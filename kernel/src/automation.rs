//! Deterministic Rust-owned automation occurrence policy with an OwnerLog-backed
//! journal (`AutomationJournalV1`).
//!
//! Every transition is committed through the canonical owner log before it is
//! visible in memory, and `open` replays the last committed snapshot. The guarded
//! invocation path (`authorize_invocation` / `record_guarded_invocation`) stays
//! unavailable in V1 — `AUTOMATION_INVOCATION_ENABLED` is false and the canonical
//! Guard does not authorize automation actions — so only deterministic scheduling
//! state is produced and no action can start without Guard, lease and receipt.

use crate::guard::{
    self, AuthorizationRequestV1, DecisionKind, EffectOriginKindV1, EffectOriginV1,
    GuardDecisionV1, ResourceResolutionV1,
};
use crate::owner_log::{
    Digest, DurabilityProfile, MAX_OWNER_READ_BATCH_EVENTS, OWNER_EVENT_SCHEMA_VERSION_V1,
    OwnerEventInput, OwnerIdentity, OwnerLogError, OwnerLogV2,
};
use crate::protocol::CursorV1;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, VecDeque};
use std::error::Error;
use std::fmt;
use std::num::NonZeroUsize;
use std::path::Path;

pub const AUTOMATION_INVOCATION_ENABLED: bool = false;
/// OwnerLog event times must stay inside the canonical safe integer range.
const MAX_SAFE_EVENT_TIME_MS: u64 = 9_007_199_254_740_991;
const SNAPSHOT_FORMAT: &str = "horizon.automation-state.v2";
const LEGACY_SNAPSHOT_FORMAT: &str = "horizon.automation-state.v1";
const MAX_ID_BYTES: usize = 256;
const MAX_SCHEDULE_BYTES: usize = 512;
const MAX_TIMEZONE_BYTES: usize = 128;
const MAX_ACTION_INPUT_BYTES: usize = 16 * 1024;
const MAX_ACTION_INPUT_NODES: usize = 2_048;
const MAX_ACTION_INPUT_DEPTH: usize = 16;
const MAX_HISTORY: usize = 128;
const MAX_ATTEMPTS: u8 = 16;
const MAX_RETRY_DELAY_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlapPolicyV1 {
    Skip,
    QueueOne,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MissedRunPolicyV1 {
    Skip,
    RunLatest,
    QueueOne,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutomationOccurrenceStatusV1 {
    PendingGuard,
    RetryWait,
    Running,
    CancelRequested,
    Succeeded,
    Failed,
    Unknown,
    Cancelled,
    Skipped,
    NeedsYou,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutomationOutcomeV1 {
    Succeeded,
    RetryableFailure,
    Failed,
    Unknown,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReconciledOutcomeV1 {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomationRetryPolicyV1 {
    /// Total attempts, including the initial attempt.
    pub max_attempts: u8,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomationDefinitionV1 {
    pub automation_id: String,
    pub version: u64,
    pub action_capability_id: String,
    pub action_version: u64,
    pub action_digest: String,
    /// Canonical machine-registry schema pin; absent only in legacy snapshots.
    pub action_schema_digest: Option<String>,
    /// Fixed, user-authored canonical JSON payload; absent only in legacy snapshots.
    pub action_input_json: Option<String>,
    /// Opaque schedule text retained for the canonical timezone-aware scheduler.
    /// This module intentionally does not parse cron or read host timezone data.
    pub schedule_expression: String,
    pub timezone: String,
    pub enabled: bool,
    pub overlap_policy: OverlapPolicyV1,
    pub missed_run_policy: MissedRunPolicyV1,
    pub retry: AutomationRetryPolicyV1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DueOccurrenceV1 {
    pub occurrence_id: String,
    /// UTC epoch milliseconds resolved by the canonical scheduler/timezone source.
    pub scheduled_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomationOccurrenceV1 {
    pub occurrence_id: String,
    pub scheduled_at_ms: u64,
    pub attempt: u8,
    pub status: AutomationOccurrenceStatusV1,
    pub retry_at_ms: Option<u64>,
    pub cancel_requested: bool,
    pub guard_receipt_ref: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DueDecisionKindV1 {
    ReadyForGuard,
    QueuedOne,
    SkippedMissed,
    SkippedOverlap,
    SkippedReplaced,
    IgnoredDisabled,
    Duplicate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DueDecisionV1 {
    pub occurrence_id: String,
    pub decision: DueDecisionKindV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementDecisionV1 {
    Succeeded,
    RetryScheduled { retry_at_ms: u64 },
    Failed,
    Cancelled,
    NeedsReconciliation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisableResultV1 {
    pub cancelled_pending: bool,
    pub cancel_requested_for_active: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AutomationErrorV1 {
    InvalidDefinition,
    InvalidOccurrence,
    InvalidTransition,
    InvalidSnapshot,
    GuardReceiptRequired,
    RetryNotReady,
    InvocationUnavailable,
    DefinitionConflict,
    PersistenceUnavailable(String),
}

impl fmt::Display for AutomationErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "automation error: {self:?}")
    }
}

impl Error for AutomationErrorV1 {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomationStateV1 {
    definition: AutomationDefinitionV1,
    last_scheduled_at_ms: Option<u64>,
    active: Option<AutomationOccurrenceV1>,
    pending: Option<AutomationOccurrenceV1>,
    retry_pending: Option<AutomationOccurrenceV1>,
    history: VecDeque<AutomationOccurrenceV1>,
}

impl AutomationDefinitionV1 {
    fn validate(&self) -> Result<(), AutomationErrorV1> {
        if !valid_text(&self.automation_id, MAX_ID_BYTES)
            || self.version == 0
            || !valid_text(&self.action_capability_id, MAX_ID_BYTES)
            || self.action_version == 0
            || !valid_text(&self.action_digest, MAX_ID_BYTES)
            || !valid_text(&self.schedule_expression, MAX_SCHEDULE_BYTES)
            || !valid_text(&self.timezone, MAX_TIMEZONE_BYTES)
            || self.retry.max_attempts == 0
            || self.retry.max_attempts > MAX_ATTEMPTS
            || self.retry.initial_delay_ms > self.retry.max_delay_ms
            || self.retry.max_delay_ms > MAX_RETRY_DELAY_MS
        {
            return Err(AutomationErrorV1::InvalidDefinition);
        }
        match (&self.action_schema_digest, &self.action_input_json) {
            (Some(schema), Some(payload)) => {
                if schema.len() != 71
                    || !schema.starts_with("blake3:")
                    || !schema.as_bytes()[7..].iter().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
                    || payload.len() > MAX_ACTION_INPUT_BYTES
                    || !canonical_action_input(payload)
                {
                    return Err(AutomationErrorV1::InvalidDefinition);
                }
            }
            (None, None) => {} // readable legacy record; never eligible for invocation
            _ => return Err(AutomationErrorV1::InvalidDefinition),
        }
        Ok(())
    }

    fn validate_new_definition(&self) -> Result<(), AutomationErrorV1> {
        self.validate()?;
        if self.action_schema_digest.is_none() || self.action_input_json.is_none() {
            return Err(AutomationErrorV1::InvalidDefinition);
        }
        Ok(())
    }
}

impl AutomationStateV1 {
    pub fn new(definition: AutomationDefinitionV1) -> Result<Self, AutomationErrorV1> {
        definition.validate_new_definition()?;
        Ok(Self {
            definition,
            last_scheduled_at_ms: None,
            active: None,
            pending: None,
            retry_pending: None,
            history: VecDeque::new(),
        })
    }

    pub fn definition(&self) -> &AutomationDefinitionV1 {
        &self.definition
    }

    pub fn active(&self) -> Option<&AutomationOccurrenceV1> {
        self.active.as_ref()
    }

    pub fn pending(&self) -> Option<&AutomationOccurrenceV1> {
        self.pending.as_ref()
    }

    pub fn retry_pending(&self) -> Option<&AutomationOccurrenceV1> {
        self.retry_pending.as_ref()
    }

    pub fn history(&self) -> &VecDeque<AutomationOccurrenceV1> {
        &self.history
    }

    /// Records timezone-resolved due occurrences. There is deliberately no cron
    /// parser or local-time fallback here; the input must be in UTC order.
    pub fn record_due_occurrences(
        &mut self,
        now_ms: u64,
        due: &[DueOccurrenceV1],
    ) -> Result<Vec<DueDecisionV1>, AutomationErrorV1> {
        let mut previous = None;
        let mut seen = std::collections::BTreeSet::new();
        for occurrence in due {
            if !valid_text(&occurrence.occurrence_id, MAX_ID_BYTES)
                || occurrence.scheduled_at_ms > now_ms
                || previous.is_some_and(|value| occurrence.scheduled_at_ms <= value)
                || !seen.insert(occurrence.occurrence_id.as_str())
            {
                return Err(AutomationErrorV1::InvalidOccurrence);
            }
            previous = Some(occurrence.scheduled_at_ms);
        }

        let latest_missed = due
            .iter()
            .enumerate()
            .filter(|(_, occurrence)| occurrence.scheduled_at_ms < now_ms)
            .map(|(index, _)| index)
            .last();
        let mut decisions = Vec::with_capacity(due.len());
        for (index, occurrence) in due.iter().enumerate() {
            if self
                .last_scheduled_at_ms
                .is_some_and(|last| occurrence.scheduled_at_ms <= last)
            {
                decisions.push(DueDecisionV1 {
                    occurrence_id: occurrence.occurrence_id.clone(),
                    decision: DueDecisionKindV1::Duplicate,
                });
                continue;
            }
            self.last_scheduled_at_ms = Some(occurrence.scheduled_at_ms);
            let missed = occurrence.scheduled_at_ms < now_ms;
            if !self.definition.enabled {
                self.archive(occurrence_from_due(
                    occurrence,
                    AutomationOccurrenceStatusV1::Skipped,
                ));
                decisions.push(decision(occurrence, DueDecisionKindV1::IgnoredDisabled));
                continue;
            }
            if missed && self.definition.missed_run_policy == MissedRunPolicyV1::Skip {
                self.archive(occurrence_from_due(
                    occurrence,
                    AutomationOccurrenceStatusV1::Skipped,
                ));
                decisions.push(decision(occurrence, DueDecisionKindV1::SkippedMissed));
                continue;
            }
            if missed
                && self.definition.missed_run_policy != MissedRunPolicyV1::Skip
                && latest_missed != Some(index)
            {
                self.archive(occurrence_from_due(
                    occurrence,
                    AutomationOccurrenceStatusV1::Skipped,
                ));
                decisions.push(decision(occurrence, DueDecisionKindV1::SkippedMissed));
                continue;
            }

            let candidate =
                occurrence_from_due(occurrence, AutomationOccurrenceStatusV1::PendingGuard);
            let busy =
                self.active.is_some() || self.pending.is_some() || self.retry_pending.is_some();
            if busy {
                let queue_one = self.definition.overlap_policy == OverlapPolicyV1::QueueOne
                    || (missed && self.definition.missed_run_policy == MissedRunPolicyV1::QueueOne);
                if !queue_one {
                    self.archive(occurrence_from_due(
                        occurrence,
                        AutomationOccurrenceStatusV1::Skipped,
                    ));
                    decisions.push(decision(occurrence, DueDecisionKindV1::SkippedOverlap));
                    continue;
                }
                if let Some(replaced) = self.pending.replace(candidate) {
                    let replaced_id = replaced.occurrence_id.clone();
                    self.archive(with_status(replaced, AutomationOccurrenceStatusV1::Skipped));
                    decisions.push(DueDecisionV1 {
                        occurrence_id: replaced_id,
                        decision: DueDecisionKindV1::SkippedReplaced,
                    });
                }
                decisions.push(decision(occurrence, DueDecisionKindV1::QueuedOne));
                continue;
            }
            self.pending = Some(candidate);
            decisions.push(decision(occurrence, DueDecisionKindV1::ReadyForGuard));
        }
        Ok(decisions)
    }

    /// Returns an occurrence candidate for the canonical Guard caller. It never
    /// invokes, approves, or authorizes the action itself.
    pub fn candidate_for_guard(&self, now_ms: u64) -> Option<&AutomationOccurrenceV1> {
        if !self.definition.enabled || self.active.is_some()
            || self.definition.action_schema_digest.is_none()
            || self.definition.action_input_json.is_none()
        {
            return None;
        }
        self.retry_pending
            .as_ref()
            .filter(|item| item.retry_at_ms.is_none_or(|retry_at| retry_at <= now_ms))
            .or(self.pending.as_ref())
    }

    /// Records a start only after the caller has already completed canonical Guard
    /// authorization and has a durable receipt reference. This method is not an
    /// executor and does not make the action runnable.
    pub(crate) fn record_guarded_start(
        &mut self,
        occurrence_id: &str,
        now_ms: u64,
        guard_receipt_ref: &str,
    ) -> Result<(), AutomationErrorV1> {
        if !self.definition.enabled
            || self.active.is_some()
            || !valid_text(guard_receipt_ref, MAX_ID_BYTES)
        {
            return Err(AutomationErrorV1::GuardReceiptRequired);
        }
        let candidate_id = self
            .candidate_for_guard(now_ms)
            .ok_or(AutomationErrorV1::RetryNotReady)?
            .occurrence_id
            .as_str();
        if candidate_id != occurrence_id {
            return Err(AutomationErrorV1::InvalidTransition);
        }
        let mut candidate = if self
            .retry_pending
            .as_ref()
            .is_some_and(|item| item.occurrence_id == occurrence_id)
        {
            self.retry_pending
                .take()
                .ok_or(AutomationErrorV1::InvalidTransition)?
        } else if self
            .pending
            .as_ref()
            .is_some_and(|item| item.occurrence_id == occurrence_id)
        {
            self.pending
                .take()
                .ok_or(AutomationErrorV1::InvalidTransition)?
        } else {
            return Err(AutomationErrorV1::InvalidTransition);
        };
        candidate.status = AutomationOccurrenceStatusV1::Running;
        candidate.retry_at_ms = None;
        candidate.guard_receipt_ref = Some(guard_receipt_ref.to_owned());
        self.active = Some(candidate);
        Ok(())
    }

    pub fn settle_active(
        &mut self,
        occurrence_id: &str,
        outcome: AutomationOutcomeV1,
        now_ms: u64,
    ) -> Result<SettlementDecisionV1, AutomationErrorV1> {
        let active = self
            .active
            .as_ref()
            .ok_or(AutomationErrorV1::InvalidTransition)?;
        if active.occurrence_id != occurrence_id
            || active.status == AutomationOccurrenceStatusV1::Unknown
        {
            return Err(AutomationErrorV1::InvalidTransition);
        }
        let mut active = self.active.take().expect("active checked above");
        match outcome {
            AutomationOutcomeV1::Succeeded => {
                active.status = AutomationOccurrenceStatusV1::Succeeded;
                self.archive(active);
                Ok(SettlementDecisionV1::Succeeded)
            }
            AutomationOutcomeV1::Cancelled => {
                active.status = AutomationOccurrenceStatusV1::Cancelled;
                self.archive(active);
                Ok(SettlementDecisionV1::Cancelled)
            }
            AutomationOutcomeV1::Unknown => {
                active.status = AutomationOccurrenceStatusV1::Unknown;
                self.active = Some(active);
                Ok(SettlementDecisionV1::NeedsReconciliation)
            }
            AutomationOutcomeV1::Failed => {
                active.status = AutomationOccurrenceStatusV1::Failed;
                self.archive(active);
                Ok(SettlementDecisionV1::Failed)
            }
            AutomationOutcomeV1::RetryableFailure => {
                if active.cancel_requested {
                    active.status = AutomationOccurrenceStatusV1::Cancelled;
                    self.archive(active);
                    return Ok(SettlementDecisionV1::Cancelled);
                }
                if active.attempt >= self.definition.retry.max_attempts {
                    active.status = AutomationOccurrenceStatusV1::Failed;
                    self.archive(active);
                    return Ok(SettlementDecisionV1::Failed);
                }
                active.attempt += 1;
                let delay = retry_delay(&self.definition.retry, active.attempt.saturating_sub(2));
                let retry_at_ms = now_ms.saturating_add(delay);
                active.status = AutomationOccurrenceStatusV1::RetryWait;
                active.retry_at_ms = Some(retry_at_ms);
                active.guard_receipt_ref = None;
                if let Some(replaced) = self.retry_pending.replace(active) {
                    self.archive(with_status(replaced, AutomationOccurrenceStatusV1::Skipped));
                }
                Ok(SettlementDecisionV1::RetryScheduled { retry_at_ms })
            }
        }
    }

    /// UNKNOWN stays blocking until an owner-side receipt/target reconciliation
    /// supplies a known result. Reconciliation never schedules a blind retry.
    pub fn reconcile_unknown(
        &mut self,
        occurrence_id: &str,
        outcome: ReconciledOutcomeV1,
    ) -> Result<(), AutomationErrorV1> {
        let active = self
            .active
            .as_ref()
            .ok_or(AutomationErrorV1::InvalidTransition)?;
        if active.occurrence_id != occurrence_id
            || active.status != AutomationOccurrenceStatusV1::Unknown
        {
            return Err(AutomationErrorV1::InvalidTransition);
        }
        let mut active = self.active.take().expect("unknown active checked above");
        active.status = match outcome {
            ReconciledOutcomeV1::Succeeded => AutomationOccurrenceStatusV1::Succeeded,
            ReconciledOutcomeV1::Failed => AutomationOccurrenceStatusV1::Failed,
            ReconciledOutcomeV1::Cancelled => AutomationOccurrenceStatusV1::Cancelled,
        };
        self.archive(active);
        Ok(())
    }

    pub fn disable(&mut self) -> DisableResultV1 {
        self.definition.enabled = false;
        let mut cancelled_pending = false;
        if let Some(pending) = self.pending.take() {
            self.archive(with_status(
                pending,
                AutomationOccurrenceStatusV1::Cancelled,
            ));
            cancelled_pending = true;
        }
        if let Some(retry) = self.retry_pending.take() {
            self.archive(with_status(retry, AutomationOccurrenceStatusV1::Cancelled));
            cancelled_pending = true;
        }
        let cancel_requested_for_active = if let Some(active) = &mut self.active {
            active.cancel_requested = true;
            if active.status != AutomationOccurrenceStatusV1::Unknown {
                active.status = AutomationOccurrenceStatusV1::CancelRequested;
            }
            true
        } else {
            false
        };
        DisableResultV1 {
            cancelled_pending,
            cancel_requested_for_active,
        }
    }

    pub fn enable(&mut self) {
        self.definition.enabled = true;
    }

    pub fn encode_snapshot(&self) -> Result<Vec<u8>, AutomationErrorV1> {
        let value = state_to_value(self);
        serde_json::to_vec(&value).map_err(|_| AutomationErrorV1::InvalidSnapshot)
    }

    pub fn decode_snapshot(bytes: &[u8]) -> Result<Self, AutomationErrorV1> {
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| AutomationErrorV1::InvalidSnapshot)?;
        if serde_json::to_vec(&value).map_err(|_| AutomationErrorV1::InvalidSnapshot)? != bytes {
            return Err(AutomationErrorV1::InvalidSnapshot);
        }
        value_to_state(value)
    }

    fn archive(&mut self, occurrence: AutomationOccurrenceV1) {
        self.history.push_back(occurrence);
        while self.history.len() > MAX_HISTORY {
            self.history.pop_front();
        }
    }

    fn recover_in_flight_as_unknown(&mut self) -> bool {
        let Some(active) = self.active.as_mut() else {
            return false;
        };
        if matches!(
            active.status,
            AutomationOccurrenceStatusV1::Running | AutomationOccurrenceStatusV1::CancelRequested
        ) {
            // Preserve cancel_requested and the original Guard receipt reference:
            // both are reconciliation facts. Never turn an interrupted start
            // into a fresh retry or assume cancellation completed.
            active.status = AutomationOccurrenceStatusV1::Unknown;
            return true;
        }
        false
    }
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

/// Accept only a canonical bounded JSON object. Schema-specific validation and
/// secret-field rejection are performed against the canonical capability
/// registry by HostKernel before definition mutation and before dispatch.
fn canonical_action_input(source: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(source) else {
        return false;
    };
    if !value.is_object() {
        return false;
    }
    let mut pending = vec![(&value, 1usize)];
    let mut nodes = 0usize;
    while let Some((current, depth)) = pending.pop() {
        nodes += 1;
        if nodes > MAX_ACTION_INPUT_NODES || depth > MAX_ACTION_INPUT_DEPTH {
            return false;
        }
        match current {
            Value::Array(items) => pending.extend(items.iter().map(|item| (item, depth + 1))),
            Value::Object(items) => {
                if items.keys().any(|key| !key.is_ascii() || key.bytes().any(|byte| byte.is_ascii_control())) {
                    return false;
                }
                pending.extend(items.values().map(|item| (item, depth + 1)));
            }
            Value::Number(number) if number.is_i64() || number.is_u64() => {}
            Value::Number(_) => return false,
            _ => {}
        }
    }
    serde_json::to_string(&value).is_ok_and(|canonical| canonical == source)
}

/// Canonical Guard inputs for one automation action. The automation identity and
/// action id/digest are bound by the journal, never supplied here.
pub struct AutomationGuardContextV1<'a> {
    pub principal: &'a str,
    pub request_id: &'a str,
    pub session_id: &'a str,
    pub batch_id: &'a str,
    pub call_id: &'a str,
    pub turn_context_digest: &'a str,
    pub workspace_root: &'a Path,
    pub workspace_binding: &'a str,
    pub target: &'a Path,
    pub resource: &'a str,
}

/// Guarantees requested for an automation action. The canonical Guard currently
/// supports only files/terminal actions, so this list is only reachable behind
/// `AUTOMATION_INVOCATION_ENABLED`; the Guard owner must expose its canonical
/// policy/guarantee constants before invocation can be enabled.
const AUTOMATION_GUARANTEES: &[&str] = &[
    "beneath_workspace_root",
    "no_symlink",
    "no_hardlink",
    "one_use",
];

fn automation_guard_request<'a>(
    definition: &'a AutomationDefinitionV1,
    context: &'a AutomationGuardContextV1<'a>,
    argument_digest: &'a str,
) -> AuthorizationRequestV1<'a> {
    AuthorizationRequestV1 {
        request_id: context.request_id,
        principal: context.principal,
        origin: EffectOriginV1 {
            kind: EffectOriginKindV1::SessionBatch,
            session_id: context.session_id,
            batch_id: context.batch_id,
            call_id: context.call_id,
            scope_digest: None,
        },
        action_id: &definition.action_capability_id,
        argument_digest,
        turn_context_digest: context.turn_context_digest,
        resource_resolution: ResourceResolutionV1 {
            workspace_root: context.workspace_root,
            workspace_binding: context.workspace_binding,
            target: context.target,
            resource: context.resource,
        },
        executable: None,
        policy_snapshot_ids: &[guard::WORKSPACE_WRITE_POLICY_ID],
        requested_guarantees: AUTOMATION_GUARANTEES,
    }
}

fn automation_intent_digest(
    automation_id: &str,
    definition: &AutomationDefinitionV1,
    occurrence_id: &str,
    argument_digest: &str,
) -> Result<String, AutomationRegistryErrorV1> {
    if !valid_text(automation_id, MAX_ID_BYTES)
        || !valid_text(occurrence_id, MAX_ID_BYTES)
        || !valid_digest(argument_digest)
    {
        return Err(AutomationRegistryErrorV1::InvalidIdempotency);
    }
    let (schema_digest, payload_digest) = definition_action_input_digests(definition)?;
    if argument_digest != payload_digest {
        return Err(AutomationRegistryErrorV1::InvalidIdempotency);
    }
    let definition_version = definition.version.to_string();
    let action_version = definition.action_version.to_string();
    let fields = [
        automation_id.as_bytes(),
        definition_version.as_bytes(),
        definition.action_capability_id.as_bytes(),
        action_version.as_bytes(),
        definition.action_digest.as_bytes(),
        schema_digest.as_bytes(),
        payload_digest.as_bytes(),
        occurrence_id.as_bytes(),
    ];
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.automation-effect-intent.v2\0");
    for field in fields {
        hasher.update(&(field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

fn definition_action_input_digests(
    definition: &AutomationDefinitionV1,
) -> Result<(&str, String), AutomationRegistryErrorV1> {
    let schema = definition.action_schema_digest.as_deref()
        .ok_or(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvocationUnavailable))?;
    let payload = definition.action_input_json.as_deref()
        .ok_or(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvocationUnavailable))?;
    if !canonical_action_input(payload) {
        return Err(AutomationRegistryErrorV1::InvalidIdempotency);
    }
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.automation-fixed-input.v1\0");
    hasher.update(&(payload.len() as u64).to_be_bytes());
    hasher.update(payload.as_bytes());
    Ok((schema, format!("blake3:{}", hasher.finalize().to_hex())))
}

const JOURNAL_OWNER_KIND: &str = "automation";
const JOURNAL_EVENT_KIND: &str = "automation.transition.v1";
/// Bounded replay scan; a journal larger than this requires compaction first.
const MAX_JOURNAL_RECORDS: u64 = 65_536;
const REGISTRY_OWNER_KIND: &str = "automation_registry";
const REGISTRY_EVENT_KIND: &str = "automation.registry.transition.v1";
const REGISTRY_SNAPSHOT_FORMAT: &str = "horizon.automation-registry.v2";
const LEGACY_REGISTRY_SNAPSHOT_FORMAT: &str = "horizon.automation-registry.v1";
const MAX_AUTOMATIONS_PER_SCOPE: usize = 128;
const MAX_MUTATION_RECEIPTS: usize = 256;
const MAX_REGISTRY_RECORDS: u64 = 65_536;
const MAX_REGISTRY_SNAPSHOT_BYTES: usize = 1024 * 1024;

/// One durable automation authority for a trusted owner scope. The OwnerLog
/// snapshot contains both definitions and their runtime occurrence state; there
/// are no per-definition production logs to reconcile or atomically update.
/// `scope_digest` must be minted by the authenticated HostKernel caller.
pub struct AutomationRegistryV1 {
    log: OwnerLogV2,
    scope_digest: String,
    states: BTreeMap<String, AutomationStateV1>,
    receipts: VecDeque<AutomationMutationReceiptV1>,
    commits: u64,
    last_time_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomationMutationReceiptV1 {
    pub idempotency_key: String,
    pub request_digest: String,
    pub automation_id: String,
    pub definition_version: u64,
    pub operation: String,
    /// Guard/lease and HostKernel outcome binding for persisted definition effects.
    /// Legacy unguarded records decode as `None`; production HostKernel mutations
    /// must use the guarded registry entrypoints below.
    pub guarded_proof: Option<GuardedAutomationMutationProofV1>,
}

/// Verified Guard facts supplied by HostKernel after it has consumed the exact
/// one-use lease and durably settled the persisted definition effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardedAutomationMutationBindingV1 {
    pub challenge_digest: String,
    pub effect_intent_digest: String,
    pub lease_digest: String,
}

/// Durable correlation between one CAS mutation and its Guard/ExecutionHost
/// proof. The execution digest covers the canonical receipt core and therefore
/// does not hash itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardedAutomationMutationProofV1 {
    pub challenge_digest: String,
    pub effect_intent_digest: String,
    pub lease_digest: String,
    pub execution_receipt_digest: String,
}

impl AutomationMutationReceiptV1 {
    pub fn execution_receipt_digest(&self) -> Option<&str> {
        self.guarded_proof.as_ref().map(|proof| proof.execution_receipt_digest.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AutomationRegistryErrorV1 {
    InvalidScope,
    InvalidIdempotency,
    NotFound,
    AlreadyExists,
    VersionConflict { expected: u64, actual: u64 },
    IdempotencyConflict,
    Capacity,
    InvalidSnapshot,
    Automation(AutomationErrorV1),
}

impl fmt::Display for AutomationRegistryErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "automation registry error: {self:?}")
    }
}

impl Error for AutomationRegistryErrorV1 {}

impl From<AutomationErrorV1> for AutomationRegistryErrorV1 {
    fn from(value: AutomationErrorV1) -> Self { Self::Automation(value) }
}

impl AutomationRegistryV1 {
    /// Opens the single scope OwnerLog and recovers interrupted Running or
    /// CancelRequested occurrences as UNKNOWN before returning it to callers.
    pub fn open(root: &Path, scope_digest: &str) -> Result<Self, AutomationRegistryErrorV1> {
        if !valid_digest(scope_digest) { return Err(AutomationRegistryErrorV1::InvalidScope); }
        let owner = OwnerIdentity::new(REGISTRY_OWNER_KIND.to_owned(), scope_digest.to_owned())
            .map_err(|e| AutomationErrorV1::PersistenceUnavailable(e.to_string()))?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)
            .map_err(|e| AutomationErrorV1::PersistenceUnavailable(e.to_string()))?;
        let (snapshot, commits, last_time_ms) = Self::replay(&log)?;
        let (mut states, receipts) = match snapshot {
            Some(bytes) => decode_registry_snapshot(&bytes, scope_digest)?,
            None => (BTreeMap::new(), VecDeque::new()),
        };
        let mut recovered = false;
        for state in states.values_mut() { recovered |= state.recover_in_flight_as_unknown(); }
        let mut result = Self { log, scope_digest: scope_digest.to_owned(), states, receipts, commits, last_time_ms };
        if recovered { result.commit_snapshot("recovered_unknown", last_time_ms)?; }
        Ok(result)
    }

    pub fn list(&self) -> impl Iterator<Item = &AutomationStateV1> { self.states.values() }
    pub fn get(&self, automation_id: &str) -> Option<&AutomationStateV1> { self.states.get(automation_id) }
    pub fn commits(&self) -> u64 { self.commits }

    /// Read-only exact recovery lookup for a one-use guarded mutation. A missing
    /// key is not evidence that dispatch was absent by itself; HostKernel must
    /// also reconcile the corresponding EffectHost state before returning
    /// NOT_FOUND to Core.
    pub fn reconcile_mutation(
        &self,
        idempotency_key: &str,
        request_digest: &str,
        automation_id: &str,
        operation: &str,
        binding: &GuardedAutomationMutationBindingV1,
    ) -> Result<Option<&AutomationMutationReceiptV1>, AutomationRegistryErrorV1> {
        if !valid_text(idempotency_key, MAX_ID_BYTES)
            || !valid_digest(request_digest)
            || !valid_text(automation_id, MAX_ID_BYTES)
            || !matches!(operation, "create" | "update" | "enable" | "disable")
            || !valid_digest(&binding.challenge_digest)
            || !valid_digest(&binding.effect_intent_digest)
            || !valid_digest(&binding.lease_digest)
        {
            return Err(AutomationRegistryErrorV1::InvalidIdempotency);
        }
        let Some(receipt) = self.receipts.iter().find(|receipt| receipt.idempotency_key == idempotency_key) else {
            return Ok(None);
        };
        let proof = receipt.guarded_proof.as_ref();
        if receipt.request_digest != request_digest
            || receipt.automation_id != automation_id
            || receipt.operation != operation
            || proof.is_none_or(|proof| {
                proof.challenge_digest != binding.challenge_digest
                    || proof.effect_intent_digest != binding.effect_intent_digest
                    || proof.lease_digest != binding.lease_digest
            })
        {
            return Err(AutomationRegistryErrorV1::IdempotencyConflict);
        }
        Ok(Some(receipt))
    }

    /// Create is idempotent by request key and refuses implicit replacement.
    pub fn create(&mut self, definition: AutomationDefinitionV1, idempotency_key: &str,
        request_digest: &str, now_ms: u64)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        definition.validate_new_definition()?;
        let id = definition.automation_id.clone();
        self.apply_mutation(&id, "create", idempotency_key, request_digest, now_ms, |states| {
            if states.contains_key(&id) { return Err(AutomationRegistryErrorV1::AlreadyExists); }
            if states.len() >= MAX_AUTOMATIONS_PER_SCOPE { return Err(AutomationRegistryErrorV1::Capacity); }
            states.insert(id.clone(), AutomationStateV1::new(definition).map_err(Into::into)?);
            Ok(())
        })
    }

    /// Persist a definition creation only alongside HostKernel-verified Guard,
    /// EffectIntent and consumed-lease bindings. This is the production API for
    /// `automations.create`; the legacy helper above is retained for isolated
    /// registry fixtures and is not a HostKernel dispatch path.
    pub fn create_guarded(&mut self, definition: AutomationDefinitionV1,
        idempotency_key: &str, request_digest: &str, now_ms: u64,
        binding: GuardedAutomationMutationBindingV1)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        definition.validate_new_definition()?;
        let id = definition.automation_id.clone();
        self.apply_guarded_mutation(&id, "create", idempotency_key, request_digest, now_ms, binding, |states| {
            if states.contains_key(&id) { return Err(AutomationRegistryErrorV1::AlreadyExists); }
            if states.len() >= MAX_AUTOMATIONS_PER_SCOPE { return Err(AutomationRegistryErrorV1::Capacity); }
            states.insert(id.clone(), AutomationStateV1::new(definition).map_err(Into::into)?);
            Ok(())
        })
    }

    /// Replaces the immutable definition only with an exact version CAS and
    /// next revision. Runtime occurrence state is retained with that definition.
    pub fn update(&mut self, definition: AutomationDefinitionV1, expected_version: u64,
        idempotency_key: &str, request_digest: &str, now_ms: u64)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        definition.validate_new_definition()?;
        let id = definition.automation_id.clone();
        self.apply_mutation(&id, "update", idempotency_key, request_digest, now_ms, |states| {
            let current = states.get_mut(&id).ok_or(AutomationRegistryErrorV1::NotFound)?;
            check_version(current, expected_version)?;
            if current.active.is_some() || current.pending.is_some() || current.retry_pending.is_some() {
                return Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvalidTransition));
            }
            if definition.version != expected_version.checked_add(1).ok_or(AutomationRegistryErrorV1::Capacity)? {
                return Err(AutomationRegistryErrorV1::VersionConflict { expected: expected_version + 1, actual: definition.version });
            }
            current.definition = definition;
            Ok(())
        })
    }

    /// Guarded CAS update. Exact replay requires the same proof tuple as the
    /// original mutation; a changed challenge, intent, or lease conflicts.
    pub fn update_guarded(&mut self, definition: AutomationDefinitionV1,
        expected_version: u64, idempotency_key: &str, request_digest: &str,
        now_ms: u64, binding: GuardedAutomationMutationBindingV1)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        definition.validate_new_definition()?;
        let id = definition.automation_id.clone();
        self.apply_guarded_mutation(&id, "update", idempotency_key, request_digest, now_ms, binding, |states| {
            let current = states.get_mut(&id).ok_or(AutomationRegistryErrorV1::NotFound)?;
            check_version(current, expected_version)?;
            if current.active.is_some() || current.pending.is_some() || current.retry_pending.is_some() {
                return Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvalidTransition));
            }
            if definition.version != expected_version.checked_add(1).ok_or(AutomationRegistryErrorV1::Capacity)? {
                return Err(AutomationRegistryErrorV1::VersionConflict { expected: expected_version + 1, actual: definition.version });
            }
            current.definition = definition;
            Ok(())
        })
    }

    pub fn set_enabled(&mut self, automation_id: &str, expected_version: u64, enabled: bool,
        idempotency_key: &str, request_digest: &str, now_ms: u64)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        self.apply_mutation(automation_id, if enabled { "enable" } else { "disable" }, idempotency_key, request_digest, now_ms, |states| {
            let state = states.get_mut(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?;
            check_version(state, expected_version)?;
            if enabled { state.enable(); } else { state.disable(); }
            state.definition.version = expected_version.checked_add(1).ok_or(AutomationRegistryErrorV1::Capacity)?;
            Ok(())
        })
    }

    /// Guarded enable/disable CAS. HostKernel supplies only bindings recovered
    /// from the exact approved user action and consumed one-use lease.
    pub fn set_enabled_guarded(&mut self, automation_id: &str, expected_version: u64,
        enabled: bool, idempotency_key: &str, request_digest: &str, now_ms: u64,
        binding: GuardedAutomationMutationBindingV1)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        self.apply_guarded_mutation(automation_id, if enabled { "enable" } else { "disable" },
            idempotency_key, request_digest, now_ms, binding, |states| {
                let state = states.get_mut(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?;
                check_version(state, expected_version)?;
                if enabled { state.enable(); } else { state.disable(); }
                state.definition.version = expected_version.checked_add(1).ok_or(AutomationRegistryErrorV1::Capacity)?;
                Ok(())
            })
    }

    pub fn record_due_occurrences(&mut self, automation_id: &str, now_ms: u64,
        due: &[DueOccurrenceV1], idempotency_key: &str, request_digest: &str)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        self.apply_mutation(automation_id, "record_due_occurrences", idempotency_key, request_digest, now_ms, |states| {
            let state = states.get_mut(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?;
            state.record_due_occurrences(now_ms, due)?;
            Ok(())
        })
    }

    pub fn settle_active(&mut self, automation_id: &str, occurrence_id: &str,
        outcome: AutomationOutcomeV1, now_ms: u64, idempotency_key: &str, request_digest: &str)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        self.apply_mutation(automation_id, "settle_active", idempotency_key, request_digest, now_ms, |states| {
            states.get_mut(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?
                .settle_active(occurrence_id, outcome, now_ms)?;
            Ok(())
        })
    }

    pub fn reconcile_unknown(&mut self, automation_id: &str, occurrence_id: &str,
        outcome: ReconciledOutcomeV1, now_ms: u64, idempotency_key: &str, request_digest: &str)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        self.apply_mutation(automation_id, "reconcile_unknown", idempotency_key, request_digest, now_ms, |states| {
            states.get_mut(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?
                .reconcile_unknown(occurrence_id, outcome)?;
            Ok(())
        })
    }

    /// Builds the canonical Guard request for a registry-owned action. This is
    /// input to HostKernel authorization only; the registry never dispatches it.
    pub fn guard_request<'a>(
        &'a self,
        automation_id: &str,
        occurrence_id: &str,
        now_ms: u64,
        context: &'a AutomationGuardContextV1<'a>,
        argument_digest: &str,
        bound_argument_digest: &'a str,
    ) -> Result<AuthorizationRequestV1<'a>, AutomationRegistryErrorV1> {
        let state = self.states.get(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?;
        if state.candidate_for_guard(now_ms).is_none_or(|candidate| candidate.occurrence_id != occurrence_id) {
            return Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvalidTransition));
        }
        let intent_digest = automation_intent_digest(automation_id, &state.definition, occurrence_id, argument_digest)?;
        if intent_digest != bound_argument_digest {
            return Err(AutomationRegistryErrorV1::InvalidIdempotency);
        }
        Ok(automation_guard_request(&state.definition, context, bound_argument_digest))
    }

    pub fn guard_request_digest(
        &self,
        automation_id: &str,
        occurrence_id: &str,
        now_ms: u64,
        argument_digest: &str,
    ) -> Result<String, AutomationRegistryErrorV1> {
        let state = self.states.get(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?;
        if state.candidate_for_guard(now_ms).is_none_or(|candidate| candidate.occurrence_id != occurrence_id) {
            return Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvalidTransition));
        }
        automation_intent_digest(automation_id, &state.definition, occurrence_id, argument_digest)
    }

    /// Remains fail-closed until P1 connects this record boundary to an
    /// authenticated Guard decision, consumed one-use lease, supervised action,
    /// durable effect receipt and restart reconciliation.
    pub fn authorize_invocation<'a>(
        &'a self,
        automation_id: &str,
        occurrence_id: &str,
        now_ms: u64,
        context: &'a AutomationGuardContextV1<'a>,
        argument_digest: &'a str,
    ) -> Result<GuardDecisionV1, AutomationRegistryErrorV1> {
        if !AUTOMATION_INVOCATION_ENABLED {
            return Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvocationUnavailable));
        }
        let state = self.states.get(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?;
        if state.candidate_for_guard(now_ms).is_none_or(|candidate| candidate.occurrence_id != occurrence_id) {
            return Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvalidTransition));
        }
        let intent_digest = automation_intent_digest(automation_id, &state.definition, occurrence_id, argument_digest)?;
        let request = automation_guard_request(&state.definition, context, &intent_digest);
        let decision = guard::authorize(&request, context.request_id);
        let state = self.states.get(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?;
        if decision.decision != DecisionKind::Ask
            || decision.reason_code.is_some()
            || decision.normalized_action != state.definition.action_capability_id
        {
            return Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvocationUnavailable));
        }
        Ok(decision)
    }

    /// The P1 caller must verify the Guard-issued decision and persist/consume
    /// its lease and effect receipt before invoking this atomic registry update.
    /// The V1 feature gate keeps the transition unavailable until that route is
    /// integrated and accepted.
    pub fn record_guarded_invocation(
        &mut self,
        automation_id: &str,
        occurrence_id: &str,
        now_ms: u64,
        guard_receipt_ref: &str,
        decision: &GuardDecisionV1,
        idempotency_key: &str,
        request_digest: &str,
    ) -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1> {
        if !AUTOMATION_INVOCATION_ENABLED {
            return Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvocationUnavailable));
        }
        let action = self
            .states
            .get(automation_id)
            .ok_or(AutomationRegistryErrorV1::NotFound)?
            .definition
            .action_capability_id
            .clone();
        if decision.decision != DecisionKind::Ask
            || decision.reason_code.is_some()
            || decision.normalized_action != action
        {
            return Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::GuardReceiptRequired));
        }
        self.apply_mutation(automation_id, "record_guarded_invocation", idempotency_key,
            request_digest, now_ms, |states| {
                states.get_mut(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?
                    .record_guarded_start(occurrence_id, now_ms, guard_receipt_ref)?;
                Ok(())
            })
    }

    fn apply_mutation<F>(&mut self, automation_id: &str, operation: &str, key: &str,
        request_digest: &str, now_ms: u64, apply: F)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1>
    where F: FnOnce(&mut BTreeMap<String, AutomationStateV1>) -> Result<(), AutomationRegistryErrorV1> {
        self.apply_mutation_inner(automation_id, operation, key, request_digest, now_ms, None, apply)
    }

    fn apply_guarded_mutation<F>(&mut self, automation_id: &str, operation: &str, key: &str,
        request_digest: &str, now_ms: u64, binding: GuardedAutomationMutationBindingV1, apply: F)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1>
    where F: FnOnce(&mut BTreeMap<String, AutomationStateV1>) -> Result<(), AutomationRegistryErrorV1> {
        if !valid_digest(&binding.challenge_digest)
            || !valid_digest(&binding.effect_intent_digest)
            || !valid_digest(&binding.lease_digest)
        {
            return Err(AutomationRegistryErrorV1::InvalidIdempotency);
        }
        self.apply_mutation_inner(automation_id, operation, key, request_digest, now_ms, Some(binding), apply)
    }

    fn apply_mutation_inner<F>(&mut self, automation_id: &str, operation: &str, key: &str,
        request_digest: &str, now_ms: u64, binding: Option<GuardedAutomationMutationBindingV1>, apply: F)
        -> Result<AutomationMutationReceiptV1, AutomationRegistryErrorV1>
    where F: FnOnce(&mut BTreeMap<String, AutomationStateV1>) -> Result<(), AutomationRegistryErrorV1> {
        if !valid_text(key, MAX_ID_BYTES) || !valid_digest(request_digest) || now_ms > MAX_SAFE_EVENT_TIME_MS {
            return Err(AutomationRegistryErrorV1::InvalidIdempotency);
        }
        if let Some(receipt) = self.receipts.iter().find(|r| r.idempotency_key == key) {
            if receipt.request_digest != request_digest
                || receipt.automation_id != automation_id
                || receipt.operation != operation
                || receipt.guarded_proof.as_ref().map(|proof| (
                    &proof.challenge_digest, &proof.effect_intent_digest, &proof.lease_digest,
                )) != binding.as_ref().map(|proof| (
                    &proof.challenge_digest, &proof.effect_intent_digest, &proof.lease_digest,
                ))
            { return Err(AutomationRegistryErrorV1::IdempotencyConflict); }
            return Ok(receipt.clone());
        }
        let mut states = self.states.clone();
        apply(&mut states)?;
        let state = states.get(automation_id).ok_or(AutomationRegistryErrorV1::NotFound)?;
        let mut receipt = AutomationMutationReceiptV1 { idempotency_key:key.to_owned(), request_digest:request_digest.to_owned(), automation_id:automation_id.to_owned(), definition_version:state.definition.version, operation:operation.to_owned(), guarded_proof: None };
        if let Some(binding) = binding {
            let execution_receipt_digest = mutation_receipt_core_digest(&receipt);
            receipt.guarded_proof = Some(GuardedAutomationMutationProofV1 {
                challenge_digest: binding.challenge_digest,
                effect_intent_digest: binding.effect_intent_digest,
                lease_digest: binding.lease_digest,
                execution_receipt_digest,
            });
        }
        let mut receipts = self.receipts.clone();
        receipts.push_back(receipt.clone());
        while receipts.len() > MAX_MUTATION_RECEIPTS { receipts.pop_front(); }
        self.commit_registry("mutation", states, receipts, now_ms)?;
        Ok(receipt)
    }

    fn commit_snapshot(&mut self, operation: &str, now_ms: u64)
        -> Result<(), AutomationRegistryErrorV1> {
        // Recovery is an owner-log transition, not a caller mutation. Do not
        // consume a caller-controlled idempotency key for it: doing so could
        // make a legitimate first request collide with a synthetic `recovery-N`
        // receipt after restart.
        self.commit_registry(operation, self.states.clone(), self.receipts.clone(), now_ms)
    }

    fn commit_registry(&mut self, operation: &str, states: BTreeMap<String, AutomationStateV1>,
        receipts: VecDeque<AutomationMutationReceiptV1>, now_ms: u64) -> Result<(), AutomationRegistryErrorV1> {
        let bytes = encode_registry_snapshot(&self.scope_digest, &states, &receipts)?;
        if bytes.len() > MAX_REGISTRY_SNAPSHOT_BYTES { return Err(AutomationRegistryErrorV1::Capacity); }
        let snapshot_json = String::from_utf8(bytes).map_err(|_| AutomationRegistryErrorV1::InvalidSnapshot)?;
        let delivery_id = format!("automation-registry-{}-{}", Digest::from_blake3(self.scope_digest.as_bytes()).to_hex(), self.commits + 1);
        let event = OwnerEventInput { schema_version:OWNER_EVENT_SCHEMA_VERSION_V1, time_ms:self.last_time_ms.max(now_ms), kind:REGISTRY_EVENT_KIND.to_owned(), data:serde_json::json!({"operation":operation,"snapshotJson":snapshot_json}), delivery_id:None, command_digest:None };
        let events = [event];
        let digest = OwnerLogV2::command_digest(&delivery_id, &events).map_err(|e| AutomationRegistryErrorV1::Automation(persistence(e)))?;
        self.log.append_batch(&delivery_id, &digest, &events, None).map_err(|e| AutomationRegistryErrorV1::Automation(persistence(e)))?;
        self.states=states; self.receipts=receipts; self.commits+=1; self.last_time_ms=self.last_time_ms.max(now_ms);
        Ok(())
    }

    fn replay(log: &OwnerLogV2) -> Result<(Option<Vec<u8>>,u64,u64),AutomationRegistryErrorV1> {
        let limit=NonZeroUsize::new(MAX_OWNER_READ_BATCH_EVENTS).expect("nonzero batch limit");
        let mut cursor: Option<CursorV1>=None; let mut scanned=0_u64; let mut commits=0_u64; let mut time=0_u64; let mut snapshot=None;
        loop { let batch=log.read_after(cursor.as_ref(),limit).map_err(|e| AutomationRegistryErrorV1::Automation(persistence(e)))?;
            scanned=scanned.checked_add(batch.events.len() as u64).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?;
            if scanned>MAX_REGISTRY_RECORDS { return Err(AutomationRegistryErrorV1::Capacity); }
            for record in &batch.events { time=time.max(record.time_ms); if record.kind==REGISTRY_EVENT_KIND {
                let encoded=record.data.get("payload").and_then(|v|v.get("snapshotJson")).and_then(Value::as_str).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?;
                snapshot=Some(encoded.as_bytes().to_vec()); commits+=1;
            } else { return Err(AutomationRegistryErrorV1::InvalidSnapshot); }}
            match batch.cursor { Some(next) if batch.has_more=>cursor=Some(next), _=>break }
        }
        Ok((snapshot,commits,time))
    }
}

fn check_version(state: &AutomationStateV1, expected: u64) -> Result<(), AutomationRegistryErrorV1> {
    if state.definition.version != expected { return Err(AutomationRegistryErrorV1::VersionConflict { expected, actual:state.definition.version }); } Ok(())
}
fn valid_digest(value: &str) -> bool { value.strip_prefix("blake3:").is_some_and(|hex| hex.len()==64 && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())) }

/// Domain-separated digest for the immutable core of one committed registry
/// mutation. Length-prefixing prevents field-boundary ambiguity. HostKernel
/// stores this exact value as the execution receipt digest in EffectHost.
fn mutation_receipt_core_digest(receipt: &AutomationMutationReceiptV1) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.automation-mutation-receipt-core.v1\0");
    let version = receipt.definition_version.to_string();
    for field in [
        receipt.idempotency_key.as_bytes(),
        receipt.request_digest.as_bytes(),
        receipt.automation_id.as_bytes(),
        version.as_bytes(),
        receipt.operation.as_bytes(),
    ] {
        hasher.update(&(field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn encode_registry_snapshot(scope: &str, states: &BTreeMap<String,AutomationStateV1>, receipts: &VecDeque<AutomationMutationReceiptV1>) -> Result<Vec<u8>,AutomationRegistryErrorV1> {
    let value=serde_json::json!({"format":REGISTRY_SNAPSHOT_FORMAT,"scopeDigest":scope,"automations":states.values().map(state_to_value).collect::<Vec<_>>(),"receipts":receipts.iter().map(|r|serde_json::json!({"idempotencyKey":r.idempotency_key,"requestDigest":r.request_digest,"automationId":r.automation_id,"definitionVersion":r.definition_version,"operation":r.operation,"guardedProof":r.guarded_proof.as_ref().map(|proof| serde_json::json!({"challengeDigest":proof.challenge_digest,"effectIntentDigest":proof.effect_intent_digest,"leaseDigest":proof.lease_digest,"executionReceiptDigest":proof.execution_receipt_digest}))})).collect::<Vec<_>>()});
    serde_json::to_vec(&value).map_err(|_|AutomationRegistryErrorV1::InvalidSnapshot)
}
fn decode_registry_snapshot(bytes:&[u8], scope:&str)->Result<(BTreeMap<String,AutomationStateV1>,VecDeque<AutomationMutationReceiptV1>),AutomationRegistryErrorV1> {
    let value:Value=serde_json::from_slice(bytes).map_err(|_|AutomationRegistryErrorV1::InvalidSnapshot)?;
    if serde_json::to_vec(&value).map_err(|_|AutomationRegistryErrorV1::InvalidSnapshot)?!=bytes{return Err(AutomationRegistryErrorV1::InvalidSnapshot)}
    let object=value.as_object().filter(|o|o.len()==4).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?;
    let format = object.get("format").and_then(Value::as_str).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?;
    let legacy = format == LEGACY_REGISTRY_SNAPSHOT_FORMAT;
    if (!legacy && format != REGISTRY_SNAPSHOT_FORMAT)||object.get("scopeDigest").and_then(Value::as_str)!=Some(scope){return Err(AutomationRegistryErrorV1::InvalidSnapshot)}
    let values=object.get("automations").and_then(Value::as_array).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?;
    if values.len()>MAX_AUTOMATIONS_PER_SCOPE{return Err(AutomationRegistryErrorV1::Capacity)}
    let mut states=BTreeMap::new(); let mut previous:Option<String>=None; for value in values { let state=value_to_state(value.clone()).map_err(AutomationRegistryErrorV1::Automation)?; let id=state.definition.automation_id.clone(); if previous.as_ref().is_some_and(|old| old>=&id){return Err(AutomationRegistryErrorV1::InvalidSnapshot)} previous=Some(id.clone()); if states.insert(id,state).is_some(){return Err(AutomationRegistryErrorV1::InvalidSnapshot)} }
    let values=object.get("receipts").and_then(Value::as_array).filter(|v|v.len()<=MAX_MUTATION_RECEIPTS).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?;
    let mut receipts=VecDeque::new(); let mut receipt_keys=std::collections::BTreeSet::new(); for value in values {
        let o=value.as_object().filter(|o| if legacy { o.len()==5 } else { o.len()==6 }).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?;
        let mut receipt=AutomationMutationReceiptV1 { idempotency_key:o.get("idempotencyKey").and_then(Value::as_str).filter(|v|valid_text(v,MAX_ID_BYTES)).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?.to_owned(), request_digest:o.get("requestDigest").and_then(Value::as_str).filter(|v|valid_digest(v)).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?.to_owned(), automation_id:o.get("automationId").and_then(Value::as_str).filter(|v|valid_text(v,MAX_ID_BYTES)).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?.to_owned(), definition_version:o.get("definitionVersion").and_then(Value::as_u64).filter(|v|*v>0).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?, operation:o.get("operation").and_then(Value::as_str).filter(|v|matches!(*v,"create"|"update"|"enable"|"disable"|"record_due_occurrences"|"settle_active"|"reconcile_unknown"|"record_guarded_invocation")).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?.to_owned(), guarded_proof: None };
        if !legacy {
            if let Some(proof_value) = o.get("guardedProof").filter(|value| !value.is_null()) {
                let proof_object = proof_value.as_object().filter(|proof| proof.len()==4).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?;
                let proof = GuardedAutomationMutationProofV1 {
                    challenge_digest: proof_object.get("challengeDigest").and_then(Value::as_str).filter(|v|valid_digest(v)).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?.to_owned(),
                    effect_intent_digest: proof_object.get("effectIntentDigest").and_then(Value::as_str).filter(|v|valid_digest(v)).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?.to_owned(),
                    lease_digest: proof_object.get("leaseDigest").and_then(Value::as_str).filter(|v|valid_digest(v)).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?.to_owned(),
                    execution_receipt_digest: proof_object.get("executionReceiptDigest").and_then(Value::as_str).filter(|v|valid_digest(v)).ok_or(AutomationRegistryErrorV1::InvalidSnapshot)?.to_owned(),
                };
                if proof.execution_receipt_digest != mutation_receipt_core_digest(&receipt) {
                    return Err(AutomationRegistryErrorV1::InvalidSnapshot);
                }
                receipt.guarded_proof = Some(proof);
            }
        }
        if !receipt_keys.insert(receipt.idempotency_key.clone()) { return Err(AutomationRegistryErrorV1::InvalidSnapshot); }
        let Some(state) = states.get(&receipt.automation_id) else { return Err(AutomationRegistryErrorV1::InvalidSnapshot); };
        if receipt.definition_version > state.definition.version { return Err(AutomationRegistryErrorV1::InvalidSnapshot); }
        receipts.push_back(receipt); }
    Ok((states,receipts))
}

fn persistence(error: OwnerLogError) -> AutomationErrorV1 {
    AutomationErrorV1::PersistenceUnavailable(format!("{error}"))
}

/// OwnerLog-backed automation journal. Every mutation is committed through the
/// canonical owner log before it becomes visible in memory, and `open` replays
/// the last committed snapshot, so overlap/missed/retry state survives reload.
pub struct AutomationJournalV1 {
    log: OwnerLogV2,
    state: AutomationStateV1,
    commits: u64,
    last_time_ms: u64,
}

impl AutomationJournalV1 {
    /// Open one automation owner and replay its last committed snapshot.
    pub fn open(
        root: &Path,
        definition: AutomationDefinitionV1,
    ) -> Result<Self, AutomationErrorV1> {
        definition.validate()?;
        let owner = OwnerIdentity::new(
            JOURNAL_OWNER_KIND.to_owned(),
            definition.automation_id.clone(),
        )
        .map_err(persistence)?;
        let log =
            OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable).map_err(persistence)?;
        let (snapshot, journal_records, last_time_ms) = Self::replay(&log)?;
        let mut state = match snapshot {
            Some(snapshot) => {
                let state = AutomationStateV1::decode_snapshot(&snapshot)?;
                let stored = state.definition();
                if stored.automation_id != definition.automation_id
                    || stored.version != definition.version
                    || stored.action_capability_id != definition.action_capability_id
                    || stored.action_version != definition.action_version
                    || stored.action_digest != definition.action_digest
                {
                    return Err(AutomationErrorV1::DefinitionConflict);
                }
                state
            }
            None => AutomationStateV1::new(definition)?,
        };
        // A journal snapshot is evidence of the last committed state, not proof
        // that an in-flight effect settled before process death. Quarantine any
        // active invocation as UNKNOWN and require owner-side reconciliation.
        let recovered = state.recover_in_flight_as_unknown();
        let mut journal = Self {
            log,
            state,
            commits: journal_records,
            last_time_ms,
        };
        if recovered {
            journal.commit("recovered_unknown", journal.state.clone(), last_time_ms)?;
        }
        Ok(journal)
    }

    pub fn state(&self) -> &AutomationStateV1 {
        &self.state
    }

    pub fn commits(&self) -> u64 {
        self.commits
    }

    /// Replays the committed journal: the last snapshot plus the number of
    /// committed transition records (which is also the next delivery sequence).
    fn replay(log: &OwnerLogV2) -> Result<(Option<Vec<u8>>, u64, u64), AutomationErrorV1> {
        let limit = NonZeroUsize::new(MAX_OWNER_READ_BATCH_EVENTS).expect("nonzero batch limit");
        let mut cursor: Option<CursorV1> = None;
        let mut scanned: u64 = 0;
        let mut journal_records: u64 = 0;
        let mut last_time_ms = 0_u64;
        let mut snapshot: Option<Vec<u8>> = None;
        loop {
            let batch = log
                .read_after(cursor.as_ref(), limit)
                .map_err(persistence)?;
            scanned = scanned
                .checked_add(batch.events.len() as u64)
                .ok_or_else(|| {
                    AutomationErrorV1::PersistenceUnavailable("journal scan overflow".to_owned())
                })?;
            if scanned > MAX_JOURNAL_RECORDS {
                return Err(AutomationErrorV1::PersistenceUnavailable(
                    "automation journal requires compaction".to_owned(),
                ));
            }
            for record in &batch.events {
                last_time_ms = last_time_ms.max(record.time_ms);
                if record.kind != JOURNAL_EVENT_KIND {
                    continue;
                }
                let Some(encoded) = record
                    .data
                    .get("payload")
                    .and_then(|payload| payload.get("snapshotJson"))
                    .and_then(Value::as_str)
                else {
                    return Err(AutomationErrorV1::InvalidSnapshot);
                };
                snapshot = Some(encoded.as_bytes().to_vec());
                journal_records += 1;
            }
            match batch.cursor {
                Some(next) if batch.has_more => cursor = Some(next),
                _ => break,
            }
        }
        Ok((snapshot, journal_records, last_time_ms))
    }

    fn commit(
        &mut self,
        operation: &'static str,
        next: AutomationStateV1,
        now_ms: u64,
    ) -> Result<(), AutomationErrorV1> {
        if now_ms > MAX_SAFE_EVENT_TIME_MS {
            return Err(AutomationErrorV1::InvalidOccurrence);
        }
        let snapshot = next.encode_snapshot()?;
        let snapshot_json =
            String::from_utf8(snapshot).map_err(|_| AutomationErrorV1::InvalidSnapshot)?;
        let delivery_id = format!(
            "automation-{}-{}",
            Digest::from_blake3(self.state.definition.automation_id.as_bytes()).to_hex(),
            self.commits + 1
        );
        let event = OwnerEventInput {
            schema_version: OWNER_EVENT_SCHEMA_VERSION_V1,
            time_ms: now_ms,
            kind: JOURNAL_EVENT_KIND.to_owned(),
            data: serde_json::json!({
                "operation": operation,
                "snapshotJson": snapshot_json,
            }),
            delivery_id: None,
            command_digest: None,
        };
        let events = [event];
        let command_digest =
            OwnerLogV2::command_digest(&delivery_id, &events).map_err(persistence)?;
        self.log
            .append_batch(&delivery_id, &command_digest, &events, None)
            .map_err(persistence)?;
        self.state = next;
        self.commits += 1;
        self.last_time_ms = self.last_time_ms.max(now_ms);
        Ok(())
    }

    pub fn record_due_occurrences(
        &mut self,
        now_ms: u64,
        due: &[DueOccurrenceV1],
    ) -> Result<Vec<DueDecisionV1>, AutomationErrorV1> {
        let mut next = self.state.clone();
        let decisions = next.record_due_occurrences(now_ms, due)?;
        let committed_time = self.last_time_ms.max(now_ms);
        self.commit("record_due_occurrences", next, committed_time)?;
        Ok(decisions)
    }

    pub fn settle_active(
        &mut self,
        occurrence_id: &str,
        outcome: AutomationOutcomeV1,
        now_ms: u64,
    ) -> Result<SettlementDecisionV1, AutomationErrorV1> {
        let mut next = self.state.clone();
        let decision = next.settle_active(occurrence_id, outcome, now_ms)?;
        let committed_time = self.last_time_ms.max(now_ms);
        self.commit("settle_active", next, committed_time)?;
        Ok(decision)
    }

    pub fn reconcile_unknown(
        &mut self,
        occurrence_id: &str,
        outcome: ReconciledOutcomeV1,
        now_ms: u64,
    ) -> Result<(), AutomationErrorV1> {
        let mut next = self.state.clone();
        next.reconcile_unknown(occurrence_id, outcome)?;
        let committed_time = self.last_time_ms.max(now_ms);
        self.commit("reconcile_unknown", next, committed_time)?;
        Ok(())
    }

    pub fn disable(&mut self, now_ms: u64) -> Result<DisableResultV1, AutomationErrorV1> {
        let mut next = self.state.clone();
        let result = next.disable();
        let committed_time = self.last_time_ms.max(now_ms);
        self.commit("disable", next, committed_time)?;
        Ok(result)
    }

    pub fn enable(&mut self, now_ms: u64) -> Result<(), AutomationErrorV1> {
        let mut next = self.state.clone();
        next.enable();
        let committed_time = self.last_time_ms.max(now_ms);
        self.commit("enable", next, committed_time)?;
        Ok(())
    }

    /// Canonical Guard request for this automation's action. Building a request is
    /// not authorization: callers must still resolve the canonical decision.
    pub fn guard_request<'a>(
        &'a self,
        context: &'a AutomationGuardContextV1<'a>,
        argument_digest: &'a str,
    ) -> AuthorizationRequestV1<'a> {
        automation_guard_request(&self.state.definition, context, argument_digest)
    }

    /// Guarded invocation entry point. V1 keeps invocation unavailable: while
    /// `AUTOMATION_INVOCATION_ENABLED` is false, and while the canonical Guard
    /// denies this action, only deterministic scheduling state is produced — no
    /// effect is admitted, dispatched or recorded as started.
    pub fn authorize_invocation<'a>(
        &'a self,
        context: &'a AutomationGuardContextV1<'a>,
        argument_digest: &'a str,
    ) -> Result<GuardDecisionV1, AutomationErrorV1> {
        if !AUTOMATION_INVOCATION_ENABLED {
            return Err(AutomationErrorV1::InvocationUnavailable);
        }
        let request = self.guard_request(context, argument_digest);
        let decision = guard::authorize(&request, context.request_id);
        if decision.decision != DecisionKind::Ask || decision.reason_code.is_some() {
            return Err(AutomationErrorV1::InvocationUnavailable);
        }
        Ok(decision)
    }

    /// Records a guarded start only after canonical authorization and a durable
    /// receipt exist. Unavailable in V1; kept typed so the production caller
    /// cannot skip Guard, lease or receipt once invocation is enabled.
    pub fn record_guarded_invocation(
        &mut self,
        occurrence_id: &str,
        now_ms: u64,
        guard_receipt_ref: &str,
        decision: &GuardDecisionV1,
    ) -> Result<(), AutomationErrorV1> {
        if !AUTOMATION_INVOCATION_ENABLED {
            return Err(AutomationErrorV1::InvocationUnavailable);
        }
        if decision.decision != DecisionKind::Ask
            || decision.reason_code.is_some()
            || decision.normalized_action != self.state.definition.action_capability_id
        {
            return Err(AutomationErrorV1::GuardReceiptRequired);
        }
        let mut next = self.state.clone();
        next.record_guarded_start(occurrence_id, now_ms, guard_receipt_ref)?;
        let committed_time = self.last_time_ms.max(now_ms);
        self.commit("record_guarded_invocation", next, committed_time)?;
        Ok(())
    }

    /// Test-only durable start, so retry/unknown persistence can be exercised
    /// while production invocation stays disabled.
    #[cfg(test)]
    pub(crate) fn record_test_guarded_start(
        &mut self,
        occurrence_id: &str,
        now_ms: u64,
        guard_receipt_ref: &str,
    ) -> Result<(), AutomationErrorV1> {
        let mut next = self.state.clone();
        next.record_guarded_start(occurrence_id, now_ms, guard_receipt_ref)?;
        let committed_time = self.last_time_ms.max(now_ms);
        self.commit("record_test_guarded_start", next, committed_time)?;
        Ok(())
    }
}

fn occurrence_from_due(
    due: &DueOccurrenceV1,
    status: AutomationOccurrenceStatusV1,
) -> AutomationOccurrenceV1 {
    AutomationOccurrenceV1 {
        occurrence_id: due.occurrence_id.clone(),
        scheduled_at_ms: due.scheduled_at_ms,
        attempt: 0,
        status,
        retry_at_ms: None,
        cancel_requested: false,
        guard_receipt_ref: None,
    }
}

fn decision(due: &DueOccurrenceV1, decision: DueDecisionKindV1) -> DueDecisionV1 {
    DueDecisionV1 {
        occurrence_id: due.occurrence_id.clone(),
        decision,
    }
}

fn with_status(
    mut occurrence: AutomationOccurrenceV1,
    status: AutomationOccurrenceStatusV1,
) -> AutomationOccurrenceV1 {
    occurrence.status = status;
    occurrence
}

fn retry_delay(policy: &AutomationRetryPolicyV1, retry_index: u8) -> u64 {
    let multiplier = 1u64
        .checked_shl(u32::from(retry_index.min(63)))
        .unwrap_or(u64::MAX);
    policy
        .initial_delay_ms
        .saturating_mul(multiplier)
        .min(policy.max_delay_ms)
}

fn state_to_value(state: &AutomationStateV1) -> Value {
    serde_json::json!({
        "active": state.active.as_ref().map(occurrence_to_value),
        "definition": definition_to_value(&state.definition),
        "format": SNAPSHOT_FORMAT,
        "history": state.history.iter().map(occurrence_to_value).collect::<Vec<_>>(),
        "lastScheduledAtMs": state.last_scheduled_at_ms,
        "pending": state.pending.as_ref().map(occurrence_to_value),
        "retryPending": state.retry_pending.as_ref().map(occurrence_to_value),
    })
}

fn definition_to_value(definition: &AutomationDefinitionV1) -> Value {
    serde_json::json!({
        "actionCapabilityId": definition.action_capability_id,
        "actionDigest": definition.action_digest,
        "actionInputJSON": definition.action_input_json,
        "actionSchemaDigest": definition.action_schema_digest,
        "actionVersion": definition.action_version,
        "automationId": definition.automation_id,
        "enabled": definition.enabled,
        "missedRunPolicy": missed_policy_name(definition.missed_run_policy),
        "overlapPolicy": overlap_policy_name(definition.overlap_policy),
        "retry": {
            "initialDelayMs": definition.retry.initial_delay_ms,
            "maxAttempts": definition.retry.max_attempts,
            "maxDelayMs": definition.retry.max_delay_ms,
        },
        "scheduleExpression": definition.schedule_expression,
        "timezone": definition.timezone,
        "version": definition.version,
    })
}

fn occurrence_to_value(occurrence: &AutomationOccurrenceV1) -> Value {
    serde_json::json!({
        "attempt": occurrence.attempt,
        "cancelRequested": occurrence.cancel_requested,
        "guardReceiptRef": occurrence.guard_receipt_ref,
        "occurrenceId": occurrence.occurrence_id,
        "retryAtMs": occurrence.retry_at_ms,
        "scheduledAtMs": occurrence.scheduled_at_ms,
        "status": occurrence_status_name(occurrence.status),
    })
}

fn value_to_state(value: Value) -> Result<AutomationStateV1, AutomationErrorV1> {
    let object = object(&value, 7)?;
    let format = string(object, "format")?;
    if format != SNAPSHOT_FORMAT && format != LEGACY_SNAPSHOT_FORMAT {
        return Err(AutomationErrorV1::InvalidSnapshot);
    }
    let definition = value_to_definition(
        object
            .get("definition")
            .ok_or(AutomationErrorV1::InvalidSnapshot)?,
        format == LEGACY_SNAPSHOT_FORMAT,
    )?;
    let history_values = object
        .get("history")
        .and_then(Value::as_array)
        .ok_or(AutomationErrorV1::InvalidSnapshot)?;
    if history_values.len() > MAX_HISTORY {
        return Err(AutomationErrorV1::InvalidSnapshot);
    }
    let history = history_values
        .iter()
        .map(value_to_occurrence)
        .collect::<Result<VecDeque<_>, _>>()?;
    let state = AutomationStateV1 {
        definition,
        last_scheduled_at_ms: optional_u64(object, "lastScheduledAtMs")?,
        active: optional_occurrence(object, "active")?,
        pending: optional_occurrence(object, "pending")?,
        retry_pending: optional_occurrence(object, "retryPending")?,
        history,
    };
    if state.active.as_ref().is_some_and(|occurrence| {
        !matches!(
            occurrence.status,
            AutomationOccurrenceStatusV1::Running
                | AutomationOccurrenceStatusV1::CancelRequested
                | AutomationOccurrenceStatusV1::Unknown
        )
    }) || state.pending.as_ref().is_some_and(|occurrence| {
        !matches!(
            occurrence.status,
            AutomationOccurrenceStatusV1::PendingGuard
        )
    }) || state.retry_pending.as_ref().is_some_and(|occurrence| {
        occurrence.status != AutomationOccurrenceStatusV1::RetryWait
            || occurrence.retry_at_ms.is_none()
    }) {
        return Err(AutomationErrorV1::InvalidSnapshot);
    }
    Ok(state)
}

fn value_to_definition(value: &Value, legacy: bool) -> Result<AutomationDefinitionV1, AutomationErrorV1> {
    let object = object(value, if legacy { 11 } else { 13 })?;
    let retry = object
        .get("retry")
        .and_then(Value::as_object)
        .filter(|retry| retry.len() == 3)
        .ok_or(AutomationErrorV1::InvalidSnapshot)?;
    let max_attempts = u8::try_from(number(retry, "maxAttempts")?)
        .map_err(|_| AutomationErrorV1::InvalidSnapshot)?;
    let definition = AutomationDefinitionV1 {
        automation_id: string(object, "automationId")?.to_owned(),
        version: number(object, "version")?,
        action_capability_id: string(object, "actionCapabilityId")?.to_owned(),
        action_version: number(object, "actionVersion")?,
        action_digest: string(object, "actionDigest")?.to_owned(),
        action_schema_digest: if legacy { None } else { optional_string(object, "actionSchemaDigest")? },
        action_input_json: if legacy { None } else { optional_string(object, "actionInputJSON")? },
        schedule_expression: string(object, "scheduleExpression")?.to_owned(),
        timezone: string(object, "timezone")?.to_owned(),
        enabled: boolean(object, "enabled")?,
        overlap_policy: match string(object, "overlapPolicy")? {
            "skip" => OverlapPolicyV1::Skip,
            "queue_one" => OverlapPolicyV1::QueueOne,
            _ => return Err(AutomationErrorV1::InvalidSnapshot),
        },
        missed_run_policy: match string(object, "missedRunPolicy")? {
            "skip" => MissedRunPolicyV1::Skip,
            "run_latest" => MissedRunPolicyV1::RunLatest,
            "queue_one" => MissedRunPolicyV1::QueueOne,
            _ => return Err(AutomationErrorV1::InvalidSnapshot),
        },
        retry: AutomationRetryPolicyV1 {
            max_attempts,
            initial_delay_ms: number(retry, "initialDelayMs")?,
            max_delay_ms: number(retry, "maxDelayMs")?,
        },
    };
    definition
        .validate()
        .map_err(|_| AutomationErrorV1::InvalidSnapshot)?;
    Ok(definition)
}

fn value_to_occurrence(value: &Value) -> Result<AutomationOccurrenceV1, AutomationErrorV1> {
    let object = object(value, 7)?;
    let attempt =
        u8::try_from(number(object, "attempt")?).map_err(|_| AutomationErrorV1::InvalidSnapshot)?;
    let status = match string(object, "status")? {
        "pending_guard" => AutomationOccurrenceStatusV1::PendingGuard,
        "retry_wait" => AutomationOccurrenceStatusV1::RetryWait,
        "running" => AutomationOccurrenceStatusV1::Running,
        "cancel_requested" => AutomationOccurrenceStatusV1::CancelRequested,
        "succeeded" => AutomationOccurrenceStatusV1::Succeeded,
        "failed" => AutomationOccurrenceStatusV1::Failed,
        "unknown" => AutomationOccurrenceStatusV1::Unknown,
        "cancelled" => AutomationOccurrenceStatusV1::Cancelled,
        "skipped" => AutomationOccurrenceStatusV1::Skipped,
        "needs_you" => AutomationOccurrenceStatusV1::NeedsYou,
        _ => return Err(AutomationErrorV1::InvalidSnapshot),
    };
    let guard_receipt_ref = match object.get("guardReceiptRef") {
        Some(Value::Null) => None,
        Some(Value::String(value)) if valid_text(value, MAX_ID_BYTES) => Some(value.clone()),
        _ => return Err(AutomationErrorV1::InvalidSnapshot),
    };
    Ok(AutomationOccurrenceV1 {
        occurrence_id: string(object, "occurrenceId")?.to_owned(),
        scheduled_at_ms: number(object, "scheduledAtMs")?,
        attempt,
        status,
        retry_at_ms: optional_u64(object, "retryAtMs")?,
        cancel_requested: boolean(object, "cancelRequested")?,
        guard_receipt_ref,
    })
}

fn object(value: &Value, fields: usize) -> Result<&Map<String, Value>, AutomationErrorV1> {
    value
        .as_object()
        .filter(|object| object.len() == fields)
        .ok_or(AutomationErrorV1::InvalidSnapshot)
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, AutomationErrorV1> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(AutomationErrorV1::InvalidSnapshot)
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, AutomationErrorV1> {
    match object.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(AutomationErrorV1::InvalidSnapshot),
    }
}

fn number(object: &Map<String, Value>, key: &str) -> Result<u64, AutomationErrorV1> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or(AutomationErrorV1::InvalidSnapshot)
}

fn boolean(object: &Map<String, Value>, key: &str) -> Result<bool, AutomationErrorV1> {
    object
        .get(key)
        .and_then(Value::as_bool)
        .ok_or(AutomationErrorV1::InvalidSnapshot)
}

fn optional_u64(object: &Map<String, Value>, key: &str) -> Result<Option<u64>, AutomationErrorV1> {
    match object.get(key) {
        Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or(AutomationErrorV1::InvalidSnapshot),
        None => Err(AutomationErrorV1::InvalidSnapshot),
    }
}

fn optional_occurrence(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<AutomationOccurrenceV1>, AutomationErrorV1> {
    match object.get(key) {
        Some(Value::Null) => Ok(None),
        Some(value) => value_to_occurrence(value).map(Some),
        None => Err(AutomationErrorV1::InvalidSnapshot),
    }
}

fn overlap_policy_name(policy: OverlapPolicyV1) -> &'static str {
    match policy {
        OverlapPolicyV1::Skip => "skip",
        OverlapPolicyV1::QueueOne => "queue_one",
    }
}

fn missed_policy_name(policy: MissedRunPolicyV1) -> &'static str {
    match policy {
        MissedRunPolicyV1::Skip => "skip",
        MissedRunPolicyV1::RunLatest => "run_latest",
        MissedRunPolicyV1::QueueOne => "queue_one",
    }
}

fn occurrence_status_name(status: AutomationOccurrenceStatusV1) -> &'static str {
    match status {
        AutomationOccurrenceStatusV1::PendingGuard => "pending_guard",
        AutomationOccurrenceStatusV1::RetryWait => "retry_wait",
        AutomationOccurrenceStatusV1::Running => "running",
        AutomationOccurrenceStatusV1::CancelRequested => "cancel_requested",
        AutomationOccurrenceStatusV1::Succeeded => "succeeded",
        AutomationOccurrenceStatusV1::Failed => "failed",
        AutomationOccurrenceStatusV1::Unknown => "unknown",
        AutomationOccurrenceStatusV1::Cancelled => "cancelled",
        AutomationOccurrenceStatusV1::Skipped => "skipped",
        AutomationOccurrenceStatusV1::NeedsYou => "needs_you",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition() -> AutomationDefinitionV1 {
        AutomationDefinitionV1 {
            automation_id: "automation-1".to_owned(),
            version: 1,
            action_capability_id: "test.run_related".to_owned(),
            action_version: 1,
            action_digest: "sha256:action".to_owned(),
            action_schema_digest: Some(format!("blake3:{}", "0".repeat(64))),
            action_input_json: Some("{}".to_owned()),
            schedule_expression: "0 * * * *".to_owned(),
            timezone: "America/Los_Angeles".to_owned(),
            enabled: true,
            overlap_policy: OverlapPolicyV1::QueueOne,
            missed_run_policy: MissedRunPolicyV1::RunLatest,
            retry: AutomationRetryPolicyV1 {
                max_attempts: 3,
                initial_delay_ms: 10,
                max_delay_ms: 100,
            },
        }
    }

    fn due(id: &str, at: u64) -> DueOccurrenceV1 {
        DueOccurrenceV1 {
            occurrence_id: id.to_owned(),
            scheduled_at_ms: at,
        }
    }

    fn active(id: &str, at: u64) -> AutomationOccurrenceV1 {
        AutomationOccurrenceV1 {
            occurrence_id: id.to_owned(),
            scheduled_at_ms: at,
            attempt: 1,
            status: AutomationOccurrenceStatusV1::Running,
            retry_at_ms: None,
            cancel_requested: false,
            guard_receipt_ref: Some("receipt:guarded".to_owned()),
        }
    }

    #[test]
    fn missed_run_latest_keeps_only_the_newest_timezone_resolved_due_occurrence() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        let decisions = state
            .record_due_occurrences(100, &[due("occ-1", 10), due("occ-2", 20), due("occ-3", 30)])
            .unwrap();

        assert_eq!(
            decisions
                .iter()
                .map(|item| item.decision)
                .collect::<Vec<_>>(),
            [
                DueDecisionKindV1::SkippedMissed,
                DueDecisionKindV1::SkippedMissed,
                DueDecisionKindV1::ReadyForGuard,
            ]
        );
        assert_eq!(state.pending().unwrap().occurrence_id, "occ-3");
        assert_eq!(state.history().len(), 2);
    }

    #[test]
    fn overlap_queue_one_keeps_only_one_pending_occurrence() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state.active = Some(active("active", 1));
        state
            .record_due_occurrences(100, &[due("occ-1", 100)])
            .unwrap();
        let decisions = state
            .record_due_occurrences(101, &[due("occ-2", 101)])
            .unwrap();

        assert_eq!(
            decisions,
            [
                decision(&due("occ-1", 100), DueDecisionKindV1::SkippedReplaced),
                decision(&due("occ-2", 101), DueDecisionKindV1::QueuedOne),
            ]
        );
        assert_eq!(state.pending().unwrap().occurrence_id, "occ-2");
        assert_eq!(state.history().len(), 1);
        assert_eq!(
            state.history()[0].status,
            AutomationOccurrenceStatusV1::Skipped
        );
    }

    #[test]
    fn queue_replacement_reports_the_replaced_occurrence_id() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state.active = Some(active("active", 1));
        state
            .record_due_occurrences(100, &[due("queued-1", 100)])
            .unwrap();

        let decisions = state
            .record_due_occurrences(101, &[due("queued-2", 101)])
            .unwrap();

        assert_eq!(
            decisions,
            [
                decision(&due("queued-1", 100), DueDecisionKindV1::SkippedReplaced),
                decision(&due("queued-2", 101), DueDecisionKindV1::QueuedOne),
            ]
        );
        assert_eq!(state.pending().unwrap().occurrence_id, "queued-2");
        assert_eq!(state.history().back().unwrap().occurrence_id, "queued-1");
    }

    #[test]
    fn guarded_start_does_not_start_a_retry_before_its_due_time() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state.active = Some(active("retry", 1));
        assert_eq!(
            state.settle_active("retry", AutomationOutcomeV1::RetryableFailure, 100),
            Ok(SettlementDecisionV1::RetryScheduled { retry_at_ms: 110 })
        );
        state
            .record_due_occurrences(101, &[due("queued", 101)])
            .unwrap();

        assert_eq!(
            state.candidate_for_guard(105).unwrap().occurrence_id,
            "queued"
        );
        state
            .record_guarded_start("queued", 105, "receipt:queued")
            .unwrap();

        assert_eq!(state.active().unwrap().occurrence_id, "queued");
        assert_eq!(state.retry_pending().unwrap().occurrence_id, "retry");
        assert!(state.pending().is_none());
    }

    #[test]
    fn retry_backoff_is_bounded_and_unknown_never_retries_without_reconciliation() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state.active = Some(active("occ-1", 1));
        assert_eq!(
            state.settle_active("occ-1", AutomationOutcomeV1::RetryableFailure, 100),
            Ok(SettlementDecisionV1::RetryScheduled { retry_at_ms: 110 })
        );
        assert!(state.candidate_for_guard(109).is_none());
        assert_eq!(state.candidate_for_guard(110).unwrap().attempt, 2);

        state.retry_pending = None;
        state.active = Some(active("occ-2", 2));
        assert_eq!(
            state.settle_active("occ-2", AutomationOutcomeV1::Unknown, 200),
            Ok(SettlementDecisionV1::NeedsReconciliation)
        );
        assert_eq!(
            state.active().unwrap().status,
            AutomationOccurrenceStatusV1::Unknown
        );
        assert_eq!(
            state.settle_active("occ-2", AutomationOutcomeV1::RetryableFailure, 300),
            Err(AutomationErrorV1::InvalidTransition)
        );
        state
            .reconcile_unknown("occ-2", ReconciledOutcomeV1::Failed)
            .unwrap();
        assert!(state.retry_pending().is_none());
    }

    #[test]
    fn disabling_cancels_pending_and_requests_active_cancel_without_claiming_rollback() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state.active = Some(active("active", 1));
        state.pending = Some(occurrence_from_due(
            &due("pending", 2),
            AutomationOccurrenceStatusV1::PendingGuard,
        ));

        assert_eq!(
            state.disable(),
            DisableResultV1 {
                cancelled_pending: true,
                cancel_requested_for_active: true,
            }
        );
        assert_eq!(
            state.active().unwrap().status,
            AutomationOccurrenceStatusV1::CancelRequested
        );
        assert!(state.pending().is_none());
        assert_eq!(
            state
                .record_due_occurrences(3, &[due("future", 3)])
                .unwrap()[0]
                .decision,
            DueDecisionKindV1::IgnoredDisabled
        );
    }

    #[test]
    fn disabling_unknown_occurrence_preserves_reconciliation_state() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state
            .record_due_occurrences(10, &[due("occ-1", 10)])
            .unwrap();
        state
            .record_guarded_start("occ-1", 10, "receipt:guarded")
            .unwrap();
        assert_eq!(
            state.settle_active("occ-1", AutomationOutcomeV1::Unknown, 11),
            Ok(SettlementDecisionV1::NeedsReconciliation)
        );

        let disabled = state.disable();

        assert_eq!(
            disabled,
            DisableResultV1 {
                cancelled_pending: false,
                cancel_requested_for_active: true,
            }
        );
        assert_eq!(
            state.active().unwrap().status,
            AutomationOccurrenceStatusV1::Unknown
        );
        assert_eq!(
            state.reconcile_unknown("occ-1", ReconciledOutcomeV1::Failed),
            Ok(())
        );
        assert!(state.active().is_none());
        assert!(state.retry_pending().is_none());
        assert!(state.candidate_for_guard(20).is_none());
    }

    #[test]
    fn snapshot_roundtrip_preserves_occurrences_and_rejects_noncanonical_data() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state
            .record_due_occurrences(20, &[due("occ-1", 20)])
            .unwrap();
        let encoded = state.encode_snapshot().unwrap();
        assert_eq!(AutomationStateV1::decode_snapshot(&encoded), Ok(state));

        let mut noncanonical = encoded.clone();
        noncanonical.push(b' ');
        assert_eq!(
            AutomationStateV1::decode_snapshot(&noncanonical),
            Err(AutomationErrorV1::InvalidSnapshot)
        );
    }

    #[test]
    fn invocation_is_explicitly_disabled_even_when_a_guard_candidate_exists() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state
            .record_due_occurrences(10, &[due("occ-1", 10)])
            .unwrap();

        assert!(state.candidate_for_guard(10).is_some());
        assert!(!AUTOMATION_INVOCATION_ENABLED);
        assert_eq!(
            state.record_guarded_start("occ-1", 10, ""),
            Err(AutomationErrorV1::GuardReceiptRequired)
        );
    }

    // ---- OwnerLog-backed journal ----

    fn journal_root(label: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let base = std::env::var_os("HORIZON_OWNER_LOG_TEST_TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = base.join(format!(
            "horizon-automation-{label}-{}-{tick}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    fn registry_scope(label: &str) -> String {
        format!("blake3:{}", Digest::from_blake3(label.as_bytes()).to_hex())
    }

    #[test]
    fn registry_recovery_does_not_consume_caller_idempotency_keys() {
        let root = journal_root("registry-recovery-idempotency");
        let scope = registry_scope("scope");
        let request_digest = registry_scope("request");
        let mut registry = AutomationRegistryV1::open(&root, &scope).unwrap();

        // Model an internal recovery commit. It must not claim a key from the
        // caller mutation space even when no occurrence state changes.
        registry.commit_snapshot("recovered_unknown", 1).unwrap();
        let receipt = registry
            .create(definition(), "recovery-1", &request_digest, 2)
            .expect("caller key remains available after internal recovery");
        assert_eq!(receipt.idempotency_key, "recovery-1");
        assert_eq!(registry.get("automation-1").unwrap().definition().version, 1);

        drop(registry);
        let reopened = AutomationRegistryV1::open(&root, &scope).unwrap();
        assert_eq!(reopened.get("automation-1").unwrap().definition().version, 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn registry_replays_idempotent_mutations_and_enforces_version_cas() {
        let root = journal_root("registry-idempotency-cas");
        let scope = registry_scope("scope");
        let request_digest = registry_scope("create-request");
        let mut registry = AutomationRegistryV1::open(&root, &scope).unwrap();
        let first = registry
            .create(definition(), "create-1", &request_digest, 10)
            .unwrap();
        let replay = registry
            .create(definition(), "create-1", &request_digest, 11)
            .unwrap();
        assert_eq!(replay, first);
        assert_eq!(registry.commits(), 1);
        assert!(matches!(
            registry.set_enabled("automation-1", 9, false, "stale-1", &registry_scope("stale"), 12),
            Err(AutomationRegistryErrorV1::VersionConflict { expected: 9, actual: 1 })
        ));

        let mut next = definition();
        next.version = 2;
        let updated = registry
            .update(next, 1, "update-1", &registry_scope("update"), 13)
            .unwrap();
        assert_eq!(updated.definition_version, 2);
        registry
            .record_due_occurrences(
                "automation-1",
                14,
                &[due("occ-1", 14)],
                "due-1",
                &registry_scope("due"),
            )
            .unwrap();
        let context = guard_context(&root);
        let raw_arguments = registry_scope("args");
        let before_invocation = registry.commits();
        assert!(matches!(
            registry.authorize_invocation("automation-1", "occ-1", 14, &context, &raw_arguments),
            Err(AutomationRegistryErrorV1::Automation(AutomationErrorV1::InvocationUnavailable))
        ));
        assert_eq!(registry.commits(), before_invocation);
        let bound_digest = registry
            .guard_request_digest("automation-1", "occ-1", 14, &raw_arguments)
            .unwrap();
        let request = registry
            .guard_request(
                "automation-1",
                "occ-1",
                14,
                &context,
                &raw_arguments,
                &bound_digest,
            )
            .unwrap();
        assert_eq!(request.action_id, "test.run_related");
        assert_ne!(request.argument_digest, raw_arguments);
        assert!(matches!(
            registry.guard_request(
                "automation-1",
                "occ-1",
                14,
                &context,
                &raw_arguments,
                &registry_scope("wrong-bound-digest"),
            ),
            Err(AutomationRegistryErrorV1::InvalidIdempotency)
        ));
        drop(registry);

        let reopened = AutomationRegistryV1::open(&root, &scope).unwrap();
        assert_eq!(reopened.commits(), 3);
        assert_eq!(reopened.get("automation-1").unwrap().definition().version, 2);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn guarded_registry_receipt_binds_exact_proof_and_survives_reopen() {
        let root = journal_root("registry-guarded-proof");
        let scope = registry_scope("scope");
        let input_digest = registry_scope("approved-input");
        let binding = GuardedAutomationMutationBindingV1 {
            challenge_digest: registry_scope("challenge"),
            effect_intent_digest: registry_scope("intent"),
            lease_digest: registry_scope("lease"),
        };
        let mut registry = AutomationRegistryV1::open(&root, &scope).unwrap();
        let first = registry.create_guarded(
            definition(), "guarded-create-1", &input_digest, 10, binding.clone(),
        ).unwrap();
        let execution_digest = first.execution_receipt_digest().unwrap().to_owned();
        assert!(valid_digest(&execution_digest));
        assert_eq!(first.guarded_proof.as_ref().unwrap().challenge_digest, binding.challenge_digest);
        assert_eq!(registry.create_guarded(
            definition(), "guarded-create-1", &input_digest, 11, binding.clone(),
        ), Ok(first.clone()));
        assert_eq!(registry.create_guarded(
            definition(), "guarded-create-1", &input_digest, 12,
            GuardedAutomationMutationBindingV1 { lease_digest: registry_scope("different-lease"), ..binding.clone() },
        ), Err(AutomationRegistryErrorV1::IdempotencyConflict));
        drop(registry);

        let reopened = AutomationRegistryV1::open(&root, &scope).unwrap();
        let replay = reopened.receipts.iter().find(|receipt| receipt.idempotency_key == "guarded-create-1").unwrap();
        assert_eq!(replay.execution_receipt_digest(), Some(execution_digest.as_str()));
        assert_eq!(replay.guarded_proof, first.guarded_proof);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn registry_recovery_persists_unknown_and_requires_owner_reconciliation() {
        let root = journal_root("registry-unknown-recovery");
        let scope = registry_scope("scope");
        let mut registry = AutomationRegistryV1::open(&root, &scope).unwrap();
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state.active = Some(active("in-flight", 10));
        registry.states.insert("automation-1".to_owned(), state);
        registry.commit_registry("test_in_flight", registry.states.clone(), registry.receipts.clone(), 10).unwrap();
        drop(registry);

        let mut recovered = AutomationRegistryV1::open(&root, &scope).unwrap();
        let active = recovered.get("automation-1").unwrap().active().unwrap();
        assert_eq!(active.status, AutomationOccurrenceStatusV1::Unknown);
        assert_eq!(active.guard_receipt_ref.as_deref(), Some("receipt:guarded"));
        assert_eq!(recovered.commits(), 2);
        recovered
            .reconcile_unknown(
                "automation-1",
                "in-flight",
                ReconciledOutcomeV1::Succeeded,
                11,
                "reconcile-1",
                &registry_scope("reconcile"),
            )
            .unwrap();
        assert!(recovered.get("automation-1").unwrap().active().is_none());
        assert_eq!(
            recovered.get("automation-1").unwrap().history().back().unwrap().status,
            AutomationOccurrenceStatusV1::Succeeded
        );
        drop(recovered);

        let reopened = AutomationRegistryV1::open(&root, &scope).unwrap();
        assert_eq!(
            reopened.get("automation-1").unwrap().history().back().unwrap().status,
            AutomationOccurrenceStatusV1::Succeeded
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn guard_context<'a>(root: &'a std::path::Path) -> AutomationGuardContextV1<'a> {
        AutomationGuardContextV1 {
            principal: "ses_automation",
            request_id: "batch_automation",
            session_id: "ses_automation",
            batch_id: "batch_automation",
            call_id: "call_automation",
            turn_context_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            workspace_root: root,
            workspace_binding: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            target: root,
            resource: ".",
        }
    }

    #[test]
    fn journal_commits_due_state_through_owner_log_and_replays_after_reload() {
        let root = journal_root("reload");
        let mut journal = AutomationJournalV1::open(&root, definition()).unwrap();
        assert_eq!(journal.commits(), 0);

        let decisions = journal
            .record_due_occurrences(100, &[due("occ-1", 10), due("occ-2", 100)])
            .unwrap();
        assert_eq!(
            decisions
                .iter()
                .map(|item| item.decision)
                .collect::<Vec<_>>(),
            [
                DueDecisionKindV1::ReadyForGuard,
                DueDecisionKindV1::SkippedReplaced,
                DueDecisionKindV1::QueuedOne
            ]
        );
        assert_eq!(journal.state().pending().unwrap().occurrence_id, "occ-2");
        assert_eq!(journal.commits(), 1);
        drop(journal);

        let reloaded = AutomationJournalV1::open(&root, definition()).unwrap();
        assert_eq!(reloaded.commits(), 1);
        assert_eq!(reloaded.state().pending().unwrap().occurrence_id, "occ-2");
        assert_eq!(
            reloaded.state().pending().unwrap().status,
            AutomationOccurrenceStatusV1::PendingGuard
        );
        assert_eq!(reloaded.state().history().len(), 1);
        assert_eq!(reloaded.state().definition().enabled, true);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn journal_replays_active_retry_and_unknown_state_across_reload() {
        let root = journal_root("retry");
        let mut journal = AutomationJournalV1::open(&root, definition()).unwrap();
        journal
            .record_due_occurrences(100, &[due("occ-1", 100)])
            .unwrap();
        journal
            .record_test_guarded_start("occ-1", 100, "receipt:guarded-1")
            .unwrap();
        assert_eq!(
            journal.state().active().unwrap().status,
            AutomationOccurrenceStatusV1::Running
        );

        let settlement = journal
            .settle_active("occ-1", AutomationOutcomeV1::RetryableFailure, 100)
            .unwrap();
        assert!(matches!(
            settlement,
            SettlementDecisionV1::RetryScheduled { .. }
        ));
        drop(journal);

        let mut reloaded = AutomationJournalV1::open(&root, definition()).unwrap();
        let retry = reloaded.state().retry_pending().unwrap();
        assert_eq!(retry.occurrence_id, "occ-1");
        assert_eq!(retry.attempt, 1);
        assert_eq!(retry.status, AutomationOccurrenceStatusV1::RetryWait);
        assert_eq!(retry.guard_receipt_ref, None);
        assert_eq!(reloaded.commits(), 3);

        // Unknown stays blocking after reload until an owner-side reconciliation.
        reloaded
            .record_test_guarded_start("occ-1", 200, "receipt:guarded-2")
            .unwrap();
        assert_eq!(
            reloaded
                .settle_active("occ-1", AutomationOutcomeV1::Unknown, 200)
                .unwrap(),
            SettlementDecisionV1::NeedsReconciliation
        );
        drop(reloaded);
        let mut reconciled = AutomationJournalV1::open(&root, definition()).unwrap();
        assert_eq!(
            reconciled.state().active().unwrap().status,
            AutomationOccurrenceStatusV1::Unknown
        );
        reconciled
            .reconcile_unknown("occ-1", ReconciledOutcomeV1::Succeeded, 300)
            .unwrap();
        drop(reconciled);
        let final_state = AutomationJournalV1::open(&root, definition()).unwrap();
        assert!(final_state.state().active().is_none());
        assert_eq!(
            final_state.state().history().back().unwrap().status,
            AutomationOccurrenceStatusV1::Succeeded
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn journal_reopen_fences_running_and_cancel_requested_as_durable_unknown() {
        let running_root = journal_root("running-recovery");
        let mut running = AutomationJournalV1::open(&running_root, definition()).unwrap();
        running
            .record_due_occurrences(700, &[due("running-occ", 700)])
            .unwrap();
        running
            .record_test_guarded_start("running-occ", 701, "receipt:running")
            .unwrap();
        drop(running);

        let recovered_running = AutomationJournalV1::open(&running_root, definition()).unwrap();
        let active = recovered_running.state().active().unwrap();
        assert_eq!(active.status, AutomationOccurrenceStatusV1::Unknown);
        assert!(!active.cancel_requested);
        assert_eq!(active.guard_receipt_ref.as_deref(), Some("receipt:running"));
        assert_eq!(recovered_running.commits(), 3);
        assert_eq!(recovered_running.last_time_ms, 701);
        drop(recovered_running);
        std::fs::remove_dir_all(&running_root).unwrap();

        let cancelled_root = journal_root("cancel-recovery");
        let mut cancelled = AutomationJournalV1::open(&cancelled_root, definition()).unwrap();
        cancelled
            .record_due_occurrences(800, &[due("cancel-occ", 800)])
            .unwrap();
        cancelled
            .record_test_guarded_start("cancel-occ", 801, "receipt:cancel")
            .unwrap();
        cancelled.disable(900).unwrap();
        drop(cancelled);

        let recovered_cancel = AutomationJournalV1::open(&cancelled_root, definition()).unwrap();
        let active = recovered_cancel.state().active().unwrap();
        assert_eq!(active.status, AutomationOccurrenceStatusV1::Unknown);
        assert!(active.cancel_requested);
        assert_eq!(active.guard_receipt_ref.as_deref(), Some("receipt:cancel"));
        assert_eq!(recovered_cancel.commits(), 4);
        assert_eq!(recovered_cancel.last_time_ms, 900);
        drop(recovered_cancel);
        std::fs::remove_dir_all(&cancelled_root).unwrap();
    }

    #[test]
    fn journal_persists_disable_and_enable_transitions() {
        let root = journal_root("disable");
        let mut journal = AutomationJournalV1::open(&root, definition()).unwrap();
        journal
            .record_due_occurrences(100, &[due("occ-1", 100)])
            .unwrap();
        let result = journal.disable(100).unwrap();
        assert!(result.cancelled_pending);
        drop(journal);

        let mut reloaded = AutomationJournalV1::open(&root, definition()).unwrap();
        assert!(!reloaded.state().definition().enabled);
        assert!(reloaded.state().pending().is_none());
        assert_eq!(
            reloaded.state().history().back().unwrap().status,
            AutomationOccurrenceStatusV1::Cancelled
        );
        reloaded.enable(101).unwrap();
        drop(reloaded);

        let enabled = AutomationJournalV1::open(&root, definition()).unwrap();
        assert!(enabled.state().definition().enabled);
        assert_eq!(enabled.commits(), 3);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn journal_rejects_a_changed_definition_version_fail_closed() {
        let root = journal_root("conflict");
        let mut journal = AutomationJournalV1::open(&root, definition()).unwrap();
        journal
            .record_due_occurrences(100, &[due("occ-1", 100)])
            .unwrap();
        drop(journal);

        let mut changed = definition();
        changed.version = 2;
        assert!(matches!(
            AutomationJournalV1::open(&root, changed),
            Err(AutomationErrorV1::DefinitionConflict)
        ));

        let mut changed_action = definition();
        changed_action.action_digest = "sha256:other".to_owned();
        assert!(matches!(
            AutomationJournalV1::open(&root, changed_action),
            Err(AutomationErrorV1::DefinitionConflict)
        ));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn guarded_invocation_stays_unavailable_and_never_changes_state() {
        let root = journal_root("invocation");
        let mut journal = AutomationJournalV1::open(&root, definition()).unwrap();
        journal
            .record_due_occurrences(100, &[due("occ-1", 100)])
            .unwrap();
        let commits = journal.commits();
        let context = guard_context(&root);

        assert_eq!(
            journal.authorize_invocation(
                &context,
                "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ),
            Err(AutomationErrorV1::InvocationUnavailable)
        );
        let decision = GuardDecisionV1 {
            decision_id: "batch_automation".to_owned(),
            decision: DecisionKind::Ask,
            policy_digest: "blake3:policy".to_owned(),
            resource_digest: "blake3:resource".to_owned(),
            normalized_action: "test.run_related".to_owned(),
            reason_code: None,
        };
        assert_eq!(
            journal.record_guarded_invocation("occ-1", 100, "receipt:forged", &decision),
            Err(AutomationErrorV1::InvocationUnavailable)
        );
        assert!(journal.state().active().is_none());
        assert_eq!(journal.state().pending().unwrap().occurrence_id, "occ-1");
        assert_eq!(journal.commits(), commits);

        // The canonical Guard request carries the automation action and is denied
        // by the current canonical policy, so the caller cannot bypass Guard.
        let request = journal.guard_request(
            &context,
            "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert_eq!(request.action_id, "test.run_related");
        let canonical = guard::authorize(&request, "batch_automation");
        assert_eq!(canonical.decision, DecisionKind::Deny);
        assert_eq!(canonical.reason_code, Some("unsupported_action"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reoffered_due_occurrences_are_deduplicated_not_rescheduled() {
        let mut state = AutomationStateV1::new(definition()).unwrap();
        state
            .record_due_occurrences(100, &[due("occ-1", 50)])
            .unwrap();
        let duplicate = state
            .record_due_occurrences(101, &[due("occ-1", 50)])
            .unwrap();
        assert_eq!(
            duplicate,
            [decision(&due("occ-1", 50), DueDecisionKindV1::Duplicate)]
        );
        assert_eq!(state.pending().unwrap().occurrence_id, "occ-1");
        assert_eq!(state.history().len(), 0);
        // A newer occurrence still schedules normally after dedup.
        let next = state
            .record_due_occurrences(102, &[due("occ-2", 102)])
            .unwrap();
        assert_eq!(
            next,
            [
                decision(&due("occ-1", 50), DueDecisionKindV1::SkippedReplaced),
                decision(&due("occ-2", 102), DueDecisionKindV1::QueuedOne)
            ]
        );
    }

    #[test]
    fn journal_keeps_missed_run_policy_and_dedup_after_a_reopen() {
        let root = journal_root("missed-policy");
        let mut journal = AutomationJournalV1::open(&root, definition()).unwrap();
        journal
            .record_due_occurrences(1_000, &[due("occ-1", 100), due("occ-2", 900)])
            .unwrap();
        assert_eq!(
            journal.state().definition().missed_run_policy,
            MissedRunPolicyV1::RunLatest
        );
        drop(journal);

        let mut reopened = AutomationJournalV1::open(&root, definition()).unwrap();
        // The replayed last-scheduled watermark deduplicates the whole prefix.
        let replayed = reopened
            .record_due_occurrences(1_001, &[due("occ-1", 100), due("occ-2", 900)])
            .unwrap();
        assert_eq!(
            replayed
                .iter()
                .map(|item| item.decision)
                .collect::<Vec<_>>(),
            [DueDecisionKindV1::Duplicate, DueDecisionKindV1::Duplicate]
        );
        // A newer missed occurrence still follows the declared RunLatest policy.
        let next = reopened
            .record_due_occurrences(1_100, &[due("occ-3", 1_050)])
            .unwrap();
        assert_eq!(
            next,
            [
                decision(&due("occ-2", 900), DueDecisionKindV1::SkippedReplaced),
                decision(&due("occ-3", 1_050), DueDecisionKindV1::QueuedOne)
            ]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
