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
    HttpResponseV1, ManagedProviderEffectBindingV1, ManagedProviderPrepareBindingV1,
    ManagedProviderSendAuthorizationV1, ManagedProviderInferenceRecoveryV1,
    MAX_HTTP_RESPONSE_BYTES,
};
use crate::messagepack::{self, FRAME_LIMITS, Value};
use crate::protocol::{
    ArtifactClassificationV1, ArtifactRefV1, EffectAttemptScopeV1, ErrorCategoryV1, FrameFence,
    MAX_BODY_BYTES, MAX_IDENTIFIER_BYTES, RetryClassV1, RpcOutcomeV1, RpcRequestV1,
    RpcResponseV1, TypedErrorV1, validate_deadline,
};
use crate::request_cancellation::RequestCancellation;
use crate::terminal_process::{
    StdioExecutionBindingV1, StdioExecutionDispatchIntentV1, StdioExecutionPreparedV1,
    StdioExecutionReceiptV1, StdioExecutionRecoveryV1, StdioExecutionStateV1,
    StdioExecutionStatusV1, StdioExecutionSupervisor, StdioProcessKindV1, StdioProcessRefV1,
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
const ORIGIN_MANAGED_ROOT: &str = "managed_root";
const EFFECTS_DB: &str = "effects.sqlite";
const MAX_STDIO_EXECUTIONS: usize = 128;
const MAX_STDIO_RECEIPT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_HTTP_EXECUTIONS: usize = 64;
const MAX_TERMINAL_CAPTURE_BYTES: u64 = 100 * 1024 * 1024;
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DirectSessionGrantErrorV1 { Invalid, Conflict, NotFound, Unavailable }

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectSessionGrantProjectionV1 {
    pub(crate) grant_id: String,
    pub(crate) grant_digest: String,
    pub(crate) scope_kind: String,
    pub(crate) scope_digest: String,
    pub(crate) expires_at_unix_ms: Option<u64>,
    pub(crate) status: String,
    pub(crate) revoked_at_unix_ms: Option<u64>,
}

/// Durable direct-session CodeMode enablement projection. The value itself stays
/// schema-strict; lifecycle status and revocation time are returned alongside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeEnablementProjectionV1 {
    pub(crate) value: Value,
    pub(crate) status: String,
    pub(crate) revoked_at_unix_ms: Option<u64>,
}

impl DirectSessionGrantProjectionV1 {
    fn from_grant(grant: &crate::direct_session_grant::DirectSessionGrantV1, status: &str) -> Self {
        let scope_value = if grant.scope_kind == "network_egress" {
            Value::Map(std::collections::BTreeMap::from([
                ("destinations".to_owned(), Value::Array(grant.destinations.clone())),
                ("maxRequests".to_owned(), Value::Unsigned(grant.max_requests.unwrap_or_default())),
                ("maxBytes".to_owned(), Value::Unsigned(grant.max_bytes.unwrap_or_default())),
            ]))
        } else { grant.scope.clone() };
        let encoded = messagepack::encode(&scope_value, FRAME_LIMITS).unwrap_or_default();
        Self {
            grant_id: grant.grant_id.clone(),
            grant_digest: grant.grant_digest.clone(),
            scope_kind: grant.scope_kind.clone(),
            scope_digest: format!("blake3:{}", blake3::hash(&encoded).to_hex()),
            expires_at_unix_ms: grant.expires_at_unix_ms,
            status: status.to_owned(),
            revoked_at_unix_ms: None,
        }
    }
}

fn direct_session_grant_event_digest(
    kind: &str, grant_id: &str, grant_digest: &str, event_value: &[u8],
    revoked_at: Option<u64>, revoked_by: Option<&str>,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.direct-session-grant-event.v1\0");
    for value in [kind.as_bytes(), grant_id.as_bytes(), grant_digest.as_bytes(), event_value,
        revoked_by.unwrap_or("").as_bytes()] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    hasher.update(&revoked_at.unwrap_or_default().to_be_bytes());
    format!("blake3:{}", hasher.finalize().to_hex())
}

#[derive(Clone, Debug)]
struct DirectCodeModeEnablementClaimsV1 {
    grant_id: String,
    principal_digest: String,
    session_id: String,
    owner_epoch: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
    revocation_generation: u64,
    enablement_digest: String,
}

fn sha256_principal_digest(principal: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, principal.as_bytes());
    format!("sha256:{}", digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

fn parse_direct_code_mode_enablement(value: &Value) -> Result<DirectCodeModeEnablementClaimsV1, TypedErrorV1> {
    let Value::Map(fields) = value else { return Err(Failure::Invalid.error()) };
    const REQUIRED: [&str; 18] = [
        "schemaVersion", "lane", "grantId", "principalDigest", "sessionID", "ownerEpoch",
        "capabilityId", "helperSelector", "helperDigest", "resourceProfileId",
        "resourceProfileDigest", "backend", "guaranteeDigest", "policyDigest", "issuedAtMs",
        "expiresAtMs", "revocationGeneration", "enablementDigest",
    ];
    if fields.len() != REQUIRED.len() || REQUIRED.iter().any(|key| !fields.contains_key(*key))
        || !matches!(fields.get("schemaVersion"), Some(Value::Unsigned(1)))
        || !matches!(fields.get("lane"), Some(Value::String(value)) if value == "direct_session")
        || !matches!(fields.get("capabilityId"), Some(Value::String(value)) if value == "codemode.execute")
        || !matches!(fields.get("helperSelector"), Some(Value::String(value)) if value == "horizoncode:codemode:bun")
        || !matches!(fields.get("resourceProfileId"), Some(Value::String(value)) if value == "codemode.v1")
        || !matches!(fields.get("backend"), Some(Value::String(value)) if value == "linux-cgroup-v2")
    { return Err(Failure::Invalid.error()); }
    let grant_id = text(fields, "grantId")?.to_owned();
    let principal_digest = text(fields, "principalDigest")?.to_owned();
    let session_id = text(fields, "sessionID")?.to_owned();
    let helper_digest = text(fields, "helperDigest")?;
    let resource_profile_digest = text(fields, "resourceProfileDigest")?;
    let guarantee_digest = text(fields, "guaranteeDigest")?;
    let policy_digest = text(fields, "policyDigest")?;
    let enablement_digest = text(fields, "enablementDigest")?.to_owned();
    let valid_schema_id = |id: &str| !id.is_empty() && id.len() <= 256
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'));
    if !valid_schema_id(&grant_id) || !session_id.starts_with("ses_")
        || session_id.len() > 132 || session_id.len() < 5
        || !session_id[4..].bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    { return Err(Failure::Invalid.error()); }
    for digest in [&principal_digest, &helper_digest] {
        if !guard::is_sha256_digest(digest) { return Err(Failure::Invalid.error()); }
    }
    for digest in [&resource_profile_digest, &guarantee_digest, &policy_digest, &enablement_digest] {
        if !is_blake3_digest(digest) { return Err(Failure::Invalid.error()); }
    }
    let decimal = |key: &str| -> Result<u64, TypedErrorV1> {
        let raw = text(fields, key)?;
        if !canonical_u64(raw) { return Err(Failure::Invalid.error()); }
        raw.parse::<u64>().map_err(|_| Failure::Invalid.error())
    };
    let owner_epoch = decimal("ownerEpoch")?;
    let issued_at_ms = decimal("issuedAtMs")?;
    let expires_at_ms = decimal("expiresAtMs")?;
    let revocation_generation = decimal("revocationGeneration")?;
    if owner_epoch == 0 || expires_at_ms <= issued_at_ms || expires_at_ms - issued_at_ms > 30 * 24 * 60 * 60 * 1000 {
        return Err(Failure::Invalid.error());
    }
    let mut immutable = fields.clone();
    immutable.remove("enablementDigest");
    immutable.remove("revocationGeneration");
    let encoded = messagepack::encode(&Value::Map(immutable), FRAME_LIMITS).map_err(|_| Failure::Invalid.error())?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.codemode-enablement.v1\0");
    hasher.update(&encoded);
    if format!("blake3:{}", hasher.finalize().to_hex()) != enablement_digest {
        return Err(Failure::Invalid.error());
    }
    Ok(DirectCodeModeEnablementClaimsV1 {
        grant_id, principal_digest, session_id, owner_epoch, issued_at_ms,
        expires_at_ms, revocation_generation, enablement_digest,
    })
}

fn code_mode_enablement_event_digest(kind: &str, claims: &DirectCodeModeEnablementClaimsV1, value: &[u8]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.codemode-enablement-event.v1\0");
    for item in [kind.as_bytes(), claims.grant_id.as_bytes(), claims.principal_digest.as_bytes(),
        claims.session_id.as_bytes(), claims.enablement_digest.as_bytes(), value] {
        hasher.update(&(item.len() as u64).to_be_bytes());
        hasher.update(item);
    }
    hasher.update(&claims.owner_epoch.to_be_bytes());
    hasher.update(&claims.revocation_generation.to_be_bytes());
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn latest_code_mode_enablement_projection(
    connection: &Connection,
    grant_id: &str,
    now_unix_ms: u64,
) -> Result<Option<CodeModeEnablementProjectionV1>, TypedErrorV1> {
    let row: Option<(String, String, String, i64, String, i64, Vec<u8>, String, i64)> = connection.query_row(
        "SELECT event_kind,principal_digest,session_id,owner_epoch,enablement_digest,
         revocation_generation,enablement_value,event_digest,created_at_ms
         FROM code_mode_enablement_events WHERE grant_id=?1 ORDER BY sequence DESC LIMIT 1",
        [grant_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?)),
    ).optional().map_err(|_| Failure::Unavailable.error())?;
    let Some((kind, principal_digest, session_id, owner_epoch, enablement_digest,
        generation, encoded, event_digest, created_at)) = row else { return Ok(None) };
    let value = messagepack::decode(&encoded, FRAME_LIMITS).map_err(|_| Failure::Unknown.error())?;
    let claims = parse_direct_code_mode_enablement(&value)?;
    if claims.grant_id != grant_id || claims.principal_digest != principal_digest
        || claims.session_id != session_id || owner_epoch <= 0 || claims.owner_epoch != owner_epoch as u64
        || claims.enablement_digest != enablement_digest || generation <= 0
        || claims.revocation_generation != generation as u64 || created_at < 0
        || !matches!(kind.as_str(), "ISSUED" | "REVOKED")
        || code_mode_enablement_event_digest(&kind, &claims, &encoded) != event_digest
    { return Err(Failure::Unknown.error()); }
    let status = if kind == "REVOKED" { "revoked" }
        else if claims.expires_at_ms <= now_unix_ms { "expired" } else { "active" };
    Ok(Some(CodeModeEnablementProjectionV1 {
        value, status: status.to_owned(),
        revoked_at_unix_ms: (kind == "REVOKED").then_some(created_at as u64),
    }))
}

/// HostKernel-authenticated reference to the immutable capture of a supervised
/// terminal run. Raw output bytes never enter EffectHost persistence.
pub(crate) struct TerminalOutputCaptureV1 {
    pub(crate) artifact_ref: ArtifactRefV1,
    pub(crate) output_digest: String,
    pub(crate) fidelity: crate::artifact_store::ArtifactFidelityV1,
    pub(crate) observed_bytes: u64,
    pub(crate) dropped_bytes: u64,
    pub(crate) truncated: bool,
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
    /// Durable origin kind recorded at admission.
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
    /// Present only for direct-session launches governed by an explicit permission
    /// mode. Both values are pinned together to prevent mode changes between prompt
    /// and one-use lease consumption.
    pub direct_permission_mode_digest: Option<String>,
    pub direct_permission_mode_revision: Option<u64>,
}

/// Exact immutable verifier launch pins assessed before the reviewer is shown an
/// approval challenge. The one-use capability lease is intentionally absent here;
/// it is minted only after the complete challenge set is approved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedVerifierPreflightBindingV1 {
    pub challenge_id: String,
    pub effect_id: String,
    pub principal: String,
    pub execution_principal: String,
    pub session_id: String,
    pub location_id: String,
    pub attempt_scope_digest: String,
    pub owner_epoch: u64,
    pub generation: u64,
    pub workspace_revision: String,
    pub approved_arguments_digest: String,
    pub profile_id: String,
    pub profile_revision: u64,
    pub profile_digest: String,
    pub executable_digest: String,
}

impl ManagedVerifierPreflightBindingV1 {
    fn digest(&self) -> Result<String, Failure> {
        for value in [
            self.challenge_id.as_str(), self.effect_id.as_str(), self.principal.as_str(),
            self.execution_principal.as_str(), self.session_id.as_str(), self.location_id.as_str(),
            self.profile_id.as_str(),
        ] {
            validate_identifier(value)?;
        }
        if self.principal == self.execution_principal || self.owner_epoch == 0 || self.generation == 0
            || self.profile_revision == 0
            || !is_blake3_digest(&self.attempt_scope_digest)
            || !is_blake3_digest(&self.workspace_revision)
            || !is_blake3_digest(&self.approved_arguments_digest)
            || !is_blake3_digest(&self.profile_digest)
            || !is_blake3_digest(&self.executable_digest)
        {
            return Err(Failure::Invalid);
        }
        let owner_epoch = self.owner_epoch.to_string();
        let generation = self.generation.to_string();
        let profile_revision = self.profile_revision.to_string();
        let fields = [
            self.challenge_id.as_str(), self.effect_id.as_str(), self.principal.as_str(),
            self.execution_principal.as_str(), self.session_id.as_str(), self.location_id.as_str(),
            self.attempt_scope_digest.as_str(), owner_epoch.as_str(), generation.as_str(),
            self.workspace_revision.as_str(), self.approved_arguments_digest.as_str(),
            self.profile_id.as_str(), profile_revision.as_str(), self.profile_digest.as_str(),
            self.executable_digest.as_str(),
        ];
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.managed-verifier-preflight-binding.v1\0");
        for field in fields {
            hasher.update(&(field.len() as u64).to_be_bytes());
            hasher.update(field.as_bytes());
        }
        Ok(format!("blake3:{}", hasher.finalize().to_hex()))
    }
}

/// Opaque receipt that proves EffectHost durably bound a no-child sandbox
/// assessment to a pending exact verifier challenge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedVerifierPreflightReceiptV1 {
    challenge_id: String,
    binding_digest: String,
    launch_digest: String,
    guarantee_digest: String,
}

impl ManagedVerifierPreflightReceiptV1 {
    pub(crate) fn challenge_id(&self) -> &str { &self.challenge_id }
    pub(crate) fn binding_digest(&self) -> &str { &self.binding_digest }
    pub(crate) fn launch_digest(&self) -> &str { &self.launch_digest }
    pub(crate) fn guarantee_digest(&self) -> &str { &self.guarantee_digest }
}

/// Durable state for a Guarded non-filesystem control-plane mutation. `Started`
/// is written before the owning registry CAS, so a crash can never be mistaken
/// for a safe-to-retry absence. The registry's post-CAS receipt is linked back
/// through `Settled` using its canonical receipt digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GuardedControlEffectStateV1 {
    NotDispatched,
    Started,
    Unknown,
    Settled { receipt_digest: String },
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

#[derive(Clone)]
struct TerminalWorkspaceProfileProjectionV1 {
    reference: crate::direct_session_grant::WorkspaceCommandGrantRefV1,
    profile: crate::workspace_command_profile::WorkspaceCommandProfileV1,
    resolved_environment: BTreeMap<String, String>,
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
        execution_principal: String,
        scope: crate::terminal_process::StdioExecutionScopeV1,
    },
    WebSearch {
        requested_path: String,
        relative_path: String,
        resource: String,
    },
    /// A user-approved durable control-plane mutation. The effect journal records
    /// its Guard intent and one-use lease; the owning registry records the actual
    /// CAS receipt and cross-log proof.
    GuardedControl {
        requested_path: String,
        relative_path: String,
        resource: String,
        operation: String,
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
    /// Trusted principal that owns the launched process. For managed verifier work
    /// this is profile-derived and intentionally differs from reviewer approval.
    pub(crate) execution_principal: String,
    pub(crate) user_action_id: String,
    pub(crate) call_id: String,
    pub(crate) scope: crate::terminal_process::StdioExecutionScopeV1,
    pub(crate) session_id: String,
    /// Digest of the exact managed Attempt scope authorized for this broker process.
    /// Core never supplies this independently; HostKernel constructs it from the live
    /// OwnerLog snapshot and the authenticated frame fence.
    pub(crate) managed_attempt_digest: Option<String>,
    /// Digest of the exact P8 root-coordinator lifecycle operation. For this origin it
    /// is stored as the broker challenge's content digest and Guard intent input.
    pub(crate) managed_root_scope_digest: Option<String>,
    pub(crate) workspace_cwd: String,
    pub(crate) resource: String,
    pub(crate) profile_id: String,
    pub(crate) executable_path: String,
    pub(crate) executable_digest: String,
    pub(crate) profile_digest: String,
    pub(crate) argument_bundle_digest: String,
}

/// EffectHost's durable result after an authenticated direct-session mode has
/// promoted a complete prepared batch. HostKernel still owns the live authority
/// fence and one-use lease minting; this is only the exact durable transition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectModeBatchApprovalV1 {
    pub(crate) batch_id: String,
    pub(crate) challenge_ids: Vec<String>,
    pub(crate) effect_ids: Vec<String>,
    pub(crate) approval_digest: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DirectModeBatchDecision {
    Candidate,
    Ask,
    Deny,
    Unavailable,
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
    /// Digest of the exact schema-decoded argument map admitted for this call.
    /// Populated by complete ToolBatch admission; empty only for private
    /// single-effect records which are not eligible for wave binding.
    arguments_digest: String,
    /// Digest of the full Guard decision and its canonical argument tuple.
    argument_digest: String,
    /// Write content digest, patch manifest digest, or terminal argument digest.
    content_digest: String,
    expires_at_ms: u64,
    managed_attempt_digest: Option<String>,
    effect: PlannedEffect,
}

/// Exact approved ToolBatch member projection used to bind a managed CodeMode wave
/// to the durable OwnerLog edge set. `call_index` is explicitly persisted at batch
/// admission; callers must not reconstruct it from request order or hash-map order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApprovedBatchEffectCandidateV1 {
    pub(crate) call_index: u8,
    pub(crate) call_id: String,
    pub(crate) challenge_id: String,
    pub(crate) effect_id: String,
    pub(crate) capability_id: String,
    pub(crate) arguments_digest: String,
    /// Exact Guard intent digest approved at initial ToolBatch admission. Unlike
    /// the challenge's mutable current-scope digest, this is immutable so the
    /// OwnerLog wave binds the authority the reviewer actually approved.
    pub(crate) intent_digest: String,
    pub(crate) status: String,
    pub(crate) attempt_scope_digest: Option<String>,
}

/// HostKernel-selected batch member for post-restart receipt reconciliation.
/// Each effect retains the exact managed Attempt-scope digest current at its
/// admission; one batch may contain multiple refreshed scopes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedAttemptEffectReceiptPinV1 {
    pub(crate) batch_id: String,
    pub(crate) call_index: u8,
    pub(crate) call_id: String,
    pub(crate) effect_id: String,
    pub(crate) attempt_scope_digest: String,
}

/// Read-only Guard receipt projection. `status` is copied from the durable Guard
/// challenge row; UNKNOWN is returned explicitly and is never rewritten as a
/// terminal success or safe-to-retry outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedAttemptEffectReceiptV1 {
    pub(crate) batch_id: String,
    pub(crate) call_index: u8,
    pub(crate) call_id: String,
    pub(crate) effect_id: String,
    pub(crate) challenge_id: String,
    pub(crate) capability_id: String,
    pub(crate) attempt_scope_digest: String,
    pub(crate) status: String,
    pub(crate) capability_lease_digest: Option<String>,
    pub(crate) receipt_kind: String,
    pub(crate) receipt_digest: String,
}

/// HostKernel-selected immutable owner-log edge for recovery of one direct-root
/// CodeMode wave. Direct sessions have no synthetic Attempt: authorization is the
/// exact authenticated CodeMode authority plus the committed, ordered edge set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectSessionCodeModeEffectReceiptPinV1 {
    pub(crate) call_index: u8,
    pub(crate) call_id: String,
    pub(crate) challenge_id: Option<String>,
    pub(crate) effect_id: Option<String>,
    pub(crate) arguments_digest: String,
    pub(crate) intent_digest: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectSessionCodeModeWaveReceiptPinV1 {
    pub(crate) batch_id: String,
    pub(crate) wave_index: u8,
    pub(crate) frame_digest: String,
    /// Absent only when the complete wave was rejected before Guard admission;
    /// there is then no bound/advanced wave digest to claim.
    pub(crate) wave_digest: Option<String>,
    pub(crate) direct_session_scope_digest: String,
    pub(crate) direct_turn_scope_digest: Option<String>,
    pub(crate) calls: Vec<DirectSessionCodeModeEffectReceiptPinV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectSessionCodeModeEffectReceiptV1 {
    pub(crate) batch_id: String,
    pub(crate) wave_index: u8,
    pub(crate) call_index: u8,
    pub(crate) call_id: String,
    pub(crate) challenge_id: Option<String>,
    pub(crate) effect_id: Option<String>,
    pub(crate) capability_id: Option<String>,
    pub(crate) status: String,
    pub(crate) receipt_ref: String,
    pub(crate) receipt_kind: String,
    pub(crate) receipt_digest: String,
}

/// Receipt-backed artifact provenance for one settled direct child terminal.run.
/// This proves only the Guard/EffectHost half of provenance; HostKernel must still
/// bind the call to its authenticated Session transcript and verify ArtifactStore
/// metadata before exposing bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectAttemptTerminalArtifactReceiptV1 {
    pub(crate) batch_id: String,
    pub(crate) call_index: u8,
    pub(crate) call_id: String,
    pub(crate) effect_id: String,
    pub(crate) challenge_id: String,
    pub(crate) attempt_scope_digest: String,
    pub(crate) receipt_digest: String,
    pub(crate) output_digest: String,
    pub(crate) artifact_ref: ArtifactRefV1,
    pub(crate) artifact_fidelity: String,
    pub(crate) observed_bytes: String,
    pub(crate) dropped_bytes: String,
}

/// Receipt-backed terminal artifact produced by a root DirectSession batch. The
/// owner epoch is authenticated by HostKernel's session journal; EffectHost proves
/// the immutable challenge, settlement and artifact provenance below it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectSessionTerminalArtifactReceiptV1 {
    pub(crate) owner_epoch: u64,
    /// Workspace revision pinned into the durable terminal launch preflight.
    /// This is the revision observed before dispatch, never a fresh filesystem
    /// observation made while projecting the artifact.
    pub(crate) workspace_revision: String,
    pub(crate) batch_id: String,
    pub(crate) call_index: u8,
    pub(crate) call_id: String,
    pub(crate) effect_id: String,
    pub(crate) challenge_id: String,
    pub(crate) receipt_digest: String,
    pub(crate) output_digest: String,
    pub(crate) artifact_ref: ArtifactRefV1,
    pub(crate) artifact_fidelity: String,
    pub(crate) observed_bytes: String,
    pub(crate) dropped_bytes: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ActiveCodeModeOuterEffectV1 {
    pub(crate) batch_id: String,
    pub(crate) call_id: String,
    pub(crate) challenge_id: String,
    pub(crate) effect_id: String,
    pub(crate) execution_id: String,
    pub(crate) origin_kind: String,
    pub(crate) capability_lease_digest: String,
    pub(crate) attempt_scope_digest: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedEffectWaveEdgeV1 {
    pub(crate) call_index: u8,
    pub(crate) call_id: String,
    pub(crate) effect_id: String,
    pub(crate) capability_id: String,
    pub(crate) arguments_digest: String,
    pub(crate) intent_digest: String,
}

/// Lane-specific authority for nested CodeMode effects. Direct sessions are
/// authenticated HostKernel sessions and intentionally have no synthetic Attempt;
/// managed effects retain the live Attempt scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodeModeAuthorityScopeV1 {
    DirectSession {
        /// Current HostKernel-computed workspace revision. Refreshed at each wave.
        workspace_revision_digest: String,
        /// Optional ordinary filesystem grant; this is distinct from the
        /// CodeModeEnablementV1 digest pinned on the enclosing authority.
        direct_session_grant_digest: Option<String>,
    },
    ManagedAttempt(crate::protocol::EffectAttemptScopeV1),
}

/// Authenticated identity of one short-lived CodeMode helper. HostKernel builds this
/// only after resolving the live outer `codemode.execute` Effect/lease and rechecking
/// its direct-turn or managed-Attempt authority. The helper protocol never serializes
/// this value and cannot supply or refresh any of its pins.
#[derive(Clone, Debug)]
pub(crate) struct CodeModeExecutionAuthorityV1 {
    pub(crate) request_id: String,
    pub(crate) execution_id: String,
    pub(crate) effect_id: String,
    pub(crate) challenge_id: String,
    pub(crate) principal: String,
    pub(crate) session_id: String,
    pub(crate) location_id: String,
    pub(crate) owner_epoch: u64,
    pub(crate) generation: u64,
    pub(crate) capability_lease_digest: String,
    pub(crate) authority_scope: CodeModeAuthorityScopeV1,
    /// Direct child-turn authority is separately checked by HostKernel. A root
    /// DirectSession has no DirectTurnScope; managed attempts leave this absent.
    pub(crate) direct_turn_scope_digest: Option<String>,
    /// Exact authorized Core tool projection. It is built by HostKernel from the
    /// current lane's registered tool tree, never copied from a helper frame.
    pub(crate) authorized_tools: Vec<crate::codemode_protocol::CodeModeToolV1>,
    pub(crate) tool_set_digest: String,
    pub(crate) enablement_digest: String,
    /// SHA-256 of the exact self-contained packaged helper bytes.
    pub(crate) helper_digest: String,
    pub(crate) resource_profile_digest: String,
    pub(crate) policy_digest: String,
    pub(crate) turn_context_digest: String,
    pub(crate) deadline_unix_ms: u64,
}

/// Result of durable nested-wave admission. `batch` is the exact existing Guard
/// challenge projection; it is not a lease and cannot be dispatched until the normal
/// approval/Attempt binding/one-use lease transition completes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeWaveAdmissionV1 {
    pub(crate) batch_id: String,
    pub(crate) wave_index: u8,
    pub(crate) total_calls: u64,
    pub(crate) total_argument_bytes: u64,
    pub(crate) batch: Value,
}

/// Host-owned immutable identity of a nested ToolBatch member. These fields are
/// retained before Guard admission so settlement can compare Core's result rows
/// against the original helper request without trusting a caller-supplied manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeWaveCallIdentityV1 {
    pub(crate) call_index: u8,
    pub(crate) call_id: String,
    pub(crate) tool_name: String,
    pub(crate) capability_id: String,
    pub(crate) dispatch_kind: CodeModeWaveCallKindV1,
    pub(crate) arguments_digest: String,
}

/// Trusted execution classification copied from the canonical capability
/// descriptor when the exact frame is durably reserved. It is never inferred
/// from a capability identifier or supplied by the model/helper.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodeModeWaveCallKindV1 {
    Effect,
    HostCallback,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeWaveCallClassificationV1 {
    pub(crate) call_id: String,
    pub(crate) kind: CodeModeWaveCallKindV1,
}

impl CodeModeWaveCallKindV1 {
    fn as_str(self) -> &'static str {
        match self { Self::Effect => "effect", Self::HostCallback => "host_callback" }
    }
    fn parse(value: &str) -> Option<Self> {
        match value { "effect" => Some(Self::Effect), "host_callback" => Some(Self::HostCallback), _ => None }
    }
}

/// Read-only projection of one retained CodeMode wave, selected by authenticated
/// EffectHost authority and its exact monotonic wave index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeWaveInspectionV1 {
    pub(crate) batch_id: String,
    pub(crate) frame_digest: String,
    pub(crate) status: String,
    pub(crate) scope_digest: String,
    pub(crate) calls: Vec<CodeModeWaveCallIdentityV1>,
}

/// Caller input for a host-observed terminal nested ToolBatch member. Status and
/// output are accepted only after the corresponding durable challenge is terminal
/// and proves that no effect was dispatched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeWaveCallOutcomeV1 {
    pub(crate) call_id: String,
    pub(crate) status: String,
    pub(crate) output: Option<String>,
    pub(crate) error_code: Option<String>,
}

/// Bounded Core report for one ordered nested call. `output_digest` hashes the
/// exact redacted UTF-8 output projection sent to the helper; raw callback output
/// remains in Core and is never copied into the EffectHost journal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeWaveCallReportV1 {
    pub(crate) call_id: String,
    pub(crate) status: String,
    pub(crate) output_digest: Option<String>,
    pub(crate) output_bytes: Option<u64>,
    pub(crate) error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeWaveCallResultV1 {
    pub(crate) call_id: String,
    pub(crate) status: String,
    pub(crate) output: Option<String>,
    pub(crate) output_bytes: Option<u64>,
    pub(crate) output_digest: Option<String>,
    /// `effect_receipt` is a settled ordinary effect; `host_decision` is a
    /// durable terminal Guard decision. UNKNOWN has no receipt identity.
    pub(crate) receipt_kind: Option<String>,
    pub(crate) receipt_ref: Option<String>,
    pub(crate) receipt_digest: Option<String>,
    pub(crate) error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeWaveReceiptTupleV1 {
    call_index: u8,
    call_id: String,
    status: String,
    receipt_kind: String,
    receipt_ref: String,
    receipt_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodeModeWaveOutcomeV1 {
    pub(crate) status: String,
    pub(crate) results: Vec<CodeModeWaveCallResultV1>,
    /// EffectHost-private integrity digest; never projected as the CodeMode
    /// public wave receipt digest.
    pub(crate) settlement_digest: String,
}

/// Durable, redacted editor lifecycle result owned by EffectHost. It contains a
/// HostKernel-minted process identity and digests only; target paths and file bytes
/// never enter the effect journal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExternalEditorExecutionOutcomeV1 {
    pub(crate) status: String,
    pub(crate) effect_id: String,
    pub(crate) execution_id: String,
    /// HostKernel must retain this exact digest across begin/settle/reconcile.
    pub(crate) binding_digest: String,
    pub(crate) process_ref: crate::terminal_process::StdioProcessRefV1,
    pub(crate) receipt_digest: Option<String>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) result_file_digest: Option<String>,
    /// Durable bounded size of the host-inspected private scratch result. This is
    /// internal metadata; file bytes are returned only by the authenticated reader.
    pub(crate) result_file_bytes: Option<u64>,
    pub(crate) observed_workspace_revision: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodeModeRunStateV1 {
    Ready,
    WavePending,
    Unknown,
    Complete,
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

pub(crate) enum ReplCallbackReplyBeginV1 {
    Dispatch,
    AlreadyDispatched(crate::protocol::ExecutionReplCallbackReplyReceiptV1),
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

fn valid_http_route_outcome(
    outcome: &str,
    result_count: Option<usize>,
    response: &crate::http_execution::HttpResponseV1,
) -> bool {
    match outcome {
        "EMPTY" => result_count == Some(0)
            && (200..300).contains(&response.status)
            && !response.body_truncated
            && response.response_complete,
        "SUCCEEDED" => result_count.is_some_and(|count| count > 0)
            && (200..300).contains(&response.status)
            && !response.body_truncated
            && response.response_complete,
        "RATE_LIMITED" => response.status == 429,
        "RETRYABLE_FAILURE" => matches!(response.status, 408 | 425 | 500..=599),
        "FAILED" => true,
        _ => false,
    }
}

fn valid_next_http_route_attempt(
    previous: Option<(&str, i64, &str, Option<&str>)>,
    route_id: &str,
    attempt: u8,
) -> bool {
    valid_next_http_route_attempt_with_proof(
        previous.map(|(route, count, state, outcome)| (route, count, state, outcome, None)),
        route_id,
        attempt,
    )
}

fn valid_next_http_route_attempt_with_proof(
    previous: Option<(&str, i64, &str, Option<&str>, Option<&str>)>,
    route_id: &str,
    attempt: u8,
) -> bool {
    valid_next_http_route_attempt_from_receipt(
        previous.map(|(route, prior_attempt, state, outcome, failure)|
            (route, prior_attempt, state, outcome, failure, None, None, false)),
        route_id,
        attempt,
    )
}

fn valid_next_http_route_attempt_from_receipt(
    previous: Option<(&str, i64, &str, Option<&str>, Option<&str>, Option<u16>, Option<i64>, bool)>,
    route_id: &str,
    attempt: u8,
) -> bool {
    let Some((prior_route, prior_attempt, prior_state, prior_outcome, prior_failure,
        prior_status, prior_result_count, prior_truncated)) = previous else {
        return attempt == 1;
    };
    if prior_state != "SETTLED" || prior_outcome.is_none() {
        return false;
    }
    let not_dispatched_retryable = prior_outcome == Some("NOT_DISPATCHED")
        && matches!(prior_failure, Some("timed_out" | "transport_failure"));
    if prior_route == route_id {
        prior_attempt.checked_add(1) == Some(i64::from(attempt))
            && (prior_outcome == Some("RETRYABLE_FAILURE")
                || not_dispatched_retryable)
    } else {
        attempt == 1
            && !(prior_outcome == Some("RETRYABLE_FAILURE") && prior_attempt == 1)
            && !(not_dispatched_retryable && prior_attempt == 1)
            && http_route_receipt_allows_next_route(
                prior_outcome.unwrap_or_default(), prior_attempt, prior_failure,
                prior_status, prior_result_count, prior_truncated,
            )
    }
}

fn http_route_receipt_allows_next_route(
    outcome: &str,
    attempt: i64,
    not_dispatched_failure: Option<&str>,
    http_status: Option<u16>,
    result_count: Option<i64>,
    body_truncated: bool,
) -> bool {
    match outcome {
        "EMPTY" => true,
        "RATE_LIMITED" => http_status == Some(429),
        "NOT_DISPATCHED" => attempt >= 2
            && matches!(not_dispatched_failure, Some("timed_out" | "transport_failure")),
        "RETRYABLE_FAILURE" => attempt >= 2
            && http_status.is_some_and(|status| matches!(status, 408 | 425 | 500..=599)),
        "FAILED" => match http_status {
            Some(401 | 403 | 407) => true,
            Some(408 | 425 | 500..=599) => attempt >= 2,
            Some(300..=399) => true,
            Some(200..=299) => body_truncated || result_count.is_none(),
            // Non-authentication 4xx outside the retry set are terminal by policy.
            Some(400..=499) | None => false,
            _ => false,
        },
        _ => false,
    }
}

fn valid_direct_protocol_grant_query(
    process_session_id: &str,
    principal: &str,
    authorization: &crate::protocol::ExecutionProtocolAuthorizationV1,
    query: &crate::direct_session_grant::ActiveGrantQueryV1,
    deadline_unix_ms: u64,
) -> bool {
    !process_session_id.is_empty()
        && !principal.is_empty()
        && query.session_id == process_session_id
        && query.principal_id == principal
        && authorization.session_id == process_session_id
        && authorization.location_id == query.location_id
        && authorization.host_process_ref.owner_epoch() == query.owner_epoch
        && authorization.callback_event_sequence.is_none()
        && matches!(
            (&authorization.operation, authorization.host_process_ref.kind()),
            (
                crate::protocol::ExecutionProtocolOperationV1::Lsp(_),
                crate::terminal_process::StdioProcessKindV1::LanguageServer
            ) | (
                crate::protocol::ExecutionProtocolOperationV1::Dap(_),
                crate::terminal_process::StdioProcessKindV1::DebugAdapter
            )
        )
        && is_blake3_digest(&authorization.workspace_revision)
        && is_blake3_digest(&query.workspace_root_digest)
        && is_blake3_digest(&query.guarantee_set_digest)
        && is_blake3_digest(&query.policy_digest)
        && !query.workspace_id.is_empty()
        && !query.execution_backend_id.is_empty()
        && query.now_unix_ms <= i64::MAX as u64
        && deadline_unix_ms > query.now_unix_ms
        && deadline_unix_ms <= i64::MAX as u64
        && authorization
            .operation
            .operation_digest()
            .ok()
            .as_deref()
            == Some(authorization.operation_digest.as_str())
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
                    capability_lease_digest TEXT,
                    batch_payload_bytes INTEGER NOT NULL DEFAULT 0,
                    direct_session_grant_digest TEXT,
                    call_index INTEGER,
                    arguments_digest TEXT NOT NULL DEFAULT '',
                    admitted_intent_digest TEXT NOT NULL DEFAULT '',
                    managed_wave_receipt_digest TEXT,
                    direct_permission_mode_digest TEXT,
                    direct_permission_mode_revision TEXT
                );
                CREATE TABLE IF NOT EXISTS effect_decision_receipts (
                    effect_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    challenge_id TEXT NOT NULL,
                    batch_id TEXT NOT NULL,
                    call_index INTEGER NOT NULL,
                    call_id TEXT NOT NULL,
                    principal TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    attempt_scope_digest TEXT NOT NULL,
                    receipt_digest TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    PRIMARY KEY(effect_id,status)
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
                    direct_permission_mode_digest TEXT,
                    direct_permission_mode_revision TEXT,
                    status TEXT NOT NULL CHECK (status IN ('PREPARED','CONSUMED','INVALID')),
                    created_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS managed_verifier_preflights (
                    challenge_id TEXT PRIMARY KEY,
                    effect_id TEXT NOT NULL UNIQUE,
                    binding_digest TEXT NOT NULL,
                    launch_digest TEXT NOT NULL,
                    guarantee_digest TEXT NOT NULL,
                    guarantee_record TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('PREPARED','CONSUMED','INVALID')),
                    created_at_ms INTEGER NOT NULL,
                    FOREIGN KEY (challenge_id) REFERENCES effect_challenges(challenge_id)
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
                    -- Legacy compatibility column. New receipts always store X'';
                    -- immutable terminal bytes belong in ArtifactStore.
                    output BLOB NOT NULL DEFAULT X'',
                    output_digest TEXT,
                    artifact_ref TEXT,
                    artifact_ref_v1 BLOB,
                    artifact_fidelity TEXT,
                    observed_bytes TEXT,
                    dropped_bytes TEXT,
                    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
                    receipt_digest TEXT,
                    cgroup_identity BLOB,
                    quiescence_digest TEXT,
                    created_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS external_editor_runs (
                    effect_id TEXT PRIMARY KEY,
                    challenge_id TEXT NOT NULL UNIQUE,
                    execution_id TEXT NOT NULL UNIQUE,
                    process_ref BLOB NOT NULL,
                    binding_digest TEXT NOT NULL,
                    launch_digest TEXT NOT NULL,
                    profile_id TEXT NOT NULL,
                    profile_revision TEXT NOT NULL,
                    profile_digest TEXT NOT NULL,
                    executable_digest TEXT NOT NULL,
                    target_kind TEXT NOT NULL CHECK (target_kind IN ('prompt_scratch','workspace_file')),
                    -- Digest of the private scratch path handed to the editor.
                    target_digest TEXT NOT NULL,
                    -- Digest of the exact selected workspace-relative source path;
                    -- raw paths never enter the durable event/receipt projection.
                    source_path_digest TEXT NOT NULL DEFAULT '',
                    base_workspace_revision TEXT NOT NULL,
                    expected_file_digest TEXT,
                    permission_mode_digest TEXT NOT NULL,
                    permission_mode_revision TEXT NOT NULL,
                    capability_lease_digest TEXT NOT NULL,
                    cgroup_identity BLOB,
                    quiescence_digest TEXT,
                    status TEXT NOT NULL CHECK (status IN ('PREPARED','RUNNING','SETTLED','CANCELLED','UNKNOWN')),
                    terminal_status TEXT,
                    exit_code INTEGER,
                    result_file_digest TEXT,
                    result_file_bytes INTEGER,
                    observed_workspace_revision TEXT,
                    receipt_digest TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS broker_process_bindings (
                    challenge_id TEXT PRIMARY KEY,
                    profile_id TEXT NOT NULL,
                    execution_principal TEXT NOT NULL DEFAULT '',
                    executable_path TEXT NOT NULL,
                    executable_digest TEXT NOT NULL,
                    profile_digest TEXT NOT NULL,
                    scope_kind TEXT NOT NULL DEFAULT 'session',
                    scope_workspace_id TEXT
                );
                CREATE TABLE IF NOT EXISTS stdio_executions (
                    execution_id TEXT PRIMARY KEY,
                    intent_id TEXT NOT NULL UNIQUE,
                    effect_id TEXT NOT NULL UNIQUE,
                    challenge_id TEXT NOT NULL UNIQUE,
                    principal TEXT NOT NULL,
                    execution_principal TEXT NOT NULL DEFAULT '',
                    session_id TEXT NOT NULL,
                    scope_kind TEXT NOT NULL DEFAULT 'session',
                    scope_workspace_id TEXT,
                    direct_session_grant_digest TEXT,
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
                    cgroup_identity BLOB,
                    quiescence_digest TEXT,
                    status TEXT NOT NULL,
                    exit_code INTEGER,
                    stdout_sequence INTEGER NOT NULL DEFAULT 0,
                    stderr_sequence INTEGER NOT NULL DEFAULT 0,
                    stdout_digest TEXT,
                    stderr_digest TEXT,
                    stdout_bytes_data BLOB,
                    stderr_bytes_data BLOB,
                    observed_workspace_revision TEXT,
                    output_bytes INTEGER,
                    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
                    receipt_digest TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS code_mode_enablement_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    grant_id TEXT NOT NULL,
                    event_kind TEXT NOT NULL CHECK (event_kind IN ('ISSUED','REVOKED')),
                    principal_digest TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
                    enablement_digest TEXT NOT NULL,
                    revocation_generation INTEGER NOT NULL CHECK (revocation_generation > 0),
                    enablement_value BLOB NOT NULL,
                    event_digest TEXT NOT NULL UNIQUE,
                    created_at_ms INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS code_mode_enablement_latest
                    ON code_mode_enablement_events(principal_digest,session_id,owner_epoch,sequence DESC);
                CREATE TABLE IF NOT EXISTS code_mode_runs (
                    request_id TEXT PRIMARY KEY,
                    execution_id TEXT NOT NULL UNIQUE,
                    effect_id TEXT NOT NULL UNIQUE,
                    challenge_id TEXT NOT NULL UNIQUE,
                    principal TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    location_id TEXT NOT NULL,
                    owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
                    generation INTEGER NOT NULL CHECK (generation > 0),
                    capability_lease_digest TEXT NOT NULL,
                    attempt_scope_digest TEXT NOT NULL,
                    direct_turn_scope_digest TEXT,
                    tool_set_digest TEXT NOT NULL,
                    enablement_digest TEXT NOT NULL,
                    helper_digest TEXT NOT NULL,
                    resource_profile_digest TEXT NOT NULL,
                    policy_digest TEXT NOT NULL,
                    turn_context_digest TEXT NOT NULL,
                    deadline_unix_ms INTEGER NOT NULL,
                    next_wave INTEGER NOT NULL DEFAULT 0,
                    total_calls INTEGER NOT NULL DEFAULT 0,
                    total_argument_bytes INTEGER NOT NULL DEFAULT 0,
                    total_output_bytes INTEGER NOT NULL DEFAULT 0,
                    prior_wave_receipt_digest TEXT,
                    status TEXT NOT NULL CHECK (status IN ('READY','WAVE_PENDING','FAILED','CANCELLED','UNKNOWN','COMPLETE')),
                    terminal_outcome TEXT CHECK (terminal_outcome IN ('failed','cancelled')),
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    FOREIGN KEY (execution_id) REFERENCES stdio_executions(execution_id),
                    FOREIGN KEY (challenge_id) REFERENCES effect_challenges(challenge_id)
                );
                CREATE TABLE IF NOT EXISTS code_mode_waves (
                    request_id TEXT NOT NULL,
                    wave_index INTEGER NOT NULL CHECK (wave_index BETWEEN 0 AND 63),
                    batch_id TEXT NOT NULL UNIQUE,
                    frame_digest TEXT NOT NULL,
                    call_count INTEGER NOT NULL CHECK (call_count BETWEEN 1 AND 32),
                    argument_bytes INTEGER NOT NULL CHECK (argument_bytes BETWEEN 0 AND 524288),
                    status TEXT NOT NULL CHECK (status IN ('RESERVED','ADMITTED','BOUND','SETTLED','REJECTED','CANCELLED','UNKNOWN')),
                    scope_digest TEXT NOT NULL,
                    direct_turn_scope_digest TEXT,
                    wave_digest TEXT,
                    receipt_digest TEXT,
                    outcome_digest TEXT,
                    output_bytes INTEGER NOT NULL DEFAULT 0,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (request_id, wave_index),
                    FOREIGN KEY (request_id) REFERENCES code_mode_runs(request_id)
                );
                CREATE TABLE IF NOT EXISTS code_mode_wave_calls (
                    request_id TEXT NOT NULL,
                    wave_index INTEGER NOT NULL,
                    call_index INTEGER NOT NULL CHECK (call_index BETWEEN 0 AND 31),
                    call_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    capability_id TEXT NOT NULL,
                    call_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (call_kind IN ('effect','host_callback','unknown')),
                    arguments_digest TEXT NOT NULL,
                    PRIMARY KEY (request_id,wave_index,call_index),
                    UNIQUE (request_id,wave_index,call_id),
                    FOREIGN KEY (request_id,wave_index) REFERENCES code_mode_waves(request_id,wave_index)
                );
                CREATE TABLE IF NOT EXISTS code_mode_wave_results (
                    request_id TEXT NOT NULL,
                    wave_index INTEGER NOT NULL,
                    call_index INTEGER NOT NULL CHECK (call_index BETWEEN 0 AND 31),
                    call_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('settled','rejected','cancelled')),
                    output TEXT,
                    output_digest TEXT,
                    output_bytes INTEGER,
                    error_code TEXT,
                    receipt_kind TEXT CHECK (receipt_kind IN ('effect_receipt','host_decision','tool_result')),
                    receipt_ref TEXT,
                    receipt_digest TEXT,
                    PRIMARY KEY (request_id,wave_index,call_index),
                    UNIQUE (request_id,wave_index,call_id),
                    FOREIGN KEY (request_id,wave_index) REFERENCES code_mode_waves(request_id,wave_index)
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
                    body_data BLOB,
                    body_bytes INTEGER,
                    body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (body_truncated IN (0,1)),
                    connected_peer TEXT,
                    receipt_digest TEXT,
                    outcome TEXT,
                    route_plan_digest TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS http_route_attempts (
                    execution_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    route_id TEXT NOT NULL,
                    attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 2),
                    state TEXT NOT NULL CHECK (state IN ('DISPATCHING','SETTLED','UNKNOWN')),
                    outcome TEXT,
                    not_dispatched_failure TEXT,
                    result_count INTEGER,
                    http_status INTEGER,
                    retry_after_ms INTEGER,
                    body_digest TEXT,
                    body_bytes INTEGER,
                    body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (body_truncated IN (0,1)),
                    connected_peer TEXT,
                    receipt_digest TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (execution_id, sequence),
                    UNIQUE (execution_id, route_id, attempt),
                    FOREIGN KEY (execution_id) REFERENCES http_executions(execution_id)
                );
                CREATE TABLE IF NOT EXISTS provider_inference_dispatches (
                    challenge_id TEXT PRIMARY KEY,
                    effect_id TEXT NOT NULL UNIQUE,
                    binding_digest TEXT NOT NULL,
                    provider_request_id TEXT NOT NULL UNIQUE,
                    prepare_digest TEXT NOT NULL,
                    dispatch_digest TEXT,
                    token_digest TEXT,
                    assistant_entry_id TEXT,
                    response_digest TEXT,
                    usage_digest TEXT,
                    receipt_digest TEXT,
                    status TEXT NOT NULL CHECK (status IN ('AWAITING_APPROVAL','TOKEN_ISSUED','CONSUMED','SETTLED','UNKNOWN')),
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    FOREIGN KEY (challenge_id) REFERENCES effect_challenges(challenge_id)
                );
                CREATE TABLE IF NOT EXISTS managed_message_consumption_acks (
                    child_session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    mailbox_sequence INTEGER NOT NULL CHECK (mailbox_sequence > 0),
                    authority_digest TEXT NOT NULL,
                    consumption_ack_digest TEXT NOT NULL,
                    host_receipt_digest TEXT NOT NULL,
                    ack_value BLOB NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (child_session_id, message_id, mailbox_sequence),
                    UNIQUE (consumption_ack_digest)
                );
                CREATE TABLE IF NOT EXISTS execution_repl_callback_events (
                    execution_id TEXT NOT NULL,
                    generation INTEGER NOT NULL,
                    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
                    callback_id TEXT NOT NULL,
                    event_digest TEXT NOT NULL,
                    event_value BLOB NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('PENDING','REPLIED','UNKNOWN')),
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (execution_id, generation, event_sequence),
                    FOREIGN KEY (execution_id) REFERENCES stdio_executions(execution_id)
                );
                CREATE TABLE IF NOT EXISTS execution_repl_callback_replies (
                    execution_id TEXT NOT NULL,
                    generation INTEGER NOT NULL,
                    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
                    request_sequence INTEGER NOT NULL CHECK (request_sequence > 0),
                    callback_id TEXT NOT NULL,
                    operation_digest TEXT NOT NULL,
                    capability_id TEXT NOT NULL,
                    effect_id TEXT NOT NULL,
                    challenge_id TEXT NOT NULL,
                    capability_lease_digest TEXT,
                    effect_receipt_digest TEXT NOT NULL,
                    result_digest TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('DISPATCHING','DISPATCHED','UNKNOWN')),
                    dispatch_receipt_digest TEXT,
                    reply_value BLOB NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (execution_id, generation, event_sequence),
                    UNIQUE (execution_id, generation, request_sequence),
                    FOREIGN KEY (execution_id, generation, event_sequence)
                        REFERENCES execution_repl_callback_events(execution_id, generation, event_sequence)
                );
                CREATE TABLE IF NOT EXISTS execution_repl_callback_denials (
                    challenge_id TEXT PRIMARY KEY,
                    execution_id TEXT NOT NULL,
                    generation INTEGER NOT NULL CHECK (generation > 0),
                    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
                    callback_id TEXT NOT NULL,
                    capability_id TEXT NOT NULL,
                    effect_id TEXT NOT NULL,
                    event_digest TEXT NOT NULL,
                    callback_arguments_digest TEXT NOT NULL,
                    challenge_arguments_digest TEXT NOT NULL,
                    principal TEXT NOT NULL,
                    execution_principal TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    location_id TEXT NOT NULL,
                    owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
                    attempt_scope_digest TEXT,
                    workspace_revision TEXT NOT NULL,
                    denial_receipt_digest TEXT NOT NULL UNIQUE,
                    created_at_ms INTEGER NOT NULL,
                    FOREIGN KEY (execution_id, generation, event_sequence)
                        REFERENCES execution_repl_callback_events(execution_id, generation, event_sequence)
                );
                CREATE TABLE IF NOT EXISTS direct_session_grant_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    grant_id TEXT NOT NULL,
                    event_kind TEXT NOT NULL CHECK (event_kind IN ('ISSUED','REVOKED')),
                    principal_id TEXT NOT NULL,
                    grant_digest TEXT NOT NULL,
                    event_digest TEXT NOT NULL UNIQUE,
                    grant_value BLOB,
                    revoked_at_unix_ms TEXT,
                    revoked_by_principal_id TEXT,
                    created_at_ms INTEGER NOT NULL,
                    CHECK ((event_kind='ISSUED' AND grant_value IS NOT NULL AND revoked_at_unix_ms IS NULL AND revoked_by_principal_id IS NULL)
                        OR (event_kind='REVOKED' AND grant_value IS NULL AND revoked_at_unix_ms IS NOT NULL AND revoked_by_principal_id IS NOT NULL))
                );
                CREATE INDEX IF NOT EXISTS direct_session_grant_events_latest
                    ON direct_session_grant_events(grant_id, sequence DESC);
                CREATE TABLE IF NOT EXISTS direct_session_grant_usage_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    grant_id TEXT NOT NULL,
                    batch_id TEXT NOT NULL,
                    batch_digest TEXT NOT NULL,
                    effect_count INTEGER NOT NULL CHECK (effect_count > 0),
                    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
                    event_digest TEXT NOT NULL UNIQUE,
                    created_at_ms INTEGER NOT NULL,
                    UNIQUE (grant_id, batch_id)
                );",
            )
            .map_err(|_| "effect database schema could not be initialized".to_owned())?;
        let has_code_mode_direct_turn_digest:i64=connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('code_mode_waves') WHERE name='direct_turn_scope_digest'",[],|row|row.get(0))
            .map_err(|_|"CodeMode wave schema could not be inspected".to_owned())?;
        if has_code_mode_direct_turn_digest==0 {
            connection.execute_batch("ALTER TABLE code_mode_waves ADD COLUMN direct_turn_scope_digest TEXT;")
                .map_err(|_|"CodeMode wave schema could not be upgraded".to_owned())?;
        }
        for (column, declaration) in [
            ("tool_name", "TEXT NOT NULL DEFAULT ''"),
            ("capability_id", "TEXT NOT NULL DEFAULT ''"),
            ("call_kind", "TEXT NOT NULL DEFAULT 'unknown'"),
        ] {
            let present: i64 = connection.query_row(
                &format!("SELECT COUNT(*) FROM pragma_table_info('code_mode_wave_calls') WHERE name=?1"),
                [column], |row| row.get(0),
            ).map_err(|_| "CodeMode call schema could not be inspected".to_owned())?;
            if present == 0 {
                connection.execute_batch(&format!("ALTER TABLE code_mode_wave_calls ADD COLUMN {column} {declaration};"))
                    .map_err(|_| "CodeMode call schema could not be upgraded".to_owned())?;
            }
        }
        for (column, declaration) in [
            ("output_digest", "TEXT"),
            ("output_bytes", "INTEGER"),
        ] {
            let present: i64 = connection.query_row(
                &format!("SELECT COUNT(*) FROM pragma_table_info('code_mode_wave_results') WHERE name=?1"),
                [column], |row| row.get(0),
            ).map_err(|_| "CodeMode result schema could not be inspected".to_owned())?;
            if present == 0 {
                connection.execute_batch(&format!("ALTER TABLE code_mode_wave_results ADD COLUMN {column} {declaration};"))
                    .map_err(|_| "CodeMode result schema could not be upgraded".to_owned())?;
            }
        }
        let result_table_sql: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='code_mode_wave_results'",
            [], |row| row.get(0),
        ).map_err(|_| "CodeMode result schema could not be inspected".to_owned())?;
        if !result_table_sql.contains("'tool_result'") {
            connection.execute_batch("ALTER TABLE code_mode_wave_results RENAME TO code_mode_wave_results_legacy;
                CREATE TABLE code_mode_wave_results (
                    request_id TEXT NOT NULL, wave_index INTEGER NOT NULL,
                    call_index INTEGER NOT NULL CHECK (call_index BETWEEN 0 AND 31), call_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('settled','rejected','cancelled')),
                    output TEXT, output_digest TEXT, output_bytes INTEGER, error_code TEXT,
                    receipt_kind TEXT CHECK (receipt_kind IN ('effect_receipt','host_decision','tool_result')),
                    receipt_ref TEXT, receipt_digest TEXT,
                    PRIMARY KEY (request_id,wave_index,call_index), UNIQUE (request_id,wave_index,call_id),
                    FOREIGN KEY (request_id,wave_index) REFERENCES code_mode_waves(request_id,wave_index));
                INSERT INTO code_mode_wave_results(request_id,wave_index,call_index,call_id,status,output,output_digest,output_bytes,error_code,receipt_kind,receipt_ref,receipt_digest)
                    SELECT request_id,wave_index,call_index,call_id,status,output,output_digest,output_bytes,error_code,receipt_kind,receipt_ref,receipt_digest FROM code_mode_wave_results_legacy;
                DROP TABLE code_mode_wave_results_legacy;")
                .map_err(|_| "CodeMode result schema could not be upgraded".to_owned())?;
        }
        let has_code_mode_result_kind: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('code_mode_wave_results') WHERE name='receipt_kind'", [], |row| row.get(0),
        ).map_err(|_| "CodeMode result schema could not be inspected".to_owned())?;
        if has_code_mode_result_kind == 0 {
            connection.execute_batch("ALTER TABLE code_mode_wave_results ADD COLUMN receipt_kind TEXT;")
                .map_err(|_| "CodeMode result schema could not be upgraded".to_owned())?;
            // Legacy aggregate digests did not bind receipt kind/status/call ID, so
            // the v2 reader below refuses them even though this aids diagnostics.
            connection.execute_batch("UPDATE code_mode_wave_results SET receipt_kind=CASE WHEN status='settled' THEN 'effect_receipt' ELSE 'host_decision' END;")
                .map_err(|_| "CodeMode result schema could not be upgraded".to_owned())?;
        }
        let has_code_mode_helper_digest: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('code_mode_runs') WHERE name='helper_digest'", [], |row| row.get(0),
        ).map_err(|_| "CodeMode run schema could not be inspected".to_owned())?;
        if has_code_mode_helper_digest == 0 {
            // Existing runs are reconciled to UNKNOWN during open. The empty legacy
            // value can never match a newly authenticated helper package.
            connection.execute_batch("ALTER TABLE code_mode_runs ADD COLUMN helper_digest TEXT NOT NULL DEFAULT '';" )
                .map_err(|_| "CodeMode run schema could not be upgraded".to_owned())?;
        }
        let has_code_mode_terminal_outcome: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('code_mode_runs') WHERE name='terminal_outcome'", [], |row| row.get(0),
        ).map_err(|_| "CodeMode run schema could not be inspected".to_owned())?;
        if has_code_mode_terminal_outcome == 0 {
            connection.execute_batch("ALTER TABLE code_mode_runs ADD COLUMN terminal_outcome TEXT;" )
                .map_err(|_| "CodeMode run schema could not be upgraded".to_owned())?;
        }
        for (column, declaration) in [
            ("direct_permission_mode_digest", "TEXT"),
            ("direct_permission_mode_revision", "TEXT"),
        ] {
            let present: i64 = connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('terminal_consent_preflights') WHERE name=?1",
                [column], |row| row.get(0),
            ).map_err(|_| "terminal consent schema could not be inspected".to_owned())?;
            if present == 0 {
                connection.execute_batch(&format!("ALTER TABLE terminal_consent_preflights ADD COLUMN {column} {declaration};"))
                    .map_err(|_| "terminal consent schema could not be upgraded".to_owned())?;
            }
        }
        let has_http_not_dispatched_failure: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('http_route_attempts') WHERE name='not_dispatched_failure'",
            [], |row| row.get(0),
        ).map_err(|_| "HTTP route receipt schema could not be inspected".to_owned())?;
        if has_http_not_dispatched_failure == 0 {
            connection.execute_batch(
                "ALTER TABLE http_route_attempts ADD COLUMN not_dispatched_failure TEXT;",
            ).map_err(|_| "HTTP route receipt schema could not be upgraded".to_owned())?;
        }
        let has_http_execution_outcome: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('http_executions') WHERE name='outcome'",
            [],
            |row| row.get(0),
        ).map_err(|_| Failure::Unavailable)?;
        if has_http_execution_outcome == 0 {
            connection.execute_batch(
                "ALTER TABLE http_executions ADD COLUMN outcome TEXT;",
            ).map_err(|_| Failure::Unavailable)?;
        }
        let has_http_route_plan_digest: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('http_executions') WHERE name='route_plan_digest'",
            [],
            |row| row.get(0),
        ).map_err(|_| Failure::Unavailable)?;
        if has_http_route_plan_digest == 0 {
            connection.execute_batch(
                "ALTER TABLE http_executions ADD COLUMN route_plan_digest TEXT;",
            ).map_err(|_| Failure::Unavailable)?;
        }
        for (column, declaration) in [
            ("body_data", "BLOB"),
        ] {
            let exists: i64 = connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('http_executions') WHERE name=?1",
                [column], |row| row.get(0),
            ).map_err(|_| "http execution schema could not be inspected".to_owned())?;
            if exists == 0 {
                connection.execute_batch(&format!(
                    "ALTER TABLE http_executions ADD COLUMN {column} {declaration};"
                )).map_err(|_| "http execution schema could not be upgraded".to_owned())?;
            }
        }
        for (column, declaration) in [
            ("execution_principal", "TEXT NOT NULL DEFAULT ''"),
            ("scope_kind", "TEXT NOT NULL DEFAULT 'session'"),
            ("scope_workspace_id", "TEXT"),
            ("direct_session_grant_digest", "TEXT"),
            ("profile_id", "TEXT NOT NULL DEFAULT ''"),
            ("profile_revision", "INTEGER NOT NULL DEFAULT 0"),
            ("profile_digest", "TEXT NOT NULL DEFAULT ''"),
            ("executable_digest", "TEXT NOT NULL DEFAULT ''"),
            ("cgroup_identity", "BLOB"),
            ("quiescence_digest", "TEXT"),
            ("stdout_bytes_data", "BLOB"),
            ("stderr_bytes_data", "BLOB"),
            ("observed_workspace_revision", "TEXT"),
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
        for (column, declaration) in [
            ("artifact_ref_v1", "BLOB"),
            ("artifact_fidelity", "TEXT"),
            ("observed_bytes", "TEXT"),
            ("dropped_bytes", "TEXT"),
            ("cgroup_identity", "BLOB"),
            ("quiescence_digest", "TEXT"),
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('terminal_runs') WHERE name=?1",
                    [column],
                    |row| row.get(0),
                )
                .map_err(|_| "terminal artifact schema could not be inspected".to_owned())?;
            if exists == 0 {
                connection
                    .execute_batch(&format!(
                        "ALTER TABLE terminal_runs ADD COLUMN {column} {declaration};"
                    ))
                    .map_err(|_| "terminal artifact schema could not be upgraded".to_owned())?;
            }
        }
        for (column, declaration) in [
            ("source_path_digest", "TEXT NOT NULL DEFAULT ''"),
            ("result_file_bytes", "INTEGER"),
            ("cgroup_identity", "BLOB"),
            ("quiescence_digest", "TEXT"),
        ] {
            let exists: i64 = connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('external_editor_runs') WHERE name=?1",
                [column], |row| row.get(0),
            ).map_err(|_| "external editor schema could not be inspected".to_owned())?;
            if exists == 0 {
                connection.execute_batch(&format!(
                    "ALTER TABLE external_editor_runs ADD COLUMN {column} {declaration};"
                )).map_err(|_| "external editor schema could not be upgraded".to_owned())?;
            }
        }
        let has_managed_ack_receipt_digest: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('managed_message_consumption_acks') WHERE name='host_receipt_digest'",
            [], |row| row.get(0),
        ).map_err(|_| "managed consumption ACK schema could not be inspected".to_owned())?;
        if has_managed_ack_receipt_digest == 0 {
            connection.execute_batch(
                "ALTER TABLE managed_message_consumption_acks ADD COLUMN host_receipt_digest TEXT NOT NULL DEFAULT '';",
            ).map_err(|_| "managed consumption ACK schema could not be upgraded".to_owned())?;
        }
        let has_broker_execution_principal: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('broker_process_bindings') WHERE name='execution_principal'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "broker process schema could not be inspected".to_owned())?;
        if has_broker_execution_principal == 0 {
            connection
                .execute_batch("ALTER TABLE broker_process_bindings ADD COLUMN execution_principal TEXT NOT NULL DEFAULT '';" )
                .map_err(|_| "broker process schema could not be upgraded".to_owned())?;
        }
        for (column, declaration) in [
            ("scope_kind", "TEXT NOT NULL DEFAULT 'session'"),
            ("scope_workspace_id", "TEXT"),
        ] {
            let present: i64 = connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('broker_process_bindings') WHERE name=?1",
                [column], |row| row.get(0),
            ).map_err(|_| "broker process scope schema could not be inspected".to_owned())?;
            if present == 0 {
                connection.execute_batch(&format!(
                    "ALTER TABLE broker_process_bindings ADD COLUMN {column} {declaration};"
                )).map_err(|_| "broker process scope schema could not be upgraded".to_owned())?;
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
        for (column, declaration) in [
            ("batch_payload_bytes", "INTEGER NOT NULL DEFAULT 0"),
            ("direct_session_grant_digest", "TEXT"),
        ] {
            let present: i64 = connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('effect_challenges') WHERE name=?1",
                [column], |row| row.get(0),
            ).map_err(|_| "effect challenge grant schema could not be inspected".to_owned())?;
            if present == 0 {
                connection.execute_batch(&format!("ALTER TABLE effect_challenges ADD COLUMN {column} {declaration};"))
                    .map_err(|_| "effect challenge grant schema could not be upgraded".to_owned())?;
            }
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
        for (column, declaration) in [
            ("call_index", "INTEGER"),
            ("arguments_digest", "TEXT NOT NULL DEFAULT ''"),
            ("admitted_intent_digest", "TEXT NOT NULL DEFAULT ''"),
            ("managed_wave_receipt_digest", "TEXT"),
            ("direct_permission_mode_digest", "TEXT"),
            ("direct_permission_mode_revision", "TEXT"),
        ] {
            let present: i64 = connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('effect_challenges') WHERE name=?1",
                [column],
                |row| row.get(0),
            ).map_err(|_| "effect challenge schema could not be inspected".to_owned())?;
            if present == 0 {
                connection.execute_batch(&format!(
                    "ALTER TABLE effect_challenges ADD COLUMN {column} {declaration};"
                )).map_err(|_| "effect database schema could not be upgraded".to_owned())?;
            }
        }
        // An opaque provider send authorization is process-local and can never
        // be recovered after restart. Any token whose consume ACK was not
        // durable is therefore permanently uncertain, never reusable.
        connection.execute(
            "UPDATE provider_inference_dispatches SET status='UNKNOWN',token_digest=NULL,updated_at_ms=?1
             WHERE status IN ('TOKEN_ISSUED','CONSUMED')",
            [now_ms().map_err(|_| "effect database recovery failed")? as i64],
        ).map_err(|_| "effect database recovery failed")?;
        connection.execute(
            "UPDATE effect_challenges SET status='UNKNOWN'
             WHERE capability_id='providers.infer' AND status='PREPARED'
               AND effect_id IN (
                   SELECT effect_id FROM provider_inference_dispatches WHERE status='UNKNOWN'
               )",
            [],
        ).map_err(|_| "provider inference recovery fence could not be persisted")?;
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
            host.connection.execute(
                "UPDATE managed_verifier_preflights SET status='INVALID' WHERE status='PREPARED'",
                [],
            ).map_err(|_| "interrupted verifier preflight could not be fenced".to_owned())?;
            host.reconcile_stdio_executions().map_err(|_| {
                "interrupted stdio execution state could not be classified safely".to_owned()
            })?;
            host.reconcile_terminal_processes().map_err(|_| {
                "interrupted terminal process containment could not be classified safely".to_owned()
            })?;
            host.reconcile_external_editor_processes().map_err(|_| {
                "interrupted external editor containment could not be classified safely".to_owned()
            })?;
            host.reconcile_code_mode_runs().map_err(|_| {
                "interrupted CodeMode waves could not be fenced safely".to_owned()
            })?;
            host.reconcile_http_executions().map_err(|_| {
                "interrupted HTTP execution state could not be classified safely".to_owned()
            })?;
            host.reconcile_prepared().map_err(|_| {
                "interrupted effect state could not be classified safely".to_owned()
            })?;
            // Reconciliation persists UNKNOWN and exact cgroup quiescence first.
            // Cleanup is best-effort: any missing/legacy identity or proof remains
            // retained and consumes the bounded cgroup capacity.
            host.reap_quiescent_execution_cgroups();
        }
        Ok(host)
    }

    fn reconcile_code_mode_runs(&mut self) -> Result<(), Failure> {
        let now=now_ms()? as i64;
        let tx=self.connection.transaction().map_err(|_|Failure::Unavailable)?;
        tx.execute("UPDATE code_mode_runs SET status='UNKNOWN',updated_at_ms=?1 WHERE status IN ('READY','WAVE_PENDING') OR (status='CANCELLED' AND NOT EXISTS(SELECT 1 FROM stdio_executions s WHERE s.execution_id=code_mode_runs.execution_id AND s.status='SETTLED'))",[now]).map_err(|_|Failure::Unavailable)?;
        tx.execute("UPDATE code_mode_waves SET status='UNKNOWN',updated_at_ms=?1 WHERE status IN ('RESERVED','ADMITTED','BOUND')",[now]).map_err(|_|Failure::Unavailable)?;
        tx.commit().map_err(|_|Failure::Unavailable)
    }

    /// Persist a strictly decoded grant after HostKernel has derived every
    /// principal/session/location/backend/policy pin from authenticated state.
    /// Issuance changes policy input only; it cannot resolve a pending challenge.
    pub(crate) fn issue_direct_session_grant(
        &mut self,
        value: &Value,
        now_unix_ms: u64,
    ) -> Result<DirectSessionGrantProjectionV1, DirectSessionGrantErrorV1> {
        let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(value)
            .map_err(|_| DirectSessionGrantErrorV1::Invalid)?;
        let Value::Map(fields) = value else { return Err(DirectSessionGrantErrorV1::Invalid) };
        let active = matches!(fields.get("revocation"), Some(Value::Map(revocation))
            if matches!(revocation.get("status"), Some(Value::String(status)) if status == "active"));
        if !active || grant.issued_at_unix_ms > now_unix_ms
            || now_unix_ms > i64::MAX as u64
            || grant.expires_at_unix_ms.is_some_and(|expiry| expiry <= now_unix_ms) {
            return Err(DirectSessionGrantErrorV1::Invalid);
        }
        let encoded = messagepack::encode(value, FRAME_LIMITS).map_err(|_| DirectSessionGrantErrorV1::Invalid)?;
        let event_digest = direct_session_grant_event_digest("ISSUED", &grant.grant_id,
            &grant.grant_digest, &encoded, None, None);
        let tx = self.connection.transaction().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let existing: Option<(String, String, Vec<u8>)> = tx.query_row(
            "SELECT principal_id,grant_digest,grant_value FROM direct_session_grant_events
             WHERE grant_id=?1 AND event_kind='ISSUED' ORDER BY sequence ASC LIMIT 1",
            [&grant.grant_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        if let Some((principal_id, grant_digest, previous_value)) = existing {
            if principal_id != grant.principal_id || grant_digest != grant.grant_digest || previous_value != encoded {
                return Err(DirectSessionGrantErrorV1::Conflict);
            }
            let revoked: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM direct_session_grant_events WHERE grant_id=?1 AND event_kind='REVOKED')",
                [&grant.grant_id], |row| row.get(0),
            ).map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
            tx.commit().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
            return Ok(DirectSessionGrantProjectionV1::from_grant(&grant, if revoked { "revoked" } else { "active" }));
        }
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM direct_session_grant_events WHERE event_kind='ISSUED'", [], |row| row.get(0))
            .map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        if count >= 4096 { return Err(DirectSessionGrantErrorV1::Unavailable); }
        let has_other_event: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM direct_session_grant_events WHERE grant_id=?1)",
            [&grant.grant_id], |row| row.get(0)).map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        if has_other_event { return Err(DirectSessionGrantErrorV1::Conflict); }
        tx.execute("INSERT INTO direct_session_grant_events(grant_id,event_kind,principal_id,grant_digest,event_digest,grant_value,created_at_ms)
                    VALUES(?1,'ISSUED',?2,?3,?4,?5,?6)",
            params![grant.grant_id, grant.principal_id, grant.grant_digest, event_digest, encoded, now_unix_ms as i64])
            .map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        tx.commit().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        Ok(DirectSessionGrantProjectionV1::from_grant(&grant, "active"))
    }

    /// Return the exact retained grant claims for HostKernel response-loss
    /// reconciliation. Callers compare every non-time authority pin before
    /// treating a repeated issuance request as the same operation.
    pub(crate) fn get_direct_session_grant(
        &self,
        grant_id: &str,
    ) -> Result<Option<(DirectSessionGrantProjectionV1, Value)>, DirectSessionGrantErrorV1> {
        validate_identifier(grant_id).map_err(|_| DirectSessionGrantErrorV1::Invalid)?;
        let issued: Option<(String, String, Vec<u8>)> = self.connection.query_row(
            "SELECT principal_id,grant_digest,grant_value FROM direct_session_grant_events
             WHERE grant_id=?1 AND event_kind='ISSUED' ORDER BY sequence ASC LIMIT 1",
            [grant_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let Some((principal_id, stored_digest, encoded)) = issued else { return Ok(None) };
        let value = messagepack::decode(&encoded, FRAME_LIMITS)
            .map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(&value)
            .map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        if grant.grant_id != grant_id || grant.principal_id != principal_id
            || grant.grant_digest != stored_digest {
            return Err(DirectSessionGrantErrorV1::Unavailable);
        }
        let revoked: Option<(String, String)> = self.connection.query_row(
            "SELECT revoked_at_unix_ms,revoked_by_principal_id FROM direct_session_grant_events
             WHERE grant_id=?1 AND event_kind='REVOKED' ORDER BY sequence DESC LIMIT 1",
            [grant_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let mut projection = DirectSessionGrantProjectionV1::from_grant(
            &grant, if revoked.is_some() { "revoked" } else { "active" },
        );
        if let Some((at, _by)) = revoked {
            projection.revoked_at_unix_ms = Some(at.parse::<u64>()
                .ok().filter(|parsed| parsed.to_string() == at)
                .ok_or(DirectSessionGrantErrorV1::Unavailable)?);
        }
        Ok(Some((projection, value)))
    }

    /// Prove the explicit grant choice still originates from the exact live,
    /// pending direct workspace challenge. HostKernel remains responsible for
    /// ServerAuth, the registered Location, current owner epoch and direct-turn
    /// journal validation; this closes expiry/status races in the durable effect
    /// owner before any grant is appended.
    pub(crate) fn validate_direct_session_grant_challenge(
        &self,
        challenge_id: &str,
        effect_id: &str,
        session_id: &str,
        principal: &str,
        attempt_scope_digest: Option<&str>,
        now_unix_ms: u64,
    ) -> Result<(), DirectSessionGrantErrorV1> {
        let challenge = load_challenge(&self.connection, challenge_id)
            .map_err(|_| DirectSessionGrantErrorV1::Unavailable)?
            .ok_or(DirectSessionGrantErrorV1::NotFound)?;
        if challenge.challenge_id != challenge_id || challenge.effect_id != effect_id
            || challenge.session_id != session_id || challenge.principal != principal
            || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::SessionBatch
            || challenge.managed_attempt_digest.as_deref() != attempt_scope_digest
            || challenge.capability_lease_digest.is_some()
            || challenge.expires_at_ms <= now_unix_ms
            || challenge.status != "AWAITING_APPROVAL"
            || !matches!(challenge.capability_id.as_str(), guard::FILES_READ_ID | guard::FILES_WRITE_ID | guard::FILES_PATCH_ID)
        {
            return Err(DirectSessionGrantErrorV1::Conflict);
        }
        Ok(())
    }

    /// Read one active grant only when all authenticated runtime pins match.
    /// Lookup is bounded and never rebases a stale record onto current pins.
    pub(crate) fn active_direct_session_grant(
        &self,
        query: &crate::direct_session_grant::ActiveGrantQueryV1,
    ) -> Result<Option<DirectSessionGrantProjectionV1>, DirectSessionGrantErrorV1> {
        let mut statement = self.connection.prepare(
            "SELECT grant_id,grant_value FROM direct_session_grant_events WHERE event_kind='ISSUED' AND principal_id=?1 ORDER BY sequence DESC LIMIT 4097")
            .map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let rows = statement.query_map([&query.principal_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))
            .map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let mut candidates = Vec::new();
        for row in rows { candidates.push(row.map_err(|_| DirectSessionGrantErrorV1::Unavailable)?); }
        if candidates.len() > 4096 { return Err(DirectSessionGrantErrorV1::Unavailable); }
        for (grant_id, encoded) in candidates {
            let value = messagepack::decode(&encoded, FRAME_LIMITS).map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
            let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(&value).map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
            if grant.grant_id != grant_id || !grant.matches(query) { continue; }
            let revoked: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM direct_session_grant_events WHERE grant_id=?1 AND event_kind='REVOKED')",
                [&grant_id], |row| row.get(0)).map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
            // Workspace/session grants are the only current Guard fast-path. Network
            // grants are persisted and projected, but remain unavailable until the
            // per-destination aggregate request/byte ledger is wired into HTTP dispatch.
            if !revoked && grant.scope_kind != "network_egress" {
                return Ok(Some(DirectSessionGrantProjectionV1::from_grant(&grant, "active")));
            }
        }
        Ok(None)
    }

    /// Advisory, read-only check for whether an exact direct Session ToolBatch can
    /// use an existing workspace grant without asking the user again. This method
    /// deliberately reserves no budget and changes no challenge state: the
    /// authoritative approval-set path must repeat every check atomically before
    /// minting leases. Any uncertain or stale state is an error/None and therefore
    /// falls back to an explicit user decision.
    pub(crate) fn preflight_direct_session_grant_batch(
        &self,
        process_session_id: &str,
        principal: &str,
        batch_id: &str,
        challenge_ids: &[String],
        query: &crate::direct_session_grant::ActiveGrantQueryV1,
        direct_turn_scope: Option<&crate::protocol::DirectTurnScopeV1>,
        deadline_unix_ms: u64,
    ) -> Result<Option<DirectSessionGrantProjectionV1>, TypedErrorV1> {
        let fail = |failure: Failure| failure.error();
        let direct_attempt_digest = direct_turn_scope
            .map(|turn| turn.direct_attempt.digest().map_err(|_| Failure::Invalid.error()))
            .transpose()?;
        if query.session_id != process_session_id || query.principal_id != principal
            || challenge_ids.is_empty() || challenge_ids.len() > MAX_TOOL_BATCH_CALLS
            || deadline_unix_ms <= query.now_unix_ms {
            return Err(Failure::Invalid.error());
        }
        if let Some(turn) = direct_turn_scope {
            if turn.direct_attempt.child_session_id != process_session_id
                || turn.direct_attempt.owner_epoch != query.owner_epoch
                || turn.direct_attempt.location_id != query.location_id
                || turn.direct_attempt.workspace_id != query.workspace_id {
                return Err(Failure::Denied.error());
            }
        }
        let now = query.now_unix_ms;
        if now > i64::MAX as u64 || deadline_unix_ms > i64::MAX as u64 {
            return Err(Failure::Invalid.error());
        }
        let mut supplied = HashSet::with_capacity(challenge_ids.len());
        if challenge_ids.iter().any(|id| validate_identifier(id).is_err() || !supplied.insert(id.as_str())) {
            return Err(Failure::Invalid.error());
        }

        // Resolve only a currently active grant pinned to the complete authenticated
        // execution scope. The final approval path repeats this selection in its
        // write transaction.
        let mut statement = self.connection.prepare(
            "SELECT grant_value FROM direct_session_grant_events e
             WHERE event_kind='ISSUED' AND principal_id=?1
               AND sequence=(SELECT MAX(sequence) FROM direct_session_grant_events x WHERE x.grant_id=e.grant_id)
             ORDER BY sequence DESC LIMIT 4097")
            .map_err(|_| Failure::Unavailable.error())?;
        let rows = statement.query_map([principal], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|_| Failure::Unavailable.error())?;
        let mut encoded_values = Vec::new();
        for row in rows { encoded_values.push(row.map_err(|_| Failure::Unavailable.error())?); }
        if encoded_values.len() > 4096 { return Err(Failure::Unavailable.error()); }
        let mut candidates = Vec::<crate::direct_session_grant::DirectSessionGrantV1>::new();
        for encoded in encoded_values {
            let value = messagepack::decode(&encoded, FRAME_LIMITS).map_err(|_| Failure::Unavailable.error())?;
            let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(&value)
                .map_err(|_| Failure::Unavailable.error())?;
            if grant.matches(query) && (grant.allows_edit() || !grant.command_profiles.is_empty())
                && grant.scope_kind != "network_egress" {
                candidates.push(grant);
            }
        }
        let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;

        // All member IDs must describe this exact, still-unleased challenge set.
        // A partial set, stale row, other origin, or changed Guard intent cannot
        // silently turn into an implicit allow.
        let mut challenges = Vec::with_capacity(challenge_ids.len());
        for challenge_id in challenge_ids {
            let challenge = load_challenge(&self.connection, challenge_id).map_err(fail)?
                .ok_or_else(|| Failure::NotFound.error())?;
            if challenge.batch_id != batch_id || challenge.session_id != process_session_id
                || challenge.principal != principal
                || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::SessionBatch
                || challenge.managed_attempt_digest.as_deref() != direct_attempt_digest.as_deref()
                || !matches!(challenge.capability_id.as_str(), guard::FILES_WRITE_ID | guard::FILES_PATCH_ID | guard::TERMINAL_RUN_ID)
                || challenge.expires_at_ms <= now || challenge.capability_lease_digest.is_some()
                || challenge.status != "AWAITING_APPROVAL" {
                return Ok(None);
            }
            challenges.push(challenge);
        }
        let Some(grant) = candidates.into_iter().find(|grant| challenges.iter().all(|challenge| direct_grant_allows_challenge(grant, challenge))) else { return Ok(None) };
        let row_count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM effect_challenges WHERE batch_id=?1 AND session_id=?2 AND principal=?3",
            params![batch_id, process_session_id, principal], |row| row.get(0))
            .map_err(|_| Failure::Unavailable.error())?;
        if row_count != challenges.len() as i64
            || challenges.iter().any(|row| !supplied.contains(row.challenge_id.as_str())) {
            return Ok(None);
        }
        let payload_bytes: i64 = self.connection.query_row(
            "SELECT MAX(batch_payload_bytes) FROM effect_challenges WHERE batch_id=?1 AND session_id=?2 AND principal=?3",
            params![batch_id, process_session_id, principal],
            |row| row.get::<_, Option<i64>>(0))
            .map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::Unavailable.error())?;
        if payload_bytes < 0 || challenges.len() as u64 > grant.max_effect_count.unwrap_or_default()
            || payload_bytes as u64 > grant.max_payload_bytes.unwrap_or_default()
            || deadline_unix_ms > now.saturating_add(grant.max_wall_time_ms.unwrap_or_default()) {
            return Ok(None);
        }
        for challenge in &challenges {
            let intent = if challenge.capability_id == guard::FILES_PATCH_ID {
                let targets = load_patch_targets(&self.connection, &challenge.challenge_id).map_err(fail)?;
                if targets.is_empty() || patch_manifest_digest(&targets) != challenge.content_digest {
                    return Ok(None);
                }
                guard_patch_intent(execution, &challenge.session_id, &challenge.principal, &challenge.batch_id,
                    &challenge.call_id, &challenge.content_digest, &challenge.turn_context_digest,
                    &challenge.challenge_id, &targets, direct_attempt_digest.as_deref())
            } else {
                let (decision, intent) = guard_decision(execution, &challenge.session_id, &challenge.principal,
                    &challenge.batch_id, &challenge.call_id, &challenge.capability_id,
                    &challenge.requested_path, &challenge.relative_path, &challenge.resource,
                    &challenge.content_digest, &challenge.turn_context_digest, &challenge.challenge_id,
                    guard::EffectOriginKindV1::SessionBatch, direct_attempt_digest.as_deref());
                (decision.decision == guard::DecisionKind::Ask).then_some(intent)
            };
            if intent.as_deref() != Some(challenge.argument_digest.as_str()) { return Ok(None); }
        }
        let old_usage: (i64, i64) = self.connection.query_row(
            "SELECT COALESCE(SUM(effect_count),0),COALESCE(SUM(payload_bytes),0)
             FROM direct_session_grant_usage_events WHERE grant_id=?1", [&grant.grant_id],
            |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|_| Failure::Unavailable.error())?;
        let total_effects = old_usage.0.checked_add(challenges.len() as i64)
            .ok_or_else(|| Failure::Denied.error())?;
        let total_bytes = old_usage.1.checked_add(payload_bytes)
            .ok_or_else(|| Failure::Denied.error())?;
        if total_effects < 0 || total_effects as u64 > grant.max_effect_count.unwrap_or_default()
            || total_bytes < 0 || total_bytes as u64 > grant.max_payload_bytes.unwrap_or_default() {
            return Ok(None);
        }
        Ok(Some(DirectSessionGrantProjectionV1::from_grant(&grant, "active")))
    }

    /// Resolve a freshly prepared direct Session ToolBatch under one exact active
    /// workspace grant. The pending challenge supplied to the grant-choice UI is
    /// never consumed: callers invoke this only after a new `prepare_tool_batch`.
    /// File edits and exact configured build/test profile references may use a
    /// matching grant. Shell, network and all other process origins remain ineligible.
    pub(crate) fn approve_direct_session_grant_batch(
        &mut self,
        process_session_id: &str,
        principal: &str,
        batch_id: &str,
        challenge_ids: &[String],
        query: &crate::direct_session_grant::ActiveGrantQueryV1,
        direct_turn_scope: Option<&crate::protocol::DirectTurnScopeV1>,
        deadline_unix_ms: u64,
    ) -> Result<Option<DirectSessionGrantProjectionV1>, TypedErrorV1> {
        let fail = |failure: Failure| failure.error();
        let direct_attempt_digest = direct_turn_scope
            .map(|turn| turn.direct_attempt.digest().map_err(|_| Failure::Invalid.error()))
            .transpose()?;
        if query.session_id != process_session_id || query.principal_id != principal
            || challenge_ids.is_empty() || challenge_ids.len() > MAX_TOOL_BATCH_CALLS
            || deadline_unix_ms <= query.now_unix_ms {
            return Err(Failure::Invalid.error());
        }
        if let Some(turn) = direct_turn_scope {
            if turn.direct_attempt.child_session_id != process_session_id
                || turn.direct_attempt.owner_epoch != query.owner_epoch
                || turn.direct_attempt.location_id != query.location_id
                || turn.direct_attempt.workspace_id != query.workspace_id {
                return Err(Failure::Denied.error());
            }
        }
        let now = query.now_unix_ms;
        if now > i64::MAX as u64 || deadline_unix_ms > i64::MAX as u64 {
            return Err(Failure::Invalid.error());
        }
        let mut supplied = HashSet::with_capacity(challenge_ids.len());
        if challenge_ids.iter().any(|id| validate_identifier(id).is_err() || !supplied.insert(id.as_str())) {
            return Err(Failure::Invalid.error());
        }
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let mut candidates = Vec::<crate::direct_session_grant::DirectSessionGrantV1>::new();
        {
            let mut statement = tx.prepare("SELECT grant_value FROM direct_session_grant_events e
                WHERE event_kind='ISSUED' AND principal_id=?1
                  AND sequence=(SELECT MAX(sequence) FROM direct_session_grant_events x WHERE x.grant_id=e.grant_id)
                ORDER BY sequence DESC LIMIT 4097").map_err(|_| Failure::Unavailable.error())?;
            let rows = statement.query_map([principal], |row| row.get::<_, Vec<u8>>(0)).map_err(|_| Failure::Unavailable.error())?;
            let mut encoded_values = Vec::new();
            for row in rows { encoded_values.push(row.map_err(|_| Failure::Unavailable.error())?); }
            if encoded_values.len() > 4096 { return Err(Failure::Unavailable.error()); }
            for encoded in encoded_values {
                let value = messagepack::decode(&encoded, FRAME_LIMITS).map_err(|_| Failure::Unavailable.error())?;
                let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(&value).map_err(|_| Failure::Unavailable.error())?;
                if !grant.matches(query) || !(grant.allows_edit() || !grant.command_profiles.is_empty()) || grant.scope_kind == "network_egress" { continue; }
                let revoked: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM direct_session_grant_events WHERE grant_id=?1 AND event_kind='REVOKED')",
                    [&grant.grant_id], |row| row.get(0)).map_err(|_| Failure::Unavailable.error())?;
                if !revoked { candidates.push(grant); }
            }
        }
        let mut challenges = Vec::with_capacity(challenge_ids.len());
        for challenge_id in challenge_ids {
            let challenge = load_challenge(&tx, challenge_id).map_err(fail)?.ok_or_else(|| Failure::NotFound.error())?;
            if challenge.batch_id != batch_id || challenge.session_id != process_session_id
                || challenge.principal != principal || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::SessionBatch
                || challenge.managed_attempt_digest.as_deref() != direct_attempt_digest.as_deref()
                || !matches!(challenge.capability_id.as_str(), guard::FILES_WRITE_ID | guard::FILES_PATCH_ID | guard::TERMINAL_RUN_ID)
                || challenge.expires_at_ms <= now || !matches!(challenge.status.as_str(), "AWAITING_APPROVAL" | "APPROVED") {
                return Err(Failure::Conflict.error());
            }
            challenges.push(challenge);
        }
        let Some(grant) = candidates.into_iter().find(|grant|
            challenges.iter().all(|challenge| direct_grant_allows_challenge(grant, challenge)))
        else { tx.commit().map_err(|_| Failure::Unavailable.error())?; return Ok(None) };
        let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;
        let row_count: i64 = tx.query_row("SELECT COUNT(*) FROM effect_challenges WHERE batch_id=?1 AND session_id=?2 AND principal=?3",
            params![batch_id, process_session_id, principal], |row| row.get(0)).map_err(|_| Failure::Unavailable.error())?;
        if row_count != challenges.len() as i64 || challenges.iter().any(|row| !supplied.contains(row.challenge_id.as_str())) {
            return Err(Failure::Conflict.error());
        }
        let payload_bytes: i64 = tx.query_row("SELECT MAX(batch_payload_bytes) FROM effect_challenges WHERE batch_id=?1 AND session_id=?2 AND principal=?3",
            params![batch_id, process_session_id, principal], |row| row.get::<_, Option<i64>>(0)).map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::Unavailable.error())?;
        if challenges.iter().any(|challenge| !direct_grant_allows_challenge(&grant, challenge))
            || challenges.len() as u64 > grant.max_effect_count.unwrap_or_default()
            || payload_bytes < 0 || payload_bytes as u64 > grant.max_payload_bytes.unwrap_or_default()
            || deadline_unix_ms > now.saturating_add(grant.max_wall_time_ms.unwrap_or_default()) {
            return Err(Failure::Denied.error());
        }
        let mut same_grant_approved = true;
        for challenge in &challenges {
            let same = tx.query_row(
                "SELECT direct_session_grant_digest=?2 AND approved=1
                 FROM effect_challenges WHERE challenge_id=?1",
                params![challenge.challenge_id, grant.grant_digest], |row| row.get::<_, bool>(0),
            ).map_err(|_| Failure::Unavailable.error())?;
            same_grant_approved &= same;
        }
        if same_grant_approved {
            tx.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(Some(DirectSessionGrantProjectionV1::from_grant(&grant, "active")));
        }
        if challenges.iter().any(|challenge| challenge.status != "AWAITING_APPROVAL") { return Err(Failure::Conflict.error()); }
        for challenge in &challenges {
            let intent = if challenge.capability_id == guard::FILES_PATCH_ID {
                let targets = load_patch_targets(&tx, &challenge.challenge_id).map_err(fail)?;
                if targets.is_empty() || patch_manifest_digest(&targets) != challenge.content_digest { return Err(Failure::Denied.error()); }
                guard_patch_intent(execution, &challenge.session_id, &challenge.principal, &challenge.batch_id,
                    &challenge.call_id, &challenge.content_digest, &challenge.turn_context_digest,
                    &challenge.challenge_id, &targets, direct_attempt_digest.as_deref())
            } else {
                let (decision, intent) = guard_decision(execution, &challenge.session_id, &challenge.principal,
                    &challenge.batch_id, &challenge.call_id, &challenge.capability_id,
                    &challenge.requested_path, &challenge.relative_path, &challenge.resource,
                    &challenge.content_digest, &challenge.turn_context_digest, &challenge.challenge_id,
                    guard::EffectOriginKindV1::SessionBatch, direct_attempt_digest.as_deref());
                (decision.decision == guard::DecisionKind::Ask).then_some(intent)
            };
            if intent.as_deref() != Some(challenge.argument_digest.as_str()) { return Err(Failure::Denied.error()); }
        }
        let old_usage: (i64, i64) = tx.query_row("SELECT COALESCE(SUM(effect_count),0),COALESCE(SUM(payload_bytes),0)
            FROM direct_session_grant_usage_events WHERE grant_id=?1", [&grant.grant_id], |row| Ok((row.get(0)?,row.get(1)?)))
            .map_err(|_| Failure::Unavailable.error())?;
        let total_effects = old_usage.0.checked_add(challenges.len() as i64).ok_or_else(|| Failure::Denied.error())?;
        let total_bytes = old_usage.1.checked_add(payload_bytes).ok_or_else(|| Failure::Denied.error())?;
        if total_effects < 0 || total_effects as u64 > grant.max_effect_count.unwrap_or_default()
            || total_bytes < 0 || total_bytes as u64 > grant.max_payload_bytes.unwrap_or_default() {
            return Err(Failure::Denied.error());
        }
        let batch_digest = direct_session_grant_event_digest("BATCH_RESERVED", batch_id, &grant.grant_digest,
            &payload_bytes.to_be_bytes(), Some(challenges.len() as u64), Some(principal));
        let usage_event_digest = direct_session_grant_event_digest("USAGE", &grant.grant_id, &grant.grant_digest,
            batch_digest.as_bytes(), Some(payload_bytes as u64), Some(principal));
        tx.execute("INSERT INTO direct_session_grant_usage_events(grant_id,batch_id,batch_digest,effect_count,payload_bytes,event_digest,created_at_ms)
            VALUES(?1,?2,?3,?4,?5,?6,?7)", params![grant.grant_id, batch_id, batch_digest, challenges.len() as i64, payload_bytes, usage_event_digest, now as i64])
            .map_err(|_| Failure::Conflict.error())?;
        for challenge in &challenges {
            let changed = tx.execute("UPDATE effect_challenges SET status='APPROVED',approved=1,direct_session_grant_digest=?1
                WHERE challenge_id=?2 AND batch_id=?3 AND session_id=?4 AND principal=?5
                  AND status='AWAITING_APPROVAL' AND expires_at_ms>?6 AND lease_id IS NULL",
                params![grant.grant_digest, challenge.challenge_id, batch_id, process_session_id, principal, now as i64])
                .map_err(|_| Failure::Unavailable.error())?;
            if changed != 1 { return Err(Failure::Conflict.error()); }
        }
        tx.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(Some(DirectSessionGrantProjectionV1::from_grant(&grant, "active")))
    }

    /// Revalidate a command-profile grant after lease redemption and immediately
    /// before spawn. Revocation, expiry, owner/backend/policy drift, or a changed
    /// profile ref turns dispatch into a denial; an existing Allow Once challenge
    /// has no grant digest and follows its ordinary approval path.
    pub(crate) fn validate_direct_session_command_grant_before_dispatch(
        &self,
        challenge_id: &str,
        query: &crate::direct_session_grant::ActiveGrantQueryV1,
    ) -> Result<bool, TypedErrorV1> {
        validate_identifier(challenge_id).map_err(Failure::error)?;
        let challenge = load_challenge(&self.connection, challenge_id)
            .map_err(Failure::error)?.ok_or_else(|| Failure::NotFound.error())?;
        if challenge.capability_id != guard::TERMINAL_RUN_ID
            || !challenge.resource.starts_with("workspace-command-profile-v1:")
            || challenge.session_id != query.session_id
            || challenge.principal != query.principal_id
            || !matches!(challenge.status.as_str(), "APPROVED" | "PREPARED")
            || challenge.capability_lease_digest.is_none()
        { return Err(Failure::Denied.error()); }
        let Some(grant_digest) = challenge.direct_session_grant_digest.as_deref() else { return Ok(true) };
        let row: Option<(String, Vec<u8>)> = self.connection.query_row(
            "SELECT event_kind,grant_value FROM direct_session_grant_events
             WHERE grant_id=(SELECT grant_id FROM direct_session_grant_events
                WHERE grant_digest=?1 ORDER BY sequence DESC LIMIT 1)
             ORDER BY sequence DESC LIMIT 1",
            [grant_digest], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        let Some((event_kind, encoded)) = row else { return Err(Failure::Denied.error()) };
        if event_kind != "ISSUED" { return Err(Failure::Denied.error()); }
        let value = messagepack::decode(&encoded, FRAME_LIMITS).map_err(|_| Failure::Unavailable.error())?;
        let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(&value)
            .map_err(|_| Failure::Unavailable.error())?;
        if grant.grant_digest != grant_digest || !grant.matches(query)
            || !direct_grant_allows_challenge(&grant, &challenge) {
            return Err(Failure::Denied.error());
        }
        Ok(true)
    }

    /// Read-only check for whether one exact root-Session protocol challenge
    /// would qualify for an active workspace-code read grant. This is display
    /// and dialog-suppression correlation only: it reserves no capacity and
    /// mutates no challenge or lease state.
    pub(crate) fn preflight_direct_session_grant_protocol_effect(
        &self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        authorization: &crate::protocol::ExecutionProtocolAuthorizationV1,
        query: &crate::direct_session_grant::ActiveGrantQueryV1,
        deadline_unix_ms: u64,
    ) -> Result<Option<DirectSessionGrantProjectionV1>, TypedErrorV1> {
        if !valid_direct_protocol_grant_query(
            process_session_id, principal, authorization, query, deadline_unix_ms,
        ) || !guard::is_direct_grant_read_protocol_action(
            authorization.capability_id().unwrap_or_default(),
        ) || !guard::is_direct_grant_read_protocol_operation(&authorization.operation)
        {
            return Err(Failure::Invalid.error());
        }
        validate_identifier(challenge_id).map_err(Failure::error)?;
        let now = query.now_unix_ms;
        let encoded_arguments = messagepack::encode(&authorization.to_value(), FRAME_LIMITS)
            .map_err(|_| Failure::Invalid.error())?;
        if encoded_arguments.is_empty() || encoded_arguments.len() > 1024 * 1024 {
            return Err(Failure::Invalid.error());
        }
        let content_digest = format!("blake3:{}", blake3::hash(&encoded_arguments).to_hex());
        let challenge = load_challenge(&self.connection, challenge_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        let capability_id = authorization.capability_id().ok_or_else(|| Failure::Denied.error())?;
        if challenge.session_id != process_session_id
            || challenge.principal != principal
            || challenge.capability_id != capability_id
            || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::UserAction
            || challenge.managed_attempt_digest.is_some()
            || challenge.content_digest != content_digest
            || challenge.expires_at_ms <= now
            || challenge.capability_lease_digest.is_some()
            || challenge.status != "AWAITING_APPROVAL"
        {
            return Err(Failure::Conflict.error());
        }
        let already_pinned: Option<String> = self.connection.query_row(
            "SELECT direct_session_grant_digest FROM effect_challenges WHERE challenge_id=?1",
            [challenge_id],
            |row| row.get(0),
        ).map_err(|_| Failure::Unavailable.error())?;
        if already_pinned.is_some() {
            return Err(Failure::Conflict.error());
        }
        let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;
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
            guard::EffectOriginKindV1::UserAction,
            None,
        );
        if decision.decision != guard::DecisionKind::Ask
            || intent.as_deref() != Some(challenge.argument_digest.as_str())
        {
            return Err(Failure::Denied.error());
        }
        let payload_bytes = i64::try_from(encoded_arguments.len()).map_err(|_| Failure::Denied.error())?;
        let mut statement = self.connection.prepare(
            "SELECT grant_value FROM direct_session_grant_events e
             WHERE event_kind='ISSUED' AND principal_id=?1
               AND sequence=(SELECT MAX(sequence) FROM direct_session_grant_events x WHERE x.grant_id=e.grant_id)
             ORDER BY sequence DESC LIMIT 4097",
        ).map_err(|_| Failure::Unavailable.error())?;
        let rows = statement.query_map([principal], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|_| Failure::Unavailable.error())?;
        let mut encoded_grants = Vec::new();
        for row in rows { encoded_grants.push(row.map_err(|_| Failure::Unavailable.error())?); }
        drop(statement);
        if encoded_grants.len() > 4096 { return Err(Failure::Unavailable.error()); }
        for encoded in encoded_grants {
            let value = messagepack::decode(&encoded, FRAME_LIMITS)
                .map_err(|_| Failure::Unavailable.error())?;
            let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(&value)
                .map_err(|_| Failure::Unavailable.error())?;
            if grant.scope_kind == "network_egress" || !grant.matches(query) || !grant.allows_read()
                || grant.max_effect_count.unwrap_or_default() == 0
                || payload_bytes < 0
                || payload_bytes as u64 > grant.max_payload_bytes.unwrap_or_default()
                || deadline_unix_ms > now.saturating_add(grant.max_wall_time_ms.unwrap_or_default())
            {
                continue;
            }
            let revoked: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM direct_session_grant_events WHERE grant_id=?1 AND event_kind='REVOKED')",
                [&grant.grant_id], |row| row.get(0),
            ).map_err(|_| Failure::Unavailable.error())?;
            if revoked { continue; }
            let old_usage: (i64, i64) = self.connection.query_row(
                "SELECT COALESCE(SUM(effect_count),0),COALESCE(SUM(payload_bytes),0)
                 FROM direct_session_grant_usage_events WHERE grant_id=?1",
                [&grant.grant_id], |row| Ok((row.get(0)?, row.get(1)?)),
            ).map_err(|_| Failure::Unavailable.error())?;
            if old_usage.0 < 0 || old_usage.1 < 0
                || old_usage.0 as u64 >= grant.max_effect_count.unwrap_or_default()
                || old_usage.1.checked_add(payload_bytes).is_none_or(|total| total < 0
                    || total as u64 > grant.max_payload_bytes.unwrap_or_default())
            {
                continue;
            }
            return Ok(Some(DirectSessionGrantProjectionV1::from_grant(&grant, "active")));
        }
        Ok(None)
    }

    /// Approve one exact root-Session read-only protocol operation under an
    /// active workspace-code grant. HostKernel supplies the authenticated grant
    /// query and the exact process authorization after refreshing owner, process,
    /// Location and workspace revision pins. This method reserves bounded grant
    /// usage and pins the grant to the retained AWAITING_APPROVAL challenge.
    /// HostKernel then uses the existing approval resolver to recheck Guard and
    /// mint the fresh one-use lease.
    pub(crate) fn approve_direct_session_grant_protocol_effect(
        &mut self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        authorization: &crate::protocol::ExecutionProtocolAuthorizationV1,
        query: &crate::direct_session_grant::ActiveGrantQueryV1,
        deadline_unix_ms: u64,
    ) -> Result<Option<DirectSessionGrantProjectionV1>, TypedErrorV1> {
        if !valid_direct_protocol_grant_query(
            process_session_id,
            principal,
            authorization,
            query,
            deadline_unix_ms,
        ) || !guard::is_direct_grant_read_protocol_action(
                authorization.capability_id().unwrap_or_default(),
            )
            || !guard::is_direct_grant_read_protocol_operation(&authorization.operation)
        {
            return Err(Failure::Invalid.error());
        }
        validate_identifier(challenge_id).map_err(Failure::error)?;
        let now = query.now_unix_ms;
        if now > i64::MAX as u64 {
            return Err(Failure::Invalid.error());
        }
        let encoded_arguments = messagepack::encode(&authorization.to_value(), FRAME_LIMITS)
            .map_err(|_| Failure::Invalid.error())?;
        if encoded_arguments.is_empty() || encoded_arguments.len() > 1024 * 1024 {
            return Err(Failure::Invalid.error());
        }
        let content_digest = format!("blake3:{}", blake3::hash(&encoded_arguments).to_hex());
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let challenge = load_challenge(&tx, challenge_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        let capability_id = authorization.capability_id().ok_or_else(|| Failure::Denied.error())?;
        if challenge.session_id != process_session_id
            || challenge.principal != principal
            || challenge.capability_id != capability_id
            || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::UserAction
            || challenge.managed_attempt_digest.is_some()
            || challenge.content_digest != content_digest
            || challenge.expires_at_ms <= now
            || challenge.capability_lease_digest.is_some()
            || !matches!(challenge.status.as_str(), "AWAITING_APPROVAL" | "APPROVED")
        {
            return Err(Failure::Conflict.error());
        }

        let mut statement = tx.prepare(
            "SELECT grant_value FROM direct_session_grant_events e
             WHERE event_kind='ISSUED' AND principal_id=?1
               AND sequence=(SELECT MAX(sequence) FROM direct_session_grant_events x WHERE x.grant_id=e.grant_id)
             ORDER BY sequence DESC LIMIT 4097",
        ).map_err(|_| Failure::Unavailable.error())?;
        let rows = statement.query_map([principal], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|_| Failure::Unavailable.error())?;
        let mut encoded_grants = Vec::new();
        for row in rows { encoded_grants.push(row.map_err(|_| Failure::Unavailable.error())?); }
        drop(statement);
        if encoded_grants.len() > 4096 { return Err(Failure::Unavailable.error()); }
        let mut selected = None;
        for encoded in encoded_grants {
            let value = messagepack::decode(&encoded, FRAME_LIMITS)
                .map_err(|_| Failure::Unavailable.error())?;
            let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(&value)
                .map_err(|_| Failure::Unavailable.error())?;
            if grant.scope_kind == "network_egress" || !grant.matches(query) || !grant.allows_read() {
                continue;
            }
            let revoked: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM direct_session_grant_events WHERE grant_id=?1 AND event_kind='REVOKED')",
                [&grant.grant_id], |row| row.get(0),
            ).map_err(|_| Failure::Unavailable.error())?;
            if !revoked { selected = Some(grant); break; }
        }
        let Some(grant) = selected else {
            tx.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(None);
        };
        let pinned_grant_digest: Option<String> = tx.query_row(
            "SELECT direct_session_grant_digest FROM effect_challenges WHERE challenge_id=?1",
            [challenge_id], |row| row.get(0),
        ).map_err(|_| Failure::Unavailable.error())?;
        if let Some(pinned_digest) = pinned_grant_digest {
            if pinned_digest != grant.grant_digest {
                return Err(Failure::Conflict.error());
            }
            let usage_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM direct_session_grant_usage_events WHERE grant_id=?1 AND batch_id=?2)",
                params![grant.grant_id, challenge.batch_id], |row| row.get(0),
            ).map_err(|_| Failure::Unavailable.error())?;
            if !usage_exists { return Err(Failure::Unknown.error()); }
            tx.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(Some(DirectSessionGrantProjectionV1::from_grant(&grant, "active")));
        }
        if challenge.status != "AWAITING_APPROVAL" {
            return Err(Failure::Conflict.error());
        }
        let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;
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
            guard::EffectOriginKindV1::UserAction,
            None,
        );
        if decision.decision != guard::DecisionKind::Ask
            || intent.as_deref() != Some(challenge.argument_digest.as_str())
        {
            return Err(Failure::Denied.error());
        }
        let payload_bytes = i64::try_from(encoded_arguments.len()).map_err(|_| Failure::Denied.error())?;
        if grant.max_effect_count.unwrap_or_default() < 1
            || payload_bytes < 0
            || payload_bytes as u64 > grant.max_payload_bytes.unwrap_or_default()
            || deadline_unix_ms > now.saturating_add(grant.max_wall_time_ms.unwrap_or_default())
        {
            return Err(Failure::Denied.error());
        }
        let old_usage: (i64, i64) = tx.query_row(
            "SELECT COALESCE(SUM(effect_count),0),COALESCE(SUM(payload_bytes),0)
             FROM direct_session_grant_usage_events WHERE grant_id=?1",
            [&grant.grant_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| Failure::Unavailable.error())?;
        let total_effects = old_usage.0.checked_add(1).ok_or_else(|| Failure::Denied.error())?;
        let total_bytes = old_usage.1.checked_add(payload_bytes).ok_or_else(|| Failure::Denied.error())?;
        if total_effects < 0 || total_effects as u64 > grant.max_effect_count.unwrap_or_default()
            || total_bytes < 0 || total_bytes as u64 > grant.max_payload_bytes.unwrap_or_default()
        {
            return Err(Failure::Denied.error());
        }
        let batch_digest = direct_session_grant_event_digest(
            "PROTOCOL_RESERVED", &challenge.batch_id, &grant.grant_digest,
            &encoded_arguments, Some(1), Some(principal),
        );
        let usage_event_digest = direct_session_grant_event_digest(
            "USAGE", &grant.grant_id, &grant.grant_digest, batch_digest.as_bytes(),
            Some(payload_bytes as u64), Some(principal),
        );
        tx.execute(
            "INSERT INTO direct_session_grant_usage_events(grant_id,batch_id,batch_digest,effect_count,payload_bytes,event_digest,created_at_ms)
             VALUES(?1,?2,?3,1,?4,?5,?6)",
            params![grant.grant_id, challenge.batch_id, batch_digest, payload_bytes,
                usage_event_digest, now as i64],
        ).map_err(|_| Failure::Conflict.error())?;
        let changed = tx.execute(
            "UPDATE effect_challenges SET direct_session_grant_digest=?1
             WHERE challenge_id=?2 AND session_id=?3 AND principal=?4
               AND status='AWAITING_APPROVAL' AND expires_at_ms>?5 AND direct_session_grant_digest IS NULL
               AND capability_lease_digest IS NULL AND lease_id IS NULL",
            params![grant.grant_digest, challenge_id, process_session_id, principal, now as i64],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        tx.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(Some(DirectSessionGrantProjectionV1::from_grant(&grant, "active")))
    }

    /// Reserve one bounded `workspace-code/read` grant use for an exact fixed Git
    /// read process. The caller has already obtained a fresh Guard lease; this
    /// transaction pins that lease/challenge to the immutable grant and launch
    /// preflight before `begin_execution_dispatch` can persist PREPARED.
    pub(crate) fn reserve_direct_grant_git_read(
        &mut self,
        binding: &StdioExecutionBindingV1,
        preflight: &StdioExecutionPreparedV1,
        query: &crate::direct_session_grant::ActiveGrantQueryV1,
        operation_digest: &str,
        operation_payload_bytes: usize,
    ) -> Result<DirectSessionGrantProjectionV1, TypedErrorV1> {
        self.validate_execution_preflight(binding, preflight)
            .map_err(Failure::error)?;
        let scope_matches = match &binding.scope {
            crate::terminal_process::StdioExecutionScopeV1::Session { session_id } => {
                !binding.session_id.is_empty()
                    && session_id == &binding.session_id
                    && query.session_id == *session_id
            }
            crate::terminal_process::StdioExecutionScopeV1::ProjectRead { workspace_id } => {
                binding.session_id.is_empty()
                    && binding.attempt_scope_digest.is_none()
                    && query.session_id.is_empty()
                    && query.workspace_id == *workspace_id
            }
        };
        if binding.capability_id != guard::FILES_READ_ID
            || !scope_matches
            || query.principal_id != binding.principal
            || query.location_id != binding.location_id
            || query.owner_epoch != binding.owner_epoch
            || !is_blake3_digest(operation_digest)
            || operation_payload_bytes == 0
            || operation_payload_bytes > 1024 * 1024
            || query.now_unix_ms > i64::MAX as u64
        {
            return Err(Failure::Denied.error());
        }
        let challenge = load_challenge(&self.connection, &binding.challenge_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        if challenge.effect_id != binding.effect_id
            || challenge.principal != binding.principal
            || challenge.session_id != binding.session_id
            || challenge.capability_id != guard::FILES_READ_ID
            || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::UserAction
            || challenge.managed_attempt_digest.is_some()
            || challenge.status != "APPROVED"
            || challenge.expires_at_ms <= query.now_unix_ms
            || challenge.capability_lease_digest.as_deref() != Some(binding.capability_lease_digest.as_str())
            || challenge.content_digest != operation_digest
            || challenge.argument_digest != binding.approved_arguments_digest
        {
            return Err(Failure::Conflict.error());
        }
        let payload_bytes = i64::try_from(operation_payload_bytes)
            .map_err(|_| Failure::Invalid.error())?;
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let mut statement = tx.prepare(
            "SELECT grant_id,grant_digest,grant_value FROM direct_session_grant_events e
             WHERE event_kind='ISSUED' AND principal_id=?1
               AND sequence=(SELECT MAX(sequence) FROM direct_session_grant_events x WHERE x.grant_id=e.grant_id)
             ORDER BY sequence DESC LIMIT 4097",
        ).map_err(|_| Failure::Unavailable.error())?;
        let rows = statement.query_map([&binding.principal], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Vec<u8>>(2)?,
        ))).map_err(|_| Failure::Unavailable.error())?;
        let mut grant_rows = Vec::new();
        for row in rows { grant_rows.push(row.map_err(|_| Failure::Unavailable.error())?); }
        drop(statement);
        if grant_rows.len() > 4096 { return Err(Failure::Unavailable.error()); }
        let mut selected = None;
        for (grant_id, event_digest, encoded) in grant_rows {
            let value = messagepack::decode(&encoded, FRAME_LIMITS)
                .map_err(|_| Failure::Unavailable.error())?;
            let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(&value)
                .map_err(|_| Failure::Unavailable.error())?;
            if grant.grant_id != grant_id || grant.grant_digest != event_digest {
                return Err(Failure::Unavailable.error());
            }
            if grant.scope_kind == "network_egress"
                || (matches!(&binding.scope, crate::terminal_process::StdioExecutionScopeV1::ProjectRead { .. })
                    && grant.scope_kind != "workspace")
                || !grant.matches(query)
                || !grant.allows_read()
            {
                continue;
            }
            let revoked: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM direct_session_grant_events WHERE grant_id=?1 AND event_kind='REVOKED')",
                [&grant.grant_id], |row| row.get(0),
            ).map_err(|_| Failure::Unavailable.error())?;
            if !revoked { selected = Some(grant); break; }
        }
        let grant = selected.ok_or_else(|| Failure::Denied.error())?;
        let mut use_material = Vec::new();
        for value in [
            binding.effect_id.as_bytes(), binding.challenge_id.as_bytes(),
            binding.capability_lease_digest.as_bytes(), binding.approved_arguments_digest.as_bytes(),
            operation_digest.as_bytes(), preflight.execution_digest.as_bytes(),
            preflight.launch_digest.as_bytes(), binding.workspace_revision.as_bytes(),
            query.workspace_root_digest.as_bytes(), query.guarantee_set_digest.as_bytes(),
        ] {
            use_material.extend_from_slice(&(value.len() as u64).to_be_bytes());
            use_material.extend_from_slice(value);
        }
        let batch_digest = direct_session_grant_event_digest(
            "STDIO_GIT_READ_RESERVED", &binding.effect_id, &grant.grant_digest,
            &use_material, Some(1), Some(&binding.principal),
        );
        let existing: Option<(String, i64, i64)> = tx.query_row(
            "SELECT batch_digest,effect_count,payload_bytes FROM direct_session_grant_usage_events
             WHERE grant_id=?1 AND batch_id=?2",
            params![grant.grant_id, binding.effect_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        if let Some((existing_digest, effect_count, existing_bytes)) = existing {
            let pinned: Option<String> = tx.query_row(
                "SELECT direct_session_grant_digest FROM effect_challenges WHERE challenge_id=?1",
                [&binding.challenge_id], |row| row.get(0),
            ).map_err(|_| Failure::Unavailable.error())?;
            if existing_digest != batch_digest || effect_count != 1 || existing_bytes != payload_bytes
                || pinned.as_deref() != Some(grant.grant_digest.as_str()) {
                return Err(Failure::Conflict.error());
            }
            tx.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(DirectSessionGrantProjectionV1::from_grant(&grant, "active"));
        }
        let old_usage: (i64, i64) = tx.query_row(
            "SELECT COALESCE(SUM(effect_count),0),COALESCE(SUM(payload_bytes),0)
             FROM direct_session_grant_usage_events WHERE grant_id=?1",
            [&grant.grant_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| Failure::Unavailable.error())?;
        let total_effects = old_usage.0.checked_add(1).ok_or_else(|| Failure::Denied.error())?;
        let total_bytes = old_usage.1.checked_add(payload_bytes).ok_or_else(|| Failure::Denied.error())?;
        if grant.max_effect_count.unwrap_or_default() == 0
            || total_effects < 0 || total_effects as u64 > grant.max_effect_count.unwrap_or_default()
            || total_bytes < 0 || total_bytes as u64 > grant.max_payload_bytes.unwrap_or_default()
            || query.now_unix_ms.saturating_add(10_000)
                > query.now_unix_ms.saturating_add(grant.max_wall_time_ms.unwrap_or_default())
        {
            return Err(Failure::Denied.error());
        }
        let usage_event_digest = direct_session_grant_event_digest(
            "USAGE", &grant.grant_id, &grant.grant_digest, batch_digest.as_bytes(),
            Some(payload_bytes as u64), Some(&binding.principal),
        );
        tx.execute(
            "INSERT INTO direct_session_grant_usage_events(grant_id,batch_id,batch_digest,effect_count,payload_bytes,event_digest,created_at_ms)
             VALUES(?1,?2,?3,1,?4,?5,?6)",
            params![grant.grant_id, binding.effect_id, batch_digest, payload_bytes,
                usage_event_digest, query.now_unix_ms as i64],
        ).map_err(|_| Failure::Conflict.error())?;
        let changed = tx.execute(
            "UPDATE effect_challenges SET direct_session_grant_digest=?1
             WHERE challenge_id=?2 AND effect_id=?3 AND principal=?4 AND session_id=?5
               AND capability_id=?6 AND status='APPROVED' AND expires_at_ms>?7
               AND capability_lease_digest=?8 AND direct_session_grant_digest IS NULL",
            params![grant.grant_digest, binding.challenge_id, binding.effect_id, binding.principal,
                binding.session_id, guard::FILES_READ_ID, query.now_unix_ms as i64,
                binding.capability_lease_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        tx.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(DirectSessionGrantProjectionV1::from_grant(&grant, "active"))
    }

    /// Append a monotonic, principal-bound revocation. Repeated revocation by
    /// the same issuer returns the existing nonsecret projection.
    pub(crate) fn revoke_direct_session_grant(
        &mut self, grant_id: &str, principal_id: &str, revoked_at_unix_ms: u64,
    ) -> Result<DirectSessionGrantProjectionV1, DirectSessionGrantErrorV1> {
        if revoked_at_unix_ms > i64::MAX as u64 { return Err(DirectSessionGrantErrorV1::Invalid); }
        let tx = self.connection.transaction().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let issued: Option<(String, String, Vec<u8>)> = tx.query_row(
            "SELECT principal_id,grant_digest,grant_value FROM direct_session_grant_events WHERE grant_id=?1 AND event_kind='ISSUED' ORDER BY sequence ASC LIMIT 1",
            [grant_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let Some((issuer, grant_digest, grant_value)) = issued else { return Err(DirectSessionGrantErrorV1::NotFound) };
        if issuer != principal_id { return Err(DirectSessionGrantErrorV1::NotFound); }
        let prior: Option<(String, String)> = tx.query_row(
            "SELECT revoked_at_unix_ms,revoked_by_principal_id FROM direct_session_grant_events WHERE grant_id=?1 AND event_kind='REVOKED' ORDER BY sequence DESC LIMIT 1",
            [grant_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let (at, by) = if let Some((at, by)) = prior {
            if by != principal_id { return Err(DirectSessionGrantErrorV1::NotFound); }
            (at.parse::<u64>().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?, by)
        } else {
            let event_value = messagepack::encode(&Value::Map(std::collections::BTreeMap::from([
                ("grantID".to_owned(), Value::String(grant_id.to_owned())),
                ("revokedAtUnixMs".to_owned(), Value::String(revoked_at_unix_ms.to_string())),
                ("revokedByPrincipalId".to_owned(), Value::String(principal_id.to_owned())),
            ])), FRAME_LIMITS).map_err(|_| DirectSessionGrantErrorV1::Invalid)?;
            let event_digest = direct_session_grant_event_digest("REVOKED", grant_id, &grant_digest,
                &event_value, Some(revoked_at_unix_ms), Some(principal_id));
            tx.execute("INSERT INTO direct_session_grant_events(grant_id,event_kind,principal_id,grant_digest,event_digest,revoked_at_unix_ms,revoked_by_principal_id,created_at_ms)
                        VALUES(?1,'REVOKED',?2,?3,?4,?5,?2,?6)",
                params![grant_id, principal_id, grant_digest, event_digest, revoked_at_unix_ms.to_string(), revoked_at_unix_ms as i64])
                .map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
            (revoked_at_unix_ms, principal_id.to_owned())
        };
        let value = messagepack::decode(&grant_value, FRAME_LIMITS).map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let grant = crate::direct_session_grant::DirectSessionGrantV1::from_value(&value).map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        tx.commit().map_err(|_| DirectSessionGrantErrorV1::Unavailable)?;
        let mut projection = DirectSessionGrantProjectionV1::from_grant(&grant, "revoked");
        projection.revoked_at_unix_ms = Some(at);
        let _ = by;
        Ok(projection)
    }

    /// Persist or inspect the explicit direct-session CodeMode enablement. The
    /// caller must mint `value` only after validating the exact completed user
    /// action and deriving all owner/helper/profile/backend pins from HostKernel.
    pub(crate) fn issue_code_mode_enablement(
        &mut self,
        principal: &str,
        session_id: &str,
        owner_epoch: u64,
        value: &Value,
        now_unix_ms: u64,
    ) -> Result<CodeModeEnablementProjectionV1, TypedErrorV1> {
        validate_identifier(principal).map_err(Failure::error)?;
        validate_identifier(session_id).map_err(Failure::error)?;
        if owner_epoch == 0 || owner_epoch > i64::MAX as u64 || now_unix_ms > i64::MAX as u64 {
            return Err(Failure::Invalid.error());
        }
        let claims = parse_direct_code_mode_enablement(value)?;
        let principal_digest = sha256_principal_digest(principal);
        if claims.session_id != session_id || claims.owner_epoch != owner_epoch
            || claims.principal_digest != principal_digest
            || claims.issued_at_ms > now_unix_ms || claims.expires_at_ms <= now_unix_ms
            || claims.revocation_generation != 1
        {
            return Err(Failure::Denied.error());
        }
        let encoded = messagepack::encode(value, FRAME_LIMITS).map_err(|_| Failure::Invalid.error())?;
        let event_digest = code_mode_enablement_event_digest("ISSUED", &claims, &encoded);
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let existing: Option<(String, String, Vec<u8>, String)> = tx.query_row(
            "SELECT principal_digest,enablement_digest,enablement_value,event_kind
             FROM code_mode_enablement_events WHERE grant_id=?1 AND event_kind='ISSUED'
             ORDER BY sequence ASC LIMIT 1",
            [&claims.grant_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        if let Some((prior_principal, prior_digest, prior_value, _)) = existing {
            if prior_principal != claims.principal_digest || prior_digest != claims.enablement_digest
                || prior_value != encoded
            { return Err(Failure::Conflict.error()); }
            let projection = latest_code_mode_enablement_projection(&tx, &claims.grant_id, now_unix_ms)?
                .ok_or_else(|| Failure::Unknown.error())?;
            tx.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(projection);
        }
        let latest: Vec<(String, Vec<u8>)> = {
            let mut statement = tx.prepare(
                "SELECT e.event_kind,e.enablement_value FROM code_mode_enablement_events e
                 WHERE e.principal_digest=?1 AND e.session_id=?2 AND e.owner_epoch=?3
                   AND e.sequence=(SELECT MAX(x.sequence) FROM code_mode_enablement_events x WHERE x.grant_id=e.grant_id)",
            ).map_err(|_| Failure::Unavailable.error())?;
            let rows = statement.query_map(params![claims.principal_digest, claims.session_id, owner_epoch as i64],
                |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| Failure::Unavailable.error())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|_| Failure::Unavailable.error())?
        };
        for (kind, bytes) in latest {
            if kind != "ISSUED" { continue; }
            let prior = messagepack::decode(&bytes, FRAME_LIMITS).map_err(|_| Failure::Unknown.error())?;
            if parse_direct_code_mode_enablement(&prior)?.expires_at_ms > now_unix_ms {
                return Err(Failure::Conflict.error());
            }
        }
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM code_mode_enablement_events WHERE event_kind='ISSUED'", [], |r| r.get(0))
            .map_err(|_| Failure::Unavailable.error())?;
        if count >= 4096 { return Err(Failure::Unavailable.error()); }
        tx.execute(
            "INSERT INTO code_mode_enablement_events(grant_id,event_kind,principal_digest,session_id,
             owner_epoch,enablement_digest,revocation_generation,enablement_value,event_digest,created_at_ms)
             VALUES(?1,'ISSUED',?2,?3,?4,?5,?6,?7,?8,?9)",
            params![claims.grant_id, claims.principal_digest, claims.session_id, owner_epoch as i64,
                claims.enablement_digest, claims.revocation_generation as i64, encoded, event_digest,
                now_unix_ms as i64],
        ).map_err(|_| Failure::Unavailable.error())?;
        tx.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(CodeModeEnablementProjectionV1 { value: value.clone(), status: "active".to_owned(), revoked_at_unix_ms: None })
    }

    /// Return the latest direct enablement for an authenticated owner. Expiry and
    /// revocation are read from durable event history, never cached in Core.
    pub(crate) fn inspect_code_mode_enablement(
        &self,
        principal: &str,
        session_id: &str,
        owner_epoch: u64,
        now_unix_ms: u64,
    ) -> Result<Option<CodeModeEnablementProjectionV1>, TypedErrorV1> {
        validate_identifier(principal).map_err(Failure::error)?;
        validate_identifier(session_id).map_err(Failure::error)?;
        if owner_epoch == 0 || owner_epoch > i64::MAX as u64 || now_unix_ms > i64::MAX as u64 {
            return Err(Failure::Invalid.error());
        }
        let grant_id: Option<String> = self.connection.query_row(
            "SELECT grant_id FROM code_mode_enablement_events
             WHERE principal_digest=?1 AND session_id=?2 AND owner_epoch=?3
             ORDER BY sequence DESC LIMIT 1",
            params![sha256_principal_digest(principal), session_id, owner_epoch as i64],
            |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        match grant_id {
            Some(id) => latest_code_mode_enablement_projection(&self.connection, &id, now_unix_ms),
            None => Ok(None),
        }
    }

    /// Revalidate every direct CodeMode pin immediately before exposing, launching
    /// or resuming the helper. A matching immutable digest is insufficient after
    /// revocation because revocationGeneration is deliberately mutable.
    pub(crate) fn validate_direct_code_mode_enablement(
        &self,
        principal: &str,
        session_id: &str,
        owner_epoch: u64,
        grant_id: &str,
        enablement_digest: &str,
        helper_digest: &str,
        resource_profile_digest: &str,
        guarantee_digest: &str,
        policy_digest: &str,
        now_unix_ms: u64,
    ) -> Result<CodeModeEnablementProjectionV1, TypedErrorV1> {
        if !is_blake3_digest(enablement_digest) || !guard::is_sha256_digest(helper_digest)
            || !is_blake3_digest(resource_profile_digest) || !is_blake3_digest(guarantee_digest)
            || !is_blake3_digest(policy_digest)
        { return Err(Failure::Invalid.error()); }
        let projection = self.inspect_code_mode_enablement(principal, session_id, owner_epoch, now_unix_ms)?
            .ok_or_else(|| Failure::NotFound.error())?;
        let claims = parse_direct_code_mode_enablement(&projection.value)?;
        let Value::Map(fields) = &projection.value else { return Err(Failure::Unknown.error()); };
        if projection.status != "active" || claims.grant_id != grant_id
            || claims.enablement_digest != enablement_digest
            || claims.principal_digest != sha256_principal_digest(principal)
            || claims.session_id != session_id || claims.owner_epoch != owner_epoch
            || text(fields, "helperDigest")? != helper_digest
            || text(fields, "resourceProfileDigest")? != resource_profile_digest
            || text(fields, "guaranteeDigest")? != guarantee_digest
            || text(fields, "policyDigest")? != policy_digest
        { return Err(Failure::Denied.error()); }
        Ok(projection)
    }

    /// Revoke exactly one direct enablement for its authenticated Session owner.
    /// The new generation is an append-only event and fences later launches.
    pub(crate) fn revoke_code_mode_enablement(
        &mut self,
        principal: &str,
        session_id: &str,
        owner_epoch: u64,
        grant_id: &str,
        now_unix_ms: u64,
    ) -> Result<CodeModeEnablementProjectionV1, TypedErrorV1> {
        validate_identifier(principal).map_err(Failure::error)?;
        validate_identifier(session_id).map_err(Failure::error)?;
        validate_identifier(grant_id).map_err(Failure::error)?;
        if owner_epoch == 0 || owner_epoch > i64::MAX as u64 || now_unix_ms > i64::MAX as u64 {
            return Err(Failure::Invalid.error());
        }
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let projection = latest_code_mode_enablement_projection(&tx, grant_id, now_unix_ms)?
            .ok_or_else(|| Failure::NotFound.error())?;
        let claims = parse_direct_code_mode_enablement(&projection.value)?;
        if now_unix_ms < claims.issued_at_ms
            || claims.principal_digest != sha256_principal_digest(principal)
            || claims.session_id != session_id || claims.owner_epoch != owner_epoch
        { return Err(Failure::NotFound.error()); }
        if projection.status == "revoked" {
            tx.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(projection);
        }
        let next_generation = claims.revocation_generation.checked_add(1)
            .filter(|generation| *generation <= i64::MAX as u64)
            .ok_or_else(|| Failure::Unavailable.error())?;
        let Value::Map(mut fields) = projection.value.clone() else { return Err(Failure::Unknown.error()); };
        fields.insert("revocationGeneration".to_owned(), Value::String(next_generation.to_string()));
        let value = Value::Map(fields);
        let revoked_claims = parse_direct_code_mode_enablement(&value)?;
        let encoded = messagepack::encode(&value, FRAME_LIMITS).map_err(|_| Failure::Unknown.error())?;
        let event_digest = code_mode_enablement_event_digest("REVOKED", &revoked_claims, &encoded);
        tx.execute(
            "INSERT INTO code_mode_enablement_events(grant_id,event_kind,principal_digest,session_id,
             owner_epoch,enablement_digest,revocation_generation,enablement_value,event_digest,created_at_ms)
             VALUES(?1,'REVOKED',?2,?3,?4,?5,?6,?7,?8,?9)",
            params![claims.grant_id, claims.principal_digest, claims.session_id, owner_epoch as i64,
                claims.enablement_digest, next_generation as i64, encoded, event_digest, now_unix_ms as i64],
        ).map_err(|_| Failure::Unavailable.error())?;
        tx.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(CodeModeEnablementProjectionV1 { value, status: "revoked".to_owned(), revoked_at_unix_ms: Some(now_unix_ms) })
    }

    /// Persist Core's exact managed inbox consumption proof after HostKernel has
    /// independently authenticated its OwnerLog receipt and current consumer.
    /// The EffectHost journal is the durable idempotency/ACK boundary shared by
    /// process restarts; it never resolves caller-provided Attempt IDs itself.
    pub(crate) fn record_managed_message_consumption_ack(
        &mut self,
        ack: &crate::protocol::ManagedMessageConsumptionAckV1,
    ) -> Result<crate::protocol::ManagedMessageConsumptionAckReceiptV1, TypedErrorV1> {
        let wire = ack.to_value();
        let decoded = crate::protocol::ManagedMessageConsumptionAckV1::from_value(&wire)
            .ok_or_else(|| Failure::Invalid.error())?;
        if &decoded != ack {
            return Err(Failure::Invalid.error());
        }
        let encoded = messagepack::encode(&wire, FRAME_LIMITS)
            .map_err(|_| Failure::Invalid.error())?;
        let mailbox_sequence = i64::try_from(ack.pins.mailbox_sequence)
            .map_err(|_| Failure::Invalid.error())?;
        let authority_digest = ack.pins.authority_digest()
            .map_err(|_| Failure::Invalid.error())?;
        let ack_receipt = crate::protocol::ManagedMessageConsumptionAckReceiptV1::new(decoded.clone())
            .map_err(|_| Failure::Invalid.error())?;
        let transaction = self.connection.transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let existing = transaction.query_row(
            "SELECT authority_digest,consumption_ack_digest,host_receipt_digest,ack_value
             FROM managed_message_consumption_acks
             WHERE child_session_id=?1 AND message_id=?2 AND mailbox_sequence=?3",
            params![ack.pins.child_session_id, ack.pins.message_id, mailbox_sequence],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Vec<u8>>(3)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        if let Some((stored_authority, stored_ack, stored_receipt, stored_value)) = existing {
            if stored_authority != authority_digest || stored_ack != ack.consumption_ack_digest
                || stored_receipt != ack_receipt.receipt_digest || stored_value != encoded
            {
                return Err(Failure::Conflict.error());
            }
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(ack_receipt);
        }
        let now = now_ms().map_err(Failure::error)? as i64;
        transaction.execute(
            "INSERT INTO managed_message_consumption_acks(
                child_session_id,message_id,mailbox_sequence,authority_digest,
                consumption_ack_digest,host_receipt_digest,ack_value,created_at_ms
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![ack.pins.child_session_id, ack.pins.message_id,
                mailbox_sequence, authority_digest,
                ack.consumption_ack_digest, ack_receipt.receipt_digest, encoded, now],
        ).map_err(|_| Failure::Conflict.error())?;
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(ack_receipt)
    }

    /// Admit one internally initiated managed provider request through the same
    /// canonical Guard challenge/approval journal. This is deliberately not a
    /// ToolBatch operation and accepts only Rust-resolved ManagedRun bindings.
    pub(crate) fn prepare_managed_provider_inference(
        &mut self,
        binding: &ManagedProviderPrepareBindingV1,
    ) -> Result<Value, TypedErrorV1> {
        let binding_digest = binding.digest().map_err(|_| Failure::Invalid.error())?;
        let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;
        if binding.provider_request_id.is_empty() || binding.managed_attempt_digest.is_empty() { return Err(Failure::Invalid.error()); }
        // The provider request ID is the idempotency key. A retry must recover
        // the original host-minted challenge, never create a second approval.
        if let Some((challenge_id, effect_id, stored_digest)) = self.connection.query_row(
            "SELECT challenge_id,effect_id,binding_digest FROM provider_inference_dispatches
             WHERE provider_request_id=?1",
            [&binding.provider_request_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())? {
            if stored_digest != binding_digest { return Err(Failure::Conflict.error()); }
            let challenge = load_challenge(&self.connection, &challenge_id)
                .map_err(Failure::error)?.ok_or_else(|| Failure::Unknown.error())?;
            if challenge.effect_id != effect_id || challenge.capability_id != guard::PROVIDERS_INFER_ID
                || challenge.content_digest != binding_digest
                || challenge.managed_attempt_digest.as_deref() != Some(binding.managed_attempt_digest.as_str())
            { return Err(Failure::Unknown.error()); }
            // A resolved, expired, or otherwise terminal consent challenge must
            // never be surfaced again as a fresh approval. Core must reconcile
            // the exact request; a new request sequence can create a new challenge.
            if challenge.status != "AWAITING_APPROVAL" || challenge.expires_at_ms <= now_ms().map_err(Failure::error)? {
                return Err(Failure::Conflict.error());
            }
            let call = PlannedCall {
                call_id: challenge.call_id,
                capability_id: challenge.capability_id,
                challenge_id: challenge.challenge_id,
                effect_id: challenge.effect_id,
                arguments_digest: String::new(),
                argument_digest: challenge.argument_digest,
                content_digest: challenge.content_digest,
                expires_at_ms: challenge.expires_at_ms,
                managed_attempt_digest: challenge.managed_attempt_digest,
                effect: PlannedEffect::GuardedControl {
                    requested_path: challenge.requested_path,
                    relative_path: challenge.relative_path,
                    resource: challenge.resource,
                    operation: guard::PROVIDERS_INFER_ID.to_owned(),
                },
            };
            return Ok(single_approval_value(&call));
        }
        let challenge_id = random_id("ch").map_err(Failure::error)?;
        let effect_id = random_id("eff").map_err(Failure::error)?;
        let root = execution.root().to_string_lossy().into_owned();
        let (decision, argument_digest) = guard_provider_inference_decision(
            execution, &binding.principal, &binding.session_id, &binding.batch_id,
            &binding.call_id, &binding.managed_attempt_digest, &binding.permission_scope_digest,
            &binding_digest, &challenge_id,
        );
        if decision.decision != guard::DecisionKind::Ask {
            return Ok(map_value([
                ("status", Value::String("denied".to_owned())),
                ("reason", Value::String(decision.reason_code.unwrap_or("guard_denied").to_owned())),
            ]));
        }
        let expires_at_ms = now_ms().map_err(Failure::error)?.checked_add(CHALLENGE_TTL_MS)
            .ok_or_else(|| Failure::Unavailable.error())?;
        let call = PlannedCall {
            call_id: binding.call_id.clone(), capability_id: guard::PROVIDERS_INFER_ID.to_owned(),
            challenge_id: challenge_id.clone(), effect_id: effect_id.clone(), argument_digest,
            arguments_digest: String::new(),
            content_digest: binding_digest.clone(), expires_at_ms,
            managed_attempt_digest: Some(binding.managed_attempt_digest.clone()),
            effect: PlannedEffect::GuardedControl {
                requested_path: root.clone(), relative_path: ".".to_owned(),
                resource: ".".to_owned(), operation: guard::PROVIDERS_INFER_ID.to_owned(),
            },
        };
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let now = now_ms().map_err(Failure::error)? as i64;
        transaction.execute(
            "INSERT INTO effect_challenges(
                challenge_id,effect_id,session_id,principal,batch_id,call_id,capability_id,
                relative_path,requested_path,target,resource,existed,argument_digest,content_digest,
                expires_at_ms,status,approved,after_digest,lease_id,receipt_digest,turn_context_digest,
                origin_kind,managed_attempt_digest
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,'.',?8,?8,'.',0,?9,?10,?11,
                       'AWAITING_APPROVAL',NULL,NULL,NULL,NULL,'','managed_run',?12)",
            params![call.challenge_id, call.effect_id, binding.session_id, binding.principal,
                binding.batch_id, call.call_id, guard::PROVIDERS_INFER_ID, root,
                call.argument_digest, binding_digest, expires_at_ms as i64,
                binding.managed_attempt_digest],
        ).map_err(|_| Failure::Conflict.error())?;
        transaction.execute(
            "INSERT INTO provider_inference_dispatches(
                challenge_id,effect_id,binding_digest,provider_request_id,prepare_digest,
                dispatch_digest,token_digest,status,created_at_ms,updated_at_ms
             ) VALUES (?1,?2,?3,?4,?5,NULL,NULL,'AWAITING_APPROVAL',?6,?6)",
            params![call.challenge_id, call.effect_id, binding_digest,
                binding.provider_request_id, binding_digest, now],
        ).map_err(|_| Failure::Conflict.error())?;
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(single_approval_value(&call))
    }

    /// Resolve the one host-minted `providers.infer` Guard challenge after the
    /// authenticated reviewer answers. This path deliberately does not reuse
    /// the broker-process approval-set resolver: inference has no executable
    /// binding and must be re-authorized against its complete pinned request.
    /// The principal and binding are supplied only by HostKernel after it has
    /// resolved ServerAuth and the live managed Attempt.
    pub(crate) fn resolve_managed_provider_inference_approval(
        &mut self,
        binding: &ManagedProviderPrepareBindingV1,
        principal: &str,
        challenge_id: &str,
        effect_id: &str,
        allow: bool,
    ) -> Result<(), TypedErrorV1> {
        let fail = |failure: Failure| failure.error();
        let prepare_digest = binding.digest().map_err(|_| Failure::Invalid.error())?;
        if principal != binding.principal
            || challenge_id.is_empty()
            || effect_id.is_empty()
        {
            return Err(Failure::Denied.error());
        }
        let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let challenge = load_challenge(&transaction, challenge_id)
            .map_err(fail)?.ok_or_else(|| Failure::NotFound.error())?;
        let now = now_ms().map_err(Failure::error)?;
        let (decision, expected_argument_digest) = guard_provider_inference_decision(
            execution,
            principal,
            &binding.session_id,
            &binding.batch_id,
            &binding.call_id,
            &binding.managed_attempt_digest,
            &binding.permission_scope_digest,
            &prepare_digest,
            challenge_id,
        );
        let dispatch: (String, String, String) = transaction.query_row(
            "SELECT status,binding_digest,provider_request_id FROM provider_inference_dispatches
             WHERE challenge_id=?1 AND effect_id=?2",
            params![challenge_id, effect_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::NotFound.error())?;
        let stored_decision: Option<i64> = transaction.query_row(
            "SELECT approved FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2",
            params![challenge_id, effect_id],
            |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        if decision.decision != guard::DecisionKind::Ask
            || challenge.challenge_id != challenge_id
            || challenge.effect_id != effect_id
            || challenge.capability_id != guard::PROVIDERS_INFER_ID
            || challenge.origin_kind != ORIGIN_MANAGED_RUN
            || challenge.principal != principal
            || challenge.session_id != binding.session_id
            || challenge.batch_id != binding.batch_id
            || challenge.call_id != binding.call_id
            || challenge.managed_attempt_digest.as_deref() != Some(binding.managed_attempt_digest.as_str())
            || challenge.argument_digest != expected_argument_digest
            || challenge.content_digest != prepare_digest
            || dispatch.0 != "AWAITING_APPROVAL"
            || dispatch.1 != prepare_digest
            || dispatch.2 != binding.provider_request_id
        {
            return Err(Failure::Conflict.error());
        }
        // A lost approval RPC reply can be retried with the same authenticated
        // binding. Accept only an exact already-committed matching decision;
        // this does not mint or return a lease and never reopens the challenge.
        if (allow && challenge.status == "APPROVED" && stored_decision == Some(1))
            || (!allow && challenge.status == "DENIED" && stored_decision == Some(0))
        {
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(());
        }
        if challenge.expires_at_ms <= now {
            transaction.execute(
                "UPDATE effect_challenges SET status='EXPIRED',approved=NULL
                 WHERE challenge_id=?1 AND effect_id=?2 AND status='AWAITING_APPROVAL'",
                params![challenge_id, effect_id],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Err(Failure::Conflict.error());
        }
        let status = if allow { "APPROVED" } else { "DENIED" };
        let changed = transaction.execute(
            "UPDATE effect_challenges SET status=?1,approved=?2
             WHERE challenge_id=?3 AND effect_id=?4 AND capability_id='providers.infer'
               AND status='AWAITING_APPROVAL' AND expires_at_ms>?5",
            params![status, i64::from(allow), challenge_id, effect_id, now as i64],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(())
    }

    /// Convert an approved Guard challenge and one-use lease into a durable,
    /// opaque authorization. HostKernel must append DISPATCHING before exposing
    /// this token to the trusted Core provider callback.
    pub(crate) fn authorize_managed_provider_dispatch(
        &mut self,
        binding: &ManagedProviderEffectBindingV1,
        challenge_id: &str,
        effect_id: &str,
        lease_digest: &str,
        prepare_digest: &str,
        dispatch_digest: &str,
    ) -> Result<ManagedProviderSendAuthorizationV1, TypedErrorV1> {
        let binding_digest = binding.digest().map_err(|_| Failure::Invalid.error())?;
        let expected_prepare_digest = binding.prepare_digest().map_err(|_| Failure::Invalid.error())?;
        if !is_blake3_digest(lease_digest) || prepare_digest != expected_prepare_digest
            || binding.pins.guard_challenge_id != challenge_id
            || binding.pins.capability_lease_digest != lease_digest
            || !is_blake3_digest(dispatch_digest)
        { return Err(Failure::Invalid.error()); }
        let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;
        let challenge = load_challenge(&self.connection, challenge_id)
            .map_err(Failure::error)?.ok_or_else(|| Failure::NotFound.error())?;
        let (decision, expected_argument_digest) = guard_provider_inference_decision(
            execution, &binding.principal, &binding.session_id, &binding.batch_id,
            &binding.call_id, &binding.pins.managed_attempt_digest, &binding.pins.permission_scope_digest,
            &expected_prepare_digest, challenge_id,
        );
        if decision.decision != guard::DecisionKind::Ask || challenge.effect_id != effect_id
            || challenge.capability_id != guard::PROVIDERS_INFER_ID
            || challenge.principal != binding.principal || challenge.session_id != binding.session_id
            || challenge.batch_id != binding.batch_id || challenge.call_id != binding.call_id
            || challenge.origin_kind != ORIGIN_MANAGED_RUN
            || challenge.managed_attempt_digest.as_deref() != Some(binding.pins.managed_attempt_digest.as_str())
            || challenge.argument_digest != expected_argument_digest || challenge.content_digest != expected_prepare_digest
            || challenge.status != "APPROVED" || challenge.expires_at_ms <= now_ms().map_err(Failure::error)?
        { return Err(Failure::Denied.error()); }
        let token = random_id("provider-send").map_err(Failure::error)?;
        let token_digest = format!("blake3:{}", blake3::hash(token.as_bytes()).to_hex());
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let row: (String, String, String, Option<String>) = transaction.query_row(
            "SELECT status,binding_digest,provider_request_id,dispatch_digest
             FROM provider_inference_dispatches WHERE challenge_id=?1 AND effect_id=?2",
            params![challenge_id, effect_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if row.0 != "AWAITING_APPROVAL" || row.1 != expected_prepare_digest
            || row.2 != binding.pins.provider_request_id || row.3.is_some()
        { return Err(Failure::Unknown.error()); }
        let changed = transaction.execute(
            "UPDATE effect_challenges SET status='PREPARED',lease_id=?1,capability_lease_digest=?2
             WHERE challenge_id=?3 AND effect_id=?4 AND capability_id='providers.infer'
               AND status='APPROVED' AND approved=1 AND capability_lease_digest IS NULL",
            params![random_id("lease").map_err(Failure::error)?, lease_digest, challenge_id, effect_id],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        let changed = transaction.execute(
            "UPDATE provider_inference_dispatches SET binding_digest=?1,dispatch_digest=?2,token_digest=?3,
                status='TOKEN_ISSUED',updated_at_ms=?4
             WHERE challenge_id=?5 AND effect_id=?6 AND binding_digest=?7
               AND status='AWAITING_APPROVAL'",
            params![binding_digest, dispatch_digest, token_digest, now_ms().map_err(Failure::error)? as i64,
                challenge_id, effect_id, expected_prepare_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(ManagedProviderSendAuthorizationV1 {
            token, provider_request_id: binding.pins.provider_request_id.clone(),
            effect_id: effect_id.to_owned(),
            prepare_digest: prepare_digest.to_owned(), dispatch_digest: dispatch_digest.to_owned(),
            binding_digest,
        })
    }

    /// Consume the opaque provider send permit exactly once. A process restart
    /// before this ACK makes its row UNKNOWN, so no token is ever replayed.
    pub(crate) fn consume_managed_provider_send_authorization(
        &mut self,
        binding: &ManagedProviderEffectBindingV1,
        authorization: &ManagedProviderSendAuthorizationV1,
    ) -> Result<(), TypedErrorV1> {
        let binding_digest = binding.digest().map_err(|_| Failure::Invalid.error())?;
        let expected_prepare_digest = binding.prepare_digest().map_err(|_| Failure::Invalid.error())?;
        if authorization.provider_request_id != binding.pins.provider_request_id
            || authorization.effect_id.is_empty()
            || authorization.binding_digest != binding_digest
            || authorization.prepare_digest != expected_prepare_digest
            || !is_blake3_digest(&authorization.dispatch_digest)
            || authorization.token.is_empty() || authorization.token.len() > 256
        { return Err(Failure::Denied.error()); }
        let token_digest = format!("blake3:{}", blake3::hash(authorization.token.as_bytes()).to_hex());
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let changed = transaction.execute(
            "UPDATE provider_inference_dispatches SET status='CONSUMED',token_digest=NULL,updated_at_ms=?1
             WHERE provider_request_id=?2 AND effect_id=?3 AND binding_digest=?4 AND prepare_digest=?5
               AND dispatch_digest=?6 AND token_digest=?7 AND status='TOKEN_ISSUED'",
            params![now_ms().map_err(Failure::error)? as i64, authorization.provider_request_id,
                authorization.effect_id, binding_digest, authorization.prepare_digest,
                authorization.dispatch_digest, token_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Unknown.error()); }
        transaction.commit().map_err(|_| Failure::Unavailable.error())
    }

    /// Persist the receipt projection after HostKernel has independently
    /// verified the committed assistant entry and authoritative usage facts.
    pub(crate) fn settle_managed_provider_inference(
        &mut self,
        binding: &ManagedProviderEffectBindingV1,
        authorization: &ManagedProviderSendAuthorizationV1,
        assistant_entry_id: &str,
        response_digest: &str,
        usage_digest: &str,
    ) -> Result<String, TypedErrorV1> {
        let binding_digest = binding.digest().map_err(|_| Failure::Invalid.error())?;
        let prepare_digest = binding.prepare_digest().map_err(|_| Failure::Invalid.error())?;
        validate_identifier(assistant_entry_id).map_err(Failure::error)?;
        if authorization.binding_digest != binding_digest
            || authorization.prepare_digest != prepare_digest
            || authorization.provider_request_id != binding.pins.provider_request_id
            || authorization.effect_id.is_empty()
            || !is_blake3_digest(&authorization.dispatch_digest)
            || !is_blake3_digest(response_digest) || !is_blake3_digest(usage_digest)
        { return Err(Failure::Denied.error()); }
        let receipt_digest = provider_inference_receipt_digest(
            &binding_digest, &authorization.dispatch_digest, assistant_entry_id,
            response_digest, usage_digest,
        );
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let existing: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>)> = transaction.query_row(
            "SELECT status,assistant_entry_id,response_digest,usage_digest,receipt_digest
             FROM provider_inference_dispatches WHERE provider_request_id=?1 AND effect_id=?2
               AND binding_digest=?3 AND prepare_digest=?4 AND dispatch_digest=?5",
            params![authorization.provider_request_id, authorization.effect_id, binding_digest,
                prepare_digest, authorization.dispatch_digest],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if existing.0 == "SETTLED" {
            if existing.1.as_deref() == Some(assistant_entry_id)
                && existing.2.as_deref() == Some(response_digest)
                && existing.3.as_deref() == Some(usage_digest)
                && existing.4.as_deref() == Some(receipt_digest.as_str())
            { transaction.commit().map_err(|_| Failure::Unavailable.error())?; return Ok(receipt_digest); }
            return Err(Failure::Unknown.error());
        }
        if existing.0 != "CONSUMED" { return Err(Failure::Unknown.error()); }
        let changed = transaction.execute(
            "UPDATE provider_inference_dispatches SET status='SETTLED',assistant_entry_id=?1,
                response_digest=?2,usage_digest=?3,receipt_digest=?4,updated_at_ms=?5
             WHERE provider_request_id=?6 AND effect_id=?7 AND binding_digest=?8 AND prepare_digest=?9
               AND dispatch_digest=?10 AND status='CONSUMED'",
            params![assistant_entry_id, response_digest, usage_digest, receipt_digest,
                now_ms().map_err(Failure::error)? as i64, authorization.provider_request_id,
                authorization.effect_id, binding_digest, prepare_digest, authorization.dispatch_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Unknown.error()); }
        let challenge_changed = transaction.execute(
            "UPDATE effect_challenges SET status='SETTLED',receipt_digest=?1
             WHERE challenge_id=?2 AND effect_id=?3 AND capability_id='providers.infer'
               AND status='PREPARED' AND capability_lease_digest=?4",
            params![receipt_digest, binding.pins.guard_challenge_id,
                authorization.effect_id, binding.pins.capability_lease_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if challenge_changed != 1 { return Err(Failure::Unknown.error()); }
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(receipt_digest)
    }

    pub(crate) fn mark_managed_provider_inference_unknown(
        &mut self,
        binding: &ManagedProviderEffectBindingV1,
        authorization: &ManagedProviderSendAuthorizationV1,
    ) -> Result<(), TypedErrorV1> {
        let binding_digest = binding.digest().map_err(|_| Failure::Invalid.error())?;
        let prepare_digest = binding.prepare_digest().map_err(|_| Failure::Invalid.error())?;
        if authorization.binding_digest != binding_digest
            || authorization.prepare_digest != prepare_digest
            || authorization.provider_request_id != binding.pins.provider_request_id
            || authorization.effect_id.is_empty()
            || !is_blake3_digest(&authorization.dispatch_digest)
        { return Err(Failure::Denied.error()); }
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let changed = transaction.execute(
            "UPDATE provider_inference_dispatches SET status='UNKNOWN',token_digest=NULL,updated_at_ms=?1
             WHERE provider_request_id=?2 AND effect_id=?3 AND binding_digest=?4 AND prepare_digest=?5
               AND dispatch_digest=?6 AND status IN ('TOKEN_ISSUED','CONSUMED')",
            params![now_ms().map_err(Failure::error)? as i64, authorization.provider_request_id,
                authorization.effect_id, binding_digest, prepare_digest, authorization.dispatch_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed == 0 {
            let status: Option<String> = transaction.query_row(
                "SELECT status FROM provider_inference_dispatches WHERE provider_request_id=?1 AND effect_id=?2
                   AND binding_digest=?3 AND prepare_digest=?4 AND dispatch_digest=?5",
                params![authorization.provider_request_id, authorization.effect_id, binding_digest,
                    prepare_digest, authorization.dispatch_digest],
                |row| row.get(0),
            ).optional().map_err(|_| Failure::Unavailable.error())?;
            if status.as_deref() != Some("UNKNOWN") { return Err(Failure::Unknown.error()); }
        }
        transaction.execute(
            "UPDATE effect_challenges SET status='UNKNOWN'
             WHERE challenge_id=?1 AND effect_id=?2 AND capability_id='providers.infer'
               AND status='PREPARED'",
            params![binding.pins.guard_challenge_id, authorization.effect_id],
        ).map_err(|_| Failure::Unavailable.error())?;
        transaction.commit().map_err(|_| Failure::Unavailable.error())
    }

    pub(crate) fn inspect_managed_provider_inference(
        &self,
        binding: &ManagedProviderEffectBindingV1,
        challenge_id: &str,
        effect_id: &str,
    ) -> Result<ManagedProviderInferenceRecoveryV1, TypedErrorV1> {
        let final_digest = binding.digest().map_err(|_| Failure::Invalid.error())?;
        let prepare_digest = binding.prepare_digest().map_err(|_| Failure::Invalid.error())?;
        if binding.pins.guard_challenge_id != challenge_id { return Err(Failure::Denied.error()); }
        let row: (String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) = self.connection.query_row(
            "SELECT status,binding_digest,assistant_entry_id,response_digest,usage_digest,receipt_digest,dispatch_digest
             FROM provider_inference_dispatches WHERE challenge_id=?1 AND effect_id=?2
               AND provider_request_id=?3",
            params![challenge_id, effect_id, binding.pins.provider_request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if row.1 != prepare_digest && row.1 != final_digest { return Err(Failure::Unknown.error()); }
        match row.0.as_str() {
            "AWAITING_APPROVAL" => Ok(ManagedProviderInferenceRecoveryV1::NotDispatched),
            "TOKEN_ISSUED" | "CONSUMED" | "UNKNOWN" => Ok(ManagedProviderInferenceRecoveryV1::Unknown),
            "SETTLED" => {
                let assistant_entry_id = row.2.ok_or_else(|| Failure::Unknown.error())?;
                let response_digest = row.3.ok_or_else(|| Failure::Unknown.error())?;
                let usage_digest = row.4.ok_or_else(|| Failure::Unknown.error())?;
                let receipt_digest = row.5.ok_or_else(|| Failure::Unknown.error())?;
                let dispatch_digest = row.6.ok_or_else(|| Failure::Unknown.error())?;
                if !is_blake3_digest(&response_digest) || !is_blake3_digest(&usage_digest)
                    || !is_blake3_digest(&receipt_digest) || !is_blake3_digest(&dispatch_digest)
                    || provider_inference_receipt_digest(&final_digest, &dispatch_digest,
                        &assistant_entry_id, &response_digest, &usage_digest) != receipt_digest
                { return Err(Failure::Unknown.error()); }
                Ok(ManagedProviderInferenceRecoveryV1::Settled {
                    receipt_digest, response_digest, usage_digest, assistant_entry_id,
                })
            }
            _ => Err(Failure::Unknown.error()),
        }
    }

    pub(crate) fn record_repl_callback_page(
        &mut self,
        binding: &StdioExecutionBindingV1,
        page: &crate::protocol::ExecutionReplCallbackReadPageV1,
    ) -> Result<(), TypedErrorV1> {
        let validated = crate::protocol::ExecutionReplCallbackReadPageV1::from_value(
            &page.to_value(), 16, 256 * 1024,
        ).ok_or_else(|| Failure::Invalid.error())?;
        if &validated != page { return Err(Failure::Invalid.error()); }
        let process_ref = StdioProcessRefV1::from_binding(binding, StdioProcessKindV1::Interpreter)
            .map_err(|_| Failure::Denied.error())?;
        if binding.capability_id != guard::REPL_START_ID || page.host_process_ref != process_ref
            || page.workspace_revision != binding.workspace_revision
        { return Err(Failure::Denied.error()); }
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let status: String = transaction.query_row(
            "SELECT status FROM stdio_executions WHERE execution_id=?1 AND effect_id=?2
             AND challenge_id=?3 AND principal=?4 AND execution_principal=?5 AND session_id=?6
             AND location_id=?7 AND capability_id=?8 AND owner_epoch=?9 AND generation=?10
             AND workspace_revision=?11 AND profile_id=?12 AND profile_revision=?13
             AND profile_digest=?14 AND executable_digest=?15",
            params![binding.execution_id, binding.effect_id, binding.challenge_id, binding.principal,
                binding.execution_principal, binding.session_id, binding.location_id, binding.capability_id,
                binding.owner_epoch as i64, binding.generation as i64, binding.workspace_revision,
                binding.profile_id, binding.profile_revision as i64, binding.profile_digest, binding.executable_digest],
            |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if status != "RUNNING" {
            transaction.execute(
                "UPDATE execution_repl_callback_events SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND generation=?3 AND status='PENDING'",
                params![now_ms().map_err(Failure::error)? as i64, binding.execution_id, binding.generation as i64],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Err(Failure::Unknown.error());
        }
        if page.status != crate::protocol::ExecutionProtocolProcessStatusV1::Running || page.resnapshot_required {
            transaction.execute(
                "UPDATE execution_repl_callback_events SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND generation=?3 AND status='PENDING'",
                params![now_ms().map_err(Failure::error)? as i64, binding.execution_id, binding.generation as i64],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.execute(
                "UPDATE stdio_executions SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND generation=?3 AND status='RUNNING'",
                params![now_ms().map_err(Failure::error)? as i64, binding.execution_id, binding.generation as i64],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Err(Failure::Unknown.error());
        }
        let last_persisted: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(event_sequence),0) FROM execution_repl_callback_events
             WHERE execution_id=?1 AND generation=?2",
            params![binding.execution_id, binding.generation as i64],
            |row| row.get(0),
        ).map_err(|_| Failure::Unavailable.error())?;
        let last_persisted = u64::try_from(last_persisted).map_err(|_| Failure::Unknown.error())?;
        if page.after_event_sequence > last_persisted
            || page.events.first().is_some_and(|event| event.event_sequence > last_persisted.saturating_add(1)
                || (event.event_sequence > last_persisted && page.after_event_sequence != last_persisted))
        {
            transaction.execute(
                "UPDATE execution_repl_callback_events SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND generation=?3 AND status='PENDING'",
                params![now_ms().map_err(Failure::error)? as i64, binding.execution_id, binding.generation as i64],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.execute(
                "UPDATE stdio_executions SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND generation=?3 AND status='RUNNING'",
                params![now_ms().map_err(Failure::error)? as i64, binding.execution_id, binding.generation as i64],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Err(Failure::Unknown.error());
        }
        let now = now_ms().map_err(Failure::error)? as i64;
        for event in &page.events {
            if event.generation != binding.generation { return Err(Failure::Denied.error()); }
            let sequence = i64::try_from(event.event_sequence).map_err(|_| Failure::Invalid.error())?;
            let value = event.to_value();
            let encoded = messagepack::encode(&value, FRAME_LIMITS).map_err(|_| Failure::Invalid.error())?;
            let event_digest = digest_bytes(&encoded);
            let existing = transaction.query_row(
                "SELECT event_digest,event_value,status FROM execution_repl_callback_events
                 WHERE execution_id=?1 AND generation=?2 AND event_sequence=?3",
                params![binding.execution_id, binding.generation as i64, sequence],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?, row.get::<_, String>(2)?)),
            ).optional().map_err(|_| Failure::Unavailable.error())?;
            if let Some((digest, bytes, stored_status)) = existing {
                if digest != event_digest || bytes != encoded {
                    transaction.execute(
                        "UPDATE execution_repl_callback_events SET status='UNKNOWN',updated_at_ms=?1
                         WHERE execution_id=?2 AND generation=?3 AND event_sequence=?4",
                        params![now, binding.execution_id, binding.generation as i64, sequence],
                    ).map_err(|_| Failure::Unavailable.error())?;
                    transaction.execute(
                        "UPDATE stdio_executions SET status='UNKNOWN',updated_at_ms=?1
                         WHERE execution_id=?2 AND generation=?3 AND status='RUNNING'",
                        params![now, binding.execution_id, binding.generation as i64],
                    ).map_err(|_| Failure::Unavailable.error())?;
                    transaction.commit().map_err(|_| Failure::Unavailable.error())?;
                    return Err(Failure::Unknown.error());
                }
                if stored_status == "UNKNOWN" { return Err(Failure::Unknown.error()); }
                continue;
            }
            let inserted = transaction.execute(
                "INSERT INTO execution_repl_callback_events(
                    execution_id,generation,event_sequence,callback_id,event_digest,event_value,status,created_at_ms,updated_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,?6,'PENDING',?7,?7)",
                params![binding.execution_id, binding.generation as i64, sequence,
                    event.callback_id, event_digest, encoded, now],
            ).map_err(|_| Failure::Unavailable.error())?;
            if inserted != 1 { return Err(Failure::Conflict.error()); }
        }
        transaction.commit().map_err(|_| Failure::Unavailable.error())
    }

    /// Return only previously journaled callback frames for the exact running
    /// interpreter. The supervisor supplies its current process state and IO
    /// cursor; EffectHost never fabricates either from callback rows.
    pub(crate) fn read_repl_callback_page(
        &mut self,
        binding: &StdioExecutionBindingV1,
        request: &crate::protocol::ExecutionReplCallbackReadRequestV1,
        process_status: crate::protocol::ExecutionProtocolProcessStatusV1,
        process_io_sequence: u64,
    ) -> Result<crate::protocol::ExecutionReplCallbackReadPageV1, TypedErrorV1> {
        let validated = crate::protocol::ExecutionReplCallbackReadRequestV1::from_value(&request.to_value())
            .ok_or_else(|| Failure::Invalid.error())?;
        if &validated != request || request.host_process_ref != StdioProcessRefV1::from_binding(binding, StdioProcessKindV1::Interpreter)
            .map_err(|_| Failure::Denied.error())?
            || binding.capability_id != guard::REPL_START_ID
            || request.session_id != binding.session_id || request.location_id != binding.location_id
            || request.workspace_revision != binding.workspace_revision
        { return Err(Failure::Denied.error()); }
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let status: String = transaction.query_row(
            "SELECT status FROM stdio_executions WHERE execution_id=?1 AND effect_id=?2
             AND challenge_id=?3 AND principal=?4 AND execution_principal=?5 AND session_id=?6
             AND location_id=?7 AND capability_id=?8 AND owner_epoch=?9 AND generation=?10
             AND workspace_revision=?11 AND profile_id=?12 AND profile_revision=?13
             AND profile_digest=?14 AND executable_digest=?15",
            params![binding.execution_id, binding.effect_id, binding.challenge_id, binding.principal,
                binding.execution_principal, binding.session_id, binding.location_id, binding.capability_id,
                binding.owner_epoch as i64, binding.generation as i64, binding.workspace_revision,
                binding.profile_id, binding.profile_revision as i64, binding.profile_digest, binding.executable_digest],
            |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if status != "RUNNING" || process_status != crate::protocol::ExecutionProtocolProcessStatusV1::Running {
            transaction.execute(
                "UPDATE execution_repl_callback_events SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND generation=?3 AND status='PENDING'",
                params![now_ms().map_err(Failure::error)? as i64, binding.execution_id, binding.generation as i64],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.execute(
                "UPDATE stdio_executions SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND generation=?3 AND status='RUNNING'",
                params![now_ms().map_err(Failure::error)? as i64, binding.execution_id, binding.generation as i64],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Err(Failure::Unknown.error());
        }
        let mut statement = transaction.prepare(
            "SELECT event_sequence,event_value,status FROM execution_repl_callback_events
             WHERE execution_id=?1 AND generation=?2 AND event_sequence>?3
             ORDER BY event_sequence LIMIT ?4",
        ).map_err(|_| Failure::Unavailable.error())?;
        let mut rows = statement.query(params![binding.execution_id, binding.generation as i64,
            request.after_event_sequence as i64, request.max_events as i64])
            .map_err(|_| Failure::Unavailable.error())?;
        let mut events = Vec::new();
        let mut encoded_bytes = 0usize;
        let mut expected = request.after_event_sequence.saturating_add(1);
        let mut gap = false;
        while let Some(row) = rows.next().map_err(|_| Failure::Unavailable.error())? {
            let sequence: i64 = row.get(0).map_err(|_| Failure::Unavailable.error())?;
            let bytes: Vec<u8> = row.get(1).map_err(|_| Failure::Unavailable.error())?;
            let row_status: String = row.get(2).map_err(|_| Failure::Unavailable.error())?;
            if row_status != "PENDING" || u64::try_from(sequence).ok() != Some(expected) {
                gap = true;
                break;
            }
            let value = messagepack::decode(&bytes, FRAME_LIMITS).map_err(|_| Failure::Unknown.error())?;
            let event = crate::protocol::ExecutionReplCallbackEventV1::from_value(&value)
                .ok_or_else(|| Failure::Unknown.error())?;
            if event.generation != binding.generation || event.event_sequence != expected
                || messagepack::encode(&event.to_value(), FRAME_LIMITS).map_err(|_| Failure::Unknown.error())? != bytes
            { gap = true; break; }
            let size = bytes.len();
            if encoded_bytes.saturating_add(size) > request.max_bytes as usize { break; }
            encoded_bytes += size;
            events.push(event);
            expected = expected.saturating_add(1);
        }
        drop(rows);
        drop(statement);
        let next_event_sequence = events.last().map_or(request.after_event_sequence, |event| event.event_sequence);
        if gap {
            transaction.execute(
                "UPDATE execution_repl_callback_events SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND generation=?3 AND status='PENDING'",
                params![now_ms().map_err(Failure::error)? as i64, binding.execution_id, binding.generation as i64],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.execute(
                "UPDATE stdio_executions SET status='UNKNOWN',updated_at_ms=?1
                 WHERE execution_id=?2 AND generation=?3 AND status='RUNNING'",
                params![now_ms().map_err(Failure::error)? as i64, binding.execution_id, binding.generation as i64],
            ).map_err(|_| Failure::Unavailable.error())?;
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Err(Failure::Unknown.error());
        }
        let page = crate::protocol::ExecutionReplCallbackReadPageV1 {
            host_process_ref: request.host_process_ref.clone(),
            after_event_sequence: request.after_event_sequence,
            next_event_sequence,
            process_io_sequence,
            workspace_revision: binding.workspace_revision.clone(),
            status: process_status,
            resnapshot_required: false,
            events,
        };
        crate::protocol::ExecutionReplCallbackReadPageV1::from_value(
            &page.to_value(), request.max_events as usize, request.max_bytes as usize,
        ).ok_or_else(|| Failure::Unknown.error())?;
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(page)
    }

    /// Persist a Guard denial as a decision receipt for one exact retained REPL
    /// callback. This proves only that Guard denied the callback action; it never
    /// proves process execution, dispatch, or settlement.
    pub(crate) fn record_repl_callback_denial(
        &mut self,
        binding: &StdioExecutionBindingV1,
        event_sequence: u64,
        callback_id: &str,
        challenge_id: &str,
        effect_id: &str,
    ) -> Result<String, TypedErrorV1> {
        if event_sequence == 0 || event_sequence > i64::MAX as u64
            || callback_id.is_empty() || callback_id.len() > 128 || !callback_id.is_ascii()
            || !callback_id.as_bytes()[0].is_ascii_alphanumeric()
            || !callback_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
            || validate_identifier(challenge_id).is_err() || validate_identifier(effect_id).is_err()
        { return Err(Failure::Invalid.error()); }
        let _process_ref = StdioProcessRefV1::from_binding(binding, StdioProcessKindV1::Interpreter)
            .map_err(|_| Failure::Denied.error())?;
        if binding.capability_id != guard::REPL_START_ID { return Err(Failure::Denied.error()); }
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let process_status: String = transaction.query_row(
            "SELECT status FROM stdio_executions WHERE execution_id=?1 AND effect_id=?2
             AND challenge_id=?3 AND principal=?4 AND execution_principal=?5 AND session_id=?6
             AND location_id=?7 AND capability_id=?8 AND owner_epoch=?9 AND generation=?10
             AND workspace_revision=?11 AND profile_id=?12 AND profile_revision=?13
             AND profile_digest=?14 AND executable_digest=?15",
            params![binding.execution_id, binding.effect_id, binding.challenge_id, binding.principal,
                binding.execution_principal, binding.session_id, binding.location_id, binding.capability_id,
                binding.owner_epoch as i64, binding.generation as i64, binding.workspace_revision,
                binding.profile_id, binding.profile_revision as i64, binding.profile_digest, binding.executable_digest],
            |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if process_status != "RUNNING" { return Err(Failure::Unknown.error()); }
        let event: (String, String, String, Vec<u8>) = transaction.query_row(
            "SELECT status,event_digest,callback_id,event_value FROM execution_repl_callback_events
             WHERE execution_id=?1 AND generation=?2 AND event_sequence=?3",
            params![binding.execution_id, binding.generation as i64, event_sequence as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::Unknown.error())?;
        if !matches!(event.0.as_str(), "PENDING" | "REPLIED") { return Err(Failure::Unknown.error()); }
        let event_value = messagepack::decode(&event.3, FRAME_LIMITS).map_err(|_| Failure::Unknown.error())?;
        let event_dto = crate::protocol::ExecutionReplCallbackEventV1::from_value(&event_value)
            .ok_or_else(|| Failure::Unknown.error())?;
        let canonical_event = messagepack::encode(&event_dto.to_value(), FRAME_LIMITS)
            .map_err(|_| Failure::Unknown.error())?;
        if event.2 != callback_id || event_dto.callback_id != callback_id
            || event_dto.generation != binding.generation || canonical_event != event.3
            || digest_bytes(&canonical_event) != event.1
        { return Err(Failure::Conflict.error()); }
        let callback_arguments_digest = digest_bytes(
            &messagepack::encode(&event_dto.arguments, FRAME_LIMITS).map_err(|_| Failure::Invalid.error())?
        );
        let challenge: (String, Option<i64>, Option<String>, Option<String>, String, String,
            String, Option<String>, String) = transaction.query_row(
            "SELECT status,approved,capability_lease_digest,receipt_digest,principal,session_id,
                    capability_id,managed_attempt_digest,argument_digest
             FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2",
            params![challenge_id, effect_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if challenge.0 != "DENIED" || challenge.1 != Some(0) || challenge.2.is_some()
            || challenge.3.is_some() || challenge.4 != binding.principal
            || challenge.5 != binding.session_id || challenge.6 != event_dto.capability_id
            || challenge.7 != binding.attempt_scope_digest
        { return Err(Failure::Denied.error()); }
        let denial_receipt_digest = repl_callback_denial_receipt_digest(
            &binding.execution_id, binding.generation, event_sequence, callback_id,
            &event_dto.capability_id, challenge_id, effect_id, &event.1,
            &callback_arguments_digest, &challenge.8, &binding.principal,
            &binding.execution_principal, &binding.session_id, &binding.location_id,
            binding.owner_epoch, binding.attempt_scope_digest.as_deref(),
            &binding.workspace_revision,
        );
        let existing: Option<(String, String, String, String, String, String, String, String, i64, Option<String>)> = transaction.query_row(
            "SELECT denial_receipt_digest,event_digest,callback_arguments_digest,challenge_arguments_digest,
                    callback_id,capability_id,effect_id,principal,owner_epoch,attempt_scope_digest
             FROM execution_repl_callback_denials WHERE challenge_id=?1",
            [challenge_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
                row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        if let Some((receipt, event_digest, args_digest, challenge_args, stored_callback,
            stored_capability, stored_effect, principal, owner_epoch, scope_digest)) = existing
        {
            if receipt != denial_receipt_digest || event_digest != event.1
                || args_digest != callback_arguments_digest || challenge_args != challenge.8
                || stored_callback != callback_id || stored_capability != event_dto.capability_id
                || stored_effect != effect_id || principal != binding.principal
                || owner_epoch != binding.owner_epoch as i64 || scope_digest != binding.attempt_scope_digest
            { return Err(Failure::Conflict.error()); }
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(receipt);
        }
        if event.0 != "PENDING" { return Err(Failure::Unknown.error()); }
        let now = now_ms().map_err(Failure::error)? as i64;
        transaction.execute(
            "INSERT INTO execution_repl_callback_denials(
                challenge_id,execution_id,generation,event_sequence,callback_id,capability_id,effect_id,
                event_digest,callback_arguments_digest,challenge_arguments_digest,principal,
                execution_principal,session_id,location_id,owner_epoch,attempt_scope_digest,
                workspace_revision,denial_receipt_digest,created_at_ms
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            params![challenge_id, binding.execution_id, binding.generation as i64, event_sequence as i64,
                callback_id, event_dto.capability_id, effect_id, event.1, callback_arguments_digest,
                challenge.8, binding.principal, binding.execution_principal, binding.session_id,
                binding.location_id, binding.owner_epoch as i64, binding.attempt_scope_digest,
                binding.workspace_revision, denial_receipt_digest, now],
        ).map_err(|_| Failure::Conflict.error())?;
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(denial_receipt_digest)
    }

    /// Creates the durable pre-dispatch fence for one callback result. A repeat
    /// of an already-dispatching result is UNKNOWN and must never write twice.
    pub(crate) fn begin_repl_callback_reply(
        &mut self,
        binding: &StdioExecutionBindingV1,
        request: &crate::protocol::ExecutionReplCallbackReplyRequestV1,
    ) -> Result<ReplCallbackReplyBeginV1, TypedErrorV1> {
        let validated = crate::protocol::ExecutionReplCallbackReplyRequestV1::from_value(&request.to_value())
            .ok_or_else(|| Failure::Invalid.error())?;
        if &validated != request { return Err(Failure::Invalid.error()); }
        if request.event_sequence > i64::MAX as u64 || request.request_sequence > i64::MAX as u64 {
            return Err(Failure::Invalid.error());
        }
        let process_ref = StdioProcessRefV1::from_binding(binding, StdioProcessKindV1::Interpreter)
            .map_err(|_| Failure::Denied.error())?;
        if binding.capability_id != guard::REPL_START_ID || request.host_process_ref != process_ref
            || request.session_id != binding.session_id || request.location_id != binding.location_id
            || request.workspace_revision != binding.workspace_revision
            || request.operation_digest != request.compute_operation_digest().map_err(|_| Failure::Invalid.error())?
        { return Err(Failure::Denied.error()); }
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let process_status: String = transaction.query_row(
            "SELECT status FROM stdio_executions WHERE execution_id=?1 AND effect_id=?2
             AND challenge_id=?3 AND principal=?4 AND execution_principal=?5 AND session_id=?6
             AND location_id=?7 AND capability_id=?8 AND owner_epoch=?9 AND generation=?10
             AND workspace_revision=?11 AND profile_id=?12 AND profile_revision=?13
             AND profile_digest=?14 AND executable_digest=?15",
            params![binding.execution_id, binding.effect_id, binding.challenge_id, binding.principal,
                binding.execution_principal, binding.session_id, binding.location_id, binding.capability_id,
                binding.owner_epoch as i64, binding.generation as i64, binding.workspace_revision,
                binding.profile_id, binding.profile_revision as i64, binding.profile_digest, binding.executable_digest],
            |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if process_status != "RUNNING" { return Err(Failure::Unknown.error()); }
        let event: (String, String, String, Vec<u8>) = transaction.query_row(
            "SELECT status,callback_id,event_digest,event_value FROM execution_repl_callback_events
             WHERE execution_id=?1 AND generation=?2 AND event_sequence=?3",
            params![binding.execution_id, binding.generation as i64, request.event_sequence as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        let event_value = messagepack::decode(&event.3, FRAME_LIMITS).map_err(|_| Failure::Unknown.error())?;
        let event_dto = crate::protocol::ExecutionReplCallbackEventV1::from_value(&event_value)
            .ok_or_else(|| Failure::Unknown.error())?;
        let canonical_event = messagepack::encode(&event_dto.to_value(), FRAME_LIMITS)
            .map_err(|_| Failure::Unknown.error())?;
        if !matches!(event.0.as_str(), "PENDING" | "REPLIED") || event.1 != request.callback_id
            || event_dto.callback_id != request.callback_id
            || event_dto.capability_id != request.capability_id
            || event_dto.generation != binding.generation || canonical_event != event.3
            || digest_bytes(&canonical_event) != event.2
        { return Err(Failure::Unknown.error()); }
        let challenge: (String, String, Option<String>, Option<String>, String, String, Option<String>) = transaction.query_row(
            "SELECT status,capability_id,capability_lease_digest,receipt_digest,principal,argument_digest,managed_attempt_digest
             FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2 AND session_id=?3
               AND capability_id=?4",
            params![request.challenge_id, request.effect_id, binding.session_id, request.capability_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if challenge.4 != binding.principal || challenge.6 != binding.attempt_scope_digest {
            return Err(Failure::Denied.error());
        }
        if request.result.status == "denied" {
            if request.capability_lease_digest.is_some() || challenge.0 != "DENIED"
                || challenge.2.is_some() || challenge.3.is_some()
            { return Err(Failure::Denied.error()); }
            let denial: Option<(String, String, i64, String, String, String, String, String,
                String, String, String, String, i64, Option<String>, String)> = transaction.query_row(
                "SELECT denial_receipt_digest,event_digest,event_sequence,callback_id,capability_id,effect_id,
                        callback_arguments_digest,challenge_arguments_digest,principal,execution_principal,
                        session_id,location_id,owner_epoch,attempt_scope_digest,workspace_revision
                 FROM execution_repl_callback_denials WHERE challenge_id=?1 AND execution_id=?2 AND generation=?3",
                params![request.challenge_id, binding.execution_id, binding.generation as i64],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
                    row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?,
                    row.get(12)?, row.get(13)?, row.get(14)?)),
            ).optional().map_err(|_| Failure::Unavailable.error())?;
            let Some((receipt, event_digest, sequence, callback, capability, effect, args_digest,
                challenge_args, principal, execution_principal, session, location, owner_epoch, scope, workspace)) = denial
            else { return Err(Failure::Denied.error()); };
            let callback_args_digest = digest_bytes(&messagepack::encode(&event_dto.arguments, FRAME_LIMITS)
                .map_err(|_| Failure::Invalid.error())?);
            let recomputed_denial_receipt = repl_callback_denial_receipt_digest(
                &binding.execution_id, binding.generation, request.event_sequence, &request.callback_id,
                &request.capability_id, &request.challenge_id, &request.effect_id, &event.2,
                &callback_args_digest, &challenge.5, &binding.principal, &binding.execution_principal,
                &binding.session_id, &binding.location_id, binding.owner_epoch,
                binding.attempt_scope_digest.as_deref(), &binding.workspace_revision,
            );
            if receipt != request.effect_receipt_digest || event_digest != event.2
                || sequence != request.event_sequence as i64 || callback != request.callback_id
                || capability != request.capability_id || effect != request.effect_id
                || args_digest != callback_args_digest || challenge_args != challenge.5
                || principal != binding.principal || execution_principal != binding.execution_principal
                || session != binding.session_id
                || location != binding.location_id || owner_epoch != binding.owner_epoch as i64
                || scope != binding.attempt_scope_digest || workspace != binding.workspace_revision
                || receipt != recomputed_denial_receipt
            { return Err(Failure::Denied.error()); }
        } else if challenge.3.as_deref() != Some(request.effect_receipt_digest.as_str())
            || challenge.2.as_deref() != request.capability_lease_digest.as_deref()
            || challenge.0 != "SETTLED"
        { return Err(Failure::Denied.error()); }
        let result_value = request.result.to_value();
        let result_digest = digest_bytes(&messagepack::encode(&result_value, FRAME_LIMITS).map_err(|_| Failure::Invalid.error())?);
        let encoded = messagepack::encode(&request.to_value(), FRAME_LIMITS).map_err(|_| Failure::Invalid.error())?;
        let now = now_ms().map_err(Failure::error)? as i64;
        let existing: Option<(String, String, Option<String>, Option<String>)> = transaction.query_row(
            "SELECT operation_digest,status,dispatch_receipt_digest,effect_receipt_digest
             FROM execution_repl_callback_replies WHERE execution_id=?1 AND generation=?2 AND event_sequence=?3",
            params![binding.execution_id, binding.generation as i64, request.event_sequence as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        if let Some((digest, status, receipt, _)) = existing {
            if digest != request.operation_digest { return Err(Failure::Conflict.error()); }
            if status == "DISPATCHED" {
                let receipt = receipt.ok_or_else(|| Failure::Unknown.error())?;
                let stored = repl_callback_reply_receipt(binding, request, &receipt)
                    .map_err(|_| Failure::Invalid.error())?;
                transaction.commit().map_err(|_| Failure::Unavailable.error())?;
                return Ok(ReplCallbackReplyBeginV1::AlreadyDispatched(stored));
            }
            return Err(Failure::Unknown.error());
        }
        if event.0 != "PENDING" { return Err(Failure::Unknown.error()); }
        transaction.execute(
            "INSERT INTO execution_repl_callback_replies(
                execution_id,generation,event_sequence,request_sequence,callback_id,operation_digest,
                capability_id,effect_id,challenge_id,capability_lease_digest,effect_receipt_digest,
                result_digest,status,reply_value,created_at_ms,updated_at_ms
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'DISPATCHING',?13,?14,?14)",
            params![binding.execution_id, binding.generation as i64, request.event_sequence as i64,
                request.request_sequence as i64, request.callback_id, request.operation_digest,
                request.capability_id, request.effect_id, request.challenge_id, request.capability_lease_digest,
                request.effect_receipt_digest, result_digest, encoded, now],
        ).map_err(|_| Failure::Conflict.error())?;
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(ReplCallbackReplyBeginV1::Dispatch)
    }

    pub(crate) fn settle_repl_callback_reply(
        &mut self,
        binding: &StdioExecutionBindingV1,
        request: &crate::protocol::ExecutionReplCallbackReplyRequestV1,
        observed_io_sequence: u64,
    ) -> Result<crate::protocol::ExecutionReplCallbackReplyReceiptV1, TypedErrorV1> {
        let validated = crate::protocol::ExecutionReplCallbackReplyRequestV1::from_value(&request.to_value())
            .ok_or_else(|| Failure::Invalid.error())?;
        if &validated != request { return Err(Failure::Invalid.error()); }
        if observed_io_sequence == 0 { return Err(Failure::Invalid.error()); }
        let process_ref = StdioProcessRefV1::from_binding(binding, StdioProcessKindV1::Interpreter)
            .map_err(|_| Failure::Denied.error())?;
        if request.host_process_ref != process_ref || request.operation_digest
            != request.compute_operation_digest().map_err(|_| Failure::Invalid.error())?
        { return Err(Failure::Denied.error()); }
        let dispatch_receipt_digest = repl_callback_dispatch_receipt_digest(
            binding.execution_id.as_str(), binding.generation, request.event_sequence,
            request.request_sequence, &request.operation_digest, observed_io_sequence,
        );
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let process_status: String = transaction.query_row(
            "SELECT status FROM stdio_executions WHERE execution_id=?1 AND effect_id=?2
             AND challenge_id=?3 AND principal=?4 AND execution_principal=?5 AND session_id=?6
             AND location_id=?7 AND capability_id=?8 AND owner_epoch=?9 AND generation=?10
             AND workspace_revision=?11 AND profile_id=?12 AND profile_revision=?13
             AND profile_digest=?14 AND executable_digest=?15",
            params![binding.execution_id, binding.effect_id, binding.challenge_id, binding.principal,
                binding.execution_principal, binding.session_id, binding.location_id, binding.capability_id,
                binding.owner_epoch as i64, binding.generation as i64, binding.workspace_revision,
                binding.profile_id, binding.profile_revision as i64, binding.profile_digest, binding.executable_digest],
            |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        if process_status != "RUNNING" { return Err(Failure::Unknown.error()); }
        let row: Option<(String, String, Option<String>)> = transaction.query_row(
            "SELECT operation_digest,status,dispatch_receipt_digest FROM execution_repl_callback_replies
             WHERE execution_id=?1 AND generation=?2 AND event_sequence=?3",
            params![binding.execution_id, binding.generation as i64, request.event_sequence as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        let Some((operation_digest, status, prior_receipt)) = row else { return Err(Failure::NotFound.error()); };
        if operation_digest != request.operation_digest { return Err(Failure::Conflict.error()); }
        if status == "DISPATCHED" {
            if prior_receipt.as_deref() != Some(dispatch_receipt_digest.as_str()) { return Err(Failure::Conflict.error()); }
            let receipt = repl_callback_reply_receipt(binding, request, &dispatch_receipt_digest)
                .map_err(|_| Failure::Invalid.error())?;
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(receipt);
        }
        if status != "DISPATCHING" { return Err(Failure::Unknown.error()); }
        let now = now_ms().map_err(Failure::error)? as i64;
        let changed = transaction.execute(
            "UPDATE execution_repl_callback_replies SET status='DISPATCHED',dispatch_receipt_digest=?1,updated_at_ms=?2
             WHERE execution_id=?3 AND generation=?4 AND event_sequence=?5 AND operation_digest=?6 AND status='DISPATCHING'",
            params![dispatch_receipt_digest, now, binding.execution_id, binding.generation as i64,
                request.event_sequence as i64, request.operation_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Unknown.error()); }
        let changed_event = transaction.execute(
            "UPDATE execution_repl_callback_events SET status='REPLIED',updated_at_ms=?1
             WHERE execution_id=?2 AND generation=?3 AND event_sequence=?4 AND callback_id=?5 AND status='PENDING'",
            params![now, binding.execution_id, binding.generation as i64, request.event_sequence as i64, request.callback_id],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed_event != 1 { return Err(Failure::Unknown.error()); }
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        repl_callback_reply_receipt(binding, request, &dispatch_receipt_digest)
            .map_err(|_| Failure::Invalid.error())
    }

    pub(crate) fn mark_repl_callback_reply_unknown(
        &mut self,
        binding: &StdioExecutionBindingV1,
        request: &crate::protocol::ExecutionReplCallbackReplyRequestV1,
    ) -> Result<(), TypedErrorV1> {
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let now = now_ms().map_err(Failure::error)? as i64;
        let changed = transaction.execute(
            "UPDATE execution_repl_callback_replies SET status='UNKNOWN',updated_at_ms=?1
             WHERE execution_id=?2 AND generation=?3 AND event_sequence=?4 AND operation_digest=?5
               AND status IN ('DISPATCHING','UNKNOWN')",
            params![now, binding.execution_id, binding.generation as i64, request.event_sequence as i64, request.operation_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        transaction.execute(
            "UPDATE execution_repl_callback_events SET status='UNKNOWN',updated_at_ms=?1
             WHERE execution_id=?2 AND generation=?3 AND event_sequence=?4 AND status IN ('PENDING','UNKNOWN')",
            params![now, binding.execution_id, binding.generation as i64, request.event_sequence as i64],
        ).map_err(|_| Failure::Unavailable.error())?;
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        Ok(())
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
                    self.prepare_tool_batch(
                        process_session_id,
                        principal,
                        &request.body,
                        request.deadline_unix_ms,
                    )
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

    /// Resolve the exact complete managed ToolBatch effect set from the durable
    /// Guard journal after HostKernel restart. This cannot issue a challenge,
    /// consume a lease or retry an operation. For terminal pre-dispatch decisions
    /// it creates an idempotent content-addressed classification receipt in the
    /// same EffectHost database if one has not already been recorded.
    pub(crate) fn recover_managed_attempt_effect_receipts(
        &self,
        principal: &str,
        session_id: &str,
        pins: &[ManagedAttemptEffectReceiptPinV1],
    ) -> Result<Vec<ManagedAttemptEffectReceiptV1>, TypedErrorV1> {
        validate_identifier(principal).map_err(Failure::error)?;
        validate_identifier(session_id).map_err(Failure::error)?;
        if pins.is_empty() || pins.len() > MAX_TOOL_BATCH_CALLS {
            return Err(Failure::Invalid.error());
        }
        let batch_id = pins[0].batch_id.as_str();
        let mut unique_effects = HashSet::with_capacity(pins.len());
        let mut unique_calls = HashSet::with_capacity(pins.len());
        let mut receipts = Vec::with_capacity(pins.len());
        for (expected_index, pin) in pins.iter().enumerate() {
            for id in [&pin.batch_id, &pin.call_id, &pin.effect_id] {
                validate_identifier(id).map_err(Failure::error)?;
            }
            if pin.batch_id != batch_id
                || pin.call_index as usize != expected_index
                || !is_blake3_digest(&pin.attempt_scope_digest)
                || !unique_effects.insert(pin.effect_id.as_str())
                || !unique_calls.insert(pin.call_id.as_str())
            {
                return Err(Failure::Invalid.error());
            }
            let row: Option<(String,String,String,Option<String>,String,Option<String>,Option<String>,String,String,String)> = self.connection.query_row(
                "SELECT challenge_id,capability_id,origin_kind,managed_attempt_digest,status,
                        capability_lease_digest,receipt_digest,arguments_digest,
                        admitted_intent_digest,turn_context_digest
                 FROM effect_challenges
                 WHERE batch_id=?1 AND call_index=?2 AND call_id=?3 AND effect_id=?4
                   AND session_id=?5 AND principal=?6",
                params![pin.batch_id,pin.call_index as i64,pin.call_id,pin.effect_id,session_id,principal],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,
                    row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?)),
            ).optional().map_err(|_| Failure::Unavailable.error())?;
            let Some((challenge_id,capability_id,origin_kind,scope_digest,status,lease_digest,
                effect_receipt_digest,arguments_digest,intent_digest,turn_context_digest)) = row else {
                return Err(Failure::Unknown.error());
            };
            if origin_kind != "managed_run"
                || scope_digest.as_deref() != Some(pin.attempt_scope_digest.as_str())
            {
                return Err(Failure::Denied.error());
            }
            if effect_receipt_digest.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
                || lease_digest.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
                || !is_blake3_digest(&arguments_digest) || !is_blake3_digest(&intent_digest)
                || !is_blake3_digest(&turn_context_digest)
            {
                return Err(Failure::Unknown.error());
            }
            let (receipt_kind, receipt_digest) = if status == "SETTLED" {
                ("effect", effect_receipt_digest.clone().ok_or_else(|| Failure::Unknown.error())?)
            } else if matches!(status.as_str(), "NOT_APPLIED" | "DENIED" | "EXPIRED" | "CANCELLED" | "UNKNOWN") {
                let receipt = managed_effect_decision_receipt_digest(
                    pin, &challenge_id, &capability_id, &status, lease_digest.as_deref(),
                    effect_receipt_digest.as_deref(), &arguments_digest, &intent_digest,
                    &turn_context_digest,
                )?;
                let now = now_ms().map_err(Failure::error)? as i64;
                self.connection.execute(
                    "INSERT OR IGNORE INTO effect_decision_receipts(
                        effect_id,status,challenge_id,batch_id,call_index,call_id,principal,
                        session_id,attempt_scope_digest,receipt_digest,created_at_ms
                     ) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
                     WHERE EXISTS (SELECT 1 FROM effect_challenges
                       WHERE challenge_id=?3 AND effect_id=?1 AND batch_id=?4
                         AND call_index=?5 AND call_id=?6 AND principal=?7 AND session_id=?8
                         AND managed_attempt_digest=?9 AND status=?2)",
                    params![pin.effect_id,status,challenge_id,pin.batch_id,pin.call_index as i64,
                        pin.call_id,principal,session_id,pin.attempt_scope_digest,receipt,now],
                ).map_err(|_| Failure::Unavailable.error())?;
                let durable: (String,String,i64,String,String,String,String,String) = self.connection.query_row(
                    "SELECT challenge_id,batch_id,call_index,call_id,principal,session_id,
                            attempt_scope_digest,receipt_digest
                     FROM effect_decision_receipts WHERE effect_id=?1 AND status=?2",
                    params![pin.effect_id,status],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,
                        row.get(5)?,row.get(6)?,row.get(7)?)),
                ).optional().map_err(|_| Failure::Unavailable.error())?
                    .ok_or_else(|| Failure::Conflict.error())?;
                if durable.0 != challenge_id || durable.1 != pin.batch_id
                    || durable.2 != pin.call_index as i64 || durable.3 != pin.call_id
                    || durable.4 != principal || durable.5 != session_id
                    || durable.6 != pin.attempt_scope_digest || durable.7 != receipt
                { return Err(Failure::Conflict.error()); }
                ("decision", receipt)
            } else {
                return Err(Failure::Unknown.error());
            };
            receipts.push(ManagedAttemptEffectReceiptV1 {
                batch_id: pin.batch_id.clone(),
                call_index: pin.call_index,
                call_id: pin.call_id.clone(),
                effect_id: pin.effect_id.clone(),
                challenge_id,
                capability_id,
                attempt_scope_digest: pin.attempt_scope_digest.clone(),
                status,
                capability_lease_digest: lease_digest,
                receipt_kind: receipt_kind.to_owned(),
                receipt_digest,
            });
        }
        let batch_count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM effect_challenges
             WHERE batch_id=?1 AND session_id=?2 AND principal=?3 AND origin_kind='managed_run'",
            params![batch_id,session_id,principal], |row| row.get(0),
        ).map_err(|_| Failure::Unavailable.error())?;
        if batch_count != pins.len() as i64 {
            return Err(Failure::Conflict.error());
        }
        Ok(receipts)
    }

    /// Resolve a terminal artifact only through the exact settled direct-Attempt
    /// ToolBatch edge. HostKernel must separately prove the authenticated source
    /// request/tool-call association and ArtifactStore owner metadata; this method
    /// never reads bytes or treats an ArtifactRef supplied by the caller as authority.
    pub(crate) fn recover_direct_attempt_terminal_artifact_receipt(
        &self,
        principal: &str,
        session_id: &str,
        scope: &crate::protocol::DirectAttemptScopeV1,
        batch_id: &str,
        call_index: u8,
        call_id: &str,
        effect_id: &str,
        expected_artifact: &ArtifactRefV1,
    ) -> Result<DirectAttemptTerminalArtifactReceiptV1, TypedErrorV1> {
        for value in [principal,session_id,batch_id,call_id,effect_id] {
            validate_identifier(value).map_err(Failure::error)?;
        }
        if scope.child_session_id != session_id || call_index as usize >= MAX_TOOL_BATCH_CALLS
            || validate_identifier(&scope.attempt_id).is_err()
            || !is_blake3_digest(&expected_artifact.digest)
            || validate_identifier(&expected_artifact.artifact_id).is_err()
        { return Err(Failure::Invalid.error()); }
        let scope_digest = EffectAttemptScopeV1::Direct(scope.clone())
            .digest().map_err(|_|Failure::Invalid.error())?;
        let row: Option<(String,String,String,String,String,String,Vec<u8>,String,String,String,String)> = self.connection.query_row(
            "SELECT c.challenge_id,c.batch_id,c.call_id,c.effect_id,c.managed_attempt_digest,
                    c.receipt_digest,t.artifact_ref_v1,t.artifact_fidelity,t.output_digest,
                    t.observed_bytes,t.dropped_bytes
             FROM effect_challenges c JOIN terminal_runs t ON t.effect_id=c.effect_id
             WHERE c.principal=?1 AND c.session_id=?2 AND c.batch_id=?3 AND c.call_index=?4
               AND c.call_id=?5 AND c.effect_id=?6 AND c.capability_id=?7
               AND c.origin_kind='session_batch' AND c.status='SETTLED' AND t.status='SETTLED'
               AND c.managed_attempt_digest=?8",
            params![principal,session_id,batch_id,call_index as i64,call_id,effect_id,
                guard::TERMINAL_RUN_ID,scope_digest],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((challenge_id,stored_batch,stored_call,stored_effect,stored_scope,receipt_digest,
            artifact_bytes,fidelity,output_digest,observed_bytes,dropped_bytes))=row else {
            return Err(Failure::Unknown.error());
        };
        let artifact_value = messagepack::decode(&artifact_bytes,FRAME_LIMITS)
            .map_err(|_|Failure::Unknown.error())?;
        let artifact_ref = terminal_artifact_ref_from_value(artifact_value)
            .ok_or_else(||Failure::Unknown.error())?;
        if stored_batch != batch_id || stored_call != call_id || stored_effect != effect_id
            || stored_scope != scope_digest || artifact_ref != *expected_artifact
            || !is_blake3_digest(&receipt_digest) || !is_blake3_digest(&output_digest)
            || !matches!(fidelity.as_str(),"FULL"|"SAMPLE")
            || !canonical_u64(&observed_bytes)
            || !canonical_u64(&dropped_bytes)
        { return Err(Failure::Conflict.error()); }
        let challenge_receipt: Option<String> = self.connection.query_row(
            "SELECT receipt_digest FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2 AND status='SETTLED'",
            params![challenge_id,effect_id],|row|row.get(0),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        if challenge_receipt.as_deref() != Some(receipt_digest.as_str()) {
            return Err(Failure::Unknown.error());
        }
        Ok(DirectAttemptTerminalArtifactReceiptV1 {
            batch_id:stored_batch,call_index,call_id:stored_call,effect_id:stored_effect,
            challenge_id,attempt_scope_digest:stored_scope,receipt_digest,output_digest,
            artifact_ref,artifact_fidelity:fidelity,observed_bytes,dropped_bytes,
        })
    }

    /// HostKernel-trusted selector for the settled direct terminal artifact. It
    /// derives the batch/call/index from the journal's unique effect row so Core or
    /// a caller cannot choose (or equivocate about) the producer call identity.
    pub(crate) fn recover_direct_attempt_terminal_artifact_by_effect(
        &self,
        principal: &str,
        session_id: &str,
        scope: &crate::protocol::DirectAttemptScopeV1,
        effect_id: &str,
    ) -> Result<DirectAttemptTerminalArtifactReceiptV1, TypedErrorV1> {
        for value in [principal,session_id,effect_id] {
            validate_identifier(value).map_err(Failure::error)?;
        }
        if scope.child_session_id != session_id || validate_identifier(&scope.attempt_id).is_err() {
            return Err(Failure::Invalid.error());
        }
        let scope_digest = EffectAttemptScopeV1::Direct(scope.clone())
            .digest().map_err(|_|Failure::Invalid.error())?;
        let edge: Option<(String,i64,String)> = self.connection.query_row(
            "SELECT batch_id,call_index,call_id FROM effect_challenges
             WHERE principal=?1 AND session_id=?2 AND effect_id=?3 AND capability_id=?4
               AND origin_kind='session_batch' AND status='SETTLED' AND managed_attempt_digest=?5",
            params![principal,session_id,effect_id,guard::TERMINAL_RUN_ID,scope_digest],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((batch_id,index,call_id))=edge else { return Err(Failure::Unknown.error()); };
        let artifact_bytes: Vec<u8> = self.connection.query_row(
            "SELECT artifact_ref_v1 FROM terminal_runs WHERE effect_id=?1 AND status='SETTLED'",
            [effect_id],|row|row.get(0),
        ).optional().map_err(|_|Failure::Unavailable.error())?.ok_or_else(||Failure::Unknown.error())?;
        let expected = terminal_artifact_ref_from_value(
            messagepack::decode(&artifact_bytes,FRAME_LIMITS).map_err(|_|Failure::Unknown.error())?,
        ).ok_or_else(||Failure::Unknown.error())?;
        self.recover_direct_attempt_terminal_artifact_receipt(
            principal,session_id,scope,&batch_id,
            u8::try_from(index).map_err(|_|Failure::Unknown.error())?,
            &call_id,effect_id,&expected,
        )
    }

    /// Project terminal artifacts in authenticated DirectAttempt effect order.
    /// `effect_ids` must come from HostKernel's durable DirectAttemptControl, never
    /// request JSON. Non-terminal capabilities are skipped; missing or ambiguous
    /// effect rows and uncertain terminal.run outcomes fail the whole projection.
    pub(crate) fn list_direct_attempt_terminal_artifact_receipts(
        &self,
        principal: &str,
        session_id: &str,
        scope: &crate::protocol::DirectAttemptScopeV1,
        effect_ids: &[String],
    ) -> Result<Vec<DirectAttemptTerminalArtifactReceiptV1>, TypedErrorV1> {
        validate_identifier(principal).map_err(Failure::error)?;
        validate_identifier(session_id).map_err(Failure::error)?;
        if scope.child_session_id != session_id || effect_ids.len() > crate::protocol::MAX_DIRECT_ATTEMPT_EFFECTS {
            return Err(Failure::Invalid.error());
        }
        let scope_digest = EffectAttemptScopeV1::Direct(scope.clone())
            .digest().map_err(|_|Failure::Invalid.error())?;
        let mut seen = HashSet::with_capacity(effect_ids.len());
        let mut output = Vec::new();
        for effect_id in effect_ids {
            validate_identifier(effect_id).map_err(Failure::error)?;
            if !seen.insert(effect_id.as_str()) { return Err(Failure::Conflict.error()); }
            let rows: Vec<(String,String,String)> = {
                let mut statement = self.connection.prepare(
                    "SELECT capability_id,status,managed_attempt_digest FROM effect_challenges
                     WHERE effect_id=?1 AND session_id=?2 AND principal=?3",
                ).map_err(|_|Failure::Unavailable.error())?;
                let rows = statement.query_map(params![effect_id,session_id,principal],|row|
                    Ok((row.get(0)?,row.get(1)?,row.get(2)?)))
                    .map_err(|_|Failure::Unavailable.error())?;
                rows.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable.error())?
            };
            if rows.len() != 1 { return Err(Failure::Unknown.error()); }
            let (capability,status,stored_scope) = &rows[0];
            if stored_scope.as_str() != scope_digest { return Err(Failure::Conflict.error()); }
            if capability != guard::TERMINAL_RUN_ID { continue; }
            if status != "SETTLED" { return Err(Failure::Unknown.error()); }
            output.push(self.recover_direct_attempt_terminal_artifact_by_effect(
                principal,session_id,scope,effect_id,
            )?);
        }
        Ok(output)
    }

    /// Resolve terminal artifacts from the authenticated root DirectSession batch
    /// journal. Batch/call/artifact identities are derived only from EffectHost's
    /// durable rows; `effect_ids` must be the exact committed ordered list supplied
    /// by HostKernel. Owner epoch is independently checked against HostKernel's
    /// authenticated session journal because direct-session terminal rows do not
    /// carry a managed Attempt epoch.
    pub(crate) fn list_direct_session_terminal_artifact_receipts(
        &self,
        principal: &str,
        session_id: &str,
        owner_epoch: u64,
        batch_id: &str,
        effect_ids: &[String],
    ) -> Result<Vec<DirectSessionTerminalArtifactReceiptV1>, TypedErrorV1> {
        for value in [principal, session_id, batch_id] {
            validate_identifier(value).map_err(Failure::error)?;
        }
        if owner_epoch == 0 || effect_ids.is_empty() || effect_ids.len() > MAX_TOOL_BATCH_CALLS {
            return Err(Failure::Invalid.error());
        }
        let batch_members: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM effect_challenges WHERE principal=?1 AND session_id=?2
             AND batch_id=?3 AND origin_kind='session_batch'",
            params![principal,session_id,batch_id],|r|r.get(0),
        ).map_err(|_|Failure::Unavailable.error())?;
        if batch_members != effect_ids.len() as i64 { return Err(Failure::Conflict.error()); }
        let mut seen = HashSet::with_capacity(effect_ids.len());
        let mut output = Vec::new();
        for (expected_index,effect_id) in effect_ids.iter().enumerate() {
            validate_identifier(effect_id).map_err(Failure::error)?;
            if !seen.insert(effect_id.as_str()) { return Err(Failure::Conflict.error()); }
            let row: Option<(String,String,Option<i64>,String,Option<String>,String,String)> = self.connection.query_row(
                "SELECT capability_id,status,call_index,batch_id,managed_attempt_digest,call_id,origin_kind
                 FROM effect_challenges WHERE effect_id=?1 AND session_id=?2 AND principal=?3",
                params![effect_id,session_id,principal],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
            ).optional().map_err(|_|Failure::Unavailable.error())?;
            let Some((capability,status,index,stored_batch,attempt_digest,call_id,origin)) = row else {
                return Err(Failure::Unknown.error());
            };
            let Some(index) = index else { return Err(Failure::Unknown.error()); };
            if origin != "session_batch" || stored_batch != batch_id || attempt_digest.is_some()
                || index != expected_index as i64 || index as usize >= MAX_TOOL_BATCH_CALLS
            { return Err(Failure::Conflict.error()); }
            if !matches!(status.as_str(),"SETTLED"|"DENIED"|"EXPIRED"|"CANCELLED"|"NOT_APPLIED") {
                return Err(Failure::Unknown.error());
            }
            if capability != guard::TERMINAL_RUN_ID { continue; }
            if index < 0 || status != "SETTLED"
            { return Err(Failure::Unknown.error()); }
            output.push(self.recover_direct_session_terminal_artifact_by_effect(
                principal,session_id,owner_epoch,batch_id,index as u8,&call_id,effect_id,
            )?);
        }
        Ok(output)
    }

    fn recover_direct_session_terminal_artifact_by_effect(
        &self,
        principal: &str,
        session_id: &str,
        owner_epoch: u64,
        batch_id: &str,
        call_index: u8,
        call_id: &str,
        effect_id: &str,
    ) -> Result<DirectSessionTerminalArtifactReceiptV1, TypedErrorV1> {
        let row: Option<(String,String,String,i64,Vec<u8>,String,String,String,String)> = self.connection.query_row(
            "SELECT c.challenge_id,c.receipt_digest,p.workspace_revision,p.owner_epoch,
                    t.artifact_ref_v1,t.artifact_fidelity,t.output_digest,t.observed_bytes,t.dropped_bytes
             FROM effect_challenges c JOIN terminal_runs t ON t.effect_id=c.effect_id
             JOIN terminal_consent_preflights p ON p.challenge_id=c.challenge_id AND p.effect_id=c.effect_id
             WHERE c.principal=?1 AND c.session_id=?2 AND c.batch_id=?3 AND c.call_index=?4
               AND c.call_id=?5 AND c.effect_id=?6 AND c.capability_id=?7
               AND c.origin_kind='session_batch' AND c.managed_attempt_digest IS NULL
               AND c.status='SETTLED' AND t.status='SETTLED' AND p.status='CONSUMED'",
            params![principal,session_id,batch_id,call_index as i64,call_id,effect_id,guard::TERMINAL_RUN_ID],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((challenge_id,receipt_digest,workspace_revision,preflight_epoch,artifact_bytes,fidelity,output_digest,observed_bytes,dropped_bytes))=row
        else { return Err(Failure::Unknown.error()); };
        let artifact_ref = terminal_artifact_ref_from_value(
            messagepack::decode(&artifact_bytes,FRAME_LIMITS).map_err(|_|Failure::Unknown.error())?,
        ).ok_or_else(||Failure::Unknown.error())?;
        if preflight_epoch <= 0 || preflight_epoch as u64 != owner_epoch
            || !is_blake3_digest(&workspace_revision)
            || !is_blake3_digest(&receipt_digest) || !is_blake3_digest(&output_digest)
            || !matches!(fidelity.as_str(),"FULL"|"SAMPLE")
            || !canonical_u64(&observed_bytes) || !canonical_u64(&dropped_bytes)
        { return Err(Failure::Unknown.error()); }
        let challenge_receipt: Option<String> = self.connection.query_row(
            "SELECT receipt_digest FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2 AND status='SETTLED'",
            params![challenge_id,effect_id],|r|r.get(0),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        if challenge_receipt.as_deref() != Some(receipt_digest.as_str()) { return Err(Failure::Unknown.error()); }
        Ok(DirectSessionTerminalArtifactReceiptV1 {
            owner_epoch,workspace_revision,batch_id:batch_id.to_owned(),call_index,call_id:call_id.to_owned(),
            effect_id:effect_id.to_owned(),challenge_id,receipt_digest,output_digest,
            artifact_ref,artifact_fidelity:fidelity,observed_bytes,dropped_bytes,
        })
    }

    /// Reconstruct the immutable root DirectSession CodeMode authority from the
    /// durable EffectHost execution rows after HostKernel restart. The caller must
    /// supply the authenticated principal/session/location/current owner epoch; the
    /// request ID is only a selector and cannot authorize another owner. Managed
    /// and child-turn authorities are intentionally not reconstructed here.
    pub(crate) fn recover_direct_session_code_mode_authority(
        &self,
        principal: &str,
        session_id: &str,
        location_id: &str,
        owner_epoch: u64,
        request_id: &str,
    ) -> Result<CodeModeExecutionAuthorityV1, TypedErrorV1> {
        for value in [principal, session_id, location_id, request_id] {
            validate_identifier(value).map_err(Failure::error)?;
        }
        if owner_epoch == 0 { return Err(Failure::Invalid.error()); }
        let run: Option<(String,String,String,String,String,String,String,String,String,String,String,
            String,String,i64,i64,i64,Option<String>,String)> = self.connection.query_row(
            "SELECT execution_id,effect_id,challenge_id,capability_lease_digest,attempt_scope_digest,
                    tool_set_digest,enablement_digest,helper_digest,resource_profile_digest,policy_digest,
                    turn_context_digest,principal,session_id,owner_epoch,generation,deadline_unix_ms,
                    direct_turn_scope_digest,status
             FROM code_mode_runs WHERE request_id=?1 AND principal=?2 AND session_id=?3 AND location_id=?4",
            params![request_id,principal,session_id,location_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,
                row.get(12)?,row.get(13)?,row.get(14)?,row.get(15)?,row.get(16)?,row.get(17)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((execution_id,effect_id,challenge_id,lease_digest,scope_digest,tool_set_digest,
            enablement_digest,helper_digest,resource_digest,policy_digest,turn_context_digest,
            stored_principal,stored_session,stored_epoch,generation,deadline,direct_turn,status))=run else {
            return Err(Failure::NotFound.error());
        };
        if stored_principal != principal || stored_session != session_id
            || stored_epoch != owner_epoch as i64 || generation <= 0 || deadline <= 0
            || direct_turn.is_some()
            || !matches!(status.as_str(),"READY"|"WAVE_PENDING"|"FAILED"|"CANCELLED"|"UNKNOWN"|"COMPLETE")
            || !is_blake3_digest(&lease_digest) || !is_blake3_digest(&scope_digest)
            || !is_blake3_digest(&tool_set_digest) || !is_blake3_digest(&enablement_digest)
            || !guard::is_sha256_digest(&helper_digest) || !is_blake3_digest(&resource_digest)
            || !is_blake3_digest(&policy_digest) || !guard::is_sha256_digest(&turn_context_digest)
        { return Err(Failure::Conflict.error()); }
        let outer: Option<(String,String,String,String,String,String,i64,i64,String,Option<String>)> = self.connection.query_row(
            "SELECT c.capability_id,c.origin_kind,c.status,c.principal,c.session_id,
                    s.status,s.owner_epoch,s.generation,s.workspace_revision,s.direct_session_grant_digest
             FROM effect_challenges c JOIN stdio_executions s ON s.execution_id=?1
             WHERE c.effect_id=?2 AND c.challenge_id=?3 AND c.principal=?4 AND c.session_id=?5
               AND s.location_id=?6",
            params![execution_id,effect_id,challenge_id,principal,session_id,location_id],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((capability,origin,challenge_status,challenge_principal,challenge_session,
            execution_status,execution_epoch,execution_generation,workspace_revision,grant_digest))=outer else {
            return Err(Failure::NotFound.error());
        };
        if capability != guard::CODE_MODE_EXECUTE_ID || origin != "session_batch"
            || !matches!(challenge_status.as_str(),"SETTLED"|"UNKNOWN")
            || !matches!(execution_status.as_str(),"SETTLED"|"UNKNOWN")
            || challenge_principal != principal || challenge_session != session_id
            || execution_epoch != owner_epoch as i64 || execution_generation != generation
            || !is_blake3_digest(&workspace_revision)
            || grant_digest.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
        { return Err(Failure::Conflict.error()); }
        let authority_scope = CodeModeAuthorityScopeV1::DirectSession {
            workspace_revision_digest: workspace_revision,
            direct_session_grant_digest: grant_digest,
        };
        let expected_scope = codemode_authority_scope_digest(&authority_scope,session_id,location_id)?;
        if scope_digest != expected_scope { return Err(Failure::Conflict.error()); }
        Ok(CodeModeExecutionAuthorityV1 {
            request_id: request_id.to_owned(), execution_id, effect_id, challenge_id,
            principal: principal.to_owned(), session_id: session_id.to_owned(),
            location_id: location_id.to_owned(), owner_epoch, generation: generation as u64,
            capability_lease_digest: lease_digest, authority_scope,
            direct_turn_scope_digest: None, authorized_tools: Vec::new(), tool_set_digest,
            enablement_digest, helper_digest, resource_profile_digest: resource_digest,
            policy_digest, turn_context_digest, deadline_unix_ms: deadline as u64,
        })
    }

    /// Rehydrate a managed CodeMode authority for read-only status and terminal
    /// receipt recovery after HostKernel restart. The current Attempt scope is
    /// supplied only from HostKernel's authenticated OwnerLog projection; this
    /// method requires it to match the latest durable wave scope (or the original
    /// outer scope before any wave). Recovered authorities carry no callable tools.
    /// They cannot resume a helper or authorize a nested dispatch.
    pub(crate) fn recover_managed_attempt_code_mode_authority(
        &self,
        principal: &str,
        session_id: &str,
        location_id: &str,
        owner_epoch: u64,
        request_id: &str,
        current_scope: &crate::protocol::ManagedAttemptScopeV1,
    ) -> Result<CodeModeExecutionAuthorityV1, TypedErrorV1> {
        for value in [principal, session_id, location_id, request_id] {
            validate_identifier(value).map_err(Failure::error)?;
        }
        if owner_epoch == 0 || current_scope.owner_epoch != owner_epoch
            || current_scope.session_id != session_id || current_scope.location_id != location_id
        { return Err(Failure::Invalid.error()); }
        let run: Option<(String,String,String,String,String,String,String,String,String,String,String,
            String,String,i64,i64,i64,String,String)> = self.connection.query_row(
            "SELECT execution_id,effect_id,challenge_id,capability_lease_digest,attempt_scope_digest,
                    tool_set_digest,enablement_digest,helper_digest,resource_profile_digest,policy_digest,
                    turn_context_digest,principal,session_id,owner_epoch,generation,deadline_unix_ms,status,location_id
             FROM code_mode_runs WHERE request_id=?1 AND principal=?2 AND session_id=?3 AND location_id=?4",
            params![request_id,principal,session_id,location_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,
                row.get(12)?,row.get(13)?,row.get(14)?,row.get(15)?,row.get(16)?,row.get(17)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((execution_id,effect_id,challenge_id,lease_digest,initial_authority_digest,
            tool_set_digest,enablement_digest,helper_digest,resource_digest,policy_digest,
            turn_context_digest,stored_principal,stored_session,stored_epoch,generation,deadline,
            run_status,stored_location)) = run else { return Err(Failure::NotFound.error()); };
        if stored_principal != principal || stored_session != session_id || stored_location != location_id
            || stored_epoch != owner_epoch as i64 || generation <= 0 || deadline <= 0
            || !matches!(run_status.as_str(),"READY"|"WAVE_PENDING"|"FAILED"|"CANCELLED"|"UNKNOWN"|"COMPLETE")
            || !is_blake3_digest(&lease_digest) || !is_blake3_digest(&initial_authority_digest)
            || !is_blake3_digest(&tool_set_digest) || !is_blake3_digest(&enablement_digest)
            || !guard::is_sha256_digest(&helper_digest) || !is_blake3_digest(&resource_digest)
            || !is_blake3_digest(&policy_digest) || !guard::is_sha256_digest(&turn_context_digest)
        { return Err(Failure::Conflict.error()); }

        let outer: Option<(String,String,String,String,String,Option<String>,String,i64,i64,String,
            Option<String>,Option<String>,Option<String>)> = self.connection.query_row(
            "SELECT c.capability_id,c.origin_kind,c.status,c.principal,c.session_id,
                    c.managed_attempt_digest,s.status,s.owner_epoch,s.generation,s.location_id,
                    s.attempt_scope_digest,c.receipt_digest,s.receipt_digest
             FROM effect_challenges c JOIN stdio_executions s
               ON s.execution_id=?1 AND s.effect_id=c.effect_id AND s.challenge_id=c.challenge_id
             WHERE c.effect_id=?2 AND c.challenge_id=?3 AND c.principal=?4 AND c.session_id=?5",
            params![execution_id,effect_id,challenge_id,principal,session_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((capability,origin,challenge_status,challenge_principal,challenge_session,
            challenge_scope,process_status,process_epoch,process_generation,process_location,
            process_scope,challenge_receipt,process_receipt)) = outer else {
            return Err(Failure::NotFound.error());
        };
        let outer_state_valid = match (challenge_status.as_str(),process_status.as_str()) {
            ("PREPARED","RUNNING") => challenge_receipt.is_none() && process_receipt.is_none(),
            ("SETTLED","SETTLED") => challenge_receipt.as_deref().is_some_and(is_blake3_digest)
                && challenge_receipt == process_receipt,
            ("UNKNOWN","UNKNOWN") => true,
            _ => false,
        };
        if capability != guard::CODE_MODE_EXECUTE_ID || origin != ORIGIN_MANAGED_RUN
            || !matches!(challenge_status.as_str(),"PREPARED"|"SETTLED"|"UNKNOWN")
            || !matches!(process_status.as_str(),"RUNNING"|"SETTLED"|"UNKNOWN")
            || challenge_principal != principal || challenge_session != session_id
            || challenge_scope.as_deref().is_none_or(|digest| !is_blake3_digest(digest))
            || challenge_scope != process_scope
            || process_scope.as_deref().is_none_or(|digest| !is_blake3_digest(digest))
            || process_epoch != owner_epoch as i64 || process_generation != generation
            || process_location != location_id
            || !outer_state_valid
        { return Err(Failure::Conflict.error()); }

        // The outer scope digest is the immutable scope at CodeMode admission.
        // A post-wave scope is accepted only when EffectHost persisted it as the
        // newest wave cursor; a caller cannot supply a rebased scope.
        let current_wave_scope: Option<String> = self.connection.query_row(
            "SELECT scope_digest FROM code_mode_waves WHERE request_id=?1
             ORDER BY wave_index DESC LIMIT 1", [request_id], |row| row.get(0),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let wave_digest = current_scope.digest().map_err(|_|Failure::Invalid.error())?;
        let expected_wave_scope = current_wave_scope.as_deref().or(process_scope.as_deref());
        if expected_wave_scope != Some(wave_digest.as_str()) {
            return Err(Failure::Conflict.error());
        }

        let authority_scope = CodeModeAuthorityScopeV1::ManagedAttempt(
            crate::protocol::EffectAttemptScopeV1::Managed(current_scope.clone()));
        Ok(CodeModeExecutionAuthorityV1 {
            request_id: request_id.to_owned(), execution_id, effect_id, challenge_id,
            principal: principal.to_owned(), session_id: session_id.to_owned(),
            location_id: location_id.to_owned(), owner_epoch, generation: generation as u64,
            capability_lease_digest: lease_digest, authority_scope,
            direct_turn_scope_digest: None, authorized_tools: Vec::new(), tool_set_digest,
            enablement_digest, helper_digest, resource_profile_digest: resource_digest,
            policy_digest, turn_context_digest, deadline_unix_ms: deadline as u64,
        })
    }

    /// Resolve the one live outer CodeMode effect associated with a private Core
    /// tool-call identity. HostKernel supplies only authenticated session/principal
    /// and its own callID; the returned lease is the already-consumed durable lease,
    /// never a caller-projected authorization.
    pub(crate) fn active_code_mode_outer_effect(
        &self,
        session_id: &str,
        principal: &str,
        call_id: &str,
    ) -> Result<ActiveCodeModeOuterEffectV1, TypedErrorV1> {
        for value in [session_id,principal,call_id] {
            validate_identifier(value).map_err(Failure::error)?;
        }
        let mut statement = self.connection.prepare(
            "SELECT c.batch_id,c.call_id,c.challenge_id,c.effect_id,s.execution_id,
                    c.origin_kind,c.capability_lease_digest,c.managed_attempt_digest,
                    c.status,s.status,s.capability_lease_digest
             FROM effect_challenges c JOIN stdio_executions s
               ON s.effect_id=c.effect_id AND s.challenge_id=c.challenge_id
             WHERE c.session_id=?1 AND c.principal=?2 AND c.call_id=?3
               AND c.capability_id=?4",
        ).map_err(|_|Failure::Unavailable.error())?;
        let rows = statement.query_map(
            params![session_id,principal,call_id,guard::CODE_MODE_EXECUTE_ID],
            |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
                r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,
                r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,
                r.get::<_,String>(8)?,r.get::<_,String>(9)?,r.get::<_,String>(10)?)),
        ).map_err(|_|Failure::Unavailable.error())?.collect::<Result<Vec<_>,_>>()
            .map_err(|_|Failure::Unavailable.error())?;
        if rows.len()!=1 { return Err(Failure::Unknown.error()); }
        let (batch_id,stored_call,challenge_id,effect_id,execution_id,origin,lease,
            attempt_scope,challenge_status,process_status,process_lease)=rows.into_iter().next().unwrap();
        let lease = lease.ok_or_else(||Failure::Unknown.error())?;
        if stored_call != call_id || !matches!(origin.as_str(),ORIGIN_MANAGED_RUN|"session_batch")
            || challenge_status != "PREPARED" || process_status != "RUNNING"
            || process_lease != lease || !is_blake3_digest(&lease)
            || attempt_scope.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
        { return Err(Failure::Conflict.error()); }
        Ok(ActiveCodeModeOuterEffectV1 {
            batch_id,call_id:stored_call,challenge_id,effect_id,execution_id,
            origin_kind:origin,capability_lease_digest:lease,attempt_scope_digest:attempt_scope,
        })
    }

    /// Resolve a direct-root wave's immutable receipt pins from the EffectHost
    /// journal itself. HostKernel uses this after restart, then compares the
    /// returned pin with its authenticated DirectSession/OwnerLog projection before
    /// asking for terminal receipts. No caller-supplied call list or digest is used
    /// to select the durable row.
    pub(crate) fn resolve_direct_session_code_mode_wave_receipt_pin(
        &self,
        authority: &CodeModeExecutionAuthorityV1,
        wave_index: u8,
    ) -> Result<DirectSessionCodeModeWaveReceiptPinV1, TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        let CodeModeAuthorityScopeV1::DirectSession { .. } = &authority.authority_scope else {
            return Err(Failure::Denied.error());
        };
        if authority.direct_turn_scope_digest.is_some() || wave_index > 63 {
            return Err(Failure::Invalid.error());
        }
        let scope_digest = codemode_authority_scope_digest(
            &authority.authority_scope,
            &authority.session_id,
            &authority.location_id,
        )?;
        let run: Option<(String,String,String,String,String,i64,i64,String,String,String,String,String,String,String,Option<String>,i64,String)> = self.connection.query_row(
            "SELECT execution_id,effect_id,challenge_id,principal,session_id,owner_epoch,generation,
                    capability_lease_digest,attempt_scope_digest,tool_set_digest,enablement_digest,
                    helper_digest,resource_profile_digest,policy_digest,direct_turn_scope_digest,
                    deadline_unix_ms,turn_context_digest FROM code_mode_runs WHERE request_id=?1",
            [&authority.request_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,
                row.get(12)?,row.get(13)?,row.get(14)?,row.get(15)?,row.get(16)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((execution,effect,challenge,principal,session,epoch,generation,lease,scope,tools,
            enablement,helper,resource,policy,direct_turn,deadline,context))=run else {
            return Err(Failure::NotFound.error());
        };
        if execution != authority.execution_id || effect != authority.effect_id
            || challenge != authority.challenge_id || principal != authority.principal
            || session != authority.session_id || lease != authority.capability_lease_digest
            || scope != scope_digest || tools != authority.tool_set_digest
            || enablement != authority.enablement_digest || helper != authority.helper_digest
            || resource != authority.resource_profile_digest || policy != authority.policy_digest
            || direct_turn.is_some() || authority.direct_turn_scope_digest.is_some()
            || epoch != authority.owner_epoch as i64 || generation != authority.generation as i64
            || deadline != authority.deadline_unix_ms as i64 || context != authority.turn_context_digest
        { return Err(Failure::Conflict.error()); }

        let wave: Option<(String,String,String,Option<String>,i64)> = self.connection.query_row(
            "SELECT batch_id,status,frame_digest,wave_digest,call_count FROM code_mode_waves
             WHERE request_id=?1 AND wave_index=?2",
            params![authority.request_id,wave_index as i64],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((batch_id,status,frame_digest,wave_digest,call_count))=wave else {
            return Err(Failure::NotFound.error());
        };
        if !matches!(status.as_str(),"SETTLED"|"REJECTED"|"CANCELLED")
            || !is_blake3_digest(&frame_digest)
            || wave_digest.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
            || (status == "SETTLED" && wave_digest.is_none())
            || call_count <= 0 || call_count as usize > crate::codemode_protocol::MAX_CALLS_PER_WAVE
        { return Err(Failure::Unknown.error()); }
        let direct_session_scope_digest: String = self.connection.query_row(
            "SELECT scope_digest FROM code_mode_waves WHERE request_id=?1 AND wave_index=?2",
            params![authority.request_id,wave_index as i64],|row|row.get(0),
        ).map_err(|_|Failure::Unavailable.error())?;
        if !is_blake3_digest(&direct_session_scope_digest) { return Err(Failure::Unknown.error()); }
        let direct_turn_scope_digest: Option<String> = self.connection.query_row(
            "SELECT direct_turn_scope_digest FROM code_mode_waves WHERE request_id=?1 AND wave_index=?2",
            params![authority.request_id,wave_index as i64],|row|row.get(0),
        ).map_err(|_|Failure::Unavailable.error())?;
        if direct_turn_scope_digest.is_some() { return Err(Failure::Conflict.error()); }

        let mut statement = self.connection.prepare(
            "SELECT call_index,call_id,arguments_digest FROM code_mode_wave_calls
             WHERE request_id=?1 AND wave_index=?2 ORDER BY call_index",
        ).map_err(|_|Failure::Unavailable.error())?;
        let rows = statement.query_map(params![authority.request_id,wave_index as i64],|row|
            Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))
            .map_err(|_|Failure::Unavailable.error())?;
        let stored_calls = rows.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable.error())?;
        if stored_calls.len() != call_count as usize { return Err(Failure::Unknown.error()); }
        let mut calls = Vec::with_capacity(stored_calls.len());
        for (expected,(index,call_id,arguments_digest)) in stored_calls.into_iter().enumerate() {
            if index != expected as i64 || validate_identifier(&call_id).is_err()
                || !is_blake3_digest(&arguments_digest)
            { return Err(Failure::Unknown.error()); }
            let challenge: Option<(String,String,String,String,Option<String>)> = self.connection.query_row(
                "SELECT challenge_id,effect_id,origin_kind,arguments_digest,admitted_intent_digest
                 FROM effect_challenges WHERE batch_id=?1 AND call_index=?2 AND call_id=?3
                   AND session_id=?4 AND principal=?5",
                params![batch_id,index,call_id,authority.session_id,authority.principal],
                |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
            ).optional().map_err(|_|Failure::Unavailable.error())?;
            let (challenge_id,effect_id,intent_digest) = if let Some((challenge_id,effect_id,origin,args,intent))=challenge {
                if origin != "session_batch" || args != arguments_digest
                    || !is_blake3_digest(intent.as_deref().unwrap_or(""))
                { return Err(Failure::Conflict.error()); }
                (Some(challenge_id),Some(effect_id),intent)
            } else { (None,None,None) };
            calls.push(DirectSessionCodeModeEffectReceiptPinV1 {
                call_index:index as u8, call_id, challenge_id, effect_id,
                arguments_digest, intent_digest,
            });
        }
        Ok(DirectSessionCodeModeWaveReceiptPinV1 {
            batch_id, wave_index, frame_digest,
            wave_digest,
            direct_session_scope_digest, direct_turn_scope_digest, calls,
        })
    }

    /// Recover a direct-root CodeMode wave from authenticated DirectSession owner
    /// authority. Unlike managed waves this takes no Attempt ID or Attempt digest.
    /// The HostKernel must build `authority` from its authenticated owner state and
    /// pass the exact committed wave and ordered call pins. This is read-only with
    /// respect to effect execution: it never admits, dispatches, leases, or retries.
    pub(crate) fn recover_direct_session_code_mode_wave_receipts(
        &self,
        authority: &CodeModeExecutionAuthorityV1,
        pin: &DirectSessionCodeModeWaveReceiptPinV1,
    ) -> Result<Vec<DirectSessionCodeModeEffectReceiptV1>, TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        let CodeModeAuthorityScopeV1::DirectSession {
            direct_session_grant_digest,
            ..
        } = &authority.authority_scope else {
            return Err(Failure::Denied.error());
        };
        if authority.direct_turn_scope_digest.is_some()
            || !is_blake3_digest(&pin.frame_digest)
            || pin.wave_digest.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
            || (pin.wave_digest.is_none() && pin.calls.iter().any(|call| call.challenge_id.is_some()))
            || !is_blake3_digest(&pin.direct_session_scope_digest)
            || pin.direct_turn_scope_digest.is_some()
            || pin.calls.is_empty()
            || pin.calls.len() > crate::codemode_protocol::MAX_CALLS_PER_WAVE
            || pin.calls.iter().enumerate().any(|(index, call)| {
                call.call_index as usize != index
                    || validate_identifier(&call.call_id).is_err()
                    || !is_blake3_digest(&call.arguments_digest)
                    || call.intent_digest.as_deref().is_some_and(|d| !is_blake3_digest(d))
                    || call.challenge_id.as_deref().is_some_and(|id| validate_identifier(id).is_err())
                    || call.effect_id.as_deref().is_some_and(|id| validate_identifier(id).is_err())
                    || call.challenge_id.is_some() != call.effect_id.is_some()
            })
        {
            return Err(Failure::Invalid.error());
        }
        validate_identifier(&pin.batch_id).map_err(Failure::error)?;
        let authority_digest = codemode_authority_scope_digest(
            &authority.authority_scope,
            &authority.session_id,
            &authority.location_id,
        )?;
        let run: Option<(String,String,String,String,String,i64,i64,String,String,String,String,String,String,String,Option<String>,String,i64,String)> = self.connection.query_row(
            "SELECT execution_id,effect_id,challenge_id,principal,session_id,owner_epoch,generation,
                    capability_lease_digest,attempt_scope_digest,tool_set_digest,enablement_digest,
                    helper_digest,resource_profile_digest,policy_digest,direct_turn_scope_digest,status,
                    deadline_unix_ms,turn_context_digest
             FROM code_mode_runs WHERE request_id=?1",
            [&authority.request_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,
                row.get(12)?,row.get(13)?,row.get(14)?,row.get(15)?,row.get(16)?,row.get(17)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((execution,effect,challenge,principal,session,epoch,generation,lease,scope,tools,
            enablement,helper,resource,policy,direct_turn,status,deadline,turn_context))=run else {
            return Err(Failure::NotFound.error());
        };
        if execution != authority.execution_id || effect != authority.effect_id
            || challenge != authority.challenge_id || principal != authority.principal
            || session != authority.session_id || lease != authority.capability_lease_digest
            || scope != authority_digest || tools != authority.tool_set_digest
            || enablement != authority.enablement_digest || helper != authority.helper_digest
            || resource != authority.resource_profile_digest || policy != authority.policy_digest
            || direct_turn != authority.direct_turn_scope_digest
            || epoch != authority.owner_epoch as i64 || generation != authority.generation as i64
            || deadline != authority.deadline_unix_ms as i64 || turn_context != authority.turn_context_digest
            || !matches!(status.as_str(), "READY"|"WAVE_PENDING"|"FAILED"|"CANCELLED"|"UNKNOWN"|"COMPLETE")
        { return Err(Failure::Conflict.error()); }
        let outer: Option<(String,String,String,String,String,i64,i64,Option<String>,String,Option<String>,Option<String>)> = self.connection.query_row(
            "SELECT c.capability_id,c.status,c.origin_kind,c.managed_attempt_digest,
                    s.status,s.owner_epoch,s.generation,s.direct_session_grant_digest,s.location_id,
                    c.direct_permission_mode_digest,c.direct_permission_mode_revision
             FROM effect_challenges c JOIN stdio_executions s ON s.execution_id=?1
             WHERE c.challenge_id=?2 AND c.effect_id=?3 AND c.principal=?4 AND c.session_id=?5",
            params![authority.execution_id,authority.challenge_id,authority.effect_id,
                authority.principal,authority.session_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((capability,outer_status,origin,attempt,execution_status,outer_epoch,
            outer_generation,outer_grant,location,outer_mode_digest,outer_mode_revision))=outer else {
            return Err(Failure::NotFound.error());
        };
        if capability != guard::CODE_MODE_EXECUTE_ID || origin != "session_batch"
            || attempt.is_some() || outer_epoch != authority.owner_epoch as i64
            || outer_generation != authority.generation as i64 || location != authority.location_id
            || outer_grant.as_deref() != direct_session_grant_digest.as_deref()
            || !matches!(outer_status.as_str(),"SETTLED"|"UNKNOWN")
            || !matches!(execution_status.as_str(),"SETTLED"|"UNKNOWN")
        { return Err(Failure::Conflict.error()); }
        let wave: Option<(i64,String,String,Option<String>,Option<String>,i64)> = self.connection.query_row(
            "SELECT wave_index,status,frame_digest,wave_digest,direct_turn_scope_digest,call_count
             FROM code_mode_waves WHERE request_id=?1 AND batch_id=?2",
            params![authority.request_id,pin.batch_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((wave_index,wave_status,frame_digest,wave_digest,direct_turn_digest,call_count))=wave else {
            return Err(Failure::NotFound.error());
        };
        let persisted_scope: String = self.connection.query_row(
            "SELECT scope_digest FROM code_mode_waves WHERE request_id=?1 AND batch_id=?2",
            params![authority.request_id,pin.batch_id],|row|row.get(0),
        ).map_err(|_|Failure::Unknown.error())?;
        if wave_index != pin.wave_index as i64 || frame_digest != pin.frame_digest
            || wave_digest.as_deref() != pin.wave_digest.as_deref()
            || direct_turn_digest != pin.direct_turn_scope_digest
            || persisted_scope != pin.direct_session_scope_digest
            || call_count != pin.calls.len() as i64
            || !matches!(wave_status.as_str(),"SETTLED"|"REJECTED"|"CANCELLED")
        { return Err(Failure::Unknown.error()); }

        let mut output = Vec::with_capacity(pin.calls.len());
        for call in &pin.calls {
            let stored_call: Option<(String,String)> = self.connection.query_row(
                "SELECT call_id,arguments_digest FROM code_mode_wave_calls
                 WHERE request_id=?1 AND wave_index=?2 AND call_index=?3",
                params![authority.request_id,pin.wave_index as i64,call.call_index as i64],
                |row|Ok((row.get(0)?,row.get(1)?)),
            ).optional().map_err(|_|Failure::Unavailable.error())?;
            let Some((call_id,arguments_digest))=stored_call else { return Err(Failure::Unknown.error()); };
            if call_id != call.call_id || arguments_digest != call.arguments_digest {
                return Err(Failure::Conflict.error());
            }
            let challenge_row: Option<(String,String,String,String,String,String,String,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>)> = self.connection.query_row(
                "SELECT challenge_id,effect_id,capability_id,status,origin_kind,arguments_digest,content_digest,
                        admitted_intent_digest,direct_session_grant_digest,managed_attempt_digest,
                        direct_permission_mode_digest,direct_permission_mode_revision
                 FROM effect_challenges WHERE batch_id=?1 AND call_index=?2 AND call_id=?3
                   AND session_id=?4 AND principal=?5",
                params![pin.batch_id,call.call_index as i64,call.call_id,authority.session_id,authority.principal],
                |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?)),
            ).optional().map_err(|_|Failure::Unavailable.error())?;
            let result: Option<(String,Option<String>,Option<String>,Option<String>,String,Option<String>,Option<String>)> = self.connection.query_row(
                "SELECT status,receipt_kind,receipt_ref,receipt_digest,call_id,error_code,output FROM code_mode_wave_results
                 WHERE request_id=?1 AND wave_index=?2 AND call_index=?3",
                params![authority.request_id,pin.wave_index as i64,call.call_index as i64],
                |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
            ).optional().map_err(|_|Failure::Unavailable.error())?;
            let Some((result_status,result_receipt_kind,receipt_ref,receipt_digest,result_call,error_code,output_text))=result else {
                return Err(Failure::Unknown.error());
            };
            if result_call != call.call_id || !receipt_digest.as_deref().is_some_and(is_blake3_digest) {
                return Err(Failure::Unknown.error());
            }
            let (challenge_id,effect_id,capability_id,guard_status,receipt_kind) =
                if let Some((challenge_id,effect_id,capability_id,guard_status,origin,args,content_digest,intent,grant,managed_scope,mode_digest,mode_revision))=challenge_row {
                    if origin != "session_batch" || args != call.arguments_digest
                        || intent.as_deref() != call.intent_digest.as_deref()
                        || grant.as_deref() != direct_session_grant_digest.as_deref()
                        || managed_scope.is_some()
                        || mode_digest != outer_mode_digest || mode_revision != outer_mode_revision
                        || call.challenge_id.as_deref() != Some(challenge_id.as_str())
                        || call.effect_id.as_deref() != Some(effect_id.as_str())
                    { return Err(Failure::Conflict.error()); }
                    let kind = match (result_status.as_str(),guard_status.as_str()) {
                        ("settled","SETTLED") => {
                            let durable: Option<String> = self.connection.query_row(
                                "SELECT receipt_digest FROM effect_challenges WHERE challenge_id=?1 AND status='SETTLED'",
                                [&challenge_id],|row|row.get(0),
                            ).optional().map_err(|_|Failure::Unavailable.error())?;
                            if durable.as_deref() != receipt_digest.as_deref()
                                || receipt_ref.as_deref() != Some(effect_id.as_str())
                                || result_receipt_kind.as_deref() != Some("effect_receipt")
                            { return Err(Failure::Unknown.error()); }
                            "effect_receipt"
                        }
                        ("rejected","DENIED") | ("cancelled","CANCELLED") => {
                            let status = if result_status == "rejected" { "rejected" } else { "cancelled" };
                            let digest = codemode_terminal_decision_receipt_digest(
                                &authority.request_id,&pin.batch_id,pin.wave_index,&pin.frame_digest,
                                &call.call_id,&challenge_id,&content_digest,status,error_code.as_deref(),output_text.as_deref(),
                            );
                            let expected_ref = codemode_terminal_decision_receipt_ref(
                                &authority.request_id,&pin.batch_id,pin.wave_index,&call.call_id,&digest,
                            );
                            if Some(digest.as_str()) != receipt_digest.as_deref() || receipt_ref.as_deref() != Some(expected_ref.as_str())
                                || result_receipt_kind.as_deref() != Some("host_decision") {
                                return Err(Failure::Unknown.error());
                            }
                            "host_decision"
                        },
                        _ => return Err(Failure::Unknown.error()),
                    };
                    (Some(challenge_id),Some(effect_id),Some(capability_id),guard_status,kind)
                } else {
                    if call.challenge_id.is_some() || call.effect_id.is_some() || call.intent_digest.is_some()
                        || !matches!(result_status.as_str(),"rejected"|"cancelled")
                    { return Err(Failure::Unknown.error()); }
                    let status = if result_status == "rejected" { "rejected" } else { "cancelled" };
                    let digest = codemode_terminal_decision_receipt_digest(
                        &authority.request_id,&pin.batch_id,pin.wave_index,&pin.frame_digest,
                        &call.call_id,"pre_dispatch",&pin.frame_digest,status,error_code.as_deref(),output_text.as_deref(),
                    );
                    let expected_ref = codemode_terminal_decision_receipt_ref(
                        &authority.request_id,&pin.batch_id,pin.wave_index,&call.call_id,&digest,
                    );
                    if Some(digest.as_str()) != receipt_digest.as_deref() || receipt_ref.as_deref() != Some(expected_ref.as_str()) {
                        return Err(Failure::Unknown.error());
                    }
                    if result_receipt_kind.as_deref()!=Some("host_decision") { return Err(Failure::Unknown.error()); }
                    (None,None,None,result_status.to_ascii_uppercase(),"host_decision")
                };
            let _ = guard_status;
            output.push(DirectSessionCodeModeEffectReceiptV1 {
                batch_id: pin.batch_id.clone(), wave_index: pin.wave_index,
                call_index: call.call_index, call_id: call.call_id.clone(), challenge_id,
                effect_id, capability_id, status: result_status.to_ascii_uppercase(),
                receipt_ref: receipt_ref.ok_or_else(||Failure::Unknown.error())?,
                receipt_kind: receipt_kind.to_owned(), receipt_digest: receipt_digest.ok_or_else(||Failure::Unknown.error())?,
            });
        }
        let aggregate_status_matches = match wave_status.as_str() {
            "SETTLED" => output.iter().all(|row| row.status == "SETTLED"),
            "REJECTED" => output.iter().all(|row| row.status == "REJECTED"),
            "CANCELLED" => output.iter().all(|row| matches!(row.status.as_str(),"SETTLED"|"CANCELLED")),
            _ => false,
        };
        if !aggregate_status_matches { return Err(Failure::Unknown.error()); }
        Ok(output)
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

    /// Persist the possible-dispatch fence for a Guard-approved automation
    /// definition mutation. This is deliberately separate from registry CAS: if
    /// the process stops between the two durable owners, recovery reports UNKNOWN
    /// unless the registry's exact proof-bound receipt resolves the outcome.
    pub(crate) fn begin_guarded_control_effect(
        &mut self,
        challenge_id: &str,
        effect_id: &str,
        user_action_id: &str,
        principal: &str,
        capability_id: &str,
        input_digest: &str,
        lease_digest: &str,
    ) -> Result<GuardedControlEffectStateV1, TypedErrorV1> {
        let validate = || {
            validate_identifier(challenge_id)?;
            validate_identifier(effect_id)?;
            validate_identifier(user_action_id)?;
            if principal.is_empty() || principal.chars().any(char::is_control)
                || !guard::is_automation_definition_action(capability_id)
                || !is_blake3_digest(input_digest) || !is_blake3_digest(lease_digest)
            { return Err(Failure::Invalid); }
            Ok(())
        };
        validate().map_err(Failure::error)?;
        let challenge = load_challenge(&self.connection, challenge_id)
            .map_err(Failure::error)?.ok_or_else(|| Failure::NotFound.error())?;
        if challenge.challenge_id != challenge_id || challenge.effect_id != effect_id
            || challenge.batch_id != user_action_id || challenge.call_id != user_action_id
            || challenge.principal != principal || challenge.session_id != ""
            || challenge.capability_id != capability_id || challenge.origin_kind != "user_action"
            || challenge.argument_digest != input_digest
        { return Err(Failure::Denied.error()); }

        let current: (Option<i64>, Option<String>, Option<String>) = self.connection.query_row(
            "SELECT approved,capability_lease_digest,receipt_digest FROM effect_challenges WHERE challenge_id=?1",
            [challenge_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|_| Failure::Unavailable.error())?;
        match challenge.status.as_str() {
            "APPROVED" if current.0 == Some(1) && current.1.is_none() => {
                let changed = self.connection.execute(
                    "UPDATE effect_challenges SET status='PREPARED',capability_lease_digest=?1
                     WHERE challenge_id=?2 AND effect_id=?3 AND principal=?4 AND capability_id=?5
                       AND argument_digest=?6 AND status='APPROVED' AND approved=1
                       AND capability_lease_digest IS NULL",
                    params![lease_digest, challenge_id, effect_id, principal, capability_id, input_digest],
                ).map_err(|_| Failure::Unavailable.error())?;
                if changed == 1 { Ok(GuardedControlEffectStateV1::Started) }
                else { Err(Failure::Unknown.error()) }
            }
            "PREPARED" | "UNKNOWN" if current.1.as_deref() == Some(lease_digest) => {
                Ok(GuardedControlEffectStateV1::Unknown)
            }
            "SETTLED" if current.1.as_deref() == Some(lease_digest) => {
                let receipt_digest = current.2.ok_or_else(|| Failure::Unknown.error())?;
                if !is_blake3_digest(&receipt_digest) { return Err(Failure::Unknown.error()); }
                Ok(GuardedControlEffectStateV1::Settled { receipt_digest })
            }
            "APPROVED" if current.0 == Some(1) && current.1.is_none() => {
                Ok(GuardedControlEffectStateV1::NotDispatched)
            }
            _ => Err(Failure::Unknown.error()),
        }
    }

    /// Reconcile one automation Guard effect without dispatch. The caller must
    /// additionally match any owning registry receipt to the returned pins.
    pub(crate) fn inspect_guarded_control_effect(
        &self,
        challenge_id: &str,
        effect_id: &str,
        user_action_id: &str,
        principal: &str,
        capability_id: &str,
        input_digest: &str,
        lease_digest: &str,
    ) -> Result<GuardedControlEffectStateV1, TypedErrorV1> {
        if !is_blake3_digest(input_digest) || !is_blake3_digest(lease_digest)
            || !guard::is_automation_definition_action(capability_id)
        { return Err(Failure::Invalid.error()); }
        let challenge = load_challenge(&self.connection, challenge_id)
            .map_err(Failure::error)?.ok_or_else(|| Failure::NotFound.error())?;
        if challenge.challenge_id != challenge_id || challenge.effect_id != effect_id
            || challenge.batch_id != user_action_id || challenge.call_id != user_action_id
            || challenge.principal != principal || challenge.session_id != ""
            || challenge.capability_id != capability_id || challenge.origin_kind != "user_action"
            || challenge.argument_digest != input_digest
        { return Err(Failure::Denied.error()); }
        let current: (Option<i64>, Option<String>, Option<String>) = self.connection.query_row(
            "SELECT approved,capability_lease_digest,receipt_digest FROM effect_challenges WHERE challenge_id=?1",
            [challenge_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|_| Failure::Unavailable.error())?;
        match challenge.status.as_str() {
            "APPROVED" if current.0 == Some(1) && current.1.is_none() =>
                Ok(GuardedControlEffectStateV1::NotDispatched),
            "PREPARED" | "UNKNOWN" if current.1.as_deref() == Some(lease_digest) =>
                Ok(GuardedControlEffectStateV1::Unknown),
            "SETTLED" if current.1.as_deref() == Some(lease_digest) => {
                let receipt_digest = current.2.ok_or_else(|| Failure::Unknown.error())?;
                if !is_blake3_digest(&receipt_digest) { return Err(Failure::Unknown.error()); }
                Ok(GuardedControlEffectStateV1::Settled { receipt_digest })
            }
            _ => Err(Failure::Unknown.error()),
        }
    }

    /// Attach the exact owner-registry mutation receipt to the prepared Guard
    /// effect. A conflicting or lost write remains UNKNOWN and is never retried.
    pub(crate) fn settle_guarded_control_effect(
        &mut self,
        challenge_id: &str,
        effect_id: &str,
        lease_digest: &str,
        receipt_digest: &str,
    ) -> Result<(), TypedErrorV1> {
        if !is_blake3_digest(lease_digest) || !is_blake3_digest(receipt_digest) {
            return Err(Failure::Invalid.error());
        }
        let changed = self.connection.execute(
            "UPDATE effect_challenges SET status='SETTLED',receipt_digest=?1
             WHERE challenge_id=?2 AND effect_id=?3 AND status IN ('PREPARED','UNKNOWN')
               AND capability_lease_digest=?4 AND capability_id IN
                 ('automations.create','automations.update','automations.enable','automations.disable')",
            params![receipt_digest, challenge_id, effect_id, lease_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed == 1 { return Ok(()); }
        let existing: Option<String> = self.connection.query_row(
            "SELECT receipt_digest FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2
             AND status='SETTLED' AND capability_lease_digest=?3",
            params![challenge_id, effect_id, lease_digest], |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        if existing.as_deref() == Some(receipt_digest) { Ok(()) }
        else { Err(Failure::Unknown.error()) }
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
            capability_lease_digest,
            arguments,
            None,
            guard::TERMINAL_RUN_ID,
            attempt_scope,
        )
        .map_err(Failure::error)
    }

    /// PREPARE a `terminal.run` workspace-profile effect after HostKernel has
    /// independently re-resolved the private Core Config binding. The profile is
    /// challenge intent only; Guard approval and a one-use lease remain required.
    pub fn prepare_terminal_workspace_profile_run(
        &mut self,
        process_session_id: &str,
        principal: &str,
        challenge_id: &str,
        capability_lease_digest: &str,
        arguments: &Value,
        projection_row: &Value,
        attempt_scope: Option<&EffectAttemptScopeV1>,
    ) -> Result<(), TypedErrorV1> {
        let call_id = "terminal-profile-call";
        let call = Value::Map(BTreeMap::from([
            ("callId".to_owned(), Value::String(call_id.to_owned())),
            ("capabilityId".to_owned(), Value::String(guard::TERMINAL_RUN_ID.to_owned())),
            ("arguments".to_owned(), arguments.clone()),
        ]));
        let calls = [call];
        let projections = Value::Array(vec![projection_row.clone()]);
        let mut parsed = parse_terminal_workspace_profile_projections(Some(&projections), &calls)
            .map_err(Failure::error)?;
        let projection = parsed.remove(call_id).ok_or_else(|| Failure::Denied.error())?;
        self.begin_terminal_effect(
            process_session_id,
            principal,
            challenge_id,
            capability_lease_digest,
            arguments,
            Some(&projection),
            guard::TERMINAL_RUN_ID,
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
            capability_lease_digest,
            arguments,
            None,
            guard::TERMINAL_START_ID,
            attempt_scope,
        )
        .map_err(Failure::error)
    }

    /// Persist the exact process-tree boundary prepared by the existing PTY
    /// ExecutionHost. This is mandatory before terminal.run/start dispatch; it does
    /// not itself authorize or launch the process.
    pub(crate) fn bind_terminal_process_cgroup(
        &mut self,
        effect_id: &str,
        principal: &str,
        capability_lease_digest: &str,
        attempt_scope: Option<&EffectAttemptScopeV1>,
        cgroup_identity_value: &Value,
    ) -> Result<(), TypedErrorV1> {
        validate_identifier(effect_id).map_err(Failure::error)?;
        validate_identifier(principal).map_err(Failure::error)?;
        if !is_blake3_digest(capability_lease_digest) {
            return Err(Failure::Invalid.error());
        }
        let identity = crate::cgroup_v2::CgroupIdentityV1::from_value(cgroup_identity_value)
            .map_err(|_| Failure::Invalid.error())?;
        let challenge = load_effect(&self.connection, effect_id)
            .map_err(Failure::error)?.ok_or_else(|| Failure::NotFound.error())?;
        let expected_kind = match challenge.capability_id.as_str() {
            guard::TERMINAL_RUN_ID => "terminal_run",
            guard::TERMINAL_START_ID => "terminal_start",
            _ => return Err(Failure::Denied.error()),
        };
        let expected_scope = attempt_scope_digest(attempt_scope, &challenge.session_id)
            .map_err(Failure::error)?;
        if challenge.principal != principal
            || challenge.status != "PREPARED"
            || challenge.managed_attempt_digest != expected_scope
            || challenge.capability_lease_digest.as_deref() != Some(capability_lease_digest)
            || identity.effect_id != effect_id
            || identity.capability_lease_digest != capability_lease_digest
            || identity.execution_principal != principal
            || identity.attempt_scope_digest != expected_scope
            || identity.owner_epoch == 0
            || identity.process_generation == 0
            || identity.process_kind != expected_kind
            || identity.profile_revision == 0
            || !matches!(identity.resource_profile.as_str(), "none")
        {
            return Err(Failure::Conflict.error());
        }
        let encoded = crate::messagepack::encode(cgroup_identity_value, FRAME_LIMITS)
            .map_err(|_| Failure::Invalid.error())?;
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let changed = tx.execute(
            "UPDATE terminal_runs SET cgroup_identity=?1,quiescence_digest=NULL
             WHERE effect_id=?2 AND status='PREPARED' AND cgroup_identity IS NULL",
            params![encoded,effect_id],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        tx.commit().map_err(|_| Failure::Unavailable.error())
    }

    /// Record containment quiescence separately from the terminal effect receipt.
    /// A parent PTY exit is insufficient while any cgroup descendant may remain.
    pub(crate) fn record_terminal_process_quiescence(
        &mut self,
        effect_id: &str,
        cgroup_identity_value: &Value,
        quiescence_digest: &str,
    ) -> Result<(), TypedErrorV1> {
        validate_identifier(effect_id).map_err(Failure::error)?;
        if !is_blake3_digest(quiescence_digest) { return Err(Failure::Invalid.error()); }
        let expected = crate::messagepack::encode(cgroup_identity_value, FRAME_LIMITS)
            .map_err(|_| Failure::Invalid.error())?;
        let changed = self.connection.execute(
            "UPDATE terminal_runs SET quiescence_digest=?1
             WHERE effect_id=?2 AND status='PREPARED' AND cgroup_identity=?3",
            params![quiescence_digest,effect_id,expected],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        Ok(())
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
                || record.direct_permission_mode_digest.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
                || record.direct_permission_mode_digest.is_some() != record.direct_permission_mode_revision.is_some()
                || record.direct_permission_mode_revision.is_some_and(|revision| revision == 0)
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
                    binding_digest,guarantee_record,direct_permission_mode_digest,direct_permission_mode_revision,
                    status,created_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'PREPARED',?14)",
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
                        record.direct_permission_mode_digest,
                        record.direct_permission_mode_revision.map(|revision| revision.to_string()),
                        now as i64,
                    ],
                )
                .map_err(|_| Failure::Conflict.error())?;
        }
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())
    }

    /// Bind a no-child verifier launch assessment to one exact pending reviewer
    /// challenge. The assessment is produced from the host-selected immutable
    /// process profile; no request field can supply or replace its guarantees.
    pub(crate) fn bind_managed_verifier_preflight(
        &mut self,
        binding: &ManagedVerifierPreflightBindingV1,
        assessment: &crate::terminal_process::StdioLaunchAssessmentV1,
    ) -> Result<ManagedVerifierPreflightReceiptV1, TypedErrorV1> {
        let fail = |failure: Failure| failure.error();
        let binding_digest = binding.digest().map_err(fail)?;
        let guarantee_digest = assessment.guarantee_digest();
        let launch_digest = assessment.execution_digest().to_owned();
        let guarantee_record = assessment.guarantee_record();
        let assessed_dimensions: HashSet<_> = assessment.guarantees().iter()
            .map(|assessment| assessment.dimension)
            .collect();
        if !is_blake3_digest(&binding_digest)
            || !is_blake3_digest(&launch_digest)
            || !is_blake3_digest(&guarantee_digest)
            || guarantee_record.is_empty()
            || guarantee_record.len() > 16 * 1024
            || assessment.guarantees().len() != horizoncode_sandbox::GuaranteeDimension::ALL.len()
            || assessed_dimensions.len() != horizoncode_sandbox::GuaranteeDimension::ALL.len()
            || horizoncode_sandbox::GuaranteeDimension::ALL.iter()
                .any(|dimension| !assessed_dimensions.contains(dimension))
        {
            return Err(Failure::Invalid.error());
        }
        let now = now_ms().map_err(fail)?;
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let challenge = load_challenge(&transaction, &binding.challenge_id)
            .map_err(fail)?
            .ok_or_else(|| Failure::NotFound.error())?;
        let profile = load_broker_process_binding(&transaction, &binding.challenge_id)
            .map_err(fail)?
            .ok_or_else(|| Failure::Denied.error())?;
        if challenge.effect_id != binding.effect_id
            || challenge.principal != binding.principal
            || challenge.session_id != binding.session_id
            || challenge.capability_id != guard::BUILTIN_VERIFIER_ID
            || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::ManagedRun
            || challenge.managed_attempt_digest.as_deref() != Some(&binding.attempt_scope_digest)
            || challenge.argument_digest != binding.approved_arguments_digest
            || challenge.status != "AWAITING_APPROVAL"
            || challenge.expires_at_ms <= now
            || profile.profile_id != binding.profile_id
            || profile.profile_digest != binding.profile_digest
            || profile.executable_digest != binding.executable_digest
            || profile.execution_principal != binding.execution_principal
        {
            return Err(Failure::Denied.error());
        }
        transaction.execute(
            "INSERT INTO managed_verifier_preflights(
                challenge_id,effect_id,binding_digest,launch_digest,guarantee_digest,
                guarantee_record,status,created_at_ms
             ) VALUES (?1,?2,?3,?4,?5,?6,'PREPARED',?7)",
            params![
                binding.challenge_id,
                binding.effect_id,
                binding_digest,
                launch_digest,
                guarantee_digest,
                guarantee_record,
                now as i64,
            ],
        ).map_err(|_| Failure::Conflict.error())?;
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(ManagedVerifierPreflightReceiptV1 {
            challenge_id: binding.challenge_id.clone(),
            binding_digest,
            launch_digest,
            guarantee_digest,
        })
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
            Option<String>,
            Option<String>,
            String,
        )> = transaction
            .query_row(
                "SELECT effect_id,principal,approved_arguments_digest,owner_epoch,profile_digest,
                    executable_digest,workspace_revision,launch_digest,binding_digest,
                    guarantee_record,direct_permission_mode_digest,direct_permission_mode_revision,status
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
                        row.get(11)?,
                        row.get(12)?,
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
            direct_permission_mode_digest,
            direct_permission_mode_revision,
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
            || direct_permission_mode_digest != expected.direct_permission_mode_digest
            || direct_permission_mode_revision
                != expected.direct_permission_mode_revision.map(|revision| revision.to_string())
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
        // This process effect currently depends on the Linux cgroup-v2 identity
        // persisted below. Do not create a PREPARED row on another platform and
        // leave it for a caller or platform backend to interpret as dispatchable.
        // Native Windows/macOS remain unavailable until their own containment and
        // crash-reconciliation contracts are implemented and accepted.
        #[cfg(not(target_os = "linux"))]
        return Err(Failure::Unavailable.error());

        self.validate_execution_preflight(binding, preflight)
            .map_err(Failure::error)?;
        let active: i64 = self
            .connection
            .query_row(
                // UNKNOWN may still name a live process after owner loss. Keep
                // it in the admission count until exact supervisor reconciliation
                // proves exit; never reuse capacity because the wrapper vanished.
                "SELECT COUNT(*) FROM stdio_executions WHERE status IN ('PREPARED','RUNNING','CANCELLING','UNKNOWN')",
                [],
                |row| row.get(0),
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if active < 0 || active as usize >= MAX_STDIO_EXECUTIONS {
            return Err(Failure::Unavailable.error());
        }
        let intent_id = random_id("xintent").map_err(Failure::error)?;
        let now = now_ms().map_err(Failure::error)? as i64;
        #[cfg(target_os = "linux")]
        let cgroup_identity = preflight
            .cgroup_identity
            .as_ref()
            .and_then(|identity| crate::messagepack::encode(identity, crate::messagepack::FRAME_LIMITS).ok())
            .ok_or_else(|| Failure::Unavailable.error())?;
        #[cfg(not(target_os = "linux"))]
        let cgroup_identity: Option<Vec<u8>> = None;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let (scope_kind, scope_workspace_id) = match &binding.scope {
            crate::terminal_process::StdioExecutionScopeV1::Session { .. } => ("session", None),
            crate::terminal_process::StdioExecutionScopeV1::ProjectRead { workspace_id } =>
                ("project_read", Some(workspace_id.as_str())),
        };
        let direct_grant_digest: Option<String> = transaction.query_row(
            "SELECT direct_session_grant_digest FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2",
            params![binding.challenge_id, binding.effect_id], |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.flatten();
        if binding.capability_id == guard::FILES_READ_ID && direct_grant_digest.is_none() {
            return Err(Failure::Denied.error());
        }
        let changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='PREPARED', lease_id=?1
                 WHERE challenge_id=?2 AND effect_id=?3 AND principal=?4 AND session_id=?5
                   AND capability_id=?6 AND status='APPROVED' AND expires_at_ms>?7
                   AND managed_attempt_digest IS ?8 AND argument_digest=?9
                   AND (?6!=?10 OR direct_session_grant_digest IS NOT NULL)",
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
                    guard::FILES_READ_ID,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 {
            return Err(Failure::Conflict.error());
        }
        if binding.capability_id == guard::BUILTIN_VERIFIER_ID {
            let attempt_scope_digest = binding.attempt_scope_digest.as_deref()
                .ok_or_else(|| Failure::Denied.error())?;
            let verifier_binding = ManagedVerifierPreflightBindingV1 {
                challenge_id: binding.challenge_id.clone(),
                effect_id: binding.effect_id.clone(),
                principal: binding.principal.clone(),
                execution_principal: binding.execution_principal.clone(),
                session_id: binding.session_id.clone(),
                location_id: binding.location_id.clone(),
                attempt_scope_digest: attempt_scope_digest.to_owned(),
                owner_epoch: binding.owner_epoch,
                generation: binding.generation,
                workspace_revision: binding.workspace_revision.clone(),
                approved_arguments_digest: binding.approved_arguments_digest.clone(),
                profile_id: binding.profile_id.clone(),
                profile_revision: binding.profile_revision,
                profile_digest: binding.profile_digest.clone(),
                executable_digest: binding.executable_digest.clone(),
            };
            let expected_binding_digest = verifier_binding.digest().map_err(Failure::error)?;
            let consumed = transaction.execute(
                "UPDATE managed_verifier_preflights SET status='CONSUMED'
                 WHERE challenge_id=?1 AND effect_id=?2 AND binding_digest=?3
                   AND launch_digest=?4 AND guarantee_digest=?5 AND guarantee_record=?6
                   AND status='PREPARED'",
                params![
                    binding.challenge_id,
                    binding.effect_id,
                    expected_binding_digest,
                    preflight.launch_digest,
                    preflight.guarantee_digest,
                    preflight.confinement_record,
                ],
            ).map_err(|_| Failure::Unavailable.error())?;
            if consumed != 1 {
                return Err(Failure::Conflict.error());
            }
        }
        transaction
            .execute(
                "INSERT INTO stdio_executions(
                    execution_id,intent_id,effect_id,challenge_id,principal,execution_principal,session_id,scope_kind,scope_workspace_id,direct_session_grant_digest,location_id,
                    capability_id,capability_lease_digest,attempt_scope_digest,owner_epoch,generation,
                    workspace_revision,profile_ref,profile_id,profile_revision,profile_digest,executable_digest,
                    execution_digest,confinement_record,cgroup_identity,status,created_at_ms,updated_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,'PREPARED',?26,?26)",
                params![
                    binding.execution_id,
                    intent_id,
                    binding.effect_id,
                    binding.challenge_id,
                    binding.principal,
                    binding.execution_principal,
                    binding.session_id,
                    scope_kind,
                    scope_workspace_id,
                    direct_grant_digest,
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
                    cgroup_identity,
                    now,
                ],
            )
            .map_err(|_| Failure::Unavailable.error())?;
        #[cfg(target_os = "linux")]
        {
            let identity = preflight.cgroup_identity.as_ref()
                .and_then(|value| crate::cgroup_v2::CgroupIdentityV1::from_value(value).ok())
                .ok_or_else(|| Failure::Unavailable.error())?;
            crate::cgroup_v2::ExecutionCgroupV2::confirm_empty_before_dispatch(&identity)
                .map_err(|_| Failure::Unavailable.error())?;
        }
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
                   AND execution_digest=?20 AND execution_principal=?21 AND status='PREPARED'",
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
                    binding.execution_principal,
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
                   AND execution_principal=?19 AND status IN ('RUNNING','CANCELLING')",
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
                    binding.execution_principal,
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
        if binding.capability_id == guard::FILES_READ_ID {
            // Read-only Git results need their exact bounded stdout/stderr bytes
            // persisted atomically with the receipt so a lost RPC response can
            // replay the result without re-running Git.
            return Err(Failure::Denied.error());
        }
        self.settle_execution_inner(binding, observation, None, None)
    }

    /// Settle a fixed Git read with the supervisor-observed bounded bytes. The
    /// durable receipt and exact replayable bytes are written in one transaction.
    pub(crate) fn settle_git_read_execution(
        &mut self,
        binding: &StdioExecutionBindingV1,
        observation: &StdioExecutionStatusV1,
        output: crate::terminal_process::StdioObservedOutputV1,
        observed_workspace_revision: &str,
    ) -> Result<crate::terminal_process::StdioGitReadReceiptV1, TypedErrorV1> {
        if binding.capability_id != guard::FILES_READ_ID {
            return Err(Failure::Denied.error());
        }
        if !is_blake3_digest(observed_workspace_revision) {
            return Err(Failure::Invalid.error());
        }
        let grant_digest: Option<String> = self.connection.query_row(
            "SELECT direct_session_grant_digest FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2",
            params![binding.challenge_id, binding.effect_id], |row| row.get::<_, Option<String>>(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.flatten()
            .ok_or_else(|| Failure::Denied.error())?;
        let process = self.settle_execution_inner(
            binding, observation, Some(output), Some(observed_workspace_revision),
        )?;
        Ok(crate::terminal_process::StdioGitReadReceiptV1 {
            process,
            workspace_revision_before: binding.workspace_revision.clone(),
            workspace_revision_after: observed_workspace_revision.to_owned(),
            operation_digest: binding.approved_arguments_digest.clone(),
            grant_digest,
        })
    }

    fn settle_execution_inner(
        &mut self,
        binding: &StdioExecutionBindingV1,
        observation: &StdioExecutionStatusV1,
        output: Option<crate::terminal_process::StdioObservedOutputV1>,
        observed_workspace_revision: Option<&str>,
    ) -> Result<StdioExecutionReceiptV1, TypedErrorV1> {
        let (stdout_bytes_data, stderr_bytes_data) = if binding.capability_id == guard::FILES_READ_ID {
            let output = output.as_ref().ok_or_else(|| Failure::Denied.error())?;
            let combined = output.stdout.len().checked_add(output.stderr.len())
                .ok_or_else(|| Failure::Invalid.error())?;
            let cap = crate::terminal_process::MAX_GIT_READ_OUTPUT_BYTES;
            if combined > cap
                || combined as u64 != observation.output_bytes
                || observed_workspace_revision.map_or(true, |revision| !is_blake3_digest(revision))
                || observation.stdout_digest != format!("blake3:{}", blake3::hash(&output.stdout).to_hex())
                || observation.stderr_digest != format!("blake3:{}", blake3::hash(&output.stderr).to_hex())
            {
                return Err(Failure::Denied.error());
            }
            (Some(output.stdout.clone()), Some(output.stderr.clone()))
        } else {
            if output.is_some() || observed_workspace_revision.is_some() {
                return Err(Failure::Denied.error());
            }
            (None, None)
        };
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
        let direct_grant_digest: Option<String> = self.connection.query_row(
            "SELECT direct_session_grant_digest FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2",
            params![binding.challenge_id, binding.effect_id], |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.flatten();
        if challenge.status != "PREPARED" {
            return Err(Failure::Unknown.error());
        }
        if binding.capability_id == guard::FILES_READ_ID {
            if direct_grant_digest.is_none()
                || !matches!(
                    &binding.scope,
                    crate::terminal_process::StdioExecutionScopeV1::ProjectRead { .. }
                        | crate::terminal_process::StdioExecutionScopeV1::Session { .. }
                )
            {
                return Err(Failure::Denied.error());
            }
        }
        let (execution_digest, encoded_cgroup_identity, capability_id): (String, Option<Vec<u8>>, String) = self
            .connection
            .query_row(
                "SELECT execution_digest,cgroup_identity,capability_id FROM stdio_executions
                 WHERE execution_id=?1 AND effect_id=?2 AND challenge_id=?3 AND principal=?4
                   AND session_id=?5 AND location_id=?6 AND capability_id=?7
                   AND capability_lease_digest=?8 AND attempt_scope_digest IS ?9
                   AND owner_epoch=?10 AND generation=?11 AND workspace_revision=?12
                   AND profile_ref=?13 AND profile_id=?14 AND profile_revision=?15
                   AND profile_digest=?16 AND executable_digest=?17 AND execution_principal=?18",
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
                    binding.execution_principal,
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::Unknown.error())?;
        #[cfg(target_os = "linux")]
        let (quiescence_digest, settled_cgroup_identity) = {
            let bytes = encoded_cgroup_identity.ok_or_else(|| Failure::Unknown.error())?;
            let value = crate::messagepack::decode(&bytes, crate::messagepack::FRAME_LIMITS)
                .map_err(|_| Failure::Unknown.error())?;
            let identity = crate::cgroup_v2::CgroupIdentityV1::from_value(&value)
                .map_err(|_| Failure::Unknown.error())?;
            if identity.execution_id != binding.execution_id
                || identity.effect_id != binding.effect_id
                || identity.capability_lease_digest != binding.capability_lease_digest
                || identity.execution_principal != binding.execution_principal
                || identity.attempt_scope_digest != binding.attempt_scope_digest
                || identity.owner_epoch != binding.owner_epoch
                || identity.process_generation != binding.generation
                || identity.process_kind != crate::terminal_process::stdio_process_kind_for_capability(&capability_id)
                    .ok_or_else(|| Failure::Unknown.error())?.wire_name()
                || identity.profile_id != binding.profile_id
                || identity.profile_revision != binding.profile_revision
                || identity.profile_digest != binding.profile_digest
                || identity.executable_digest != binding.executable_digest
            { return Err(Failure::Unknown.error()); }
            let proof = crate::cgroup_v2::ExecutionCgroupV2::kill_and_confirm_empty(&identity)
                .map_err(|_| Failure::Unknown.error())?;
            (proof, identity)
        };
        #[cfg(not(target_os = "linux"))]
        let quiescence_digest = {
            let _ = encoded_cgroup_identity;
            return Err(Failure::Unavailable.error());
        };
        let receipt_digest = digest_bytes(
            format!(
                "horizoncode.stdio.receipt.v1:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
                binding.execution_id,
                binding.effect_id,
                binding.generation,
                match &binding.scope { crate::terminal_process::StdioExecutionScopeV1::Session { .. } => "session", crate::terminal_process::StdioExecutionScopeV1::ProjectRead { .. } => "project_read" },
                match &binding.scope { crate::terminal_process::StdioExecutionScopeV1::ProjectRead { workspace_id } => workspace_id.as_str(), _ => "none" },
                direct_grant_digest.as_deref().unwrap_or("none"),
                binding.profile_id,
                binding.profile_revision,
                binding.profile_digest,
                binding.executable_digest,
                execution_digest,
                binding.approved_arguments_digest,
                binding.execution_principal,
                observation
                    .exit_code
                    .map_or_else(|| "none".to_owned(), |code| code.to_string()),
                observation.stdout_sequence,
                observation.stderr_sequence,
                observation.stdout_digest,
                observation.stderr_digest,
                observation.output_bytes,
                observation.truncated,
                observed_workspace_revision.unwrap_or("none"),
                quiescence_digest,
            )
            .as_bytes(),
        );
        let now = now_ms().map_err(Failure::error)? as i64;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable.error())?;
        let (scope_kind, scope_workspace_id) = match &binding.scope {
            crate::terminal_process::StdioExecutionScopeV1::Session { .. } => ("session", None),
            crate::terminal_process::StdioExecutionScopeV1::ProjectRead { workspace_id } =>
                ("project_read", Some(workspace_id.as_str())),
        };
        let changed = transaction
            .execute(
                "UPDATE stdio_executions SET status='SETTLED',exit_code=?1,stdout_sequence=?2,
                    stderr_sequence=?3,stdout_digest=?4,stderr_digest=?5,output_bytes=?6,
                    truncated=?7,receipt_digest=?8,quiescence_digest=?9,updated_at_ms=?10,
                    stdout_bytes_data=?33,stderr_bytes_data=?34
                    ,observed_workspace_revision=?35
                 WHERE execution_id=?11 AND effect_id=?12 AND challenge_id=?13 AND principal=?14
                   AND session_id=?15 AND location_id=?16 AND capability_id=?17
                   AND capability_lease_digest=?18 AND attempt_scope_digest IS ?19
                   AND owner_epoch=?20 AND generation=?21 AND workspace_revision=?22
                   AND profile_ref=?23 AND profile_id=?24 AND profile_revision=?25
                   AND profile_digest=?26 AND executable_digest=?27
                   AND execution_digest=?28 AND execution_principal=?29
                   AND scope_kind=?30 AND scope_workspace_id IS ?31 AND direct_session_grant_digest IS ?32
                   AND status IN ('RUNNING','CANCELLING')",
                params![
                    observation.exit_code,
                    observation.stdout_sequence as i64,
                    observation.stderr_sequence as i64,
                    observation.stdout_digest,
                    observation.stderr_digest,
                    observation.output_bytes as i64,
                    observation.truncated as i64,
                    receipt_digest,
                    quiescence_digest,
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
                    binding.execution_principal,
                    scope_kind,
                    scope_workspace_id,
                    direct_grant_digest,
                    stdout_bytes_data,
                    stderr_bytes_data,
                    observed_workspace_revision,
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
        transaction.execute(
            "UPDATE http_route_attempts SET state='UNKNOWN',updated_at_ms=?1
             WHERE execution_id=?2 AND state='DISPATCHING'",
            params![now_ms().map_err(Failure::error)? as i64, binding.execution_id],
        ).map_err(|_| Failure::Unavailable.error())?;
        transaction
            .commit()
            .map_err(|_| Failure::Unavailable.error())?;
        #[cfg(target_os = "linux")]
        let _ = crate::cgroup_v2::ExecutionCgroupV2::remove_quiescent_if_empty(&settled_cgroup_identity, &quiescence_digest);
        Ok(StdioExecutionReceiptV1 {
            execution_id: binding.execution_id.clone(),
            effect_id: binding.effect_id.clone(),
            generation: binding.generation,
            profile_id: binding.profile_id.clone(),
            profile_revision: binding.profile_revision,
            profile_digest: binding.profile_digest.clone(),
            executable_digest: binding.executable_digest.clone(),
            execution_principal: binding.execution_principal.clone(),
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
                   AND execution_principal=?19 AND status IN ('PREPARED','RUNNING','CANCELLING','UNKNOWN')",
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
                    binding.execution_principal,
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
                        profile_id,profile_revision,profile_digest,executable_digest,execution_principal,
                        scope_kind,scope_workspace_id,direct_session_grant_digest
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
                    row.get::<_, String>(23)?,
                    row.get::<_, String>(24)?, row.get::<_, Option<String>>(25)?,
                    row.get::<_, Option<String>>(26)?,
                )),
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::NotFound.error())?;
        let (expected_scope_kind, expected_workspace_id) = match &binding.scope {
            crate::terminal_process::StdioExecutionScopeV1::Session { .. } => ("session", None),
            crate::terminal_process::StdioExecutionScopeV1::ProjectRead { workspace_id } =>
                ("project_read", Some(workspace_id.as_str())),
        };
        let challenge_grant_digest: Option<String> = self.connection.query_row(
            "SELECT direct_session_grant_digest FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2",
            params![binding.challenge_id, binding.effect_id], |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.flatten();
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
            || row.23 != binding.execution_principal
            || row.24 != expected_scope_kind
            || row.25.as_deref() != expected_workspace_id
            || row.26 != challenge_grant_digest
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

    /// Return the exact bytes committed with a settled fixed Git read. This is a
    /// replay-only path: it never launches a process and refuses legacy receipts,
    /// UNKNOWN executions, incomplete blobs, and any output that no longer matches
    /// the supervisor receipt digests and direct workspace-read grant.
    pub(crate) fn replay_git_read_output(
        &self,
        binding: &StdioExecutionBindingV1,
    ) -> Result<crate::terminal_process::StdioGitReadReplayV1, TypedErrorV1> {
        if binding.capability_id != guard::FILES_READ_ID {
            return Err(Failure::Denied.error());
        }
        let status = self.execution_status(binding)?;
        if status.state != StdioExecutionStateV1::Exited || status.receipt_digest.is_none() {
            return Err(Failure::Unknown.error());
        }
        let (stdout, stderr, observed_workspace_revision, grant_digest, challenge_receipt_digest):
            (Option<Vec<u8>>, Option<Vec<u8>>, Option<String>, Option<String>, Option<String>) = self
            .connection
            .query_row(
                "SELECT e.stdout_bytes_data,e.stderr_bytes_data,e.observed_workspace_revision,
                        e.direct_session_grant_digest,c.receipt_digest
                 FROM stdio_executions e JOIN effect_challenges c ON c.challenge_id=e.challenge_id
                 WHERE e.execution_id=?1 AND e.effect_id=?2 AND e.challenge_id=?3
                   AND e.principal=?4 AND e.session_id=?5 AND e.location_id=?6 AND e.capability_id=?7
                   AND e.capability_lease_digest=?8 AND e.owner_epoch=?9 AND e.generation=?10
                   AND e.workspace_revision=?11 AND e.profile_ref=?12 AND e.profile_id=?13
                   AND e.profile_revision=?14 AND e.profile_digest=?15 AND e.executable_digest=?16
                   AND e.execution_principal=?17 AND e.status='SETTLED' AND c.status='SETTLED'",
                params![
                    binding.execution_id, binding.effect_id, binding.challenge_id,
                    binding.principal, binding.session_id, binding.location_id,
                    binding.capability_id, binding.capability_lease_digest,
                    binding.owner_epoch as i64, binding.generation as i64,
                    binding.workspace_revision, binding.profile_ref, binding.profile_id,
                    binding.profile_revision as i64, binding.profile_digest,
                    binding.executable_digest, binding.execution_principal,
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::Unknown.error())?;
        let stdout = stdout.ok_or_else(|| Failure::Unknown.error())?;
        let stderr = stderr.ok_or_else(|| Failure::Unknown.error())?;
        let observed_workspace_revision = observed_workspace_revision
            .filter(|revision| is_blake3_digest(revision))
            .ok_or_else(|| Failure::Unknown.error())?;
        let combined_bytes = stdout.len().checked_add(stderr.len())
            .ok_or_else(|| Failure::Unknown.error())?;
        if grant_digest.as_deref().map_or(true, |digest| !is_blake3_digest(digest))
            || observed_workspace_revision != binding.workspace_revision
            || challenge_receipt_digest.as_deref() != status.receipt_digest.as_deref()
            || combined_bytes > crate::terminal_process::MAX_GIT_READ_OUTPUT_BYTES
            || combined_bytes as u64 != status.output_bytes
            || format!("blake3:{}", blake3::hash(&stdout).to_hex()) != status.stdout_digest
            || format!("blake3:{}", blake3::hash(&stderr).to_hex()) != status.stderr_digest
        {
            return Err(Failure::Unknown.error());
        }
        let process = StdioExecutionReceiptV1 {
            execution_id: binding.execution_id.clone(),
            effect_id: binding.effect_id.clone(),
            generation: binding.generation,
            profile_id: binding.profile_id.clone(),
            profile_revision: binding.profile_revision,
            profile_digest: binding.profile_digest.clone(),
            executable_digest: binding.executable_digest.clone(),
            execution_principal: binding.execution_principal.clone(),
            exit_code: status.exit_code,
            stdout_sequence: status.stdout_sequence,
            stderr_sequence: status.stderr_sequence,
            stdout_digest: status.stdout_digest,
            stderr_digest: status.stderr_digest,
            output_bytes: status.output_bytes,
            truncated: status.truncated,
            receipt_digest: status.receipt_digest.ok_or_else(|| Failure::Unknown.error())?,
        };
        Ok(crate::terminal_process::StdioGitReadReplayV1 {
            receipt: crate::terminal_process::StdioGitReadReceiptV1 {
                process,
                workspace_revision_before: binding.workspace_revision.clone(),
                workspace_revision_after: observed_workspace_revision,
                operation_digest: binding.approved_arguments_digest.clone(),
                grant_digest: grant_digest.ok_or_else(|| Failure::Unknown.error())?,
            },
            output: crate::terminal_process::StdioObservedOutputV1 { stdout, stderr },
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
            || binding.principal == binding.execution_principal
            || binding.profile_ref != invocation.profile_id()
            || binding.workspace_revision != invocation.final_revision()
            || binding.owner_epoch != invocation.owner_epoch()
            || binding.location_id != invocation.location_id()
            || binding.session_id.is_empty()
            || binding.attempt_scope_digest.is_none()
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
            || profile.execution_principal != invocation.execution_principal()
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
        self.reconcile_stdio_execution_for_capability(
            execution_id, effect_id, challenge_id, principal, location_id,
            guard::TERMINAL_RUN_ID,
        )
    }

    /// Recover one exact fixed Git-read execution from EffectHost's durable row.
    /// This reconstructs authority from the stored binding and never starts Git.
    pub(crate) fn reconcile_git_read_execution(
        &self,
        execution_id: &str,
        effect_id: &str,
        challenge_id: &str,
        principal: &str,
        location_id: &str,
    ) -> Result<StdioExecutionRecoveryV1, TypedErrorV1> {
        self.reconcile_stdio_execution_for_capability(
            execution_id, effect_id, challenge_id, principal, location_id,
            guard::FILES_READ_ID,
        )
    }

    /// Re-resolve every durable stdio process owner for one authenticated managed
    /// Attempt after HostKernel restart. This deliberately does not depend on the
    /// process-local `stdio_bindings` map. Effect IDs are supplied from the live
    /// Attempt proof and are treated only as selectors; every returned authority
    /// field is reconstructed from this journal.
    pub(crate) fn recover_managed_attempt_stdio_effects(
        &self,
        principal: &str,
        session_id: &str,
        effect_pins: &[crate::terminal_process::ManagedStdioEffectRecoveryPinV1],
    ) -> Result<Vec<StdioExecutionRecoveryV1>, TypedErrorV1> {
        validate_identifier(principal).map_err(Failure::error)?;
        validate_identifier(session_id).map_err(Failure::error)?;
        if effect_pins.len() > MAX_TOOL_BATCH_CALLS {
            return Err(Failure::Invalid.error());
        }
        let mut unique = HashSet::with_capacity(effect_pins.len());
        let mut recoveries = Vec::with_capacity(effect_pins.len());
        for pin in effect_pins {
            validate_identifier(&pin.effect_id).map_err(Failure::error)?;
            if !is_blake3_digest(&pin.attempt_scope_digest)
                || !unique.insert(pin.effect_id.as_str())
            { return Err(Failure::Invalid.error()); }
            let row: Option<(String,String,String,String,String,String,Option<String>)> = self.connection.query_row(
                "SELECT execution_id,challenge_id,principal,session_id,location_id,capability_id,attempt_scope_digest
                 FROM stdio_executions WHERE effect_id=?1",
                [&pin.effect_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
            ).optional().map_err(|_| Failure::Unavailable.error())?;
            let Some((execution_id,challenge_id,row_principal,row_session,location_id,capability_id,row_scope)) = row else {
                continue;
            };
            if row_principal != principal || row_session != session_id
                || row_scope.as_deref() != Some(pin.attempt_scope_digest.as_str())
                || crate::terminal_process::stdio_process_kind_for_capability(&capability_id).is_none()
            { return Err(Failure::Denied.error()); }
            let recovery = self.reconcile_stdio_execution_for_capability(
                &execution_id,&pin.effect_id,&challenge_id,principal,&location_id,&capability_id,
            )?;
            if recovery.binding.effect_id != pin.effect_id
                || recovery.binding.attempt_scope_digest.as_deref() != Some(pin.attempt_scope_digest.as_str())
            { return Err(Failure::Unknown.error()); }
            // Push in selector order. HostKernel can compare the projection
            // position-for-position with its authenticated Attempt effect list.
            recoveries.push(recovery);
        }
        Ok(recoveries)
    }

    fn reconcile_stdio_execution_for_capability(
        &self,
        execution_id: &str,
        effect_id: &str,
        challenge_id: &str,
        principal: &str,
        location_id: &str,
        expected_capability_id: &str,
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
                        e.profile_id,e.profile_revision,e.profile_digest,e.executable_digest,e.execution_principal,
                        e.scope_kind,e.scope_workspace_id,e.direct_session_grant_digest
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
                    row.get::<_, String>(25)?, row.get::<_, String>(26)?, row.get::<_, String>(27)?,
                    row.get::<_, String>(28)?, row.get::<_, Option<String>>(29)?, row.get::<_, Option<String>>(30)?,
                )),
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::NotFound.error())?;
        if row.0 != effect_id
            || row.1 != challenge_id
            || row.2 != principal
            || row.4 != location_id
            || row.5 != expected_capability_id
            || crate::terminal_process::stdio_process_kind_for_capability(expected_capability_id).is_none()
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
            || row.27.is_empty()
            || row.27.chars().any(char::is_control)
            || (expected_capability_id == guard::BUILTIN_VERIFIER_ID && row.27 == principal)
            || !is_blake3_digest(&row.21)
            || row
                .18
                .is_some_and(|bytes| bytes < 0 || bytes as u64 > MAX_STDIO_RECEIPT_BYTES as u64)
            || (expected_capability_id == guard::FILES_READ_ID
                && (row.7.is_some()
                    || row.30.as_deref().map_or(true, |digest| !is_blake3_digest(digest))
                    || !matches!(row.28.as_str(), "session" | "project_read")
                    || (row.28 == "project_read"
                        && (!row.3.is_empty() || row.29.as_deref().map_or(true, str::is_empty)))
                    || (row.28 == "session"
                        && (row.3.is_empty() || row.29.is_some()))))
        {
            return Err(Failure::Denied.error());
        }
        let challenge_grant_digest: Option<String> = self.connection.query_row(
            "SELECT direct_session_grant_digest FROM effect_challenges WHERE challenge_id=?1 AND effect_id=?2",
            params![challenge_id, effect_id], |row| row.get(0),
        ).optional().map_err(|_| Failure::Unavailable.error())?.flatten();
        if expected_capability_id == guard::FILES_READ_ID && challenge_grant_digest != row.30 {
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
        let scope = if row.28 == "project_read" {
            crate::terminal_process::StdioExecutionScopeV1::ProjectRead {
                workspace_id: row.29.clone().ok_or_else(|| Failure::Denied.error())?,
            }
        } else {
            crate::terminal_process::StdioExecutionScopeV1::Session { session_id: row.3.clone() }
        };
        let binding = StdioExecutionBindingV1 {
            execution_id: execution_id.to_owned(),
            effect_id: row.0,
            challenge_id: row.1,
            principal: row.2,
            execution_principal: row.27,
            scope,
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
                // A request that became UNKNOWN may still be in flight or have
                // caused a remote effect. Retain its slot until exact recovery.
                "SELECT COUNT(*) FROM http_executions WHERE status IN ('PREPARED','RUNNING','UNKNOWN')",
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

    /// Persist one bounded route attempt beneath the already-approved aggregate
    /// web.search execution. The Guard challenge/lease is spent once for the whole
    /// ordered route plan; each route attempt has its own durable pre-dispatch row.
    pub fn begin_http_route_attempt(
        &mut self,
        binding: &HttpExecutionBindingV1,
        route_id: &str,
        attempt: u8,
    ) -> Result<u64, TypedErrorV1> {
        if !(1..=2).contains(&attempt)
            || (crate::http_execution::fixed_web_search_mcp_route(route_id).is_none()
                && !route_id.strip_prefix("web.search.").is_some_and(|key|
                    crate::http_execution::fixed_credentialed_search_request(key, "bounded query", 1).is_some()))
        {
            return Err(Failure::Invalid.error());
        }
        let row: Option<(String, String, String, String, i64, i64)> = self.connection.query_row(
            "SELECT status,effect_id,challenge_id,principal,owner_epoch,generation
             FROM http_executions WHERE execution_id=?1 AND location_id=?2 AND capability_id=?3
               AND capability_lease_digest=?4 AND attempt_scope_digest IS ?5
               AND owner_epoch=?6 AND generation=?7 AND approved_arguments_digest=?8
               AND request_digest=?9",
            params![binding.execution_id, binding.location_id, binding.capability_id,
                binding.capability_lease_digest, binding.attempt_scope_digest,
                binding.owner_epoch as i64, binding.generation as i64,
                binding.approved_arguments_digest, binding.request_digest],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        let Some(row) = row else { return Err(Failure::NotFound.error()) };
        if row.0 != "RUNNING" || row.1 != binding.effect_id || row.2 != binding.challenge_id
            || row.3 != binding.principal || row.4 != binding.owner_epoch as i64
            || row.5 != binding.generation as i64
        {
            return Err(Failure::Conflict.error());
        }
        let active: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM http_route_attempts WHERE execution_id=?1 AND state='DISPATCHING'",
            [&binding.execution_id], |row| row.get(0),
        ).map_err(|_| Failure::Unavailable.error())?;
        if active != 0 { return Err(Failure::Conflict.error()); }
        let count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM http_route_attempts WHERE execution_id=?1",
            [&binding.execution_id], |row| row.get(0),
        ).map_err(|_| Failure::Unavailable.error())?;
        // A cascade has at most twenty durable route attempts, including retries.
        // Reject before creating the next DISPATCHING row so recovery never has
        // to reconcile a source state the shared schema cannot represent.
        if !(0..20).contains(&count) { return Err(Failure::Unavailable.error()); }
        let previous: Option<(String, i64, String, Option<String>, Option<String>, Option<i64>, Option<i64>, i64)> = self.connection.query_row(
            "SELECT route_id,attempt,state,outcome,not_dispatched_failure,http_status,result_count,body_truncated FROM http_route_attempts WHERE execution_id=?1 ORDER BY sequence DESC LIMIT 1",
            [&binding.execution_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        let previous_ref = previous.as_ref().map(|(route, prior_attempt, state, outcome, failure, status, result_count, truncated)|
            (route.as_str(), *prior_attempt, state.as_str(), outcome.as_deref(), failure.as_deref(),
                status.and_then(|value| u16::try_from(value).ok()), *result_count, *truncated != 0));
        if !valid_next_http_route_attempt_from_receipt(previous_ref, route_id, attempt) {
            if previous.as_ref().is_some_and(|(_, _, state, outcome, _, _, _, _)| state != "SETTLED" || outcome.is_none()) {
                return Err(Failure::Unknown.error());
            }
            return Err(Failure::Conflict.error());
        }
        let sequence: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM http_route_attempts WHERE execution_id=?1",
            [&binding.execution_id], |row| row.get(0),
        ).map_err(|_| Failure::Unavailable.error())?;
        let now = now_ms().map_err(Failure::error)? as i64;
        self.connection.execute(
            "INSERT INTO http_route_attempts(execution_id,sequence,route_id,attempt,state,created_at_ms,updated_at_ms)
             VALUES (?1,?2,?3,?4,'DISPATCHING',?5,?5)",
            params![binding.execution_id, sequence, route_id, i64::from(attempt), now],
        ).map_err(|_| Failure::Conflict.error())?;
        u64::try_from(sequence).map_err(|_| Failure::Unavailable.error())
    }

    /// Append the exact bounded response subreceipt for one route attempt. Body bytes
    /// stay transient; the durable record retains only status, peer and digests.
    pub fn settle_http_route_attempt(
        &mut self,
        binding: &HttpExecutionBindingV1,
        sequence: u64,
        route_id: &str,
        attempt: u8,
        outcome: &str,
        result_count: Option<usize>,
        response: &HttpResponseV1,
    ) -> Result<String, TypedErrorV1> {
        if sequence == 0 || !(1..=2).contains(&attempt)
            || !valid_http_route_outcome(outcome, result_count, response)
            || result_count.is_some_and(|value| value > 10)
            || !(100..=599).contains(&response.status)
            || response.body.len() > crate::http_execution::MAX_HTTP_RESPONSE_BYTES
            || response.connected_peer.is_some_and(|peer| !crate::http_execution::is_public_unicast(peer))
            || response.retry_after_ms.is_some_and(|value| value > crate::http_execution::MAX_RETRY_AFTER_MS)
            || !is_blake3_digest(&response.body_digest)
            || response.body_digest != format!("blake3:{}", blake3::hash(&response.body).to_hex())
            || response.body_truncated == response.response_complete
        {
            return Err(Failure::Invalid.error());
        }
        let peer = response.connected_peer.map_or_else(|| "secret-broker-fixed-route".to_owned(), |peer| peer.to_string());
        let receipt_digest = digest_bytes(format!(
            "horizon.http.route-attempt.v1:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
            binding.execution_id, sequence, route_id, attempt, outcome,
            result_count.map_or_else(|| "unknown".to_owned(), |value| value.to_string()), response.status,
            response.retry_after_ms.map_or_else(|| "none".to_owned(), |value| value.to_string()),
            response.body_digest, response.body.len(), peer,
        ).as_bytes());
        let changed = self.connection.execute(
            "UPDATE http_route_attempts SET state='SETTLED',outcome=?1,result_count=?2,http_status=?3,retry_after_ms=?4,
               body_digest=?5,body_bytes=?6,body_truncated=?7,connected_peer=?8,receipt_digest=?9,updated_at_ms=?10
             WHERE execution_id=?11 AND sequence=?12 AND route_id=?13 AND attempt=?14 AND state='DISPATCHING'
               AND EXISTS (SELECT 1 FROM http_executions WHERE execution_id=?11 AND status='RUNNING'
                 AND effect_id=?15 AND challenge_id=?16 AND principal=?17 AND capability_lease_digest=?18)",
            params![outcome, result_count.map(|value| value as i64), response.status as i64, response.retry_after_ms.map(|v| v as i64),
                response.body_digest, response.body.len() as i64, response.body_truncated as i64,
                peer, receipt_digest, now_ms().map_err(Failure::error)? as i64,
                binding.execution_id, sequence as i64, route_id, i64::from(attempt),
                binding.effect_id, binding.challenge_id, binding.principal, binding.capability_lease_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        Ok(receipt_digest)
    }

    /// Settle an attempt only when the fixed-route transport produced its opaque
    /// pre-send proof. This row contains no HTTP/result/body metadata and records
    /// exactly zero bytes; post-send failures cannot call this API.
    pub(crate) fn settle_http_route_attempt_not_dispatched(
        &mut self,
        binding: &HttpExecutionBindingV1,
        proof: &crate::http_execution::HttpNotDispatchedProofV1,
    ) -> Result<String, TypedErrorV1> {
        if !proof.matches_binding(binding)
            || proof.sequence() == 0
            || !(1..=2).contains(&proof.attempt())
            || !is_blake3_digest(proof.request_digest())
            || !matches!(proof.failure(),
                crate::http_execution::HttpExecutionErrorV1::Cancelled
                    | crate::http_execution::HttpExecutionErrorV1::TimedOut
                    | crate::http_execution::HttpExecutionErrorV1::TransportFailure)
        {
            return Err(Failure::Denied.error());
        }
        let receipt_digest = proof.receipt_digest();
        if !is_blake3_digest(&receipt_digest) {
            return Err(Failure::Invalid.error());
        }
        let changed = self.connection.execute(
            "UPDATE http_route_attempts SET state='SETTLED',outcome='NOT_DISPATCHED',not_dispatched_failure=?1,result_count=NULL,
               http_status=NULL,retry_after_ms=NULL,body_digest=NULL,body_bytes=0,body_truncated=0,
               connected_peer=NULL,receipt_digest=?2,updated_at_ms=?3
             WHERE execution_id=?4 AND sequence=?5 AND route_id=?6 AND attempt=?7 AND state='DISPATCHING'
               AND EXISTS (SELECT 1 FROM http_executions WHERE execution_id=?4 AND status='RUNNING'
                 AND effect_id=?8 AND challenge_id=?9 AND principal=?10 AND capability_lease_digest=?11
                 AND attempt_scope_digest IS ?12 AND owner_epoch=?13 AND generation=?14
                 AND workspace_revision=?15 AND request_digest=?16)",
            params![
                proof.failure_code(), receipt_digest, now_ms().map_err(Failure::error)? as i64,
                proof.execution_id(), proof.sequence() as i64, proof.route_id(), i64::from(proof.attempt()),
                binding.effect_id, binding.challenge_id, binding.principal, binding.capability_lease_digest,
                binding.attempt_scope_digest, binding.owner_epoch as i64, binding.generation as i64,
                binding.workspace_revision, binding.request_digest,
            ],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        Ok(receipt_digest)
    }

    /// A timeout, cancellation, crash or lost response after route dispatch is
    /// durably UNKNOWN; the aggregate cascade must stop without trying another route.
    pub fn mark_http_route_attempt_unknown(
        &mut self,
        binding: &HttpExecutionBindingV1,
        sequence: u64,
    ) -> Result<(), TypedErrorV1> {
        let now = now_ms().map_err(Failure::error)? as i64;
        let changed = self.connection.execute(
            "UPDATE http_route_attempts SET state='UNKNOWN',updated_at_ms=?1
             WHERE execution_id=?2 AND sequence=?3 AND state='DISPATCHING'
               AND EXISTS (SELECT 1 FROM http_executions WHERE execution_id=?2 AND effect_id=?4
                 AND challenge_id=?5 AND principal=?6 AND location_id=?7 AND capability_lease_digest=?8
                 AND status IN ('RUNNING','UNKNOWN'))",
            params![now, binding.execution_id, sequence as i64, binding.effect_id,
                binding.challenge_id, binding.principal, binding.location_id, binding.capability_lease_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        Ok(())
    }

    /// Persist a completed HTTP response as a bounded receipt. Response bytes remain in
    /// the in-memory RPC result and are never stored in the durable effect database.
    pub fn settle_http_execution(
        &mut self,
        binding: &HttpExecutionBindingV1,
        response: &HttpResponseV1,
    ) -> Result<HttpExecutionReceiptV1, TypedErrorV1> {
        self.settle_http_execution_inner(binding, response, None)
    }

    /// Settle a successful cascade response only after authenticating the exact
    /// approved route plan and every ordered durable route subreceipt. The plan
    /// digest is copied into both the aggregate receipt and the durable execution
    /// row so response-loss recovery can compare it with the frozen cursor.
    pub(crate) fn settle_http_execution_with_route_plan(
        &mut self,
        binding: &HttpExecutionBindingV1,
        response: &HttpResponseV1,
        canonical_routes: &[String],
        route_receipts: &[crate::http_execution::HttpRouteReceiptRefV1],
        route_plan_digest: &str,
    ) -> Result<HttpExecutionReceiptV1, TypedErrorV1> {
        self.settle_http_execution_inner(
            binding,
            response,
            Some((canonical_routes, route_receipts, route_plan_digest)),
        )
    }

    fn settle_http_execution_inner(
        &mut self,
        binding: &HttpExecutionBindingV1,
        response: &HttpResponseV1,
        route_plan: Option<(
            &[String],
            &[crate::http_execution::HttpRouteReceiptRefV1],
            &str,
        )>,
    ) -> Result<HttpExecutionReceiptV1, TypedErrorV1> {
        let challenge = load_effect(&self.connection, &binding.effect_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        self.require_http_binding(binding, &challenge)
            .map_err(Failure::error)?;
        if !(100..=599).contains(&response.status)
            || !is_blake3_digest(&response.body_digest)
            || response.body.len() > MAX_HTTP_RESPONSE_BYTES
            || response.connected_peer.is_some_and(|peer| !crate::http_execution::is_public_unicast(peer))
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
        if let Some((canonical_routes, route_receipts, plan_digest)) = route_plan {
            if canonical_routes.is_empty()
                || canonical_routes.len() > 10
                || route_receipts.is_empty()
                || route_receipts.len() > 20
                || !is_blake3_digest(plan_digest)
                || plan_digest != binding.request_digest
                || response.body_truncated
                || !(200..300).contains(&response.status)
            {
                return Err(Failure::Invalid.error());
            }
            let mut unique = HashSet::new();
            if canonical_routes.iter().any(|route_id| {
                !unique.insert(route_id.as_str())
                    || (crate::http_execution::fixed_web_search_mcp_route(route_id).is_none()
                        && !route_id.strip_prefix("web.search.").is_some_and(|key|
                            crate::http_execution::fixed_credentialed_search_request(
                                key, "bounded query", 1,
                            ).is_some()))
            }) {
                return Err(Failure::Denied.error());
            }
        }
        // Serialize route-history validation and aggregate settlement against
        // concurrent route writers. The response and route plan are one receipt.
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let mut route_statement = transaction.prepare(
            "SELECT sequence,route_id,attempt,state,outcome,result_count,receipt_digest,
                    not_dispatched_failure,http_status,retry_after_ms,body_digest,body_bytes,
                    body_truncated,connected_peer FROM http_route_attempts
             WHERE execution_id=?1 ORDER BY sequence",
        ).map_err(|_| Failure::Unavailable.error())?;
        let route_rows = route_statement.query_map([&binding.execution_id], |row| Ok((
            row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<i64>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?, row.get::<_, Option<i64>>(8)?,
            row.get::<_, Option<i64>>(9)?, row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<i64>>(11)?, row.get::<_, i64>(12)?, row.get::<_, Option<String>>(13)?,
        ))).map_err(|_| Failure::Unavailable.error())?;
        let mut route_material = Vec::new();
        let mut strict_previous: Option<(usize, i64, String, Option<String>, Option<u16>, Option<i64>, bool)> = None;
        let mut route_count = 0usize;
        let mut final_route_facts: Option<(String, u8, String, Option<String>, Option<u16>, Option<u64>, Option<String>, usize, bool, Option<String>)> = None;
        let expected_response_peer = response.connected_peer.map_or_else(
            || "secret-broker-fixed-route".to_owned(), |peer| peer.to_string());
        for row in route_rows {
            let (sequence, route_id, attempt, state, outcome, result_count, receipt,
                not_dispatched_failure, http_status, retry_after_ms, sub_body_digest,
                sub_body_bytes, sub_body_truncated, connected_peer) = row.map_err(|_| Failure::Unavailable.error())?;
            if sequence <= 0 || !(1..=2).contains(&attempt) || state != "SETTLED"
                || !outcome.as_deref().is_some_and(|value| matches!(value,
                    "SUCCEEDED" | "EMPTY" | "FAILED" | "RATE_LIMITED" | "RETRYABLE_FAILURE" | "NOT_DISPATCHED"))
                || result_count.is_some_and(|value| !(0..=10).contains(&value))
                || !receipt.as_deref().is_some_and(is_blake3_digest)
            {
                return Err(Failure::Unknown.error());
            }
            if let Some((canonical_routes, route_receipts, _)) = route_plan {
                let expected = route_receipts.get(route_count).ok_or_else(|| Failure::Conflict.error())?;
                let sequence_u64 = u64::try_from(sequence).map_err(|_| Failure::Unknown.error())?;
                let attempt_u8 = u8::try_from(attempt).map_err(|_| Failure::Unknown.error())?;
                let route_index = canonical_routes.iter().position(|candidate| candidate == &route_id)
                    .ok_or_else(|| Failure::Denied.error())?;
                let status = http_status.and_then(|value| u16::try_from(value).ok());
                if expected.sequence != sequence_u64 || expected.route_id != route_id
                    || expected.attempt != attempt_u8 || expected.outcome != outcome.as_deref().unwrap_or_default()
                    || expected.not_dispatched_failure.as_deref() != not_dispatched_failure.as_deref()
                    || expected.receipt_digest != receipt.as_deref().unwrap_or_default()
                    || sequence_u64 as usize != route_count + 1
                {
                    return Err(Failure::Conflict.error());
                }
                let outcome_value = outcome.as_deref().unwrap_or_default();
                let status_i64 = http_status;
                let result_i64 = result_count;
                if outcome_value == "NOT_DISPATCHED" {
                    if !matches!(not_dispatched_failure.as_deref(), Some("timed_out" | "transport_failure"))
                        || result_count.is_some() || status_i64.is_some() || retry_after_ms.is_some()
                        || sub_body_digest.is_some() || sub_body_bytes != Some(0)
                        || sub_body_truncated != 0 || connected_peer.is_some()
                    {
                        return Err(Failure::Unknown.error());
                    }
                } else {
                    let status_value = status.ok_or_else(|| Failure::Unknown.error())?;
                    let body_bytes = sub_body_bytes.and_then(|value| usize::try_from(value).ok())
                        .ok_or_else(|| Failure::Unknown.error())?;
                    let peer = connected_peer.as_deref().ok_or_else(|| Failure::Unknown.error())?;
                    let shape_invalid = match outcome_value {
                        "EMPTY" => result_i64 != Some(0) || !(200..300).contains(&status_value) || sub_body_truncated != 0,
                        "SUCCEEDED" => !result_i64.is_some_and(|value| value > 0)
                            || !(200..300).contains(&status_value) || sub_body_truncated != 0,
                        "RATE_LIMITED" => status_value != 429,
                        "RETRYABLE_FAILURE" => !matches!(status_value, 408 | 425 | 500..=599),
                        "FAILED" => false,
                        _ => true,
                    };
                    if not_dispatched_failure.is_some()
                        || result_i64.is_some_and(|value| !(0..=10).contains(&value))
                        || retry_after_ms.is_some_and(|value| value < 0 || value as u64 > crate::http_execution::MAX_RETRY_AFTER_MS)
                        || body_bytes > crate::http_execution::MAX_HTTP_RESPONSE_BYTES
                        || !sub_body_digest.as_deref().is_some_and(is_blake3_digest)
                        || (peer != "secret-broker-fixed-route"
                            && !peer.parse::<std::net::IpAddr>().is_ok_and(crate::http_execution::is_public_unicast))
                        || shape_invalid
                    {
                        return Err(Failure::Unknown.error());
                    }
                }
                let previous_ref = strict_previous.as_ref().map(|(prior_index, prior_attempt, prior_outcome, prior_failure, prior_status, prior_count, prior_truncated)| {
                    (canonical_routes[*prior_index].as_str(), *prior_attempt, "SETTLED", Some(prior_outcome.as_str()),
                        prior_failure.as_deref(), *prior_status, *prior_count, *prior_truncated)
                });
                if !valid_next_http_route_attempt_from_receipt(previous_ref, &route_id, attempt_u8)
                    || strict_previous.as_ref().is_some_and(|(prior_index, _, _, prior_failure, _, _, _)| {
                        (route_index != *prior_index && route_index != prior_index.saturating_add(1))
                            || prior_failure.as_deref() == Some("cancelled")
                    })
                {
                    return Err(Failure::Conflict.error());
                }
                if let Some((prior_index, prior_attempt, _, _, _, _, _)) = strict_previous.as_ref() {
                    if (route_index == *prior_index && (*prior_attempt != 1 || attempt_u8 != 2))
                        || (route_index == prior_index.saturating_add(1) && attempt_u8 != 1)
                    {
                        return Err(Failure::Conflict.error());
                    }
                } else if route_index != 0 || attempt_u8 != 1 {
                    return Err(Failure::Conflict.error());
                }
                strict_previous = Some((route_index, i64::from(attempt_u8), outcome_value.to_owned(),
                    not_dispatched_failure.clone(), status, result_i64, sub_body_truncated != 0));
                final_route_facts = Some((route_id.clone(), attempt_u8, outcome_value.to_owned(),
                    not_dispatched_failure.clone(), status, retry_after_ms.and_then(|value| u64::try_from(value).ok()),
                    sub_body_digest.clone(), sub_body_bytes.and_then(|value| usize::try_from(value).ok()).unwrap_or(0),
                    sub_body_truncated != 0, connected_peer.clone()));
                route_count += 1;
            }
            route_material.extend_from_slice(format!("{sequence}:{route_id}:{attempt}:{}:{}:{}\n",
                outcome.unwrap(), result_count.map_or_else(|| "unknown".to_owned(), |value| value.to_string()),
                receipt.unwrap()).as_bytes());
        }
        drop(route_statement);
        if let Some((canonical_routes, route_receipts, plan_digest)) = route_plan {
            let Some((_, _, last_outcome, last_failure, last_status, last_retry_after, last_body_digest,
                last_body_bytes, last_truncated, last_peer)) = final_route_facts else {
                return Err(Failure::Unknown.error());
            };
            if route_count != route_receipts.len()
                || route_count == 0
                || route_count > 20
                || last_outcome != "SUCCEEDED"
                || last_failure.is_some()
                || last_status != Some(response.status)
                || last_retry_after != response.retry_after_ms
                || last_body_digest.as_deref() != Some(response.body_digest.as_str())
                || last_body_bytes != response.body.len()
                || last_truncated != response.body_truncated
                || last_peer.as_deref() != Some(expected_response_peer.as_str())
                || route_plan_digest != binding.request_digest
                || canonical_routes.is_empty()
            {
                return Err(Failure::Conflict.error());
            }
        }
        let route_attempts_digest = format!("blake3:{}", blake3::hash(&route_material).to_hex());
        let route_plan_digest = route_plan.map(|(_, _, digest)| digest);
        let peer = response.connected_peer.map_or_else(|| "secret-broker-fixed-route".to_owned(), |peer| peer.to_string());
        let receipt_digest = digest_bytes(
            format!(
                "horizon.http.receipt.v1:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
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
                route_attempts_digest,
                route_plan_digest.unwrap_or("none"),
            )
            .as_bytes(),
        );
        let now = now_ms().map_err(Failure::error)? as i64;
        let changed = transaction
            .execute(
                "UPDATE http_executions SET status='SETTLED',http_status=?1,retry_after_ms=?2,
                    body_digest=?3,body_bytes=?4,body_truncated=?5,connected_peer=?6,
                    receipt_digest=?7,updated_at_ms=?8,route_plan_digest=?9,body_data=?10
                 WHERE execution_id=?11 AND effect_id=?12 AND challenge_id=?13 AND principal=?14
                   AND session_id=?15 AND location_id=?16 AND capability_id=?17
                   AND capability_lease_digest=?18 AND attempt_scope_digest IS ?19
                   AND owner_epoch=?20 AND generation=?21 AND workspace_revision=?22
                   AND route_id=?23 AND approved_arguments_digest=?24 AND request_digest=?25
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
                    route_plan_digest,
                    response.body,
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
            route_plan_digest: route_plan_digest.map(str::to_owned),
            receipt_digest,
        })
    }

    /// Replay a settled HTTP response after a lost RPC response. The body bytes,
    /// effect receipt, challenge receipt and exact request binding must all still
    /// agree; UNKNOWN and no-response terminal outcomes never produce a body.
    pub(crate) fn replay_http_execution_response(
        &self,
        binding: &HttpExecutionBindingV1,
    ) -> Result<HttpResponseV1, TypedErrorV1> {
        let challenge = load_effect(&self.connection, &binding.effect_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        self.require_http_binding(binding, &challenge).map_err(Failure::error)?;
        let row: (String, Option<Vec<u8>>, Option<String>, Option<i64>, i64,
            Option<i64>, Option<i64>, Option<String>, Option<String>, Option<String>, Option<String>) = self.connection
            .query_row(
                "SELECT e.status,e.body_data,e.body_digest,e.body_bytes,e.body_truncated,
                        e.http_status,e.retry_after_ms,e.connected_peer,e.receipt_digest,
                        e.route_plan_digest,c.receipt_digest
                 FROM http_executions e JOIN effect_challenges c ON c.challenge_id=e.challenge_id
                 WHERE e.execution_id=?1 AND e.effect_id=?2 AND e.challenge_id=?3
                   AND e.principal=?4 AND e.session_id=?5 AND e.location_id=?6
                   AND e.capability_id=?7 AND e.capability_lease_digest=?8
                   AND e.attempt_scope_digest IS ?9 AND e.owner_epoch=?10 AND e.generation=?11
                   AND e.workspace_revision=?12 AND e.route_id=?13
                   AND e.approved_arguments_digest=?14 AND e.request_digest=?15
                   AND c.status='SETTLED'",
                params![binding.execution_id, binding.effect_id, binding.challenge_id,
                    binding.principal, binding.session_id, binding.location_id,
                    binding.capability_id, binding.capability_lease_digest,
                    binding.attempt_scope_digest, binding.owner_epoch as i64,
                    binding.generation as i64, binding.workspace_revision,
                    binding.route_id, binding.approved_arguments_digest, binding.request_digest],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                    row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?)),
            )
            .optional()
            .map_err(|_| Failure::Unavailable.error())?
            .ok_or_else(|| Failure::NotFound.error())?;
        let body = row.1.ok_or_else(|| Failure::Unknown.error())?;
        let body_digest = row.2.ok_or_else(|| Failure::Unknown.error())?;
        let body_bytes = row.3.and_then(|bytes| usize::try_from(bytes).ok())
            .ok_or_else(|| Failure::Unknown.error())?;
        let http_status = row.5.and_then(|status| u16::try_from(status).ok())
            .ok_or_else(|| Failure::Unknown.error())?;
        let retry_after_ms = row.6.and_then(|value| u64::try_from(value).ok());
        let receipt_digest = row.8.as_deref().ok_or_else(|| Failure::Unknown.error())?;
        if row.0 != "SETTLED"
            || row.10.as_deref() != Some(receipt_digest)
            || body.len() > MAX_HTTP_RESPONSE_BYTES
            || body.len() != body_bytes
            || !is_blake3_digest(&body_digest)
            || format!("blake3:{}", blake3::hash(&body).to_hex()) != body_digest
            || !(100..=599).contains(&http_status)
            || retry_after_ms.is_some_and(|value| value > crate::http_execution::MAX_RETRY_AFTER_MS)
            || !matches!(row.4, 0 | 1)
            || row.9.as_deref().is_some_and(|digest|
                !is_blake3_digest(digest) || digest != binding.request_digest)
        {
            return Err(Failure::Unknown.error());
        }
        let connected_peer = match row.7.as_deref() {
            Some("secret-broker-fixed-route") => None,
            Some(peer) => Some(peer.parse::<std::net::IpAddr>().map_err(|_| Failure::Unknown.error())?),
            None => return Err(Failure::Unknown.error()),
        };
        Ok(HttpResponseV1 {
            status: http_status,
            retry_after_ms,
            retry_after_header: None,
            body,
            body_digest,
            body_truncated: row.4 != 0,
            response_complete: row.4 == 0,
            connected_peer,
        })
    }

    /// Settle an admitted bounded search plan without fabricating an aggregate
    /// response. `route_plan_digest` is the HostKernel digest of canonical
    /// MessagePack for the exact approved `routes` array (route key, attempt count,
    /// and order); it must equal the request digest committed by this binding. The
    /// route-ID list is used only to validate the ordered durable receipt history.
    /// `CANCELLED` may contain no attempts or any complete ordered prefix
    /// of settled response/no-send receipts. `FAILED` is limited to a final settled
    /// non-authentication, non-rate-limit terminal 4xx. `EXHAUSTED` requires the full approved
    /// route plan, all bounded retry decisions, and no successful result. UNKNOWN or
    /// in-flight history cannot be converted to either terminal outcome.
    pub(crate) fn settle_http_execution_terminal_no_response(
        &mut self,
        binding: &HttpExecutionBindingV1,
        canonical_routes: &[String],
        route_receipts: &[crate::http_execution::HttpRouteReceiptRefV1],
        route_plan_digest: &str,
        terminal_outcome: &str,
    ) -> Result<crate::http_execution::HttpExecutionTerminalReceiptV1, TypedErrorV1> {
        if canonical_routes.is_empty() || canonical_routes.len() > 10 || route_receipts.len() > 20
            || !is_blake3_digest(route_plan_digest)
            // The request digest is minted from the exact approved canonical
            // MessagePack route array (including order and attemptCount). Keep
            // EffectHost bound to that authority; route IDs below are only used
            // to validate the durable receipt sequence.
            || route_plan_digest != binding.request_digest {
            return Err(Failure::Invalid.error());
        }
        if !matches!(terminal_outcome, "CANCELLED" | "FAILED" | "EXHAUSTED") {
            return Err(Failure::Invalid.error());
        }
        let mut unique_routes = HashSet::new();
        if canonical_routes.iter().any(|route_id| {
            !unique_routes.insert(route_id.as_str())
                || (crate::http_execution::fixed_web_search_mcp_route(route_id).is_none()
                    && !route_id.strip_prefix("web.search.").is_some_and(|key|
                        crate::http_execution::fixed_credentialed_search_request(
                            key, "bounded query", 1,
                        ).is_some()))
        }) {
            return Err(Failure::Denied.error());
        }
        let challenge = load_effect(&self.connection, &binding.effect_id)
            .map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        self.require_http_binding(binding, &challenge)
            .map_err(Failure::error)?;

        let mut statement = self.connection.prepare(
            "SELECT sequence,route_id,attempt,state,outcome,not_dispatched_failure,
                    result_count,http_status,retry_after_ms,body_digest,body_bytes,
                    body_truncated,connected_peer,receipt_digest
             FROM http_route_attempts WHERE execution_id=?1 ORDER BY sequence",
        ).map_err(|_| Failure::Unavailable.error())?;
        let rows = statement.query_map([&binding.execution_id], |row| Ok((
            row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?, row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<i64>>(7)?, row.get::<_, Option<i64>>(8)?,
            row.get::<_, Option<String>>(9)?, row.get::<_, Option<i64>>(10)?,
            row.get::<_, i64>(11)?, row.get::<_, Option<String>>(12)?,
            row.get::<_, Option<String>>(13)?,
        ))).map_err(|_| Failure::Unavailable.error())?;

        let mut route_material = Vec::new();
        let mut previous: Option<(usize, i64, String, Option<String>, Option<u16>, Option<i64>, bool)> = None;
        let mut count = 0usize;
        let mut saw_success = false;
        for row in rows {
            let row = row.map_err(|_| Failure::Unavailable.error())?;
            let Some(expected_receipt) = route_receipts.get(count) else {
                return Err(Failure::Conflict.error());
            };
            count += 1;
            let sequence = u64::try_from(row.0).map_err(|_| Failure::Unknown.error())?;
            let attempt = u8::try_from(row.2).map_err(|_| Failure::Unknown.error())?;
            let route_index = canonical_routes.iter().position(|route| route == &row.1)
                .ok_or_else(|| Failure::Denied.error())?;
            if sequence as usize != count || !(1..=2).contains(&attempt) || row.3 != "SETTLED"
                || !row.13.as_deref().is_some_and(is_blake3_digest) {
                return Err(Failure::Unknown.error());
            }
            let outcome = row.4.as_deref().ok_or_else(|| Failure::Unknown.error())?;
            let failure = row.5.as_deref();
            let not_dispatched = outcome == "NOT_DISPATCHED";
            let receipt = row.13.as_deref().ok_or_else(|| Failure::Unknown.error())?;
            let mut response_status = None;
            if expected_receipt.sequence != sequence
                || expected_receipt.route_id != row.1
                || expected_receipt.attempt != attempt
                || expected_receipt.outcome != outcome
                || expected_receipt.not_dispatched_failure.as_deref() != failure
                || expected_receipt.receipt_digest != receipt
            {
                return Err(Failure::Conflict.error());
            }
            if not_dispatched {
                if !matches!(failure, Some("timed_out" | "transport_failure" | "cancelled"))
                    || row.6.is_some() || row.7.is_some() || row.8.is_some() || row.9.is_some()
                    || row.10 != Some(0) || row.11 != 0 || row.12.is_some() {
                    return Err(Failure::Unknown.error());
                }
            } else {
                let Some(status) = row.7.and_then(|value| u16::try_from(value).ok()) else {
                    return Err(Failure::Unknown.error());
                };
                response_status = Some(status);
                let Some(body_bytes) = row.10.and_then(|value| usize::try_from(value).ok()) else {
                    return Err(Failure::Unknown.error());
                };
                let body_digest = row.9.as_deref().ok_or_else(|| Failure::Unknown.error())?;
                let peer = row.12.as_deref().ok_or_else(|| Failure::Unknown.error())?;
                let outcome_shape_invalid = match outcome {
                    "EMPTY" => row.6 != Some(0) || !(200..300).contains(&status) || row.11 != 0,
                    "SUCCEEDED" => !row.6.is_some_and(|value| value > 0)
                        || !(200..300).contains(&status) || row.11 != 0,
                    "RATE_LIMITED" => status != 429,
                    "RETRYABLE_FAILURE" => !matches!(status, 408 | 425 | 500..=599),
                    "FAILED" => false,
                    _ => true,
                };
                if failure.is_some() || row.8.is_some_and(|value| value < 0)
                    || row.8.is_some_and(|value| value as u64 > crate::http_execution::MAX_RETRY_AFTER_MS)
                    || row.6.is_some_and(|value| !(0..=10).contains(&value))
                    || body_bytes > crate::http_execution::MAX_HTTP_RESPONSE_BYTES
                    || !is_blake3_digest(body_digest)
                    || (peer != "secret-broker-fixed-route"
                        && !peer.parse::<std::net::IpAddr>().is_ok_and(crate::http_execution::is_public_unicast))
                    || !is_blake3_digest(receipt)
                    || !matches!(outcome, "EMPTY" | "SUCCEEDED" | "FAILED" | "RATE_LIMITED" | "RETRYABLE_FAILURE")
                    || outcome_shape_invalid
                {
                    return Err(Failure::Unknown.error());
                }
                saw_success |= matches!(outcome, "EMPTY" | "SUCCEEDED");
            }
            let previous_ref = previous.as_ref().map(|(prior_index, prior_attempt, prior_outcome, prior_failure, prior_status, prior_count, prior_truncated)| {
                (canonical_routes[*prior_index].as_str(), *prior_attempt, "SETTLED", Some(prior_outcome.as_str()), prior_failure.as_deref(), *prior_status, *prior_count, *prior_truncated)
            });
            if !valid_next_http_route_attempt_from_receipt(previous_ref, &row.1, attempt)
                || previous.as_ref().is_some_and(|(prior_index, _, _, prior_failure, _)| {
                    route_index != *prior_index && route_index != prior_index.saturating_add(1)
                        || prior_failure.as_deref() == Some("cancelled")
                })
            {
                return Err(Failure::Conflict.error());
            }
            if let Some((prior_index, prior_attempt, _, _, _)) = previous.as_ref() {
                if route_index == *prior_index && (*prior_attempt != 1 || attempt != 2)
                    || route_index == prior_index.saturating_add(1) && attempt != 1 {
                    return Err(Failure::Conflict.error());
                }
            } else if route_index != 0 || attempt != 1 {
                return Err(Failure::Conflict.error());
            }
            route_material.extend_from_slice(format!(
                "{sequence}:{}:{attempt}:{outcome}:{}:{receipt}\n",
                row.1, failure.unwrap_or("none"),
            ).as_bytes());
            previous = Some((route_index, i64::from(attempt), outcome.to_owned(), failure.map(str::to_owned), response_status, row.6, row.11 != 0));
        }
        drop(statement);
        if count > 20 || count != route_receipts.len() {
            return Err(Failure::Unknown.error());
        }
        let terminal_valid = match terminal_outcome {
            // Cancellation is permitted before the first route attempt and after
            // any fully settled prefix. A DISPATCHING/UNKNOWN row was rejected above.
            "CANCELLED" => true,
            "FAILED" => count > 0 && !saw_success
                && previous.as_ref().is_some_and(|(_, _, last_outcome, last_failure, status, _, _)| {
                    last_outcome.as_str() == "FAILED" && last_failure.is_none()
                        && status.as_ref().is_some_and(|status| (400..500).contains(status)
                            && !matches!(*status, 401 | 403 | 407 | 408 | 425 | 429))
                }),
            // Exhaustion consumes the whole approved plan and cannot hide success.
            "EXHAUSTED" => count > 0 && !saw_success
                && previous.as_ref().is_some_and(|(last_route_index, last_attempt, last_outcome, last_failure, status, _, _)| {
                    *last_route_index + 1 == canonical_routes.len()
                        && !matches!(last_outcome.as_str(), "SUCCEEDED" | "EMPTY")
                        && last_failure.as_deref() != Some("cancelled")
                        && !(last_outcome.as_str() == "FAILED" && status.as_ref().is_some_and(|status| (400..500).contains(status)
                            && !matches!(*status, 401 | 403 | 407 | 408 | 425 | 429)))
                        && !(matches!(last_outcome.as_str(), "RETRYABLE_FAILURE" | "NOT_DISPATCHED") && *last_attempt == 1)
                }),
            _ => false,
        };
        if !terminal_valid {
            return Err(Failure::Conflict.error());
        }

        let route_attempts_digest = format!("blake3:{}", blake3::hash(&route_material).to_hex());
        let receipt_digest = digest_bytes(format!(
            "horizon.http.terminal-aggregate.v1:{}:{}:{}:{}:{}:{}:{}:{}:{}",
            binding.execution_id, binding.effect_id, binding.generation,
            binding.route_id, binding.request_digest, binding.approved_arguments_digest,
            terminal_outcome, route_plan_digest, route_attempts_digest,
        ).as_bytes());
        let now = now_ms().map_err(Failure::error)? as i64;
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let changed = transaction.execute(
            "UPDATE http_executions SET status='SETTLED',outcome=?1,route_plan_digest=?2,
                http_status=NULL,retry_after_ms=NULL,body_digest=NULL,body_bytes=0,
                body_data=NULL,body_truncated=0,connected_peer=NULL,receipt_digest=?3,updated_at_ms=?4
             WHERE execution_id=?5 AND effect_id=?6 AND challenge_id=?7 AND principal=?8
               AND session_id=?9 AND location_id=?10 AND capability_id=?11
               AND capability_lease_digest=?12 AND attempt_scope_digest IS ?13
               AND owner_epoch=?14 AND generation=?15 AND workspace_revision=?16
               AND route_id=?17 AND approved_arguments_digest=?18 AND request_digest=?19
               AND status='RUNNING'",
            params![terminal_outcome, route_plan_digest, receipt_digest, now, binding.execution_id, binding.effect_id,
                binding.challenge_id, binding.principal, binding.session_id, binding.location_id,
                binding.capability_id, binding.capability_lease_digest, binding.attempt_scope_digest,
                binding.owner_epoch as i64, binding.generation as i64, binding.workspace_revision,
                binding.route_id, binding.approved_arguments_digest, binding.request_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Unknown.error()); }
        let challenge_changed = transaction.execute(
            "UPDATE effect_challenges SET status='SETTLED',receipt_digest=?1
             WHERE challenge_id=?2 AND effect_id=?3 AND status='PREPARED'",
            params![receipt_digest, binding.challenge_id, binding.effect_id],
        ).map_err(|_| Failure::Unavailable.error())?;
        if challenge_changed != 1 { return Err(Failure::Unknown.error()); }
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(crate::http_execution::HttpExecutionTerminalReceiptV1 {
            execution_id: binding.execution_id.clone(),
            effect_id: binding.effect_id.clone(),
            generation: binding.generation,
            outcome: terminal_outcome.to_owned(),
            route_plan_digest: route_plan_digest.to_owned(),
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
                        body_digest,body_bytes,body_truncated,connected_peer,receipt_digest,outcome,route_plan_digest
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
                    row.get::<_, Option<String>>(20)?,
                    row.get::<_, Option<String>>(21)?,
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
        let settled_shape_valid = match row.20.as_deref() {
            Some("CANCELLED" | "FAILED" | "EXHAUSTED") => row.13.is_none()
                && row.14.is_none()
                && row.15.is_none()
                && row.16 == Some(0)
                && row.17 == 0
                && row.18.is_none()
                && row.21.as_deref().is_some_and(is_blake3_digest)
                && row.21.as_deref() == Some(row.11.as_str()),
            None => row.13.is_some_and(|status| (100..=599).contains(&status))
                && row.15.as_deref().is_some_and(is_blake3_digest)
                && row.21.is_none()
                && row.16.is_some_and(|bytes| bytes >= 0
                    && usize::try_from(bytes).is_ok_and(|bytes| bytes <= crate::http_execution::MAX_HTTP_RESPONSE_BYTES))
                && row.14.map_or(true, |retry| retry >= 0
                    && u64::try_from(retry).is_ok_and(|retry| retry <= crate::http_execution::MAX_RETRY_AFTER_MS))
                && (row.17 == 0 || row.17 == 1),
            _ => false,
        };
        let state = match row.12.as_str() {
            "UNKNOWN" => HttpExecutionStateV1::Unknown,
            "SETTLED"
                if row.19.as_deref().is_some_and(is_blake3_digest)
                    && settled_shape_valid =>
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
            outcome: row.20,
            route_plan_digest: row.21,
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

    /// Return ordered route subreceipts for an already authenticated aggregate
    /// recovery. The caller must first validate ownership with
    /// `reconcile_http_execution`; no response bodies are retained here.
    pub fn http_route_attempt_recovery(
        &self,
        execution_id: &str,
    ) -> Result<Vec<crate::http_execution::HttpRouteAttemptRecoveryV1>, TypedErrorV1> {
        validate_identifier(execution_id).map_err(Failure::error)?;
        let mut statement = self.connection.prepare(
            "SELECT sequence,route_id,attempt,state,outcome,result_count,http_status,retry_after_ms,body_digest,
                    body_bytes,body_truncated,receipt_digest,not_dispatched_failure
             FROM http_route_attempts WHERE execution_id=?1 ORDER BY sequence",
        ).map_err(|_| Failure::Unavailable.error())?;
        let rows = statement.query_map([execution_id], |row| Ok((
            row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<i64>>(5)?,
            row.get::<_, Option<i64>>(6)?, row.get::<_, Option<i64>>(7)?, row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<i64>>(9)?, row.get::<_, i64>(10)?, row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
        ))).map_err(|_| Failure::Unavailable.error())?;
        let mut output = Vec::new();
        for row in rows {
            let row = row.map_err(|_| Failure::Unavailable.error())?;
            let sequence = u64::try_from(row.0).map_err(|_| Failure::Unknown.error())?;
            let attempt = u8::try_from(row.2).map_err(|_| Failure::Unknown.error())?;
            if sequence == 0 || !(1..=2).contains(&attempt)
                || !matches!(row.3.as_str(), "DISPATCHING" | "SETTLED" | "UNKNOWN")
                || row.4.as_deref().is_some_and(|value| !matches!(value.as_str(),
                    "SUCCEEDED" | "EMPTY" | "FAILED" | "RATE_LIMITED" | "RETRYABLE_FAILURE" | "NOT_DISPATCHED"))
                || row.5.is_some_and(|value| !(0..=10).contains(&value))
                || row.8.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
                || row.11.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
                || row.12.as_deref().is_some_and(|reason| !matches!(reason, "cancelled" | "timed_out" | "transport_failure"))
            {
                return Err(Failure::Unknown.error());
            }
            if row.3 == "SETTLED" {
                let (Some(outcome), Some(receipt)) = (row.4.as_deref(), row.11.as_deref()) else {
                        return Err(Failure::Unknown.error());
                    };
                if !is_blake3_digest(receipt)
                    || (outcome == "NOT_DISPATCHED" && (row.5.is_some() || row.6.is_some()
                        || row.7.is_some() || row.8.is_some() || row.9 != Some(0) || row.10 != 0
                        || row.12.is_none()))
                    || (outcome != "NOT_DISPATCHED" && row.6.is_none())
                    || (outcome != "NOT_DISPATCHED" && row.12.is_some())
                    || (outcome == "EMPTY" && (row.5 != Some(0) || !row.6.is_some_and(|status| (200..300).contains(&status))))
                    || (outcome == "SUCCEEDED" && (row.5.is_none_or(|count| count <= 0)
                        || !row.6.is_some_and(|status| (200..300).contains(&status))))
                {
                    return Err(Failure::Unknown.error());
                }
            } else if row.4.is_some() || row.11.is_some() || row.12.is_some() {
                return Err(Failure::Unknown.error());
            }
            output.push(crate::http_execution::HttpRouteAttemptRecoveryV1 {
                sequence, route_id: row.1, attempt, state: row.3,
                outcome: row.4,
                not_dispatched_failure: row.12,
                result_count: row.5.and_then(|value| usize::try_from(value).ok()),
                http_status: row.6.and_then(|value| u16::try_from(value).ok()),
                retry_after_ms: row.7.and_then(|value| u64::try_from(value).ok()),
                body_digest: row.8,
                body_bytes: row.9.and_then(|value| u64::try_from(value).ok()).unwrap_or(0),
                body_truncated: row.10 != 0,
                receipt_digest: row.11,
            });
            if output.len() > 22 { return Err(Failure::Unknown.error()); }
        }
        Ok(output)
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
            transaction.execute(
                "UPDATE http_route_attempts SET state='UNKNOWN',updated_at_ms=?1
                 WHERE state='DISPATCHING' AND execution_id IN
                   (SELECT execution_id FROM http_executions WHERE status='UNKNOWN')",
                [now_ms()? as i64],
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
        match &binding.scope {
            crate::terminal_process::StdioExecutionScopeV1::Session { session_id } => {
                if session_id.is_empty() || session_id != &binding.session_id {
                    return Err(Failure::Invalid);
                }
                validate_identifier(session_id)?;
            }
            crate::terminal_process::StdioExecutionScopeV1::ProjectRead { workspace_id } => {
                if binding.capability_id != guard::FILES_READ_ID
                    || !binding.session_id.is_empty()
                    || binding.attempt_scope_digest.is_some()
                {
                    return Err(Failure::Invalid);
                }
                validate_identifier(workspace_id)?;
            }
        }
        if binding.capability_id == guard::BUILTIN_VERIFIER_ID {
            // A managed verifier is attributable to the same live coding Attempt as
            // the work it verifies. A Goal/Run, reviewer challenge or verifier profile
            // cannot substitute for that Attempt scope. HostKernel builds this digest
            // from the current authenticated Attempt snapshot; reject historical
            // verifier rows that omitted it instead of preserving a weaker launch path.
            if binding.session_id.is_empty() || binding.attempt_scope_digest.is_none() {
                return Err(Failure::Invalid);
            }
            if !matches!(&binding.scope, crate::terminal_process::StdioExecutionScopeV1::Session { .. }) {
                return Err(Failure::Invalid);
            }
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
        #[cfg(target_os = "linux")]
        {
            let identity = preflight.cgroup_identity.as_ref()
                .and_then(|value| crate::cgroup_v2::CgroupIdentityV1::from_value(value).ok())
                .ok_or(Failure::Invalid)?;
            let expected_kind = crate::terminal_process::stdio_process_kind_for_capability(&binding.capability_id)
                .ok_or(Failure::Invalid)?.wire_name();
            if identity.execution_id != binding.execution_id
                || identity.effect_id != binding.effect_id
                || identity.capability_lease_digest != binding.capability_lease_digest
                || identity.execution_principal != binding.execution_principal
                || identity.attempt_scope_digest != binding.attempt_scope_digest
                || identity.owner_epoch != binding.owner_epoch
                || identity.process_generation != binding.generation
                || identity.process_kind != expected_kind
                || identity.profile_id != binding.profile_id
                || identity.profile_revision != binding.profile_revision
                || identity.profile_digest != binding.profile_digest
                || identity.executable_digest != binding.executable_digest
            {
                return Err(Failure::Invalid);
            }
        }
        #[cfg(not(target_os = "linux"))]
        if preflight.cgroup_identity.is_some() {
            return Err(Failure::Invalid);
        }
        let challenge =
            load_effect(&self.connection, &binding.effect_id)?.ok_or(Failure::NotFound)?;
        self.require_stdio_binding(binding, &challenge)?;
        self.validate_stdio_profile_executable(binding, &challenge)?;
        if challenge.status != "APPROVED" || challenge.expires_at_ms <= now_ms()? {
            return Err(Failure::Conflict);
        }
        if binding.capability_id == guard::BUILTIN_VERIFIER_ID {
            let attempt_scope_digest = binding.attempt_scope_digest.as_deref().ok_or(Failure::Denied)?;
            let verifier_binding = ManagedVerifierPreflightBindingV1 {
                challenge_id: binding.challenge_id.clone(),
                effect_id: binding.effect_id.clone(),
                principal: binding.principal.clone(),
                execution_principal: binding.execution_principal.clone(),
                session_id: binding.session_id.clone(),
                location_id: binding.location_id.clone(),
                attempt_scope_digest: attempt_scope_digest.to_owned(),
                owner_epoch: binding.owner_epoch,
                generation: binding.generation,
                workspace_revision: binding.workspace_revision.clone(),
                approved_arguments_digest: binding.approved_arguments_digest.clone(),
                profile_id: binding.profile_id.clone(),
                profile_revision: binding.profile_revision,
                profile_digest: binding.profile_digest.clone(),
                executable_digest: binding.executable_digest.clone(),
            };
            let expected_binding_digest = verifier_binding.digest()?;
            let row: Option<(String, String, String, String)> = self.connection.query_row(
                "SELECT binding_digest,launch_digest,guarantee_digest,guarantee_record
                 FROM managed_verifier_preflights
                 WHERE challenge_id=?1 AND effect_id=?2 AND status='PREPARED'",
                params![binding.challenge_id, binding.effect_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional().map_err(|_| Failure::Unavailable)?;
            let Some((stored_binding, stored_launch, stored_guarantee, stored_record)) = row else {
                return Err(Failure::Denied);
            };
            if stored_binding != expected_binding_digest
                || stored_launch != preflight.launch_digest
                || stored_guarantee != preflight.guarantee_digest
                || stored_record != preflight.confinement_record
                || !is_blake3_digest(&preflight.launch_digest)
                || !is_blake3_digest(&preflight.guarantee_digest)
                || crate::terminal_process::bind_stdio_execution_digest(
                    &preflight.launch_digest,
                    &binding.approved_arguments_digest,
                    &binding.execution_principal,
                ) != preflight.execution_digest
            {
                return Err(Failure::Denied);
            }
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
            || is_stdio_launch_capability(&challenge.capability_id)
        {
            let profile = load_broker_process_binding(&self.connection, &challenge.challenge_id)?
                .ok_or(Failure::Denied)?;
            if binding.profile_ref != profile.profile_id {
                return Err(Failure::Denied);
            }
            if profile.execution_principal != binding.execution_principal {
                return Err(Failure::Denied);
            }
            if profile.scope != binding.scope {
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
                && !is_git_worktree_capability(&challenge.capability_id)
                && !is_stdio_launch_capability(&challenge.capability_id))
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
            && !is_stdio_launch_capability(&challenge.capability_id)
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
        workspace_profile: Option<&TerminalWorkspaceProfileProjectionV1>,
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
            match workspace_profile {
                Some(projection) => parse_terminal_workspace_profile_arguments(
                    arguments, projection, execution.root(),
                )?,
                None => parse_terminal_arguments(arguments, execution.root())?,
            }
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
        // Artifact quota and immutable-byte admission belong to ArtifactStore.
        // EffectHost retains only the terminal receipt and bounded preview.
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
        preview: &str,
        capture: &TerminalOutputCaptureV1,
    ) -> Result<Value, TypedErrorV1> {
        self.complete_terminal_run(effect_id, status, exit_code, preview, capture)
            .map_err(Failure::error)
    }

    fn complete_terminal_run(
        &mut self,
        effect_id: &str,
        status: &str,
        exit_code: Option<i32>,
        preview: &str,
        capture: &TerminalOutputCaptureV1,
    ) -> Result<Value, Failure> {
        if !matches!(status, "exited" | "timed_out" | "cancelled")
            || preview.len() > 50 * 1024
            || !is_blake3_digest(&capture.output_digest)
            || !is_blake3_digest(&capture.artifact_ref.digest)
            || validate_identifier(&capture.artifact_ref.artifact_id).is_err()
            || capture.artifact_ref.media_type.is_empty()
            || capture.artifact_ref.media_type.len() > 256
            || capture.artifact_ref.media_type.chars().any(char::is_control)
            || capture.artifact_ref.classification != ArtifactClassificationV1::Workspace
        {
            return Err(Failure::Invalid);
        }
        let retained_bytes = capture
            .artifact_ref
            .byte_length
            .parse::<u64>()
            .filter(|value| value.to_string() == capture.artifact_ref.byte_length)
            .ok_or(Failure::Invalid)?;
        let observed_bytes = retained_bytes
            .checked_add(capture.dropped_bytes)
            .filter(|value| *value == capture.observed_bytes)
            .ok_or(Failure::Invalid)?;
        if retained_bytes > MAX_TERMINAL_CAPTURE_BYTES {
            return Err(Failure::Invalid);
        }
        let is_full = capture.fidelity == crate::artifact_store::ArtifactFidelityV1::Full;
        let is_sample = capture.fidelity == crate::artifact_store::ArtifactFidelityV1::HeadTailSample;
        if (!is_full && !is_sample)
            || (is_full && (capture.dropped_bytes != 0 || retained_bytes != observed_bytes || capture.artifact_ref.digest != capture.output_digest))
            || (is_sample && capture.dropped_bytes == 0)
            || capture.truncated != (capture.dropped_bytes > 0)
        {
            return Err(Failure::Invalid);
        }
        let challenge = load_effect(&self.connection, effect_id)?.ok_or(Failure::NotFound)?;
        if challenge.capability_id != guard::TERMINAL_RUN_ID || challenge.status != "PREPARED" {
            return Err(Failure::Unknown);
        }
        let cgroup_quiescence_digest = self.require_terminal_process_quiescence(effect_id, &challenge)?;
        let lease_id =
            load_lease_id(&self.connection, &challenge.challenge_id)?.ok_or(Failure::Unknown)?;
        let artifact_ref_value = terminal_artifact_ref_value(&capture.artifact_ref);
        let receipt_core = Value::Map(BTreeMap::from([
            ("effectID".to_owned(), Value::String(effect_id.to_owned())),
            ("challengeDigest".to_owned(), Value::String(challenge.content_digest.clone())),
            ("status".to_owned(), Value::String(status.to_owned())),
            ("exitCode".to_owned(), exit_code.map_or(Value::Nil, |value| Value::Signed(i64::from(value)))),
            ("preview".to_owned(), Value::String(preview.to_owned())),
            ("outputDigest".to_owned(), Value::String(capture.output_digest.clone())),
            ("artifactRef".to_owned(), artifact_ref_value.clone()),
            ("artifactFidelity".to_owned(), Value::String(if is_full { "FULL" } else { "SAMPLE" }.to_owned())),
            ("observedBytes".to_owned(), Value::String(capture.observed_bytes.to_string())),
            ("droppedBytes".to_owned(), Value::String(capture.dropped_bytes.to_string())),
            ("artifactTruncated".to_owned(), Value::Bool(capture.truncated)),
            ("leaseID".to_owned(), Value::String(lease_id.clone())),
            ("cgroupQuiescenceDigest".to_owned(), Value::String(cgroup_quiescence_digest.clone())),
        ]));
        let receipt_bytes = messagepack::encode(&receipt_core, FRAME_LIMITS).map_err(|_| Failure::Invalid)?;
        let receipt = digest_bytes(&receipt_bytes);
        let artifact_ref_bytes = messagepack::encode(&artifact_ref_value, FRAME_LIMITS)
            .map_err(|_| Failure::Invalid)?;
        let fidelity_label = if is_full { "FULL" } else { "SAMPLE" };
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        let changed = transaction
            .execute(
                "UPDATE effect_challenges SET status='SETTLED',after_digest=?1,receipt_digest=?2
             WHERE effect_id=?3 AND status='PREPARED'",
                params![&capture.output_digest, receipt, effect_id],
            )
            .map_err(|_| Failure::Unavailable)?;
        if changed != 1 {
            return Err(Failure::Unknown);
        }
        let terminal_changed = transaction.execute(
            "UPDATE terminal_runs SET status='SETTLED',terminal_status=?1,exit_code=?2,preview=?3,
             output=X'',output_digest=?4,artifact_ref=?5,artifact_ref_v1=?6,artifact_fidelity=?7,
             observed_bytes=?8,dropped_bytes=?9,truncated=?10,receipt_digest=?11
             WHERE effect_id=?12 AND status='PREPARED'",
            params![
                status,
                exit_code,
                preview,
                capture.output_digest,
                capture.artifact_ref.artifact_id,
                artifact_ref_bytes,
                fidelity_label,
                capture.observed_bytes.to_string(),
                capture.dropped_bytes.to_string(),
                capture.truncated as i64,
                receipt,
                effect_id
            ],
        ).map_err(|_| Failure::Unavailable)?;
        if terminal_changed != 1 {
            return Err(Failure::Unknown);
        }
        transaction.commit().map_err(|_| Failure::Unavailable)?;
        self.remove_persisted_terminal_cgroup(effect_id, &cgroup_quiescence_digest);
        let mut fields = BTreeMap::from([
            ("status".to_owned(), Value::String(status.to_owned())),
            ("preview".to_owned(), Value::String(preview.to_owned())),
            ("artifactRef".to_owned(), artifact_ref_value),
            ("receiptRef".to_owned(), Value::String(receipt)),
            ("receiptDigest".to_owned(), Value::String(receipt)),
            ("outputDigest".to_owned(), Value::String(capture.output_digest.clone())),
            ("observedBytes".to_owned(), Value::String(capture.observed_bytes.to_string())),
            ("droppedBytes".to_owned(), Value::String(capture.dropped_bytes.to_string())),
            ("artifactTruncated".to_owned(), Value::Bool(capture.truncated)),
            ("artifactFidelity".to_owned(), Value::String(fidelity_label.to_owned())),
            ("cgroupQuiescenceDigest".to_owned(), Value::String(cgroup_quiescence_digest)),
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
        let cgroup_quiescence_digest = self.require_terminal_process_quiescence(effect_id, &challenge)?;
        let code = exit_code.map(|code| code.to_string()).unwrap_or_default();
        let receipt = digest_bytes(
            format!(
                "{}:{}:{}:{}:{}",
                effect_id, status, code, challenge.content_digest, cgroup_quiescence_digest
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
        self.remove_persisted_terminal_cgroup(effect_id, &cgroup_quiescence_digest);
        Ok(map_value([
            ("status", Value::String(status.to_owned())),
            ("effectID", Value::String(effect_id.to_owned())),
            ("receiptRef", Value::String(receipt)),
            ("cgroupQuiescenceDigest", Value::String(cgroup_quiescence_digest)),
        ]))
    }

    fn require_terminal_process_quiescence(
        &self,
        effect_id: &str,
        challenge: &Challenge,
    ) -> Result<String, Failure> {
        let row: Option<(Vec<u8>, Option<String>)> = self.connection.query_row(
            "SELECT cgroup_identity,quiescence_digest FROM terminal_runs
             WHERE effect_id=?1 AND status='PREPARED'",
            [effect_id],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional().map_err(|_|Failure::Unavailable)?;
        let Some((encoded, Some(proof))) = row else { return Err(Failure::Unknown); };
        if !is_blake3_digest(&proof) { return Err(Failure::Unknown); }
        let value = crate::messagepack::decode(&encoded, FRAME_LIMITS).map_err(|_|Failure::Unknown)?;
        let identity = crate::cgroup_v2::CgroupIdentityV1::from_value(&value).map_err(|_|Failure::Unknown)?;
        if identity.effect_id != effect_id
            || identity.capability_lease_digest != challenge.capability_lease_digest.as_deref().unwrap_or_default()
            || identity.execution_principal != challenge.principal
            || identity.attempt_scope_digest != challenge.managed_attempt_digest
            || identity.process_kind != if challenge.capability_id == guard::TERMINAL_RUN_ID { "terminal_run" } else { "terminal_start" }
        { return Err(Failure::Conflict); }
        Ok(proof)
    }

    /// Remove only the cgroup identity whose terminal proof and terminal row have
    /// both committed. Cleanup failure is intentionally non-fatal: a later owner
    /// startup retries it, while the retained slot continues to count against cap.
    fn remove_persisted_terminal_cgroup(&self, effect_id: &str, proof: &str) {
        #[cfg(target_os = "linux")]
        {
            if !is_blake3_digest(proof) { return; }
            let row: Option<(String,Option<Vec<u8>>,Option<String>)> = self.connection.query_row(
                "SELECT status,cgroup_identity,quiescence_digest FROM terminal_runs WHERE effect_id=?1",
                [effect_id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
            ).optional().ok().flatten();
            let Some((status,Some(encoded),Some(stored_proof)))=row else{return};
            if status!="SETTLED" || stored_proof!=proof {return;}
            let Ok(value)=crate::messagepack::decode(&encoded,FRAME_LIMITS) else{return};
            let Ok(identity)=crate::cgroup_v2::CgroupIdentityV1::from_value(&value) else{return};
            if identity.effect_id==effect_id {
                let _=crate::cgroup_v2::ExecutionCgroupV2::remove_quiescent_if_empty(&identity,proof);
            }
        }
        #[cfg(not(target_os = "linux"))]
        { let _=(effect_id,proof); }
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

    /// Consume the ordinary user-approved editor challenge and persist its exact
    /// process/profile/target/mode pins before the HostKernel can dispatch the PTY.
    /// The process reference is a correlation token only; this method does not spawn.
    pub(crate) fn prepare_external_editor_execution(
        &mut self,
        binding: &crate::terminal_process::ExternalEditorLaunchBindingV1,
        process_ref: &crate::terminal_process::StdioProcessRefV1,
        launch_digest: &str,
        cgroup_identity_value: &Value,
    ) -> Result<ExternalEditorExecutionOutcomeV1, TypedErrorV1> {
        use crate::terminal_process::{ExternalEditorTargetKindV1, StdioProcessKindV1};
        if !is_blake3_digest(launch_digest)
            || !binding.permission_mode.validate()
            || binding.session_id != binding.permission_mode.session_id
            || binding.owner_epoch != binding.permission_mode.owner_epoch
            || binding.permission_mode.workspace_root_digest != binding.workspace_root_binding
            || binding.owner_epoch == 0 || binding.generation == 0
            || !is_blake3_digest(&binding.capability_lease_digest)
            || !is_blake3_digest(&binding.workspace_root_binding)
            || !is_blake3_digest(&binding.executable_digest)
            || !binding.profile_ref.matches_definition(&binding.profile).map_err(|_| Failure::Invalid.error())?
            || process_ref.kind() != StdioProcessKindV1::ExternalEditor
            || process_ref.execution_id() != binding.execution_id
            || process_ref.owner_epoch() != binding.owner_epoch
            || process_ref.generation() != binding.generation
            || process_ref.profile_id() != binding.profile_ref.profile_id
            || process_ref.profile_revision() != binding.profile_ref.revision
            || process_ref.profile_digest() != binding.profile_ref.profile_digest
            || process_ref.executable_digest() != binding.executable_digest
            || (binding.target.kind == ExternalEditorTargetKindV1::WorkspaceFile
                && binding.permission_mode.sandbox_mode == guard::DirectSandboxModeV1::ReadOnly)
            || (binding.target.kind == ExternalEditorTargetKindV1::WorkspaceFile
                && binding.permission_mode.sandbox_mode == guard::DirectSandboxModeV1::DangerFullAccess)
            || (binding.permission_mode.sandbox_mode == guard::DirectSandboxModeV1::DangerFullAccess
                && binding.permission_mode.approval_policy != guard::DirectApprovalPolicyV1::Never)
        {
            return Err(Failure::Denied.error());
        }
        let identity = crate::cgroup_v2::CgroupIdentityV1::from_value(cgroup_identity_value)
            .map_err(|_| Failure::Invalid.error())?;
        if identity.execution_id != binding.execution_id
            || identity.effect_id != binding.effect_id
            || identity.capability_lease_digest != binding.capability_lease_digest
            || identity.execution_principal != binding.profile_ref.profile_id
            || identity.attempt_scope_digest.is_some()
            || identity.owner_epoch != binding.owner_epoch
            || identity.process_generation != binding.generation
            || identity.process_kind != "external_editor"
            || identity.profile_id != binding.profile_ref.profile_id
            || identity.profile_revision != binding.profile_ref.revision
            || identity.profile_digest != binding.profile_ref.profile_digest
            || identity.executable_digest != binding.executable_digest
            || identity.resource_profile != "none"
        { return Err(Failure::Conflict.error()); }
        #[cfg(target_os = "linux")]
        crate::cgroup_v2::ExecutionCgroupV2::confirm_empty_before_dispatch(&identity)
            .map_err(|_| Failure::Unavailable.error())?;
        #[cfg(not(target_os = "linux"))]
        return Err(Failure::Unavailable.error());
        let cgroup_identity_bytes = crate::messagepack::encode(cgroup_identity_value, FRAME_LIMITS)
            .map_err(|_| Failure::Invalid.error())?;
        for value in [&binding.session_id, &binding.principal, &binding.location_id,
            &binding.execution_id, &binding.user_action_id, &binding.call_id,
            &binding.effect_id, &binding.challenge_id] {
            validate_identifier(value).map_err(Failure::error)?;
        }
        if binding.target.base_workspace_revision.is_empty()
            || binding.target.base_workspace_revision.len() > 256
            || binding.target.base_workspace_revision.chars().any(char::is_control)
            || match binding.target.kind {
                ExternalEditorTargetKindV1::PromptScratch => binding.target.expected_file_digest.is_some(),
                ExternalEditorTargetKindV1::WorkspaceFile => binding.target.expected_file_digest.as_deref()
                    .is_none_or(|digest| !is_blake3_digest(digest))
                    || !crate::terminal_process::valid_editor_source_relative_path(&binding.target.source_relative_path),
            }
        {
            return Err(Failure::Invalid.error());
        }
        let challenge = load_effect(&self.connection, &binding.effect_id)
            .map_err(Failure::error)?.ok_or_else(|| Failure::NotFound.error())?;
        if challenge.challenge_id != binding.challenge_id
            || challenge.capability_id != guard::EDITOR_LAUNCH_ID
            || challenge.origin_kind != ORIGIN_USER_ACTION
            || challenge.status != "APPROVED"
            || challenge.principal != binding.principal
            || challenge.session_id != binding.session_id
            || challenge.batch_id != binding.user_action_id
            || challenge.call_id != binding.call_id
            || challenge.managed_attempt_digest.is_some()
            || challenge.requested_path != binding.workspace_root.to_string_lossy()
            || challenge.resource != "."
            || challenge.expires_at_ms <= now_ms().map_err(Failure::error)?
            || challenge.capability_lease_digest.as_deref() != Some(binding.capability_lease_digest.as_str())
        {
            return Err(Failure::Conflict.error());
        }
        let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;
        let workspace = fs::canonicalize(&binding.workspace_root).map_err(|_| Failure::Denied.error())?;
        if workspace != execution.root()
            || workspace.to_str() != Some(binding.workspace_root.to_string_lossy().as_ref())
            || binding.permission_mode.workspace_root_digest != binding.workspace_root_binding
        {
            return Err(Failure::Conflict.error());
        }
        let source_path_digest = match binding.target.kind {
            ExternalEditorTargetKindV1::PromptScratch => {
                if !binding.target.source_relative_path.is_empty() { return Err(Failure::Invalid.error()); }
                digest_bytes(b"horizoncode.external-editor-prompt-scratch.v1\0")
            }
            ExternalEditorTargetKindV1::WorkspaceFile => {
                let relative = Path::new(&binding.target.source_relative_path);
                let actual_digest = execution.digest(relative).map_err(|_| Failure::Conflict.error())?;
                if binding.target.expected_file_digest.as_deref() != Some(actual_digest.as_str()) {
                    return Err(Failure::Conflict.error());
                }
                let mut preimage = b"horizoncode.external-editor-source-path.v1\0".to_vec();
                preimage.extend_from_slice(binding.target.source_relative_path.as_bytes());
                digest_bytes(&preimage)
            }
        };
        let scratch_path = Path::new(&binding.target.canonical_target_token);
        let scratch_root = fs::canonicalize(&binding.target.scratch_root).map_err(|_| Failure::Denied.error())?;
        if !scratch_path.is_absolute() || scratch_root.starts_with(&workspace) {
            return Err(Failure::Denied.error());
        }
        let (initial_scratch_digest, _) = crate::terminal_process::inspect_external_editor_scratch(
            &scratch_root, scratch_path,
        ).map_err(|_| Failure::Denied.error())?;
        if binding.target.kind == ExternalEditorTargetKindV1::WorkspaceFile
            && binding.target.expected_file_digest.as_deref() != Some(initial_scratch_digest.as_str())
        {
            return Err(Failure::Conflict.error());
        }
        let broker_binding = load_broker_process_binding(&self.connection, &binding.challenge_id)
            .map_err(Failure::error)?.ok_or_else(|| Failure::Denied.error())?;
        let executable_path = fs::canonicalize(&binding.executable_path).map_err(|_| Failure::Denied.error())?;
        if broker_binding.profile_id != binding.profile.profile_id
            || broker_binding.executable_digest != binding.executable_digest
            || broker_binding.profile_digest != binding.profile_ref.profile_digest
            || executable_path.to_str() != Some(broker_binding.executable_path.as_str())
            || crate::terminal_process::executable_digest(&executable_path)
                .map_err(|_| Failure::Denied.error())? != binding.executable_digest
        {
            return Err(Failure::Conflict.error());
        }
        let (decision, intent) = guard_broker_decision(
            execution, &challenge.session_id, &challenge.principal, &challenge.batch_id,
            &challenge.call_id, &challenge.requested_path, &challenge.resource,
            &challenge.content_digest, &broker_binding.executable_path,
            &broker_binding.executable_digest, &broker_binding.profile_digest,
            &challenge.challenge_id, &challenge.capability_id,
            guard::EffectOriginKindV1::UserAction, None, None,
        );
        if decision.decision != guard::DecisionKind::Ask || intent != challenge.argument_digest {
            return Err(Failure::Denied.error());
        }
        let target_kind = match binding.target.kind {
            ExternalEditorTargetKindV1::PromptScratch => "prompt_scratch",
            ExternalEditorTargetKindV1::WorkspaceFile => "workspace_file",
        };
        let target_digest = digest_bytes([b"horizoncode.external-editor-target.v1\0".as_slice(),
            binding.target.canonical_target_token.as_bytes()].concat().as_slice());
        let process_ref_value = process_ref.to_value();
        let process_ref_bytes = crate::messagepack::encode(&process_ref_value, FRAME_LIMITS)
            .map_err(|_| Failure::Invalid.error())?;
        let binding_value = Value::Map(BTreeMap::from([
            ("executionID".to_owned(), Value::String(binding.execution_id.clone())),
            ("effectID".to_owned(), Value::String(binding.effect_id.clone())),
            ("challengeID".to_owned(), Value::String(binding.challenge_id.clone())),
            ("sessionID".to_owned(), Value::String(binding.session_id.clone())),
            ("principal".to_owned(), Value::String(binding.principal.clone())),
            ("locationID".to_owned(), Value::String(binding.location_id.clone())),
            ("ownerEpoch".to_owned(), Value::String(binding.owner_epoch.to_string())),
            ("generation".to_owned(), Value::String(binding.generation.to_string())),
            ("userActionID".to_owned(), Value::String(binding.user_action_id.clone())),
            ("callID".to_owned(), Value::String(binding.call_id.clone())),
            ("profileID".to_owned(), Value::String(binding.profile_ref.profile_id.clone())),
            ("profileRevision".to_owned(), Value::String(binding.profile_ref.revision.to_string())),
            ("profileDigest".to_owned(), Value::String(binding.profile_ref.profile_digest.clone())),
            ("executableDigest".to_owned(), Value::String(binding.executable_digest.clone())),
            ("targetKind".to_owned(), Value::String(target_kind.to_owned())),
            ("targetDigest".to_owned(), Value::String(target_digest.clone())),
            ("sourcePathDigest".to_owned(), Value::String(source_path_digest.clone())),
            ("baseWorkspaceRevision".to_owned(), Value::String(binding.target.base_workspace_revision.clone())),
            ("expectedFileDigest".to_owned(), binding.target.expected_file_digest.clone().map_or(Value::Nil, Value::String)),
            ("permissionModeDigest".to_owned(), Value::String(binding.permission_mode.digest.clone())),
            ("permissionModeRevision".to_owned(), Value::String(binding.permission_mode.revision.to_string())),
            ("capabilityLeaseDigest".to_owned(), Value::String(binding.capability_lease_digest.clone())),
            ("launchDigest".to_owned(), Value::String(launch_digest.to_owned())),
            ("cgroupIdentityDigest".to_owned(), Value::String(digest_bytes(&cgroup_identity_bytes))),
        ]));
        let encoded = crate::messagepack::encode(&binding_value, FRAME_LIMITS)
            .map_err(|_| Failure::Invalid.error())?;
        let mut digest_preimage = b"horizoncode.external-editor-binding.v1\0".to_vec();
        digest_preimage.extend_from_slice(&encoded);
        let binding_digest = format!("blake3:{}", blake3::hash(&digest_preimage).to_hex());
        let lease_id = random_id("lease").map_err(Failure::error)?;
        let now = now_ms().map_err(Failure::error)? as i64;
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        transaction.execute(
            "INSERT INTO external_editor_runs(effect_id,challenge_id,execution_id,process_ref,binding_digest,launch_digest,profile_id,profile_revision,profile_digest,executable_digest,target_kind,target_digest,source_path_digest,base_workspace_revision,expected_file_digest,permission_mode_digest,permission_mode_revision,capability_lease_digest,cgroup_identity,status,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,'PREPARED',?20,?20)",
            params![binding.effect_id,binding.challenge_id,binding.execution_id,process_ref_bytes,binding_digest,launch_digest,binding.profile_ref.profile_id,binding.profile_ref.revision.to_string(),binding.profile_ref.profile_digest,binding.executable_digest,target_kind,target_digest,source_path_digest,binding.target.base_workspace_revision,binding.target.expected_file_digest,binding.permission_mode.digest,binding.permission_mode.revision.to_string(),binding.capability_lease_digest,cgroup_identity_bytes,now],
        ).map_err(|_| Failure::Conflict.error())?;
        let changed = transaction.execute(
            "UPDATE effect_challenges SET status='PREPARED',lease_id=?1,capability_lease_digest=?2 WHERE effect_id=?3 AND challenge_id=?4 AND status='APPROVED'",
            params![lease_id,binding.capability_lease_digest,binding.effect_id,binding.challenge_id],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(ExternalEditorExecutionOutcomeV1 {
            status: "prepared".to_owned(), effect_id: binding.effect_id.clone(),
            execution_id: binding.execution_id.clone(), binding_digest: binding_digest.clone(),
            process_ref: process_ref.clone(),
            receipt_digest: None, exit_code: None, result_file_digest: None, result_file_bytes: None,
            observed_workspace_revision: None,
        })
    }

    /// Mark the exact prepared editor as possibly dispatched. From this atomic point
    /// onward, a missing host response is UNKNOWN and can never trigger a relaunch.
    pub(crate) fn mark_external_editor_dispatching(
        &mut self,
        effect_id: &str,
        challenge_id: &str,
        execution_id: &str,
        binding_digest: &str,
    ) -> Result<(), TypedErrorV1> {
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let changed = tx.execute(
            "UPDATE external_editor_runs SET status='RUNNING',updated_at_ms=?1 WHERE effect_id=?2 AND challenge_id=?3 AND execution_id=?4 AND binding_digest=?5 AND status='PREPARED'",
            params![now_ms().map_err(Failure::error)? as i64,effect_id,challenge_id,execution_id,binding_digest],
        ).map_err(|_| Failure::Unavailable.error())?;
        let challenge_changed = tx.execute(
            "UPDATE effect_challenges SET status='RUNNING' WHERE effect_id=?1 AND challenge_id=?2 AND status='PREPARED'",
            params![effect_id,challenge_id],
        ).map_err(|_| Failure::Unavailable.error())?;
        if changed != 1 || challenge_changed != 1 { return Err(Failure::Conflict.error()); }
        tx.commit().map_err(|_| Failure::Unavailable.error())
    }

    fn external_editor_cgroup_identity(
        &self,
        binding: &crate::terminal_process::ExternalEditorLaunchBindingV1,
    ) -> Result<crate::cgroup_v2::CgroupIdentityV1, TypedErrorV1> {
        let encoded: Option<Vec<u8>> = self.connection.query_row(
            "SELECT cgroup_identity FROM external_editor_runs
             WHERE effect_id=?1 AND challenge_id=?2 AND execution_id=?3",
            params![binding.effect_id,binding.challenge_id,binding.execution_id],
            |row| row.get(0),
        ).optional().map_err(|_|Failure::Unavailable.error())?
            .ok_or_else(||Failure::NotFound.error())?;
        let encoded = encoded.ok_or_else(||Failure::Unknown.error())?;
        let value = crate::messagepack::decode(&encoded, FRAME_LIMITS)
            .map_err(|_|Failure::Unknown.error())?;
        let identity = crate::cgroup_v2::CgroupIdentityV1::from_value(&value)
            .map_err(|_|Failure::Unknown.error())?;
        if identity.execution_id != binding.execution_id
            || identity.effect_id != binding.effect_id
            || identity.capability_lease_digest != binding.capability_lease_digest
            || identity.execution_principal != binding.profile_ref.profile_id
            || identity.attempt_scope_digest.is_some()
            || identity.owner_epoch != binding.owner_epoch
            || identity.process_generation != binding.generation
            || identity.process_kind != "external_editor"
            || identity.profile_id != binding.profile_ref.profile_id
            || identity.profile_revision != binding.profile_ref.revision
            || identity.profile_digest != binding.profile_ref.profile_digest
            || identity.executable_digest != binding.executable_digest
            || identity.resource_profile != "none"
        { return Err(Failure::Conflict.error()); }
        Ok(identity)
    }

    pub(crate) fn cancel_prepared_external_editor(
        &mut self,
        effect_id: &str,
        challenge_id: &str,
        execution_id: &str,
        binding_digest: &str,
    ) -> Result<ExternalEditorExecutionOutcomeV1, TypedErrorV1> {
        let row = self.external_editor_identity(effect_id, challenge_id, execution_id)?;
        if row.0 != "PREPARED" || row.1 != binding_digest { return Err(Failure::Conflict.error()); }
        let encoded: Vec<u8> = self.connection.query_row(
            "SELECT cgroup_identity FROM external_editor_runs WHERE effect_id=?1 AND challenge_id=?2 AND execution_id=?3",
            params![effect_id,challenge_id,execution_id],|row|row.get(0),
        ).optional().map_err(|_|Failure::Unavailable.error())?.ok_or_else(||Failure::Unknown.error())?;
        let identity_value = crate::messagepack::decode(&encoded, FRAME_LIMITS).map_err(|_|Failure::Unknown.error())?;
        let identity = crate::cgroup_v2::CgroupIdentityV1::from_value(&identity_value).map_err(|_|Failure::Unknown.error())?;
        let quiescence = crate::cgroup_v2::ExecutionCgroupV2::kill_and_confirm_empty(&identity)
            .map_err(|_|Failure::Unknown.error())?;
        crate::cgroup_v2::ExecutionCgroupV2::retain_if_empty(&identity)
            .map_err(|_|Failure::Unknown.error())?;
        let receipt = editor_terminal_receipt_digest(effect_id, challenge_id, execution_id,
            binding_digest, "cancelled", None, None, None, None, &quiescence)?;
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let changed = tx.execute("UPDATE external_editor_runs SET status='CANCELLED',terminal_status='cancelled',quiescence_digest=?1,receipt_digest=?2,updated_at_ms=?3 WHERE effect_id=?4 AND status='PREPARED'",
            params![quiescence,receipt,now_ms().map_err(Failure::error)? as i64,effect_id]).map_err(|_|Failure::Unavailable.error())?;
        let challenge_changed = tx.execute("UPDATE effect_challenges SET status='SETTLED',receipt_digest=?1 WHERE effect_id=?2 AND challenge_id=?3 AND status='PREPARED'",
            params![receipt,effect_id,challenge_id]).map_err(|_|Failure::Unavailable.error())?;
        if changed != 1 || challenge_changed != 1 { return Err(Failure::Conflict.error()); }
        tx.commit().map_err(|_|Failure::Unavailable.error())?;
        let _=crate::cgroup_v2::ExecutionCgroupV2::remove_quiescent_if_empty(&identity,&quiescence);
        self.read_external_editor_outcome(effect_id, challenge_id, execution_id)
    }

    pub(crate) fn settle_external_editor_execution(
        &mut self,
        binding: &crate::terminal_process::ExternalEditorLaunchBindingV1,
        expected_binding_digest: &str,
        status: &str,
        exit_code: Option<i32>,
        observed_workspace_revision: Option<&str>,
    ) -> Result<ExternalEditorExecutionOutcomeV1, TypedErrorV1> {
        use crate::terminal_process::ExternalEditorTargetKindV1;
        if !is_blake3_digest(expected_binding_digest)
            || !matches!(status, "completed" | "cancelled" | "conflict")
            || observed_workspace_revision.is_some_and(|revision| !is_blake3_digest(revision))
            || (status == "completed" && (exit_code != Some(0) || observed_workspace_revision.is_none()))
        { return Err(Failure::Invalid.error()); }
        let (state, process_bytes, binding_digest, target_kind, target_digest, source_path_digest,
            base_revision, expected_digest, profile_id, profile_revision, profile_digest,
            executable_digest_value, mode_digest, mode_revision, lease_digest):
            (String, Vec<u8>, String, String, String, String, String, Option<String>, String,
             String, String, String, String, String, String) = self.connection.query_row(
            "SELECT status,process_ref,binding_digest,target_kind,target_digest,source_path_digest,
                    base_workspace_revision,expected_file_digest,profile_id,profile_revision,
                    profile_digest,executable_digest,permission_mode_digest,permission_mode_revision,
                    capability_lease_digest FROM external_editor_runs
             WHERE effect_id=?1 AND challenge_id=?2 AND execution_id=?3",
            params![binding.effect_id,binding.challenge_id,binding.execution_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,
                row.get(12)?,row.get(13)?,row.get(14)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        let source_kind = match binding.target.kind {
            ExternalEditorTargetKindV1::PromptScratch => "prompt_scratch",
            ExternalEditorTargetKindV1::WorkspaceFile => "workspace_file",
        };
        let expected_source_path_digest = if binding.target.kind == ExternalEditorTargetKindV1::PromptScratch {
            digest_bytes(b"horizoncode.external-editor-prompt-scratch.v1\0")
        } else {
            if !crate::terminal_process::valid_editor_source_relative_path(&binding.target.source_relative_path) {
                return Err(Failure::Invalid.error());
            }
            let mut preimage = b"horizoncode.external-editor-source-path.v1\0".to_vec();
            preimage.extend_from_slice(binding.target.source_relative_path.as_bytes());
            digest_bytes(&preimage)
        };
        let expected_target_digest = digest_bytes([b"horizoncode.external-editor-target.v1\0".as_slice(),
            binding.target.canonical_target_token.as_bytes()].concat().as_slice());
        let process_value = crate::messagepack::decode(&process_bytes, FRAME_LIMITS)
            .map_err(|_| Failure::Unknown.error())?;
        let process_ref = crate::terminal_process::StdioProcessRefV1::from_value(&process_value)
            .map_err(|_| Failure::Unknown.error())?;
        if state != "RUNNING" || binding_digest != expected_binding_digest
            || target_kind != source_kind || target_digest != expected_target_digest
            || source_path_digest != expected_source_path_digest
            || base_revision != binding.target.base_workspace_revision
            || expected_digest != binding.target.expected_file_digest
            || profile_id != binding.profile_ref.profile_id
            || profile_revision != binding.profile_ref.revision.to_string()
            || profile_digest != binding.profile_ref.profile_digest
            || executable_digest_value != binding.executable_digest
            || mode_digest != binding.permission_mode.digest
            || mode_revision != binding.permission_mode.revision.to_string()
            || lease_digest != binding.capability_lease_digest
            || process_ref.execution_id() != binding.execution_id
            || process_ref.owner_epoch() != binding.owner_epoch
            || process_ref.generation() != binding.generation
            || process_ref.profile_id() != binding.profile_ref.profile_id
            || process_ref.profile_revision() != binding.profile_ref.revision
            || process_ref.profile_digest() != binding.profile_ref.profile_digest
            || process_ref.executable_digest() != binding.executable_digest
        { return Err(Failure::Conflict.error()); }
        let challenge = load_effect(&self.connection, &binding.effect_id).map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        if challenge.challenge_id != binding.challenge_id || challenge.principal != binding.principal
            || challenge.session_id != binding.session_id || challenge.status != "RUNNING"
        { return Err(Failure::Conflict.error()); }

        let cgroup_identity = self.external_editor_cgroup_identity(binding)?;
        let quiescence = crate::cgroup_v2::ExecutionCgroupV2::kill_and_confirm_empty(&cgroup_identity)
            .map_err(|_|Failure::Unknown.error())?;
        crate::cgroup_v2::ExecutionCgroupV2::retain_if_empty(&cgroup_identity)
            .map_err(|_|Failure::Unknown.error())?;

        let mut terminal_status = status.to_owned();
        let mut result_file_digest: Option<String> = None;
        let mut result_file_bytes: Option<u64> = None;
        if status == "completed" {
            let (digest, bytes) = crate::terminal_process::inspect_external_editor_scratch(
                &binding.target.scratch_root, Path::new(&binding.target.canonical_target_token),
            ).map_err(|_| Failure::Unknown.error())?;
            result_file_digest = Some(digest);
            result_file_bytes = Some(bytes);
            if let Some(revision) = observed_workspace_revision {
                if revision != binding.target.base_workspace_revision { terminal_status = "conflict".to_owned(); }
            }
            if binding.target.kind == ExternalEditorTargetKindV1::WorkspaceFile {
                let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;
                let current_digest = execution.digest(Path::new(&binding.target.source_relative_path))
                    .map_err(|_| Failure::Unknown.error())?;
                if Some(current_digest.as_str()) != binding.target.expected_file_digest.as_deref()
                    || observed_workspace_revision != Some(binding.target.base_workspace_revision.as_str())
                { terminal_status = "conflict".to_owned(); }
            }
        }
        let receipt = editor_terminal_receipt_digest(&binding.effect_id, &binding.challenge_id,
            &binding.execution_id, &binding_digest, &terminal_status, exit_code,
            result_file_digest.as_deref(), result_file_bytes, observed_workspace_revision, &quiescence)?;
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let changed = tx.execute("UPDATE external_editor_runs SET status='SETTLED',terminal_status=?1,exit_code=?2,result_file_digest=?3,result_file_bytes=?4,observed_workspace_revision=?5,quiescence_digest=?6,receipt_digest=?7,updated_at_ms=?8 WHERE effect_id=?9 AND status='RUNNING'",
            params![terminal_status,exit_code,result_file_digest,result_file_bytes.map(|v| v as i64),observed_workspace_revision,quiescence,receipt,now_ms().map_err(Failure::error)? as i64,binding.effect_id]).map_err(|_|Failure::Unavailable.error())?;
        let challenge_changed = tx.execute("UPDATE effect_challenges SET status='SETTLED',after_digest=?1,receipt_digest=?2 WHERE effect_id=?3 AND challenge_id=?4 AND status='RUNNING'",
            params![result_file_digest,receipt,binding.effect_id,binding.challenge_id]).map_err(|_|Failure::Unavailable.error())?;
        if changed != 1 || challenge_changed != 1 { return Err(Failure::Unknown.error()); }
        tx.commit().map_err(|_|Failure::Unavailable.error())?;
        let _=crate::cgroup_v2::ExecutionCgroupV2::remove_quiescent_if_empty(&cgroup_identity,&quiescence);
        self.read_external_editor_outcome(&binding.effect_id, &binding.challenge_id, &binding.execution_id)
    }

    /// Read back only the exact bounded result retained for a completed editor.
    /// This returns bytes to HostKernel/Core but never puts them in the event journal.
    pub(crate) fn read_external_editor_result(
        &self,
        binding: &crate::terminal_process::ExternalEditorLaunchBindingV1,
        expected_binding_digest: &str,
        receipt_digest: &str,
    ) -> Result<Vec<u8>, TypedErrorV1> {
        if !is_blake3_digest(expected_binding_digest) || !is_blake3_digest(receipt_digest) {
            return Err(Failure::Invalid.error());
        }
        let (status, terminal_status, binding_digest, stored_receipt, expected_result,
            expected_bytes, target_digest, source_path_digest, source_revision, source_digest,
            quiescence_digest):
            (String, Option<String>, String, Option<String>, Option<String>, Option<i64>,
             String, String, String, Option<String>, Option<String>) = self.connection.query_row(
            "SELECT status,terminal_status,binding_digest,receipt_digest,result_file_digest,
                    result_file_bytes,target_digest,source_path_digest,base_workspace_revision,
                    expected_file_digest,quiescence_digest FROM external_editor_runs
             WHERE effect_id=?1 AND challenge_id=?2 AND execution_id=?3",
            params![binding.effect_id,binding.challenge_id,binding.execution_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,
                row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?.ok_or_else(|| Failure::NotFound.error())?;
        let expected_target = digest_bytes([b"horizoncode.external-editor-target.v1\0".as_slice(),
            binding.target.canonical_target_token.as_bytes()].concat().as_slice());
        let mut source_preimage = b"horizoncode.external-editor-source-path.v1\0".to_vec();
        source_preimage.extend_from_slice(binding.target.source_relative_path.as_bytes());
        let expected_path = if binding.target.source_relative_path.is_empty() {
            digest_bytes(b"horizoncode.external-editor-prompt-scratch.v1\0")
        } else { digest_bytes(&source_preimage) };
        if status != "SETTLED" || binding_digest != expected_binding_digest
            || terminal_status.as_deref() != Some("completed")
            || stored_receipt.as_deref() != Some(receipt_digest)
            || quiescence_digest.as_deref().is_none_or(|digest| !is_blake3_digest(digest))
            || target_digest != expected_target || source_path_digest != expected_path
            || source_revision != binding.target.base_workspace_revision
            || source_digest != binding.target.expected_file_digest
        { return Err(Failure::Conflict.error()); }
        let challenge = load_effect(&self.connection, &binding.effect_id).map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        if challenge.challenge_id != binding.challenge_id || challenge.principal != binding.principal
            || challenge.session_id != binding.session_id || challenge.status != "SETTLED"
            || challenge.receipt_digest.as_deref() != Some(receipt_digest)
        { return Err(Failure::Denied.error()); }
        let bytes = crate::terminal_process::read_external_editor_scratch(
            &binding.target.scratch_root, Path::new(&binding.target.canonical_target_token),
        ).map_err(|_| Failure::Unknown.error())?;
        let actual_digest = format!("blake3:{}", blake3::hash(&bytes).to_hex());
        if expected_result.as_deref() != Some(actual_digest.as_str())
            || expected_bytes != Some(bytes.len() as i64)
        { return Err(Failure::Unknown.error()); }
        Ok(bytes)
    }

    pub(crate) fn mark_external_editor_unknown(
        &mut self, effect_id: &str, challenge_id: &str, execution_id: &str,
    ) -> Result<(), TypedErrorV1> {
        let encoded: Option<Vec<u8>> = self.connection.query_row(
            "SELECT cgroup_identity FROM external_editor_runs WHERE effect_id=?1 AND challenge_id=?2 AND execution_id=?3",
            params![effect_id,challenge_id,execution_id],|row|row.get(0),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let quiescence = encoded.and_then(|bytes| crate::messagepack::decode(&bytes,FRAME_LIMITS).ok())
            .and_then(|value| crate::cgroup_v2::CgroupIdentityV1::from_value(&value).ok())
            .and_then(|identity| {
                let proof = crate::cgroup_v2::ExecutionCgroupV2::kill_and_confirm_empty(&identity).ok()?;
                crate::cgroup_v2::ExecutionCgroupV2::retain_if_empty(&identity).ok()?;
                Some(proof)
            });
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let changed = tx.execute("UPDATE external_editor_runs SET status='UNKNOWN',quiescence_digest=COALESCE(?1,quiescence_digest),updated_at_ms=?2 WHERE effect_id=?3 AND challenge_id=?4 AND execution_id=?5 AND status IN ('PREPARED','RUNNING','UNKNOWN')",
            params![quiescence,now_ms().map_err(Failure::error)? as i64,effect_id,challenge_id,execution_id]).map_err(|_|Failure::Unavailable.error())?;
        let challenge_changed = tx.execute("UPDATE effect_challenges SET status='UNKNOWN' WHERE effect_id=?1 AND challenge_id=?2 AND status IN ('PREPARED','RUNNING','UNKNOWN')",
            params![effect_id,challenge_id]).map_err(|_|Failure::Unavailable.error())?;
        if changed != 1 || challenge_changed != 1 { return Err(Failure::Conflict.error()); }
        tx.commit().map_err(|_|Failure::Unavailable.error())
    }

    pub(crate) fn reconcile_external_editor_execution(
        &self,
        binding: &crate::terminal_process::ExternalEditorLaunchBindingV1,
        expected_binding_digest: &str,
    ) -> Result<ExternalEditorExecutionOutcomeV1, TypedErrorV1> {
        if !is_blake3_digest(expected_binding_digest) { return Err(Failure::Invalid.error()); }
        let challenge = load_effect(&self.connection, &binding.effect_id).map_err(Failure::error)?
            .ok_or_else(|| Failure::NotFound.error())?;
        let identity = self.external_editor_identity(&binding.effect_id, &binding.challenge_id, &binding.execution_id)?;
        if challenge.challenge_id != binding.challenge_id || challenge.principal != binding.principal
            || challenge.session_id != binding.session_id || challenge.capability_id != guard::EDITOR_LAUNCH_ID
            || identity.1 != expected_binding_digest
        { return Err(Failure::Denied.error()); }
        self.read_external_editor_outcome(&binding.effect_id, &binding.challenge_id, &binding.execution_id)
    }

    fn external_editor_identity(&self, effect_id: &str, challenge_id: &str, execution_id: &str) -> Result<(String,String), TypedErrorV1> {
        self.connection.query_row("SELECT status,binding_digest FROM external_editor_runs WHERE effect_id=?1 AND challenge_id=?2 AND execution_id=?3",
            params![effect_id,challenge_id,execution_id],|row|Ok((row.get(0)?,row.get(1)?)))
            .optional().map_err(|_|Failure::Unavailable.error())?.ok_or_else(||Failure::NotFound.error())
    }

    fn read_external_editor_outcome(&self, effect_id: &str, challenge_id: &str, execution_id: &str) -> Result<ExternalEditorExecutionOutcomeV1, TypedErrorV1> {
        let row: (String,Vec<u8>,String,Option<String>,Option<i32>,Option<String>,Option<i64>,Option<String>,Option<String>,Option<String>) = self.connection.query_row(
            "SELECT status,process_ref,binding_digest,receipt_digest,exit_code,result_file_digest,result_file_bytes,observed_workspace_revision,terminal_status,quiescence_digest FROM external_editor_runs WHERE effect_id=?1 AND challenge_id=?2 AND execution_id=?3",
            params![effect_id,challenge_id,execution_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?)))
            .optional().map_err(|_|Failure::Unavailable.error())?.ok_or_else(||Failure::NotFound.error())?;
        let process_value = crate::messagepack::decode(&row.1, FRAME_LIMITS).map_err(|_|Failure::Unknown.error())?;
        let process_ref = crate::terminal_process::StdioProcessRefV1::from_value(&process_value).map_err(|_|Failure::Unknown.error())?;
        let status = row.8.unwrap_or_else(|| match row.0.as_str() {
            "PREPARED" => "prepared", "RUNNING" => "running", "UNKNOWN" => "unknown",
            "CANCELLED" => "cancelled", "SETTLED" => "settled", _ => "unknown",
        }.to_owned());
        if row.0 == "UNKNOWN" && row.3.is_some() || row.0 != "UNKNOWN" && row.0 != "PREPARED" && row.0 != "RUNNING" && row.3.is_none()
            || matches!(row.0.as_str(),"SETTLED"|"CANCELLED") && row.9.as_deref().is_none_or(|digest| !is_blake3_digest(digest))
            || row.9.as_deref().is_some_and(|digest| !is_blake3_digest(digest))
            || row.6.is_some_and(|value| value < 0)
            || row.0 == "SETTLED" && row.5.is_some() != row.6.is_some()
        {
            return Err(Failure::Unknown.error());
        }
        if matches!(row.0.as_str(),"SETTLED"|"CANCELLED") {
            let terminal_status = row.8.as_deref().ok_or_else(||Failure::Unknown.error())?;
            let receipt = editor_terminal_receipt_digest(
                effect_id, challenge_id, execution_id, &row.2, terminal_status, row.4,
                row.5.as_deref(), row.6.map(|bytes|bytes as u64), row.7.as_deref(),
                row.9.as_deref().ok_or_else(||Failure::Unknown.error())?,
            )?;
            if row.3.as_deref() != Some(receipt.as_str()) { return Err(Failure::Unknown.error()); }
            let challenge = load_effect(&self.connection,effect_id).map_err(Failure::error)?
                .ok_or_else(||Failure::Unknown.error())?;
            if challenge.challenge_id != challenge_id || challenge.status != "SETTLED"
                || challenge.receipt_digest.as_deref() != Some(receipt.as_str())
            { return Err(Failure::Unknown.error()); }
        }
        Ok(ExternalEditorExecutionOutcomeV1 { status, effect_id:effect_id.to_owned(), execution_id:execution_id.to_owned(),
            binding_digest: row.2, process_ref,receipt_digest:row.3,exit_code:row.4,result_file_digest:row.5,
            result_file_bytes:row.6.map(|value| value as u64), observed_workspace_revision:row.7 })
    }

    /// Pin the host-created CodeMode helper to the already consumed outer effect.
    /// This is deliberately private: only HostKernel can construct the authority.
    pub(crate) fn register_code_mode_execution(
        &mut self,
        authority: &CodeModeExecutionAuthorityV1,
    ) -> Result<(), TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        validate_effect_request_deadline(authority.deadline_unix_ms).map_err(Failure::error)?;
        let now_unix=now_ms().map_err(Failure::error)?;
        let scope_digest = codemode_authority_scope_digest(&authority.authority_scope, &authority.session_id, &authority.location_id)?;
        if !is_blake3_digest(&authority.capability_lease_digest)
            || !is_blake3_digest(&authority.enablement_digest)
            || !guard::is_sha256_digest(&authority.helper_digest)
            || !is_blake3_digest(&authority.policy_digest)
            || !guard::is_sha256_digest(&authority.turn_context_digest)
            || !is_blake3_digest(&authority.resource_profile_digest)
            || authority.resource_profile_digest != crate::terminal_process::CodeModeResourceProfileV1::digest()
            || authority.deadline_unix_ms.saturating_sub(now_unix)>30_000
            || authority.tool_set_digest != crate::codemode_protocol::authorized_tool_set_digest(&authority.authorized_tools).unwrap_or_default()
            || matches!(&authority.authority_scope, CodeModeAuthorityScopeV1::ManagedAttempt(scope)
                if scope.location_id() != authority.location_id || scope.session_id() != authority.session_id)
            || matches!(&authority.authority_scope, CodeModeAuthorityScopeV1::ManagedAttempt(_)
                if authority.direct_turn_scope_digest.is_some())
            || matches!(&authority.authority_scope, CodeModeAuthorityScopeV1::DirectSession { workspace_revision_digest, direct_session_grant_digest }
                if !is_blake3_digest(workspace_revision_digest) || direct_session_grant_digest.as_ref().is_some_and(|d| !is_blake3_digest(d)))
            || authority.direct_turn_scope_digest.as_ref().is_some_and(|digest| !is_blake3_digest(digest))
        { return Err(Failure::Denied.error()); }
        let outer: Option<(String,String,String,String,String,String,String,String,String,i64,i64,Option<String>)> = self.connection.query_row(
            "SELECT c.effect_id,c.challenge_id,c.principal,c.session_id,c.capability_id,c.status,c.capability_lease_digest,
                    s.status,s.location_id,s.owner_epoch,s.generation,s.attempt_scope_digest
             FROM effect_challenges c JOIN stdio_executions s ON s.execution_id=?1
             WHERE c.effect_id=?2 AND c.challenge_id=?3 AND c.principal=?4 AND c.session_id=?5",
            params![authority.execution_id, authority.effect_id, authority.challenge_id, authority.principal, authority.session_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        let Some((effect,challenge,principal,session,capability,challenge_status,lease,execution_status,location,epoch,generation,stored_scope)) = outer else {
            return Err(Failure::NotFound.error());
        };
        let outer_scope_matches = match (&authority.authority_scope, stored_scope.as_deref()) {
            (CodeModeAuthorityScopeV1::ManagedAttempt(scope), Some(stored)) =>
                attempt_scope_digest(Some(scope), &authority.session_id).ok().flatten().as_deref() == Some(stored),
            (CodeModeAuthorityScopeV1::DirectSession { .. }, None) => true,
            _ => false,
        };
        if effect != authority.effect_id || challenge != authority.challenge_id || principal != authority.principal
            || session != authority.session_id || capability != guard::CODE_MODE_EXECUTE_ID
            || challenge_status != "PREPARED" || lease.as_deref() != Some(authority.capability_lease_digest.as_str())
            || execution_status != "RUNNING" || location != authority.location_id
            || epoch != authority.owner_epoch as i64 || generation != authority.generation as i64
            || !outer_scope_matches
        { return Err(Failure::Conflict.error()); }
        let now = now_ms().map_err(Failure::error)? as i64;
        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let existing: Option<(String,String,String,String,String,String)> = transaction.query_row(
            "SELECT execution_id,effect_id,challenge_id,attempt_scope_digest,tool_set_digest,helper_digest FROM code_mode_runs WHERE request_id=?1",
            [&authority.request_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        if let Some((execution,effect,challenge,scope,tools,helper_digest)) = existing {
            if execution != authority.execution_id || effect != authority.effect_id || challenge != authority.challenge_id
                || scope != scope_digest || tools != authority.tool_set_digest || helper_digest != authority.helper_digest { return Err(Failure.Conflict.error()); }
            transaction.commit().map_err(|_| Failure::Unavailable.error())?;
            return Ok(());
        }
        transaction.execute(
            "INSERT INTO code_mode_runs(request_id,execution_id,effect_id,challenge_id,principal,session_id,location_id,
              owner_epoch,generation,capability_lease_digest,attempt_scope_digest,direct_turn_scope_digest,tool_set_digest,
              enablement_digest,helper_digest,resource_profile_digest,policy_digest,turn_context_digest,deadline_unix_ms,status,created_at_ms,updated_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,'READY',?20,?20)",
            params![authority.request_id,authority.execution_id,authority.effect_id,authority.challenge_id,authority.principal,
                authority.session_id,authority.location_id,authority.owner_epoch as i64,authority.generation as i64,
                authority.capability_lease_digest,scope_digest,authority.direct_turn_scope_digest,authority.tool_set_digest,
                authority.enablement_digest,authority.helper_digest,authority.resource_profile_digest,authority.policy_digest,authority.turn_context_digest,
                authority.deadline_unix_ms as i64,now],
        ).map_err(|_| Failure::Unavailable.error())?;
        transaction.commit().map_err(|_| Failure::Unavailable.error())
    }

    /// Admit one helper wave through ordinary all-or-none ToolBatch Guard admission.
    /// Reservation precedes admission, so a crash or lost response fences the run.
    pub(crate) fn prepare_code_mode_wave(
        &mut self,
        authority: &CodeModeExecutionAuthorityV1,
        frame: &crate::codemode_protocol::CodeModeFrameV1,
        classifications: &[CodeModeWaveCallClassificationV1],
    ) -> Result<CodeModeWaveAdmissionV1, TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        self.validate_code_mode_authority_pins(authority)?;
        let crate::codemode_protocol::CodeModeFrameV1::WaveRequest(request) = frame else { return Err(Failure::Invalid.error()) };
        frame.to_json_line().map_err(|_| Failure::Invalid.error())?;
        if request.request_id != authority.request_id { return Err(Failure::Denied.error()); }
        let scope_digest = codemode_wave_scope_digest(&authority.authority_scope, &authority.session_id, &authority.location_id)?;
        let authority_digest = codemode_authority_scope_digest(&authority.authority_scope, &authority.session_id, &authority.location_id)?;
        let frame_bytes = frame.to_json_line().map_err(|_| Failure::Invalid.error())?;
        let frame_digest = digest_bytes(&frame_bytes);
        let batch_id = format!("cmb_{}", &blake3::hash(format!("{}:{}", authority.request_id, request.wave_index).as_bytes()).to_hex()[..32]);
        let argument_bytes = request.calls.iter().try_fold(0usize, |sum, call| sum.checked_add(call.argument_bytes))
            .ok_or_else(|| Failure::Invalid.error())?;
        if request.calls.is_empty() || request.calls.len() > crate::codemode_protocol::MAX_CALLS_PER_WAVE
            || classifications.len() != request.calls.len()
            || argument_bytes > crate::codemode_protocol::MAX_WAVE_ARGUMENT_BYTES
            || request.calls.iter().any(|call| authority.authorized_tools.iter().find(|tool| tool.tool_name == call.tool_name)
                .is_none_or(|tool| tool.capability_id != call.capability_id))
        { return Err(Failure::Denied.error()); }
        if request.calls.iter().zip(classifications).any(|(call, classification)|
            call.call_id != classification.call_id)
        { return Err(Failure::Conflict.error()); }
        let now = now_ms().map_err(Failure::error)? as i64;
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let run: Option<(String,String,String,String,String,i64,i64,i64,i64,i64,String)> = tx.query_row(
            "SELECT effect_id,challenge_id,principal,session_id,location_id,owner_epoch,generation,next_wave,total_calls,total_argument_bytes,status
             FROM code_mode_runs WHERE request_id=?1 AND execution_id=?2 AND capability_lease_digest=?3 AND attempt_scope_digest=?4",
            params![authority.request_id,authority.execution_id,authority.capability_lease_digest,authority_digest],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        let Some((effect,challenge,principal,session,location,epoch,generation,next_wave,total_calls,total_args,status)) = run else { return Err(Failure::NotFound.error()) };
        if effect != authority.effect_id || challenge != authority.challenge_id || principal != authority.principal
            || session != authority.session_id || location != authority.location_id || epoch != authority.owner_epoch as i64
            || generation != authority.generation as i64 || next_wave != request.wave_index as i64 || status != "READY"
            || authority.deadline_unix_ms <= now as u64
        { return Err(Failure::Conflict.error()); }
        let new_calls = (total_calls as usize).checked_add(request.calls.len()).ok_or_else(|| Failure::Invalid.error())?;
        let new_args = (total_args as usize).checked_add(argument_bytes).ok_or_else(|| Failure::Invalid.error())?;
        if new_calls > crate::codemode_protocol::MAX_TOTAL_CALLS || new_args > crate::codemode_protocol::MAX_TOTAL_ARGUMENT_BYTES
        { return Err(Failure::Denied.error()); }
        tx.execute("INSERT INTO code_mode_waves(request_id,wave_index,batch_id,frame_digest,call_count,argument_bytes,status,scope_digest,created_at_ms,updated_at_ms)
            VALUES (?1,?2,?3,?4,?5,?6,'RESERVED',?7,?8,?8)",
            params![authority.request_id,request.wave_index as i64,batch_id,frame_digest,request.calls.len() as i64,argument_bytes as i64,scope_digest,now])
            .map_err(|_| Failure::Conflict.error())?;
        for (call_index, call) in request.calls.iter().enumerate() {
            let arguments = json_map_to_wire(&call.arguments).ok_or_else(|| Failure::Invalid.error())?;
            let encoded = messagepack::encode(&arguments, FRAME_LIMITS).map_err(|_| Failure::Invalid.error())?;
            tx.execute(
                "INSERT INTO code_mode_wave_calls(request_id,wave_index,call_index,call_id,tool_name,capability_id,call_kind,arguments_digest) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![authority.request_id,request.wave_index as i64,call_index as i64,call.call_id,call.tool_name,call.capability_id,classifications[call_index].kind.as_str(),digest_bytes(&encoded)],
            ).map_err(|_| Failure::Conflict.error())?;
        }
        let run_changed=tx.execute("UPDATE code_mode_runs SET status='WAVE_PENDING',total_calls=?1,total_argument_bytes=?2,updated_at_ms=?3 WHERE request_id=?4 AND status='READY'",
            params![new_calls as i64,new_args as i64,now,authority.request_id]).map_err(|_| Failure::Unavailable.error())?;
        if run_changed!=1{return Err(Failure::Conflict.error())}
        tx.commit().map_err(|_| Failure::Unavailable.error())?;
        let calls = request.calls.iter().enumerate().map(|(index,call)| {
            let arguments = json_map_to_wire(&call.arguments).ok_or_else(|| Failure::Invalid.error())?;
            Ok(Value::Map(BTreeMap::from([
                ("callId".into(),Value::String(call.call_id.clone())),
                ("capabilityId".into(),Value::String(call.capability_id.clone())),
                ("kind".into(),Value::String(classifications[index].kind.as_str().to_owned())),
                ("arguments".into(),arguments),
            ])))
        }).collect::<Result<Vec<_>,TypedErrorV1>>()?;
        let mut body = BTreeMap::from([
            ("sessionId".into(),Value::String(authority.session_id.clone())),
            ("batchId".into(),Value::String(batch_id.clone())),
            ("turnContextDigest".into(),Value::String(authority.turn_context_digest.clone())),
            ("calls".into(),Value::Array(calls)),
        ]);
        if let CodeModeAuthorityScopeV1::ManagedAttempt(scope) = &authority.authority_scope {
            body.insert(scope.field_name().into(), scope.wire_value());
        }
        let batch = match self.prepare_tool_batch(&authority.session_id,&authority.principal,&Value::Map(std::mem::take(&mut body)),authority.deadline_unix_ms) {
            Ok(value) => value,
            Err(error) => { self.fence_code_mode_unknown(&authority.request_id,&batch_id)?; return Err(error.error()); }
        };
        if matches!(&batch,Value::Map(fields) if matches!(fields.get("status"),Some(Value::String(status)) if status == "denied")) {
            // `prepare_tool_batch` returns denied only for an all-or-none preflight
            // decision before challenge persistence or dispatch. Keep the reservation
            // available for `reject_code_mode_wave_before_dispatch`, which persists
            // the exact per-call terminal decisions and receipt projections.
            return Err(Failure::Denied.error());
        }
        self.connection.execute("UPDATE code_mode_waves SET status='ADMITTED',updated_at_ms=?1 WHERE request_id=?2 AND batch_id=?3 AND status='RESERVED'",
            params![now_ms().map_err(Failure::error)? as i64,authority.request_id,batch_id]).map_err(|_| Failure::Unknown.error())?;
        Ok(CodeModeWaveAdmissionV1 { batch_id, wave_index:request.wave_index,total_calls:new_calls as u64,total_argument_bytes:new_args as u64,batch })
    }

    /// Return the exact originally-admitted call identities for a retained wave.
    /// HostKernel invokes this only after resolving `authority` from authenticated
    /// owner state; this projection neither authorizes nor dispatches effects.
    pub(crate) fn inspect_code_mode_wave_calls(
        &self,
        authority: &CodeModeExecutionAuthorityV1,
        wave_index: u8,
    ) -> Result<CodeModeWaveInspectionV1, TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        if wave_index > 63 { return Err(Failure::Invalid.error()); }
        let wave: Option<(String, String, String, String, i64)> = self.connection.query_row(
            "SELECT batch_id,frame_digest,status,scope_digest,call_count FROM code_mode_waves
             WHERE request_id=?1 AND wave_index=?2",
            params![authority.request_id, wave_index as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        let Some((batch_id, frame_digest, status, scope_digest, call_count)) = wave else {
            return Err(Failure::NotFound.error());
        };
        if !matches!(status.as_str(), "RESERVED" | "ADMITTED" | "BOUND" | "SETTLED" | "REJECTED" | "CANCELLED" | "UNKNOWN")
            || !is_blake3_digest(&frame_digest) || !is_blake3_digest(&scope_digest)
            || call_count <= 0 || call_count as usize > crate::codemode_protocol::MAX_CALLS_PER_WAVE
            || validate_identifier(&batch_id).is_err()
        { return Err(Failure::Unknown.error()); }
        let mut statement = self.connection.prepare(
            "SELECT call_index,call_id,tool_name,capability_id,call_kind,arguments_digest FROM code_mode_wave_calls
             WHERE request_id=?1 AND wave_index=?2 ORDER BY call_index",
        ).map_err(|_| Failure::Unavailable.error())?;
        let rows = statement.query_map(params![authority.request_id, wave_index as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?))
        }).map_err(|_| Failure::Unavailable.error())?;
        let stored = rows.collect::<Result<Vec<_>, _>>().map_err(|_| Failure::Unavailable.error())?;
        if stored.len() != call_count as usize { return Err(Failure::Unknown.error()); }
        let mut calls = Vec::with_capacity(stored.len());
        for (expected, (index, call_id, tool_name, capability_id, dispatch_kind, arguments_digest)) in stored.into_iter().enumerate() {
            let Some(dispatch_kind) = CodeModeWaveCallKindV1::parse(&dispatch_kind) else { return Err(Failure::Unknown.error()); };
            if index != expected as i64 || validate_identifier(&call_id).is_err()
                || validate_identifier(&tool_name).is_err() || validate_identifier(&capability_id).is_err()
                || !is_blake3_digest(&arguments_digest)
            { return Err(Failure::Unknown.error()); }
            calls.push(CodeModeWaveCallIdentityV1 {
                call_index: index as u8, call_id, tool_name, capability_id, dispatch_kind, arguments_digest,
            });
        }
        Ok(CodeModeWaveInspectionV1 { batch_id, frame_digest, status, scope_digest, calls })
    }

    /// Bind all admitted effects to the authenticated next turn/Attempt scope. The
    /// caller appends its durable DirectTurnJournal or OwnerLog event first; leases
    /// remain unavailable until this succeeds.
    pub(crate) fn bind_code_mode_wave(
        &mut self,
        authority: &CodeModeExecutionAuthorityV1,
        batch_id: &str,
        refreshed_scope: &CodeModeAuthorityScopeV1,
        refreshed_direct_turn_scope_digest: Option<&str>,
        wave_digest: &str,
        edges: &[ManagedEffectWaveEdgeV1],
    ) -> Result<(), TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        self.validate_code_mode_authority_pins(authority)?;
        if !is_blake3_digest(wave_digest)
            || matches!(refreshed_scope, CodeModeAuthorityScopeV1::ManagedAttempt(scope)
                if scope.session_id() != authority.session_id || scope.location_id() != authority.location_id)
            || matches!(refreshed_scope, CodeModeAuthorityScopeV1::DirectSession { workspace_revision_digest, direct_session_grant_digest }
                if !is_blake3_digest(workspace_revision_digest)
                    || direct_session_grant_digest.as_ref().is_some_and(|d| !is_blake3_digest(d)))
            || matches!(refreshed_scope, CodeModeAuthorityScopeV1::ManagedAttempt(_)
                if refreshed_direct_turn_scope_digest.is_some())
            || refreshed_direct_turn_scope_digest.is_some_and(|digest| !is_blake3_digest(digest))
            || std::mem::discriminant(&authority.authority_scope) != std::mem::discriminant(refreshed_scope)
        { return Err(Failure::Invalid.error()); }
        let previous_digest = codemode_wave_scope_digest(&authority.authority_scope,&authority.session_id,&authority.location_id)?;
        let refreshed_digest = codemode_wave_scope_digest(refreshed_scope,&authority.session_id,&authority.location_id)?;
        let wave: Option<(i64,String,String,Option<String>,Option<String>)> = self.connection.query_row(
            "SELECT wave_index,status,scope_digest,direct_turn_scope_digest,wave_digest FROM code_mode_waves WHERE request_id=?1 AND batch_id=?2",
            params![authority.request_id,batch_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((_,status,old_scope,old_direct_turn_digest,old_wave_digest))=wave else{return Err(Failure::NotFound.error())};
        if status=="BOUND" {
            if old_wave_digest.as_deref()==Some(wave_digest) && old_scope==refreshed_digest
                && old_direct_turn_digest.as_deref()==refreshed_direct_turn_scope_digest{return Ok(())}
            return Err(Failure::Conflict.error());
        }
        if status!="ADMITTED" || old_scope!=previous_digest {return Err(Failure::Conflict.error())}
        let candidates=self.approved_batch_effect_candidates(&authority.session_id,&authority.principal,batch_id,&{
            let mut s=self.connection.prepare("SELECT challenge_id FROM effect_challenges WHERE batch_id=?1 AND session_id=?2 AND principal=?3 ORDER BY call_index").map_err(|_|Failure::Unavailable.error())?;
            let rows=s.query_map(params![batch_id,authority.session_id,authority.principal],|r|r.get::<_,String>(0)).map_err(|_|Failure::Unavailable.error())?;
            rows.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable.error())?
        })?;
        if candidates.is_empty() || candidates.len()>crate::codemode_protocol::MAX_CALLS_PER_WAVE {return Err(Failure::Conflict.error())}
        match (&authority.authority_scope, refreshed_scope) {
            (CodeModeAuthorityScopeV1::ManagedAttempt(previous), CodeModeAuthorityScopeV1::ManagedAttempt(refreshed)) => {
                self.transition_batch_attempt_scope(&authority.session_id,&authority.principal,batch_id,
                    &candidates.iter().map(|c|c.effect_id.clone()).collect::<Vec<_>>(),previous,refreshed)?;
                self.validate_approved_batch_effect_wave(&authority.session_id,&authority.principal,batch_id,&refreshed_digest,wave_digest,edges)?;
            }
            (CodeModeAuthorityScopeV1::DirectSession { .. }, CodeModeAuthorityScopeV1::DirectSession { .. }) => {
                if !edges.is_empty() { return Err(Failure::Invalid.error()); }
            }
            _ => return Err(Failure::Denied.error()),
        }
        let changed=self.connection.execute("UPDATE code_mode_waves SET status='BOUND',scope_digest=?1,direct_turn_scope_digest=?2,wave_digest=?3,updated_at_ms=?4 WHERE request_id=?5 AND batch_id=?6 AND status='ADMITTED'",
            params![refreshed_digest,refreshed_direct_turn_scope_digest,wave_digest,now_ms().map_err(Failure::error)? as i64,authority.request_id,batch_id]).map_err(|_|Failure::Unavailable.error())?;
        if changed!=1{return Err(Failure::Conflict.error())}
        Ok(())
    }

    /// Settle one complete ordered wave. Dispatch kind comes only from the retained
    /// reservation; effect receipt identity is resolved from EffectHost's durable
    /// challenge/lease/receipt rows, while host callbacks accept only a bounded Core
    /// output digest/byte-count report. The ordered rows and cursor advance atomically.
    pub(crate) fn settle_code_mode_wave(
        &mut self,
        authority: &CodeModeExecutionAuthorityV1,
        batch_id: &str,
        outcomes: &[CodeModeWaveCallReportV1],
    ) -> Result<CodeModeWaveOutcomeV1, TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        self.validate_code_mode_authority_pins(authority)?;
        validate_identifier(batch_id).map_err(Failure::error)?;
        if outcomes.is_empty() || outcomes.len()>crate::codemode_protocol::MAX_CALLS_PER_WAVE {
            return Err(Failure::Invalid.error());
        }
        let wave: Option<(i64,String,i64,String)> = self.connection.query_row(
            "SELECT wave_index,status,call_count,frame_digest FROM code_mode_waves WHERE request_id=?1 AND batch_id=?2",
            params![authority.request_id,batch_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((index,status,count,frame_digest))=wave else{return Err(Failure::NotFound.error())};
        if status=="SETTLED" {
            let stored=self.read_code_mode_wave_outcome(&authority.request_id,index as u8,batch_id)?;
            if stored.results.len()!=outcomes.len() || stored.results.iter().zip(outcomes).any(|(stored,input)|
                stored.call_id!=input.call_id || input.status!="settled" || input.error_code.is_some()) {
                return Err(Failure::Conflict.error());
            }
            return Ok(stored);
        }
        if status!="BOUND" || count<=0 || count as usize!=outcomes.len() || !is_blake3_digest(&frame_digest) {
            return Err(Failure::Conflict.error());
        }
        let rows={
            let mut statement=self.connection.prepare("SELECT c.call_index,c.call_id,c.call_kind,e.effect_id,e.status,e.lease_id,e.receipt_digest
                FROM code_mode_wave_calls c LEFT JOIN effect_challenges e ON e.batch_id=?3 AND e.session_id=?4 AND e.principal=?5
                    AND e.call_id=c.call_id AND e.call_index=c.call_index
                WHERE c.request_id=?1 AND c.wave_index=?2 ORDER BY c.call_index")
                .map_err(|_|Failure::Unavailable.error())?;
            let rows=statement.query_map(params![authority.request_id,index,batch_id,authority.session_id,authority.principal],|row|
                Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,Option<String>>(5)?,row.get::<_,Option<String>>(6)?)))
                .map_err(|_|Failure::Unavailable.error())?;
            rows.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable.error())?
        };
        if rows.len()!=outcomes.len(){return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error()))}
        let mut total_output=0u64;
        let mut results=Vec::with_capacity(outcomes.len());
        let mut receipt_tuples=Vec::with_capacity(outcomes.len());
        for (expected,(call_index,call_id,kind_text,effect_id,challenge_status,lease_id,receipt_digest)) in rows.into_iter().enumerate(){
            let input=&outcomes[expected];
            let Some(kind)=CodeModeWaveCallKindV1::parse(&kind_text) else {
                return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error()))
            };
            if call_index!=expected as i64 || input.call_id!=call_id || input.status!="settled"
                || input.output_digest.is_some()!=input.output_bytes.is_some()
                || input.output_digest.as_deref().is_some_and(|digest|!is_blake3_digest(digest))
                || input.output_bytes.is_some_and(|bytes|bytes as usize>crate::codemode_protocol::MAX_OUTPUT_BYTES)
                || input.error_code.as_deref().is_some_and(|code|code.is_empty()||code.len()>128||!code.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b))) {
                return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error()))
            }
            total_output=total_output.checked_add(input.output_bytes.unwrap_or(0)).ok_or_else(||Failure::Invalid.error())?;
            if total_output>crate::codemode_protocol::MAX_OUTPUT_BYTES as u64{return self.fence_code_mode_unknown(&authority.request_id,batch_id)}
            let (receipt_kind,receipt_ref,receipt_digest)=match kind {
                CodeModeWaveCallKindV1::Effect => {
                    let (Some(effect_id),Some(_lease),Some(digest))=(effect_id,lease_id,receipt_digest) else {
                        return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error()))
                    };
                    if challenge_status.as_deref()!=Some("SETTLED")||!is_blake3_digest(&digest){
                        return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error()))
                    }
                    ("effect_receipt",effect_id,digest)
                }
                CodeModeWaveCallKindV1::HostCallback => {
                    if effect_id.is_some()||challenge_status.is_some()||lease_id.is_some()||receipt_digest.is_some(){
                        return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error()))
                    }
                    let output_digest=input.output_digest.as_deref().unwrap_or("none");
                    let output_bytes=input.output_bytes.unwrap_or(0);
                    let digest=codemode_tool_result_receipt_digest(&authority.request_id,batch_id,index as u8,expected as u8,&call_id,output_digest,output_bytes,input.error_code.as_deref());
                    let reference=codemode_tool_result_receipt_ref(&authority.request_id,batch_id,index as u8,expected as u8,&call_id);
                    ("tool_result",reference,digest)
                }
            };
            receipt_tuples.push(CodeModeWaveReceiptTupleV1 { call_index: expected as u8, call_id: call_id.clone(), status: "settled".into(), receipt_kind: receipt_kind.into(), receipt_ref: receipt_ref.clone(), receipt_digest: receipt_digest.clone() });
            results.push(CodeModeWaveCallResultV1{call_id,status:"settled".to_owned(),output:None,output_bytes:input.output_bytes,output_digest:input.output_digest.clone(),receipt_kind:Some(receipt_kind.into()),receipt_ref:Some(receipt_ref),receipt_digest:Some(receipt_digest),error_code:input.error_code.clone()});
        }
        if total_output>crate::codemode_protocol::MAX_OUTPUT_BYTES as u64{return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error()))}
        let aggregate=codemode_wave_receipt_digest(batch_id,&receipt_tuples);
        let previous:i64=self.connection.query_row("SELECT total_output_bytes FROM code_mode_runs WHERE request_id=?1 AND status='WAVE_PENDING'",[&authority.request_id],|row|row.get(0)).optional().map_err(|_|Failure::Unavailable.error())?.ok_or_else(||Failure::Conflict.error())?;
        let total=(previous as u64).checked_add(total_output).ok_or_else(||Failure::Invalid.error())?;
        if total>crate::codemode_protocol::MAX_OUTPUT_BYTES as u64{return self.fence_code_mode_unknown(&authority.request_id,batch_id)}
        let tx=self.connection.transaction().map_err(|_|Failure::Unavailable.error())?;
        for (call_index,row) in results.iter().enumerate(){
            tx.execute("INSERT INTO code_mode_wave_results(request_id,wave_index,call_index,call_id,status,output,output_digest,output_bytes,error_code,receipt_kind,receipt_ref,receipt_digest)
                VALUES (?1,?2,?3,?4,'settled',NULL,?5,?6,?7,?8,?9,?10)",params![authority.request_id,index,call_index as i64,row.call_id,outcomes[call_index].output_digest,outcomes[call_index].output_bytes.map(|n|n as i64),row.error_code,row.receipt_kind,row.receipt_ref,row.receipt_digest])
                .map_err(|_|Failure::Conflict.error())?;
        }
        let now=now_ms().map_err(Failure::error)? as i64;
        let changed=tx.execute("UPDATE code_mode_waves SET status='SETTLED',receipt_digest=?1,outcome_digest=?1,output_bytes=?2,updated_at_ms=?3 WHERE request_id=?4 AND batch_id=?5 AND wave_index=?6 AND status='BOUND'",
            params![aggregate,total_output as i64,now,authority.request_id,batch_id,index]).map_err(|_|Failure::Unavailable.error())?;
        if changed!=1{return Err(Failure::Conflict.error())}
        let run_changed=tx.execute("UPDATE code_mode_runs SET status='READY',next_wave=next_wave+1,total_output_bytes=?1,prior_wave_receipt_digest=?2,updated_at_ms=?3 WHERE request_id=?4 AND status='WAVE_PENDING' AND next_wave=?5",
            params![total as i64,aggregate,now,authority.request_id,index]).map_err(|_|Failure::Unavailable.error())?;
        if run_changed!=1{return Err(Failure::Conflict.error())}
        tx.commit().map_err(|_|Failure::Unavailable.error())?;
        Ok(CodeModeWaveOutcomeV1{status:"settled".to_owned(),results,settlement_digest:aggregate})
    }

    /// Persist the complete ordered result vector for a bound nested wave. The durable
    /// challenge status is authoritative: callers cannot turn a denied/cancelled or
    /// ambiguous effect into a successful result, nor supply receipt identifiers.
    pub(crate) fn persist_code_mode_wave_outcomes(
        &mut self,
        authority: &CodeModeExecutionAuthorityV1,
        batch_id: &str,
        outcomes: &[CodeModeWaveCallOutcomeV1],
    ) -> Result<CodeModeWaveOutcomeV1, TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        self.validate_code_mode_authority_pins(authority)?;
        validate_identifier(batch_id).map_err(Failure::error)?;
        if outcomes.is_empty() || outcomes.len() > crate::codemode_protocol::MAX_CALLS_PER_WAVE {
            return Err(Failure::Invalid.error());
        }
        let (wave_index, wave_status, frame_digest, expected_count): (i64,String,String,i64) = self.connection.query_row(
            "SELECT wave_index,status,frame_digest,call_count FROM code_mode_waves WHERE request_id=?1 AND batch_id=?2",
            params![authority.request_id,batch_id],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?.ok_or_else(||Failure::NotFound.error())?;
        if wave_status == "REJECTED" || wave_status == "CANCELLED" {
            let stored = self.read_code_mode_wave_outcome(&authority.request_id,wave_index as u8,batch_id)?;
            if stored.results.len() != outcomes.len() || stored.results.iter().zip(outcomes).any(|(stored,input)|
                stored.call_id != input.call_id || stored.status != input.status
                    || stored.output != input.output || stored.error_code != input.error_code) {
                return Err(Failure::Conflict.error());
            }
            return Ok(stored);
        }
        if wave_status != "BOUND" || expected_count != outcomes.len() as i64 || !is_blake3_digest(&frame_digest) {
            return Err(Failure::Conflict.error());
        }

        let mut stmt = self.connection.prepare(
            "SELECT c.call_index,c.call_id,c.arguments_digest,e.challenge_id,e.content_digest,e.status,
                    e.lease_id,e.receipt_digest,e.effect_id
             FROM code_mode_wave_calls c
             LEFT JOIN effect_challenges e ON e.batch_id=?3 AND e.session_id=?4 AND e.principal=?5
                  AND e.call_id=c.call_id AND e.call_index=c.call_index
             WHERE c.request_id=?1 AND c.wave_index=?2 ORDER BY c.call_index",
        ).map_err(|_|Failure::Unavailable.error())?;
        let rows = stmt.query_map(params![authority.request_id,wave_index,batch_id,authority.session_id,authority.principal], |row| Ok((
            row.get::<_,i64>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?,
            row.get::<_,Option<String>>(3)?, row.get::<_,Option<String>>(4)?, row.get::<_,Option<String>>(5)?,
            row.get::<_,Option<String>>(6)?, row.get::<_,Option<String>>(7)?, row.get::<_,Option<String>>(8)?,
        ))).map_err(|_|Failure::Unavailable.error())?;
        let stored = rows.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable.error())?;
        if stored.len() != outcomes.len() { return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error())); }
        let mut total_output = 0usize;
        let mut result_rows = Vec::with_capacity(outcomes.len());
        let mut receipt_tuples = Vec::with_capacity(outcomes.len());
        let mut all_rejected = true;
        for (index, (call_index, call_id, _arguments_digest, challenge_id, content_digest, challenge_status, lease_id, stored_receipt, effect_id)) in stored.into_iter().enumerate() {
            let input = &outcomes[index];
            if call_index != index as i64 || input.call_id != call_id {
                return Err(Failure::Conflict.error());
            }
            if let Some(output) = input.output.as_ref() {
                if output.len() > crate::codemode_protocol::MAX_OUTPUT_BYTES { return Err(Failure::Invalid.error()); }
                total_output = total_output.checked_add(output.len()).ok_or_else(||Failure::Invalid.error())?;
            }
            if let Some(code) = input.error_code.as_deref() {
                if code.is_empty() || code.len() > 128 || !code.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) {
                    return Err(Failure::Invalid.error());
                }
            }
            let (status, receipt_ref, receipt_digest) = match (input.status.as_str(),challenge_status.as_deref()) {
                ("settled",Some("SETTLED")) if lease_id.is_some() && stored_receipt.as_deref().is_some_and(is_blake3_digest) => {
                    all_rejected = false;
                    ("settled".to_owned(), effect_id.clone().ok_or_else(||Failure::Unknown.error())?, stored_receipt.clone().ok_or_else(||Failure::Unknown.error())?)
                }
                ("rejected",Some("DENIED")) if lease_id.is_none() && stored_receipt.is_none() => {
                    let digest = codemode_terminal_decision_receipt_digest(&authority.request_id,batch_id,wave_index as u8,&frame_digest,&call_id,
                        challenge_id.as_deref().ok_or_else(||Failure::Unknown.error())?,content_digest.as_deref().ok_or_else(||Failure::Unknown.error())?,
                        "rejected",input.error_code.as_deref(),input.output.as_deref());
                    ("rejected".to_owned(),codemode_terminal_decision_receipt_ref(&authority.request_id,batch_id,wave_index as u8,&call_id,&digest),digest)
                }
                ("cancelled",Some("CANCELLED")) if lease_id.is_none() && stored_receipt.is_none() => {
                    all_rejected = false;
                    let digest = codemode_terminal_decision_receipt_digest(&authority.request_id,batch_id,wave_index as u8,&frame_digest,&call_id,
                        challenge_id.as_deref().ok_or_else(||Failure::Unknown.error())?,content_digest.as_deref().ok_or_else(||Failure::Unknown.error())?,
                        "cancelled",input.error_code.as_deref(),input.output.as_deref());
                    ("cancelled".to_owned(),codemode_terminal_decision_receipt_ref(&authority.request_id,batch_id,wave_index as u8,&call_id,&digest),digest)
                }
                _ => return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error())),
            };
            let receipt_kind = if status == "settled" { "effect_receipt" } else { "host_decision" };
            receipt_tuples.push(CodeModeWaveReceiptTupleV1 { call_index:index as u8, call_id:call_id.clone(), status:status.clone(), receipt_kind:receipt_kind.into(), receipt_ref:receipt_ref.clone(), receipt_digest:receipt_digest.clone() });
            result_rows.push(CodeModeWaveCallResultV1 { call_id,status,output:input.output.clone(),output_bytes:input.output.as_ref().map(|s|s.len() as u64),output_digest:None,receipt_kind:Some(receipt_kind.into()),receipt_ref:Some(receipt_ref),receipt_digest:Some(receipt_digest),error_code:input.error_code.clone() });
        }
        if total_output > crate::codemode_protocol::MAX_OUTPUT_BYTES { return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error())); }
        let prior_output:i64=self.connection.query_row("SELECT total_output_bytes FROM code_mode_runs WHERE request_id=?1 AND status='WAVE_PENDING'",[&authority.request_id],|row|row.get(0)).optional().map_err(|_|Failure::Unavailable.error())?.ok_or_else(||Failure::Conflict.error())?;
        let cumulative_output=(prior_output as usize).checked_add(total_output).ok_or_else(||Failure::Invalid.error())?;
        if cumulative_output>crate::codemode_protocol::MAX_OUTPUT_BYTES{return Err(Failure::Invalid.error())}
        let aggregate = codemode_wave_receipt_digest(batch_id,&receipt_tuples);
        let has_rejected = result_rows.iter().any(|r|r.status=="rejected");
        let has_cancelled = result_rows.iter().any(|r|r.status=="cancelled");
        // Admission is atomic: a known denial applies to the complete wave. A
        // mixed settled/rejected vector cannot be reconciled as a known outcome.
        if has_rejected && !all_rejected {
            return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error()));
        }
        let wave_result_status = if all_rejected { "REJECTED" } else if has_cancelled { "CANCELLED" } else { "SETTLED" };
        if wave_result_status == "SETTLED" {
            // Successful calls must be settled by the normal atomic receipt path.
            return Err(Failure::Conflict.error());
        }
        let tx = self.connection.transaction().map_err(|_|Failure::Unavailable.error())?;
        for (index,row) in result_rows.iter().enumerate() {
            tx.execute("INSERT INTO code_mode_wave_results(request_id,wave_index,call_index,call_id,status,output,error_code,receipt_kind,receipt_ref,receipt_digest)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![authority.request_id,wave_index,index as i64,row.call_id,row.status,row.output,row.error_code,row.receipt_kind,row.receipt_ref,row.receipt_digest])
                .map_err(|_|Failure::Conflict.error())?;
        }
        let changed = tx.execute("UPDATE code_mode_waves SET status=?1,outcome_digest=?2,receipt_digest=?3,output_bytes=?4,updated_at_ms=?5
            WHERE request_id=?6 AND batch_id=?7 AND status='BOUND'",params![wave_result_status,aggregate,aggregate,total_output as i64,now_ms().map_err(Failure::error)? as i64,authority.request_id,batch_id])
            .map_err(|_|Failure::Unavailable.error())?;
        if changed != 1 { return Err(Failure::Conflict.error()); }
        let run_changed = if wave_result_status == "REJECTED" {
            tx.execute("UPDATE code_mode_runs SET status='CANCELLED',terminal_outcome='failed',total_output_bytes=?1,updated_at_ms=?2 WHERE request_id=?3 AND status='WAVE_PENDING' AND next_wave=?4",
                params![cumulative_output as i64,now_ms().map_err(Failure::error)? as i64,authority.request_id,wave_index]).map_err(|_|Failure::Unavailable.error())?
        } else {
            tx.execute("UPDATE code_mode_runs SET status='CANCELLED',terminal_outcome='cancelled',total_output_bytes=?1,updated_at_ms=?2 WHERE request_id=?3 AND status='WAVE_PENDING' AND next_wave=?4",
                params![cumulative_output as i64,now_ms().map_err(Failure::error)? as i64,authority.request_id,wave_index]).map_err(|_|Failure::Unavailable.error())?
        };
        if run_changed != 1 { return Err(Failure::Conflict.error()); }
        tx.commit().map_err(|_|Failure::Unavailable.error())?;
        Ok(CodeModeWaveOutcomeV1 { status:wave_result_status.to_ascii_lowercase(),results:result_rows,settlement_digest:aggregate })
    }

    /// Convert a deterministic all-or-none admission denial into a durable terminal
    /// wave only when no challenge was persisted. This never claims that an effect ran.
    pub(crate) fn reject_code_mode_wave_before_dispatch(
        &mut self,
        authority: &CodeModeExecutionAuthorityV1,
        batch_id: &str,
        error_code: &str,
    ) -> Result<CodeModeWaveOutcomeV1, TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        validate_identifier(batch_id).map_err(Failure::error)?;
        if error_code.is_empty() || error_code.len() > 128 || !error_code.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) {
            return Err(Failure::Invalid.error());
        }
        let (index,status,frame_digest): (i64,String,String) = self.connection.query_row(
            "SELECT wave_index,status,frame_digest FROM code_mode_waves WHERE request_id=?1 AND batch_id=?2",
            params![authority.request_id,batch_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?.ok_or_else(||Failure::NotFound.error())?;
        if status == "REJECTED" {
            let stored=self.read_code_mode_wave_outcome(&authority.request_id,index as u8,batch_id)?;
            if stored.status!="rejected" || stored.results.iter().any(|row|
                row.error_code.as_deref()!=Some(error_code) || row.output.is_some()) {
                return Err(Failure::Conflict.error());
            }
            return Ok(stored);
        }
        if status != "RESERVED" || !is_blake3_digest(&frame_digest) { return Err(Failure::Conflict.error()); }
        let challenge_count:i64=self.connection.query_row("SELECT COUNT(*) FROM effect_challenges WHERE batch_id=?1 AND session_id=?2 AND principal=?3",
            params![batch_id,authority.session_id,authority.principal],|r|r.get(0)).map_err(|_|Failure::Unavailable.error())?;
        if challenge_count != 0 { return self.fence_code_mode_unknown(&authority.request_id,batch_id).and(Err(Failure::Unknown.error())); }
        let mut stmt=self.connection.prepare("SELECT call_index,call_id FROM code_mode_wave_calls WHERE request_id=?1 AND wave_index=?2 ORDER BY call_index")
            .map_err(|_|Failure::Unavailable.error())?;
        let calls=stmt.query_map(params![authority.request_id,index],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))
            .map_err(|_|Failure::Unavailable.error())?.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable.error())?;
        if calls.is_empty() || calls.len()>crate::codemode_protocol::MAX_CALLS_PER_WAVE { return Err(Failure::Conflict.error()); }
        let mut results=Vec::with_capacity(calls.len());
        let mut tuples=Vec::with_capacity(calls.len());
        for (expected,(call_index,call_id)) in calls.into_iter().enumerate() {
            if call_index!=expected as i64{return Err(Failure::Conflict.error())}
            let digest=codemode_terminal_decision_receipt_digest(&authority.request_id,batch_id,index as u8,&frame_digest,&call_id,"pre_dispatch",&frame_digest,"rejected",Some(error_code),None);
            let receipt_ref=codemode_terminal_decision_receipt_ref(&authority.request_id,batch_id,index as u8,&call_id,&digest);
            tuples.push(CodeModeWaveReceiptTupleV1 { call_index:expected as u8, call_id:call_id.clone(), status:"rejected".into(), receipt_kind:"host_decision".into(), receipt_ref:receipt_ref.clone(), receipt_digest:digest.clone() });
            results.push(CodeModeWaveCallResultV1{call_id,status:"rejected".into(),output:None,output_bytes:None,output_digest:None,receipt_kind:Some("host_decision".into()),receipt_ref:Some(receipt_ref),receipt_digest:Some(digest),error_code:Some(error_code.to_owned())});
        }
        let aggregate=codemode_wave_receipt_digest(batch_id,&tuples);
        let tx=self.connection.transaction().map_err(|_|Failure::Unavailable.error())?;
        for (call_index,row) in results.iter().enumerate(){
            tx.execute("INSERT INTO code_mode_wave_results(request_id,wave_index,call_index,call_id,status,output,error_code,receipt_kind,receipt_ref,receipt_digest)
                VALUES (?1,?2,?3,?4,'rejected',NULL,?5,?6,?7,?8)",params![authority.request_id,index,call_index as i64,row.call_id,error_code,row.receipt_kind,row.receipt_ref,row.receipt_digest])
                .map_err(|_|Failure::Conflict.error())?;
        }
        let changed=tx.execute("UPDATE code_mode_waves SET status='REJECTED',outcome_digest=?1,receipt_digest=?1,output_bytes=0,updated_at_ms=?2 WHERE request_id=?3 AND batch_id=?4 AND status='RESERVED'",
            params![aggregate,now_ms().map_err(Failure::error)? as i64,authority.request_id,batch_id]).map_err(|_|Failure::Unavailable.error())?;
        if changed!=1{return Err(Failure::Conflict.error())}
        let run_changed=tx.execute("UPDATE code_mode_runs SET status='CANCELLED',terminal_outcome='failed',updated_at_ms=?1 WHERE request_id=?2 AND status='WAVE_PENDING' AND next_wave=?3",
            params![now_ms().map_err(Failure::error)? as i64,authority.request_id,index]).map_err(|_|Failure::Unavailable.error())?;
        if run_changed!=1{return Err(Failure::Conflict.error())}
        tx.commit().map_err(|_|Failure::Unavailable.error())?;
        Ok(CodeModeWaveOutcomeV1{status:"rejected".into(),results,settlement_digest:aggregate})
    }

    fn read_code_mode_wave_outcome(&self,request_id:&str,wave_index:u8,batch_id:&str)->Result<CodeModeWaveOutcomeV1,TypedErrorV1>{
        let (status,receipt_digest,outcome_digest,call_count): (String,Option<String>,Option<String>,i64)=self.connection.query_row(
            "SELECT status,receipt_digest,outcome_digest,call_count FROM code_mode_waves WHERE request_id=?1 AND wave_index=?2 AND batch_id=?3",
            params![request_id,wave_index as i64,batch_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?.ok_or_else(||Failure::NotFound.error())?;
        let receipt_digest=receipt_digest.ok_or_else(||Failure::Unknown.error())?;
        if outcome_digest.as_deref()!=Some(receipt_digest.as_str()) {return Err(Failure::Unknown.error())}
        let mut stmt=self.connection.prepare("SELECT call_id,status,output,output_bytes,output_digest,receipt_kind,receipt_ref,receipt_digest,error_code FROM code_mode_wave_results
            WHERE request_id=?1 AND wave_index=?2 ORDER BY call_index").map_err(|_|Failure::Unavailable.error())?;
        let rows=stmt.query_map(params![request_id,wave_index as i64],|r|Ok(CodeModeWaveCallResultV1{
            call_id:r.get(0)?,status:r.get(1)?,output:r.get(2)?,output_bytes:r.get::<_,Option<i64>>(3)?.map(|v|v as u64),output_digest:r.get(4)?,receipt_kind:r.get(5)?,receipt_ref:r.get(6)?,receipt_digest:r.get(7)?,error_code:r.get(8)?,
        })).map_err(|_|Failure::Unavailable.error())?.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable.error())?;
        if rows.is_empty() || rows.len()!=call_count as usize || rows.iter().any(|row|
            !row.receipt_digest.as_deref().is_some_and(is_blake3_digest)
                || row.receipt_ref.as_deref().is_none_or(str::is_empty)
                || !matches!(row.receipt_kind.as_deref(),Some("effect_receipt"|"host_decision"|"tool_result")))
        {return Err(Failure::Unknown.error())}
        let mut calls_stmt=self.connection.prepare("SELECT call_index,call_id,call_kind FROM code_mode_wave_calls WHERE request_id=?1 AND wave_index=?2 ORDER BY call_index")
            .map_err(|_|Failure::Unavailable.error())?;
        let call_ids=calls_stmt.query_map(params![request_id,wave_index as i64],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))
            .map_err(|_|Failure::Unavailable.error())?.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable.error())?;
        if call_ids.len()!=rows.len() || call_ids.iter().enumerate().any(|(index,(call_index,call_id))|
            *call_index!=index as i64 || rows[index].call_id.as_str()!=call_id.as_str()
                || CodeModeWaveCallKindV1::parse(&call_ids[index].2).is_none()) {return Err(Failure::Unknown.error())}
        for (index,(_,call_id,kind_text)) in call_ids.iter().enumerate() {
            let row=&rows[index];
            if row.output_digest.is_some()!=row.output_bytes.is_some()
                || row.output_digest.as_deref().is_some_and(|digest|!is_blake3_digest(digest))
                || row.output_bytes.is_some_and(|bytes|bytes as usize>crate::codemode_protocol::MAX_OUTPUT_BYTES)
            { return Err(Failure::Unknown.error()); }
            match (CodeModeWaveCallKindV1::parse(kind_text),row.status.as_str(),row.receipt_kind.as_deref()) {
                (Some(CodeModeWaveCallKindV1::Effect),"settled",Some("effect_receipt")) => {},
                (Some(CodeModeWaveCallKindV1::HostCallback),"settled",Some("tool_result")) => {
                    let expected=codemode_tool_result_receipt_digest(request_id,batch_id,wave_index,index as u8,call_id,
                        row.output_digest.as_deref().unwrap_or("none"),row.output_bytes.unwrap_or(0),row.error_code.as_deref());
                    let expected_ref=codemode_tool_result_receipt_ref(request_id,batch_id,wave_index,index as u8,call_id);
                    if row.receipt_digest.as_deref()!=Some(expected.as_str()) || row.receipt_ref.as_deref()!=Some(expected_ref.as_str()) {return Err(Failure::Unknown.error())}
                }
                (_,"rejected"|"cancelled",Some("host_decision")) => {},
                _ => return Err(Failure::Unknown.error()),
            }
        }
        let tuples=rows.iter().enumerate().map(|(index,row)|CodeModeWaveReceiptTupleV1 {
            call_index:index as u8, call_id:row.call_id.clone(), status:row.status.clone(),
            receipt_kind:row.receipt_kind.clone().expect("validated receipt kind"),
            receipt_ref:row.receipt_ref.clone().expect("validated receipt ref"),
            receipt_digest:row.receipt_digest.clone().expect("validated receipt digest"),
        }).collect::<Vec<_>>();
        if codemode_wave_receipt_digest(batch_id,&tuples)!=receipt_digest {return Err(Failure::Unknown.error())}
        let expected_status=if rows.iter().all(|row|row.status=="rejected") {"rejected"}
            else if rows.iter().any(|row|row.status=="cancelled") && rows.iter().all(|row|matches!(row.status.as_str(),"settled"|"cancelled")) {"cancelled"}
            else if rows.iter().all(|row|row.status=="settled") {"settled"} else {return Err(Failure::Unknown.error())};
        if status.to_ascii_lowercase()!=expected_status {return Err(Failure::Unknown.error())}
        Ok(CodeModeWaveOutcomeV1{status:expected_status.into(),results:rows,settlement_digest:receipt_digest})
    }

    /// Reconcile the durable outer helper receipt and nested wave cursor for one
    /// already-authenticated CodeMode authority. This is read-only: it never resumes
    /// a helper, consumes a lease, or dispatches a nested effect. Any mismatch or
    /// incomplete outer settlement is exposed as UNKNOWN without receipt fields.
    pub(crate) fn inspect_code_mode_execution(
        &self,
        authority: &CodeModeExecutionAuthorityV1,
    ) -> Result<Value, TypedErrorV1> {
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        let scope_digest = codemode_authority_scope_digest(
            &authority.authority_scope,
            &authority.session_id,
            &authority.location_id,
        )?;
        let row: Option<(
            String, String, String, String, String, String, i64, i64, String, String,
            Option<String>, String, String, String, String, String, String, i64, String,
            i64, Option<String>,
        )> = self.connection.query_row(
            "SELECT execution_id,effect_id,challenge_id,principal,session_id,location_id,
                    owner_epoch,generation,capability_lease_digest,attempt_scope_digest,
                    direct_turn_scope_digest,tool_set_digest,enablement_digest,helper_digest,
                    resource_profile_digest,policy_digest,turn_context_digest,deadline_unix_ms,
                    status,next_wave,terminal_outcome
             FROM code_mode_runs WHERE request_id=?1",
            [&authority.request_id],
            |r| Ok((
                r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,
                r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?,r.get(14)?,
                r.get(15)?,r.get(16)?,r.get(17)?,r.get(18)?,r.get(19)?,r.get(20)?,
            )),
        ).optional().map_err(|_| Failure::Unavailable.error())?;
        let Some((execution,effect,challenge,principal,session,location,epoch,generation,lease,scope,
            direct_turn,tools,enablement,helper,resource,policy,context,deadline,run_status,next_wave,terminal_outcome)) = row
        else { return Err(Failure::NotFound.error()); };
        let scope_matches = match &authority.authority_scope {
            CodeModeAuthorityScopeV1::DirectSession { .. } => scope == scope_digest,
            CodeModeAuthorityScopeV1::ManagedAttempt(EffectAttemptScopeV1::Managed(current)) => {
                let current_digest = current.digest().map_err(|_|Failure::Invalid.error())?;
                let wave_scope: Option<String> = self.connection.query_row(
                    "SELECT scope_digest FROM code_mode_waves WHERE request_id=?1
                     ORDER BY wave_index DESC LIMIT 1", [&authority.request_id], |r| r.get(0),
                ).optional().map_err(|_|Failure::Unavailable.error())?;
                let process_scope: Option<String> = self.connection.query_row(
                    "SELECT attempt_scope_digest FROM stdio_executions WHERE execution_id=?1",
                    [&authority.execution_id], |r| r.get(0),
                ).optional().map_err(|_|Failure::Unavailable.error())?;
                wave_scope.as_deref().or(process_scope.as_deref()) == Some(current_digest.as_str())
            }
            CodeModeAuthorityScopeV1::ManagedAttempt(EffectAttemptScopeV1::Direct(_)) => false,
        };
        if execution != authority.execution_id || effect != authority.effect_id
            || challenge != authority.challenge_id || principal != authority.principal
            || session != authority.session_id || location != authority.location_id
            || epoch != authority.owner_epoch as i64 || generation != authority.generation as i64
            || lease != authority.capability_lease_digest || !scope_matches
            || direct_turn != authority.direct_turn_scope_digest || tools != authority.tool_set_digest
            || enablement != authority.enablement_digest || helper != authority.helper_digest
            || resource != authority.resource_profile_digest || policy != authority.policy_digest
            || context != authority.turn_context_digest || deadline != authority.deadline_unix_ms as i64
            || !matches!(run_status.as_str(),"READY"|"WAVE_PENDING"|"FAILED"|"CANCELLED"|"UNKNOWN"|"COMPLETE")
            || !(0..=64).contains(&next_wave)
            || terminal_outcome.as_deref().is_some_and(|value| !matches!(value,"failed"|"cancelled"))
        { return Err(Failure::Conflict.error()); }

        let outer: Option<(String,Option<String>,String,Option<String>,String,Option<String>,Option<String>)> = self.connection.query_row(
            "SELECT c.status,c.receipt_digest,s.status,s.receipt_digest,c.origin_kind,
                    c.managed_attempt_digest,s.attempt_scope_digest
             FROM effect_challenges c JOIN stdio_executions s
               ON s.execution_id=?1 AND s.effect_id=c.effect_id AND s.challenge_id=c.challenge_id
             WHERE c.effect_id=?2 AND c.challenge_id=?3 AND c.principal=?4 AND c.session_id=?5
               AND c.capability_id=?6",
            params![authority.execution_id,authority.effect_id,authority.challenge_id,
                authority.principal,authority.session_id,guard::CODE_MODE_EXECUTE_ID],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let outer_scope_valid = outer.as_ref().is_some_and(|(_,_,_,_,origin,managed_scope,process_scope)| match &authority.authority_scope {
            CodeModeAuthorityScopeV1::DirectSession { .. } => origin == "session_batch" && managed_scope.is_none() && process_scope.is_none(),
            CodeModeAuthorityScopeV1::ManagedAttempt(EffectAttemptScopeV1::Managed(current)) => {
                origin == ORIGIN_MANAGED_RUN && managed_scope == process_scope
                    && managed_scope.as_deref().is_some_and(is_blake3_digest)
                    && current.session_id == authority.session_id && current.location_id == authority.location_id
            }
            CodeModeAuthorityScopeV1::ManagedAttempt(EffectAttemptScopeV1::Direct(_)) => false,
        });
        let outer_settled = outer.as_ref().is_some_and(|(challenge_status,challenge_receipt,process_status,process_receipt,_,_,_)|
            outer_scope_valid && challenge_status == "SETTLED" && process_status == "SETTLED"
                && challenge_receipt.as_deref().is_some_and(is_blake3_digest)
                && challenge_receipt == process_receipt);
        let outer_active = outer.as_ref().is_some_and(|(challenge_status,challenge_receipt,process_status,process_receipt,_,_,_)|
            outer_scope_valid && challenge_status == "PREPARED" && process_status == "RUNNING"
                && challenge_receipt.is_none() && process_receipt.is_none());

        let (mut status, mut pending_batch_id, mut outer_receipt) = match run_status.as_str() {
            "READY" | "WAVE_PENDING" if outer_active => (run_status.clone(),None,None),
            "COMPLETE" if outer_settled => ("COMPLETE".to_owned(),None,None),
            "CANCELLED" | "FAILED" if outer_settled => ("CANCELLED".to_owned(),None,None),
            "UNKNOWN" => ("UNKNOWN".to_owned(),None,None),
            _ => ("UNKNOWN".to_owned(),None,None),
        };
        if status == "WAVE_PENDING" {
            if next_wave < 0 || next_wave >= 64 { status = "UNKNOWN".to_owned(); }
            else {
                let wave: Option<(String,String)> = self.connection.query_row(
                    "SELECT batch_id,status FROM code_mode_waves WHERE request_id=?1 AND wave_index=?2",
                    params![authority.request_id,next_wave],
                    |r| Ok((r.get(0)?,r.get(1)?)),
                ).optional().map_err(|_|Failure::Unavailable.error())?;
                match wave {
                    Some((batch_id,wave_status)) if matches!(wave_status.as_str(),"RESERVED"|"ADMITTED"|"BOUND") => pending_batch_id=Some(batch_id),
                    _ => status="UNKNOWN".to_owned(),
                }
            }
        }
        if status == "UNKNOWN" {
            outer_receipt = Some(Value::Map(BTreeMap::from([("status".into(),Value::String("unknown".into()))])));
            pending_batch_id = None;
        } else if matches!(status.as_str(),"COMPLETE"|"CANCELLED") {
            let (_,receipt_digest,_,_,_,_,_) = outer.as_ref().ok_or_else(||Failure::Unknown.error())?;
            let receipt_digest = receipt_digest.as_deref().filter(|digest|is_blake3_digest(digest))
                .ok_or_else(||Failure::Unknown.error())?;
            outer_receipt = Some(Value::Map(BTreeMap::from([
                ("status".into(),Value::String("settled".into())),
                ("receiptRef".into(),Value::String(authority.effect_id.clone())),
                ("receiptDigest".into(),Value::String(receipt_digest.to_owned())),
            ])));
        }
        Ok(Value::Map(BTreeMap::from([
            ("requestId".into(),Value::String(authority.request_id.clone())),
            ("executionID".into(),Value::String(authority.execution_id.clone())),
            ("status".into(),Value::String(status)),
            ("nextWave".into(),Value::Unsigned(next_wave as u64)),
            ("pendingBatchID".into(),pending_batch_id.map(Value::String).unwrap_or(Value::Null)),
            ("outerReceipt".into(),outer_receipt.unwrap_or(Value::Null)),
        ])))
    }

    pub(crate) fn complete_code_mode_execution(&mut self, authority:&CodeModeExecutionAuthorityV1)->Result<(),TypedErrorV1>{
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        let changed=self.connection.execute("UPDATE code_mode_runs SET status='COMPLETE',updated_at_ms=?1
            WHERE request_id=?2 AND execution_id=?3 AND effect_id=?4 AND challenge_id=?5 AND principal=?6 AND session_id=?7
              AND location_id=?8 AND capability_lease_digest=?9 AND attempt_scope_digest=?10
              AND tool_set_digest=?11 AND enablement_digest=?12 AND helper_digest=?13 AND resource_profile_digest=?14
              AND policy_digest=?15 AND turn_context_digest=?16 AND direct_turn_scope_digest IS ?17
              AND owner_epoch=?18 AND generation=?19 AND deadline_unix_ms=?20
              AND status IN ('READY','FAILED','CANCELLED')
              AND EXISTS(SELECT 1 FROM stdio_executions s JOIN effect_challenges c ON c.challenge_id=s.challenge_id
                WHERE s.execution_id=code_mode_runs.execution_id AND s.status='SETTLED' AND s.receipt_digest IS NOT NULL
                  AND c.effect_id=code_mode_runs.effect_id AND c.status='SETTLED' AND c.receipt_digest IS NOT NULL)
              AND NOT EXISTS(SELECT 1 FROM code_mode_waves w WHERE w.request_id=code_mode_runs.request_id
                AND w.status NOT IN ('SETTLED','REJECTED','CANCELLED'))",
            params![now_ms().map_err(Failure::error)? as i64,authority.request_id,authority.execution_id,authority.effect_id,
                authority.challenge_id,authority.principal,authority.session_id,authority.location_id,authority.capability_lease_digest,
                codemode_authority_scope_digest(&authority.authority_scope,&authority.session_id,&authority.location_id)?,
                authority.tool_set_digest,authority.enablement_digest,authority.helper_digest,authority.resource_profile_digest,authority.policy_digest,
                authority.turn_context_digest,authority.direct_turn_scope_digest,authority.owner_epoch as i64,authority.generation as i64,
                authority.deadline_unix_ms as i64]).map_err(|_|Failure::Unavailable.error())?;
        if changed==1 {return Ok(())}
        let complete:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM code_mode_runs WHERE request_id=?1 AND execution_id=?2 AND effect_id=?3 AND challenge_id=?4 AND status='COMPLETE')",
            params![authority.request_id,authority.execution_id,authority.effect_id,authority.challenge_id],|r|r.get(0))
            .map_err(|_|Failure::Unavailable.error())?;
        if complete {Ok(())} else {Err(Failure::Conflict.error())}
    }

    /// Stop the CodeMode conversation without replaying a dispatched effect. Before
    /// one-use consume, standard batch cancellation is safe; once any member is
    /// PREPARED/UNKNOWN the enclosing wave is UNKNOWN and no subsequent wave is allowed.
    pub(crate) fn cancel_code_mode_execution(&mut self,authority:&CodeModeExecutionAuthorityV1)->Result<(),TypedErrorV1>{
        self.validate_code_mode_authority(authority).map_err(Failure::error)?;
        let run:Option<(String,i64)>=self.connection.query_row("SELECT status,next_wave FROM code_mode_runs WHERE request_id=?1 AND execution_id=?2",params![authority.request_id,authority.execution_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((status,index))=run else{return Err(Failure::NotFound.error())};
        if status=="COMPLETE"||status=="CANCELLED" {return Ok(())}
        if status=="UNKNOWN" {return Err(Failure::Unknown.error())}
        self.validate_code_mode_authority_pins(authority)?;
        let active:Option<(String,String)>=self.connection.query_row("SELECT batch_id,status FROM code_mode_waves WHERE request_id=?1 AND wave_index=?2",params![authority.request_id,index],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|Failure::Unavailable.error())?;
        if let Some((batch_id,wave_status))=active {
            if wave_status=="BOUND" {
                let rows=self.batch_effect_states_for_host(&authority.session_id,&authority.principal,&batch_id)?;
                if rows.iter().any(|(_,state)|state=="PREPARED"||state=="UNKNOWN") {
                    self.fence_code_mode_unknown(&authority.request_id,&batch_id)?;
                    return Err(Failure::Unknown.error());
                }
                if rows.iter().any(|(_,state)|state=="APPROVED"||state=="AWAITING_APPROVAL") {
                    let body=map_value([("sessionId",Value::String(authority.session_id.clone())),("batchId",Value::String(batch_id.clone()))]);
                    let cancelled=self.cancel_batch(&authority.session_id,&authority.principal,&body)?;
                    if matches!(&cancelled,Value::Map(fields) if matches!(fields.get("prepared"),Some(Value::Unsigned(value)) if *value>0)) {
                        self.fence_code_mode_unknown(&authority.request_id,&batch_id)?;
                        return Err(Failure::Unknown.error());
                    }
                }
                let rows=self.batch_effect_states_for_host(&authority.session_id,&authority.principal,&batch_id)?;
                if rows.iter().any(|(_,state)|state!="SETTLED"&&state!="CANCELLED") {
                    self.fence_code_mode_unknown(&authority.request_id,&batch_id)?;
                    return Err(Failure::Unknown.error());
                }
            } else if wave_status=="ADMITTED"||wave_status=="RESERVED" {
                let body=map_value([("sessionId",Value::String(authority.session_id.clone())),("batchId",Value::String(batch_id.clone()))]);
                let cancelled=self.cancel_batch(&authority.session_id,&authority.principal,&body)?;
                if matches!(&cancelled,Value::Map(fields) if matches!(fields.get("prepared"),Some(Value::Unsigned(value)) if *value>0)) {
                    self.fence_code_mode_unknown(&authority.request_id,&batch_id)?;
                    return Err(Failure::Unknown.error());
                }
            }
            let tx=self.connection.transaction().map_err(|_|Failure::Unavailable.error())?;
            tx.execute("UPDATE code_mode_waves SET status='CANCELLED',updated_at_ms=?1 WHERE request_id=?2 AND batch_id=?3 AND status IN ('RESERVED','ADMITTED','BOUND')",params![now_ms().map_err(Failure::error)? as i64,authority.request_id,batch_id]).map_err(|_|Failure::Unavailable.error())?;
            tx.execute("UPDATE code_mode_runs SET status='CANCELLED',terminal_outcome='cancelled',updated_at_ms=?1 WHERE request_id=?2 AND status IN ('READY','WAVE_PENDING')",params![now_ms().map_err(Failure::error)? as i64,authority.request_id]).map_err(|_|Failure::Unavailable.error())?;
            tx.commit().map_err(|_|Failure::Unavailable.error())
        } else {
            let changed=self.connection.execute("UPDATE code_mode_runs SET status='CANCELLED',terminal_outcome='cancelled',updated_at_ms=?1 WHERE request_id=?2 AND status='READY'",params![now_ms().map_err(Failure::error)? as i64,authority.request_id]).map_err(|_|Failure::Unavailable.error())?;
            if changed==1 {Ok(())} else {Err(Failure::Conflict.error())}
        }
    }

    fn validate_code_mode_authority(&self, authority: &CodeModeExecutionAuthorityV1) -> Result<(), Failure> {
        for id in [&authority.request_id,&authority.execution_id,&authority.effect_id,&authority.challenge_id,&authority.principal,&authority.session_id,&authority.location_id] {
            validate_identifier(id)?;
        }
        Ok(())
    }

    fn validate_code_mode_authority_pins(&self, authority:&CodeModeExecutionAuthorityV1)->Result<(),TypedErrorV1>{
        let scope_digest=codemode_authority_scope_digest(&authority.authority_scope,&authority.session_id,&authority.location_id)?;
        let row:Option<(String,String,String,String,String,String,String,String,String,String,String,String,String,String,Option<String>,i64,i64,i64,String)>=self.connection.query_row(
            "SELECT execution_id,effect_id,challenge_id,principal,session_id,location_id,capability_lease_digest,
             attempt_scope_digest,tool_set_digest,enablement_digest,helper_digest,resource_profile_digest,policy_digest,turn_context_digest,
             direct_turn_scope_digest,owner_epoch,generation,deadline_unix_ms,status
             FROM code_mode_runs WHERE request_id=?1",[&authority.request_id],
            |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?,r.get(14)?,r.get(15)?,r.get(16)?,r.get(17)?,r.get(18)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((execution,effect,challenge,principal,session,location,lease,scope,tools,enablement,helper_digest,profile,policy,context,direct_scope,epoch,generation,deadline,status))=row else{return Err(Failure::NotFound.error())};
        if execution!=authority.execution_id || effect!=authority.effect_id || challenge!=authority.challenge_id
            || principal!=authority.principal || session!=authority.session_id || location!=authority.location_id
            || lease!=authority.capability_lease_digest || scope!=scope_digest || tools!=authority.tool_set_digest
            || enablement!=authority.enablement_digest || helper_digest!=authority.helper_digest || profile!=authority.resource_profile_digest
            || policy!=authority.policy_digest || context!=authority.turn_context_digest
            || direct_scope!=authority.direct_turn_scope_digest
            || epoch!=authority.owner_epoch as i64 || generation!=authority.generation as i64
            || deadline!=authority.deadline_unix_ms as i64 || status!="READY" && status!="WAVE_PENDING"
        {return Err(Failure::Conflict.error())}
        let live:Option<(String,String,String)>=self.connection.query_row(
            "SELECT c.status,c.capability_id,s.status FROM effect_challenges c JOIN stdio_executions s ON s.execution_id=?1
             WHERE c.effect_id=?2 AND c.challenge_id=?3 AND c.principal=?4 AND c.session_id=?5",
            params![authority.execution_id,authority.effect_id,authority.challenge_id,authority.principal,authority.session_id],
            |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(|_|Failure::Unavailable.error())?;
        let Some((effect_status,capability,execution_status))=live else{return Err(Failure::NotFound.error())};
        if capability!=guard::CODE_MODE_EXECUTE_ID || execution_status!="RUNNING"
            || effect_status!="PREPARED"
        {return Err(Failure::Conflict.error())}
        Ok(())
    }

    fn fence_code_mode_unknown(&mut self, request_id: &str, batch_id: &str) -> Result<(), TypedErrorV1> {
        let tx = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        tx.execute("UPDATE code_mode_runs SET status='UNKNOWN',updated_at_ms=?1 WHERE request_id=?2 AND status IN ('READY','WAVE_PENDING')",params![now_ms().map_err(Failure::error)? as i64,request_id]).map_err(|_| Failure::Unavailable.error())?;
        tx.execute("UPDATE code_mode_waves SET status='UNKNOWN',updated_at_ms=?1 WHERE request_id=?2 AND batch_id=?3 AND status IN ('RESERVED','ADMITTED','BOUND')",params![now_ms().map_err(Failure::error)? as i64,request_id,batch_id]).map_err(|_| Failure::Unavailable.error())?;
        tx.commit().map_err(|_| Failure::Unavailable.error())
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
        deadline_unix_ms: u64,
    ) -> Result<Value, Failure> {
        self.prepare_tool_batch_internal(process_session_id, principal, body, deadline_unix_ms, None, None)
    }

    /// HostKernel-only root DirectSession entrypoint. The typed projection is not a
    /// public RPC field; HostKernel must mint it from authenticated owner state. This
    /// method still creates the normal durable challenges and never issues leases.
    pub(crate) fn prepare_tool_batch_with_direct_mode(
        &mut self,
        process_session_id: &str,
        principal: &str,
        owner_epoch: u64,
        body: &Value,
        deadline_unix_ms: u64,
        permission_mode: &guard::DirectSessionPermissionModeProjectionV1,
    ) -> Result<Value, Failure> {
        self.prepare_tool_batch_internal(
            process_session_id,
            principal,
            body,
            deadline_unix_ms,
            Some(owner_epoch),
            Some(permission_mode),
        )
    }

    fn prepare_tool_batch_internal(
        &mut self,
        process_session_id: &str,
        principal: &str,
        body: &Value,
        deadline_unix_ms: u64,
        owner_epoch: Option<u64>,
        permission_mode: Option<&guard::DirectSessionPermissionModeProjectionV1>,
    ) -> Result<Value, Failure> {
        validate_effect_request_deadline(deadline_unix_ms)?;
        let body = strict_map_optional(
            body,
            &["sessionId", "batchId", "turnContextDigest", "calls"],
            &["managedAttempt", "directAttempt", "directTurnScope", "workspaceCommandProfiles"],
        )?;
        let session_id = text(body, "sessionId")?;
        require_session(process_session_id, session_id)?;
        let managed_attempt_digest = parse_effect_attempt_scope_digest(body, session_id)?;
        if let Some(mode) = permission_mode {
            let execution = self.execution.as_ref().ok_or(Failure::Unavailable)?;
            let Some(expected_owner_epoch) = owner_epoch else { return Err(Failure::Denied); };
            if !mode.validate()
                || mode.session_id != session_id
                || mode.owner_epoch != expected_owner_epoch
                || mode.workspace_root_digest != execution.workspace_binding()
                || mode.execution_backend_id != guard::DIRECT_SESSION_EFFECT_BACKEND_ID
                || mode.policy_digest != guard::direct_session_policy_digest()
                || managed_attempt_digest.is_some()
                || body.get("directTurnScope").is_some()
            {
                return Err(Failure::Conflict);
            }
        } else if owner_epoch.is_some() {
            return Err(Failure::Invalid);
        }
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
        let workspace_profiles = parse_terminal_workspace_profile_projections(
            body.get("workspaceCommandProfiles"), calls,
        )?;
        // Bound the batch payload before any parsing work: per-call and aggregate
        // encoded-argument bytes, independent of the surrounding RPC frame limit.
        let mut batch_bytes = 0usize;
        for call in calls {
            validate_effect_request_deadline(deadline_unix_ms)?;
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
            validate_effect_request_deadline(deadline_unix_ms)?;
            let fields = strict_map(call, &["callId", "capabilityId", "arguments"])?;
            let call_id = text(fields, "callId")?;
            validate_identifier(call_id)?;
            if !call_ids.insert(call_id.to_owned()) {
                return Ok(denied_batch("duplicate_call_id"));
            }
            let capability_id = text(fields, "capabilityId")?;
            let arguments = fields.get("arguments").ok_or(Failure::Invalid)?;
            let arguments_digest = tool_batch_arguments_digest(arguments)?;
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
                self.plan_terminal_effect(&origin, arguments, expires_at_ms, workspace_profiles.get(call_id))?
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
            } else if capability_id == guard::WEB_SEARCH_ID {
                self.plan_web_search(
                    session_id, principal, batch_id, call_id, turn_context_digest,
                    arguments, expires_at_ms, managed_attempt_digest.as_deref(),
                )?
            } else {
                return Ok(denied_batch("unsupported_capability"));
            };
            validate_effect_request_deadline(deadline_unix_ms)?;
            match outcome {
                PlanOutcome::Call(mut call) => {
                    call.arguments_digest = arguments_digest;
                    planned.push(call);
                }
                PlanOutcome::Denied(reason) => return Ok(denied_batch(reason)),
            }
        }
        validate_effect_request_deadline(deadline_unix_ms)?;
        let mode_decision = permission_mode
            .map(|mode| classify_direct_mode_batch(mode, &planned))
            .unwrap_or(DirectModeBatchDecision::Ask);
        match mode_decision {
            DirectModeBatchDecision::Deny => return Ok(denied_batch("permission_mode_boundary")),
            DirectModeBatchDecision::Unavailable => return Err(Failure::Unavailable),
            DirectModeBatchDecision::Ask | DirectModeBatchDecision::Candidate => {}
        }
        self.persist_batch_with_direct_mode(
            session_id,
            principal,
            batch_id,
            turn_context_digest,
            guard::EffectOriginKindV1::SessionBatch,
            &planned,
            Some(batch_bytes),
            permission_mode,
        )?;
        let status = if mode_decision == DirectModeBatchDecision::Candidate {
            "mode_approval_candidate"
        } else {
            "needs_approval"
        };
        Ok(batch_approval_value_with_status(batch_id, &planned, status))
    }

    /// Promote only the complete, exact direct-session batch which EffectHost
    /// admitted as a mode candidate. HostKernel must revalidate the live owner,
    /// workspace generation and budget immediately before calling this method;
    /// one-use leases remain HostKernel-owned and are minted only after return.
    pub(crate) fn approve_direct_mode_batch(
        &mut self,
        process_session_id: &str,
        principal: &str,
        owner_epoch: u64,
        batch_id: &str,
        ordered_challenge_ids: &[String],
        permission_mode: &guard::DirectSessionPermissionModeProjectionV1,
    ) -> Result<DirectModeBatchApprovalV1, TypedErrorV1> {
        if ordered_challenge_ids.is_empty()
            || ordered_challenge_ids.len() > MAX_TOOL_BATCH_CALLS
            || owner_epoch == 0
            || !permission_mode.validate()
            || permission_mode.session_id != process_session_id
            || permission_mode.owner_epoch != owner_epoch
            || permission_mode.execution_backend_id != guard::DIRECT_SESSION_EFFECT_BACKEND_ID
            || permission_mode.policy_digest != guard::direct_session_policy_digest()
            || !matches!(
                (permission_mode.sandbox_mode, permission_mode.approval_policy),
                (guard::DirectSandboxModeV1::WorkspaceWrite, guard::DirectApprovalPolicyV1::OnRequest | guard::DirectApprovalPolicyV1::Never)
                    | (guard::DirectSandboxModeV1::DangerFullAccess, guard::DirectApprovalPolicyV1::Never)
            )
        {
            return Err(Failure::Denied.error());
        }
        validate_identifier(batch_id).map_err(Failure::error)?;
        let execution = self.execution.as_ref().ok_or_else(|| Failure::Unavailable.error())?;
        if permission_mode.workspace_root_digest != execution.workspace_binding() {
            return Err(Failure::Conflict.error());
        }
        let mut unique = HashSet::with_capacity(ordered_challenge_ids.len());
        if ordered_challenge_ids.iter().any(|id| validate_identifier(id).is_err() || !unique.insert(id.as_str())) {
            return Err(Failure::Invalid.error());
        }

        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let batch_rows = {
            let mut statement = transaction.prepare(
                "SELECT challenge_id,effect_id,call_index,status,expires_at_ms,
                        direct_permission_mode_digest,direct_permission_mode_revision,
                        lease_id,receipt_digest
                 FROM effect_challenges
                 WHERE session_id=?1 AND principal=?2 AND batch_id=?3
                 ORDER BY call_index ASC",
            ).map_err(|_| Failure::Unavailable.error())?;
            let rows = statement.query_map(params![process_session_id, principal, batch_id], |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?,
                    row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?,
                ))
            }).map_err(|_| Failure::Unavailable.error())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|_| Failure::Unavailable.error())?
        };
        if batch_rows.len() != ordered_challenge_ids.len() {
            return Err(Failure::Conflict.error());
        }
        let mut effect_ids = Vec::with_capacity(batch_rows.len());
        for (index, row) in batch_rows.iter().enumerate() {
            if row.0 != ordered_challenge_ids[index]
                || row.2 != Some(index as i64)
                || row.3 != "AWAITING_APPROVAL"
                || row.4 <= now_ms().map_err(Failure::error)? as i64
                || row.5.as_deref() != Some(permission_mode.digest.as_str())
                || row.6.as_deref() != Some(permission_mode.revision.to_string().as_str())
                || row.7.is_some()
                || row.8.is_some()
            {
                return Err(Failure::Conflict.error());
            }
            let challenge = load_challenge(&transaction, &row.0)
                .map_err(Failure::error)?
                .ok_or_else(|| Failure::NotFound.error())?;
            if challenge.session_id != process_session_id
                || challenge.principal != principal
                || challenge.batch_id != batch_id
                || challenge_origin_kind(&challenge) != guard::EffectOriginKindV1::SessionBatch
                || challenge.managed_attempt_digest.is_some()
                || classify_direct_mode_challenge(permission_mode, &challenge) != DirectModeBatchDecision::Candidate
            {
                return Err(Failure::Denied.error());
            }
            let intent = if challenge.capability_id == guard::FILES_PATCH_ID {
                let targets = load_patch_targets(&transaction, &challenge.challenge_id).map_err(Failure::error)?;
                if targets.is_empty() || patch_manifest_digest(&targets) != challenge.content_digest {
                    return Err(Failure::Conflict.error());
                }
                guard_patch_intent(
                    execution, &challenge.session_id, &challenge.principal, &challenge.batch_id,
                    &challenge.call_id, &challenge.content_digest, &challenge.turn_context_digest,
                    &challenge.challenge_id, &targets, None,
                )
            } else {
                let (decision, intent) = guard_decision(
                    execution, &challenge.session_id, &challenge.principal, &challenge.batch_id,
                    &challenge.call_id, &challenge.capability_id, &challenge.requested_path,
                    &challenge.relative_path, &challenge.resource, &challenge.content_digest,
                    &challenge.turn_context_digest, &challenge.challenge_id,
                    guard::EffectOriginKindV1::SessionBatch, None,
                );
                if decision.decision != guard::DecisionKind::Ask {
                    return Err(Failure::Denied.error());
                }
                Some(intent)
            };
            if intent.as_deref() != Some(challenge.argument_digest.as_str()) {
                return Err(Failure::Conflict.error());
            }
            effect_ids.push(row.1.clone());
        }
        let approval_digest = direct_mode_approval_digest(
            batch_id, &permission_mode.digest, &ordered_challenge_ids.iter().zip(&effect_ids)
                .map(|(challenge, effect)| (challenge.as_str(), effect.as_str())).collect::<Vec<_>>(),
        );
        for (challenge_id, effect_id) in ordered_challenge_ids.iter().zip(&effect_ids) {
            let changed = transaction.execute(
                "UPDATE effect_challenges SET status='APPROVED',approved=1
                 WHERE challenge_id=?1 AND effect_id=?2 AND session_id=?3 AND principal=?4
                   AND batch_id=?5 AND status='AWAITING_APPROVAL' AND approved IS NULL
                   AND lease_id IS NULL AND receipt_digest IS NULL
                   AND direct_permission_mode_digest=?6 AND direct_permission_mode_revision=?7",
                params![challenge_id, effect_id, process_session_id, principal, batch_id,
                    permission_mode.digest, permission_mode.revision.to_string()],
            ).map_err(|_| Failure::Unavailable.error())?;
            if changed != 1 {
                return Err(Failure::Conflict.error());
            }
        }
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(DirectModeBatchApprovalV1 {
            batch_id: batch_id.to_owned(),
            challenge_ids: ordered_challenge_ids.to_vec(),
            effect_ids,
            approval_digest,
        })
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
            arguments_digest: String::new(),
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

    /// One atomic web.search ToolBatch member. Its complete bounded cascade plan
    /// is the approved argument bundle; per-route intents are minted only inside
    /// the later HostKernel cascade operation.
    fn plan_web_search(
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
        let fields = strict_map_optional(arguments, &["query", "limit", "routes"], &["credentialRefsByRoute"])?;
        let query = text(fields, "query")?;
        if query.trim() != query || query.is_empty() || query.len() > 2_000 {
            return Err(Failure::Invalid);
        }
        let Some(Value::Unsigned(1..=10)) = fields.get("limit") else { return Err(Failure::Invalid) };
        let Some(Value::Array(routes)) = fields.get("routes") else { return Err(Failure::Invalid) };
        if routes.is_empty() || routes.len() > 11 { return Err(Failure::Invalid) }
        let mut unique_routes = HashSet::with_capacity(routes.len());
        for route in routes {
            let route = strict_map(route, &["routeKey", "attemptCount"])?;
            let route_key = text(route, "routeKey")?;
            let Some(Value::Unsigned(2)) = route.get("attemptCount") else { return Err(Failure::Invalid) };
            if !unique_routes.insert(route_key) || !valid_search_route_key(route_key) {
                return Err(Failure::Invalid);
            }
        }
        let route_keys = routes.iter().map(|route| {
            let fields = strict_map(route, &["routeKey", "attemptCount"])?;
            Ok(text(fields, "routeKey")?)
        }).collect::<Result<HashSet<_>, Failure>>()?;
        let mut credential_routes = HashSet::new();
        if let Some(value) = fields.get("credentialRefsByRoute") {
            let Value::Array(credentials) = value else { return Err(Failure::Invalid) };
            if credentials.len() > 11 { return Err(Failure::Invalid) }
            for credential in credentials {
                let credential = strict_map(credential, &["routeKey", "secretRef"])?;
                let route_key = text(credential, "routeKey")?;
                let secret_ref = text(credential, "secretRef")?;
                if !matches!(route_key, "brave" | "exa" | "youcom" | "tavily" | "firecrawl" | "parallel")
                    || !route_keys.contains(route_key) || !credential_routes.insert(route_key)
                    || secret_ref.is_empty() || secret_ref.len() > 256
                    || !secret_ref.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
                {
                    return Err(Failure::Invalid);
                }
            }
        }
        for route_key in route_keys {
            if !route_key.ends_with("_keyless") && route_key != "youcom_free"
                && !credential_routes.contains(route_key)
            {
                return Err(Failure::Invalid);
            }
        }
        let execution = self.execution.as_ref().ok_or(Failure::Unavailable)?;
        let challenge_id = random_id("ch")?;
        let effect_id = random_id("eff")?;
        let bundle_bytes = messagepack::encode(arguments, FRAME_LIMITS).map_err(|_| Failure::Invalid)?;
        let bundle_digest = digest_bytes(&bundle_bytes);
        let (decision, argument_digest) = guard_http_decision(
            execution, session_id, principal, batch_id, call_id, &bundle_digest,
            turn_context_digest, &challenge_id, managed_attempt_digest,
        );
        if decision.decision != guard::DecisionKind::Ask {
            return Ok(PlanOutcome::Denied(decision.reason_code.unwrap_or("guard_denied")));
        }
        Ok(PlanOutcome::Call(PlannedCall {
            call_id: call_id.to_owned(),
            capability_id: guard::WEB_SEARCH_ID.to_owned(),
            challenge_id,
            effect_id,
            arguments_digest: String::new(),
            argument_digest,
            content_digest: bundle_digest,
            expires_at_ms,
            managed_attempt_digest: managed_attempt_digest.map(str::to_owned),
            effect: PlannedEffect::WebSearch {
                requested_path: ".".to_owned(),
                relative_path: ".".to_owned(),
                resource: "web.search".to_owned(),
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
        if guard::is_automation_definition_action(capability_id) {
            if !session_id.is_empty()
                || fields.contains_key("managedAttempt")
                || fields.contains_key("directAttempt")
            {
                return Err(Failure::Denied);
            }
            return self.prepare_guarded_control_user_effect(principal, user_action_id, capability_id,
                session_id, fields.get("arguments").ok_or(Failure::Invalid)?, None);
        }
        if capability_id == guard::AGENTS_MESSAGE_ID {
            if session_id.is_empty()
                || fields.contains_key("managedAttempt") == fields.contains_key("directAttempt")
            {
                return Err(Failure::Denied);
            }
            let scope = EffectAttemptScopeV1::from_fields(fields).ok_or(Failure::Denied)?;
            if scope.session_id() != session_id {
                return Err(Failure::Denied);
            }
            if let EffectAttemptScopeV1::Managed(scope) = &scope {
                let pins = crate::protocol::ManagedMessageAuthorityPinsV1::from_value(
                    fields.get("arguments").ok_or(Failure::Invalid)?,
                ).ok_or(Failure::Denied)?;
                if pins.goal_id != scope.goal_id
                    || pins.run_id != scope.run_id
                    || pins.task_id != scope.task_id
                    || pins.attempt_id != scope.attempt_id
                    || pins.child_session_id != scope.session_id
                    || pins.owner_epoch != scope.owner_epoch
                    || pins.binding_digest != scope.delegation_binding_digest
                {
                    return Err(Failure::Denied);
                }
            }
            let scope_digest = parse_effect_attempt_scope_digest(fields, session_id)?
                .ok_or(Failure::Denied)?;
            return self.prepare_guarded_control_user_effect(
                principal, user_action_id, capability_id, session_id,
                fields.get("arguments").ok_or(Failure::Invalid)?, Some(scope_digest),
            );
        }
        if guard::is_protocol_io_action(capability_id) {
            let managed_attempt_digest = parse_effect_attempt_scope_digest(fields, session_id)?;
            if session_id.is_empty() {
                return Err(Failure::Denied);
            }
            return self.prepare_protocol_user_effect(
                principal,
                user_action_id,
                session_id,
                capability_id,
                fields.get("arguments").ok_or(Failure::Invalid)?,
                managed_attempt_digest.as_deref(),
            );
        }
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

    fn prepare_guarded_control_user_effect(
        &mut self,
        principal: &str,
        user_action_id: &str,
        capability_id: &str,
        session_id: &str,
        arguments: &Value,
        attempt_scope_digest: Option<String>,
    ) -> Result<Value, Failure> {
        if !guard::is_automation_definition_action(capability_id)
            && capability_id != guard::AGENTS_MESSAGE_ID
        {
            return Err(Failure::Invalid);
        }
        let execution = self.execution.as_ref().ok_or(Failure::Unavailable)?;
        let encoded = messagepack::encode(arguments, FRAME_LIMITS).map_err(|_| Failure::Invalid)?;
        if encoded.len() > 128 * 1024 {
            return Err(Failure::Invalid);
        }
        let content_digest = format!("blake3:{}", blake3::hash(&encoded).to_hex());
        let challenge_id = random_id("ch")?;
        let effect_id = random_id("eff")?;
        let root = execution.root().to_string_lossy().into_owned();
        let (decision, argument_digest) = guard_decision(
            execution, session_id, principal, user_action_id, user_action_id,
            capability_id, &root, ".", ".", &content_digest, "", &challenge_id,
            guard::EffectOriginKindV1::UserAction, attempt_scope_digest.as_deref(),
        );
        if decision.decision != guard::DecisionKind::Ask {
            return Ok(map_value([
                ("status", Value::String("denied".to_owned())),
                ("reason", Value::String(decision.reason_code.unwrap_or("guard_denied").to_owned())),
            ]));
        }
        let expires_at_ms = now_ms()?.checked_add(CHALLENGE_TTL_MS).ok_or(Failure::Unavailable)?;
        let call = PlannedCall {
            call_id: user_action_id.to_owned(),
            capability_id: capability_id.to_owned(),
            challenge_id,
            effect_id,
            arguments_digest: String::new(),
            argument_digest,
            content_digest,
            expires_at_ms,
            managed_attempt_digest: attempt_scope_digest,
            effect: PlannedEffect::GuardedControl {
                requested_path: root,
                relative_path: ".".to_owned(),
                resource: ".".to_owned(),
                operation: capability_id.to_owned(),
            },
        };
        // Automation definitions are authenticated workspace-owner actions and stay
        // sessionless. A direct child mailbox approval is tied to the exact child
        // Session so the later HostKernel approval resolution cannot substitute a
        // different Session label.
        let persisted_session_id = if capability_id == guard::AGENTS_MESSAGE_ID {
            session_id
        } else {
            ""
        };
        self.persist_batch(persisted_session_id, principal, user_action_id, "",
            guard::EffectOriginKindV1::UserAction, std::slice::from_ref(&call), None)?;
        Ok(single_approval_value(&call))
    }

    fn prepare_protocol_user_effect(
        &mut self,
        principal: &str,
        user_action_id: &str,
        session_id: &str,
        capability_id: &str,
        arguments: &Value,
        managed_attempt_digest: Option<&str>,
    ) -> Result<Value, Failure> {
        if !guard::is_protocol_io_action(capability_id)
            || session_id.is_empty()
            || managed_attempt_digest.is_some_and(|digest| !is_blake3_digest(digest))
        {
            return Err(Failure::Denied);
        }
        let execution = self.execution.as_ref().ok_or(Failure::Unavailable)?;
        let encoded = messagepack::encode(arguments, FRAME_LIMITS).map_err(|_| Failure::Invalid)?;
        if encoded.len() > 1024 * 1024 {
            return Err(Failure::Invalid);
        }
        let content_digest = format!("blake3:{}", blake3::hash(&encoded).to_hex());
        let challenge_id = random_id("ch")?;
        let effect_id = random_id("eff")?;
        let root = execution.root().to_string_lossy().into_owned();
        let (decision, argument_digest) = guard_decision(
            execution,
            session_id,
            principal,
            user_action_id,
            user_action_id,
            capability_id,
            &root,
            ".",
            ".",
            &content_digest,
            "",
            &challenge_id,
            guard::EffectOriginKindV1::UserAction,
            managed_attempt_digest,
        );
        if decision.decision != guard::DecisionKind::Ask {
            return Ok(map_value([
                ("status", Value::String("denied".to_owned())),
                ("reason", Value::String(decision.reason_code.unwrap_or("guard_denied").to_owned())),
            ]));
        }
        let expires_at_ms = now_ms()?.checked_add(CHALLENGE_TTL_MS).ok_or(Failure::Unavailable)?;
        let call = PlannedCall {
            call_id: user_action_id.to_owned(),
            capability_id: capability_id.to_owned(),
            challenge_id,
            effect_id,
            arguments_digest: String::new(),
            argument_digest,
            content_digest,
            expires_at_ms,
            managed_attempt_digest: managed_attempt_digest.map(str::to_owned),
            effect: PlannedEffect::GuardedControl {
                requested_path: root,
                relative_path: ".".to_owned(),
                resource: ".".to_owned(),
                operation: capability_id.to_owned(),
            },
        };
        self.persist_batch(
            session_id,
            principal,
            user_action_id,
            "",
            guard::EffectOriginKindV1::UserAction,
            std::slice::from_ref(&call),
            None,
        )?;
        Ok(single_approval_value(&call))
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
        let managed_root_worktree = matches!(
            first.capability_id.as_str(),
            guard::GIT_WORKTREE_ACQUIRE_ID
                | guard::GIT_WORKTREE_LIST_ID
                | guard::GIT_WORKTREE_RELEASE_ID
        ) && first.origin_kind == guard::EffectOriginKindV1::ManagedRoot;
        let user_stdio_launch = (is_stdio_launch_capability(&first.capability_id)
            || first.capability_id == guard::FILES_READ_ID)
            && first.origin_kind == guard::EffectOriginKindV1::UserAction;
        let process_scope_valid = match &first.scope {
            crate::terminal_process::StdioExecutionScopeV1::Session { session_id } => {
                !session_id.is_empty() && session_id == &first.session_id
            }
            crate::terminal_process::StdioExecutionScopeV1::ProjectRead { workspace_id } => {
                first.capability_id == guard::FILES_READ_ID
                    && first.session_id.is_empty()
                    && first.managed_attempt_digest.is_none()
                    && !workspace_id.is_empty()
            }
        };
        let managed_code_mode_launch = first.capability_id == guard::CODE_MODE_EXECUTE_ID
            && first.origin_kind == guard::EffectOriginKindV1::ManagedRun;
        if git_worktree
            && (authorizations.len() != 1
                || first.profile_id != "git-worktree"
                || first.session_id.is_empty()
                || first.managed_attempt_digest.is_some())
        {
            return Err(Failure::Denied.error());
        }
        if managed_root_worktree
            && (authorizations.len() != 1
                || first.profile_id != "git-worktree"
                || first.session_id.is_empty()
                || first.managed_attempt_digest.is_some()
                || first.managed_root_scope_digest.as_deref().is_none_or(|digest| !is_blake3_digest(digest)))
        {
            return Err(Failure::Denied.error());
        }
        if user_stdio_launch
            && (authorizations.len() != 1
                || first.profile_id.is_empty()
                || !process_scope_valid
                || (first.capability_id != guard::FILES_READ_ID && first.session_id.is_empty())
                || (first.capability_id == guard::FILES_READ_ID && first.managed_attempt_digest.is_some())
                || first.managed_root_scope_digest.is_some())
        {
            return Err(Failure::Denied.error());
        }
        if (first.capability_id == guard::CODE_MODE_EXECUTE_ID)
            && (authorizations.len() != 1
                || first.profile_id != "codemode"
                || first.session_id.is_empty()
                || first.resource != "."
                || first.managed_root_scope_digest.is_some()
                || (!user_stdio_launch && !managed_code_mode_launch))
        {
            return Err(Failure::Denied.error());
        }
        if authorizations.iter().any(|authorization| {
            authorization.capability_id != first.capability_id
                || !(verifier || git_worktree || managed_root_worktree || user_stdio_launch || managed_code_mode_launch)
                || authorization.principal != first.principal
                || authorization.execution_principal != first.execution_principal
                || authorization.user_action_id != first.user_action_id
                || authorization.session_id != first.session_id
                || authorization.scope != first.scope
                || authorization.managed_attempt_digest != first.managed_attempt_digest
                || authorization.managed_root_scope_digest != first.managed_root_scope_digest
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
        if first.execution_principal.is_empty()
            || first.execution_principal.len() > 256
            || first.execution_principal.chars().any(char::is_control)
            || verifier && first.execution_principal == first.principal
            || !verifier && first.execution_principal != first.principal
        {
            return Err(Failure::Denied.error());
        }
        if first
            .managed_attempt_digest
            .as_deref()
            .is_some_and(|digest| !is_blake3_digest(digest))
            || first.origin_kind == guard::EffectOriginKindV1::ManagedRun
                && first.managed_attempt_digest.is_none()
            || first.origin_kind == guard::EffectOriginKindV1::ManagedRoot
                && first.managed_root_scope_digest.as_deref().is_none_or(|digest| !is_blake3_digest(digest))
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
        if verifier {
            if let Some(existing) = self
                .existing_broker_process_set(&authorizations)
                .map_err(Failure::error)?
            {
                return Ok(existing);
            }
        }
        if first.capability_id == guard::FILES_READ_ID
            && first.origin_kind == guard::EffectOriginKindV1::UserAction
        {
            if let Some(existing) = self
                .existing_user_git_read_call(first)
                .map_err(Failure::error)?
            {
                return Ok(vec![existing]);
            }
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
                authorization.managed_root_scope_digest.as_deref(),
            );
            if decision.decision != guard::DecisionKind::Ask {
                return Err(Failure::Denied.error());
            }
            calls.push(PlannedCall {
                call_id: authorization.call_id.clone(),
                capability_id: authorization.capability_id.clone(),
                challenge_id,
                effect_id,
                arguments_digest: String::new(),
                argument_digest,
                content_digest: authorization.managed_root_scope_digest.clone()
                    .unwrap_or_else(|| authorization.argument_bundle_digest.clone()),
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
                    execution_principal: authorization.execution_principal.clone(),
                    scope: authorization.scope.clone(),
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
            None,
        )
        .map_err(Failure::error)?;
        Ok(calls.iter().map(single_approval_value).collect())
    }

    /// Exact idempotent replay for HostKernel-derived managed verifier set IDs.
    /// A matching batch with any missing, changed, approved, expired, or uncertain
    /// member is a conflict/UNKNOWN; it is never repaired by minting replacement IDs.
    fn existing_broker_process_set(
        &self,
        authorizations: &[BrokerProcessAuthorizationV1],
    ) -> Result<Option<Vec<Value>>, Failure> {
        let Some(first) = authorizations.first() else {
            return Err(Failure::Invalid);
        };
        let count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM effect_challenges WHERE batch_id=?1 AND session_id=?2 AND principal=?3",
            params![first.user_action_id, first.session_id, first.principal],
            |row| row.get(0),
        ).map_err(|_| Failure::Unavailable)?;
        if count == 0 {
            return Ok(None);
        }
        if usize::try_from(count).ok() != Some(authorizations.len()) {
            return Err(Failure::Conflict);
        }
        let now = now_ms()?;
        let mut replay = Vec::with_capacity(authorizations.len());
        for authorization in authorizations {
            let challenge = self.connection.query_row(
                "SELECT challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
                        relative_path, requested_path, target, resource, existed, argument_digest,
                        content_digest, expires_at_ms, status, after_digest, turn_context_digest,
                        principal, origin_kind, managed_attempt_digest
                 FROM effect_challenges WHERE batch_id=?1 AND session_id=?2 AND principal=?3 AND call_id=?4",
                params![authorization.user_action_id, authorization.session_id,
                    authorization.principal, authorization.call_id],
                row_to_challenge,
            ).optional().map_err(|_| Failure::Unavailable)?
                .ok_or(Failure::Conflict)?;
            if challenge.capability_id != authorization.capability_id
                || challenge.origin_kind != ORIGIN_MANAGED_RUN
                || challenge.managed_attempt_digest.as_deref() != authorization.managed_attempt_digest.as_deref()
                || challenge.requested_path != authorization.workspace_cwd
                || challenge.resource != authorization.resource
                || challenge.content_digest != authorization.argument_bundle_digest
                || !challenge.turn_context_digest.is_empty()
            {
                return Err(Failure::Conflict);
            }
            if challenge.status != "AWAITING_APPROVAL" || challenge.expires_at_ms <= now {
                return Err(Failure::Unknown);
            }
            let profile = load_broker_process_binding(&self.connection, &challenge.challenge_id)?
                .ok_or(Failure::Conflict)?;
            if profile.profile_id != authorization.profile_id
                || profile.execution_principal != authorization.execution_principal
                || profile.executable_path != authorization.executable_path
                || profile.executable_digest != authorization.executable_digest
                || profile.profile_digest != authorization.profile_digest
            {
                return Err(Failure::Conflict);
            }
            replay.push(map_value([
                ("callId", Value::String(challenge.call_id)),
                ("challengeId", Value::String(challenge.challenge_id)),
                ("effectId", Value::String(challenge.effect_id)),
                ("inputDigest", Value::String(challenge.argument_digest)),
                ("expiresAtUnixMs", Value::Unsigned(challenge.expires_at_ms)),
                ("normalizedTargets", Value::Array(vec![map_value([
                    ("target", Value::String(challenge.requested_path)),
                    ("resource", Value::String(challenge.resource)),
                    ("operation", Value::String(format!("verify:{}", authorization.profile_id))),
                    ("existed", Value::Bool(false)),
                ])])),
            ]));
        }
        Ok(Some(replay))
    }

    /// Idempotent lookup for a host-generated FILES_READ call ID before challenge
    /// IDs are minted. Reusing the same operation ID with changed scope, payload,
    /// profile, or terminal state is a conflict/UNKNOWN; it never creates a second
    /// approval or process opportunity.
    fn existing_user_git_read_call(
        &self,
        authorization: &BrokerProcessAuthorizationV1,
    ) -> Result<Option<Value>, Failure> {
        let count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM effect_challenges WHERE session_id=?1 AND principal=?2
               AND call_id=?3 AND capability_id=?4 AND origin_kind=?5 AND batch_id=''",
            params![authorization.session_id, authorization.principal,
                authorization.call_id, guard::FILES_READ_ID, ORIGIN_USER_ACTION],
            |row| row.get(0),
        ).map_err(|_| Failure::Unavailable)?;
        if count == 0 { return Ok(None); }
        if count != 1 { return Err(Failure::Unknown); }
        let challenge = self.connection.query_row(
            "SELECT challenge_id,effect_id,session_id,batch_id,call_id,capability_id,
                    relative_path,requested_path,target,resource,existed,argument_digest,
                    content_digest,expires_at_ms,status,after_digest,turn_context_digest,
                    principal,origin_kind,managed_attempt_digest
             FROM effect_challenges WHERE session_id=?1 AND principal=?2 AND call_id=?3
               AND capability_id=?4 AND origin_kind=?5 AND batch_id=''",
            params![authorization.session_id, authorization.principal,
                authorization.call_id, guard::FILES_READ_ID, ORIGIN_USER_ACTION],
            row_to_challenge,
        ).map_err(|_| Failure::Unavailable)?;
        if challenge.content_digest != authorization.argument_bundle_digest
            || challenge.requested_path != authorization.workspace_cwd
            || challenge.resource != authorization.resource
            || challenge.managed_attempt_digest.is_some()
            || !challenge.turn_context_digest.is_empty()
        {
            return Err(Failure::Conflict);
        }
        let profile = load_broker_process_binding(&self.connection, &challenge.challenge_id)?
            .ok_or(Failure::Conflict)?;
        if profile.profile_id != authorization.profile_id
            || profile.execution_principal != authorization.execution_principal
            || profile.executable_path != authorization.executable_path
            || profile.executable_digest != authorization.executable_digest
            || profile.profile_digest != authorization.profile_digest
        {
            return Err(Failure::Conflict);
        }
        if challenge.status != "AWAITING_APPROVAL" || challenge.expires_at_ms <= now_ms()? {
            return Err(Failure::Unknown);
        }
        let target = vec![map_value([
            ("target", Value::String(challenge.requested_path.clone())),
            ("resource", Value::String(challenge.resource.clone())),
            ("operation", Value::String("read".to_owned())),
            ("existed", Value::Bool(false)),
        ])];
        let call = map_value([
            ("callId", Value::String(challenge.call_id.clone())),
            ("challengeId", Value::String(challenge.challenge_id.clone())),
            ("effectId", Value::String(challenge.effect_id.clone())),
            ("inputDigest", Value::String(challenge.argument_digest.clone())),
            ("expiresAtUnixMs", Value::Unsigned(challenge.expires_at_ms)),
            ("target", Value::String(challenge.target.clone())),
            ("resource", Value::String(challenge.resource.clone())),
            ("existed", Value::Bool(false)),
            ("normalizedTargets", Value::Array(target.clone())),
        ]);
        Ok(Some(map_value([
            ("status", Value::String("needs_approval".to_owned())),
            ("expiresAtUnixMs", Value::Unsigned(challenge.expires_at_ms)),
            ("calls", Value::Array(vec![call])),
            ("challengeId", Value::String(challenge.challenge_id)),
            ("effectId", Value::String(challenge.effect_id)),
            ("inputDigest", Value::String(challenge.argument_digest)),
            ("target", Value::String(challenge.target)),
            ("resource", Value::String(challenge.resource)),
            ("existed", Value::Bool(false)),
            ("normalizedTargets", Value::Array(target)),
        ])))
    }

    fn prepare_terminal_effect(
        &mut self,
        origin: TerminalOrigin<'_>,
        arguments: &Value,
    ) -> Result<Value, Failure> {
        let expires_at_ms = now_ms()?
            .checked_add(CHALLENGE_TTL_MS)
            .ok_or(Failure::Unavailable)?;
        let outcome = self.plan_terminal_effect(&origin, arguments, expires_at_ms, None)?;
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
            None,
        )?;
        Ok(single_approval_value(&call))
    }

    /// Plan one terminal member without persisting anything.
    fn plan_terminal_effect(
        &self,
        origin: &TerminalOrigin<'_>,
        arguments: &Value,
        expires_at_ms: u64,
        workspace_profile: Option<&TerminalWorkspaceProfileProjectionV1>,
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
            if matches!(arguments, Value::Map(fields)
                if matches!(fields.get("mode"), Some(Value::String(mode)) if mode == "workspace_profile")) {
                parse_terminal_workspace_profile_arguments(
                    arguments,
                    workspace_profile.ok_or(Failure::Denied)?,
                    execution.root(),
                )?
            } else {
                if workspace_profile.is_some() { return Err(Failure::Invalid); }
                parse_terminal_arguments(arguments, execution.root())?
            }
        } else {
            if workspace_profile.is_some() { return Err(Failure::Invalid); }
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
            arguments_digest: String::new(),
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
            arguments_digest: String::new(),
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
            None,
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
        batch_payload_bytes: Option<usize>,
    ) -> Result<(), Failure> {
        self.persist_batch_with_direct_mode(
            session_id,
            principal,
            batch_id,
            turn_context_digest,
            origin_kind,
            calls,
            batch_payload_bytes,
            None,
        )
    }

    fn persist_batch_with_direct_mode(
        &mut self,
        session_id: &str,
        principal: &str,
        batch_id: &str,
        turn_context_digest: &str,
        origin_kind: guard::EffectOriginKindV1,
        calls: &[PlannedCall],
        batch_payload_bytes: Option<usize>,
        direct_mode: Option<&guard::DirectSessionPermissionModeProjectionV1>,
    ) -> Result<(), Failure> {
        if direct_mode.is_some_and(|mode| !mode.validate() || mode.session_id != session_id) {
            return Err(Failure::Denied);
        }
        let origin_kind_name = match origin_kind {
            guard::EffectOriginKindV1::SessionBatch => ORIGIN_SESSION_BATCH,
            guard::EffectOriginKindV1::UserAction => ORIGIN_USER_ACTION,
            guard::EffectOriginKindV1::ManagedRun => ORIGIN_MANAGED_RUN,
            guard::EffectOriginKindV1::ManagedRoot => ORIGIN_MANAGED_ROOT,
        };
        let created_at_ms = now_ms()? as i64;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        for (call_index, call) in calls.iter().enumerate() {
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
                PlannedEffect::WebSearch { requested_path, relative_path, resource } => (
                    relative_path.as_str(), requested_path.as_str(), requested_path.as_str(), resource.as_str(), false,
                ),
                PlannedEffect::GuardedControl { requested_path, relative_path, resource, .. } => (
                    relative_path.as_str(), requested_path.as_str(), requested_path.as_str(), resource.as_str(), false,
                ),
            };
            transaction
                .execute(
                    "INSERT INTO effect_challenges (
                        challenge_id, effect_id, session_id, principal, batch_id, call_id,
                        capability_id, relative_path, requested_path, target, resource, existed,
                        argument_digest, content_digest, expires_at_ms, status, approved,
                        after_digest, lease_id, receipt_digest, turn_context_digest, origin_kind,
                        managed_attempt_digest, batch_payload_bytes, call_index,
                        arguments_digest, admitted_intent_digest, managed_wave_receipt_digest,
                        direct_permission_mode_digest, direct_permission_mode_revision
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                               ?15, 'AWAITING_APPROVAL', NULL, NULL, NULL, NULL, ?16, ?17, ?18, ?19,
                               ?20, ?21, ?22, NULL, ?23, ?24)",
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
                        batch_payload_bytes.unwrap_or_default() as i64,
                        call_index as i64,
                        call.arguments_digest,
                        call.argument_digest,
                        direct_mode.map(|mode| mode.digest.as_str()),
                        direct_mode.map(|mode| mode.revision.to_string()),
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
                    execution_principal,
                    scope,
                    ..
                } => {
                    let (scope_kind, scope_workspace_id) = match scope {
                        crate::terminal_process::StdioExecutionScopeV1::Session { .. } => ("session", None),
                        crate::terminal_process::StdioExecutionScopeV1::ProjectRead { workspace_id } =>
                            ("project_read", Some(workspace_id.as_str())),
                    };
                    transaction
                        .execute(
                            "INSERT INTO broker_process_bindings(challenge_id,profile_id,execution_principal,executable_path,executable_digest,profile_digest,scope_kind,scope_workspace_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                            params![call.challenge_id,profile_id,execution_principal,executable_path,executable_digest,profile_digest,scope_kind,scope_workspace_id],
                        )
                        .map_err(|_| Failure::Unavailable)?;
                }
                PlannedEffect::WebSearch { .. } => {}
                PlannedEffect::GuardedControl { .. } => {}
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
                    challenge.managed_attempt_digest.as_deref(),
                    challenge_root_scope_digest(&challenge),
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

    /// Return the exact durable candidate order for one already-approved managed
    /// ToolBatch. Approval only creates candidates; it does not itself prove that
    /// OwnerLog bound the dynamic wave, and it does not issue a dispatch lease.
    pub(crate) fn approved_batch_effect_candidates(
        &self,
        session_id: &str,
        principal: &str,
        batch_id: &str,
        challenge_ids: &[String],
    ) -> Result<Vec<ApprovedBatchEffectCandidateV1>, TypedErrorV1> {
        if validate_identifier(session_id).is_err()
            || validate_identifier(principal).is_err()
            || validate_identifier(batch_id).is_err()
            || challenge_ids.is_empty()
            || challenge_ids.len() > MAX_TOOL_BATCH_CALLS
        { return Err(Failure::Invalid.error()); }
        let mut supplied = HashSet::with_capacity(challenge_ids.len());
        if challenge_ids.iter().any(|id| validate_identifier(id).is_err() || !supplied.insert(id.as_str())) {
            return Err(Failure::Invalid.error());
        }
        let mut statement = self.connection.prepare(
            "SELECT call_index,call_id,challenge_id,effect_id,capability_id,arguments_digest,
                    admitted_intent_digest,status,approved,lease_id,capability_lease_digest,
                    managed_attempt_digest,expires_at_ms,origin_kind
             FROM effect_challenges
             WHERE batch_id=?1 AND session_id=?2 AND principal=?3
             ORDER BY call_index ASC",
        ).map_err(|_| Failure::Unavailable.error())?;
        let rows = statement.query_map(params![batch_id, session_id, principal], |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, Option<i64>>(8)?,
                row.get::<_, Option<String>>(9)?, row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?, row.get::<_, i64>(12)?, row.get::<_, String>(13)?,
            ))
        }).map_err(|_| Failure::Unavailable.error())?;
        let mut candidates = Vec::with_capacity(challenge_ids.len());
        for row in rows {
            let (index, call_id, challenge_id, effect_id, capability_id, arguments_digest,
                 intent_digest, status, approved, lease_id, lease_digest, attempt_scope_digest,
                 expires_at_ms, origin_kind) = row.map_err(|_| Failure::Unavailable.error())?;
            let index = index.filter(|value| (0..MAX_TOOL_BATCH_CALLS as i64).contains(value))
                .ok_or_else(|| Failure::Conflict.error())?;
            if !supplied.contains(challenge_id.as_str())
                || status != "APPROVED" || approved != Some(1) || lease_id.is_some()
                || lease_digest.is_some() || origin_kind != ORIGIN_SESSION_BATCH
                || attempt_scope_digest.as_deref().is_none_or(|digest| !is_blake3_digest(digest))
                || !is_blake3_digest(&arguments_digest) || !is_blake3_digest(&intent_digest)
                || expires_at_ms <= now_ms().map_err(Failure::error)? as i64
            { return Err(Failure::Conflict.error()); }
            candidates.push(ApprovedBatchEffectCandidateV1 {
                call_index: index as u8, call_id, challenge_id, effect_id, capability_id,
                arguments_digest, intent_digest, status, attempt_scope_digest,
            });
        }
        if candidates.len() != challenge_ids.len()
            || candidates.iter().any(|candidate| candidate.attempt_scope_digest.is_none())
            || candidates.windows(2).any(|pair| pair[0].call_index >= pair[1].call_index)
        { return Err(Failure::Conflict.error()); }
        Ok(candidates)
    }

    /// Durably bind the complete approved candidate wave to the exact OwnerLog
    /// append and refreshed Attempt scope, after HostKernel has revalidated that
    /// scope. `wave_digest` is the HostKernel-derived digest of the exact OwnerLog
    /// event (excluding its digest field), and is idempotent only for the identical
    /// digest and edge set.
    /// The private HostKernel caller supplies the receipt proof; Core cannot call
    /// this EffectHost method or mint the proof itself.
    pub(crate) fn validate_approved_batch_effect_wave(
        &mut self,
        session_id: &str,
        principal: &str,
        batch_id: &str,
        refreshed_attempt_scope_digest: &str,
        wave_digest: &str,
        edges: &[ManagedEffectWaveEdgeV1],
    ) -> Result<Vec<ApprovedBatchEffectCandidateV1>, TypedErrorV1> {
        if !is_blake3_digest(refreshed_attempt_scope_digest)
            || !is_blake3_digest(wave_digest)
            || edges.is_empty() || edges.len() > MAX_TOOL_BATCH_CALLS
            || edges.iter().any(|edge| validate_identifier(&edge.call_id).is_err()
                || validate_identifier(&edge.effect_id).is_err()
                || validate_identifier(&edge.capability_id).is_err()
                || !is_blake3_digest(&edge.arguments_digest)
                || !is_blake3_digest(&edge.intent_digest))
            || edges.windows(2).any(|pair| pair[0].call_index >= pair[1].call_index)
        { return Err(Failure::Invalid.error()); }
        let challenge_ids = {
            let mut statement = self.connection.prepare(
                "SELECT challenge_id FROM effect_challenges
                 WHERE batch_id=?1 AND session_id=?2 AND principal=?3 ORDER BY call_index ASC",
            ).map_err(|_| Failure::Unavailable.error())?;
            let rows = statement.query_map(params![batch_id, session_id, principal], |row| row.get::<_, String>(0))
                .map_err(|_| Failure::Unavailable.error())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|_| Failure::Unavailable.error())?
        };
        let candidates = self.approved_batch_effect_candidates(session_id, principal, batch_id, &challenge_ids)?;
        if candidates.len() != edges.len() || candidates.iter().zip(edges).any(|(candidate, edge)|
            candidate.call_index != edge.call_index || candidate.call_id != edge.call_id
                || candidate.effect_id != edge.effect_id || candidate.capability_id != edge.capability_id
                || candidate.arguments_digest != edge.arguments_digest || candidate.intent_digest != edge.intent_digest
                || candidate.attempt_scope_digest.as_deref() != Some(refreshed_attempt_scope_digest))
        { return Err(Failure::Conflict.error()); }

        let transaction = self.connection.transaction().map_err(|_| Failure::Unavailable.error())?;
        let existing: Vec<Option<String>> = {
            let mut statement = transaction.prepare(
                "SELECT managed_wave_receipt_digest FROM effect_challenges
                 WHERE batch_id=?1 AND session_id=?2 AND principal=?3 ORDER BY call_index ASC",
            ).map_err(|_| Failure::Unavailable.error())?;
            let rows = statement.query_map(params![batch_id, session_id, principal], |row| row.get(0))
                .map_err(|_| Failure::Unavailable.error())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|_| Failure::Unavailable.error())?
        };
        if existing.len() != candidates.len()
            || existing.iter().any(|stored| stored.as_deref().is_some_and(|value| value != wave_digest))
        { return Err(Failure::Conflict.error()); }
        for candidate in &candidates {
            let changed = transaction.execute(
                "UPDATE effect_challenges SET managed_wave_receipt_digest=?1
                 WHERE challenge_id=?2 AND batch_id=?3 AND session_id=?4 AND principal=?5
                   AND status='APPROVED' AND approved=1 AND lease_id IS NULL
                   AND capability_lease_digest IS NULL AND managed_attempt_digest=?6
                   AND (managed_wave_receipt_digest IS NULL OR managed_wave_receipt_digest=?1)",
                params![wave_digest, candidate.challenge_id, batch_id, session_id,
                    principal, refreshed_attempt_scope_digest],
            ).map_err(|_| Failure::Unavailable.error())?;
            if changed != 1 { return Err(Failure::Conflict.error()); }
        }
        transaction.commit().map_err(|_| Failure::Unavailable.error())?;
        Ok(candidates)
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
                transaction.execute(
                    "UPDATE managed_verifier_preflights SET status='INVALID' WHERE challenge_id=?1 AND status='PREPARED'",
                    [&challenge.challenge_id],
                ).map_err(|_| Failure::Unavailable.error())?;
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
                let preflight: Option<(String, String, String, String)> = transaction.query_row(
                    "SELECT binding_digest,launch_digest,guarantee_digest,guarantee_record
                     FROM managed_verifier_preflights
                     WHERE challenge_id=?1 AND effect_id=?2 AND status='PREPARED'",
                    params![challenge.challenge_id, challenge.effect_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                ).optional().map_err(|_| Failure::Unavailable.error())?;
                let Some((binding_digest, launch_digest, guarantee_digest, guarantee_record)) = preflight else {
                    return Err(Failure::Denied.error());
                };
                if !is_blake3_digest(&binding_digest)
                    || !is_blake3_digest(&launch_digest)
                    || !is_blake3_digest(&guarantee_digest)
                    || guarantee_record.is_empty()
                    || guarantee_record.len() > 16 * 1024
                    || crate::terminal_process::stdio_guarantee_record_digest(&guarantee_record) != guarantee_digest
                {
                    return Err(Failure::Denied.error());
                }
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
                    None,
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
                transaction.execute(
                    "UPDATE managed_verifier_preflights SET status='INVALID' WHERE challenge_id=?1 AND status='PREPARED'",
                    [&challenge.challenge_id],
                ).map_err(|_| Failure::Unavailable.error())?;
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
        #[cfg(target_os = "linux")]
        {
            let pending = {
                let mut statement = self.connection.prepare(
                    "SELECT execution_id,effect_id,capability_lease_digest,attempt_scope_digest,owner_epoch,generation,capability_id,
                            profile_id,profile_revision,profile_digest,executable_digest,cgroup_identity,quiescence_digest,execution_principal
                     FROM stdio_executions WHERE status IN ('PREPARED','RUNNING','CANCELLING','UNKNOWN')",
                ).map_err(|_| Failure::Unavailable)?;
                let rows = statement.query_map([], |row| Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, i64>(8)?,
                    row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, Option<Vec<u8>>>(11)?, row.get::<_, Option<String>>(12)?, row.get::<_, String>(13)?,
                ))).map_err(|_| Failure::Unavailable)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|_| Failure::Unavailable)?
            };
            for (execution_id, effect_id, lease_digest, attempt_scope_digest, owner_epoch, generation, capability_id,
                 profile_id, profile_revision, profile_digest, executable_digest, encoded, prior_proof, execution_principal) in pending {
                if prior_proof.as_deref().is_some_and(is_blake3_digest) { continue; }
                let Some(encoded) = encoded else { continue; };
                let Ok(value) = crate::messagepack::decode(&encoded, crate::messagepack::FRAME_LIMITS) else { continue; };
                let Ok(identity) = crate::cgroup_v2::CgroupIdentityV1::from_value(&value) else { continue; };
                if identity.execution_id != execution_id || identity.effect_id != effect_id
                    || identity.capability_lease_digest != lease_digest
                    || identity.attempt_scope_digest != attempt_scope_digest
                    || i64::try_from(identity.owner_epoch).ok() != Some(owner_epoch)
                    || i64::try_from(identity.process_generation).ok() != Some(generation)
                    || identity.process_kind != crate::terminal_process::stdio_process_kind_for_capability(&capability_id)
                        .ok_or_else(|| Failure::Unknown)?.wire_name()
                    || identity.profile_id != profile_id
                    || i64::try_from(identity.profile_revision).ok() != Some(profile_revision)
                    || identity.profile_digest != profile_digest
                    || identity.executable_digest != executable_digest
                    || identity.execution_principal != execution_principal
                { continue; }
                // This proves only that the exact authenticated containment boundary
                // is empty. It is not an execution receipt, so the outcome remains
                // UNKNOWN and the challenge is not settled.
                let Ok(proof) = crate::cgroup_v2::ExecutionCgroupV2::kill_and_confirm_empty(&identity) else { continue; };
                self.connection.execute(
                    "UPDATE stdio_executions SET quiescence_digest=?1,updated_at_ms=?2
                     WHERE execution_id=?3 AND effect_id=?4 AND status IN ('PREPARED','RUNNING','CANCELLING','UNKNOWN')",
                    params![proof, now_ms()? as i64, execution_id, effect_id],
                ).map_err(|_| Failure::Unavailable)?;
                let _ = crate::cgroup_v2::ExecutionCgroupV2::retain_if_empty(&identity);
            }
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| Failure::Unavailable)?;
        // A restarted HostKernel cannot prove that an owned descendant or
        // callback stopped. Keep the exact dispatch row UNKNOWN and preserve
        // its challenge fence; only an authenticated supervisor exit receipt
        // may make this capacity available again.
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
        transaction.execute(
            "UPDATE execution_repl_callback_replies SET status='UNKNOWN',updated_at_ms=?1
             WHERE status='DISPATCHING'",
            [now_ms()? as i64],
        ).map_err(|_| Failure::Unavailable)?;
        transaction.execute(
            "UPDATE execution_repl_callback_events SET status='UNKNOWN',updated_at_ms=?1
             WHERE status='PENDING' AND execution_id IN
                 (SELECT execution_id FROM stdio_executions WHERE status='UNKNOWN')",
            [now_ms()? as i64],
        ).map_err(|_| Failure::Unavailable)?;
        transaction.commit().map_err(|_| Failure::Unavailable)
    }

    fn reconcile_terminal_processes(&mut self) -> Result<(), Failure> {
        #[cfg(target_os = "linux")]
        {
            let pending: Vec<(String,Option<Vec<u8>>)> = {
                let mut statement = self.connection.prepare(
                    "SELECT effect_id,cgroup_identity FROM terminal_runs
                     WHERE status IN ('PREPARED','UNKNOWN')",
                ).map_err(|_|Failure::Unavailable)?;
                let rows = statement.query_map([],|row|Ok((row.get(0)?,row.get(1)?)))
                    .map_err(|_|Failure::Unavailable)?;
                rows.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable)?
            };
            for (effect_id, encoded) in pending {
                let Some(encoded) = encoded else { continue; };
                let Ok(value) = crate::messagepack::decode(&encoded, FRAME_LIMITS) else { continue; };
                let Ok(identity) = crate::cgroup_v2::CgroupIdentityV1::from_value(&value) else { continue; };
                let Some(challenge) = load_effect(&self.connection,&effect_id)? else { continue; };
                let expected_kind = match challenge.capability_id.as_str() {
                    guard::TERMINAL_RUN_ID => "terminal_run",
                    guard::TERMINAL_START_ID => "terminal_start",
                    _ => continue,
                };
                if identity.effect_id != effect_id
                    || identity.capability_lease_digest != challenge.capability_lease_digest.as_deref().unwrap_or_default()
                    || identity.execution_principal != challenge.principal
                    || identity.attempt_scope_digest != challenge.managed_attempt_digest
                    || identity.process_kind != expected_kind
                { continue; }
                let Ok(proof) = crate::cgroup_v2::ExecutionCgroupV2::kill_and_confirm_empty(&identity) else { continue; };
                self.connection.execute(
                    "UPDATE terminal_runs SET quiescence_digest=?1
                     WHERE effect_id=?2 AND cgroup_identity=?3 AND status IN ('PREPARED','UNKNOWN')",
                    params![proof,effect_id,encoded],
                ).map_err(|_|Failure::Unavailable)?;
                let _ = crate::cgroup_v2::ExecutionCgroupV2::retain_if_empty(&identity);
            }
        }
        self.connection.execute(
            "UPDATE terminal_runs SET status='UNKNOWN' WHERE status='PREPARED'",
            [],
        ).map_err(|_|Failure::Unavailable)?;
        Ok(())
    }

    /// Fence editor dispatch after owner restart and persist quiescence separately
    /// from the editor outcome. An unknown editor result remains UNKNOWN even when
    /// its exact process tree is now confirmed empty.
    fn reconcile_external_editor_processes(&mut self) -> Result<(), Failure> {
        #[cfg(target_os = "linux")]
        {
            let pending: Vec<(String,String,String,String,String,String,Option<Vec<u8>>,Option<String>)> = {
                let mut statement = self.connection.prepare(
                    "SELECT effect_id,challenge_id,execution_id,binding_digest,profile_id,profile_digest,
                            cgroup_identity,quiescence_digest FROM external_editor_runs
                     WHERE status IN ('PREPARED','RUNNING','UNKNOWN')",
                ).map_err(|_|Failure::Unavailable)?;
                let rows=statement.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)))
                    .map_err(|_|Failure::Unavailable)?;
                rows.collect::<Result<Vec<_>,_>>().map_err(|_|Failure::Unavailable)?
            };
            for (effect,challenge_id,execution,binding,profile,profile_digest,encoded,prior_proof) in pending {
                let Some(encoded)=encoded else {continue};
                let Ok(value)=crate::messagepack::decode(&encoded,FRAME_LIMITS) else {continue};
                let Ok(identity)=crate::cgroup_v2::CgroupIdentityV1::from_value(&value) else {continue};
                let challenge=load_effect(&self.connection,&effect)?.ok_or(Failure::Unknown)?;
                if identity.effect_id!=effect || identity.execution_id!=execution || identity.process_kind!="external_editor"
                    || identity.profile_id!=profile || identity.profile_digest!=profile_digest
                    || challenge.challenge_id!=challenge_id || challenge.capability_id!=guard::EDITOR_LAUNCH_ID
                    || challenge.capability_lease_digest.as_deref()!=Some(identity.capability_lease_digest.as_str())
                    || challenge.principal!=identity.execution_principal || challenge.managed_attempt_digest!=identity.attempt_scope_digest
                {continue;}
                let proof = match prior_proof {
                    Some(proof) if is_blake3_digest(&proof) => proof,
                    _ => match crate::cgroup_v2::ExecutionCgroupV2::kill_and_confirm_empty(&identity) {
                        Ok(proof)=>proof, Err(_)=>continue,
                    },
                };
                let tx=self.connection.transaction().map_err(|_|Failure::Unavailable)?;
                tx.execute("UPDATE external_editor_runs SET status='UNKNOWN',quiescence_digest=?1,updated_at_ms=?2
                    WHERE effect_id=?3 AND challenge_id=?4 AND execution_id=?5 AND binding_digest=?6
                      AND cgroup_identity=?7 AND status IN ('PREPARED','RUNNING','UNKNOWN')",
                    params![proof,now_ms()? as i64,effect,challenge_id,execution,binding,encoded]).map_err(|_|Failure::Unavailable)?;
                tx.execute("UPDATE effect_challenges SET status='UNKNOWN' WHERE effect_id=?1 AND challenge_id=?2
                    AND capability_id=?3 AND status IN ('PREPARED','RUNNING','UNKNOWN')",
                    params![effect,challenge_id,guard::EDITOR_LAUNCH_ID]).map_err(|_|Failure::Unavailable)?;
                tx.commit().map_err(|_|Failure::Unavailable)?;
            }
        }
        Ok(())
    }

    /// Owner-only janitor for exact, durably quiescent execution cgroups. A cgroup
    /// is eligible only after its source row is terminal/UNKNOWN and every persisted
    /// identity pin still matches that row. Legacy identities decode with visibility
    /// false and are intentionally retained.
    fn reap_quiescent_execution_cgroups(&self) {
        #[cfg(target_os = "linux")]
        {
            let terminal: Vec<(String, Option<Vec<u8>>, Option<String>, String)> = match self.connection.prepare(
                "SELECT effect_id,cgroup_identity,quiescence_digest,status FROM terminal_runs
                 WHERE status IN ('SETTLED','CANCELLED','UNKNOWN') AND quiescence_digest IS NOT NULL",
            ) {
                Ok(mut statement) => statement.query_map([], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))
                    .and_then(|rows| rows.collect::<Result<Vec<_>,_>>()).unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            for (effect_id, encoded, proof, status) in terminal {
                let (Some(encoded),Some(proof))=(encoded,proof) else {continue};
                if !is_blake3_digest(&proof) {continue;}
                let Ok(value)=crate::messagepack::decode(&encoded,FRAME_LIMITS) else {continue};
                let Ok(identity)=crate::cgroup_v2::CgroupIdentityV1::from_value(&value) else {continue};
                let Some(challenge)=load_effect(&self.connection,&effect_id).ok().flatten() else {continue};
                let expected_kind=if challenge.capability_id==guard::TERMINAL_RUN_ID {"terminal_run"}
                    else if challenge.capability_id==guard::TERMINAL_START_ID {"terminal_start"} else {continue};
                let challenge_state_matches = match status.as_str() {
                    "SETTLED" | "CANCELLED" => challenge.status == "SETTLED",
                    "UNKNOWN" => challenge.status == "UNKNOWN",
                    _ => false,
                };
                if identity.effect_id==effect_id && identity.capability_lease_digest==challenge.capability_lease_digest.as_deref().unwrap_or_default()
                    && identity.execution_principal==challenge.principal && identity.attempt_scope_digest==challenge.managed_attempt_digest
                    && identity.process_kind==expected_kind && challenge_state_matches
                    && !self.has_live_cgroup_row_reference(&encoded)
                { let _=crate::cgroup_v2::ExecutionCgroupV2::remove_quiescent_if_empty(&identity,&proof); }
            }

            let stdio: Vec<(String,String,String,Option<String>,String,i64,i64,String,String,String,String,Option<Vec<u8>>,Option<String>,String,String)> = match self.connection.prepare(
                "SELECT execution_id,effect_id,capability_lease_digest,attempt_scope_digest,capability_id,owner_epoch,generation,
                        profile_id,profile_revision,profile_digest,executable_digest,cgroup_identity,quiescence_digest,status,execution_principal
                 FROM stdio_executions WHERE status IN ('SETTLED','CANCELLED','UNKNOWN') AND quiescence_digest IS NOT NULL",
            ) {
                Ok(mut statement) => statement.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?,r.get(14)?)))
                    .and_then(|rows| rows.collect::<Result<Vec<_>,_>>()).unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            for (execution,effect,lease,scope,capability,epoch,generation,profile,revision,digest,executable,encoded,proof,status,principal) in stdio {
                let (Some(encoded),Some(proof))=(encoded,proof) else {continue};
                if !is_blake3_digest(&proof) {continue;}
                let Ok(value)=crate::messagepack::decode(&encoded,FRAME_LIMITS) else {continue};
                let Ok(identity)=crate::cgroup_v2::CgroupIdentityV1::from_value(&value) else {continue};
                let expected_kind=crate::terminal_process::stdio_process_kind_for_capability(&capability).map(|kind|kind.wire_name());
                if expected_kind==Some(identity.process_kind.as_str()) && identity.execution_id==execution && identity.effect_id==effect
                    && identity.capability_lease_digest==lease && identity.attempt_scope_digest==scope
                    && i64::try_from(identity.owner_epoch).ok()==Some(epoch) && i64::try_from(identity.process_generation).ok()==Some(generation)
                    && identity.profile_id==profile && i64::try_from(identity.profile_revision).ok()==Some(revision)
                    && identity.profile_digest==digest && identity.executable_digest==executable && identity.execution_principal==principal
                    && (match status.as_str() {
                        "SETTLED" => load_effect(&self.connection,&effect).ok().flatten().is_some_and(|c|c.status=="SETTLED"),
                        "CANCELLED" => load_effect(&self.connection,&effect).ok().flatten().is_some_and(|c|c.status=="SETTLED"),
                        "UNKNOWN" => load_effect(&self.connection,&effect).ok().flatten().is_some_and(|c|c.status=="UNKNOWN"),
                        _ => false,
                    })
                    && !self.has_live_cgroup_row_reference(&encoded)
                { let _=crate::cgroup_v2::ExecutionCgroupV2::remove_quiescent_if_empty(&identity,&proof); }
            }

            let editors: Vec<(String,String,String,String,String,String,String,String,Option<Vec<u8>>,Option<String>,String)> = match self.connection.prepare(
                "SELECT effect_id,challenge_id,execution_id,binding_digest,profile_id,profile_revision,profile_digest,executable_digest,
                        cgroup_identity,quiescence_digest,status FROM external_editor_runs
                 WHERE status IN ('SETTLED','CANCELLED','UNKNOWN') AND quiescence_digest IS NOT NULL",
            ) {
                Ok(mut statement) => statement.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?)))
                    .and_then(|rows| rows.collect::<Result<Vec<_>,_>>()).unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            for (effect,challenge_id,execution,binding,profile,revision,digest,executable,encoded,proof,status) in editors {
                let (Some(encoded),Some(proof))=(encoded,proof) else {continue};
                if !is_blake3_digest(&proof) {continue;}
                let Ok(value)=crate::messagepack::decode(&encoded,FRAME_LIMITS) else {continue};
                let Ok(identity)=crate::cgroup_v2::CgroupIdentityV1::from_value(&value) else {continue};
                let challenge=load_effect(&self.connection,&effect).ok().flatten();
                let binding_matches: bool = self.connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM external_editor_runs WHERE effect_id=?1 AND challenge_id=?2
                     AND execution_id=?3 AND binding_digest=?4 AND cgroup_identity=?5 AND quiescence_digest=?6
                     AND status=?7)",
                    params![effect,challenge_id,execution,binding,encoded,proof,status],|row|row.get(0),
                ).unwrap_or(false);
                if identity.effect_id==effect && identity.execution_id==execution && identity.profile_id==profile
                    && identity.profile_revision.to_string()==revision && identity.profile_digest==digest && identity.executable_digest==executable
                    && identity.process_kind=="external_editor" && challenge.is_some_and(|c|c.challenge_id==challenge_id && match status.as_str() {
                        "SETTLED" | "CANCELLED" => c.status=="SETTLED",
                        "UNKNOWN" => c.status=="UNKNOWN",
                        _ => false,
                    })
                    && !self.has_live_cgroup_row_reference(&encoded)
                    && binding_matches
                { let _=crate::cgroup_v2::ExecutionCgroupV2::remove_quiescent_if_empty(&identity,&proof); }
            }
        }
    }

    /// A terminal row is eligible for cleanup only if no live durable execution
    /// record, including another effect family, still points at the exact encoded
    /// identity. This protects against accidental ID reuse and stale cross-table
    /// ownership; unreadable or migrated storage retains the cgroup.
    #[cfg(target_os = "linux")]
    fn has_live_cgroup_row_reference(&self, identity: &[u8]) -> bool {
        self.connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM terminal_runs WHERE cgroup_identity=?1 AND status NOT IN ('SETTLED','CANCELLED','UNKNOWN')
                UNION ALL
                SELECT 1 FROM stdio_executions WHERE cgroup_identity=?1 AND status NOT IN ('SETTLED','CANCELLED','UNKNOWN')
                UNION ALL
                SELECT 1 FROM external_editor_runs WHERE cgroup_identity=?1 AND status NOT IN ('SETTLED','CANCELLED','UNKNOWN')
            )",
            [identity],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(true)
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
        for capability_id in guard::PROTOCOL_IO_CAPABILITY_IDS {
            self.connection
                .execute(
                    "UPDATE effect_challenges SET status='EXPIRED',approved=NULL,lease_id=NULL
                     WHERE origin_kind=?1 AND capability_id=?2
                       AND status IN ('AWAITING_APPROVAL','APPROVED')",
                    params![ORIGIN_USER_ACTION, capability_id],
                )
                .map_err(|_| Failure::Unavailable)?;
        }
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
            if guard::is_protocol_io_action(&challenge.capability_id) {
                // Protocol payload authority is tied to an in-memory process
                // generation and owner epoch. Recovery never reuses it or approves
                // an operation whose dispatch boundary may have been crossed.
                self.mark_unknown(&challenge.challenge_id)?;
                continue;
            }
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

fn repl_callback_dispatch_receipt_digest(
    execution_id: &str,
    generation: u64,
    event_sequence: u64,
    request_sequence: u64,
    operation_digest: &str,
    observed_io_sequence: u64,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.repl-callback-dispatch-receipt.v1\0");
    let generation = generation.to_string();
    let event_sequence = event_sequence.to_string();
    let request_sequence = request_sequence.to_string();
    let observed_io_sequence = observed_io_sequence.to_string();
    for value in [execution_id, generation.as_str(), event_sequence.as_str(),
        request_sequence.as_str(), operation_digest, observed_io_sequence.as_str()] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn repl_callback_reply_receipt(
    binding: &StdioExecutionBindingV1,
    request: &crate::protocol::ExecutionReplCallbackReplyRequestV1,
    dispatch_receipt_digest: &str,
) -> io::Result<crate::protocol::ExecutionReplCallbackReplyReceiptV1> {
    let host_process_ref = StdioProcessRefV1::from_binding(binding, StdioProcessKindV1::Interpreter)?;
    let receipt = crate::protocol::ExecutionReplCallbackReplyReceiptV1 {
        host_process_ref,
        event_sequence: request.event_sequence,
        request_sequence: request.request_sequence,
        callback_id: request.callback_id.clone(),
        capability_id: request.capability_id.clone(),
        effect_id: request.effect_id.clone(),
        challenge_id: request.challenge_id.clone(),
        capability_lease_digest: request.capability_lease_digest.clone(),
        effect_receipt_digest: request.effect_receipt_digest.clone(),
        operation_digest: request.operation_digest.clone(),
        dispatch_receipt_digest: dispatch_receipt_digest.to_owned(),
    };
    let value = receipt.to_value();
    crate::protocol::ExecutionReplCallbackReplyReceiptV1::from_value(&value)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid callback reply receipt"))
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
    execution_principal: String,
    executable_path: String,
    executable_digest: String,
    profile_digest: String,
    scope: crate::terminal_process::StdioExecutionScopeV1,
}

fn load_broker_process_binding(
    connection: &Connection,
    challenge_id: &str,
) -> Result<Option<BrokerProcessBinding>, Failure> {
    let row: Option<(String, String, String, String, String, String, Option<String>)> = connection
        .query_row(
            "SELECT profile_id,execution_principal,executable_path,executable_digest,profile_digest,scope_kind,scope_workspace_id FROM broker_process_bindings WHERE challenge_id=?1",
            [challenge_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .optional()
        .map_err(|_| Failure::Unavailable)?;
    row.map(|(profile_id, execution_principal, executable_path, executable_digest,
        profile_digest, scope_kind, scope_workspace_id)| {
        let scope = match scope_kind.as_str() {
            "session" if scope_workspace_id.is_none() => {
                let challenge = load_challenge(connection, challenge_id)?
                    .ok_or(Failure::NotFound)?;
                Ok(crate::terminal_process::StdioExecutionScopeV1::Session {
                    session_id: challenge.session_id,
                })
            }
            "project_read" => scope_workspace_id
                .map(|workspace_id| crate::terminal_process::StdioExecutionScopeV1::ProjectRead { workspace_id })
                .ok_or(Failure::Unavailable),
            _ => Err(Failure::Unavailable),
        }?;
        Ok(BrokerProcessBinding {
            profile_id,
            execution_principal,
            executable_path,
            executable_digest,
            profile_digest,
            scope,
        })
    }).transpose()
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

/// User-approved LSP/DAP adapter startup only. REPL remains unavailable until
/// hard CPU/memory/FD/process limits have OS enforcement.
fn is_stdio_launch_capability(capability_id: &str) -> bool {
    matches!(
        capability_id,
        guard::LANGUAGE_SERVER_START_ID | guard::DEBUG_START_ID | guard::CODE_MODE_EXECUTE_ID
            | guard::EDITOR_LAUNCH_ID | guard::FILES_READ_ID
    )
}

fn challenge_origin_kind(challenge: &Challenge) -> guard::EffectOriginKindV1 {
    match challenge.origin_kind.as_str() {
        ORIGIN_USER_ACTION => guard::EffectOriginKindV1::UserAction,
        ORIGIN_MANAGED_RUN => guard::EffectOriginKindV1::ManagedRun,
        ORIGIN_MANAGED_ROOT => guard::EffectOriginKindV1::ManagedRoot,
        _ => guard::EffectOriginKindV1::SessionBatch,
    }
}

fn challenge_root_scope_digest(challenge: &Challenge) -> Option<&str> {
    (challenge.origin_kind == ORIGIN_MANAGED_ROOT).then_some(challenge.content_digest.as_str())
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
    let (policy_id, requested_guarantees) = match guard::approval_policy(capability_id) {
        Some((id, _, guarantees)) => (id, guarantees),
        None => (guard::WORKSPACE_WRITE_POLICY_ID, vec![
            "beneath_workspace_root", "no_symlink", "no_hardlink", "one_use",
        ]),
    };
    let policy_snapshot_ids = [policy_id];
    let request = guard::AuthorizationRequestV1 {
        request_id: batch_id,
        principal,
        origin: guard::EffectOriginV1 {
            kind: origin_kind,
            session_id,
            batch_id,
            call_id,
            scope_digest: None,
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

fn guard_provider_inference_decision(
    execution: &ExecutionHost,
    principal: &str,
    session_id: &str,
    batch_id: &str,
    call_id: &str,
    managed_attempt_digest: &str,
    permission_scope_digest: &str,
    prepare_binding_digest: &str,
    challenge_id: &str,
) -> (guard::GuardDecisionV1, String) {
    let target = execution.root().to_owned();
    let argument_digest = guard::argument_digest(
        session_id, batch_id, call_id, guard::PROVIDERS_INFER_ID, ".", prepare_binding_digest,
    );
    let policy_snapshot_ids = [guard::PROVIDER_INFERENCE_POLICY_ID];
    let request = guard::AuthorizationRequestV1 {
        request_id: batch_id,
        principal,
        origin: guard::EffectOriginV1 {
            kind: guard::EffectOriginKindV1::ManagedRun,
            session_id,
            batch_id,
            call_id,
            scope_digest: Some(permission_scope_digest),
        },
        action_id: guard::PROVIDERS_INFER_ID,
        argument_digest: &argument_digest,
        turn_context_digest: "",
        resource_resolution: guard::ResourceResolutionV1 {
            workspace_root: execution.root(), workspace_binding: execution.workspace_binding(),
            target: &target, resource: ".",
        },
        executable: None,
        policy_snapshot_ids: &policy_snapshot_ids,
        requested_guarantees: guard::PROVIDER_INFERENCE_GUARANTEES,
    };
    let decision = guard::authorize(&request, challenge_id);
    let intent = guard::intent_digest_with_managed_scope(
        &request, &decision, Some(managed_attempt_digest),
    );
    (decision, intent)
}

fn provider_inference_receipt_digest(
    binding_digest: &str,
    dispatch_digest: &str,
    assistant_entry_id: &str,
    response_digest: &str,
    usage_digest: &str,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.providers-infer.settlement.v1\0");
    for field in [binding_digest, dispatch_digest, assistant_entry_id, response_digest, usage_digest] {
        hasher.update(&(field.len() as u64).to_be_bytes());
        hasher.update(field.as_bytes());
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn guard_http_decision(
    execution: &ExecutionHost,
    session_id: &str,
    principal: &str,
    batch_id: &str,
    call_id: &str,
    arguments_digest: &str,
    turn_context_digest: &str,
    challenge_id: &str,
    managed_attempt_digest: Option<&str>,
) -> (guard::GuardDecisionV1, String) {
    let target = execution.root().to_owned();
    let argument_digest = guard::argument_digest(
        session_id, batch_id, call_id, guard::WEB_SEARCH_ID, ".", arguments_digest,
    );
    let policy_snapshot_ids = [guard::OUTBOUND_HTTP_POLICY_ID];
    let request = guard::AuthorizationRequestV1 {
        request_id: batch_id,
        principal,
        origin: guard::EffectOriginV1 {
            kind: guard::EffectOriginKindV1::SessionBatch,
            session_id,
            batch_id,
            call_id,
            scope_digest: None,
        },
        action_id: guard::WEB_SEARCH_ID,
        argument_digest: &argument_digest,
        turn_context_digest,
        resource_resolution: guard::ResourceResolutionV1 {
            workspace_root: execution.root(),
            workspace_binding: execution.workspace_binding(),
            target: &target,
            resource: "web.search",
        },
        executable: None,
        policy_snapshot_ids: &policy_snapshot_ids,
        requested_guarantees: guard::HTTP_GUARANTEES,
    };
    let decision = guard::authorize(&request, challenge_id);
    let intent = guard::intent_digest_with_managed_scope(&request, &decision, managed_attempt_digest);
    (decision, intent)
}

fn valid_search_route_key(route_key: &str) -> bool {
    matches!(route_key,
        "exa_keyless" | "youcom_free" | "firecrawl_keyless" |
        "parallel_keyless" | "brave" | "exa" | "youcom" | "tavily" | "firecrawl" | "parallel")
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
    managed_root_scope_digest: Option<&str>,
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
            scope_digest: managed_root_scope_digest,
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
            "mode",
            "shellProfileID",
            "command",
            "cwd",
            "timeoutMs",
            "resolvedEnvironment",
        ],
    )?;
    if text(fields, "mode")? != "shell" {
        return Err(Failure::Invalid);
    }
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
        terminal_arguments_digest("shell", shell_profile_id, command, cwd, timeout_ms, &environment);
    Ok(TerminalArguments {
        cwd: cwd.to_owned(),
        relative_path: relative_path.to_string_lossy().into_owned(),
        resource,
        digest,
    })
}

fn parse_terminal_workspace_profile_arguments(
    value: &Value,
    projection: &TerminalWorkspaceProfileProjectionV1,
    root: &Path,
) -> Result<TerminalArguments, Failure> {
    let fields = strict_map(value, &["mode", "action", "profileID", "revision", "profileDigest", "arguments"])?;
    let action = match text(fields, "action")? {
        "build" => crate::workspace_command_profile::WorkspaceCommandActionV1::Build,
        "test" => crate::workspace_command_profile::WorkspaceCommandActionV1::Test,
        _ => return Err(Failure::Invalid),
    };
    let revision = text(fields, "revision")?.parse::<u64>().map_err(|_| Failure::Invalid)?;
    if text(fields, "mode")? != "workspace_profile"
        || text(fields, "profileID")? != projection.reference.profile_id
        || revision != projection.reference.revision
        || text(fields, "revision")? != projection.reference.revision.to_string()
        || text(fields, "profileDigest")? != projection.reference.profile_digest
        || action != projection.reference.action
        || projection.profile.profile_id != projection.reference.profile_id
        || projection.profile.revision != projection.reference.revision
        || projection.profile.profile_digest != projection.reference.profile_digest
        || !projection.profile.allows(action)
        || projection.resolved_environment.keys().any(|name| !projection.profile.allowed_environment_names.contains(name))
    {
        return Err(Failure::Denied);
    }
    let Value::Array(values) = fields.get("arguments").ok_or(Failure::Invalid)? else { return Err(Failure::Invalid) };
    let tail = values.iter().map(|value| match value {
        Value::String(value) if value.len() <= 256 && !value.contains('\0') => Ok(value.clone()),
        _ => Err(Failure::Invalid),
    }).collect::<Result<Vec<_>, _>>()?;
    let argv = projection.profile.argv(action, &tail).ok_or(Failure::Denied)?;
    let encoded = messagepack::encode(&Value::Array(vec![
        Value::String(projection.reference.profile_id.clone()),
        Value::Unsigned(projection.reference.revision),
        Value::String(projection.reference.profile_digest.clone()),
        Value::String(action.as_str().to_owned()),
        Value::Array(argv.into_iter().map(Value::String).collect()),
        Value::Map(projection.resolved_environment.iter().map(|(key, value)| (key.clone(), Value::String(value.clone()))).collect()),
    ]), FRAME_LIMITS).map_err(|_| Failure::Invalid)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.terminal.workspace-profile-intent.v1\0");
    hasher.update(&encoded);
    let digest = format!("blake3:{}", hasher.finalize().to_hex());
    let resource = terminal_workspace_profile_resource(&projection.reference);
    let cwd = root.to_str().ok_or(Failure::Invalid)?.to_owned();
    Ok(TerminalArguments { cwd, relative_path: ".".to_owned(), resource, digest })
}

fn terminal_workspace_profile_resource(
    reference: &crate::direct_session_grant::WorkspaceCommandGrantRefV1,
) -> String {
    format!("workspace-command-profile-v1:{}:{}:{}:{}", reference.profile_id,
        reference.revision, reference.profile_digest, reference.action.as_str())
}

fn direct_grant_allows_challenge(
    grant: &crate::direct_session_grant::DirectSessionGrantV1,
    challenge: &Challenge,
) -> bool {
    match challenge.capability_id.as_str() {
        guard::FILES_WRITE_ID | guard::FILES_PATCH_ID => grant.allows_edit(),
        guard::TERMINAL_RUN_ID if challenge.resource.starts_with("workspace-command-profile-v1:") =>
            grant.command_profiles.iter().any(|reference| {
                grant.command_profile(reference.action, &reference.profile_id, reference.revision, &reference.profile_digest)
                    && terminal_workspace_profile_resource(reference) == challenge.resource
            }),
        _ => false,
    }
}

fn parse_terminal_workspace_profile_projections(
    value: Option<&Value>,
    calls: &[Value],
) -> Result<HashMap<String, TerminalWorkspaceProfileProjectionV1>, Failure> {
    let mut calls_by_id = HashMap::new();
    for call in calls {
        let fields = strict_map(call, &["callId", "capabilityId", "arguments"])?;
        if text(fields, "capabilityId")? != guard::TERMINAL_RUN_ID { continue; }
        let call_id = text(fields, "callId")?.to_owned();
        let arguments = fields.get("arguments").ok_or(Failure::Invalid)?;
        if calls_by_id.insert(call_id, arguments).is_some() { return Err(Failure::Invalid); }
    }
    let Some(value) = value else {
        if calls_by_id.values().any(|arguments| matches!(arguments, Value::Map(fields)
            if matches!(fields.get("mode"), Some(Value::String(mode)) if mode == "workspace_profile"))) {
            return Err(Failure::Denied);
        }
        return Ok(HashMap::new());
    };
    let Value::Array(rows) = value else { return Err(Failure::Invalid) };
    if rows.is_empty() || rows.len() > MAX_TOOL_BATCH_CALLS { return Err(Failure::Invalid); }
    let mut output = HashMap::new();
    for row in rows {
        let fields = strict_map(row, &["callID", "reference", "definition", "resolvedEnvironment"])?;
        let call_id = text(fields, "callID")?.to_owned();
        let Some(arguments) = calls_by_id.get(&call_id) else { return Err(Failure::Invalid) };
        let Value::Map(invocation) = arguments else { return Err(Failure::Invalid) };
        if !matches!(invocation.get("mode"), Some(Value::String(mode)) if mode == "workspace_profile") {
            return Err(Failure::Invalid);
        }
        let reference = strict_map(fields.get("reference").ok_or(Failure::Invalid)?,
            &["profileId", "revision", "profileDigest", "action"])?;
        let profile_id = text(reference, "profileId")?.to_owned();
        let revision_text = text(reference, "revision")?;
        let revision = revision_text.parse::<u64>().map_err(|_| Failure::Invalid)?;
        if revision == 0 || revision.to_string() != revision_text { return Err(Failure::Invalid); }
        let profile_digest = text(reference, "profileDigest")?.to_owned();
        let action = match text(reference, "action")? {
            "build" => crate::workspace_command_profile::WorkspaceCommandActionV1::Build,
            "test" => crate::workspace_command_profile::WorkspaceCommandActionV1::Test,
            _ => return Err(Failure::Invalid),
        };
        let profile = crate::workspace_command_profile::WorkspaceCommandProfileV1::from_value(
            fields.get("definition").ok_or(Failure::Invalid)?,
        ).ok_or(Failure::Denied)?;
        if profile.profile_id != profile_id || profile.revision != revision
            || profile.profile_digest != profile_digest || !profile.allows(action) {
            return Err(Failure::Denied);
        }
        let Value::Map(environment_fields) = fields.get("resolvedEnvironment").ok_or(Failure::Invalid)? else {
            return Err(Failure::Invalid);
        };
        if environment_fields.len() > 64 { return Err(Failure::Invalid); }
        let mut resolved_environment = BTreeMap::new();
        let mut total = 0usize;
        for (name, value) in environment_fields {
            let Value::String(value) = value else { return Err(Failure::Invalid) };
            if !valid_environment_key(name) || !profile.allowed_environment_names.contains(name)
                || value.len() > 4096 || value.contains('\0') || name.starts_with("LD_")
                || matches!(name.as_str(), "BASH_ENV" | "ENV" | "SHELLOPTS" | "BASHOPTS" | "IFS") {
                return Err(Failure::Denied);
            }
            total = total.checked_add(name.len()).and_then(|n| n.checked_add(value.len())).ok_or(Failure::Invalid)?;
            if total > 64 * 1024 { return Err(Failure::Invalid); }
            resolved_environment.insert(name.clone(), value.clone());
        }
        if output.insert(call_id, TerminalWorkspaceProfileProjectionV1 {
            reference: crate::direct_session_grant::WorkspaceCommandGrantRefV1 {
                profile_id, revision, profile_digest, action,
            },
            profile,
            resolved_environment,
        }).is_some() { return Err(Failure::Invalid); }
    }
    for (call_id, arguments) in calls_by_id {
        let is_profile = matches!(arguments, Value::Map(fields)
            if matches!(fields.get("mode"), Some(Value::String(mode)) if mode == "workspace_profile"));
        if is_profile != output.contains_key(&call_id) { return Err(Failure::Denied); }
    }
    Ok(output)
}

fn terminal_arguments_digest(
    mode: &str,
    shell_profile_id: &str,
    command: &str,
    cwd: &str,
    timeout_ms: u64,
    environment: &BTreeMap<String, String>,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.terminal.run.arguments.v2\0");
    for value in [
        mode.as_bytes(),
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

fn json_map_to_wire(values: &crate::codemode_protocol::JsonMap) -> Option<Value> {
    fn convert(value:&serde_json::Value)->Option<Value>{
        Some(match value {
            serde_json::Value::Null=>Value::Nil,
            serde_json::Value::Bool(v)=>Value::Bool(*v),
            serde_json::Value::String(v)=>Value::String(v.clone()),
            serde_json::Value::Number(v)=>{
                if let Some(n)=v.as_u64(){Value::Unsigned(n)}
                else if let Some(n)=v.as_i64(){Value::Signed(n)}
                else {Value::Float(v.as_f64()?.to_bits())}
            }
            serde_json::Value::Array(items)=>Value::Array(items.iter().map(convert).collect::<Option<Vec<_>>>()?),
            serde_json::Value::Object(map)=>Value::Map(map.iter().map(|(k,v)|Some((k.clone(),convert(v)?))).collect::<Option<BTreeMap<_,_>>>()?),
        })
    }
    Some(Value::Map(values.iter().map(|(key,value)|Some((key.clone(),convert(value)?))).collect::<Option<BTreeMap<_,_>>>()?))
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

#[allow(clippy::too_many_arguments)]
fn repl_callback_denial_receipt_digest(
    execution_id: &str,
    generation: u64,
    event_sequence: u64,
    callback_id: &str,
    capability_id: &str,
    challenge_id: &str,
    effect_id: &str,
    event_digest: &str,
    callback_arguments_digest: &str,
    challenge_arguments_digest: &str,
    principal: &str,
    execution_principal: &str,
    session_id: &str,
    location_id: &str,
    owner_epoch: u64,
    attempt_scope_digest: Option<&str>,
    workspace_revision: &str,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.repl-callback-guard-denial.v1\0");
    let generation = generation.to_string();
    let event_sequence = event_sequence.to_string();
    let owner_epoch = owner_epoch.to_string();
    fn field(hasher: &mut blake3::Hasher, value: &[u8]) {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    for value in [
        "DENIED", execution_id, &generation, &event_sequence, callback_id,
        capability_id, challenge_id, effect_id, event_digest, callback_arguments_digest,
        challenge_arguments_digest, principal, execution_principal, session_id, location_id,
        &owner_epoch, workspace_revision,
    ] {
        field(&mut hasher, value.as_bytes());
    }
    match attempt_scope_digest {
        Some(value) => { field(&mut hasher, b"some"); field(&mut hasher, value.as_bytes()); }
        None => field(&mut hasher, b"none"),
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(bytes).to_hex())
}

fn managed_effect_decision_receipt_digest(
    pin: &ManagedAttemptEffectReceiptPinV1,
    challenge_id: &str,
    capability_id: &str,
    status: &str,
    lease_digest: Option<&str>,
    effect_receipt_digest: Option<&str>,
    arguments_digest: &str,
    intent_digest: &str,
    turn_context_digest: &str,
) -> Result<String, TypedErrorV1> {
    if !matches!(status, "NOT_APPLIED" | "DENIED" | "EXPIRED" | "CANCELLED" | "UNKNOWN")
        || !is_blake3_digest(&pin.attempt_scope_digest)
        || !is_blake3_digest(arguments_digest)
        || !is_blake3_digest(intent_digest)
        || !is_blake3_digest(turn_context_digest)
        || lease_digest.is_some_and(|digest| !is_blake3_digest(digest))
        || effect_receipt_digest.is_some_and(|digest| !is_blake3_digest(digest))
    {
        return Err(Failure::Invalid.error());
    }
    let value = Value::Map(BTreeMap::from([
        ("argumentsDigest".to_owned(), Value::String(arguments_digest.to_owned())),
        ("attemptScopeDigest".to_owned(), Value::String(pin.attempt_scope_digest.clone())),
        ("batchID".to_owned(), Value::String(pin.batch_id.clone())),
        ("callID".to_owned(), Value::String(pin.call_id.clone())),
        ("callIndex".to_owned(), Value::Unsigned(pin.call_index as u64)),
        ("capabilityID".to_owned(), Value::String(capability_id.to_owned())),
        ("capabilityLeaseDigest".to_owned(), lease_digest.map_or(Value::Nil, |value| Value::String(value.to_owned()))),
        ("challengeID".to_owned(), Value::String(challenge_id.to_owned())),
        ("effectID".to_owned(), Value::String(pin.effect_id.clone())),
        ("executionReceiptDigest".to_owned(), effect_receipt_digest.map_or(Value::Nil, |value| Value::String(value.to_owned()))),
        ("intentDigest".to_owned(), Value::String(intent_digest.to_owned())),
        ("schemaVersion".to_owned(), Value::Unsigned(1)),
        ("status".to_owned(), Value::String(status.to_owned())),
        ("turnContextDigest".to_owned(), Value::String(turn_context_digest.to_owned())),
    ]));
    let encoded = crate::messagepack::encode(&value, FRAME_LIMITS).map_err(|_| Failure::Invalid.error())?;
    let mut preimage = b"horizoncode.managed-effect-decision-receipt.v1\0".to_vec();
    preimage.extend_from_slice(&encoded);
    Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
}

/// Stable terminal receipt for an external-editor lifecycle. The receipt stores
/// only digests and normalized outcome facts; paths, argv, file contents and raw
/// process output are deliberately excluded.
fn editor_terminal_receipt_digest(
    effect_id: &str,
    challenge_id: &str,
    execution_id: &str,
    binding_digest: &str,
    status: &str,
    exit_code: Option<i32>,
    result_file_digest: Option<&str>,
    result_file_bytes: Option<u64>,
    observed_workspace_revision: Option<&str>,
    quiescence_digest: &str,
) -> Result<String, TypedErrorV1> {
    if !matches!(status, "cancelled" | "completed" | "conflict")
        || !is_blake3_digest(binding_digest)
        || !is_blake3_digest(quiescence_digest)
        || result_file_digest.is_some_and(|value| !is_blake3_digest(value))
        || observed_workspace_revision.is_some_and(|value| !is_blake3_digest(value))
        || result_file_bytes.is_some_and(|value| value > crate::terminal_process::MAX_EXTERNAL_EDITOR_SCRATCH_BYTES)
        || result_file_digest.is_some() != result_file_bytes.is_some()
        || (status == "completed"
            && (exit_code != Some(0)
                || result_file_digest.is_none()
                || observed_workspace_revision.is_none()))
    {
        return Err(Failure::Invalid.error());
    }
    let value = Value::Map(BTreeMap::from([
        ("bindingDigest".to_owned(), Value::String(binding_digest.to_owned())),
        ("challengeID".to_owned(), Value::String(challenge_id.to_owned())),
        ("cgroupQuiescenceDigest".to_owned(), Value::String(quiescence_digest.to_owned())),
        ("effectID".to_owned(), Value::String(effect_id.to_owned())),
        ("executionID".to_owned(), Value::String(execution_id.to_owned())),
        ("exitCode".to_owned(), exit_code.map_or(Value::Nil, |code| Value::Signed(code as i64))),
        ("observedWorkspaceRevision".to_owned(), observed_workspace_revision.map_or(Value::Nil, |value| Value::String(value.to_owned()))),
        ("resultFileDigest".to_owned(), result_file_digest.map_or(Value::Nil, |value| Value::String(value.to_owned()))),
        ("resultFileBytes".to_owned(), result_file_bytes.map_or(Value::Nil, Value::Unsigned)),
        ("schemaVersion".to_owned(), Value::Unsigned(1)),
        ("status".to_owned(), Value::String(status.to_owned())),
    ]));
    let encoded = crate::messagepack::encode(&value, FRAME_LIMITS)
        .map_err(|_| Failure::Invalid.error())?;
    let mut preimage = b"horizoncode.external-editor-receipt.v1\0".to_vec();
    preimage.extend_from_slice(&encoded);
    Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
}

fn codemode_authority_scope_digest(
    scope: &CodeModeAuthorityScopeV1,
    session_id: &str,
    location_id: &str,
) -> Result<String, TypedErrorV1> {
    let (lane, attempt) = match scope {
        CodeModeAuthorityScopeV1::DirectSession { .. } => ("direct_session", None),
        CodeModeAuthorityScopeV1::ManagedAttempt(scope) => {
            let digest = attempt_scope_digest(Some(scope), session_id)
                .map_err(Failure::error)?.ok_or_else(|| Failure::Invalid.error())?;
            ("managed_attempt", Some(digest))
        }
    };
    let mut preimage = b"horizoncode.codemode-authority-scope.v1\0".to_vec();
    for value in [lane, session_id, location_id, attempt.as_deref().unwrap_or("")] {
        preimage.extend_from_slice(&(value.len() as u64).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    }
    Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
}

fn codemode_wave_scope_digest(
    scope: &CodeModeAuthorityScopeV1,
    session_id: &str,
    location_id: &str,
) -> Result<String, TypedErrorV1> {
    match scope {
        CodeModeAuthorityScopeV1::DirectSession { workspace_revision_digest, direct_session_grant_digest } => {
            if !is_blake3_digest(workspace_revision_digest) { return Err(Failure::Invalid.error()); }
            if direct_session_grant_digest.as_ref().is_some_and(|digest| !is_blake3_digest(digest)) {
                return Err(Failure::Invalid.error());
            }
            let mut preimage = b"horizoncode.codemode-direct-wave-scope.v1\0".to_vec();
            for value in [workspace_revision_digest.as_str(), direct_session_grant_digest.as_deref().unwrap_or("")] {
                preimage.extend_from_slice(&(value.len() as u64).to_be_bytes());
                preimage.extend_from_slice(value.as_bytes());
            }
            Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
        }
        CodeModeAuthorityScopeV1::ManagedAttempt(scope) => {
            if scope.session_id() != session_id || scope.location_id() != location_id {
                return Err(Failure::Denied.error());
            }
            attempt_scope_digest(Some(scope), session_id)
                .map_err(Failure::error)?.ok_or_else(|| Failure::Invalid.error())
        }
    }
}

pub(crate) fn codemode_wave_receipt_digest(batch_id:&str,receipts:&[CodeModeWaveReceiptTupleV1])->String{
    let mut hasher=blake3::Hasher::new();
    hasher.update(b"horizoncode.effecthost.codemode-wave-settlement.v1\0");
    fn field(hasher:&mut blake3::Hasher,value:&[u8]){
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    field(&mut hasher,batch_id.as_bytes());
    for receipt in receipts {
        field(&mut hasher,&[receipt.call_index]);
        field(&mut hasher,receipt.call_id.as_bytes());
        field(&mut hasher,receipt.status.as_bytes());
        field(&mut hasher,receipt.receipt_kind.as_bytes());
        field(&mut hasher,receipt.receipt_ref.as_bytes());
        field(&mut hasher,receipt.receipt_digest.as_bytes());
    }
    format!("blake3:{}",hasher.finalize().to_hex())
}

fn codemode_terminal_decision_receipt_digest(
    request_id:&str,batch_id:&str,wave_index:u8,frame_digest:&str,call_id:&str,
    challenge_id:&str,content_digest:&str,status:&str,error_code:Option<&str>,output:Option<&str>,
)->String{
    let mut hasher=blake3::Hasher::new();
    hasher.update(b"horizoncode.codemode-terminal-decision.v1\0");
    for value in [request_id,batch_id,frame_digest,call_id,challenge_id,content_digest,status,error_code.unwrap_or("")] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(&[wave_index]);
    let output_digest=output.map(|value|digest_bytes(value.as_bytes())).unwrap_or_default();
    hasher.update(&(output_digest.len() as u64).to_be_bytes());
    hasher.update(output_digest.as_bytes());
    format!("blake3:{}",hasher.finalize().to_hex())
}

fn codemode_terminal_decision_receipt_ref(request_id:&str,batch_id:&str,wave_index:u8,call_id:&str,digest:&str)->String{
    let mut hasher=blake3::Hasher::new();
    hasher.update(b"horizoncode.codemode-terminal-decision-ref.v1\0");
    for value in [request_id,batch_id,call_id,digest] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(&[wave_index]);
    format!("cmdec_{}",&hasher.finalize().to_hex()[..32])
}

#[cfg(test)]
mod http_route_outcome_tests {
    use super::{valid_http_route_outcome, valid_next_http_route_attempt};
    use crate::http_execution::HttpResponseV1;

    fn response(status: u16, truncated: bool) -> HttpResponseV1 {
        HttpResponseV1 {
            status,
            retry_after_ms: None,
            retry_after_header: None,
            body: Vec::new(),
            body_digest: format!("blake3:{}", "a".repeat(64)),
            body_truncated: truncated,
            response_complete: !truncated,
            connected_peer: None,
        }
    }

    #[test]
    fn empty_requires_a_complete_successful_zero_result_response() {
        assert!(valid_http_route_outcome("EMPTY", Some(0), &response(200, false)));
        assert!(valid_http_route_outcome("EMPTY", Some(0), &response(204, false)));
        assert!(!valid_http_route_outcome("EMPTY", None, &response(200, false)));
        assert!(!valid_http_route_outcome("EMPTY", Some(1), &response(200, false)));
        assert!(!valid_http_route_outcome("EMPTY", Some(0), &response(503, false)));
        assert!(!valid_http_route_outcome("EMPTY", Some(0), &response(200, true)));
    }

    #[test]
    fn retryable_and_rate_limit_outcomes_are_bound_to_http_status() {
        assert!(valid_http_route_outcome("RATE_LIMITED", None, &response(429, false)));
        assert!(!valid_http_route_outcome("RATE_LIMITED", None, &response(503, false)));
        assert!(valid_http_route_outcome("RETRYABLE_FAILURE", None, &response(408, false)));
        assert!(valid_http_route_outcome("RETRYABLE_FAILURE", None, &response(503, false)));
        assert!(!valid_http_route_outcome("RETRYABLE_FAILURE", None, &response(429, false)));
    }

    #[test]
    fn route_attempt_transition_requires_settled_retryable_receipts() {
        assert!(valid_next_http_route_attempt(None, "web.search.exa", 1));
        assert!(!valid_next_http_route_attempt(None, "web.search.exa", 2));
        assert!(!valid_next_http_route_attempt(
            Some(("web.search.exa", 1, "DISPATCHING", None)),
            "web.search.exa",
            2,
        ));
        assert!(!valid_next_http_route_attempt(
            Some(("web.search.exa", 1, "SETTLED", Some("EMPTY"))),
            "web.search.exa",
            2,
        ));
        assert!(valid_next_http_route_attempt(
            Some(("web.search.exa", 1, "SETTLED", Some("RETRYABLE_FAILURE"))),
            "web.search.exa",
            2,
        ));
        assert!(!valid_next_http_route_attempt(
            Some(("web.search.exa", 1, "SETTLED", Some("RETRYABLE_FAILURE"))),
            "web.search.tavily",
            1,
        ));
        assert!(valid_next_http_route_attempt(
            Some(("web.search.exa", 2, "SETTLED", Some("RETRYABLE_FAILURE"))),
            "web.search.tavily",
            1,
        ));
        assert!(valid_next_http_route_attempt(
            Some(("web.search.exa", 1, "SETTLED", Some("EMPTY"))),
            "web.search.tavily",
            1,
        ));
        assert!(!valid_next_http_route_attempt(
            Some(("web.search.exa", 1, "SETTLED", Some("SUCCEEDED"))),
            "web.search.tavily",
            1,
        ));
    }
}

#[cfg(test)]
mod codemode_wave_receipt_tests {
    use super::{codemode_authority_scope_digest, codemode_terminal_decision_receipt_digest,
        codemode_terminal_decision_receipt_ref, codemode_wave_receipt_digest,
        codemode_wave_scope_digest, CodeModeAuthorityScopeV1, CodeModeWaveReceiptTupleV1};

    #[test]
    fn wave_receipt_digest_is_ordered_and_binds_batch_and_member_receipts() {
        let rows=vec![CodeModeWaveReceiptTupleV1 { call_index:0,call_id:"call-a".into(),status:"settled".into(),receipt_kind:"effect_receipt".into(),receipt_ref:"effect-a".into(),receipt_digest:format!("blake3:{}","a".repeat(64)) },
            CodeModeWaveReceiptTupleV1 { call_index:1,call_id:"call-b".into(),status:"settled".into(),receipt_kind:"effect_receipt".into(),receipt_ref:"effect-b".into(),receipt_digest:format!("blake3:{}","b".repeat(64)) }];
        let digest=codemode_wave_receipt_digest("batch-1",&rows);
        assert_eq!(digest,codemode_wave_receipt_digest("batch-1",&rows));
        assert_ne!(digest,codemode_wave_receipt_digest("batch-2",&rows));
        assert_ne!(digest,codemode_wave_receipt_digest("batch-1",&rows.into_iter().rev().collect::<Vec<_>>()));
    }

    #[test]
    fn direct_session_code_mode_has_no_attempt_and_refreshes_workspace_grant_per_wave() {
        let first = CodeModeAuthorityScopeV1::DirectSession {
            workspace_revision_digest: format!("blake3:{}", "a".repeat(64)),
            direct_session_grant_digest: None,
        };
        let later = CodeModeAuthorityScopeV1::DirectSession {
            workspace_revision_digest: format!("blake3:{}", "b".repeat(64)),
            direct_session_grant_digest: Some(format!("blake3:{}", "c".repeat(64))),
        };
        assert_eq!(
            codemode_authority_scope_digest(&first, "session", "location").unwrap(),
            codemode_authority_scope_digest(&later, "session", "location").unwrap(),
            "the authenticated session authority remains stable while live workspace grants refresh"
        );
        assert_ne!(
            codemode_wave_scope_digest(&first, "session", "location").unwrap(),
            codemode_wave_scope_digest(&later, "session", "location").unwrap(),
            "each wave binds its actual workspace revision and current grant"
        );
        assert_ne!(
            codemode_authority_scope_digest(&first, "other-session", "location").unwrap(),
            codemode_authority_scope_digest(&first, "session", "location").unwrap()
        );
    }

    #[test]
    fn terminal_decision_receipt_binds_decision_evidence_and_has_separate_ref_domain() {
        let digest=codemode_terminal_decision_receipt_digest(
            "request","batch",0,&format!("blake3:{}","a".repeat(64)),"call",
            "challenge",&format!("blake3:{}","b".repeat(64)),"rejected",Some("guard_denied"),Some("denied"));
        assert_eq!(digest,codemode_terminal_decision_receipt_digest(
            "request","batch",0,&format!("blake3:{}","a".repeat(64)),"call",
            "challenge",&format!("blake3:{}","b".repeat(64)),"rejected",Some("guard_denied"),Some("denied")));
        assert_ne!(digest,codemode_terminal_decision_receipt_digest(
            "request","batch",0,&format!("blake3:{}","a".repeat(64)),"call",
            "challenge",&format!("blake3:{}","b".repeat(64)),"cancelled",Some("guard_denied"),Some("denied")));
        let reference=codemode_terminal_decision_receipt_ref("request","batch",0,"call",&digest);
        assert!(reference.starts_with("cmdec_"));
        assert_eq!(reference,codemode_terminal_decision_receipt_ref("request","batch",0,"call",&digest));
    }
}

fn tool_batch_arguments_digest(arguments: &Value) -> Result<String, Failure> {
    let encoded = messagepack::encode(arguments, FRAME_LIMITS).map_err(|_| Failure::Invalid)?;
    let mut preimage = b"horizoncode.tool-batch.arguments.v1\0".to_vec();
    preimage.extend_from_slice(&encoded);
    Ok(digest_bytes(&preimage))
}

fn terminal_artifact_ref_value(reference: &ArtifactRefV1) -> Value {
    Value::Map(BTreeMap::from([
        ("artifactId".to_owned(), Value::String(reference.artifact_id.clone())),
        ("digest".to_owned(), Value::String(reference.digest.clone())),
        ("byteLength".to_owned(), Value::String(reference.byte_length.clone())),
        ("mediaType".to_owned(), Value::String(reference.media_type.clone())),
        (
            "classification".to_owned(),
            Value::String(
                match reference.classification {
                    ArtifactClassificationV1::Public => "public",
                    ArtifactClassificationV1::Workspace => "workspace",
                    ArtifactClassificationV1::Sensitive => "sensitive",
                }
                .to_owned(),
            ),
        ),
    ]))
}

fn terminal_artifact_ref_from_value(value: Value) -> Option<ArtifactRefV1> {
    let Value::Map(mut fields) = value else { return None };
    if fields.len() != 5 { return None; }
    let artifact_id = match fields.remove("artifactId") {
        Some(Value::String(value)) if !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES
            && !value.chars().any(char::is_control) => value,
        _ => return None,
    };
    let digest = match fields.remove("digest") {
        Some(Value::String(value)) if is_blake3_digest(&value) => value,
        _ => return None,
    };
    let byte_length = match fields.remove("byteLength") {
        Some(Value::String(value)) if canonical_u64(&value) => value,
        _ => return None,
    };
    let media_type = match fields.remove("mediaType") {
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 256
            && !value.chars().any(char::is_control) => value,
        _ => return None,
    };
    let classification = match fields.remove("classification") {
        Some(Value::String(value)) if value == "public" => ArtifactClassificationV1::Public,
        Some(Value::String(value)) if value == "workspace" => ArtifactClassificationV1::Workspace,
        Some(Value::String(value)) if value == "sensitive" => ArtifactClassificationV1::Sensitive,
        _ => return None,
    };
    if !fields.is_empty() { return None; }
    Some(ArtifactRefV1 { artifact_id,digest,byte_length,media_type,classification })
}

fn canonical_u64(value: &str) -> bool {
    value.parse::<u64>().ok().is_some_and(|parsed| parsed.to_string() == value)
}

fn is_blake3_digest(value: &str) -> bool {
    value.strip_prefix("blake3:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn codemode_tool_result_receipt_ref(request_id:&str,batch_id:&str,wave_index:u8,call_index:u8,call_id:&str)->String {
    let mut hash=blake3::Hasher::new();
    hash.update(b"horizoncode.codemode-tool-result-ref.v1\0");
    for field in [request_id,batch_id,call_id] { hash.update(&(field.len() as u64).to_be_bytes()); hash.update(field.as_bytes()); }
    hash.update(&[wave_index,call_index]);
    format!("tool_result:{}",hash.finalize().to_hex())
}

fn codemode_tool_result_receipt_digest(request_id:&str,batch_id:&str,wave_index:u8,call_index:u8,call_id:&str,
    output_digest:&str,output_bytes:u64,error_code:Option<&str>)->String {
    let mut hash=blake3::Hasher::new();
    hash.update(b"horizoncode.codemode-tool-result-receipt.v1\0");
    for field in [request_id,batch_id,call_id,output_digest,error_code.unwrap_or("")] {
        hash.update(&(field.len() as u64).to_be_bytes()); hash.update(field.as_bytes());
    }
    hash.update(&[wave_index,call_index]);
    hash.update(&output_bytes.to_be_bytes());
    format!("blake3:{}",hash.finalize().to_hex())
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
            ..
        } if call.capability_id == guard::FILES_READ_ID => vec![map_value([
            ("target", Value::String(requested_path.clone())),
            ("resource", Value::String(resource.clone())),
            ("operation", Value::String("read".to_owned())),
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
        PlannedEffect::WebSearch { requested_path, resource, .. } => vec![map_value([
            ("target", Value::String(requested_path.clone())),
            ("resource", Value::String(resource.clone())),
            ("operation", Value::String("web.search".to_owned())),
            ("existed", Value::Bool(false)),
        ])],
        PlannedEffect::GuardedControl { requested_path, resource, operation, .. } => vec![map_value([
            ("target", Value::String(requested_path.clone())),
            ("resource", Value::String(resource.clone())),
            ("operation", Value::String(operation.clone())),
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
        PlannedEffect::WebSearch { requested_path, resource, .. } => {
            fields.insert("target".to_owned(), Value::String(requested_path.clone()));
            fields.insert("resource".to_owned(), Value::String(resource.clone()));
            fields.insert("existed".to_owned(), Value::Bool(false));
        }
        PlannedEffect::GuardedControl { requested_path, resource, .. } => {
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
    batch_approval_value_with_status(batch_id, calls, "needs_approval")
}

fn classify_direct_mode_batch(
    mode: &guard::DirectSessionPermissionModeProjectionV1,
    calls: &[PlannedCall],
) -> DirectModeBatchDecision {
    if mode.approval_policy == guard::DirectApprovalPolicyV1::Always {
        return DirectModeBatchDecision::Ask;
    }
    let full_access = mode.sandbox_mode == guard::DirectSandboxModeV1::DangerFullAccess;
    let inside_workspace = mode.sandbox_mode == guard::DirectSandboxModeV1::WorkspaceWrite;
    let mut crosses_boundary = false;
    for call in calls {
        match &call.effect {
            PlannedEffect::Write { .. } | PlannedEffect::Patch { .. } if inside_workspace || full_access => {}
            // A configured build/test profile is still a process boundary. Only
            // an exact DirectSessionGrant commandProfiles ref may quiet it; the
            // broad permission mode never turns arbitrary process launch into
            // an implicit allow.
            // Search has separate query-sharing and possible-cost consent.
            PlannedEffect::WebSearch { .. } => return if mode.approval_policy == guard::DirectApprovalPolicyV1::Never {
                DirectModeBatchDecision::Deny
            } else {
                DirectModeBatchDecision::Ask
            },
            PlannedEffect::Write { .. } | PlannedEffect::Patch { .. }
            | PlannedEffect::Terminal { .. } | PlannedEffect::BrokerProcess { .. }
            | PlannedEffect::GuardedControl { .. } => crosses_boundary = true,
        }
    }
    if !crosses_boundary {
        if full_access && mode.approval_policy != guard::DirectApprovalPolicyV1::Never {
            return DirectModeBatchDecision::Unavailable;
        }
        return DirectModeBatchDecision::Candidate;
    }
    match mode.approval_policy {
        guard::DirectApprovalPolicyV1::OnRequest => DirectModeBatchDecision::Ask,
        guard::DirectApprovalPolicyV1::Never => DirectModeBatchDecision::Deny,
        guard::DirectApprovalPolicyV1::Always => DirectModeBatchDecision::Ask,
    }
}

fn classify_direct_mode_challenge(
    mode: &guard::DirectSessionPermissionModeProjectionV1,
    challenge: &Challenge,
) -> DirectModeBatchDecision {
    if mode.approval_policy == guard::DirectApprovalPolicyV1::Always {
        return DirectModeBatchDecision::Ask;
    }
    let inside_scope = matches!(mode.sandbox_mode,
            guard::DirectSandboxModeV1::WorkspaceWrite | guard::DirectSandboxModeV1::DangerFullAccess)
        && matches!(challenge.capability_id.as_str(), guard::FILES_WRITE_ID | guard::FILES_PATCH_ID);
    let inside = inside_scope;
    if inside {
        return DirectModeBatchDecision::Candidate;
    }
    if challenge.capability_id == guard::WEB_SEARCH_ID {
        return if mode.approval_policy == guard::DirectApprovalPolicyV1::Never {
            DirectModeBatchDecision::Deny
        } else {
            DirectModeBatchDecision::Ask
        };
    }
    match mode.approval_policy {
        guard::DirectApprovalPolicyV1::OnRequest => DirectModeBatchDecision::Ask,
        guard::DirectApprovalPolicyV1::Never => DirectModeBatchDecision::Deny,
        guard::DirectApprovalPolicyV1::Always => DirectModeBatchDecision::Ask,
    }
}

#[cfg(test)]
mod direct_mode_classifier_tests {
    use super::{classify_direct_mode_batch, DirectModeBatchDecision, PlannedCall, PlannedEffect};
    use crate::guard::{DirectApprovalPolicyV1, DirectPermissionModeSourceV1, DirectSandboxModeV1, DirectSessionPermissionModeProjectionV1};

    fn mode(sandbox_mode: DirectSandboxModeV1, approval_policy: DirectApprovalPolicyV1) -> DirectSessionPermissionModeProjectionV1 {
        DirectSessionPermissionModeProjectionV1 {
            session_id: "session_test".to_owned(), owner_epoch: 1,
            location_id: "location_test".to_owned(), workspace_id: "workspace_test".to_owned(),
            workspace_root_digest: "blake3:root".to_owned(),
            execution_backend_id: crate::guard::DIRECT_SESSION_EFFECT_BACKEND_ID.to_owned(),
            policy_digest: "blake3:policy".to_owned(), sandbox_mode, approval_policy,
            source: if sandbox_mode == DirectSandboxModeV1::DangerFullAccess {
                DirectPermissionModeSourceV1::UserSession
            } else { DirectPermissionModeSourceV1::Default },
            revision: 1, digest: "blake3:mode".to_owned(),
        }
    }

    fn call(effect: PlannedEffect, capability_id: &str) -> PlannedCall {
        PlannedCall {
            call_id: "call_test".to_owned(), capability_id: capability_id.to_owned(),
            challenge_id: "challenge_test".to_owned(), effect_id: "effect_test".to_owned(),
            arguments_digest: "blake3:arguments".to_owned(), argument_digest: "blake3:intent".to_owned(),
            content_digest: "blake3:content".to_owned(), expires_at_ms: 100,
            managed_attempt_digest: None, effect,
        }
    }

    #[test]
    fn explicit_full_access_skips_local_shell_prompt_but_keeps_search_consent_boundary() {
        let local = call(PlannedEffect::Terminal {
            requested_path: "sh".to_owned(), relative_path: "".to_owned(),
            resource: ".".to_owned(), digest: "blake3:args".to_owned(),
            capability_id: crate::guard::TERMINAL_RUN_ID.to_owned(),
        }, crate::guard::TERMINAL_RUN_ID);
        assert_eq!(classify_direct_mode_batch(
            &mode(DirectSandboxModeV1::DangerFullAccess, DirectApprovalPolicyV1::Never), &[local]),
            DirectModeBatchDecision::Candidate);
        let search = call(PlannedEffect::WebSearch {
            requested_path: "web.search".to_owned(), relative_path: "".to_owned(), resource: "query".to_owned(),
        }, crate::guard::WEB_SEARCH_ID);
        assert_eq!(classify_direct_mode_batch(
            &mode(DirectSandboxModeV1::DangerFullAccess, DirectApprovalPolicyV1::Never), &[search]),
            DirectModeBatchDecision::Deny);
    }

    #[test]
    fn workspace_write_on_request_is_quiet_inside_the_workspace() {
        let write = call(PlannedEffect::Write {
            requested_path: "src/main.rs".to_owned(), relative_path: "src/main.rs".to_owned(),
            target: "/workspace/src/main.rs".to_owned(), resource: "src/main.rs".to_owned(), existed: true,
        }, crate::guard::FILES_WRITE_ID);
        assert_eq!(classify_direct_mode_batch(
            &mode(DirectSandboxModeV1::WorkspaceWrite, DirectApprovalPolicyV1::OnRequest), &[write]),
            DirectModeBatchDecision::Candidate);
    }
}

fn direct_mode_approval_digest(batch_id: &str, mode_digest: &str, rows: &[(&str, &str)]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.direct-mode-batch-approval.v1\0");
    for value in [batch_id, mode_digest] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(&(rows.len() as u64).to_be_bytes());
    for (challenge_id, effect_id) in rows {
        for value in [*challenge_id, *effect_id] {
            hasher.update(&(value.len() as u64).to_be_bytes());
            hasher.update(value.as_bytes());
        }
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn batch_approval_value_with_status(batch_id: &str, calls: &[PlannedCall], status: &str) -> Value {
    let expires_at_ms = calls
        .iter()
        .map(|call| call.expires_at_ms)
        .min()
        .unwrap_or_default();
    let mut fields = std::collections::BTreeMap::from([
        (
            "status".to_owned(),
            Value::String(status.to_owned()),
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
            effective_max_tokens: 100,
            remaining_tokens: 100,
            request_id: None, request_sequence: None, context_selection_digest: None,
            worktree_target: None,
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
            execution_principal: "server_auth:verifier".to_owned(),
            user_action_id: "verify_action_test".to_owned(),
            call_id: "criterion_one".to_owned(),
            session_id: "session_test".to_owned(),
            managed_attempt_digest: Some(format!("blake3:{}", "c".repeat(64))),
            managed_root_scope_digest: None,
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
            direct_permission_mode_digest: None,
            direct_permission_mode_revision: None,
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
                    execution_principal: "server_auth:verifier".to_owned(),
                    user_action_id: "verification_run_one".to_owned(),
                    call_id: criterion.to_owned(),
                    session_id: "session_verification".to_owned(),
                    managed_attempt_digest: Some(format!("blake3:{}", "c".repeat(64))),
                    managed_root_scope_digest: None,
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
            execution_principal: "server_auth:verifier".to_owned(),
            scope: crate::terminal_process::StdioExecutionScopeV1::Session { session_id: "session_verification".to_owned() },
            session_id: "session_verification".to_owned(),
            location_id: "location_verifier_one".to_owned(),
            capability_id: guard::BUILTIN_VERIFIER_ID.to_owned(),
            capability_lease_digest: lease_digest.clone(),
            attempt_scope_digest: Some(format!("blake3:{}", "c".repeat(64))),
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
                execution_principal: "host_os_uid:1000".to_owned(),
                scope: crate::terminal_process::StdioExecutionScopeV1::Session { session_id: format!("session_unknown_{suffix}") },
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
            execution_principal: "server_auth:verifier".to_owned(),
            scope: crate::terminal_process::StdioExecutionScopeV1::Session { session_id: "session_verifier_reconcile".to_owned() },
            session_id: "session_verifier_reconcile".to_owned(),
            location_id: "location_verifier_reconcile".to_owned(),
            capability_id: guard::BUILTIN_VERIFIER_ID.to_owned(),
            capability_lease_digest: format!("blake3:{}", "c".repeat(64)),
            approved_arguments_digest: format!("blake3:{}", "d".repeat(64)),
            attempt_scope_digest: Some(format!("blake3:{}", "c".repeat(64))),
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
                    content_digest,expires_at_ms,status,turn_context_digest,origin_kind,managed_attempt_digest
                ) VALUES (?1,?2,?10,?3,?4,?5,?6,'','.','.', '.',0,?7,?8,?9,'RUNNING',?7,'managed_run',?11)",
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
                    binding.session_id,
                    binding.attempt_scope_digest,
                ],
            )
            .unwrap();
        host.connection
            .execute(
                "INSERT INTO broker_process_bindings(
                    challenge_id,profile_id,execution_principal,executable_path,executable_digest,profile_digest
                 ) VALUES (?1,?2,'server_auth:verifier',?3,?4,?5)",
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
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,'enforced','RUNNING',?20,?20)",
                params![
                    invocation.execution_id(),
                    "intent_verifier_reconcile",
                    invocation.effect_id(),
                    invocation.challenge_id(),
                    invocation.reviewer_principal(),
                    binding.session_id,
                    invocation.location_id(),
                    guard::BUILTIN_VERIFIER_ID,
                    invocation.lease_digest(),
                    binding.attempt_scope_digest,
                    invocation.owner_epoch() as i64,
                    invocation.execution_generation() as i64,
                    invocation.final_revision(),
                    invocation.profile_id(),
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
            execution_principal: "server_auth:verifier".to_owned(),
            scope: crate::terminal_process::StdioExecutionScopeV1::Session { session_id: "session_verifier_denied".to_owned() },
            session_id: "session_verifier_denied".to_owned(),
            location_id: "location_verifier_denied".to_owned(),
            capability_id: guard::BUILTIN_VERIFIER_ID.to_owned(),
            capability_lease_digest: format!("blake3:{}", "c".repeat(64)),
            approved_arguments_digest: format!("blake3:{}", "b".repeat(64)),
            attempt_scope_digest: Some(format!("blake3:{}", "c".repeat(64))),
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
                    content_digest,expires_at_ms,status,turn_context_digest,origin_kind,managed_attempt_digest
                ) VALUES (?1,?2,?10,?3,?4,?5,?6,'','.','.', '.',0,?7,?8,?9,'APPROVED',?8,'managed_run',?11)",
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
                    binding.session_id,
                    binding.attempt_scope_digest,
                ],
            )
            .unwrap();
        host.connection
            .execute(
                "INSERT INTO broker_process_bindings(
                    challenge_id,profile_id,execution_principal,executable_path,executable_digest,profile_digest
                 ) VALUES (?1,?2,'server_auth:verifier',?3,?4,?5)",
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
            connected_peer: Some("93.184.216.34".parse().unwrap()),
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
                    connected_peer: Some("93.184.216.34".parse().unwrap()),
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
