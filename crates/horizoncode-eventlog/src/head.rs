//! The committed head: the one record a restart trusts (`ARCH/07` §`CommittedLogHead`).
//!
//! The head names the last acknowledged sequence and digest, the active
//! segment and its rolling content digest, the generation, and the durability
//! profile the commit was made under. It is replaced atomically (write a
//! sibling, synchronize, rename, synchronize the directory) and it is written
//! **after** the bytes it acknowledges, so bytes beyond the head are
//! uncommitted by construction.
//!
//! Read states are typed so that "the head is absent" and "the head is
//! unreadable" can never be confused, the same discipline the audit store
//! learned in `F-49`.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::CURRENT_SCHEMA_VERSION;
use crate::error::LogError;

/// The head file name inside a stream root.
pub const HEAD_FILE: &str = "head.json";

/// One committed log head.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommittedLogHead {
    /// The schema version the stream was written under.
    pub schema_version: u32,
    /// `session` or `run`.
    pub owner_kind: String,
    /// The owning session or run id.
    pub owner_id: String,
    /// The recovery generation; `0` until an explicit recovery starts one.
    pub generation: u64,
    /// The last acknowledged sequence.
    pub committed_seq: u64,
    /// The last acknowledged event digest.
    pub committed_event_digest: String,
    /// The segment that holds `committed_seq`.
    pub committed_segment: u32,
    /// The rolling content digest of that segment's committed prefix.
    pub committed_segment_digest: String,
    /// The durability profile the commit was acknowledged under.
    pub durability_profile: String,
    /// UTC epoch milliseconds of the last commit.
    pub updated_at: i64,
}

/// The typed result of reading a head file.
#[derive(Clone, Debug, PartialEq)]
pub enum HeadState {
    /// No head file exists.
    Absent,
    /// A valid head.
    Present(Box<CommittedLogHead>),
    /// The file exists but is not a valid head.
    Malformed {
        /// What is wrong with it.
        detail: String,
    },
    /// The file exists but could not be read.
    Unreadable {
        /// The underlying failure.
        detail: String,
    },
}

/// Reads the head file at `path`.
#[must_use]
pub fn read_head(path: &Path) -> HeadState {
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<CommittedLogHead>(&text) {
            Ok(head) => HeadState::Present(Box::new(head)),
            Err(error) => HeadState::Malformed {
                detail: error.to_string(),
            },
        },
        Err(error) if error.kind() == ErrorKind::NotFound => HeadState::Absent,
        Err(error) => HeadState::Unreadable {
            detail: error.to_string(),
        },
    }
}

/// Writes the head atomically.
///
/// The caller is responsible for synchronizing the containing directory through
/// the durability backend before acknowledging the commit (`DEC-057`); this
/// function synchronizes the file it replaces.
///
/// # Errors
/// Returns [`LogError::Io`] when the head cannot be written.
pub fn write_head(path: &Path, head: &CommittedLogHead) -> Result<(), LogError> {
    let temp: PathBuf = path.with_extension("new");
    let line =
        serde_json::to_string(head).map_err(|error| LogError::encode(path, error.to_string()))?;
    {
        use std::io::Write as _;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp)
            .map_err(|error| LogError::io(&temp, &error))?;
        file.write_all(line.as_bytes())
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_all())
            .map_err(|error| LogError::io(&temp, &error))?;
    }
    fs::rename(&temp, path).map_err(|error| LogError::io(path, &error))
}

/// Whether a head names a schema version this build understands.
///
/// # Errors
/// Returns [`LogError::UnsupportedVersion`] for a newer version and
/// [`LogError::Corrupt`] for an impossible zero.
pub fn check_version(head: &CommittedLogHead) -> Result<(), LogError> {
    if head.schema_version > CURRENT_SCHEMA_VERSION {
        return Err(LogError::UnsupportedVersion {
            found: head.schema_version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }
    if head.schema_version == 0 {
        return Err(LogError::Corrupt {
            segment: head.committed_segment,
            detail: "the head names schema version 0".to_owned(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head() -> CommittedLogHead {
        CommittedLogHead {
            schema_version: CURRENT_SCHEMA_VERSION,
            owner_kind: "session".to_owned(),
            owner_id: "ses_1".to_owned(),
            generation: 0,
            committed_seq: 3,
            committed_event_digest: "a".repeat(64),
            committed_segment: 0,
            committed_segment_digest: "b".repeat(64),
            durability_profile: "run_durable".to_owned(),
            updated_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn a_missing_head_is_absent_and_a_corrupt_one_is_malformed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HEAD_FILE);
        assert_eq!(read_head(&path), HeadState::Absent);
        fs::write(&path, b"{not json").unwrap();
        assert!(matches!(read_head(&path), HeadState::Malformed { .. }));
    }

    #[test]
    fn a_head_round_trips_and_replaces_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HEAD_FILE);
        write_head(&path, &head()).unwrap();
        assert_eq!(
            read_head(&path),
            HeadState::Present(Box::new(head())),
            "the first write is readable"
        );
        let mut second = head();
        second.committed_seq = 4;
        write_head(&path, &second).unwrap();
        assert_eq!(read_head(&path), HeadState::Present(Box::new(second)));
    }

    #[test]
    fn a_newer_schema_version_is_refused_before_anything_is_decoded() {
        let mut newer = head();
        newer.schema_version = CURRENT_SCHEMA_VERSION + 1;
        assert!(matches!(
            check_version(&newer),
            Err(LogError::UnsupportedVersion { found, supported })
                if found == CURRENT_SCHEMA_VERSION + 1 && supported == CURRENT_SCHEMA_VERSION
        ));
        let mut zero = head();
        zero.schema_version = 0;
        assert!(matches!(
            check_version(&zero),
            Err(LogError::Corrupt { .. })
        ));
    }
}
