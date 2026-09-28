//! Typed failures of the shared event log.

use std::path::{Path, PathBuf};

use crate::envelope::EventEnvelopeError;

/// Why a log operation failed.
#[derive(Debug, thiserror::Error)]
pub enum LogError {
    /// A filesystem operation failed.
    #[error("{path} failed: {detail}")]
    Io {
        /// The path involved.
        path: PathBuf,
        /// The underlying failure.
        detail: String,
    },
    /// Another writer holds the stream lock.
    #[error("the event log at {root} is locked by another writer")]
    Locked {
        /// The stream root.
        root: PathBuf,
    },
    /// Segments exist but no committed head does.
    #[error(
        "the event log at {root} has segments but no committed head; explicit recovery is required"
    )]
    HeadMissing {
        /// The stream root.
        root: PathBuf,
    },
    /// The head file exists but is not a valid head.
    #[error("the committed head at {path} is malformed: {detail}")]
    HeadMalformed {
        /// The head path.
        path: PathBuf,
        /// What is wrong with it.
        detail: String,
    },
    /// The head file exists but could not be read.
    #[error("the committed head at {path} cannot be read: {detail}")]
    HeadUnreadable {
        /// The head path.
        path: PathBuf,
        /// The underlying failure.
        detail: String,
    },
    /// The head names a newer schema version.
    #[error("the log schema version {found} is newer than this build supports ({supported})")]
    UnsupportedVersion {
        /// The version in the head.
        found: u32,
        /// The version this build writes.
        supported: u32,
    },
    /// The head belongs to a different owner.
    #[error("the committed head belongs to {found}, not {expected}")]
    OwnerMismatch {
        /// The requested owner.
        expected: String,
        /// The owner in the head.
        found: String,
    },
    /// The event itself is invalid.
    #[error(transparent)]
    Envelope(#[from] EventEnvelopeError),
    /// One event exceeds the record ceiling.
    #[error("the event is {bytes} bytes, above the {limit}-byte record ceiling")]
    EventTooLarge {
        /// The encoded event bytes.
        bytes: u64,
        /// The effective limit.
        limit: u64,
    },
    /// The stream has reached its event-byte ceiling.
    #[error("the stream has reached its {limit}-byte event ceiling")]
    StreamFull {
        /// The effective limit.
        limit: u64,
    },
    /// Bytes beyond the committed head are present; recovery is required.
    #[error(
        "segment {segment} has {bytes} uncommitted bytes beyond the head; recovery is required before append"
    )]
    UncommittedTail {
        /// The segment holding the tail.
        segment: u32,
        /// The uncommitted byte count.
        bytes: u64,
    },
    /// Stored bytes are not the chain the head describes.
    #[error("segment {segment} is corrupt: {detail}")]
    Corrupt {
        /// The segment involved.
        segment: u32,
        /// What failed.
        detail: String,
    },
    /// A committed segment has no seal.
    #[error("segment {segment} is committed but has no seal")]
    SealMissing {
        /// The segment involved.
        segment: u32,
    },
    /// A seal does not describe its segment.
    #[error("segment {segment}'s seal does not match: {detail}")]
    SealMismatch {
        /// The segment involved.
        segment: u32,
        /// What failed.
        detail: String,
    },
    /// The durability backend refused the commit.
    #[error("the durability backend refused: {detail}")]
    DurabilityRefused {
        /// The backend's reason.
        detail: String,
    },
    /// A state path is not safe to use (`ARCH/22` `F-02`/`L-07`).
    #[error("unsafe state path {path}: {detail}")]
    UnsafePath {
        /// The path involved.
        path: PathBuf,
        /// What is wrong with it.
        detail: String,
    },
    /// The replay visitor failed.
    #[error("the replay visitor failed: {0}")]
    Visitor(String),
}

impl LogError {
    pub(crate) fn io(path: &Path, error: &std::io::Error) -> Self {
        Self::Io {
            path: path.to_path_buf(),
            detail: error.to_string(),
        }
    }

    pub(crate) fn encode(path: &Path, detail: String) -> Self {
        Self::Io {
            path: path.to_path_buf(),
            detail,
        }
    }

    pub(crate) fn corrupt(segment: u32, detail: impl Into<String>) -> Self {
        Self::Corrupt {
            segment,
            detail: detail.into(),
        }
    }

    pub(crate) fn unsafe_path(path: &Path, error: std::io::Error) -> Self {
        Self::UnsafePath {
            path: path.to_path_buf(),
            detail: error.to_string(),
        }
    }
}
