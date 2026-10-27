//! Bounded, owner-managed terminal process backends.
//!
//! Commands, arguments, working directories, and environment values are never logged. The
//! supplied environment replaces the inherited environment; an empty map means empty env.
//!
//! On Linux a dedicated supervisor process owns the PTY session: it is the parent of the
//! session leader and a child subreaper, so owner loss (including a SIGKILLed owner) is
//! detected through a keepalive pipe and triggers a bounded process-tree kill and sweep
//! before the supervisor exits. The leader's exit status is relayed only when the
//! supervisor itself observed it and then proved the complete session tree empty.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::{Duration, Instant};

use crate::guard::is_blake3_digest;

/// Maximum private stdio frame; enough for the complete bounded 1 MiB CodeMode
/// call wave plus framing overhead. Aggregate process input remains separately capped.
pub const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_STDIO_ARGUMENTS: usize = 128;
pub const MAX_STDIO_ARGUMENT_BYTES: usize = 64 * 1024;
pub const MAX_STDIO_ENV_ITEMS: usize = 32;
pub const MAX_STDIO_ENV_VALUE_BYTES: usize = 4 * 1024;
pub const MAX_STDIO_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_STDIO_OUTPUT_PAGE_BYTES: usize = 256 * 1024;
/// Maximum prompt-scratch document that the editor service will open or import.
pub const MAX_EXTERNAL_EDITOR_SCRATCH_BYTES: u64 = 1024 * 1024;

/// Establish that the current OS has the same enforcing backend guarantees that
/// every guarded process launch requires. This preflight creates no child and is
/// used before HostKernel advertises the effects/ExecutionHost feature surface.
pub fn guard_execution_backend_ready() -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        return Err("guarded process confinement is unavailable on this platform".to_owned());
    }
    #[cfg(target_os = "linux")]
    {
        use horizoncode_sandbox::{ExpectedLevel, GuaranteeDimension, Sandbox, SandboxProfile};
        static SANDBOX: std::sync::OnceLock<Sandbox> = std::sync::OnceLock::new();
        let sandbox = SANDBOX.get_or_init(Sandbox::probe);
        let root = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| "guarded process temp root is unavailable".to_owned())?;
        let prepared = sandbox
            .prepare(&SandboxProfile::workspace_write(&root))
            .map_err(|_| "guarded process confinement backend is unavailable".to_owned())?;
        for dimension in [
            GuaranteeDimension::FilesystemRead,
            GuaranteeDimension::FilesystemWrite,
            GuaranteeDimension::NetworkEgress,
            GuaranteeDimension::ProcessTree,
        ] {
            prepared
                .require(dimension, ExpectedLevel::ENFORCED)
                .map_err(|_| format!("guarded process guarantee `{dimension}` is not enforced"))?;
        }
        Ok(())
    }
}
pub const MAX_STDIO_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const STDIO_OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const MAX_STDIO_INPUT_TOTAL_BYTES: usize = 16 * 1024 * 1024;

/// Fixed host-owned CodeMode containment policy. This is not caller input or a
/// general managed ResourcePolicy projection; changing any value requires a new
/// schema version and digest domain.
pub(crate) struct CodeModeResourceProfileV1;

impl CodeModeResourceProfileV1 {
    pub(crate) const MEMORY_MAX: &'static str = "536870912";
    pub(crate) const CPU_MAX: &'static str = "100000 100000";
    pub(crate) const PIDS_MAX: &'static str = "64";
    pub(crate) const MEMORY_MAX_BYTES: u64 = 536_870_912;
    pub(crate) const CPU_MAX_QUOTA: u64 = 100_000;
    pub(crate) const CPU_MAX_PERIOD: u64 = 100_000;
    pub(crate) const PIDS_MAX_COUNT: u64 = 64;
    pub(crate) const NOFILE_MAX: u64 = 256;

    pub(crate) fn digest() -> String {
        use crate::protocol::Value;
        let value = Value::Map(BTreeMap::from([
            ("cpuMaxPeriod".to_owned(), Value::Unsigned(Self::CPU_MAX_PERIOD)),
            ("cpuMaxQuota".to_owned(), Value::Unsigned(Self::CPU_MAX_QUOTA)),
            ("memoryMaxBytes".to_owned(), Value::Unsigned(Self::MEMORY_MAX_BYTES)),
            ("nofileMax".to_owned(), Value::Unsigned(Self::NOFILE_MAX)),
            ("pidsMax".to_owned(), Value::Unsigned(Self::PIDS_MAX_COUNT)),
            ("profileId".to_owned(), Value::String("codemode.v1".to_owned())),
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
        ]));
        let encoded = crate::messagepack::encode(&value, crate::messagepack::FRAME_LIMITS)
            .expect("fixed CodeMode resource profile fits the canonical frame");
        let mut preimage = b"horizoncode.codemode-resource-profile.v1\0".to_vec();
        preimage.extend_from_slice(&encoded);
        format!("blake3:{}", blake3::hash(&preimage).to_hex())
    }
}

/// Fixed packaged CodeMode helper artifact resolved only from trusted HostKernel
/// installation roots. The model and private frame never choose these paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeHelperPackageV1 {
    pub(crate) executable: PathBuf,
    pub(crate) executable_digest: String,
    pub(crate) package_root: PathBuf,
    pub(crate) entrypoint: PathBuf,
    pub(crate) entrypoint_relative: PathBuf,
    pub(crate) helper_digest: String,
}

impl CodeModeHelperPackageV1 {
    pub(crate) const SELECTOR: &'static str = "horizoncode:codemode:bun";
    pub(crate) const PROFILE_ID: &'static str = "codemode.v1";
    pub(crate) const PROFILE_REVISION: u64 = 1;

    /// Resolve the fixed selector plus the bundled, self-contained helper asset.
    /// `trusted_asset_root` and `relative_entrypoint` are HostKernel installation
    /// metadata, never request fields. Every path component is checked without
    /// following a symlink and the exact SHA-256 asset digest is compared to the
    /// authenticated CodeMode enablement/Attempt projection.
    pub(crate) fn resolve(
        trusted_selectors: &BTreeMap<String, PathBuf>,
        trusted_asset_root: &Path,
        relative_entrypoint: &Path,
        expected_helper_digest: &str,
    ) -> io::Result<Self> {
        if !crate::guard::is_sha256_digest(expected_helper_digest)
            || relative_entrypoint.as_os_str().is_empty()
            || relative_entrypoint.to_str().is_none_or(|value| value.is_empty() || value.len() > 1024)
            || relative_entrypoint.is_absolute()
            || relative_entrypoint.components().any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(invalid_launch_profile());
        }
        let executable_candidate = trusted_selectors.get(Self::SELECTOR).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "fixed CodeMode Bun selector is unavailable")
        })?;
        let executable = std::fs::canonicalize(executable_candidate)?;
        let executable_metadata = std::fs::metadata(&executable)?;
        if !executable_candidate.is_absolute() || !executable_metadata.is_file() {
            return Err(invalid_launch_profile());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if executable_metadata.permissions().mode() & 0o111 == 0 {
                return Err(invalid_launch_profile());
            }
        }
        let package_root = std::fs::canonicalize(trusted_asset_root)?;
        if !package_root.is_absolute() || !std::fs::metadata(&package_root)?.is_dir() {
            return Err(invalid_launch_profile());
        }
        let mut candidate = package_root.clone();
        for component in relative_entrypoint.components() {
            let std::path::Component::Normal(segment) = component else { return Err(invalid_launch_profile()) };
            candidate.push(segment);
            let metadata = std::fs::symlink_metadata(&candidate)?;
            if metadata.file_type().is_symlink() {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "CodeMode helper asset contains a symlink"));
            }
        }
        let entrypoint = std::fs::canonicalize(candidate)?;
        let metadata = std::fs::metadata(&entrypoint)?;
        if !entrypoint.starts_with(&package_root) || !metadata.is_file() || metadata.len() == 0 || metadata.len() > 16 * 1024 * 1024 {
            return Err(invalid_launch_profile());
        }
        let bytes = read_fixed_helper(&entrypoint)?;
        let actual_helper_digest = format!("sha256:{}", ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref().iter().map(|byte| format!("{byte:02x}")).collect::<String>());
        if actual_helper_digest != expected_helper_digest {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "packaged CodeMode helper digest changed"));
        }
        Ok(Self {
            executable_digest: executable_digest(&executable)?,
            executable,
            package_root,
            entrypoint,
            entrypoint_relative: relative_entrypoint.to_path_buf(),
            helper_digest: actual_helper_digest,
        })
    }

    pub(crate) fn launch_profile_digest(&self) -> io::Result<String> {
        use crate::protocol::Value;
        let value = Value::Map(BTreeMap::from([
            ("executableDigest".to_owned(), Value::String(self.executable_digest.clone())),
            ("helperDigest".to_owned(), Value::String(self.helper_digest.clone())),
            ("helperSelector".to_owned(), Value::String(Self::SELECTOR.to_owned())),
            ("relativeEntrypoint".to_owned(), Value::String(self.entrypoint_relative.to_string_lossy().into_owned())),
            ("resourceProfileDigest".to_owned(), Value::String(CodeModeResourceProfileV1::digest())),
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
        ]));
        let encoded = crate::messagepack::encode(&value, crate::messagepack::FRAME_LIMITS)
            .map_err(|_| invalid_launch_profile())?;
        let mut preimage = b"horizoncode.codemode-launch-profile.v1\0".to_vec();
        preimage.extend_from_slice(&encoded);
        Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
    }
}

fn read_fixed_helper(path: &Path) -> io::Result<Vec<u8>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid_launch_profile());
    }
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err(invalid_launch_profile());
    }
    Ok(bytes)
}

#[derive(Clone, Debug)]
pub struct TerminalLaunchSpec {
    pub executable: PathBuf,
    /// Argument vector excluding the executable (as with `Command::args`).
    pub argv: Vec<OsString>,
    pub cwd: PathBuf,
    /// Complete child environment; the ambient environment is never inherited.
    pub env: BTreeMap<OsString, OsString>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalBackend {
    LinuxPty,
    WindowsConPty,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessGuarantees {
    /// A successful `try_wait` observes the leader exit. The Linux PTY backend also
    /// withholds that result until its complete process-tree sweep proves quiescence.
    pub observed_exit: bool,
    /// Owner/process-handle close is configured to kill the process tree.
    pub tree_kill_on_owner_close: bool,
    /// Whether process-group/job termination is available on this backend.
    pub process_tree_termination: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminationReason {
    Cancelled,
    TimedOut,
    OwnerLost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    Exited(ExitStatus),
    TimedOut,
}

pub struct TerminalProcess {
    inner: platform::Process,
    // Drop order is significant: reap the process tree before removing mount targets.
    _confinement: Option<horizoncode_sandbox::ExternalLaunch>,
    #[cfg(target_os = "linux")]
    cgroup: Option<crate::cgroup_v2::ExecutionCgroupV2>,
}

pub struct PreparedTerminalLaunch {
    spec: TerminalLaunchSpec,
    confinement: Option<horizoncode_sandbox::ExternalLaunch>,
    guarantee_record: String,
    launch_digest: String,
    executable_path: PathBuf,
    executable_digest: String,
    cgroup_hierarchy_hidden: bool,
    #[cfg(target_os = "linux")]
    cgroup: Option<crate::cgroup_v2::ExecutionCgroupV2>,
    cgroup_required: bool,
}

/// Exact durable marker for an explicitly authenticated Full Access launch. It is
/// written into the HostKernel consent preflight and is the only record that lets
/// EffectHost settle a cgroup-less terminal effect using the supervised process
/// tree observation instead of cgroup emptiness. Any other record keeps the
/// outcome UNKNOWN.
pub(crate) const FULL_ACCESS_GUARANTEE_RECORD: &str = "explicit direct-session Full Access; no HorizonCode filesystem/network sandbox and no cgroup containment claim; supervised process-group lifetime only; restart without exact process-tree proof is UNKNOWN";

/// A host-resolved, bounded request for a non-PTY process. Callers must resolve the
/// executable reference from a trusted profile registry before constructing this value;
/// the digest is rechecked immediately before confinement preparation.
#[derive(Clone, Debug)]
pub struct StdioLaunchSpec {
    pub executable: PathBuf,
    pub executable_digest: String,
    /// Present only for the fixed packaged CodeMode helper launch.
    pub(crate) code_mode_helper: Option<CodeModeHelperPackageV1>,
    pub profile_digest: String,
    pub workspace_revision: String,
    pub argv: Vec<OsString>,
    pub cwd: PathBuf,
    pub workspace_root: PathBuf,
    /// Dedicated writable cache/data roots. The source workspace remains read-only
    /// unless it is explicitly present here.
    pub writable_roots: Vec<PathBuf>,
    /// Complete environment; only the fixed non-secret allowlist is accepted.
    pub env: BTreeMap<OsString, OsString>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
    /// Ordinary processes keep Git metadata protected. Only the HostKernel-minted
    /// Git worktree profile may opt into the exact `.git/worktrees` exception.
    filesystem_policy: StdioFilesystemPolicyV1,
    /// Set only by the fixed Git read-spec constructor. `files.read` cannot be
    /// repurposed by another in-crate caller as arbitrary process execution.
    fixed_git_read: bool,
    /// Retain bytes for a crate-internal evidence producer. Ordinary terminal
    /// processes keep this off to avoid a second in-memory output copy.
    capture_output_for_host: bool,
}

/// Fixed, structured operations accepted by the HostKernel's authenticated Git-read
/// route. These values cannot name an executable, cwd, environment, or arbitrary argv.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GitReadOperationV1 {
    Status { include_untracked: bool },
    Diff {
        base_oid: Option<String>,
        target_oid: Option<String>,
        paths: Vec<String>,
        context_lines: u8,
    },
    Log { revision: String, limit: u8 },
    Show { revision: String, path: String },
    BranchList,
}

const MAX_GIT_READ_PATHS: usize = 128;
pub(crate) const MAX_GIT_READ_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

fn valid_stdio_blake3(value: &str) -> bool {
    value.strip_prefix("blake3:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn invalid_stdio_launch() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "fixed Git read launch is invalid")
}

fn valid_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_git_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.starts_with('/')
        && !value.starts_with('\\')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Build a bounded, read-only Git process spec for a host-selected executable and
/// authenticated registered Location. The caller still performs normal Guard lease
/// admission, preflight, dispatch, and receipt settlement before launch.
pub(crate) fn prepare_git_read_spec(
    executable: PathBuf,
    executable_digest: String,
    profile_digest: String,
    workspace_revision: String,
    root: PathBuf,
    operation: GitReadOperationV1,
    output_limit: usize,
) -> io::Result<StdioLaunchSpec> {
    if !executable.is_absolute()
        || !root.is_absolute()
        || !valid_stdio_blake3(&profile_digest)
        || !valid_stdio_blake3(&workspace_revision)
        || !valid_stdio_blake3(&executable_digest)
        || !(1..=MAX_GIT_READ_OUTPUT_BYTES).contains(&output_limit)
    {
        return Err(invalid_stdio_launch());
    }

    let mut argv = vec![
        OsString::from("--no-optional-locks"),
        OsString::from("-c"),
        OsString::from("core.fsmonitor=false"),
        OsString::from("-c"),
        OsString::from("core.hooksPath=/dev/null"),
        OsString::from("-c"),
        OsString::from("core.pager=cat"),
        OsString::from("-c"),
        OsString::from("diff.external="),
    ];
    match operation {
        GitReadOperationV1::Status { include_untracked } => {
            argv.extend(["status", "--porcelain=v1", "-z", "--untracked-files=all"]
                .into_iter().map(OsString::from));
            if !include_untracked {
                argv.pop();
                argv.push(OsString::from("--untracked-files=no"));
            }
        }
        GitReadOperationV1::Diff { base_oid, target_oid, paths, context_lines } => {
            if context_lines > 20 || paths.len() > MAX_GIT_READ_PATHS
                || base_oid.as_deref().is_some_and(|oid| !valid_git_object_id(oid))
                || target_oid.as_deref().is_some_and(|oid| !valid_git_object_id(oid))
                || paths.iter().any(|path| !valid_git_relative_path(path))
            {
                return Err(invalid_stdio_launch());
            }
            argv.extend([
                "diff", "--no-ext-diff", "--no-textconv", "--no-color",
                "--no-renames",
            ].into_iter().map(OsString::from));
            argv.push(OsString::from(format!("--unified={context_lines}")));
            if let Some(base) = base_oid { argv.push(OsString::from(base)); }
            if let Some(target) = target_oid { argv.push(OsString::from(target)); }
            argv.push(OsString::from("--"));
            argv.extend(paths.into_iter().map(|path| OsString::from(format!(":(literal){path}"))));
        }
        GitReadOperationV1::Log { revision, limit } => {
            if !valid_git_object_id(&revision) || !(1..=100).contains(&limit) {
                return Err(invalid_stdio_launch());
            }
            argv.extend([
                "log", "--no-color", "--no-show-signature",
                "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00",
                "-n",
            ].into_iter().map(OsString::from));
            argv.push(OsString::from(limit.to_string()));
            argv.push(OsString::from(revision));
        }
        GitReadOperationV1::Show { revision, path } => {
            if !valid_git_object_id(&revision) || !valid_git_relative_path(&path) {
                return Err(invalid_stdio_launch());
            }
            argv.extend([
                "show", "--no-color", "--no-ext-diff", "--no-textconv",
                "--format=",
            ].into_iter().map(OsString::from));
            argv.push(OsString::from(format!("{revision}:{path}")));
        }
        GitReadOperationV1::BranchList => {
            argv.extend([
                "for-each-ref", "--sort=refname",
                "--format=%(refname:short)%00%(objectname)%00%(objecttype)%00",
                "refs/heads/",
            ].into_iter().map(OsString::from));
        }
    }
    if argv.len() > 140 {
        return Err(invalid_stdio_launch());
    }
    let mut spec = StdioLaunchSpec::new(executable, executable_digest, argv, root.clone());
    spec.workspace_root = root;
    spec.profile_digest = profile_digest;
    spec.workspace_revision = workspace_revision;
    spec.timeout = Duration::from_secs(10);
    spec.max_output_bytes = output_limit;
    spec.use_readonly_workspace();
    spec.fixed_git_read = true;
    spec.retain_output_for_host();
    // Replace inherited variables; Git sees no HOME/config search path or prompts.
    spec.env.insert(OsString::from("HOME"), OsString::from("/nonexistent"));
    spec.env.insert(OsString::from("GIT_CONFIG_NOSYSTEM"), OsString::from("1"));
    spec.env.insert(OsString::from("GIT_CONFIG_GLOBAL"), OsString::from("/dev/null"));
    spec.env.insert(OsString::from("GIT_CONFIG_SYSTEM"), OsString::from("/dev/null"));
    spec.env.insert(OsString::from("GIT_TERMINAL_PROMPT"), OsString::from("0"));
    spec.env.insert(OsString::from("GIT_OPTIONAL_LOCKS"), OsString::from("0"));
    spec.env.insert(OsString::from("GIT_NO_REPLACE_OBJECTS"), OsString::from("1"));
    Ok(spec)
}

#[derive(Clone, Debug, Default)]
enum StdioFilesystemPolicyV1 {
    #[default]
    WorkspaceWrite,
    /// LSP/DAP adapter profile: workspace is readable but never writable.
    /// Network and undeclared filesystem access remain denied by the OS profile.
    ReadOnlyWorkspace,
    /// Managed Inspect reads one exact child worktree and one authenticated Git
    /// metadata directory. Both roots remain read-only and separately scoped.
    ReadOnlyGitWorktreeMetadata { metadata_root: PathBuf },
    GitWorktreeLifecycle {
        metadata_root: PathBuf,
        destination_parent: PathBuf,
    },
    /// CodeMode receives only the sandbox's private temporary root and the
    /// platform runtime/library roots. The caller's registered workspace is
    /// authenticated but is never mounted into the helper view.
    CodeModeIsolated {
        package_root: PathBuf,
        entrypoint: PathBuf,
        helper_digest: String,
    },
}

/// One immutable Core Config projection for one supervised broker-process launch.
/// It is a per-request proof, not a HostKernel profile registry. Project/plugin
/// definitions must be rejected by Core before they reach this boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionLaunchProfileV1 {
    pub profile_id: String,
    pub revision: u64,
    pub kind: StdioProcessKindV1,
    pub executable_selector: String,
    pub argv: Vec<OsString>,
    /// Explicit DAP policy; omitted on the wire means default-deny. The optional
    /// representation is retained so profile digest canonicalization preserves the
    /// exact Core Config definition.
    pub dap_policy_allow_evaluate: Option<bool>,
}

/// Canonical reference to the exact Core Config launch definition projected for one
/// HostKernel launch. The definition and reference must arrive together on the
/// authenticated private RPC; this value is not a selector or launch authority on its
/// own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionLaunchProfileRefV1 {
    pub profile_id: String,
    pub revision: u64,
    pub profile_digest: String,
}

/// Strict immutable Core Config projection for a user-selected external editor.
/// This definition is configuration only; HostKernel must resolve its executable
/// selector from trusted Core state and bind the resulting process to an authenticated
/// root Session user action before constructing any launch binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalEditorProfileV1 {
    pub profile_id: String,
    pub revision: u64,
    pub executable_selector: String,
    pub argv: Vec<OsString>,
    pub target_arg_index: usize,
    pub launch_mode: ExternalEditorLaunchModeV1,
    pub target_kinds: Vec<ExternalEditorTargetKindV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalEditorProfileRefV1 {
    pub profile_id: String,
    pub revision: u64,
    pub profile_digest: String,
}

/// Authenticated HostKernel handoff for the P1 editor preflight. This is an
/// in-process Rust value, never a public RPC payload; HostKernel must mint it
/// after deriving the principal, owner epoch, target and normal Guard lease.
/// Constructing it does not itself authorize dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExternalEditorLaunchBindingV1 {
    pub(crate) execution_id: String,
    pub(crate) session_id: String,
    pub(crate) principal: String,
    pub(crate) location_id: String,
    pub(crate) owner_epoch: u64,
    pub(crate) generation: u64,
    pub(crate) user_action_id: String,
    pub(crate) call_id: String,
    pub(crate) profile_ref: ExternalEditorProfileRefV1,
    pub(crate) profile: ExternalEditorProfileV1,
    pub(crate) executable_path: PathBuf,
    pub(crate) executable_digest: String,
    pub(crate) target: ExternalEditorTargetBindingV1,
    pub(crate) workspace_root: PathBuf,
    pub(crate) workspace_root_binding: String,
    pub(crate) permission_mode: crate::guard::DirectSessionPermissionModeProjectionV1,
    pub(crate) capability_lease_digest: String,
    pub(crate) effect_id: String,
    pub(crate) challenge_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExternalEditorTargetBindingV1 {
    pub(crate) kind: ExternalEditorTargetKindV1,
    /// One literal argv value naming the host-created private scratch file. The
    /// original workspace path is never passed to the editor.
    pub(crate) canonical_target_token: String,
    /// Exact user-selected root-relative source path for workspace editing; empty
    /// for prompt scratch. This is retained as a digest in the durable journal.
    pub(crate) source_relative_path: String,
    /// Exact preview source revision and source content digest. For workspace
    /// editing these are checked before launch and again before result settlement.
    pub(crate) base_workspace_revision: String,
    pub(crate) expected_file_digest: Option<String>,
    /// Host-created owner-only directory containing the scratch target.
    pub(crate) scratch_root: PathBuf,
}

impl ExternalEditorProfileRefV1 {
    pub fn from_value(value: &crate::protocol::Value) -> io::Result<Self> {
        use crate::protocol::Value;
        let Value::Map(fields) = value else { return Err(invalid_external_editor_profile()); };
        if fields.len() != 3 || !fields.contains_key("profileId") || !fields.contains_key("revision")
            || !fields.contains_key("profileDigest") { return Err(invalid_external_editor_profile()); }
        let profile_id = match fields.get("profileId") {
            Some(Value::String(value)) if value.len() <= 256 && is_profile_identifier(value) => value.clone(),
            _ => return Err(invalid_external_editor_profile()),
        };
        let revision = match fields.get("revision") {
            Some(Value::String(value)) => parse_profile_revision(value).ok_or_else(invalid_external_editor_profile)?,
            _ => return Err(invalid_external_editor_profile()),
        };
        let profile_digest = match fields.get("profileDigest") {
            Some(Value::String(value)) if is_blake3_digest(value) => value.clone(),
            _ => return Err(invalid_external_editor_profile()),
        };
        Ok(Self { profile_id, revision, profile_digest })
    }

    pub fn matches_definition(&self, definition: &ExternalEditorProfileV1) -> io::Result<bool> {
        Ok(self.profile_id == definition.profile_id && self.revision == definition.revision
            && self.profile_digest == definition.definition_digest()?)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExternalEditorLaunchModeV1 {
    ForegroundTty,
    Wait,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExternalEditorTargetKindV1 {
    PromptScratch,
    WorkspaceFile,
}

impl ExternalEditorProfileV1 {
    pub fn from_value(value: &crate::protocol::Value) -> io::Result<Self> {
        use crate::protocol::Value;
        let Value::Map(fields) = value else { return Err(invalid_external_editor_profile()); };
        const KEYS: [&str; 9] = [
            "schemaVersion", "profileId", "revision", "executableSelector", "argv",
            "targetArgIndex", "launchMode", "targetKinds", "environmentPolicy",
        ];
        if fields.len() != KEYS.len() || KEYS.iter().any(|key| !fields.contains_key(*key)) {
            return Err(invalid_external_editor_profile());
        }
        let text = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if !value.is_empty() && !value.chars().any(char::is_control) => Ok(value.as_str()),
            _ => Err(invalid_external_editor_profile()),
        };
        if !matches!(fields.get("schemaVersion"), Some(Value::Unsigned(1)))
            || text("environmentPolicy")? != "sanitized_host"
        { return Err(invalid_external_editor_profile()); }
        let profile_id = text("profileId")?;
        if profile_id.len() > 256 || !is_profile_identifier(profile_id) { return Err(invalid_external_editor_profile()); }
        let revision = parse_profile_revision(text("revision")?).ok_or_else(invalid_external_editor_profile)?;
        let executable_selector = text("executableSelector")?;
        if executable_selector.len() > 4096 { return Err(invalid_external_editor_profile()); }
        let Value::Array(raw_argv) = fields.get("argv").ok_or_else(invalid_external_editor_profile)? else {
            return Err(invalid_external_editor_profile());
        };
        if raw_argv.len() > 127 { return Err(invalid_external_editor_profile()); }
        let mut argv = Vec::with_capacity(raw_argv.len());
        let mut total = 0usize;
        for value in raw_argv {
            let Value::String(argument) = value else { return Err(invalid_external_editor_profile()); };
            if argument.len() > 4096 || argument.chars().any(char::is_control) { return Err(invalid_external_editor_profile()); }
            total = total.checked_add(argument.len()).ok_or_else(invalid_external_editor_profile)?;
            if total > 512 * 1024 { return Err(invalid_external_editor_profile()); }
            argv.push(OsString::from(argument));
        }
        let target_arg_index = match fields.get("targetArgIndex") {
            Some(Value::Unsigned(value)) if *value <= argv.len() as u64 => *value as usize,
            _ => return Err(invalid_external_editor_profile()),
        };
        let launch_mode = match text("launchMode")? {
            "foreground_tty" => ExternalEditorLaunchModeV1::ForegroundTty,
            "wait" => ExternalEditorLaunchModeV1::Wait,
            _ => return Err(invalid_external_editor_profile()),
        };
        let Value::Array(raw_targets) = fields.get("targetKinds").ok_or_else(invalid_external_editor_profile)? else {
            return Err(invalid_external_editor_profile());
        };
        if raw_targets.is_empty() || raw_targets.len() > 2 { return Err(invalid_external_editor_profile()); }
        let mut target_kinds = Vec::with_capacity(raw_targets.len());
        for raw in raw_targets {
            let Value::String(kind) = raw else { return Err(invalid_external_editor_profile()); };
            let kind = match kind.as_str() {
                "prompt_scratch" => ExternalEditorTargetKindV1::PromptScratch,
                "workspace_file" => ExternalEditorTargetKindV1::WorkspaceFile,
                _ => return Err(invalid_external_editor_profile()),
            };
            if target_kinds.contains(&kind) { return Err(invalid_external_editor_profile()); }
            target_kinds.push(kind);
        }
        Ok(Self { profile_id: profile_id.to_owned(), revision, executable_selector: executable_selector.to_owned(),
            argv, target_arg_index, launch_mode, target_kinds })
    }

    pub fn to_value(&self) -> crate::protocol::Value {
        use crate::protocol::Value;
        Value::Map(BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            ("profileId".to_owned(), Value::String(self.profile_id.clone())),
            ("revision".to_owned(), Value::String(self.revision.to_string())),
            ("executableSelector".to_owned(), Value::String(self.executable_selector.clone())),
            ("argv".to_owned(), Value::Array(self.argv.iter().map(|arg| Value::String(arg.to_string_lossy().into_owned())).collect())),
            ("targetArgIndex".to_owned(), Value::Unsigned(self.target_arg_index as u64)),
            ("launchMode".to_owned(), Value::String(match self.launch_mode { ExternalEditorLaunchModeV1::ForegroundTty => "foreground_tty", ExternalEditorLaunchModeV1::Wait => "wait" }.to_owned())),
            ("targetKinds".to_owned(), Value::Array(self.target_kinds.iter().map(|kind| Value::String(match kind { ExternalEditorTargetKindV1::PromptScratch => "prompt_scratch", ExternalEditorTargetKindV1::WorkspaceFile => "workspace_file" }.to_owned())).collect())),
            ("environmentPolicy".to_owned(), Value::String("sanitized_host".to_owned())),
        ]))
    }

    pub fn definition_digest(&self) -> io::Result<String> {
        let encoded = crate::messagepack::encode(&self.to_value(), crate::messagepack::FRAME_LIMITS)
            .map_err(|_| invalid_external_editor_profile())?;
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.external-editor-profile.v1\0");
        hasher.update(&encoded);
        Ok(format!("blake3:{}", hasher.finalize().to_hex()))
    }

    pub fn resolve_executable_with_trusted_map(
        &self,
        trusted_selectors: &BTreeMap<String, PathBuf>,
    ) -> io::Result<(PathBuf, String)> {
        let candidate = trusted_selectors.get(&self.executable_selector).ok_or_else(||
            io::Error::new(io::ErrorKind::NotFound, "trusted editor executable selector is not configured"))?;
        if !candidate.is_absolute() { return Err(invalid_external_editor_profile()); }
        let executable = std::fs::canonicalize(candidate)?;
        let metadata = std::fs::metadata(&executable)?;
        if !metadata.is_file() { return Err(invalid_external_editor_profile()); }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 { return Err(invalid_external_editor_profile()); }
        }
        let digest = executable_digest(&executable)?;
        Ok((executable, digest))
    }

    /// Insert the exact host-created scratch target as one argv token. For both
    /// prompt and workspace editing the editor receives only a private scratch path.
    pub fn argv_for_target(&self, target: &str, kind: ExternalEditorTargetKindV1) -> io::Result<Vec<OsString>> {
        if !self.target_kinds.contains(&kind) || target.is_empty() || target.len() > 4096
            || target.chars().any(char::is_control) || self.argv.len() >= 128
        { return Err(invalid_external_editor_profile()); }
        if !Path::new(target).is_absolute() {
            return Err(invalid_external_editor_profile());
        }
        let mut result = self.argv.clone();
        result.insert(self.target_arg_index, OsString::from(target));
        Ok(result)
    }
}

/// Read one host-owned editor scratch file through a descriptor-relative
/// O_NOFOLLOW open. The directory must be private, the file a single-link regular
/// file, and the result stays within the editor's bounded document limit.
pub(crate) fn inspect_external_editor_scratch(
    scratch_root: &Path,
    scratch_file: &Path,
) -> io::Result<(String, u64)> {
    let bytes = read_external_editor_scratch(scratch_root, scratch_file)?;
    Ok((format!("blake3:{}", blake3::hash(&bytes).to_hex()), bytes.len() as u64))
}

pub(crate) fn read_external_editor_scratch(
    scratch_root: &Path,
    scratch_file: &Path,
) -> io::Result<Vec<u8>> {
    #[cfg(target_os = "linux")]
    {
        use std::io::Read;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let root = std::fs::canonicalize(scratch_root)?;
        let target = std::fs::canonicalize(scratch_file)?;
        if root != scratch_root || target != scratch_file || target.parent() != Some(root.as_path()) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "editor scratch target is not a direct child of its canonical host directory"));
        }
        let root_metadata = std::fs::symlink_metadata(&root)?;
        let effective_uid = unsafe { libc::geteuid() };
        if !root_metadata.is_dir() || root_metadata.uid() != effective_uid
            || root_metadata.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "editor scratch directory is not private"));
        }
        let directory = std::fs::File::open(&root)?;
        let name = target.file_name().ok_or_else(invalid_external_editor_profile)?;
        let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| invalid_external_editor_profile())?;
        // SAFETY: the pinned directory descriptor and NUL-terminated direct-child
        // filename remain valid for the duration of openat.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK) };
        if fd < 0 { return Err(io::Error::last_os_error()); }
        // SAFETY: openat returned a fresh owned descriptor.
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let before = file.metadata()?;
        if !before.is_file() || before.uid() != effective_uid || before.nlink() != 1
            || before.len() > MAX_EXTERNAL_EDITOR_SCRATCH_BYTES
            || before.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "editor scratch target is not a bounded private regular file"));
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        (&mut file).take(MAX_EXTERNAL_EDITOR_SCRATCH_BYTES + 1).read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if bytes.len() as u64 != before.len() || after.dev() != before.dev()
            || after.ino() != before.ino() || after.nlink() != 1
            || after.len() != before.len() || after.mtime() != before.mtime()
            || after.mtime_nsec() != before.mtime_nsec()
        {
            return Err(io::Error::new(io::ErrorKind::WouldBlock,
                "editor scratch target changed while being read"));
        }
        Ok(bytes)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (scratch_root, scratch_file);
        Err(io::Error::new(io::ErrorKind::Unsupported,
            "external editor scratch inspection requires the accepted Linux backend"))
    }
}

fn is_profile_identifier(value: &str) -> bool {
    value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

fn valid_editor_binding_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && is_profile_identifier(value)
}

pub(crate) fn valid_editor_source_relative_path(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.starts_with('/')
        && !value.contains('\\') && !value.chars().any(char::is_control)
        && value.split('/').all(|component| !component.is_empty() && component != "." && component != "..")
}

fn invalid_external_editor_profile() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "external editor profile is invalid")
}

fn validate_editor_environment(environment: &BTreeMap<OsString, OsString>) -> io::Result<()> {
    if environment.len() > 8 { return Err(invalid_external_editor_profile()); }
    let mut total = 0usize;
    for (key, value) in environment {
        let key = key.as_encoded_bytes();
        let value = value.as_encoded_bytes();
        if !matches!(key, b"PATH" | b"HOME" | b"LANG" | b"LC_ALL" | b"LC_CTYPE" | b"TMPDIR" | b"XDG_CACHE_HOME")
            || key.is_empty() || key.contains(&0) || value.contains(&0) || value.len() > 8192
        { return Err(invalid_external_editor_profile()); }
        total = total.checked_add(key.len() + value.len()).ok_or_else(invalid_external_editor_profile)?;
        if total > 32 * 1024 { return Err(invalid_external_editor_profile()); }
    }
    Ok(())
}

impl ExecutionLaunchProfileRefV1 {
    pub fn from_value(value: &crate::protocol::Value) -> io::Result<Self> {
        use crate::protocol::Value;
        let Value::Map(fields) = value else {
            return Err(invalid_launch_profile());
        };
        if fields.len() != 3
            || !fields.contains_key("profileId")
            || !fields.contains_key("revision")
            || !fields.contains_key("profileDigest")
        {
            return Err(invalid_launch_profile());
        }
        let profile_id = match fields.get("profileId") {
            Some(Value::String(value))
                if !value.is_empty()
                    && value.len() <= 128
                    && value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                    }) => value.clone(),
            _ => return Err(invalid_launch_profile()),
        };
        let revision = match fields.get("revision") {
            Some(Value::String(value)) => {
                parse_profile_revision(value).ok_or_else(invalid_launch_profile)?
            }
            _ => return Err(invalid_launch_profile()),
        };
        let profile_digest = match fields.get("profileDigest") {
            Some(Value::String(value))
                if value.len() == 71
                    && value.starts_with("blake3:")
                    && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
                    && value[7..].bytes().all(|byte| !byte.is_ascii_uppercase()) =>
            {
                value.clone()
            }
            _ => return Err(invalid_launch_profile()),
        };
        Ok(Self { profile_id, revision, profile_digest })
    }

    pub fn to_value(&self) -> crate::protocol::Value {
        use crate::protocol::Value;
        Value::Map(BTreeMap::from([
            ("profileId".to_owned(), Value::String(self.profile_id.clone())),
            ("revision".to_owned(), Value::String(self.revision.to_string())),
            ("profileDigest".to_owned(), Value::String(self.profile_digest.clone())),
        ]))
    }

    pub fn matches_definition(&self, definition: &ExecutionLaunchProfileV1) -> io::Result<bool> {
        Ok(self.profile_id == definition.profile_id
            && self.revision == definition.revision
            && self.profile_digest == definition.definition_digest()?)
    }
}

impl ExecutionLaunchProfileV1 {
    pub fn from_value(value: &crate::protocol::Value) -> io::Result<Self> {
        use crate::protocol::Value;
        let Value::Map(fields) = value else {
            return Err(invalid_launch_profile());
        };
        const REQUIRED_KEYS: [&str; 8] = [
            "schemaVersion",
            "profileId",
            "revision",
            "kind",
            "executableSelector",
            "argv",
            "workingDirectoryPolicy",
            "environmentPolicy",
        ];
        if REQUIRED_KEYS.iter().any(|key| !fields.contains_key(*key))
            || fields.keys().any(|key| !REQUIRED_KEYS.contains(&key.as_str()) && key != "dapPolicy")
        {
            return Err(invalid_launch_profile());
        }
        let text = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if !value.is_empty() && !value.contains('\0') => {
                Some(value.as_str())
            }
            _ => None,
        };
        if !matches!(fields.get("schemaVersion"), Some(Value::Unsigned(1)))
            || text("workingDirectoryPolicy") != Some("registered_location_root")
            || text("environmentPolicy") != Some("sanitized_host")
        {
            return Err(invalid_launch_profile());
        }
        let profile_id = text("profileId").ok_or_else(invalid_launch_profile)?;
        if profile_id.len() > 128
            || !profile_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            return Err(invalid_launch_profile());
        }
        let revision_text = text("revision").ok_or_else(invalid_launch_profile)?;
        let revision = parse_profile_revision(revision_text).ok_or_else(invalid_launch_profile)?;
        let kind = match text("kind") {
            Some("lsp") => StdioProcessKindV1::LanguageServer,
            Some("dap") => StdioProcessKindV1::DebugAdapter,
            Some("repl") => StdioProcessKindV1::Interpreter,
            Some("codemode") => StdioProcessKindV1::CodeModeHelper,
            _ => return Err(invalid_launch_profile()),
        };
        let dap_policy_allow_evaluate = match fields.get("dapPolicy") {
            None => None,
            Some(Value::Map(policy))
                if kind == StdioProcessKindV1::DebugAdapter
                    && policy.len() == 1
                    && policy.contains_key("allowEvaluate") =>
            {
                match policy.get("allowEvaluate") {
                    Some(Value::Bool(value)) => Some(*value),
                    _ => return Err(invalid_launch_profile()),
                }
            }
            _ => return Err(invalid_launch_profile()),
        };
        let executable_selector = text("executableSelector")
            .ok_or_else(invalid_launch_profile)?
            .to_owned();
        if executable_selector.len() > 4096
            || executable_selector.bytes().any(|byte| byte.is_ascii_control())
            || !trusted_selector_name(&executable_selector, kind)
        {
            return Err(invalid_launch_profile());
        }
        let Some(Value::Array(arguments)) = fields.get("argv") else {
            return Err(invalid_launch_profile());
        };
        if arguments.len() > MAX_STDIO_ARGUMENTS {
            return Err(invalid_launch_profile());
        }
        let mut argv = Vec::with_capacity(arguments.len());
        let mut total_bytes = 0usize;
        for argument in arguments {
            let Value::String(argument) = argument else {
                return Err(invalid_launch_profile());
            };
            if argument.contains('\0')
                || argument.len() > MAX_STDIO_ARGUMENT_BYTES
                || contains_launch_placeholder(argument)
            {
                return Err(invalid_launch_profile());
            }
            total_bytes = total_bytes
                .checked_add(argument.len())
                .ok_or_else(invalid_launch_profile)?;
            if total_bytes > MAX_STDIO_ARGUMENT_BYTES {
                return Err(invalid_launch_profile());
            }
            argv.push(OsString::from(argument));
        }
        Ok(Self {
            profile_id: profile_id.to_owned(),
            revision,
            kind,
            executable_selector,
            argv,
            dap_policy_allow_evaluate,
        })
    }

    pub fn to_value(&self) -> crate::protocol::Value {
        use crate::protocol::Value;
        let mut fields = BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            ("profileId".to_owned(), Value::String(self.profile_id.clone())),
            ("revision".to_owned(), Value::String(self.revision.to_string())),
            (
                "kind".to_owned(),
                Value::String(match self.kind {
                    StdioProcessKindV1::LanguageServer => "lsp",
                    StdioProcessKindV1::DebugAdapter => "dap",
                    StdioProcessKindV1::Interpreter => "repl",
                    StdioProcessKindV1::CodeModeHelper => "codemode",
                    _ => "invalid",
                }.to_owned()),
            ),
            ("executableSelector".to_owned(), Value::String(self.executable_selector.clone())),
            (
                "argv".to_owned(),
                Value::Array(
                    self.argv
                        .iter()
                        .map(|value| Value::String(value.to_string_lossy().into_owned()))
                        .collect(),
                ),
            ),
            (
                "workingDirectoryPolicy".to_owned(),
                Value::String("registered_location_root".to_owned()),
            ),
            (
                "environmentPolicy".to_owned(),
                Value::String("sanitized_host".to_owned()),
            ),
        ]);
        if let Some(allow_evaluate) = self.dap_policy_allow_evaluate {
            fields.insert(
                "dapPolicy".to_owned(),
                Value::Map(BTreeMap::from([(
                    "allowEvaluate".to_owned(),
                    Value::Bool(allow_evaluate),
                )])),
            );
        }
        Value::Map(fields)
    }

    pub fn definition_digest(&self) -> io::Result<String> {
        let encoded = crate::messagepack::encode(&self.to_value(), crate::messagepack::FRAME_LIMITS)
            .map_err(|_| invalid_launch_profile())?;
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.execution-launch-profile.v1\0");
        hasher.update(&encoded);
        Ok(format!("blake3:{}", hasher.finalize().to_hex()))
    }

    pub fn resolve_executable(&self) -> io::Result<(PathBuf, String)> {
        // Presence on PATH or in a conventional system directory is not evidence
        // that Core Config authorized this executable. Launch stays unavailable
        // until the HostKernel is supplied an explicit trusted selector mapping.
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "trusted executable selector mapping is not configured",
        ))
    }

    /// Resolve only through an explicit mapping owned by HostKernel installation
    /// configuration. The map key is the complete namespaced selector, never a
    /// caller-provided path or basename. This helper does not create or persist a
    /// second profile registry.
    pub(crate) fn resolve_executable_with_trusted_map(
        &self,
        trusted_selectors: &BTreeMap<String, PathBuf>,
    ) -> io::Result<(PathBuf, String)> {
        let candidate = trusted_selectors
            .get(&self.executable_selector)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "trusted executable selector is not configured",
                )
            })?;
        if !candidate.is_absolute() {
            return Err(invalid_launch_profile());
        }
        let executable = std::fs::canonicalize(&candidate)?;
        let metadata = std::fs::metadata(&executable)?;
        if !executable.is_absolute() || !metadata.is_file() {
            return Err(invalid_launch_profile());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(invalid_launch_profile());
            }
        }
        let digest = executable_digest(&executable)?;
        Ok((executable, digest))
    }
}

fn trusted_selector_name(value: &str, kind: StdioProcessKindV1) -> bool {
    let (expected_prefix, allowed) = match kind {
        StdioProcessKindV1::LanguageServer => ("horizoncode:lsp:", &["typescript-language-server", "rust-analyzer", "pyright-langserver", "pylsp"][..]),
        StdioProcessKindV1::DebugAdapter => ("horizoncode:dap:", &["debugpy-adapter", "lldb-dap"][..]),
        StdioProcessKindV1::Interpreter => ("horizoncode:repl:", &["python3", "node"][..]),
        StdioProcessKindV1::CodeModeHelper => ("horizoncode:codemode:", &["bun"][..]),
        _ => return false,
    };
    value.strip_prefix(expected_prefix).is_some_and(|name| allowed.contains(&name))
}

fn invalid_launch_profile() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "execution launch profile is invalid")
}

fn parse_profile_revision(value: &str) -> Option<u64> {
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return None;
    }
    let revision = value.parse::<u64>().ok()?;
    (revision > 0).then_some(revision)
}

fn contains_launch_placeholder(value: &str) -> bool {
    ["${", "{{", "}}", "%WORKSPACE%", "%ROOT%"]
        .iter()
        .any(|marker| value.contains(marker))
}

impl StdioLaunchSpec {
    pub fn new<I, A>(
        executable: impl Into<PathBuf>,
        executable_digest: impl Into<String>,
        argv: I,
        cwd: impl Into<PathBuf>,
    ) -> Self
    where
        I: IntoIterator<Item = A>,
        A: AsRef<std::ffi::OsStr>,
    {
        let cwd = cwd.into();
        Self {
            executable: executable.into(),
            executable_digest: executable_digest.into(),
            code_mode_helper: None,
            profile_digest: String::new(),
            workspace_revision: String::new(),
            argv: argv
                .into_iter()
                .map(|argument| argument.as_ref().to_owned())
                .collect(),
            workspace_root: cwd.clone(),
            cwd,
            writable_roots: Vec::new(),
            env: BTreeMap::new(),
            timeout: Duration::from_secs(60),
            max_output_bytes: MAX_STDIO_OUTPUT_BYTES,
            filesystem_policy: StdioFilesystemPolicyV1::WorkspaceWrite,
            fixed_git_read: false,
            capture_output_for_host: false,
        }
    }

    /// Restrict a trusted editor/debug adapter to read-only access to the registered
    /// workspace. This is a HostKernel-selected profile policy; no Core or project field
    /// can widen it to workspace write access.
    pub(crate) fn use_readonly_workspace(&mut self) {
        self.filesystem_policy = StdioFilesystemPolicyV1::ReadOnlyWorkspace;
    }

    pub(crate) fn use_readonly_git_worktree_metadata(&mut self, metadata_root: PathBuf) {
        self.filesystem_policy = StdioFilesystemPolicyV1::ReadOnlyGitWorktreeMetadata { metadata_root };
    }

    /// Select the broker-only nested-write exception. Inputs are supplied from the
    /// authenticated Location root and P8's fixed `.horizon/worktrees` layout; the
    /// confinement preflight independently canonicalizes and checks both paths.
    pub(crate) fn allow_git_worktree_metadata(
        &mut self,
        metadata_root: PathBuf,
        destination_parent: PathBuf,
    ) {
        self.filesystem_policy = StdioFilesystemPolicyV1::GitWorktreeLifecycle {
            metadata_root,
            destination_parent,
        };
    }

    pub(crate) fn retain_output_for_host(&mut self) {
        self.capture_output_for_host = true;
    }

    pub(crate) fn use_codemode_isolation(&mut self, package: &CodeModeHelperPackageV1) {
        self.code_mode_helper = Some(package.clone());
        self.filesystem_policy = StdioFilesystemPolicyV1::CodeModeIsolated {
            package_root: package.package_root.clone(),
            entrypoint: package.entrypoint.clone(),
            helper_digest: package.helper_digest.clone(),
        };
        self.cwd = PathBuf::from("/tmp");
        self.writable_roots.clear();
    }

    /// Construct the only supported CodeMode helper launch. Every executable,
    /// package, entrypoint and digest value comes from the HostKernel-owned install
    /// manifest; helper frames can never select argv, cwd, environment or roots.
    pub(crate) fn code_mode(
        package: &CodeModeHelperPackageV1,
        workspace_root: impl Into<PathBuf>,
        workspace_revision: impl Into<String>,
        timeout: Duration,
    ) -> io::Result<Self> {
        if timeout.is_zero() || timeout > Duration::from_millis(30_000) {
            return Err(invalid_launch_profile());
        }
        let mut spec = Self::new(
            package.executable.clone(),
            package.executable_digest.clone(),
            [OsString::from("run"), package.entrypoint.as_os_str().to_owned()],
            "/tmp",
        );
        spec.workspace_root = workspace_root.into();
        spec.workspace_revision = workspace_revision.into();
        spec.profile_digest = package.launch_profile_digest()?;
        spec.timeout = timeout;
        spec.use_codemode_isolation(package);
        Ok(spec)
    }
}

pub struct PreparedStdioLaunch {
    prepared: horizoncode_sandbox::PreparedExecution,
    request: horizoncode_sandbox::SpawnRequest,
    /// Preserve the exact trusted executable pin across the Guard/lease wait so
    /// it can be rehashed at the last userspace boundary before spawn.
    executable_path: PathBuf,
    executable_digest: String,
    guarantee_record: String,
    execution_digest: String,
    timeout: Duration,
    max_output_bytes: usize,
    capture_output_for_host: bool,
}

impl PreparedStdioLaunch {
    pub fn guarantee_record(&self) -> &str {
        &self.guarantee_record
    }
    pub(crate) fn guarantee_assessments(
        &self,
    ) -> &[horizoncode_sandbox::GuaranteeAssessment] {
        self.prepared.guarantees()
    }
    pub fn execution_digest(&self) -> &str {
        &self.execution_digest
    }
    pub fn max_output_bytes(&self) -> usize {
        self.max_output_bytes
    }
}

/// Host-only, no-child assessment of one exact immutable process launch. It is
/// useful for constructing an informed Guard challenge before approval; it carries
/// no process handle or dispatch authority. Execution must recompute and match its
/// digest after approval before spending the one-use lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StdioLaunchAssessmentV1 {
    execution_digest: String,
    guarantee_record: String,
    guarantees: Vec<horizoncode_sandbox::GuaranteeAssessment>,
}

/// User-consent-safe guarantee projection. Residual prose comes from the fixed
/// sandbox backend; any backtick-delimited path/detail is replaced with `<detail>`
/// before it crosses the approval UI boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StdioGuaranteeAssessmentProjectionV1 {
    pub dimension: &'static str,
    pub level: &'static str,
    pub backend: &'static str,
    pub residuals: Vec<String>,
}

impl StdioLaunchAssessmentV1 {
    pub(crate) fn execution_digest(&self) -> &str {
        &self.execution_digest
    }

    pub(crate) fn guarantee_record(&self) -> &str {
        &self.guarantee_record
    }

    pub(crate) fn guarantees(&self) -> &[horizoncode_sandbox::GuaranteeAssessment] {
        &self.guarantees
    }

    pub(crate) fn guarantee_digest(&self) -> String {
        guarantee_record_digest(&self.guarantee_record)
    }

    pub(crate) fn approval_projection(
        &self,
    ) -> io::Result<Vec<StdioGuaranteeAssessmentProjectionV1>> {
        use horizoncode_sandbox::GuaranteeDimension;
        if self.guarantees.len() != GuaranteeDimension::ALL.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "incomplete sandbox guarantee vector"));
        }
        let mut by_dimension = std::collections::BTreeMap::new();
        for assessment in &self.guarantees {
            let mut residual_bytes = 0usize;
            let residuals = assessment.residuals.iter().map(|residual| {
                if residual.len() > 1024 || residual.chars().any(char::is_control) {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "sandbox residual is unsafe to project"));
                }
                residual_bytes = residual_bytes.saturating_add(residual.len());
                if residual_bytes > 4096 {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "sandbox residual projection exceeds bound"));
                }
                Ok(redact_sandbox_residual(residual))
            }).collect::<io::Result<Vec<_>>>()?;
            if by_dimension.insert(assessment.dimension, StdioGuaranteeAssessmentProjectionV1 {
                dimension: assessment.dimension.as_str(),
                level: assessment.level.as_str(),
                backend: assessment.backend,
                residuals,
            }).is_some() {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "duplicate sandbox guarantee dimension"));
            }
        }
        if GuaranteeDimension::ALL.iter().any(|dimension| !by_dimension.contains_key(dimension)) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "sandbox guarantee dimension is missing"));
        }
        Ok(GuaranteeDimension::ALL.iter().filter_map(|dimension| by_dimension.remove(dimension)).collect())
    }
}

fn redact_sandbox_residual(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_opaque_detail = false;
    for character in value.chars() {
        if character == '`' {
            if in_opaque_detail {
                output.push_str("<detail>");
                in_opaque_detail = false;
            } else {
                in_opaque_detail = true;
            }
        } else if !in_opaque_detail {
            output.push(character);
        }
    }
    if in_opaque_detail {
        output.push_str("<detail>");
    }
    output
}

fn guarantee_record_digest(record: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.stdio.guarantee-assessment.v1\0");
    hasher.update(&(record.len() as u64).to_be_bytes());
    hasher.update(record.as_bytes());
    format!("blake3:{}", hasher.finalize().to_hex())
}

pub(crate) fn stdio_guarantee_record_digest(record: &str) -> String {
    guarantee_record_digest(record)
}

/// A non-PTY child launched through horizoncode-sandbox. Output capture and RPC framing
/// remain bounded by the owner; this handle only exposes the three requested pipes and
/// observed process lifecycle.
pub struct StdioProcess {
    child: horizoncode_sandbox::RunningChild,
    timeout: Duration,
    /// One wall-time deadline measured from actual spawn. Preflight may wait on an
    /// approval indefinitely within its own expiry and must not consume execution time.
    deadline: Instant,
    stdin: Option<std::process::ChildStdin>,
    stdout: Option<std::process::ChildStdout>,
    stderr: Option<std::process::ChildStderr>,
    stdout_sequence: u64,
    stderr_sequence: u64,
    max_output_bytes: usize,
    output_bytes: usize,
    output_limit_exceeded: bool,
    input_bytes: usize,
    stdout_hasher: blake3::Hasher,
    stderr_hasher: blake3::Hasher,
    stdout_capture: Vec<u8>,
    stderr_capture: Vec<u8>,
    observed_output_taken: bool,
    capture_output_for_host: bool,
}

/// Bounded process output captured by the supervisor itself. This is crate-private
/// evidence input; RPC readers cannot construct or replace these bytes.
pub(crate) struct StdioObservedOutputV1 {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdioOutputSource {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StdioOutputRecord {
    pub source: StdioOutputSource,
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StdioOutputPage {
    pub generation: u64,
    pub records: Vec<StdioOutputRecord>,
    pub next_stdout_sequence: u64,
    pub next_stderr_sequence: u64,
    pub eof: bool,
    pub truncated: bool,
}

/// Authenticated host facts that bind an execution to its existing Guard challenge.
/// The RPC adapter constructs this value from the peer principal, FrameFence, registered
/// Location, approved capability binding, and exact Attempt scope; request bodies never
/// supply a principal or resolved executable path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StdioExecutionBindingV1 {
    pub execution_id: String,
    pub effect_id: String,
    pub challenge_id: String,
    pub principal: String,
    /// Principal whose trusted execution profile owns the child process. This is
    /// distinct from `principal` for managed verification: the latter remains the
    /// authenticated reviewer who approved the Guard challenge.
    pub execution_principal: String,
    /// Explicit authority subject. ProjectRead is Location/workspace scoped and
    /// intentionally carries no fabricated Session identity.
    pub scope: StdioExecutionScopeV1,
    pub session_id: String,
    pub location_id: String,
    pub capability_id: String,
    pub capability_lease_digest: String,
    /// Guard's immutable digest for the canonical approved request arguments.
    /// HostKernel derives this from its stored capability binding.
    pub approved_arguments_digest: String,
    pub attempt_scope_digest: Option<String>,
    pub owner_epoch: u64,
    pub generation: u64,
    pub workspace_revision: String,
    pub profile_ref: String,
    /// Immutable profile pin and resolved executable content identity retained with
    /// the process owner and copied into its durable receipt projection.
    pub profile_id: String,
    pub profile_revision: u64,
    pub profile_digest: String,
    pub executable_digest: String,
    /// Retained from the immutable DAP launch-profile definition. Other process
    /// kinds must always carry false. This is only one required condition; each
    /// evaluate operation still needs a fresh debug.evaluate Guard lease.
    pub dap_allow_evaluate: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StdioExecutionScopeV1 {
    Session { session_id: String },
    ProjectRead { workspace_id: String },
}

/// Host-minted identity for a supervised process. This is a lookup reference, never
/// launch authority; the owning HostKernel retains the full authenticated binding and
/// checks principal, Session/Attempt, Location, workspace and owner epoch on every use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdioProcessKindV1 {
    TerminalRun,
    GitRead,
    /// User-selected editor resolved from immutable Core Config. This is an
    /// identity label only; HostKernel remains the authority for profile and
    /// root-Session user-action admission.
    ExternalEditor,
    LanguageServer,
    DebugAdapter,
    Interpreter,
    ManagedVerifier,
    /// Fixed packaged CodeMode helper; nested calls return through bounded stdio RPC.
    CodeModeHelper,
}

impl StdioProcessKindV1 {
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::TerminalRun => "terminal_run",
            Self::GitRead => "git_read",
            Self::ExternalEditor => "external_editor",
            Self::LanguageServer => "language_server",
            Self::DebugAdapter => "debug_adapter",
            Self::Interpreter => "interpreter",
            Self::ManagedVerifier => "managed_verifier",
            Self::CodeModeHelper => "codemode_helper",
        }
    }
}

/// Exact process identity returned to typed adapters instead of a caller-supplied PID.
/// Generation and epoch use canonical decimal strings in wire projections.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StdioProcessRefV1 {
    execution_id: String,
    generation: u64,
    owner_epoch: u64,
    kind: StdioProcessKindV1,
    profile_id: String,
    profile_revision: u64,
    profile_digest: String,
    executable_digest: String,
}

impl StdioProcessRefV1 {
    pub(crate) fn from_value(value: &crate::protocol::Value) -> io::Result<Self> {
        use crate::protocol::Value;
        let Value::Map(fields) = value else { return Err(invalid_process_ref()) };
        const KEYS: [&str; 8] = [
            "executionID", "generation", "ownerEpoch", "kind", "profileID",
            "profileRevision", "profileDigest", "executableDigest",
        ];
        if fields.len() != KEYS.len() || KEYS.iter().any(|key| !fields.contains_key(*key)) {
            return Err(invalid_process_ref());
        }
        let text = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if !value.is_empty() => Some(value.as_str()),
            _ => None,
        };
        let kind = match text("kind") {
            Some("terminal_run") => StdioProcessKindV1::TerminalRun,
            Some("git_read") => StdioProcessKindV1::GitRead,
            Some("external_editor") => StdioProcessKindV1::ExternalEditor,
            Some("language_server") => StdioProcessKindV1::LanguageServer,
            Some("debug_adapter") => StdioProcessKindV1::DebugAdapter,
            Some("interpreter") => StdioProcessKindV1::Interpreter,
            Some("managed_verifier") => StdioProcessKindV1::ManagedVerifier,
            Some("codemode_helper") => StdioProcessKindV1::CodeModeHelper,
            _ => return Err(invalid_process_ref()),
        };
        Self::from_claims(
            text("executionID").ok_or_else(invalid_process_ref)?.to_owned(),
            parse_profile_revision(text("generation").ok_or_else(invalid_process_ref)?)
                .ok_or_else(invalid_process_ref)?,
            parse_profile_revision(text("ownerEpoch").ok_or_else(invalid_process_ref)?)
                .ok_or_else(invalid_process_ref)?,
            kind,
            text("profileID").ok_or_else(invalid_process_ref)?.to_owned(),
            parse_profile_revision(text("profileRevision").ok_or_else(invalid_process_ref)?)
                .ok_or_else(invalid_process_ref)?,
            text("profileDigest").ok_or_else(invalid_process_ref)?.to_owned(),
            text("executableDigest").ok_or_else(invalid_process_ref)?.to_owned(),
        )
    }

    pub(crate) fn from_binding(
        binding: &StdioExecutionBindingV1,
        kind: StdioProcessKindV1,
    ) -> io::Result<Self> {
        Self::from_claims(
            binding.execution_id.clone(),
            binding.generation,
            binding.owner_epoch,
            kind,
            binding.profile_id.clone(),
            binding.profile_revision,
            binding.profile_digest.clone(),
            binding.executable_digest.clone(),
        )
    }

    /// Parse the bounded identity claim from an authenticated control message. The
    /// returned value is only a lookup key; HostKernel must resolve it against its
    /// retained process binding before authorizing any operation.
    pub(crate) fn from_claims(
        execution_id: String,
        generation: u64,
        owner_epoch: u64,
        kind: StdioProcessKindV1,
        profile_id: String,
        profile_revision: u64,
        profile_digest: String,
        executable_digest: String,
    ) -> io::Result<Self> {
        if execution_id.is_empty()
            || execution_id.len() > 256
            || execution_id.chars().any(char::is_control)
            || generation == 0
            || owner_epoch == 0
            || profile_id.is_empty()
            || profile_id.len() > 128
            || !profile_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            || profile_revision == 0
            || !is_blake3_digest(&profile_digest)
            || !is_blake3_digest(&executable_digest)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "supervised process identity is invalid",
            ));
        }
        Ok(Self {
            execution_id,
            generation,
            owner_epoch,
            kind,
            profile_id,
            profile_revision,
            profile_digest,
            executable_digest,
        })
    }

    pub fn execution_id(&self) -> &str {
        &self.execution_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }

    pub fn kind(&self) -> StdioProcessKindV1 {
        self.kind
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub fn profile_revision(&self) -> u64 {
        self.profile_revision
    }

    pub fn profile_digest(&self) -> &str {
        &self.profile_digest
    }

    pub fn executable_digest(&self) -> &str {
        &self.executable_digest
    }

    pub(crate) fn to_value(&self) -> crate::protocol::Value {
        use crate::protocol::Value;
        let mut fields = BTreeMap::new();
        fields.insert(
            "executionID".to_owned(),
            Value::String(self.execution_id.clone()),
        );
        fields.insert(
            "generation".to_owned(),
            Value::String(self.generation.to_string()),
        );
        fields.insert(
            "ownerEpoch".to_owned(),
            Value::String(self.owner_epoch.to_string()),
        );
        fields.insert(
            "kind".to_owned(),
            Value::String(self.kind.wire_name().to_owned()),
        );
        fields.insert("profileID".to_owned(), Value::String(self.profile_id.clone()));
        fields.insert(
            "profileRevision".to_owned(),
            Value::String(self.profile_revision.to_string()),
        );
        fields.insert(
            "profileDigest".to_owned(),
            Value::String(self.profile_digest.clone()),
        );
        fields.insert(
            "executableDigest".to_owned(),
            Value::String(self.executable_digest.clone()),
        );
        Value::Map(fields)
    }
}

fn invalid_process_ref() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "supervised process reference is invalid")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StdioExecutionPreparedV1 {
    pub execution_id: String,
    pub generation: u64,
    /// Digest of the exact sandbox-prepared caller-side launch, including the
    /// host-observed guarantee record. Comparable to a pre-approval assessment.
    pub launch_digest: String,
    pub guarantee_digest: String,
    pub execution_digest: String,
    pub approved_arguments_digest: String,
    pub confinement_record: String,
    pub capability_lease_digest: String,
    /// Exact cgroup-v2 containment identity to persist in the EffectHost PREPARED
    /// transaction before this one-use launch can reach spawn.
    pub cgroup_identity: Option<crate::protocol::Value>,
    /// OS-enforced resource dimensions of the selected process profile. Default worker
    /// effects prove none; the fixed Linux CodeMode profile proves these four dimensions.
    pub resource_guarantees: ProcessResourceGuaranteesV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessResourceGuaranteesV1 {
    pub cpu_time_enforced: bool,
    pub memory_enforced: bool,
    pub process_count_enforced: bool,
    pub file_descriptors_enforced: bool,
}

impl ProcessResourceGuaranteesV1 {
    pub const fn for_current_backend() -> Self {
        Self {
            cpu_time_enforced: false,
            memory_enforced: false,
            process_count_enforced: false,
            file_descriptors_enforced: false,
        }
    }

    pub const fn for_code_mode_linux() -> Self {
        Self { cpu_time_enforced: true, memory_enforced: true,
            process_count_enforced: true, file_descriptors_enforced: true }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdioExecutionStateV1 {
    Prepared,
    Running,
    Cancelling,
    Exited,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StdioExecutionStatusV1 {
    pub execution_id: String,
    pub generation: u64,
    pub state: StdioExecutionStateV1,
    pub stdout_sequence: u64,
    pub stderr_sequence: u64,
    pub exit_code: Option<i32>,
    pub stdout_digest: String,
    pub stderr_digest: String,
    pub output_bytes: u64,
    pub truncated: bool,
    /// Monotonic elapsed milliseconds from actual process launch to this observed
    /// exit (or now while live), retained on the supervisor boundary for trusted
    /// verifier evidence; never supplied by RPC.
    pub duration_ms: u64,
    pub receipt_digest: Option<String>,
}

/// Read-only persisted recovery projection. `binding` is reconstructed from the
/// authenticated durable row; clients cannot provide launch authority for recovery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StdioExecutionRecoveryV1 {
    pub binding: StdioExecutionBindingV1,
    pub status: StdioExecutionStatusV1,
}

/// HostKernel-selected managed process effect plus the exact per-effect Attempt
/// scope that was current when that effect was admitted. Managed scopes may be
/// refreshed between effects in one Attempt, so a batch cannot share one digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedStdioEffectRecoveryPinV1 {
    pub effect_id: String,
    pub attempt_scope_digest: String,
}

/// Durable receipt facts emitted only after the supervisor observes process exit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StdioExecutionReceiptV1 {
    pub execution_id: String,
    pub effect_id: String,
    pub generation: u64,
    pub profile_id: String,
    pub profile_revision: u64,
    pub profile_digest: String,
    pub executable_digest: String,
    /// Trusted process principal captured by the HostKernel launch binding.
    pub execution_principal: String,
    pub exit_code: Option<i32>,
    pub stdout_sequence: u64,
    pub stderr_sequence: u64,
    pub stdout_digest: String,
    pub stderr_digest: String,
    pub output_bytes: u64,
    pub truncated: bool,
    pub receipt_digest: String,
}

/// Exact read-only Git settlement facts. The process receipt is bound to both
/// the workspace revision pinned before launch and the revision observed after
/// process exit; callers must not return result bytes when these differ.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StdioGitReadReceiptV1 {
    pub(crate) process: StdioExecutionReceiptV1,
    pub(crate) workspace_revision_before: String,
    pub(crate) workspace_revision_after: String,
    pub(crate) operation_digest: String,
    pub(crate) grant_digest: String,
}

/// Replay projection for a settled fixed Git read. Output bytes are returned only
/// after the durable receipt and both workspace revision pins are revalidated.
pub(crate) struct StdioGitReadReplayV1 {
    pub(crate) receipt: StdioGitReadReceiptV1,
    pub(crate) output: StdioObservedOutputV1,
}

/// Internal token returned only after EffectHost has durably recorded the process intent.
/// It is required to launch a matching preflight and cannot be reconstructed from wire data.
#[derive(Clone, Debug)]
pub struct StdioExecutionDispatchIntentV1 {
    binding: StdioExecutionBindingV1,
    execution_digest: String,
    intent_id: String,
}

impl StdioExecutionDispatchIntentV1 {
    pub(crate) fn new(
        binding: StdioExecutionBindingV1,
        execution_digest: String,
        intent_id: String,
    ) -> Self {
        Self {
            binding,
            execution_digest,
            intent_id,
        }
    }

    pub(crate) fn binding(&self) -> &StdioExecutionBindingV1 {
        &self.binding
    }

    pub(crate) fn execution_digest(&self) -> &str {
        &self.execution_digest
    }

    pub(crate) fn intent_id(&self) -> &str {
        &self.intent_id
    }
}

struct StdioExecutionRecord {
    binding: StdioExecutionBindingV1,
    prepared: Option<PreparedStdioLaunch>,
    process: Option<StdioProcess>,
    state: StdioExecutionStateV1,
    exit_code: Option<i32>,
    deadline: Instant,
    dispatch_intent_id: Option<String>,
    execution_digest: String,
    started_at: Option<Instant>,
    finished_at: Option<Instant>,
    #[cfg(target_os = "linux")]
    cgroup: Option<crate::cgroup_v2::ExecutionCgroupV2>,
}

/// One process owner for non-PTY Guarded executions. Durable intent and receipts remain
/// in EffectHost; this object owns only live process handles and single-use preflights.
#[derive(Default)]
pub struct StdioExecutionSupervisor {
    executions: BTreeMap<String, StdioExecutionRecord>,
}

impl PreparedTerminalLaunch {
    /// Attach the exact durable execution cgroup a HostKernel binding owns to
    /// this prepared launch. `prepare_confined` intentionally carries no
    /// identity (the durable identity lives only in the HostKernel binding),
    /// but §14.21 forbids spawning without a prepared, persisted containment
    /// identity, so the dispatcher must attach the group — after confirming it
    /// is empty and exactly owned — before `spawn_prepared`.
    #[cfg(target_os = "linux")]
    pub(crate) fn attach_execution_cgroup(
        &mut self,
        cgroup: crate::cgroup_v2::ExecutionCgroupV2,
    ) -> io::Result<()> {
        if self.cgroup.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "a confinement cgroup is already attached to this prepared launch",
            ));
        }
        crate::cgroup_v2::ExecutionCgroupV2::confirm_empty_before_dispatch(cgroup.identity())?;
        self.cgroup = Some(cgroup);
        self.cgroup_required = true;
        Ok(())
    }

    pub fn guarantee_record(&self) -> &str {
        &self.guarantee_record
    }

    /// Digest of the exact caller-side launch inputs before the sandbox wrapper is
    /// applied. HostKernel combines this with profile, workspace revision and owner
    /// epoch to bind an approval-time preflight to the later dispatch.
    pub fn launch_digest(&self) -> &str {
        &self.launch_digest
    }

    pub fn executable_digest(&self) -> &str {
        &self.executable_digest
    }

    /// Exact host-created cgroup identity to include in EffectHost PREPARED before
    /// `spawn_prepared` can put the supervisor and its descendants in the group.
    #[cfg(target_os = "linux")]
    pub(crate) fn cgroup_identity(&self) -> Option<crate::protocol::Value> {
        self.cgroup.as_ref().map(|cgroup| cgroup.identity().to_value())
    }

    /// Prove the exact prepared cgroup is empty when cancellation wins before spawn.
    /// This does not settle the effect; the caller must persist the proof before
    /// returning a known pre-dispatch cancellation.
    #[cfg(target_os = "linux")]
    pub(crate) fn quiesce_unstarted_process_tree(&self) -> io::Result<String> {
        let cgroup = self.cgroup.as_ref().ok_or_else(|| io::Error::new(
            io::ErrorKind::Unsupported,
            "prepared terminal launch has no cgroup-v2 containment identity",
        ))?;
        let proof = crate::cgroup_v2::ExecutionCgroupV2::kill_and_confirm_empty(cgroup.identity())?;
        crate::cgroup_v2::ExecutionCgroupV2::retain_if_empty(cgroup.identity())?;
        Ok(proof)
    }

    #[cfg(not(target_os = "linux"))]
    pub(crate) fn quiesce_unstarted_process_tree(&self) -> io::Result<String> {
        Err(io::Error::new(io::ErrorKind::Unsupported,
            "terminal process-tree containment is unavailable on this platform"))
    }

    /// Attach the exact cgroup-v2 identity to an already Guard-prepared terminal
    /// launch. The caller supplies only authority facts resolved by HostKernel after
    /// approval/lease admission; no process starts here. Linux process-tree containment
    /// is mandatory for durable terminal dispatch.
    #[cfg(target_os = "linux")]
    pub(crate) fn bind_effect_cgroup(
        &mut self,
        effect_id: &str,
        capability_lease_digest: &str,
        execution_principal: &str,
        attempt_scope_digest: Option<&str>,
        owner_epoch: u64,
        process_generation: u64,
        process_kind: &str,
        profile_id: &str,
        profile_revision: u64,
        profile_digest: &str,
    ) -> io::Result<crate::protocol::Value> {
        if self.cgroup.is_some() || process_generation == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput,
                "terminal launch already has containment or an invalid generation"));
        }
        let mut identity_preimage = b"horizoncode.terminal-execution-id.v1\0".to_vec();
        identity_preimage.extend_from_slice(effect_id.as_bytes());
        identity_preimage.push(0);
        identity_preimage.extend_from_slice(capability_lease_digest.as_bytes());
        let execution_id = format!("termexec_{}", blake3::hash(&identity_preimage).to_hex());
        let cgroup = crate::cgroup_v2::ExecutionCgroupV2::create(
            &execution_id,
            effect_id,
            capability_lease_digest,
            execution_principal,
            attempt_scope_digest,
            owner_epoch,
            process_generation,
            process_kind,
            profile_id,
            profile_revision,
            profile_digest,
            &self.executable_digest,
            "none",
            self.cgroup_hierarchy_hidden,
        )?;
        crate::cgroup_v2::ExecutionCgroupV2::confirm_empty_before_dispatch(cgroup.identity())?;
        let value = cgroup.identity().to_value();
        self.cgroup = Some(cgroup);
        self.cgroup_required = true;
        Ok(value)
    }

    #[cfg(not(target_os = "linux"))]
    pub(crate) fn bind_effect_cgroup(
        &mut self,
        _effect_id: &str,
        _capability_lease_digest: &str,
        _execution_principal: &str,
        _attempt_scope_digest: Option<&str>,
        _owner_epoch: u64,
        _process_generation: u64,
        _process_kind: &str,
        _profile_id: &str,
        _profile_revision: u64,
        _profile_digest: &str,
    ) -> io::Result<crate::protocol::Value> {
        Err(io::Error::new(io::ErrorKind::Unsupported,
            "durable terminal process-tree containment is unavailable on this platform"))
    }
}

impl StdioProcess {
    /// Validate the trusted executable binding and prepare Linux OS confinement before
    /// any durable PREPARE/lease consumption. Unsupported platforms and profiles fail
    /// closed; there is no unconfined fallback.
    pub fn prepare_confined(spec: StdioLaunchSpec) -> io::Result<PreparedStdioLaunch> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = spec;
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "confined stdio process execution is unavailable on this platform",
            ));
        }
        #[cfg(target_os = "linux")]
        {
            use horizoncode_sandbox::{
                ConfinedProfile, ExpectedLevel, GuaranteeDimension, ProtectedSubpath, Sandbox,
                SandboxProfile, ScopedRoot, SpawnRequest, StdioPolicy,
            };
            validate_stdio_limits(&spec)?;
            let workspace = std::fs::canonicalize(&spec.workspace_root)?;
            let isolated_codemode = matches!(&spec.filesystem_policy, StdioFilesystemPolicyV1::CodeModeIsolated { .. });
            let cwd = if isolated_codemode { PathBuf::from("/tmp") } else { std::fs::canonicalize(&spec.cwd)? };
            if !workspace.is_absolute()
                || !std::fs::metadata(&workspace)?.is_dir()
                || (isolated_codemode && (spec.cwd != Path::new("/tmp") || !spec.writable_roots.is_empty()))
                || (!isolated_codemode && !cwd.starts_with(&workspace))
                || (!isolated_codemode && !std::fs::metadata(&cwd)?.is_dir())
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "process cwd must be a directory within the admitted workspace",
                ));
            }
            let executable = std::fs::canonicalize(&spec.executable)?;
            if !executable.is_absolute()
                || !std::fs::metadata(&executable)?.is_file()
                || executable_digest(&executable)? != spec.executable_digest
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "host-resolved executable digest or file binding changed",
                ));
            }
            let mut profile = ConfinedProfile::default();
            match &spec.filesystem_policy {
                StdioFilesystemPolicyV1::ReadOnlyWorkspace => {
                    if !spec.writable_roots.is_empty() {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "read-only process profiles cannot accept writable roots",
                        ));
                    }
                    profile.scoped_roots.push(ScopedRoot::read(workspace.clone()));
                }
                StdioFilesystemPolicyV1::ReadOnlyGitWorktreeMetadata { metadata_root } => {
                    if !spec.writable_roots.is_empty() {
                        return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                            "read-only Git Inspect cannot accept writable roots"));
                    }
                    let metadata = std::fs::symlink_metadata(metadata_root)?;
                    let metadata_canonical = std::fs::canonicalize(metadata_root)?;
                    let child_git_marker = workspace.join(".git");
                    let marker = std::fs::symlink_metadata(&child_git_marker)?;
                    if metadata.file_type().is_symlink() || !metadata.is_dir()
                        || metadata_canonical.starts_with(&workspace)
                        || workspace.starts_with(&metadata_canonical)
                        || marker.file_type().is_symlink() || !marker.is_file()
                    {
                        return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                            "Git Inspect metadata must be a separate authenticated directory and child .git marker a regular file"));
                    }
                    profile.scoped_roots = vec![
                        ScopedRoot::read(workspace.clone()),
                        ScopedRoot::read(metadata_canonical),
                    ];
                }
                StdioFilesystemPolicyV1::WorkspaceWrite => {
                    let mut writable_roots = Vec::with_capacity(spec.writable_roots.len());
                    for requested in &spec.writable_roots {
                        let root = std::fs::canonicalize(requested)?;
                        if !root.starts_with(&workspace)
                            || !std::fs::metadata(&root)?.is_dir()
                            || is_protected_workspace_path(&workspace, &root)
                            || writable_roots.contains(&root)
                        {
                            return Err(io::Error::new(
                                io::ErrorKind::PermissionDenied,
                                "process writable roots must be unique, existing scoped directories",
                            ));
                        }
                        writable_roots.push(root);
                    }
                    if !writable_roots.iter().any(|root| root == &workspace) {
                        // A writable root is readable too. Adding it again as a read-only
                        // root would cause bubblewrap to re-bind it read-only after the
                        // writable bind and silently deny the admitted writes.
                        profile
                            .scoped_roots
                            .push(ScopedRoot::read(workspace.clone()));
                    }
                    profile
                        .scoped_roots
                        .extend(writable_roots.into_iter().map(ScopedRoot::write));
                    profile.protected_subpaths = [".git", ".agents", ".codex", ".horizoncode"]
                        .into_iter()
                        .map(|name| ProtectedSubpath::directory(workspace.join(name)))
                        .collect();
                }
                StdioFilesystemPolicyV1::GitWorktreeLifecycle {
                    metadata_root,
                    destination_parent,
                } => {
                    if !spec.writable_roots.is_empty() {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "Git worktree profile cannot accept caller writable roots",
                        ));
                    }
                    let git_dir = workspace.join(".git");
                    let git_metadata = git_dir.join("worktrees");
                    let destination = workspace.join(".horizon").join("worktrees");
                    let git_meta = std::fs::symlink_metadata(&git_dir)?;
                    if git_meta.file_type().is_symlink() || !git_meta.is_dir() {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "Git worktree exception requires a local non-symlink .git directory",
                        ));
                    }
                    let metadata_canonical = std::fs::canonicalize(metadata_root)?;
                    let destination_canonical = std::fs::canonicalize(destination_parent)?;
                    if metadata_canonical != git_metadata
                        || destination_canonical != destination
                        || !std::fs::metadata(&metadata_canonical)?.is_dir()
                        || !std::fs::metadata(&destination_canonical)?.is_dir()
                        || metadata_canonical.starts_with(&destination_canonical)
                        || destination_canonical.starts_with(&metadata_canonical)
                    {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "Git worktree writable roots differ from the exact registered workspace subtrees",
                        ));
                    }
                    // Bubblewrap applies the read-only workspace mount first, then
                    // these two exact nested writable binds. Every other `.git` path
                    // therefore remains read-only; ordinary profiles still protect
                    // the entire `.git` tree.
                    profile.scoped_roots = vec![
                        ScopedRoot::read(workspace.clone()),
                        ScopedRoot::write(metadata_canonical),
                        ScopedRoot::write(destination_canonical),
                    ];
                    profile.protected_subpaths = [".agents", ".codex", ".horizoncode"]
                        .into_iter()
                        .map(|name| ProtectedSubpath::directory(workspace.join(name)))
                        .collect();
                }
                StdioFilesystemPolicyV1::CodeModeIsolated { package_root, entrypoint, helper_digest } => {
                    if !spec.writable_roots.is_empty() {
                        return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                            "CodeMode cannot receive writable host roots"));
                    }
                    let package = spec.code_mode_helper.as_ref().ok_or_else(invalid_launch_profile)?;
                    let package_canonical = std::fs::canonicalize(package_root)?;
                    let entrypoint_canonical = std::fs::canonicalize(entrypoint)?;
                    let metadata = std::fs::symlink_metadata(entrypoint)?;
                    let bytes = read_fixed_helper(entrypoint)?;
                    let actual_digest = format!("sha256:{}", ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref().iter().map(|byte| format!("{byte:02x}")).collect::<String>());
                    if package.package_root != package_canonical
                        || package.entrypoint != entrypoint_canonical
                        || package.helper_digest != *helper_digest
                        || actual_digest != *helper_digest
                        || metadata.file_type().is_symlink()
                        || !metadata.is_file()
                        || metadata.len() == 0
                        || metadata.len() > 16 * 1024 * 1024
                        || !entrypoint_canonical.starts_with(&package_canonical)
                        || package_canonical.starts_with(&workspace)
                        || workspace.starts_with(&package_canonical)
                        || spec.executable != package.executable
                        || spec.executable_digest != package.executable_digest
                        || spec.profile_digest != package.launch_profile_digest()?
                        || spec.argv != [OsString::from("run"), package.entrypoint.as_os_str().to_owned()]
                        || !spec.env.is_empty()
                    {
                        return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                            "CodeMode fixed helper package binding changed"));
                    }
                    // The helper is a self-contained installed artifact and is
                    // mounted read-only. Its current workspace is deliberately not
                    // visible; effects return through authenticated ToolBatch waves.
                    profile.scoped_roots.push(ScopedRoot::read(package_canonical));
                }
            }
            let profile = SandboxProfile::Confined(profile);
            static SANDBOX: std::sync::OnceLock<Sandbox> = std::sync::OnceLock::new();
            let sandbox = SANDBOX.get_or_init(Sandbox::probe);
            let unavailable = |error| {
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!("confined process backend unavailable: {error}"),
                )
            };
            let prepared = sandbox.prepare(&profile).map_err(unavailable)?;
            for dimension in [
                GuaranteeDimension::FilesystemRead,
                GuaranteeDimension::FilesystemWrite,
                GuaranteeDimension::NetworkEgress,
                GuaranteeDimension::ProcessTree,
            ] {
                prepared
                    .require(dimension, ExpectedLevel::ENFORCED)
                    .map_err(unavailable)?;
            }

            let mut request = SpawnRequest::new(&executable).cwd(&cwd);
            request.args = spec.argv.clone();
            request.env_vars = spec
                .env
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            request.stdin = StdioPolicy::Piped;
            request.stdout = StdioPolicy::Piped;
            request.stderr = StdioPolicy::Piped;
            let profile_digest = blake3::hash(profile.canonical_descriptor().as_bytes()).to_hex();
            let guarantee_record = prepared.guarantee_record();
            let mut hasher = blake3::Hasher::new();
            for part in [
                b"horizoncode.stdio.execution.v1".as_slice(),
                spec.profile_digest.as_bytes(),
                spec.workspace_revision.as_bytes(),
                workspace.to_string_lossy().as_bytes(),
                executable.to_string_lossy().as_bytes(),
                spec.executable_digest.as_bytes(),
                profile_digest.as_bytes(),
                cwd.to_string_lossy().as_bytes(),
            ] {
                hasher.update(&(part.len() as u64).to_be_bytes());
                hasher.update(part);
            }
            for argument in &spec.argv {
                let bytes = argument.as_encoded_bytes();
                hasher.update(&(bytes.len() as u64).to_be_bytes());
                hasher.update(bytes);
            }
            for root in &spec.writable_roots {
                let bytes = root.as_os_str().as_encoded_bytes();
                hasher.update(&(bytes.len() as u64).to_be_bytes());
                hasher.update(bytes);
            }
            for (key, value) in &spec.env {
                for part in [key.as_encoded_bytes(), value.as_encoded_bytes()] {
                    hasher.update(&(part.len() as u64).to_be_bytes());
                    hasher.update(part);
                }
            }
            hasher.update(&(spec.timeout.as_millis() as u64).to_be_bytes());
            hasher.update(&(spec.max_output_bytes as u64).to_be_bytes());
            hasher.update(&[u8::from(spec.capture_output_for_host)]);
            hasher.update(&(guarantee_record.len() as u64).to_be_bytes());
            hasher.update(guarantee_record.as_bytes());
            Ok(PreparedStdioLaunch {
                guarantee_record,
                prepared,
                request,
                executable_path: executable,
                executable_digest: spec.executable_digest.clone(),
                execution_digest: format!("blake3:{}", hasher.finalize().to_hex()),
                timeout: spec.timeout,
                max_output_bytes: spec.max_output_bytes,
                capture_output_for_host: spec.capture_output_for_host,
            })
        }
    }

    /// Consume a successful preflight only after durable intent and Guard lease admission.
    pub fn spawn_prepared(prepared: PreparedStdioLaunch) -> io::Result<Self> {
        Self::spawn_prepared_inner(prepared, None, None)
    }

    fn spawn_prepared_in_cgroup(
        prepared: PreparedStdioLaunch,
        cgroup_procs_fd: i32,
        max_open_files: Option<u64>,
    ) -> io::Result<Self> {
        Self::spawn_prepared_inner(prepared, Some(cgroup_procs_fd), max_open_files)
    }

    fn spawn_prepared_inner(
        prepared: PreparedStdioLaunch,
        cgroup_procs_fd: Option<i32>,
        max_open_files: Option<u64>,
    ) -> io::Result<Self> {
        // The profile may sit in an approval queue after confinement preflight.
        // Re-resolve and hash it again immediately before the sandbox launcher
        // receives the executable path; a replaced binary never starts under the
        // older Guard decision.
        let executable = std::fs::canonicalize(&prepared.executable_path)?;
        if executable != prepared.executable_path
            || executable_digest(&executable)? != prepared.executable_digest
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "trusted executable changed after preflight and before spawn",
            ));
        }
        let mut child = match cgroup_procs_fd {
            Some(fd) => prepared.prepared.spawn_in_cgroup(&prepared.request, fd, max_open_files),
            None => prepared.prepared.spawn(&prepared.request),
        }
        .map_err(|error| io::Error::other(error.to_string()))?;
        let deadline = Instant::now() + prepared.timeout;
        let stdin = child.take_stdin();
        let stdout = child.take_stdout();
        let stderr = child.take_stderr();
        #[cfg(target_os = "linux")]
        {
            for fd in [
                stdin.as_ref().map(AsRawFd::as_raw_fd),
                stdout.as_ref().map(AsRawFd::as_raw_fd),
                stderr.as_ref().map(AsRawFd::as_raw_fd),
            ]
            .into_iter()
            .flatten()
            {
                let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
                if flags < 0
                    || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
                {
                    let _ = child.kill();
                    return Err(io::Error::last_os_error());
                }
            }
        }
        Ok(Self {
            child,
            timeout: prepared.timeout,
            deadline,
            stdin,
            stdout,
            stderr,
            stdout_sequence: 0,
            stderr_sequence: 0,
            max_output_bytes: prepared.max_output_bytes,
            output_bytes: 0,
            output_limit_exceeded: false,
            input_bytes: 0,
            stdout_hasher: blake3::Hasher::new(),
            stderr_hasher: blake3::Hasher::new(),
            stdout_capture: Vec::new(),
            stderr_capture: Vec::new(),
            observed_output_taken: false,
            capture_output_for_host: prepared.capture_output_for_host,
        })
    }

    /// Transfer the bounded bytes only after the supervisor has observed child exit.
    /// The transfer is one-use and may return a truncated prefix when the configured
    /// output limit was exceeded; the independent process status records that fact.
    pub(crate) fn take_observed_output(&mut self) -> io::Result<StdioObservedOutputV1> {
        if !self.capture_output_for_host
            || self.observed_output_taken
            || (!self.output_limit_exceeded && (self.stdout.is_some() || self.stderr.is_some()))
            || self
                .child
                .try_wait()
                .map_err(|error| io::Error::other(error.to_string()))?
                .is_none()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process output is not settled or was already transferred",
            ));
        }
        self.observed_output_taken = true;
        Ok(StdioObservedOutputV1 {
            stdout: std::mem::take(&mut self.stdout_capture),
            stderr: std::mem::take(&mut self.stderr_capture),
        })
    }

    pub fn pid(&self) -> u32 {
        self.child.pid()
    }

    /// Write one bounded input frame to the child. This confirms only local pipe
    /// delivery; it does not claim the child processed the request.
    pub fn write_stdin(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty()
            || bytes.len() > MAX_INPUT_BYTES
            || self
                .input_bytes
                .checked_add(bytes.len())
                .is_none_or(|total| total > MAX_STDIO_INPUT_TOTAL_BYTES)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process input frame exceeds its bound",
            ));
        }
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "process stdin is closed"))?;
        #[cfg(target_os = "linux")]
        let written = write_pipe_until(stdin, bytes, self.deadline);
        #[cfg(not(target_os = "linux"))]
        let written = Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined process stdin is unavailable on this platform",
        ));
        if let Err(error) = written {
            // A partial frame can already have reached the child. Stop this exact
            // process and let the caller persist UNKNOWN/reconcile; never continue
            // sending the suffix or treat the failed write as absent.
            let _ = self.child.kill();
            return Err(error);
        }
        self.input_bytes = self.input_bytes.saturating_add(bytes.len());
        Ok(())
    }

    /// Drain currently available stdout/stderr bytes without blocking either stream.
    /// The page is bounded independently of the total output cap. Once a byte beyond
    /// the admitted cap is observed, it is discarded and the child is terminated;
    /// callers must still observe exit before settling the effect.
    pub fn read_output_page(
        &mut self,
        generation: u64,
        after_stdout_sequence: u64,
        after_stderr_sequence: u64,
        max_bytes: usize,
    ) -> io::Result<StdioOutputPage> {
        if generation == 0
            || after_stdout_sequence != self.stdout_sequence
            || after_stderr_sequence != self.stderr_sequence
            || max_bytes == 0
            || max_bytes > MAX_STDIO_OUTPUT_PAGE_BYTES
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid process output cursor or page bound",
            ));
        }

        let mut records = Vec::new();
        let mut page_bytes = 0usize;
        let mut stdout_turn = true;
        while page_bytes < max_bytes && !self.output_limit_exceeded {
            let order = if stdout_turn {
                [StdioOutputSource::Stdout, StdioOutputSource::Stderr]
            } else {
                [StdioOutputSource::Stderr, StdioOutputSource::Stdout]
            };
            let mut made_progress = false;
            for source in order {
                let remaining_output = self.max_output_bytes.saturating_sub(self.output_bytes);
                let response_remaining = max_bytes.saturating_sub(page_bytes);
                let requested = STDIO_OUTPUT_CHUNK_BYTES
                    .min(response_remaining)
                    .min(remaining_output.saturating_add(1));
                if requested == 0 {
                    break;
                }
                let mut buffer = vec![0; requested];
                let read_result = match source {
                    StdioOutputSource::Stdout => {
                        self.stdout.as_mut().map(|stream| stream.read(&mut buffer))
                    }
                    StdioOutputSource::Stderr => {
                        self.stderr.as_mut().map(|stream| stream.read(&mut buffer))
                    }
                };
                let Some(read_result) = read_result else {
                    continue;
                };
                match read_result {
                    Ok(0) => match source {
                        StdioOutputSource::Stdout => self.stdout = None,
                        StdioOutputSource::Stderr => self.stderr = None,
                    },
                    Ok(count) => {
                        made_progress = true;
                        let accepted = count.min(remaining_output);
                        if accepted > 0 {
                            if self.capture_output_for_host {
                                let capture = match source {
                                    StdioOutputSource::Stdout => &mut self.stdout_capture,
                                    StdioOutputSource::Stderr => &mut self.stderr_capture,
                                };
                                capture.try_reserve(accepted).map_err(|_| {
                                    io::Error::other(
                                        "bounded process output capture allocation failed",
                                    )
                                })?;
                                capture.extend_from_slice(&buffer[..accepted]);
                            }
                            match source {
                                StdioOutputSource::Stdout => {
                                    self.stdout_hasher.update(&buffer[..accepted]);
                                }
                                StdioOutputSource::Stderr => {
                                    self.stderr_hasher.update(&buffer[..accepted]);
                                }
                            }
                            buffer.truncate(accepted);
                            self.output_bytes = self.output_bytes.saturating_add(accepted);
                            page_bytes = page_bytes.saturating_add(accepted);
                            let sequence = match source {
                                StdioOutputSource::Stdout => &mut self.stdout_sequence,
                                StdioOutputSource::Stderr => &mut self.stderr_sequence,
                            };
                            *sequence = sequence.checked_add(1).ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "process output sequence overflow",
                                )
                            })?;
                            records.push(StdioOutputRecord {
                                source,
                                sequence: *sequence,
                                bytes: buffer,
                            });
                        }
                        if count > accepted {
                            self.output_limit_exceeded = true;
                            self.request_terminate()?;
                            break;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(error),
                }
                if page_bytes >= max_bytes || self.output_limit_exceeded {
                    break;
                }
            }
            if !made_progress {
                break;
            }
            stdout_turn = !stdout_turn;
        }
        let eof = self.stdout.is_none() && self.stderr.is_none() && self.try_wait()?.is_some();
        Ok(StdioOutputPage {
            generation,
            records,
            next_stdout_sequence: self.stdout_sequence,
            next_stderr_sequence: self.stderr_sequence,
            eof,
            truncated: self.output_limit_exceeded,
        })
    }

    /// Ask the confined backend to terminate. `Some` from `try_wait` is still required
    /// before a caller may persist an observed exit receipt.
    pub fn request_terminate(&mut self) -> io::Result<()> {
        self.child
            .kill()
            .map_err(|error| io::Error::other(error.to_string()))
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child
            .try_wait()
            .map(|outcome| outcome.map(|outcome| outcome.status))
            .map_err(|error| io::Error::other(error.to_string()))
    }

    /// The timeout is capped by the admitted request. On expiry the process is signalled,
    /// but the caller must continue observing `try_wait` before settling the outcome.
    pub fn wait_timeout(&mut self, timeout: Duration) -> io::Result<WaitOutcome> {
        let deadline = Instant::now().checked_add(timeout.min(self.timeout));
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(WaitOutcome::Exited(status));
            }
            if deadline.is_none_or(|deadline| Instant::now() >= deadline) {
                self.request_terminate()?;
                return Ok(WaitOutcome::TimedOut);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl StdioExecutionSupervisor {
    /// Produce a no-child assessment for Guard's pre-approval projection. The same
    /// immutable launch inputs are prepared again after approval; callers must bind
    /// this record to the challenge and require the later digest to match.
    pub(crate) fn assess_launch(
        spec: StdioLaunchSpec,
    ) -> io::Result<StdioLaunchAssessmentV1> {
        let prepared = StdioProcess::prepare_confined(spec)?;
        Ok(StdioLaunchAssessmentV1 {
            execution_digest: prepared.execution_digest.clone(),
            guarantee_record: prepared.guarantee_record.clone(),
            guarantees: prepared.prepared.guarantees().to_vec(),
        })
    }

    /// Run sandbox/executable preflight and retain the prepared object for exactly one
    /// later dispatch. This method creates no durable intent and consumes no Guard lease.
    pub fn preflight(
        &mut self,
        binding: StdioExecutionBindingV1,
        mut spec: StdioLaunchSpec,
    ) -> io::Result<StdioExecutionPreparedV1> {
        let process_kind = stdio_process_kind_for_capability(&binding.capability_id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported,
                "process capability has no supervised ExecutionHost adapter"))?;
        if (binding.capability_id == crate::guard::FILES_READ_ID) != spec.fixed_git_read {
            return Err(io::Error::new(io::ErrorKind::Unsupported,
                "files.read is available only through the fixed Git read adapter"));
        }
        let is_code_mode = binding.capability_id == crate::guard::CODE_MODE_EXECUTE_ID;
        if is_code_mode {
            let package = spec.code_mode_helper.clone().ok_or_else(|| {
                io::Error::new(io::ErrorKind::Unsupported,
                    "fixed CodeMode helper package is unavailable")
            })?;
            spec.use_codemode_isolation(&package);
            if binding.profile_id != CodeModeHelperPackageV1::PROFILE_ID
                || binding.profile_revision != CodeModeHelperPackageV1::PROFILE_REVISION
                || binding.profile_digest != package.launch_profile_digest()?
                || binding.executable_digest != package.executable_digest
                || spec.timeout > Duration::from_secs(30)
                || spec.max_output_bytes > MAX_OUTPUT_BYTES
            {
                return Err(io::Error::new(io::ErrorKind::InvalidInput,
                    "CodeMode binding differs from its fixed helper profile or bounded execution budget"));
            }
        }
        validate_stdio_binding(&binding, &spec)?;
        if self.executions.contains_key(&binding.execution_id)
            || self.executions.len() >= MAX_ACTIVE_STDIO_EXECUTIONS
        {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "execution identifier is active or process capacity is exhausted",
            ));
        }
        let prepared = StdioProcess::prepare_confined(spec)?;
        let execution_digest = bind_stdio_execution_digest(
            prepared.execution_digest(),
            &binding.approved_arguments_digest,
            &binding.execution_principal,
        );
        #[cfg(not(target_os = "linux"))]
        if is_code_mode {
            return Err(io::Error::new(io::ErrorKind::Unsupported,
                "CodeMode OS resource profile is unavailable on this platform"));
        }
        #[cfg(target_os = "linux")]
        let resource_profile = if is_code_mode {
            "codemode.v1"
        } else {
            "none"
        };
        #[cfg(target_os = "linux")]
        let cgroup = Some(crate::cgroup_v2::ExecutionCgroupV2::create(
            &binding.execution_id,
            &binding.effect_id,
            &binding.capability_lease_digest,
            &binding.execution_principal,
            binding.attempt_scope_digest.as_deref(),
            binding.owner_epoch,
            binding.generation,
            process_kind.wire_name(),
            &binding.profile_id,
            binding.profile_revision,
            &binding.profile_digest,
            &binding.executable_digest,
            resource_profile,
            prepared.prepared.proves_cgroup_hierarchy_hidden(),
        )?);
        #[cfg(not(target_os = "linux"))]
        let cgroup: Option<()> = None;
        #[cfg(target_os = "linux")]
        let cgroup_identity = cgroup.as_ref().map(|cgroup| cgroup.identity().to_value());
        #[cfg(not(target_os = "linux"))]
        let cgroup_identity = None;
        let response = StdioExecutionPreparedV1 {
            execution_id: binding.execution_id.clone(),
            generation: binding.generation,
            launch_digest: prepared.execution_digest.clone(),
            guarantee_digest: guarantee_record_digest(&prepared.guarantee_record),
            execution_digest: execution_digest.clone(),
            approved_arguments_digest: binding.approved_arguments_digest.clone(),
            confinement_record: prepared.guarantee_record().to_owned(),
            capability_lease_digest: binding.capability_lease_digest.clone(),
            cgroup_identity,
            resource_guarantees: if is_code_mode {
                ProcessResourceGuaranteesV1::for_code_mode_linux()
            } else {
                ProcessResourceGuaranteesV1::for_current_backend()
            },
        };
        let timeout = prepared.timeout;
        self.executions.insert(
            binding.execution_id.clone(),
            StdioExecutionRecord {
                binding,
                prepared: Some(prepared),
                process: None,
                state: StdioExecutionStateV1::Prepared,
                exit_code: None,
                deadline: Instant::now() + timeout,
                dispatch_intent_id: None,
                execution_digest,
                started_at: None,
                finished_at: None,
                #[cfg(target_os = "linux")]
                cgroup,
            },
        );
        Ok(response)
    }

    /// Launch only after EffectHost returned a durable intent for the exact preflight
    /// binding and digest. A mismatch leaves the child unspawned.
    pub fn launch(
        &mut self,
        intent: StdioExecutionDispatchIntentV1,
    ) -> io::Result<StdioExecutionStatusV1> {
        let record = self.record_mut(&intent.binding)?;
        let prepared = record.prepared.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "execution preflight was consumed",
            )
        })?;
        if record.state != StdioExecutionStateV1::Prepared
            || record.execution_digest != intent.execution_digest
            || intent.intent_id.is_empty()
        {
            record.prepared = Some(prepared);
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "durable intent does not match the prepared execution",
            ));
        }
        #[cfg(target_os = "linux")]
        let process = {
            let cgroup = record.cgroup.as_ref().ok_or_else(|| {
                io::Error::new(io::ErrorKind::Unsupported, "execution cgroup is unavailable")
            })?;
            StdioProcess::spawn_prepared_in_cgroup(
                prepared,
                cgroup.placement_fd(),
                (record.binding.capability_id == crate::guard::CODE_MODE_EXECUTE_ID)
                    .then_some(CodeModeResourceProfileV1::NOFILE_MAX),
            )?
        };
        #[cfg(not(target_os = "linux"))]
        let process = StdioProcess::spawn_prepared(prepared)?;
        // Process time starts at dispatch, never at preflight/approval.
        record.deadline = process.deadline;
        record.state = StdioExecutionStateV1::Running;
        record.process = Some(process);
        record.started_at = Some(Instant::now());
        record.dispatch_intent_id = Some(intent.intent_id);
        Ok(stdio_status(&intent.binding.execution_id, record))
    }

    /// Release an exact preflight that was never durably dispatched. This does not
    /// change or settle the durable EffectHost challenge.
    pub fn discard_preflight(&mut self, binding: &StdioExecutionBindingV1) -> io::Result<()> {
        let record = self.record_mut(binding)?;
        if record.state != StdioExecutionStateV1::Prepared
            || record.prepared.is_none()
            || record.process.is_some()
            || record.dispatch_intent_id.is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "only an exact unstarted preflight can be discarded",
            ));
        }
        #[cfg(target_os = "linux")]
        if let Some(cgroup) = record.cgroup.as_ref() {
            crate::cgroup_v2::ExecutionCgroupV2::retain_if_empty(cgroup.identity())?;
        }
        self.executions.remove(&binding.execution_id);
        Ok(())
    }

    /// Resolve a process id only for internal HostKernel-to-adapter translation.
    /// The id is never serialized to Core and is available only for the exact live
    /// generation binding.
    pub(crate) fn process_pid(&self, binding: &StdioExecutionBindingV1) -> io::Result<u32> {
        let record = self.executions.get(&binding.execution_id).ok_or_else(||
            io::Error::new(io::ErrorKind::NotFound, "execution identifier is unknown"))?;
        if record.binding != *binding || record.state != StdioExecutionStateV1::Running {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "process PID is unavailable for a stale or non-running binding"));
        }
        record.process.as_ref().map(StdioProcess::pid).ok_or_else(||
            io::Error::new(io::ErrorKind::NotFound, "live process handle is unavailable"))
    }

    /// Transfer internally retained bytes for a verifier only after the bound process
    /// exited. Complete output requires both pipes to reach EOF; a capped process may
    /// transfer its bounded prefix with truncation independently recorded in status.
    pub(crate) fn take_observed_output(
        &mut self,
        binding: &StdioExecutionBindingV1,
    ) -> io::Result<StdioObservedOutputV1> {
        let record = self.record_mut(binding)?;
        if record.state != StdioExecutionStateV1::Exited {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process output cannot be transferred before observed exit",
            ));
        }
        record
            .process
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "execution process is absent"))?
            .take_observed_output()
    }

    pub fn write_input(
        &mut self,
        binding: &StdioExecutionBindingV1,
        bytes: &[u8],
    ) -> io::Result<()> {
        let record = self.record_mut(binding)?;
        if record.state != StdioExecutionStateV1::Running {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "execution is not running",
            ));
        }
        if Instant::now() >= record.deadline {
            if let Some(process) = record.process.as_mut() {
                let _ = process.request_terminate();
            }
            record.state = StdioExecutionStateV1::Cancelling;
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process stdin delivery exceeded the execution deadline",
            ));
        }
        let result = record
            .process
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "execution process is absent"))?
            .write_stdin(bytes);
        if result.is_err() {
            // Input delivery may have been partial. The process handle attempts a
            // best-effort kill; keep the lifecycle fenced until exit is observed.
            record.state = StdioExecutionStateV1::Cancelling;
        }
        result
    }

    pub fn read_output(
        &mut self,
        binding: &StdioExecutionBindingV1,
        after_stdout_sequence: u64,
        after_stderr_sequence: u64,
        max_bytes: usize,
    ) -> io::Result<StdioOutputPage> {
        let record = self.record_mut(binding)?;
        if record.state == StdioExecutionStateV1::Running && Instant::now() >= record.deadline {
            if let Some(process) = record.process.as_mut() {
                process.request_terminate()?;
            }
            record.state = StdioExecutionStateV1::Cancelling;
        }
        let process = record.process.as_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "execution process is absent")
        })?;
        let page = process.read_output_page(
            binding.generation,
            after_stdout_sequence,
            after_stderr_sequence,
            max_bytes,
        )?;
        if let Some(status) = process.try_wait()? {
            record.exit_code = status.code();
            record.state = StdioExecutionStateV1::Exited;
            record.finished_at = Some(Instant::now());
        }
        Ok(page)
    }

    pub fn cancel(
        &mut self,
        binding: &StdioExecutionBindingV1,
    ) -> io::Result<StdioExecutionStatusV1> {
        let record = self.record_mut(binding)?;
        if record.state == StdioExecutionStateV1::Running {
            record
                .process
                .as_mut()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "execution process is absent")
                })?
                .request_terminate()?;
            record.state = StdioExecutionStateV1::Cancelling;
        }
        observe_stdio_exit(record)?;
        Ok(stdio_status(&binding.execution_id, record))
    }

    pub fn status(
        &mut self,
        binding: &StdioExecutionBindingV1,
    ) -> io::Result<StdioExecutionStatusV1> {
        let record = self.record_mut(binding)?;
        observe_stdio_exit(record)?;
        Ok(stdio_status(&binding.execution_id, record))
    }

    /// Fence an unresolved process after owner loss. This records UNKNOWN and prevents
    /// redispatch. It does not establish process-tree exit: dropping the wrapper handle
    /// is not proof that descendants have stopped. The caller must persist UNKNOWN,
    /// retain the durable capacity reservation, and never call launch again.
    pub fn mark_unknown(
        &mut self,
        binding: &StdioExecutionBindingV1,
    ) -> io::Result<StdioExecutionStatusV1> {
        let record = self.record_mut(binding)?;
        record.prepared = None;
        record.state = StdioExecutionStateV1::Unknown;
        Ok(stdio_status(&binding.execution_id, record))
    }

    fn record_mut(
        &mut self,
        binding: &StdioExecutionBindingV1,
    ) -> io::Result<&mut StdioExecutionRecord> {
        let record = self
            .executions
            .get_mut(&binding.execution_id)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "execution identifier is unknown")
            })?;
        if record.binding != *binding {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "execution binding, owner epoch, generation, or Attempt scope changed",
            ));
        }
        Ok(record)
    }
}

fn validate_stdio_binding(
    binding: &StdioExecutionBindingV1,
    spec: &StdioLaunchSpec,
) -> io::Result<()> {
    let valid_id = |value: &str| {
        !value.is_empty()
            && value.len() <= 256
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
            })
    };
    let valid_blake3 = |value: &str| {
        value.len() == 71
            && value.starts_with("blake3:")
            && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    let scope_valid = match &binding.scope {
        StdioExecutionScopeV1::Session { session_id } => {
            valid_id(session_id) && session_id == &binding.session_id
        }
        StdioExecutionScopeV1::ProjectRead { workspace_id } => {
            valid_id(workspace_id)
                && binding.session_id.is_empty()
                && binding.capability_id == crate::guard::FILES_READ_ID
                && binding.attempt_scope_digest.is_none()
        }
    };
    if stdio_process_kind_for_capability(&binding.capability_id).is_none()
        || !scope_valid
        || (binding.capability_id == crate::guard::FILES_READ_ID) != spec.fixed_git_read
        || !valid_id(&binding.execution_id)
        || !valid_id(&binding.effect_id)
        || !valid_id(&binding.challenge_id)
        || !valid_id(&binding.location_id)
        || !valid_id(&binding.capability_id)
        || !valid_id(&binding.profile_ref)
        || !valid_id(&binding.profile_id)
        || !valid_id(&binding.principal)
        || !valid_id(&binding.execution_principal)
        || binding.session_id.len() > 256
        || binding.owner_epoch == 0
        || binding.generation == 0
        || !valid_blake3(&binding.capability_lease_digest)
        || !valid_blake3(&binding.approved_arguments_digest)
        || binding
            .attempt_scope_digest
            .as_ref()
            .is_some_and(|value| !valid_blake3(value))
        || !valid_blake3(&binding.workspace_revision)
        || binding.profile_revision == 0
        || !valid_blake3(&binding.profile_digest)
        || !valid_blake3(&binding.executable_digest)
        || spec.workspace_revision != binding.workspace_revision
        || !valid_blake3(&spec.profile_digest)
        || spec.profile_digest != binding.profile_digest
        || spec.executable_digest != binding.executable_digest
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "execution binding is malformed or does not match its trusted launch profile",
        ));
    }
    Ok(())
}

pub(crate) fn stdio_process_kind_for_capability(capability_id: &str) -> Option<StdioProcessKindV1> {
    match capability_id {
        crate::guard::TERMINAL_RUN_ID | crate::guard::TERMINAL_START_ID => Some(StdioProcessKindV1::TerminalRun),
        crate::guard::FILES_READ_ID => Some(StdioProcessKindV1::GitRead),
        crate::guard::LANGUAGE_SERVER_START_ID => Some(StdioProcessKindV1::LanguageServer),
        crate::guard::DEBUG_START_ID => Some(StdioProcessKindV1::DebugAdapter),
        crate::guard::REPL_START_ID => Some(StdioProcessKindV1::Interpreter),
        crate::guard::CODE_MODE_EXECUTE_ID => Some(StdioProcessKindV1::CodeModeHelper),
        crate::guard::EDITOR_LAUNCH_ID => Some(StdioProcessKindV1::ExternalEditor),
        crate::guard::BUILTIN_VERIFIER_ID => Some(StdioProcessKindV1::ManagedVerifier),
        _ => None,
    }
}

pub(crate) fn bind_stdio_execution_digest(spec_digest: &str, approved_arguments_digest: &str, execution_principal: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.stdio.approved-execution.v1\0");
    for value in [spec_digest.as_bytes(), approved_arguments_digest.as_bytes(), execution_principal.as_bytes()] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn observe_stdio_exit(record: &mut StdioExecutionRecord) -> io::Result<()> {
    if matches!(
        record.state,
        StdioExecutionStateV1::Running | StdioExecutionStateV1::Cancelling
    ) && let Some(process) = record.process.as_mut()
        && let Some(status) = process.try_wait()?
    {
        record.exit_code = status.code();
        record.state = StdioExecutionStateV1::Exited;
        record.finished_at = Some(Instant::now());
    }
    Ok(())
}

fn stdio_status(execution_id: &str, record: &StdioExecutionRecord) -> StdioExecutionStatusV1 {
    let empty_digest = format!("blake3:{}", blake3::hash(b"").to_hex());
    let output = record.process.as_ref();
    StdioExecutionStatusV1 {
        execution_id: execution_id.to_owned(),
        generation: record.binding.generation,
        state: record.state,
        stdout_sequence: record
            .process
            .as_ref()
            .map_or(0, |process| process.stdout_sequence),
        stderr_sequence: record
            .process
            .as_ref()
            .map_or(0, |process| process.stderr_sequence),
        exit_code: record.exit_code,
        stdout_digest: output.map_or_else(
            || empty_digest.clone(),
            |process| {
                format!(
                    "blake3:{}",
                    process.stdout_hasher.clone().finalize().to_hex()
                )
            },
        ),
        stderr_digest: output.map_or(empty_digest, |process| {
            format!(
                "blake3:{}",
                process.stderr_hasher.clone().finalize().to_hex()
            )
        }),
        output_bytes: output.map_or(0, |process| process.output_bytes as u64),
        truncated: output.is_some_and(|process| process.output_limit_exceeded),
        duration_ms: record.started_at.map_or(0, |started| {
            record
                .finished_at
                .unwrap_or_else(Instant::now)
                .saturating_duration_since(started)
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX)
        }),
        receipt_digest: None,
    }
}

const MAX_ACTIVE_STDIO_EXECUTIONS: usize = 32;

impl Drop for StdioProcess {
    fn drop(&mut self) {
        if self.try_wait().ok().flatten().is_none() {
            let _ = self.request_terminate();
        }
    }
}

pub fn executable_digest(path: impl AsRef<Path>) -> io::Result<String> {
    let path = std::fs::canonicalize(path)?;
    let metadata = std::fs::metadata(&path)?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "executable is not a bounded regular file",
        ));
    }
    let bytes = std::fs::read(path)?;
    Ok(format!("blake3:{}", blake3::hash(&bytes).to_hex()))
}

fn validate_stdio_limits(spec: &StdioLaunchSpec) -> io::Result<()> {
    if spec.argv.len() > MAX_STDIO_ARGUMENTS
        || spec.writable_roots.len() > 32
        || spec.env.len() > MAX_STDIO_ENV_ITEMS
        || spec.timeout.is_zero()
        || spec.timeout > MAX_STDIO_TIMEOUT
        || spec.max_output_bytes == 0
        || spec.max_output_bytes > MAX_STDIO_OUTPUT_BYTES
        || !spec.executable_digest.starts_with("blake3:")
        || spec.executable_digest.len() != 71
        || !spec.executable_digest[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process launch exceeds a hard bound or has an invalid executable digest",
        ));
    }
    let mut argument_bytes = 0usize;
    for argument in &spec.argv {
        let bytes = argument.as_encoded_bytes();
        if bytes.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "argv contains NUL",
            ));
        }
        argument_bytes = argument_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "argv size overflow"))?;
        if argument_bytes > MAX_STDIO_ARGUMENT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "argv is too large",
            ));
        }
    }
    let mut env_bytes = 0usize;
    for (key, value) in &spec.env {
        let key = key.as_encoded_bytes();
        let value = value.as_encoded_bytes();
        if !matches!(
            key,
            b"PATH" | b"HOME" | b"LANG" | b"LC_ALL" | b"LC_CTYPE" | b"TMPDIR" | b"XDG_CACHE_HOME"
        ) || key.is_empty()
            || key.contains(&0)
            || value.contains(&0)
            || value.len() > MAX_STDIO_ENV_VALUE_BYTES
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process environment contains a disallowed key or value",
            ));
        }
        env_bytes = env_bytes
            .checked_add(key.len() + value.len())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "environment size overflow")
            })?;
        if env_bytes > MAX_STDIO_ENV_ITEMS * MAX_STDIO_ENV_VALUE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process environment is too large",
            ));
        }
    }
    Ok(())
}

/// Write a single bounded pipe frame without blocking the HostKernel request
/// thread. The deadline is the process's original wall-time budget, not a fresh
/// timeout per frame. A caller that sees an error must treat a partial write as
/// uncertain and stop/reconcile the child.
#[cfg(target_os = "linux")]
fn write_pipe_until(
    pipe: &mut std::process::ChildStdin,
    bytes: &[u8],
    deadline: Instant,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let fd = pipe.as_raw_fd();
    let mut offset = 0usize;
    while offset < bytes.len() {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process stdin delivery exceeded the execution deadline",
            ));
        }
        // SAFETY: `bytes[offset..]` is a valid readable range for the duration
        // of this call, and `fd` is the live child stdin pipe owned by `pipe`.
        let result = unsafe {
            libc::write(
                fd,
                bytes[offset..].as_ptr().cast(),
                bytes.len() - offset,
            )
        };
        if result > 0 {
            offset = offset.saturating_add(result as usize);
            continue;
        }
        if result == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "process stdin pipe accepted no bytes",
            ));
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(libc::EAGAIN) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    continue;
                }
                let timeout_ms = remaining.as_millis().clamp(1, 50) as libc::c_int;
                let mut descriptor = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                // SAFETY: `descriptor` is a valid single-element poll array.
                let polled = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
                if polled < 0 {
                    let poll_error = io::Error::last_os_error();
                    if poll_error.raw_os_error() == Some(libc::EINTR) {
                        continue;
                    }
                    return Err(poll_error);
                }
                if descriptor.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "child closed process stdin",
                    ));
                }
            }
            _ => return Err(error),
        }
    }
    Ok(())
}

fn is_protected_workspace_path(workspace: &Path, candidate: &Path) -> bool {
    [".git", ".agents", ".codex", ".horizoncode"]
        .into_iter()
        .any(|name| candidate.starts_with(workspace.join(name)))
}

impl TerminalProcess {
    pub(crate) fn prepared_launch_digest(prepared: &PreparedTerminalLaunch) -> &str {
        &prepared.launch_digest
    }

    pub(crate) fn prepared_executable_digest(prepared: &PreparedTerminalLaunch) -> &str {
        &prepared.executable_digest
    }

    /// Terminate every remaining descendant in this launch's exact cgroup and prove
    /// the kernel reports it empty. A PTY leader exiting is not enough: it may have
    /// left children behind. The returned digest is containment evidence, not a
    /// successful command/effect receipt.
    #[cfg(target_os = "linux")]
    pub(crate) fn quiesce_process_tree(&self) -> io::Result<String> {
        let cgroup = self.cgroup.as_ref().ok_or_else(|| io::Error::new(
            io::ErrorKind::Unsupported,
            "terminal process has no durable cgroup-v2 containment identity",
        ))?;
        let proof = crate::cgroup_v2::ExecutionCgroupV2::kill_and_confirm_empty(cgroup.identity())?;
        crate::cgroup_v2::ExecutionCgroupV2::retain_if_empty(cgroup.identity())?;
        Ok(proof)
    }

    #[cfg(not(target_os = "linux"))]
    pub(crate) fn quiesce_process_tree(&self) -> io::Result<String> {
        Err(io::Error::new(io::ErrorKind::Unsupported,
            "terminal process-tree containment is unavailable on this platform"))
    }

    /// Compute the digest used by the consent preflight for an exact caller-side launch
    /// specification, before wrapping it with the selected sandbox command.
    pub fn launch_digest_for(
        spec: &TerminalLaunchSpec,
        workspace_root: &Path,
    ) -> io::Result<String> {
        let workspace = std::fs::canonicalize(workspace_root)?;
        terminal_launch_digest(spec, &workspace)
    }

    /// Preflight before consuming a capability lease or persisting PREPARE.
    /// This cannot opt into full-access or silently fall back to an unconfined process.
    pub fn prepare_confined(
        mut spec: TerminalLaunchSpec,
        workspace_root: &Path,
    ) -> io::Result<PreparedTerminalLaunch> {
        use horizoncode_sandbox::{
            ExpectedLevel, GuaranteeDimension, Sandbox, SandboxProfile, SpawnRequest,
        };
        validate_size(spec.cols, spec.rows)?;
        let workspace = std::fs::canonicalize(workspace_root)?;
        let cwd = std::fs::canonicalize(&spec.cwd)?;
        if workspace.parent().is_none() || !cwd.starts_with(&workspace) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "terminal cwd must be within a scoped workspace",
            ));
        }
        static SANDBOX: std::sync::OnceLock<Sandbox> = std::sync::OnceLock::new();
        let sandbox = SANDBOX.get_or_init(Sandbox::probe);
        let profile = SandboxProfile::workspace_write(&workspace);
        let unavailable = |error| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                format!("terminal confinement unavailable: {error}"),
            )
        };
        let prepared = sandbox.prepare(&profile).map_err(unavailable)?;
        for dimension in [
            GuaranteeDimension::FilesystemRead,
            GuaranteeDimension::FilesystemWrite,
            GuaranteeDimension::NetworkEgress,
            GuaranteeDimension::ProcessTree,
        ] {
            prepared
                .require(dimension, ExpectedLevel::ENFORCED)
                .map_err(unavailable)?;
        }
        let mut request = SpawnRequest::new(&spec.executable).cwd(&cwd);
        request.args = spec.argv.clone();
        request.preserve_controlling_terminal = true;
        let launch_digest = terminal_launch_digest(&spec, &workspace)?;
        let executable_path = std::fs::canonicalize(&spec.executable)?;
        let executable_digest = executable_digest(&executable_path)?;
        let cgroup_hierarchy_hidden = prepared.proves_cgroup_hierarchy_hidden();
        let confinement = prepared.prepare_external(&request).map_err(unavailable)?;
        let argv = confinement.argv();
        spec.executable = PathBuf::from(&argv[0]);
        spec.argv = argv[1..].to_vec();
        spec.cwd = cwd;
        Ok(PreparedTerminalLaunch {
            spec,
            confinement: Some(confinement),
            guarantee_record: prepared.guarantee_record(),
            launch_digest,
            executable_path,
            executable_digest,
            cgroup_hierarchy_hidden,
            #[cfg(target_os = "linux")]
            cgroup: None,
            cgroup_required: true,
        })
    }

    /// Confine a workspace editor to the registered workspace plus one unique
    /// private scratch directory. The extra writable root is deliberately a
    /// host-created per-invocation directory, never a profile-selected path.
    #[cfg(target_os = "linux")]
    fn prepare_confined_with_private_scratch(
        mut spec: TerminalLaunchSpec,
        workspace_root: &Path,
        scratch_root: &Path,
        workspace_write: bool,
    ) -> io::Result<PreparedTerminalLaunch> {
        use horizoncode_sandbox::{
            ExpectedLevel, GuaranteeDimension, RootAccess, Sandbox,
            SandboxProfile, ScopedRoot, SpawnRequest,
        };
        validate_size(spec.cols, spec.rows)?;
        let workspace = std::fs::canonicalize(workspace_root)?;
        let scratch = std::fs::canonicalize(scratch_root)?;
        let cwd = std::fs::canonicalize(&spec.cwd)?;
        let scratch_metadata = std::fs::metadata(&scratch)?;
        if workspace.parent().is_none() || !cwd.starts_with(&workspace)
            || !scratch_metadata.is_dir() || scratch.starts_with(&workspace)
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "editor scratch root must be a private directory outside the workspace"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if scratch_metadata.permissions().mode() & 0o077 != 0 {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                    "editor scratch root permissions are not private"));
            }
        }
        static SANDBOX: std::sync::OnceLock<Sandbox> = std::sync::OnceLock::new();
        let sandbox = SANDBOX.get_or_init(Sandbox::probe);
        let mut profile = match if workspace_write {
            SandboxProfile::workspace_write(&workspace)
        } else {
            SandboxProfile::readonly([workspace.clone()])
        } {
            SandboxProfile::Confined(profile) => profile,
            SandboxProfile::FullAccess => unreachable!("editor confined profiles are not full access"),
        };
        profile.scoped_roots.push(ScopedRoot {
            path: scratch.clone(),
            access: RootAccess::ReadWrite,
        });
        let profile = SandboxProfile::Confined(profile);
        let unavailable = |error| io::Error::new(io::ErrorKind::Unsupported,
            format!("external editor confinement unavailable: {error}"));
        let prepared = sandbox.prepare(&profile).map_err(unavailable)?;
        for dimension in [GuaranteeDimension::FilesystemRead, GuaranteeDimension::FilesystemWrite,
            GuaranteeDimension::NetworkEgress, GuaranteeDimension::ProcessTree] {
            prepared.require(dimension, ExpectedLevel::ENFORCED).map_err(unavailable)?;
        }
        let mut request = SpawnRequest::new(&spec.executable).cwd(&cwd);
        request.args = spec.argv.clone();
        request.preserve_controlling_terminal = true;
        let launch_digest = terminal_launch_digest(&spec, &workspace)?;
        let executable_path = std::fs::canonicalize(&spec.executable)?;
        let executable_digest = executable_digest(&executable_path)?;
        let cgroup_hierarchy_hidden = prepared.proves_cgroup_hierarchy_hidden();
        let confinement = prepared.prepare_external(&request).map_err(unavailable)?;
        let argv = confinement.argv();
        spec.executable = PathBuf::from(&argv[0]);
        spec.argv = argv[1..].to_vec();
        spec.cwd = cwd;
        Ok(PreparedTerminalLaunch {
            spec,
            confinement: Some(confinement),
            guarantee_record: prepared.guarantee_record(),
            launch_digest,
            executable_path,
            executable_digest,
            cgroup_hierarchy_hidden,
            #[cfg(target_os = "linux")]
            cgroup: None,
            cgroup_required: true,
        })
    }

    /// Prepare the exact user-selected external editor through the existing PTY
    /// ExecutionHost. This performs no spawn and creates no Guard lease or durable
    /// intent. HostKernel must verify the profile reference, authenticated root Session,
    /// one user action, target file identity/revision and exclusive write fence before
    /// calling this; dispatch remains behind the ordinary durable intent + lease.
    #[cfg(target_os = "linux")]
    pub(crate) fn prepare_external_editor(
        binding: &ExternalEditorLaunchBindingV1,
        trusted_selectors: &BTreeMap<String, PathBuf>,
        environment: BTreeMap<OsString, OsString>,
        cols: u16,
        rows: u16,
    ) -> io::Result<PreparedTerminalLaunch> {
        let profile = &binding.profile;
        let permission_mode = &binding.permission_mode;
        let target = &binding.target;
        if !binding.profile_ref.matches_definition(profile)?
            || !permission_mode.validate()
            || binding.session_id != permission_mode.session_id
            || binding.owner_epoch != permission_mode.owner_epoch
            || permission_mode.workspace_root_digest != binding.workspace_root_binding
            || binding.owner_epoch == 0
            || binding.generation == 0
            || !valid_editor_binding_id(&binding.execution_id)
            || !valid_editor_binding_id(&binding.session_id)
            || !valid_editor_binding_id(&binding.principal)
            || !valid_editor_binding_id(&binding.location_id)
            || !valid_editor_binding_id(&binding.user_action_id)
            || !valid_editor_binding_id(&binding.call_id)
            || !valid_editor_binding_id(&binding.effect_id)
            || !valid_editor_binding_id(&binding.challenge_id)
            || !is_blake3_digest(&binding.workspace_root_binding)
            || !is_blake3_digest(&binding.capability_lease_digest)
            || !is_blake3_digest(&binding.executable_digest)
            || (permission_mode.sandbox_mode == crate::guard::DirectSandboxModeV1::ReadOnly
                && target.kind != ExternalEditorTargetKindV1::PromptScratch)
            // A Full access editor can write the original workspace despite only
            // receiving the private scratch pathname. Keep workspace-file editing
            // unavailable unless the kernel can enforce the read-only workspace
            // boundary and separate Guarded patch flow.
            || (permission_mode.sandbox_mode == crate::guard::DirectSandboxModeV1::DangerFullAccess
                && target.kind == ExternalEditorTargetKindV1::WorkspaceFile)
            || (permission_mode.sandbox_mode == crate::guard::DirectSandboxModeV1::DangerFullAccess
                && permission_mode.approval_policy != crate::guard::DirectApprovalPolicyV1::Never)
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "editor launch profile or direct-session mode is stale or unavailable"));
        }
        let workspace_root = &binding.workspace_root;
        if !is_blake3_digest(&target.base_workspace_revision)
            || match target.kind {
                ExternalEditorTargetKindV1::WorkspaceFile => {
                    target.expected_file_digest.as_deref().is_none_or(|d| !is_blake3_digest(d))
                        || !valid_editor_source_relative_path(&target.source_relative_path)
                }
                ExternalEditorTargetKindV1::PromptScratch => {
                    target.expected_file_digest.is_some() || !target.source_relative_path.is_empty()
                }
            }
        {
            return Err(invalid_external_editor_profile());
        }
        let scratch_path = Path::new(&target.canonical_target_token);
        if !scratch_path.is_absolute() {
            return Err(invalid_external_editor_profile());
        }
        let workspace_canonical = std::fs::canonicalize(workspace_root)?;
        let scratch_root_canonical = std::fs::canonicalize(&target.scratch_root)?;
        if scratch_root_canonical.starts_with(&workspace_canonical) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "editor scratch directory must be outside the workspace"));
        }
        let (initial_scratch_digest, _) = inspect_external_editor_scratch(&target.scratch_root, scratch_path)?;
        if target.kind == ExternalEditorTargetKindV1::WorkspaceFile
            && target.expected_file_digest.as_deref() != Some(initial_scratch_digest.as_str())
        {
            return Err(io::Error::new(io::ErrorKind::InvalidData,
                "workspace editor scratch does not match the selected source preview"));
        }
        validate_editor_environment(&environment)?;
        let (executable, digest) = profile.resolve_executable_with_trusted_map(trusted_selectors)?;
        let expected_path = std::fs::canonicalize(&binding.executable_path)?;
        if digest != binding.executable_digest || digest != executable_digest(&expected_path)?
            || executable != expected_path
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "editor executable does not match the authenticated HostKernel pin"));
        }
        let argv = profile.argv_for_target(&target.canonical_target_token, target.kind)?;
        let launch_spec = TerminalLaunchSpec {
            executable,
            argv,
            cwd: workspace_root.to_path_buf(),
            env: environment,
            cols,
            rows,
        };
        let mut prepared = if permission_mode.sandbox_mode == crate::guard::DirectSandboxModeV1::DangerFullAccess {
            Self::prepare_full_access(launch_spec, workspace_root, &binding.session_id, binding.owner_epoch,
                &binding.workspace_root_binding, permission_mode)?
        } else {
            // The editor only mutates the private copy. Even in WorkspaceWrite
            // mode the workspace stays read-only until a separate Guarded
            // files.patch applies the result after revalidating its source pins.
            Self::prepare_confined_with_private_scratch(
                launch_spec, workspace_root, &target.scratch_root, false,
            )?
        };
        if prepared.executable_digest != digest {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "trusted editor executable changed during preflight"));
        }
        // Full Access intentionally allocates no retained cgroup (the child can
        // migrate descendants, so an empty group is not proof). Confined profiles
        // keep the exact-identity cgroup requirement.
        if permission_mode.sandbox_mode != crate::guard::DirectSandboxModeV1::DangerFullAccess {
            let cgroup = crate::cgroup_v2::ExecutionCgroupV2::create(
                &binding.execution_id,
                &binding.effect_id,
                &binding.capability_lease_digest,
                &binding.profile_ref.profile_id,
                None,
                binding.owner_epoch,
                binding.generation,
                "external_editor",
                &binding.profile_ref.profile_id,
                binding.profile_ref.revision,
                &binding.profile_ref.profile_digest,
                &binding.executable_digest,
                "none",
                prepared.cgroup_hierarchy_hidden,
            )?;
            crate::cgroup_v2::ExecutionCgroupV2::confirm_empty_before_dispatch(cgroup.identity())?;
            prepared.cgroup = Some(cgroup);
            prepared.cgroup_required = true;
        }
        let profile_digest = profile.definition_digest()?;
        let target_kind_name = match target.kind {
            ExternalEditorTargetKindV1::PromptScratch => "prompt_scratch",
            ExternalEditorTargetKindV1::WorkspaceFile => "workspace_file",
        };
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.external-editor-launch.v1\0");
        let owner_epoch = binding.owner_epoch.to_string();
        let generation = binding.generation.to_string();
        let revision = target.base_workspace_revision.as_bytes();
        let file_digest = target.expected_file_digest.as_deref().unwrap_or("").as_bytes();
        for value in [binding.execution_id.as_bytes(), binding.session_id.as_bytes(), binding.principal.as_bytes(),
            binding.location_id.as_bytes(), owner_epoch.as_bytes(), generation.as_bytes(),
            binding.user_action_id.as_bytes(), binding.call_id.as_bytes(), profile_digest.as_bytes(),
            binding.profile_ref.profile_digest.as_bytes(), binding.executable_digest.as_bytes(),
            target_kind_name.as_bytes(), target.canonical_target_token.as_bytes(),
            target.source_relative_path.as_bytes(), revision,
            file_digest, binding.capability_lease_digest.as_bytes(), binding.effect_id.as_bytes(),
            binding.challenge_id.as_bytes(), prepared.launch_digest.as_bytes(), permission_mode.digest.as_bytes()] {
            hasher.update(&(value.len() as u64).to_be_bytes());
            hasher.update(value);
        }
        prepared.launch_digest = format!("blake3:{}", hasher.finalize().to_hex());
        Ok(prepared)
    }

    #[cfg(not(target_os = "linux"))]
    pub(crate) fn prepare_external_editor(
        _binding: &ExternalEditorLaunchBindingV1,
        _trusted_selectors: &BTreeMap<String, PathBuf>,
        _environment: BTreeMap<OsString, OsString>,
        _cols: u16,
        _rows: u16,
    ) -> io::Result<PreparedTerminalLaunch> {
        Err(io::Error::new(io::ErrorKind::Unsupported,
            "external editor launch requires an accepted Linux process-tree containment backend"))
    }

    /// Dispatch only after Guard, durable PREPARE and one-use lease admission.
    pub fn spawn_prepared(mut prepared: PreparedTerminalLaunch) -> io::Result<Self> {
        if executable_digest(&prepared.executable_path)? != prepared.executable_digest {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "terminal executable changed after confined preflight",
            ));
        }
        if let Some(confinement) = prepared.confinement.as_mut() {
            confinement
                .activate()
                .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error.to_string()))?;
        }
        #[cfg(target_os = "linux")]
        let cgroup = prepared.cgroup.take();
        #[cfg(target_os = "linux")]
        let inner = match cgroup.as_ref() {
            Some(cgroup) => platform::Process::spawn_in_cgroup(prepared.spec, cgroup.placement_fd())?,
            None if !prepared.cgroup_required => platform::Process::spawn(prepared.spec)?,
            None => return Err(io::Error::new(io::ErrorKind::Unsupported,
                "editor process cgroup was not prepared before durable dispatch")),
        };
        #[cfg(not(target_os = "linux"))]
        let inner = platform::Process::spawn(prepared.spec)?;
        Ok(Self {
            inner,
            _confinement: prepared.confinement,
            #[cfg(target_os = "linux")]
            cgroup,
        })
    }

    /// Prepare a direct-session Full Access PTY launch. The only product caller is
    /// HostKernel after it has authenticated the live root Session, verified the
    /// explicit `danger-full-access + never` projection and obtained the normal
    /// Guard approval/one-use lease. This deliberately skips the HorizonCode
    /// filesystem/network sandbox while retaining the existing supervised process
    /// tree lifecycle. Platforms without that process-tree guarantee stay unavailable.
    #[cfg(target_os = "linux")]
    pub(crate) fn prepare_full_access(
        mut spec: TerminalLaunchSpec,
        workspace_root: &Path,
        session_id: &str,
        owner_epoch: u64,
        workspace_binding: &str,
        permission_mode: &crate::guard::DirectSessionPermissionModeProjectionV1,
    ) -> io::Result<PreparedTerminalLaunch> {
        validate_size(spec.cols, spec.rows)?;
        if !permission_mode.validate()
            || permission_mode.session_id != session_id
            || permission_mode.owner_epoch != owner_epoch
            || permission_mode.workspace_root_digest != workspace_binding
            || permission_mode.sandbox_mode != crate::guard::DirectSandboxModeV1::DangerFullAccess
            || permission_mode.approval_policy != crate::guard::DirectApprovalPolicyV1::Never
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "Full Access launch requires the exact authenticated direct-session mode"));
        }
        if !Self::owner_loss_tree_cleanup_supported() {
            return Err(io::Error::new(io::ErrorKind::Unsupported,
                "Full Access terminal launch requires supervised process-tree cleanup"));
        }
        let workspace = std::fs::canonicalize(workspace_root)?;
        let cwd = std::fs::canonicalize(&spec.cwd)?;
        if workspace.parent().is_none() || !cwd.starts_with(&workspace) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "terminal initial cwd must be within the authenticated workspace"));
        }
        let launch_digest = terminal_launch_digest(&spec, &workspace)?;
        let executable_path = std::fs::canonicalize(&spec.executable)?;
        let executable_digest = executable_digest(&executable_path)?;
        spec.executable = executable_path.clone();
        spec.cwd = cwd;
        Ok(PreparedTerminalLaunch {
            spec,
            confinement: None,
            // Full Access deliberately allocates no cgroup: the child can reach the
            // delegated hierarchy and migrate descendants, so an empty visible group
            // proves nothing. The durable effect journal plus the supervised
            // process-group lifetime are the only guarantees; restart without exact
            // process-tree proof is UNKNOWN and never replayed.
            guarantee_record: FULL_ACCESS_GUARANTEE_RECORD.to_owned(),
            launch_digest,
            executable_path,
            executable_digest,
            cgroup_hierarchy_hidden: false,
            #[cfg(target_os = "linux")]
            cgroup: None,
            cgroup_required: false,
        })
    }

    #[cfg(not(target_os = "linux"))]
    pub(crate) fn prepare_full_access(
        _spec: TerminalLaunchSpec,
        _workspace_root: &Path,
        _session_id: &str,
        _owner_epoch: u64,
        _workspace_binding: &str,
        _permission_mode: &crate::guard::DirectSessionPermissionModeProjectionV1,
    ) -> io::Result<PreparedTerminalLaunch> {
        Err(io::Error::new(io::ErrorKind::Unsupported,
            "Full Access terminal launch is unavailable without verified process-tree containment"))
    }

    /// Unconfined process launch retained for isolated unit fixtures only. Product callers
    /// must hold a Guarded `PreparedTerminalLaunch` from `prepare_confined`.
    #[cfg(test)]
    pub fn spawn(spec: TerminalLaunchSpec) -> io::Result<Self> {
        validate_size(spec.cols, spec.rows)?;
        Ok(Self {
            inner: platform::Process::spawn(spec)?,
            _confinement: None,
            #[cfg(target_os = "linux")]
            cgroup: None,
        })
    }

    pub fn backend(&self) -> TerminalBackend {
        self.inner.backend()
    }
    pub fn guarantees(&self) -> ProcessGuarantees {
        self.inner.guarantees()
    }
    pub fn pid(&self) -> u32 {
        self.inner.pid()
    }
    pub fn owner_loss_tree_cleanup_supported() -> bool {
        platform::Process::owner_loss_tree_cleanup_supported()
    }
    /// Polls at most `max_bytes`; `WouldBlock` is represented as an empty vector.
    pub fn read_output(&mut self, max_bytes: usize) -> io::Result<Vec<u8>> {
        if max_bytes > MAX_OUTPUT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "output read exceeds 64 KiB",
            ));
        }
        self.inner.read_output(max_bytes)
    }

    /// Writes one bounded input frame. A partial nonblocking write is reported as an error.
    pub fn write_input(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "input exceeds 2 MiB",
            ));
        }
        self.inner.write_input(bytes)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        validate_size(cols, rows)?;
        self.inner.resize(cols, rows)
    }

    /// Requests process-tree termination; this does not assert that termination has occurred.
    pub fn request_terminate(&mut self, reason: TerminationReason) -> io::Result<()> {
        self.inner.request_terminate(reason)
    }

    /// `Some` means the operating system has reported process exit; `None` means unknown/running.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.inner.try_wait()
    }

    /// Waits until exit or a deadline. At the deadline it requests kill and returns TimedOut;
    /// callers must continue polling `try_wait` before reporting termination.
    pub fn wait_timeout(&mut self, timeout: Duration) -> io::Result<WaitOutcome> {
        let deadline = Instant::now().checked_add(timeout);
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(WaitOutcome::Exited(status));
            }
            if deadline.is_none_or(|deadline| Instant::now() >= deadline) {
                self.request_terminate(TerminationReason::TimedOut)?;
                return Ok(WaitOutcome::TimedOut);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    /// Test hook: simulate owner loss (SIGKILL-equivalent) while keeping this handle
    /// alive, so tests can assert guarded process-tree cleanup without killing the test
    /// process.
    #[cfg(all(test, target_os = "linux"))]
    pub fn abandon_owner(&mut self) {
        self.inner.abandon_owner();
    }
}

fn validate_size(cols: u16, rows: u16) -> io::Result<()> {
    if !(1..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "terminal size out of range",
        ));
    }
    Ok(())
}

fn terminal_launch_digest(spec: &TerminalLaunchSpec, workspace: &Path) -> io::Result<String> {
    let executable = std::fs::canonicalize(&spec.executable)?;
    let executable_digest = executable_digest(&executable)?;
    let mut hasher = blake3::Hasher::new();
    for part in [
        b"horizoncode.terminal.launch-inputs.v1".as_slice(),
        workspace.as_os_str().as_encoded_bytes(),
        executable.as_os_str().as_encoded_bytes(),
        executable_digest.as_bytes(),
        spec.cwd.as_os_str().as_encoded_bytes(),
        &spec.cols.to_be_bytes(),
        &spec.rows.to_be_bytes(),
    ] {
        hasher.update(&(part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    for argument in &spec.argv {
        let bytes = argument.as_os_str().as_encoded_bytes();
        hasher.update(&(bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    for (key, value) in &spec.env {
        for bytes in [
            key.as_os_str().as_encoded_bytes(),
            value.as_os_str().as_encoded_bytes(),
        ] {
            hasher.update(&(bytes.len() as u64).to_be_bytes());
            hasher.update(bytes);
        }
    }
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::ffi::CString;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::process::ExitStatusExt;
    use std::thread;

    /// Supervisor-to-owner relay frame: the session leader id and its `/proc` start time.
    const FRAME_LEADER: u8 = 1;
    /// Supervisor-to-owner relay frame: the raw `waitpid` status of the leader.
    const FRAME_EXIT: u8 = 2;
    const FRAME_LEADER_LEN: usize = 13;
    const FRAME_EXIT_LEN: usize = 5;
    const RELAY_BUFFER_MAX: usize = 64;

    /// Bounded cleanup budget for the supervisor's process-tree sweep.
    const SWEEP_MAX_ROUNDS: usize = 8;
    // Process enumeration includes unrelated host PIDs before the supervisor's
    // descendants are known. Keep a hard allocation/work bound, but leave enough
    // headroom for busy development machines; a truncated scan still fails closed.
    const SWEEP_MAX_ENTRIES: usize = 8_192;
    const SWEEP_ROUND_DELAY_MS: u64 = 15;

    /// Supervisor keepalive poll interval; bounds observed-exit relay latency.
    const SUPERVISOR_POLL_MS: libc::c_int = 100;

    /// Bounded waits used by owner-side spawn and drop bookkeeping.
    const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(10);
    const REAP_TIMEOUT: Duration = Duration::from_secs(8);
    const FORCE_REAP_TIMEOUT: Duration = Duration::from_secs(2);

    // Stable kernel ABI options that the linked libc crate does not wrap on
    // linux-gnu. Values come from `linux/prctl.h`.
    const PR_SET_PDEATHSIG: libc::c_long = 1;
    const PR_SET_CHILD_SUBREAPER: libc::c_long = 36;

    pub struct Process {
        master: File,
        relay: File,
        keepalive: Option<File>,
        janitor: Option<libc::pid_t>,
        leader: u32,
        leader_start: u64,
        exit: Option<ExitStatus>,
        relay_buffer: Vec<u8>,
    }

    impl Process {
        pub fn spawn(spec: TerminalLaunchSpec) -> io::Result<Self> {
            Self::spawn_inner(spec, -1)
        }

        pub fn spawn_in_cgroup(spec: TerminalLaunchSpec, cgroup_procs_fd: RawFd) -> io::Result<Self> {
            if cgroup_procs_fd < 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid cgroup.procs descriptor"));
            }
            Self::spawn_inner(spec, cgroup_procs_fd)
        }

        fn spawn_inner(spec: TerminalLaunchSpec, cgroup_procs_fd: RawFd) -> io::Result<Self> {
            // Everything the post-fork child needs is prepared before the fork; the
            // child then runs only async-signal-safe raw syscalls and never allocates.
            let executable = cstring(spec.executable.as_os_str().as_bytes(), "executable")?;
            let cwd = cstring(spec.cwd.as_os_str().as_bytes(), "working directory")?;
            let mut argv = Vec::with_capacity(spec.argv.len() + 1);
            argv.push(executable.clone());
            for argument in &spec.argv {
                argv.push(cstring(argument.as_os_str().as_bytes(), "argument")?);
            }
            let mut environment = Vec::with_capacity(spec.env.len());
            for (key, value) in &spec.env {
                let mut entry = Vec::with_capacity(key.len() + value.len() + 1);
                entry.extend_from_slice(key.as_os_str().as_bytes());
                entry.push(b'=');
                entry.extend_from_slice(value.as_os_str().as_bytes());
                environment.push(cstring(&entry, "environment entry")?);
            }
            let mut argv_ptrs: Vec<*const libc::c_char> =
                argv.iter().map(|value| value.as_ptr()).collect();
            argv_ptrs.push(std::ptr::null());
            let mut environment_ptrs: Vec<*const libc::c_char> =
                environment.iter().map(|value| value.as_ptr()).collect();
            environment_ptrs.push(std::ptr::null());

            let mut master = -1;
            let mut slave = -1;
            // SAFETY: both output pointers reference live integers; the kernel initializes them.
            let opened = unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            if opened != 0 {
                return Err(io::Error::last_os_error());
            }
            // Keep both PTY descriptors out of unrelated execs; the leader installs only
            // the slave on stdin/stdout/stderr.
            let mut master_fd = unsafe { OwnedFd::from_raw_fd(master) };
            let mut slave_fd = unsafe { OwnedFd::from_raw_fd(slave) };
            set_cloexec(master_fd.as_raw_fd())?;
            set_cloexec(slave_fd.as_raw_fd())?;
            master_fd = move_above_stdio(master_fd)?;
            slave_fd = move_above_stdio(slave_fd)?;
            // The owner must poll cancellation/deadlines even when the child is
            // silent or not reading input; only the slave remains blocking.
            set_nonblocking(master_fd.as_raw_fd())?;
            let mut winsize = libc::winsize {
                ws_row: spec.rows,
                ws_col: spec.cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: the slave descriptor is valid and winsize is initialized.
            if unsafe { libc::ioctl(slave_fd.as_raw_fd(), libc::TIOCSWINSZ, &mut winsize) } < 0 {
                return Err(io::Error::last_os_error());
            }
            // The keepalive pipe is the owner liveness lease: the supervisor cleans the
            // tree when every write end closes. The relay pipe reports the leader identity
            // and the observed exit status. The exec pipe reports execve failure
            // (CLOEXEC on success, so EOF is success).
            let (keepalive_read, keepalive_write) = cloexec_pipe()?;
            let (relay_read, relay_write) = cloexec_pipe()?;
            let (exec_read, exec_write) = cloexec_pipe()?;

            // SAFETY: fork is called from the owner request thread; the child runs only
            // raw syscalls (see supervisor_main).
            let supervisor = unsafe { libc::fork() };
            if supervisor < 0 {
                return Err(io::Error::last_os_error());
            }
            if supervisor == 0 {
                // SAFETY: this process is the forked supervisor; the call never returns.
                unsafe {
                    supervisor_main(
                        keepalive_read.as_raw_fd(),
                        relay_write.as_raw_fd(),
                        exec_write.as_raw_fd(),
                        slave_fd.as_raw_fd(),
                        cgroup_procs_fd,
                        executable.as_ptr(),
                        argv_ptrs.as_ptr(),
                        environment_ptrs.as_ptr(),
                        cwd.as_ptr(),
                    );
                }
            }
            // Exactly one end of every pipe belongs to the owner process.
            drop(keepalive_read);
            drop(relay_write);
            drop(exec_write);
            // The owner must not keep a slave handle: it would mask PTY end-of-stream.
            drop(slave_fd);
            let keepalive_write = File::from(keepalive_write);
            let relay_read = File::from(relay_read);

            let frame = match read_bootstrap_frame(relay_read.as_raw_fd(), BOOTSTRAP_TIMEOUT) {
                Ok(frame) => frame,
                Err(error) => {
                    drop(keepalive_write);
                    force_reap(supervisor);
                    return Err(error);
                }
            };
            let leader = u32::from_le_bytes(frame[1..5].try_into().expect("bootstrap frame"));
            let leader_start =
                u64::from_le_bytes(frame[5..13].try_into().expect("bootstrap frame"));
            match read_exec_report(exec_read.as_raw_fd()) {
                Ok(None) => {}
                Ok(Some(error)) => {
                    drop(keepalive_write);
                    drop(exec_read);
                    force_reap(supervisor);
                    return Err(io::Error::from_raw_os_error(error));
                }
                Err(error) => {
                    drop(keepalive_write);
                    drop(exec_read);
                    force_reap(supervisor);
                    return Err(error);
                }
            }
            drop(exec_read);
            if let Err(error) = set_nonblocking(relay_read.as_raw_fd()) {
                drop(keepalive_write);
                force_reap(supervisor);
                return Err(error);
            }
            Ok(Self {
                master: File::from(master_fd),
                relay: relay_read,
                keepalive: Some(keepalive_write),
                janitor: Some(supervisor),
                leader,
                leader_start,
                exit: None,
                relay_buffer: Vec::new(),
            })
        }

        pub fn pid(&self) -> u32 {
            self.leader
        }
        pub fn backend(&self) -> TerminalBackend {
            TerminalBackend::LinuxPty
        }
        pub fn guarantees(&self) -> ProcessGuarantees {
            ProcessGuarantees {
                observed_exit: true,
                tree_kill_on_owner_close: true,
                process_tree_termination: true,
            }
        }
        pub fn owner_loss_tree_cleanup_supported() -> bool {
            true
        }
        pub fn read_output(&mut self, max: usize) -> io::Result<Vec<u8>> {
            let mut bytes = vec![0; max];
            match self.master.read(&mut bytes) {
                Ok(count) => {
                    bytes.truncate(count);
                    Ok(bytes)
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(Vec::new()),
                Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(Vec::new()),
                Err(error) => Err(error),
            }
        }
        pub fn write_input(&mut self, bytes: &[u8]) -> io::Result<()> {
            match self.master.write(bytes) {
                Ok(count) if count == bytes.len() => Ok(()),
                Ok(_) => Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "partial nonblocking terminal write",
                )),
                Err(error) => Err(error),
            }
        }
        pub fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
            let winsize = libc::winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: master is valid and winsize is initialized.
            if unsafe {
                libc::ioctl(
                    std::os::fd::AsRawFd::as_raw_fd(&self.master),
                    libc::TIOCSWINSZ,
                    &winsize,
                )
            } < 0
            {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
        pub fn request_terminate(&mut self, _reason: TerminationReason) -> io::Result<()> {
            if self.exit.is_some() {
                return Ok(());
            }
            // PID-reuse defence: only signal the session group while /proc still shows
            // the exact leader generation recorded by the supervisor.
            match read_starttime(self.leader) {
                Some(start) if start == self.leader_start => {}
                _ => return Ok(()),
            }
            // The leader called setsid, so its PID is also its session/process-group ID.
            if unsafe { libc::kill(-(self.leader as libc::pid_t), libc::SIGKILL) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(error)
            }
        }
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if self.exit.is_some() {
                self.reap_janitor_if_exited();
                return Ok(self.exit);
            }
            let mut chunk = [0u8; 32];
            let mut eof = false;
            loop {
                match self.relay.read(&mut chunk) {
                    Ok(0) => {
                        eof = true;
                        break;
                    }
                    Ok(count) => {
                        if self.relay_buffer.len() + count > RELAY_BUFFER_MAX {
                            self.relay_buffer.clear();
                            eof = true;
                            break;
                        }
                        self.relay_buffer.extend_from_slice(&chunk[..count]);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        eof = true;
                        break;
                    }
                }
            }
            loop {
                match self.relay_buffer.first().copied() {
                    Some(FRAME_LEADER) if self.relay_buffer.len() >= FRAME_LEADER_LEN => {
                        self.relay_buffer.drain(..FRAME_LEADER_LEN);
                    }
                    Some(FRAME_EXIT) if self.relay_buffer.len() >= FRAME_EXIT_LEN => {
                        let raw = i32::from_le_bytes(
                            self.relay_buffer[1..FRAME_EXIT_LEN]
                                .try_into()
                                .map_err(|_| {
                                    io::Error::new(
                                        io::ErrorKind::InvalidData,
                                        "terminal exit frame",
                                    )
                                })?,
                        );
                        self.relay_buffer.drain(..FRAME_EXIT_LEN);
                        self.exit = Some(ExitStatus::from_raw(raw));
                    }
                    Some(FRAME_LEADER) | Some(FRAME_EXIT) => break,
                    Some(_) => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "terminal supervisor protocol mismatch",
                        ));
                    }
                    None => break,
                }
            }
            if self.exit.is_some() {
                self.reap_janitor_if_exited();
                return Ok(self.exit);
            }
            if eof {
                self.reap_janitor_if_exited();
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "terminal supervisor exited without reporting the session exit",
                ));
            }
            Ok(None)
        }

        fn reap_janitor_if_exited(&mut self) {
            let Some(janitor) = self.janitor else {
                return;
            };
            let mut status = 0;
            if unsafe { libc::waitpid(janitor, &mut status, libc::WNOHANG) } == janitor {
                self.janitor = None;
            }
        }

        /// Test hook: close the owner keepalive handle without dropping the process,
        /// simulating owner loss while the test process itself stays alive.
        #[cfg(test)]
        pub fn abandon_owner(&mut self) {
            self.keepalive.take();
        }
    }

    impl Drop for Process {
        fn drop(&mut self) {
            // Owner close is the terminal session's kill boundary: closing the keepalive
            // handle is the owner-loss signal that makes the supervisor terminate the
            // complete session tree before it exits.
            self.keepalive.take();
            let Some(janitor) = self.janitor.take() else {
                return;
            };
            force_reap(janitor);
        }
    }

    /// The terminal supervisor ("janitor") process.
    ///
    /// It is the parent of the PTY session leader and a child subreaper, so every
    /// orphaned descendant of the session reparents to it instead of init. It is also
    /// the only process that terminates and reaps the session tree: holding the
    /// keepalive pipe open is the owner's liveness lease. EOF means owner loss (normal
    /// owner exit, crash, or SIGKILL) and triggers a bounded kill and sweep of the whole
    /// tree. On a normal leader exit the supervisor sweeps escaped descendants first
    /// and relays the observed wait status only after a complete scan proves the
    /// process tree is empty. A bounded or incomplete sweep therefore stays UNKNOWN.
    ///
    /// SAFETY: this function runs in the forked child of a possibly multi-threaded
    /// owner, so it never returns and performs only async-signal-safe raw syscalls; all
    /// values it uses were prepared before the fork.
    unsafe fn supervisor_main(
        keepalive_read: RawFd,
        relay_write: RawFd,
        exec_write: RawFd,
        slave: RawFd,
        cgroup_procs_fd: RawFd,
        executable: *const libc::c_char,
        argv: *const *const libc::c_char,
        envp: *const *const libc::c_char,
        cwd: *const libc::c_char,
    ) -> ! {
        unsafe {
            // The HostKernel parent retains the cgroup.procs descriptor and passes
            // it only to this forked supervisor. Place the supervisor before it
            // creates any child; descendants inherit the cgroup membership.
            if cgroup_procs_fd >= 0 && !write_current_pid_to_cgroup(cgroup_procs_fd) {
                report_exec_error(exec_write);
            }
            // The supervisor owns no stdio and only the descriptors its contract needs.
            libc::close_range(0, 2, 0);
            if cgroup_procs_fd >= 0 {
                close_except(&mut [keepalive_read, relay_write, exec_write, slave, cgroup_procs_fd]);
            } else {
                close_except(&mut [keepalive_read, relay_write, exec_write, slave]);
            }
            // Detach from the owner's session so a Ctrl-C or SIGHUP sent to the owner's
            // foreground process group cannot end tree cleanup.
            libc::setsid();
            // Orphaned descendants must reparent here, not to init, so the bounded sweep
            // can still see and terminate them after the owner dies.
            if libc::syscall(libc::SYS_prctl, PR_SET_CHILD_SUBREAPER, 1) != 0 {
                libc::_exit(70);
            }
        }
        // The leader inherits the keepalive read end and relay write end; close_except
        // above already removed everything else, but only the leader keeps exec_write
        // and the slave, and the supervisor closes its copies right after the fork.
        let leader = unsafe { libc::fork() };
        if leader < 0 {
            unsafe { libc::_exit(71) };
        }
        if leader == 0 {
            unsafe { leader_main(slave, exec_write, executable, argv, envp, cwd) };
        }
        unsafe {
            libc::close(exec_write);
            // Holding a slave handle would keep the PTY from signalling end-of-stream
            // to the owner after the tree exits.
            libc::close(slave);
            // Ignore signals that job-control or controlling-terminal teardown could
            // deliver while the leader starts; the leader restores defaults before exec.
            for signal in [
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGHUP,
                libc::SIGTERM,
                libc::SIGPIPE,
            ] {
                libc::signal(signal, libc::SIG_IGN);
            }
        }
        // The leader already exists (or is a zombie), so its generation is observable.
        let leader_start = read_starttime(leader as u32).unwrap_or(0);
        let mut frame = [0u8; FRAME_LEADER_LEN];
        frame[0] = FRAME_LEADER;
        frame[1..5].copy_from_slice(&(leader as u32).to_le_bytes());
        frame[5..13].copy_from_slice(&leader_start.to_le_bytes());
        if !write_full(relay_write, &frame) {
            // The owner is already gone; the tree must still be cleaned up.
            unsafe {
                supervisor_cleanup(leader, leader_start, false);
                libc::_exit(0);
            }
        }
        // `Some` only when this supervisor itself observed the leader's wait status;
        // owner loss and interior waitpid failures must never fabricate an observed exit.
        let mut observed_status: Option<libc::c_int> = None;
        loop {
            let mut descriptor = libc::pollfd {
                fd: keepalive_read,
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut descriptor, 1, SUPERVISOR_POLL_MS) };
            if ready > 0 {
                let mut byte = [0u8; 8];
                let got =
                    unsafe { libc::read(keepalive_read, byte.as_mut_ptr().cast(), byte.len()) };
                if got <= 0 {
                    break;
                }
            } else if ready < 0 && unsafe { *libc::__errno_location() } != libc::EINTR {
                break;
            }
            let mut status: libc::c_int = 0;
            let reaped = unsafe { libc::waitpid(leader, &mut status, libc::WNOHANG) };
            if reaped == leader {
                observed_status = Some(status);
                break;
            }
            if reaped < 0 {
                // The leader can no longer be observed; clean up without reporting an exit.
                break;
            }
        }
        let tree_quiesced = unsafe {
            supervisor_cleanup(leader, leader_start, observed_status.is_some())
        };
        if tree_quiesced {
            if let Some(status) = observed_status {
                let mut frame = [0u8; FRAME_EXIT_LEN];
                frame[0] = FRAME_EXIT;
                frame[1..5].copy_from_slice(&status.to_le_bytes());
                write_full(relay_write, &frame);
            }
        }
        // Closing the relay without FRAME_EXIT turns an unprovable sweep into
        // BrokenPipe/UNKNOWN at the owner boundary.
        unsafe { libc::_exit(0) }
    }

    /// Write this forked supervisor's PID to the already-open cgroup.procs file.
    /// Uses a fixed stack buffer and raw `write`, so it remains safe between fork
    /// and the point where process creation is allowed to proceed.
    unsafe fn write_current_pid_to_cgroup(fd: RawFd) -> bool {
        let mut value = unsafe { libc::getpid() as u32 };
        let mut reversed = [0u8; 16];
        let mut count = 0usize;
        loop {
            reversed[count] = b'0' + (value % 10) as u8;
            count += 1;
            value /= 10;
            if value == 0 { break; }
        }
        let mut bytes = [0u8; 17];
        for index in 0..count { bytes[index] = reversed[count - index - 1]; }
        bytes[count] = b'\n';
        let mut offset = 0usize;
        while offset <= count {
            let wrote = unsafe { libc::write(fd, bytes[offset..=count].as_ptr().cast(), count + 1 - offset) };
            if wrote > 0 { offset += wrote as usize; continue; }
            if wrote < 0 && unsafe { *libc::__errno_location() } == libc::EINTR { continue; }
            return false;
        }
        true
    }

    /// Installs the controlling terminal and execs the requested program.
    ///
    /// SAFETY: runs in a forked child (see `supervisor_main`); it never returns and only
    /// performs async-signal-safe raw syscalls.
    unsafe fn leader_main(
        slave: RawFd,
        exec_write: RawFd,
        executable: *const libc::c_char,
        argv: *const *const libc::c_char,
        envp: *const *const libc::c_char,
        cwd: *const libc::c_char,
    ) -> ! {
        unsafe {
            let supervisor = libc::getppid();
            if libc::setsid() < 0 {
                report_exec_error(exec_write);
            }
            if libc::ioctl(slave, libc::TIOCSCTTY, 0) < 0 {
                report_exec_error(exec_write);
            }
            // Restore default dispositions: ignored signals survive execve, and the
            // launched program must not inherit the supervisor's job-control masking.
            for signal in [
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGHUP,
                libc::SIGTERM,
                libc::SIGPIPE,
            ] {
                libc::signal(signal, libc::SIG_DFL);
            }
            // The supervisor is the session's only reaper: if it dies, the leader must
            // die with it instead of orphaning a PTY with no owner.
            if libc::syscall(
                libc::SYS_prctl,
                PR_SET_PDEATHSIG,
                libc::SIGKILL as libc::c_long,
            ) != 0
            {
                report_exec_error(exec_write);
            }
            if libc::getppid() != supervisor {
                // The supervisor died before PDEATHSIG could be armed.
                libc::_exit(126);
            }
            for target in [libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO] {
                if libc::dup2(slave, target) < 0 {
                    report_exec_error(exec_write);
                }
            }
            if slave > libc::STDERR_FILENO {
                libc::close(slave);
            }
            if libc::chdir(cwd) != 0 {
                report_exec_error(exec_write);
            }
            libc::execve(executable, argv, envp);
            report_exec_error(exec_write);
        }
    }

    /// Reports the current errno to the owner and exits the failed leader.
    unsafe fn report_exec_error(exec_write: RawFd) -> ! {
        let code = unsafe { *libc::__errno_location() };
        let bytes = code.to_le_bytes();
        unsafe {
            libc::write(exec_write, bytes.as_ptr().cast(), bytes.len());
            libc::_exit(127);
        }
    }

    /// Terminates and reaps every remaining session descendant within a bounded budget.
    /// Returns true only after a complete `/proc` scan proves no descendants remain.
    /// Truncation, inspection failure, and budget exhaustion fail closed.
    ///
    /// The supervisor is a child subreaper, so the session tree is exactly the set of
    /// processes rooted at the supervisor's direct children (`ppid == supervisor`)
    /// extended transitively. Each group signal is verified against the scanned
    /// `/proc` generation immediately beforehand so a reused PID is never signalled.
    unsafe fn supervisor_cleanup(
        leader: libc::pid_t,
        leader_start: u64,
        leader_reaped: bool,
    ) -> bool {
        let me = unsafe { libc::getpid() };
        let my_group = unsafe { libc::getpgrp() };
        if !leader_reaped && leader_start != 0 {
            // Verify the recorded generation before signalling the session group.
            if read_starttime(leader as u32) == Some(leader_start) {
                unsafe {
                    libc::kill(-leader, libc::SIGKILL);
                }
            }
        }
        let mut round = 0;
        while round < SWEEP_MAX_ROUNDS {
            let mut entries = [(0i32, 0i32, 0i32, 0u64); SWEEP_MAX_ENTRIES];
            let Some((count, complete)) = scan_proc(&mut entries) else {
                return false;
            };
            let mut marked = [false; SWEEP_MAX_ENTRIES];
            // Build an index sorted by parent PID, then walk outward from the
            // supervisor. This keeps the bounded 8,192-entry scan O(n log n)
            // instead of repeatedly comparing every process pair.
            entries[..count].sort_unstable_by_key(|entry| entry.0);
            let mut parent_order = [0usize; SWEEP_MAX_ENTRIES];
            for (index, slot) in parent_order.iter_mut().take(count).enumerate() {
                *slot = index;
            }
            parent_order[..count].sort_unstable_by_key(|index| entries[*index].1);
            let mut queue = [0i32; SWEEP_MAX_ENTRIES];
            let (mut head, mut tail) = (0usize, 1usize);
            queue[0] = me;
            while head < tail {
                let parent = queue[head];
                head += 1;
                let first = parent_order[..count]
                    .partition_point(|index| entries[*index].1 < parent);
                for &index in &parent_order[first..count] {
                    if entries[index].1 != parent {
                        break;
                    }
                    if marked[index] {
                        continue;
                    }
                    marked[index] = true;
                    if tail == queue.len() {
                        return false;
                    }
                    queue[tail] = entries[index].0;
                    tail += 1;
                }
            }
            let mut marked_count = 0usize;
            for index in 0..count {
                if !marked[index] {
                    continue;
                }
                marked_count += 1;
                let (pid, _, group, _) = entries[index];
                if pid == me {
                    continue;
                }
                if group > 1 && group != my_group {
                    // Only signal a group whose leader is a verified member of this
                    // scan: the group id is a PID and may otherwise name a reused,
                    // unrelated process group.
                    let verified = entries[..count]
                        .binary_search_by_key(&group, |entry| entry.0)
                        .ok()
                        .is_some_and(|candidate| {
                            marked[candidate]
                                && read_starttime(group as u32) == Some(entries[candidate].3)
                        });
                    if verified {
                        unsafe {
                            libc::kill(-group, libc::SIGKILL);
                        }
                        continue;
                    }
                }
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
            // Reap every dead child: the leader (zombie or killed) and adopted orphans.
            loop {
                let mut status = 0;
                if unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) } <= 0 {
                    break;
                }
            }
            if marked_count == 0 {
                return complete;
            }
            round += 1;
            if round < SWEEP_MAX_ROUNDS {
                sleep_millis(SWEEP_ROUND_DELAY_MS);
            }
        }
        false
    }

    /// Enumerates `/proc` into bounded `(pid, ppid, pgrp, starttime)` entries.
    fn scan_proc(
        entries: &mut [(i32, i32, i32, u64); SWEEP_MAX_ENTRIES],
    ) -> Option<(usize, bool)> {
        // SAFETY: the path literal is NUL-terminated and the buffer is valid.
        let descriptor = unsafe {
            libc::open(
                c"/proc".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return None;
        }
        let mut count = 0usize;
        let mut complete = true;
        let mut buffer = [0u8; 4096];
        loop {
            // SAFETY: getdents64 writes at most `buffer.len()` bytes to the buffer.
            let got = unsafe {
                libc::syscall(
                    libc::SYS_getdents64,
                    descriptor,
                    buffer.as_mut_ptr(),
                    buffer.len(),
                )
            };
            if got == 0 {
                break;
            }
            if got < 0 {
                let error = unsafe { *libc::__errno_location() };
                if error == libc::EINTR {
                    continue;
                }
                complete = false;
                break;
            }
            let end = got as usize;
            let mut offset = 0usize;
            while offset + 19 <= end && count < entries.len() {
                // struct linux_dirent64: u64 ino, i64 off, u16 reclen, u8 type, name[].
                let record_length =
                    u16::from_ne_bytes([buffer[offset + 16], buffer[offset + 17]]) as usize;
                if record_length < 20 || offset + record_length > end {
                    complete = false;
                    break;
                }
                let record = &buffer[offset + 19..offset + record_length];
                let name_length = record
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(record.len());
                if let Some(pid) = parse_uint(&record[..name_length])
                    && let Ok(pid) = u32::try_from(pid)
                {
                    if let Some((parent, group, start)) = read_proc_fields(pid) {
                        entries[count] = (pid as i32, parent, group, start);
                        count += 1;
                    } else if process_still_exists(pid) {
                        // A live process with unreadable identity may be a descendant;
                        // never certify a sweep from an incomplete ancestry snapshot.
                        complete = false;
                    }
                }
                offset += record_length;
            }
            if count >= entries.len() {
                complete = false;
                break;
            }
        }
        unsafe {
            libc::close(descriptor);
        }
        Some((count, complete))
    }

    fn process_still_exists(pid: u32) -> bool {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0
            || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    /// Reads the `/proc/<pid>/stat` fields the supervisor needs: `(ppid, pgrp, starttime)`.
    fn read_proc_fields(pid: u32) -> Option<(i32, i32, u64)> {
        let mut path = [0u8; 32];
        proc_stat_path(pid, &mut path)?;
        // SAFETY: the path is NUL-terminated in the fixed buffer.
        let descriptor =
            unsafe { libc::open(path.as_ptr().cast(), libc::O_RDONLY | libc::O_CLOEXEC) };
        if descriptor < 0 {
            return None;
        }
        let mut buffer = [0u8; 512];
        let mut total = 0usize;
        loop {
            if total == buffer.len() {
                break;
            }
            // SAFETY: the write pointer stays inside the fixed buffer.
            let got = unsafe {
                libc::read(
                    descriptor,
                    buffer.as_mut_ptr().add(total).cast(),
                    buffer.len() - total,
                )
            };
            if got <= 0 {
                break;
            }
            total += got as usize;
        }
        unsafe {
            libc::close(descriptor);
        }
        parse_proc_stat(&buffer[..total])
    }

    fn read_starttime(pid: u32) -> Option<u64> {
        read_proc_fields(pid).map(|fields| fields.2)
    }

    /// Parses `(ppid, pgrp, starttime)` from raw `/proc/<pid>/stat` bytes.
    fn parse_proc_stat(stat: &[u8]) -> Option<(i32, i32, u64)> {
        let close = stat.iter().rposition(|byte| *byte == b')')?;
        let mut parent = None;
        let mut group = None;
        let mut start = None;
        // Field 3 (state) is the first token after the comm; starttime is field 22.
        for (index, token) in stat[close + 1..]
            .split(|byte| *byte == b' ')
            .filter(|token| !token.is_empty())
            .enumerate()
        {
            match index {
                1 => parent = Some(parse_int(token)?),
                2 => group = Some(parse_int(token)?),
                19 => start = Some(parse_uint(token)?),
                _ => {}
            }
            if parent.is_some() && group.is_some() && start.is_some() {
                break;
            }
        }
        Some((parent?, group?, start?))
    }

    fn proc_stat_path(pid: u32, buffer: &mut [u8; 32]) -> Option<usize> {
        let mut digits = [0u8; 10];
        let mut value = pid;
        let mut length = 0usize;
        if value == 0 {
            digits[0] = b'0';
            length = 1;
        } else {
            while value > 0 {
                digits[length] = b'0' + (value % 10) as u8;
                value /= 10;
                length += 1;
            }
        }
        let total = 6 + length + 5 + 1;
        if total > buffer.len() {
            return None;
        }
        buffer[..6].copy_from_slice(b"/proc/");
        let mut index = 6;
        for digit in (0..length).rev() {
            buffer[index] = digits[digit];
            index += 1;
        }
        buffer[index..index + 5].copy_from_slice(b"/stat");
        buffer[index + 5] = 0;
        Some(index + 6)
    }

    fn parse_uint(bytes: &[u8]) -> Option<u64> {
        if bytes.is_empty() {
            return None;
        }
        let mut value = 0u64;
        for byte in bytes {
            if !byte.is_ascii_digit() {
                return None;
            }
            value = value.checked_mul(10)?.checked_add((byte - b'0') as u64)?;
        }
        Some(value)
    }

    fn parse_int(bytes: &[u8]) -> Option<i32> {
        i32::try_from(parse_uint(bytes)?).ok()
    }

    fn sleep_millis(millis: u64) {
        let request = libc::timespec {
            tv_sec: (millis / 1000) as libc::time_t,
            tv_nsec: ((millis % 1000) * 1_000_000) as libc::c_long,
        };
        let mut remaining = request;
        loop {
            // SAFETY: both timespec values are initialized.
            if unsafe { libc::nanosleep(&remaining, &mut remaining) } == 0 {
                break;
            }
            if unsafe { *libc::__errno_location() } != libc::EINTR {
                break;
            }
        }
    }

    fn cstring(bytes: &[u8], what: &str) -> io::Result<CString> {
        CString::new(bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("NUL byte in terminal {what}"),
            )
        })
    }

    fn set_cloexec(fd: RawFd) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn set_nonblocking(fd: RawFd) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Moves a descriptor out of the stdio range so `close_except` can start at 3.
    fn move_above_stdio(fd: OwnedFd) -> io::Result<OwnedFd> {
        let raw = fd.as_raw_fd();
        if raw >= 3 {
            return Ok(fd);
        }
        let moved = unsafe { libc::fcntl(raw, libc::F_DUPFD_CLOEXEC, 3) };
        if moved < 0 {
            return Err(io::Error::last_os_error());
        }
        drop(fd);
        Ok(unsafe { OwnedFd::from_raw_fd(moved) })
    }

    fn cloexec_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: both output slots are valid integers.
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let read = move_above_stdio(unsafe { OwnedFd::from_raw_fd(fds[0]) })?;
        let write = move_above_stdio(unsafe { OwnedFd::from_raw_fd(fds[1]) })?;
        Ok((read, write))
    }

    /// Closes every descriptor at or above 3 except the given keep set.
    ///
    /// SAFETY: must run in a single-threaded context; kept descriptors must be
    /// distinct and at or above 3.
    unsafe fn close_except(keep: &mut [RawFd]) {
        keep.sort_unstable();
        let mut low: u32 = 3;
        for &fd in keep.iter() {
            let fd = fd as u32;
            if fd > low {
                unsafe {
                    libc::close_range(low, fd - 1, 0);
                }
            }
            low = fd + 1;
        }
        unsafe {
            libc::close_range(low, u32::MAX, 0);
        }
    }

    fn write_full(fd: RawFd, mut bytes: &[u8]) -> bool {
        while !bytes.is_empty() {
            // SAFETY: the byte pointer references a valid slice for `bytes.len()`.
            let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
            if written <= 0 {
                if written < 0 && unsafe { *libc::__errno_location() } == libc::EINTR {
                    continue;
                }
                return false;
            }
            bytes = &bytes[written as usize..];
        }
        true
    }

    fn read_bootstrap_frame(fd: RawFd, timeout: Duration) -> io::Result<[u8; FRAME_LEADER_LEN]> {
        let deadline = Instant::now() + timeout;
        let mut frame = [0u8; FRAME_LEADER_LEN];
        let mut filled = 0usize;
        while filled < frame.len() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if !wait_readable(fd, remaining)? {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "terminal supervisor did not report the session leader",
                ));
            }
            // SAFETY: the write pointer stays inside the fixed frame.
            let got = unsafe {
                libc::read(
                    fd,
                    frame.as_mut_ptr().add(filled).cast(),
                    frame.len() - filled,
                )
            };
            if got < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(error);
            }
            if got == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "terminal supervisor exited before reporting the session leader",
                ));
            }
            filled += got as usize;
        }
        if frame[0] != FRAME_LEADER {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "terminal supervisor protocol mismatch",
            ));
        }
        Ok(frame)
    }

    /// Reads the exec report: `None` means exec succeeded (EOF), `Some(errno)` a failure.
    fn read_exec_report(fd: RawFd) -> io::Result<Option<libc::c_int>> {
        let deadline = Instant::now() + BOOTSTRAP_TIMEOUT;
        let mut report = [0u8; 4];
        let mut filled = 0usize;
        loop {
            if filled == report.len() {
                return Ok(Some(libc::c_int::from_le_bytes(report)));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if !wait_readable(fd, remaining)? {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "terminal launch report timed out",
                ));
            }
            // SAFETY: the write pointer stays inside the fixed report buffer.
            let got = unsafe {
                libc::read(
                    fd,
                    report.as_mut_ptr().add(filled).cast(),
                    report.len() - filled,
                )
            };
            if got < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(error);
            }
            if got == 0 {
                if filled == 0 {
                    return Ok(None);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "terminal launch report was truncated",
                ));
            }
            filled += got as usize;
        }
    }

    /// Waits until a read is possible; `false` means the deadline expired.
    fn wait_readable(fd: RawFd, timeout: Duration) -> io::Result<bool> {
        let mut descriptor = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let millis = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
        loop {
            // SAFETY: one initialized pollfd is supplied.
            let ready = unsafe { libc::poll(&mut descriptor, 1, millis) };
            if ready > 0 {
                return Ok(true);
            }
            if ready == 0 {
                return Ok(false);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(error);
        }
    }

    /// Reaps a child within `timeout`, force-killing it after the first deadline.
    fn force_reap(child: libc::pid_t) {
        if !reap_bounded(child, REAP_TIMEOUT) {
            // A supervisor that misses its bounded cleanup window is force-killed; the
            // leader's PDEATHSIG then tears down the PTY session.
            unsafe {
                libc::kill(child, libc::SIGKILL);
            }
            let _ = reap_bounded(child, FORCE_REAP_TIMEOUT);
        }
    }

    fn reap_bounded(child: libc::pid_t, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let mut status = 0;
            // SAFETY: `status` is a valid out-pointer for waitpid.
            let reaped = unsafe { libc::waitpid(child, &mut status, libc::WNOHANG) };
            if reaped == child || reaped < 0 {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::{OsStr, c_void};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::ExitStatusExt;
    use std::ptr::{null, null_mut};
    use std::thread;

    type Handle = *mut c_void;
    type Hpc = *mut c_void;
    type Bool = i32;
    type Dword = u32;
    type SizeT = usize;
    #[repr(C)]
    struct Coord {
        x: i16,
        y: i16,
    }
    #[repr(C)]
    struct StartupInfo {
        cb: Dword,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: Dword,
        y: Dword,
        xsize: Dword,
        ysize: Dword,
        xchars: Dword,
        ychars: Dword,
        fill: Dword,
        flags: Dword,
        show: u16,
        reserved2_size: u16,
        reserved2: *mut u8,
        stdin: Handle,
        stdout: Handle,
        stderr: Handle,
    }
    #[repr(C)]
    struct StartupInfoEx {
        startup: StartupInfo,
        attributes: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInfo {
        process: Handle,
        thread: Handle,
        pid: Dword,
        tid: Dword,
    }
    #[repr(C)]
    struct SecurityAttributes {
        length: Dword,
        descriptor: *mut c_void,
        inherit: Bool,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreatePipe(
            read: *mut Handle,
            write: *mut Handle,
            attrs: *const SecurityAttributes,
            size: Dword,
        ) -> Bool;
        fn SetHandleInformation(handle: Handle, mask: Dword, flags: Dword) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
        fn CreatePseudoConsole(
            size: Coord,
            input: Handle,
            output: Handle,
            flags: Dword,
            console: *mut Hpc,
        ) -> i32;
        fn ResizePseudoConsole(console: Hpc, size: Coord) -> i32;
        fn ClosePseudoConsole(console: Hpc);
        fn InitializeProcThreadAttributeList(
            list: *mut c_void,
            count: Dword,
            flags: Dword,
            size: *mut SizeT,
        ) -> Bool;
        fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: Dword,
            attribute: usize,
            value: *mut c_void,
            size: SizeT,
            previous: *mut c_void,
            returned: *mut SizeT,
        ) -> Bool;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(
            app: *const u16,
            command: *mut u16,
            proc_sec: *mut SecurityAttributes,
            thread_sec: *mut SecurityAttributes,
            inherit: Bool,
            flags: Dword,
            environment: *mut c_void,
            cwd: *const u16,
            startup: *mut StartupInfo,
            info: *mut ProcessInfo,
        ) -> Bool;
        fn CreateJobObjectW(attrs: *mut SecurityAttributes, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: Dword,
        ) -> Bool;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
        fn TerminateProcess(process: Handle, code: Dword) -> Bool;
        fn ResumeThread(thread: Handle) -> Dword;
        fn TerminateJobObject(job: Handle, code: Dword) -> Bool;
        fn WaitForSingleObject(handle: Handle, millis: Dword) -> Dword;
        fn GetExitCodeProcess(process: Handle, code: *mut Dword) -> Bool;
        fn PeekNamedPipe(
            pipe: Handle,
            buffer: *mut c_void,
            size: Dword,
            read: *mut Dword,
            available: *mut Dword,
            left: *mut Dword,
        ) -> Bool;
        fn ReadFile(
            handle: Handle,
            buffer: *mut c_void,
            size: Dword,
            read: *mut Dword,
            overlapped: *mut c_void,
        ) -> Bool;
        fn WriteFile(
            handle: Handle,
            buffer: *const c_void,
            size: Dword,
            written: *mut Dword,
            overlapped: *mut c_void,
        ) -> Bool;
    }
    const HANDLE_FLAG_INHERIT: Dword = 1;
    const EXTENDED_STARTUPINFO_PRESENT: Dword = 0x0008_0000;
    const CREATE_UNICODE_ENVIRONMENT: Dword = 0x0000_0400;
    const CREATE_SUSPENDED: Dword = 0x0000_0004;
    const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const INFINITE: Dword = 0xffff_ffff;
    #[repr(C)]
    struct BasicLimit {
        per_process_time: i64,
        per_job_time: i64,
        limit_flags: Dword,
        min_working_set: usize,
        max_working_set: usize,
        active_processes: Dword,
        affinity: usize,
        priority: Dword,
        scheduling: Dword,
    }
    #[repr(C)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    struct JobLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    fn wide(s: &OsStr) -> io::Result<Vec<u16>> {
        let mut out: Vec<u16> = s.encode_wide().collect();
        if out.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in process argument",
            ));
        }
        out.push(0);
        Ok(out)
    }
    fn last_error() -> io::Error {
        io::Error::last_os_error()
    }
    fn quote_arg(arg: &[u16], out: &mut Vec<u16>) {
        let needs_quotes = arg.is_empty() || arg.iter().any(|c| *c == 32 || *c == 9 || *c == 34);
        if !needs_quotes {
            out.extend_from_slice(arg);
            return;
        }
        out.push(34);
        let mut slashes = 0;
        for &ch in arg {
            if ch == 92 {
                slashes += 1;
                continue;
            }
            if ch == 34 {
                out.extend(std::iter::repeat_n(92, slashes * 2 + 1));
                out.push(ch);
                slashes = 0;
            } else {
                out.extend(std::iter::repeat_n(92, slashes));
                slashes = 0;
                out.push(ch);
            }
        }
        out.extend(std::iter::repeat_n(92, slashes * 2));
        out.push(34);
    }
    struct AttrList(Vec<usize>);
    impl Drop for AttrList {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast());
            }
        }
    }
    pub struct Process {
        input: Handle,
        output: Handle,
        console: Hpc,
        process: Handle,
        job: Handle,
        pid: u32,
        exit: Option<ExitStatus>,
    }
    impl Process {
        pub fn spawn(spec: TerminalLaunchSpec) -> io::Result<Self> {
            let app = wide(spec.executable.as_os_str())?;
            let cwd = wide(spec.cwd.as_os_str())?;
            let mut argv = Vec::with_capacity(spec.argv.len() + 1);
            argv.push(spec.executable.as_os_str().to_os_string());
            argv.extend(spec.argv);
            let mut line = Vec::new();
            for (i, arg) in argv.iter().enumerate() {
                if i != 0 {
                    line.push(32);
                }
                let w = wide(arg)?;
                quote_arg(&w[..w.len() - 1], &mut line);
            }
            line.push(0);
            let mut env_entries = Vec::new();
            for (k, v) in &spec.env {
                let mut e = wide(k.as_os_str())?;
                e.pop();
                if e.contains(&61) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "environment key contains '='",
                    ));
                }
                let mut val = wide(v.as_os_str())?;
                val.pop();
                e.extend([61]);
                e.extend(val);
                env_entries.push(e);
            }
            env_entries.sort_by(|a, b| {
                a.iter()
                    .map(|c| c.to_ascii_lowercase())
                    .cmp(b.iter().map(|c| c.to_ascii_lowercase()))
            });
            let mut env: Vec<u16> = env_entries
                .into_iter()
                .flatten()
                .chain(std::iter::once(0))
                .collect();
            if env.len() == 1 {
                env.push(0);
            }
            let mut sa = SecurityAttributes {
                length: size_of::<SecurityAttributes>() as u32,
                descriptor: null_mut(),
                inherit: 1,
            };
            let (mut input_read, mut input_write, mut output_read, mut output_write) =
                (null_mut(), null_mut(), null_mut(), null_mut());
            unsafe {
                if CreatePipe(&mut input_read, &mut input_write, &sa, 0) == 0 {
                    return Err(last_error());
                }
                if CreatePipe(&mut output_read, &mut output_write, &sa, 0) == 0 {
                    CloseHandle(input_read);
                    CloseHandle(input_write);
                    return Err(last_error());
                }
                if SetHandleInformation(input_write, HANDLE_FLAG_INHERIT, 0) == 0
                    || SetHandleInformation(output_read, HANDLE_FLAG_INHERIT, 0) == 0
                {
                    let error = last_error();
                    CloseHandle(input_read);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                    CloseHandle(output_write);
                    return Err(error);
                }
            }
            let mut console = null_mut();
            let hr = unsafe {
                CreatePseudoConsole(
                    Coord {
                        x: spec.cols as i16,
                        y: spec.rows as i16,
                    },
                    input_read,
                    output_write,
                    0,
                    &mut console,
                )
            };
            unsafe {
                CloseHandle(input_read);
                CloseHandle(output_write);
            }
            if hr < 0 {
                unsafe {
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(io::Error::from_raw_os_error(hr));
            }
            let mut attr_size = 0;
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attr_size);
            }
            let mut storage = vec![0usize; attr_size.div_ceil(size_of::<usize>())];
            if unsafe {
                InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut attr_size)
            } == 0
            {
                unsafe {
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(last_error());
            }
            let attrs = AttrList(storage);
            if unsafe {
                UpdateProcThreadAttribute(
                    attrs.0.as_mut_ptr().cast(),
                    0,
                    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                    console,
                    size_of::<Hpc>(),
                    null_mut(),
                    null_mut(),
                )
            } == 0
            {
                unsafe {
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(last_error());
            }
            let mut startup: StartupInfoEx = unsafe { zeroed() };
            startup.startup.cb = size_of::<StartupInfoEx>() as u32;
            startup.attributes = attrs.0.as_ptr().cast();
            let mut pi: ProcessInfo = unsafe { zeroed() };
            let created = unsafe {
                CreateProcessW(
                    app.as_ptr(),
                    line.as_mut_ptr(),
                    null_mut(),
                    null_mut(),
                    0,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                    env.as_mut_ptr().cast(),
                    cwd.as_ptr(),
                    (&mut startup as *mut StartupInfoEx).cast(),
                    &mut pi,
                )
            };
            if created == 0 {
                unsafe {
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(last_error());
            }
            let job = unsafe { CreateJobObjectW(null_mut(), null()) };
            if job.is_null() {
                unsafe {
                    TerminateProcess(pi.process, 1);
                    WaitForSingleObject(pi.process, INFINITE);
                    CloseHandle(pi.thread);
                    CloseHandle(pi.process);
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(last_error());
            }
            let mut limits: JobLimit = unsafe { zeroed() };
            limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &limits as *const _ as *const c_void,
                    size_of::<JobLimit>() as u32,
                )
            } == 0
                || unsafe { AssignProcessToJobObject(job, pi.process) } == 0
            {
                let error = last_error();
                unsafe {
                    TerminateProcess(pi.process, 1);
                    WaitForSingleObject(pi.process, INFINITE);
                    CloseHandle(job);
                    CloseHandle(pi.thread);
                    CloseHandle(pi.process);
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(error);
            }
            if unsafe { ResumeThread(pi.thread) } == u32::MAX {
                let error = last_error();
                unsafe {
                    TerminateJobObject(job, 1);
                    WaitForSingleObject(pi.process, INFINITE);
                    CloseHandle(job);
                    CloseHandle(pi.thread);
                    CloseHandle(pi.process);
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(error);
            }
            unsafe {
                CloseHandle(pi.thread);
            }
            Ok(Self {
                input: input_write,
                output: output_read,
                console,
                process: pi.process,
                job,
                pid: pi.pid,
                exit: None,
            })
        }
        pub fn pid(&self) -> u32 {
            self.pid
        }
        pub fn backend(&self) -> TerminalBackend {
            TerminalBackend::WindowsConPty
        }
        pub fn guarantees(&self) -> ProcessGuarantees {
            ProcessGuarantees {
                observed_exit: true,
                tree_kill_on_owner_close: true,
                process_tree_termination: true,
            }
        }
        pub fn owner_loss_tree_cleanup_supported() -> bool {
            true
        }
        pub fn read_output(&mut self, max: usize) -> io::Result<Vec<u8>> {
            let mut available = 0;
            if unsafe {
                PeekNamedPipe(
                    self.output,
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error());
            }
            let count = available.min(max as u32) as usize;
            let mut bytes = vec![0; count];
            if count == 0 {
                return Ok(bytes);
            }
            let mut got = 0;
            if unsafe {
                ReadFile(
                    self.output,
                    bytes.as_mut_ptr().cast(),
                    count as u32,
                    &mut got,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error());
            }
            bytes.truncate(got as usize);
            Ok(bytes)
        }
        pub fn write_input(&mut self, bytes: &[u8]) -> io::Result<()> {
            if bytes.is_empty() {
                return Ok(());
            }
            let mut n = 0;
            if unsafe {
                WriteFile(
                    self.input,
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    &mut n,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error());
            }
            if n as usize != bytes.len() {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "partial terminal input write",
                ));
            }
            Ok(())
        }
        pub fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
            let hr = unsafe {
                ResizePseudoConsole(
                    self.console,
                    Coord {
                        x: cols as i16,
                        y: rows as i16,
                    },
                )
            };
            if hr < 0 {
                Err(io::Error::from_raw_os_error(hr))
            } else {
                Ok(())
            }
        }
        pub fn request_terminate(&mut self, _reason: TerminationReason) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.job, 1) } == 0 {
                let e = last_error();
                if self.try_wait()?.is_some() {
                    Ok(())
                } else {
                    Err(e)
                }
            } else {
                Ok(())
            }
        }
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if let Some(s) = self.exit {
                return Ok(Some(s));
            }
            match unsafe { WaitForSingleObject(self.process, 0) } {
                0 => {
                    let mut code = 0;
                    if unsafe { GetExitCodeProcess(self.process, &mut code) } == 0 {
                        return Err(last_error());
                    }
                    self.exit = Some(ExitStatus::from_raw(code as i32));
                    Ok(self.exit)
                }
                0x102 => Ok(None),
                _ => Err(last_error()),
            }
        }
    }
    impl Drop for Process {
        fn drop(&mut self) {
            if self.request_terminate(TerminationReason::OwnerLost).is_ok() {
                // Job termination is asynchronous; wait for the leader before releasing
                // PTY resources, and observe its status rather than inferring exit from close.
                unsafe {
                    WaitForSingleObject(self.process, INFINITE);
                }
                let _ = self.try_wait();
            }
            // Closing the pseudoconsole can enqueue a final frame; keep the output
            // pipe alive and drain it before closing the inherited pipe handle.
            unsafe {
                ClosePseudoConsole(self.console);
            }
            self.console = null_mut();
            loop {
                let mut available = 0;
                if unsafe {
                    PeekNamedPipe(
                        self.output,
                        null_mut(),
                        0,
                        null_mut(),
                        &mut available,
                        null_mut(),
                    )
                } == 0
                    || available == 0
                {
                    break;
                }
                let mut buffer = [0_u8; 4096];
                let mut read = 0;
                if unsafe {
                    ReadFile(
                        self.output,
                        buffer.as_mut_ptr().cast(),
                        available.min(buffer.len() as u32),
                        &mut read,
                        null_mut(),
                    )
                } == 0
                    || read == 0
                {
                    break;
                }
            }
            unsafe {
                CloseHandle(self.input);
                CloseHandle(self.output);
                CloseHandle(self.process);
                CloseHandle(self.job);
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use super::*;
    pub struct Process;
    impl Process {
        pub fn spawn(_: TerminalLaunchSpec) -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable on this target",
            ))
        }
        pub fn pid(&self) -> u32 {
            0
        }
        pub fn backend(&self) -> TerminalBackend {
            TerminalBackend::Unavailable
        }
        pub fn guarantees(&self) -> ProcessGuarantees {
            ProcessGuarantees {
                observed_exit: false,
                tree_kill_on_owner_close: false,
                process_tree_termination: false,
            }
        }
        pub fn owner_loss_tree_cleanup_supported() -> bool {
            false
        }
        pub fn read_output(&mut self, _: usize) -> io::Result<Vec<u8>> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
        pub fn write_input(&mut self, _: &[u8]) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
        pub fn resize(&mut self, _: u16, _: u16) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
        pub fn request_terminate(&mut self, _: TerminationReason) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
    }
}
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::ffi::OsString;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::PermissionsExt;
    use std::thread;
    use std::time::Instant;

    #[test]
    fn external_editor_profile_is_strict_and_inserts_target_as_one_literal_arg() {
        use crate::protocol::Value;
        let definition = Value::Map(BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            ("profileId".to_owned(), Value::String("editor.vim".to_owned())),
            ("revision".to_owned(), Value::String("7".to_owned())),
            ("executableSelector".to_owned(), Value::String("horizoncode:editor:vim".to_owned())),
            ("argv".to_owned(), Value::Array(vec![Value::String("--".to_owned())])),
            ("targetArgIndex".to_owned(), Value::Unsigned(1)),
            ("launchMode".to_owned(), Value::String("foreground_tty".to_owned())),
            ("targetKinds".to_owned(), Value::Array(vec![Value::String("workspace_file".to_owned())])),
            ("environmentPolicy".to_owned(), Value::String("sanitized_host".to_owned())),
        ]));
        let profile = ExternalEditorProfileV1::from_value(&definition).unwrap();
        // Production only ever passes the absolute host-created scratch token
        // (§14.29); it must land as one literal argv value, spaces included.
        let scratch = "/private/horizoncode-scratch/editor target with spaces.rs";
        assert_eq!(profile.argv_for_target(scratch, ExternalEditorTargetKindV1::WorkspaceFile).unwrap(),
            vec![OsString::from("--"), OsString::from(scratch)]);
        // Relative and traversal-shaped targets are refused outright.
        assert!(profile.argv_for_target("src/file with spaces.rs", ExternalEditorTargetKindV1::WorkspaceFile).is_err());
        assert!(profile.argv_for_target("../outside.rs", ExternalEditorTargetKindV1::WorkspaceFile).is_err());
        assert!(profile.argv_for_target("src\\outside.rs", ExternalEditorTargetKindV1::WorkspaceFile).is_err());
        let base = profile.definition_digest().unwrap();
        let mut changed = definition.clone();
        {
            let Value::Map(fields) = &mut changed else { unreachable!() };
            fields.insert("argv".to_owned(), Value::Array(vec![Value::String("--readonly".to_owned())]));
        }
        assert_ne!(base, ExternalEditorProfileV1::from_value(&changed).unwrap().definition_digest().unwrap());
        {
            let Value::Map(fields) = &mut changed else { unreachable!() };
            fields.insert("argv".to_owned(), Value::Array(vec![Value::String("--".to_owned())]));
            fields.insert("unexpected".to_owned(), Value::Bool(true));
        }
        assert!(ExternalEditorProfileV1::from_value(&changed).is_err());
    }

    #[test]
    fn dap_profile_policy_is_strict_default_denied_and_digest_bound() {
        use crate::protocol::Value;
        let mut definition = BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            ("profileId".to_owned(), Value::String("dap-test".to_owned())),
            ("revision".to_owned(), Value::String("1".to_owned())),
            ("kind".to_owned(), Value::String("dap".to_owned())),
            ("executableSelector".to_owned(), Value::String("horizoncode:dap:debugpy-adapter".to_owned())),
            ("argv".to_owned(), Value::Array(Vec::new())),
            ("workingDirectoryPolicy".to_owned(), Value::String("registered_location_root".to_owned())),
            ("environmentPolicy".to_owned(), Value::String("sanitized_host".to_owned())),
        ]);
        let base = ExecutionLaunchProfileV1::from_value(&Value::Map(definition.clone())).unwrap();
        assert_eq!(base.dap_policy_allow_evaluate, None);
        let digest_without_policy = base.definition_digest().unwrap();
        definition.insert("dapPolicy".to_owned(), Value::Map(BTreeMap::from([
            ("allowEvaluate".to_owned(), Value::Bool(false)),
        ])));
        let disabled = ExecutionLaunchProfileV1::from_value(&Value::Map(definition.clone())).unwrap();
        assert_eq!(disabled.dap_policy_allow_evaluate, Some(false));
        assert_ne!(disabled.definition_digest().unwrap(), digest_without_policy);
        definition.insert("dapPolicy".to_owned(), Value::Map(BTreeMap::from([
            ("allowEvaluate".to_owned(), Value::Bool(true)),
        ])));
        let enabled = ExecutionLaunchProfileV1::from_value(&Value::Map(definition.clone())).unwrap();
        assert_eq!(enabled.dap_policy_allow_evaluate, Some(true));
        assert_ne!(enabled.definition_digest().unwrap(), disabled.definition_digest().unwrap());
        definition.insert("kind".to_owned(), Value::String("lsp".to_owned()));
        assert!(ExecutionLaunchProfileV1::from_value(&Value::Map(definition)).is_err());
    }

    fn launch(command: &str) -> TerminalLaunchSpec {
        TerminalLaunchSpec {
            executable: PathBuf::from("/bin/sh"),
            argv: vec![OsString::from("-c"), OsString::from(command)],
            cwd: std::env::current_dir().expect("current directory"),
            env: BTreeMap::new(),
            cols: 80,
            rows: 24,
        }
    }

    /// OS capability probe: confined stdio/PTY preflight and cgroup attachment
    /// need a delegated cgroup subtree this user can write. Root-owned cgroupfs
    /// without user delegation cannot run those paths; tests gate on this and
    /// report SKIP loudly instead of failing, exactly like the product's
    /// fail-closed "confinement unavailable" stance. Everything durable before
    /// the probe still runs.
    fn delegated_cgroup_root_available() -> bool {
        std::fs::read_to_string("/proc/self/cgroup")
            .ok()
            .and_then(|contents| {
                contents
                    .lines()
                    .find(|line| line.starts_with("0::"))
                    .map(|line| line[3..].to_owned())
            })
            .map(|relative| {
                std::path::PathBuf::from("/sys/fs/cgroup").join(relative.trim_start_matches('/'))
            })
            .map(|root| {
                let probe = root.join(format!(".hz-p1-delegation-probe-{}", std::process::id()));
                let created = std::fs::create_dir(&probe).is_ok();
                if created {
                    let _ = std::fs::remove_dir(&probe);
                }
                created
            })
            .unwrap_or(false)
    }

    #[test]
    fn terminal_launch_digest_changes_with_command_environment_and_workspace() {
        let root = std::env::temp_dir().join(format!("hz-launch-digest-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut base = launch("printf one");
        base.cwd = root.clone();
        base.env
            .insert(OsString::from("PATH"), OsString::from("/usr/bin"));
        let digest = terminal_launch_digest(&base, &root).unwrap();

        let mut changed = launch("printf two");
        changed.cwd = root.clone();
        changed
            .env
            .insert(OsString::from("PATH"), OsString::from("/usr/bin"));
        assert_ne!(terminal_launch_digest(&changed, &root).unwrap(), digest);

        let mut changed = base.clone();
        changed
            .env
            .insert(OsString::from("HOME"), OsString::from("/tmp/other"));
        assert_ne!(terminal_launch_digest(&changed, &root).unwrap(), digest);

        let other = root.join("nested");
        std::fs::create_dir(&other).unwrap();
        assert_ne!(terminal_launch_digest(&base, &other).unwrap(), digest);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guard_execution_readiness_requires_the_launch_guarantees() {
        #[cfg(target_os = "linux")]
        assert!(guard_execution_backend_ready().is_ok());
        #[cfg(not(target_os = "linux"))]
        assert!(guard_execution_backend_ready().is_err());
    }

    fn read_for(process: &mut TerminalProcess, needle: &[u8]) -> Vec<u8> {
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let mut output = Vec::new();
        while Instant::now() < deadline {
            output.extend(process.read_output(4096).expect("read output"));
            if output.windows(needle.len()).any(|window| window == needle) {
                return output;
            }
            thread::sleep(std::time::Duration::from_millis(5));
        }
        panic!(
            "terminal output did not contain the expected marker {:?}; captured {:?}",
            String::from_utf8_lossy(needle),
            String::from_utf8_lossy(&output)
        );
    }

    fn marker_pid(output: &[u8], marker: &[u8]) -> libc::pid_t {
        let index = output
            .windows(marker.len())
            .position(|window| window == marker)
            .expect("output marker")
            + marker.len();
        let mut value: libc::pid_t = 0;
        for byte in &output[index..] {
            if !byte.is_ascii_digit() {
                break;
            }
            value = value * 10 + (byte - b'0') as libc::pid_t;
        }
        assert!(value > 1, "output marker did not carry a process id");
        value
    }

    fn alive(pid: libc::pid_t) -> bool {
        (unsafe { libc::kill(pid, 0) }) == 0
    }

    fn wait_dead(pid: libc::pid_t, timeout: std::time::Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !alive(pid) {
                return true;
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        !alive(pid)
    }

    fn wait_supervisor_exit(process: &mut TerminalProcess) {
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match process.try_wait() {
                Err(_) => return,
                Ok(None) => {}
                Ok(Some(_)) => panic!("owner loss must not fabricate an observed exit status"),
            }
            assert!(
                Instant::now() < deadline,
                "supervisor did not exit after owner loss"
            );
            thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn output_reads_obey_the_requested_bound() {
        let mut process =
            TerminalProcess::spawn(launch("printf 'terminal-output'")).expect("spawn shell");
        let mut output = Vec::new();
        for _ in 0..100 {
            let chunk = process.read_output(4).expect("read output");
            assert!(chunk.len() <= 4);
            output.extend(chunk);
            if output.len() == b"terminal-output".len() {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(2));
        }
        assert_eq!(output, b"terminal-output");
    }

    #[test]
    fn silent_terminal_output_read_never_blocks_deadline_or_cancel_polling() {
        let mut process =
            TerminalProcess::spawn(launch("sleep 0.5")).expect("spawn silent command");
        let started = Instant::now();
        assert!(
            process
                .read_output(64)
                .expect("poll idle output")
                .is_empty()
        );
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "an idle output poll must not wait for the process to exit"
        );
        assert!(
            process.try_wait().unwrap().is_none(),
            "the output poll must leave the live command running"
        );
        process
            .request_terminate(TerminationReason::Cancelled)
            .unwrap();
        assert!(matches!(
            process.wait_timeout(Duration::from_secs(5)).unwrap(),
            WaitOutcome::Exited(_)
        ));
    }

    #[test]
    fn dropping_process_reaps_the_pty_leader() {
        let process = TerminalProcess::spawn(launch("sleep 30")).expect("spawn shell");
        let pid = process.pid() as libc::pid_t;
        drop(process);
        // Drop signals owner loss; the supervisor terminates and reaps the session tree.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }

    #[test]
    fn observed_exit_status_is_relayed_to_the_owner() {
        let mut process = TerminalProcess::spawn(launch("exit 7")).expect("spawn shell");
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = process.try_wait().expect("poll exit") {
                assert_eq!(status.code(), Some(7));
                return;
            }
            assert!(Instant::now() < deadline, "terminal exit was not relayed");
            thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn confined_launch_writes_workspace_but_cannot_touch_outside_or_metadata() {
        if !delegated_cgroup_root_available() {
            eprintln!("SKIP confined_launch_writes_workspace_but_cannot_touch_outside_or_metadata: no user-owned delegated cgroup root on this host");
            return;
        }
        let root = std::env::temp_dir().join(format!("hz-pty-confinement-{}", std::process::id()));
        let workspace = root.join("workspace");
        std::fs::create_dir_all(workspace.join(".git")).unwrap();
        std::fs::write(root.join("outside"), "original").unwrap();
        std::fs::write(workspace.join(".git/config"), "original").unwrap();
        let mut spec = launch(&format!(
            "exec 3<>/dev/tty || exit 99; printf inside > inside; printf escaped > '{}'; printf forged > .git/config; printf CONFIRMED",
            root.join("outside").display()
        ));
        spec.cwd = workspace.clone();
        let mut prepared = TerminalProcess::prepare_confined(spec, &workspace)
            .expect("confinement required for this acceptance host");
        // §14.21: the dispatcher attaches the exact durable execution cgroup it
        // owns before spawn; the prepared launch refuses to run without one.
        let cgroup = crate::cgroup_v2::ExecutionCgroupV2::create(
            "execution_pty_confine",
            "effect_pty_confine",
            &format!("blake3:{}", "a".repeat(64)),
            "host_os_uid:1000",
            None,
            1,
            1,
            "terminal_run",
            "linux-bash",
            1,
            &format!("blake3:{}", "b".repeat(64)),
            &executable_digest(&prepared.executable_path).unwrap(),
            "none",
            prepared.cgroup_hierarchy_hidden,
        )
        .expect("delegated root probe passed, cgroup creation must succeed");
        prepared
            .attach_execution_cgroup(cgroup)
            .expect("the prepared launch accepts its exact confinement cgroup");
        assert!(
            prepared
                .guarantee_record()
                .contains("filesystem_write level=enforced")
        );
        assert!(
            prepared
                .guarantee_record()
                .contains("process_tree level=enforced")
        );
        let mut process = TerminalProcess::spawn_prepared(prepared).expect("spawn confined PTY");
        read_for(&mut process, b"CONFIRMED");
        let WaitOutcome::Exited(status) = process
            .wait_timeout(std::time::Duration::from_secs(5))
            .unwrap()
        else {
            panic!("confined child timed out")
        };
        assert_eq!(status.code(), Some(0));
        drop(process);
        assert_eq!(
            std::fs::read_to_string(workspace.join("inside")).unwrap(),
            "inside"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("outside")).unwrap(),
            "original"
        );
        assert_eq!(
            std::fs::read_to_string(workspace.join(".git/config")).unwrap(),
            "original"
        );
        assert!(
            !workspace.join(".agents").exists(),
            "missing protected placeholders must be removed after tree cleanup"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confined_stdio_launch_keeps_streams_separate_and_blocks_outside_writes() {
        let root =
            std::env::temp_dir().join(format!("hz-stdio-confinement-{}", std::process::id()));
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let outside = PathBuf::from(format!("/etc/hz-stdio-outside-{}", std::process::id()));
        assert!(!outside.exists(), "test marker must not pre-exist");
        let marker = workspace.join("inside-marker");
        let mut spec = StdioLaunchSpec::new(
            "/bin/sh",
            executable_digest("/bin/sh").unwrap(),
            [
                "-c",
                &format!(
                    "printf stdout; touch '{}'; if touch '{}' 2>/dev/null; then exit 9; fi; printf denied >&2",
                    marker.display(),
                    outside.display()
                ),
            ],
            &workspace,
        );
        spec.writable_roots.push(workspace.clone());
        let prepared = StdioProcess::prepare_confined(spec)
            .expect("confinement required for this acceptance host");
        assert!(
            prepared
                .guarantee_record()
                .contains("filesystem_write level=enforced")
        );
        let mut process = StdioProcess::spawn_prepared(prepared).expect("spawn confined process");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut stdout_sequence = 0;
        let mut stderr_sequence = 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let page = process
                .read_output_page(1, stdout_sequence, stderr_sequence, 64 * 1024)
                .unwrap();
            stdout_sequence = page.next_stdout_sequence;
            stderr_sequence = page.next_stderr_sequence;
            for record in page.records {
                match record.source {
                    StdioOutputSource::Stdout => stdout.extend(record.bytes),
                    StdioOutputSource::Stderr => stderr.extend(record.bytes),
                }
            }
            if page.eof {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "confined stdio process did not finish"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let WaitOutcome::Exited(status) = process.wait_timeout(Duration::from_secs(5)).unwrap()
        else {
            panic!("confined process timed out")
        };
        assert_eq!(status.code(), Some(0));
        assert_eq!(stdout, b"stdout");
        assert_eq!(stderr, b"denied");
        assert!(marker.exists(), "authorized workspace writes must succeed");
        assert!(
            !outside.exists(),
            "outside write must not create a host file"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn repository_test_workspace(label: &str) -> PathBuf {
        let root = std::env::current_dir()
            .expect("repository root")
            .join("target")
            .join(format!("hz-p1-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("repository-local test workspace");
        root
    }

    #[test]
    fn stdio_stdin_delivery_to_nonreading_child_is_deadline_bounded() {
        let workspace = repository_test_workspace("stdin-deadline");
        let mut spec = StdioLaunchSpec::new(
            "/bin/sh",
            executable_digest("/bin/sh").unwrap(),
            ["-c", "/bin/sleep 30"],
            &workspace,
        );
        spec.timeout = Duration::from_millis(300);
        spec.use_readonly_workspace();
        let prepared = StdioProcess::prepare_confined(spec).expect("confined preflight");
        let mut process = StdioProcess::spawn_prepared(prepared).expect("confined spawn");
        let frame = vec![b'x'; MAX_INPUT_BYTES];
        let started = Instant::now();
        let error = loop {
            match process.write_stdin(&frame) {
                Ok(()) => {}
                Err(error) => break error,
            }
        };
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
        let deadline = Instant::now() + Duration::from_secs(2);
        while process.try_wait().expect("observe terminated child").is_none() {
            assert!(Instant::now() < deadline, "timed-out stdin child remained live");
            thread::sleep(Duration::from_millis(5));
        }
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn stdio_execution_deadline_starts_at_launch_not_guard_preflight() {
        if !delegated_cgroup_root_available() {
            eprintln!("SKIP stdio_execution_deadline_starts_at_launch_not_guard_preflight: no user-owned delegated cgroup root on this host");
            return;
        }
        let workspace = repository_test_workspace("preflight-deadline");
        let workspace_revision = format!("blake3:{}", "a".repeat(64));
        let profile_digest = format!("blake3:{}", "d".repeat(64));
        let executable_digest = executable_digest("/bin/sh").unwrap();
        let binding = StdioExecutionBindingV1 {
            execution_id: "execution_deadline_start_test".to_owned(),
            effect_id: "effect_deadline_start_test".to_owned(),
            challenge_id: "challenge_deadline_start_test".to_owned(),
            principal: "host_os_uid:1000".to_owned(),
            execution_principal: "host_os_uid:1000".to_owned(),
            scope: StdioExecutionScopeV1::Session { session_id: "session_deadline_start_test".to_owned() },
            session_id: "session_deadline_start_test".to_owned(),
            location_id: "location_deadline_start_test".to_owned(),
            capability_id: crate::guard::TERMINAL_RUN_ID.to_owned(),
            capability_lease_digest: format!("blake3:{}", "c".repeat(64)),
            approved_arguments_digest: format!("blake3:{}", "b".repeat(64)),
            attempt_scope_digest: None,
            owner_epoch: 1,
            generation: 1,
            workspace_revision,
            profile_ref: "profile_deadline_start_test".to_owned(),
            profile_id: "profile_deadline_start_test".to_owned(),
            profile_revision: 1,
            profile_digest: profile_digest.clone(),
            executable_digest: executable_digest.clone(),
            dap_allow_evaluate: false,
        };
        let mut spec = StdioLaunchSpec::new(
            "/bin/sh",
            executable_digest,
            ["-c", "/bin/sleep 30"],
            &workspace,
        );
        spec.timeout = Duration::from_secs(2);
        spec.use_readonly_workspace();
        spec.profile_digest = profile_digest;
        spec.workspace_revision = binding.workspace_revision.clone();
        let mut supervisor = StdioExecutionSupervisor::default();
        let prepared = supervisor
            .preflight(binding.clone(), spec)
            .expect("confined preflight");
        thread::sleep(Duration::from_millis(2_100));
        let intent = StdioExecutionDispatchIntentV1::new(
            binding.clone(),
            prepared.execution_digest,
            "dispatch_deadline_start_test".to_owned(),
        );
        supervisor.launch(intent).expect("dispatch after approval delay");
        let page = supervisor.read_output(&binding, 0, 0, 1024).expect("read output");
        assert!(!page.eof, "fresh process must not inherit expired preflight time");
        assert_eq!(
            supervisor.status(&binding).unwrap().state,
            StdioExecutionStateV1::Running
        );
        supervisor.cancel(&binding).expect("cancel fixture child");
        let deadline = Instant::now() + Duration::from_secs(2);
        while supervisor.status(&binding).unwrap().state != StdioExecutionStateV1::Exited {
            assert!(Instant::now() < deadline, "fixture child did not exit after cancel");
            thread::sleep(Duration::from_millis(5));
        }
        drop(supervisor);
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn stdio_preflight_digest_is_bound_to_the_exact_guard_approved_arguments() {
        let spec_digest = format!("blake3:{}", "a".repeat(64));
        let approved = format!("blake3:{}", "b".repeat(64));
        let altered = format!("blake3:{}", "c".repeat(64));

        let principal = "host_os_uid:1000";
        let expected = bind_stdio_execution_digest(&spec_digest, &approved, principal);
        assert_eq!(
            expected,
            bind_stdio_execution_digest(&spec_digest, &approved, principal)
        );
        assert_ne!(
            expected,
            bind_stdio_execution_digest(&spec_digest, &altered, principal)
        );
        // The execution principal is part of the approval binding: a reviewer
        // identity can never substitute for the trusted process owner.
        assert_ne!(
            expected,
            bind_stdio_execution_digest(&spec_digest, &approved, "host_os_uid:0")
        );
        assert!(expected.starts_with("blake3:"));
    }

    #[test]
    fn discarding_preflight_releases_only_the_exact_unstarted_execution() {
        if !delegated_cgroup_root_available() {
            eprintln!("SKIP discarding_preflight_releases_only_the_exact_unstarted_execution: no user-owned delegated cgroup root on this host");
            return;
        }
        let root = std::env::temp_dir().join(format!("hz-stdio-discard-{}", std::process::id()));
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let marker = workspace.join("must-not-run");
        let workspace_revision = format!("blake3:{}", "a".repeat(64));
        let approved_arguments_digest = format!("blake3:{}", "b".repeat(64));
        let executable_digest = executable_digest("/bin/sh").unwrap();
        let profile_digest = format!("blake3:{}", "d".repeat(64));
        let mut binding = StdioExecutionBindingV1 {
            execution_id: "execution_discard_test".to_owned(),
            effect_id: "effect_discard_test".to_owned(),
            challenge_id: "challenge_discard_test".to_owned(),
            principal: "host_os_uid:1000".to_owned(),
            execution_principal: "host_os_uid:1000".to_owned(),
            scope: StdioExecutionScopeV1::Session { session_id: "session_discard_test".to_owned() },
            session_id: "session_discard_test".to_owned(),
            location_id: "location_discard_test".to_owned(),
            capability_id: crate::guard::TERMINAL_RUN_ID.to_owned(),
            capability_lease_digest: format!("blake3:{}", "c".repeat(64)),
            approved_arguments_digest,
            attempt_scope_digest: None,
            owner_epoch: 1,
            generation: 1,
            workspace_revision: workspace_revision.clone(),
            profile_ref: "profile_discard_test".to_owned(),
            profile_id: "profile_discard_test".to_owned(),
            profile_revision: 1,
            profile_digest: profile_digest.clone(),
            executable_digest: executable_digest.clone(),
            dap_allow_evaluate: false,
        };
        let mut spec = StdioLaunchSpec::new(
            "/bin/sh",
            executable_digest,
            ["-c", &format!("touch '{}'", marker.display())],
            &workspace,
        );
        spec.writable_roots.push(workspace.clone());
        spec.profile_digest = profile_digest;
        spec.workspace_revision = workspace_revision;

        let mut supervisor = StdioExecutionSupervisor::default();
        supervisor
            .preflight(binding.clone(), spec)
            .expect("confined preflight");
        binding.execution_id = "forged_execution_discard_test".to_owned();
        assert_eq!(
            supervisor.discard_preflight(&binding).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        binding.execution_id = "execution_discard_test".to_owned();
        supervisor
            .discard_preflight(&binding)
            .expect("discard exact preflight");
        assert!(
            !marker.exists(),
            "discarding a preflight must never spawn it"
        );
        assert_eq!(
            supervisor.discard_preflight(&binding).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confined_stdio_output_pages_and_total_capture_are_bounded() {
        let root = std::env::temp_dir().join(format!("hz-stdio-output-{}", std::process::id()));
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let mut spec = StdioLaunchSpec::new(
            "/bin/sh",
            executable_digest("/bin/sh").unwrap(),
            ["-c", "printf 123456789; sleep 1"],
            &workspace,
        );
        spec.max_output_bytes = 5;
        spec.retain_output_for_host();
        let prepared = StdioProcess::prepare_confined(spec).expect("confined preflight");
        let mut process = StdioProcess::spawn_prepared(prepared).expect("confined spawn");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut stdout_sequence = 0;
        let mut stderr_sequence = 0;
        let mut records = Vec::new();
        let truncated = loop {
            let page = process
                .read_output_page(7, stdout_sequence, stderr_sequence, 1024)
                .unwrap();
            assert_eq!(page.generation, 7);
            stdout_sequence = page.next_stdout_sequence;
            stderr_sequence = page.next_stderr_sequence;
            records.extend(page.records);
            if page.truncated {
                break true;
            }
            assert!(Instant::now() < deadline, "output cap was not observed");
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].source, StdioOutputSource::Stdout);
        assert_eq!(records[0].sequence, 1);
        assert_eq!(records[0].bytes, b"12345");
        assert_eq!(stdout_sequence, 1);
        assert_eq!(stderr_sequence, 0);
        assert!(
            truncated,
            "the first byte beyond the output cap must be detected"
        );
        assert!(matches!(
            process.wait_timeout(Duration::from_secs(5)).unwrap(),
            WaitOutcome::Exited(_)
        ));
        let captured = process
            .take_observed_output()
            .expect("supervisor retains the exact bounded process output for trusted capture");
        assert_eq!(captured.stdout, b"12345");
        assert!(captured.stderr.is_empty());
        assert!(process.take_observed_output().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confined_preflight_rejects_cwd_outside_workspace_before_spawn() {
        let base = std::env::temp_dir().join(format!("hz-pty-cwd-{}", std::process::id()));
        let root = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut spec = launch("touch must-not-run");
        spec.cwd = outside.clone();
        assert!(TerminalProcess::prepare_confined(spec, &root).is_err());
        assert!(!outside.join("must-not-run").exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn abandoning_preflight_never_removes_a_concurrently_created_user_directory() {
        let root = std::env::temp_dir().join(format!("hz-pty-preflight-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut spec = launch("printf must-not-run");
        spec.cwd = root.clone();
        let prepared = TerminalProcess::prepare_confined(spec, &root).unwrap();
        std::fs::create_dir(root.join(".agents")).unwrap();
        drop(prepared);
        assert!(
            root.join(".agents").is_dir(),
            "preflight cleanup must preserve directories created by another actor"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confined_pty_cannot_connect_to_host_listener() {
        if !delegated_cgroup_root_available() {
            eprintln!("SKIP confined_pty_cannot_connect_to_host_listener: no user-owned delegated cgroup root on this host");
            return;
        }
        let root = std::env::temp_dir().join(format!("hz-pty-network-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut spec = launch(&format!(
            "if echo probe >/dev/tcp/127.0.0.1/{port}; then printf CONNECTED; else printf DENIED; fi"
        ));
        spec.executable = PathBuf::from("/bin/bash");
        spec.cwd = root.clone();
        let mut prepared = TerminalProcess::prepare_confined(spec, &root).unwrap();
        // §14.21: attach the exact durable execution cgroup before spawn.
        let cgroup = crate::cgroup_v2::ExecutionCgroupV2::create(
            "execution_pty_network",
            "effect_pty_network",
            &format!("blake3:{}", "a".repeat(64)),
            "host_os_uid:1000",
            None,
            1,
            1,
            "terminal_run",
            "linux-bash",
            1,
            &format!("blake3:{}", "b".repeat(64)),
            &executable_digest(&prepared.executable_path).unwrap(),
            "none",
            prepared.cgroup_hierarchy_hidden,
        )
        .expect("delegated root probe passed, cgroup creation must succeed");
        prepared
            .attach_execution_cgroup(cgroup)
            .expect("the prepared launch accepts its exact confinement cgroup");
        let mut process = TerminalProcess::spawn_prepared(prepared).unwrap();
        let output = read_for(&mut process, b"DENIED");
        assert!(!output.windows(9).any(|window| window == b"CONNECTED"));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(process);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owner_loss_terminates_escaped_session_descendants() {
        let mut process = TerminalProcess::spawn(launch(
            "/usr/bin/setsid /bin/sh -c 'echo escapee=$$; sleep 300' & wait",
        ))
        .expect("spawn shell");
        let output = read_for(&mut process, b"escapee=");
        let escapee = marker_pid(&output, b"escapee=");
        assert!(alive(escapee), "the escaped descendant must start alive");
        process.abandon_owner();
        assert!(
            wait_dead(escapee, std::time::Duration::from_secs(10)),
            "owner loss must terminate escaped session descendants"
        );
        wait_supervisor_exit(&mut process);
    }

    #[test]
    fn owner_close_terminates_escaped_session_descendants() {
        let mut process = TerminalProcess::spawn(launch(
            "/usr/bin/setsid /bin/sh -c 'echo escapee=$$; sleep 300' & wait",
        ))
        .expect("spawn shell");
        let output = read_for(&mut process, b"escapee=");
        let escapee = marker_pid(&output, b"escapee=");
        assert!(alive(escapee), "the escaped descendant must start alive");
        drop(process);
        assert!(
            wait_dead(escapee, std::time::Duration::from_secs(10)),
            "owner close must terminate escaped session descendants"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ps014_prepared_terminal_without_containment_identity_never_spawns() {
        let workspace = std::env::temp_dir().join(format!("hz-ps014-no-spawn-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::set_permissions(&workspace, std::fs::Permissions::from_mode(0o700)).unwrap();
        let marker = workspace.join("must-not-spawn");
        let executable = std::fs::canonicalize("/bin/sh").unwrap();
        let mut spec = launch(&format!("touch {}", marker.display()));
        spec.cwd = workspace.clone();
        let prepared = PreparedTerminalLaunch {
            spec,
            confinement: None,
            guarantee_record: "PS-014 fixture prepared launch".to_owned(),
            launch_digest: format!("blake3:{}", "a".repeat(64)),
            executable_path: executable.clone(),
            executable_digest: executable_digest(&executable).unwrap(),
            cgroup_hierarchy_hidden: false,
            #[cfg(target_os = "linux")]
            cgroup: None,
            cgroup_required: true,
        };

        let error = match TerminalProcess::spawn_prepared(prepared) {
            Err(error) => error,
            Ok(_) => panic!("missing containment identity must deny dispatch"),
        };
        assert_eq!(error.kind(), io::ErrorKind::Unsupported, "{error:?}");
        assert!(!marker.exists(), "deny-before-spawn must leave no filesystem effect");
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ps014_full_access_terminal_uses_supervised_marker_and_no_cgroup_claim() {
        let workspace = std::env::temp_dir().join(format!("hz-ps014-full-access-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::set_permissions(&workspace, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut mode = crate::guard::DirectSessionPermissionModeProjectionV1 {
            session_id: "ses_ps014_full_access".to_owned(),
            owner_epoch: 7,
            location_id: format!("loc_{}", "a".repeat(64)),
            workspace_id: "wrk_ps014".to_owned(),
            workspace_root_digest: format!("blake3:{}", "b".repeat(64)),
            execution_backend_id: crate::guard::DIRECT_SESSION_EFFECT_BACKEND_ID.to_owned(),
            policy_digest: format!("blake3:{}", "c".repeat(64)),
            sandbox_mode: crate::guard::DirectSandboxModeV1::DangerFullAccess,
            approval_policy: crate::guard::DirectApprovalPolicyV1::Never,
            source: crate::guard::DirectPermissionModeSourceV1::UserSession,
            revision: 1,
            digest: String::new(),
        };
        mode.digest = mode.recompute_digest();
        let mut spec = launch("exit 0");
        spec.cwd = workspace.clone();
        let prepared = TerminalProcess::prepare_full_access(
            spec,
            &workspace,
            &mode.session_id,
            mode.owner_epoch,
            &mode.workspace_root_digest,
            &mode,
        )
        .expect("Full Access fixture is valid on Linux");
        assert_eq!(prepared.guarantee_record(), FULL_ACCESS_GUARANTEE_RECORD);
        assert!(prepared.cgroup_identity().is_none());
        let mut process = TerminalProcess::spawn_prepared(prepared).expect("Full Access dispatch");
        assert!(matches!(
            process.wait_timeout(std::time::Duration::from_secs(5)).unwrap(),
            WaitOutcome::Exited(status) if status.success()
        ));
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn observed_exit_waits_for_escaped_descendant_quiescence() {
        let mut process = TerminalProcess::spawn(launch(
            "/usr/bin/setsid /bin/sh -c 'echo escapee=$$; exec sleep 300' & sleep 1; exit 0",
        ))
        .expect("spawn shell");
        let output = read_for(&mut process, b"escapee=");
        let escapee = marker_pid(&output, b"escapee=");
        assert!(alive(escapee), "the escaped descendant must start alive");
        assert!(matches!(
            process.wait_timeout(std::time::Duration::from_secs(5)).unwrap(),
            WaitOutcome::Exited(_)
        ));
        assert!(
            !alive(escapee),
            "an observed exit must follow successful process-tree cleanup"
        );
    }
}
