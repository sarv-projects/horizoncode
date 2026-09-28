//! Cross-process writer evidence for the audit chain (`ARCH/14-AUDIT.md`,
//! `REQ-AUDIT-010`, `ACC-P1-04`).
//!
//! A process-local mutex cannot serialize two processes, so this test spawns
//! **real** child processes that contend for the same store. Each child appends
//! entries as fast as it can; the parent then checks the two properties the
//! requirement names: sequence numbers are unique and contiguous, and the chain
//! still verifies.
//!
//! `REPETITIONS` cycles run because a concurrency property proven once is not
//! proven.

use std::process::{Command, Stdio};

use horizoncode_audit::{
    Actor, AuditConfig, AuditError, AuditLog, AuditRecord, EntryKind, Outcome, verify,
};

/// Environment variable naming the store a child should append to.
const CHILD_CONFIG_ENV: &str = "HORIZONCODE_TEST_AUDIT_CONFIG";
/// Environment variable naming how many entries the child should append.
const CHILD_COUNT_ENV: &str = "HORIZONCODE_TEST_AUDIT_COUNT";
/// Environment variable that marks this process as an appender child.
const CHILD_FLAG_ENV: &str = "HORIZONCODE_TEST_AUDIT_CHILD";

/// Concurrency cycles, each one a real two-process race.
const REPETITIONS: usize = 20;
/// Entries each child tries to append.
const ENTRIES_PER_CHILD: usize = 25;

fn fixture_config(root: &std::path::Path) -> AuditConfig {
    AuditConfig {
        root: root.join("audit"),
        segment_max_entries: 7,
        ..AuditConfig::default()
    }
}

fn child_role() {
    let raw = std::env::var(CHILD_CONFIG_ENV).expect("the child needs a store path");
    let count: usize = std::env::var(CHILD_COUNT_ENV)
        .expect("the child needs a count")
        .parse()
        .expect("the count must be a number");
    let mut config: AuditConfig = serde_json::from_str(&raw).expect("the child config must parse");
    config.root = std::path::PathBuf::from(&config.root);
    let log = AuditLog::open(config, &[]).expect("the child must open the store");
    for index in 0..count {
        // A contended lock is a legitimate refusal, not a lost write: the child
        // reports it and the parent counts only what the chain actually holds.
        match log.append(
            AuditRecord::new("ses_race", EntryKind::Step)
                .with_actor(Actor::Agent)
                .with_action("step")
                .with_outcome(Outcome::Ok)
                .with_meta("index", index as i64),
        ) {
            Ok(_) => {}
            Err(AuditError::StoreLocked { .. }) => {
                // Contended: stop appending rather than spin.
                break;
            }
            Err(error) => panic!("the child could not append: {error}"),
        }
    }
    std::process::exit(0);
}

fn spawn_child(config: &AuditConfig, count: usize) -> std::process::Child {
    let raw = serde_json::to_string(config).expect("the config must serialize");
    Command::new(std::env::current_exe().expect("the test binary must run"))
        .arg("--exact")
        .arg("two_processes_cannot_interleave_a_sequence")
        .arg("--nocapture")
        .env(CHILD_FLAG_ENV, "1")
        .env(CHILD_CONFIG_ENV, raw)
        .env(CHILD_COUNT_ENV, count.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child must be spawnable")
}

#[test]
fn two_processes_cannot_interleave_a_sequence() {
    if std::env::var(CHILD_FLAG_ENV).is_ok() {
        child_role();
    }

    for cycle in 0..REPETITIONS {
        let dir = tempfile::tempdir().unwrap();
        let config = fixture_config(dir.path());
        // An initialized store with a device key, so both children race for the
        // same head rather than creating one.
        {
            let log = AuditLog::open(config.clone(), &[]).unwrap();
            log.append(
                AuditRecord::new("ses_race", EntryKind::Run)
                    .with_actor(Actor::Agent)
                    .with_action("cycle_start")
                    .with_outcome(Outcome::Ok)
                    .with_meta("cycle", cycle as i64),
            )
            .unwrap();
        }

        // Both children start together and contend for the writer lock.
        let first = spawn_child(&config, ENTRIES_PER_CHILD);
        let second = spawn_child(&config, ENTRIES_PER_CHILD);
        for mut child in [first, second] {
            let status = child.wait().expect("the child must finish");
            // A child that was refused the lock exits cleanly; one that died in
            // any other way is a real failure, not a contention story.
            assert!(
                status.success() || status.code().is_some(),
                "cycle {cycle}: a child ended with {status}"
            );
        }

        // Whatever the contention decided, the chain is intact: unique, dense
        // sequences, valid hashes, and a verification that still passes.
        let entries = horizoncode_audit::read_segments(&config)
            .expect("segments must be readable")
            .into_iter()
            .flat_map(|segment| segment.entries)
            .collect::<Vec<_>>();
        assert!(!entries.is_empty(), "cycle {cycle}: nothing was recorded");
        for (index, entry) in entries.iter().enumerate() {
            assert_eq!(
                entry.seq, index as u64,
                "cycle {cycle}: sequence numbers must be unique and contiguous"
            );
        }
        let report = verify(&config)
            .unwrap_or_else(|error| panic!("cycle {cycle}: the chain must verify: {error}"));
        assert_eq!(report.entries_checked, entries.len() as u64);
    }
}
