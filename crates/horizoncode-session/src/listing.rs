//! Typed session enumeration and per-entry integrity (`ARCH/07-SESSION.md`).
//!
//! Listing a store is how a user finds out whether work exists, so it must never
//! answer "no sessions" when the truth is "the scan failed". Two different
//! failures are therefore distinguished:
//!
//! - a **store-level** problem (the directory could not be read, the iterator
//!   failed) makes the enumeration itself incomplete;
//! - a **session-level** problem (one log is corrupt, unreadable, torn, or
//!   written by a newer build) is a visible row carrying its own typed issue.
//!
//! The result contract is fixed in `ARCH/07`: `SessionListResult`, with the
//! `SessionListIssue` payload and the integrity derivation order below.

use std::path::PathBuf;

use horizoncode_types::SessionId;
use serde::{Deserialize, Serialize};

use crate::session::SessionSummary;

/// What is known about one session's stored log.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionIntegrityState {
    /// The log parsed cleanly.
    Available,
    /// A row, the header, or the sequence is not readable as written.
    Corrupt,
    /// The log was written by a newer format version than this build.
    Unsupported,
    /// The log's bytes could not be read at all.
    Unreadable,
    /// The log's last write was interrupted; the tail is retained and unreconciled.
    RecoveryPending,
    /// The state could not be determined.
    Unknown,
}

impl SessionIntegrityState {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Corrupt => "corrupt",
            Self::Unsupported => "unsupported",
            Self::Unreadable => "unreadable",
            Self::RecoveryPending => "recovery_pending",
            Self::Unknown => "unknown",
        }
    }
}

/// The exact set of problems a listing can report.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionListIssueKind {
    /// The sessions directory itself could not be read. Store-level.
    DirectoryUnreadable,
    /// The directory iterator failed part way through. Store-level.
    IteratorError,
    /// A discovered entry's bytes could not be read.
    EntryUnreadable,
    /// The log has no `session/created` row.
    HeaderMissing,
    /// The `session/created` row is not decodable.
    HeaderCorrupt,
    /// The header's format version is newer than this build.
    HeaderUnsupported,
    /// A non-final row is not decodable, or the sequence is not dense.
    LogCorrupt,
    /// The log's format version is newer than this build.
    LogUnsupported,
    /// The final write was interrupted; its bytes are retained.
    TailTorn,
}

impl SessionListIssueKind {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectoryUnreadable => "directory_unreadable",
            Self::IteratorError => "iterator_error",
            Self::EntryUnreadable => "entry_unreadable",
            Self::HeaderMissing => "header_missing",
            Self::HeaderCorrupt => "header_corrupt",
            Self::HeaderUnsupported => "header_unsupported",
            Self::LogCorrupt => "log_corrupt",
            Self::LogUnsupported => "log_unsupported",
            Self::TailTorn => "tail_torn",
        }
    }

    /// Whether this problem makes the enumeration itself incomplete, as opposed
    /// to being a property of one session.
    #[must_use]
    pub fn is_store_level(self) -> bool {
        matches!(self, Self::DirectoryUnreadable | Self::IteratorError)
    }
}

/// One typed problem, with the exact path that was examined.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListIssue {
    /// The problem class.
    pub kind: SessionListIssueKind,
    /// The session it belongs to, when the problem is not store-level.
    pub session_id: Option<SessionId>,
    /// The exact path examined.
    pub path: PathBuf,
    /// The cause, never a bare "unknown".
    pub message: String,
    /// The 1-based line at fault, when a specific line is at fault.
    pub line: Option<usize>,
    /// The affected byte count, when known.
    pub bytes_affected: Option<u64>,
}

impl SessionListIssue {
    /// Builds a store-level issue.
    #[must_use]
    pub fn store_level(kind: SessionListIssueKind, path: PathBuf, message: String) -> Self {
        Self {
            kind,
            session_id: None,
            path,
            message,
            line: None,
            bytes_affected: None,
        }
    }

    /// Builds a per-session issue.
    #[must_use]
    pub fn for_session(
        kind: SessionListIssueKind,
        session_id: SessionId,
        path: PathBuf,
        message: String,
    ) -> Self {
        Self {
            kind,
            session_id: Some(session_id),
            path,
            message,
            line: None,
            bytes_affected: None,
        }
    }

    /// Records the 1-based line at fault.
    #[must_use]
    pub fn at_line(mut self, line: usize) -> Self {
        self.line = Some(line);
        self
    }

    /// Records the affected byte count.
    #[must_use]
    pub fn affecting_bytes(mut self, bytes: u64) -> Self {
        self.bytes_affected = Some(bytes);
        self
    }
}

/// One session as enumeration found it.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionListEntry {
    /// The stable identity, present even when the log is unreadable.
    pub id: SessionId,
    /// The last known projection, when the header could be read.
    pub summary: Option<SessionSummary>,
    /// What is known about the stored log.
    pub integrity: SessionIntegrityState,
    /// The problem, when this row is not plain `available`.
    pub issue: Option<SessionListIssue>,
}

/// The result of enumerating the store.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionListResult {
    /// Every session found, in a deterministic order.
    pub items: Vec<SessionListEntry>,
    /// `false` only when the store-level scan itself was incomplete.
    pub enumeration_complete: bool,
    /// Store-level issues; per-session issues stay on their entry.
    pub issues: Vec<SessionListIssue>,
}

impl SessionListResult {
    /// Returns the sessions that are plainly readable.
    pub fn available(&self) -> impl Iterator<Item = &SessionListEntry> {
        self.items
            .iter()
            .filter(|entry| entry.integrity == SessionIntegrityState::Available)
    }
}
