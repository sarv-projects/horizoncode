//! macOS local backend: a Seatbelt profile via `sandbox-exec` (`ARCH/13`).
//!
//! Path containment is kernel-enforced by the Seatbelt profile. Child-process
//! network denial is **best-effort at this tier**: the profile denies network
//! syscalls for the wrapped process, but a child that escapes the process tree
//! is not separately confined. This limit is recorded in `applied` whenever a
//! network-restricted profile is requested, and is never described as
//! equivalent to the Linux namespace tier.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::error::SandboxError;
use crate::paths::{absolute, is_within, path_matches_deny};
use crate::process::{host_command, run_process};
use crate::profile::{ConfinementProfile, FsProfile, NetworkPolicy};
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

    fn seatbelt_profile(&self, resolved: &ResolvedProfile) -> String {
        let mut profile = String::from("(version 1)\n(deny default)\n");
        profile.push_str("(allow process-fork)\n(allow process-exec*)\n");
        profile.push_str("(allow file-read*)\n(allow sysctl-read)\n(allow mach-lookup)\n");
        if resolved.profile == FsProfile::WorkspaceWrite {
            for root in &resolved.writable_roots {
                profile.push_str(&format!(
                    "(allow file-write* (subpath \"{}\"))\n",
                    escape(root)
                ));
            }
        }
        match resolved.network {
            NetworkPolicy::None => profile.push_str("(deny network*)\n"),
            NetworkPolicy::Allowlist(_) | NetworkPolicy::Full => {
                profile.push_str("(allow network*)\n")
            }
        }
        profile
    }
}

fn escape(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
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
            "filesystem read allowed; writes scoped to the profile roots".to_owned(),
        ];
        if profile.network == NetworkPolicy::None {
            applied.push(
                "network denied for the wrapped process (child-network blocking is best-effort)"
                    .to_owned(),
            );
        }
        Ok(ResolvedProfile {
            backend: "seatbelt".to_owned(),
            profile: profile.profile,
            network: profile.network.clone(),
            workspace: profile.workspace.clone(),
            writable_roots: profile.writable_roots(),
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
            let mut process = Command::new(&self.binary);
            process
                .arg("-p")
                .arg(self.seatbelt_profile(resolved))
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
        if resolved.bare {
            return Ok(());
        }
        let normalized = absolute(path, &resolved.workspace);
        if path_matches_deny(&normalized, &resolved.workspace, &resolved.deny)? {
            return Err(SandboxError::violation(format!(
                "`{}` matches a denied path",
                normalized.display()
            )));
        }
        if op == FsOp::Read {
            return Ok(());
        }
        if resolved
            .protected
            .iter()
            .any(|protected| is_within(&normalized, protected))
        {
            return Err(SandboxError::violation(
                "protected path is read-only".to_owned(),
            ));
        }
        if resolved
            .writable_roots
            .iter()
            .any(|root| is_within(&normalized, root))
        {
            return Ok(());
        }
        Err(SandboxError::violation(
            "path is outside the writable roots".to_owned(),
        ))
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
