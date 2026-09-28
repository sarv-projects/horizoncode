//! The documented exit-code contract, asserted against `--help`.
//!
//! `ACC-P1-08` requires the code table in `--help` to match the implementation,
//! and requires a test that *fails* when the two disagree. This is that test:
//! it parses the rendered help, not a copy of it.

use std::process::Command;

mod support;

/// Every documented code, with what it means.
const TABLE: &[(u8, &str)] = &[
    (0, "turn completed"),
    (1, "the agent failed to complete the turn"),
    (2, "the turn was declined or denied by policy"),
    (3, "the turn was interrupted"),
    (4, "configuration error"),
    (5, "internal error"),
    (6, "audit verification or the coverage census failed"),
    (
        7,
        "the audit access record could not be written, so nothing was disclosed",
    ),
];

fn help() -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_horizoncode"))
        .arg("--help")
        .output()
        .expect("the binary must run");
    assert!(output.status.success());
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn the_exit_code_table_matches_the_help_text() {
    let help = help();
    for (code, meaning) in TABLE {
        let needle = format!("  {code}  {meaning}");
        assert!(
            help.contains(&needle),
            "`--help` must document exit code {code} as `{meaning}`:\n{help}"
        );
    }
}

#[test]
fn the_help_documents_exactly_the_documented_codes() {
    let help = help();
    let section = help
        .split("Exit codes:")
        .nth(1)
        .expect("`--help` must carry an exit-code section");
    let documented: Vec<u8> = section
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let digits: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u8>().ok()
        })
        .collect();
    let expected: Vec<u8> = TABLE.iter().map(|(code, _)| *code).collect();
    assert_eq!(
        documented, expected,
        "`--help` documents codes the implementation does not define:\n{help}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_audit_gate_uses_its_own_code() {
    // A verification failure must be distinguishable from an internal error, so
    // a release gate can tell "the evidence is bad" from "the tool broke".
    let home = support::TestHome::new();
    // The evidence is written directly: `audit verify` is a read surface, so it
    // no longer creates the chain it inspects, and a test that relied on that
    // side effect was asserting the defect rather than the contract.
    seed_audit_entry(&home.audit());

    let output = home
        .env_offline()
        .args(["audit", "verify", "--all"])
        .output()
        .await
        .expect("the binary must run");
    assert_eq!(output.status.code(), Some(0));

    // A tampered segment is what a real failure looks like.
    let segment = home.audit().join("segments/0000.jsonl");
    let raw = std::fs::read_to_string(&segment).expect("a segment must exist");
    std::fs::write(&segment, raw.replace("\"seq\":0", "\"seq\":9"))
        .expect("the negative control must be writable");

    let output = home
        .env_offline()
        .args(["audit", "verify", "--all"])
        .output()
        .await
        .expect("the binary must run");
    assert_eq!(output.status.code(), Some(6));
}

/// Writes one real audit entry so the read surfaces have something to read.
fn seed_audit_entry(root: &std::path::Path) {
    let log = horizoncode_audit::AuditLog::open(
        horizoncode_audit::AuditConfig::new(root.to_path_buf()),
        &[],
    )
    .expect("the fixture store must open");
    log.append(
        horizoncode_audit::AuditRecord::new("ses_seed", horizoncode_audit::EntryKind::Run)
            .with_actor(horizoncode_audit::Actor::Agent)
            .with_action("turn_start")
            .with_outcome(horizoncode_audit::Outcome::Ok),
    )
    .expect("the fixture entry must be written");
}

#[test]
fn the_subcommand_surface_is_discoverable_in_help() {
    let help = help();
    for expected in ["audit", "analytics", "acp"] {
        assert!(
            help.contains(expected),
            "`--help` must list `{expected}`:\n{help}"
        );
    }
}
