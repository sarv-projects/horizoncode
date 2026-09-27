//! Windows containment tier: AppContainer + restricted token/job objects
//! (`ARCH/13` §Platform notes, `AX-113`).
//!
//! This slice is honest about what it does not yet do. Establishing an
//! AppContainer boundary, a restricted token, and a job object requires
//! Win32 calls that are not linked here, so confined requests return a typed
//! [`SandboxError::Unsupported`] rather than running unconfined. Job objects
//! alone govern process lifetime and limits; they do **not** by themselves deny
//! filesystem paths or outbound network the way the Unix tiers do, so claiming
//! equivalence would be false. Only an explicit `full-access` profile runs bare.

use std::path::Path;

use crate::error::SandboxError;
use crate::process::{host_command, run_process};
use crate::profile::{ConfinementProfile, FsProfile};
use crate::provider::{
    Availability, FsOp, ResolvedProfile, SandboxCommand, SandboxOutcome, SandboxProvider,
};

const REASON: &str =
    "AppContainer + restricted token/job-object confinement is not linked in this slice";

/// The Windows containment backend.
#[derive(Debug, Clone, Copy)]
pub struct AppContainerSandbox;

impl Default for AppContainerSandbox {
    fn default() -> Self {
        Self
    }
}

impl AppContainerSandbox {
    /// Builds the Windows containment backend.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl SandboxProvider for AppContainerSandbox {
    fn backend(&self) -> &'static str {
        "appcontainer"
    }

    fn probe(&self) -> Availability {
        Availability::Unavailable {
            reason: REASON.to_owned(),
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
        Err(SandboxError::unsupported("appcontainer", REASON))
    }

    fn spawn(
        &self,
        command: &SandboxCommand,
        resolved: &ResolvedProfile,
    ) -> Result<SandboxOutcome, SandboxError> {
        if !resolved.bare {
            return Err(SandboxError::unsupported("appcontainer", REASON));
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
            Err(SandboxError::unsupported("appcontainer", REASON))
        }
    }
}
