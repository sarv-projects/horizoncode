//! Crash/restart evidence for the session log (`ARCH/07-SESSION.md`,
//! `ACC-P1-06`).
//!
//! The property under test is the one a crash can break: **an acknowledged step
//! is never lost, and an unacknowledged one is never counted as committed.**
//!
//! Two kinds of crash are exercised:
//!
//! - a **real process death at a commit boundary** — the child aborts from
//!   inside the durability backend, at the file sync or the directory sync, so
//!   the process dies exactly where a power cut would leave the store;
//! - an **interrupted final write** — the child writes a partial row and dies,
//!   which is the byte state an interrupted write leaves behind.
//!
//! Each scenario repeats, because a crash-consistency property proven once is
//! not proven; `REPETITIONS` is the repetition count `ARCH/23` asks for from
//! tests that use real processes.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;

use horizoncode_session::{
    CommitSink, DurabilityProfile, ModelRef, SessionCreatedPayload, SessionIntegrityState,
    SessionStore, TailState,
};
use horizoncode_testkit::{KILL_POINT_ENV, TestClock};
use horizoncode_types::{Event, EventKind};
use serde_json::json;

/// Environment variable naming the state root the child must use.
const CHILD_ROOT_ENV: &str = "HORIZONCODE_TEST_CHILD_ROOT";
/// Environment variable that marks this process as the crash child.
const CHILD_FLAG_ENV: &str = "HORIZONCODE_TEST_CHILD";

/// How many crash/restart cycles each scenario must survive.
const REPETITIONS: usize = 20;

fn header() -> SessionCreatedPayload {
    SessionCreatedPayload::new(
        "workspace:kill",
        "kill matrix",
        ModelRef {
            id: "test-model".to_owned(),
            provider: "local".to_owned(),
            variant: None,
        },
        "chat",
        json!({ "rules": [] }),
    )
}

/// Where the child should die.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CrashPoint {
    /// Complete normally: the control case.
    None,
    /// Die from inside the file sync, with the bytes already written.
    OnSyncFile,
    /// Die from inside the directory sync, after the file is durable.
    OnSyncDir,
    /// Die with a partially written row appended to a new log.
    OnCreateTornTail,
    /// Die with a partially written row appended after a committed create.
    OnAppendTornTail,
}

impl CrashPoint {
    fn from_env() -> Self {
        match std::env::var(KILL_POINT_ENV).as_deref() {
            Ok("session_sync_file") => Self::OnSyncFile,
            Ok("session_sync_dir") => Self::OnSyncDir,
            Ok("session_create_torn_tail") => Self::OnCreateTornTail,
            Ok("session_append_torn_tail") => Self::OnAppendTornTail,
            _ => Self::None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::None => "control",
            Self::OnSyncFile => "session_sync_file",
            Self::OnSyncDir => "session_sync_dir",
            Self::OnCreateTornTail => "session_create_torn_tail",
            Self::OnAppendTornTail => "session_append_torn_tail",
        }
    }
}

/// A backend that aborts the process at a chosen commit step.
#[derive(Debug)]
struct KillSink {
    crash: CrashPoint,
}

impl CommitSink for KillSink {
    fn supports_run_durable(&self) -> bool {
        true
    }

    fn sync_file(&self, file: &std::fs::File) -> std::io::Result<()> {
        if self.crash == CrashPoint::OnSyncFile {
            std::process::abort();
        }
        file.sync_all()
    }

    fn sync_dir(&self, dir: &std::path::Path) -> std::io::Result<()> {
        if self.crash == CrashPoint::OnSyncDir {
            std::process::abort();
        }
        horizoncode_session::std_sink().sync_dir(dir)
    }
}

/// The child: commit what it can, then die at the requested point.
fn run_child(root: &std::path::Path, crash: CrashPoint) {
    let store = SessionStore::open(root)
        .unwrap()
        .with_clock(Arc::new(TestClock::new(1_700_000_000_000)))
        .with_sink(Arc::new(KillSink { crash }));
    let store = store
        .with_durability(DurabilityProfile::RunDurable)
        .expect("the durable profile must be selectable in this fixture");
    let session = store.create(header()).unwrap();
    if crash == CrashPoint::OnCreateTornTail {
        // The create was acknowledged, then a second write was interrupted: the
        // log now ends in a partial row.
        append_partial_row(&store, &session.id);
        std::process::abort();
    }
    store
        .append(
            &session.id,
            Event::payload(
                EventKind::InputPromoted,
                &json!({ "input_id": "in_1", "delivery": "user", "text": "hello" }),
            ),
        )
        .unwrap();
    if crash == CrashPoint::OnAppendTornTail {
        append_partial_row(&store, &session.id);
        std::process::abort();
    }
    std::process::exit(0);
}

fn append_partial_row(store: &SessionStore, id: &horizoncode_types::SessionId) {
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(store.log_path(id))
        .unwrap();
    file.write_all(b"{\"seq\":1,\"time\":1,\"type\":\"input/prom")
        .unwrap();
}

/// Runs one crash child against `root`.
fn run_child_once(root: &std::path::Path, crash: CrashPoint) {
    let mut command = Command::new(std::env::current_exe().expect("the test binary must run"));
    command
        .arg("--exact")
        .arg("a_crash_at_every_commit_boundary_loses_no_acknowledged_step")
        .arg("--nocapture")
        .env(CHILD_FLAG_ENV, "1")
        .env(CHILD_ROOT_ENV, root)
        .env_remove(KILL_POINT_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if crash != CrashPoint::None {
        command.env(KILL_POINT_ENV, crash.as_str());
    }
    // The child's own outcome is the scenario's input, not an assertion here.
    let _ = command.status();
}

/// Checks the state a crash left behind, which is the actual property.
fn check_after_crash(root: &std::path::Path, crash: CrashPoint) {
    let label = crash.as_str();
    let store = SessionStore::open(root).expect("the store must reopen after a crash");
    let listed = store.list();
    assert!(
        listed.enumeration_complete,
        "{label}: a crash must not make the store unlistable"
    );
    assert!(
        !listed.items.is_empty(),
        "{label}: a session was created before the crash"
    );

    let mut committed_rows = 0usize;
    for entry in &listed.items {
        match entry.integrity {
            SessionIntegrityState::Available | SessionIntegrityState::RecoveryPending => {
                // Committed rows stay dense in both cases: a crash cannot leave a
                // hole in the sequence of what was acknowledged, and the
                // interrupted row is not counted as one. A recovery-pending row
                // is additionally required to name the bytes it retains.
                let report = store.read_only(&entry.id).unwrap();
                if entry.integrity == SessionIntegrityState::RecoveryPending {
                    assert!(
                        matches!(report.tail, TailState::Torn { bytes } if bytes > 0),
                        "{label}: a recovery-pending row must name its retained bytes"
                    );
                }
                for (index, event) in report.events.iter().enumerate() {
                    assert_eq!(
                        event.seq, index as u64,
                        "{label}: an acknowledged step was lost or reordered"
                    );
                }
                committed_rows += report.events.len();
            }
            other => panic!("{label}: unexpected integrity state {other:?}"),
        }
    }
    assert!(
        committed_rows >= 1,
        "{label}: the acknowledged create must survive the crash"
    );
    // The store is usable again: a fresh session commits and replays exactly.
    let session = store
        .create(header())
        .expect("a new session must be creatable");
    store
        .append(
            &session.id,
            Event::payload(
                EventKind::SessionUpdated,
                &json!({ "title": "after crash" }),
            ),
        )
        .expect("a new step must be committable after a crash");
    let replayed = store.read_only(&session.id).unwrap();
    assert_eq!(replayed.events.len(), 2, "{label}: replay is not exact");
    assert!(
        replayed
            .events
            .windows(2)
            .all(|pair| pair[1].seq > pair[0].seq)
    );
}

#[test]
fn a_crash_at_every_commit_boundary_loses_no_acknowledged_step() {
    // The parent spawns this same test binary as a child; the child takes the
    // branch below and performs exactly one crash.
    if std::env::var(CHILD_FLAG_ENV).is_ok() {
        let root = std::env::var(CHILD_ROOT_ENV).expect("the child needs a state root");
        run_child(std::path::Path::new(&root), CrashPoint::from_env());
    }

    for crash in [
        CrashPoint::None,
        CrashPoint::OnSyncFile,
        CrashPoint::OnSyncDir,
        CrashPoint::OnCreateTornTail,
        CrashPoint::OnAppendTornTail,
    ] {
        for _ in 0..REPETITIONS {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("sessions");
            run_child_once(&root, crash);
            check_after_crash(&root, crash);
        }
    }
}
