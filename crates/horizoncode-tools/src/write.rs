//! The shared governed-write path (`ARCH/10` §Mutations).
//!
//! `write` and `edit` use [`write_with_base_check`] to re-read the target, compare
//! it against the approved base, and write only when the file is still what it
//! was. `apply_patch` uses a separate all-file preflight and staged per-file
//! publication path in `builtin::patch`. A changed file yields a typed
//! [`ToolError::Conflict`] instead of silently overwriting a concurrent change.
//!
//! The digest is a real one — the audit chain's `blake3` — because a base pin is
//! a value the model quotes back to the tool, and a colliding non-cryptographic
//! fingerprint would let a stale base look current.

use std::path::Path;

use crate::error::ToolError;

/// Returns the content digest a base pin is compared against.
#[must_use]
pub fn file_digest(bytes: &[u8]) -> String {
    horizoncode_audit::digest(bytes)
}

/// Returns whether a caller-supplied pin matches `base`.
///
/// A missing pin is accepted: the tool still compares against the base it read
/// itself, so a concurrent change is caught either way. A *present* pin that
/// does not match means the caller's view is stale, which is a typed conflict.
///
/// # Errors
/// Returns [`ToolError::InvalidInput`] when `expected` is not a hex digest.
pub fn check_base_pin(expected: Option<&str>, path: &Path, base: &[u8]) -> Result<(), ToolError> {
    let Some(expected) = expected.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if expected.len() % 2 != 0 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ToolError::InvalidInput(
            "`expectedBaseHash` must be a hex digest".to_owned(),
        ));
    }
    if expected.eq_ignore_ascii_case(&file_digest(base)) {
        return Ok(());
    }
    Err(conflict(
        path,
        base,
        &std::fs::read(path).unwrap_or_default(),
        "the file no longer matches `expectedBaseHash`",
    ))
}

/// Re-reads `path` and writes `content` only if it still matches `base`.
///
/// # Errors
/// Returns [`ToolError::Conflict`] when the target changed since the base was
/// read, and [`ToolError::Io`] on a read or write failure.
pub fn write_with_base_check(path: &Path, base: &[u8], content: &[u8]) -> Result<(), ToolError> {
    let current = std::fs::read(path).unwrap_or_default();
    if current != base {
        return Err(conflict(
            path,
            base,
            &current,
            "it changed between being read and being written",
        ));
    }
    std::fs::write(path, content).map_err(|error| ToolError::Io {
        path: path.to_path_buf(),
        message: error.to_string(),
    })
}

/// Builds the typed conflict a caller re-reads and retries from.
fn conflict(path: &Path, base: &[u8], current: &[u8], why: &str) -> ToolError {
    ToolError::Conflict {
        path: path.to_string_lossy().into_owned(),
        message: format!(
            "{why}: base {}, on disk {}. Re-read the file, then retry; to overwrite \
             deliberately, pin `expectedBaseHash` to the on-disk digest.",
            file_digest(base),
            file_digest(current)
        ),
    }
}
