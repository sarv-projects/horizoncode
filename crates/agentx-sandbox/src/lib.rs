//! Platform confinement (`CMP-sandbox`, `ARCH/13-SANDBOX.md`).
//!
//! Every tier presents one [`SandboxProvider`] interface so callers never branch
//! on backend (`DEC-008`). The Linux local backend is implemented against the
//! `bubblewrap` binary as a subprocess: mount/user/PID/IPC/UTS/network
//! namespaces, a read-only host root, a profile-scoped writable workspace, and
//! `--die-with-parent` (`REQ-GUARD-004`). The macOS backend applies a Seatbelt
//! profile; the Windows backend returns a typed `Unsupported` because the
//! AppContainer/token/job-object boundary is not linked in this slice — it never
//! runs a confined command unconfined.
//!
//! ## Fail-closed
//! If the requested confinement cannot be established, [`SandboxProvider::spawn`]
//! returns a typed error and the command does **not** run. Only an explicit
//! [`FsProfile::FullAccess`] profile runs bare, and that is recorded in the
//! resolved plan.
//!
//! ## Honest limits
//! Landlock and seccomp are not installed in this slice; namespace isolation is
//! the Linux enforcement. The seam is [`SandboxProvider::resolve`], which fails
//! closed before spawn, so stacking a syscall filter later does not change the
//! interface.

#![forbid(unsafe_code)]

mod error;
mod paths;
mod process;
mod profile;
mod provider;
mod unsupported;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

pub use error::SandboxError;
pub use profile::{ConfinementProfile, FsProfile, Limits, NetworkPolicy, default_protected};
pub use provider::{
    Availability, FsOp, ResolvedProfile, SandboxCommand, SandboxOutcome, SandboxProvider,
};
pub use unsupported::UnsupportedSandbox;

#[cfg(target_os = "linux")]
pub use linux::BwrapSandbox;
#[cfg(target_os = "macos")]
pub use macos::SeatbeltSandbox;
#[cfg(windows)]
pub use windows::AppContainerSandbox;

use std::sync::Arc;

/// Returns the local backend for the current platform.
#[must_use]
#[cfg(target_os = "linux")]
pub fn local_provider() -> Arc<dyn SandboxProvider> {
    Arc::new(BwrapSandbox::new())
}

/// Returns the local backend for the current platform.
#[must_use]
#[cfg(target_os = "macos")]
pub fn local_provider() -> Arc<dyn SandboxProvider> {
    Arc::new(SeatbeltSandbox::new())
}

/// Returns the local backend for the current platform.
#[must_use]
#[cfg(windows)]
pub fn local_provider() -> Arc<dyn SandboxProvider> {
    Arc::new(AppContainerSandbox::new())
}

/// Returns the local backend for the current platform.
#[must_use]
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn local_provider() -> Arc<dyn SandboxProvider> {
    Arc::new(UnsupportedSandbox::new())
}
