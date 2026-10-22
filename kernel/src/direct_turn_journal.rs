//! Durable direct child turn-cycle and one-use follow-up authorization journal.
//! This uses the same child-keyed OwnerLog as direct-message mailbox receipts.
//! An interrupted active cycle or authorization reservation is UNKNOWN and cannot
//! be replayed into a second provider turn.

use crate::owner_log::{DurabilityProfile, OwnerEventInput, OwnerIdentity, OwnerLogError, OwnerLogV2, OWNER_EVENT_SCHEMA_VERSION_V1};
use crate::protocol::{DirectAttemptScopeV1, DirectMessageAuthorityPinsV1, DirectTurnScopeV1, FreshTurnAuthorizationV1};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroUsize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_TURNS_PER_CHILD: usize = 1024;
const MAX_AUTHORIZATIONS_PER_CHILD: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
struct TurnCycle {
    scope: DirectTurnScopeV1,
    process_incarnation: String,
    result_digest: Option<String>,
    receipt_digest: String,
    state: TurnState,
    /// Retain completed batches so later batches do not erase exact replay data.
    batches: BTreeMap<String, TurnBatch>,
    active_batch_id: Option<String>,
}

/// One immutable ToolBatch admission pinned to a single provider-turn snapshot.
/// Member receipts may advance the direct Attempt, but the public turn scope is
/// refreshed once, after every admitted member has a terminal receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
struct TurnBatch {
    admitted_scope: DirectTurnScopeV1,
    effect_ids: Vec<String>,
    receipts: BTreeMap<String, String>,
    receipt_scopes: BTreeMap<String, DirectAttemptScopeV1>,
    final_scope: Option<DirectTurnScopeV1>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TurnState { Active, Completed, Unknown }

#[derive(Clone, Debug, PartialEq, Eq)]
struct AuthorizationEntry { proof: FreshTurnAuthorizationV1, process_incarnation: String, state: AuthorizationState }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthorizationState { Issued, Reserved, Unknown, Consumed }

pub(crate) struct DirectTurnJournalV1 {
    log: OwnerLogV2,
    child_session_id: String,
    owner_epoch: u64,
    process_incarnation: String,
    cycles: BTreeMap<u64, TurnCycle>,
    authorizations: BTreeMap<String, AuthorizationEntry>,
    reserved_sequences: BTreeSet<u64>,
    cursor: Option<crate::protocol::CursorV1>,
}

impl DirectTurnJournalV1 {
    pub(crate) fn open(root: &Path, child_session_id: &str, owner_epoch: u64, process_incarnation: &str) -> Result<Self, OwnerLogError> {
        if !valid_id(process_incarnation) { return Err(OwnerLogError::InvalidRecord("direct turn process incarnation is invalid")); }
        let owner = OwnerIdentity::new("direct_message_child_mailbox".to_owned(), child_session_id.to_owned())?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)?;
        let mut journal = Self { log, child_session_id: child_session_id.to_owned(), owner_epoch,
            process_incarnation: process_incarnation.to_owned(),
            cycles: BTreeMap::new(), authorizations: BTreeMap::new(), reserved_sequences: BTreeSet::new(), cursor: None };
        journal.replay()?;
        let old_active = journal.cycles.iter().filter(|(_, cycle)| cycle.state == TurnState::Active
            && (cycle.scope.direct_attempt.owner_epoch != owner_epoch || cycle.process_incarnation != process_incarnation))
            .map(|(seq, cycle)| (*seq, cycle.scope.cycle_digest.clone())).collect::<Vec<_>>();
        for (sequence, digest) in old_active { journal.mark_cycle_unknown(sequence, &digest, "process_incarnation_recovery")?; }
        let old_authorizations = journal.authorizations.iter().filter(|(_, entry)| {
            let stale_pending = (entry.proof.authority_pins.child_owner_epoch != owner_epoch
                || entry.process_incarnation != process_incarnation)
                && matches!(entry.state, AuthorizationState::Issued | AuthorizationState::Reserved);
            let consumed_without_successor = entry.state == AuthorizationState::Consumed
                && !journal.cycles.contains_key(&entry.proof.next_turn_sequence);
            stale_pending || consumed_without_successor
        })
            .map(|(id, entry)| (id.clone(), entry.proof.authorization_digest.clone())).collect::<Vec<_>>();
        for (issuance_id, digest) in old_authorizations { journal.mark_authorization_unknown(&issuance_id, &digest, "process_recovery_or_missing_successor")?; }
        let now = now_ms().ok_or(OwnerLogError::InvalidRecord("clock unavailable"))?;
        let expired = journal.authorizations.iter().filter(|(_, entry)|
            entry.proof.expires_at_unix_ms <= now
                && matches!(entry.state, AuthorizationState::Issued | AuthorizationState::Reserved))
            .map(|(id, entry)| (id.clone(), entry.proof.authorization_digest.clone())).collect::<Vec<_>>();
        for (issuance_id, digest) in expired { journal.mark_authorization_unknown(&issuance_id, &digest, "authorization_expired")?; }
        Ok(journal)
    }

    pub(crate) fn begin_turn(&mut self, scope: &DirectAttemptScopeV1, proof: Option<&FreshTurnAuthorizationV1>, cycle_id: &str) -> Result<DirectTurnScopeV1, OwnerLogError> {
        if scope.child_session_id != self.child_session_id || scope.owner_epoch != self.owner_epoch || !valid_id(cycle_id) {
            return Err(OwnerLogError::ReplayConflict);
        }
        if let Some(active) = self.cycles.values().find(|cycle| cycle.state == TurnState::Active) {
            if active.scope.direct_attempt.attempt_id == scope.attempt_id
            && active.scope.direct_attempt.scope_digest == scope.scope_digest
                && active.process_incarnation == self.process_incarnation
            { return Ok(active.scope.clone()); }
            return Err(OwnerLogError::ReplayConflict);
        }
        if self.cycles.values().any(|cycle| cycle.state == TurnState::Unknown) {
            return Err(OwnerLogError::ReplayConflict);
        }
        let last_sequence = self.cycles.keys().next_back().copied().unwrap_or(0);
        let next_sequence = last_sequence.checked_add(1).ok_or(OwnerLogError::LimitExceeded("direct turn sequence"))?;
        if self.cycles.len() >= MAX_TURNS_PER_CHILD { return Err(OwnerLogError::LimitExceeded("direct turns per child")); }
        match (next_sequence, proof) {
            (1, None) => {}
            (1, Some(_)) | (_, None) => return Err(OwnerLogError::ReplayConflict),
            (_, Some(proof)) => {
                let latest = self.cycles.get(&last_sequence).ok_or(OwnerLogError::ReplayConflict)?;
                if latest.state != TurnState::Completed || latest.scope != proof.completed_turn
                    || proof.next_turn_sequence != next_sequence || proof.authority_pins.direct_attempt_id != scope.attempt_id
                    || proof.authority_pins.child_session_id != self.child_session_id
                    || proof.authority_pins.child_owner_epoch != self.owner_epoch
                    || proof.authority_pins.parent_session_id != scope.parent_session_id
                    || proof.authority_pins.profile_id != scope.profile_id
                    || proof.authority_pins.profile_revision != scope.profile_revision
                    || proof.authority_pins.profile_digest != scope.profile_digest
                    || proof.authority_pins.permission_scope_digest != scope.permissions_digest
                    || proof.expires_at_unix_ms <= now_ms().ok_or(OwnerLogError::InvalidRecord("clock unavailable"))?
                { return Err(OwnerLogError::ReplayConflict); }
                let authorization = self.authorizations.get(&proof.issuance_id).ok_or(OwnerLogError::ReplayConflict)?;
                if authorization.proof != *proof || authorization.state != AuthorizationState::Reserved {
                    return Err(OwnerLogError::ReplayConflict);
                }
                if proof.expires_at_unix_ms <= now_ms().ok_or(OwnerLogError::InvalidRecord("clock unavailable"))? {
                    return Err(OwnerLogError::ReplayConflict);
                }
                self.append(&format!("turn:{}:consume:{}", next_sequence, proof.issuance_id), "direct_turn_authorization_consumed", json!({
                    "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
                    "processIncarnation": self.process_incarnation,
                    "issuanceID": proof.issuance_id, "authorizationDigest": proof.authorization_digest,
                    "turnSequence": next_sequence.to_string(), "status": "CONSUMED"
                }))?;
                self.authorizations.get_mut(&proof.issuance_id).expect("validated authorization").state = AuthorizationState::Consumed;
                self.reserved_sequences.remove(&next_sequence);
            }
        }
        let turn = DirectTurnScopeV1 { direct_attempt: scope.clone(), runner_cycle_id: cycle_id.to_owned(), turn_sequence: next_sequence, cycle_digest: String::new() };
        let cycle_digest = turn.cycle_digest().map_err(|_| OwnerLogError::InvalidDigest)?;
        let turn = DirectTurnScopeV1 { cycle_digest, ..turn };
        self.append(&format!("turn:{}:begin", turn.runner_cycle_id), "direct_turn_started", json!({
            "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
            "processIncarnation": self.process_incarnation,
            "turnScope": turn.to_value(), "status": "ACTIVE"
        }))?;
        self.cycles.insert(next_sequence, TurnCycle { scope: turn.clone(), process_incarnation: self.process_incarnation.clone(), result_digest: None,
            receipt_digest: String::new(), state: TurnState::Active, batches: BTreeMap::new(), active_batch_id: None });
        Ok(turn)
    }

    pub(crate) fn validate_active_scope(&self, scope: &DirectTurnScopeV1) -> Result<(), OwnerLogError> {
        let cycle = self.cycles.get(&scope.turn_sequence).ok_or(OwnerLogError::ReplayConflict)?;
        if cycle.state != TurnState::Active || cycle.process_incarnation != self.process_incarnation
            || cycle.scope != *scope || cycle.active_batch_id.is_some()
        { return Err(OwnerLogError::ReplayConflict); }
        Ok(())
    }

    pub(crate) fn validate_batch_member_scope(&self, scope: &DirectTurnScopeV1, batch_id: &str, effect_id: &str) -> Result<(), OwnerLogError> {
        let cycle = self.cycles.get(&scope.turn_sequence).ok_or(OwnerLogError::ReplayConflict)?;
        let batch = cycle.batches.get(batch_id).ok_or(OwnerLogError::ReplayConflict)?;
        if cycle.state != TurnState::Active || cycle.process_incarnation != self.process_incarnation
            || cycle.scope != *scope || cycle.active_batch_id.as_deref() != Some(batch_id) || !batch.effect_ids.iter().any(|id| id == effect_id)
            || batch.final_scope.is_some()
        { return Err(OwnerLogError::ReplayConflict); }
        Ok(())
    }

    pub(crate) fn completed_batch_scope(&self, sequence: u64, batch_id: &str) -> Result<Option<DirectTurnScopeV1>, OwnerLogError> {
        let cycle = self.cycles.get(&sequence).ok_or(OwnerLogError::ReplayConflict)?;
        let batch = cycle.batches.get(batch_id).ok_or(OwnerLogError::ReplayConflict)?;
        Ok(batch.final_scope.clone())
    }

    pub(crate) fn fence_scope_unknown(&mut self, scope: &DirectTurnScopeV1, reason: &str) -> Result<(), OwnerLogError> {
        let cycle = self.cycles.get(&scope.turn_sequence).ok_or(OwnerLogError::ReplayConflict)?;
        if cycle.scope != *scope { return Err(OwnerLogError::ReplayConflict); }
        if cycle.state == TurnState::Unknown { return Ok(()); }
        if cycle.state != TurnState::Active { return Err(OwnerLogError::ReplayConflict); }
        self.mark_cycle_unknown(scope.turn_sequence, &scope.cycle_digest, reason)
    }

    /// Durably pins the complete admitted batch before HostKernel issues any
    /// one-use member lease. The refreshed scope is HostKernel-derived after
    /// the atomic Attempt bind and remains the batch's immutable authority.
    pub(crate) fn bind_effect_batch(&mut self, admitted: &DirectTurnScopeV1, refreshed: &DirectTurnScopeV1,
        batch_id: &str, effect_ids: &[String]) -> Result<(), OwnerLogError> {
        let cycle = self.cycles.get(&admitted.turn_sequence).ok_or(OwnerLogError::ReplayConflict)?;
        let unique_ids = effect_ids.iter().cloned().collect::<BTreeSet<_>>();
        if cycle.state != TurnState::Active || cycle.scope != *admitted || cycle.active_batch_id.is_some()
            || cycle.process_incarnation != self.process_incarnation || !valid_id(batch_id)
            || cycle.batches.contains_key(batch_id)
            || unique_ids.is_empty() || unique_ids.len() != effect_ids.len() || unique_ids.len() > 32
            || refreshed.runner_cycle_id != admitted.runner_cycle_id || refreshed.turn_sequence != admitted.turn_sequence
            || !same_direct_attempt_authority(&admitted.direct_attempt, &refreshed.direct_attempt)
            || refreshed.direct_attempt.child_session_id != self.child_session_id
            || refreshed.direct_attempt.owner_epoch != self.owner_epoch
            || refreshed.direct_attempt.expected_revision < admitted.direct_attempt.expected_revision
            || refreshed.cycle_digest().ok().as_deref() != Some(refreshed.cycle_digest.as_str())
        { return Err(OwnerLogError::ReplayConflict); }
        self.append(&format!("turn:{}:batch:{}:bind", admitted.turn_sequence, batch_id), "direct_turn_batch_bound", json!({
            "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
            "processIncarnation": self.process_incarnation, "batchID": batch_id,
            "admittedScope": admitted.to_value(), "refreshedScope": refreshed.to_value(),
            "effectIDs": effect_ids, "status": "BOUND"
        }))?;
        let cycle = self.cycles.get_mut(&admitted.turn_sequence).expect("validated cycle");
        cycle.scope = refreshed.clone();
        cycle.batches.insert(batch_id.to_owned(), TurnBatch { admitted_scope: admitted.clone(),
            effect_ids: effect_ids.to_vec(), receipts: BTreeMap::new(), receipt_scopes: BTreeMap::new(), final_scope: None });
        cycle.active_batch_id = Some(batch_id.to_owned());
        Ok(())
    }

    /// Records an exact terminal receipt. The batch exposes only one refreshed
    /// scope, on its final member; duplicate receipts are accepted only byte for
    /// byte and cannot mint a different scope.
    pub(crate) fn record_batch_receipt(&mut self, sequence: u64, batch_id: &str, effect_id: &str,
        receipt_digest: &str, refreshed: &DirectTurnScopeV1) -> Result<Option<DirectTurnScopeV1>, OwnerLogError> {
        if !valid_digest(receipt_digest, "blake3:") { return Err(OwnerLogError::InvalidDigest); }
        let cycle = self.cycles.get(&sequence).ok_or(OwnerLogError::ReplayConflict)?;
        let batch = cycle.batches.get(batch_id).ok_or(OwnerLogError::ReplayConflict)?;
        if !batch.effect_ids.iter().any(|id| id == effect_id)
            || refreshed.runner_cycle_id != cycle.scope.runner_cycle_id || refreshed.turn_sequence != sequence
            || !same_direct_attempt_authority(&batch.admitted_scope.direct_attempt, &refreshed.direct_attempt)
            || refreshed.cycle_digest().ok().as_deref() != Some(refreshed.cycle_digest.as_str())
        { return Err(OwnerLogError::ReplayConflict); }
        if let Some(existing) = batch.receipts.get(effect_id) {
            if existing != receipt_digest || batch.receipt_scopes.get(effect_id) != Some(&refreshed.direct_attempt) {
                return Err(OwnerLogError::ReplayConflict);
            }
            return Ok(batch.final_scope.clone());
        }
        if cycle.state != TurnState::Active || cycle.active_batch_id.as_deref() != Some(batch_id) || batch.final_scope.is_some() {
            return Err(OwnerLogError::ReplayConflict);
        }
        let latest_revision = batch.receipt_scopes.values().map(|scope| scope.expected_revision)
            .max().unwrap_or(cycle.scope.direct_attempt.expected_revision);
        if refreshed.direct_attempt.expected_revision < latest_revision {
            return Err(OwnerLogError::ReplayConflict);
        }
        self.append(&format!("turn:{}:batch:{}:receipt:{}", sequence, batch_id, effect_id), "direct_turn_batch_member_receipt", json!({
            "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
            "processIncarnation": self.process_incarnation, "turnSequence": sequence.to_string(),
            "batchID": batch_id, "effectID": effect_id, "receiptDigest": receipt_digest,
            "refreshedAttempt": refreshed.direct_attempt.to_value(), "status": "TERMINAL"
        }))?;
        let cycle = self.cycles.get_mut(&sequence).expect("validated cycle");
        let batch = cycle.batches.get_mut(batch_id).expect("validated batch");
        batch.receipts.insert(effect_id.to_owned(), receipt_digest.to_owned());
        batch.receipt_scopes.insert(effect_id.to_owned(), refreshed.direct_attempt.clone());
        if batch.receipts.len() != batch.effect_ids.len() || batch.receipt_scopes.len() != batch.effect_ids.len() { return Ok(None); }
        let completed_effect_ids = batch.effect_ids.clone();
        self.append(&format!("turn:{}:batch:{}:complete", sequence, batch_id), "direct_turn_batch_completed", json!({
            "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
            "processIncarnation": self.process_incarnation, "turnSequence": sequence.to_string(),
            "batchID": batch_id, "finalScope": refreshed.to_value(),
            "effectIDs": completed_effect_ids, "status": "COMPLETED"
        }))?;
        let cycle = self.cycles.get_mut(&sequence).expect("validated cycle");
        cycle.scope = refreshed.clone();
        cycle.batches.get_mut(batch_id).expect("validated batch").final_scope = Some(refreshed.clone());
        cycle.active_batch_id = None;
        Ok(Some(refreshed.clone()))
    }

    pub(crate) fn complete_turn(&mut self, scope: &DirectTurnScopeV1, result_digest: &str) -> Result<(u64, String), OwnerLogError> {
        if !valid_digest(result_digest, "sha256:") || scope.direct_attempt.child_session_id != self.child_session_id
            || scope.direct_attempt.owner_epoch != self.owner_epoch
        { return Err(OwnerLogError::ReplayConflict); }
        let cycle = self.cycles.get(&scope.turn_sequence).ok_or(OwnerLogError::ReplayConflict)?;
        if cycle.scope != *scope || cycle.active_batch_id.is_some() { return Err(OwnerLogError::ReplayConflict); }
        if cycle.state == TurnState::Completed {
            if cycle.result_digest.as_deref() == Some(result_digest) {
                return Ok((scope.turn_sequence.checked_add(1).ok_or(OwnerLogError::LimitExceeded("direct turn sequence"))?, cycle.receipt_digest.clone()));
            }
            return Err(OwnerLogError::ReplayConflict);
        }
        if cycle.state != TurnState::Active { return Err(OwnerLogError::ReplayConflict); }
        if cycle.process_incarnation != self.process_incarnation { return Err(OwnerLogError::ReplayConflict); }
        let receipt = self.append(&format!("turn:{}:complete", scope.runner_cycle_id), "direct_turn_completed", json!({
            "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
            "processIncarnation": self.process_incarnation,
            "turnScope": scope.to_value(), "resultDigest": result_digest, "status": "COMPLETED"
        }))?;
        let cycle = self.cycles.get_mut(&scope.turn_sequence).expect("validated cycle");
        cycle.result_digest = Some(result_digest.to_owned());
        cycle.receipt_digest = receipt.clone();
        cycle.state = TurnState::Completed;
        Ok((scope.turn_sequence.checked_add(1).ok_or(OwnerLogError::LimitExceeded("direct turn sequence"))?, receipt))
    }

    pub(crate) fn issue_fresh_authorization(&mut self, pins: &DirectMessageAuthorityPinsV1, completed: &DirectTurnScopeV1,
        issuance_id: &str, expires_at_unix_ms: u64) -> Result<FreshTurnAuthorizationV1, OwnerLogError> {
        if pins.delivery_mode != crate::protocol::DirectMessageDeliveryModeV1::FollowUp
            || pins.child_session_id != self.child_session_id || pins.child_owner_epoch != self.owner_epoch
            || !valid_id(issuance_id) || expires_at_unix_ms <= now_ms().ok_or(OwnerLogError::InvalidRecord("clock unavailable"))?
        { return Err(OwnerLogError::ReplayConflict); }
        if let Some(existing) = self.authorizations.values().find(|entry| entry.proof.authority_pins.message_id == pins.message_id) {
            if existing.proof.authority_pins == *pins && existing.proof.completed_turn == *completed
                && matches!(existing.state, AuthorizationState::Issued | AuthorizationState::Reserved)
            { return Ok(existing.proof.clone()); }
            return Err(OwnerLogError::ReplayConflict);
        }
        let latest = self.cycles.get(&completed.turn_sequence).ok_or(OwnerLogError::ReplayConflict)?;
        let next = completed.turn_sequence.checked_add(1).ok_or(OwnerLogError::LimitExceeded("direct turn sequence"))?;
        if latest.scope != *completed || latest.state != TurnState::Completed
            || self.cycles.keys().next_back().copied() != Some(completed.turn_sequence)
            || self.cycles.values().any(|cycle| cycle.state == TurnState::Active || cycle.state == TurnState::Unknown)
            || self.reserved_sequences.contains(&next)
            || self.authorizations.len() >= MAX_AUTHORIZATIONS_PER_CHILD
        { return Err(OwnerLogError::ReplayConflict); }
        let mut proof = FreshTurnAuthorizationV1 { authority_pins: pins.clone(), completed_turn: completed.clone(),
            next_turn_sequence: next, issuance_id: issuance_id.to_owned(), expires_at_unix_ms, authorization_digest: String::new() };
        proof.authorization_digest = proof.authorization_digest().map_err(|_| OwnerLogError::InvalidDigest)?;
        self.append(&format!("turn:auth:{}:issue", proof.issuance_id), "direct_turn_authorization_issued", json!({
            "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
            "processIncarnation": self.process_incarnation,
            "authorization": proof.to_value(), "status": "ISSUED"
        }))?;
        self.authorizations.insert(proof.issuance_id.clone(), AuthorizationEntry { proof: proof.clone(), process_incarnation: self.process_incarnation.clone(), state: AuthorizationState::Issued });
        self.reserved_sequences.insert(next);
        Ok(proof)
    }

    pub(crate) fn reserve_follow_up(&mut self, pins: &DirectMessageAuthorityPinsV1, proof: &FreshTurnAuthorizationV1) -> Result<(), OwnerLogError> {
        let entry = self.authorizations.get(&proof.issuance_id).ok_or(OwnerLogError::ReplayConflict)?;
        if entry.proof != *proof || proof.authority_pins != *pins
            || proof.expires_at_unix_ms <= now_ms().ok_or(OwnerLogError::InvalidRecord("clock unavailable"))?
            || !self.reserved_sequences.contains(&proof.next_turn_sequence)
        { return Err(OwnerLogError::ReplayConflict); }
        if entry.state == AuthorizationState::Reserved { return Ok(()); }
        if entry.state != AuthorizationState::Issued { return Err(OwnerLogError::ReplayConflict); }
        self.append(&format!("turn:auth:{}:reserve", proof.issuance_id), "direct_turn_authorization_reserved", json!({
            "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
            "processIncarnation": self.process_incarnation,
            "issuanceID": proof.issuance_id, "authorizationDigest": proof.authorization_digest,
            "messageID": pins.message_id, "pinsDigest": pins.authority_digest().map_err(|_| OwnerLogError::InvalidDigest)?,
            "turnSequence": proof.next_turn_sequence.to_string(), "status": "RESERVED"
        }))?;
        self.authorizations.get_mut(&proof.issuance_id).expect("validated proof").state = AuthorizationState::Reserved;
        Ok(())
    }

    fn mark_cycle_unknown(&mut self, sequence: u64, digest: &str, reason: &str) -> Result<(), OwnerLogError> {
        self.append(&format!("turn:{}:unknown", sequence), "direct_turn_unknown", json!({
            "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
            "processIncarnation": self.process_incarnation,
            "turnSequence": sequence.to_string(), "cycleDigest": digest, "reason": reason, "status": "UNKNOWN"
        }))?;
        if let Some(cycle) = self.cycles.get_mut(&sequence) { cycle.state = TurnState::Unknown; }
        Ok(())
    }

    fn mark_authorization_unknown(&mut self, issuance_id: &str, digest: &str, reason: &str) -> Result<(), OwnerLogError> {
        self.append(&format!("turn:auth:{}:unknown", issuance_id), "direct_turn_authorization_unknown", json!({
            "childSessionID": self.child_session_id, "ownerEpoch": self.owner_epoch,
            "processIncarnation": self.process_incarnation,
            "issuanceID": issuance_id, "authorizationDigest": digest, "reason": reason, "status": "UNKNOWN"
        }))?;
        if let Some(entry) = self.authorizations.get_mut(issuance_id) { entry.state = AuthorizationState::Unknown; }
        Ok(())
    }

    fn append(&mut self, delivery_id: &str, kind: &str, payload: Value) -> Result<String, OwnerLogError> {
        let time_ms = now_ms().ok_or(OwnerLogError::InvalidRecord("clock unavailable"))?;
        let event = OwnerEventInput { schema_version: OWNER_EVENT_SCHEMA_VERSION_V1, time_ms, kind: kind.to_owned(),
            data: payload, delivery_id: None, command_digest: None };
        let command_digest = OwnerLogV2::command_digest(delivery_id, std::slice::from_ref(&event))?;
        let mut event = event; event.delivery_id = Some(delivery_id.to_owned()); event.command_digest = Some(command_digest.clone());
        let receipt = self.log.append_batch(delivery_id, &command_digest, &[event], self.cursor.as_ref())?;
        let event_digest = receipt.owner_cursor.event_digest.clone();
        self.cursor = Some(receipt.owner_cursor);
        Ok(event_digest)
    }

    fn replay(&mut self) -> Result<(), OwnerLogError> {
        loop {
            let batch = self.log.read_after(self.cursor.as_ref(), NonZeroUsize::new(128).unwrap())?;
            for event in &batch.events {
                let envelope = event.data.as_object().ok_or(OwnerLogError::InvalidRecord("direct turn OwnerLog envelope is invalid"))?;
                if envelope.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
                    return Err(OwnerLogError::InvalidRecord("direct turn event schema is invalid"));
                }
                let payload = envelope.get("payload").and_then(Value::as_object).ok_or(OwnerLogError::InvalidRecord("direct turn event payload is invalid"))?;
                match event.kind.as_str() {
                    "direct_turn_started" => {
                        let scope = DirectTurnScopeV1::from_value(payload.get("turnScope").ok_or(OwnerLogError::InvalidRecord("turn scope missing"))?).ok_or(OwnerLogError::InvalidRecord("turn scope invalid"))?;
                        if string(payload, "childSessionID")? != self.child_session_id || scope.turn_sequence != self.cycles.keys().next_back().copied().unwrap_or(0).checked_add(1).ok_or(OwnerLogError::ReplayConflict)? || self.cycles.len() >= MAX_TURNS_PER_CHILD { return Err(OwnerLogError::ReplayConflict); }
                        // Replay validates the event against the authority that
                        // originally owned this cycle. The journal is opened
                        // under the current epoch; comparing old records to that
                        // epoch here made every restart after an epoch advance
                        // fail before `open` could durably classify the active
                        // cycle UNKNOWN.
                        if number(payload, "ownerEpoch")? != scope.direct_attempt.owner_epoch {
                            return Err(OwnerLogError::ReplayConflict);
                        }
                        let process_incarnation = string(payload, "processIncarnation")?.to_owned();
                        self.cycles.insert(scope.turn_sequence, TurnCycle { scope, process_incarnation, result_digest: None, receipt_digest: String::new(), state: TurnState::Active, batches: BTreeMap::new(), active_batch_id: None });
                    }
                    "direct_turn_completed" => {
                        let scope = DirectTurnScopeV1::from_value(payload.get("turnScope").ok_or(OwnerLogError::InvalidRecord("turn scope missing"))?).ok_or(OwnerLogError::InvalidRecord("turn scope invalid"))?;
                        let result_digest = string(payload, "resultDigest")?.to_owned();
                        let cycle = self.cycles.get_mut(&scope.turn_sequence).ok_or(OwnerLogError::ReplayConflict)?;
                        if cycle.scope != scope || cycle.state != TurnState::Active || cycle.active_batch_id.is_some()
                            || number(payload, "ownerEpoch")? != cycle.scope.direct_attempt.owner_epoch
                            || cycle.process_incarnation != string(payload, "processIncarnation")?
                            || !valid_digest(&result_digest, "sha256:") { return Err(OwnerLogError::ReplayConflict); }
                        cycle.result_digest = Some(result_digest); cycle.receipt_digest = format!("blake3:{}", event.event_digest.to_hex()); cycle.state = TurnState::Completed;
                    }
                    "direct_turn_unknown" => {
                        let sequence = parse_u64(string(payload, "turnSequence")?).ok_or(OwnerLogError::InvalidRecord("turn sequence invalid"))?;
                        let cycle = self.cycles.get_mut(&sequence).ok_or(OwnerLogError::ReplayConflict)?;
                        if string(payload, "childSessionID")? != self.child_session_id
                            || number(payload, "ownerEpoch")? != cycle.scope.direct_attempt.owner_epoch
                            || cycle.process_incarnation != string(payload, "processIncarnation")?
                            || cycle.scope.cycle_digest != string(payload, "cycleDigest")?
                        { return Err(OwnerLogError::ReplayConflict); }
                        cycle.state = TurnState::Unknown;
                    }
                    "direct_turn_batch_bound" => {
                        let admitted = DirectTurnScopeV1::from_value(payload.get("admittedScope").ok_or(OwnerLogError::InvalidRecord("admitted scope missing"))?).ok_or(OwnerLogError::InvalidRecord("admitted scope invalid"))?;
                        let refreshed = DirectTurnScopeV1::from_value(payload.get("refreshedScope").ok_or(OwnerLogError::InvalidRecord("refreshed scope missing"))?).ok_or(OwnerLogError::InvalidRecord("refreshed scope invalid"))?;
                        let batch_id = string(payload, "batchID")?.to_owned();
                        let effect_ids = payload.get("effectIDs").and_then(Value::as_array).ok_or(OwnerLogError::InvalidRecord("batch effect IDs missing"))?.iter()
                            .map(|value| value.as_str().filter(|id| valid_id(id)).map(str::to_owned).ok_or(OwnerLogError::InvalidRecord("batch effect ID invalid"))).collect::<Result<Vec<_>, _>>()?;
                        let unique_ids = effect_ids.iter().cloned().collect::<BTreeSet<_>>();
                        let cycle = self.cycles.get_mut(&admitted.turn_sequence).ok_or(OwnerLogError::ReplayConflict)?;
                        if string(payload, "childSessionID")? != self.child_session_id
                            || number(payload, "ownerEpoch")? != admitted.direct_attempt.owner_epoch
                            || cycle.scope != admitted || cycle.state != TurnState::Active
                            || cycle.active_batch_id.is_some() || cycle.batches.contains_key(&batch_id)
                            || cycle.process_incarnation != string(payload, "processIncarnation")? || unique_ids.is_empty() || unique_ids.len() != effect_ids.len()
                            || refreshed.turn_sequence != admitted.turn_sequence || refreshed.runner_cycle_id != admitted.runner_cycle_id
                            || !same_direct_attempt_authority(&admitted.direct_attempt, &refreshed.direct_attempt)
                        { return Err(OwnerLogError::ReplayConflict); }
                        cycle.scope = refreshed.clone();
                        cycle.batches.insert(batch_id.clone(), TurnBatch { admitted_scope: admitted, effect_ids, receipts: BTreeMap::new(), receipt_scopes: BTreeMap::new(), final_scope: None });
                        cycle.active_batch_id = Some(batch_id);
                    }
                    "direct_turn_batch_member_receipt" => {
                        let sequence = parse_u64(string(payload, "turnSequence")?).ok_or(OwnerLogError::InvalidRecord("turn sequence invalid"))?;
                        let effect_id = string(payload, "effectID")?;
                        let receipt_digest = string(payload, "receiptDigest")?;
                        let refreshed_attempt = DirectAttemptScopeV1::from_value(payload.get("refreshedAttempt").ok_or(OwnerLogError::InvalidRecord("refreshed Attempt missing"))?).ok_or(OwnerLogError::InvalidRecord("refreshed Attempt invalid"))?;
                        if !valid_digest(receipt_digest, "blake3:") { return Err(OwnerLogError::InvalidDigest); }
                        let cycle = self.cycles.get_mut(&sequence).ok_or(OwnerLogError::ReplayConflict)?;
                        let batch_id = string(payload, "batchID")?;
                        let batch = cycle.batches.get_mut(batch_id).ok_or(OwnerLogError::ReplayConflict)?;
                        let latest_revision = batch.receipt_scopes.values().map(|scope| scope.expected_revision)
                            .max().unwrap_or(cycle.scope.direct_attempt.expected_revision);
                        if string(payload, "childSessionID")? != self.child_session_id
                            || number(payload, "ownerEpoch")? != cycle.scope.direct_attempt.owner_epoch
                            || cycle.process_incarnation != string(payload, "processIncarnation")?
                            || cycle.active_batch_id.as_deref() != Some(batch_id) || !batch.effect_ids.iter().any(|id| id == effect_id)
                            || batch.receipts.insert(effect_id.to_owned(), receipt_digest.to_owned()).is_some()
                            || !same_direct_attempt_authority(&batch.admitted_scope.direct_attempt, &refreshed_attempt)
                            || refreshed_attempt.expected_revision < latest_revision
                        { return Err(OwnerLogError::ReplayConflict); }
                        if batch.receipt_scopes.insert(effect_id.to_owned(), refreshed_attempt).is_some() {
                            return Err(OwnerLogError::ReplayConflict);
                        }
                    }
                    "direct_turn_batch_completed" => {
                        let sequence = parse_u64(string(payload, "turnSequence")?).ok_or(OwnerLogError::InvalidRecord("turn sequence invalid"))?;
                        let final_scope = DirectTurnScopeV1::from_value(payload.get("finalScope").ok_or(OwnerLogError::InvalidRecord("final scope missing"))?).ok_or(OwnerLogError::InvalidRecord("final scope invalid"))?;
                        let cycle = self.cycles.get_mut(&sequence).ok_or(OwnerLogError::ReplayConflict)?;
                        let batch_id = string(payload, "batchID")?;
                        let batch = cycle.batches.get_mut(batch_id).ok_or(OwnerLogError::ReplayConflict)?;
                        if string(payload, "childSessionID")? != self.child_session_id
                            || number(payload, "ownerEpoch")? != cycle.scope.direct_attempt.owner_epoch
                            || cycle.process_incarnation != string(payload, "processIncarnation")?
                            || cycle.active_batch_id.as_deref() != Some(batch_id) || batch.receipts.len() != batch.effect_ids.len()
                            || batch.receipt_scopes.len() != batch.effect_ids.len()
                            || final_scope.turn_sequence != sequence || final_scope.runner_cycle_id != cycle.scope.runner_cycle_id
                            || !same_direct_attempt_authority(&batch.admitted_scope.direct_attempt, &final_scope.direct_attempt)
                            || !batch.receipt_scopes.values().any(|scope| scope == &final_scope.direct_attempt)
                            || payload.get("effectIDs").and_then(Value::as_array).is_none_or(|ids| {
                                ids.iter().map(Value::as_str).collect::<Option<Vec<_>>>()
                                    != Some(batch.effect_ids.iter().map(String::as_str).collect::<Vec<_>>())
                            })
                        { return Err(OwnerLogError::ReplayConflict); }
                        batch.final_scope = Some(final_scope.clone());
                        cycle.scope = final_scope;
                        cycle.active_batch_id = None;
                    }
                    "direct_turn_authorization_issued" => {
                        let proof = FreshTurnAuthorizationV1::from_value(payload.get("authorization").ok_or(OwnerLogError::InvalidRecord("authorization missing"))?).ok_or(OwnerLogError::InvalidRecord("authorization invalid"))?;
                        if string(payload, "childSessionID")? != self.child_session_id
                            || number(payload, "ownerEpoch")? != proof.authority_pins.child_owner_epoch
                            || self.authorizations.len() >= MAX_AUTHORIZATIONS_PER_CHILD || self.authorizations.contains_key(&proof.issuance_id) || self.reserved_sequences.contains(&proof.next_turn_sequence) { return Err(OwnerLogError::ReplayConflict); }
                        self.reserved_sequences.insert(proof.next_turn_sequence);
                        self.authorizations.insert(proof.issuance_id.clone(), AuthorizationEntry { proof, process_incarnation: string(payload, "processIncarnation")?.to_owned(), state: AuthorizationState::Issued });
                    }
                    "direct_turn_authorization_reserved" => {
                        let id = string(payload, "issuanceID")?;
                        let entry = self.authorizations.get_mut(id).ok_or(OwnerLogError::ReplayConflict)?;
                        if string(payload, "childSessionID")? != self.child_session_id
                            || number(payload, "ownerEpoch")? != entry.proof.authority_pins.child_owner_epoch
                            || entry.proof.authorization_digest != string(payload, "authorizationDigest")? || entry.state != AuthorizationState::Issued
                            || entry.process_incarnation != string(payload, "processIncarnation")? { return Err(OwnerLogError::ReplayConflict); }
                        entry.state = AuthorizationState::Reserved;
                    }
                    "direct_turn_authorization_consumed" => {
                        let id = string(payload, "issuanceID")?;
                        let entry = self.authorizations.get_mut(id).ok_or(OwnerLogError::ReplayConflict)?;
                        if string(payload, "childSessionID")? != self.child_session_id
                            || number(payload, "ownerEpoch")? != entry.proof.authority_pins.child_owner_epoch
                            || entry.proof.authorization_digest != string(payload, "authorizationDigest")? || entry.state != AuthorizationState::Reserved
                            || entry.process_incarnation != string(payload, "processIncarnation")? { return Err(OwnerLogError::ReplayConflict); }
                        entry.state = AuthorizationState::Consumed;
                        self.reserved_sequences.remove(&entry.proof.next_turn_sequence);
                    }
                    "direct_turn_authorization_unknown" => {
                        let id = string(payload, "issuanceID")?;
                        let entry = self.authorizations.get_mut(id).ok_or(OwnerLogError::ReplayConflict)?;
                        if string(payload, "childSessionID")? != self.child_session_id
                            || number(payload, "ownerEpoch")? != entry.proof.authority_pins.child_owner_epoch
                            || entry.proof.authorization_digest != string(payload, "authorizationDigest")? { return Err(OwnerLogError::ReplayConflict); }
                        entry.state = AuthorizationState::Unknown;
                    }
                    // Mailbox event kinds share this child-keyed OwnerLog and are
                    // replayed by DirectMessageJournalV1.
                    kind if kind.starts_with("direct_message_") => {}
                    _ => return Err(OwnerLogError::InvalidRecord("unknown direct turn OwnerLog event")),
                }
            }
            self.cursor = batch.cursor;
            if !batch.has_more { break; }
        }
        Ok(())
    }
}

fn same_direct_attempt_authority(before: &DirectAttemptScopeV1, after: &DirectAttemptScopeV1) -> bool {
    before.attempt_id == after.attempt_id
        && before.parent_session_id == after.parent_session_id
        && before.child_session_id == after.child_session_id
        && before.owner_epoch == after.owner_epoch
        && before.profile_id == after.profile_id
        && before.profile_revision == after.profile_revision
        && before.profile_digest == after.profile_digest
        && before.location_id == after.location_id
        && before.workspace_id == after.workspace_id
        && before.capability_digest == after.capability_digest
        && before.permissions_digest == after.permissions_digest
        && before.budget_digest == after.budget_digest
        && before.scope_digest == after.scope_digest
}

fn string<'a>(payload: &'a Map<String, Value>, key: &str) -> Result<&'a str, OwnerLogError> { payload.get(key).and_then(Value::as_str).ok_or(OwnerLogError::InvalidRecord("direct turn event string missing")) }
fn number(payload: &Map<String, Value>, key: &str) -> Result<u64, OwnerLogError> { payload.get(key).and_then(Value::as_u64).ok_or(OwnerLogError::InvalidRecord("direct turn event number missing")) }
fn parse_u64(value: &str) -> Option<u64> { (value == "0" || (!value.starts_with('0') && value.bytes().all(|b| b.is_ascii_digit()))).then(|| value.parse().ok()).flatten() }
fn valid_id(value: &str) -> bool { !value.is_empty() && value.len() <= 256 && !value.bytes().any(|b| b.is_ascii_whitespace() || b == 0 || b.is_ascii_control()) }
fn valid_digest(value: &str, prefix: &str) -> bool { value.strip_prefix(prefix).is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())) }
fn now_ms() -> Option<u64> { SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis().try_into().ok() }
