//! The segmented log's contract: bounded append, rotation and seals, an
//! explicit commit point, restart resume, streaming replay, and typed refusals.

use std::fs;
use std::path::Path;

use horizoncode_config::LogLimits;
use horizoncode_eventlog::{
    DurabilityProfile, EventLog, EventRecord, HeadState, LogError, RecordSpec, read_head,
};
use serde_json::json;

fn limits() -> LogLimits {
    LogLimits {
        max_event_bytes: 4096,
        max_segment_bytes: 8 * 1024 * 1024,
        max_segment_events: 4,
        max_stream_event_bytes: 1024 * 1024,
        control_reserve_bytes: 1024,
        replay_batch_events: 8,
    }
}

fn spec(kind: &str, marker: u64) -> RecordSpec {
    RecordSpec::new(
        1_700_000_000_000 + marker as i64,
        kind,
        json!({"marker": marker, "text": format!("event {marker}")}),
    )
}

fn open(root: &Path, limits: LogLimits) -> EventLog {
    EventLog::open(
        root,
        "session",
        "ses_1",
        limits,
        DurabilityProfile::Interactive,
    )
    .unwrap()
}

fn collect(log: &EventLog) -> Vec<EventRecord> {
    let mut events = Vec::new();
    log.replay(|record| {
        events.push(record.clone());
        Ok(())
    })
    .unwrap();
    events
}

#[test]
fn a_round_trip_replays_every_event_in_order_and_linked() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = open(dir.path(), limits());
    for marker in 0..3 {
        let committed = log.append(spec("tool.settled", marker)).unwrap();
        assert_eq!(committed.seq, marker);
    }

    let events = collect(&log);
    assert_eq!(events.len(), 3);
    for (marker, record) in events.iter().enumerate() {
        assert_eq!(record.seq, marker as u64);
        assert_eq!(record.data["marker"], json!(marker as u64));
    }
    let report = log.replay(|_| Ok(())).unwrap();
    assert_eq!(report.events, 3);
    assert_eq!(report.segments, 1);
    assert_eq!(report.uncommitted_tail_bytes, 0);
    assert_eq!(log.next_seq(), 3);
}

#[test]
fn segments_rotate_at_the_event_ceiling_and_replay_spans_them() {
    let dir = tempfile::tempdir().unwrap();
    let mut limits = limits();
    limits.max_segment_events = 4;
    let mut log = open(dir.path(), limits);
    for marker in 0..9 {
        log.append(spec("step.settled", marker)).unwrap();
    }

    assert!(dir.path().join("segments/00000000.seal.json").is_file());
    assert!(dir.path().join("segments/00000001.seal.json").is_file());
    assert!(
        !dir.path().join("segments/00000002.seal.json").exists(),
        "the active segment is never sealed"
    );
    let events = collect(&log);
    assert_eq!(events.len(), 9);
    assert_eq!(events[8].seq, 8);
    assert_eq!(log.replay(|_| Ok(())).unwrap().segments, 3);
}

#[test]
fn segments_rotate_at_the_byte_ceiling() {
    let dir = tempfile::tempdir().unwrap();
    let mut limits = limits();
    limits.max_segment_bytes = 400;
    limits.max_segment_events = 1000;
    let mut log = open(dir.path(), limits);
    for marker in 0..10 {
        log.append(spec("step.settled", marker)).unwrap();
    }
    let sealed = fs::read_dir(dir.path().join("segments"))
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".seal.json"))
        .count();
    assert!(sealed >= 2, "byte pressure must rotate segments: {sealed}");
    assert_eq!(collect(&log).len(), 10);
}

#[test]
fn an_oversized_event_is_refused_before_anything_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let mut limits = limits();
    limits.max_event_bytes = 80;
    let mut log = open(dir.path(), limits);
    let error = log
        .append(RecordSpec::new(
            1,
            "tool.settled",
            json!({"text": "x".repeat(200)}),
        ))
        .unwrap_err();
    assert!(matches!(error, LogError::EventTooLarge { .. }), "{error}");
    assert_eq!(log.next_seq(), 0);
    assert_eq!(
        read_head(&dir.path().join("head.json")),
        HeadState::Absent,
        "a refused event must not publish a head"
    );
}

#[test]
fn the_stream_ceiling_refuses_after_the_bound_and_keeps_history() {
    let dir = tempfile::tempdir().unwrap();
    let mut limits = limits();
    limits.max_stream_event_bytes = 400;
    let mut log = open(dir.path(), limits);
    let mut committed = 0u64;
    let mut refused = false;
    for marker in 0..50 {
        match log.append(spec("step.settled", marker)) {
            Ok(_) => committed += 1,
            Err(LogError::StreamFull { .. }) => {
                refused = true;
                break;
            }
            Err(error) => panic!("unexpected error: {error}"),
        }
    }
    assert!(refused, "the ceiling must eventually refuse");
    assert!(committed > 0);
    assert_eq!(collect(&log).len() as u64, committed, "history is intact");
}

#[test]
fn a_restart_resumes_the_sequence_and_the_chain() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut log = open(dir.path(), limits());
        for marker in 0..3 {
            log.append(spec("step.settled", marker)).unwrap();
        }
        assert_eq!(log.next_seq(), 3);
    }
    let mut log = open(dir.path(), limits());
    assert_eq!(log.next_seq(), 3, "the head carries the resume point");
    log.append(spec("step.settled", 3)).unwrap();
    let events = collect(&log);
    assert_eq!(events.len(), 4);
    assert_eq!(events[3].previous_digest, events[2].event_digest);
}

#[test]
fn a_torn_or_complete_uncommitted_tail_is_preserved_and_blocks_append() {
    let dir = tempfile::tempdir().unwrap();
    let segment = dir.path().join("segments/00000000.jsonl");
    {
        let mut log = open(dir.path(), limits());
        log.append(spec("step.settled", 0)).unwrap();
        log.append(spec("step.settled", 1)).unwrap();
    }
    let committed_size = fs::metadata(&segment).unwrap().len();
    // Simulate a crash between the write and the head commit: a partial line.
    {
        use std::io::Write as _;
        let mut file = fs::OpenOptions::new().append(true).open(&segment).unwrap();
        file.write_all(b"{\"seq\":2,\"time_ms\":").unwrap();
    }
    let tail_bytes = fs::metadata(&segment).unwrap().len() - committed_size;

    let mut log = open(dir.path(), limits());
    assert_eq!(log.uncommitted_tail_bytes(), tail_bytes);
    let error = log.append(spec("step.settled", 2)).unwrap_err();
    assert!(
        matches!(error, LogError::UncommittedTail { bytes, .. } if bytes == tail_bytes),
        "{error}"
    );
    let report = log.replay(|_| Ok(())).unwrap();
    assert_eq!(report.events, 2, "only committed events replay");
    assert_eq!(report.uncommitted_tail_bytes, tail_bytes);
    assert_eq!(
        fs::metadata(&segment).unwrap().len(),
        committed_size + tail_bytes,
        "the tail bytes are preserved, never truncated"
    );
}

#[test]
fn a_corrupt_sealed_segment_fails_replay_with_its_segment() {
    let dir = tempfile::tempdir().unwrap();
    let mut limits = limits();
    limits.max_segment_events = 4;
    {
        let mut log = open(dir.path(), limits);
        for marker in 0..6 {
            log.append(spec("step.settled", marker)).unwrap();
        }
        assert!(dir.path().join("segments/00000000.seal.json").is_file());
    }
    let first = dir.path().join("segments/00000000.jsonl");
    let text = fs::read_to_string(&first).unwrap();
    let tampered = text.replacen("\"marker\":0", "\"marker\":9", 1);
    assert_ne!(tampered, text, "the fixture must change a byte");
    fs::write(&first, tampered).unwrap();

    let log = open(dir.path(), limits);
    let error = log.replay(|_| Ok(())).unwrap_err();
    assert!(
        matches!(error, LogError::Corrupt { segment: 0, .. }),
        "the corrupt segment must be named: {error}"
    );
}

#[test]
fn a_newer_schema_version_is_refused_before_any_segment_is_read() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut log = open(dir.path(), limits());
        log.append(spec("step.settled", 0)).unwrap();
    }
    let head_path = dir.path().join("head.json");
    let mut head: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&head_path).unwrap()).unwrap();
    head["schema_version"] = json!(99);
    fs::write(&head_path, head.to_string()).unwrap();
    // Make the segment unreadable: a version check that ran after decoding
    // would report corruption instead.
    fs::write(dir.path().join("segments/00000000.jsonl"), b"garbage").unwrap();

    let error = EventLog::open(
        dir.path(),
        "session",
        "ses_1",
        limits(),
        DurabilityProfile::Interactive,
    )
    .expect_err("a newer version must be refused");
    assert!(
        matches!(
            error,
            LogError::UnsupportedVersion {
                found: 99,
                supported: 1
            }
        ),
        "{error}"
    );
}

#[test]
fn a_second_writer_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let _first = open(dir.path(), limits());
    let error = EventLog::open(
        dir.path(),
        "session",
        "ses_1",
        limits(),
        DurabilityProfile::Interactive,
    )
    .expect_err("a second writer must be refused");
    assert!(matches!(error, LogError::Locked { .. }), "{error}");
}

#[test]
fn an_empty_log_replays_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let log = open(dir.path(), limits());
    let report = log.replay(|_| Ok(())).unwrap();
    assert_eq!(report, horizoncode_eventlog::ReplayReport::default());
}

#[test]
fn a_run_durable_stream_refuses_a_backend_that_cannot_provide_it() {
    let dir = tempfile::tempdir().unwrap();
    let error = EventLog::open_with_sink(
        dir.path(),
        "session",
        "ses_1",
        limits(),
        DurabilityProfile::RunDurable,
        std::sync::Arc::new(horizoncode_eventlog::UnsupportedSink),
    )
    .expect_err("an unsupported backend must be refused");
    assert!(
        matches!(error, LogError::DurabilityRefused { .. }),
        "{error}"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_lock_or_segment_is_refused_not_followed() {
    // A link planted at the lock would redirect the lock target; a link at a
    // segment would redirect a read outside the stream.
    let dir = tempfile::tempdir().unwrap();
    let victim = dir.path().join("victim");
    fs::write(&victim, b"do not touch").unwrap();

    let lock = dir.path().join("lock");
    std::os::unix::fs::symlink(&victim, &lock).unwrap();
    let error = EventLog::open(
        dir.path(),
        "session",
        "ses_1",
        limits(),
        DurabilityProfile::Interactive,
    )
    .expect_err("a symlinked lock must be refused");
    assert!(matches!(error, LogError::UnsafePath { .. }), "{error}");
    fs::remove_file(&lock).unwrap();

    let mut log = open(dir.path(), limits());
    log.append(spec("step.settled", 0)).unwrap();
    drop(log);
    let segment = dir.path().join("segments/00000000.jsonl");
    let segment_bytes = fs::read(&segment).unwrap();
    let copy = dir.path().join("segment-copy");
    fs::write(&copy, segment_bytes).unwrap();
    fs::remove_file(&segment).unwrap();
    std::os::unix::fs::symlink(&copy, &segment).unwrap();

    let error = EventLog::open(
        dir.path(),
        "session",
        "ses_1",
        limits(),
        DurabilityProfile::Interactive,
    )
    .expect_err("a symlinked segment must be refused");
    assert!(matches!(error, LogError::UnsafePath { .. }), "{error}");
}

#[cfg(unix)]
#[test]
fn created_state_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let mut log = open(dir.path(), limits());
    log.append(spec("step.settled", 0)).unwrap();
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(dir.path()), 0o700, "stream root");
    assert_eq!(mode(&dir.path().join("segments")), 0o700, "segments dir");
    assert_eq!(mode(&dir.path().join("lock")), 0o600, "lock");
    assert_eq!(mode(&dir.path().join("head.json")), 0o600, "head");
    assert_eq!(
        mode(&dir.path().join("segments/00000000.jsonl")),
        0o600,
        "segment"
    );
}
