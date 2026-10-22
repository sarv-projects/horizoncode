//! Strict Rust decoder for the shared, lane-tagged SubagentDeliveryV1 envelope.
//!
//! Decoding and digest verification are structural checks only. Callers must
//! still authenticate the owner and compare the claims with live Core or
//! managed Attempt state before accepting a delivery.

use crate::messagepack::{self, FRAME_LIMITS, MessagePackError, Value};
use crate::protocol::DelegationBindingV1;

const AUTHORITY_DOMAIN: &str = "SubagentDeliveryV1.authority";
const TOP_KEYS: [&str; 17] = [
    "schemaVersion",
    "lane",
    "deliveryId",
    "requestId",
    "parentExecutionId",
    "childExecutionId",
    "messageId",
    "payloadRef",
    "payloadDigest",
    "replyTo",
    "kind",
    "ackState",
    "ownerEpoch",
    "sequence",
    "expiresAt",
    "authorityDigest",
    "authority",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubagentDeliveryLaneV1 {
    DirectSession,
    ManagedAttempt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubagentDeliveryAuthorityV1 {
    DirectSession {
        parent_session_id: String,
        child_session_id: String,
        profile_id: String,
        profile_revision: u64,
        profile_digest: String,
        permission_scope_digest: String,
    },
    ManagedAttempt {
        delegation_binding_digest: String,
        goal_id: String,
        run_id: String,
        task_id: String,
        attempt_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentDeliveryV1 {
    pub lane: SubagentDeliveryLaneV1,
    pub delivery_id: String,
    pub request_id: String,
    pub parent_execution_id: String,
    pub child_execution_id: String,
    pub message_id: String,
    pub payload_ref: String,
    pub payload_digest: String,
    pub reply_to: Option<String>,
    pub kind: String,
    pub ack_state: String,
    pub owner_epoch: u64,
    pub sequence: u64,
    pub expires_at: String,
    pub authority_digest: String,
    pub authority: SubagentDeliveryAuthorityV1,
}

impl SubagentDeliveryV1 {
    /// Decode a single bounded MessagePack frame and reject trailing bytes.
    pub fn decode_bytes(input: &[u8]) -> Option<Self> {
        let value = messagepack::decode(input, FRAME_LIMITS).ok()?;
        Self::decode(&value)
    }

    /// Decode a bounded MessagePack value, reject unknown/missing fields, and
    /// verify the authority digest. This does not grant authority.
    pub fn decode(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if fields.len() != TOP_KEYS.len() && fields.len() != TOP_KEYS.len() - 1 {
            return None;
        }
        if fields.keys().any(|key| !TOP_KEYS.contains(&key.as_str()))
            || TOP_KEYS
                .iter()
                .filter(|key| **key != "replyTo")
                .any(|key| !fields.contains_key(*key))
        {
            return None;
        }
        if fields.get("schemaVersion") != Some(&Value::Unsigned(1)) {
            return None;
        }

        let lane = match fields.get("lane")? {
            Value::String(value) if value == "direct_session" => {
                SubagentDeliveryLaneV1::DirectSession
            }
            Value::String(value) if value == "managed_attempt" => {
                SubagentDeliveryLaneV1::ManagedAttempt
            }
            _ => return None,
        };
        let delivery_id = identifier(fields.get("deliveryId")?, 256)?;
        let request_id = identifier(fields.get("requestId")?, 256)?;
        let parent_execution_id = identifier(fields.get("parentExecutionId")?, 256)?;
        let child_execution_id = identifier(fields.get("childExecutionId")?, 256)?;
        let message_id = identifier(fields.get("messageId")?, 256)?;
        let payload_ref = identifier(fields.get("payloadRef")?, 512)?;
        let payload_digest = digest(fields.get("payloadDigest")?, false)?;
        let reply_to = match fields.get("replyTo") {
            Some(value) => Some(identifier(value, 256)?),
            None => None,
        };
        let kind = enum_value(
            fields.get("kind")?,
            &[
                "task", "question", "response", "progress", "result", "cancel",
            ],
        )?;
        let ack_state = enum_value(
            fields.get("ackState")?,
            &["queued", "delivered", "acknowledged", "expired", "unknown"],
        )?;
        let owner_epoch = canonical_u64(fields.get("ownerEpoch")?)?;
        let sequence = canonical_u64(fields.get("sequence")?)?;
        let expires_at = match fields.get("expiresAt")? {
            Value::String(value) if valid_timestamp(value) => value.clone(),
            _ => return None,
        };
        let authority = decode_authority(lane, fields.get("authority")?)?;
        let authority_digest = digest(fields.get("authorityDigest")?, true)?;

        let expected = authority_digest_for(
            lane,
            &parent_execution_id,
            &child_execution_id,
            owner_epoch,
            fields.get("authority")?,
        )
        .ok()?;
        if authority_digest != expected {
            return None;
        }

        Some(Self {
            lane,
            delivery_id,
            request_id,
            parent_execution_id,
            child_execution_id,
            message_id,
            payload_ref,
            payload_digest,
            reply_to,
            kind,
            ack_state,
            owner_epoch,
            sequence,
            expires_at,
            authority_digest,
            authority,
        })
    }

    /// Compare a managed delivery's claims to the current canonical Goal and
    /// immutable Attempt binding. Callers must obtain both from authenticated
    /// live state; matching a delivery alone does not authorize an effect.
    pub fn matches_managed_attempt(
        &self,
        goal_id: &str,
        binding: &DelegationBindingV1,
    ) -> Result<bool, MessagePackError> {
        let SubagentDeliveryAuthorityV1::ManagedAttempt {
            delegation_binding_digest,
            goal_id: delivery_goal_id,
            run_id,
            task_id,
            attempt_id,
        } = &self.authority
        else {
            return Ok(false);
        };
        Ok(self.lane == SubagentDeliveryLaneV1::ManagedAttempt
            && self.parent_execution_id == binding.parent_execution_id
            && self.child_execution_id == binding.child_execution_id
            && self.owner_epoch == binding.owner_epoch
            && *delivery_goal_id == goal_id
            && *run_id == binding.run_id
            && *task_id == binding.task_id
            && *attempt_id == binding.attempt_id
            && *delegation_binding_digest == binding.digest()?)
    }

    /// Compare a direct delivery's claims to trusted Core-owned Session/profile
    /// state supplied by the authenticated parent Session owner.
    pub fn matches_direct_session(
        &self,
        parent_execution_id: &str,
        child_execution_id: &str,
        owner_epoch: u64,
        parent_session_id: &str,
        child_session_id: &str,
        profile_id: &str,
        profile_revision: u64,
        profile_digest: &str,
        permission_scope_digest: &str,
    ) -> bool {
        let SubagentDeliveryAuthorityV1::DirectSession {
            parent_session_id: delivery_parent_session_id,
            child_session_id: delivery_child_session_id,
            profile_id: delivery_profile_id,
            profile_revision: delivery_profile_revision,
            profile_digest: delivery_profile_digest,
            permission_scope_digest: delivery_permission_scope_digest,
        } = &self.authority
        else {
            return false;
        };
        self.lane == SubagentDeliveryLaneV1::DirectSession
            && self.parent_execution_id == parent_execution_id
            && self.child_execution_id == child_execution_id
            && self.owner_epoch == owner_epoch
            && delivery_parent_session_id == parent_session_id
            && delivery_child_session_id == child_session_id
            && delivery_profile_id == profile_id
            && *delivery_profile_revision == profile_revision
            && delivery_profile_digest == profile_digest
            && delivery_permission_scope_digest == permission_scope_digest
    }
}

/// Compute the documented digest over the canonical MessagePack authority tuple.
pub fn authority_digest_for(
    lane: SubagentDeliveryLaneV1,
    parent_execution_id: &str,
    child_execution_id: &str,
    owner_epoch: u64,
    authority: &Value,
) -> Result<String, messagepack::MessagePackError> {
    let lane = match lane {
        SubagentDeliveryLaneV1::DirectSession => "direct_session",
        SubagentDeliveryLaneV1::ManagedAttempt => "managed_attempt",
    };
    let preimage = Value::Array(vec![
        Value::String(AUTHORITY_DOMAIN.to_owned()),
        Value::String(lane.to_owned()),
        Value::String(parent_execution_id.to_owned()),
        Value::String(child_execution_id.to_owned()),
        Value::String(owner_epoch.to_string()),
        authority.clone(),
    ]);
    let bytes = messagepack::encode(&preimage, FRAME_LIMITS)?;
    Ok(format!("blake3:{}", blake3::hash(&bytes).to_hex()))
}

fn decode_authority(
    lane: SubagentDeliveryLaneV1,
    value: &Value,
) -> Option<SubagentDeliveryAuthorityV1> {
    let Value::Map(fields) = value else {
        return None;
    };
    match lane {
        SubagentDeliveryLaneV1::DirectSession => {
            const KEYS: [&str; 6] = [
                "parentSessionId",
                "childSessionId",
                "profileId",
                "profileRevision",
                "profileDigest",
                "permissionScopeDigest",
            ];
            if !exact_keys(fields, &KEYS) {
                return None;
            }
            Some(SubagentDeliveryAuthorityV1::DirectSession {
                parent_session_id: identifier(fields.get("parentSessionId")?, 256)?,
                child_session_id: identifier(fields.get("childSessionId")?, 256)?,
                profile_id: identifier(fields.get("profileId")?, 256)?,
                profile_revision: canonical_u64(fields.get("profileRevision")?)?,
                profile_digest: digest(fields.get("profileDigest")?, false)?,
                permission_scope_digest: digest(fields.get("permissionScopeDigest")?, false)?,
            })
        }
        SubagentDeliveryLaneV1::ManagedAttempt => {
            const KEYS: [&str; 5] = [
                "delegationBindingDigest",
                "goalId",
                "runId",
                "taskId",
                "attemptId",
            ];
            if !exact_keys(fields, &KEYS) {
                return None;
            }
            Some(SubagentDeliveryAuthorityV1::ManagedAttempt {
                delegation_binding_digest: digest(fields.get("delegationBindingDigest")?, false)?,
                goal_id: identifier(fields.get("goalId")?, 256)?,
                run_id: identifier(fields.get("runId")?, 256)?,
                task_id: identifier(fields.get("taskId")?, 256)?,
                attempt_id: identifier(fields.get("attemptId")?, 256)?,
            })
        }
    }
}

fn exact_keys<const N: usize>(
    fields: &std::collections::BTreeMap<String, Value>,
    keys: &[&str; N],
) -> bool {
    fields.len() == N && fields.keys().all(|key| keys.contains(&key.as_str()))
}

fn identifier(value: &Value, max: usize) -> Option<String> {
    match value {
        Value::String(value)
            if !value.is_empty()
                && value.encode_utf16().count() <= max
                && !value
                    .chars()
                    .any(|ch| ch.is_whitespace() || ch.is_control()) =>
        {
            Some(value.clone())
        }
        _ => None,
    }
}

fn canonical_u64(value: &Value) -> Option<u64> {
    let Value::String(value) = value else {
        return None;
    };
    if value.is_empty()
        || value.len() > 20
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

fn digest(value: &Value, blake3_only: bool) -> Option<String> {
    let Value::String(value) = value else {
        return None;
    };
    let prefixes: &[&str] = if blake3_only {
        &["blake3:"]
    } else {
        &["sha256:", "blake3:"]
    };
    prefixes
        .iter()
        .any(|prefix| {
            value.strip_prefix(prefix).is_some_and(|hex| {
                hex.len() == 64
                    && hex
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        })
        .then(|| value.clone())
}

fn enum_value(value: &Value, variants: &[&str]) -> Option<String> {
    match value {
        Value::String(value) if variants.contains(&value.as_str()) => Some(value.clone()),
        _ => None,
    }
}

fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit() {
            return false;
        }
    }
    let number = |range: std::ops::Range<usize>| value[range].parse::<u32>().ok();
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number(0..4),
        number(5..7),
        number(8..10),
        number(11..13),
        number(14..16),
        number(17..19),
    ) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max_day).contains(&day) && hour <= 23 && minute <= 59 && second <= 59
}
