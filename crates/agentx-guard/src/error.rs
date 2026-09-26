//! Typed guard failures (`ARCH/12-GUARD.md`).
//!
//! Guard is fail-closed: a rule/config error never becomes a silent allow.

use thiserror::Error;

/// A failure while loading or evaluating policy.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum GuardError {
    /// A config layer could not be read.
    #[error("cannot read guard config {path}: {message}")]
    Io {
        /// The path involved.
        path: String,
        /// A description of the failure.
        message: String,
    },

    /// A config layer was malformed; the layer is rejected fail-closed.
    #[error("invalid guard config {path}: {message}")]
    Config {
        /// The path involved.
        path: String,
        /// A description of the failure.
        message: String,
    },

    /// A rule pattern was malformed.
    #[error("invalid pattern `{pattern}`: {message}")]
    Pattern {
        /// The offending pattern.
        pattern: String,
        /// A description of the failure.
        message: String,
    },

    /// A ticket was unknown, expired, revoked, out of scope or exhausted.
    #[error("invalid ticket: {0}")]
    InvalidTicket(String),

    /// A saved rule could not be persisted.
    #[error("cannot persist saved rule: {0}")]
    Persist(String),
}

impl GuardError {
    /// Builds an I/O error.
    #[must_use]
    pub fn io(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Io {
            path: path.into(),
            message: message.into(),
        }
    }

    /// Builds a config error.
    #[must_use]
    pub fn config(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Config {
            path: path.into(),
            message: message.into(),
        }
    }

    /// Builds a pattern error.
    #[must_use]
    pub fn pattern(pattern: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Pattern {
            pattern: pattern.into(),
            message: message.into(),
        }
    }

    /// Returns a stable, machine-readable error code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io { .. } => "GUARD_IO",
            Self::Config { .. } => "GUARD_CONFIG",
            Self::Pattern { .. } => "GUARD_PATTERN",
            Self::InvalidTicket(_) => "GUARD_TICKET",
            Self::Persist(_) => "GUARD_PERSIST",
        }
    }
}
