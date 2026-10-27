//! Durable SecretBroker mutation authority for `secret.v1`.
//!
//! This journal contains metadata only. Credential bytes are never accepted,
//! derived, logged or persisted here: the trusted in-process broker remains the
//! sole owner of secret material. `HostKernel` derives the owner scope and
//! principal from the authenticated typed `ServerAuth` state, consumes an exact
//! one-use EffectHost lease, records a version-fenced receipt, and replays only
//! the exact receipt. A durable intent without a receipt is UNKNOWN and must not
//! be retried or silently replaced.

use crate::owner_log::{
    Digest, DurabilityProfile, MAX_OWNER_READ_BATCH_EVENTS, OWNER_EVENT_SCHEMA_VERSION_V1,
    OwnerEventInput, OwnerIdentity, OwnerLogError, OwnerLogV2,
};
use crate::protocol::CursorV1;
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, VecDeque};
use std::num::NonZeroUsize;
use std::path::Path;

const JOURNAL_OWNER_KIND: &str = "secret_mutation";
const JOURNAL_EVENT_KIND: &str = "secret.mutation.transition.v1";
const SNAPSHOT_FORMAT: &str = "horizon.secret-mutation.v1";
const MAX_SECRETS: usize = 256;
const MAX_RECEIPTS: usize = 256;
const MAX_INTENTS: usize = 64;
const MAX_JOURNAL_RECORDS: u64 = 65_536;
const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_ID_BYTES: usize = 256;
const MAX_LABEL_BYTES: usize = 128;
const MAX_SAFE_EVENT_TIME_MS: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretRecordV1 {
    pub secret_ref: String,
    pub provider_id: String,
    pub label: Option<String>,
    pub revoked: bool,
    pub version: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretMutationIntentV1 {
    pub idempotency_key: String,
    pub request_digest: String,
    pub operation: String,
    pub provider_id: String,
    pub secret_ref: String,
    pub expected_version: Option<u64>,
    pub resulting_version: u64,
    pub label: Option<String>,
    pub challenge_id: String,
    pub effect_id: String,
    pub user_action_id: String,
    pub effect_intent_digest: String,
    pub capability_lease_digest: String,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretMutationReceiptV1 {
    pub idempotency_key: String,
    pub request_digest: String,
    pub operation: String,
    pub provider_id: String,
    pub secret_ref: String,
    pub expected_version: Option<u64>,
    pub resulting_version: u64,
    pub revoked_version: Option<u64>,
    pub label: Option<String>,
    pub challenge_id: String,
    pub effect_id: String,
    pub user_action_id: String,
    pub effect_intent_digest: String,
    pub capability_lease_digest: String,
    pub expires_at_ms: u64,
    pub grant_id: String,
    pub receipt_digest: String,
    pub committed_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretJournalErrorV1 {
    Invalid,
    NotFound,
    StaleVersion { expected: u64, actual: u64 },
    ProviderMismatch,
    Revoked,
    Capacity,
    IdempotencyConflict,
    Unsettled,
    Corrupt,
    Persistence(String),
}

impl std::fmt::Display for SecretJournalErrorV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "secret mutation journal error: {self:?}")
    }
}

impl std::error::Error for SecretJournalErrorV1 {}

/// Domain-separated digest of the immutable receipt core. `receipt_digest` and
/// the derived `grant_id` are excluded so the digest cannot hash itself.
pub fn receipt_core_digest(receipt: &SecretMutationReceiptV1) -> String {
    let expected = receipt
        .expected_version
        .map(|value| value.to_string())
        .unwrap_or_default();
    let revoked = receipt
        .revoked_version
        .map(|value| value.to_string())
        .unwrap_or_default();
    let resulting = receipt.resulting_version.to_string();
    let expires = receipt.expires_at_ms.to_string();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.secret-mutation-receipt.v1\0");
    for field in [
        receipt.idempotency_key.as_bytes(),
        receipt.request_digest.as_bytes(),
        receipt.operation.as_bytes(),
        receipt.provider_id.as_bytes(),
        receipt.secret_ref.as_bytes(),
        expected.as_bytes(),
        resulting.as_bytes(),
        revoked.as_bytes(),
        receipt.label.as_deref().unwrap_or("").as_bytes(),
        receipt.challenge_id.as_bytes(),
        receipt.effect_id.as_bytes(),
        receipt.user_action_id.as_bytes(),
        receipt.effect_intent_digest.as_bytes(),
        receipt.capability_lease_digest.as_bytes(),
        expires.as_bytes(),
    ] {
        hasher.update(&(field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

pub struct SecretMutationJournalV1 {
    log: OwnerLogV2,
    scope_digest: String,
    records: BTreeMap<String, SecretRecordV1>,
    receipts: VecDeque<SecretMutationReceiptV1>,
    intents: BTreeMap<String, SecretMutationIntentV1>,
    commits: u64,
    last_time_ms: u64,
}

impl SecretMutationJournalV1 {
    pub fn open(root: &Path, scope_digest: &str) -> Result<Self, SecretJournalErrorV1> {
        if !valid_digest(scope_digest) {
            return Err(SecretJournalErrorV1::Invalid);
        }
        let owner = OwnerIdentity::new(
            JOURNAL_OWNER_KIND.to_owned(),
            scope_digest.to_owned(),
        )
        .map_err(|error| SecretJournalErrorV1::Persistence(error.to_string()))?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)
            .map_err(|error| SecretJournalErrorV1::Persistence(error.to_string()))?;
        let (snapshot, commits, last_time_ms) = Self::replay(&log)?;
        let (records, receipts, intents) = match snapshot {
            Some(bytes) => decode_snapshot(&bytes, scope_digest)?,
            None => (BTreeMap::new(), VecDeque::new(), BTreeMap::new()),
        };
        Ok(Self {
            log,
            scope_digest: scope_digest.to_owned(),
            records,
            receipts,
            intents,
            commits,
            last_time_ms,
        })
    }
    pub fn record(&self, secret_ref: &str) -> Option<&SecretRecordV1> {
        self.records.get(secret_ref)
    }

    pub fn receipt(&self, idempotency_key: &str) -> Option<&SecretMutationReceiptV1> {
        self.receipts
            .iter()
            .find(|receipt| receipt.idempotency_key == idempotency_key)
    }

    pub fn intent(&self, idempotency_key: &str) -> Option<&SecretMutationIntentV1> {
        self.intents.get(idempotency_key)
    }

    pub fn has_unsettled_for_target(&self, secret_ref: &str) -> bool {
        self.intents
            .values()
            .any(|intent| intent.secret_ref == secret_ref)
    }

    pub fn validate_put(
        &self,
        secret_ref: &str,
        provider_id: &str,
        expected_version: Option<u64>,
    ) -> Result<u64, SecretJournalErrorV1> {
        if !valid_wire_id(secret_ref) || !valid_wire_id(provider_id) {
            return Err(SecretJournalErrorV1::Invalid);
        }
        let Some(record) = self.records.get(secret_ref) else {
            if expected_version.is_some() {
                return Err(SecretJournalErrorV1::NotFound);
            }
            return Ok(1);
        };
        let expected = expected_version.ok_or(SecretJournalErrorV1::Invalid)?;
        check_target(record, provider_id, expected)?;
        expected
            .checked_add(1)
            .ok_or(SecretJournalErrorV1::Capacity)
    }

    pub fn validate_rotate(
        &self,
        secret_ref: &str,
        provider_id: &str,
        expected_version: u64,
    ) -> Result<u64, SecretJournalErrorV1> {
        if !valid_wire_id(secret_ref) || !valid_wire_id(provider_id) {
            return Err(SecretJournalErrorV1::Invalid);
        }
        let record = self
            .records
            .get(secret_ref)
            .ok_or(SecretJournalErrorV1::NotFound)?;
        check_target(record, provider_id, expected_version)?;
        expected_version
            .checked_add(1)
            .ok_or(SecretJournalErrorV1::Capacity)
    }

    pub fn validate_revoke(
        &self,
        secret_ref: &str,
        provider_id: &str,
        expected_version: u64,
    ) -> Result<u64, SecretJournalErrorV1> {
        self.validate_rotate(secret_ref, provider_id, expected_version)
    }

    /// Durably pin the PREPARED intent before EffectHost dispatch. A later
    /// request for the same key or target sees this intent and fails closed as
    /// UNKNOWN until the exact durable receipt resolves it.
    pub fn append_intent(
        &mut self,
        intent: SecretMutationIntentV1,
    ) -> Result<(), SecretJournalErrorV1> {
        validate_intent(&intent)?;
        if self.receipt(&intent.idempotency_key).is_some() {
            return Err(SecretJournalErrorV1::IdempotencyConflict);
        }
        if let Some(existing) = self.intents.get(&intent.idempotency_key) {
            return if existing == &intent {
                Ok(())
            } else {
                Err(SecretJournalErrorV1::IdempotencyConflict)
            };
        }
        if self.intents.len() >= MAX_INTENTS {
            return Err(SecretJournalErrorV1::Capacity);
        }
        let mut intents = self.intents.clone();
        intents.insert(intent.idempotency_key.clone(), intent);
        self.commit_snapshot(
            "intent",
            self.records.clone(),
            self.receipts.clone(),
            intents,
            unix_ms()?,
        )
    }

    /// Atomically persist the target version change and its exact receipt. The
    /// intent is removed in the same owner-log transition, so no crash can leave
    /// both a committed receipt and an unsettled intent for one operation.
    pub fn commit(
        &mut self,
        receipt: SecretMutationReceiptV1,
        record: SecretRecordV1,
        now_ms: u64,
    ) -> Result<(), SecretJournalErrorV1> {
        validate_receipt(&receipt)?;
        if receipt.receipt_digest != receipt_core_digest(&receipt) {
            return Err(SecretJournalErrorV1::Invalid);
        }
        if receipt.secret_ref != record.secret_ref
            || receipt.provider_id != record.provider_id
            || receipt.resulting_version != record.version
            || receipt.label != record.label
            || (receipt.operation == "revoke") != record.revoked
            || record.version == 0
        {
            return Err(SecretJournalErrorV1::Invalid);
        }
        if let Some(existing) = self.receipt(&receipt.idempotency_key) {
            return if existing == &receipt {
                Ok(())
            } else {
                Err(SecretJournalErrorV1::IdempotencyConflict)
            };
        }
        if self.receipts.len() >= MAX_RECEIPTS {
            return Err(SecretJournalErrorV1::Capacity);
        }
        let mut records = self.records.clone();
        if records
            .insert(record.secret_ref.clone(), record)
            .is_none()
            && records.len() > MAX_SECRETS
        {
            return Err(SecretJournalErrorV1::Capacity);
        }
        let mut receipts = self.receipts.clone();
        receipts.push_back(receipt.clone());
        while receipts.len() > MAX_RECEIPTS {
            receipts.pop_front();
        }
        let mut intents = self.intents.clone();
        intents.remove(&receipt.idempotency_key);
        self.commit_snapshot("receipt", records, receipts, intents, now_ms)
    }

    fn commit_snapshot(
        &mut self,
        operation: &str,
        records: BTreeMap<String, SecretRecordV1>,
        receipts: VecDeque<SecretMutationReceiptV1>,
        intents: BTreeMap<String, SecretMutationIntentV1>,
        now_ms: u64,
    ) -> Result<(), SecretJournalErrorV1> {
        if now_ms > MAX_SAFE_EVENT_TIME_MS {
            return Err(SecretJournalErrorV1::Invalid);
        }
        let bytes = encode_snapshot(&self.scope_digest, &records, &receipts, &intents)?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(SecretJournalErrorV1::Capacity);
        }
        let snapshot_json =
            String::from_utf8(bytes).map_err(|_| SecretJournalErrorV1::Corrupt)?;
        let delivery_id = format!(
            "secret-mutation-{}-{}",
            Digest::from_blake3(self.scope_digest.as_bytes()).to_hex(),
            self.commits + 1
        );
        let event = OwnerEventInput {
            schema_version: OWNER_EVENT_SCHEMA_VERSION_V1,
            time_ms: self.last_time_ms.max(now_ms),
            kind: JOURNAL_EVENT_KIND.to_owned(),
            data: serde_json::json!({
                "operation": operation,
                "snapshotJson": snapshot_json,
            }),
            delivery_id: None,
            command_digest: None,
        };
        let events = [event];
        let digest = OwnerLogV2::command_digest(&delivery_id, &events)
            .map_err(|error| SecretJournalErrorV1::Persistence(error.to_string()))?;
        self.log
            .append_batch(&delivery_id, &digest, &events, None)
            .map_err(|error| SecretJournalErrorV1::Persistence(error.to_string()))?;
        self.records = records;
        self.receipts = receipts;
        self.intents = intents;
        self.commits = self.commits.saturating_add(1);
        self.last_time_ms = self.last_time_ms.max(now_ms);
        Ok(())
    }

    fn replay(
        log: &OwnerLogV2,
    ) -> Result<(Option<Vec<u8>>, u64, u64), SecretJournalErrorV1> {
        let limit = NonZeroUsize::new(MAX_OWNER_READ_BATCH_EVENTS)
            .expect("owner-log read batch limit is nonzero");
        let mut cursor: Option<CursorV1> = None;
        let mut scanned = 0_u64;
        let mut commits = 0_u64;
        let mut last_time_ms = 0_u64;
        let mut snapshot = None;
        loop {
            let batch = log
                .read_after(cursor.as_ref(), limit)
                .map_err(|error| SecretJournalErrorV1::Persistence(error.to_string()))?;
            scanned = scanned
                .checked_add(batch.events.len() as u64)
                .ok_or(SecretJournalErrorV1::Corrupt)?;
            if scanned > MAX_JOURNAL_RECORDS {
                return Err(SecretJournalErrorV1::Capacity);
            }
            for record in &batch.events {
                last_time_ms = last_time_ms.max(record.time_ms);
                if record.kind != JOURNAL_EVENT_KIND {
                    return Err(SecretJournalErrorV1::Corrupt);
                }
                let encoded = record
                    .data
                    .get("payload")
                    .and_then(|payload| payload.get("snapshotJson"))
                    .and_then(JsonValue::as_str)
                    .ok_or(SecretJournalErrorV1::Corrupt)?;
                snapshot = Some(encoded.as_bytes().to_vec());
                commits = commits.saturating_add(1);
            }
            match batch.cursor {
                Some(next) if batch.has_more => cursor = Some(next),
                _ => break,
            }
        }
        Ok((snapshot, commits, last_time_ms))
    }
}

fn check_target(
    record: &SecretRecordV1,
    provider_id: &str,
    expected_version: u64,
) -> Result<(), SecretJournalErrorV1> {
    if record.version != expected_version {
        return Err(SecretJournalErrorV1::StaleVersion {
            expected: expected_version,
            actual: record.version,
        });
    }
    if record.provider_id != provider_id {
        return Err(SecretJournalErrorV1::ProviderMismatch);
    }
    if record.revoked {
        return Err(SecretJournalErrorV1::Revoked);
    }
    Ok(())
}

fn validate_intent(intent: &SecretMutationIntentV1) -> Result<(), SecretJournalErrorV1> {
    if !valid_text(&intent.idempotency_key, MAX_ID_BYTES)
        || !valid_digest(&intent.request_digest)
        || !matches!(intent.operation.as_str(), "put" | "rotate" | "revoke")
        || !valid_wire_id(&intent.provider_id)
        || !valid_wire_id(&intent.secret_ref)
        || intent.resulting_version == 0
        || intent
            .label
            .as_deref()
            .is_some_and(|label| !valid_label(label))
        || !valid_wire_id(&intent.challenge_id)
        || !valid_wire_id(&intent.effect_id)
        || !valid_wire_id(&intent.user_action_id)
        || !valid_digest(&intent.effect_intent_digest)
        || !valid_digest(&intent.capability_lease_digest)
        || intent.created_at_ms > MAX_SAFE_EVENT_TIME_MS
    {
        return Err(SecretJournalErrorV1::Invalid);
    }
    Ok(())
}

fn validate_receipt(receipt: &SecretMutationReceiptV1) -> Result<(), SecretJournalErrorV1> {
    if !valid_text(&receipt.idempotency_key, MAX_ID_BYTES)
        || !valid_digest(&receipt.request_digest)
        || !matches!(receipt.operation.as_str(), "put" | "rotate" | "revoke")
        || !valid_wire_id(&receipt.provider_id)
        || !valid_wire_id(&receipt.secret_ref)
        || receipt.resulting_version == 0
        || receipt
            .label
            .as_deref()
            .is_some_and(|label| !valid_label(label))
        || !valid_wire_id(&receipt.challenge_id)
        || !valid_wire_id(&receipt.effect_id)
        || !valid_wire_id(&receipt.user_action_id)
        || !valid_digest(&receipt.effect_intent_digest)
        || !valid_digest(&receipt.capability_lease_digest)
        || !valid_digest(&receipt.receipt_digest)
        || !valid_wire_id(&receipt.grant_id)
        || receipt.expires_at_ms > MAX_SAFE_EVENT_TIME_MS
        || receipt.committed_at_ms > MAX_SAFE_EVENT_TIME_MS
        || (receipt.operation == "revoke") != receipt.revoked_version.is_some()
    {
        return Err(SecretJournalErrorV1::Invalid);
    }
    Ok(())
}
pub fn valid_digest(value: &str) -> bool {
    value.strip_prefix("blake3:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && !value.chars().any(char::is_control)
        && !value.contains('\0')
}

fn valid_wire_id(value: &str) -> bool {
    valid_text(value, MAX_ID_BYTES)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

fn valid_label(value: &str) -> bool {
    valid_text(value, MAX_LABEL_BYTES)
}

fn unix_ms() -> Result<u64, SecretJournalErrorV1> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .map_err(|_| SecretJournalErrorV1::Persistence("system clock unavailable".to_owned()))
}

fn record_to_json(record: &SecretRecordV1) -> JsonValue {
    serde_json::json!({
        "secretRef": record.secret_ref,
        "providerId": record.provider_id,
        "label": record.label,
        "revoked": record.revoked,
        "version": record.version,
        "createdAtMs": record.created_at_ms,
        "updatedAtMs": record.updated_at_ms,
    })
}

fn receipt_to_json(receipt: &SecretMutationReceiptV1) -> JsonValue {
    serde_json::json!({
        "idempotencyKey": receipt.idempotency_key,
        "requestDigest": receipt.request_digest,
        "operation": receipt.operation,
        "providerId": receipt.provider_id,
        "secretRef": receipt.secret_ref,
        "expectedVersion": receipt.expected_version,
        "resultingVersion": receipt.resulting_version,
        "revokedVersion": receipt.revoked_version,
        "label": receipt.label,
        "challengeId": receipt.challenge_id,
        "effectId": receipt.effect_id,
        "userActionId": receipt.user_action_id,
        "effectIntentDigest": receipt.effect_intent_digest,
        "capabilityLeaseDigest": receipt.capability_lease_digest,
        "expiresAtMs": receipt.expires_at_ms,
        "grantId": receipt.grant_id,
        "receiptDigest": receipt.receipt_digest,
        "committedAtMs": receipt.committed_at_ms,
    })
}

fn intent_to_json(intent: &SecretMutationIntentV1) -> JsonValue {
    serde_json::json!({
        "idempotencyKey": intent.idempotency_key,
        "requestDigest": intent.request_digest,
        "operation": intent.operation,
        "providerId": intent.provider_id,
        "secretRef": intent.secret_ref,
        "expectedVersion": intent.expected_version,
        "resultingVersion": intent.resulting_version,
        "label": intent.label,
        "challengeId": intent.challenge_id,
        "effectId": intent.effect_id,
        "userActionId": intent.user_action_id,
        "effectIntentDigest": intent.effect_intent_digest,
        "capabilityLeaseDigest": intent.capability_lease_digest,
        "createdAtMs": intent.created_at_ms,
    })
}

fn encode_snapshot(
    scope_digest: &str,
    records: &BTreeMap<String, SecretRecordV1>,
    receipts: &VecDeque<SecretMutationReceiptV1>,
    intents: &BTreeMap<String, SecretMutationIntentV1>,
) -> Result<Vec<u8>, SecretJournalErrorV1> {
    let value = serde_json::json!({
        "format": SNAPSHOT_FORMAT,
        "scopeDigest": scope_digest,
        "secrets": records
            .values()
            .map(record_to_json)
            .collect::<Vec<JsonValue>>(),
        "receipts": receipts
            .iter()
            .map(receipt_to_json)
            .collect::<Vec<JsonValue>>(),
        "intents": intents
            .values()
            .map(intent_to_json)
            .collect::<Vec<JsonValue>>(),
    });
    serde_json::to_vec(&value).map_err(|_| SecretJournalErrorV1::Corrupt)
}
fn decode_snapshot(
    bytes: &[u8],
    scope_digest: &str,
) -> Result<
    (
        BTreeMap<String, SecretRecordV1>,
        VecDeque<SecretMutationReceiptV1>,
        BTreeMap<String, SecretMutationIntentV1>,
    ),
    SecretJournalErrorV1,
> {
    let value: JsonValue =
        serde_json::from_slice(bytes).map_err(|_| SecretJournalErrorV1::Corrupt)?;
    if serde_json::to_vec(&value).map_err(|_| SecretJournalErrorV1::Corrupt)? != bytes {
        return Err(SecretJournalErrorV1::Corrupt);
    }
    let object = value
        .as_object()
        .filter(|object| object.len() == 5)
        .ok_or(SecretJournalErrorV1::Corrupt)?;
    if object.get("format").and_then(JsonValue::as_str) != Some(SNAPSHOT_FORMAT)
        || object.get("scopeDigest").and_then(JsonValue::as_str) != Some(scope_digest)
    {
        return Err(SecretJournalErrorV1::Corrupt);
    }
    let secrets = object
        .get("secrets")
        .and_then(JsonValue::as_array)
        .filter(|values| values.len() <= MAX_SECRETS)
        .ok_or(SecretJournalErrorV1::Corrupt)?;
    let mut records = BTreeMap::new();
    let mut previous: Option<String> = None;
    for value in secrets {
        let record = decode_record(value)?;
        if previous
            .as_ref()
            .is_some_and(|prior| prior >= &record.secret_ref)
        {
            return Err(SecretJournalErrorV1::Corrupt);
        }
        previous = Some(record.secret_ref.clone());
        if records
            .insert(record.secret_ref.clone(), record)
            .is_some()
        {
            return Err(SecretJournalErrorV1::Corrupt);
        }
    }
    let receipts = object
        .get("receipts")
        .and_then(JsonValue::as_array)
        .filter(|values| values.len() <= MAX_RECEIPTS)
        .ok_or(SecretJournalErrorV1::Corrupt)?;
    let mut receipt_queue = VecDeque::new();
    let mut receipt_keys = std::collections::BTreeSet::new();
    for value in receipts {
        let receipt = decode_receipt(value)?;
        if !receipt_keys.insert(receipt.idempotency_key.clone())
            || !records.contains_key(&receipt.secret_ref)
        {
            return Err(SecretJournalErrorV1::Corrupt);
        }
        receipt_queue.push_back(receipt);
    }
    let intents = object
        .get("intents")
        .and_then(JsonValue::as_array)
        .filter(|values| values.len() <= MAX_INTENTS)
        .ok_or(SecretJournalErrorV1::Corrupt)?;
    let mut intent_map = BTreeMap::new();
    for value in intents {
        let intent = decode_intent(value)?;
        if intent_map
            .insert(intent.idempotency_key.clone(), intent)
            .is_some()
        {
            return Err(SecretJournalErrorV1::Corrupt);
        }
    }
    Ok((records, receipt_queue, intent_map))
}

fn json_object<'a>(
    value: &'a JsonValue,
    fields: usize,
) -> Result<&'a serde_json::Map<String, JsonValue>, SecretJournalErrorV1> {
    value
        .as_object()
        .filter(|object| object.len() == fields)
        .ok_or(SecretJournalErrorV1::Corrupt)
}

fn json_text<'a>(
    object: &'a serde_json::Map<String, JsonValue>,
    key: &str,
) -> Result<&'a str, SecretJournalErrorV1> {
    object
        .get(key)
        .and_then(JsonValue::as_str)
        .ok_or(SecretJournalErrorV1::Corrupt)
}

fn json_optional_text(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
) -> Result<Option<String>, SecretJournalErrorV1> {
    match object.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(value)) if valid_text(value, MAX_LABEL_BYTES) => {
            Ok(Some(value.clone()))
        }
        _ => Err(SecretJournalErrorV1::Corrupt),
    }
}

fn json_u64(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
) -> Result<u64, SecretJournalErrorV1> {
    object
        .get(key)
        .and_then(JsonValue::as_u64)
        .ok_or(SecretJournalErrorV1::Corrupt)
}

fn json_optional_u64(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
) -> Result<Option<u64>, SecretJournalErrorV1> {
    match object.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or(SecretJournalErrorV1::Corrupt),
    }
}

fn json_bool(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
) -> Result<bool, SecretJournalErrorV1> {
    object
        .get(key)
        .and_then(JsonValue::as_bool)
        .ok_or(SecretJournalErrorV1::Corrupt)
}

fn decode_record(value: &JsonValue) -> Result<SecretRecordV1, SecretJournalErrorV1> {
    let object = json_object(value, 7)?;
    let secret_ref = json_text(object, "secretRef")?.to_owned();
    let provider_id = json_text(object, "providerId")?.to_owned();
    let label = json_optional_text(object, "label")?;
    let version = json_u64(object, "version")?;
    let created_at_ms = json_u64(object, "createdAtMs")?;
    let updated_at_ms = json_u64(object, "updatedAtMs")?;
    if !valid_wire_id(&secret_ref)
        || !valid_wire_id(&provider_id)
        || label.as_deref().is_some_and(|label| !valid_label(label))
        || version == 0
        || created_at_ms > MAX_SAFE_EVENT_TIME_MS
        || updated_at_ms > MAX_SAFE_EVENT_TIME_MS
        || updated_at_ms < created_at_ms
    {
        return Err(SecretJournalErrorV1::Corrupt);
    }
    Ok(SecretRecordV1 {
        secret_ref,
        provider_id,
        label,
        revoked: json_bool(object, "revoked")?,
        version,
        created_at_ms,
        updated_at_ms,
    })
}

fn decode_receipt(value: &JsonValue) -> Result<SecretMutationReceiptV1, SecretJournalErrorV1> {
    let object = json_object(value, 18)?;
    let receipt = SecretMutationReceiptV1 {
        idempotency_key: json_text(object, "idempotencyKey")?.to_owned(),
        request_digest: json_text(object, "requestDigest")?.to_owned(),
        operation: json_text(object, "operation")?.to_owned(),
        provider_id: json_text(object, "providerId")?.to_owned(),
        secret_ref: json_text(object, "secretRef")?.to_owned(),
        expected_version: json_optional_u64(object, "expectedVersion")?,
        resulting_version: json_u64(object, "resultingVersion")?,
        revoked_version: json_optional_u64(object, "revokedVersion")?,
        label: json_optional_text(object, "label")?,
        challenge_id: json_text(object, "challengeId")?.to_owned(),
        effect_id: json_text(object, "effectId")?.to_owned(),
        user_action_id: json_text(object, "userActionId")?.to_owned(),
        effect_intent_digest: json_text(object, "effectIntentDigest")?.to_owned(),
        capability_lease_digest: json_text(object, "capabilityLeaseDigest")?.to_owned(),
        expires_at_ms: json_u64(object, "expiresAtMs")?,
        grant_id: json_text(object, "grantId")?.to_owned(),
        receipt_digest: json_text(object, "receiptDigest")?.to_owned(),
        committed_at_ms: json_u64(object, "committedAtMs")?,
    };
    validate_receipt(&receipt)?;
    if receipt.receipt_digest != receipt_core_digest(&receipt) {
        return Err(SecretJournalErrorV1::Corrupt);
    }
    Ok(receipt)
}

fn decode_intent(value: &JsonValue) -> Result<SecretMutationIntentV1, SecretJournalErrorV1> {
    let object = json_object(value, 14)?;
    let intent = SecretMutationIntentV1 {
        idempotency_key: json_text(object, "idempotencyKey")?.to_owned(),
        request_digest: json_text(object, "requestDigest")?.to_owned(),
        operation: json_text(object, "operation")?.to_owned(),
        provider_id: json_text(object, "providerId")?.to_owned(),
        secret_ref: json_text(object, "secretRef")?.to_owned(),
        expected_version: json_optional_u64(object, "expectedVersion")?,
        resulting_version: json_u64(object, "resultingVersion")?,
        label: json_optional_text(object, "label")?,
        challenge_id: json_text(object, "challengeId")?.to_owned(),
        effect_id: json_text(object, "effectId")?.to_owned(),
        user_action_id: json_text(object, "userActionId")?.to_owned(),
        effect_intent_digest: json_text(object, "effectIntentDigest")?.to_owned(),
        capability_lease_digest: json_text(object, "capabilityLeaseDigest")?.to_owned(),
        created_at_ms: json_u64(object, "createdAtMs")?,
    };
    validate_intent(&intent)?;
    Ok(intent)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn root() -> std::path::PathBuf {
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hz-secret-journal-{}-{tick}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    fn scope() -> String {
        format!("blake3:{}", "a".repeat(64))
    }

    fn intent(key: &str, operation: &str, version: u64) -> SecretMutationIntentV1 {
        SecretMutationIntentV1 {
            idempotency_key: key.to_owned(),
            request_digest: format!("blake3:{}", "b".repeat(64)),
            operation: operation.to_owned(),
            provider_id: "openai".to_owned(),
            secret_ref: "secret_test".to_owned(),
            expected_version: (operation != "put").then_some(1),
            resulting_version: version,
            label: Some("test".to_owned()),
            challenge_id: "ch_secret_test".to_owned(),
            effect_id: "eff_secret_test".to_owned(),
            user_action_id: "act_secret_test".to_owned(),
            effect_intent_digest: format!("blake3:{}", "c".repeat(64)),
            capability_lease_digest: format!("blake3:{}", "d".repeat(64)),
            created_at_ms: 1,
        }
    }

    fn receipt(key: &str, operation: &str, version: u64) -> SecretMutationReceiptV1 {
        let mut receipt = SecretMutationReceiptV1 {
            idempotency_key: key.to_owned(),
            request_digest: format!("blake3:{}", "b".repeat(64)),
            operation: operation.to_owned(),
            provider_id: "openai".to_owned(),
            secret_ref: "secret_test".to_owned(),
            expected_version: (operation != "put").then_some(1),
            resulting_version: version,
            revoked_version: (operation == "revoke").then_some(1),
            label: Some("test".to_owned()),
            challenge_id: "ch_secret_test".to_owned(),
            effect_id: "eff_secret_test".to_owned(),
            user_action_id: "act_secret_test".to_owned(),
            effect_intent_digest: format!("blake3:{}", "c".repeat(64)),
            capability_lease_digest: format!("blake3:{}", "d".repeat(64)),
            expires_at_ms: 10,
            grant_id: "secret_grant_test".to_owned(),
            receipt_digest: String::new(),
            committed_at_ms: 2,
        };
        receipt.receipt_digest = receipt_core_digest(&receipt);
        receipt
    }

    fn record(version: u64, revoked: bool) -> SecretRecordV1 {
        SecretRecordV1 {
            secret_ref: "secret_test".to_owned(),
            provider_id: "openai".to_owned(),
            label: Some("test".to_owned()),
            revoked,
            version,
            created_at_ms: 1,
            updated_at_ms: 2,
        }
    }

    #[test]
    fn version_fencing_and_receipt_replay_survive_reopen() {
        let root = root();
        let scope = scope();
        let mut journal = SecretMutationJournalV1::open(&root, &scope).unwrap();
        journal.append_intent(intent("idem-1", "put", 1)).unwrap();
        assert!(journal.has_unsettled_for_target("secret_test"));
        journal
            .commit(receipt("idem-1", "put", 1), record(1, false), 2)
            .unwrap();
        assert!(!journal.has_unsettled_for_target("secret_test"));
        assert_eq!(journal.validate_rotate("secret_test", "openai", 1), Ok(2));
        assert!(matches!(
            journal.validate_rotate("secret_test", "openai", 2),
            Err(SecretJournalErrorV1::StaleVersion { .. })
        ));
        assert_eq!(
            journal.validate_rotate("secret_test", "other", 1),
            Err(SecretJournalErrorV1::ProviderMismatch)
        );
        drop(journal);
        let reopened = SecretMutationJournalV1::open(&root, &scope).unwrap();
        assert_eq!(
            reopened
                .receipt("idem-1")
                .map(|receipt| receipt.receipt_digest.clone()),
            Some(receipt("idem-1", "put", 1).receipt_digest)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn intent_without_receipt_is_unsettled_and_blocks_replacement() {
        let root = root();
        let mut journal = SecretMutationJournalV1::open(&root, &scope()).unwrap();
        journal.append_intent(intent("idem-1", "rotate", 2)).unwrap();
        assert!(journal.receipt("idem-1").is_none());
        assert!(journal.has_unsettled_for_target("secret_test"));
        assert!(matches!(
            journal.append_intent(intent("idem-1", "put", 1)),
            Err(SecretJournalErrorV1::IdempotencyConflict)
        ));
        let _ = fs::remove_dir_all(root);
    }
}
