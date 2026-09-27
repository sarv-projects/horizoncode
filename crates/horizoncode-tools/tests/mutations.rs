//! Mutating/exec built-in tests: write, edit, apply_patch, bash, todo and the
//! guard assertion path (`REQ-TOOL-001`, `REQ-GUARD-001..004`).

use std::path::PathBuf;
use std::sync::Arc;

use horizoncode_guard::{DenyAllResolver, Effect, Guard, GuardMode, Rule};
use horizoncode_sandbox::{ConfinementProfile, ResolvedProfile, SandboxProvider};
use horizoncode_tools::{
    BuiltinOptions, GateDecision, GuardPermissionGate, OutputBounds, PermissionGate, PermissionRequest,
    PolicyGate, ToolContext, ToolRegistry, register_all_builtins,
};
use horizoncode_types::{SessionId, ToolCall, ToolCallId, ToolStatus};
use async_trait::async_trait;
use serde_json::{Value, json};

/// A gate that simulates another writer touching the file between the
/// authorization and the effect, so the base-hash comparison has something to
/// catch. It mutates the file on the **second** authorization for a call, which
/// is where a tool re-asserts the guard immediately before its effect.
#[derive(Debug)]
struct RacingGate {
    target: PathBuf,
    raced: std::sync::atomic::AtomicBool,
}

impl RacingGate {
    fn new(target: PathBuf) -> Self {
        Self {
            target,
            raced: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn raced(&self) -> bool {
        self.raced.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait]
impl PermissionGate for RacingGate {
    async fn authorize(&self, _request: &PermissionRequest) -> GateDecision {
        if !self.raced.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return GateDecision::Allow;
        }
        std::fs::write(&self.target, "other-writer\n").unwrap();
        GateDecision::Allow
    }
}

fn workspace() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// The reach plan a workspace profile resolves to, for tests that exercise the
/// tool plane's own filesystem scope rather than a spawn.
fn scope(profile: &ConfinementProfile) -> ResolvedProfile {
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

fn registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    register_all_builtins(&mut registry, BuiltinOptions::headless()).unwrap();
    registry
}

fn context(dir: &std::path::Path) -> ToolContext {
    ToolContext::new(
        SessionId::new("ses_test"),
        ToolCallId::new("call_test"),
        dir,
    )
    .with_resolved_scope(scope(&ConfinementProfile::workspace_write(dir)))
}

async fn settle(
    registry: &ToolRegistry,
    name: &str,
    args: Value,
    ctx: &ToolContext,
) -> horizoncode_tools::Settlement {
    let call = ToolCall::new(ctx.tool_call_id.clone(), name, args);
    registry
        .settle(
            &call,
            ctx,
            &PolicyGate::read_only().allow(all_actions()),
            &OutputBounds::default(),
        )
        .await
}

fn all_actions() -> Vec<String> {
    [
        "read",
        "glob",
        "grep",
        "list",
        "write",
        "edit",
        "apply_patch",
        "bash",
        "todo",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[tokio::test]
async fn write_creates_and_overwrites() {
    let dir = workspace();
    let registry = registry();
    let ctx = context(dir.path());

    let created = settle(
        &registry,
        "write",
        json!({"path": "src/a.txt", "content": "one\n"}),
        &ctx,
    )
    .await;
    assert_eq!(created.status, ToolStatus::Success, "{created:?}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("src/a.txt")).unwrap(),
        "one\n"
    );

    let overwritten = settle(
        &registry,
        "write",
        json!({"path": "src/a.txt", "content": "two\n"}),
        &ctx,
    )
    .await;
    assert!(overwritten.model_text().contains("Wrote"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("src/a.txt")).unwrap(),
        "two\n"
    );
}

#[tokio::test]
async fn write_refuses_workspace_escape() {
    let dir = workspace();
    let registry = registry();
    let ctx = context(dir.path());
    let settlement = settle(
        &registry,
        "write",
        json!({"path": "../escaped.txt", "content": "x"}),
        &ctx,
    )
    .await;
    assert_eq!(settlement.status, ToolStatus::Error);
    assert!(settlement.model_text().contains("escapes the workspace"));
}

#[tokio::test]
async fn edit_requires_a_unique_match() {
    let dir = workspace();
    std::fs::write(dir.path().join("a.txt"), "alpha\nbeta\nalpha\n").unwrap();
    let registry = registry();
    let ctx = context(dir.path());

    let ambiguous = settle(
        &registry,
        "edit",
        json!({"path": "a.txt", "oldString": "alpha", "newString": "gamma"}),
        &ctx,
    )
    .await;
    assert_eq!(ambiguous.status, ToolStatus::Error);
    assert!(ambiguous.model_text().contains("matched 2 times"));

    let replace_all = settle(
        &registry,
        "edit",
        json!({"path": "a.txt", "oldString": "alpha", "newString": "gamma", "replaceAll": true}),
        &ctx,
    )
    .await;
    assert_eq!(replace_all.status, ToolStatus::Success, "{replace_all:?}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "gamma\nbeta\ngamma\n"
    );

    let missing = settle(
        &registry,
        "edit",
        json!({"path": "a.txt", "oldString": "nope", "newString": "x"}),
        &ctx,
    )
    .await;
    assert!(missing.model_text().contains("was not found"));

    let identical = settle(
        &registry,
        "edit",
        json!({"path": "a.txt", "oldString": "gamma", "newString": "gamma"}),
        &ctx,
    )
    .await;
    assert!(identical.model_text().contains("identical"));
}

#[tokio::test]
async fn apply_patch_adds_updates_and_deletes() {
    let dir = workspace();
    std::fs::write(dir.path().join("keep.txt"), "one\ntwo\nthree\n").unwrap();
    let registry = registry();
    let ctx = context(dir.path());

    let patch = concat!(
        "*** Begin Patch\n",
        "*** Add File: new.txt\n",
        "+hello\n",
        "+world\n",
        "*** Update File: keep.txt\n",
        "@@\n",
        " one\n",
        "-two\n",
        "+TWO\n",
        " three\n",
        "*** End Patch\n",
    );
    let settlement = settle(&registry, "apply_patch", json!({"patchText": patch}), &ctx).await;
    assert_eq!(settlement.status, ToolStatus::Success, "{settlement:?}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("new.txt")).unwrap(),
        "hello\nworld\n"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("keep.txt")).unwrap(),
        "one\nTWO\nthree\n"
    );

    let delete = "*** Begin Patch\n*** Delete File: new.txt\n*** End Patch\n";
    let settlement = settle(&registry, "apply_patch", json!({"patchText": delete}), &ctx).await;
    assert_eq!(settlement.status, ToolStatus::Success);
    assert!(!dir.path().join("new.txt").exists());
}

#[tokio::test]
async fn apply_patch_reports_a_non_matching_hunk() {
    let dir = workspace();
    std::fs::write(dir.path().join("a.txt"), "alpha\n").unwrap();
    let registry = registry();
    let ctx = context(dir.path());
    let patch = concat!(
        "*** Begin Patch\n",
        "*** Update File: a.txt\n",
        "@@\n",
        "-nope\n",
        "+yes\n",
        "*** End Patch\n",
    );
    let settlement = settle(&registry, "apply_patch", json!({"patchText": patch}), &ctx).await;
    assert_eq!(settlement.status, ToolStatus::Error);
    assert!(settlement.model_text().contains("did not match"));
}

#[tokio::test]
async fn todo_state_is_maintained_per_session() {
    let dir = workspace();
    let registry = registry();
    let ctx = context(dir.path());
    let settlement = settle(
        &registry,
        "todo",
        json!({"todos": [
            {"content": "first", "status": "in_progress"},
            {"content": "second"}
        ]}),
        &ctx,
    )
    .await;
    assert_eq!(settlement.status, ToolStatus::Success, "{settlement:?}");
    let text = settlement.model_text();
    assert!(text.contains("[in_progress] todo_1: first"), "{text}");
    assert!(text.contains("[pending] todo_2: second"), "{text}");
}

#[tokio::test]
async fn bash_without_a_sandbox_is_unavailable() {
    let dir = workspace();
    let registry = registry();
    let ctx = context(dir.path());
    let settlement = settle(&registry, "bash", json!({"command": "echo hi"}), &ctx).await;
    assert_eq!(settlement.status, ToolStatus::Error);
    assert_eq!(settlement.error_code.as_deref(), Some("TOOL_UNAVAILABLE"));
}

/// `ARCH/13` §Failure modes: a profile that could not be applied fails closed.
/// A tool that performs a write with no resolved plan has no enforcement at all,
/// so the effect must be refused rather than run.
#[tokio::test]
async fn a_write_is_refused_when_no_confinement_profile_resolved() {
    let dir = workspace();
    let registry = registry();
    let ctx = ToolContext::new(
        SessionId::new("ses_test"),
        ToolCallId::new("call_test"),
        dir.path(),
    );
    let settlement = settle(
        &registry,
        "write",
        json!({"path": "a.txt", "content": "x"}),
        &ctx,
    )
    .await;
    assert_eq!(settlement.status, ToolStatus::Denied, "{settlement:?}");
    assert!(
        !dir.path().join("a.txt").exists(),
        "an unenforced write must not reach the filesystem"
    );
}

/// `REQ-SEC-004` / `REQ-SEC-005`: a symlinked **parent** must not carry a create
/// out of the workspace. Canonicalizing the whole target misses this, because
/// the target does not exist yet.
#[tokio::test]
async fn write_refuses_a_symlinked_parent_that_escapes_the_workspace() {
    let dir = workspace();
    let outside = workspace();
    std::fs::create_dir_all(dir.path().join("real")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
    let registry = registry();
    let ctx = context(dir.path());

    let settlement = settle(
        &registry,
        "write",
        json!({"path": "link/escaped.txt", "content": "leaked\n"}),
        &ctx,
    )
    .await;
    assert_ne!(settlement.status, ToolStatus::Success, "{settlement:?}");
    assert!(
        !outside.path().join("escaped.txt").exists(),
        "the write followed a symlinked parent out of the workspace"
    );

    // The same path through a real in-workspace directory still works, so the
    // fix refuses the escape rather than the tool.
    let allowed = settle(
        &registry,
        "write",
        json!({"path": "real/fine.txt", "content": "ok\n"}),
        &ctx,
    )
    .await;
    assert_eq!(allowed.status, ToolStatus::Success, "{allowed:?}");
    assert!(dir.path().join("real/fine.txt").is_file());
}

/// The write scope includes the protected subpaths, so a write grant cannot
/// install a hook that runs outside confinement.
#[tokio::test]
async fn write_refuses_a_protected_subpath() {
    let dir = workspace();
    std::fs::create_dir_all(dir.path().join(".git/hooks")).unwrap();
    let registry = registry();
    let ctx = context(dir.path());
    let settlement = settle(
        &registry,
        "write",
        json!({"path": ".git/hooks/pre-commit", "content": "#!/bin/sh\n"}),
        &ctx,
    )
    .await;
    assert_eq!(settlement.status, ToolStatus::Denied, "{settlement:?}");
    assert!(!dir.path().join(".git/hooks/pre-commit").exists());
}

/// Reads are reach, not authorization: an in-process read is scoped to the
/// granted roots and the deny set exactly like a spawned one. The tool plane's
/// own workspace check cannot express a deny glob, so the sandbox is the only
/// component that can refuse here — and it must.
#[tokio::test]
async fn read_refuses_a_denied_path_inside_the_workspace() {
    let dir = workspace();
    std::fs::write(dir.path().join(".env"), "SECRET=1\n").unwrap();
    std::fs::write(dir.path().join("notes.txt"), "fine\n").unwrap();

    let registry = registry();
    let denied_profile = ConfinementProfile::workspace_write(dir.path()).with_deny("**/.env");
    let ctx = context(dir.path()).with_resolved_scope(scope(&denied_profile));

    let denied = settle(&registry, "read", json!({"path": ".env"}), &ctx).await;
    assert_eq!(denied.status, ToolStatus::Denied, "{denied:?}");
    assert!(
        !denied.model_text().contains("SECRET"),
        "a denied path must not be read: {denied:?}"
    );

    // Scoping is not a lockout: an ordinary in-scope read still works.
    let allowed = settle(&registry, "read", json!({"path": "notes.txt"}), &ctx).await;
    assert_eq!(allowed.status, ToolStatus::Success, "{allowed:?}");
    assert!(allowed.model_text().contains("fine"), "{allowed:?}");
}

/// A read is refused when no confinement profile resolved, exactly as a write is.
#[tokio::test]
async fn read_is_refused_when_no_confinement_profile_resolved() {
    let dir = workspace();
    std::fs::write(dir.path().join("a.txt"), "hi\n").unwrap();
    let registry = registry();
    let ctx = ToolContext::new(
        SessionId::new("ses_test"),
        ToolCallId::new("call_test"),
        dir.path(),
    );
    let settlement = settle(&registry, "read", json!({"path": "a.txt"}), &ctx).await;
    assert_eq!(settlement.status, ToolStatus::Denied, "{settlement:?}");
}

/// `ARCH/10` §Mutations and `T3`: the approved base is re-read and compared
/// before the write, so a concurrent change is reported as a typed conflict
/// rather than silently overwritten.
#[tokio::test]
async fn write_reports_a_conflict_when_the_file_changed_after_it_was_approved() {
    let dir = workspace();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "base\n").unwrap();
    let registry = registry();
    let racer = Arc::new(RacingGate::new(file.clone()));
    let ctx = context(dir.path()).with_gate(racer.clone());
    let call = ToolCall::new(
        ToolCallId::new("call_race"),
        "write",
        json!({"path": "a.txt", "content": "agent\n"}),
    );
    let settlement = registry
        .settle(&call, &ctx, racer.as_ref(), &OutputBounds::default())
        .await;
    assert!(racer.raced(), "the fixture must have raced");
    assert_eq!(settlement.status, ToolStatus::Error, "{settlement:?}");
    assert_eq!(
        settlement.error_code.as_deref(),
        Some("TOOL_CONFLICT"),
        "{settlement:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "other-writer\n",
        "the concurrent change must survive"
    );
}

#[tokio::test]
async fn edit_reports_a_conflict_when_the_file_changed_after_it_was_approved() {
    let dir = workspace();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "alpha\n").unwrap();
    let registry = registry();
    let racer = Arc::new(RacingGate::new(file.clone()));
    let ctx = context(dir.path()).with_gate(racer.clone());
    let call = ToolCall::new(
        ToolCallId::new("call_race"),
        "edit",
        json!({"path": "a.txt", "oldString": "alpha", "newString": "beta"}),
    );
    let settlement = registry
        .settle(&call, &ctx, racer.as_ref(), &OutputBounds::default())
        .await;
    assert!(racer.raced(), "the fixture must have raced");
    assert_eq!(
        settlement.error_code.as_deref(),
        Some("TOOL_CONFLICT"),
        "{settlement:?}"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "other-writer\n");
}

/// A caller may pin the base it approved. A stale pin is a typed conflict, not
/// a silent overwrite.
#[tokio::test]
async fn write_honours_a_caller_supplied_base_hash() {
    let dir = workspace();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "current\n").unwrap();
    let registry = registry();
    let ctx = context(dir.path());
    let call = ToolCall::new(
        ToolCallId::new("call_pin"),
        "write",
        json!({
            "path": "a.txt",
            "content": "replacement\n",
            "expectedBaseHash": "00".repeat(32),
        }),
    );
    let settlement = registry
        .settle(
            &call,
            &ctx,
            &PolicyGate::read_only().allow(all_actions()),
            &OutputBounds::default(),
        )
        .await;
    assert_eq!(
        settlement.error_code.as_deref(),
        Some("TOOL_CONFLICT"),
        "{settlement:?}"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "current\n");

    // A pin that matches the approved base proceeds.
    let good = horizoncode_tools::file_digest(b"current\n");
    let call = ToolCall::new(
        ToolCallId::new("call_pin_ok"),
        "write",
        json!({"path": "a.txt", "content": "replacement\n", "expectedBaseHash": good}),
    );
    let settlement = registry
        .settle(
            &call,
            &ctx,
            &PolicyGate::read_only().allow(all_actions()),
            &OutputBounds::default(),
        )
        .await;
    assert_eq!(settlement.status, ToolStatus::Success, "{settlement:?}");
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "replacement\n"
    );
}

fn gate_with(guard: Guard) -> Arc<dyn PermissionGate> {
    Arc::new(GuardPermissionGate::new(
        Arc::new(guard),
        Arc::new(DenyAllResolver),
    ))
}

#[tokio::test]
async fn a_deny_rule_blocks_a_write_and_removes_the_tool() {
    let dir = workspace();
    let registry = registry();
    let guard = Guard::from_rules(
        vec![
            Rule::new("fs.read", "**", Effect::Allow),
            Rule::new("fs.write", "**", Effect::Deny),
        ],
        GuardMode::Act,
        Effect::Deny,
    );
    let gate = gate_with(guard);
    let materialization = registry.materialize(gate.as_ref());
    assert!(!materialization.names.iter().any(|name| name == "write"));
    assert!(materialization.names.iter().any(|name| name == "read"));

    let ctx = context(dir.path()).with_gate(gate.clone());
    let call = ToolCall::new(
        ToolCallId::new("call_w"),
        "write",
        json!({"path": "a.txt", "content": "x"}),
    );
    let settlement = registry
        .settle(&call, &ctx, gate.as_ref(), &OutputBounds::default())
        .await;
    assert_eq!(settlement.status, ToolStatus::Denied);
    assert!(!dir.path().join("a.txt").exists());
}

#[tokio::test]
async fn plan_mode_refuses_a_mutating_call() {
    let dir = workspace();
    let registry = registry();
    let guard = Guard::from_rules(
        vec![
            Rule::new("fs.read", "**", Effect::Allow),
            Rule::new("fs.write", "**", Effect::Allow),
        ],
        GuardMode::Plan,
        Effect::Deny,
    );
    let gate = gate_with(guard);
    assert!(gate.wholly_denied("write"));
    let ctx = context(dir.path()).with_gate(gate.clone());
    let call = ToolCall::new(
        ToolCallId::new("call_w"),
        "write",
        json!({"path": "a.txt", "content": "x"}),
    );
    let settlement = registry
        .settle(&call, &ctx, gate.as_ref(), &OutputBounds::default())
        .await;
    assert_eq!(settlement.status, ToolStatus::Denied);
    assert!(!dir.path().join("a.txt").exists());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn bash_runs_inside_the_sandbox() {
    let dir = workspace();
    let provider = horizoncode_sandbox::BwrapSandbox::new();
    if !provider.probe().is_available() {
        eprintln!("skipping: bubblewrap unavailable");
        return;
    }
    let profile = ConfinementProfile::workspace_write(dir.path());
    let resolved: ResolvedProfile = provider.resolve(&profile).unwrap();
    let registry = registry();
    let ctx = context(dir.path()).with_sandbox(Arc::new(provider), Arc::new(resolved));

    let settlement = settle(
        &registry,
        "bash",
        json!({"command": "echo sandboxed && echo wrote > out.txt"}),
        &ctx,
    )
    .await;
    assert_eq!(settlement.status, ToolStatus::Success, "{settlement:?}");
    assert!(
        settlement.model_text().contains("sandboxed"),
        "{settlement:?}"
    );
    assert!(dir.path().join("out.txt").is_file());
    assert_eq!(settlement.structured.unwrap()["exit_code"], json!(0));
}
