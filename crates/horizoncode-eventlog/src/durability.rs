//! The commit durability backend (`DEC-057`, `ARCH/07-SESSION.md` §Commit
//! durability backend).
//!
//! A durability profile is a claim about what a commit acknowledgement has
//! actually flushed on *this* host, so the backend is a small, explicit
//! interface rather than a hidden `fsync` call: exactly two capabilities, a file
//! sync and a directory-entry sync, plus a declaration of whether the platform
//! can provide the `run_durable` contract at all.
//!
//! The module lives in the shared event-log core because that core is what makes
//! a commit acknowledgement on behalf of both session and run history; the
//! session crate re-exports these items so its existing callers keep one import
//! path. The `run_durable` profile is a multi-hour-run requirement; where the
//! backend cannot provide it, it is **refused** — a weaker interactive profile
//! stays available for labeled interactive use and is never presented as
//! crash-durable.

use std::fmt;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::sync::Arc;

/// What a commit acknowledgement promises.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DurabilityProfile {
    /// The event file is flushed, and synchronized when the store is configured
    /// to do so. The containing directory entry is not synchronized. Visible
    /// only as interactive work.
    #[default]
    Interactive,
    /// The event file's bytes are synchronized **and** the containing directory
    /// entry is synchronized after any create, rename, seal or head replace,
    /// before the caller is told the step committed.
    RunDurable,
}

impl DurabilityProfile {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::RunDurable => "run_durable",
        }
    }
}

/// The two synchronization primitives a store commits through.
pub trait CommitSink: Send + Sync + fmt::Debug {
    /// Whether this backend can provide the `run_durable` contract here.
    fn supports_run_durable(&self) -> bool;

    /// Synchronizes a file's contents and the metadata needed to reach them.
    fn sync_file(&self, file: &File) -> io::Result<()>;

    /// Synchronizes a directory's own entries, so a create or rename inside it
    /// survives a crash.
    fn sync_dir(&self, dir: &Path) -> io::Result<()>;
}

/// The production backend: full `fsync` on the file, and a directory `fsync`
/// where the platform allows opening a directory for synchronization.
#[derive(Clone, Copy, Debug, Default)]
pub struct StdCommitSink;

impl CommitSink for StdCommitSink {
    fn supports_run_durable(&self) -> bool {
        cfg!(unix)
    }

    fn sync_file(&self, file: &File) -> io::Result<()> {
        file.sync_all()
    }

    fn sync_dir(&self, dir: &Path) -> io::Result<()> {
        if !cfg!(unix) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "this platform cannot synchronize a directory entry",
            ));
        }
        // A directory is opened read-only for the sole purpose of fsyncing its
        // entry list; nothing is written through this handle.
        let handle = OpenOptions::new().read(true).open(dir)?;
        handle.sync_all()
    }
}

/// A backend that provides nothing, for hosts with no accepted durability
/// mechanism. It refuses `run_durable` rather than pretending.
#[derive(Clone, Copy, Debug, Default)]
pub struct UnsupportedSink;

impl CommitSink for UnsupportedSink {
    fn supports_run_durable(&self) -> bool {
        false
    }

    fn sync_file(&self, _file: &File) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no accepted file-synchronization backend on this host",
        ))
    }

    fn sync_dir(&self, _dir: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no accepted directory-synchronization backend on this host",
        ))
    }
}

/// The production backend.
#[must_use]
pub fn std_sink() -> Arc<dyn CommitSink> {
    Arc::new(StdCommitSink)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct RecordingSink {
        calls: Mutex<Vec<&'static str>>,
        dir_fails: bool,
    }

    impl CommitSink for RecordingSink {
        fn supports_run_durable(&self) -> bool {
            true
        }

        fn sync_file(&self, _file: &File) -> io::Result<()> {
            self.calls.lock().unwrap().push("file");
            Ok(())
        }

        fn sync_dir(&self, _dir: &Path) -> io::Result<()> {
            self.calls.lock().unwrap().push("dir");
            if self.dir_fails {
                return Err(io::Error::new(
                    io::ErrorKind::StorageFull,
                    "injected directory sync failure",
                ));
            }
            Ok(())
        }
    }

    #[test]
    fn the_standard_backend_syncs_a_real_file_and_reports_its_capability() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.log");
        std::fs::write(&path, b"x").unwrap();
        let file = File::open(&path).unwrap();
        let sink = StdCommitSink;
        sink.sync_file(&file).unwrap();
        assert_eq!(sink.supports_run_durable(), cfg!(unix));
        if cfg!(unix) {
            sink.sync_dir(dir.path()).unwrap();
        } else {
            let error = sink.sync_dir(dir.path()).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        }
    }

    #[test]
    fn the_unsupported_backend_refuses_both_capabilities() {
        let sink = UnsupportedSink;
        assert!(!sink.supports_run_durable());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.log");
        std::fs::write(&path, b"x").unwrap();
        assert_eq!(
            sink.sync_file(&File::open(&path).unwrap())
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported
        );
        assert_eq!(
            sink.sync_dir(dir.path()).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
    }

    #[test]
    fn a_recording_sink_shows_the_commit_ordering() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.log");
        std::fs::write(&path, b"x").unwrap();
        let file = File::open(&path).unwrap();
        let sink = RecordingSink::default();
        sink.sync_file(&file).unwrap();
        sink.sync_dir(dir.path()).unwrap();
        assert_eq!(*sink.calls.lock().unwrap(), vec!["file", "dir"]);
    }
}
