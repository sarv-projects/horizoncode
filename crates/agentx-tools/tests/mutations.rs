//! Mutating/exec built-in tests: write, edit, apply_patch, bash, todo and the
//! guard assertion path (`REQ-TOOL-001`, `REQ-GUARD-001..004`).

use std::sync::Arc;

use agentx_guard::{DenyAllResolver, Effect, Guard, GuardMode, Rule};
use agentx_sandbox::{ConfinementProfile, ResolvedProfile, SandboxProvider};
use agentx_tools::{
    BuiltinOptions, GuardPermissionGate, OutputBounds, PermissionGate, PolicyGate, ToolContext,
    ToolRegistry, register_all_builtins,
};
use agentx_types::{SessionId, ToolCall, ToolCallId, ToolStatus};
use serde_json::{Value, json};

fn workspace() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
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
}

async fn settle(
    registry: &ToolRegistry,
    name: &str,
    args: Value,
    ctx: &ToolContext,
) -> agentx_tools::Settlement {
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
    let provider = agentx_sandbox::BwrapSandbox::new();
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
