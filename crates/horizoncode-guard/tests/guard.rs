//! Guard policy semantics: precedence, ceilings, fail-closed, tickets, modes
//! and the catastrophic gate (`REQ-GUARD-001..004`).

use horizoncode_guard::{
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
    let config_dir = dir.path().join(".horizoncode");
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
    let project_dir = root.path().join("project/.horizoncode");
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
    let deny = horizoncode_guard::DenyAllResolver;
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

    let auto = horizoncode_guard::AutoApproveResolver;
    assert_eq!(auto.resolve(&request).await, ApprovalReply::Once);
    let catastrophic = ApprovalRequest {
        catastrophic: true,
        ..request
    };
    assert_eq!(auto.resolve(&catastrophic).await, ApprovalReply::Reject);
}

/// The global document carries posture, not only rules. Reading `mode` and
/// `unmatched` from the project layer while ignoring the global layer meant a
/// user's global `{"guard":{"mode":"plan"}}` silently produced the permissive
/// default — a config that reads as a posture and does nothing.
mod document_posture {
    use horizoncode_guard::{Effect, Guard, GuardMode};

    fn write(path: &std::path::Path, text: &str) {
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn the_global_document_sets_mode_and_unmatched() {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("global.jsonc");
        write(
            &global,
            r#"{ "guard": { "mode": "plan", "unmatched": "ask",
                 "rules": [ { "action": "fs.read", "resource": "**", "effect": "allow" } ] } }"#,
        );
        let guard = Guard::builder()
            .with_global_config(&global)
            .with_workspace(dir.path())
            .build();
        assert!(guard.degraded().is_none(), "{:?}", guard.degraded());
        assert_eq!(guard.mode(), GuardMode::Plan);
        assert_eq!(guard.unmatched(), Effect::Ask);
        // Plan mode is a ceiling applied after rule evaluation.
        assert!(matches!(
            guard.evaluate("fs.write", &["a.txt".to_owned()]),
            horizoncode_guard::GuardDecision::Deny { .. }
        ));
    }

    #[test]
    fn a_nearer_project_document_wins_over_the_global_one() {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("global.jsonc");
        write(
            &global,
            r#"{ "guard": { "mode": "plan", "unmatched": "deny" } }"#,
        );
        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join(".horizoncode")).unwrap();
        write(
            &project.join(".horizoncode/config.jsonc"),
            r#"{ "guard": { "mode": "act" } }"#,
        );
        let guard = Guard::builder()
            .with_global_config(&global)
            .with_workspace(&project)
            .build();
        assert_eq!(guard.mode(), GuardMode::Act);
        // The global `unmatched` still stands: the project did not set one.
        assert_eq!(guard.unmatched(), Effect::Deny);
    }

    #[test]
    fn an_explicit_override_wins_over_any_document() {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("global.jsonc");
        write(&global, r#"{ "guard": { "mode": "plan" } }"#);
        let guard = Guard::builder()
            .with_global_config(&global)
            .with_workspace(dir.path())
            .with_mode(GuardMode::Yolo)
            .build();
        assert_eq!(guard.mode(), GuardMode::Yolo);
    }

    #[test]
    fn the_configured_approval_timeout_is_consulted() {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("global.jsonc");
        write(
            &global,
            r#"{ "guard": { "approval": { "default_timeout_ms": 1000 },
                 "rules": [ { "action": "fs.read", "resource": "**", "effect": "allow" } ] } }"#,
        );
        let guard = Guard::builder()
            .with_global_config(&global)
            .with_workspace(dir.path())
            .build();
        assert!(guard.degraded().is_none(), "{:?}", guard.degraded());
        let request = horizoncode_guard::GuardRequest::new("fs.read", vec!["a.txt".to_owned()]);
        let ticket = guard.issue_ticket(&request, None);
        let ttl = ticket.expires_at_ms.saturating_sub(horizoncode_guard::now_ms());
        assert!(
            ttl <= 1_000 && ttl > 500,
            "the configured approval window must bound the ticket: {ttl} ms"
        );
    }

    #[test]
    fn a_malformed_approval_timeout_rejects_the_layer() {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("global.jsonc");
        write(
            &global,
            r#"{ "guard": { "approval": { "default_timeout_ms": -5 } } }"#,
        );
        let guard = Guard::builder()
            .with_global_config(&global)
            .with_workspace(dir.path())
            .build();
        assert!(
            guard.degraded().is_some(),
            "a malformed timeout must reject the layer, not be ignored"
        );
        assert!(matches!(
            guard.evaluate("fs.read", &["a.txt".to_owned()]),
            horizoncode_guard::GuardDecision::Deny { .. }
        ));
    }
}

/// `DEC-025` / `REQ-SEC-025`: one path grammar, one command matcher. A
/// path-shaped `exec.run` resource cannot be expressed by the command matcher, so
/// accepting it at load creates a protection that is silently unenforceable.
mod exec_run_path_resources {
    use horizoncode_guard::{Effect, Guard, Rule, parse_document};

    #[test]
    fn a_path_shaped_exec_run_rule_is_rejected_at_load() {
        for resource in [
            "/home/user/.ssh/**",
            "**/.env",
            "~/secrets",
            "./config.json",
            "../outside/**",
            "etc/passwd",
        ] {
            let text = format!(
                r#"{{ "guard": {{ "rules": [ {{ "action": "exec.run", "resource": "{resource}", "effect": "deny" }} ] }} }}"#
            );
            let error = parse_document(&text, "test").expect_err(resource);
            assert!(
                error.to_string().contains("exec.run"),
                "{resource} must be rejected with an explanation: {error}"
            );
        }
    }

    #[test]
    fn a_command_token_prefix_is_still_accepted() {
        for resource in [
            "**",
            "*",
            "cargo test*",
            "rm -rf /*",
            "git commit*",
            "npm run",
            "cat",
            "dd *of=/dev/*",
        ] {
            let text = format!(
                r#"{{ "guard": {{ "rules": [ {{ "action": "exec.run", "resource": "{resource}", "effect": "deny" }} ] }} }}"#
            );
            parse_document(&text, "test").unwrap_or_else(|error| panic!("{resource}: {error}"));
        }
    }

    #[test]
    fn the_same_protection_is_expressible_as_a_path_rule() {
        // Rejecting the form must not remove the capability: a path protection is
        // fully expressible as an `fs.*` rule, which the path matcher owns.
        let text = r#"{ "guard": { "rules": [
            { "action": "fs.read", "resource": "**/.ssh/**", "effect": "deny" }
        ] } }"#;
        let document = parse_document(text, "test").unwrap();
        assert_eq!(document.rules.len(), 1);
        let guard = Guard::builder()
            .discover_global(false)
            .with_unmatched(Effect::Allow)
            .with_session_rules(document.rules)
            .build();
        assert!(matches!(
            guard.evaluate("fs.read", &["/home/u/.ssh/id_rsa".to_owned()]),
            horizoncode_guard::GuardDecision::Deny { .. }
        ));
    }

    #[test]
    fn the_rejection_also_applies_to_a_rule_constructed_in_code() {
        assert!(
            Rule::new("exec.run", "/etc/**", Effect::Deny).validate().is_err(),
            "a programmatically built rule must be held to the same grammar"
        );
        assert!(Rule::new("exec.run", "cargo test*", Effect::Deny).validate().is_ok());
        // An `fs.*` action carries a path freely.
        assert!(Rule::new("fs.read", "/etc/**", Effect::Deny).validate().is_ok());
    }
}

/// `DEC-024` / `DEC-025` / `REQ-SEC-025`: one request may name several targets —
/// the command token prefix for `exec.run` **and** the `fs.*` resources a shell
/// argument names — and the guard returns exactly one decision over the whole
/// set. The built-in external-directory floor raises an outside-root path to the
/// single `external_directory` ask; it can only ever raise.
mod external_directory_floor {
    use horizoncode_guard::{Effect, Guard, GuardDecision, GuardMode, GuardRequest, Rule};

    fn ws() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn guard_in(dir: &std::path::Path, rules: Vec<Rule>) -> Guard {
        Guard::builder()
            .discover_global(false)
            .with_workspace(dir)
            .with_mode(GuardMode::Act)
            .with_unmatched(Effect::Deny)
            .with_session_rules(rules)
            .build()
    }

    fn allow_fs() -> Vec<Rule> {
        vec![
            Rule::new("fs.read", "**", Effect::Allow),
            Rule::new("fs.write", "**", Effect::Allow),
            Rule::new("exec.run", "**", Effect::Allow),
        ]
    }

    #[test]
    fn a_wildcard_allow_does_not_extend_to_a_path_outside_the_granted_roots() {
        let ws = ws();
        let guard = guard_in(ws.path(), allow_fs());
        assert_eq!(
            guard.evaluate("fs.read", &["src/main.rs".to_owned()]),
            GuardDecision::Allow,
            "an in-root path is unaffected"
        );
        assert_eq!(
            guard.evaluate("fs.read", &["/etc/passwd".to_owned()]),
            GuardDecision::Ask,
            "a `**` allow must not silently become an allow of the whole host"
        );
    }

    #[test]
    fn a_lexically_escaped_relative_path_is_still_an_external_path() {
        let ws = ws();
        let guard = guard_in(ws.path(), allow_fs());
        assert_eq!(
            guard.evaluate("fs.read", &["../../etc/passwd".to_owned()]),
            GuardDecision::Ask
        );
    }

    #[test]
    fn a_deliberate_external_allow_is_honoured() {
        let ws = ws();
        let mut rules = allow_fs();
        rules.push(Rule::new("fs.read", "/opt/vendor/**", Effect::Allow));
        let guard = guard_in(ws.path(), rules);
        assert_eq!(
            guard.evaluate("fs.read", &["/opt/vendor/lib.rs".to_owned()]),
            GuardDecision::Allow,
            "a rule that names the external area is an explicit grant"
        );
    }

    #[test]
    fn the_floor_never_lowers_a_deny() {
        let ws = ws();
        let mut rules = allow_fs();
        rules.push(Rule::new("fs.write", "/etc/**", Effect::Deny));
        let guard = guard_in(ws.path(), rules);
        assert!(matches!(
            guard.evaluate("fs.write", &["/etc/shadow".to_owned()]),
            GuardDecision::Deny { .. }
        ));
    }

    #[test]
    fn without_a_workspace_every_absolute_path_is_outside_the_granted_roots() {
        // Nothing is granted, so nothing is inside: the floor is fail-closed.
        let guard = Guard::builder()
            .discover_global(false)
            .with_unmatched(Effect::Allow)
            .with_session_rules(allow_fs())
            .build();
        assert_eq!(
            guard.evaluate("fs.read", &["/etc/passwd".to_owned()]),
            GuardDecision::Ask
        );
    }

    #[test]
    fn one_request_carries_the_command_and_the_paths_it_names() {
        let ws = ws();
        let mut rules = allow_fs();
        rules.push(Rule::new("fs.read", "/etc/**", Effect::Deny));
        let guard = guard_in(ws.path(), rules);
        let request = GuardRequest::new("exec.run", vec!["cat /etc/passwd".to_owned()])
            .with_target("fs.read", vec!["/etc/passwd".to_owned()])
            .with_target("fs.write", vec!["/etc/passwd".to_owned()]);
        assert!(
            matches!(guard.check(&request), GuardDecision::Deny { .. }),
            "the extracted path target must be part of the one decision"
        );
    }

    #[test]
    fn an_extracted_target_may_only_raise_the_outcome() {
        let ws = ws();
        let guard = guard_in(ws.path(), allow_fs());
        // Allow, raised to the external ask.
        let request = GuardRequest::new("exec.run", vec!["ls /etc".to_owned()])
            .with_target("fs.read", vec!["/etc".to_owned()]);
        assert_eq!(guard.check(&request), GuardDecision::Ask);
        // An ask cannot be lowered by a target that is allowed.
        let guard = guard_in(
            ws.path(),
            vec![
                Rule::new("exec.run", "**", Effect::Ask),
                Rule::new("fs.write", "**", Effect::Allow),
            ],
        );
        let request = GuardRequest::new("exec.run", vec!["cargo test".to_owned()])
            .with_target("fs.write", vec!["src/a.rs".to_owned()]);
        assert_eq!(guard.check(&request), GuardDecision::Ask);
    }

    #[test]
    fn plan_mode_ceils_every_target() {
        let ws = ws();
        let guard = Guard::builder()
            .discover_global(false)
            .with_workspace(ws.path())
            .with_mode(GuardMode::Plan)
            .with_unmatched(Effect::Allow)
            .with_session_rules(allow_fs())
            .build();
        let request = GuardRequest::new("exec.run", vec!["cargo test".to_owned()])
            .with_target("fs.write", vec!["src/a.rs".to_owned()]);
        assert!(matches!(guard.check(&request), GuardDecision::Deny { .. }));
    }

    #[test]
    fn a_non_filesystem_action_is_never_raised_by_the_floor() {
        let ws = ws();
        let guard = guard_in(ws.path(), vec![Rule::new("net.connect", "**", Effect::Allow)]);
        assert_eq!(
            guard.evaluate("net.connect", &["example.invalid:443".to_owned()]),
            GuardDecision::Allow,
            "the floor is a path rule and does not touch other action domains"
        );
    }

    #[test]
    fn a_target_goes_through_the_same_canonical_action() {
        let ws = ws();
        let guard = guard_in(
            ws.path(),
            vec![
                Rule::new("fs.read", "**", Effect::Allow),
                Rule::new("fs.read", "**/.ssh/**", Effect::Deny),
            ],
        );
        // The tool plane names the tool, not the capability; the guard maps it.
        let request = GuardRequest::new("read", Vec::new())
            .with_target("read", vec!["/home/u/.ssh/id_rsa".to_owned()]);
        assert!(
            matches!(guard.check(&request), GuardDecision::Deny { .. }),
            "an extracted target must go through the same canonical action"
        );
    }
}

/// `S7`: a ticket is a grant only while it is live, and "allow once" has to mean
/// once. The stored policy fingerprint is compared, not merely issued.
mod ticket_effect_path {
    use horizoncode_guard::{
        Effect, Guard, GuardMode, GuardRequest, Rule, Ticket, TicketStore, now_ms,
    };

    fn guard() -> Guard {
        Guard::builder()
            .discover_global(false)
            .with_mode(GuardMode::Act)
            .with_unmatched(Effect::Deny)
            .with_session_rules(vec![
                Rule::new("fs.read", "**", Effect::Allow),
                Rule::new("fs.write", "**", Effect::Allow),
            ])
            .build()
    }

    #[test]
    fn a_rule_grant_is_a_single_use_ticket() {
        let guard = guard();
        let request = GuardRequest::new("fs.write", vec!["src/main.rs".to_owned()]);
        let ticket = guard.issue_ticket(&request, None);
        assert!(ticket.single_use, "an unbounded ticket is not a grant");
        assert_eq!(ticket.uses, 1);
        // It pays for exactly the effect it names, once.
        assert!(
            guard
                .validate_ticket(&ticket.id, "fs.write", "src/main.rs")
                .is_ok()
        );
        assert!(
            guard
                .validate_ticket(&ticket.id, "fs.write", "src/main.rs")
                .is_err(),
            "a second effect must not be covered by the same grant"
        );
        // And it never covers a different resource.
        let ticket = guard.issue_ticket(&request, None);
        assert!(
            guard
                .validate_ticket(&ticket.id, "fs.write", "other.rs")
                .is_err()
        );
    }

    #[test]
    fn a_ticket_issued_under_another_policy_cannot_be_spent() {
        let store = TicketStore::new();
        let ticket = Ticket {
            id: "tkt_foreign".to_owned(),
            action: "fs.write".to_owned(),
            scope: vec!["src/**".to_owned()],
            uses: 1,
            single_use: true,
            expires_at_ms: now_ms().saturating_add(60_000),
            // A grant that a later policy change no longer stands behind.
            policy_hash: format!("ph_{}", "0".repeat(64)),
            approval_ref: None,
        };
        store.issue(ticket.clone());
        let current = format!("ph_{}", "1".repeat(64));
        let error = store
            .validate(&ticket.id, "fs.write", "src/main.rs", &current)
            .unwrap_err();
        assert!(
            error.to_string().contains("different policy"),
            "the stored policy hash must be compared, not merely issued: {error}"
        );
        // The same ticket is fine under the policy it was issued for.
        store
            .validate(&ticket.id, "fs.write", "src/main.rs", &ticket.policy_hash)
            .unwrap();
    }

    #[test]
    fn a_revoked_ticket_cannot_be_spent() {
        let guard = guard();
        let request = GuardRequest::new("fs.read", vec!["a.txt".to_owned()]);
        let ticket = guard.issue_ticket(&request, None);
        assert!(guard.revoke_ticket(&ticket.id));
        assert!(
            guard
                .validate_ticket(&ticket.id, "fs.read", "a.txt")
                .is_err()
        );
    }

    #[test]
    fn revoking_everything_invalidates_live_grants() {
        let guard = guard();
        let request = GuardRequest::new("fs.read", vec!["a.txt".to_owned()]);
        let first = guard.issue_ticket(&request, None);
        let second = guard.issue_ticket(&request, None);
        assert_eq!(guard.live_tickets(), 2);
        guard.revoke_all_tickets();
        assert_eq!(guard.live_tickets(), 0);
        for ticket in [&first, &second] {
            assert!(guard.validate_ticket(&ticket.id, "fs.read", "a.txt").is_err());
        }
    }

    #[test]
    fn a_single_use_approval_ticket_is_bounded_and_expiring() {
        let guard = guard();
        let ticket = guard.issue_single_use("fs.read", vec!["a.txt".to_owned()], 50_000);
        assert!(ticket.single_use);
        assert_eq!(ticket.uses, 1);
        assert!(ticket.expires_at_ms <= now_ms().saturating_add(50_000));
    }
}

/// The policy fingerprint is quoted into the audit chain, so it must be a real
/// cryptographic digest of a stable canonical form — not a
/// `DefaultHasher` fingerprint, which changes between toolchain releases and is
/// not collision-resistant. `horizoncode-audit` owns that digest, so the fingerprint is
/// the audit chain's own primitive over an explicit, length-framed byte form.
mod policy_hash {
    use horizoncode_guard::{Effect, Guard, GuardMode, Rule, default_rules};

    fn hash_of(rules: Vec<Rule>, unmatched: Effect) -> String {
        Guard::from_rules(rules, GuardMode::Act, unmatched)
            .policy_hash()
            .to_owned()
    }

    /// The canonical byte form the fingerprint is taken over, rebuilt here from
    /// the specification rather than from the implementation, so the assertion
    /// pins the framing as well as the primitive.
    fn expected_digest(rules: &[Rule], mode: GuardMode, unmatched: Effect) -> String {
        fn field(bytes: &mut Vec<u8>, value: &str) {
            bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        let mut bytes: Vec<u8> = b"horizoncode/guard/policy/v1".to_vec();
        field(&mut bytes, mode.as_str());
        field(&mut bytes, unmatched.as_str());
        // `from_rules` builds exactly one layer: the session layer.
        bytes.extend_from_slice(&1u64.to_be_bytes());
        field(&mut bytes, "session");
        bytes.extend_from_slice(&(rules.len() as u64).to_be_bytes());
        for rule in rules {
            field(&mut bytes, &rule.action);
            field(&mut bytes, &rule.resource);
            field(&mut bytes, rule.effect.as_str());
        }
        // No global or project layer, so the ceiling is empty.
        bytes.extend_from_slice(&0u64.to_be_bytes());
        format!("ph_{}", horizoncode_audit::digest(&bytes))
    }

    #[test]
    fn the_fingerprint_is_a_blake3_digest() {
        let hash = hash_of(default_rules(), Effect::Deny);
        assert!(hash.starts_with("ph_"), "{hash}");
        assert_eq!(hash.len(), 3 + 64, "a 32-byte digest in hex: {hash}");
        assert!(
            hash[3..].chars().all(|c| c.is_ascii_hexdigit()),
            "not hex: {hash}"
        );
    }

    #[test]
    fn the_fingerprint_is_the_audit_chains_own_digest_over_the_documented_form() {
        // This is the check that rules out `DefaultHasher`: the value is exactly
        // the audit primitive over the documented canonical bytes. A
        // non-cryptographic or differently-framed fingerprint cannot satisfy it.
        let rules = default_rules();
        assert_eq!(
            hash_of(rules.clone(), Effect::Deny),
            expected_digest(&rules, GuardMode::Act, Effect::Deny)
        );
        assert_eq!(
            hash_of(rules.clone(), Effect::Ask),
            expected_digest(&rules, GuardMode::Act, Effect::Ask)
        );
    }

    #[test]
    fn the_fingerprint_is_stable_across_guard_instances() {
        assert_eq!(
            hash_of(default_rules(), Effect::Deny),
            hash_of(default_rules(), Effect::Deny)
        );
    }

    #[test]
    fn every_effective_field_changes_the_fingerprint() {
        let base = hash_of(default_rules(), Effect::Deny);
        // A different action.
        let mut changed_action = default_rules();
        changed_action[0] = Rule::new("fs.readwrite", "**", Effect::Allow);
        assert_ne!(base, hash_of(changed_action, Effect::Deny));
        // A different resource.
        let mut changed_resource = default_rules();
        changed_resource[0] = Rule::new("fs.read", "src/**", Effect::Allow);
        assert_ne!(base, hash_of(changed_resource, Effect::Deny));
        // A different effect on a later rule, which find-last-wins can reach.
        let mut changed_effect = default_rules();
        changed_effect[1] = Rule::new("fs.write", "**", Effect::Deny);
        assert_ne!(base, hash_of(changed_effect, Effect::Deny));
        // A different unmatched default.
        assert_ne!(base, hash_of(default_rules(), Effect::Ask));
        // A different mode.
        let act = Guard::from_rules(default_rules(), GuardMode::Act, Effect::Deny)
            .policy_hash()
            .to_owned();
        let plan = Guard::from_rules(default_rules(), GuardMode::Plan, Effect::Deny)
            .policy_hash()
            .to_owned();
        assert_ne!(act, plan);
    }

    #[test]
    fn the_framing_prevents_field_boundary_collisions() {
        // Without length-prefixed framing, ("ab", "c") and ("a", "bc") hash to
        // the same byte stream. With it they must not.
        let left = hash_of(
            vec![
                Rule::new("ab", "c", Effect::Allow),
                Rule::new("d", "e", Effect::Allow),
            ],
            Effect::Deny,
        );
        let right = hash_of(
            vec![
                Rule::new("a", "bc", Effect::Allow),
                Rule::new("d", "e", Effect::Allow),
            ],
            Effect::Deny,
        );
        assert_ne!(left, right);
    }
}
