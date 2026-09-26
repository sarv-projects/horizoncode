//! Confinement profiles and their defaults (`ARCH/13-SANDBOX.md`).

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The filesystem confinement level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsProfile {
    /// Scoped read; writes only to session state and temp.
    ReadOnly,
    /// Scoped read; writes to the workspace, session state and temp (default).
    WorkspaceWrite,
    /// No filesystem restriction; still subject to Guard and the catastrophic
    /// gate. This is the only profile that runs bare.
    FullAccess,
}

impl FsProfile {
    /// Parses a profile name.
    ///
    /// # Errors
    /// Returns `None` for an unknown name so the caller fails closed.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "read-only" | "read_only" | "readonly" => Some(Self::ReadOnly),
            "workspace-write" | "workspace_write" | "workspace" => Some(Self::WorkspaceWrite),
            "full-access" | "full_access" | "full" => Some(Self::FullAccess),
            _ => None,
        }
    }

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::FullAccess => "full-access",
        }
    }
}

/// The outbound network policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NetworkPolicy {
    /// No usable outbound network (default).
    None,
    /// A specific `host:port` allowlist. The local backend cannot enforce a
    /// per-host allowlist with mount/namespace primitives alone and returns a
    /// typed `Unsupported` rather than silently opening the network.
    Allowlist(Vec<String>),
    /// Full outbound network. Only valid with `full-access` or an explicit,
    /// audited opt-in.
    Full,
}

impl NetworkPolicy {
    /// Returns the stable name.
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Allowlist(_) => "allowlist",
            Self::Full => "full",
        }
    }
}

/// Resource limits applied to a spawned command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Wall-clock ceiling in milliseconds; `None` disables the watchdog.
    pub wall_clock_ms: Option<u64>,
    /// Maximum captured stdout/stderr bytes retained.
    pub max_output_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            wall_clock_ms: Some(120_000),
            max_output_bytes: 5 * 1024 * 1024,
        }
    }
}

impl Limits {
    /// Returns the wall-clock ceiling as a duration.
    #[must_use]
    pub fn wall_clock(&self) -> Option<Duration> {
        self.wall_clock_ms.map(Duration::from_millis)
    }
}

/// A requested confinement profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfinementProfile {
    /// The filesystem level.
    pub profile: FsProfile,
    /// The workspace root.
    pub workspace: PathBuf,
    /// Additional writable roots beyond the workspace.
    pub writable_roots: Vec<PathBuf>,
    /// Paths that stay read-only inside a writable root.
    pub protected: Vec<PathBuf>,
    /// Kernel-enforced read+write denial globs (workspace-relative or absolute).
    pub deny: Vec<String>,
    /// The network policy.
    pub network: NetworkPolicy,
    /// Session-scoped writable state (temp) directory.
    pub session_dir: Option<PathBuf>,
    /// Resource limits.
    pub limits: Limits,
}

impl ConfinementProfile {
    /// Builds a `workspace-write`, network-off profile for a workspace.
    #[must_use]
    pub fn workspace_write(workspace: impl Into<PathBuf>) -> Self {
        let workspace = workspace.into();
        Self {
            profile: FsProfile::WorkspaceWrite,
            protected: default_protected(&workspace),
            workspace,
            writable_roots: Vec::new(),
            deny: Vec::new(),
            network: NetworkPolicy::None,
            session_dir: None,
            limits: Limits::default(),
        }
    }

    /// Builds a `read-only`, network-off profile for a workspace.
    #[must_use]
    pub fn read_only(workspace: impl Into<PathBuf>) -> Self {
        let mut profile = Self::workspace_write(workspace);
        profile.profile = FsProfile::ReadOnly;
        profile
    }

    /// Builds a `full-access` profile. This is the only profile that runs bare.
    #[must_use]
    pub fn full_access(workspace: impl Into<PathBuf>) -> Self {
        let mut profile = Self::workspace_write(workspace);
        profile.profile = FsProfile::FullAccess;
        profile.network = NetworkPolicy::Full;
        profile
    }

    /// Sets the session-scoped writable directory.
    #[must_use]
    pub fn with_session_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.session_dir = Some(dir.into());
        self
    }

    /// Sets the network policy.
    #[must_use]
    pub fn with_network(mut self, network: NetworkPolicy) -> Self {
        self.network = network;
        self
    }

    /// Adds a kernel-enforced deny glob.
    #[must_use]
    pub fn with_deny(mut self, pattern: impl Into<String>) -> Self {
        self.deny.push(pattern.into());
        self
    }

    /// Sets the resource limits.
    #[must_use]
    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    /// Returns every writable root for this profile.
    #[must_use]
    pub fn writable_roots(&self) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if self.profile == FsProfile::WorkspaceWrite {
            roots.push(self.workspace.clone());
            roots.extend(self.writable_roots.iter().cloned());
        }
        if let Some(session) = &self.session_dir {
            roots.push(session.clone());
        }
        roots
    }
}

/// Default protected subpaths kept read-only inside a writable root.
#[must_use]
pub fn default_protected(workspace: &Path) -> Vec<PathBuf> {
    ["/.git/hooks", "/.git/config", "/.agentx"]
        .iter()
        .map(|suffix| workspace.join(suffix.trim_start_matches('/')))
        .collect()
}
