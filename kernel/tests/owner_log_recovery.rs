use horizoncode_kernel::owner_log::{
    Digest, DurabilityProfile, MAX_OWNER_BATCH_EVENTS, OwnerEventInput, OwnerHeadV2, OwnerIdentity,
    OwnerLogError, OwnerLogV2,
};
use horizoncode_kernel::protocol::CursorV1;
use rusqlite::Connection;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::num::NonZeroUsize;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_TEMP_ID: AtomicUsize = AtomicUsize::new(0);

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let base = std::env::var_os("HORIZON_OWNER_LOG_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        for _ in 0..32 {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let tick = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = base.join(format!(
                "horizon-owner-log-{}-{tick}-{id}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    #[cfg(unix)]
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
                    return Self(path);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("failed creating test root: {error}"),
            }
        }
        panic!("could not allocate a unique OwnerLog test root")
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn owner(id: &str) -> OwnerIdentity {
    OwnerIdentity::new("thread".to_owned(), id.to_owned()).unwrap()
}

fn command_digest(delivery_id: &str, events: &[OwnerEventInput]) -> String {
    OwnerLogV2::command_digest(delivery_id, events).unwrap()
}

fn event(name: &str) -> OwnerEventInput {
    OwnerEventInput {
        schema_version: 1,
        time_ms: 1_700_000_000_123,
        kind: "thread.created".to_owned(),
        data: serde_json::json!({"name": name}),
        delivery_id: None,
        command_digest: None,
    }
}

fn owner_dir(root: &Path, identity: &OwnerIdentity) -> PathBuf {
    root.join("owners").join(identity.directory_key())
}

fn cursor(identity: &OwnerIdentity, seq: &str, digest: &str) -> CursorV1 {
    CursorV1 {
        owner_kind: identity.kind().to_owned(),
        owner_id: identity.id().to_owned(),
        seq: seq.to_owned(),
        event_digest: format!("blake3:{digest}"),
    }
}

#[test]
fn committed_batch_replays_exactly_and_retry_returns_original_receipt() {
    let root = TempRoot::new();
    let identity = owner("thr_replay");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let events = [event("one"), event("two")];
    let digest = command_digest("delivery-1", &events);

    let receipt = log
        .append_batch("delivery-1", &digest, &events, None)
        .unwrap();
    assert_eq!(receipt.owner_cursor.seq, "2");
    assert_eq!(receipt.event_count, 2);
    assert_eq!(
        receipt.receipt_digest,
        "blake3:c0c300c77151bf76be9b5b5319ceb672eb04157052fedaaf85d0b2df7199590c"
    );
    assert_eq!(
        log.append_batch("delivery-1", &digest, &events, None)
            .unwrap(),
        receipt
    );

    let batch = log.read_after(None, NonZeroUsize::new(8).unwrap()).unwrap();
    assert_eq!(batch.events.len(), 2);
    assert_eq!(batch.cursor, Some(receipt.owner_cursor.clone()));
    assert!(!batch.has_more);

    drop(log);
    let mut log =
        OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly).unwrap();
    let replayed = log.read_after(None, NonZeroUsize::new(8).unwrap()).unwrap();
    assert_eq!(replayed.events, batch.events);
    assert_eq!(replayed.cursor, batch.cursor);
    assert_eq!(
        log.append_batch("delivery-1", &digest, &events, None)
            .unwrap(),
        receipt
    );
}

#[test]
fn command_digest_is_stable_for_canonical_event_batches() {
    let events = [event("one"), event("two")];
    assert_eq!(
        command_digest("delivery-1", &events),
        "blake3:a459011b1b7075f92c08cc033565f7ece3bacdf98819f3708688811a3274b885"
    );
}

#[test]
fn command_digest_rejects_batches_over_the_fixed_event_count_limit() {
    let events = vec![event("bounded"); MAX_OWNER_BATCH_EVENTS + 1];
    assert!(matches!(
        OwnerLogV2::command_digest("delivery-1", &events),
        Err(OwnerLogError::LimitExceeded("command event count"))
    ));
}

#[test]
fn read_after_uses_owner_scoped_cursors_for_pagination() {
    let root = TempRoot::new();
    let identity = owner("thr_pagination");
    let mut log =
        OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly).unwrap();
    let mut expected_receipts = Vec::new();
    for (delivery_id, name) in [("delivery-1", "one"), ("delivery-2", "two")] {
        let events = [event(name)];
        let receipt = log
            .append_batch(
                delivery_id,
                &command_digest(delivery_id, &events),
                &events,
                None,
            )
            .unwrap();
        assert_eq!(
            receipt.owner_cursor.seq,
            if delivery_id == "delivery-1" {
                "1"
            } else {
                "2"
            }
        );
        expected_receipts.push((delivery_id, name, receipt.clone()));
        if delivery_id == "delivery-1" {
            assert_eq!(
                log.append_batch(
                    delivery_id,
                    &command_digest(delivery_id, &events),
                    &events,
                    None,
                )
                .unwrap(),
                receipt
            );
        }
    }
    let dir = owner_dir(root.path(), &owner("thr_pagination"));
    assert!(dir.join("segment-00000000000000000001.jsonl").exists());
    assert!(!dir.join("segment-00000000000000000002.jsonl").exists());

    let first = log.read_after(None, NonZeroUsize::new(1).unwrap()).unwrap();
    assert_eq!(first.events.len(), 1);
    assert!(first.has_more);
    let second = log
        .read_after(first.cursor.as_ref(), NonZeroUsize::new(1).unwrap())
        .unwrap();
    assert_eq!(second.events.len(), 1);
    assert!(!second.has_more);
    assert_eq!(second.events[0].seq, 2);

    let mut invalid = second.cursor.unwrap();
    invalid.event_digest = format!("blake3:{}", "0".repeat(64));
    assert!(matches!(
        log.read_after(Some(&invalid), NonZeroUsize::new(1).unwrap()),
        Err(OwnerLogError::CursorConflict)
    ));

    drop(log);
    let mut recovered = OwnerLogV2::open(
        root.path(),
        owner("thr_pagination"),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    for (delivery_id, name, original_receipt) in expected_receipts {
        let events = [event(name)];
        let receipt = recovered
            .append_batch(
                delivery_id,
                &command_digest(delivery_id, &events),
                &events,
                None,
            )
            .unwrap();
        assert_eq!(receipt, original_receipt);
    }
}

#[test]
fn corrupt_derived_index_rebuilds_without_losing_retries_or_committed_history() {
    let root = TempRoot::new();
    let identity = owner("thr_rebuild_derived_index");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let mut first_command = None;
    let mut last_command = None;

    for index in 0..24 {
        if index > 0 {
            drop(log);
            log = OwnerLogV2::open(
                root.path(),
                identity.clone(),
                DurabilityProfile::InteractiveOnly,
            )
            .unwrap();
        }
        let delivery_id = format!("index-delivery-{index}");
        let events = [event(&format!("index-event-{index}"))];
        let digest = command_digest(&delivery_id, &events);
        let receipt = log
            .append_batch(&delivery_id, &digest, &events, None)
            .unwrap();
        if index == 0 {
            first_command = Some((
                delivery_id.clone(),
                events.clone(),
                digest.clone(),
                receipt.clone(),
            ));
        }
        last_command = Some((delivery_id, events, digest, receipt));

        if index < 23 {
            let segment =
                owner_dir(root.path(), &identity).join(format!("segment-{:020}.jsonl", index + 1));
            let mut tail = OpenOptions::new().append(true).open(segment).unwrap();
            tail.write_all(b"uncommitted-derived-index-test-tail")
                .unwrap();
            tail.sync_all().unwrap();
        }
    }

    let directory = owner_dir(root.path(), &identity);
    let index_path = directory.join("owner-index.sqlite");
    assert!(
        index_path.is_file(),
        "OwnerLog must persist its rebuildable derived index"
    );
    let committed_head = fs::read(directory.join("head.json")).unwrap();
    let first_cursor = first_command.as_ref().unwrap().3.owner_cursor.clone();
    drop(log);

    fs::write(&index_path, b"corrupt derived index").unwrap();
    fs::write(
        directory.join("owner-index.sqlite-journal"),
        b"stale corrupt journal",
    )
    .unwrap();
    #[cfg(unix)]
    fs::set_permissions(
        directory.join("owner-index.sqlite-journal"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let mut recovered =
        OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly).unwrap();
    assert!(
        fs::read(&index_path)
            .unwrap()
            .starts_with(b"SQLite format 3\0")
    );
    assert!(!directory.join("owner-index.sqlite-journal").exists());
    assert_eq!(
        fs::read(directory.join("head.json")).unwrap(),
        committed_head
    );

    let (delivery_id, events, digest, receipt) = first_command.unwrap();
    assert_eq!(
        recovered
            .append_batch(&delivery_id, &digest, &events, None)
            .unwrap(),
        receipt
    );
    let (delivery_id, events, digest, receipt) = last_command.unwrap();
    assert_eq!(
        recovered
            .append_batch(&delivery_id, &digest, &events, None)
            .unwrap(),
        receipt
    );
    let page = recovered
        .read_after(Some(&first_cursor), NonZeroUsize::new(2).unwrap())
        .unwrap();
    assert_eq!(
        page.events
            .iter()
            .map(|record| record.seq)
            .collect::<Vec<_>>(),
        [2, 3]
    );
    assert!(page.has_more);
}

#[test]
fn missing_delivery_index_entry_falls_back_to_canonical_history() {
    let root = TempRoot::new();
    let identity = owner("thr_missing_delivery_index");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let delivery_id = "delivery-index-miss";
    let events = [event("original")];
    let digest = command_digest(delivery_id, &events);
    let receipt = log
        .append_batch(delivery_id, &digest, &events, None)
        .unwrap();
    let head_before = fs::read(owner_dir(root.path(), &identity).join("head.json")).unwrap();

    Connection::open(owner_dir(root.path(), &identity).join("owner-index.sqlite"))
        .unwrap()
        .execute(
            "DELETE FROM deliveries WHERE delivery_id = ?1",
            [delivery_id],
        )
        .unwrap();

    assert_eq!(
        log.append_batch(delivery_id, &digest, &events, None)
            .unwrap(),
        receipt
    );
    assert_eq!(
        fs::read(owner_dir(root.path(), &identity).join("head.json")).unwrap(),
        head_before
    );
    let conflict = [event("different")];
    assert!(matches!(
        log.append_batch(
            delivery_id,
            &command_digest(delivery_id, &conflict),
            &conflict,
            None
        ),
        Err(OwnerLogError::ReplayConflict)
    ));
    assert_eq!(
        fs::read(owner_dir(root.path(), &identity).join("head.json")).unwrap(),
        head_before
    );
}

#[test]
fn missing_segment_index_entry_falls_back_to_canonical_pagination() {
    let root = TempRoot::new();
    let identity = owner("thr_missing_segment_index");
    let log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let mut log = log;
    let commands = [
        ("delivery-index-page-1", event("page-1")),
        ("delivery-index-page-2", event("page-2")),
    ];
    for (delivery_id, event) in &commands {
        let events = [event.clone()];
        log.append_batch(
            delivery_id,
            &command_digest(delivery_id, &events),
            &events,
            None,
        )
        .unwrap();
    }
    let first = log.read_after(None, NonZeroUsize::new(1).unwrap()).unwrap();
    let cursor = first.cursor.unwrap();

    Connection::open(owner_dir(root.path(), &identity).join("owner-index.sqlite"))
        .unwrap()
        .execute("DELETE FROM segments", [])
        .unwrap();

    let next = log
        .read_after(Some(&cursor), NonZeroUsize::new(1).unwrap())
        .unwrap();
    assert_eq!(next.events.len(), 1);
    assert_eq!(next.events[0].seq, 2);
    assert_eq!(next.events[0].data["payload"]["name"], "page-2");
}

#[test]
fn invalid_segment_index_path_falls_back_to_canonical_pagination() {
    let root = TempRoot::new();
    let identity = owner("thr_invalid_segment_index");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let events = [event("canonical")];
    let delivery_id = "delivery-invalid-segment-index";
    log.append_batch(
        delivery_id,
        &command_digest(delivery_id, &events),
        &events,
        None,
    )
    .unwrap();

    Connection::open(owner_dir(root.path(), &identity).join("owner-index.sqlite"))
        .unwrap()
        .execute(
            "UPDATE segments SET segment_id = '00000000000000000099', sealed = 1",
            [],
        )
        .unwrap();

    let batch = log.read_after(None, NonZeroUsize::new(4).unwrap()).unwrap();
    assert_eq!(batch.events.len(), 1);
    assert_eq!(batch.events[0].seq, 1);
    assert_eq!(batch.events[0].data["payload"]["name"], "canonical");
}

#[cfg(unix)]
#[test]
fn owner_index_journal_symlink_is_rejected_without_touching_target() {
    let root = TempRoot::new();
    let identity = owner("thr_index_journal_symlink");
    drop(
        OwnerLogV2::open(
            root.path(),
            identity.clone(),
            DurabilityProfile::InteractiveOnly,
        )
        .unwrap(),
    );
    let directory = owner_dir(root.path(), &identity);
    let target = root.path().join("outside-index-journal-target");
    let journal = directory.join("owner-index.sqlite-journal");
    fs::write(&target, b"target must remain unchanged").unwrap();
    symlink(&target, &journal).unwrap();

    let result = OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly);
    assert!(
        matches!(result, Err(OwnerLogError::UnknownStorageEntry)),
        "unexpected OwnerLog open error: {:?}",
        result.as_ref().err()
    );
    assert_eq!(fs::read(target).unwrap(), b"target must remain unchanged");
}

#[test]
fn append_rejects_a_digest_that_does_not_match_the_command_preimage() {
    let root = TempRoot::new();
    let identity = owner("thr_digest_check");
    let mut log =
        OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly).unwrap();
    assert!(matches!(
        log.append_batch(
            "delivery-1",
            &command_digest("delivery-1", &[event("different")]),
            &[event("one")],
            None,
        ),
        Err(OwnerLogError::CommandDigestMismatch)
    ));
}

#[test]
fn unsupported_owner_schema_is_rejected_before_append() {
    let root = TempRoot::new();
    let identity = owner("thr_schema_gate");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let mut future_event = event("future-schema");
    future_event.schema_version = 2;
    let events = [future_event];

    assert!(matches!(
        log.append_batch(
            "delivery-1",
            &command_digest("delivery-1", &events),
            &events,
            None,
        ),
        Err(OwnerLogError::UnsupportedSchemaVersion(2))
    ));
    assert!(
        !owner_dir(root.path(), &identity)
            .join("segment-00000000000000000001.jsonl")
            .exists()
    );
}

#[test]
fn unsupported_head_schema_is_refused_without_rewriting_it() {
    let root = TempRoot::new();
    let identity = owner("thr_schema_replay");
    let log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    drop(log);

    let directory = owner_dir(root.path(), &identity);
    let head_path = directory.join("head.json");
    let unsupported_head = OwnerHeadV2::new(
        &identity,
        2,
        2,
        DurabilityProfile::InteractiveOnly,
        0,
        Digest::ZERO,
        1,
        0,
    )
    .unwrap();
    let original = OwnerLogV2::encode_head(&unsupported_head).unwrap();
    fs::write(&head_path, &original).unwrap();

    assert!(matches!(
        OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly,),
        Err(OwnerLogError::UnsupportedSchemaVersion(2))
    ));
    assert_eq!(fs::read(head_path).unwrap(), original);
}

#[test]
fn delivery_digest_conflict_and_stale_expected_cursor_are_rejected() {
    let root = TempRoot::new();
    let identity = owner("thr_conflict");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let first_event = [event("one")];
    let first = log
        .append_batch(
            "delivery-1",
            &command_digest("delivery-1", &first_event),
            &first_event,
            None,
        )
        .unwrap();
    assert!(matches!(
        log.append_batch(
            "delivery-1",
            &command_digest("delivery-1", &[event("different")]),
            &[event("different")],
            None,
        ),
        Err(OwnerLogError::ReplayConflict)
    ));
    assert!(matches!(
        log.append_batch(
            "delivery-2",
            &command_digest("delivery-2", &[event("two")]),
            &[event("two")],
            Some(&cursor(&identity, "0", &"0".repeat(64))),
        ),
        Err(OwnerLogError::CursorConflict)
    ));
    assert_eq!(
        log.read_after(None, NonZeroUsize::new(8).unwrap())
            .unwrap()
            .cursor,
        Some(first.owner_cursor)
    );
}

#[test]
fn delivery_ids_are_scoped_to_their_owner_streams() {
    let root = TempRoot::new();
    let first_owner = owner("thr_owner_a");
    let second_owner = owner("thr_owner_b");
    let mut first =
        OwnerLogV2::open(root.path(), first_owner, DurabilityProfile::InteractiveOnly).unwrap();
    let mut second = OwnerLogV2::open(
        root.path(),
        second_owner,
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let first_events = [event("a")];
    let second_events = [event("b")];

    assert_eq!(
        first
            .append_batch(
                "same-delivery",
                &command_digest("same-delivery", &first_events),
                &first_events,
                None,
            )
            .unwrap()
            .owner_cursor
            .seq,
        "1"
    );
    assert_eq!(
        second
            .append_batch(
                "same-delivery",
                &command_digest("same-delivery", &second_events),
                &second_events,
                None,
            )
            .unwrap()
            .owner_cursor
            .seq,
        "1"
    );
}

#[test]
fn owner_lock_is_held_until_log_drop_and_released_on_close() {
    let root = TempRoot::new();
    let identity = owner("thr_lock");
    let first = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    assert!(matches!(
        OwnerLogV2::open(
            root.path(),
            identity.clone(),
            DurabilityProfile::InteractiveOnly,
        ),
        Err(OwnerLogError::OwnerBusy)
    ));
    drop(first);
    assert!(OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly).is_ok());
}

#[cfg(unix)]
#[test]
fn owner_log_rejects_a_non_private_state_root_without_creating_storage() {
    let root = TempRoot::new();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();

    assert!(matches!(
        OwnerLogV2::open(
            root.path(),
            owner("thr_public_root"),
            DurabilityProfile::InteractiveOnly,
        ),
        Err(OwnerLogError::StoragePermissionsUnavailable)
    ));
    assert!(!root.path().join("owners").exists());
}

#[cfg(unix)]
#[test]
fn newly_created_owner_storage_uses_owner_only_permissions() {
    let root = TempRoot::new();
    let identity = owner("thr_private_mode");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let events = [event("private")];
    log.append_batch(
        "delivery-1",
        &command_digest("delivery-1", &events),
        &events,
        None,
    )
    .unwrap();

    let directory = owner_dir(root.path(), &identity);
    for path in [
        root.path().to_path_buf(),
        root.path().join("owners"),
        directory.clone(),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    for name in [
        "owner.lock",
        "head.json",
        "segment-00000000000000000001.jsonl",
        "owner-index.sqlite",
    ] {
        assert_eq!(
            fs::metadata(directory.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn torn_tail_is_preserved_and_the_next_commit_uses_a_new_segment() {
    let root = TempRoot::new();
    let identity = owner("thr_torn");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let first_events = [event("one")];
    let first_receipt = log
        .append_batch(
            "delivery-1",
            &command_digest("delivery-1", &first_events),
            &first_events,
            None,
        )
        .unwrap();
    drop(log);

    let dir = owner_dir(root.path(), &identity);
    let segment_one = dir.join("segment-00000000000000000001.jsonl");
    let committed_bytes = fs::read(&segment_one).unwrap();
    let mut segment = OpenOptions::new().append(true).open(&segment_one).unwrap();
    segment.write_all(b"{\"torn\":").unwrap();
    segment.sync_all().unwrap();
    drop(segment);
    let with_torn_tail = fs::read(&segment_one).unwrap();

    let mut recovered = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    assert_eq!(
        recovered
            .read_after(None, NonZeroUsize::new(8).unwrap())
            .unwrap()
            .events
            .len(),
        1
    );
    let second_receipt = recovered
        .append_batch(
            "delivery-2",
            &command_digest("delivery-2", &[event("two")]),
            &[event("two")],
            None,
        )
        .unwrap();

    assert_eq!(&with_torn_tail[..committed_bytes.len()], committed_bytes);
    assert_eq!(fs::read(&segment_one).unwrap(), with_torn_tail);
    assert!(dir.join("segment-00000000000000000002.jsonl").exists());

    drop(recovered);
    let reopened =
        OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly).unwrap();
    let later = reopened
        .read_after(
            Some(&first_receipt.owner_cursor),
            NonZeroUsize::new(8).unwrap(),
        )
        .unwrap();
    assert_eq!(later.events.len(), 1);
    assert_eq!(later.events[0].seq, 2);
    assert_eq!(later.cursor, Some(second_receipt.owner_cursor));
}

#[test]
fn unknown_head_version_and_corrupt_committed_record_are_refused_without_rewrite() {
    let root = TempRoot::new();
    let identity = owner("thr_corrupt");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let first_events = [event("one")];
    log.append_batch(
        "delivery-1",
        &command_digest("delivery-1", &first_events),
        &first_events,
        None,
    )
    .unwrap();
    drop(log);

    let dir = owner_dir(root.path(), &identity);
    let head = dir.join("head.json");
    let original_head = fs::read(&head).unwrap();
    let unknown = String::from_utf8(original_head.clone())
        .unwrap()
        .replacen("\"format_version\":2", "\"format_version\":99", 1)
        .into_bytes();
    fs::write(&head, &unknown).unwrap();
    assert!(matches!(
        OwnerLogV2::open(
            root.path(),
            identity.clone(),
            DurabilityProfile::InteractiveOnly,
        ),
        Err(OwnerLogError::UnsupportedFormatVersion(99))
    ));
    assert_eq!(fs::read(&head).unwrap(), unknown);
    fs::write(&head, original_head).unwrap();

    let segment = dir.join("segment-00000000000000000001.jsonl");
    let original_segment = fs::read(&segment).unwrap();
    let mut corrupt = original_segment.clone();
    corrupt[0] ^= 1;
    fs::write(&segment, &corrupt).unwrap();
    assert!(OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly).is_err());
    assert_eq!(fs::read(&segment).unwrap(), corrupt);
}

#[test]
fn owner_head_mismatch_is_refused_without_rewriting_the_head() {
    let root = TempRoot::new();
    let identity = owner("thr_head_mismatch");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let events = [event("one")];
    log.append_batch(
        "delivery-1",
        &command_digest("delivery-1", &events),
        &events,
        None,
    )
    .unwrap();
    drop(log);

    let dir = owner_dir(root.path(), &identity);
    let head_path = dir.join("head.json");
    let old_head = fs::read(&head_path).unwrap();
    let segment = fs::read(dir.join("segment-00000000000000000001.jsonl")).unwrap();
    let wrong_owner = owner("thr_someone_else");
    let wrong_head = OwnerHeadV2::new(
        &wrong_owner,
        1,
        2,
        DurabilityProfile::InteractiveOnly,
        1,
        Digest::from_blake3(b"not-the-stream-head"),
        1,
        segment.len() as u64,
    )
    .unwrap();
    fs::write(&head_path, OwnerLogV2::encode_head(&wrong_head).unwrap()).unwrap();
    let mismatched_head = fs::read(&head_path).unwrap();

    assert!(matches!(
        OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly,),
        Err(OwnerLogError::OwnerMismatch)
    ));
    assert_eq!(fs::read(&head_path).unwrap(), mismatched_head);
    assert_ne!(mismatched_head, old_head);
}

#[test]
fn duplicate_raw_json_keys_in_committed_records_are_refused_without_rewrite() {
    let root = TempRoot::new();
    let identity = owner("thr_duplicate_key");
    let mut log = OwnerLogV2::open(
        root.path(),
        identity.clone(),
        DurabilityProfile::InteractiveOnly,
    )
    .unwrap();
    let events = [event("one")];
    log.append_batch(
        "delivery-1",
        &command_digest("delivery-1", &events),
        &events,
        None,
    )
    .unwrap();
    drop(log);

    let segment = owner_dir(root.path(), &identity).join("segment-00000000000000000001.jsonl");
    let original = fs::read(&segment).unwrap();
    let mut duplicate = b"{\"format_version\":2,".to_vec();
    duplicate.extend_from_slice(&original[1..]);
    fs::write(&segment, &duplicate).unwrap();

    assert!(OwnerLogV2::open(root.path(), identity, DurabilityProfile::InteractiveOnly).is_err());
    assert_eq!(fs::read(segment).unwrap(), duplicate);
}

#[cfg(windows)]
#[test]
fn run_durable_is_unavailable_on_the_windows_filesystem_backend() {
    let root = TempRoot::new();
    assert!(matches!(
        OwnerLogV2::open(
            root.path(),
            owner("thr_run_durable"),
            DurabilityProfile::RunDurable,
        ),
        Err(OwnerLogError::DurabilityUnavailable)
    ));
}
