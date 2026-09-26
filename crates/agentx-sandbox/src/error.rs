//! Typed sandbox failures (`ARCH/13-SANDBOX.md`).
//!
//! Sandbox is fail-closed: if the requested confinement cannot be established
//! the command must not run unconfined. Only an explicit `full-access` profile
//! runs bare.

use thiserror::Error;

/// A failure while resolving or applying confinement.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SandboxError {
    /// No backend on this platform can establish the requested confinement.
    #[error("sandbox unsupported: {backend}: {reason}")]
    Unsupported {
        /// The backend that was asked to confine the effect.
        backend: String,
        /// Why it cannot.
        reason: String,
    },

    /// A required backend binary or capability is missing.
    #[error("sandbox backend unavailable: {backend}: {reason}")]
    Unavailable {
        /// The backend.
        backend: String,
        /// Why it is unavailable.
        reason: String,
    },

    /// The confinement could not be applied to the requested effect.
    #[error("sandbox confinement failed: {reason}")]
    ConfinementFailed {
        /// A description of the failure.
        reason: String,
    },

    /// The effect was refused because it targeted a denied or protected path.
    #[error("sandbox violation: {reason}")]
    Violation {
        /// A description of the violation.
        reason: String,
    },

    /// An I/O or process failure.
    #[error("sandbox io error: {0}")]
    Io(String),
}

impl SandboxError {
    /// Builds an unsupported error.
    #[must_use]
    pub fn unsupported(backend: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Unsupported {
            backend: backend.into(),
            reason: reason.into(),
        }
    }

    /// Builds an unavailable error.
    #[must_use]
    pub fn unavailable(backend: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Unavailable {
            backend: backend.into(),
            reason: reason.into(),
        }
    }

    /// Builds a confinement-failed error.
    #[must_use]
    pub fn failed(reason: impl Into<String>) -> Self {
        Self::ConfinementFailed {
            reason: reason.into(),
        }
    }

    /// Builds a violation error.
    #[must_use]
    pub fn violation(reason: impl Into<String>) -> Self {
        Self::Violation {
            reason: reason.into(),
        }
    }

    /// Returns a stable, machine-readable error code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported { .. } => "SANDBOX_UNSUPPORTED",
            Self::Unavailable { .. } => "SANDBOX_UNAVAILABLE",
            Self::ConfinementFailed { .. } => "SANDBOX_CONFINEMENT_FAILED",
            Self::Violation { .. } => "SANDBOX_VIOLATION",
            Self::Io(_) => "SANDBOX_IO",
        }
    }
}
