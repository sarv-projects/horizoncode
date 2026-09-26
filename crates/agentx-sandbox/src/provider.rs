//! The one `SandboxProvider` interface (`ARCH/13-SANDBOX.md`).
//!
//! Callers hold a resolved profile, never a backend. Every tier presents this
//! interface so the tool plane never branches on platform (`DEC-008`).

use std::path::{Path, PathBuf};

use crate::error::SandboxError;
use crate::profile::{ConfinementProfile, FsProfile, NetworkPolicy};

/// Whether a backend can confine on this host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Availability {
    /// The backend is present and passed its probe.
    Available,
    /// The backend cannot be used, with a reason.
    Unavailable {
        /// Why the backend is unavailable.
        reason: String,
    },
}

impl Availability {
    /// Returns whether the backend is available.
    #[must_use]
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available)
    }

    /// Returns the unavailability reason, when any.
    #[must_use]
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Available => None,
            Self::Unavailable { reason } => Some(reason),
        }
    }
}

/// A resolved, immutable confinement plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedProfile {
    /// The backend that resolved it.
    pub backend: String,
    /// The filesystem level.
    pub profile: FsProfile,
    /// The network policy.
    pub network: NetworkPolicy,
    /// The workspace root.
    pub workspace: PathBuf,
    /// Writable roots in force.
    pub writable_roots: Vec<PathBuf>,
    /// Paths kept read-only inside a writable root.
    pub protected: Vec<PathBuf>,
    /// Kernel-enforced read+write denial globs.
    pub deny: Vec<String>,
    /// Session-scoped writable state directory.
    pub session_dir: Option<PathBuf>,
    /// Resource limits applied at spawn.
    pub limits: crate::profile::Limits,
    /// Human-readable description of what was applied.
    pub applied: Vec<String>,
    /// The monotonic epoch; bumping it revokes stale tickets upstream.
    pub epoch: u64,
    /// Whether the effect runs bare (only for `full-access`).
    pub bare: bool,
}

/// A command to execute under confinement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxCommand {
    /// The program to run.
    pub program: String,
    /// The program arguments.
    pub args: Vec<String>,
    /// The working directory.
    pub cwd: Option<PathBuf>,
    /// Extra environment variables.
    pub env: Vec<(String, String)>,
    /// Optional stdin payload.
    pub stdin: Option<String>,
}

impl SandboxCommand {
    /// Builds a command.
    #[must_use]
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            stdin: None,
        }
    }

    /// Appends an argument.
    #[must_use]
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Appends arguments.
    #[must_use]
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Sets the working directory.
    #[must_use]
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Sets an environment variable.
    #[must_use]
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Sets the stdin payload.
    #[must_use]
    pub fn stdin(mut self, stdin: impl Into<String>) -> Self {
        self.stdin = Some(stdin.into());
        self
    }
}

/// A filesystem operation class for in-process checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsOp {
    /// A read.
    Read,
    /// A write, rename or delete.
    Write,
}

/// The bounded result of a confined command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxOutcome {
    /// The exit code, when the process exited normally.
    pub exit_code: Option<i32>,
    /// Captured stdout (bounded).
    pub stdout: String,
    /// Captured stderr (bounded).
    pub stderr: String,
    /// Whether the wall-clock watchdog killed the process.
    pub timed_out: bool,
    /// The backend that ran the command.
    pub backend: String,
    /// The filesystem level in force.
    pub profile: FsProfile,
    /// Any confinement violations observed.
    pub violations: Vec<String>,
}

impl SandboxOutcome {
    /// Returns whether the command exited successfully.
    #[must_use]
    pub fn success(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out
    }
}

/// The single confinement interface every tier implements.
pub trait SandboxProvider: Send + Sync + std::fmt::Debug {
    /// Returns the backend name.
    fn backend(&self) -> &'static str;

    /// Probes backend availability once, at startup.
    fn probe(&self) -> Availability;

    /// Resolves a requested profile into a concrete plan, failing closed.
    ///
    /// # Errors
    /// Returns [`SandboxError`] when the confinement cannot be established.
    fn resolve(&self, profile: &ConfinementProfile) -> Result<ResolvedProfile, SandboxError>;

    /// Runs a command under the resolved plan.
    ///
    /// # Errors
    /// Returns [`SandboxError`] when confinement cannot be established. It must
    /// never fall back to unconfined execution except for an explicit
    /// `full-access` profile.
    fn spawn(
        &self,
        command: &SandboxCommand,
        resolved: &ResolvedProfile,
    ) -> Result<SandboxOutcome, SandboxError>;

    /// Validates an in-process filesystem operation against the plan.
    ///
    /// # Errors
    /// Returns [`SandboxError::Violation`] when the path is outside the scoped
    /// roots, protected, or denied.
    fn check_path(
        &self,
        op: FsOp,
        path: &Path,
        resolved: &ResolvedProfile,
    ) -> Result<(), SandboxError> {
        let _ = (op, path, resolved);
        Ok(())
    }
}
