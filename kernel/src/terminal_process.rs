//! Bounded, owner-managed terminal process backends.
//!
//! Commands, arguments, working directories, and environment values are never logged. The
//! supplied environment replaces the inherited environment; an empty map means empty env.
//!
//! On Linux a dedicated supervisor process owns the PTY session: it is the parent of the
//! session leader and a child subreaper, so owner loss (including a SIGKILLed owner) is
//! detected through a keepalive pipe and triggers a bounded process-tree kill and sweep
//! before the supervisor exits. The leader's exit status is relayed only when the
//! supervisor itself observed it.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::{Duration, Instant};

pub const MAX_INPUT_BYTES: usize = 16 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_STDIO_ARGUMENTS: usize = 128;
pub const MAX_STDIO_ARGUMENT_BYTES: usize = 64 * 1024;
pub const MAX_STDIO_ENV_ITEMS: usize = 32;
pub const MAX_STDIO_ENV_VALUE_BYTES: usize = 4 * 1024;
pub const MAX_STDIO_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_STDIO_OUTPUT_PAGE_BYTES: usize = 256 * 1024;

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
    /// A successful `try_wait` is the only indication that exit was observed.
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
}

pub struct PreparedTerminalLaunch {
    spec: TerminalLaunchSpec,
    confinement: horizoncode_sandbox::ExternalLaunch,
    guarantee_record: String,
    launch_digest: String,
    executable_path: PathBuf,
    executable_digest: String,
}

/// A host-resolved, bounded request for a non-PTY process. Callers must resolve the
/// executable reference from a trusted profile registry before constructing this value;
/// the digest is rechecked immediately before confinement preparation.
#[derive(Clone, Debug)]
pub struct StdioLaunchSpec {
    pub executable: PathBuf,
    pub executable_digest: String,
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
    /// Retain bytes for a crate-internal evidence producer. Ordinary terminal
    /// processes keep this off to avoid a second in-memory output copy.
    capture_output_for_host: bool,
}

#[derive(Clone, Debug, Default)]
enum StdioFilesystemPolicyV1 {
    #[default]
    WorkspaceWrite,
    GitWorktreeLifecycle {
        metadata_root: PathBuf,
        destination_parent: PathBuf,
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
}

impl ExecutionLaunchProfileV1 {
    pub fn from_value(value: &crate::protocol::Value) -> io::Result<Self> {
        use crate::protocol::Value;
        let Value::Map(fields) = value else {
            return Err(invalid_launch_profile());
        };
        const KEYS: [&str; 8] = [
            "schemaVersion",
            "profileId",
            "revision",
            "kind",
            "executableSelector",
            "argv",
            "workingDirectoryPolicy",
            "environmentPolicy",
        ];
        if fields.len() != KEYS.len() || KEYS.iter().any(|key| !fields.contains_key(*key)) {
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
        })
    }

    pub fn to_value(&self) -> crate::protocol::Value {
        use crate::protocol::Value;
        Value::Map(BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            ("profileId".to_owned(), Value::String(self.profile_id.clone())),
            ("revision".to_owned(), Value::String(self.revision.to_string())),
            (
                "kind".to_owned(),
                Value::String(match self.kind {
                    StdioProcessKindV1::LanguageServer => "lsp",
                    StdioProcessKindV1::DebugAdapter => "dap",
                    StdioProcessKindV1::Interpreter => "repl",
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
        ]))
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
            capture_output_for_host: false,
        }
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
    pub fn execution_digest(&self) -> &str {
        &self.execution_digest
    }
    pub fn max_output_bytes(&self) -> usize {
        self.max_output_bytes
    }
}

/// A non-PTY child launched through horizoncode-sandbox. Output capture and RPC framing
/// remain bounded by the owner; this handle only exposes the three requested pipes and
/// observed process lifecycle.
pub struct StdioProcess {
    child: horizoncode_sandbox::RunningChild,
    timeout: Duration,
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
}

/// Host-minted identity for a supervised process. This is a lookup reference, never
/// launch authority; the owning HostKernel retains the full authenticated binding and
/// checks principal, Session/Attempt, Location, workspace and owner epoch on every use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdioProcessKindV1 {
    TerminalRun,
    LanguageServer,
    DebugAdapter,
    Interpreter,
    ManagedVerifier,
}

impl StdioProcessKindV1 {
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::TerminalRun => "terminal_run",
            Self::LanguageServer => "language_server",
            Self::DebugAdapter => "debug_adapter",
            Self::Interpreter => "interpreter",
            Self::ManagedVerifier => "managed_verifier",
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
            Some("language_server") => StdioProcessKindV1::LanguageServer,
            Some("debug_adapter") => StdioProcessKindV1::DebugAdapter,
            Some("interpreter") => StdioProcessKindV1::Interpreter,
            Some("managed_verifier") => StdioProcessKindV1::ManagedVerifier,
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
    pub execution_digest: String,
    pub approved_arguments_digest: String,
    pub confinement_record: String,
    pub capability_lease_digest: String,
    /// OS-enforced resource dimensions of the selected backend. This backend currently
    /// proves none of the V1 worker CPU/memory/process-count/FD limits.
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
    pub exit_code: Option<i32>,
    pub stdout_sequence: u64,
    pub stderr_sequence: u64,
    pub stdout_digest: String,
    pub stderr_digest: String,
    pub output_bytes: u64,
    pub truncated: bool,
    pub receipt_digest: String,
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
}

/// One process owner for non-PTY Guarded executions. Durable intent and receipts remain
/// in EffectHost; this object owns only live process handles and single-use preflights.
#[derive(Default)]
pub struct StdioExecutionSupervisor {
    executions: BTreeMap<String, StdioExecutionRecord>,
}

impl PreparedTerminalLaunch {
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
            let cwd = std::fs::canonicalize(&spec.cwd)?;
            if !workspace.is_absolute()
                || !std::fs::metadata(&workspace)?.is_dir()
                || !cwd.starts_with(&workspace)
                || !std::fs::metadata(&cwd)?.is_dir()
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
            Ok(PreparedStdioLaunch {
                guarantee_record: prepared.guarantee_record(),
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
        let mut child = prepared
            .prepared
            .spawn(&prepared.request)
            .map_err(|error| io::Error::other(error.to_string()))?;
        let stdin = child.take_stdin();
        let stdout = child.take_stdout();
        let stderr = child.take_stderr();
        #[cfg(unix)]
        {
            for fd in [
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
        if bytes.len() > MAX_INPUT_BYTES
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
        stdin.write_all(bytes)?;
        stdin.flush()?;
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
    /// Run sandbox/executable preflight and retain the prepared object for exactly one
    /// later dispatch. This method creates no durable intent and consumes no Guard lease.
    pub fn preflight(
        &mut self,
        binding: StdioExecutionBindingV1,
        spec: StdioLaunchSpec,
    ) -> io::Result<StdioExecutionPreparedV1> {
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
        );
        let response = StdioExecutionPreparedV1 {
            execution_id: binding.execution_id.clone(),
            generation: binding.generation,
            execution_digest: execution_digest.clone(),
            approved_arguments_digest: binding.approved_arguments_digest.clone(),
            confinement_record: prepared.guarantee_record().to_owned(),
            capability_lease_digest: binding.capability_lease_digest.clone(),
            resource_guarantees: ProcessResourceGuaranteesV1::for_current_backend(),
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
        let process = StdioProcess::spawn_prepared(prepared)?;
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
        self.executions.remove(&binding.execution_id);
        Ok(())
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
        record
            .process
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "execution process is absent"))?
            .write_stdin(bytes)
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

    /// Fence an unresolved process after owner loss. The process handle is dropped and
    /// killed; the caller must persist UNKNOWN and must never call launch again.
    pub fn mark_unknown(
        &mut self,
        binding: &StdioExecutionBindingV1,
    ) -> io::Result<StdioExecutionStatusV1> {
        let record = self.record_mut(binding)?;
        record.prepared = None;
        record.process = None;
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
    if !valid_id(&binding.execution_id)
        || !valid_id(&binding.effect_id)
        || !valid_id(&binding.challenge_id)
        || !valid_id(&binding.location_id)
        || !valid_id(&binding.capability_id)
        || !valid_id(&binding.profile_ref)
        || !valid_id(&binding.profile_id)
        || binding.principal.is_empty()
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

fn bind_stdio_execution_digest(spec_digest: &str, approved_arguments_digest: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.stdio.approved-execution.v1\0");
    for value in [spec_digest.as_bytes(), approved_arguments_digest.as_bytes()] {
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

fn is_protected_workspace_path(workspace: &Path, candidate: &Path) -> bool {
    [".git", ".agents", ".codex", ".horizoncode"]
        .into_iter()
        .any(|name| candidate.starts_with(workspace.join(name)))
}

impl TerminalProcess {
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
        let confinement = prepared.prepare_external(&request).map_err(unavailable)?;
        let argv = confinement.argv();
        spec.executable = PathBuf::from(&argv[0]);
        spec.argv = argv[1..].to_vec();
        spec.cwd = cwd;
        Ok(PreparedTerminalLaunch {
            spec,
            confinement,
            guarantee_record: prepared.guarantee_record(),
            launch_digest,
            executable_path,
            executable_digest,
        })
    }

    /// Dispatch only after Guard, durable PREPARE and one-use lease admission.
    pub fn spawn_prepared(mut prepared: PreparedTerminalLaunch) -> io::Result<Self> {
        if executable_digest(&prepared.executable_path)? != prepared.executable_digest {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "terminal executable changed after confined preflight",
            ));
        }
        prepared
            .confinement
            .activate()
            .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error.to_string()))?;
        Ok(Self {
            inner: platform::Process::spawn(prepared.spec)?,
            _confinement: Some(prepared.confinement),
        })
    }

    /// Unconfined process launch retained for isolated unit fixtures only. Product callers
    /// must hold a Guarded `PreparedTerminalLaunch` from `prepare_confined`.
    #[cfg(test)]
    pub fn spawn(spec: TerminalLaunchSpec) -> io::Result<Self> {
        validate_size(spec.cols, spec.rows)?;
        Ok(Self {
            inner: platform::Process::spawn(spec)?,
            _confinement: None,
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
                "input exceeds 16 KiB",
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
    const SWEEP_MAX_ENTRIES: usize = 512;
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
    /// tree. On a normal leader exit the supervisor relays the observed wait status to
    /// the owner and then sweeps escaped descendants, keeping one-terminal-one-tree.
    ///
    /// SAFETY: this function runs in the forked child of a possibly multi-threaded
    /// owner, so it never returns and performs only async-signal-safe raw syscalls; all
    /// values it uses were prepared before the fork.
    unsafe fn supervisor_main(
        keepalive_read: RawFd,
        relay_write: RawFd,
        exec_write: RawFd,
        slave: RawFd,
        executable: *const libc::c_char,
        argv: *const *const libc::c_char,
        envp: *const *const libc::c_char,
        cwd: *const libc::c_char,
    ) -> ! {
        unsafe {
            // The supervisor owns no stdio and only the descriptors its contract needs.
            libc::close_range(0, 2, 0);
            close_except(&mut [keepalive_read, relay_write, exec_write, slave]);
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
        if let Some(status) = observed_status {
            let mut frame = [0u8; FRAME_EXIT_LEN];
            frame[0] = FRAME_EXIT;
            frame[1..5].copy_from_slice(&status.to_le_bytes());
            write_full(relay_write, &frame);
        }
        unsafe {
            supervisor_cleanup(leader, leader_start, observed_status.is_some());
            libc::_exit(0);
        }
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
    ///
    /// The supervisor is a child subreaper, so the session tree is exactly the set of
    /// processes rooted at the supervisor's direct children (`ppid == supervisor`)
    /// extended transitively. Each group signal is verified against the scanned
    /// `/proc` generation immediately beforehand so a reused PID is never signalled.
    unsafe fn supervisor_cleanup(leader: libc::pid_t, leader_start: u64, leader_reaped: bool) {
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
            let count = scan_proc(&mut entries);
            let mut marked = [false; SWEEP_MAX_ENTRIES];
            let mut changed = true;
            while changed {
                changed = false;
                for index in 0..count {
                    if marked[index] {
                        continue;
                    }
                    let parent = entries[index].1;
                    if parent == me {
                        marked[index] = true;
                        changed = true;
                        continue;
                    }
                    for candidate in 0..count {
                        if marked[candidate] && entries[candidate].0 == parent {
                            marked[index] = true;
                            changed = true;
                            break;
                        }
                    }
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
                    let verified = (0..count)
                        .find(|candidate| entries[*candidate].0 == group)
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
                break;
            }
            round += 1;
            if round < SWEEP_MAX_ROUNDS {
                sleep_millis(SWEEP_ROUND_DELAY_MS);
            }
        }
    }

    /// Enumerates `/proc` into bounded `(pid, ppid, pgrp, starttime)` entries.
    fn scan_proc(entries: &mut [(i32, i32, i32, u64); SWEEP_MAX_ENTRIES]) -> usize {
        // SAFETY: the path literal is NUL-terminated and the buffer is valid.
        let descriptor = unsafe {
            libc::open(
                c"/proc".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return 0;
        }
        let mut count = 0usize;
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
            if got <= 0 {
                break;
            }
            let end = got as usize;
            let mut offset = 0usize;
            while offset + 19 <= end && count < entries.len() {
                // struct linux_dirent64: u64 ino, i64 off, u16 reclen, u8 type, name[].
                let record_length =
                    u16::from_ne_bytes([buffer[offset + 16], buffer[offset + 17]]) as usize;
                if record_length < 20 || offset + record_length > end {
                    break;
                }
                let record = &buffer[offset + 19..offset + record_length];
                let name_length = record
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(record.len());
                if let Some(pid) = parse_uint(&record[..name_length])
                    && let Ok(pid) = u32::try_from(pid)
                    && let Some((parent, group, start)) = read_proc_fields(pid)
                {
                    entries[count] = (pid as i32, parent, group, start);
                    count += 1;
                }
                offset += record_length;
            }
            if count >= entries.len() {
                break;
            }
        }
        unsafe {
            libc::close(descriptor);
        }
        count
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
    use std::thread;
    use std::time::Instant;

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
        let prepared = TerminalProcess::prepare_confined(spec, &workspace)
            .expect("confinement required for this acceptance host");
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

    #[test]
    fn stdio_preflight_digest_is_bound_to_the_exact_guard_approved_arguments() {
        let spec_digest = format!("blake3:{}", "a".repeat(64));
        let approved = format!("blake3:{}", "b".repeat(64));
        let altered = format!("blake3:{}", "c".repeat(64));

        let expected = bind_stdio_execution_digest(&spec_digest, &approved);
        assert_eq!(
            expected,
            bind_stdio_execution_digest(&spec_digest, &approved)
        );
        assert_ne!(
            expected,
            bind_stdio_execution_digest(&spec_digest, &altered)
        );
        assert!(expected.starts_with("blake3:"));
    }

    #[test]
    fn discarding_preflight_releases_only_the_exact_unstarted_execution() {
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
        let spec = launch("touch must-not-run");
        let root = std::env::temp_dir();
        assert!(TerminalProcess::prepare_confined(spec, &root).is_err());
        assert!(!root.join("must-not-run").exists());
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
        let prepared = TerminalProcess::prepare_confined(spec, &root).unwrap();
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
}
