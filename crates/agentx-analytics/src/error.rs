//! Typed analytics failures.
//!
//! The stance is the same as the audit store's: a missing input is **reported**,
//! never replaced with a plausible-looking value. A rollup that cannot be
//! computed is an error; a cost that cannot be priced is `unknown`, never zero
//! (`ARCH/20-ANALYTICS.md` §Cost semantics).

use std::path::PathBuf;

use thiserror::Error;

/// A failure that stops an analytics operation.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum AnalyticsError {
    /// The analytics configuration is invalid.
    #[error("invalid analytics configuration: {0}")]
    Config(String),

    /// A filesystem operation failed.
    #[error("analytics io error at {path}: {message}")]
    Io {
        /// The path the operation targeted.
        path: PathBuf,
        /// The underlying error.
        message: String,
    },

    /// The rollup database failed.
    #[error("rollup database error: {0}")]
    Sqlite(String),

    /// The ledger is corrupt at a line.
    #[error("analytics ledger line {line} is not a valid event: {message}")]
    Ledger {
        /// The 1-based line number.
        line: usize,
        /// What was wrong.
        message: String,
    },

    /// A query is not answerable from the rollups.
    #[error("rollup query failed: {0}")]
    Query(String),

    /// The declared configuration is understood but not implemented.
    ///
    /// Analytics is local-only. A request to emit telemetry anywhere is refused
    /// loudly rather than silently ignored, so nobody can believe a remote
    /// export happened when it did not (`REQ-ANALYTICS-004`).
    #[error(
        "analytics feature `{0}` is declared but not implemented; no telemetry left this machine"
    )]
    Unsupported(String),
}

impl AnalyticsError {
    /// Wraps an I/O error with its path.
    #[must_use]
    pub fn io(path: impl Into<PathBuf>, error: &std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            message: error.to_string(),
        }
    }

    /// Wraps a `rusqlite` error.
    #[must_use]
    pub fn sqlite(error: &rusqlite::Error) -> Self {
        Self::Sqlite(error.to_string())
    }
}
