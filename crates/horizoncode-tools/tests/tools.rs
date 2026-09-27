//! Built-in tool and registry tests.

use horizoncode_sandbox::{ConfinementProfile, ResolvedProfile};
use horizoncode_tools::{
    OutputBounds, PolicyGate, ToolContext, ToolRegistry, register_read_only_builtins,
};
use horizoncode_types::{SessionId, ToolCall, ToolCallId, ToolStatus};
use async_trait::async_trait;
use serde_json::json;

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
    let ctx = ToolContext::new(
        SessionId::new("ses_test"),
        ToolCallId::new("call_test"),
        dir.to_path_buf(),
    )
    .with_resolved_scope(scope(dir));
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
