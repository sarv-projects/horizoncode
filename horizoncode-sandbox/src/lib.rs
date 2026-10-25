//! HorizonCode OS-confinement backend (`horizoncode-sandbox`).
//!
//! This crate is the fail-closed OS containment layer described by
//! `arch_V1/14-EFFECTS-EXECUTION-SECURITY.md` §14.5 (sandbox profile vector and
//! platform contract) and by `arch_V1/17-GOVERNANCE-DECISIONS.md` `DEC-V1-03`.
//! It answers exactly two questions for the Rust Guard/ExecutionHost
//! boundary:
//!
//! 1. **What can this host actually enforce?** — [`Capabilities`] is a probed,
//!    typed record of bubblewrap presence/version, user/mount/pid/network
//!    namespace availability and the probed Landlock ABI (raw syscall probe).
//! 2. **What did this prepared execution enforce?** — every
//!    [`PreparedExecution`] exposes a per-dimension
//!    [`GuaranteeAssessment`] vector (filesystem read/write, network egress,
//!    process tree, resource limits, credentials, workspace fence) with the
//!    backend name and explicit residuals. A dimension is never reported
//!    `enforced` unless the mechanism enforcing it was actually applied.
//!
//! Fail-closed rules implemented here:
//!
//! * [`SandboxProfile::Confined`] never runs "bare". If the requested backend
//!   cannot be applied on this host, [`Sandbox::prepare`] returns a typed
//!   [`SandboxError::Unsupported`].
//! * Weaker guarantees (for example the explicit Landlock-write-scope-only
//!   backend) are reported as [`GuaranteeLevel::BestEffort`] with residuals,
//!   and callers must call [`PreparedExecution::require`] for the levels their
//!   `GuaranteeRequirement` demands.
//! * [`SandboxProfile::FullAccess`] is the only profile that may run without OS
//!   containment, and it never reports any dimension as `enforced`.
//!
//! Scope boundary: this crate prepares and spawns the confined process
//! (program, args, cwd, environment policy in; pid + exit status out). Bounded
//! output capture/truncation receipts, wall-clock deadlines, process-tree
//! kill/reconciliation and lease/receipt bookkeeping stay with the kernel
//! ExecutionHost (P1.3); see "ExecutionHost integration" below.
//!
//! # Example
//!
//! ```no_run
//! use std::ffi::OsString;
//! use std::path::PathBuf;
//! use horizoncode_sandbox::{
//!     ConfinementBackend, ExpectedLevel, GuaranteeDimension, NetworkPolicy, RootAccess,
//!     Sandbox, SandboxProfile, ScopedRoot, SpawnRequest,
//! };
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! // Probe once per process and cache the result.
//! let sandbox = Sandbox::probe();
//!
//! // "workspace-write": read the workspace, write only inside it, no network.
//! let profile = SandboxProfile::workspace_write("/home/user/project");
//!
//! let prepared = sandbox.prepare(&profile)?;
//!
//! // Refuse to run if the platform cannot actually enforce write scoping.
//! prepared.require(GuaranteeDimension::FilesystemWrite, ExpectedLevel::ENFORCED)?;
//!
//! let mut request = SpawnRequest::new("/bin/sh");
//! request.args = vec![OsString::from("-c"), OsString::from("echo hi > notes.txt")];
//! request.cwd = Some(PathBuf::from("/home/user/project"));
//!
//! let outcome = prepared.run(&request)?;
//! println!("exit code: {:?}", outcome.code);
//! # Ok(())
//! # }
//! ```
//!
//! # ExecutionHost integration (intended call site: `kernel/src/effect_host.rs`)
//!
//! ```text
//! startup:      Sandbox::probe()  -> cache Capabilities (also emitted to the
//!               DEC-V1-03 containment record)
//! per dispatch: policy profile -> SandboxProfile -> Sandbox::prepare()
//!               -> PreparedExecution::require(dimension, level) for every
//!                  GuaranteeRequirement the Task/Attempt carries
//!               -> PreparedExecution::spawn(SpawnRequest)
//!               -> ExecutionHost owns deadlines, bounded readers/truncation,
//!                  process-tree kill and UNKNOWN reconciliation, then
//!                  RunningChild::wait() for the exit receipt
//! receipt:      backend name + guarantee vector + residuals from the prepared
//!               execution are recorded with the EffectReceipt.
//! reuse key:    PreparedExecution::canonical_descriptor() is the
//!               `WorkerReuseKey.sandbox_profile` source string (kernel hashes it).
//! ```
//!
//! The crate deliberately performs no file writes outside the child's own
//! scoped roots. The only host-side side effects are mount-target placeholders
//! that bubblewrap itself must create for `deny_masks`/`protected_subpaths`
//! entries that do not exist yet; those are tracked and removed again after the
//! child exits (see [`RunningChild`]).

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};

#[cfg(target_os = "linux")]
mod landlock;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod unsupported;

mod platform {
    //! Platform implementation selection.
    #[cfg(target_os = "linux")]
    pub(crate) use crate::linux as imp;
    #[cfg(not(target_os = "linux"))]
    pub(crate) use crate::unsupported as imp;
}

/// Crate version, recorded in the capability record.
pub const CRATE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Version tag for the deterministic capability record format.
pub const CAPABILITY_RECORD_FORMAT: &str = "hz-sandbox-capability-record v1";

// ---------------------------------------------------------------------------
// Profiles: requests, not claims (§14.5)
// ---------------------------------------------------------------------------

/// Access granted to one scoped root.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootAccess {
    /// Visible and readable, not writable.
    ReadOnly,
    /// Visible, readable and writable.
    ReadWrite,
}

/// One declared root of the sandbox filesystem view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopedRoot {
    /// Absolute host path that becomes visible at the same path in the view.
    pub path: PathBuf,
    /// Requested access for this root.
    pub access: RootAccess,
}

impl ScopedRoot {
    /// A read-only scoped root.
    pub fn read(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            access: RootAccess::ReadOnly,
        }
    }

    /// A writable scoped root.
    pub fn write(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            access: RootAccess::ReadWrite,
        }
    }
}

/// What the sandbox view shows for a [`ProtectedSubpath`] that does not exist
/// on the host yet.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MissingPlaceholder {
    /// Materialize an empty, non-writable directory (blocks creation of files
    /// and directories at that path).
    #[default]
    Directory,
    /// Materialize an empty, read-only regular file (blocks creation of files
    /// and directories at that path).
    File,
}

/// A path inside a writable root that must stay read-only (for example
/// `.git`) and must not become creatable when it is absent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtectedSubpath {
    /// Absolute path of the protected entry.
    pub path: PathBuf,
    /// Placeholder shape used when `path` does not exist.
    pub when_missing: MissingPlaceholder,
}

impl ProtectedSubpath {
    /// Protect `path`, materializing a non-writable directory when absent.
    pub fn directory(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            when_missing: MissingPlaceholder::Directory,
        }
    }

    /// Protect `path`, materializing an empty read-only file when absent.
    pub fn file(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            when_missing: MissingPlaceholder::File,
        }
    }
}

impl From<PathBuf> for ProtectedSubpath {
    fn from(path: PathBuf) -> Self {
        Self::directory(path)
    }
}

impl From<&Path> for ProtectedSubpath {
    fn from(path: &Path) -> Self {
        Self::directory(path)
    }
}

/// Network egress policy of a confined profile.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NetworkPolicy {
    /// No network namespace sharing; the child gets an empty network
    /// namespace with a down loopback interface.
    #[default]
    DenyDefault,
    /// Explicitly share the host network namespace. This never yields an
    /// enforced network guarantee; it is reported as a residual.
    ShareHost,
}

/// Which OS mechanism enforces a confined profile.
///
/// Selection is always explicit; there is no silent fallback between backends.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ConfinementBackend {
    /// bubblewrap: fresh mount view, user/ipc/pid/network/uts/cgroup
    /// namespaces, scoped roots, protected subpaths, masked deny paths, no
    /// network namespace sharing by default.
    #[default]
    Bubblewrap,
    /// Landlock write scoping only (raw syscalls, no namespaces). A weaker,
    /// explicitly requested backend: reads, process tree and (below ABI 4)
    /// network are **not** confined and are reported as residuals.
    LandlockWriteScope,
}

/// A confined profile: the explicit request handed to [`Sandbox::prepare`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfinedProfile {
    /// Requested enforcement mechanism.
    pub backend: ConfinementBackend,
    /// Declared filesystem roots of the sandbox view.
    pub scoped_roots: Vec<ScopedRoot>,
    /// Read-only carveouts that stay protected under writable roots.
    pub protected_subpaths: Vec<ProtectedSubpath>,
    /// Paths hidden (non-readable, non-writable, non-creatable) in the view.
    pub deny_masks: Vec<PathBuf>,
    /// Egress policy; defaults to [`NetworkPolicy::DenyDefault`].
    pub network: NetworkPolicy,
    /// Add the standard system read roots (`/usr`, `/bin`, `/sbin`, `/lib`,
    /// `/lib64`, `/etc`, `/nix/store`, `/run/current-system/sw`) needed to
    /// execute dynamically linked programs. Default: `true`.
    pub platform_default_reads: bool,
    /// Mount a fresh private `tmpfs` on `/tmp`. Default: `true`.
    pub private_tmp: bool,
    /// Hide `/run/WSL` so WSL2 Windows interop (which would return to the
    /// unconfined Windows side, including the host network stack) is
    /// unreachable from the sandbox. Default: `true`.
    pub mask_wsl_interop: bool,
}

impl Default for ConfinedProfile {
    fn default() -> Self {
        Self {
            backend: ConfinementBackend::Bubblewrap,
            scoped_roots: Vec::new(),
            protected_subpaths: Vec::new(),
            deny_masks: Vec::new(),
            network: NetworkPolicy::DenyDefault,
            platform_default_reads: true,
            private_tmp: true,
            mask_wsl_interop: true,
        }
    }
}

/// The sandbox profile vector (§14.5). A profile is a request; the resulting
/// guarantees are reported per dimension by [`PreparedExecution`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SandboxProfile {
    /// Confined by the OS. Guarantees are probed, reported and fail closed.
    Confined(ConfinedProfile),
    /// Explicit high-risk opt-in: host profile with no OS filesystem
    /// containment. Still Guard/audit/budgeted upstream; never described as
    /// confined and never reported as enforcing any dimension.
    FullAccess,
}

impl SandboxProfile {
    /// The V1 `workspace-write` profile: reads the workspace plus platform
    /// defaults, writes only inside the workspace, no network, protected
    /// repository metadata.
    pub fn workspace_write(workspace: impl Into<PathBuf>) -> Self {
        let workspace = workspace.into();
        let mut profile = ConfinedProfile::default();
        profile
            .scoped_roots
            .push(ScopedRoot::write(workspace.clone()));
        profile.protected_subpaths = vec![
            ProtectedSubpath::directory(workspace.join(".git")),
            ProtectedSubpath::directory(workspace.join(".agents")),
            ProtectedSubpath::directory(workspace.join(".codex")),
            ProtectedSubpath::directory(workspace.join(".horizoncode")),
        ];
        SandboxProfile::Confined(profile)
    }

    /// The V1 `readonly` profile: reads the declared roots and platform
    /// defaults only; no write root, no network.
    pub fn readonly(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut profile = ConfinedProfile::default();
        profile.scoped_roots = roots.into_iter().map(ScopedRoot::read).collect();
        SandboxProfile::Confined(profile)
    }

    /// The explicit `full-access` profile.
    pub fn full_access() -> Self {
        SandboxProfile::FullAccess
    }

    /// Stable profile label for policy/UX and `WorkerReuseKey.sandbox_profile`
    /// prefixes.
    pub fn descriptor_id(&self) -> &'static str {
        match self {
            SandboxProfile::FullAccess => "full-access",
            SandboxProfile::Confined(profile) => match profile.backend {
                ConfinementBackend::LandlockWriteScope => "landlock-write-scope",
                ConfinementBackend::Bubblewrap => {
                    let has_rw = profile
                        .scoped_roots
                        .iter()
                        .any(|r| r.access == RootAccess::ReadWrite);
                    if has_rw {
                        if profile.network == NetworkPolicy::DenyDefault {
                            "workspace-write"
                        } else {
                            "networked-workspace-write"
                        }
                    } else {
                        "readonly"
                    }
                }
            },
        }
    }

    /// Deterministic, sorted, canonical rendering of the profile. Use this
    /// (hashed upstream) as the `WorkerReuseKey.sandbox_profile` value so a
    /// policy change cannot silently reuse a worker confined by another
    /// profile.
    pub fn canonical_descriptor(&self) -> String {
        let mut lines = vec![format!("profile={}", self.descriptor_id())];
        match self {
            SandboxProfile::FullAccess => {
                lines.push("containment=none".to_string());
            }
            SandboxProfile::Confined(profile) => {
                let backend = match profile.backend {
                    ConfinementBackend::Bubblewrap => "bubblewrap",
                    ConfinementBackend::LandlockWriteScope => "landlock-write-scope",
                };
                lines.push(format!("backend={backend}"));
                lines.push(format!(
                    "network={}",
                    match profile.network {
                        NetworkPolicy::DenyDefault => "deny-default",
                        NetworkPolicy::ShareHost => "share-host",
                    }
                ));
                lines.push(format!(
                    "platform-default-reads={}",
                    profile.platform_default_reads
                ));
                lines.push(format!("private-tmp={}", profile.private_tmp));
                lines.push(format!("mask-wsl-interop={}", profile.mask_wsl_interop));
                let mut reads: Vec<String> = profile
                    .scoped_roots
                    .iter()
                    .filter(|root| root.access == RootAccess::ReadOnly)
                    .map(|root| root.path.display().to_string())
                    .collect();
                reads.sort();
                for read in reads {
                    lines.push(format!("read={read}"));
                }
                let mut writes: Vec<String> = profile
                    .scoped_roots
                    .iter()
                    .filter(|root| root.access == RootAccess::ReadWrite)
                    .map(|root| root.path.display().to_string())
                    .collect();
                writes.sort();
                for write in writes {
                    lines.push(format!("write={write}"));
                }
                let mut protected: Vec<String> = profile
                    .protected_subpaths
                    .iter()
                    .map(|subpath| {
                        format!(
                            "{}:{}",
                            subpath.path.display(),
                            match subpath.when_missing {
                                MissingPlaceholder::Directory => "dir",
                                MissingPlaceholder::File => "file",
                            }
                        )
                    })
                    .collect();
                protected.sort();
                for path in protected {
                    lines.push(format!("protected={path}"));
                }
                let mut denied: Vec<String> = profile
                    .deny_masks
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect();
                denied.sort();
                for path in denied {
                    lines.push(format!("deny={path}"));
                }
            }
        }
        lines.join("\n")
    }
}

// ---------------------------------------------------------------------------
// Capability probing
// ---------------------------------------------------------------------------

/// Platform identity recorded with every capability report.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlatformId {
    /// Linux (including WSL2).
    Linux {
        /// Kernel release from `/proc/sys/kernel/osrelease`.
        os_release: String,
        /// Target architecture (`x86_64`, `aarch64`, ...).
        arch: &'static str,
    },
    /// Any other platform; confined profiles fail closed there.
    Other {
        /// Effectively `std::env::consts::OS`.
        os: &'static str,
    },
}

impl fmt::Display for PlatformId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlatformId::Linux { os_release, arch } => {
                write!(formatter, "linux {os_release} {arch}")
            }
            PlatformId::Other { os } => write!(formatter, "{os}"),
        }
    }
}

/// Result of probing one capability dimension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CapabilityStatus {
    /// The mechanism was probed and is usable on this host.
    Available {
        /// How availability was established (exact command or syscall probe).
        evidence: String,
    },
    /// The mechanism is not usable; the reason is retained verbatim.
    Unavailable {
        /// Typed reason, suitable for surfacing to the user.
        reason: String,
    },
}

impl CapabilityStatus {
    /// True only for [`CapabilityStatus::Available`].
    pub fn is_available(&self) -> bool {
        matches!(self, CapabilityStatus::Available { .. })
    }

    /// The reason string when unavailable.
    pub fn reason(&self) -> Option<&str> {
        match self {
            CapabilityStatus::Available { .. } => None,
            CapabilityStatus::Unavailable { reason } => Some(reason),
        }
    }
}

/// bubblewrap presence and version.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BwrapStatus {
    /// `bwrap --version` succeeded.
    Present {
        /// Resolved absolute path of the `bwrap` binary.
        path: PathBuf,
        /// Version string reported by `bwrap --version`.
        version: String,
    },
    /// No usable bubblewrap binary was found.
    Missing {
        /// Typed reason.
        reason: String,
    },
}

impl BwrapStatus {
    /// The resolved binary path when present.
    pub fn path(&self) -> Option<&Path> {
        match self {
            BwrapStatus::Present { path, .. } => Some(path),
            BwrapStatus::Missing { .. } => None,
        }
    }

    /// The version string when present.
    pub fn version(&self) -> Option<&str> {
        match self {
            BwrapStatus::Present { version, .. } => Some(version),
            BwrapStatus::Missing { .. } => None,
        }
    }
}

/// Probed host capabilities backing every guarantee claim.
///
/// Probe results are computed once per process ([`Sandbox::probe`]) and can be
/// injected for tests with [`Sandbox::with_capabilities`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Capabilities {
    /// Platform identity.
    pub platform: PlatformId,
    /// bubblewrap presence/version.
    pub bwrap: BwrapStatus,
    /// Unprivileged user-namespace creation (probed empirically).
    pub user_namespaces: CapabilityStatus,
    /// Mount-namespace creation (implied by any bubblewrap run).
    pub mount_namespaces: CapabilityStatus,
    /// PID-namespace creation (probed empirically).
    pub pid_namespaces: CapabilityStatus,
    /// Network-namespace creation (probed empirically).
    pub network_namespaces: CapabilityStatus,
    /// Landlock ABI level from the raw `landlock_create_ruleset` version probe.
    pub landlock_abi: Option<u32>,
    /// Error text when the Landlock probe itself failed.
    pub landlock_probe_error: Option<String>,
}

impl Capabilities {
    /// Landlock write-scoping usability (ABI >= 1).
    pub fn landlock_write_scope(&self) -> CapabilityStatus {
        match (self.landlock_abi, &self.landlock_probe_error) {
            (Some(abi), _) if abi >= 1 => CapabilityStatus::Available {
                evidence: format!(
                    "landlock_create_ruleset(LANDLOCK_CREATE_RULESET_VERSION) -> ABI {abi}"
                ),
            },
            (Some(abi), _) => CapabilityStatus::Unavailable {
                reason: format!("Landlock ABI {abi} does not support filesystem rulesets"),
            },
            (None, Some(error)) => CapabilityStatus::Unavailable {
                reason: format!("Landlock probe failed: {error}"),
            },
            (None, None) => CapabilityStatus::Unavailable {
                reason: "Landlock probe did not run on this platform".to_string(),
            },
        }
    }

    /// Landlock TCP bind/connect denial usability (ABI >= 4).
    pub fn landlock_network_tcp(&self) -> CapabilityStatus {
        match self.landlock_abi {
            Some(abi) if abi >= 4 => CapabilityStatus::Available {
                evidence: format!("Landlock ABI {abi} supports TCP bind/connect rules"),
            },
            Some(abi) => CapabilityStatus::Unavailable {
                reason: format!(
                    "Landlock ABI {abi} cannot restrict TCP bind/connect (needs ABI >= 4)"
                ),
            },
            None => CapabilityStatus::Unavailable {
                reason: self
                    .landlock_probe_error
                    .clone()
                    .map(|error| format!("Landlock probe failed: {error}"))
                    .unwrap_or_else(|| "Landlock probe did not run on this platform".to_string()),
            },
        }
    }

    /// Whether the requested confined backend is usable on this host.
    pub fn confined_backend(&self, backend: ConfinementBackend) -> CapabilityStatus {
        match backend {
            ConfinementBackend::Bubblewrap => match &self.bwrap {
                BwrapStatus::Missing { reason } => CapabilityStatus::Unavailable {
                    reason: reason.clone(),
                },
                BwrapStatus::Present { path, version } => {
                    for (name, status) in [
                        ("user namespaces", &self.user_namespaces),
                        ("mount namespaces", &self.mount_namespaces),
                        ("pid namespaces", &self.pid_namespaces),
                        ("network namespaces", &self.network_namespaces),
                    ] {
                        if let Some(reason) = status.reason() {
                            return CapabilityStatus::Unavailable {
                                reason: format!("{name} unavailable: {reason}"),
                            };
                        }
                    }
                    CapabilityStatus::Available {
                        evidence: format!(
                            "{} ({version}) with user/mount/pid/network namespaces probed",
                            path.display()
                        ),
                    }
                }
            },
            ConfinementBackend::LandlockWriteScope => self.landlock_write_scope(),
        }
    }
}

// ---------------------------------------------------------------------------
// Guarantee vector (§14.5)
// ---------------------------------------------------------------------------

/// One dimension of the sandbox guarantee vector.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum GuaranteeDimension {
    /// Filesystem reads limited to declared roots.
    FilesystemRead,
    /// Filesystem writes limited to declared writable roots.
    FilesystemWrite,
    /// Network egress denial.
    NetworkEgress,
    /// Process-tree containment.
    ProcessTree,
    /// CPU/memory/FD/resource limits.
    ResourceLimits,
    /// Credential/secret exposure control.
    Credentials,
    /// Workspace revision/lease fencing.
    WorkspaceFence,
}

impl GuaranteeDimension {
    /// Every dimension, in report order.
    pub const ALL: [GuaranteeDimension; 7] = [
        GuaranteeDimension::FilesystemRead,
        GuaranteeDimension::FilesystemWrite,
        GuaranteeDimension::NetworkEgress,
        GuaranteeDimension::ProcessTree,
        GuaranteeDimension::ResourceLimits,
        GuaranteeDimension::Credentials,
        GuaranteeDimension::WorkspaceFence,
    ];

    /// Stable lowercase name used in records.
    pub fn as_str(self) -> &'static str {
        match self {
            GuaranteeDimension::FilesystemRead => "filesystem_read",
            GuaranteeDimension::FilesystemWrite => "filesystem_write",
            GuaranteeDimension::NetworkEgress => "network_egress",
            GuaranteeDimension::ProcessTree => "process_tree",
            GuaranteeDimension::ResourceLimits => "resource_limits",
            GuaranteeDimension::Credentials => "credentials",
            GuaranteeDimension::WorkspaceFence => "workspace_fence",
        }
    }
}

impl fmt::Display for GuaranteeDimension {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Strength of one dimension's guarantee.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum GuaranteeLevel {
    /// Not provided by this backend/profile.
    Unsupported,
    /// Provided with a named mechanism and named residual gaps.
    BestEffort,
    /// Provided by an enforced OS mechanism for this execution.
    Enforced,
}

impl GuaranteeLevel {
    /// Stable lowercase name used in records.
    pub fn as_str(self) -> &'static str {
        match self {
            GuaranteeLevel::Unsupported => "unsupported",
            GuaranteeLevel::BestEffort => "best_effort",
            GuaranteeLevel::Enforced => "enforced",
        }
    }
}

impl fmt::Display for GuaranteeLevel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Minimum level a caller accepts for a dimension.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExpectedLevel(pub GuaranteeLevel);

impl ExpectedLevel {
    /// Require an enforced mechanism.
    pub const ENFORCED: ExpectedLevel = ExpectedLevel(GuaranteeLevel::Enforced);
    /// Accept a named best-effort mechanism.
    pub const BEST_EFFORT: ExpectedLevel = ExpectedLevel(GuaranteeLevel::BestEffort);
}

/// One prepared execution's claim for one dimension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuaranteeAssessment {
    /// Dimension being described.
    pub dimension: GuaranteeDimension,
    /// Level actually provided by this prepared execution.
    pub level: GuaranteeLevel,
    /// Enforcing backend name (`bubblewrap`, `landlock`, `none`).
    pub backend: &'static str,
    /// Explicit residual gaps; always present for `BestEffort`/`Unsupported`.
    pub residuals: Vec<String>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Typed failure of preparation or execution. Guarantee failures are never
/// silent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SandboxError {
    /// The requested profile cannot be enforced on this host. Fail closed: the
    /// caller must not fall back to unconfined execution.
    Unsupported {
        /// Typed reason naming the missing mechanism.
        reason: String,
        /// Dimension the refusal concerns, when it is dimension-specific.
        dimension: Option<GuaranteeDimension>,
    },
    /// The profile itself is malformed or cannot be translated safely
    /// (missing root, symlinked protected path, relative program, ...).
    ProfileInvalid {
        /// Typed reason.
        reason: String,
    },
    /// [`PreparedExecution::require`] found the guaranteed level below the
    /// caller's requirement.
    GuaranteeNotMet {
        /// Dimension that failed.
        dimension: GuaranteeDimension,
        /// Level the caller required.
        requested: GuaranteeLevel,
        /// Level actually provided.
        actual: GuaranteeLevel,
    },
    /// The child process could not be started.
    SpawnFailed {
        /// Typed reason (includes the OS error text when available).
        reason: String,
        /// `errno` when the failure was a syscall error.
        errno: Option<i32>,
    },
    /// Waiting for the child failed.
    WaitFailed {
        /// Typed reason.
        reason: String,
    },
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SandboxError::Unsupported { reason, dimension } => match dimension {
                Some(dimension) => write!(
                    formatter,
                    "confinement guarantee for {dimension} is unsupported on this host: {reason}"
                ),
                None => write!(
                    formatter,
                    "confined profile unsupported on this host: {reason}"
                ),
            },
            SandboxError::ProfileInvalid { reason } => {
                write!(
                    formatter,
                    "sandbox profile cannot be enforced as given: {reason}"
                )
            }
            SandboxError::GuaranteeNotMet {
                dimension,
                requested,
                actual,
            } => write!(
                formatter,
                "sandbox guarantee for {dimension} is {actual}, caller requires {requested}"
            ),
            SandboxError::SpawnFailed { reason, errno } => match errno {
                Some(errno) => write!(
                    formatter,
                    "sandboxed spawn failed (errno {errno}): {reason}"
                ),
                None => write!(formatter, "sandboxed spawn failed: {reason}"),
            },
            SandboxError::WaitFailed { reason } => {
                write!(formatter, "sandboxed wait failed: {reason}")
            }
        }
    }
}

impl std::error::Error for SandboxError {}

// ---------------------------------------------------------------------------
// Spawn request
// ---------------------------------------------------------------------------

/// Environment policy for a spawn request.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum EnvPolicy {
    /// Clear the environment and rebuild it from `SpawnRequest::env_vars`
    /// (§14.4 "cleared and rebuilt from an explicit allowlist"). Default.
    #[default]
    Cleared,
    /// Inherit the parent environment, then apply `SpawnRequest::env_vars`
    /// overrides. Requires explicit caller intent.
    Inherit,
}

/// stdio policy for one stream.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum StdioPolicy {
    /// Inherit the parent's stream.
    #[default]
    Inherit,
    /// Redirect to `/dev/null`.
    Null,
    /// Create a pipe owned by the caller (`RunningChild::take_stdout` ...).
    ///
    /// Bounded capture, truncation receipts and drain deadlines are
    /// ExecutionHost responsibilities, not this crate's.
    Piped,
}

/// Everything needed to start one confined process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpawnRequest {
    /// Executable path. Must be absolute: name resolution inside a cleared
    /// environment is not dependable, and executable resolution is explicit
    /// (§14.4).
    pub program: PathBuf,
    /// Arguments (argv[1..]).
    pub args: Vec<OsString>,
    /// Working directory inside the sandbox view.
    pub cwd: Option<PathBuf>,
    /// Environment policy.
    pub env: EnvPolicy,
    /// Environment entries applied according to `env`.
    pub env_vars: Vec<(OsString, OsString)>,
    /// stdin policy.
    pub stdin: StdioPolicy,
    /// stdout policy.
    pub stdout: StdioPolicy,
    /// stderr policy.
    pub stderr: StdioPolicy,
    /// Preserve an already-established controlling terminal, if one was
    /// inherited by the executor. This is intended for a kernel-owned PTY;
    /// it does not acquire or grant access to a terminal by itself.
    pub preserve_controlling_terminal: bool,
}

impl SpawnRequest {
    /// A request for `program` with default policies (cleared env, inherited
    /// stdio).
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: EnvPolicy::Cleared,
            env_vars: Vec::new(),
            stdin: StdioPolicy::Inherit,
            stdout: StdioPolicy::Inherit,
            stderr: StdioPolicy::Inherit,
            preserve_controlling_terminal: false,
        }
    }

    /// Append one argument.
    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Set the working directory.
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Keep the request in its current session so an inherited kernel PTY
    /// remains the command's controlling terminal. Ordinary processes remain
    /// isolated in a new session by default.
    pub fn preserve_controlling_terminal(mut self) -> Self {
        self.preserve_controlling_terminal = true;
        self
    }

    /// Allow one environment variable through the cleared environment.
    pub fn env_allow(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env_vars.push((key.into(), value.into()));
        self
    }

    /// Apply the environment/stdio policy to a `std::process::Command`.
    pub(crate) fn apply_env(&self, command: &mut Command) {
        match self.env {
            EnvPolicy::Cleared => {
                command.env_clear();
            }
            EnvPolicy::Inherit => {}
        }
        for (key, value) in &self.env_vars {
            command.env(key, value);
        }
    }

    fn stdio(policy: StdioPolicy) -> Stdio {
        match policy {
            StdioPolicy::Inherit => Stdio::inherit(),
            StdioPolicy::Null => Stdio::null(),
            StdioPolicy::Piped => Stdio::piped(),
        }
    }

    pub(crate) fn apply_stdio(&self, command: &mut Command) {
        command.stdin(Self::stdio(self.stdin));
        command.stdout(Self::stdio(self.stdout));
        command.stderr(Self::stdio(self.stderr));
    }
}

// ---------------------------------------------------------------------------
// Sandbox / PreparedExecution / RunningChild
// ---------------------------------------------------------------------------

/// Probed host capabilities plus the preparation entry point.
#[derive(Clone, Debug)]
pub struct Sandbox {
    capabilities: Capabilities,
}

impl Sandbox {
    /// Probe this host once; cache the result for the process lifetime.
    pub fn probe() -> Self {
        Self {
            capabilities: platform::imp::probe_capabilities(),
        }
    }

    /// Build a sandbox from explicit capabilities. Intended for tests and for
    /// hosts that cache a probe result elsewhere.
    pub fn with_capabilities(capabilities: Capabilities) -> Self {
        Self { capabilities }
    }

    /// The probed capabilities.
    pub fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }

    /// Prepare a profile against the probed capabilities.
    ///
    /// Returns [`SandboxError::Unsupported`] when the profile's requested
    /// backend cannot be applied; the caller must keep the affected origin
    /// unavailable rather than run unconfined.
    pub fn prepare(&self, profile: &SandboxProfile) -> Result<PreparedExecution, SandboxError> {
        let plan = platform::imp::Plan::prepare(profile, &self.capabilities)?;
        let guarantees = platform::imp::guarantees(profile, &self.capabilities, &plan);
        Ok(PreparedExecution {
            profile: profile.clone(),
            plan,
            guarantees,
            capabilities: self.capabilities.clone(),
        })
    }

    /// Deterministic, per-host capability record (DEC-V1-03 evidence seed).
    ///
    /// Format is `key=value` lines with a fixed order; it contains no
    /// timestamps and no volatile data beyond the probed platform/kernel.
    pub fn capability_record(&self) -> String {
        let capabilities = &self.capabilities;
        let mut lines = vec![
            format!("# {CAPABILITY_RECORD_FORMAT}"),
            format!("crate_version={CRATE_VERSION}"),
            format!("platform={}", capabilities.platform),
        ];
        match &capabilities.platform {
            PlatformId::Linux { os_release, arch } => {
                lines.push(format!("kernel_release={os_release}"));
                lines.push(format!("kernel_arch={arch}"));
            }
            PlatformId::Other { os } => {
                lines.push(format!("platform_os={os}"));
            }
        }
        match &capabilities.bwrap {
            BwrapStatus::Present { path, version } => {
                lines.push(format!("bwrap_path={}", path.display()));
                lines.push(format!("bwrap_version={version}"));
                lines.push("bwrap_state=present".to_string());
            }
            BwrapStatus::Missing { reason } => {
                lines.push("bwrap_state=missing".to_string());
                lines.push(format!("bwrap_reason={reason}"));
            }
        }
        for (key, status) in [
            ("user_namespaces", &capabilities.user_namespaces),
            ("mount_namespaces", &capabilities.mount_namespaces),
            ("pid_namespaces", &capabilities.pid_namespaces),
            ("network_namespaces", &capabilities.network_namespaces),
            ("landlock_write_scope", &capabilities.landlock_write_scope()),
            ("landlock_network_tcp", &capabilities.landlock_network_tcp()),
        ] {
            match status {
                CapabilityStatus::Available { evidence } => {
                    lines.push(format!("{key}=available"));
                    lines.push(format!("{key}_evidence={evidence}"));
                }
                CapabilityStatus::Unavailable { reason } => {
                    lines.push(format!("{key}=unavailable"));
                    lines.push(format!("{key}_reason={reason}"));
                }
            }
        }
        lines.push(format!(
            "landlock_abi={}",
            capabilities
                .landlock_abi
                .map(|abi| abi.to_string())
                .unwrap_or_else(|| "none".to_string())
        ));
        for backend in [
            ConfinementBackend::Bubblewrap,
            ConfinementBackend::LandlockWriteScope,
        ] {
            let key = match backend {
                ConfinementBackend::Bubblewrap => "backend_bubblewrap",
                ConfinementBackend::LandlockWriteScope => "backend_landlock_write_scope",
            };
            let status = capabilities.confined_backend(backend);
            lines.push(match status {
                CapabilityStatus::Available { .. } => format!("{key}=available"),
                CapabilityStatus::Unavailable { reason } => format!("{key}=unavailable ({reason})"),
            });
        }
        lines.join("\n")
    }
}

/// A prepared (not yet started) confined execution.
#[derive(Clone, Debug)]
pub struct PreparedExecution {
    profile: SandboxProfile,
    plan: platform::imp::Plan,
    guarantees: Vec<GuaranteeAssessment>,
    capabilities: Capabilities,
}

/// A bubblewrap launch delegated to the existing kernel PTY supervisor. The
/// supervisor owns fork/exec, tree termination and reaping; this guard owns only
/// sandbox mount-target cleanup and must outlive that process tree.
pub struct ExternalLaunch {
    argv: Vec<OsString>,
    state: platform::imp::RunningState,
}

impl ExternalLaunch {
    pub fn argv(&self) -> &[OsString] {
        &self.argv
    }

    /// Reserve missing mount targets after Guard/PREPARE, immediately before
    /// dispatch. A path created by another actor since preflight is a conflict.
    pub fn activate(&mut self) -> Result<(), SandboxError> {
        self.state.activate()
    }
}

impl Drop for ExternalLaunch {
    fn drop(&mut self) {
        let _ = self.state.cleanup();
    }
}

impl PreparedExecution {
    /// Prepare a command for an executor that performs raw fork/exec itself.
    /// Plans requiring pre-exec hooks are refused, never run without the hook.
    pub fn prepare_external(&self, request: &SpawnRequest) -> Result<ExternalLaunch, SandboxError> {
        let (argv, state) = self.plan.external_launch(request)?;
        Ok(ExternalLaunch { argv, state })
    }
    /// The profile this execution was prepared from.
    pub fn profile(&self) -> &SandboxProfile {
        &self.profile
    }

    /// Capabilities the preparation was validated against.
    pub fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }

    /// Name of the enforcing backend (`bubblewrap`, `landlock`, `none`).
    pub fn backend(&self) -> &'static str {
        self.plan.backend_name()
    }

    /// The per-dimension guarantee vector for this execution.
    pub fn guarantees(&self) -> &[GuaranteeAssessment] {
        &self.guarantees
    }

    /// Whether the selected, validated mount plan hides the host cgroup
    /// hierarchy from the child. This is an explicit cleanup-authority proof,
    /// not an inference from process-tree containment alone.
    pub fn proves_cgroup_hierarchy_hidden(&self) -> bool {
        if self.plan.backend_name() != "bubblewrap" {
            return false;
        }
        let SandboxProfile::Confined(profile) = &self.profile else {
            return false;
        };
        let mount = Path::new("/sys/fs/cgroup");
        if profile.scoped_roots.iter().any(|root| {
            root.path.starts_with(mount) || mount.starts_with(&root.path)
        }) {
            return false;
        }
        profile.platform_default_reads
            .then_some(["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/nix/store", "/run/current-system/sw"])
            .is_none_or(|roots| roots.iter().all(|root| {
                let root = Path::new(root);
                !root.starts_with(mount) && !mount.starts_with(root)
            }))
    }

    /// The assessment of one dimension.
    pub fn guarantee(&self, dimension: GuaranteeDimension) -> Option<&GuaranteeAssessment> {
        self.guarantees
            .iter()
            .find(|assessment| assessment.dimension == dimension)
    }

    /// Enforce a caller requirement (`GuaranteeRequirement` in the kernel).
    pub fn require(
        &self,
        dimension: GuaranteeDimension,
        level: ExpectedLevel,
    ) -> Result<(), SandboxError> {
        let actual = self
            .guarantee(dimension)
            .map(|assessment| assessment.level)
            .unwrap_or(GuaranteeLevel::Unsupported);
        if actual >= level.0 {
            Ok(())
        } else {
            Err(SandboxError::GuaranteeNotMet {
                dimension,
                requested: level.0,
                actual,
            })
        }
    }

    /// Deterministic containment-matrix record for this prepared execution.
    pub fn guarantee_record(&self) -> String {
        let mut lines = vec![
            format!("# {CAPABILITY_RECORD_FORMAT} containment-matrix"),
            format!("profile={}", self.profile.descriptor_id()),
            format!("backend={}", self.backend()),
        ];
        for assessment in &self.guarantees {
            let residuals = if assessment.residuals.is_empty() {
                "none".to_string()
            } else {
                assessment.residuals.join(" | ")
            };
            lines.push(format!(
                "dimension={} level={} backend={} residuals={residuals}",
                assessment.dimension, assessment.level, assessment.backend
            ));
        }
        lines.join("\n")
    }

    /// Exact command line that [`PreparedExecution::spawn`] would execute,
    /// including the bubblewrap wrapper. Intended for audit records.
    pub fn command_line(&self, request: &SpawnRequest) -> Result<Vec<OsString>, SandboxError> {
        self.plan.command_line(request)
    }

    /// Start the confined process. The caller owns deadlines, bounded output
    /// reads, process-tree kill and reconciliation; call
    /// [`RunningChild::wait`] to reap and clean up.
    pub fn spawn(&self, request: &SpawnRequest) -> Result<RunningChild, SandboxError> {
        self.spawn_internal(request, None, None)
    }

    /// Start the confined launcher inside an already-created delegated cgroup-v2
    /// before its first executable runs. The child writes its own PID to the
    /// pinned `cgroup.procs` descriptor in `pre_exec`; failure aborts exec, so
    /// neither bubblewrap nor the target command can start outside containment.
    /// The caller must durably persist the cgroup identity before this call and
    /// keep the descriptor open until the call returns.
    pub fn spawn_in_cgroup(
        &self,
        request: &SpawnRequest,
        cgroup_procs_fd: i32,
        max_open_files: Option<u64>,
    ) -> Result<RunningChild, SandboxError> {
        if cgroup_procs_fd < 0 {
            return Err(SandboxError::SpawnFailed { reason: "invalid cgroup.procs descriptor".to_owned(), errno: None });
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (request, cgroup_procs_fd, max_open_files);
            return Err(SandboxError::Unsupported { reason: "cgroup-v2 process containment is Linux-only".to_owned(), dimension: None });
        }
        #[cfg(target_os = "linux")]
        { self.spawn_internal(request, Some(cgroup_procs_fd), max_open_files) }
    }

    fn spawn_internal(&self, request: &SpawnRequest, cgroup_procs_fd: Option<i32>, max_open_files: Option<u64>) -> Result<RunningChild, SandboxError> {
        let (mut command, running_state) = self.plan.command(request)?;
        // A confined command is owned by this host process. On Linux, make the
        // kernel terminate the direct sandbox child if the ExecutionHost dies,
        // including abrupt owner loss where Rust Drop/finalizers do not run.
        // Bubblewrap additionally uses --die-with-parent inside a fresh PID
        // namespace, which tears down its complete confined process tree.
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            let expected_parent = std::process::id() as libc::pid_t;
            // SAFETY: the child-side closure performs only `prctl` and `getppid`
            // syscalls before exec; it does not allocate or access shared state.
            unsafe {
                command.pre_exec(move || {
                    const PR_SET_PDEATHSIG: libc::c_int = 1;
                    if libc::prctl(PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    // Close the race where the parent exits between fork and
                    // arming the parent-death signal.
                    if libc::getppid() != expected_parent {
                        return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
                    }
                    if let Some(maximum) = max_open_files {
                        if maximum == 0 { return Err(std::io::Error::from_raw_os_error(libc::EINVAL)); }
                        let mut current = std::mem::MaybeUninit::<libc::rlimit>::uninit();
                        if libc::getrlimit(libc::RLIMIT_NOFILE, current.as_mut_ptr()) != 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        let current = unsafe { current.assume_init() };
                        let limit = maximum as libc::rlim_t;
                        if current.rlim_max < limit {
                            return Err(std::io::Error::from_raw_os_error(libc::EPERM));
                        }
                        let requested = libc::rlimit { rlim_cur: limit, rlim_max: limit };
                        if libc::setrlimit(libc::RLIMIT_NOFILE, &requested) != 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        let mut verified = std::mem::MaybeUninit::<libc::rlimit>::uninit();
                        if libc::getrlimit(libc::RLIMIT_NOFILE, verified.as_mut_ptr()) != 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        let verified = unsafe { verified.assume_init() };
                        if verified.rlim_cur != limit || verified.rlim_max != limit {
                            return Err(std::io::Error::from_raw_os_error(libc::EPERM));
                        }
                    }
                    if let Some(fd) = cgroup_procs_fd {
                        let mut digits = [0u8; 32];
                        let mut value = libc::getpid() as u32;
                        let mut cursor = digits.len();
                        loop {
                            cursor -= 1;
                            digits[cursor] = b'0' + (value % 10) as u8;
                            value /= 10;
                            if value == 0 { break; }
                        }
                        cursor -= 1;
                        digits[cursor] = b'\n';
                        let mut written = 0usize;
                        while written < digits.len() - cursor {
                            let result = libc::write(fd, digits[cursor + written..].as_ptr().cast(), digits.len() - cursor - written);
                            if result > 0 { written += result as usize; continue; }
                            if result < 0 && *libc::__errno_location() == libc::EINTR { continue; }
                            return Err(std::io::Error::last_os_error());
                        }
                    }
                    Ok(())
                });
            }
        }
        let child = command.spawn().map_err(|error| SandboxError::SpawnFailed {
            reason: format!("{}: {error}", request.program.display()),
            errno: error.raw_os_error(),
        })?;
        let pid = child.id();
        Ok(RunningChild {
            child,
            pid,
            backend: self.backend(),
            state: Some(running_state),
            cleanup_warnings: Vec::new(),
        })
    }

    /// Spawn, wait and return the exit outcome (no deadline handling).
    pub fn run(&self, request: &SpawnRequest) -> Result<ExitOutcome, SandboxError> {
        let mut child = self.spawn(request)?;
        child.wait()
    }
}

/// A running confined process.
///
/// Dropping this value does **not** kill the child: cancellation and
/// process-tree semantics belong to the ExecutionHost. If the child has
/// already exited when the value is dropped, tracked mount-target placeholders
/// are removed; otherwise they are left in place and
/// `cleanup_placeholders_now` can be called after the ExecutionHost has
/// reconciled the process tree.
pub struct RunningChild {
    child: Child,
    pid: u32,
    backend: &'static str,
    state: Option<platform::imp::RunningState>,
    cleanup_warnings: Vec<String>,
}

impl RunningChild {
    /// Operating system process id of the started process (the bubblewrap
    /// wrapper when a confined backend is active; it execs the payload).
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Access the underlying `std::process::Child` (bounded readers, signals).
    pub fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    /// Take the piped stdout stream, when `StdioPolicy::Piped` was requested.
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    /// Take the piped stdin stream, when `StdioPolicy::Piped` was requested.
    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }


    /// Take the piped stderr stream, when `StdioPolicy::Piped` was requested.
    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    /// Non-blocking reaping. On exit, tracked placeholders are cleaned up.
    pub fn try_wait(&mut self) -> Result<Option<ExitOutcome>, SandboxError> {
        let status = self
            .child
            .try_wait()
            .map_err(|error| SandboxError::WaitFailed {
                reason: error.to_string(),
            })?;
        match status {
            Some(status) => Ok(Some(self.finish(status))),
            None => Ok(None),
        }
    }

    /// Block until the child exits, then clean up tracked placeholders.
    pub fn wait(&mut self) -> Result<ExitOutcome, SandboxError> {
        let status = self
            .child
            .wait()
            .map_err(|error| SandboxError::WaitFailed {
                reason: error.to_string(),
            })?;
        Ok(self.finish(status))
    }

    /// Send a kill signal to the direct child only. Terminating a whole
    /// process tree is the ExecutionHost's responsibility.
    pub fn kill(&mut self) -> Result<(), SandboxError> {
        self.child.kill().map_err(|error| SandboxError::WaitFailed {
            reason: error.to_string(),
        })
    }

    /// Remove tracked mount-target placeholders now. Safe to call repeatedly;
    /// returns human-readable warnings for entries that could not be removed.
    pub fn cleanup_placeholders_now(&mut self) -> Vec<String> {
        match &mut self.state {
            Some(state) => state.cleanup(),
            None => Vec::new(),
        }
    }

    /// Cleanup warnings gathered so far.
    pub fn cleanup_warnings(&self) -> &[String] {
        &self.cleanup_warnings
    }

    fn finish(&mut self, status: ExitStatus) -> ExitOutcome {
        let warnings = self.cleanup_placeholders_now();
        self.cleanup_warnings.extend(warnings.iter().cloned());
        self.state = None;
        ExitOutcome::from_status(self.pid, status, self.backend, warnings)
    }
}

impl fmt::Debug for RunningChild {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunningChild")
            .field("pid", &self.pid)
            .field("backend", &self.backend)
            .finish_non_exhaustive()
    }
}

impl Drop for RunningChild {
    fn drop(&mut self) {
        // Best effort only: never kill, never delete while the child may still
        // be running. Reap opportunistically so a completed child does not
        // leave placeholder entries behind.
        if self.state.is_none() {
            return;
        }
        if let Ok(Some(status)) = self.child.try_wait() {
            let _ = self.finish(status);
        }
    }
}

/// Result of one confined execution.
#[derive(Clone, Debug)]
pub struct ExitOutcome {
    /// Process id that was started.
    pub pid: u32,
    /// Raw exit status.
    pub status: ExitStatus,
    /// Exit code when the process exited normally.
    pub code: Option<i32>,
    /// Terminating signal when the process was signalled.
    pub signal: Option<i32>,
    /// Enforcing backend that produced this outcome.
    pub backend: &'static str,
    /// Placement-cleanup warnings; empty when everything was removed.
    pub cleanup_warnings: Vec<String>,
}

impl ExitOutcome {
    fn from_status(
        pid: u32,
        status: ExitStatus,
        backend: &'static str,
        cleanup_warnings: Vec<String>,
    ) -> Self {
        #[cfg(unix)]
        let signal = std::os::unix::process::ExitStatusExt::signal(&status);
        #[cfg(not(unix))]
        let signal = None;
        Self {
            pid,
            status,
            code: status.code(),
            signal,
            backend,
            cleanup_warnings,
        }
    }

    /// True when the process exited with code 0.
    pub fn success(&self) -> bool {
        self.status.success()
    }
}

// ---------------------------------------------------------------------------
// Unit tests (no OS capability required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn no_capability_caps() -> Capabilities {
        Capabilities {
            platform: PlatformId::Linux {
                os_release: "test".to_string(),
                arch: "x86_64",
            },
            bwrap: BwrapStatus::Missing {
                reason: "test stub: bwrap absent".to_string(),
            },
            user_namespaces: CapabilityStatus::Unavailable {
                reason: "test stub".to_string(),
            },
            mount_namespaces: CapabilityStatus::Unavailable {
                reason: "test stub".to_string(),
            },
            pid_namespaces: CapabilityStatus::Unavailable {
                reason: "test stub".to_string(),
            },
            network_namespaces: CapabilityStatus::Unavailable {
                reason: "test stub".to_string(),
            },
            landlock_abi: None,
            landlock_probe_error: Some("test stub".to_string()),
        }
    }

    #[test]
    fn confined_profile_fails_closed_when_bwrap_is_absent() {
        let sandbox = Sandbox::with_capabilities(no_capability_caps());
        let error = sandbox
            .prepare(&SandboxProfile::workspace_write("/tmp/workspace"))
            .expect_err("confined profile must not prepare when bubblewrap is absent");
        assert!(
            matches!(error, SandboxError::Unsupported { .. }),
            "unexpected: {error}"
        );
    }

    #[test]
    fn landlock_backend_fails_closed_when_landlock_is_absent() {
        let sandbox = Sandbox::with_capabilities(no_capability_caps());
        let mut profile = match SandboxProfile::workspace_write("/tmp/workspace") {
            SandboxProfile::Confined(profile) => profile,
            SandboxProfile::FullAccess => unreachable!(),
        };
        profile.backend = ConfinementBackend::LandlockWriteScope;
        let error = sandbox
            .prepare(&SandboxProfile::Confined(profile))
            .expect_err("landlock backend must not prepare without Landlock");
        assert!(
            matches!(error, SandboxError::Unsupported { .. }),
            "unexpected: {error}"
        );
    }

    #[test]
    fn full_access_never_reports_an_enforced_dimension() {
        let sandbox = Sandbox::with_capabilities(no_capability_caps());
        let prepared = sandbox
            .prepare(&SandboxProfile::full_access())
            .expect("full-access prepares");
        assert_eq!(prepared.backend(), "none");
        assert_eq!(prepared.guarantees().len(), GuaranteeDimension::ALL.len());
        for assessment in prepared.guarantees() {
            assert_ne!(
                assessment.level,
                GuaranteeLevel::Enforced,
                "full-access must never claim enforcement ({})",
                assessment.dimension
            );
            assert!(
                !assessment.residuals.is_empty(),
                "unsupported dimensions must state a residual ({})",
                assessment.dimension
            );
        }
        assert!(matches!(
            prepared.require(GuaranteeDimension::FilesystemWrite, ExpectedLevel::ENFORCED),
            Err(SandboxError::GuaranteeNotMet { .. })
        ));
    }

    #[test]
    fn capability_record_is_deterministic_and_covers_the_matrix() {
        let sandbox = Sandbox::with_capabilities(no_capability_caps());
        let first = sandbox.capability_record();
        let second = sandbox.capability_record();
        assert_eq!(first, second, "capability record must be deterministic");
        for key in [
            "platform=",
            "bwrap_state=",
            "user_namespaces=",
            "mount_namespaces=",
            "pid_namespaces=",
            "network_namespaces=",
            "landlock_abi=",
            "landlock_write_scope=",
            "landlock_network_tcp=",
            "backend_bubblewrap=",
            "backend_landlock_write_scope=",
        ] {
            assert!(
                first.contains(key),
                "capability record misses {key}: {first}"
            );
        }
        assert!(first.contains("backend_bubblewrap=unavailable"));
    }

    #[test]
    fn canonical_descriptor_is_sorted_and_stable() {
        let mut profile = match SandboxProfile::workspace_write("/ws") {
            SandboxProfile::Confined(profile) => profile,
            SandboxProfile::FullAccess => unreachable!(),
        };
        profile.scoped_roots.push(ScopedRoot::read("/aaa"));
        profile.scoped_roots.push(ScopedRoot::read("/zzz"));
        profile.deny_masks.push("/ws/secret".into());
        profile.deny_masks.push("/ws/aws".into());
        let descriptor = SandboxProfile::Confined(profile.clone()).canonical_descriptor();
        let aaa = descriptor.find("read=/aaa").expect("read=/aaa present");
        let zzz = descriptor.find("read=/zzz").expect("read=/zzz present");
        let aws = descriptor
            .find("deny=/ws/aws")
            .expect("deny=/ws/aws present");
        let secret = descriptor
            .find("deny=/ws/secret")
            .expect("deny=/ws/secret present");
        assert!(aaa < zzz, "reads must be sorted");
        assert!(aws < secret, "deny masks must be sorted");
        assert_eq!(
            descriptor,
            SandboxProfile::Confined(profile).canonical_descriptor(),
            "descriptor must be stable"
        );
    }

    #[test]
    fn descriptor_id_matches_the_profile_vector() {
        assert_eq!(
            SandboxProfile::workspace_write("/ws").descriptor_id(),
            "workspace-write"
        );
        assert_eq!(
            SandboxProfile::readonly([PathBuf::from("/ws")]).descriptor_id(),
            "readonly"
        );
        assert_eq!(SandboxProfile::full_access().descriptor_id(), "full-access");
        let mut networked = match SandboxProfile::workspace_write("/ws") {
            SandboxProfile::Confined(profile) => profile,
            SandboxProfile::FullAccess => unreachable!(),
        };
        networked.network = NetworkPolicy::ShareHost;
        assert_eq!(
            SandboxProfile::Confined(networked).descriptor_id(),
            "networked-workspace-write"
        );
    }

    #[test]
    fn guarantee_record_lists_every_dimension() {
        let sandbox = Sandbox::with_capabilities(no_capability_caps());
        let prepared = sandbox
            .prepare(&SandboxProfile::full_access())
            .expect("full-access prepares");
        let record = prepared.guarantee_record();
        for dimension in GuaranteeDimension::ALL {
            assert!(
                record.contains(&format!("dimension={dimension}")),
                "record misses {dimension}: {record}"
            );
        }
    }

    #[test]
    fn env_policy_cleared_is_the_default() {
        let request = SpawnRequest::new("/bin/true");
        assert_eq!(request.env, EnvPolicy::Cleared);
        assert!(request.env_vars.is_empty());
        assert_eq!(request.stdin, StdioPolicy::Inherit);
    }
}
