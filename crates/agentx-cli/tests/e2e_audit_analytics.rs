//! The end-to-end proof that a real headless run produces a verifiable audit
//! chain and non-empty analytics.
//!
//! This drives the built `agentx` binary against a loopback mock provider, in
//! a temp workspace with a temp `AGENTX_HOME`, and then inspects the artifacts
//! the run actually left behind. Nothing about the record is injected: the
//! chain, the roots, the sink, and the ledger are all written by the run.

use std::fs;
use std::path::Path;

use agentx_analytics::{AnalyticsConfig, AnalyticsLog, usage};
use agentx_audit::{AuditConfig, CensusWindow, EffectClass, census, census_strict, verify};
use agentx_provider::testing::{MockServer, MockTurn};
use serde_json::json;
use tokio::process::Command;

/// A temp workspace and a temp state home.
///
/// Every store is under an explicit `AGENTX_HOME`, so the test cannot read or
/// write the developer's real `~/.agentx`, and no state is shared with any
/// other test — the property that makes the suite order-independent.
struct Sandbox {
    _home: tempfile::TempDir,
    _workspace: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("a.txt"), "alpha\n").unwrap();
        Self {
            _home: home,
            _workspace: workspace,
        }
    }

    fn home(&self) -> &Path {
        self._home.path()
    }

    fn workspace(&self) -> &Path {
        self._workspace.path()
    }
}

async fn run(
    server: &MockServer,
    home: &Path,
    workspace: &Path,
    prompt: &str,
) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_agentx"))
        .args(["-p", prompt, "--cwd", workspace.to_str().unwrap()])
        .env("AGENTX_BASE_URL", server.base_url())
        .env("AGENTX_API_KEY", "test-key")
        .env("AGENTX_MODEL", "mock-model")
        .env("AGENTX_HOME", home)
        .output()
        .await
        .unwrap()
}

async fn verify_with_cli(home: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_agentx"))
        .args(["audit", "verify", "--all"])
        .env_remove("AGENTX_BASE_URL")
        .env("AGENTX_HOME", home)
        .output()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_headless_run_leaves_a_verifiable_chain_and_non_empty_analytics() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("list", json!({})),
        MockTurn::text("The workspace has a.txt."),
    ])
    .await;
    let sandbox = Sandbox::new();

    let output = run(
        &server,
        sandbox.home(),
        sandbox.workspace(),
        "list the files",
    )
    .await;
    assert!(
        output.status.success(),
        "exit={:?} stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("a.txt"));

    // --- The audit chain the run left behind verifies.
    let audit_config = AuditConfig::new(sandbox.home().join("audit"));
    let report = verify(&audit_config).expect("the run's chain must verify");
    assert!(report.entries_checked > 0, "the run recorded nothing");
    assert_eq!(report.claim.level.as_str(), "local-sink");
    assert_eq!(
        report.anchored_roots, report.roots_checked,
        "every finalized root must be anchored at the declared level"
    );
    assert!(
        report.segments.iter().any(|segment| segment.signature_ok),
        "no segment carried a verifying signature"
    );
    for segment in &report.segments {
        assert_eq!(
            Some(&segment.recomputed_merkle_root),
            segment.signed_merkle_root.as_ref(),
            "a recomputed root must equal the signed root"
        );
    }

    // The chain is durable on disk in the documented layout.
    assert!(sandbox.home().join("audit/segments/0000.jsonl").is_file());
    assert!(sandbox.home().join("audit/roots.jsonl").is_file());
    assert!(sandbox.home().join("audit/head").is_file());
    assert!(sandbox.home().join("audit/device.key").is_file());
    let sink = sandbox.home().join("audit-anchor/roots.jsonl");
    assert!(
        sink.is_file(),
        "the local-sink must live outside the audit store"
    );
    assert!(
        fs::read_to_string(&sink).unwrap().contains("merkle_root"),
        "the sink must hold signed roots"
    );

    // --- The analytics ledger is non-empty and honest about cost.
    let analytics_config = AnalyticsConfig::new(sandbox.home().join("analytics"));
    let ledger = AnalyticsLog::open(analytics_config.clone()).unwrap();
    let events = ledger.events().unwrap();
    assert!(
        events.len() >= 4,
        "the run recorded {} events",
        events.len()
    );

    let usage_report = usage(&analytics_config, None).unwrap();
    assert!(usage_report.events > 0);
    let row = usage_report
        .sessions
        .first()
        .expect("the run's session must be rolled up");
    assert_eq!(row.steps, 2, "one provider step per model request");
    assert_eq!(row.tool_calls, 1);
    assert!(row.tokens.observed, "the mock provider reports usage");
    assert!(row.tokens.total() > 0);
    // No pricing snapshot exists, so the cost is unknown and carries no number.
    assert_eq!(row.cost_status.as_str(), "unknown");
    assert_eq!(row.cost_micros_usd, None);
    assert!(usage_report.render().contains("cost: unknown"));
    assert!(usage_report.render().contains("network egress: none"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_class_the_run_exercised_is_covered_and_the_rest_are_named() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("list", json!({})),
        MockTurn::text("Done."),
    ])
    .await;
    let sandbox = Sandbox::new();
    assert!(
        run(&server, sandbox.home(), sandbox.workspace(), "list")
            .await
            .status
            .success()
    );

    // Reading the record is itself a recorded class, so the census is taken
    // after one `audit verify`, exactly as an operator would.
    let verified = verify_with_cli(sandbox.home()).await;
    assert_eq!(
        verified.status.code(),
        Some(0),
        "stderr={}",
        String::from_utf8_lossy(&verified.stderr)
    );

    let audit_config = AuditConfig::new(sandbox.home().join("audit"));
    let census = census(&audit_config, CensusWindow::all()).expect("coverage census");
    let count = |class: EffectClass| {
        census
            .classes
            .iter()
            .find(|row| row.class == class)
            .map_or(0, |row| row.count)
    };
    for class in [
        EffectClass::RunBoundary,
        EffectClass::StepReceipt,
        EffectClass::PolicyDecision,
        EffectClass::ToolCall,
        EffectClass::TicketLifecycle,
        EffectClass::ModelCall,
        EffectClass::Cost,
        EffectClass::RecordAccess,
    ] {
        assert!(
            count(class) >= 1,
            "the run recorded no `{}` entry",
            class.as_str()
        );
    }

    // The classes this run had no reason to exercise are reported as gaps, and
    // the strict census refuses them: coverage is a property of a window chosen
    // to exercise every class, not of any one run.
    let uncovered: Vec<String> = census
        .uncovered
        .iter()
        .map(|class| class.as_str().to_owned())
        .collect();
    for expected in [EffectClass::Approval, EffectClass::FileWrite] {
        assert!(
            uncovered.iter().any(|name| name == expected.as_str()),
            "`{}` was expected to be reported uncovered, got {uncovered:?}",
            expected.as_str()
        );
    }
    let error = census_strict(&audit_config, CensusWindow::all())
        .expect_err("a strict census over a partial window must fail");
    let text = error.to_string();
    assert!(text.contains("census failed"), "{text}");
    assert!(text.contains("approval"), "{text}");

    // The `audit census` surface says the same thing and uses the audit exit
    // code, so a gate can tell a coverage gap from a broken tool.
    let gate = Command::new(env!("CARGO_BIN_EXE_agentx"))
        .args(["audit", "census"])
        .env_remove("AGENTX_BASE_URL")
        .env("AGENTX_HOME", sandbox.home())
        .output()
        .await
        .unwrap();
    assert_eq!(gate.status.code(), Some(6));
    let stderr = String::from_utf8_lossy(&gate.stderr);
    assert!(stderr.contains("coverage census FAILED"), "{stderr}");

    // An exploratory pass reports the gaps without failing, so an operator can
    // inspect a partial run.
    let exploratory = Command::new(env!("CARGO_BIN_EXE_agentx"))
        .args(["audit", "census", "--allow-uncovered"])
        .env_remove("AGENTX_BASE_URL")
        .env("AGENTX_HOME", sandbox.home())
        .output()
        .await
        .unwrap();
    assert_eq!(exploratory.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&exploratory.stdout);
    assert!(stdout.contains("UNCOVERED declared classes"), "{stdout}");
    assert!(stdout.contains("approval"), "{stdout}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_denied_effect_is_audited_and_never_happens() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("write", json!({ "path": "blocked.txt", "content": "nope" })),
        MockTurn::text("Could not write."),
    ])
    .await;
    let sandbox = Sandbox::new();
    // A project-scoped deny rule, so the write is refused by policy.
    fs::create_dir_all(sandbox.workspace().join(".agentx")).unwrap();
    fs::write(
        sandbox.workspace().join(".agentx/config.jsonc"),
        r#"{ "guard": { "rules": [
            { "action": "fs.write", "resource": "**", "effect": "deny" }
        ] } }"#,
    )
    .unwrap();

    let output = run(&server, sandbox.home(), sandbox.workspace(), "write it").await;
    assert!(output.status.success());
    assert!(
        !sandbox.workspace().join("blocked.txt").exists(),
        "a denied effect must not happen"
    );

    // The refusal is first-class evidence, not an omission.
    let audit_config = AuditConfig::new(sandbox.home().join("audit"));
    verify(&audit_config).expect("the chain verifies");
    let census = census(&audit_config, CensusWindow::all()).expect("coverage census");
    let decision = census
        .classes
        .iter()
        .find(|class| class.class == EffectClass::PolicyDecision)
        .expect("a policy decision must be recorded");
    assert!(decision.count >= 1);
    let log = fs::read_to_string(audit_config.root.join("segments/0000.jsonl")).unwrap();
    assert!(
        log.contains(r#""effect":"deny""#),
        "the decision record must carry the deny effect: {log}"
    );
    // Analytics recorded the rejection too.
    let analytics = AnalyticsConfig::new(sandbox.home().join("analytics"));
    let report = usage(&analytics, None).unwrap();
    let session = report.sessions.first().expect("a session rollup");
    assert_eq!(session.tool_calls, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_and_an_approval_are_their_own_audited_classes() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("write", json!({ "path": "hello.txt", "content": "hi" })),
        MockTurn::text("Written."),
    ])
    .await;
    let sandbox = Sandbox::new();

    // Force an approval prompt for the write, so the run exercises the approval
    // path, and answer it on a terminal-free stdin with a rejection first and
    // then the allow, so the record holds the real reply.
    let output = Command::new(env!("CARGO_BIN_EXE_agentx"))
        .args(["-p", "write it", "--yolo"])
        .arg("--cwd")
        .arg(sandbox.workspace())
        .env("AGENTX_BASE_URL", server.base_url())
        .env("AGENTX_API_KEY", "test-key")
        .env("AGENTX_MODEL", "mock-model")
        .env("AGENTX_HOME", sandbox.home())
        .output()
        .await
        .unwrap();
    assert!(output.status.success());

    let audit_config = AuditConfig::new(sandbox.home().join("audit"));
    verify(&audit_config).expect("the chain verifies");
    let census = census(&audit_config, CensusWindow::all()).expect("coverage census");
    let count = |class: EffectClass| {
        census
            .classes
            .iter()
            .find(|row| row.class == class)
            .map_or(0, |row| row.count)
    };
    // A real write is its own effect class, not a detail of the tool call.
    assert!(
        count(EffectClass::FileWrite) >= 1,
        "the file write was not recorded as its own class"
    );
    let log = fs::read_to_string(audit_config.root.join("segments/0000.jsonl")).unwrap();
    assert!(log.contains(r#""kind":"fs_write""#), "{log}");
    assert!(
        log.contains("hello.txt"),
        "the write must name its path: {log}"
    );
    // The path is workspace-relative, not an absolute host path.
    assert!(!log.contains(sandbox.workspace().to_str().unwrap()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_inspection_surfaces_work_without_provider_configuration() {
    let sandbox = Sandbox::new();
    let home = sandbox.home();

    // The inspection surfaces need no provider settings at all, so they work
    // when a run is not possible.
    for args in [
        vec!["audit", "verify", "--all"],
        vec!["analytics", "stats"],
        vec!["analytics", "export"],
        vec!["analytics", "export", "--sanitize"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_agentx"))
            .args(&args)
            .env_remove("AGENTX_BASE_URL")
            .env_remove("AGENTX_API_KEY")
            .env("AGENTX_HOME", home)
            .output()
            .await
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(
            output.status.code(),
            Some(0),
            "`{}` failed: {stderr}",
            args.join(" ")
        );
    }

    // A slash command is an analytics query, not a run.
    for (prompt, expected) in [
        ("/usage", "engineering analytics"),
        ("/insights", "insights over the last 7 day(s)"),
        ("/insights --days 3", "insights over the last 3 day(s)"),
        ("/insights --days=5", "insights over the last 5 day(s)"),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_agentx"))
            .args(["-p", prompt])
            .env_remove("AGENTX_BASE_URL")
            .env_remove("AGENTX_API_KEY")
            .env("AGENTX_HOME", home)
            .output()
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(0), "`{prompt}` failed");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains(expected), "`{prompt}`: {stdout}");
    }

    // An unknown slash command is a configuration error, not a prompt.
    let output = Command::new(env!("CARGO_BIN_EXE_agentx"))
        .args(["-p", "/nope"])
        .env_remove("AGENTX_BASE_URL")
        .env("AGENTX_HOME", home)
        .output()
        .await
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tampered_chain_fails_verify_with_the_audit_exit_code() {
    let server = MockServer::start(vec![MockTurn::text("Done.")]).await;
    let sandbox = Sandbox::new();
    assert!(
        run(&server, sandbox.home(), sandbox.workspace(), "hello")
            .await
            .status
            .success()
    );

    // A negative control: one byte of a committed event changes.
    let segment = sandbox.home().join("audit/segments/0000.jsonl");
    let raw = fs::read_to_string(&segment).unwrap();
    let at = raw
        .find("turn_start")
        .expect("the run recorded a turn boundary");
    let mut tampered = raw.clone();
    tampered.replace_range(at..at + "turn_start".len(), "turn_stark");
    fs::write(&segment, tampered).unwrap();

    let output = verify_with_cli(sandbox.home()).await;
    assert_eq!(
        output.status.code(),
        Some(6),
        "a failed verification must use the audit exit code, not success"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("audit verification FAILED"), "{stderr}");
    assert!(stderr.contains("first divergence"), "{stderr}");
    assert!(
        stderr.contains("seq "),
        "the failing seq must be named: {stderr}"
    );
    // The claim boundary is rendered even on failure, so a reader is never told
    // the tool is broken without also being told what the tool claims.
    assert!(stderr.contains("does NOT detect"), "{stderr}");
    assert!(stderr.contains("off-box"), "{stderr}");
}
