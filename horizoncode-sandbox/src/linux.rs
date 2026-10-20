//! Linux implementation: bubblewrap namespaces + restricted mount view, and an
//! explicitly weaker Landlock write-scoping backend.
//!
//! Design decisions recorded here (also reported as residuals so nothing is
//! silently claimed):
//!
//! * The confined view starts as an empty `tmpfs /` and only the declared
//!   scoped roots plus `platform_default_reads` become visible (§14.5:
//!   "Reads limited to declared roots").
//! * Mount order decides precedence: read roots first, writable roots second,
//!   then read-only protection re-applied for read roots nested inside
//!   writable roots, then protected subpaths, then deny masks. The last mount
//!   wins, so deny beats write.
//! * Landlock is **not** layered on top of bubblewrap. An allowlist ruleset
//!   applied before `bwrap` runs would also constrain bwrap's own namespace
//!   setup (mount-target `mkdir`, device creation inside the fresh tmpfs),
//!   where the intermediate inodes are not beneath any allowlisted host path.
//!   The Landlock write-scoping backend therefore runs *without* namespaces and
//!   is reported as the weaker, explicitly requested mechanism it is.
//! * `--unshare-all` is always used; `--share-net` is added only for an
//!   explicit `NetworkPolicy::ShareHost`, which is reported as a residual and
//!   never as an enforced egress guarantee.

use std::ffi::OsString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use crate::landlock;
use crate::{
    BwrapStatus, Capabilities, CapabilityStatus, ConfinedProfile, ConfinementBackend,
    GuaranteeAssessment, GuaranteeDimension, GuaranteeLevel, MissingPlaceholder, NetworkPolicy,
    PlatformId, RootAccess, SandboxError, SandboxProfile, SpawnRequest,
};

/// Base descriptor number used for `--ro-bind-data` placeholder plumbing.
/// Kept far above the descriptors the standard library wires for stdio/pipes.
const PLACEHOLDER_FD_BASE: i32 = 100;

/// System read roots required to execute dynamically linked programs. Only
/// system-level paths; user data is never included implicitly.
const PLATFORM_DEFAULT_READ_ROOTS: [&str; 8] = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/nix/store",
    "/run/current-system/sw",
];

/// WSL2 Windows-interop socket directory. Reaching it escapes Linux
/// confinement into the unconfined Windows side, so it is masked by default.
const WSL_INTEROP_DIR: &str = "/run/WSL";

/// WSLg exposes a second view of the same distribution root. A path under it
/// would make path-based policy ambiguous, so such paths are rejected.
const WSLG_DISTRO_ROOT: &str = "/mnt/wslg/distro";

// ---------------------------------------------------------------------------
// Capability probing
// ---------------------------------------------------------------------------

/// Probe this Linux host. Every probe is empirical: namespace availability is
/// established by actually starting bubblewrap with that namespace flag.
pub(crate) fn probe_capabilities() -> Capabilities {
    let os_release = std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|release| release.trim().to_string())
        .unwrap_or_else(|error| format!("unknown ({error})"));
    let platform = PlatformId::Linux {
        os_release,
        arch: std::env::consts::ARCH,
    };
    let bwrap = probe_bwrap();
    let true_binary = find_trusted_system_executable("true");
    let (user_namespaces, mount_namespaces, pid_namespaces, network_namespaces) =
        probe_namespaces(&bwrap, true_binary.as_deref());
    let (landlock_abi, landlock_probe_error) = match landlock::probe_abi() {
        Ok(abi) => (Some(abi), None),
        Err(error) => (None, Some(error)),
    };
    Capabilities {
        platform,
        bwrap,
        user_namespaces,
        mount_namespaces,
        pid_namespaces,
        network_namespaces,
        landlock_abi,
        landlock_probe_error,
    }
}

fn probe_bwrap() -> BwrapStatus {
    let Some(path) = find_trusted_system_executable("bwrap") else {
        return BwrapStatus::Missing {
            reason: "no trusted root-owned system `bwrap` executable is available".to_string(),
        };
    };
    match Command::new(&path).arg("--version").output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let version = stdout
                .split_whitespace()
                .last()
                .map(str::to_string)
                .unwrap_or_else(|| stdout.trim().to_string());
            if version.is_empty() {
                BwrapStatus::Missing {
                    reason: format!("`{} --version` produced no version text", path.display()),
                }
            } else {
                BwrapStatus::Present { path, version }
            }
        }
        Ok(output) => BwrapStatus::Missing {
            reason: format!(
                "`{} --version` exited with {:?}: {}",
                path.display(),
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        },
        Err(error) => BwrapStatus::Missing {
            reason: format!("`{} --version` could not run: {error}", path.display()),
        },
    }
}

fn probe_namespaces(
    bwrap: &BwrapStatus,
    true_binary: Option<&Path>,
) -> (
    CapabilityStatus,
    CapabilityStatus,
    CapabilityStatus,
    CapabilityStatus,
) {
    let mut reasons = Vec::new();
    if let BwrapStatus::Missing { reason } = bwrap {
        reasons.push(reason.clone());
    }
    if true_binary.is_none() {
        reasons
            .push("no trusted root-owned system `true` binary for namespace probing".to_string());
    }
    if !reasons.is_empty() {
        let reason = reasons.join("; ");
        return (
            CapabilityStatus::Unavailable {
                reason: reason.clone(),
            },
            CapabilityStatus::Unavailable {
                reason: reason.clone(),
            },
            CapabilityStatus::Unavailable {
                reason: reason.clone(),
            },
            CapabilityStatus::Unavailable { reason },
        );
    }
    let BwrapStatus::Present { path, .. } = bwrap else {
        unreachable!("checked above")
    };
    let true_binary = true_binary.expect("checked above");
    (
        probe_bwrap_namespace(path, "--unshare-user", true_binary),
        probe_bwrap_namespace(path, "", true_binary),
        probe_bwrap_namespace(path, "--unshare-pid", true_binary),
        probe_bwrap_namespace(path, "--unshare-net", true_binary),
    )
}

fn probe_bwrap_namespace(bwrap: &Path, flag: &str, true_binary: &Path) -> CapabilityStatus {
    let mut command = Command::new(bwrap);
    if !flag.is_empty() {
        command.arg(flag);
    }
    command.args(["--die-with-parent", "--ro-bind", "/", "/"]);
    command.arg(true_binary);
    let mut rendered_parts = vec![bwrap.display().to_string()];
    if !flag.is_empty() {
        rendered_parts.push(flag.to_string());
    }
    rendered_parts.push("--die-with-parent".to_string());
    rendered_parts.push("--ro-bind / /".to_string());
    rendered_parts.push(true_binary.display().to_string());
    let rendered = rendered_parts.join(" ");
    match command.output() {
        Ok(output) if output.status.success() => CapabilityStatus::Available {
            evidence: format!("{rendered} -> exit 0"),
        },
        Ok(output) => CapabilityStatus::Unavailable {
            reason: format!(
                "{rendered} -> exit {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        },
        Err(error) => CapabilityStatus::Unavailable {
            reason: format!("{rendered} -> {error}"),
        },
    }
}

fn find_trusted_system_executable(name: &str) -> Option<PathBuf> {
    // Backend discovery is host authority, so neither repository configuration
    // nor the inherited PATH may select the program run during capability probes.
    for directory in ["/usr/bin", "/bin"] {
        let Ok(candidate) = std::fs::canonicalize(Path::new(directory).join(name)) else {
            continue;
        };
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !metadata.is_file() || metadata.mode() & 0o111 == 0 {
            continue;
        }
        // A writable ancestor allows replacement even if the file itself is read-only.
        let trusted = candidate.ancestors().all(|path| {
            std::fs::metadata(path)
                .is_ok_and(|metadata| metadata.uid() == 0 && metadata.mode() & 0o022 == 0)
        });
        if trusted {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/// A fully translated, capability-checked execution plan.
#[derive(Clone, Debug)]
pub(crate) struct Plan {
    kind: Kind,
    residuals: Vec<String>,
}

#[derive(Clone, Debug)]
enum Kind {
    Bubblewrap(BwrapPlan),
    Landlock(LandlockPlan),
    Bare,
}

#[derive(Clone, Debug)]
struct BwrapPlan {
    bwrap: PathBuf,
    /// bubblewrap arguments before `--chdir` and the payload command.
    args_prefix: Vec<OsString>,
    /// Number of placeholder descriptors to wire in the child before exec.
    placeholder_fds: usize,
    /// Placeholder mount targets created at sandbox setup, removed after exit.
    synthetic_targets: Vec<SyntheticTarget>,
    /// Roots visible in the prepared view (for cwd validation).
    visible_roots: Vec<PathBuf>,
    /// Paths hidden by deny masks (a cwd inside one cannot exist).
    denied: Vec<PathBuf>,
    /// Whether a fresh (private) `/tmp` exists in the view.
    private_tmp: bool,
}

#[derive(Clone, Debug)]
struct LandlockPlan {
    abi: u32,
    writable_roots: Vec<PathBuf>,
    deny_tcp: bool,
}

/// State that must outlive the child so host-side placeholders are removed.
#[derive(Debug, Default)]
pub(crate) struct RunningState {
    synthetic_targets: Vec<SyntheticTarget>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SyntheticTarget {
    path: PathBuf,
    kind: PlaceholderKind,
    owned_inode: Option<(u64, u64)>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlaceholderKind {
    EmptyFile,
    EmptyDir,
}

impl SyntheticTarget {
    fn remove(&self) -> Result<(), String> {
        let Some(identity) = self.owned_inode else {
            // A missing-at-preflight path is not an owned resource. In
            // particular, abandoning preflight must never delete a user path.
            return Ok(());
        };
        let metadata = match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("{}: {error}", self.path.display())),
        };
        if (metadata.dev(), metadata.ino()) != identity {
            return Err(format!(
                "{}: placeholder identity changed; left in place",
                self.path.display()
            ));
        }
        match self.kind {
            PlaceholderKind::EmptyFile => {
                if !metadata.file_type().is_file() || metadata.len() != 0 {
                    return Err(format!(
                        "{}: no longer an empty placeholder file; left in place",
                        self.path.display()
                    ));
                }
                std::fs::remove_file(&self.path)
                    .map_err(|error| format!("{}: {error}", self.path.display()))
            }
            PlaceholderKind::EmptyDir => {
                if !metadata.file_type().is_dir() {
                    return Err(format!(
                        "{}: no longer a placeholder directory; left in place",
                        self.path.display()
                    ));
                }
                match std::fs::read_dir(&self.path) {
                    Ok(mut entries) => {
                        if entries.next().is_some() {
                            return Err(format!(
                                "{}: placeholder directory is not empty; left in place",
                                self.path.display()
                            ));
                        }
                    }
                    Err(error) => return Err(format!("{}: {error}", self.path.display())),
                }
                std::fs::remove_dir(&self.path)
                    .map_err(|error| format!("{}: {error}", self.path.display()))
            }
        }
    }
}

impl RunningState {
    pub(crate) fn activate(&mut self) -> Result<(), SandboxError> {
        for target in &mut self.synthetic_targets {
            if target.owned_inode.is_some() {
                continue;
            }
            let created = match target.kind {
                PlaceholderKind::EmptyDir => {
                    std::fs::DirBuilder::new().mode(0o700).create(&target.path)
                }
                PlaceholderKind::EmptyFile => std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&target.path)
                    .map(drop),
            };
            if let Err(error) = created {
                let reason = format!("sandbox mount target changed since preflight: {error}");
                let _ = self.cleanup();
                return Err(SandboxError::ProfileInvalid { reason });
            }
            let metadata = std::fs::symlink_metadata(&target.path).map_err(|error| {
                SandboxError::ProfileInvalid {
                    reason: format!("sandbox mount target identity unavailable: {error}"),
                }
            })?;
            target.owned_inode = Some((metadata.dev(), metadata.ino()));
        }
        Ok(())
    }
    pub(crate) fn cleanup(&mut self) -> Vec<String> {
        let mut warnings = Vec::new();
        for target in &self.synthetic_targets {
            if let Err(warning) = target.remove() {
                warnings.push(warning);
            }
        }
        self.synthetic_targets.clear();
        warnings
    }
}

impl Drop for RunningState {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

impl Plan {
    pub(crate) fn backend_name(&self) -> &'static str {
        match self.kind {
            Kind::Bubblewrap(_) => "bubblewrap",
            Kind::Landlock(_) => "landlock",
            Kind::Bare => "none",
        }
    }

    pub(crate) fn prepare(
        profile: &SandboxProfile,
        capabilities: &Capabilities,
    ) -> Result<Plan, SandboxError> {
        match profile {
            SandboxProfile::FullAccess => Ok(Plan {
                kind: Kind::Bare,
                residuals: Vec::new(),
            }),
            SandboxProfile::Confined(confined) => match confined.backend {
                ConfinementBackend::Bubblewrap => prepare_bubblewrap(confined, capabilities),
                ConfinementBackend::LandlockWriteScope => prepare_landlock(confined, capabilities),
            },
        }
    }

    /// Build the command for one spawn request.
    pub(crate) fn command(
        &self,
        request: &SpawnRequest,
    ) -> Result<(Command, RunningState), SandboxError> {
        validate_program(request)?;
        match &self.kind {
            Kind::Bubblewrap(plan) => {
                let mut command = Command::new(&plan.bwrap);
                command.args(args_prefix_for_request(plan, request));
                if let Some(cwd) = &request.cwd {
                    validate_cwd_for_view(cwd, plan)?;
                    command.arg("--chdir").arg(cwd);
                }
                command.arg("--");
                command.arg(&request.program);
                command.args(&request.args);
                request.apply_env(&mut command);
                request.apply_stdio(&mut command);
                if plan.placeholder_fds > 0 {
                    let placeholders = plan.placeholder_fds;
                    // SAFETY: `pre_exec` runs between fork and exec; the
                    // closure performs raw file-descriptor syscalls only, with
                    // no allocation and no Rust I/O.
                    unsafe {
                        command.pre_exec(move || wire_placeholder_fds(placeholders));
                    }
                }
                let mut state = RunningState {
                    synthetic_targets: plan.synthetic_targets.clone(),
                };
                state.activate()?;
                Ok((command, state))
            }
            Kind::Landlock(plan) => self.landlock_command(request, plan),
            Kind::Bare => {
                let mut command = Command::new(&request.program);
                command.args(&request.args);
                if let Some(cwd) = &request.cwd {
                    command.current_dir(cwd);
                }
                request.apply_env(&mut command);
                request.apply_stdio(&mut command);
                Ok((command, RunningState::default()))
            }
        }
    }

    fn landlock_command(
        &self,
        request: &SpawnRequest,
        plan: &LandlockPlan,
    ) -> Result<(Command, RunningState), SandboxError> {
        let mut command = Command::new(&request.program);
        command.args(&request.args);
        if let Some(cwd) = &request.cwd {
            if !cwd.is_absolute() {
                return Err(SandboxError::ProfileInvalid {
                    reason: format!("cwd `{}` must be an absolute path", cwd.display()),
                });
            }
            if !cwd.is_dir() {
                return Err(SandboxError::ProfileInvalid {
                    reason: format!(
                        "cwd `{}` does not exist; the Landlock backend does not create it",
                        cwd.display()
                    ),
                });
            }
            command.current_dir(cwd);
        }
        request.apply_env(&mut command);
        request.apply_stdio(&mut command);

        // Open rule targets now: `pre_exec` may not allocate or touch the
        // filesystem, so descriptors and masks are prepared in the parent.
        let mut rule_fds: Vec<OwnedFd> = Vec::with_capacity(plan.writable_roots.len());
        for root in &plan.writable_roots {
            rule_fds.push(
                open_path_fd(root).map_err(|error| SandboxError::ProfileInvalid {
                    reason: format!(
                        "cannot open Landlock rule target `{}`: {error}",
                        root.display()
                    ),
                })?,
            );
        }
        let dev_null = match open_path_fd(Path::new("/dev/null")) {
            Ok(fd) => Some(fd),
            Err(_) => None,
        };
        let rights = landlock::write_scope_rights(plan.abi);
        let targets: Vec<(i32, u64)> = rule_fds.iter().map(|fd| (fd.as_raw_fd(), rights)).collect();
        let device_targets: Vec<i32> = dev_null.iter().map(AsRawFd::as_raw_fd).collect();
        let abi = plan.abi;
        let deny_tcp = plan.deny_tcp;
        let keepalive = (rule_fds, dev_null);
        // SAFETY: `pre_exec` runs between fork and exec; the closure performs
        // raw Landlock/prctl syscalls on already-open descriptors and
        // pre-computed masks only. `keepalive` holds the descriptors open until
        // the exec happens.
        unsafe {
            command.pre_exec(move || {
                let _keepalive = &keepalive;
                landlock::apply_write_scope(abi, &targets, &device_targets, deny_tcp)
            });
        }
        Ok((command, RunningState::default()))
    }

    /// Exact argv that `Plan::command` would execute.
    pub(crate) fn external_launch(
        &self,
        request: &SpawnRequest,
    ) -> Result<(Vec<OsString>, RunningState), SandboxError> {
        let Kind::Bubblewrap(plan) = &self.kind else {
            return Err(SandboxError::Unsupported {
                reason: "external PTY executor requires bubblewrap confinement".to_owned(),
                dimension: None,
            });
        };
        if plan.placeholder_fds != 0 {
            return Err(SandboxError::Unsupported {
                reason: "external PTY executor cannot install file-placeholder descriptors"
                    .to_owned(),
                dimension: None,
            });
        }
        Ok((
            self.command_line(request)?,
            RunningState {
                synthetic_targets: plan.synthetic_targets.clone(),
            },
        ))
    }

    /// Exact argv that `Plan::command` would execute.
    pub(crate) fn command_line(
        &self,
        request: &SpawnRequest,
    ) -> Result<Vec<OsString>, SandboxError> {
        validate_program(request)?;
        let mut argv = Vec::new();
        if let Kind::Bubblewrap(plan) = &self.kind {
            argv.push(plan.bwrap.clone().into_os_string());
            argv.extend(args_prefix_for_request(plan, request));
            if let Some(cwd) = &request.cwd {
                validate_cwd_for_view(cwd, plan)?;
                argv.push(OsString::from("--chdir"));
                argv.push(cwd.clone().into_os_string());
            }
            argv.push(OsString::from("--"));
        }
        argv.push(request.program.clone().into_os_string());
        argv.extend(request.args.iter().cloned());
        Ok(argv)
    }
}

fn args_prefix_for_request(plan: &BwrapPlan, request: &SpawnRequest) -> Vec<OsString> {
    if request.preserve_controlling_terminal {
        plan.args_prefix
            .iter()
            .filter(|argument| {
                argument.as_os_str() != std::ffi::OsStr::new("--new-session")
            })
            .cloned()
            .collect()
    } else {
        plan.args_prefix.clone()
    }
}

// ---------------------------------------------------------------------------
// Plan preparation
// ---------------------------------------------------------------------------

fn prepare_bubblewrap(
    confined: &ConfinedProfile,
    capabilities: &Capabilities,
) -> Result<Plan, SandboxError> {
    let status = capabilities.confined_backend(ConfinementBackend::Bubblewrap);
    let CapabilityStatus::Available { .. } = &status else {
        return Err(SandboxError::Unsupported {
            reason: status
                .reason()
                .unwrap_or("bubblewrap confinement is unavailable on this host")
                .to_string(),
            dimension: None,
        });
    };
    let BwrapStatus::Present { path: bwrap, .. } = &capabilities.bwrap else {
        return Err(SandboxError::Unsupported {
            reason: "bubblewrap is unavailable on this host".to_string(),
            dimension: None,
        });
    };

    // Bindings for the mount-view construction. The macros keep the argument
    // vector building readable while preserving strict mount order.
    let mut args: Vec<OsString> = Vec::new();
    macro_rules! push {
        ($($argument:expr),+ $(,)?) => {{
            $( args.push(OsString::from($argument)); )+
        }};
    }
    macro_rules! push_path {
        ($path:expr) => {{
            args.push($path.as_os_str().to_os_string());
        }};
    }

    let mut residuals: Vec<String> = Vec::new();
    let writable_roots = normalized_roots(confined, RootAccess::ReadWrite)?;
    let mut read_roots = normalized_roots(confined, RootAccess::ReadOnly)?;

    push!("--unshare-all");
    if confined.network == NetworkPolicy::ShareHost {
        push!("--share-net");
    }
    push!("--die-with-parent");
    push!("--new-session");

    // Base view. `/` is only bound when a scoped root asks for it; otherwise
    // the view starts empty so undeclared host paths simply do not exist.
    let binds_root = read_roots
        .iter()
        .any(|root| root.as_path() == Path::new("/"))
        || writable_roots
            .iter()
            .any(|root| root.as_path() == Path::new("/"));
    if binds_root {
        let root_writable = writable_roots
            .iter()
            .any(|root| root.as_path() == Path::new("/"));
        if root_writable {
            push!(
                "--bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--bind-try",
                "/dev/shm",
                "/dev/shm"
            );
        } else {
            push!("--ro-bind", "/", "/", "--dev", "/dev");
        }
    } else {
        push!("--tmpfs", "/", "--dev", "/dev");
    }

    if confined.private_tmp {
        push!("--tmpfs", "/tmp");
    }

    if confined.platform_default_reads {
        for root in PLATFORM_DEFAULT_READ_ROOTS {
            let root = PathBuf::from(root);
            if root.is_dir() && !read_roots.iter().any(|existing| existing == &root) {
                read_roots.push(root);
            }
        }
    }
    read_roots.sort_by_key(|path| path_depth(path));

    let mut visible_roots: Vec<PathBuf> = Vec::new();
    let mut nested_reads: Vec<PathBuf> = Vec::new();
    for root in &read_roots {
        if root.as_path() == Path::new("/") {
            visible_roots.push(root.clone());
            continue;
        }
        if writable_roots
            .iter()
            .any(|writable| root.starts_with(writable))
        {
            nested_reads.push(root.clone());
            residuals.push(format!(
                "read-only root `{}` is nested inside a writable root and is re-applied as a read-only bind",
                root.display()
            ));
        } else {
            push!("--ro-bind");
            push_path!(root);
            push_path!(root);
        }
        visible_roots.push(root.clone());
    }
    for root in &writable_roots {
        if root.as_path() != Path::new("/") {
            push!("--bind");
            push_path!(root);
            push_path!(root);
        }
        visible_roots.push(root.clone());
        if confined
            .protected_subpaths
            .iter()
            .any(|subpath| subpath.path == *root)
        {
            residuals.push(format!(
                "protected subpath `{}` equals writable root; the root ends up read-only",
                root.display()
            ));
        }
    }
    for root in &nested_reads {
        push!("--ro-bind");
        push_path!(root);
        push_path!(root);
    }

    // Roots provided by the sandbox itself exist in the view but not in a
    // host sense; they are visible for cwd validation.
    if confined.private_tmp {
        visible_roots.push(PathBuf::from("/tmp"));
    }
    visible_roots.push(PathBuf::from("/dev"));
    visible_roots.push(PathBuf::from("/proc"));

    // Protected subpaths: read-only carveouts that win over writable roots.
    let mut protected = confined.protected_subpaths.clone();
    protected.sort_by(|left, right| {
        path_depth(&left.path)
            .cmp(&path_depth(&right.path))
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut synthetic_targets: Vec<SyntheticTarget> = Vec::new();
    let mut placeholder_fds: usize = 0;
    for subpath in &protected {
        reject_reserved_mask_path(confined, &subpath.path, "protected subpath")?;
        if !is_visible(&subpath.path, &visible_roots) {
            return Err(SandboxError::ProfileInvalid {
                reason: format!(
                    "protected subpath `{}` is not reachable in the prepared view (not under any scoped or platform default root)",
                    subpath.path.display()
                ),
            });
        }
        if read_roots.iter().any(|root| subpath.path.starts_with(root)) {
            residuals.push(format!(
                "protected subpath `{}` already lies under a read-only root; protection is redundant",
                subpath.path.display()
            ));
            continue;
        }
        match classify_entry(&subpath.path)? {
            EntryKind::Missing => {
                require_existing_directory(
                    subpath.path.parent(),
                    &format!("parent of protected subpath `{}`", subpath.path.display()),
                )?;
                match subpath.when_missing {
                    MissingPlaceholder::Directory => {
                        push!("--perms", "555", "--tmpfs");
                        push_path!(&subpath.path);
                        push!("--remount-ro");
                        push_path!(&subpath.path);
                        synthetic_targets.push(SyntheticTarget {
                            path: subpath.path.clone(),
                            kind: PlaceholderKind::EmptyDir,
                            owned_inode: None,
                        });
                    }
                    MissingPlaceholder::File => {
                        let fd = PLACEHOLDER_FD_BASE + placeholder_fds as i32;
                        placeholder_fds += 1;
                        push!("--ro-bind-data", fd.to_string());
                        push_path!(&subpath.path);
                        synthetic_targets.push(SyntheticTarget {
                            path: subpath.path.clone(),
                            kind: PlaceholderKind::EmptyFile,
                            owned_inode: None,
                        });
                    }
                }
            }
            EntryKind::Directory | EntryKind::File => {
                push!("--ro-bind");
                push_path!(&subpath.path);
                push_path!(&subpath.path);
            }
        }
    }

    // Deny masks: hidden, not creatable. Deny wins over every bind above.
    let mut deny_masks = confined.deny_masks.clone();
    deny_masks.sort_by_key(|path| path_depth(path));
    for mask in &deny_masks {
        require_absolute(mask, "deny mask")?;
        reject_reserved_mask_path(confined, mask, "deny mask")?;
        match classify_entry(mask)? {
            EntryKind::Missing => {
                require_existing_directory(
                    mask.parent(),
                    &format!("parent of deny mask `{}`", mask.display()),
                )?;
                push!("--perms", "000", "--tmpfs");
                push_path!(mask);
                push!("--remount-ro");
                push_path!(mask);
                synthetic_targets.push(SyntheticTarget {
                    path: mask.clone(),
                    kind: PlaceholderKind::EmptyDir,
                    owned_inode: None,
                });
            }
            EntryKind::Directory => {
                push!("--perms", "000", "--tmpfs");
                push_path!(mask);
                push!("--remount-ro");
                push_path!(mask);
            }
            EntryKind::File => {
                // An empty read-only regular file: content hidden, writes fail
                // with EROFS instead of being silently discarded.
                let fd = PLACEHOLDER_FD_BASE + placeholder_fds as i32;
                placeholder_fds += 1;
                push!("--ro-bind-data", fd.to_string());
                push_path!(mask);
            }
        }
    }

    if confined.mask_wsl_interop && Path::new(WSL_INTEROP_DIR).exists() {
        push!(
            "--perms",
            "000",
            "--tmpfs",
            WSL_INTEROP_DIR,
            "--remount-ro",
            WSL_INTEROP_DIR
        );
        residuals.push(format!(
            "`{WSL_INTEROP_DIR}` masked (WSL2 Windows interop); binfmt_misc registration is not independently verified"
        ));
    }

    push!("--proc", "/proc", "--cap-drop", "ALL");

    if confined.network == NetworkPolicy::ShareHost {
        residuals.push(
            "profile explicitly shares the host network namespace; egress is not confined"
                .to_string(),
        );
    } else {
        residuals.push(
            "AF_UNIX sockets remain usable inside the empty network namespace; reachability of their paths is governed by the mount view"
                .to_string(),
        );
    }

    Ok(Plan {
        kind: Kind::Bubblewrap(BwrapPlan {
            bwrap: bwrap.clone(),
            args_prefix: args,
            placeholder_fds,
            synthetic_targets,
            visible_roots,
            denied: deny_masks,
            private_tmp: confined.private_tmp,
        }),
        residuals,
    })
}

fn prepare_landlock(
    confined: &ConfinedProfile,
    capabilities: &Capabilities,
) -> Result<Plan, SandboxError> {
    let status = capabilities.landlock_write_scope();
    let CapabilityStatus::Available { .. } = &status else {
        return Err(SandboxError::Unsupported {
            reason: status
                .reason()
                .unwrap_or("Landlock write scoping is unavailable on this host")
                .to_string(),
            dimension: Some(GuaranteeDimension::FilesystemWrite),
        });
    };
    let abi = capabilities
        .landlock_abi
        .expect("available status implies a probed ABI");

    let mut residuals = vec![
        "Landlock write scoping only: reads use the unconfined host filesystem view".to_string(),
    ];
    let writable_roots = normalized_roots(confined, RootAccess::ReadWrite)?;
    for root in &writable_roots {
        if !root.is_dir() {
            return Err(SandboxError::ProfileInvalid {
                reason: format!(
                    "Landlock writable root `{}` must be an existing directory",
                    root.display()
                ),
            });
        }
    }
    if !confined.protected_subpaths.is_empty() {
        let mut paths: Vec<String> = confined
            .protected_subpaths
            .iter()
            .map(|subpath| subpath.path.display().to_string())
            .collect();
        paths.sort();
        residuals.push(format!(
            "protected subpaths cannot be expressed by a Landlock allowlist and are NOT enforced by this backend: {}",
            paths.join(", ")
        ));
    }
    if !confined.deny_masks.is_empty() {
        let mut paths: Vec<String> = confined
            .deny_masks
            .iter()
            .map(|mask| mask.display().to_string())
            .collect();
        paths.sort();
        residuals.push(format!(
            "deny masks cannot be expressed by a Landlock allowlist and are NOT enforced by this backend: {}",
            paths.join(", ")
        ));
    }
    if abi < 2 {
        residuals
            .push("Landlock ABI 1: cross-directory rename (REFER) is not restricted".to_string());
    }
    if abi < 3 {
        residuals.push("Landlock ABI 2 or lower: truncate is not restricted".to_string());
    }
    let deny_tcp = confined.network == NetworkPolicy::DenyDefault;
    if deny_tcp {
        if abi >= 4 {
            residuals.push(
                "Landlock TCP rules cover TCP bind/connect only; UDP, DNS, raw sockets and other protocols are not confined"
                    .to_string(),
            );
        } else {
            residuals.push(
                "Landlock ABI below 4 cannot restrict TCP; network egress is not confined"
                    .to_string(),
            );
        }
    } else {
        residuals.push("profile explicitly shares the host network namespace".to_string());
    }
    residuals.push(
        "write allowlist covers the declared writable roots and /dev/null; other device nodes are not writable"
            .to_string(),
    );
    Ok(Plan {
        kind: Kind::Landlock(LandlockPlan {
            abi,
            writable_roots,
            deny_tcp,
        }),
        residuals,
    })
}

// ---------------------------------------------------------------------------
// Guarantee vector
// ---------------------------------------------------------------------------

pub(crate) fn guarantees(
    profile: &SandboxProfile,
    _capabilities: &Capabilities,
    plan: &Plan,
) -> Vec<GuaranteeAssessment> {
    let mut assessments = Vec::with_capacity(GuaranteeDimension::ALL.len());
    match profile {
        SandboxProfile::FullAccess => {
            for dimension in GuaranteeDimension::ALL {
                assessments.push(GuaranteeAssessment {
                    dimension,
                    level: GuaranteeLevel::Unsupported,
                    backend: "none",
                    residuals: vec![
                        "full-access profile: OS containment disabled by explicit high-risk opt-in"
                            .to_string(),
                    ],
                });
            }
        }
        SandboxProfile::Confined(confined) => match &plan.kind {
            Kind::Bubblewrap(_) => {
                let fs_read = GuaranteeAssessment {
                    dimension: GuaranteeDimension::FilesystemRead,
                    level: GuaranteeLevel::Enforced,
                    backend: "bubblewrap",
                    residuals: plan
                        .residuals
                        .iter()
                        .filter(|residual| residual.contains("read-only root"))
                        .cloned()
                        .collect(),
                };
                let fs_write = GuaranteeAssessment {
                    dimension: GuaranteeDimension::FilesystemWrite,
                    level: GuaranteeLevel::Enforced,
                    backend: "bubblewrap",
                    residuals: plan
                        .residuals
                        .iter()
                        .filter(|residual| {
                            residual.contains("protected subpath")
                                || residual.contains("writable root")
                        })
                        .cloned()
                        .collect(),
                };
                let network = GuaranteeAssessment {
                    dimension: GuaranteeDimension::NetworkEgress,
                    level: match confined.network {
                        NetworkPolicy::DenyDefault => GuaranteeLevel::Enforced,
                        NetworkPolicy::ShareHost => GuaranteeLevel::Unsupported,
                    },
                    backend: "bubblewrap",
                    residuals: if confined.network == NetworkPolicy::DenyDefault {
                        vec![
                            "AF_UNIX sockets remain usable inside the empty network namespace; reachability of their paths is governed by the mount view"
                                .to_string(),
                        ]
                    } else {
                        vec![
                            "profile explicitly shares the host network namespace; egress is not confined"
                                .to_string(),
                        ]
                    },
                };
                let process_tree = GuaranteeAssessment {
                    dimension: GuaranteeDimension::ProcessTree,
                    level: GuaranteeLevel::Enforced,
                    backend: "bubblewrap",
                    residuals: vec![
                        "child runs in a fresh user/pid/ipc/uts/cgroup namespace with --cap-drop ALL and --die-with-parent"
                            .to_string(),
                        "terminating the whole descendant tree and reconciling UNKNOWN remain ExecutionHost responsibilities"
                            .to_string(),
                    ],
                };
                let resource_limits = GuaranteeAssessment {
                    dimension: GuaranteeDimension::ResourceLimits,
                    level: GuaranteeLevel::Unsupported,
                    backend: "bubblewrap",
                    residuals: vec![
                        "no CPU/memory/FD limits are applied by this backend; kernel resource admission owns budgets"
                            .to_string(),
                    ],
                };
                let credentials = GuaranteeAssessment {
                    dimension: GuaranteeDimension::Credentials,
                    level: GuaranteeLevel::BestEffort,
                    backend: "bubblewrap",
                    residuals: vec![
                        "environment is cleared and rebuilt from the caller's allowlist by default"
                            .to_string(),
                        "bubblewrap injects PWD set to the child working directory (or `/` when no cwd is requested) even with a cleared environment"
                            .to_string(),
                        "host credential files stay readable when they fall inside scoped or platform default read roots (for example /etc); SecretBroker owns secret scoping"
                            .to_string(),
                    ],
                };
                let workspace_fence = GuaranteeAssessment {
                    dimension: GuaranteeDimension::WorkspaceFence,
                    level: GuaranteeLevel::Unsupported,
                    backend: "bubblewrap",
                    residuals: vec![
                        "workspace revision/lease fencing is owned by the kernel; this backend enforces filesystem access only"
                            .to_string(),
                    ],
                };
                assessments.extend([
                    fs_read,
                    fs_write,
                    network,
                    process_tree,
                    resource_limits,
                    credentials,
                    workspace_fence,
                ]);
            }
            Kind::Landlock(landlock_plan) => {
                let write_level = if landlock_plan.abi >= 3
                    && confined.protected_subpaths.is_empty()
                    && confined.deny_masks.is_empty()
                {
                    GuaranteeLevel::Enforced
                } else {
                    GuaranteeLevel::BestEffort
                };
                let network_level = match (confined.network, landlock_plan.abi) {
                    (NetworkPolicy::DenyDefault, abi) if abi >= 4 => GuaranteeLevel::BestEffort,
                    _ => GuaranteeLevel::Unsupported,
                };
                let write_residuals: Vec<String> = plan
                    .residuals
                    .iter()
                    .filter(|residual| {
                        residual.contains("protected subpath")
                            || residual.contains("deny mask")
                            || residual.contains("rename")
                            || residual.contains("truncate")
                            || residual.contains("device nodes")
                    })
                    .cloned()
                    .collect();
                assessments.extend([
                    GuaranteeAssessment {
                        dimension: GuaranteeDimension::FilesystemRead,
                        level: GuaranteeLevel::Unsupported,
                        backend: "landlock",
                        residuals: vec![
                            "Landlock-only backend does not restrict reads; the process keeps the host filesystem read view"
                                .to_string(),
                        ],
                    },
                    GuaranteeAssessment {
                        dimension: GuaranteeDimension::FilesystemWrite,
                        level: write_level,
                        backend: "landlock",
                        residuals: write_residuals,
                    },
                    GuaranteeAssessment {
                        dimension: GuaranteeDimension::NetworkEgress,
                        level: network_level,
                        backend: "landlock",
                        residuals: plan
                            .residuals
                            .iter()
                            .filter(|residual| {
                                residual.contains("TCP") || residual.contains("network namespace")
                            })
                            .cloned()
                            .collect(),
                    },
                    GuaranteeAssessment {
                        dimension: GuaranteeDimension::ProcessTree,
                        level: GuaranteeLevel::Unsupported,
                        backend: "landlock",
                        residuals: vec![
                            "no namespaces are created; the process sees the host pid namespace"
                                .to_string(),
                        ],
                    },
                    GuaranteeAssessment {
                        dimension: GuaranteeDimension::ResourceLimits,
                        level: GuaranteeLevel::Unsupported,
                        backend: "landlock",
                        residuals: vec!["no resource limits are applied by this backend".to_string()],
                    },
                    GuaranteeAssessment {
                        dimension: GuaranteeDimension::Credentials,
                        level: GuaranteeLevel::BestEffort,
                        backend: "landlock",
                        residuals: vec![
                            "environment is cleared and rebuilt from the caller's allowlist by default; filesystem secret scoping is not provided"
                                .to_string(),
                        ],
                    },
                    GuaranteeAssessment {
                        dimension: GuaranteeDimension::WorkspaceFence,
                        level: GuaranteeLevel::Unsupported,
                        backend: "landlock",
                        residuals: vec![
                            "workspace revision/lease fencing is owned by the kernel".to_string(),
                        ],
                    },
                ]);
            }
            Kind::Bare => {
                for dimension in GuaranteeDimension::ALL {
                    assessments.push(GuaranteeAssessment {
                        dimension,
                        level: GuaranteeLevel::Unsupported,
                        backend: "none",
                        residuals: vec![
                            "full-access profile: OS containment disabled by explicit high-risk opt-in"
                                .to_string(),
                        ],
                    });
                }
            }
        },
    }
    assessments
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn validate_program(request: &SpawnRequest) -> Result<(), SandboxError> {
    if !request.program.is_absolute() {
        return Err(SandboxError::ProfileInvalid {
            reason: format!(
                "program `{}` must be an absolute path; name resolution inside a cleared environment is not dependable",
                request.program.display()
            ),
        });
    }
    Ok(())
}

fn validate_cwd_for_view(cwd: &Path, plan: &BwrapPlan) -> Result<(), SandboxError> {
    if !cwd.is_absolute() {
        return Err(SandboxError::ProfileInvalid {
            reason: format!("cwd `{}` must be an absolute path", cwd.display()),
        });
    }
    if plan.denied.iter().any(|mask| cwd.starts_with(mask)) {
        return Err(SandboxError::ProfileInvalid {
            reason: format!(
                "cwd `{}` lies inside a deny mask of the prepared view",
                cwd.display()
            ),
        });
    }
    if cwd == Path::new("/") {
        return Ok(());
    }
    if plan.visible_roots.iter().any(|root| cwd.starts_with(root)) {
        return Ok(());
    }
    if plan.private_tmp && cwd.starts_with("/tmp") {
        return Ok(());
    }
    Err(SandboxError::ProfileInvalid {
        reason: format!(
            "cwd `{}` is not inside any scoped, platform default or private tmp root of the prepared view",
            cwd.display()
        ),
    })
}

fn normalized_roots(
    confined: &ConfinedProfile,
    access: RootAccess,
) -> Result<Vec<PathBuf>, SandboxError> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for root in &confined.scoped_roots {
        if root.access != access {
            continue;
        }
        let path = root.path.clone();
        require_absolute(&path, "scoped root")?;
        if is_wslg_distro(&path) {
            return Err(SandboxError::ProfileInvalid {
                reason: format!(
                    "scoped root `{}` is inside the WSLg duplicate distribution root; path-based policy would be ambiguous",
                    path.display()
                ),
            });
        }
        if !path.exists() {
            return Err(SandboxError::ProfileInvalid {
                reason: format!("scoped root `{}` does not exist", path.display()),
            });
        }
        if roots.iter().any(|existing| existing == &path) {
            continue;
        }
        roots.push(path);
    }
    roots.sort_by_key(|path| path_depth(path));
    Ok(roots)
}

fn require_absolute(path: &Path, what: &str) -> Result<(), SandboxError> {
    if !path.is_absolute() {
        return Err(SandboxError::ProfileInvalid {
            reason: format!("{what} `{}` must be an absolute path", path.display()),
        });
    }
    Ok(())
}

fn require_existing_directory(path: Option<&Path>, what: &str) -> Result<(), SandboxError> {
    let Some(path) = path else {
        return Err(SandboxError::ProfileInvalid {
            reason: format!("{what} has no parent directory"),
        });
    };
    if !path.is_dir() {
        return Err(SandboxError::ProfileInvalid {
            reason: format!(
                "{what} `{}` must already exist: bubblewrap would otherwise create host directories",
                path.display()
            ),
        });
    }
    Ok(())
}

/// Paths that the sandbox provides itself (`/dev`, `/proc`, private `/tmp`)
/// exist in the view but not as host objects, so a host-side bind or mask for
/// them would be ambiguous. They are rejected with a typed reason.
fn reject_reserved_mask_path(
    confined: &ConfinedProfile,
    path: &Path,
    what: &str,
) -> Result<(), SandboxError> {
    if is_wslg_distro(path) {
        return Err(SandboxError::ProfileInvalid {
            reason: format!(
                "{what} `{}` escapes through the WSLg duplicate distribution root",
                path.display()
            ),
        });
    }
    if path.starts_with("/dev") || path.starts_with("/proc") {
        return Err(SandboxError::ProfileInvalid {
            reason: format!(
                "{what} `{}` lies inside a sandbox-provided mount (/dev or /proc) and cannot be enforced from the host",
                path.display()
            ),
        });
    }
    // Explicit scoped roots are bind-mounted after the private tmpfs, so a
    // nested workspace under /tmp is a real host view and can be protected.
    // Unscoped /tmp entries still refer only to the private tmpfs.
    if confined.private_tmp
        && path.starts_with("/tmp")
        && !confined
            .scoped_roots
            .iter()
            .any(|root| root.path.starts_with("/tmp") && path.starts_with(&root.path))
    {
        return Err(SandboxError::ProfileInvalid {
            reason: format!(
                "{what} `{}` lies inside the private tmpfs mounted on /tmp; disable private_tmp or scope /tmp explicitly",
                path.display()
            ),
        });
    }
    Ok(())
}

fn is_wslg_distro(path: &Path) -> bool {
    path.starts_with(WSLG_DISTRO_ROOT)
}

fn is_visible(path: &Path, visible_roots: &[PathBuf]) -> bool {
    path == Path::new("/")
        || visible_roots
            .iter()
            .any(|root| root.as_path() == Path::new("/") || path.starts_with(root))
}

fn path_depth(path: &Path) -> usize {
    path.components().count()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EntryKind {
    Missing,
    Directory,
    File,
}

/// Classify a policy path. Directories and regular files can be bound
/// read-only or replaced by a mask mount; anything else is rejected.
fn classify_entry(path: &Path) -> Result<EntryKind, SandboxError> {
    // A symlink anywhere in the path would make the mount view bind or mask a
    // different object than the policy names.
    if has_symlink_component(path) {
        return Err(SandboxError::ProfileInvalid {
            reason: format!(
                "`{}` crosses a symlink component; a mount-view policy cannot enforce it reliably",
                path.display()
            ),
        });
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            if file_type.is_dir() {
                Ok(EntryKind::Directory)
            } else if file_type.is_file() {
                Ok(EntryKind::File)
            } else {
                Err(SandboxError::ProfileInvalid {
                    reason: format!(
                        "`{}` is neither a regular file nor a directory; entry type cannot be enforced safely",
                        path.display()
                    ),
                })
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(EntryKind::Missing),
        Err(error) => Err(SandboxError::ProfileInvalid {
            reason: format!("cannot inspect `{}`: {error}", path.display()),
        }),
    }
}

fn has_symlink_component(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => {
                current.push(Path::new("/"));
                continue;
            }
            Component::CurDir => continue,
            Component::ParentDir => {
                current.pop();
                continue;
            }
            Component::Normal(part) => current.push(part),
            Component::Prefix(_) => continue,
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return true;
                }
            }
            Err(_) => return false,
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Descriptor plumbing (child side, between fork and exec)
// ---------------------------------------------------------------------------

/// Wire `/dev/null` descriptors for `--ro-bind-data` placeholders. Runs in the
/// forked child before exec: raw syscalls only, no allocation.
fn wire_placeholder_fds(count: usize) -> std::io::Result<()> {
    for index in 0..count {
        let target = PLACEHOLDER_FD_BASE + index as i32;
        // SAFETY: plain `open(2)` on a constant path with constant flags.
        let fd = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if fd == target {
            // SAFETY: clearing FD_CLOEXEC on our own descriptor.
            unsafe { libc::fcntl(fd, libc::F_SETFD, 0) };
            continue;
        }
        // SAFETY: `dup2` with valid descriptors; the duplicate clears
        // FD_CLOEXEC so bubblewrap can read it after exec.
        if unsafe { libc::dup2(fd, target) } < 0 {
            let error = std::io::Error::last_os_error();
            // SAFETY: closing the descriptor we just opened.
            unsafe { libc::close(fd) };
            return Err(error);
        }
        // SAFETY: closing the original descriptor; the duplicate stays open.
        unsafe { libc::close(fd) };
    }
    Ok(())
}

/// Open a path with `O_PATH` for Landlock rule targets (no read permission is
/// required, and the descriptor is CLOEXEC).
fn open_path_fd(path: &Path) -> std::io::Result<OwnedFd> {
    let bytes = path.as_os_str().as_bytes();
    let c_path = std::ffi::CString::new(bytes)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: `c_path` is a valid NUL-terminated string; flags are constants.
    let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `fd` is a fresh descriptor returned by `open`.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
