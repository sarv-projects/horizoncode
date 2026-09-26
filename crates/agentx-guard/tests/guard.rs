//! Guard policy semantics: precedence, ceilings, fail-closed, tickets, modes
//! and the catastrophic gate (`REQ-GUARD-001..004`).

use agentx_guard::{
    ApprovalReply, ApprovalRequest, ApprovalResolver, Effect, Guard, GuardDecision, GuardMode, Rule,
};

fn resources(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn rule(action: &str, resource: &str, effect: Effect) -> Rule {
    Rule::new(action, resource, effect)
}

fn make(rules: Vec<Rule>, mode: GuardMode) -> Guard {
    Guard::builder()
        .discover_global(false)
        .with_mode(mode)
        .with_unmatched(Effect::Deny)
        .with_session_rules(rules)
        .build()
}

#[test]
fn find_last_wins_within_a_layer() {
    let guard = make(
        vec![
            rule("fs.write", "**", Effect::Allow),
            rule("fs.write", "secret/**", Effect::Deny),
        ],
        GuardMode::Act,
    );
    assert_eq!(
        guard.evaluate("fs.write", &resources(&["src/main.rs"])),
        GuardDecision::Allow
    );
    assert!(matches!(
        guard.evaluate("fs.write", &resources(&["secret/key"])),
        GuardDecision::Deny { .. }
    ));
}

#[test]
fn unmatched_actions_fail_closed() {
    let guard = make(vec![rule("fs.read", "**", Effect::Allow)], GuardMode::Act);
    assert_eq!(
        guard.evaluate("fs.read", &resources(&["a.txt"])),
        GuardDecision::Allow
    );
    assert!(matches!(
        guard.evaluate("exec.run", &resources(&["echo hi"])),
        GuardDecision::Deny { .. }
    ));
}

#[test]
fn unmatched_may_be_ask_but_never_allow() {
    let guard = Guard::builder()
        .discover_global(false)
        .with_unmatched(Effect::Ask)
        .build();
    assert_eq!(
        guard.evaluate("exec.run", &resources(&["echo hi"])),
        GuardDecision::Ask
    );

    // A caller cannot configure an allow fallback.
    let forced = Guard::builder()
        .discover_global(false)
        .with_unmatched(Effect::Allow)
        .build();
    assert_eq!(forced.unmatched(), Effect::Deny);
}

#[test]
fn outer_deny_ceiling_cannot_be_widened_by_a_session_allow() {
    let project = Rule::new("fs.write", ".git/**", Effect::Deny);
    let session = Rule::new("fs.write", "**", Effect::Allow);
    let guard = Guard::builder()
        .discover_global(false)
        .with_agent_rules(vec![project])
        .with_session_rules(vec![session])
        .build();
    // An agent-layer deny is not a ceiling; a later session allow wins.
    assert_eq!(
        guard.evaluate("fs.write", &resources(&[".git/hooks/pre-commit"])),
        GuardDecision::Allow
    );

    // A project-layer deny is a ceiling and cannot be widened.
    let guard = Guard::builder()
        .discover_global(false)
        .with_default_rules(vec![Rule::new("fs.write", ".git/**", Effect::Deny)])
        .with_session_rules(vec![Rule::new("fs.write", "**", Effect::Allow)])
        .build();
    assert!(matches!(
        guard.evaluate("fs.write", &resources(&[".git/hooks/pre-commit"])),
        GuardDecision::Deny { .. }
    ));
}

#[test]
fn malformed_config_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().join(".agentx");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(
        config_dir.join("config.jsonc"),
        r#"{ "guard": { "rules": [ { "action": "fs.read", "resource": "**", "effect": "permit" } ] } }"#,
    )
    .unwrap();
    let guard = Guard::builder().with_workspace(dir.path()).build();
    assert!(guard.degraded().is_some());
    assert!(matches!(
        guard.evaluate("fs.read", &resources(&["a.txt"])),
        GuardDecision::Deny { .. }
    ));
}

#[test]
fn plan_mode_blocks_mutating_actions_and_allows_reads() {
    let guard = make(
        vec![
            rule("fs.read", "**", Effect::Allow),
            rule("fs.write", "**", Effect::Allow),
            rule("exec.run", "**", Effect::Allow),
        ],
        GuardMode::Plan,
    );
    assert_eq!(
        guard.evaluate("fs.read", &resources(&["a.txt"])),
        GuardDecision::Allow
    );
    assert!(matches!(
        guard.evaluate("fs.write", &resources(&["a.txt"])),
        GuardDecision::Deny { .. }
    ));
    assert!(matches!(
        guard.evaluate("exec.run", &resources(&["echo hi"])),
        GuardDecision::Deny { .. }
    ));
}

#[test]
fn yolo_allows_ask_but_never_the_catastrophic_gate_or_explicit_deny() {
    let guard = make(
        vec![
            rule("exec.run", "**", Effect::Ask),
            rule("exec.run", "danger*", Effect::Deny),
        ],
        GuardMode::Yolo,
    );
    // `ask` collapses to allow under yolo.
    assert_eq!(
        guard.evaluate("exec.run", &resources(&["echo hi"])),
        GuardDecision::Allow
    );
    // An explicit deny still applies.
    assert!(matches!(
        guard.evaluate("exec.run", &resources(&["danger-zone"])),
        GuardDecision::Deny { .. }
    ));
    // The catastrophic gate is irreducible even for an explicit allow + yolo.
    let permissive = make(vec![rule("exec.run", "**", Effect::Allow)], GuardMode::Yolo);
    assert!(matches!(
        permissive.evaluate("exec.run", &resources(&["rm -rf /"])),
        GuardDecision::Deny { .. }
    ));
    assert!(matches!(
        permissive.evaluate("fs.delete", &resources(&["/"])),
        GuardDecision::Deny { .. }
    ));
}

#[test]
fn ticket_scope_ttl_and_single_use() {
    let guard = make(vec![rule("fs.write", "**", Effect::Allow)], GuardMode::Act);
    let ticket = guard.issue_single_use("fs.write", resources(&["src/**"]), 60_000);
    assert!(
        guard
            .validate_ticket(&ticket.id, "fs.write", "src/main.rs")
            .is_ok()
    );
    // Out of scope.
    assert!(
        guard
            .validate_ticket(&ticket.id, "fs.write", "other.txt")
            .is_err()
    );
    // Single-use: the first validation consumed the only use.
    assert!(
        guard
            .validate_ticket(&ticket.id, "fs.write", "src/main.rs")
            .is_err()
    );

    // TTL of zero expires immediately.
    let expired = guard.issue_single_use("fs.write", resources(&["**"]), 0);
    assert!(
        guard
            .validate_ticket(&expired.id, "fs.write", "a.txt")
            .is_err()
    );

    // Wrong action.
    let ticket = guard.issue_single_use("fs.read", resources(&["**"]), 60_000);
    assert!(
        guard
            .validate_ticket(&ticket.id, "fs.write", "a.txt")
            .is_err()
    );
}

#[test]
fn materialize_filter_removes_plan_mode_mutating_tools() {
    let act = make(
        vec![
            rule("fs.read", "**", Effect::Allow),
            rule("fs.write", "**", Effect::Allow),
            rule("exec.run", "**", Effect::Allow),
        ],
        GuardMode::Act,
    );
    let filter = act.materialize_filter();
    assert!(!filter.contains("fs.read"));
    assert!(!filter.contains("fs.write"));

    let plan = make(
        vec![
            rule("fs.read", "**", Effect::Allow),
            rule("fs.write", "**", Effect::Allow),
            rule("exec.run", "**", Effect::Allow),
        ],
        GuardMode::Plan,
    );
    let filter = plan.materialize_filter();
    assert!(filter.contains("fs.write"));
    assert!(filter.contains("exec.run"));
    assert!(!filter.contains("fs.read"));
}

#[test]
fn saved_rule_takes_effect_and_persists() {
    let dir = tempfile::tempdir().unwrap();
    let saved_path = dir.path().join("saved.json");
    let guard = Guard::builder()
        .discover_global(false)
        .with_unmatched(Effect::Ask)
        .with_saved_path(&saved_path)
        .build();
    assert_eq!(
        guard.evaluate("exec.run", &resources(&["cargo test"])),
        GuardDecision::Ask
    );
    guard.persist_saved_rule("exec.run", "cargo test*").unwrap();
    assert_eq!(
        guard.evaluate("exec.run", &resources(&["cargo test --workspace"])),
        GuardDecision::Allow
    );
    assert!(saved_path.is_file());
    assert_eq!(guard.saved_rules().len(), 1);
}

#[test]
fn project_config_overrides_global_nearest_wins() {
    let root = tempfile::tempdir().unwrap();
    let global = root.path().join("global.jsonc");
    std::fs::write(
        &global,
        r#"{ "guard": { "rules": [ { "action": "fs.write", "resource": "**", "effect": "deny" } ] } }"#,
    )
    .unwrap();
    let project_dir = root.path().join("project/.agentx");
    std::fs::create_dir_all(&project_dir).unwrap();
    std::fs::write(
        project_dir.join("config.jsonc"),
        r#"{ "guard": { "rules": [ { "action": "fs.write", "resource": "**", "effect": "allow" } ] } }"#,
    )
    .unwrap();
    // The global deny is a ceiling, so the project allow cannot widen it.
    let guard = Guard::builder()
        .with_global_config(&global)
        .with_workspace(root.path().join("project"))
        .build();
    assert!(matches!(
        guard.evaluate("fs.write", &resources(&["src/main.rs"])),
        GuardDecision::Deny { .. }
    ));

    // Without the global ceiling, the project allow wins.
    let guard = Guard::builder()
        .discover_global(false)
        .with_workspace(root.path().join("project"))
        .build();
    assert_eq!(
        guard.evaluate("fs.write", &resources(&["src/main.rs"])),
        GuardDecision::Allow
    );
}

/// The default and yolo resolvers are exercised through their async contract.
#[tokio::test]
async fn approval_resolvers_are_fail_closed_by_default() {
    let deny = agentx_guard::DenyAllResolver;
    let request = ApprovalRequest {
        action: "exec.run".to_owned(),
        tool: "bash".to_owned(),
        source: "call_1".to_owned(),
        resources: resources(&["echo hi"]),
        save: Vec::new(),
        prompt: "run echo".to_owned(),
        catastrophic: false,
    };
    assert_eq!(deny.resolve(&request).await, ApprovalReply::Reject);

    let auto = agentx_guard::AutoApproveResolver;
    assert_eq!(auto.resolve(&request).await, ApprovalReply::Once);
    let catastrophic = ApprovalRequest {
        catastrophic: true,
        ..request
    };
    assert_eq!(auto.resolve(&catastrophic).await, ApprovalReply::Reject);
}
