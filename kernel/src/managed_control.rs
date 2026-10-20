//! Durable, non-executing managed-work admission fence.
//!
//! This module owns the durable managed state projection, not execution
//! permission. OwnerLogV2 records immutable SpecVersion decisions, Run/Task and
//! Attempt transitions, receipt/evidence pins, and exact verifier assignment.
//! A state transition here never dispatches an effect: HostKernel must validate
//! authenticated scope, live owner-epoch leases, Guard intents and target receipts
//! at the single ExecutionHost boundary. The independent-verifier reducer keeps
//! one coding Attempt live through verifier receipts and typed evidence. The
//! accepted-by/proposed-by identity fields are owner-log facts from trusted
//! ingress; they are not themselves authentication proofs, and the state machine
//! still prevents a SpecVersion author from approving their own proposal.
//!
//! Direct (Goal-less) subagent dispatch is fenced by `DirectAttemptControl`
//! below: one durable owner log per direct Attempt id, admitted once with the
//! Core-computed dispatch scope digest, settled or cancelled once, and recovered
//! as UNKNOWN — never resumed — across a host epoch boundary.

use crate::artifact_store::{
    ArtifactAccessV1, ArtifactError, ArtifactMetadataV1, ArtifactOwnerScopeV1,
};
pub(crate) use crate::agent_profile::{ProfileOwnerBindingV1, ProfileRevisionRefV1};
use crate::host_kernel::ObservedVerifierRunV1;
use crate::messagepack::{self, FRAME_LIMITS};
use crate::owner_log::{
    DurabilityProfile, OwnerEventInput, OwnerIdentity, OwnerLogError, OwnerLogV2,
};
use crate::protocol::{
    ArtifactClassificationV1, ArtifactRefV1, CursorV1, DelegationBindingV1,
    MAX_DIRECT_ATTEMPT_EFFECTS,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::num::NonZeroUsize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::OnceLock;

const MAX_VERIFICATION_HISTORY: usize = 16;
const MAX_VERIFIER_CRITERION_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_VERIFIER_RUN_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_VERIFIER_ARTIFACT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum ManagedError {
    Storage(OwnerLogError),
    Invalid(&'static str),
    Conflict(&'static str),
    /// No durable Goal binding exists yet. Returned only by `open_existing`, which
    /// never allocates owner state for an unknown identifier.
    NotFound(&'static str),
}

impl From<OwnerLogError> for ManagedError {
    fn from(value: OwnerLogError) -> Self {
        Self::Storage(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunPhase {
    /// Durable plan exists, but has not been explicitly started by an
    /// authenticated user. Scheduler and all effect admission remain fenced.
    Planned,
    Running,
    Paused,
    Reconciling,
    Cancelling,
    /// Terminal. Reached only from CANCELLING once no admitted effect remains
    /// active or UNKNOWN; the future authenticated EffectService settles those.
    Cancelled,
    Verifying,
    Succeeded,
    NeedsYou,
    /// Terminal. Reached from VERIFYING, or from RECONCILING after a future
    /// authenticated EffectService has reconciled every UNKNOWN attempt.
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoalDraft {
    pub objective: String,
    pub project_ref: String,
    pub workspace_ref: String,
    pub created_by: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatedGoalProposal {
    pub goal_id: String,
    pub spec_id: String,
    pub spec_digest: String,
    pub created_by: String,
    pub proposed_by: String,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Goal {
    pub objective: String,
    pub project_ref: String,
    pub workspace_ref: String,
    pub created_by: String,
    pub active_spec_version_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptanceCriterion {
    pub id: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecBudget {
    pub max_tasks: u16,
    pub max_attempts_per_task: u16,
    pub max_run_duration_ms: u64,
    pub max_memory_bytes: Option<u64>,
    pub max_disk_bytes: Option<u64>,
    pub max_workers: u16,
    pub max_tokens: Option<u64>,
    pub max_cost_micros: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecVersionDraft {
    pub parent_version_id: Option<String>,
    pub objective: String,
    pub project_ref: String,
    pub workspace_ref: String,
    /// Explicit canonical capability IDs this immutable SpecVersion may authorize.
    /// Empty means the SpecVersion grants no effectful capability ceiling.
    pub capability_scope: Vec<String>,
    pub scope: Vec<String>,
    pub constraints: Vec<String>,
    pub criteria: Vec<AcceptanceCriterion>,
    pub budget: SpecBudget,
    pub source_digests: Vec<String>,
    /// Supplied by trusted ingress from its authenticated principal. The current
    /// managed-control module has no authenticated public ingress and stays private.
    pub proposed_by: String,
}

impl SpecVersionDraft {
    pub fn digest(&self) -> String {
        let canonical = spec_draft_value(self).to_string();
        format!("blake3:{}", blake3::hash(canonical.as_bytes()).to_hex())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecVersion {
    pub digest: String,
    pub content: SpecVersionDraft,
    pub accepted: bool,
    pub accepted_by: Option<String>,
    pub accepted_at_ms: Option<u64>,
    /// Authenticated reviewer assigned once to this immutable proposal. The
    /// assignment is durable and must differ from the proposer.
    pub reviewer_id: Option<String>,
    /// Aggregate revision observed by the reviewer when claiming the proposal.
    pub reviewer_assigned_revision: Option<u64>,
    /// Aggregate revision the reviewer actually observed when making the terminal
    /// decision. This is set from the owner-log revision at apply time, not supplied
    /// by a client, and is echoed on idempotent replay for compare-and-swap checks.
    pub reviewed_revision: Option<u64>,
    pub rejected_by: Option<String>,
    pub rejected_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionLink {
    pub session_id: String,
    pub source_store_id: String,
    pub source_instance_id: String,
    pub source_cursor: CursorV1,
    pub source_epoch: u64,
    pub latest_observed_message_id: Option<String>,
    pub latest_observed_part_id: Option<String>,
    pub source_digest: String,
    pub redaction_profile: String,
    pub owner_epoch: u64,
    pub protocol_version: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    /// Monotonic generation for safe pre-admission retries. It changes only
    /// after HostKernel proves P8 durably tombstoned a candidate as
    /// NotAdmittedNoDispatch.
    pub candidate_generation: u64,
    /// User-reviewed, immutable delivery text from the accepted Run plan.
    /// Legacy tasks retain `None` and are never schedulable for managed V1.
    pub title: Option<String>,
    pub purpose: Option<String>,
    pub dependencies: Vec<String>,
    pub criterion_ids: Vec<String>,
    /// Required canonical capabilities for this Task, constrained by its accepted
    /// SpecVersion. Empty means no effectful execution is admissible.
    pub required_capabilities: Vec<String>,
    /// Exact immutable Core profile revision selected for this Task. Admission
    /// must resolve this exact digest; a later profile edit cannot silently
    /// change the Task's execution authority.
    pub agent_profile_revision: Option<ProfileRevisionRefV1>,
    pub profile_owner_binding_digest: Option<String>,
    pub ready: bool,
    pub active_attempt: Option<String>,
    /// Attempt selected for the in-flight independent verifier. In V1 this is the
    /// same live Attempt as `active_attempt` and remains so until evidence settles.
    pub pending_verification_attempt: Option<String>,
    pub unknown_effect: bool,
    pub verified_revision: Option<String>,
    /// Durable evidence reference explaining which Attempt/revision was verified.
    pub verification_evidence: Option<TaskVerificationEvidence>,
    /// Acceptance criteria that an independent verifier durably failed.
    pub failed_criterion_ids: Vec<String>,
    pub attempt_count: u16,
}

/// HostKernel-only proof that P8 durably tombstoned one exact pre-admission
/// candidate as NotAdmittedNoDispatch. Request decoders cannot construct it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedCandidateAbandonProofV1 {
    goal_id: String,
    run_id: String,
    task_id: String,
    candidate_attempt_id: String,
    worker_execution_id: String,
    ticket_id: String,
    expected_managed_revision: u64,
    expected_task_generation: u64,
    expected_attempt_count: u16,
    task_revision: u64,
    pins_digest: String,
    disposition: crate::worker_durable::ManagedReservationReconciliationDispositionV1,
    terminal_state: crate::resource_budget::ReservationState,
    tombstone_owner_log_id: String,
    tombstone_owner_log_sequence: u64,
    tombstone_owner_log_event_digest: String,
    worker_pool_revision: u64,
    reconciliation_proof_digest: String,
    p8_receipt_digest: String,
    owner_epoch: u64,
    process_incarnation: String,
    delivery_id: String,
}

impl ManagedCandidateAbandonProofV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_host_kernel(
        goal_id: String, run_id: String, task_id: String, candidate_attempt_id: String,
        expected_managed_revision: u64, expected_task_generation: u64, task_revision: u64,
        expected_attempt_count: u16,
        receipt: &crate::worker_durable::PreAdmissionReconciliationReceiptV1,
        owner_epoch: u64, process_incarnation: String, delivery_id: String,
    ) -> Result<Self, ManagedError> {
        let worker_execution_id = receipt.worker_execution_id().to_owned();
        let ticket_id = receipt.ticket_id().to_owned();
        let pins_digest = receipt.pins_digest().to_owned();
        let disposition = receipt.disposition();
        let terminal_state = receipt.terminal_state();
        let tombstone_owner_log_id = receipt.owner_log_id().to_owned();
        let tombstone_owner_log_sequence = receipt.owner_log_sequence().parse::<u64>()
            .map_err(|_| ManagedError::Invalid("P8 tombstone sequence is invalid"))?;
        let tombstone_owner_log_event_digest = receipt.owner_log_event_digest().to_owned();
        let worker_pool_revision = receipt.worker_pool_revision();
        let reconciliation_proof_digest = receipt.reconciliation_proof_digest().to_owned();
        let p8_receipt_digest = receipt.receipt_digest().to_owned();
        for value in [&goal_id, &run_id, &task_id, &candidate_attempt_id, &worker_execution_id, &ticket_id,
            &tombstone_owner_log_id, &process_incarnation, &delivery_id] { id(value)?; }
        if receipt.attempt_id() != candidate_attempt_id {
            return Err(ManagedError::Conflict("P8 tombstone candidate differs from Task candidate"));
        }
        blake3_digest(&pins_digest)?;
        blake3_digest(&tombstone_owner_log_event_digest)?;
        blake3_digest(&reconciliation_proof_digest)?;
        blake3_digest(&p8_receipt_digest)?;
        if disposition != crate::worker_durable::ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch
            || terminal_state != crate::resource_budget::ReservationState::Expired {
            return Err(ManagedError::Conflict("P8 candidate receipt is not a no-dispatch tombstone"));
        }
        if expected_task_generation == u64::MAX || tombstone_owner_log_sequence == 0
            || owner_epoch == 0 || task_revision == 0 || worker_pool_revision == 0 {
            return Err(ManagedError::Invalid("candidate tombstone proof cursor or generation is invalid"));
        }
        Ok(Self { goal_id, run_id, task_id, candidate_attempt_id, worker_execution_id, ticket_id,
            expected_managed_revision, expected_task_generation, expected_attempt_count,
            task_revision, pins_digest,
            disposition, terminal_state, tombstone_owner_log_id, tombstone_owner_log_sequence,
            tombstone_owner_log_event_digest, worker_pool_revision, reconciliation_proof_digest,
            p8_receipt_digest, owner_epoch,
            process_incarnation, delivery_id })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedCandidateAbandonedReceiptV1 {
    pub(crate) goal_id: String, pub(crate) run_id: String, pub(crate) task_id: String,
    pub(crate) candidate_attempt_id: String, pub(crate) generation: u64,
    pub(crate) attempt_count: u16,
    pub(crate) worker_execution_id: String, pub(crate) ticket_id: String,
    pub(crate) pins_digest: String, pub(crate) tombstone_owner_log_id: String,
    pub(crate) disposition: crate::worker_durable::ManagedReservationReconciliationDispositionV1,
    pub(crate) terminal_state: crate::resource_budget::ReservationState,
    pub(crate) tombstone_owner_log_sequence: u64,
    pub(crate) tombstone_owner_log_event_digest: String,
    pub(crate) worker_pool_revision: u64, pub(crate) reconciliation_proof_digest: String,
    pub(crate) p8_receipt_digest: String,
    pub(crate) managed_revision: u64, pub(crate) delivery_id: String,
    pub(crate) receipt_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedOwnerWatermarkV1 {
    pub(crate) owner_log_id: String,
    pub(crate) sequence: String,
    pub(crate) event_digest: String,
    pub(crate) revision: u64,
}

/// Canonical ManagedControl settlement view for one logical child Attempt.
/// This value is derived from the locked OwnerLog projection; request decoders
/// cannot construct it. It is evidence for HostKernel/P8 cross-owner settlement,
/// not an authorization token and not proof that the Core prompt is quiescent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedAttemptEffectChainStateV1 {
    AllSettled,
    UnresolvedOrUnknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedTaskTerminalStateV1 {
    Verified,
    Failed,
    Cancelled,
    Retryable,
    PendingVerification,
    Active,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedAttemptTerminalStateV1 {
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedChildPromptStateV1 {
    Quiesced,
    Unconfirmed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedAttemptTerminalEffectV1 {
    effect_id: String,
    outcome: Option<AttemptEffectOutcomeV1>,
    observation_digest: Option<String>,
    before_workspace_revision: Option<String>,
    after_workspace_revision: Option<String>,
}

impl ManagedAttemptTerminalEffectV1 {
    pub(crate) fn effect_id(&self) -> &str { &self.effect_id }
    pub(crate) fn outcome(&self) -> Option<AttemptEffectOutcomeV1> { self.outcome }
    pub(crate) fn observation_digest(&self) -> Option<&str> { self.observation_digest.as_deref() }
    pub(crate) fn before_workspace_revision(&self) -> Option<&str> { self.before_workspace_revision.as_deref() }
    pub(crate) fn after_workspace_revision(&self) -> Option<&str> { self.after_workspace_revision.as_deref() }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedAttemptTerminalSnapshotV1 {
    goal_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    task_revision: u64,
    attempt_revision: u64,
    managed_revision: u64,
    admission_workspace_revision: Option<String>,
    observed_workspace_head: Option<String>,
    spec_id: String,
    spec_digest: String,
    run_phase: RunPhase,
    task_state: ManagedTaskTerminalStateV1,
    attempt_state: ManagedAttemptTerminalStateV1,
    child_prompt_state: ManagedChildPromptStateV1,
    child_prompt_quiescence_digest: Option<String>,
    child_prompt_quiescence_owner_log_id: Option<String>,
    child_prompt_quiescence_owner_log_sequence: Option<u64>,
    child_prompt_quiescence_owner_log_event_digest: Option<String>,
    child_prompt_quiescence: Option<ManagedDispatchQuiescedReceiptV1>,
    binding_digest: String,
    owner_log_id: String,
    owner_log_sequence: u64,
    owner_log_event_digest: String,
    attempt_state_digest: String,
    effect_chain_state: ManagedAttemptEffectChainStateV1,
    effect_chain_digest: String,
    effects: Vec<ManagedAttemptTerminalEffectV1>,
    evidence_digest: Option<String>,
    evidence_refs: Vec<ArtifactRefV1>,
}

impl ManagedAttemptTerminalSnapshotV1 {
    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn task_id(&self) -> &str { &self.task_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn task_revision(&self) -> u64 { self.task_revision }
    pub(crate) fn attempt_revision(&self) -> u64 { self.attempt_revision }
    pub(crate) fn managed_revision(&self) -> u64 { self.managed_revision }
    pub(crate) fn admission_workspace_revision(&self) -> Option<&str> { self.admission_workspace_revision.as_deref() }
    pub(crate) fn observed_workspace_head(&self) -> Option<&str> { self.observed_workspace_head.as_deref() }
    pub(crate) fn spec_id(&self) -> &str { &self.spec_id }
    pub(crate) fn spec_digest(&self) -> &str { &self.spec_digest }
    pub(crate) fn run_phase(&self) -> RunPhase { self.run_phase }
    pub(crate) fn task_state(&self) -> ManagedTaskTerminalStateV1 { self.task_state }
    pub(crate) fn attempt_state(&self) -> ManagedAttemptTerminalStateV1 { self.attempt_state }
    pub(crate) fn child_prompt_state(&self) -> ManagedChildPromptStateV1 { self.child_prompt_state }
    pub(crate) fn child_prompt_quiescence_digest(&self) -> Option<&str> { self.child_prompt_quiescence_digest.as_deref() }
    pub(crate) fn child_prompt_quiescence_owner_log_id(&self) -> Option<&str> { self.child_prompt_quiescence_owner_log_id.as_deref() }
    pub(crate) fn child_prompt_quiescence_owner_log_sequence(&self) -> Option<u64> { self.child_prompt_quiescence_owner_log_sequence }
    pub(crate) fn child_prompt_quiescence_owner_log_event_digest(&self) -> Option<&str> { self.child_prompt_quiescence_owner_log_event_digest.as_deref() }
    pub(crate) fn child_prompt_quiescence(&self) -> Option<&ManagedDispatchQuiescedReceiptV1> { self.child_prompt_quiescence.as_ref() }
    pub(crate) fn binding_digest(&self) -> &str { &self.binding_digest }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> u64 { self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn attempt_state_digest(&self) -> &str { &self.attempt_state_digest }
    pub(crate) fn effect_chain_state(&self) -> ManagedAttemptEffectChainStateV1 { self.effect_chain_state }
    pub(crate) fn effect_chain_digest(&self) -> &str { &self.effect_chain_digest }
    pub(crate) fn effects(&self) -> &[ManagedAttemptTerminalEffectV1] { &self.effects }
    pub(crate) fn evidence_digest(&self) -> Option<&str> { self.evidence_digest.as_deref() }
    pub(crate) fn evidence_refs(&self) -> &[ArtifactRefV1] { &self.evidence_refs }
}

/// Bounded pre-terminal projection used only by HostKernel's complete-dispatch
/// path. Prompt completion is recorded while the Attempt is SETTLING, before
/// verifier evidence and terminal Task settlement are committed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedDispatchCompletionSnapshotV1 {
    goal_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    parent_session_id: String,
    session_id: String,
    handoff_id: String,
    handoff_digest: String,
    consume_delivery_id: String,
    consume_receipt_digest: String,
    binding_digest: String,
    task_revision: u64,
    attempt_revision: u64,
    managed_revision: u64,
    spec_id: String,
    spec_digest: String,
    admission_workspace_revision: Option<String>,
    observed_workspace_head: Option<String>,
    owner_log_id: String,
    owner_log_sequence: u64,
    owner_log_event_digest: String,
    attempt_state_digest: String,
    effect_chain_state: ManagedAttemptEffectChainStateV1,
    effect_chain_digest: String,
    effects: Vec<ManagedAttemptTerminalEffectV1>,
    consumed_receipt: ManagedDispatchConsumedReceiptV1,
}

impl ManagedDispatchCompletionSnapshotV1 {
    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn task_id(&self) -> &str { &self.task_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn parent_session_id(&self) -> &str { &self.parent_session_id }
    pub(crate) fn session_id(&self) -> &str { &self.session_id }
    pub(crate) fn handoff_id(&self) -> &str { &self.handoff_id }
    pub(crate) fn handoff_digest(&self) -> &str { &self.handoff_digest }
    pub(crate) fn consume_delivery_id(&self) -> &str { &self.consume_delivery_id }
    pub(crate) fn consume_receipt_digest(&self) -> &str { &self.consume_receipt_digest }
    pub(crate) fn binding_digest(&self) -> &str { &self.binding_digest }
    pub(crate) fn task_revision(&self) -> u64 { self.task_revision }
    pub(crate) fn attempt_revision(&self) -> u64 { self.attempt_revision }
    pub(crate) fn managed_revision(&self) -> u64 { self.managed_revision }
    pub(crate) fn spec_id(&self) -> &str { &self.spec_id }
    pub(crate) fn spec_digest(&self) -> &str { &self.spec_digest }
    pub(crate) fn admission_workspace_revision(&self) -> Option<&str> { self.admission_workspace_revision.as_deref() }
    pub(crate) fn observed_workspace_head(&self) -> Option<&str> { self.observed_workspace_head.as_deref() }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> u64 { self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn attempt_state_digest(&self) -> &str { &self.attempt_state_digest }
    pub(crate) fn effect_chain_state(&self) -> ManagedAttemptEffectChainStateV1 { self.effect_chain_state }
    pub(crate) fn effect_chain_digest(&self) -> &str { &self.effect_chain_digest }
    pub(crate) fn effects(&self) -> &[ManagedAttemptTerminalEffectV1] { &self.effects }
    pub(crate) fn consumed_receipt(&self) -> &ManagedDispatchConsumedReceiptV1 { &self.consumed_receipt }
}

/// Immutable Task authority captured by `goal.plan` and adopted atomically by
/// `goal.start`. It intentionally contains no Attempt or effect authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlannedTaskV1 {
    pub(crate) task_id: String,
    pub(crate) title: String,
    pub(crate) purpose: String,
    pub(crate) dependencies: Vec<String>,
    pub(crate) criterion_ids: Vec<String>,
    pub(crate) required_capabilities: Vec<String>,
    pub(crate) agent_profile_revision: ProfileRevisionRefV1,
    pub(crate) profile_owner_binding_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskVerificationEvidence {
    pub attempt_id: String,
    /// Authenticated independent verifier identity that produced this evidence.
    pub verifier_id: String,
    pub source_revision: String,
    /// Kernel-computed verification binding over the settled Attempt receipt, the
    /// accepted criteria and this exact source revision. Never a caller-supplied hash.
    pub evidence_digest: String,
}

/// One durable effect bound to an Attempt. The Location/session identify where the
/// authoritative target receipt must be reconciled from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundEffect {
    pub effect_id: String,
    pub location_id: String,
    pub session_id: String,
    /// Exact aggregate OwnerLog revision that appended this Attempt/effect edge.
    /// Reconstructed from the same append during replay; never inferred from the
    /// current revision after unrelated commands have advanced the projection.
    pub bound_revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttemptEffectOutcomeV1 {
    Succeeded,
    Failed,
    Unknown,
}

/// HostKernel-only facts from the exact EffectHost target receipt. The request
/// decoder cannot construct this proof; the append path verifies it against the
/// live Attempt and its immutable bound-effect edge before making it durable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedAttemptEffectReceiptProofV1 {
    pub(crate) goal_id: String,
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) attempt_id: String,
    pub(crate) effect_id: String,
    pub(crate) executor_principal: String,
    pub(crate) owner_epoch: u64,
    pub(crate) bound_revision: u64,
    pub(crate) location_id: String,
    pub(crate) session_id: String,
    pub(crate) capability_id: String,
    pub(crate) capability_lease_digest: String,
    pub(crate) outcome: AttemptEffectOutcomeV1,
    pub(crate) target_receipt_digest: Option<String>,
    pub(crate) before_workspace_revision: String,
    pub(crate) after_workspace_revision: Option<String>,
}

/// HostKernel-only immutable verifier intent attached to one already durable
/// EffectIntent/Attempt edge before Guard issues the one-use lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedAttemptVerifierIntentV1 {
    pub(crate) goal_id: String,
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) attempt_id: String,
    pub(crate) effect_id: String,
    /// Authenticated assigned reviewer who approved the verifier challenge.
    pub(crate) reviewer_principal: String,
    /// Registered verifier child identity that will run the read-only process.
    pub(crate) verifier_principal: String,
    pub(crate) owner_epoch: u64,
    pub(crate) bound_revision: u64,
    pub(crate) location_id: String,
    pub(crate) session_id: String,
    pub(crate) capability_id: String,
    pub(crate) verifier_profile_id: String,
    pub(crate) executable_digest: String,
    pub(crate) profile_digest: String,
    pub(crate) criterion_id: String,
    pub(crate) test_identity: String,
    pub(crate) arguments_digest: String,
    pub(crate) source_workspace_revision: String,
    pub(crate) max_duration_ms: u64,
    pub(crate) max_output_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedAttemptEffectReceiptV1 {
    pub(crate) executor_principal: String,
    pub(crate) owner_epoch: u64,
    pub(crate) bound_revision: u64,
    pub(crate) location_id: String,
    pub(crate) session_id: String,
    pub(crate) capability_id: String,
    pub(crate) capability_lease_digest: String,
    pub(crate) outcome: AttemptEffectOutcomeV1,
    pub(crate) target_receipt_digest: Option<String>,
    pub(crate) before_workspace_revision: String,
    pub(crate) after_workspace_revision: Option<String>,
}

/// HostKernel-validated one-use child prompt consumption. This fences duplicate
/// Core model calls; it does not create process, scheduling, Guard, or effect
/// authority. Request decoders cannot construct this proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedDispatchConsumeProofV1 {
    goal_id: String,
    run_id: String,
    task_id: String,
    parent_session_id: String,
    session_id: String,
    attempt_id: String,
    expected_managed_revision: u64,
    handoff_id: String,
    handoff_digest: String,
    claimed_proof_digest: String,
    claimed_attempt_id: String,
    worker_execution_id: String,
    claimed_binding_digest: String,
    pins_digest: String,
    claim_owner_log_id: String,
    claim_owner_log_sequence: u64,
    claim_owner_log_event_digest: String,
    worker_pool_revision: u64,
    claim_nonce: String,
    attached_binding_digest: String,
    owner_epoch: u64,
    process_incarnation: String,
    core_pid: u32,
    core_start_identity: u64,
    core_uid: u32,
    core_gid: u32,
    core_executable_digest: String,
    delivery_id: String,
}

impl ManagedDispatchConsumeProofV1 {
    /// Only the authenticated HostKernel boundary should call this after it has
    /// validated the live P8 claim proof, owner epoch and process incarnation.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_host_kernel(
        goal_id: String, run_id: String, task_id: String, parent_session_id: String, session_id: String, attempt_id: String,
        expected_managed_revision: u64, handoff_id: String, handoff_digest: String,
        claimed_proof_digest: String,
        claimed_attempt_id: String, worker_execution_id: String,
        claimed_binding_digest: String, pins_digest: String, claim_owner_log_id: String,
        claim_owner_log_sequence: u64, claim_owner_log_event_digest: String,
        worker_pool_revision: u64, claim_nonce: String, attached_binding_digest: String,
        owner_epoch: u64, process_incarnation: String, core_pid: u32,
        core_start_identity: u64, core_uid: u32, core_gid: u32,
        core_executable_digest: String, delivery_id: String,
    ) -> Result<Self, ManagedError> {
        for value in [goal_id.as_str(), run_id.as_str(), task_id.as_str(), parent_session_id.as_str(), session_id.as_str(), attempt_id.as_str(),
            handoff_id.as_str(), claimed_attempt_id.as_str(), worker_execution_id.as_str(),
            claim_owner_log_id.as_str(), process_incarnation.as_str(), delivery_id.as_str()] {
            id(value)?;
        }
        for value in [handoff_digest.as_str(), claimed_proof_digest.as_str(), claimed_binding_digest.as_str(), pins_digest.as_str(),
            claim_owner_log_event_digest.as_str(), claim_nonce.as_str(), attached_binding_digest.as_str(),
            core_executable_digest.as_str()] {
            managed_digest(value)?;
        }
        if expected_managed_revision == 0 || owner_epoch == 0 || claim_owner_log_sequence == 0
            || worker_pool_revision == 0 || core_pid == 0 || core_start_identity == 0
        {
            return Err(ManagedError::Invalid("managed dispatch consume cursor is zero"));
        }
        Ok(Self { goal_id, run_id, task_id, parent_session_id, session_id, attempt_id, expected_managed_revision, handoff_id,
            handoff_digest, claimed_proof_digest, claimed_attempt_id, worker_execution_id, claimed_binding_digest,
            pins_digest, claim_owner_log_id, claim_owner_log_sequence,
            claim_owner_log_event_digest, worker_pool_revision, claim_nonce,
            attached_binding_digest, owner_epoch, process_incarnation, core_pid,
            core_start_identity, core_uid, core_gid, core_executable_digest, delivery_id })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ManagedDispatchConsumeRecordV1 {
    goal_id: String, run_id: String, task_id: String, parent_session_id: String, session_id: String, attempt_id: String,
    expected_managed_revision: u64, handoff_id: String, handoff_digest: String,
    claimed_proof_digest: String,
    claimed_attempt_id: String, worker_execution_id: String,
    claimed_binding_digest: String, pins_digest: String, claim_owner_log_id: String,
    claim_owner_log_sequence: u64, claim_owner_log_event_digest: String,
    worker_pool_revision: u64, claim_nonce: String, attached_binding_digest: String,
    owner_epoch: u64, process_incarnation: String, core_pid: u32,
    core_start_identity: u64, core_uid: u32, core_gid: u32,
    core_executable_digest: String, delivery_id: String,
}

impl From<ManagedDispatchConsumeProofV1> for ManagedDispatchConsumeRecordV1 {
    fn from(proof: ManagedDispatchConsumeProofV1) -> Self {
        Self { goal_id: proof.goal_id, run_id: proof.run_id, task_id: proof.task_id,
            parent_session_id: proof.parent_session_id,
            session_id: proof.session_id,
            attempt_id: proof.attempt_id, expected_managed_revision: proof.expected_managed_revision,
            handoff_id: proof.handoff_id, handoff_digest: proof.handoff_digest,
            claimed_proof_digest: proof.claimed_proof_digest,
            claimed_attempt_id: proof.claimed_attempt_id, worker_execution_id: proof.worker_execution_id,
            claimed_binding_digest: proof.claimed_binding_digest, pins_digest: proof.pins_digest,
            claim_owner_log_id: proof.claim_owner_log_id,
            claim_owner_log_sequence: proof.claim_owner_log_sequence,
            claim_owner_log_event_digest: proof.claim_owner_log_event_digest,
            worker_pool_revision: proof.worker_pool_revision, claim_nonce: proof.claim_nonce,
            attached_binding_digest: proof.attached_binding_digest, owner_epoch: proof.owner_epoch,
            process_incarnation: proof.process_incarnation, core_pid: proof.core_pid,
            core_start_identity: proof.core_start_identity, core_uid: proof.core_uid,
            core_gid: proof.core_gid, core_executable_digest: proof.core_executable_digest,
            delivery_id: proof.delivery_id }
    }
}

/// Durable reply returned after the marker is committed. The cursor and digest
/// let Core persist its exact prompt-pending state before provider invocation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedDispatchConsumedReceiptV1 {
    pub(crate) goal_id: String, pub(crate) run_id: String, pub(crate) task_id: String,
    pub(crate) parent_session_id: String,
    pub(crate) session_id: String,
    pub(crate) attempt_id: String, pub(crate) handoff_id: String,
    pub(crate) handoff_digest: String, pub(crate) claimed_proof_digest: String,
    pub(crate) worker_execution_id: String, pub(crate) pins_digest: String,
    pub(crate) binding_digest: String,
    pub(crate) claim_nonce: String, pub(crate) claim_owner_log_id: String,
    pub(crate) claim_owner_log_sequence: u64,
    pub(crate) claim_owner_log_event_digest: String,
    pub(crate) worker_pool_revision: u64, pub(crate) owner_epoch: u64,
    pub(crate) process_incarnation: String, pub(crate) delivery_id: String,
    pub(crate) core_pid: u32, pub(crate) core_start_identity: u64,
    pub(crate) core_uid: u32, pub(crate) core_gid: u32,
    pub(crate) core_executable_digest: String,
    pub(crate) consumed_managed_revision: u64, pub(crate) receipt_digest: String,
}

/// HostKernel-only confirmation that the exact consumed logical child prompt has
/// returned and its Core Session outcome has been durably projected. This marker
/// does not settle the Task or effects; it only fences prompt re-entry and lets
/// later settlement prove callback quiescence across restart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedDispatchQuiescenceProofV1 {
    goal_id: String,
    run_id: String,
    task_id: String,
    parent_session_id: String,
    session_id: String,
    attempt_id: String,
    handoff_id: String,
    handoff_digest: String,
    consume_delivery_id: String,
    consume_receipt_digest: String,
    owner_epoch: u64,
    process_incarnation: String,
    child_session_sequence: u64,
    child_session_event_digest: String,
    child_session_state_digest: String,
    delivery_id: String,
}

impl ManagedDispatchQuiescenceProofV1 {
    /// The authenticated HostKernel completion route is the only constructor.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_host_kernel(
        goal_id: String, run_id: String, task_id: String, parent_session_id: String,
        session_id: String, attempt_id: String, handoff_id: String, handoff_digest: String,
        consume_delivery_id: String, consume_receipt_digest: String, owner_epoch: u64,
        process_incarnation: String, child_session_sequence: u64,
        child_session_event_digest: String, child_session_state_digest: String,
        delivery_id: String,
    ) -> Result<Self, ManagedError> {
        for value in [&goal_id, &run_id, &task_id, &parent_session_id, &session_id,
            &attempt_id, &handoff_id, &consume_delivery_id, &process_incarnation,
            &delivery_id] { id(value)?; }
        for digest in [&handoff_digest, &consume_receipt_digest,
            &child_session_event_digest, &child_session_state_digest] { managed_digest(digest)?; }
        if owner_epoch == 0 || child_session_sequence == 0 {
            return Err(ManagedError::Invalid("dispatch quiescence cursor is invalid"));
        }
        Ok(Self { goal_id, run_id, task_id, parent_session_id, session_id, attempt_id,
            handoff_id, handoff_digest, consume_delivery_id, consume_receipt_digest,
            owner_epoch, process_incarnation, child_session_sequence,
            child_session_event_digest, child_session_state_digest, delivery_id })
    }

    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn task_id(&self) -> &str { &self.task_id }
    pub(crate) fn parent_session_id(&self) -> &str { &self.parent_session_id }
    pub(crate) fn session_id(&self) -> &str { &self.session_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn handoff_id(&self) -> &str { &self.handoff_id }
    pub(crate) fn handoff_digest(&self) -> &str { &self.handoff_digest }
    pub(crate) fn consume_delivery_id(&self) -> &str { &self.consume_delivery_id }
    pub(crate) fn consume_receipt_digest(&self) -> &str { &self.consume_receipt_digest }
    pub(crate) fn owner_epoch(&self) -> u64 { self.owner_epoch }
    pub(crate) fn process_incarnation(&self) -> &str { &self.process_incarnation }
    pub(crate) fn child_session_sequence(&self) -> u64 { self.child_session_sequence }
    pub(crate) fn child_session_event_digest(&self) -> &str { &self.child_session_event_digest }
    pub(crate) fn child_session_state_digest(&self) -> &str { &self.child_session_state_digest }
    pub(crate) fn delivery_id(&self) -> &str { &self.delivery_id }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedDispatchQuiescedReceiptV1 {
    proof: ManagedDispatchQuiescenceProofV1,
    managed_revision: u64,
    owner_log_id: String,
    owner_log_sequence: u64,
    owner_log_event_digest: String,
    receipt_digest: String,
}

impl ManagedDispatchQuiescedReceiptV1 {
    fn new(
        proof: &ManagedDispatchQuiescenceProofV1,
        managed_revision: u64,
        owner_log_id: String,
        owner_log_sequence: u64,
        owner_log_event_digest: String,
    ) -> Self {
        let canonical = json!({
            "goalID": proof.goal_id, "runID": proof.run_id, "taskID": proof.task_id,
            "parentSessionID": proof.parent_session_id, "sessionID": proof.session_id,
            "attemptID": proof.attempt_id, "handoffID": proof.handoff_id,
            "handoffDigest": proof.handoff_digest, "consumeDeliveryID": proof.consume_delivery_id,
            "consumeReceiptDigest": proof.consume_receipt_digest,
            "ownerEpoch": proof.owner_epoch.to_string(), "processIncarnation": proof.process_incarnation,
            "childSessionSequence": proof.child_session_sequence.to_string(),
            "childSessionEventDigest": proof.child_session_event_digest,
            "childSessionStateDigest": proof.child_session_state_digest,
            "deliveryID": proof.delivery_id, "managedRevision": managed_revision.to_string(),
            "ownerLogID": owner_log_id, "ownerLogSequence": owner_log_sequence.to_string(),
            "ownerLogEventDigest": owner_log_event_digest,
        });
        let receipt_digest = format!("blake3:{}", blake3::hash(canonical.to_string().as_bytes()).to_hex());
        Self { proof: proof.clone(), managed_revision, owner_log_id, owner_log_sequence,
            owner_log_event_digest, receipt_digest }
    }

    pub(crate) fn proof(&self) -> &ManagedDispatchQuiescenceProofV1 { &self.proof }
    pub(crate) fn managed_revision(&self) -> u64 { self.managed_revision }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> u64 { self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn receipt_digest(&self) -> &str { &self.receipt_digest }
}

impl ManagedDispatchConsumedReceiptV1 {
    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn task_id(&self) -> &str { &self.task_id }
    pub(crate) fn parent_session_id(&self) -> &str { &self.parent_session_id }
    pub(crate) fn session_id(&self) -> &str { &self.session_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn handoff_id(&self) -> &str { &self.handoff_id }
    pub(crate) fn handoff_digest(&self) -> &str { &self.handoff_digest }
    pub(crate) fn binding_digest(&self) -> &str { &self.binding_digest }
    pub(crate) fn owner_epoch(&self) -> u64 { self.owner_epoch }
    pub(crate) fn process_incarnation(&self) -> &str { &self.process_incarnation }
    pub(crate) fn delivery_id(&self) -> &str { &self.delivery_id }
    pub(crate) fn consumed_managed_revision(&self) -> u64 { self.consumed_managed_revision }
    pub(crate) fn receipt_digest(&self) -> &str { &self.receipt_digest }

    fn from_record(record: &ManagedDispatchConsumeRecordV1, consumed_revision: u64) -> Self {
        let canonical = json!({
            "goalId": record.goal_id, "runId": record.run_id, "taskId": record.task_id,
            "parentSessionID": record.parent_session_id,
            "sessionID": record.session_id,
            "attemptId": record.attempt_id, "handoffID": record.handoff_id,
            "handoffDigest": record.handoff_digest, "claimedProofDigest": record.claimed_proof_digest,
            "workerExecutionID": record.worker_execution_id, "pinsDigest": record.pins_digest,
            "bindingDigest": record.attached_binding_digest,
            "claimNonce": record.claim_nonce, "claimOwnerLogID": record.claim_owner_log_id,
            "claimOwnerLogSequence": record.claim_owner_log_sequence.to_string(),
            "claimOwnerLogEventDigest": record.claim_owner_log_event_digest,
            "workerPoolRevision": record.worker_pool_revision.to_string(),
            "ownerEpoch": record.owner_epoch.to_string(), "processIncarnation": record.process_incarnation,
            "corePID": record.core_pid, "coreStartIdentity": record.core_start_identity.to_string(),
            "coreUID": record.core_uid, "coreGID": record.core_gid,
            "coreExecutableDigest": record.core_executable_digest,
            "deliveryID": record.delivery_id, "consumedManagedRevision": consumed_revision.to_string(),
        });
        let receipt_digest = format!("blake3:{}", blake3::hash(canonical.to_string().as_bytes()).to_hex());
        Self { goal_id: record.goal_id.clone(), run_id: record.run_id.clone(), task_id: record.task_id.clone(),
            parent_session_id: record.parent_session_id.clone(),
            session_id: record.session_id.clone(),
            attempt_id: record.attempt_id.clone(), handoff_id: record.handoff_id.clone(),
            handoff_digest: record.handoff_digest.clone(), claimed_proof_digest: record.claimed_proof_digest.clone(),
            worker_execution_id: record.worker_execution_id.clone(), pins_digest: record.pins_digest.clone(),
            binding_digest: record.attached_binding_digest.clone(),
            claim_nonce: record.claim_nonce.clone(), claim_owner_log_id: record.claim_owner_log_id.clone(),
            claim_owner_log_sequence: record.claim_owner_log_sequence,
            claim_owner_log_event_digest: record.claim_owner_log_event_digest.clone(),
            worker_pool_revision: record.worker_pool_revision, owner_epoch: record.owner_epoch,
            process_incarnation: record.process_incarnation.clone(), delivery_id: record.delivery_id.clone(),
            core_pid: record.core_pid, core_start_identity: record.core_start_identity,
            core_uid: record.core_uid, core_gid: record.core_gid,
            core_executable_digest: record.core_executable_digest.clone(),
            consumed_managed_revision: consumed_revision, receipt_digest }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub spec_id: String,
    pub phase: RunPhase,
    /// Trusted OwnerLog `time_ms` of the explicit authenticated start. A legacy
    /// Run without this fact cannot authorize a duration-bounded worker lease.
    pub started_at_ms: Option<u64>,
    pub tasks: BTreeMap<String, Task>,
    pub session_link: Option<SessionLink>,
    pub final_revision: Option<String>,
    /// Authenticated ServerAuth verifier assigned when verification begins.
    pub verifier_id: Option<String>,
    pub criterion_evidence: BTreeMap<String, CriterionEvidence>,
    /// Complete, typed evidence submitted by a trusted independent verifier
    /// adapter. This projection is durable, but is not itself proof that artifact
    /// bytes were read; HostKernel must validate every reference through the
    /// guarded ArtifactStore before accepting this command.
    pub(crate) verification_evidence: Option<VerificationEvidenceV1>,
    /// Prior revisions' evidence is retained for audit, never used for current
    /// finalization. A new verification requires evidence bound to `final_revision`.
    pub(crate) verification_history: Vec<VerificationEvidenceHistoryV1>,
    /// Bounded failure code recorded when the Run reaches FAILED.
    pub failure_code: Option<String>,
}

/// Only an independent, trusted verifier adapter may submit this evidence.
/// No model-facing, plugin or public command path may submit these events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CriterionEvidence {
    pub source_revision: String,
    pub evidence_digest: String,
    pub verifier_id: String,
}

/// Historical verification evidence retained when a later integrated workspace
/// revision starts a fresh verification attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerificationEvidenceHistoryV1 {
    pub source_revision: Option<String>,
    pub verifier_id: Option<String>,
    pub(crate) typed_evidence: Option<VerificationEvidenceV1>,
    pub criterion_evidence: BTreeMap<String, CriterionEvidence>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerificationVerdictV1 {
    Pass,
    Fail,
}

/// Concrete evidence for one accepted criterion. The test identity and run ID
/// identify the independent test execution; ArtifactRefs are exact immutable
/// content references owned by `verification_run:{verification_run_id}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CriterionTestEvidenceV1 {
    pub(crate) criterion_id: String,
    pub(crate) verdict: VerificationVerdictV1,
    pub(crate) test_identity: String,
    pub(crate) test_run_id: String,
    pub(crate) process: CriterionVerifierProcessEvidenceV1,
    pub(crate) artifact_refs: Vec<ArtifactRefV1>,
}

/// Immutable HostKernel profile binding for an independently supervised
/// verification run. The profile applies to the full exact criterion set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifierProfileEvidenceV1 {
    pub(crate) profile_id: String,
    pub(crate) owner_epoch: u64,
    pub(crate) executable_digest: String,
    pub(crate) profile_digest: String,
}

/// Host-observed bounded output facts for the one supervised process assigned
/// to a criterion by the immutable HostKernel profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CriterionVerifierProcessEvidenceV1 {
    pub(crate) execution_id: String,
    pub(crate) generation: u64,
    pub(crate) exit_code: i32,
    pub(crate) stdout_digest: String,
    pub(crate) stderr_digest: String,
    pub(crate) output_bytes: u64,
    pub(crate) duration_ms: u64,
    pub(crate) truncated: bool,
}

/// Full immutable verifier result for one live final workspace revision.
/// `evidence_digest` is computed by the trusted HostKernel adapter over these
/// exact fields after it has validated each ArtifactRef against ArtifactStore.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerificationEvidenceV1 {
    pub(crate) verification_run_id: String,
    pub(crate) verifier_id: String,
    pub(crate) source_revision: String,
    pub(crate) profile: VerifierProfileEvidenceV1,
    pub(crate) aggregate_output_bytes: u64,
    pub(crate) aggregate_duration_ms: u64,
    pub(crate) criteria: Vec<CriterionTestEvidenceV1>,
    pub(crate) evidence_digest: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptPhase {
    Admitted,
    Executing,
    Settling,
    Succeeded,
    Unknown,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptRecord {
    pub run_id: String,
    pub task_id: String,
    /// Authenticated principal that admitted this Attempt. Verification requires an
    /// independent verifier principal distinct from this executor.
    pub executor_principal: String,
    /// Host epoch and workspace/session binding captured at admission. Legacy
    /// records decode to an unavailable zero/empty binding and cannot dispatch.
    pub owner_epoch: u64,
    pub location_id: String,
    pub session_id: String,
    /// Kernel-computed bounded workspace content digest captured at admission.
    /// Empty for historical records, which therefore cannot authorize effects.
    pub workspace_revision: Option<String>,
    /// Immutable, Rust-minted authority envelope. Missing values in historical
    /// records remain unavailable and cannot authorize an effect.
    pub delegation_binding: Option<DelegationBindingV1>,
    /// Durable effects bound to this Attempt. Settlement reconciles each bound
    /// effect's authoritative target receipt; an RPC-supplied digest is never trusted.
    pub effects: Vec<BoundEffect>,
    /// Per-edge receipts are appended as target effects settle; a missing or
    /// UNKNOWN edge permanently fences redispatch until HostKernel reconciliation.
    pub(crate) effect_receipts: BTreeMap<String, ManagedAttemptEffectReceiptV1>,
    /// Trusted verifier intents are per-effect and survive restart for exact
    /// reconciliation; they never authorize a lease by themselves.
    pub(crate) verifier_intents: BTreeMap<String, ManagedAttemptVerifierIntentV1>,
    /// Immutable observed verifier evidence captured before Attempt settlement.
    /// It is durable so restart recovery reconciles receipts rather than rerunning.
    pub(crate) verifier_evidence: Option<VerificationEvidenceV1>,
    pub phase: AttemptPhase,
    /// Kernel-computed BLAKE3 receipt over the reconciled target receipts, present
    /// only when at least one bound effect settled.
    pub receipt_digest: Option<String>,
    pub failure_code: Option<String>,
    pub retryable: Option<bool>,
}

/// Exact durable reply for the atomic managed Attempt + DelegationBinding
/// admission event. HostKernel uses this before READY/revision checks when an
/// RPC response was lost, then independently revalidates its live P8 proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedAttemptAdmissionReceiptV1 {
    pub(crate) goal_id: String,
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) attempt_id: String,
    pub(crate) executor_principal: String,
    pub(crate) owner_epoch: u64,
    pub(crate) location_id: String,
    pub(crate) session_id: String,
    pub(crate) workspace_revision: String,
    pub(crate) binding: DelegationBindingV1,
    pub(crate) binding_digest: String,
    /// Aggregate revision against which HostKernel originally performed the
    /// admission CAS. The durable binding stores the post-append revision.
    pub(crate) expected_managed_revision: u64,
    pub(crate) managed_revision: u64,
    pub(crate) delivery_id: String,
    pub(crate) receipt_digest: String,
}

impl ManagedAttemptAdmissionReceiptV1 {
    fn from_snapshot(
        goal_id: &str,
        delivery_id: &str,
        attempt_id: &str,
        snapshot: &ManagedSnapshot,
    ) -> Result<Self, ManagedError> {
        id(delivery_id)?;
        let attempt = snapshot.attempts.get(attempt_id)
            .ok_or(ManagedError::Conflict("admitted managed Attempt is unavailable"))?;
        let binding = attempt.delegation_binding.clone()
            .ok_or(ManagedError::Conflict("admitted managed Attempt binding is unavailable"))?;
        let workspace_revision = attempt.workspace_revision.clone()
            .ok_or(ManagedError::Conflict("admitted managed Attempt workspace revision is unavailable"))?;
        let binding_digest = binding.digest()
            .map_err(|_| ManagedError::Invalid("managed admission binding digest failed"))?;
        let managed_revision = binding.admitted_managed_revision;
        let expected_managed_revision = managed_revision.checked_sub(1)
            .ok_or(ManagedError::Conflict("managed admission revision is invalid"))?;
        if binding.run_id != attempt.run_id
            || binding.task_id != attempt.task_id
            || binding.attempt_id != attempt_id
            || binding.owner_epoch != attempt.owner_epoch
            || binding.source_revision != workspace_revision
            || managed_revision == 0
            || managed_revision > snapshot.revision
        {
            return Err(ManagedError::Conflict("managed admission receipt differs from its durable Attempt"));
        }
        let canonical = json!({
            "goalID": goal_id,
            "runID": attempt.run_id,
            "taskID": attempt.task_id,
            "attemptID": attempt_id,
            "executorPrincipal": attempt.executor_principal,
            "ownerEpoch": attempt.owner_epoch.to_string(),
            "locationID": attempt.location_id,
            "sessionID": attempt.session_id,
            "workspaceRevision": workspace_revision,
            "bindingDigest": binding_digest,
            "expectedManagedRevision": expected_managed_revision.to_string(),
            "managedRevision": managed_revision.to_string(),
            "deliveryID": delivery_id,
        });
        let receipt_digest = format!("blake3:{}", blake3::hash(canonical.to_string().as_bytes()).to_hex());
        Ok(Self {
            goal_id: goal_id.to_owned(),
            run_id: attempt.run_id.clone(),
            task_id: attempt.task_id.clone(),
            attempt_id: attempt_id.to_owned(),
            executor_principal: attempt.executor_principal.clone(),
            owner_epoch: attempt.owner_epoch,
            location_id: attempt.location_id.clone(),
            session_id: attempt.session_id.clone(),
            workspace_revision,
            binding,
            binding_digest,
            expected_managed_revision,
            managed_revision,
            delivery_id: delivery_id.to_owned(),
            receipt_digest,
        })
    }
}

/// Opaque facts resolved by authenticated Rust owner services for one managed
/// Attempt admission. This is crate-private: request decoders cannot construct
/// it. P1 supplies authenticated execution/workspace facts, P8 supplies live
/// durable lease proofs, and the registered AgentProfile/context owners supply
/// their immutable selections. Until each owner can construct its proof,
/// managed effect admission remains unavailable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthenticatedAttemptAdmissionProofV1 {
    goal_id: String,
    attempt_id: String,
    run_id: String,
    task_id: String,
    executor_principal: String,
    location_id: String,
    /// Host-resolved canonical workspace binding for the registered Location.
    /// This is compared with P8's owner proof; it is never read from request JSON.
    workspace_binding: String,
    session_id: String,
    owner_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RegisteredAgentProfileProofV1 {
    profile_id: String,
    profile_revision: u64,
    profile_digest: String,
    profile_source: String,
    permission_ceiling_digest: String,
    capability_ceiling: Vec<String>,
    owner_binding: ProfileOwnerBindingV1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BoundedContextSelectionProofV1 {
    context_selection_digest: String,
}

/// The parent is either a real active worker Attempt or the authenticated root
/// coordinator attachment for the existing Core process. Root coordinators do
/// not receive synthetic Task/Attempt identities.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ParentExecutionProofV1 {
    Worker {
    execution_id: String,
    principal_ref: String,
    goal_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    session_id: String,
    workspace_binding: String,
    owner_epoch: u64,
    accepted_spec_digest: String,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    },
    RootCoordinator {
        execution_id: String,
        principal_ref: String,
        goal_id: String,
        run_id: String,
        session_id: String,
        location_id: String,
        workspace_binding: String,
        owner_epoch: u64,
        accepted_spec_digest: String,
        source_revision: String,
        process_incarnation: String,
        owner_log_id: String,
        owner_log_sequence: String,
        owner_log_event_digest: String,
        worker_pool_revision: u64,
        expires_at_ms: u64,
    },
}

impl ParentExecutionProofV1 {
    /// Build this proof only from the HostKernel-authenticated active parent
    /// Attempt plus P8's currently resolved worker lease proof. The HostKernel
    /// caller must obtain both from the durable parent owner, not infer them
    /// from the current Session, child Task, or a ticket.
    pub(crate) fn from_active_attempt_owner(
        parent_attempt: &AuthenticatedAttemptAdmissionProofV1,
        parent_worker: &crate::worker_durable::DurableManagedLeaseProofV1,
    ) -> Result<Self, ManagedError> {
        let proof = Self::Worker {
            execution_id: parent_worker.worker_execution_id().to_owned(),
            principal_ref: parent_attempt.executor_principal.clone(),
            goal_id: parent_attempt.goal_id.clone(),
            run_id: parent_attempt.run_id.clone(),
            task_id: parent_attempt.task_id.clone(),
            attempt_id: parent_attempt.attempt_id.clone(),
            session_id: parent_attempt.session_id.clone(),
            workspace_binding: parent_attempt.workspace_binding.clone(),
            owner_epoch: parent_attempt.owner_epoch,
            accepted_spec_digest: parent_worker.accepted_spec_digest().to_owned(),
            owner_log_id: parent_worker.owner_log_id().to_owned(),
            owner_log_sequence: parent_worker.owner_log_sequence().to_owned(),
            owner_log_event_digest: parent_worker.owner_log_event_digest().to_owned(),
            worker_pool_revision: parent_worker.worker_pool_revision(),
        };
        if !proof.matches_worker_owner(parent_worker)
            || parent_worker.worker_state() != crate::resource_budget::ReservationState::Claimed
            || parent_worker.process_identity().is_none()
            || proof.owner_epoch == 0
            || proof.worker_pool_revision == 0
            || !proof.owner_log_sequence.parse::<u64>().is_ok_and(|sequence| sequence > 0)
        {
            return Err(ManagedError::Conflict(
                "active parent execution owner proof is missing or stale",
            ));
        }
        id(&proof.execution_id)?;
        id(&proof.owner_log_id)?;
        principal(&proof.principal_ref)?;
        managed_digest(&proof.accepted_spec_digest)?;
        blake3_digest(&proof.owner_log_event_digest)?;
        Ok(proof)
    }

    /// Build a root parent only from P8's durable root-coordinator owner proof.
    /// No Task or Attempt identity is synthesized for the logical root.
    pub(crate) fn from_root_coordinator_owner(
        root: &crate::worker_durable::RootCoordinatorExecutionProofV1,
    ) -> Result<Self, ManagedError> {
        let proof = Self::RootCoordinator {
            execution_id: root.worker_execution_id().to_owned(),
            principal_ref: root.principal_ref().to_owned(),
            goal_id: root.goal_id().to_owned(),
            run_id: root.run_id().to_owned(),
            session_id: root.session_id().to_owned(),
            location_id: root.location_id().to_owned(),
            workspace_binding: root.workspace_binding().to_owned(),
            owner_epoch: root.owner_epoch(),
            accepted_spec_digest: root.accepted_spec_digest().to_owned(),
            source_revision: root.source_revision().to_owned(),
            process_incarnation: root.process_incarnation().to_owned(),
            owner_log_id: root.owner_log_id().to_owned(),
            owner_log_sequence: root.owner_log_sequence().to_owned(),
            owner_log_event_digest: root.owner_log_event_digest().to_owned(),
            worker_pool_revision: root.worker_pool_revision(),
            expires_at_ms: root.expires_at_ms(),
        };
        let Self::RootCoordinator {
            execution_id,
            principal_ref,
            goal_id,
            run_id,
            session_id,
            location_id,
            workspace_binding,
            owner_epoch,
            accepted_spec_digest,
            source_revision,
            process_incarnation,
            owner_log_id,
            owner_log_sequence,
            owner_log_event_digest,
            worker_pool_revision,
            expires_at_ms,
        } = &proof else {
            unreachable!("constructed root proof must be the root variant")
        };
        if *owner_epoch == 0
            || *worker_pool_revision == 0
            || *expires_at_ms == 0
            || !owner_log_sequence.parse::<u64>().is_ok_and(|sequence| sequence > 0)
        {
            return Err(ManagedError::Conflict("root coordinator owner proof is stale or incomplete"));
        }
        for value in [execution_id, goal_id, run_id, session_id, location_id, workspace_binding, source_revision, process_incarnation, owner_log_id] {
            id(value)?;
        }
        principal(principal_ref)?;
        managed_digest(accepted_spec_digest)?;
        blake3_digest(owner_log_event_digest)?;
        Ok(proof)
    }

    pub(crate) fn execution_id(&self) -> &str {
        match self {
            Self::Worker { execution_id, .. } | Self::RootCoordinator { execution_id, .. } => execution_id,
        }
    }

    #[cfg(test)]
    fn test_fixture_for(
        child: &AuthenticatedAttemptAdmissionProofV1,
        execution_id: &str,
        accepted_spec_digest: &str,
    ) -> Self {
        Self::Worker {
            execution_id: execution_id.to_owned(),
            principal_ref: child.executor_principal.clone(),
            goal_id: child.goal_id.clone(),
            run_id: child.run_id.clone(),
            task_id: "parent-task".to_owned(),
            attempt_id: "parent-attempt".to_owned(),
            session_id: child.session_id.clone(),
            workspace_binding: child.workspace_binding.clone(),
            owner_epoch: child.owner_epoch,
            accepted_spec_digest: accepted_spec_digest.to_owned(),
            owner_log_id: "worker-test-pool".to_owned(),
            owner_log_sequence: "1".to_owned(),
            owner_log_event_digest: format!("blake3:{}", "0".repeat(64)),
            worker_pool_revision: 1,
        }
    }

    #[cfg(test)]
    fn test_set_execution_id(&mut self, value: &str) {
        if let Self::Worker { execution_id, .. } = self {
            *execution_id = value.to_owned();
        }
    }

    fn matches_worker_owner(
        &self,
        worker: &crate::worker_durable::DurableManagedLeaseProofV1,
    ) -> bool {
        match self {
            Self::Worker {
                execution_id, principal_ref, goal_id, run_id, task_id, attempt_id, session_id,
                workspace_binding, owner_epoch, accepted_spec_digest, owner_log_id,
                owner_log_sequence, owner_log_event_digest, worker_pool_revision,
            } => execution_id == worker.worker_execution_id()
                && principal_ref == worker.principal_ref()
                && goal_id == worker.goal_id()
                && run_id == worker.run_id()
                && task_id == worker.task_id()
                && attempt_id == worker.attempt_id()
                && session_id == worker.session_id()
                && workspace_binding == worker.workspace_binding()
                && owner_epoch == &worker.owner_epoch()
                && accepted_spec_digest == worker.accepted_spec_digest()
                && owner_log_id == worker.owner_log_id()
                && owner_log_sequence == worker.owner_log_sequence()
                && owner_log_event_digest == worker.owner_log_event_digest()
                && worker_pool_revision == &worker.worker_pool_revision(),
            Self::RootCoordinator { .. } => false,
        }
    }

    fn matches_child(
        &self,
        child: &AuthenticatedAttemptAdmissionProofV1,
        child_worker: &crate::worker_durable::DurableManagedLeaseProofV1,
    ) -> bool {
        match self {
            Self::Worker {
                execution_id, principal_ref, goal_id, run_id, task_id, attempt_id, session_id,
                workspace_binding, owner_epoch, accepted_spec_digest, ..
            } => execution_id != child_worker.worker_execution_id()
                && principal_ref == &child.executor_principal
                && goal_id == &child.goal_id
                && run_id == &child.run_id
                && session_id == &child.session_id
                && workspace_binding == &child.workspace_binding
                && owner_epoch == &child.owner_epoch
                && accepted_spec_digest == child_worker.accepted_spec_digest()
                && task_id != &child.task_id
                && attempt_id != &child.attempt_id,
            Self::RootCoordinator {
                execution_id, principal_ref, goal_id, run_id, session_id, location_id,
                workspace_binding, owner_epoch, accepted_spec_digest, ..
            } => execution_id != child_worker.worker_execution_id()
                && principal_ref == &child.executor_principal
                && goal_id == &child.goal_id
                && run_id == &child.run_id
                && session_id == &child.session_id
                && location_id == &child.location_id
                && workspace_binding == &child.workspace_binding
                && owner_epoch == &child.owner_epoch
                && accepted_spec_digest == child_worker.accepted_spec_digest(),
        }
    }
}

impl BoundedContextSelectionProofV1 {
    /// Accept only a strict typed selection from the authenticated Core
    /// ContextService path and bind it to the exact Attempt Session. A digest
    /// copied from IPC is never sufficient to construct this proof.
    pub(crate) fn from_core_selection(
        selection: &crate::context_selection::ContextSelectionV1,
        authenticated_session_id: &str,
    ) -> Result<Self, ManagedError> {
        if selection.session_id != authenticated_session_id {
            return Err(ManagedError::Conflict(
                "ContextSelection belongs to another authenticated Session",
            ));
        }
        let context_selection_digest = selection
            .digest()
            .map_err(|_| ManagedError::Invalid("ContextSelection digest failed"))?;
        blake3_digest(&context_selection_digest)?;
        Ok(Self { context_selection_digest })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceSourceLeaseProofV1 {
    workspace_lease_id: String,
    source_revision: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResourceLeaseProofV1 {
    budget_lease_id: String,
    resource_lease_ids: Vec<String>,
}

impl RegisteredAgentProfileProofV1 {
    /// Converts a profile only after HostKernel's full strict schema decoder has
    /// authenticated and validated the Core definition. All digests and the
    /// narrowing capability list are recomputed from that canonical value.
    pub(crate) fn from_validated_definition(
        profile: &crate::agent_profile::AgentProfileDefinitionV2,
        owner_binding: ProfileOwnerBindingV1,
    ) -> Result<Self, messagepack::MessagePackError> {
        Ok(Self {
            profile_id: profile.profile_id.clone(),
            profile_revision: profile.revision,
            profile_digest: profile.definition_digest()?,
            profile_source: profile.source.clone(),
            permission_ceiling_digest: profile.permission_ceiling_digest()?,
            capability_ceiling: profile.capability_ceiling.clone(),
            owner_binding,
        })
    }

    pub(crate) fn profile_id(&self) -> &str { &self.profile_id }
    pub(crate) fn profile_revision(&self) -> u64 { self.profile_revision }
    pub(crate) fn profile_digest(&self) -> &str { &self.profile_digest }
    pub(crate) fn profile_source(&self) -> &str { &self.profile_source }
    pub(crate) fn permission_ceiling_digest(&self) -> &str { &self.permission_ceiling_digest }
    pub(crate) fn capability_ceiling(&self) -> &[String] { &self.capability_ceiling }
    pub(crate) fn owner_binding(&self) -> &ProfileOwnerBindingV1 { &self.owner_binding }
}

impl AuthenticatedAttemptAdmissionProofV1 {
    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn task_id(&self) -> &str { &self.task_id }
    pub(crate) fn executor_principal(&self) -> &str { &self.executor_principal }
    pub(crate) fn location_id(&self) -> &str { &self.location_id }
    pub(crate) fn workspace_binding(&self) -> &str { &self.workspace_binding }
    pub(crate) fn session_id(&self) -> &str { &self.session_id }
    pub(crate) fn owner_epoch(&self) -> u64 { self.owner_epoch }

    /// Private bridge for HostKernel's authenticated owner adapter. It accepts
    /// the already-decoded out-of-body principal and durable owner identities;
    /// request DTOs cannot reach this constructor or supply authentication.
    pub(crate) fn from_host_authenticated_owner(
        authenticated_principal: &crate::protocol::AuthenticatedPrincipalV1,
        goal_id: &str,
        attempt_id: &str,
        run_id: &str,
        task_id: &str,
        location_id: &str,
        workspace_binding: &str,
        session_id: &str,
        owner_epoch: u64,
    ) -> Result<Self, ManagedError> {
        let subject = match authenticated_principal {
            crate::protocol::AuthenticatedPrincipalV1::ServerAuth { subject }
                if !subject.is_empty()
                    && subject.len() <= 256
                    && !subject.chars().any(char::is_control) => subject,
            _ => return Err(ManagedError::Conflict("authenticated managed executor principal missing")),
        };
        let executor_principal = format!("server_auth:{subject}");
        principal(&executor_principal)?;
        for identity in [goal_id, attempt_id, run_id, task_id, location_id, workspace_binding, session_id] {
            id(identity)?;
        }
        if owner_epoch == 0 {
            return Err(ManagedError::Conflict("managed owner epoch is unavailable"));
        }
        Ok(Self {
            goal_id: goal_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            run_id: run_id.to_owned(),
            task_id: task_id.to_owned(),
            executor_principal,
            location_id: location_id.to_owned(),
            workspace_binding: workspace_binding.to_owned(),
            session_id: session_id.to_owned(),
            owner_epoch,
        })
    }
}

/// Composition of opaque proofs produced by the trusted HostKernel, profile,
/// context and durable lease owners. The fields cannot be populated by a wire
/// decoder or an ordinary request handler.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedDelegationAdmissionFactsV1 {
    authenticated_attempt: AuthenticatedAttemptAdmissionProofV1,
    registered_profile: RegisteredAgentProfileProofV1,
    bounded_context: BoundedContextSelectionProofV1,
    workspace_source_lease: WorkspaceSourceLeaseProofV1,
    resource_leases: ResourceLeaseProofV1,
    durable_managed_lease: crate::worker_durable::DurableManagedLeaseProofV1,
    effective_capability_ceiling: crate::guard::EffectiveCapabilityCeilingProofV1,
    parent_execution: ParentExecutionProofV1,
    child_execution_id: String,
}

/// Read-only, owner-derived accepted capability facts for P1 Guard proof minting.
/// No wire decoder or request may construct this value. Guard must bind it to its
/// authenticated Attempt scope and intersect it with a Core-minted profile ceiling
/// and current runtime policy before deriving an effective digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AcceptedTaskCapabilityScopeFactsV1 {
    run_id: String,
    task_id: String,
    spec_id: String,
    spec_digest: String,
    managed_revision: u64,
    capability_scope: Vec<String>,
    required_capabilities: Vec<String>,
    profile_revision: Option<ProfileRevisionRefV1>,
    profile_owner_binding_digest: Option<String>,
}

impl AcceptedTaskCapabilityScopeFactsV1 {
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn task_id(&self) -> &str { &self.task_id }
    pub(crate) fn spec_id(&self) -> &str { &self.spec_id }
    pub(crate) fn spec_digest(&self) -> &str { &self.spec_digest }
    pub(crate) fn managed_revision(&self) -> u64 { self.managed_revision }
    pub(crate) fn capability_scope(&self) -> &[String] { &self.capability_scope }
    pub(crate) fn required_capabilities(&self) -> &[String] { &self.required_capabilities }
    pub(crate) fn profile_revision(&self) -> Option<&ProfileRevisionRefV1> { self.profile_revision.as_ref() }
    pub(crate) fn profile_owner_binding(&self) -> Option<&str> { self.profile_owner_binding_digest.as_deref() }

    /// Canonical §12.18 accepted Task/Spec capability scope digest consumed by
    /// Guard proof minting. The owner revision is encoded as decimal text.
    pub(crate) fn digest(&self) -> Result<String, messagepack::MessagePackError> {
        use crate::messagepack::Value as MpValue;
        let value = MpValue::Map(BTreeMap::from([
            ("schemaVersion".into(), MpValue::Unsigned(1)),
            ("runID".into(), MpValue::String(self.run_id.clone())),
            ("taskID".into(), MpValue::String(self.task_id.clone())),
            ("specID".into(), MpValue::String(self.spec_id.clone())),
            ("specDigest".into(), MpValue::String(self.spec_digest.clone())),
            ("managedRevision".into(), MpValue::String(self.managed_revision.to_string())),
            ("capabilityScope".into(), MpValue::Array(self.capability_scope.iter().cloned().map(MpValue::String).collect())),
            ("requiredCapabilities".into(), MpValue::Array(self.required_capabilities.iter().cloned().map(MpValue::String).collect())),
        ]));
        let bytes = messagepack::encode(&value, FRAME_LIMITS)?;
        let mut preimage = b"horizoncode.accepted-task-capability-scope.v1\0".to_vec();
        preimage.extend_from_slice(&bytes);
        Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
    }
}

impl ManagedDelegationAdmissionFactsV1 {
    /// Typed composition only; no raw profile, context, workspace or resource
    /// strings cross this seam. Each proof's owner controls its constructor.
    pub(crate) fn from_owner_proofs(
        authenticated_attempt: AuthenticatedAttemptAdmissionProofV1,
        registered_profile: RegisteredAgentProfileProofV1,
        bounded_context: BoundedContextSelectionProofV1,
        durable_managed_lease: crate::worker_durable::DurableManagedLeaseProofV1,
        effective_capability_ceiling: crate::guard::EffectiveCapabilityCeilingProofV1,
        parent_execution: ParentExecutionProofV1,
    ) -> Self {
        // The lease IDs and source revision are copied only from the opaque P8
        // proof. Keeping this cached projection makes existing downstream
        // binding code explicit while equality checks below detect any drift.
        let workspace_source_lease = WorkspaceSourceLeaseProofV1 {
            workspace_lease_id: durable_managed_lease.workspace_lease_id().to_owned(),
            source_revision: durable_managed_lease.source_revision().to_owned(),
        };
        let resource_leases = ResourceLeaseProofV1 {
            budget_lease_id: durable_managed_lease.budget_lease_id().to_owned(),
            resource_lease_ids: durable_managed_lease.resource_lease_ids().to_vec(),
        };
        let child_execution_id = durable_managed_lease.worker_execution_id().to_owned();
        Self {
            authenticated_attempt,
            registered_profile,
            bounded_context,
            workspace_source_lease,
            resource_leases,
            durable_managed_lease,
            effective_capability_ceiling,
            parent_execution,
            child_execution_id,
        }
    }
}

/// Checks that the P8 proof is the exact live-owner projection expected for
/// this authenticated Attempt. P8 mints it only after resolving its replayed
/// OwnerLog; HostKernel still re-resolves filesystem revision and Guard policy.
fn durable_lease_proof_matches_attempt(
    facts: &ManagedDelegationAdmissionFactsV1,
) -> bool {
    let lease = &facts.durable_managed_lease;
    let Some(pins) = lease.pre_admission_pins() else { return false };
    lease.purpose() == crate::worker_durable::DurableManagedLeaseProofPurposeV1::PreAdmissionReserved
        && lease.delegation_binding_digest().is_none()
        && lease.worker_state() == crate::resource_budget::ReservationState::Reserved
        && lease.principal_ref() == facts.authenticated_attempt.executor_principal
        && lease.workspace_binding() == facts.authenticated_attempt.workspace_binding
        && lease.session_id() == facts.authenticated_attempt.session_id
        && lease.run_id() == facts.authenticated_attempt.run_id
        && lease.task_id() == facts.authenticated_attempt.task_id
        && lease.attempt_id() == facts.authenticated_attempt.attempt_id
        && lease.goal_id() == facts.authenticated_attempt.goal_id
        && lease.owner_epoch() == facts.authenticated_attempt.owner_epoch
        && lease.worker_execution_id() == facts.child_execution_id
        && pins.goal_id() == facts.authenticated_attempt.goal_id
        && pins.run_id() == facts.authenticated_attempt.run_id
        && pins.task_id() == facts.authenticated_attempt.task_id
        && pins.attempt_id() == facts.authenticated_attempt.attempt_id
        && pins.owner_epoch() == facts.authenticated_attempt.owner_epoch
        && pins.principal_ref() == facts.authenticated_attempt.executor_principal
        && pins.workspace_binding() == facts.authenticated_attempt.workspace_binding
        && pins.session_id() == facts.authenticated_attempt.session_id
        && pins.location_id() == facts.authenticated_attempt.location_id
        && pins.accepted_spec_digest() == lease.accepted_spec_digest()
        && pins.workspace_revision() == lease.source_revision()
        && pins.profile_id() == facts.registered_profile.profile_id
        && pins.profile_revision() == facts.registered_profile.profile_revision
        && pins.profile_digest() == facts.registered_profile.profile_digest
        && pins.permission_scope_digest() == facts.registered_profile.permission_ceiling_digest
        && pins.context_selection_digest() == facts.bounded_context.context_selection_digest
        && pins.accepted_scope_digest() == facts.effective_capability_ceiling.accepted_scope_digest()
        && pins.capability_ceiling_digest() == facts.effective_capability_ceiling.effective_ceiling_digest()
        && pins.dimension() == crate::resource_budget::BudgetDimension::ActiveWorkers
        && pins.amount() == 1
        && lease.workspace_lease_id() == facts.workspace_source_lease.workspace_lease_id
        && lease.source_revision() == facts.workspace_source_lease.source_revision
        && lease.budget_lease_id() == facts.resource_leases.budget_lease_id
        && lease.resource_lease_ids() == facts.resource_leases.resource_lease_ids
        && !lease.ticket_id().is_empty()
        && !lease.owner_log_id().is_empty()
        && lease.owner_log_sequence().parse::<u64>().is_ok_and(|seq| seq > 0)
        && blake3_digest(lease.owner_log_event_digest()).is_ok()
        && lease.worker_pool_revision() > 0
        && facts.parent_execution.matches_child(&facts.authenticated_attempt, lease)
}

#[derive(Clone, Debug, Default)]
pub struct ManagedSnapshot {
    /// Durable OwnerLog identity used when recomputing owner-bound receipts.
    /// Set only by `ManagedControl::open`; request data cannot mutate it.
    pub(crate) owner_goal_id: String,
    pub revision: u64,
    pub goal: Option<Goal>,
    pub specs: BTreeMap<String, SpecVersion>,
    pub runs: BTreeMap<String, Run>,
    /// Run IDs whose root SessionLink was pinned in the authenticated explicit
    /// start event. Legacy post-start AttachSessionLink replay cannot make a
    /// historical Run scheduler/admission eligible.
    session_links_pinned_at_start: BTreeSet<String>,
    pub attempts: BTreeMap<String, AttemptRecord>,
    deliveries: BTreeMap<String, String>,
    /// One durable model-dispatch consume marker per admitted managed Attempt.
    /// The delivery-keyed copy is retained to return the exact receipt on replay.
    dispatch_consumptions: BTreeMap<String, ManagedDispatchConsumedReceiptV1>,
    dispatch_quiescence_proofs: BTreeMap<String, ManagedDispatchQuiescenceProofV1>,
    /// Durable exactly-once prompt completion markers. Missing markers after
    /// consume mean restart ambiguity and permanently fence model re-entry.
    dispatch_quiescence: BTreeMap<String, ManagedDispatchQuiescedReceiptV1>,
    /// Exact durable replies for safe pre-admission candidate tombstones.
    candidate_abandonments: BTreeMap<String, ManagedCandidateAbandonedReceiptV1>,
    /// Exact durable replies for atomic managed Attempt admissions.
    managed_admission_receipts: BTreeMap<String, ManagedAttemptAdmissionReceiptV1>,
}

/// Commands contain only control identifiers and digests, never conversation
/// transcripts or mutable provider messages.
#[derive(Clone, Debug)]
pub enum ManagedCommand {
    CreateGoal {
        goal: GoalDraft,
    },
    CreateGoalProposal {
        goal: GoalDraft,
        spec_id: String,
        spec: SpecVersionDraft,
        spec_digest: String,
    },
    ProposeSpec {
        spec_id: String,
        spec: SpecVersionDraft,
        spec_digest: String,
    },
    AssignSpecReviewer {
        spec_id: String,
        spec_digest: String,
        reviewer_id: String,
    },
    AcceptSpec {
        spec_id: String,
        spec_digest: String,
        accepted_by: String,
        accepted_at_ms: u64,
    },
    RejectSpec {
        spec_id: String,
        spec_digest: String,
        rejected_by: String,
        rejected_at_ms: u64,
    },
    StartRun {
        run_id: String,
        spec_id: String,
    },
    PlanRun {
        run_id: String,
        spec_id: String,
        spec_digest: String,
        tasks: Vec<PlannedTaskV1>,
    },
    StartPlannedRun {
        run_id: String,
        spec_id: String,
        spec_digest: String,
        plan_digest: String,
        expected_goal_revision: u64,
        started_by: String,
        session_link: Option<SessionLink>,
    },
    AddTask {
        run_id: String,
        task_id: String,
        dependencies: Vec<String>,
        criterion_ids: Vec<String>,
        required_capabilities: Vec<String>,
    },
    /// New managed task ingress pins the exact immutable Core profile revision
    /// at creation. Legacy AddTask records replay as unpinned and remain
    /// ineligible for managed Attempt admission.
    AddTaskPinnedProfile {
        run_id: String,
        task_id: String,
        dependencies: Vec<String>,
        criterion_ids: Vec<String>,
        required_capabilities: Vec<String>,
        agent_profile_revision: ProfileRevisionRefV1,
        profile_owner_binding_digest: String,
    },
    MarkTaskReady {
        run_id: String,
        task_id: String,
    },
    AdmitAttempt {
        run_id: String,
        task_id: String,
        attempt_id: String,
        /// Authenticated principal of the executor that owns this Attempt.
        executor_principal: String,
        owner_epoch: u64,
        location_id: String,
        session_id: String,
    },
    /// One atomic admission event containing both the newly admitted Attempt
    /// and its immutable accepted-state/lease binding. Only the private
    /// owner-proof API constructs this command; there is no RPC decoder path.
    AdmitAttemptWithDelegation {
        run_id: String,
        task_id: String,
        attempt_id: String,
        executor_principal: String,
        owner_epoch: u64,
        location_id: String,
        session_id: String,
        binding: DelegationBindingV1,
    },
    /// Stores the HostKernel-computed workspace revision for the just-admitted
    /// Attempt. Kept separate to preserve historical state-command compatibility.
    BindAttemptWorkspaceRevision {
        attempt_id: String,
        workspace_revision: String,
    },
    /// Atomically records the complete accepted-state/lease binding in OwnerLog.
    /// Its admittedManagedRevision must equal the post-append aggregate revision.
    BindAttemptDelegation {
        attempt_id: String,
        binding: DelegationBindingV1,
    },
    /// Records one durable Attempt-to-effect edge after the trusted HostKernel
    /// adapter has resolved the effect in a registered Location. Only bound effects
    /// can back a successful settlement.
    BindAttemptEffect {
        run_id: String,
        task_id: String,
        attempt_id: String,
        effect_id: String,
        location_id: String,
        session_id: String,
    },
    /// Atomically records every EffectIntent in one admitted ToolBatch before
    /// any member can dispatch. All edges share the same OwnerLog revision.
    BindAttemptEffects {
        run_id: String,
        task_id: String,
        attempt_id: String,
        effect_ids: Vec<String>,
        location_id: String,
        session_id: String,
    },
    /// Appends an immutable verifier intent to an already bound EffectIntent edge.
    /// Only HostKernel constructs this command after deriving the live Attempt
    /// scope and trusted local verifier profile.
    BindAttemptVerifierIntent {
        intent: ManagedAttemptVerifierIntentV1,
    },
    /// Persists the authoritative target receipt for one exact bound edge while
    /// the Attempt remains live. UNKNOWN is durable and cannot be relaunched.
    RecordAttemptEffectReceipt {
        proof: ManagedAttemptEffectReceiptProofV1,
    },
    /// Appends an authoritative terminal target receipt for the first unresolved
    /// edge of an UNKNOWN Attempt. This never changes Attempt/Run back to an
    /// executable phase; only HostKernel reconciliation constructs it.
    ReconcileAttemptEffectReceipt {
        proof: ManagedAttemptEffectReceiptProofV1,
    },
    /// Durable no-replay marker before Core enters the provider/model path.
    /// HostKernel validates the current P8 claim and is the only constructor.
    ConsumeManagedDispatch {
        record: ManagedDispatchConsumeRecordV1,
    },
    /// Durable one-use completion fence after Core has persisted the exact child
    /// prompt outcome and HostKernel has verified the callback is quiescent.
    DispatchQuiesced {
        proof: ManagedDispatchQuiescenceProofV1,
    },
    AbandonPreAdmissionCandidate {
        proof: ManagedCandidateAbandonProofV1,
    },
    RecordAttemptVerifierEvidence {
        attempt_id: String,
        evidence: VerificationEvidenceV1,
    },
    /// Records the trusted scheduler's transition into execution. This state
    /// command does not dispatch work or authorize an effect.
    StartAttempt {
        run_id: String,
        task_id: String,
        attempt_id: String,
    },
    /// Records that the target action returned and is being durably settled.
    BeginAttemptSettlement {
        run_id: String,
        task_id: String,
        attempt_id: String,
    },
    /// Internal state projection for an authenticated target receipt. This is
    /// not a public ingress or a receipt validator: only a future trusted
    /// HostKernel adapter may submit it after validating the real receipt.
    SettleAttempt {
        run_id: String,
        task_id: String,
        attempt_id: String,
        receipt_digest: String,
    },
    /// Records a known post-dispatch failure only after the trusted adapter has
    /// authenticated its settled target receipts. `FailAttempt` remains limited
    /// to failures known before dispatch. `receipt_digest` is the kernel-computed
    /// composite over the bound settled effects and is absent when the failure
    /// happened before any effect settled.
    SettleAttemptFailure {
        run_id: String,
        task_id: String,
        attempt_id: String,
        failure_code: String,
        retryable: bool,
        receipt_digest: Option<String>,
    },
    MarkAttemptUnknown {
        run_id: String,
        task_id: String,
        attempt_id: String,
    },
    /// Records a failure proven to occur before dispatch; post-dispatch
    /// failures must use `SettleAttemptFailure` with an authenticated receipt.
    FailAttempt {
        run_id: String,
        task_id: String,
        attempt_id: String,
        failure_code: String,
        retryable: bool,
    },
    VerifyTask {
        run_id: String,
        task_id: String,
        attempt_id: String,
        /// Authenticated independent verifier identity (must differ from the
        /// Attempt's executor principal).
        verifier_id: String,
        source_revision: String,
        /// Kernel-computed binding over the settled receipt, criteria and revision.
        evidence_digest: String,
    },
    BeginVerification {
        run_id: String,
        final_revision: String,
        verifier_id: String,
    },
    /// Receipt-backed verification start used for all new OwnerLog events. The
    /// three-field `BeginVerification` form is retained for historical replay.
    BeginVerificationWithReceiptBasis {
        run_id: String,
        final_revision: String,
        verifier_id: String,
        receipt_basis_digest: String,
    },
    AttachSessionLink {
        run_id: String,
        link: SessionLink,
    },
    RecordCriterionEvidence {
        run_id: String,
        criterion_id: String,
        source_revision: String,
        evidence_digest: String,
        verifier_id: String,
    },
    /// Records the complete verifier result after HostKernel has authenticated the
    /// distinct verifier, rechecked the live workspace revision, and verified each
    /// exact ArtifactRef through the private ArtifactStore ingress.
    RecordVerificationEvidence {
        run_id: String,
        evidence: VerificationEvidenceV1,
    },
    FinalizeRun {
        run_id: String,
        final_revision: String,
    },
    NeedsYou {
        run_id: String,
    },
    PauseRun {
        run_id: String,
    },
    ResumeRun {
        run_id: String,
    },
    RequestCancel {
        run_id: String,
    },
    /// Records CANCELLED once a cancelling Run has no active or UNKNOWN
    /// attempts left. This command never settles an effect itself.
    CompleteCancel {
        run_id: String,
    },
    /// Terminally fails a settled Run. From RECONCILING this stays fenced until
    /// a future authenticated EffectService reconciles UNKNOWN attempts.
    FailRun {
        run_id: String,
        failure_code: String,
    },
}

fn goal_draft_value(goal: &GoalDraft) -> Value {
    json!({
        "objective": goal.objective,
        "projectRef": goal.project_ref,
        "workspaceRef": goal.workspace_ref,
        "createdBy": goal.created_by,
    })
}

fn spec_draft_value(spec: &SpecVersionDraft) -> Value {
    json!({
        "parentVersionId": spec.parent_version_id,
        "objective": spec.objective,
        "projectRef": spec.project_ref,
        "workspaceRef": spec.workspace_ref,
        "capabilityScope": spec.capability_scope,
        "scope": spec.scope,
        "constraints": spec.constraints,
        "criteria": spec.criteria.iter().map(|criterion| json!({
            "id": criterion.id,
            "description": criterion.description,
        })).collect::<Vec<_>>(),
        "budget": {
            "maxTasks": spec.budget.max_tasks,
            "maxAttemptsPerTask": spec.budget.max_attempts_per_task,
            "maxRunDurationMs": spec.budget.max_run_duration_ms,
            "maxMemoryBytes": spec.budget.max_memory_bytes,
            "maxDiskBytes": spec.budget.max_disk_bytes,
            "maxWorkers": spec.budget.max_workers,
            "maxTokens": spec.budget.max_tokens,
            "maxCostMicros": spec.budget.max_cost_micros,
        },
        "sourceDigests": spec.source_digests,
        "proposedBy": spec.proposed_by,
    })
}

fn profile_revision_ref_value(profile: &ProfileRevisionRefV1) -> Value {
    json!({
        "profileId": profile.profile_id,
        "revision": profile.revision.to_string(),
        "definitionDigest": profile.definition_digest,
    })
}

fn planned_task_set_digest(run: &Run) -> String {
    let tasks = run.tasks.iter().map(|(task_id, task)| json!({
        "taskId": task_id,
        "title": task.title,
        "purpose": task.purpose,
        "dependencies": task.dependencies,
        "criterionIds": task.criterion_ids,
        "requiredCapabilities": task.required_capabilities,
        "agentProfileRevision": task.agent_profile_revision.as_ref().map(profile_revision_ref_value),
        "profileOwnerBindingDigest": task.profile_owner_binding_digest,
    })).collect::<Vec<_>>();
    format!("blake3:{}", blake3::hash(json!({"schemaVersion":1,"tasks":tasks}).to_string().as_bytes()).to_hex())
}

fn optional_profile_revision_ref(
    value: &Value,
    key: &str,
) -> Result<Option<ProfileRevisionRefV1>, ManagedError> {
    let raw = value
        .get(key)
        .ok_or(ManagedError::Invalid("Task profile revision field missing"))?;
    if raw.is_null() {
        return Ok(None);
    }
    exact_object(raw, 3)?;
    let revision = required_string(raw, "revision")?;
    if revision.is_empty()
        || (revision.len() > 1 && revision.starts_with('0'))
        || !revision.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ManagedError::Invalid("Task profile revision is noncanonical"));
    }
    let revision = revision
        .parse::<u64>()
        .ok()
        .filter(|revision| *revision > 0)
        .ok_or(ManagedError::Invalid("Task profile revision is invalid"))?;
    let profile = ProfileRevisionRefV1 {
        profile_id: required_string(raw, "profileId")?,
        revision,
        definition_digest: required_string(raw, "definitionDigest")?,
    };
    if !profile.is_valid() {
        return Err(ManagedError::Invalid("Task profile revision reference is invalid"));
    }
    Ok(Some(profile))
}

fn session_link_value(link: &SessionLink) -> Value {
    json!({
        "sessionId": link.session_id,
        "sourceStoreId": link.source_store_id,
        "sourceInstanceId": link.source_instance_id,
        "sourceCursor": {
            "ownerKind": link.source_cursor.owner_kind,
            "ownerId": link.source_cursor.owner_id,
            "seq": link.source_cursor.seq,
            "eventDigest": link.source_cursor.event_digest,
        },
        "sourceEpoch": link.source_epoch,
        "latestObservedMessageId": link.latest_observed_message_id,
        "latestObservedPartId": link.latest_observed_part_id,
        "sourceDigest": link.source_digest,
        "redactionProfile": link.redaction_profile,
        "ownerEpoch": link.owner_epoch,
        "protocolVersion": link.protocol_version,
    })
}

fn delegation_binding_json(binding: &DelegationBindingV1) -> Value {
    json!({
        "schemaVersion": 1,
        "runID": binding.run_id,
        "taskID": binding.task_id,
        "attemptID": binding.attempt_id,
        "parentExecutionID": binding.parent_execution_id,
        "childExecutionID": binding.child_execution_id,
        "acceptedSpecDigest": binding.accepted_spec_digest,
        "profileID": binding.profile_id,
        "profileRevision": binding.profile_revision.to_string(),
        "profileDigest": binding.profile_digest,
        "criteriaIDs": binding.criteria_ids,
        "workspaceLeaseID": binding.workspace_lease_id,
        "sourceRevision": binding.source_revision,
        "capabilityCeilingDigest": binding.capability_ceiling_digest,
        "contextSelectionDigest": binding.context_selection_digest,
        "budgetLeaseID": binding.budget_lease_id,
        "resourceLeaseIDs": binding.resource_lease_ids,
        "ownerEpoch": binding.owner_epoch.to_string(),
        "admittedManagedRevision": binding.admitted_managed_revision.to_string(),
    })
}

fn decode_delegation_binding(value: &Value) -> Result<DelegationBindingV1, ManagedError> {
    DelegationBindingV1::from_json_value(value)
        .ok_or(ManagedError::Invalid("delegation binding is malformed"))
}

/// Resolve all managed-owned fields from the current accepted projection and
/// compose them with owner-only facts. The caller supplies the exact next
/// revision reserved for the single atomic admission event; no binding can be
/// minted from a request JSON map.
fn mint_delegation_binding(
    snapshot: &ManagedSnapshot,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    facts: &ManagedDelegationAdmissionFactsV1,
    admitted_managed_revision: u64,
) -> Result<DelegationBindingV1, ManagedError> {
    let expected_revision = snapshot
        .revision
        .checked_add(1)
        .ok_or(ManagedError::Invalid("managed revision overflow"))?;
    if admitted_managed_revision != expected_revision {
        return Err(ManagedError::Conflict(
            "delegation admission revision is stale",
        ));
    }
    let goal = snapshot
        .goal
        .as_ref()
        .ok_or(ManagedError::Conflict("managed Goal missing"))?;
    let run = snapshot
        .runs
        .get(run_id)
        .ok_or(ManagedError::Conflict("managed Run missing"))?;
    let task = run
        .tasks
        .get(task_id)
        .ok_or(ManagedError::Conflict("managed Task missing"))?;
    let spec = snapshot
        .specs
        .get(&run.spec_id)
        .ok_or(ManagedError::Conflict("accepted SpecVersion missing"))?;
    let attempt = snapshot
        .attempts
        .get(attempt_id)
        .ok_or(ManagedError::Conflict("managed Attempt missing"))?;
    let subject = facts.authenticated_attempt.executor_principal
        .strip_prefix("server_auth:")
        .ok_or(ManagedError::Conflict("managed profile requires authenticated ServerAuth executor"))?;
    let authenticated_owner = ProfileOwnerBindingV1::from_authenticated_principal(
        facts.registered_profile.profile_source(),
        &crate::protocol::AuthenticatedPrincipalV1::ServerAuth { subject: subject.to_owned() },
    ).ok_or(ManagedError::Conflict("managed profile owner is unavailable for this executor"))?;
    let authenticated_owner_digest = authenticated_owner.digest();
    if !spec.accepted
        || goal.active_spec_version_id.as_deref() != Some(run.spec_id.as_str())
        || spec.digest != spec.content.digest()
        || run.phase != RunPhase::Running
        || task.active_attempt.as_deref() != Some(attempt_id)
        || attempt.run_id != run_id
        || attempt.task_id != task_id
        || attempt.phase != AttemptPhase::Executing
        || facts.authenticated_attempt.attempt_id != attempt_id
        || facts.authenticated_attempt.run_id != run_id
        || facts.authenticated_attempt.task_id != task_id
        || attempt.owner_epoch != facts.authenticated_attempt.owner_epoch
        || facts.authenticated_attempt.goal_id.is_empty()
        || !durable_lease_proof_matches_attempt(facts)
        || facts.durable_managed_lease.goal_id() != facts.authenticated_attempt.goal_id
        || facts.durable_managed_lease.accepted_spec_digest() != spec.digest
        || attempt.workspace_revision.as_deref()
            != Some(facts.workspace_source_lease.source_revision.as_str())
        || task.criterion_ids.is_empty()
        || task.criterion_ids.len() > 32
        || task.agent_profile_revision.as_ref().is_none_or(|pin| {
            !pin.is_valid()
                || pin.profile_id != facts.registered_profile.profile_id
                || pin.revision != facts.registered_profile.profile_revision
                || pin.definition_digest != facts.registered_profile.profile_digest
        })
        || task.profile_owner_binding_digest.as_deref()
            != Some(authenticated_owner_digest.as_str())
        || facts.registered_profile.owner_binding() != &authenticated_owner
        || task.profile_owner_binding_digest.as_deref()
            != Some(facts.registered_profile.owner_binding().digest().as_str())
    {
        return Err(ManagedError::Conflict(
            "managed Attempt or owner facts are stale or outside accepted scope",
        ));
    }
    let mut criteria_ids = task.criterion_ids.clone();
    criteria_ids.sort();
    if criteria_ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(ManagedError::Conflict(
            "accepted Task criteria are duplicated",
        ));
    }
    if facts.resource_leases.resource_lease_ids.len() > 16
        || facts
            .resource_leases
            .resource_lease_ids
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err(ManagedError::Invalid(
            "resource lease proofs must be bounded, sorted and unique",
        ));
    }
    let accepted_scope = AcceptedTaskCapabilityScopeFactsV1 {
        run_id: run_id.to_owned(),
        task_id: task_id.to_owned(),
        spec_id: run.spec_id.clone(),
        spec_digest: spec.digest.clone(),
        managed_revision: snapshot.revision,
        capability_scope: spec.content.capability_scope.clone(),
        required_capabilities: task.required_capabilities.clone(),
        profile_revision: task.agent_profile_revision.clone(),
        profile_owner_binding_digest: task.profile_owner_binding_digest.clone(),
    };
    let accepted_scope_digest = accepted_scope
        .digest()
        .map_err(|_| ManagedError::Invalid("accepted capability scope digest failed"))?;
    let effective = &facts.effective_capability_ceiling;
    if effective.attempt_id() != attempt_id
        || effective.owner_epoch() != facts.authenticated_attempt.owner_epoch
        || effective.run_id() != run_id
        || effective.task_id() != task_id
        || effective.accepted_scope_digest() != accepted_scope_digest
        || effective.profile_id() != facts.registered_profile.profile_id
        || effective.profile_revision() != facts.registered_profile.profile_revision
        || effective.profile_digest() != facts.registered_profile.profile_digest
        || effective.profile_owner_binding_digest() != facts.registered_profile.owner_binding().digest()
        || effective.profile_permission_digest() != facts.registered_profile.permission_ceiling_digest
    {
        return Err(ManagedError::Conflict(
            "Guard effective capability proof does not match accepted Attempt scope",
        ));
    }
    let binding = DelegationBindingV1 {
        run_id: run_id.to_owned(),
        task_id: task_id.to_owned(),
        attempt_id: attempt_id.to_owned(),
        parent_execution_id: facts.parent_execution.execution_id().to_owned(),
        child_execution_id: facts.child_execution_id.clone(),
        accepted_spec_digest: spec.digest.clone(),
        profile_id: facts.registered_profile.profile_id.clone(),
        profile_revision: facts.registered_profile.profile_revision,
        profile_digest: facts.registered_profile.profile_digest.clone(),
        criteria_ids,
        workspace_lease_id: facts.workspace_source_lease.workspace_lease_id.clone(),
        source_revision: facts.workspace_source_lease.source_revision.clone(),
        capability_ceiling_digest: effective.effective_ceiling_digest().to_owned(),
        context_selection_digest: facts.bounded_context.context_selection_digest.clone(),
        budget_lease_id: facts.resource_leases.budget_lease_id.clone(),
        resource_lease_ids: facts.resource_leases.resource_lease_ids.clone(),
        owner_epoch: facts.authenticated_attempt.owner_epoch,
        admitted_managed_revision,
    };
    if DelegationBindingV1::from_value(&binding.to_value()).as_ref() != Some(&binding) {
        return Err(ManagedError::Invalid(
            "delegation owner facts are missing or malformed",
        ));
    }
    Ok(binding)
}

fn delegation_binding_matches_owner_facts(
    binding: &DelegationBindingV1,
    facts: &ManagedDelegationAdmissionFactsV1,
) -> bool {
    binding.run_id == facts.authenticated_attempt.run_id
        && binding.task_id == facts.authenticated_attempt.task_id
        && binding.attempt_id == facts.authenticated_attempt.attempt_id
        && binding.parent_execution_id == facts.parent_execution.execution_id()
        && binding.child_execution_id == facts.child_execution_id
        && binding.profile_id == facts.registered_profile.profile_id
        && binding.profile_revision == facts.registered_profile.profile_revision
        && binding.profile_digest == facts.registered_profile.profile_digest
        && binding.workspace_lease_id == facts.workspace_source_lease.workspace_lease_id
        && binding.source_revision == facts.workspace_source_lease.source_revision
        && binding.capability_ceiling_digest == facts.effective_capability_ceiling.effective_ceiling_digest()
        && binding.context_selection_digest == facts.bounded_context.context_selection_digest
        && binding.budget_lease_id == facts.resource_leases.budget_lease_id
        && binding.resource_lease_ids == facts.resource_leases.resource_lease_ids
        && binding.owner_epoch == facts.authenticated_attempt.owner_epoch
        && durable_lease_proof_matches_attempt(facts)
        && facts.effective_capability_ceiling.profile_owner_binding_digest()
            == facts.registered_profile.owner_binding().digest()
}

fn artifact_ref_value(reference: &ArtifactRefV1) -> Value {
    let classification = match reference.classification {
        ArtifactClassificationV1::Public => "PUBLIC",
        ArtifactClassificationV1::Workspace => "WORKSPACE",
        ArtifactClassificationV1::Sensitive => "SENSITIVE",
    };
    json!({
        "artifactID": reference.artifact_id,
        "digest": reference.digest,
        "byteLength": reference.byte_length,
        "mediaType": reference.media_type,
        "classification": classification,
    })
}

fn verification_evidence_value(evidence: &VerificationEvidenceV1) -> Value {
    let criteria = evidence
        .criteria
        .iter()
        .map(|criterion| {
            let verdict = match criterion.verdict {
                VerificationVerdictV1::Pass => "PASS",
                VerificationVerdictV1::Fail => "FAIL",
            };
            json!({
                "criterionID": criterion.criterion_id,
                "verdict": verdict,
                "testIdentity": criterion.test_identity,
                "testRunID": criterion.test_run_id,
                "process": {
                    "executionID": criterion.process.execution_id,
                    "generation": criterion.process.generation,
                    "exitCode": criterion.process.exit_code,
                    "stdoutDigest": criterion.process.stdout_digest,
                    "stderrDigest": criterion.process.stderr_digest,
                    "outputBytes": criterion.process.output_bytes,
                    "durationMs": criterion.process.duration_ms,
                    "truncated": criterion.process.truncated,
                },
                "artifactRefs": criterion.artifact_refs.iter().map(artifact_ref_value).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "verificationRunID": evidence.verification_run_id,
        "verifierID": evidence.verifier_id,
        "sourceRevision": evidence.source_revision,
        "profile": {
            "profileID": evidence.profile.profile_id,
            "ownerEpoch": evidence.profile.owner_epoch,
            "executableDigest": evidence.profile.executable_digest,
            "profileDigest": evidence.profile.profile_digest,
        },
        "aggregateOutputBytes": evidence.aggregate_output_bytes,
        "aggregateDurationMs": evidence.aggregate_duration_ms,
        "criteria": criteria,
        "evidenceDigest": evidence.evidence_digest,
    })
}

fn exact_object(
    value: &Value,
    expected_fields: usize,
) -> Result<&serde_json::Map<String, Value>, ManagedError> {
    let object = value.as_object().ok_or(ManagedError::Invalid(
        "managed event payload must be object",
    ))?;
    if object.len() != expected_fields {
        return Err(ManagedError::Invalid("managed event fields mismatch"));
    }
    Ok(object)
}

fn required_string(value: &Value, name: &str) -> Result<String, ManagedError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(ManagedError::Invalid(
            "managed event field missing or wrong type",
        ))
}

fn required_blake3(value: &Value, name: &str) -> Result<String, ManagedError> {
    let digest = required_string(value, name)?;
    blake3_digest(&digest)?;
    Ok(digest)
}

fn optional_string(value: &Value, name: &str) -> Result<Option<String>, ManagedError> {
    match value.get(name) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(ManagedError::Invalid("managed optional string is invalid")),
    }
}

fn required_u64(value: &Value, name: &str) -> Result<u64, ManagedError> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .ok_or(ManagedError::Invalid(
            "managed event integer missing or invalid",
        ))
}

fn optional_u64(value: &Value, name: &str) -> Result<Option<u64>, ManagedError> {
    match value.get(name) {
        Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or(ManagedError::Invalid("managed optional integer is invalid")),
        None => Err(ManagedError::Invalid("managed optional integer is missing")),
    }
}

fn string_list(value: &Value, name: &str) -> Result<Vec<String>, ManagedError> {
    value
        .get(name)
        .and_then(Value::as_array)
        .ok_or(ManagedError::Invalid("managed event array missing"))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or(ManagedError::Invalid("managed event array item invalid"))
        })
        .collect()
}

fn decode_goal_draft(value: &Value) -> Result<GoalDraft, ManagedError> {
    exact_object(value, 4)?;
    Ok(GoalDraft {
        objective: required_string(value, "objective")?,
        project_ref: required_string(value, "projectRef")?,
        workspace_ref: required_string(value, "workspaceRef")?,
        created_by: required_string(value, "createdBy")?,
    })
}

fn decode_spec_draft(value: &Value) -> Result<SpecVersionDraft, ManagedError> {
    exact_object(value, 11)?;
    let criteria_value = value
        .get("criteria")
        .and_then(Value::as_array)
        .ok_or(ManagedError::Invalid("managed criteria array missing"))?;
    let criteria = criteria_value
        .iter()
        .map(|value| {
            exact_object(value, 2)?;
            Ok(AcceptanceCriterion {
                id: required_string(value, "id")?,
                description: required_string(value, "description")?,
            })
        })
        .collect::<Result<Vec<_>, ManagedError>>()?;
    let budget_value = value
        .get("budget")
        .ok_or(ManagedError::Invalid("managed budget missing"))?;
    exact_object(budget_value, 8)?;
    let max_tasks = u16::try_from(required_u64(budget_value, "maxTasks")?)
        .map_err(|_| ManagedError::Invalid("managed task budget overflow"))?;
    let max_attempts_per_task = u16::try_from(required_u64(budget_value, "maxAttemptsPerTask")?)
        .map_err(|_| ManagedError::Invalid("managed attempt budget overflow"))?;
    let max_workers = u16::try_from(required_u64(budget_value, "maxWorkers")?)
        .map_err(|_| ManagedError::Invalid("managed worker budget overflow"))?;
    Ok(SpecVersionDraft {
        parent_version_id: optional_string(value, "parentVersionId")?,
        objective: required_string(value, "objective")?,
        project_ref: required_string(value, "projectRef")?,
        workspace_ref: required_string(value, "workspaceRef")?,
        capability_scope: string_list(value, "capabilityScope")?,
        scope: string_list(value, "scope")?,
        constraints: string_list(value, "constraints")?,
        criteria,
        budget: SpecBudget {
            max_tasks,
            max_attempts_per_task,
            max_run_duration_ms: required_u64(budget_value, "maxRunDurationMs")?,
            max_memory_bytes: optional_u64(budget_value, "maxMemoryBytes")?,
            max_disk_bytes: optional_u64(budget_value, "maxDiskBytes")?,
            max_workers,
            max_tokens: optional_u64(budget_value, "maxTokens")?,
            max_cost_micros: optional_u64(budget_value, "maxCostMicros")?,
        },
        source_digests: string_list(value, "sourceDigests")?,
        proposed_by: required_string(value, "proposedBy")?,
    })
}

fn decode_session_link(value: &Value) -> Result<SessionLink, ManagedError> {
    exact_object(value, 11)?;
    let cursor = value
        .get("sourceCursor")
        .ok_or(ManagedError::Invalid("SessionLink cursor missing"))?;
    exact_object(cursor, 4)?;
    let protocol_version = u16::try_from(required_u64(value, "protocolVersion")?)
        .map_err(|_| ManagedError::Invalid("SessionLink protocol version overflow"))?;
    Ok(SessionLink {
        session_id: required_string(value, "sessionId")?,
        source_store_id: required_string(value, "sourceStoreId")?,
        source_instance_id: required_string(value, "sourceInstanceId")?,
        source_cursor: CursorV1 {
            owner_kind: required_string(cursor, "ownerKind")?,
            owner_id: required_string(cursor, "ownerId")?,
            seq: required_string(cursor, "seq")?,
            event_digest: required_string(cursor, "eventDigest")?,
        },
        source_epoch: required_u64(value, "sourceEpoch")?,
        latest_observed_message_id: optional_string(value, "latestObservedMessageId")?,
        latest_observed_part_id: optional_string(value, "latestObservedPartId")?,
        source_digest: required_string(value, "sourceDigest")?,
        redaction_profile: required_string(value, "redactionProfile")?,
        owner_epoch: required_u64(value, "ownerEpoch")?,
        protocol_version,
    })
}

fn decode_artifact_ref(value: &Value) -> Result<ArtifactRefV1, ManagedError> {
    exact_object(value, 5)?;
    let classification = match required_string(value, "classification")?.as_str() {
        "PUBLIC" => ArtifactClassificationV1::Public,
        "WORKSPACE" => ArtifactClassificationV1::Workspace,
        "SENSITIVE" => ArtifactClassificationV1::Sensitive,
        _ => return Err(ManagedError::Invalid("artifact classification is invalid")),
    };
    Ok(ArtifactRefV1 {
        artifact_id: required_string(value, "artifactID")?,
        digest: required_string(value, "digest")?,
        byte_length: required_string(value, "byteLength")?,
        media_type: required_string(value, "mediaType")?,
        classification,
    })
}

fn decode_verification_evidence(value: &Value) -> Result<VerificationEvidenceV1, ManagedError> {
    exact_object(value, 8)?;
    let profile_value = value.get("profile").ok_or(ManagedError::Invalid(
        "verification profile evidence missing",
    ))?;
    exact_object(profile_value, 4)?;
    let criteria_value = value
        .get("criteria")
        .and_then(Value::as_array)
        .ok_or(ManagedError::Invalid("verification criteria are missing"))?;
    if criteria_value.is_empty() || criteria_value.len() > 256 {
        return Err(ManagedError::Invalid("verification criteria exceed bounds"));
    }
    let mut total_artifacts = 0usize;
    let criteria = criteria_value
        .iter()
        .map(|item| {
            exact_object(item, 6)?;
            let process = item
                .get("process")
                .ok_or(ManagedError::Invalid("criterion process evidence missing"))?;
            exact_object(process, 8)?;
            let verdict = match required_string(item, "verdict")?.as_str() {
                "PASS" => VerificationVerdictV1::Pass,
                "FAIL" => VerificationVerdictV1::Fail,
                _ => return Err(ManagedError::Invalid("verification verdict is invalid")),
            };
            let refs = item
                .get("artifactRefs")
                .and_then(Value::as_array)
                .ok_or(ManagedError::Invalid("verification artifacts are missing"))?;
            if refs.is_empty() || refs.len() > 64 {
                return Err(ManagedError::Invalid(
                    "verification artifact count exceeds bounds",
                ));
            }
            total_artifacts = total_artifacts.saturating_add(refs.len());
            if total_artifacts > 256 {
                return Err(ManagedError::Invalid(
                    "verification artifact total exceeds bounds",
                ));
            }
            Ok(CriterionTestEvidenceV1 {
                criterion_id: required_string(item, "criterionID")?,
                verdict,
                test_identity: required_string(item, "testIdentity")?,
                test_run_id: required_string(item, "testRunID")?,
                process: CriterionVerifierProcessEvidenceV1 {
                    execution_id: required_string(process, "executionID")?,
                    generation: required_u64(process, "generation")?,
                    exit_code: process
                        .get("exitCode")
                        .and_then(Value::as_i64)
                        .and_then(|value| i32::try_from(value).ok())
                        .ok_or(ManagedError::Invalid("criterion exit code is invalid"))?,
                    stdout_digest: required_string(process, "stdoutDigest")?,
                    stderr_digest: required_string(process, "stderrDigest")?,
                    output_bytes: required_u64(process, "outputBytes")?,
                    duration_ms: required_u64(process, "durationMs")?,
                    truncated: process.get("truncated").and_then(Value::as_bool).ok_or(
                        ManagedError::Invalid("criterion output truncation flag is invalid"),
                    )?,
                },
                artifact_refs: refs
                    .iter()
                    .map(decode_artifact_ref)
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect::<Result<Vec<_>, ManagedError>>()?;
    Ok(VerificationEvidenceV1 {
        verification_run_id: required_string(value, "verificationRunID")?,
        verifier_id: required_string(value, "verifierID")?,
        source_revision: required_string(value, "sourceRevision")?,
        profile: VerifierProfileEvidenceV1 {
            profile_id: required_string(profile_value, "profileID")?,
            owner_epoch: required_u64(profile_value, "ownerEpoch")?,
            executable_digest: required_string(profile_value, "executableDigest")?,
            profile_digest: required_string(profile_value, "profileDigest")?,
        },
        aggregate_output_bytes: required_u64(value, "aggregateOutputBytes")?,
        aggregate_duration_ms: required_u64(value, "aggregateDurationMs")?,
        criteria,
        evidence_digest: required_string(value, "evidenceDigest")?,
    })
}

impl ManagedCommand {
    fn event(&self) -> (&'static str, Value) {
        match self {
            Self::CreateGoal { goal } => ("goal_created", json!({"goal": goal_draft_value(goal)})),
            Self::CreateGoalProposal {
                goal,
                spec_id,
                spec,
                spec_digest,
            } => (
                "goal_proposal_created",
                json!({"goal": goal_draft_value(goal), "specId": spec_id, "spec": spec_draft_value(spec), "specDigest": spec_digest}),
            ),
            Self::ProposeSpec {
                spec_id,
                spec,
                spec_digest,
            } => (
                "spec_proposed",
                json!({"specId": spec_id, "spec": spec_draft_value(spec), "specDigest": spec_digest}),
            ),
            Self::AssignSpecReviewer {
                spec_id,
                spec_digest,
                reviewer_id,
            } => (
                "spec_reviewer_assigned",
                json!({"specId": spec_id, "specDigest": spec_digest, "reviewerId": reviewer_id}),
            ),
            Self::AcceptSpec {
                spec_id,
                spec_digest,
                accepted_by,
                accepted_at_ms,
            } => (
                "spec_accepted",
                json!({"specId": spec_id, "specDigest": spec_digest, "acceptedBy": accepted_by, "acceptedAtMs": accepted_at_ms}),
            ),
            Self::RejectSpec {
                spec_id,
                spec_digest,
                rejected_by,
                rejected_at_ms,
            } => (
                "spec_rejected",
                json!({"specId": spec_id, "specDigest": spec_digest, "rejectedBy": rejected_by, "rejectedAtMs": rejected_at_ms}),
            ),
            Self::StartRun { run_id, spec_id } => {
                ("run_started", json!({"runId": run_id, "specId": spec_id}))
            }
            Self::PlanRun { run_id, spec_id, spec_digest, tasks } => (
                "run_planned",
                json!({
                    "runId": run_id,
                    "specId": spec_id,
                    "specDigest": spec_digest,
                    "tasks": tasks.iter().map(|task| json!({
                        "taskId": task.task_id,
                        "title": task.title,
                        "purpose": task.purpose,
                        "dependencies": task.dependencies,
                        "criterionIds": task.criterion_ids,
                        "requiredCapabilities": task.required_capabilities,
                        "agentProfileRevision": profile_revision_ref_value(&task.agent_profile_revision),
                        "profileOwnerBindingDigest": task.profile_owner_binding_digest,
                    })).collect::<Vec<_>>(),
                }),
            ),
            Self::StartPlannedRun { run_id, spec_id, spec_digest, plan_digest, expected_goal_revision, started_by, session_link } => (
                "planned_run_started",
                json!({
                    "runId": run_id,
                    "specId": spec_id,
                    "specDigest": spec_digest,
                    "planDigest": plan_digest,
                    "expectedGoalRevision": expected_goal_revision.to_string(),
                    "startedBy": started_by,
                    "sessionLink": session_link.as_ref().map(session_link_value),
                }),
            ),
            Self::AddTask {
                run_id,
                task_id,
                dependencies,
                criterion_ids,
                required_capabilities,
            } => (
                "task_proposed",
                json!({"runId": run_id, "taskId": task_id, "dependencies": dependencies, "criterionIds": criterion_ids, "requiredCapabilities": required_capabilities}),
            ),
            Self::AddTaskPinnedProfile {
                run_id,
                task_id,
                dependencies,
                criterion_ids,
                required_capabilities,
                agent_profile_revision,
                profile_owner_binding_digest,
            } => (
                "task_proposed",
                json!({"runId": run_id, "taskId": task_id, "dependencies": dependencies, "criterionIds": criterion_ids, "requiredCapabilities": required_capabilities, "agentProfileRevision": profile_revision_ref_value(agent_profile_revision), "profileOwnerBindingDigest": profile_owner_binding_digest}),
            ),
            Self::MarkTaskReady { run_id, task_id } => {
                ("task_ready", json!({"runId": run_id, "taskId": task_id}))
            }
            Self::AdmitAttempt {
                run_id,
                task_id,
                attempt_id,
                executor_principal,
                owner_epoch,
                location_id,
                session_id,
            } => (
                "attempt_admitted",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id, "executorPrincipal": executor_principal, "ownerEpoch": owner_epoch, "locationId": location_id, "sessionId": session_id}),
            ),
            Self::AdmitAttemptWithDelegation {
                run_id,
                task_id,
                attempt_id,
                executor_principal,
                owner_epoch,
                location_id,
                session_id,
                binding,
            } => (
                "attempt_admitted_with_delegation",
                json!({
                    "runId": run_id,
                    "taskId": task_id,
                    "attemptId": attempt_id,
                    "executorPrincipal": executor_principal,
                    "ownerEpoch": owner_epoch.to_string(),
                    "locationId": location_id,
                    "sessionId": session_id,
                    "binding": delegation_binding_json(binding),
                }),
            ),
            Self::BindAttemptWorkspaceRevision {
                attempt_id,
                workspace_revision,
            } => (
                "attempt_workspace_bound",
                json!({"attemptId": attempt_id, "workspaceRevision": workspace_revision}),
            ),
            Self::BindAttemptDelegation {
                attempt_id,
                binding,
            } => (
                "attempt_delegation_bound",
                json!({"attemptId": attempt_id, "binding": delegation_binding_json(binding)}),
            ),
            Self::ConsumeManagedDispatch { record } => (
                "managed_dispatch_consumed",
                json!({
                    "goalId": record.goal_id,
                    "runId": record.run_id,
                    "taskId": record.task_id,
                    "parentSessionID": record.parent_session_id,
                    "sessionID": record.session_id,
                    "attemptId": record.attempt_id,
                    "expectedManagedRevision": record.expected_managed_revision.to_string(),
                    "handoffID": record.handoff_id,
                    "handoffDigest": record.handoff_digest,
                    "claimedProofDigest": record.claimed_proof_digest,
                    "claimedAttemptID": record.claimed_attempt_id,
                    "workerExecutionID": record.worker_execution_id,
                    "claimedBindingDigest": record.claimed_binding_digest,
                    "pinsDigest": record.pins_digest,
                    "claimOwnerLogID": record.claim_owner_log_id,
                    "claimOwnerLogSequence": record.claim_owner_log_sequence.to_string(),
                    "claimOwnerLogEventDigest": record.claim_owner_log_event_digest,
                    "workerPoolRevision": record.worker_pool_revision.to_string(),
                    "claimNonce": record.claim_nonce,
                    "attachedBindingDigest": record.attached_binding_digest,
                    "ownerEpoch": record.owner_epoch.to_string(),
                    "processIncarnation": record.process_incarnation,
                    "corePID": record.core_pid,
                    "coreStartIdentity": record.core_start_identity.to_string(),
                    "coreUID": record.core_uid,
                    "coreGID": record.core_gid,
                    "coreExecutableDigest": record.core_executable_digest,
                    "deliveryID": record.delivery_id,
                }),
            ),
            Self::DispatchQuiesced { proof } => (
                "managed_dispatch_quiesced",
                json!({
                    "goalId": proof.goal_id, "runId": proof.run_id, "taskId": proof.task_id,
                    "parentSessionID": proof.parent_session_id, "sessionID": proof.session_id,
                    "attemptId": proof.attempt_id, "handoffID": proof.handoff_id,
                    "handoffDigest": proof.handoff_digest, "consumeDeliveryID": proof.consume_delivery_id,
                    "consumeReceiptDigest": proof.consume_receipt_digest,
                    "ownerEpoch": proof.owner_epoch.to_string(), "processIncarnation": proof.process_incarnation,
                    "childSessionSequence": proof.child_session_sequence.to_string(),
                    "childSessionEventDigest": proof.child_session_event_digest,
                    "childSessionStateDigest": proof.child_session_state_digest,
                    "deliveryID": proof.delivery_id,
                }),
            ),
            Self::AbandonPreAdmissionCandidate { proof } => (
                "pre_admission_candidate_abandoned",
                json!({
                    "goalId": proof.goal_id, "runId": proof.run_id, "taskId": proof.task_id,
                    "candidateAttemptID": proof.candidate_attempt_id,
                    "workerExecutionID": proof.worker_execution_id, "ticketID": proof.ticket_id,
                    "expectedManagedRevision": proof.expected_managed_revision.to_string(),
                    "expectedTaskGeneration": proof.expected_task_generation.to_string(),
                    "expectedAttemptCount": proof.expected_attempt_count.to_string(),
                    "taskRevision": proof.task_revision.to_string(),
                    "pinsDigest": proof.pins_digest,
                    "disposition": managed_candidate_disposition_wire(proof.disposition),
                    "terminalState": managed_candidate_terminal_wire(proof.terminal_state),
                    "tombstoneOwnerLogID": proof.tombstone_owner_log_id,
                    "tombstoneOwnerLogSequence": proof.tombstone_owner_log_sequence.to_string(),
                    "tombstoneOwnerLogEventDigest": proof.tombstone_owner_log_event_digest,
                    "workerPoolRevision": proof.worker_pool_revision.to_string(),
                    "reconciliationProofDigest": proof.reconciliation_proof_digest,
                    "p8ReceiptDigest": proof.p8_receipt_digest,
                    "ownerEpoch": proof.owner_epoch.to_string(),
                    "processIncarnation": proof.process_incarnation,
                    "deliveryID": proof.delivery_id,
                }),
            ),
            Self::BindAttemptEffect {
                run_id,
                task_id,
                attempt_id,
                effect_id,
                location_id,
                session_id,
            } => (
                "attempt_effect_bound",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id, "effectId": effect_id, "locationId": location_id, "sessionId": session_id}),
            ),
            Self::BindAttemptEffects {
                run_id,
                task_id,
                attempt_id,
                effect_ids,
                location_id,
                session_id,
            } => (
                "attempt_effects_bound",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id, "effectIds": effect_ids, "locationId": location_id, "sessionId": session_id}),
            ),
            Self::BindAttemptVerifierIntent { intent } => (
                "attempt_verifier_intent_bound",
                verifier_intent_value(intent),
            ),
            Self::RecordAttemptEffectReceipt { proof } => (
                "attempt_effect_receipt_recorded",
                effect_receipt_proof_value(proof),
            ),
            Self::ReconcileAttemptEffectReceipt { proof } => (
                "attempt_effect_receipt_reconciled",
                effect_receipt_proof_value(proof),
            ),
            Self::RecordAttemptVerifierEvidence { attempt_id, evidence } => (
                "attempt_verifier_evidence_recorded",
                json!({"attemptId": attempt_id, "evidence": verification_evidence_value(evidence)}),
            ),
            Self::StartAttempt {
                run_id,
                task_id,
                attempt_id,
            } => (
                "attempt_executing",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id}),
            ),
            Self::BeginAttemptSettlement {
                run_id,
                task_id,
                attempt_id,
            } => (
                "attempt_settling",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id}),
            ),
            Self::SettleAttempt {
                run_id,
                task_id,
                attempt_id,
                receipt_digest,
            } => (
                "attempt_succeeded",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id, "receiptDigest": receipt_digest}),
            ),
            Self::SettleAttemptFailure {
                run_id,
                task_id,
                attempt_id,
                failure_code,
                retryable,
                receipt_digest,
            } => (
                "attempt_failure_settled",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id, "failureCode": failure_code, "retryable": retryable, "receiptDigest": receipt_digest}),
            ),
            Self::MarkAttemptUnknown {
                run_id,
                task_id,
                attempt_id,
            } => (
                "attempt_unknown",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id}),
            ),
            Self::FailAttempt {
                run_id,
                task_id,
                attempt_id,
                failure_code,
                retryable,
            } => (
                "attempt_failed",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id, "failureCode": failure_code, "retryable": retryable}),
            ),
            Self::VerifyTask {
                run_id,
                task_id,
                attempt_id,
                verifier_id,
                source_revision,
                evidence_digest,
            } => (
                "task_passed",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id, "verifierId": verifier_id, "sourceRevision": source_revision, "evidenceDigest": evidence_digest}),
            ),
            Self::BeginVerification {
                run_id,
                final_revision,
                verifier_id,
            } => (
                "run_verifying",
                json!({"runId": run_id, "finalRevision": final_revision, "verifierId": verifier_id}),
            ),
            Self::BeginVerificationWithReceiptBasis {
                run_id,
                final_revision,
                verifier_id,
                receipt_basis_digest,
            } => (
                "run_verifying",
                json!({"runId": run_id, "finalRevision": final_revision, "verifierId": verifier_id, "receiptBasisDigest": receipt_basis_digest}),
            ),
            Self::AttachSessionLink { run_id, link } => (
                "session_link_attached",
                json!({"runId": run_id, "sessionLink": session_link_value(link)}),
            ),
            Self::RecordCriterionEvidence {
                run_id,
                criterion_id,
                source_revision,
                evidence_digest,
                verifier_id,
            } => (
                "evidence_accepted",
                json!({"runId": run_id, "criterionId": criterion_id, "sourceRevision": source_revision, "evidenceDigest": evidence_digest, "verifierId": verifier_id}),
            ),
            Self::RecordVerificationEvidence { run_id, evidence } => (
                "verification_evidence_recorded",
                json!({"runId": run_id, "evidence": verification_evidence_value(evidence)}),
            ),
            Self::FinalizeRun {
                run_id,
                final_revision,
            } => (
                "run_succeeded",
                json!({"runId": run_id, "finalRevision": final_revision}),
            ),
            Self::NeedsYou { run_id } => ("run_needs_you", json!({"runId": run_id})),
            Self::PauseRun { run_id } => ("run_paused", json!({"runId": run_id})),
            Self::ResumeRun { run_id } => ("run_resumed", json!({"runId": run_id})),
            Self::RequestCancel { run_id } => ("run_cancelling", json!({"runId": run_id})),
            Self::CompleteCancel { run_id } => ("run_cancelled", json!({"runId": run_id})),
            Self::FailRun {
                run_id,
                failure_code,
            } => (
                "run_failed",
                json!({"runId": run_id, "failureCode": failure_code}),
            ),
        }
    }

    fn decode(kind: &str, payload: &Value) -> Result<Self, ManagedError> {
        fn field(payload: &Value, name: &str) -> Result<String, ManagedError> {
            payload
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or(ManagedError::Invalid(
                    "managed event field missing or wrong type",
                ))
        }
        fn list(payload: &Value, name: &str) -> Result<Vec<String>, ManagedError> {
            payload
                .get(name)
                .and_then(Value::as_array)
                .ok_or(ManagedError::Invalid("managed event array missing"))?
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_owned)
                        .ok_or(ManagedError::Invalid("managed event array item invalid"))
                })
                .collect()
        }
        fn decimal_u64(payload: &Value, name: &str) -> Result<u64, ManagedError> {
            let value = payload
                .get(name)
                .and_then(Value::as_str)
                .ok_or(ManagedError::Invalid("managed decimal revision missing"))?;
            value
                .parse::<u64>()
                .ok()
                .filter(|parsed| parsed.to_string() == value)
                .ok_or(ManagedError::Invalid("managed decimal revision is not canonical"))
        }
        fn receipt_proof(payload: &Value) -> Result<ManagedAttemptEffectReceiptProofV1, ManagedError> {
            let outcome = match payload.get("outcome").and_then(Value::as_str) {
                Some("SUCCEEDED") => AttemptEffectOutcomeV1::Succeeded,
                Some("FAILED") => AttemptEffectOutcomeV1::Failed,
                Some("UNKNOWN") => AttemptEffectOutcomeV1::Unknown,
                _ => return Err(ManagedError::Invalid("Attempt effect outcome is invalid")),
            };
            Ok(ManagedAttemptEffectReceiptProofV1 {
                goal_id: field(payload, "goalId")?,
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                effect_id: field(payload, "effectId")?,
                executor_principal: field(payload, "executorPrincipal")?,
                owner_epoch: decimal_u64(payload, "ownerEpoch")?,
                bound_revision: decimal_u64(payload, "boundRevision")?,
                location_id: field(payload, "locationId")?,
                session_id: field(payload, "sessionId")?,
                capability_id: field(payload, "capabilityId")?,
                capability_lease_digest: field(payload, "capabilityLeaseDigest")?,
                outcome,
                target_receipt_digest: payload.get("targetReceiptDigest").and_then(Value::as_str).map(str::to_owned),
                before_workspace_revision: field(payload, "beforeWorkspaceRevision")?,
                after_workspace_revision: payload.get("afterWorkspaceRevision").and_then(Value::as_str).map(str::to_owned),
            })
        }
        let count = payload
            .as_object()
            .ok_or(ManagedError::Invalid(
                "managed event payload must be object",
            ))?
            .len();
        let command = match kind {
            "goal_created" if count == 1 => Self::CreateGoal {
                goal: decode_goal_draft(
                    payload
                        .get("goal")
                        .ok_or(ManagedError::Invalid("managed Goal payload missing"))?,
                )?,
            },
            "goal_proposal_created" if count == 4 => Self::CreateGoalProposal {
                goal: decode_goal_draft(
                    payload
                        .get("goal")
                        .ok_or(ManagedError::Invalid("managed Goal payload missing"))?,
                )?,
                spec_id: field(payload, "specId")?,
                spec: decode_spec_draft(
                    payload
                        .get("spec")
                        .ok_or(ManagedError::Invalid("managed SpecVersion payload missing"))?,
                )?,
                spec_digest: field(payload, "specDigest")?,
            },
            "spec_proposed" if count == 3 => Self::ProposeSpec {
                spec_id: field(payload, "specId")?,
                spec: decode_spec_draft(
                    payload
                        .get("spec")
                        .ok_or(ManagedError::Invalid("managed SpecVersion payload missing"))?,
                )?,
                spec_digest: field(payload, "specDigest")?,
            },
            "spec_reviewer_assigned" if count == 3 => Self::AssignSpecReviewer {
                spec_id: field(payload, "specId")?,
                spec_digest: field(payload, "specDigest")?,
                reviewer_id: field(payload, "reviewerId")?,
            },
            "spec_accepted" if count == 4 => Self::AcceptSpec {
                spec_id: field(payload, "specId")?,
                spec_digest: field(payload, "specDigest")?,
                accepted_by: field(payload, "acceptedBy")?,
                accepted_at_ms: payload
                    .get("acceptedAtMs")
                    .and_then(Value::as_u64)
                    .ok_or(ManagedError::Invalid("acceptance time is invalid"))?,
            },
            "spec_rejected" if count == 4 => Self::RejectSpec {
                spec_id: field(payload, "specId")?,
                spec_digest: field(payload, "specDigest")?,
                rejected_by: field(payload, "rejectedBy")?,
                rejected_at_ms: payload
                    .get("rejectedAtMs")
                    .and_then(Value::as_u64)
                    .ok_or(ManagedError::Invalid("rejection time is invalid"))?,
            },
            "run_started" if count == 2 => Self::StartRun {
                run_id: field(payload, "runId")?,
                spec_id: field(payload, "specId")?,
            },
            "run_planned" if count == 4 => {
                let raw_tasks = payload.get("tasks").and_then(Value::as_array)
                    .ok_or(ManagedError::Invalid("planned Task list missing"))?;
                if raw_tasks.len() > 256 {
                    return Err(ManagedError::Invalid("planned Task list exceeds limit"));
                }
                let tasks = raw_tasks.iter().map(|raw| {
                    exact_object(raw, 8)?;
                    Ok(PlannedTaskV1 {
                        task_id: required_string(raw, "taskId")?,
                        title: required_string(raw, "title")?,
                        purpose: required_string(raw, "purpose")?,
                        dependencies: raw.get("dependencies").and_then(Value::as_array)
                            .ok_or(ManagedError::Invalid("planned dependencies missing"))?.iter()
                            .map(|item| item.as_str().map(str::to_owned).ok_or(ManagedError::Invalid("planned dependency invalid")))
                            .collect::<Result<Vec<_>, _>>()?,
                        criterion_ids: raw.get("criterionIds").and_then(Value::as_array)
                            .ok_or(ManagedError::Invalid("planned criteria missing"))?.iter()
                            .map(|item| item.as_str().map(str::to_owned).ok_or(ManagedError::Invalid("planned criterion invalid")))
                            .collect::<Result<Vec<_>, _>>()?,
                        required_capabilities: raw.get("requiredCapabilities").and_then(Value::as_array)
                            .ok_or(ManagedError::Invalid("planned capabilities missing"))?.iter()
                            .map(|item| item.as_str().map(str::to_owned).ok_or(ManagedError::Invalid("planned capability invalid")))
                            .collect::<Result<Vec<_>, _>>()?,
                        agent_profile_revision: optional_profile_revision_ref(raw, "agentProfileRevision")?
                            .ok_or(ManagedError::Invalid("planned Task profile pin missing"))?,
                        profile_owner_binding_digest: required_blake3(raw, "profileOwnerBindingDigest")?,
                    })
                }).collect::<Result<Vec<_>, ManagedError>>()?;
                Self::PlanRun {
                    run_id: field(payload, "runId")?,
                    spec_id: field(payload, "specId")?,
                    spec_digest: required_blake3(payload, "specDigest")?,
                    tasks,
                }
            }
            "planned_run_started" if count == 6 || count == 7 => Self::StartPlannedRun {
                run_id: field(payload, "runId")?,
                spec_id: field(payload, "specId")?,
                spec_digest: required_blake3(payload, "specDigest")?,
                plan_digest: required_blake3(payload, "planDigest")?,
                expected_goal_revision: decimal_u64(payload, "expectedGoalRevision")?,
                started_by: field(payload, "startedBy")?,
                session_link: if count == 7 {
                    Some(decode_session_link(payload.get("sessionLink").ok_or(ManagedError::Invalid("Run start SessionLink missing"))?)?)
                } else { None },
            },
            "task_proposed" if count == 5 => Self::AddTask {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                dependencies: list(payload, "dependencies")?,
                criterion_ids: list(payload, "criterionIds")?,
                required_capabilities: list(payload, "requiredCapabilities")?,
            },
            "task_proposed" if count == 7 => Self::AddTaskPinnedProfile {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                dependencies: list(payload, "dependencies")?,
                criterion_ids: list(payload, "criterionIds")?,
                required_capabilities: list(payload, "requiredCapabilities")?,
                agent_profile_revision: optional_profile_revision_ref(payload, "agentProfileRevision")?
                    .ok_or(ManagedError::Invalid("Task profile revision pin is required"))?,
                profile_owner_binding_digest: required_blake3(payload, "profileOwnerBindingDigest")?,
            },
            "task_ready" if count == 2 => Self::MarkTaskReady {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
            },
            "attempt_admitted" if count == 4 => Self::AdmitAttempt {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                executor_principal: field(payload, "executorPrincipal")?,
                owner_epoch: 0,
                location_id: String::new(),
                session_id: String::new(),
            },
            "attempt_admitted" if count == 7 => Self::AdmitAttempt {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                executor_principal: field(payload, "executorPrincipal")?,
                owner_epoch: payload
                    .get("ownerEpoch")
                    .and_then(Value::as_u64)
                    .ok_or(ManagedError::Invalid("Attempt owner epoch is invalid"))?,
                location_id: field(payload, "locationId")?,
                session_id: field(payload, "sessionId")?,
            },
            "attempt_admitted_with_delegation" if count == 8 => {
                let owner_epoch_text = field(payload, "ownerEpoch")?;
                let owner_epoch = owner_epoch_text
                    .parse::<u64>()
                    .ok()
                    .filter(|value| value.to_string() == owner_epoch_text)
                    .ok_or(ManagedError::Invalid(
                        "managed admission owner epoch is not canonical",
                    ))?;
                Self::AdmitAttemptWithDelegation {
                    run_id: field(payload, "runId")?,
                    task_id: field(payload, "taskId")?,
                    attempt_id: field(payload, "attemptId")?,
                    executor_principal: field(payload, "executorPrincipal")?,
                    owner_epoch,
                    location_id: field(payload, "locationId")?,
                    session_id: field(payload, "sessionId")?,
                    binding: decode_delegation_binding(
                        payload
                            .get("binding")
                            .ok_or(ManagedError::Invalid("managed admission binding missing"))?,
                    )?,
                }
            }
            "attempt_workspace_bound" if count == 2 => Self::BindAttemptWorkspaceRevision {
                attempt_id: field(payload, "attemptId")?,
                workspace_revision: field(payload, "workspaceRevision")?,
            },
            "attempt_delegation_bound" if count == 2 => Self::BindAttemptDelegation {
                attempt_id: field(payload, "attemptId")?,
                binding: decode_delegation_binding(
                    payload
                        .get("binding")
                        .ok_or(ManagedError::Invalid("delegation binding payload missing"))?,
                )?,
            },
            "managed_dispatch_consumed" if count == 26 || count == 27 || count == 28 => Self::ConsumeManagedDispatch {
                record: ManagedDispatchConsumeRecordV1 {
                    goal_id: field(payload, "goalId")?,
                    run_id: field(payload, "runId")?,
                    task_id: field(payload, "taskId")?,
                    // Legacy consumed events predate the explicit parent Session
                    // projection. They remain terminal replay facts and can never
                    // be used to authorize a new prompt dispatch.
                    parent_session_id: if count >= 27 { field(payload, "parentSessionID")? } else { String::new() },
                    session_id: if count == 28 { field(payload, "sessionID")? } else { String::new() },
                    attempt_id: field(payload, "attemptId")?,
                    expected_managed_revision: decimal_u64(payload, "expectedManagedRevision")?,
                    handoff_id: field(payload, "handoffID")?,
                    handoff_digest: required_blake3(payload, "handoffDigest")?,
                    claimed_proof_digest: required_blake3(payload, "claimedProofDigest")?,
                    claimed_attempt_id: field(payload, "claimedAttemptID")?,
                    worker_execution_id: field(payload, "workerExecutionID")?,
                    claimed_binding_digest: required_blake3(payload, "claimedBindingDigest")?,
                    pins_digest: required_blake3(payload, "pinsDigest")?,
                    claim_owner_log_id: field(payload, "claimOwnerLogID")?,
                    claim_owner_log_sequence: decimal_u64(payload, "claimOwnerLogSequence")?,
                    claim_owner_log_event_digest: required_blake3(payload, "claimOwnerLogEventDigest")?,
                    worker_pool_revision: decimal_u64(payload, "workerPoolRevision")?,
                    claim_nonce: required_blake3(payload, "claimNonce")?,
                    attached_binding_digest: required_blake3(payload, "attachedBindingDigest")?,
                    owner_epoch: decimal_u64(payload, "ownerEpoch")?,
                    process_incarnation: field(payload, "processIncarnation")?,
                    core_pid: payload.get("corePID").and_then(Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                        .filter(|value| *value > 0)
                        .ok_or(ManagedError::Invalid("authenticated Core PID is invalid"))?,
                    core_start_identity: decimal_u64(payload, "coreStartIdentity")?,
                    core_uid: payload.get("coreUID").and_then(Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                        .ok_or(ManagedError::Invalid("authenticated Core UID is invalid"))?,
                    core_gid: payload.get("coreGID").and_then(Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                        .ok_or(ManagedError::Invalid("authenticated Core GID is invalid"))?,
                    core_executable_digest: required_blake3(payload, "coreExecutableDigest")?,
                    delivery_id: field(payload, "deliveryID")?,
                },
            },
            "managed_dispatch_quiesced" if count == 16 => Self::DispatchQuiesced {
                proof: ManagedDispatchQuiescenceProofV1 {
                    goal_id: field(payload, "goalId")?,
                    run_id: field(payload, "runId")?,
                    task_id: field(payload, "taskId")?,
                    parent_session_id: field(payload, "parentSessionID")?,
                    session_id: field(payload, "sessionID")?,
                    attempt_id: field(payload, "attemptId")?,
                    handoff_id: field(payload, "handoffID")?,
                    handoff_digest: required_blake3(payload, "handoffDigest")?,
                    consume_delivery_id: field(payload, "consumeDeliveryID")?,
                    consume_receipt_digest: required_blake3(payload, "consumeReceiptDigest")?,
                    owner_epoch: decimal_u64(payload, "ownerEpoch")?,
                    process_incarnation: field(payload, "processIncarnation")?,
                    child_session_sequence: decimal_u64(payload, "childSessionSequence")?,
                    child_session_event_digest: required_blake3(payload, "childSessionEventDigest")?,
                    child_session_state_digest: required_blake3(payload, "childSessionStateDigest")?,
                    delivery_id: field(payload, "deliveryID")?,
                },
            },
            "pre_admission_candidate_abandoned" if count == 22 => {
                let expected_task_generation = decimal_u64(payload, "expectedTaskGeneration")?;
                if expected_task_generation == u64::MAX {
                    return Err(ManagedError::Invalid("candidate generation overflow"));
                }
                Self::AbandonPreAdmissionCandidate {
                    proof: ManagedCandidateAbandonProofV1 {
                        goal_id: field(payload, "goalId")?,
                        run_id: field(payload, "runId")?,
                        task_id: field(payload, "taskId")?,
                        candidate_attempt_id: field(payload, "candidateAttemptID")?,
                        worker_execution_id: field(payload, "workerExecutionID")?,
                        ticket_id: field(payload, "ticketID")?,
                        expected_managed_revision: decimal_u64(payload, "expectedManagedRevision")?,
                        expected_task_generation,
                        expected_attempt_count: decimal_u64(payload, "expectedAttemptCount")?
                            .try_into().map_err(|_| ManagedError::Invalid("Task attempt count is invalid"))?,
                        task_revision: decimal_u64(payload, "taskRevision")?,
                        pins_digest: required_blake3(payload, "pinsDigest")?,
                        disposition: managed_candidate_disposition_decode(&field(payload, "disposition")?)?,
                        terminal_state: managed_candidate_terminal_decode(&field(payload, "terminalState")?)?,
                        tombstone_owner_log_id: field(payload, "tombstoneOwnerLogID")?,
                        tombstone_owner_log_sequence: decimal_u64(payload, "tombstoneOwnerLogSequence")?,
                        tombstone_owner_log_event_digest: required_blake3(payload, "tombstoneOwnerLogEventDigest")?,
                        worker_pool_revision: decimal_u64(payload, "workerPoolRevision")?,
                        reconciliation_proof_digest: required_blake3(payload, "reconciliationProofDigest")?,
                        p8_receipt_digest: required_blake3(payload, "p8ReceiptDigest")?,
                        owner_epoch: decimal_u64(payload, "ownerEpoch")?,
                        process_incarnation: field(payload, "processIncarnation")?,
                        delivery_id: field(payload, "deliveryID")?,
                    },
                }
            }
            "attempt_effect_bound" if count == 6 => Self::BindAttemptEffect {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                effect_id: field(payload, "effectId")?,
                location_id: field(payload, "locationId")?,
                session_id: field(payload, "sessionId")?,
            },
            "attempt_effects_bound" if count == 6 => Self::BindAttemptEffects {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                effect_ids: list(payload, "effectIds")?,
                location_id: field(payload, "locationId")?,
                session_id: field(payload, "sessionId")?,
            },
            "attempt_verifier_intent_bound" if count == 21 => Self::BindAttemptVerifierIntent {
                intent: ManagedAttemptVerifierIntentV1 {
                    goal_id: field(payload, "goalId")?,
                    run_id: field(payload, "runId")?,
                    task_id: field(payload, "taskId")?,
                    attempt_id: field(payload, "attemptId")?,
                    effect_id: field(payload, "effectId")?,
                    reviewer_principal: field(payload, "reviewerPrincipal")?,
                    verifier_principal: field(payload, "verifierPrincipal")?,
                    owner_epoch: decimal_u64(payload, "ownerEpoch")?,
                    bound_revision: decimal_u64(payload, "boundRevision")?,
                    location_id: field(payload, "locationId")?,
                    session_id: field(payload, "sessionId")?,
                    capability_id: field(payload, "capabilityId")?,
                    verifier_profile_id: field(payload, "verifierProfileId")?,
                    executable_digest: field(payload, "executableDigest")?,
                    profile_digest: field(payload, "profileDigest")?,
                    criterion_id: field(payload, "criterionId")?,
                    test_identity: field(payload, "testIdentity")?,
                    arguments_digest: field(payload, "argumentsDigest")?,
                    source_workspace_revision: field(payload, "sourceWorkspaceRevision")?,
                    max_duration_ms: decimal_u64(payload, "maxDurationMs")?,
                    max_output_bytes: decimal_u64(payload, "maxOutputBytes")?,
                },
            },
            "attempt_effect_receipt_recorded" if count == 16 => {
                Self::RecordAttemptEffectReceipt { proof: receipt_proof(payload)? }
            }
            "attempt_effect_receipt_reconciled" if count == 16 => {
                Self::ReconcileAttemptEffectReceipt { proof: receipt_proof(payload)? }
            }
            "attempt_verifier_evidence_recorded" if count == 2 => Self::RecordAttemptVerifierEvidence {
                attempt_id: field(payload, "attemptId")?,
                evidence: decode_verification_evidence(
                    payload.get("evidence").ok_or(ManagedError::Invalid("Attempt verifier evidence missing"))?,
                )?,
            },
            "attempt_executing" if count == 3 => Self::StartAttempt {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
            },
            "attempt_settling" if count == 3 => Self::BeginAttemptSettlement {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
            },
            "attempt_succeeded" if count == 4 => Self::SettleAttempt {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                receipt_digest: field(payload, "receiptDigest")?,
            },
            "attempt_failure_settled" if count == 6 => Self::SettleAttemptFailure {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                failure_code: field(payload, "failureCode")?,
                retryable: payload
                    .get("retryable")
                    .and_then(Value::as_bool)
                    .ok_or(ManagedError::Invalid("attempt retry class is invalid"))?,
                receipt_digest: optional_string(payload, "receiptDigest")?,
            },
            "attempt_unknown" if count == 3 => Self::MarkAttemptUnknown {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
            },
            "attempt_failed" if count == 5 => Self::FailAttempt {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                failure_code: field(payload, "failureCode")?,
                retryable: payload
                    .get("retryable")
                    .and_then(Value::as_bool)
                    .ok_or(ManagedError::Invalid("attempt retry class is invalid"))?,
            },
            "task_passed" if count == 6 => Self::VerifyTask {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                verifier_id: field(payload, "verifierId")?,
                source_revision: field(payload, "sourceRevision")?,
                evidence_digest: field(payload, "evidenceDigest")?,
            },
            "run_verifying" if count == 3 => Self::BeginVerification {
                run_id: field(payload, "runId")?,
                final_revision: field(payload, "finalRevision")?,
                verifier_id: field(payload, "verifierId")?,
            },
            "run_verifying" if count == 4 => Self::BeginVerificationWithReceiptBasis {
                run_id: field(payload, "runId")?,
                final_revision: field(payload, "finalRevision")?,
                verifier_id: field(payload, "verifierId")?,
                receipt_basis_digest: field(payload, "receiptBasisDigest")?,
            },
            "session_link_attached" if count == 2 => Self::AttachSessionLink {
                run_id: field(payload, "runId")?,
                link: decode_session_link(
                    payload
                        .get("sessionLink")
                        .ok_or(ManagedError::Invalid("SessionLink payload missing"))?,
                )?,
            },
            "evidence_accepted" if count == 5 => Self::RecordCriterionEvidence {
                run_id: field(payload, "runId")?,
                criterion_id: field(payload, "criterionId")?,
                source_revision: field(payload, "sourceRevision")?,
                evidence_digest: field(payload, "evidenceDigest")?,
                verifier_id: field(payload, "verifierId")?,
            },
            "verification_evidence_recorded" if count == 2 => Self::RecordVerificationEvidence {
                run_id: field(payload, "runId")?,
                evidence: decode_verification_evidence(
                    payload
                        .get("evidence")
                        .ok_or(ManagedError::Invalid("verification evidence is missing"))?,
                )?,
            },
            "run_succeeded" if count == 2 => Self::FinalizeRun {
                run_id: field(payload, "runId")?,
                final_revision: field(payload, "finalRevision")?,
            },
            "run_needs_you" if count == 1 => Self::NeedsYou {
                run_id: field(payload, "runId")?,
            },
            "run_paused" if count == 1 => Self::PauseRun {
                run_id: field(payload, "runId")?,
            },
            "run_resumed" if count == 1 => Self::ResumeRun {
                run_id: field(payload, "runId")?,
            },
            "run_cancelling" if count == 1 => Self::RequestCancel {
                run_id: field(payload, "runId")?,
            },
            "run_cancelled" if count == 1 => Self::CompleteCancel {
                run_id: field(payload, "runId")?,
            },
            "run_failed" if count == 2 => Self::FailRun {
                run_id: field(payload, "runId")?,
                failure_code: field(payload, "failureCode")?,
            },
            _ => {
                return Err(ManagedError::Invalid(
                    "unknown managed event kind or fields",
                ));
            }
        };
        Ok(command)
    }
}

fn effect_outcome_name(outcome: AttemptEffectOutcomeV1) -> &'static str {
    match outcome {
        AttemptEffectOutcomeV1::Succeeded => "SUCCEEDED",
        AttemptEffectOutcomeV1::Failed => "FAILED",
        AttemptEffectOutcomeV1::Unknown => "UNKNOWN",
    }
}

fn verifier_intent_value(intent: &ManagedAttemptVerifierIntentV1) -> Value {
    json!({
        "goalId": intent.goal_id,
        "runId": intent.run_id,
        "taskId": intent.task_id,
        "attemptId": intent.attempt_id,
        "effectId": intent.effect_id,
        "reviewerPrincipal": intent.reviewer_principal,
        "verifierPrincipal": intent.verifier_principal,
        "ownerEpoch": intent.owner_epoch.to_string(),
        "boundRevision": intent.bound_revision.to_string(),
        "locationId": intent.location_id,
        "sessionId": intent.session_id,
        "capabilityId": intent.capability_id,
        "verifierProfileId": intent.verifier_profile_id,
        "executableDigest": intent.executable_digest,
        "profileDigest": intent.profile_digest,
        "criterionId": intent.criterion_id,
        "testIdentity": intent.test_identity,
        "argumentsDigest": intent.arguments_digest,
        "sourceWorkspaceRevision": intent.source_workspace_revision,
        "maxDurationMs": intent.max_duration_ms.to_string(),
        "maxOutputBytes": intent.max_output_bytes.to_string(),
    })
}

fn effect_receipt_proof_value(proof: &ManagedAttemptEffectReceiptProofV1) -> Value {
    json!({
        "goalId": proof.goal_id,
        "runId": proof.run_id,
        "taskId": proof.task_id,
        "attemptId": proof.attempt_id,
        "effectId": proof.effect_id,
        "executorPrincipal": proof.executor_principal,
        "ownerEpoch": proof.owner_epoch.to_string(),
        "boundRevision": proof.bound_revision.to_string(),
        "locationId": proof.location_id,
        "sessionId": proof.session_id,
        "capabilityId": proof.capability_id,
        "capabilityLeaseDigest": proof.capability_lease_digest,
        "outcome": effect_outcome_name(proof.outcome),
        "targetReceiptDigest": proof.target_receipt_digest,
        "beforeWorkspaceRevision": proof.before_workspace_revision,
        "afterWorkspaceRevision": proof.after_workspace_revision,
    })
}

/// Bounded Attempt-to-effect edges. The P2 single Attempt owns one bounded
/// ToolBatch; a larger fan-out needs the worker/lease gates.
pub const MAX_BOUND_EFFECTS_PER_ATTEMPT: usize = 64;

/// Kernel-computed BLAKE3 receipt over the reconciled bound-effect receipts of one
/// Attempt. Length-prefixed fields make the digest unambiguous; the same durable
/// facts always reproduce the same receipt, and a caller cannot forge it because the
/// ingress recomputes it from authoritative target receipts.
pub fn attempt_receipt_digest(
    goal_id: &str,
    attempt: &AttemptRecord,
    settled: &[(String, String)],
) -> String {
    let mut preimage = Vec::with_capacity(256);
    let mut extend = |value: &str| {
        preimage.extend_from_slice(&(value.len() as u32).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    };
    extend(goal_id);
    extend(&attempt.run_id);
    extend(&attempt.task_id);
    extend(&attempt.executor_principal);
    extend(&attempt.effects.len().to_string());
    for (effect_id, receipt_digest) in settled {
        extend(effect_id);
        extend(receipt_digest);
    }
    format!("blake3:{}", blake3::hash(&preimage).to_hex())
}

/// Returns the workspace head immediately before one exact bound effect. The
/// ordered Attempt effect list is the sole lineage: coding receipts must advance
/// from the current head, while verifier effects must prove a read-only
/// before==after observation. During intent staging, earlier verifier intents may
/// be present without receipts because no dispatch is permitted until the full
/// criterion set is bound. Receipt admission uses `allow_unsettled_verifiers =
/// false`, so every preceding edge must already be terminal and reconciled.
fn attempt_workspace_revision_before(
    attempt: &AttemptRecord,
    effect_id: &str,
    allow_unsettled_verifiers: bool,
) -> Result<String, ManagedError> {
    let mut head = attempt.workspace_revision.clone()
        .ok_or(ManagedError::Conflict("Attempt admission workspace revision is missing"))?;
    let mut saw_verifier = false;
    for effect in &attempt.effects {
        if effect.effect_id == effect_id {
            return Ok(head);
        }
        if let Some(intent) = attempt.verifier_intents.get(&effect.effect_id) {
            saw_verifier = true;
            if intent.source_workspace_revision != head {
                return Err(ManagedError::Conflict("verifier intent does not match ordered workspace lineage"));
            }
            match attempt.effect_receipts.get(&effect.effect_id) {
                Some(receipt)
                    if matches!(receipt.outcome, AttemptEffectOutcomeV1::Succeeded | AttemptEffectOutcomeV1::Failed)
                        && receipt.before_workspace_revision == head
                        && receipt.after_workspace_revision.as_deref() == Some(head.as_str()) => {}
                None if allow_unsettled_verifiers => {}
                _ => return Err(ManagedError::Conflict("prior verifier effect is unresolved or changed the workspace")),
            }
        } else {
            if saw_verifier {
                return Err(ManagedError::Conflict("coding effect appears after verifier effects in Attempt lineage"));
            }
            let receipt = attempt.effect_receipts.get(&effect.effect_id)
                .ok_or(ManagedError::Conflict("prior coding effect receipt is missing"))?;
            if receipt.outcome != AttemptEffectOutcomeV1::Succeeded
                || receipt.before_workspace_revision != head
            {
                return Err(ManagedError::Conflict("prior coding effect is not a successful contiguous workspace edge"));
            }
            head = receipt.after_workspace_revision.clone()
                .ok_or(ManagedError::Conflict("prior coding effect has no observed workspace revision"))?;
        }
    }
    Err(ManagedError::Conflict("workspace lineage effect edge is missing"))
}

/// Computes the current head for a still-live coding Attempt before independent
/// verifier intents are appended. Every coding edge must have one successful
/// receipt and form a contiguous before/after chain from admission revision.
fn live_coding_workspace_head(attempt: &AttemptRecord) -> Result<String, ManagedError> {
    if attempt.phase != AttemptPhase::Executing
        || attempt.effects.is_empty()
        || !attempt.verifier_intents.is_empty()
        || attempt.effects.len() != attempt.effect_receipts.len()
    {
        return Err(ManagedError::Conflict(
            "live verification requires a complete executing coding Attempt",
        ));
    }
    let mut head = attempt.workspace_revision.clone().ok_or(ManagedError::Conflict(
        "Attempt admission workspace revision is missing",
    ))?;
    for effect in &attempt.effects {
        let receipt = attempt.effect_receipts.get(&effect.effect_id).ok_or(
            ManagedError::Conflict("coding effect receipt is missing"),
        )?;
        if receipt.outcome != AttemptEffectOutcomeV1::Succeeded
            || receipt.before_workspace_revision != head
        {
            return Err(ManagedError::Conflict(
                "coding effect receipt chain is failed, unresolved, or non-contiguous",
            ));
        }
        head = receipt.after_workspace_revision.clone().ok_or(
            ManagedError::Conflict("coding effect has no observed after revision"),
        )?;
    }
    Ok(head)
}

/// A process restart may retain an active Attempt only in VERIFYING, after the
/// final revision and verifier assignment are durable. It may resume the exact
/// verifier challenge only before any verifier intent exists, or complete local
/// settlement after typed evidence and every receipt are durable. Terminal
/// process digests alone cannot reconstruct verifier output/artifacts. The
/// persisted owner epoch remains unchanged; this never renews a lease.
fn restart_recoverable_live_verification(
    run_id: &str,
    run: &Run,
    attempts: &BTreeMap<String, AttemptRecord>,
) -> bool {
    if run.tasks.len() != 1 {
        return false;
    }
    let Some((task_id, task)) = run.tasks.iter().next() else {
        return false;
    };
    if task.unknown_effect
        || task.verified_revision.is_some()
        || task.verification_evidence.is_some()
        || !task.failed_criterion_ids.is_empty()
    {
        return false;
    }
    let Some(attempt_id) = task.active_attempt.as_deref() else {
        return false;
    };
    let Some(attempt) = attempts.get(attempt_id) else {
        return false;
    };
    if attempt.run_id != run_id
        || attempt.task_id != *task_id
        || attempt.owner_epoch == 0
        || attempt.delegation_binding.is_none()
        || task.pending_verification_attempt.as_deref() != Some(attempt_id)
        || run.phase != RunPhase::Verifying
        || run.final_revision.is_none()
        || run.final_revision.as_deref().is_none_or(|revision| managed_digest(revision).is_err())
        || run.verifier_id.is_none()
        || run.verification_evidence.is_some()
        || !run.criterion_evidence.is_empty()
    {
        return false;
    }
    let final_revision = run.final_revision.as_deref().expect("checked frozen revision");
    let verifier_id = run.verifier_id.as_deref().expect("checked verifier assignment");
    match attempt.phase {
        AttemptPhase::Executing => {
            attempt.verifier_intents.is_empty()
                && attempt.verifier_evidence.is_none()
                && live_coding_workspace_head(attempt).ok().as_deref() == Some(final_revision)
        }
        AttemptPhase::Settling => {
            let Some(evidence) = attempt.verifier_evidence.as_ref() else {
                return false;
            };
            if attempt.receipt_digest.is_some()
                || evidence.evidence_digest != verification_evidence_digest(evidence)
                || evidence.source_revision != final_revision
                || evidence.verifier_id != verifier_id
                || evidence.profile.owner_epoch != attempt.owner_epoch
                || attempt.effects.is_empty()
                || attempt.effects.len() != attempt.effect_receipts.len()
            {
                return false;
            }
            let task_criteria = task.criterion_ids.iter().map(String::as_str).collect::<BTreeSet<_>>();
            let evidence_criteria = evidence.criteria.iter().map(|criterion| criterion.criterion_id.as_str()).collect::<BTreeSet<_>>();
            if task_criteria.is_empty()
                || task_criteria.len() != task.criterion_ids.len()
                || task_criteria != evidence_criteria
                || attempt.verifier_intents.len() != evidence.criteria.len()
            {
                return false;
            }
            let mut seen_criteria = BTreeSet::new();
            let mut coding_head = match attempt.workspace_revision.as_deref() {
                Some(revision) => revision,
                None => return false,
            };
            let mut verifier_stage = false;
            for effect in &attempt.effects {
                let Some(receipt) = attempt.effect_receipts.get(&effect.effect_id) else {
                    return false;
                };
                if receipt.owner_epoch != attempt.owner_epoch
                    || receipt.target_receipt_digest.is_none()
                    || receipt.outcome == AttemptEffectOutcomeV1::Unknown
                    || receipt.after_workspace_revision.is_none()
                {
                    return false;
                }
                if let Some(intent) = attempt.verifier_intents.get(&effect.effect_id) {
                    verifier_stage = true;
                    let Some(after_revision) = receipt.after_workspace_revision.as_deref() else {
                        return false;
                    };
                    if intent.run_id != run_id
                        || intent.task_id != *task_id
                        || intent.attempt_id != attempt_id
                        || intent.verifier_principal != verifier_id
                        || intent.owner_epoch != attempt.owner_epoch
                        || intent.verifier_profile_id != evidence.profile.profile_id
                        || intent.executable_digest != evidence.profile.executable_digest
                        || intent.profile_digest != evidence.profile.profile_digest
                        || intent.source_workspace_revision != final_revision
                        || !seen_criteria.insert(intent.criterion_id.as_str())
                        || !evidence.criteria.iter().any(|criterion| {
                            criterion.criterion_id == intent.criterion_id
                                && criterion.test_identity == intent.test_identity
                        })
                        || coding_head != final_revision
                        || receipt.before_workspace_revision != final_revision
                        || after_revision != final_revision
                    {
                        return false;
                    }
                } else {
                    if verifier_stage
                        || receipt.outcome != AttemptEffectOutcomeV1::Succeeded
                        || receipt.before_workspace_revision != coding_head
                    {
                        return false;
                    }
                    let Some(after_revision) = receipt.after_workspace_revision.as_deref() else {
                        return false;
                    };
                    coding_head = after_revision;
                }
            }
            coding_head == final_revision && seen_criteria == task_criteria
        }
        _ => false,
    }
}

/// Kernel-computed final Revision for one Run's verification phase: the ordered,
/// verified Task/Attempt receipt facts plus the accepted SpecVersion digest. The
/// verifier binds criteria and evidence to exactly this revision.
pub fn final_revision_digest(
    goal_id: &str,
    run_id: &str,
    spec_digest: &str,
    run: &Run,
    attempts: &BTreeMap<String, AttemptRecord>,
) -> String {
    let mut preimage = Vec::with_capacity(256);
    let mut extend = |value: &str| {
        preimage.extend_from_slice(&(value.len() as u32).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    };
    extend(goal_id);
    extend(run_id);
    extend(spec_digest);
    for (task_id, task) in &run.tasks {
        extend(task_id);
        let attempt_id = task
            .pending_verification_attempt
            .as_deref()
            .or_else(|| {
                task.verification_evidence
                    .as_ref()
                    .map(|evidence| evidence.attempt_id.as_str())
            })
            .unwrap_or("");
        extend(attempt_id);
        extend(
            attempts
                .get(attempt_id)
                .and_then(|attempt| attempt.receipt_digest.as_deref())
                .unwrap_or(""),
        );
    }
    format!("blake3:{}", blake3::hash(&preimage).to_hex())
}

/// Canonical receipt basis for the Attempt currently selected by each Task in a
/// Run. V1 verifies while its single coding Attempt remains EXECUTING; historical
/// settled-attempt runs remain readable for OwnerLog replay compatibility.
pub fn successful_task_receipt_basis_digest(
    run_id: &str,
    run: &Run,
    attempts: &BTreeMap<String, AttemptRecord>,
) -> Result<String, ManagedError> {
    if run.tasks.is_empty() {
        return Err(ManagedError::Conflict(
            "verification receipt basis has no Tasks",
        ));
    }

    let has_live_attempt = run.tasks.values().any(|task| task.active_attempt.is_some());
    if has_live_attempt && run.tasks.values().filter(|task| task.active_attempt.is_some()).count() != 1 {
        return Err(ManagedError::Conflict(
            "live verification requires exactly one active coding Attempt",
        ));
    }
    let mut preimage = if has_live_attempt {
        b"horizoncode.managed-live-verification-receipt-basis.v1\0".to_vec()
    } else {
        b"horizoncode.managed-verification-receipt-basis.v1\0".to_vec()
    };
    let mut extend = |value: &str| {
        preimage.extend_from_slice(&(value.len() as u32).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    };
    extend(run_id);
    extend(&run.tasks.len().to_string());
    for (task_id, task) in &run.tasks {
        if task.unknown_effect {
            return Err(ManagedError::Conflict(
                "verification receipt basis contains an UNKNOWN Task",
            ));
        }
        if has_live_attempt {
            let attempt_id = task.active_attempt.as_deref().ok_or(ManagedError::Conflict(
                "live verification requires exactly one active Task Attempt",
            ))?;
            if task.pending_verification_attempt.as_deref().is_some_and(|pending| pending != attempt_id)
                || task.verified_revision.is_some()
            {
                return Err(ManagedError::Conflict(
                    "live verification Task already has settled verification state",
                ));
            }
            let attempt = attempts.get(attempt_id).ok_or(ManagedError::Conflict(
                "live verification Attempt is missing",
            ))?;
            if attempt.run_id != run_id || attempt.task_id != *task_id {
                return Err(ManagedError::Conflict(
                    "live verification Attempt belongs to another Task or Run",
                ));
            }
            let head = live_coding_workspace_head(attempt)?;
            extend(task_id);
            extend(attempt_id);
            extend(&head);
            for effect in &attempt.effects {
                let receipt = attempt.effect_receipts.get(&effect.effect_id).expect("live coding chain validated");
                extend(&effect.effect_id);
                extend(receipt.target_receipt_digest.as_deref().ok_or(ManagedError::Conflict(
                    "coding effect receipt has no target digest",
                ))?);
                extend(&receipt.before_workspace_revision);
                extend(receipt.after_workspace_revision.as_deref().expect("live coding chain validated"));
            }
            continue;
        }
        if task.active_attempt.is_some() {
            return Err(ManagedError::Conflict(
                "verification receipt basis mixes active and settled Tasks",
            ));
        }
        let evidence_attempt_id = task
            .verification_evidence
            .as_ref()
            .map(|evidence| evidence.attempt_id.as_str());
        if task
            .pending_verification_attempt
            .as_deref()
            .zip(evidence_attempt_id)
            .is_some_and(|(pending, verified)| pending != verified)
        {
            return Err(ManagedError::Conflict(
                "verification receipt basis has conflicting Task Attempt references",
            ));
        }
        let attempt_id = task
            .pending_verification_attempt
            .as_deref()
            .or(evidence_attempt_id)
            .ok_or(ManagedError::Conflict(
                "verification receipt basis has a Task without a settled Attempt",
            ))?;
        let attempt = attempts.get(attempt_id).ok_or(ManagedError::Conflict(
            "verification receipt basis Attempt is missing",
        ))?;
        if attempt.run_id != run_id
            || attempt.task_id != *task_id
            || attempt.phase != AttemptPhase::Succeeded
        {
            return Err(ManagedError::Conflict(
                "verification receipt basis Attempt is stale or unsettled",
            ));
        }
        let receipt_digest = attempt
            .receipt_digest
            .as_deref()
            .ok_or(ManagedError::Conflict(
                "verification receipt basis has no settled receipt",
            ))?;
        blake3_digest(receipt_digest)?;
        extend(task_id);
        extend(attempt_id);
        extend(receipt_digest);
    }
    Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
}

/// Kernel-computed verification binding for one settled Attempt on the frozen final
/// Revision. Binds the Attempt's authoritative target receipt, the Task identity, the
/// revision and the authenticated independent verifier.
pub fn task_verification_digest(
    goal_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    receipt_digest: &str,
    final_revision: &str,
    verifier_id: &str,
) -> String {
    let mut preimage = Vec::with_capacity(256);
    for field in [
        goal_id,
        run_id,
        task_id,
        attempt_id,
        receipt_digest,
        final_revision,
        verifier_id,
    ] {
        preimage.extend_from_slice(&(field.len() as u32).to_be_bytes());
        preimage.extend_from_slice(field.as_bytes());
    }
    format!("blake3:{}", blake3::hash(&preimage).to_hex())
}

/// Kernel-computed verification binding for one accepted criterion on one final
/// Revision: the criterion, revision, independent verifier identity and the ordered
/// verified Task evidence facts. Callers cannot supply this digest.
pub fn criterion_evidence_digest(
    goal_id: &str,
    run_id: &str,
    criterion_id: &str,
    final_revision: &str,
    verifier_id: &str,
    run: &Run,
    attempts: &BTreeMap<String, AttemptRecord>,
) -> String {
    let mut preimage = Vec::with_capacity(256);
    let mut extend = |value: &str| {
        preimage.extend_from_slice(&(value.len() as u32).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    };
    extend(goal_id);
    extend(run_id);
    extend(criterion_id);
    extend(final_revision);
    extend(verifier_id);
    for (task_id, task) in &run.tasks {
        if !task.criterion_ids.iter().any(|id| id == criterion_id) {
            continue;
        }
        extend(task_id);
        let attempt_id = task
            .pending_verification_attempt
            .as_deref()
            .or_else(|| {
                task.verification_evidence
                    .as_ref()
                    .map(|evidence| evidence.attempt_id.as_str())
            })
            .unwrap_or("");
        extend(attempt_id);
        extend(
            attempts
                .get(attempt_id)
                .and_then(|attempt| attempt.receipt_digest.as_deref())
                .unwrap_or(""),
        );
        // The independent verification of this Task must already be bound to the
        // frozen revision before its criterion can carry evidence.
        extend(
            task.verification_evidence
                .as_ref()
                .map(|evidence| evidence.evidence_digest.as_str())
                .unwrap_or(""),
        );
    }
    format!("blake3:{}", blake3::hash(&preimage).to_hex())
}

/// Kernel-computed canonical binding for a complete independent verifier result.
/// Ordered criteria and exact artifact references are included so omission,
/// substitution, verdict edits, or test-run changes alter the digest.
pub fn verification_evidence_digest(evidence: &VerificationEvidenceV1) -> String {
    let mut preimage = Vec::with_capacity(512);
    let mut extend = |value: &str| {
        preimage.extend_from_slice(&(value.len() as u32).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    };
    extend(&evidence.verification_run_id);
    extend(&evidence.verifier_id);
    extend(&evidence.source_revision);
    extend(&evidence.profile.profile_id);
    extend(&evidence.profile.owner_epoch.to_string());
    extend(&evidence.profile.executable_digest);
    extend(&evidence.profile.profile_digest);
    extend(&evidence.aggregate_output_bytes.to_string());
    extend(&evidence.aggregate_duration_ms.to_string());
    for criterion in &evidence.criteria {
        extend(&criterion.criterion_id);
        extend(match criterion.verdict {
            VerificationVerdictV1::Pass => "PASS",
            VerificationVerdictV1::Fail => "FAIL",
        });
        extend(&criterion.test_identity);
        extend(&criterion.test_run_id);
        extend(&criterion.process.execution_id);
        extend(&criterion.process.generation.to_string());
        extend(&criterion.process.exit_code.to_string());
        extend(&criterion.process.stdout_digest);
        extend(&criterion.process.stderr_digest);
        extend(&criterion.process.output_bytes.to_string());
        extend(&criterion.process.duration_ms.to_string());
        extend(if criterion.process.truncated {
            "TRUNCATED"
        } else {
            "COMPLETE"
        });
        for reference in &criterion.artifact_refs {
            extend(&reference.artifact_id);
            extend(&reference.digest);
            extend(&reference.byte_length);
            extend(&reference.media_type);
            extend(match reference.classification {
                ArtifactClassificationV1::Public => "PUBLIC",
                ArtifactClassificationV1::Workspace => "WORKSPACE",
                ArtifactClassificationV1::Sensitive => "SENSITIVE",
            });
        }
    }
    format!("blake3:{}", blake3::hash(&preimage).to_hex())
}

/// Task-local projection of the full verifier result. The run evidence digest
/// commits every verdict, process observation and ArtifactRef; the task and its
/// accepted criterion subset make this edge independently addressable.
fn task_typed_verification_digest(
    task_id: &str,
    attempt_id: &str,
    receipt_digest: &str,
    criterion_ids: &[String],
    evidence: &VerificationEvidenceV1,
) -> String {
    let mut preimage = b"horizoncode.task-verification-evidence.v1\0".to_vec();
    let mut extend = |value: &str| {
        preimage.extend_from_slice(&(value.len() as u32).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    };
    extend(task_id);
    extend(attempt_id);
    extend(receipt_digest);
    extend(&evidence.source_revision);
    extend(&evidence.verifier_id);
    extend(&evidence.evidence_digest);
    let mut sorted = criterion_ids.to_vec();
    sorted.sort();
    for criterion_id in sorted {
        extend(&criterion_id);
    }
    format!("blake3:{}", blake3::hash(&preimage).to_hex())
}

fn id(value: &str) -> Result<(), ManagedError> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(ManagedError::Invalid("invalid managed identifier"));
    }
    Ok(())
}

/// Durable owner-log existence probe that never allocates and never opens a lock.
fn owner_head_exists(root: &Path, kind: &str, id_value: &str) -> bool {
    let Ok(owner) = OwnerIdentity::new(kind.to_owned(), id_value.to_owned()) else {
        return false;
    };
    let head = root
        .join("owners")
        .join(owner.directory_key())
        .join("head.json");
    matches!(std::fs::symlink_metadata(&head), Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink())
}

fn principal(value: &str) -> Result<(), ManagedError> {
    if value.is_empty() || value.len() > 256 || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(ManagedError::Invalid("invalid managed principal"));
    }
    Ok(())
}

fn nonempty_text(value: &str, max_bytes: usize, field: &'static str) -> Result<(), ManagedError> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(ManagedError::Invalid(field));
    }
    Ok(())
}

fn logical_command_digest(kind: &str, data: &Value) -> String {
    // Idempotency identifies the logical operation, independent of the
    // timestamp in OwnerLog's separately authenticated physical envelope.
    let command = json!({"kind": kind, "data": data});
    format!(
        "blake3:{}",
        blake3::hash(command.to_string().as_bytes()).to_hex()
    )
}

fn digest(value: &str) -> Result<(), ManagedError> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err(ManagedError::Invalid("invalid managed digest"));
    }
    Ok(())
}

/// A revision or evidence digest produced by the trusted ingress. Source revisions
/// and kernel-computed verification bindings are BLAKE3; a client-supplied
/// SpecVersion source digest remains `sha256:`. Both are canonical lowercase.
fn managed_digest(value: &str) -> Result<(), ManagedError> {
    if value.len() != 71
        || !(value.starts_with("sha256:") || value.starts_with("blake3:"))
        || !value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(ManagedError::Invalid("invalid managed digest"));
    }
    Ok(())
}

fn managed_candidate_disposition_wire(
    value: crate::worker_durable::ManagedReservationReconciliationDispositionV1,
) -> &'static str {
    match value {
        crate::worker_durable::ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch => "NOT_ADMITTED_NO_DISPATCH",
        crate::worker_durable::ManagedReservationReconciliationDispositionV1::TerminalNoEffect => "TERMINAL_NO_EFFECT",
    }
}

fn managed_candidate_disposition_decode(
    value: &str,
) -> Result<crate::worker_durable::ManagedReservationReconciliationDispositionV1, ManagedError> {
    match value {
        "NOT_ADMITTED_NO_DISPATCH" => Ok(crate::worker_durable::ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch),
        "TERMINAL_NO_EFFECT" => Ok(crate::worker_durable::ManagedReservationReconciliationDispositionV1::TerminalNoEffect),
        _ => Err(ManagedError::Invalid("candidate reconciliation disposition is invalid")),
    }
}

fn managed_candidate_terminal_wire(value: crate::resource_budget::ReservationState) -> &'static str {
    match value {
        crate::resource_budget::ReservationState::Proposed => "PROPOSED",
        crate::resource_budget::ReservationState::Reserved => "RESERVED",
        crate::resource_budget::ReservationState::Claimed => "CLAIMED",
        crate::resource_budget::ReservationState::ReleasePending => "RELEASE_PENDING",
        crate::resource_budget::ReservationState::Quarantined => "QUARANTINED",
        crate::resource_budget::ReservationState::Released => "RELEASED",
        crate::resource_budget::ReservationState::Expired => "EXPIRED",
    }
}

fn managed_candidate_terminal_decode(value: &str) -> Result<crate::resource_budget::ReservationState, ManagedError> {
    match value {
        "PROPOSED" => Ok(crate::resource_budget::ReservationState::Proposed),
        "RESERVED" => Ok(crate::resource_budget::ReservationState::Reserved),
        "CLAIMED" => Ok(crate::resource_budget::ReservationState::Claimed),
        "RELEASE_PENDING" => Ok(crate::resource_budget::ReservationState::ReleasePending),
        "QUARANTINED" => Ok(crate::resource_budget::ReservationState::Quarantined),
        "RELEASED" => Ok(crate::resource_budget::ReservationState::Released),
        "EXPIRED" => Ok(crate::resource_budget::ReservationState::Expired),
        _ => Err(ManagedError::Invalid("candidate reconciliation terminal state is invalid")),
    }
}

fn managed_task_attempt_candidate_id(task_id: &str, attempt_count: u16, candidate_generation: u64) -> String {
    let mut bytes = b"horizoncode.managed-task-attempt-candidate.v1\0".to_vec();
    bytes.extend_from_slice(&(task_id.len() as u64).to_be_bytes());
    bytes.extend_from_slice(task_id.as_bytes());
    bytes.extend_from_slice(&u64::from(attempt_count).to_be_bytes());
    bytes.extend_from_slice(&candidate_generation.to_be_bytes());
    format!("attempt_{}", blake3::hash(&bytes).to_hex())
}

fn managed_dispatch_claim_nonce(record: &ManagedDispatchConsumeRecordV1) -> String {
    let mut bytes = b"horizoncode.claimed-worker-dispatch-proof.v1\0".to_vec();
    let sequence = record.claim_owner_log_sequence.to_string();
    for value in [record.claimed_attempt_id.as_str(), record.worker_execution_id.as_str(),
        record.claimed_binding_digest.as_str(), record.pins_digest.as_str(),
        record.claim_owner_log_id.as_str(), sequence.as_str(),
        record.claim_owner_log_event_digest.as_str()] {
        bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes.extend_from_slice(&record.worker_pool_revision.to_be_bytes());
    format!("blake3:{}", blake3::hash(&bytes).to_hex())
}

fn managed_dispatch_claim_proof_digest(record: &ManagedDispatchConsumeRecordV1) -> String {
    let mut bytes = b"horizoncode.claimed-worker-dispatch-proof-digest.v1\0".to_vec();
    let sequence = record.claim_owner_log_sequence.to_string();
    for value in [record.claimed_attempt_id.as_str(), record.worker_execution_id.as_str(),
        record.claimed_binding_digest.as_str(), record.pins_digest.as_str(),
        record.claim_owner_log_id.as_str(), sequence.as_str(),
        record.claim_owner_log_event_digest.as_str(), record.claim_nonce.as_str()] {
        bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes.extend_from_slice(&record.worker_pool_revision.to_be_bytes());
    format!("blake3:{}", blake3::hash(&bytes).to_hex())
}

fn validate_verification_evidence(evidence: &VerificationEvidenceV1) -> Result<(), ManagedError> {
    id(&evidence.verification_run_id)?;
    principal(&evidence.verifier_id)?;
    managed_digest(&evidence.source_revision)?;
    blake3_digest(&evidence.evidence_digest)?;
    id(&evidence.profile.profile_id)?;
    managed_digest(&evidence.profile.executable_digest)?;
    managed_digest(&evidence.profile.profile_digest)?;
    if evidence.profile.owner_epoch == 0 {
        return Err(ManagedError::Invalid("verifier owner epoch is invalid"));
    }
    if evidence.criteria.is_empty() || evidence.criteria.len() > 256 {
        return Err(ManagedError::Invalid(
            "verification criterion count exceeds bounds",
        ));
    }
    let mut criteria = BTreeSet::new();
    let mut test_runs = BTreeSet::new();
    let mut executions = BTreeSet::new();
    let mut refs = BTreeSet::new();
    let mut artifact_count = 0usize;
    let mut aggregate_artifact_bytes = 0u64;
    let mut aggregate_output_bytes = 0u64;
    let mut aggregate_duration_ms = 0u64;
    for criterion in &evidence.criteria {
        id(&criterion.criterion_id)?;
        id(&criterion.test_identity)?;
        id(&criterion.test_run_id)?;
        id(&criterion.process.execution_id)?;
        if !criteria.insert(criterion.criterion_id.as_str()) {
            return Err(ManagedError::Invalid("duplicate verification criterion"));
        }
        if !test_runs.insert(criterion.test_run_id.as_str())
            || !executions.insert(criterion.process.execution_id.as_str())
        {
            return Err(ManagedError::Invalid(
                "duplicate verifier process or test run identity",
            ));
        }
        blake3_digest(&criterion.process.stdout_digest)?;
        blake3_digest(&criterion.process.stderr_digest)?;
        if criterion.process.generation == 0
            || criterion.process.duration_ms == 0
            || criterion.process.duration_ms > evidence.aggregate_duration_ms
            || criterion.process.output_bytes > 16 * 1024 * 1024
        {
            return Err(ManagedError::Invalid(
                "criterion verifier process exceeds bounds",
            ));
        }
        aggregate_output_bytes = aggregate_output_bytes
            .checked_add(criterion.process.output_bytes)
            .ok_or(ManagedError::Invalid("verifier output total overflow"))?;
        aggregate_duration_ms = aggregate_duration_ms
            .checked_add(criterion.process.duration_ms)
            .ok_or(ManagedError::Invalid("verifier duration total overflow"))?;
        if (criterion.verdict == VerificationVerdictV1::Pass
            && (criterion.process.exit_code != 0 || criterion.process.truncated))
            || (criterion.verdict == VerificationVerdictV1::Fail
                && criterion.process.exit_code == 0)
        {
            return Err(ManagedError::Invalid(
                "criterion verdict does not match its observed process result",
            ));
        }
        if criterion.artifact_refs.is_empty() || criterion.artifact_refs.len() > 64 {
            return Err(ManagedError::Invalid(
                "verification artifact count exceeds bounds",
            ));
        }
        artifact_count = artifact_count.saturating_add(criterion.artifact_refs.len());
        if artifact_count > 256 {
            return Err(ManagedError::Invalid(
                "verification artifact total exceeds bounds",
            ));
        }
        for reference in &criterion.artifact_refs {
            id(&reference.artifact_id)?;
            if reference.media_type.is_empty()
                || reference.media_type.len() > 256
                || reference
                    .media_type
                    .bytes()
                    .any(|byte| byte.is_ascii_control())
            {
                return Err(ManagedError::Invalid("verification media type is invalid"));
            }
            managed_digest(&reference.digest)?;
            if reference.byte_length.is_empty()
                || (reference.byte_length.len() > 1 && reference.byte_length.starts_with('0'))
                || !reference
                    .byte_length
                    .bytes()
                    .all(|byte| byte.is_ascii_digit())
                || reference
                    .byte_length
                    .parse::<u64>()
                    .ok()
                    .is_none_or(|length| length > 256 * 1024 * 1024)
            {
                return Err(ManagedError::Invalid(
                    "verification artifact length is invalid",
                ));
            }
            if !refs.insert((reference.artifact_id.as_str(), reference.digest.as_str())) {
                return Err(ManagedError::Invalid(
                    "duplicate verification artifact reference",
                ));
            }
            let byte_length = reference
                .byte_length
                .parse::<u64>()
                .map_err(|_| ManagedError::Invalid("verification artifact length is invalid"))?;
            if byte_length > MAX_VERIFIER_ARTIFACT_BYTES as u64 {
                return Err(ManagedError::Invalid(
                    "verification artifact exceeds its per-reference bound",
                ));
            }
            aggregate_artifact_bytes =
                aggregate_artifact_bytes
                    .checked_add(byte_length)
                    .ok_or(ManagedError::Invalid(
                        "verification artifact total overflow",
                    ))?;
            if aggregate_artifact_bytes > MAX_VERIFIER_RUN_OUTPUT_BYTES {
                return Err(ManagedError::Invalid(
                    "verification artifact total exceeds bounds",
                ));
            }
        }
    }
    if evidence.aggregate_output_bytes != aggregate_output_bytes
        || evidence.aggregate_output_bytes > 64 * 1024 * 1024
        || evidence.aggregate_duration_ms == 0
        || evidence.aggregate_duration_ms != aggregate_duration_ms
    {
        return Err(ManagedError::Invalid(
            "verifier aggregate output or duration is inconsistent or exceeds bounds",
        ));
    }
    Ok(())
}

fn verification_criteria_match_exact_accepted_set(
    accepted: &BTreeSet<&str>,
    observed: &BTreeSet<&str>,
    artifacts: &BTreeSet<&str>,
) -> bool {
    !accepted.is_empty() && accepted == observed && accepted == artifacts
}

fn blake3_digest(value: &str) -> Result<(), ManagedError> {
    if value.len() != 71
        || !value.starts_with("blake3:")
        || !value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(ManagedError::Invalid("invalid managed BLAKE3 digest"));
    }
    Ok(())
}

#[cfg(test)]
mod managed_verification_evidence_tests {
    use super::*;

    #[test]
    fn verifier_artifacts_must_cover_exact_accepted_criteria() {
        let accepted = BTreeSet::from(["build", "tests"]);
        let exact = BTreeSet::from(["build", "tests"]);
        let missing = BTreeSet::from(["build"]);
        let extra = BTreeSet::from(["build", "tests", "docs"]);

        assert!(verification_criteria_match_exact_accepted_set(
            &accepted, &exact, &exact
        ));
        assert!(!verification_criteria_match_exact_accepted_set(
            &accepted, &missing, &exact
        ));
        assert!(!verification_criteria_match_exact_accepted_set(
            &accepted, &extra, &exact
        ));
        assert!(!verification_criteria_match_exact_accepted_set(
            &accepted, &exact, &missing
        ));
    }

    fn digest(seed: char) -> String {
        format!("blake3:{}", seed.to_string().repeat(64))
    }

    fn valid_evidence() -> VerificationEvidenceV1 {
        let mut evidence = VerificationEvidenceV1 {
            verification_run_id: "verify-run-1".into(),
            verifier_id: "server_auth.independent".into(),
            source_revision: digest('a'),
            profile: VerifierProfileEvidenceV1 {
                profile_id: "profile-linux-v1".into(),
                owner_epoch: 2,
                executable_digest: digest('b'),
                profile_digest: digest('c'),
            },
            aggregate_output_bytes: 512,
            aggregate_duration_ms: 100,
            criteria: vec![CriterionTestEvidenceV1 {
                criterion_id: "tests-pass".into(),
                verdict: VerificationVerdictV1::Pass,
                test_identity: "test-suite".into(),
                test_run_id: "test-run-1".into(),
                process: CriterionVerifierProcessEvidenceV1 {
                    execution_id: "execution-1".into(),
                    generation: 1,
                    exit_code: 0,
                    stdout_digest: digest('d'),
                    stderr_digest: digest('e'),
                    output_bytes: 512,
                    duration_ms: 100,
                    truncated: false,
                },
                artifact_refs: vec![ArtifactRefV1 {
                    artifact_id: "artifact-1".into(),
                    digest: digest('f'),
                    byte_length: "64".into(),
                    media_type: "text/plain".into(),
                    classification: ArtifactClassificationV1::Workspace,
                }],
            }],
            evidence_digest: String::new(),
        };
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        evidence
    }

    fn live_verifier_receipt_snapshot() -> ManagedSnapshot {
        let workspace_revision = digest('a');
        let mut snapshot = ManagedSnapshot {
            owner_goal_id: "goal-verification".into(),
            ..ManagedSnapshot::default()
        };
        let spec = SpecVersionDraft {
            parent_version_id: None,
            objective: "verify one managed task".into(),
            project_ref: "project-1".into(),
            workspace_ref: "workspace-1".into(),
            capability_scope: vec!["verifier.run".into()],
            scope: vec!["src/**".into()],
            constraints: vec![],
            criteria: vec![AcceptanceCriterion { id: "tests-pass".into(), description: "tests pass".into() }],
            budget: SpecBudget {
                max_tasks: 1,
                max_attempts_per_task: 1,
                max_run_duration_ms: 1_000,
                max_memory_bytes: None,
                max_disk_bytes: None,
                max_workers: 1,
                max_tokens: None,
                max_cost_micros: Some(0),
            },
            source_digests: vec![digest('f')],
            proposed_by: "server_auth.author".into(),
        };
        snapshot.specs.insert("spec-verification".into(), SpecVersion {
            digest: spec.digest(),
            content: spec,
            accepted: true,
            accepted_by: Some("server_auth.acceptance-reviewer".into()),
            accepted_at_ms: Some(1),
            reviewer_id: Some("server_auth.acceptance-reviewer".into()),
            reviewer_assigned_revision: Some(1),
            reviewed_revision: Some(2),
            rejected_by: None,
            rejected_at_ms: None,
        });
        snapshot.runs.insert("run-verification".into(), Run {
            spec_id: "spec-verification".into(),
            phase: RunPhase::Running,
            started_at_ms: None,
            tasks: BTreeMap::from([("task-verification".into(), Task {
                dependencies: vec![],
                criterion_ids: vec!["tests-pass".into()],
                required_capabilities: vec!["verifier.run".into()],
                agent_profile_revision: None,
                profile_owner_binding_digest: None,
                ready: false,
                active_attempt: Some("attempt-verification".into()),
                pending_verification_attempt: None,
                unknown_effect: false,
                verified_revision: None,
                verification_evidence: None,
                failed_criterion_ids: vec![],
                attempt_count: 1,
                candidate_generation: 0,
                title: None,
                purpose: None,
            })]),
            session_link: None,
            final_revision: None,
            verifier_id: None,
            criterion_evidence: BTreeMap::new(),
            verification_evidence: None,
            verification_history: vec![],
            failure_code: None,
        });
        snapshot.attempts.insert("attempt-verification".into(), AttemptRecord {
            run_id: "run-verification".into(),
            task_id: "task-verification".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 2,
            location_id: "location-verification".into(),
            session_id: "session-verification".into(),
            workspace_revision: Some(workspace_revision.clone()),
            delegation_binding: None,
            effects: vec![BoundEffect {
                effect_id: "effect-verifier".into(),
                location_id: "location-verification".into(),
                session_id: "session-verification".into(),
                bound_revision: 1,
            }],
            effect_receipts: BTreeMap::new(),
            verifier_intents: BTreeMap::from([("effect-verifier".into(), ManagedAttemptVerifierIntentV1 {
                goal_id: "goal-verification".into(),
                run_id: "run-verification".into(),
                task_id: "task-verification".into(),
                attempt_id: "attempt-verification".into(),
                effect_id: "effect-verifier".into(),
                reviewer_principal: "server_auth.reviewer".into(),
                verifier_principal: "server_auth.independent".into(),
                owner_epoch: 2,
                bound_revision: 1,
                location_id: "location-verification".into(),
                session_id: "session-verification".into(),
                capability_id: "verifier.run".into(),
                verifier_profile_id: "profile-verifier".into(),
                executable_digest: digest('c'),
                profile_digest: digest('d'),
                criterion_id: "tests-pass".into(),
                test_identity: "suite-tests".into(),
                arguments_digest: digest('e'),
                source_workspace_revision: workspace_revision,
                max_duration_ms: 1_000,
                max_output_bytes: 1_024,
            })]),
            verifier_evidence: None,
            phase: AttemptPhase::Executing,
            receipt_digest: None,
            failure_code: None,
            retryable: None,
        });
        snapshot
    }

    #[test]
    fn verifier_effect_receipt_binds_to_the_intent_principal_not_the_coding_executor() {
        let proof = ManagedAttemptEffectReceiptProofV1 {
            goal_id: "goal-verification".into(),
            run_id: "run-verification".into(),
            task_id: "task-verification".into(),
            attempt_id: "attempt-verification".into(),
            effect_id: "effect-verifier".into(),
            executor_principal: "server_auth.independent".into(),
            owner_epoch: 2,
            bound_revision: 1,
            location_id: "location-verification".into(),
            session_id: "session-verification".into(),
            capability_id: "verifier.run".into(),
            capability_lease_digest: digest('b'),
            outcome: AttemptEffectOutcomeV1::Succeeded,
            target_receipt_digest: Some(digest('e')),
            before_workspace_revision: digest('a'),
            after_workspace_revision: Some(digest('a')),
        };
        let mut accepted = live_verifier_receipt_snapshot();
        assert!(accepted.apply_with_replay_mode(
            &ManagedCommand::RecordAttemptEffectReceipt { proof: proof.clone() },
            false,
        ).is_ok());

        let mut forged = live_verifier_receipt_snapshot();
        let mut forged_proof = proof;
        forged_proof.executor_principal = "server_auth.executor".into();
        assert!(forged.apply_with_replay_mode(
            &ManagedCommand::RecordAttemptEffectReceipt { proof: forged_proof },
            false,
        ).is_err());
    }

    #[test]
    fn managed_effect_workspace_revision_follows_the_ordered_receipt_chain() {
        let mut snapshot = live_verifier_receipt_snapshot();
        let attempt = snapshot.attempts.get_mut("attempt-verification").unwrap();
        attempt.effects.insert(0, BoundEffect {
            effect_id: "effect-coding".into(),
            location_id: "location-verification".into(),
            session_id: "session-verification".into(),
            bound_revision: 0,
        });
        attempt.effect_receipts.insert("effect-coding".into(), ManagedAttemptEffectReceiptV1 {
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 2,
            bound_revision: 0,
            location_id: "location-verification".into(),
            session_id: "session-verification".into(),
            capability_id: "files.write".into(),
            capability_lease_digest: digest('f'),
            outcome: AttemptEffectOutcomeV1::Succeeded,
            target_receipt_digest: Some(digest('e')),
            before_workspace_revision: digest('a'),
            after_workspace_revision: Some(digest('b')),
        });
        let head = attempt_workspace_revision_before(attempt, "effect-verifier", false).unwrap();
        assert_eq!(head, digest('b'));

        attempt.effect_receipts.get_mut("effect-coding").unwrap().before_workspace_revision = digest('c');
        assert!(attempt_workspace_revision_before(attempt, "effect-verifier", false).is_err());
    }

    #[test]
    fn unknown_attempt_reconciliation_records_only_the_first_terminal_edge_without_resuming() {
        let mut snapshot = live_verifier_receipt_snapshot();
        snapshot.runs.get_mut("run-verification").unwrap().phase = RunPhase::Reconciling;
        let task = snapshot.runs.get_mut("run-verification").unwrap().tasks.get_mut("task-verification").unwrap();
        task.unknown_effect = true;
        let attempt = snapshot.attempts.get_mut("attempt-verification").unwrap();
        attempt.phase = AttemptPhase::Unknown;
        attempt.effects.insert(0, BoundEffect {
            effect_id: "effect-coding".into(),
            location_id: "location-verification".into(),
            session_id: "session-verification".into(),
            bound_revision: 0,
        });
        attempt.effect_receipts.insert("effect-coding".into(), ManagedAttemptEffectReceiptV1 {
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 2,
            bound_revision: 0,
            location_id: "location-verification".into(),
            session_id: "session-verification".into(),
            capability_id: "files.write".into(),
            capability_lease_digest: digest('f'),
            outcome: AttemptEffectOutcomeV1::Succeeded,
            target_receipt_digest: Some(digest('e')),
            before_workspace_revision: digest('a'),
            after_workspace_revision: Some(digest('b')),
        });
        let proof = ManagedAttemptEffectReceiptProofV1 {
            goal_id: "goal-verification".into(),
            run_id: "run-verification".into(),
            task_id: "task-verification".into(),
            attempt_id: "attempt-verification".into(),
            effect_id: "effect-verifier".into(),
            executor_principal: "server_auth.independent".into(),
            owner_epoch: 2,
            bound_revision: 1,
            location_id: "location-verification".into(),
            session_id: "session-verification".into(),
            capability_id: "verifier.run".into(),
            capability_lease_digest: digest('b'),
            outcome: AttemptEffectOutcomeV1::Succeeded,
            target_receipt_digest: Some(digest('c')),
            before_workspace_revision: digest('b'),
            after_workspace_revision: Some(digest('b')),
        };

        assert!(snapshot.apply_with_replay_mode(
            &ManagedCommand::ReconcileAttemptEffectReceipt { proof: proof.clone() },
            false,
        ).is_ok());
        assert_eq!(snapshot.attempts["attempt-verification"].phase, AttemptPhase::Unknown);
        assert_eq!(snapshot.runs["run-verification"].phase, RunPhase::Reconciling);
        assert_eq!(snapshot.attempts["attempt-verification"].effect_receipts["effect-verifier"].outcome, AttemptEffectOutcomeV1::Succeeded);

        let mut skipped = live_verifier_receipt_snapshot();
        skipped.runs.get_mut("run-verification").unwrap().phase = RunPhase::Reconciling;
        skipped.runs.get_mut("run-verification").unwrap().tasks.get_mut("task-verification").unwrap().unknown_effect = true;
        skipped.attempts.get_mut("attempt-verification").unwrap().phase = AttemptPhase::Unknown;
        assert!(skipped.apply_with_replay_mode(
            &ManagedCommand::ReconcileAttemptEffectReceipt { proof },
            false,
        ).is_err());
    }

    fn receipt_ready_snapshot() -> ManagedSnapshot {
        let run_id = "run-verification";
        let task_id = "task-verification";
        let attempt_id = "attempt-verification";
        let location_id = "location-verification";
        let session_id = "session-verification";
        let mut snapshot = ManagedSnapshot::default();
        snapshot.runs.insert(
            run_id.into(),
            Run {
                spec_id: "spec-verification".into(),
                phase: RunPhase::Running,
                started_at_ms: None,
                tasks: BTreeMap::from([(
                    task_id.into(),
                    Task {
                        dependencies: Vec::new(),
                        criterion_ids: vec!["tests-pass".into()],
                        required_capabilities: Vec::new(),
                        agent_profile_revision: None,
                        profile_owner_binding_digest: None,
                        ready: false,
                        active_attempt: None,
                        pending_verification_attempt: Some(attempt_id.into()),
                        unknown_effect: false,
                        verified_revision: None,
                        verification_evidence: None,
                        failed_criterion_ids: Vec::new(),
                        attempt_count: 1,
                        candidate_generation: 0,
                        title: None,
                        purpose: None,
                    },
                )]),
                session_link: None,
                final_revision: None,
                verifier_id: None,
                criterion_evidence: BTreeMap::new(),
                verification_evidence: None,
                verification_history: Vec::new(),
                failure_code: None,
            },
        );
        snapshot.attempts.insert(
            attempt_id.into(),
            AttemptRecord {
                run_id: run_id.into(),
                task_id: task_id.into(),
                executor_principal: "server_auth.executor".into(),
                owner_epoch: 1,
                location_id: location_id.into(),
                session_id: session_id.into(),
                workspace_revision: Some(digest('a')),
                delegation_binding: None,
                effects: vec![BoundEffect {
                    effect_id: "effect-verification".into(),
                    location_id: location_id.into(),
                    session_id: session_id.into(),
                    bound_revision: 1,
                }],
                effect_receipts: BTreeMap::new(),
                verifier_intents: BTreeMap::new(),
                verifier_evidence: None,
                phase: AttemptPhase::Succeeded,
                receipt_digest: Some(digest('b')),
                failure_code: None,
                retryable: None,
            },
        );
        snapshot
    }

    #[test]
    fn receipt_backed_verification_event_projects_and_legacy_event_replays() {
        let initial = receipt_ready_snapshot();
        let expected = successful_task_receipt_basis_digest(
            "run-verification",
            &initial.runs["run-verification"],
            &initial.attempts,
        )
        .unwrap();
        let command = ManagedCommand::BeginVerificationWithReceiptBasis {
            run_id: "run-verification".into(),
            final_revision: digest('c'),
            verifier_id: "server_auth.verifier".into(),
            receipt_basis_digest: expected.clone(),
        };
        let (kind, payload) = command.event();
        assert_eq!(kind, "run_verifying");
        assert_eq!(payload.as_object().unwrap().len(), 4);
        assert_eq!(
            payload.get("receiptBasisDigest").and_then(Value::as_str),
            Some(expected.as_str())
        );
        assert!(matches!(
            ManagedCommand::decode(kind, &payload),
            Ok(ManagedCommand::BeginVerificationWithReceiptBasis {
                receipt_basis_digest,
                ..
            }) if receipt_basis_digest == expected
        ));

        let mut projected = initial.clone();
        projected.apply(&command).unwrap();
        assert_eq!(
            projected.runs["run-verification"].phase,
            RunPhase::Verifying
        );

        let mut tampered = initial.clone();
        assert!(matches!(
            tampered.apply(&ManagedCommand::BeginVerificationWithReceiptBasis {
                run_id: "run-verification".into(),
                final_revision: digest('c'),
                verifier_id: "server_auth.verifier".into(),
                receipt_basis_digest: digest('d'),
            }),
            Err(ManagedError::Conflict(
                "verification receipt basis digest mismatch"
            ))
        ));
        assert_eq!(tampered.revision, initial.revision);
        assert_eq!(tampered.runs["run-verification"].phase, RunPhase::Running);

        let legacy_payload = json!({
            "runId": "run-verification",
            "finalRevision": digest('c'),
            "verifierId": "server_auth.verifier",
        });
        let legacy = ManagedCommand::decode("run_verifying", &legacy_payload).unwrap();
        assert!(matches!(legacy, ManagedCommand::BeginVerification { .. }));
        let mut replayed = initial;
        replayed.replay(&legacy).unwrap();
        assert_eq!(replayed.runs["run-verification"].phase, RunPhase::Verifying);
    }

    #[test]
    fn verification_keeps_the_single_coding_attempt_live_until_typed_evidence() {
        let mut snapshot = receipt_ready_snapshot();
        let run = snapshot.runs.get_mut("run-verification").unwrap();
        run.phase = RunPhase::Running;
        let task = run.tasks.get_mut("task-verification").unwrap();
        task.active_attempt = Some("attempt-verification".into());
        task.pending_verification_attempt = None;
        task.ready = false;
        let attempt = snapshot.attempts.get_mut("attempt-verification").unwrap();
        attempt.phase = AttemptPhase::Executing;
        attempt.receipt_digest = None;
        attempt.workspace_revision = Some(digest('a'));
        attempt.delegation_binding = Some(DelegationBindingV1 {
            run_id: "run-verification".into(),
            task_id: "task-verification".into(),
            attempt_id: "attempt-verification".into(),
            parent_execution_id: "parent-execution".into(),
            child_execution_id: "child-execution".into(),
            accepted_spec_digest: digest('1'),
            profile_id: "profile-verification".into(),
            profile_revision: 1,
            profile_digest: digest('2'),
            criteria_ids: vec!["tests-pass".into()],
            workspace_lease_id: "workspace-lease".into(),
            source_revision: digest('a'),
            capability_ceiling_digest: digest('3'),
            context_selection_digest: digest('4'),
            budget_lease_id: "budget-lease".into(),
            resource_lease_ids: vec![],
            owner_epoch: 1,
            admitted_managed_revision: 1,
        });
        let coding_effect = &attempt.effects[0];
        attempt.effect_receipts.insert(coding_effect.effect_id.clone(), ManagedAttemptEffectReceiptV1 {
            executor_principal: attempt.executor_principal.clone(),
            owner_epoch: attempt.owner_epoch,
            bound_revision: coding_effect.bound_revision,
            location_id: coding_effect.location_id.clone(),
            session_id: coding_effect.session_id.clone(),
            capability_id: "files.write".into(),
            capability_lease_digest: digest('d'),
            outcome: AttemptEffectOutcomeV1::Succeeded,
            target_receipt_digest: Some(digest('e')),
            before_workspace_revision: digest('a'),
            after_workspace_revision: Some(digest('b')),
        });

        let receipt_basis = successful_task_receipt_basis_digest(
            "run-verification", &snapshot.runs["run-verification"], &snapshot.attempts,
        ).unwrap();
        snapshot.apply(&ManagedCommand::BeginVerificationWithReceiptBasis {
            run_id: "run-verification".into(),
            final_revision: digest('b'),
            verifier_id: "server_auth.verifier".into(),
            receipt_basis_digest: receipt_basis,
        }).unwrap();

        let run = &snapshot.runs["run-verification"];
        let task = &run.tasks["task-verification"];
        assert_eq!(run.phase, RunPhase::Verifying);
        assert_eq!(task.active_attempt.as_deref(), Some("attempt-verification"));
        assert_eq!(task.pending_verification_attempt.as_deref(), Some("attempt-verification"));
        assert_eq!(snapshot.attempts["attempt-verification"].phase, AttemptPhase::Executing);
        assert_eq!(snapshot.attempts["attempt-verification"].receipt_digest, None);
        assert!(restart_recoverable_live_verification(
            "run-verification", run, &snapshot.attempts,
        ));
        let mut after_verifier_intent = snapshot.clone();
        after_verifier_intent
            .attempts
            .get_mut("attempt-verification")
            .unwrap()
            .verifier_intents
            .insert(
                "effect-verification".into(),
                ManagedAttemptVerifierIntentV1 {
                    goal_id: "goal-verification".into(),
                    run_id: "run-verification".into(),
                    task_id: "task-verification".into(),
                    attempt_id: "attempt-verification".into(),
                    effect_id: "effect-verification".into(),
                    reviewer_principal: "server_auth.reviewer".into(),
                    verifier_principal: "server_auth.verifier".into(),
                    owner_epoch: 1,
                    bound_revision: 2,
                    location_id: "location-verification".into(),
                    session_id: "session-verification".into(),
                    capability_id: "builtin.verifier".into(),
                    verifier_profile_id: "verifier-profile".into(),
                    executable_digest: digest('5'),
                    profile_digest: digest('6'),
                    criterion_id: "tests-pass".into(),
                    test_identity: "tests".into(),
                    arguments_digest: digest('7'),
                    source_workspace_revision: digest('b'),
                    max_duration_ms: 1_000,
                    max_output_bytes: 1_024,
                },
            );
        assert!(!restart_recoverable_live_verification(
            "run-verification",
            &after_verifier_intent.runs["run-verification"],
            &after_verifier_intent.attempts,
        ));

        // A post-restart begin-verification retry keeps the frozen head,
        // assigned verifier, receipt basis and same coding Attempt. The
        // HostKernel journal owns the challenge set; this does not create one.
        let before_retry_attempt = snapshot.attempts["attempt-verification"].clone();
        let retry_basis = successful_task_receipt_basis_digest(
            "run-verification", run, &snapshot.attempts,
        ).unwrap();
        snapshot.apply(&ManagedCommand::BeginVerificationWithReceiptBasis {
            run_id: "run-verification".into(),
            final_revision: digest('b'),
            verifier_id: "server_auth.verifier".into(),
            receipt_basis_digest: retry_basis,
        }).unwrap();
        assert_eq!(snapshot.attempts["attempt-verification"], before_retry_attempt);
        assert_eq!(snapshot.runs["run-verification"].phase, RunPhase::Verifying);
        assert_eq!(
            snapshot.runs["run-verification"].final_revision.as_deref(),
            Some(digest('b').as_str()),
        );
        assert!(restart_recoverable_live_verification(
            "run-verification", &snapshot.runs["run-verification"], &snapshot.attempts,
        ));

        let revision = snapshot.revision;
        assert!(snapshot.apply(&ManagedCommand::BeginVerification {
            run_id: "run-verification".into(),
            final_revision: digest('c'),
            verifier_id: "server_auth.verifier".into(),
        }).is_err());
        assert_eq!(snapshot.revision, revision);
        assert_eq!(
            snapshot.runs["run-verification"].final_revision.as_deref(),
            Some(digest('b').as_str()),
        );
    }

    #[test]
    fn typed_task_evidence_binding_includes_settled_receipt_digest() {
        let evidence = valid_evidence();
        let criteria = vec!["tests-pass".into()];
        let first = task_typed_verification_digest(
            "task-1",
            "attempt-1",
            &digest('1'),
            &criteria,
            &evidence,
        );
        let changed_receipt = task_typed_verification_digest(
            "task-1",
            "attempt-1",
            &digest('2'),
            &criteria,
            &evidence,
        );
        assert_ne!(first, changed_receipt);
    }

    #[test]
    fn capability_scope_is_empty_or_sorted_unique_and_catalog_canonical() {
        assert!(validate_canonical_capability_ids(&[]).is_ok());
        assert!(validate_canonical_capability_ids(&[
            "files.patch".into(),
            "files.read".into(),
        ])
        .is_ok());
        assert!(validate_canonical_capability_ids(&[
            "files.read".into(),
            "files.patch".into(),
        ])
        .is_err());
        assert!(validate_canonical_capability_ids(&["exec.shell".into()]).is_err());
        assert!(validate_canonical_capability_ids(&["not.a.capability".into()]).is_err());
        assert!(validate_canonical_capability_ids(&vec!["files.read".into(); 65]).is_err());
    }

    #[test]
    fn legacy_digest_only_criterion_records_cannot_finalize_a_run() {
        let revision = digest('a');
        let spec = SpecVersionDraft {
            parent_version_id: None,
            objective: "verify the managed result".into(),
            project_ref: "project://test".into(),
            workspace_ref: "workspace://test".into(),
            capability_scope: vec![],
            scope: vec!["src/**".into()],
            constraints: Vec::new(),
            criteria: vec![AcceptanceCriterion {
                id: "tests-pass".into(),
                description: "the accepted test profile passes".into(),
            }],
            budget: SpecBudget {
                max_tasks: 1,
                max_attempts_per_task: 1,
                max_run_duration_ms: 1_000,
                max_memory_bytes: None,
                max_disk_bytes: None,
                max_workers: 1,
                max_tokens: None,
                max_cost_micros: None,
            },
            source_digests: vec![revision.clone()],
            proposed_by: "server_auth.author".into(),
        };
        let spec_id = "spec-v1".to_owned();
        let spec_digest = spec.digest();
        let mut snapshot = ManagedSnapshot::default();
        snapshot.specs.insert(
            spec_id.clone(),
            SpecVersion {
                digest: spec_digest,
                content: spec,
                accepted: true,
                accepted_by: Some("server_auth.reviewer".into()),
                accepted_at_ms: Some(1),
                reviewer_id: Some("server_auth.reviewer".into()),
                reviewer_assigned_revision: Some(1),
                reviewed_revision: Some(2),
                rejected_by: None,
                rejected_at_ms: None,
            },
        );
        snapshot.runs.insert(
            "run-v1".into(),
            Run {
                spec_id,
                phase: RunPhase::Verifying,
                started_at_ms: None,
                tasks: BTreeMap::new(),
                session_link: None,
                final_revision: Some(revision.clone()),
                verifier_id: Some("server_auth.verifier".into()),
                criterion_evidence: BTreeMap::from([(
                    "tests-pass".into(),
                    CriterionEvidence {
                        source_revision: revision.clone(),
                        evidence_digest: digest('b'),
                        verifier_id: "server_auth.verifier".into(),
                    },
                )]),
                verification_evidence: None,
                verification_history: Vec::new(),
                failure_code: None,
            },
        );

        let result = snapshot.apply(&ManagedCommand::FinalizeRun {
            run_id: "run-v1".into(),
            final_revision: revision,
        });

        assert!(matches!(result, Err(ManagedError::Conflict(_))));
        assert_eq!(snapshot.runs["run-v1"].phase, RunPhase::Verifying);
    }

    #[test]
    fn new_final_revision_rejects_stale_evidence_then_accepts_typed_current_evidence() {
        let old_revision = digest('a');
        let current_revision = digest('b');
        let spec = SpecVersionDraft {
            parent_version_id: None,
            objective: "verify the managed result".into(),
            project_ref: "project://test".into(),
            workspace_ref: "workspace://test".into(),
            capability_scope: vec![],
            scope: vec!["src/**".into()],
            constraints: Vec::new(),
            criteria: vec![AcceptanceCriterion {
                id: "tests-pass".into(),
                description: "the accepted test profile passes".into(),
            }],
            budget: SpecBudget {
                max_tasks: 1,
                max_attempts_per_task: 1,
                max_run_duration_ms: 1_000,
                max_memory_bytes: None,
                max_disk_bytes: None,
                max_workers: 1,
                max_tokens: None,
                max_cost_micros: None,
            },
            source_digests: vec![old_revision.clone()],
            proposed_by: "server_auth.author".into(),
        };
        let spec_digest = spec.digest();
        let spec_id = "spec-v1".to_owned();
        let verifier_id = "server_auth.independent".to_owned();
        let mut previous_evidence = valid_evidence();
        previous_evidence.verifier_id = verifier_id.clone();
        previous_evidence.evidence_digest = verification_evidence_digest(&previous_evidence);
        let mut snapshot = ManagedSnapshot::default();
        snapshot.specs.insert(
            spec_id.clone(),
            SpecVersion {
                digest: spec_digest,
                content: spec.clone(),
                accepted: true,
                accepted_by: Some("server_auth.reviewer".into()),
                accepted_at_ms: Some(1),
                reviewer_id: Some("server_auth.reviewer".into()),
                reviewer_assigned_revision: Some(1),
                reviewed_revision: Some(2),
                rejected_by: None,
                rejected_at_ms: None,
            },
        );
        snapshot.runs.insert(
            "run-v1".into(),
            Run {
                spec_id,
                phase: RunPhase::Verifying,
                started_at_ms: None,
                tasks: BTreeMap::from([(
                    "task-v1".into(),
                    Task {
                        dependencies: Vec::new(),
                        criterion_ids: vec!["tests-pass".into()],
                        required_capabilities: vec![],
                        agent_profile_revision: None,
                        profile_owner_binding_digest: None,
                        ready: true,
                        active_attempt: None,
                        pending_verification_attempt: None,
                        unknown_effect: false,
                        verified_revision: Some(old_revision.clone()),
                        verification_evidence: None,
                        failed_criterion_ids: Vec::new(),
                        attempt_count: 1,
                        candidate_generation: 0,
                        title: None,
                        purpose: None,
                    },
                )]),
                session_link: None,
                final_revision: Some(old_revision.clone()),
                verifier_id: Some(verifier_id.clone()),
                criterion_evidence: BTreeMap::from([(
                    "tests-pass".into(),
                    CriterionEvidence {
                        source_revision: old_revision.clone(),
                        evidence_digest: digest('e'),
                        verifier_id: verifier_id.clone(),
                    },
                )]),
                verification_evidence: Some(previous_evidence.clone()),
                verification_history: Vec::new(),
                failure_code: None,
            },
        );

        snapshot
            .apply(&ManagedCommand::BeginVerification {
                run_id: "run-v1".into(),
                final_revision: current_revision.clone(),
                verifier_id: verifier_id.clone(),
            })
            .unwrap();
        assert!(snapshot.runs["run-v1"].criterion_evidence.is_empty());
        assert!(snapshot.runs["run-v1"].verification_evidence.is_none());
        assert_eq!(snapshot.runs["run-v1"].verification_history.len(), 1);
        assert!(matches!(
            snapshot.apply(&ManagedCommand::RecordVerificationEvidence {
                run_id: "run-v1".into(),
                evidence: previous_evidence,
            }),
            Err(ManagedError::Conflict(_))
        ));

        let mut current_evidence = valid_evidence();
        current_evidence.verification_run_id = "verify-run-current".into();
        current_evidence.verifier_id = verifier_id;
        current_evidence.source_revision = current_revision.clone();
        current_evidence.evidence_digest = verification_evidence_digest(&current_evidence);
        snapshot
            .apply(&ManagedCommand::RecordVerificationEvidence {
                run_id: "run-v1".into(),
                evidence: current_evidence,
            })
            .unwrap();
        snapshot
            .apply(&ManagedCommand::FinalizeRun {
                run_id: "run-v1".into(),
                final_revision: current_revision,
            })
            .unwrap();
        assert_eq!(snapshot.runs["run-v1"].phase, RunPhase::Succeeded);
        assert_eq!(snapshot.runs["run-v1"].verification_history.len(), 1);
    }

    #[test]
    fn same_revision_verification_retry_is_rejected_when_typed_evidence_exists() {
        let evidence = valid_evidence();
        let revision = evidence.source_revision.clone();
        let verifier_id = evidence.verifier_id.clone();
        let run = Run {
            spec_id: "spec-v1".into(),
            phase: RunPhase::Verifying,
            started_at_ms: None,
            tasks: BTreeMap::from([(
                "task-v1".into(),
                Task {
                    dependencies: Vec::new(),
                    criterion_ids: vec!["tests-pass".into()],
                    required_capabilities: vec![],
                    agent_profile_revision: None,
                    profile_owner_binding_digest: None,
                    ready: true,
                    active_attempt: None,
                    pending_verification_attempt: None,
                    unknown_effect: false,
                    verified_revision: Some(revision.clone()),
                    verification_evidence: None,
                    failed_criterion_ids: Vec::new(),
                    attempt_count: 1,
                candidate_generation: 0,
                title: None,
                purpose: None,
                },
            )]),
            session_link: None,
            final_revision: Some(revision.clone()),
            verifier_id: Some(verifier_id.clone()),
            criterion_evidence: BTreeMap::new(),
            verification_evidence: Some(evidence.clone()),
            verification_history: Vec::new(),
            failure_code: None,
        };
        let mut snapshot = ManagedSnapshot::default();
        snapshot.runs.insert("run-v1".into(), run.clone());

        let result = snapshot.apply(&ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: revision.clone(),
            verifier_id,
        });

        assert!(matches!(result, Err(ManagedError::Conflict(_))));
        assert_eq!(snapshot.runs["run-v1"], run);
    }

    #[test]
    fn observed_verification_evidence_round_trips_with_per_criterion_process_provenance() {
        let evidence = valid_evidence();
        validate_verification_evidence(&evidence).unwrap();

        let decoded =
            decode_verification_evidence(&verification_evidence_value(&evidence)).unwrap();

        assert_eq!(decoded, evidence);
        assert_eq!(
            decoded.evidence_digest,
            verification_evidence_digest(&decoded)
        );
    }

    #[test]
    fn observed_verification_evidence_rejects_pass_without_complete_zero_exit() {
        let mut evidence = valid_evidence();
        evidence.criteria[0].process.exit_code = 1;
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        assert!(validate_verification_evidence(&evidence).is_err());

        evidence.criteria[0].process.exit_code = 0;
        evidence.criteria[0].process.truncated = true;
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        assert!(validate_verification_evidence(&evidence).is_err());
    }

    #[test]
    fn observed_verification_evidence_rejects_aggregate_output_mismatch_and_overflow() {
        let mut evidence = valid_evidence();
        evidence.aggregate_output_bytes += 1;
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        assert!(validate_verification_evidence(&evidence).is_err());

        evidence = valid_evidence();
        evidence.criteria[0].process.output_bytes = 16 * 1024 * 1024 + 1;
        evidence.aggregate_output_bytes = evidence.criteria[0].process.output_bytes;
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        assert!(validate_verification_evidence(&evidence).is_err());
    }

    #[test]
    fn observed_verification_evidence_rejects_aggregate_duration_mismatch_and_overflow() {
        let mut evidence = valid_evidence();
        evidence.aggregate_duration_ms += 1;
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        assert!(validate_verification_evidence(&evidence).is_err());

        evidence = valid_evidence();
        evidence.criteria[0].process.duration_ms = u64::MAX;
        evidence.aggregate_duration_ms = u64::MAX;
        let mut second = evidence.criteria[0].clone();
        second.criterion_id = "docs-pass".into();
        second.test_identity = "docs-suite".into();
        second.test_run_id = "test-run-2".into();
        second.process.execution_id = "execution-2".into();
        second.process.duration_ms = 1;
        second.process.output_bytes = 0;
        second.artifact_refs[0].artifact_id = "artifact-2".into();
        evidence.criteria.push(second);
        evidence.aggregate_output_bytes = 512;
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        assert!(validate_verification_evidence(&evidence).is_err());
    }

    #[test]
    fn observed_verification_evidence_rejects_artifact_size_and_total_overflow() {
        let mut evidence = valid_evidence();
        evidence.criteria[0].artifact_refs[0].byte_length =
            (MAX_VERIFIER_ARTIFACT_BYTES as u64 + 1).to_string();
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        assert!(validate_verification_evidence(&evidence).is_err());

        evidence = valid_evidence();
        evidence.criteria[0].artifact_refs[0].byte_length = MAX_VERIFIER_ARTIFACT_BYTES.to_string();
        for index in 2..=5 {
            let mut reference = evidence.criteria[0].artifact_refs[0].clone();
            reference.artifact_id = format!("artifact-{index}");
            evidence.criteria[0].artifact_refs.push(reference);
        }
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        assert!(validate_verification_evidence(&evidence).is_err());
    }
}

#[cfg(test)]
mod managed_delegation_admission_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn digest(seed: char) -> String {
        format!("blake3:{}", seed.to_string().repeat(64))
    }

    fn sha(seed: char) -> String {
        format!("sha256:{}", seed.to_string().repeat(64))
    }

    fn facts_for_snapshot(snapshot: &ManagedSnapshot) -> ManagedDelegationAdmissionFactsV1 {
        let task = &snapshot.runs["run-1"].tasks["task-1"];
        let accepted_spec_digest = snapshot.specs["spec-1"].digest.clone();
        let context_selection = crate::context_selection::ContextSelectionV1::test_fixture();
        let session_id = context_selection.session_id.clone();
        let bounded_context = BoundedContextSelectionProofV1::from_core_selection(
            &context_selection,
            &session_id,
        )
        .unwrap();
        let owner = crate::resource_budget::AuthenticatedOwnerContext::test_fixture(
            "server_auth:executor",
            "workspace-1",
            &session_id,
            "run-1",
            "task-1",
            "attempt-1",
            3,
        );
        let worker_binding = crate::worker_pool::VerifiedAttemptBinding::test_fixture(
            "goal-admission",
            "run-1",
            "task-1",
            "attempt-1",
            3,
            &digest('b'),
            &accepted_spec_digest,
        );
        let durable_lease = crate::worker_durable::DurableManagedLeaseProofV1::test_fixture(
            &owner,
            &worker_binding,
            "child-exec",
            "goal-admission",
            "ticket-1",
            "workspace-lease",
            "budget-lease",
            vec!["resource-lease".into()],
            1,
        );
        let parent_attempt = AuthenticatedAttemptAdmissionProofV1 {
            goal_id: "goal-admission".into(),
            attempt_id: "parent-attempt".into(),
            run_id: "run-1".into(),
            task_id: "parent-task".into(),
            executor_principal: "server_auth:executor".into(),
            location_id: "location-1".into(),
            workspace_binding: "workspace-1".into(),
            session_id: session_id.clone(),
            owner_epoch: 3,
        };
        let parent_execution = ParentExecutionProofV1::test_fixture_for(
            &AuthenticatedAttemptAdmissionProofV1 {
                goal_id: "goal-admission".into(),
                attempt_id: "attempt-1".into(),
                run_id: "run-1".into(),
                task_id: "task-1".into(),
                executor_principal: "server_auth:executor".into(),
                location_id: "location-1".into(),
                workspace_binding: "workspace-1".into(),
                session_id: session_id.clone(),
                owner_epoch: 3,
            },
            "parent-exec",
            &accepted_spec_digest,
        );
        let scope = AcceptedTaskCapabilityScopeFactsV1 {
            run_id: "run-1".into(),
            task_id: "task-1".into(),
            spec_id: "spec-1".into(),
            spec_digest: snapshot.specs["spec-1"].digest.clone(),
            managed_revision: snapshot.revision,
            capability_scope: snapshot.specs["spec-1"].content.capability_scope.clone(),
            required_capabilities: task.required_capabilities.clone(),
            profile_revision: task.agent_profile_revision.clone(),
            profile_owner_binding_digest: task.profile_owner_binding_digest.clone(),
        };
        let profile = task.agent_profile_revision.as_ref().unwrap();
        let profile_digest = profile.definition_digest.clone();
        let scope_digest = scope.digest().unwrap();
        let owner_binding = ProfileOwnerBindingV1::Builtin;
        let owner_digest = owner_binding.digest();
        let proof = crate::guard::EffectiveCapabilityCeilingProofV1::test_fixture_for_owner(
            "attempt-1", 3, "run-1", "task-1", &scope_digest,
            &profile.profile_id, profile.revision, &profile_digest, &owner_digest, &digest('c'), vec![],
        );
        ManagedDelegationAdmissionFactsV1::from_owner_proofs(
            AuthenticatedAttemptAdmissionProofV1 {
                goal_id: "goal-admission".into(),
                attempt_id: "attempt-1".into(),
                run_id: "run-1".into(),
                task_id: "task-1".into(),
                executor_principal: "server_auth:executor".into(),
                location_id: "location-1".into(),
                workspace_binding: "workspace-1".into(),
                session_id,
                owner_epoch: 3,
            },
            RegisteredAgentProfileProofV1 {
                profile_id: profile.profile_id.clone(),
                profile_revision: profile.revision,
                profile_digest,
                profile_source: "builtin".into(),
                permission_ceiling_digest: digest('c'),
                capability_ceiling: vec![],
                owner_binding,
            },
            bounded_context,
            durable_lease,
            proof,
            parent_execution,
        )
    }

    fn facts() -> ManagedDelegationAdmissionFactsV1 {
        facts_for_snapshot(&accepted_attempt_snapshot())
    }

    fn accepted_attempt_snapshot() -> ManagedSnapshot {
        let spec = SpecVersionDraft {
            parent_version_id: None,
            objective: "perform one managed task".into(),
            project_ref: "project-1".into(),
            workspace_ref: "workspace-1".into(),
            capability_scope: vec![],
            scope: vec!["src/**".into()],
            constraints: vec![],
            criteria: vec![AcceptanceCriterion {
                id: "tests".into(),
                description: "tests pass".into(),
            }],
            budget: SpecBudget {
                max_tasks: 1,
                max_attempts_per_task: 1,
                max_run_duration_ms: 1_000,
                max_memory_bytes: None,
                max_disk_bytes: None,
                max_workers: 1,
                max_tokens: None,
                max_cost_micros: Some(0),
            },
            source_digests: vec![digest('e')],
            proposed_by: "server_auth.author".into(),
        };
        let spec_digest = spec.digest();
        let mut snapshot = ManagedSnapshot {
            owner_goal_id: "goal-admission".into(),
            revision: 12,
            goal: Some(Goal {
                objective: spec.objective.clone(),
                project_ref: spec.project_ref.clone(),
                workspace_ref: spec.workspace_ref.clone(),
                created_by: "server_auth.author".into(),
                active_spec_version_id: Some("spec-1".into()),
            }),
            ..ManagedSnapshot::default()
        };
        snapshot.specs.insert(
            "spec-1".into(),
            SpecVersion {
                digest: spec_digest,
                content: spec,
                accepted: true,
                accepted_by: Some("server_auth.reviewer".into()),
                accepted_at_ms: Some(1),
                reviewer_id: Some("server_auth.reviewer".into()),
                reviewer_assigned_revision: Some(2),
                reviewed_revision: Some(3),
                rejected_by: None,
                rejected_at_ms: None,
            },
        );
        snapshot.runs.insert(
            "run-1".into(),
            Run {
                spec_id: "spec-1".into(),
                phase: RunPhase::Running,
                started_at_ms: None,
                tasks: BTreeMap::from([(
                    "task-1".into(),
                    Task {
                        dependencies: vec![],
                        criterion_ids: vec!["tests".into()],
                        required_capabilities: vec![],
                        agent_profile_revision: Some(ProfileRevisionRefV1 {
                            profile_id: "agent-profile".into(),
                            revision: 7,
                            definition_digest: digest('a'),
                        }),
                        profile_owner_binding_digest: Some(ProfileOwnerBindingV1::Builtin.digest()),
                        ready: true,
                        active_attempt: Some("attempt-1".into()),
                        pending_verification_attempt: None,
                        unknown_effect: false,
                        verified_revision: None,
                        verification_evidence: None,
                        failed_criterion_ids: vec![],
                        attempt_count: 1,
                        candidate_generation: 0,
                        title: None,
                        purpose: None,
                    },
                )]),
                session_link: None,
                final_revision: None,
                verifier_id: None,
                criterion_evidence: BTreeMap::new(),
                verification_evidence: None,
                verification_history: vec![],
                failure_code: None,
            },
        );
        snapshot.attempts.insert(
            "attempt-1".into(),
            AttemptRecord {
                run_id: "run-1".into(),
                task_id: "task-1".into(),
                executor_principal: "server_auth.executor".into(),
                owner_epoch: 3,
                location_id: "location-1".into(),
                session_id: "session-1".into(),
                workspace_revision: Some(digest('b')),
                delegation_binding: None,
                effects: vec![],
                effect_receipts: BTreeMap::new(),
                verifier_intents: BTreeMap::new(),
                verifier_evidence: None,
                phase: AttemptPhase::Executing,
                receipt_digest: None,
                failure_code: None,
                retryable: None,
            },
        );
        snapshot
    }

    fn private_test_root() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "horizon-managed-admission-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[test]
    fn managed_admission_appends_attempt_and_binding_at_one_postappend_revision() {
        let root = private_test_root();
        let result = (|| {
            let mut control = ManagedControl::open(&root, "goal-admission")?;
            let draft = SpecVersionDraft {
                parent_version_id: None,
                objective: "perform one managed task".into(),
                project_ref: "project-1".into(),
                workspace_ref: "workspace-1".into(),
                capability_scope: vec![],
                scope: vec!["src/**".into()],
                constraints: vec![],
                criteria: vec![AcceptanceCriterion {
                    id: "tests".into(),
                    description: "tests pass".into(),
                }],
                budget: SpecBudget {
                    max_tasks: 1,
                    max_attempts_per_task: 1,
                    max_run_duration_ms: 1_000,
                    max_memory_bytes: None,
                    max_disk_bytes: None,
                    max_workers: 1,
                    max_tokens: None,
                    max_cost_micros: Some(0),
                },
                source_digests: vec![sha('e')],
                proposed_by: "server_auth.author".into(),
            };
            let spec_digest = draft.digest();
            control.apply(
                0,
                "create-goal",
                ManagedCommand::CreateGoal {
                    goal: GoalDraft {
                        objective: draft.objective.clone(),
                        project_ref: draft.project_ref.clone(),
                        workspace_ref: draft.workspace_ref.clone(),
                        created_by: draft.proposed_by.clone(),
                    },
                },
            )?;
            control.apply(
                1,
                "propose-spec",
                ManagedCommand::ProposeSpec {
                    spec_id: "spec-1".into(),
                    spec: draft,
                    spec_digest: spec_digest.clone(),
                },
            )?;
            control.apply(
                2,
                "assign-reviewer",
                ManagedCommand::AssignSpecReviewer {
                    spec_id: "spec-1".into(),
                    spec_digest: spec_digest.clone(),
                    reviewer_id: "server_auth.reviewer".into(),
                },
            )?;
            control.apply(
                3,
                "accept-spec",
                ManagedCommand::AcceptSpec {
                    spec_id: "spec-1".into(),
                    spec_digest,
                    accepted_by: "server_auth.reviewer".into(),
                    accepted_at_ms: 1,
                },
            )?;
            control.apply(
                4,
                "start-run",
                ManagedCommand::StartRun {
                    run_id: "run-1".into(),
                    spec_id: "spec-1".into(),
                },
            )?;
            control.apply(
                5,
                "add-task",
                ManagedCommand::AddTaskPinnedProfile {
                    run_id: "run-1".into(),
                    task_id: "task-1".into(),
                    dependencies: vec![],
                    criterion_ids: vec!["tests".into()],
                    required_capabilities: vec![],
                    agent_profile_revision: ProfileRevisionRefV1 {
                        profile_id: "agent-profile".into(),
                        revision: 7,
                        definition_digest: digest('a'),
                    },
                    profile_owner_binding_digest: ProfileOwnerBindingV1::Builtin.digest(),
                },
            )?;
            control.apply(
                6,
                "ready-task",
                ManagedCommand::MarkTaskReady {
                    run_id: "run-1".into(),
                    task_id: "task-1".into(),
                },
            )?;

            let before = control.snapshot().revision;
            assert!(
                control
                    .admit_attempt_with_delegation(
                        "missing-proof",
                        "run-1",
                        "task-1",
                        "attempt-missing",
                        None,
                    )
                    .is_err()
            );
            assert_eq!(control.snapshot().revision, before);
            let owner_snapshot = control.snapshot();
            let owner_facts = facts_for_snapshot(&owner_snapshot);
            control.admit_attempt_with_delegation(
                "admit-attempt",
                "run-1",
                "task-1",
                "attempt-1",
                Some(owner_facts.clone()),
            )?;
            let admitted_revision = control.snapshot().revision;
            control.admit_attempt_with_delegation(
                "admit-attempt",
                "run-1",
                "task-1",
                "attempt-1",
                Some(owner_facts.clone()),
            )?;
            assert_eq!(control.snapshot().revision, admitted_revision);
            let mut changed_facts = owner_facts;
            changed_facts.bounded_context.context_selection_digest = digest('f');
            assert!(
                control
                    .admit_attempt_with_delegation(
                        "admit-attempt",
                        "run-1",
                        "task-1",
                        "attempt-1",
                        Some(changed_facts),
                    )
                    .is_err()
            );
            assert_eq!(control.snapshot().revision, admitted_revision);
            let snapshot = control.snapshot();
            let attempt = &snapshot.attempts["attempt-1"];
            let binding = snapshot
                .attempt_delegation_binding("attempt-1")
                .unwrap()
                .clone();
            assert_eq!(snapshot.revision, before + 1);
            assert_eq!(attempt.phase, AttemptPhase::Executing);
            assert_eq!(
                attempt.workspace_revision.as_deref(),
                Some(digest('b').as_str())
            );
            assert_eq!(binding.admitted_managed_revision, snapshot.revision);
            assert_eq!(binding.criteria_ids, vec!["tests"]);

            drop(control);
            let reopened = ManagedControl::open(&root, "goal-admission")?;
            let recovered = reopened.snapshot();
            let recovered_task = &recovered.runs["run-1"].tasks["task-1"];
            assert_eq!(recovered_task.agent_profile_revision.as_ref(), Some(&ProfileRevisionRefV1 {
                profile_id: "agent-profile".into(),
                revision: 7,
                definition_digest: digest('a'),
            }));
            assert_eq!(recovered_task.profile_owner_binding_digest.as_deref(), Some(ProfileOwnerBindingV1::Builtin.digest().as_str()));
            assert_eq!(
                recovered.attempt_delegation_binding("attempt-1"),
                Some(&binding)
            );
            assert_eq!(recovered.attempts["attempt-1"].phase, AttemptPhase::Unknown);
            Ok::<_, ManagedError>(())
        })();
        std::fs::remove_dir_all(&root).unwrap();
        result.unwrap();
    }

    #[test]
    fn delegation_admission_derives_accepted_scope_and_rejects_stale_owner_facts() {
        let snapshot = accepted_attempt_snapshot();
        let binding =
            mint_delegation_binding(&snapshot, "run-1", "task-1", "attempt-1", &facts(), 13)
                .unwrap();
        assert_eq!(binding.criteria_ids, vec!["tests"]);
        assert_eq!(
            binding.accepted_spec_digest,
            snapshot.specs["spec-1"].digest
        );
        assert_eq!(binding.admitted_managed_revision, 13);

        let mut stale = facts();
        stale.authenticated_attempt.owner_epoch = 4;
        assert!(
            mint_delegation_binding(&snapshot, "run-1", "task-1", "attempt-1", &stale, 13,)
                .is_err()
        );

        let mut malformed_profile = facts();
        malformed_profile.registered_profile.profile_digest = "profile-digest-from-request".into();
        assert!(
            mint_delegation_binding(
                &snapshot,
                "run-1",
                "task-1",
                "attempt-1",
                &malformed_profile,
                13,
            )
            .is_err()
        );

        let mut parent_is_child = facts();
        let child_execution_id = parent_is_child.child_execution_id.clone();
        parent_is_child.parent_execution.test_set_execution_id(&child_execution_id);
        assert!(
            mint_delegation_binding(
                &snapshot,
                "run-1",
                "task-1",
                "attempt-1",
                &parent_is_child,
                13,
            )
            .is_err()
        );

        let mut duplicated_resource_refs = facts();
        duplicated_resource_refs.resource_leases.resource_lease_ids =
            vec!["lease-z".into(), "lease-a".into()];
        assert!(
            mint_delegation_binding(
                &snapshot,
                "run-1",
                "task-1",
                "attempt-1",
                &duplicated_resource_refs,
                13,
            )
            .is_err()
        );

        let mut forged_profile = facts();
        forged_profile.registered_profile.profile_digest = "not-a-digest".into();
        assert!(
            mint_delegation_binding(
                &snapshot,
                "run-1",
                "task-1",
                "attempt-1",
                &forged_profile,
                13,
            )
            .is_err()
        );

        let mut parent_is_child = facts();
        let child_execution_id = parent_is_child.child_execution_id.clone();
        parent_is_child.parent_execution.test_set_execution_id(&child_execution_id);
        assert!(
            mint_delegation_binding(
                &snapshot,
                "run-1",
                "task-1",
                "attempt-1",
                &parent_is_child,
                13,
            )
            .is_err()
        );

        let mut unsorted_resource_refs = facts();
        unsorted_resource_refs.resource_leases.resource_lease_ids =
            vec!["lease-z".into(), "lease-a".into()];
        assert!(
            mint_delegation_binding(
                &snapshot,
                "run-1",
                "task-1",
                "attempt-1",
                &unsorted_resource_refs,
                13,
            )
            .is_err()
        );

        let mut stale_source = facts();
        stale_source.workspace_source_lease.source_revision = digest('f');
        assert!(
            mint_delegation_binding(&snapshot, "run-1", "task-1", "attempt-1", &stale_source, 13,)
                .is_err()
        );
    }

    #[test]
    fn profile_owner_mismatch_is_denied_before_managed_admission_mutation() {
        let mut snapshot = accepted_attempt_snapshot();
        let owner_a_principal = crate::protocol::AuthenticatedPrincipalV1::ServerAuth {
            subject: "alice".into(),
        };
        let owner_a = ProfileOwnerBindingV1::from_authenticated_principal("user", &owner_a_principal).unwrap();
        snapshot.runs.get_mut("run-1").unwrap().tasks.get_mut("task-1").unwrap()
            .profile_owner_binding_digest = Some(owner_a.digest());
        let mut facts = facts_for_snapshot(&snapshot);
        facts.authenticated_attempt.executor_principal = "server_auth:bob".into();
        facts.registered_profile.profile_source = "user".into();
        facts.registered_profile.owner_binding = owner_a.clone();
        let scope = AcceptedTaskCapabilityScopeFactsV1 {
            run_id: "run-1".into(),
            task_id: "task-1".into(),
            spec_id: "spec-1".into(),
            spec_digest: snapshot.specs["spec-1"].digest.clone(),
            managed_revision: snapshot.revision,
            capability_scope: snapshot.specs["spec-1"].content.capability_scope.clone(),
            required_capabilities: snapshot.runs["run-1"].tasks["task-1"].required_capabilities.clone(),
            profile_revision: snapshot.runs["run-1"].tasks["task-1"].agent_profile_revision.clone(),
            profile_owner_binding_digest: snapshot.runs["run-1"].tasks["task-1"].profile_owner_binding_digest.clone(),
        };
        let owner_digest = owner_a.digest();
        facts.effective_capability_ceiling = crate::guard::EffectiveCapabilityCeilingProofV1::test_fixture_for_owner(
            "attempt-1", 3, "run-1", "task-1", &scope.digest().unwrap(),
            "agent-profile", 7, &digest('a'), &owner_digest, &digest('c'), vec![],
        );
        assert!(mint_delegation_binding(&snapshot, "run-1", "task-1", "attempt-1", &facts, 13).is_err());
        assert_eq!(snapshot.revision, 12);
        assert!(snapshot.attempt_delegation_binding("attempt-1").is_none());
    }
}

/// Canonical lowercase `sha256:` digest. Used for Core-computed facts (dispatch scope,
/// typed child result), which cannot be BLAKE3 because Core's runtime has no BLAKE3
/// implementation; kernel-computed receipts stay BLAKE3 so the two never collide.
fn sha256_digest(value: &str) -> Result<(), ManagedError> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(ManagedError::Invalid("invalid canonical sha256 digest"));
    }
    Ok(())
}

fn validate_goal(goal: &GoalDraft) -> Result<(), ManagedError> {
    nonempty_text(&goal.objective, 16 * 1024, "invalid Goal objective")?;
    id(&goal.project_ref)?;
    id(&goal.workspace_ref)?;
    principal(&goal.created_by)
}

fn validate_spec(spec: &SpecVersionDraft) -> Result<(), ManagedError> {
    nonempty_text(&spec.objective, 16 * 1024, "invalid SpecVersion objective")?;
    id(&spec.project_ref)?;
    id(&spec.workspace_ref)?;
    if let Some(parent) = &spec.parent_version_id {
        id(parent)?;
    }
    principal(&spec.proposed_by)?;
    validate_capability_ids(&spec.capability_scope, "SpecVersion capability scope")?;
    if spec.scope.is_empty() || spec.scope.len() > 128 || spec.constraints.len() > 128 {
        return Err(ManagedError::Invalid(
            "invalid SpecVersion scope or constraints",
        ));
    }
    for item in spec.scope.iter().chain(&spec.constraints) {
        nonempty_text(item, 4096, "invalid SpecVersion scope item")?;
    }
    if spec.criteria.is_empty() || spec.criteria.len() > 256 {
        return Err(ManagedError::Invalid("invalid acceptance criteria count"));
    }
    let mut criterion_ids = BTreeSet::new();
    for criterion in &spec.criteria {
        id(&criterion.id)?;
        nonempty_text(
            &criterion.description,
            4096,
            "invalid criterion description",
        )?;
        if !criterion_ids.insert(&criterion.id) {
            return Err(ManagedError::Invalid("duplicate criterion"));
        }
    }
    if spec.source_digests.len() > 256 {
        return Err(ManagedError::Invalid("too many SpecVersion source digests"));
    }
    let mut source_digests = BTreeSet::new();
    for source_digest in &spec.source_digests {
        digest(source_digest)?;
        if !source_digests.insert(source_digest) {
            return Err(ManagedError::Invalid("duplicate SpecVersion source digest"));
        }
    }
    let budget = &spec.budget;
    if budget.max_tasks == 0
        || budget.max_tasks > 256
        || budget.max_attempts_per_task == 0
        || budget.max_attempts_per_task > 100
        || budget.max_run_duration_ms == 0
        || budget.max_run_duration_ms > 9_007_199_254_740_991
        || budget.max_workers == 0
        || budget.max_workers > 20
        || budget.max_memory_bytes == Some(0)
        || budget.max_disk_bytes == Some(0)
        || budget.max_tokens == Some(0)
    {
        return Err(ManagedError::Invalid("invalid SpecVersion budget"));
    }
    Ok(())
}

fn canonical_capability_ids() -> &'static BTreeSet<String> {
    static IDS: OnceLock<BTreeSet<String>> = OnceLock::new();
    IDS.get_or_init(|| {
        let registry: Value = serde_json::from_str(include_str!(
            "../../arch_V1/contracts-v2/capability-registry-v1.json"
        ))
        .expect("canonical capability registry must be valid JSON");
        registry
            .get("canonical")
            .and_then(Value::as_array)
            .expect("canonical capability registry must contain canonical IDs")
            .iter()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect()
    })
}

pub(crate) fn validate_canonical_capability_ids(values: &[String]) -> Result<(), ManagedError> {
    validate_capability_ids(values, "capability IDs must be sorted and unique")
}

fn validate_capability_ids(values: &[String], label: &'static str) -> Result<(), ManagedError> {
    if values.len() > 64 {
        return Err(ManagedError::Invalid("too many capability IDs"));
    }
    let catalog = canonical_capability_ids();
    let mut previous: Option<&str> = None;
    for value in values {
        if !catalog.contains(value) {
            return Err(ManagedError::Invalid("unknown or noncanonical capability ID"));
        }
        if previous.is_some_and(|prior| prior >= value.as_str()) {
            return Err(ManagedError::Invalid(label));
        }
        previous = Some(value);
    }
    Ok(())
}

fn validate_session_link(link: &SessionLink) -> Result<(), ManagedError> {
    id(&link.session_id)?;
    id(&link.source_store_id)?;
    id(&link.source_instance_id)?;
    id(&link.source_cursor.owner_kind)?;
    id(&link.source_cursor.owner_id)?;
    if link.source_cursor.owner_kind != "session" || link.source_cursor.owner_id != link.session_id
    {
        return Err(ManagedError::Invalid("SessionLink cursor owner mismatch"));
    }
    if link.source_cursor.seq.is_empty()
        || (link.source_cursor.seq.len() > 1 && link.source_cursor.seq.starts_with('0'))
        || link.source_cursor.seq.parse::<u64>().is_err()
    {
        return Err(ManagedError::Invalid("SessionLink cursor sequence invalid"));
    }
    blake3_digest(&link.source_cursor.event_digest)?;
    if link.source_epoch == 0 || link.owner_epoch == 0 || link.protocol_version == 0 {
        return Err(ManagedError::Invalid(
            "SessionLink epoch or protocol version invalid",
        ));
    }
    if let Some(message_id) = &link.latest_observed_message_id {
        id(message_id)?;
    }
    if let Some(part_id) = &link.latest_observed_part_id {
        id(part_id)?;
    }
    digest(&link.source_digest)?;
    id(&link.redaction_profile)
}

impl ManagedSnapshot {
    /// Returns the first deterministic, independently unblocked Task candidate.
    ///
    /// This read-only selection does not admit an Attempt, reserve resources, or
    /// authorize dispatch. Callers must still submit `AdmitAttempt` against the
    /// current durable revision; this P2 implementation intentionally exposes at
    /// most one candidate and waits for independent verification before advancing.
    pub fn next_schedulable_task(&self, run_id: &str) -> Option<String> {
        let run = self.runs.get(run_id)?;
        if run.phase != RunPhase::Running
            || !self.session_links_pinned_at_start.contains(run_id)
            || run.tasks.values().any(|task| task.unknown_effect || task.pending_verification_attempt.is_some())
        {
            return None;
        }
        let spec = self.specs.get(&run.spec_id)?;
        run.tasks.iter().find_map(|(task_id, task)| {
            let prerequisites_passed = task.dependencies.iter().all(|dependency| {
                run.tasks
                    .get(dependency)
                    .is_some_and(|prior| prior.verified_revision.is_some())
            });
            (task.ready
                && task.active_attempt.is_none()
                && task.pending_verification_attempt.is_none()
                && !task.unknown_effect
                && task.verified_revision.is_none()
                && task.attempt_count < spec.content.budget.max_attempts_per_task
                && prerequisites_passed)
                .then(|| task_id.clone())
        })
    }

    pub fn attempt_delegation_binding(&self, attempt_id: &str) -> Option<&DelegationBindingV1> {
        self.attempts.get(attempt_id)?.delegation_binding.as_ref()
    }

    pub fn attempt_effect_bound_revision(
        &self,
        attempt_id: &str,
        effect_id: &str,
    ) -> Option<u64> {
        self.attempts
            .get(attempt_id)?
            .effects
            .iter()
            .find(|effect| effect.effect_id == effect_id)
            .map(|effect| effect.bound_revision)
    }

    fn apply(&mut self, command: &ManagedCommand) -> Result<(), ManagedError> {
        self.apply_with_replay_mode(command, false)
    }

    fn replay(&mut self, command: &ManagedCommand) -> Result<(), ManagedError> {
        self.apply_with_replay_mode(command, true)
    }

    fn apply_begin_verification(
        &mut self,
        run_id: &str,
        final_revision: &str,
        verifier_id: &str,
        receipt_basis_digest: Option<&str>,
        replaying_owner_log: bool,
    ) -> Result<(), ManagedError> {
        managed_digest(final_revision)?;
        principal(verifier_id)?;
        let live_attempt = {
            let run = self
                .runs
                .get(run_id)
                .ok_or(ManagedError::Conflict("run missing"))?;
            if matches!(run.phase, RunPhase::Running | RunPhase::Verifying) && run.tasks.len() == 1 {
                let (task_id, task) = run.tasks.iter().next().expect("single Task checked");
                let attempt_id = task.active_attempt.as_deref();
                attempt_id.and_then(|attempt_id| {
                    self.attempts.get(attempt_id).and_then(|attempt| {
                        (attempt.run_id == run_id
                            && attempt.task_id == *task_id
                            && attempt.phase == AttemptPhase::Executing
                            && (run.phase == RunPhase::Running
                                && task.pending_verification_attempt.is_none()
                                || run.phase == RunPhase::Verifying
                                    && task.pending_verification_attempt.as_deref() == Some(attempt_id)
                                    && run.final_revision.as_deref() == Some(final_revision)
                                    && run.verifier_id.as_deref() == Some(verifier_id))
                            && live_coding_workspace_head(attempt).ok().as_deref() == Some(final_revision))
                            .then(|| attempt_id.to_owned())
                    })
                })
            } else {
                None
            }
        };
        if let Some(attempt_id) = live_attempt.as_deref() {
            let task = self.runs.get(run_id)
                .and_then(|run| run.tasks.values().next())
                .ok_or(ManagedError::Conflict("live verification Task is missing"))?;
            if task.unknown_effect
                || task.pending_verification_attempt.as_deref().is_some_and(|pending| pending != attempt_id)
                || task.verified_revision.is_some() || task.active_attempt.as_deref() != Some(attempt_id)
            {
                return Err(ManagedError::Conflict("live verification Attempt is stale or already verified"));
            }
        }
        if let Some(expected) = receipt_basis_digest {
            blake3_digest(expected)?;
            let run = self
                .runs
                .get(run_id)
                .ok_or(ManagedError::Conflict("run missing"))?;
            let actual = successful_task_receipt_basis_digest(run_id, run, &self.attempts)?;
            if actual != expected {
                return Err(ManagedError::Conflict(
                    "verification receipt basis digest mismatch",
                ));
            }
        }

        let run = self
            .runs
            .get_mut(run_id)
            .ok_or(ManagedError::Conflict("run missing"))?;
        let revision_changed = run.phase == RunPhase::Verifying
            && run.final_revision.as_deref() != Some(final_revision);
        let current_revision_retry = run.phase == RunPhase::Verifying
            && run.final_revision.as_deref() == Some(final_revision)
            && run.verification_evidence.is_none()
            && run.criterion_evidence.is_empty();
        if run
            .verifier_id
            .as_deref()
            .is_some_and(|current| current != verifier_id)
        {
            return Err(ManagedError::Conflict("Run verifier assignment changed"));
        }
        let has_prior_typed_result = run.verification_evidence.is_some()
            || run
                .verification_history
                .iter()
                .any(|history| history.typed_evidence.is_some());
        let tasks_not_ready = if let Some(attempt_id) = live_attempt.as_deref() {
            run.tasks.len() != 1 || run.tasks.iter().any(|(task_id, task)| {
                task.unknown_effect
                    || task.active_attempt.as_deref() != Some(attempt_id)
                    || task.pending_verification_attempt.as_deref()
                        .is_some_and(|pending| pending != attempt_id)
                    || (run.phase == RunPhase::Running
                        && task.pending_verification_attempt.is_some())
                    || (run.phase == RunPhase::Verifying
                        && (task.pending_verification_attempt.as_deref() != Some(attempt_id)
                            || run.final_revision.as_deref() != Some(final_revision)
                            || run.verifier_id.as_deref() != Some(verifier_id)))
                    || !self.attempts.get(attempt_id).is_some_and(|attempt| {
                        attempt.run_id == run_id
                            && attempt.task_id == *task_id
                            && attempt.phase == AttemptPhase::Executing
                    })
            })
        } else { run.tasks.iter().any(|(task_id, task)| {
            if task.unknown_effect || task.active_attempt.is_some() {
                return true;
            }
            if let Some(attempt_id) = task.pending_verification_attempt.as_deref() {
                return !self.attempts.get(attempt_id).is_some_and(|attempt| {
                    attempt.run_id == run_id
                        && attempt.task_id == *task_id
                        && attempt.phase == AttemptPhase::Succeeded
                        && attempt.receipt_digest.is_some()
                });
            }
            // A previous typed verifier result may be rerun after the
            // current workspace changes. A legacy per-Task digest is only
            // replayable from historical OwnerLog events.
            !(replaying_owner_log && task.verified_revision.is_some())
                && (!has_prior_typed_result || task.verification_evidence.is_none())
        }) };
        let live_verification_retry = live_attempt.is_some()
            && run.phase == RunPhase::Verifying
            && run.final_revision.as_deref() == Some(final_revision)
            && run.verification_evidence.is_none()
            && run.criterion_evidence.is_empty();
        if !(run.phase == RunPhase::Running || revision_changed || current_revision_retry || live_verification_retry)
            || run.tasks.is_empty()
            || tasks_not_ready
        {
            return Err(ManagedError::Conflict(
                "run has unresolved or unsettled Tasks",
            ));
        }
        if revision_changed {
            let has_evidence =
                run.verification_evidence.is_some() || !run.criterion_evidence.is_empty();
            if has_evidence && run.verification_history.len() >= MAX_VERIFICATION_HISTORY {
                return Err(ManagedError::Conflict(
                    "verification history retention bound reached",
                ));
            }
            if has_evidence {
                run.verification_history
                    .push(VerificationEvidenceHistoryV1 {
                        source_revision: run.final_revision.clone(),
                        verifier_id: run.verifier_id.clone(),
                        typed_evidence: run.verification_evidence.take(),
                        criterion_evidence: std::mem::take(&mut run.criterion_evidence),
                    });
            }
        }
        run.phase = RunPhase::Verifying;
        run.final_revision = Some(final_revision.to_owned());
        run.verifier_id = Some(verifier_id.to_owned());
        if let Some(attempt_id) = live_attempt {
            let task = run.tasks.values_mut().next().expect("single live Task checked");
            task.pending_verification_attempt = Some(attempt_id);
        }
        // Only evidence for the currently frozen revision can finalize.
        // Historical proofs remain in verification_history for audit.
        run.verification_evidence = None;
        run.criterion_evidence.clear();
        Ok(())
    }

    fn apply_with_replay_mode(
        &mut self,
        command: &ManagedCommand,
        replaying_owner_log: bool,
    ) -> Result<(), ManagedError> {
        match command {
            ManagedCommand::CreateGoal { goal } => {
                validate_goal(goal)?;
                if self.goal.is_some() {
                    return Err(ManagedError::Conflict("goal already exists"));
                }
                self.goal = Some(Goal {
                    objective: goal.objective.clone(),
                    project_ref: goal.project_ref.clone(),
                    workspace_ref: goal.workspace_ref.clone(),
                    created_by: goal.created_by.clone(),
                    active_spec_version_id: None,
                });
            }
            ManagedCommand::CreateGoalProposal {
                goal,
                spec_id,
                spec,
                spec_digest,
            } => {
                validate_goal(goal)?;
                id(spec_id)?;
                validate_spec(spec)?;
                blake3_digest(spec_digest)?;
                if spec_digest != &spec.digest() {
                    return Err(ManagedError::Invalid("SpecVersion digest mismatch"));
                }
                if self.goal.is_some() {
                    return Err(ManagedError::Conflict("goal already exists"));
                }
                if goal.created_by != spec.proposed_by {
                    return Err(ManagedError::Conflict(
                        "Goal creator and initial SpecVersion proposer differ",
                    ));
                }
                if goal.objective != spec.objective {
                    return Err(ManagedError::Conflict(
                        "Goal and initial SpecVersion objectives differ",
                    ));
                }
                if spec.parent_version_id.is_some() {
                    return Err(ManagedError::Conflict(
                        "initial SpecVersion cannot have a parent",
                    ));
                }
                if spec.project_ref != goal.project_ref || spec.workspace_ref != goal.workspace_ref
                {
                    return Err(ManagedError::Conflict(
                        "SpecVersion project/workspace mismatch",
                    ));
                }
                if spec_draft_value(spec).to_string().len() > 512 * 1024 {
                    return Err(ManagedError::Invalid(
                        "SpecVersion exceeds durable payload limit",
                    ));
                }
                self.goal = Some(Goal {
                    objective: goal.objective.clone(),
                    project_ref: goal.project_ref.clone(),
                    workspace_ref: goal.workspace_ref.clone(),
                    created_by: goal.created_by.clone(),
                    active_spec_version_id: None,
                });
                self.specs.insert(
                    spec_id.clone(),
                    SpecVersion {
                        digest: spec_digest.clone(),
                        content: spec.clone(),
                        accepted: false,
                        accepted_by: None,
                        accepted_at_ms: None,
                        reviewer_id: None,
                        reviewer_assigned_revision: None,
                        reviewed_revision: None,
                        rejected_by: None,
                        rejected_at_ms: None,
                    },
                );
            }
            ManagedCommand::ProposeSpec {
                spec_id,
                spec,
                spec_digest,
            } => {
                id(spec_id)?;
                validate_spec(spec)?;
                blake3_digest(spec_digest)?;
                if spec_digest != &spec.digest() {
                    return Err(ManagedError::Invalid("SpecVersion digest mismatch"));
                }
                let goal = self
                    .goal
                    .as_ref()
                    .ok_or(ManagedError::Conflict("goal not created"))?;
                if spec.project_ref != goal.project_ref || spec.workspace_ref != goal.workspace_ref
                {
                    return Err(ManagedError::Conflict(
                        "SpecVersion project/workspace mismatch",
                    ));
                }
                if spec_draft_value(spec).to_string().len() > 512 * 1024 {
                    return Err(ManagedError::Invalid(
                        "SpecVersion exceeds durable payload limit",
                    ));
                }
                if let Some(parent_id) = &spec.parent_version_id {
                    let parent = self
                        .specs
                        .get(parent_id)
                        .ok_or(ManagedError::Conflict("parent SpecVersion missing"))?;
                    if !(parent.accepted || parent.rejected_by.is_some())
                        || parent.content.project_ref != spec.project_ref
                        || parent.content.workspace_ref != spec.workspace_ref
                    {
                        return Err(ManagedError::Conflict("parent SpecVersion is not accepted"));
                    }
                }
                if self.goal.is_none() {
                    return Err(ManagedError::Conflict("goal not created"));
                }
                if self.specs.contains_key(spec_id) {
                    return Err(ManagedError::Conflict("spec ID already used"));
                }
                self.specs.insert(
                    spec_id.clone(),
                    SpecVersion {
                        digest: spec_digest.clone(),
                        content: spec.clone(),
                        accepted: false,
                        accepted_by: None,
                        accepted_at_ms: None,
                        reviewer_id: None,
                        reviewer_assigned_revision: None,
                        reviewed_revision: None,
                        rejected_by: None,
                        rejected_at_ms: None,
                    },
                );
            }
            ManagedCommand::AssignSpecReviewer {
                spec_id,
                spec_digest,
                reviewer_id,
            } => {
                id(spec_id)?;
                blake3_digest(spec_digest)?;
                principal(reviewer_id)?;
                let spec = self
                    .specs
                    .get_mut(spec_id)
                    .ok_or(ManagedError::Conflict("spec not proposed"))?;
                if spec.digest != *spec_digest || spec.content.digest() != *spec_digest {
                    return Err(ManagedError::Conflict(
                        "reviewed SpecVersion digest is stale",
                    ));
                }
                if spec.content.proposed_by == *reviewer_id {
                    return Err(ManagedError::Conflict(
                        "SpecVersion author cannot review it",
                    ));
                }
                if spec.accepted || spec.rejected_by.is_some() {
                    return Err(ManagedError::Conflict(
                        "SpecVersion is no longer awaiting review",
                    ));
                }
                if let Some(assigned) = &spec.reviewer_id {
                    return Err(if assigned == reviewer_id {
                        ManagedError::Conflict("reviewer already assigned")
                    } else {
                        ManagedError::Conflict("a different reviewer is already assigned")
                    });
                }
                spec.reviewer_id = Some(reviewer_id.clone());
                spec.reviewer_assigned_revision = Some(self.revision);
            }
            ManagedCommand::AcceptSpec {
                spec_id,
                spec_digest,
                accepted_by,
                accepted_at_ms,
            } => {
                id(spec_id)?;
                blake3_digest(spec_digest)?;
                principal(accepted_by)?;
                if *accepted_at_ms == 0 || *accepted_at_ms > 9_007_199_254_740_991 {
                    return Err(ManagedError::Invalid("SpecVersion acceptance time invalid"));
                }
                let proposed = self
                    .specs
                    .get(spec_id)
                    .ok_or(ManagedError::Conflict("spec not proposed"))?;
                if proposed.digest.as_str() != spec_digest.as_str()
                    || proposed.content.digest().as_str() != spec_digest.as_str()
                {
                    return Err(ManagedError::Conflict(
                        "accepted SpecVersion digest is stale",
                    ));
                }
                if proposed.rejected_by.is_some() {
                    return Err(ManagedError::Conflict("rejected SpecVersion is immutable"));
                }
                if proposed.reviewer_id.as_deref() != Some(accepted_by.as_str()) {
                    return Err(ManagedError::Conflict(
                        "reviewer is not assigned to this SpecVersion",
                    ));
                }
                if proposed.content.proposed_by.as_str() == accepted_by.as_str() {
                    return Err(ManagedError::Conflict(
                        "SpecVersion author cannot approve it",
                    ));
                }
                if proposed
                    .reviewer_assigned_revision
                    .and_then(|revision| revision.checked_add(1))
                    != Some(self.revision)
                {
                    return Err(ManagedError::Conflict("review assignment is stale"));
                }
                if proposed.accepted {
                    return Err(ManagedError::Conflict("spec already accepted"));
                }
                let spec = self
                    .specs
                    .get_mut(spec_id)
                    .ok_or(ManagedError::Conflict("spec not proposed"))?;
                spec.accepted = true;
                spec.accepted_by = Some(accepted_by.clone());
                spec.accepted_at_ms = Some(*accepted_at_ms);
                spec.reviewed_revision = Some(self.revision);
                self.goal
                    .as_mut()
                    .ok_or(ManagedError::Conflict("goal missing"))?
                    .active_spec_version_id = Some(spec_id.clone());
            }
            ManagedCommand::RejectSpec {
                spec_id,
                spec_digest,
                rejected_by,
                rejected_at_ms,
            } => {
                id(spec_id)?;
                blake3_digest(spec_digest)?;
                principal(rejected_by)?;
                if *rejected_at_ms == 0 || *rejected_at_ms > 9_007_199_254_740_991 {
                    return Err(ManagedError::Invalid("SpecVersion rejection time invalid"));
                }
                let proposed = self
                    .specs
                    .get(spec_id)
                    .ok_or(ManagedError::Conflict("spec not proposed"))?;
                if proposed.digest.as_str() != spec_digest.as_str()
                    || proposed.content.digest().as_str() != spec_digest.as_str()
                {
                    return Err(ManagedError::Conflict(
                        "rejected SpecVersion digest is stale",
                    ));
                }
                if proposed.accepted || proposed.rejected_by.is_some() {
                    return Err(ManagedError::Conflict(
                        "SpecVersion is no longer awaiting review",
                    ));
                }
                if proposed.reviewer_id.as_deref() != Some(rejected_by.as_str()) {
                    return Err(ManagedError::Conflict(
                        "reviewer is not assigned to this SpecVersion",
                    ));
                }
                if proposed
                    .reviewer_assigned_revision
                    .and_then(|revision| revision.checked_add(1))
                    != Some(self.revision)
                {
                    return Err(ManagedError::Conflict("review assignment is stale"));
                }
                let spec = self
                    .specs
                    .get_mut(spec_id)
                    .ok_or(ManagedError::Conflict("spec not proposed"))?;
                spec.rejected_by = Some(rejected_by.clone());
                spec.rejected_at_ms = Some(*rejected_at_ms);
                spec.reviewed_revision = Some(self.revision);
            }
            ManagedCommand::StartRun { run_id, spec_id } => {
                id(run_id)?;
                let goal = self
                    .goal
                    .as_ref()
                    .ok_or(ManagedError::Conflict("goal missing"))?;
                if goal.active_spec_version_id.as_deref() != Some(spec_id.as_str()) {
                    return Err(ManagedError::Conflict(
                        "Run must use the accepted active SpecVersion",
                    ));
                }
                let spec = self
                    .specs
                    .get(spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?;
                if !spec.accepted {
                    return Err(ManagedError::Conflict("spec not accepted"));
                }
                if self.runs.contains_key(run_id) {
                    return Err(ManagedError::Conflict("run ID already used"));
                }
                self.runs.insert(
                    run_id.clone(),
                    Run {
                        spec_id: spec_id.clone(),
                        phase: RunPhase::Running,
                        started_at_ms: None,
                        tasks: BTreeMap::new(),
                        session_link: None,
                        final_revision: None,
                        verifier_id: None,
                        criterion_evidence: BTreeMap::new(),
                        verification_evidence: None,
                        verification_history: Vec::new(),
                        failure_code: None,
                    },
                );
            }
            ManagedCommand::PlanRun { run_id, spec_id, spec_digest, tasks } => {
                id(run_id)?;
                blake3_digest(spec_digest)?;
                if tasks.is_empty() || tasks.len() > 256 {
                    return Err(ManagedError::Invalid("planned Task set is empty or over limit"));
                }
                let goal = self.goal.as_ref().ok_or(ManagedError::Conflict("goal missing"))?;
                if goal.active_spec_version_id.as_deref() != Some(spec_id.as_str()) {
                    return Err(ManagedError::Conflict("Run plan must use the accepted active SpecVersion"));
                }
                let spec = self.specs.get(spec_id).ok_or(ManagedError::Conflict("spec missing"))?;
                if !spec.accepted || spec.digest != *spec_digest || spec.digest != spec.content.digest() {
                    return Err(ManagedError::Conflict("Run plan SpecVersion is not current and accepted"));
                }
                if self.runs.contains_key(run_id) {
                    return Err(ManagedError::Conflict("run ID already used"));
                }
                if tasks.len() > usize::from(spec.content.budget.max_tasks) {
                    return Err(ManagedError::Conflict("accepted SpecVersion task budget exhausted"));
                }
                let task_ids = tasks.iter().map(|task| task.task_id.as_str()).collect::<BTreeSet<_>>();
                if task_ids.len() != tasks.len() {
                    return Err(ManagedError::Conflict("planned Task IDs are duplicated"));
                }
                let mut covered_criteria = BTreeSet::new();
                let mut planned = BTreeMap::new();
                for task in tasks {
                    id(&task.task_id)?;
                    if !task.agent_profile_revision.is_valid() || blake3_digest(&task.profile_owner_binding_digest).is_err() {
                        return Err(ManagedError::Invalid("planned Task AgentProfile pin is invalid"));
                    }
                    if task.dependencies.len() > 256 || task.criterion_ids.len() > 256 {
                        return Err(ManagedError::Invalid("planned Task bounds exceeded"));
                    }
                    validate_capability_ids(&task.required_capabilities, "Task required capabilities must be sorted and unique")?;
                    if task.required_capabilities.iter().any(|cap| !spec.content.capability_scope.contains(cap)) {
                        return Err(ManagedError::Conflict("Task capability is outside accepted SpecVersion scope"));
                    }
                    let mut dependencies = BTreeSet::new();
                    for dependency in &task.dependencies {
                        id(dependency)?;
                        if dependency == &task.task_id || !task_ids.contains(dependency.as_str()) || !dependencies.insert(dependency.clone()) {
                            return Err(ManagedError::Conflict("planned Task dependency is invalid or duplicated"));
                        }
                    }
                    let mut criteria = BTreeSet::new();
                    for criterion in &task.criterion_ids {
                        id(criterion)?;
                        if !spec.content.criteria.iter().any(|item| item.id == *criterion)
                            || !criteria.insert(criterion.clone()) || !covered_criteria.insert(criterion.clone()) {
                            return Err(ManagedError::Conflict("planned Task criteria are invalid or duplicated"));
                        }
                    }
                    planned.insert(task.task_id.clone(), task);
                }
                if covered_criteria.len() != spec.content.criteria.len()
                    || spec.content.criteria.iter().any(|criterion| !covered_criteria.contains(&criterion.id)) {
                    return Err(ManagedError::Conflict("planned Task set must cover every accepted criterion exactly once"));
                }
                // Kahn traversal rejects cycles before persisting a plan.
                let mut resolved = BTreeSet::new();
                while resolved.len() < planned.len() {
                    let before = resolved.len();
                    for (task_id, task) in &planned {
                        if !resolved.contains(task_id)
                            && task.dependencies.iter().all(|dependency| resolved.contains(dependency)) {
                            resolved.insert(task_id.clone());
                        }
                    }
                    if resolved.len() == before {
                        return Err(ManagedError::Conflict("planned Task dependency graph contains a cycle"));
                    }
                }
                let tasks = planned.into_iter().map(|(task_id, task)| (task_id, Task {
                    dependencies: task.dependencies.clone(),
                    criterion_ids: task.criterion_ids.clone(),
                    required_capabilities: task.required_capabilities.clone(),
                    agent_profile_revision: Some(task.agent_profile_revision.clone()),
                    profile_owner_binding_digest: Some(task.profile_owner_binding_digest.clone()),
                    ready: false,
                    active_attempt: None,
                    pending_verification_attempt: None,
                    unknown_effect: false,
                    verified_revision: None,
                    verification_evidence: None,
                    failed_criterion_ids: Vec::new(),
                    attempt_count: 0,
                    candidate_generation: 0,
                    title: Some(task.title.clone()),
                    purpose: Some(task.purpose.clone()),
                })).collect();
                self.runs.insert(run_id.clone(), Run {
                    spec_id: spec_id.clone(),
                    phase: RunPhase::Planned,
                    started_at_ms: None,
                    tasks,
                    session_link: None,
                    final_revision: None,
                    verifier_id: None,
                    criterion_evidence: BTreeMap::new(),
                    verification_evidence: None,
                    verification_history: Vec::new(),
                    failure_code: None,
                });
            }
            ManagedCommand::StartPlannedRun { run_id, spec_id, spec_digest, plan_digest, expected_goal_revision, started_by, session_link } => {
                principal(started_by)?;
                blake3_digest(spec_digest)?;
                if let Some(session_link) = session_link.as_ref() {
                    validate_session_link(session_link)?;
                }
                if *expected_goal_revision != self.revision {
                    return Err(ManagedError::Conflict("Goal revision changed before explicit Run start"));
                }
                let goal = self.goal.as_ref().ok_or(ManagedError::Conflict("goal missing"))?;
                if goal.active_spec_version_id.as_deref() != Some(spec_id.as_str()) {
                    return Err(ManagedError::Conflict("Run start SpecVersion is no longer active"));
                }
                let spec = self.specs.get(spec_id).ok_or(ManagedError::Conflict("spec missing"))?;
                if !spec.accepted || spec.digest != *spec_digest || spec.digest != spec.content.digest() {
                    return Err(ManagedError::Conflict("Run start requires the current accepted SpecVersion digest"));
                }
                let run = self.runs.get_mut(run_id).ok_or(ManagedError::Conflict("planned Run missing"))?;
                if run.phase != RunPhase::Planned || run.spec_id != *spec_id || run.tasks.is_empty()
                    || run.session_link.is_some()
                {
                    return Err(ManagedError::Conflict("Run is not a complete unstarted plan"));
                }
                if run.tasks.values().any(|task| task.ready || task.agent_profile_revision.is_none() || task.profile_owner_binding_digest.is_none()) {
                    return Err(ManagedError::Conflict("planned Run contains an incomplete or previously started Task set"));
                }
                if planned_task_set_digest(run) != *plan_digest {
                    return Err(ManagedError::Conflict("Run start task-plan digest does not match the durable plan"));
                }
                run.phase = RunPhase::Running;
                if let Some(session_link) = session_link {
                    run.session_link = Some(session_link.clone());
                    self.session_links_pinned_at_start.insert(run_id.clone());
                }
                for task in run.tasks.values_mut() {
                    // Only roots are immediately executable. Dependents become
                    // ready after their prerequisites are independently verified.
                    task.ready = task.dependencies.is_empty();
                }
            }
            ManagedCommand::AttachSessionLink { run_id, link } => {
                validate_session_link(link)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running || run.session_link.is_some() {
                    return Err(ManagedError::Conflict(
                        "Run cannot attach or rebind SessionLink",
                    ));
                }
                run.session_link = Some(link.clone());
            }
            ManagedCommand::AddTask {
                run_id,
                task_id,
                dependencies,
                criterion_ids,
                required_capabilities,
            } => {
                id(task_id)?;
                if dependencies.len() > 256 {
                    return Err(ManagedError::Invalid("too many dependencies"));
                }
                if criterion_ids.len() > 256 {
                    return Err(ManagedError::Invalid("too many Task criteria"));
                }
                validate_capability_ids(required_capabilities, "Task required capabilities must be sorted and unique")?;
                let spec_id = self
                    .runs
                    .get(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?
                    .spec_id
                    .clone();
                let spec = self
                    .specs
                    .get(&spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?;
                if criterion_ids.iter().any(|criterion_id| {
                    !spec.content.criteria.iter().any(|c| c.id == *criterion_id)
                }) {
                    return Err(ManagedError::Conflict(
                        "Task criterion is outside accepted SpecVersion",
                    ));
                }
                if required_capabilities
                    .iter()
                    .any(|capability| !spec.content.capability_scope.contains(capability))
                {
                    return Err(ManagedError::Conflict(
                        "Task required capability is outside accepted SpecVersion scope",
                    ));
                }
                let mut seen_criteria = BTreeSet::new();
                for criterion_id in criterion_ids {
                    id(criterion_id)?;
                    if !seen_criteria.insert(criterion_id) {
                        return Err(ManagedError::Invalid("duplicate Task criterion"));
                    }
                }
                let max_tasks = usize::from(spec.content.budget.max_tasks);
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running {
                    return Err(ManagedError::Conflict("run fenced"));
                }
                if run.tasks.contains_key(task_id) {
                    return Err(ManagedError::Conflict("task ID already used"));
                }
                if run.tasks.len() >= max_tasks {
                    return Err(ManagedError::Conflict(
                        "accepted SpecVersion task budget exhausted",
                    ));
                }
                let mut seen = BTreeSet::new();
                for dependency in dependencies {
                    id(dependency)?;
                    if dependency == task_id
                        || !run.tasks.contains_key(dependency)
                        || !seen.insert(dependency)
                    {
                        return Err(ManagedError::Conflict(
                            "task dependency invalid or duplicated",
                        ));
                    }
                }
                run.tasks.insert(
                    task_id.clone(),
                    Task {
                        dependencies: dependencies.clone(),
                        criterion_ids: criterion_ids.clone(),
                        required_capabilities: required_capabilities.clone(),
                        agent_profile_revision: None,
                        profile_owner_binding_digest: None,
                        ready: false,
                        active_attempt: None,
                        pending_verification_attempt: None,
                        unknown_effect: false,
                        verified_revision: None,
                        verification_evidence: None,
                        failed_criterion_ids: Vec::new(),
                        attempt_count: 0,
                    candidate_generation: 0,
                    title: None,
                    purpose: None,
                    },
                );
            }
            ManagedCommand::AddTaskPinnedProfile {
                run_id,
                task_id,
                dependencies,
                criterion_ids,
                required_capabilities,
                agent_profile_revision,
                profile_owner_binding_digest,
            } => {
                if !agent_profile_revision.is_valid() || blake3_digest(profile_owner_binding_digest).is_err() {
                    return Err(ManagedError::Invalid("Task AgentProfile revision reference is invalid"));
                }
                self.apply(&ManagedCommand::AddTask {
                    run_id: run_id.clone(),
                    task_id: task_id.clone(),
                    dependencies: dependencies.clone(),
                    criterion_ids: criterion_ids.clone(),
                    required_capabilities: required_capabilities.clone(),
                })?;
                self.runs
                    .get_mut(run_id)
                    .and_then(|run| run.tasks.get_mut(task_id))
                    .ok_or(ManagedError::Conflict("newly admitted Task missing"))?
                    .agent_profile_revision = Some(agent_profile_revision.clone());
                self.runs.get_mut(run_id).and_then(|run| run.tasks.get_mut(task_id))
                    .ok_or(ManagedError::Conflict("newly admitted Task missing"))?
                    .profile_owner_binding_digest = Some(profile_owner_binding_digest.clone());
            }
            ManagedCommand::MarkTaskReady { run_id, task_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running {
                    return Err(ManagedError::Conflict("run fenced"));
                }
                let dependencies = run
                    .tasks
                    .get(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?
                    .dependencies
                    .clone();
                let prerequisites_passed = dependencies.iter().all(|dependency| {
                    run.tasks
                        .get(dependency)
                        .is_some_and(|prior| prior.verified_revision.is_some())
                });
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.ready
                    || !prerequisites_passed
                    || task.unknown_effect
                    || task.active_attempt.is_some()
                    || task.pending_verification_attempt.is_some()
                {
                    return Err(ManagedError::Conflict(
                        "task dependencies not independently verified",
                    ));
                }
                task.ready = true;
            }
            ManagedCommand::AdmitAttemptWithDelegation {
                run_id,
                task_id,
                attempt_id,
                executor_principal,
                owner_epoch,
                location_id,
                session_id,
                binding,
            } => {
                if binding.admitted_managed_revision
                    != self
                        .revision
                        .checked_add(1)
                        .ok_or(ManagedError::Invalid("managed revision overflow"))?
                    || binding.owner_epoch != *owner_epoch
                    || binding.source_revision.is_empty()
                {
                    return Err(ManagedError::Conflict(
                        "atomic managed admission binding is stale",
                    ));
                }
                let base_revision = self.revision;
                self.apply(&ManagedCommand::AdmitAttempt {
                    run_id: run_id.clone(),
                    task_id: task_id.clone(),
                    attempt_id: attempt_id.clone(),
                    executor_principal: executor_principal.clone(),
                    owner_epoch: *owner_epoch,
                    location_id: location_id.clone(),
                    session_id: session_id.clone(),
                })?;
                self.revision = base_revision;
                self.apply(&ManagedCommand::StartAttempt {
                    run_id: run_id.clone(),
                    task_id: task_id.clone(),
                    attempt_id: attempt_id.clone(),
                })?;
                self.revision = base_revision;
                self.apply(&ManagedCommand::BindAttemptWorkspaceRevision {
                    attempt_id: attempt_id.clone(),
                    workspace_revision: binding.source_revision.clone(),
                })?;
                self.revision = base_revision;
                self.apply(&ManagedCommand::BindAttemptDelegation {
                    attempt_id: attempt_id.clone(),
                    binding: binding.clone(),
                })?;
                self.revision = base_revision;
            }
            ManagedCommand::AdmitAttempt {
                run_id,
                task_id,
                attempt_id,
                executor_principal,
                owner_epoch,
                location_id,
                session_id,
            } => {
                id(attempt_id)?;
                principal(executor_principal)?;
                id(location_id)?;
                id(session_id)?;
                if !self.session_links_pinned_at_start.contains(run_id) {
                    return Err(ManagedError::Conflict("Run root SessionLink was not pinned by explicit authenticated start"));
                }
                if *owner_epoch == 0 {
                    return Err(ManagedError::Invalid("Attempt owner epoch is zero"));
                }
                if self.attempts.contains_key(attempt_id) {
                    return Err(ManagedError::Conflict("attempt ID already used"));
                }
                let spec_id = self
                    .runs
                    .get(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?
                    .spec_id
                    .clone();
                let budget = &self
                    .specs
                    .get(&spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?
                    .content
                    .budget;
                let max_attempts = budget.max_attempts_per_task;
                // P2's accepted runtime is deliberately single-Attempt. A larger
                // reviewed budget is not permission to enable worker fan-out
                // before the authenticated worker/lease and verifier gates pass.
                let max_workers = usize::from(budget.max_workers.min(1));
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running {
                    return Err(ManagedError::Conflict("run fenced"));
                }
                // The accepted SpecVersion budget is an upper bound; this P2
                // implementation supports one Attempt until worker/lease and
                // independent-verifier gates pass. Active, UNKNOWN, and settled-
                // but-unverified Attempts all retain that slot.
                let active_attempts = run
                    .tasks
                    .values()
                    .filter(|task| {
                        task.active_attempt.is_some()
                            || task.pending_verification_attempt.is_some()
                            || task.unknown_effect
                    })
                    .count();
                if active_attempts >= max_workers {
                    return Err(ManagedError::Conflict(
                        "accepted SpecVersion worker budget exhausted",
                    ));
                }
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                // Without independent Task PASS, dependencies are never presumed satisfied.
                if !task.ready
                    || task.verified_revision.is_some()
                    || task.active_attempt.is_some()
                    || task.pending_verification_attempt.is_some()
                    || task.unknown_effect
                    || task.attempt_count >= max_attempts
                {
                    return Err(ManagedError::Conflict("task not ready for another attempt"));
                }
                task.active_attempt = Some(attempt_id.clone());
                task.attempt_count = task
                    .attempt_count
                    .checked_add(1)
                    .ok_or(ManagedError::Invalid("Task attempt count overflow"))?;
                self.attempts.insert(
                    attempt_id.clone(),
                    AttemptRecord {
                        run_id: run_id.clone(),
                        task_id: task_id.clone(),
                        executor_principal: executor_principal.clone(),
                        owner_epoch: *owner_epoch,
                        location_id: location_id.clone(),
                        session_id: session_id.clone(),
                        workspace_revision: None,
                        delegation_binding: None,
                        effects: Vec::new(),
                        effect_receipts: BTreeMap::new(),
                        verifier_intents: BTreeMap::new(),
                        verifier_evidence: None,
                        phase: AttemptPhase::Admitted,
                        receipt_digest: None,
                        failure_code: None,
                        retryable: None,
                    },
                );
            }
            ManagedCommand::BindAttemptWorkspaceRevision {
                attempt_id,
                workspace_revision,
            } => {
                id(attempt_id)?;
                blake3_digest(workspace_revision)?;
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.phase != AttemptPhase::Executing
                    || !attempt.effects.is_empty()
                    || attempt.workspace_revision.is_some()
                {
                    return Err(ManagedError::Conflict(
                        "workspace revision can only bind once before effect intents",
                    ));
                }
                attempt.workspace_revision = Some(workspace_revision.clone());
            }
            ManagedCommand::BindAttemptDelegation {
                attempt_id,
                binding,
            } => {
                id(attempt_id)?;
                let expected_revision = self
                    .revision
                    .checked_add(1)
                    .ok_or(ManagedError::Invalid("revision overflow"))?;
                let encoded = binding.to_value();
                if DelegationBindingV1::from_value(&encoded).as_ref() != Some(binding)
                    || binding.attempt_id != *attempt_id
                    || binding.admitted_managed_revision != expected_revision
                {
                    return Err(ManagedError::Invalid(
                        "delegation binding does not match its admission revision",
                    ));
                }
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("Attempt record missing"))?;
                let run = self
                    .runs
                    .get(&attempt.run_id)
                    .ok_or(ManagedError::Conflict("Run missing"))?;
                let task = run
                    .tasks
                    .get(&attempt.task_id)
                    .ok_or(ManagedError::Conflict("Task missing"))?;
                let spec = self
                    .specs
                    .get(&run.spec_id)
                    .ok_or(ManagedError::Conflict("accepted SpecVersion missing"))?;
                if attempt.phase != AttemptPhase::Executing
                    || attempt.delegation_binding.is_some()
                    || !attempt.effects.is_empty()
                    || attempt.workspace_revision.as_deref()
                        != Some(binding.source_revision.as_str())
                    || attempt.owner_epoch != binding.owner_epoch
                    || attempt.run_id != binding.run_id
                    || attempt.task_id != binding.task_id
                    || !spec.accepted
                    || spec.digest != binding.accepted_spec_digest
                    || binding.criteria_ids.iter().any(|criterion| {
                        !task
                            .criterion_ids
                            .iter()
                            .any(|accepted| accepted == criterion)
                    })
                {
                    return Err(ManagedError::Conflict(
                        "delegation binding is stale or outside accepted Attempt scope",
                    ));
                }
                attempt.delegation_binding = Some(binding.clone());
            }
            ManagedCommand::ConsumeManagedDispatch { record } => {
                for value in [record.goal_id.as_str(), record.run_id.as_str(), record.task_id.as_str(),
                    record.attempt_id.as_str(), record.handoff_id.as_str(), record.claimed_attempt_id.as_str(),
                    record.worker_execution_id.as_str(), record.claim_owner_log_id.as_str(),
                    record.process_incarnation.as_str(), record.delivery_id.as_str()] {
                    id(value)?;
                }
                // The 26/27-field records were emitted before the explicit child
                // Session pin. They remain replayable as historical terminal
                // facts, but an empty child Session can never authorize Core work.
                let legacy_consumption = record.session_id.is_empty();
                if !legacy_consumption {
                    id(&record.parent_session_id)?;
                    id(&record.session_id)?;
                } else if !record.parent_session_id.is_empty() {
                    id(&record.parent_session_id)?;
                }
                for value in [record.handoff_digest.as_str(), record.claimed_proof_digest.as_str(),
                    record.claimed_binding_digest.as_str(), record.pins_digest.as_str(),
                    record.claim_owner_log_event_digest.as_str(), record.claim_nonce.as_str(),
                    record.attached_binding_digest.as_str()] {
                    managed_digest(value)?;
                }
                if record.goal_id != self.owner_goal_id
                    || record.delivery_id.is_empty()
                    || record.expected_managed_revision != self.revision
                    || record.claimed_attempt_id != record.attempt_id
                    || record.claim_nonce != managed_dispatch_claim_nonce(record)
                    || record.claimed_proof_digest != managed_dispatch_claim_proof_digest(record)
                {
                    return Err(ManagedError::Conflict("managed dispatch proof is stale or malformed"));
                }
                if self.dispatch_consumptions.contains_key(&record.attempt_id) {
                    return Err(ManagedError::Conflict("managed Attempt prompt dispatch was already consumed"));
                }
                let run = self.runs.get(&record.run_id)
                    .ok_or(ManagedError::Conflict("managed dispatch Run is missing"))?;
                let task = run.tasks.get(&record.task_id)
                    .ok_or(ManagedError::Conflict("managed dispatch Task is missing"))?;
                let attempt = self.attempts.get(&record.attempt_id)
                    .ok_or(ManagedError::Conflict("managed dispatch Attempt is missing"))?;
                let spec = self.specs.get(&run.spec_id)
                    .ok_or(ManagedError::Conflict("managed dispatch accepted SpecVersion is missing"))?;
                let binding = attempt.delegation_binding.as_ref()
                    .ok_or(ManagedError::Conflict("managed dispatch DelegationBinding is missing"))?;
                let canonical_binding_digest = binding.digest()
                    .map_err(|_| ManagedError::Invalid("managed DelegationBinding digest failed"))?;
                let mut criteria = task.criterion_ids.clone();
                criteria.sort();
                if run.phase != RunPhase::Running
                    || task.active_attempt.as_deref() != Some(record.attempt_id.as_str())
                    || !task.ready
                    || task.unknown_effect
                    || attempt.phase != AttemptPhase::Executing
                    || attempt.run_id != record.run_id
                    || attempt.task_id != record.task_id
                    || (!legacy_consumption && (!self.session_links_pinned_at_start.contains(&record.run_id)
                        || run.session_link.as_ref()
                        .is_none_or(|link| link.session_id != record.parent_session_id))
                    )
                    || attempt.owner_epoch != record.owner_epoch
                    || binding.run_id != record.run_id
                    || binding.task_id != record.task_id
                    || binding.attempt_id != record.attempt_id
                    || (!legacy_consumption && attempt.session_id != record.session_id)
                    || (!legacy_consumption && attempt.delegation_binding.as_ref()
                        .is_none_or(|stored| stored != binding))
                    || binding.child_execution_id != record.worker_execution_id
                    || binding.owner_epoch != record.owner_epoch
                    || binding.accepted_spec_digest != spec.digest
                    || !spec.accepted
                    || spec.digest != spec.content.digest()
                    || self.goal.as_ref().and_then(|goal| goal.active_spec_version_id.as_deref())
                        != Some(run.spec_id.as_str())
                    || binding.profile_id.as_str() != task.agent_profile_revision.as_ref().map(|pin| pin.profile_id.as_str()).unwrap_or_default()
                    || task.agent_profile_revision.as_ref().is_none_or(|pin| {
                        pin.revision != binding.profile_revision || pin.definition_digest != binding.profile_digest
                    })
                    || binding.criteria_ids != criteria
                    || task.required_capabilities.iter().any(|capability| {
                        !spec.content.capability_scope.iter().any(|accepted| accepted == capability)
                    })
                    || binding.source_revision != attempt.workspace_revision.as_deref().unwrap_or_default()
                    || canonical_binding_digest != record.attached_binding_digest
                    || record.claimed_binding_digest != canonical_binding_digest
                {
                    return Err(ManagedError::Conflict("managed dispatch claim differs from the live Attempt, Task, profile, or binding"));
                }
                let consumed_revision = self.revision.checked_add(1)
                    .ok_or(ManagedError::Invalid("managed revision overflow"))?;
                let receipt = ManagedDispatchConsumedReceiptV1::from_record(record, consumed_revision);
                self.dispatch_consumptions.insert(record.attempt_id.clone(), receipt);
            }
            ManagedCommand::DispatchQuiesced { proof } => {
                for value in [&proof.goal_id, &proof.run_id, &proof.task_id,
                    &proof.parent_session_id, &proof.session_id, &proof.attempt_id,
                    &proof.handoff_id, &proof.consume_delivery_id, &proof.process_incarnation,
                    &proof.delivery_id] { id(value)?; }
                for digest in [&proof.handoff_digest, &proof.consume_receipt_digest,
                    &proof.child_session_event_digest, &proof.child_session_state_digest] {
                    managed_digest(digest)?;
                }
                if proof.goal_id != self.owner_goal_id || proof.owner_epoch == 0
                    || proof.child_session_sequence == 0 || proof.delivery_id.is_empty()
                {
                    return Err(ManagedError::Conflict("managed prompt quiescence proof is malformed"));
                }
                if self.dispatch_quiescence_proofs.contains_key(&proof.attempt_id) {
                    return Err(ManagedError::Conflict("managed child prompt was already marked quiescent"));
                }
                let consumed = self.dispatch_consumptions.get(&proof.attempt_id)
                    .ok_or(ManagedError::Conflict("managed prompt has no durable consume marker"))?;
                let run = self.runs.get(&proof.run_id)
                    .ok_or(ManagedError::Conflict("managed prompt Run is missing"))?;
                let task = run.tasks.get(&proof.task_id)
                    .ok_or(ManagedError::Conflict("managed prompt Task is missing"))?;
                let attempt = self.attempts.get(&proof.attempt_id)
                    .ok_or(ManagedError::Conflict("managed prompt Attempt is missing"))?;
                let binding = attempt.delegation_binding.as_ref()
                    .ok_or(ManagedError::Conflict("managed prompt DelegationBinding is missing"))?;
                let binding_digest = binding.digest()
                    .map_err(|_| ManagedError::Invalid("managed prompt binding digest failed"))?;
                if consumed.goal_id != proof.goal_id || consumed.run_id != proof.run_id
                    || consumed.task_id != proof.task_id || consumed.parent_session_id != proof.parent_session_id
                    || consumed.session_id != proof.session_id || consumed.attempt_id != proof.attempt_id
                    || consumed.handoff_id != proof.handoff_id || consumed.handoff_digest != proof.handoff_digest
                    || consumed.delivery_id != proof.consume_delivery_id
                    || consumed.receipt_digest != proof.consume_receipt_digest
                    || consumed.owner_epoch != proof.owner_epoch
                    || consumed.process_incarnation != proof.process_incarnation
                    || attempt.session_id != proof.session_id || attempt.owner_epoch != proof.owner_epoch
                    || attempt.run_id != proof.run_id || attempt.task_id != proof.task_id
                    || run.session_link.as_ref().is_none_or(|link| link.session_id != proof.parent_session_id)
                    || binding.run_id != proof.run_id || binding.task_id != proof.task_id
                    || binding.attempt_id != proof.attempt_id || binding_digest != consumed.binding_digest
                    || attempt.phase != AttemptPhase::Settling
                    || task.active_attempt.as_deref().is_some_and(|active| active != proof.attempt_id)
                    || attempt.effects.len() != attempt.effect_receipts.len()
                    || attempt.effects.iter().any(|effect| {
                        attempt.effect_receipts.get(&effect.effect_id).is_none_or(|receipt| {
                            receipt.outcome == AttemptEffectOutcomeV1::Unknown
                                || receipt.target_receipt_digest.is_none()
                                || receipt.after_workspace_revision.is_none()
                        })
                    })
                {
                    return Err(ManagedError::Conflict("managed prompt quiescence differs from consumed child or settled effect state"));
                }
                self.dispatch_quiescence_proofs.insert(proof.attempt_id.clone(), proof.clone());
            }
            ManagedCommand::AbandonPreAdmissionCandidate { proof } => {
                for value in [&proof.goal_id, &proof.run_id, &proof.task_id,
                    &proof.candidate_attempt_id, &proof.worker_execution_id, &proof.ticket_id,
                    &proof.tombstone_owner_log_id,
                    &proof.process_incarnation, &proof.delivery_id] { id(value)?; }
                blake3_digest(&proof.pins_digest)?;
                blake3_digest(&proof.tombstone_owner_log_event_digest)?;
                blake3_digest(&proof.reconciliation_proof_digest)?;
                blake3_digest(&proof.p8_receipt_digest)?;
                if proof.goal_id != self.owner_goal_id
                    || proof.delivery_id.is_empty()
                    || proof.expected_managed_revision != self.revision
                    || proof.task_revision != proof.expected_managed_revision
                    || proof.owner_epoch == 0
                    || proof.tombstone_owner_log_sequence == 0
                    || proof.expected_task_generation == u64::MAX {
                    return Err(ManagedError::Conflict("pre-admission tombstone proof is stale or malformed"));
                }
                if proof.disposition != crate::worker_durable::ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch
                    || proof.terminal_state != crate::resource_budget::ReservationState::Expired
                    || proof.worker_pool_revision == 0 {
                    return Err(ManagedError::Conflict("P8 candidate receipt is not an expired no-dispatch tombstone"));
                }
                let run = self.runs.get_mut(&proof.run_id)
                    .ok_or(ManagedError::Conflict("pre-admission candidate Run is missing"))?;
                let task = run.tasks.get_mut(&proof.task_id)
                    .ok_or(ManagedError::Conflict("pre-admission candidate Task is missing"))?;
                if run.phase != RunPhase::Running
                    || !task.ready || task.active_attempt.is_some()
                    || task.pending_verification_attempt.is_some() || task.unknown_effect
                    || task.candidate_generation != proof.expected_task_generation
                    || task.attempt_count != proof.expected_attempt_count
                    || proof.candidate_attempt_id != managed_task_attempt_candidate_id(
                        &proof.task_id, task.attempt_count, task.candidate_generation,
                    )
                    || self.attempts.contains_key(&proof.candidate_attempt_id)
                    || self.dispatch_consumptions.contains_key(&proof.candidate_attempt_id) {
                    return Err(ManagedError::Conflict("Task is not the exact READY pre-admission candidate"));
                }
                let next_generation = task.candidate_generation.checked_add(1)
                    .ok_or(ManagedError::Invalid("candidate generation overflow"))?;
                task.candidate_generation = next_generation;
                let managed_revision = self.revision.checked_add(1)
                    .ok_or(ManagedError::Invalid("managed revision overflow"))?;
                let canonical = json!({
                    "goalID": proof.goal_id, "runID": proof.run_id, "taskID": proof.task_id,
                    "candidateAttemptID": proof.candidate_attempt_id,
                    "attemptCount": proof.expected_attempt_count,
                    "workerExecutionID": proof.worker_execution_id,
                    "ticketID": proof.ticket_id,
                    "generation": next_generation.to_string(), "pinsDigest": proof.pins_digest,
                    "disposition": managed_candidate_disposition_wire(proof.disposition),
                    "terminalState": managed_candidate_terminal_wire(proof.terminal_state),
                    "tombstoneOwnerLogID": proof.tombstone_owner_log_id,
                    "tombstoneOwnerLogSequence": proof.tombstone_owner_log_sequence.to_string(),
                    "tombstoneOwnerLogEventDigest": proof.tombstone_owner_log_event_digest,
                    "workerPoolRevision": proof.worker_pool_revision.to_string(),
                    "reconciliationProofDigest": proof.reconciliation_proof_digest,
                    "p8ReceiptDigest": proof.p8_receipt_digest,
                    "ownerEpoch": proof.owner_epoch.to_string(),
                    "processIncarnation": proof.process_incarnation,
                    "managedRevision": managed_revision.to_string(), "deliveryID": proof.delivery_id,
                });
                let receipt = ManagedCandidateAbandonedReceiptV1 {
                    goal_id: proof.goal_id.clone(), run_id: proof.run_id.clone(),
                    task_id: proof.task_id.clone(), candidate_attempt_id: proof.candidate_attempt_id.clone(),
                    attempt_count: proof.expected_attempt_count,
                    worker_execution_id: proof.worker_execution_id.clone(), ticket_id: proof.ticket_id.clone(),
                    generation: next_generation, pins_digest: proof.pins_digest.clone(),
                    disposition: proof.disposition.clone(), terminal_state: proof.terminal_state.clone(),
                    tombstone_owner_log_id: proof.tombstone_owner_log_id.clone(),
                    tombstone_owner_log_sequence: proof.tombstone_owner_log_sequence,
                    tombstone_owner_log_event_digest: proof.tombstone_owner_log_event_digest.clone(),
                    worker_pool_revision: proof.worker_pool_revision,
                    reconciliation_proof_digest: proof.reconciliation_proof_digest.clone(),
                    p8_receipt_digest: proof.p8_receipt_digest.clone(),
                    managed_revision, delivery_id: proof.delivery_id.clone(),
                    receipt_digest: format!("blake3:{}", blake3::hash(canonical.to_string().as_bytes()).to_hex()),
                };
                self.candidate_abandonments.insert(proof.delivery_id.clone(), receipt);
            }
            ManagedCommand::BindAttemptEffect {
                run_id,
                task_id,
                attempt_id,
                effect_id,
                location_id,
                session_id,
            } => {
                id(effect_id)?;
                id(location_id)?;
                id(session_id)?;
                let run = self.runs.get(run_id).ok_or(ManagedError::Conflict("Run missing"))?;
                let task = run.tasks.get(task_id).ok_or(ManagedError::Conflict("Task missing"))?;
                if !matches!(run.phase, RunPhase::Running | RunPhase::Verifying)
                    || task.active_attempt.as_deref() != Some(attempt_id.as_str())
                    || (run.phase == RunPhase::Verifying
                        && task.pending_verification_attempt.as_deref() != Some(attempt_id.as_str()))
                {
                    return Err(ManagedError::Conflict("effect intent cannot bind outside a live Attempt"));
                }
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || attempt.phase != AttemptPhase::Executing
                    || attempt.delegation_binding.is_none()
                {
                    return Err(ManagedError::Conflict(
                        "only a bound executing Attempt can bind an effect",
                    ));
                }
                if attempt.effects.len() >= MAX_BOUND_EFFECTS_PER_ATTEMPT {
                    return Err(ManagedError::Conflict("too many bound Attempt effects"));
                }
                if run.phase == RunPhase::Running && !attempt.verifier_intents.is_empty() {
                    return Err(ManagedError::Conflict(
                        "coding effect edge cannot be appended after verifier intent staging begins",
                    ));
                }
                if attempt
                    .effects
                    .iter()
                    .any(|effect| effect.effect_id == *effect_id)
                {
                    return Err(ManagedError::Conflict("effect already bound to Attempt"));
                }
                attempt.effects.push(BoundEffect {
                    effect_id: effect_id.clone(),
                    location_id: location_id.clone(),
                    session_id: session_id.clone(),
                    bound_revision: self
                        .revision
                        .checked_add(1)
                        .ok_or(ManagedError::Invalid("revision overflow"))?,
                });
            }
            ManagedCommand::BindAttemptEffects {
                run_id,
                task_id,
                attempt_id,
                effect_ids,
                location_id,
                session_id,
            } => {
                id(location_id)?;
                id(session_id)?;
                if effect_ids.is_empty()
                    || effect_ids.len() > MAX_BOUND_EFFECTS_PER_ATTEMPT
                    || effect_ids.iter().any(|effect_id| id(effect_id).is_err())
                    || effect_ids.iter().collect::<BTreeSet<_>>().len() != effect_ids.len()
                {
                    return Err(ManagedError::Invalid(
                        "Attempt effect batch is empty, duplicated, or outside bounds",
                    ));
                }
                let run = self.runs.get(run_id).ok_or(ManagedError::Conflict("Run missing"))?;
                let task = run.tasks.get(task_id).ok_or(ManagedError::Conflict("Task missing"))?;
                if !matches!(run.phase, RunPhase::Running | RunPhase::Verifying)
                    || task.active_attempt.as_deref() != Some(attempt_id.as_str())
                    || (run.phase == RunPhase::Verifying
                        && task.pending_verification_attempt.as_deref() != Some(attempt_id.as_str()))
                {
                    return Err(ManagedError::Conflict("effect batch cannot bind outside a live Attempt"));
                }
                let attempt = self
                    .attempts
                    .get(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || attempt.phase != AttemptPhase::Executing
                    || attempt.delegation_binding.is_none()
                    || (run.phase == RunPhase::Running && !attempt.verifier_intents.is_empty())
                {
                    return Err(ManagedError::Conflict(
                        "only a bound executing Attempt can bind an effect batch",
                    ));
                }
                if attempt.effects.len().saturating_add(effect_ids.len())
                    > MAX_BOUND_EFFECTS_PER_ATTEMPT
                    || effect_ids.iter().any(|effect_id| {
                        attempt.effects.iter().any(|effect| effect.effect_id == *effect_id)
                    })
                {
                    return Err(ManagedError::Conflict(
                        "Attempt effect batch conflicts with existing edges or exceeds bounds",
                    ));
                }
                let bound_revision = self
                    .revision
                    .checked_add(1)
                    .ok_or(ManagedError::Invalid("revision overflow"))?;
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                attempt.effects.extend(effect_ids.iter().map(|effect_id| BoundEffect {
                    effect_id: effect_id.clone(),
                    location_id: location_id.clone(),
                    session_id: session_id.clone(),
                    bound_revision,
                }));
            }
            ManagedCommand::BindAttemptVerifierIntent { intent } => {
                for value in [
                    intent.goal_id.as_str(), intent.run_id.as_str(), intent.task_id.as_str(),
                    intent.attempt_id.as_str(), intent.effect_id.as_str(), intent.location_id.as_str(),
                    intent.session_id.as_str(), intent.capability_id.as_str(), intent.verifier_profile_id.as_str(),
                    intent.criterion_id.as_str(), intent.test_identity.as_str(),
                ] {
                    id(value)?;
                }
                principal(&intent.reviewer_principal)?;
                principal(&intent.verifier_principal)?;
                for digest_value in [
                    intent.executable_digest.as_str(), intent.profile_digest.as_str(), intent.arguments_digest.as_str(),
                    intent.source_workspace_revision.as_str(),
                ] {
                    managed_digest(digest_value)?;
                }
                if intent.goal_id != self.owner_goal_id || intent.owner_epoch == 0 || intent.bound_revision == 0
                    || intent.max_duration_ms == 0 || intent.max_output_bytes == 0
                {
                    return Err(ManagedError::Invalid("verifier intent scope or bounds are invalid"));
                }
                let run = self.runs.get(&intent.run_id).ok_or(ManagedError::Conflict("verifier Run is missing"))?;
                if !matches!(run.phase, RunPhase::Running | RunPhase::Verifying) {
                    return Err(ManagedError::Conflict("Run is fenced for verifier intent"));
                }
                let task = run.tasks.get(&intent.task_id).ok_or(ManagedError::Conflict("verifier Task is missing"))?;
                let spec = self.specs.get(&run.spec_id).ok_or(ManagedError::Conflict("accepted SpecVersion is missing"))?;
                let attempt = self.attempts.get(&intent.attempt_id).ok_or(ManagedError::Conflict("verifier Attempt is missing"))?;
                let edge = attempt.effects.iter().find(|effect| effect.effect_id == intent.effect_id);
                let binding = attempt.delegation_binding.as_ref().ok_or(ManagedError::Conflict("Attempt delegation binding is missing"))?;
                if attempt.run_id != intent.run_id || attempt.task_id != intent.task_id
                    || attempt.phase != AttemptPhase::Executing
                    || task.active_attempt.as_deref() != Some(intent.attempt_id.as_str())
                    || run.phase == RunPhase::Verifying
                        && task.pending_verification_attempt.as_deref() != Some(intent.attempt_id.as_str())
                    || intent.reviewer_principal != spec.reviewer_id.as_deref().unwrap_or_default()
                    || intent.reviewer_principal == attempt.executor_principal
                    || intent.verifier_principal == intent.reviewer_principal
                    || attempt.executor_principal == intent.verifier_principal
                    || spec.content.proposed_by == intent.verifier_principal
                    || spec.accepted_by.as_deref() == Some(intent.verifier_principal.as_str())
                    || spec.reviewer_id.as_deref() == Some(intent.verifier_principal.as_str())
                    || !spec.accepted
                    || !task.criterion_ids.iter().any(|criterion| criterion == &intent.criterion_id)
                    || !task.required_capabilities.iter().any(|capability| capability == &intent.capability_id)
                    || !spec.content.capability_scope.iter().any(|capability| capability == &intent.capability_id)
                    || binding.attempt_id != intent.attempt_id
                    || binding.owner_epoch != intent.owner_epoch
                    || attempt.owner_epoch != intent.owner_epoch
                    || attempt.location_id != intent.location_id
                    || attempt.session_id != intent.session_id
                    || edge.is_none_or(|effect| effect.bound_revision != intent.bound_revision
                        || effect.location_id != intent.location_id || effect.session_id != intent.session_id)
                    || attempt.verifier_intents.contains_key(&intent.effect_id)
                    || attempt.effect_receipts.contains_key(&intent.effect_id)
                {
                    return Err(ManagedError::Conflict("verifier intent is stale or outside live Attempt scope"));
                }
                let aggregate_duration = attempt.verifier_intents.values()
                    .map(|existing| existing.max_duration_ms)
                    .try_fold(intent.max_duration_ms, |sum, value| sum.checked_add(value))
                    .ok_or(ManagedError::Invalid("verifier duration bound overflow"))?;
                let aggregate_output = attempt.verifier_intents.values()
                    .map(|existing| existing.max_output_bytes)
                    .try_fold(intent.max_output_bytes, |sum, value| sum.checked_add(value))
                    .ok_or(ManagedError::Invalid("verifier output bound overflow"))?;
                if intent.max_duration_ms > spec.content.budget.max_run_duration_ms
                    || aggregate_duration > spec.content.budget.max_run_duration_ms
                    || intent.max_output_bytes > MAX_VERIFIER_CRITERION_OUTPUT_BYTES
                    || aggregate_output > MAX_VERIFIER_RUN_OUTPUT_BYTES
                {
                    return Err(ManagedError::Invalid(
                        "verifier intent exceeds accepted run duration or output budget",
                    ));
                }
                // Verifier work is admitted only after the coding effects have
                // durable successful receipts. The same Attempt remains live;
                // the last coding edge pins the revision every verifier observes.
                let expected_head = attempt_workspace_revision_before(attempt, &intent.effect_id, true)?;
                let has_coding_edge = attempt.effects.iter()
                    .take_while(|effect| effect.effect_id != intent.effect_id)
                    .any(|effect| !attempt.verifier_intents.contains_key(&effect.effect_id));
                if !has_coding_edge || expected_head != intent.source_workspace_revision {
                    return Err(ManagedError::Conflict(
                        "verifier intent requires successful coding receipts at its ordered workspace head",
                    ));
                }
                if attempt.verifier_intents.values().any(|existing| {
                    existing.reviewer_principal != intent.reviewer_principal
                        || existing.verifier_principal != intent.verifier_principal
                        || existing.owner_epoch != intent.owner_epoch
                        || existing.location_id != intent.location_id
                        || existing.session_id != intent.session_id
                        || existing.verifier_profile_id != intent.verifier_profile_id
                        || existing.executable_digest != intent.executable_digest
                        || existing.profile_digest != intent.profile_digest
                        || existing.source_workspace_revision != intent.source_workspace_revision
                        || existing.max_duration_ms != intent.max_duration_ms
                        || existing.max_output_bytes != intent.max_output_bytes
                        || existing.criterion_id == intent.criterion_id
                }) {
                    return Err(ManagedError::Conflict(
                        "verifier intents for one Attempt must share one immutable profile and distinct criteria",
                    ));
                }
                let attempt = self.attempts.get_mut(&intent.attempt_id).expect("checked Attempt exists");
                attempt.verifier_intents.insert(intent.effect_id.clone(), intent.clone());
            }
            ManagedCommand::RecordAttemptEffectReceipt { proof } => {
                for value in [proof.goal_id.as_str(), proof.run_id.as_str(), proof.task_id.as_str(),
                    proof.attempt_id.as_str(), proof.effect_id.as_str(), proof.location_id.as_str(),
                    proof.session_id.as_str(), proof.capability_id.as_str()] { id(value)?; }
                principal(&proof.executor_principal)?;
                managed_digest(&proof.capability_lease_digest)?;
                managed_digest(&proof.before_workspace_revision)?;
                if let Some(value) = proof.target_receipt_digest.as_deref() { managed_digest(value)?; }
                if let Some(value) = proof.after_workspace_revision.as_deref() { managed_digest(value)?; }
                let run = self.runs.get(&proof.run_id).ok_or(ManagedError::Conflict("receipt Run is missing"))?;
                let task = run.tasks.get(&proof.task_id).ok_or(ManagedError::Conflict("receipt Task is missing"))?;
                let attempt = self.attempts.get(&proof.attempt_id).ok_or(ManagedError::Conflict("receipt Attempt is missing"))?;
                let edge = attempt.effects.iter().find(|effect| effect.effect_id == proof.effect_id)
                    .ok_or(ManagedError::Conflict("receipt has no exact bound EffectIntent edge"))?;
                let expected_before = attempt_workspace_revision_before(attempt, &proof.effect_id, false)?;
                let expected_principal = attempt.verifier_intents.get(&proof.effect_id)
                    .map(|intent| intent.verifier_principal.as_str())
                    .unwrap_or(attempt.executor_principal.as_str());
                if proof.goal_id != self.owner_goal_id || attempt.run_id != proof.run_id || attempt.task_id != proof.task_id
                    || expected_principal != proof.executor_principal || attempt.owner_epoch != proof.owner_epoch
                    || attempt.phase != AttemptPhase::Executing || task.active_attempt.as_deref() != Some(proof.attempt_id.as_str())
                    || edge.bound_revision != proof.bound_revision || edge.location_id != proof.location_id
                    || edge.session_id != proof.session_id || attempt.location_id != proof.location_id
                    || attempt.session_id != proof.session_id || expected_before != proof.before_workspace_revision
                    || attempt.effect_receipts.contains_key(&proof.effect_id)
                {
                    return Err(ManagedError::Conflict("effect receipt is stale or does not match its live Attempt edge"));
                }
                let verifier_intent = attempt.verifier_intents.get(&proof.effect_id);
                if verifier_intent.is_some_and(|intent| intent.capability_id != proof.capability_id
                    || intent.owner_epoch != proof.owner_epoch || intent.bound_revision != proof.bound_revision)
                {
                    return Err(ManagedError::Conflict("verifier receipt differs from its immutable intent"));
                }
                if verifier_intent.is_some_and(|intent| {
                    proof.before_workspace_revision != intent.source_workspace_revision
                        || proof.after_workspace_revision.as_deref()
                            != Some(intent.source_workspace_revision.as_str())
                }) {
                    return Err(ManagedError::Conflict(
                        "read-only verifier receipt changed or did not use its pinned workspace revision",
                    ));
                }
                match proof.outcome {
                    AttemptEffectOutcomeV1::Succeeded | AttemptEffectOutcomeV1::Failed
                        if proof.target_receipt_digest.is_none() || proof.after_workspace_revision.is_none() =>
                    {
                        return Err(ManagedError::Invalid("settled effect receipt is missing target or revision evidence"));
                    }
                    AttemptEffectOutcomeV1::Unknown if proof.after_workspace_revision.is_some() => {
                        return Err(ManagedError::Invalid("UNKNOWN effect cannot claim an after-workspace revision"));
                    }
                    _ => {}
                }
                let receipt = ManagedAttemptEffectReceiptV1 {
                    executor_principal: proof.executor_principal.clone(), owner_epoch: proof.owner_epoch,
                    bound_revision: proof.bound_revision, location_id: proof.location_id.clone(),
                    session_id: proof.session_id.clone(), capability_id: proof.capability_id.clone(),
                    capability_lease_digest: proof.capability_lease_digest.clone(), outcome: proof.outcome,
                    target_receipt_digest: proof.target_receipt_digest.clone(),
                    before_workspace_revision: proof.before_workspace_revision.clone(),
                    after_workspace_revision: proof.after_workspace_revision.clone(),
                };
                self.attempts.get_mut(&proof.attempt_id).expect("checked Attempt exists")
                    .effect_receipts.insert(proof.effect_id.clone(), receipt);
                if proof.outcome == AttemptEffectOutcomeV1::Unknown {
                    let run = self.runs.get_mut(&proof.run_id).expect("checked Run exists");
                    let task = run.tasks.get_mut(&proof.task_id).expect("checked Task exists");
                    task.unknown_effect = true;
                    self.attempts.get_mut(&proof.attempt_id).expect("checked Attempt exists").phase = AttemptPhase::Unknown;
                    run.phase = RunPhase::Reconciling;
                }
            }
            ManagedCommand::ReconcileAttemptEffectReceipt { proof } => {
                for value in [proof.goal_id.as_str(), proof.run_id.as_str(), proof.task_id.as_str(),
                    proof.attempt_id.as_str(), proof.effect_id.as_str(), proof.location_id.as_str(),
                    proof.session_id.as_str(), proof.capability_id.as_str()] { id(value)?; }
                principal(&proof.executor_principal)?;
                managed_digest(&proof.capability_lease_digest)?;
                managed_digest(&proof.before_workspace_revision)?;
                let target_receipt_digest = proof.target_receipt_digest.as_deref()
                    .ok_or(ManagedError::Invalid("reconciled effect receipt is missing target evidence"))?;
                let after_workspace_revision = proof.after_workspace_revision.as_deref()
                    .ok_or(ManagedError::Invalid("reconciled effect receipt is missing observed workspace revision"))?;
                managed_digest(target_receipt_digest)?;
                managed_digest(after_workspace_revision)?;
                if proof.outcome == AttemptEffectOutcomeV1::Unknown {
                    return Err(ManagedError::Invalid("reconciliation requires a terminal target outcome"));
                }

                let run = self.runs.get(&proof.run_id).ok_or(ManagedError::Conflict("reconciliation Run is missing"))?;
                let task = run.tasks.get(&proof.task_id).ok_or(ManagedError::Conflict("reconciliation Task is missing"))?;
                let attempt = self.attempts.get(&proof.attempt_id).ok_or(ManagedError::Conflict("reconciliation Attempt is missing"))?;
                let edge = attempt.effects.iter().find(|effect| effect.effect_id == proof.effect_id)
                    .ok_or(ManagedError::Conflict("reconciliation has no exact bound effect edge"))?;
                let existing = attempt.effect_receipts.get(&proof.effect_id);
                let first_unresolved = attempt.effects.iter().find(|effect| {
                    attempt.effect_receipts.get(&effect.effect_id).is_none_or(|receipt|
                        receipt.outcome == AttemptEffectOutcomeV1::Unknown)
                });
                let expected_principal = attempt.verifier_intents.get(&proof.effect_id)
                    .map(|intent| intent.verifier_principal.as_str())
                    .unwrap_or(attempt.executor_principal.as_str());
                let expected_before = attempt_workspace_revision_before(attempt, &proof.effect_id, false)?;
                if proof.goal_id != self.owner_goal_id
                    || !matches!(run.phase, RunPhase::Reconciling | RunPhase::Cancelling)
                    || task.active_attempt.as_deref() != Some(proof.attempt_id.as_str())
                    || !task.unknown_effect
                    || attempt.phase != AttemptPhase::Unknown
                    || attempt.run_id != proof.run_id || attempt.task_id != proof.task_id
                    || expected_principal != proof.executor_principal
                    || attempt.owner_epoch != proof.owner_epoch
                    || edge.bound_revision != proof.bound_revision
                    || edge.location_id != proof.location_id || edge.session_id != proof.session_id
                    || attempt.location_id != proof.location_id || attempt.session_id != proof.session_id
                    || expected_before != proof.before_workspace_revision
                    || first_unresolved.is_none_or(|unresolved| unresolved.effect_id != proof.effect_id)
                {
                    return Err(ManagedError::Conflict("reconciliation proof is stale or does not target the first unresolved live Attempt edge"));
                }
                if let Some(intent) = attempt.verifier_intents.get(&proof.effect_id) {
                    if intent.capability_id != proof.capability_id
                        || intent.owner_epoch != proof.owner_epoch
                        || intent.bound_revision != proof.bound_revision
                        || intent.source_workspace_revision != proof.before_workspace_revision
                        || proof.after_workspace_revision.as_deref() != Some(intent.source_workspace_revision.as_str())
                    {
                        return Err(ManagedError::Conflict("reconciled verifier receipt differs from its immutable read-only intent"));
                    }
                }
                if let Some(previous) = existing {
                    if previous.outcome != AttemptEffectOutcomeV1::Unknown
                        || previous.executor_principal != proof.executor_principal
                        || previous.owner_epoch != proof.owner_epoch
                        || previous.bound_revision != proof.bound_revision
                        || previous.location_id != proof.location_id
                        || previous.session_id != proof.session_id
                        || previous.capability_id != proof.capability_id
                        || previous.capability_lease_digest != proof.capability_lease_digest
                        || previous.before_workspace_revision != proof.before_workspace_revision
                    {
                        return Err(ManagedError::Conflict("reconciled receipt changes immutable UNKNOWN effect identity"));
                    }
                }
                let receipt = ManagedAttemptEffectReceiptV1 {
                    executor_principal: proof.executor_principal.clone(),
                    owner_epoch: proof.owner_epoch,
                    bound_revision: proof.bound_revision,
                    location_id: proof.location_id.clone(),
                    session_id: proof.session_id.clone(),
                    capability_id: proof.capability_id.clone(),
                    capability_lease_digest: proof.capability_lease_digest.clone(),
                    outcome: proof.outcome,
                    target_receipt_digest: proof.target_receipt_digest.clone(),
                    before_workspace_revision: proof.before_workspace_revision.clone(),
                    after_workspace_revision: proof.after_workspace_revision.clone(),
                };
                self.attempts.get_mut(&proof.attempt_id).expect("checked Attempt exists")
                    .effect_receipts.insert(proof.effect_id.clone(), receipt);
                // Preserve UNKNOWN/RECONCILING as the no-dispatch fence until every
                // edge has been independently reconciled and HostKernel explicitly
                // requests failure settlement. Reconciliation never re-enters RUNNING.
            }
            ManagedCommand::RecordAttemptVerifierEvidence { attempt_id, evidence } => {
                validate_verification_evidence(evidence)?;
                if evidence.evidence_digest != verification_evidence_digest(evidence) {
                    return Err(ManagedError::Conflict("Attempt verifier evidence digest mismatch"));
                }
                let attempt = self.attempts.get(attempt_id).ok_or(ManagedError::Conflict("verifier Attempt is missing"))?;
                let run = self.runs.get(&attempt.run_id).ok_or(ManagedError::Conflict("verifier Run is missing"))?;
                let task = run.tasks.get(&attempt.task_id).ok_or(ManagedError::Conflict("verifier Task is missing"))?;
                let spec = self.specs.get(&run.spec_id).ok_or(ManagedError::Conflict("accepted SpecVersion is missing"))?;
                if attempt.phase != AttemptPhase::Executing || run.phase != RunPhase::Verifying
                    || task.active_attempt.as_deref() != Some(attempt_id.as_str())
                    || task.pending_verification_attempt.as_deref() != Some(attempt_id.as_str())
                    || run.final_revision.as_deref() != Some(evidence.source_revision.as_str())
                    || attempt.verifier_evidence.is_some()
                    || evidence.verifier_id == attempt.executor_principal
                    || evidence.verifier_id == spec.content.proposed_by
                    || spec.accepted_by.as_deref() == Some(evidence.verifier_id.as_str())
                    || spec.reviewer_id.as_deref() == Some(evidence.verifier_id.as_str())
                    || evidence.profile.owner_epoch != attempt.owner_epoch
                    || evidence.aggregate_duration_ms > spec.content.budget.max_run_duration_ms
                {
                    return Err(ManagedError::Conflict("verifier evidence is stale, duplicated, or outside live Attempt authority"));
                }
                if attempt.effects.len() != attempt.effect_receipts.len()
                    || attempt.effects.iter().any(|effect| {
                        let Some(receipt) = attempt.effect_receipts.get(&effect.effect_id) else { return true };
                        receipt.outcome == AttemptEffectOutcomeV1::Unknown
                            || (receipt.outcome == AttemptEffectOutcomeV1::Failed
                                && !attempt.verifier_intents.contains_key(&effect.effect_id))
                    })
                {
                    return Err(ManagedError::Conflict("verifier evidence requires every coding and verifier effect receipt to be durably settled"));
                }
                let accepted: BTreeSet<&str> = spec.content.criteria.iter().map(|criterion| criterion.id.as_str()).collect();
                let supplied: BTreeSet<&str> = evidence.criteria.iter().map(|criterion| criterion.criterion_id.as_str()).collect();
                if accepted.is_empty() || accepted != supplied {
                    return Err(ManagedError::Conflict("live Attempt verifier evidence must cover the exact accepted criteria"));
                }
                let intents = attempt.verifier_intents.values().collect::<Vec<_>>();
                if intents.len() != evidence.criteria.len() || intents.iter().any(|intent| {
                    intent.attempt_id != *attempt_id
                        || intent.verifier_principal != evidence.verifier_id
                        || intent.verifier_profile_id != evidence.profile.profile_id
                        || intent.executable_digest != evidence.profile.executable_digest
                        || intent.profile_digest != evidence.profile.profile_digest
                        || intent.owner_epoch != evidence.profile.owner_epoch
                        || intent.source_workspace_revision != evidence.source_revision
                        || !attempt.effect_receipts.get(&intent.effect_id).is_some_and(|receipt| {
                            receipt.outcome != AttemptEffectOutcomeV1::Unknown
                                && receipt.after_workspace_revision.as_deref() == Some(evidence.source_revision.as_str())
                        })
                }) {
                    return Err(ManagedError::Conflict("typed verifier evidence differs from persisted per-criterion intent or receipt"));
                }
                for intent in &intents {
                    if !evidence.criteria.iter().any(|criterion| criterion.criterion_id == intent.criterion_id
                        && criterion.test_identity == intent.test_identity)
                    {
                        return Err(ManagedError::Conflict("typed verifier result does not match its exact criterion/test intent"));
                    }
                }
                self.attempts.get_mut(attempt_id).expect("checked Attempt exists").verifier_evidence = Some(evidence.clone());
            }
            ManagedCommand::StartAttempt {
                run_id,
                task_id,
                attempt_id,
            } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running {
                    return Err(ManagedError::Conflict("run fenced"));
                }
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.active_attempt.as_deref() != Some(attempt_id) || task.unknown_effect {
                    return Err(ManagedError::Conflict("attempt is not admitted"));
                }
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || attempt.phase != AttemptPhase::Admitted
                {
                    return Err(ManagedError::Conflict("attempt ownership or state changed"));
                }
                attempt.phase = AttemptPhase::Executing;
            }
            ManagedCommand::BeginAttemptSettlement {
                run_id,
                task_id,
                attempt_id,
            } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if !matches!(
                    run.phase,
                    RunPhase::Running | RunPhase::Paused | RunPhase::Cancelling | RunPhase::Verifying
                ) {
                    return Err(ManagedError::Conflict("run cannot settle this Attempt"));
                }
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.active_attempt.as_deref() != Some(attempt_id) || task.unknown_effect {
                    return Err(ManagedError::Conflict("attempt is not executing"));
                }
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || attempt.phase != AttemptPhase::Executing
                    || (run.phase == RunPhase::Verifying
                        && (task.pending_verification_attempt.as_deref() != Some(attempt_id)
                            || attempt.verifier_evidence.is_none()))
                {
                    return Err(ManagedError::Conflict("attempt ownership or state changed"));
                }
                attempt.phase = AttemptPhase::Settling;
            }
            ManagedCommand::SettleAttempt {
                run_id,
                task_id,
                attempt_id,
                receipt_digest,
            } => {
                blake3_digest(receipt_digest)?;
                let attempt_snapshot = self.attempts.get(attempt_id).ok_or(ManagedError::Conflict("attempt record missing"))?;
                if !replaying_owner_log {
                    if attempt_snapshot.effects.is_empty()
                        || attempt_snapshot.effects.len() != attempt_snapshot.effect_receipts.len()
                        || attempt_snapshot.effects.iter().any(|effect| {
                            let Some(receipt) = attempt_snapshot.effect_receipts.get(&effect.effect_id) else { return true };
                            receipt.target_receipt_digest.is_none()
                                || receipt.outcome == AttemptEffectOutcomeV1::Unknown
                                || (receipt.outcome == AttemptEffectOutcomeV1::Failed
                                    && !attempt_snapshot.verifier_intents.contains_key(&effect.effect_id))
                        })
                    {
                        return Err(ManagedError::Conflict("successful Attempt settlement requires every exact effect receipt to be durably settled"));
                    }
                    let mut settled = attempt_snapshot.effects.iter().map(|effect| {
                        let receipt = attempt_snapshot.effect_receipts.get(&effect.effect_id).expect("complete receipt set checked");
                        (effect.effect_id.clone(), receipt.target_receipt_digest.clone().expect("successful receipt digest checked"))
                    }).collect::<Vec<_>>();
                    settled.sort_by(|left, right| left.0.cmp(&right.0));
                    if attempt_receipt_digest(&self.owner_goal_id, attempt_snapshot, &settled) != *receipt_digest {
                        return Err(ManagedError::Conflict("Attempt receipt digest does not match durable per-effect receipts"));
                    }
                }
                let live_verifier_evidence = attempt_snapshot.verifier_evidence.clone();
                if !replaying_owner_log && live_verifier_evidence.is_none() {
                    return Err(ManagedError::Conflict(
                        "successful V1 Attempt settlement requires typed independent verifier evidence",
                    ));
                }
                if let Some(evidence) = &live_verifier_evidence {
                    let run = self.runs.get(run_id).ok_or(ManagedError::Conflict("run missing"))?;
                    if run.tasks.len() != 1 {
                        return Err(ManagedError::Conflict("live-Attempt verifier currently requires a single-Task Run"));
                    }
                    let task = run.tasks.get(task_id).ok_or(ManagedError::Conflict("task missing"))?;
                    let task_criteria = task.criterion_ids.iter().map(String::as_str).collect::<BTreeSet<_>>();
                    let evidence_criteria = evidence.criteria.iter().map(|criterion| criterion.criterion_id.as_str()).collect::<BTreeSet<_>>();
                    if task_criteria != evidence_criteria || task_criteria.len() != task.criterion_ids.len()
                        || attempt_snapshot.verifier_intents.len() != evidence.criteria.len()
                        || attempt_snapshot.verifier_intents.values().any(|intent| {
                            attempt_snapshot.effect_receipts.get(&intent.effect_id)
                                .and_then(|receipt| receipt.after_workspace_revision.as_deref())
                                != Some(evidence.source_revision.as_str())
                        })
                    {
                        return Err(ManagedError::Conflict("live verifier result does not match the single Task criteria or final revision"));
                    }
                }
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if !matches!(
                    run.phase,
                    RunPhase::Running | RunPhase::Paused | RunPhase::Cancelling | RunPhase::Verifying
                ) {
                    return Err(ManagedError::Conflict("run cannot settle this Attempt"));
                }
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.active_attempt.as_deref() != Some(attempt_id)
                    || task.unknown_effect
                    || task.pending_verification_attempt.as_deref()
                        .is_some_and(|pending| pending != attempt_id)
                {
                    return Err(ManagedError::Conflict("attempt is not settling"));
                }
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || attempt.phase != AttemptPhase::Settling
                    || (run.phase == RunPhase::Verifying
                        && (task.pending_verification_attempt.as_deref() != Some(attempt_id)
                            || attempt.verifier_evidence.is_none()))
                {
                    return Err(ManagedError::Conflict("attempt ownership or state changed"));
                }
                if attempt.effects.is_empty() {
                    return Err(ManagedError::Conflict(
                        "successful settlement requires at least one bound effect",
                    ));
                }
                attempt.phase = AttemptPhase::Succeeded;
                attempt.receipt_digest = Some(receipt_digest.clone());
                task.ready = false;
                task.active_attempt = None;
                if let Some(evidence) = live_verifier_evidence {
                    let failed = evidence.criteria.iter().filter(|criterion| criterion.verdict == VerificationVerdictV1::Fail)
                        .map(|criterion| criterion.criterion_id.clone()).collect::<Vec<_>>();
                    let task_evidence_digest = task_typed_verification_digest(
                        task_id, attempt_id, receipt_digest, &task.criterion_ids, &evidence,
                    );
                    task.verified_revision = Some(evidence.source_revision.clone());
                    task.verification_evidence = Some(TaskVerificationEvidence {
                        attempt_id: attempt_id.clone(), verifier_id: evidence.verifier_id.clone(),
                        source_revision: evidence.source_revision.clone(), evidence_digest: task_evidence_digest,
                    });
                    task.failed_criterion_ids = failed.clone();
                    task.pending_verification_attempt = None;
                    for criterion in &evidence.criteria {
                        run.criterion_evidence.insert(criterion.criterion_id.clone(), CriterionEvidence {
                            source_revision: evidence.source_revision.clone(),
                            evidence_digest: evidence.evidence_digest.clone(),
                            verifier_id: evidence.verifier_id.clone(),
                        });
                    }
                    run.final_revision = Some(evidence.source_revision.clone());
                    run.verifier_id = Some(evidence.verifier_id.clone());
                    run.verification_evidence = Some(evidence);
                    if run.phase != RunPhase::Cancelling {
                        run.phase = if failed.is_empty() { RunPhase::Verifying } else { RunPhase::Failed };
                        if !failed.is_empty() { run.failure_code = Some("independent_verification_failed".to_owned()); }
                    }
                } else {
                    task.pending_verification_attempt = Some(attempt_id.clone());
                }
            }
            ManagedCommand::SettleAttemptFailure {
                run_id,
                task_id,
                attempt_id,
                failure_code,
                retryable,
                receipt_digest,
            } => {
                id(failure_code)?;
                if let Some(receipt_digest) = receipt_digest {
                    blake3_digest(receipt_digest)?;
                }
                let spec_id = self
                    .runs
                    .get(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?
                    .spec_id
                    .clone();
                let max_attempts = self
                    .specs
                    .get(&spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?
                    .content
                    .budget
                    .max_attempts_per_task;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if !matches!(
                    run.phase,
                    RunPhase::Running | RunPhase::Paused | RunPhase::Cancelling | RunPhase::Verifying
                ) {
                    return Err(ManagedError::Conflict(
                        "Run does not accept settled Attempt failure",
                    ));
                }
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.active_attempt.as_deref() != Some(attempt_id)
                    || task.unknown_effect
                    || task.pending_verification_attempt.as_deref()
                        .is_some_and(|pending| pending != attempt_id)
                {
                    return Err(ManagedError::Conflict(
                        "Attempt is not awaiting failure settlement",
                    ));
                }
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || attempt.phase != AttemptPhase::Settling
                {
                    return Err(ManagedError::Conflict("attempt ownership or state changed"));
                }
                attempt.phase = AttemptPhase::Failed;
                attempt.receipt_digest = receipt_digest.clone();
                attempt.failure_code = Some(failure_code.clone());
                attempt.retryable = Some(*retryable);
                task.active_attempt = None;
                task.pending_verification_attempt = None;
                let exhausted = !retryable || task.attempt_count >= max_attempts;
                if exhausted || run.phase == RunPhase::Cancelling {
                    task.ready = false;
                }
                if run.phase == RunPhase::Verifying {
                    run.phase = RunPhase::Failed;
                    run.failure_code = Some(failure_code.clone());
                } else if exhausted && matches!(run.phase, RunPhase::Running | RunPhase::Paused) {
                    run.phase = RunPhase::NeedsYou;
                }
            }
            ManagedCommand::FailAttempt {
                run_id,
                task_id,
                attempt_id,
                failure_code,
                retryable,
            } => {
                id(failure_code)?;
                let spec_id = self
                    .runs
                    .get(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?
                    .spec_id
                    .clone();
                let max_attempts = self
                    .specs
                    .get(&spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?
                    .content
                    .budget
                    .max_attempts_per_task;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if !matches!(run.phase, RunPhase::Running | RunPhase::Paused) {
                    return Err(ManagedError::Conflict(
                        "Run does not accept Attempt settlement",
                    ));
                }
                let exhausted = {
                    let task = run
                        .tasks
                        .get_mut(task_id)
                        .ok_or(ManagedError::Conflict("task missing"))?;
                    if task.active_attempt.as_deref() != Some(attempt_id) || task.unknown_effect {
                        return Err(ManagedError::Conflict("attempt is not safely settleable"));
                    }
                    let attempt = self
                        .attempts
                        .get_mut(attempt_id)
                        .ok_or(ManagedError::Conflict("attempt record missing"))?;
                    if attempt.run_id != *run_id
                        || attempt.task_id != *task_id
                        || attempt.phase != AttemptPhase::Admitted
                    {
                        return Err(ManagedError::Conflict("attempt ownership or state changed"));
                    }
                    attempt.phase = AttemptPhase::Failed;
                    attempt.failure_code = Some(failure_code.clone());
                    attempt.retryable = Some(*retryable);
                    task.active_attempt = None;
                    let exhausted = !retryable || task.attempt_count >= max_attempts;
                    if exhausted {
                        task.ready = false;
                    }
                    exhausted
                };
                if exhausted {
                    run.phase = RunPhase::NeedsYou;
                }
            }
            ManagedCommand::MarkAttemptUnknown {
                run_id,
                task_id,
                attempt_id,
            } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.active_attempt.as_deref() != Some(attempt_id) || task.unknown_effect {
                    return Err(ManagedError::Conflict("attempt is not active"));
                }
                task.unknown_effect = true;
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || !matches!(
                        attempt.phase,
                        AttemptPhase::Admitted | AttemptPhase::Executing | AttemptPhase::Settling
                    )
                {
                    return Err(ManagedError::Conflict("attempt ownership or state changed"));
                }
                attempt.phase = AttemptPhase::Unknown;
                if matches!(run.phase, RunPhase::Running | RunPhase::Paused | RunPhase::Verifying) {
                    run.phase = RunPhase::Reconciling;
                }
                // Keep CANCELLING as the durable user-intent fence. The active
                // Attempt remains UNKNOWN until a future authenticated EffectService
                // can reconcile process/target evidence; this state owner cannot settle it.
            }

            ManagedCommand::VerifyTask {
                run_id,
                task_id,
                attempt_id,
                verifier_id,
                source_revision,
                evidence_digest,
            } => {
                if !replaying_owner_log {
                    return Err(ManagedError::Conflict(
                        "digest-only Task verification is unavailable; typed independent evidence is required",
                    ));
                }
                managed_digest(source_revision)?;
                managed_digest(evidence_digest)?;
                principal(verifier_id)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if !matches!(run.phase, RunPhase::Running | RunPhase::Verifying) {
                    return Err(ManagedError::Conflict("run fenced"));
                }
                if run
                    .verifier_id
                    .as_deref()
                    .is_some_and(|assigned| assigned != verifier_id)
                {
                    return Err(ManagedError::Conflict(
                        "Task verifier does not match the Run verifier assignment",
                    ));
                }
                // Evidence must bind the frozen final integrated Revision once that
                // revision exists; a stale or foreign revision can never PASS.
                if let Some(final_revision) = run.final_revision.as_deref()
                    && final_revision != source_revision
                {
                    return Err(ManagedError::Conflict("stale verification revision"));
                }
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.pending_verification_attempt.as_deref() != Some(attempt_id)
                    || task.unknown_effect
                    || task.verified_revision.is_some()
                {
                    return Err(ManagedError::Conflict(
                        "task has no settled Attempt awaiting verification",
                    ));
                }
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || attempt.phase != AttemptPhase::Succeeded
                    || attempt.receipt_digest.is_none()
                {
                    return Err(ManagedError::Conflict("attempt ownership or state changed"));
                }
                task.verified_revision = Some(source_revision.clone());
                task.verification_evidence = Some(TaskVerificationEvidence {
                    attempt_id: attempt_id.clone(),
                    verifier_id: verifier_id.clone(),
                    source_revision: source_revision.clone(),
                    evidence_digest: evidence_digest.clone(),
                });
                task.pending_verification_attempt = None;
            }
            ManagedCommand::BeginVerification {
                run_id,
                final_revision,
                verifier_id,
            } => {
                self.apply_begin_verification(
                    run_id,
                    final_revision,
                    verifier_id,
                    None,
                    replaying_owner_log,
                )?;
            }
            ManagedCommand::BeginVerificationWithReceiptBasis {
                run_id,
                final_revision,
                verifier_id,
                receipt_basis_digest,
            } => {
                self.apply_begin_verification(
                    run_id,
                    final_revision,
                    verifier_id,
                    Some(receipt_basis_digest),
                    replaying_owner_log,
                )?;
            }
            ManagedCommand::RecordCriterionEvidence {
                run_id,
                criterion_id,
                source_revision,
                evidence_digest,
                verifier_id,
            } => {
                managed_digest(source_revision)?;
                managed_digest(evidence_digest)?;
                principal(verifier_id)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Verifying
                    || run.final_revision.as_deref() != Some(source_revision)
                    || run.verifier_id.as_deref() != Some(verifier_id.as_str())
                    || run.verification_evidence.is_some()
                {
                    return Err(ManagedError::Conflict(
                        "stale, out-of-phase, or wrong-verifier criterion evidence",
                    ));
                }
                let spec = self
                    .specs
                    .get(&run.spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?;
                if !spec
                    .content
                    .criteria
                    .iter()
                    .any(|criterion| criterion.id == *criterion_id)
                    || run.criterion_evidence.contains_key(criterion_id)
                {
                    return Err(ManagedError::Conflict(
                        "unknown or duplicated acceptance criterion",
                    ));
                }
                run.criterion_evidence.insert(
                    criterion_id.clone(),
                    CriterionEvidence {
                        source_revision: source_revision.clone(),
                        evidence_digest: evidence_digest.clone(),
                        verifier_id: verifier_id.clone(),
                    },
                );
            }
            ManagedCommand::RecordVerificationEvidence { run_id, evidence } => {
                validate_verification_evidence(evidence)?;
                if evidence.evidence_digest != verification_evidence_digest(evidence) {
                    return Err(ManagedError::Conflict(
                        "verification evidence digest mismatch",
                    ));
                }
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Verifying
                    || run.final_revision.as_deref() != Some(evidence.source_revision.as_str())
                    || run.verifier_id.as_deref() != Some(evidence.verifier_id.as_str())
                    || run.verification_evidence.is_some()
                {
                    return Err(ManagedError::Conflict(
                        "stale, duplicate, out-of-phase, or wrong-verifier result",
                    ));
                }
                let spec = self
                    .specs
                    .get(&run.spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?;
                if evidence.aggregate_duration_ms > spec.content.budget.max_run_duration_ms {
                    return Err(ManagedError::Conflict(
                        "verifier elapsed time exceeds the accepted Run budget",
                    ));
                }
                if evidence.verifier_id == spec.content.proposed_by
                    || spec.reviewer_id.as_deref() == Some(evidence.verifier_id.as_str())
                    || spec.accepted_by.as_deref() == Some(evidence.verifier_id.as_str())
                {
                    return Err(ManagedError::Conflict(
                        "verifier must be distinct from proposer and reviewer",
                    ));
                }
                if run.tasks.values().any(|task| {
                    task.pending_verification_attempt
                        .as_deref()
                        .or_else(|| {
                            task.verification_evidence
                                .as_ref()
                                .map(|proof| proof.attempt_id.as_str())
                        })
                        .and_then(|attempt_id| self.attempts.get(attempt_id))
                        .is_some_and(|attempt| attempt.executor_principal == evidence.verifier_id)
                }) {
                    return Err(ManagedError::Conflict(
                        "verifier must be distinct from every task executor",
                    ));
                }
                let task_attempts = run
                    .tasks
                    .iter()
                    .map(|(task_id, task)| {
                        let attempt_id = task
                            .pending_verification_attempt
                            .as_deref()
                            .or_else(|| {
                                task.verification_evidence
                                    .as_ref()
                                    .map(|prior| prior.attempt_id.as_str())
                            })
                            .ok_or(ManagedError::Conflict(
                                "typed verifier result has a Task without a settled Attempt",
                            ))?;
                        let attempt = self
                            .attempts
                            .get(attempt_id)
                            .ok_or(ManagedError::Conflict("verification Attempt is missing"))?;
                        if attempt.run_id != *run_id
                            || attempt.task_id != *task_id
                            || attempt.phase != AttemptPhase::Succeeded
                            || attempt.receipt_digest.is_none()
                            || task.unknown_effect
                            || task.active_attempt.is_some()
                        {
                            return Err(ManagedError::Conflict(
                                "typed verifier Task Attempt is stale or unsettled",
                            ));
                        }
                        let task_criteria = task.criterion_ids.iter().cloned().collect::<BTreeSet<_>>();
                        let evidence_criteria = evidence
                            .criteria
                            .iter()
                            .map(|criterion| criterion.criterion_id.as_str())
                            .collect::<BTreeSet<_>>();
                        if task_criteria.is_empty()
                            || task_criteria.len() != task.criterion_ids.len()
                            || task_criteria
                                .iter()
                                .any(|criterion| !evidence_criteria.contains(criterion.as_str()))
                        {
                            return Err(ManagedError::Conflict(
                                "typed verifier evidence does not cover a Task's accepted criteria",
                            ));
                        }
                        Ok((
                            task_id.clone(),
                            attempt_id.to_owned(),
                            attempt
                                .receipt_digest
                                .clone()
                                .ok_or(ManagedError::Conflict(
                                    "typed verifier Task Attempt has no settled receipt digest",
                                ))?,
                            task.criterion_ids.clone(),
                        ))
                    })
                    .collect::<Result<Vec<_>, ManagedError>>()?;
                let accepted: BTreeSet<&str> = spec
                    .content
                    .criteria
                    .iter()
                    .map(|criterion| criterion.id.as_str())
                    .collect();
                let supplied: BTreeSet<&str> = evidence
                    .criteria
                    .iter()
                    .map(|criterion| criterion.criterion_id.as_str())
                    .collect();
                if accepted.len() != supplied.len() || accepted != supplied {
                    return Err(ManagedError::Conflict(
                        "verification result does not cover the exact accepted criteria",
                    ));
                }
                if !run.criterion_evidence.is_empty() {
                    return Err(ManagedError::Conflict(
                        "legacy digest-only evidence cannot be mixed with typed evidence",
                    ));
                }
                let failed_criteria = evidence
                    .criteria
                    .iter()
                    .filter(|criterion| criterion.verdict == VerificationVerdictV1::Fail)
                    .map(|criterion| criterion.criterion_id.as_str())
                    .collect::<BTreeSet<_>>();
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                run.criterion_evidence = evidence
                    .criteria
                    .iter()
                    .map(|criterion| {
                        (
                            criterion.criterion_id.clone(),
                            CriterionEvidence {
                                source_revision: evidence.source_revision.clone(),
                                evidence_digest: evidence.evidence_digest.clone(),
                                verifier_id: evidence.verifier_id.clone(),
                            },
                        )
                    })
                    .collect();
                run.verification_evidence = Some(evidence.clone());
                for (task_id, attempt_id, receipt_digest, criterion_ids) in task_attempts {
                    let task = run
                        .tasks
                        .get_mut(&task_id)
                        .ok_or(ManagedError::Conflict("verification Task is missing"))?;
                    let task_evidence_digest = task_typed_verification_digest(
                        &task_id,
                        &attempt_id,
                        &receipt_digest,
                        &criterion_ids,
                        evidence,
                    );
                    task.verified_revision = Some(evidence.source_revision.clone());
                    task.verification_evidence = Some(TaskVerificationEvidence {
                        attempt_id,
                        verifier_id: evidence.verifier_id.clone(),
                        source_revision: evidence.source_revision.clone(),
                        evidence_digest: task_evidence_digest,
                    });
                    task.pending_verification_attempt = None;
                }
                if !failed_criteria.is_empty() {
                    for task in run.tasks.values_mut() {
                        for criterion_id in &task.criterion_ids {
                            if failed_criteria.contains(criterion_id.as_str())
                                && !task.failed_criterion_ids.contains(criterion_id)
                            {
                                task.failed_criterion_ids.push(criterion_id.clone());
                            }
                        }
                    }
                    run.phase = RunPhase::Failed;
                    run.failure_code = Some("independent_verification_failed".to_owned());
                }
            }
            ManagedCommand::FinalizeRun {
                run_id,
                final_revision,
            } => {
                managed_digest(final_revision)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Verifying
                    || run.final_revision.as_deref() != Some(final_revision)
                    || run
                        .tasks
                        .values()
                        .any(|task| task.unknown_effect || task.active_attempt.is_some())
                {
                    return Err(ManagedError::Conflict("run not ready to finalize"));
                }
                let spec = self
                    .specs
                    .get(&run.spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?;
                let Some(evidence) = run.verification_evidence.as_ref() else {
                    return Err(ManagedError::Conflict(
                        "typed independent verifier evidence is missing",
                    ));
                };
                if evidence.source_revision != *final_revision
                    || Some(evidence.verifier_id.as_str()) != run.verifier_id.as_deref()
                    || evidence.evidence_digest != verification_evidence_digest(evidence)
                    || validate_verification_evidence(evidence).is_err()
                {
                    return Err(ManagedError::Conflict(
                        "typed independent verifier evidence is stale or invalid",
                    ));
                }
                if spec.content.criteria.iter().any(|criterion| {
                    run.criterion_evidence
                        .get(&criterion.id)
                        .is_none_or(|proof| {
                            proof.source_revision != *final_revision
                                || Some(proof.verifier_id.as_str()) != run.verifier_id.as_deref()
                        })
                }) {
                    return Err(ManagedError::Conflict(
                        "missing or stale final-revision evidence",
                    ));
                }
                run.phase = RunPhase::Succeeded;
            }
            ManagedCommand::NeedsYou { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if matches!(
                    run.phase,
                    RunPhase::Succeeded
                        | RunPhase::Cancelling
                        | RunPhase::Cancelled
                        | RunPhase::NeedsYou
                        | RunPhase::Failed
                ) || run.tasks.values().any(|task| task.active_attempt.is_some())
                {
                    return Err(ManagedError::Conflict("run cannot transition to NEEDS_YOU"));
                }
                run.phase = RunPhase::NeedsYou;
            }
            ManagedCommand::PauseRun { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                // Pause is a coding-worker admission fence. A live coding
                // Attempt is never suspended here because its effect dispatch
                // status may be ambiguous; verifier retry has its own frozen
                // Attempt path below and must not be routed through this state.
                if run.phase != RunPhase::Running
                    || run.tasks.values().any(|task| task.active_attempt.is_some() || task.unknown_effect)
                {
                    return Err(ManagedError::Conflict("only running Runs can pause"));
                }
                run.phase = RunPhase::Paused; // Durable admission fence precedes stopping workers.
            }
            ManagedCommand::ResumeRun { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                // ResumeRun only reopens a quiescent PAUSED coding Run. A Run
                // already VERIFYING resumes through BeginVerification on its
                // exact pinned Attempt, finalRevision and verifier assignment;
                // it must not allocate a new coding Attempt here.
                if run.phase != RunPhase::Paused
                    || run.tasks.values().any(|task| task.unknown_effect || task.active_attempt.is_some())
                {
                    return Err(ManagedError::Conflict("run not safely resumable"));
                }
                run.phase = RunPhase::Running;
            }
            ManagedCommand::RequestCancel { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase == RunPhase::Planned {
                    // A not-yet-started plan owns no worker, Attempt, lease or
                    // effect; discard it directly without a cancellation saga.
                    run.phase = RunPhase::Cancelled;
                } else {
                    if matches!(
                        run.phase,
                        RunPhase::Cancelling
                            | RunPhase::Cancelled
                            | RunPhase::Succeeded
                            | RunPhase::NeedsYou
                            | RunPhase::Failed
                    ) {
                        return Err(ManagedError::Conflict(
                            "run cannot be cancelled from terminal/fenced phase",
                        ));
                    }
                    run.phase = RunPhase::Cancelling; // Fence before signaling active workers.
                }
            }
            ManagedCommand::CompleteCancel { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Cancelling {
                    return Err(ManagedError::Conflict(
                        "only cancelling Runs can complete cancellation",
                    ));
                }
                // Settlement of admitted effects belongs to the future
                // authenticated EffectService. CANCELLED is recorded only when
                // nothing remains active or UNKNOWN; otherwise this fails closed.
                if run
                    .tasks
                    .values()
                    .any(|task| task.active_attempt.is_some() || task.unknown_effect)
                {
                    return Err(ManagedError::Conflict(
                        "cancellation still has unsettled attempts",
                    ));
                }
                run.phase = RunPhase::Cancelled;
            }
            ManagedCommand::FailRun {
                run_id,
                failure_code,
            } => {
                id(failure_code)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if !matches!(run.phase, RunPhase::Verifying | RunPhase::Reconciling) {
                    return Err(ManagedError::Conflict("run cannot fail from this phase"));
                }
                // RECONCILING is only entered alongside an unsettled UNKNOWN
                // Attempt; until a future authenticated EffectService reconciles
                // it with target-side proof, failure stays fenced and this fails
                // closed rather than abandoning an unknown effect.
                if run
                    .tasks
                    .values()
                    .any(|task| task.active_attempt.is_some() || task.unknown_effect)
                {
                    return Err(ManagedError::Conflict("run still has unsettled attempts"));
                }
                run.failure_code = Some(failure_code.clone());
                run.phase = RunPhase::Failed;
            }
        }
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or(ManagedError::Invalid("revision overflow"))?;
        Ok(())
    }
}

/// Acquires one durable owner lock per Goal. Another process cannot write the
/// same Goal concurrently; all commands also compare the caller's revision.
pub struct ManagedControl {
    goal_id: String,
    log: OwnerLogV2,
    snapshot: ManagedSnapshot,
    cursor: Option<CursorV1>,
}

impl ManagedControl {
    pub fn open(root: &Path, goal_id: &str) -> Result<Self, ManagedError> {
        id(goal_id)?;
        let owner = OwnerIdentity::new("managed_goal".to_owned(), goal_id.to_owned())?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)?;
        let mut snapshot = ManagedSnapshot {
            owner_goal_id: goal_id.to_owned(),
            ..ManagedSnapshot::default()
        };
        let mut cursor: Option<CursorV1> = None;
        loop {
            let batch = log.read_after(cursor.as_ref(), NonZeroUsize::new(128).unwrap())?;
            for event in &batch.events {
                let envelope = event
                    .data
                    .as_object()
                    .ok_or(ManagedError::Invalid("invalid managed envelope"))?;
                let version = envelope.get("schemaVersion").and_then(Value::as_u64);
                if version != Some(1) {
                    return Err(ManagedError::Invalid("unknown managed schema version"));
                }
                let payload = envelope
                    .get("payload")
                    .ok_or(ManagedError::Invalid("missing managed payload"))?;
                let delivery = envelope
                    .get("deliveryId")
                    .and_then(Value::as_str)
                    .ok_or(ManagedError::Invalid("missing delivery"))?;
                let command_digest = envelope
                    .get("commandDigest")
                    .and_then(Value::as_str)
                    .ok_or(ManagedError::Invalid("missing command digest"))?;
                if snapshot.deliveries.contains_key(delivery) {
                    return Err(ManagedError::Invalid("duplicate physical delivery"));
                }
                let command = ManagedCommand::decode(&event.kind, payload)?;
                if let ManagedCommand::ConsumeManagedDispatch { record } = &command {
                    if record.delivery_id != delivery {
                        return Err(ManagedError::Invalid(
                            "managed dispatch delivery differs from OwnerLog envelope",
                        ));
                    }
                }
                if let ManagedCommand::AbandonPreAdmissionCandidate { proof } = &command {
                    if proof.delivery_id != delivery {
                        return Err(ManagedError::Invalid(
                            "candidate tombstone delivery differs from OwnerLog envelope",
                        ));
                    }
                }
                if let ManagedCommand::DispatchQuiesced { proof } = &command {
                    if proof.delivery_id != delivery {
                        return Err(ManagedError::Invalid("dispatch quiescence delivery differs from OwnerLog envelope"));
                    }
                }
                snapshot.replay(&command)?;
                if let ManagedCommand::DispatchQuiesced { proof } = &command {
                    let owner_cursor = batch.cursor.as_ref()
                        .ok_or(ManagedError::Invalid("dispatch quiescence OwnerLog cursor is missing"))?;
                    let marker_digest = format!("blake3:{}", event.event_digest.to_hex());
                    let marker = ManagedDispatchQuiescedReceiptV1::new(
                        proof,
                        snapshot.revision,
                        owner_cursor.owner_id.clone(),
                        event.seq,
                        marker_digest,
                    );
                    if snapshot.dispatch_quiescence.insert(proof.attempt_id.clone(), marker).is_some() {
                        return Err(ManagedError::Invalid("duplicate managed dispatch quiescence marker"));
                    }
                }
                if let ManagedCommand::AdmitAttemptWithDelegation { attempt_id, .. } = &command {
                    let receipt = ManagedAttemptAdmissionReceiptV1::from_snapshot(
                        goal_id, delivery, attempt_id, &snapshot,
                    )?;
                    if snapshot.managed_admission_receipts.insert(delivery.to_owned(), receipt).is_some() {
                        return Err(ManagedError::Invalid("duplicate managed Attempt admission delivery"));
                    }
                }
                if let ManagedCommand::StartPlannedRun { run_id, .. } = &command {
                    if event.time_ms == 0 {
                        return Err(ManagedError::Invalid("planned Run start has an invalid OwnerLog timestamp"));
                    }
                    let run = snapshot.runs.get_mut(run_id)
                        .ok_or(ManagedError::Invalid("planned Run start references a missing Run"))?;
                    if run.started_at_ms.replace(event.time_ms).is_some() {
                        return Err(ManagedError::Invalid("planned Run has duplicate start timestamps"));
                    }
                }
                let logical = logical_command_digest(&event.kind, payload);
                // OwnerLog already authenticates the physical command digest;
                // this projection additionally records retry-equivalence.
                if !command_digest.starts_with("blake3:") {
                    return Err(ManagedError::Invalid("invalid physical command digest"));
                }
                snapshot.deliveries.insert(delivery.to_owned(), logical);
            }
            cursor = batch.cursor;
            if !batch.has_more {
                break;
            }
        }
        // After a host crash, ordinary active Attempts remain UNKNOWN. The one
        // exception is a coding Attempt whose complete successful effect chain
        // is already durable and has not entered verifier dispatch: its exact
        // pin can resume verification, subject to HostKernel's live lease and
        // challenge-journal checks. This projection never replays a mutation.
        for (run_id, run) in snapshot.runs.iter_mut() {
            let unsettled = run.tasks.values().any(|task| task.active_attempt.is_some());
            if unsettled {
                let recoverable = restart_recoverable_live_verification(
                    run_id,
                    run,
                    &snapshot.attempts,
                );
                if recoverable {
                    // Keep the exact Attempt and verifier pin. HostKernel must
                    // revalidate owner-epoch lease and recover the same challenge
                    // journal for unfinished dispatch, or finish persisted typed
                    // evidence settlement without launching another verifier.
                    continue;
                }
                for task in run.tasks.values_mut() {
                    if let Some(attempt_id) = task.active_attempt.as_deref() {
                        task.unknown_effect = true;
                        if let Some(attempt) = snapshot.attempts.get_mut(attempt_id) {
                            attempt.phase = AttemptPhase::Unknown;
                        }
                    }
                }
                if run.phase == RunPhase::Running || run.phase == RunPhase::Paused {
                    run.phase = RunPhase::Reconciling;
                }
                // A persisted CANCELLING phase remains fenced across restart; an
                // unsettled Attempt is not evidence that cancellation completed.
            }
        }
        Ok(Self {
            goal_id: goal_id.to_owned(),
            log,
            snapshot,
            cursor,
        })
    }

    pub fn snapshot(&self) -> &ManagedSnapshot {
        &self.snapshot
    }

    /// Return the server-owned candidate generation for the exact Task. The
    /// generation is projected for HostKernel ID derivation; clients cannot set it.
    pub(crate) fn candidate_generation(&self, run_id: &str, task_id: &str) -> Result<u64, ManagedError> {
        self.snapshot.runs.get(run_id)
            .and_then(|run| run.tasks.get(task_id))
            .map(|task| task.candidate_generation)
            .ok_or(ManagedError::Conflict("candidate generation Task is missing"))
    }

    /// Exact current ManagedControl OwnerLog watermark for a HostKernel cross-log
    /// proof. The empty owner-log state has no watermark and cannot authorize it.
    pub(crate) fn owner_watermark(&self) -> Result<ManagedOwnerWatermarkV1, ManagedError> {
        let cursor = self.cursor.as_ref().ok_or(ManagedError::Conflict("managed OwnerLog has no committed watermark"))?;
        Ok(ManagedOwnerWatermarkV1 {
            owner_log_id: cursor.owner_id.clone(),
            sequence: cursor.seq.clone(),
            event_digest: cursor.event_digest.clone(),
            revision: self.snapshot.revision,
        })
    }

    /// Resolve the exact pre-terminal state P1 must inspect before recording that
    /// the logical child prompt callback has returned. This is intentionally
    /// restricted to SETTLING and refuses UNKNOWN, incomplete or discontinuous
    /// effect chains, so the prompt-quiescence marker cannot settle an Attempt.
    pub(crate) fn managed_dispatch_completion_snapshot(
        &self,
        goal_id: &str,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        expected_binding_digest: &str,
    ) -> Result<ManagedDispatchCompletionSnapshotV1, ManagedError> {
        if goal_id != self.goal_id || goal_id != self.snapshot.owner_goal_id {
            return Err(ManagedError::Conflict("dispatch completion Goal owner mismatch"));
        }
        for value in [run_id, task_id, attempt_id] { id(value)?; }
        managed_digest(expected_binding_digest)?;
        if self.snapshot.dispatch_quiescence.contains_key(attempt_id) {
            return Err(ManagedError::Conflict("managed prompt callback is already quiesced"));
        }
        let run = self.snapshot.runs.get(run_id)
            .ok_or(ManagedError::Conflict("dispatch completion Run is missing"))?;
        let task = run.tasks.get(task_id)
            .ok_or(ManagedError::Conflict("dispatch completion Task is missing"))?;
        let attempt = self.snapshot.attempts.get(attempt_id)
            .ok_or(ManagedError::Conflict("dispatch completion Attempt is missing"))?;
        let spec = self.snapshot.specs.get(&run.spec_id)
            .ok_or(ManagedError::Conflict("dispatch completion SpecVersion is missing"))?;
        let binding = attempt.delegation_binding.as_ref()
            .ok_or(ManagedError::Conflict("dispatch completion DelegationBinding is missing"))?;
        let binding_digest = binding.digest()
            .map_err(|_| ManagedError::Invalid("dispatch completion binding digest failed"))?;
        let consumed = self.snapshot.dispatch_consumptions.get(attempt_id)
            .ok_or(ManagedError::Conflict("dispatch completion has no consumed handoff"))?;
        if !spec.accepted || attempt.phase != AttemptPhase::Settling
            || task.active_attempt.as_deref() != Some(attempt_id)
            || task.unknown_effect
            || attempt.run_id != run_id || attempt.task_id != task_id
            || binding.run_id != run_id || binding.task_id != task_id || binding.attempt_id != attempt_id
            || binding_digest != expected_binding_digest
            || consumed.goal_id != goal_id || consumed.run_id != run_id
            || consumed.task_id != task_id || consumed.attempt_id != attempt_id
            || consumed.session_id != attempt.session_id
            || consumed.owner_epoch != attempt.owner_epoch
            || consumed.binding_digest != binding_digest
            || run.session_link.as_ref().is_none_or(|link| link.session_id != consumed.parent_session_id)
            || !matches!(run.phase, RunPhase::Running | RunPhase::Paused | RunPhase::Cancelling | RunPhase::Verifying)
        {
            return Err(ManagedError::Conflict("dispatch completion is stale, non-SETTLING, or differs from exact consumed child"));
        }
        if task.pending_verification_attempt.as_deref().is_some_and(|pending| pending != attempt_id) {
            return Err(ManagedError::Conflict("dispatch completion conflicts with another verifier Attempt"));
        }

        let mut effects = Vec::with_capacity(attempt.effects.len());
        let mut encoded_effects = Vec::with_capacity(attempt.effects.len());
        let mut workspace_head = attempt.workspace_revision.clone();
        let mut workspace_head_confident = workspace_head.is_some();
        let mut chain_settled = workspace_head_confident;
        for edge in &attempt.effects {
            let receipt = attempt.effect_receipts.get(&edge.effect_id);
            let row = ManagedAttemptTerminalEffectV1 {
                effect_id: edge.effect_id.clone(),
                outcome: receipt.map(|item| item.outcome),
                observation_digest: receipt.and_then(|item| item.target_receipt_digest.clone()),
                before_workspace_revision: receipt.map(|item| item.before_workspace_revision.clone()),
                after_workspace_revision: receipt.and_then(|item| item.after_workspace_revision.clone()),
            };
            chain_settled &= receipt.is_some_and(|item| {
                item.outcome != AttemptEffectOutcomeV1::Unknown
                    && item.target_receipt_digest.as_deref().is_some_and(|digest| blake3_digest(digest).is_ok())
                    && blake3_digest(&item.before_workspace_revision).is_ok()
                    && item.after_workspace_revision.as_deref().is_some_and(|digest| blake3_digest(digest).is_ok())
            });
            match (workspace_head.as_deref(), receipt) {
                (Some(head), Some(item)) if head == item.before_workspace_revision
                    && item.outcome != AttemptEffectOutcomeV1::Unknown => {
                    workspace_head = item.after_workspace_revision.clone();
                }
                _ => {
                    workspace_head_confident = false;
                    workspace_head = None;
                }
            }
            encoded_effects.push(json!({
                "effectID": edge.effect_id,
                "boundRevision": edge.bound_revision.to_string(),
                "locationID": edge.location_id,
                "sessionID": edge.session_id,
                "outcome": receipt.map(|item| effect_outcome_name(item.outcome)),
                "observationDigest": receipt.and_then(|item| item.target_receipt_digest.as_deref()),
                "beforeWorkspaceRevision": receipt.map(|item| item.before_workspace_revision.as_str()),
                "afterWorkspaceRevision": receipt.and_then(|item| item.after_workspace_revision.as_deref()),
                "executorPrincipal": receipt.map(|item| item.executor_principal.as_str()),
                "ownerEpoch": receipt.map(|item| item.owner_epoch.to_string()),
                "capabilityID": receipt.map(|item| item.capability_id.as_str()),
                "leaseDigest": receipt.map(|item| item.capability_lease_digest.as_str()),
            }));
            effects.push(row);
        }
        chain_settled &= attempt.effects.len() == attempt.effect_receipts.len() && workspace_head_confident;
        if !chain_settled {
            return Err(ManagedError::Conflict("dispatch completion effect receipts are incomplete, UNKNOWN, or have a discontinuous workspace head"));
        }
        let effect_chain_digest = format!("blake3:{}", blake3::hash(json!({
            "domain": "horizoncode.managed-attempt-effect-chain.v1",
            "goalID": goal_id, "runID": run_id, "taskID": task_id,
            "attemptID": attempt_id, "bindingDigest": binding_digest,
            "effects": encoded_effects,
        }).to_string().as_bytes()).to_hex());
        let watermark = self.owner_watermark()?;
        let attempt_revision = binding.admitted_managed_revision;
        let task_revision = attempt_revision.checked_sub(1)
            .ok_or(ManagedError::Conflict("Attempt admission revision is invalid"))?;
        let attempt_state_digest = format!("blake3:{}", blake3::hash(json!({
            "goalID": goal_id, "runID": run_id, "taskID": task_id, "attemptID": attempt_id,
            "runPhase": format!("{:?}", run.phase), "attemptPhase": "Settling",
            "executorPrincipal": attempt.executor_principal, "ownerEpoch": attempt.owner_epoch.to_string(),
            "locationID": attempt.location_id, "childSessionID": attempt.session_id,
            "workspaceRevision": attempt.workspace_revision,
            "observedWorkspaceHead": if workspace_head_confident { workspace_head.as_deref() } else { None },
            "bindingDigest": binding_digest, "effectChainDigest": effect_chain_digest,
            "consumedReceiptDigest": consumed.receipt_digest,
        }).to_string().as_bytes()).to_hex());
        let owner_log_sequence = watermark.sequence.parse::<u64>()
            .map_err(|_| ManagedError::Invalid("OwnerLog sequence is invalid"))?;
        Ok(ManagedDispatchCompletionSnapshotV1 {
            goal_id: goal_id.to_owned(), run_id: run_id.to_owned(), task_id: task_id.to_owned(),
            attempt_id: attempt_id.to_owned(), parent_session_id: consumed.parent_session_id.clone(),
            session_id: consumed.session_id.clone(), handoff_id: consumed.handoff_id.clone(),
            handoff_digest: consumed.handoff_digest.clone(), consume_delivery_id: consumed.delivery_id.clone(),
            consume_receipt_digest: consumed.receipt_digest.clone(), binding_digest,
            task_revision, attempt_revision, managed_revision: watermark.revision,
            spec_id: run.spec_id.clone(), spec_digest: spec.digest.clone(),
            admission_workspace_revision: attempt.workspace_revision.clone(),
            observed_workspace_head: if workspace_head_confident { workspace_head } else { None },
            owner_log_id: watermark.owner_log_id, owner_log_sequence,
            owner_log_event_digest: watermark.event_digest, attempt_state_digest,
            effect_chain_state: if chain_settled { ManagedAttemptEffectChainStateV1::AllSettled }
                else { ManagedAttemptEffectChainStateV1::UnresolvedOrUnknown },
            effect_chain_digest, effects, consumed_receipt: consumed.clone(),
        })
    }

    /// Builds the canonical P2 terminal/effect snapshot used by P1 and P8.
    /// Every field comes from the locked ManagedControl projection; it is not a
    /// request assertion or an execution authorization token. Nonterminal Attempt
    /// phases are rejected. UNKNOWN, incomplete receipts, pending verification,
    /// or an absent prompt-quiescence marker remain explicitly unresolved.
    pub(crate) fn managed_attempt_terminal_snapshot(
        &self,
        goal_id: &str,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        expected_binding_digest: &str,
    ) -> Result<ManagedAttemptTerminalSnapshotV1, ManagedError> {
        if goal_id != self.goal_id || goal_id != self.snapshot.owner_goal_id {
            return Err(ManagedError::Conflict("terminal Attempt Goal owner mismatch"));
        }
        for value in [run_id, task_id, attempt_id] { id(value)?; }
        managed_digest(expected_binding_digest)?;
        let run = self.snapshot.runs.get(run_id)
            .ok_or(ManagedError::Conflict("terminal Attempt Run is missing"))?;
        let task = run.tasks.get(task_id)
            .ok_or(ManagedError::Conflict("terminal Attempt Task is missing"))?;
        let attempt = self.snapshot.attempts.get(attempt_id)
            .ok_or(ManagedError::Conflict("terminal Attempt record is missing"))?;
        let spec = self.snapshot.specs.get(&run.spec_id)
            .ok_or(ManagedError::Conflict("terminal Attempt SpecVersion is missing"))?;
        let binding = attempt.delegation_binding.as_ref()
            .ok_or(ManagedError::Conflict("terminal Attempt DelegationBinding is missing"))?;
        let binding_digest = binding.digest()
            .map_err(|_| ManagedError::Invalid("terminal Attempt binding digest failed"))?;
        if !spec.accepted || binding_digest != expected_binding_digest
            || attempt.run_id != run_id || attempt.task_id != task_id
            || binding.run_id != run_id || binding.task_id != task_id || binding.attempt_id != attempt_id
            || task.active_attempt.as_deref().is_some_and(|active| active != attempt_id)
            || !matches!(attempt.phase, AttemptPhase::Succeeded | AttemptPhase::Failed | AttemptPhase::Unknown)
        {
            return Err(ManagedError::Conflict("Attempt is nonterminal or differs from exact managed binding"));
        }
        let watermark = self.owner_watermark()?;
        let attempt_revision = binding.admitted_managed_revision;
        let task_revision = attempt_revision.checked_sub(1)
            .ok_or(ManagedError::Conflict("Attempt admission revision is invalid"))?;

        let mut effects = Vec::with_capacity(attempt.effects.len());
        let mut encoded_effects = Vec::with_capacity(attempt.effects.len());
        let mut chain_settled = true;
        let mut workspace_head = attempt.workspace_revision.clone();
        let mut workspace_head_confident = workspace_head.is_some();
        for edge in &attempt.effects {
            let receipt = attempt.effect_receipts.get(&edge.effect_id);
            let row = ManagedAttemptTerminalEffectV1 {
                effect_id: edge.effect_id.clone(),
                outcome: receipt.map(|item| item.outcome),
                observation_digest: receipt.and_then(|item| item.target_receipt_digest.clone()),
                before_workspace_revision: receipt.map(|item| item.before_workspace_revision.clone()),
                after_workspace_revision: receipt.and_then(|item| item.after_workspace_revision.clone()),
            };
            chain_settled &= receipt.is_some_and(|item| {
                item.outcome != AttemptEffectOutcomeV1::Unknown
                    && item.target_receipt_digest.as_deref().is_some_and(|digest| blake3_digest(digest).is_ok())
                    && blake3_digest(&item.before_workspace_revision).is_ok()
                    && item.after_workspace_revision.as_deref().is_some_and(|digest| blake3_digest(digest).is_ok())
            });
            match (workspace_head.as_deref(), receipt) {
                (Some(head), Some(item)) if head == item.before_workspace_revision
                    && item.outcome != AttemptEffectOutcomeV1::Unknown => {
                    workspace_head = item.after_workspace_revision.clone();
                }
                _ => {
                    workspace_head_confident = false;
                    workspace_head = None;
                }
            }
            encoded_effects.push(json!({
                "effectID": edge.effect_id,
                "boundRevision": edge.bound_revision.to_string(),
                "locationID": edge.location_id,
                "sessionID": edge.session_id,
                "outcome": receipt.map(|item| effect_outcome_name(item.outcome)),
                "observationDigest": receipt.and_then(|item| item.target_receipt_digest.as_deref()),
                "beforeWorkspaceRevision": receipt.map(|item| item.before_workspace_revision.as_str()),
                "afterWorkspaceRevision": receipt.and_then(|item| item.after_workspace_revision.as_deref()),
                "executorPrincipal": receipt.map(|item| item.executor_principal.as_str()),
                "ownerEpoch": receipt.map(|item| item.owner_epoch.to_string()),
                "capabilityID": receipt.map(|item| item.capability_id.as_str()),
                "leaseDigest": receipt.map(|item| item.capability_lease_digest.as_str()),
            }));
            effects.push(row);
        }
        if attempt.effects.len() != attempt.effect_receipts.len() {
            chain_settled = false;
        }
        if !workspace_head_confident {
            chain_settled = false;
        }
        let effect_chain_digest = format!("blake3:{}", blake3::hash(json!({
            "domain": "horizoncode.managed-attempt-effect-chain.v1",
            "goalID": goal_id, "runID": run_id, "taskID": task_id,
            "attemptID": attempt_id, "bindingDigest": binding_digest,
            "effects": encoded_effects,
        }).to_string().as_bytes()).to_hex());

        let consumed = self.snapshot.dispatch_consumptions.get(attempt_id);
        let prompt_marker = self.snapshot.dispatch_quiescence.get(attempt_id).filter(|marker| {
            let proof = &marker.proof;
            consumed.is_some_and(|receipt| proof.goal_id == goal_id
                && proof.run_id == run_id && proof.task_id == task_id
                && proof.attempt_id == attempt_id
                && proof.parent_session_id == receipt.parent_session_id
                && proof.session_id == receipt.session_id
                && proof.handoff_id == receipt.handoff_id
                && proof.handoff_digest == receipt.handoff_digest
                && proof.consume_delivery_id == receipt.delivery_id
                && proof.consume_receipt_digest == receipt.receipt_digest)
        });
        let child_prompt_state = if prompt_marker.is_some() {
            ManagedChildPromptStateV1::Quiesced
        } else {
            ManagedChildPromptStateV1::Unconfirmed
        };

        let task_state = if task.unknown_effect || attempt.phase == AttemptPhase::Unknown {
            ManagedTaskTerminalStateV1::Unknown
        } else if task.active_attempt.as_deref() == Some(attempt_id) {
            ManagedTaskTerminalStateV1::Active
        } else if task.pending_verification_attempt.as_deref() == Some(attempt_id) {
            ManagedTaskTerminalStateV1::PendingVerification
        } else if task.verified_revision.is_some() && task.verification_evidence.is_some() {
            ManagedTaskTerminalStateV1::Verified
        } else if run.phase == RunPhase::Cancelled {
            ManagedTaskTerminalStateV1::Cancelled
        } else if !task.failed_criterion_ids.is_empty() {
            ManagedTaskTerminalStateV1::Failed
        } else if attempt.phase == AttemptPhase::Failed {
            if attempt.retryable == Some(true) {
                ManagedTaskTerminalStateV1::Retryable
            } else {
                ManagedTaskTerminalStateV1::Failed
            }
        } else if task.ready {
            ManagedTaskTerminalStateV1::Retryable
        } else {
            ManagedTaskTerminalStateV1::PendingVerification
        };
        if matches!(task_state, ManagedTaskTerminalStateV1::Unknown
            | ManagedTaskTerminalStateV1::Active | ManagedTaskTerminalStateV1::PendingVerification)
        {
            chain_settled = false;
        }
        let attempt_state = match attempt.phase {
            AttemptPhase::Succeeded => ManagedAttemptTerminalStateV1::Succeeded,
            AttemptPhase::Failed => ManagedAttemptTerminalStateV1::Failed,
            AttemptPhase::Unknown => ManagedAttemptTerminalStateV1::Unknown,
            _ => unreachable!("nonterminal Attempt phases were rejected"),
        };
        let evidence_refs = attempt.verifier_evidence.as_ref().map(|evidence| {
            evidence.criteria.iter().flat_map(|criterion| criterion.artifact_refs.iter().cloned()).collect()
        }).unwrap_or_default();
        let evidence_digest = attempt.verifier_evidence.as_ref().map(|evidence| evidence.evidence_digest.clone())
            .or_else(|| task.verification_evidence.as_ref().map(|evidence| evidence.evidence_digest.clone()));
        let attempt_state_value = json!({
            "goalID": goal_id, "runID": run_id, "taskID": task_id, "attemptID": attempt_id,
            "runPhase": format!("{:?}", run.phase), "taskState": format!("{task_state:?}"),
            "attemptState": format!("{attempt_state:?}"), "executorPrincipal": attempt.executor_principal,
            "ownerEpoch": attempt.owner_epoch.to_string(), "locationID": attempt.location_id,
            "childSessionID": attempt.session_id, "workspaceRevision": attempt.workspace_revision,
            "observedWorkspaceHead": if workspace_head_confident { workspace_head.as_deref() } else { None },
            "bindingDigest": binding_digest, "receiptDigest": attempt.receipt_digest,
            "failureCode": attempt.failure_code, "retryable": attempt.retryable,
            "effectChainDigest": effect_chain_digest, "evidenceDigest": evidence_digest,
            "quiescenceReceiptDigest": prompt_marker.map(|marker| marker.receipt_digest.as_str()),
        });
        let attempt_state_digest = format!("blake3:{}", blake3::hash(attempt_state_value.to_string().as_bytes()).to_hex());
        let owner_log_sequence = watermark.sequence.parse::<u64>()
            .map_err(|_| ManagedError::Invalid("OwnerLog sequence is invalid"))?;
        Ok(ManagedAttemptTerminalSnapshotV1 {
            goal_id: goal_id.to_owned(), run_id: run_id.to_owned(), task_id: task_id.to_owned(),
            attempt_id: attempt_id.to_owned(), task_revision, attempt_revision,
            managed_revision: watermark.revision, spec_id: run.spec_id.clone(), spec_digest: spec.digest.clone(),
            run_phase: run.phase, task_state, attempt_state, child_prompt_state,
            child_prompt_quiescence_digest: prompt_marker.map(|marker| marker.receipt_digest.clone()),
            child_prompt_quiescence_owner_log_id: prompt_marker.map(|marker| marker.owner_log_id.clone()),
            child_prompt_quiescence_owner_log_sequence: prompt_marker.map(|marker| marker.owner_log_sequence),
            child_prompt_quiescence_owner_log_event_digest: prompt_marker.map(|marker| marker.owner_log_event_digest.clone()),
            child_prompt_quiescence: prompt_marker.cloned(),
            admission_workspace_revision: attempt.workspace_revision.clone(),
            observed_workspace_head: if workspace_head_confident { workspace_head } else { None },
            binding_digest, owner_log_id: watermark.owner_log_id, owner_log_sequence,
            owner_log_event_digest: watermark.event_digest, attempt_state_digest,
            effect_chain_state: if chain_settled { ManagedAttemptEffectChainStateV1::AllSettled }
                else { ManagedAttemptEffectChainStateV1::UnresolvedOrUnknown },
            effect_chain_digest, effects, evidence_digest, evidence_refs,
        })
    }

    /// Exact idempotent replay lookup for P1's managed prompt-completion route.
    pub(crate) fn managed_dispatch_quiesced_receipt(
        &self,
        attempt_id: &str,
        delivery_id: &str,
    ) -> Result<Option<ManagedDispatchQuiescedReceiptV1>, ManagedError> {
        match self.snapshot.dispatch_quiescence.get(attempt_id) {
            Some(receipt) if receipt.proof.delivery_id == delivery_id => Ok(Some(receipt.clone())),
            Some(_) => Err(ManagedError::Conflict("managed child prompt quiescence was committed by another delivery")),
            None => Ok(None),
        }
    }

    pub(crate) fn mark_managed_dispatch_quiesced(
        &mut self,
        expected_revision: u64,
        proof: ManagedDispatchQuiescenceProofV1,
    ) -> Result<ManagedDispatchQuiescedReceiptV1, ManagedError> {
        let attempt_id = proof.attempt_id.clone();
        let delivery_id = proof.delivery_id.clone();
        if let Some(existing) = self.snapshot.dispatch_quiescence.get(&attempt_id) {
            return if existing.proof == proof {
                Ok(existing.clone())
            } else {
                Err(ManagedError::Conflict("managed prompt quiescence was already recorded with different proof"))
            };
        }
        let binding_digest = self.snapshot.attempts.get(&attempt_id)
            .and_then(|attempt| attempt.delegation_binding.as_ref())
            .ok_or(ManagedError::Conflict("managed prompt DelegationBinding is missing"))?
            .digest()
            .map_err(|_| ManagedError::Invalid("managed prompt binding digest failed"))?;
        let completion = self.managed_dispatch_completion_snapshot(
            &proof.goal_id, &proof.run_id, &proof.task_id, &proof.attempt_id, &binding_digest,
        )?;
        let consumed = completion.consumed_receipt();
        if expected_revision != completion.managed_revision()
            || proof.goal_id != completion.goal_id()
            || proof.run_id != completion.run_id()
            || proof.task_id != completion.task_id()
            || proof.parent_session_id != completion.parent_session_id()
            || proof.session_id != completion.session_id()
            || proof.attempt_id != completion.attempt_id()
            || proof.handoff_id != completion.handoff_id()
            || proof.handoff_digest != completion.handoff_digest()
            || proof.consume_delivery_id != completion.consume_delivery_id()
            || proof.consume_receipt_digest != completion.consume_receipt_digest()
            || proof.owner_epoch != consumed.owner_epoch
            || proof.process_incarnation != consumed.process_incarnation
            || proof.delivery_id.is_empty()
        {
            return Err(ManagedError::Conflict("HostKernel quiescence proof differs from the current SETTLING child and consumed handoff"));
        }
        self.apply(expected_revision, &delivery_id, ManagedCommand::DispatchQuiesced { proof })?;
        self.snapshot.dispatch_quiescence.get(&attempt_id).cloned()
            .ok_or(ManagedError::Invalid("managed prompt quiescence receipt missing after append"))
    }

    /// Exact replay lookup for a committed candidate tombstone. HostKernel
    /// consults this before deriving the current generation's candidate ID.
    pub(crate) fn candidate_abandonment_receipt(
        &self,
        delivery_id: &str,
    ) -> Option<ManagedCandidateAbandonedReceiptV1> {
        self.snapshot.candidate_abandonments.get(delivery_id).cloned()
    }

    /// Exact admission replay lookup. HostKernel invokes this before current
    /// Task/revision checks, then revalidates P8 attachment and current authority.
    pub(crate) fn managed_attempt_admission_receipt(
        &self,
        delivery_id: &str,
    ) -> Option<ManagedAttemptAdmissionReceiptV1> {
        self.snapshot.managed_admission_receipts.get(delivery_id).cloned()
    }

    /// Exact replay lookup for a consumed managed prompt dispatch. A different
    /// delivery cannot consume the same Attempt; callers must not reconstruct a
    /// fresh P8 proof after this no-replay fence has committed.
    pub(crate) fn managed_dispatch_consumed_receipt(
        &self,
        attempt_id: &str,
        delivery_id: &str,
    ) -> Result<Option<ManagedDispatchConsumedReceiptV1>, ManagedError> {
        match self.snapshot.dispatch_consumptions.get(attempt_id) {
            Some(receipt) if receipt.delivery_id == delivery_id => Ok(Some(receipt.clone())),
            Some(_) => Err(ManagedError::Conflict("managed Attempt prompt dispatch was consumed by another delivery")),
            None => Ok(None),
        }
    }

    pub fn attempt_effect_bound_revision(
        &self,
        attempt_id: &str,
        effect_id: &str,
    ) -> Option<u64> {
        self.snapshot
            .attempt_effect_bound_revision(attempt_id, effect_id)
    }

    /// Atomically persists the complete immutable Task/profile plan in one
    /// OwnerLog event. A lost response is recovered by replaying the same
    /// delivery ID and exact payload; partial Run-without-Task plans cannot
    /// occur.
    pub(crate) fn plan_run(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        run_id: &str,
        spec_id: &str,
        spec_digest: &str,
        tasks: &[PlannedTaskV1],
    ) -> Result<u64, ManagedError> {
        self.apply(expected_revision, delivery_id, ManagedCommand::PlanRun {
            run_id: run_id.to_owned(),
            spec_id: spec_id.to_owned(),
            spec_digest: spec_digest.to_owned(),
            tasks: tasks.to_vec(),
        })?;
        Ok(self.snapshot.revision)
    }

    /// Starts the exact durable plan after authenticated human confirmation.
    /// The request has no Task/profile inputs; OwnerLog replay is idempotent
    /// only for the same delivery ID and exact trusted actor/pins.
    pub(crate) fn start_planned_run(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        run_id: &str,
        spec_id: &str,
        spec_digest: &str,
        started_by: &str,
        session_link: SessionLink,
    ) -> Result<u64, ManagedError> {
        let plan_digest = self.snapshot.runs.get(run_id)
            .ok_or(ManagedError::Conflict("planned Run missing"))
            .map(planned_task_set_digest)?;
        self.apply(expected_revision, delivery_id, ManagedCommand::StartPlannedRun {
            run_id: run_id.to_owned(),
            spec_id: spec_id.to_owned(),
            spec_digest: spec_digest.to_owned(),
            plan_digest,
            expected_goal_revision: expected_revision,
            started_by: started_by.to_owned(),
            session_link: Some(session_link),
        })?;
        Ok(self.snapshot.revision)
    }

    /// Exact trusted time from the durable `planned_run_started` OwnerLog
    /// envelope. Since the envelope timestamp is minted only after admission
    /// checks, it survives replay and cannot be extended by request retries.
    pub(crate) fn run_started_at_ms(&self, run_id: &str) -> Option<u64> {
        self.snapshot.runs.get(run_id).and_then(|run| run.started_at_ms)
    }

    /// True only when this Run's root SessionLink was part of the explicit
    /// authenticated start event. Compatibility AttachSessionLink events cannot
    /// grant scheduler or admission eligibility to legacy Runs.
    pub(crate) fn session_link_pinned_at_start(&self, run_id: &str) -> bool {
        self.snapshot.session_links_pinned_at_start.contains(run_id)
    }

    /// Remaining accepted Spec duration for a Run with a HostKernel-authenticated
    /// explicit start timestamp. `None` means the event predates timestamped
    /// starts and therefore cannot authorize a duration-bounded lease.
    pub(crate) fn run_remaining_ms(
        &self,
        run_id: &str,
        now_ms: u64,
    ) -> Result<Option<u64>, ManagedError> {
        let Some(run) = self.snapshot.runs.get(run_id) else {
            return Err(ManagedError::NotFound("managed Run is unknown"));
        };
        let Some(started_at_ms) = run.started_at_ms else {
            return Ok(None);
        };
        if now_ms < started_at_ms {
            return Err(ManagedError::Conflict("HostKernel clock precedes the durable Run start"));
        }
        if run.phase != RunPhase::Running {
            return Err(ManagedError::Conflict("Run is not active for managed admission"));
        }
        let spec = self.snapshot.specs.get(&run.spec_id)
            .ok_or(ManagedError::Conflict("Run accepted SpecVersion is unavailable"))?;
        if spec.content.budget.max_run_duration_ms == 0 {
            return Err(ManagedError::Conflict("accepted SpecVersion has no positive Run duration"));
        }
        Ok(Some(spec.content.budget.max_run_duration_ms.saturating_sub(now_ms - started_at_ms)))
    }

    /// Durably pins the verifier profile, exact criterion, source revision and
    /// Guard lease facts to one already-bound EffectIntent before dispatch.
    /// The opaque value can be constructed only by HostKernel after resolving
    /// the live Attempt and trusted verifier registry.
    pub(crate) fn bind_attempt_verifier_intent(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        intent: &ManagedAttemptVerifierIntentV1,
    ) -> Result<u64, ManagedError> {
        self.apply(expected_revision, delivery_id, ManagedCommand::BindAttemptVerifierIntent {
            intent: intent.clone(),
        })?;
        Ok(self.snapshot.revision)
    }

    /// Persists one HostKernel-authenticated target receipt while the Attempt
    /// stays executing. UNKNOWN is a durable no-relaunch fence and is recovered
    /// as RECONCILING after process restart.
    pub(crate) fn record_attempt_effect_receipt(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        proof: &ManagedAttemptEffectReceiptProofV1,
    ) -> Result<u64, ManagedError> {
        self.apply(expected_revision, delivery_id, ManagedCommand::RecordAttemptEffectReceipt {
            proof: proof.clone(),
        })?;
        Ok(self.snapshot.revision)
    }

    /// Appends a HostKernel-authenticated terminal target receipt while an
    /// Attempt is UNKNOWN. The reducer accepts only the first unresolved edge
    /// and preserves the UNKNOWN/RECONCILING dispatch fence until failure
    /// settlement; this API never resumes or relaunches an effect.
    pub(crate) fn reconcile_attempt_effect_receipt(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        proof: &ManagedAttemptEffectReceiptProofV1,
    ) -> Result<u64, ManagedError> {
        self.apply(expected_revision, delivery_id, ManagedCommand::ReconcileAttemptEffectReceipt {
            proof: proof.clone(),
        })?;
        Ok(self.snapshot.revision)
    }

    pub(crate) fn accepted_task_capability_scope_facts(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<AcceptedTaskCapabilityScopeFactsV1, ManagedError> {
        let goal = self
            .snapshot
            .goal
            .as_ref()
            .ok_or(ManagedError::Conflict("managed Goal missing"))?;
        let run = self
            .snapshot
            .runs
            .get(run_id)
            .ok_or(ManagedError::Conflict("managed Run missing"))?;
        let task = run
            .tasks
            .get(task_id)
            .ok_or(ManagedError::Conflict("managed Task missing"))?;
        let spec = self
            .snapshot
            .specs
            .get(&run.spec_id)
            .ok_or(ManagedError::Conflict("accepted SpecVersion missing"))?;
        if !spec.accepted
            || goal.active_spec_version_id.as_deref() != Some(run.spec_id.as_str())
            || spec.digest != spec.content.digest()
            || run.phase != RunPhase::Running
            || task
                .required_capabilities
                .iter()
                .any(|capability| !spec.content.capability_scope.contains(capability))
        {
            return Err(ManagedError::Conflict(
                "managed Task capability scope is stale or outside accepted SpecVersion",
            ));
        }
        validate_capability_ids(
            &spec.content.capability_scope,
            "accepted SpecVersion capability scope is not canonical",
        )?;
        validate_capability_ids(
            &task.required_capabilities,
            "accepted Task required capabilities are not canonical",
        )?;
        Ok(AcceptedTaskCapabilityScopeFactsV1 {
            run_id: run_id.to_owned(),
            task_id: task_id.to_owned(),
            spec_id: run.spec_id.clone(),
            spec_digest: spec.digest.clone(),
            managed_revision: self.snapshot.revision,
            capability_scope: spec.content.capability_scope.clone(),
            required_capabilities: task.required_capabilities.clone(),
            profile_revision: task.agent_profile_revision.clone(),
            profile_owner_binding_digest: task.profile_owner_binding_digest.clone(),
        })
    }

    /// Opens one already-created durable Goal without allocating an owner log for
    /// an unknown identifier. The authenticated kernel ingress uses this so a
    /// forged, not-yet-proposed or not-yet-accepted Goal binding can never create
    /// durable state, and a missing Goal fails closed as NOT_FOUND.
    pub fn open_existing(root: &Path, goal_id: &str) -> Result<Self, ManagedError> {
        id(goal_id)?;
        if !owner_head_exists(root, "managed_goal", goal_id) {
            return Err(ManagedError::NotFound("managed Goal is unknown"));
        }
        Self::open(root, goal_id)
    }

    /// Cheap durable-existence probe for the plan ingress: `create_goal` must answer
    /// an existing Goal from durable state (replay or typed conflict) instead of
    /// allocating a second owner log for the same id.
    pub fn goal_exists(root: &Path, goal_id: &str) -> bool {
        id(goal_id).is_ok() && owner_head_exists(root, "managed_goal", goal_id)
    }

    /// Discovers existing managed Goal owners from committed owner heads without
    /// creating logs. Every candidate directory is revalidated by `open_existing`
    /// at the caller before its snapshot is exposed. The scan is bounded and rejects
    /// symlinked or oversized heads instead of following them.
    pub fn existing_goal_ids(root: &Path, max: usize) -> Result<Vec<String>, ManagedError> {
        const MAX_OWNER_HEADS_TO_SCAN: usize = 256;
        let owners = root.join("owners");
        match fs::symlink_metadata(&owners) {
            Ok(value) if value.is_dir() && !value.file_type().is_symlink() => {}
            Ok(_) => return Err(ManagedError::Invalid("managed owner directory is unsafe")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => {
                return Err(ManagedError::Invalid(
                    "managed owner directory is unavailable",
                ));
            }
        }
        let entries = fs::read_dir(&owners)
            .map_err(|_| ManagedError::Invalid("managed owner directory is unavailable"))?;
        let mut goal_ids = Vec::new();
        let mut scanned = 0usize;
        for entry in entries {
            scanned = scanned
                .checked_add(1)
                .ok_or(ManagedError::Invalid("managed owner listing overflow"))?;
            if scanned > MAX_OWNER_HEADS_TO_SCAN {
                return Err(ManagedError::Invalid(
                    "managed owner listing exceeds scan bound",
                ));
            }
            let entry =
                entry.map_err(|_| ManagedError::Invalid("managed owner entry is unavailable"))?;
            let file_type = entry
                .file_type()
                .map_err(|_| ManagedError::Invalid("managed owner entry is unavailable"))?;
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let directory_key = entry
                .file_name()
                .into_string()
                .map_err(|_| ManagedError::Invalid("managed owner key is invalid"))?;
            if directory_key.len() != 64
                || !directory_key.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                continue;
            }
            let head = entry.path().join("head.json");
            let head_metadata = match fs::symlink_metadata(&head) {
                Ok(value) if value.is_file() && !value.file_type().is_symlink() => value,
                Ok(_) => return Err(ManagedError::Invalid("managed owner head is unsafe")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(ManagedError::Invalid("managed owner head is unavailable")),
            };
            if head_metadata.len() > crate::owner_log::MAX_OWNER_METADATA_BYTES as u64 {
                return Err(ManagedError::Invalid(
                    "managed owner head exceeds size bound",
                ));
            }
            let bytes = fs::read(&head)
                .map_err(|_| ManagedError::Invalid("managed owner head is unavailable"))?;
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| ManagedError::Invalid("managed owner head is malformed"))?;
            let object = value
                .as_object()
                .ok_or(ManagedError::Invalid("managed owner head is malformed"))?;
            if object.get("owner_kind").and_then(Value::as_str) != Some("managed_goal") {
                continue;
            }
            let goal_id = object
                .get("owner_id")
                .and_then(Value::as_str)
                .ok_or(ManagedError::Invalid("managed owner identity is malformed"))?;
            id(goal_id)?;
            let owner = OwnerIdentity::new("managed_goal".to_owned(), goal_id.to_owned())?;
            if owner.directory_key() != directory_key {
                return Err(ManagedError::Invalid(
                    "managed owner head does not match its directory",
                ));
            }
            goal_ids.push(goal_id.to_owned());
            if goal_ids.len() > max {
                return Err(ManagedError::Invalid(
                    "managed Goal listing exceeds result bound",
                ));
            }
        }
        goal_ids.sort();
        goal_ids.dedup();
        Ok(goal_ids)
    }

    /// One-use delivery-key classification for the plan ingress: `Ok(true)` when the
    /// exact logical command was already applied (a lost response may be retried
    /// idempotently), `Ok(false)` when the key is unused, and a typed conflict when
    /// the key was reused for a different command.
    pub fn is_replay(
        &self,
        delivery_id: &str,
        command: &ManagedCommand,
    ) -> Result<bool, ManagedError> {
        let (kind, data) = command.event();
        match self.snapshot.deliveries.get(delivery_id) {
            None => Ok(false),
            Some(previous) if previous == &logical_command_digest(kind, &data) => Ok(true),
            Some(_) => Err(ManagedError::Conflict(
                "idempotency key reused for different command",
            )),
        }
    }

    /// True when this durable delivery key was already applied to this Goal,
    /// regardless of the command's volatile fields. Plan-ingress operations whose
    /// command carries a kernel-generated timestamp (spec acceptance/rejection) use
    /// this so a lost response is answered from the recorded decision instead of
    /// re-deriving a different command; the caller must still verify that the
    /// recorded decision matches the request it is replaying.
    pub fn is_delivered(&self, delivery_id: &str) -> bool {
        self.snapshot.deliveries.contains_key(delivery_id)
    }

    /// Consumes a HostKernel-minted verifier observation and exact host-produced
    /// artifact references. This is the only code path that may construct typed
    /// verifier evidence: neither request data nor child stdout can create the
    /// opaque observation or its identities.
    pub(crate) fn record_observed_verification<F>(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        observed: &ObservedVerifierRunV1,
        current_workspace_revision: &str,
        current_owner_epoch: u64,
        artifact_refs_by_criterion: BTreeMap<String, Vec<ArtifactRefV1>>,
        mut verify_artifact: F,
    ) -> Result<(), ManagedError>
    where
        F: FnMut(
            &ArtifactOwnerScopeV1,
            &str,
            &ArtifactRefV1,
            NonZeroUsize,
        ) -> Result<ArtifactMetadataV1, ArtifactError>,
    {
        if observed.goal_id() != self.owner_goal_id
            || observed.owner_epoch() != current_owner_epoch
            || observed.live_workspace_revision() != current_workspace_revision
        {
            return Err(ManagedError::Conflict(
                "verifier observation is stale or belongs to another owner",
            ));
        }
        let run = self
            .snapshot
            .runs
            .get(observed.run_id())
            .ok_or(ManagedError::Conflict("verifier Run is missing"))?;
        let spec = self
            .snapshot
            .specs
            .get(&run.spec_id)
            .ok_or(ManagedError::Conflict("verifier SpecVersion is missing"))?;
        let attempt_id = observed.attempt_id();
        let attempt = self.snapshot.attempts.get(attempt_id)
            .ok_or(ManagedError::Conflict("verifier Attempt is missing"))?;
        let task = run.tasks.get(&attempt.task_id)
            .ok_or(ManagedError::Conflict("verifier Task is missing"))?;
        if observed.spec_id() != run.spec_id
            || observed.spec_digest() != spec.digest
            || observed.verification_run_id().is_empty()
            || run.phase != RunPhase::Verifying
            || run.final_revision.as_deref() != Some(observed.live_workspace_revision())
            || attempt.phase != AttemptPhase::Executing
            || task.active_attempt.as_deref() != Some(attempt_id)
            || task.pending_verification_attempt.as_deref() != Some(attempt_id)
            || attempt.run_id != observed.run_id()
            || attempt.verifier_evidence.is_some()
            || attempt.executor_principal == observed.verifier_principal()
            || spec.content.proposed_by == observed.verifier_principal()
            || spec.accepted_by.as_deref() == Some(observed.verifier_principal())
            || spec.reviewer_id.as_deref() == Some(observed.verifier_principal())
            || observed.aggregate_duration_ms() > spec.content.budget.max_run_duration_ms
        {
            return Err(ManagedError::Conflict(
                "verifier observation no longer matches the live accepted Attempt",
            ));
        }
        if attempt.effects.len() != attempt.effect_receipts.len()
            || attempt.effects.iter().any(|effect| {
                let Some(receipt) = attempt.effect_receipts.get(&effect.effect_id) else { return true };
                receipt.outcome == AttemptEffectOutcomeV1::Unknown
                    || (receipt.outcome == AttemptEffectOutcomeV1::Failed
                        && !attempt.verifier_intents.contains_key(&effect.effect_id))
            })
        {
            return Err(ManagedError::Conflict(
                "verifier output requires all exact coding and verifier receipts to be durably settled",
            ));
        }

        let accepted: BTreeSet<&str> = spec
            .content
            .criteria
            .iter()
            .map(|criterion| criterion.id.as_str())
            .collect();
        let supplied: BTreeSet<&str> = observed
            .criteria()
            .iter()
            .map(|criterion| criterion.criterion_id())
            .collect();
        let artifacts: BTreeSet<&str> = artifact_refs_by_criterion
            .keys()
            .map(String::as_str)
            .collect();
        if !verification_criteria_match_exact_accepted_set(&accepted, &supplied, &artifacts) {
            return Err(ManagedError::Conflict(
                "verifier observation or artifacts do not cover the exact accepted criteria",
            ));
        }
        if attempt.verifier_intents.len() != observed.criteria().len()
            || observed.criteria().iter().any(|criterion| {
                let Some(intent) = attempt.verifier_intents.get(criterion.effect_id()) else { return true };
                intent.attempt_id != attempt_id
                    || intent.verifier_principal != observed.verifier_principal()
                    || intent.verifier_profile_id != observed.profile_id()
                    || intent.executable_digest != observed.executable_digest()
                    || intent.profile_digest != observed.profile_digest()
                    || intent.owner_epoch != observed.owner_epoch()
                    || intent.criterion_id != criterion.criterion_id()
                    || intent.test_identity != criterion.test_identity()
                    || intent.source_workspace_revision != current_workspace_revision
                    || attempt.effect_receipts.get(criterion.effect_id()).is_none_or(|receipt| {
                        receipt.outcome == AttemptEffectOutcomeV1::Unknown
                            || receipt.after_workspace_revision.as_deref() != Some(current_workspace_revision)
                    })
            })
        {
            return Err(ManagedError::Conflict(
                "verifier observation differs from persisted per-criterion intent and receipt",
            ));
        }

        let owner = ArtifactOwnerScopeV1::new("verification_run", observed.verification_run_id())
            .map_err(|_| {
            ManagedError::Invalid("verification artifact owner scope is invalid")
        })?;
        let max_artifact_bytes = NonZeroUsize::new(MAX_VERIFIER_ARTIFACT_BYTES).ok_or(
            ManagedError::Invalid("verification artifact limit is invalid"),
        )?;
        let mut total_output_bytes = 0u64;
        let mut total_artifact_bytes = 0u64;
        let mut criteria = Vec::with_capacity(observed.criteria().len());
        for criterion in observed.criteria() {
            let refs = artifact_refs_by_criterion
                .get(criterion.criterion_id())
                .ok_or(ManagedError::Conflict(
                    "verifier criterion artifacts are missing",
                ))?;
            if refs.is_empty() || refs.len() > 64 {
                return Err(ManagedError::Invalid(
                    "verification artifact count exceeds bounds",
                ));
            }
            for reference in refs {
                let metadata = verify_artifact(
                    &owner,
                    observed.verifier_principal(),
                    reference,
                    max_artifact_bytes,
                )
                .map_err(|_| ManagedError::Conflict("verification artifact validation failed"))?;
                let classification = match metadata.access {
                    ArtifactAccessV1::Public => ArtifactClassificationV1::Public,
                    ArtifactAccessV1::Workspace => ArtifactClassificationV1::Workspace,
                    ArtifactAccessV1::Sensitive => ArtifactClassificationV1::Sensitive,
                };
                if metadata.artifact_id != reference.artifact_id
                    || metadata.digest != reference.digest
                    || metadata.byte_length != reference.byte_length
                    || metadata.media_type != reference.media_type
                    || classification != reference.classification
                    || !metadata
                        .owner_refs
                        .iter()
                        .any(|owner_ref| owner_ref == &owner.owner_ref())
                {
                    return Err(ManagedError::Conflict(
                        "verification artifact reference differs from canonical metadata",
                    ));
                }
                let byte_length = reference.byte_length.parse::<u64>().map_err(|_| {
                    ManagedError::Invalid("verification artifact length is invalid")
                })?;
                total_artifact_bytes =
                    total_artifact_bytes
                        .checked_add(byte_length)
                        .ok_or(ManagedError::Invalid(
                            "verification artifact total overflow",
                        ))?;
            }
            let process_output = criterion.output_bytes();
            total_output_bytes = total_output_bytes
                .checked_add(process_output)
                .ok_or(ManagedError::Invalid("verifier output total overflow"))?;
            criteria.push(CriterionTestEvidenceV1 {
                criterion_id: criterion.criterion_id().to_owned(),
                verdict: criterion.verdict(),
                test_identity: criterion.test_identity().to_owned(),
                test_run_id: criterion.test_run_id().to_owned(),
                process: CriterionVerifierProcessEvidenceV1 {
                    execution_id: criterion.execution_id().to_owned(),
                    generation: criterion.generation(),
                    exit_code: criterion.exit_code(),
                    stdout_digest: criterion.stdout_digest().to_owned(),
                    stderr_digest: criterion.stderr_digest().to_owned(),
                    output_bytes: process_output,
                    duration_ms: criterion.duration_ms(),
                    truncated: criterion.truncated(),
                },
                artifact_refs: refs.clone(),
            });
        }
        if total_output_bytes != observed.aggregate_output_bytes()
            || total_output_bytes > MAX_VERIFIER_RUN_OUTPUT_BYTES
            || total_artifact_bytes > MAX_VERIFIER_RUN_OUTPUT_BYTES
        {
            return Err(ManagedError::Invalid(
                "verifier aggregate output or artifacts exceed bounds",
            ));
        }
        let mut evidence = VerificationEvidenceV1 {
            verification_run_id: observed.verification_run_id().to_owned(),
            verifier_id: observed.verifier_principal().to_owned(),
            source_revision: current_workspace_revision.to_owned(),
            profile: VerifierProfileEvidenceV1 {
                profile_id: observed.profile_id().to_owned(),
                owner_epoch: observed.owner_epoch(),
                executable_digest: observed.executable_digest().to_owned(),
                profile_digest: observed.profile_digest().to_owned(),
            },
            aggregate_output_bytes: total_output_bytes,
            aggregate_duration_ms: observed.aggregate_duration_ms(),
            criteria,
            evidence_digest: String::new(),
        };
        evidence.evidence_digest = verification_evidence_digest(&evidence);
        self.apply(
            expected_revision,
            delivery_id,
            ManagedCommand::RecordAttemptVerifierEvidence {
                attempt_id: attempt_id.to_owned(),
                evidence,
            },
        )
    }

    /// Atomically creates a new Goal and its first immutable SpecVersion in one
    /// durable OwnerLog event. Validation and state projection happen before the
    /// append; a rejected proposal leaves no committed Goal or partial revision.
    pub fn create_goal_proposal(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        goal_id: String,
        spec_id: String,
        goal: GoalDraft,
        spec: SpecVersionDraft,
    ) -> Result<CreatedGoalProposal, ManagedError> {
        id(&goal_id)?;
        if goal_id != self.goal_id {
            return Err(ManagedError::Conflict(
                "Goal id does not match the managed owner",
            ));
        }
        if goal.created_by != spec.proposed_by {
            return Err(ManagedError::Conflict(
                "Goal creator and initial SpecVersion proposer differ",
            ));
        }
        if goal.objective != spec.objective {
            return Err(ManagedError::Conflict(
                "Goal and initial SpecVersion objectives differ",
            ));
        }
        let spec_digest = spec.digest();
        self.apply(
            expected_revision,
            delivery_id,
            ManagedCommand::CreateGoalProposal {
                goal,
                spec_id: spec_id.clone(),
                spec,
                spec_digest,
            },
        )?;
        let goal = self
            .snapshot
            .goal
            .as_ref()
            .ok_or(ManagedError::Conflict("managed Goal was not created"))?;
        let spec = self
            .snapshot
            .specs
            .get(&spec_id)
            .ok_or(ManagedError::Conflict(
                "initial SpecVersion was not proposed",
            ))?;
        Ok(CreatedGoalProposal {
            goal_id,
            spec_id,
            spec_digest: spec.digest.clone(),
            created_by: goal.created_by.clone(),
            proposed_by: spec.content.proposed_by.clone(),
            revision: self.snapshot.revision,
        })
    }

    pub fn apply(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        command: ManagedCommand,
    ) -> Result<(), ManagedError> {
        id(delivery_id)?;
        if let ManagedCommand::RecordVerificationEvidence { evidence, .. } = &command {
            validate_verification_evidence(evidence)?;
            if evidence.evidence_digest != verification_evidence_digest(evidence) {
                return Err(ManagedError::Conflict(
                    "verification evidence digest mismatch",
                ));
            }
        }
        if let ManagedCommand::RecordAttemptVerifierEvidence { evidence, .. } = &command {
            validate_verification_evidence(evidence)?;
            if evidence.evidence_digest != verification_evidence_digest(evidence) {
                return Err(ManagedError::Conflict("Attempt verifier evidence digest mismatch"));
            }
        }
        let (requested_kind, requested_data) = command.event();
        let requested_logical = logical_command_digest(requested_kind, &requested_data);
        if let Some(previous) = self.snapshot.deliveries.get(delivery_id) {
            if previous == &requested_logical {
                return Ok(());
            }
            if matches!(&command, ManagedCommand::BeginVerification { .. }) {
                let receipt_backed = self.receipt_backed_begin_command(command.clone())?;
                let (kind, data) = receipt_backed.event();
                return if previous == &logical_command_digest(kind, &data) {
                    Ok(())
                } else {
                    Err(ManagedError::Conflict(
                        "idempotency key reused for different command",
                    ))
                };
            }
            return Err(ManagedError::Conflict(
                "idempotency key reused for different command",
            ));
        }
        if self.snapshot.revision != expected_revision {
            return Err(ManagedError::Conflict("stale managed revision"));
        }
        let command = self.receipt_backed_begin_command(command)?;
        let (kind, data) = command.event();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ManagedError::Invalid("system time invalid"))?
            .as_millis() as u64;
        if matches!(&command, ManagedCommand::StartPlannedRun { .. }) && timestamp == 0 {
            return Err(ManagedError::Invalid("HostKernel clock produced an invalid Run start timestamp"));
        }
        let mut event = OwnerEventInput {
            schema_version: 1,
            time_ms: timestamp,
            kind: kind.to_owned(),
            data,
            delivery_id: None,
            command_digest: None,
        };
        let command_digest = OwnerLogV2::command_digest(delivery_id, &[event.clone()])?;
        // Existing deliveries were classified above using their exact physical
        // event shape. New BeginVerification calls are normalized to the
        // receipt-backed event before a command digest is calculated.
        let logical = logical_command_digest(kind, &event.data);
        let mut next = self.snapshot.clone();
        next.apply(&command)?;
        if let ManagedCommand::AdmitAttemptWithDelegation { attempt_id, .. } = &command {
            let admission_receipt = ManagedAttemptAdmissionReceiptV1::from_snapshot(
                &self.goal_id, delivery_id, attempt_id, &next,
            )?;
            next.managed_admission_receipts.insert(delivery_id.to_owned(), admission_receipt);
        }
        if let ManagedCommand::StartPlannedRun { run_id, .. } = &command {
            let run = next.runs.get_mut(run_id)
                .ok_or(ManagedError::Invalid("started Run missing after durable transition"))?;
            if run.started_at_ms.replace(timestamp).is_some() {
                return Err(ManagedError::Conflict("Run already has a trusted start timestamp"));
            }
        }
        event.delivery_id = Some(delivery_id.to_owned());
        event.command_digest = Some(command_digest.clone());
        let receipt =
            self.log
                .append_batch(delivery_id, &command_digest, &[event], self.cursor.as_ref())?;
        if let ManagedCommand::DispatchQuiesced { proof } = &command {
            let marker_sequence = receipt.owner_cursor.seq.parse::<u64>()
                .map_err(|_| ManagedError::Invalid("dispatch quiescence OwnerLog sequence is invalid"))?;
            let marker = ManagedDispatchQuiescedReceiptV1::new(
                proof,
                next.revision,
                receipt.owner_cursor.owner_id.clone(),
                marker_sequence,
                receipt.owner_cursor.event_digest.clone(),
            );
            if next.dispatch_quiescence.insert(proof.attempt_id.clone(), marker).is_some() {
                return Err(ManagedError::Conflict("managed dispatch quiescence already exists"));
            }
        }
        next.deliveries.insert(delivery_id.to_owned(), logical);
        self.snapshot = next;
        self.cursor = Some(receipt.owner_cursor);
        Ok(())
    }

    fn receipt_backed_begin_command(
        &self,
        command: ManagedCommand,
    ) -> Result<ManagedCommand, ManagedError> {
        match command {
            ManagedCommand::BeginVerification {
                run_id,
                final_revision,
                verifier_id,
            } => {
                let run = self
                    .snapshot
                    .runs
                    .get(&run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                let receipt_basis_digest =
                    successful_task_receipt_basis_digest(&run_id, run, &self.snapshot.attempts)?;
                Ok(ManagedCommand::BeginVerificationWithReceiptBasis {
                    run_id,
                    final_revision,
                    verifier_id,
                    receipt_basis_digest,
                })
            }
            other => Ok(other),
        }
    }

    /// Persist a trusted immutable authority binding after all accepted-state and
    /// live lease inputs have been resolved. The binding revision is checked by
    /// projection against the exact post-append OwnerLog revision.
    pub fn bind_attempt_delegation(
        &mut self,
        delivery_id: &str,
        attempt_id: &str,
        binding: DelegationBindingV1,
    ) -> Result<(), ManagedError> {
        self.apply(
            self.snapshot.revision,
            delivery_id,
            ManagedCommand::BindAttemptDelegation {
                attempt_id: attempt_id.to_owned(),
                binding,
            },
        )
    }

    /// Atomically binds a complete admitted effect batch before any member is
    /// dispatched. One immutable OwnerLog event and revision covers every edge.
    pub(crate) fn bind_attempt_effects(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        effect_ids: Vec<String>,
        location_id: &str,
        session_id: &str,
    ) -> Result<u64, ManagedError> {
        self.apply(
            expected_revision,
            delivery_id,
            ManagedCommand::BindAttemptEffects {
                run_id: run_id.to_owned(),
                task_id: task_id.to_owned(),
                attempt_id: attempt_id.to_owned(),
                effect_ids,
                location_id: location_id.to_owned(),
                session_id: session_id.to_owned(),
            },
        )?;
        Ok(self.snapshot.revision)
    }

    /// Persist the one-use Core prompt-dispatch fence after HostKernel has
    /// authenticated the caller and validated the exact P8 claim proof. Exact
    /// delivery replay returns the original durable receipt even after later
    /// aggregate revisions; changed proof reuse conflicts.
    pub(crate) fn consume_managed_dispatch(
        &mut self,
        expected_revision: u64,
        proof: ManagedDispatchConsumeProofV1,
    ) -> Result<ManagedDispatchConsumedReceiptV1, ManagedError> {
        if expected_revision != proof.expected_managed_revision {
            return Err(ManagedError::Conflict("managed dispatch expected revision mismatch"));
        }
        let record = ManagedDispatchConsumeRecordV1::from(proof);
        let attempt_id = record.attempt_id.clone();
        let delivery_id = record.delivery_id.clone();
        self.apply(expected_revision, &delivery_id, ManagedCommand::ConsumeManagedDispatch { record })?;
        self.snapshot.dispatch_consumptions.get(&attempt_id).cloned()
            .ok_or(ManagedError::Invalid("managed dispatch receipt missing after durable append"))
    }

    /// Advance a Task's candidate generation only after HostKernel verified
    /// P8's durable NotAdmittedNoDispatch tombstone. Replays return the exact
    /// original receipt, even after a later generation has been allocated.
    pub(crate) fn abandon_pre_admission_candidate(
        &mut self,
        expected_revision: u64,
        proof: ManagedCandidateAbandonProofV1,
    ) -> Result<ManagedCandidateAbandonedReceiptV1, ManagedError> {
        if expected_revision != proof.expected_managed_revision {
            return Err(ManagedError::Conflict("candidate tombstone expected revision mismatch"));
        }
        let delivery_id = proof.delivery_id.clone();
        self.apply(expected_revision, &delivery_id, ManagedCommand::AbandonPreAdmissionCandidate { proof })?;
        self.snapshot.candidate_abandonments.get(&delivery_id).cloned()
            .ok_or(ManagedError::Invalid("candidate tombstone receipt missing after durable append"))
    }

    /// Atomically admit one managed Attempt and persist its immutable
    /// DelegationBinding in a single OwnerLog append. The owner facts are
    /// resolved before this call by trusted Rust owner adapters; an absent
    /// proof, stale scope or conflict leaves the OwnerLog unchanged.
    pub(crate) fn admit_attempt_with_delegation(
        &mut self,
        delivery_id: &str,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        facts: Option<ManagedDelegationAdmissionFactsV1>,
    ) -> Result<(), ManagedError> {
        id(delivery_id)?;
        id(run_id)?;
        id(task_id)?;
        id(attempt_id)?;
        let facts = facts.ok_or(ManagedError::Conflict(
            "managed admission requires complete authenticated owner proofs",
        ))?;
        if facts.authenticated_attempt.goal_id != self.goal_id
            || facts.durable_managed_lease.goal_id() != self.goal_id
            || !durable_lease_proof_matches_attempt(&facts)
        {
            return Err(ManagedError::Conflict(
                "managed admission lease proof does not match this authenticated Goal Attempt",
            ));
        }

        // An exact delivery replay reuses the byte-identical immutable binding;
        // a delivery key cannot be used to rebase or replace its owner facts.
        if self.snapshot.deliveries.contains_key(delivery_id) {
            let attempt = self
                .snapshot
                .attempts
                .get(attempt_id)
                .ok_or(ManagedError::Conflict("replayed managed Attempt missing"))?;
            let binding = attempt
                .delegation_binding
                .as_ref()
                .ok_or(ManagedError::Conflict("replayed binding missing"))?;
            if attempt.run_id != run_id
                || attempt.task_id != task_id
                || attempt.executor_principal != facts.authenticated_attempt.executor_principal
                || attempt.owner_epoch != facts.authenticated_attempt.owner_epoch
                || attempt.location_id != facts.authenticated_attempt.location_id
                || attempt.session_id != facts.authenticated_attempt.session_id
                || attempt.workspace_revision.as_deref()
                    != Some(facts.workspace_source_lease.source_revision.as_str())
                || !delegation_binding_matches_owner_facts(binding, &facts)
            {
                return Err(ManagedError::Conflict(
                    "managed admission replay has changed owner facts",
                ));
            }
            return self.apply(
                self.snapshot.revision,
                delivery_id,
                ManagedCommand::AdmitAttemptWithDelegation {
                    run_id: run_id.to_owned(),
                    task_id: task_id.to_owned(),
                    attempt_id: attempt_id.to_owned(),
                    executor_principal: facts.authenticated_attempt.executor_principal,
                    owner_epoch: facts.authenticated_attempt.owner_epoch,
                    location_id: facts.authenticated_attempt.location_id,
                    session_id: facts.authenticated_attempt.session_id,
                    binding: binding.clone(),
                },
            );
        }

        let mut candidate = self.snapshot.clone();
        candidate.apply(&ManagedCommand::AdmitAttempt {
            run_id: run_id.to_owned(),
            task_id: task_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            executor_principal: facts.authenticated_attempt.executor_principal.clone(),
            owner_epoch: facts.authenticated_attempt.owner_epoch,
            location_id: facts.authenticated_attempt.location_id.clone(),
            session_id: facts.authenticated_attempt.session_id.clone(),
        })?;
        candidate.apply(&ManagedCommand::StartAttempt {
            run_id: run_id.to_owned(),
            task_id: task_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
        })?;
        candidate.apply(&ManagedCommand::BindAttemptWorkspaceRevision {
            attempt_id: attempt_id.to_owned(),
            workspace_revision: facts.workspace_source_lease.source_revision.clone(),
        })?;
        // The candidate was projected through helper commands for validation;
        // persistence is still one composite OwnerLog event, so bind against
        // the real base revision's single increment.
        candidate.revision = self.snapshot.revision;
        let admitted_managed_revision = self
            .snapshot
            .revision
            .checked_add(1)
            .ok_or(ManagedError::Invalid("managed revision overflow"))?;
        let binding = mint_delegation_binding(
            &candidate,
            run_id,
            task_id,
            attempt_id,
            &facts,
            admitted_managed_revision,
        )?;
        self.apply(
            self.snapshot.revision,
            delivery_id,
            ManagedCommand::AdmitAttemptWithDelegation {
                run_id: run_id.to_owned(),
                task_id: task_id.to_owned(),
                attempt_id: attempt_id.to_owned(),
                executor_principal: facts.authenticated_attempt.executor_principal,
                owner_epoch: facts.authenticated_attempt.owner_epoch,
                location_id: facts.authenticated_attempt.location_id,
                session_id: facts.authenticated_attempt.session_id,
                binding,
            },
        )
    }
}

// ---------------------------------------------------------------------------
// Direct (Goal-less) subagent Attempt scope
// ---------------------------------------------------------------------------

/// Phase of one direct subagent Attempt. `Unknown` is a durable outcome, never a
/// resumable state: an Attempt that crossed a host epoch boundary without a settled
/// outcome must be reconciled by target-side evidence, and a fresh dispatch needs a
/// fresh Attempt id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectAttemptPhase {
    Executing,
    Succeeded,
    Failed,
    Unknown,
    Cancelled,
}

impl DirectAttemptPhase {
    pub fn name(self) -> &'static str {
        match self {
            Self::Executing => "EXECUTING",
            Self::Succeeded => "SUCCEEDED",
            Self::Failed => "FAILED",
            Self::Unknown => "UNKNOWN",
            Self::Cancelled => "CANCELLED",
        }
    }
}

/// The authenticated bound dispatch facts of one direct subagent Attempt.
///
/// `scope_digest` is computed by the trusted Core client over the intersected
/// dispatch scope (parent/child session, agent, provider/model, workspace, derived
/// permission set and budget). The kernel records and returns it but never
/// re-derives it; it is a Core-computed `sha256:` digest, while every kernel-computed
/// receipt is BLAKE3 so the two cannot be confused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectAttemptIntent {
    pub parent_session_id: String,
    pub child_session_id: String,
    pub agent: String,
    pub profile_id: String,
    pub profile_revision: u64,
    pub profile_digest: String,
    pub executor_principal: String,
    pub owner_epoch: u64,
    pub location_id: String,
    pub workspace_id: String,
    pub workspace_revision: String,
    pub capability_digest: String,
    pub permissions_digest: String,
    pub budget_digest: String,
    pub scope_digest: String,
}

impl DirectAttemptIntent {
    /// Validates every field before any durable owner state can be allocated.
    pub fn validate(&self) -> Result<(), ManagedError> {
        id(&self.parent_session_id)?;
        id(&self.child_session_id)?;
        id(&self.agent)?;
        id(&self.profile_id)?;
        if self.profile_revision == 0 {
            return Err(ManagedError::Invalid(
                "direct Attempt AgentProfileV2 revision is invalid",
            ));
        }
        blake3_digest(&self.profile_digest)?;
        if self.executor_principal.is_empty()
            || self.executor_principal.len() > 256
            || self.executor_principal.contains('\0')
        {
            return Err(ManagedError::Invalid(
                "direct Attempt executor principal is invalid",
            ));
        }
        id(&self.location_id)?;
        id(&self.workspace_id)?;
        if self.owner_epoch == 0 {
            return Err(ManagedError::Invalid(
                "direct Attempt owner epoch is invalid",
            ));
        }
        blake3_digest(&self.workspace_revision)?;
        sha256_digest(&self.capability_digest)?;
        sha256_digest(&self.permissions_digest)?;
        sha256_digest(&self.budget_digest)?;
        sha256_digest(&self.scope_digest)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectAttemptRecord {
    pub intent: DirectAttemptIntent,
    pub phase: DirectAttemptPhase,
    pub effect_intents: Vec<DirectAttemptEffectIntent>,
    /// The live workspace head reconstructed exclusively from ordered successful
    /// effect receipts. The admission revision above remains immutable provenance.
    pub workspace_head_revision: String,
    /// One durable receipt per bound effect, replayed in the same order as intents.
    pub effect_receipts: Vec<DirectAttemptEffectReceiptV1>,
    /// Appended resolutions of uncertain receipts. Original UNKNOWN rows remain
    /// immutable evidence in `effect_receipts` and the OwnerLog.
    pub effect_reconciliations: Vec<DirectAttemptEffectReconciliationV1>,
    /// A terminal failed effect prevents further dispatch while allowing the caller
    /// to durably settle the overall Attempt as FAILED.
    pub effect_chain_failed: bool,
    /// Kernel-computed BLAKE3 receipt over the durable dispatch facts.
    pub receipt_digest: Option<String>,
    /// Core-computed `sha256:` digest of the typed child result (or failure) payload.
    pub result_digest: Option<String>,
    pub failure_code: Option<String>,
    pub retryable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectAttemptEffectIntent {
    pub effect_id: String,
    pub location_id: String,
    pub session_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectAttemptEffectOutcome {
    Succeeded,
    Failed,
    Unknown,
    /// HostKernel proved the exact bound intent was never dispatched.
    NotDispatched,
}

impl DirectAttemptEffectOutcome {
    fn name(self) -> &'static str {
        match self {
            Self::Succeeded => "SUCCEEDED",
            Self::Failed => "FAILED",
            Self::Unknown => "UNKNOWN",
            Self::NotDispatched => "NOT_DISPATCHED",
        }
    }
}

/// Durable HostKernel-authenticated observation for one exact bound direct
/// Attempt effect. The digest is the target receipt digest when one exists, or
/// a domain-separated HostKernel uncertainty observation when dispatch may have
/// occurred without a recoverable target receipt. Only `Succeeded` carries a
/// new workspace head; other outcomes fence the chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectAttemptEffectReceiptV1 {
    pub effect_id: String,
    pub observation_digest: String,
    pub outcome: DirectAttemptEffectOutcome,
    pub before_workspace_revision: String,
    pub after_workspace_revision: Option<String>,
}

/// Authenticated HostKernel reconciliation for the exact next effect after an
/// Attempt crossed an UNKNOWN boundary. The OwnerLog keeps the original UNKNOWN
/// observation and appends this resolution; reconciliation never resumes dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectAttemptEffectReconciliationV1 {
    pub effect_id: String,
    /// Exact digest of the persisted UNKNOWN observation, or `None` when recovery
    /// found an intent with no receipt at all.
    pub prior_unknown_digest: Option<String>,
    pub observation_digest: String,
    pub outcome: DirectAttemptEffectOutcome,
    pub before_workspace_revision: String,
    pub after_workspace_revision: Option<String>,
}

/// Opaque proof minted by HostKernel after it revokes the unleased suffix and
/// EffectHost durably confirms that every remaining effect is APPROVED/not dispatched.
/// Callers cannot construct this through the serialized managed-control protocol.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectAttemptCancellationProofV1 {
    attempt_id: String,
    owner_epoch: u64,
    expected_revision: u64,
    receipt_chain_digest: String,
    workspace_head_revision: String,
    successful_prefix_count: u32,
    remaining_effect_ids: Vec<String>,
    batch_id: String,
    session_id: String,
    location_id: String,
    delivery_id: String,
}

impl DirectAttemptCancellationProofV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_host_kernel(
        attempt_id: String,
        owner_epoch: u64,
        expected_revision: u64,
        receipt_chain_digest: String,
        workspace_head_revision: String,
        successful_prefix_count: u32,
        remaining_effect_ids: Vec<String>,
        batch_id: String,
        session_id: String,
        location_id: String,
        delivery_id: String,
    ) -> Self {
        Self {
            attempt_id,
            owner_epoch,
            expected_revision,
            receipt_chain_digest,
            workspace_head_revision,
            successful_prefix_count,
            remaining_effect_ids,
            batch_id,
            session_id,
            location_id,
            delivery_id,
        }
    }
}

/// Durable commands for one direct Attempt owner log. A log carries at most one
/// valid command sequence: admit, then exactly one terminal settlement or cancel.
#[derive(Clone, Debug)]
pub enum DirectAttemptCommand {
    Admit {
        intent: DirectAttemptIntent,
    },
    BindEffects(Vec<DirectAttemptEffectIntent>),
    RecordEffectReceipt(DirectAttemptEffectReceiptV1),
    ReconcileEffectReceipt(DirectAttemptEffectReconciliationV1),
    CancelWithProof(DirectAttemptCancellationProofV1),
    Succeed {
        result_digest: String,
        receipt_digest: String,
    },
    Fail {
        failure_code: String,
        retryable: bool,
        result_digest: String,
        receipt_digest: String,
    },
    MarkUnknown,
    Cancel,
}

/// BLAKE3 receipt over the durable direct-Attempt facts. Length-prefixed fields make
/// the digest unambiguous, and the same facts always reproduce the same receipt.
pub fn direct_attempt_receipt_digest(
    attempt_id: &str,
    outcome: &str,
    result_digest: &str,
    intent: &DirectAttemptIntent,
) -> String {
    let mut preimage = Vec::with_capacity(256);
    for field in [
        attempt_id,
        intent.parent_session_id.as_str(),
        intent.child_session_id.as_str(),
        intent.agent.as_str(),
        intent.profile_id.as_str(),
        &intent.profile_revision.to_string(),
        intent.profile_digest.as_str(),
        intent.executor_principal.as_str(),
        &intent.owner_epoch.to_string(),
        intent.location_id.as_str(),
        intent.workspace_id.as_str(),
        intent.workspace_revision.as_str(),
        intent.capability_digest.as_str(),
        intent.permissions_digest.as_str(),
        intent.budget_digest.as_str(),
        intent.scope_digest.as_str(),
        outcome,
        result_digest,
    ] {
        preimage.extend_from_slice(&(field.len() as u32).to_be_bytes());
        preimage.extend_from_slice(field.as_bytes());
    }
    format!("blake3:{}", blake3::hash(&preimage).to_hex())
}

/// Canonical digest over the exact ordered target receipt chain and current
/// workspace head. HostKernel includes this in terminal settlement receipts.
pub fn direct_attempt_effect_chain_digest(
    attempt_id: &str,
    record: &DirectAttemptRecord,
) -> Result<String, ManagedError> {
    id(attempt_id)?;
    blake3_digest(&record.workspace_head_revision)?;
    let mut preimage = Vec::with_capacity(128 + record.effect_receipts.len() * 256);
    for field in [attempt_id, record.workspace_head_revision.as_str()] {
        preimage.extend_from_slice(&(field.len() as u32).to_be_bytes());
        preimage.extend_from_slice(field.as_bytes());
    }
    for receipt in &record.effect_receipts {
        for field in [
            receipt.effect_id.as_str(),
            receipt.observation_digest.as_str(),
            receipt.outcome.name(),
            receipt.before_workspace_revision.as_str(),
            receipt.after_workspace_revision.as_deref().unwrap_or(""),
        ] {
            preimage.extend_from_slice(&(field.len() as u32).to_be_bytes());
            preimage.extend_from_slice(field.as_bytes());
        }
    }
    for resolution in &record.effect_reconciliations {
        for field in [
            resolution.effect_id.as_str(),
            resolution.prior_unknown_digest.as_deref().unwrap_or(""),
            resolution.observation_digest.as_str(),
            resolution.outcome.name(),
            resolution.before_workspace_revision.as_str(),
            resolution.after_workspace_revision.as_deref().unwrap_or(""),
        ] {
            preimage.extend_from_slice(&(field.len() as u32).to_be_bytes());
            preimage.extend_from_slice(field.as_bytes());
        }
    }
    Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
}

fn direct_attempt_event(command: &DirectAttemptCommand) -> (&'static str, Value) {
    match command {
        DirectAttemptCommand::Admit { intent } => (
            "direct_attempt_admitted",
            json!({
                "parentSessionId": intent.parent_session_id,
                "childSessionId": intent.child_session_id,
                "agent": intent.agent,
                "profileId": intent.profile_id,
                "profileRevision": intent.profile_revision,
                "profileDigest": intent.profile_digest,
                "executorPrincipal": intent.executor_principal,
                "ownerEpoch": intent.owner_epoch,
                "locationId": intent.location_id,
                "workspaceId": intent.workspace_id,
                "workspaceRevision": intent.workspace_revision,
                "capabilityDigest": intent.capability_digest,
                "permissionsDigest": intent.permissions_digest,
                "budgetDigest": intent.budget_digest,
                "scopeDigest": intent.scope_digest,
            }),
        ),
        DirectAttemptCommand::BindEffects(intents) => (
            "direct_attempt_effect_intents",
            json!({
                "effects": intents.iter().map(|intent| json!({
                    "effectId": intent.effect_id,
                    "locationId": intent.location_id,
                    "sessionId": intent.session_id,
                })).collect::<Vec<_>>(),
            }),
        ),
        DirectAttemptCommand::RecordEffectReceipt(receipt) => (
            "direct_attempt_effect_receipt",
            json!({
                "effectId": receipt.effect_id,
                "observationDigest": receipt.observation_digest,
                "outcome": receipt.outcome.name(),
                "beforeWorkspaceRevision": receipt.before_workspace_revision,
                "afterWorkspaceRevision": receipt.after_workspace_revision,
            }),
        ),
        DirectAttemptCommand::ReconcileEffectReceipt(receipt) => (
            "direct_attempt_effect_reconciled",
            json!({
                "effectId": receipt.effect_id,
                "priorUnknownDigest": receipt.prior_unknown_digest,
                "observationDigest": receipt.observation_digest,
                "outcome": receipt.outcome.name(),
                "beforeWorkspaceRevision": receipt.before_workspace_revision,
                "afterWorkspaceRevision": receipt.after_workspace_revision,
            }),
        ),
        DirectAttemptCommand::CancelWithProof(proof) => (
            "direct_attempt_cancelled_with_proof",
            json!({
                "attemptId": proof.attempt_id,
                "ownerEpoch": proof.owner_epoch,
                "expectedRevision": proof.expected_revision,
                "receiptChainDigest": proof.receipt_chain_digest,
                "workspaceHeadRevision": proof.workspace_head_revision,
                "successfulPrefixCount": proof.successful_prefix_count,
                "remainingEffectIds": proof.remaining_effect_ids,
                "batchId": proof.batch_id,
                "sessionId": proof.session_id,
                "locationId": proof.location_id,
                "deliveryId": proof.delivery_id,
            }),
        ),
        DirectAttemptCommand::Succeed {
            result_digest,
            receipt_digest,
        } => (
            "direct_attempt_succeeded",
            json!({"resultDigest": result_digest, "receiptDigest": receipt_digest}),
        ),
        DirectAttemptCommand::Fail {
            failure_code,
            retryable,
            result_digest,
            receipt_digest,
        } => (
            "direct_attempt_failed",
            json!({
                "failureCode": failure_code,
                "retryable": retryable,
                "resultDigest": result_digest,
                "receiptDigest": receipt_digest,
            }),
        ),
        DirectAttemptCommand::MarkUnknown => ("direct_attempt_unknown", json!({})),
        DirectAttemptCommand::Cancel => ("direct_attempt_cancelled", json!({})),
    }
}

fn decode_direct_attempt_command(
    kind: &str,
    payload: &Value,
) -> Result<DirectAttemptCommand, ManagedError> {
    let count = payload
        .as_object()
        .ok_or(ManagedError::Invalid(
            "direct Attempt event payload must be object",
        ))?
        .len();
    let command = match kind {
        "direct_attempt_admitted" if count == 15 => DirectAttemptCommand::Admit {
            intent: DirectAttemptIntent {
                parent_session_id: required_string(payload, "parentSessionId")?,
                child_session_id: required_string(payload, "childSessionId")?,
                agent: required_string(payload, "agent")?,
                profile_id: required_string(payload, "profileId")?,
                profile_revision: payload
                    .get("profileRevision")
                    .and_then(Value::as_u64)
                    .filter(|revision| *revision > 0)
                    .ok_or(ManagedError::Invalid("direct Attempt AgentProfileV2 revision is invalid"))?,
                profile_digest: required_string(payload, "profileDigest")?,
                executor_principal: required_string(payload, "executorPrincipal")?,
                owner_epoch: payload.get("ownerEpoch").and_then(Value::as_u64).ok_or(
                    ManagedError::Invalid("direct Attempt owner epoch is invalid"),
                )?,
                location_id: required_string(payload, "locationId")?,
                workspace_id: required_string(payload, "workspaceId")?,
                workspace_revision: required_string(payload, "workspaceRevision")?,
                capability_digest: required_string(payload, "capabilityDigest")?,
                permissions_digest: required_string(payload, "permissionsDigest")?,
                budget_digest: required_string(payload, "budgetDigest")?,
                scope_digest: required_string(payload, "scopeDigest")?,
            },
        },
        "direct_attempt_effect_intent" if count == 3 => {
            DirectAttemptCommand::BindEffects(vec![DirectAttemptEffectIntent {
                effect_id: required_string(payload, "effectId")?,
                location_id: required_string(payload, "locationId")?,
                session_id: required_string(payload, "sessionId")?,
            }])
        }
        "direct_attempt_effect_intents" if count == 1 => {
            let effects = payload
                .get("effects")
                .and_then(Value::as_array)
                .ok_or(ManagedError::Invalid("direct Attempt effects are invalid"))?;
            if effects.is_empty() || effects.len() > MAX_DIRECT_ATTEMPT_EFFECTS {
                return Err(ManagedError::Invalid(
                    "direct Attempt effect count is invalid",
                ));
            }
            let mut intents = Vec::with_capacity(effects.len());
            for effect in effects {
                intents.push(DirectAttemptEffectIntent {
                    effect_id: required_string(effect, "effectId")?,
                    location_id: required_string(effect, "locationId")?,
                    session_id: required_string(effect, "sessionId")?,
                });
            }
            DirectAttemptCommand::BindEffects(intents)
        }
        "direct_attempt_effect_receipt" if count == 5 => {
            let outcome = match required_string(payload, "outcome")?.as_str() {
                "SUCCEEDED" => DirectAttemptEffectOutcome::Succeeded,
                "FAILED" => DirectAttemptEffectOutcome::Failed,
                "UNKNOWN" => DirectAttemptEffectOutcome::Unknown,
                "NOT_DISPATCHED" => DirectAttemptEffectOutcome::NotDispatched,
                _ => return Err(ManagedError::Invalid("direct Attempt effect outcome is invalid")),
            };
            DirectAttemptCommand::RecordEffectReceipt(DirectAttemptEffectReceiptV1 {
                effect_id: required_string(payload, "effectId")?,
                observation_digest: required_string(payload, "observationDigest")?,
                outcome,
                before_workspace_revision: required_string(payload, "beforeWorkspaceRevision")?,
                after_workspace_revision: optional_string(payload, "afterWorkspaceRevision")?,
            })
        }
        "direct_attempt_effect_reconciled" if count == 6 => {
            let outcome = match required_string(payload, "outcome")?.as_str() {
                "SUCCEEDED" => DirectAttemptEffectOutcome::Succeeded,
                "FAILED" => DirectAttemptEffectOutcome::Failed,
                "NOT_DISPATCHED" => DirectAttemptEffectOutcome::NotDispatched,
                _ => return Err(ManagedError::Invalid("reconciled direct Attempt outcome is invalid")),
            };
            DirectAttemptCommand::ReconcileEffectReceipt(DirectAttemptEffectReconciliationV1 {
                effect_id: required_string(payload, "effectId")?,
                prior_unknown_digest: optional_string(payload, "priorUnknownDigest")?,
                observation_digest: required_string(payload, "observationDigest")?,
                outcome,
                before_workspace_revision: required_string(payload, "beforeWorkspaceRevision")?,
                after_workspace_revision: optional_string(payload, "afterWorkspaceRevision")?,
            })
        }
        "direct_attempt_cancelled_with_proof" if count == 11 => {
            let remaining = payload.get("remainingEffectIds").and_then(Value::as_array)
                .ok_or(ManagedError::Invalid("direct Attempt cancellation suffix is invalid"))?;
            let remaining_effect_ids = remaining.iter().map(|value| {
                value.as_str().map(str::to_owned).ok_or(ManagedError::Invalid(
                    "direct Attempt cancellation effect ID is invalid",
                ))
            }).collect::<Result<Vec<_>, _>>()?;
            DirectAttemptCommand::CancelWithProof(DirectAttemptCancellationProofV1 {
                attempt_id: required_string(payload, "attemptId")?,
                owner_epoch: payload.get("ownerEpoch").and_then(Value::as_u64)
                    .ok_or(ManagedError::Invalid("direct Attempt cancellation epoch is invalid"))?,
                expected_revision: payload.get("expectedRevision").and_then(Value::as_u64)
                    .ok_or(ManagedError::Invalid("direct Attempt cancellation revision is invalid"))?,
                receipt_chain_digest: required_string(payload, "receiptChainDigest")?,
                workspace_head_revision: required_string(payload, "workspaceHeadRevision")?,
                successful_prefix_count: payload.get("successfulPrefixCount").and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or(ManagedError::Invalid("direct Attempt cancellation prefix is invalid"))?,
                remaining_effect_ids,
                batch_id: required_string(payload, "batchId")?,
                session_id: required_string(payload, "sessionId")?,
                location_id: required_string(payload, "locationId")?,
                delivery_id: required_string(payload, "deliveryId")?,
            })
        }
        "direct_attempt_succeeded" if count == 2 => DirectAttemptCommand::Succeed {
            result_digest: required_string(payload, "resultDigest")?,
            receipt_digest: required_string(payload, "receiptDigest")?,
        },
        "direct_attempt_failed" if count == 4 => DirectAttemptCommand::Fail {
            failure_code: required_string(payload, "failureCode")?,
            retryable: payload.get("retryable").and_then(Value::as_bool).ok_or(
                ManagedError::Invalid("direct Attempt retry class is invalid"),
            )?,
            result_digest: required_string(payload, "resultDigest")?,
            receipt_digest: required_string(payload, "receiptDigest")?,
        },
        "direct_attempt_unknown" if count == 0 => DirectAttemptCommand::MarkUnknown,
        "direct_attempt_cancelled" if count == 0 => DirectAttemptCommand::Cancel,
        _ => return Err(ManagedError::Invalid("unknown direct Attempt event kind")),
    };
    Ok(command)
}

impl DirectAttemptRecord {
    fn admitted(intent: &DirectAttemptIntent) -> Result<Self, ManagedError> {
        intent.validate()?;
        Ok(Self {
            intent: intent.clone(),
            phase: DirectAttemptPhase::Executing,
            effect_intents: Vec::new(),
            workspace_head_revision: intent.workspace_revision.clone(),
            effect_receipts: Vec::new(),
            effect_reconciliations: Vec::new(),
            effect_chain_failed: false,
            receipt_digest: None,
            result_digest: None,
            failure_code: None,
            retryable: None,
        })
    }

    fn reconciliation_for(&self, effect_id: &str) -> Option<&DirectAttemptEffectReconciliationV1> {
        self.effect_reconciliations.iter().find(|item| item.effect_id == effect_id)
    }

    fn all_effects_succeeded(&self) -> bool {
        self.effect_intents.iter().all(|intent| {
            self.reconciliation_for(&intent.effect_id)
                .map(|item| item.outcome == DirectAttemptEffectOutcome::Succeeded)
                .or_else(|| self.effect_receipts.iter().find(|item| item.effect_id == intent.effect_id)
                    .map(|item| item.outcome == DirectAttemptEffectOutcome::Succeeded))
                .unwrap_or(false)
        })
    }

    fn all_effects_cancel_safe(&self) -> bool {
        self.effect_intents.iter().all(|intent| {
            self.reconciliation_for(&intent.effect_id)
                .map(|item| matches!(item.outcome, DirectAttemptEffectOutcome::Succeeded | DirectAttemptEffectOutcome::NotDispatched))
                .or_else(|| self.effect_receipts.iter().find(|item| item.effect_id == intent.effect_id)
                    .map(|item| item.outcome == DirectAttemptEffectOutcome::Succeeded))
                .unwrap_or(false)
        })
    }

    fn all_effects_classified(&self) -> bool {
        self.effect_intents.iter().all(|intent| {
            self.reconciliation_for(&intent.effect_id).is_some()
                || self.effect_receipts.iter().any(|item| {
                    item.effect_id == intent.effect_id && item.outcome != DirectAttemptEffectOutcome::Unknown
                })
        })
    }

    fn next_unresolved_effect(&self) -> Option<&DirectAttemptEffectIntent> {
        self.effect_intents.iter().find(|intent| {
            self.reconciliation_for(&intent.effect_id).is_none()
                && !self.effect_receipts.iter().any(|item| {
                    item.effect_id == intent.effect_id && item.outcome != DirectAttemptEffectOutcome::Unknown
                })
        })
    }

    fn validate_cancellation_proof(
        &self,
        attempt_id: &str,
        expected_revision: u64,
        delivery_id: &str,
        proof: &DirectAttemptCancellationProofV1,
    ) -> Result<(), ManagedError> {
        id(&proof.attempt_id)?;
        id(&proof.batch_id)?;
        id(&proof.session_id)?;
        id(&proof.location_id)?;
        id(&proof.delivery_id)?;
        blake3_digest(&proof.receipt_chain_digest)?;
        blake3_digest(&proof.workspace_head_revision)?;
        let prefix = proof.successful_prefix_count as usize;
        if self.phase != DirectAttemptPhase::Executing
            || self.effect_chain_failed
            || proof.attempt_id != attempt_id
            || proof.owner_epoch != self.intent.owner_epoch
            || proof.expected_revision != expected_revision
            || proof.delivery_id != delivery_id
            || proof.receipt_chain_digest != direct_attempt_effect_chain_digest(attempt_id, self)?
            || proof.workspace_head_revision != self.workspace_head_revision
            || proof.session_id != self.intent.child_session_id
            || proof.location_id != self.intent.location_id
            || prefix >= self.effect_intents.len()
            || self.effect_receipts.len() != prefix
            || !self.effect_reconciliations.is_empty()
            || self.effect_receipts.iter().enumerate().any(|(index, receipt)| {
                receipt.effect_id != self.effect_intents[index].effect_id
                    || receipt.outcome != DirectAttemptEffectOutcome::Succeeded
            })
            || proof.remaining_effect_ids.len() != self.effect_intents.len() - prefix
            || proof.remaining_effect_ids.iter().zip(&self.effect_intents[prefix..])
                .any(|(provided, expected)| provided != &expected.effect_id)
        {
            return Err(ManagedError::Conflict("direct Attempt cancellation proof is stale or mismatched"));
        }
        for effect_id in &proof.remaining_effect_ids {
            id(effect_id)?;
        }
        Ok(())
    }

    fn apply(&mut self, command: &DirectAttemptCommand) -> Result<(), ManagedError> {
        match command {
            DirectAttemptCommand::Admit { .. } => {
                return Err(ManagedError::Conflict("direct Attempt is already admitted"));
            }
            DirectAttemptCommand::BindEffects(intents) => {
                if self.phase != DirectAttemptPhase::Executing
                    || self.effect_chain_failed
                    || intents.is_empty()
                    || intents.len() > MAX_DIRECT_ATTEMPT_EFFECTS
                {
                    return Err(ManagedError::Conflict(
                        "direct Attempt effect intent batch is stale or invalid",
                    ));
                }
                let mut seen = BTreeSet::new();
                for intent in intents {
                    id(&intent.effect_id)?;
                    id(&intent.location_id)?;
                    id(&intent.session_id)?;
                    if intent.location_id != self.intent.location_id
                        || intent.session_id != self.intent.child_session_id
                        || !seen.insert(intent.effect_id.as_str())
                        || self
                            .effect_intents
                            .iter()
                            .any(|bound| bound.effect_id == intent.effect_id)
                    {
                        return Err(ManagedError::Conflict(
                            "direct Attempt effect intent batch conflicts with existing binding",
                        ));
                    }
                }
                self.effect_intents.extend(intents.iter().cloned());
                return Ok(());
            }
            DirectAttemptCommand::RecordEffectReceipt(receipt) => {
                if self.phase != DirectAttemptPhase::Executing
                    || self.effect_chain_failed
                    || receipt.before_workspace_revision != self.workspace_head_revision
                {
                    return Err(ManagedError::Conflict(
                        "direct Attempt effect receipt is stale or fenced",
                    ));
                }
                id(&receipt.effect_id)?;
                blake3_digest(&receipt.observation_digest)?;
                blake3_digest(&receipt.before_workspace_revision)?;
                let next_effect = self
                    .effect_intents
                    .get(self.effect_receipts.len())
                    .ok_or(ManagedError::Conflict(
                        "direct Attempt effect receipt has no pending bound intent",
                    ))?;
                if next_effect.effect_id != receipt.effect_id
                    || self.effect_receipts.iter().any(|existing| existing.effect_id == receipt.effect_id)
                {
                    return Err(ManagedError::Conflict(
                        "direct Attempt effect receipt is duplicated or out of order",
                    ));
                }
                match (receipt.outcome, receipt.after_workspace_revision.as_deref()) {
                    (DirectAttemptEffectOutcome::Succeeded, Some(after)) => {
                        blake3_digest(after)?;
                        if after == receipt.before_workspace_revision {
                            return Err(ManagedError::Conflict(
                                "successful direct Attempt effect did not advance workspace head",
                            ));
                        }
                        self.workspace_head_revision = after.to_owned();
                    }
                    (DirectAttemptEffectOutcome::Failed, None) => {
                        self.effect_chain_failed = true;
                    }
                    (DirectAttemptEffectOutcome::Unknown, None) => {
                        self.phase = DirectAttemptPhase::Unknown;
                    }
                    _ => return Err(ManagedError::Invalid(
                        "direct Attempt effect receipt workspace head is invalid",
                    )),
                }
                self.effect_receipts.push(receipt.clone());
                return Ok(());
            }
            DirectAttemptCommand::ReconcileEffectReceipt(receipt) => {
                if self.phase != DirectAttemptPhase::Unknown {
                    return Err(ManagedError::Conflict("direct Attempt is not UNKNOWN"));
                }
                id(&receipt.effect_id)?;
                blake3_digest(&receipt.observation_digest)?;
                blake3_digest(&receipt.before_workspace_revision)?;
                let next = self.next_unresolved_effect().ok_or(ManagedError::Conflict(
                    "direct Attempt effect chain is already classified",
                ))?;
                if next.effect_id != receipt.effect_id || receipt.before_workspace_revision != self.workspace_head_revision {
                    return Err(ManagedError::Conflict("direct Attempt reconciliation is stale or out of order"));
                }
                if self.reconciliation_for(&receipt.effect_id).is_some() {
                    return Err(ManagedError::Conflict("direct Attempt effect was already reconciled"));
                }
                let previous_unknown = self.effect_receipts.iter().find(|item| {
                    item.effect_id == receipt.effect_id && item.outcome == DirectAttemptEffectOutcome::Unknown
                });
                match (previous_unknown, receipt.prior_unknown_digest.as_deref()) {
                    (Some(previous), Some(digest)) if previous.observation_digest == digest => {}
                    (None, None) => {}
                    _ => return Err(ManagedError::Conflict("direct Attempt UNKNOWN observation does not match")),
                }
                match (receipt.outcome, receipt.after_workspace_revision.as_deref()) {
                    (DirectAttemptEffectOutcome::Succeeded, Some(after)) => {
                        blake3_digest(after)?;
                        if after == receipt.before_workspace_revision {
                            return Err(ManagedError::Conflict("reconciled successful effect did not advance workspace head"));
                        }
                        self.workspace_head_revision = after.to_owned();
                    }
                    (DirectAttemptEffectOutcome::Failed, None) => self.effect_chain_failed = true,
                    (DirectAttemptEffectOutcome::NotDispatched, None) => {}
                    _ => return Err(ManagedError::Invalid("direct Attempt reconciliation workspace head is invalid")),
                }
                self.effect_reconciliations.push(receipt.clone());
                return Ok(());
            }
            DirectAttemptCommand::Succeed {
                result_digest,
                receipt_digest,
            } => {
                sha256_digest(result_digest)?;
                blake3_digest(receipt_digest)?;
                if !matches!(self.phase, DirectAttemptPhase::Executing | DirectAttemptPhase::Unknown)
                    || self.effect_chain_failed
                    || !self.all_effects_succeeded()
                {
                    return Err(ManagedError::Conflict("direct Attempt is not executing"));
                }
                self.phase = DirectAttemptPhase::Succeeded;
                self.result_digest = Some(result_digest.clone());
                self.receipt_digest = Some(receipt_digest.clone());
            }
            DirectAttemptCommand::Fail {
                failure_code,
                retryable,
                result_digest,
                receipt_digest,
            } => {
                id(failure_code)?;
                sha256_digest(result_digest)?;
                blake3_digest(receipt_digest)?;
                if !matches!(self.phase, DirectAttemptPhase::Executing | DirectAttemptPhase::Unknown)
                    || (self.phase == DirectAttemptPhase::Unknown && !self.all_effects_classified())
                    || self.effect_receipts.iter().any(|receipt| receipt.outcome == DirectAttemptEffectOutcome::Unknown
                        && self.reconciliation_for(&receipt.effect_id).is_none())
                {
                    return Err(ManagedError::Conflict("direct Attempt is not executing"));
                }
                self.phase = DirectAttemptPhase::Failed;
                self.failure_code = Some(failure_code.clone());
                self.retryable = Some(*retryable);
                self.result_digest = Some(result_digest.clone());
                self.receipt_digest = Some(receipt_digest.clone());
            }
            DirectAttemptCommand::MarkUnknown => {
                if self.phase != DirectAttemptPhase::Executing {
                    return Err(ManagedError::Conflict("direct Attempt is not executing"));
                }
                self.phase = DirectAttemptPhase::Unknown;
            }
            DirectAttemptCommand::Cancel => {
                if !matches!(self.phase, DirectAttemptPhase::Executing | DirectAttemptPhase::Unknown) {
                    return Err(ManagedError::Conflict("direct Attempt is not cancellable"));
                }
                let can_cancel = if self.phase == DirectAttemptPhase::Unknown {
                    self.all_effects_classified() && self.all_effects_cancel_safe()
                } else {
                    self.all_effects_succeeded()
                };
                if self.effect_chain_failed || !can_cancel {
                    return Err(ManagedError::Conflict(
                        "direct Attempt has an unsettled or failed effect chain",
                    ));
                }
                self.phase = DirectAttemptPhase::Cancelled;
            }
            DirectAttemptCommand::CancelWithProof(_) => {
                if self.phase != DirectAttemptPhase::Executing {
                    return Err(ManagedError::Conflict("direct Attempt is not cancellable"));
                }
                self.phase = DirectAttemptPhase::Cancelled;
            }
        }
        Ok(())
    }
}

/// One durable direct subagent Attempt. The owner log is exclusive (one live kernel
/// may own it) and every command compares the caller's revision, so no second writer
/// can admit, settle or cancel the same Attempt concurrently.
pub struct DirectAttemptControl {
    attempt_id: String,
    log: OwnerLogV2,
    record: Option<DirectAttemptRecord>,
    revision: u64,
    cursor: Option<CursorV1>,
    deliveries: BTreeMap<String, String>,
}

impl DirectAttemptControl {
    /// Durable-existence probe used for one-use Attempt ids. Allocation happens only
    /// in `create`, after every request field has been validated.
    pub fn exists(root: &Path, attempt_id: &str) -> bool {
        id(attempt_id).is_ok() && owner_head_exists(root, "direct_attempt", attempt_id)
    }

    /// Allocates one fresh Attempt owner log. An Attempt id that already has durable
    /// state is a typed conflict: Attempt ids are one-use, and a lost response is
    /// answered by the caller's exact delivery-key replay instead.
    pub fn create(root: &Path, attempt_id: &str) -> Result<Self, ManagedError> {
        id(attempt_id)?;
        if Self::exists(root, attempt_id) {
            return Err(ManagedError::Conflict("direct Attempt ID already used"));
        }
        Self::open(root, attempt_id)
    }

    /// Opens one already-created direct Attempt without allocating durable state for
    /// an unknown id.
    pub fn open_existing(root: &Path, attempt_id: &str) -> Result<Self, ManagedError> {
        id(attempt_id)?;
        if !Self::exists(root, attempt_id) {
            return Err(ManagedError::NotFound("direct Attempt is unknown"));
        }
        Self::open(root, attempt_id)
    }

    fn open(root: &Path, attempt_id: &str) -> Result<Self, ManagedError> {
        let owner = OwnerIdentity::new("direct_attempt".to_owned(), attempt_id.to_owned())?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)?;
        let mut record: Option<DirectAttemptRecord> = None;
        let mut revision = 0_u64;
        let mut deliveries = BTreeMap::new();
        let mut cursor: Option<CursorV1> = None;
        loop {
            let batch = log.read_after(cursor.as_ref(), NonZeroUsize::new(128).unwrap())?;
            for event in &batch.events {
                let envelope = event
                    .data
                    .as_object()
                    .ok_or(ManagedError::Invalid("invalid direct Attempt envelope"))?;
                let version = envelope.get("schemaVersion").and_then(Value::as_u64);
                if version != Some(1) {
                    return Err(ManagedError::Invalid(
                        "unknown direct Attempt schema version",
                    ));
                }
                let payload = envelope
                    .get("payload")
                    .ok_or(ManagedError::Invalid("missing direct Attempt payload"))?;
                let delivery = envelope
                    .get("deliveryId")
                    .and_then(Value::as_str)
                    .ok_or(ManagedError::Invalid("missing direct Attempt delivery"))?;
                let command_digest = envelope
                    .get("commandDigest")
                    .and_then(Value::as_str)
                    .ok_or(ManagedError::Invalid(
                        "missing direct Attempt command digest",
                    ))?;
                if deliveries.contains_key(delivery) {
                    return Err(ManagedError::Invalid("duplicate direct Attempt delivery"));
                }
                let command = decode_direct_attempt_command(&event.kind, payload)?;
                if let DirectAttemptCommand::CancelWithProof(proof) = &command {
                    let record = record.as_ref().ok_or(ManagedError::Invalid(
                        "direct Attempt cancellation preceded admission",
                    ))?;
                    record.validate_cancellation_proof(attempt_id, revision, delivery, proof)?;
                }
                match &mut record {
                    None => {
                        let DirectAttemptCommand::Admit { intent } = &command else {
                            return Err(ManagedError::Invalid(
                                "direct Attempt must be admitted first",
                            ));
                        };
                        record = Some(DirectAttemptRecord::admitted(intent)?);
                    }
                    Some(existing) => existing.apply(&command)?,
                }
                let logical = logical_command_digest(&event.kind, payload);
                if !command_digest.starts_with("blake3:") {
                    return Err(ManagedError::Invalid(
                        "invalid direct Attempt command digest",
                    ));
                }
                deliveries.insert(delivery.to_owned(), logical);
                revision = revision
                    .checked_add(1)
                    .ok_or(ManagedError::Invalid("direct Attempt revision overflow"))?;
            }
            cursor = batch.cursor;
            if !batch.has_more {
                break;
            }
        }
        let mut control = Self {
            attempt_id: attempt_id.to_owned(),
            log,
            record,
            revision,
            cursor,
            deliveries,
        };
        // A host epoch boundary cannot prove whether the dispatched child work
        // launched or obtained a receipt. Persist UNKNOWN before returning the
        // recovered owner: an in-memory phase change would be lost on the next
        // restart and could make the same ambiguous Attempt appear live again.
        if control
            .record
            .as_ref()
            .is_some_and(|record| record.phase == DirectAttemptPhase::Executing)
        {
            let delivery_id = format!("recovery_unknown_{attempt_id}");
            control.apply(
                control.revision,
                &delivery_id,
                DirectAttemptCommand::MarkUnknown,
            )?;
        }
        Ok(control)
    }

    pub fn record(&self) -> Option<&DirectAttemptRecord> {
        self.record.as_ref()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Current HostKernel-observed workspace chain head. This differs from the
    /// immutable admission revision after successful effect receipts.
    pub fn workspace_head_revision(&self) -> Option<&str> {
        self.record.as_ref().map(|record| record.workspace_head_revision.as_str())
    }

    /// Digest used to bind terminal outcome to the exact durable receipt chain.
    pub fn effect_chain_digest(&self, attempt_id: &str) -> Result<String, ManagedError> {
        let record = self.record.as_ref().ok_or(ManagedError::NotFound(
            "direct Attempt is not admitted",
        ))?;
        direct_attempt_effect_chain_digest(attempt_id, record)
    }

    /// Terminal phases can be evicted from the bounded live set and reopened from
    /// durable state without inventing an outcome; EXECUTING/UNKNOWN are retained.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.record.as_ref().map(|record| record.phase),
            Some(
                DirectAttemptPhase::Succeeded
                    | DirectAttemptPhase::Failed
                    | DirectAttemptPhase::Cancelled
            )
        )
    }

    /// One-use delivery-key classification; the exact replay may be retried after a
    /// lost response, while a reused key with a different command fails closed.
    pub fn is_replay(
        &self,
        delivery_id: &str,
        command: &DirectAttemptCommand,
    ) -> Result<bool, ManagedError> {
        let (kind, data) = direct_attempt_event(command);
        match self.deliveries.get(delivery_id) {
            None => Ok(false),
            Some(previous) if previous == &logical_command_digest(kind, &data) => Ok(true),
            Some(_) => Err(ManagedError::Conflict(
                "idempotency key reused for different command",
            )),
        }
    }

    pub fn apply(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        command: DirectAttemptCommand,
    ) -> Result<(), ManagedError> {
        id(delivery_id)?;
        let (kind, data) = direct_attempt_event(&command);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ManagedError::Invalid("system time invalid"))?
            .as_millis() as u64;
        let mut event = OwnerEventInput {
            schema_version: 1,
            time_ms: timestamp,
            kind: kind.to_owned(),
            data,
            delivery_id: None,
            command_digest: None,
        };
        let command_digest = OwnerLogV2::command_digest(delivery_id, &[event.clone()])?;
        let logical = logical_command_digest(kind, &event.data);
        if let Some(previous) = self.deliveries.get(delivery_id) {
            return if previous == &logical {
                Ok(())
            } else {
                Err(ManagedError::Conflict(
                    "idempotency key reused for different command",
                ))
            };
        }
        if self.revision != expected_revision {
            return Err(ManagedError::Conflict("stale direct Attempt revision"));
        }
        if let DirectAttemptCommand::CancelWithProof(proof) = &command {
            self.record.as_ref().ok_or(ManagedError::Conflict(
                "direct Attempt must be admitted before cancellation",
            ))?.validate_cancellation_proof(&self.attempt_id, expected_revision, delivery_id, proof)?;
        }
        // Check before appending the durable event. Checking after OwnerLog append
        // could return an error while leaving a command on disk that this process
        // did not apply to its in-memory projection.
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or(ManagedError::Invalid("direct Attempt revision overflow"))?;
        let next = match self.record.clone() {
            None => {
                let DirectAttemptCommand::Admit { intent } = &command else {
                    return Err(ManagedError::Conflict(
                        "direct Attempt must be admitted first",
                    ));
                };
                // Constructing the admitted record is the application of the
                // admission command; `DirectAttemptRecord::apply` only handles the
                // commands that follow it.
                DirectAttemptRecord::admitted(intent)?
            }
            Some(mut record) => {
                record.apply(&command)?;
                record
            }
        };
        event.delivery_id = Some(delivery_id.to_owned());
        event.command_digest = Some(command_digest.clone());
        let receipt =
            self.log
                .append_batch(delivery_id, &command_digest, &[event], self.cursor.as_ref())?;
        self.deliveries.insert(delivery_id.to_owned(), logical);
        self.record = Some(next);
        self.revision = next_revision;
        self.cursor = Some(receipt.owner_cursor);
        Ok(())
    }
}

/// Durable admission counters for direct AgentProfileV2 children. The single
/// owner log serializes reservations across concurrent Task calls, while each
/// per-Attempt log remains the authority for that Attempt's effects and receipt.
/// UNKNOWN reservations stay active until explicit terminal reconciliation.
#[derive(Clone, Debug, PartialEq, Eq)]
struct DirectAttemptProfileReservationV1 {
    attempt_id: String,
    parent_session_id: String,
    child_session_id: String,
    executor_principal: String,
    profile_id: String,
    profile_revision: u64,
    profile_digest: String,
    max_total_children: u64,
    max_active_children: u64,
    max_parallel_children: u64,
    counts_total: bool,
    active: bool,
}

/// One durable owner protects all profile child reservations for this HostKernel
/// state root. Callers keep it open for the kernel lifetime so OwnerLog's lock is
/// the cross-request and cross-process admission mutex.
pub struct DirectAttemptProfileAdmissionControl {
    log: OwnerLogV2,
    reservations: BTreeMap<String, DirectAttemptProfileReservationV1>,
    revision: u64,
    cursor: Option<CursorV1>,
    deliveries: BTreeMap<String, String>,
}

impl DirectAttemptProfileAdmissionControl {
    pub fn open(root: &Path) -> Result<Self, ManagedError> {
        let owner = OwnerIdentity::new(
            "direct_attempt_profile_admissions".to_owned(),
            "global".to_owned(),
        )?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)?;
        let mut control = Self {
            log,
            reservations: BTreeMap::new(),
            revision: 0,
            cursor: None,
            deliveries: BTreeMap::new(),
        };
        control.replay()?;
        Ok(control)
    }

    fn replay(&mut self) -> Result<(), ManagedError> {
        loop {
            let batch = self
                .log
                .read_after(self.cursor.as_ref(), NonZeroUsize::new(128).unwrap())?;
            for event in &batch.events {
                let envelope = event.data.as_object().ok_or(ManagedError::Invalid(
                    "direct profile admission envelope is invalid",
                ))?;
                if envelope.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
                    return Err(ManagedError::Invalid(
                        "unknown direct profile admission schema version",
                    ));
                }
                let payload = envelope
                    .get("payload")
                    .ok_or(ManagedError::Invalid("direct profile admission payload missing"))?;
                let delivery = envelope
                    .get("deliveryId")
                    .and_then(Value::as_str)
                    .ok_or(ManagedError::Invalid("direct profile admission delivery missing"))?;
                let command_digest = envelope
                    .get("commandDigest")
                    .and_then(Value::as_str)
                    .ok_or(ManagedError::Invalid(
                        "direct profile admission command digest missing",
                    ))?;
                if self.deliveries.contains_key(delivery) || !command_digest.starts_with("blake3:") {
                    return Err(ManagedError::Invalid(
                        "direct profile admission delivery or digest is invalid",
                    ));
                }
                match event.kind.as_str() {
                    "direct_profile_child_reserved" => {
                        let reservation = decode_direct_profile_reservation(payload)?;
                        self.apply_reservation(reservation, true)?;
                    }
                    "direct_profile_child_released" => {
                        self.apply_terminal(required_string(payload, "attemptId")?, false)?;
                    }
                    "direct_profile_child_abandoned" => {
                        self.apply_terminal(required_string(payload, "attemptId")?, true)?;
                    }
                    _ => return Err(ManagedError::Invalid("unknown direct profile admission event")),
                }
                self.deliveries.insert(
                    delivery.to_owned(),
                    logical_command_digest(&event.kind, payload),
                );
                self.revision = self
                    .revision
                    .checked_add(1)
                    .ok_or(ManagedError::Invalid("direct profile admission revision overflow"))?;
            }
            self.cursor = batch.cursor;
            if !batch.has_more {
                break;
            }
        }
        Ok(())
    }

    /// Reserves profile child capacity before a DirectAttempt or child Session is
    /// created. A retry of the same exact pin is idempotent; reused Attempt IDs
    /// with changed authority fail closed.
    #[allow(clippy::too_many_arguments)]
    pub fn reserve(
        &mut self,
        attempt_id: &str,
        parent_session_id: &str,
        child_session_id: &str,
        executor_principal: &str,
        profile_id: &str,
        profile_revision: u64,
        profile_digest: &str,
        max_total_children: u64,
        max_active_children: u64,
        max_parallel_children: u64,
    ) -> Result<(), ManagedError> {
        let reservation = DirectAttemptProfileReservationV1 {
            attempt_id: attempt_id.to_owned(),
            parent_session_id: parent_session_id.to_owned(),
            child_session_id: child_session_id.to_owned(),
            executor_principal: executor_principal.to_owned(),
            profile_id: profile_id.to_owned(),
            profile_revision,
            profile_digest: profile_digest.to_owned(),
            max_total_children,
            max_active_children,
            max_parallel_children,
            counts_total: true,
            active: true,
        };
        validate_direct_profile_reservation(&reservation)?;
        if let Some(existing) = self.reservations.get(attempt_id) {
            let same_authority = existing.attempt_id == reservation.attempt_id
                && existing.parent_session_id == reservation.parent_session_id
                && existing.child_session_id == reservation.child_session_id
                && existing.executor_principal == reservation.executor_principal
                && existing.profile_id == reservation.profile_id
                && existing.profile_revision == reservation.profile_revision
                && existing.profile_digest == reservation.profile_digest
                && existing.max_total_children == reservation.max_total_children
                && existing.max_active_children == reservation.max_active_children
                && existing.max_parallel_children == reservation.max_parallel_children;
            if !same_authority {
                return Err(ManagedError::Conflict(
                    "direct profile reservation Attempt ID was reused with changed authority",
                ));
            }
            // Admission retries are idempotent only while the same durable
            // reservation is still live. Once terminal or proven uncreated,
            // the Attempt ID is consumed and must never authorize a new child.
            return if existing.active {
                Ok(())
            } else {
                Err(ManagedError::Conflict(
                    "direct profile reservation Attempt ID is already terminal",
                ))
            };
        }
        let matching = self.reservations.values().filter(|entry| {
            entry.counts_total
                && entry.parent_session_id == reservation.parent_session_id
                && entry.profile_id == reservation.profile_id
        });
        let total = matching.clone().filter(|entry| entry.counts_total).count() as u64;
        let active = matching.filter(|entry| entry.active).count() as u64;
        let active_limit = max_active_children.min(max_parallel_children);
        if total >= max_total_children || active >= active_limit {
            return Err(ManagedError::Conflict(
                "AgentProfileV2 child admission limit is exhausted",
            ));
        }
        self.append(
            &direct_profile_admission_delivery("reserve", attempt_id),
            "direct_profile_child_reserved",
            direct_profile_reservation_value(&reservation),
            Some(reservation),
            None,
        )
    }

    /// Releases one active slot after a durable terminal Attempt outcome. UNKNOWN
    /// is intentionally not terminal and must never call this method.
    pub fn release_terminal(&mut self, attempt_id: &str) -> Result<(), ManagedError> {
        self.finish(attempt_id, false)
    }

    /// Removes a reservation only when the caller has proved no Attempt log or
    /// child Session was created. It does not represent a terminal child result.
    pub fn abandon_uncreated(&mut self, attempt_id: &str) -> Result<(), ManagedError> {
        self.finish(attempt_id, true)
    }

    /// Returns the durable active reservations so HostKernel startup recovery can
    /// compare them with per-Attempt owner logs. A reservation with no admitted
    /// Attempt record may be abandoned only after the canonical host proves that
    /// no child Session could have been created; UNKNOWN and active records stay
    /// reserved.
    pub fn active_attempt_ids(&self) -> Vec<String> {
        self.reservations
            .values()
            .filter(|entry| entry.active)
            .map(|entry| entry.attempt_id.clone())
            .collect()
    }

    /// Checks that an active durable reservation is the exact authority tuple
    /// carried by a DirectAttempt record during HostKernel startup recovery.
    /// This deliberately returns only a match bit so callers cannot mutate or
    /// reinterpret the reservation's profile limits or authority fields.
    pub fn reservation_matches_attempt(
        &self,
        attempt_id: &str,
        parent_session_id: &str,
        child_session_id: &str,
        executor_principal: &str,
        profile_id: &str,
        profile_revision: u64,
        profile_digest: &str,
    ) -> Result<bool, ManagedError> {
        id(attempt_id)?;
        id(parent_session_id)?;
        id(child_session_id)?;
        principal(executor_principal)?;
        id(profile_id)?;
        blake3_digest(profile_digest)?;
        let Some(reservation) = self.reservations.get(attempt_id) else {
            return Ok(false);
        };
        Ok(reservation.active
            && reservation.parent_session_id == parent_session_id
            && reservation.child_session_id == child_session_id
            && reservation.executor_principal == executor_principal
            && reservation.profile_id == profile_id
            && reservation.profile_revision == profile_revision
            && reservation.profile_digest == profile_digest)
    }

    fn finish(&mut self, attempt_id: &str, abandoned: bool) -> Result<(), ManagedError> {
        id(attempt_id)?;
        let Some(existing) = self.reservations.get(attempt_id) else {
            return Err(ManagedError::NotFound("direct profile reservation is unknown"));
        };
        if !existing.active && (!abandoned || !existing.counts_total) {
            return Ok(());
        }
        let kind = if abandoned {
            "direct_profile_child_abandoned"
        } else {
            "direct_profile_child_released"
        };
        self.append(
            &direct_profile_admission_delivery(
                if abandoned { "abandon" } else { "release" },
                attempt_id,
            ),
            kind,
            json!({ "attemptId": attempt_id }),
            None,
            Some((attempt_id.to_owned(), abandoned)),
        )
    }

    fn apply_reservation(
        &mut self,
        reservation: DirectAttemptProfileReservationV1,
        enforce_limits: bool,
    ) -> Result<(), ManagedError> {
        validate_direct_profile_reservation(&reservation)?;
        if self.reservations.contains_key(&reservation.attempt_id) {
            return Err(ManagedError::Invalid("duplicate direct profile reservation"));
        }
        if enforce_limits {
            let total = self.reservations.values().filter(|entry| {
                entry.counts_total
                    && entry.parent_session_id == reservation.parent_session_id
                    && entry.profile_id == reservation.profile_id
            }).count() as u64;
            let active = self.reservations.values().filter(|entry| {
                entry.active
                    && entry.parent_session_id == reservation.parent_session_id
                    && entry.profile_id == reservation.profile_id
            }).count() as u64;
            if total >= reservation.max_total_children
                || active >= reservation.max_active_children.min(reservation.max_parallel_children)
            {
                return Err(ManagedError::Invalid("persisted direct profile admission exceeds its limits"));
            }
        }
        self.reservations.insert(reservation.attempt_id.clone(), reservation);
        Ok(())
    }

    fn apply_terminal(&mut self, attempt_id: String, abandoned: bool) -> Result<(), ManagedError> {
        let entry = self.reservations.get_mut(&attempt_id).ok_or(ManagedError::Invalid(
            "direct profile terminal event has no reservation",
        ))?;
        if abandoned {
            entry.counts_total = false;
        }
        entry.active = false;
        Ok(())
    }

    fn append(
        &mut self,
        delivery_id: &str,
        kind: &str,
        payload: Value,
        reservation: Option<DirectAttemptProfileReservationV1>,
        terminal: Option<(String, bool)>,
    ) -> Result<(), ManagedError> {
        id(delivery_id)?;
        let logical = logical_command_digest(kind, &payload);
        if let Some(previous) = self.deliveries.get(delivery_id) {
            return if previous == &logical {
                Ok(())
            } else {
                Err(ManagedError::Conflict("direct profile admission delivery was reused"))
            };
        }
        let next_revision = self.revision.checked_add(1)
            .ok_or(ManagedError::Invalid("direct profile admission revision overflow"))?;
        let mut event = OwnerEventInput {
            schema_version: 1,
            time_ms: SystemTime::now().duration_since(UNIX_EPOCH)
                .map_err(|_| ManagedError::Invalid("system time invalid"))?
                .as_millis() as u64,
            kind: kind.to_owned(),
            data: payload.clone(),
            delivery_id: None,
            command_digest: None,
        };
        let command_digest = OwnerLogV2::command_digest(delivery_id, &[event.clone()])?;
        event.delivery_id = Some(delivery_id.to_owned());
        event.command_digest = Some(command_digest.clone());
        let receipt = self.log.append_batch(
            delivery_id,
            &command_digest,
            &[event],
            self.cursor.as_ref(),
        )?;
        if let Some(reservation) = reservation {
            self.apply_reservation(reservation, false)?;
        }
        if let Some((attempt_id, abandoned)) = terminal {
            self.apply_terminal(attempt_id, abandoned)?;
        }
        self.deliveries.insert(delivery_id.to_owned(), logical);
        self.revision = next_revision;
        self.cursor = Some(receipt.owner_cursor);
        Ok(())
    }
}

fn direct_profile_reservation_value(reservation: &DirectAttemptProfileReservationV1) -> Value {
    json!({
        "attemptId": reservation.attempt_id,
        "parentSessionId": reservation.parent_session_id,
        "childSessionId": reservation.child_session_id,
        "executorPrincipal": reservation.executor_principal,
        "profileId": reservation.profile_id,
        "profileRevision": reservation.profile_revision,
        "profileDigest": reservation.profile_digest,
        "maxTotalChildren": reservation.max_total_children,
        "maxActiveChildren": reservation.max_active_children,
        "maxParallelChildren": reservation.max_parallel_children,
    })
}

fn direct_profile_admission_delivery(prefix: &str, attempt_id: &str) -> String {
    let digest = blake3::hash(attempt_id.as_bytes()).to_hex();
    format!("{prefix}.{}", &digest[..32])
}

fn decode_direct_profile_reservation(
    value: &Value,
) -> Result<DirectAttemptProfileReservationV1, ManagedError> {
    exact_object(value, 10)?;
    let reservation = DirectAttemptProfileReservationV1 {
        attempt_id: required_string(value, "attemptId")?,
        parent_session_id: required_string(value, "parentSessionId")?,
        child_session_id: required_string(value, "childSessionId")?,
        executor_principal: required_string(value, "executorPrincipal")?,
        profile_id: required_string(value, "profileId")?,
        profile_revision: value.get("profileRevision").and_then(Value::as_u64)
            .ok_or(ManagedError::Invalid("direct profile revision is invalid"))?,
        profile_digest: required_string(value, "profileDigest")?,
        max_total_children: value.get("maxTotalChildren").and_then(Value::as_u64)
            .ok_or(ManagedError::Invalid("direct total-child limit is invalid"))?,
        max_active_children: value.get("maxActiveChildren").and_then(Value::as_u64)
            .ok_or(ManagedError::Invalid("direct active-child limit is invalid"))?,
        max_parallel_children: value.get("maxParallelChildren").and_then(Value::as_u64)
            .ok_or(ManagedError::Invalid("direct parallel-child limit is invalid"))?,
        counts_total: true,
        active: true,
    };
    validate_direct_profile_reservation(&reservation)?;
    Ok(reservation)
}

fn validate_direct_profile_reservation(
    reservation: &DirectAttemptProfileReservationV1,
) -> Result<(), ManagedError> {
    id(&reservation.attempt_id)?;
    id(&reservation.parent_session_id)?;
    id(&reservation.child_session_id)?;
    principal(&reservation.executor_principal)?;
    id(&reservation.profile_id)?;
    if reservation.profile_revision == 0 {
        return Err(ManagedError::Invalid("direct profile revision is invalid"));
    }
    if reservation.max_total_children == 0
        || reservation.max_active_children == 0
        || reservation.max_parallel_children == 0
        || reservation.max_parallel_children > reservation.max_active_children
        || reservation.max_active_children > reservation.max_total_children
    {
        return Err(ManagedError::Invalid(
            "direct profile child limits are invalid",
        ));
    }
    blake3_digest(&reservation.profile_digest)
}

#[cfg(test)]
mod direct_attempt_profile_admission_tests {
    use super::*;

    fn reserve(control: &mut DirectAttemptProfileAdmissionControl, attempt_id: &str, child_id: &str) {
        control
            .reserve(
                attempt_id,
                "ses_parent",
                child_id,
                "server_auth:owner",
                "profile.specialist",
                4,
                &format!("blake3:{}", "a".repeat(64)),
                2,
                1,
                1,
            )
            .unwrap();
    }

    #[test]
    fn profile_child_admission_serializes_active_and_total_limits_across_reopen() {
        let directory = tempfile::tempdir().unwrap();
        {
            let mut control = DirectAttemptProfileAdmissionControl::open(directory.path()).unwrap();
            reserve(&mut control, "attempt_one", "ses_child_one");
            assert!(control
                .reserve(
                    "attempt_two",
                    "ses_parent",
                    "ses_child_two",
                    "server_auth:owner",
                    "profile.specialist",
                    4,
                    &format!("blake3:{}", "a".repeat(64)),
                    2,
                    1,
                    1,
                )
                .is_err());
            control.release_terminal("attempt_one").unwrap();
            assert!(control
                .reserve(
                    "attempt_one",
                    "ses_parent",
                    "ses_child_one",
                    "server_auth:owner",
                    "profile.specialist",
                    4,
                    &format!("blake3:{}", "a".repeat(64)),
                    2,
                    1,
                    1,
                )
                .is_err());
        }
        {
            let mut control = DirectAttemptProfileAdmissionControl::open(directory.path()).unwrap();
            reserve(&mut control, "attempt_two", "ses_child_two");
            control.release_terminal("attempt_two").unwrap();
        }
        let mut control = DirectAttemptProfileAdmissionControl::open(directory.path()).unwrap();
        assert!(control
            .reserve(
                "attempt_three",
                "ses_parent",
                "ses_child_three",
                "server_auth:owner",
                "profile.specialist",
                4,
                &format!("blake3:{}", "a".repeat(64)),
                2,
                1,
                1,
            )
            .is_err());
    }

    #[test]
    fn unknown_attempt_keeps_its_active_profile_reservation() {
        let directory = tempfile::tempdir().unwrap();
        let mut control = DirectAttemptProfileAdmissionControl::open(directory.path()).unwrap();
        reserve(&mut control, "attempt_unknown", "ses_child_one");
        // No release event is emitted for UNKNOWN. The next child remains denied.
        assert!(control
            .reserve(
                "attempt_next",
                "ses_parent",
                "ses_child_two",
                "server_auth:owner",
                "profile.specialist",
                4,
                &format!("blake3:{}", "a".repeat(64)),
                2,
                1,
                1,
            )
            .is_err());
    }

    #[test]
    fn reservation_recovery_matches_the_full_pinned_attempt_authority_tuple() {
        let directory = tempfile::tempdir().unwrap();
        let mut control = DirectAttemptProfileAdmissionControl::open(directory.path()).unwrap();
        reserve(&mut control, "attempt_recovery", "ses_child_one");
        let digest = format!("blake3:{}", "a".repeat(64));
        assert!(control.reservation_matches_attempt(
            "attempt_recovery", "ses_parent", "ses_child_one", "server_auth:owner",
            "profile.specialist", 4, &digest,
        ).unwrap());
        assert!(!control.reservation_matches_attempt(
            "attempt_recovery", "ses_parent", "ses_child_one", "server_auth:owner",
            "profile.specialist", 5, &digest,
        ).unwrap());
        assert!(!control.reservation_matches_attempt(
            "attempt_recovery", "ses_parent", "ses_child_two", "server_auth:owner",
            "profile.specialist", 4, &digest,
        ).unwrap());
    }

    #[test]
    fn abandoned_attempt_id_cannot_be_reused_to_create_a_child() {
        let directory = tempfile::tempdir().unwrap();
        let mut control = DirectAttemptProfileAdmissionControl::open(directory.path()).unwrap();
        reserve(&mut control, "attempt_abandoned", "ses_child_one");
        control.abandon_uncreated("attempt_abandoned").unwrap();
        assert!(control
            .reserve(
                "attempt_abandoned",
                "ses_parent",
                "ses_child_one",
                "server_auth:owner",
                "profile.specialist",
                4,
                &format!("blake3:{}", "a".repeat(64)),
                2,
                1,
                1,
            )
            .is_err());
    }
}
