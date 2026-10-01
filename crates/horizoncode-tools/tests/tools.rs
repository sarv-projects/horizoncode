//! Built-in tool and registry tests.

use async_trait::async_trait;
use horizoncode_sandbox::{ConfinementProfile, ResolvedProfile};
use horizoncode_tools::{
    OutputBounds, PolicyGate, ToolContext, ToolRegistry, register_read_only_builtins,
};
use horizoncode_types::{CancelToken, SessionId, ToolCall, ToolCallId, ToolStatus};
use serde_json::json;

const MAX_READ_FILE_BYTES: u64 = 16_777_216;

/// The reach plan a workspace profile resolves to. The read-only built-ins scope
/// their own filesystem operations, so a test needs a plan in force.
fn scope(dir: &std::path::Path) -> ResolvedProfile {
    let profile = ConfinementProfile::workspace_write(dir);
    ResolvedProfile {
        backend: "test".to_owned(),
        profile: profile.profile,
        network: profile.network.clone(),
        workspace: profile.workspace.clone(),
        writable_roots: profile.writable_roots(),
        readable_roots: profile.readable_roots(),
        protected: profile.protected.clone(),
        deny: profile.deny.clone(),
        session_dir: profile.session_dir.clone(),
        limits: profile.limits,
        applied: Vec::new(),
        epoch: 1,
        bare: false,
    }
}

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/main.rs"), "fn main() {}\n// marker\n").unwrap();
    std::fs::write(dir.path().join("README.md"), "# hello\nmarker here\n").unwrap();
    std::fs::write(dir.path().join("data.bin"), [0u8, 1, 2, 3]).unwrap();
    dir
}

fn registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    register_read_only_builtins(&mut registry).unwrap();
    registry
}

async fn call(
    registry: &ToolRegistry,
    name: &str,
    args: serde_json::Value,
    dir: &std::path::Path,
) -> horizoncode_tools::Settlement {
    call_with_cancel(registry, name, args, dir, CancelToken::new()).await
}

async fn call_with_cancel(
    registry: &ToolRegistry,
    name: &str,
    args: serde_json::Value,
    dir: &std::path::Path,
    cancel: CancelToken,
) -> horizoncode_tools::Settlement {
    let ctx = ToolContext::new(
        SessionId::new("ses_test"),
        ToolCallId::new("call_test"),
        dir.to_path_buf(),
    )
    .with_resolved_scope(scope(dir));
    let mut ctx = ctx;
    ctx.cancel = cancel;
    let call = ToolCall::new(ToolCallId::new("call_test"), name, args);
    let gate = PolicyGate::read_only();
    registry
        .settle(&call, &ctx, &gate, &OutputBounds::default())
        .await
}

#[test]
fn materialization_removes_wholly_denied_tools() {
    let registry = registry();
    let open = registry.materialize(&PolicyGate::read_only());
    let mut names = open.names.clone();
    names.sort();
    assert_eq!(names, vec!["glob", "grep", "list", "read"]);

    let gate = PolicyGate::read_only().deny(["read".to_owned()]);
    let filtered = registry.materialize(&gate);
    assert!(!filtered.names.iter().any(|name| name == "read"));
    assert!(filtered.names.iter().any(|name| name == "glob"));
}

#[tokio::test]
async fn read_pages_a_file_and_lists_a_directory() {
    let dir = workspace();
    let registry = registry();

    let page = call(
        &registry,
        "read",
        json!({"path": "src/main.rs"}),
        dir.path(),
    )
    .await;
    assert_eq!(page.status, ToolStatus::Success);
    assert!(page.model_text().contains("fn main() {}"));
    assert!(page.model_text().contains("lines 1-2 of 2"));

    let listing = call(&registry, "read", json!({"path": "src"}), dir.path()).await;
    assert!(listing.model_text().contains("main.rs"));

    let windowed = call(
        &registry,
        "read",
        json!({"path": "README.md", "offset": 2, "limit": 1}),
        dir.path(),
    )
    .await;
    assert!(windowed.model_text().contains("marker here"));
    assert!(!windowed.model_text().contains("# hello"));
}

#[tokio::test]
async fn read_refuses_workspace_escape() {
    let dir = workspace();
    let registry = registry();
    let settlement = call(
        &registry,
        "read",
        json!({"path": "../etc/passwd"}),
        dir.path(),
    )
    .await;
    assert_eq!(settlement.status, ToolStatus::Error);
    assert!(settlement.model_text().contains("escapes the workspace"));
}

#[tokio::test]
async fn read_reports_binary_files_without_content() {
    let dir = workspace();
    let registry = registry();
    let settlement = call(&registry, "read", json!({"path": "data.bin"}), dir.path()).await;
    assert_eq!(settlement.status, ToolStatus::Success);
    assert!(settlement.model_text().contains("binary file"));
}

#[tokio::test]
async fn read_refuses_oversized_regular_file_with_typed_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("too-large.bin");
    let file = std::fs::File::create(path).unwrap();
    file.set_len(MAX_READ_FILE_BYTES + 1).unwrap();

    let settlement = call(
        &registry(),
        "read",
        json!({"path": "too-large.bin"}),
        dir.path(),
    )
    .await;
    assert_eq!(settlement.status, ToolStatus::Error);
    assert_eq!(settlement.error_code.as_deref(), Some("TOOL_OUTPUT_LIMIT"));
    let message = settlement.model_text();
    assert!(message.contains("16777216-byte limit"), "{message}");
    assert!(message.contains("observed 16777217 bytes"), "{message}");
    assert!(
        !message.contains("lines "),
        "oversize must not be partial success: {message}"
    );
}

#[tokio::test]
async fn recursive_search_uses_nested_ignore_rules_and_keeps_hidden_files_visible() {
    let dir = workspace();
    std::fs::write(
        dir.path().join(".gitignore"),
        "ignored.txt\n*.tmp\nignored-dir/\n",
    )
    .unwrap();
    std::fs::write(dir.path().join(".ignore"), "!ignored.txt\n").unwrap();
    std::fs::write(
        dir.path().join("ignored.txt"),
        "marker restored by .ignore\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("ignored.tmp"), "marker ignored\n").unwrap();
    std::fs::create_dir_all(dir.path().join("ignored-dir")).unwrap();
    std::fs::write(
        dir.path().join("ignored-dir/child.txt"),
        "marker ignored directory\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join(".hidden.txt"),
        "marker hidden but visible\n",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("nested")).unwrap();
    std::fs::write(dir.path().join("nested/.gitignore"), "*.log\n").unwrap();
    std::fs::write(dir.path().join("nested/.ignore"), "!kept.log\n").unwrap();
    std::fs::write(
        dir.path().join("nested/ignored.log"),
        "marker nested ignored\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("nested/kept.log"),
        "marker nested restored\n",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join(".git")).unwrap();
    std::fs::write(dir.path().join(".git/internal.txt"), "marker metadata\n").unwrap();

    let registry = registry();
    let paths = call(&registry, "glob", json!({"pattern": "**/*"}), dir.path()).await;
    assert_eq!(paths.status, ToolStatus::Success, "{paths:?}");
    let paths = paths.model_text();
    assert!(paths.contains("ignored.txt"), "{paths}");
    assert!(paths.contains(".hidden.txt"), "{paths}");
    assert!(paths.contains("nested/kept.log"), "{paths}");
    assert!(!paths.contains("ignored.tmp"), "{paths}");
    assert!(!paths.contains("ignored-dir/child.txt"), "{paths}");
    assert!(!paths.contains("nested/ignored.log"), "{paths}");
    assert!(!paths.contains(".git/internal.txt"), "{paths}");

    let hits = call(&registry, "grep", json!({"pattern": "marker"}), dir.path()).await;
    assert_eq!(hits.status, ToolStatus::Success, "{hits:?}");
    let hits = hits.model_text();
    assert!(hits.contains("ignored.txt"), "{hits}");
    assert!(hits.contains(".hidden.txt"), "{hits}");
    assert!(hits.contains("nested/kept.log"), "{hits}");
    assert!(!hits.contains("ignored.tmp"), "{hits}");
    assert!(!hits.contains("ignored-dir/child.txt"), "{hits}");
    assert!(!hits.contains("nested/ignored.log"), "{hits}");
    assert!(!hits.contains("metadata"), "{hits}");
}

#[tokio::test]
async fn recursive_search_does_not_apply_ignore_files_above_selected_root() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".gitignore"), "*.txt\n").unwrap();
    let selected = dir.path().join("selected");
    std::fs::create_dir(&selected).unwrap();
    std::fs::write(selected.join("visible.txt"), "marker\n").unwrap();

    let result = call(
        &registry(),
        "glob",
        json!({"pattern": "**/*.txt", "path": "selected"}),
        dir.path(),
    )
    .await;
    assert_eq!(result.status, ToolStatus::Success, "{result:?}");
    assert!(result.model_text().contains("visible.txt"), "{result:?}");
}

#[tokio::test]
async fn selected_root_applies_its_gitignore_without_a_git_repository_marker() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("selected");
    std::fs::create_dir(&selected).unwrap();
    std::fs::write(selected.join(".gitignore"), "*.tmp\n").unwrap();
    std::fs::write(selected.join("hidden.tmp"), "marker\n").unwrap();
    std::fs::write(selected.join("visible.txt"), "marker\n").unwrap();

    for tool in ["glob", "grep"] {
        let result = call(
            &registry(),
            tool,
            if tool == "glob" {
                json!({"pattern": "**/*", "path": "selected"})
            } else {
                json!({"pattern": "marker", "path": "selected"})
            },
            dir.path(),
        )
        .await;
        assert_eq!(result.status, ToolStatus::Success, "{tool}: {result:?}");
        assert!(
            result.model_text().contains("visible.txt"),
            "{tool}: {result:?}"
        );
        assert!(
            !result.model_text().contains("hidden.tmp"),
            "{tool}: {result:?}"
        );
    }
}

#[tokio::test]
async fn ignore_precedence_places_ignore_files_above_gitignore_across_depths() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".ignore"), "!nested/keep.txt\n").unwrap();
    let nested = dir.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(nested.join(".gitignore"), "*.txt\n").unwrap();
    std::fs::write(nested.join("keep.txt"), "marker\n").unwrap();

    for tool in ["glob", "grep"] {
        let result = call(
            &registry(),
            tool,
            if tool == "glob" {
                json!({"pattern": "**/*"})
            } else {
                json!({"pattern": "marker"})
            },
            dir.path(),
        )
        .await;
        assert_eq!(result.status, ToolStatus::Success, "{tool}: {result:?}");
        assert!(
            result.model_text().contains("nested/keep.txt"),
            "{tool}: {result:?}"
        );
    }
}

#[tokio::test]
async fn recursive_search_honors_an_already_cancelled_turn() {
    let dir = workspace();
    let cancel = CancelToken::new();
    cancel.cancel();
    for tool in ["glob", "grep"] {
        let result = call_with_cancel(
            &registry(),
            tool,
            if tool == "glob" {
                json!({"pattern": "**/*"})
            } else {
                json!({"pattern": "marker"})
            },
            dir.path(),
            cancel.clone(),
        )
        .await;
        assert_eq!(result.status, ToolStatus::Aborted, "{tool}: {result:?}");
        assert_eq!(result.error_code.as_deref(), Some("TOOL_ABORTED"));
        assert!(!result.model_text().contains("no matches"));
    }
}

#[tokio::test]
async fn malformed_ignore_file_fails_recursive_search_with_typed_io_error() {
    let dir = workspace();
    std::fs::write(dir.path().join(".ignore"), "[z-a]\n").unwrap();

    let result = call(&registry(), "glob", json!({"pattern": "**/*"}), dir.path()).await;
    assert_eq!(result.status, ToolStatus::Error, "{result:?}");
    assert_eq!(result.error_code.as_deref(), Some("TOOL_IO_ERROR"));
}

#[tokio::test]
async fn oversized_ignore_file_fails_before_search() {
    let dir = workspace();
    std::fs::write(dir.path().join(".ignore"), vec![b'x'; 1_048_577]).unwrap();

    let result = call(&registry(), "glob", json!({"pattern": "**/*"}), dir.path()).await;
    assert_eq!(result.status, ToolStatus::Error, "{result:?}");
    assert_eq!(result.error_code.as_deref(), Some("TOOL_OUTPUT_LIMIT"));
}

#[tokio::test]
async fn non_regular_ignore_file_fails_before_search() {
    let dir = workspace();
    std::fs::create_dir(dir.path().join(".ignore")).unwrap();

    let result = call(&registry(), "glob", json!({"pattern": "**/*"}), dir.path()).await;
    assert_eq!(result.status, ToolStatus::Error, "{result:?}");
    assert_eq!(
        result.error_code.as_deref(),
        Some("TOOL_UNSUPPORTED_TARGET")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unreadable_ignore_file_fails_before_search_when_permissions_enforce_it() {
    use std::os::unix::fs::PermissionsExt;

    let dir = workspace();
    let path = dir.path().join(".ignore");
    std::fs::write(&path, "ignored.txt\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&path).is_ok() {
        // Root and some sandboxed test runners can read mode-000 files. This
        // environment cannot prove the permission-denied branch.
        return;
    }

    let result = call(&registry(), "glob", json!({"pattern": "**/*"}), dir.path()).await;
    assert_eq!(result.status, ToolStatus::Error, "{result:?}");
    assert_eq!(result.error_code.as_deref(), Some("TOOL_IO_ERROR"));
}

#[tokio::test]
async fn grep_refuses_an_oversized_file_without_partial_matches() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("too-large.txt");
    let file = std::fs::File::create(path).unwrap();
    file.set_len(MAX_READ_FILE_BYTES + 1).unwrap();

    let settlement = call(
        &registry(),
        "grep",
        json!({"pattern": "anything"}),
        dir.path(),
    )
    .await;
    assert_eq!(settlement.status, ToolStatus::Error);
    assert_eq!(settlement.error_code.as_deref(), Some("TOOL_OUTPUT_LIMIT"));
    let message = settlement.model_text();
    assert!(message.contains("16777216-byte limit"), "{message}");
    assert!(!message.contains("no matches"), "{message}");
}

#[tokio::test]
async fn glob_matches_relative_paths() {
    let dir = workspace();
    let registry = registry();
    let settlement = call(&registry, "glob", json!({"pattern": "**/*.rs"}), dir.path()).await;
    assert_eq!(settlement.status, ToolStatus::Success);
    assert_eq!(settlement.model_text().trim(), "src/main.rs");
}

#[tokio::test]
async fn grep_groups_hits_with_line_numbers() {
    let dir = workspace();
    let registry = registry();
    let settlement = call(&registry, "grep", json!({"pattern": "marker"}), dir.path()).await;
    assert_eq!(settlement.status, ToolStatus::Success);
    let text = settlement.model_text();
    assert!(text.contains("src/main.rs:2: // marker"), "{text}");
    assert!(text.contains("README.md:2: marker here"), "{text}");
}

#[tokio::test]
async fn grep_respects_include_glob() {
    let dir = workspace();
    let registry = registry();
    let settlement = call(
        &registry,
        "grep",
        json!({"pattern": "marker", "include": "**/*.rs"}),
        dir.path(),
    )
    .await;
    let text = settlement.model_text();
    assert!(text.contains("src/main.rs"));
    assert!(!text.contains("README.md"));
}

#[tokio::test]
async fn grep_rejects_invalid_regex() {
    let dir = workspace();
    let registry = registry();
    let settlement = call(&registry, "grep", json!({"pattern": "("}), dir.path()).await;
    assert_eq!(settlement.status, ToolStatus::Error);
    assert!(settlement.model_text().contains("invalid regex"));
}

#[tokio::test]
async fn list_marks_directories() {
    let dir = workspace();
    let registry = registry();
    let settlement = call(&registry, "list", json!({}), dir.path()).await;
    let text = settlement.model_text();
    assert!(text.contains("src/"));
    assert!(text.contains("README.md"));
}

#[tokio::test]
async fn denied_action_is_a_typed_settlement() {
    let dir = workspace();
    let registry = registry();
    let ctx = ToolContext::new(SessionId::new("s"), ToolCallId::new("c"), dir.path());
    let call = ToolCall::new(ToolCallId::new("c"), "read", json!({"path": "README.md"}));
    let gate = PolicyGate::read_only().deny(["read".to_owned()]);
    let settlement = registry
        .settle(&call, &ctx, &gate, &OutputBounds::default())
        .await;
    assert_eq!(settlement.status, ToolStatus::Denied);
    assert_eq!(settlement.error_code.as_deref(), Some("TOOL_DENIED"));
}

#[tokio::test]
async fn unknown_tool_is_a_typed_settlement() {
    let dir = workspace();
    let registry = registry();
    let settlement = call(&registry, "does_not_exist", json!({}), dir.path()).await;
    assert_eq!(settlement.status, ToolStatus::Error);
    assert_eq!(settlement.error_code.as_deref(), Some("TOOL_UNKNOWN"));
}

#[tokio::test]
async fn large_output_is_bounded_and_spilled() {
    let dir = tempfile::tempdir().unwrap();
    let big = "x\n".repeat(5000);
    std::fs::write(dir.path().join("big.txt"), &big).unwrap();
    let mut registry = registry();
    let spill = tempfile::tempdir().unwrap();
    registry.set_spill_dir(Some(spill.path().to_path_buf()));

    let ctx = ToolContext::new(SessionId::new("s"), ToolCallId::new("call_big"), dir.path())
        .with_resolved_scope(scope(dir.path()));
    let call = ToolCall::new(
        ToolCallId::new("call_big"),
        "read",
        json!({"path": "big.txt"}),
    );
    let settlement = registry
        .settle(
            &call,
            &ctx,
            &PolicyGate::read_only(),
            &OutputBounds {
                max_lines: 50,
                max_bytes: 200,
            },
        )
        .await;
    assert_eq!(settlement.status, ToolStatus::Success);
    assert!(settlement.model_text().contains("truncated:"));
    assert_eq!(settlement.output_paths.len(), 1);
    assert!(std::path::Path::new(&settlement.output_paths[0]).is_file());
}

#[test]
fn invalid_tool_name_is_rejected_before_registration() {
    #[derive(Debug)]
    struct BadTool;
    #[async_trait]
    impl horizoncode_tools::Tool for BadTool {
        fn definition(&self) -> horizoncode_types::ToolDefinition {
            horizoncode_types::ToolDefinition::new("bad name", "x", json!({}), None)
        }
        async fn execute(
            &self,
            _input: serde_json::Value,
            _ctx: &ToolContext,
        ) -> Result<horizoncode_tools::ToolOutput, horizoncode_tools::ToolError> {
            Ok(horizoncode_tools::ToolOutput::text("unused"))
        }
    }
    let mut registry = ToolRegistry::new();
    let error = registry.register(std::sync::Arc::new(BadTool)).unwrap_err();
    assert_eq!(error.code(), "TOOL_INVALID_INPUT");
    assert!(registry.is_empty());
}
