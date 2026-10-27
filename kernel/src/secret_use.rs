//! Durable one-use SecretBroker **use** authorization for `secret.v1`.
//!
//! This journal contains metadata only. Credential bytes are never accepted,
//! derived, logged or persisted here: the trusted in-process broker remains the
//! sole owner of secret material. A `SecretUseLeaseV1` records the exact
//! owner-scoped target version, provider, destination, purpose and operation
//! digest allowed for one provider request, a bounded expiry, and a durable
//! receipt. Redemption transitions the lease to CONSUMED exactly once; a second
//! redemption of a consumed lease always fails closed.
//!
//! The lease is a metadata projection, not a credential handle. It never grants
//! access to another owner scope: the owner scope is a domain-separated digest
//! derived by `HostKernel` from the authenticated principal, and `HostKernel`
//! requires that same principal to redeem it.

use crate::owner_log::{
    Digest, DurabilityProfile, MAX_OWNER_READ_BATCH_EVENTS, OWNER_EVENT_SCHEMA_VERSION_V1,
    OwnerEventInput, OwnerIdentity, OwnerLogError, OwnerLogV2,
};
use crate::protocol::CursorV1;
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, VecDeque};
use std::num::NonZeroUsize;
use std::path::Path;

const JOURNAL_OWNER_KIND: &str = "secret_use";
const JOURNAL_EVENT_KIND: &str = "secret.use.transition.v1";
const SNAPSHOT_FORMAT: &str = "horizon.secret-use.v1";
const MAX_LEASES: usize = 256;
const MAX_REDEMPTIONS: usize = 256;
const MAX_INTENTS: usize = 64;
const MAX_JOURNAL_RECORDS: u64 = 65_536;
const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_ID_BYTES: usize = 256;
const MAX_PURPOSE_BYTES: usize = 64;
const MAX_SAFE_EVENT_TIME_MS: u64 = 9_007_199_254_740_991;

/// The only purpose accepted by the V1 provider-use contract.
pub const USE_PURPOSE_PROVIDER_REQUEST: &str = "PROVIDER_REQUEST";
/// Maximum authorized use window: 120 seconds from issuance.
pub const MAX_USE_TTL_MS: u64 = 120_000;
/// Maximum destination length for a metadata-only provider request.
pub const MAX_USE_DESTINATION_BYTES: usize = 2_048;

/// The immutable one-use lease projection minted by `authorize_use`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretUseLeaseV1 {
    pub lease_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub secret_ref: String,
    pub secret_version: u64,
    pub provider_id: String,
    pub operation_digest: String,
    pub destination: String,
    pub purpose: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub challenge_id: String,
    pub effect_id: String,
    pub user_action_id: String,
    pub effect_intent_digest: String,
    pub capability_lease_digest: String,
}

/// Durable grant record: the exact lease plus its receipt digest. The receipt is
/// derived only from the lease core and the commit time, so replay can verify it
/// without storing a second copy of the projection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretUseGrantV1 {
    pub lease: SecretUseLeaseV1,
    pub committed_at_ms: u64,
    pub receipt_digest: String,
}

/// PREPARED intent persisted before the Guard/EffectHost dispatch begins. A
/// later request for the same key sees this intent and fails closed as UNKNOWN
/// until the exact durable receipt resolves it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretUseIntentV1 {
    pub idempotency_key: String,
    pub request_digest: String,
    pub secret_ref: String,
    pub provider_id: String,
    pub operation_digest: String,
    pub destination: String,
    pub purpose: String,
    pub expires_at_ms: u64,
    pub challenge_id: String,
    pub effect_id: String,
    pub user_action_id: String,
    pub effect_intent_digest: String,
    pub capability_lease_digest: String,
    pub created_at_ms: u64,
}

/// Durable proof that one lease was redeemed once by the calling owner scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretUseRedemptionV1 {
    pub lease_id: String,
    pub lease_receipt_digest: String,
    pub redeem_key: String,
    pub redeemed_at_ms: u64,
    pub redemption_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretUseJournalErrorV1 {
    Invalid,
    NotFound,
    Conflict,
    Expired,
    Consumed,
    Capacity,
    Unsettled,
    Corrupt,
    Persistence(String),
}

impl std::fmt::Display for SecretUseJournalErrorV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "secret use journal error: {self:?}")
    }
}

impl std::error::Error for SecretUseJournalErrorV1 {}

/// Domain-separated digest of the immutable lease core. `receipt_digest` is not
/// part of the lease, so the digest cannot hash itself.
pub fn lease_core_digest(lease: &SecretUseLeaseV1) -> String {
    let version = lease.secret_version.to_string();
    let issued = lease.issued_at_ms.to_string();
    let expires = lease.expires_at_ms.to_string();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.secret-use-lease.v1\0");
    for field in [
        lease.lease_id.as_bytes(),
        lease.idempotency_key.as_bytes(),
        lease.request_digest.as_bytes(),
        lease.secret_ref.as_bytes(),
        version.as_bytes(),
        lease.provider_id.as_bytes(),
        lease.operation_digest.as_bytes(),
        lease.destination.as_bytes(),
        lease.purpose.as_bytes(),
        issued.as_bytes(),
        expires.as_bytes(),
        lease.challenge_id.as_bytes(),
        lease.effect_id.as_bytes(),
        lease.user_action_id.as_bytes(),
        lease.effect_intent_digest.as_bytes(),
        lease.capability_lease_digest.as_bytes(),
    ] {
        hasher.update(&(field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

/// Durable receipt digest over the lease core and the exact commit time.
pub fn receipt_digest(lease: &SecretUseLeaseV1, committed_at_ms: u64) -> String {
    let core = lease_core_digest(lease);
    let committed = committed_at_ms.to_string();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.secret-use-receipt.v1\0");
    for field in [core.as_bytes(), committed.as_bytes()] {
        hasher.update(&(field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn redemption_core_digest(
    lease_id: &str,
    lease_receipt_digest: &str,
    redeem_key: &str,
    redeemed_at_ms: u64,
) -> String {
    let redeemed = redeemed_at_ms.to_string();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.secret-use-redemption.v1\0");
    for field in [
        lease_id.as_bytes(),
        lease_receipt_digest.as_bytes(),
        redeem_key.as_bytes(),
        redeemed.as_bytes(),
    ] {
        hasher.update(&(field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

pub struct SecretUseJournalV1 {
    log: OwnerLogV2,
    scope_digest: String,
    /// Insertion-keyed by `idempotency_key`.
    grants: BTreeMap<String, SecretUseGrantV1>,
    /// Derived index: `lease_id` -> `idempotency_key`.
    leases: BTreeMap<String, String>,
    redemptions: BTreeMap<String, SecretUseRedemptionV1>,
    intents: BTreeMap<String, SecretUseIntentV1>,
    commits: u64,
    last_time_ms: u64,
}

impl SecretUseJournalV1 {
    pub fn open(root: &Path, scope_digest: &str) -> Result<Self, SecretUseJournalErrorV1> {
        if !valid_digest(scope_digest) {
            return Err(SecretUseJournalErrorV1::Invalid);
        }
        let owner =
            OwnerIdentity::new(JOURNAL_OWNER_KIND.to_owned(), scope_digest.to_owned())
                .map_err(|error| SecretUseJournalErrorV1::Persistence(error.to_string()))?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)
            .map_err(|error| SecretUseJournalErrorV1::Persistence(error.to_string()))?;
        let (snapshot, commits, last_time_ms) = Self::replay(&log)?;
        let (grants, redemptions, intents) = match snapshot {
            Some(bytes) => decode_snapshot(&bytes, scope_digest)?,
            None => (BTreeMap::new(), BTreeMap::new(), BTreeMap::new()),
        };
        let leases = index_leases(&grants)?;
        Ok(Self {
            log,
            scope_digest: scope_digest.to_owned(),
            grants,
            leases,
            redemptions,
            intents,
            commits,
            last_time_ms,
        })
    }

    pub fn grant_for_key(&self, idempotency_key: &str) -> Option<&SecretUseGrantV1> {
        self.grants.get(idempotency_key)
    }

    pub fn grant_for_lease(&self, lease_id: &str) -> Option<&SecretUseGrantV1> {
        self.leases
            .get(lease_id)
            .and_then(|key| self.grants.get(key))
    }

    pub fn redemption(&self, lease_id: &str) -> Option<&SecretUseRedemptionV1> {
        self.redemptions.get(lease_id)
    }

    pub fn intent(&self, idempotency_key: &str) -> Option<&SecretUseIntentV1> {
        self.intents.get(idempotency_key)
    }

    /// Durably pin the PREPARED intent before Guard/EffectHost dispatch.
    pub fn append_intent(
        &mut self,
        intent: SecretUseIntentV1,
    ) -> Result<(), SecretUseJournalErrorV1> {
        validate_intent(&intent)?;
        if self.grants.contains_key(&intent.idempotency_key) {
            return Err(SecretUseJournalErrorV1::Conflict);
        }
        if let Some(existing) = self.intents.get(&intent.idempotency_key) {
            return if existing == &intent {
                Ok(())
            } else {
                Err(SecretUseJournalErrorV1::Conflict)
            };
        }
        if self.intents.len() >= MAX_INTENTS {
            return Err(SecretUseJournalErrorV1::Capacity);
        }
        let mut intents = self.intents.clone();
        intents.insert(intent.idempotency_key.clone(), intent);
        self.commit_snapshot(
            "intent",
            self.grants.clone(),
            self.redemptions.clone(),
            intents,
            unix_ms()?,
        )
    }

    /// Atomically persist the issued lease and its exact receipt, removing any
    /// matching PREPARED intent in the same owner-log transition.
    pub fn commit_lease(
        &mut self,
        grant: SecretUseGrantV1,
        now_ms: u64,
    ) -> Result<(), SecretUseJournalErrorV1> {
        validate_grant(&grant)?;
        if grant.receipt_digest != receipt_digest(&grant.lease, grant.committed_at_ms) {
            return Err(SecretUseJournalErrorV1::Invalid);
        }
        if let Some(existing) = self.grants.get(&grant.lease.idempotency_key) {
            return if existing == &grant {
                Ok(())
            } else {
                Err(SecretUseJournalErrorV1::Conflict)
            };
        }
        if let Some(redemption) = self.redemptions.get(&grant.lease.lease_id) {
            return if redemption.lease_receipt_digest == grant.receipt_digest {
                Ok(())
            } else {
                Err(SecretUseJournalErrorV1::Conflict)
            };
        }
        let committed_key = grant.lease.idempotency_key.clone();
        let mut grants = self.grants.clone();
        grants.insert(committed_key.clone(), grant);
        let mut redemptions = self.redemptions.clone();
        // Never let capacity eviction discard the lease being committed.
        trim_grants(&mut grants, &mut redemptions, Some(&committed_key))?;
        let mut intents = self.intents.clone();
        // Remove the exact intent for every committed key.
        for key in grants.keys() {
            intents.remove(key);
        }
        self.commit_snapshot("receipt", grants, redemptions, intents, now_ms)
    }

    /// Transition one ISSUED lease to CONSUMED exactly once. A consumed or
    /// expired lease is never redeemable again, including after a restart.
    pub fn redeem(
        &mut self,
        lease_id: &str,
        redeem_key: &str,
        now_ms: u64,
    ) -> Result<SecretUseRedemptionV1, SecretUseJournalErrorV1> {
        if !valid_wire_id(lease_id) || !valid_text(redeem_key, MAX_ID_BYTES) {
            return Err(SecretUseJournalErrorV1::Invalid);
        }
        let grant = self
            .grant_for_lease(lease_id)
            .cloned()
            .ok_or(SecretUseJournalErrorV1::NotFound)?;
        if self.redemptions.contains_key(lease_id) {
            return Err(SecretUseJournalErrorV1::Consumed);
        }
        if now_ms >= grant.lease.expires_at_ms {
            return Err(SecretUseJournalErrorV1::Expired);
        }
        if now_ms > MAX_SAFE_EVENT_TIME_MS || now_ms < grant.lease.issued_at_ms {
            return Err(SecretUseJournalErrorV1::Invalid);
        }
        let redemption = SecretUseRedemptionV1 {
            lease_id: lease_id.to_owned(),
            lease_receipt_digest: grant.receipt_digest.clone(),
            redeem_key: redeem_key.to_owned(),
            redeemed_at_ms: now_ms,
            redemption_digest: redemption_core_digest(
                lease_id,
                &grant.receipt_digest,
                redeem_key,
                now_ms,
            ),
        };
        let mut redemptions = self.redemptions.clone();
        redemptions.insert(lease_id.to_owned(), redemption.clone());
        let mut grants = self.grants.clone();
        trim_grants(&mut grants, &mut redemptions, None)?;
        self.commit_snapshot("redemption", grants, redemptions, self.intents.clone(), now_ms)?;
        Ok(redemption)
    }

    fn commit_snapshot(
        &mut self,
        operation: &str,
        grants: BTreeMap<String, SecretUseGrantV1>,
        redemptions: BTreeMap<String, SecretUseRedemptionV1>,
        intents: BTreeMap<String, SecretUseIntentV1>,
        now_ms: u64,
    ) -> Result<(), SecretUseJournalErrorV1> {
        if now_ms > MAX_SAFE_EVENT_TIME_MS {
            return Err(SecretUseJournalErrorV1::Invalid);
        }
        let leases = index_leases(&grants)?;
        let bytes = encode_snapshot(&self.scope_digest, &grants, &redemptions, &intents)?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(SecretUseJournalErrorV1::Capacity);
        }
        let snapshot_json =
            String::from_utf8(bytes).map_err(|_| SecretUseJournalErrorV1::Corrupt)?;
        let delivery_id = format!(
            "secret-use-{}-{}",
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
            .map_err(|error| SecretUseJournalErrorV1::Persistence(error.to_string()))?;
        self.log
            .append_batch(&delivery_id, &digest, &events, None)
            .map_err(|error| SecretUseJournalErrorV1::Persistence(error.to_string()))?;
        self.grants = grants;
        self.leases = leases;
        self.redemptions = redemptions;
        self.intents = intents;
        self.commits = self.commits.saturating_add(1);
        self.last_time_ms = self.last_time_ms.max(now_ms);
        Ok(())
    }

    fn replay(
        log: &OwnerLogV2,
    ) -> Result<(Option<Vec<u8>>, u64, u64), SecretUseJournalErrorV1> {
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
                .map_err(|error| SecretUseJournalErrorV1::Persistence(error.to_string()))?;
            scanned = scanned
                .checked_add(batch.events.len() as u64)
                .ok_or(SecretUseJournalErrorV1::Corrupt)?;
            if scanned > MAX_JOURNAL_RECORDS {
                return Err(SecretUseJournalErrorV1::Capacity);
            }
            for record in &batch.events {
                last_time_ms = last_time_ms.max(record.time_ms);
                if record.kind != JOURNAL_EVENT_KIND {
                    return Err(SecretUseJournalErrorV1::Corrupt);
                }
                let encoded = record
                    .data
                    .get("payload")
                    .and_then(|payload| payload.get("snapshotJson"))
                    .and_then(JsonValue::as_str)
                    .ok_or(SecretUseJournalErrorV1::Corrupt)?;
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

fn index_leases(
    grants: &BTreeMap<String, SecretUseGrantV1>,
) -> Result<BTreeMap<String, String>, SecretUseJournalErrorV1> {
    let mut leases = BTreeMap::new();
    for (key, grant) in grants {
        if leases
            .insert(grant.lease.lease_id.clone(), key.clone())
            .is_some()
        {
            return Err(SecretUseJournalErrorV1::Corrupt);
        }
    }
    Ok(leases)
}

/// Evict the oldest committed lease (deterministic tiebreak by key) when the
/// bounded journal is full, together with its redemption record. Eviction is
/// fail-closed for the evicted lease: it is no longer replayable or redeemable.
fn trim_grants(
    grants: &mut BTreeMap<String, SecretUseGrantV1>,
    redemptions: &mut BTreeMap<String, SecretUseRedemptionV1>,
    protected: Option<&str>,
) -> Result<(), SecretUseJournalErrorV1> {
    while grants.len() > MAX_LEASES {
        let Some(oldest) = grants
            .iter()
            .filter(|(key, _)| protected != Some(key.as_str()))
            .min_by(|left, right| {
                left.1
                    .committed_at_ms
                    .cmp(&right.1.committed_at_ms)
                    .then_with(|| left.0.cmp(right.0))
            })
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        if let Some(removed) = grants.remove(&oldest) {
            redemptions.remove(&removed.lease.lease_id);
        }
    }
    while redemptions.len() > MAX_REDEMPTIONS {
        let oldest = redemptions
            .iter()
            .min_by(|left, right| {
                left.1
                    .redeemed_at_ms
                    .cmp(&right.1.redeemed_at_ms)
                    .then_with(|| left.0.cmp(right.0))
            })
            .map(|(key, _)| key.clone())
            .ok_or(SecretUseJournalErrorV1::Corrupt)?;
        redemptions.remove(&oldest);
    }
    Ok(())
}

/// A V1 provider-use destination must be an absolute `https:` URL with a host,
/// no userinfo, no query, no fragment, no whitespace/control bytes and a
/// bounded length. This is a syntax gate only: it never resolves or contacts
/// the destination.
pub fn valid_use_destination(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_USE_DESTINATION_BYTES
        || value.chars().any(|character| character.is_control() || character.is_whitespace())
    {
        return false;
    }
    let Some(rest) = value.strip_prefix("https://") else {
        return false;
    };
    if rest.contains(['?', '#', '@']) {
        return false;
    }
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    if authority.is_empty() || authority.len() > 253 {
        return false;
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port)) => {
            if port.is_empty()
                || port.len() > 5
                || !port.bytes().all(|byte| byte.is_ascii_digit())
                || port.parse::<u16>().map_or(true, |port| port == 0)
            {
                return false;
            }
            host
        }
        None => authority,
    };
    if host.is_empty()
        || host.starts_with('.')
        || host.ends_with('.')
        || host.contains("..")
        || !host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return false;
    }
    path.is_empty() || path.starts_with('/')
}

fn validate_lease(lease: &SecretUseLeaseV1) -> Result<(), SecretUseJournalErrorV1> {
    if !valid_wire_id(&lease.lease_id)
        || !valid_text(&lease.idempotency_key, MAX_ID_BYTES)
        || !valid_text(&lease.request_digest, MAX_ID_BYTES)
        || !valid_digest(&lease.request_digest)
        || !valid_wire_id(&lease.secret_ref)
        || lease.secret_version == 0
        || !valid_wire_id(&lease.provider_id)
        || !valid_digest(&lease.operation_digest)
        || !valid_use_destination(&lease.destination)
        || !valid_text(&lease.purpose, MAX_PURPOSE_BYTES)
        || lease.purpose != USE_PURPOSE_PROVIDER_REQUEST
        || lease.issued_at_ms == 0
        || lease.issued_at_ms > MAX_SAFE_EVENT_TIME_MS
        || lease.expires_at_ms > MAX_SAFE_EVENT_TIME_MS
        || lease.expires_at_ms <= lease.issued_at_ms
        || lease.expires_at_ms - lease.issued_at_ms > MAX_USE_TTL_MS
        || !valid_wire_id(&lease.challenge_id)
        || !valid_wire_id(&lease.effect_id)
        || !valid_wire_id(&lease.user_action_id)
        || !valid_digest(&lease.effect_intent_digest)
        || !valid_digest(&lease.capability_lease_digest)
    {
        return Err(SecretUseJournalErrorV1::Invalid);
    }
    Ok(())
}

fn validate_grant(grant: &SecretUseGrantV1) -> Result<(), SecretUseJournalErrorV1> {
    validate_lease(&grant.lease)?;
    if !valid_digest(&grant.receipt_digest)
        || grant.committed_at_ms > MAX_SAFE_EVENT_TIME_MS
        || grant.committed_at_ms < grant.lease.issued_at_ms
    {
        return Err(SecretUseJournalErrorV1::Invalid);
    }
    Ok(())
}

fn validate_intent(intent: &SecretUseIntentV1) -> Result<(), SecretUseJournalErrorV1> {
    if !valid_text(&intent.idempotency_key, MAX_ID_BYTES)
        || !valid_digest(&intent.request_digest)
        || !valid_wire_id(&intent.secret_ref)
        || !valid_wire_id(&intent.provider_id)
        || !valid_digest(&intent.operation_digest)
        || !valid_use_destination(&intent.destination)
        || intent.purpose != USE_PURPOSE_PROVIDER_REQUEST
        || intent.expires_at_ms == 0
        || intent.expires_at_ms > MAX_SAFE_EVENT_TIME_MS
        || !valid_wire_id(&intent.challenge_id)
        || !valid_wire_id(&intent.effect_id)
        || !valid_wire_id(&intent.user_action_id)
        || !valid_digest(&intent.effect_intent_digest)
        || !valid_digest(&intent.capability_lease_digest)
        || intent.created_at_ms > MAX_SAFE_EVENT_TIME_MS
    {
        return Err(SecretUseJournalErrorV1::Invalid);
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

fn unix_ms() -> Result<u64, SecretUseJournalErrorV1> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .map_err(|_| SecretUseJournalErrorV1::Persistence("system clock unavailable".to_owned()))
}

fn lease_to_json(lease: &SecretUseLeaseV1) -> JsonValue {
    serde_json::json!({
        "leaseId": lease.lease_id,
        "idempotencyKey": lease.idempotency_key,
        "requestDigest": lease.request_digest,
        "secretRef": lease.secret_ref,
        "secretVersion": lease.secret_version,
        "providerId": lease.provider_id,
        "operationDigest": lease.operation_digest,
        "destination": lease.destination,
        "purpose": lease.purpose,
        "issuedAtMs": lease.issued_at_ms,
        "expiresAtMs": lease.expires_at_ms,
        "challengeId": lease.challenge_id,
        "effectId": lease.effect_id,
        "userActionId": lease.user_action_id,
        "effectIntentDigest": lease.effect_intent_digest,
        "capabilityLeaseDigest": lease.capability_lease_digest,
    })
}

fn grant_to_json(grant: &SecretUseGrantV1) -> JsonValue {
    serde_json::json!({
        "lease": lease_to_json(&grant.lease),
        "committedAtMs": grant.committed_at_ms,
        "receiptDigest": grant.receipt_digest,
    })
}

fn redemption_to_json(redemption: &SecretUseRedemptionV1) -> JsonValue {
    serde_json::json!({
        "leaseId": redemption.lease_id,
        "leaseReceiptDigest": redemption.lease_receipt_digest,
        "redeemKey": redemption.redeem_key,
        "redeemedAtMs": redemption.redeemed_at_ms,
        "redemptionDigest": redemption.redemption_digest,
    })
}

fn intent_to_json(intent: &SecretUseIntentV1) -> JsonValue {
    serde_json::json!({
        "idempotencyKey": intent.idempotency_key,
        "requestDigest": intent.request_digest,
        "secretRef": intent.secret_ref,
        "providerId": intent.provider_id,
        "operationDigest": intent.operation_digest,
        "destination": intent.destination,
        "purpose": intent.purpose,
        "expiresAtMs": intent.expires_at_ms,
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
    grants: &BTreeMap<String, SecretUseGrantV1>,
    redemptions: &BTreeMap<String, SecretUseRedemptionV1>,
    intents: &BTreeMap<String, SecretUseIntentV1>,
) -> Result<Vec<u8>, SecretUseJournalErrorV1> {
    let value = serde_json::json!({
        "format": SNAPSHOT_FORMAT,
        "scopeDigest": scope_digest,
        "grants": grants.values().map(grant_to_json).collect::<Vec<JsonValue>>(),
        "redemptions": redemptions
            .values()
            .map(redemption_to_json)
            .collect::<Vec<JsonValue>>(),
        "intents": intents.values().map(intent_to_json).collect::<Vec<JsonValue>>(),
    });
    serde_json::to_vec(&value).map_err(|_| SecretUseJournalErrorV1::Corrupt)
}

fn decode_snapshot(
    bytes: &[u8],
    scope_digest: &str,
) -> Result<
    (
        BTreeMap<String, SecretUseGrantV1>,
        BTreeMap<String, SecretUseRedemptionV1>,
        BTreeMap<String, SecretUseIntentV1>,
    ),
    SecretUseJournalErrorV1,
> {
    let value: JsonValue =
        serde_json::from_slice(bytes).map_err(|_| SecretUseJournalErrorV1::Corrupt)?;
    if serde_json::to_vec(&value).map_err(|_| SecretUseJournalErrorV1::Corrupt)? != bytes {
        return Err(SecretUseJournalErrorV1::Corrupt);
    }
    let object = value
        .as_object()
        .filter(|object| object.len() == 5)
        .ok_or(SecretUseJournalErrorV1::Corrupt)?;
    if object.get("format").and_then(JsonValue::as_str) != Some(SNAPSHOT_FORMAT)
        || object.get("scopeDigest").and_then(JsonValue::as_str) != Some(scope_digest)
    {
        return Err(SecretUseJournalErrorV1::Corrupt);
    }
    let grants = object
        .get("grants")
        .and_then(JsonValue::as_array)
        .filter(|values| values.len() <= MAX_LEASES)
        .ok_or(SecretUseJournalErrorV1::Corrupt)?;
    let mut grant_map = BTreeMap::new();
    let mut previous: Option<String> = None;
    for value in grants {
        let grant = decode_grant(value)?;
        if previous
            .as_ref()
            .is_some_and(|prior| prior >= &grant.lease.idempotency_key)
        {
            return Err(SecretUseJournalErrorV1::Corrupt);
        }
        previous = Some(grant.lease.idempotency_key.clone());
        if grant_map
            .insert(grant.lease.idempotency_key.clone(), grant)
            .is_some()
        {
            return Err(SecretUseJournalErrorV1::Corrupt);
        }
    }
    let redemptions = object
        .get("redemptions")
        .and_then(JsonValue::as_array)
        .filter(|values| values.len() <= MAX_REDEMPTIONS)
        .ok_or(SecretUseJournalErrorV1::Corrupt)?;
    let mut redemption_map = BTreeMap::new();
    let mut previous: Option<String> = None;
    for value in redemptions {
        let redemption = decode_redemption(value)?;
        if previous
            .as_ref()
            .is_some_and(|prior| prior >= &redemption.lease_id)
        {
            return Err(SecretUseJournalErrorV1::Corrupt);
        }
        previous = Some(redemption.lease_id.clone());
        let Some(grant) = grant_map.values().find(|grant| grant.lease.lease_id == redemption.lease_id)
        else {
            return Err(SecretUseJournalErrorV1::Corrupt);
        };
        if grant.receipt_digest != redemption.lease_receipt_digest {
            return Err(SecretUseJournalErrorV1::Corrupt);
        }
        if redemption_map
            .insert(redemption.lease_id.clone(), redemption)
            .is_some()
        {
            return Err(SecretUseJournalErrorV1::Corrupt);
        }
    }
    let intents = object
        .get("intents")
        .and_then(JsonValue::as_array)
        .filter(|values| values.len() <= MAX_INTENTS)
        .ok_or(SecretUseJournalErrorV1::Corrupt)?;
    let mut intent_map = BTreeMap::new();
    for value in intents {
        let intent = decode_intent(value)?;
        if intent_map
            .insert(intent.idempotency_key.clone(), intent)
            .is_some()
        {
            return Err(SecretUseJournalErrorV1::Corrupt);
        }
    }
    Ok((grant_map, redemption_map, intent_map))
}

fn json_object<'a>(
    value: &'a JsonValue,
    fields: usize,
) -> Result<&'a serde_json::Map<String, JsonValue>, SecretUseJournalErrorV1> {
    value
        .as_object()
        .filter(|object| object.len() == fields)
        .ok_or(SecretUseJournalErrorV1::Corrupt)
}

fn json_text<'a>(
    object: &'a serde_json::Map<String, JsonValue>,
    key: &str,
) -> Result<&'a str, SecretUseJournalErrorV1> {
    object
        .get(key)
        .and_then(JsonValue::as_str)
        .ok_or(SecretUseJournalErrorV1::Corrupt)
}

fn json_u64(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
) -> Result<u64, SecretUseJournalErrorV1> {
    object
        .get(key)
        .and_then(JsonValue::as_u64)
        .ok_or(SecretUseJournalErrorV1::Corrupt)
}

fn decode_lease(value: &JsonValue) -> Result<SecretUseLeaseV1, SecretUseJournalErrorV1> {
    let object = json_object(value, 16)?;
    let lease = SecretUseLeaseV1 {
        lease_id: json_text(object, "leaseId")?.to_owned(),
        idempotency_key: json_text(object, "idempotencyKey")?.to_owned(),
        request_digest: json_text(object, "requestDigest")?.to_owned(),
        secret_ref: json_text(object, "secretRef")?.to_owned(),
        secret_version: json_u64(object, "secretVersion")?,
        provider_id: json_text(object, "providerId")?.to_owned(),
        operation_digest: json_text(object, "operationDigest")?.to_owned(),
        destination: json_text(object, "destination")?.to_owned(),
        purpose: json_text(object, "purpose")?.to_owned(),
        issued_at_ms: json_u64(object, "issuedAtMs")?,
        expires_at_ms: json_u64(object, "expiresAtMs")?,
        challenge_id: json_text(object, "challengeId")?.to_owned(),
        effect_id: json_text(object, "effectId")?.to_owned(),
        user_action_id: json_text(object, "userActionId")?.to_owned(),
        effect_intent_digest: json_text(object, "effectIntentDigest")?.to_owned(),
        capability_lease_digest: json_text(object, "capabilityLeaseDigest")?.to_owned(),
    };
    validate_lease(&lease)?;
    Ok(lease)
}

fn decode_grant(value: &JsonValue) -> Result<SecretUseGrantV1, SecretUseJournalErrorV1> {
    let object = json_object(value, 3)?;
    let lease = decode_lease(object.get("lease").ok_or(SecretUseJournalErrorV1::Corrupt)?)?;
    let grant = SecretUseGrantV1 {
        lease,
        committed_at_ms: json_u64(object, "committedAtMs")?,
        receipt_digest: json_text(object, "receiptDigest")?.to_owned(),
    };
    validate_grant(&grant)?;
    if grant.receipt_digest != receipt_digest(&grant.lease, grant.committed_at_ms) {
        return Err(SecretUseJournalErrorV1::Corrupt);
    }
    Ok(grant)
}

fn decode_redemption(
    value: &JsonValue,
) -> Result<SecretUseRedemptionV1, SecretUseJournalErrorV1> {
    let object = json_object(value, 5)?;
    let redemption = SecretUseRedemptionV1 {
        lease_id: json_text(object, "leaseId")?.to_owned(),
        lease_receipt_digest: json_text(object, "leaseReceiptDigest")?.to_owned(),
        redeem_key: json_text(object, "redeemKey")?.to_owned(),
        redeemed_at_ms: json_u64(object, "redeemedAtMs")?,
        redemption_digest: json_text(object, "redemptionDigest")?.to_owned(),
    };
    if !valid_wire_id(&redemption.lease_id)
        || !valid_digest(&redemption.lease_receipt_digest)
        || !valid_text(&redemption.redeem_key, MAX_ID_BYTES)
        || redemption.redeemed_at_ms > MAX_SAFE_EVENT_TIME_MS
        || !valid_digest(&redemption.redemption_digest)
        || redemption.redemption_digest
            != redemption_core_digest(
                &redemption.lease_id,
                &redemption.lease_receipt_digest,
                &redemption.redeem_key,
                redemption.redeemed_at_ms,
            )
    {
        return Err(SecretUseJournalErrorV1::Corrupt);
    }
    Ok(redemption)
}

fn decode_intent(value: &JsonValue) -> Result<SecretUseIntentV1, SecretUseJournalErrorV1> {
    let object = json_object(value, 14)?;
    let intent = SecretUseIntentV1 {
        idempotency_key: json_text(object, "idempotencyKey")?.to_owned(),
        request_digest: json_text(object, "requestDigest")?.to_owned(),
        secret_ref: json_text(object, "secretRef")?.to_owned(),
        provider_id: json_text(object, "providerId")?.to_owned(),
        operation_digest: json_text(object, "operationDigest")?.to_owned(),
        destination: json_text(object, "destination")?.to_owned(),
        purpose: json_text(object, "purpose")?.to_owned(),
        expires_at_ms: json_u64(object, "expiresAtMs")?,
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
            "hz-secret-use-journal-{}-{tick}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    fn scope() -> String {
        format!("blake3:{}", "e".repeat(64))
    }

    fn digest(seed: &str) -> String {
        format!(
            "blake3:{}",
            blake3::hash(seed.as_bytes()).to_hex()
        )
    }

    fn lease(key: &str, issued: u64, expires: u64) -> SecretUseLeaseV1 {
        SecretUseLeaseV1 {
            lease_id: format!(
                "secret_lease_{}",
                blake3::hash(key.as_bytes()).to_hex()
            ),
            idempotency_key: key.to_owned(),
            request_digest: digest(key),
            secret_ref: "secret_test".to_owned(),
            secret_version: 1,
            provider_id: "openai".to_owned(),
            operation_digest: digest("operation"),
            destination: "https://api.openai.com/v1/responses".to_owned(),
            purpose: USE_PURPOSE_PROVIDER_REQUEST.to_owned(),
            issued_at_ms: issued,
            expires_at_ms: expires,
            challenge_id: "ch_secret_use".to_owned(),
            effect_id: "eff_secret_use".to_owned(),
            user_action_id: "act_secret_use".to_owned(),
            effect_intent_digest: digest("effect"),
            capability_lease_digest: digest("lease"),
        }
    }

    fn grant(key: &str, issued: u64, expires: u64) -> SecretUseGrantV1 {
        let lease = lease(key, issued, expires);
        let committed_at_ms = issued + 1;
        let receipt_digest = receipt_digest(&lease, committed_at_ms);
        SecretUseGrantV1 {
            lease,
            committed_at_ms,
            receipt_digest,
        }
    }

    #[test]
    fn issued_lease_is_redeemable_once_and_survives_reopen() {
        let root = root();
        let scope = scope();
        let mut journal = SecretUseJournalV1::open(&root, &scope).unwrap();
        journal.commit_lease(grant("idem-1", 1_000, 31_000), 1_001).unwrap();
        let stored = journal.grant_for_key("idem-1").cloned().unwrap();
        assert_eq!(
            stored.receipt_digest,
            receipt_digest(&stored.lease, stored.committed_at_ms)
        );
        assert_eq!(
            journal.grant_for_lease(&stored.lease.lease_id).map(|grant| {
                grant.lease.idempotency_key.clone()
            }),
            Some("idem-1".to_owned())
        );
        let redemption = journal.redeem(&stored.lease.lease_id, "redeem-1", 2_000).unwrap();
        assert_eq!(redemption.lease_receipt_digest, stored.receipt_digest);
        assert_eq!(
            journal.redeem(&stored.lease.lease_id, "redeem-2", 3_000),
            Err(SecretUseJournalErrorV1::Consumed)
        );
        drop(journal);
        let mut reopened = SecretUseJournalV1::open(&root, &scope).unwrap();
        assert_eq!(
            reopened.grant_for_key("idem-1").map(|grant| grant.receipt_digest.clone()),
            Some(stored.receipt_digest)
        );
        assert_eq!(
            reopened.redeem(&stored.lease.lease_id, "redeem-3", 4_000),
            Err(SecretUseJournalErrorV1::Consumed)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn expired_lease_is_never_redeemable() {
        let root = root();
        let scope = scope();
        let mut journal = SecretUseJournalV1::open(&root, &scope).unwrap();
        journal.commit_lease(grant("idem-2", 1_000, 2_000), 1_001).unwrap();
        assert_eq!(
            journal.redeem(&lease("idem-2", 1_000, 2_000).lease_id, "redeem-1", 2_000),
            Err(SecretUseJournalErrorV1::Expired)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn destination_syntax_is_https_only_and_bounded() {
        for valid in [
            "https://api.openai.com/v1/responses",
            "https://api.openai.com",
            "https://api.openai.com:443/v1",
            "https://127.0.0.1:8443/v1/messages",
        ] {
            assert!(valid_use_destination(valid), "{valid} must be accepted");
        }
        for invalid in [
            "http://api.openai.com/v1",
            "https://user:pass@api.openai.com/v1",
            "https://api.openai.com/v1?debug=1",
            "https://api.openai.com/v1#fragment",
            "https://",
            "https:///v1",
            "/v1/messages",
            "https://api.openai.com:0/v1",
            "https://api.openai.com:99999/v1",
            "https://.api.openai.com/v1",
            "https://api..openai.com/v1",
            "https://api.openai.com /v1",
        ] {
            assert!(
                !valid_use_destination(invalid),
                "{invalid} must be rejected"
            );
        }
        assert!(!valid_use_destination(&format!(
            "https://api.openai.com/{}",
            "a".repeat(MAX_USE_DESTINATION_BYTES)
        )));
    }
}
