//! Typed errors for the session store.

use std::path::PathBuf;

use horizoncode_types::SessionId;
use thiserror::Error;

/// A failure loading, appending to, or managing a session log.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum SessionError {
    /// A filesystem operation failed.
    #[error("session io error at {path}: {source}")]
    Io {
        /// The path involved.
        path: PathBuf,
        /// The underlying error.
        #[source]
        source: std::io::Error,
    },

    /// No session exists for the given id.
    #[error("session not found: {0}")]
    NotFound(SessionId),

    /// A log line could not be decoded.
    #[error("corrupt session log at {path}:{line}: {message}")]
    Corrupt {
        /// The log path.
        path: PathBuf,
        /// One-based line number.
        line: usize,
        /// A description of the problem.
        message: String,
    },

    /// The log's format version is newer than this build supports.
    #[error("unsupported session format version {found} (this build supports <= {supported})")]
    UnsupportedVersion {
        /// The version found in the log.
        found: u32,
        /// The highest version this build supports.
        supported: u32,
    },

    /// The event sequence numbers are not dense and monotonic.
    #[error("session sequence gap: expected {expected}, found {found}")]
    SeqGap {
        /// The next sequence number that was expected.
        expected: u64,
        /// The sequence number actually found.
        found: u64,
    },

    /// A write or promotion was attempted against a closed session.
    #[error("session is closed: {0}")]
    Closed(SessionId),

    /// A payload could not be encoded or decoded.
    #[error("session payload error: {0}")]
    Payload(String),
}

impl SessionError {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}
