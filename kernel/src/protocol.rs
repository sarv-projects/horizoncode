//! Typed `HzKernelRpcV1` messages and deterministic handshake negotiation.
//!
//! This module validates the wire shape only. A successful handshake does not prove
//! that the operating-system peer was authenticated; callers must first enforce the
//! platform-specific inherited-handle/socket/named-pipe checks from §13.3.

use crate::messagepack::{self, FRAME_LIMITS, Limits, Value};
use crate::transport::{self, FrameError, MAX_FRAME_SIZE, MAX_PAYLOAD_SIZE};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::io::{Read, Write};

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_blake3_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("blake3:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub const PROTOCOL_V1: u16 = 1;
pub const FEATURE_SESSION_PAGE_CONTROL_V1: &str = "session.events.page-control.v1";
pub const FEATURE_EFFECTS_V2: &str = "effects.v2";
/// Authenticated requests may carry an out-of-body Session/Location binding for
/// read-only RepoIntel queries. RepoIntel remains unavailable unless negotiated.
pub const FEATURE_REPO_INTEL_READ_CONTEXT_V1: &str = "repo-intel.read-context-v1";
/// Host atomically prepares complete bounded multi-call effect batches and supports
/// per-batch cancellation before dispatch.
pub const FEATURE_EFFECTS_MULTI_CALL: &str = "effects.v2.multi-call";
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Bounded for the largest base64-encoded `files.patch` preimage/postimage batch
/// while remaining below the 8 MiB transport frame ceiling.
pub const MAX_BODY_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 256 * 1024;
pub const MAX_ERROR_BYTES: usize = 64 * 1024;
pub const MAX_ARTIFACT_CHUNK_BODY_BYTES: usize = 768 * 1024;
pub const MAX_IDENTIFIER_BYTES: usize = 256;
pub const MAX_FEATURE_COUNT: usize = 256;
pub const MAX_SUBJECT_IDS: usize = 256;
pub const MAX_DIRECT_ATTEMPT_EFFECTS: usize = 64;
pub const MAX_DEADLINE_INTERACTIVE_MS: u64 = 5 * 60 * 1000;
pub const MAX_DEADLINE_DURABLE_MS: u64 = 24 * 60 * 60 * 1000;

/// A stream cursor scoped to one canonical owner; it is not a global sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorV1 {
    pub owner_kind: String,
    pub owner_id: String,
    /// Canonical unsigned base-10 integer, without a leading zero except for "0".
    pub seq: String,
    pub event_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactRefV1 {
    pub artifact_id: String,
    pub digest: String,
    /// Canonical unsigned base-10 integer, without a leading zero except for "0".
    pub byte_length: String,
    pub media_type: String,
    pub classification: ArtifactClassificationV1,
}

/// Immutable authority for one managed child execution. Values are minted from
/// accepted managed state and live Rust-owned leases; a request envelope never
/// creates or widens this binding. u64 fields use canonical decimal strings on
/// this private wire so projections preserve values above 2^53.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegationBindingV1 {
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub parent_execution_id: String,
    pub child_execution_id: String,
    pub accepted_spec_digest: String,
    pub profile_id: String,
    pub profile_revision: u64,
    pub profile_digest: String,
    pub criteria_ids: Vec<String>,
    pub workspace_lease_id: String,
    pub source_revision: String,
    pub capability_ceiling_digest: String,
    pub context_selection_digest: String,
    pub budget_lease_id: String,
    pub resource_lease_ids: Vec<String>,
    pub owner_epoch: u64,
    pub admitted_managed_revision: u64,
}

impl DelegationBindingV1 {
    const DOMAIN: &'static [u8] = b"horizoncode.delegation-binding.v1\0";

    /// Decode the exact canonical wire shape. Arrays must already be sorted and
    /// unique, and u64 strings must be canonical decimal without leading zeros.
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        const KEYS: [&str; 19] = [
            "schemaVersion",
            "runID",
            "taskID",
            "attemptID",
            "parentExecutionID",
            "childExecutionID",
            "acceptedSpecDigest",
            "profileID",
            "profileRevision",
            "profileDigest",
            "criteriaIDs",
            "workspaceLeaseID",
            "sourceRevision",
            "capabilityCeilingDigest",
            "contextSelectionDigest",
            "budgetLeaseID",
            "resourceLeaseIDs",
            "ownerEpoch",
            "admittedManagedRevision",
        ];
        if fields.len() != KEYS.len() || KEYS.iter().any(|key| !fields.contains_key(*key)) {
            return None;
        }
        if fields.get("schemaVersion") != Some(&Value::Unsigned(1)) {
            return None;
        }
        let text = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if valid_binding_id(value) => Some(value.clone()),
            _ => None,
        };
        let digest = |key: &str, valid: fn(&str) -> bool| match fields.get(key) {
            Some(Value::String(value)) if valid(value) => Some(value.clone()),
            _ => None,
        };
        let decimal = |key: &str| match fields.get(key) {
            Some(Value::String(value)) => parse_canonical_u64(value),
            _ => None,
        };
        let criteria_ids = binding_ids(fields.get("criteriaIDs")?, 32, false)?;
        let resource_lease_ids = binding_ids(fields.get("resourceLeaseIDs")?, 16, true)?;
        let binding = Self {
            run_id: text("runID")?,
            task_id: text("taskID")?,
            attempt_id: text("attemptID")?,
            parent_execution_id: text("parentExecutionID")?,
            child_execution_id: text("childExecutionID")?,
            accepted_spec_digest: digest("acceptedSpecDigest", is_blake3_digest)?,
            profile_id: text("profileID")?,
            profile_revision: decimal("profileRevision")?,
            profile_digest: digest("profileDigest", is_blake3_digest)?,
            criteria_ids,
            workspace_lease_id: text("workspaceLeaseID")?,
            source_revision: digest("sourceRevision", is_blake3_digest)?,
            capability_ceiling_digest: digest("capabilityCeilingDigest", is_sha256_digest)?,
            context_selection_digest: digest("contextSelectionDigest", is_blake3_digest)?,
            budget_lease_id: text("budgetLeaseID")?,
            resource_lease_ids,
            owner_epoch: decimal("ownerEpoch")?,
            admitted_managed_revision: decimal("admittedManagedRevision")?,
        };
        if binding.profile_revision == 0
            || binding.owner_epoch == 0
            || binding.admitted_managed_revision == 0
            || binding.parent_execution_id == binding.child_execution_id
        {
            return None;
        }
        Some(binding)
    }

    pub fn to_value(&self) -> Value {
        Value::Map(BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            ("runID".to_owned(), Value::String(self.run_id.clone())),
            ("taskID".to_owned(), Value::String(self.task_id.clone())),
            (
                "attemptID".to_owned(),
                Value::String(self.attempt_id.clone()),
            ),
            (
                "parentExecutionID".to_owned(),
                Value::String(self.parent_execution_id.clone()),
            ),
            (
                "childExecutionID".to_owned(),
                Value::String(self.child_execution_id.clone()),
            ),
            (
                "acceptedSpecDigest".to_owned(),
                Value::String(self.accepted_spec_digest.clone()),
            ),
            (
                "profileID".to_owned(),
                Value::String(self.profile_id.clone()),
            ),
            (
                "profileRevision".to_owned(),
                Value::String(self.profile_revision.to_string()),
            ),
            (
                "profileDigest".to_owned(),
                Value::String(self.profile_digest.clone()),
            ),
            (
                "criteriaIDs".to_owned(),
                Value::Array(
                    self.criteria_ids
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            ),
            (
                "workspaceLeaseID".to_owned(),
                Value::String(self.workspace_lease_id.clone()),
            ),
            (
                "sourceRevision".to_owned(),
                Value::String(self.source_revision.clone()),
            ),
            (
                "capabilityCeilingDigest".to_owned(),
                Value::String(self.capability_ceiling_digest.clone()),
            ),
            (
                "contextSelectionDigest".to_owned(),
                Value::String(self.context_selection_digest.clone()),
            ),
            (
                "budgetLeaseID".to_owned(),
                Value::String(self.budget_lease_id.clone()),
            ),
            (
                "resourceLeaseIDs".to_owned(),
                Value::Array(
                    self.resource_lease_ids
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            ),
            (
                "ownerEpoch".to_owned(),
                Value::String(self.owner_epoch.to_string()),
            ),
            (
                "admittedManagedRevision".to_owned(),
                Value::String(self.admitted_managed_revision.to_string()),
            ),
        ]))
    }

    /// Strict serde projection used only inside the durable managed OwnerLog.
    /// The canonical MessagePack representation remains the digest authority.
    pub fn from_json_value(value: &serde_json::Value) -> Option<Self> {
        fn convert(value: &serde_json::Value) -> Option<Value> {
            Some(match value {
                serde_json::Value::Null => Value::Nil,
                serde_json::Value::Bool(value) => Value::Bool(*value),
                serde_json::Value::Number(value) => {
                    if let Some(value) = value.as_u64() {
                        Value::Unsigned(value)
                    } else if let Some(value) = value.as_i64() {
                        Value::Signed(value)
                    } else {
                        Value::Float(value.as_f64()?.to_bits())
                    }
                }
                serde_json::Value::String(value) => Value::String(value.clone()),
                serde_json::Value::Array(values) => {
                    Value::Array(values.iter().map(convert).collect::<Option<_>>()?)
                }
                serde_json::Value::Object(values) => Value::Map(
                    values
                        .iter()
                        .map(|(key, value)| Some((key.clone(), convert(value)?)))
                        .collect::<Option<_>>()?,
                ),
            })
        }
        Self::from_value(&convert(value)?)
    }

    pub fn to_json_value(&self) -> Result<serde_json::Value, messagepack::MessagePackError> {
        fn convert(value: Value) -> serde_json::Value {
            match value {
                Value::Nil => serde_json::Value::Null,
                Value::Bool(value) => serde_json::Value::Bool(value),
                Value::Unsigned(value) => serde_json::Value::Number(value.into()),
                Value::Signed(value) => serde_json::Value::Number(value.into()),
                Value::String(value) => serde_json::Value::String(value),
                Value::Array(values) => {
                    serde_json::Value::Array(values.into_iter().map(convert).collect())
                }
                Value::Map(values) => serde_json::Value::Object(
                    values
                        .into_iter()
                        .map(|(key, value)| (key, convert(value)))
                        .collect(),
                ),
                Value::Binary(_) | Value::Float(_) => {
                    unreachable!("binding has no binary or float fields")
                }
            }
        }
        // Encoding first enforces the same canonical frame bounds used by digest().
        messagepack::encode(&self.to_value(), FRAME_LIMITS)?;
        Ok(convert(self.to_value()))
    }

    /// Domain-separated BLAKE3 over the canonical MessagePack map.
    pub fn digest(&self) -> Result<String, messagepack::MessagePackError> {
        let encoded = messagepack::encode(&self.to_value(), FRAME_LIMITS)?;
        let mut hasher = blake3::Hasher::new();
        hasher.update(Self::DOMAIN);
        hasher.update(&encoded);
        Ok(format!("blake3:{}", hasher.finalize().to_hex()))
    }
}

fn valid_binding_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_profile_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

fn parse_canonical_u64(value: &str) -> Option<u64> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return None;
    }
    let parsed = value.parse::<u64>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}

fn binding_ids(value: &Value, max: usize, allow_empty: bool) -> Option<Vec<String>> {
    let Value::Array(values) = value else {
        return None;
    };
    if values.len() > max || (!allow_empty && values.is_empty()) {
        return None;
    }
    let mut output = Vec::with_capacity(values.len());
    for value in values {
        let Value::String(value) = value else {
            return None;
        };
        if !valid_binding_id(value) {
            return None;
        }
        output.push(value.clone());
    }
    if output.windows(2).any(|pair| pair[0] >= pair[1]) {
        return None;
    }
    Some(output)
}

/// Trusted managed Attempt scope attached by Core to a Guard effect request.
/// The IDs are references, not authority: HostKernel validates them against the
/// durable managed OwnerLog and authenticated socket principal before admission.
/// `owner_epoch` is copied from the authenticated FrameFence and checked again by
/// HostKernel; it is never accepted as a substitute for that fence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedAttemptScopeV1 {
    pub goal_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub owner_epoch: u64,
    pub expected_managed_revision: u64,
    pub location_id: String,
    pub session_id: String,
    /// Exact bounded content digest captured at Attempt admission. HostKernel
    /// recomputes it before every effect boundary; callers cannot rebase authority.
    pub workspace_revision: String,
    /// BLAKE3 digest of the immutable HostKernel-minted DelegationBindingV1.
    /// IDs in this envelope are lookup hints; no managed effect is authorized
    /// unless HostKernel resolves and compares this digest to the durable Attempt.
    pub delegation_binding_digest: String,
}

impl ManagedAttemptScopeV1 {
    /// Decode only the exact fixed wire shape. Domain and authorization checks
    /// belong to HostKernel, after the OS peer and FrameFence have been verified.
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if fields.len() != 10
            || [
                "goalID",
                "runID",
                "taskID",
                "attemptID",
                "ownerEpoch",
                "expectedManagedRevision",
                "locationID",
                "sessionID",
                "workspaceRevision",
                "delegationBindingDigest",
            ]
            .iter()
            .any(|key| !fields.contains_key(*key))
        {
            return None;
        }
        let text = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if !value.is_empty() && !value.contains('\0') => {
                Some(value.clone())
            }
            _ => None,
        };
        let unsigned = |key: &str| match fields.get(key) {
            Some(Value::String(value)) => parse_canonical_u64(value),
            _ => None,
        };
        let scope = Self {
            goal_id: text("goalID")?,
            run_id: text("runID")?,
            task_id: text("taskID")?,
            attempt_id: text("attemptID")?,
            owner_epoch: unsigned("ownerEpoch")?,
            expected_managed_revision: unsigned("expectedManagedRevision")?,
            location_id: text("locationID")?,
            session_id: text("sessionID")?,
            workspace_revision: text("workspaceRevision")?,
            delegation_binding_digest: text("delegationBindingDigest")?,
        };
        if !is_blake3_digest(&scope.workspace_revision)
            || !is_blake3_digest(&scope.delegation_binding_digest)
        {
            return None;
        }
        Some(scope)
    }

    /// Deterministic wire object used for the Guard challenge/one-use lease digest.
    /// The key set is exact and map order is canonicalized by `Value::Map`.
    pub fn to_value(&self) -> Value {
        Value::Map(BTreeMap::from([
            ("goalID".to_owned(), Value::String(self.goal_id.clone())),
            ("runID".to_owned(), Value::String(self.run_id.clone())),
            ("taskID".to_owned(), Value::String(self.task_id.clone())),
            (
                "attemptID".to_owned(),
                Value::String(self.attempt_id.clone()),
            ),
            (
                "ownerEpoch".to_owned(),
                Value::String(self.owner_epoch.to_string()),
            ),
            (
                "expectedManagedRevision".to_owned(),
                Value::String(self.expected_managed_revision.to_string()),
            ),
            (
                "locationID".to_owned(),
                Value::String(self.location_id.clone()),
            ),
            (
                "sessionID".to_owned(),
                Value::String(self.session_id.clone()),
            ),
            (
                "workspaceRevision".to_owned(),
                Value::String(self.workspace_revision.clone()),
            ),
            (
                "delegationBindingDigest".to_owned(),
                Value::String(self.delegation_binding_digest.clone()),
            ),
        ]))
    }

    /// Stable `blake3:<hex>` digest of the exact MessagePack wire object. Guard
    /// stores this digest at prepare and requires the same scope at lease consume.
    pub fn digest(&self) -> Result<String, messagepack::MessagePackError> {
        let encoded = messagepack::encode(&self.to_value(), FRAME_LIMITS)?;
        Ok(format!("blake3:{}", blake3::hash(&encoded).to_hex()))
    }
}

/// Direct Goal-less child Attempt scope. Every authority value is persisted at
/// authenticated admission and compared again before an effect intent/lease is
/// consumed; the request envelope never grants any of these permissions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectAttemptScopeV1 {
    pub attempt_id: String,
    pub parent_session_id: String,
    pub child_session_id: String,
    pub owner_epoch: u64,
    pub expected_revision: u64,
    /// Exact immutable AgentProfileV2 revision selected by authenticated Core Config.
    /// The revision is decimal text on the private wire to avoid lossy JSON-number
    /// conversions and to match the profile-selection contract.
    pub profile_id: String,
    pub profile_revision: u64,
    pub profile_digest: String,
    pub location_id: String,
    pub workspace_id: String,
    pub workspace_revision: String,
    pub capability_digest: String,
    pub permissions_digest: String,
    pub budget_digest: String,
    pub scope_digest: String,
}

impl DirectAttemptScopeV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if fields.len() != 15
            || [
                "attemptID",
                "parentSessionID",
                "childSessionID",
                "ownerEpoch",
                "expectedRevision",
                "profileID",
                "profileRevision",
                "profileDigest",
                "locationID",
                "workspaceID",
                "workspaceRevision",
                "capabilityDigest",
                "permissionsDigest",
                "budgetDigest",
                "scopeDigest",
            ]
            .iter()
            .any(|key| !fields.contains_key(*key))
        {
            return None;
        }
        let text = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if !value.is_empty() && !value.contains('\0') => {
                Some(value.clone())
            }
            _ => None,
        };
        let unsigned = |key: &str| match fields.get(key) {
            Some(Value::Unsigned(value)) => Some(*value),
            _ => None,
        };
        let scope = Self {
            attempt_id: text("attemptID")?,
            parent_session_id: text("parentSessionID")?,
            child_session_id: text("childSessionID")?,
            owner_epoch: unsigned("ownerEpoch")?,
            expected_revision: unsigned("expectedRevision")?,
            profile_id: text("profileID")?,
            profile_revision: match fields.get("profileRevision") {
                Some(Value::String(value)) => parse_canonical_u64(value)?,
                _ => return None,
            },
            profile_digest: text("profileDigest")?,
            location_id: text("locationID")?,
            workspace_id: text("workspaceID")?,
            workspace_revision: text("workspaceRevision")?,
            capability_digest: text("capabilityDigest")?,
            permissions_digest: text("permissionsDigest")?,
            budget_digest: text("budgetDigest")?,
            scope_digest: text("scopeDigest")?,
        };
        if scope.owner_epoch == 0
            || scope.expected_revision == 0
            || !valid_profile_id(&scope.profile_id)
            || scope.profile_revision == 0
            || !is_blake3_digest(&scope.profile_digest)
            || !is_blake3_digest(&scope.workspace_revision)
            || !is_sha256_digest(&scope.capability_digest)
            || !is_sha256_digest(&scope.permissions_digest)
            || !is_sha256_digest(&scope.budget_digest)
            || !is_sha256_digest(&scope.scope_digest)
        {
            return None;
        }
        Some(scope)
    }

    pub fn to_value(&self) -> Value {
        Value::Map(BTreeMap::from([
            (
                "attemptID".to_owned(),
                Value::String(self.attempt_id.clone()),
            ),
            (
                "parentSessionID".to_owned(),
                Value::String(self.parent_session_id.clone()),
            ),
            (
                "childSessionID".to_owned(),
                Value::String(self.child_session_id.clone()),
            ),
            ("ownerEpoch".to_owned(), Value::Unsigned(self.owner_epoch)),
            (
                "expectedRevision".to_owned(),
                Value::Unsigned(self.expected_revision),
            ),
            (
                "profileID".to_owned(),
                Value::String(self.profile_id.clone()),
            ),
            (
                "profileRevision".to_owned(),
                Value::String(self.profile_revision.to_string()),
            ),
            (
                "profileDigest".to_owned(),
                Value::String(self.profile_digest.clone()),
            ),
            (
                "locationID".to_owned(),
                Value::String(self.location_id.clone()),
            ),
            (
                "workspaceID".to_owned(),
                Value::String(self.workspace_id.clone()),
            ),
            (
                "workspaceRevision".to_owned(),
                Value::String(self.workspace_revision.clone()),
            ),
            (
                "capabilityDigest".to_owned(),
                Value::String(self.capability_digest.clone()),
            ),
            (
                "permissionsDigest".to_owned(),
                Value::String(self.permissions_digest.clone()),
            ),
            (
                "budgetDigest".to_owned(),
                Value::String(self.budget_digest.clone()),
            ),
            (
                "scopeDigest".to_owned(),
                Value::String(self.scope_digest.clone()),
            ),
        ]))
    }

    pub fn digest(&self) -> Result<String, messagepack::MessagePackError> {
        scope_digest(&self.to_value())
    }
}

/// One mutually-exclusive authority envelope for Guarded effects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EffectAttemptScopeV1 {
    Managed(ManagedAttemptScopeV1),
    Direct(DirectAttemptScopeV1),
}

impl EffectAttemptScopeV1 {
    pub fn from_fields(fields: &BTreeMap<String, Value>) -> Option<Self> {
        match (fields.get("managedAttempt"), fields.get("directAttempt")) {
            (Some(value), None) => ManagedAttemptScopeV1::from_value(value).map(Self::Managed),
            (None, Some(value)) => DirectAttemptScopeV1::from_value(value).map(Self::Direct),
            (None, None) | (Some(_), Some(_)) => None,
        }
    }

    pub fn field_name(&self) -> &'static str {
        match self {
            Self::Managed(_) => "managedAttempt",
            Self::Direct(_) => "directAttempt",
        }
    }

    pub fn session_id(&self) -> &str {
        match self {
            Self::Managed(scope) => &scope.session_id,
            Self::Direct(scope) => &scope.child_session_id,
        }
    }

    pub fn location_id(&self) -> &str {
        match self {
            Self::Managed(scope) => &scope.location_id,
            Self::Direct(scope) => &scope.location_id,
        }
    }

    pub fn wire_value(&self) -> Value {
        match self {
            Self::Managed(scope) => scope.to_value(),
            Self::Direct(scope) => scope.to_value(),
        }
    }

    pub fn digest(&self) -> Result<String, messagepack::MessagePackError> {
        scope_digest(&self.wire_value())
    }
}

fn scope_digest(value: &Value) -> Result<String, messagepack::MessagePackError> {
    let bytes = messagepack::encode(value, FRAME_LIMITS)?;
    Ok(format!("blake3:{}", blake3::hash(&bytes).to_hex()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactClassificationV1 {
    Public,
    Workspace,
    Sensitive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCategoryV1 {
    Validation,
    Conflict,
    Authorization,
    Capability,
    NotFound,
    Unavailable,
    Deadline,
    Uncertain,
    Corruption,
    Internal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryClassV1 {
    Never,
    SafeQueryRetry,
    RetryAfterReconciliation,
    RetryAfterContextRecovery,
    UserActionRequired,
    RetryWithNewId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypedErrorV1 {
    pub code: String,
    pub category: ErrorCategoryV1,
    pub message: String,
    pub retry_class: RetryClassV1,
    pub retry_after_ms: Option<u64>,
    pub owner_cursor: Option<CursorV1>,
    pub subject_ids: Vec<String>,
    pub details: Option<ArtifactRefV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KernelHelloV1 {
    pub min_protocol: u16,
    pub max_protocol: u16,
    pub host_build_digest: String,
    pub kernel_build_digest: Option<String>,
    pub host_instance_id: String,
    pub process_incarnation: String,
    pub supervisor_nonce: String,
    pub required_features: Vec<String>,
    pub optional_features: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KernelHelloResultV1 {
    pub protocol: u16,
    pub enabled_features: Vec<String>,
    pub unavailable_optional_features: Vec<String>,
    pub supervisor_nonce: String,
    pub process_incarnation: String,
    /// Positive durable epoch held by the canonical host kernel owner.
    pub owner_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KernelHelloRejectedV1 {
    pub supervisor_nonce: String,
    pub process_incarnation: String,
    pub error: TypedErrorV1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KernelStartupStatusV1 {
    Starting,
    Ready,
    Failed(Box<TypedErrorV1>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcRequestV1 {
    pub owner_epoch: u64,
    pub process_incarnation: String,
    pub request_id: String,
    pub service_id: String,
    pub operation: String,
    pub delivery_id: Option<String>,
    pub expected_cursor: Option<CursorV1>,
    pub deadline_unix_ms: u64,
    pub trace_id: String,
    /// Operation-specific schema validation is performed by the service owner.
    pub body: Value,
}

/// Exact outer fence for one typed adapter operation. HostKernel must resolve the
/// process ref against its own live supervisor record before examining `operation`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionProtocolOperationRequestV1 {
    pub host_process_ref: crate::terminal_process::StdioProcessRefV1,
    pub session_id: String,
    pub location_id: String,
    pub workspace_revision: String,
    pub effect_id: String,
    pub challenge_id: String,
    pub capability_id: String,
    pub capability_lease_digest: String,
    pub managed_attempt: Option<Value>,
    pub direct_attempt: Option<Value>,
    pub operation: ExecutionProtocolOperationV1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecutionProtocolOperationV1 {
    Lsp(LanguageProtocolOperationV1),
    Dap(DebugProtocolOperationV1),
}

impl ExecutionProtocolOperationV1 {
    pub fn protocol_name(&self) -> &'static str {
        match self {
            Self::Lsp(_) => "lsp",
            Self::Dap(_) => "dap",
        }
    }

    pub fn request_sequence(&self) -> u64 {
        match self {
            Self::Lsp(operation) => operation.request_sequence,
            Self::Dap(operation) => operation.request_sequence,
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::Lsp(operation) => operation.to_value(),
            Self::Dap(operation) => operation.to_value(),
        }
    }

    /// Canonical digest preimage shared with Core: BLAKE3(MessagePack([
    /// "ExecutionProtocolOperationV1", protocol, requestSequence, operation])).
    pub fn operation_digest(&self) -> Result<String, crate::messagepack::MessagePackError> {
        let preimage = Value::Array(vec![
            Value::String("ExecutionProtocolOperationV1".to_owned()),
            Value::String(self.protocol_name().to_owned()),
            Value::String(self.request_sequence().to_string()),
            self.to_value(),
        ]);
        let packed = messagepack::encode(&preimage, FRAME_LIMITS)?;
        Ok(format!("blake3:{}", blake3::hash(&packed).to_hex()))
    }
}

/// Durable-before-ack receipt for a typed operation dispatched to the one
/// HostKernel-owned process supervisor. It contains no PID, path, or stdio bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionProtocolDispatchReceiptV1 {
    pub host_process_ref: crate::terminal_process::StdioProcessRefV1,
    pub request_sequence: u64,
    pub process_io_sequence: u64,
    pub operation_digest: String,
    pub dispatch_receipt_digest: String,
}

impl ExecutionProtocolDispatchReceiptV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        const KEYS: [&str; 7] = [
            "schemaVersion",
            "hostProcessRef",
            "requestSequence",
            "processIOSequence",
            "operationDigest",
            "dispatchReceiptDigest",
            "status",
        ];
        if fields.len() != KEYS.len()
            || KEYS.iter().any(|key| !fields.contains_key(*key))
            || fields.get("schemaVersion") != Some(&Value::Unsigned(1))
            || fields.get("status") != Some(&Value::String("DISPATCHED".to_owned()))
        {
            return None;
        }
        let decimal = |key: &str| match fields.get(key)? {
            Value::String(value) => parse_canonical_positive_u64(value),
            _ => None,
        };
        let digest = |key: &str| match fields.get(key)? {
            Value::String(value) if is_blake3_digest(value) => Some(value.clone()),
            _ => None,
        };
        Some(Self {
            host_process_ref: crate::terminal_process::StdioProcessRefV1::from_value(
                fields.get("hostProcessRef")?,
            )
            .ok()?,
            request_sequence: decimal("requestSequence")?,
            process_io_sequence: decimal("processIOSequence")?,
            operation_digest: digest("operationDigest")?,
            dispatch_receipt_digest: digest("dispatchReceiptDigest")?,
        })
    }

    pub fn new(
        host_process_ref: crate::terminal_process::StdioProcessRefV1,
        effect_id: &str,
        challenge_id: &str,
        capability_id: &str,
        capability_lease_digest: &str,
        operation: &ExecutionProtocolOperationV1,
        process_io_sequence: u64,
        accepted_frame_bytes: u64,
    ) -> Result<Self, crate::messagepack::MessagePackError> {
        let operation_digest = operation.operation_digest()?;
        let preimage = Value::Array(vec![
            Value::String("ExecutionProtocolDispatchReceiptV1.dispatch".to_owned()),
            host_process_ref.to_value(),
            Value::String(effect_id.to_owned()),
            Value::String(challenge_id.to_owned()),
            Value::String(capability_id.to_owned()),
            Value::String(capability_lease_digest.to_owned()),
            Value::String(operation.request_sequence().to_string()),
            Value::String(process_io_sequence.to_string()),
            Value::String(operation_digest.clone()),
            Value::Unsigned(accepted_frame_bytes),
        ]);
        let packed = messagepack::encode(&preimage, FRAME_LIMITS)?;
        let dispatch_receipt_digest = format!("blake3:{}", blake3::hash(&packed).to_hex());
        Ok(Self {
            host_process_ref,
            request_sequence: operation.request_sequence(),
            process_io_sequence,
            operation_digest,
            dispatch_receipt_digest,
        })
    }

    pub fn to_value(&self) -> Value {
        Value::Map(BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            ("hostProcessRef".to_owned(), self.host_process_ref.to_value()),
            ("requestSequence".to_owned(), Value::String(self.request_sequence.to_string())),
            ("processIOSequence".to_owned(), Value::String(self.process_io_sequence.to_string())),
            ("operationDigest".to_owned(), Value::String(self.operation_digest.clone())),
            ("dispatchReceiptDigest".to_owned(), Value::String(self.dispatch_receipt_digest.clone())),
            ("status".to_owned(), Value::String("DISPATCHED".to_owned())),
        ]))
    }
}

impl ExecutionProtocolOperationRequestV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        const REQUIRED: [&str; 9] = [
            "hostProcessRef",
            "sessionID",
            "locationID",
            "workspaceRevision",
            "effectID",
            "challengeID",
            "capabilityID",
            "capabilityLeaseDigest",
            "operation",
        ];
        if fields.len() < REQUIRED.len()
            || fields.len() > REQUIRED.len() + 2
            || REQUIRED.iter().any(|key| !fields.contains_key(*key))
            || fields.keys().any(|key| {
                !REQUIRED.contains(&key.as_str())
                    && !matches!(key.as_str(), "managedAttempt" | "directAttempt")
            })
            || (fields.contains_key("managedAttempt") && fields.contains_key("directAttempt"))
        {
            return None;
        }
        let host_process_ref = crate::terminal_process::StdioProcessRefV1::from_value(
            fields.get("hostProcessRef")?,
        )
        .ok()?;
        let id = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if valid_binding_id(value) => Some(value.clone()),
            _ => None,
        };
        let workspace_revision = match fields.get("workspaceRevision")? {
            Value::String(value) if is_blake3_digest(value) => value.clone(),
            _ => return None,
        };
        let capability_lease_digest = match fields.get("capabilityLeaseDigest")? {
            Value::String(value) if is_blake3_digest(value) => value.clone(),
            _ => return None,
        };
        let operation_value = fields.get("operation")?;
        let operation = match host_process_ref.kind() {
            crate::terminal_process::StdioProcessKindV1::LanguageServer => {
                let operation = LanguageProtocolOperationV1::from_value(operation_value)?;
                let expected = crate::guard::language_protocol_capability(&operation.method)?;
                if id("capabilityID")?.as_str() != expected {
                    return None;
                }
                ExecutionProtocolOperationV1::Lsp(operation)
            }
            crate::terminal_process::StdioProcessKindV1::DebugAdapter => {
                let operation = DebugProtocolOperationV1::from_value(operation_value)?;
                let expected = crate::guard::debug_protocol_capability(&operation.command)?;
                if id("capabilityID")?.as_str() != expected {
                    return None;
                }
                ExecutionProtocolOperationV1::Dap(operation)
            }
            _ => return None,
        };
        Some(Self {
            host_process_ref,
            session_id: id("sessionID")?,
            location_id: id("locationID")?,
            workspace_revision,
            effect_id: id("effectID")?,
            challenge_id: id("challengeID")?,
            capability_id: id("capabilityID")?,
            capability_lease_digest,
            managed_attempt: fields.get("managedAttempt").cloned(),
            direct_attempt: fields.get("directAttempt").cloned(),
            operation,
        })
    }
}

/// Authenticated reply to one HostKernel-buffered LSP server request. The caller
/// cannot invent a method/ID pair: the dispatcher correlates this exact tuple to
/// the retained event before it may write the JSON-RPC response to the process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionProtocolReplyRequestV1 {
    pub host_process_ref: crate::terminal_process::StdioProcessRefV1,
    pub session_id: String,
    pub location_id: String,
    pub workspace_revision: String,
    pub effect_id: String,
    pub challenge_id: String,
    pub capability_id: String,
    pub capability_lease_digest: String,
    pub managed_attempt: Option<Value>,
    pub direct_attempt: Option<Value>,
    pub reply: LanguageProtocolReplyV1,
}

impl ExecutionProtocolReplyRequestV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        const REQUIRED: [&str; 10] = [
            "hostProcessRef",
            "sessionID",
            "locationID",
            "workspaceRevision",
            "effectID",
            "challengeID",
            "capabilityID",
            "capabilityLeaseDigest",
            "reply",
            "schemaVersion",
        ];
        if fields.len() < REQUIRED.len()
            || fields.len() > REQUIRED.len() + 2
            || REQUIRED.iter().any(|key| !fields.contains_key(*key))
            || fields.keys().any(|key| {
                !REQUIRED.contains(&key.as_str())
                    && !matches!(key.as_str(), "managedAttempt" | "directAttempt")
            })
            || (fields.contains_key("managedAttempt") && fields.contains_key("directAttempt"))
            || fields.get("schemaVersion") != Some(&Value::Unsigned(1))
        {
            return None;
        }
        let host_process_ref = crate::terminal_process::StdioProcessRefV1::from_value(
            fields.get("hostProcessRef")?,
        )
        .ok()?;
        if host_process_ref.kind()
            != crate::terminal_process::StdioProcessKindV1::LanguageServer
        {
            return None;
        }
        let id = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if valid_binding_id(value) => Some(value.clone()),
            _ => None,
        };
        let workspace_revision = match fields.get("workspaceRevision")? {
            Value::String(value) if is_blake3_digest(value) => value.clone(),
            _ => return None,
        };
        let capability_lease_digest = match fields.get("capabilityLeaseDigest")? {
            Value::String(value) if is_blake3_digest(value) => value.clone(),
            _ => return None,
        };
        let reply = LanguageProtocolReplyV1::from_value(fields.get("reply")?)?;
        if crate::guard::language_server_request_capability(&reply.method)?
            != id("capabilityID")?
        {
            return None;
        }
        Some(Self {
            host_process_ref,
            session_id: id("sessionID")?,
            location_id: id("locationID")?,
            workspace_revision,
            effect_id: id("effectID")?,
            challenge_id: id("challengeID")?,
            capability_id: id("capabilityID")?,
            capability_lease_digest,
            managed_attempt: fields.get("managedAttempt").cloned(),
            direct_attempt: fields.get("directAttempt").cloned(),
            reply,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionProtocolProcessStatusV1 {
    Running,
    Exited,
    Unknown,
}

/// Nonblocking bounded process-event page request. An empty RUNNING page returns
/// immediately; Core performs a bounded backoff before polling again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionProtocolReadRequestV1 {
    pub host_process_ref: crate::terminal_process::StdioProcessRefV1,
    pub session_id: String,
    pub location_id: String,
    pub workspace_revision: String,
    pub after_event_sequence: u64,
    pub max_events: u64,
    pub max_bytes: u64,
    pub managed_attempt: Option<Value>,
    pub direct_attempt: Option<Value>,
}

impl ExecutionProtocolReadRequestV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        const REQUIRED: [&str; 7] = [
            "hostProcessRef",
            "sessionID",
            "locationID",
            "workspaceRevision",
            "afterEventSequence",
            "maxEvents",
            "maxBytes",
        ];
        if fields.len() < REQUIRED.len()
            || fields.len() > REQUIRED.len() + 2
            || REQUIRED.iter().any(|key| !fields.contains_key(*key))
            || fields.keys().any(|key| {
                !REQUIRED.contains(&key.as_str())
                    && !matches!(key.as_str(), "managedAttempt" | "directAttempt")
            })
            || (fields.contains_key("managedAttempt") && fields.contains_key("directAttempt"))
        {
            return None;
        }
        let host_process_ref = crate::terminal_process::StdioProcessRefV1::from_value(
            fields.get("hostProcessRef")?,
        )
        .ok()?;
        let id = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if valid_binding_id(value) => Some(value.clone()),
            _ => None,
        };
        let workspace_revision = match fields.get("workspaceRevision")? {
            Value::String(value) if is_blake3_digest(value) => value.clone(),
            _ => return None,
        };
        let after_event_sequence = match fields.get("afterEventSequence")? {
            Value::String(value) => parse_canonical_u64(value)?,
            _ => return None,
        };
        let max_events = match fields.get("maxEvents")? {
            Value::Unsigned(value) => *value,
            _ => return None,
        };
        let max_bytes = match fields.get("maxBytes")? {
            Value::Unsigned(value) => *value,
            _ => return None,
        };
        if !(1..=64).contains(&max_events) || !(1..=1_048_576).contains(&max_bytes) {
            return None;
        }
        Some(Self {
            host_process_ref,
            session_id: id("sessionID")?,
            location_id: id("locationID")?,
            workspace_revision,
            after_event_sequence,
            max_events,
            max_bytes,
            managed_attempt: fields.get("managedAttempt").cloned(),
            direct_attempt: fields.get("directAttempt").cloned(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecutionProtocolBufferedEventV1 {
    LspNotification(LanguageProtocolEventV1),
    LspServerRequest(LanguageProtocolServerRequestV1),
    LspResponse(LanguageProtocolResponseV1),
    DapResponse(DebugProtocolResponseV1),
    Dap(DebugProtocolEventV1),
}

impl ExecutionProtocolBufferedEventV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        let protocol = match fields.get("protocol")? {
            Value::String(value) => value.as_str(),
            _ => return None,
        };
        let message_kind = match fields.get("messageKind")? {
            Value::String(value) => value.as_str(),
            _ => return None,
        };
        let payload = fields.get("payload")?;
        if fields.len() != 3
            || fields
                .keys()
                .any(|key| !matches!(key.as_str(), "protocol" | "messageKind" | "payload"))
        {
            return None;
        }
        match (protocol, message_kind) {
            ("lsp", "notification") => {
                LanguageProtocolEventV1::from_value(payload).map(Self::LspNotification)
            }
            ("lsp", "server_request") => {
                LanguageProtocolServerRequestV1::from_value(payload).map(Self::LspServerRequest)
            }
            ("lsp", "response") => {
                LanguageProtocolResponseV1::from_value(payload).map(Self::LspResponse)
            }
            ("dap", "response") => {
                DebugProtocolResponseV1::from_value(payload).map(Self::DapResponse)
            }
            ("dap", "event") => DebugProtocolEventV1::from_value(payload).map(Self::Dap),
            _ => None,
        }
    }

    pub fn event_sequence(&self) -> u64 {
        match self {
            Self::LspNotification(event) => event.event_sequence,
            Self::LspServerRequest(event) => event.event_sequence,
            Self::LspResponse(event) => event.event_sequence,
            Self::DapResponse(event) => event.event_sequence,
            Self::Dap(event) => event.event_sequence,
        }
    }
}

/// Typed nonblocking page returned by `execution.v1/protocol_read`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionProtocolReadPageV1 {
    pub host_process_ref: crate::terminal_process::StdioProcessRefV1,
    pub after_event_sequence: u64,
    pub process_io_sequence: u64,
    pub workspace_revision: String,
    pub status: ExecutionProtocolProcessStatusV1,
    pub events: Vec<ExecutionProtocolBufferedEventV1>,
}

impl ExecutionProtocolReadPageV1 {
    pub fn from_value(value: &Value, max_events: usize, max_bytes: usize) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        const KEYS: [&str; 6] = [
            "hostProcessRef",
            "afterEventSequence",
            "processIOSequence",
            "workspaceRevision",
            "status",
            "events",
        ];
        if fields.len() != KEYS.len() || KEYS.iter().any(|key| !fields.contains_key(*key)) {
            return None;
        }
        let host_process_ref = crate::terminal_process::StdioProcessRefV1::from_value(
            fields.get("hostProcessRef")?,
        )
        .ok()?;
        let decimal = |key: &str| match fields.get(key) {
            Some(Value::String(value)) => parse_canonical_u64(value),
            _ => None,
        };
        let after_event_sequence = decimal("afterEventSequence")?;
        let process_io_sequence = decimal("processIOSequence")?;
        let workspace_revision = match fields.get("workspaceRevision")? {
            Value::String(value) if is_blake3_digest(value) => value.clone(),
            _ => return None,
        };
        let status = match fields.get("status")? {
            Value::String(value) if value == "RUNNING" => ExecutionProtocolProcessStatusV1::Running,
            Value::String(value) if value == "EXITED" => ExecutionProtocolProcessStatusV1::Exited,
            Value::String(value) if value == "UNKNOWN" => ExecutionProtocolProcessStatusV1::Unknown,
            _ => return None,
        };
        let Value::Array(raw_events) = fields.get("events")? else {
            return None;
        };
        if max_events == 0 || max_events > 64 || max_bytes == 0 || max_bytes > 1_048_576
            || raw_events.len() > max_events
        {
            return None;
        }
        let encoded = messagepack::encode(
            &Value::Array(raw_events.clone()),
            Limits {
                max_encoded_bytes: max_bytes,
                max_depth: FRAME_LIMITS.max_depth,
                max_nodes: FRAME_LIMITS.max_nodes,
                max_collection_items: 4096,
                max_scalar_bytes: max_bytes,
            },
        )
        .ok()?;
        if encoded.len() > max_bytes {
            return None;
        }
        let events = raw_events
            .iter()
            .map(ExecutionProtocolBufferedEventV1::from_value)
            .collect::<Option<Vec<_>>>()?;
        let protocol_matches_kind = match host_process_ref.kind() {
            crate::terminal_process::StdioProcessKindV1::LanguageServer => events.iter().all(
                |event| {
                    matches!(
                        event,
                        ExecutionProtocolBufferedEventV1::LspNotification(_)
                            | ExecutionProtocolBufferedEventV1::LspServerRequest(_)
                            | ExecutionProtocolBufferedEventV1::LspResponse(_)
                    )
                },
            ),
            crate::terminal_process::StdioProcessKindV1::DebugAdapter => events
                .iter()
                .all(|event| matches!(
                    event,
                    ExecutionProtocolBufferedEventV1::DapResponse(_)
                        | ExecutionProtocolBufferedEventV1::Dap(_)
                )),
            _ => false,
        };
        if !protocol_matches_kind {
            return None;
        }
        let mut previous = after_event_sequence;
        for event in &events {
            if previous.checked_add(1) != Some(event.event_sequence()) {
                return None;
            }
            previous = event.event_sequence();
        }
        Some(Self {
            host_process_ref,
            after_event_sequence,
            process_io_sequence,
            workspace_revision,
            status,
            events,
        })
    }
}

/// One bounded LSP JSON-RPC operation sent through `execution.v1/protocol_op`.
/// It contains no executable, process handle or stdio bytes. HostKernel checks the
/// method against the canonical Guard map before creating a JSON-RPC frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanguageProtocolOperationV1 {
    pub request_sequence: u64,
    pub method: String,
    pub request_id: Option<Value>,
    pub params: Value,
}

impl LanguageProtocolOperationV1 {
    pub const MAX_PARAMS_ENCODED_BYTES: usize = 1024 * 1024;
    pub const MAX_PARAMS_DEPTH: usize = 24;
    pub const MAX_PARAMS_NODES: usize = 16_384;

    /// Decode the exact private wire shape and enforce a deliberately smaller
    /// payload budget than the enclosing IPC frame.
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if !(3..=4).contains(&fields.len())
            || !fields.contains_key("requestSequence")
            || !fields.contains_key("method")
            || !fields.contains_key("params")
            || fields
                .keys()
                .any(|key| !matches!(key.as_str(), "requestSequence" | "method" | "requestID" | "params"))
        {
            return None;
        }
        let request_sequence = match fields.get("requestSequence")? {
            Value::String(value) => parse_canonical_positive_u64(value)?,
            _ => return None,
        };
        let method = match fields.get("method")? {
            Value::String(value)
                if !value.is_empty()
                    && value.len() <= 128
                    && value.bytes().all(|byte| byte.is_ascii_graphic()) =>
            {
                value.clone()
            }
            _ => return None,
        };
        let is_request = crate::guard::language_protocol_is_request(&method)?;
        let request_id = match fields.get("requestID") {
            Some(Value::String(value))
                if is_request
                    && !value.is_empty()
                    && value.len() <= 128
                    && !value.bytes().any(|byte| byte.is_ascii_control()) =>
            {
                Some(Value::String(value.clone()))
            }
            Some(Value::Unsigned(value)) if is_request => Some(Value::Unsigned(*value)),
            Some(Value::Signed(value)) if is_request && *value >= 0 => {
                Some(Value::Signed(*value))
            }
            None if !is_request => None,
            _ => return None,
        };
        let params = fields.get("params")?.clone();
        if !bounded_protocol_json(&params, Self::MAX_PARAMS_ENCODED_BYTES) {
            return None;
        }
        let encoded = messagepack::encode(
            &params,
            Limits {
                max_encoded_bytes: Self::MAX_PARAMS_ENCODED_BYTES,
                max_depth: Self::MAX_PARAMS_DEPTH,
                max_nodes: Self::MAX_PARAMS_NODES,
                max_collection_items: 4096,
                max_scalar_bytes: Self::MAX_PARAMS_ENCODED_BYTES,
            },
        )
        .ok()?;
        if encoded.len() > Self::MAX_PARAMS_ENCODED_BYTES {
            return None;
        }
        Some(Self {
            request_sequence,
            method,
            request_id,
            params,
        })
    }

    pub fn to_value(&self) -> Value {
        let mut fields = BTreeMap::from([
            (
                "requestSequence".to_owned(),
                Value::String(self.request_sequence.to_string()),
            ),
            ("method".to_owned(), Value::String(self.method.clone())),
            ("params".to_owned(), self.params.clone()),
        ]);
        if let Some(request_id) = &self.request_id {
            fields.insert("requestID".to_owned(), request_id.clone());
        }
        Value::Map(fields)
    }
}

fn parse_canonical_positive_u64(value: &str) -> Option<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let parsed = value.parse::<u64>().ok()?;
    (parsed > 0).then_some(parsed)
}

fn json_value_within_bounds(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    max_depth: usize,
    max_nodes: usize,
) -> bool {
    if depth > max_depth {
        return false;
    }
    *nodes = match nodes.checked_add(1) {
        Some(nodes) if nodes <= max_nodes => nodes,
        _ => return false,
    };
    match value {
        Value::Binary(_) => false,
        Value::String(value) => !value.contains('\0'),
        Value::Array(values) => values.iter().all(|value| {
            json_value_within_bounds(value, depth + 1, nodes, max_depth, max_nodes)
        }),
        Value::Map(values) => values.iter().all(|(key, value)| {
            !key.contains('\0')
                && json_value_within_bounds(value, depth + 1, nodes, max_depth, max_nodes)
        }),
        Value::Float(bits) => f64::from_bits(*bits).is_finite(),
        Value::Nil | Value::Bool(_) | Value::Unsigned(_) | Value::Signed(_) => true,
    }
}

/// Server-initiated request emitted by the supervised LSP process. Only the
/// explicit adapter callback set is decoded; arbitrary JSON-RPC methods never
/// reach a generic Core request handler.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanguageProtocolServerRequestV1 {
    pub event_sequence: u64,
    pub request_id: Value,
    pub method: String,
    pub params: Value,
}

impl LanguageProtocolServerRequestV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if fields.len() != 4
            || fields
                .keys()
                .any(|key| !matches!(key.as_str(), "eventSequence" | "requestID" | "method" | "params"))
        {
            return None;
        }
        let event_sequence = match fields.get("eventSequence")? {
            Value::String(value) => parse_canonical_positive_u64(value)?,
            _ => return None,
        };
        let request_id = fields.get("requestID")?.clone();
        if !valid_jsonrpc_request_id(&request_id) {
            return None;
        }
        let method = match fields.get("method")? {
            Value::String(value) if supported_language_server_request(value) => value.clone(),
            _ => return None,
        };
        let params = fields.get("params")?.clone();
        if !matches!(params, Value::Map(_) | Value::Array(_))
            || !bounded_protocol_json(
                &params,
                LanguageProtocolOperationV1::MAX_PARAMS_ENCODED_BYTES,
            )
        {
            return None;
        }
        Some(Self {
            event_sequence,
            request_id,
            method,
            params,
        })
    }
}

/// Asynchronous server notification forwarded to Core. V1 forwards only
/// publishDiagnostics; all other notifications are rejected by the process
/// decoder before they can become UI events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanguageProtocolEventV1 {
    pub event_sequence: u64,
    pub method: String,
    pub params: Value,
}

/// Correlated JSON-RPC response produced by the supervised LSP process. The
/// request sequence and id are retained separately from the replay event cursor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanguageProtocolResponseV1 {
    pub event_sequence: u64,
    pub request_sequence: u64,
    pub request_id: Value,
    pub method: String,
    pub result: Option<Value>,
    pub error: Option<Value>,
}

impl LanguageProtocolResponseV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if !(6..=7).contains(&fields.len())
            || fields.keys().any(|key| {
                !matches!(key.as_str(), "schemaVersion" | "eventSequence" | "requestSequence" | "requestID" | "method" | "result" | "error")
            })
            || fields.get("schemaVersion") != Some(&Value::Unsigned(1))
            || fields.contains_key("result") == fields.contains_key("error")
        {
            return None;
        }
        let decimal = |key: &str| match fields.get(key) {
            Some(Value::String(value)) => parse_canonical_positive_u64(value),
            _ => None,
        };
        let event_sequence = decimal("eventSequence")?;
        let request_sequence = decimal("requestSequence")?;
        let request_id = fields.get("requestID")?.clone();
        if !valid_jsonrpc_request_id(&request_id) {
            return None;
        }
        let method = match fields.get("method")? {
            Value::String(value) if crate::guard::language_protocol_is_request(value).unwrap_or(false) => value.clone(),
            _ => return None,
        };
        let result = fields.get("result").cloned();
        let error = fields.get("error").cloned();
        if let Some(result) = &result {
            let mut nodes = 0;
            if !matches!(result, Value::Nil | Value::Map(_) | Value::Array(_))
                || !json_value_within_bounds(result, 0, &mut nodes, 24, 16_384)
            {
                return None;
            }
        }
        if let Some(error) = &error {
            if !valid_jsonrpc_error(error) {
                return None;
            }
        }
        let payload = result.as_ref().or(error.as_ref())?;
        let encoded = messagepack::encode(
            payload,
            Limits {
                max_encoded_bytes: LanguageProtocolOperationV1::MAX_PARAMS_ENCODED_BYTES,
                max_depth: LanguageProtocolOperationV1::MAX_PARAMS_DEPTH,
                max_nodes: LanguageProtocolOperationV1::MAX_PARAMS_NODES,
                max_collection_items: 4096,
                max_scalar_bytes: LanguageProtocolOperationV1::MAX_PARAMS_ENCODED_BYTES,
            },
        )
        .ok()?;
        if encoded.len() > LanguageProtocolOperationV1::MAX_PARAMS_ENCODED_BYTES {
            return None;
        }
        Some(Self {
            event_sequence,
            request_sequence,
            request_id,
            method,
            result,
            error,
        })
    }
}

impl LanguageProtocolEventV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if fields.len() != 3
            || fields
                .keys()
                .any(|key| !matches!(key.as_str(), "eventSequence" | "method" | "params"))
        {
            return None;
        }
        let event_sequence = match fields.get("eventSequence")? {
            Value::String(value) => parse_canonical_positive_u64(value)?,
            _ => return None,
        };
        if fields.get("method")? != &Value::String("textDocument/publishDiagnostics".to_owned()) {
            return None;
        }
        let params = fields.get("params")?.clone();
        if !matches!(params, Value::Map(_))
            || !bounded_protocol_json(
                &params,
                LanguageProtocolOperationV1::MAX_PARAMS_ENCODED_BYTES,
            )
        {
            return None;
        }
        Some(Self {
            event_sequence,
            method: "textDocument/publishDiagnostics".to_owned(),
            params,
        })
    }
}

/// Method-correlated response to one HostKernel-buffered server request.
/// Results have method-specific shapes; there is deliberately no generic error
/// or arbitrary callback escape hatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanguageProtocolReplyV1 {
    pub request_sequence: u64,
    pub server_request_id: Value,
    pub method: String,
    pub result: Value,
}

impl LanguageProtocolReplyV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        const KEYS: [&str; 5] = [
            "requestSequence",
            "serverRequestID",
            "method",
            "result",
            "schemaVersion",
        ];
        if fields.len() != KEYS.len() || KEYS.iter().any(|key| !fields.contains_key(*key)) {
            return None;
        }
        if fields.get("schemaVersion") != Some(&Value::Unsigned(1)) {
            return None;
        }
        let request_sequence = match fields.get("requestSequence")? {
            Value::String(value) => parse_canonical_positive_u64(value)?,
            _ => return None,
        };
        let server_request_id = fields.get("serverRequestID")?.clone();
        if !valid_jsonrpc_request_id(&server_request_id) {
            return None;
        }
        let method = match fields.get("method")? {
            Value::String(value) if supported_language_server_request(value) => value.clone(),
            _ => return None,
        };
        let result = fields.get("result")?.clone();
        if !valid_language_server_result(&method, &result)
            || !bounded_protocol_json(
                &result,
                LanguageProtocolOperationV1::MAX_PARAMS_ENCODED_BYTES,
            )
        {
            return None;
        }
        Some(Self {
            request_sequence,
            server_request_id,
            method,
            result,
        })
    }
}

/// One bounded DAP request sent to a supervised adapter. `command` must have a
/// canonical Guard mapping; launch and unknown commands are not decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebugProtocolOperationV1 {
    pub request_sequence: u64,
    pub request_id: u64,
    pub command: String,
    pub arguments: Value,
}

const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

impl DebugProtocolOperationV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        const KEYS: [&str; 4] = ["requestSequence", "requestID", "command", "arguments"];
        if fields.len() != KEYS.len() || KEYS.iter().any(|key| !fields.contains_key(*key)) {
            return None;
        }
        let request_sequence = match fields.get("requestSequence")? {
            Value::String(value) => parse_canonical_positive_u64(value)?,
            _ => return None,
        };
        let request_id = match fields.get("requestID")? {
            Value::Unsigned(value) if (1..=MAX_SAFE_JSON_INTEGER).contains(value) => *value,
            _ => return None,
        };
        let command = match fields.get("command")? {
            Value::String(value)
                if !value.is_empty()
                    && value.len() <= 128
                    && value.bytes().all(|byte| byte.is_ascii_graphic())
                    && crate::guard::debug_protocol_capability(value).is_some() =>
            {
                value.clone()
            }
            _ => return None,
        };
        let arguments = fields.get("arguments")?.clone();
        if !matches!(arguments, Value::Map(_))
            || !bounded_protocol_json(
                &arguments,
                LanguageProtocolOperationV1::MAX_PARAMS_ENCODED_BYTES,
            )
        {
            return None;
        }
        Some(Self {
            request_sequence,
            request_id,
            command,
            arguments,
        })
    }

    pub fn to_value(&self) -> Value {
        Value::Map(BTreeMap::from([
            ("requestSequence".to_owned(), Value::String(self.request_sequence.to_string())),
            ("requestID".to_owned(), Value::Unsigned(self.request_id)),
            ("command".to_owned(), Value::String(self.command.clone())),
            ("arguments".to_owned(), self.arguments.clone()),
        ]))
    }
}

/// Correlated response from a DAP adapter. Only the response to an admitted
/// request may be surfaced to Core; sequence and command are checked against the
/// pending request before this projection is emitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebugProtocolResponseV1 {
    pub event_sequence: u64,
    pub request_sequence: u64,
    pub request_id: u64,
    pub command: String,
    pub success: bool,
    pub body: Option<Value>,
    pub message: Option<String>,
}

impl DebugProtocolResponseV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if !(6..=8).contains(&fields.len())
            || fields.keys().any(|key| {
                !matches!(key.as_str(), "eventSequence" | "requestSequence" | "requestID" | "command" | "success" | "body" | "message" | "schemaVersion")
            })
        {
            return None;
        }
        if fields.get("schemaVersion") != Some(&Value::Unsigned(1)) {
            return None;
        }
        let event_sequence = match fields.get("eventSequence")? {
            Value::String(value) => parse_canonical_positive_u64(value)?,
            _ => return None,
        };
        let request_sequence = match fields.get("requestSequence")? {
            Value::String(value) => parse_canonical_positive_u64(value)?,
            _ => return None,
        };
        let request_id = match fields.get("requestID")? {
            Value::Unsigned(value) if (1..=MAX_SAFE_JSON_INTEGER).contains(value) => *value,
            _ => return None,
        };
        let command = match fields.get("command")? {
            Value::String(value) if crate::guard::debug_protocol_capability(value).is_some() => {
                value.clone()
            }
            _ => return None,
        };
        let success = match fields.get("success")? {
            Value::Bool(value) => *value,
            _ => return None,
        };
        let body = fields.get("body").cloned();
        let message = match fields.get("message") {
            None => None,
            Some(Value::String(value)) if value.len() <= 4096 && !value.bytes().any(|b| b.is_ascii_control()) => {
                Some(value.clone())
            }
            _ => return None,
        };
        if !success && message.is_none() {
            return None;
        }
        if let Some(body) = &body {
            if !matches!(body, Value::Map(_))
                || !bounded_protocol_json(
                    body,
                    LanguageProtocolOperationV1::MAX_PARAMS_ENCODED_BYTES,
                )
            {
                return None;
            }
        }
        Some(Self {
            event_sequence,
            request_sequence,
            request_id,
            command,
            success,
            body,
            message,
        })
    }
}

/// Allowlisted asynchronous DAP event from the adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebugProtocolEventV1 {
    pub event_sequence: u64,
    pub dap_sequence: u64,
    pub event: String,
    pub body: Option<Value>,
}

impl DebugProtocolEventV1 {
    pub fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if !(3..=4).contains(&fields.len())
            || fields.keys().any(|key| {
                !matches!(key.as_str(), "eventSequence" | "dapSequence" | "event" | "body")
            })
        {
            return None;
        }
        let event_sequence = match fields.get("eventSequence")? {
            Value::String(value) => parse_canonical_positive_u64(value)?,
            _ => return None,
        };
        let dap_sequence = match fields.get("dapSequence")? {
            Value::Unsigned(value) if *value > 0 => *value,
            _ => return None,
        };
        let event = match fields.get("event")? {
            Value::String(value) if supported_debug_event(value) => value.clone(),
            _ => return None,
        };
        let body = fields.get("body").cloned();
        if let Some(body) = &body {
            if !matches!(body, Value::Map(_))
                || !bounded_protocol_json(
                    body,
                    LanguageProtocolOperationV1::MAX_PARAMS_ENCODED_BYTES,
                )
            {
                return None;
            }
        }
        Some(Self {
            event_sequence,
            dap_sequence,
            event,
            body,
        })
    }
}

fn supported_debug_event(event: &str) -> bool {
    matches!(
        event,
        "initialized"
            | "stopped"
            | "continued"
            | "exited"
            | "terminated"
            | "thread"
            | "output"
            | "breakpoint"
            | "module"
            | "loadedSource"
            | "process"
            | "capabilities"
            | "progressStart"
            | "progressUpdate"
            | "progressEnd"
            | "invalidated"
    )
}

fn valid_jsonrpc_request_id(value: &Value) -> bool {
    match value {
        Value::String(value) => {
            !value.is_empty() && value.len() <= 128 && !value.bytes().any(|byte| byte.is_ascii_control())
        }
        Value::Unsigned(_) => true,
        Value::Signed(value) => *value >= 0,
        _ => false,
    }
}

fn valid_jsonrpc_error(value: &Value) -> bool {
    let Value::Map(fields) = value else {
        return false;
    };
    if !(2..=3).contains(&fields.len())
        || fields
            .keys()
            .any(|key| !matches!(key.as_str(), "code" | "message" | "data"))
    {
        return false;
    }
    let code_valid = matches!(
        fields.get("code"),
        Some(Value::Signed(_)) | Some(Value::Unsigned(_))
    );
    let message_valid = matches!(
        fields.get("message"),
        Some(Value::String(message)) if message.len() <= 4096 && !message.contains('\0')
    );
    if !code_valid || !message_valid {
        return false;
    }
    let Some(data) = fields.get("data") else {
        return true;
    };
    let mut nodes = 0;
    json_value_within_bounds(data, 0, &mut nodes, 24, 16_384)
}

fn supported_language_server_request(method: &str) -> bool {
    matches!(
        method,
        "window/workDoneProgress/create"
            | "workspace/configuration"
            | "client/registerCapability"
            | "client/unregisterCapability"
            | "workspace/workspaceFolders"
            | "workspace/diagnostic/refresh"
    )
}

fn valid_language_server_result(method: &str, result: &Value) -> bool {
    match method {
        "workspace/configuration" | "workspace/workspaceFolders" => {
            matches!(result, Value::Array(_))
        }
        "window/workDoneProgress/create"
        | "client/registerCapability"
        | "client/unregisterCapability"
        | "workspace/diagnostic/refresh" => matches!(result, Value::Nil),
        _ => false,
    }
}

fn bounded_protocol_json(value: &Value, max_encoded_bytes: usize) -> bool {
    let mut nodes = 0;
    if !matches!(value, Value::Map(_) | Value::Array(_))
        || !json_value_within_bounds(
            value,
            0,
            &mut nodes,
            LanguageProtocolOperationV1::MAX_PARAMS_DEPTH,
            LanguageProtocolOperationV1::MAX_PARAMS_NODES,
        )
    {
        return false;
    }
    messagepack::encode(
        value,
        Limits {
            max_encoded_bytes,
            max_depth: LanguageProtocolOperationV1::MAX_PARAMS_DEPTH,
            max_nodes: LanguageProtocolOperationV1::MAX_PARAMS_NODES,
            max_collection_items: 4096,
            max_scalar_bytes: max_encoded_bytes,
        },
    )
    .is_ok_and(|encoded| encoded.len() <= max_encoded_bytes)
}

/// A principal delegated by Core's validated ServerAuth middleware. The host
/// socket still authenticates the Core process and the request frame fence; this
/// value is accepted only as an out-of-body authenticated envelope field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthenticatedPrincipalV1 {
    ServerAuth { subject: String },
}

/// Narrow authenticated request metadata for RepoIntel reads. The IDs bind to
/// existing owners; HostKernel resolves the registered Location and current
/// policy and never treats this metadata as a root or read-scope grant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthenticatedRequestContextV1 {
    RepoRead {
        session_id: String,
        location_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RpcOutcomeV1 {
    Ok,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcResponseV1 {
    pub owner_epoch: u64,
    pub process_incarnation: String,
    pub request_id: String,
    pub outcome: RpcOutcomeV1,
    pub owner_cursor: Option<CursorV1>,
    pub receipt_digest: Option<String>,
    pub body: Option<Value>,
    pub error: Option<TypedErrorV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcEventV1 {
    pub owner_epoch: u64,
    pub process_incarnation: String,
    pub subscription_id: String,
    pub cursor: CursorV1,
    pub event_type: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RpcControlV1 {
    Subscribe {
        owner_epoch: u64,
        process_incarnation: String,
        subscription_id: String,
        owner_kind: String,
        owner_id: String,
        after: Option<CursorV1>,
    },
    Unsubscribe {
        owner_epoch: u64,
        process_incarnation: String,
        subscription_id: String,
    },
    Ack {
        owner_epoch: u64,
        process_incarnation: String,
        subscription_id: String,
        through: CursorV1,
    },
    /// Server-to-client page boundary. The cursor is the last acknowledged event,
    /// including the requested cursor for an empty page.
    PageEnd {
        owner_epoch: u64,
        process_incarnation: String,
        subscription_id: String,
        through: CursorV1,
        has_more: bool,
    },
    /// The requested cursor is no longer represented by retained owner history.
    /// The client must obtain a fresh owner snapshot before resuming.
    ResnapshotRequired {
        owner_epoch: u64,
        process_incarnation: String,
        subscription_id: String,
        requested: CursorV1,
        latest: CursorV1,
    },
    CancelRequest {
        owner_epoch: u64,
        process_incarnation: String,
        request_id: String,
    },
    Ping {
        owner_epoch: u64,
        process_incarnation: String,
        nonce: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RpcMessageV1 {
    Hello(Box<KernelHelloV1>),
    HelloResult(Box<KernelHelloResultV1>),
    HelloRejected(Box<KernelHelloRejectedV1>),
    StartupStatus(Box<KernelStartupStatusV1>),
    Request(Box<RpcRequestV1>),
    AuthenticatedRequest {
        request: Box<RpcRequestV1>,
        principal: AuthenticatedPrincipalV1,
        context: Option<AuthenticatedRequestContextV1>,
    },
    Response(Box<RpcResponseV1>),
    Event(Box<RpcEventV1>),
    Control(Box<RpcControlV1>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError(pub ProtocolErrorKind);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProtocolErrorKind {
    MessagePack(messagepack::ErrorKind),
    Frame,
    InvalidField {
        field: &'static str,
        reason: &'static str,
    },
    MissingField {
        field: &'static str,
    },
    UnsupportedKind,
    UnsupportedProtocol {
        protocol: u64,
    },
    TransportIncompatible,
    DeadlineExceeded,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            ProtocolErrorKind::MessagePack(kind) => {
                write!(formatter, "invalid RPC MessagePack: {kind:?}")
            }
            ProtocolErrorKind::Frame => formatter.write_str("invalid RPC frame"),
            ProtocolErrorKind::InvalidField { field, reason } => {
                write!(formatter, "invalid RPC field {field}: {reason}")
            }
            ProtocolErrorKind::MissingField { field } => {
                write!(formatter, "missing RPC field {field}")
            }
            ProtocolErrorKind::UnsupportedKind => {
                formatter.write_str("unsupported RPC message kind")
            }
            ProtocolErrorKind::UnsupportedProtocol { protocol } => {
                write!(formatter, "unsupported RPC protocol {protocol}")
            }
            ProtocolErrorKind::TransportIncompatible => {
                formatter.write_str("kernel RPC peers have no compatible protocol/features")
            }
            ProtocolErrorKind::DeadlineExceeded => {
                formatter.write_str("RPC deadline is expired or too distant")
            }
        }
    }
}

impl Error for ProtocolError {}

impl From<messagepack::MessagePackError> for ProtocolError {
    fn from(error: messagepack::MessagePackError) -> Self {
        Self(ProtocolErrorKind::MessagePack(error.0))
    }
}

impl From<FrameError> for ProtocolError {
    fn from(_: FrameError) -> Self {
        Self(ProtocolErrorKind::Frame)
    }
}

fn invalid(field: &'static str, reason: &'static str) -> ProtocolError {
    ProtocolError(ProtocolErrorKind::InvalidField { field, reason })
}
fn validate_frame_metadata(
    owner_epoch: u64,
    process_incarnation: &str,
) -> Result<(), ProtocolError> {
    if owner_epoch == 0 {
        return Err(invalid("ownerEpoch", "must be a positive owner epoch"));
    }
    validate_safe_integer("ownerEpoch", owner_epoch)?;
    text(
        "processIncarnation",
        process_incarnation,
        MAX_IDENTIFIER_BYTES,
    )
}

fn missing(field: &'static str) -> ProtocolError {
    ProtocolError(ProtocolErrorKind::MissingField { field })
}

/// Encodes one protocol message as a bounded MessagePack payload.
pub fn encode_message(message: &RpcMessageV1) -> Result<Vec<u8>, ProtocolError> {
    validate_message(message)?;
    let value = message_to_value(message);
    let encoded = messagepack::encode(&value, FRAME_LIMITS)?;
    if encoded.len() > MAX_PAYLOAD_SIZE || encoded.len() + 4 > MAX_FRAME_SIZE {
        return Err(invalid("frame", "encoded payload exceeds the frame limit"));
    }
    Ok(encoded)
}

/// Decodes one typed protocol message, rejecting malformed fields and trailing bytes.
pub fn decode_message(payload: &[u8]) -> Result<RpcMessageV1, ProtocolError> {
    if payload.len() > MAX_PAYLOAD_SIZE {
        return Err(invalid("frame", "payload exceeds the frame limit"));
    }
    let value = messagepack::decode(payload, FRAME_LIMITS)?;
    let message = value_to_message(value)?;
    validate_message(&message)?;
    Ok(message)
}

/// Reads one framed message; clean EOF before a new frame is `Ok(None)`.
pub fn read_message<R: Read>(reader: &mut R) -> Result<Option<RpcMessageV1>, ProtocolError> {
    let Some(payload) = transport::read_frame(reader)? else {
        return Ok(None);
    };
    decode_message(&payload).map(Some)
}

/// Writes one bounded framed message. On partial I/O failure the channel must be dropped.
pub fn write_message<W: Write>(
    writer: &mut W,
    message: &RpcMessageV1,
) -> Result<(), ProtocolError> {
    let payload = encode_message(message)?;
    transport::write_frame(writer, &payload)?;
    Ok(())
}

fn control_metadata(control: &RpcControlV1) -> (u64, &str) {
    match control {
        RpcControlV1::Subscribe {
            owner_epoch,
            process_incarnation,
            ..
        }
        | RpcControlV1::Unsubscribe {
            owner_epoch,
            process_incarnation,
            ..
        }
        | RpcControlV1::Ack {
            owner_epoch,
            process_incarnation,
            ..
        }
        | RpcControlV1::PageEnd {
            owner_epoch,
            process_incarnation,
            ..
        }
        | RpcControlV1::ResnapshotRequired {
            owner_epoch,
            process_incarnation,
            ..
        }
        | RpcControlV1::CancelRequest {
            owner_epoch,
            process_incarnation,
            ..
        }
        | RpcControlV1::Ping {
            owner_epoch,
            process_incarnation,
            ..
        } => (*owner_epoch, process_incarnation),
    }
}

fn frame_fence_metadata(message: &RpcMessageV1) -> Option<(u64, &str)> {
    match message {
        RpcMessageV1::Request(request) | RpcMessageV1::AuthenticatedRequest { request, .. } => {
            Some((request.owner_epoch, &request.process_incarnation))
        }
        RpcMessageV1::Response(response) => {
            Some((response.owner_epoch, &response.process_incarnation))
        }
        RpcMessageV1::Event(event) => Some((event.owner_epoch, &event.process_incarnation)),
        RpcMessageV1::Control(control) => Some(control_metadata(control)),
        RpcMessageV1::Hello(_)
        | RpcMessageV1::HelloResult(_)
        | RpcMessageV1::HelloRejected(_)
        | RpcMessageV1::StartupStatus(_) => None,
    }
}

/// The negotiated frame-fencing pair for one authenticated kernel session.
///
/// `owner_epoch` is the positive durable epoch from `HandshakePolicy.owner_epoch`;
/// `process_incarnation` is the authenticated hello binding echoed by the negotiated
/// `KernelHelloResultV1`. Application frames carrying any other pair fail closed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameFence {
    owner_epoch: u64,
    process_incarnation: String,
}

impl FrameFence {
    /// Fails closed unless the pair is a positive safe epoch and a bounded identifier.
    pub fn new(
        owner_epoch: u64,
        process_incarnation: impl Into<String>,
    ) -> Result<Self, ProtocolError> {
        let process_incarnation = process_incarnation.into();
        validate_frame_metadata(owner_epoch, &process_incarnation)?;
        Ok(Self {
            owner_epoch,
            process_incarnation,
        })
    }

    pub fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }

    pub fn process_incarnation(&self) -> &str {
        &self.process_incarnation
    }

    /// Validates one frame-metadata pair, failing closed on any difference from the
    /// negotiated fence.
    pub fn validate_frame(
        &self,
        owner_epoch: u64,
        process_incarnation: &str,
    ) -> Result<(), ProtocolError> {
        validate_frame_metadata(owner_epoch, process_incarnation)?;
        if owner_epoch != self.owner_epoch {
            return Err(invalid(
                "ownerEpoch",
                "does not match the negotiated session fence",
            ));
        }
        if process_incarnation != self.process_incarnation {
            return Err(invalid(
                "processIncarnation",
                "does not match the negotiated session fence",
            ));
        }
        Ok(())
    }

    /// Validates a whole message: full wire-shape validation followed by exact fence
    /// matching for every application frame that carries fencing metadata.
    pub fn validate_message(&self, message: &RpcMessageV1) -> Result<(), ProtocolError> {
        validate_message(message)?;
        match frame_fence_metadata(message) {
            Some((owner_epoch, process_incarnation)) => {
                self.validate_frame(owner_epoch, process_incarnation)
            }
            None => Ok(()),
        }
    }
}

pub(crate) fn validate_message(message: &RpcMessageV1) -> Result<(), ProtocolError> {
    match message {
        RpcMessageV1::Hello(hello) => validate_hello(hello),
        RpcMessageV1::HelloResult(result) => validate_hello_result(result),
        RpcMessageV1::HelloRejected(rejected) => {
            text(
                "supervisorNonce",
                &rejected.supervisor_nonce,
                MAX_IDENTIFIER_BYTES,
            )?;
            text(
                "processIncarnation",
                &rejected.process_incarnation,
                MAX_IDENTIFIER_BYTES,
            )?;
            validate_typed_error(&rejected.error)
        }
        RpcMessageV1::StartupStatus(status) => match status.as_ref() {
            KernelStartupStatusV1::Starting | KernelStartupStatusV1::Ready => Ok(()),
            KernelStartupStatusV1::Failed(error) => validate_typed_error(error),
        },
        RpcMessageV1::Request(request) | RpcMessageV1::AuthenticatedRequest { request, .. } => {
            validate_frame_metadata(request.owner_epoch, &request.process_incarnation)?;
            text("requestId", &request.request_id, MAX_IDENTIFIER_BYTES)?;
            text("serviceId", &request.service_id, MAX_IDENTIFIER_BYTES)?;
            text("operation", &request.operation, MAX_IDENTIFIER_BYTES)?;
            if let Some(delivery_id) = &request.delivery_id {
                text("deliveryId", delivery_id, MAX_IDENTIFIER_BYTES)?;
            }
            if let Some(cursor) = &request.expected_cursor {
                validate_cursor(cursor)?;
            }
            text("traceId", &request.trace_id, MAX_IDENTIFIER_BYTES)?;
            validate_safe_integer("deadlineUnixMs", request.deadline_unix_ms)?;
            validate_value_bound("body", &request.body, MAX_BODY_BYTES)?;
            if let RpcMessageV1::AuthenticatedRequest {
                principal, context, ..
            } = message
            {
                match principal {
                    AuthenticatedPrincipalV1::ServerAuth { subject } => {
                        text(
                            "authenticatedPrincipal.subject",
                            subject,
                            MAX_IDENTIFIER_BYTES,
                        )?;
                        if subject.chars().any(char::is_control) {
                            return Err(invalid(
                                "authenticatedPrincipal.subject",
                                "must not contain control characters",
                            ));
                        }
                    }
                }
                if let Some(context) = context {
                    validate_authenticated_request_context(context)?;
                }
            }
            Ok(())
        }
        RpcMessageV1::Response(response) => {
            validate_frame_metadata(response.owner_epoch, &response.process_incarnation)?;
            text("requestId", &response.request_id, MAX_IDENTIFIER_BYTES)?;
            match response.outcome {
                RpcOutcomeV1::Ok if response.error.is_some() => {
                    return Err(invalid("error", "success response cannot contain an error"));
                }
                RpcOutcomeV1::Ok
                    if response.owner_cursor.is_some() != response.receipt_digest.is_some() =>
                {
                    return Err(invalid(
                        "receiptDigest",
                        "owner cursor and receipt digest must be present together",
                    ));
                }
                RpcOutcomeV1::Error
                    if response.error.is_none()
                        || response.body.is_some()
                        || response.owner_cursor.is_some()
                        || response.receipt_digest.is_some() =>
                {
                    return Err(invalid(
                        "outcome",
                        "error response must contain only a typed error",
                    ));
                }
                _ => {}
            }
            if let Some(cursor) = &response.owner_cursor {
                validate_cursor(cursor)?;
            }
            if let Some(digest) = &response.receipt_digest {
                validate_digest("receiptDigest", digest)?;
            }
            if let Some(body) = &response.body {
                validate_value_bound("body", body, MAX_BODY_BYTES)?;
            }
            if let Some(error) = &response.error {
                validate_typed_error(error)?;
            }
            Ok(())
        }
        RpcMessageV1::Event(event) => {
            validate_frame_metadata(event.owner_epoch, &event.process_incarnation)?;
            text(
                "subscriptionId",
                &event.subscription_id,
                MAX_IDENTIFIER_BYTES,
            )?;
            validate_cursor(&event.cursor)?;
            text("eventType", &event.event_type, MAX_IDENTIFIER_BYTES)?;
            validate_value_bound("payload", &event.payload, MAX_EVENT_PAYLOAD_BYTES)
        }
        RpcMessageV1::Control(control) => {
            let (owner_epoch, process_incarnation) = control_metadata(control);
            validate_frame_metadata(owner_epoch, process_incarnation)?;
            match control.as_ref() {
                RpcControlV1::Subscribe {
                    subscription_id,
                    owner_kind,
                    owner_id,
                    after,
                    ..
                } => {
                    text("subscriptionId", subscription_id, MAX_IDENTIFIER_BYTES)?;
                    text("ownerKind", owner_kind, MAX_IDENTIFIER_BYTES)?;
                    text("ownerId", owner_id, MAX_IDENTIFIER_BYTES)?;
                    if let Some(cursor) = after {
                        validate_cursor(cursor)?;
                        if cursor.owner_kind != *owner_kind || cursor.owner_id != *owner_id {
                            return Err(invalid(
                                "after",
                                "subscription cursor must belong to the requested owner",
                            ));
                        }
                    }
                    Ok(())
                }
                RpcControlV1::Unsubscribe {
                    subscription_id, ..
                } => text("subscriptionId", subscription_id, MAX_IDENTIFIER_BYTES),
                RpcControlV1::Ack {
                    subscription_id,
                    through,
                    ..
                } => {
                    text("subscriptionId", subscription_id, MAX_IDENTIFIER_BYTES)?;
                    validate_cursor(through)
                }
                RpcControlV1::PageEnd {
                    subscription_id,
                    through,
                    ..
                } => {
                    text("subscriptionId", subscription_id, MAX_IDENTIFIER_BYTES)?;
                    validate_cursor(through)
                }
                RpcControlV1::ResnapshotRequired {
                    subscription_id,
                    requested,
                    latest,
                    ..
                } => {
                    text("subscriptionId", subscription_id, MAX_IDENTIFIER_BYTES)?;
                    validate_cursor(requested)?;
                    validate_cursor(latest)?;
                    if requested.owner_kind != latest.owner_kind
                        || requested.owner_id != latest.owner_id
                    {
                        return Err(invalid(
                            "latest",
                            "resnapshot cursors must belong to the same owner",
                        ));
                    }
                    Ok(())
                }
                RpcControlV1::CancelRequest { request_id, .. } => {
                    text("requestId", request_id, MAX_IDENTIFIER_BYTES)
                }
                RpcControlV1::Ping { nonce, .. } => text("nonce", nonce, MAX_IDENTIFIER_BYTES),
            }
        }
    }
}

fn validate_authenticated_request_context(
    context: &AuthenticatedRequestContextV1,
) -> Result<(), ProtocolError> {
    match context {
        AuthenticatedRequestContextV1::RepoRead {
            session_id,
            location_id,
        } => {
            text(
                "authenticatedContext.sessionID",
                session_id,
                MAX_IDENTIFIER_BYTES,
            )?;
            if !session_id.starts_with("ses_") || session_id.chars().any(char::is_control) {
                return Err(invalid(
                    "authenticatedContext.sessionID",
                    "must be a bounded Session ID",
                ));
            }
            text(
                "authenticatedContext.locationID",
                location_id,
                MAX_IDENTIFIER_BYTES,
            )?;
            if location_id.len() != 68
                || !location_id.starts_with("loc_")
                || !location_id[4..]
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(invalid(
                    "authenticatedContext.locationID",
                    "must be a registered Location ID",
                ));
            }
            Ok(())
        }
    }
}

fn validate_hello(hello: &KernelHelloV1) -> Result<(), ProtocolError> {
    if hello.min_protocol == 0 || hello.min_protocol > hello.max_protocol {
        return Err(invalid(
            "protocolRange",
            "minimum must be nonzero and no greater than maximum",
        ));
    }
    validate_digest("hostBuildDigest", &hello.host_build_digest)?;
    if let Some(digest) = &hello.kernel_build_digest {
        validate_digest("kernelBuildDigest", digest)?;
    }
    text(
        "hostInstanceId",
        &hello.host_instance_id,
        MAX_IDENTIFIER_BYTES,
    )?;
    text(
        "processIncarnation",
        &hello.process_incarnation,
        MAX_IDENTIFIER_BYTES,
    )?;
    text(
        "supervisorNonce",
        &hello.supervisor_nonce,
        MAX_IDENTIFIER_BYTES,
    )?;
    validate_features("requiredFeatures", &hello.required_features)?;
    validate_features("optionalFeatures", &hello.optional_features)?;
    let required: BTreeSet<&str> = hello.required_features.iter().map(String::as_str).collect();
    if hello
        .optional_features
        .iter()
        .any(|feature| required.contains(feature.as_str()))
    {
        return Err(invalid(
            "features",
            "required and optional feature sets overlap",
        ));
    }
    Ok(())
}

fn validate_hello_result(result: &KernelHelloResultV1) -> Result<(), ProtocolError> {
    if result.protocol != PROTOCOL_V1 {
        return Err(ProtocolError(ProtocolErrorKind::UnsupportedProtocol {
            protocol: result.protocol as u64,
        }));
    }
    validate_features("enabledFeatures", &result.enabled_features)?;
    validate_features(
        "unavailableOptionalFeatures",
        &result.unavailable_optional_features,
    )?;
    if result
        .enabled_features
        .iter()
        .any(|feature| result.unavailable_optional_features.contains(feature))
    {
        return Err(invalid(
            "features",
            "enabled and unavailable optional feature sets overlap",
        ));
    }
    text(
        "supervisorNonce",
        &result.supervisor_nonce,
        MAX_IDENTIFIER_BYTES,
    )?;
    text(
        "processIncarnation",
        &result.process_incarnation,
        MAX_IDENTIFIER_BYTES,
    )?;
    if result.owner_epoch == 0 || result.owner_epoch > MAX_SAFE_INTEGER {
        return Err(invalid("ownerEpoch", "must be a positive safe integer"));
    }
    Ok(())
}

fn validate_features(field: &'static str, features: &[String]) -> Result<(), ProtocolError> {
    if features.len() > MAX_FEATURE_COUNT {
        return Err(invalid(field, "feature count exceeds the limit"));
    }
    let mut unique = BTreeSet::new();
    for feature in features {
        text(field, feature, MAX_IDENTIFIER_BYTES)?;
        if !unique.insert(feature) {
            return Err(invalid(field, "feature names must be unique"));
        }
    }
    Ok(())
}

fn validate_cursor(cursor: &CursorV1) -> Result<(), ProtocolError> {
    text("cursor.ownerKind", &cursor.owner_kind, MAX_IDENTIFIER_BYTES)?;
    text("cursor.ownerId", &cursor.owner_id, MAX_IDENTIFIER_BYTES)?;
    validate_decimal("cursor.seq", &cursor.seq)?;
    validate_digest("cursor.eventDigest", &cursor.event_digest)
}

fn validate_artifact_ref(reference: &ArtifactRefV1) -> Result<(), ProtocolError> {
    text(
        "artifactRef.artifactId",
        &reference.artifact_id,
        MAX_IDENTIFIER_BYTES,
    )?;
    validate_digest("artifactRef.digest", &reference.digest)?;
    validate_decimal("artifactRef.byteLength", &reference.byte_length)?;
    text(
        "artifactRef.mediaType",
        &reference.media_type,
        MAX_IDENTIFIER_BYTES,
    )?;
    Ok(())
}

fn validate_typed_error(error: &TypedErrorV1) -> Result<(), ProtocolError> {
    text("error.code", &error.code, MAX_IDENTIFIER_BYTES)?;
    text("error.message", &error.message, MAX_ERROR_BYTES)?;
    if let Some(retry_after_ms) = error.retry_after_ms {
        validate_safe_integer("error.retryAfterMs", retry_after_ms)?;
    }
    if error.subject_ids.len() > MAX_SUBJECT_IDS {
        return Err(invalid(
            "error.subjectIds",
            "subject count exceeds the limit",
        ));
    }
    for subject_id in &error.subject_ids {
        text("error.subjectIds", subject_id, MAX_IDENTIFIER_BYTES)?;
    }
    if let Some(cursor) = &error.owner_cursor {
        validate_cursor(cursor)?;
    }
    if let Some(reference) = &error.details {
        validate_artifact_ref(reference)?;
    }
    let value = typed_error_to_value(error);
    validate_value_bound("error", &value, MAX_ERROR_BYTES)
}

fn validate_value_bound(
    field: &'static str,
    value: &Value,
    max_bytes: usize,
) -> Result<(), ProtocolError> {
    let limits = Limits {
        max_encoded_bytes: max_bytes,
        ..FRAME_LIMITS
    };
    messagepack::encoded_len(value, limits)
        .map(|_| ())
        .map_err(|error| match error.0 {
            messagepack::ErrorKind::InputTooLarge { .. } => {
                invalid(field, "encoded value exceeds the byte limit")
            }
            other => ProtocolError(ProtocolErrorKind::MessagePack(other)),
        })
}

fn text(field: &'static str, value: &str, max_bytes: usize) -> Result<(), ProtocolError> {
    if value.is_empty() || value.len() > max_bytes || value.contains('\0') {
        return Err(invalid(
            field,
            "must be nonempty, NUL-free, and within the byte limit",
        ));
    }
    Ok(())
}

fn validate_safe_integer(field: &'static str, value: u64) -> Result<(), ProtocolError> {
    if value > MAX_SAFE_INTEGER {
        return Err(invalid(
            field,
            "must be an exactly representable JavaScript safe integer",
        ));
    }
    Ok(())
}

fn validate_digest(field: &'static str, digest: &str) -> Result<(), ProtocolError> {
    let Some(hex) = digest.strip_prefix("blake3:") else {
        return Err(invalid(field, "must use the blake3: digest form"));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(
            field,
            "must contain exactly 64 lowercase hexadecimal digits",
        ));
    }
    Ok(())
}

fn validate_decimal(field: &'static str, value: &str) -> Result<(), ProtocolError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || value.parse::<u64>().is_err()
    {
        return Err(invalid(
            field,
            "must be a canonical unsigned 64-bit decimal string",
        ));
    }
    Ok(())
}

/// Validates an absolute Unix-millisecond deadline against the trusted operation class.
/// The class must come from the operation registry, never from the RPC caller.
pub fn validate_deadline(
    deadline_unix_ms: u64,
    now_unix_ms: u64,
    durable_managed: bool,
) -> Result<(), ProtocolError> {
    validate_safe_integer("nowUnixMs", now_unix_ms)?;
    validate_safe_integer("deadlineUnixMs", deadline_unix_ms)?;
    let max_ahead = if durable_managed {
        MAX_DEADLINE_DURABLE_MS
    } else {
        MAX_DEADLINE_INTERACTIVE_MS
    };
    let latest = now_unix_ms
        .checked_add(max_ahead)
        .ok_or(ProtocolError(ProtocolErrorKind::DeadlineExceeded))?;
    if deadline_unix_ms <= now_unix_ms || deadline_unix_ms > latest {
        return Err(ProtocolError(ProtocolErrorKind::DeadlineExceeded));
    }
    Ok(())
}

/// Locally trusted protocol/feature policy for hello negotiation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandshakePolicy {
    pub min_protocol: u16,
    pub max_protocol: u16,
    pub supported_features: BTreeSet<String>,
    pub expected_supervisor_nonce: String,
    pub expected_host_process_incarnation: Option<String>,
    pub owner_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NegotiatedProtocol {
    pub protocol: u16,
    pub enabled_features: Vec<String>,
    pub unavailable_optional_features: Vec<String>,
}

/// Negotiates a host's `KernelHelloV1` against trusted kernel capabilities.
/// This validates the nonce binding but is not OS identity verification or channel
/// authentication; callers must authenticate the pipe/socket peer separately.
pub fn negotiate_hello(
    hello: &KernelHelloV1,
    policy: &HandshakePolicy,
) -> Result<NegotiatedProtocol, ProtocolError> {
    validate_hello(hello)?;
    if policy.min_protocol == 0
        || policy.min_protocol > policy.max_protocol
        || policy.owner_epoch == 0
        || policy.owner_epoch > MAX_SAFE_INTEGER
        || hello.supervisor_nonce != policy.expected_supervisor_nonce
        || policy
            .expected_host_process_incarnation
            .as_ref()
            .is_none_or(|expected| expected != &hello.process_incarnation)
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    if PROTOCOL_V1 < policy.min_protocol
        || PROTOCOL_V1 > policy.max_protocol
        || PROTOCOL_V1 < hello.min_protocol
        || PROTOCOL_V1 > hello.max_protocol
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    if hello
        .required_features
        .iter()
        .any(|feature| !policy.supported_features.contains(feature))
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    let enabled_features = hello
        .required_features
        .iter()
        .chain(hello.optional_features.iter())
        .filter(|feature| policy.supported_features.contains(*feature))
        .cloned()
        .collect();
    let unavailable_optional_features = hello
        .optional_features
        .iter()
        .filter(|feature| !policy.supported_features.contains(*feature))
        .cloned()
        .collect();

    Ok(NegotiatedProtocol {
        protocol: PROTOCOL_V1,
        enabled_features,
        unavailable_optional_features,
    })
}

/// Binds a negotiation result to the exact host hello that initiated the handshake.
/// This is protocol binding only; callers must separately authenticate the OS peer.
pub fn validate_hello_result_binding(
    hello: &KernelHelloV1,
    result: &KernelHelloResultV1,
) -> Result<(), ProtocolError> {
    validate_hello(hello)?;
    validate_hello_result(result)?;
    if result.protocol < hello.min_protocol || result.protocol > hello.max_protocol {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }
    if result.supervisor_nonce != hello.supervisor_nonce
        || result.process_incarnation != hello.process_incarnation
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    let expected_enabled: Vec<&String> = hello
        .required_features
        .iter()
        .chain(hello.optional_features.iter())
        .filter(|feature| {
            result
                .enabled_features
                .iter()
                .any(|enabled| enabled == *feature)
        })
        .collect();
    let actual_enabled: Vec<&String> = result.enabled_features.iter().collect();
    if expected_enabled != actual_enabled
        || hello
            .required_features
            .iter()
            .any(|required| !result.enabled_features.contains(required))
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    let expected_unavailable: Vec<&String> = hello
        .optional_features
        .iter()
        .filter(|optional| !result.enabled_features.contains(optional))
        .collect();
    let actual_unavailable: Vec<&String> = result.unavailable_optional_features.iter().collect();
    if expected_unavailable != actual_unavailable {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }
    Ok(())
}

/// Creates the host-visible success response from a trusted negotiation result.
pub fn hello_result_for(
    hello: &KernelHelloV1,
    negotiated: &NegotiatedProtocol,
    owner_epoch: u64,
) -> Result<KernelHelloResultV1, ProtocolError> {
    let result = KernelHelloResultV1 {
        protocol: negotiated.protocol,
        enabled_features: negotiated.enabled_features.clone(),
        unavailable_optional_features: negotiated.unavailable_optional_features.clone(),
        supervisor_nonce: hello.supervisor_nonce.clone(),
        process_incarnation: hello.process_incarnation.clone(),
        owner_epoch,
    };
    validate_hello_result_binding(hello, &result)?;
    Ok(result)
}

/// Validates a service body using an owner-declared byte cap, lowered to the global
/// request/response limit. The cap must come from the trusted operation registry.
pub fn validate_operation_body(body: &Value, owner_max_bytes: usize) -> Result<(), ProtocolError> {
    validate_value_bound("body", body, owner_max_bytes.min(MAX_BODY_BYTES))
}

/// Produces canonical MessagePack body bytes for an owner payload digest after
/// operation-schema normalization. Never substitute the original frame byte slice.
pub fn canonical_body_bytes(
    body: &Value,
    owner_max_bytes: usize,
) -> Result<Vec<u8>, ProtocolError> {
    let limits = Limits {
        max_encoded_bytes: owner_max_bytes.min(MAX_BODY_BYTES),
        ..FRAME_LIMITS
    };
    messagepack::encode(body, limits).map_err(Into::into)
}

/// Applies the stricter chunk-body ceiling for the dedicated artifact-transfer
/// operation. Artifact ownership, offsets, totals, digest and authorization are
/// validated by the ArtifactService and are deliberately not inferred here.
pub fn validate_artifact_chunk_body(body: &Value) -> Result<(), ProtocolError> {
    validate_value_bound("body", body, MAX_ARTIFACT_CHUNK_BODY_BYTES)
}

fn message_to_value(message: &RpcMessageV1) -> Value {
    let mut map = BTreeMap::new();
    match message {
        RpcMessageV1::Hello(hello) => {
            put(&mut map, "kind", string("hello"));
            put(&mut map, "minProtocol", number(hello.min_protocol as u64));
            put(&mut map, "maxProtocol", number(hello.max_protocol as u64));
            put(
                &mut map,
                "hostBuildDigest",
                string(&hello.host_build_digest),
            );
            put_optional(
                &mut map,
                "kernelBuildDigest",
                hello.kernel_build_digest.as_deref().map(string),
            );
            put(&mut map, "hostInstanceId", string(&hello.host_instance_id));
            put(
                &mut map,
                "processIncarnation",
                string(&hello.process_incarnation),
            );
            put(&mut map, "supervisorNonce", string(&hello.supervisor_nonce));
            put(
                &mut map,
                "requiredFeatures",
                strings(&hello.required_features),
            );
            put(
                &mut map,
                "optionalFeatures",
                strings(&hello.optional_features),
            );
        }
        RpcMessageV1::HelloResult(result) => {
            put(&mut map, "kind", string("hello_result"));
            put(&mut map, "protocol", number(result.protocol as u64));
            put(
                &mut map,
                "enabledFeatures",
                strings(&result.enabled_features),
            );
            put(
                &mut map,
                "unavailableOptionalFeatures",
                strings(&result.unavailable_optional_features),
            );
            put(
                &mut map,
                "supervisorNonce",
                string(&result.supervisor_nonce),
            );
            put(
                &mut map,
                "processIncarnation",
                string(&result.process_incarnation),
            );
            put(&mut map, "ownerEpoch", number(result.owner_epoch));
        }
        RpcMessageV1::HelloRejected(rejected) => {
            put(&mut map, "kind", string("hello_rejected"));
            put(
                &mut map,
                "supervisorNonce",
                string(&rejected.supervisor_nonce),
            );
            put(
                &mut map,
                "processIncarnation",
                string(&rejected.process_incarnation),
            );
            put(&mut map, "error", typed_error_to_value(&rejected.error));
        }
        RpcMessageV1::StartupStatus(status) => {
            put(&mut map, "kind", string("startup_status"));
            put(&mut map, "protocol", number(PROTOCOL_V1 as u64));
            match status.as_ref() {
                KernelStartupStatusV1::Starting => {
                    put(&mut map, "state", string("STARTING"));
                }
                KernelStartupStatusV1::Ready => {
                    put(&mut map, "state", string("READY"));
                }
                KernelStartupStatusV1::Failed(error) => {
                    put(&mut map, "state", string("FAILED"));
                    put(&mut map, "error", typed_error_to_value(error));
                }
            }
        }
        RpcMessageV1::Request(request) | RpcMessageV1::AuthenticatedRequest { request, .. } => {
            put(&mut map, "kind", string("request"));
            put(&mut map, "protocol", number(PROTOCOL_V1 as u64));
            put(&mut map, "ownerEpoch", number(request.owner_epoch));
            put(
                &mut map,
                "processIncarnation",
                string(&request.process_incarnation),
            );
            put(&mut map, "requestId", string(&request.request_id));
            put(&mut map, "serviceId", string(&request.service_id));
            put(&mut map, "operation", string(&request.operation));
            put_optional(
                &mut map,
                "deliveryId",
                request.delivery_id.as_deref().map(string),
            );
            put_optional(
                &mut map,
                "expectedCursor",
                request.expected_cursor.as_ref().map(cursor_to_value),
            );
            put(&mut map, "deadlineUnixMs", number(request.deadline_unix_ms));
            put(&mut map, "traceId", string(&request.trace_id));
            put(&mut map, "body", request.body.clone());
            if let RpcMessageV1::AuthenticatedRequest { principal, .. } = message {
                match principal {
                    AuthenticatedPrincipalV1::ServerAuth { subject } => put(
                        &mut map,
                        "authenticatedPrincipal",
                        Value::Map(BTreeMap::from([
                            ("kind".to_owned(), string("server_auth")),
                            ("subject".to_owned(), string(subject)),
                        ])),
                    ),
                }
            }
            if let RpcMessageV1::AuthenticatedRequest {
                context: Some(context),
                ..
            } = message
            {
                put(
                    &mut map,
                    "authenticatedContext",
                    authenticated_context_to_value(context),
                );
            }
        }
        RpcMessageV1::Response(response) => {
            put(&mut map, "kind", string("response"));
            put(&mut map, "protocol", number(PROTOCOL_V1 as u64));
            put(&mut map, "ownerEpoch", number(response.owner_epoch));
            put(
                &mut map,
                "processIncarnation",
                string(&response.process_incarnation),
            );
            put(&mut map, "requestId", string(&response.request_id));
            put(
                &mut map,
                "outcome",
                string(match response.outcome {
                    RpcOutcomeV1::Ok => "ok",
                    RpcOutcomeV1::Error => "error",
                }),
            );
            put_optional(
                &mut map,
                "ownerCursor",
                response.owner_cursor.as_ref().map(cursor_to_value),
            );
            put_optional(
                &mut map,
                "receiptDigest",
                response.receipt_digest.as_deref().map(string),
            );
            put_optional(&mut map, "body", response.body.clone());
            put_optional(
                &mut map,
                "error",
                response.error.as_ref().map(typed_error_to_value),
            );
        }
        RpcMessageV1::Event(event) => {
            put(&mut map, "kind", string("event"));
            put(&mut map, "protocol", number(PROTOCOL_V1 as u64));
            put(&mut map, "ownerEpoch", number(event.owner_epoch));
            put(
                &mut map,
                "processIncarnation",
                string(&event.process_incarnation),
            );
            put(&mut map, "subscriptionId", string(&event.subscription_id));
            put(&mut map, "cursor", cursor_to_value(&event.cursor));
            put(&mut map, "eventType", string(&event.event_type));
            put(&mut map, "payload", event.payload.clone());
        }
        RpcMessageV1::Control(control) => match control.as_ref() {
            RpcControlV1::Subscribe {
                owner_epoch,
                process_incarnation,
                subscription_id,
                owner_kind,
                owner_id,
                after,
                ..
            } => {
                put(&mut map, "kind", string("subscribe"));
                put(&mut map, "ownerEpoch", number(*owner_epoch));
                put(&mut map, "processIncarnation", string(process_incarnation));
                put(&mut map, "subscriptionId", string(subscription_id));
                put(&mut map, "ownerKind", string(owner_kind));
                put(&mut map, "ownerId", string(owner_id));
                put_optional(&mut map, "after", after.as_ref().map(cursor_to_value));
            }
            RpcControlV1::Unsubscribe {
                owner_epoch,
                process_incarnation,
                subscription_id,
                ..
            } => {
                put(&mut map, "kind", string("unsubscribe"));
                put(&mut map, "ownerEpoch", number(*owner_epoch));
                put(&mut map, "processIncarnation", string(process_incarnation));
                put(&mut map, "subscriptionId", string(subscription_id));
            }
            RpcControlV1::Ack {
                owner_epoch,
                process_incarnation,
                subscription_id,
                through,
                ..
            } => {
                put(&mut map, "kind", string("ack"));
                put(&mut map, "ownerEpoch", number(*owner_epoch));
                put(&mut map, "processIncarnation", string(process_incarnation));
                put(&mut map, "subscriptionId", string(subscription_id));
                put(&mut map, "through", cursor_to_value(through));
            }
            RpcControlV1::PageEnd {
                owner_epoch,
                process_incarnation,
                subscription_id,
                through,
                has_more,
                ..
            } => {
                put(&mut map, "kind", string("page_end"));
                put(&mut map, "ownerEpoch", number(*owner_epoch));
                put(&mut map, "processIncarnation", string(process_incarnation));
                put(&mut map, "subscriptionId", string(subscription_id));
                put(&mut map, "through", cursor_to_value(through));
                put(&mut map, "hasMore", Value::Bool(*has_more));
            }
            RpcControlV1::ResnapshotRequired {
                owner_epoch,
                process_incarnation,
                subscription_id,
                requested,
                latest,
                ..
            } => {
                put(&mut map, "kind", string("resnapshot_required"));
                put(&mut map, "ownerEpoch", number(*owner_epoch));
                put(&mut map, "processIncarnation", string(process_incarnation));
                put(&mut map, "subscriptionId", string(subscription_id));
                put(&mut map, "requested", cursor_to_value(requested));
                put(&mut map, "latest", cursor_to_value(latest));
            }
            RpcControlV1::CancelRequest {
                owner_epoch,
                process_incarnation,
                request_id,
                ..
            } => {
                put(&mut map, "kind", string("cancel_request"));
                put(&mut map, "ownerEpoch", number(*owner_epoch));
                put(&mut map, "processIncarnation", string(process_incarnation));
                put(&mut map, "requestId", string(request_id));
            }
            RpcControlV1::Ping {
                owner_epoch,
                process_incarnation,
                nonce,
                ..
            } => {
                put(&mut map, "kind", string("ping"));
                put(&mut map, "ownerEpoch", number(*owner_epoch));
                put(&mut map, "processIncarnation", string(process_incarnation));
                put(&mut map, "nonce", string(nonce));
            }
        },
    }
    Value::Map(map)
}

fn value_to_message(value: Value) -> Result<RpcMessageV1, ProtocolError> {
    let mut map = into_map(value, "message")?;
    let kind = take_string(&mut map, "kind", MAX_IDENTIFIER_BYTES)?;
    match kind.as_str() {
        "hello" => Ok(RpcMessageV1::Hello(Box::new(KernelHelloV1 {
            min_protocol: take_u16(&mut map, "minProtocol")?,
            max_protocol: take_u16(&mut map, "maxProtocol")?,
            host_build_digest: take_string(&mut map, "hostBuildDigest", MAX_IDENTIFIER_BYTES)?,
            kernel_build_digest: take_optional_string(
                &mut map,
                "kernelBuildDigest",
                MAX_IDENTIFIER_BYTES,
            )?,
            host_instance_id: take_string(&mut map, "hostInstanceId", MAX_IDENTIFIER_BYTES)?,
            process_incarnation: take_string(&mut map, "processIncarnation", MAX_IDENTIFIER_BYTES)?,
            supervisor_nonce: take_string(&mut map, "supervisorNonce", MAX_IDENTIFIER_BYTES)?,
            required_features: take_strings(&mut map, "requiredFeatures", MAX_FEATURE_COUNT)?,
            optional_features: take_strings(&mut map, "optionalFeatures", MAX_FEATURE_COUNT)?,
        }))),
        "hello_result" => {
            take_protocol(&mut map)?;
            Ok(RpcMessageV1::HelloResult(Box::new(KernelHelloResultV1 {
                protocol: PROTOCOL_V1,
                enabled_features: take_strings(&mut map, "enabledFeatures", MAX_FEATURE_COUNT)?,
                unavailable_optional_features: take_strings(
                    &mut map,
                    "unavailableOptionalFeatures",
                    MAX_FEATURE_COUNT,
                )?,
                supervisor_nonce: take_string(&mut map, "supervisorNonce", MAX_IDENTIFIER_BYTES)?,
                process_incarnation: take_string(
                    &mut map,
                    "processIncarnation",
                    MAX_IDENTIFIER_BYTES,
                )?,
                owner_epoch: take_u64(&mut map, "ownerEpoch")?,
            })))
        }
        "hello_rejected" => Ok(RpcMessageV1::HelloRejected(Box::new(
            KernelHelloRejectedV1 {
                supervisor_nonce: take_string(&mut map, "supervisorNonce", MAX_IDENTIFIER_BYTES)?,
                process_incarnation: take_string(
                    &mut map,
                    "processIncarnation",
                    MAX_IDENTIFIER_BYTES,
                )?,
                error: value_to_typed_error(take_required(&mut map, "error")?)?,
            },
        ))),
        "startup_status" => {
            take_protocol(&mut map)?;
            let state = take_string(&mut map, "state", 16)?;
            let error = take_optional(&mut map, "error")?;
            let status = match (state.as_str(), error) {
                ("STARTING", None) => KernelStartupStatusV1::Starting,
                ("READY", None) => KernelStartupStatusV1::Ready,
                ("FAILED", Some(error)) => {
                    KernelStartupStatusV1::Failed(Box::new(value_to_typed_error(error)?))
                }
                ("STARTING" | "READY", Some(_)) => {
                    return Err(invalid("error", "only FAILED startup status has an error"));
                }
                ("FAILED", None) => {
                    return Err(missing("error"));
                }
                _ => return Err(invalid("state", "unknown startup status")),
            };
            Ok(RpcMessageV1::StartupStatus(Box::new(status)))
        }
        "request" => {
            take_protocol(&mut map)?;
            let owner_epoch = take_u64(&mut map, "ownerEpoch")?;
            let process_incarnation =
                take_string(&mut map, "processIncarnation", MAX_IDENTIFIER_BYTES)?;
            validate_frame_metadata(owner_epoch, &process_incarnation)?;
            let request = Box::new(RpcRequestV1 {
                owner_epoch,
                process_incarnation,
                request_id: take_string(&mut map, "requestId", MAX_IDENTIFIER_BYTES)?,
                service_id: take_string(&mut map, "serviceId", MAX_IDENTIFIER_BYTES)?,
                operation: take_string(&mut map, "operation", MAX_IDENTIFIER_BYTES)?,
                delivery_id: take_optional_string(&mut map, "deliveryId", MAX_IDENTIFIER_BYTES)?,
                expected_cursor: take_optional(&mut map, "expectedCursor")?
                    .map(value_to_cursor)
                    .transpose()?,
                deadline_unix_ms: take_u64(&mut map, "deadlineUnixMs")?,
                trace_id: take_string(&mut map, "traceId", MAX_IDENTIFIER_BYTES)?,
                body: take_required(&mut map, "body")?,
            });
            let context = take_optional(&mut map, "authenticatedContext")?
                .map(value_to_authenticated_context)
                .transpose()?;
            match take_optional(&mut map, "authenticatedPrincipal")? {
                None if context.is_none() => Ok(RpcMessageV1::Request(request)),
                None => Err(invalid(
                    "authenticatedContext",
                    "requires an authenticated principal",
                )),
                Some(value) => {
                    let mut fields = into_map(value, "authenticatedPrincipal")?;
                    if fields.len() != 2 || fields.len() != fields.keys().count() {
                        return Err(invalid("authenticatedPrincipal", "has an invalid shape"));
                    }
                    let kind = take_string(&mut fields, "kind", 32)?;
                    let principal = match kind.as_str() {
                        "server_auth" => AuthenticatedPrincipalV1::ServerAuth {
                            subject: take_string(&mut fields, "subject", MAX_IDENTIFIER_BYTES)?,
                        },
                        _ => return Err(invalid("authenticatedPrincipal.kind", "is unsupported")),
                    };
                    if !fields.is_empty() {
                        return Err(invalid("authenticatedPrincipal", "has unknown fields"));
                    }
                    Ok(RpcMessageV1::AuthenticatedRequest {
                        request,
                        principal,
                        context,
                    })
                }
            }
        }
        "response" => {
            take_protocol(&mut map)?;
            let owner_epoch = take_u64(&mut map, "ownerEpoch")?;
            let process_incarnation =
                take_string(&mut map, "processIncarnation", MAX_IDENTIFIER_BYTES)?;
            validate_frame_metadata(owner_epoch, &process_incarnation)?;
            let request_id = take_string(&mut map, "requestId", MAX_IDENTIFIER_BYTES)?;
            let outcome = match take_string(&mut map, "outcome", 16)?.as_str() {
                "ok" => RpcOutcomeV1::Ok,
                "error" => RpcOutcomeV1::Error,
                _ => return Err(invalid("outcome", "must be `ok` or `error`")),
            };
            Ok(RpcMessageV1::Response(Box::new(RpcResponseV1 {
                owner_epoch,
                process_incarnation,
                request_id,
                outcome,
                owner_cursor: take_optional(&mut map, "ownerCursor")?
                    .map(value_to_cursor)
                    .transpose()?,
                receipt_digest: take_optional_string(
                    &mut map,
                    "receiptDigest",
                    MAX_IDENTIFIER_BYTES,
                )?,
                body: take_optional(&mut map, "body")?,
                error: take_optional(&mut map, "error")?
                    .map(value_to_typed_error)
                    .transpose()?,
            })))
        }
        "event" => {
            take_protocol(&mut map)?;
            let owner_epoch = take_u64(&mut map, "ownerEpoch")?;
            let process_incarnation =
                take_string(&mut map, "processIncarnation", MAX_IDENTIFIER_BYTES)?;
            validate_frame_metadata(owner_epoch, &process_incarnation)?;
            Ok(RpcMessageV1::Event(Box::new(RpcEventV1 {
                owner_epoch,
                process_incarnation,
                subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
                cursor: value_to_cursor(take_required(&mut map, "cursor")?)?,
                event_type: take_string(&mut map, "eventType", MAX_IDENTIFIER_BYTES)?,
                payload: take_required(&mut map, "payload")?,
            })))
        }
        "subscribe" => {
            let (owner_epoch, process_incarnation) = take_frame_fence(&mut map)?;
            Ok(RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
                owner_epoch,
                process_incarnation,
                subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
                owner_kind: take_string(&mut map, "ownerKind", MAX_IDENTIFIER_BYTES)?,
                owner_id: take_string(&mut map, "ownerId", MAX_IDENTIFIER_BYTES)?,
                after: take_optional(&mut map, "after")?
                    .map(value_to_cursor)
                    .transpose()?,
            })))
        }
        "unsubscribe" => {
            let (owner_epoch, process_incarnation) = take_frame_fence(&mut map)?;
            Ok(RpcMessageV1::Control(Box::new(RpcControlV1::Unsubscribe {
                owner_epoch,
                process_incarnation,
                subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
            })))
        }
        "ack" => {
            let (owner_epoch, process_incarnation) = take_frame_fence(&mut map)?;
            Ok(RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
                owner_epoch,
                process_incarnation,
                subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
                through: value_to_cursor(take_required(&mut map, "through")?)?,
            })))
        }
        "page_end" => {
            let (owner_epoch, process_incarnation) = take_frame_fence(&mut map)?;
            Ok(RpcMessageV1::Control(Box::new(RpcControlV1::PageEnd {
                owner_epoch,
                process_incarnation,
                subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
                through: value_to_cursor(take_required(&mut map, "through")?)?,
                has_more: take_bool(&mut map, "hasMore")?,
            })))
        }
        "resnapshot_required" => {
            let (owner_epoch, process_incarnation) = take_frame_fence(&mut map)?;
            Ok(RpcMessageV1::Control(Box::new(
                RpcControlV1::ResnapshotRequired {
                    owner_epoch,
                    process_incarnation,
                    subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
                    requested: value_to_cursor(take_required(&mut map, "requested")?)?,
                    latest: value_to_cursor(take_required(&mut map, "latest")?)?,
                },
            )))
        }
        "cancel_request" => {
            let (owner_epoch, process_incarnation) = take_frame_fence(&mut map)?;
            Ok(RpcMessageV1::Control(Box::new(
                RpcControlV1::CancelRequest {
                    owner_epoch,
                    process_incarnation,
                    request_id: take_string(&mut map, "requestId", MAX_IDENTIFIER_BYTES)?,
                },
            )))
        }
        "ping" => {
            let (owner_epoch, process_incarnation) = take_frame_fence(&mut map)?;
            Ok(RpcMessageV1::Control(Box::new(RpcControlV1::Ping {
                owner_epoch,
                process_incarnation,
                nonce: take_string(&mut map, "nonce", MAX_IDENTIFIER_BYTES)?,
            })))
        }
        _ => Err(ProtocolError(ProtocolErrorKind::UnsupportedKind)),
    }
}

fn cursor_to_value(cursor: &CursorV1) -> Value {
    let mut map = BTreeMap::new();
    put(&mut map, "ownerKind", string(&cursor.owner_kind));
    put(&mut map, "ownerId", string(&cursor.owner_id));
    put(&mut map, "seq", string(&cursor.seq));
    put(&mut map, "eventDigest", string(&cursor.event_digest));
    Value::Map(map)
}

fn authenticated_context_to_value(context: &AuthenticatedRequestContextV1) -> Value {
    match context {
        AuthenticatedRequestContextV1::RepoRead {
            session_id,
            location_id,
        } => Value::Map(BTreeMap::from([
            ("kind".to_owned(), string("repo_read")),
            ("sessionID".to_owned(), string(session_id)),
            ("locationID".to_owned(), string(location_id)),
        ])),
    }
}

fn value_to_authenticated_context(
    value: Value,
) -> Result<AuthenticatedRequestContextV1, ProtocolError> {
    let mut fields = into_map(value, "authenticatedContext")?;
    if fields.len() != 3 {
        return Err(invalid("authenticatedContext", "has an invalid shape"));
    }
    let kind = take_string(&mut fields, "kind", 32)?;
    let context = match kind.as_str() {
        "repo_read" => AuthenticatedRequestContextV1::RepoRead {
            session_id: take_string(&mut fields, "sessionID", MAX_IDENTIFIER_BYTES)?,
            location_id: take_string(&mut fields, "locationID", MAX_IDENTIFIER_BYTES)?,
        },
        _ => return Err(invalid("authenticatedContext.kind", "is unsupported")),
    };
    if !fields.is_empty() {
        return Err(invalid("authenticatedContext", "has unknown fields"));
    }
    validate_authenticated_request_context(&context)?;
    Ok(context)
}

fn value_to_cursor(value: Value) -> Result<CursorV1, ProtocolError> {
    let mut map = into_map(value, "cursor")?;
    Ok(CursorV1 {
        owner_kind: take_string(&mut map, "ownerKind", MAX_IDENTIFIER_BYTES)?,
        owner_id: take_string(&mut map, "ownerId", MAX_IDENTIFIER_BYTES)?,
        seq: take_string(&mut map, "seq", 20)?,
        event_digest: take_string(&mut map, "eventDigest", MAX_IDENTIFIER_BYTES)?,
    })
}

fn artifact_ref_to_value(reference: &ArtifactRefV1) -> Value {
    let mut map = BTreeMap::new();
    put(&mut map, "artifactId", string(&reference.artifact_id));
    put(&mut map, "digest", string(&reference.digest));
    put(&mut map, "byteLength", string(&reference.byte_length));
    put(&mut map, "mediaType", string(&reference.media_type));
    put(
        &mut map,
        "classification",
        string(match reference.classification {
            ArtifactClassificationV1::Public => "public",
            ArtifactClassificationV1::Workspace => "workspace",
            ArtifactClassificationV1::Sensitive => "sensitive",
        }),
    );
    Value::Map(map)
}

fn value_to_artifact_ref(value: Value) -> Result<ArtifactRefV1, ProtocolError> {
    let mut map = into_map(value, "artifactRef")?;
    let classification = match take_string(&mut map, "classification", 32)?.as_str() {
        "public" => ArtifactClassificationV1::Public,
        "workspace" => ArtifactClassificationV1::Workspace,
        "sensitive" => ArtifactClassificationV1::Sensitive,
        _ => {
            return Err(invalid(
                "artifactRef.classification",
                "unknown classification",
            ));
        }
    };
    Ok(ArtifactRefV1 {
        artifact_id: take_string(&mut map, "artifactId", MAX_IDENTIFIER_BYTES)?,
        digest: take_string(&mut map, "digest", MAX_IDENTIFIER_BYTES)?,
        byte_length: take_string(&mut map, "byteLength", 20)?,
        media_type: take_string(&mut map, "mediaType", MAX_IDENTIFIER_BYTES)?,
        classification,
    })
}

fn typed_error_to_value(error: &TypedErrorV1) -> Value {
    let mut map = BTreeMap::new();
    put(&mut map, "code", string(&error.code));
    put(
        &mut map,
        "category",
        string(category_to_str(error.category)),
    );
    put(&mut map, "message", string(&error.message));
    put(
        &mut map,
        "retryClass",
        string(retry_class_to_str(error.retry_class)),
    );
    put_optional(&mut map, "retryAfterMs", error.retry_after_ms.map(number));
    put_optional(
        &mut map,
        "ownerCursor",
        error.owner_cursor.as_ref().map(cursor_to_value),
    );
    put(&mut map, "subjectIds", strings(&error.subject_ids));
    put_optional(
        &mut map,
        "details",
        error.details.as_ref().map(artifact_ref_to_value),
    );
    Value::Map(map)
}

fn value_to_typed_error(value: Value) -> Result<TypedErrorV1, ProtocolError> {
    let mut map = into_map(value, "error")?;
    let category = match take_string(&mut map, "category", 32)?.as_str() {
        "validation" => ErrorCategoryV1::Validation,
        "conflict" => ErrorCategoryV1::Conflict,
        "authorization" => ErrorCategoryV1::Authorization,
        "capability" => ErrorCategoryV1::Capability,
        "not_found" => ErrorCategoryV1::NotFound,
        "unavailable" => ErrorCategoryV1::Unavailable,
        "deadline" => ErrorCategoryV1::Deadline,
        "uncertain" => ErrorCategoryV1::Uncertain,
        "corruption" => ErrorCategoryV1::Corruption,
        "internal" => ErrorCategoryV1::Internal,
        _ => return Err(invalid("error.category", "unknown error category")),
    };
    let retry_class = match take_string(&mut map, "retryClass", 40)?.as_str() {
        "NEVER" => RetryClassV1::Never,
        "SAFE_QUERY_RETRY" => RetryClassV1::SafeQueryRetry,
        "RETRY_AFTER_RECONCILIATION" => RetryClassV1::RetryAfterReconciliation,
        "RETRY_AFTER_CONTEXT_RECOVERY" => RetryClassV1::RetryAfterContextRecovery,
        "USER_ACTION_REQUIRED" => RetryClassV1::UserActionRequired,
        "RETRY_WITH_NEW_ID" => RetryClassV1::RetryWithNewId,
        _ => return Err(invalid("error.retryClass", "unknown retry class")),
    };
    Ok(TypedErrorV1 {
        code: take_string(&mut map, "code", MAX_IDENTIFIER_BYTES)?,
        category,
        message: take_string(&mut map, "message", MAX_ERROR_BYTES)?,
        retry_class,
        retry_after_ms: take_optional(&mut map, "retryAfterMs")?
            .map(value_to_u64)
            .transpose()?,
        owner_cursor: take_optional(&mut map, "ownerCursor")?
            .map(value_to_cursor)
            .transpose()?,
        subject_ids: take_strings(&mut map, "subjectIds", MAX_SUBJECT_IDS)?,
        details: take_optional(&mut map, "details")?
            .map(value_to_artifact_ref)
            .transpose()?,
    })
}

fn category_to_str(category: ErrorCategoryV1) -> &'static str {
    match category {
        ErrorCategoryV1::Validation => "validation",
        ErrorCategoryV1::Conflict => "conflict",
        ErrorCategoryV1::Authorization => "authorization",
        ErrorCategoryV1::Capability => "capability",
        ErrorCategoryV1::NotFound => "not_found",
        ErrorCategoryV1::Unavailable => "unavailable",
        ErrorCategoryV1::Deadline => "deadline",
        ErrorCategoryV1::Uncertain => "uncertain",
        ErrorCategoryV1::Corruption => "corruption",
        ErrorCategoryV1::Internal => "internal",
    }
}

fn retry_class_to_str(retry_class: RetryClassV1) -> &'static str {
    match retry_class {
        RetryClassV1::Never => "NEVER",
        RetryClassV1::SafeQueryRetry => "SAFE_QUERY_RETRY",
        RetryClassV1::RetryAfterReconciliation => "RETRY_AFTER_RECONCILIATION",
        RetryClassV1::RetryAfterContextRecovery => "RETRY_AFTER_CONTEXT_RECOVERY",
        RetryClassV1::UserActionRequired => "USER_ACTION_REQUIRED",
        RetryClassV1::RetryWithNewId => "RETRY_WITH_NEW_ID",
    }
}

fn put(map: &mut BTreeMap<String, Value>, key: &str, value: Value) {
    map.insert(key.to_owned(), value);
}

fn put_optional(map: &mut BTreeMap<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        put(map, key, value);
    }
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn number(value: u64) -> Value {
    Value::Unsigned(value)
}

fn strings(values: &[String]) -> Value {
    Value::Array(values.iter().map(|value| string(value)).collect())
}

fn into_map(value: Value, field: &'static str) -> Result<BTreeMap<String, Value>, ProtocolError> {
    match value {
        Value::Map(map) => Ok(map),
        _ => Err(invalid(field, "must be a MessagePack map")),
    }
}

fn take_required(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Value, ProtocolError> {
    map.remove(field).ok_or_else(|| missing(field))
}

fn take_optional(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<Value>, ProtocolError> {
    Ok(map.remove(field))
}

fn take_string(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
    max: usize,
) -> Result<String, ProtocolError> {
    let value = match take_required(map, field)? {
        Value::String(value) => value,
        _ => return Err(invalid(field, "must be a string")),
    };
    text(field, &value, max)?;
    Ok(value)
}

fn take_optional_string(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
    max: usize,
) -> Result<Option<String>, ProtocolError> {
    take_optional(map, field)?
        .map(|value| match value {
            Value::String(value) => {
                text(field, &value, max)?;
                Ok(value)
            }
            _ => Err(invalid(field, "must be a string when present")),
        })
        .transpose()
}

fn take_u64(map: &mut BTreeMap<String, Value>, field: &'static str) -> Result<u64, ProtocolError> {
    value_to_u64(take_required(map, field)?)
        .map_err(|_| invalid(field, "must be an unsigned integer"))
}

fn take_frame_fence(map: &mut BTreeMap<String, Value>) -> Result<(u64, String), ProtocolError> {
    let owner_epoch = take_u64(map, "ownerEpoch")?;
    let process_incarnation = take_string(map, "processIncarnation", MAX_IDENTIFIER_BYTES)?;
    validate_frame_metadata(owner_epoch, &process_incarnation)?;
    Ok((owner_epoch, process_incarnation))
}

fn take_bool(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
) -> Result<bool, ProtocolError> {
    match take_required(map, field)? {
        Value::Bool(value) => Ok(value),
        _ => Err(invalid(field, "must be a boolean")),
    }
}

fn value_to_u64(value: Value) -> Result<u64, ProtocolError> {
    match value {
        Value::Unsigned(value) => Ok(value),
        Value::Signed(value) if value >= 0 => Ok(value as u64),
        _ => Err(invalid("integer", "must be an unsigned integer")),
    }
}

fn take_u16(map: &mut BTreeMap<String, Value>, field: &'static str) -> Result<u16, ProtocolError> {
    u16::try_from(take_u64(map, field)?).map_err(|_| invalid(field, "exceeds u16 range"))
}

fn take_strings(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
    max_items: usize,
) -> Result<Vec<String>, ProtocolError> {
    let values = match take_required(map, field)? {
        Value::Array(values) => values,
        _ => return Err(invalid(field, "must be an array")),
    };
    if values.len() > max_items {
        return Err(invalid(field, "array exceeds the item limit"));
    }
    values
        .into_iter()
        .map(|value| match value {
            Value::String(value) => {
                text(field, &value, MAX_IDENTIFIER_BYTES)?;
                Ok(value)
            }
            _ => Err(invalid(field, "array entries must be strings")),
        })
        .collect()
}

fn take_protocol(map: &mut BTreeMap<String, Value>) -> Result<(), ProtocolError> {
    let protocol = take_u64(map, "protocol")?;
    if protocol != PROTOCOL_V1 as u64 {
        return Err(ProtocolError(ProtocolErrorKind::UnsupportedProtocol {
            protocol,
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn json_to_value(value: serde_json::Value) -> Value {
        match value {
            serde_json::Value::Null => Value::Nil,
            serde_json::Value::Bool(value) => Value::Bool(value),
            serde_json::Value::Number(value) if value.is_u64() => {
                Value::Unsigned(value.as_u64().unwrap())
            }
            serde_json::Value::Number(value) if value.is_i64() => {
                Value::Signed(value.as_i64().unwrap())
            }
            serde_json::Value::Number(value) => Value::Float(value.as_f64().unwrap().to_bits()),
            serde_json::Value::String(value) => Value::String(value),
            serde_json::Value::Array(values) => {
                Value::Array(values.into_iter().map(json_to_value).collect())
            }
            serde_json::Value::Object(values) => Value::Map(
                values
                    .into_iter()
                    .map(|(key, value)| (key, json_to_value(value)))
                    .collect(),
            ),
        }
    }

    const DIGEST: &str = "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn hello(required: &[&str], optional: &[&str]) -> KernelHelloV1 {
        KernelHelloV1 {
            min_protocol: 1,
            max_protocol: 2,
            host_build_digest: DIGEST.to_owned(),
            kernel_build_digest: None,
            host_instance_id: "host-1".to_owned(),
            process_incarnation: "inc-1".to_owned(),
            supervisor_nonce: "nonce-1".to_owned(),
            required_features: required.iter().map(|value| (*value).to_owned()).collect(),
            optional_features: optional.iter().map(|value| (*value).to_owned()).collect(),
        }
    }

    fn cursor() -> CursorV1 {
        CursorV1 {
            owner_kind: "thread".to_owned(),
            owner_id: "thr_1".to_owned(),
            seq: "42".to_owned(),
            event_digest: DIGEST.to_owned(),
        }
    }

    fn delegation_binding() -> DelegationBindingV1 {
        DelegationBindingV1 {
            run_id: "run-1".to_owned(),
            task_id: "task-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            parent_execution_id: "exec-parent-1".to_owned(),
            child_execution_id: "exec-child-1".to_owned(),
            accepted_spec_digest: format!("blake3:{}", "a".repeat(64)),
            profile_id: "profile-review-1".to_owned(),
            profile_revision: 9_007_199_254_740_993,
            profile_digest: format!("blake3:{}", "b".repeat(64)),
            criteria_ids: vec!["criterion-a".to_owned(), "criterion-b".to_owned()],
            workspace_lease_id: "workspace-lease-1".to_owned(),
            source_revision: format!("blake3:{}", "c".repeat(64)),
            capability_ceiling_digest: format!("sha256:{}", "d".repeat(64)),
            context_selection_digest: format!("blake3:{}", "e".repeat(64)),
            budget_lease_id: "budget-lease-1".to_owned(),
            resource_lease_ids: vec!["resource-lease-a".to_owned(), "resource-lease-b".to_owned()],
            owner_epoch: 9_007_199_254_740_995,
            admitted_managed_revision: 9_007_199_254_740_997,
        }
    }

    #[test]
    fn delegation_binding_matches_shared_golden_and_preserves_large_counters() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/delegation-binding-v1.json"))
                .unwrap();
        let binding = delegation_binding();
        let wire = binding.to_value();
        assert_eq!(
            DelegationBindingV1::from_value(&wire),
            Some(binding.clone())
        );
        let Value::Map(fields) = &wire else {
            unreachable!()
        };
        assert_eq!(
            fields.get("ownerEpoch"),
            Some(&Value::String("9007199254740995".into()))
        );
        assert_eq!(
            fields.get("admittedManagedRevision"),
            Some(&Value::String("9007199254740997".into()))
        );
        assert_eq!(
            binding.digest().unwrap(),
            fixture["canonicalBindingDigest"].as_str().unwrap(),
        );
        assert_eq!(fixture["binding"]["ownerEpoch"], "9007199254740995");
        assert_eq!(fixture["binding"]["profileRevision"], "9007199254740993");
        assert_eq!(
            DelegationBindingV1::from_json_value(&fixture["binding"]),
            Some(binding.clone())
        );
        assert_eq!(binding.to_json_value().unwrap(), fixture["binding"]);
    }

    #[test]
    fn delegation_binding_rejects_forged_stale_or_noncanonical_authority() {
        let original = delegation_binding().to_value();
        let Value::Map(fields) = original else {
            unreachable!()
        };
        let mut tampered = fields.clone();
        tampered.insert(
            "ownerEpoch".into(),
            Value::String("09007199254740995".into()),
        );
        assert!(DelegationBindingV1::from_value(&Value::Map(tampered)).is_none());
        let mut tampered = fields.clone();
        tampered.insert(
            "admittedManagedRevision".into(),
            Value::String("18446744073709551616".into()),
        );
        assert!(DelegationBindingV1::from_value(&Value::Map(tampered)).is_none());
        let mut tampered = fields.clone();
        tampered.insert(
            "criteriaIDs".into(),
            Value::Array(vec![
                Value::String("criterion-b".into()),
                Value::String("criterion-a".into()),
            ]),
        );
        assert!(DelegationBindingV1::from_value(&Value::Map(tampered)).is_none());
        let mut tampered = fields.clone();
        tampered.insert(
            "resourceLeaseIDs".into(),
            Value::Array(vec![
                Value::String("resource-lease-a".into()),
                Value::String("resource-lease-a".into()),
            ]),
        );
        assert!(DelegationBindingV1::from_value(&Value::Map(tampered)).is_none());
        let mut tampered = fields.clone();
        tampered.insert(
            "childExecutionID".into(),
            Value::String("exec-parent-1".into()),
        );
        assert!(DelegationBindingV1::from_value(&Value::Map(tampered)).is_none());
        let mut tampered = fields.clone();
        tampered.insert(
            "profileID".into(),
            Value::String("p".repeat(MAX_IDENTIFIER_BYTES + 1)),
        );
        assert!(DelegationBindingV1::from_value(&Value::Map(tampered)).is_none());
        for key in ["acceptedSpecDigest", "profileDigest", "sourceRevision"] {
            let mut tampered = fields.clone();
            tampered.insert(
                key.into(),
                Value::String(format!("sha256:{}", "a".repeat(64))),
            );
            assert!(DelegationBindingV1::from_value(&Value::Map(tampered)).is_none());
        }
        let mut tampered = fields.clone();
        tampered.insert(
            "criteriaIDs".into(),
            Value::Array(vec![
                Value::String("criterion-a".into()),
                Value::String("criterion-a".into()),
            ]),
        );
        assert!(DelegationBindingV1::from_value(&Value::Map(tampered)).is_none());
        let mut tampered = fields;
        tampered.insert("principal".into(), Value::String("reviewer-forged".into()));
        assert!(DelegationBindingV1::from_value(&Value::Map(tampered)).is_none());
    }

    #[test]
    fn managed_attempt_scope_has_exact_shape_and_stable_digest() {
        let scope = ManagedAttemptScopeV1 {
            goal_id: "goal-1".to_owned(),
            run_id: "run-1".to_owned(),
            task_id: "task-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            owner_epoch: 17,
            expected_managed_revision: 42,
            location_id: "loc-1".to_owned(),
            session_id: "ses-1".to_owned(),
            workspace_revision: format!("blake3:{}", "a".repeat(64)),
            delegation_binding_digest: format!("blake3:{}", "b".repeat(64)),
        };
        let wire = scope.to_value();
        assert_eq!(
            ManagedAttemptScopeV1::from_value(&wire),
            Some(scope.clone())
        );
        let digest = scope.digest().unwrap();
        assert!(digest.starts_with("blake3:"));
        assert_eq!(digest, scope.digest().unwrap());
    }

    #[test]
    fn managed_attempt_scope_rejects_extra_fields_and_noncanonical_types() {
        let scope = ManagedAttemptScopeV1 {
            goal_id: "goal-1".to_owned(),
            run_id: "run-1".to_owned(),
            task_id: "task-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            owner_epoch: 17,
            expected_managed_revision: 42,
            location_id: "loc-1".to_owned(),
            session_id: "ses-1".to_owned(),
            workspace_revision: format!("blake3:{}", "a".repeat(64)),
            delegation_binding_digest: format!("blake3:{}", "b".repeat(64)),
        };
        let Value::Map(mut fields) = scope.to_value() else {
            unreachable!()
        };
        fields.insert(
            "principal".to_owned(),
            Value::String("server_auth:forged".to_owned()),
        );
        assert!(ManagedAttemptScopeV1::from_value(&Value::Map(fields)).is_none());

        let Value::Map(mut fields) = scope.to_value() else {
            unreachable!()
        };
        fields.insert("ownerEpoch".to_owned(), Value::Unsigned(17));
        assert!(ManagedAttemptScopeV1::from_value(&Value::Map(fields)).is_none());

        let Value::Map(mut fields) = scope.to_value() else {
            unreachable!()
        };
        fields.insert("ownerEpoch".to_owned(), Value::String("017".to_owned()));
        assert!(ManagedAttemptScopeV1::from_value(&Value::Map(fields)).is_none());
    }

    #[test]
    fn direct_attempt_scope_is_exact_and_effect_scope_union_rejects_ambiguity() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let scope = DirectAttemptScopeV1 {
            attempt_id: "att_0123456789abcdef0123456789abcdef".to_owned(),
            parent_session_id: "ses_parent".to_owned(),
            child_session_id: "ses_child".to_owned(),
            owner_epoch: 17,
            expected_revision: 1,
            profile_id: "profile_builtin_coder".to_owned(),
            profile_revision: 3,
            profile_digest: format!("blake3:{}", "f".repeat(64)),
            location_id: "loc_1".to_owned(),
            workspace_id: "workspace_1".to_owned(),
            workspace_revision: DIGEST.to_owned(),
            capability_digest: digest.clone(),
            permissions_digest: digest.clone(),
            budget_digest: digest.clone(),
            scope_digest: digest,
        };
        let envelope = EffectAttemptScopeV1::Direct(scope.clone());
        let mut fields = BTreeMap::new();
        fields.insert(envelope.field_name().to_owned(), envelope.wire_value());
        assert_eq!(
            EffectAttemptScopeV1::from_fields(&fields),
            Some(EffectAttemptScopeV1::Direct(scope.clone()))
        );
        assert_eq!(scope.digest().unwrap(), envelope.digest().unwrap());
        assert_eq!(envelope.field_name(), "directAttempt");

        let mut malformed_scope = scope.to_value();
        let Value::Map(malformed_fields) = &mut malformed_scope else {
            unreachable!()
        };
        malformed_fields.insert(
            "profileRevision".to_owned(),
            Value::String("03".to_owned()),
        );
        assert!(DirectAttemptScopeV1::from_value(&malformed_scope).is_none());

        let mut malformed_scope = scope.to_value();
        let Value::Map(malformed_fields) = &mut malformed_scope else {
            unreachable!()
        };
        malformed_fields.insert(
            "profileDigest".to_owned(),
            Value::String(format!("sha256:{}", "f".repeat(64))),
        );
        assert!(DirectAttemptScopeV1::from_value(&malformed_scope).is_none());

        fields.insert(
            "managedAttempt".to_owned(),
            ManagedAttemptScopeV1 {
                goal_id: "goal".to_owned(),
                run_id: "run".to_owned(),
                task_id: "task".to_owned(),
                attempt_id: "attempt".to_owned(),
                owner_epoch: 17,
                expected_managed_revision: 1,
                location_id: "loc_1".to_owned(),
                session_id: "ses_child".to_owned(),
                workspace_revision: format!("blake3:{}", "a".repeat(64)),
                delegation_binding_digest: format!("blake3:{}", "b".repeat(64)),
            }
            .to_value(),
        );
        assert!(EffectAttemptScopeV1::from_fields(&fields).is_none());
    }

    fn wire_message(fields: BTreeMap<String, Value>) -> Vec<u8> {
        messagepack::encode(&Value::Map(fields), FRAME_LIMITS).unwrap()
    }

    fn protocol_error() -> TypedErrorV1 {
        TypedErrorV1 {
            code: "TRANSPORT_INCOMPATIBLE".to_owned(),
            category: ErrorCategoryV1::Capability,
            message: "required protocol feature is unavailable".to_owned(),
            retry_class: RetryClassV1::Never,
            retry_after_ms: None,
            owner_cursor: None,
            subject_ids: Vec::new(),
            details: None,
        }
    }

    fn hello_result() -> KernelHelloResultV1 {
        let host = hello(&["threads.v1"], &["memory.v1", "other.v1"]);
        let policy = HandshakePolicy {
            min_protocol: 1,
            max_protocol: 1,
            supported_features: BTreeSet::from(["threads.v1".to_owned(), "memory.v1".to_owned()]),
            expected_supervisor_nonce: "nonce-1".to_owned(),
            expected_host_process_incarnation: Some("inc-1".to_owned()),
            owner_epoch: 7,
        };
        let negotiated = negotiate_hello(&host, &policy).unwrap();
        hello_result_for(&host, &negotiated, policy.owner_epoch).unwrap()
    }

    #[test]
    fn accepts_hello_result_wire_message() {
        let wire = wire_message(BTreeMap::from([
            ("kind".to_owned(), string("hello_result")),
            ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
            (
                "enabledFeatures".to_owned(),
                Value::Array(vec![string("threads.v1")]),
            ),
            (
                "unavailableOptionalFeatures".to_owned(),
                Value::Array(vec![string("memory.v1")]),
            ),
            ("supervisorNonce".to_owned(), string("nonce-1")),
            ("processIncarnation".to_owned(), string("inc-1")),
            ("ownerEpoch".to_owned(), number(7)),
        ]));

        assert!(decode_message(&wire).is_ok());
    }

    #[test]
    fn accepts_typed_hello_rejection_wire_message() {
        let wire = wire_message(BTreeMap::from([
            ("kind".to_owned(), string("hello_rejected")),
            ("supervisorNonce".to_owned(), string("nonce-1")),
            ("processIncarnation".to_owned(), string("inc-1")),
            ("error".to_owned(), typed_error_to_value(&protocol_error())),
        ]));

        assert!(decode_message(&wire).is_ok());
    }

    #[test]
    fn accepts_startup_status_wire_variants() {
        for (state, error) in [
            ("STARTING", None),
            ("READY", None),
            ("FAILED", Some(typed_error_to_value(&protocol_error()))),
        ] {
            let mut fields = BTreeMap::from([
                ("kind".to_owned(), string("startup_status")),
                ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
                ("state".to_owned(), string(state)),
            ]);
            if let Some(error) = error {
                fields.insert("error".to_owned(), error);
            }
            assert!(decode_message(&wire_message(fields)).is_ok(), "{state}");
        }
    }

    #[test]
    fn handshake_messages_match_fixed_v1_wire_vectors() {
        let error = protocol_error();
        let messages = [
            (
                RpcMessageV1::HelloResult(Box::new(hello_result())),
                "87af656e61626c6564466561747572657392aa746872656164732e7631a96d656d6f72792e7631a46b696e64ac68656c6c6f5f726573756c74aa6f776e657245706f636807b270726f63657373496e6361726e6174696f6ea5696e632d31a870726f746f636f6c01af73757065727669736f724e6f6e6365a76e6f6e63652d31bb756e617661696c61626c654f7074696f6e616c466561747572657391a86f746865722e7631",
            ),
            (
                RpcMessageV1::HelloRejected(Box::new(KernelHelloRejectedV1 {
                    supervisor_nonce: "nonce-1".to_owned(),
                    process_incarnation: "inc-1".to_owned(),
                    error: error.clone(),
                })),
                "84a56572726f7285a863617465676f7279aa6361706162696c697479a4636f6465b65452414e53504f52545f494e434f4d50415449424c45a76d657373616765d92872657175697265642070726f746f636f6c206665617475726520697320756e617661696c61626c65aa7265747279436c617373a54e45564552aa7375626a65637449647390a46b696e64ae68656c6c6f5f72656a6563746564b270726f63657373496e6361726e6174696f6ea5696e632d31af73757065727669736f724e6f6e6365a76e6f6e63652d31",
            ),
            (
                RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Starting)),
                "83a46b696e64ae737461727475705f737461747573a870726f746f636f6c01a57374617465a85354415254494e47",
            ),
            (
                RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Ready)),
                "83a46b696e64ae737461727475705f737461747573a870726f746f636f6c01a57374617465a55245414459",
            ),
            (
                RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Failed(Box::new(
                    error,
                )))),
                "84a56572726f7285a863617465676f7279aa6361706162696c697479a4636f6465b65452414e53504f52545f494e434f4d50415449424c45a76d657373616765d92872657175697265642070726f746f636f6c206665617475726520697320756e617661696c61626c65aa7265747279436c617373a54e45564552aa7375626a65637449647390a46b696e64ae737461727475705f737461747573a870726f746f636f6c01a57374617465a64641494c4544",
            ),
        ];

        for (message, expected_hex) in messages {
            let expected = decode_hex(expected_hex);
            assert_eq!(encode_message(&message).unwrap(), expected);
            assert_eq!(decode_message(&expected).unwrap(), message);
        }
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        value
            .as_bytes()
            .chunks(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(pair, 16).unwrap()
            })
            .collect()
    }

    fn request(body: Value) -> RpcMessageV1 {
        RpcMessageV1::Request(Box::new(RpcRequestV1 {
            owner_epoch: 7,
            process_incarnation: "inc-1".to_owned(),
            request_id: "req_1".to_owned(),
            service_id: "thread".to_owned(),
            operation: "query".to_owned(),
            delivery_id: None,
            expected_cursor: Some(cursor()),
            deadline_unix_ms: 1_800_000_000_000,
            trace_id: "trace_1".to_owned(),
            body,
        }))
    }

    #[test]
    fn round_trips_all_message_families_and_framed_io() {
        let failure = protocol_error();
        let messages = [
            RpcMessageV1::Hello(Box::new(hello(&["threads.v1"], &["memory.v1"]))),
            RpcMessageV1::HelloResult(Box::new(hello_result())),
            RpcMessageV1::HelloRejected(Box::new(KernelHelloRejectedV1 {
                supervisor_nonce: "nonce-1".to_owned(),
                process_incarnation: "inc-1".to_owned(),
                error: failure.clone(),
            })),
            RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Starting)),
            RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Ready)),
            RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Failed(Box::new(failure)))),
            request(Value::Map(BTreeMap::from([(
                "input".to_owned(),
                Value::String("hello".to_owned()),
            )]))),
            RpcMessageV1::Response(Box::new(RpcResponseV1 {
                owner_epoch: 7,
                process_incarnation: "inc-1".to_owned(),
                request_id: "req_1".to_owned(),
                outcome: RpcOutcomeV1::Ok,
                owner_cursor: Some(cursor()),
                receipt_digest: Some(DIGEST.to_owned()),
                body: Some(Value::Bool(true)),
                error: None,
            })),
            RpcMessageV1::Response(Box::new(RpcResponseV1 {
                owner_epoch: 7,
                process_incarnation: "inc-1".to_owned(),
                request_id: "req_error".to_owned(),
                outcome: RpcOutcomeV1::Error,
                owner_cursor: None,
                receipt_digest: None,
                body: None,
                error: Some(TypedErrorV1 {
                    code: "STALE_CURSOR".to_owned(),
                    category: ErrorCategoryV1::Conflict,
                    message: "owner cursor changed".to_owned(),
                    retry_class: RetryClassV1::SafeQueryRetry,
                    retry_after_ms: None,
                    owner_cursor: Some(cursor()),
                    subject_ids: vec!["thr_1".to_owned()],
                    details: None,
                }),
            })),
            RpcMessageV1::Event(Box::new(RpcEventV1 {
                owner_epoch: 7,
                process_incarnation: "inc-1".to_owned(),
                subscription_id: "sub_1".to_owned(),
                cursor: cursor(),
                event_type: "thread/message_committed".to_owned(),
                payload: Value::Array(vec![Value::Unsigned(1)]),
            })),
            RpcMessageV1::Control(Box::new(RpcControlV1::CancelRequest {
                owner_epoch: 7,
                process_incarnation: "inc-1".to_owned(),
                request_id: "req_1".to_owned(),
            })),
        ];

        for message in messages {
            let encoded = encode_message(&message).unwrap();
            assert_eq!(decode_message(&encoded).unwrap(), message);
            let mut framed = Vec::new();
            write_message(&mut framed, &message).unwrap();
            assert_eq!(
                read_message(&mut Cursor::new(framed)).unwrap(),
                Some(message)
            );
        }
    }

    #[test]
    fn authenticated_server_principal_is_outside_request_body_and_round_trips() {
        let RpcMessageV1::Request(request) = request(Value::Map(BTreeMap::from([(
            "goalID".to_owned(),
            Value::String("goal-1".to_owned()),
        )]))) else {
            unreachable!()
        };
        let message = RpcMessageV1::AuthenticatedRequest {
            request,
            principal: AuthenticatedPrincipalV1::ServerAuth {
                subject: "reviewer@example.test".to_owned(),
            },
            context: Some(AuthenticatedRequestContextV1::RepoRead {
                session_id: "ses_01J9ABCDEF0123456789ABCDEFGH".to_owned(),
                location_id: format!("loc_{}", "a".repeat(64)),
            }),
        };
        let encoded = encode_message(&message).expect("trusted request encodes");
        let decoded = decode_message(&encoded).expect("trusted request decodes");
        assert_eq!(decoded, message);
        let RpcMessageV1::AuthenticatedRequest {
            request,
            principal,
            context,
        } = decoded
        else {
            panic!("authenticated identity must remain in the RPC envelope")
        };
        assert_eq!(
            request.body,
            Value::Map(BTreeMap::from([(
                "goalID".to_owned(),
                Value::String("goal-1".to_owned()),
            )]))
        );
        assert_eq!(
            principal,
            AuthenticatedPrincipalV1::ServerAuth {
                subject: "reviewer@example.test".to_owned()
            }
        );
        assert_eq!(
            context,
            Some(AuthenticatedRequestContextV1::RepoRead {
                session_id: "ses_01J9ABCDEF0123456789ABCDEFGH".to_owned(),
                location_id: format!("loc_{}", "a".repeat(64)),
            })
        );
    }

    #[test]
    fn authenticated_server_principal_rejects_empty_or_unbounded_subjects() {
        for subject in [String::new(), "x".repeat(MAX_IDENTIFIER_BYTES + 1)] {
            let RpcMessageV1::Request(request) = request(Value::Nil) else {
                unreachable!()
            };
            let message = RpcMessageV1::AuthenticatedRequest {
                request,
                principal: AuthenticatedPrincipalV1::ServerAuth { subject },
                context: None,
            };
            assert!(validate_message(&message).is_err());
        }
    }

    #[test]
    fn authenticated_repo_read_context_is_strict_and_outside_the_body() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/authenticated-request-context-v1.json"
        ))
        .unwrap();
        let fixture_value = json_to_value(fixture);
        let fixture_context = value_to_authenticated_context(fixture_value.clone()).unwrap();
        assert_eq!(
            authenticated_context_to_value(&fixture_context),
            fixture_value
        );

        let RpcMessageV1::Request(request_value) = request(Value::Nil) else {
            unreachable!()
        };
        let message = RpcMessageV1::AuthenticatedRequest {
            request: request_value,
            principal: AuthenticatedPrincipalV1::ServerAuth {
                subject: "reader".into(),
            },
            context: Some(AuthenticatedRequestContextV1::RepoRead {
                session_id: "ses_01J9ABCDEF0123456789ABCDEFGH".into(),
                location_id: format!("loc_{}", "0".repeat(64)),
            }),
        };
        let encoded = encode_message(&message).unwrap();
        assert_eq!(decode_message(&encoded).unwrap(), message);
        let RpcMessageV1::AuthenticatedRequest {
            request: request_value,
            ..
        } = &message
        else {
            unreachable!()
        };
        assert_eq!(request_value.body, Value::Nil);

        for context in [
            AuthenticatedRequestContextV1::RepoRead {
                session_id: "ses_\nforged".into(),
                location_id: format!("loc_{}", "0".repeat(64)),
            },
            AuthenticatedRequestContextV1::RepoRead {
                session_id: "ses_valid".into(),
                location_id: "loc_not-a-digest".into(),
            },
        ] {
            let RpcMessageV1::Request(request) = request(Value::Nil) else {
                unreachable!()
            };
            let invalid = RpcMessageV1::AuthenticatedRequest {
                request,
                principal: AuthenticatedPrincipalV1::ServerAuth {
                    subject: "reader".into(),
                },
                context: Some(context),
            };
            assert!(validate_message(&invalid).is_err());
        }

        let mut decoded_value = message_to_value(&message);
        let Value::Map(fields) = &mut decoded_value else {
            unreachable!()
        };
        fields.remove("authenticatedPrincipal");
        assert!(value_to_message(decoded_value).is_err());

        let mut unknown = authenticated_context_to_value(&fixture_context);
        let Value::Map(fields) = &mut unknown else {
            unreachable!()
        };
        fields.insert("principal".into(), Value::String("forged".into()));
        assert!(value_to_authenticated_context(unknown).is_err());
    }

    #[test]
    fn hello_result_binding_rejects_nonce_incarnation_and_feature_mismatches() {
        let host = hello(&["threads.v1"], &["memory.v1", "other.v1"]);
        let result = hello_result();
        assert!(validate_hello_result_binding(&host, &result).is_ok());

        let mut wrong_nonce = result.clone();
        wrong_nonce.supervisor_nonce = "other-nonce".to_owned();
        assert!(validate_hello_result_binding(&host, &wrong_nonce).is_err());

        let mut wrong_incarnation = result.clone();
        wrong_incarnation.process_incarnation = "other-incarnation".to_owned();
        assert!(validate_hello_result_binding(&host, &wrong_incarnation).is_err());

        let mut missing_required = result.clone();
        missing_required.enabled_features.clear();
        missing_required.unavailable_optional_features = vec!["threads.v1".to_owned()];
        assert!(validate_hello_result_binding(&host, &missing_required).is_err());

        let mut unrequested_feature = result;
        unrequested_feature
            .enabled_features
            .push("unrequested.v1".to_owned());
        assert!(validate_hello_result_binding(&host, &unrequested_feature).is_err());
    }

    #[test]
    fn rejects_malformed_hello_result_and_startup_status_fields() {
        let mut wrong_protocol = BTreeMap::from([
            ("kind".to_owned(), string("hello_result")),
            ("protocol".to_owned(), number(2)),
            ("enabledFeatures".to_owned(), Value::Array(vec![])),
            (
                "unavailableOptionalFeatures".to_owned(),
                Value::Array(vec![]),
            ),
            ("supervisorNonce".to_owned(), string("nonce-1")),
            ("processIncarnation".to_owned(), string("inc-1")),
            ("ownerEpoch".to_owned(), number(7)),
        ]);
        assert!(decode_message(&wire_message(wrong_protocol.clone())).is_err());

        wrong_protocol.insert("protocol".to_owned(), number(PROTOCOL_V1 as u64));
        wrong_protocol.insert(
            "enabledFeatures".to_owned(),
            Value::Array(vec![string("threads.v1"), string("threads.v1")]),
        );
        assert!(decode_message(&wire_message(wrong_protocol)).is_err());

        let ready_with_error = BTreeMap::from([
            ("kind".to_owned(), string("startup_status")),
            ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
            ("state".to_owned(), string("READY")),
            ("error".to_owned(), typed_error_to_value(&protocol_error())),
        ]);
        assert!(decode_message(&wire_message(ready_with_error)).is_err());

        let failed_without_error = BTreeMap::from([
            ("kind".to_owned(), string("startup_status")),
            ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
            ("state".to_owned(), string("FAILED")),
        ]);
        assert!(decode_message(&wire_message(failed_without_error)).is_err());

        let unknown_state = BTreeMap::from([
            ("kind".to_owned(), string("startup_status")),
            ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
            ("state".to_owned(), string("RESTARTING")),
        ]);
        assert!(decode_message(&wire_message(unknown_state)).is_err());
    }

    #[test]
    fn hello_result_features_are_bounded_unique_and_disjoint() {
        let mut too_many = hello_result();
        too_many.enabled_features = (0..=MAX_FEATURE_COUNT)
            .map(|index| format!("feature-{index}"))
            .collect();
        assert!(validate_message(&RpcMessageV1::HelloResult(Box::new(too_many))).is_err());

        let mut duplicate = hello_result();
        duplicate.enabled_features.push("threads.v1".to_owned());
        assert!(validate_message(&RpcMessageV1::HelloResult(Box::new(duplicate))).is_err());

        let mut overlap = hello_result();
        overlap
            .unavailable_optional_features
            .push("threads.v1".to_owned());
        assert!(validate_message(&RpcMessageV1::HelloResult(Box::new(overlap))).is_err());
    }

    #[test]
    fn startup_status_wire_omits_error_except_for_failure() {
        for status in [
            KernelStartupStatusV1::Starting,
            KernelStartupStatusV1::Ready,
        ] {
            let Value::Map(map) = message_to_value(&RpcMessageV1::StartupStatus(Box::new(status)))
            else {
                panic!("startup status must encode as a map");
            };
            assert!(!map.contains_key("error"));
        }

        let failed = RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Failed(
            Box::new(protocol_error()),
        )));
        let Value::Map(map) = message_to_value(&failed) else {
            panic!("startup status must encode as a map");
        };
        assert!(map.contains_key("error"));
    }

    #[test]
    fn frame_fence_rejects_foreign_epoch_or_incarnation() {
        let fence = FrameFence::new(7, "inc-1").unwrap();
        assert!(fence.validate_frame(7, "inc-1").is_ok());
        assert!(fence.validate_frame(0, "inc-1").is_err());
        assert!(fence.validate_frame(8, "inc-1").is_err());
        assert!(fence.validate_frame(7, "inc-2").is_err());
        assert!(fence.validate_frame(MAX_SAFE_INTEGER + 1, "inc-1").is_err());
        // Construction fails closed on malformed pairs instead of defaulting them.
        assert!(FrameFence::new(0, "inc-1").is_err());
        assert!(FrameFence::new(7, "").is_err());
    }

    #[test]
    fn decode_rejects_missing_or_invalid_frame_fencing() {
        let Value::Map(valid) = message_to_value(&request(Value::Nil)) else {
            panic!("request must encode as a map");
        };
        for (field, replacement) in [
            ("ownerEpoch", Value::Unsigned(0)),
            ("ownerEpoch", Value::Unsigned(MAX_SAFE_INTEGER + 1)),
            ("processIncarnation", Value::String(String::new())),
        ] {
            let mut invalid = valid.clone();
            invalid.insert(field.to_owned(), replacement);
            assert!(decode_message(&wire_message(invalid)).is_err(), "{field}");
        }
        let mut missing = valid;
        missing.remove("ownerEpoch");
        assert!(decode_message(&wire_message(missing)).is_err());

        // Hello rejections must carry the nonce/incarnation binding of the rejected hello.
        let Value::Map(rejection) = message_to_value(&RpcMessageV1::HelloRejected(Box::new(
            KernelHelloRejectedV1 {
                supervisor_nonce: "nonce-1".to_owned(),
                process_incarnation: "inc-1".to_owned(),
                error: protocol_error(),
            },
        ))) else {
            panic!("hello rejection must encode as a map");
        };
        let mut missing_nonce = rejection.clone();
        missing_nonce.remove("supervisorNonce");
        assert!(decode_message(&wire_message(missing_nonce)).is_err());
        let mut missing_incarnation = rejection;
        missing_incarnation.remove("processIncarnation");
        assert!(decode_message(&wire_message(missing_incarnation)).is_err());
    }

    #[test]
    fn control_messages_match_fixed_v1_wire_vectors() {
        let control_messages = [
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
                    owner_epoch: 7,
                    process_incarnation: "inc-1".to_owned(),
                    subscription_id: "sub_1".to_owned(),
                    owner_kind: "thread".to_owned(),
                    owner_id: "thr_1".to_owned(),
                    after: None,
                })),
                "86a46b696e64a9737562736372696265aa6f776e657245706f636807a76f776e65724964a57468725f31a96f776e65724b696e64a6746872656164b270726f63657373496e6361726e6174696f6ea5696e632d31ae737562736372697074696f6e4964a57375625f31",
            ),
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
                    owner_epoch: 7,
                    process_incarnation: "inc-1".to_owned(),
                    subscription_id: "sub_1".to_owned(),
                    owner_kind: "thread".to_owned(),
                    owner_id: "thr_1".to_owned(),
                    after: Some(cursor()),
                })),
                "87a5616674657284ab6576656e74446967657374d947626c616b65333a30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566a76f776e65724964a57468725f31a96f776e65724b696e64a6746872656164a3736571a23432a46b696e64a9737562736372696265aa6f776e657245706f636807a76f776e65724964a57468725f31a96f776e65724b696e64a6746872656164b270726f63657373496e6361726e6174696f6ea5696e632d31ae737562736372697074696f6e4964a57375625f31",
            ),
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Unsubscribe {
                    owner_epoch: 7,
                    process_incarnation: "inc-1".to_owned(),
                    subscription_id: "sub_1".to_owned(),
                })),
                "84a46b696e64ab756e737562736372696265aa6f776e657245706f636807b270726f63657373496e6361726e6174696f6ea5696e632d31ae737562736372697074696f6e4964a57375625f31",
            ),
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
                    owner_epoch: 7,
                    process_incarnation: "inc-1".to_owned(),
                    subscription_id: "sub_1".to_owned(),
                    through: cursor(),
                })),
                "85a46b696e64a361636baa6f776e657245706f636807b270726f63657373496e6361726e6174696f6ea5696e632d31ae737562736372697074696f6e4964a57375625f31a77468726f75676884ab6576656e74446967657374d947626c616b65333a30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566a76f776e65724964a57468725f31a96f776e65724b696e64a6746872656164a3736571a23432",
            ),
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Ping {
                    owner_epoch: 7,
                    process_incarnation: "inc-1".to_owned(),
                    nonce: "nonce_1".to_owned(),
                })),
                "84a46b696e64a470696e67a56e6f6e6365a76e6f6e63655f31aa6f776e657245706f636807b270726f63657373496e6361726e6174696f6ea5696e632d31",
            ),
        ];

        for (message, expected_hex) in control_messages {
            let expected = decode_hex(expected_hex);
            assert_eq!(encode_message(&message).unwrap(), expected);
            assert_eq!(decode_message(&expected).unwrap(), message);
        }
    }

    #[test]
    fn page_control_messages_roundtrip_and_resnapshot_is_owner_scoped() {
        let page_end = RpcMessageV1::Control(Box::new(RpcControlV1::PageEnd {
            owner_epoch: 7,
            process_incarnation: "inc-1".to_owned(),
            subscription_id: "sub_1".to_owned(),
            through: cursor(),
            has_more: true,
        }));
        assert_eq!(
            decode_message(&encode_message(&page_end).unwrap()).unwrap(),
            page_end
        );

        let resnapshot = RpcMessageV1::Control(Box::new(RpcControlV1::ResnapshotRequired {
            owner_epoch: 7,
            process_incarnation: "inc-1".to_owned(),
            subscription_id: "sub_1".to_owned(),
            requested: cursor(),
            latest: cursor(),
        }));
        assert_eq!(
            decode_message(&encode_message(&resnapshot).unwrap()).unwrap(),
            resnapshot
        );

        let mut wrong_owner = cursor();
        wrong_owner.owner_id = "thr_other".to_owned();
        assert!(
            validate_message(&RpcMessageV1::Control(Box::new(
                RpcControlV1::ResnapshotRequired {
                    owner_epoch: 7,
                    process_incarnation: "inc-1".to_owned(),
                    subscription_id: "sub_1".to_owned(),
                    requested: cursor(),
                    latest: wrong_owner,
                }
            )))
            .is_err()
        );
    }

    #[test]
    fn subscription_start_cursor_must_match_requested_owner() {
        let subscription_for = |cursor| {
            RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
                owner_epoch: 7,
                process_incarnation: "inc-1".to_owned(),
                subscription_id: "sub_1".to_owned(),
                owner_kind: "thread".to_owned(),
                owner_id: "thr_1".to_owned(),
                after: Some(cursor),
            }))
        };

        assert!(encode_message(&subscription_for(cursor())).is_ok());

        let mut wrong_owner_kind = cursor();
        wrong_owner_kind.owner_kind = "run".to_owned();
        assert!(encode_message(&subscription_for(wrong_owner_kind)).is_err());

        let mut wrong_owner_id = cursor();
        wrong_owner_id.owner_id = "thr_other".to_owned();
        assert!(encode_message(&subscription_for(wrong_owner_id)).is_err());
    }

    #[test]
    fn rejects_invalid_digest_decimal_response_shape_and_protocol_version() {
        let mut invalid_cursor = cursor();
        invalid_cursor.seq = "042".to_owned();
        assert!(validate_cursor(&invalid_cursor).is_err());

        let mut invalid_digest = hello(&[], &[]);
        invalid_digest.host_build_digest = "blake3:ABC".to_owned();
        assert!(validate_hello(&invalid_digest).is_err());

        let mismatched_receipt = RpcMessageV1::Response(Box::new(RpcResponseV1 {
            owner_epoch: 7,
            process_incarnation: "inc-1".to_owned(),
            request_id: "req_1".to_owned(),
            outcome: RpcOutcomeV1::Ok,
            owner_cursor: Some(cursor()),
            receipt_digest: None,
            body: None,
            error: None,
        }));
        assert!(validate_message(&mismatched_receipt).is_err());

        let mut bad_protocol = message_to_value(&request(Value::Nil));
        if let Value::Map(map) = &mut bad_protocol {
            map.insert("protocol".to_owned(), Value::Unsigned(2));
        }
        let encoded = messagepack::encode(&bad_protocol, FRAME_LIMITS).unwrap();
        assert!(matches!(
            decode_message(&encoded).unwrap_err().0,
            ProtocolErrorKind::UnsupportedProtocol { protocol: 2 }
        ));
    }

    #[test]
    fn negotiation_selects_highest_kernel_version_and_rejects_unknown_required_features() {
        let mut host = hello(&["threads.v1"], &["memory.v1", "other.v1"]);
        host.process_incarnation = "host-inc-1".to_owned();
        let policy = HandshakePolicy {
            min_protocol: 1,
            max_protocol: 3,
            supported_features: BTreeSet::from(["threads.v1".to_owned(), "memory.v1".to_owned()]),
            expected_supervisor_nonce: "nonce-1".to_owned(),
            expected_host_process_incarnation: Some("host-inc-1".to_owned()),
            owner_epoch: 7,
        };
        let negotiated = negotiate_hello(&host, &policy).unwrap();
        assert_eq!(negotiated.protocol, 1);
        assert_eq!(negotiated.enabled_features, vec!["threads.v1", "memory.v1"]);
        assert_eq!(negotiated.unavailable_optional_features, vec!["other.v1"]);

        let mut unknown_required = hello(&["unknown.required"], &[]);
        unknown_required.process_incarnation = "host-inc-1".to_owned();
        assert!(matches!(
            negotiate_hello(&unknown_required, &policy).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let mut protocol_two_host = host.clone();
        protocol_two_host.min_protocol = 2;
        assert!(matches!(
            negotiate_hello(&protocol_two_host, &policy).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let protocol_two_kernel = HandshakePolicy {
            min_protocol: 2,
            ..policy.clone()
        };
        assert!(matches!(
            negotiate_hello(&host, &protocol_two_kernel).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let mut wrong_nonce = host.clone();
        wrong_nonce.supervisor_nonce = "wrong-nonce".to_owned();
        assert!(matches!(
            negotiate_hello(&wrong_nonce, &policy).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let mut wrong_incarnation = host;
        wrong_incarnation.process_incarnation = "wrong-incarnation".to_owned();
        assert!(matches!(
            negotiate_hello(&wrong_incarnation, &policy).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let missing_expected_incarnation = HandshakePolicy {
            expected_host_process_incarnation: None,
            ..policy
        };
        assert!(matches!(
            negotiate_hello(
                &hello(&["threads.v1"], &["memory.v1"]),
                &missing_expected_incarnation
            )
            .unwrap_err()
            .0,
            ProtocolErrorKind::TransportIncompatible
        ));
    }

    #[test]
    fn repo_intel_read_context_is_optional_and_unavailable_without_negotiation() {
        let feature = FEATURE_REPO_INTEL_READ_CONTEXT_V1.to_owned();
        let mut host = hello(&[], &[feature.as_str()]);
        host.process_incarnation = "host-inc-1".to_owned();
        let policy = HandshakePolicy {
            min_protocol: 1,
            max_protocol: 1,
            supported_features: BTreeSet::from([feature.clone()]),
            expected_supervisor_nonce: "nonce-1".to_owned(),
            expected_host_process_incarnation: Some("host-inc-1".to_owned()),
            owner_epoch: 7,
        };
        let negotiated = negotiate_hello(&host, &policy).unwrap();
        assert_eq!(negotiated.enabled_features, vec![feature.clone()]);
        assert!(negotiated.unavailable_optional_features.is_empty());

        let older_peer = HandshakePolicy {
            supported_features: BTreeSet::new(),
            ..policy
        };
        let negotiated = negotiate_hello(&host, &older_peer).unwrap();
        assert!(negotiated.enabled_features.is_empty());
        assert_eq!(negotiated.unavailable_optional_features, vec![feature]);
    }

    #[test]
    fn request_response_and_event_bodies_have_independent_decoded_value_limits() {
        let too_large = Value::String("x".repeat(MAX_BODY_BYTES));
        assert!(validate_message(&request(too_large)).is_err());

        let response_for_body = |body| {
            RpcMessageV1::Response(Box::new(RpcResponseV1 {
                owner_epoch: 7,
                process_incarnation: "inc-1".to_owned(),
                request_id: "req_body".to_owned(),
                outcome: RpcOutcomeV1::Ok,
                owner_cursor: None,
                receipt_digest: None,
                body: Some(body),
                error: None,
            }))
        };
        let body_at_limit = Value::Binary(vec![0; MAX_BODY_BYTES - 5]);
        assert_eq!(
            messagepack::encoded_len(&body_at_limit, FRAME_LIMITS).unwrap(),
            MAX_BODY_BYTES
        );
        assert!(encode_message(&response_for_body(body_at_limit)).is_ok());
        assert!(
            encode_message(&response_for_body(Value::Binary(vec![
                0;
                MAX_BODY_BYTES - 4
            ])))
            .is_err()
        );

        let event_for_payload = |payload| {
            RpcMessageV1::Event(Box::new(RpcEventV1 {
                owner_epoch: 7,
                process_incarnation: "inc-1".to_owned(),
                subscription_id: "sub_1".to_owned(),
                cursor: cursor(),
                event_type: "test".to_owned(),
                payload,
            }))
        };
        let payload_at_limit = Value::Binary(vec![0; MAX_EVENT_PAYLOAD_BYTES - 5]);
        assert_eq!(
            messagepack::encoded_len(&payload_at_limit, FRAME_LIMITS).unwrap(),
            MAX_EVENT_PAYLOAD_BYTES
        );
        assert!(encode_message(&event_for_payload(payload_at_limit)).is_ok());
        assert!(
            encode_message(&event_for_payload(Value::Binary(vec![
                0;
                MAX_EVENT_PAYLOAD_BYTES
                    - 4
            ])))
            .is_err()
        );
    }

    #[test]
    fn trusted_operation_and_artifact_chunk_limits_can_only_lower_global_body_limit() {
        assert!(validate_operation_body(&Value::Nil, 0).is_err());
        let above_global_limit = Value::Binary(vec![0; MAX_BODY_BYTES - 4]);
        assert_eq!(
            messagepack::encoded_len(&above_global_limit, FRAME_LIMITS).unwrap(),
            MAX_BODY_BYTES + 1
        );
        assert!(validate_operation_body(&above_global_limit, MAX_BODY_BYTES + 1).is_err());
        assert!(canonical_body_bytes(&above_global_limit, MAX_BODY_BYTES + 1).is_err());
        let chunk_at_limit = Value::Binary(vec![0; MAX_ARTIFACT_CHUNK_BODY_BYTES - 5]);
        assert_eq!(
            messagepack::encoded_len(&chunk_at_limit, FRAME_LIMITS).unwrap(),
            MAX_ARTIFACT_CHUNK_BODY_BYTES
        );
        assert!(validate_artifact_chunk_body(&chunk_at_limit).is_ok());
        assert!(
            validate_artifact_chunk_body(&Value::Binary(vec![
                0;
                MAX_ARTIFACT_CHUNK_BODY_BYTES - 4
            ]))
            .is_err()
        );
    }

    #[test]
    fn operation_body_limit_matches_canonical_encoded_bytes() {
        let body = Value::String("x".to_owned());
        let encoded_length = messagepack::encoded_len(&body, FRAME_LIMITS).unwrap();
        assert_eq!(encoded_length, 2);
        assert!(validate_operation_body(&body, encoded_length).is_ok());
        assert!(validate_operation_body(&body, encoded_length - 1).is_err());
        assert_eq!(
            canonical_body_bytes(&body, encoded_length).unwrap(),
            [0xa1, b'x']
        );
        assert!(canonical_body_bytes(&body, encoded_length - 1).is_err());
    }

    #[test]
    fn deadline_limits_depend_on_trusted_operation_class() {
        assert!(validate_deadline(10_000, 1_000, false).is_ok());
        assert!(validate_deadline(400_000, 1_000, false).is_err());
        assert!(validate_deadline(400_000, 1_000, true).is_ok());
        assert!(validate_deadline(1_000, 1_000, true).is_err());
        assert!(validate_deadline(MAX_SAFE_INTEGER + 1, 1_000, true).is_err());
        assert!(validate_deadline(1_000 + MAX_DEADLINE_INTERACTIVE_MS, 1_000, false).is_ok());
        assert!(validate_deadline(1_001 + MAX_DEADLINE_INTERACTIVE_MS, 1_000, false).is_err());
        assert!(validate_deadline(1_000 + MAX_DEADLINE_DURABLE_MS, 1_000, true).is_ok());
        assert!(validate_deadline(1_001 + MAX_DEADLINE_DURABLE_MS, 1_000, true).is_err());
    }

    #[test]
    fn rejects_javascript_unsafe_deadline_and_retry_duration_fields() {
        let mut request = match request(Value::Nil) {
            RpcMessageV1::Request(request) => *request,
            _ => unreachable!(),
        };
        request.deadline_unix_ms = MAX_SAFE_INTEGER + 1;
        assert!(validate_message(&RpcMessageV1::Request(Box::new(request))).is_err());

        let response = RpcMessageV1::Response(Box::new(RpcResponseV1 {
            owner_epoch: 7,
            process_incarnation: "inc-1".to_owned(),
            request_id: "req_error".to_owned(),
            outcome: RpcOutcomeV1::Error,
            owner_cursor: None,
            receipt_digest: None,
            body: None,
            error: Some(TypedErrorV1 {
                code: "RATE_LIMITED".to_owned(),
                category: ErrorCategoryV1::Unavailable,
                message: "retry later".to_owned(),
                retry_class: RetryClassV1::Never,
                retry_after_ms: Some(u64::MAX),
                owner_cursor: None,
                subject_ids: Vec::new(),
                details: None,
            }),
        }));
        assert!(validate_message(&response).is_err());
    }

    #[test]
    fn enforces_the_encoded_typed_error_detail_limit_at_the_boundary() {
        assert_eq!(MAX_ERROR_BYTES, 64 * 1024);

        let error_for_message = |message: String| TypedErrorV1 {
            code: "UNAVAILABLE".to_owned(),
            category: ErrorCategoryV1::Unavailable,
            message,
            retry_class: RetryClassV1::Never,
            retry_after_ms: None,
            owner_cursor: None,
            subject_ids: Vec::new(),
            details: None,
        };
        let encoded_error_len = |message_length: usize| {
            let value = typed_error_to_value(&error_for_message("x".repeat(message_length)));
            messagepack::encoded_len(&value, FRAME_LIMITS).unwrap()
        };
        let response_for_message = |message: String| {
            RpcMessageV1::Response(Box::new(RpcResponseV1 {
                owner_epoch: 7,
                process_incarnation: "inc-1".to_owned(),
                request_id: "req_error".to_owned(),
                outcome: RpcOutcomeV1::Error,
                owner_cursor: None,
                receipt_digest: None,
                body: None,
                error: Some(error_for_message(message)),
            }))
        };

        let mut largest_accepted_message = 0;
        let mut upper_message_length = MAX_ERROR_BYTES;
        while largest_accepted_message < upper_message_length {
            let candidate = largest_accepted_message
                + (upper_message_length - largest_accepted_message).div_ceil(2);
            if encoded_error_len(candidate) <= MAX_ERROR_BYTES {
                largest_accepted_message = candidate;
            } else {
                upper_message_length = candidate - 1;
            }
        }

        assert!(largest_accepted_message < MAX_ERROR_BYTES);
        assert!(encoded_error_len(largest_accepted_message) <= MAX_ERROR_BYTES);
        assert!(encoded_error_len(largest_accepted_message + 1) > MAX_ERROR_BYTES);
        assert!(
            encode_message(&response_for_message("x".repeat(largest_accepted_message))).is_ok()
        );
        assert!(
            encode_message(&response_for_message(
                "x".repeat(largest_accepted_message + 1)
            ))
            .is_err()
        );
    }
}
