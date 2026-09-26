//! Workspace-scoped path resolution (`REQ-SEC-003`, `ARCH/10-TOOLS.md`).
//!
//! Relative paths resolve within the active workspace. Absolute paths inside
//! the workspace are accepted. A path that escapes the workspace is refused
//! before any filesystem effect, after lexical normalization and — when the
//! target exists — canonicalization so symlinks cannot escape.

use std::path::{Component, Path, PathBuf};

use crate::error::ToolError;

/// Resolves `raw` against `workspace`, refusing escapes.
///
/// # Errors
/// Returns [`ToolError::InvalidInput`] for an empty path or one outside the
/// workspace, and [`ToolError::Io`] when the workspace cannot be resolved.
pub fn resolve_workspace_path(workspace: &Path, raw: &str) -> Result<PathBuf, ToolError> {
    if raw.trim().is_empty() {
        return Err(ToolError::InvalidInput("path must not be empty".to_owned()));
    }
    let workspace_abs = std::fs::canonicalize(workspace).map_err(|error| ToolError::Io {
        path: workspace.to_path_buf(),
        message: error.to_string(),
    })?;
    let candidate = Path::new(raw);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace_abs.join(candidate)
    };
    let normalized = lexical_normalize(&joined);
    if !normalized.starts_with(&workspace_abs) {
        return Err(ToolError::InvalidInput(format!(
            "path `{raw}` escapes the workspace `{}`",
            workspace_abs.display()
        )));
    }
    // If the target exists, canonicalize so a symlink cannot escape.
    if let Ok(canonical) = std::fs::canonicalize(&normalized) {
        if !canonical.starts_with(&workspace_abs) {
            return Err(ToolError::InvalidInput(format!(
                "path `{raw}` resolves outside the workspace"
            )));
        }
        return Ok(canonical);
    }
    Ok(normalized)
}

/// Lexically normalizes `.` and `..` without touching the filesystem.
#[must_use]
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_escape() {
        let dir = tempfile::tempdir().unwrap();
        let error = resolve_workspace_path(dir.path(), "../outside.txt").unwrap_err();
        assert_eq!(error.code(), "TOOL_INVALID_INPUT");
    }

    #[test]
    fn accepts_nested_and_absolute_inside() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("c.txt");
        std::fs::write(&file, "hi").unwrap();

        let relative = resolve_workspace_path(dir.path(), "a/b/c.txt").unwrap();
        assert_eq!(relative, std::fs::canonicalize(&file).unwrap());

        let absolute = resolve_workspace_path(dir.path(), file.to_str().unwrap()).unwrap();
        assert_eq!(absolute, std::fs::canonicalize(&file).unwrap());
    }

    #[test]
    fn normalizes_dot_segments() {
        let path = lexical_normalize(Path::new("/w/a/../b/./c"));
        assert_eq!(path, PathBuf::from("/w/b/c"));
    }
}
