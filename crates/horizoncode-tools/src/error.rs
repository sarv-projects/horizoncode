//! Typed tool failures.
//!
//! A tool failure crossing into model output is always a short, typed,
//! actionable message, never a raw internal error (`ARCH/core/TOOLS.md`).

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

    /// The target changed between the approved base and the write, so the
    /// effect would have silently overwritten a concurrent change
    /// (`ARCH/core/TOOLS.md`, Mutations).
    #[error("conflict at {path}: {message}")]
    Conflict {
        /// The path involved.
        path: String,
        /// What the caller must do next.
        message: String,
    },

    /// A multi-file patch published one or more complete files before a later
    /// file failed. This is an in-process receipt, not a crash-recovery journal.
    #[error(
        "patch partially applied; committed=[{committed}], pending=[{pending}], failed={failed}: {cause}"
    )]
    PartialEffect {
        /// Per-file receipts for changes already published.
        committed: String,
        /// Files that were not published and still need reconciliation.
        pending: String,
        /// The file whose publication failed.
        failed: String,
        /// A bounded typed failure description.
        cause: String,
    },

    /// The tool failed while carrying out its work.
    #[error("tool execution failed: {0}")]
    Execute(String),

    /// The requested read target is not a regular file or directory.
    #[error("unsupported read target: {0} (regular files and directories only)")]
    UnsupportedTarget(String),

    /// A tool-specific byte limit was exceeded.
    #[error(
        "read output for {resource} exceeds the {limit_bytes}-byte limit (observed {observed_bytes} bytes)"
    )]
    OutputLimit {
        /// A workspace-relative or otherwise policy-safe resource label.
        resource: String,
        /// Maximum number of bytes permitted.
        limit_bytes: u64,
        /// Exact metadata size or number of bytes observed by the bounded reader.
        observed_bytes: u64,
    },

    /// A patch request or captured patch base exceeded its working-set bound.
    #[error("patch limit for {resource} exceeded ({observed_bytes} > {limit_bytes})")]
    PatchLimit {
        /// The patch input or base resource that exceeded the limit.
        resource: String,
        /// The configured maximum.
        limit_bytes: u64,
        /// The observed or lower-bound byte count.
        observed_bytes: u64,
    },

    /// A patch request exceeded a structural count limit.
    #[error("patch limit for {resource} exceeded ({observed} > {limit})")]
    PatchCountLimit {
        /// The bounded patch structure.
        resource: String,
        /// Maximum permitted count.
        limit: u64,
        /// Count observed before refusal.
        observed: u64,
    },

    /// A recursive search exceeded its bounded traversal or aggregate-input budget.
    #[error("search limit for {resource} exceeded ({observed} > {limit})")]
    SearchLimit {
        /// The bounded search resource.
        resource: String,
        /// The configured maximum.
        limit: u64,
        /// The first observed value beyond the maximum.
        observed: u64,
    },

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
            Self::Conflict { .. } => "TOOL_CONFLICT",
            Self::PartialEffect { .. } => "TOOL_PARTIAL_EFFECT",
            Self::Execute(_) => "TOOL_EXECUTE_ERROR",
            Self::UnsupportedTarget(_) => "TOOL_UNSUPPORTED_TARGET",
            Self::OutputLimit { .. } => "TOOL_OUTPUT_LIMIT",
            Self::PatchLimit { .. } => "TOOL_PATCH_LIMIT",
            Self::PatchCountLimit { .. } => "TOOL_PATCH_LIMIT",
            Self::SearchLimit { .. } => "TOOL_SEARCH_LIMIT",
            Self::Unavailable(_) => "TOOL_UNAVAILABLE",
        }
    }

    /// Returns the message shown to the model.
    #[must_use]
    pub fn model_message(&self) -> String {
        format!("{} (code {})", self, self.code())
    }
}
