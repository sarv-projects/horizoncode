//! Typed ACP surface errors.

use agentx_session::SessionError;
use thiserror::Error;

/// A failure in the ACP surface.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum AcpError {
    /// The protocol connection failed.
    #[error("acp protocol error: {0}")]
    Protocol(String),

    /// The session store failed while creating or loading a session.
    #[error(transparent)]
    Session(#[from] SessionError),

    /// An option was invalid.
    #[error("invalid acp option: {0}")]
    Invalid(String),
}
