//! The permission seam: resource extraction, the external-directory ask, and
//! ticket validation on the effect path (`DEC-024`, `DEC-025`, `REQ-SEC-025`,
//! `ARCH/12`, `ARCH/10`).

use std::sync::{Arc, Mutex};

use horizoncode_guard::{
    ApprovalReply, ApprovalRequest, ApprovalResolver, Effect, Guard, GuardMode, Rule,
};
use horizoncode_sandbox::{ConfinementProfile, ResolvedProfile};
use horizoncode_tools::{
    BuiltinOptions, GateDecision, GuardPermissionGate, OutputBounds, PermissionGate,
    PermissionRequest, PermissionTarget, PolicyGate, ToolContext, ToolRegistry,
    additional_targets_from_input, extract_patch_paths, extract_path_arguments,
    register_all_builtins,
};
use horizoncode_types::{SessionId, ToolCall, ToolCallId, ToolStatus};
use async_trait::async_trait;
use serde_json::{Value, json};

fn workspace() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

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
    .with_resolved_scope(scope(dir))
}

/// A resolver that records what it was asked and answers `Once`.
#[derive(Debug, Default)]
struct RecordingResolver {
    seen: Mutex<Vec<ApprovalRequest>>,
    reply: Mutex<Option<ApprovalReply>>,
}

impl RecordingResolver {
    fn new(reply: ApprovalReply) -> Self {
        Self {
            seen: Mutex::new(Vec::new()),
            reply: Mutex::new(Some(reply)),
        }
    }

    fn asked(&self) -> Vec<ApprovalRequest> {
        self.seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl ApprovalResolver for RecordingResolver {
    async fn resolve(&self, request: &ApprovalRequest) -> ApprovalReply {
        self.seen.lock().unwrap().push(request.clone());
        self.reply.lock().unwrap().unwrap_or(ApprovalReply::Once)
    }
}

fn guard_in(dir: &std::path::Path, rules: Vec<Rule>) -> Arc<Guard> {
    Arc::new(
        Guard::builder()
            .discover_global(false)
            .with_workspace(dir)
            .with_mode(GuardMode::Act)
            .with_unmatched(Effect::Deny)
            .with_session_rules(rules)
            .build(),
    )
}

fn gate(guard: Arc<Guard>, resolver: Arc<dyn ApprovalResolver>) -> Arc<GuardPermissionGate> {
    Arc::new(GuardPermissionGate::new(guard, resolver))
}

fn request(action: &str, tool: &str, resources: Vec<&str>) -> PermissionRequest {
    PermissionRequest {
        action: action.to_owned(),
        tool_name: tool.to_owned(),
        resources: resources.into_iter().map(str::to_owned).collect(),
        session_id: SessionId::new("ses_test"),
        source: ToolCallId::new("call_1"),
        metadata: json!({}),
        targets: Vec::new(),
    }
}

// ---------------------------------------------------------------- extraction

#[test]
fn path_shaped_shell_arguments_become_fs_resources() {
    let found = extract_path_arguments("cat /etc/passwd | grep root > out.txt");
    assert_eq!(found, vec!["/etc/passwd".to_owned(), "out.txt".to_owned()]);
    // A dot-leading name is extracted, so a deny glob for `**/.env` sees it.
    assert_eq!(extract_path_arguments("cat .env"), vec![".env".to_owned()]);
    // A bare command word is not a path and must not be put through the path
    // matcher, or an unrelated deny pattern could match a command word.
    assert!(extract_path_arguments("grep -r secret .").is_empty());

    // Quoting and punctuation do not hide a path.
    assert_eq!(
        extract_path_arguments(r#"cp "/home/u/.ssh/id_rsa" /tmp/x"#),
        vec![
            "/home/u/.ssh/id_rsa".to_owned(),
            "/tmp/x".to_owned()
        ]
    );
    assert_eq!(
        extract_path_arguments("tar -cf /tmp/a.tar /var/log"),
        vec!["/tmp/a.tar".to_owned(), "/var/log".to_owned()]
    );
    // A command with no path names no resource.
    assert!(extract_path_arguments("cargo test --workspace").is_empty());
}

#[test]
fn extraction_is_bounded() {
    let huge = "x".repeat(4096);
    let command = format!("cat {} /etc/passwd", vec!["/a"; 5000].join(" "));
    assert!(extract_path_arguments(&command).len() <= 64);
    assert!(extract_path_arguments(&huge).is_empty());
    // A path longer than the token bound is not extracted rather than truncated.
    let long = format!("cat /{}", "a".repeat(5000));
    assert!(extract_path_arguments(&long).is_empty());
}

#[test]
fn a_patch_names_the_files_it_touches() {
    let patch = concat!(
        "*** Begin Patch\n",
        "*** Add File: src/new.rs\n",
        "+x\n",
        "*** Update File: src/old.rs\n",
        "@@\n",
        "*** Delete File: src/gone.rs\n",
        "*** End Patch\n",
    );
    assert_eq!(
        extract_patch_paths(patch),
        vec![
            "src/new.rs".to_owned(),
            "src/old.rs".to_owned(),
            "src/gone.rs".to_owned()
        ]
    );
}

#[test]
fn a_bash_request_carries_the_command_and_the_paths_it_names() {
    let targets = additional_targets_from_input(&json!({"command": "cat /etc/passwd"}));
    assert_eq!(targets.len(), 2, "read and write, both directions");
    for target in &targets {
        assert_eq!(target.resources, vec!["/etc/passwd".to_owned()]);
        assert!(target.action.starts_with("fs."), "{target:?}");
    }
}

#[test]
fn an_apply_patch_request_names_its_files() {
    let targets =
        additional_targets_from_input(&json!({"patchText": "*** Delete File: a.txt\n"}));
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].resources, vec!["a.txt".to_owned()]);
}

#[test]
fn the_registry_builds_the_request_from_the_call() {
    let dir = workspace();
    let registry = registry();
    let ctx = context(dir.path());
    let call = ToolCall::new(
        ToolCallId::new("call_1"),
        "bash",
        json!({"command": "cat /etc/shadow"}),
    );
    let request = registry.permission_request(&call, &ctx).unwrap();
    assert_eq!(
        request.resources,
        vec!["cat /etc/shadow".to_owned()],
        "the primary resources are the command; the paths travel as targets"
    );
    assert!(
        request
            .targets
            .iter()
            .any(|target| target.resources.contains(&"/etc/shadow".to_owned())),
        "{:?}",
        request.targets
    );
}

// ------------------------------------------------------- the one decision

#[tokio::test]
async fn a_command_naming_a_denied_path_is_denied() {
    let dir = workspace();
    let guard = guard_in(
        dir.path(),
        vec![
            Rule::new("exec.run", "**", Effect::Allow),
            Rule::new("fs.read", "**", Effect::Allow),
            Rule::new("fs.write", "**", Effect::Allow),
            Rule::new("fs.read", "/etc/**", Effect::Deny),
        ],
    );
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let mut req = request("bash", "bash", vec!["cat /etc/passwd"]);
    req.targets = additional_targets_from_input(&json!({"command": "cat /etc/passwd"}));
    let decision = gate.authorize(&req).await;
    assert!(
        matches!(decision, GateDecision::Deny { .. }),
        "a path a rule denies must deny the command that names it: {decision:?}"
    );
}

#[tokio::test]
async fn a_command_naming_an_external_path_is_asked_not_silently_allowed() {
    let dir = workspace();
    let guard = guard_in(
        dir.path(),
        vec![
            Rule::new("exec.run", "**", Effect::Allow),
            Rule::new("fs.read", "**", Effect::Allow),
            Rule::new("fs.write", "**", Effect::Allow),
        ],
    );
    let resolver = Arc::new(RecordingResolver::new(ApprovalReply::Reject));
    let gate = gate(guard, resolver.clone());
    let command = "cat /etc/passwd";
    let mut req = request("bash", "bash", vec![command]);
    req.targets = additional_targets_from_input(&json!({"command": command}));
    let decision = gate.authorize(&req).await;
    assert!(
        matches!(decision, GateDecision::Deny { .. }),
        "the rejection of the ask is what denies: {decision:?}"
    );
    let asked = resolver.asked();
    assert_eq!(asked.len(), 1, "exactly one external_directory ask");
    assert!(
        asked[0].resources.contains(&"/etc/passwd".to_owned()),
        "the ask must show the real path: {:?}",
        asked[0].resources
    );
    assert!(
        asked[0].save.iter().any(|rule| rule.resource == "/etc/passwd"),
        "what `always` would remember is the path shown: {:?}",
        asked[0].save
    );
}

#[tokio::test]
async fn a_command_naming_no_external_path_never_asks() {
    let dir = workspace();
    let guard = guard_in(
        dir.path(),
        vec![
            Rule::new("exec.run", "**", Effect::Allow),
            Rule::new("fs.read", "**", Effect::Allow),
            Rule::new("fs.write", "**", Effect::Allow),
        ],
    );
    let resolver = Arc::new(RecordingResolver::new(ApprovalReply::Reject));
    let gate = gate(guard, resolver.clone());
    let command = "cargo test --workspace";
    let mut req = request("bash", "bash", vec![command]);
    req.targets = additional_targets_from_input(&json!({"command": command}));
    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    assert!(resolver.asked().is_empty());
}

// ------------------------------------------------------ ticket effect path

#[tokio::test]
async fn the_ticket_is_validated_and_spent_before_the_effect() {
    let dir = workspace();
    let guard = guard_in(
        dir.path(),
        vec![
            Rule::new("fs.write", "**", Effect::Allow),
            Rule::new("exec.run", "**", Effect::Allow),
        ],
    );
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let req = request("edit", "write", vec!["a.txt"]);

    // The registry's authorization issues the grant.
    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    assert_eq!(gate.live_grants(), 1);
    // The tool's re-assertion spends it.
    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    assert_eq!(gate.live_grants(), 0, "the grant is consumed, not remembered");
    // "Allow once" means once: a third pass has nothing to spend.
    assert!(
        matches!(gate.authorize(&req).await, GateDecision::Deny { .. }),
        "a spent grant must not authorize a further effect"
    );
}

#[tokio::test]
async fn a_replay_of_a_spent_call_identity_is_refused() {
    let dir = workspace();
    let guard = guard_in(dir.path(), vec![Rule::new("fs.read", "**", Effect::Allow)]);
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let req = request("read", "read", vec!["a.txt"]);
    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    assert!(matches!(gate.authorize(&req).await, GateDecision::Deny { .. }));
}

#[tokio::test]
async fn a_request_that_grew_after_authorization_cannot_pass_on_a_narrower_grant() {
    let dir = workspace();
    let guard = guard_in(
        dir.path(),
        vec![
            Rule::new("exec.run", "**", Effect::Allow),
            Rule::new("fs.read", "**", Effect::Allow),
            Rule::new("fs.write", "**", Effect::Allow),
        ],
    );
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let command = "cat a.txt";
    let mut narrow = request("bash", "bash", vec![command]);
    narrow.targets = additional_targets_from_input(&json!({"command": command}));
    assert_eq!(gate.authorize(&narrow).await, GateDecision::Allow);

    // The same call identity now claims a path the grant never covered.
    let mut grown = request("bash", "bash", vec![command]);
    grown.targets = additional_targets_from_input(&json!({"command": "cat a.txt /etc/shadow"}));
    assert!(
        matches!(gate.authorize(&grown).await, GateDecision::Deny { .. }),
        "the grant must be checked against every pair the effect names"
    );
}

#[tokio::test]
async fn revoking_the_grants_stops_live_authorizations() {
    let dir = workspace();
    let guard = guard_in(dir.path(), vec![Rule::new("fs.write", "**", Effect::Allow)]);
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let req = request("edit", "write", vec!["a.txt"]);
    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    assert_eq!(gate.live_grants(), 1);
    gate.revoke_all();
    assert_eq!(gate.live_grants(), 0);
    assert!(
        matches!(gate.authorize(&req).await, GateDecision::Deny { .. }),
        "a revoked grant must not authorize its effect"
    );
}

#[tokio::test]
async fn a_deny_never_issues_a_grant() {
    let dir = workspace();
    let guard = guard_in(dir.path(), vec![Rule::new("fs.write", "**", Effect::Deny)]);
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    assert!(
        matches!(
            gate.authorize(&request("edit", "write", vec!["a.txt"])).await,
            GateDecision::Deny { .. }
        )
    );
    assert_eq!(gate.live_grants(), 0);
}

#[tokio::test]
async fn a_tool_call_runs_only_with_a_spent_grant() {
    // The end-to-end shape: the registry authorizes, the tool re-asserts, and the
    // effect happens exactly once.
    let dir = workspace();
    let registry = registry();
    let guard = guard_in(
        dir.path(),
        vec![
            Rule::new("fs.write", "**", Effect::Allow),
            Rule::new("fs.read", "**", Effect::Allow),
        ],
    );
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    // The context carries the call identity the loop would use, so the tool's
    // re-assertion lands on the same grant.
    let ctx = ToolContext::new(
        SessionId::new("ses_test"),
        ToolCallId::new("call_w"),
        dir.path(),
    )
    .with_resolved_scope(scope(dir.path()))
    .with_gate(gate.clone() as Arc<dyn PermissionGate>);
    let call = ToolCall::new(
        ToolCallId::new("call_w"),
        "write",
        json!({"path": "a.txt", "content": "x"}),
    );
    let settlement = registry
        .settle(&call, &ctx, gate.as_ref(), &OutputBounds::default())
        .await;
    assert_eq!(settlement.status, ToolStatus::Success, "{settlement:?}");
    assert!(dir.path().join("a.txt").is_file());
    assert_eq!(gate.live_grants(), 0, "the grant was spent on the effect");
}

#[tokio::test]
async fn a_tool_call_without_a_grant_does_not_run() {
    let dir = workspace();
    let registry = registry();
    // A gate that allows the registry's pass but refuses the tool's re-assertion:
    // the effect must not happen.
    #[derive(Debug)]
    struct SecondPassDeny;
    #[async_trait]
    impl PermissionGate for SecondPassDeny {
        async fn authorize(&self, request: &PermissionRequest) -> GateDecision {
            if request
                .metadata
                .get("self_assert")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return GateDecision::Deny {
                    reason: "the grant is not valid for this effect".to_owned(),
                };
            }
            GateDecision::Allow
        }
    }
    let gate: Arc<dyn PermissionGate> = Arc::new(SecondPassDeny);
    let ctx = ToolContext::new(
        SessionId::new("ses_test"),
        ToolCallId::new("call_w"),
        dir.path(),
    )
    .with_resolved_scope(scope(dir.path()))
    .with_gate(gate.clone());
    let call = ToolCall::new(
        ToolCallId::new("call_w"),
        "write",
        json!({"path": "a.txt", "content": "x"}),
    );
    let settlement = registry
        .settle(&call, &ctx, gate.as_ref(), &OutputBounds::default())
        .await;
    assert_eq!(settlement.status, ToolStatus::Denied, "{settlement:?}");
    assert!(
        !dir.path().join("a.txt").exists(),
        "an effect must not run when its own authorization is refused"
    );
}

#[tokio::test]
async fn the_plain_policy_gate_still_works_for_callers_without_tickets() {
    let gate = PolicyGate::read_only().allow(["read".to_owned()]);
    assert_eq!(
        gate.authorize(&request("read", "read", vec!["a.txt"])).await,
        GateDecision::Allow
    );
}

#[test]
fn an_empty_target_contributes_nothing() {
    assert!(additional_targets_from_input(&json!({})).is_empty());
    assert!(
        additional_targets_from_input(&json!({"command": "ls"})).is_empty(),
        "a command naming no path has no target"
    );
    let target = PermissionTarget::new("fs.read", vec!["a.txt".to_owned()]);
    assert_eq!(target.action, "fs.read");
}
