//! A backend that refuses every confined request (`ARCH/13-SANDBOX.md`).
//!
//! Used on platforms without a local confinement implementation and by tests
//! that prove an unavailable backend fails closed instead of running bare.

use std::path::Path;

use crate::error::SandboxError;
use crate::process::{host_command, run_process};
use crate::profile::{ConfinementProfile, FsProfile};
use crate::provider::{
    Availability, FsOp, ResolvedProfile, SandboxCommand, SandboxOutcome, SandboxProvider,
};

/// A backend that returns a typed `Unsupported` for every confined request.
#[derive(Debug, Clone, Copy)]
pub struct UnsupportedSandbox {
    backend: &'static str,
    reason: &'static str,
}

impl Default for UnsupportedSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl UnsupportedSandbox {
    /// Builds the default unsupported backend.
    #[must_use]
    pub fn new() -> Self {
        Self {
            backend: "unsupported",
            reason: "no confinement backend is implemented for this platform in this slice",
        }
    }

    /// Builds a named unsupported backend with an explicit reason.
    #[must_use]
    pub fn with_reason(backend: &'static str, reason: &'static str) -> Self {
        Self { backend, reason }
    }
}

impl SandboxProvider for UnsupportedSandbox {
    fn backend(&self) -> &'static str {
        self.backend
    }

    fn probe(&self) -> Availability {
        Availability::Unavailable {
            reason: self.reason.to_owned(),
        }
    }

    fn resolve(&self, profile: &ConfinementProfile) -> Result<ResolvedProfile, SandboxError> {
        if profile.profile == FsProfile::FullAccess {
            return Ok(ResolvedProfile {
                backend: "bare".to_owned(),
                profile: profile.profile,
                network: profile.network.clone(),
                workspace: profile.workspace.clone(),
                writable_roots: Vec::new(),
                readable_roots: Vec::new(),
                protected: Vec::new(),
                deny: Vec::new(),
                session_dir: profile.session_dir.clone(),
                limits: profile.limits,
                applied: vec!["explicit full-access: no confinement applied".to_owned()],
                epoch: 1,
                bare: true,
            });
        }
        Err(SandboxError::unsupported(self.backend, self.reason))
    }

    fn spawn(
        &self,
        command: &SandboxCommand,
        resolved: &ResolvedProfile,
    ) -> Result<SandboxOutcome, SandboxError> {
        if !resolved.bare {
            return Err(SandboxError::unsupported(self.backend, self.reason));
        }
        let mut host = host_command(command);
        let raw = run_process(
            &mut host,
            command.stdin.as_deref(),
            resolved.limits.wall_clock(),
            resolved.limits.max_output_bytes,
        )?;
        Ok(SandboxOutcome {
            exit_code: raw.exit_code,
            stdout: String::from_utf8_lossy(&raw.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&raw.stderr).into_owned(),
            timed_out: raw.timed_out,
            backend: resolved.backend.clone(),
            profile: resolved.profile,
            violations: Vec::new(),
        })
    }

    fn check_path(
        &self,
        _op: FsOp,
        _path: &Path,
        resolved: &ResolvedProfile,
    ) -> Result<(), SandboxError> {
        if resolved.bare {
            Ok(())
        } else {
            Err(SandboxError::unsupported(self.backend, self.reason))
        }
    }
}
