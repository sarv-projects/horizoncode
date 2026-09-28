//! Hierarchical `AGENTS.md` discovery (`ARCH/09-CONTEXT.md` §6,
//! `REQ-CTX-005`).
//!
//! The order is fixed: the global file first (`<state-root>/AGENTS.md`), then
//! each project instruction file from the project root down to the working
//! directory, outermost to nearest. Duplicates are dropped twice over — by
//! canonical path so one file reached through two spellings loads once, and by
//! content digest so identical text is not injected twice.
//!
//! The project root is the nearest ancestor containing `.git` (a directory in a
//! normal checkout, a file in a worktree) or `.horizoncode`; instructions above
//! it are never read. With no such marker the working directory is its own
//! project root, so a plain directory tree cannot leak files from above it.
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
use std::path::{Path, PathBuf};

use crate::discovery::{ConfigLayer, PROJECT_CONFIG_DIR, state_root};

/// The instruction file name.
pub const INSTRUCTION_FILE: &str = "AGENTS.md";

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

fn project_root(cwd: &Path) -> PathBuf {
    let mut walk = Some(cwd);
    while let Some(dir) = walk {
        if dir.join(".git").exists() || dir.join(PROJECT_CONFIG_DIR).is_dir() {
            return dir.to_path_buf();
        }
        walk = dir.parent();
    }
    cwd.to_path_buf()
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
