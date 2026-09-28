//! Owner-only state and no-follow paths for the session store (`ARCH/22`
//! `F-02`/`L-07`, `TODO.md` `AX-126`).

use horizoncode_session::{ModelRef, SessionCreatedPayload, SessionError, SessionStore};
use horizoncode_types::{Event, EventKind};
use serde_json::json;

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
        json!({}),
    )
}

#[cfg(unix)]
#[test]
fn a_created_session_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let sessions = dir.path().join("sessions");
    let store = SessionStore::open(&sessions).unwrap();
    let loaded = store.create(header()).unwrap();
    let log = sessions.join(format!("{}.jsonl", loaded.id));
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&sessions), 0o700, "the sessions root is owner-only");
    assert_eq!(mode(&log), 0o600, "the session log is owner-only");
}

#[cfg(unix)]
#[test]
fn a_symlinked_session_log_is_refused_on_read_and_append() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = dir.path().join("sessions");
    let store = SessionStore::open(&sessions).unwrap();
    let loaded = store.create(header()).unwrap();
    let log = sessions.join(format!("{}.jsonl", loaded.id));
    let elsewhere = dir.path().join("elsewhere.jsonl");
    std::fs::rename(&log, &elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &log).unwrap();

    let error = store
        .append(
            &loaded.id,
            Event::payload(EventKind::ModelAttempt, &json!({"step": 1})),
        )
        .expect_err("append must not follow the link");
    assert!(matches!(error, SessionError::Io { .. }), "{error}");
    assert!(error.to_string().contains("symlink"), "{error}");

    let error = store
        .read_only(&loaded.id)
        .expect_err("the read path must not follow the link");
    assert!(matches!(error, SessionError::Io { .. }), "{error}");
}
