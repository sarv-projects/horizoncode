//! Typed audit failures.
//!
//! Every variant is a **fail-closed** condition: the store refuses to proceed
//! rather than degrade to a weaker posture that could be mistaken for the
//! configured one (`ARCH/14-AUDIT.md` §Failure modes, `DEC-022`).

use std::path::PathBuf;

use thiserror::Error;

/// A failure that stops an audited effect from being committed unrecorded.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum AuditError {
    /// The audit configuration is invalid. `sign: false` is one of these.
    #[error("invalid audit configuration: {0}")]
    Config(String),

    /// A filesystem operation failed.
    #[error("audit io error at {path}: {message}")]
    Io {
        /// The path the operation targeted.
        path: PathBuf,
        /// The underlying error.
        message: String,
    },

    /// Bounded-metadata or field-length limits were exceeded.
    #[error("audit entry field `{field}` exceeds its bound: {detail}")]
    FieldTooLarge {
        /// The offending field.
        field: &'static str,
        /// What was wrong.
        detail: String,
    },

    /// The effect class is not in the declared registry (`REQ-AUDIT-005`).
    #[error("unregistered audit effect class `{0}`; every recorded effect must be declared")]
    UnregisteredEffectClass(String),

    /// The redaction pass could not complete, so the entry is refused rather
    /// than chained with a possibly-secret payload.
    #[error("redaction refused the entry: {0}")]
    Redaction(String),

    /// The on-disk state disagrees with the recorded head pointer.
    #[error(
        "audit store state mismatch at segment {segment}: on-disk {disk_entries} entries \
         vs head {head_entries}; refusing to append into a diverged chain"
    )]
    StateMismatch {
        /// The segment index.
        segment: u32,
        /// How many entries the segment file holds.
        disk_entries: u64,
        /// How many entries the head pointer claims.
        head_entries: u64,
    },

    /// The device signing key is missing, unreadable, or not private.
    #[error("audit device key is unusable: {0}")]
    DeviceKey(String),

    /// A configured anchor sink cannot be reached. Fails closed.
    #[error("configured anchor sink `{path}` is unreachable: {reason}")]
    SinkUnreachable {
        /// The configured sink path.
        path: PathBuf,
        /// Why it is unreachable.
        reason: String,
    },

    /// A path that carries security meaning failed its ownership/mode check.
    #[error("refusing to use `{path}`: {reason}")]
    UnsafePath {
        /// The validated path.
        path: PathBuf,
        /// Why it was refused.
        reason: String,
    },

    /// The sink must be distinct from the audit store root.
    #[error(
        "anchor sink `{sink}` is inside the audit store root `{root}`; a local actor who can \
         rewrite the audit store could rewrite the anchor with it"
    )]
    SinkInsideAuditRoot {
        /// The configured sink.
        sink: PathBuf,
        /// The audit store root.
        root: PathBuf,
    },

    /// The declared configuration is understood but not implemented yet.
    #[error("audit feature `{0}` is declared but not implemented; refusing to downgrade silently")]
    Unsupported(String),

    /// The head pointer is present but cannot be trusted, so ordinary startup
    /// refuses rather than substituting a derived one
    /// (`REQ-AUDIT-011`, `DEC-044`).
    #[error(
        "audit head at {path} is {state}: {detail}; refusing to treat it as a new or empty store"
    )]
    HeadInvalid {
        /// The head path.
        path: PathBuf,
        /// `malformed` or `unreadable`.
        state: &'static str,
        /// The underlying cause.
        detail: String,
    },

    /// The head pointer is missing while the store holds entries, so the chain's
    /// last acknowledged position is unknown.
    #[error(
        "audit head at {path} is missing while the store holds {entries} entries; explicit recovery is required"
    )]
    HeadMissing {
        /// The head path.
        path: PathBuf,
        /// How many entries the segments hold.
        entries: u64,
    },

    /// A torn trailing write blocks appending until it is repaired explicitly.
    #[error(
        "audit segment(s) {segments:?} have an interrupted trailing write; run the explicit repair instead of appending"
    )]
    RecoveryRequired {
        /// The affected segment indices.
        segments: Vec<u32>,
    },

    /// Another process holds the writer lock, so this one must not allocate a
    /// sequence (`REQ-AUDIT-010`).
    #[error("audit store lock at {path} is held by another writer: {reason}")]
    StoreLocked {
        /// The lock path.
        path: PathBuf,
        /// Why the lock could not be taken.
        reason: String,
    },
}

impl AuditError {
    /// Wraps an I/O error with its path.
    #[must_use]
    pub fn io(path: impl Into<PathBuf>, error: &std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            message: error.to_string(),
        }
    }
}
