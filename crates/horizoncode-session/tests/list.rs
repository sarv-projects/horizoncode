//! Typed enumeration: a store failure is never reported as "no sessions"
//! (`ARCH/07-SESSION.md`, `REQ-SESS-006`, `DEC-056`).

use std::fs;
use std::io::Write;

use horizoncode_session::{
    ModelRef, SessionCreatedPayload, SessionIntegrityState, SessionListIssueKind, SessionStore,
};
use horizoncode_testkit::StoreSnapshot;
use horizoncode_types::{Event, EventKind, SessionId};
use serde_json::json;

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

/// Appends a partial final row, exactly as an interrupted write leaves it.
fn tear_the_tail(store: &SessionStore, id: &SessionId) {
    let path = store.log_path(id);
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    write!(file, "{{\"seq\":1,\"time\":1,\"type\":\"turn/sta").unwrap();
}

#[test]
fn a_directory_that_cannot_be_read_is_an_incomplete_scan() {
    let (dir, store) = store();
    store.create(header()).unwrap();
    // The root is gone: the scan failed, which is not the same as an empty store.
    fs::remove_dir_all(store.root()).unwrap();
    let listed = store.list();
    assert!(!listed.enumeration_complete);
    assert!(listed.items.is_empty());
    assert_eq!(listed.issues.len(), 1);
    assert_eq!(
        listed.issues[0].kind,
        SessionListIssueKind::DirectoryUnreadable
    );
    assert!(!listed.issues[0].message.is_empty());
    // The most recent session is not resumable while the store is unreadable.
    assert_eq!(store.latest(), None);
    drop(dir);
}

#[test]
fn an_unreadable_log_stays_visible_as_a_row() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    let path = store.log_path(&session.id);
    // A directory where a log file should be: unreadable regardless of uid.
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();

    let listed = store.list();
    assert!(
        listed.enumeration_complete,
        "one bad file is not a failed scan"
    );
    assert_eq!(listed.items.len(), 1);
    let row = &listed.items[0];
    assert_eq!(row.id, session.id);
    assert_eq!(row.integrity, SessionIntegrityState::Unreadable);
    assert!(row.summary.is_none());
    let issue = row.issue.as_ref().expect("a typed issue");
    assert_eq!(issue.kind, SessionListIssueKind::EntryUnreadable);
    assert_eq!(issue.session_id, Some(session.id.clone()));
    assert_eq!(issue.path, path);
    // A caller that already knows the log exists gets the row, not an error.
    assert_eq!(
        store.inspect(&session.id).unwrap().integrity,
        SessionIntegrityState::Unreadable
    );
}

#[test]
fn a_corrupt_header_is_reported_with_its_line() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    fs::write(store.log_path(&session.id), b"not json at all\n").unwrap();

    let listed = store.list();
    let row = &listed.items[0];
    assert_eq!(row.integrity, SessionIntegrityState::Corrupt);
    let issue = row.issue.as_ref().unwrap();
    assert_eq!(issue.kind, SessionListIssueKind::HeaderCorrupt);
    assert_eq!(issue.line, Some(1));
    // A log that is not readable is never silently resumed.
    assert_eq!(store.latest(), None);
}

#[test]
fn a_newer_format_version_is_a_visible_unsupported_row() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    let path = store.log_path(&session.id);
    let mut raw = fs::read_to_string(&path).unwrap();
    let row: serde_json::Value = serde_json::from_str(raw.trim_end()).unwrap();
    let newer = horizoncode_session::CURRENT_FORMAT_VERSION + 1;
    raw = raw.replace(
        &row["data"]["format_version"].to_string(),
        &newer.to_string(),
    );
    fs::write(&path, raw).unwrap();

    let listed = store.list();
    let row = &listed.items[0];
    assert_eq!(row.integrity, SessionIntegrityState::Unsupported);
    assert_eq!(
        row.issue.as_ref().unwrap().kind,
        SessionListIssueKind::LogUnsupported
    );
    assert_eq!(store.latest(), None);
}

#[test]
fn a_torn_tail_is_recovery_pending_with_its_bytes() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    store
        .append(
            &session.id,
            Event::payload(EventKind::SessionUpdated, &json!({ "title": "renamed" })),
        )
        .unwrap();
    tear_the_tail(&store, &session.id);

    let listed = store.list();
    let row = &listed.items[0];
    assert_eq!(row.integrity, SessionIntegrityState::RecoveryPending);
    // The projection is still usable: the committed prefix is intact.
    assert_eq!(row.summary.as_ref().unwrap().event_count, 2);
    let issue = row.issue.as_ref().unwrap();
    assert_eq!(issue.kind, SessionListIssueKind::TailTorn);
    assert!(issue.bytes_affected.is_some_and(|bytes| bytes > 0));
    assert!(listed.enumeration_complete);
}

#[test]
fn enumeration_changes_nothing_and_never_repairs() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    store
        .append(
            &session.id,
            Event::payload(
                EventKind::TurnStart,
                &json!({ "turn_id": "turn_1", "prompt": "hi" }),
            ),
        )
        .unwrap();
    tear_the_tail(&store, &session.id);

    let snapshot = StoreSnapshot::capture(store.root());
    let listed = store.list();
    assert_eq!(listed.items.len(), 1);
    assert_eq!(store.latest(), None);
    let _ = store.inspect(&session.id).unwrap();
    // Byte-for-byte: no truncation, no synthetic append, no new file.
    snapshot.assert_unchanged();
}

#[test]
fn latest_prefers_the_newest_readable_session() {
    let (_dir, store) = store();
    let healthy = store.create(header()).unwrap();
    let broken = store.create(header()).unwrap();
    // Make the newer session unreadable.
    let path = store.log_path(&broken.id);
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    store
        .append(
            &healthy.id,
            Event::payload(EventKind::SessionUpdated, &json!({ "title": "touched" })),
        )
        .unwrap();

    let listed = store.list();
    // Unreadable rows sort after every projected row, in a stable order.
    assert_eq!(listed.items.len(), 2);
    assert_eq!(listed.items[0].id, healthy.id);
    assert_eq!(listed.items[1].id, broken.id);
    assert_eq!(store.latest().unwrap(), healthy.id);
}

#[test]
fn inspect_reports_absence_rather_than_inventing_a_row() {
    let (_dir, store) = store();
    let error = store.inspect(&SessionId::new("ses_missing")).unwrap_err();
    assert!(matches!(
        error,
        horizoncode_session::SessionError::NotFound(_)
    ));
}
