//! The permission seam: resource extraction, the external-directory ask, and
//! ticket validation on the effect path (`DEC-024`, `DEC-025`, `REQ-SEC-025`,
//! `ARCH/12`, `ARCH/10`).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use horizoncode_guard::{
    ApprovalReply, ApprovalRequest, ApprovalResolver, Effect, Guard, GuardMode, Rule,
};
use horizoncode_sandbox::{ConfinementProfile, ResolvedProfile};
use horizoncode_tools::{
    ApprovalObserver, ApprovalRecord, BuiltinOptions, GateDecision, GuardPermissionGate,
    OutputBounds, PermissionGate, PermissionRequest, PermissionTarget, PolicyGate, TicketNotice,
    ToolContext, ToolRegistry, additional_targets_from_input, extract_patch_paths,
    extract_path_arguments, register_all_builtins,
};
use horizoncode_types::{SessionId, ToolCall, ToolCallId, ToolStatus, TurnId};
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
            .with_default_rules(rules)
            .build(),
    )
}

fn gate(guard: Arc<Guard>, resolver: Arc<dyn ApprovalResolver>) -> Arc<GuardPermissionGate> {
    Arc::new(GuardPermissionGate::new(guard, resolver))
}

/// The turn these helper-built requests belong to. It is fixed, because the
/// call identity is *(turn, call id)*: two requests that share a call id and are
/// meant to be the same call must also share a turn.
const TEST_TURN: &str = "turn_test";

fn request(action: &str, tool: &str, resources: Vec<&str>) -> PermissionRequest {
    request_in(action, tool, resources, TurnId::new(TEST_TURN))
}

/// A request bound to one call in one turn, which is what the call identity is.
fn request_in(
    action: &str,
    tool: &str,
    resources: Vec<&str>,
    turn_id: TurnId,
) -> PermissionRequest {
    PermissionRequest {
        action: action.to_owned(),
        tool_name: tool.to_owned(),
        resources: resources.into_iter().map(str::to_owned).collect(),
        session_id: SessionId::new("ses_test"),
        source: ToolCallId::new("call_1"),
        turn_id: Some(turn_id),
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
        vec!["/home/u/.ssh/id_rsa".to_owned(), "/tmp/x".to_owned()]
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
    let targets = additional_targets_from_input(&json!({"patchText": "*** Delete File: a.txt\n"}));
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
        asked[0]
            .save
            .iter()
            .any(|rule| rule.resource == "/etc/passwd"),
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

    // The registry's authorization is the decision, and it issues the grant.
    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    assert_eq!(gate.live_grants(), 1);
    // The tool's re-assertion spends it; it is not another decision.
    assert_eq!(gate.consume(&req).await, GateDecision::Allow);
    assert_eq!(
        gate.live_grants(),
        0,
        "the grant is consumed, not remembered"
    );
    // "Allow once" means once: the same identity has nothing left to spend.
    assert!(
        matches!(gate.consume(&req).await, GateDecision::Deny { .. }),
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
    assert_eq!(gate.consume(&req).await, GateDecision::Allow);
    // Re-authorizing a spent identity is a replay, not a new call.
    assert!(matches!(
        gate.authorize(&req).await,
        GateDecision::Deny { .. }
    ));
}

/// A second *decision* where one is already live is refused with the reason,
/// rather than issuing a second grant and leaving the effect's spend ambiguous.
#[tokio::test]
async fn a_second_authorization_instead_of_a_spend_is_refused() {
    let dir = workspace();
    let guard = guard_in(dir.path(), vec![Rule::new("fs.read", "**", Effect::Allow)]);
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let req = request("read", "read", vec!["a.txt"]);
    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    match gate.authorize(&req).await {
        GateDecision::Deny { reason } => {
            assert!(
                reason.contains("spend it at the effect boundary"),
                "{reason}"
            );
        }
        other => panic!("a second decision must not be allowed: {other:?}"),
    }
    // The original grant survives the refusal, so the effect can still run once.
    assert_eq!(gate.live_grants(), 1);
    assert_eq!(gate.consume(&req).await, GateDecision::Allow);
}

/// `F-66`: a call that names no resource is a whole-action request, and the
/// guard allows it. The tool then re-asserts with the resource it defaulted to,
/// and the grant must cover it — otherwise the call is allowed and then denied
/// for the same effect.
/// The grant lifecycle is what remains visible after the re-assertion stopped
/// being recorded as a decision: an issued ticket and a spent one are two ticket
/// events, never two policy decisions (`F-66`).
#[tokio::test]
async fn a_spent_grant_is_reported_as_ticket_lifecycle() {
    #[derive(Debug, Default)]
    struct Notices(Mutex<Vec<&'static str>>);

    #[async_trait]
    impl ApprovalObserver for Notices {
        fn on_approval(&self, _record: &ApprovalRecord) {}

        fn on_ticket(&self, record: &TicketNotice) {
            self.0.lock().unwrap().push(record.granted_by);
        }
    }

    let dir = workspace();
    let guard = guard_in(dir.path(), vec![Rule::new("fs.read", "**", Effect::Allow)]);
    let notices = Arc::new(Notices::default());
    let gate =
        GuardPermissionGate::new(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)))
            .with_approval_observer(notices.clone());
    let req = request("read", "read", vec!["a.txt"]);

    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    assert_eq!(gate.consume(&req).await, GateDecision::Allow);

    assert_eq!(
        *notices.0.lock().unwrap(),
        vec!["rule", "validated"],
        "the issue and the spend are both visible, as ticket lifecycle"
    );
}

#[tokio::test]
async fn a_call_naming_no_resource_is_spent_by_the_tools_default_resource() {
    let dir = workspace();
    let registry = registry();
    let guard = guard_in(dir.path(), vec![Rule::new("fs.read", "**", Effect::Allow)]);
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let ctx = ToolContext::new(
        SessionId::new("ses_test"),
        ToolCallId::new("call_list"),
        dir.path(),
    )
    .with_resolved_scope(scope(dir.path()))
    .with_gate(gate.clone() as Arc<dyn PermissionGate>);
    // `{}` is the shape a read-only directory listing arrives in: the model
    // names no path, so the tool resolves the default itself.
    let call = ToolCall::new(ToolCallId::new("call_list"), "list", json!({}));
    let settlement = registry
        .settle(&call, &ctx, gate.as_ref(), &OutputBounds::default())
        .await;
    assert_eq!(
        settlement.status,
        ToolStatus::Success,
        "a read-only call must not be denied by its own re-assertion: {settlement:?}"
    );
    assert_eq!(gate.live_grants(), 0, "the grant was spent on the effect");
}

/// The wildcard is one-directional: a whole-action grant covers a named
/// resource, but a narrow grant does not cover a whole-action request, so a
/// request can never widen the grant it was issued.
#[tokio::test]
async fn a_narrow_grant_does_not_cover_a_whole_action_request() {
    let dir = workspace();
    let guard = guard_in(dir.path(), vec![Rule::new("fs.read", "**", Effect::Allow)]);
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let narrow = request("read", "read", vec!["a.txt"]);
    assert_eq!(gate.authorize(&narrow).await, GateDecision::Allow);
    // The same call identity now claims the whole action.
    let widened = request("read", "read", vec![]);
    assert!(
        matches!(gate.consume(&widened).await, GateDecision::Deny { .. }),
        "a grant for one file must not authorize every file"
    );
}

/// The call identity is *(turn, call id)*: a provider may reuse an id in a later
/// turn, and that is a new call, not a replay of the old one.
#[tokio::test]
async fn a_reused_call_id_in_a_later_turn_is_a_new_call() {
    let dir = workspace();
    let guard = guard_in(dir.path(), vec![Rule::new("fs.read", "**", Effect::Allow)]);
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let first_turn = TurnId::new("turn_1");
    let first = request_in("read", "read", vec!["a.txt"], first_turn);
    assert_eq!(gate.authorize(&first).await, GateDecision::Allow);
    assert_eq!(gate.consume(&first).await, GateDecision::Allow);

    // The same call id, a later turn: a new call, decided on its own merits.
    let later = request_in("read", "read", vec!["b.txt"], TurnId::new("turn_2"));
    assert_eq!(
        gate.authorize(&later).await,
        GateDecision::Allow,
        "an id collision across turns must not deny a legitimate later call"
    );
    assert_eq!(gate.consume(&later).await, GateDecision::Allow);
}

/// The turn scoping must not weaken replay protection inside the turn that
/// issued the grant.
#[tokio::test]
async fn a_replay_inside_the_issuing_turn_is_still_refused() {
    let dir = workspace();
    let guard = guard_in(dir.path(), vec![Rule::new("fs.read", "**", Effect::Allow)]);
    let gate = gate(guard, Arc::new(RecordingResolver::new(ApprovalReply::Once)));
    let turn = TurnId::new(TEST_TURN);
    let req = request_in("read", "read", vec!["a.txt"], turn);
    assert_eq!(gate.authorize(&req).await, GateDecision::Allow);
    assert_eq!(gate.consume(&req).await, GateDecision::Allow);
    assert!(
        matches!(gate.authorize(&req).await, GateDecision::Deny { .. }),
        "a spent grant is spent for the rest of its turn"
    );
    assert!(matches!(
        gate.consume(&req).await,
        GateDecision::Deny { .. }
    ));
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
    assert!(matches!(
        gate.authorize(&request("edit", "write", vec!["a.txt"]))
            .await,
        GateDecision::Deny { .. }
    ));
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
        gate.authorize(&request("read", "read", vec!["a.txt"]))
            .await,
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

// ------------------------------------------ reduced approval on the gate

#[tokio::test]
async fn reduced_approval_resolves_an_eligible_ask_without_the_resolver() {
    let dir = workspace();
    let guard = Arc::new(
        Guard::builder()
            .discover_global(false)
            .with_workspace(dir.path())
            .with_mode(GuardMode::Yolo)
            .with_unmatched(Effect::Deny)
            .with_default_rules(vec![Rule::new("fs.write", "**", Effect::Ask)])
            .build(),
    );
    let resolver = Arc::new(RecordingResolver::new(ApprovalReply::Reject));
    let gate = gate(guard, resolver.clone());
    assert_eq!(
        gate.authorize(&request("write", "write", vec!["a.txt"]))
            .await,
        GateDecision::Allow,
        "an eligible ask is resolved by the guard's reduced-approval posture"
    );
    assert!(resolver.asked().is_empty());
}

#[tokio::test]
async fn reduced_approval_leaves_an_external_reach_to_the_resolver() {
    let dir = workspace();
    let guard = Arc::new(
        Guard::builder()
            .discover_global(false)
            .with_workspace(dir.path())
            .with_mode(GuardMode::Yolo)
            .with_unmatched(Effect::Deny)
            .with_default_rules(vec![
                Rule::new("exec.run", "**", Effect::Allow),
                Rule::new("fs.read", "**", Effect::Allow),
                Rule::new("fs.write", "**", Effect::Allow),
            ])
            .build(),
    );
    let resolver = Arc::new(RecordingResolver::new(ApprovalReply::Reject));
    let gate = gate(guard, resolver.clone());
    let command = "cat /etc/passwd";
    let mut req = request("bash", "bash", vec![command]);
    req.targets = additional_targets_from_input(&json!({"command": command}));
    assert!(
        matches!(gate.authorize(&req).await, GateDecision::Deny { .. }),
        "the external-directory ask must stay manual even under reduced approval"
    );
    assert_eq!(
        resolver.asked().len(),
        1,
        "the external reach is still presented for an explicit decision"
    );
}
