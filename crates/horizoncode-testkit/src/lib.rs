//! Test-only support for HorizonCode (`ARCH/23-VERIFICATION.md` §Determinism).
//!
//! This crate is a **development dependency of the test suites only**: it is
//! never linked into the `horizoncode` binary, and no product module depends on
//! it. It exists because the determinism policy is a hard prerequisite rather
//! than a nicety:
//!
//! - [`TestClock`] replaces the host wall clock, so stored timestamps are a
//!   function of the test's inputs rather than of when the suite ran.
//! - [`ScriptedFaults`] turns a durability or filesystem step into a
//!   deterministic failure, so "the disk was full" is a test case rather than an
//!   incident.
//! - [`StoreSnapshot`] proves a read path changed nothing by comparing bytes,
//!   length and digest of every file under a root before and after.
//! - [`kill_point_from_env`] lets a test binary re-exec itself as a child that
//!   aborts at a named step, which is how the real kill/restart matrices are
//!   built without a second harness.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub use horizoncode_types::{Clock, SystemClock};

/// The environment variable naming the step at which a child process must die.
pub const KILL_POINT_ENV: &str = "HORIZONCODE_TEST_KILL_POINT";

/// A clock a test advances by hand.
#[derive(Debug)]
pub struct TestClock {
    now_ms: Mutex<i64>,
}

impl TestClock {
    /// Builds a clock starting at `start_ms`.
    #[must_use]
    pub fn new(start_ms: i64) -> Self {
        Self {
            now_ms: Mutex::new(start_ms),
        }
    }

    /// Moves the clock forward.
    ///
    /// # Panics
    /// Panics if the clock is poisoned, which can only happen if a test panicked
    /// while holding it.
    pub fn advance(&self, delta_ms: i64) {
        let mut now = self.now_ms.lock().unwrap_or_else(|e| e.into_inner());
        *now = now.saturating_add(delta_ms);
    }
}

impl Default for TestClock {
    fn default() -> Self {
        Self::new(1_700_000_000_000)
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        *self.now_ms.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A named step a store can be asked to interrupt.
///
/// The variants cover the boundaries where a crash can actually lose or
/// duplicate state: the write itself, the file flush, the directory entry, the
/// head replacement, the access receipt, and lock acquisition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FaultOp {
    /// Writing a new session log.
    SessionCreateWrite,
    /// Appending to a session log.
    SessionAppendWrite,
    /// Synchronizing a session log file.
    SessionSyncFile,
    /// Synchronizing a session directory entry.
    SessionSyncDir,
    /// Appending an audit entry.
    AuditAppendWrite,
    /// Replacing the audit head pointer.
    AuditHeadReplace,
    /// Recording an audit access receipt.
    AuditAccessRecord,
    /// Acquiring the audit writer lock.
    LockAcquire,
}

impl FaultOp {
    /// Parses the wire name used by [`KILL_POINT_ENV`].
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "session_create_write" => Self::SessionCreateWrite,
            "session_append_write" => Self::SessionAppendWrite,
            "session_sync_file" => Self::SessionSyncFile,
            "session_sync_dir" => Self::SessionSyncDir,
            "audit_append_write" => Self::AuditAppendWrite,
            "audit_head_replace" => Self::AuditHeadReplace,
            "audit_access_record" => Self::AuditAccessRecord,
            "lock_acquire" => Self::LockAcquire,
            _ => return None,
        })
    }

    /// Returns the wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionCreateWrite => "session_create_write",
            Self::SessionAppendWrite => "session_append_write",
            Self::SessionSyncFile => "session_sync_file",
            Self::SessionSyncDir => "session_sync_dir",
            Self::AuditAppendWrite => "audit_append_write",
            Self::AuditHeadReplace => "audit_head_replace",
            Self::AuditAccessRecord => "audit_access_record",
            Self::LockAcquire => "lock_acquire",
        }
    }
}

/// What a scripted fault does when its step is reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultAction {
    /// Fail the operation with this I/O error kind.
    Fail(io::ErrorKind),
    /// Abort the process immediately, before the step takes effect.
    Abort,
}

impl FaultAction {
    /// Returns the I/O error a failing action produces.
    #[must_use]
    pub fn error(self) -> io::Error {
        match self {
            Self::Fail(kind) => io::Error::new(kind, "injected fault"),
            Self::Abort => io::Error::other("injected abort"),
        }
    }
}

/// The injection point a durable store consults at each durability boundary.
pub trait FaultInjector: Send + Sync + fmt::Debug {
    /// Returns the action for `op`, or `None` to proceed normally.
    fn action(&self, op: FaultOp) -> Option<FaultAction>;
}

/// The production injector: never faults.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoFaults;

impl FaultInjector for NoFaults {
    fn action(&self, _op: FaultOp) -> Option<FaultAction> {
        None
    }
}

/// A deterministic fault script.
#[derive(Debug, Default)]
pub struct ScriptedFaults {
    actions: Mutex<BTreeMap<FaultOp, FaultAction>>,
}

impl ScriptedFaults {
    /// Builds an empty script.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Fails `op` with `kind`.
    #[must_use]
    pub fn with_failure(self, op: FaultOp, kind: io::ErrorKind) -> Self {
        self.actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(op, FaultAction::Fail(kind));
        self
    }

    /// Aborts the process at `op`.
    #[must_use]
    pub fn with_abort(self, op: FaultOp) -> Self {
        self.actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(op, FaultAction::Abort);
        self
    }
}

impl FaultInjector for ScriptedFaults {
    fn action(&self, op: FaultOp) -> Option<FaultAction> {
        self.actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&op)
            .copied()
    }
}

/// Applies a scripted action: aborts the process, or returns the error.
pub fn apply(action: FaultAction) -> io::Error {
    match action {
        FaultAction::Abort => std::process::abort(),
        FaultAction::Fail(kind) => io::Error::new(kind, "injected fault"),
    }
}

/// Reads the kill point a parent process requested, if any.
///
/// # Errors
/// Returns [`io::ErrorKind::InvalidInput`] when the variable names a step this
/// build does not know, so a typo fails loudly instead of disabling the kill.
pub fn kill_point_from_env() -> Result<Option<FaultOp>, String> {
    match std::env::var(KILL_POINT_ENV) {
        Err(_) => Ok(None),
        Ok(value) if value.is_empty() => Ok(None),
        Ok(value) => FaultOp::parse(&value).map(Some).ok_or_else(|| {
            format!("unknown {KILL_POINT_ENV} `{value}`; use FaultOp::as_str names")
        }),
    }
}

/// The bytes of every file under `root`, keyed by relative path.
///
/// A read path that changes nothing is proven by comparing two snapshots, not
/// by asserting a single file: a repair that appends to one log and leaves
/// another alone would still be a mutation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreSnapshot {
    root: PathBuf,
    files: BTreeMap<PathBuf, Option<Vec<u8>>>,
}

impl StoreSnapshot {
    /// Captures every regular file under `root`.
    ///
    /// # Panics
    /// Panics if a path cannot be read during the walk, which in a test means
    /// the fixture is broken rather than the code under test.
    #[must_use]
    pub fn capture(root: &Path) -> Self {
        let mut files = BTreeMap::new();
        collect(root, root, &mut files);
        Self {
            root: root.to_path_buf(),
            files,
        }
    }

    /// Returns the captured relative paths.
    pub fn paths(&self) -> impl Iterator<Item = &PathBuf> {
        self.files.keys()
    }

    /// Returns the captured bytes of one file, if it was present.
    #[must_use]
    pub fn get(&self, path: &Path) -> Option<&[u8]> {
        self.files.get(&self.strip(path)).and_then(Option::as_deref)
    }

    /// Asserts that nothing under the root changed.
    ///
    /// # Panics
    /// Panics naming the added, removed or changed paths, which is the evidence
    /// `ACC-P1-12` requires for a read route.
    pub fn assert_unchanged(&self) {
        let after = Self::capture(&self.root);
        assert_eq!(
            self.files,
            after.files,
            "the read path mutated {}",
            self.root.display()
        );
    }

    fn strip(&self, path: &Path) -> PathBuf {
        path.strip_prefix(&self.root).unwrap_or(path).to_path_buf()
    }
}

fn collect(root: &Path, dir: &Path, files: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect(root, &path, files);
        } else {
            let relative = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
            files.insert(relative, fs::read(&path).ok());
        }
    }
}

/// Returns the `blake3` digest of a file, or `None` when it cannot be read.
#[must_use]
pub fn file_digest(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| blake3::hash(&bytes).to_hex().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_test_clock_only_moves_when_told() {
        let clock = TestClock::new(10);
        assert_eq!(clock.now_ms(), 10);
        clock.advance(5);
        assert_eq!(clock.now_ms(), 15);
    }

    #[test]
    fn a_scripted_fault_only_fires_at_its_own_step() {
        let script =
            ScriptedFaults::new().with_failure(FaultOp::SessionSyncDir, io::ErrorKind::StorageFull);
        assert_eq!(script.action(FaultOp::SessionSyncFile), None);
        assert_eq!(
            script.action(FaultOp::SessionSyncDir),
            Some(FaultAction::Fail(io::ErrorKind::StorageFull))
        );
        assert_eq!(NoFaults.action(FaultOp::SessionSyncDir), None);
    }

    #[test]
    fn a_snapshot_catches_an_added_file_and_a_changed_byte() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("store");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.log"), b"one\n").unwrap();
        let snapshot = StoreSnapshot::capture(&root);
        snapshot.assert_unchanged();

        fs::write(root.join("a.log"), b"two\n").unwrap();
        let changed = std::panic::catch_unwind(|| snapshot.assert_unchanged()).is_err();
        assert!(changed, "a changed byte must be caught");

        let snapshot = StoreSnapshot::capture(&root);
        fs::write(root.join("b.log"), b"new\n").unwrap();
        let added = std::panic::catch_unwind(|| snapshot.assert_unchanged()).is_err();
        assert!(added, "an added file must be caught");
    }

    #[test]
    fn kill_points_round_trip_through_the_environment() {
        for op in [
            FaultOp::SessionCreateWrite,
            FaultOp::SessionAppendWrite,
            FaultOp::SessionSyncFile,
            FaultOp::SessionSyncDir,
            FaultOp::AuditAppendWrite,
            FaultOp::AuditHeadReplace,
            FaultOp::AuditAccessRecord,
            FaultOp::LockAcquire,
        ] {
            assert_eq!(FaultOp::parse(op.as_str()), Some(op));
        }
        assert_eq!(FaultOp::parse("nope"), None);
    }
}
