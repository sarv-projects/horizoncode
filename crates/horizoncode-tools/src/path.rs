//! Workspace-scoped path resolution (`REQ-SEC-003`, `ARCH/10-TOOLS.md`).
//!
//! Relative paths resolve within the active workspace. Absolute paths inside
//! the workspace are accepted. A path that escapes the workspace is refused
//! before any filesystem effect.
//!
//! ## Why the whole target is not enough
//! Canonicalizing the target only helps when the target already exists. The
//! create case is the dangerous one: for `<workspace>/link/new.txt`, where
//! `link` is a symlink to a directory outside the workspace and `new.txt` does
//! not exist yet, `canonicalize` fails with `NotFound`, the lexical path is
//! inside the workspace, and the subsequent `create_dir_all` + `write` lands on
//! `<outside>/new.txt`. So the **parent chain** is resolved: the deepest
//! existing ancestor is canonicalized and the not-yet-existing tail is rejoined
//! to it, which is exactly the path the effect will touch (`REQ-SEC-004`,
//! `REQ-SEC-005`).
//!
//! ## Residual race
//! Resolution and the effect are not one syscall, so a symlink swapped in
//! between them is a residual window. It is narrowed, not removed: the
//! confinement layer re-checks the resolved path with its own canonicalizing
//! `check_path` immediately before the effect, and the kernel-facing tier
//! (`CMP-sandbox`) is the control this pre-check never claims to be.

use std::ffi::OsString;
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
    // Resolve through the parent chain, so a symlinked parent cannot redirect a
    // create out of the workspace.
    let resolved = resolve_through_existing(&normalized)?;
    if !resolved.starts_with(&workspace_abs) {
        return Err(ToolError::InvalidInput(format!(
            "path `{raw}` resolves outside the workspace `{}`",
            workspace_abs.display()
        )));
    }
    Ok(resolved)
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

/// Canonicalizes the deepest existing ancestor of `path` and rejoins the
/// components that do not exist yet.
///
/// Walking down one component at a time and stopping at the first ancestor that
/// resolves means every existing component — including a symlinked parent — is
/// replaced by what it actually points at, and only genuinely-absent names are
/// carried through unchanged. A symlink loop or any other canonicalization
/// failure is an error, never a best-effort fall-through.
fn resolve_through_existing(path: &Path) -> Result<PathBuf, ToolError> {
    let mut tail: Vec<OsString> = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        match std::fs::canonicalize(&current) {
            Ok(canonical) => {
                let mut out = canonical;
                for name in tail.iter().rev() {
                    out.push(name);
                }
                return Ok(out);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = current.file_name().map(OsString::from) else {
                    // No file name left to drop: the path does not exist at any
                    // level, so there is nothing to resolve.
                    return Ok(lexical_normalize(path));
                };
                tail.push(name);
                match current.parent() {
                    Some(parent) => current = parent.to_path_buf(),
                    None => return Ok(lexical_normalize(path)),
                }
            }
            Err(error) => {
                return Err(ToolError::Io {
                    path: current,
                    message: error.to_string(),
                });
            }
        }
    }
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

    #[test]
    fn a_symlinked_parent_cannot_carry_a_create_out_of_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        #[cfg(not(unix))]
        return;

        // The target does not exist, so a whole-target canonicalize would miss it.
        let error = resolve_workspace_path(dir.path(), "link/new.txt").unwrap_err();
        assert_eq!(error.code(), "TOOL_INVALID_INPUT", "{error}");
    }

    #[test]
    fn a_symlink_pointing_back_inside_the_workspace_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("real");
        std::fs::create_dir_all(&nested).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&nested, dir.path().join("alias")).unwrap();
        #[cfg(not(unix))]
        return;

        let resolved = resolve_workspace_path(dir.path(), "alias/new.txt").unwrap();
        assert!(resolved.starts_with(std::fs::canonicalize(dir.path()).unwrap()));
    }

    #[test]
    fn a_symlink_to_an_existing_outside_directory_is_refused_even_for_a_create() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), dir.path().join("dead")).unwrap();
        #[cfg(not(unix))]
        return;
        assert!(resolve_workspace_path(dir.path(), "dead/file.txt").is_err());
    }

    #[test]
    fn a_dangling_symlink_is_treated_as_the_name_it_spells() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/nonexistent-target-xyz", dir.path().join("dead")).unwrap();
        #[cfg(not(unix))]
        return;
        // A symlink with no target names a path that does not exist, so there is
        // nothing outside the workspace to reach: it resolves to a plain in-workspace
        // name. Creating through it then fails at the filesystem, because the
        // parent cannot be created under an existing dangling link.
        let resolved = resolve_workspace_path(dir.path(), "dead/file.txt").unwrap();
        assert!(resolved.starts_with(std::fs::canonicalize(dir.path()).unwrap()));
        assert!(
            std::fs::create_dir_all(resolved.parent().unwrap()).is_err(),
            "a dangling symlink parent must not be created through"
        );
    }
}
