//! Strict DirectSessionGrantV1 decoding and canonical immutable-claim digest.
//!
//! This module validates the schema at the Rust authority boundary. It does not
//! decide whether a grant is current for a Location; callers must compare every
//! authenticated pin through `ActiveGrantQueryV1` before Guard admission.

use crate::messagepack::{self, Value, FRAME_LIMITS};
use std::collections::BTreeMap;

const DIGEST_DOMAIN: &[u8] = b"horizoncode.direct-session-grant.v1\0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectSessionGrantV1 {
    pub(crate) grant_id: String,
    pub(crate) scope_kind: String,
    pub(crate) principal_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) owner_epoch: Option<u64>,
    pub(crate) location_id: Option<String>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) workspace_root_digest: Option<String>,
    pub(crate) execution_backend_id: Option<String>,
    pub(crate) guarantee_set_digest: Option<String>,
    pub(crate) policy_digest: String,
    pub(crate) issued_at_unix_ms: u64,
    pub(crate) expires_at_unix_ms: Option<u64>,
    pub(crate) scope: Value,
    pub(crate) command_profiles: Vec<WorkspaceCommandGrantRefV1>,
    pub(crate) max_effect_count: Option<u64>,
    pub(crate) max_payload_bytes: Option<u64>,
    pub(crate) max_wall_time_ms: Option<u64>,
    pub(crate) destinations: Vec<Value>,
    pub(crate) max_requests: Option<u64>,
    pub(crate) max_bytes: Option<u64>,
    pub(crate) grant_digest: String,
    pub(crate) value: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceCommandGrantRefV1 {
    pub(crate) profile_id: String,
    pub(crate) revision: u64,
    pub(crate) profile_digest: String,
    pub(crate) action: crate::workspace_command_profile::WorkspaceCommandActionV1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ActiveGrantQueryV1 {
    pub(crate) principal_id: String,
    pub(crate) session_id: String,
    pub(crate) owner_epoch: u64,
    pub(crate) location_id: String,
    pub(crate) workspace_id: String,
    pub(crate) workspace_root_digest: String,
    pub(crate) execution_backend_id: String,
    pub(crate) guarantee_set_digest: String,
    pub(crate) policy_digest: String,
    pub(crate) now_unix_ms: u64,
}

impl DirectSessionGrantV1 {
    pub(crate) fn from_value(value: &Value) -> Result<Self, &'static str> {
        let Value::Map(fields) = value else { return Err("grant must be an object") };
        let scope_kind = text(fields, "scopeKind")?;
        let expected: &[&str] = match scope_kind.as_str() {
            "session" => &["schemaVersion", "grantId", "scopeKind", "principalId", "sessionId", "ownerEpoch", "locationId", "workspaceId", "workspaceRootDigest", "executionBackendId", "guaranteeSetDigest", "policyDigest", "scope", "issuedAtUnixMs", "consentSource", "grantDigest", "revocation"],
            "workspace" => &["schemaVersion", "grantId", "scopeKind", "principalId", "locationId", "workspaceId", "workspaceRootDigest", "executionBackendId", "guaranteeSetDigest", "policyDigest", "scope", "issuedAtUnixMs", "expiresAtUnixMs", "consentSource", "grantDigest", "revocation"],
            "network_egress" => &["schemaVersion", "grantId", "scopeKind", "principalId", "locationId", "workspaceId", "workspaceRootDigest", "executionBackendId", "guaranteeSetDigest", "policyDigest", "destinations", "maxRequests", "maxBytes", "issuedAtUnixMs", "expiresAtUnixMs", "consentSource", "grantDigest", "revocation"],
            _ => return Err("unsupported grant scope kind"),
        };
        exact_keys(fields, expected)?;
        if unsigned(fields, "schemaVersion")? != 1 || text(fields, "consentSource")? != "explicit_user_interaction" {
            return Err("grant schema or consent source is invalid");
        }
        let grant_id = text(fields, "grantId")?;
        let principal_id = text(fields, "principalId")?;
        valid_id(&grant_id)?;
        valid_id(&principal_id)?;
        let policy_digest = digest(fields, "policyDigest")?;
        let issued_at_unix_ms = decimal(fields, "issuedAtUnixMs", false)?;
        let revocation = fields.get("revocation").ok_or("grant revocation is missing")?;
        validate_revocation(revocation)?;

        let mut session_id = None;
        let mut owner_epoch = None;
        let mut location_id = None;
        let mut workspace_id = None;
        let mut workspace_root_digest = None;
        let mut execution_backend_id = None;
        let mut guarantee_set_digest = None;
        let mut expires_at_unix_ms = None;
        let mut scope = Value::Nil;
        let mut command_profiles = Vec::new();
        let mut max_effect_count = None;
        let mut max_payload_bytes = None;
        let mut max_wall_time_ms = None;
        let mut destinations = Vec::new();
        let mut max_requests = None;
        let mut max_bytes = None;
        match scope_kind.as_str() {
            "session" => {
                session_id = Some(text(fields, "sessionId")?);
                valid_id(session_id.as_deref().unwrap())?;
                owner_epoch = Some(decimal(fields, "ownerEpoch", true)?);
                location_id = Some(text(fields, "locationId")?);
                workspace_id = Some(text(fields, "workspaceId")?);
                valid_id(location_id.as_deref().unwrap())?;
                valid_id(workspace_id.as_deref().unwrap())?;
                workspace_root_digest = Some(digest(fields, "workspaceRootDigest")?);
                execution_backend_id = Some(text(fields, "executionBackendId")?);
                valid_id(execution_backend_id.as_deref().unwrap())?;
                guarantee_set_digest = Some(digest(fields, "guaranteeSetDigest")?);
                scope = fields.get("scope").cloned().ok_or("workspace scope is missing")?;
                let (limits, profiles) = validate_workspace_scope(&scope)?;
                command_profiles = profiles;
                max_effect_count = Some(limits.0); max_payload_bytes = Some(limits.1); max_wall_time_ms = Some(limits.2);
            }
            "workspace" => {
                location_id = Some(text(fields, "locationId")?);
                workspace_id = Some(text(fields, "workspaceId")?);
                valid_id(location_id.as_deref().unwrap())?;
                valid_id(workspace_id.as_deref().unwrap())?;
                workspace_root_digest = Some(digest(fields, "workspaceRootDigest")?);
                execution_backend_id = Some(text(fields, "executionBackendId")?);
                valid_id(execution_backend_id.as_deref().unwrap())?;
                guarantee_set_digest = Some(digest(fields, "guaranteeSetDigest")?);
                scope = fields.get("scope").cloned().ok_or("workspace scope is missing")?;
                let (limits, profiles) = validate_workspace_scope(&scope)?;
                command_profiles = profiles;
                max_effect_count = Some(limits.0); max_payload_bytes = Some(limits.1); max_wall_time_ms = Some(limits.2);
                expires_at_unix_ms = Some(decimal(fields, "expiresAtUnixMs", false)?);
            }
            "network_egress" => {
                location_id = Some(text(fields, "locationId")?);
                workspace_id = Some(text(fields, "workspaceId")?);
                valid_id(location_id.as_deref().unwrap())?;
                valid_id(workspace_id.as_deref().unwrap())?;
                workspace_root_digest = Some(digest(fields, "workspaceRootDigest")?);
                execution_backend_id = Some(text(fields, "executionBackendId")?);
                valid_id(execution_backend_id.as_deref().unwrap())?;
                guarantee_set_digest = Some(digest(fields, "guaranteeSetDigest")?);
                expires_at_unix_ms = Some(decimal(fields, "expiresAtUnixMs", false)?);
                max_requests = Some(unsigned(fields, "maxRequests")?);
                max_bytes = Some(unsigned(fields, "maxBytes")?);
                if !(1..=100_000).contains(&max_requests.unwrap()) || !(1..=1_073_741_824).contains(&max_bytes.unwrap()) {
                    return Err("network grant limits are invalid");
                }
                let Value::Array(items) = fields.get("destinations").ok_or("destinations are missing")? else { return Err("destinations must be an array") };
                if items.is_empty() || items.len() > 64 { return Err("destination count is invalid"); }
                for item in items {
                    validate_destination(item)?;
                    if destinations.contains(item) { return Err("duplicate destination"); }
                    destinations.push(item.clone());
                }
            }
            _ => unreachable!(),
        }
        if let Some(expiry) = expires_at_unix_ms {
            if expiry <= issued_at_unix_ms || expiry - issued_at_unix_ms > 30 * 24 * 60 * 60 * 1000 {
                return Err("grant lifetime is invalid");
            }
        }
        let supplied_digest = digest(fields, "grantDigest")?;
        let mut claims = fields.clone();
        claims.remove("grantDigest");
        claims.remove("revocation");
        let encoded = messagepack::encode(&Value::Map(claims), FRAME_LIMITS).map_err(|_| "grant claims exceed canonical encoding bounds")?;
        let mut hasher = blake3::Hasher::new();
        hasher.update(DIGEST_DOMAIN);
        hasher.update(&encoded);
        let computed = format!("blake3:{}", hasher.finalize().to_hex());
        if computed != supplied_digest { return Err("grant digest does not match immutable claims"); }
        Ok(Self { grant_id, scope_kind, principal_id, session_id, owner_epoch, location_id, workspace_id, workspace_root_digest, execution_backend_id, guarantee_set_digest, policy_digest, issued_at_unix_ms, expires_at_unix_ms, scope, command_profiles, max_effect_count, max_payload_bytes, max_wall_time_ms, destinations, max_requests, max_bytes, grant_digest: supplied_digest, value: value.clone() })
    }

    pub(crate) fn matches(&self, query: &ActiveGrantQueryV1) -> bool {
        if self.principal_id != query.principal_id || self.policy_digest != query.policy_digest
            || query.now_unix_ms < self.issued_at_unix_ms
            || self.expires_at_unix_ms.is_some_and(|expires| query.now_unix_ms >= expires) {
            return false;
        }
        match self.scope_kind.as_str() {
            "session" => self.session_id.as_deref() == Some(query.session_id.as_str()) && self.owner_epoch == Some(query.owner_epoch)
                && self.location_id.as_deref() == Some(query.location_id.as_str())
                && self.workspace_id.as_deref() == Some(query.workspace_id.as_str())
                && self.workspace_root_digest.as_deref() == Some(query.workspace_root_digest.as_str())
                && self.execution_backend_id.as_deref() == Some(query.execution_backend_id.as_str())
                && self.guarantee_set_digest.as_deref() == Some(query.guarantee_set_digest.as_str()),
            "workspace" | "network_egress" => self.location_id.as_deref() == Some(query.location_id.as_str())
                && self.workspace_id.as_deref() == Some(query.workspace_id.as_str())
                && self.workspace_root_digest.as_deref() == Some(query.workspace_root_digest.as_str())
                && self.execution_backend_id.as_deref() == Some(query.execution_backend_id.as_str())
                && self.guarantee_set_digest.as_deref() == Some(query.guarantee_set_digest.as_str()),
            _ => false,
        }
    }

    pub(crate) fn allows_edit(&self) -> bool {
        matches!(&self.scope, Value::Map(fields)
            if matches!(fields.get("actions"), Some(Value::Array(actions))
                if actions.iter().any(|action| matches!(action, Value::String(value) if value == "edit"))))
    }

    pub(crate) fn allows_read(&self) -> bool {
        matches!(&self.scope, Value::Map(fields)
            if matches!(fields.get("actions"), Some(Value::Array(actions))
                if actions.iter().any(|action| matches!(action, Value::String(value) if value == "read"))))
    }

    pub(crate) fn command_profile(&self, action: crate::workspace_command_profile::WorkspaceCommandActionV1,
        profile_id: &str, revision: u64, profile_digest: &str) -> bool {
        self.command_profiles.iter().any(|reference| reference.action == action
            && reference.profile_id == profile_id && reference.revision == revision
            && reference.profile_digest == profile_digest)
    }
}

fn validate_workspace_scope(value: &Value) -> Result<((u64,u64,u64), Vec<WorkspaceCommandGrantRefV1>), &'static str> {
    let Value::Map(scope) = value else { return Err("scope must be an object") };
    exact_keys_optional(scope, &["profile", "actions", "resourceScope", "limits"], &["commandProfiles"])?;
    if text(scope, "profile")? != "workspace-code" || text(scope, "resourceScope")? != "registered_workspace_and_isolated_temp_cache_roots" {
        return Err("workspace scope is invalid");
    }
    let Value::Array(actions) = scope.get("actions").ok_or("scope actions are missing")? else { return Err("scope actions must be an array") };
    if actions.is_empty() || actions.len() > 4 { return Err("scope action count is invalid"); }
    let allowed = ["read", "edit", "build", "test"];
    let mut seen = std::collections::BTreeSet::new();
    for action in actions {
        let Value::String(action) = action else { return Err("scope action must be text") };
        if !allowed.contains(&action.as_str()) || !seen.insert(action.clone()) { return Err("scope action is invalid or duplicated"); }
    }
    let Value::Map(limits) = scope.get("limits").ok_or("scope limits are missing")? else { return Err("scope limits must be an object") };
    exact_keys(limits, &["maxEffectCount", "maxPayloadBytes", "maxWallTimeMs"])?;
    let effects = unsigned(limits, "maxEffectCount")?;
    let bytes = unsigned(limits, "maxPayloadBytes")?;
    let wall = unsigned(limits, "maxWallTimeMs")?;
    if !(1..=4096).contains(&effects) || !(1..=16_777_216).contains(&bytes) || !(1..=600_000).contains(&wall) { return Err("scope limits are invalid"); }
    let mut command_profiles = Vec::new();
    if let Some(value) = scope.get("commandProfiles") {
        let Value::Array(refs) = value else { return Err("commandProfiles must be an array") };
        if refs.len() > 32 { return Err("command profile reference count is invalid"); }
        for value in refs {
            let Value::Map(reference) = value else { return Err("command profile reference must be an object") };
            exact_keys(reference, &["profileId", "revision", "profileDigest", "action"])?;
            let profile_id = text(reference, "profileId")?;
            valid_id(&profile_id)?;
            let revision = decimal(reference, "revision", true)?;
            let profile_digest = digest(reference, "profileDigest")?;
            let action = match text(reference, "action")?.as_str() {
                "build" => crate::workspace_command_profile::WorkspaceCommandActionV1::Build,
                "test" => crate::workspace_command_profile::WorkspaceCommandActionV1::Test,
                _ => return Err("command profile action is invalid"),
            };
            if command_profiles.iter().any(|item: &WorkspaceCommandGrantRefV1|
                item.profile_id == profile_id && item.action == action) {
                return Err("duplicate command profile action reference");
            }
            command_profiles.push(WorkspaceCommandGrantRefV1 { profile_id, revision, profile_digest, action });
        }
    }
    for (name, action) in [("build", crate::workspace_command_profile::WorkspaceCommandActionV1::Build),
        ("test", crate::workspace_command_profile::WorkspaceCommandActionV1::Test)] {
        let included = seen.contains(name);
        let referenced = command_profiles.iter().any(|reference| reference.action == action);
        if included != referenced { return Err("build/test scope and command profile references do not match"); }
    }
    Ok(((effects, bytes, wall), command_profiles))
}

fn validate_destination(value: &Value) -> Result<(), &'static str> {
    let Value::Map(fields) = value else { return Err("destination must be an object") };
    exact_keys(fields, &["host", "protocol", "port"])?;
    let host = text(fields, "host")?;
    if host.len() > 253 || host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b".:-".contains(&b)) || host.contains("..") || host.starts_with('.') || host.ends_with('.') { return Err("destination host is invalid"); }
    if !matches!(text(fields, "protocol")?.as_str(), "http" | "https") || !(1..=65_535).contains(&unsigned(fields, "port")?) { return Err("destination protocol or port is invalid"); }
    Ok(())
}

fn validate_revocation(value: &Value) -> Result<(), &'static str> {
    let Value::Map(fields) = value else { return Err("revocation must be an object") };
    match text(fields, "status")?.as_str() {
        "active" => exact_keys(fields, &["status"]),
        "revoked" => { exact_keys(fields, &["status", "revokedAtUnixMs", "revokedByPrincipalId"])?; let _ = decimal(fields, "revokedAtUnixMs", false)?; valid_id(&text(fields, "revokedByPrincipalId")?) },
        _ => Err("revocation status is invalid"),
    }
}

fn text(fields: &BTreeMap<String, Value>, key: &str) -> Result<String, &'static str> {
    match fields.get(key) { Some(Value::String(value)) if !value.is_empty() && !value.contains('\0') => Ok(value.clone()), _ => Err("required grant text field is invalid") }
}
fn unsigned(fields: &BTreeMap<String, Value>, key: &str) -> Result<u64, &'static str> {
    match fields.get(key) { Some(Value::Unsigned(value)) => Ok(*value), _ => Err("required grant integer field is invalid") }
}
fn decimal(fields: &BTreeMap<String, Value>, key: &str, positive: bool) -> Result<u64, &'static str> {
    let value = text(fields, key)?;
    let parsed = value.parse::<u64>().map_err(|_| "grant decimal field is invalid")?;
    if parsed.to_string() != value || positive && parsed == 0 { return Err("grant decimal is not canonical"); }
    Ok(parsed)
}
fn digest(fields: &BTreeMap<String, Value>, key: &str) -> Result<String, &'static str> {
    let value = text(fields, key)?;
    if !value.starts_with("blake3:") || value.len() != 71 || !value[7..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err("grant digest is invalid"); }
    Ok(value)
}
fn valid_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 256 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)) { return Err("grant identifier is invalid"); }
    Ok(())
}
fn exact_keys(fields: &BTreeMap<String, Value>, expected: &[&str]) -> Result<(), &'static str> {
    if fields.len() != expected.len() || expected.iter().any(|key| !fields.contains_key(*key)) { return Err("grant object has missing or extra fields"); }
    Ok(())
}
fn exact_keys_optional(fields: &BTreeMap<String, Value>, required: &[&str], optional: &[&str]) -> Result<(), &'static str> {
    if required.iter().any(|key| !fields.contains_key(*key))
        || fields.keys().any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str())) {
        return Err("grant object has missing or extra fields");
    }
    Ok(())
}
