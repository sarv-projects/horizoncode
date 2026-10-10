use horizoncode_kernel::session_projection::{ProjectionError, SessionProjection};
use rusqlite::{Connection, params};
use std::time::{SystemTime, UNIX_EPOCH};

fn source() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE event (
             id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
             type TEXT NOT NULL, data TEXT NOT NULL,
             UNIQUE(aggregate_id,seq)
        );",
    )
    .unwrap();
    db
}

fn append(db: &Connection, session: &str, seq: i64, typ: &str, payload: &str) {
    db.execute(
        "INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?1,?2,?3,?4,?5)",
        params![format!("evt_{session}_{seq}"), session, seq, typ, payload],
    )
    .unwrap();
}

fn projector() -> SessionProjection {
    SessionProjection::open(Connection::open_in_memory().unwrap()).unwrap()
}

#[test]
fn admitted_and_promoted_are_distinct_and_replay_is_idempotent() {
    let s = source();
    append(
        &s,
        "ses_one",
        0,
        "session.next.prompt.admitted",
        r#"{"sessionID":"ses_one","messageID":"msg_1","prompt":[{"type":"text","text":"PRIVATE TASK"}]}"#,
    );
    append(
        &s,
        "ses_one",
        1,
        "session.next.prompted",
        r#"{"sessionID":"ses_one","messageID":"msg_1","prompt":[{"type":"text","text":"PRIVATE TASK"}]}"#,
    );
    let mut p = projector();
    let first = p.sync(&s, "ses_one", 1).unwrap();
    assert_eq!((first.imported, first.cursor.last_seq), (1, 0));
    let second = p.sync(&s, "ses_one", 4).unwrap();
    assert_eq!((second.imported, second.cursor.last_seq), (1, 1));
    assert_eq!(p.sync(&s, "ses_one", 4).unwrap().imported, 0);
    assert_eq!(p.event_count("ses_one").unwrap(), 2);
    assert_eq!(
        p.correlation("ses_one", 0).unwrap().unwrap().1.as_deref(),
        Some("msg_1")
    );
    assert_eq!(
        p.correlation("ses_one", 1).unwrap().unwrap().0,
        "session.next.prompted"
    );
}

#[test]
fn failure_on_gap_does_not_commit_partial_batch() {
    let s = source();
    append(
        &s,
        "ses_gap",
        0,
        "session.next.prompt.admitted",
        r#"{"messageID":"msg_a"}"#,
    );
    append(
        &s,
        "ses_gap",
        2,
        "session.next.prompted",
        r#"{"messageID":"msg_a"}"#,
    );
    let mut p = projector();
    assert!(matches!(
        p.sync(&s, "ses_gap", 9),
        Err(ProjectionError::SourceGap {
            expected: 1,
            found: 2,
            ..
        })
    ));
    assert_eq!(p.cursor("ses_gap").unwrap().last_seq, -1);
    append(
        &s,
        "ses_gap",
        1,
        "session.next.context.updated",
        r#"{"messageID":"msg_a"}"#,
    );
    assert_eq!(p.sync(&s, "ses_gap", 9).unwrap().cursor.last_seq, 2);
}

#[test]
fn changed_or_deleted_history_is_never_accepted_as_continuation() {
    let s = source();
    append(
        &s,
        "ses_drift",
        0,
        "session.next.prompt.admitted",
        r#"{"messageID":"msg_x"}"#,
    );
    let mut p = projector();
    p.sync(&s, "ses_drift", 5).unwrap();
    s.execute(
        "UPDATE event SET data=?1 WHERE aggregate_id=?2",
        params![r#"{"messageID":"msg_hijacked"}"#, "ses_drift"],
    )
    .unwrap();
    append(
        &s,
        "ses_drift",
        1,
        "session.next.prompted",
        r#"{"messageID":"msg_x"}"#,
    );
    assert!(matches!(
        p.sync(&s, "ses_drift", 5),
        Err(ProjectionError::SourceDrift { .. })
    ));
    assert_eq!(p.cursor("ses_drift").unwrap().last_seq, 0);
}

#[test]
fn invalid_payload_or_correlation_is_rejected_atomically() {
    let s = source();
    append(
        &s,
        "ses_bad",
        0,
        "session.next.prompt.admitted",
        r#"{"messageID":"msg_valid"}"#,
    );
    append(
        &s,
        "ses_bad",
        1,
        "session.next.prompted",
        r#"{"messageID":42}"#,
    );
    let mut p = projector();
    assert!(matches!(
        p.sync(&s, "ses_bad", 3),
        Err(ProjectionError::Invalid(_))
    ));
    assert_eq!(p.cursor("ses_bad").unwrap().last_seq, -1);
}

#[test]
fn work_sessions_have_independent_cursors() {
    let s = source();
    append(
        &s,
        "ses_a",
        0,
        "session.next.prompt.admitted",
        r#"{"messageID":"msg_a"}"#,
    );
    append(
        &s,
        "ses_b",
        0,
        "session.next.step.started",
        r#"{"assistantMessageID":"msg_b"}"#,
    );
    let mut p = projector();
    p.sync(&s, "ses_a", 4).unwrap();
    assert_eq!(p.cursor("ses_a").unwrap().count, 1);
    assert_eq!(p.cursor("ses_b").unwrap().count, 0);
    p.sync(&s, "ses_b", 4).unwrap();
    assert_eq!(
        p.correlation("ses_b", 0).unwrap().unwrap().1.as_deref(),
        Some("msg_b")
    );
}

#[test]
fn attempt_link_rejects_reassignment_without_mutating_first_link() {
    let mut p = projector();
    p.link_attempt("at_1", "run_1", "ses_a").unwrap();
    p.link_attempt("at_1", "run_1", "ses_a").unwrap();
    assert!(matches!(
        p.link_attempt("at_1", "run_other", "ses_a"),
        Err(ProjectionError::LinkConflict)
    ));
    assert!(matches!(
        p.link_attempt("at_1", "run_1", "ses_other"),
        Err(ProjectionError::LinkConflict)
    ));
}

#[test]
fn state_survives_process_reopen_and_replay_stays_idempotent() {
    let s = source();
    append(
        &s,
        "ses_restart",
        0,
        "session.next.prompt.admitted",
        r#"{"messageID":"msg_x"}"#,
    );
    append(
        &s,
        "ses_restart",
        1,
        "session.next.prompted",
        r#"{"messageID":"msg_x"}"#,
    );
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "hc-session-projection-{}-{suffix}.db",
        std::process::id()
    ));
    {
        let mut p = SessionProjection::open(Connection::open(&path).unwrap()).unwrap();
        assert_eq!(p.sync(&s, "ses_restart", 4).unwrap().imported, 2);
    }
    {
        let mut p = SessionProjection::open(Connection::open(&path).unwrap()).unwrap();
        assert_eq!(p.cursor("ses_restart").unwrap().last_seq, 1);
        assert_eq!(p.sync(&s, "ses_restart", 4).unwrap().imported, 0);
        append(
            &s,
            "ses_restart",
            2,
            "session.next.step.ended",
            r#"{"assistantMessageID":"msg_answer"}"#,
        );
        assert_eq!(p.sync(&s, "ses_restart", 4).unwrap().cursor.last_seq, 2);
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn missing_source_table_reports_error_and_retains_cursor() {
    let bad_source = Connection::open_in_memory().unwrap();
    let mut p = projector();
    assert!(matches!(
        p.sync(&bad_source, "ses_a", 10),
        Err(ProjectionError::Sql(_))
    ));
    assert_eq!(p.cursor("ses_a").unwrap().last_seq, -1);
}

#[test]
fn rejects_bad_batch_size_and_session_ids() {
    let s = source();
    let mut p = projector();
    assert!(matches!(
        p.sync(&s, "ses_a", 0),
        Err(ProjectionError::Invalid(_))
    ));
    assert!(matches!(
        p.sync(&s, "ses_a", 4097),
        Err(ProjectionError::Invalid(_))
    ));
    assert!(matches!(
        p.sync(&s, "../bad", 1),
        Err(ProjectionError::Invalid(_))
    ));
}
