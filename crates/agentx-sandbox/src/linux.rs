//! Linux local backend: `bubblewrap` as a subprocess (`DEC-008`, `ARCH/13`).
//!
//! Namespaces provide the real containment: user/mount/PID/IPC/UTS/network are
//! unshared, the host filesystem is bound read-only, the workspace (per profile)
//! is re-bound writable, protected subpaths are re-bound read-only, and the
//! network namespace is absent by default. `--die-with-parent` reaps the tree.
//!
//! ## Honest limits
//! `bubblewrap` is invoked as a subprocess and never linked. Landlock and a
//! seccomp filter are **not** installed in this slice: namespace isolation is
//! the enforcement, and the `applied` list records exactly that. The seam for
//! stacking Landlock/seccomp is [`BwrapSandbox::resolve`], which fails closed
//! before spawn; adding a syscall filter there does not change the interface.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::error::SandboxError;
use crate::paths::{absolute, is_within, materialize_deny, path_matches_deny};
use crate::process::{host_command, run_process};
use crate::profile::{ConfinementProfile, FsProfile, NetworkPolicy};
use crate::provider::{
    Availability, FsOp, ResolvedProfile, SandboxCommand, SandboxOutcome, SandboxProvider,
};

/// The Linux `bubblewrap` backend.
#[derive(Debug)]
pub struct BwrapSandbox {
    binary: PathBuf,
    probe: OnceLock<Availability>,
}

impl Default for BwrapSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl BwrapSandbox {
    /// Builds a backend that invokes `bwrap` from `PATH`.
    #[must_use]
    pub fn new() -> Self {
        Self {
            binary: PathBuf::from("bwrap"),
            probe: OnceLock::new(),
        }
    }

    /// Builds a backend that invokes a specific `bwrap` binary.
    #[must_use]
    pub fn with_binary(binary: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            probe: OnceLock::new(),
        }
    }

    fn build_command(
        &self,
        command: &SandboxCommand,
        resolved: &ResolvedProfile,
    ) -> Result<Command, SandboxError> {
        if resolved.bare {
            return Ok(host_command(command));
        }
        let availability = self.probe();
        if !availability.is_available() {
            return Err(SandboxError::unavailable(
                "bubblewrap",
                availability
                    .reason()
                    .unwrap_or("backend unavailable")
                    .to_owned(),
            ));
        }
        if matches!(resolved.network, NetworkPolicy::Allowlist(_)) {
            return Err(SandboxError::unsupported(
                "bubblewrap",
                "a per-host network allowlist cannot be enforced by mount/namespace primitives alone",
            ));
        }
        let mut bwrap = Command::new(&self.binary);
        bwrap
            .arg("--unshare-all")
            .arg("--die-with-parent")
            .arg("--ro-bind")
            .arg("/")
            .arg("/")
            .arg("--proc")
            .arg("/proc")
            .arg("--dev")
            .arg("/dev")
            .arg("--tmpfs")
            .arg("/tmp");
        if resolved.network == NetworkPolicy::Full {
            bwrap.arg("--share-net");
        }
        for root in &resolved.writable_roots {
            if !root.exists() {
                std::fs::create_dir_all(root)
                    .map_err(|error| SandboxError::Io(error.to_string()))?;
            }
            bwrap.arg("--bind").arg(root).arg(root);
        }
        // A read-only profile keeps the workspace visible but read-only; this
        // also re-exposes it when the workspace lives under a shadowed `/tmp`.
        if resolved.profile == FsProfile::ReadOnly && resolved.workspace.exists() {
            bwrap
                .arg("--ro-bind")
                .arg(&resolved.workspace)
                .arg(&resolved.workspace);
        }
        for protected in &resolved.protected {
            if protected.exists() {
                bwrap.arg("--ro-bind").arg(protected).arg(protected);
            }
        }
        for denied in materialize_deny(&resolved.writable_roots, &resolved.deny)? {
            if denied.is_dir() {
                // An empty tmpfs hides the directory contents and discards writes.
                bwrap.arg("--tmpfs").arg(&denied);
            } else {
                // `/dev/null` reads empty and is read-only, so content is hidden
                // and writes cannot reach the real file.
                bwrap.arg("--ro-bind").arg("/dev/null").arg(&denied);
            }
        }
        let cwd = command
            .cwd
            .clone()
            .unwrap_or_else(|| resolved.workspace.clone());
        bwrap.arg("--chdir").arg(cwd);
        bwrap.arg("--").arg(&command.program).args(&command.args);
        for (key, value) in &command.env {
            bwrap.env(key, value);
        }
        Ok(bwrap)
    }
}

impl SandboxProvider for BwrapSandbox {
    fn backend(&self) -> &'static str {
        "bubblewrap"
    }

    fn probe(&self) -> Availability {
        self.probe.get_or_init(|| probe_bwrap(&self.binary)).clone()
    }

    fn resolve(&self, profile: &ConfinementProfile) -> Result<ResolvedProfile, SandboxError> {
        if profile.profile == FsProfile::FullAccess {
            return Ok(ResolvedProfile {
                backend: "bare".to_owned(),
                profile: profile.profile,
                network: profile.network.clone(),
                workspace: profile.workspace.clone(),
                writable_roots: Vec::new(),
                protected: Vec::new(),
                deny: Vec::new(),
                session_dir: profile.session_dir.clone(),
                limits: profile.limits,
                applied: vec!["explicit full-access: no confinement applied".to_owned()],
                epoch: 1,
                bare: true,
            });
        }
        let availability = self.probe();
        if !availability.is_available() {
            return Err(SandboxError::unsupported(
                "bubblewrap",
                availability
                    .reason()
                    .unwrap_or("bubblewrap is unavailable")
                    .to_owned(),
            ));
        }
        if matches!(profile.network, NetworkPolicy::Allowlist(_)) {
            return Err(SandboxError::unsupported(
                "bubblewrap",
                "network allowlists are not supported by the local backend",
            ));
        }
        let mut applied = vec![
            "namespaces: user, mount, pid, ipc, uts, cgroup, network".to_owned(),
            "root filesystem bound read-only".to_owned(),
            "--die-with-parent set".to_owned(),
        ];
        match profile.profile {
            FsProfile::ReadOnly => {
                applied.push("workspace left read-only; session state and temp writable".to_owned())
            }
            FsProfile::WorkspaceWrite => applied.push("workspace bound writable".to_owned()),
            FsProfile::FullAccess => unreachable!("handled above"),
        }
        if profile.network == NetworkPolicy::None {
            applied.push("outbound network disabled".to_owned());
        } else {
            applied.push("outbound network shared with the host".to_owned());
        }
        Ok(ResolvedProfile {
            backend: "bubblewrap".to_owned(),
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
        let mut bwrap = self.build_command(command, resolved)?;
        let raw = run_process(
            &mut bwrap,
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
            return Err(SandboxError::violation(format!(
                "`{}` is a protected path and is read-only",
                normalized.display()
            )));
        }
        if resolved
            .writable_roots
            .iter()
            .any(|root| is_within(&normalized, root))
        {
            return Ok(());
        }
        Err(SandboxError::violation(format!(
            "`{}` is outside the writable roots for profile `{}`",
            normalized.display(),
            resolved.profile.as_str()
        )))
    }
}

fn probe_bwrap(binary: &Path) -> Availability {
    let version = Command::new(binary).arg("--version").output();
    match version {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            return Availability::Unavailable {
                reason: format!(
                    "`{}` --version exited with {:?}",
                    binary.display(),
                    output.status.code()
                ),
            };
        }
        Err(error) => {
            return Availability::Unavailable {
                reason: format!("`{}` could not be run: {error}", binary.display()),
            };
        }
    }
    // A trivial smoke test proves user namespaces and bind mounts actually work.
    let smoke = Command::new(binary)
        .args([
            "--unshare-all",
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--",
            "/bin/sh",
            "-c",
            "true",
        ])
        .output();
    match smoke {
        Ok(output) if output.status.success() => Availability::Available,
        Ok(output) => Availability::Unavailable {
            reason: format!(
                "bubblewrap smoke test failed with {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        },
        Err(error) => Availability::Unavailable {
            reason: format!("bubblewrap smoke test could not run: {error}"),
        },
    }
}
