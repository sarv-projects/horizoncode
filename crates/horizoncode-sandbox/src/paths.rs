//! Shared path-confinement helpers for the backends.

use std::path::{Component, Path, PathBuf};

use globset::{GlobBuilder, GlobMatcher};
use walkdir::WalkDir;

use crate::error::SandboxError;

/// The maximum deny-glob matches materialized before the profile fails closed.
pub(crate) const MAX_DENY_MATCHES: usize = 512;
/// The maximum directory depth scanned when materializing deny globs.
pub(crate) const MAX_DENY_DEPTH: usize = 12;

/// System directories a confined child needs in order to **execute** a program
/// at all: the program image, its shared libraries, and nothing else.
///
/// This is a declared, closed allowlist, not a prefix of the host. It is
/// deliberately narrow: a child's mount view contains the granted roots plus
/// this list, so `$HOME`, `/home`, `/root`, `/var`, `/srv` and every other host
/// location are simply absent and a read of them fails as "no such file" rather
/// than returning host content (`ARCH/13` §Data / state model, `REQ-SEC-025`).
/// Nothing here is operator data, and no entry can hold a credential: the
/// credential-bearing locations (`~/.ssh`, `/etc/shadow`, `/etc/ssh`, private PKI)
/// are outside the list.
pub const RUNTIME_BASE_DIRECTORIES: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32",
];

/// Individual `/etc` entries that are runtime support data: dynamic-linker
/// configuration, time zone data, terminfo, name-service switch, the host
/// resolver, and the public CA bundle needed when a profile is granted egress.
///
/// `/etc/passwd`, `/etc/shadow`, `/etc/gshadow`, `/etc/ssh` and `/etc/ssl/private`
/// are **not** in this list: they are account and credential material, not
/// support data, so they stay unreachable.
pub const RUNTIME_BASE_FILES: &[&str] = &[
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/alternatives",
    "/etc/terminfo",
    "/etc/nsswitch.conf",
    "/etc/localtime",
    "/etc/timezone",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/ssl/certs",
    "/etc/ssl/openssl.cnf",
];

/// Returns the runtime base directories that exist on this host.
#[must_use]
pub fn existing_runtime_base_directories() -> Vec<PathBuf> {
    RUNTIME_BASE_DIRECTORIES
        .iter()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .collect()
}

/// Returns the runtime base files that exist on this host.
#[must_use]
pub fn existing_runtime_base_files() -> Vec<PathBuf> {
    RUNTIME_BASE_FILES
        .iter()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .collect()
}

/// Lexically absolutizes and normalizes a path against a base.
pub(crate) fn absolute(path: &Path, base: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    lexical_normalize(&joined)
}

/// Lexically normalizes `.` and `..` without touching the filesystem.
pub(crate) fn lexical_normalize(path: &Path) -> PathBuf {
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

/// Returns whether `path` is equal to or under `root`, canonicalizing where
/// possible so symlinks cannot escape.
pub(crate) fn is_within(path: &Path, root: &Path) -> bool {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| lexical_normalize(root));
    let candidate = if let Ok(canonical) = std::fs::canonicalize(path) {
        canonical
    } else if let Some(parent) = path.parent()
        && let Ok(canonical_parent) = std::fs::canonicalize(parent)
    {
        canonical_parent.join(path.file_name().unwrap_or_default())
    } else {
        lexical_normalize(path)
    };
    candidate.starts_with(&root)
}

pub(crate) fn compile_globs(patterns: &[String]) -> Result<Vec<GlobMatcher>, SandboxError> {
    patterns
        .iter()
        .map(|pattern| {
            GlobBuilder::new(pattern)
                .literal_separator(true)
                .build()
                .map(|glob| glob.compile_matcher())
                .map_err(|error| {
                    SandboxError::failed(format!("invalid deny glob `{pattern}`: {error}"))
                })
        })
        .collect()
}

pub(crate) fn path_matches_deny(
    path: &Path,
    workspace: &Path,
    deny: &[String],
) -> Result<bool, SandboxError> {
    if deny.is_empty() {
        return Ok(false);
    }
    let globs = compile_globs(deny)?;
    let absolute = path.to_string_lossy();
    let relative = path
        .strip_prefix(workspace)
        .map(|relative| relative.to_string_lossy().into_owned())
        .unwrap_or_else(|_| absolute.clone().into_owned());
    Ok(globs
        .iter()
        .any(|glob| glob.is_match(absolute.as_ref()) || glob.is_match(relative.as_str())))
}

/// Expands deny globs under the writable roots into concrete paths to hide.
pub(crate) fn materialize_deny(
    roots: &[PathBuf],
    deny: &[String],
) -> Result<Vec<PathBuf>, SandboxError> {
    if deny.is_empty() {
        return Ok(Vec::new());
    }
    let globs = compile_globs(deny)?;
    let mut matches = Vec::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(root)
            .follow_links(false)
            .max_depth(MAX_DENY_DEPTH)
            .into_iter()
            .flatten()
        {
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map(|relative| relative.to_string_lossy().into_owned())
                .unwrap_or_default();
            let absolute = path.to_string_lossy();
            if globs
                .iter()
                .any(|glob| glob.is_match(relative.as_str()) || glob.is_match(absolute.as_ref()))
            {
                matches.push(path.to_path_buf());
                if matches.len() > MAX_DENY_MATCHES {
                    return Err(SandboxError::failed(format!(
                        "deny globs matched more than {MAX_DENY_MATCHES} paths; refusing to start"
                    )));
                }
            }
        }
    }
    matches.sort();
    matches.dedup();
    Ok(matches)
}
