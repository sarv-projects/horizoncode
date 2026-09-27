//! macOS local backend: a Seatbelt profile via `sandbox-exec` (`ARCH/13`).
//!
//! Path containment is kernel-enforced by the Seatbelt profile, and reads are
//! scoped to the granted roots as subpath allows — the profile text is produced
//! by [`crate::seatbelt_profile`] and never a blanket `file-read*`.
//!
//! ## Declared network guarantee (`DEC-026`)
//! `best_effort`. The profile denies network syscalls for the wrapped process,
//! but a child that escapes the process tree is not separately confined. That
//! level, its mechanism, and its residual are recorded in `applied` whenever a
//! network-restricted profile is resolved, and the tier is never described as
//! equivalent to the Linux namespace tier. A caller that requires `enforced` is
//! refused (`resolve` returns `Unsupported` for an allowlist, and the residual
//! is disclosed rather than upgraded).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::error::SandboxError;
use crate::process::{host_command, run_process};
use crate::profile::{ConfinementProfile, NetworkPolicy};
use crate::provider::{
    Availability, FsOp, ResolvedProfile, SandboxCommand, SandboxOutcome, SandboxProvider,
};

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The macOS Seatbelt backend.
#[derive(Debug)]
pub struct SeatbeltSandbox {
    binary: PathBuf,
    probe: OnceLock<Availability>,
}

impl Default for SeatbeltSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl SeatbeltSandbox {
    /// Builds the default Seatbelt backend.
    #[must_use]
    pub fn new() -> Self {
        Self {
            binary: PathBuf::from(SANDBOX_EXEC),
            probe: OnceLock::new(),
        }
    }

    fn seatbelt_plan(&self, resolved: &ResolvedProfile) -> Result<String, SandboxError> {
        crate::seatbelt::seatbelt_profile(resolved)
    }
}

impl SandboxProvider for SeatbeltSandbox {
    fn backend(&self) -> &'static str {
        "seatbelt"
    }

    fn probe(&self) -> Availability {
        self.probe
            .get_or_init(|| {
                if self.binary.is_file() {
                    Availability::Available
                } else {
                    Availability::Unavailable {
                        reason: format!("`{}` is not present", self.binary.display()),
                    }
                }
            })
            .clone()
    }

    fn resolve(&self, profile: &ConfinementProfile) -> Result<ResolvedProfile, SandboxError> {
        if profile.profile == FsProfile::FullAccess {
            return Ok(bare_profile(
                profile,
                "explicit full-access: no confinement applied",
            ));
        }
        let availability = self.probe();
        if !availability.is_available() {
            return Err(SandboxError::unsupported(
                "seatbelt",
                availability
                    .reason()
                    .unwrap_or("sandbox-exec unavailable")
                    .to_owned(),
            ));
        }
        if matches!(profile.network, NetworkPolicy::Allowlist(_)) {
            return Err(SandboxError::unsupported(
                "seatbelt",
                "network allowlists are not supported by the local backend",
            ));
        }
        let mut applied = vec![
            "seatbelt profile applied via sandbox-exec".to_owned(),
            format!(
                "filesystem reads scoped to {} granted root(s) plus the declared runtime base; \
                 writes scoped to the writable roots; deny globs and protected subpaths are \
                 kernel-enforced",
                profile.readable_roots().len()
            ),
        ];
        if profile.network == NetworkPolicy::None {
            applied.push(
                "network_guarantee_level=best_effort; mechanism=Seatbelt rule on the wrapped \
                 process; residual=an escaped descendant is not separately confined, and an \
                 allowlisted host would be reported Unsupported for this reason"
                    .to_owned(),
            );
        } else {
            applied.push(
                "network_guarantee_level=none; mechanism=Seatbelt network allow; \
                 residual=no egress isolation claimed on this tier"
                    .to_owned(),
            );
        }
        Ok(ResolvedProfile {
            backend: "seatbelt".to_owned(),
            profile: profile.profile,
            network: profile.network.clone(),
            workspace: profile.workspace.clone(),
            writable_roots: profile.writable_roots(),
            readable_roots: profile.readable_roots(),
            protected: profile.protected.clone(),
            deny: profile.deny.clone(),
            session_dir: profile.session_dir.clone(),
            limits: profile.limits,
            applied,
            epoch: 1,
            bare: false,
        })
    }

    fn spawn(
        &self,
        command: &SandboxCommand,
        resolved: &ResolvedProfile,
    ) -> Result<SandboxOutcome, SandboxError> {
        let mut process = if resolved.bare {
            host_command(command)
        } else {
            // Fail closed before the process starts: a profile whose rules
            // cannot be rendered is never applied in weakened form.
            let plan = self.seatbelt_plan(resolved)?;
            let mut process = Command::new(&self.binary);
            process
                .arg("-p")
                .arg(plan)
                .arg("--")
                .arg(&command.program)
                .args(&command.args);
            if let Some(cwd) = command
                .cwd
                .clone()
                .or_else(|| Some(resolved.workspace.clone()))
            {
                process.current_dir(cwd);
            }
            for (key, value) in &command.env {
                process.env(key, value);
            }
            process
        };
        let raw = run_process(
            &mut process,
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
        op: FsOp,
        path: &Path,
        resolved: &ResolvedProfile,
    ) -> Result<(), SandboxError> {
        crate::provider::check_path(op, path, resolved)
    }
}

fn bare_profile(profile: &ConfinementProfile, note: &str) -> ResolvedProfile {
    ResolvedProfile {
        backend: "bare".to_owned(),
        profile: profile.profile,
        network: profile.network.clone(),
        workspace: profile.workspace.clone(),
        writable_roots: Vec::new(),
        protected: Vec::new(),
        deny: Vec::new(),
        session_dir: profile.session_dir.clone(),
        limits: profile.limits,
        applied: vec![note.to_owned()],
        epoch: 1,
        bare: true,
    }
}
