//! Durable, fail-closed executor for the first ToolBatch filesystem effect.
//!
//! Approval records contain only identifiers, paths, BLAKE3 digests and decisions. The
//! UTF-8 content is supplied again at execution time and is never persisted.

use crate::guard;
use crate::messagepack::Value;
use crate::protocol::{
    ErrorCategoryV1, MAX_BODY_BYTES, MAX_IDENTIFIER_BYTES, RetryClassV1, RpcOutcomeV1,
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
    batch_id: String,
    call_id: String,
    capability_id: String,
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

    fn digest(&self, relative: &Path) -> io::Result<String> {
        read_target_digest(&self.root_handle, relative)
    }
}

impl EffectHost {
    /// Open durable effect state and reconcile every unresolved PREPARED write before READY.
    pub fn open(state_dir: &Path, workspace_root: Option<&Path>) -> Result<Self, String> {
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
                    turn_context_digest TEXT NOT NULL
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
        let mut host = Self {
            connection,
            execution,
        };
        host.reconcile_prepared()
            .map_err(|_| "unresolved effects could not be reconciled".to_owned())?;
        Ok(host)
    }

    /// Dispatch a request received on the already-authenticated supervisor channel.
    pub fn handle_request(
        &mut self,
        process_session_id: &str,
        request: &RpcRequestV1,
        effect_feature_enabled: bool,
    ) -> RpcResponseV1 {
        let result = if request.service_id != EFFECTS_SERVICE_ID {
            Err(Failure::Invalid)
        } else if !effect_feature_enabled {
            Err(Failure::FeatureNotNegotiated)
        } else if let Err(failure) = validate_effect_request_deadline(request.deadline_unix_ms) {
            Err(failure)
        } else {
            match request.operation.as_str() {
                "prepare_tool_batch" => self.prepare_tool_batch(process_session_id, &request.body),
                "resolve_approval" => self.resolve_approval(process_session_id, &request.body),
                "execute_write" => self.execute_write(process_session_id, &request.body),
                _ => Err(Failure::Invalid),
            }
        };
        match result {
            Ok(body) => RpcResponseV1 {
                request_id: request.request_id.clone(),
                outcome: RpcOutcomeV1::Ok,
                owner_cursor: None,
                receipt_digest: None,
                body: Some(body),
                error: None,
            },
            Err(failure) => RpcResponseV1 {
                request_id: request.request_id.clone(),
                outcome: RpcOutcomeV1::Error,
                owner_cursor: None,
                receipt_digest: None,
                body: None,
                error: Some(failure.error()),
            },
        }
    }

    fn prepare_tool_batch(
        &mut self,
        process_session_id: &str,
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
        let call_id = text(call, "callId")?;
        validate_identifier(call_id)?;
        let capability_id = text(call, "capabilityId")?;
        if capability_id != "files.write" {
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
            batch_id,
            call_id,
            capability_id,
            path,
            &relative_text,
            &resource,
            &content_digest,
            turn_context_digest,
            &challenge_id,
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
                    receipt_digest, turn_context_digest
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                           'AWAITING_APPROVAL', NULL, NULL, NULL, NULL, ?15)",
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
        ]))
    }

    fn resolve_approval(
        &mut self,
        process_session_id: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        let body = strict_map(body, &["sessionId", "challengeId", "approved"])?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
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
        if challenge.session_id != session_id {
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
            let (decision, intent_digest) = guard_decision(
                execution,
                &challenge.session_id,
                &challenge.batch_id,
                &challenge.call_id,
                &challenge.capability_id,
                &challenge.requested_path,
                &challenge.relative_path,
                &challenge.resource,
                &challenge.content_digest,
                &challenge.turn_context_digest,
                &challenge.challenge_id,
            );
            if decision.decision != guard::DecisionKind::Ask
                || intent_digest != challenge.argument_digest
            {
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

    fn execute_write(&mut self, process_session_id: &str, body: &Value) -> Result<Value, Failure> {
        let body = strict_map(body, &["sessionId", "challengeId", "content"])?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
        let challenge_id = text(body, "challengeId")?;
        validate_identifier(challenge_id)?;
        let content = text(body, "content")?;
        validate_content(content)?;
        let challenge = load_challenge(&self.connection, challenge_id)?.ok_or(Failure::NotFound)?;
        if challenge.session_id != session_id {
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
                &challenge.batch_id,
                &challenge.call_id,
                &challenge.capability_id,
                &challenge.requested_path,
                &challenge.relative_path,
                &challenge.resource,
                &challenge.content_digest,
                &challenge.turn_context_digest,
                &challenge.challenge_id,
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
        let lease = self.persist_prepared(&challenge, &after_digest, &lease_id)?;

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
        &mut self,
        challenge: &Challenge,
        after_digest: &str,
        lease_id: &str,
    ) -> Result<ExecutionLease, Failure> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
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
                 WHERE challenge_id=?2 AND status='PREPARED'",
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
                        content_digest, expires_at_ms, status, after_digest, turn_context_digest
                 FROM effect_challenges WHERE status='PREPARED' ORDER BY challenge_id",
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
                        &challenge.batch_id,
                        &challenge.call_id,
                        &challenge.capability_id,
                        &challenge.requested_path,
                        &challenge.relative_path,
                        &challenge.resource,
                        &challenge.content_digest,
                        &challenge.turn_context_digest,
                        &challenge.challenge_id,
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
                    content_digest, expires_at_ms, status, after_digest, turn_context_digest
             FROM effect_challenges WHERE challenge_id=?1",
            [challenge_id],
            row_to_challenge,
        )
        .optional()
        .map_err(|_| Failure::Unavailable)
}

fn guard_decision(
    execution: &ExecutionHost,
    session_id: &str,
    batch_id: &str,
    call_id: &str,
    capability_id: &str,
    requested_path: &str,
    relative_path: &str,
    resource: &str,
    content_digest: &str,
    turn_context_digest: &str,
    challenge_id: &str,
) -> (guard::GuardDecisionV1, String) {
    let target = execution.root().join(relative_path);
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
        principal: session_id,
        origin: guard::EffectOriginV1 {
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

fn row_to_challenge(row: &rusqlite::Row<'_>) -> rusqlite::Result<Challenge> {
    let existed: i64 = row.get(10)?;
    let expires_at_ms: i64 = row.get(13)?;
    Ok(Challenge {
        challenge_id: row.get(0)?,
        effect_id: row.get(1)?,
        session_id: row.get(2)?,
        batch_id: row.get(3)?,
        call_id: row.get(4)?,
        capability_id: row.get(5)?,
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

fn text<'a>(map: &'a BTreeMap<String, Value>, key: &str) -> Result<&'a str, Failure> {
    match map.get(key) {
        Some(Value::String(value)) => Ok(value),
        _ => Err(Failure::Invalid),
    }
}

fn require_session(process_session_id: &str, request_session_id: &str) -> Result<(), Failure> {
    if process_session_id == request_session_id && validate_identifier(request_session_id).is_ok() {
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
