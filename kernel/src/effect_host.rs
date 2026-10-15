//! Durable, fail-closed executor for ToolBatch filesystem effects.
//!
//! Approval records contain only identifiers, paths, BLAKE3 digests and decisions. Write
//! content is supplied again at execution time; patch content is canonical base64 decoded
//! to exact postimage bytes. Neither is persisted.

use crate::guard;
use crate::messagepack::{self, FRAME_LIMITS, Value};
use crate::protocol::{
    ErrorCategoryV1, FrameFence, MAX_BODY_BYTES, MAX_IDENTIFIER_BYTES, RetryClassV1, RpcOutcomeV1,
    RpcRequestV1, RpcResponseV1, TypedErrorV1, validate_deadline,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const EFFECTS_SERVICE_ID: &str = "effects.v2";
const CHALLENGE_TTL_MS: u64 = 5 * 60 * 1000;
const MAX_WRITE_BYTES: usize = 768 * 1024;
/// Durable origin kinds. The kind is recorded when the effect is admitted and is never
/// re-derived from caller-supplied values.
const ORIGIN_SESSION_BATCH: &str = "session_batch";
const ORIGIN_USER_ACTION: &str = "user_action";
const EFFECTS_DB: &str = "effects.sqlite";
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
    fn consume(self, challenge_id: &str) -> io::Result<String> {
        if self.challenge_id != challenge_id {
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
        target: ExecutionTarget,
        bytes: &[u8],
    ) -> io::Result<String> {
        let lease_id = lease.consume(challenge_id)?;
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
        targets: &[PatchTarget],
    ) -> io::Result<String> {
        let lease_id = lease.consume(challenge_id)?;
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
                    origin_kind TEXT NOT NULL DEFAULT 'session_batch'
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
                );",
            )
            .map_err(|_| "effect database schema could not be initialized".to_owned())?;
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
            _ => return Err(Failure::Unknown.error()),
        };
        let mut fields = BTreeMap::from([
            ("status".to_owned(), Value::String(status.to_owned())),
            (
                "effectID".to_owned(),
                Value::String(challenge.effect_id.clone()),
            ),
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

    pub fn prepare_terminal_run(
        &mut self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        arguments: &Value,
    ) -> Result<(), TypedErrorV1> {
        self.begin_terminal_effect(
            process_session_id,
            principal,
            challenge_id,
            arguments,
            guard::TERMINAL_RUN_ID,
        )
        .map_err(Failure::error)
    }

    pub fn prepare_terminal_start(
        &mut self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        arguments: &Value,
    ) -> Result<(), TypedErrorV1> {
        self.begin_terminal_effect(
            process_session_id,
            principal,
            challenge_id,
            arguments,
            guard::TERMINAL_START_ID,
        )
        .map_err(Failure::error)
    }

    pub fn authorize_terminal_continuation(
        &self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        effect_id: &str,
    ) -> Result<(), TypedErrorV1> {
        self.check_terminal_continuation(process_session_id, principal, challenge_id, effect_id)
            .map_err(Failure::error)
    }

    fn check_terminal_continuation(
        &self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        effect_id: &str,
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
        );
        if decision.decision != guard::DecisionKind::Ask || intent != challenge.argument_digest {
            return Err(Failure::Denied);
        }
        Ok(())
    }

    fn begin_terminal_effect(
        &mut self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        arguments: &Value,
        capability_id: &str,
    ) -> Result<(), Failure> {
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
                "UPDATE effect_challenges SET status='PREPARED',lease_id=?1
             WHERE challenge_id=?2 AND status='APPROVED'",
                params![lease_id, challenge_id],
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

    fn prepare_tool_batch(
        &mut self,
        process_session_id: &str,
        principal: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        let body = strict_map(
            body,
            &["sessionId", "batchId", "turnContextDigest", "calls"],
        )?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
        let batch_id = text(body, "batchId")?;
        validate_identifier(batch_id)?;
        let turn_context_digest = text(body, "turnContextDigest")?;
        if !guard::is_sha256_digest(turn_context_digest) {
            return Err(Failure::Invalid);
        }
        let calls = match body.get("calls") {
            Some(Value::Array(calls)) if calls.len() != 1 => {
                return Ok(denied_batch("only_one_call_supported"));
            }
            Some(Value::Array(calls)) => calls,
            _ => return Err(Failure::Invalid),
        };
        let call = strict_map(&calls[0], &["callId", "capabilityId", "arguments"])?;
        let capability_id = text(call, "capabilityId")?;
        let call_id = text(call, "callId")?;
        validate_identifier(call_id)?;
        if capability_id == guard::TERMINAL_RUN_ID || capability_id == guard::TERMINAL_START_ID {
            let arguments = call.get("arguments").ok_or(Failure::Invalid)?;
            return self.prepare_terminal_effect(
                TerminalOrigin {
                    kind: guard::EffectOriginKindV1::SessionBatch,
                    session_id,
                    principal,
                    batch_id,
                    call_id,
                    turn_context_digest,
                    capability_id,
                },
                arguments,
            );
        }
        if capability_id == guard::FILES_PATCH_ID {
            return self.prepare_patch(
                session_id,
                principal,
                batch_id,
                call_id,
                turn_context_digest,
                &calls[0],
            );
        }
        if capability_id != guard::FILES_WRITE_ID {
            return Ok(denied_batch("unsupported_capability"));
        }
        let arguments = strict_map(
            call.get("arguments").ok_or(Failure::Invalid)?,
            &["path", "content"],
        )?;
        let path = text(arguments, "path")?;
        let content = text(arguments, "content")?;
        validate_content(content)?;
        let execution = match self.execution.as_ref() {
            Some(execution) => execution,
            None => return Ok(denied_batch("workspace_root_unconfigured")),
        };
        let (relative, relative_text) = match normalize_workspace_path(execution.root(), path) {
            Ok(path) => path,
            Err(Failure::Denied) => return Ok(denied_batch("path_outside_or_unsafe")),
            Err(error) => return Err(error),
        };
        let existed = match execution.inspect(&relative) {
            Ok(existed) => existed,
            Err(_) => return Ok(denied_batch("path_unavailable_or_unsafe")),
        };
        let target_path = execution.root().join(&relative);
        let target = target_path.to_string_lossy().into_owned();
        let resource = relative_text.clone();
        let content_digest = digest_bytes(content.as_bytes());
        let challenge_id = random_id("ch")?;
        let effect_id = random_id("eff")?;
        let expires_at_ms = now_ms()?
            .checked_add(CHALLENGE_TTL_MS)
            .ok_or(Failure::Unavailable)?;
        let (decision, argument_digest) = guard_decision(
            execution,
            session_id,
            principal,
            batch_id,
            call_id,
            capability_id,
            path,
            &relative_text,
            &resource,
            &content_digest,
            turn_context_digest,
            &challenge_id,
            guard::EffectOriginKindV1::SessionBatch,
        );
        if decision.decision != guard::DecisionKind::Ask {
            return Ok(denied_batch(decision.reason_code.unwrap_or("guard_denied")));
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        transaction
            .execute(
                "INSERT INTO effect_challenges (
                    challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
                    relative_path, requested_path, target, resource, existed, argument_digest,
                    content_digest, expires_at_ms, status, approved, after_digest, lease_id,
                    receipt_digest, turn_context_digest, principal, origin_kind
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                           'AWAITING_APPROVAL', NULL, NULL, NULL, NULL, ?15, ?16, 'session_batch')",
                params![
                    challenge_id,
                    effect_id,
                    session_id,
                    batch_id,
                    call_id,
                    capability_id,
                    relative_text,
                    path,
                    target,
                    resource,
                    existed as i64,
                    argument_digest,
                    content_digest,
                    expires_at_ms as i64,
                    turn_context_digest,
                    principal,
                ],
            )
            .map_err(|_| Failure::Unavailable)?;
        transaction.commit().map_err(|_| Failure::Unavailable)?;
        Ok(map_value([
            ("status", Value::String("needs_approval".to_owned())),
            ("challengeId", Value::String(challenge_id)),
            ("effectId", Value::String(effect_id)),
            (
                "target",
                Value::String(target_path.to_string_lossy().into_owned()),
            ),
            ("resource", Value::String(resource)),
            ("existed", Value::Bool(existed)),
            ("inputDigest", Value::String(argument_digest)),
            ("expiresAtUnixMs", Value::Unsigned(expires_at_ms)),
            (
                "normalizedTargets",
                Value::Array(vec![map_value([
                    (
                        "target",
                        Value::String(target_path.to_string_lossy().into_owned()),
                    ),
                    ("resource", Value::String(relative_text)),
                    ("operation", Value::String("write".to_owned())),
                    ("existed", Value::Bool(existed)),
                ])]),
            ),
        ]))
    }

    fn prepare_user_effect(&mut self, principal: &str, body: &Value) -> Result<Value, Failure> {
        let fields = strict_map_optional(
            body,
            &["userActionId", "capabilityId", "arguments"],
            &["sessionId"],
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
        self.prepare_terminal_effect(
            TerminalOrigin {
                kind: guard::EffectOriginKindV1::UserAction,
                session_id,
                principal,
                batch_id: user_action_id,
                call_id: user_action_id,
                turn_context_digest: "",
                capability_id,
            },
            fields.get("arguments").ok_or(Failure::Invalid)?,
        )
    }

    fn prepare_terminal_effect(
        &mut self,
        origin: TerminalOrigin<'_>,
        arguments: &Value,
    ) -> Result<Value, Failure> {
        let TerminalOrigin {
            kind: origin_kind,
            session_id,
            principal,
            batch_id,
            call_id,
            turn_context_digest,
            capability_id,
        } = origin;
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
        let origin_kind_name = match origin_kind {
            guard::EffectOriginKindV1::SessionBatch => ORIGIN_SESSION_BATCH,
            guard::EffectOriginKindV1::UserAction => ORIGIN_USER_ACTION,
        };
        let challenge_id = random_id("ch")?;
        let effect_id = random_id("eff")?;
        let expires_at_ms = now_ms()?
            .checked_add(CHALLENGE_TTL_MS)
            .ok_or(Failure::Unavailable)?;
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
        );
        if decision.decision != guard::DecisionKind::Ask {
            return Ok(denied_batch(decision.reason_code.unwrap_or("guard_denied")));
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        transaction.execute(
            "INSERT INTO effect_challenges (
                challenge_id,effect_id,session_id,principal,batch_id,call_id,capability_id,
                relative_path,requested_path,target,resource,existed,argument_digest,content_digest,
                expires_at_ms,status,approved,after_digest,lease_id,receipt_digest,turn_context_digest,origin_kind
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,?13,?14,'AWAITING_APPROVAL',NULL,NULL,NULL,NULL,?15,?16)",
            params![
                challenge_id,effect_id,session_id,principal,batch_id,call_id,capability_id,
                args.relative_path,args.cwd,args.cwd,args.resource,argument_digest,args.digest,
                expires_at_ms as i64,turn_context_digest,origin_kind_name,
            ],
        ).map_err(|_| Failure::Unavailable)?;
        transaction.execute(
            "INSERT INTO terminal_runs(effect_id,status,created_at_ms) VALUES (?1,'AWAITING_APPROVAL',?2)",
            params![effect_id, now_ms()? as i64],
        ).map_err(|_| Failure::Unavailable)?;
        transaction.commit().map_err(|_| Failure::Unavailable)?;
        Ok(map_value([
            ("status", Value::String("needs_approval".to_owned())),
            ("challengeId", Value::String(challenge_id)),
            ("effectId", Value::String(effect_id)),
            ("inputDigest", Value::String(argument_digest)),
            ("expiresAtUnixMs", Value::Unsigned(expires_at_ms)),
            (
                "normalizedTargets",
                Value::Array(vec![map_value([
                    ("target", Value::String(args.cwd)),
                    ("resource", Value::String(args.resource)),
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
                ])]),
            ),
        ]))
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
            Some(Value::Array(_)) => return Ok(denied_batch("invalid_operation_count")),
            _ => return Err(Failure::Invalid),
        };
        let execution = match self.execution.as_ref() {
            Some(execution) => execution,
            None => return Ok(denied_batch("workspace_root_unconfigured")),
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
                return Ok(denied_batch("unsupported_operation"));
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
                return Ok(denied_batch("patch_too_large"));
            }
            total_bytes = total_bytes
                .checked_add(expected_before.as_ref().map_or(0, Vec::len))
                .ok_or(Failure::Invalid)?;
            if total_bytes > 4 * 1024 * 1024 {
                return Ok(denied_batch("patch_too_large"));
            }
            let content = if operation == "write" {
                let encoded = text(map, "contentBase64")?;
                let decoded = decode_canonical_base64(encoded).ok_or(Failure::Invalid)?;
                if decoded.len() > 2 * 1024 * 1024 {
                    return Ok(denied_batch("patch_too_large"));
                }
                total_bytes = total_bytes
                    .checked_add(decoded.len())
                    .ok_or(Failure::Invalid)?;
                if total_bytes > 4 * 1024 * 1024 {
                    return Ok(denied_batch("patch_too_large"));
                }
                Some(decoded)
            } else {
                None
            };
            if operation == "delete" && expected_before.is_none() {
                return Ok(denied_batch("delete_requires_preimage"));
            }
            let (relative, relative_text) = match normalize_workspace_path(execution.root(), path) {
                Ok(path) => path,
                Err(_) => return Ok(denied_batch("path_outside_or_unsafe")),
            };
            if !paths.insert(relative_text.clone()) {
                return Ok(denied_batch("duplicate_path"));
            }
            let existed = match execution.inspect(&relative) {
                Ok(existed) => existed,
                Err(_) => return Ok(denied_batch("path_unavailable_or_unsafe")),
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
                return Ok(denied_batch("stale_preimage"));
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
        let expires_at_ms = now_ms()?
            .checked_add(CHALLENGE_TTL_MS)
            .ok_or(Failure::Unavailable)?;
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
        ) else {
            return Ok(denied_batch("guard_denied"));
        };
        let first = &targets[0];
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        transaction.execute(
            "INSERT INTO effect_challenges (challenge_id,effect_id,session_id,batch_id,call_id,capability_id,relative_path,requested_path,target,resource,existed,argument_digest,content_digest,expires_at_ms,status,approved,after_digest,lease_id,receipt_digest,turn_context_digest,principal,origin_kind)
             VALUES (?1,?2,?3,?4,?5,'files.patch',?6,?7,?8,?9,?10,?11,?12,?13,'AWAITING_APPROVAL',NULL,NULL,NULL,NULL,?14,?15,'session_batch')",
            params![challenge_id,effect_id,session_id,batch_id,call_id,first.relative_path,first.requested_path,first.target,first.resource,first.existed as i64,argument_digest,canonical,expires_at_ms as i64,turn_context_digest,principal],
        ).map_err(|_| Failure::Unavailable)?;
        for (ordinal, target) in targets.iter().enumerate() {
            transaction.execute(
                "INSERT INTO patch_targets (challenge_id,ordinal,operation,relative_path,requested_path,target,resource,existed,before_digest,after_digest,content_digest,requested_executable,before_mode,mode) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![challenge_id,ordinal as i64,target.operation,target.relative_path,target.requested_path,target.target,target.resource,target.existed as i64,target.before_digest,target.after_digest,target.content_digest,target.requested_executable.map(|value| if value { 1i64 } else { 0i64 }),target.before_mode,target.mode],
            ).map_err(|_| Failure::Unavailable)?;
        }
        transaction.commit().map_err(|_| Failure::Unavailable)?;
        Ok(map_value([
            ("status", Value::String("needs_approval".into())),
            ("challengeId", Value::String(challenge_id)),
            ("effectId", Value::String(effect_id)),
            (
                "targets",
                Value::Array(targets.iter().map(patch_target_value).collect()),
            ),
            ("inputDigest", Value::String(argument_digest)),
            ("expiresAtUnixMs", Value::Unsigned(expires_at_ms)),
            (
                "normalizedTargets",
                Value::Array(targets.iter().map(patch_target_value).collect()),
            ),
        ]))
    }

    fn execute_patch(
        &mut self,
        process_session_id: &str,
        principal: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        let body = strict_map(body, &["sessionId", "challengeId", "operations"])?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
        let challenge_id = text(body, "challengeId")?;
        validate_identifier(challenge_id)?;
        let challenge = load_challenge(&self.connection, challenge_id)?.ok_or(Failure::NotFound)?;
        if challenge.session_id != session_id || challenge.principal != principal {
            return Err(Failure::Denied);
        }
        if challenge.capability_id != guard::FILES_PATCH_ID || challenge.status != "APPROVED" {
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
        let result = execution.apply_patch(lease, challenge_id, &targets);
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
                    challenge_origin_kind(&challenge),
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

    fn execute_write(
        &mut self,
        process_session_id: &str,
        principal: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        let body = strict_map(body, &["sessionId", "challengeId", "content"])?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
        let challenge_id = text(body, "challengeId")?;
        validate_identifier(challenge_id)?;
        let content = text(body, "content")?;
        validate_content(content)?;
        let challenge = load_challenge(&self.connection, challenge_id)?.ok_or(Failure::NotFound)?;
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
            execution.write(lease, challenge_id, target, output.as_ref())
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

    fn reconcile_prepared(&mut self) -> Result<(), Failure> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
                        relative_path, requested_path, target, resource, existed, argument_digest,
                        content_digest, expires_at_ms, status, after_digest, turn_context_digest, principal, origin_kind
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

fn load_challenge(
    connection: &Connection,
    challenge_id: &str,
) -> Result<Option<Challenge>, Failure> {
    connection
        .query_row(
            "SELECT challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
                    relative_path, requested_path, target, resource, existed, argument_digest,
                    content_digest, expires_at_ms, status, after_digest, turn_context_digest, principal, origin_kind
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
                    content_digest, expires_at_ms, status, after_digest, turn_context_digest, principal, origin_kind
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
fn challenge_origin_kind(challenge: &Challenge) -> guard::EffectOriginKindV1 {
    if challenge.origin_kind == ORIGIN_USER_ACTION {
        guard::EffectOriginKindV1::UserAction
    } else {
        guard::EffectOriginKindV1::SessionBatch
    }
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
        policy_snapshot_ids: &policy_snapshot_ids,
        requested_guarantees: &requested_guarantees,
    };
    let decision = guard::authorize(&request, challenge_id);
    let intent_digest = guard::intent_digest(&request, &decision);
    (decision, intent_digest)
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
fn denied_batch(reason: &str) -> Value {
    map_value([
        ("status", Value::String("denied".to_owned())),
        ("reason", Value::String(reason.to_owned())),
    ])
}
