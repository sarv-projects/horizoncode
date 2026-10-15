use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{CursorV1, FrameFence, RpcEventV1};
use horizoncode_kernel::subscription::{
    AckResult, BoundedSubscription, OfferResult, SubscriptionError,
};

const DIGEST: &str = "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn fence() -> FrameFence {
    FrameFence::new(7, "incarnation-test").unwrap()
}

fn cursor(seq: u64, digest: &str) -> CursorV1 {
    CursorV1 {
        owner_kind: "session".into(),
        owner_id: "ses_1".into(),
        seq: seq.to_string(),
        event_digest: digest.into(),
    }
}

fn event(seq: u64, digest: &str) -> RpcEventV1 {
    RpcEventV1 {
        owner_epoch: 7,
        process_incarnation: "incarnation-test".into(),
        subscription_id: "sub_1".into(),
        cursor: cursor(seq, digest),
        event_type: "session.next.prompted.1".into(),
        payload: Value::Map(std::collections::BTreeMap::new()),
    }
}

fn subscription(capacity: usize) -> BoundedSubscription {
    BoundedSubscription::new(
        "sub_1",
        "session",
        "ses_1",
        cursor(0, DIGEST),
        capacity,
        fence(),
    )
    .unwrap()
}

#[test]
fn bounded_window_backpressures_until_acknowledgment_releases_capacity() {
    let mut subscription = subscription(2);
    assert_eq!(
        subscription.offer(event(1, DIGEST)).unwrap(),
        OfferResult::Queued
    );
    assert_eq!(
        subscription.offer(event(2, DIGEST)).unwrap(),
        OfferResult::Queued
    );
    assert_eq!(
        subscription.offer(event(3, DIGEST)).unwrap(),
        OfferResult::Backpressured
    );
    assert_eq!(subscription.buffered(), 2);

    assert_eq!(subscription.next_event().unwrap().cursor.seq, "1");
    assert_eq!(subscription.next_event().unwrap().cursor.seq, "2");
    assert!(subscription.next_event().is_none());
    assert_eq!(
        subscription.offer(event(3, DIGEST)).unwrap(),
        OfferResult::Backpressured
    );
    assert_eq!(
        subscription.ack(&cursor(1, DIGEST)).unwrap(),
        AckResult::Advanced { released: 1 }
    );
    assert_eq!(
        subscription.offer(event(3, DIGEST)).unwrap(),
        OfferResult::Queued
    );
    assert_eq!(subscription.buffered(), 2);
}

#[test]
fn enforces_owner_sequence_and_event_digest_idempotency() {
    let mut subscription = subscription(4);
    assert!(matches!(
        subscription.offer(event(2, DIGEST)),
        Err(SubscriptionError::SequenceGap {
            expected: 1,
            found: 2
        })
    ));
    assert_eq!(
        subscription.offer(event(1, DIGEST)).unwrap(),
        OfferResult::Queued
    );
    assert_eq!(
        subscription.offer(event(1, DIGEST)).unwrap(),
        OfferResult::Duplicate
    );
    assert!(matches!(
        subscription.offer(event(
            1,
            "blake3:1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        )),
        Err(SubscriptionError::CursorConflict)
    ));
    let mut other_owner = event(2, DIGEST);
    other_owner.cursor.owner_id = "ses_other".into();
    assert!(matches!(
        subscription.offer(other_owner),
        Err(SubscriptionError::OwnerMismatch)
    ));
}

#[test]
fn acknowledgments_must_name_sent_events_and_are_idempotent() {
    let mut subscription = subscription(3);
    subscription.offer(event(1, DIGEST)).unwrap();
    subscription.offer(event(2, DIGEST)).unwrap();
    assert!(matches!(
        subscription.ack(&cursor(1, DIGEST)),
        Err(SubscriptionError::AckNotDelivered)
    ));
    subscription.next_event().unwrap();
    subscription.next_event().unwrap();
    assert_eq!(
        subscription.ack(&cursor(2, DIGEST)).unwrap(),
        AckResult::Advanced { released: 2 }
    );
    assert_eq!(
        subscription.ack(&cursor(2, DIGEST)).unwrap(),
        AckResult::Duplicate
    );
    assert!(matches!(
        subscription.ack(&cursor(
            2,
            "blake3:1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        )),
        Err(SubscriptionError::CursorConflict)
    ));
    assert_eq!(subscription.buffered(), 0);
}

#[test]
fn refuses_zero_or_unbounded_windows() {
    assert!(matches!(
        BoundedSubscription::new("sub_1", "session", "ses_1", cursor(0, DIGEST), 0, fence()),
        Err(SubscriptionError::InvalidCapacity)
    ));
    assert!(matches!(
        BoundedSubscription::new("sub_1", "session", "ses_1", cursor(0, DIGEST), 257, fence()),
        Err(SubscriptionError::InvalidCapacity)
    ));
}
