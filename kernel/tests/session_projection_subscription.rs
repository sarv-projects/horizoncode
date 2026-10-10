use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::session_projection::{SessionProjection, SubscriptionPageError};
use horizoncode_kernel::subscription::{BoundedSubscription, OfferResult};
use rusqlite::{Connection, params};

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

fn append(db: &Connection, seq: i64, typ: &str, data: &str) {
    db.execute(
        "INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?1,'ses_stream',?2,?3,?4)",
        params![format!("evt_stream_{seq}"), seq, typ, data],
    )
    .unwrap();
}

#[test]
fn projected_session_page_feeds_bounded_delivery_without_prompt_content() {
    let source = source();
    let mut projection = SessionProjection::open(Connection::open_in_memory().unwrap()).unwrap();
    projection.sync(&source, "ses_stream", 8).unwrap();
    let snapshot = projection.subscription_cursor("ses_stream").unwrap();
    assert_eq!(snapshot.seq, "0");

    append(
        &source,
        0,
        "session.next.prompt.admitted.1",
        r#"{"messageID":"msg_input","prompt":[{"text":"private prompt"}]}"#,
    );
    append(
        &source,
        1,
        "session.next.prompted.1",
        r#"{"messageID":"msg_input","prompt":[{"text":"private prompt"}]}"#,
    );
    projection.sync(&source, "ses_stream", 8).unwrap();
    let page = projection.subscription_page("sub_1", &snapshot, 1).unwrap();
    assert!(page.has_more);
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0].cursor.seq, "1");
    assert_eq!(page.events[0].event_type, "session.next.prompt.admitted.1");
    let continuation = projection
        .subscription_page("sub_1", &page.events[0].cursor, 1)
        .unwrap();
    assert!(!continuation.has_more);
    assert_eq!(continuation.events[0].cursor.seq, "2");

    let mut window =
        BoundedSubscription::new("sub_1", "session", "ses_stream", snapshot, 1).unwrap();
    let first = page.events.into_iter().next().unwrap();
    let second = continuation.events.into_iter().next().unwrap();
    let first_cursor = first.cursor.clone();
    assert_eq!(window.offer(first).unwrap(), OfferResult::Queued);
    assert_eq!(
        window.offer(second.clone()).unwrap(),
        OfferResult::Backpressured
    );
    assert_eq!(window.next_event().unwrap().cursor.seq, "1");
    window.ack(&first_cursor).unwrap();
    assert_eq!(window.offer(second).unwrap(), OfferResult::Queued);
    let delivered = window.next_event().unwrap();
    assert!(!format!("{:?}", delivered.payload).contains("private prompt"));
    assert_eq!(
        string_field(&delivered.payload, "messageID"),
        Some("msg_input")
    );
    assert_eq!(
        string_field(&delivered.payload, "eventID"),
        Some("evt_stream_1")
    );
}

#[test]
fn rejects_unknown_or_drifted_projection_cursors() {
    let source = source();
    append(
        &source,
        0,
        "session.next.prompt.admitted.1",
        r#"{"messageID":"msg_a"}"#,
    );
    let mut projection = SessionProjection::open(Connection::open_in_memory().unwrap()).unwrap();
    projection.sync(&source, "ses_stream", 8).unwrap();
    let mut cursor = projection.subscription_cursor("ses_stream").unwrap();
    cursor.event_digest =
        "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into();
    assert!(matches!(
        projection.subscription_page("sub_1", &cursor, 8),
        Err(SubscriptionPageError::CursorConflict)
    ));
}

fn string_field<'a>(payload: &'a Value, field: &str) -> Option<&'a str> {
    let Value::Map(map) = payload else {
        return None;
    };
    let Value::String(value) = map.get(field)? else {
        return None;
    };
    Some(value)
}
