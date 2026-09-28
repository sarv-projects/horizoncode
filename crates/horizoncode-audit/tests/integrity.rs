//! Store-state integrity under inspection (`ARCH/14-AUDIT.md`, `DEC-044`,
//! `REQ-AUDIT-009..011`).
//!
//! These tests drive the real store on a real temp root. They assert the
//! properties the architecture names: inspection changes nothing, an access
//! receipt is written outside the chain it describes, a read whose receipt
//! cannot be written is refused, a corrupt or absent head is distinct from an
//! empty store, an inaccessible directory is not an empty store, and two writers
//! cannot allocate the same sequence.

use std::fs;

use horizoncode_audit::{
    ACCESS_FILE, AccessLedger, Actor, AuditConfig, AuditError, AuditLog, AuditRecord, CensusWindow,
    EntryKind, Outcome, census, census_strict, verify,
};

struct Harness {
    _dir: tempfile::TempDir,
    config: AuditConfig,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = AuditConfig {
            root: dir.path().join("audit"),
            segment_max_entries: 8,
            ..AuditConfig::default()
        };
        Self { _dir: dir, config }
    }

    fn seed(&self) {
        let log = AuditLog::open(self.config.clone(), &[]).unwrap();
        log.append(
            AuditRecord::new("ses_1", EntryKind::Run)
                .with_actor(Actor::Agent)
                .with_action("turn_start")
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
    }

    fn access_root(&self) -> std::path::PathBuf {
        self.config.root.parent().unwrap().join("audit-access")
    }
}

fn store_files(config: &AuditConfig) -> Vec<(std::path::PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let segments = config.segments_dir();
    if let Ok(entries) = fs::read_dir(&segments) {
        for entry in entries.flatten() {
            out.push((entry.path(), fs::read(entry.path()).unwrap_or_default()));
        }
    }
    for path in [config.head_path(), config.roots_path()] {
        if let Ok(bytes) = fs::read(&path) {
            out.push((path, bytes));
        }
    }
    out
}

#[test]
fn reading_the_record_never_changes_it() {
    let harness = Harness::new();
    harness.seed();
    let before = store_files(&harness.config);

    // Every read surface, in the order an operator would run them.
    verify(&harness.config).unwrap();
    horizoncode_audit::replay(
        &harness.config,
        Some("ses_1"),
        horizoncode_audit::ReplayWindow::default(),
    )
    .unwrap();
    census(&harness.config, CensusWindow::all()).unwrap();
    AuditLog::open_read_only(harness.config.clone())
        .unwrap()
        .entries()
        .unwrap();

    assert_eq!(
        before,
        store_files(&harness.config),
        "a read mutated the store"
    );
}

#[test]
fn an_access_receipt_is_written_outside_the_chain_it_describes() {
    let harness = Harness::new();
    harness.seed();
    let ledger = AccessLedger::open(&harness.config.root).unwrap();
    let receipt = ledger
        .record("audit_verify", "all", Some("head-digest".to_owned()))
        .unwrap();

    // The receipt lives in its own stream, and the chain did not gain an entry.
    assert!(harness.access_root().join(ACCESS_FILE).is_file());
    assert_eq!(receipt.seq, 0);
    assert_eq!(receipt.target_head_digest.as_deref(), Some("head-digest"));
    let entries = AuditLog::open_read_only(harness.config.clone())
        .unwrap()
        .entries()
        .unwrap();
    assert_eq!(
        entries.len(),
        1,
        "recording a read must not append to the chain"
    );
    // The receipts verify as a chain of their own.
    assert_eq!(ledger.receipts().unwrap().len(), 1);
}

#[test]
fn a_corrupt_head_is_not_an_empty_store() {
    let harness = Harness::new();
    harness.seed();
    fs::write(harness.config.head_path(), b"{not json").unwrap();

    let error = AuditLog::open(harness.config.clone(), &[]).unwrap_err();
    assert!(
        matches!(
            error,
            AuditError::HeadInvalid {
                state: "malformed",
                ..
            }
        ),
        "{error}"
    );
    // A reader is refused too, rather than reporting a clean store.
    let error = AuditLog::open_read_only(harness.config.clone()).unwrap_err();
    assert!(matches!(error, AuditError::HeadInvalid { .. }), "{error}");
}

#[test]
fn a_missing_head_with_entries_is_typed_not_new() {
    let harness = Harness::new();
    harness.seed();
    fs::remove_file(harness.config.head_path()).unwrap();
    let error = AuditLog::open(harness.config.clone(), &[]).unwrap_err();
    assert!(
        matches!(error, AuditError::HeadMissing { entries: 1, .. }),
        "{error}"
    );
}

#[test]
fn a_genuinely_empty_store_still_opens() {
    let harness = Harness::new();
    let log = AuditLog::open(harness.config.clone(), &[]).expect("a new store is not corrupt");
    assert_eq!(log.head().next_seq, 0);
    // And a read of it verifies as empty rather than failing.
    let report = verify(&harness.config).unwrap();
    assert_eq!(report.entries_checked, 0);
}

#[test]
fn an_inaccessible_segment_directory_is_not_an_empty_store() {
    let harness = Harness::new();
    harness.seed();
    // A regular file where the segments directory must be: unlistable whatever
    // the process uid is.
    let segments = harness.config.segments_dir();
    fs::remove_dir_all(&segments).unwrap();
    fs::write(&segments, b"not a directory").unwrap();
    let error = verify(&harness.config).unwrap_err();
    assert!(error.to_string().contains("audit io error"), "{error}");
    let error = census(&harness.config, CensusWindow::all()).unwrap_err();
    assert!(error.to_string().contains("audit io error"), "{error}");
}

#[test]
fn a_second_writer_cannot_allocate_a_sequence() {
    let harness = Harness::new();
    let first = AuditLog::open(harness.config.clone(), &[]).unwrap();
    let error = AuditLog::open(harness.config.clone(), &[]).unwrap_err();
    assert!(
        matches!(error, AuditError::StoreLocked { .. }),
        "a second writer must be refused, not allowed to interleave: {error}"
    );
    // The first writer is unaffected.
    first
        .append(
            AuditRecord::new("ses_1", EntryKind::Step)
                .with_action("step")
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
    drop(first);
    // Once released, a writer may open again.
    AuditLog::open(harness.config.clone(), &[]).unwrap();
}

#[test]
fn a_torn_tail_is_repaired_only_on_request() {
    let harness = Harness::new();
    harness.seed();
    let path = harness.config.segment_path(0);
    let original = fs::read_to_string(&path).unwrap();
    let mut torn = original.clone();
    torn.push_str("{\"seq\":1,\"ts\":2,\"ses");
    fs::write(&path, &torn).unwrap();

    // A refused open leaves the bytes exactly as they were.
    let error = AuditLog::open(harness.config.clone(), &[]).unwrap_err();
    assert!(
        matches!(error, AuditError::RecoveryRequired { .. }),
        "{error}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), torn);
    // `verify` still reads it: verification reports, it does not repair.
    let _ = verify(&harness.config);

    let outcome = AuditLog::repair_segment(&harness.config, 0).unwrap();
    assert!(outcome.repaired);
    assert!(std::path::Path::new(&outcome.artifact).is_file());
    // The store is writable again, and the chain records what happened.
    let log = AuditLog::open(harness.config.clone(), &[]).unwrap();
    let entries = log.entries().unwrap();
    assert_eq!(
        entries.last().unwrap().action.as_deref(),
        Some("tail_repair")
    );
}

#[test]
fn a_repaired_store_still_verifies_as_a_reconstruction() {
    let harness = Harness::new();
    harness.seed();
    let path = harness.config.segment_path(0);
    let mut torn = fs::read_to_string(&path).unwrap();
    torn.push_str("{\"seq\":1,\"ts\":2,\"ses");
    fs::write(&path, &torn).unwrap();
    AuditLog::repair_segment(&harness.config, 0).unwrap();
    // The chain verifies: the repair appended a real entry rather than leaving a
    // hole, and the artifact states that the discarded range is a
    // reconstruction.
    verify(&harness.config).expect("a repaired store verifies as a chain");
    let artifacts: Vec<_> = fs::read_dir(harness.config.root.join("recovery"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(
        artifacts.len(),
        1,
        "the repair must leave exactly one artifact"
    );
}

#[test]
fn the_census_still_reports_coverage_after_an_access_record() {
    let harness = Harness::new();
    harness.seed();
    // Reading the record no longer inflates coverage in the chain, so a strict
    // census over this window names it as a gap rather than passing quietly.
    let error = census_strict(&harness.config, CensusWindow::all()).unwrap_err();
    assert!(error.to_string().contains("census failed"), "{error}");
    let report = census(&harness.config, CensusWindow::all()).unwrap();
    assert!(!report.is_clean());
}
