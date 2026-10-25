//! Durable, bounded direct-child mailbox admission and Core-append receipt journal.
//! The payload is never stored here; only exact authority pins and opaque digests are
//! retained. An unresolved admission at owner restart becomes UNKNOWN and cannot issue
//! another lease or authorize another Core inbox append.

use crate::owner_log::{
    DurabilityProfile, OwnerEventInput, OwnerIdentity, OwnerLogError, OwnerLogV2,
    MAX_OWNER_METADATA_BYTES, OWNER_EVENT_SCHEMA_VERSION_V1,
};
use crate::protocol::{CursorV1, DirectMessageAuthorityPinsV1, DirectMessageDeliveryModeV1};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_RETAINED_MESSAGES_PER_CHILD: usize = 256;
pub(crate) const PREPARED: &str = "PREPARED";
pub(crate) const ADMITTED: &str = "ADMITTED";
pub(crate) const UNKNOWN: &str = "UNKNOWN";
pub(crate) const COMMITTED: &str = "COMMITTED";
pub(crate) const ABORTED: &str = "ABORTED";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectMessageJournalEntryV1 {
    pub(crate) direct_attempt_id: String,
    pub(crate) parent_session_id: String,
    pub(crate) child_session_id: String,
    pub(crate) profile_id: String,
    pub(crate) profile_revision: u64,
    pub(crate) profile_digest: String,
    pub(crate) permission_scope_digest: String,
    pub(crate) payload_digest: String,
    pub(crate) delivery_mode: DirectMessageDeliveryModeV1,
    pub(crate) owner_epoch: u64,
    pub(crate) mailbox_sequence: u64,
    pub(crate) pins_digest: String,
    pub(crate) challenge_id: String,
    pub(crate) effect_id: String,
    pub(crate) input_digest: String,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) capability_lease_digest: Option<String>,
    pub(crate) inbox_receipt_digest: Option<String>,
    pub(crate) consumed: bool,
    pub(crate) consumption_ack_digest: Option<String>,
    pub(crate) consumption_receipt_digest: Option<String>,
    pub(crate) status: String,
    pub(crate) receipt_digest: Option<String>,
}

pub(crate) struct DirectMessageJournalV1 {
    log: OwnerLogV2,
    mailbox_session_id: String,
    owner_epoch: u64,
    entries: BTreeMap<String, DirectMessageJournalEntryV1>,
    cursor: Option<CursorV1>,
}

impl DirectMessageJournalV1 {
    pub(crate) fn open(root: &Path, mailbox_session_id: &str, owner_epoch: u64) -> Result<Self, OwnerLogError> {
        let owner = OwnerIdentity::new("direct_message_child_mailbox".to_owned(), mailbox_session_id.to_owned())?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)?;
        reject_legacy_attempt_mailboxes(root)?;
        let mut journal = Self { log, mailbox_session_id: mailbox_session_id.to_owned(), owner_epoch, entries: BTreeMap::new(), cursor: None };
        journal.replay()?;
        // A challenge or lease from a previous HostKernel epoch cannot be used to
        // append to Core. Preserve the exact row but terminalize the authority.
        let unresolved = journal.entries.iter()
            .filter(|(_, entry)| entry.owner_epoch != owner_epoch && (entry.status == PREPARED || entry.status == ADMITTED))
            .map(|(message_id, entry)| (message_id.clone(), entry.pins_digest.clone()))
            .collect::<Vec<_>>();
        for (message_id, pins_digest) in unresolved {
            journal.append_state(&message_id, "direct_message_unknown", &pins_digest, json!({
                "messageID": message_id,
                "pinsDigest": pins_digest,
                "mailboxSessionID": journal.mailbox_session_id.clone(),
                "ownerEpoch": journal.owner_epoch,
                "reason": "owner_epoch_recovery",
            }))?;
            if let Some(entry) = journal.entries.get_mut(&message_id) { entry.status = UNKNOWN.to_owned(); }
        }
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| OwnerLogError::InvalidRecord("system time is invalid"))?.as_millis() as u64;
        let expired = journal.entries.iter()
            .filter(|(_, entry)| entry.owner_epoch == owner_epoch && entry.expires_at_unix_ms <= now_ms
                && (entry.status == PREPARED || entry.status == ADMITTED))
            .map(|(message_id, entry)| (message_id.clone(), entry.pins_digest.clone(), entry.status.clone()))
            .collect::<Vec<_>>();
        for (message_id, pins_digest, status) in expired {
            let (kind, state) = if status == PREPARED { ("direct_message_aborted", ABORTED) }
                else { ("direct_message_unknown", UNKNOWN) };
            journal.append_state(&message_id, kind, &pins_digest, json!({
                "messageID": message_id, "pinsDigest": pins_digest,
                "mailboxSessionID": journal.mailbox_session_id.clone(), "ownerEpoch": owner_epoch,
                "reason": "lease_expired", "status": state,
            }))?;
            if let Some(entry) = journal.entries.get_mut(&message_id) { entry.status = state.to_owned(); }
        }
        Ok(journal)
    }

    pub(crate) fn get(&self, message_id: &str) -> Option<&DirectMessageJournalEntryV1> {
        self.entries.get(message_id)
    }

    pub(crate) fn outstanding(&self) -> usize {
        self.entries.values().filter(|entry| entry.status == PREPARED || entry.status == ADMITTED).count()
    }

    pub(crate) fn count(&self) -> usize { self.entries.len() }

    pub(crate) fn pending_count(&self) -> usize { self.entries.values().filter(|entry|
        entry.status == PREPARED || entry.status == ADMITTED
            || (entry.status == COMMITTED && !entry.consumed)).count() }

    pub(crate) fn outstanding_for_attempt(&self, attempt_id: &str) -> usize {
        self.entries.values().filter(|entry| entry.direct_attempt_id == attempt_id
            && (entry.status == PREPARED || entry.status == ADMITTED)).count()
    }

    /// A committed wake remains a no-settlement fence until Core acknowledges
    /// consumption after the exact child turn returns.
    pub(crate) fn committed_follow_ups_for_attempt(&self, attempt_id: &str) -> usize {
        self.entries.values().filter(|entry| entry.direct_attempt_id == attempt_id
            && entry.delivery_mode == DirectMessageDeliveryModeV1::FollowUp
            && entry.status == COMMITTED && !entry.consumed).count()
    }

    pub(crate) fn sequence_is_next(&self, sequence: u64) -> bool {
        self.entries.values().map(|entry| entry.mailbox_sequence).max()
            .is_none_or(|previous| previous.checked_add(1) == Some(sequence))
    }

    pub(crate) fn prepare(
        &mut self,
        pins: &DirectMessageAuthorityPinsV1,
        challenge_id: &str,
        effect_id: &str,
        input_digest: &str,
        expires_at_unix_ms: u64,
    ) -> Result<(), OwnerLogError> {
        let pins_digest = pins.authority_digest().map_err(|_| OwnerLogError::InvalidRecord("direct message authority pins are invalid"))?;
        if let Some(existing) = self.entries.get(&pins.message_id) {
            return if existing.pins_digest == pins_digest && existing.challenge_id == challenge_id
                && existing.effect_id == effect_id && existing.input_digest == input_digest {
                Ok(())
            } else { Err(OwnerLogError::ReplayConflict) };
        }
        if self.entries.len() >= MAX_RETAINED_MESSAGES_PER_CHILD { return Err(OwnerLogError::LimitExceeded("retained direct mailbox messages per child")); }
        let data = json!({
            "messageID": pins.message_id,
            "directAttemptID": pins.direct_attempt_id,
            "parentSessionID": pins.parent_session_id,
            "childSessionID": pins.child_session_id,
            "profileID": pins.profile_id,
            "profileRevision": pins.profile_revision,
            "profileDigest": pins.profile_digest,
            "permissionScopeDigest": pins.permission_scope_digest,
            "payloadDigest": pins.payload_digest,
            "deliveryMode": pins.delivery_mode.name(),
            "pinsDigest": pins_digest,
            "challengeID": challenge_id,
            "effectID": effect_id,
            "inputDigest": input_digest,
            "expiresAtUnixMs": expires_at_unix_ms,
            "mailboxSequence": pins.mailbox_sequence,
            "ownerEpoch": self.owner_epoch,
            "status": PREPARED,
        });
        self.append_state(&pins.message_id, "direct_message_prepared", &pins_digest, data)?;
        self.entries.insert(pins.message_id.clone(), DirectMessageJournalEntryV1 {
            direct_attempt_id: pins.direct_attempt_id.clone(),
            parent_session_id: pins.parent_session_id.clone(),
            child_session_id: pins.child_session_id.clone(),
            profile_id: pins.profile_id.clone(), profile_revision: pins.profile_revision,
            profile_digest: pins.profile_digest.clone(),
            permission_scope_digest: pins.permission_scope_digest.clone(),
            payload_digest: pins.payload_digest.clone(),
            delivery_mode: pins.delivery_mode,
            owner_epoch: self.owner_epoch,
            mailbox_sequence: pins.mailbox_sequence,
            pins_digest, challenge_id: challenge_id.to_owned(), effect_id: effect_id.to_owned(),
            input_digest: input_digest.to_owned(), expires_at_unix_ms,
            capability_lease_digest: None, inbox_receipt_digest: None,
            consumed: false, consumption_ack_digest: None, consumption_receipt_digest: None,
            status: PREPARED.to_owned(), receipt_digest: None,
        });
        Ok(())
    }

    pub(crate) fn admit(
        &mut self,
        message_id: &str,
        pins_digest: &str,
        challenge_id: &str,
        capability_lease_digest: &str,
    ) -> Result<(), OwnerLogError> {
        let entry = self.entries.get(message_id).ok_or(OwnerLogError::InvalidRecord("direct message prepare is missing"))?;
        if entry.pins_digest != pins_digest || entry.challenge_id != challenge_id
            || entry.status != PREPARED || !valid_digest(capability_lease_digest, "blake3:")
        { return Err(OwnerLogError::ReplayConflict); }
        let data = json!({ "messageID": message_id, "pinsDigest": pins_digest,
            "challengeID": challenge_id, "capabilityLeaseDigest": capability_lease_digest,
            "status": ADMITTED, "ownerEpoch": self.owner_epoch });
        self.append_state(message_id, "direct_message_admitted", pins_digest, data)?;
        let entry = self.entries.get_mut(message_id).expect("validated journal entry");
        entry.capability_lease_digest = Some(capability_lease_digest.to_owned());
        entry.status = ADMITTED.to_owned();
        Ok(())
    }

    pub(crate) fn commit(
        &mut self,
        pins: &DirectMessageAuthorityPinsV1,
        capability_lease_digest: &str,
        inbox_receipt_digest: &str,
    ) -> Result<String, OwnerLogError> {
        let pins_digest = pins.authority_digest().map_err(|_| OwnerLogError::InvalidRecord("direct message authority pins are invalid"))?;
        let entry = self.entries.get(&pins.message_id).ok_or(OwnerLogError::InvalidRecord("direct message admission is missing"))?;
        if entry.pins_digest != pins_digest { return Err(OwnerLogError::ReplayConflict); }
        if entry.status == COMMITTED {
            if entry.capability_lease_digest.as_deref() == Some(capability_lease_digest)
                && entry.inbox_receipt_digest.as_deref() == Some(inbox_receipt_digest) {
                return entry.receipt_digest.clone().ok_or(OwnerLogError::CorruptCommittedLog("committed mailbox receipt is missing"));
            }
            return Err(OwnerLogError::ReplayConflict);
        }
        if entry.status != ADMITTED || entry.capability_lease_digest.as_deref() != Some(capability_lease_digest)
            || !valid_digest(inbox_receipt_digest, "sha256:")
        { return Err(OwnerLogError::ReplayConflict); }
        let data = json!({ "messageID": pins.message_id, "pinsDigest": pins_digest,
            "capabilityLeaseDigest": capability_lease_digest,
            "inboxReceiptDigest": inbox_receipt_digest, "status": COMMITTED,
            "ownerEpoch": self.owner_epoch });
        let receipt = self.append_state(&pins.message_id, "direct_message_committed", &pins_digest, data)?;
        let entry = self.entries.get_mut(&pins.message_id).expect("validated journal entry");
        entry.inbox_receipt_digest = Some(inbox_receipt_digest.to_owned());
        entry.consumed = false;
        entry.status = COMMITTED.to_owned();
        entry.receipt_digest = Some(receipt.clone());
        Ok(receipt)
    }

    pub(crate) fn acknowledge_consumed(
        &mut self,
        message_id: &str,
        pins_digest: &str,
        inbox_receipt_digest: &str,
        consumption_ack_digest: &str,
    ) -> Result<String, OwnerLogError> {
        let entry = self.entries.get(message_id).ok_or(OwnerLogError::InvalidRecord("direct message commit is missing"))?;
        if entry.pins_digest != pins_digest || entry.status != COMMITTED
            || entry.inbox_receipt_digest.as_deref() != Some(inbox_receipt_digest)
            || !valid_digest(inbox_receipt_digest, "sha256:")
            || !valid_digest(consumption_ack_digest, "sha256:")
        { return Err(OwnerLogError::ReplayConflict); }
        if entry.consumed {
            if entry.consumption_ack_digest.as_deref() == Some(consumption_ack_digest) {
                return entry.consumption_receipt_digest.clone()
                    .ok_or(OwnerLogError::CorruptCommittedLog("consumption receipt is missing"));
            }
            return Err(OwnerLogError::ReplayConflict);
        }
        let owner_epoch = entry.owner_epoch;
        let data = json!({ "messageID": message_id, "pinsDigest": pins_digest,
            "inboxReceiptDigest": inbox_receipt_digest,
            "consumptionAckDigest": consumption_ack_digest, "status": "CONSUMED",
            "ownerEpoch": owner_epoch });
        let receipt = self.append_state(message_id, "direct_message_consumed", pins_digest, data)?;
        let entry = self.entries.get_mut(message_id).expect("validated journal entry");
        entry.consumed = true;
        entry.consumption_ack_digest = Some(consumption_ack_digest.to_owned());
        entry.consumption_receipt_digest = Some(receipt.clone());
        Ok(receipt)
    }

    pub(crate) fn abort(&mut self, message_id: &str, pins_digest: &str) -> Result<(), OwnerLogError> {
        let entry = self.entries.get(message_id).ok_or(OwnerLogError::InvalidRecord("direct message prepare is missing"))?;
        if entry.pins_digest != pins_digest || entry.owner_epoch != self.owner_epoch
            || entry.status != PREPARED { return Err(OwnerLogError::ReplayConflict); }
        let data = json!({ "messageID": message_id, "pinsDigest": pins_digest,
            "ownerEpoch": self.owner_epoch, "status": ABORTED });
        self.append_state(message_id, "direct_message_aborted", pins_digest, data)?;
        self.entries.get_mut(message_id).expect("validated journal entry").status = ABORTED.to_owned();
        Ok(())
    }

    fn append_state(&mut self, message_id: &str, kind: &str, pins_digest: &str, data: Value) -> Result<String, OwnerLogError> {
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| OwnerLogError::InvalidRecord("system time is invalid"))?.as_millis() as u64;
        let event = OwnerEventInput { schema_version: OWNER_EVENT_SCHEMA_VERSION_V1,
            time_ms: now_ms, kind: kind.to_owned(), data, delivery_id: None, command_digest: None };
        let delivery_id = format!("{message_id}:{kind}");
        let command_digest = OwnerLogV2::command_digest(&delivery_id, std::slice::from_ref(&event))?;
        let mut event = event;
        event.delivery_id = Some(delivery_id.clone());
        event.command_digest = Some(command_digest.clone());
        let receipt = self.log.append_batch(&delivery_id, &command_digest, &[event], self.cursor.as_ref())?;
        let event_digest = receipt.owner_cursor.event_digest.clone();
        self.cursor = Some(receipt.owner_cursor);
        let _ = pins_digest;
        Ok(event_digest)
    }

    fn replay(&mut self) -> Result<(), OwnerLogError> {
        loop {
            let batch = self.log.read_after(self.cursor.as_ref(), NonZeroUsize::new(128).unwrap())?;
            for event in &batch.events {
                let envelope = event.data.as_object().ok_or(OwnerLogError::InvalidRecord("direct mailbox OwnerLog envelope is invalid"))?;
                if envelope.get("schemaVersion").and_then(Value::as_u64) != Some(1) { return Err(OwnerLogError::InvalidRecord("direct mailbox event schema is invalid")); }
                let payload = envelope.get("payload").and_then(Value::as_object).ok_or(OwnerLogError::InvalidRecord("direct mailbox event payload is invalid"))?;
                if event.kind.starts_with("direct_turn_") {
                    continue;
                }
                let message_id = string(payload, "messageID")?.to_owned();
                let pins_digest = string(payload, "pinsDigest")?.to_owned();
                if !valid_digest(&pins_digest, "blake3:") { return Err(OwnerLogError::InvalidDigest); }
                match event.kind.as_str() {
                    "direct_message_prepared" => {
                        if self.entries.len() >= MAX_RETAINED_MESSAGES_PER_CHILD || self.entries.contains_key(&message_id) { return Err(OwnerLogError::ReplayConflict); }
                        if string(payload, "childSessionID")? != self.mailbox_session_id {
                            return Err(OwnerLogError::ReplayConflict);
                        }
                        self.entries.insert(message_id, DirectMessageJournalEntryV1 {
                            direct_attempt_id: string(payload, "directAttemptID")?.to_owned(),
                            parent_session_id: string(payload, "parentSessionID")?.to_owned(),
                            child_session_id: string(payload, "childSessionID")?.to_owned(),
                            profile_id: string(payload, "profileID")?.to_owned(),
                            profile_revision: number(payload, "profileRevision")?,
                            profile_digest: string(payload, "profileDigest")?.to_owned(),
                            permission_scope_digest: string(payload, "permissionScopeDigest")?.to_owned(),
                            payload_digest: string(payload, "payloadDigest")?.to_owned(),
                            delivery_mode: match payload.get("deliveryMode").and_then(Value::as_str) {
                                Some("queue") => DirectMessageDeliveryModeV1::Queue,
                                Some("follow_up") => DirectMessageDeliveryModeV1::FollowUp,
                                // Earlier V1 journal rows could only be queue-only.
                                None => DirectMessageDeliveryModeV1::Queue,
                                _ => return Err(OwnerLogError::InvalidRecord("direct message delivery mode is invalid")),
                            },
                            owner_epoch: number(payload, "ownerEpoch")?, mailbox_sequence: number(payload, "mailboxSequence")?, pins_digest, challenge_id: string(payload, "challengeID")?.to_owned(),
                            effect_id: string(payload, "effectID")?.to_owned(), input_digest: string(payload, "inputDigest")?.to_owned(),
                            expires_at_unix_ms: number(payload, "expiresAtUnixMs")?, capability_lease_digest: None,
                            inbox_receipt_digest: None, consumed: false,
                            consumption_ack_digest: None, consumption_receipt_digest: None,
                            status: PREPARED.to_owned(), receipt_digest: None,
                        });
                    }
                    "direct_message_admitted" => {
                        let entry = self.entries.get_mut(&message_id).ok_or(OwnerLogError::InvalidRecord("admission lacks prepare"))?;
                        let lease = string(payload, "capabilityLeaseDigest")?;
                        if entry.pins_digest != pins_digest || entry.challenge_id != string(payload, "challengeID")? || entry.status != PREPARED || !valid_digest(lease, "blake3:") { return Err(OwnerLogError::ReplayConflict); }
                        if entry.owner_epoch != number(payload, "ownerEpoch")? { return Err(OwnerLogError::ReplayConflict); }
                        entry.capability_lease_digest = Some(lease.to_owned()); entry.status = ADMITTED.to_owned();
                    }
                    "direct_message_committed" => {
                        let entry = self.entries.get_mut(&message_id).ok_or(OwnerLogError::InvalidRecord("commit lacks admission"))?;
                        let lease = string(payload, "capabilityLeaseDigest")?;
                        let inbox = string(payload, "inboxReceiptDigest")?;
                        if entry.pins_digest != pins_digest || entry.status != ADMITTED || entry.capability_lease_digest.as_deref() != Some(lease) || !valid_digest(inbox, "sha256:") { return Err(OwnerLogError::ReplayConflict); }
                        if entry.owner_epoch != number(payload, "ownerEpoch")? { return Err(OwnerLogError::ReplayConflict); }
                        entry.inbox_receipt_digest = Some(inbox.to_owned()); entry.status = COMMITTED.to_owned();
                        entry.receipt_digest = Some(format!("blake3:{}", event.event_digest.to_hex()));
                    }
                    "direct_message_consumed" => {
                        let entry = self.entries.get_mut(&message_id).ok_or(OwnerLogError::InvalidRecord("consumption ACK lacks committed message"))?;
                        let inbox = string(payload, "inboxReceiptDigest")?;
                        let ack = string(payload, "consumptionAckDigest")?;
                        if entry.pins_digest != pins_digest || entry.status != COMMITTED || entry.consumed
                            || entry.inbox_receipt_digest.as_deref() != Some(inbox)
                            || !valid_digest(ack, "sha256:")
                            || entry.owner_epoch != number(payload, "ownerEpoch")?
                        { return Err(OwnerLogError::ReplayConflict); }
                        entry.consumed = true;
                        entry.consumption_ack_digest = Some(ack.to_owned());
                        entry.consumption_receipt_digest = Some(format!("blake3:{}", event.event_digest.to_hex()));
                    }
                    "direct_message_unknown" => {
                        let entry = self.entries.get_mut(&message_id).ok_or(OwnerLogError::InvalidRecord("UNKNOWN lacks prepare"))?;
                        if entry.pins_digest != pins_digest { return Err(OwnerLogError::ReplayConflict); }
                        entry.status = UNKNOWN.to_owned();
                    }
                    "direct_message_aborted" => {
                        let entry = self.entries.get_mut(&message_id).ok_or(OwnerLogError::InvalidRecord("abort lacks prepare"))?;
                        if entry.pins_digest != pins_digest || entry.status != PREPARED
                            || entry.owner_epoch != number(payload, "ownerEpoch")? { return Err(OwnerLogError::ReplayConflict); }
                        entry.status = ABORTED.to_owned();
                    }
                    _ => return Err(OwnerLogError::InvalidRecord("unknown direct mailbox event")),
                }
            }
            self.cursor = batch.cursor;
            if !batch.has_more { break; }
        }
        Ok(())
    }
}

/// Earlier source builds used one OwnerLog per Attempt, which cannot safely be
/// treated as an empty child mailbox after a key migration. Any committed legacy
/// mailbox stream makes the new aggregate mailbox unavailable pending explicit
/// reconciliation/migration; it is never silently reset or replayed as a new queue.
fn reject_legacy_attempt_mailboxes(root: &Path) -> Result<(), OwnerLogError> {
    let owners = root.join("owners");
    let entries = match fs::read_dir(&owners) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(OwnerLogError::Io { operation: "inspect legacy direct mailbox owners", kind: std::io::ErrorKind::PermissionDenied }),
    };
    for entry in entries {
        let entry = entry.map_err(|_| OwnerLogError::UnknownStorageEntry)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| OwnerLogError::UnknownStorageEntry)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(OwnerLogError::UnknownStorageEntry);
        }
        let head_path = entry.path().join("head.json");
        let head_metadata = match fs::symlink_metadata(&head_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(OwnerLogError::UnknownStorageEntry),
        };
        if head_metadata.file_type().is_symlink() || !head_metadata.is_file()
            || head_metadata.len() as usize > MAX_OWNER_METADATA_BYTES
        { return Err(OwnerLogError::UnknownStorageEntry); }
        let bytes = fs::read(&head_path).map_err(|_| OwnerLogError::UnknownStorageEntry)?;
        let head: Value = serde_json::from_slice(&bytes).map_err(|_| OwnerLogError::InvalidMetadata("owner head JSON is invalid"))?;
        let Some(fields) = head.as_object() else { return Err(OwnerLogError::InvalidMetadata("owner head is not an object")) };
        if fields.get("owner_kind").and_then(Value::as_str) == Some("direct_message_mailbox")
            && fields.get("committed_seq").and_then(Value::as_u64).unwrap_or(0) > 0
        {
            return Err(OwnerLogError::InvalidRecord("legacy per-Attempt direct mailbox requires reconciliation"));
        }
    }
    Ok(())
}

fn string<'a>(payload: &'a Map<String, Value>, key: &str) -> Result<&'a str, OwnerLogError> {
    payload.get(key).and_then(Value::as_str).ok_or(OwnerLogError::InvalidRecord("direct mailbox event string is missing"))
}

fn number(payload: &Map<String, Value>, key: &str) -> Result<u64, OwnerLogError> {
    payload.get(key).and_then(Value::as_u64).ok_or(OwnerLogError::InvalidRecord("direct mailbox event integer is missing"))
}

fn valid_digest(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}
