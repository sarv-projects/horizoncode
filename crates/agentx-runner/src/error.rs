//! Typed loop failures.
//!
//! A turn's *outcome* (completed/failed/interrupted/declined/partial) is data,
//! not an error. These errors are reserved for infrastructure failures such as
//! a session that cannot be read or appended.

use agentx_session::SessionError;
use thiserror::Error;

/// A failure that prevents the loop from running a turn at all.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum LoopError {
    /// The session store failed.
    #[error(transparent)]
    Session(#[from] SessionError),

    /// The session is closed and refuses admission.
    #[error("session is closed: {0}")]
    Closed(agentx_types::SessionId),

    /// The configured model is missing or empty.
    #[error("invalid run configuration: {0}")]
    Config(String),
}
