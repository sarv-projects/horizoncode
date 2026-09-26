//! Typed tool failures.
//!
//! A tool failure crossing into model output is always a short, typed,
//! actionable message, never a raw internal error (`ARCH/10-TOOLS.md`).

use std::path::PathBuf;

use thiserror::Error;

/// A failure produced while executing a tool.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ToolError {
    /// The model supplied input that does not match the tool's schema.
    #[error("invalid tool input: {0}")]
    InvalidInput(String),

    /// The requested path or resource does not exist.
    #[error("not found: {0}")]
    NotFound(String),

    /// Policy denied the call.
    #[error("permission denied: {0}")]
    Denied(String),

    /// A filesystem operation failed.
    #[error("io error at {path}: {message}")]
    Io {
        /// The path involved.
        path: PathBuf,
        /// A description of the failure.
        message: String,
    },

    /// The call was aborted by interruption.
    #[error("aborted: {0}")]
    Aborted(String),

    /// The tool failed while carrying out its work.
    #[error("tool execution failed: {0}")]
    Execute(String),

    /// The tool is unavailable in this run mode (for example a question in a
    /// non-interactive run).
    #[error("tool unavailable: {0}")]
    Unavailable(String),
}

impl ToolError {
    /// Returns a stable, machine-readable error code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "TOOL_INVALID_INPUT",
            Self::NotFound(_) => "TOOL_NOT_FOUND",
            Self::Denied(_) => "TOOL_DENIED",
            Self::Io { .. } => "TOOL_IO_ERROR",
            Self::Aborted(_) => "TOOL_ABORTED",
            Self::Execute(_) => "TOOL_EXECUTE_ERROR",
            Self::Unavailable(_) => "TOOL_UNAVAILABLE",
        }
    }

    /// Returns the message shown to the model.
    #[must_use]
    pub fn model_message(&self) -> String {
        format!("{} (code {})", self, self.code())
    }
}
