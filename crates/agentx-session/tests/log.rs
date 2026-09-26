//! Session log append/replay/resume/repair tests.

use agentx_session::{
    AssistantMessagePayload, InputPromotedPayload, ModelRef, SessionCreatedPayload, SessionStatus,
    SessionStore, StepStartPayload, ToolCallPayload, TurnStartPayload,
};
use agentx_types::{ContentPart, Event, EventKind, SessionId, ToolCall, ToolCallId, TurnId};
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

#[test]
fn create_append_and_replay_round_trips_history() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    let id = session.id.clone();
    let turn = TurnId::new("turn_1");

    store
        .append(
            &id,
            Event::payload(
                EventKind::TurnStart,
                &TurnStartPayload {
                    turn_id: turn.clone(),
                    prompt: "hello".to_owned(),
                },
            ),
        )
        .unwrap();
    store
        .append(
            &id,
            Event::payload(
                EventKind::InputPromoted,
                &InputPromotedPayload {
                    input_id: "in_1".to_owned(),
                    delivery: "user".to_owned(),
                    text: "hello".to_owned(),
                },
            ),
        )
        .unwrap();
    store
        .append(
            &id,
            Event::payload(
                EventKind::AssistantMessage,
                &AssistantMessagePayload {
                    turn_id: turn.clone(),
                    message_id: None,
                    content: vec![ContentPart::text("hi there")],
                    tool_calls: vec![],
                    interrupted: false,
                },
            ),
        )
        .unwrap();

    let replayed = store.load(&id).unwrap();
    let history = replayed.history();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].text(), "hello");
    assert_eq!(history[1].text(), "hi there");
    assert_eq!(replayed.last_assistant_text().as_deref(), Some("hi there"));
    // Sequence numbers are dense from zero.
    for (index, event) in replayed.events.iter().enumerate() {
        assert_eq!(event.seq, index as u64);
    }
}

#[test]
fn resume_after_reopen_replays_identically() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("sessions");
    let id;
    {
        let store = SessionStore::open(&root).unwrap();
        let session = store.create(header()).unwrap();
        id = session.id.clone();
        store
            .append(
                &id,
                Event::payload(
                    EventKind::InputPromoted,
                    &InputPromotedPayload {
                        input_id: "in_1".to_owned(),
                        delivery: "user".to_owned(),
                        text: "persisted".to_owned(),
                    },
                ),
            )
            .unwrap();
    }
    // A fresh store instance simulates a process restart.
    let store = SessionStore::open(&root).unwrap();
    let replayed = store.load(&id).unwrap();
    assert_eq!(replayed.history().len(), 1);
    assert_eq!(replayed.history()[0].text(), "persisted");
}

#[test]
fn list_and_latest_are_ordered_by_activity() {
    let (_dir, store) = store();
    let first = store.create(header()).unwrap();
    let second = store.create(header()).unwrap();
    // Touch the first session so it becomes the most recent.
    store
        .append(
            &first.id,
            Event::payload(EventKind::SessionUpdated, &json!({ "title": "renamed" })),
        )
        .unwrap();
    let listed = store.list();
    assert_eq!(listed.len(), 2);
    assert_eq!(store.latest().unwrap(), first.id);
    assert!(store.exists(&second.id));
    assert_eq!(store.load(&first.id).unwrap().status, SessionStatus::Active);
}

#[test]
fn close_is_idempotent_and_marks_status() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    let closed = store.close(&session.id).unwrap();
    assert_eq!(closed.status, SessionStatus::Closed);
    let again = store.close(&session.id).unwrap();
    assert_eq!(again.status, SessionStatus::Closed);
    // Exactly one session/closed event.
    let closers = again
        .events
        .iter()
        .filter(|event| event.kind == EventKind::SessionClosed)
        .count();
    assert_eq!(closers, 1);
}

#[test]
fn interrupted_turn_is_repaired_deterministically() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    let id = session.id.clone();
    let turn = TurnId::new("turn_1");
    let call = ToolCall::new(
        ToolCallId::new("call_1"),
        "read",
        json!({ "path": "src/main.rs" }),
    );

    store
        .append(
            &id,
            Event::payload(
                EventKind::TurnStart,
                &TurnStartPayload {
                    turn_id: turn.clone(),
                    prompt: "read a file".to_owned(),
                },
            ),
        )
        .unwrap();
    store
        .append(
            &id,
            Event::payload(
                EventKind::StepStart,
                &StepStartPayload {
                    turn_id: turn.clone(),
                    step: 1,
                },
            ),
        )
        .unwrap();
    store
        .append(
            &id,
            Event::payload(
                EventKind::ToolCall,
                &ToolCallPayload {
                    turn_id: turn.clone(),
                    action: "read".to_owned(),
                    tool_call: call.clone(),
                },
            ),
        )
        .unwrap();

    let repaired = store.load(&id).unwrap();
    let kinds: Vec<_> = repaired
        .events
        .iter()
        .rev()
        .take(3)
        .map(|event| event.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![
            EventKind::TurnEnd,
            EventKind::StepEnd,
            EventKind::ToolResult,
        ]
    );
    let results: Vec<_> = repaired
        .events
        .iter()
        .filter(|event| event.kind == EventKind::ToolResult)
        .collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].data["error_code"], "TOOL_OUTCOME_UNKNOWN");
    assert_eq!(repaired.open_turn(), None);
    assert!(!repaired.has_open_step());
    assert!(repaired.pending_tool_calls().is_empty());
    // Synthetic closers reuse the last real timestamp.
    let last_real = repaired.events[repaired.events.len() - 4].time;
    assert!(
        repaired
            .events
            .iter()
            .rev()
            .take(3)
            .all(|e| e.time == last_real)
    );

    // Repair is idempotent: a second load appends nothing.
    let before = repaired.events.len();
    let again = store.load(&id).unwrap();
    assert_eq!(again.events.len(), before);
}

#[test]
fn torn_final_line_is_discarded() {
    use std::io::Write;
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    let id = session.id.clone();
    let path = store.log_path(&id);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    write!(file, "{{\"seq\":1,\"time\":1,\"type\":\"turn/sta").unwrap();
    drop(file);
    let loaded = store.load(&id).unwrap();
    assert_eq!(loaded.events.len(), 1);
    // Appends continue from the surviving prefix.
    store
        .append(
            &id,
            Event::payload(EventKind::SessionUpdated, &json!({ "title": "after tear" })),
        )
        .unwrap();
    let loaded = store.load(&id).unwrap();
    assert_eq!(loaded.events.len(), 2);
    assert_eq!(loaded.events[1].seq, 1);
}

#[test]
fn unknown_event_type_is_a_typed_failure() {
    let (_dir, store) = store();
    let session = store.create(header()).unwrap();
    let id = session.id.clone();
    let path = store.log_path(&id);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    use std::io::Write;
    writeln!(
        file,
        "{}",
        json!({"seq":1,"time":1,"type":"totally/unknown","data":{}})
    )
    .unwrap();
    drop(file);
    let error = store.load(&id).unwrap_err();
    assert!(matches!(
        error,
        agentx_session::SessionError::Corrupt { .. }
    ));
}

#[test]
fn missing_session_is_not_found() {
    let (_dir, store) = store();
    let error = store.load(&SessionId::new("ses_missing")).unwrap_err();
    assert!(matches!(error, agentx_session::SessionError::NotFound(_)));
}
