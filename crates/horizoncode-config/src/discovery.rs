//! Layer discovery: the one place that answers *where does state live and which
//! config files apply?* (`ARCH/18` §Discovery walk).
//!
//! The global layer is `<state-root>/config.jsonc`, where `<state-root>` is
//! `$HORIZONCODE_HOME` when set, otherwise `~/.horizoncode`. The project walk
//! collects `<dir>/.horizoncode/config.jsonc` for every ancestor of the working
//! directory, outermost first, so the nearest file is applied last and wins
//! per key. Session, audit, analytics, and the CLI resolve their roots from
//! [`state_root`] too, so there is one layout rather than four copies of the
//! environment logic.
//!
//! Discovery reports what it saw; it never decides whether a file is *valid*.
//! A path that exists but is unusable becomes a [`DiscoveryIssue`] instead of
//! silently disappearing, because "the layer was not found" and "the layer
//! could not be read" must not look the same (`F-50`'s lesson, applied at
//! configuration scope).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::state_fs::PathEntry;

/// The project configuration directory name used during the walk.
pub const PROJECT_CONFIG_DIR: &str = ".horizoncode";

/// The main configuration file name.
pub const CONFIG_FILE: &str = "config.jsonc";

/// Returns the per-user state root.
///
/// `$HORIZONCODE_HOME` when it is set and non-empty; otherwise
/// `~/.horizoncode`; otherwise the current directory (a last resort for an
/// environment with no resolvable home, so the tool still runs somewhere
/// private to its working directory rather than writing to `/`).
#[must_use]
pub fn state_root() -> PathBuf {
    state_root_from(std::env::var_os("HORIZONCODE_HOME"), home_dir())
}

/// Returns the operating system's home directory when one is available.
///
/// The standard-library resolver uses `HOME`/the user database on Unix and
/// `USERPROFILE`/the native profile API on Windows. Its Windows handling was
/// corrected in Rust 1.85, which is below this workspace's Rust 1.89 minimum.
#[must_use]
pub fn home_dir() -> Option<PathBuf> {
    // Rust 1.89 still marks this long-standing API deprecated. The deprecation
    // is removed in newer toolchains; its documented platform behavior is the
    // cross-platform resolver required by the existing path contract.
    #[allow(deprecated)]
    let home = std::env::home_dir();
    home.filter(|path| !path.as_os_str().is_empty())
}

/// The pure resolution behind [`state_root`], so every branch is testable
/// without mutating the process environment.
fn state_root_from(env: Option<OsString>, home: Option<PathBuf>) -> PathBuf {
    env.filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".horizoncode")))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Returns the global config file path: `<state-root>/config.jsonc`.
#[must_use]
pub fn global_config_path() -> PathBuf {
    state_root().join(CONFIG_FILE)
}

/// Returns the project config paths for `workspace`, outer to nearest.
///
/// Only existing regular files are returned; the workspace's own file is last
/// so that a nearer layer wins. Callers that need to distinguish "absent" from
/// "unreadable" should use [`discover`], which reports issues.
#[must_use]
pub fn project_config_paths(workspace: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut walk = Some(workspace);
    while let Some(dir) = walk {
        let candidate = dir.join(PROJECT_CONFIG_DIR).join(CONFIG_FILE);
        if candidate.is_file() {
            found.push(candidate);
        }
        walk = dir.parent();
    }
    found.reverse();
    found
}

/// Which layer a source belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ConfigLayer {
    /// The user's global layer.
    Global,
    /// A project layer found on the ancestor walk.
    Project,
}

impl ConfigLayer {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }
}

/// One configuration file that should be applied, in application order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigSource {
    /// The layer the file belongs to.
    pub layer: ConfigLayer,
    /// The layer root that relative paths in this file resolve against: the
    /// state root for the global layer, or the directory that contains
    /// `.horizoncode` for a project layer. A project file therefore writes
    /// `docs/team.md`, not `.horizoncode/docs/team.md`.
    pub root: PathBuf,
    /// The file path.
    pub path: PathBuf,
}

/// A path that exists but cannot be used as a layer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryIssue {
    /// The unusable path.
    pub path: PathBuf,
    /// What is wrong with it.
    pub detail: String,
}

/// The ordered result of a discovery walk.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Discovery {
    /// Sources in application order: global first, then outer to nearest.
    pub sources: Vec<ConfigSource>,
    /// Paths that matched a layer location but are not usable files.
    pub issues: Vec<DiscoveryIssue>,
}

/// Discovers the layers that apply to `cwd` using [`state_root`] as the global
/// layer. Missing files are absent, not issues.
#[must_use]
pub fn discover(cwd: &Path) -> Discovery {
    discover_with(cwd, Some(&state_root()))
}

/// [`discover`] with an explicit global directory, for tests and for callers
/// that resolve the state root themselves.
#[must_use]
pub fn discover_with(cwd: &Path, global_dir: Option<&Path>) -> Discovery {
    let mut sources = Vec::new();
    let mut issues = Vec::new();
    if let Some(dir) = global_dir {
        let path = dir.join(CONFIG_FILE);
        if classify(&path, &mut issues) {
            sources.push(ConfigSource {
                layer: ConfigLayer::Global,
                root: dir.to_path_buf(),
                path,
            });
        }
    }
    let mut project = Vec::new();
    let mut walk = Some(cwd);
    while let Some(dir) = walk {
        let path = dir.join(PROJECT_CONFIG_DIR).join(CONFIG_FILE);
        if classify(&path, &mut issues) {
            project.push((dir.to_path_buf(), path));
        }
        walk = dir.parent();
    }
    project.reverse();
    sources.extend(project.into_iter().map(|(root, path)| ConfigSource {
        layer: ConfigLayer::Project,
        root,
        path,
    }));
    Discovery { sources, issues }
}

/// Returns whether `path` is a usable layer file, recording why not otherwise.
///
/// A symlinked layer is **not followed** (`ARCH/22` `F-02`/`L-06`): it is
/// reported and skipped, so a link planted in a repository cannot redirect the
/// user's configuration read to another file.
fn classify(path: &Path, issues: &mut Vec<DiscoveryIssue>) -> bool {
    match crate::state_fs::classify(path) {
        Ok(PathEntry::File) => true,
        Ok(PathEntry::Missing) => false,
        Ok(PathEntry::Symlink) => {
            issues.push(DiscoveryIssue {
                path: path.to_path_buf(),
                detail: "is a symlink; a config layer is never followed".to_owned(),
            });
            false
        }
        Ok(_) => {
            issues.push(DiscoveryIssue {
                path: path.to_path_buf(),
                detail: "exists but is not a regular file".to_owned(),
            });
            false
        }
        Err(error) => {
            issues.push(DiscoveryIssue {
                path: path.to_path_buf(),
                detail: format!("cannot be inspected: {error}"),
            });
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_root_prefers_the_environment_over_the_home_fallback() {
        assert_eq!(
            state_root_from(Some(OsString::from("/tmp/env-home")), None),
            PathBuf::from("/tmp/env-home")
        );
        assert_eq!(
            state_root_from(
                Some(OsString::from("/tmp/env-home")),
                Some(PathBuf::from("/home/u"))
            ),
            PathBuf::from("/tmp/env-home")
        );
    }

    #[test]
    fn the_home_fallback_lands_in_dot_horizoncode_not_the_home_directory() {
        // The documented layout is `~/.horizoncode`; resolving state directly
        // into `~` would scatter `sessions/`, `audit/`, and `analytics/`
        // through the user's home.
        assert_eq!(
            state_root_from(None, Some(PathBuf::from("/home/u"))),
            PathBuf::from("/home/u/.horizoncode")
        );
        assert_eq!(
            state_root_from(Some(OsString::new()), Some(PathBuf::from("/home/u"))),
            PathBuf::from("/home/u/.horizoncode")
        );
    }

    #[test]
    fn the_state_root_has_a_last_resort_with_no_home() {
        assert_eq!(state_root_from(None, None), PathBuf::from("."));
    }

    #[test]
    fn the_platform_home_resolver_never_returns_an_empty_path() {
        assert!(home_dir().is_none_or(|path| !path.as_os_str().is_empty()));
    }
}
