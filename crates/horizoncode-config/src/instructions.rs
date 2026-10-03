//! Hierarchical `AGENTS.md` discovery (`ARCH/09-CONTEXT.md` §6,
//! `REQ-CTX-005`).
//!
//! The order is fixed: the global file first (`<state-root>/AGENTS.md`), then
//! each project instruction file from the project root down to the working
//! directory, outermost to nearest. Duplicates are dropped twice over — by
//! canonical path so one file reached through two spellings loads once, and by
//! content digest so identical text is not injected twice.
//!
//! The project root is the nearest ancestor containing valid `.git` metadata or
//! a non-symlink `.horizoncode` directory; uncheckable existing markers form a
//! conservative boundary. Invalid Git markers do not stop the walk. With no
//! marker the working directory is its own project root, so a plain directory
//! tree cannot leak files from above it.
//!
//! A discovered file that exists but cannot be read is a typed error, never a
//! silent omission: the architecture blocks initialization in that case, and a
//! missing file is simply absent.
//!
//! Instruction content is **untrusted data** (`ARCH/18` §Failure modes): this
//! module reads and renders it; it never executes, and nothing here grants
//! authority.

use std::collections::HashSet;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

use crate::discovery::{ConfigLayer, PROJECT_CONFIG_DIR, state_root};

/// The instruction file name.
pub const INSTRUCTION_FILE: &str = "AGENTS.md";
const MAX_GITDIR_POINTER_BYTES: u64 = 8_192;
const MAX_GIT_HEAD_BYTES: u64 = 65_536;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MarkerStatus {
    Valid,
    Invalid,
    Uncheckable,
}

/// Which scope an instruction file belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstructionScope {
    /// The user's global file.
    Global,
    /// A project file found on the walk.
    Project,
}

impl InstructionScope {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }

    /// Maps a discovered configuration layer to its instruction scope.
    #[must_use]
    pub fn from_layer(layer: ConfigLayer) -> Self {
        match layer {
            ConfigLayer::Global => Self::Global,
            ConfigLayer::Project => Self::Project,
        }
    }
}

/// One instruction file, ready to be rendered as a typed context source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstructionSource {
    /// The canonical absolute path.
    pub path: PathBuf,
    /// Which scope it came from.
    pub scope: InstructionScope,
    /// `blake3` over the file content.
    pub digest: String,
    /// The file content, verbatim.
    pub content: String,
}

/// A discovered instruction file that cannot be used.
#[derive(Debug, thiserror::Error)]
pub enum InstructionsError {
    /// The file exists but cannot be read as UTF-8 text.
    #[error("instruction file {} cannot be read: {detail}", path.display())]
    Unreadable {
        /// The file that could not be read.
        path: PathBuf,
        /// The underlying failure.
        detail: String,
    },
}

/// Discovers the instruction files for `cwd` with [`state_root`] as the global
/// directory.
///
/// # Errors
/// Returns [`InstructionsError::Unreadable`] when a discovered file exists but
/// cannot be read; initialization is meant to block in that case rather than
/// proceed with a partial instruction set.
pub fn discover_instructions(cwd: &Path) -> Result<Vec<InstructionSource>, InstructionsError> {
    discover_instructions_with(cwd, &state_root())
}

/// [`discover_instructions`] with an explicit global directory.
///
/// # Errors
/// As [`discover_instructions`].
pub fn discover_instructions_with(
    cwd: &Path,
    global_dir: &Path,
) -> Result<Vec<InstructionSource>, InstructionsError> {
    let cwd = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let mut sources = Vec::new();
    if let Some(source) =
        read_if_present(&global_dir.join(INSTRUCTION_FILE), InstructionScope::Global)?
    {
        sources.push(source);
    }
    let root = project_root(&cwd);
    for dir in walk_dirs(&root, &cwd) {
        if let Some(source) =
            read_if_present(&dir.join(INSTRUCTION_FILE), InstructionScope::Project)?
        {
            sources.push(source);
        }
    }
    dedupe(&mut sources);
    Ok(sources)
}

/// Reads one instruction file that must exist, for `instructions.extra`
/// references.
///
/// # Errors
/// Returns [`InstructionsError::Unreadable`] when the file cannot be read.
pub fn read_instruction(
    path: &Path,
    scope: InstructionScope,
) -> Result<InstructionSource, InstructionsError> {
    read_required(path, scope)
}

/// Renders discovered instructions as one text source, each named by its
/// absolute path and joined by a blank line, exactly as `ARCH/09` §6 requires.
#[must_use]
pub fn render_instructions(sources: &[InstructionSource]) -> String {
    sources
        .iter()
        .map(|source| {
            format!(
                "Instructions from: {}\n{}",
                source.path.display(),
                source.content.trim_end_matches(['\n', '\r'])
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn read_if_present(
    path: &Path,
    scope: InstructionScope,
) -> Result<Option<InstructionSource>, InstructionsError> {
    match crate::state_fs::classify(path) {
        Ok(crate::state_fs::PathEntry::Missing) => Ok(None),
        Ok(crate::state_fs::PathEntry::Symlink) => Err(InstructionsError::Unreadable {
            path: path.to_path_buf(),
            detail: "is a symlink; an instruction file is never followed".to_owned(),
        }),
        Ok(_) => read_required(path, scope).map(Some),
        Err(error) => Err(InstructionsError::Unreadable {
            path: path.to_path_buf(),
            detail: error.to_string(),
        }),
    }
}

fn read_required(
    path: &Path,
    scope: InstructionScope,
) -> Result<InstructionSource, InstructionsError> {
    // A repository can plant `AGENTS.md` as a link to a file outside the
    // workspace; following it would pull that file into the model's context.
    crate::state_fs::refuse_symlink(path).map_err(|error| InstructionsError::Unreadable {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    let content = fs::read_to_string(path).map_err(|error| InstructionsError::Unreadable {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    Ok(InstructionSource {
        digest: blake3::hash(content.as_bytes()).to_hex().to_string(),
        path: canonical,
        scope,
        content,
    })
}

/// The project root for a working directory: the nearest ancestor carrying a
/// valid Git metadata marker or a `.horizoncode` directory; with no marker, the
/// working directory itself. An existing marker that cannot be checked forms a
/// conservative boundary to avoid loading parent instructions.
///
/// This is the boundary both instruction and skill discovery stop at, so a
/// parent directory cannot contribute context to an unrelated project.
#[must_use]
pub fn project_root_for(cwd: &Path) -> PathBuf {
    let mut walk = Some(cwd);
    while let Some(dir) = walk {
        let git_status = git_marker_status(&dir.join(".git"));
        let project_status = directory_marker_status(&dir.join(PROJECT_CONFIG_DIR));
        if matches!(git_status, MarkerStatus::Valid | MarkerStatus::Uncheckable)
            || matches!(
                project_status,
                MarkerStatus::Valid | MarkerStatus::Uncheckable
            )
        {
            return dir.to_path_buf();
        }
        walk = dir.parent();
    }
    cwd.to_path_buf()
}

fn directory_marker_status(path: &Path) -> MarkerStatus {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => MarkerStatus::Invalid,
        Ok(metadata) if metadata.is_dir() => MarkerStatus::Valid,
        Ok(_) => MarkerStatus::Invalid,
        Err(error) if error.kind() == ErrorKind::NotFound => MarkerStatus::Invalid,
        Err(_) => MarkerStatus::Uncheckable,
    }
}

fn git_marker_status(path: &Path) -> MarkerStatus {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => return status_from_marker_io_error(&error),
    };
    if metadata.file_type().is_symlink() {
        return MarkerStatus::Invalid;
    }
    if metadata.is_dir() {
        return git_directory_status(path);
    }
    if !metadata.is_file() {
        return MarkerStatus::Invalid;
    }
    if metadata.len() > MAX_GITDIR_POINTER_BYTES {
        return MarkerStatus::Invalid;
    }

    let contents = match read_bounded_text(path, MAX_GITDIR_POINTER_BYTES) {
        Ok(Some(contents)) => contents,
        Ok(None) => return MarkerStatus::Invalid,
        Err(error) => return status_from_marker_io_error(&error),
    };
    let Some(line) = one_line(&contents) else {
        return MarkerStatus::Invalid;
    };
    let Some(target) = line.strip_prefix("gitdir: ") else {
        return MarkerStatus::Invalid;
    };
    if target.is_empty() || target.contains('\0') || target.contains('\n') || target.contains('\r')
    {
        return MarkerStatus::Invalid;
    }
    let target = Path::new(target);
    let target = if target.is_absolute() {
        target.to_path_buf()
    } else {
        path.parent().unwrap_or_else(|| Path::new(".")).join(target)
    };
    git_directory_status(&target)
}

fn git_directory_status(path: &Path) -> MarkerStatus {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => return status_from_marker_io_error(&error),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return MarkerStatus::Invalid;
    }

    let head_path = path.join("HEAD");
    let metadata = match fs::symlink_metadata(&head_path) {
        Ok(metadata) => metadata,
        Err(error) => return status_from_marker_io_error(&error),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_GIT_HEAD_BYTES
    {
        return MarkerStatus::Invalid;
    }
    let head = match read_bounded_text(&head_path, MAX_GIT_HEAD_BYTES) {
        Ok(Some(head)) => head,
        Ok(None) => return MarkerStatus::Invalid,
        Err(error) => return status_from_marker_io_error(&error),
    };
    let Some(line) = one_line(&head) else {
        return MarkerStatus::Invalid;
    };
    let valid_ref = line
        .strip_prefix("ref: ")
        .is_some_and(is_valid_symbolic_ref);
    let valid_oid =
        (line.len() == 40 || line.len() == 64) && line.bytes().all(|byte| byte.is_ascii_hexdigit());
    if valid_ref || valid_oid {
        MarkerStatus::Valid
    } else {
        MarkerStatus::Invalid
    }
}

fn status_from_marker_io_error(error: &std::io::Error) -> MarkerStatus {
    match error.kind() {
        ErrorKind::NotFound | ErrorKind::InvalidData => MarkerStatus::Invalid,
        _ => MarkerStatus::Uncheckable,
    }
}

fn is_valid_symbolic_ref(reference: &str) -> bool {
    let Some(reference) = reference.strip_prefix("refs/") else {
        return false;
    };
    if reference.is_empty()
        || reference.ends_with('.')
        || reference.contains("..")
        || reference.contains("@{")
        || reference.contains("//")
        || reference.bytes().any(|byte| {
            byte.is_ascii_control()
                || matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
    {
        return false;
    }
    reference.split('/').all(|component| {
        !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
    })
}

fn read_bounded_text(path: &Path, limit: u64) -> std::io::Result<Option<String>> {
    let file = fs::File::open(path)?;
    let mut contents = String::new();
    let bytes_read = file.take(limit + 1).read_to_string(&mut contents)?;
    if bytes_read as u64 > limit {
        return Ok(None);
    }
    Ok(Some(contents))
}

fn one_line(contents: &str) -> Option<&str> {
    let line = contents
        .strip_suffix("\r\n")
        .or_else(|| contents.strip_suffix('\n'))
        .unwrap_or(contents);
    if line.is_empty() || line.contains('\n') || line.contains('\r') {
        None
    } else {
        Some(line)
    }
}

fn project_root(cwd: &Path) -> PathBuf {
    project_root_for(cwd)
}

fn walk_dirs(root: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut walk = Some(cwd);
    while let Some(dir) = walk {
        dirs.push(dir.to_path_buf());
        if dir == root {
            break;
        }
        walk = dir.parent();
    }
    dirs.reverse();
    dirs
}

fn dedupe(sources: &mut Vec<InstructionSource>) {
    let mut paths = HashSet::new();
    let mut digests = HashSet::new();
    sources.retain(|source| {
        paths.insert(source.path.clone()) && digests.insert(source.digest.clone())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_io_failures_are_conservative_except_absence_and_invalid_text() {
        assert_eq!(
            status_from_marker_io_error(&std::io::Error::from(ErrorKind::PermissionDenied)),
            MarkerStatus::Uncheckable
        );
        assert_eq!(
            status_from_marker_io_error(&std::io::Error::from(ErrorKind::NotFound)),
            MarkerStatus::Invalid
        );
        assert_eq!(
            status_from_marker_io_error(&std::io::Error::from(ErrorKind::InvalidData)),
            MarkerStatus::Invalid
        );
    }

    #[test]
    fn symbolic_ref_validation_rejects_git_forbidden_forms() {
        for reference in [
            "refs/../main",
            "refs/heads/a..b",
            "refs/heads/foo.lock",
            "refs/heads/foo/",
            "refs/heads//foo",
            "refs/heads/.hidden",
            "refs/heads/@{x",
            "refs/heads/has space",
        ] {
            assert!(!is_valid_symbolic_ref(reference), "{reference}");
        }
        assert!(is_valid_symbolic_ref("refs/heads/main"));
        assert!(is_valid_symbolic_ref("refs/heads/foo./bar"));
        assert!(!is_valid_symbolic_ref("refs/heads/foo."));
        assert!(is_valid_symbolic_ref(&format!(
            "refs/heads/{}",
            "a".repeat(256)
        )));
    }
}
