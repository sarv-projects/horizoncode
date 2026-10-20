//! Fail-closed stub for platforms without an OS-confinement implementation.
//!
//! V1 is Linux/WSL-first (`arch_V1/17` `DEC-V1-01`/`DEC-V1-02`/`DEC-V1-03`):
//! native Windows keeps confined profiles unavailable until a native backend is
//! implemented and accepted, and macOS support is not claimed. Only the
//! explicitly requested `full-access` profile may run here.

use std::path::PathBuf;
use std::process::Command;

use crate::{
    Capabilities, CapabilityStatus, ConfinementBackend, GuaranteeAssessment, GuaranteeDimension,
    GuaranteeLevel, PlatformId, SandboxError, SandboxProfile, SpawnRequest,
};

/// Probe this platform. No confinement backend exists, so every dimension is
/// reported unavailable with a typed reason.
pub(crate) fn probe_capabilities() -> Capabilities {
    let os = std::env::consts::OS;
    let reason = format!(
        "no OS-confinement backend is implemented for `{os}`; confined profiles stay unavailable (DEC-V1-01/DEC-V1-02/DEC-V1-03)"
    );
    Capabilities {
        platform: PlatformId::Other { os },
        bwrap: crate::BwrapStatus::Missing {
            reason: "bubblewrap confinement is Linux-only".to_string(),
        },
        user_namespaces: CapabilityStatus::Unavailable {
            reason: reason.clone(),
        },
        mount_namespaces: CapabilityStatus::Unavailable {
            reason: reason.clone(),
        },
        pid_namespaces: CapabilityStatus::Unavailable {
            reason: reason.clone(),
        },
        network_namespaces: CapabilityStatus::Unavailable { reason },
        landlock_abi: None,
        landlock_probe_error: Some("Landlock is Linux-only".to_string()),
    }
}

/// Platform plan. Only `Bare` (explicit `full-access`) can execute.
#[derive(Clone, Debug)]
pub(crate) struct Plan {
    kind: Kind,
}

#[derive(Clone, Debug)]
enum Kind {
    Bare,
}

/// Placeholder-cleanup state; empty on this platform.
#[derive(Clone, Debug, Default)]
pub(crate) struct RunningState;

impl RunningState {
    pub(crate) fn activate(&mut self) -> Result<(), SandboxError> {
        Err(SandboxError::Unsupported {
            reason: "confined external process backend unavailable".to_owned(),
            dimension: None,
        })
    }
    pub(crate) fn cleanup(&mut self) -> Vec<String> {
        Vec::new()
    }
}

impl Plan {
    pub(crate) fn external_launch(
        &self,
        _request: &SpawnRequest,
    ) -> Result<(Vec<std::ffi::OsString>, RunningState), SandboxError> {
        Err(SandboxError::Unsupported {
            reason: "confined external process backend unavailable on this platform".to_owned(),
            dimension: None,
        })
    }
    pub(crate) fn backend_name(&self) -> &'static str {
        match self.kind {
            Kind::Bare => "none",
        }
    }

    pub(crate) fn prepare(
        profile: &SandboxProfile,
        _capabilities: &Capabilities,
    ) -> Result<Plan, SandboxError> {
        match profile {
            SandboxProfile::FullAccess => Ok(Plan { kind: Kind::Bare }),
            SandboxProfile::Confined(confined) => Err(SandboxError::Unsupported {
                reason: format!(
                    "the `{}` backend is not implemented on this platform; confined profiles fail closed",
                    match confined.backend {
                        ConfinementBackend::Bubblewrap => "bubblewrap",
                        ConfinementBackend::LandlockWriteScope => "landlock-write-scope",
                    }
                ),
                dimension: None,
            }),
        }
    }

    pub(crate) fn command(
        &self,
        request: &SpawnRequest,
    ) -> Result<(Command, RunningState), SandboxError> {
        let mut command = Command::new(&request.program);
        command.args(&request.args);
        if let Some(cwd) = &request.cwd {
            command.current_dir(cwd);
        }
        request.apply_env(&mut command);
        request.apply_stdio(&mut command);
        Ok((command, RunningState))
    }

    pub(crate) fn command_line(
        &self,
        request: &SpawnRequest,
    ) -> Result<Vec<std::ffi::OsString>, SandboxError> {
        let mut argv = vec![request.program.clone().into_os_string()];
        argv.extend(request.args.iter().cloned());
        Ok(argv)
    }
}

/// Guarantee vector: nothing is enforced without a confinement backend.
pub(crate) fn guarantees(
    _profile: &SandboxProfile,
    _capabilities: &Capabilities,
    _plan: &Plan,
) -> Vec<GuaranteeAssessment> {
    let platform = std::env::consts::OS;
    GuaranteeDimension::ALL
        .iter()
        .map(|&dimension| GuaranteeAssessment {
            dimension,
            level: GuaranteeLevel::Unsupported,
            backend: "none",
            residuals: vec![format!(
                "no OS-confinement backend on `{platform}`; full-access runs are never described as confined"
            )],
        })
        .collect()
}

#[allow(dead_code)]
fn _unused_path_marker() -> PathBuf {
    PathBuf::new()
}
