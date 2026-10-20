//! Durable, fail-closed executor for ToolBatch filesystem effects.
//!
//! Approval records contain only identifiers, paths, BLAKE3 digests and decisions. Write
//! content is supplied again at execution time; patch content is canonical base64 decoded
//! to exact postimage bytes. Neither is persisted.

use crate::guard;
use crate::host_kernel::managed_verifier::{
    ManagedVerifierObservedOutcomeV1, ManagedVerifierUnknownReasonV1, VerifierInvocationV1,
};
use crate::http_execution::{
    HttpExecutionBindingV1, HttpExecutionDispatchIntentV1, HttpExecutionPreparedV1,
    HttpExecutionReceiptV1, HttpExecutionRecoveryV1, HttpExecutionStateV1, HttpExecutionStatusV1,
    HttpResponseV1, MAX_HTTP_RESPONSE_BYTES,
};
use crate::messagepack::{self, FRAME_LIMITS, Value};
use crate::protocol::{
    EffectAttemptScopeV1, ErrorCategoryV1, FrameFence, MAX_BODY_BYTES, MAX_IDENTIFIER_BYTES,
    RetryClassV1, RpcOutcomeV1, RpcRequestV1, RpcResponseV1, TypedErrorV1, validate_deadline,
};
use crate::request_cancellation::RequestCancellation;
use crate::terminal_process::{
    StdioExecutionBindingV1, StdioExecutionDispatchIntentV1, StdioExecutionPreparedV1,
    StdioExecutionReceiptV1, StdioExecutionRecoveryV1, StdioExecutionStateV1,
    StdioExecutionStatusV1, StdioExecutionSupervisor,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const EFFECTS_SERVICE_ID: &str = "effects.v2";
const CHALLENGE_TTL_MS: u64 = 5 * 60 * 1000;
const MAX_WRITE_BYTES: usize = 768 * 1024;
/// Durable origin kinds. The kind is recorded when the effect is admitted and is never
/// re-derived from caller-supplied values.
const ORIGIN_SESSION_BATCH: &str = "session_batch";
const ORIGIN_USER_ACTION: &str = "user_action";
const ORIGIN_MANAGED_RUN: &str = "managed_run";
const EFFECTS_DB: &str = "effects.sqlite";
const MAX_STDIO_EXECUTIONS: usize = 128;
const MAX_STDIO_RECEIPT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_HTTP_EXECUTIONS: usize = 64;
const BOM: &[u8; 3] = b"\xef\xbb\xbf";

#[derive(Clone, Copy, Debug)]
enum Failure {
    Invalid,
    DeadlineExceeded,
    FeatureNotNegotiated,
    Denied,
    NotFound,
    Conflict,
    Unavailable,
    Unknown,
}

impl Failure {
    fn error(self) -> TypedErrorV1 {
        let (code, category, message) = match self {
            Self::Invalid => (
                "invalid_effect_request",
                ErrorCategoryV1::Validation,
                "effect request is malformed or unsupported",
            ),
            Self::DeadlineExceeded => (
                "deadline_exceeded",
                ErrorCategoryV1::Validation,
                "effect RPC deadline is expired or outside the allowed window",
            ),
            Self::FeatureNotNegotiated => (
                "feature_not_negotiated",
                ErrorCategoryV1::Capability,
                "effects.v2 was not negotiated for this connection",
            ),
            Self::Denied => (
                "effect_denied",
                ErrorCategoryV1::Authorization,
                "effect is not authorized for this workspace or approval state",
            ),
            Self::NotFound => (
                "approval_not_found",
                ErrorCategoryV1::NotFound,
                "approval challenge was not found",
            ),
            Self::Conflict => (
                "effect_conflict",
                ErrorCategoryV1::Conflict,
                "effect challenge is expired, consumed, or no longer applicable",
            ),
            Self::Unavailable => (
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "effect storage or workspace operation is unavailable",
            ),
            Self::Unknown => (
                "effect_outcome_unknown",
                ErrorCategoryV1::Uncertain,
                "effect outcome is unknown and the challenge is blocked",
            ),
        };
        TypedErrorV1 {
            code: code.to_owned(),
            category,
            message: message.to_owned(),
            retry_class: RetryClassV1::Never,
            retry_after_ms: None,
            owner_cursor: None,
            subject_ids: Vec::new(),
            details: None,
        }
    }
}

#[derive(Debug)]
struct Challenge {
    challenge_id: String,
    effect_id: String,
    session_id: String,
    principal: String,
    batch_id: String,
    call_id: String,
    capability_id: String,
    /// Durable origin kind (`session_batch` or `user_action`), recorded at admission.
    origin_kind: String,
    /// Canonical managed Attempt envelope digest, when this effect belongs to an Attempt.
    managed_attempt_digest: Option<String>,
    relative_path: String,
    requested_path: String,
    target: String,
    resource: String,
    existed: bool,
    /// Digest of the full Guard decision and its canonical argument tuple.
    argument_digest: String,
    content_digest: String,
    turn_context_digest: String,
    expires_at_ms: u64,
    status: String,
    after_digest: Option<String>,
    /// HostKernel-issued authority digest persisted before target dispatch so an
    /// authenticated Attempt receipt can be reconciled after owner restart.
    capability_lease_digest: Option<String>,
}

/// Host-only launch-specific preflight metadata. The execution handle itself remains in
/// HostKernel memory; this durable row fences stale/replayed approval and dispatch across
/// owner epochs and binds the exact backend assessment that was shown for consent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TerminalConsentPreflightRecordV1 {
    pub challenge_id: String,
    pub effect_id: String,
    pub principal: String,
    pub owner_epoch: u64,
    pub approved_arguments_digest: String,
    pub profile_digest: String,
    pub executable_digest: String,
    pub workspace_revision: String,
    pub launch_digest: String,
    pub binding_digest: String,
    pub guarantee_record: String,
}

/// The origin identity a terminal effect is admitted with. The kind is fixed by the
/// Canonical operation that admitted it and is never taken from the request body.
struct TerminalOrigin<'a> {
    kind: guard::EffectOriginKindV1,
    session_id: &'a str,
    principal: &'a str,
    batch_id: &'a str,
    call_id: &'a str,
    turn_context_digest: &'a str,
    capability_id: &'a str,
    managed_attempt_digest: Option<&'a str>,
}

struct TerminalArguments {
    cwd: String,
    relative_path: String,
    resource: String,
    digest: String,
}

#[derive(Clone, Debug)]
struct PatchTarget {
    operation: String,
    relative_path: String,
    requested_path: String,
    target: String,
    resource: String,
    existed: bool,
    requested_executable: Option<bool>,
    before_mode: Option<u32>,
    mode: Option<u32>,
    before_digest: Option<String>,
    after_digest: Option<String>,
    content_digest: Option<String>,
    content: Option<Vec<u8>>,
}

/// Bounded complete-batch admission limits. These mirror the Core streaming bounds in
/// `packages/opencode/src/session/tool-batch.ts`, so a batch the Core is willing to collect
/// is never silently widened here.
const MAX_TOOL_BATCH_CALLS: usize = 32;
const MAX_TOOL_CALL_ARGUMENT_BYTES: usize = 256 * 1024;
const MAX_TOOL_BATCH_ARGUMENT_BYTES: usize = 512 * 1024;

/// One validated, *not yet durable* member of a complete ToolBatch. Nothing in this
/// structure has been persisted or executed: every member is planned first, and the whole
/// set is written in one transaction so a denied or malformed batch leaves zero effects
/// and zero durable rows.
enum PlannedEffect {
    Write {
        requested_path: String,
        relative_path: String,
        target: String,
        resource: String,
        existed: bool,
    },
    Patch {
        targets: Vec<PatchTarget>,
    },
    Terminal {
        requested_path: String,
        relative_path: String,
        resource: String,
        digest: String,
        capability_id: String,
    },
    BrokerProcess {
        requested_path: String,
        relative_path: String,
        resource: String,
        profile_id: String,
        executable_path: String,
        executable_digest: String,
        profile_digest: String,
    },
}

/// Host-resolved binding for a broker process approval. This crate-private value has no
/// wire decoder; HostKernel builds it only from an immutable local profile and live
/// managed Run state.
pub(crate) struct BrokerProcessAuthorizationV1 {
    /// HostKernel-selected canonical capability; never decoded from a broker
    /// challenge or accepted from a model ToolBatch.
    pub(crate) capability_id: String,
    pub(crate) origin_kind: guard::EffectOriginKindV1,
    pub(crate) principal: String,
    pub(crate) user_action_id: String,
    pub(crate) call_id: String,
    pub(crate) session_id: String,
    /// Digest of the exact managed Attempt scope authorized for this broker process.
    /// Core never supplies this independently; HostKernel constructs it from the live
    /// OwnerLog snapshot and the authenticated frame fence.
    pub(crate) managed_attempt_digest: Option<String>,
    pub(crate) workspace_cwd: String,
    pub(crate) resource: String,
    pub(crate) profile_id: String,
    pub(crate) executable_path: String,
    pub(crate) executable_digest: String,
    pub(crate) profile_digest: String,
    pub(crate) argument_bundle_digest: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedRunApprovalAbortReasonV1 {
    ReviewerDenied,
    Cancelled,
    Expired,
    TransportLost,
}

struct PlannedCall {
    call_id: String,
    capability_id: String,
    challenge_id: String,
    effect_id: String,
    /// Digest of the full Guard decision and its canonical argument tuple.
    argument_digest: String,
    /// Write content digest, patch manifest digest, or terminal argument digest.
    content_digest: String,
    expires_at_ms: u64,
    managed_attempt_digest: Option<String>,
    effect: PlannedEffect,
}

/// A per-call plan either becomes a challenge or denies the complete batch.
enum PlanOutcome {
    Call(PlannedCall),
    Denied(&'static str),
}

/// The only Rust owner of guarded filesystem mutation for this supervisor process.
pub struct EffectHost {
    connection: Connection,
    execution: Option<ExecutionHost>,
}

/// Pinned workspace directory descriptor and the only filesystem mutation surface.
struct ExecutionHost {
    root: PathBuf,
    root_handle: File,
    workspace_binding: String,
}

struct ExecutionTarget {
    parent: File,
    name: CString,
    existing: Option<File>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TargetIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    links: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}
struct ExecutionLease {
    challenge_id: String,
    lease_id: String,
    managed_attempt_digest: Option<String>,
}

impl ExecutionTarget {
    fn identity(&self) -> io::Result<Option<TargetIdentity>> {
        self.existing
            .as_ref()
            .map(|file| {
                let metadata = file.metadata()?;
                Ok(TargetIdentity {
                    device: metadata.dev(),
                    inode: metadata.ino(),
                    mode: metadata.mode(),
                    links: metadata.nlink(),
                    size: metadata.size(),
                    modified_seconds: metadata.mtime(),
                    modified_nanoseconds: metadata.mtime_nsec(),
                    changed_seconds: metadata.ctime(),
                    changed_nanoseconds: metadata.ctime_nsec(),
                })
            })
            .transpose()
    }
}

impl ExecutionLease {
    fn consume(
        self,
        challenge_id: &str,
        managed_attempt_digest: Option<&str>,
    ) -> io::Result<String> {
        if self.challenge_id != challenge_id
            || self.managed_attempt_digest.as_deref() != managed_attempt_digest
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "invalid lease scope",
            ));
        }
        Ok(self.lease_id)
    }
}

impl ExecutionHost {
    fn open(path: &Path) -> Result<Self, String> {
        let root = fs::canonicalize(path)
            .map_err(|_| "workspace root cannot be canonicalized".to_owned())?;
        let root_metadata = fs::symlink_metadata(&root)
            .map_err(|_| "workspace root cannot be inspected".to_owned())?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err("workspace root must be a canonical directory".to_owned());
        }
        let root_handle =
            open_root(&root).map_err(|_| "workspace root cannot be securely opened".to_owned())?;
        let opened_metadata = root_handle
            .metadata()
            .map_err(|_| "workspace root descriptor cannot be inspected".to_owned())?;
        if opened_metadata.dev() != root_metadata.dev()
            || opened_metadata.ino() != root_metadata.ino()
        {
            return Err("workspace root changed during secure open".to_owned());
        }
        let workspace_binding =
            guard::workspace_binding(&root, opened_metadata.dev(), opened_metadata.ino());
        Ok(Self {
            root,
            root_handle,
            workspace_binding,
        })
    }
    fn root(&self) -> &Path {
        &self.root
    }
    fn workspace_binding(&self) -> &str {
        &self.workspace_binding
    }

    fn inspect(&self, relative: &Path) -> io::Result<bool> {
        let (parent, name) = open_parent(&self.root_handle, relative)?;
        inspect_target(parent.as_raw_fd(), &name)
    }

    fn prepare_write(&self, relative: &Path, existed: bool) -> io::Result<ExecutionTarget> {
        let (parent, name) = open_parent(&self.root_handle, relative)?;
        let existing = open_target_for_update(parent.as_raw_fd(), &name, existed)?;
        Ok(ExecutionTarget {
            parent,
            name,
            existing,
        })
    }

    fn write(
        &self,
        lease: ExecutionLease,
        challenge_id: &str,
        managed_attempt_digest: Option<&str>,
        target: ExecutionTarget,
        bytes: &[u8],
    ) -> io::Result<String> {
        let lease_id = lease.consume(challenge_id, managed_attempt_digest)?;
        let ExecutionTarget {
            parent,
            name,
            existing,
        } = target;
        match existing {
            Some(mut file) => {
                file.set_len(0)?;
                file.seek(SeekFrom::Start(0))?;
                file.write_all(bytes)?;
                file.sync_all()?;
            }
            None => {
                let mut file = open_new_target(parent.as_raw_fd(), &name)?;
                file.write_all(bytes)?;
                file.sync_all()?;
            }
        }
        parent.sync_all()?;
        Ok(lease_id)
    }

    fn apply_patch(
        &self,
        lease: ExecutionLease,
        challenge_id: &str,
        managed_attempt_digest: Option<&str>,
        targets: &[PatchTarget],
    ) -> io::Result<String> {
        let lease_id = lease.consume(challenge_id, managed_attempt_digest)?;
        let mut opened = Vec::with_capacity(targets.len());
        for target in targets {
            let (parent, name) = open_parent(&self.root_handle, Path::new(&target.relative_path))?;
            let existing = open_target_for_update(parent.as_raw_fd(), &name, target.existed)?;
            let actual = match existing.as_ref() {
                Some(file) => {
                    let metadata = file.metadata()?;
                    let actual_mode = metadata.mode() & 0o777;
                    if metadata.len() > 2 * 1024 * 1024
                        || metadata.mode() & 0o7000 != 0
                        || Some(actual_mode) != target.before_mode
                    {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "patch preimage mode or size changed",
                        ));
                    }
                    digest_file(file)?
                }
                None => {
                    if target.before_mode.is_some() {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "patch preimage mode changed",
                        ));
                    }
                    String::new()
                }
            };
            if actual != target.before_digest.clone().unwrap_or_default() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "patch preimage changed",
                ));
            }
            if target.operation == "write" && target.mode.is_none_or(|mode| mode & !0o777 != 0) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid patch mode",
                ));
            }
            if target.operation == "delete" && target.mode.is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "delete has a mode",
                ));
            }
            opened.push((parent, name, existing));
        }
        for (target, (parent, name, existing)) in targets.iter().zip(opened) {
            if target.operation == "delete" {
                if target.existed
                    && unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } < 0
                {
                    return Err(io::Error::last_os_error());
                }
            } else {
                let bytes = target.content.as_deref().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "missing patch content")
                })?;
                let mode = target.mode.ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "missing patch mode")
                })?;
                match existing {
                    Some(mut file) => {
                        file.set_len(0)?;
                        file.seek(SeekFrom::Start(0))?;
                        file.write_all(bytes)?;
                        file.set_permissions(fs::Permissions::from_mode(mode))?;
                        file.sync_all()?;
                    }
                    None => {
                        let mut file = open_new_target(parent.as_raw_fd(), &name)?;
                        file.write_all(bytes)?;
                        file.set_permissions(fs::Permissions::from_mode(mode))?;
                        file.sync_all()?;
                    }
                }
            }
            parent.sync_all()?;
        }
        Ok(lease_id)
    }
    fn target_mode(&self, relative: &Path) -> io::Result<u32> {
        let (parent, name) = open_parent(&self.root_handle, relative)?;
        if !inspect_target(parent.as_raw_fd(), &name)? {
            return Err(io::Error::new(io::ErrorKind::NotFound, "target is missing"));
        }
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.mode() & 0o7000 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "unsafe target mode",
            ));
        }
        Ok(metadata.mode() & 0o777)
    }

    fn read_target_bytes(&self, relative: &Path) -> io::Result<(Vec<u8>, u32)> {
        let (parent, name) = open_parent(&self.root_handle, relative)?;
        if !inspect_target(parent.as_raw_fd(), &name)? {
            return Err(io::Error::new(io::ErrorKind::NotFound, "target is missing"));
        }
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.mode() & 0o7000 != 0
            || metadata.len() > 2 * 1024 * 1024
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsafe or oversized target",
            ));
        }
        let mode = metadata.mode() & 0o777;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "oversized target",
            ));
        }
        Ok((bytes, mode))
    }
    fn digest(&self, relative: &Path) -> io::Result<String> {
        read_target_digest(&self.root_handle, relative)
    }
}

impl EffectHost {
    /// Open durable effect state and reconcile every unresolved PREPARED effect before READY.
    pub fn open(state_dir: &Path, workspace_root: Option<&Path>) -> Result<Self, String> {
        Self::open_with_recovery(state_dir, workspace_root, true)
    }

    /// Open the same durable state for a request in an already recovered owner epoch.
    /// In-flight interactive terminal grants are live and must not be reconciled as
    /// interrupted merely because another RPC opened the same Location.
    pub fn open_live(state_dir: &Path, workspace_root: Option<&Path>) -> Result<Self, String> {
        Self::open_with_recovery(state_dir, workspace_root, false)
    }

    fn open_with_recovery(
        state_dir: &Path,
        workspace_root: Option<&Path>,
        recover: bool,
    ) -> Result<Self, String> {
        let execution = workspace_root.map(ExecutionHost::open).transpose()?;
        let database_path = state_dir.join(EFFECTS_DB);
        if let Ok(metadata) = fs::symlink_metadata(&database_path)
            && (metadata.file_type().is_symlink() || !metadata.is_file())
        {
            return Err("effect database must be a regular non-symlink file".to_owned());
        }
        let connection = Connection::open(&database_path)
            .map_err(|_| "effect database could not be opened".to_owned())?;
        fs::set_permissions(&database_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "effect database permissions could not be secured".to_owned())?;
        connection
            .pragma_update(None, "journal_mode", "DELETE")
            .map_err(|_| "effect database journaling could not be configured".to_owned())?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| "effect database durability could not be configured".to_owned())?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS effect_challenges (
                    challenge_id TEXT PRIMARY KEY,
                    effect_id TEXT NOT NULL UNIQUE,
                    session_id TEXT NOT NULL,
                    principal TEXT NOT NULL DEFAULT '',
                    batch_id TEXT NOT NULL,
                    call_id TEXT NOT NULL,
                    capability_id TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    requested_path TEXT NOT NULL,
                    target TEXT NOT NULL,
                    resource TEXT NOT NULL,
                    existed INTEGER NOT NULL CHECK (existed IN (0, 1)),
                    argument_digest TEXT NOT NULL,
                    content_digest TEXT NOT NULL,
                    expires_at_ms INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    approved INTEGER,
                    after_digest TEXT,
                    lease_id TEXT,
                    receipt_digest TEXT,
                    turn_context_digest TEXT NOT NULL,
                    origin_kind TEXT NOT NULL DEFAULT 'session_batch',
                    managed_attempt_digest TEXT,
                    attempt_scope_transition_from TEXT,
                    capability_lease_digest TEXT
                );
                CREATE TABLE IF NOT EXISTS terminal_consent_preflights (
                    challenge_id TEXT PRIMARY KEY,
                    effect_id TEXT NOT NULL UNIQUE,
                    principal TEXT NOT NULL,
                    owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
                    approved_arguments_digest TEXT NOT NULL,
                    profile_digest TEXT NOT NULL,
                    executable_digest TEXT NOT NULL,
                    workspace_revision TEXT NOT NULL,
                    launch_digest TEXT NOT NULL,
                    binding_digest TEXT NOT NULL,
                    guarantee_record TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('PREPARED','CONSUMED','INVALID')),
                    created_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS patch_targets (
                    challenge_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    operation TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    requested_path TEXT NOT NULL,
                    target TEXT NOT NULL,
                    resource TEXT NOT NULL,
                    existed INTEGER NOT NULL CHECK (existed IN (0, 1)),
                    before_digest TEXT,
                    after_digest TEXT,
                    content_digest TEXT,
                    requested_executable INTEGER,
                    before_mode INTEGER,
                    mode INTEGER,
                    PRIMARY KEY (challenge_id, ordinal),
                    UNIQUE (challenge_id, relative_path)
                );
                CREATE TABLE IF NOT EXISTS terminal_runs (
                    effect_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    terminal_status TEXT,
                    exit_code INTEGER,
                    preview TEXT NOT NULL DEFAULT '',
                    output BLOB NOT NULL DEFAULT X'',
                    output_digest TEXT,
                    artifact_ref TEXT,
                    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
                    receipt_digest TEXT,
                    created_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS broker_process_bindings (
                    challenge_id TEXT PRIMARY KEY,
                    profile_id TEXT NOT NULL,
                    executable_path TEXT NOT NULL,
                    executable_digest TEXT NOT NULL,
                    profile_digest TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS stdio_executions (
                    execution_id TEXT PRIMARY KEY,
                    intent_id TEXT NOT NULL UNIQUE,
                    effect_id TEXT NOT NULL UNIQUE,
                    challenge_id TEXT NOT NULL UNIQUE,
                    principal TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    location_id TEXT NOT NULL,
                    capability_id TEXT NOT NULL,
                    capability_lease_digest TEXT NOT NULL,
                    attempt_scope_digest TEXT,
                    owner_epoch INTEGER NOT NULL,
                    generation INTEGER NOT NULL,
                    workspace_revision TEXT NOT NULL,
                    profile_ref TEXT NOT NULL,
                    profile_id TEXT NOT NULL DEFAULT '',
                    profile_revision INTEGER NOT NULL DEFAULT 0,
                    profile_digest TEXT NOT NULL DEFAULT '',
                    executable_digest TEXT NOT NULL DEFAULT '',
                    execution_digest TEXT NOT NULL,
                    confinement_record TEXT NOT NULL,
                    status TEXT NOT NULL,
                    exit_code INTEGER,
                    stdout_sequence INTEGER NOT NULL DEFAULT 0,
                    stderr_sequence INTEGER NOT NULL DEFAULT 0,
                    stdout_digest TEXT,
                    stderr_digest TEXT,
                    output_bytes INTEGER,
                    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
                    receipt_digest TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS http_executions (
                    execution_id TEXT PRIMARY KEY,
                    intent_id TEXT NOT NULL UNIQUE,
                    effect_id TEXT NOT NULL UNIQUE,
                    challenge_id TEXT NOT NULL UNIQUE,
                    principal TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    location_id TEXT NOT NULL,
                    capability_id TEXT NOT NULL,
                    capability_lease_digest TEXT NOT NULL,
                    attempt_scope_digest TEXT,
                    owner_epoch INTEGER NOT NULL,
                    generation INTEGER NOT NULL,
                    workspace_revision TEXT NOT NULL,
                    route_id TEXT NOT NULL,
                    approved_arguments_digest TEXT NOT NULL,
                    request_digest TEXT NOT NULL,
                    execution_digest TEXT NOT NULL,
                    status TEXT NOT NULL,
                    http_status INTEGER,
                    retry_after_ms INTEGER,
                    body_digest TEXT,
                    body_bytes INTEGER,
                    body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (body_truncated IN (0,1)),
                    connected_peer TEXT,
                    receipt_digest TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );",
            )
            .map_err(|_| "effect database schema could not be initialized".to_owned())?;
        for (column, declaration) in [
            ("profile_id", "TEXT NOT NULL DEFAULT ''"),
            ("profile_revision", "INTEGER NOT NULL DEFAULT 0"),
            ("profile_digest", "TEXT NOT NULL DEFAULT ''"),
            ("executable_digest", "TEXT NOT NULL DEFAULT ''"),
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('stdio_executions') WHERE name=?1",
                    [column],
                    |row| row.get(0),
                )
                .map_err(|_| "stdio execution schema could not be inspected".to_owned())?;
            if exists == 0 {
                connection
                    .execute_batch(&format!(
                        "ALTER TABLE stdio_executions ADD COLUMN {column} {declaration};"
                    ))
                    .map_err(|_| "stdio execution schema could not be upgraded".to_owned())?;
            }
        }
        let has_attempt_scope_transition_from: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('effect_challenges') WHERE name='attempt_scope_transition_from'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "effect challenge schema could not be inspected".to_owned())?;
        if has_attempt_scope_transition_from == 0 {
            connection
                .execute_batch(
                    "ALTER TABLE effect_challenges ADD COLUMN attempt_scope_transition_from TEXT;",
                )
                .map_err(|_| "effect challenge scope-transition schema could not be initialized".to_owned())?;
        }
        let has_http_approved_arguments_digest: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('http_executions') WHERE name='approved_arguments_digest'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "HTTP execution schema could not be inspected".to_owned())?;
        if has_http_approved_arguments_digest == 0 {
            connection
                .execute_batch(
                    "ALTER TABLE http_executions ADD COLUMN approved_arguments_digest TEXT NOT NULL DEFAULT '';",
                )
                .map_err(|_| "HTTP execution schema could not be upgraded".to_owned())?;
        }
        let has_turn_context_digest: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('effect_challenges') WHERE name='turn_context_digest'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "effect database schema could not be inspected".to_owned())?;
        if has_turn_context_digest == 0 {
            connection
                .execute_batch(
                    "ALTER TABLE effect_challenges ADD COLUMN turn_context_digest TEXT NOT NULL DEFAULT '';",
                )
                .map_err(|_| "effect database schema could not be upgraded".to_owned())?;
        }
        let has_principal: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('effect_challenges') WHERE name='principal'",
            [],
            |row| row.get(0),
        ).map_err(|_| "effect challenge schema could not be inspected".to_owned())?;
        if has_principal == 0 {
            connection
                .execute_batch(
                    "ALTER TABLE effect_challenges ADD COLUMN principal TEXT NOT NULL DEFAULT '';",
                )
                .map_err(|_| "effect database schema could not be upgraded".to_owned())?;
        }
        let has_origin_kind: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('effect_challenges') WHERE name='origin_kind'",
            [],
            |row| row.get(0),
        ).map_err(|_| "effect challenge schema could not be inspected".to_owned())?;
        if has_origin_kind == 0 {
            connection.execute_batch(
                "ALTER TABLE effect_challenges ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'session_batch';",
            ).map_err(|_| "effect database schema could not be upgraded".to_owned())?;
        }
        let has_managed_attempt_digest: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('effect_challenges') WHERE name='managed_attempt_digest'",
            [],
            |row| row.get(0),
        ).map_err(|_| "effect challenge schema could not be inspected".to_owned())?;
        if has_managed_attempt_digest == 0 {
            connection
                .execute_batch(
                    "ALTER TABLE effect_challenges ADD COLUMN managed_attempt_digest TEXT;",
                )
                .map_err(|_| "effect database schema could not be upgraded".to_owned())?;
        }
        let has_capability_lease_digest: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('effect_challenges') WHERE name='capability_lease_digest'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "effect challenge schema could not be inspected".to_owned())?;
        if has_capability_lease_digest == 0 {
            connection
                .execute_batch("ALTER TABLE effect_challenges ADD COLUMN capability_lease_digest TEXT;")
                .map_err(|_| "effect challenge schema could not be upgraded".to_owned())?;
        }
        for column in ["requested_executable", "before_mode", "mode"] {
            let present: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('patch_targets') WHERE name=?1",
                    [column],
                    |row| row.get(0),
                )
                .map_err(|_| "patch target schema could not be inspected".to_owned())?;
            if present == 0 {
                connection
                    .execute_batch(&format!(
                        "ALTER TABLE patch_targets ADD COLUMN {column} INTEGER;"
                    ))
                    .map_err(|_| "patch target schema could not be upgraded".to_owned())?;
            }
        }
        let mut host = Self {
            connection,
            execution,
        };
        if recover {
            host.reconcile_stdio_executions().map_err(|_| {
                "interrupted stdio execution state could not be classified safely".to_owned()
            })?;
            host.reconcile_http_executions().map_err(|_| {
                "interrupted HTTP execution state could not be classified safely".to_owned()
            })?;
            host.reconcile_prepared().map_err(|_| {
                "interrupted effect state could not be classified safely".to_owned()
            })?;
        }
        Ok(host)
    }

    /// Dispatch a request after the host owner has derived its principal from the
    /// authenticated operating-system peer. Caller payloads never supply this value.
    pub fn handle_request(
        &mut self,
        process_session_id: &str,
        principal: &str,
        request: &RpcRequestV1,
        effect_feature_enabled: bool,
        fence: &FrameFence,
    ) -> RpcResponseV1 {
        let result = if fence
            .validate_frame(request.owner_epoch, &request.process_incarnation)
            .is_err()
        {
            Err(Failure::Invalid)
        } else if request.service_id != EFFECTS_SERVICE_ID {
            Err(Failure::Invalid)
        } else if !effect_feature_enabled {
            Err(Failure::FeatureNotNegotiated)
        } else if let Err(failure) = validate_effect_request_deadline(request.deadline_unix_ms) {
            Err(failure)
        } else {
            match request.operation.as_str() {
                "prepare_tool_batch" => {
                    self.prepare_tool_batch(process_session_id, principal, &request.body)
                }
                "cancel_batch" => self.cancel_batch(process_session_id, principal, &request.body),
                "prepare_user_effect" => self.prepare_user_effect(principal, &request.body),
                "resolve_approval" => {
                    self.resolve_approval(process_session_id, principal, &request.body)
                }
                "execute_write" => self.execute_write(process_session_id, principal, &request.body),
                "execute_patch" => self.execute_patch(process_session_id, principal, &request.body),
                _ => Err(Failure::Invalid),
            }
        };
        match result {
            Ok(body) => RpcResponseV1 {
                owner_epoch: fence.owner_epoch(),
                process_incarnation: fence.process_incarnation().to_owned(),
                request_id: request.request_id.clone(),
                outcome: RpcOutcomeV1::Ok,
                owner_cursor: None,
                receipt_digest: None,
                body: Some(body),
                error: None,
            },
            Err(failure) => RpcResponseV1 {
                owner_epoch: fence.owner_epoch(),
                process_incarnation: fence.process_incarnation().to_owned(),
                request_id: request.request_id.clone(),
                outcome: RpcOutcomeV1::Error,
                owner_cursor: None,
                receipt_digest: None,
                body: None,
                error: Some(failure.error()),
            },
        }
    }

    /// Read a durable effect outcome after a caller may have lost the execute
    /// response. This never dispatches or retries an effect.
    pub fn reconcile_effect(
        &self,
        process_session_id: &str,
        principal: &str,
        effect_id: &str,
    ) -> Result<Value, TypedErrorV1> {
        let challenge = load_effect(&self.connection, effect_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        if challenge.session_id != process_session_id {
            return Err(Failure::Denied.error());
        }
        // A record written before principals were persisted cannot prove the caller's
        // authority, so reconciliation reports UNKNOWN instead of a false denial: the
        // effect is never replayed, and the row keeps its durable classification.
        if challenge.principal.is_empty() {
            return Err(Failure::Unknown.error());
        }
        if challenge.principal != principal {
            return Err(Failure::Denied.error());
        }
        if challenge.status == "UNKNOWN" || challenge.status == "PREPARED" {
            return Err(Failure::Unknown.error());
        }
        let status = match challenge.status.as_str() {
            "SETTLED" => "settled",
            "NOT_APPLIED" => "not_applied",
            "AWAITING_APPROVAL" => "awaiting_approval",
            "APPROVED" => "approved",
            "DENIED" => "denied",
            "EXPIRED" => "expired",
            "CANCELLED" => "cancelled",
            _ => return Err(Failure::Unknown.error()),
        };
        let mut fields = BTreeMap::from([
            ("status".to_owned(), Value::String(status.to_owned())),
            (
                "effectID".to_owned(),
                Value::String(challenge.effect_id.clone()),
            ),
            ("batchID".to_owned(), Value::String(challenge.batch_id.clone())),
        ]);
        if challenge.status == "SETTLED" {
            let receipt: Option<String> = self.connection.query_row(
                "SELECT receipt_digest FROM effect_challenges WHERE effect_id=?1 AND status='SETTLED'",
                [effect_id],
                |row| row.get(0),
            ).optional().map_err(|_| Failure::Unavailable.error())?;
            let receipt = receipt.ok_or_else(|| Failure::Unknown.error())?;
            fields.insert("receiptDigest".to_owned(), Value::String(receipt));
            if challenge.capability_id == guard::FILES_PATCH_ID {
                let targets = load_patch_targets(&self.connection, &challenge.challenge_id)
                    .map_err(Failure::error)?;
                if targets.is_empty() {
                    return Err(Failure::Unknown.error());
                }
                fields.insert(
                    "targets".to_owned(),
                    Value::Array(targets.iter().map(patch_target_value).collect()),
                );
            } else {
                // The durable capability binding carries the prepared operation, so a
                // terminal challenge is never reconciled as a filesystem write.
                let operation = match challenge.capability_id.as_str() {
                    guard::TERMINAL_RUN_ID => "run",
                    guard::TERMINAL_START_ID => "start",
                    _ => "write",
                };
                fields.insert(
                    "targets".to_owned(),
                    Value::Array(vec![map_value([
                        ("target", Value::String(challenge.target)),
                        ("resource", Value::String(challenge.resource)),
                        ("operation", Value::String(operation.to_owned())),
                        ("existed", Value::Bool(challenge.existed)),
                    ])]),
                );
            }
        }
        Ok(Value::Map(fields))
    }

    /// HostKernel-only cancellation primitive used to fence a complete unresolved
    /// Attempt suffix after authenticated reconciliation. The durable transaction
    /// cancels every still-APPROVED/AWAITING_APPROVAL member and reports PREPARED
    /// members separately; callers must verify the exact expected effect set before
    /// treating the result as proof that no dispatch occurred.
    pub(crate) fn cancel_batch_for_host(
        &mut self,
        process_session_id: &str,
        principal: &str,
        batch_id: &str,
    ) -> Result<Value, TypedErrorV1> {
        validate_identifier(batch_id).map_err(Failure::error)?;
        let body = map_value([
            ("sessionId", Value::String(process_session_id.to_owned())),
            ("batchId", Value::String(batch_id.to_owned())),
        ]);
        self.cancel_batch(process_session_id, principal, &body)
            .map_err(Failure::error)
    }

    /// Read the complete durable membership/status projection for one authenticated
    /// batch. This is used only to prove that a cancellation/reconciliation applies
    /// to the exact Attempt-bound effect set, never to grant dispatch authority.
    pub(crate) fn batch_effect_states_for_host(
        &self,
        process_session_id: &str,
        principal: &str,
        batch_id: &str,
    ) -> Result<Vec<(String, String)>, TypedErrorV1> {
        validate_identifier(batch_id).map_err(Failure::error)?;
        let mut statement = self.connection.prepare(
            "SELECT effect_id,status FROM effect_challenges
             WHERE batch_id=?1 AND session_id=?2 AND principal=?3 ORDER BY call_id,effect_id",
        ).map_err(|_| Failure::Unavailable.error())?;
        let rows = statement.query_map(params![batch_id, process_session_id, principal], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|_| Failure::Unavailable.error())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|_| Failure::Unavailable.error())
    }

    pub fn prepare_terminal_run(
        &mut self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        capability_lease_digest: &str,
        arguments: &Value,
        attempt_scope: Option<&EffectAttemptScopeV1>,
    ) -> Result<(), TypedErrorV1> {
        self.begin_terminal_effect(
            process_session_id,
            principal,
            challenge_id,
            arguments,
            guard::TERMINAL_RUN_ID,
            capability_lease_digest,
            attempt_scope,
        )
        .map_err(Failure::error)
    }

    pub fn prepare_terminal_start(
        &mut self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        capability_lease_digest: &str,
        arguments: &Value,
        attempt_scope: Option<&EffectAttemptScopeV1>,
    ) -> Result<(), TypedErrorV1> {
        self.begin_terminal_effect(
            process_session_id,
            principal,
            challenge_id,
            arguments,
            guard::TERMINAL_START_ID,
            capability_lease_digest,
            attempt_scope,
        )
        .map_err(Failure::error)
    }

    /// Persist a HostKernel-only, launch-specific sandbox preflight before the approval
    /// response is exposed. This binds the challenge to the exact normalized operation,
    /// owner epoch, profile/executable, workspace revision and backend assessment.
    /// Bind every terminal challenge from one admitted ToolBatch in a single durable
    /// transaction. A failed member leaves no partial host-side consent set.
    pub(crate) fn bind_terminal_consent_preflight_set(
        &mut self,
        records: &[TerminalConsentPreflightRecordV1],
    ) -> Result<(), TypedErrorV1> {
        if records.is_empty() || records.len() > MAX_TOOL_BATCH_CALLS {
            return Err(Failure::Invalid.error());
        }
        let mut challenges = HashSet::with_capacity(records.len());
        let mut effects = HashSet::with_capacity(records.len());
        for record in records {
            if record.owner_epoch == 0
                || !is_blake3_digest(&record.approved_arguments_digest)
                || !is_blake3_digest(&record.profile_digest)
                || !is_blake3_digest(&record.executable_digest)
                || !is_blake3_digest(&record.workspace_revision)
                || !is_blake3_digest(&record.launch_digest)
                || !is_blake3_digest(&record.binding_digest)
                || record.guarantee_record.is_empty()
                || record.guarantee_record.len() > 16 * 1024
                || !challenges.insert(record.challenge_id.as_str())
                || !effects.insert(record.effect_id.as_str())
            {
                return Err(Failure::Invalid.error());
            }
        }

        let now = now_ms().map_err(Failure::error)?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        for record in records {
            let challenge = load_challenge(&transaction, &record.challenge_id)
                .map_err(Failure::error)?
                .ok_or_else(|| Failure::NotFound.error())?;
            if challenge.effect_id != record.effect_id
                || challenge.principal != record.principal
                || !matches!(
                    challenge.capability_id.as_str(),
                    guard::TERMINAL_RUN_ID | guard::TERMINAL_START_ID
                )
                || challenge.argument_digest != record.approved_arguments_digest
                || challenge.status != "AWAITING_APPROVAL"
                || challenge.expires_at_ms <= now
            {
                return Err(Failure::Denied.error());
            }
            transaction
                .execute(
                    "INSERT INTO terminal_consent_preflights (
                    challenge_id,effect_id,principal,owner_epoch,approved_arguments_digest,
                    profile_digest,executable_digest,workspace_revision,launch_digest,
                    binding_digest,guarantee_record,status,created_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'PREPARED',?12)",
                    params![
                        record.challenge_id,
                        record.effect_id,
                        record.principal,
                        record.owner_epoch as i64,
                        record.approved_arguments_digest,
                        record.profile_digest,
                        record.executable_digest,
                        record.workspace_revision,
                        record.launch_digest,
                        record.binding_digest,
                        record.guarantee_record,
                        now as i64,
                    ],
                )
                .map_err(|_| Failure::Conflict.error())?;
        }
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())
    }

    /// Consume the durable preflight exactly once after the host has admitted the
    /// matching lease. A restarted owner lacks the retained launch object and cannot
    /// recreate or replay the preflight from this digest row.
    pub(crate) fn consume_terminal_consent_preflight(
        &mut self,
        expected: &TerminalConsentPreflightRecordV1,
    ) -> Result<(), TypedErrorV1> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let stored: Option<(
            String,
            String,
            String,
            i64,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
        )> = transaction
            .query_row(
                "SELECT effect_id,principal,approved_arguments_digest,owner_epoch,profile_digest,
                    executable_digest,workspace_revision,launch_digest,binding_digest,
                    guarantee_record,status
             FROM terminal_consent_preflights WHERE challenge_id=?1",
                [&expected.challenge_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?;
        let Some((
            effect_id,
            principal,
            arguments_digest,
            owner_epoch,
            profile_digest,
            executable_digest,
            workspace_revision,
            launch_digest,
            binding_digest,
            guarantee_record,
            status,
        )) = stored
        else {
            return Err(Failure::NotFound.error());
        };
        if effect_id != expected.effect_id
            || principal != expected.principal
            || arguments_digest != expected.approved_arguments_digest
            || owner_epoch != expected.owner_epoch as i64
            || profile_digest != expected.profile_digest
            || executable_digest != expected.executable_digest
            || workspace_revision != expected.workspace_revision
            || launch_digest != expected.launch_digest
            || binding_digest != expected.binding_digest
            || guarantee_record != expected.guarantee_record
            || status != "PREPARED"
        {
            return Err(Failure::Denied.error());
        }
        let updated = transaction
            .execute(
                "UPDATE terminal_consent_preflights SET status='CONSUMED'
             WHERE challenge_id=?1 AND effect_id=?2 AND status='PREPARED'",
                params![expected.challenge_id, expected.effect_id],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if updated != 1 {
            return Err(Failure::Conflict.error());
        }
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())
    }

    /// Read-only validation for a non-PTY process preflight. It consumes neither the
    /// HostKernel capability binding nor the durable effect challenge.
    pub fn authorize_execution_preflight(
        &self,
        binding: &StdioExecutionBindingV1,
        preflight: &StdioExecutionPreparedV1,
    ) -> Result<(), TypedErrorV1> {
        self.validate_execution_preflight(binding, preflight)
            .map_err(Failure::error)
    }

    /// Atomically consume the already-approved durable challenge and persist the
    /// execution intent before HostKernel consumes its ephemeral one-use binding or the
    /// supervisor can spawn. Restart reconciliation classifies this row UNKNOWN.
    pub fn begin_execution_dispatch(
        &mut self,
        binding: &StdioExecutionBindingV1,
        preflight: &StdioExecutionPreparedV1,
    ) -> Result<StdioExecutionDispatchIntentV1, TypedErrorV1> {
        self.validate_execution_preflight(binding, preflight)
            .map_err(Failure::error)?;
        let active: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM stdio_executions WHERE status IN ('PREPARED','RUNNING','CANCELLING')",
                [],
                |row| row.get(0),
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if active < 0 || active as usize >= MAX_STDIO_EXECUTIONS {
            return Err(Failure::Unavailable.error());
        }
        let intent_id = random_id("xintent").map_err(Failure::error)?;
        let now = now_ms().map_err(Failure::error)? as i64;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='PREPARED', lease_id=?1
                 WHERE challenge_id=?2 AND effect_id=?3 AND principal=?4 AND session_id=?5
                   AND capability_id=?6 AND status='APPROVED' AND expires_at_ms>?7
                   AND managed_attempt_digest IS ?8 AND argument_digest=?9",
                params![
                    intent_id,
                    binding.challenge_id,
                    binding.effect_id,
                    binding.principal,
                    binding.session_id,
                    binding.capability_id,
                    now,
                    binding.attempt_scope_digest,
                    binding.approved_arguments_digest,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::Conflict.error());
        }
        transaction
            .execute(
                "INSERT INTO stdio_executions(
                    execution_id,intent_id,effect_id,challenge_id,principal,session_id,location_id,
                    capability_id,capability_lease_digest,attempt_scope_digest,owner_epoch,generation,
                    workspace_revision,profile_ref,profile_id,profile_revision,profile_digest,executable_digest,
                    execution_digest,confinement_record,status,created_at_ms,updated_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,'PREPARED',?21,?21)",
                params![
                    binding.execution_id,
                    intent_id,
                    binding.effect_id,
                    binding.challenge_id,
                    binding.principal,
                    binding.session_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    binding.owner_epoch as i64,
                    binding.generation as i64,
                    binding.workspace_revision,
                    binding.profile_ref,
                    binding.profile_id,
                    binding.profile_revision as i64,
                    binding.profile_digest,
                    binding.executable_digest,
                    preflight.execution_digest,
                    preflight.confinement_record,
                    now,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())?;
        Ok(StdioExecutionDispatchIntentV1::new(
            binding.clone(),
            preflight.execution_digest.clone(),
            intent_id,
        ))
    }

    /// Persist that the supervisor successfully spawned the process. If this write fails,
    /// the caller must terminate the process and classify the outcome UNKNOWN.
    pub fn mark_execution_running(
        &mut self,
        binding: &StdioExecutionBindingV1,
        intent: &StdioExecutionDispatchIntentV1,
    ) -> Result<(), TypedErrorV1> {
        if intent.binding() != binding || intent.intent_id().is_empty() {
            return Err(Failure::Denied.error());
        }
        let changed = self
            .connection
            .execute(
                "UPDATE stdio_executions SET status='RUNNING',updated_at_ms=?1
                 WHERE execution_id=?2 AND intent_id=?3 AND effect_id=?4 AND principal=?5
                   AND challenge_id=?6 AND session_id=?7 AND location_id=?8 AND capability_id=?9
                   AND capability_lease_digest=?10 AND attempt_scope_digest IS ?11
                   AND owner_epoch=?12 AND generation=?13 AND workspace_revision=?14 AND profile_ref=?15
                   AND profile_id=?16 AND profile_revision=?17 AND profile_digest=?18 AND executable_digest=?19
                   AND execution_digest=?20 AND status='PREPARED'",
                params![
                    now_ms().map_err(Failure::error)? as i64,
                    binding.execution_id,
                    intent.intent_id(),
                    binding.effect_id,
                    binding.principal,
                    binding.challenge_id,
                    binding.session_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    binding.owner_epoch as i64,
                    binding.generation as i64,
                    binding.workspace_revision,
                    binding.profile_ref,
                    binding.profile_id,
                    binding.profile_revision as i64,
                    binding.profile_digest,
                    binding.executable_digest,
                    intent.execution_digest(),
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::Conflict.error());
        }
        Ok(())
    }

    pub fn mark_execution_cancelling(
        &mut self,
        binding: &StdioExecutionBindingV1,
    ) -> Result<(), TypedErrorV1> {
        let changed = self
            .connection
            .execute(
                "UPDATE stdio_executions SET status='CANCELLING',updated_at_ms=?1
                 WHERE execution_id=?2 AND effect_id=?3 AND principal=?4 AND session_id=?5
                   AND challenge_id=?6 AND location_id=?7 AND capability_id=?8
                   AND capability_lease_digest=?9 AND attempt_scope_digest IS ?10
                   AND owner_epoch=?11 AND generation=?12 AND workspace_revision=?13 AND profile_ref=?14
                   AND profile_id=?15 AND profile_revision=?16 AND profile_digest=?17 AND executable_digest=?18
                   AND status IN ('RUNNING','CANCELLING')",
                params![
                    now_ms().map_err(Failure::error)? as i64,
                    binding.execution_id,
                    binding.effect_id,
                    binding.principal,
                    binding.session_id,
                    binding.challenge_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    binding.owner_epoch as i64,
                    binding.generation as i64,
                    binding.workspace_revision,
                    binding.profile_ref,
                    binding.profile_id,
                    binding.profile_revision as i64,
                    binding.profile_digest,
                    binding.executable_digest,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::Conflict.error());
        }
        Ok(())
    }

    /// Settle only an observed process exit. The receipt is content addressed and durable;
    /// callers cannot report successful completion from child output or model self-report.
    pub fn settle_execution(
        &mut self,
        binding: &StdioExecutionBindingV1,
        observation: &StdioExecutionStatusV1,
    ) -> Result<StdioExecutionReceiptV1, TypedErrorV1> {
        if observation.execution_id != binding.execution_id
            || observation.generation != binding.generation
            || observation.state != StdioExecutionStateV1::Exited
            || !is_blake3_digest(&observation.stdout_digest)
            || !is_blake3_digest(&observation.stderr_digest)
            || observation.output_bytes > MAX_STDIO_RECEIPT_BYTES
        {
            return Err(Failure::Invalid.error());
        }
        let challenge = load_effect(&self.connection, &binding.effect_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        self.require_stdio_binding(binding, &challenge)
            .map_err(Failure::error)?;
        if challenge.status != "PREPARED" {
            return Err(Failure::Unknown.error());
        }
        let execution_digest: String = self
            .connection
            .query_row(
                "SELECT execution_digest FROM stdio_executions
                 WHERE execution_id=?1 AND effect_id=?2 AND challenge_id=?3 AND principal=?4
                   AND session_id=?5 AND location_id=?6 AND capability_id=?7
                   AND capability_lease_digest=?8 AND attempt_scope_digest IS ?9
                   AND owner_epoch=?10 AND generation=?11 AND workspace_revision=?12
                   AND profile_ref=?13 AND profile_id=?14 AND profile_revision=?15
                   AND profile_digest=?16 AND executable_digest=?17",
                params![
                    binding.execution_id,
                    binding.effect_id,
                    binding.challenge_id,
                    binding.principal,
                    binding.session_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    binding.owner_epoch as i64,
                    binding.generation as i64,
                    binding.workspace_revision,
                    binding.profile_ref,
                    binding.profile_id,
                    binding.profile_revision as i64,
                    binding.profile_digest,
                    binding.executable_digest,
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::Unknown.error())?;
        let receipt_digest = digest_bytes(
            format!(
                "horizoncode.stdio.receipt.v1:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
                binding.execution_id,
                binding.effect_id,
                binding.generation,
                binding.profile_id,
                binding.profile_revision,
                binding.profile_digest,
                binding.executable_digest,
                execution_digest,
                binding.approved_arguments_digest,
                observation
                    .exit_code
                    .map_or_else(|| "none".to_owned(), |code| code.to_string()),
                observation.stdout_sequence,
                observation.stderr_sequence,
                observation.stdout_digest,
                observation.stderr_digest,
                observation.output_bytes,
                observation.truncated,
            )
            .as_bytes(),
        );
        let now = now_ms().map_err(Failure::error)? as i64;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let changed = transaction
            .execute(
                "UPDATE stdio_executions SET status='SETTLED',exit_code=?1,stdout_sequence=?2,
                    stderr_sequence=?3,stdout_digest=?4,stderr_digest=?5,output_bytes=?6,
                    truncated=?7,receipt_digest=?8,updated_at_ms=?9
                 WHERE execution_id=?10 AND effect_id=?11 AND challenge_id=?12 AND principal=?13
                   AND session_id=?14 AND location_id=?15 AND capability_id=?16
                   AND capability_lease_digest=?17 AND attempt_scope_digest IS ?18
                   AND owner_epoch=?19 AND generation=?20 AND workspace_revision=?21
                   AND profile_ref=?22 AND profile_id=?23 AND profile_revision=?24
                   AND profile_digest=?25 AND executable_digest=?26
                   AND execution_digest=?27 AND status IN ('RUNNING','CANCELLING')",
                params![
                    observation.exit_code,
                    observation.stdout_sequence as i64,
                    observation.stderr_sequence as i64,
                    observation.stdout_digest,
                    observation.stderr_digest,
                    observation.output_bytes as i64,
                    observation.truncated as i64,
                    receipt_digest,
                    now,
                    binding.execution_id,
                    binding.effect_id,
                    binding.challenge_id,
                    binding.principal,
                    binding.session_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    binding.owner_epoch as i64,
                    binding.generation as i64,
                    binding.workspace_revision,
                    binding.profile_ref,
                    binding.profile_id,
                    binding.profile_revision as i64,
                    binding.profile_digest,
                    binding.executable_digest,
                    execution_digest,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::Unknown.error());
        }
        let challenge_changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='SETTLED',receipt_digest=?1
                 WHERE challenge_id=?2 AND effect_id=?3 AND status='PREPARED'",
                params![receipt_digest, binding.challenge_id, binding.effect_id],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if challenge_changed != 1 {
            return Err(Failure::Unknown.error());
        }
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())?;
        Ok(StdioExecutionReceiptV1 {
            execution_id: binding.execution_id.clone(),
            effect_id: binding.effect_id.clone(),
            generation: binding.generation,
            profile_id: binding.profile_id.clone(),
            profile_revision: binding.profile_revision,
            profile_digest: binding.profile_digest.clone(),
            executable_digest: binding.executable_digest.clone(),
            exit_code: observation.exit_code,
            stdout_sequence: observation.stdout_sequence,
            stderr_sequence: observation.stderr_sequence,
            stdout_digest: observation.stdout_digest.clone(),
            stderr_digest: observation.stderr_digest.clone(),
            output_bytes: observation.output_bytes,
            truncated: observation.truncated,
            receipt_digest,
        })
    }

    /// Classify any ambiguous dispatch or owner-loss result without allowing relaunch.
    pub fn mark_execution_unknown(
        &mut self,
        binding: &StdioExecutionBindingV1,
    ) -> Result<(), TypedErrorV1> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let changed = transaction
            .execute(
                "UPDATE stdio_executions SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND effect_id=?3 AND challenge_id=?4 AND principal=?5 AND session_id=?6
                   AND location_id=?7 AND capability_id=?8 AND capability_lease_digest=?9
                   AND attempt_scope_digest IS ?10 AND owner_epoch=?11 AND generation=?12
                   AND workspace_revision=?13 AND profile_ref=?14 AND profile_id=?15
                   AND profile_revision=?16 AND profile_digest=?17 AND executable_digest=?18
                   AND status IN ('PREPARED','RUNNING','CANCELLING','UNKNOWN')",
                params![
                    now_ms().map_err(Failure::error)? as i64,
                    binding.execution_id,
                    binding.effect_id,
                    binding.challenge_id,
                    binding.principal,
                    binding.session_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    binding.owner_epoch as i64,
                    binding.generation as i64,
                    binding.workspace_revision,
                    binding.profile_ref,
                    binding.profile_id,
                    binding.profile_revision as i64,
                    binding.profile_digest,
                    binding.executable_digest,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::NotFound.error());
        }
        let challenge_changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='UNKNOWN'
                 WHERE challenge_id=?1 AND effect_id=?2 AND status IN ('PREPARED','RUNNING','CANCELLING','UNKNOWN')",
                params![binding.challenge_id, binding.effect_id],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if challenge_changed != 1 {
            return Err(Failure::Unknown.error());
        }
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())
    }

    pub fn execution_status(
        &self,
        binding: &StdioExecutionBindingV1,
    ) -> Result<StdioExecutionStatusV1, TypedErrorV1> {
        let row = self
            .connection
            .query_row(
                "SELECT principal,session_id,location_id,capability_id,capability_lease_digest,
                        attempt_scope_digest,owner_epoch,generation,status,stdout_sequence,stderr_sequence,exit_code,
                        workspace_revision,profile_ref,stdout_digest,stderr_digest,output_bytes,truncated,receipt_digest,
                        profile_id,profile_revision,profile_digest,executable_digest
                 FROM stdio_executions WHERE execution_id=?1 AND effect_id=?2 AND challenge_id=?3",
                params![binding.execution_id, binding.effect_id, binding.challenge_id],
                |row| Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?, row.get::<_, i64>(7)?, row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?, row.get::<_, i64>(10)?, row.get::<_, Option<i32>>(11)?,
                    row.get::<_, String>(12)?, row.get::<_, String>(13)?,
                    row.get::<_, Option<String>>(14)?, row.get::<_, Option<String>>(15)?,
                    row.get::<_, Option<i64>>(16)?, row.get::<_, i64>(17)?,
                    row.get::<_, Option<String>>(18)?,
                    row.get::<_, String>(19)?, row.get::<_, i64>(20)?,
                    row.get::<_, String>(21)?, row.get::<_, String>(22)?,
                )),
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::NotFound.error())?;
        if row.0 != binding.principal
            || row.1 != binding.session_id
            || row.2 != binding.location_id
            || row.3 != binding.capability_id
            || row.4 != binding.capability_lease_digest
            || row.5 != binding.attempt_scope_digest
            || row.6 as u64 != binding.owner_epoch
            || row.7 as u64 != binding.generation
            || row.12 != binding.workspace_revision
            || row.13 != binding.profile_ref
            || row.19 != binding.profile_id
            || row.20 as u64 != binding.profile_revision
            || row.21 != binding.profile_digest
            || row.22 != binding.executable_digest
        {
            return Err(Failure::Denied.error());
        }
        let challenge = load_effect(&self.connection, &binding.effect_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        self.require_stdio_binding(binding, &challenge)
            .map_err(Failure::error)?;
        let state = parse_stdio_state(&row.8).ok_or_else(|| Failure::Unknown.error())?;
        Ok(StdioExecutionStatusV1 {
            execution_id: binding.execution_id.clone(),
            generation: binding.generation,
            state,
            stdout_sequence: u64::try_from(row.9).map_err(|_| Failure::Unknown.error())?,
            stderr_sequence: u64::try_from(row.10).map_err(|_| Failure::Unknown.error())?,
            exit_code: row.11,
            stdout_digest: row
                .14
                .unwrap_or_else(|| format!("blake3:{}", blake3::hash(b"").to_hex())),
            stderr_digest: row
                .15
                .unwrap_or_else(|| format!("blake3:{}", blake3::hash(b"").to_hex())),
            output_bytes: row
                .16
                .and_then(|bytes| u64::try_from(bytes).ok())
                .unwrap_or(0),
            truncated: row.17 != 0,
            duration_ms: 0,
            receipt_digest: row.18,
        })
    }

    /// Execute one opaque, HostKernel-minted managed verifier invocation through the
    /// exact Guard challenge, durable one-use dispatch intent, and confined stdio
    /// supervisor. No caller command strings or approval identities are accepted here.
    pub(crate) fn execute_managed_verifier(
        &mut self,
        invocation: &VerifierInvocationV1,
        supervisor: &mut StdioExecutionSupervisor,
        cancellation: Option<&RequestCancellation>,
    ) -> Result<ManagedVerifierObservedOutcomeV1, TypedErrorV1> {
        self.validate_managed_verifier_invocation(invocation, true)?;
        if cancellation.is_some_and(RequestCancellation::is_cancelled) {
            return Err(Failure::Conflict.error());
        }

        let binding = invocation.stdio_binding().clone();
        let prepared = supervisor
            .preflight(binding.clone(), invocation.stdio_launch_spec().clone())
            .map_err(|_| Failure::Unavailable.error())?;
        if let Err(error) = self.authorize_execution_preflight(&binding, &prepared) {
            let _ = supervisor.discard_preflight(&binding);
            return Err(error);
        }
        let intent = match self.begin_execution_dispatch(&binding, &prepared) {
            Ok(intent) => intent,
            Err(error) => {
                let _ = supervisor.discard_preflight(&binding);
                return Err(error);
            }
        };

        let launched = match supervisor.launch(intent.clone()) {
            Ok(status) => status,
            Err(_) => {
                let _ = supervisor.mark_unknown(&binding);
                self.mark_execution_unknown(&binding)?;
                return ManagedVerifierObservedOutcomeV1::unknown(
                    invocation,
                    ManagedVerifierUnknownReasonV1::DispatchAmbiguous,
                );
            }
        };
        if self.mark_execution_running(&binding, &intent).is_err() {
            let _ = supervisor.cancel(&binding);
            let _ = supervisor.mark_unknown(&binding);
            self.mark_execution_unknown(&binding)?;
            return ManagedVerifierObservedOutcomeV1::unknown(
                invocation,
                ManagedVerifierUnknownReasonV1::DispatchAmbiguous,
            );
        }

        let mut stdout_sequence = launched.stdout_sequence;
        let mut stderr_sequence = launched.stderr_sequence;
        let mut cancellation_started: Option<Instant> = None;
        loop {
            if cancellation.is_some_and(RequestCancellation::is_cancelled) {
                let _ = self.mark_execution_cancelling(&binding);
                let _ = supervisor.cancel(&binding);
                let status = supervisor
                    .mark_unknown(&binding)
                    .map_err(|_| Failure::Unknown.error())?;
                self.mark_execution_unknown(&binding)?;
                return ManagedVerifierObservedOutcomeV1::from_status(
                    invocation,
                    status,
                    None,
                    None,
                    Some(ManagedVerifierUnknownReasonV1::CancelledAfterDispatch),
                );
            }

            // Reading bounded pages drives pipe draining and causes the supervisor to
            // enforce its host-side deadline. Captured evidence remains separately
            // bounded and is transferred exactly once after observed exit.
            match supervisor.read_output(&binding, stdout_sequence, stderr_sequence, 64 * 1024) {
                Ok(page) => {
                    stdout_sequence = page.next_stdout_sequence;
                    stderr_sequence = page.next_stderr_sequence;
                }
                Err(_) => {
                    let _ = supervisor.mark_unknown(&binding);
                    self.mark_execution_unknown(&binding)?;
                    return ManagedVerifierObservedOutcomeV1::unknown(
                        invocation,
                        ManagedVerifierUnknownReasonV1::ProcessLost,
                    );
                }
            }

            let status = match supervisor.status(&binding) {
                Ok(status) => status,
                Err(_) => {
                    let _ = supervisor.mark_unknown(&binding);
                    self.mark_execution_unknown(&binding)?;
                    return ManagedVerifierObservedOutcomeV1::unknown(
                        invocation,
                        ManagedVerifierUnknownReasonV1::ProcessLost,
                    );
                }
            };
            match status.state {
                StdioExecutionStateV1::Exited => {
                    let output = match supervisor.take_observed_output(&binding) {
                        Ok(output) => output,
                        Err(_) => {
                            // The child was observed, but its one-use bytes could not be
                            // retained. Do not settle fabricated evidence or replay.
                            self.mark_execution_unknown(&binding)?;
                            return ManagedVerifierObservedOutcomeV1::unknown(
                                invocation,
                                ManagedVerifierUnknownReasonV1::ReceiptUnavailable,
                            );
                        }
                    };
                    let receipt = match self.settle_execution(&binding, &status) {
                        Ok(receipt) => receipt,
                        Err(_) => {
                            self.mark_execution_unknown(&binding)?;
                            return ManagedVerifierObservedOutcomeV1::unknown(
                                invocation,
                                ManagedVerifierUnknownReasonV1::ReceiptUnavailable,
                            );
                        }
                    };
                    let mut settled_status = status;
                    settled_status.receipt_digest = Some(receipt.receipt_digest.clone());
                    return ManagedVerifierObservedOutcomeV1::from_status(
                        invocation,
                        settled_status,
                        Some(output),
                        Some(receipt),
                        None,
                    );
                }
                StdioExecutionStateV1::Unknown => {
                    self.mark_execution_unknown(&binding)?;
                    return ManagedVerifierObservedOutcomeV1::from_status(
                        invocation,
                        status,
                        None,
                        None,
                        Some(ManagedVerifierUnknownReasonV1::ProcessLost),
                    );
                }
                StdioExecutionStateV1::Cancelling => {
                    let since = cancellation_started.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_secs(2) {
                        let status = supervisor
                            .mark_unknown(&binding)
                            .map_err(|_| Failure::Unknown.error())?;
                        self.mark_execution_unknown(&binding)?;
                        return ManagedVerifierObservedOutcomeV1::from_status(
                            invocation,
                            status,
                            None,
                            None,
                            Some(ManagedVerifierUnknownReasonV1::ProcessLost),
                        );
                    }
                }
                StdioExecutionStateV1::Prepared | StdioExecutionStateV1::Running => {}
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Reconcile only an invocation already durably bound to the same challenge.
    /// Recovery never launches. UNKNOWN stays UNKNOWN; settled rows without retained
    /// output cannot be promoted into verifier evidence after restart.
    pub(crate) fn reconcile_managed_verifier(
        &mut self,
        invocation: &VerifierInvocationV1,
    ) -> Result<ManagedVerifierObservedOutcomeV1, TypedErrorV1> {
        self.validate_managed_verifier_invocation(invocation, false)?;
        let status = self.execution_status(invocation.stdio_binding())?;
        match status.state {
            StdioExecutionStateV1::Unknown => ManagedVerifierObservedOutcomeV1::from_status(
                invocation,
                status,
                None,
                None,
                Some(ManagedVerifierUnknownReasonV1::ProcessLost),
            ),
            StdioExecutionStateV1::Exited => ManagedVerifierObservedOutcomeV1::unknown(
                invocation,
                ManagedVerifierUnknownReasonV1::ReceiptUnavailable,
            ),
            StdioExecutionStateV1::Prepared
            | StdioExecutionStateV1::Running
            | StdioExecutionStateV1::Cancelling => {
                // A process handle from a prior owner cannot be recovered or relaunched.
                self.mark_execution_unknown(invocation.stdio_binding())?;
                ManagedVerifierObservedOutcomeV1::unknown(
                    invocation,
                    ManagedVerifierUnknownReasonV1::ProcessLost,
                )
            }
        }
    }

    /// Cancel only the process already bound to this opaque verifier invocation.
    /// Cancellation is a durable UNKNOWN fence; it never returns partial bytes as
    /// evidence and never allows another dispatch with the same lease.
    pub(crate) fn cancel_managed_verifier(
        &mut self,
        invocation: &VerifierInvocationV1,
        supervisor: &mut StdioExecutionSupervisor,
    ) -> Result<ManagedVerifierObservedOutcomeV1, TypedErrorV1> {
        self.validate_managed_verifier_invocation(invocation, false)?;
        let binding = invocation.stdio_binding();
        let status = self.execution_status(binding)?;
        match status.state {
            StdioExecutionStateV1::Unknown => ManagedVerifierObservedOutcomeV1::from_status(
                invocation,
                status,
                None,
                None,
                Some(ManagedVerifierUnknownReasonV1::CancelledAfterDispatch),
            ),
            StdioExecutionStateV1::Exited => ManagedVerifierObservedOutcomeV1::unknown(
                invocation,
                ManagedVerifierUnknownReasonV1::ReceiptUnavailable,
            ),
            StdioExecutionStateV1::Prepared
            | StdioExecutionStateV1::Running
            | StdioExecutionStateV1::Cancelling => {
                if matches!(
                    status.state,
                    StdioExecutionStateV1::Running | StdioExecutionStateV1::Cancelling
                ) {
                    let _ = self.mark_execution_cancelling(binding);
                }
                let _ = supervisor.cancel(binding);
                let observed = supervisor.mark_unknown(binding).ok();
                self.mark_execution_unknown(binding)?;
                match observed {
                    Some(status) => ManagedVerifierObservedOutcomeV1::from_status(
                        invocation,
                        status,
                        None,
                        None,
                        Some(ManagedVerifierUnknownReasonV1::CancelledAfterDispatch),
                    ),
                    None => ManagedVerifierObservedOutcomeV1::unknown(
                        invocation,
                        ManagedVerifierUnknownReasonV1::CancelledAfterDispatch,
                    ),
                }
            }
        }
    }

    fn validate_managed_verifier_invocation(
        &self,
        invocation: &VerifierInvocationV1,
        require_approved: bool,
    ) -> Result<(), TypedErrorV1> {
        let binding = invocation.stdio_binding();
        if !invocation.validate_digest()
            || binding.capability_id != guard::BUILTIN_VERIFIER_ID
            || binding.principal != invocation.reviewer_principal()
            || binding.profile_ref != invocation.profile_id()
            || binding.workspace_revision != invocation.final_revision()
            || binding.owner_epoch != invocation.owner_epoch()
            || binding.location_id != invocation.location_id()
        {
            return Err(Failure::Denied.error());
        }
        let challenge = load_effect(&self.connection, invocation.effect_id())
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        self.require_stdio_binding(binding, &challenge)
            .map_err(Failure::error)?;
        if challenge.capability_id != guard::BUILTIN_VERIFIER_ID
            || challenge.origin_kind != ORIGIN_MANAGED_RUN
            || challenge.call_id != invocation.criterion_id()
            || challenge.principal != invocation.reviewer_principal()
            || challenge.argument_digest != invocation.approved_arguments_digest()
            || challenge.content_digest != invocation.canonical_arguments_digest()
        {
            return Err(Failure::Denied.error());
        }
        let profile = load_broker_process_binding(&self.connection, &challenge.challenge_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::Denied.error())?;
        let status_allowed = if require_approved {
            challenge.status == "APPROVED"
        } else {
            matches!(
                challenge.status.as_str(),
                "APPROVED" | "PREPARED" | "RUNNING" | "CANCELLING" | "SETTLED" | "UNKNOWN"
            )
        };
        if !status_allowed
            || (require_approved && challenge.expires_at_ms <= now_ms().map_err(Failure::error)?)
            || profile.profile_id != invocation.profile_id()
            || profile.profile_digest != invocation.profile_digest()
            || profile.executable_digest != invocation.executable_digest()
            || profile.executable_path != invocation.executable_path().to_string_lossy()
            || (require_approved
                && self
                    .validate_stdio_profile_executable(binding, &challenge)
                    .is_err())
        {
            return Err(Failure::Denied.error());
        }
        Ok(())
    }

    /// Recover only an owner-loss outcome. Identity comes from the authenticated HostKernel
    /// adapter; every returned scope fact is loaded from the durable row, never request data.
    /// A missing row is NotFound; PREPARED/RUNNING after restart is normalized to UNKNOWN by
    /// `open()` before this method is reachable.
    pub fn reconcile_execution(
        &self,
        execution_id: &str,
        effect_id: &str,
        challenge_id: &str,
        principal: &str,
        location_id: &str,
    ) -> Result<StdioExecutionRecoveryV1, TypedErrorV1> {
        for value in [
            execution_id,
            effect_id,
            challenge_id,
            principal,
            location_id,
        ] {
            validate_identifier(value).map_err(Failure::error)?;
        }
        let row = self
            .connection
            .query_row(
                "SELECT e.effect_id,e.challenge_id,e.principal,e.session_id,e.location_id,
                        e.capability_id,e.capability_lease_digest,e.attempt_scope_digest,
                        e.owner_epoch,e.generation,e.workspace_revision,e.profile_ref,e.status,
                        e.stdout_sequence,e.stderr_sequence,e.exit_code,e.stdout_digest,e.stderr_digest,
                        e.output_bytes,e.truncated,e.receipt_digest,c.argument_digest,c.status,
                        e.profile_id,e.profile_revision,e.profile_digest,e.executable_digest
                 FROM stdio_executions e JOIN effect_challenges c ON c.challenge_id=e.challenge_id
                 WHERE e.execution_id=?1 AND e.effect_id=?2 AND e.challenge_id=?3
                   AND e.principal=?4 AND e.location_id=?5",
                params![execution_id, effect_id, challenge_id, principal, location_id],
                |row| Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?, row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?, row.get::<_, i64>(9)?, row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?, row.get::<_, String>(12)?, row.get::<_, i64>(13)?,
                    row.get::<_, i64>(14)?, row.get::<_, Option<i32>>(15)?,
                    row.get::<_, Option<String>>(16)?, row.get::<_, Option<String>>(17)?,
                    row.get::<_, Option<i64>>(18)?, row.get::<_, i64>(19)?,
                    row.get::<_, Option<String>>(20)?, row.get::<_, String>(21)?,
                    row.get::<_, String>(22)?,
                    row.get::<_, String>(23)?, row.get::<_, i64>(24)?,
                    row.get::<_, String>(25)?, row.get::<_, String>(26)?,
                )),
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::NotFound.error())?;
        if row.0 != effect_id
            || row.1 != challenge_id
            || row.2 != principal
            || row.4 != location_id
            || row.5 != guard::TERMINAL_RUN_ID
            || row.8 <= 0
            || row.9 <= 0
            || !is_blake3_digest(&row.6)
            || row
                .7
                .as_deref()
                .is_some_and(|digest| !is_blake3_digest(digest))
            || !is_blake3_digest(&row.10)
            || row.23.is_empty()
            || row.24 <= 0
            || !is_blake3_digest(&row.25)
            || !is_blake3_digest(&row.26)
            || !is_blake3_digest(&row.21)
            || row
                .18
                .is_some_and(|bytes| bytes < 0 || bytes as u64 > MAX_STDIO_RECEIPT_BYTES as u64)
        {
            return Err(Failure::Denied.error());
        }
        let state = match (row.12.as_str(), row.22.as_str()) {
            ("UNKNOWN", "UNKNOWN") => StdioExecutionStateV1::Unknown,
            ("SETTLED", "SETTLED")
                if row.20.as_deref().is_some_and(is_blake3_digest)
                    && row.16.as_deref().is_some_and(is_blake3_digest)
                    && row.17.as_deref().is_some_and(is_blake3_digest) =>
            {
                StdioExecutionStateV1::Exited
            }
            _ => return Err(Failure::Unknown.error()),
        };
        let binding = StdioExecutionBindingV1 {
            execution_id: execution_id.to_owned(),
            effect_id: row.0,
            challenge_id: row.1,
            principal: row.2,
            session_id: row.3,
            location_id: row.4,
            capability_id: row.5,
            capability_lease_digest: row.6,
            attempt_scope_digest: row.7,
            owner_epoch: row.8 as u64,
            generation: row.9 as u64,
            workspace_revision: row.10,
            profile_ref: row.11,
            profile_id: row.23,
            profile_revision: row.24 as u64,
            profile_digest: row.25,
            executable_digest: row.26,
            approved_arguments_digest: row.21,
        };
        let status = StdioExecutionStatusV1 {
            execution_id: execution_id.to_owned(),
            generation: binding.generation,
            state,
            stdout_sequence: u64::try_from(row.13).map_err(|_| Failure::Unknown.error())?,
            stderr_sequence: u64::try_from(row.14).map_err(|_| Failure::Unknown.error())?,
            exit_code: row.15,
            stdout_digest: row
                .16
                .unwrap_or_else(|| format!("blake3:{}", blake3::hash(b"").to_hex())),
            stderr_digest: row
                .17
                .unwrap_or_else(|| format!("blake3:{}", blake3::hash(b"").to_hex())),
            output_bytes: row
                .18
                .and_then(|bytes| u64::try_from(bytes).ok())
                .unwrap_or(0),
            truncated: row.19 != 0,
            duration_ms: 0,
            receipt_digest: row.20,
        };
        Ok(StdioExecutionRecoveryV1 { binding, status })
    }

    /// Read-only validation for a single allowlisted outbound HTTP call. The request
    /// digest and EffectHost challenge must be the same values approved by Guard.
    pub fn authorize_http_preflight(
        &self,
        binding: &HttpExecutionBindingV1,
        preflight: &HttpExecutionPreparedV1,
    ) -> Result<(), TypedErrorV1> {
        self.validate_http_preflight(binding, preflight)
            .map_err(Failure::error)
    }

    /// Spend the approved HTTP challenge and persist a durable intent before any
    /// network bytes are sent. After this transaction, ambiguity is UNKNOWN and can
    /// never be retried using the same lease.
    pub fn begin_http_dispatch(
        &mut self,
        binding: &HttpExecutionBindingV1,
        preflight: &HttpExecutionPreparedV1,
    ) -> Result<HttpExecutionDispatchIntentV1, TypedErrorV1> {
        self.validate_http_preflight(binding, preflight)
            .map_err(Failure::error)?;
        let active: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM http_executions WHERE status IN ('PREPARED','RUNNING')",
                [],
                |row| row.get(0),
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if active < 0 || active as usize >= MAX_HTTP_EXECUTIONS {
            return Err(Failure::Unavailable.error());
        }
        let owner_epoch =
            i64::try_from(binding.owner_epoch).map_err(|_| Failure::Invalid.error())?;
        let generation = i64::try_from(binding.generation).map_err(|_| Failure::Invalid.error())?;
        let intent_id = random_id("hintent").map_err(Failure::error)?;
        let now = now_ms().map_err(Failure::error)? as i64;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='PREPARED',lease_id=?1
                 WHERE challenge_id=?2 AND effect_id=?3 AND principal=?4 AND session_id=?5
                   AND capability_id=?6 AND status='APPROVED' AND expires_at_ms>?7
                   AND managed_attempt_digest IS ?8 AND argument_digest=?9",
                params![
                    intent_id,
                    binding.challenge_id,
                    binding.effect_id,
                    binding.principal,
                    binding.session_id,
                    binding.capability_id,
                    now,
                    binding.attempt_scope_digest,
                    binding.approved_arguments_digest,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::Conflict.error());
        }
        transaction
            .execute(
                "INSERT INTO http_executions(
                    execution_id,intent_id,effect_id,challenge_id,principal,session_id,location_id,
                    capability_id,capability_lease_digest,attempt_scope_digest,owner_epoch,generation,
                    workspace_revision,route_id,approved_arguments_digest,request_digest,execution_digest,status,created_at_ms,updated_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'PREPARED',?18,?18)",
                params![
                    binding.execution_id,
                    intent_id,
                    binding.effect_id,
                    binding.challenge_id,
                    binding.principal,
                    binding.session_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    owner_epoch,
                    generation,
                    binding.workspace_revision,
                    binding.route_id,
                    binding.approved_arguments_digest,
                    binding.request_digest,
                    preflight.execution_digest,
                    now,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())?;
        Ok(HttpExecutionDispatchIntentV1::new(
            binding.clone(),
            preflight.execution_digest.clone(),
            intent_id,
        ))
    }

    /// Mark the exact committed intent as network-dispatching. The transport must not
    /// send before this succeeds.
    pub fn mark_http_running(
        &mut self,
        binding: &HttpExecutionBindingV1,
        intent: &HttpExecutionDispatchIntentV1,
    ) -> Result<(), TypedErrorV1> {
        if intent.binding() != binding || intent.intent_id().is_empty() {
            return Err(Failure::Denied.error());
        }
        let changed = self
            .connection
            .execute(
                "UPDATE http_executions SET status='RUNNING',updated_at_ms=?1
                 WHERE execution_id=?2 AND intent_id=?3 AND effect_id=?4 AND challenge_id=?5
                   AND principal=?6 AND session_id=?7 AND location_id=?8 AND capability_id=?9
                   AND capability_lease_digest=?10 AND attempt_scope_digest IS ?11
                   AND owner_epoch=?12 AND generation=?13 AND workspace_revision=?14
                   AND route_id=?15 AND approved_arguments_digest=?16 AND request_digest=?17
                   AND execution_digest=?18 AND status='PREPARED'",
                params![
                    now_ms().map_err(Failure::error)? as i64,
                    binding.execution_id,
                    intent.intent_id(),
                    binding.effect_id,
                    binding.challenge_id,
                    binding.principal,
                    binding.session_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    binding.owner_epoch as i64,
                    binding.generation as i64,
                    binding.workspace_revision,
                    binding.route_id,
                    binding.approved_arguments_digest,
                    binding.request_digest,
                    intent.execution_digest(),
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::Conflict.error());
        }
        Ok(())
    }

    /// Persist a completed HTTP response as a bounded receipt. Response bytes remain in
    /// the in-memory RPC result and are never stored in the durable effect database.
    pub fn settle_http_execution(
        &mut self,
        binding: &HttpExecutionBindingV1,
        response: &HttpResponseV1,
    ) -> Result<HttpExecutionReceiptV1, TypedErrorV1> {
        let challenge = load_effect(&self.connection, &binding.effect_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        self.require_http_binding(binding, &challenge)
            .map_err(Failure::error)?;
        if !(100..=599).contains(&response.status)
            || !is_blake3_digest(&response.body_digest)
            || response.body.len() > MAX_HTTP_RESPONSE_BYTES
            || !crate::http_execution::is_public_unicast(response.connected_peer)
            || response
                .retry_after_ms
                .is_some_and(|delay| delay > crate::http_execution::MAX_RETRY_AFTER_MS)
            || response.body_truncated == response.response_complete
        {
            return Err(Failure::Invalid.error());
        }
        let body_digest = format!("blake3:{}", blake3::hash(&response.body).to_hex());
        if body_digest != response.body_digest {
            return Err(Failure::Denied.error());
        }
        let peer = response.connected_peer.to_string();
        let receipt_digest = digest_bytes(
            format!(
                "horizon.http.receipt.v1:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
                binding.execution_id,
                binding.effect_id,
                binding.generation,
                binding.route_id,
                response.status,
                response
                    .retry_after_ms
                    .map_or_else(|| "none".to_owned(), |v| v.to_string()),
                response.body_digest,
                response.body.len(),
                response.body_truncated,
                peer,
                binding.request_digest,
            )
            .as_bytes(),
        );
        let now = now_ms().map_err(Failure::error)? as i64;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let changed = transaction
            .execute(
                "UPDATE http_executions SET status='SETTLED',http_status=?1,retry_after_ms=?2,
                    body_digest=?3,body_bytes=?4,body_truncated=?5,connected_peer=?6,
                    receipt_digest=?7,updated_at_ms=?8
                 WHERE execution_id=?9 AND effect_id=?10 AND challenge_id=?11 AND principal=?12
                   AND session_id=?13 AND location_id=?14 AND capability_id=?15
                   AND capability_lease_digest=?16 AND attempt_scope_digest IS ?17
                   AND owner_epoch=?18 AND generation=?19 AND workspace_revision=?20
                   AND route_id=?21 AND approved_arguments_digest=?22 AND request_digest=?23
                   AND status='RUNNING'",
                params![
                    response.status as i64,
                    response.retry_after_ms.map(|value| value as i64),
                    response.body_digest,
                    response.body.len() as i64,
                    response.body_truncated as i64,
                    peer,
                    receipt_digest,
                    now,
                    binding.execution_id,
                    binding.effect_id,
                    binding.challenge_id,
                    binding.principal,
                    binding.session_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    binding.owner_epoch as i64,
                    binding.generation as i64,
                    binding.workspace_revision,
                    binding.route_id,
                    binding.approved_arguments_digest,
                    binding.request_digest,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::Unknown.error());
        }
        let challenge_changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='SETTLED',receipt_digest=?1
                 WHERE challenge_id=?2 AND effect_id=?3 AND status='PREPARED'",
                params![receipt_digest, binding.challenge_id, binding.effect_id],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if challenge_changed != 1 {
            return Err(Failure::Unknown.error());
        }
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())?;
        Ok(HttpExecutionReceiptV1 {
            execution_id: binding.execution_id.clone(),
            effect_id: binding.effect_id.clone(),
            generation: binding.generation,
            route_id: binding.route_id.clone(),
            http_status: response.status,
            retry_after_ms: response.retry_after_ms,
            body_digest: response.body_digest.clone(),
            body_bytes: response.body.len() as u64,
            body_truncated: response.body_truncated,
            connected_peer: response.connected_peer,
            receipt_digest,
        })
    }

    /// Mark any ambiguous post-dispatch outcome UNKNOWN; this is idempotent and never
    /// authorizes retry or replay.
    pub fn mark_http_unknown(
        &mut self,
        binding: &HttpExecutionBindingV1,
    ) -> Result<(), TypedErrorV1> {
        let challenge = load_effect(&self.connection, &binding.effect_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        self.require_http_binding(binding, &challenge)
            .map_err(Failure::error)?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let changed = transaction
            .execute(
                "UPDATE http_executions SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND effect_id=?3 AND challenge_id=?4 AND principal=?5
                   AND session_id=?6 AND location_id=?7 AND capability_id=?8
                   AND capability_lease_digest=?9 AND attempt_scope_digest IS ?10
                   AND owner_epoch=?11 AND generation=?12 AND workspace_revision=?13
                   AND route_id=?14 AND approved_arguments_digest=?15 AND request_digest=?16
                   AND status IN ('PREPARED','RUNNING','UNKNOWN')",
                params![
                    now_ms().map_err(Failure::error)? as i64,
                    binding.execution_id,
                    binding.effect_id,
                    binding.challenge_id,
                    binding.principal,
                    binding.session_id,
                    binding.location_id,
                    binding.capability_id,
                    binding.capability_lease_digest,
                    binding.attempt_scope_digest,
                    binding.owner_epoch as i64,
                    binding.generation as i64,
                    binding.workspace_revision,
                    binding.route_id,
                    binding.approved_arguments_digest,
                    binding.request_digest,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::NotFound.error());
        }
        let challenge_changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='UNKNOWN'
                 WHERE challenge_id=?1 AND effect_id=?2 AND status IN ('PREPARED','UNKNOWN')",
                params![binding.challenge_id, binding.effect_id],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if challenge_changed != 1 {
            return Err(Failure::Unknown.error());
        }
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())
    }

    /// Recover only the owner-loss result for this authenticated peer/location. The
    /// prior owner epoch and Attempt scope are read from the durable row, never request
    /// data; unresolved states have already been classified UNKNOWN during open().
    pub fn reconcile_http_execution(
        &self,
        execution_id: &str,
        effect_id: &str,
        challenge_id: &str,
        principal: &str,
        location_id: &str,
    ) -> Result<HttpExecutionRecoveryV1, TypedErrorV1> {
        for value in [
            execution_id,
            effect_id,
            challenge_id,
            principal,
            location_id,
        ] {
            validate_identifier(value).map_err(Failure::error)?;
        }
        let row = self
            .connection
            .query_row(
                "SELECT principal,session_id,location_id,capability_id,capability_lease_digest,
                        approved_arguments_digest,attempt_scope_digest,owner_epoch,generation,
                        workspace_revision,route_id,request_digest,status,http_status,retry_after_ms,
                        body_digest,body_bytes,body_truncated,connected_peer,receipt_digest
                 FROM http_executions WHERE execution_id=?1 AND effect_id=?2 AND challenge_id=?3
                   AND principal=?4 AND location_id=?5",
                params![execution_id, effect_id, challenge_id, principal, location_id],
                |row| Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?, row.get::<_, i64>(7)?, row.get::<_, i64>(8)?,
                    row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?, row.get::<_, Option<i64>>(13)?, row.get::<_, Option<i64>>(14)?,
                    row.get::<_, Option<String>>(15)?, row.get::<_, Option<i64>>(16)?, row.get::<_, i64>(17)?,
                    row.get::<_, Option<String>>(18)?, row.get::<_, Option<String>>(19)?,
                )),
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::NotFound.error())?;
        if row.0 != principal
            || row.2 != location_id
            || row.3 != guard::WEB_SEARCH_ID
            || row.7 <= 0
            || row.8 <= 0
            || !is_blake3_digest(&row.4)
            || !is_blake3_digest(&row.5)
            || row
                .6
                .as_deref()
                .is_some_and(|digest| !is_blake3_digest(digest))
            || !is_blake3_digest(&row.9)
            || !is_blake3_digest(&row.11)
        {
            return Err(Failure::Denied.error());
        }
        let state = match row.12.as_str() {
            "UNKNOWN" => HttpExecutionStateV1::Unknown,
            "SETTLED"
                if row.19.as_deref().is_some_and(is_blake3_digest)
                    && row.15.as_deref().is_some_and(is_blake3_digest) =>
            {
                HttpExecutionStateV1::Settled
            }
            _ => return Err(Failure::Unknown.error()),
        };
        let binding = HttpExecutionBindingV1 {
            execution_id: execution_id.to_owned(),
            effect_id: effect_id.to_owned(),
            challenge_id: challenge_id.to_owned(),
            principal: row.0,
            session_id: row.1,
            location_id: row.2,
            capability_id: row.3,
            capability_lease_digest: row.4,
            approved_arguments_digest: row.5,
            attempt_scope_digest: row.6,
            owner_epoch: row.7 as u64,
            generation: row.8 as u64,
            workspace_revision: row.9,
            route_id: row.10,
            request_digest: row.11,
        };
        let status = HttpExecutionStatusV1 {
            execution_id: execution_id.to_owned(),
            generation: binding.generation,
            state,
            http_status: row.13.and_then(|value| u16::try_from(value).ok()),
            retry_after_ms: row.14.and_then(|value| u64::try_from(value).ok()),
            body_digest: row.15,
            body_bytes: row
                .16
                .and_then(|value| u64::try_from(value).ok())
                .unwrap_or(0),
            body_truncated: row.17 != 0,
            connected_peer: row.18.and_then(|value| value.parse().ok()),
            receipt_digest: row.19,
        };
        Ok(HttpExecutionRecoveryV1 { binding, status })
    }

    fn validate_http_preflight(
        &self,
        binding: &HttpExecutionBindingV1,
        preflight: &HttpExecutionPreparedV1,
    ) -> Result<(), Failure> {
        for value in [
            binding.execution_id.as_str(),
            binding.effect_id.as_str(),
            binding.challenge_id.as_str(),
            binding.principal.as_str(),
            binding.session_id.as_str(),
            binding.location_id.as_str(),
            binding.route_id.as_str(),
        ] {
            validate_identifier(value)?;
        }
        if binding.capability_id != guard::WEB_SEARCH_ID
            || binding.owner_epoch == 0
            || binding.generation == 0
            || i64::try_from(binding.owner_epoch).is_err()
            || i64::try_from(binding.generation).is_err()
            || !is_blake3_digest(&binding.capability_lease_digest)
            || !is_blake3_digest(&binding.approved_arguments_digest)
            || !is_blake3_digest(&binding.workspace_revision)
            || !is_blake3_digest(&binding.request_digest)
            || binding
                .attempt_scope_digest
                .as_deref()
                .is_some_and(|value| !is_blake3_digest(value))
            || preflight.execution_id != binding.execution_id
            || preflight.generation != binding.generation
            || preflight.approved_arguments_digest != binding.approved_arguments_digest
            || preflight.capability_lease_digest != binding.capability_lease_digest
            || preflight.execution_digest != binding.request_digest
        {
            return Err(Failure::Invalid);
        }
        let challenge =
            load_effect(&self.connection, &binding.effect_id)?.ok_or(Failure::NotFound)?;
        self.require_http_binding(binding, &challenge)?;
        if challenge.status != "APPROVED" || challenge.expires_at_ms <= now_ms()? {
            return Err(Failure::Conflict);
        }
        let existing: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM http_executions WHERE execution_id=?1 OR effect_id=?2 OR challenge_id=?3",
            params![binding.execution_id, binding.effect_id, binding.challenge_id],
            |row| row.get(0),
        ).map_err(|_| Failure::Unavailable)?;
        if existing != 0 {
            return Err(Failure::Conflict);
        }
        Ok(())
    }

    fn require_http_binding(
        &self,
        binding: &HttpExecutionBindingV1,
        challenge: &Challenge,
    ) -> Result<(), Failure> {
        if challenge.challenge_id != binding.challenge_id
            || challenge.effect_id != binding.effect_id
            || challenge.principal != binding.principal
            || challenge.session_id != binding.session_id
            || challenge.capability_id != binding.capability_id
            || challenge.managed_attempt_digest != binding.attempt_scope_digest
            || challenge.argument_digest != binding.approved_arguments_digest
            || challenge.capability_id != guard::WEB_SEARCH_ID
        {
            return Err(Failure::Denied);
        }
        Ok(())
    }

    fn reconcile_http_executions(&mut self) -> Result<(), Failure> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        let pending = transaction.execute(
            "UPDATE http_executions SET status='UNKNOWN',updated_at_ms=?1 WHERE status IN ('PREPARED','RUNNING')",
            [now_ms()? as i64],
        ).map_err(|_| Failure::Unavailable)?;
        if pending > 0 {
            transaction.execute(
                "UPDATE effect_challenges SET status='UNKNOWN' WHERE effect_id IN
                 (SELECT effect_id FROM http_executions WHERE status='UNKNOWN') AND status='PREPARED'",
                [],
            ).map_err(|_| Failure::Unavailable)?;
        }
        transaction.commit().map_err(|_| Failure::Unavailable)
    }

    pub fn authorize_terminal_continuation(
        &self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        effect_id: &str,
        attempt_scope: Option<&EffectAttemptScopeV1>,
    ) -> Result<(), TypedErrorV1> {
        self.check_terminal_continuation(
            process_session_id,
            principal,
            challenge_id,
            effect_id,
            attempt_scope,
        )
        .map_err(Failure::error)
    }

    fn check_terminal_continuation(
        &self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        effect_id: &str,
        attempt_scope: Option<&EffectAttemptScopeV1>,
    ) -> Result<(), Failure> {
        let challenge = load_challenge(&self.connection, challenge_id)?.ok_or(Failure::NotFound)?;
        if challenge.effect_id != effect_id
            || challenge.capability_id != guard::TERMINAL_START_ID
            || challenge.principal != principal
            || challenge.status != "PREPARED"
            || challenge.expires_at_ms <= now_ms()?
        {
            return Err(Failure::Denied);
        }
        let supplied_scope = attempt_scope_digest(attempt_scope, &challenge.session_id)?;
        if supplied_scope != challenge.managed_attempt_digest {
            return Err(Failure::Denied);
        }
        if challenge_origin_kind(&challenge) == guard::EffectOriginKindV1::SessionBatch {
            require_session(process_session_id, &challenge.session_id)?;
        }
        let execution = self.execution.as_ref().ok_or(Failure::Unavailable)?;
        let (decision, intent) = guard_decision(
            execution,
            &challenge.session_id,
            principal,
            &challenge.batch_id,
            &challenge.call_id,
            guard::TERMINAL_START_ID,
            &challenge.requested_path,
            &challenge.relative_path,
            &challenge.resource,
            &challenge.content_digest,
            &challenge.turn_context_digest,
            challenge_id,
            challenge_origin_kind(&challenge),
            challenge.managed_attempt_digest.as_deref(),
        );
        if decision.decision != guard::DecisionKind::Ask || intent != challenge.argument_digest {
            return Err(Failure::Denied);
        }
        Ok(())
    }

    fn validate_execution_preflight(
        &self,
        binding: &StdioExecutionBindingV1,
        preflight: &StdioExecutionPreparedV1,
    ) -> Result<(), Failure> {
        for value in [
            binding.execution_id.as_str(),
            binding.effect_id.as_str(),
            binding.challenge_id.as_str(),
            binding.principal.as_str(),
            binding.location_id.as_str(),
            binding.capability_id.as_str(),
            binding.profile_ref.as_str(),
        ] {
            validate_identifier(value)?;
        }
        if binding.session_id.is_empty() {
            if binding.capability_id != guard::BUILTIN_VERIFIER_ID
                || binding.attempt_scope_digest.is_some()
            {
                return Err(Failure::Invalid);
            }
        } else {
            validate_identifier(&binding.session_id)?;
        }
        if binding.owner_epoch == 0
            || binding.generation == 0
            || !is_blake3_digest(&binding.capability_lease_digest)
            || !is_blake3_digest(&binding.approved_arguments_digest)
            || !is_blake3_digest(&binding.workspace_revision)
            || binding
                .attempt_scope_digest
                .as_deref()
                .is_some_and(|digest| !is_blake3_digest(digest))
            || preflight.execution_id != binding.execution_id
            || preflight.generation != binding.generation
            || preflight.capability_lease_digest != binding.capability_lease_digest
            || preflight.approved_arguments_digest != binding.approved_arguments_digest
            || !is_blake3_digest(&preflight.execution_digest)
            || preflight.confinement_record.is_empty()
            || preflight.confinement_record.len() > 16 * 1024
        {
            return Err(Failure::Invalid);
        }
        let challenge =
            load_effect(&self.connection, &binding.effect_id)?.ok_or(Failure::NotFound)?;
        self.require_stdio_binding(binding, &challenge)?;
        self.validate_stdio_profile_executable(binding, &challenge)?;
        if challenge.status != "APPROVED" || challenge.expires_at_ms <= now_ms()? {
            return Err(Failure::Conflict);
        }
        let existing: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM stdio_executions WHERE execution_id=?1 OR effect_id=?2 OR challenge_id=?3",
                params![binding.execution_id, binding.effect_id, binding.challenge_id],
                |row| row.get(0),
            )
            .map_err(|_| Failure::Unavailable)?;
        if existing != 0 {
            return Err(Failure::Conflict);
        }
        Ok(())
    }

    fn require_stdio_binding(
        &self,
        binding: &StdioExecutionBindingV1,
        challenge: &Challenge,
    ) -> Result<(), Failure> {
        if !stdio_arguments_match_approval(
            &binding.approved_arguments_digest,
            &challenge.argument_digest,
        ) {
            return Err(Failure::Denied);
        }
        if challenge.capability_id == guard::BUILTIN_VERIFIER_ID
            || is_git_worktree_capability(&challenge.capability_id)
        {
            let profile = load_broker_process_binding(&self.connection, &challenge.challenge_id)?
                .ok_or(Failure::Denied)?;
            if binding.profile_ref != profile.profile_id {
                return Err(Failure::Denied);
            }
        }
        if challenge.challenge_id != binding.challenge_id
            || challenge.effect_id != binding.effect_id
            || challenge.principal != binding.principal
            || challenge.session_id != binding.session_id
            || challenge.capability_id != binding.capability_id
            || challenge.managed_attempt_digest != binding.attempt_scope_digest
            || (challenge.capability_id != guard::TERMINAL_RUN_ID
                && challenge.capability_id != guard::BUILTIN_VERIFIER_ID
                && !is_git_worktree_capability(&challenge.capability_id))
        {
            return Err(Failure::Denied);
        }
        Ok(())
    }

    /// Revalidate the live executable only on a pre-dispatch path. Recovery, receipt
    /// lookup, and cancellation bind to the durable profile identity and must remain
    /// available when the original executable has since moved or disappeared.
    fn validate_stdio_profile_executable(
        &self,
        binding: &StdioExecutionBindingV1,
        challenge: &Challenge,
    ) -> Result<(), Failure> {
        if challenge.capability_id != guard::BUILTIN_VERIFIER_ID
            && !is_git_worktree_capability(&challenge.capability_id)
        {
            return Ok(());
        }
        let profile = load_broker_process_binding(&self.connection, &challenge.challenge_id)?
            .ok_or(Failure::Denied)?;
        if binding.profile_ref != profile.profile_id {
            return Err(Failure::Denied);
        }
        let executable = fs::canonicalize(&profile.executable_path).map_err(|_| Failure::Denied)?;
        if executable.to_str() != Some(profile.executable_path.as_str())
            || crate::terminal_process::executable_digest(&executable)
                .map_err(|_| Failure::Denied)?
                != profile.executable_digest
        {
            return Err(Failure::Denied);
        }
        Ok(())
    }

    fn begin_terminal_effect(
        &mut self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        capability_lease_digest: &str,
        arguments: &Value,
        capability_id: &str,
        attempt_scope: Option<&EffectAttemptScopeV1>,
    ) -> Result<(), Failure> {
        if !is_blake3_digest(capability_lease_digest) {
            return Err(Failure::Invalid);
        }
        let challenge = load_challenge(&self.connection, challenge_id)?.ok_or(Failure::NotFound)?;
        let origin_kind = challenge_origin_kind(&challenge);
        // Only a Session-bound batch must match the calling process Session. A user action
        // is authorized by its principal and explicit approval, not by Session identity.
        if origin_kind == guard::EffectOriginKindV1::SessionBatch {
            require_session(process_session_id, &challenge.session_id)?;
        }
        if challenge.capability_id != capability_id || challenge.principal != principal {
            return Err(Failure::Denied);
        }
        let supplied_scope = attempt_scope_digest(attempt_scope, &challenge.session_id)?;
        if supplied_scope != challenge.managed_attempt_digest {
            return Err(Failure::Denied);
        }
        if challenge.status != "APPROVED" {
            return Err(Failure::Conflict);
        }
        if challenge.expires_at_ms <= now_ms()? {
            return Err(Failure::Conflict);
        }
        let execution = self.execution.as_ref().ok_or(Failure::Unavailable)?;
        let args = if capability_id == guard::TERMINAL_RUN_ID {
            parse_terminal_arguments(arguments, execution.root())?
        } else {
            parse_terminal_start_arguments(arguments, execution.root())?
        };
        if args.digest != challenge.content_digest
            || args.cwd != challenge.target
            || args.relative_path != challenge.relative_path
            || args.resource != challenge.resource
        {
            return Err(Failure::Denied);
        }
        let (decision, intent) = guard_decision(
            execution,
            &challenge.session_id,
            principal,
            &challenge.batch_id,
            &challenge.call_id,
            capability_id,
            &challenge.requested_path,
            &challenge.relative_path,
            &challenge.resource,
            &challenge.content_digest,
            &challenge.turn_context_digest,
            challenge_id,
            challenge_origin_kind(&challenge),
            challenge.managed_attempt_digest.as_deref(),
        );
        if decision.decision != guard::DecisionKind::Ask || intent != challenge.argument_digest {
            return Err(Failure::Denied);
        }
        let stored_bytes: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(SUM(length(output)),0) FROM terminal_runs",
                [],
                |row| row.get(0),
            )
            .map_err(|_| Failure::Unavailable)?;
        if stored_bytes < 0 || stored_bytes as u64 > 1024 * 1024 * 1024 - 100 * 1024 * 1024 {
            return Err(Failure::Unavailable);
        }
        let lease_id = random_id("lease")?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        let changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='PREPARED',lease_id=?1,capability_lease_digest=?2
             WHERE challenge_id=?3 AND status='APPROVED'",
                params![lease_id, capability_lease_digest, challenge_id],
            )
            .map_err(|_| Failure::Unavailable)?;
        if changed != 1 {
            return Err(Failure::Conflict);
        }
        transaction.execute(
            "UPDATE terminal_runs SET status='PREPARED' WHERE effect_id=?1 AND status='AWAITING_APPROVAL'",
            [&challenge.effect_id],
        ).map_err(|_| Failure::Unavailable)?;
        if capability_id == guard::TERMINAL_START_ID {
            let expires = now_ms()?
                .checked_add(crate::terminal::MAX_INTERACTIVE_GRANT_MS)
                .ok_or(Failure::Unavailable)?;
            transaction.execute(
                "UPDATE effect_challenges SET expires_at_ms=?1 WHERE challenge_id=?2 AND status='PREPARED'",
                params![expires as i64, challenge_id],
            ).map_err(|_| Failure::Unavailable)?;
        }
        transaction.commit().map_err(|_| Failure::Unavailable)
    }

    pub fn settle_terminal_run(
        &mut self,
        effect_id: &str,
        status: &str,
        exit_code: Option<i32>,
        output: &[u8],
        preview: &str,
        truncated: bool,
    ) -> Result<Value, TypedErrorV1> {
        self.complete_terminal_run(effect_id, status, exit_code, output, preview, truncated)
            .map_err(Failure::error)
    }

    fn complete_terminal_run(
        &mut self,
        effect_id: &str,
        status: &str,
        exit_code: Option<i32>,
        output: &[u8],
        preview: &str,
        truncated: bool,
    ) -> Result<Value, Failure> {
        if !matches!(status, "exited" | "timed_out" | "cancelled")
            || output.len() > 100 * 1024 * 1024
            || preview.len() > 50 * 1024
        {
            return Err(Failure::Invalid);
        }
        let challenge = load_effect(&self.connection, effect_id)?.ok_or(Failure::NotFound)?;
        if challenge.capability_id != guard::TERMINAL_RUN_ID || challenge.status != "PREPARED" {
            return Err(Failure::Unknown);
        }
        let output_digest = digest_bytes(output);
        let artifact_ref = format!(
            "artifact_{}",
            effect_id.strip_prefix("eff_").unwrap_or(effect_id)
        );
        let lease_id =
            load_lease_id(&self.connection, &challenge.challenge_id)?.ok_or(Failure::Unknown)?;
        let receipt = digest_bytes(
            format!(
                "{}:{}:{}:{}:{}",
                effect_id, challenge.content_digest, status, output_digest, lease_id,
            )
            .as_bytes(),
        );
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        let changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='SETTLED',after_digest=?1,receipt_digest=?2
             WHERE effect_id=?3 AND status='PREPARED'",
                params![output_digest, receipt, effect_id],
            )
            .map_err(|_| Failure::Unavailable)?;
        if changed != 1 {
            return Err(Failure::Unknown);
        }
        transaction.execute(
            "UPDATE terminal_runs SET status='SETTLED',terminal_status=?1,exit_code=?2,preview=?3,
             output=?4,output_digest=?5,artifact_ref=?6,truncated=?7,receipt_digest=?8
             WHERE effect_id=?9 AND status='PREPARED'",
            params![status,exit_code,preview,output,output_digest,artifact_ref,truncated as i64,receipt,effect_id],
        ).map_err(|_| Failure::Unavailable)?;
        transaction.commit().map_err(|_| Failure::Unavailable)?;
        let mut fields = BTreeMap::from([
            ("status".to_owned(), Value::String(status.to_owned())),
            ("preview".to_owned(), Value::String(preview.to_owned())),
            ("artifactRef".to_owned(), Value::String(artifact_ref)),
            ("receiptRef".to_owned(), Value::String(receipt)),
            ("truncated".to_owned(), Value::Bool(truncated)),
        ]);
        if let Some(code) = exit_code.and_then(|code| u64::try_from(code).ok()) {
            fields.insert("exitCode".to_owned(), Value::Unsigned(code));
        }
        Ok(Value::Map(fields))
    }

    pub fn mark_terminal_unknown(&mut self, effect_id: &str) -> Result<(), TypedErrorV1> {
        self.mark_terminal_run_unknown(effect_id)
            .map_err(Failure::error)
    }
    pub fn settle_terminal_start(
        &mut self,
        effect_id: &str,
        status: &str,
        exit_code: Option<i32>,
    ) -> Result<Value, TypedErrorV1> {
        self.complete_terminal_start(effect_id, status, exit_code)
            .map_err(Failure::error)
    }

    fn complete_terminal_start(
        &mut self,
        effect_id: &str,
        status: &str,
        exit_code: Option<i32>,
    ) -> Result<Value, Failure> {
        if !matches!(status, "exited" | "cancelled") {
            return Err(Failure::Invalid);
        }
        let challenge = load_effect(&self.connection, effect_id)?.ok_or(Failure::NotFound)?;
        if challenge.capability_id != guard::TERMINAL_START_ID || challenge.status != "PREPARED" {
            return Err(Failure::Unknown);
        }
        let code = exit_code.map(|code| code.to_string()).unwrap_or_default();
        let receipt = digest_bytes(
            format!(
                "{}:{}:{}:{}",
                effect_id, status, code, challenge.content_digest
            )
            .as_bytes(),
        );
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        let changed = transaction.execute(
            "UPDATE effect_challenges SET status='SETTLED',receipt_digest=?1 WHERE effect_id=?2 AND status='PREPARED'",
            params![receipt, effect_id],
        ).map_err(|_| Failure::Unavailable)?;
        if changed != 1 {
            return Err(Failure::Unknown);
        }
        transaction.execute(
            "UPDATE terminal_runs SET status='SETTLED',terminal_status=?1,exit_code=?2,receipt_digest=?3 WHERE effect_id=?4 AND status='PREPARED'",
            params![status, exit_code, receipt, effect_id],
        ).map_err(|_| Failure::Unavailable)?;
        transaction.commit().map_err(|_| Failure::Unavailable)?;
        Ok(map_value([
            ("status", Value::String(status.to_owned())),
            ("effectID", Value::String(effect_id.to_owned())),
            ("receiptRef", Value::String(receipt)),
        ]))
    }

    fn mark_terminal_run_unknown(&mut self, effect_id: &str) -> Result<(), Failure> {
        let challenge = load_effect(&self.connection, effect_id)?.ok_or(Failure::NotFound)?;
        if challenge.capability_id != guard::TERMINAL_RUN_ID
            && challenge.capability_id != guard::TERMINAL_START_ID
        {
            return Err(Failure::Denied);
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        transaction.execute(
            "UPDATE effect_challenges SET status='UNKNOWN' WHERE effect_id=?1 AND status IN ('PREPARED','UNKNOWN')",
            [effect_id],
        ).map_err(|_| Failure::Unavailable)?;
        transaction.execute(
            "UPDATE terminal_runs SET status='UNKNOWN' WHERE effect_id=?1 AND status IN ('PREPARED','UNKNOWN')",
            [effect_id],
        ).map_err(|_| Failure::Unavailable)?;
        transaction.commit().map_err(|_| Failure::Unavailable)
    }

    /// Complete atomic ToolBatch admission.
    ///
    /// Every call is validated and Guard-decided while nothing is durable; the complete
    /// set is then persisted in one transaction. A malformed, bounded-out or Guard-denied
    /// member denies the whole batch before any challenge row exists, so a mixed batch can
    /// never leave a partial admitted subset. Per-call approval, one-use lease and
    /// receipt/UNKNOWN settlement stay exactly as proven for a single call.
    fn prepare_tool_batch(
        &mut self,
        process_session_id: &str,
        principal: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        let body = strict_map_optional(
            body,
            &["sessionId", "batchId", "turnContextDigest", "calls"],
            &["managedAttempt", "directAttempt"],
        )?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
        let managed_attempt_digest = parse_effect_attempt_scope_digest(body, session_id)?;
        let batch_id = text(body, "batchId")?;
        validate_identifier(batch_id)?;
        let turn_context_digest = text(body, "turnContextDigest")?;
        if !guard::is_sha256_digest(turn_context_digest) {
            return Err(Failure::Invalid);
        }
        let calls = match body.get("calls") {
            Some(Value::Array(calls)) if calls.is_empty() => return Err(Failure::Invalid),
            Some(Value::Array(calls)) if calls.len() > MAX_TOOL_BATCH_CALLS => {
                return Ok(denied_batch("batch_call_limit"));
            }
            Some(Value::Array(calls)) => calls,
            _ => return Err(Failure::Invalid),
        };
        // Bound the batch payload before any parsing work: per-call and aggregate
        // encoded-argument bytes, independent of the surrounding RPC frame limit.
        let mut batch_bytes = 0usize;
        for call in calls {
            let encoded =
                messagepack::encoded_len(call, FRAME_LIMITS).map_err(|_| Failure::Invalid)?;
            if encoded > MAX_TOOL_CALL_ARGUMENT_BYTES {
                return Ok(denied_batch("argument_bytes"));
            }
            batch_bytes = batch_bytes.checked_add(encoded).ok_or(Failure::Invalid)?;
            if batch_bytes > MAX_TOOL_BATCH_ARGUMENT_BYTES {
                return Ok(denied_batch("argument_bytes"));
            }
        }
        if self.execution.is_none() {
            return Ok(denied_batch("workspace_root_unconfigured"));
        }
        let expires_at_ms = now_ms()?
            .checked_add(CHALLENGE_TTL_MS)
            .ok_or(Failure::Unavailable)?;
        let mut planned = Vec::with_capacity(calls.len());
        let mut call_ids = std::collections::HashSet::with_capacity(calls.len());
        for call in calls {
            let fields = strict_map(call, &["callId", "capabilityId", "arguments"])?;
            let call_id = text(fields, "callId")?;
            validate_identifier(call_id)?;
            if !call_ids.insert(call_id.to_owned()) {
                return Ok(denied_batch("duplicate_call_id"));
            }
            let capability_id = text(fields, "capabilityId")?;
            let arguments = fields.get("arguments").ok_or(Failure::Invalid)?;
            // Supervised broker process control (language server, debug adapter, REPL
            // interpreter) has no ExecutionHost route in this kernel yet. The capability
            // is refused as unavailable before anything durable exists; it is never
            // emulated and never falls through to a different capability's arm.
            if guard::is_broker_process_action(capability_id) {
                return Err(Failure::Unavailable);
            }
            let outcome = if capability_id == guard::TERMINAL_RUN_ID
                || capability_id == guard::TERMINAL_START_ID
            {
                let origin = TerminalOrigin {
                    kind: guard::EffectOriginKindV1::SessionBatch,
                    session_id,
                    principal,
                    batch_id,
                    call_id,
                    turn_context_digest,
                    capability_id,
                    managed_attempt_digest: managed_attempt_digest.as_deref(),
                };
                self.plan_terminal_effect(&origin, arguments, expires_at_ms)?
            } else if capability_id == guard::FILES_PATCH_ID {
                self.plan_patch(
                    session_id,
                    principal,
                    batch_id,
                    call_id,
                    turn_context_digest,
                    call,
                    expires_at_ms,
                    managed_attempt_digest.as_deref(),
                )?
            } else if capability_id == guard::FILES_WRITE_ID {
                self.plan_write(
                    session_id,
                    principal,
                    batch_id,
                    call_id,
                    turn_context_digest,
                    arguments,
                    expires_at_ms,
                    managed_attempt_digest.as_deref(),
                )?
            } else {
                return Ok(denied_batch("unsupported_capability"));
            };
            match outcome {
                PlanOutcome::Call(call) => planned.push(call),
                PlanOutcome::Denied(reason) => return Ok(denied_batch(reason)),
            }
        }
        self.persist_batch(
            session_id,
            principal,
            batch_id,
            turn_context_digest,
            guard::EffectOriginKindV1::SessionBatch,
            &planned,
        )?;
        Ok(batch_approval_value(batch_id, &planned))
    }

    /// Transition an exact still-approved, unleased subset of a ToolBatch from one
    /// HostKernel-authenticated Attempt scope to its next durable receipt-chain
    /// scope. The OwnerLog edge append is performed first; this transaction then
    /// recomputes each Guard intent against the refreshed scope. Consumed members
    /// cannot be transitioned or leased again.
    pub(crate) fn transition_batch_attempt_scope(
        &mut self,
        session_id: &str,
        principal: &str,
        batch_id: &str,
        effect_ids: &[String],
        previous_scope: &EffectAttemptScopeV1,
        refreshed_scope: &EffectAttemptScopeV1,
    ) -> Result<(), TypedErrorV1> {
        if effect_ids.is_empty() || effect_ids.len() > MAX_TOOL_BATCH_CALLS {
            return Err(Failure::Invalid.error());
        }
        let previous_digest = attempt_scope_digest(Some(previous_scope), session_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::Invalid.error())?;
        let refreshed_digest = attempt_scope_digest(Some(refreshed_scope), session_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::Invalid.error())?;
        if previous_digest == refreshed_digest {
            return Err(Failure::Invalid.error());
        }
        let mut unique = HashSet::with_capacity(effect_ids.len());
        if effect_ids.iter().any(|id| !unique.insert(id.as_str())) {
            return Err(Failure::Invalid.error());
        }
        let mut challenges = Vec::with_capacity(effect_ids.len());
        for effect_id in effect_ids {
            let row: Option<(String, String, String, Option<String>, Option<String>, String, Option<i64>, Option<String>)> = self
                .connection
                .query_row(
                    "SELECT challenge_id,session_id,principal,managed_attempt_digest,attempt_scope_transition_from,status,approved,lease_id
                     FROM effect_challenges WHERE effect_id=?1 AND batch_id=?2",
                    params![effect_id, batch_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
                )
                .optional()
                .map_err(|_| Failure::Unavailable.error())?;
            let (challenge_id, stored_session, stored_principal, stored_digest, transitioned_from, status, approved, lease_id) =
                row.ok_or_else(|| Failure::NotFound.error())?;
            if stored_session != session_id || stored_principal != principal {
                return Err(Failure::Denied.error());
            }
            // A retry after the OwnerLog append may observe the already-committed
            // transition. It is idempotent only for this exact old/new scope pair.
            if stored_digest.as_deref() == Some(refreshed_digest.as_str())
                && transitioned_from.as_deref() == Some(previous_digest.as_str())
            {
                let challenge = load_challenge(&self.connection, &challenge_id)
                    .map_err(Failure::error)?
                    .ok_or_else(|| Failure::NotFound.error())?;
                if challenge.status != "APPROVED" || approved != Some(1) || lease_id.is_some() {
                    return Err(Failure::Conflict.error());
                }
                challenges.push(challenge);
                continue;
            }
            if stored_digest.as_deref() != Some(previous_digest.as_str()) {
                return Err(Failure::Denied.error());
            }
            let challenge = load_challenge(&self.connection, &challenge_id)
                .map_err(Failure::error)?
                .ok_or_else(|| Failure::NotFound.error())?;
            if status != "APPROVED"
                || approved != Some(1)
                || lease_id.is_some()
                || challenge.status != "APPROVED"
                || challenge.batch_id != batch_id
                || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::SessionBatch
            {
                return Err(Failure::Conflict.error());
            }
            challenges.push(challenge);
        }
        if challenges.len() != effect_ids.len() {
            return Err(Failure::Conflict.error());
        }
        if challenges.iter().all(|challenge| {
            challenge.managed_attempt_digest.as_deref() == Some(refreshed_digest.as_str())
        }) {
            return Ok(());
        }
        if challenges.iter().any(|challenge| {
            challenge.managed_attempt_digest.as_deref() != Some(previous_digest.as_str())
        }) {
            return Err(Failure::Conflict.error());
        }
        let execution = self
            .execution
            .as_ref()
            .ok_or_else(|| Failure::Unavailable.error())?;
        let mut updates = Vec::with_capacity(challenges.len());
        for challenge in &challenges {
            let (decision, argument_digest) = guard_decision(
                execution,
                &challenge.session_id,
                &challenge.principal,
                &challenge.batch_id,
                &challenge.call_id,
                &challenge.capability_id,
                &challenge.requested_path,
                &challenge.relative_path,
                &challenge.resource,
                &challenge.content_digest,
                &challenge.turn_context_digest,
                &challenge.challenge_id,
                challenge_origin_kind(challenge),
                Some(&refreshed_digest),
            );
            if decision.decision != guard::DecisionKind::Ask {
                return Err(Failure::Denied.error());
            }
            updates.push((challenge.challenge_id.as_str(), argument_digest));
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        for (challenge_id, argument_digest) in updates {
            let changed = transaction
                .execute(
                    "UPDATE effect_challenges
                     SET managed_attempt_digest=?1,argument_digest=?2,attempt_scope_transition_from=?3
                     WHERE challenge_id=?4 AND session_id=?5 AND principal=?6 AND batch_id=?7
                       AND status='APPROVED' AND approved=1 AND lease_id IS NULL
                       AND managed_attempt_digest=?3
                       AND capability_lease_digest IS NULL",
                    params![
                        refreshed_digest,
                        argument_digest,
                        previous_digest,
                        challenge_id,
                        session_id,
                        principal,
                        batch_id,
                    ],
                )
                .map_err(|_| Failure::Unavailable.error())?;
            if changed != 1 {
                return Err(Failure::Conflict.error());
            }
        }
        transaction.commit().map_err(|_| Failure::Unavailable.error())
    }

    /// Plan one `files.write` member without persisting anything.
    fn plan_write(
        &self,
        session_id: &str,
        principal: &str,
        batch_id: &str,
        call_id: &str,
        turn_context_digest: &str,
        arguments: &Value,
        expires_at_ms: u64,
        managed_attempt_digest: Option<&str>,
    ) -> Result<PlanOutcome, Failure> {
        let arguments = strict_map(arguments, &["path", "content"])?;
        let path = text(arguments, "path")?;
        let content = text(arguments, "content")?;
        validate_content(content)?;
        let execution = self.execution.as_ref().ok_or(Failure::Unavailable)?;
        let (relative, relative_text) = match normalize_workspace_path(execution.root(), path) {
            Ok(path) => path,
            Err(Failure::Denied) => return Ok(PlanOutcome::Denied("path_outside_or_unsafe")),
            Err(error) => return Err(error),
        };
        let existed = match execution.inspect(&relative) {
            Ok(existed) => existed,
            Err(_) => return Ok(PlanOutcome::Denied("path_unavailable_or_unsafe")),
        };
        let target_path = execution.root().join(&relative);
        let target = target_path.to_string_lossy().into_owned();
        let content_digest = digest_bytes(content.as_bytes());
        let challenge_id = random_id("ch")?;
        let effect_id = random_id("eff")?;
        let (decision, argument_digest) = guard_decision(
            execution,
            session_id,
            principal,
            batch_id,
            call_id,
            guard::FILES_WRITE_ID,
            path,
            &relative_text,
            &relative_text,
            &content_digest,
            turn_context_digest,
            &challenge_id,
            guard::EffectOriginKindV1::SessionBatch,
            managed_attempt_digest,
        );
        if decision.decision != guard::DecisionKind::Ask {
            return Ok(PlanOutcome::Denied(
                decision.reason_code.unwrap_or("guard_denied"),
            ));
        }
        Ok(PlanOutcome::Call(PlannedCall {
            call_id: call_id.to_owned(),
            capability_id: guard::FILES_WRITE_ID.to_owned(),
            challenge_id,
            effect_id,
            argument_digest,
            content_digest,
            expires_at_ms,
            managed_attempt_digest: managed_attempt_digest.map(str::to_owned),
            effect: PlannedEffect::Write {
                requested_path: path.to_owned(),
                relative_path: relative_text.clone(),
                target,
                resource: relative_text,
                existed,
            },
        }))
    }

    fn prepare_user_effect(&mut self, principal: &str, body: &Value) -> Result<Value, Failure> {
        let fields = strict_map_optional(
            body,
            &["userActionId", "capabilityId", "arguments"],
            &["sessionId", "managedAttempt", "directAttempt"],
        )?;
        // A user action is authorized by the authenticated principal and its explicit
        // approval. The host does not own Session identity, so the recorded Session is a
        // label only and is never required to match the calling process.
        let session_id = match fields.get("sessionId") {
            None => "",
            Some(Value::String(value))
                if !value.contains('\0') && validate_identifier(value).is_ok() =>
            {
                value.as_str()
            }
            _ => return Err(Failure::Invalid),
        };
        let user_action_id = text(fields, "userActionId")?;
        validate_identifier(user_action_id)?;
        let capability_id = text(fields, "capabilityId")?;
        if capability_id != guard::TERMINAL_RUN_ID && capability_id != guard::TERMINAL_START_ID {
            return Err(Failure::Invalid);
        }
        let managed_attempt_digest = parse_effect_attempt_scope_digest(fields, session_id)?;
        self.prepare_terminal_effect(
            TerminalOrigin {
                kind: guard::EffectOriginKindV1::UserAction,
                session_id,
                principal,
                batch_id: user_action_id,
                call_id: user_action_id,
                turn_context_digest: "",
                capability_id,
                managed_attempt_digest: managed_attempt_digest.as_deref(),
            },
            fields.get("arguments").ok_or(Failure::Invalid)?,
        )
    }

    /// Prepare a Guard challenge for one fixed broker-process invocation. The caller is
    /// HostKernel only and supplies a validated local profile binding; there is no RPC
    /// decoder that can choose an executable, profile, argv, or environment.
    pub(crate) fn prepare_broker_process(
        &mut self,
        authorization: BrokerProcessAuthorizationV1,
    ) -> Result<Value, TypedErrorV1> {
        self.prepare_broker_process_set(vec![authorization])?
            .into_iter()
            .next()
            .ok_or_else(|| Failure::Unavailable.error())
    }

    /// Persist the entire managed verifier challenge set in one EffectHost transaction.
    /// All members must share the same authenticated reviewer, Run identity, Location,
    /// executable, and immutable profile binding.
    pub(crate) fn prepare_broker_process_set(
        &mut self,
        authorizations: Vec<BrokerProcessAuthorizationV1>,
    ) -> Result<Vec<Value>, TypedErrorV1> {
        if authorizations.is_empty() || authorizations.len() > 32 {
            return Err(Failure::Invalid.error());
        }
        let first = &authorizations[0];
        let verifier = first.capability_id == guard::BUILTIN_VERIFIER_ID
            && first.origin_kind == guard::EffectOriginKindV1::ManagedRun;
        let git_worktree = matches!(
            first.capability_id.as_str(),
            guard::GIT_WORKTREE_ACQUIRE_ID
                | guard::GIT_WORKTREE_LIST_ID
                | guard::GIT_WORKTREE_RELEASE_ID
        ) && first.origin_kind == guard::EffectOriginKindV1::UserAction;
        if git_worktree
            && (authorizations.len() != 1
                || first.profile_id != "git-worktree"
                || first.session_id.is_empty()
                || first.managed_attempt_digest.is_some())
        {
            return Err(Failure::Denied.error());
        }
        if authorizations.iter().any(|authorization| {
            authorization.capability_id != first.capability_id
                || !(verifier || git_worktree)
                || authorization.principal != first.principal
                || authorization.user_action_id != first.user_action_id
                || authorization.session_id != first.session_id
                || authorization.managed_attempt_digest != first.managed_attempt_digest
                || authorization.workspace_cwd != first.workspace_cwd
                || authorization.resource != first.resource
                || authorization.profile_id != first.profile_id
                || authorization.executable_path != first.executable_path
                || authorization.executable_digest != first.executable_digest
                || authorization.profile_digest != first.profile_digest
        }) {
            return Err(Failure::Denied.error());
        }
        let mut call_ids = HashSet::with_capacity(authorizations.len());
        if authorizations
            .iter()
            .any(|authorization| !call_ids.insert(authorization.call_id.as_str()))
        {
            return Err(Failure::Invalid.error());
        }
        let execution = self
            .execution
            .as_ref()
            .ok_or_else(|| Failure::Unavailable.error())?;
        validate_identifier(&first.user_action_id).map_err(Failure::error)?;
        validate_identifier(&first.profile_id).map_err(Failure::error)?;
        if !first.session_id.is_empty() {
            validate_identifier(&first.session_id).map_err(Failure::error)?;
        }
        if first.principal.is_empty() || first.principal.chars().any(char::is_control) {
            return Err(Failure::Denied.error());
        }
        if first
            .managed_attempt_digest
            .as_deref()
            .is_some_and(|digest| !is_blake3_digest(digest))
            || first.origin_kind == guard::EffectOriginKindV1::ManagedRun
                && first.managed_attempt_digest.is_none()
        {
            return Err(Failure::Denied.error());
        }
        let workspace_cwd =
            fs::canonicalize(&first.workspace_cwd).map_err(|_| Failure::Denied.error())?;
        let executable_path =
            fs::canonicalize(&first.executable_path).map_err(|_| Failure::Denied.error())?;
        if workspace_cwd != execution.root()
            || first.resource != "."
            || workspace_cwd.to_str() != Some(first.workspace_cwd.as_str())
            || executable_path.to_str() != Some(first.executable_path.as_str())
            || !is_blake3_digest(&first.executable_digest)
            || !is_blake3_digest(&first.profile_digest)
            || crate::terminal_process::executable_digest(&executable_path)
                .map_err(|_| Failure::Denied.error())?
                != first.executable_digest
        {
            return Err(Failure::Denied.error());
        }
        let expires_at_ms = now_ms()
            .and_then(|now| {
                now.checked_add(CHALLENGE_TTL_MS)
                    .ok_or(Failure::Unavailable)
            })
            .map_err(Failure::error)?;
        let mut calls = Vec::with_capacity(authorizations.len());
        for authorization in &authorizations {
            validate_identifier(&authorization.call_id).map_err(Failure::error)?;
            if !is_blake3_digest(&authorization.argument_bundle_digest) {
                return Err(Failure::Invalid.error());
            }
            let challenge_id = random_id("ch").map_err(Failure::error)?;
            let effect_id = random_id("eff").map_err(Failure::error)?;
            let (decision, argument_digest) = guard_broker_decision(
                execution,
                &authorization.session_id,
                &authorization.principal,
                &authorization.user_action_id,
                &authorization.call_id,
                &authorization.workspace_cwd,
                &authorization.resource,
                &authorization.argument_bundle_digest,
                &authorization.executable_path,
                &authorization.executable_digest,
                &authorization.profile_digest,
                &challenge_id,
                &authorization.capability_id,
                authorization.origin_kind,
                authorization.managed_attempt_digest.as_deref(),
            );
            if decision.decision != guard::DecisionKind::Ask {
                return Err(Failure::Denied.error());
            }
            calls.push(PlannedCall {
                call_id: authorization.call_id.clone(),
                capability_id: authorization.capability_id.clone(),
                challenge_id,
                effect_id,
                argument_digest,
                content_digest: authorization.argument_bundle_digest.clone(),
                expires_at_ms,
                managed_attempt_digest: authorization.managed_attempt_digest.clone(),
                effect: PlannedEffect::BrokerProcess {
                    requested_path: authorization.workspace_cwd.clone(),
                    relative_path: ".".to_owned(),
                    resource: authorization.resource.clone(),
                    profile_id: authorization.profile_id.clone(),
                    executable_path: authorization.executable_path.clone(),
                    executable_digest: authorization.executable_digest.clone(),
                    profile_digest: authorization.profile_digest.clone(),
                },
            });
        }
        self.persist_batch(
            &first.session_id,
            &first.principal,
            &first.user_action_id,
            "",
            first.origin_kind,
            &calls,
        )
        .map_err(Failure::error)?;
        Ok(calls.iter().map(single_approval_value).collect())
    }

    fn prepare_terminal_effect(
        &mut self,
        origin: TerminalOrigin<'_>,
        arguments: &Value,
    ) -> Result<Value, Failure> {
        let expires_at_ms = now_ms()?
            .checked_add(CHALLENGE_TTL_MS)
            .ok_or(Failure::Unavailable)?;
        let outcome = self.plan_terminal_effect(&origin, arguments, expires_at_ms)?;
        let call = match outcome {
            PlanOutcome::Call(call) => call,
            PlanOutcome::Denied(reason) => return Ok(denied_batch(reason)),
        };
        self.persist_batch(
            origin.session_id,
            origin.principal,
            origin.batch_id,
            origin.turn_context_digest,
            origin.kind,
            std::slice::from_ref(&call),
        )?;
        Ok(single_approval_value(&call))
    }

    /// Plan one terminal member without persisting anything.
    fn plan_terminal_effect(
        &self,
        origin: &TerminalOrigin<'_>,
        arguments: &Value,
        expires_at_ms: u64,
    ) -> Result<PlanOutcome, Failure> {
        let TerminalOrigin {
            kind: origin_kind,
            session_id,
            principal,
            batch_id,
            call_id,
            turn_context_digest,
            capability_id,
            managed_attempt_digest,
        } = *origin;
        let execution = self.execution.as_ref().ok_or(Failure::Unavailable)?;
        let args = if capability_id == guard::TERMINAL_RUN_ID {
            parse_terminal_arguments(arguments, execution.root())?
        } else {
            parse_terminal_start_arguments(arguments, execution.root())?
        };
        if (!session_id.is_empty() && validate_identifier(session_id).is_err())
            || validate_identifier(batch_id).is_err()
            || validate_identifier(call_id).is_err()
            || (!turn_context_digest.is_empty() && !guard::is_sha256_digest(turn_context_digest))
        {
            return Err(Failure::Invalid);
        }
        let challenge_id = random_id("ch")?;
        let effect_id = random_id("eff")?;
        let (decision, argument_digest) = guard_decision(
            execution,
            session_id,
            principal,
            batch_id,
            call_id,
            capability_id,
            &args.cwd,
            &args.relative_path,
            &args.resource,
            &args.digest,
            turn_context_digest,
            &challenge_id,
            origin_kind,
            managed_attempt_digest,
        );
        if decision.decision != guard::DecisionKind::Ask {
            return Ok(PlanOutcome::Denied(
                decision.reason_code.unwrap_or("guard_denied"),
            ));
        }
        Ok(PlanOutcome::Call(PlannedCall {
            call_id: call_id.to_owned(),
            capability_id: capability_id.to_owned(),
            challenge_id,
            effect_id,
            argument_digest,
            content_digest: args.digest.clone(),
            expires_at_ms,
            managed_attempt_digest: managed_attempt_digest.map(str::to_owned),
            effect: PlannedEffect::Terminal {
                requested_path: args.cwd.clone(),
                relative_path: args.relative_path,
                resource: args.resource,
                digest: args.digest,
                capability_id: capability_id.to_owned(),
            },
        }))
    }

    /// Plan one `files.patch` member without persisting anything.
    fn plan_patch(
        &self,
        session_id: &str,
        principal: &str,
        batch_id: &str,
        call_id: &str,
        turn_context_digest: &str,
        call: &Value,
        expires_at_ms: u64,
        managed_attempt_digest: Option<&str>,
    ) -> Result<PlanOutcome, Failure> {
        let call = strict_map(call, &["callId", "capabilityId", "arguments"])?;
        if text(call, "callId")? != call_id || text(call, "capabilityId")? != guard::FILES_PATCH_ID
        {
            return Err(Failure::Invalid);
        }
        let arguments = strict_map(
            call.get("arguments").ok_or(Failure::Invalid)?,
            &["operations"],
        )?;
        let values = match arguments.get("operations") {
            Some(Value::Array(values)) if !values.is_empty() && values.len() <= 64 => values,
            Some(Value::Array(_)) => return Ok(PlanOutcome::Denied("invalid_operation_count")),
            _ => return Err(Failure::Invalid),
        };
        let execution = match self.execution.as_ref() {
            Some(execution) => execution,
            None => return Ok(PlanOutcome::Denied("workspace_root_unconfigured")),
        };
        let mut targets = Vec::with_capacity(values.len());
        let mut paths = std::collections::HashSet::new();
        let mut total_bytes = 0usize;
        for value in values {
            let map = match value {
                Value::Map(map) => map,
                _ => return Err(Failure::Invalid),
            };
            let operation = text(map, "operation")?;
            if operation == "write" {
                strict_map_optional(
                    value,
                    &["operation", "path", "expectedBeforeBase64", "contentBase64"],
                    &["executable"],
                )?;
            } else if operation == "delete" {
                strict_map(value, &["operation", "path", "expectedBeforeBase64"])?;
            } else {
                return Ok(PlanOutcome::Denied("unsupported_operation"));
            }
            let path = text(map, "path")?;
            let expected_before = match map.get("expectedBeforeBase64") {
                Some(Value::Nil) => None,
                Some(Value::String(encoded)) => {
                    Some(decode_canonical_base64(encoded).ok_or(Failure::Invalid)?)
                }
                _ => return Err(Failure::Invalid),
            };
            if expected_before
                .as_ref()
                .is_some_and(|bytes| bytes.len() > 2 * 1024 * 1024)
            {
                return Ok(PlanOutcome::Denied("patch_too_large"));
            }
            total_bytes = total_bytes
                .checked_add(expected_before.as_ref().map_or(0, Vec::len))
                .ok_or(Failure::Invalid)?;
            if total_bytes > 4 * 1024 * 1024 {
                return Ok(PlanOutcome::Denied("patch_too_large"));
            }
            let content = if operation == "write" {
                let encoded = text(map, "contentBase64")?;
                let decoded = decode_canonical_base64(encoded).ok_or(Failure::Invalid)?;
                if decoded.len() > 2 * 1024 * 1024 {
                    return Ok(PlanOutcome::Denied("patch_too_large"));
                }
                total_bytes = total_bytes
                    .checked_add(decoded.len())
                    .ok_or(Failure::Invalid)?;
                if total_bytes > 4 * 1024 * 1024 {
                    return Ok(PlanOutcome::Denied("patch_too_large"));
                }
                Some(decoded)
            } else {
                None
            };
            if operation == "delete" && expected_before.is_none() {
                return Ok(PlanOutcome::Denied("delete_requires_preimage"));
            }
            let (relative, relative_text) = match normalize_workspace_path(execution.root(), path) {
                Ok(path) => path,
                Err(_) => return Ok(PlanOutcome::Denied("path_outside_or_unsafe")),
            };
            if !paths.insert(relative_text.clone()) {
                return Ok(PlanOutcome::Denied("duplicate_path"));
            }
            let existed = match execution.inspect(&relative) {
                Ok(existed) => existed,
                Err(_) => return Ok(PlanOutcome::Denied("path_unavailable_or_unsafe")),
            };
            let requested_executable = match map.get("executable") {
                None => None,
                Some(Value::Bool(executable)) => Some(*executable),
                Some(_) => return Err(Failure::Invalid),
            };
            let (before_bytes, before_mode) = if existed {
                let (bytes, mode) = execution
                    .read_target_bytes(&relative)
                    .map_err(map_io_failure)?;
                (Some(bytes), Some(mode))
            } else {
                (None, None)
            };
            if before_bytes != expected_before {
                return Ok(PlanOutcome::Denied("stale_preimage"));
            }
            let before_digest = before_bytes.as_deref().map(digest_bytes);
            let mode = if operation == "write" {
                Some(match requested_executable {
                    Some(true) => 0o755,
                    Some(false) => 0o644,
                    None => before_mode.unwrap_or(0o644),
                })
            } else {
                None
            };
            targets.push(PatchTarget {
                operation: operation.to_owned(),
                relative_path: relative_text.clone(),
                requested_path: path.to_owned(),
                target: execution
                    .root()
                    .join(&relative)
                    .to_string_lossy()
                    .into_owned(),
                resource: relative_text,
                existed,
                requested_executable,
                before_mode,
                mode,
                before_digest,
                content_digest: content.as_deref().map(|bytes| digest_bytes(bytes)),
                after_digest: content.as_deref().map(|bytes| digest_bytes(bytes)),
                content,
            });
        }
        let canonical = patch_manifest_digest(&targets);
        let challenge_id = random_id("ch")?;
        let effect_id = random_id("eff")?;
        let Some(argument_digest) = guard_patch_intent(
            execution,
            session_id,
            principal,
            batch_id,
            call_id,
            &canonical,
            turn_context_digest,
            &challenge_id,
            &targets,
            managed_attempt_digest,
        ) else {
            return Ok(PlanOutcome::Denied("guard_denied"));
        };
        Ok(PlanOutcome::Call(PlannedCall {
            call_id: call_id.to_owned(),
            capability_id: guard::FILES_PATCH_ID.to_owned(),
            challenge_id,
            effect_id,
            argument_digest,
            content_digest: canonical,
            expires_at_ms,
            managed_attempt_digest: managed_attempt_digest.map(str::to_owned),
            effect: PlannedEffect::Patch { targets },
        }))
    }

    fn prepare_patch(
        &mut self,
        session_id: &str,
        principal: &str,
        batch_id: &str,
        call_id: &str,
        turn_context_digest: &str,
        call: &Value,
    ) -> Result<Value, Failure> {
        let expires_at_ms = now_ms()?
            .checked_add(CHALLENGE_TTL_MS)
            .ok_or(Failure::Unavailable)?;
        let outcome = self.plan_patch(
            session_id,
            principal,
            batch_id,
            call_id,
            turn_context_digest,
            call,
            expires_at_ms,
            None,
        )?;
        let planned = match outcome {
            PlanOutcome::Call(call) => call,
            PlanOutcome::Denied(reason) => return Ok(denied_batch(reason)),
        };
        self.persist_batch(
            session_id,
            principal,
            batch_id,
            turn_context_digest,
            guard::EffectOriginKindV1::SessionBatch,
            std::slice::from_ref(&planned),
        )?;
        Ok(single_approval_value(&planned))
    }

    /// Persist the complete planned batch in one durable transaction. Every challenge row
    /// (plus patch targets and terminal bookkeeping) is written atomically, so a crash
    /// between planning and commit leaves either the complete batch or nothing.
    fn persist_batch(
        &mut self,
        session_id: &str,
        principal: &str,
        batch_id: &str,
        turn_context_digest: &str,
        origin_kind: guard::EffectOriginKindV1,
        calls: &[PlannedCall],
    ) -> Result<(), Failure> {
        let origin_kind_name = match origin_kind {
            guard::EffectOriginKindV1::SessionBatch => ORIGIN_SESSION_BATCH,
            guard::EffectOriginKindV1::UserAction => ORIGIN_USER_ACTION,
            guard::EffectOriginKindV1::ManagedRun => ORIGIN_MANAGED_RUN,
        };
        let created_at_ms = now_ms()? as i64;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        for call in calls {
            let (relative_path, requested_path, target, resource, existed) = match &call.effect {
                PlannedEffect::Write {
                    requested_path,
                    relative_path,
                    target,
                    resource,
                    existed,
                } => (
                    relative_path.as_str(),
                    requested_path.as_str(),
                    target.as_str(),
                    resource.as_str(),
                    *existed,
                ),
                PlannedEffect::Patch { targets } => {
                    let first = targets.first().ok_or(Failure::Invalid)?;
                    (
                        first.relative_path.as_str(),
                        first.requested_path.as_str(),
                        first.target.as_str(),
                        first.resource.as_str(),
                        first.existed,
                    )
                }
                PlannedEffect::Terminal {
                    requested_path,
                    relative_path,
                    resource,
                    ..
                } => (
                    relative_path.as_str(),
                    requested_path.as_str(),
                    requested_path.as_str(),
                    resource.as_str(),
                    false,
                ),
                PlannedEffect::BrokerProcess {
                    requested_path,
                    relative_path,
                    resource,
                    ..
                } => (
                    relative_path.as_str(),
                    requested_path.as_str(),
                    requested_path.as_str(),
                    resource.as_str(),
                    false,
                ),
            };
            transaction
                .execute(
                    "INSERT INTO effect_challenges (
                        challenge_id, effect_id, session_id, principal, batch_id, call_id,
                        capability_id, relative_path, requested_path, target, resource, existed,
                        argument_digest, content_digest, expires_at_ms, status, approved,
                        after_digest, lease_id, receipt_digest, turn_context_digest, origin_kind,
                        managed_attempt_digest
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                               ?15, 'AWAITING_APPROVAL', NULL, NULL, NULL, NULL, ?16, ?17, ?18)",
                    params![
                        call.challenge_id,
                        call.effect_id,
                        session_id,
                        principal,
                        batch_id,
                        call.call_id,
                        call.capability_id,
                        relative_path,
                        requested_path,
                        target,
                        resource,
                        existed as i64,
                        call.argument_digest,
                        call.content_digest,
                        call.expires_at_ms as i64,
                        turn_context_digest,
                        origin_kind_name,
                        call.managed_attempt_digest,
                    ],
                )
                .map_err(|_| Failure::Unavailable)?;
            match &call.effect {
                PlannedEffect::Write { .. } => {}
                PlannedEffect::Patch { targets } => {
                    for (ordinal, target) in targets.iter().enumerate() {
                        transaction.execute(
                            "INSERT INTO patch_targets (challenge_id,ordinal,operation,relative_path,requested_path,target,resource,existed,before_digest,after_digest,content_digest,requested_executable,before_mode,mode) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                            params![call.challenge_id,ordinal as i64,target.operation,target.relative_path,target.requested_path,target.target,target.resource,target.existed as i64,target.before_digest,target.after_digest,target.content_digest,target.requested_executable.map(|value| if value { 1i64 } else { 0i64 }),target.before_mode,target.mode],
                        ).map_err(|_| Failure::Unavailable)?;
                    }
                }
                PlannedEffect::Terminal { .. } => {
                    transaction
                        .execute(
                            "INSERT INTO terminal_runs(effect_id,status,created_at_ms) VALUES (?1,'AWAITING_APPROVAL',?2)",
                            params![call.effect_id, created_at_ms],
                        )
                        .map_err(|_| Failure::Unavailable)?;
                }
                PlannedEffect::BrokerProcess {
                    profile_id,
                    executable_path,
                    executable_digest,
                    profile_digest,
                    ..
                } => {
                    transaction
                        .execute(
                            "INSERT INTO broker_process_bindings(challenge_id,profile_id,executable_path,executable_digest,profile_digest) VALUES (?1,?2,?3,?4,?5)",
                            params![call.challenge_id,profile_id,executable_path,executable_digest,profile_digest],
                        )
                        .map_err(|_| Failure::Unavailable)?;
                }
            }
        }
        transaction.commit().map_err(|_| Failure::Unavailable)
    }

    /// Cancel every not-yet-executing challenge of one tool batch. The operation is
    /// durable and idempotent: only `AWAITING_APPROVAL`/`APPROVED` members are cancelled,
    /// while a `PREPARED` member may already be mid-execution and is left for explicit
    /// receipt/UNKNOWN reconciliation instead of being reported as safely cancelled.
    fn cancel_batch(
        &mut self,
        process_session_id: &str,
        principal: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        let body = strict_map(body, &["sessionId", "batchId"])?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
        let batch_id = text(body, "batchId")?;
        validate_identifier(batch_id)?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        let rows = {
            let mut statement = transaction
                .prepare(
                    "SELECT challenge_id, effect_id, status FROM effect_challenges
                     WHERE batch_id=?1 AND session_id=?2 AND principal=?3 AND status IN ('AWAITING_APPROVAL','APPROVED')",
                )
                .map_err(|_| Failure::Unavailable)?;
            let mapped = statement
                .query_map(params![batch_id, session_id, principal], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|_| Failure::Unavailable)?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| Failure::Unavailable)?
        };
        let mut cancelled = 0u64;
        for (challenge_id, effect_id, status) in &rows {
            let changed = transaction
                .execute(
                    "UPDATE effect_challenges SET status='CANCELLED'
                     WHERE challenge_id=?1 AND status=?2",
                    params![challenge_id, status],
                )
                .map_err(|_| Failure::Unavailable)?;
            if changed == 1 {
                cancelled += 1;
                transaction
                    .execute(
                        "UPDATE terminal_runs SET status='CANCELLED'
                         WHERE effect_id=?1 AND status='AWAITING_APPROVAL'",
                        [effect_id],
                    )
                    .map_err(|_| Failure::Unavailable)?;
            }
        }
        let prepared: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM effect_challenges WHERE batch_id=?1 AND session_id=?2 AND principal=?3 AND status='PREPARED'",
                params![batch_id, session_id, principal],
                |row| row.get(0),
            )
            .map_err(|_| Failure::Unavailable)?;
        transaction.commit().map_err(|_| Failure::Unavailable)?;
        Ok(map_value([
            ("status", Value::String("cancelled".to_owned())),
            ("batchId", Value::String(batch_id.to_owned())),
            ("cancelled", Value::Unsigned(cancelled)),
            ("prepared", Value::Unsigned(prepared.max(0) as u64)),
        ]))
    }

    fn execute_patch(
        &mut self,
        process_session_id: &str,
        principal: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        let body = strict_map_optional(
            body,
            &["sessionId", "challengeId", "operations"],
            &["managedAttempt", "directAttempt"],
        )?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
        let challenge_id = text(body, "challengeId")?;
        validate_identifier(challenge_id)?;
        let challenge = load_challenge(&self.connection, challenge_id)?.ok_or(Failure::NotFound)?;
        let supplied_scope = parse_effect_attempt_scope_digest(body, session_id)?;
        if supplied_scope != challenge.managed_attempt_digest {
            return Err(Failure::Denied);
        }
        // Exact-capability binding: only a `files.patch` challenge may be applied by the
        // patch executor, regardless of its durable state.
        if challenge.capability_id != guard::FILES_PATCH_ID {
            return Err(Failure::Denied);
        }
        if challenge.session_id != session_id || challenge.principal != principal {
            return Err(Failure::Denied);
        }
        if challenge.status != "APPROVED" {
            return Err(Failure::Conflict);
        }
        if challenge.expires_at_ms <= now_ms()? {
            return Err(Failure::Conflict);
        }
        let supplied = match body.get("operations") {
            Some(Value::Array(values)) => values,
            _ => return Err(Failure::Invalid),
        };
        let mut targets = load_patch_targets(&self.connection, challenge_id)?;
        if targets.len() != supplied.len() || targets.is_empty() {
            return Err(Failure::Denied);
        }
        let mut total_bytes = 0usize;
        for (target, value) in targets.iter_mut().zip(supplied) {
            let map = match value {
                Value::Map(map) => map,
                _ => return Err(Failure::Invalid),
            };
            let operation = text(map, "operation")?;
            let expected_before = match map.get("expectedBeforeBase64") {
                Some(Value::Nil) => None,
                Some(Value::String(encoded)) => {
                    Some(decode_canonical_base64(encoded).ok_or(Failure::Invalid)?)
                }
                _ => return Err(Failure::Invalid),
            };
            if expected_before
                .as_ref()
                .is_some_and(|bytes| bytes.len() > 2 * 1024 * 1024)
            {
                return Err(Failure::Denied);
            }
            total_bytes = total_bytes
                .checked_add(expected_before.as_ref().map_or(0, Vec::len))
                .ok_or(Failure::Invalid)?;
            if total_bytes > 4 * 1024 * 1024
                || expected_before.as_deref().map(digest_bytes) != target.before_digest
            {
                return Err(Failure::Denied);
            }
            if operation == "write" {
                strict_map_optional(
                    value,
                    &["operation", "path", "expectedBeforeBase64", "contentBase64"],
                    &["executable"],
                )?;
                let executable = match map.get("executable") {
                    None => None,
                    Some(Value::Bool(executable)) => Some(*executable),
                    Some(_) => return Err(Failure::Invalid),
                };
                if executable != target.requested_executable {
                    return Err(Failure::Denied);
                }
                let encoded = text(map, "contentBase64")?;
                let content = decode_canonical_base64(encoded).ok_or(Failure::Invalid)?;
                total_bytes = total_bytes
                    .checked_add(content.len())
                    .ok_or(Failure::Invalid)?;
                if content.len() > 2 * 1024 * 1024
                    || total_bytes > 4 * 1024 * 1024
                    || Some(digest_bytes(&content)) != target.content_digest
                {
                    return Err(Failure::Denied);
                }
                target.content = Some(content);
            } else if operation == "delete" {
                strict_map(value, &["operation", "path", "expectedBeforeBase64"])?;
                if target.content_digest.is_some() || expected_before.is_none() {
                    return Err(Failure::Denied);
                }
            } else {
                return Err(Failure::Denied);
            }
            if operation != target.operation || text(map, "path")? != target.requested_path {
                return Err(Failure::Denied);
            }
        }
        let execution = self.execution.as_ref().ok_or(Failure::Denied)?;
        let intent = guard_patch_intent(
            execution,
            &challenge.session_id,
            &challenge.principal,
            &challenge.batch_id,
            &challenge.call_id,
            &challenge.content_digest,
            &challenge.turn_context_digest,
            &challenge.challenge_id,
            &targets,
            challenge.managed_attempt_digest.as_deref(),
        );
        if intent.as_deref() != Some(challenge.argument_digest.as_str())
            || patch_manifest_digest(&targets) != challenge.content_digest
        {
            return Err(Failure::Denied);
        }
        for target in &targets {
            let (actual, mode) = if execution
                .inspect(Path::new(&target.relative_path))
                .map_err(map_io_failure)?
            {
                let (bytes, mode) = execution
                    .read_target_bytes(Path::new(&target.relative_path))
                    .map_err(map_io_failure)?;
                (Some(digest_bytes(&bytes)), Some(mode))
            } else {
                (None, None)
            };
            if actual != target.before_digest || mode != target.before_mode {
                return Err(Failure::Denied);
            }
        }
        if targets.iter().any(|target| {
            execution
                .root()
                .join(&target.relative_path)
                .to_string_lossy()
                != target.target
        }) {
            return Err(Failure::Denied);
        }
        let after_manifest = patch_after_digest(&targets);
        let lease_id = random_id("lease")?;
        let lease =
            Self::persist_prepared(&mut self.connection, &challenge, &after_manifest, &lease_id)?;
        let result = execution.apply_patch(
            lease,
            challenge_id,
            challenge.managed_attempt_digest.as_deref(),
            &targets,
        );
        if result.is_err() {
            self.mark_unknown(challenge_id)?;
            return Err(Failure::Unknown);
        }
        let mut observed = Vec::with_capacity(targets.len());
        for target in &targets {
            if target.operation == "delete" {
                observed.push((target.relative_path.as_str(), None, None));
            } else {
                let (bytes, mode) = execution
                    .read_target_bytes(Path::new(&target.relative_path))
                    .map_err(|_| Failure::Unknown)?;
                observed.push((
                    target.relative_path.as_str(),
                    Some(digest_bytes(&bytes)),
                    Some(mode),
                ));
            }
        }
        if patch_observed_digest(&observed) != after_manifest {
            self.mark_unknown(challenge_id)?;
            return Err(Failure::Unknown);
        }
        let receipt_digest = digest_bytes(
            format!("{}:{}:{}", challenge.effect_id, after_manifest, lease_id).as_bytes(),
        );
        self.persist_settled(challenge_id, &receipt_digest)?;
        Ok(map_value([
            ("status", Value::String("settled".into())),
            ("effectId", Value::String(challenge.effect_id)),
            ("receiptDigest", Value::String(receipt_digest)),
            (
                "targets",
                Value::Array(targets.iter().map(patch_target_value).collect()),
            ),
        ]))
    }

    fn reconcile_patch(&mut self, challenge: &Challenge) -> Result<(), Failure> {
        let targets = load_patch_targets(&self.connection, &challenge.challenge_id)?;
        if targets.is_empty() {
            self.mark_unknown(&challenge.challenge_id)?;
            return Ok(());
        }
        let Some(execution) = self.execution.as_ref() else {
            self.mark_unknown(&challenge.challenge_id)?;
            return Ok(());
        };
        let intent = guard_patch_intent(
            execution,
            &challenge.session_id,
            &challenge.principal,
            &challenge.batch_id,
            &challenge.call_id,
            &challenge.content_digest,
            &challenge.turn_context_digest,
            &challenge.challenge_id,
            &targets,
            challenge.managed_attempt_digest.as_deref(),
        );
        if intent.as_deref() != Some(challenge.argument_digest.as_str())
            || patch_manifest_digest(&targets) != challenge.content_digest
            || patch_after_digest(&targets) != challenge.after_digest.as_deref().unwrap_or("")
            || targets.iter().any(|target| {
                execution
                    .root()
                    .join(&target.relative_path)
                    .to_string_lossy()
                    != target.target
            })
        {
            self.mark_unknown(&challenge.challenge_id)?;
            return Ok(());
        }
        let mut all_before = true;
        let mut all_after = true;
        let mut observed_targets = Vec::with_capacity(targets.len());
        for target in &targets {
            let (observed_digest, observed_mode) = match execution
                .inspect(Path::new(&target.relative_path))
            {
                Ok(false) => (None, None),
                Ok(true) => match execution.read_target_bytes(Path::new(&target.relative_path)) {
                    Ok((bytes, mode)) => (Some(digest_bytes(&bytes)), Some(mode)),
                    Err(_) => {
                        all_before = false;
                        all_after = false;
                        continue;
                    }
                },
                Err(_) => {
                    all_before = false;
                    all_after = false;
                    continue;
                }
            };
            let expected_after = if target.operation == "delete" {
                None
            } else {
                target.after_digest.clone()
            };
            all_before &= observed_digest.as_ref() == target.before_digest.as_ref()
                && observed_mode == target.before_mode;
            all_after &=
                observed_digest.as_ref() == expected_after.as_ref() && observed_mode == target.mode;
            observed_targets.push((
                target.relative_path.as_str(),
                observed_digest,
                observed_mode,
            ));
        }
        all_after &= patch_observed_digest(&observed_targets)
            == challenge.after_digest.as_deref().unwrap_or("");
        let lease_id = match load_lease_id(&self.connection, &challenge.challenge_id)? {
            Some(lease_id) => lease_id,
            None => {
                self.mark_unknown(&challenge.challenge_id)?;
                return Ok(());
            }
        };
        if all_after {
            let receipt = digest_bytes(
                format!(
                    "{}:{}:{}",
                    challenge.effect_id,
                    challenge.after_digest.as_deref().unwrap_or(""),
                    lease_id
                )
                .as_bytes(),
            );
            self.persist_settled(&challenge.challenge_id, &receipt)?;
        } else if all_before {
            self.connection.execute("UPDATE effect_challenges SET status='NOT_APPLIED' WHERE challenge_id=?1 AND status='PREPARED'",[&challenge.challenge_id]).map_err(|_|Failure::Unavailable)?;
        } else {
            self.mark_unknown(&challenge.challenge_id)?;
        }
        Ok(())
    }
    fn resolve_approval(
        &mut self,
        process_session_id: &str,
        principal: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        let body = strict_map(body, &["sessionId", "challengeId", "approved"])?;
        // A user action records no Session binding, so an empty label is valid for it; a
        // Session-bound batch still has to match the calling process Session exactly.
        let session_id = match body.get("sessionId") {
            Some(Value::String(value)) if !value.contains('\0') => value.as_str(),
            _ => return Err(Failure::Invalid),
        };
        let challenge_id = text(body, "challengeId")?;
        validate_identifier(challenge_id)?;
        let approved = match body.get("approved") {
            Some(Value::Bool(approved)) => *approved,
            _ => return Err(Failure::Invalid),
        };
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        let challenge = load_challenge(&transaction, challenge_id)?.ok_or(Failure::NotFound)?;
        if challenge.capability_id == guard::BUILTIN_VERIFIER_ID {
            // Verifier approvals resolve only through the exact-set HostKernel path.
            // The legacy item endpoint must not mint a partial criterion lease.
            return Err(Failure::Denied);
        }
        if challenge_origin_kind(&challenge) == guard::EffectOriginKindV1::SessionBatch {
            require_session(process_session_id, session_id)?;
        }
        if challenge.session_id != session_id || challenge.principal != principal {
            return Err(Failure::Denied);
        }
        if challenge.status != "AWAITING_APPROVAL" {
            return Err(Failure::Conflict);
        }
        if challenge.expires_at_ms <= now_ms()? {
            transaction
                .execute(
                    "UPDATE effect_challenges SET status='EXPIRED' WHERE challenge_id=?1 AND status='AWAITING_APPROVAL'",
                    [challenge_id],
                )
                .map_err(|_| Failure::Unavailable)?;
            transaction.commit().map_err(|_| Failure::Unavailable)?;
            return Err(Failure::Conflict);
        }
        if approved {
            let execution = self.execution.as_ref().ok_or(Failure::Denied)?;
            let intent_digest = if challenge.capability_id == guard::FILES_PATCH_ID {
                let targets = load_patch_targets(&transaction, challenge_id)?;
                if targets.is_empty() || patch_manifest_digest(&targets) != challenge.content_digest
                {
                    return Err(Failure::Denied);
                }
                guard_patch_intent(
                    execution,
                    &challenge.session_id,
                    &challenge.principal,
                    &challenge.batch_id,
                    &challenge.call_id,
                    &challenge.content_digest,
                    &challenge.turn_context_digest,
                    &challenge.challenge_id,
                    &targets,
                    challenge.managed_attempt_digest.as_deref(),
                )
            } else if guard::is_broker_process_action(&challenge.capability_id) {
                let binding = load_broker_process_binding(&transaction, challenge_id)?
                    .ok_or(Failure::Denied)?;
                if fs::canonicalize(&binding.executable_path)
                    .ok()
                    .is_none_or(|path| {
                        path.to_str() != Some(binding.executable_path.as_str())
                            || crate::terminal_process::executable_digest(&path)
                                .ok()
                                .as_deref()
                                != Some(binding.executable_digest.as_str())
                    })
                {
                    return Err(Failure::Denied);
                }
                let (decision, intent) = guard_broker_decision(
                    execution,
                    &challenge.session_id,
                    &challenge.principal,
                    &challenge.batch_id,
                    &challenge.call_id,
                    &challenge.requested_path,
                    &challenge.resource,
                    &challenge.content_digest,
                    &binding.executable_path,
                    &binding.executable_digest,
                    &binding.profile_digest,
                    &challenge.challenge_id,
                    &challenge.capability_id,
                    challenge_origin_kind(&challenge),
                );
                if decision.decision != guard::DecisionKind::Ask {
                    return Err(Failure::Denied);
                }
                Some(intent)
            } else {
                let (decision, intent) = guard_decision(
                    execution,
                    &challenge.session_id,
                    &challenge.principal,
                    &challenge.batch_id,
                    &challenge.call_id,
                    &challenge.capability_id,
                    &challenge.requested_path,
                    &challenge.relative_path,
                    &challenge.resource,
                    &challenge.content_digest,
                    &challenge.turn_context_digest,
                    &challenge.challenge_id,
                    challenge_origin_kind(&challenge),
                    challenge.managed_attempt_digest.as_deref(),
                );
                if decision.decision != guard::DecisionKind::Ask {
                    return Err(Failure::Denied);
                }
                Some(intent)
            };
            if intent_digest.as_deref() != Some(challenge.argument_digest.as_str()) {
                return Err(Failure::Denied);
            }
        }
        let status = if approved { "APPROVED" } else { "DENIED" };
        transaction
            .execute(
                "UPDATE effect_challenges SET status=?1, approved=?2 WHERE challenge_id=?3 AND status='AWAITING_APPROVAL'",
                params![status, approved as i64, challenge_id],
            )
            .map_err(|_| Failure::Unavailable)?;
        transaction.commit().map_err(|_| Failure::Unavailable)?;
        Ok(map_value([(
            "status",
            Value::String(if approved { "approved" } else { "denied" }.to_owned()),
        )]))
    }

    /// Durably approve one complete Session ToolBatch in a single SQLite transaction.
    /// The HostKernel binds its exact Attempt effect set only after this commits, then
    /// transitions the approved challenges to the refreshed scope before minting leases.
    /// A complete all-approved retry is idempotent for recovery between these stages;
    /// partial decisions, omitted members and changed intents are conflicts.
    pub(crate) fn resolve_batch_approval_set(
        &mut self,
        process_session_id: &str,
        principal: &str,
        batch_id: &str,
        challenge_ids: &[String],
    ) -> Result<(), TypedErrorV1> {
        self.resolve_batch_approval_set_inner(
            process_session_id,
            principal,
            batch_id,
            challenge_ids,
        )
        .map_err(Failure::error)
    }

    fn resolve_batch_approval_set_inner(
        &mut self,
        process_session_id: &str,
        principal: &str,
        batch_id: &str,
        challenge_ids: &[String],
    ) -> Result<(), Failure> {
        validate_identifier(batch_id)?;
        if challenge_ids.is_empty() || challenge_ids.len() > MAX_TOOL_BATCH_CALLS {
            return Err(Failure::Invalid);
        }
        let mut supplied = HashSet::with_capacity(challenge_ids.len());
        if challenge_ids.iter().any(|id| {
            validate_identifier(id).is_err() || !supplied.insert(id.as_str())
        }) {
            return Err(Failure::Invalid);
        }
        let now = now_ms()?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        let rows = {
            let mut statement = transaction
                .prepare(
                    "SELECT challenge_id FROM effect_challenges
                     WHERE batch_id=?1 AND session_id=?2 AND principal=?3",
                )
                .map_err(|_| Failure::Unavailable)?;
            let mapped = statement
                .query_map(params![batch_id, process_session_id, principal], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|_| Failure::Unavailable)?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| Failure::Unavailable)?
        };
        if rows.len() != challenge_ids.len()
            || rows.iter().any(|id| !supplied.contains(id.as_str()))
        {
            return Err(Failure::Denied);
        }
        let mut challenges = Vec::with_capacity(rows.len());
        for challenge_id in &rows {
            let challenge = load_challenge(&transaction, challenge_id)?
                .ok_or(Failure::NotFound)?;
            if challenge.batch_id != batch_id
                || challenge.session_id != process_session_id
                || challenge.principal != principal
                || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::SessionBatch
                || !matches!(
                    challenge.status.as_str(),
                    "AWAITING_APPROVAL" | "APPROVED"
                )
                || challenge
                    .managed_attempt_digest
                    .as_deref()
                    .is_some_and(|digest| !is_blake3_digest(digest))
            {
                return Err(Failure::Conflict);
            }
            challenges.push(challenge);
        }
        if challenges.iter().any(|challenge| challenge.expires_at_ms <= now) {
            for challenge in &challenges {
                transaction
                    .execute(
                        "UPDATE effect_challenges SET status='EXPIRED',approved=NULL
                         WHERE challenge_id=?1 AND status='AWAITING_APPROVAL'",
                        [&challenge.challenge_id],
                    )
                    .map_err(|_| Failure::Unavailable)?;
            }
            transaction.commit().map_err(|_| Failure::Unavailable)?;
            return Err(Failure::Conflict);
        }
        let already_approved = challenges
            .iter()
            .all(|challenge| challenge.status == "APPROVED");
        if already_approved {
            let all_durable_approvals: bool = challenges.iter().all(|challenge| {
                transaction
                    .query_row(
                        "SELECT approved=1 AND lease_id IS NULL AND capability_lease_digest IS NULL
                         FROM effect_challenges WHERE challenge_id=?1",
                        [&challenge.challenge_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(false)
            });
            if !all_durable_approvals {
                return Err(Failure::Conflict);
            }
            transaction.commit().map_err(|_| Failure::Unavailable)?;
            return Ok(());
        }
        if challenges
            .iter()
            .any(|challenge| challenge.status != "AWAITING_APPROVAL")
        {
            return Err(Failure::Conflict);
        }
        let execution = self.execution.as_ref().ok_or(Failure::Denied)?;
        for challenge in &challenges {
            let intent_digest = if challenge.capability_id == guard::FILES_PATCH_ID {
                let targets = load_patch_targets(&transaction, &challenge.challenge_id)?;
                if targets.is_empty()
                    || patch_manifest_digest(&targets) != challenge.content_digest
                {
                    return Err(Failure::Denied);
                }
                guard_patch_intent(
                    execution,
                    &challenge.session_id,
                    &challenge.principal,
                    &challenge.batch_id,
                    &challenge.call_id,
                    &challenge.content_digest,
                    &challenge.turn_context_digest,
                    &challenge.challenge_id,
                    &targets,
                    challenge.managed_attempt_digest.as_deref(),
                )
            } else {
                let (decision, intent) = guard_decision(
                    execution,
                    &challenge.session_id,
                    &challenge.principal,
                    &challenge.batch_id,
                    &challenge.call_id,
                    &challenge.capability_id,
                    &challenge.requested_path,
                    &challenge.relative_path,
                    &challenge.resource,
                    &challenge.content_digest,
                    &challenge.turn_context_digest,
                    &challenge.challenge_id,
                    challenge_origin_kind(challenge),
                    challenge.managed_attempt_digest.as_deref(),
                );
                if decision.decision != guard::DecisionKind::Ask {
                    return Err(Failure::Denied);
                }
                Some(intent)
            };
            if intent_digest.as_deref() != Some(challenge.argument_digest.as_str()) {
                return Err(Failure::Denied);
            }
        }
        for challenge in &challenges {
            let changed = transaction
                .execute(
                    "UPDATE effect_challenges SET status='APPROVED',approved=1
                     WHERE challenge_id=?1 AND batch_id=?2 AND session_id=?3 AND principal=?4
                       AND status='AWAITING_APPROVAL' AND expires_at_ms>?5",
                    params![
                        challenge.challenge_id,
                        batch_id,
                        process_session_id,
                        principal,
                        now as i64
                    ],
                )
                .map_err(|_| Failure::Unavailable)?;
            if changed != 1 {
                return Err(Failure::Conflict);
            }
        }
        transaction.commit().map_err(|_| Failure::Unavailable)
    }

    /// Atomically records a complete managed-verifier challenge-set resolution. A full
    /// allow set transitions every member together; aborts persist only actual decisions
    /// supplied by the authenticated reviewer and close every unseen member as a system
    /// outcome. Lease material is minted by HostKernel only after this transaction commits.
    pub(crate) fn resolve_managed_run_approval_set(
        &mut self,
        principal: &str,
        decisions: &[(String, Option<bool>)],
        abort_reason: Option<ManagedRunApprovalAbortReasonV1>,
    ) -> Result<(), TypedErrorV1> {
        let fail = |failure: Failure| failure.error();
        if decisions.is_empty() || decisions.len() > 32 {
            return Err(Failure::Invalid.error());
        }
        let mut seen = HashSet::with_capacity(decisions.len());
        if decisions.iter().any(|(id, _)| !seen.insert(id.as_str())) {
            return Err(Failure::Invalid.error());
        }
        let all_allow = abort_reason.is_none()
            && decisions
                .iter()
                .all(|(_, decision)| *decision == Some(true));
        if !all_allow && abort_reason.is_none() {
            return Err(Failure::Invalid.error());
        }
        if matches!(
            abort_reason,
            Some(ManagedRunApprovalAbortReasonV1::ReviewerDenied)
        ) != decisions
            .iter()
            .any(|(_, decision)| *decision == Some(false))
        {
            return Err(Failure::Invalid.error());
        }

        let now = now_ms().map_err(fail)?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let mut challenges = Vec::with_capacity(decisions.len());
        for (challenge_id, _) in decisions {
            validate_identifier(challenge_id).map_err(fail)?;
            let challenge = load_challenge(&transaction, challenge_id)
                .map_err(fail)?
                .ok_or_else(|| Failure::NotFound.error())?;
            if challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::ManagedRun
                || challenge.capability_id != guard::BUILTIN_VERIFIER_ID
                || challenge.principal != principal
                || challenge.status != "AWAITING_APPROVAL"
            {
                return Err(Failure::Conflict.error());
            }
            challenges.push(challenge);
        }

        let expired = challenges
            .iter()
            .any(|challenge| challenge.expires_at_ms <= now);
        if expired && abort_reason.is_none() {
            for challenge in &challenges {
                transaction
                    .execute(
                        "UPDATE effect_challenges SET status='EXPIRED',approved=NULL WHERE challenge_id=?1 AND status='AWAITING_APPROVAL'",
                        [&challenge.challenge_id],
                    )
                    .map_err(|_| Failure::Unavailable.error())?;
            }
            transaction
                .commit()
                .map_err(|_| Failure::Unavailable.error())?;
            return Err(Failure::Conflict.error());
        }
        if all_allow {
            let execution = self
                .execution
                .as_ref()
                .ok_or_else(|| Failure::Denied.error())?;
            for challenge in &challenges {
                let binding = load_broker_process_binding(&transaction, &challenge.challenge_id)
                    .map_err(fail)?
                    .ok_or_else(|| Failure::Denied.error())?;
                let executable = fs::canonicalize(&binding.executable_path)
                    .map_err(|_| Failure::Denied.error())?;
                if executable.to_str() != Some(binding.executable_path.as_str())
                    || crate::terminal_process::executable_digest(&executable)
                        .map_err(|_| Failure::Denied.error())?
                        != binding.executable_digest
                {
                    return Err(Failure::Denied.error());
                }
                let (decision, intent) = guard_broker_decision(
                    execution,
                    &challenge.session_id,
                    principal,
                    &challenge.batch_id,
                    &challenge.call_id,
                    &challenge.requested_path,
                    &challenge.resource,
                    &challenge.content_digest,
                    &binding.executable_path,
                    &binding.executable_digest,
                    &binding.profile_digest,
                    &challenge.challenge_id,
                    &challenge.capability_id,
                    guard::EffectOriginKindV1::ManagedRun,
                    challenge.managed_attempt_digest.as_deref(),
                );
                if decision.decision != guard::DecisionKind::Ask
                    || intent != challenge.argument_digest
                {
                    return Err(Failure::Denied.error());
                }
            }
            for challenge in &challenges {
                let changed = transaction
                    .execute(
                        "UPDATE effect_challenges SET status='APPROVED',approved=1 WHERE challenge_id=?1 AND status='AWAITING_APPROVAL' AND expires_at_ms>?2",
                        params![challenge.challenge_id, now as i64],
                    )
                    .map_err(|_| Failure::Unavailable.error())?;
                if changed != 1 {
                    return Err(Failure::Conflict.error());
                }
            }
        } else {
            let reason = abort_reason.ok_or_else(|| Failure::Invalid.error())?;
            for (challenge, (_, actual)) in challenges.iter().zip(decisions) {
                let status = match (reason, actual) {
                    (ManagedRunApprovalAbortReasonV1::ReviewerDenied, Some(false)) => "DENIED",
                    (ManagedRunApprovalAbortReasonV1::ReviewerDenied, _) => {
                        "ABORTED_BY_REVIEWER_DECISION"
                    }
                    (ManagedRunApprovalAbortReasonV1::Cancelled, _) => "CANCELLED",
                    (ManagedRunApprovalAbortReasonV1::Expired, _) => "EXPIRED",
                    (ManagedRunApprovalAbortReasonV1::TransportLost, _) => "ABORTED_BY_TRANSPORT",
                };
                let approved = actual.map(i64::from);
                let changed = transaction
                    .execute(
                        "UPDATE effect_challenges SET status=?1,approved=?2 WHERE challenge_id=?3 AND status='AWAITING_APPROVAL'",
                        params![status, approved, challenge.challenge_id],
                    )
                    .map_err(|_| Failure::Unavailable.error())?;
                if changed != 1 {
                    return Err(Failure::Conflict.error());
                }
            }
        }
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())?;
        Ok(())
    }

    fn execute_write(
        &mut self,
        process_session_id: &str,
        principal: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        let body = strict_map_optional(
            body,
            &["sessionId", "challengeId", "content"],
            &["managedAttempt", "directAttempt"],
        )?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
        let challenge_id = text(body, "challengeId")?;
        validate_identifier(challenge_id)?;
        let content = text(body, "content")?;
        validate_content(content)?;
        let challenge = load_challenge(&self.connection, challenge_id)?.ok_or(Failure::NotFound)?;
        let supplied_scope = parse_effect_attempt_scope_digest(body, session_id)?;
        if supplied_scope != challenge.managed_attempt_digest {
            return Err(Failure::Denied);
        }
        // The write executor is bound to exactly one capability. A challenge admitted for
        // any other action (terminal run/start or patch) is refused here, before status,
        // digest or workspace checks, so no other action's durable state can be replayed
        // through the write path even if its row were tampered with.
        if challenge.capability_id != guard::FILES_WRITE_ID {
            return Err(Failure::Denied);
        }
        if challenge.session_id != session_id || challenge.principal != principal {
            return Err(Failure::Denied);
        }
        if challenge.status != "APPROVED" {
            return Err(Failure::Conflict);
        }
        if challenge.expires_at_ms <= now_ms()? {
            self.connection
                .execute(
                    "UPDATE effect_challenges SET status='EXPIRED' WHERE challenge_id=?1 AND status='APPROVED'",
                    [challenge_id],
                )
                .map_err(|_| Failure::Unavailable)?;
            return Err(Failure::Conflict);
        }
        let proposed_content_digest = digest_bytes(content.as_bytes());
        if proposed_content_digest != challenge.content_digest {
            return Err(Failure::Denied);
        }
        let (decision, intent_digest) = {
            let execution = self.execution.as_ref().ok_or(Failure::Denied)?;
            guard_decision(
                execution,
                &challenge.session_id,
                &challenge.principal,
                &challenge.batch_id,
                &challenge.call_id,
                &challenge.capability_id,
                &challenge.requested_path,
                &challenge.relative_path,
                &challenge.resource,
                &challenge.content_digest,
                &challenge.turn_context_digest,
                &challenge.challenge_id,
                challenge_origin_kind(&challenge),
                challenge.managed_attempt_digest.as_deref(),
            )
        };
        if decision.decision != guard::DecisionKind::Ask
            || intent_digest != challenge.argument_digest
        {
            return Err(Failure::Denied);
        }
        let (preflight_identity, target_had_bom) = {
            let execution = self.execution.as_ref().ok_or(Failure::Denied)?;
            if execution
                .root()
                .join(&challenge.relative_path)
                .to_string_lossy()
                != challenge.target
            {
                return Err(Failure::Denied);
            }
            let target = execution
                .prepare_write(Path::new(&challenge.relative_path), challenge.existed)
                .map_err(map_io_failure)?;
            let identity = target.identity().map_err(map_io_failure)?;
            let has_bom = match target.existing.as_ref() {
                Some(file) => has_bom(file).map_err(map_io_failure)?,
                None => false,
            };
            (identity, has_bom)
        };
        let output: Cow<'_, [u8]> = if !target_had_bom && !content.starts_with('\u{feff}') {
            Cow::Borrowed(content.as_bytes())
        } else {
            let stripped_content = content.trim_start_matches('\u{feff}');
            let mut output = Vec::with_capacity(stripped_content.len() + BOM.len());
            output.extend_from_slice(BOM);
            output.extend_from_slice(stripped_content.as_bytes());
            Cow::Owned(output)
        };
        let after_digest = digest_bytes(output.as_ref());
        let lease_id = random_id("lease")?;
        let lease =
            Self::persist_prepared(&mut self.connection, &challenge, &after_digest, &lease_id)?;

        // The durable intent and one-use lease exist before ExecutionHost reopens the target.
        // Any subsequent ambiguity blocks this challenge as UNKNOWN instead of retrying.
        let target_result = {
            let execution = self.execution.as_ref().ok_or(Failure::Unknown)?;
            execution
                .prepare_write(Path::new(&challenge.relative_path), challenge.existed)
                .map_err(|_| Failure::Unknown)
                .and_then(|target| {
                    if target.identity().map_err(|_| Failure::Unknown)? != preflight_identity {
                        return Err(Failure::Unknown);
                    }
                    Ok(target)
                })
        };
        let target = match target_result {
            Ok(target) => target,
            Err(_) => {
                self.mark_unknown(challenge_id)?;
                return Err(Failure::Unknown);
            }
        };
        let write_result = {
            let execution = self.execution.as_ref().ok_or(Failure::Unknown)?;
            execution.write(
                lease,
                challenge_id,
                challenge.managed_attempt_digest.as_deref(),
                target,
                output.as_ref(),
            )
        };
        let lease_id = match write_result {
            Ok(lease_id) => lease_id,
            Err(_) => {
                self.mark_unknown(challenge_id)?;
                return Err(Failure::Unknown);
            }
        };
        let observed = self
            .execution
            .as_ref()
            .ok_or(Failure::Unknown)?
            .digest(Path::new(&challenge.relative_path));
        if !matches!(observed.as_deref(), Ok(digest) if digest == after_digest.as_str()) {
            self.mark_unknown(challenge_id)?;
            return Err(Failure::Unknown);
        }
        let receipt_digest = receipt_digest(
            &challenge.effect_id,
            &challenge.target,
            &challenge.resource,
            challenge.existed,
            &after_digest,
            &lease_id,
        );
        self.persist_settled(challenge_id, &receipt_digest)?;
        Ok(map_value([
            ("status", Value::String("settled".to_owned())),
            ("effectId", Value::String(challenge.effect_id)),
            ("receiptDigest", Value::String(receipt_digest)),
            ("target", Value::String(challenge.target)),
            ("resource", Value::String(challenge.resource)),
            ("existed", Value::Bool(challenge.existed)),
        ]))
    }

    fn persist_prepared(
        connection: &mut Connection,
        challenge: &Challenge,
        after_digest: &str,
        lease_id: &str,
    ) -> Result<ExecutionLease, Failure> {
        let transaction = connection.transaction().map_err(|_| Failure::Unavailable)?;
        let changed = transaction
            .execute(
                "UPDATE effect_challenges
                 SET status='PREPARED', after_digest=?1, lease_id=?2
                 WHERE challenge_id=?3 AND session_id=?4 AND status='APPROVED' AND expires_at_ms>?5",
                params![
                    after_digest,
                    lease_id,
                    challenge.challenge_id,
                    challenge.session_id,
                    now_ms()? as i64,
                ],
            )
            .map_err(|_| Failure::Unavailable)?;
        if changed != 1 {
            return Err(Failure::Conflict);
        }
        transaction.commit().map_err(|_| Failure::Unavailable)?;
        Ok(ExecutionLease {
            challenge_id: challenge.challenge_id.clone(),
            lease_id: lease_id.to_owned(),
            managed_attempt_digest: challenge.managed_attempt_digest.clone(),
        })
    }

    fn persist_settled(&mut self, challenge_id: &str, receipt_digest: &str) -> Result<(), Failure> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        let changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='SETTLED', receipt_digest=?1
                 WHERE challenge_id=?2 AND status IN ('PREPARED', 'UNKNOWN')",
                params![receipt_digest, challenge_id],
            )
            .map_err(|_| Failure::Unavailable)?;
        if changed != 1 {
            return Err(Failure::Unknown);
        }
        transaction.commit().map_err(|_| Failure::Unavailable)
    }

    fn mark_unknown(&mut self, challenge_id: &str) -> Result<(), Failure> {
        self.connection
            .execute(
                "UPDATE effect_challenges SET status='UNKNOWN'
                 WHERE challenge_id=?1 AND status='PREPARED'",
                [challenge_id],
            )
            .map_err(|_| Failure::Unavailable)?;
        Ok(())
    }

    fn reconcile_stdio_executions(&mut self) -> Result<(), Failure> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        transaction
            .execute(
                "UPDATE stdio_executions SET status='UNKNOWN',updated_at_ms=?1
                 WHERE status IN ('PREPARED','RUNNING','CANCELLING')",
                [now_ms()? as i64],
            )
            .map_err(|_| Failure::Unavailable)?;
        transaction
            .execute(
                "UPDATE effect_challenges SET status='UNKNOWN'
                 WHERE challenge_id IN (SELECT challenge_id FROM stdio_executions WHERE status='UNKNOWN')
                   AND status IN ('PREPARED','UNKNOWN')",
                [],
            )
            .map_err(|_| Failure::Unavailable)?;
        transaction.commit().map_err(|_| Failure::Unavailable)
    }

    fn reconcile_prepared(&mut self) -> Result<(), Failure> {
        // Managed-run approval bindings and lease digests are owner-epoch scoped. On
        // restart, close pending and approved broker challenges before serving requests;
        // the previous HostKernel's ephemeral exact-set membership/leases cannot revive.
        self.connection
            .execute(
                "UPDATE effect_challenges SET status='EXPIRED',approved=NULL,lease_id=NULL
                 WHERE origin_kind=?1 AND capability_id=?2 AND status IN ('AWAITING_APPROVAL','APPROVED')",
                params![ORIGIN_MANAGED_RUN, guard::BUILTIN_VERIFIER_ID],
            )
            .map_err(|_| Failure::Unavailable)?;
        self.connection
            .execute(
                "UPDATE effect_challenges SET status='EXPIRED',approved=NULL,lease_id=NULL
                 WHERE origin_kind=?1 AND capability_id IN (?2,?3,?4)
                   AND status IN ('AWAITING_APPROVAL','APPROVED')",
                params![
                    ORIGIN_USER_ACTION,
                    guard::GIT_WORKTREE_ACQUIRE_ID,
                    guard::GIT_WORKTREE_LIST_ID,
                    guard::GIT_WORKTREE_RELEASE_ID,
                ],
            )
            .map_err(|_| Failure::Unavailable)?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
                        relative_path, requested_path, target, resource, existed, argument_digest,
                        content_digest, expires_at_ms, status, after_digest, turn_context_digest, principal, origin_kind, managed_attempt_digest
                 FROM effect_challenges WHERE status IN ('PREPARED', 'UNKNOWN') ORDER BY challenge_id",
            )
            .map_err(|_| Failure::Unavailable)?;
        let rows = statement
            .query_map([], row_to_challenge)
            .map_err(|_| Failure::Unavailable)?;
        let challenges = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Failure::Unavailable)?;
        drop(statement);
        for challenge in challenges {
            if guard::is_broker_process_action(&challenge.capability_id) {
                self.mark_unknown(&challenge.challenge_id)?;
                continue;
            }
            if challenge.capability_id == guard::TERMINAL_RUN_ID
                || challenge.capability_id == guard::TERMINAL_START_ID
            {
                self.mark_terminal_run_unknown(&challenge.effect_id)?;
                continue;
            }
            if challenge.capability_id == guard::FILES_PATCH_ID {
                self.reconcile_patch(&challenge)?;
                continue;
            }
            let after_digest = challenge.after_digest.clone();
            let can_settle = match (self.execution.as_ref(), after_digest.as_deref()) {
                (Some(execution), Some(after_digest))
                    if execution
                        .root()
                        .join(&challenge.relative_path)
                        .to_string_lossy()
                        == challenge.target =>
                {
                    let (decision, intent_digest) = guard_decision(
                        execution,
                        &challenge.session_id,
                        &challenge.principal,
                        &challenge.batch_id,
                        &challenge.call_id,
                        &challenge.capability_id,
                        &challenge.requested_path,
                        &challenge.relative_path,
                        &challenge.resource,
                        &challenge.content_digest,
                        &challenge.turn_context_digest,
                        &challenge.challenge_id,
                        challenge_origin_kind(&challenge),
                        challenge.managed_attempt_digest.as_deref(),
                    );
                    decision.decision == guard::DecisionKind::Ask
                        && intent_digest == challenge.argument_digest
                        && matches!(
                            execution.digest(Path::new(&challenge.relative_path)).as_deref(),
                            Ok(digest) if digest == after_digest
                        )
                }
                _ => false,
            };
            if !can_settle {
                self.mark_unknown(&challenge.challenge_id)?;
                continue;
            }
            let after_digest = after_digest.as_deref().ok_or(Failure::Unknown)?;
            let lease_id = load_lease_id(&self.connection, &challenge.challenge_id)?
                .ok_or(Failure::Unknown)?;
            let receipt = receipt_digest(
                &challenge.effect_id,
                &challenge.target,
                &challenge.resource,
                challenge.existed,
                after_digest,
                &lease_id,
            );
            self.persist_settled(&challenge.challenge_id, &receipt)?;
        }
        Ok(())
    }
}

fn stdio_arguments_match_approval(approved_digest: &str, challenge_digest: &str) -> bool {
    is_blake3_digest(approved_digest) && approved_digest == challenge_digest
}

fn load_challenge(
    connection: &Connection,
    challenge_id: &str,
) -> Result<Option<Challenge>, Failure> {
    connection
        .query_row(
            "SELECT challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
                    relative_path, requested_path, target, resource, existed, argument_digest,
                    content_digest, expires_at_ms, status, after_digest, turn_context_digest, principal, origin_kind, managed_attempt_digest
             FROM effect_challenges WHERE challenge_id=?1",
            [challenge_id],
            row_to_challenge,
        )
        .optional()
        .map_err(|_| Failure::Unavailable)
}

fn load_effect(connection: &Connection, effect_id: &str) -> Result<Option<Challenge>, Failure> {
    connection
        .query_row(
            "SELECT challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
                    relative_path, requested_path, target, resource, existed, argument_digest,
                    content_digest, expires_at_ms, status, after_digest, turn_context_digest, principal, origin_kind, managed_attempt_digest
             FROM effect_challenges WHERE effect_id=?1",
            [effect_id],
            row_to_challenge,
        )
        .optional()
        .map_err(|_| Failure::Unavailable)
}

/// The origin kind recorded when the challenge was admitted. It is never re-derived from
/// caller-supplied values, so an admitted batch effect can never be re-decided as a user
/// action (or the reverse).
struct BrokerProcessBinding {
    profile_id: String,
    executable_path: String,
    executable_digest: String,
    profile_digest: String,
}

fn load_broker_process_binding(
    connection: &Connection,
    challenge_id: &str,
) -> Result<Option<BrokerProcessBinding>, Failure> {
    connection
        .query_row(
            "SELECT profile_id,executable_path,executable_digest,profile_digest FROM broker_process_bindings WHERE challenge_id=?1",
            [challenge_id],
            |row| {
                Ok(BrokerProcessBinding {
                    profile_id: row.get(0)?,
                    executable_path: row.get(1)?,
                    executable_digest: row.get(2)?,
                    profile_digest: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|_| Failure::Unavailable)
}

/// Broker process capabilities admitted only from crate-private HostKernel
/// authorizations. This deliberately excludes the wider Guard action family;
/// adding an action here does not expose a model-facing process launcher.
fn is_git_worktree_capability(capability_id: &str) -> bool {
    matches!(
        capability_id,
        guard::GIT_WORKTREE_ACQUIRE_ID
            | guard::GIT_WORKTREE_LIST_ID
            | guard::GIT_WORKTREE_RELEASE_ID
    )
}

fn challenge_origin_kind(challenge: &Challenge) -> guard::EffectOriginKindV1 {
    match challenge.origin_kind.as_str() {
        ORIGIN_USER_ACTION => guard::EffectOriginKindV1::UserAction,
        ORIGIN_MANAGED_RUN => guard::EffectOriginKindV1::ManagedRun,
        _ => guard::EffectOriginKindV1::SessionBatch,
    }
}

fn attempt_scope_digest(
    scope: Option<&EffectAttemptScopeV1>,
    session_id: &str,
) -> Result<Option<String>, Failure> {
    let Some(scope) = scope else {
        return Ok(None);
    };
    let bound_session = match scope {
        EffectAttemptScopeV1::Managed(scope) => &scope.session_id,
        EffectAttemptScopeV1::Direct(scope) => &scope.child_session_id,
    };
    if bound_session != session_id {
        return Err(Failure::Denied);
    }
    scope.digest().map(Some).map_err(|_| Failure::Invalid)
}

fn parse_effect_attempt_scope_digest(
    fields: &BTreeMap<String, Value>,
    session_id: &str,
) -> Result<Option<String>, Failure> {
    let scope = EffectAttemptScopeV1::from_fields(fields);
    if !fields.contains_key("managedAttempt") && !fields.contains_key("directAttempt") {
        return Ok(None);
    }
    let scope = scope.ok_or(Failure::Invalid)?;
    attempt_scope_digest(Some(&scope), session_id)
}

fn guard_decision(
    execution: &ExecutionHost,
    session_id: &str,
    principal: &str,
    batch_id: &str,
    call_id: &str,
    capability_id: &str,
    requested_path: &str,
    relative_path: &str,
    resource: &str,
    content_digest: &str,
    turn_context_digest: &str,
    challenge_id: &str,
    origin_kind: guard::EffectOriginKindV1,
    managed_attempt_digest: Option<&str>,
) -> (guard::GuardDecisionV1, String) {
    let target = if relative_path == "." {
        execution.root().to_owned()
    } else {
        execution.root().join(relative_path)
    };
    let argument_digest = guard::argument_digest(
        session_id,
        batch_id,
        call_id,
        capability_id,
        requested_path,
        content_digest,
    );
    let policy_snapshot_ids = [guard::WORKSPACE_WRITE_POLICY_ID];
    let requested_guarantees = [
        "beneath_workspace_root",
        "no_symlink",
        "no_hardlink",
        "one_use",
    ];
    let request = guard::AuthorizationRequestV1 {
        request_id: batch_id,
        principal,
        origin: guard::EffectOriginV1 {
            kind: origin_kind,
            session_id,
            batch_id,
            call_id,
        },
        action_id: capability_id,
        argument_digest: &argument_digest,
        turn_context_digest,
        resource_resolution: guard::ResourceResolutionV1 {
            workspace_root: execution.root(),
            workspace_binding: execution.workspace_binding(),
            target: &target,
            resource,
        },
        executable: None,
        policy_snapshot_ids: &policy_snapshot_ids,
        requested_guarantees: &requested_guarantees,
    };
    let decision = guard::authorize(&request, challenge_id);
    let intent_digest =
        guard::intent_digest_with_managed_scope(&request, &decision, managed_attempt_digest);
    (decision, intent_digest)
}

fn guard_broker_decision(
    execution: &ExecutionHost,
    session_id: &str,
    principal: &str,
    batch_id: &str,
    call_id: &str,
    requested_path: &str,
    resource: &str,
    argument_bundle_digest: &str,
    executable_path: &str,
    executable_digest: &str,
    profile_digest: &str,
    challenge_id: &str,
    capability_id: &str,
    origin_kind: guard::EffectOriginKindV1,
    managed_attempt_digest: Option<&str>,
) -> (guard::GuardDecisionV1, String) {
    let target = execution.root().to_owned();
    let argument_digest = guard::argument_digest(
        session_id,
        batch_id,
        call_id,
        capability_id,
        requested_path,
        argument_bundle_digest,
    );
    let policy_snapshot_ids = [guard::BROKER_PROCESS_POLICY_ID];
    let request = guard::AuthorizationRequestV1 {
        request_id: batch_id,
        principal,
        origin: guard::EffectOriginV1 {
            kind: origin_kind,
            session_id,
            batch_id,
            call_id,
        },
        action_id: capability_id,
        argument_digest: &argument_digest,
        turn_context_digest: "",
        resource_resolution: guard::ResourceResolutionV1 {
            workspace_root: execution.root(),
            workspace_binding: execution.workspace_binding(),
            target: &target,
            resource,
        },
        executable: Some(guard::ExecutableResolutionV1 {
            requested_path: executable_path,
            resolved_path: executable_path,
            digest: executable_digest,
            profile_digest,
        }),
        policy_snapshot_ids: &policy_snapshot_ids,
        requested_guarantees: guard::BROKER_GUARANTEES,
    };
    let decision = guard::authorize(&request, challenge_id);
    let intent = guard::intent_digest_with_managed_scope(
        &request,
        &decision,
        managed_attempt_digest,
    );
    (decision, intent)
}
fn parse_terminal_start_arguments(
    value: &Value,
    root: &Path,
) -> Result<TerminalArguments, Failure> {
    let fields = strict_map(
        value,
        &[
            "terminalID",
            "shellProfileID",
            "command",
            "args",
            "cwd",
            "cols",
            "rows",
            "env",
        ],
    )?;
    let terminal_id = text(fields, "terminalID")?;
    validate_identifier(terminal_id)?;
    let profile = text(fields, "shellProfileID")?;
    if profile.len() != 68
        || !profile.starts_with("shp_")
        || !profile[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(Failure::Invalid);
    }
    let command = text(fields, "command")?;
    if command.len() > 64 * 1024 || command.contains('\0') {
        return Err(Failure::Invalid);
    }
    let Value::Array(args) = fields.get("args").ok_or(Failure::Invalid)? else {
        return Err(Failure::Invalid);
    };
    if args.len() > 256 {
        return Err(Failure::Invalid);
    }
    let mut arg_bytes = 0usize;
    for arg in args {
        let Value::String(arg) = arg else {
            return Err(Failure::Invalid);
        };
        if arg.contains('\0') {
            return Err(Failure::Invalid);
        }
        arg_bytes = arg_bytes.checked_add(arg.len()).ok_or(Failure::Invalid)?;
    }
    if arg_bytes > 256 * 1024 {
        return Err(Failure::Invalid);
    }
    let cwd = text(fields, "cwd")?;
    if cwd.len() > 4096 || !Path::new(cwd).is_absolute() || cwd.contains('\0') {
        return Err(Failure::Invalid);
    }
    let canonical_cwd = fs::canonicalize(cwd).map_err(|_| Failure::Denied)?;
    if canonical_cwd.to_str() != Some(cwd)
        || !canonical_cwd.starts_with(root)
        || !fs::metadata(&canonical_cwd).is_ok_and(|metadata| metadata.is_dir())
    {
        return Err(Failure::Denied);
    }
    let (relative_path, resource) = if canonical_cwd == root {
        (PathBuf::from("."), ".".to_owned())
    } else {
        let relative = canonical_cwd
            .strip_prefix(root)
            .map_err(|_| Failure::Denied)?;
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(Failure::Denied);
        }
        let text = relative
            .to_str()
            .ok_or(Failure::Invalid)?
            .replace('\\', "/");
        (relative.to_owned(), text)
    };
    for (key, max) in [("cols", 500), ("rows", 300)] {
        match fields.get(key) {
            Some(Value::Unsigned(value)) if (1..=max).contains(value) => {}
            _ => return Err(Failure::Invalid),
        }
    }
    let Value::Map(environment) = fields.get("env").ok_or(Failure::Invalid)? else {
        return Err(Failure::Invalid);
    };
    if environment.len() > 128 {
        return Err(Failure::Invalid);
    }
    let mut environment_bytes = 0usize;
    for (key, value) in environment {
        let Value::String(value) = value else {
            return Err(Failure::Invalid);
        };
        if !valid_environment_key(key)
            || value.contains('\0')
            || matches!(
                key.as_str(),
                "BASH_ENV" | "ENV" | "SHELLOPTS" | "BASHOPTS" | "IFS"
            )
            || key.starts_with("LD_")
        {
            return Err(Failure::Invalid);
        }
        environment_bytes = environment_bytes
            .checked_add(key.len())
            .and_then(|size| size.checked_add(value.len()))
            .ok_or(Failure::Invalid)?;
    }
    if environment_bytes > 64 * 1024 {
        return Err(Failure::Invalid);
    }
    let encoded = messagepack::encode(value, FRAME_LIMITS).map_err(|_| Failure::Invalid)?;
    Ok(TerminalArguments {
        cwd: cwd.to_owned(),
        relative_path: relative_path.to_string_lossy().into_owned(),
        resource,
        digest: format!("blake3:{}", blake3::hash(&encoded).to_hex()),
    })
}

fn parse_terminal_arguments(value: &Value, root: &Path) -> Result<TerminalArguments, Failure> {
    let fields = strict_map(
        value,
        &[
            "shellProfileID",
            "command",
            "cwd",
            "timeoutMs",
            "resolvedEnvironment",
        ],
    )?;
    let shell_profile_id = text(fields, "shellProfileID")?;
    if shell_profile_id.len() != 68
        || !shell_profile_id.starts_with("shp_")
        || !shell_profile_id[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(Failure::Invalid);
    }
    let command = text(fields, "command")?;
    if command.len() > 64 * 1024 || command.contains('\0') || command.is_empty() {
        return Err(Failure::Invalid);
    }
    let cwd = text(fields, "cwd")?;
    if cwd.len() > 4096 || !Path::new(cwd).is_absolute() || cwd.contains('\0') {
        return Err(Failure::Invalid);
    }
    let canonical_cwd = fs::canonicalize(cwd).map_err(|_| Failure::Denied)?;
    if canonical_cwd.to_str() != Some(cwd)
        || !canonical_cwd.starts_with(root)
        || !fs::metadata(&canonical_cwd).is_ok_and(|metadata| metadata.is_dir())
    {
        return Err(Failure::Denied);
    }
    let (relative_path, resource) = if canonical_cwd == root {
        (PathBuf::from("."), ".".to_owned())
    } else {
        let relative = canonical_cwd
            .strip_prefix(root)
            .map_err(|_| Failure::Denied)?;
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(Failure::Denied);
        }
        let text = relative
            .to_str()
            .ok_or(Failure::Invalid)?
            .replace('\\', "/");
        (relative.to_owned(), text)
    };
    let timeout_ms = match fields.get("timeoutMs") {
        Some(Value::Unsigned(value)) if (1..=600_000).contains(value) => *value,
        _ => return Err(Failure::Invalid),
    };
    let environment_value = fields.get("resolvedEnvironment").ok_or(Failure::Invalid)?;
    let Value::Map(environment_fields) = environment_value else {
        return Err(Failure::Invalid);
    };
    if environment_fields.len() > 128 {
        return Err(Failure::Invalid);
    }
    let mut environment = BTreeMap::new();
    let mut environment_bytes = 0usize;
    for (key, value) in environment_fields {
        let Value::String(value) = value else {
            return Err(Failure::Invalid);
        };
        if !valid_environment_key(key)
            || value.contains('\0')
            || matches!(
                key.as_str(),
                "BASH_ENV" | "ENV" | "SHELLOPTS" | "BASHOPTS" | "IFS"
            )
            || key.starts_with("LD_")
        {
            return Err(Failure::Invalid);
        }
        environment_bytes = environment_bytes
            .checked_add(key.len())
            .and_then(|size| size.checked_add(value.len()))
            .ok_or(Failure::Invalid)?;
        if environment_bytes > 64 * 1024 {
            return Err(Failure::Invalid);
        }
        environment.insert(key.clone(), value.clone());
    }
    let digest =
        terminal_arguments_digest(shell_profile_id, command, cwd, timeout_ms, &environment);
    Ok(TerminalArguments {
        cwd: cwd.to_owned(),
        relative_path: relative_path.to_string_lossy().into_owned(),
        resource,
        digest,
    })
}

fn terminal_arguments_digest(
    shell_profile_id: &str,
    command: &str,
    cwd: &str,
    timeout_ms: u64,
    environment: &BTreeMap<String, String>,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizon.terminal.run.arguments.v1\0");
    for value in [
        shell_profile_id.as_bytes(),
        command.as_bytes(),
        cwd.as_bytes(),
    ] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    hasher.update(&timeout_ms.to_be_bytes());
    for (key, value) in environment {
        for value in [key.as_bytes(), value.as_bytes()] {
            hasher.update(&(value.len() as u64).to_be_bytes());
            hasher.update(value);
        }
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

pub(crate) fn valid_environment_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte == b'_' || byte.is_ascii_alphabetic())
        && bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
}

fn guard_patch_intent(
    execution: &ExecutionHost,
    session_id: &str,
    principal: &str,
    batch_id: &str,
    call_id: &str,
    canonical_digest: &str,
    turn_context_digest: &str,
    challenge_id: &str,
    targets: &[PatchTarget],
    managed_attempt_digest: Option<&str>,
) -> Option<String> {
    let mut hasher = blake3::Hasher::new();
    for target in targets {
        let (decision, intent) = guard_decision(
            execution,
            session_id,
            principal,
            batch_id,
            call_id,
            guard::FILES_PATCH_ID,
            &target.requested_path,
            &target.relative_path,
            &target.resource,
            canonical_digest,
            turn_context_digest,
            challenge_id,
            guard::EffectOriginKindV1::SessionBatch,
            managed_attempt_digest,
        );
        if decision.decision != guard::DecisionKind::Ask {
            return None;
        }
        hasher.update(&(intent.len() as u64).to_be_bytes());
        hasher.update(intent.as_bytes());
    }
    Some(format!("blake3:{}", hasher.finalize().to_hex()))
}

fn load_patch_targets(
    connection: &Connection,
    challenge_id: &str,
) -> Result<Vec<PatchTarget>, Failure> {
    let mut statement = connection.prepare(
        "SELECT operation,relative_path,requested_path,target,resource,existed,before_digest,after_digest,content_digest,requested_executable,before_mode,mode
         FROM patch_targets WHERE challenge_id=?1 ORDER BY ordinal"
    ).map_err(|_| Failure::Unavailable)?;
    let rows = statement
        .query_map([challenge_id], |row| {
            let existed: i64 = row.get(5)?;
            let requested_executable: Option<i64> = row.get(9)?;
            Ok(PatchTarget {
                operation: row.get(0)?,
                relative_path: row.get(1)?,
                requested_path: row.get(2)?,
                target: row.get(3)?,
                resource: row.get(4)?,
                existed: existed != 0,
                before_digest: row.get(6)?,
                after_digest: row.get(7)?,
                content_digest: row.get(8)?,
                requested_executable: requested_executable.map(|value| value != 0),
                before_mode: row.get(10)?,
                mode: row.get(11)?,
                content: None,
            })
        })
        .map_err(|_| Failure::Unavailable)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| Failure::Unavailable)
}

fn row_to_challenge(row: &rusqlite::Row<'_>) -> rusqlite::Result<Challenge> {
    let existed: i64 = row.get(10)?;
    let expires_at_ms: i64 = row.get(13)?;
    Ok(Challenge {
        challenge_id: row.get(0)?,
        effect_id: row.get(1)?,
        session_id: row.get(2)?,
        principal: row.get(17)?,
        batch_id: row.get(3)?,
        call_id: row.get(4)?,
        capability_id: row.get(5)?,
        origin_kind: row.get(18)?,
        relative_path: row.get(6)?,
        requested_path: row.get(7)?,
        target: row.get(8)?,
        resource: row.get(9)?,
        existed: existed != 0,
        argument_digest: row.get(11)?,
        content_digest: row.get(12)?,
        expires_at_ms: expires_at_ms.max(0) as u64,
        status: row.get(14)?,
        after_digest: row.get(15)?,
        turn_context_digest: row.get(16)?,
        managed_attempt_digest: row.get(19)?,
    })
}

fn load_lease_id(connection: &Connection, challenge_id: &str) -> Result<Option<String>, Failure> {
    connection
        .query_row(
            "SELECT lease_id FROM effect_challenges WHERE challenge_id=?1",
            [challenge_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| Failure::Unavailable)
}

fn strict_map<'a>(
    value: &'a Value,
    expected: &[&str],
) -> Result<&'a BTreeMap<String, Value>, Failure> {
    let Value::Map(map) = value else {
        return Err(Failure::Invalid);
    };
    if map.len() != expected.len() || expected.iter().any(|key| !map.contains_key(*key)) {
        return Err(Failure::Invalid);
    }
    Ok(map)
}

fn strict_map_optional<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a BTreeMap<String, Value>, Failure> {
    let Value::Map(map) = value else {
        return Err(Failure::Invalid);
    };
    if required.iter().any(|key| !map.contains_key(*key))
        || map
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
        || map.len() > required.len() + optional.len()
    {
        return Err(Failure::Invalid);
    }
    Ok(map)
}

fn patch_target_value(target: &PatchTarget) -> Value {
    let mut fields = BTreeMap::from([
        ("target".to_owned(), Value::String(target.target.clone())),
        (
            "resource".to_owned(),
            Value::String(target.resource.clone()),
        ),
        (
            "operation".to_owned(),
            Value::String(target.operation.clone()),
        ),
        ("existed".to_owned(), Value::Bool(target.existed)),
    ]);
    if let Some(mode) = target.mode {
        fields.insert("executable".to_owned(), Value::Bool(mode & 0o111 != 0));
    }
    Value::Map(fields)
}
fn text<'a>(map: &'a BTreeMap<String, Value>, key: &str) -> Result<&'a str, Failure> {
    match map.get(key) {
        Some(Value::String(value)) => Ok(value),
        _ => Err(Failure::Invalid),
    }
}

fn require_session(process_session_id: &str, request_session_id: &str) -> Result<(), Failure> {
    if process_session_id == request_session_id
        && (request_session_id.is_empty() || validate_identifier(request_session_id).is_ok())
    {
        Ok(())
    } else {
        Err(Failure::Denied)
    }
}
fn validate_identifier(value: &str) -> Result<(), Failure> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES || value.chars().any(char::is_control)
    {
        Err(Failure::Invalid)
    } else {
        Ok(())
    }
}

fn validate_content(content: &str) -> Result<(), Failure> {
    if content.len() > MAX_WRITE_BYTES || content.len() > MAX_BODY_BYTES {
        Err(Failure::Invalid)
    } else {
        Ok(())
    }
}

fn normalize_workspace_path(root: &Path, input: &str) -> Result<(PathBuf, String), Failure> {
    if input.is_empty() || input.len() > 4096 || input.contains('\0') {
        return Err(Failure::Invalid);
    }
    let supplied = Path::new(input);
    let relative = if supplied.is_absolute() {
        supplied.strip_prefix(root).map_err(|_| Failure::Denied)?
    } else {
        supplied
    };
    let mut normalized = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            _ => return Err(Failure::Denied),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(Failure::Denied);
    }
    let text = normalized.to_str().ok_or(Failure::Invalid)?.to_owned();
    Ok((normalized, text))
}

fn open_root(root: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
}

fn open_parent(root: &File, relative: &Path) -> io::Result<(File, CString)> {
    let mut components = Vec::new();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsafe path component",
            ));
        };
        components.push(
            CString::new(part.as_bytes()).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "NUL in path component")
            })?,
        );
    }
    let Some(name) = components.pop() else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty path"));
    };
    let mut directory = root.try_clone()?;
    for component in components {
        // SAFETY: the component is NUL-terminated and the parent descriptor remains open.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: openat returned a new owned descriptor.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok((directory, name))
}

fn inspect_target(parent_fd: i32, name: &CString) -> io::Result<bool> {
    // SAFETY: the output pointer is valid and name is NUL-terminated.
    let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::fstatat(
            parent_fd,
            name.as_ptr(),
            &mut metadata,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOENT) {
            return Ok(false);
        }
        return Err(error);
    }
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG || metadata.st_nlink != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unsafe target type",
        ));
    }
    Ok(true)
}

fn open_target_for_update(
    parent_fd: i32,
    name: &CString,
    expected_exists: bool,
) -> io::Result<Option<File>> {
    let exists = inspect_target(parent_fd, name)?;
    if exists != expected_exists {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "target existence changed",
        ));
    }
    if !exists {
        return Ok(None);
    }
    // SAFETY: name is NUL-terminated and parent_fd remains open.
    let fd = unsafe {
        libc::openat(
            parent_fd,
            name.as_ptr(),
            libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned an owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unsafe target type",
        ));
    }
    Ok(Some(file))
}

fn open_new_target(parent_fd: i32, name: &CString) -> io::Result<File> {
    // SAFETY: name is NUL-terminated and parent_fd remains open. O_EXCL prevents replacing
    // anything created after the durable PREPARED intent.
    let fd = unsafe {
        libc::openat(
            parent_fd,
            name.as_ptr(),
            libc::O_WRONLY
                | libc::O_CREAT
                | libc::O_EXCL
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK,
            0o666,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned an owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn has_bom(file: &File) -> io::Result<bool> {
    let mut bytes = [0_u8; 3];
    // SAFETY: the buffer is writable and the file descriptor is live. pread does not
    // mutate the shared file offset.
    let count = unsafe { libc::pread(file.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(count == BOM.len() as isize && &bytes == BOM)
}

fn read_target_digest(root: &File, relative: &Path) -> io::Result<String> {
    let (parent, name) = open_parent(root, relative)?;
    if !inspect_target(parent.as_raw_fd(), &name)? {
        return Err(io::Error::new(io::ErrorKind::NotFound, "target is missing"));
    }
    // SAFETY: name is NUL-terminated and parent descriptor remains open.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned an owned descriptor.
    let mut file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unsafe target type",
        ));
    }
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

fn patch_manifest_digest(targets: &[PatchTarget]) -> String {
    let mut hasher = blake3::Hasher::new();
    for target in targets {
        for field in [
            target.operation.as_bytes(),
            target.relative_path.as_bytes(),
            target.requested_path.as_bytes(),
            target.before_digest.as_deref().unwrap_or("").as_bytes(),
            target.content_digest.as_deref().unwrap_or("").as_bytes(),
            &[match target.requested_executable {
                None => 2,
                Some(false) => 0,
                Some(true) => 1,
            }],
            &target.before_mode.unwrap_or(u32::MAX).to_be_bytes(),
            &target.mode.unwrap_or(u32::MAX).to_be_bytes(),
        ] {
            hasher.update(&(field.len() as u64).to_be_bytes());
            hasher.update(field);
        }
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn patch_after_digest(targets: &[PatchTarget]) -> String {
    let mut hasher = blake3::Hasher::new();
    for target in targets {
        let digest = if target.operation == "delete" {
            ""
        } else {
            target.after_digest.as_deref().unwrap_or("")
        };
        for field in [
            target.relative_path.as_bytes(),
            digest.as_bytes(),
            &target.mode.unwrap_or(u32::MAX).to_be_bytes(),
        ] {
            hasher.update(&(field.len() as u64).to_be_bytes());
            hasher.update(field);
        }
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn patch_observed_digest(targets: &[(&str, Option<String>, Option<u32>)]) -> String {
    let mut hasher = blake3::Hasher::new();
    for (path, digest, mode) in targets {
        for field in [
            path.as_bytes(),
            digest.as_deref().unwrap_or("").as_bytes(),
            &mode.unwrap_or(u32::MAX).to_be_bytes(),
        ] {
            hasher.update(&(field.len() as u64).to_be_bytes());
            hasher.update(field);
        }
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn digest_file(file: &File) -> io::Result<String> {
    let mut file = file.try_clone()?;
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

fn decode_canonical_base64(encoded: &str) -> Option<Vec<u8>> {
    let input = encoded.as_bytes();
    if input.len() % 4 != 0 {
        return None;
    }
    let value = |byte: u8| -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    for (index, chunk) in input.chunks_exact(4).enumerate() {
        let last = index + 1 == input.len() / 4;
        let a = value(chunk[0])?;
        let b = value(chunk[1])?;
        if chunk[2] == b'=' {
            if !last || chunk[3] != b'=' || b & 15 != 0 {
                return None;
            }
            output.push((a << 2) | (b >> 4));
        } else {
            let c = value(chunk[2])?;
            output.push((a << 2) | (b >> 4));
            output.push((b << 4) | (c >> 2));
            if chunk[3] == b'=' {
                if !last || c & 3 != 0 {
                    return None;
                }
            } else {
                let d = value(chunk[3])?;
                output.push((c << 6) | d);
            }
        }
    }
    Some(output)
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(bytes).to_hex())
}

fn is_blake3_digest(value: &str) -> bool {
    value.strip_prefix("blake3:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn parse_stdio_state(value: &str) -> Option<StdioExecutionStateV1> {
    match value {
        "PREPARED" => Some(StdioExecutionStateV1::Prepared),
        "RUNNING" => Some(StdioExecutionStateV1::Running),
        "CANCELLING" => Some(StdioExecutionStateV1::Cancelling),
        "SETTLED" => Some(StdioExecutionStateV1::Exited),
        "UNKNOWN" => Some(StdioExecutionStateV1::Unknown),
        _ => None,
    }
}

fn receipt_digest(
    effect_id: &str,
    target: &str,
    resource: &str,
    existed: bool,
    after_digest: &str,
    lease_id: &str,
) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in [effect_id, target, resource, after_digest, lease_id] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(&[u8::from(existed)]);
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn map_io_failure(error: io::Error) -> Failure {
    match error.kind() {
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => Failure::Denied,
        io::ErrorKind::PermissionDenied => Failure::Denied,
        io::ErrorKind::NotFound => Failure::Denied,
        _ => Failure::Unavailable,
    }
}

fn random_id(prefix: &str) -> Result<String, Failure> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut bytes))
        .map_err(|_| Failure::Unavailable)?;
    Ok(format!("{prefix}_{}", hex(&bytes)))
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn now_ms() -> Result<u64, Failure> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .map_err(|_| Failure::Unavailable)
}

fn validate_effect_request_deadline(deadline_unix_ms: u64) -> Result<(), Failure> {
    validate_deadline(deadline_unix_ms, now_ms()?, false).map_err(|_| Failure::DeadlineExceeded)
}

fn map_value<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

/// The normalized target list for one planned call, exactly as an approval surface renders it.
fn planned_normalized_targets(call: &PlannedCall) -> Vec<Value> {
    match &call.effect {
        PlannedEffect::Write {
            target,
            resource,
            existed,
            ..
        } => vec![map_value([
            ("target", Value::String(target.clone())),
            ("resource", Value::String(resource.clone())),
            ("operation", Value::String("write".to_owned())),
            ("existed", Value::Bool(*existed)),
        ])],
        PlannedEffect::Patch { targets } => targets.iter().map(patch_target_value).collect(),
        PlannedEffect::Terminal {
            requested_path,
            resource,
            capability_id,
            ..
        } => vec![map_value([
            ("target", Value::String(requested_path.clone())),
            ("resource", Value::String(resource.clone())),
            (
                "operation",
                Value::String(
                    if capability_id == guard::TERMINAL_START_ID {
                        "start"
                    } else {
                        "run"
                    }
                    .to_owned(),
                ),
            ),
            ("existed", Value::Bool(false)),
        ])],
        PlannedEffect::BrokerProcess {
            requested_path,
            resource,
            profile_id,
            ..
        } => vec![map_value([
            ("target", Value::String(requested_path.clone())),
            ("resource", Value::String(resource.clone())),
            ("operation", Value::String(format!("verify:{profile_id}"))),
            ("existed", Value::Bool(false)),
        ])],
    }
}

/// One call's approval metadata, including its own one-use challenge identity. The
/// per-call fields mirror the proven single-call response surface so a relay layer can
/// build the same challenge object for each member of the batch.
fn planned_call_value(call: &PlannedCall) -> Value {
    let mut fields = std::collections::BTreeMap::from([
        ("callId".to_owned(), Value::String(call.call_id.clone())),
        (
            "capabilityId".to_owned(),
            Value::String(call.capability_id.clone()),
        ),
        (
            "challengeId".to_owned(),
            Value::String(call.challenge_id.clone()),
        ),
        ("effectId".to_owned(), Value::String(call.effect_id.clone())),
        (
            "inputDigest".to_owned(),
            Value::String(call.argument_digest.clone()),
        ),
        (
            "expiresAtUnixMs".to_owned(),
            Value::Unsigned(call.expires_at_ms),
        ),
    ]);
    let normalized = planned_normalized_targets(call);
    match &call.effect {
        PlannedEffect::Write {
            target,
            resource,
            existed,
            ..
        } => {
            fields.insert("target".to_owned(), Value::String(target.clone()));
            fields.insert("resource".to_owned(), Value::String(resource.clone()));
            fields.insert("existed".to_owned(), Value::Bool(*existed));
        }
        PlannedEffect::Patch { .. } => {
            fields.insert("targets".to_owned(), Value::Array(normalized.clone()));
        }
        PlannedEffect::Terminal {
            requested_path,
            resource,
            ..
        } => {
            fields.insert("target".to_owned(), Value::String(requested_path.clone()));
            fields.insert("resource".to_owned(), Value::String(resource.clone()));
            fields.insert("existed".to_owned(), Value::Bool(false));
        }
        PlannedEffect::BrokerProcess {
            requested_path,
            resource,
            ..
        } => {
            fields.insert("target".to_owned(), Value::String(requested_path.clone()));
            fields.insert("resource".to_owned(), Value::String(resource.clone()));
            fields.insert("existed".to_owned(), Value::Bool(false));
        }
    }
    fields.insert("normalizedTargets".to_owned(), Value::Array(normalized));
    Value::Map(fields)
}

/// Complete-batch approval response. Every member carries its own challenge; the batch is
/// labelled with the durable `batchId` so a cancellation can address the whole set.
fn batch_approval_value(batch_id: &str, calls: &[PlannedCall]) -> Value {
    let expires_at_ms = calls
        .iter()
        .map(|call| call.expires_at_ms)
        .min()
        .unwrap_or_default();
    let mut fields = std::collections::BTreeMap::from([
        (
            "status".to_owned(),
            Value::String("needs_approval".to_owned()),
        ),
        ("expiresAtUnixMs".to_owned(), Value::Unsigned(expires_at_ms)),
        (
            "calls".to_owned(),
            Value::Array(calls.iter().map(planned_call_value).collect()),
        ),
    ]);
    if !batch_id.is_empty() {
        fields.insert("batchId".to_owned(), Value::String(batch_id.to_owned()));
    }
    if calls.len() == 1 {
        // Preserve the exact single-call response surface already proven end to end.
        let call = &calls[0];
        fields.insert(
            "challengeId".to_owned(),
            Value::String(call.challenge_id.clone()),
        );
        fields.insert("effectId".to_owned(), Value::String(call.effect_id.clone()));
        fields.insert(
            "inputDigest".to_owned(),
            Value::String(call.argument_digest.clone()),
        );
        fields.insert(
            "expiresAtUnixMs".to_owned(),
            Value::Unsigned(call.expires_at_ms),
        );
        let normalized = planned_normalized_targets(call);
        if let PlannedEffect::Patch { .. } = call.effect {
            fields.insert("targets".to_owned(), Value::Array(normalized.clone()));
        }
        if let PlannedEffect::Write {
            target,
            resource,
            existed,
            ..
        } = &call.effect
        {
            fields.insert("target".to_owned(), Value::String(target.clone()));
            fields.insert("resource".to_owned(), Value::String(resource.clone()));
            fields.insert("existed".to_owned(), Value::Bool(*existed));
        }
        fields.insert("normalizedTargets".to_owned(), Value::Array(normalized));
    }
    Value::Map(fields)
}

/// Single-call approval response (user effects and direct single-call preparation).
fn single_approval_value(call: &PlannedCall) -> Value {
    batch_approval_value("", std::slice::from_ref(call))
}

fn denied_batch(reason: &str) -> Value {
    map_value([
        ("status", Value::String("denied".to_owned())),
        ("reason", Value::String(reason.to_owned())),
    ])
}

#[cfg(test)]
mod managed_attempt_scope_tests {
    use super::*;
    use crate::protocol::{DirectAttemptScopeV1, ManagedAttemptScopeV1};
    use crate::terminal_process::{
        StdioExecutionBindingV1, StdioExecutionSupervisor, StdioLaunchSpec,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scope() -> ManagedAttemptScopeV1 {
        ManagedAttemptScopeV1 {
            goal_id: "goal_scope_test".to_owned(),
            run_id: "run_scope_test".to_owned(),
            task_id: "task_scope_test".to_owned(),
            attempt_id: "attempt_scope_test".to_owned(),
            owner_epoch: 11,
            expected_managed_revision: 19,
            location_id: "loc_scope_test".to_owned(),
            session_id: "ses_scope_test".to_owned(),
            workspace_revision: format!("blake3:{}", "a".repeat(64)),
            delegation_binding_digest: format!("blake3:{}", "b".repeat(64)),
        }
    }

    #[test]
    fn one_use_lease_requires_the_exact_managed_attempt_digest() {
        let digest = EffectAttemptScopeV1::Managed(scope()).digest().unwrap();
        let lease = ExecutionLease {
            challenge_id: "ch_scope_test".to_owned(),
            lease_id: "lease_scope_test".to_owned(),
            managed_attempt_digest: Some(digest.clone()),
        };
        assert_eq!(
            lease.consume("ch_scope_test", Some(&digest)).unwrap(),
            "lease_scope_test"
        );

        let stale_lease = ExecutionLease {
            challenge_id: "ch_scope_test".to_owned(),
            lease_id: "lease_scope_test".to_owned(),
            managed_attempt_digest: Some(digest.clone()),
        };
        assert_eq!(
            stale_lease
                .consume("ch_scope_test", Some("blake3:stale"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        let omitted_lease = ExecutionLease {
            challenge_id: "ch_scope_test".to_owned(),
            lease_id: "lease_scope_test".to_owned(),
            managed_attempt_digest: Some(digest),
        };
        assert_eq!(
            omitted_lease
                .consume("ch_scope_test", None)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn builtin_verifier_challenge_denies_legacy_resolution_and_revalidates_profile_in_set_path() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "hz-broker-verifier-approval-{}-{nonce}",
            std::process::id()
        ));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();

        let mut host = EffectHost::open(&state, Some(&workspace)).unwrap();
        let profile = BrokerProcessAuthorizationV1 {
            capability_id: guard::BUILTIN_VERIFIER_ID.to_owned(),
            origin_kind: guard::EffectOriginKindV1::ManagedRun,
            principal: "server_auth:reviewer".to_owned(),
            user_action_id: "verify_action_test".to_owned(),
            call_id: "criterion_one".to_owned(),
            session_id: "session_test".to_owned(),
            managed_attempt_digest: Some(format!("blake3:{}", "c".repeat(64))),
            workspace_cwd: workspace.to_string_lossy().into_owned(),
            resource: ".".to_owned(),
            profile_id: "profile_test".to_owned(),
            executable_path: fs::canonicalize("/bin/sh")
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            executable_digest: crate::terminal_process::executable_digest("/bin/sh").unwrap(),
            profile_digest: format!("blake3:{}", "a".repeat(64)),
            argument_bundle_digest: format!("blake3:{}", "b".repeat(64)),
        };
        let prepared = host
            .prepare_broker_process(profile)
            .expect("host-registered broker profile should produce a Guard challenge");
        let fields = match prepared {
            Value::Map(fields) => fields,
            _ => panic!("approval response must be a map"),
        };
        assert!(
            matches!(fields.get("status"), Some(Value::String(status)) if status == "needs_approval")
        );
        let challenge_id = match fields.get("challengeId") {
            Some(Value::String(value)) => value.clone(),
            _ => panic!("approval response must contain a challenge"),
        };

        let single_resolution = host
            .resolve_approval(
                "",
                "server_auth:reviewer",
                &map_value([
                    ("sessionId", Value::String(String::new())),
                    ("challengeId", Value::String(challenge_id.clone())),
                    ("approved", Value::Bool(true)),
                ]),
            )
            .expect_err("verifier approvals must only resolve as one exact set");
        assert!(matches!(single_resolution, Failure::Denied));

        host.connection
            .execute(
                "UPDATE broker_process_bindings SET profile_digest=?1 WHERE challenge_id=?2",
                params![format!("blake3:{}", "c".repeat(64)), challenge_id],
            )
            .expect("test mutation should be durable");
        let error = host
            .resolve_managed_run_approval_set(
                "server_auth:reviewer",
                &[(challenge_id, Some(true))],
                None,
            )
            .expect_err("set approval must fail if the persisted profile binding changed");
        assert_eq!(error.code, "effect_denied");
        drop(host);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn terminal_consent_preflight_set_rolls_back_all_rows_on_member_conflict() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "hz-terminal-preflight-set-{}-{nonce}",
            std::process::id()
        ));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();

        let mut host = EffectHost::open(&state, Some(&workspace)).unwrap();
        let principal = "host_os_uid:1000";
        let argument_digest = format!("blake3:{}", "a".repeat(64));
        for (challenge_id, effect_id) in [
            ("challenge_preflight_one", "effect_preflight_one"),
            ("challenge_preflight_two", "effect_preflight_two"),
        ] {
            host.connection.execute(
                "INSERT INTO effect_challenges(
                    challenge_id,effect_id,session_id,principal,batch_id,call_id,capability_id,
                    relative_path,requested_path,target,resource,existed,argument_digest,
                    content_digest,expires_at_ms,status,turn_context_digest,origin_kind
                 ) VALUES (?1,?2,'session_test',?3,'batch_test',?1,?4,'','.','.', '.',0,?5,?5,?6,'AWAITING_APPROVAL',?5,'session_batch')",
                params![
                    challenge_id,
                    effect_id,
                    principal,
                    guard::TERMINAL_RUN_ID,
                    argument_digest,
                    now_ms().unwrap() as i64 + 60_000,
                ],
            ).unwrap();
        }
        // Occupy the unique effect_id of member two. The first member must roll back
        // when the second insert conflicts, rather than leaving a partially bound set.
        host.connection.execute(
            "INSERT INTO terminal_consent_preflights(
                challenge_id,effect_id,principal,owner_epoch,approved_arguments_digest,
                profile_digest,executable_digest,workspace_revision,launch_digest,
                binding_digest,guarantee_record,status,created_at_ms
             ) VALUES ('challenge_preflight_old','effect_preflight_two',?1,1,?2,?2,?2,?2,?2,?2,'enforced','PREPARED',?3)",
            params![principal, argument_digest, now_ms().unwrap() as i64],
        ).unwrap();

        let make_record = |challenge_id: &str, effect_id: &str| TerminalConsentPreflightRecordV1 {
            challenge_id: challenge_id.to_owned(),
            effect_id: effect_id.to_owned(),
            principal: principal.to_owned(),
            owner_epoch: 1,
            approved_arguments_digest: argument_digest.clone(),
            profile_digest: format!("blake3:{}", "b".repeat(64)),
            executable_digest: format!("blake3:{}", "c".repeat(64)),
            workspace_revision: format!("blake3:{}", "d".repeat(64)),
            launch_digest: format!("blake3:{}", "e".repeat(64)),
            binding_digest: format!("blake3:{}", "f".repeat(64)),
            guarantee_record: "enforced".to_owned(),
        };
        assert!(
            host.bind_terminal_consent_preflight_set(&[
                make_record("challenge_preflight_one", "effect_preflight_one"),
                make_record("challenge_preflight_two", "effect_preflight_two"),
            ])
            .is_err()
        );
        let first: i64 = host.connection.query_row(
            "SELECT COUNT(*) FROM terminal_consent_preflights WHERE challenge_id='challenge_preflight_one'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(first, 0);
        host.connection
            .execute(
                "DELETE FROM terminal_consent_preflights WHERE challenge_id='challenge_preflight_old'",
                [],
            )
            .unwrap();
        host.bind_terminal_consent_preflight_set(&[
            make_record("challenge_preflight_one", "effect_preflight_one"),
            make_record("challenge_preflight_two", "effect_preflight_two"),
        ])
        .unwrap();
        let bound: i64 = host.connection.query_row(
            "SELECT COUNT(*) FROM terminal_consent_preflights WHERE challenge_id IN ('challenge_preflight_one','challenge_preflight_two') AND status='PREPARED'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(bound, 2);

        drop(host);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn managed_run_approval_set_is_atomic_and_only_accepts_exact_all_allow() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "hz-managed-verifier-set-{}-{nonce}",
            std::process::id()
        ));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();

        let mut host = EffectHost::open(&state, Some(&workspace)).unwrap();
        let executable = fs::canonicalize("/bin/sh").unwrap();
        let mut challenge_ids = Vec::new();
        let mut effect_ids = Vec::new();
        let mut input_digests = Vec::new();
        for criterion in ["criterion_one", "criterion_two"] {
            let prepared = host
                .prepare_broker_process(BrokerProcessAuthorizationV1 {
                    capability_id: guard::BUILTIN_VERIFIER_ID.to_owned(),
                    origin_kind: guard::EffectOriginKindV1::ManagedRun,
                    principal: "server_auth:reviewer".to_owned(),
                    user_action_id: "verification_run_one".to_owned(),
                    call_id: criterion.to_owned(),
                    session_id: "session_verification".to_owned(),
                    managed_attempt_digest: Some(format!("blake3:{}", "c".repeat(64))),
                    workspace_cwd: workspace.to_string_lossy().into_owned(),
                    resource: ".".to_owned(),
                    profile_id: "profile_test".to_owned(),
                    executable_path: executable.to_string_lossy().into_owned(),
                    executable_digest: crate::terminal_process::executable_digest(&executable)
                        .unwrap(),
                    profile_digest: format!("blake3:{}", "a".repeat(64)),
                    argument_bundle_digest: digest_bytes(criterion.as_bytes()),
                })
                .unwrap();
            let fields = match prepared {
                Value::Map(fields) => fields,
                _ => panic!("approval response must be a map"),
            };
            let challenge = match fields.get("challengeId") {
                Some(Value::String(value)) => value.clone(),
                _ => panic!("approval response must contain challengeId"),
            };
            let effect = match fields.get("effectId") {
                Some(Value::String(value)) => value.clone(),
                _ => panic!("approval response must contain effectId"),
            };
            let input_digest = match fields.get("inputDigest") {
                Some(Value::String(value)) => value.clone(),
                _ => panic!("approval response must contain inputDigest"),
            };
            challenge_ids.push(challenge);
            effect_ids.push(effect);
            input_digests.push(input_digest);
        }

        assert!(
            host.resolve_managed_run_approval_set(
                "server_auth:reviewer",
                &[
                    (challenge_ids[0].clone(), Some(true)),
                    (challenge_ids[0].clone(), Some(true)),
                ],
                None,
            )
            .is_err()
        );
        for challenge in &challenge_ids {
            let status: String = host
                .connection
                .query_row(
                    "SELECT status FROM effect_challenges WHERE challenge_id=?1",
                    [challenge],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(status, "AWAITING_APPROVAL");
        }

        host.resolve_managed_run_approval_set(
            "server_auth:reviewer",
            &challenge_ids
                .iter()
                .cloned()
                .map(|challenge| (challenge, Some(true)))
                .collect::<Vec<_>>(),
            None,
        )
        .unwrap();
        for challenge in &challenge_ids {
            let (status, approved): (String, i64) = host
                .connection
                .query_row(
                    "SELECT status,approved FROM effect_challenges WHERE challenge_id=?1",
                    [challenge],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(status, "APPROVED");
            assert_eq!(approved, 1);
        }

        let lease_digest = format!("blake3:{}", "c".repeat(64));
        let workspace_revision = format!("blake3:{}", "d".repeat(64));
        let binding = StdioExecutionBindingV1 {
            execution_id: "exec_verifier_one".to_owned(),
            effect_id: effect_ids[0].clone(),
            challenge_id: challenge_ids[0].clone(),
            principal: "server_auth:reviewer".to_owned(),
            session_id: String::new(),
            location_id: "location_verifier_one".to_owned(),
            capability_id: guard::BUILTIN_VERIFIER_ID.to_owned(),
            capability_lease_digest: lease_digest.clone(),
            attempt_scope_digest: None,
            owner_epoch: 7,
            generation: 7,
            workspace_revision: workspace_revision.clone(),
            profile_ref: "profile_test".to_owned(),
            profile_id: "profile_test".to_owned(),
            profile_revision: 1,
            profile_digest: format!("blake3:{}", "a".repeat(64)),
            executable_digest: crate::terminal_process::executable_digest(&executable).unwrap(),
            approved_arguments_digest: input_digests[0].clone(),
        };
        let mut launch = StdioLaunchSpec::new(
            executable.clone(),
            crate::terminal_process::executable_digest(&executable).unwrap(),
            ["-c", "printf verifier"],
            workspace.clone(),
        );
        launch.profile_digest = format!("blake3:{}", "a".repeat(64));
        launch.workspace_revision = workspace_revision;
        launch.workspace_root = workspace.clone();
        let mut supervisor = StdioExecutionSupervisor::default();
        let prepared = supervisor
            .preflight(binding.clone(), launch)
            .expect("managed_run should support a confined sessionless process binding");
        host.authorize_execution_preflight(&binding, &prepared)
            .expect("the exact approved verifier profile and Guard challenge authorize preflight");
        drop(host);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn managed_attempt_scope_parser_requires_exact_shape_and_session_binding() {
        let scope = scope();
        assert_eq!(
            attempt_scope_digest(
                Some(&EffectAttemptScopeV1::Managed(scope.clone())),
                "ses_scope_test",
            )
            .unwrap(),
            Some(scope.digest().unwrap())
        );
        assert!(matches!(
            attempt_scope_digest(
                Some(&EffectAttemptScopeV1::Managed(scope.clone())),
                "ses_other"
            ),
            Err(Failure::Denied)
        ));

        let mut malformed = scope.to_value();
        if let Value::Map(fields) = &mut malformed {
            fields.insert(
                "callerPrincipal".to_owned(),
                Value::String("fake".to_owned()),
            );
        }
        let body = BTreeMap::from([("managedAttempt".to_owned(), malformed)]);
        assert!(matches!(
            parse_effect_attempt_scope_digest(&body, "ses_scope_test"),
            Err(Failure::Invalid)
        ));
    }

    #[test]
    fn direct_attempt_scope_binds_child_session_and_workspace_revision_digest() {
        let direct = DirectAttemptScopeV1 {
            attempt_id: "attempt_direct_test".to_owned(),
            parent_session_id: "ses_parent_test".to_owned(),
            child_session_id: "ses_child_test".to_owned(),
            owner_epoch: 5,
            expected_revision: 1,
            profile_id: "profile_builtin_coder".to_owned(),
            profile_revision: 1,
            profile_digest: format!("blake3:{}", "f".repeat(64)),
            location_id: "loc_direct_test".to_owned(),
            workspace_id: "workspace_test".to_owned(),
            workspace_revision: format!("blake3:{}", "a".repeat(64)),
            capability_digest: format!("sha256:{}", "b".repeat(64)),
            permissions_digest: format!("sha256:{}", "c".repeat(64)),
            budget_digest: format!("sha256:{}", "d".repeat(64)),
            scope_digest: format!("sha256:{}", "e".repeat(64)),
        };
        let scope = EffectAttemptScopeV1::Direct(direct.clone());
        let digest = attempt_scope_digest(Some(&scope), "ses_child_test")
            .unwrap()
            .unwrap();
        assert!(matches!(
            attempt_scope_digest(Some(&scope), "ses_parent_test"),
            Err(Failure::Denied)
        ));

        let body = BTreeMap::from([("directAttempt".to_owned(), direct.to_value())]);
        assert_eq!(
            parse_effect_attempt_scope_digest(&body, "ses_child_test")
                .unwrap()
                .as_deref(),
            Some(digest.as_str())
        );
        assert!(matches!(
            parse_effect_attempt_scope_digest(&body, "ses_stale_child"),
            Err(Failure::Denied)
        ));
    }

    #[test]
    fn stdio_preflight_rejects_process_arguments_different_from_approved_terminal_arguments() {
        let approved = format!("blake3:{}", "a".repeat(64));
        let altered = format!("blake3:{}", "b".repeat(64));

        assert!(stdio_arguments_match_approval(&approved, &approved));
        assert!(!stdio_arguments_match_approval(&approved, &altered));
        assert!(!stdio_arguments_match_approval(&approved, "not-a-digest"));
    }

    #[test]
    fn ambiguous_stdio_dispatch_moves_running_and_cancelling_challenges_to_unknown() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("hz-stdio-unknown-transition-{nonce}"));
        let state = base.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();

        let mut host = EffectHost::open(&state, None).unwrap();
        for (suffix, status) in [("running", "RUNNING"), ("cancelling", "CANCELLING")] {
            let binding = StdioExecutionBindingV1 {
                execution_id: format!("execution_unknown_{suffix}"),
                effect_id: format!("effect_unknown_{suffix}"),
                challenge_id: format!("challenge_unknown_{suffix}"),
                principal: "host_os_uid:1000".to_owned(),
                session_id: format!("session_unknown_{suffix}"),
                location_id: format!("location_unknown_{suffix}"),
                capability_id: guard::TERMINAL_RUN_ID.to_owned(),
                capability_lease_digest: format!("blake3:{}", "a".repeat(64)),
                approved_arguments_digest: format!("blake3:{}", "b".repeat(64)),
                attempt_scope_digest: None,
                owner_epoch: 11,
                generation: 4,
                workspace_revision: format!("blake3:{}", "c".repeat(64)),
                profile_ref: "linux-bash".to_owned(),
                profile_id: "linux-bash".to_owned(),
                profile_revision: 1,
                profile_digest: format!("blake3:{}", "d".repeat(64)),
                executable_digest: format!("blake3:{}", "e".repeat(64)),
            };
            host.connection
                .execute(
                    "INSERT INTO effect_challenges(
                        challenge_id,effect_id,session_id,principal,batch_id,call_id,capability_id,
                        relative_path,requested_path,target,resource,existed,argument_digest,
                        content_digest,expires_at_ms,status,turn_context_digest,origin_kind
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,'','.','.', '.',0,?8,?8,?9,?10,?8,'session_batch')",
                    params![
                        binding.challenge_id,
                        binding.effect_id,
                        binding.session_id,
                        binding.principal,
                        format!("batch_unknown_{suffix}"),
                        format!("call_unknown_{suffix}"),
                        binding.capability_id,
                        binding.approved_arguments_digest,
                        now_ms().unwrap() as i64 + 60_000,
                        status,
                    ],
                )
                .unwrap();
            host.connection
                .execute(
                    "INSERT INTO stdio_executions(
                        execution_id,intent_id,effect_id,challenge_id,principal,session_id,location_id,
                        capability_id,capability_lease_digest,attempt_scope_digest,owner_epoch,generation,
                        workspace_revision,profile_ref,profile_id,profile_revision,profile_digest,executable_digest,
                        execution_digest,confinement_record,status,created_at_ms,updated_at_ms
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,?10,?11,?12,?13,?14,?15,?16,?17,?18,'enforced',?19,?20,?20)",
                    params![
                        binding.execution_id,
                        format!("intent_unknown_{suffix}"),
                        binding.effect_id,
                        binding.challenge_id,
                        binding.principal,
                        binding.session_id,
                        binding.location_id,
                        binding.capability_id,
                        binding.capability_lease_digest,
                        binding.owner_epoch as i64,
                        binding.generation as i64,
                        binding.workspace_revision,
                        binding.profile_ref,
                        binding.profile_id,
                        binding.profile_revision as i64,
                        binding.profile_digest,
                        binding.executable_digest,
                        format!("blake3:{}", "d".repeat(64)),
                        status,
                        now_ms().unwrap() as i64,
                    ],
                )
                .unwrap();

            host.mark_execution_unknown(&binding).unwrap();
            let challenge_status: String = host
                .connection
                .query_row(
                    "SELECT status FROM effect_challenges WHERE challenge_id=?1",
                    [&binding.challenge_id],
                    |row| row.get(0),
                )
                .unwrap();
            let execution_status: String = host
                .connection
                .query_row(
                    "SELECT status FROM stdio_executions WHERE execution_id=?1",
                    [&binding.execution_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(challenge_status, "UNKNOWN");
            assert_eq!(execution_status, "UNKNOWN");
        }

        drop(host);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn managed_verifier_restart_reconciles_unknown_without_the_executable_or_relaunch() {
        use crate::host_kernel::managed_verifier::VerifierInvocationV1;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("hz-managed-verifier-reconcile-{nonce}"));
        let state = base.join("state");
        let workspace = base.join("workspace");
        let executable = workspace.join("verifier");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        fs::copy("/bin/sh", &executable).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

        let canonical_executable = fs::canonicalize(&executable).unwrap();
        let executable_digest =
            crate::terminal_process::executable_digest(&canonical_executable).unwrap();
        let profile_digest = format!("blake3:{}", "a".repeat(64));
        let revision = format!("blake3:{}", "b".repeat(64));
        let binding = StdioExecutionBindingV1 {
            execution_id: "execution_verifier_reconcile".to_owned(),
            effect_id: "effect_verifier_reconcile".to_owned(),
            challenge_id: "challenge_verifier_reconcile".to_owned(),
            principal: "server_auth:reviewer".to_owned(),
            session_id: String::new(),
            location_id: "location_verifier_reconcile".to_owned(),
            capability_id: guard::BUILTIN_VERIFIER_ID.to_owned(),
            capability_lease_digest: format!("blake3:{}", "c".repeat(64)),
            approved_arguments_digest: format!("blake3:{}", "d".repeat(64)),
            attempt_scope_digest: None,
            owner_epoch: 7,
            generation: 9,
            workspace_revision: revision.clone(),
            profile_ref: "profile_verifier_reconcile".to_owned(),
            profile_id: "profile_verifier_reconcile".to_owned(),
            profile_revision: 1,
            profile_digest: profile_digest.clone(),
            executable_digest: executable_digest.clone(),
        };
        let mut launch = StdioLaunchSpec::new(
            canonical_executable.clone(),
            executable_digest.clone(),
            ["-c", "printf must-not-run"],
            workspace.clone(),
        );
        launch.profile_digest = profile_digest.clone();
        launch.workspace_revision = revision;
        launch.workspace_root = workspace.clone();
        launch.timeout = Duration::from_secs(2);
        launch.max_output_bytes = 1024;
        let invocation = VerifierInvocationV1::test_fixture_from_host_fields(
            "goal_verifier_reconcile".to_owned(),
            "run_verifier_reconcile".to_owned(),
            "spec_verifier_reconcile".to_owned(),
            format!("blake3:{}", "e".repeat(64)),
            "verification_verifier_reconcile".to_owned(),
            "criterion_verifier_reconcile".to_owned(),
            format!("blake3:{}", "f".repeat(64)),
            "server_auth:reviewer".to_owned(),
            "profile_verifier_reconcile".to_owned(),
            profile_digest.clone(),
            format!("blake3:{}", "1".repeat(64)),
            "unit:criterion_verifier_reconcile".to_owned(),
            8,
            binding.clone(),
            launch,
        )
        .unwrap();

        let mut host = EffectHost::open(&state, None).unwrap();
        host.connection
            .execute(
                "INSERT INTO effect_challenges(
                    challenge_id,effect_id,session_id,principal,batch_id,call_id,capability_id,
                    relative_path,requested_path,target,resource,existed,argument_digest,
                    content_digest,expires_at_ms,status,turn_context_digest,origin_kind
                 ) VALUES (?1,?2,'',?3,?4,?5,?6,'','.','.', '.',0,?7,?8,?9,'RUNNING',?7,'managed_run')",
                params![
                    invocation.challenge_id(),
                    invocation.effect_id(),
                    invocation.reviewer_principal(),
                    invocation.verification_run_id(),
                    invocation.criterion_id(),
                    guard::BUILTIN_VERIFIER_ID,
                    invocation.approved_arguments_digest(),
                    invocation.canonical_arguments_digest(),
                    now_ms().unwrap() as i64 - 1,
                ],
            )
            .unwrap();
        host.connection
            .execute(
                "INSERT INTO broker_process_bindings(
                    challenge_id,profile_id,executable_path,executable_digest,profile_digest
                 ) VALUES (?1,?2,?3,?4,?5)",
                params![
                    invocation.challenge_id(),
                    invocation.profile_id(),
                    canonical_executable.to_string_lossy(),
                    executable_digest,
                    profile_digest,
                ],
            )
            .unwrap();
        host.connection
            .execute(
                "INSERT INTO stdio_executions(
                    execution_id,intent_id,effect_id,challenge_id,principal,session_id,location_id,
                    capability_id,capability_lease_digest,attempt_scope_digest,owner_epoch,generation,
                    workspace_revision,profile_ref,profile_id,profile_revision,profile_digest,executable_digest,
                    execution_digest,confinement_record,status,created_at_ms,updated_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,'',?6,?7,?8,NULL,?9,?10,?11,?12,?13,?14,?15,?16,?17,'enforced','RUNNING',?18,?18)",
                params![
                    invocation.execution_id(),
                    "intent_verifier_reconcile",
                    invocation.effect_id(),
                    invocation.challenge_id(),
                    invocation.reviewer_principal(),
                    invocation.location_id(),
                    guard::BUILTIN_VERIFIER_ID,
                    invocation.lease_digest(),
                    invocation.owner_epoch() as i64,
                    invocation.execution_generation() as i64,
                    invocation.final_revision(),
                    invocation.profile_id(),
                    invocation.profile_revision() as i64,
                    invocation.profile_digest(),
                    invocation.executable_digest(),
                    format!("blake3:{}", "2".repeat(64)),
                    now_ms().unwrap() as i64,
                ],
            )
            .unwrap();
        fs::remove_file(&executable).unwrap();

        let outcome = host.reconcile_managed_verifier(&invocation).unwrap();
        assert!(matches!(
            outcome,
            ManagedVerifierObservedOutcomeV1::Unknown { .. }
        ));
        let status: String = host
            .connection
            .query_row(
                "SELECT status FROM stdio_executions WHERE execution_id=?1",
                [invocation.execution_id()],
                |row| row.get(0),
            )
            .unwrap();
        let challenge_status: String = host
            .connection
            .query_row(
                "SELECT status FROM effect_challenges WHERE challenge_id=?1",
                [invocation.challenge_id()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "UNKNOWN");
        assert_eq!(challenge_status, "UNKNOWN");

        drop(host);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn managed_verifier_rejects_guard_digest_mismatch_before_preflight_or_spawn() {
        use crate::host_kernel::managed_verifier::VerifierInvocationV1;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("hz-managed-verifier-deny-{nonce}"));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();

        let executable = fs::canonicalize("/bin/sh").unwrap();
        let executable_digest = crate::terminal_process::executable_digest(&executable).unwrap();
        let profile_digest = format!("blake3:{}", "a".repeat(64));
        let revision = format!("blake3:{}", "d".repeat(64));
        let binding = StdioExecutionBindingV1 {
            execution_id: "execution_verifier_denied".to_owned(),
            effect_id: "effect_verifier_denied".to_owned(),
            challenge_id: "challenge_verifier_denied".to_owned(),
            principal: "server_auth:reviewer".to_owned(),
            session_id: String::new(),
            location_id: "location_verifier_denied".to_owned(),
            capability_id: guard::BUILTIN_VERIFIER_ID.to_owned(),
            capability_lease_digest: format!("blake3:{}", "c".repeat(64)),
            approved_arguments_digest: format!("blake3:{}", "b".repeat(64)),
            attempt_scope_digest: None,
            owner_epoch: 7,
            generation: 9,
            workspace_revision: revision.clone(),
            profile_ref: "profile_verifier_denied".to_owned(),
            profile_id: "profile_verifier_denied".to_owned(),
            profile_revision: 1,
            profile_digest: profile_digest.clone(),
            executable_digest: executable_digest.clone(),
        };
        let mut launch = StdioLaunchSpec::new(
            executable.clone(),
            executable_digest.clone(),
            ["-c", "printf should-not-run"],
            workspace.clone(),
        );
        launch.profile_digest = profile_digest.clone();
        launch.workspace_revision = revision;
        launch.workspace_root = workspace.clone();
        launch.max_output_bytes = 1024;
        launch.timeout = Duration::from_secs(2);
        let invocation = VerifierInvocationV1::test_fixture_from_host_fields(
            "goal_verifier_denied".to_owned(),
            "run_verifier_denied".to_owned(),
            "spec_verifier_denied".to_owned(),
            format!("blake3:{}", "e".repeat(64)),
            "verification_verifier_denied".to_owned(),
            "criterion_denied".to_owned(),
            format!("blake3:{}", "f".repeat(64)),
            "server_auth:reviewer".to_owned(),
            "profile_verifier_denied".to_owned(),
            profile_digest.clone(),
            format!("blake3:{}", "1".repeat(64)),
            "unit:criterion_denied".to_owned(),
            4,
            binding.clone(),
            launch,
        )
        .unwrap();

        let mut host = EffectHost::open(&state, None).unwrap();
        let wrong_guard_digest = format!("blake3:{}", "9".repeat(64));
        host.connection
            .execute(
                "INSERT INTO effect_challenges(
                    challenge_id,effect_id,session_id,principal,batch_id,call_id,capability_id,
                    relative_path,requested_path,target,resource,existed,argument_digest,
                    content_digest,expires_at_ms,status,turn_context_digest,origin_kind
                 ) VALUES (?1,?2,'',?3,?4,?5,?6,'','.','.', '.',0,?7,?8,?9,'APPROVED',?8,'managed_run')",
                params![
                    invocation.challenge_id(),
                    invocation.effect_id(),
                    invocation.reviewer_principal(),
                    invocation.verification_run_id(),
                    invocation.criterion_id(),
                    guard::BUILTIN_VERIFIER_ID,
                    wrong_guard_digest,
                    invocation.canonical_arguments_digest(),
                    now_ms().unwrap() as i64 + 60_000,
                ],
            )
            .unwrap();
        host.connection
            .execute(
                "INSERT INTO broker_process_bindings(
                    challenge_id,profile_id,executable_path,executable_digest,profile_digest
                 ) VALUES (?1,?2,?3,?4,?5)",
                params![
                    invocation.challenge_id(),
                    invocation.profile_id(),
                    executable.to_string_lossy(),
                    executable_digest,
                    profile_digest,
                ],
            )
            .unwrap();

        let mut supervisor = StdioExecutionSupervisor::default();
        let error = match host.execute_managed_verifier(&invocation, &mut supervisor, None) {
            Ok(_) => panic!("Guard argument digest mismatch must fail before confined preflight"),
            Err(error) => error,
        };
        assert_eq!(error.code, "effect_denied");
        assert!(supervisor.status(invocation.stdio_binding()).is_err());
        let executions: i64 = host
            .connection
            .query_row("SELECT COUNT(*) FROM stdio_executions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(executions, 0);
        let status: String = host
            .connection
            .query_row(
                "SELECT status FROM effect_challenges WHERE challenge_id=?1",
                [invocation.challenge_id()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "APPROVED");

        drop(host);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn stdio_restart_recovery_returns_unknown_only_for_the_persisted_owner_scope() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("hz-stdio-recovery-{nonce}"));
        let state = base.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();

        let host = EffectHost::open(&state, None).unwrap();
        host.connection.execute(
            "INSERT INTO effect_challenges(
                challenge_id,effect_id,session_id,principal,batch_id,call_id,capability_id,
                relative_path,requested_path,target,resource,existed,argument_digest,content_digest,
                expires_at_ms,status,turn_context_digest,origin_kind
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,'','.','.', '.',0,?8,?8,?9,'PREPARED',?8,'session_batch')",
            params![
                "challenge_stdio_recovery",
                "effect_stdio_recovery",
                "session_stdio_recovery",
                "host_os_uid:1000",
                "batch_stdio_recovery",
                "call_stdio_recovery",
                guard::TERMINAL_RUN_ID,
                format!("blake3:{}", "a".repeat(64)),
                now_ms().unwrap() as i64 + 60_000,
            ],
        ).unwrap();
        host.connection.execute(
            "INSERT INTO stdio_executions(
                execution_id,intent_id,effect_id,challenge_id,principal,session_id,location_id,
                capability_id,capability_lease_digest,attempt_scope_digest,owner_epoch,generation,
                workspace_revision,profile_ref,profile_id,profile_revision,profile_digest,executable_digest,
                execution_digest,confinement_record,status,created_at_ms,updated_at_ms
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,11,4,?10,'linux-bash','linux-bash',1,?11,?12,?13,'enforced','RUNNING',?14,?14)",
            params![
                "execution_stdio_recovery",
                "intent_stdio_recovery",
                "effect_stdio_recovery",
                "challenge_stdio_recovery",
                "host_os_uid:1000",
                "session_stdio_recovery",
                "location_stdio_recovery",
                guard::TERMINAL_RUN_ID,
                format!("blake3:{}", "b".repeat(64)),
                format!("blake3:{}", "c".repeat(64)),
                format!("blake3:{}", "d".repeat(64)),
                format!("blake3:{}", "e".repeat(64)),
                format!("blake3:{}", "f".repeat(64)),
                now_ms().unwrap() as i64,
            ],
        ).unwrap();
        drop(host);

        let recovered_host = EffectHost::open(&state, None).unwrap();
        let recovered = recovered_host
            .reconcile_execution(
                "execution_stdio_recovery",
                "effect_stdio_recovery",
                "challenge_stdio_recovery",
                "host_os_uid:1000",
                "location_stdio_recovery",
            )
            .unwrap();
        assert_eq!(recovered.status.state, StdioExecutionStateV1::Unknown);
        assert_eq!(recovered.binding.generation, 4);
        assert_eq!(
            recovered.binding.approved_arguments_digest,
            format!("blake3:{}", "a".repeat(64))
        );
        assert_eq!(recovered.status.receipt_digest, None);
        assert_eq!(
            recovered_host
                .reconcile_execution(
                    "execution_stdio_recovery",
                    "effect_stdio_recovery",
                    "challenge_stdio_recovery",
                    "host_os_uid:1001",
                    "location_stdio_recovery",
                )
                .unwrap_err()
                .code,
            "approval_not_found"
        );
        assert_eq!(
            recovered_host
                .reconcile_execution(
                    "execution_stdio_recovery",
                    "effect_other",
                    "challenge_other",
                    "host_os_uid:1000",
                    "location_stdio_recovery",
                )
                .unwrap_err()
                .code,
            "approval_not_found"
        );

        drop(recovered_host);
        fs::remove_dir_all(base).unwrap();
    }

    fn http_test_binding(execution_id: &str) -> HttpExecutionBindingV1 {
        HttpExecutionBindingV1 {
            execution_id: execution_id.to_owned(),
            effect_id: "effect_http_test".to_owned(),
            challenge_id: "challenge_http_test".to_owned(),
            principal: "host_os_uid:1000".to_owned(),
            session_id: "session_http_test".to_owned(),
            location_id: "location_http_test".to_owned(),
            capability_id: guard::WEB_SEARCH_ID.to_owned(),
            capability_lease_digest: format!("blake3:{}", "a".repeat(64)),
            approved_arguments_digest: format!("blake3:{}", "b".repeat(64)),
            attempt_scope_digest: None,
            owner_epoch: 7,
            generation: 1,
            workspace_revision: format!("blake3:{}", "c".repeat(64)),
            route_id: "builtin-search".to_owned(),
            request_digest: format!("blake3:{}", "d".repeat(64)),
        }
    }

    fn seed_approved_http_challenge(host: &EffectHost, binding: &HttpExecutionBindingV1) {
        host.connection.execute(
            "INSERT INTO effect_challenges(
                challenge_id,effect_id,session_id,principal,batch_id,call_id,capability_id,
                relative_path,requested_path,target,resource,existed,argument_digest,content_digest,
                expires_at_ms,status,turn_context_digest,origin_kind
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,'','','','','0',?8,?8,?9,'APPROVED',?8,'session_batch')",
            params![
                binding.challenge_id,
                binding.effect_id,
                binding.session_id,
                binding.principal,
                "batch_http_test",
                "call_http_test",
                binding.capability_id,
                binding.approved_arguments_digest,
                now_ms().unwrap() as i64 + 60_000,
            ],
        ).unwrap();
    }

    #[test]
    fn http_effect_receipt_is_one_use_durable_and_recovers_without_body_bytes() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("hz-http-receipt-{nonce}"));
        let state = base.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();

        let binding = http_test_binding("execution_http_test");
        let prepared = HttpExecutionPreparedV1 {
            execution_id: binding.execution_id.clone(),
            generation: binding.generation,
            execution_digest: binding.request_digest.clone(),
            approved_arguments_digest: binding.approved_arguments_digest.clone(),
            capability_lease_digest: binding.capability_lease_digest.clone(),
        };
        let mut host = EffectHost::open(&state, None).unwrap();
        seed_approved_http_challenge(&host, &binding);
        let mut altered_binding = binding.clone();
        altered_binding.approved_arguments_digest = format!("blake3:{}", "e".repeat(64));
        let altered_preflight = HttpExecutionPreparedV1 {
            approved_arguments_digest: altered_binding.approved_arguments_digest.clone(),
            ..prepared.clone()
        };
        assert_eq!(
            host.authorize_http_preflight(&altered_binding, &altered_preflight)
                .unwrap_err()
                .code,
            "effect_denied"
        );
        assert_eq!(
            host.begin_http_dispatch(&altered_binding, &altered_preflight)
                .unwrap_err()
                .code,
            "effect_denied"
        );
        host.authorize_http_preflight(&binding, &prepared).unwrap();
        let intent = host.begin_http_dispatch(&binding, &prepared).unwrap();
        assert_eq!(
            host.begin_http_dispatch(&binding, &prepared)
                .unwrap_err()
                .code,
            "effect_conflict"
        );
        host.mark_http_running(&binding, &intent).unwrap();
        let body = b"bounded response".to_vec();
        let response = HttpResponseV1 {
            status: 200,
            retry_after_ms: None,
            retry_after_header: None,
            body_digest: format!("blake3:{}", blake3::hash(&body).to_hex()),
            body,
            body_truncated: false,
            response_complete: true,
            connected_peer: "93.184.216.34".parse().unwrap(),
        };
        let receipt = host.settle_http_execution(&binding, &response).unwrap();
        assert_eq!(receipt.http_status, 200);
        assert_eq!(receipt.body_bytes, 16);
        assert!(!receipt.body_truncated);
        drop(host);

        let recovered_host = EffectHost::open(&state, None).unwrap();
        let recovered = recovered_host
            .reconcile_http_execution(
                &binding.execution_id,
                &binding.effect_id,
                &binding.challenge_id,
                &binding.principal,
                &binding.location_id,
            )
            .unwrap();
        assert_eq!(recovered.status.state, HttpExecutionStateV1::Settled);
        assert_eq!(
            recovered.status.receipt_digest.as_deref(),
            Some(receipt.receipt_digest.as_str())
        );
        assert_eq!(
            recovered.status.body_digest.as_deref(),
            Some(response.body_digest.as_str())
        );
        assert_eq!(recovered.status.body_bytes, 16);
        assert_eq!(
            recovered_host
                .reconcile_http_execution(
                    &binding.execution_id,
                    &binding.effect_id,
                    &binding.challenge_id,
                    "host_os_uid:1001",
                    &binding.location_id,
                )
                .unwrap_err()
                .code,
            "approval_not_found"
        );
        let columns: i64 = recovered_host.connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('http_executions') WHERE name IN ('body','response_body')",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(columns, 0, "HTTP response bytes must not be persisted");

        drop(recovered_host);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn interrupted_http_effect_recovers_unknown_and_never_relaunches() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("hz-http-unknown-{nonce}"));
        let state = base.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();

        let binding = http_test_binding("execution_http_unknown");
        let prepared = HttpExecutionPreparedV1 {
            execution_id: binding.execution_id.clone(),
            generation: binding.generation,
            execution_digest: binding.request_digest.clone(),
            approved_arguments_digest: binding.approved_arguments_digest.clone(),
            capability_lease_digest: binding.capability_lease_digest.clone(),
        };
        let mut host = EffectHost::open(&state, None).unwrap();
        seed_approved_http_challenge(&host, &binding);
        let _intent = host.begin_http_dispatch(&binding, &prepared).unwrap();
        drop(host);

        let mut recovered_host = EffectHost::open(&state, None).unwrap();
        let recovered = recovered_host
            .reconcile_http_execution(
                &binding.execution_id,
                &binding.effect_id,
                &binding.challenge_id,
                &binding.principal,
                &binding.location_id,
            )
            .unwrap();
        assert_eq!(recovered.status.state, HttpExecutionStateV1::Unknown);
        assert_eq!(
            recovered_host
                .begin_http_dispatch(&binding, &prepared)
                .unwrap_err()
                .code,
            "effect_conflict"
        );
        assert_eq!(
            recovered_host
                .reconcile_http_execution(
                    &binding.execution_id,
                    &binding.effect_id,
                    &binding.challenge_id,
                    &binding.principal,
                    "location_other",
                )
                .unwrap_err()
                .code,
            "approval_not_found"
        );

        drop(recovered_host);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn cancelled_http_dispatch_is_unknown_and_cannot_settle_or_relaunch() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("hz-http-cancel-{nonce}"));
        let state = base.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();

        let binding = http_test_binding("execution_http_cancel");
        let prepared = HttpExecutionPreparedV1 {
            execution_id: binding.execution_id.clone(),
            generation: binding.generation,
            execution_digest: binding.request_digest.clone(),
            approved_arguments_digest: binding.approved_arguments_digest.clone(),
            capability_lease_digest: binding.capability_lease_digest.clone(),
        };
        let mut host = EffectHost::open(&state, None).unwrap();
        seed_approved_http_challenge(&host, &binding);
        let intent = host.begin_http_dispatch(&binding, &prepared).unwrap();
        host.mark_http_running(&binding, &intent).unwrap();
        host.mark_http_unknown(&binding).unwrap();
        // A repeated cancel/reconcile settlement remains idempotent, but cannot turn an
        // ambiguous request into a known response or permit a second send.
        host.mark_http_unknown(&binding).unwrap();
        assert_eq!(
            host.settle_http_execution(
                &binding,
                &HttpResponseV1 {
                    status: 200,
                    retry_after_ms: None,
                    retry_after_header: None,
                    body: b"late response".to_vec(),
                    body_digest: format!("blake3:{}", blake3::hash(b"late response").to_hex()),
                    body_truncated: false,
                    response_complete: true,
                    connected_peer: "93.184.216.34".parse().unwrap(),
                },
            )
            .unwrap_err()
            .code,
            "effect_outcome_unknown"
        );
        assert_eq!(
            host.begin_http_dispatch(&binding, &prepared)
                .unwrap_err()
                .code,
            "effect_conflict"
        );
        let recovered = host
            .reconcile_http_execution(
                &binding.execution_id,
                &binding.effect_id,
                &binding.challenge_id,
                &binding.principal,
                &binding.location_id,
            )
            .unwrap();
        assert_eq!(recovered.status.state, HttpExecutionStateV1::Unknown);
        assert_eq!(recovered.status.http_status, None);
        assert_eq!(recovered.status.receipt_digest, None);

        drop(host);
        fs::remove_dir_all(base).unwrap();
    }

    fn test_request(operation: &str, body: Value, request_id: u64) -> RpcRequestV1 {
        RpcRequestV1 {
            owner_epoch: 11,
            process_incarnation: "inc_managed_scope_test".to_owned(),
            request_id: format!("req_managed_scope_{request_id}"),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: operation.to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms().unwrap() + 30_000,
            trace_id: format!("trace_managed_scope_{request_id}"),
            body,
        }
    }

    fn response_string<'a>(response: &'a RpcResponseV1, key: &str) -> &'a str {
        let Some(Value::Map(fields)) = response.body.as_ref() else {
            panic!("expected response map")
        };
        match fields.get(key) {
            Some(Value::String(value)) => value,
            _ => panic!("missing string field {key}"),
        }
    }

    #[test]
    fn write_dispatch_rejects_missing_or_changed_managed_attempt_scope_before_effect() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "hz-managed-scope-effect-{}-{nonce}",
            std::process::id()
        ));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();

        let mut host = EffectHost::open(&state, Some(&workspace)).unwrap();
        let fence = FrameFence::new(11, "inc_managed_scope_test").unwrap();
        let scope = scope();
        let prepared = host.handle_request(
            "ses_scope_test",
            "host_os_uid:1000",
            &test_request(
                "prepare_tool_batch",
                map_value([
                    ("sessionId", Value::String(scope.session_id.clone())),
                    ("batchId", Value::String("batch_scope_test".to_owned())),
                    (
                        "turnContextDigest",
                        Value::String("sha256:0000000000000000000000000000000000000000000000000000000000000000".to_owned()),
                    ),
                    (
                        "managedAttempt",
                        scope.to_value(),
                    ),
                    (
                        "calls",
                        Value::Array(vec![map_value([
                            ("callId", Value::String("call_scope_test".to_owned())),
                            ("capabilityId", Value::String(guard::FILES_WRITE_ID.to_owned())),
                            (
                                "arguments",
                                map_value([
                                    ("path", Value::String("managed.txt".to_owned())),
                                    ("content", Value::String("managed".to_owned())),
                                ]),
                            ),
                        ])]),
                    ),
                ]),
                1,
            ),
            true,
            &fence,
        );
        assert_eq!(prepared.outcome, RpcOutcomeV1::Ok, "{:?}", prepared.error);
        let challenge_id = response_string(&prepared, "challengeId").to_owned();
        let approved = host.handle_request(
            "ses_scope_test",
            "host_os_uid:1000",
            &test_request(
                "resolve_approval",
                map_value([
                    ("sessionId", Value::String(scope.session_id.clone())),
                    ("challengeId", Value::String(challenge_id.clone())),
                    ("approved", Value::Bool(true)),
                ]),
                2,
            ),
            true,
            &fence,
        );
        assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);

        let mut stale_scope = scope.clone();
        stale_scope.attempt_id = "attempt_forged".to_owned();
        let stale = host.handle_request(
            "ses_scope_test",
            "host_os_uid:1000",
            &test_request(
                "execute_write",
                map_value([
                    ("sessionId", Value::String(scope.session_id.clone())),
                    ("challengeId", Value::String(challenge_id.clone())),
                    ("content", Value::String("managed".to_owned())),
                    ("managedAttempt", stale_scope.to_value()),
                ]),
                3,
            ),
            true,
            &fence,
        );
        assert_eq!(stale.outcome, RpcOutcomeV1::Error);
        assert!(!workspace.join("managed.txt").exists());

        let omitted = host.handle_request(
            "ses_scope_test",
            "host_os_uid:1000",
            &test_request(
                "execute_write",
                map_value([
                    ("sessionId", Value::String(scope.session_id.clone())),
                    ("challengeId", Value::String(challenge_id.clone())),
                    ("content", Value::String("managed".to_owned())),
                ]),
                4,
            ),
            true,
            &fence,
        );
        assert_eq!(omitted.outcome, RpcOutcomeV1::Error);
        assert!(!workspace.join("managed.txt").exists());

        let exact = host.handle_request(
            "ses_scope_test",
            "host_os_uid:1000",
            &test_request(
                "execute_write",
                map_value([
                    ("sessionId", Value::String(scope.session_id.clone())),
                    ("challengeId", Value::String(challenge_id)),
                    ("content", Value::String("managed".to_owned())),
                    ("managedAttempt", scope.to_value()),
                ]),
                5,
            ),
            true,
            &fence,
        );
        assert_eq!(exact.outcome, RpcOutcomeV1::Ok, "{:?}", exact.error);
        assert_eq!(
            fs::read_to_string(workspace.join("managed.txt")).unwrap(),
            "managed"
        );

        drop(host);
        fs::remove_dir_all(base).unwrap();
    }
}
