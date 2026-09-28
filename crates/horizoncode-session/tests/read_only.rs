//! Byte-preserving reads: inspection never repairs a session log
//! (`ARCH/07-SESSION.md` §Read-only and recovery API boundary, `DEC-056`).

use std::fs;
use std::io::Write;
use std::sync::Arc;

use horizoncode_session::{
    CommitSink, DurabilityProfile, ModelRef, SessionCreatedPayload, SessionIntegrityState,
    SessionStore, TailState,
};
use horizoncode_testkit::{StoreSnapshot, TestClock};
use horizoncode_types::{Event, EventKind};
use serde_json::json;

/// A backend that records the order of the commit steps instead of flushing.
#[derive(Debug, Default)]
struct RecordingSink {
    calls: std::sync::Mutex<Vec<&'static str>>,
    dir_fails: bool,
}

impl CommitSink for RecordingSink {
    fn supports_run_durable(&self) -> bool {
        true
    }

    fn sync_file(&self, _file: &fs::File) -> std::io::Result<()> {
        self.calls.lock().unwrap().push("file");
        Ok(())
    }

    fn sync_dir(&self, _dir: &std::path::Path) -> std::io::Result<()> {
        self.calls.lock().unwrap().push("dir");
        if self.dir_fails {
            return Err(std::io::Error::new(
                std::io::ErrorKind::StorageFull,
                "injected directory sync failure",
            ));
        }
        Ok(())
    }
}

fn store() -> (tempfile::TempDir, SessionStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::open(dir.path().join("sessions")).unwrap();
    (dir, store)
}

fn header() -> SessionCreatedPayload {
    SessionCreatedPayload::new(
        "workspace:test",
        "test session",
        ModelRef {
            id: "test-model".to_owned(),
            provider: "local".to_owned(),
            variant: None,
        },
        "chat",
        json!({ "rules": [] }),
    )
}

fn tear_the_tail(store: &SessionStore, id: &horizoncode_types::SessionId) {
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(store.log_path(id))
        .unwrap();
    write!(file, "{{\"seq\":1,\"time\":1,\"type\":\"turn/sta").unwrap();
}

#[test]
fn read_only_reports_a_torn_tail_without_touching_it() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    store
        .append(
            &session.id,
            Event::payload(EventKind::SessionUpdated, &json!({ "title": "kept" })),
        )
        .unwrap();
    tear_the_tail(&store, &session.id);

    let snapshot = StoreSnapshot::capture(store.root());
    let report = store.read_only(&session.id).unwrap();
    assert_eq!(report.integrity, SessionIntegrityState::RecoveryPending);
    assert!(matches!(report.tail, TailState::Torn { bytes } if bytes > 0));
    // Only the committed prefix is reported; the partial row is not invented
    // into an event.
    assert_eq!(report.events.len(), 2);
    // Byte-preserving: no truncation, no repair append.
    snapshot.assert_unchanged();
}

#[test]
fn scan_matches_load_for_a_clean_log() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    store
        .append(
            &session.id,
            Event::payload(
                EventKind::InputPromoted,
                &json!({ "input_id": "in_1", "delivery": "user", "text": "hello" }),
            ),
        )
        .unwrap();

    let scan = store.scan(&session.id).unwrap();
    assert_eq!(scan.integrity, SessionIntegrityState::Available);
    assert_eq!(scan.tail, TailState::Clean);
    assert_eq!(scan.events, store.load(&session.id).unwrap().events);
}

#[test]
fn the_repairing_load_path_still_closes_an_interrupted_turn() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    let turn = horizoncode_types::TurnId::new("turn_1");
    store
        .append(
            &session.id,
            Event::payload(
                EventKind::TurnStart,
                &json!({ "turn_id": turn.as_str(), "prompt": "work" }),
            ),
        )
        .unwrap();

    // The repairing path is explicit and still deterministic; the read-only
    // path above is what a status surface uses.
    let loaded = store.load(&session.id).unwrap();
    assert_eq!(
        loaded.last_turn_status(),
        Some(horizoncode_session::TurnEndStatus::Interrupted)
    );
    let before = loaded.events.len();
    let again = store.load(&session.id).unwrap();
    assert_eq!(again.events.len(), before, "repair is idempotent");
}

#[test]
fn run_durable_orders_the_file_sync_before_the_directory_sync() {
    let dir = tempfile::tempdir().unwrap();
    let sink = Arc::new(RecordingSink::default());
    let store = SessionStore::open(dir.path().join("sessions"))
        .unwrap()
        .with_sink(sink.clone())
        .with_durability(DurabilityProfile::RunDurable)
        .unwrap();
    store.create(header()).unwrap();
    let calls = sink.calls.lock().unwrap().clone();
    assert_eq!(calls.first(), Some(&"file"), "the file is flushed first");
    assert_eq!(
        calls.last(),
        Some(&"dir"),
        "the directory is synced before the ack"
    );
    assert!(calls.iter().filter(|call| **call == "file").count() >= 1);
}

#[test]
fn a_directory_sync_failure_is_never_reported_as_success() {
    let dir = tempfile::tempdir().unwrap();
    let sink = Arc::new(RecordingSink {
        dir_fails: true,
        ..RecordingSink::default()
    });
    let store = SessionStore::open(dir.path().join("sessions"))
        .unwrap()
        .with_sink(sink)
        .with_durability(DurabilityProfile::RunDurable)
        .unwrap();
    let error = store.create(header()).unwrap_err();
    assert!(
        matches!(error, horizoncode_session::SessionError::Io { .. }),
        "{error}"
    );
    // The caller was not told the session exists, so nothing can resume a
    // phantom. The bytes that were written are still readable rather than
    // half-written, which is what makes a retry safe.
    let listed = store.list();
    let row = &listed.items[0];
    assert_eq!(row.integrity, SessionIntegrityState::Available);
    assert_eq!(row.summary.as_ref().unwrap().event_count, 1);
}

#[test]
fn run_durable_refuses_a_backend_that_cannot_sync_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("sessions");
    let error = SessionStore::open(&root)
        .unwrap()
        .with_sink(Arc::new(horizoncode_session::UnsupportedSink))
        .with_durability(DurabilityProfile::RunDurable)
        .unwrap_err();
    assert!(
        matches!(error, horizoncode_session::SessionError::Durability(_)),
        "{error}"
    );
    // The refusal is typed; the caller must ask for interactive explicitly.
    let interactive = SessionStore::open(&root)
        .unwrap()
        .with_sink(Arc::new(horizoncode_session::UnsupportedSink))
        .with_durability(DurabilityProfile::Interactive)
        .unwrap();
    assert_eq!(interactive.durability(), DurabilityProfile::Interactive);
}

#[test]
fn run_durable_refuses_a_disabled_per_append_sync() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::open(dir.path().join("sessions"))
        .unwrap()
        .with_fsync(false);
    let error = store
        .with_durability(DurabilityProfile::RunDurable)
        .unwrap_err();
    assert!(error.to_string().contains("per-append sync"), "{error}");
}

#[test]
fn the_injected_clock_is_the_only_source_of_record_time() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(TestClock::new(1_700_000_000_000));
    let store = SessionStore::open(dir.path().join("sessions"))
        .unwrap()
        .with_clock(clock.clone());
    let session = store.create(header()).unwrap();
    assert_eq!(session.events[0].time, 1_700_000_000_000);
    clock.advance(5_000);
    let appended = store
        .append(
            &session.id,
            Event::payload(EventKind::SessionUpdated, &json!({ "title": "later" })),
        )
        .unwrap();
    assert_eq!(appended.time, 1_700_000_005_000);
}
