//! OwnerLog-backed durable clone-apply-commit adapter for [`WorkerPool`].
//!
//! Mirrors the canonical managed-control pattern: one owner-private
//! [`OwnerLogV2`] stream, one logical command per delivery ID, an idempotent
//! exact retry and a fail-closed conflict on a reused delivery key. Commands
//! carry only control identifiers, digests and bounded settlement facts — never
//! transcripts, argv or secrets. The durable append wins before any process
//! spawn, and a crash between two commands is recovered conservatively
//! (`CLAIMED`/`RELEASE_PENDING` workers become `QUARANTINED`, queued tickets are
//! fenced, capacity stays held).
//!
//! This module consumes the P7-owned `owner_log` API read-only. HostKernel's
//! authenticated `managed.v1` ingress is the only production caller; it must
//! call [`WorkerPoolControl::apply`] only with facts derived from authenticated
//! managed state. Fan-out remains unavailable until P1/P2 end-to-end acceptance
//! proves the admission, Guard, claim, consume and recovery chain.

use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::owner_log::{
    DurabilityProfile, OwnerEventInput, OwnerIdentity, OwnerLogError, OwnerLogV2,
};
use crate::protocol::CursorV1;
use crate::resource_budget::{AuthenticatedOwnerContext, BudgetDimension, ReservationProof};
use crate::resource_sampler::ProcessIdentity;
use crate::worker_pool::{
    ApplyMode, BindingAttemptPhase, CancelScope, EnqueueRequest, FanOutState, OwnerScopeKey,
    ParentExecutionLineageV1, ReconciliationProof, VerifiedAttemptBinding, WorkerClass, WorkerPool,
    WorkerPoolConfig, WorkerPoolError, WorkerReuseKey, WorkerSettlement, WorkerSettlementOutcome,
    WorktreeBindingRequest, WorktreeSettlementFacts,
};
use crate::worktree_lifecycle::{
    GuardedWorktreeReceiptV1, GuardedWorktreeRequestV1, WorktreeLifecycleErrorV1,
    WorktreeObservedStatusV1, WorktreePreReleaseEvidenceV1, WorktreeOperationIntentV1, WorktreeOperationJournalV1,
    WorktreeOperationKindV1, WorktreeOperationStateV1, VerifiedWorktreeRegistrationV1, WorktreeRegistrationProvenanceV1,
    WorktreeRootOwnerV1,
};
use crate::worktree_pool::WorktreeRegistration;

const OWNER_KIND: &str = "worker_pool";
const EVENT_SCHEMA_VERSION: u16 = 1;
const MAX_BATCH_EVENTS: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerDurableError {
    Log(OwnerLogError),
    Pool(WorkerPoolError),
    Invalid(&'static str),
    Conflict(&'static str),
    ReplayConflict(&'static str),
    StaleRevision,
    NotFound(&'static str),
    /// A worktree intent has crossed the durable possible-dispatch fence. It
    /// must be reconciled from its exact receipt; it is never equivalent to
    /// an absent operation and must not trigger a replacement dispatch.
    WorktreeIntentUnknown,
    /// The durable HostKernel observation quarantined this operation.
    WorktreeIntentQuarantined,
    /// The operation has a committed terminal receipt. Call the exact receipt
    /// resolver; do not run the operation again.
    WorktreeIntentCompleted,
    /// The exact intent was retired with proof that it was never dispatched.
    WorktreeIntentRetired,
    /// The operation exists but is bound to a different or stale root owner.
    WorktreeIntentStale,
}

impl From<OwnerLogError> for WorkerDurableError {
    fn from(error: OwnerLogError) -> Self {
        Self::Log(error)
    }
}

impl From<WorkerPoolError> for WorkerDurableError {
    fn from(error: WorkerPoolError) -> Self {
        Self::Pool(error)
    }
}

/// Opening configuration. `owner_epoch` is the epoch this kernel incarnation
/// wants to use; a mismatch with the persisted epoch appends an explicit
/// `EpochAdvanced` fence command before any new work is admitted.
#[derive(Clone, Copy, Debug)]
pub struct WorkerPoolOpenConfig {
    pub owner_epoch: u64,
    pub max_live_workers: usize,
    pub max_queued_tickets: usize,
    pub max_worktrees: usize,
}

/// Immutable pre-admission pins minted only by HostKernel from its authenticated
/// owner, selected immutable profile/context and Guard-computed accepted ceiling.
/// No RPC decoder exists for this type; the private decoder below reads only the
/// authenticated, owner-private OwnerLog. Binding is attached in a second durable
/// step because managed admission itself creates DelegationBindingV1.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkerAdmissionPinsV1 {
    owner: OwnerScopeKey,
    goal_id: String,
    source_revision: String,
    accepted_spec_digest: String,
    location_id: String,
    process_incarnation: String,
    profile_id: String,
    profile_revision: u64,
    profile_digest: String,
    context_selection_digest: String,
    accepted_scope_digest: String,
    capability_ceiling_digest: String,
}

impl WorkerAdmissionPinsV1 {
    /// `profile_*`, context and capability digests must be projected by P1 from
    /// registered-profile/context/Guard proofs, never copied from request JSON.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_authenticated_host(
        owner: &AuthenticatedOwnerContext,
        binding: &VerifiedAttemptBinding,
        location_id: &str,
        process_incarnation: &str,
        profile_id: &str,
        profile_revision: u64,
        profile_digest: &str,
        context_selection_digest: &str,
        accepted_scope_digest: &str,
        capability_ceiling_digest: &str,
    ) -> Result<Self, WorkerDurableError> {
        if owner.run_id() != binding.run_id()
            || owner.task_id() != binding.task_id()
            || owner.attempt_id() != binding.attempt_id()
            || owner.owner_epoch() != binding.owner_epoch()
        {
            return Err(WorkerDurableError::Conflict("worker admission owner mismatch"));
        }
        let pins = Self {
            owner: OwnerScopeKey::from_owner(owner),
            goal_id: binding.goal_id().to_owned(),
            source_revision: binding.source_revision().to_owned(),
            accepted_spec_digest: binding.accepted_spec_digest().to_owned(),
            location_id: location_id.to_owned(),
            process_incarnation: process_incarnation.to_owned(),
            profile_id: profile_id.to_owned(),
            profile_revision,
            profile_digest: profile_digest.to_owned(),
            context_selection_digest: context_selection_digest.to_owned(),
            accepted_scope_digest: accepted_scope_digest.to_owned(),
            capability_ceiling_digest: capability_ceiling_digest.to_owned(),
        };
        pins.validate()?;
        Ok(pins)
    }

    fn validate(&self) -> Result<(), WorkerDurableError> {
        rehydrate(&self.owner)?;
        for value in [&self.goal_id, &self.source_revision, &self.location_id,
            &self.process_incarnation, &self.profile_id] {
            validate_owner_token(value)?;
        }
        for value in [&self.accepted_spec_digest, &self.profile_digest,
            &self.context_selection_digest, &self.accepted_scope_digest] {
            validate_owner_digest(value, "blake3:")?;
        }
        validate_owner_digest(&self.capability_ceiling_digest, "sha256:")?;
        if self.profile_revision == 0 {
            return Err(WorkerDurableError::Invalid("profile revision is zero"));
        }
        Ok(())
    }
}

/// Typed parent lineage supplied only from a live P8 OwnerLog proof. Possessing
/// the enum does not authorize dispatch; `WorkerPoolControl` re-resolves its
/// embedded proof against the current cursor before accepting a reservation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ManagedParentProofV1 {
    RootCoordinator(RootCoordinatorExecutionProofV1),
    ClaimedWorker(DurableParentExecutionProofV1),
}

/// Parent/root Session lineage is distinct from the admitted child's Session.
/// Nested child reconciliation remains unavailable until its durable proof
/// carries the original Run root identity through the parent chain.
fn managed_root_session_id(
    proof: &ManagedParentProofV1,
) -> Result<&str, WorkerDurableError> {
    match proof {
        ManagedParentProofV1::RootCoordinator(root) => Ok(root.session_id()),
        ManagedParentProofV1::ClaimedWorker(_) => Err(WorkerDurableError::Conflict(
            "nested managed child lacks an authenticated root Session lineage proof",
        )),
    }
}

/// Authenticated projection of the existing Core Session/Run process used as
/// the logical root coordinator. It has no managed Task/Attempt identity and
/// does not create or account for another OS process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RootCoordinatorRegistrationPinsV1 {
    goal_id: String,
    run_id: String,
    principal_ref: String,
    workspace_binding: String,
    session_id: String,
    location_id: String,
    owner_epoch: u64,
    process_incarnation: String,
    process_identity: ProcessIdentity,
    source_revision: String,
    accepted_spec_digest: String,
    pins_digest: String,
}

impl RootCoordinatorRegistrationPinsV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_authenticated_core_peer(
        goal_id: String,
        run_id: String,
        principal_ref: String,
        workspace_binding: String,
        session_id: String,
        location_id: String,
        owner_epoch: u64,
        process_incarnation: String,
        process_identity: ProcessIdentity,
        source_revision: String,
        accepted_spec_digest: String,
    ) -> Result<Self, WorkerDurableError> {
        let mut pins = Self { goal_id, run_id, principal_ref, workspace_binding, session_id,
            location_id, owner_epoch, process_incarnation, process_identity, source_revision,
            accepted_spec_digest, pins_digest: String::new() };
        pins.validate()?;
        pins.pins_digest = pins.compute_digest();
        Ok(pins)
    }

    fn validate(&self) -> Result<(), WorkerDurableError> {
        for value in [&self.goal_id, &self.run_id, &self.workspace_binding, &self.session_id,
            &self.location_id, &self.process_incarnation, &self.source_revision] {
            validate_owner_token(value)?;
        }
        if !self.principal_ref.starts_with("server_auth:")
            || self.principal_ref.len() > 256 || self.principal_ref.chars().any(char::is_control)
            || self.owner_epoch == 0 || self.process_identity.pid == 0
            || self.process_identity.start_identity == 0
        {
            return Err(WorkerDurableError::Invalid("invalid authenticated Core coordinator pins"));
        }
        validate_owner_digest(&self.accepted_spec_digest, "blake3:")?;
        if !self.pins_digest.is_empty() && self.pins_digest != self.compute_digest() {
            return Err(WorkerDurableError::Conflict("root coordinator pin digest mismatch"));
        }
        Ok(())
    }

    fn compute_digest(&self) -> String {
        let mut bytes = b"horizoncode.root-coordinator-registration-pins.v1\0".to_vec();
        for value in [&self.goal_id, &self.run_id, &self.principal_ref, &self.workspace_binding,
            &self.session_id, &self.location_id, &self.process_incarnation, &self.source_revision,
            &self.accepted_spec_digest] {
            bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes.extend_from_slice(&self.owner_epoch.to_be_bytes());
        bytes.extend_from_slice(&self.process_identity.pid.to_be_bytes());
        bytes.extend_from_slice(&self.process_identity.start_identity.to_be_bytes());
        format!("blake3:{}", blake3::hash(&bytes).to_hex())
    }

    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn principal_ref(&self) -> &str { &self.principal_ref }
    pub(crate) fn workspace_binding(&self) -> &str { &self.workspace_binding }
    pub(crate) fn session_id(&self) -> &str { &self.session_id }
    pub(crate) fn location_id(&self) -> &str { &self.location_id }
    pub(crate) fn owner_epoch(&self) -> u64 { self.owner_epoch }
    pub(crate) fn process_incarnation(&self) -> &str { &self.process_incarnation }
    pub(crate) fn process_identity(&self) -> &ProcessIdentity { &self.process_identity }
    pub(crate) fn source_revision(&self) -> &str { &self.source_revision }
    pub(crate) fn accepted_spec_digest(&self) -> &str { &self.accepted_spec_digest }
    pub(crate) fn pins_digest(&self) -> &str { &self.pins_digest }
}

/// Immutable, authenticated READY-Task facts used to reserve resources before
/// P1 creates the managed Attempt. This is a private Core→HostKernel product,
/// never an RPC-decodable request or an authority by identifier alone.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrustedPreAdmissionPinsV1 {
    owner: AuthenticatedOwnerContext,
    goal_id: String,
    task_revision: String,
    task_attempt_count: u64,
    candidate_generation: u64,
    accepted_spec_digest: String,
    workspace_revision: String,
    location_id: String,
    process_incarnation: String,
    profile_id: String,
    profile_revision: u64,
    profile_digest: String,
    profile_permission_ceiling_digest: String,
    context_selection_digest: Option<String>,
    accepted_scope_digest: String,
    capability_ceiling_digest: String,
    spec_max_workers: u64,
    resource_policy_revision: u64,
    resource_policy_digest: String,
    resource_active_worker_limit: Option<u64>,
    dimension: crate::resource_budget::BudgetDimension,
    amount: u64,
    expires_at_ms: u64,
    worktree: crate::worker_pool::WorktreeBindingRequest,
    worktree_pool_revision: u64,
    idempotency_key: String,
    parent_proof: ManagedParentProofV1,
    /// New two-stage reservations use a context-independent candidate digest.
    /// The context digest is durably attached by `PreAdmissionContextBound`.
    /// Legacy full-pin reservations keep their original digest/ID derivation.
    staged_pre_admission: bool,
    pins_digest: String,
}

/// Canonical P1-facing name for the immutable READY Task token. It is minted
/// only by the authenticated HostKernel path after checking the current Run,
/// Task, SpecVersion, profile, context, workspace, Guard ceiling and parent.
pub(crate) type ManagedReadyTaskPinV1 = TrustedPreAdmissionPinsV1;

/// Stage-A pins for the managed pre-admission target. ContextSelection is
/// genuinely absent and excluded from the candidate identity digest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedPreAdmissionTargetPinsV1 {
    pins: TrustedPreAdmissionPinsV1,
}

impl ManagedPreAdmissionTargetPinsV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_verified_host_staged(
        owner: AuthenticatedOwnerContext,
        goal_id: String,
        task_revision: String,
        task_attempt_count: u64,
        candidate_generation: u64,
        accepted_spec_digest: String,
        workspace_revision: String,
        location_id: String,
        process_incarnation: String,
        profile_id: String,
        profile_revision: u64,
        profile_digest: String,
        profile_permission_ceiling_digest: String,
        accepted_scope_digest: String,
        capability_ceiling_digest: String,
        spec_max_workers: u64,
        resource_policy_revision: u64,
        resource_policy_digest: String,
        resource_active_worker_limit: Option<u64>,
        dimension: crate::resource_budget::BudgetDimension,
        amount: u64,
        expires_at_ms: u64,
        worktree: crate::worker_pool::ResolvedManagedWorktreeV1,
        idempotency_key: String,
        parent_proof: ManagedParentProofV1,
    ) -> Result<Self, WorkerDurableError> {
        if resource_policy_revision == 0 {
            return Err(WorkerDurableError::Invalid("resource policy revision is zero"));
        }
        if worktree.workspace_binding() != owner.workspace_binding()
            || worktree.location_id() != location_id
            || worktree.source_revision() != workspace_revision
            || worktree.pool_revision() == 0
        {
            return Err(WorkerDurableError::Conflict(
                "resolved worktree differs from authenticated owner, Location or workspace revision",
            ));
        }
        let worktree_pool_revision = worktree.pool_revision();
        let worktree = crate::worker_pool::WorktreeBindingRequest {
            worktree_id: worktree.worktree_id().to_owned(),
            base_revision: worktree.base_revision().to_owned(),
        };
        let mut pins = TrustedPreAdmissionPinsV1 {
            owner, goal_id, task_revision, task_attempt_count, candidate_generation,
            accepted_spec_digest, workspace_revision, location_id, process_incarnation,
            profile_id, profile_revision, profile_digest, profile_permission_ceiling_digest,
            context_selection_digest: None, accepted_scope_digest,
            capability_ceiling_digest, spec_max_workers, resource_policy_revision,
            resource_policy_digest, resource_active_worker_limit, dimension, amount,
            expires_at_ms, worktree, worktree_pool_revision, idempotency_key,
            parent_proof, staged_pre_admission: true, pins_digest: String::new(),
        };
        pins.validate()?;
        pins.pins_digest = pins.compute_digest();
        Ok(Self { pins })
    }

    pub(crate) fn candidate_attempt_id(&self) -> &str { self.pins.attempt_id() }
    pub(crate) fn idempotency_key(&self) -> &str { &self.pins.idempotency_key }
    pub(crate) fn pins_digest(&self) -> &str { &self.pins.pins_digest }
    pub(crate) fn owner(&self) -> &AuthenticatedOwnerContext { &self.pins.owner }
    pub(crate) fn principal_ref(&self) -> &str { self.pins.principal_ref() }
    pub(crate) fn workspace_binding(&self) -> &str { self.pins.workspace_binding() }
    pub(crate) fn session_id(&self) -> &str { self.pins.session_id() }
    pub(crate) fn owner_epoch(&self) -> u64 { self.pins.owner_epoch() }
    pub(crate) fn goal_id(&self) -> &str { &self.pins.goal_id }
    pub(crate) fn run_id(&self) -> &str { self.pins.run_id() }
    pub(crate) fn task_id(&self) -> &str { self.pins.task_id() }
    pub(crate) fn task_revision(&self) -> &str { &self.pins.task_revision }
    pub(crate) fn task_attempt_count(&self) -> u64 { self.pins.task_attempt_count }
    pub(crate) fn candidate_generation(&self) -> u64 { self.pins.candidate_generation }
    pub(crate) fn accepted_spec_digest(&self) -> &str { &self.pins.accepted_spec_digest }
    pub(crate) fn profile_id(&self) -> &str { &self.pins.profile_id }
    pub(crate) fn profile_revision(&self) -> u64 { self.pins.profile_revision }
    pub(crate) fn profile_digest(&self) -> &str { &self.pins.profile_digest }
    pub(crate) fn profile_permission_ceiling_digest(&self) -> &str { &self.pins.profile_permission_ceiling_digest }
    pub(crate) fn accepted_scope_digest(&self) -> &str { &self.pins.accepted_scope_digest }
    pub(crate) fn capability_ceiling_digest(&self) -> &str { &self.pins.capability_ceiling_digest }
    pub(crate) fn workspace_revision(&self) -> &str { &self.pins.workspace_revision }
    pub(crate) fn location_id(&self) -> &str { &self.pins.location_id }
    pub(crate) fn process_incarnation(&self) -> &str { &self.pins.process_incarnation }
    pub(crate) fn spec_max_workers(&self) -> u64 { self.pins.spec_max_workers }
    pub(crate) fn resource_policy_revision(&self) -> u64 { self.pins.resource_policy_revision }
    pub(crate) fn resource_policy_digest(&self) -> &str { &self.pins.resource_policy_digest }
    pub(crate) fn resource_active_worker_limit(&self) -> Option<u64> { self.pins.resource_active_worker_limit }
    pub(crate) fn expires_at_ms(&self) -> u64 { self.pins.expires_at_ms }
    pub(crate) fn worktree_id(&self) -> &str { &self.pins.worktree.worktree_id }
    pub(crate) fn worktree_base_revision(&self) -> &str { &self.pins.worktree.base_revision }
    pub(crate) fn parent_execution_id(&self) -> String { pre_admission_parent_execution_id(&self.pins) }
    pub(crate) fn parent_root_session_id(&self) -> Result<&str, WorkerDurableError> {
        managed_root_session_id(self.pins.parent_proof())
    }
    pub(crate) fn worktree_pool_revision(&self) -> u64 { self.pins.worktree_pool_revision }
}

/// Proof of a Stage-A RESERVED candidate. It carries no ContextSelection,
/// Attempt admission, binding, claim or dispatch authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReservedPreAdmissionTargetProofV1 {
    pins: ManagedPreAdmissionTargetPinsV1,
    reservation: ReservedWorkerLeaseProofV1,
    proof_digest: String,
}

impl ReservedPreAdmissionTargetProofV1 {
    pub(crate) fn pins(&self) -> &ManagedPreAdmissionTargetPinsV1 { &self.pins }
    pub(crate) fn pre_context_pins(&self) -> &ManagedPreAdmissionTargetPinsV1 { &self.pins }
    pub(crate) fn candidate_attempt_id(&self) -> &str { self.pins.candidate_attempt_id() }
    pub(crate) fn candidate_generation(&self) -> u64 { self.pins.candidate_generation() }
    pub(crate) fn idempotency_key(&self) -> &str { self.pins.idempotency_key() }
    pub(crate) fn pins_digest(&self) -> &str { self.pins.pins_digest() }
    pub(crate) fn owner_epoch(&self) -> u64 { self.pins.owner_epoch() }
    pub(crate) fn worker_execution_id(&self) -> &str { self.reservation.worker_execution_id() }
    pub(crate) fn ticket_id(&self) -> &str { self.reservation.ticket_id() }
    pub(crate) fn owner_log_id(&self) -> &str { self.reservation.owner_log_id() }
    pub(crate) fn owner_log_sequence(&self) -> &str { self.reservation.owner_log_sequence() }
    pub(crate) fn owner_log_event_digest(&self) -> &str { self.reservation.owner_log_event_digest() }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.reservation.worker_pool_revision() }
    pub(crate) fn proof_digest(&self) -> &str { &self.proof_digest }
    /// Fresh cursor/pool-bound proof of the currently RESERVED lease. This
    /// changes as OwnerLog advances and is never the response replay key.
    pub(crate) fn lease_proof_digest(&self) -> String {
        self.reservation.proof_digest()
    }
    /// Persisted Stage-B context, when this candidate was already bound.
    pub(crate) fn context_selection_digest(&self) -> Option<&str> {
        self.reservation.context_selection_digest()
    }
    /// Stable reservation receipt for DTO replay; current OwnerLog cursor is
    /// exposed separately and must be refreshed before any admission action.
    pub(crate) fn reservation_receipt_digest(&self) -> String {
        self.reservation.context_bound_receipt_digest()
    }
}

impl ReservedPreAdmissionTargetProofV1 {
    fn new(pins: ManagedPreAdmissionTargetPinsV1, reservation: ReservedWorkerLeaseProofV1) -> Self {
        let mut h = blake3::Hasher::new();
        h.update(b"horizoncode.pre-admission-target-proof.v1\0");
        for value in [pins.pins_digest(), reservation.worker_execution_id(), reservation.ticket_id(),
            reservation.workspace_lease_id()] {
            h.update(&(value.len() as u64).to_be_bytes());
            h.update(value.as_bytes());
        }
        let proof_digest = format!("blake3:{}", h.finalize().to_hex());
        Self { pins, reservation, proof_digest }
    }
}

/// V1 managed Task workers are logical child Sessions in the authenticated Core
/// process. A future process-backed class must carry separate supervisor exit
/// evidence and must never reuse this settlement path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkerExecutionKindV1 {
    LogicalCoreSession,
    ProcessBacked,
}

impl TrustedPreAdmissionPinsV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_verified_host(
        owner: AuthenticatedOwnerContext,
        goal_id: String,
        task_revision: String,
        task_attempt_count: u64,
        candidate_generation: u64,
        accepted_spec_digest: String,
        workspace_revision: String,
        location_id: String,
        process_incarnation: String,
        profile_id: String,
        profile_revision: u64,
        profile_digest: String,
        profile_permission_ceiling_digest: String,
        context_selection_digest: String,
        accepted_scope_digest: String,
        capability_ceiling_digest: String,
        spec_max_workers: u64,
        resource_policy_revision: u64,
        resource_policy_digest: String,
        resource_active_worker_limit: Option<u64>,
        dimension: crate::resource_budget::BudgetDimension,
        amount: u64,
        expires_at_ms: u64,
        worktree: crate::worker_pool::ResolvedManagedWorktreeV1,
        idempotency_key: String,
        parent_proof: ManagedParentProofV1,
    ) -> Result<Self, WorkerDurableError> {
        if resource_policy_revision == 0 {
            return Err(WorkerDurableError::Invalid("resource policy revision is zero"));
        }
        if worktree.workspace_binding() != owner.workspace_binding()
            || worktree.location_id() != location_id
            || worktree.source_revision() != workspace_revision
            || worktree.pool_revision() == 0
        {
            return Err(WorkerDurableError::Conflict(
                "resolved worktree differs from authenticated owner, Location or workspace revision",
            ));
        }
        let worktree_pool_revision = worktree.pool_revision();
        let worktree = crate::worker_pool::WorktreeBindingRequest {
            worktree_id: worktree.worktree_id().to_owned(),
            base_revision: worktree.base_revision().to_owned(),
        };
        let mut pins = Self {
            owner,
            goal_id,
            task_revision,
            task_attempt_count,
            candidate_generation,
            accepted_spec_digest,
            workspace_revision,
            location_id,
            process_incarnation,
            profile_id,
            profile_revision,
            profile_digest,
            profile_permission_ceiling_digest,
            context_selection_digest: Some(context_selection_digest),
            accepted_scope_digest,
            capability_ceiling_digest,
            spec_max_workers,
            resource_policy_revision,
            resource_policy_digest,
            resource_active_worker_limit,
            dimension,
            amount,
            expires_at_ms,
            worktree,
            worktree_pool_revision,
            idempotency_key,
            parent_proof,
            staged_pre_admission: false,
            pins_digest: String::new(),
        };
        pins.validate()?;
        pins.pins_digest = pins.compute_digest();
        Ok(pins)
    }

    fn validate(&self) -> Result<(), WorkerDurableError> {
        if self.owner.owner_epoch() == 0 || self.amount != 1
            || self.dimension != crate::resource_budget::BudgetDimension::ActiveWorkers
            || self.spec_max_workers == 0 || self.expires_at_ms == 0
            || self.profile_revision == 0 || self.idempotency_key.is_empty()
            || self.worktree_pool_revision == 0
            || self.idempotency_key.len() > 256
            || self.idempotency_key.chars().any(char::is_control)
        {
            return Err(WorkerDurableError::Invalid("invalid managed pre-admission pins"));
        }
        for value in [&self.goal_id, &self.task_revision, &self.location_id,
            &self.process_incarnation, &self.profile_id, &self.worktree.worktree_id,
            &self.worktree.base_revision] {
            validate_owner_token(value)?;
        }
        for value in [&self.accepted_spec_digest, &self.workspace_revision,
            &self.profile_digest, &self.profile_permission_ceiling_digest,
            &self.accepted_scope_digest] {
            validate_owner_digest(value, "blake3:")?;
        }
        match self.context_selection_digest.as_deref() {
            Some(value) => validate_owner_digest(value, "blake3:")?,
            None if self.staged_pre_admission => {},
            None => return Err(WorkerDurableError::Invalid("ContextSelection digest is required after pre-admission binding")),
        }
        validate_owner_digest(&self.capability_ceiling_digest, "sha256:")?;
        if self.resource_policy_revision == 0 {
            // Schema-v1 records written before resource-policy pinning remain
            // replayable for conservative recovery, but carry no authority for
            // new admission.
            if !self.resource_policy_digest.is_empty() || self.resource_active_worker_limit.is_some() {
                return Err(WorkerDurableError::Invalid("legacy pre-admission pins contain resource authority"));
            }
        } else {
            validate_owner_digest(&self.resource_policy_digest, "blake3:")?;
        }
        if self.resource_active_worker_limit == Some(0) {
            return Err(WorkerDurableError::Invalid("resource active-worker policy limit is zero"));
        }
        if self.owner.workspace_binding().is_empty()
            || self.owner.session_id().is_empty()
            || self.owner.run_id().is_empty()
            || self.owner.task_id().is_empty()
            || self.owner.attempt_id().is_empty()
        {
            return Err(WorkerDurableError::Invalid("incomplete managed owner scope"));
        }
        if self.owner.attempt_id() != managed_task_attempt_candidate_id(
            self.owner.task_id(), self.task_attempt_count, self.candidate_generation,
        ) {
            return Err(WorkerDurableError::Conflict(
                "candidate Attempt ID does not match Task attempt count and candidate generation",
            ));
        }
        if !self.pins_digest.is_empty() && self.pins_digest != self.compute_digest() {
            return Err(WorkerDurableError::Conflict("managed pre-admission pin digest mismatch"));
        }
        Ok(())
    }

    fn compute_digest(&self) -> String {
        let mut bytes = if self.staged_pre_admission {
            b"horizoncode.trusted-pre-admission-pins.staged.v1\0".to_vec()
        } else if self.resource_policy_revision == 0 {
            b"horizoncode.trusted-pre-admission-pins.v1\0".to_vec()
        } else {
            b"horizoncode.trusted-pre-admission-pins.v2\0".to_vec()
        };
        for value in [
            self.owner.principal_ref(), self.owner.workspace_binding(), self.owner.session_id(),
            self.owner.run_id(), self.owner.task_id(), self.owner.attempt_id(), &self.goal_id,
            &self.task_revision, &self.accepted_spec_digest, &self.workspace_revision,
            &self.location_id, &self.process_incarnation, &self.profile_id, &self.profile_digest,
            &self.profile_permission_ceiling_digest,
        ] {
            bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        if !self.staged_pre_admission {
            if let Some(value) = self.context_selection_digest.as_deref() {
                bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
                bytes.extend_from_slice(value.as_bytes());
            }
        }
        for value in [&self.accepted_scope_digest, &self.capability_ceiling_digest,
            &self.worktree.worktree_id, &self.worktree.base_revision, &self.idempotency_key] {
            bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes.extend_from_slice(&self.owner.owner_epoch().to_be_bytes());
        bytes.extend_from_slice(&self.task_attempt_count.to_be_bytes());
        bytes.extend_from_slice(&self.candidate_generation.to_be_bytes());
        bytes.extend_from_slice(&self.profile_revision.to_be_bytes());
        bytes.extend_from_slice(&self.spec_max_workers.to_be_bytes());
        if self.resource_policy_revision != 0 {
            bytes.extend_from_slice(&self.resource_policy_revision.to_be_bytes());
            bytes.extend_from_slice(&(self.resource_policy_digest.len() as u64).to_be_bytes());
            bytes.extend_from_slice(self.resource_policy_digest.as_bytes());
            match self.resource_active_worker_limit {
                Some(limit) => {
                    bytes.push(1);
                    bytes.extend_from_slice(&limit.to_be_bytes());
                }
                None => bytes.push(0),
            }
        }
        bytes.extend_from_slice(&self.worktree_pool_revision.to_be_bytes());
        bytes.extend_from_slice(&self.amount.to_be_bytes());
        bytes.extend_from_slice(&self.expires_at_ms.to_be_bytes());
        bytes.push(match self.dimension {
            crate::resource_budget::BudgetDimension::MemoryBytes => 1,
            crate::resource_budget::BudgetDimension::CpuMillicores => 2,
            crate::resource_budget::BudgetDimension::Processes => 3,
            crate::resource_budget::BudgetDimension::FileDescriptors => 4,
            crate::resource_budget::BudgetDimension::DiskBytes => 5,
            crate::resource_budget::BudgetDimension::ToolOutputBytes => 6,
            crate::resource_budget::BudgetDimension::ActiveWorkers => 7,
            crate::resource_budget::BudgetDimension::Tokens => 8,
            crate::resource_budget::BudgetDimension::ProviderCostMicros => 9,
        });
        match &self.parent_proof {
            ManagedParentProofV1::RootCoordinator(proof) => {
                bytes.push(1);
                for value in [proof.worker_execution_id(), proof.goal_id(), proof.run_id(),
                    proof.principal_ref(), proof.workspace_binding(), proof.session_id(),
                    proof.location_id(), proof.process_incarnation(), proof.source_revision(),
                    proof.accepted_spec_digest(), proof.owner_log_id(), proof.owner_log_sequence(),
                    proof.owner_log_event_digest()] {
                    bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
                    bytes.extend_from_slice(value.as_bytes());
                }
                bytes.extend_from_slice(&proof.owner_epoch().to_be_bytes());
                bytes.extend_from_slice(&proof.worker_pool_revision().to_be_bytes());
                bytes.extend_from_slice(&proof.expires_at_ms().to_be_bytes());
                bytes.extend_from_slice(&proof.process_identity().pid.to_be_bytes());
                bytes.extend_from_slice(&proof.process_identity().start_identity.to_be_bytes());
            }
            ManagedParentProofV1::ClaimedWorker(proof) => {
                bytes.push(2);
                for value in [proof.worker_execution_id(), proof.goal_id(),
                    proof.owner.principal_ref.as_str(), proof.owner.workspace_binding.as_str(),
                    proof.owner.session_id.as_str(), proof.owner.run_id.as_str(),
                    proof.owner.task_id.as_str(), proof.owner.attempt_id.as_str(),
                    proof.source_revision(), proof.accepted_spec_digest(),
                    proof.owner_log_id(), proof.owner_log_sequence(), proof.owner_log_event_digest()] {
                    bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
                    bytes.extend_from_slice(value.as_bytes());
                }
                bytes.extend_from_slice(&proof.owner.owner_epoch.to_be_bytes());
                bytes.extend_from_slice(&proof.worker_pool_revision().to_be_bytes());
                bytes.extend_from_slice(&proof.process_identity().pid.to_be_bytes());
                bytes.extend_from_slice(&proof.process_identity().start_identity.to_be_bytes());
            }
        }
        format!("blake3:{}", blake3::hash(&bytes).to_hex())
    }

    pub(crate) fn owner(&self) -> &AuthenticatedOwnerContext { &self.owner }
    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn run_id(&self) -> &str { self.owner.run_id() }
    pub(crate) fn task_id(&self) -> &str { self.owner.task_id() }
    pub(crate) fn attempt_id(&self) -> &str { self.owner.attempt_id() }
    pub(crate) fn execution_kind(&self) -> WorkerExecutionKindV1 {
        WorkerExecutionKindV1::LogicalCoreSession
    }
    pub(crate) fn task_revision(&self) -> &str { &self.task_revision }
    pub(crate) fn task_attempt_count(&self) -> u64 { self.task_attempt_count }
    pub(crate) fn candidate_generation(&self) -> u64 { self.candidate_generation }
    pub(crate) fn accepted_spec_digest(&self) -> &str { &self.accepted_spec_digest }
    pub(crate) fn workspace_revision(&self) -> &str { &self.workspace_revision }
    pub(crate) fn workspace_binding(&self) -> &str { self.owner.workspace_binding() }
    pub(crate) fn session_id(&self) -> &str { self.owner.session_id() }
    pub(crate) fn location_id(&self) -> &str { &self.location_id }
    pub(crate) fn owner_epoch(&self) -> u64 { self.owner.owner_epoch() }
    pub(crate) fn principal_ref(&self) -> &str { self.owner.principal_ref() }
    pub(crate) fn process_incarnation(&self) -> &str { &self.process_incarnation }
    pub(crate) fn profile_id(&self) -> &str { &self.profile_id }
    pub(crate) fn profile_revision(&self) -> u64 { self.profile_revision }
    pub(crate) fn profile_digest(&self) -> &str { &self.profile_digest }
    pub(crate) fn profile_permission_ceiling_digest(&self) -> &str { &self.profile_permission_ceiling_digest }
    pub(crate) fn context_selection_digest(&self) -> Option<&str> { self.context_selection_digest.as_deref() }
    pub(crate) fn accepted_scope_digest(&self) -> &str { &self.accepted_scope_digest }
    pub(crate) fn capability_ceiling_digest(&self) -> &str { &self.capability_ceiling_digest }
    pub(crate) fn spec_max_workers(&self) -> u64 { self.spec_max_workers }
    pub(crate) fn resource_policy_revision(&self) -> u64 { self.resource_policy_revision }
    pub(crate) fn resource_policy_digest(&self) -> &str { &self.resource_policy_digest }
    pub(crate) fn resource_active_worker_limit(&self) -> Option<u64> { self.resource_active_worker_limit }
    pub(crate) fn dimension(&self) -> crate::resource_budget::BudgetDimension { self.dimension }
    pub(crate) fn amount(&self) -> u64 { self.amount }
    pub(crate) fn expires_at_ms(&self) -> u64 { self.expires_at_ms }
    pub(crate) fn worktree(&self) -> &crate::worker_pool::WorktreeBindingRequest { &self.worktree }
    pub(crate) fn worktree_pool_revision(&self) -> u64 { self.worktree_pool_revision }
    pub(crate) fn idempotency_key(&self) -> &str { &self.idempotency_key }
    pub(crate) fn parent_proof(&self) -> &ManagedParentProofV1 { &self.parent_proof }
    pub(crate) fn pins_digest(&self) -> &str { &self.pins_digest }
}

fn managed_task_attempt_candidate_id(task_id: &str, attempt_count: u64, generation: u64) -> String {
    let mut bytes = b"horizoncode.managed-task-attempt-candidate.v1\0".to_vec();
    bytes.extend_from_slice(&(task_id.len() as u64).to_be_bytes());
    bytes.extend_from_slice(task_id.as_bytes());
    bytes.extend_from_slice(&attempt_count.to_be_bytes());
    bytes.extend_from_slice(&generation.to_be_bytes());
    format!("attempt_{}", blake3::hash(&bytes).to_hex())
}

/// A one-use proof that P8 durably reserved this exact READY Task before P1
/// admitted its Attempt. IDs and lease references are informative only; P1
/// must compare the full pins and the current P8 cursor before managed commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReservedWorkerLeaseProofV1 {
    attempt_id: String,
    worker_execution_id: String,
    ticket_id: String,
    budget_lease_id: String,
    workspace_lease_id: String,
    resource_lease_ids: Vec<String>,
    pins_digest: String,
    context_selection_digest: Option<String>,
    binding_digest: Option<String>,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
}

impl ReservedWorkerLeaseProofV1 {
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn worker_execution_id(&self) -> &str { &self.worker_execution_id }
    pub(crate) fn ticket_id(&self) -> &str { &self.ticket_id }
    pub(crate) fn budget_lease_id(&self) -> &str { &self.budget_lease_id }
    pub(crate) fn workspace_lease_id(&self) -> &str { &self.workspace_lease_id }
    pub(crate) fn resource_lease_ids(&self) -> &[String] { &self.resource_lease_ids }
    pub(crate) fn pins_digest(&self) -> &str { &self.pins_digest }
    pub(crate) fn context_selection_digest(&self) -> Option<&str> {
        self.context_selection_digest.as_deref()
    }
    /// Digest of the exact current reservation proof. At Stage A this binds
    /// the context-free candidate; Stage B includes the compiled context pin.
    pub(crate) fn proof_digest(&self) -> String {
        let mut h = blake3::Hasher::new();
        h.update(b"horizoncode.reserved-worker-lease-proof.v1\0");
        for value in [self.attempt_id.as_str(), self.worker_execution_id.as_str(),
            self.ticket_id.as_str(), self.budget_lease_id.as_str(),
            self.workspace_lease_id.as_str(), self.pins_digest.as_str(),
            self.owner_log_id.as_str(), self.owner_log_sequence.as_str(),
            self.owner_log_event_digest.as_str()]
        .into_iter().chain(self.context_selection_digest.as_deref())
        .chain(self.resource_lease_ids.iter().map(String::as_str)) {
            h.update(&(value.len() as u64).to_be_bytes());
            h.update(value.as_bytes());
        }
        h.update(&self.worker_pool_revision.to_be_bytes());
        format!("blake3:{}", h.finalize().to_hex())
    }
    /// Stable idempotency receipt for the immutable context-bind event. Unlike
    /// `proof_digest`, this does not claim the current lease cursor and remains
    /// unchanged after admission or later OwnerLog events.
    pub(crate) fn context_bound_receipt_digest(&self) -> String {
        let mut h = blake3::Hasher::new();
        h.update(b"horizoncode.pre-admission-context-bound-receipt.v1\0");
        for value in [self.attempt_id.as_str(), self.worker_execution_id.as_str(),
            self.ticket_id.as_str(), self.budget_lease_id.as_str(),
            self.workspace_lease_id.as_str(), self.pins_digest.as_str()]
        .into_iter().chain(self.context_selection_digest.as_deref())
        .chain(self.resource_lease_ids.iter().map(String::as_str)) {
            h.update(&(value.len() as u64).to_be_bytes());
            h.update(value.as_bytes());
        }
        format!("blake3:{}", h.finalize().to_hex())
    }
    pub(crate) fn binding_digest(&self) -> Option<&str> { self.binding_digest.as_deref() }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
}

/// P8 proof after the durable claim fence. It is still not a HostProcessRef,
/// Guard lease or permission to spawn; P1 must route through ExecutionHost and
/// bind the authenticated process generation after a successful launch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClaimedWorkerDispatchProofV1 {
    reserved: ReservedWorkerLeaseProofV1,
}

impl ClaimedWorkerDispatchProofV1 {
    pub(crate) fn reservation(&self) -> &ReservedWorkerLeaseProofV1 { &self.reserved }
    pub(crate) fn attempt_id(&self) -> &str { self.reserved.attempt_id() }
    pub(crate) fn worker_execution_id(&self) -> &str { self.reserved.worker_execution_id() }
    pub(crate) fn binding_digest(&self) -> &str {
        self.reserved.binding_digest().expect("claimed proof requires attached binding")
    }
    pub(crate) fn pins_digest(&self) -> &str { self.reserved.pins_digest() }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.reserved.worker_pool_revision() }
    pub(crate) fn owner_log_id(&self) -> &str { self.reserved.owner_log_id() }
    pub(crate) fn owner_log_sequence(&self) -> &str { self.reserved.owner_log_sequence() }
    pub(crate) fn owner_log_event_digest(&self) -> &str { self.reserved.owner_log_event_digest() }

    /// Stable cursor-bound claim nonce for P1's canonical handoff digest. This
    /// is an idempotency/replay fence, not a bearer credential or Guard lease.
    pub(crate) fn claim_nonce(&self) -> String {
        let mut bytes = b"horizoncode.claimed-worker-dispatch-proof.v1\0".to_vec();
        for value in [self.attempt_id(), self.worker_execution_id(), self.binding_digest(),
            self.pins_digest(), self.owner_log_id(), self.owner_log_sequence(),
            self.owner_log_event_digest()] {
            bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes.extend_from_slice(&self.worker_pool_revision().to_be_bytes());
        format!("blake3:{}", blake3::hash(&bytes).to_hex())
    }
}

/// P1-minted terminal authority for a managed logical Core child. The P2
/// snapshot is required as an opaque reducer projection; the root proof and
/// P8 claim remain independently revalidated by `WorkerPoolControl`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkerSettlementProofV1 {
    execution_kind: WorkerExecutionKindV1,
    claim: ClaimedWorkerDispatchProofV1,
    root: RootCoordinatorExecutionProofV1,
    owner: AuthenticatedOwnerContext,
    attempt_binding: VerifiedAttemptBinding,
    terminal: crate::managed_control::ManagedAttemptTerminalSnapshotV1,
    verifier_pins: Option<crate::host_kernel::SettledVerifierChallengeSetPinsV1>,
    host_quiescence_digest: String,
    final_worktree_receipt: Option<GuardedWorktreeReceiptV1>,
    proof_digest: String,
}

/// Independent P1/P2 reconciliation proof for an already quarantined logical
/// Core child. It is not an escape hatch for an unresolved effect chain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkerReconciliationProofV1 {
    quarantine: WorkerManagedQuarantineReceiptV1,
    current_owner: AuthenticatedOwnerContext,
    current_root: ReadOnlyReconciliationRootProofV1,
    current_terminal: crate::managed_control::ManagedAttemptTerminalSnapshotV1,
    current_host_quiescence_digest: String,
    current_worktree_receipt: GuardedWorktreeReceiptV1,
    reconciliation_digest: String,
}

/// P1/P2 authority for completing the second half of a successful worker
/// settlement after the HostKernel owner epoch changed. It never reopens the
/// worker or replays the old Inspect: the receipt must name a newly committed
/// current-epoch Guarded Inspect, while the terminal snapshot must still match
/// the original verified Attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkerSettlementDispositionRecoveryProofV1 {
    current_root: RootCoordinatorExecutionProofV1,
    current_owner: AuthenticatedOwnerContext,
    current_terminal: crate::managed_control::ManagedAttemptTerminalSnapshotV1,
    current_worktree_receipt: GuardedWorktreeReceiptV1,
    current_host_quiescence_digest: String,
    proof_digest: String,
}

impl WorkerSettlementDispositionRecoveryProofV1 {
    pub(crate) fn from_host_kernel(
        current_root: RootCoordinatorExecutionProofV1,
        current_owner: AuthenticatedOwnerContext,
        current_terminal: crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        current_worktree_receipt: GuardedWorktreeReceiptV1,
        current_host_quiescence_digest: String,
    ) -> Result<Self, WorkerDurableError> {
        let receipt = &current_worktree_receipt;
        if current_owner.owner_epoch() == 0
            || current_owner.owner_epoch() != current_root.owner_epoch()
            || current_owner.principal_ref() != current_root.principal_ref()
            || current_owner.workspace_binding() != current_root.workspace_binding()
            || current_owner.run_id() != current_root.run_id()
            || current_terminal.goal_id() != current_root.goal_id()
            || current_terminal.run_id() != current_root.run_id()
            || current_terminal.attempt_state() != crate::managed_control::ManagedAttemptTerminalStateV1::Succeeded
            || current_terminal.task_state() != crate::managed_control::ManagedTaskTerminalStateV1::Verified
            || current_terminal.effect_chain_state() != crate::managed_control::ManagedAttemptEffectChainStateV1::AllSettled
            || current_terminal.child_prompt_state() != crate::managed_control::ManagedChildPromptStateV1::Quiesced
            || current_terminal.child_prompt_quiescence().is_none_or(|q| {
                let p = q.proof();
                p.goal_id() != current_terminal.goal_id()
                    || p.run_id() != current_terminal.run_id()
                    || p.task_id() != current_terminal.task_id()
                    || p.attempt_id() != current_terminal.attempt_id()
                    || p.parent_session_id() != current_root.session_id()
                    || p.session_id() != current_owner.session_id()
                    || p.owner_epoch() != current_owner.owner_epoch()
            })
            || current_terminal.observed_workspace_head() != Some(receipt.observed_workspace_revision())
            || receipt.workspace_binding() != current_owner.workspace_binding()
            || matches!(receipt.status(), WorktreeObservedStatusV1::Missing | WorktreeObservedStatusV1::Unknown)
            || !receipt.owned() || !receipt.no_follow()
            || !valid_digest(&current_host_quiescence_digest, "blake3:")
            || !valid_digest(current_terminal.owner_log_event_digest(), "blake3:")
            || !valid_digest(current_terminal.attempt_state_digest(), "blake3:")
            || !valid_digest(current_terminal.effect_chain_digest(), "blake3:")
        {
            return Err(WorkerDurableError::Conflict(
                "settlement disposition recovery lacks current root, verified terminal, quiescence, or Guarded Inspect proof",
            ));
        }
        let mut h = blake3::Hasher::new();
        h.update(b"horizoncode.worker-settlement-disposition-recovery.v1\0");
        for value in [current_root.owner_log_id(), current_root.owner_log_sequence(),
            current_root.owner_log_event_digest(), current_owner.principal_ref(),
            current_owner.workspace_binding(), current_owner.session_id(),
            current_owner.run_id(), current_owner.task_id(), current_owner.attempt_id(),
            current_terminal.owner_log_id(), current_terminal.owner_log_event_digest(),
            current_terminal.attempt_state_digest(), current_terminal.effect_chain_digest(),
            current_host_quiescence_digest.as_str(), receipt.operation_id(),
            receipt.host_receipt_ref(), receipt.observed_workspace_revision()] {
            append_digest_field(&mut h, value);
        }
        h.update(&current_owner.owner_epoch().to_be_bytes());
        let proof_digest = format!("blake3:{}", h.finalize().to_hex());
        Ok(Self { current_root, current_owner, current_terminal, current_worktree_receipt,
            current_host_quiescence_digest, proof_digest })
    }
}

impl WorkerSettlementProofV1 {
    pub(crate) fn from_host_kernel(
        claim: ClaimedWorkerDispatchProofV1,
        root: RootCoordinatorExecutionProofV1,
        owner: AuthenticatedOwnerContext,
        attempt_binding: VerifiedAttemptBinding,
        terminal: crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        host_quiescence_digest: String,
        final_worktree_receipt: Option<GuardedWorktreeReceiptV1>,
        verifier_pins: Option<crate::host_kernel::SettledVerifierChallengeSetPinsV1>,
    ) -> Result<Self, WorkerDurableError> {
        let execution_kind = WorkerExecutionKindV1::LogicalCoreSession;
        let quiescence = terminal.child_prompt_quiescence();
        if owner.owner_epoch() == 0
            || owner.owner_epoch() != attempt_binding.owner_epoch()
            || owner.principal_ref() != root.principal_ref()
            || owner.workspace_binding() != root.workspace_binding()
            || owner.run_id() != root.run_id()
            || root.goal_id() != terminal.goal_id()
            || claim.attempt_id() != attempt_binding.attempt_id()
            || claim.binding_digest() != terminal.binding_digest()
            || claim.attempt_id() != terminal.attempt_id()
            || attempt_binding.goal_id() != terminal.goal_id()
            || attempt_binding.run_id() != terminal.run_id()
            || attempt_binding.task_id() != terminal.task_id()
            || attempt_binding.attempt_id() != terminal.attempt_id()
            || attempt_binding.accepted_spec_digest() != terminal.spec_digest()
            || terminal.admission_workspace_revision() != Some(attempt_binding.source_revision())
            || !matches!(terminal.effect_chain_state(), crate::managed_control::ManagedAttemptEffectChainStateV1::AllSettled)
            || !matches!(terminal.attempt_state(), crate::managed_control::ManagedAttemptTerminalStateV1::Succeeded | crate::managed_control::ManagedAttemptTerminalStateV1::Failed)
            || !matches!(terminal.task_state(), crate::managed_control::ManagedTaskTerminalStateV1::Verified | crate::managed_control::ManagedTaskTerminalStateV1::Failed | crate::managed_control::ManagedTaskTerminalStateV1::Cancelled)
            || terminal.owner_log_sequence() == 0
            || terminal.managed_revision() == 0
            || terminal.child_prompt_state() != crate::managed_control::ManagedChildPromptStateV1::Quiesced
            || quiescence.is_none_or(|receipt| {
                let marker = receipt.proof();
                marker.goal_id() != terminal.goal_id()
                    || marker.run_id() != terminal.run_id()
                    || marker.task_id() != terminal.task_id()
                    || marker.attempt_id() != terminal.attempt_id()
                    || marker.parent_session_id() != root.session_id()
                    || marker.session_id() != owner.session_id()
                    || marker.owner_epoch() != owner.owner_epoch()
            })
            || terminal.child_prompt_quiescence_digest().is_none_or(|digest| !valid_digest(digest, "blake3:"))
            || terminal.child_prompt_quiescence_owner_log_id().is_none_or(str::is_empty)
            || terminal.child_prompt_quiescence_owner_log_sequence().is_none_or(|sequence| sequence == 0)
            || terminal.child_prompt_quiescence_owner_log_event_digest()
                .is_none_or(|digest| !valid_digest(digest, "blake3:"))
            || !valid_digest(&terminal.owner_log_event_digest(), "blake3:")
            || !valid_digest(terminal.attempt_state_digest(), "blake3:")
            || !valid_digest(terminal.effect_chain_digest(), "blake3:")
            || !valid_digest(&host_quiescence_digest, "blake3:")
            || terminal.observed_workspace_head().is_some_and(|head| !valid_digest(head, "blake3:"))
            || validate_settlement_evidence(terminal.evidence_digest(), terminal.evidence_refs()).is_err()
            || validate_terminal_usage_accounting(
                &terminal,
                terminal.task_state() == crate::managed_control::ManagedTaskTerminalStateV1::Verified,
            ).is_err()
            || terminal.effects().len() > MAX_BATCH_EVENTS
            || terminal.effects().iter().any(|effect| {
                effect.effect_id().is_empty()
                    || effect.outcome().is_none()
                    || effect.outcome() == Some(crate::managed_control::AttemptEffectOutcomeV1::Unknown)
                    || effect.observation_digest().is_none_or(|digest| !valid_digest(digest, "blake3:"))
            })
        {
            return Err(WorkerDurableError::Conflict(
                "managed logical worker terminal evidence is incomplete or mismatched",
            ));
        }
        if terminal.task_state() == crate::managed_control::ManagedTaskTerminalStateV1::Verified
            && (terminal.evidence_digest().is_none() || terminal.evidence_refs().is_empty()
                || terminal.observed_workspace_head().is_none() || final_worktree_receipt.is_none())
        {
            return Err(WorkerDurableError::Conflict("verified Task lacks final Inspect or durable verifier evidence refs"));
        }
        let verified = terminal.task_state() == crate::managed_control::ManagedTaskTerminalStateV1::Verified;
        if verified != verifier_pins.is_some() {
            return Err(WorkerDurableError::Conflict(
                "verified settlement requires opaque verifier pins; non-success settlement forbids them",
            ));
        }
        if let Some(pins) = verifier_pins.as_ref() {
            if pins.goal_id() != terminal.goal_id() || pins.run_id() != terminal.run_id()
                || pins.task_id() != terminal.task_id() || pins.attempt_id() != terminal.attempt_id()
                || terminal.evidence_digest() != Some(pins.evidence_digest())
                || !valid_digest(pins.set_identity_digest(), "blake3:")
                || !valid_digest(pins.challenge_set_digest(), "blake3:")
                || pins.verification_run_id().is_empty()
            {
                return Err(WorkerDurableError::Conflict(
                    "opaque verifier-set pins differ from the authenticated terminal evidence",
                ));
            }
        }
        if final_worktree_receipt.as_ref().is_some_and(|receipt| {
            receipt.workspace_binding() != owner.workspace_binding()
                || terminal.observed_workspace_head()
                    .is_none_or(|head| head != receipt.observed_workspace_revision())
                || matches!(receipt.status(), WorktreeObservedStatusV1::Missing | WorktreeObservedStatusV1::Unknown)
                || !receipt.owned()
                || !receipt.no_follow()
        }) {
            return Err(WorkerDurableError::Conflict(
                "final guarded workspace receipt differs from terminal workspace observation",
            ));
        }
        if verified && final_worktree_receipt.as_ref()
            .is_none_or(|receipt| !final_inspect_allows_verified_settlement(receipt))
        {
            return Err(WorkerDurableError::Conflict(
                "verified settlement requires a clean or Attempt-owned final Inspect with no user-owned changes",
            ));
        }
        if terminal.attempt_state() == crate::managed_control::ManagedAttemptTerminalStateV1::Succeeded
            && terminal.task_state() != crate::managed_control::ManagedTaskTerminalStateV1::Verified
            || terminal.attempt_state() == crate::managed_control::ManagedAttemptTerminalStateV1::Failed
                && !matches!(terminal.task_state(), crate::managed_control::ManagedTaskTerminalStateV1::Failed | crate::managed_control::ManagedTaskTerminalStateV1::Cancelled)
        {
            return Err(WorkerDurableError::Conflict("Task and Attempt terminal outcomes disagree"));
        }
        let proof_digest = worker_settlement_proof_digest(
            execution_kind, &claim, &root, &owner, &attempt_binding, &terminal,
            &host_quiescence_digest, final_worktree_receipt.as_ref(), verifier_pins.as_ref(),
        );
        Ok(Self {
            execution_kind, claim, root, owner, attempt_binding, terminal,
            host_quiescence_digest, final_worktree_receipt, verifier_pins, proof_digest,
        })
    }

    pub(crate) fn execution_kind(&self) -> WorkerExecutionKindV1 { self.execution_kind }
    pub(crate) fn claim(&self) -> &ClaimedWorkerDispatchProofV1 { &self.claim }
    pub(crate) fn root(&self) -> &RootCoordinatorExecutionProofV1 { &self.root }
    pub(crate) fn owner(&self) -> &AuthenticatedOwnerContext { &self.owner }
    pub(crate) fn attempt_binding(&self) -> &VerifiedAttemptBinding { &self.attempt_binding }
    pub(crate) fn terminal(&self) -> &crate::managed_control::ManagedAttemptTerminalSnapshotV1 { &self.terminal }
    pub(crate) fn host_quiescence_digest(&self) -> &str { &self.host_quiescence_digest }
    pub(crate) fn final_worktree_receipt(&self) -> Option<&GuardedWorktreeReceiptV1> { self.final_worktree_receipt.as_ref() }
    pub(crate) fn verifier_pins(&self) -> Option<&crate::host_kernel::SettledVerifierChallengeSetPinsV1> { self.verifier_pins.as_ref() }
    pub(crate) fn proof_digest(&self) -> &str { &self.proof_digest }
}

impl WorkerReconciliationProofV1 {
    pub(crate) fn from_host_kernel(
        quarantine: WorkerManagedQuarantineReceiptV1,
        current_owner: AuthenticatedOwnerContext,
        current_root: ReadOnlyReconciliationRootProofV1,
        current_terminal: crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        current_host_quiescence_digest: String,
        current_worktree_receipt: GuardedWorktreeReceiptV1,
    ) -> Result<Self, WorkerDurableError> {
        let reason = quarantine.reason();
        let quiescence = current_terminal.child_prompt_quiescence();
        let expected_terminal_state = match reason {
            WorkerManagedQuarantineReasonV1::FailedAttempt => crate::managed_control::ManagedTaskTerminalStateV1::Failed,
            WorkerManagedQuarantineReasonV1::CancelledTask => crate::managed_control::ManagedTaskTerminalStateV1::Cancelled,
        };
        if quarantine.owner_epoch() > current_owner.owner_epoch()
            || current_owner.principal_ref().is_empty()
            || current_owner.workspace_binding().is_empty()
            || current_owner.session_id().is_empty()
            || current_owner.run_id() != quarantine.run_id()
            || current_owner.task_id() != quarantine.task_id()
            || current_owner.attempt_id() != quarantine.attempt_id()
            || current_owner.owner_epoch() == 0
            || current_root.goal_id() != quarantine.goal_id()
            || current_root.run_id() != quarantine.run_id()
            || current_root.principal_ref() != current_owner.principal_ref()
            || current_root.workspace_binding() != current_owner.workspace_binding()
            || current_root.location_id().is_empty()
            || current_root.owner_epoch() != current_owner.owner_epoch()
            || current_root.accepted_spec_digest().is_empty()
            || quarantine.worker_execution_id().is_empty()
            || quarantine.attempt_id().is_empty()
            || quarantine.reservation_id().is_empty()
            || quarantine.worktree_lease_id().is_empty()
            || !valid_digest(quarantine.receipt_digest(), "blake3:")
            || current_terminal.goal_id() != quarantine.goal_id()
            || current_terminal.run_id() != quarantine.run_id()
            || current_terminal.task_id() != quarantine.task_id()
            || current_terminal.attempt_id() != quarantine.attempt_id()
            || !matches!(current_terminal.attempt_state(), crate::managed_control::ManagedAttemptTerminalStateV1::Failed)
            || current_terminal.task_state() != expected_terminal_state
            || current_terminal.child_prompt_state() != crate::managed_control::ManagedChildPromptStateV1::Quiesced
            || current_terminal.effect_chain_state() != crate::managed_control::ManagedAttemptEffectChainStateV1::AllSettled
            || current_terminal.owner_log_sequence() == 0
            || current_terminal.managed_revision() == 0
            || current_terminal.owner_log_id().is_empty()
            || !valid_digest(current_terminal.owner_log_event_digest(), "blake3:")
            || current_terminal.attempt_revision() == 0
            || quiescence.is_none_or(|receipt| {
                let marker = receipt.proof();
                marker.goal_id() != current_terminal.goal_id()
                    || marker.run_id() != current_terminal.run_id()
                    || marker.task_id() != current_terminal.task_id()
                    || marker.attempt_id() != current_terminal.attempt_id()
                    || marker.parent_session_id() != current_root.session_id()
                    || marker.session_id() != current_owner.session_id()
                    || marker.owner_epoch() > current_owner.owner_epoch()
            })
            || current_terminal.child_prompt_quiescence_digest().is_none_or(|digest| !valid_digest(digest, "blake3:"))
            || current_terminal.child_prompt_quiescence_owner_log_id().is_none_or(str::is_empty)
            || current_terminal.child_prompt_quiescence_owner_log_sequence().is_none_or(|sequence| sequence == 0)
            || current_terminal.child_prompt_quiescence_owner_log_event_digest()
                .is_none_or(|digest| !valid_digest(digest, "blake3:"))
            || current_terminal.effects().len() > MAX_BATCH_EVENTS
            || current_terminal.effects().iter().any(|effect| {
                effect.effect_id().is_empty()
                    || effect.outcome().is_none()
                    || effect.outcome() == Some(crate::managed_control::AttemptEffectOutcomeV1::Unknown)
                    || effect.observation_digest().is_none_or(|digest| !valid_digest(digest, "blake3:"))
            })
            || !valid_digest(&current_host_quiescence_digest, "blake3:")
            || !current_worktree_receipt.owned()
            || !current_worktree_receipt.no_follow()
            || matches!(current_worktree_receipt.status(), WorktreeObservedStatusV1::Missing | WorktreeObservedStatusV1::Unknown)
            || current_worktree_receipt.workspace_binding() != current_owner.workspace_binding()
            || !valid_digest(current_terminal.attempt_state_digest(), "blake3:")
            || !valid_digest(current_terminal.effect_chain_digest(), "blake3:")
            || validate_settlement_evidence(current_terminal.evidence_digest(), current_terminal.evidence_refs()).is_err()
            || validate_terminal_usage_accounting(&current_terminal, false).is_err()
        {
            return Err(WorkerDurableError::Invalid("worker reconciliation authority or digest is invalid"));
        }
        let mut h = blake3::Hasher::new();
        h.update(b"horizoncode.worker-reconciliation-proof.v2\0");
        append_digest_field(&mut h, quarantine.receipt_digest());
        for value in [current_owner.principal_ref(), current_owner.workspace_binding(),
            current_owner.session_id(), current_owner.run_id(), current_owner.task_id(),
            current_owner.attempt_id()] {
            append_digest_field(&mut h, value);
        }
        h.update(&current_owner.owner_epoch().to_be_bytes());
        for value in [current_root.worker_execution_id(), current_root.goal_id(), current_root.run_id(),
            current_root.principal_ref(), current_root.workspace_binding(), current_root.session_id(),
            current_root.location_id(), current_root.process_incarnation(), current_root.source_revision(),
            current_root.accepted_spec_digest(), current_root.owner_log_id(), current_root.owner_log_sequence(),
            current_root.owner_log_event_digest()] {
            append_digest_field(&mut h, value);
        }
        h.update(&current_root.owner_epoch().to_be_bytes());
        h.update(&current_root.worker_pool_revision().to_be_bytes());
        h.update(&current_root.process_identity().pid.to_be_bytes());
        h.update(&current_root.process_identity().start_identity.to_be_bytes());
        append_digest_field(&mut h, current_terminal.attempt_state_digest());
        append_digest_field(&mut h, current_terminal.effect_chain_digest());
        append_usage_summary_to_digest(&mut h, current_terminal.usage_accounting());
        append_digest_field(&mut h, current_terminal.owner_log_id());
        append_digest_field(&mut h, current_terminal.owner_log_event_digest());
        h.update(&current_terminal.owner_log_sequence().to_be_bytes());
        h.update(&current_terminal.managed_revision().to_be_bytes());
        append_digest_field(&mut h, &current_host_quiescence_digest);
        append_digest_field(&mut h, current_worktree_receipt.operation_id());
        append_digest_field(&mut h, current_worktree_receipt.host_receipt_ref());
        append_digest_field(&mut h, current_worktree_receipt.observed_workspace_revision());
        append_digest_field(&mut h, current_worktree_receipt.dirty_entries_digest());
        h.update(&current_worktree_receipt.registration_generation().to_be_bytes());
        h.update(&current_worktree_receipt.dirty_entry_count().to_be_bytes());
        append_digest_field(&mut h, match current_worktree_receipt.status() {
            WorktreeObservedStatusV1::Clean => "CLEAN",
            WorktreeObservedStatusV1::DirtyOwned => "DIRTY_OWNED",
            WorktreeObservedStatusV1::DirtyUnattributed => "DIRTY_UNATTRIBUTED",
            WorktreeObservedStatusV1::Missing => "MISSING",
            WorktreeObservedStatusV1::Unknown => "UNKNOWN",
        });
        h.update(&[u8::from(current_worktree_receipt.contains_user_owned_changes())]);
        let reconciliation_digest = format!("blake3:{}", h.finalize().to_hex());
        Ok(Self { quarantine, current_owner, current_root, current_terminal,
            current_host_quiescence_digest, current_worktree_receipt, reconciliation_digest })
    }

    pub(crate) fn quarantine(&self) -> &WorkerManagedQuarantineReceiptV1 { &self.quarantine }
    pub(crate) fn current_owner(&self) -> &AuthenticatedOwnerContext { &self.current_owner }
    pub(crate) fn current_root(&self) -> &ReadOnlyReconciliationRootProofV1 { &self.current_root }
    pub(crate) fn current_terminal(&self) -> &crate::managed_control::ManagedAttemptTerminalSnapshotV1 { &self.current_terminal }
    pub(crate) fn current_host_quiescence_digest(&self) -> &str { &self.current_host_quiescence_digest }
    pub(crate) fn current_worktree_receipt(&self) -> &GuardedWorktreeReceiptV1 { &self.current_worktree_receipt }
    pub(crate) fn reconciliation_digest(&self) -> &str { &self.reconciliation_digest }
}

fn valid_digest(value: &str, prefix: &str) -> bool {
    value.len() == prefix.len() + 64 && value.starts_with(prefix)
        && value[prefix.len()..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn worker_settlement_proof_digest(
    execution_kind: WorkerExecutionKindV1,
    claim: &ClaimedWorkerDispatchProofV1,
    root: &RootCoordinatorExecutionProofV1,
    owner: &AuthenticatedOwnerContext,
    binding: &VerifiedAttemptBinding,
    terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
    host_quiescence_digest: &str,
    final_worktree: Option<&GuardedWorktreeReceiptV1>,
    verifier_pins: Option<&crate::host_kernel::SettledVerifierChallengeSetPinsV1>,
) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"horizoncode.logical-worker-settlement-proof.v3\0");
    let claim_nonce = claim.claim_nonce();
    h.update(&[match execution_kind { WorkerExecutionKindV1::LogicalCoreSession => 1, WorkerExecutionKindV1::ProcessBacked => 2 }]);
    for value in [
        claim.attempt_id(), claim.worker_execution_id(), claim.binding_digest(),
        claim.pins_digest(), claim.owner_log_id(), claim.owner_log_sequence(),
        claim.owner_log_event_digest(), claim_nonce.as_str(),
        root.worker_execution_id(), root.goal_id(), root.run_id(), root.principal_ref(),
        root.workspace_binding(), root.session_id(), root.location_id(),
        root.process_incarnation(), root.source_revision(), root.accepted_spec_digest(),
        root.owner_log_id(), root.owner_log_sequence(), root.owner_log_event_digest(),
        owner.principal_ref(), owner.workspace_binding(), owner.session_id(), owner.run_id(),
        owner.task_id(), owner.attempt_id(), binding.goal_id(), binding.run_id(),
        binding.task_id(), binding.attempt_id(), binding.source_revision(),
        binding.accepted_spec_digest(), terminal.goal_id(), terminal.run_id(),
        terminal.task_id(), terminal.attempt_id(), terminal.spec_id(), terminal.spec_digest(),
        terminal.binding_digest(), terminal.owner_log_id(), terminal.owner_log_event_digest(),
        terminal.attempt_state_digest(), terminal.effect_chain_digest(),
        host_quiescence_digest,
    ] { append_digest_field(&mut h, value); }
    append_usage_summary_to_digest(&mut h, terminal.usage_accounting());
    for number in [
        claim.worker_pool_revision(), root.owner_epoch(), root.worker_pool_revision(),
        terminal.task_revision(), terminal.attempt_revision(), terminal.managed_revision(),
        terminal.owner_log_sequence(),
    ] { h.update(&number.to_be_bytes()); }
    h.update(&root.process_identity().pid.to_be_bytes());
    h.update(&root.process_identity().start_identity.to_be_bytes());
    h.update(&[terminal.run_phase() as u8, terminal.task_state() as u8,
        terminal.attempt_state() as u8, terminal.effect_chain_state() as u8,
        terminal.child_prompt_state() as u8]);
    if let Some(pins) = verifier_pins {
        h.update(&[1]);
        for value in [pins.goal_id(), pins.run_id(), pins.task_id(), pins.attempt_id(),
            pins.verification_run_id(), pins.set_identity_digest(), pins.challenge_set_digest(),
            pins.evidence_digest()] { append_digest_field(&mut h, value); }
    } else {
        h.update(&[0]);
    }
    if let Some(digest) = terminal.child_prompt_quiescence_digest() { append_digest_field(&mut h, digest); }
    for value in [
        terminal.admission_workspace_revision().unwrap_or_default(),
        terminal.observed_workspace_head().unwrap_or_default(),
        terminal.child_prompt_quiescence_owner_log_id().unwrap_or_default(),
        terminal.child_prompt_quiescence_owner_log_event_digest().unwrap_or_default(),
    ] { append_digest_field(&mut h, value); }
    h.update(&terminal.child_prompt_quiescence_owner_log_sequence().unwrap_or_default().to_be_bytes());
    if let Some(digest) = terminal.evidence_digest() { append_digest_field(&mut h, digest); }
    for effect in terminal.effects() {
        append_digest_field(&mut h, effect.effect_id());
        if let Some(outcome) = effect.outcome() { h.update(&[outcome as u8]); }
        if let Some(digest) = effect.observation_digest() { append_digest_field(&mut h, digest); }
        if let Some(revision) = effect.before_workspace_revision() { append_digest_field(&mut h, revision); }
        if let Some(revision) = effect.after_workspace_revision() { append_digest_field(&mut h, revision); }
    }
    for artifact in terminal.evidence_refs() {
        for value in [&artifact.artifact_id, &artifact.digest, &artifact.byte_length, &artifact.media_type] {
            append_digest_field(&mut h, value);
        }
        h.update(&[match artifact.classification {
            crate::protocol::ArtifactClassificationV1::Public => 1,
            crate::protocol::ArtifactClassificationV1::Workspace => 2,
            crate::protocol::ArtifactClassificationV1::Sensitive => 3,
        }]);
    }
    if let Some(receipt) = final_worktree {
        h.update(&[1]);
        for value in [receipt.operation_id(), receipt.host_receipt_ref(), receipt.workspace_binding(),
            receipt.observed_workspace_revision(), receipt.dirty_entries_digest()] { append_digest_field(&mut h, value); }
        h.update(&receipt.registration_generation().to_be_bytes());
        h.update(&receipt.dirty_entry_count().to_be_bytes());
        h.update(&[receipt.status() as u8, u8::from(receipt.contains_user_owned_changes()),
            u8::from(receipt.owned()), u8::from(receipt.no_follow())]);
    } else { h.update(&[0]); }
    format!("blake3:{}", h.finalize().to_hex())
}

fn append_digest_field(hasher: &mut blake3::Hasher, value: &str) {
    hasher.update(&(value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
}

fn append_usage_summary_to_digest(
    hasher: &mut blake3::Hasher,
    usage: Option<&crate::managed_control::ManagedAttemptUsageSummaryV1>,
) {
    let Some(usage) = usage else {
        append_digest_field(hasher, "usage-accounting-unavailable");
        return;
    };
    append_digest_field(hasher, "usage-accounting-v1");
    for value in [
        usage.token_remainder_status(), usage.cost_remainder_status(), usage.usage_state(),
        usage.stop_reason(), usage.ceiling_digest(), usage.cost_status(), usage.receipt_chain_digest(),
    ] { append_digest_field(hasher, value); }
    for value in [usage.accounting_cursor(), usage.token_known_subtotal(),
        usage.cost_known_subtotal_micros(), usage.receipt_count()] {
        hasher.update(&value.to_be_bytes());
    }
    hasher.update(&(usage.metric_statuses().len() as u64).to_be_bytes());
    for (metric, status) in usage.metric_statuses() {
        append_digest_field(hasher, metric);
        append_digest_field(hasher, status);
    }
}

fn artifact_ref_value(reference: &crate::protocol::ArtifactRefV1) -> Value {
    json!({
        "artifactId": reference.artifact_id,
        "digest": reference.digest,
        "byteLength": reference.byte_length,
        "mediaType": reference.media_type,
        "classification": match reference.classification {
            crate::protocol::ArtifactClassificationV1::Public => "public",
            crate::protocol::ArtifactClassificationV1::Workspace => "workspace",
            crate::protocol::ArtifactClassificationV1::Sensitive => "sensitive",
        },
    })
}

fn decode_artifact_ref_value(value: Value) -> Result<crate::protocol::ArtifactRefV1, WorkerDurableError> {
    let artifact_id = text(&value, "artifactId")?;
    let digest = text(&value, "digest")?;
    let byte_length = text(&value, "byteLength")?;
    let media_type = text(&value, "mediaType")?;
    let classification = match text(&value, "classification")?.as_str() {
        "public" => crate::protocol::ArtifactClassificationV1::Public,
        "workspace" => crate::protocol::ArtifactClassificationV1::Workspace,
        "sensitive" => crate::protocol::ArtifactClassificationV1::Sensitive,
        _ => return Err(WorkerDurableError::Invalid("invalid artifact classification")),
    };
    validate_owner_token(&artifact_id)?;
    validate_owner_digest(&digest, "blake3:")?;
    validate_owner_token(&media_type)?;
    let parsed_length = byte_length.parse::<u64>()
        .map_err(|_| WorkerDurableError::Invalid("invalid artifact byte length"))?;
    if parsed_length.to_string() != byte_length || byte_length.len() > 20 {
        return Err(WorkerDurableError::Invalid("non-canonical artifact byte length"));
    }
    Ok(crate::protocol::ArtifactRefV1 { artifact_id, digest, byte_length, media_type, classification })
}

fn validate_settlement_evidence(
    evidence_digest: Option<&str>,
    evidence_refs: &[crate::protocol::ArtifactRefV1],
) -> Result<(), WorkerDurableError> {
    if evidence_refs.len() > 256 {
        return Err(WorkerDurableError::Invalid("settlement evidence ref count exceeds limit"));
    }
    if let Some(digest) = evidence_digest {
        validate_owner_digest(digest, "blake3:")?;
    }
    let mut total_bytes = 0u64;
    for reference in evidence_refs {
        let decoded = decode_artifact_ref_value(artifact_ref_value(reference))?;
        total_bytes = total_bytes.saturating_add(decoded.byte_length.parse::<u64>().unwrap_or(u64::MAX));
        if total_bytes > 64 * 1024 * 1024 {
            return Err(WorkerDurableError::Invalid("settlement evidence refs exceed aggregate bound"));
        }
    }
    if evidence_digest.is_some() != !evidence_refs.is_empty() {
        return Err(WorkerDurableError::Invalid("settlement evidence digest and refs are incomplete"));
    }
    Ok(())
}

fn validate_terminal_usage_accounting(
    terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
    required: bool,
) -> Result<(), WorkerDurableError> {
    let Some(usage) = terminal.usage_accounting() else {
        return if required {
            Err(WorkerDurableError::Conflict("verified managed terminal lacks durable usage accounting"))
        } else {
            Ok(())
        };
    };
    validate_usage_accounting_summary(usage, terminal.managed_revision())
}

fn validate_usage_accounting_summary(
    usage: &crate::managed_control::ManagedAttemptUsageSummaryV1,
    managed_revision: u64,
) -> Result<(), WorkerDurableError> {
    let valid_remainder = |value: &str| matches!(value, "KNOWN" | "ESTIMATED" | "UNKNOWN");
    let valid_aggregate_status = |value: &str| matches!(
        value, "provider-reported" | "measured" | "estimated" | "unknown" | "mixed"
    );
    // These are the five canonical keys emitted by ManagedControl's V1
    // per-operation ledger; cache read/write are subcomponents and never
    // duplicate the input-token total.
    let valid_metric_key = |value: &str| matches!(
        value, "input" | "output" | "reasoning" | "cache.read" | "cache.write"
    );
    if usage.accounting_cursor() == 0
        || usage.receipt_count() == 0
        || usage.receipt_count() > usage.accounting_cursor()
        || usage.accounting_cursor() > managed_revision
        || !valid_digest(usage.ceiling_digest(), "blake3:")
        || !valid_digest(usage.receipt_chain_digest(), "blake3:")
        || !valid_remainder(usage.token_remainder_status())
        || !valid_remainder(usage.cost_remainder_status())
        || !matches!(usage.usage_state(), "KNOWN" | "ESTIMATED" | "UNKNOWN")
        || !matches!(usage.stop_reason(), "NONE" | "TOKEN_CEILING" | "COST_CEILING" | "USAGE_UNCERTAIN")
        || !valid_aggregate_status(usage.cost_status())
        || usage.metric_statuses().len() != 5
        || usage.metric_statuses().iter().any(|(metric, status)| {
            !valid_metric_key(metric) || !valid_aggregate_status(status)
        })
    {
        return Err(WorkerDurableError::Conflict("managed terminal usage accounting summary is invalid"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ManagedReservationReconciliationDispositionV1 {
    NotAdmittedNoDispatch,
    TerminalNoEffect,
}

/// Opaque P1 proof from a current managed OwnerLog snapshot and authenticated
/// HostKernel process observation. It authorizes P8 to release only the exact
/// RESERVED candidate after P8 independently confirms no claim/process exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedReservationReconciliationProofV1 {
    worker_execution_id: String,
    ticket_id: String,
    attempt_id: String,
    pins_digest: String,
    disposition: ManagedReservationReconciliationDispositionV1,
    managed_owner_log_id: String,
    managed_owner_log_sequence: String,
    managed_owner_log_event_digest: String,
    managed_owner_revision: u64,
    host_owner_epoch: u64,
    host_process_incarnation: String,
    no_process_observation_digest: String,
    attempt_digest: Option<String>,
    binding_digest: Option<String>,
    proof_digest: String,
}

/// Durable P8 receipt for a cross-owner pre-admission reconciliation. This
/// certifies only the exact EXPIRED worker lease and its OwnerLog event; P2
/// must still validate the matching Task tombstone and generation transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreAdmissionReconciliationReceiptV1 {
    disposition: ManagedReservationReconciliationDispositionV1,
    worker_execution_id: String,
    ticket_id: String,
    attempt_id: String,
    pins_digest: String,
    terminal_state: crate::resource_budget::ReservationState,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    reconciliation_proof_digest: String,
    receipt_digest: String,
}

impl PreAdmissionReconciliationReceiptV1 {
    fn from_committed_event(
        proof: &ManagedReservationReconciliationProofV1,
        cursor: &CursorV1,
        worker_pool_revision: u64,
    ) -> Self {
        let mut value = Self {
            disposition: proof.disposition(),
            worker_execution_id: proof.worker_execution_id().to_owned(),
            ticket_id: proof.ticket_id().to_owned(),
            attempt_id: proof.attempt_id().to_owned(),
            pins_digest: proof.pins_digest().to_owned(),
            terminal_state: crate::resource_budget::ReservationState::Expired,
            owner_log_id: cursor.owner_id.clone(),
            owner_log_sequence: cursor.seq.clone(),
            owner_log_event_digest: cursor.event_digest.clone(),
            worker_pool_revision,
            reconciliation_proof_digest: proof.proof_digest().to_owned(),
            receipt_digest: String::new(),
        };
        value.receipt_digest = value.compute_digest();
        value
    }

    fn compute_digest(&self) -> String {
        let mut bytes = b"horizoncode.pre-admission-reconciliation-receipt.v1\0".to_vec();
        for value in [self.worker_execution_id.as_str(), self.ticket_id.as_str(),
            self.attempt_id.as_str(), self.pins_digest.as_str(), self.owner_log_id.as_str(),
            self.owner_log_sequence.as_str(), self.owner_log_event_digest.as_str(),
            self.reconciliation_proof_digest.as_str(), "EXPIRED"] {
            bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes.push(match self.disposition {
            ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch => 1,
            ManagedReservationReconciliationDispositionV1::TerminalNoEffect => 2,
        });
        bytes.extend_from_slice(&self.worker_pool_revision.to_be_bytes());
        format!("blake3:{}", blake3::hash(&bytes).to_hex())
    }

    pub(crate) fn disposition(&self) -> ManagedReservationReconciliationDispositionV1 { self.disposition }
    pub(crate) fn worker_execution_id(&self) -> &str { &self.worker_execution_id }
    pub(crate) fn ticket_id(&self) -> &str { &self.ticket_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn pins_digest(&self) -> &str { &self.pins_digest }
    pub(crate) fn terminal_state(&self) -> crate::resource_budget::ReservationState { self.terminal_state }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn reconciliation_proof_digest(&self) -> &str { &self.reconciliation_proof_digest }
    pub(crate) fn receipt_digest(&self) -> &str { &self.receipt_digest }
}

impl ManagedReservationReconciliationProofV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_authenticated_host(
        worker_execution_id: String,
        ticket_id: String,
        attempt_id: String,
        pins_digest: String,
        disposition: ManagedReservationReconciliationDispositionV1,
        managed_owner_log_id: String,
        managed_owner_log_sequence: String,
        managed_owner_log_event_digest: String,
        managed_owner_revision: u64,
        host_owner_epoch: u64,
        host_process_incarnation: String,
        no_process_observation_digest: String,
        attempt_digest: Option<String>,
        binding_digest: Option<String>,
    ) -> Result<Self, WorkerDurableError> {
        let mut proof = Self { worker_execution_id, ticket_id, attempt_id, pins_digest,
            disposition, managed_owner_log_id, managed_owner_log_sequence,
            managed_owner_log_event_digest, managed_owner_revision, host_owner_epoch,
            host_process_incarnation, no_process_observation_digest, attempt_digest,
            binding_digest, proof_digest: String::new() };
        proof.validate()?;
        proof.proof_digest = proof.compute_digest();
        Ok(proof)
    }

    fn validate(&self) -> Result<(), WorkerDurableError> {
        for value in [&self.worker_execution_id, &self.ticket_id, &self.attempt_id,
            &self.managed_owner_log_id, &self.host_process_incarnation] {
            validate_owner_token(value)?;
        }
        for value in [&self.pins_digest, &self.managed_owner_log_event_digest,
            &self.no_process_observation_digest] {
            validate_owner_digest(value, "blake3:")?;
        }
        if self.managed_owner_log_sequence.parse::<u64>().is_err()
            || self.managed_owner_revision == 0 || self.host_owner_epoch == 0
        {
            return Err(WorkerDurableError::Invalid("invalid managed reconciliation watermark"));
        }
        match self.disposition {
            ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch
                if self.attempt_digest.is_none() && self.binding_digest.is_none() => {}
            ManagedReservationReconciliationDispositionV1::TerminalNoEffect
                if self.attempt_digest.as_deref().is_some_and(|d| validate_owner_digest(d, "blake3:").is_ok())
                    && self.binding_digest.as_deref().is_some_and(|d| validate_owner_digest(d, "blake3:").is_ok()) => {}
            _ => return Err(WorkerDurableError::Invalid("managed reconciliation disposition evidence mismatch")),
        }
        if !self.proof_digest.is_empty() && self.proof_digest != self.compute_digest() {
            return Err(WorkerDurableError::Conflict("managed reconciliation proof digest mismatch"));
        }
        Ok(())
    }

    fn compute_digest(&self) -> String {
        let mut bytes = b"horizoncode.managed-reservation-reconciliation.v1\0".to_vec();
        for value in [self.worker_execution_id.as_str(), self.ticket_id.as_str(), self.attempt_id.as_str(),
            self.pins_digest.as_str(), self.managed_owner_log_id.as_str(), self.managed_owner_log_sequence.as_str(),
            self.managed_owner_log_event_digest.as_str(), self.host_process_incarnation.as_str(),
            self.no_process_observation_digest.as_str(), self.attempt_digest.as_deref().unwrap_or(""),
            self.binding_digest.as_deref().unwrap_or("")] {
            bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes.push(match self.disposition {
            ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch => 1,
            ManagedReservationReconciliationDispositionV1::TerminalNoEffect => 2,
        });
        bytes.extend_from_slice(&self.managed_owner_revision.to_be_bytes());
        bytes.extend_from_slice(&self.host_owner_epoch.to_be_bytes());
        format!("blake3:{}", blake3::hash(&bytes).to_hex())
    }

    pub(crate) fn worker_execution_id(&self) -> &str { &self.worker_execution_id }
    pub(crate) fn ticket_id(&self) -> &str { &self.ticket_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn pins_digest(&self) -> &str { &self.pins_digest }
    pub(crate) fn disposition(&self) -> ManagedReservationReconciliationDispositionV1 { self.disposition }
    pub(crate) fn managed_owner_log_id(&self) -> &str { &self.managed_owner_log_id }
    pub(crate) fn managed_owner_log_sequence(&self) -> &str { &self.managed_owner_log_sequence }
    pub(crate) fn managed_owner_log_event_digest(&self) -> &str { &self.managed_owner_log_event_digest }
    pub(crate) fn managed_owner_revision(&self) -> u64 { self.managed_owner_revision }
    pub(crate) fn host_owner_epoch(&self) -> u64 { self.host_owner_epoch }
    pub(crate) fn host_process_incarnation(&self) -> &str { &self.host_process_incarnation }
    pub(crate) fn no_process_observation_digest(&self) -> &str { &self.no_process_observation_digest }
    pub(crate) fn attempt_digest(&self) -> Option<&str> { self.attempt_digest.as_deref() }
    pub(crate) fn binding_digest(&self) -> Option<&str> { self.binding_digest.as_deref() }
    pub(crate) fn proof_digest(&self) -> &str { &self.proof_digest }
}

/// A logical attachment to the existing Core process. This is not an isolated
/// worker, resource reservation, process launch or independent transcript owner.
/// P1 must observe the OS peer identity itself before registering/resolving it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RootCoordinatorExecutionV1 {
    worker_execution_id: String,
    goal_id: String,
    run_id: String,
    principal_ref: String,
    workspace_binding: String,
    session_id: String,
    location_id: String,
    owner_epoch: u64,
    process_incarnation: String,
    process_identity: ProcessIdentity,
    source_revision: String,
    accepted_spec_digest: String,
    expires_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RootCoordinatorExecutionProofV1 {
    execution: RootCoordinatorExecutionV1,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
}

/// Current authenticated Core owner authority restricted to read-only
/// reconciliation of one already-quarantined logical child. This deliberately
/// cannot be passed to admission, claim, dispatch, or ordinary worktree APIs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReadOnlyReconciliationRootProofV1 {
    execution: RootCoordinatorExecutionV1,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
}

impl ReadOnlyReconciliationRootProofV1 {
    pub(crate) fn worker_execution_id(&self) -> &str { &self.execution.worker_execution_id }
    pub(crate) fn goal_id(&self) -> &str { &self.execution.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.execution.run_id }
    pub(crate) fn principal_ref(&self) -> &str { &self.execution.principal_ref }
    pub(crate) fn workspace_binding(&self) -> &str { &self.execution.workspace_binding }
    pub(crate) fn session_id(&self) -> &str { &self.execution.session_id }
    pub(crate) fn location_id(&self) -> &str { &self.execution.location_id }
    pub(crate) fn owner_epoch(&self) -> u64 { self.execution.owner_epoch }
    pub(crate) fn process_incarnation(&self) -> &str { &self.execution.process_incarnation }
    pub(crate) fn process_identity(&self) -> &ProcessIdentity { &self.execution.process_identity }
    pub(crate) fn source_revision(&self) -> &str { &self.execution.source_revision }
    pub(crate) fn accepted_spec_digest(&self) -> &str { &self.execution.accepted_spec_digest }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn expires_at_ms(&self) -> u64 { self.execution.expires_at_ms }
}

impl RootCoordinatorExecutionProofV1 {
    pub(crate) fn worker_execution_id(&self) -> &str { &self.execution.worker_execution_id }
    pub(crate) fn goal_id(&self) -> &str { &self.execution.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.execution.run_id }
    pub(crate) fn principal_ref(&self) -> &str { &self.execution.principal_ref }
    pub(crate) fn workspace_binding(&self) -> &str { &self.execution.workspace_binding }
    pub(crate) fn session_id(&self) -> &str { &self.execution.session_id }
    pub(crate) fn location_id(&self) -> &str { &self.execution.location_id }
    pub(crate) fn owner_epoch(&self) -> u64 { self.execution.owner_epoch }
    pub(crate) fn process_incarnation(&self) -> &str { &self.execution.process_incarnation }
    pub(crate) fn process_identity(&self) -> &ProcessIdentity { &self.execution.process_identity }
    pub(crate) fn source_revision(&self) -> &str { &self.execution.source_revision }
    pub(crate) fn accepted_spec_digest(&self) -> &str { &self.execution.accepted_spec_digest }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn expires_at_ms(&self) -> u64 { self.execution.expires_at_ms }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BoundWorkerDelegationV1 {
    binding_digest: String,
    parent_execution_id: String,
    /// HostKernel-measured child Location/workspace and revision. Older journal
    /// records omit this pin and remain replayable, but cannot authorize a new
    /// managed Attempt dispatch or settlement.
    worktree_admission: Option<ManagedWorktreeAdmissionPinV1>,
}

impl BoundWorkerDelegationV1 {
    fn child_workspace_revision(&self) -> Result<&str, WorkerDurableError> {
        self.worktree_admission.as_ref().map(|pin| pin.child_workspace_revision.as_str())
            .ok_or(WorkerDurableError::Conflict("managed binding has no HostKernel child worktree pin"))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManagedWorktreeAdmissionPinV1 {
    worktree_id: String,
    base_revision: String,
    pool_revision: u64,
    root_location_id: String,
    p8_workspace_binding: String,
    child_location_id: String,
    child_workspace_id: String,
    child_workspace_ref: String,
    child_canonical_root: String,
    child_workspace_revision: String,
}

impl ManagedWorktreeAdmissionPinV1 {
    fn from_hostkernel(
        projection: &crate::managed_control::ManagedWorktreeAdmissionProjectionV1,
    ) -> Result<Self, WorkerDurableError> {
        let pin = Self {
            worktree_id: projection.worktree_id().to_owned(),
            base_revision: projection.base_revision().to_owned(),
            pool_revision: projection.pool_revision(),
            root_location_id: projection.root_location_id().to_owned(),
            p8_workspace_binding: projection.p8_workspace_binding().to_owned(),
            child_location_id: projection.location_id().to_owned(),
            child_workspace_id: projection.workspace_id().to_owned(),
            child_workspace_ref: projection.workspace_ref().to_owned(),
            child_canonical_root: projection.canonical_root().to_owned(),
            child_workspace_revision: projection.workspace_revision().to_owned(),
        };
        pin.validate()?;
        Ok(pin)
    }

    fn validate(&self) -> Result<(), WorkerDurableError> {
        for value in [&self.worktree_id, &self.base_revision, &self.root_location_id,
            &self.p8_workspace_binding, &self.child_location_id, &self.child_workspace_id,
            &self.child_workspace_ref] {
            validate_owner_token(value)?;
        }
        validate_owner_digest(&self.child_workspace_revision, "blake3:")?;
        if self.pool_revision == 0 || self.root_location_id == self.child_location_id
            || self.child_canonical_root.is_empty() || self.child_canonical_root.len() > 4096
            || self.child_canonical_root.chars().any(char::is_control)
            || !std::path::Path::new(&self.child_canonical_root).is_absolute()
        {
            return Err(WorkerDurableError::Invalid("invalid HostKernel managed worktree admission projection"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default)]
struct WorkerIdentityJournalV1 {
    pre_admission_pins: BTreeMap<String, TrustedPreAdmissionPinsV1>,
    admission_pins: BTreeMap<String, WorkerAdmissionPinsV1>,
    delegation_bindings: BTreeMap<String, BoundWorkerDelegationV1>,
    root_coordinators: BTreeMap<String, RootCoordinatorExecutionV1>,
    reconciliation_root_ids: BTreeMap<String, (String, String)>,
    claim_receipts: BTreeMap<String, WorkerClaimReceiptV1>,
    verified_worktree_registrations: BTreeMap<String, String>,
    worktree_registration_records: BTreeMap<String, VerifiedWorktreeRegistrationV1>,
    removed_worktree_registrations: BTreeMap<String, String>,
}

/// Reconstructed from the exact durable `worker_claimed` event. Keeping its
/// cursor makes a lost managed-dispatch response replayable even if unrelated
/// P8 events advance the current OwnerLog afterward.
#[derive(Clone, Debug, Eq, PartialEq)]
struct WorkerClaimReceiptV1 {
    ticket_id: String,
    attempt_id: String,
    pins_digest: String,
    binding_digest: String,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
}

/// Opaque P8 owner proof resolved from the currently replayed worker OwnerLog.
/// It certifies only that the referenced budget/worktree leases are current in
/// that durable owner stream and match one authenticated Attempt binding. It
/// never certifies filesystem currentness, Guard permission or process
/// confinement; HostKernel must re-resolve those independently immediately
/// before dispatch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DurableManagedLeaseProofV1 {
    facts: crate::worker_pool::DurableWorkerLeaseFactsV1,
    purpose: DurableManagedLeaseProofPurposeV1,
    pre_admission_pins: Option<TrustedPreAdmissionPinsV1>,
    admission_pins: Option<WorkerAdmissionPinsV1>,
    delegation: Option<BoundWorkerDelegationV1>,
    owner_log_id: String,
    worker_pool_revision: u64,
    owner_log_sequence: String,
    owner_log_event_digest: String,
}

/// Distinguishes the one pre-admission projection accepted only by the atomic
/// Attempt+DelegationBinding reducer from the attached lease proof required by
/// claim, dispatch and effect paths.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DurableManagedLeaseProofPurposeV1 {
    PreAdmissionReserved,
    AttachedAttempt,
    LegacyAdmitted,
}

/// Opaque parent execution identity resolved from an active claimed worker
/// record in the replayed P8 OwnerLog. This is lineage only; P1 still performs
/// current HostKernel principal, Attempt, Guard and workspace checks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DurableParentExecutionProofV1 {
    worker_execution_id: String,
    goal_id: String,
    owner: OwnerScopeKey,
    source_revision: String,
    accepted_spec_digest: String,
    process_identity: ProcessIdentity,
    owner_log_id: String,
    worker_pool_revision: u64,
    owner_log_sequence: String,
    owner_log_event_digest: String,
}

impl DurableParentExecutionProofV1 {
    pub(crate) fn worker_execution_id(&self) -> &str {
        &self.worker_execution_id
    }
    pub(crate) fn goal_id(&self) -> &str {
        &self.goal_id
    }
    pub(crate) fn owner(&self) -> &OwnerScopeKey {
        &self.owner
    }
    pub(crate) fn principal_ref(&self) -> &str {
        &self.owner.principal_ref
    }
    pub(crate) fn workspace_binding(&self) -> &str {
        &self.owner.workspace_binding
    }
    pub(crate) fn session_id(&self) -> &str {
        &self.owner.session_id
    }
    pub(crate) fn run_id(&self) -> &str {
        &self.owner.run_id
    }
    pub(crate) fn task_id(&self) -> &str {
        &self.owner.task_id
    }
    pub(crate) fn attempt_id(&self) -> &str {
        &self.owner.attempt_id
    }
    pub(crate) fn owner_epoch(&self) -> u64 {
        self.owner.owner_epoch
    }
    pub(crate) fn source_revision(&self) -> &str {
        &self.source_revision
    }
    pub(crate) fn accepted_spec_digest(&self) -> &str {
        &self.accepted_spec_digest
    }
    pub(crate) fn process_identity(&self) -> &ProcessIdentity {
        &self.process_identity
    }
    pub(crate) fn owner_log_id(&self) -> &str {
        &self.owner_log_id
    }
    pub(crate) fn worker_pool_revision(&self) -> u64 {
        self.worker_pool_revision
    }
    pub(crate) fn owner_log_sequence(&self) -> &str {
        &self.owner_log_sequence
    }
    pub(crate) fn owner_log_event_digest(&self) -> &str {
        &self.owner_log_event_digest
    }

    pub(crate) fn child_lineage(&self) -> Result<ParentExecutionLineageV1, WorkerDurableError> {
        Ok(ParentExecutionLineageV1::from_owner_log_facts(
            self.worker_execution_id.clone(),
            self.goal_id.clone(),
            self.owner.clone(),
            self.source_revision.clone(),
            self.accepted_spec_digest.clone(),
            self.owner_log_id.clone(),
            self.owner_log_sequence.clone(),
            self.owner_log_event_digest.clone(),
            self.worker_pool_revision,
            self.process_identity.clone(),
        )?)
    }
}

impl DurableManagedLeaseProofV1 {
    pub(crate) fn purpose(&self) -> DurableManagedLeaseProofPurposeV1 { self.purpose }
    pub(crate) fn location_id(&self) -> Option<&str> { self.admission_pins.as_ref().map(|p| p.location_id.as_str()).or_else(|| self.pre_admission_pins.as_ref().map(|p| p.location_id.as_str())) }
    pub(crate) fn process_incarnation(&self) -> Option<&str> { self.admission_pins.as_ref().map(|p| p.process_incarnation.as_str()).or_else(|| self.pre_admission_pins.as_ref().map(|p| p.process_incarnation.as_str())) }
    pub(crate) fn profile_id(&self) -> Option<&str> { self.admission_pins.as_ref().map(|p| p.profile_id.as_str()).or_else(|| self.pre_admission_pins.as_ref().map(|p| p.profile_id.as_str())) }
    pub(crate) fn profile_revision(&self) -> Option<u64> { self.admission_pins.as_ref().map(|p| p.profile_revision).or_else(|| self.pre_admission_pins.as_ref().map(|p| p.profile_revision)) }
    pub(crate) fn profile_digest(&self) -> Option<&str> { self.admission_pins.as_ref().map(|p| p.profile_digest.as_str()).or_else(|| self.pre_admission_pins.as_ref().map(|p| p.profile_digest.as_str())) }
    pub(crate) fn context_selection_digest(&self) -> Option<&str> {
        self.admission_pins.as_ref().map(|p| p.context_selection_digest.as_str())
            .or_else(|| self.pre_admission_pins.as_ref().and_then(|p| p.context_selection_digest.as_deref()))
    }
    pub(crate) fn accepted_scope_digest(&self) -> Option<&str> { self.admission_pins.as_ref().map(|p| p.accepted_scope_digest.as_str()).or_else(|| self.pre_admission_pins.as_ref().map(|p| p.accepted_scope_digest.as_str())) }
    pub(crate) fn capability_ceiling_digest(&self) -> Option<&str> { self.admission_pins.as_ref().map(|p| p.capability_ceiling_digest.as_str()).or_else(|| self.pre_admission_pins.as_ref().map(|p| p.capability_ceiling_digest.as_str())) }
    pub(crate) fn delegation_binding_digest(&self) -> Option<&str> { self.delegation.as_ref().map(|p| p.binding_digest.as_str()) }
    pub(crate) fn pre_admission_pins(&self) -> Option<&TrustedPreAdmissionPinsV1> { self.pre_admission_pins.as_ref() }
    pub(crate) fn parent_execution_id(&self) -> Option<&str> { self.delegation.as_ref().map(|p| p.parent_execution_id.as_str()) }

    #[cfg(test)]
    pub(crate) fn test_fixture(
        owner: &AuthenticatedOwnerContext,
        binding: &VerifiedAttemptBinding,
        worker_execution_id: &str,
        goal_id: &str,
        ticket_id: &str,
        workspace_lease_id: &str,
        budget_lease_id: &str,
        resource_lease_ids: Vec<String>,
        worker_pool_revision: u64,
    ) -> Self {
        Self {
            purpose: DurableManagedLeaseProofPurposeV1::LegacyAdmitted,
            facts: crate::worker_pool::DurableWorkerLeaseFactsV1::test_fixture(
                owner,
                binding,
                worker_execution_id,
                goal_id,
                ticket_id,
                workspace_lease_id,
                budget_lease_id,
                resource_lease_ids,
            ),
            admission_pins: None,
            pre_admission_pins: None,
            delegation: None,
            owner_log_id: "worker-test-pool".to_owned(),
            worker_pool_revision,
            owner_log_sequence: "1".to_owned(),
            owner_log_event_digest: format!("blake3:{}", "0".repeat(64)),
        }
    }

    pub(crate) fn worker_execution_id(&self) -> &str {
        self.facts.worker_execution_id()
    }
    pub(crate) fn goal_id(&self) -> &str {
        self.facts.goal_id()
    }
    pub(crate) fn ticket_id(&self) -> &str {
        self.facts.ticket_id()
    }
    pub(crate) fn principal_ref(&self) -> &str {
        self.facts.principal_ref()
    }
    pub(crate) fn workspace_binding(&self) -> &str {
        self.facts.workspace_binding()
    }
    pub(crate) fn session_id(&self) -> &str {
        self.facts.session_id()
    }
    pub(crate) fn run_id(&self) -> &str {
        self.facts.run_id()
    }
    pub(crate) fn task_id(&self) -> &str {
        self.facts.task_id()
    }
    pub(crate) fn attempt_id(&self) -> &str {
        self.facts.attempt_id()
    }
    pub(crate) fn owner_epoch(&self) -> u64 {
        self.facts.owner_epoch()
    }
    pub(crate) fn source_revision(&self) -> &str {
        self.facts.source_revision()
    }
    pub(crate) fn accepted_spec_digest(&self) -> &str {
        self.facts.accepted_spec_digest()
    }
    pub(crate) fn workspace_lease_id(&self) -> &str {
        self.facts.workspace_lease_id()
    }
    pub(crate) fn budget_lease_id(&self) -> &str {
        self.facts.budget_lease_id()
    }
    pub(crate) fn resource_lease_ids(&self) -> &[String] {
        self.facts.resource_lease_ids()
    }
    pub(crate) fn worker_state(&self) -> crate::resource_budget::ReservationState {
        self.facts.worker_state()
    }
    pub(crate) fn budget_dimension(&self) -> BudgetDimension {
        self.facts.budget_dimension()
    }
    pub(crate) fn reserved_amount(&self) -> u64 {
        self.facts.reserved_amount()
    }
    pub(crate) fn expires_at_ms(&self) -> u64 {
        self.facts.expires_at_ms()
    }
    pub(crate) fn process_identity(&self) -> Option<&ProcessIdentity> {
        self.facts.process_identity()
    }
    pub(crate) fn owner_log_id(&self) -> &str {
        &self.owner_log_id
    }
    pub(crate) fn worker_pool_revision(&self) -> u64 {
        self.worker_pool_revision
    }
    pub(crate) fn owner_log_sequence(&self) -> &str {
        &self.owner_log_sequence
    }
    pub(crate) fn owner_log_event_digest(&self) -> &str {
        &self.owner_log_event_digest
    }
}

/// One durable worker-pool command. Only trusted ingress code may construct
/// and apply these; every command is validated by the pool state machine again.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedFinalInspectCandidatePinV1 {
    operation_id: String,
    candidate_digest: String,
    attempt_id: String,
    binding_digest: String,
    spec_id: String,
    spec_digest: String,
    evidence_digest: String,
    final_revision: String,
    verification_run_id: Option<String>,
    set_identity_digest: Option<String>,
    challenge_set_digest: Option<String>,
}

fn managed_final_inspect_candidate_digest(
    attempt_id: &str, goal_id: &str, run_id: &str, task_id: &str,
    binding_digest: &str, spec_id: &str, spec_digest: &str, evidence_digest: &str,
    final_revision: &str, effect_chain_digest: &str, attempt_state_digest: &str,
    owner_log_id: &str, owner_log_sequence: u64, owner_log_event_digest: &str,
    managed_revision: u64,
    usage_accounting: &crate::managed_control::ManagedAttemptUsageSummaryV1,
    verifier_pins: &crate::host_kernel::SettledVerifierChallengeSetPinsV1,
) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"horizoncode.managed-final-inspect-candidate.v3\0");
    for value in [attempt_id, goal_id, run_id, task_id, binding_digest, spec_id,
        spec_digest, evidence_digest, final_revision, effect_chain_digest,
        attempt_state_digest, owner_log_id, owner_log_event_digest,
        verifier_pins.verification_run_id(), verifier_pins.set_identity_digest(),
        verifier_pins.challenge_set_digest()] {
        append_digest_field(&mut h, value);
    }
    h.update(&owner_log_sequence.to_be_bytes());
    h.update(&managed_revision.to_be_bytes());
    append_usage_summary_to_digest(&mut h, Some(usage_accounting));
    format!("blake3:{}", h.finalize().to_hex())
}

fn validate_final_inspect_verifier_pins(
    candidate: &crate::managed_control::ManagedAttemptSettlementCandidateV1,
    verifier_pins: &crate::host_kernel::SettledVerifierChallengeSetPinsV1,
) -> Result<(), WorkerDurableError> {
    if verifier_pins.goal_id() != candidate.goal_id()
        || verifier_pins.run_id() != candidate.run_id()
        || verifier_pins.task_id() != candidate.task_id()
        || verifier_pins.attempt_id() != candidate.attempt_id()
        || verifier_pins.evidence_digest() != candidate.evidence_digest()
        || validate_owner_token(verifier_pins.verification_run_id()).is_err()
        || !valid_digest(verifier_pins.set_identity_digest(), "blake3:")
        || !valid_digest(verifier_pins.challenge_set_digest(), "blake3:")
    {
        return Err(WorkerDurableError::Conflict(
            "settled verifier pins differ from the final Inspect candidate",
        ));
    }
    Ok(())
}

/// A successful managed Attempt may settle only against an attributable final
/// workspace observation. A dirty result is acceptable when all dirty entries
/// are owned by the Attempt; user-owned or unattributed changes keep the
/// result from becoming a successful settlement proof.
fn final_inspect_allows_verified_settlement(receipt: &GuardedWorktreeReceiptV1) -> bool {
    matches!(
        receipt.status(),
        WorktreeObservedStatusV1::Clean | WorktreeObservedStatusV1::DirtyOwned
    ) && !receipt.contains_user_owned_changes()
        && receipt.owned()
        && receipt.no_follow()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerCommand {
    /// Atomically creates the queue record, RESERVED budget/worktree leases,
    /// and immutable pre-admission pins from one authenticated READY Task.
    PreAdmissionReserved {
        pins: TrustedPreAdmissionPinsV1,
        request: EnqueueRequest,
        ticket_id: String,
        worker_execution_id: String,
        now_ms: u64,
    },
    /// Binds the compiled ContextSelection to the same still-RESERVED Stage-A
    /// candidate. Only this event makes a staged reservation admissible.
    PreAdmissionContextBound {
        worker_execution_id: String,
        ticket_id: String,
        pins: TrustedPreAdmissionPinsV1,
    },
    /// Releases only a pinned pre-admission lease with P1's durable
    /// cross-owner proof that no dispatched effect or process can exist.
    PreAdmissionReconciled {
        proof: ManagedReservationReconciliationProofV1,
    },
    AdmissionPinsRecorded { worker_execution_id: String, pins: WorkerAdmissionPinsV1 },
    DelegationBound { worker_execution_id: String, binding: BoundWorkerDelegationV1 },
    RootCoordinatorRegistered { execution: RootCoordinatorExecutionV1 },
    /// Reauthorizes an existing root identity for terminal read-only recovery.
    /// Immutable Goal/Run/Session/Location/spec lineage is checked on replay.
    RootCoordinatorReauthorized {
        attempt_id: String,
        quarantine_receipt_digest: String,
        prior_execution_digest: String,
        execution: RootCoordinatorExecutionV1,
    },
    /// First command of the stream; binds the pool's durable owner epoch.
    PoolOpened {
        owner_epoch: u64,
        max_live_workers: usize,
        max_queued_tickets: usize,
        max_worktrees: usize,
    },
    /// New-incarnation fence: quarantines old-epoch capacity-holding workers,
    /// expires provably unlaunched timed-out reservations and fences old-epoch
    /// queued tickets.
    EpochAdvanced {
        from: u64,
        to: u64,
        now_ms: u64,
        retain_reserved: Vec<String>,
    },
    /// Durable evidence of the conservative crash-recovery fence (quarantine
    /// unsettled workers, expire timed-out unlaunched reservations, fence
    /// queued tickets). Written by `open` when recovery changes state so replay
    /// reproduces the same history before later settlement commands.
    RecoveredFence {
        now_ms: u64,
        retain_reserved: Vec<String>,
    },
    RegisterWorktree {
        owner: WorktreeRootOwnerV1,
        registration: VerifiedWorktreeRegistrationV1,
    },
    /// Historical caller-scoped registrations remain replayable and occupy
    /// their old IDs, but they are never admission-eligible.
    LegacyRegisterWorktree {
        scope: OwnerScopeKey,
        registration: WorktreeRegistration,
    },
    WorktreeRegistrationRemoved {
        owner: WorktreeRootOwnerV1,
        operation_id: String,
        worktree_id: String,
    },
    WorktreeOperationRetiredNoDispatch {
        current_owner: WorktreeRootOwnerV1,
        operation_id: String,
        intent_digest: String,
    },
    Enqueue {
        scope: OwnerScopeKey,
        request: EnqueueRequest,
    },
    Reserve {
        scope: OwnerScopeKey,
        ticket_id: String,
        worker_execution_id: String,
        binding: VerifiedAttemptBinding,
        now_ms: u64,
    },
    ClaimWorker {
        scope: OwnerScopeKey,
        worker_execution_id: String,
    },
    AttachCoreClient {
        scope: OwnerScopeKey,
        worker_execution_id: String,
        session_link_ref: String,
        reuse_key: WorkerReuseKey,
    },
    BindProcess {
        scope: OwnerScopeKey,
        worker_execution_id: String,
        process_identity: ProcessIdentity,
    },
    SettleWorker {
        scope: OwnerScopeKey,
        worker_execution_id: String,
        settlement: WorkerSettlement,
    },
    QuarantineWorker {
        scope: OwnerScopeKey,
        worker_execution_id: String,
    },
    ExpireUnlaunched {
        scope: OwnerScopeKey,
        worker_execution_id: String,
        now_ms: u64,
        proof: ReservationProof,
    },
    ReconcileRelease {
        scope: OwnerScopeKey,
        worker_execution_id: String,
        proof: ReconciliationProof,
    },
    /// Terminal settlement for a logical Core child. This event deliberately
    /// carries no PID or process-exit boolean; it is emitted only after the
    /// opaque HostKernel proof is revalidated by WorkerPoolControl.
    ManagedLogicalSettled { event: ManagedLogicalSettlementEventV1 },
    /// Final workspace disposition is independently replayable from logical
    /// reservation settlement. It is emitted only after the exact final Inspect
    /// receipt and the durable settlement receipt have both been re-resolved.
    ManagedWorktreeDisposition { event: ManagedWorktreeDispositionEventV1 },
    /// Quarantine-only terminal record. It retains ActiveWorkers and the
    /// worktree lease; it is not a success settlement or release proof.
    ManagedTerminalQuarantined { event: ManagedTerminalQuarantineEventV1 },
    CancelScope {
        scope: OwnerScopeKey,
        cancel: CancelScope,
        now_ms: u64,
    },
    WorktreeOperationDispatchStarted { operation_id: String },
    WorktreeOperationIntent {
        intent: WorktreeOperationIntentV1,
    },
    /// Durable binding from a final Inspect operation to the exact P2 settlement
    /// candidate and the HostKernel-validated settled verifier identity. Legacy
    /// entries without verifier fields remain readable for history only.
    ManagedFinalInspectCandidatePinned { pin: ManagedFinalInspectCandidatePinV1 },
    WorktreeOperationReceipt {
        receipt: GuardedWorktreeReceiptV1,
    },
    /// Durable audit record for PSS attribution. On replay it is retained as
    /// evidence but never subtracts current reserved headroom: OS samples are
    /// ephemeral and admission stays conservative until a fresh sample arrives.
    MemoryUsageObserved {
        scope: OwnerScopeKey,
        attribution: crate::resource_sampler::AttributedWorkerUsageV1,
    },
}

impl WorkerCommand {
    fn event(&self) -> (&'static str, Value) {
        match self {
            Self::PreAdmissionReserved { pins, request, ticket_id, worker_execution_id, now_ms } => (
                "worker_pre_admission_reserved",
                json!({
                    "pins": trusted_pre_admission_value(pins),
                    "request": enqueue_value(request),
                    "ticketId": ticket_id,
                    "workerExecutionId": worker_execution_id,
                    "nowMs": now_ms,
                }),
            ),
            Self::PreAdmissionContextBound { worker_execution_id, ticket_id, pins } => (
                "worker_pre_admission_context_bound",
                json!({"workerExecutionId": worker_execution_id, "ticketId": ticket_id,
                    "pins": trusted_pre_admission_value(pins)}),
            ),
            Self::PreAdmissionReconciled { proof } => (
                "worker_pre_admission_reconciled",
                managed_reservation_reconciliation_value(proof),
            ),
            Self::AdmissionPinsRecorded { worker_execution_id, pins } => (
                "worker_admission_pins_recorded", json!({"workerExecutionId": worker_execution_id, "pins": admission_pins_value(pins)}),
            ),
            Self::DelegationBound { worker_execution_id, binding } => (
                "worker_delegation_bound", json!({"workerExecutionId": worker_execution_id, "bindingDigest": binding.binding_digest, "parentExecutionId": binding.parent_execution_id, "worktreeAdmission": binding.worktree_admission.as_ref().map(managed_worktree_admission_pin_value)}),
            ),
            Self::RootCoordinatorRegistered { execution } => (
                "worker_root_coordinator_registered", root_coordinator_value(execution),
            ),
            Self::RootCoordinatorReauthorized { attempt_id, quarantine_receipt_digest, prior_execution_digest, execution } => (
                "worker_root_coordinator_reauthorized",
                json!({"attemptId": attempt_id, "quarantineReceiptDigest": quarantine_receipt_digest,
                    "priorExecutionDigest": prior_execution_digest, "execution": root_coordinator_value(execution)}),
            ),
            Self::PoolOpened {
                owner_epoch,
                max_live_workers,
                max_queued_tickets,
                max_worktrees,
            } => (
                "worker_pool_opened",
                json!({
                    "poolConfigVersion": 2,
                    "ownerEpoch": owner_epoch,
                    "maxLiveWorkers": max_live_workers,
                    "maxQueuedTickets": max_queued_tickets,
                    "maxWorktrees": max_worktrees,
                }),
            ),
            Self::EpochAdvanced { from, to, now_ms, retain_reserved } => (
                "worker_epoch_advanced",
                json!({"fromEpoch": from, "toEpoch": to, "nowMs": now_ms, "retainReserved": retain_reserved}),
            ),
            Self::RecoveredFence { now_ms, retain_reserved } => ("worker_recovered_fence", json!({"nowMs": now_ms, "retainReserved": retain_reserved})),
            Self::RegisterWorktree {
                owner,
                registration,
            } => (
                "worker_worktree_registered",
                json!({"owner": worktree_root_owner_value(owner), "registration": registration_value(registration.registration()),
                    "verificationDigest": registration.verification_digest(),
                    "provenance": registration.provenance().map(|p| json!({
                        "createOperationId": p.create_operation_id(),
                        "createReceiptRef": p.create_receipt_ref(),
                        "inspectOperationId": p.inspect_operation_id(),
                        "inspectReceiptRef": p.inspect_receipt_ref(),
                    }))}),
            ),
            Self::LegacyRegisterWorktree { scope, registration } => (
                "worker_worktree_registered",
                json!({"scope": scope_value(scope), "registration": registration_value(registration)}),
            ),
            Self::WorktreeRegistrationRemoved { owner, operation_id, worktree_id } => (
                "worker_worktree_registration_removed",
                json!({"owner": worktree_root_owner_value(owner), "operationId": operation_id,
                    "worktreeId": worktree_id}),
            ),
            Self::WorktreeOperationRetiredNoDispatch { current_owner, operation_id, intent_digest } => (
                "worker_worktree_retired_no_dispatch",
                json!({"currentOwner": worktree_root_owner_value(current_owner),
                    "operationId": operation_id, "intentDigest": intent_digest}),
            ),
            Self::Enqueue { scope, request } => (
                "worker_task_enqueued",
                json!({"scope": scope_value(scope), "request": enqueue_value(request)}),
            ),
            Self::Reserve {
                scope,
                ticket_id,
                worker_execution_id,
                binding,
                now_ms,
            } => (
                "worker_reserved",
                json!({
                    "scope": scope_value(scope),
                    "ticketId": ticket_id,
                    "workerExecutionId": worker_execution_id,
                    "binding": binding_value(binding),
                    "nowMs": now_ms,
                }),
            ),
            Self::ClaimWorker {
                scope,
                worker_execution_id,
            } => (
                "worker_claimed",
                json!({"scope": scope_value(scope), "workerExecutionId": worker_execution_id}),
            ),
            Self::AttachCoreClient {
                scope,
                worker_execution_id,
                session_link_ref,
                reuse_key,
            } => (
                "worker_core_client_attached",
                json!({
                    "scope": scope_value(scope),
                    "workerExecutionId": worker_execution_id,
                    "sessionLinkRef": session_link_ref,
                    "reuseKey": reuse_key_value(reuse_key),
                }),
            ),
            Self::BindProcess {
                scope,
                worker_execution_id,
                process_identity,
            } => (
                "worker_process_bound",
                json!({
                    "scope": scope_value(scope),
                    "workerExecutionId": worker_execution_id,
                    "processIdentity": process_identity_value(process_identity),
                }),
            ),
            Self::SettleWorker {
                scope,
                worker_execution_id,
                settlement,
            } => (
                "worker_settled",
                json!({
                    "scope": scope_value(scope),
                    "workerExecutionId": worker_execution_id,
                    "settlement": settlement_value(settlement),
                }),
            ),
            Self::QuarantineWorker {
                scope,
                worker_execution_id,
            } => (
                "worker_quarantined",
                json!({"scope": scope_value(scope), "workerExecutionId": worker_execution_id}),
            ),
            Self::ExpireUnlaunched {
                scope,
                worker_execution_id,
                now_ms,
                proof,
            } => (
                "worker_expired",
                json!({
                    "scope": scope_value(scope),
                    "workerExecutionId": worker_execution_id,
                    "nowMs": now_ms,
                    "proof": proof_value(proof),
                }),
            ),
            Self::ReconcileRelease {
                scope,
                worker_execution_id,
                proof,
            } => (
                "worker_reconciled",
                json!({
                    "scope": scope_value(scope),
                    "workerExecutionId": worker_execution_id,
                    "proof": reconciliation_value(proof),
                }),
            ),
            Self::ManagedLogicalSettled { event } => {
                let mut payload = json!({
                    "workerExecutionId": event.worker_execution_id,
                    "attemptId": event.attempt_id,
                    "proofDigest": event.proof_digest,
                    "observedWorkspaceRevision": event.observed_workspace_revision,
                    "finalWorktreeOperationId": event.final_worktree_operation_id,
                    "finalWorktreeHostReceiptRef": event.final_worktree_host_receipt_ref,
                    "evidenceDigest": event.evidence_digest,
                    "evidenceRefs": event.evidence_refs.iter().map(artifact_ref_value).collect::<Vec<_>>(),
                    "reusableWorktree": event.reusable_worktree,
                    "reconciliationOwnerEpoch": event.reconciliation_owner_epoch,
                    "dispositionDeferred": event.disposition_deferred,
                });
                if event.schema_version >= 4 {
                    payload["verificationRunID"] = event.verification_run_id.clone().map(Value::String).unwrap_or(Value::Null);
                    payload["setIdentityDigest"] = event.set_identity_digest.clone().map(Value::String).unwrap_or(Value::Null);
                    payload["challengeSetDigest"] = event.challenge_set_digest.clone().map(Value::String).unwrap_or(Value::Null);
                }
                ("worker_managed_logical_settled", payload)
            },
            Self::ManagedWorktreeDisposition { event } => (
                "worker_managed_worktree_disposition",
                json!({
                    "workerExecutionId": event.worker_execution_id,
                    "attemptId": event.attempt_id,
                    "ownerEpoch": event.owner_epoch,
                    "settlementReceiptDigest": event.settlement_receipt_digest,
                    "finalWorktreeOperationId": event.final_worktree_operation_id,
                    "finalWorktreeHostReceiptRef": event.final_worktree_host_receipt_ref,
                    "observedWorkspaceRevision": event.observed_workspace_revision,
                    "inspectReceiptDigest": event.inspect_receipt_digest,
                    "reusableWorktree": event.reusable_worktree,
                    "reconciliationOwnerEpoch": event.reconciliation_owner_epoch,
                    "reconciliationProofDigest": event.reconciliation_proof_digest,
                }),
            ),
            Self::ManagedTerminalQuarantined { event } => (
                "worker_managed_terminal_quarantined",
                json!({
                    "scope": scope_value(&event.scope),
                    "workerExecutionId": event.worker_execution_id,
                    "goalId": event.goal_id,
                    "runId": event.run_id,
                    "taskId": event.task_id,
                    "attemptId": event.attempt_id,
                    "ownerEpoch": event.owner_epoch,
                    "reservationId": event.reservation_id,
                    "worktreeLeaseId": event.worktree_lease_id,
                    "terminalProofDigest": event.terminal_proof_digest,
                    "reason": event.reason.wire_name(),
                }),
            ),
            Self::CancelScope {
                scope,
                cancel,
                now_ms,
            } => (
                "worker_scope_cancelled",
                json!({"scope": scope_value(scope), "cancel": cancel_value(cancel), "nowMs": now_ms}),
            ),
            Self::WorktreeOperationDispatchStarted { operation_id } => (
                "worker_worktree_dispatch_started", json!({"operationId": operation_id}),
            ),
            Self::WorktreeOperationIntent { intent } => (
                "worker_worktree_operation_intent",
                worktree_intent_value(intent),
            ),
            Self::ManagedFinalInspectCandidatePinned { pin } => (
                "worker_managed_final_inspect_candidate_pinned",
                if let (Some(verification_run_id), Some(set_identity_digest), Some(challenge_set_digest)) =
                    (&pin.verification_run_id, &pin.set_identity_digest, &pin.challenge_set_digest) {
                    json!({"operationId": pin.operation_id, "candidateDigest": pin.candidate_digest,
                        "attemptId": pin.attempt_id, "bindingDigest": pin.binding_digest,
                        "specId": pin.spec_id,
                        "specDigest": pin.spec_digest, "evidenceDigest": pin.evidence_digest,
                        "finalRevision": pin.final_revision, "verificationRunID": verification_run_id,
                        "setIdentityDigest": set_identity_digest, "challengeSetDigest": challenge_set_digest})
                } else {
                    json!({"operationId": pin.operation_id, "candidateDigest": pin.candidate_digest,
                        "attemptId": pin.attempt_id, "bindingDigest": pin.binding_digest,
                        "specId": pin.spec_id,
                        "specDigest": pin.spec_digest, "evidenceDigest": pin.evidence_digest,
                        "finalRevision": pin.final_revision})
                },
            ),
            Self::WorktreeOperationReceipt { receipt } => (
                "worker_worktree_operation_receipt",
                worktree_receipt_value(receipt),
            ),
            Self::MemoryUsageObserved { scope, attribution } => (
                "worker_memory_usage_observed",
                json!({
                    "scope": scope_value(scope),
                    "workerExecutionId": attribution.worker_execution_id(),
                    "taskId": attribution.task_id(),
                    "attemptId": attribution.attempt_id(),
                    "processIdentity": process_identity_value(attribution.process_identity()),
                    "units": attribution.units().to_string(),
                    "sampleSequence": attribution.sample_sequence().to_string(),
                    "ownerLogId": attribution.owner_log_id(),
                    "ownerLogSequence": attribution.owner_log_sequence(),
                    "ownerLogEventDigest": attribution.owner_log_event_digest(),
                    "workerPoolRevision": attribution.worker_pool_revision().to_string(),
                }),
            ),
        }
    }

    fn decode(
        kind: &str,
        payload: &Value,
        schema_version: u64,
    ) -> Result<Self, WorkerDurableError> {
        let count =
            payload
                .as_object()
                .map(|object| object.len())
                .ok_or(WorkerDurableError::Invalid(
                    "worker payload must be an object",
                ))?;
        match kind {
            "worker_pre_admission_reserved" if count == 5 => Ok(Self::PreAdmissionReserved {
                pins: decode_trusted_pre_admission(
                    payload.get("pins").ok_or(WorkerDurableError::Invalid("missing pre-admission pins"))?,
                )?,
                request: decode_enqueue(
                    payload.get("request").ok_or(WorkerDurableError::Invalid("missing pre-admission request"))?,
                )?,
                ticket_id: text(payload, "ticketId")?,
                worker_execution_id: text(payload, "workerExecutionId")?,
                now_ms: unsigned(payload, "nowMs")?,
            }),
            "worker_pre_admission_context_bound" if count == 3 => Ok(Self::PreAdmissionContextBound {
                worker_execution_id: text(payload, "workerExecutionId")?,
                ticket_id: text(payload, "ticketId")?,
                pins: decode_trusted_pre_admission(payload.get("pins").ok_or(
                    WorkerDurableError::Invalid("missing context-bound pre-admission pins"),
                )?)?,
            }),
            "worker_pre_admission_reconciled" if count == 1 => Ok(Self::PreAdmissionReconciled {
                proof: decode_managed_reservation_reconciliation(payload)?,
            }),
            "worker_admission_pins_recorded" if count == 2 => Ok(Self::AdmissionPinsRecorded {
                worker_execution_id: text(payload, "workerExecutionId")?,
                pins: decode_admission_pins(payload.get("pins").ok_or(WorkerDurableError::Invalid("missing admission pins"))?)?,
            }),
            "worker_delegation_bound" if count == 3 => {
                let binding_digest = text(payload, "bindingDigest")?;
                validate_owner_digest(&binding_digest, "blake3:")?;
                Ok(Self::DelegationBound {
                    worker_execution_id: text(payload, "workerExecutionId")?,
                    binding: BoundWorkerDelegationV1 { binding_digest, parent_execution_id: text(payload, "parentExecutionId")?, worktree_admission: None },
                })
            },
            "worker_delegation_bound" if count == 4 => {
                let binding_digest = text(payload, "bindingDigest")?;
                validate_owner_digest(&binding_digest, "blake3:")?;
                let worktree_admission = match payload.get("worktreeAdmission") {
                    Some(Value::Null) => None,
                    Some(value) => Some(decode_managed_worktree_admission_pin(value)?),
                    None => return Err(WorkerDurableError::Invalid("missing managed worktree admission pin")),
                };
                Ok(Self::DelegationBound {
                    worker_execution_id: text(payload, "workerExecutionId")?,
                    binding: BoundWorkerDelegationV1 { binding_digest, parent_execution_id: text(payload, "parentExecutionId")?, worktree_admission },
                })
            },
            "worker_root_coordinator_registered" if count == 13 => Ok(Self::RootCoordinatorRegistered {
                execution: decode_root_coordinator(payload)?,
            }),
            "worker_root_coordinator_reauthorized" if count == 4 => Ok(Self::RootCoordinatorReauthorized {
                attempt_id: text(payload, "attemptId")?,
                quarantine_receipt_digest: text(payload, "quarantineReceiptDigest")?,
                prior_execution_digest: text(payload, "priorExecutionDigest")?,
                execution: decode_root_coordinator(payload.get("execution")
                    .ok_or(WorkerDurableError::Invalid("missing reauthorized root execution"))?)?,
            }),
            "worker_pool_opened" if schema_version == 1 && count == 1 => Ok(Self::PoolOpened {
                owner_epoch: unsigned(payload, "ownerEpoch")?,
                // V1 persisted only the epoch; retain the exact original
                // default bounds when replaying that immutable history.
                max_live_workers: crate::worker_pool::MAX_LIVE_WORKERS,
                max_queued_tickets: crate::worker_pool::MAX_QUEUED_TICKETS,
                max_worktrees: crate::worker_pool::MAX_LIVE_WORKERS,
            }),
            "worker_pool_opened"
                if schema_version == 1
                    && count == 5
                    && unsigned(payload, "poolConfigVersion")? == 2 =>
            {
                Ok(Self::PoolOpened {
                    owner_epoch: unsigned(payload, "ownerEpoch")?,
                    max_live_workers: usize_value(payload, "maxLiveWorkers")?,
                    max_queued_tickets: usize_value(payload, "maxQueuedTickets")?,
                    max_worktrees: usize_value(payload, "maxWorktrees")?,
                })
            }
            "worker_epoch_advanced" if count == 3 || count == 4 => Ok(Self::EpochAdvanced {
                from: unsigned(payload, "fromEpoch")?,
                to: unsigned(payload, "toEpoch")?,
                now_ms: unsigned(payload, "nowMs")?,
                retain_reserved: match payload.get("retainReserved") {
                    Some(Value::Array(values)) if values.len() <= crate::worker_pool::MAX_WORKER_RECORDS => values.iter()
                        .map(|value| value.as_str().filter(|id| !id.is_empty() && id.len() <= 128)
                            .map(str::to_owned).ok_or(WorkerDurableError::Invalid("invalid retained worker id")))
                        .collect::<Result<Vec<_>, _>>()?,
                    None => Vec::new(),
                    _ => return Err(WorkerDurableError::Invalid("invalid retained worker list")),
                },
            }),
            "worker_recovered_fence" if count == 1 || count == 2 => Ok(Self::RecoveredFence {
                now_ms: unsigned(payload, "nowMs")?,
                retain_reserved: match payload.get("retainReserved") {
                    Some(Value::Array(values)) if values.len() <= crate::worker_pool::MAX_WORKER_RECORDS => values.iter()
                        .map(|value| value.as_str().filter(|id| !id.is_empty() && id.len() <= 128)
                            .map(str::to_owned).ok_or(WorkerDurableError::Invalid("invalid retained worker id")))
                        .collect::<Result<Vec<_>, _>>()?,
                    None => Vec::new(),
                    _ => return Err(WorkerDurableError::Invalid("invalid retained worker list")),
                },
            }),
            "worker_worktree_registered" if count == 2 || count == 3 || count == 4 => {
                let registration = decode_registration(
                    payload.get("registration").ok_or(WorkerDurableError::Invalid("worktree registration missing"))?,
                )?;
                let Some(owner_value) = payload.get("owner") else {
                    return Ok(Self::LegacyRegisterWorktree {
                        scope: decode_scope(payload.get("scope").ok_or(
                            WorkerDurableError::Invalid("legacy worktree scope missing"),
                        )?)?,
                        registration,
                    });
                };
                let owner = decode_worktree_root_owner(owner_value)?;
                let verification_digest = optional_text(payload, "verificationDigest")?;
                let provenance = match payload.get("provenance") {
                    None | Some(Value::Null) => None,
                    Some(value) => Some(WorktreeRegistrationProvenanceV1::from_owner_log(
                        text(value, "createOperationId")?,
                        text(value, "createReceiptRef")?,
                        text(value, "inspectOperationId")?,
                        text(value, "inspectReceiptRef")?,
                    ).map_err(map_worktree_lifecycle_error)?),
                };
                let verified = VerifiedWorktreeRegistrationV1::from_owner_log(
                    owner.clone(), registration, verification_digest, provenance,
                ).map_err(map_worktree_lifecycle_error)?;
                Ok(Self::RegisterWorktree { owner, registration: verified })
            }
            "worker_worktree_registration_removed" if count == 3 => Ok(Self::WorktreeRegistrationRemoved {
                owner: decode_worktree_root_owner(payload.get("owner").ok_or(
                    WorkerDurableError::Invalid("worktree root owner missing"),
                )?)?,
                operation_id: text(payload, "operationId")?,
                worktree_id: text(payload, "worktreeId")?,
            }),
            "worker_worktree_retired_no_dispatch" if count == 3 => {
                let intent_digest = text(payload, "intentDigest")?;
                validate_owner_digest(&intent_digest, "blake3:")?;
                Ok(Self::WorktreeOperationRetiredNoDispatch {
                    current_owner: decode_worktree_root_owner(payload.get("currentOwner").ok_or(
                        WorkerDurableError::Invalid("retirement root owner missing"),
                    )?)?,
                    operation_id: text(payload, "operationId")?,
                    intent_digest,
                })
            },
            "worker_task_enqueued" if count == 2 => Ok(Self::Enqueue {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                request: decode_enqueue(
                    payload
                        .get("request")
                        .ok_or(WorkerDurableError::Invalid("enqueue request missing"))?,
                )?,
            }),
            "worker_reserved" if count == 5 => Ok(Self::Reserve {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                ticket_id: text(payload, "ticketId")?,
                worker_execution_id: text(payload, "workerExecutionId")?,
                binding: decode_binding(
                    payload
                        .get("binding")
                        .ok_or(WorkerDurableError::Invalid("attempt binding missing"))?,
                )?,
                now_ms: unsigned(payload, "nowMs")?,
            }),
            "worker_claimed" if count == 2 => Ok(Self::ClaimWorker {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                worker_execution_id: text(payload, "workerExecutionId")?,
            }),
            "worker_core_client_attached" if count == 4 => Ok(Self::AttachCoreClient {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                worker_execution_id: text(payload, "workerExecutionId")?,
                session_link_ref: text(payload, "sessionLinkRef")?,
                reuse_key: decode_reuse_key(
                    payload
                        .get("reuseKey")
                        .ok_or(WorkerDurableError::Invalid("reuse key missing"))?,
                )?,
            }),
            "worker_process_bound" if count == 3 => Ok(Self::BindProcess {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                worker_execution_id: text(payload, "workerExecutionId")?,
                process_identity: decode_process_identity(
                    payload
                        .get("processIdentity")
                        .ok_or(WorkerDurableError::Invalid("process identity missing"))?,
                )?,
            }),
            "worker_settled" if count == 3 => Ok(Self::SettleWorker {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                worker_execution_id: text(payload, "workerExecutionId")?,
                settlement: decode_settlement(
                    payload
                        .get("settlement")
                        .ok_or(WorkerDurableError::Invalid("settlement missing"))?,
                )?,
            }),
            "worker_managed_terminal_quarantined" if count == 11 => {
                let event = ManagedTerminalQuarantineEventV1 {
                    scope: decode_scope(payload.get("scope").ok_or(
                        WorkerDurableError::Invalid("managed quarantine scope is missing"),
                    )?)?,
                    worker_execution_id: text(payload, "workerExecutionId")?,
                    goal_id: text(payload, "goalId")?,
                    run_id: text(payload, "runId")?,
                    task_id: text(payload, "taskId")?,
                    attempt_id: text(payload, "attemptId")?,
                    owner_epoch: unsigned(payload, "ownerEpoch")?,
                    reservation_id: text(payload, "reservationId")?,
                    worktree_lease_id: text(payload, "worktreeLeaseId")?,
                    terminal_proof_digest: text(payload, "terminalProofDigest")?,
                    reason: WorkerManagedQuarantineReasonV1::from_wire(text(payload, "reason")?.as_str())?,
                };
                for token in [&event.worker_execution_id, &event.goal_id, &event.run_id,
                    &event.task_id, &event.attempt_id, &event.reservation_id, &event.worktree_lease_id] {
                    validate_owner_token(token)?;
                }
                validate_owner_digest(&event.terminal_proof_digest, "blake3:")?;
                if event.owner_epoch == 0 {
                    return Err(WorkerDurableError::Invalid("managed quarantine owner epoch must be nonzero"));
                }
                Ok(Self::ManagedTerminalQuarantined { event })
            }
            "worker_quarantined" if count == 2 => Ok(Self::QuarantineWorker {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                worker_execution_id: text(payload, "workerExecutionId")?,
            }),
            "worker_expired" if count == 4 => Ok(Self::ExpireUnlaunched {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                worker_execution_id: text(payload, "workerExecutionId")?,
                now_ms: unsigned(payload, "nowMs")?,
                proof: decode_proof(
                    payload
                        .get("proof")
                        .ok_or(WorkerDurableError::Invalid("reservation proof missing"))?,
                )?,
            }),
            "worker_reconciled" if count == 3 => Ok(Self::ReconcileRelease {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                worker_execution_id: text(payload, "workerExecutionId")?,
                proof: decode_reconciliation(
                    payload
                        .get("proof")
                        .ok_or(WorkerDurableError::Invalid("reconciliation proof missing"))?,
                )?,
            }),
            "worker_managed_logical_settled" if count == 6 || count == 10 || count == 11 || count == 14 => {
                let observed_workspace_revision = match payload.get("observedWorkspaceRevision") {
                    Some(Value::Null) | None => None,
                    Some(Value::String(value)) => Some(value.clone()),
                    _ => return Err(WorkerDurableError::Invalid("invalid settled workspace revision")),
                };
                if count == 10 {
                    if let Some(revision) = observed_workspace_revision.as_deref() {
                        validate_owner_digest(revision, "blake3:")?;
                    }
                }
                let proof_digest = text(payload, "proofDigest")?;
                validate_owner_digest(&proof_digest, "blake3:")?;
                let final_worktree_operation_id = optional_text(payload, "finalWorktreeOperationId")?;
                let final_worktree_host_receipt_ref = optional_text(payload, "finalWorktreeHostReceiptRef")?;
                let evidence_digest = optional_text(payload, "evidenceDigest")?;
                if let Some(digest) = evidence_digest.as_deref() { validate_owner_digest(digest, "blake3:")?; }
                let evidence_refs = match payload.get("evidenceRefs") {
                    None => Vec::new(),
                    Some(Value::Array(values)) if values.len() <= 256 => values.iter()
                        .cloned().map(decode_artifact_ref_value).collect::<Result<Vec<_>, _>>()?,
                    _ => return Err(WorkerDurableError::Invalid("invalid settlement evidence refs")),
                };
                let verification_run_id = optional_text(payload, "verificationRunID")?;
                let set_identity_digest = optional_text(payload, "setIdentityDigest")?;
                let challenge_set_digest = optional_text(payload, "challengeSetDigest")?;
                let has_all_verifier_pins = verification_run_id.is_some()
                    && set_identity_digest.is_some() && challenge_set_digest.is_some();
                let has_any_verifier_pins = verification_run_id.is_some()
                    || set_identity_digest.is_some() || challenge_set_digest.is_some();
                let reconciliation_owner_epoch = match payload.get("reconciliationOwnerEpoch") {
                    Some(Value::Null) | None => None,
                    Some(value) => Some(value.as_u64().ok_or(WorkerDurableError::Invalid("invalid reconciliation epoch"))?),
                };
                if count == 14 {
                    if has_any_verifier_pins != has_all_verifier_pins {
                        return Err(WorkerDurableError::Invalid("incomplete verifier settlement pins"));
                    }
                    if let Some(run_id) = verification_run_id.as_deref() {
                        validate_owner_token(run_id)?;
                    }
                    for digest in [set_identity_digest.as_deref(), challenge_set_digest.as_deref()]
                        .into_iter().flatten() { validate_owner_digest(digest, "blake3:")?; }
                    if has_any_verifier_pins && evidence_digest.is_none() {
                        return Err(WorkerDurableError::Invalid("verifier settlement pins have no evidence digest"));
                    }
                    if reconciliation_owner_epoch.is_some() == has_any_verifier_pins {
                        return Err(WorkerDurableError::Invalid(
                            "verifier pins must appear exactly on verified, non-reconciliation settlement",
                        ));
                    }
                } else if has_any_verifier_pins {
                    return Err(WorkerDurableError::Invalid("legacy settlement cannot carry verifier pins"));
                }
                validate_settlement_evidence(evidence_digest.as_deref(), &evidence_refs)?;
                if final_worktree_operation_id.is_some() != final_worktree_host_receipt_ref.is_some() {
                    return Err(WorkerDurableError::Invalid("incomplete final worktree receipt reference"));
                }
                if let Some(operation_id) = final_worktree_operation_id.as_deref() {
                    validate_owner_token(operation_id)?;
                }
                if let Some(host_ref) = final_worktree_host_receipt_ref.as_deref() {
                    validate_owner_token(host_ref)?;
                }
                if final_worktree_operation_id.is_some() && observed_workspace_revision.is_none() {
                    return Err(WorkerDurableError::Invalid("final worktree receipt has no observed revision"));
                }
                Ok(Self::ManagedLogicalSettled { event: ManagedLogicalSettlementEventV1 {
                    schema_version: if count == 6 { 1 } else if count == 10 { 2 } else if count == 11 { 3 } else { 4 },
                    worker_execution_id: text(payload, "workerExecutionId")?,
                    attempt_id: text(payload, "attemptId")?,
                    proof_digest, observed_workspace_revision, final_worktree_operation_id,
                    final_worktree_host_receipt_ref, evidence_digest, evidence_refs,
                    verification_run_id, set_identity_digest, challenge_set_digest,
                    reusable_worktree: boolean(payload, "reusableWorktree")?,
                    // Schema 4 is schema 3 plus the verifier pins, so the
                    // settlement payload still carries `dispositionDeferred`.
                    // Reading it only at count 11 silently replayed schema-4
                    // deferred dispositions as false, diverging from the
                    // durable receipt digest that hashes this field.
                    disposition_deferred: if count == 11 || count == 14 { boolean(payload, "dispositionDeferred")? } else { false },
                    reconciliation_owner_epoch,
                } })
            },
            "worker_managed_worktree_disposition" if count == 10 || count == 11 => {
                let event = ManagedWorktreeDispositionEventV1 {
                    worker_execution_id: text(payload, "workerExecutionId")?,
                    attempt_id: text(payload, "attemptId")?,
                    owner_epoch: payload.get("ownerEpoch").and_then(Value::as_u64)
                        .filter(|epoch| *epoch > 0)
                        .ok_or(WorkerDurableError::Invalid("invalid disposition owner epoch"))?,
                    settlement_receipt_digest: text(payload, "settlementReceiptDigest")?,
                    final_worktree_operation_id: text(payload, "finalWorktreeOperationId")?,
                    final_worktree_host_receipt_ref: text(payload, "finalWorktreeHostReceiptRef")?,
                    observed_workspace_revision: text(payload, "observedWorkspaceRevision")?,
                    inspect_receipt_digest: text(payload, "inspectReceiptDigest")?,
                    reusable_worktree: boolean(payload, "reusableWorktree")?,
                    reconciliation_owner_epoch: match payload.get("reconciliationOwnerEpoch") {
                        Some(Value::Null) => None,
                        Some(value) => Some(value.as_u64().ok_or(WorkerDurableError::Invalid("invalid disposition owner epoch"))?),
                        None => return Err(WorkerDurableError::Invalid("missing disposition owner epoch")),
                    },
                    reconciliation_proof_digest: match payload.get("reconciliationProofDigest") {
                        Some(Value::Null) | None => None,
                        Some(value) => Some(value.as_str().ok_or(WorkerDurableError::Invalid("invalid disposition reconciliation proof digest"))?.to_owned()),
                    },
                };
                for digest in [&event.settlement_receipt_digest, &event.observed_workspace_revision,
                    &event.inspect_receipt_digest] { validate_owner_digest(digest, "blake3:")?; }
                if let Some(digest) = event.reconciliation_proof_digest.as_deref() {
                    validate_owner_digest(digest, "blake3:")?;
                }
                if (count == 11 || event.reconciliation_proof_digest.is_some())
                    && event.reconciliation_owner_epoch.is_some() != event.reconciliation_proof_digest.is_some() {
                    return Err(WorkerDurableError::Invalid("epoch recovery disposition requires its authenticated recovery proof digest"));
                }
                validate_owner_token(&event.worker_execution_id)?;
                validate_owner_token(&event.attempt_id)?;
                validate_owner_token(&event.final_worktree_operation_id)?;
                validate_owner_token(&event.final_worktree_host_receipt_ref)?;
                Ok(Self::ManagedWorktreeDisposition { event })
            }
            "worker_scope_cancelled" if count == 3 => Ok(Self::CancelScope {
                scope: decode_scope(
                    payload
                        .get("scope")
                        .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                )?,
                cancel: decode_cancel(
                    payload
                        .get("cancel")
                        .ok_or(WorkerDurableError::Invalid("cancel scope missing"))?,
                )?,
                now_ms: unsigned(payload, "nowMs")?,
            }),
            "worker_worktree_dispatch_started" if count == 1 => Ok(Self::WorktreeOperationDispatchStarted {
                operation_id: text(payload, "operationId")?,
            }),
            "worker_worktree_operation_intent" if count == 11 || count == 12 => {
                Ok(Self::WorktreeOperationIntent {
                    intent: decode_worktree_intent(payload)?,
                })
            }
            "worker_managed_final_inspect_candidate_pinned" if count == 8 || count == 11 => {
                let pin = ManagedFinalInspectCandidatePinV1 {
                    operation_id: text(payload, "operationId")?,
                    candidate_digest: text(payload, "candidateDigest")?,
                    attempt_id: text(payload, "attemptId")?,
                    binding_digest: text(payload, "bindingDigest")?,
                    spec_id: text(payload, "specId")?,
                    spec_digest: text(payload, "specDigest")?,
                    evidence_digest: text(payload, "evidenceDigest")?,
                    final_revision: text(payload, "finalRevision")?,
                    verification_run_id: if count == 11 { Some(text(payload, "verificationRunID")?) } else { None },
                    set_identity_digest: if count == 11 { Some(text(payload, "setIdentityDigest")?) } else { None },
                    challenge_set_digest: if count == 11 { Some(text(payload, "challengeSetDigest")?) } else { None },
                };
                for digest in [&pin.candidate_digest, &pin.binding_digest, &pin.spec_digest,
                    &pin.evidence_digest, &pin.final_revision] {
                    validate_owner_digest(digest, "blake3:")?;
                }
                for digest in [pin.set_identity_digest.as_deref(), pin.challenge_set_digest.as_deref()]
                    .into_iter().flatten() { validate_owner_digest(digest, "blake3:")?; }
                validate_owner_token(&pin.operation_id)?;
                validate_owner_token(&pin.attempt_id)?;
                validate_owner_token(&pin.spec_id)?;
                if let Some(verification_run_id) = pin.verification_run_id.as_deref() {
                    validate_owner_token(verification_run_id)?;
                }
                Ok(Self::ManagedFinalInspectCandidatePinned { pin })
            }
            "worker_worktree_operation_receipt" if count == 9 || count == 10 || count == 11 || count == 12 => {
                Ok(Self::WorktreeOperationReceipt {
                    receipt: decode_worktree_receipt(payload)?,
                })
            }
            "worker_memory_usage_observed" if count == 11 => {
                let attribution = crate::resource_sampler::AttributedWorkerUsageV1::from_owner_log(
                    text(payload, "workerExecutionId")?,
                    text(payload, "taskId")?,
                    text(payload, "attemptId")?,
                    decode_process_identity(
                        payload
                            .get("processIdentity")
                            .ok_or(WorkerDurableError::Invalid("process identity missing"))?,
                    )?,
                    text(payload, "units")?
                        .parse()
                        .map_err(|_| WorkerDurableError::Invalid("usage units invalid"))?,
                    text(payload, "sampleSequence")?
                        .parse()
                        .map_err(|_| WorkerDurableError::Invalid("sample sequence invalid"))?,
                    text(payload, "ownerLogId")?,
                    text(payload, "ownerLogSequence")?,
                    text(payload, "ownerLogEventDigest")?,
                    text(payload, "workerPoolRevision")?
                        .parse()
                        .map_err(|_| WorkerDurableError::Invalid("pool revision invalid"))?,
                )
                .map_err(|_| WorkerDurableError::Invalid("resource usage attribution invalid"))?;
                Ok(Self::MemoryUsageObserved {
                    scope: decode_scope(
                        payload
                            .get("scope")
                            .ok_or(WorkerDurableError::Invalid("worker scope missing"))?,
                    )?,
                    attribution,
                })
            }
            _ => Err(WorkerDurableError::Invalid("unknown worker command")),
        }
    }

    fn apply_to(&self, pool: &mut WorkerPool, mode: ApplyMode) -> Result<(), WorkerPoolError> {
        match self {
            Self::PreAdmissionReserved { pins, request, ticket_id, worker_execution_id, now_ms } => {
                validate_pre_admission_request(pins, request, ticket_id, worker_execution_id)
                    .map_err(|_| WorkerPoolError::InvalidRequest)?;
                let owner = pins.owner();
                pool.enqueue_pre_admission(request.clone(), pins, pool.revision())?;
                match mode {
                    ApplyMode::Live => pool.reserve_pre_admission(
                        ticket_id,
                        pins,
                        worker_execution_id,
                        owner,
                        pool.revision(),
                        *now_ms,
                    )?,
                    ApplyMode::Replay => pool.reserve_pre_admission_replayed(
                        ticket_id,
                        pins,
                        worker_execution_id,
                        owner,
                    )?,
                };
                Ok(())
            }
            Self::PreAdmissionContextBound { .. } => Ok(()),
            Self::PreAdmissionReconciled { proof } => {
                let owner = pool.worker(proof.worker_execution_id())
                    .ok_or(WorkerPoolError::WorkerNotFound)?;
                let scope = rehydrate(&owner.owner).map_err(|_| WorkerPoolError::ScopeMismatch)?;
                pool.reconcile_pre_admission_no_dispatch(proof.worker_execution_id(), &scope, pool.revision())
            }
            Self::AdmissionPinsRecorded { .. } | Self::DelegationBound { .. }
                | Self::RootCoordinatorRegistered { .. } | Self::RootCoordinatorReauthorized { .. } => Ok(()),
            Self::PoolOpened { .. } => Err(WorkerPoolError::InvalidTransition),
            Self::EpochAdvanced { from, to, now_ms, retain_reserved } => {
                pool.advance_owner_epoch_preserving(*from, *to, *now_ms, &retain_reserved.iter().cloned().collect())
            }
            Self::RecoveredFence { now_ms, retain_reserved } => {
                pool.recover_after_restart_preserving(*now_ms, &retain_reserved.iter().cloned().collect())?;
                Ok(())
            }
            Self::RegisterWorktree {
                owner,
                registration,
            } => {
                if registration.owner() != owner {
                    return Err(WorkerPoolError::ScopeMismatch);
                }
                pool.register_verified_root_worktree(
                    registration.registration().clone(), owner, pool.revision(),
                )
            }
            Self::LegacyRegisterWorktree { scope, registration } => {
                let owner = rehydrate(scope)?;
                pool.register_worktree(registration.clone(), &owner, pool.revision())
            }
            Self::WorktreeRegistrationRemoved { owner, worktree_id, .. } => {
                pool.remove_verified_root_worktree(worktree_id, owner, pool.revision())
            }
            Self::WorktreeOperationRetiredNoDispatch { .. } => Ok(()),
            Self::Enqueue { scope, request } => {
                let owner = rehydrate(scope)?;
                pool.enqueue(request.clone(), &owner, pool.revision())?;
                Ok(())
            }
            Self::Reserve {
                scope,
                ticket_id,
                worker_execution_id,
                binding,
                now_ms,
            } => {
                let owner = rehydrate(scope)?;
                match mode {
                    ApplyMode::Live => pool.reserve(
                        ticket_id,
                        binding,
                        worker_execution_id,
                        &owner,
                        pool.revision(),
                        *now_ms,
                    )?,
                    ApplyMode::Replay => {
                        pool.reserve_replayed(ticket_id, binding, worker_execution_id, &owner)?
                    }
                };
                Ok(())
            }
            Self::ClaimWorker {
                scope,
                worker_execution_id,
            } => {
                let owner = rehydrate(scope)?;
                pool.claim(worker_execution_id, &owner, pool.revision())
            }
            Self::AttachCoreClient {
                scope,
                worker_execution_id,
                session_link_ref,
                reuse_key,
            } => {
                let owner = rehydrate(scope)?;
                pool.attach_existing_core_client(
                    worker_execution_id,
                    session_link_ref,
                    reuse_key.clone(),
                    &owner,
                    pool.revision(),
                )
            }
            Self::BindProcess {
                scope,
                worker_execution_id,
                process_identity,
            } => {
                let owner = rehydrate(scope)?;
                pool.bind_process_record(
                    worker_execution_id,
                    process_identity.clone(),
                    &owner,
                    pool.revision(),
                )
            }
            Self::SettleWorker {
                scope,
                worker_execution_id,
                settlement,
            } => {
                let owner = rehydrate(scope)?;
                pool.settle_worker(
                    worker_execution_id,
                    settlement.clone(),
                    &owner,
                    pool.revision(),
                )?;
                Ok(())
            }
            Self::QuarantineWorker {
                scope,
                worker_execution_id,
            } => {
                let owner = rehydrate(scope)?;
                pool.quarantine_worker(worker_execution_id, &owner, pool.revision())
            }
            Self::ExpireUnlaunched {
                scope,
                worker_execution_id,
                now_ms,
                proof,
            } => {
                let owner = rehydrate(scope)?;
                pool.expire_unlaunched_worker(
                    worker_execution_id,
                    *now_ms,
                    *proof,
                    &owner,
                    pool.revision(),
                )
            }
            Self::ReconcileRelease {
                scope,
                worker_execution_id,
                proof,
            } => {
                let owner = rehydrate(scope)?;
                pool.reconcile_and_release_worker(
                    worker_execution_id,
                    *proof,
                    pool.revision(),
                    &owner,
                )?;
                Ok(())
            }
            Self::ManagedLogicalSettled { event } => pool.settle_logical_managed_worker_event(
                &event.worker_execution_id, &event.attempt_id, &event.proof_digest,
                event.observed_workspace_revision.clone(), event.reusable_worktree,
                event.disposition_deferred, event.reconciliation_owner_epoch,
            ),
            Self::ManagedWorktreeDisposition { event } => pool.finalize_logical_managed_worktree_disposition(
                &event.worker_execution_id, &event.attempt_id, &event.observed_workspace_revision,
                event.reusable_worktree, event.reconciliation_owner_epoch,
            ),
            Self::ManagedTerminalQuarantined { event } => {
                let owner = rehydrate(&event.scope)?;
                if owner.owner_epoch() != event.owner_epoch
                    || owner.run_id() != event.run_id
                    || owner.task_id() != event.task_id
                    || owner.attempt_id() != event.attempt_id
                {
                    return Err(WorkerPoolError::ScopeMismatch);
                }
                let worker = pool.worker(&event.worker_execution_id)
                    .ok_or(WorkerPoolError::WorkerNotFound)?;
                if worker.goal_id != event.goal_id
                    || worker.owner != event.scope
                    || worker.process_identity.is_some()
                    || pool.worker_reservation_id(&event.worker_execution_id)
                        != Some(event.reservation_id.as_str())
                    || worker.worktree_lease_id.as_deref() != Some(event.worktree_lease_id.as_str())
                {
                    return Err(WorkerPoolError::ScopeMismatch);
                }
                pool.quarantine_worker(&event.worker_execution_id, &owner, pool.revision())
            }
            Self::CancelScope { scope, cancel, .. } => {
                let owner = rehydrate(scope)?;
                pool.cancel_scope(cancel, &owner, pool.revision())?;
                Ok(())
            }
            Self::WorktreeOperationDispatchStarted { .. } | Self::WorktreeOperationIntent { .. }
            | Self::WorktreeOperationReceipt { .. } | Self::ManagedFinalInspectCandidatePinned { .. } => Ok(()),
            Self::MemoryUsageObserved { scope, attribution } => {
                // Current capacity is not replayable; keep the event in the
                // canonical log and restore full reservation headroom.
                let owner = rehydrate(scope)?;
                if owner.task_id() != attribution.task_id()
                    || owner.attempt_id() != attribution.attempt_id()
                {
                    return Err(WorkerPoolError::ScopeMismatch);
                }
                if mode == ApplyMode::Live {
                    pool.record_attributed_memory_usage(attribution, &owner, pool.revision())?;
                }
                Ok(())
            }
        }
    }
}

/// Clone-apply-commit durable owner of one worker pool. `open` replays the
/// committed log, fences a changed owner epoch and conservatively quarantines
/// unsettled workers before any new admission.
pub struct WorkerPoolControl {
    pool_id: String,
    log: OwnerLogV2,
    pool: Option<WorkerPool>,
    cursor: Option<CursorV1>,
    deliveries: BTreeMap<String, String>,
    worktree_operations: WorktreeOperationJournalV1,
    managed_final_inspect_candidate_pins: BTreeMap<String, ManagedFinalInspectCandidatePinV1>,
    identities: WorkerIdentityJournalV1,
    pre_admission_reconciliation_receipts: BTreeMap<String, PreAdmissionReconciliationReceiptV1>,
    managed_settlement_receipts: BTreeMap<String, WorkerSettlementReceiptV1>,
    managed_worktree_disposition_events: BTreeMap<String, ManagedWorktreeDispositionEventV1>,
    managed_worktree_disposition_receipts: BTreeMap<String, WorkerWorktreeDispositionReceiptV1>,
    managed_quarantine_receipts: BTreeMap<String, WorkerManagedQuarantineReceiptV1>,
    worktree_removal_receipts: BTreeMap<String, WorktreeRegistrationRemovalReceiptV1>,
    worktree_retirement_receipts: BTreeMap<String, WorktreeOperationRetirementReceiptV1>,
    /// Process-local advisory hysteresis only. It is deliberately reset on
    /// reopen because no OwnerLog retention contract exists for pressure
    /// history; a new tracker starts in RECOVERING and cannot claim NORMAL
    /// until it observes the configured calm window again.
    resource_pressure_trackers: std::collections::HashMap<AuthenticatedOwnerContext,
        crate::resource_budget::ManagedResourcePressureTrackerV1>,
    resumed_epoch: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkerManagedSettlementDispositionV1 { Released, WorktreeQuarantined }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkerManagedQuarantineReasonV1 {
    FailedAttempt,
    CancelledTask,
}

impl WorkerManagedQuarantineReasonV1 {
    fn wire_name(self) -> &'static str {
        match self {
            Self::FailedAttempt => "FAILED_ATTEMPT",
            Self::CancelledTask => "CANCELLED_TASK",
        }
    }

    fn from_wire(value: &str) -> Result<Self, WorkerDurableError> {
        match value {
            "FAILED_ATTEMPT" => Ok(Self::FailedAttempt),
            "CANCELLED_TASK" => Ok(Self::CancelledTask),
            _ => Err(WorkerDurableError::Invalid("unknown managed terminal quarantine reason")),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManagedTerminalQuarantineEventV1 {
    scope: OwnerScopeKey,
    worker_execution_id: String,
    goal_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    owner_epoch: u64,
    reservation_id: String,
    worktree_lease_id: String,
    terminal_proof_digest: String,
    reason: WorkerManagedQuarantineReasonV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkerManagedQuarantineReceiptV1 {
    worker_execution_id: String,
    goal_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    owner_epoch: u64,
    reservation_id: String,
    worktree_lease_id: String,
    terminal_proof_digest: String,
    reason: WorkerManagedQuarantineReasonV1,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    receipt_digest: String,
}

impl WorkerManagedQuarantineReceiptV1 {
    fn from_committed_event(
        event: &ManagedTerminalQuarantineEventV1,
        cursor: &CursorV1,
        worker_pool_revision: u64,
    ) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.worker-managed-terminal-quarantine.v1\0");
        for value in [
            event.worker_execution_id.as_str(), event.goal_id.as_str(), event.run_id.as_str(),
            event.task_id.as_str(), event.attempt_id.as_str(), event.reservation_id.as_str(),
            event.worktree_lease_id.as_str(), event.terminal_proof_digest.as_str(),
            event.reason.wire_name(), cursor.owner_id.as_str(), cursor.seq.as_str(), cursor.event_digest.as_str(),
        ] {
            append_digest_field(&mut hasher, value);
        }
        hasher.update(&event.owner_epoch.to_be_bytes());
        hasher.update(&worker_pool_revision.to_be_bytes());
        Self {
            worker_execution_id: event.worker_execution_id.clone(),
            goal_id: event.goal_id.clone(), run_id: event.run_id.clone(),
            task_id: event.task_id.clone(), attempt_id: event.attempt_id.clone(),
            owner_epoch: event.owner_epoch, reservation_id: event.reservation_id.clone(),
            worktree_lease_id: event.worktree_lease_id.clone(),
            terminal_proof_digest: event.terminal_proof_digest.clone(), reason: event.reason,
            owner_log_id: cursor.owner_id.clone(), owner_log_sequence: cursor.seq.clone(),
            owner_log_event_digest: cursor.event_digest.clone(), worker_pool_revision,
            receipt_digest: format!("blake3:{}", hasher.finalize().to_hex()),
        }
    }

    pub(crate) fn worker_execution_id(&self) -> &str { &self.worker_execution_id }
    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn task_id(&self) -> &str { &self.task_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn owner_epoch(&self) -> u64 { self.owner_epoch }
    pub(crate) fn reservation_id(&self) -> &str { &self.reservation_id }
    pub(crate) fn worktree_lease_id(&self) -> &str { &self.worktree_lease_id }
    pub(crate) fn terminal_proof_digest(&self) -> &str { &self.terminal_proof_digest }
    pub(crate) fn reason(&self) -> WorkerManagedQuarantineReasonV1 { self.reason }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn receipt_digest(&self) -> &str { &self.receipt_digest }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkerSettlementReceiptV1 {
    worker_execution_id: String,
    attempt_id: String,
    proof_digest: String,
    disposition: WorkerManagedSettlementDispositionV1,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    final_worktree_operation_id: Option<String>,
    final_worktree_host_receipt_ref: Option<String>,
    final_workspace_revision: Option<String>,
    evidence_digest: Option<String>,
    evidence_refs: Vec<crate::protocol::ArtifactRefV1>,
    verification_run_id: Option<String>,
    set_identity_digest: Option<String>,
    challenge_set_digest: Option<String>,
    disposition_deferred: bool,
    reconciliation_owner_epoch: Option<u64>,
    receipt_digest: String,
}

/// Typed reference to the durable P8 HostRun settlement record. This is a
/// reference only; constructing one requires the committed settlement receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostRunReceiptRefV1 {
    worker_execution_id: String,
    attempt_id: String,
    settlement_proof_digest: String,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    settlement_receipt_digest: String,
}

impl HostRunReceiptRefV1 {
    pub(crate) fn worker_execution_id(&self) -> &str { &self.worker_execution_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn settlement_proof_digest(&self) -> &str { &self.settlement_proof_digest }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn settlement_receipt_digest(&self) -> &str { &self.settlement_receipt_digest }
}

impl WorkerSettlementReceiptV1 {
    fn from_committed_event(
        event: &ManagedLogicalSettlementEventV1, cursor: &CursorV1, worker_pool_revision: u64,
    ) -> Self {
        let mut h = blake3::Hasher::new();
        h.update(if event.schema_version >= 4 {
            b"horizoncode.worker-settlement-receipt.v4\0"
        } else if event.schema_version >= 3 {
            b"horizoncode.worker-settlement-receipt.v3\0"
        } else if event.schema_version >= 2 {
            b"horizoncode.worker-settlement-receipt.v2\0"
        } else {
            b"horizoncode.worker-settlement-receipt.v1\0"
        });
        for value in [&event.worker_execution_id, &event.attempt_id, &event.proof_digest,
            &cursor.owner_id, &cursor.seq, &cursor.event_digest] {
            h.update(&(value.len() as u64).to_be_bytes());
            h.update(value.as_bytes());
        }
        let disposition = if event.reusable_worktree {
            WorkerManagedSettlementDispositionV1::Released
        } else { WorkerManagedSettlementDispositionV1::WorktreeQuarantined };
        h.update(&[match disposition { WorkerManagedSettlementDispositionV1::Released => 1,
            WorkerManagedSettlementDispositionV1::WorktreeQuarantined => 2 }]);
        h.update(&worker_pool_revision.to_be_bytes());
        if event.schema_version >= 2 {
            for value in [&event.final_worktree_operation_id,
                &event.final_worktree_host_receipt_ref,
                &event.observed_workspace_revision,
                &event.evidence_digest] {
                match value {
                    Some(value) => { h.update(&[1]); append_digest_field(&mut h, value); }
                    None => { h.update(&[0]); }
                };
            }
            for reference in &event.evidence_refs {
                append_digest_field(&mut h, &reference.artifact_id);
                append_digest_field(&mut h, &reference.digest);
                append_digest_field(&mut h, &reference.byte_length);
                append_digest_field(&mut h, &reference.media_type);
                h.update(&[match reference.classification {
                    crate::protocol::ArtifactClassificationV1::Public => 1,
                    crate::protocol::ArtifactClassificationV1::Workspace => 2,
                    crate::protocol::ArtifactClassificationV1::Sensitive => 3,
                }]);
            }
        }
        if event.schema_version >= 4 {
            for value in [&event.verification_run_id, &event.set_identity_digest,
                &event.challenge_set_digest] {
                match value {
                    Some(value) => { h.update(&[1]); append_digest_field(&mut h, value); }
                    None => { h.update(&[0]); }
                }
            }
        }
        Self { worker_execution_id: event.worker_execution_id.clone(), attempt_id: event.attempt_id.clone(),
            proof_digest: event.proof_digest.clone(), disposition, owner_log_id: cursor.owner_id.clone(),
            owner_log_sequence: cursor.seq.clone(), owner_log_event_digest: cursor.event_digest.clone(),
            worker_pool_revision,
            final_worktree_operation_id: event.final_worktree_operation_id.clone(),
            final_worktree_host_receipt_ref: event.final_worktree_host_receipt_ref.clone(),
            final_workspace_revision: event.observed_workspace_revision.clone(),
            evidence_digest: event.evidence_digest.clone(), evidence_refs: event.evidence_refs.clone(),
            verification_run_id: event.verification_run_id.clone(),
            set_identity_digest: event.set_identity_digest.clone(),
            challenge_set_digest: event.challenge_set_digest.clone(),
            disposition_deferred: event.disposition_deferred,
            reconciliation_owner_epoch: event.reconciliation_owner_epoch,
            receipt_digest: format!("blake3:{}", h.finalize().to_hex()) }
    }
    pub(crate) fn worker_execution_id(&self) -> &str { &self.worker_execution_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn proof_digest(&self) -> &str { &self.proof_digest }
    pub(crate) fn disposition(&self) -> WorkerManagedSettlementDispositionV1 { self.disposition }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn final_worktree_operation_id(&self) -> Option<&str> { self.final_worktree_operation_id.as_deref() }
    pub(crate) fn final_worktree_host_receipt_ref(&self) -> Option<&str> { self.final_worktree_host_receipt_ref.as_deref() }
    pub(crate) fn final_workspace_revision(&self) -> Option<&str> { self.final_workspace_revision.as_deref() }
    pub(crate) fn disposition_deferred(&self) -> bool { self.disposition_deferred }
    pub(crate) fn reconciliation_owner_epoch(&self) -> Option<u64> { self.reconciliation_owner_epoch }
    pub(crate) fn evidence_digest(&self) -> Option<&str> { self.evidence_digest.as_deref() }
    pub(crate) fn evidence_refs(&self) -> &[crate::protocol::ArtifactRefV1] { &self.evidence_refs }
    pub(crate) fn verification_run_id(&self) -> Option<&str> { self.verification_run_id.as_deref() }
    pub(crate) fn set_identity_digest(&self) -> Option<&str> { self.set_identity_digest.as_deref() }
    pub(crate) fn challenge_set_digest(&self) -> Option<&str> { self.challenge_set_digest.as_deref() }
    pub(crate) fn receipt_digest(&self) -> &str { &self.receipt_digest }
    pub(crate) fn host_run_receipt_ref(&self) -> HostRunReceiptRefV1 {
        HostRunReceiptRefV1 {
            worker_execution_id: self.worker_execution_id.clone(),
            attempt_id: self.attempt_id.clone(),
            settlement_proof_digest: self.proof_digest.clone(),
            owner_log_id: self.owner_log_id.clone(),
            owner_log_sequence: self.owner_log_sequence.clone(),
            owner_log_event_digest: self.owner_log_event_digest.clone(),
            worker_pool_revision: self.worker_pool_revision,
            settlement_receipt_digest: self.receipt_digest.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManagedLogicalSettlementEventV1 {
    schema_version: u8,
    worker_execution_id: String,
    attempt_id: String,
    proof_digest: String,
    observed_workspace_revision: Option<String>,
    final_worktree_operation_id: Option<String>,
    final_worktree_host_receipt_ref: Option<String>,
    evidence_digest: Option<String>,
    evidence_refs: Vec<crate::protocol::ArtifactRefV1>,
    verification_run_id: Option<String>,
    set_identity_digest: Option<String>,
    challenge_set_digest: Option<String>,
    reusable_worktree: bool,
    reconciliation_owner_epoch: Option<u64>,
    disposition_deferred: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManagedWorktreeDispositionEventV1 {
    worker_execution_id: String,
    attempt_id: String,
    owner_epoch: u64,
    settlement_receipt_digest: String,
    final_worktree_operation_id: String,
    final_worktree_host_receipt_ref: String,
    observed_workspace_revision: String,
    inspect_receipt_digest: String,
    reusable_worktree: bool,
    reconciliation_owner_epoch: Option<u64>,
    reconciliation_proof_digest: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkerWorktreeDispositionV1 { Reusable, Quarantined }

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkerWorktreeDispositionReceiptV1 {
    worker_execution_id: String,
    attempt_id: String,
    owner_epoch: u64,
    disposition: WorkerWorktreeDispositionV1,
    settlement_receipt_digest: String,
    final_worktree_operation_id: String,
    final_worktree_host_receipt_ref: String,
    observed_workspace_revision: String,
    inspect_receipt_digest: String,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    reconciliation_owner_epoch: Option<u64>,
    receipt_digest: String,
}

impl WorkerWorktreeDispositionReceiptV1 {
    fn from_committed_event(
        event: &ManagedWorktreeDispositionEventV1,
        cursor: &CursorV1,
        worker_pool_revision: u64,
    ) -> Self {
        let disposition = if event.reusable_worktree {
            WorkerWorktreeDispositionV1::Reusable
        } else {
            WorkerWorktreeDispositionV1::Quarantined
        };
        let mut h = blake3::Hasher::new();
        h.update(b"horizoncode.worker-worktree-disposition-receipt.v1\0");
        for value in [event.worker_execution_id.as_str(), event.attempt_id.as_str(),
            event.settlement_receipt_digest.as_str(), event.final_worktree_operation_id.as_str(),
            event.final_worktree_host_receipt_ref.as_str(), event.observed_workspace_revision.as_str(),
            event.inspect_receipt_digest.as_str(), cursor.owner_id.as_str(), cursor.seq.as_str(),
            cursor.event_digest.as_str()] {
            h.update(&(value.len() as u64).to_be_bytes());
            h.update(value.as_bytes());
        }
        h.update(&event.owner_epoch.to_be_bytes());
        match event.reconciliation_owner_epoch {
            Some(epoch) => { h.update(&[1]); h.update(&epoch.to_be_bytes()); }
            None => { h.update(&[0]); }
        }
        if let Some(digest) = event.reconciliation_proof_digest.as_deref() {
            h.update(&[1]);
            append_digest_field(&mut h, digest);
        }
        h.update(&[match disposition {
            WorkerWorktreeDispositionV1::Reusable => 1,
            WorkerWorktreeDispositionV1::Quarantined => 2,
        }]);
        h.update(&worker_pool_revision.to_be_bytes());
        Self {
            worker_execution_id: event.worker_execution_id.clone(),
            attempt_id: event.attempt_id.clone(), owner_epoch: event.owner_epoch, disposition,
            settlement_receipt_digest: event.settlement_receipt_digest.clone(),
            final_worktree_operation_id: event.final_worktree_operation_id.clone(),
            final_worktree_host_receipt_ref: event.final_worktree_host_receipt_ref.clone(),
            observed_workspace_revision: event.observed_workspace_revision.clone(),
            inspect_receipt_digest: event.inspect_receipt_digest.clone(),
            owner_log_id: cursor.owner_id.clone(), owner_log_sequence: cursor.seq.clone(),
            owner_log_event_digest: cursor.event_digest.clone(), worker_pool_revision,
            reconciliation_owner_epoch: event.reconciliation_owner_epoch,
            receipt_digest: format!("blake3:{}", h.finalize().to_hex()),
        }
    }

    pub(crate) fn worker_execution_id(&self) -> &str { &self.worker_execution_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn owner_epoch(&self) -> u64 { self.owner_epoch }
    pub(crate) fn disposition(&self) -> WorkerWorktreeDispositionV1 { self.disposition }
    pub(crate) fn settlement_receipt_digest(&self) -> &str { &self.settlement_receipt_digest }
    pub(crate) fn final_worktree_operation_id(&self) -> &str { &self.final_worktree_operation_id }
    pub(crate) fn final_worktree_host_receipt_ref(&self) -> &str { &self.final_worktree_host_receipt_ref }
    pub(crate) fn observed_workspace_revision(&self) -> &str { &self.observed_workspace_revision }
    pub(crate) fn inspect_receipt_digest(&self) -> &str { &self.inspect_receipt_digest }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn reconciliation_owner_epoch(&self) -> Option<u64> { self.reconciliation_owner_epoch }
    pub(crate) fn receipt_digest(&self) -> &str { &self.receipt_digest }
}

/// P8-minted immutable input to one guarded worktree operation. The intent is
/// already durable before P1 receives this pin; it is not execution authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeLifecycleOperationPinV1 {
    intent: WorktreeOperationIntentV1,
}

/// Selected by P8 from its durable, verified pool. It has no filesystem
/// authority and cannot be supplied through an RPC decoder.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeLifecycleTargetV1 {
    owner: WorktreeRootOwnerV1,
    worktree_id: String,
    base_revision: String,
    relative_path: std::path::PathBuf,
    verification_digest: String,
}

/// Read-only exact target for an attached managed Attempt reservation. It
/// carries no execution authority; P1 uses it to derive the cross-owner P2
/// workspace target without accepting paths or revisions from a request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedAttemptWorktreeTargetV1 {
    target: WorktreeLifecycleTargetV1,
    root: crate::worktree_lifecycle::WorkspaceRootRefV1,
    workspace_revision: String,
    binding_digest: String,
    pool_revision: u64,
    admission: Option<ManagedWorktreeAdmissionPinV1>,
    reservation_proof_digest: Option<String>,
}

/// Read-only target for a current-epoch reconciliation Inspect of a previously
/// quarantined FAILED/CANCELLED logical child. It exposes the registered P8
/// worktree path only after re-resolving the durable quarantine, old claim and
/// reservation under a fresh root proof. It carries no claim or dispatch right.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct QuarantinedManagedWorktreeTargetV1 {
    target: WorktreeLifecycleTargetV1,
    root: crate::worktree_lifecycle::WorkspaceRootRefV1,
    worker_execution_id: String,
    goal_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    reservation_id: String,
    worktree_lease_id: String,
    quarantine_receipt_digest: String,
    binding_digest: String,
    pool_revision: u64,
    reservation_proof_digest: Option<String>,
}

/// Read-only target for a fresh Inspect that completes a successful settlement
/// after an owner restart. It conveys no dispatch or lease-release authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SettledManagedWorktreeRecoveryTargetV1 {
    target: WorktreeLifecycleTargetV1,
    root: crate::worktree_lifecycle::WorkspaceRootRefV1,
    attempt_id: String,
    settlement_receipt_digest: String,
    pool_revision: u64,
}

impl SettledManagedWorktreeRecoveryTargetV1 {
    pub(crate) fn target(&self) -> &WorktreeLifecycleTargetV1 { &self.target }
    pub(crate) fn root(&self) -> &crate::worktree_lifecycle::WorkspaceRootRefV1 { &self.root }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn settlement_receipt_digest(&self) -> &str { &self.settlement_receipt_digest }
    pub(crate) fn pool_revision(&self) -> u64 { self.pool_revision }
}

impl QuarantinedManagedWorktreeTargetV1 {
    pub(crate) fn target(&self) -> &WorktreeLifecycleTargetV1 { &self.target }
    pub(crate) fn root(&self) -> &crate::worktree_lifecycle::WorkspaceRootRefV1 { &self.root }
    pub(crate) fn worker_execution_id(&self) -> &str { &self.worker_execution_id }
    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn task_id(&self) -> &str { &self.task_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn reservation_id(&self) -> &str { &self.reservation_id }
    pub(crate) fn worktree_lease_id(&self) -> &str { &self.worktree_lease_id }
    pub(crate) fn quarantine_receipt_digest(&self) -> &str { &self.quarantine_receipt_digest }
    pub(crate) fn binding_digest(&self) -> &str { &self.binding_digest }
    pub(crate) fn pool_revision(&self) -> u64 { self.pool_revision }
    pub(crate) fn reservation_proof_digest(&self) -> Option<&str> {
        self.reservation_proof_digest.as_deref()
    }
}

impl ManagedAttemptWorktreeTargetV1 {
    pub(crate) fn worktree_id(&self) -> &str { self.target.worktree_id() }
    pub(crate) fn base_revision(&self) -> &str { self.target.base_revision() }
    pub(crate) fn relative_path(&self) -> &Path { self.target.relative_path() }
    pub(crate) fn workspace_binding(&self) -> &str { self.target.owner().workspace_binding() }
    pub(crate) fn workspace_revision(&self) -> &str { &self.workspace_revision }
    pub(crate) fn binding_digest(&self) -> Option<&str> { (!self.binding_digest.is_empty()).then_some(self.binding_digest.as_str()) }
    pub(crate) fn location_id(&self) -> &str { self.root.location_ref() }
    pub(crate) fn root(&self) -> &crate::worktree_lifecycle::WorkspaceRootRefV1 { &self.root }
    pub(crate) fn pool_revision(&self) -> u64 { self.pool_revision }
    pub(crate) fn target(&self) -> &WorktreeLifecycleTargetV1 { &self.target }
    pub(crate) fn child_location_id(&self) -> Option<&str> { self.admission.as_ref().map(|pin| pin.child_location_id.as_str()) }
    pub(crate) fn child_workspace_id(&self) -> Option<&str> { self.admission.as_ref().map(|pin| pin.child_workspace_id.as_str()) }
    pub(crate) fn child_workspace_ref(&self) -> Option<&str> { self.admission.as_ref().map(|pin| pin.child_workspace_ref.as_str()) }
    pub(crate) fn child_canonical_root(&self) -> Option<&str> { self.admission.as_ref().map(|pin| pin.child_canonical_root.as_str()) }
    pub(crate) fn child_workspace_revision(&self) -> Option<&str> { self.admission.as_ref().map(|pin| pin.child_workspace_revision.as_str()) }
}

/// Durable proof that the exact verified registration was removed after a
/// guarded clean pre-delete/MISSING post-delete Release receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeRegistrationRemovalReceiptV1 {
    owner: WorktreeRootOwnerV1,
    worktree_id: String,
    release_operation_id: String,
    release_receipt_ref: String,
    tombstone_digest: String,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    receipt_digest: String,
}

/// Terminal no-effect answer for an old-root operation that never crossed the
/// durable possible-dispatch fence. It cannot authorize a retry or a tree edit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeOperationRetirementReceiptV1 {
    operation_id: String,
    old_owner_digest: String,
    current_owner: WorktreeRootOwnerV1,
    intent_digest: String,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    receipt_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorktreeOperationResolutionV1 {
    None,
    Pending(WorktreeLifecycleOperationPinV1),
    Completed(WorktreeLifecycleOperationPinV1),
    RetiredNoDispatch(WorktreeOperationRetirementReceiptV1),
    PossibleDispatchUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorktreeRetirementDispositionV1 { NotAdmittedNoDispatch }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorktreeOperationTerminalStateV1 { Expired }

impl WorktreeOperationRetirementReceiptV1 {
    fn from_committed_event(
        operation_id: String,
        old_owner_digest: String,
        current_owner: WorktreeRootOwnerV1,
        intent_digest: String,
        cursor: &CursorV1,
        worker_pool_revision: u64,
    ) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.worktree-operation-no-dispatch-retirement.v1\0");
        for value in [
            operation_id.as_str(), old_owner_digest.as_str(), current_owner.root_digest(),
            intent_digest.as_str(), cursor.owner_id.as_str(), cursor.seq.as_str(),
            cursor.event_digest.as_str(),
        ] {
            hasher.update(&(value.len() as u64).to_be_bytes());
            hasher.update(value.as_bytes());
        }
        hasher.update(&worker_pool_revision.to_be_bytes());
        Self {
            operation_id,
            old_owner_digest,
            current_owner,
            intent_digest,
            owner_log_id: cursor.owner_id.clone(),
            owner_log_sequence: cursor.seq.clone(),
            owner_log_event_digest: cursor.event_digest.clone(),
            worker_pool_revision,
            receipt_digest: format!("blake3:{}", hasher.finalize().to_hex()),
        }
    }
    pub(crate) fn operation_id(&self) -> &str { &self.operation_id }
    pub(crate) fn old_owner_digest(&self) -> &str { &self.old_owner_digest }
    pub(crate) fn current_owner(&self) -> &WorktreeRootOwnerV1 { &self.current_owner }
    pub(crate) fn intent_digest(&self) -> &str { &self.intent_digest }
    pub(crate) fn disposition(&self) -> WorktreeRetirementDispositionV1 {
        WorktreeRetirementDispositionV1::NotAdmittedNoDispatch
    }
    pub(crate) fn terminal_state(&self) -> WorktreeOperationTerminalStateV1 {
        WorktreeOperationTerminalStateV1::Expired
    }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn receipt_digest(&self) -> &str { &self.receipt_digest }
}

impl WorktreeRegistrationRemovalReceiptV1 {
    fn from_committed_event(
        owner: WorktreeRootOwnerV1,
        worktree_id: String,
        release_operation_id: String,
        release_receipt_ref: String,
        tombstone_digest: String,
        cursor: &CursorV1,
        worker_pool_revision: u64,
    ) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.worktree-registration-removal-receipt.v1\0");
        for value in [
            owner.root_digest(),
            worktree_id.as_str(),
            release_operation_id.as_str(),
            release_receipt_ref.as_str(),
            tombstone_digest.as_str(),
            cursor.owner_id.as_str(),
            cursor.seq.as_str(),
            cursor.event_digest.as_str(),
        ] {
            hasher.update(&(value.len() as u64).to_be_bytes());
            hasher.update(value.as_bytes());
        }
        hasher.update(&worker_pool_revision.to_be_bytes());
        let receipt_digest = format!("blake3:{}", hasher.finalize().to_hex());
        Self {
            owner,
            worktree_id,
            release_operation_id,
            release_receipt_ref,
            tombstone_digest,
            owner_log_id: cursor.owner_id.clone(),
            owner_log_sequence: cursor.seq.clone(),
            owner_log_event_digest: cursor.event_digest.clone(),
            worker_pool_revision,
            receipt_digest,
        }
    }

    pub(crate) fn owner(&self) -> &WorktreeRootOwnerV1 { &self.owner }
    pub(crate) fn worktree_id(&self) -> &str { &self.worktree_id }
    pub(crate) fn release_operation_id(&self) -> &str { &self.release_operation_id }
    pub(crate) fn release_receipt_ref(&self) -> &str { &self.release_receipt_ref }
    pub(crate) fn tombstone_digest(&self) -> &str { &self.tombstone_digest }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn receipt_digest(&self) -> &str { &self.receipt_digest }
}

impl WorktreeLifecycleTargetV1 {
    pub(crate) fn owner(&self) -> &WorktreeRootOwnerV1 { &self.owner }
    pub(crate) fn worktree_id(&self) -> &str { &self.worktree_id }
    pub(crate) fn base_revision(&self) -> &str { &self.base_revision }
    pub(crate) fn relative_path(&self) -> &Path { &self.relative_path }
    pub(crate) fn verification_digest(&self) -> &str { &self.verification_digest }
}

impl WorktreeLifecycleOperationPinV1 {
    fn from_durable_intent(intent: WorktreeOperationIntentV1) -> Self { Self { intent } }
    pub(crate) fn operation_id(&self) -> &str { self.intent.operation_id() }
    pub(crate) fn kind(&self) -> WorktreeOperationKindV1 { self.intent.kind() }
    pub(crate) fn owner(&self) -> &WorktreeRootOwnerV1 { self.intent.owner() }
    pub(crate) fn root(&self) -> &crate::worktree_lifecycle::WorkspaceRootRefV1 { self.intent.root() }
    pub(crate) fn worktree_id(&self) -> &str { self.intent.worktree_id() }
    pub(crate) fn base_revision(&self) -> Option<&str> { self.intent.base_revision() }
    pub(crate) fn relative_path(&self) -> &Path { self.intent.relative_path() }
    pub(crate) fn expected_workspace_revision(&self) -> &str { self.intent.expected_workspace_revision() }
    pub(crate) fn intent(&self) -> &WorktreeOperationIntentV1 { &self.intent }
}

impl WorkerPoolControl {
    pub fn open(
        root: &Path,
        pool_id: &str,
        config: WorkerPoolOpenConfig,
    ) -> Result<Self, WorkerDurableError> {
        if pool_id.is_empty()
            || pool_id.len() > 128
            || pool_id
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte == b'/' || byte == b'\\')
        {
            return Err(WorkerDurableError::Invalid("invalid worker pool ID"));
        }
        if config.owner_epoch == 0 {
            return Err(WorkerDurableError::Invalid("owner epoch must be nonzero"));
        }
        let owner = OwnerIdentity::new(OWNER_KIND.to_owned(), pool_id.to_owned())?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)?;
        let mut control = Self {
            pool_id: pool_id.to_owned(),
            log,
            pool: None,
            cursor: None,
            deliveries: BTreeMap::new(),
            worktree_operations: WorktreeOperationJournalV1::default(),
            managed_final_inspect_candidate_pins: BTreeMap::new(),
            identities: WorkerIdentityJournalV1::default(),
            pre_admission_reconciliation_receipts: BTreeMap::new(),
            managed_settlement_receipts: BTreeMap::new(),
            managed_worktree_disposition_events: BTreeMap::new(),
            managed_worktree_disposition_receipts: BTreeMap::new(),
            managed_quarantine_receipts: BTreeMap::new(),
            worktree_removal_receipts: BTreeMap::new(),
            worktree_retirement_receipts: BTreeMap::new(),
            resource_pressure_trackers: std::collections::HashMap::new(),
            resumed_epoch: 0,
        };
        control.replay()?;
        // Only `worktree_dispatch_started` means an operation may have reached
        // P1. Intent-only Pending entries have no external effect and replay as
        // Pending; they can be resolved only under the exact still-current root
        // owner. A changed epoch/process root fences them. Dispatched entries
        // replay as UNKNOWN and cannot obtain another request.
        match control.pool.as_ref().map(|pool| pool.owner_epoch()) {
            None => {
                control.apply(
                    0,
                    "worker-pool.open",
                    WorkerCommand::PoolOpened {
                        owner_epoch: config.owner_epoch,
                        max_live_workers: config.max_live_workers,
                        max_queued_tickets: config.max_queued_tickets,
                        max_worktrees: config.max_worktrees,
                    },
                )?;
            }
            Some(_) => {
                let persisted = control
                    .pool
                    .as_ref()
                    .expect("matched persisted worker pool")
                    .limits();
                if persisted.max_live_workers != config.max_live_workers
                    || persisted.max_queued_tickets != config.max_queued_tickets
                    || persisted.max_worktrees != config.max_worktrees
                {
                    return Err(WorkerDurableError::Conflict(
                        "worker pool limits differ from durable configuration",
                    ));
                }
                if persisted.owner_epoch != config.owner_epoch {
                    if persisted.owner_epoch > config.owner_epoch {
                        return Err(WorkerDurableError::Conflict(
                            "persisted owner epoch is newer than the requested epoch",
                        ));
                    }
                    let revision = control
                        .pool
                        .as_ref()
                        .map(|pool| pool.revision())
                        .unwrap_or(0);
                    let retain_reserved = control.pre_admission_reservations_pending_reconciliation();
                    control.apply(
                        revision,
                        &format!("worker-pool.epoch-{}-{}", persisted.owner_epoch, config.owner_epoch),
                        WorkerCommand::EpochAdvanced {
                            from: persisted.owner_epoch,
                            to: config.owner_epoch,
                            now_ms: now_ms(),
                            retain_reserved,
                        },
                    )?;
                }
            }
        }
        let recovery_now = now_ms();
        // Probe a clone: recovery must obey the same append-before-publish
        // contract as ordinary commands. Mutating the live projection here
        // would make the subsequent durable fence a no-op and leave replay at
        // a different revision (or expose an uncommitted fence on IO failure).
        let retain_reserved = control.pre_admission_reservations_pending_reconciliation();
        let probe = control
            .pool
            .as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool was not opened"))?
            .clone()
            .recover_after_restart_preserving(recovery_now, &retain_reserved.iter().cloned().collect())?;
        if probe != crate::worker_pool::RecoveryReport::default() {
            // Persist the conservative fence as durable evidence so replay
            // reproduces the same history before later settlement commands.
            let revision = control
                .pool
                .as_ref()
                .map(|pool| pool.revision())
                .unwrap_or(0);
            control.apply(
                revision,
                &format!("worker-pool.recovery-{revision}"),
                WorkerCommand::RecoveredFence {
                    now_ms: recovery_now,
                    retain_reserved,
                },
            )?;
        }
        control.resumed_epoch = config.owner_epoch;
        Ok(control)
    }

    pub fn pool(&self) -> Option<&WorkerPool> {
        self.pool.as_ref()
    }

    /// Resolve a candidate exclusively from the replayed P8 worktree registry.
    /// Requiring the current authenticated owner epoch keeps callers from
    /// manufacturing a resolution token from stale pool snapshots.
    pub(crate) fn resolve_managed_worktree(
        &self,
        owner: &AuthenticatedOwnerContext,
        parent_session_id: &str,
        location_id: &str,
        workspace_revision: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<crate::worker_pool::ResolvedManagedWorktreeV1, WorkerDurableError> {
        if owner.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        if parent_session_id.is_empty()
            || root_owner.session_id() != parent_session_id
            || root_owner.run_id() != owner.run_id()
            || root_owner.principal_ref() != owner.principal_ref()
            || root_owner.workspace_binding() != owner.workspace_binding()
            || root_owner.location_id() != location_id
        {
            return Err(WorkerDurableError::Conflict("managed worktree root proof differs from Attempt owner"));
        }
        let verified_ids: std::collections::BTreeSet<String> = self.identities.worktree_registration_records.iter()
            .filter(|(id, registration)| {
                !self.identities.removed_worktree_registrations.contains_key(*id)
                    && registration.owner() == &root_owner
                    && registration.verification_digest().is_some_and(|digest|
                        self.identities.verified_worktree_registrations.get(*id).map(String::as_str) == Some(digest))
            })
            .map(|(id, _)| id.clone())
            .collect();
        self.pool.as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?
            .resolve_managed_worktree(owner, location_id, workspace_revision, &verified_ids)
            .map_err(WorkerDurableError::Pool)
    }

    /// Persist only a registration minted by a completed guarded Create plus a
    /// fresh no-follow Inspect. Raw cleanliness booleans and legacy OwnerLog
    /// registrations are retained for history but never admission-eligible.
    pub(crate) fn persist_guarded_worktree_registration(
        &mut self,
        delivery_id: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        registration: VerifiedWorktreeRegistrationV1,
    ) -> Result<(), WorkerDurableError> {
        if registration.verification_digest().is_none() {
            return Err(WorkerDurableError::Conflict("worktree registration lacks guarded provenance"));
        }
        let owner = registration.owner().clone();
        if self.resolve_worktree_root_owner(root_proof, now_ms)? != owner
            || !registration.matches_durable_operations(&self.worktree_operations)
        {
            return Err(WorkerDurableError::Conflict(
                "verified worktree registration is not backed by the current root and durable receipts",
            ));
        }
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        self.apply(revision, delivery_id, WorkerCommand::RegisterWorktree { owner, registration })
    }

    pub(crate) fn resolve_worktree_root_owner(
        &self,
        proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<WorktreeRootOwnerV1, WorkerDurableError> {
        let root = self.identities.root_coordinators.get(proof.worker_execution_id())
            .ok_or(WorkerDurableError::NotFound("root coordinator unavailable"))?;
        let (owner_log_id, owner_log_sequence, owner_log_event_digest, pool_revision) = self.owner_log_watermark()?;
        if !worktree_root_owner_matches_execution_fields(proof, root)
            || proof.owner_log_id() != owner_log_id
            || proof.owner_log_sequence() != owner_log_sequence
            || proof.owner_log_event_digest() != owner_log_event_digest
            || proof.worker_pool_revision() != pool_revision
            || proof.expires_at_ms() <= now_ms
            || proof.owner_epoch() != self.resumed_epoch
        {
            return Err(WorkerDurableError::Conflict("root coordinator proof is stale for worktree lifecycle"));
        }
        WorktreeRootOwnerV1::from_live_root_proof(proof).map_err(map_worktree_lifecycle_error)
    }

    /// Choose a registered, free worktree entirely from the durable P8 pool.
    /// The caller gets an opaque target and never nominates an ID or path.
    pub(crate) fn select_worktree_lifecycle_target(
        &self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<WorktreeLifecycleTargetV1, WorkerDurableError> {
        let owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        for (worktree_id, registration) in &self.identities.worktree_registration_records {
            if registration.owner() != &owner
                || self.identities.removed_worktree_registrations.contains_key(worktree_id)
            {
                continue;
            }
            let Some(snapshot) = pool.worktree_snapshot(worktree_id) else { continue };
            if snapshot.status != crate::worktree_pool::WorktreeStatus::Free
                || snapshot.lease_id.is_some()
                || snapshot.workspace_binding != owner.workspace_binding()
                || registration.registration().clean != Some(true)
                || registration.registration().has_untracked != Some(false)
            {
                continue;
            }
            let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
                "verified worktree target has no guarded provenance",
            ))?;
            let create = self.worktree_operations.get(provenance.create_operation_id())
                .ok_or(WorkerDurableError::Conflict("worktree Create intent is missing"))?.intent();
            if create.kind() != WorktreeOperationKindV1::Create
                || create.owner() != &owner
                || create.worktree_id() != worktree_id
            {
                return Err(WorkerDurableError::Conflict("worktree target provenance differs from registration"));
            }
            return Ok(WorktreeLifecycleTargetV1 {
                owner,
                worktree_id: worktree_id.clone(),
                base_revision: registration.registration().base_revision.clone(),
                relative_path: create.relative_path().to_path_buf(),
                verification_digest: registration.verification_digest().ok_or(
                    WorkerDurableError::Conflict("worktree target is not verified"),
                )?.to_owned(),
            });
        }
        Err(WorkerDurableError::NotFound("no free verified worktree is available"))
    }

    /// Resolve the just-created tree as an inspect target without pretending it
    /// is already a registered/free worktree. The only accepted source is the
    /// exact P8 Create pin whose settled guarded receipt proves owned, no-follow,
    /// clean creation at the pinned workspace revision.
    pub(crate) fn resolve_created_worktree_target(
        &self,
        create_pin: &WorktreeLifecycleOperationPinV1,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<WorktreeLifecycleTargetV1, WorkerDurableError> {
        let owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let record = self.worktree_operations.get(create_pin.operation_id()).ok_or(
            WorkerDurableError::NotFound("durable Create operation is missing"),
        )?;
        let intent = record.intent();
        let receipt = record.receipt().ok_or(WorkerDurableError::Conflict(
            "Create operation has no settled guarded receipt",
        ))?;
        if create_pin.intent() != intent
            || intent.kind() != WorktreeOperationKindV1::Create
            || intent.owner() != &owner
            || record.state() != WorktreeOperationStateV1::Completed
            || receipt.operation_id() != intent.operation_id()
            || receipt.workspace_binding() != intent.root().workspace_binding()
            || receipt.registration_generation() != intent.root().registration_generation()
            || receipt.observed_workspace_revision() != intent.expected_workspace_revision()
            || receipt.status() != WorktreeObservedStatusV1::Clean
            || receipt.dirty_entry_count() != 0
            || receipt.contains_user_owned_changes()
            || !receipt.owned()
            || !receipt.no_follow()
            || self.identities.verified_worktree_registrations.contains_key(intent.worktree_id())
            || self.identities.removed_worktree_registrations.contains_key(intent.worktree_id())
        {
            return Err(WorkerDurableError::Conflict(
                "Create receipt cannot authorize an inspect target for this worktree",
            ));
        }
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.created-worktree-inspect-target.v1\0");
        for value in [
            owner.root_digest(), intent.operation_id(), intent.worktree_id(),
            intent.base_revision().ok_or(WorkerDurableError::Conflict(
                "Create intent has no base revision locator",
            ))?,
            intent.relative_path().to_str().ok_or(WorkerDurableError::Conflict(
                "Create intent path is not valid UTF-8",
            ))?,
            intent.expected_workspace_revision(), receipt.host_receipt_ref(),
        ] {
            hasher.update(&(value.len() as u64).to_be_bytes());
            hasher.update(value.as_bytes());
        }
        hasher.update(&intent.root().registration_generation().to_be_bytes());
        Ok(WorktreeLifecycleTargetV1 {
            owner,
            worktree_id: intent.worktree_id().to_owned(),
            base_revision: intent.base_revision().expect("validated Create base revision").to_owned(),
            relative_path: intent.relative_path().to_path_buf(),
            verification_digest: format!("blake3:{}", hasher.finalize().to_hex()),
        })
    }

    /// P8 allocates and durably records the path and identities before P1
    /// performs Guard evaluation or asks ExecutionHost to create the tree.
    pub(crate) fn prepare_worktree_create_pin(
        &mut self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        idempotency_key: &str,
        root: crate::worktree_lifecycle::WorkspaceRootRefV1,
        base_revision: &str,
        workspace_revision: &str,
    ) -> Result<WorktreeLifecycleOperationPinV1, WorkerDurableError> {
        self.prepare_worktree_operation_pin(
            root_proof, now_ms, idempotency_key, WorktreeOperationKindV1::Create,
            root, base_revision, workspace_revision, None,
        )
    }

    pub(crate) fn prepare_worktree_inspect_pin(
        &mut self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        idempotency_key: &str,
        root: crate::worktree_lifecycle::WorkspaceRootRefV1,
        workspace_revision: &str,
        target: &WorktreeLifecycleTargetV1,
    ) -> Result<WorktreeLifecycleOperationPinV1, WorkerDurableError> {
        self.prepare_worktree_operation_pin(
            root_proof, now_ms, idempotency_key, WorktreeOperationKindV1::Inspect,
            root, target.base_revision(), workspace_revision, Some(target),
        )
    }

    /// Prepare the final P1 Guarded Inspect for a managed child. The worker ID
    /// selects only an existing P8 claim; workspace revision comes from P2's
    /// typed SETTLING candidate, while verifier identity must be a HostKernel-
    /// minted token from the exact persisted SETTLED ChallengeSet. Target
    /// identity/path come from immutable admission pins plus the verified
    /// worktree registration/Create receipt.
    pub(crate) fn prepare_managed_final_inspect_pin(
        &mut self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        idempotency_key: &str,
        root: crate::worktree_lifecycle::WorkspaceRootRefV1,
        worker_execution_id: &str,
        candidate: &crate::managed_control::ManagedAttemptSettlementCandidateV1,
        verifier_pins: &crate::host_kernel::SettledVerifierChallengeSetPinsV1,
    ) -> Result<WorktreeLifecycleOperationPinV1, WorkerDurableError> {
        validate_owner_token(worker_execution_id)?;
        if idempotency_key != managed_final_inspect_idempotency_key(candidate.attempt_id()) {
            return Err(WorkerDurableError::Conflict(
                "managed final Inspect idempotency key is not derived from the settlement Attempt",
            ));
        }
        validate_final_inspect_verifier_pins(candidate, verifier_pins)?;
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let pins = self.identities.pre_admission_pins.get(worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("managed final Inspect P8 pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(worker_execution_id)?;
        self.validate_claimed_worker_dispatch_proof(&claim)?;
        let durable_binding = self.identities.delegation_bindings.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("claimed managed worktree binding is unavailable"))?;
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(worker_execution_id))
            .ok_or(WorkerDurableError::NotFound("managed final Inspect worker is unavailable"))?;
        let tree = self.pool.as_ref().and_then(|pool| pool.worktree_snapshot(&pins.worktree.worktree_id))
            .ok_or(WorkerDurableError::NotFound("managed final Inspect worktree lease is unavailable"))?;
        if pins.owner_epoch() != self.resumed_epoch
            || pins.goal_id() != candidate.goal_id()
            || pins.run_id() != candidate.run_id()
            || pins.task_id() != candidate.task_id()
            || pins.attempt_id() != candidate.attempt_id()
            || pins.attempt_id() != claim.attempt_id()
            || candidate.binding_digest() != claim.binding_digest()
            || durable_binding.binding_digest != candidate.binding_digest()
            || durable_binding.worktree_admission.as_ref().is_none_or(|admission|
                admission.worktree_id != pins.worktree.worktree_id
                    || admission.base_revision != pins.worktree.base_revision
                    || admission.root_location_id != pins.location_id
                    || admission.p8_workspace_binding != pins.workspace_binding())
            || pins.owner().owner_epoch() != root_owner.owner_epoch()
            || pins.owner().principal_ref() != root_owner.principal_ref()
            || pins.owner().workspace_binding() != root_owner.workspace_binding()
            || pins.run_id() != root_owner.run_id()
            || pins.goal_id() != root_owner.goal_id()
            || pins.location_id() != root_owner.location_id()
            || root.workspace_binding() != root_owner.workspace_binding()
            || worker.state != crate::resource_budget::ReservationState::Claimed
            || worker.cancellation_requested || worker.unknown_effect
            || worker.process_identity.is_some()
            || worker.worktree_lease_id.as_deref() != tree.lease_id.as_deref()
            || tree.status != crate::worktree_pool::WorktreeStatus::Leased
            || tree.workspace_binding != pins.workspace_binding()
            || !valid_digest(candidate.evidence_digest(), "blake3:")
            || !valid_digest(candidate.final_revision(), "blake3:")
            || !valid_digest(candidate.effect_chain_digest(), "blake3:")
            || !valid_digest(candidate.attempt_state_digest(), "blake3:")
            || candidate.owner_log_id().is_empty()
            || candidate.owner_log_sequence() == 0
            || !valid_digest(candidate.owner_log_event_digest(), "blake3:")
            || candidate.managed_revision() == 0
            || validate_usage_accounting_summary(
                candidate.usage_accounting(), candidate.managed_revision(),
            ).is_err()
        {
            return Err(WorkerDurableError::Conflict("managed final Inspect does not match the active claimed Attempt and worktree lease"));
        }
        let worktree_id = pins.worktree.worktree_id.as_str();
        let registration = self.identities.worktree_registration_records.get(worktree_id)
            .filter(|record| {
                record.owner() == &root_owner
                    && !self.identities.removed_worktree_registrations.contains_key(worktree_id)
                    && record.verification_digest().is_some_and(|digest|
                        self.identities.verified_worktree_registrations.get(worktree_id).map(String::as_str) == Some(digest))
            })
            .ok_or(WorkerDurableError::Conflict("managed final Inspect worktree lacks exact verified registration"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "managed final Inspect worktree registration has no guarded provenance",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .ok_or(WorkerDurableError::Conflict("managed final Inspect Create intent is unavailable"))?;
        if create.state() != WorktreeOperationStateV1::Completed
            || create.intent().kind() != WorktreeOperationKindV1::Create
            || create.intent().owner() != &root_owner
            || create.intent().worktree_id() != worktree_id
            || create.intent().root() != &root
            || create.intent().base_revision() != Some(pins.worktree.base_revision.as_str())
            || registration.registration().base_revision != pins.worktree.base_revision
            || create.receipt().is_none_or(|receipt| !receipt.owned() || !receipt.no_follow())
        {
            return Err(WorkerDurableError::Conflict("managed final Inspect registration does not match guarded Create provenance"));
        }
        let target = WorktreeLifecycleTargetV1 {
            owner: root_owner,
            worktree_id: worktree_id.to_owned(),
            base_revision: pins.worktree.base_revision.clone(),
            relative_path: create.intent().relative_path().to_path_buf(),
            verification_digest: registration.verification_digest().ok_or(WorkerDurableError::Conflict(
                "managed final Inspect worktree verification digest is unavailable",
            ))?.to_owned(),
        };
        let operation = self.prepare_worktree_inspect_pin(
            root_proof, now_ms, idempotency_key, root,
            candidate.final_revision(), &target,
        )?;
        let candidate_digest = managed_final_inspect_candidate_digest(
            candidate.attempt_id(), candidate.goal_id(), candidate.run_id(), candidate.task_id(),
            candidate.binding_digest(), candidate.spec_id(), candidate.spec_digest(),
            candidate.evidence_digest(), candidate.final_revision(), candidate.effect_chain_digest(),
            candidate.attempt_state_digest(), candidate.owner_log_id(), candidate.owner_log_sequence(),
            candidate.owner_log_event_digest(), candidate.managed_revision(), candidate.usage_accounting(),
            verifier_pins,
        );
        let candidate_pin = ManagedFinalInspectCandidatePinV1 {
            operation_id: operation.operation_id().to_owned(), candidate_digest,
            attempt_id: candidate.attempt_id().to_owned(),
            binding_digest: candidate.binding_digest().to_owned(), spec_id: candidate.spec_id().to_owned(),
            spec_digest: candidate.spec_digest().to_owned(),
            evidence_digest: candidate.evidence_digest().to_owned(), final_revision: candidate.final_revision().to_owned(),
            verification_run_id: Some(verifier_pins.verification_run_id().to_owned()),
            set_identity_digest: Some(verifier_pins.set_identity_digest().to_owned()),
            challenge_set_digest: Some(verifier_pins.challenge_set_digest().to_owned()),
        };
        let expected_revision = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.revision();
        self.apply(expected_revision, &format!("managed-final-inspect-candidate:{}", operation.operation_id()),
            WorkerCommand::ManagedFinalInspectCandidatePinned { pin: candidate_pin })?;
        Ok(operation)
    }

    /// Resolve the exact registered Create root for the active managed claim.
    /// HostKernel must use this generation instead of guessing a root ref.
    pub(crate) fn managed_final_inspect_root(
        &self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        worker_execution_id: &str,
        candidate: &crate::managed_control::ManagedAttemptSettlementCandidateV1,
    ) -> Result<crate::worktree_lifecycle::WorkspaceRootRefV1, WorkerDurableError> {
        validate_owner_token(worker_execution_id)?;
        let owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let pins = self.identities.pre_admission_pins.get(worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("managed final Inspect P8 pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(worker_execution_id)?;
        let registration = self.identities.worktree_registration_records.get(&pins.worktree.worktree_id)
            .filter(|record| record.owner() == &owner
                && !self.identities.removed_worktree_registrations.contains_key(&pins.worktree.worktree_id)
                && record.matches_durable_operations(&self.worktree_operations))
            .ok_or(WorkerDurableError::Conflict("managed final Inspect registration is unavailable"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "managed final Inspect registration provenance is unavailable",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .filter(|record| record.state() == WorktreeOperationStateV1::Completed
                && record.intent().kind() == WorktreeOperationKindV1::Create
                && record.intent().owner() == &owner
                && record.intent().worktree_id() == pins.worktree.worktree_id
                && record.intent().root().workspace_binding() == pins.workspace_binding())
            .ok_or(WorkerDurableError::Conflict("managed final Inspect Create root is unavailable"))?;
        if pins.attempt_id() != candidate.attempt_id()
            || pins.goal_id() != candidate.goal_id()
            || pins.run_id() != candidate.run_id()
            || pins.task_id() != candidate.task_id()
            || pins.attempt_id() != claim.attempt_id()
            || claim.binding_digest() != candidate.binding_digest()
            || pins.owner().principal_ref() != owner.principal_ref()
            || pins.workspace_binding() != owner.workspace_binding()
            || pins.run_id() != owner.run_id()
            || pins.goal_id() != owner.goal_id()
            || pins.location_id() != owner.location_id()
            || pins.owner_epoch() != owner.owner_epoch()
        {
            return Err(WorkerDurableError::Conflict("managed final Inspect candidate does not match the claimed P8 worktree"));
        }
        Ok(create.intent().root().clone())
    }

    /// Derive the exact worktree target attached to an active claimed managed
    /// child. The returned pool revision lets HostKernel reject a stale target
    /// before it mints P2's workspace reference.
    pub(crate) fn resolve_claimed_managed_worktree_target(
        &self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        worker_execution_id: &str,
        candidate: &crate::managed_control::ManagedAttemptSettlementCandidateV1,
    ) -> Result<ManagedAttemptWorktreeTargetV1, WorkerDurableError> {
        validate_owner_token(worker_execution_id)?;
        let owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let pins = self.identities.pre_admission_pins.get(worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("claimed managed worktree P8 pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(worker_execution_id)?;
        self.validate_claimed_worker_dispatch_proof(&claim)?;
        let durable_binding = self.identities.delegation_bindings.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("claimed managed worktree binding is unavailable"))?;
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(worker_execution_id))
            .ok_or(WorkerDurableError::NotFound("claimed managed worktree worker is unavailable"))?;
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let tree = pool.worktree_snapshot(&pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::NotFound("claimed managed worktree lease is unavailable"))?;
        if pins.owner_epoch() != self.resumed_epoch
            || pins.goal_id() != candidate.goal_id()
            || pins.run_id() != candidate.run_id()
            || pins.task_id() != candidate.task_id()
            || pins.attempt_id() != candidate.attempt_id()
            || pins.attempt_id() != claim.attempt_id()
            || claim.binding_digest() != candidate.binding_digest()
            || durable_binding.binding_digest != candidate.binding_digest()
            || durable_binding.worktree_admission.as_ref().is_none_or(|admission|
                admission.worktree_id != pins.worktree.worktree_id
                    || admission.base_revision != pins.worktree.base_revision
                    || admission.root_location_id != pins.location_id
                    || admission.p8_workspace_binding != pins.workspace_binding())
            || pins.owner().principal_ref() != owner.principal_ref()
            || pins.owner().workspace_binding() != owner.workspace_binding()
            || pins.run_id() != owner.run_id()
            || pins.goal_id() != owner.goal_id()
            || pins.location_id() != owner.location_id()
            || worker.state != crate::resource_budget::ReservationState::Claimed
            || worker.cancellation_requested || worker.unknown_effect
            || worker.process_identity.is_some()
            || worker.worktree_lease_id.as_deref() != tree.lease_id.as_deref()
            || tree.status != crate::worktree_pool::WorktreeStatus::Leased
            || tree.workspace_binding != pins.workspace_binding()
        {
            return Err(WorkerDurableError::Conflict("claimed managed worktree is stale or mismatched"));
        }
        let worktree_id = pins.worktree.worktree_id.as_str();
        let registration = self.identities.worktree_registration_records.get(worktree_id)
            .filter(|registration| registration.owner() == &owner
                && !self.identities.removed_worktree_registrations.contains_key(worktree_id)
                && registration.matches_durable_operations(&self.worktree_operations)
                && registration.verification_digest().is_some_and(|digest|
                    self.identities.verified_worktree_registrations.get(worktree_id).map(String::as_str) == Some(digest)))
            .ok_or(WorkerDurableError::Conflict("claimed worktree has no exact durable verified registration"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "claimed worktree registration has no guarded Create provenance",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .filter(|record| record.state() == WorktreeOperationStateV1::Completed
                && record.intent().kind() == WorktreeOperationKindV1::Create
                && record.intent().owner() == &owner
                && record.intent().worktree_id() == worktree_id
                && record.intent().base_revision() == Some(pins.worktree.base_revision.as_str())
                && record.intent().root().workspace_binding() == pins.workspace_binding()
                && record.receipt().is_some_and(|receipt| receipt.owned() && receipt.no_follow()))
            .ok_or(WorkerDurableError::Conflict("claimed worktree Create receipt does not match P8 pins"))?;
        let target = WorktreeLifecycleTargetV1 {
            owner,
            worktree_id: worktree_id.to_owned(),
            base_revision: pins.worktree.base_revision.clone(),
            relative_path: create.intent().relative_path().to_path_buf(),
            verification_digest: registration.verification_digest().ok_or(WorkerDurableError::Conflict(
                "claimed worktree registration verification digest is unavailable",
            ))?.to_owned(),
        };
        Ok(ManagedAttemptWorktreeTargetV1 {
            target,
            root: create.intent().root().clone(),
            workspace_revision: candidate.final_revision().to_owned(),
            binding_digest: durable_binding.binding_digest.clone(),
            pool_revision: pool.revision(),
            admission: durable_binding.worktree_admission.clone(),
            reservation_proof_digest: None,
        })
    }

    /// Pre-prompt variant for P1 admission/handoff. Identity and authority come
    /// from the authenticated owner, exact P2 binding and the durable P8 claim;
    /// no post-verification candidate or caller path is needed.
    pub(crate) fn resolve_active_claimed_managed_worktree_target(
        &self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        worker_execution_id: &str,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
    ) -> Result<ManagedAttemptWorktreeTargetV1, WorkerDurableError> {
        validate_owner_token(worker_execution_id)?;
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let pins = self.identities.pre_admission_pins.get(worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("claimed managed worktree P8 pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(worker_execution_id)?;
        self.validate_claimed_worker_dispatch_proof(&claim)?;
        let durable_binding = self.identities.delegation_bindings.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("claimed managed worktree binding is unavailable"))?;
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(worker_execution_id))
            .ok_or(WorkerDurableError::NotFound("claimed managed worktree worker is unavailable"))?;
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let tree = pool.worktree_snapshot(&pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::NotFound("claimed managed worktree lease is unavailable"))?;
        if binding.goal_id() != pins.goal_id()
            || binding.run_id() != pins.run_id()
            || binding.task_id() != pins.task_id()
            || binding.attempt_id() != pins.attempt_id()
            || binding.owner_epoch() != pins.owner_epoch()
            || binding.source_revision() != durable_binding.child_workspace_revision()?
            || binding.accepted_spec_digest() != pins.accepted_spec_digest()
            || owner.owner_epoch() != binding.owner_epoch()
            || owner.run_id() != binding.run_id()
            || owner.task_id() != binding.task_id()
            || owner.attempt_id() != binding.attempt_id()
            || owner.session_id() != pins.session_id()
            || owner.principal_ref() != root_owner.principal_ref()
            || owner.workspace_binding() != root_owner.workspace_binding()
            || root_owner.session_id() != managed_root_session_id(pins.parent_proof())?
            || pins.location_id() != root_owner.location_id()
            || root_owner.run_id() != binding.run_id()
            || root_owner.goal_id() != binding.goal_id()
            || claim.attempt_id() != binding.attempt_id()
            || claim.binding_digest() != durable_binding.binding_digest
            || worker.state != crate::resource_budget::ReservationState::Claimed
            || worker.cancellation_requested || worker.unknown_effect
            || worker.process_identity.is_some()
            || worker.worktree_lease_id.as_deref() != tree.lease_id.as_deref()
            || tree.status != crate::worktree_pool::WorktreeStatus::Leased
            || tree.workspace_binding != pins.workspace_binding()
        {
            return Err(WorkerDurableError::Conflict("active claimed managed worktree target is stale or mismatched"));
        }
        let worktree_id = pins.worktree.worktree_id.as_str();
        let registration = self.identities.worktree_registration_records.get(worktree_id)
            .filter(|registration| registration.owner() == &root_owner
                && !self.identities.removed_worktree_registrations.contains_key(worktree_id)
                && registration.matches_durable_operations(&self.worktree_operations)
                && registration.verification_digest().is_some_and(|digest|
                    self.identities.verified_worktree_registrations.get(worktree_id).map(String::as_str) == Some(digest)))
            .ok_or(WorkerDurableError::Conflict("claimed worktree lacks exact verified registration"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "claimed worktree registration lacks guarded Create provenance",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .filter(|record| record.state() == WorktreeOperationStateV1::Completed
                && record.intent().kind() == WorktreeOperationKindV1::Create
                && record.intent().owner() == &root_owner
                && record.intent().worktree_id() == worktree_id
                && record.intent().base_revision() == Some(pins.worktree.base_revision.as_str())
                && record.intent().root().workspace_binding() == pins.workspace_binding()
                && record.receipt().is_some_and(|receipt| receipt.owned() && receipt.no_follow()))
            .ok_or(WorkerDurableError::Conflict("claimed worktree Create receipt does not match durable pins"))?;
        let target = WorktreeLifecycleTargetV1 {
            owner: root_owner,
            worktree_id: worktree_id.to_owned(),
            base_revision: pins.worktree.base_revision.clone(),
            relative_path: create.intent().relative_path().to_path_buf(),
            verification_digest: registration.verification_digest().ok_or(WorkerDurableError::Conflict(
                "claimed worktree registration verification digest is unavailable",
            ))?.to_owned(),
        };
        Ok(ManagedAttemptWorktreeTargetV1 {
            target,
            root: create.intent().root().clone(),
            workspace_revision: durable_binding.child_workspace_revision()?.to_owned(),
            binding_digest: durable_binding.binding_digest.clone(),
            pool_revision: pool.revision(),
            admission: durable_binding.worktree_admission.clone(),
            reservation_proof_digest: None,
        })
    }

    fn resolve_quarantined_reconciliation_root_owner(
        &self,
        proof: &ReadOnlyReconciliationRootProofV1,
        now_ms: u64,
    ) -> Result<WorktreeRootOwnerV1, WorkerDurableError> {
        let root = self.identities.root_coordinators.get(proof.worker_execution_id())
            .ok_or(WorkerDurableError::NotFound("reauthorized reconciliation root unavailable"))?;
        let (owner_log_id, owner_log_sequence, owner_log_event_digest, pool_revision) = self.owner_log_watermark()?;
        if root.goal_id != proof.goal_id() || root.run_id != proof.run_id()
            || root.principal_ref != proof.principal_ref()
            || root.workspace_binding != proof.workspace_binding()
            || root.session_id != proof.session_id() || root.location_id != proof.location_id()
            || root.owner_epoch != proof.owner_epoch()
            || root.process_incarnation != proof.process_incarnation()
            || &root.process_identity != proof.process_identity()
            || root.source_revision != proof.source_revision()
            || root.accepted_spec_digest != proof.accepted_spec_digest()
            || root.expires_at_ms != proof.expires_at_ms() || root.expires_at_ms <= now_ms
            || proof.owner_epoch() != self.resumed_epoch
            || proof.owner_log_id() != owner_log_id || proof.owner_log_sequence() != owner_log_sequence
            || proof.owner_log_event_digest() != owner_log_event_digest
            || proof.worker_pool_revision() != pool_revision
        {
            return Err(WorkerDurableError::Conflict("read-only reconciliation root proof is stale"));
        }
        WorktreeRootOwnerV1::from_read_only_reconciliation_proof(proof)
            .map_err(map_worktree_lifecycle_error)
    }

    fn validate_quarantined_terminal_snapshot(
        &self,
        quarantine: &WorkerManagedQuarantineReceiptV1,
        current_owner: &AuthenticatedOwnerContext,
        terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
    ) -> Result<(), WorkerDurableError> {
        let durable = self.resolve_managed_quarantine_for_attempt(quarantine.attempt_id())?
            .ok_or(WorkerDurableError::NotFound("durable managed quarantine unavailable"))?;
        let pins = self.identities.pre_admission_pins.get(quarantine.worker_execution_id())
            .ok_or(WorkerDurableError::NotFound("quarantined worker pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(quarantine.worker_execution_id())?;
        let binding = self.identities.delegation_bindings.get(quarantine.worker_execution_id())
            .ok_or(WorkerDurableError::Conflict("quarantined worker DelegationBinding unavailable"))?;
        let expected_task = match quarantine.reason() {
            WorkerManagedQuarantineReasonV1::FailedAttempt => crate::managed_control::ManagedTaskTerminalStateV1::Failed,
            WorkerManagedQuarantineReasonV1::CancelledTask => crate::managed_control::ManagedTaskTerminalStateV1::Cancelled,
        };
        let quiescence = terminal.child_prompt_quiescence();
        if quarantine != &durable
            || current_owner.owner_epoch() != self.resumed_epoch
            || current_owner.owner_epoch() <= quarantine.owner_epoch()
            || current_owner.principal_ref() != pins.principal_ref()
            || current_owner.workspace_binding() != pins.workspace_binding()
            || current_owner.session_id() != pins.session_id()
            || current_owner.run_id() != pins.run_id()
            || current_owner.task_id() != pins.task_id()
            || current_owner.attempt_id() != pins.attempt_id()
            || terminal.goal_id() != pins.goal_id()
            || terminal.run_id() != pins.run_id()
            || terminal.task_id() != pins.task_id()
            || terminal.attempt_id() != pins.attempt_id()
            || terminal.task_revision() != pins.task_revision().parse::<u64>()
                .map_err(|_| WorkerDurableError::Conflict("quarantined Task revision is invalid"))?
            || terminal.spec_digest() != pins.accepted_spec_digest()
            || terminal.binding_digest() != binding.binding_digest
            || terminal.binding_digest() != claim.binding_digest()
            || terminal.admission_workspace_revision() != Some(binding.child_workspace_revision()?)
            || terminal.attempt_state() != crate::managed_control::ManagedAttemptTerminalStateV1::Failed
            || terminal.task_state() != expected_task
            || terminal.child_prompt_state() != crate::managed_control::ManagedChildPromptStateV1::Quiesced
            || terminal.effect_chain_state() != crate::managed_control::ManagedAttemptEffectChainStateV1::AllSettled
            || terminal.owner_log_sequence() == 0 || terminal.managed_revision() == 0
            || !valid_digest(terminal.owner_log_event_digest(), "blake3:")
            || !valid_digest(terminal.attempt_state_digest(), "blake3:")
            || !valid_digest(terminal.effect_chain_digest(), "blake3:")
            || terminal.effects().len() > MAX_BATCH_EVENTS
            || terminal.effects().iter().any(|effect| effect.effect_id().is_empty()
                || effect.outcome().is_none()
                || effect.outcome() == Some(crate::managed_control::AttemptEffectOutcomeV1::Unknown)
                || effect.observation_digest().is_none_or(|digest| !valid_digest(digest, "blake3:")))
            || quiescence.is_none_or(|receipt| {
                let marker = receipt.proof();
                marker.goal_id() != pins.goal_id()
                    || marker.run_id() != pins.run_id()
                    || marker.task_id() != pins.task_id()
                    || marker.attempt_id() != pins.attempt_id()
                    || marker.session_id() != current_owner.session_id()
                    || marker.owner_epoch() > current_owner.owner_epoch()
            })
            || terminal.child_prompt_quiescence_digest().is_none_or(|digest| !valid_digest(digest, "blake3:"))
            || terminal.child_prompt_quiescence_owner_log_id().is_none_or(str::is_empty)
            || terminal.child_prompt_quiescence_owner_log_sequence().is_none_or(|seq| seq == 0)
            || terminal.child_prompt_quiescence_owner_log_event_digest().is_none_or(|digest| !valid_digest(digest, "blake3:"))
        {
            return Err(WorkerDurableError::Conflict("fresh terminal snapshot does not prove exact quarantined Attempt quiescence and settled effects"));
        }
        Ok(())
    }

    /// Resolve a current-epoch read-only target for the independent Guarded
    /// Inspect required to reconcile an already quarantined logical child.
    /// The caller cannot nominate a worktree, path, claim, or lease; this method
    /// re-resolves all of them from the exact durable quarantine receipt and
    /// HostKernel-minted current root/Attempt owner. It does not reopen the
    /// worker claim, make the worktree reusable, or authorize an effect.
    pub(crate) fn resolve_quarantined_managed_reconciliation_target(
        &self,
        root_proof: &ReadOnlyReconciliationRootProofV1,
        now_ms: u64,
        quarantine: &WorkerManagedQuarantineReceiptV1,
        current_owner: &AuthenticatedOwnerContext,
        current_terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
    ) -> Result<QuarantinedManagedWorktreeTargetV1, WorkerDurableError> {
        validate_owner_token(quarantine.attempt_id())?;
        if current_owner.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let root_owner = self.resolve_quarantined_reconciliation_root_owner(root_proof, now_ms)?;
        self.validate_quarantined_terminal_snapshot(quarantine, current_owner, current_terminal)?;
        if current_terminal.child_prompt_quiescence().is_none_or(|receipt|
            receipt.proof().parent_session_id() != root_owner.session_id())
        {
            return Err(WorkerDurableError::Conflict(
                "quarantined child quiescence is not bound to the authenticated current root Session",
            ));
        }
        let durable_quarantine = self.resolve_managed_quarantine_for_attempt(quarantine.attempt_id())?
            .ok_or(WorkerDurableError::NotFound("durable managed quarantine receipt unavailable"))?;
        let worker_id = quarantine.worker_execution_id();
        let pins = self.identities.pre_admission_pins.get(worker_id)
            .ok_or(WorkerDurableError::NotFound("quarantined worker admission pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(worker_id)?;
        let binding = self.identities.delegation_bindings.get(worker_id)
            .ok_or(WorkerDurableError::Conflict("quarantined worker DelegationBinding unavailable"))?;
        let pool = self.pool.as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let worker = pool.worker(worker_id)
            .ok_or(WorkerDurableError::NotFound("quarantined worker lease unavailable"))?;
        let tree = pool.worktree_snapshot(&pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::NotFound("quarantined worktree lease unavailable"))?;
        if quarantine != &durable_quarantine
            || quarantine.attempt_id() != pins.attempt_id()
            || quarantine.goal_id() != pins.goal_id()
            || quarantine.run_id() != pins.run_id()
            || quarantine.task_id() != pins.task_id()
            || quarantine.owner_epoch() != pins.owner_epoch()
            || quarantine.reservation_id() != claim.reservation().budget_lease_id()
            || quarantine.worktree_lease_id() != claim.reservation().workspace_lease_id()
            || current_owner.principal_ref() != pins.principal_ref()
            || current_owner.workspace_binding() != pins.workspace_binding()
            || current_owner.session_id() != pins.session_id()
            || current_owner.run_id() != pins.run_id()
            || current_owner.task_id() != pins.task_id()
            || current_owner.attempt_id() != pins.attempt_id()
            || current_owner.owner_epoch() < pins.owner_epoch()
            || root_owner.goal_id() != pins.goal_id()
            || root_owner.run_id() != pins.run_id()
            || root_owner.principal_ref() != pins.principal_ref()
            || root_owner.workspace_binding() != pins.workspace_binding()
            || managed_root_session_id(pins.parent_proof())? != root_owner.session_id()
            || root_owner.location_id() != pins.location_id()
            || root_owner.owner_epoch() != current_owner.owner_epoch()
            || root_owner.accepted_spec_digest() != pins.accepted_spec_digest()
            || claim.attempt_id() != pins.attempt_id()
            || claim.binding_digest() != binding.binding_digest
            || worker.state != crate::resource_budget::ReservationState::Quarantined
            || worker.goal_id != pins.goal_id()
            || worker.owner.principal_ref != pins.principal_ref()
            || worker.owner.workspace_binding != pins.workspace_binding()
            || worker.owner.session_id != pins.session_id()
            || worker.owner.run_id != pins.run_id()
            || worker.owner.task_id != pins.task_id()
            || worker.owner.attempt_id != pins.attempt_id()
            || worker.owner.owner_epoch != pins.owner_epoch()
            || worker.process_identity.is_some()
            || pool.worker_reservation_id(worker_id) != Some(quarantine.reservation_id())
            || worker.worktree_lease_id.as_deref() != Some(quarantine.worktree_lease_id())
            || tree.status != crate::worktree_pool::WorktreeStatus::Quarantined
            || tree.lease_id.as_deref() != Some(quarantine.worktree_lease_id())
            || tree.workspace_binding != pins.workspace_binding()
            || !valid_digest(quarantine.terminal_proof_digest(), "blake3:")
            || !valid_digest(quarantine.receipt_digest(), "blake3:")
        {
            return Err(WorkerDurableError::Conflict(
                "quarantined reconciliation target differs from current root, Attempt, claim, or retained lease",
            ));
        }

        let worktree_id = pins.worktree.worktree_id.as_str();
        let registration = self.identities.worktree_registration_records.get(worktree_id)
            .filter(|registration| {
                !self.identities.removed_worktree_registrations.contains_key(worktree_id)
                    && same_worktree_root_lineage(registration.owner(), &root_owner)
                    && registration.owner().owner_epoch() == pins.owner_epoch()
                    && registration.matches_durable_operations(&self.worktree_operations)
                    && registration.verification_digest().is_some_and(|digest|
                        self.identities.verified_worktree_registrations.get(worktree_id).map(String::as_str) == Some(digest))
            })
            .ok_or(WorkerDurableError::Conflict("quarantined worktree has no retained guarded registration"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "quarantined worktree registration has no guarded Create provenance",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .filter(|record| record.state() == WorktreeOperationStateV1::Completed
                && record.intent().kind() == WorktreeOperationKindV1::Create
                && record.intent().owner() == registration.owner()
                && record.intent().worktree_id() == worktree_id
                && record.intent().base_revision() == Some(pins.worktree.base_revision.as_str())
                && record.intent().root().workspace_binding() == pins.workspace_binding()
                && record.receipt().is_some_and(|receipt| receipt.owned() && receipt.no_follow()))
            .ok_or(WorkerDurableError::Conflict("quarantined worktree Create provenance differs from P8 pins"))?;
        let target = WorktreeLifecycleTargetV1 {
            owner: root_owner,
            worktree_id: worktree_id.to_owned(),
            base_revision: pins.worktree.base_revision.clone(),
            relative_path: create.intent().relative_path().to_path_buf(),
            verification_digest: registration.verification_digest().ok_or(WorkerDurableError::Conflict(
                "quarantined worktree verification digest unavailable",
            ))?.to_owned(),
        };
        Ok(QuarantinedManagedWorktreeTargetV1 {
            target,
            root: create.intent().root().clone(),
            worker_execution_id: worker_id.to_owned(),
            goal_id: pins.goal_id().to_owned(),
            run_id: pins.run_id().to_owned(),
            task_id: pins.task_id().to_owned(),
            attempt_id: pins.attempt_id().to_owned(),
            reservation_id: quarantine.reservation_id().to_owned(),
            worktree_lease_id: quarantine.worktree_lease_id().to_owned(),
            quarantine_receipt_digest: quarantine.receipt_digest().to_owned(),
            binding_digest: binding.binding_digest.clone(),
            pool_revision: pool.revision(),
            reservation_proof_digest: None,
        })
    }

    /// Persist the single read-only Inspect intent for the exact quarantined
    /// Attempt. `expected_workspace_revision` must be freshly measured by P1
    /// from the registered child Location under the authenticated root proof.
    pub(crate) fn prepare_quarantined_reconciliation_inspect_pin(
        &mut self,
        root_proof: &ReadOnlyReconciliationRootProofV1,
        now_ms: u64,
        quarantine: &WorkerManagedQuarantineReceiptV1,
        current_owner: &AuthenticatedOwnerContext,
        current_terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        target: &QuarantinedManagedWorktreeTargetV1,
        expected_workspace_revision: &str,
    ) -> Result<WorktreeLifecycleOperationPinV1, WorkerDurableError> {
        validate_owner_digest(expected_workspace_revision, "blake3:")?;
        let resolved = self.resolve_quarantined_managed_reconciliation_target(
            root_proof, now_ms, quarantine, current_owner, current_terminal,
        )?;
        if &resolved != target || target.attempt_id() != quarantine.attempt_id() {
            return Err(WorkerDurableError::Conflict("reconciliation Inspect target is stale or mismatched"));
        }
        for record in self.worktree_operations.iter().filter(|record| {
            let intent = record.intent();
            intent.kind() == WorktreeOperationKindV1::Inspect
                && intent.owner() == target.target().owner()
                && intent.worktree_id() == target.target().worktree_id()
                && intent.relative_path() == target.target().relative_path()
                && intent.operation_id() == worktree_operation_id(
                    intent.owner(), WorktreeOperationKindV1::Inspect,
                    &quarantined_reconciliation_inspect_key(
                        target.attempt_id(), intent.owner_epoch(), intent.owner_log_sequence(),
                    ),
                )
        }) {
            if record.state() == WorktreeOperationStateV1::Pending {
                if record.intent().expected_workspace_revision() != expected_workspace_revision {
                    return Err(WorkerDurableError::Conflict("pending reconciliation Inspect is pinned to a different workspace revision"));
                }
                return Ok(WorktreeLifecycleOperationPinV1::from_durable_intent(record.intent().clone()));
            }
        }
        let (_, sequence, _, _) = self.owner_log_watermark()?;
        let operation_key = quarantined_reconciliation_inspect_key(
            target.attempt_id(), root_proof.owner_epoch(), &sequence,
        );
        validate_owner_token(&operation_key)?;
        let intent = self.quarantined_reconciliation_inspect_intent(
            target, expected_workspace_revision, &operation_key,
        )?;
        let operation_id = intent.operation_id().to_owned();
        self.persist_worktree_intent(&format!("worktree-reconcile-inspect-intent-{operation_id}"), intent.clone())?;
        Ok(WorktreeLifecycleOperationPinV1::from_durable_intent(intent))
    }

    fn quarantined_reconciliation_inspect_intent(
        &self,
        target: &QuarantinedManagedWorktreeTargetV1,
        expected_workspace_revision: &str,
        idempotency_key: &str,
    ) -> Result<WorktreeOperationIntentV1, WorkerDurableError> {
        let owner = target.target().owner().clone();
        let operation_id = worktree_operation_id(&owner, WorktreeOperationKindV1::Inspect, idempotency_key);
        let (log_id, sequence, event_digest, _) = self.owner_log_watermark()?;
        WorktreeOperationIntentV1::new(
            operation_id, WorktreeOperationKindV1::Inspect, owner, target.root().clone(),
            target.target().worktree_id().to_owned(), target.target().base_revision().to_owned(),
            target.target().relative_path().to_path_buf(), expected_workspace_revision.to_owned(),
            log_id, sequence, event_digest,
        ).map_err(map_worktree_lifecycle_error)
    }

    /// Cross the possible-dispatch fence for the single exact read-only
    /// reconciliation Inspect. All other operation kinds are rejected.
    pub(crate) fn mark_quarantined_reconciliation_inspect_dispatch_started_and_get_request(
        &mut self,
        root_proof: &ReadOnlyReconciliationRootProofV1,
        pin: &WorktreeLifecycleOperationPinV1,
        quarantine: &WorkerManagedQuarantineReceiptV1,
        current_owner: &AuthenticatedOwnerContext,
        current_terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        now_ms: u64,
    ) -> Result<GuardedWorktreeRequestV1, WorkerDurableError> {
        if pin.kind() != WorktreeOperationKindV1::Inspect
            || pin.operation_id() != worktree_operation_id(
                pin.owner(), WorktreeOperationKindV1::Inspect,
                &quarantined_reconciliation_inspect_key(
                    quarantine.attempt_id(), pin.owner().owner_epoch(), pin.intent().owner_log_sequence(),
                ),
            )
        {
            return Err(WorkerDurableError::Conflict("reconciliation dispatch is not the exact quarantine Inspect"));
        }
        let target = self.resolve_quarantined_managed_reconciliation_target(
            root_proof, now_ms, quarantine, current_owner, current_terminal,
        )?;
        let record = self.worktree_operations.get(pin.operation_id())
            .ok_or(WorkerDurableError::NotFound("reconciliation Inspect intent unavailable"))?;
        if record.intent() != pin.intent() || record.intent().owner() != target.target().owner()
            || record.intent().root() != target.root()
            || record.intent().worktree_id() != target.target().worktree_id()
            || record.intent().relative_path() != target.target().relative_path()
            || record.state() != WorktreeOperationStateV1::Pending
        {
            return Err(WorkerDurableError::Conflict("reconciliation Inspect intent differs from current quarantine target"));
        }
        let intent = record.intent().clone();
        let revision = self.pool.as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.revision();
        self.apply(revision, &format!("worktree-reconcile-inspect-dispatch-{}", pin.operation_id()),
            WorkerCommand::WorktreeOperationDispatchStarted { operation_id: pin.operation_id().to_owned() })?;
        Ok(GuardedWorktreeRequestV1::from_durable_intent(intent))
    }

    /// Persist a fresh P1 Guarded Inspect receipt for the exact quarantined
    /// Attempt. This does not itself release either retained lease.
    pub(crate) fn persist_quarantined_reconciliation_inspect_receipt(
        &mut self,
        root_proof: &ReadOnlyReconciliationRootProofV1,
        quarantine: &WorkerManagedQuarantineReceiptV1,
        current_owner: &AuthenticatedOwnerContext,
        current_terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        now_ms: u64,
        receipt: GuardedWorktreeReceiptV1,
    ) -> Result<(), WorkerDurableError> {
        let target = self.resolve_quarantined_managed_reconciliation_target(
            root_proof, now_ms, quarantine, current_owner, current_terminal,
        )?;
        let record = self.worktree_operations.get(receipt.operation_id())
            .ok_or(WorkerDurableError::NotFound("reconciliation Inspect intent unavailable"))?;
        let operation_key = quarantined_reconciliation_inspect_key(
            quarantine.attempt_id(), record.intent().owner_epoch(), record.intent().owner_log_sequence(),
        );
        let expected_operation = worktree_operation_id(
            target.target().owner(), WorktreeOperationKindV1::Inspect, &operation_key,
        );
        if receipt.operation_id() != expected_operation
            || record.intent().kind() != WorktreeOperationKindV1::Inspect
            || record.intent().owner() != target.target().owner()
            || record.intent().root() != target.root()
            || record.intent().worktree_id() != target.target().worktree_id()
            || record.intent().relative_path() != target.target().relative_path()
            || record.state() != WorktreeOperationStateV1::Unknown
            || !receipt.owned() || !receipt.no_follow()
            || receipt.workspace_binding() != current_owner.workspace_binding()
            || receipt.registration_generation() != record.intent().root().registration_generation()
            || receipt.observed_workspace_revision() != record.intent().expected_workspace_revision()
            || matches!(receipt.status(), WorktreeObservedStatusV1::Missing | WorktreeObservedStatusV1::Unknown)
        {
            return Err(WorkerDurableError::Conflict("Guarded reconciliation Inspect receipt differs from exact quarantined target"));
        }
        let revision = self.pool.as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.revision();
        self.apply(revision, &format!("worktree-reconcile-inspect-receipt-{}", quarantine.attempt_id()),
            WorkerCommand::WorktreeOperationReceipt { receipt })
    }

    /// Resolve the durable result of a previously dispatched quarantine Inspect
    /// after its execute response was lost. The caller supplies the operation
    /// ID it already pinned; this resolver cannot select another generation or
    /// turn a pending/UNKNOWN dispatch into a receipt. A returned receipt is
    /// exact, current-owner scoped, and has already crossed the durable receipt
    /// transition.
    pub(crate) fn resolve_quarantined_reconciliation_inspect_receipt(
        &self,
        root_proof: &ReadOnlyReconciliationRootProofV1,
        quarantine: &WorkerManagedQuarantineReceiptV1,
        current_owner: &AuthenticatedOwnerContext,
        current_terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        operation_id: &str,
        now_ms: u64,
    ) -> Result<GuardedWorktreeReceiptV1, WorkerDurableError> {
        let target = self.resolve_quarantined_managed_reconciliation_target(
            root_proof, now_ms, quarantine, current_owner, current_terminal,
        )?;
        let record = self.worktree_operations.get(operation_id)
            .ok_or(WorkerDurableError::NotFound("reconciliation Inspect operation unavailable"))?;
        let expected_key = quarantined_reconciliation_inspect_key(
            quarantine.attempt_id(), record.intent().owner_epoch(), record.intent().owner_log_sequence(),
        );
        let expected_id = worktree_operation_id(
            target.target().owner(), WorktreeOperationKindV1::Inspect, &expected_key,
        );
        let receipt = record.receipt()
            .ok_or(WorkerDurableError::Conflict("reconciliation Inspect has no durable receipt"))?;
        if operation_id != expected_id
            || record.intent().kind() != WorktreeOperationKindV1::Inspect
            || record.intent().owner() != target.target().owner()
            || record.intent().root() != target.root()
            || record.intent().worktree_id() != target.target().worktree_id()
            || record.intent().relative_path() != target.target().relative_path()
            || record.state() != WorktreeOperationStateV1::Completed
            || receipt.operation_id() != operation_id
            || receipt.workspace_binding() != current_owner.workspace_binding()
            || receipt.registration_generation() != target.root().registration_generation()
            || receipt.observed_workspace_revision() != record.intent().expected_workspace_revision()
            || !receipt.owned() || !receipt.no_follow()
            || !matches!(receipt.status(), WorktreeObservedStatusV1::Clean | WorktreeObservedStatusV1::DirtyOwned)
            || receipt.contains_user_owned_changes()
        {
            return Err(WorkerDurableError::Conflict(
                "durable Inspect receipt does not match the exact current quarantined Attempt",
            ));
        }
        Ok(receipt.clone())
    }

    /// Pre-dispatch projection for an attached RESERVED lease or an already
    /// CLAIMED lease. It derives the target from P8 pins/registration and the
    /// authenticated live owner; it does not consume or grant a claim.
    pub(crate) fn resolve_managed_worktree_target_for_attempt(
        &self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        worker_execution_id: &str,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
    ) -> Result<ManagedAttemptWorktreeTargetV1, WorkerDurableError> {
        validate_owner_token(worker_execution_id)?;
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let pins = self.identities.pre_admission_pins.get(worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("managed target P8 pins unavailable"))?;
        let durable_binding = self.identities.delegation_bindings.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("managed target requires durable attached DelegationBinding"))?;
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(worker_execution_id))
            .ok_or(WorkerDurableError::NotFound("managed target worker reservation is unavailable"))?;
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let tree = pool.worktree_snapshot(&pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::NotFound("managed target worktree lease is unavailable"))?;
        let owner_matches = owner.owner_epoch() == binding.owner_epoch()
            && owner.run_id() == binding.run_id()
            && owner.task_id() == binding.task_id()
            && owner.attempt_id() == binding.attempt_id()
            && owner.session_id() == pins.session_id()
            && owner.principal_ref() == root_owner.principal_ref()
            && owner.workspace_binding() == root_owner.workspace_binding()
            && root_owner.session_id() == managed_root_session_id(pins.parent_proof())?
            && pins.location_id() == root_owner.location_id();
        if !owner_matches
            || binding.goal_id() != pins.goal_id()
            || binding.run_id() != pins.run_id()
            || binding.task_id() != pins.task_id()
            || binding.attempt_id() != pins.attempt_id()
            || binding.owner_epoch() != pins.owner_epoch()
            || binding.source_revision() != durable_binding.child_workspace_revision()?
            || binding.accepted_spec_digest() != pins.accepted_spec_digest()
            || durable_binding.binding_digest.is_empty()
            || durable_binding.worktree_admission.is_none()
            || pins.owner_epoch() != self.resumed_epoch
            || pins.goal_id() != root_owner.goal_id()
            || pins.run_id() != root_owner.run_id()
            || pins.location_id() != root_owner.location_id()
            || worker.cancellation_requested || worker.unknown_effect
            || worker.process_identity.is_some()
            || !matches!(worker.state, crate::resource_budget::ReservationState::Reserved
                | crate::resource_budget::ReservationState::Claimed)
            || worker.worktree_lease_id.as_deref() != tree.lease_id.as_deref()
            || tree.status != crate::worktree_pool::WorktreeStatus::Leased
            || tree.workspace_binding != pins.workspace_binding()
        {
            return Err(WorkerDurableError::Conflict("managed target does not match a live attached P8 reservation"));
        }
        let worktree_id = pins.worktree.worktree_id.as_str();
        let registration = self.identities.worktree_registration_records.get(worktree_id)
            .filter(|registration| registration.owner() == &root_owner
                && !self.identities.removed_worktree_registrations.contains_key(worktree_id)
                && registration.matches_durable_operations(&self.worktree_operations)
                && registration.verification_digest().is_some_and(|digest|
                    self.identities.verified_worktree_registrations.get(worktree_id).map(String::as_str) == Some(digest)))
            .ok_or(WorkerDurableError::Conflict("managed target lacks exact durable verified registration"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "managed target registration lacks guarded Create provenance",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .filter(|record| record.state() == WorktreeOperationStateV1::Completed
                && record.intent().kind() == WorktreeOperationKindV1::Create
                && record.intent().owner() == &root_owner
                && record.intent().worktree_id() == worktree_id
                && record.intent().base_revision() == Some(pins.worktree.base_revision.as_str())
                && record.intent().root().workspace_binding() == pins.workspace_binding()
                && record.receipt().is_some_and(|receipt| receipt.owned() && receipt.no_follow()))
            .ok_or(WorkerDurableError::Conflict("managed target Create receipt does not match P8 pins"))?;
        let target = WorktreeLifecycleTargetV1 {
            owner: root_owner,
            worktree_id: worktree_id.to_owned(),
            base_revision: pins.worktree.base_revision.clone(),
            relative_path: create.intent().relative_path().to_path_buf(),
            verification_digest: registration.verification_digest().ok_or(WorkerDurableError::Conflict(
                "managed target registration verification digest is unavailable",
            ))?.to_owned(),
        };
        Ok(ManagedAttemptWorktreeTargetV1 {
            target,
            root: create.intent().root().clone(),
            workspace_revision: durable_binding.child_workspace_revision()?.to_owned(),
            binding_digest: durable_binding.binding_digest.clone(),
            pool_revision: pool.revision(),
            admission: durable_binding.worktree_admission.clone(),
            reservation_proof_digest: None,
        })
    }

    /// Resolve the registered worktree immediately after P8 RESERVED the
    /// opaque pre-admission lease and before P2 appends Attempt/Binding. This
    /// closes the admission cycle: only the exact reservation proof and its
    /// immutable HostKernel pins select the path/revision.
    pub(crate) fn resolve_reserved_managed_worktree_target(
        &self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        pins: &ManagedReadyTaskPinV1,
        reservation: &ReservedWorkerLeaseProofV1,
    ) -> Result<ManagedAttemptWorktreeTargetV1, WorkerDurableError> {
        pins.validate()?;
        if pins.owner_epoch() != self.resumed_epoch
            || self.identities.pre_admission_pins.get(reservation.worker_execution_id()) != Some(pins)
            || reservation.binding_digest().is_some()
        {
            return Err(WorkerDurableError::Conflict("reserved target proof is stale or already attached"));
        }
        let current = self.reserved_worker_proof(
            pins, reservation.ticket_id(), reservation.worker_execution_id(), None,
        )?;
        if current != *reservation {
            return Err(WorkerDurableError::Conflict("reserved target proof is not the current lease"));
        }
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        if pool.worker(reservation.worker_execution_id()).is_none_or(|worker|
            worker.state != crate::resource_budget::ReservationState::Reserved
                || worker.process_identity.is_some() || worker.cancellation_requested || worker.unknown_effect)
        {
            return Err(WorkerDurableError::Conflict("reserved target requires an undispatched RESERVED worker"));
        }
        if pins.expires_at_ms() <= now_ms {
            return Err(WorkerDurableError::Conflict(
                "pre-admission reservation expired; exact no-dispatch reconciliation is required",
            ));
        }
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        if pins.owner_epoch() != self.resumed_epoch
            || pins.owner().principal_ref() != root_owner.principal_ref()
            || pins.workspace_binding() != root_owner.workspace_binding()
            || managed_root_session_id(pins.parent_proof())? != root_owner.session_id()
            || pins.run_id() != root_owner.run_id()
            || pins.goal_id() != root_owner.goal_id()
            || pins.location_id() != root_owner.location_id()
        {
            return Err(WorkerDurableError::Conflict("reserved worktree target differs from authenticated root and Attempt pins"));
        }
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let worker = pool.worker(reservation.worker_execution_id())
            .ok_or(WorkerDurableError::NotFound("reserved worker lease unavailable"))?;
        let tree = pool.worktree_snapshot(&pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::NotFound("reserved worktree lease unavailable"))?;
        if worker.state != crate::resource_budget::ReservationState::Reserved
            || worker.cancellation_requested || worker.unknown_effect
            || worker.process_identity.is_some()
            || worker.worktree_lease_id.as_deref() != Some(reservation.workspace_lease_id())
            || tree.status != crate::worktree_pool::WorktreeStatus::Leased
            || tree.lease_id.as_deref() != Some(reservation.workspace_lease_id())
            || tree.workspace_binding != pins.workspace_binding()
        {
            return Err(WorkerDurableError::Conflict("reserved worktree target no longer matches P8 lease"));
        }
        let worktree_id = pins.worktree.worktree_id.as_str();
        let registration = self.identities.worktree_registration_records.get(worktree_id)
            .filter(|registration| registration.owner() == &root_owner
                && !self.identities.removed_worktree_registrations.contains_key(worktree_id)
                && registration.matches_durable_operations(&self.worktree_operations)
                && registration.verification_digest().is_some_and(|digest|
                    self.identities.verified_worktree_registrations.get(worktree_id).map(String::as_str) == Some(digest)))
            .ok_or(WorkerDurableError::Conflict("reserved worktree lacks exact verified registration"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "reserved worktree registration lacks guarded Create provenance",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .filter(|record| record.state() == WorktreeOperationStateV1::Completed
                && record.intent().kind() == WorktreeOperationKindV1::Create
                && record.intent().owner() == &root_owner
                && record.intent().worktree_id() == worktree_id
                && record.intent().base_revision() == Some(pins.worktree.base_revision.as_str())
                && record.intent().root().workspace_binding() == pins.workspace_binding()
                && record.receipt().is_some_and(|receipt| receipt.owned() && receipt.no_follow()))
            .ok_or(WorkerDurableError::Conflict("reserved worktree Create receipt does not match exact P8 pins"))?;
        let target = WorktreeLifecycleTargetV1 {
            owner: root_owner,
            worktree_id: worktree_id.to_owned(),
            base_revision: pins.worktree.base_revision.clone(),
            relative_path: create.intent().relative_path().to_path_buf(),
            verification_digest: registration.verification_digest().ok_or(WorkerDurableError::Conflict(
                "reserved worktree verification digest is unavailable",
            ))?.to_owned(),
        };
        Ok(ManagedAttemptWorktreeTargetV1 {
            target,
            root: create.intent().root().clone(),
            workspace_revision: pins.workspace_revision().to_owned(),
            binding_digest: String::new(),
            pool_revision: pool.revision(),
            admission: None,
            reservation_proof_digest: pins.staged_pre_admission
                .then(|| reservation.context_bound_receipt_digest()),
        })
    }

    /// Reserve a Rust-selected READY Task and resolve the exact registered
    /// worktree while the reservation is still pre-admission. Keeping these
    /// operations behind one P8 entry point makes it harder for the caller to
    /// accidentally project a target from the Goal root or from a different
    /// candidate after the durable reservation append.
    ///
    /// The returned target is read-only location evidence. It does not create
    /// an Attempt, attach a DelegationBinding, claim a worker, or grant dispatch
    /// authority. If target resolution fails after the reservation append, the
    /// reservation remains durable and must be recovered through the existing
    /// no-dispatch reconciliation path; this helper never rolls it back.
    pub(crate) fn reserve_managed_ready_task_with_target(
        &mut self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        pins: &ManagedReadyTaskPinV1,
    ) -> Result<(ReservedWorkerLeaseProofV1, ManagedAttemptWorktreeTargetV1), WorkerDurableError> {
        let reservation = self.reserve_managed_ready_task(pins)?;
        let mut target = self.resolve_reserved_managed_worktree_target(
            root_proof, now_ms, pins, &reservation,
        )?;
        target.reservation_proof_digest = Some(reservation.context_bound_receipt_digest());
        Ok((reservation, target))
    }

    /// Reconstruct the exact completed final Inspect receipt after restart.
    /// A completed operation pin alone is not settlement evidence: this method
    /// re-resolves the durable journal record and checks its immutable intent,
    /// root lineage, worker lease, candidate/revision, verifier-set identity and receipt.
    /// Possible-dispatch UNKNOWN operations intentionally have no receipt and
    /// remain unrecoverable here.
    pub(crate) fn resolve_managed_final_inspect_receipt(
        &self,
        idempotency_key: &str,
        worker_execution_id: &str,
        candidate: &crate::managed_control::ManagedAttemptSettlementCandidateV1,
        verifier_pins: &crate::host_kernel::SettledVerifierChallengeSetPinsV1,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<GuardedWorktreeReceiptV1, WorkerDurableError> {
        validate_final_inspect_verifier_pins(candidate, verifier_pins)?;
        self.resolve_managed_final_inspect_receipt_for_attempt(
            idempotency_key, worker_execution_id, candidate.attempt_id(),
            candidate.goal_id(), candidate.run_id(), candidate.task_id(),
            candidate.binding_digest(), candidate.spec_id(), candidate.spec_digest(), candidate.evidence_digest(),
            candidate.final_revision(), Some(managed_final_inspect_candidate_digest(
                candidate.attempt_id(), candidate.goal_id(), candidate.run_id(), candidate.task_id(),
                candidate.binding_digest(), candidate.spec_id(), candidate.spec_digest(),
                candidate.evidence_digest(), candidate.final_revision(), candidate.effect_chain_digest(),
                candidate.attempt_state_digest(), candidate.owner_log_id(), candidate.owner_log_sequence(),
                candidate.owner_log_event_digest(), candidate.managed_revision(), candidate.usage_accounting(),
                verifier_pins,
            )), verifier_pins, root_proof, now_ms,
        )
    }

    /// Resolve the exact final Inspect intent for a fresh Guard challenge after
    /// an idempotent prepare. A durable Completed operation is returned only
    /// after the exact candidate-bound receipt has been revalidated; this is a
    /// read-only projection and never grants possible-dispatch authority.
    pub(crate) fn resolve_managed_final_inspect_intent_for_candidate(
        &self,
        idempotency_key: &str,
        worker_execution_id: &str,
        candidate: &crate::managed_control::ManagedAttemptSettlementCandidateV1,
        verifier_pins: &crate::host_kernel::SettledVerifierChallengeSetPinsV1,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<GuardedWorktreeRequestV1, WorkerDurableError> {
        validate_final_inspect_verifier_pins(candidate, verifier_pins)?;
        validate_owner_token(idempotency_key)?;
        validate_owner_token(worker_execution_id)?;
        if idempotency_key != managed_final_inspect_idempotency_key(candidate.attempt_id()) {
            return Err(WorkerDurableError::Conflict(
                "managed final Inspect idempotency key is not derived from the settlement Attempt",
            ));
        }
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let operation_id = worktree_operation_id(
            &root_owner, WorktreeOperationKindV1::Inspect, idempotency_key,
        );
        let record = self.worktree_operations.get(&operation_id)
            .ok_or(WorkerDurableError::NotFound("managed final Inspect operation is unavailable"))?;
        let target = self.resolve_claimed_managed_worktree_target(
            root_proof, now_ms, worker_execution_id, candidate,
        )?;
        let expected_candidate_digest = managed_final_inspect_candidate_digest(
            candidate.attempt_id(), candidate.goal_id(), candidate.run_id(), candidate.task_id(),
            candidate.binding_digest(), candidate.spec_id(), candidate.spec_digest(),
            candidate.evidence_digest(), candidate.final_revision(), candidate.effect_chain_digest(),
            candidate.attempt_state_digest(), candidate.owner_log_id(), candidate.owner_log_sequence(),
            candidate.owner_log_event_digest(), candidate.managed_revision(), candidate.usage_accounting(),
            verifier_pins,
        );
        let pin = self.managed_final_inspect_candidate_pins.get(&operation_id)
            .ok_or(WorkerDurableError::Conflict("final Inspect has no durable P2 candidate pin"))?;
        let intent = record.intent();
        let pins = self.identities.pre_admission_pins.get(worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("managed final Inspect P8 pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(worker_execution_id)?;
        let binding = self.identities.delegation_bindings.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("managed final Inspect binding is unavailable"))?;
        let (ticket_id, expected_worker_id, _) = pre_admission_request(pins)?;
        if expected_worker_id.as_str() != worker_execution_id
            || pins.attempt_id() != candidate.attempt_id()
            || pins.goal_id() != candidate.goal_id()
            || pins.run_id() != candidate.run_id()
            || pins.task_id() != candidate.task_id()
            || claim.attempt_id() != candidate.attempt_id()
            || claim.binding_digest() != candidate.binding_digest()
            || binding.binding_digest != candidate.binding_digest()
            || !self.identities.claim_receipts.get(worker_execution_id)
                .is_some_and(|receipt| receipt.ticket_id == ticket_id)
            || pin.operation_id != operation_id
            || pin.candidate_digest != expected_candidate_digest
            || pin.attempt_id != candidate.attempt_id()
            || pin.binding_digest != candidate.binding_digest()
            || pin.spec_id != candidate.spec_id()
            || pin.spec_digest != candidate.spec_digest()
            || pin.evidence_digest != candidate.evidence_digest()
            || pin.final_revision != candidate.final_revision()
            || pin.verification_run_id.as_deref() != Some(verifier_pins.verification_run_id())
            || pin.set_identity_digest.as_deref() != Some(verifier_pins.set_identity_digest())
            || pin.challenge_set_digest.as_deref() != Some(verifier_pins.challenge_set_digest())
            || intent.kind() != WorktreeOperationKindV1::Inspect
            || intent.owner() != &root_owner
            || intent.root() != target.root()
            || intent.operation_id() != operation_id
            || intent.worktree_id() != target.target().worktree_id()
            || intent.relative_path() != target.target().relative_path()
            || intent.base_revision() != Some(target.target().base_revision())
            || target.workspace_revision() != candidate.final_revision()
            || intent.expected_workspace_revision() != candidate.final_revision()
        {
            return Err(WorkerDurableError::Conflict(
                "managed final Inspect intent differs from the exact current P8/P2 candidate pins",
            ));
        }
        match record.state() {
            WorktreeOperationStateV1::Pending => {}
            WorktreeOperationStateV1::Completed => {
                // A completed operation is safe to expose only for challenge
                // reconciliation after the durable Guard receipt is exact.
                self.resolve_managed_final_inspect_receipt(
                    idempotency_key, worker_execution_id, candidate, verifier_pins, root_proof, now_ms,
                )?;
            }
            WorktreeOperationStateV1::Unknown => return Err(WorkerDurableError::WorktreeIntentUnknown),
            WorktreeOperationStateV1::Quarantined => return Err(WorkerDurableError::WorktreeIntentQuarantined),
            WorktreeOperationStateV1::RetiredNoDispatch => return Err(WorkerDurableError::WorktreeIntentRetired),
        }
        Ok(GuardedWorktreeRequestV1::from_durable_intent(intent.clone()))
    }

    /// Resolve the same exact durable Inspect after P2 has settled the Attempt.
    /// The terminal projection must be a successful verified outcome and its
    /// observed head/evidence/binding and opaque verifier identity must match the
    /// original Inspect intent.
    pub(crate) fn resolve_managed_final_inspect_receipt_for_terminal(
        &self,
        idempotency_key: &str,
        worker_execution_id: &str,
        terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        verifier_pins: &crate::host_kernel::SettledVerifierChallengeSetPinsV1,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<GuardedWorktreeReceiptV1, WorkerDurableError> {
        if terminal.attempt_state() != crate::managed_control::ManagedAttemptTerminalStateV1::Succeeded
            || terminal.task_state() != crate::managed_control::ManagedTaskTerminalStateV1::Verified
            || terminal.effect_chain_state() != crate::managed_control::ManagedAttemptEffectChainStateV1::AllSettled
            || terminal.child_prompt_state() != crate::managed_control::ManagedChildPromptStateV1::Quiesced
        {
            return Err(WorkerDurableError::Conflict(
                "managed final Inspect terminal projection is not successfully verified and quiescent",
            ));
        }
        let durable_binding = self.identities.delegation_bindings.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("managed terminal final Inspect has no durable P8 binding"))?;
        if terminal.admission_workspace_revision() != Some(durable_binding.child_workspace_revision()?) {
            return Err(WorkerDurableError::Conflict(
                "managed terminal admission revision differs from the P8-pinned child workspace",
            ));
        }
        let evidence_digest = terminal.evidence_digest().ok_or(WorkerDurableError::Conflict(
            "managed final Inspect terminal projection has no verifier evidence digest",
        ))?;
        let final_revision = terminal.observed_workspace_head().ok_or(WorkerDurableError::Conflict(
            "managed final Inspect terminal projection has no observed workspace head",
        ))?;
        if verifier_pins.goal_id() != terminal.goal_id()
            || verifier_pins.run_id() != terminal.run_id()
            || verifier_pins.task_id() != terminal.task_id()
            || verifier_pins.attempt_id() != terminal.attempt_id()
            || verifier_pins.evidence_digest() != evidence_digest
            || validate_owner_token(verifier_pins.verification_run_id()).is_err()
            || !valid_digest(verifier_pins.set_identity_digest(), "blake3:")
            || !valid_digest(verifier_pins.challenge_set_digest(), "blake3:")
        {
            return Err(WorkerDurableError::Conflict(
                "settled verifier pins differ from the successful terminal projection",
            ));
        }
        self.resolve_managed_final_inspect_receipt_for_attempt(
            idempotency_key, worker_execution_id, terminal.attempt_id(),
            terminal.goal_id(), terminal.run_id(), terminal.task_id(),
            terminal.binding_digest(), terminal.spec_id(), terminal.spec_digest(), evidence_digest,
            final_revision, None, verifier_pins, root_proof, now_ms,
        )
    }

    fn resolve_managed_final_inspect_receipt_for_attempt(
        &self,
        idempotency_key: &str,
        worker_execution_id: &str,
        attempt_id: &str,
        goal_id: &str,
        run_id: &str,
        task_id: &str,
        binding_digest: &str,
        spec_id: &str,
        spec_digest: &str,
        evidence_digest: &str,
        final_revision: &str,
        candidate_digest: Option<String>,
        verifier_pins: &crate::host_kernel::SettledVerifierChallengeSetPinsV1,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<GuardedWorktreeReceiptV1, WorkerDurableError> {
        validate_owner_token(idempotency_key)?;
        validate_owner_token(worker_execution_id)?;
        if idempotency_key != managed_final_inspect_idempotency_key(attempt_id) {
            return Err(WorkerDurableError::Conflict(
                "managed final Inspect idempotency key is not derived from the settlement Attempt",
            ));
        }
        if !valid_digest(binding_digest, "blake3:")
            || !valid_digest(spec_digest, "blake3:")
            || !valid_digest(evidence_digest, "blake3:")
            || !valid_digest(final_revision, "blake3:")
        {
            return Err(WorkerDurableError::Conflict(
                "managed final Inspect terminal evidence contains an invalid digest",
            ));
        }
        if verifier_pins.goal_id() != goal_id || verifier_pins.run_id() != run_id
            || verifier_pins.task_id() != task_id || verifier_pins.attempt_id() != attempt_id
            || verifier_pins.evidence_digest() != evidence_digest
            || validate_owner_token(verifier_pins.verification_run_id()).is_err()
            || !valid_digest(verifier_pins.set_identity_digest(), "blake3:")
            || !valid_digest(verifier_pins.challenge_set_digest(), "blake3:")
        {
            return Err(WorkerDurableError::Conflict(
                "terminal final Inspect verifier pins differ from authenticated evidence scope",
            ));
        }
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let pins = self.identities.pre_admission_pins.get(worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("managed final Inspect P8 pins unavailable"))?;
        let claim = self.identities.claim_receipts.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("durable claim receipt is unavailable"))?;
        let binding = self.identities.delegation_bindings.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("managed worker binding is unavailable"))?;
        let mut matching_operations = self.worktree_operations.iter().filter(|record| {
            let intent = record.intent();
            intent.kind() == WorktreeOperationKindV1::Inspect
                && same_worktree_root_lineage(intent.owner(), &root_owner)
                && intent.owner().owner_epoch() <= root_owner.owner_epoch()
                && worktree_operation_id(intent.owner(), WorktreeOperationKindV1::Inspect, idempotency_key)
                    == intent.operation_id()
        });
        let record = matching_operations.next()
            .ok_or(WorkerDurableError::NotFound("managed final Inspect operation is unavailable"))?;
        if matching_operations.next().is_some() {
            return Err(WorkerDurableError::ReplayConflict(
                "Attempt-derived final Inspect key maps to multiple durable operations",
            ));
        }
        let operation_id = record.intent().operation_id();
        let intent = record.intent();
        let candidate_pin = self.managed_final_inspect_candidate_pins.get(operation_id)
            .ok_or(WorkerDurableError::Conflict("final Inspect has no durable P2 candidate pin"))?;
        if candidate_pin.attempt_id != attempt_id
            || candidate_pin.binding_digest != binding_digest
            || candidate_pin.spec_id != spec_id
            || candidate_pin.spec_digest != spec_digest
            || candidate_pin.evidence_digest != evidence_digest
            || candidate_pin.final_revision != final_revision
            || candidate_pin.verification_run_id.as_deref() != Some(verifier_pins.verification_run_id())
            || candidate_pin.set_identity_digest.as_deref() != Some(verifier_pins.set_identity_digest())
            || candidate_pin.challenge_set_digest.as_deref() != Some(verifier_pins.challenge_set_digest())
            || candidate_digest.as_deref().is_some_and(|digest| candidate_pin.candidate_digest != digest)
        {
            return Err(WorkerDurableError::Conflict(
                "terminal settlement does not match the durably pinned final Inspect candidate",
            ));
        }
        let receipt = record.receipt().ok_or(WorkerDurableError::Conflict(
            "managed final Inspect has no durable completed Guard receipt",
        ))?;
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(worker_execution_id))
            .ok_or(WorkerDurableError::NotFound("managed final Inspect worker is unavailable"))?;
        let tree = self.pool.as_ref().and_then(|pool| pool.worktree_snapshot(&pins.worktree.worktree_id))
            .ok_or(WorkerDurableError::NotFound("managed final Inspect worktree lease is unavailable"))?;
        let (expected_ticket_id, expected_worker_id, _) = pre_admission_request(pins)?;
        let claim_sequence = claim.owner_log_sequence.parse::<u64>().ok();
        let current_sequence = self.cursor.as_ref()
            .and_then(|cursor| cursor.seq.parse::<u64>().ok());
        let current_pool_revision = self.pool.as_ref().map(WorkerPool::revision);
        let registration = self.identities.worktree_registration_records.get(&pins.worktree.worktree_id)
            .filter(|registration| same_worktree_root_lineage(registration.owner(), &root_owner)
                && registration.owner().owner_epoch() <= root_owner.owner_epoch()
                && !self.identities.removed_worktree_registrations.contains_key(&pins.worktree.worktree_id)
                && registration.matches_durable_operations(&self.worktree_operations))
            .ok_or(WorkerDurableError::Conflict("managed final Inspect registration is not durably verified"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "managed final Inspect registration provenance is unavailable",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .filter(|create| create.state() == WorktreeOperationStateV1::Completed
                && create.intent().kind() == WorktreeOperationKindV1::Create
                && same_worktree_root_lineage(create.intent().owner(), &root_owner)
                && create.intent().owner().owner_epoch() <= root_owner.owner_epoch()
                && create.intent().worktree_id() == pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::Conflict("managed final Inspect Create provenance is unavailable"))?;
        if record.state() != WorktreeOperationStateV1::Completed
            || intent.kind() != WorktreeOperationKindV1::Inspect
            || !same_worktree_root_lineage(intent.owner(), &root_owner)
            || intent.owner().owner_epoch() > root_owner.owner_epoch()
            || worktree_operation_id(intent.owner(), WorktreeOperationKindV1::Inspect, idempotency_key) != operation_id
            || intent.worktree_id() != pins.worktree.worktree_id
            || intent.base_revision() != Some(pins.worktree.base_revision.as_str())
            || intent.expected_workspace_revision() != final_revision
            || intent.root() != create.intent().root()
            || intent.relative_path() != create.intent().relative_path()
            || intent.root().workspace_binding() != pins.workspace_binding()
            || intent.root().workspace_binding() != root_owner.workspace_binding()
            || intent.root().location_ref() != pins.location_id()
            || intent.root().location_ref() != root_proof.location_id()
            || pins.owner_epoch() > self.resumed_epoch
            || pins.goal_id() != goal_id
            || pins.run_id() != run_id
            || pins.task_id() != task_id
            || pins.attempt_id() != attempt_id
            || pins.accepted_spec_digest() != spec_digest
            || expected_worker_id != worker_execution_id
            || pins.attempt_id() != claim.attempt_id
            || claim.worker_pool_revision == 0
            || claim.ticket_id != expected_ticket_id
            || claim.owner_log_id != self.pool_id
            || claim_sequence.is_none_or(|sequence| sequence == 0
                || current_sequence.is_none_or(|current| sequence > current))
            || current_pool_revision.is_none_or(|revision| claim.worker_pool_revision > revision)
            || !valid_digest(&claim.owner_log_event_digest, "blake3:")
            || claim.pins_digest != pins.pins_digest()
            || claim.binding_digest != binding.binding_digest
            || binding_digest != binding.binding_digest
            || binding.worktree_admission.as_ref().is_none_or(|admission|
                admission.worktree_id != pins.worktree.worktree_id
                    || admission.base_revision != pins.worktree.base_revision
                    || admission.root_location_id != pins.location_id
                    || admission.p8_workspace_binding != pins.workspace_binding()
                    || self.pool.as_ref().and_then(|pool|
                        pool.worker_source_revision(worker_execution_id))
                        != Some(admission.child_workspace_revision.as_str()))
            || pins.owner().principal_ref() != root_owner.principal_ref()
            || pins.owner().workspace_binding() != root_owner.workspace_binding()
            || pins.run_id() != root_owner.run_id()
            || pins.goal_id() != root_owner.goal_id()
            || pins.location_id() != root_owner.location_id()
            || !matches!(worker.state, crate::resource_budget::ReservationState::Claimed
                | crate::resource_budget::ReservationState::Quarantined)
            || worker.owner.owner_epoch != pins.owner_epoch()
            || worker.cancellation_requested
            || worker.process_identity.is_some()
            || worker.worktree_lease_id.as_deref() != tree.lease_id.as_deref()
            || !matches!(tree.status, crate::worktree_pool::WorktreeStatus::Leased
                | crate::worktree_pool::WorktreeStatus::Quarantined)
            || tree.workspace_binding != pins.workspace_binding()
            || receipt.operation_id() != operation_id
            || receipt.workspace_binding() != intent.root().workspace_binding()
            || receipt.registration_generation() != intent.root().registration_generation()
            || receipt.observed_workspace_revision() != final_revision
            || !final_inspect_allows_verified_settlement(receipt)
        {
            return Err(WorkerDurableError::Conflict(
            "durable final Inspect receipt does not match the P8 claim, idempotency key and settlement candidate",
            ));
        }
        Ok(receipt.clone())
    }

    pub(crate) fn prepare_worktree_release_pin(
        &mut self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        idempotency_key: &str,
        root: crate::worktree_lifecycle::WorkspaceRootRefV1,
        workspace_revision: &str,
        target: &WorktreeLifecycleTargetV1,
    ) -> Result<WorktreeLifecycleOperationPinV1, WorkerDurableError> {
        self.prepare_worktree_operation_pin(
            root_proof, now_ms, idempotency_key, WorktreeOperationKindV1::Release,
            root, target.base_revision(), workspace_revision, Some(target),
        )
    }

    fn prepare_worktree_operation_pin(
        &mut self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        idempotency_key: &str,
        kind: WorktreeOperationKindV1,
        root: crate::worktree_lifecycle::WorkspaceRootRefV1,
        base_revision: &str,
        workspace_revision: &str,
        target: Option<&WorktreeLifecycleTargetV1>,
    ) -> Result<WorktreeLifecycleOperationPinV1, WorkerDurableError> {
        validate_owner_token(idempotency_key)?;
        validate_owner_token(base_revision)?;
        validate_owner_token(workspace_revision)?;
        let owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        if let Some(previous) = self.resolve_worktree_operation_for_idempotency(
            kind, idempotency_key, root_proof, now_ms,
        )? {
            match previous {
                WorktreeOperationResolutionV1::Pending(pin) if pin.owner() != &owner => {
                    return Err(WorkerDurableError::Conflict(
                        "old-root pending operation must be retired as NotAdmittedNoDispatch before retry",
                    ));
                }
                WorktreeOperationResolutionV1::RetiredNoDispatch(_) => {
                    return Err(WorkerDurableError::Conflict(
                        "consume the durable NotAdmittedNoDispatch/EXPIRED receipt before using a new idempotency key",
                    ));
                }
                WorktreeOperationResolutionV1::PossibleDispatchUnknown => {
                    return Err(WorkerDurableError::Conflict(
                        "possible-dispatch operation requires reconciliation and cannot be retried",
                    ));
                }
                WorktreeOperationResolutionV1::Completed(pin) if pin.owner() != &owner => {
                    return Err(WorkerDurableError::Conflict(
                        "completed operation belongs to a stale root and cannot be replayed",
                    ));
                }
                WorktreeOperationResolutionV1::None
                | WorktreeOperationResolutionV1::Pending(_)
                | WorktreeOperationResolutionV1::Completed(_) => {}
            }
        }
        if root.location_ref() != owner.location_id()
            || root.workspace_binding() != owner.workspace_binding()
            || root.registration_generation() == 0
        {
            return Err(WorkerDurableError::Conflict("worktree root differs from authenticated Run location"));
        }
        let operation_id = worktree_operation_id(&owner, kind, idempotency_key);
        if let Some(record) = self.worktree_operations.get(&operation_id) {
            let intent = record.intent();
            let expected_target = target.map(|target| (target.worktree_id(), target.relative_path()));
            let consistent = intent.owner() == &owner
                && intent.kind() == kind
                && intent.root() == &root
                && intent.base_revision() == Some(base_revision)
                && intent.expected_workspace_revision() == workspace_revision
                && expected_target.is_none_or(|(id, path)| intent.worktree_id() == id && intent.relative_path() == path);
            return if consistent {
                Ok(WorktreeLifecycleOperationPinV1::from_durable_intent(intent.clone()))
            } else {
                Err(WorkerDurableError::Conflict("worktree operation idempotency key reused with different pins"))
            };
        }
        let (log_id, sequence, event_digest, _) = self.owner_log_watermark()?;
        let (worktree_id, relative_path) = match target {
            Some(target) if target.owner() == &owner => (
                target.worktree_id().to_owned(), target.relative_path().to_path_buf(),
            ),
            Some(_) => return Err(WorkerDurableError::Conflict("worktree target is outside current root owner")),
            None if kind == WorktreeOperationKindV1::Create => {
                let id = worktree_candidate_id(&operation_id);
                (id.clone(), std::path::PathBuf::from(".horizon/worktrees").join(id))
            }
            None => return Err(WorkerDurableError::Conflict("inspect/release requires a P8-selected worktree target")),
        };
        if kind == WorktreeOperationKindV1::Create
            && (self.identities.verified_worktree_registrations.contains_key(&worktree_id)
                || self.identities.removed_worktree_registrations.contains_key(&worktree_id))
        {
            return Err(WorkerDurableError::Conflict("allocated worktree ID was previously used"));
        }
        let intent = WorktreeOperationIntentV1::new(
            operation_id.clone(), kind, owner, root, worktree_id, base_revision.to_owned(),
            relative_path, workspace_revision.to_owned(), log_id, sequence, event_digest,
        ).map_err(map_worktree_lifecycle_error)?;
        let delivery_id = format!("worktree-intent-{operation_id}");
        self.persist_worktree_intent(&delivery_id, intent.clone())?;
        Ok(WorktreeLifecycleOperationPinV1::from_durable_intent(intent))
    }

    /// Resolve a lifecycle idempotency key across root process/epoch changes.
    /// This returns an existing durable outcome; it never creates or dispatches
    /// an operation. A retired operation returns the same terminal receipt so
    /// callers can observe NotAdmittedNoDispatch/EXPIRED before selecting a new
    /// idempotency key.
    pub(crate) fn resolve_worktree_operation_for_idempotency(
        &self,
        kind: WorktreeOperationKindV1,
        idempotency_key: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<Option<WorktreeOperationResolutionV1>, WorkerDurableError> {
        validate_owner_token(idempotency_key)?;
        let current_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let mut found: Option<WorktreeOperationResolutionV1> = None;
        for record in self.worktree_operations.iter() {
            let intent = record.intent();
            if intent.kind() != kind
                || !same_worktree_root_lineage(intent.owner(), &current_owner)
                || worktree_operation_id(intent.owner(), kind, idempotency_key) != intent.operation_id()
            {
                continue;
            }
            if found.is_some() {
                return Err(WorkerDurableError::Conflict(
                    "worktree idempotency key matches multiple durable operations",
                ));
            }
            let resolution = if let Some(receipt) = self.worktree_retirement_receipts.get(intent.operation_id()) {
                WorktreeOperationResolutionV1::RetiredNoDispatch(receipt.clone())
            } else {
                match record.state() {
                    WorktreeOperationStateV1::Pending => WorktreeOperationResolutionV1::Pending(
                        WorktreeLifecycleOperationPinV1::from_durable_intent(intent.clone()),
                    ),
                    WorktreeOperationStateV1::Completed => WorktreeOperationResolutionV1::Completed(
                        WorktreeLifecycleOperationPinV1::from_durable_intent(intent.clone()),
                    ),
                    WorktreeOperationStateV1::Unknown | WorktreeOperationStateV1::Quarantined => {
                        WorktreeOperationResolutionV1::PossibleDispatchUnknown
                    }
                    WorktreeOperationStateV1::RetiredNoDispatch => {
                        return Err(WorkerDurableError::Conflict(
                            "retired operation has no durable retirement receipt",
                        ));
                    }
                }
            };
            found = Some(resolution);
        }
        Ok(found)
    }

    /// Retire an old-root intent only when a fresh authenticated root proves
    /// the same Goal/Run/Session/Location/workspace lineage. Pending plus no
    /// receipt/marker is exact no-dispatch evidence; this append changes only
    /// journal accounting and never mutates a worktree or grants new authority.
    pub(crate) fn retire_pending_worktree_no_dispatch(
        &mut self,
        operation_id: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<WorktreeOperationRetirementReceiptV1, WorkerDurableError> {
        let current_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        if let Some(receipt) = self.worktree_retirement_receipts.get(operation_id) {
            return if same_worktree_root_lineage(receipt.current_owner(), &current_owner) {
                Ok(receipt.clone())
            } else {
                Err(WorkerDurableError::Conflict("retirement receipt belongs to a different root lineage"))
            };
        }
        let record = self.worktree_operations.get(operation_id).ok_or(
            WorkerDurableError::NotFound("pending worktree operation is missing"),
        )?;
        if record.state() != WorktreeOperationStateV1::Pending
            || record.receipt().is_some()
            || !same_worktree_root_lineage(record.intent().owner(), &current_owner)
        {
            return Err(WorkerDurableError::Conflict(
                "only an exact old-root Pending operation with unchanged Run lineage may be retired",
            ));
        }
        let old_owner_digest = record.intent().owner().root_digest().to_owned();
        let intent_digest = worktree_intent_digest(record.intent());
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        self.apply(revision, &format!("worktree-retire-no-dispatch-{operation_id}"),
            WorkerCommand::WorktreeOperationRetiredNoDispatch {
                current_owner,
                operation_id: operation_id.to_owned(),
                intent_digest,
            })?;
        self.worktree_retirement_receipts.get(operation_id).cloned().ok_or(
            WorkerDurableError::Invalid("durable no-dispatch retirement receipt is unavailable"),
        )
    }

    pub(crate) fn persist_guarded_worktree_removal(
        &mut self,
        delivery_id: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        release_operation_id: &str,
    ) -> Result<WorktreeRegistrationRemovalReceiptV1, WorkerDurableError> {
        let owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        if let Some(previous) = self.worktree_removal_receipts.get(delivery_id) {
            if previous.owner() == &owner && previous.release_operation_id() == release_operation_id {
                return Ok(previous.clone());
            }
            return Err(WorkerDurableError::Conflict(
                "worktree removal delivery was reused with different authority",
            ));
        }
        let record = self.worktree_operations.get(release_operation_id).ok_or(
            WorkerDurableError::NotFound("worktree release operation is not durable"),
        )?;
        if !self.worktree_operations.is_release_safe(release_operation_id)
            || record.intent().owner() != &owner
            || !self.identities.verified_worktree_registrations.contains_key(record.intent().worktree_id())
            || !self.identities.root_coordinators.get(owner.coordinator_id())
                .is_some_and(|root| worktree_root_owner_matches_execution(&owner, root))
        {
            return Err(WorkerDurableError::Conflict("worktree removal requires exact clean guarded release receipt"));
        }
        let worktree_id = record.intent().worktree_id().to_owned();
        let release_receipt_ref = record.receipt().ok_or(
            WorkerDurableError::NotFound("worktree release receipt is missing"),
        )?.host_receipt_ref().to_owned();
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        self.apply(revision, delivery_id, WorkerCommand::WorktreeRegistrationRemoved {
            owner, operation_id: release_operation_id.to_owned(),
            worktree_id: worktree_id.clone(),
        })?;
        self.worktree_removal_receipts.get(delivery_id).cloned().ok_or(
            WorkerDurableError::Invalid("durable worktree removal receipt is unavailable"),
        )
    }

    fn build_worktree_removal_receipt(
        &mut self,
        delivery_id: &str,
        worktree_id: &str,
        release_operation_id: &str,
        release_receipt_ref: &str,
        cursor: &CursorV1,
    ) -> Result<WorktreeRegistrationRemovalReceiptV1, WorkerDurableError> {
        if let Some(previous) = self.worktree_removal_receipts.get(delivery_id) {
            return Ok(previous.clone());
        }
        let owner = self.worktree_operations.get(release_operation_id)
            .ok_or(WorkerDurableError::NotFound("worktree release operation is missing"))?
            .intent().owner().clone();
        let tombstone_digest = self.identities.removed_worktree_registrations.get(worktree_id)
            .ok_or(WorkerDurableError::NotFound("worktree tombstone is missing"))?.clone();
        let worker_pool_revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        let receipt = WorktreeRegistrationRemovalReceiptV1::from_committed_event(
            owner, worktree_id.to_owned(), release_operation_id.to_owned(),
            release_receipt_ref.to_owned(), tombstone_digest, cursor, worker_pool_revision,
        );
        self.worktree_removal_receipts.insert(delivery_id.to_owned(), receipt.clone());
        Ok(receipt)
    }

    fn pre_admission_reservations_pending_reconciliation(&self) -> Vec<String> {
        let Some(pool) = self.pool.as_ref() else { return Vec::new() };
        self.identities.pre_admission_pins.keys().filter(|worker_id| {
            pool.worker(worker_id).is_some_and(|worker|
                worker.state == crate::resource_budget::ReservationState::Reserved)
        }).cloned().collect()
    }

    pub(crate) fn worktree_operations(&self) -> &WorktreeOperationJournalV1 {
        &self.worktree_operations
    }

    pub(crate) fn owner_log_watermark(
        &self,
    ) -> Result<(String, String, String, u64), WorkerDurableError> {
        let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
            "worker OwnerLog cursor is unavailable",
        ))?;
        let revision = self
            .pool
            .as_ref()
            .map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        Ok((
            cursor.owner_id.clone(),
            cursor.seq.clone(),
            cursor.event_digest.clone(),
            revision,
        ))
    }

    /// Durably reserve a READY Task from P1's opaque authenticated pin. The
    /// delivery/worker/ticket identities are derived from the canonical pin
    /// digest, so replay of the same candidate Attempt returns the same lease.
    /// No request field can choose a worker identity or widen the budget.
    pub(crate) fn reserve_managed_ready_task(
        &mut self,
        pins: &ManagedReadyTaskPinV1,
    ) -> Result<ReservedWorkerLeaseProofV1, WorkerDurableError> {
        pins.validate()?;
        if self.identities.pre_admission_pins.values().any(|existing|
            existing.attempt_id() == pins.attempt_id() && existing != pins)
        {
            return Err(WorkerDurableError::Conflict(
                "candidate Attempt ID is already pinned to different pre-admission facts",
            ));
        }
        if pins.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        self.validate_managed_parent_pin(pins, now_ms())?;
        let (ticket_id, worker_execution_id, request) = pre_admission_request(pins)?;
        let (_, _, delivery_id) = pre_admission_ids(pins);
        let revision = self.pool.as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?.revision();
        if let Some(existing) = self.identities.pre_admission_pins.get(&worker_execution_id) {
            if existing != pins {
                return Err(WorkerDurableError::Conflict("candidate Attempt was replayed with different pins"));
            }
            let attached = self.identities.delegation_bindings.get(&worker_execution_id)
                .map(|binding| binding.binding_digest.as_str());
            return self.reserved_worker_proof(pins, &ticket_id, &worker_execution_id, attached);
        }
        self.apply(revision, &delivery_id, WorkerCommand::PreAdmissionReserved {
            pins: pins.clone(), request, ticket_id: ticket_id.clone(),
            worker_execution_id: worker_execution_id.clone(), now_ms: now_ms(),
        })?;
        self.reserved_worker_proof(pins, &ticket_id, &worker_execution_id, None)
    }

    /// Stage A: reserve the exact bounded candidate and return its read-only
    /// worktree target before Core compiles ContextSelection. The identity is
    /// based on all authenticated pre-context pins plus the stable idempotency
    /// key; no candidate is dispatched or admitted here.
    pub(crate) fn reserve_managed_pre_admission_target(
        &mut self,
        pins: &ManagedPreAdmissionTargetPinsV1,
    ) -> Result<ReservedPreAdmissionTargetProofV1, WorkerDurableError> {
        let pins = &pins.pins;
        pins.validate()?;
        if !pins.staged_pre_admission || pins.context_selection_digest.is_some() {
            return Err(WorkerDurableError::Conflict("Stage-A pins must omit ContextSelection"));
        }
        if pins.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let candidate_worker_id = pre_admission_ids(pins).1;
        if self.identities.pre_admission_pins.iter().any(|(existing_worker, existing)|
            existing.attempt_id() == pins.attempt_id() && existing_worker != &candidate_worker_id)
        {
            return Err(WorkerDurableError::Conflict(
                "candidate Attempt already has a different durable Stage-A identity; reconcile and advance generation",
            ));
        }
        let (ticket_id, worker_id, request) = pre_admission_request(pins)?;
        let (_, _, delivery_id) = pre_admission_ids(pins);
        let revision = self.pool.as_ref().ok_or(WorkerDurableError::Invalid(
            "worker pool is unavailable",
        ))?.revision();
        if let Some(existing) = self.identities.pre_admission_pins.get(&worker_id) {
            if existing.expires_at_ms <= now_ms() {
                return Err(WorkerDurableError::Conflict(
                    "existing pre-admission reservation expired; reconcile before a new candidate",
                ));
            }
            let mut existing_pre_context = existing.clone();
            if existing_pre_context.staged_pre_admission {
                existing_pre_context.context_selection_digest = None;
                existing_pre_context.pins_digest = existing_pre_context.compute_digest();
            }
            if &existing_pre_context != pins {
                return Err(WorkerDurableError::Conflict(
                    "candidate identity is already reserved with different pre-context pins",
                ));
            }
            let reservation = self.reserved_worker_proof(existing, &ticket_id, &worker_id, None)?;
            return Ok(ReservedPreAdmissionTargetProofV1::new(
                ManagedPreAdmissionTargetPinsV1 { pins: pins.clone() }, reservation,
            ));
        }
        self.validate_managed_parent_pin(pins, now_ms())?;
        self.apply(revision, &delivery_id, WorkerCommand::PreAdmissionReserved {
            pins: pins.clone(), request, ticket_id: ticket_id.clone(),
            worker_execution_id: worker_id.clone(), now_ms: now_ms(),
        })?;
        let reservation = self.reserved_worker_proof(pins, &ticket_id, &worker_id, None)?;
        Ok(ReservedPreAdmissionTargetProofV1::new(
            ManagedPreAdmissionTargetPinsV1 { pins: pins.clone() }, reservation,
        ))
    }

    /// Resolve the exact Stage-A target from the persisted candidate and
    /// proof after restart. It never searches for or substitutes another tree.
    pub(crate) fn resolve_reserved_managed_pre_admission_target(
        &self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        pins: &ManagedPreAdmissionTargetPinsV1,
        proof: &ReservedPreAdmissionTargetProofV1,
    ) -> Result<(ReservedPreAdmissionTargetProofV1, ManagedAttemptWorktreeTargetV1), WorkerDurableError> {
        if proof.pins != *pins || proof.proof_digest != ReservedPreAdmissionTargetProofV1::new(
            pins.clone(), proof.reservation.clone(),
        ).proof_digest {
            return Err(WorkerDurableError::Conflict("Stage-A proof differs from the exact candidate"));
        }
        let current_pins = self.identities.pre_admission_pins.get(proof.worker_execution_id())
            .ok_or(WorkerDurableError::NotFound("Stage-A candidate is not in the OwnerLog"))?;
        let mut current_pre_context = current_pins.clone();
        current_pre_context.context_selection_digest = None;
        current_pre_context.pins_digest = current_pre_context.compute_digest();
        if current_pre_context != pins.pins {
            return Err(WorkerDurableError::Conflict("persisted candidate differs from Stage-A pins"));
        }
        let reservation = self.reserved_worker_proof(
            current_pins, proof.ticket_id(), proof.worker_execution_id(), None,
        )?;
        let current_proof = ReservedPreAdmissionTargetProofV1::new(pins.clone(), reservation);
        let mut target = self.resolve_reserved_managed_worktree_target(
            root_proof, now_ms, current_pins, &current_proof.reservation,
        )?;
        target.reservation_proof_digest = Some(if current_proof.context_selection_digest().is_some() {
            current_proof.reservation_receipt_digest()
        } else {
            current_proof.proof_digest().to_owned()
        });
        Ok((current_proof, target))
    }

    /// Restart resolver: candidate identity and stable idempotency key locate
    /// the one durable reservation; all P8-issued pins (deadline and exact
    /// worktree selection included) are returned from OwnerLog unchanged.
    pub(crate) fn resolve_managed_pre_admission_target_for_candidate(
        &self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        candidate_attempt_id: &str,
        idempotency_key: &str,
    ) -> Result<(ManagedPreAdmissionTargetPinsV1, ReservedPreAdmissionTargetProofV1,
        ManagedAttemptWorktreeTargetV1), WorkerDurableError> {
        validate_owner_token(candidate_attempt_id)?;
        if idempotency_key.is_empty() || idempotency_key.len() > 256
            || idempotency_key.chars().any(char::is_control)
        {
            return Err(WorkerDurableError::Invalid("invalid pre-admission idempotency key"));
        }
        let candidates = self.identities.pre_admission_pins.values()
            .filter(|pins| pins.attempt_id() == candidate_attempt_id).collect::<Vec<_>>();
        if !candidates.is_empty() && !candidates.iter().any(|pins|
            pins.staged_pre_admission && pins.idempotency_key == idempotency_key)
        {
            return Err(WorkerDurableError::Conflict(
                "candidate Attempt exists under different P8 idempotency pins",
            ));
        }
        let mut matches = candidates.into_iter().filter(|pins|
            pins.staged_pre_admission && pins.idempotency_key == idempotency_key);
        let persisted = matches.next().ok_or(WorkerDurableError::NotFound(
            "candidate has no durable P8 pre-admission reservation",
        ))?.clone();
        if matches.next().is_some() {
            return Err(WorkerDurableError::Conflict("candidate idempotency key maps to multiple P8 reservations"));
        }
        let mut stage_a_pins = persisted.clone();
        stage_a_pins.context_selection_digest = None;
        stage_a_pins.pins_digest = stage_a_pins.compute_digest();
        let stage_a_pins = ManagedPreAdmissionTargetPinsV1 { pins: stage_a_pins };
        let (ticket_id, worker_id, _) = pre_admission_request(&persisted)?;
        let reservation = self.reserved_worker_proof(&persisted, &ticket_id, &worker_id, None)?;
        let proof = ReservedPreAdmissionTargetProofV1::new(stage_a_pins.clone(), reservation);
        let mut target = self.resolve_reserved_managed_worktree_target(
            root_proof, now_ms, &persisted, &proof.reservation,
        )?;
        target.reservation_proof_digest = Some(if proof.context_selection_digest().is_some() {
            proof.reservation_receipt_digest()
        } else {
            proof.proof_digest().to_owned()
        });
        Ok((stage_a_pins, proof, target))
    }

    /// Stage B: bind the exact Rust-validated ContextSelection to the same
    /// still-RESERVED Stage-A lease. Returns canonical pins plus the exact
    /// reservation proof admission must consume; it never reserves again.
    pub(crate) fn bind_managed_pre_admission_context_digest(
        &mut self,
        proof: &ReservedPreAdmissionTargetProofV1,
        context_selection_digest: &str,
    ) -> Result<(ManagedReadyTaskPinV1, ReservedWorkerLeaseProofV1), WorkerDurableError> {
        validate_owner_digest(context_selection_digest, "blake3:")?;
        let stored = self.identities.pre_admission_pins.get(proof.worker_execution_id())
            .ok_or(WorkerDurableError::NotFound("Stage-A candidate pins unavailable"))?;
        let mut persisted_stage_a = stored.clone();
        persisted_stage_a.context_selection_digest = None;
        persisted_stage_a.pins_digest = persisted_stage_a.compute_digest();
        let mut supplied_stage_a = proof.pins.pins.clone();
        supplied_stage_a.context_selection_digest = None;
        supplied_stage_a.pins_digest = supplied_stage_a.compute_digest();
        if !stored.staged_pre_admission || proof.pins.pins.context_selection_digest.is_some()
            || supplied_stage_a != persisted_stage_a
            || proof.worker_execution_id() != pre_admission_ids(stored).1
            || proof.ticket_id() != pre_admission_ids(stored).0
            || proof.proof_digest != ReservedPreAdmissionTargetProofV1::new(
                proof.pins.clone(), proof.reservation.clone(),
            ).proof_digest
        {
            return Err(WorkerDurableError::Conflict("Stage-B pins differ from Stage-A candidate"));
        }
        if stored.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        if stored.expires_at_ms <= now_ms() {
            return Err(WorkerDurableError::Conflict(
                "pre-admission reservation expired before ContextSelection bind; reconcile without dispatch",
            ));
        }
        let mut bound = stored.clone();
        if bound.context_selection_digest.as_deref().is_some_and(|existing|
            existing != context_selection_digest)
        {
            return Err(WorkerDurableError::Conflict("ContextSelection is already bound differently"));
        }
        bound.context_selection_digest = Some(context_selection_digest.to_owned());
        bound.pins_digest = bound.compute_digest();
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(proof.worker_execution_id()))
            .ok_or(WorkerDurableError::NotFound("Stage-A reserved worker unavailable"))?;
        if worker.state != crate::resource_budget::ReservationState::Reserved
            || worker.cancellation_requested || worker.unknown_effect || worker.process_identity.is_some()
            || self.identities.delegation_bindings.contains_key(proof.worker_execution_id())
        {
            return Err(WorkerDurableError::Conflict("Stage-B requires the same unclaimed RESERVED lease"));
        }
        let current = self.identities.pre_admission_pins.get(proof.worker_execution_id())
            .ok_or(WorkerDurableError::NotFound("Stage-A candidate pins unavailable"))?;
        let (_, _, delivery_id) = pre_admission_ids(&bound);
        if current != &bound {
            let revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
            self.apply(revision, &format!("{delivery_id}-context-bound"),
                WorkerCommand::PreAdmissionContextBound {
                    worker_execution_id: proof.worker_execution_id().to_owned(),
                    ticket_id: proof.ticket_id().to_owned(), pins: bound.clone(),
                })?;
        }
        let reservation = self.reserved_worker_proof(
            &bound, proof.ticket_id(), proof.worker_execution_id(), None,
        )?;
        Ok((bound, reservation))
    }

    /// Test adapter for the real two-stage managed-admission lease contract.
    /// The caller supplies complete authenticated Stage-A pins and the exact
    /// ContextSelection digest. Both transitions are persisted through this
    /// live OwnerLog, and the returned opaque proof is resolved from the actual
    /// cursor and pool revision; this helper never constructs proof fields.
    #[cfg(test)]
    pub(crate) fn test_reserve_and_bind_managed_pre_admission(
        &mut self,
        pins: &ManagedPreAdmissionTargetPinsV1,
        context_selection_digest: &str,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<(ManagedReadyTaskPinV1, DurableManagedLeaseProofV1), WorkerDurableError> {
        let stage_a = self.reserve_managed_pre_admission_target(pins)?;
        let (ready_pins, reservation) = self.bind_managed_pre_admission_context_digest(
            &stage_a,
            context_selection_digest,
        )?;
        let lease_proof = self.resolve_pre_admission_admission_lease_proof(
            &ready_pins,
            &reservation,
            owner,
            now_ms,
        )?;
        Ok((ready_pins, lease_proof))
    }

    /// Test-support composition for the authenticated managed-admission
    /// journey. The caller must supply the same opaque registration minted
    /// from guarded Create+Inspect receipts and the complete HostKernel pins;
    /// this method persists/re-resolves root lineage and worktree registration
    /// before deriving Stage A, Stage B, and the current lease proof.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn test_reserve_authenticated_managed_pre_admission(
        &mut self,
        root_pins: &RootCoordinatorRegistrationPinsV1,
        root_delivery_id: &str,
        registration_delivery_id: &str,
        registration_owner: &WorktreeRootOwnerV1,
        create_intent: &WorktreeOperationIntentV1,
        create_receipt: &GuardedWorktreeReceiptV1,
        inspect_intent: &WorktreeOperationIntentV1,
        inspect_receipt: &GuardedWorktreeReceiptV1,
        canonical_worktree_path: std::path::PathBuf,
        parent_session_id: &str,
        location_id: &str,
        workspace_revision: &str,
        pins: &ManagedPreAdmissionTargetPinsV1,
        context_selection_digest: &str,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
        expires_at_ms: u64,
    ) -> Result<(
        RootCoordinatorExecutionProofV1,
        crate::worker_pool::ResolvedManagedWorktreeV1,
        ManagedReadyTaskPinV1,
        DurableManagedLeaseProofV1,
    ), WorkerDurableError> {
        let root = self.register_authenticated_root_coordinator(
            root_delivery_id, root_pins, now_ms, expires_at_ms,
        )?;
        let registration = VerifiedWorktreeRegistrationV1::from_guarded_create_and_inspect(
            registration_owner,
            create_intent,
            create_receipt,
            inspect_intent,
            inspect_receipt,
            canonical_worktree_path,
        ).map_err(map_worktree_lifecycle_error)?;
        // Worktree registration appends to the same OwnerLog and invalidates
        // the root proof watermark, so persist against the live proof then
        // resolve a fresh proof for target selection and admission.
        self.persist_guarded_worktree_registration(
            registration_delivery_id, &root, now_ms, registration,
        )?;
        let root = self.resolve_authenticated_root_coordinator_proof(root_pins, now_ms)?;
        let target = self.resolve_managed_worktree(
            owner, parent_session_id, location_id, workspace_revision, &root, now_ms,
        )?;
        let staged = &pins.pins;
        let ManagedParentProofV1::RootCoordinator(staged_root) = &staged.parent_proof else {
            return Err(WorkerDurableError::Conflict(
                "managed pre-admission pins do not contain authenticated root lineage",
            ));
        };
        let registered_root = &root.execution;
        let pinned_root = &staged_root.execution;
        if pinned_root.worker_execution_id != registered_root.worker_execution_id
            || pinned_root.goal_id != registered_root.goal_id
            || pinned_root.run_id != registered_root.run_id
            || pinned_root.principal_ref != registered_root.principal_ref
            || pinned_root.workspace_binding != registered_root.workspace_binding
            || pinned_root.session_id != registered_root.session_id
            || pinned_root.location_id != registered_root.location_id
            || pinned_root.owner_epoch != registered_root.owner_epoch
            || pinned_root.process_incarnation != registered_root.process_incarnation
            || pinned_root.process_identity != registered_root.process_identity
            || pinned_root.source_revision != registered_root.source_revision
            || pinned_root.accepted_spec_digest != registered_root.accepted_spec_digest
            || staged.location_id != location_id
            || staged.workspace_revision != workspace_revision
            || target.workspace_binding() != staged.owner.workspace_binding()
            || target.location_id() != location_id
            || target.source_revision() != workspace_revision
        {
            return Err(WorkerDurableError::Conflict(
                "managed pre-admission pins differ from authenticated root or registered worktree",
            ));
        }
        // Rebind only the cursor-sensitive root proof and pool-derived target
        // facts. All immutable Task/profile/scope/budget pins remain caller
        // supplied and are validated again by the Stage-A writer.
        let mut refreshed_pins = pins.clone();
        refreshed_pins.pins.parent_proof = ManagedParentProofV1::RootCoordinator(root.clone());
        refreshed_pins.pins.worktree = crate::worker_pool::WorktreeBindingRequest {
            worktree_id: target.worktree_id().to_owned(),
            base_revision: target.base_revision().to_owned(),
        };
        refreshed_pins.pins.worktree_pool_revision = target.pool_revision();
        refreshed_pins.pins.pins_digest = refreshed_pins.pins.compute_digest();
        let (ready, lease) = self.test_reserve_and_bind_managed_pre_admission(
            &refreshed_pins, context_selection_digest, owner, now_ms,
        )?;
        Ok((root, target, ready, lease))
    }

    /// Resolve the immutable P8 reservation by a trusted Attempt identity
    /// already selected by HostKernel. A tombstoned candidate remains
    /// discoverable only through its reconciliation receipt and cannot be
    /// turned back into a live lease.
    pub(crate) fn resolve_managed_ready_task_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<(ManagedReadyTaskPinV1, ReservedWorkerLeaseProofV1), WorkerDurableError> {
        let mut matches = self.identities.pre_admission_pins.values()
            .filter(|pins| pins.attempt_id() == attempt_id);
        let pins = matches.next().ok_or(WorkerDurableError::NotFound(
            "managed pre-admission Attempt is not reserved by P8",
        ))?.clone();
        if matches.next().is_some() {
            return Err(WorkerDurableError::Conflict(
                "Attempt identity maps to multiple P8 reservations",
            ));
        }
        let (ticket_id, worker_execution_id, _) = pre_admission_request(&pins)?;
        let attached = self.identities.delegation_bindings.get(&worker_execution_id)
            .map(|binding| binding.binding_digest.as_str());
        let proof = self.reserved_worker_proof(&pins, &ticket_id, &worker_execution_id, attached)?;
        Ok((pins, proof))
    }

    /// Admission-only projection for the atomic managed Attempt+binding
    /// append. The proof is cursor-bound to an exact current RESERVED lease,
    /// has no attached DelegationBinding, and is explicitly marked so the
    /// effect/claim/dispatch path must resolve a different post-append proof.
    pub(crate) fn resolve_pre_admission_admission_lease_proof(
        &self,
        pins: &ManagedReadyTaskPinV1,
        reservation: &ReservedWorkerLeaseProofV1,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<DurableManagedLeaseProofV1, WorkerDurableError> {
        pins.validate()?;
        if pins.context_selection_digest.is_none()
            || pins.owner() != owner || pins.owner_epoch() != self.resumed_epoch
            || self.identities.pre_admission_pins.get(reservation.worker_execution_id()) != Some(pins)
            || reservation.binding_digest().is_some()
        {
            return Err(WorkerDurableError::Conflict(
                "pre-admission lease proof is stale or already attached",
            ));
        }
        let (ticket_id, worker_id, _) = pre_admission_request(pins)?;
        let current = self.reserved_worker_proof(pins, &ticket_id, &worker_id, None)?;
        if &current != reservation {
            return Err(WorkerDurableError::Conflict(
                "pre-admission reservation proof is stale",
            ));
        }
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid(
            "worker pool is unavailable",
        ))?;
        let facts = pool.resolve_pre_admission_lease_facts(pins, reservation, owner, now_ms)?;
        let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
            "worker OwnerLog cursor is unavailable",
        ))?;
        if cursor.owner_kind != OWNER_KIND || cursor.owner_id != self.pool_id
            || cursor.seq == "0" || cursor.event_digest.is_empty()
        {
            return Err(WorkerDurableError::Invalid(
                "worker OwnerLog is not durably opened",
            ));
        }
        Ok(DurableManagedLeaseProofV1 {
            facts,
            purpose: DurableManagedLeaseProofPurposeV1::PreAdmissionReserved,
            pre_admission_pins: Some(pins.clone()),
            admission_pins: None,
            delegation: None,
            owner_log_id: cursor.owner_id.clone(),
            worker_pool_revision: pool.revision(),
            owner_log_sequence: cursor.seq.clone(),
            owner_log_event_digest: cursor.event_digest.clone(),
        })
    }

    /// Attach P1's canonical managed binding after Attempt admission. This is
    /// a separate durable fence; claim/dispatch are refused until it matches
    /// every immutable pre-admission fact and the exact reserved lease refs.
    pub(crate) fn attach_managed_ready_task_binding(
        &mut self,
        proof: &ReservedWorkerLeaseProofV1,
        delegation: &crate::protocol::DelegationBindingV1,
        worktree_projection: &crate::managed_control::ManagedWorktreeAdmissionProjectionV1,
    ) -> Result<ReservedWorkerLeaseProofV1, WorkerDurableError> {
        let pins = self.identities.pre_admission_pins.get(&proof.worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("pre-admission pins unavailable"))?.clone();
        let (_, _, delivery_id) = pre_admission_ids(&pins);
        let binding_digest = delegation.digest()
            .map_err(|_| WorkerDurableError::Invalid("delegation digest failed"))?;
        let worktree_admission = ManagedWorktreeAdmissionPinV1::from_hostkernel(worktree_projection)?;
        let attached_digest = self.identities.delegation_bindings
            .get(&proof.worker_execution_id).map(|binding| binding.binding_digest.as_str());
        let current = self.reserved_worker_proof(&pins, &proof.ticket_id, &proof.worker_execution_id, attached_digest)?;
        if &current != proof && attached_digest.is_none() {
            return Err(WorkerDurableError::Conflict("reserved worker proof is stale"));
        }
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(&proof.worker_execution_id))
            .ok_or(WorkerDurableError::NotFound("reserved worker unavailable"))?;
        if worker.state != crate::resource_budget::ReservationState::Reserved
            || worker.cancellation_requested || worker.unknown_effect
            || delegation.run_id != pins.run_id()
            || delegation.task_id != pins.task_id()
            || delegation.attempt_id != pins.attempt_id()
            || delegation.child_execution_id != proof.worker_execution_id
            || delegation.accepted_spec_digest != pins.accepted_spec_digest
            || delegation.source_revision != worktree_admission.child_workspace_revision
            || worktree_admission.worktree_id != pins.worktree.worktree_id
            || worktree_admission.base_revision != pins.worktree.base_revision
            || worktree_admission.root_location_id != pins.location_id
            || worktree_admission.p8_workspace_binding != pins.workspace_binding()
            || worktree_admission.pool_revision != self.pool.as_ref()
                .map(WorkerPool::revision).unwrap_or_default()
            || delegation.owner_epoch != pins.owner_epoch()
            || delegation.profile_id != pins.profile_id
            || delegation.profile_revision != pins.profile_revision
            || delegation.profile_digest != pins.profile_digest
            || delegation.capability_ceiling_digest != pins.capability_ceiling_digest
            || Some(delegation.context_selection_digest.as_str()) != pins.context_selection_digest.as_deref()
            || delegation.workspace_lease_id != proof.workspace_lease_id
            || delegation.budget_lease_id != proof.budget_lease_id
            || delegation.resource_lease_ids != proof.resource_lease_ids
            || delegation.parent_execution_id != pre_admission_parent_execution_id(&pins)
        {
            return Err(WorkerDurableError::Conflict("DelegationBinding differs from pinned candidate Attempt"));
        }
        let journal_binding = BoundWorkerDelegationV1 {
            binding_digest: binding_digest.clone(),
            parent_execution_id: delegation.parent_execution_id.clone(),
            worktree_admission: Some(worktree_admission),
        };
        if let Some(existing) = self.identities.delegation_bindings.get(&proof.worker_execution_id) {
            if existing != &journal_binding {
                return Err(WorkerDurableError::Conflict("worker binding digest is immutable"));
            }
            if proof.worker_execution_id != current.worker_execution_id
                || proof.ticket_id != current.ticket_id
                || proof.attempt_id != current.attempt_id
                || proof.pins_digest != current.pins_digest
                || proof.workspace_lease_id != current.workspace_lease_id
                || proof.budget_lease_id != current.budget_lease_id
                || proof.resource_lease_ids != current.resource_lease_ids
            {
                return Err(WorkerDurableError::Conflict("binding retry differs from exact P8 reservation"));
            }
            return self.reserved_worker_proof(&pins, &proof.ticket_id, &proof.worker_execution_id, Some(&binding_digest));
        } else {
            let revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
            self.apply(revision, &format!("{delivery_id}-binding"), WorkerCommand::DelegationBound {
                worker_execution_id: proof.worker_execution_id.clone(), binding: journal_binding,
            })?;
        }
        self.reserved_worker_proof(&pins, &proof.ticket_id, &proof.worker_execution_id, Some(binding_digest.as_str()))
    }

    /// Compose the live managed Attempt with its exact pre-admission P8 lease
    /// after the canonical DelegationBinding has been durably attached. This
    /// resolves the same OwnerLog-backed lease facts as the legacy admission
    /// path, while retaining the pre-admission profile/context pins and binding
    /// lineage in the returned proof. No raw worker ID or caller-created digest
    /// can select a different lease.
    pub(crate) fn resolve_attached_pre_admission_lease_proof(
        &self,
        pins: &ManagedReadyTaskPinV1,
        reservation: &ReservedWorkerLeaseProofV1,
        delegation: &crate::protocol::DelegationBindingV1,
        attempt_binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<DurableManagedLeaseProofV1, WorkerDurableError> {
        pins.validate()?;
        if pins.owner() != owner || pins.owner_epoch() != self.resumed_epoch
            || attempt_binding.phase() != crate::worker_pool::BindingAttemptPhase::Executing
            || attempt_binding.goal_id() != pins.goal_id()
            || attempt_binding.run_id() != pins.run_id()
            || attempt_binding.task_id() != pins.task_id()
            || attempt_binding.attempt_id() != pins.attempt_id()
            || attempt_binding.owner_epoch() != pins.owner_epoch()
            || attempt_binding.accepted_spec_digest() != pins.accepted_spec_digest()
        {
            return Err(WorkerDurableError::Conflict(
                "admitted Attempt differs from immutable pre-admission pins",
            ));
        }

        let worker_execution_id = reservation.worker_execution_id();
        let attached_binding = self.identities.delegation_bindings.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("managed Attempt has no durable P8 DelegationBinding"))?;
        let child_workspace_revision = attached_binding.child_workspace_revision()?;
        let (ticket_id, expected_worker_id, _) = pre_admission_request(pins)?;
        if worker_execution_id != expected_worker_id
            || reservation.ticket_id() != ticket_id
            || reservation.attempt_id() != pins.attempt_id()
            || reservation.pins_digest() != pins.pins_digest()
        {
            return Err(WorkerDurableError::Conflict(
                "reserved proof does not identify the pinned candidate Attempt",
            ));
        }
        if crate::protocol::DelegationBindingV1::from_value(&delegation.to_value()).as_ref()
            != Some(delegation)
        {
            return Err(WorkerDurableError::Invalid(
                "DelegationBinding is not its canonical validated form",
            ));
        }
        let binding_digest = delegation.digest()
            .map_err(|_| WorkerDurableError::Invalid("delegation digest failed"))?;
        if delegation.run_id != pins.run_id()
            || delegation.task_id != pins.task_id()
            || delegation.attempt_id != pins.attempt_id()
            || delegation.child_execution_id != worker_execution_id
            || delegation.parent_execution_id != pre_admission_parent_execution_id(pins)
            || delegation.accepted_spec_digest != pins.accepted_spec_digest()
            || delegation.profile_id != pins.profile_id()
            || delegation.profile_revision != pins.profile_revision()
            || delegation.profile_digest != pins.profile_digest()
            || Some(delegation.context_selection_digest.as_str()) != pins.context_selection_digest()
            || delegation.capability_ceiling_digest != pins.capability_ceiling_digest()
            || attempt_binding.source_revision() != child_workspace_revision
            || delegation.source_revision != child_workspace_revision
            || delegation.owner_epoch != pins.owner_epoch()
            || delegation.workspace_lease_id != reservation.workspace_lease_id()
            || delegation.budget_lease_id != reservation.budget_lease_id()
            || delegation.resource_lease_ids != reservation.resource_lease_ids()
        {
            return Err(WorkerDurableError::Conflict(
                "admitted DelegationBinding differs from pre-admission pins or leases",
            ));
        }

        let current_reservation = self.reserved_worker_proof(
            pins, &ticket_id, worker_execution_id, Some(&binding_digest),
        )?;
        if &current_reservation != reservation
            || self.pool.as_ref().and_then(|pool| pool.worker(worker_execution_id))
                .is_none_or(|worker| worker.state != crate::resource_budget::ReservationState::Reserved
                    || worker.cancellation_requested || worker.unknown_effect)
        {
            return Err(WorkerDurableError::Conflict(
                "pre-admission reservation is stale, cancelled, uncertain or not RESERVED",
            ));
        }
        if self.identities.pre_admission_pins.get(worker_execution_id) != Some(pins)
            || self.identities.delegation_bindings.get(worker_execution_id)
                .is_none_or(|attached| attached.binding_digest != binding_digest
                    || attached.parent_execution_id != delegation.parent_execution_id
                    || attached.worktree_admission.as_ref().is_none_or(|pin|
                        pin.child_workspace_revision != child_workspace_revision))
        {
            return Err(WorkerDurableError::Conflict(
                "durable P8 pins or attached DelegationBinding changed",
            ));
        }

        let proof = self.resolve_managed_lease_proof(
            worker_execution_id, attempt_binding, owner, now_ms,
        )?;
        if proof.purpose() != DurableManagedLeaseProofPurposeV1::AttachedAttempt
            || proof.pre_admission_pins() != Some(pins)
            || proof.delegation_binding_digest() != Some(binding_digest.as_str())
            || proof.owner_log_id() != reservation.owner_log_id()
            || proof.owner_log_sequence() != reservation.owner_log_sequence()
            || proof.owner_log_event_digest() != reservation.owner_log_event_digest()
            || proof.worker_pool_revision() != reservation.worker_pool_revision()
            || proof.worker_state() != crate::resource_budget::ReservationState::Reserved
        {
            return Err(WorkerDurableError::Conflict(
                "resolved managed lease proof is not the current attached reservation",
            ));
        }
        Ok(proof)
    }

    /// Claim is the final P8-side pre-dispatch fence. It does not launch a
    /// process; P1 must still validate current HostKernel/Guard/confinement
    /// authority and perform the only supervised dispatch.
    pub(crate) fn claim_bound_pre_admission_worker(
        &mut self,
        proof: &ReservedWorkerLeaseProofV1,
    ) -> Result<ClaimedWorkerDispatchProofV1, WorkerDurableError> {
        let pins = self.identities.pre_admission_pins.get(&proof.worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("pre-admission pins unavailable"))?.clone();
        let digest = self.identities.delegation_bindings.get(&proof.worker_execution_id)
            .map(|binding| binding.binding_digest.clone())
            .ok_or(WorkerDurableError::Conflict("worker binding digest is not attached"))?;
        let current = self.reserved_worker_proof(&pins, &proof.ticket_id, &proof.worker_execution_id, Some(&digest))?;
        if &current != proof {
            return Err(WorkerDurableError::Conflict("bound worker proof is stale"));
        }
        let (_, _, delivery_id) = pre_admission_ids(&pins);
        let revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
        self.apply(revision, &format!("{delivery_id}-claim"), WorkerCommand::ClaimWorker {
            scope: OwnerScopeKey::from_owner(pins.owner()),
            worker_execution_id: proof.worker_execution_id.clone(),
        })?;
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(&proof.worker_execution_id))
            .ok_or(WorkerDurableError::NotFound("claimed worker unavailable"))?;
        if worker.state != crate::resource_budget::ReservationState::Claimed
            || worker.cancellation_requested || worker.unknown_effect
        {
            return Err(WorkerDurableError::Conflict("worker claim did not reach a dispatchable state"));
        }
        let claimed = self.reserved_worker_proof(&pins, &proof.ticket_id, &proof.worker_execution_id, Some(&digest))?;
        Ok(ClaimedWorkerDispatchProofV1 { reserved: claimed })
    }

    /// Re-resolve the immutable claim-event receipt and current worker state
    /// immediately before P1 mints a dispatch handoff. Unrelated OwnerLog
    /// events may advance the current cursor; cancellation, quarantine,
    /// process binding, authority drift or epoch recovery invalidates replay.
    pub(crate) fn validate_claimed_worker_dispatch_proof(
        &self,
        proof: &ClaimedWorkerDispatchProofV1,
    ) -> Result<(), WorkerDurableError> {
        if self.fan_out_state() != crate::worker_pool::FanOutState::ManagedAttemptBinding {
            return Err(WorkerDurableError::Conflict("managed claim replay is fenced by the current pool epoch"));
        }
        let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
            "worker OwnerLog cursor is unavailable",
        ))?;
        let pool_revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        let receipt_sequence = proof.owner_log_sequence().parse::<u64>()
            .map_err(|_| WorkerDurableError::Conflict("claimed proof sequence is invalid"))?;
        let current_sequence = cursor.seq.parse::<u64>()
            .map_err(|_| WorkerDurableError::Conflict("current worker cursor sequence is invalid"))?;
        validate_owner_digest(&cursor.event_digest, "blake3:")?;
        if cursor.owner_kind != OWNER_KIND || cursor.owner_id != self.pool_id
            || current_sequence < receipt_sequence
            || pool_revision < proof.worker_pool_revision()
        {
            return Err(WorkerDurableError::Conflict("claimed proof is outside the current worker OwnerLog"));
        }
        let current = self.claimed_worker_dispatch_proof(proof.worker_execution_id())?;
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(proof.worker_execution_id()))
            .ok_or(WorkerDurableError::NotFound("claimed worker unavailable"))?;
        if &current != proof
            || worker.state != crate::resource_budget::ReservationState::Claimed
            || worker.cancellation_requested || worker.unknown_effect || worker.process_identity.is_some()
            || worker.owner.owner_epoch != self.resumed_epoch
        {
            return Err(WorkerDurableError::Conflict("claimed worker dispatch proof is stale"));
        }
        Ok(())
    }

    /// Resolve the exact already-claimed handoff fence for a live managed
    /// Attempt. This is the only lost-response replay path: it reconstructs
    /// the original claim event cursor, and refuses replay after any process
    /// was bound, cancellation/UNKNOWN/quarantine, epoch drift, or pin/binding
    /// mismatch. It never claims or launches again.
    pub(crate) fn resolve_claimed_pre_admission_dispatch_for_attempt(
        &self,
        attempt_id: &str,
        delegation: &crate::protocol::DelegationBindingV1,
        attempt_binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<(ManagedReadyTaskPinV1, ClaimedWorkerDispatchProofV1), WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let mut matches = self.identities.pre_admission_pins.iter()
            .filter(|(_, pins)| pins.attempt_id() == attempt_id);
        let Some((worker_id, pins)) = matches.next() else {
            return Err(WorkerDurableError::NotFound("managed Attempt has no P8 pre-admission pin"));
        };
        if matches.next().is_some() {
            return Err(WorkerDurableError::Conflict("Attempt maps to multiple P8 pre-admission pins"));
        }
        pins.validate()?;
        if pins.owner() != owner || pins.owner_epoch() != self.resumed_epoch
            || attempt_binding.phase() != crate::worker_pool::BindingAttemptPhase::Executing
            || attempt_binding.goal_id() != pins.goal_id()
            || attempt_binding.run_id() != pins.run_id()
            || attempt_binding.task_id() != pins.task_id()
            || attempt_binding.attempt_id() != pins.attempt_id()
            || attempt_binding.owner_epoch() != pins.owner_epoch()
            || attempt_binding.accepted_spec_digest() != pins.accepted_spec_digest()
            || delegation.attempt_id != pins.attempt_id()
            || delegation.task_id != pins.task_id()
            || delegation.run_id != pins.run_id()
            || delegation.child_execution_id.as_str() != worker_id.as_str()
            || delegation.parent_execution_id != pre_admission_parent_execution_id(pins)
            || delegation.accepted_spec_digest != pins.accepted_spec_digest()
            || delegation.profile_id != pins.profile_id()
            || delegation.profile_revision != pins.profile_revision()
            || delegation.profile_digest != pins.profile_digest()
            || Some(delegation.context_selection_digest.as_str()) != pins.context_selection_digest()
            || delegation.capability_ceiling_digest != pins.capability_ceiling_digest()
            || delegation.source_revision != self.identities.delegation_bindings.get(worker_id)
                .ok_or(WorkerDurableError::Conflict("claimed worker binding is unavailable"))?
                .child_workspace_revision()?
        {
            return Err(WorkerDurableError::Conflict("claimed handoff Attempt or binding differs from immutable P8 pins"));
        }
        let binding_digest = delegation.digest()
            .map_err(|_| WorkerDurableError::Invalid("delegation digest failed"))?;
        let (ticket_id, expected_worker_id, _) = pre_admission_request(pins)?;
        let attached = self.identities.delegation_bindings.get(worker_id)
            .ok_or(WorkerDurableError::Conflict("claimed worker binding is unavailable"))?;
        if expected_worker_id.as_str() != worker_id.as_str() || attached.binding_digest != binding_digest
            || attached.parent_execution_id != delegation.parent_execution_id
        {
            return Err(WorkerDurableError::Conflict("claimed worker binding digest changed"));
        }
        let current_lease = self.resolve_managed_lease_proof(worker_id, attempt_binding, owner, now_ms)?;
        if current_lease.purpose() != DurableManagedLeaseProofPurposeV1::AttachedAttempt
            || current_lease.pre_admission_pins() != Some(pins)
            || current_lease.delegation_binding_digest() != Some(binding_digest.as_str())
            || current_lease.worker_state() != crate::resource_budget::ReservationState::Claimed
            || current_lease.process_identity().is_some()
        {
            return Err(WorkerDurableError::Conflict("claimed lease is not safe for same-handoff replay"));
        }
        let proof = self.claimed_worker_dispatch_proof(worker_id)?;
        if proof.reservation().ticket_id() != ticket_id
            || proof.attempt_id() != attempt_id
            || proof.binding_digest() != binding_digest
            || proof.pins_digest() != pins.pins_digest()
            || delegation.workspace_lease_id != proof.reservation().workspace_lease_id()
            || delegation.budget_lease_id != proof.reservation().budget_lease_id()
            || delegation.resource_lease_ids != proof.reservation().resource_lease_ids()
        {
            return Err(WorkerDurableError::Conflict("claimed receipt differs from exact managed binding"));
        }
        self.validate_claimed_worker_dispatch_proof(&proof)?;
        Ok((pins.clone(), proof))
    }

    /// Read-only terminal resolver for P1. Unlike dispatch replay it does not
    /// require the managed Attempt to remain EXECUTING and never reopens claim
    /// or launch authority.
    pub(crate) fn resolve_claimed_terminal_worker_for_attempt(
        &self,
        attempt_id: &str,
        delegation: &crate::protocol::DelegationBindingV1,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<(ManagedReadyTaskPinV1, ClaimedWorkerDispatchProofV1), WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let mut matches = self.identities.pre_admission_pins.iter()
            .filter(|(_, pins)| pins.attempt_id() == attempt_id);
        let Some((worker_id, pins)) = matches.next() else {
            return Err(WorkerDurableError::NotFound("managed Attempt has no P8 pre-admission pin"));
        };
        if matches.next().is_some() {
            return Err(WorkerDurableError::Conflict("Attempt maps to multiple P8 pre-admission pins"));
        }
        pins.validate()?;
        if owner.owner_epoch() != self.resumed_epoch
            || pins.owner_epoch() > self.resumed_epoch
            || pins.principal_ref() != owner.principal_ref()
            || pins.workspace_binding() != owner.workspace_binding()
            || pins.session_id() != owner.session_id()
            || pins.run_id() != owner.run_id()
            || pins.task_id() != owner.task_id()
            || pins.attempt_id() != owner.attempt_id()
            || delegation.run_id != pins.run_id() || delegation.task_id != pins.task_id()
            || delegation.attempt_id != pins.attempt_id()
            || delegation.child_execution_id != *worker_id
            || delegation.parent_execution_id != pre_admission_parent_execution_id(pins)
            || delegation.accepted_spec_digest != pins.accepted_spec_digest()
            || delegation.profile_id != pins.profile_id()
            || delegation.profile_revision != pins.profile_revision()
            || delegation.profile_digest != pins.profile_digest()
            || Some(delegation.context_selection_digest.as_str()) != pins.context_selection_digest()
            || delegation.capability_ceiling_digest != pins.capability_ceiling_digest()
            || delegation.source_revision != self.identities.delegation_bindings.get(worker_id)
                .ok_or(WorkerDurableError::Conflict("terminal worker binding is unavailable"))?
                .child_workspace_revision()?
        {
            return Err(WorkerDurableError::Conflict("terminal Attempt or binding differs from immutable P8 pins"));
        }
        let digest = delegation.digest()
            .map_err(|_| WorkerDurableError::Invalid("DelegationBinding digest failed"))?;
        let attached = self.identities.delegation_bindings.get(worker_id)
            .ok_or(WorkerDurableError::Conflict("terminal worker binding is unavailable"))?;
        if attached.binding_digest != digest
            || attached.parent_execution_id != delegation.parent_execution_id
        {
            return Err(WorkerDurableError::Conflict("terminal DelegationBinding digest changed"));
        }
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let worker = pool.worker(worker_id).ok_or(WorkerDurableError::NotFound("terminal worker lease missing"))?;
        if !matches!(worker.state, crate::resource_budget::ReservationState::Claimed
            | crate::resource_budget::ReservationState::Quarantined
            | crate::resource_budget::ReservationState::Released)
            || worker.process_identity.is_some()
            || worker.owner.attempt_id != attempt_id
        {
            return Err(WorkerDurableError::Conflict("terminal worker is not a claimed logical Core child"));
        }
        let proof = self.claimed_worker_dispatch_proof(worker_id)?;
        if proof.attempt_id() != attempt_id || proof.binding_digest() != digest
            || proof.pins_digest() != pins.pins_digest()
            || delegation.workspace_lease_id != proof.reservation().workspace_lease_id()
            || delegation.budget_lease_id != proof.reservation().budget_lease_id()
            || delegation.resource_lease_ids != proof.reservation().resource_lease_ids()
        {
            return Err(WorkerDurableError::Conflict("terminal claim receipt differs from exact P8 binding"));
        }
        Ok((pins.clone(), proof))
    }

    /// Persist a typed non-success terminal quarantine without releasing the
    /// ActiveWorkers reservation or making its worktree reusable. The proof
    /// must establish exact logical-child quiescence and settled effects; this
    /// path does not claim a child PID exit and cannot be used for UNKNOWN.
    pub(crate) fn quarantine_managed_worker(
        &mut self,
        proof: WorkerSettlementProofV1,
        now_ms: u64,
    ) -> Result<WorkerManagedQuarantineReceiptV1, WorkerDurableError> {
        if proof.execution_kind() != WorkerExecutionKindV1::LogicalCoreSession
            || !valid_digest(proof.proof_digest(), "blake3:")
            || proof.final_worktree_receipt().is_some()
        {
            return Err(WorkerDurableError::Invalid("managed terminal quarantine proof is invalid"));
        }
        let terminal = proof.terminal();
        let reason = match (terminal.attempt_state(), terminal.task_state()) {
            (crate::managed_control::ManagedAttemptTerminalStateV1::Failed,
                crate::managed_control::ManagedTaskTerminalStateV1::Failed) => WorkerManagedQuarantineReasonV1::FailedAttempt,
            (crate::managed_control::ManagedAttemptTerminalStateV1::Failed,
                crate::managed_control::ManagedTaskTerminalStateV1::Cancelled) => WorkerManagedQuarantineReasonV1::CancelledTask,
            _ => return Err(WorkerDurableError::Conflict("only FAILED/CANCELLED terminal Attempts may enter quarantine")),
        };
        let worker_id = proof.claim().worker_execution_id().to_owned();
        if let Some(receipt) = self.managed_quarantine_receipts.get(&worker_id) {
            return if receipt.terminal_proof_digest() == proof.proof_digest()
                && receipt.attempt_id() == proof.claim().attempt_id()
            {
                Ok(receipt.clone())
            } else {
                Err(WorkerDurableError::Conflict("managed worker already has a different quarantine receipt"))
            };
        }
        let root_owner = self.resolve_worktree_root_owner(proof.root(), now_ms)?;
        let pins = self.identities.pre_admission_pins.get(&worker_id)
            .ok_or(WorkerDurableError::NotFound("quarantine worker pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(&worker_id)?;
        let binding = self.identities.delegation_bindings.get(&worker_id)
            .ok_or(WorkerDurableError::Conflict("quarantine DelegationBinding missing"))?;
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(&worker_id))
            .ok_or(WorkerDurableError::NotFound("quarantine worker lease missing"))?;
        if &claim != proof.claim()
            || proof.owner() != pins.owner()
            || proof.owner().owner_epoch() != self.resumed_epoch
            || proof.attempt_binding().attempt_id() != pins.attempt_id()
            || proof.attempt_binding().source_revision() != binding.child_workspace_revision()?
            || proof.attempt_binding().accepted_spec_digest() != pins.accepted_spec_digest()
            || terminal.task_revision() != pins.task_revision().parse::<u64>()
                .map_err(|_| WorkerDurableError::Conflict("pinned Task revision is invalid"))?
            || terminal.admission_workspace_revision() != Some(binding.child_workspace_revision()?)
            || terminal.binding_digest() != binding.binding_digest
            || terminal.binding_digest() != claim.binding_digest()
            || terminal.spec_digest() != pins.accepted_spec_digest()
            || terminal.goal_id() != pins.goal_id() || terminal.run_id() != pins.run_id()
            || terminal.task_id() != pins.task_id() || terminal.attempt_id() != pins.attempt_id()
            || root_owner.goal_id() != pins.goal_id() || root_owner.run_id() != pins.run_id()
            || root_owner.principal_ref() != pins.principal_ref()
            || root_owner.workspace_binding() != pins.workspace_binding()
            || managed_root_session_id(pins.parent_proof())? != root_owner.session_id()
            || root_owner.location_id() != pins.location_id()
            || root_owner.owner_epoch() != pins.owner_epoch()
            || root_owner.process_incarnation() != pins.process_incarnation()
            || root_owner.accepted_spec_digest() != pins.accepted_spec_digest()
            || worker.state != crate::resource_budget::ReservationState::Claimed
            || worker.goal_id != pins.goal_id()
            || worker.owner.principal_ref != pins.principal_ref()
            || worker.owner.workspace_binding != pins.workspace_binding()
            || worker.owner.session_id != pins.session_id()
            || worker.owner.run_id != pins.run_id()
            || worker.owner.task_id != pins.task_id()
            || worker.owner.attempt_id != pins.attempt_id()
            || worker.owner.owner_epoch != pins.owner_epoch()
            || worker.process_identity.is_some()
            || worker.worktree_lease_id.as_deref() != Some(claim.reservation().workspace_lease_id())
            || worker.unknown_effect
            || terminal.effects().iter().any(|effect| {
                effect.outcome() == Some(crate::managed_control::AttemptEffectOutcomeV1::Unknown)
            })
        {
            return Err(WorkerDurableError::Conflict(
                "managed terminal quarantine differs from current P8/P1/P2 pins or has uncertain work",
            ));
        }
        let event = ManagedTerminalQuarantineEventV1 {
            scope: OwnerScopeKey::from_owner(proof.owner()),
            worker_execution_id: worker_id.clone(),
            goal_id: pins.goal_id().to_owned(), run_id: pins.run_id().to_owned(),
            task_id: pins.task_id().to_owned(), attempt_id: pins.attempt_id().to_owned(),
            owner_epoch: proof.owner().owner_epoch(),
            reservation_id: claim.reservation().budget_lease_id().to_owned(),
            worktree_lease_id: claim.reservation().workspace_lease_id().to_owned(),
            terminal_proof_digest: proof.proof_digest().to_owned(), reason,
        };
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let delivery_id = format!("worker-managed-quarantine-{worker_id}");
        self.apply(revision, &delivery_id, WorkerCommand::ManagedTerminalQuarantined { event })?;
        self.managed_quarantine_receipts.get(&worker_id).cloned()
            .ok_or(WorkerDurableError::Invalid("managed quarantine OwnerLog receipt was not materialized"))
    }

    /// Consume a P1-minted logical-session terminal proof. P8 re-resolves the
    /// claim receipt, exact pins/binding, current root OwnerLog watermark and
    /// P2 evidence digests before appending. Exact retry returns the same
    /// durable receipt; another proof for the same worker conflicts.
    pub(crate) fn settle_managed_worker(
        &mut self,
        proof: WorkerSettlementProofV1,
        now_ms: u64,
    ) -> Result<WorkerSettlementReceiptV1, WorkerDurableError> {
        if proof.execution_kind() != WorkerExecutionKindV1::LogicalCoreSession
            || !valid_digest(proof.proof_digest(), "blake3:")
        {
            return Err(WorkerDurableError::Invalid("managed worker settlement proof is invalid"));
        }
        let worker_id = proof.claim().worker_execution_id().to_owned();
        if let Some(receipt) = self.managed_settlement_receipts.get(&worker_id) {
            if receipt.proof_digest() == proof.proof_digest()
                && receipt.attempt_id() == proof.claim().attempt_id()
            {
                if self.resolve_managed_worktree_disposition_for_attempt(proof.claim().attempt_id())?.is_some() {
                    return self.resolve_managed_settlement_for_attempt(proof.claim().attempt_id())?
                        .ok_or(WorkerDurableError::ReplayConflict(
                            "managed settlement disappeared after its disposition was committed",
                        ));
                }
                self.ensure_managed_worktree_disposition(&worker_id, proof.claim().attempt_id(), None)?;
                return self.resolve_managed_settlement_for_attempt(proof.claim().attempt_id())?
                    .ok_or(WorkerDurableError::ReplayConflict(
                        "managed settlement receipt disappeared during exact replay",
                    ));
            } else {
                return Err(WorkerDurableError::Conflict("managed worker already has a different settlement receipt"));
            }
        }
        let root_owner = self.resolve_worktree_root_owner(proof.root(), now_ms)?;
        let pins = self.identities.pre_admission_pins.get(&worker_id)
            .ok_or(WorkerDurableError::NotFound("settlement worker pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(&worker_id)?;
        let binding = self.identities.delegation_bindings.get(&worker_id)
            .ok_or(WorkerDurableError::Conflict("settlement DelegationBinding missing"))?;
        let terminal = proof.terminal();
        // This event releases ActiveWorkers capacity. Architecture permits
        // release here only after independently verified success. A failed or
        // cancelled terminal can still be represented by the typed proof for
        // quarantine/reconciliation, but must never enter this release path.
        if terminal.attempt_state() != crate::managed_control::ManagedAttemptTerminalStateV1::Succeeded
            || terminal.task_state() != crate::managed_control::ManagedTaskTerminalStateV1::Verified
        {
            return Err(WorkerDurableError::Conflict(
                "non-success managed terminal requires quarantine/reconciliation; capacity is retained",
            ));
        }
        if &claim != proof.claim()
            || proof.owner() != pins.owner()
            || proof.owner().owner_epoch() != self.resumed_epoch
            || proof.attempt_binding().attempt_id() != pins.attempt_id()
            || proof.attempt_binding().source_revision() != binding.child_workspace_revision()?
            || proof.attempt_binding().accepted_spec_digest() != pins.accepted_spec_digest()
            || terminal.task_revision() != pins.task_revision().parse::<u64>()
                .map_err(|_| WorkerDurableError::Conflict("pinned Task revision is invalid"))?
            || terminal.admission_workspace_revision() != Some(binding.child_workspace_revision()?)
            || terminal.binding_digest() != binding.binding_digest
            || terminal.binding_digest() != claim.binding_digest()
            || terminal.spec_digest() != pins.accepted_spec_digest()
            || terminal.goal_id() != pins.goal_id() || terminal.run_id() != pins.run_id()
            || terminal.task_id() != pins.task_id() || terminal.attempt_id() != pins.attempt_id()
            || root_owner.goal_id() != pins.goal_id() || root_owner.run_id() != pins.run_id()
            || root_owner.principal_ref() != pins.principal_ref()
            || root_owner.workspace_binding() != pins.workspace_binding()
            || root_owner.session_id() != managed_root_session_id(pins.parent_proof())?
            || root_owner.location_id() != pins.location_id()
            || root_owner.owner_epoch() != pins.owner_epoch()
            || root_owner.process_incarnation() != pins.process_incarnation()
            || root_owner.accepted_spec_digest() != pins.accepted_spec_digest()
        {
            return Err(WorkerDurableError::Conflict("managed settlement differs from current P8/P1/P2 pins"));
        }
        // A successful worker settlement releases ActiveWorkers. Require the
        // final Guarded Inspect receipt at this boundary even though the
        // opaque P1 proof constructor also requires it for VERIFIED Tasks.
        // P8 independently rechecks that invariant before appending its own
        // OwnerLog event, and rejects incomplete observations as well as
        // missing/UNKNOWN workspace states.
        let receipt = proof.final_worktree_receipt().ok_or(WorkerDurableError::Conflict(
            "successful managed settlement requires the durable final Inspect receipt",
        ))?;
        self.validate_settlement_worktree_receipt(receipt, &root_owner, pins, terminal)?;
        if terminal.observed_workspace_head() != Some(receipt.observed_workspace_revision())
            || receipt.workspace_binding() != pins.workspace_binding()
            || !receipt.owned() || !receipt.no_follow()
        {
            return Err(WorkerDurableError::Conflict("final guarded workspace observation differs from P2 terminal head"));
        }
        let event = ManagedLogicalSettlementEventV1 {
            schema_version: 4,
            worker_execution_id: worker_id.clone(), attempt_id: pins.attempt_id().to_owned(),
            proof_digest: proof.proof_digest().to_owned(),
            observed_workspace_revision: Some(receipt.observed_workspace_revision().to_owned()),
            final_worktree_operation_id: Some(receipt.operation_id().to_owned()),
            final_worktree_host_receipt_ref: Some(receipt.host_receipt_ref().to_owned()),
            evidence_digest: terminal.evidence_digest().map(str::to_owned),
            evidence_refs: terminal.evidence_refs().to_vec(),
            verification_run_id: proof.verifier_pins().map(|pins| pins.verification_run_id().to_owned()),
            set_identity_digest: proof.verifier_pins().map(|pins| pins.set_identity_digest().to_owned()),
            challenge_set_digest: proof.verifier_pins().map(|pins| pins.challenge_set_digest().to_owned()),
            reusable_worktree: false,
            reconciliation_owner_epoch: None,
            disposition_deferred: true,
        };
        let settlement_attempt_id = pins.attempt_id().to_owned();
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let delivery_id = format!("worker-managed-settle-{worker_id}");
        self.apply(revision, &delivery_id, WorkerCommand::ManagedLogicalSettled { event })?;
        self.ensure_managed_worktree_disposition(&worker_id, &settlement_attempt_id, None)?;
        self.managed_settlement_receipts.get(&worker_id).cloned()
            .ok_or(WorkerDurableError::Invalid("settlement OwnerLog receipt was not materialized"))
    }

    fn validate_settlement_worktree_receipt(
        &self,
        receipt: &GuardedWorktreeReceiptV1,
        root_owner: &WorktreeRootOwnerV1,
        pins: &TrustedPreAdmissionPinsV1,
        terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
    ) -> Result<(), WorkerDurableError> {
        let operation = self.worktree_operations.get(receipt.operation_id()).ok_or(
            WorkerDurableError::Conflict("final Inspect receipt has no durable P8 operation"),
        )?;
        let intent = operation.intent();
        let registration = self.identities.worktree_registration_records
            .get(&pins.worktree.worktree_id)
            .filter(|registration| same_worktree_root_lineage(registration.owner(), root_owner)
                && registration.owner().owner_epoch() <= root_owner.owner_epoch()
                && !self.identities.removed_worktree_registrations.contains_key(&pins.worktree.worktree_id)
                && registration.matches_durable_operations(&self.worktree_operations))
            .ok_or(WorkerDurableError::Conflict("final Inspect registration lineage is unavailable"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "final Inspect registration provenance is unavailable",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .filter(|create| create.state() == WorktreeOperationStateV1::Completed
                && create.intent().kind() == WorktreeOperationKindV1::Create
                && same_worktree_root_lineage(create.intent().owner(), root_owner)
                && create.intent().owner().owner_epoch() <= root_owner.owner_epoch()
                && create.intent().worktree_id() == pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::Conflict("final Inspect Create provenance is unavailable"))?;
        if operation.state() != WorktreeOperationStateV1::Completed
            || operation.receipt() != Some(receipt)
            || intent.kind() != WorktreeOperationKindV1::Inspect
            || intent.owner() != root_owner
            || intent.operation_id() != worktree_operation_id(
                intent.owner(), WorktreeOperationKindV1::Inspect,
                &managed_final_inspect_idempotency_key(pins.attempt_id()),
            )
            || intent.worktree_id() != pins.worktree.worktree_id
            || intent.base_revision() != Some(pins.worktree.base_revision.as_str())
            || intent.root() != create.intent().root()
            || intent.root().location_ref() != pins.location_id()
            || intent.relative_path() != create.intent().relative_path()
            || intent.root().workspace_binding() != pins.workspace_binding()
            || intent.expected_workspace_revision() != terminal.observed_workspace_head().unwrap_or_default()
            || receipt.workspace_binding() != pins.workspace_binding()
            || receipt.observed_workspace_revision() != terminal.observed_workspace_head().unwrap_or_default()
            || !final_inspect_allows_verified_settlement(receipt)
        {
            return Err(WorkerDurableError::Conflict("final Inspect receipt is not the exact durable P8 operation for this Attempt"));
        }
        Ok(())
    }

    fn ensure_managed_worktree_disposition(
        &mut self,
        worker_execution_id: &str,
        attempt_id: &str,
        reconciliation_owner_epoch: Option<u64>,
    ) -> Result<(), WorkerDurableError> {
        let settlement = self.resolve_managed_settlement_for_attempt_inner(attempt_id, false)?
            .ok_or(WorkerDurableError::Conflict("managed settlement is not durable before worktree disposition"))?;
        if settlement.worker_execution_id() != worker_execution_id {
            return Err(WorkerDurableError::ReplayConflict(
                "settlement receipt belongs to another worker before worktree disposition",
            ));
        }
        let operation_id = settlement.final_worktree_operation_id().ok_or(
            WorkerDurableError::Conflict("managed settlement has no final Inspect operation for disposition"),
        )?;
        let host_receipt_ref = settlement.final_worktree_host_receipt_ref().ok_or(
            WorkerDurableError::Conflict("managed settlement has no HostKernel Inspect receipt for disposition"),
        )?;
        let observed_revision = settlement.final_workspace_revision().ok_or(
            WorkerDurableError::Conflict("managed settlement has no observed revision for disposition"),
        )?;
        let inspect = self.worktree_operations.get(operation_id).ok_or(
            WorkerDurableError::ReplayConflict("final Inspect is unavailable for worktree disposition"),
        )?;
        let receipt = inspect.receipt().ok_or(
            WorkerDurableError::ReplayConflict("final Inspect receipt is unavailable for worktree disposition"),
        )?;
        let inspect_receipt_digest = logical_command_digest(
            "worker_final_inspect_receipt", &worktree_receipt_value(receipt),
        );
        let original_owner_epoch = self.identities.pre_admission_pins.get(worker_execution_id)
            .ok_or(WorkerDurableError::ReplayConflict(
                "managed worktree disposition has no immutable admission pins",
            ))?.owner_epoch();
        let reusable_worktree = receipt.status() == WorktreeObservedStatusV1::Clean
            && receipt.dirty_entry_count() == 0
            && !receipt.contains_user_owned_changes()
            && receipt.owned() && receipt.no_follow();
        let event = ManagedWorktreeDispositionEventV1 {
            worker_execution_id: worker_execution_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            owner_epoch: original_owner_epoch,
            settlement_receipt_digest: settlement.receipt_digest().to_owned(),
            final_worktree_operation_id: operation_id.to_owned(),
            final_worktree_host_receipt_ref: host_receipt_ref.to_owned(),
            observed_workspace_revision: observed_revision.to_owned(),
            inspect_receipt_digest,
            reusable_worktree,
            reconciliation_owner_epoch,
            reconciliation_proof_digest: reconciliation_owner_epoch.map(|_| settlement.proof_digest().to_owned()),
        };
        if let Some(existing) = self.managed_worktree_disposition_events.get(worker_execution_id) {
            let legacy_epoch_replay = existing.reconciliation_owner_epoch.is_some()
                && existing.reconciliation_proof_digest.is_none()
                && existing.worker_execution_id == event.worker_execution_id
                && existing.attempt_id == event.attempt_id
                && existing.owner_epoch == event.owner_epoch
                && existing.settlement_receipt_digest == event.settlement_receipt_digest
                && existing.final_worktree_operation_id == event.final_worktree_operation_id
                && existing.final_worktree_host_receipt_ref == event.final_worktree_host_receipt_ref
                && existing.observed_workspace_revision == event.observed_workspace_revision
                && existing.inspect_receipt_digest == event.inspect_receipt_digest
                && existing.reusable_worktree == event.reusable_worktree
                && existing.reconciliation_owner_epoch == event.reconciliation_owner_epoch;
            return if existing == &event || legacy_epoch_replay {
                Ok(())
            } else {
                Err(WorkerDurableError::ReplayConflict(
                    "managed worktree disposition changed after durable settlement",
                ))
            };
        }
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let delivery_id = format!("worker-managed-worktree-disposition-{worker_execution_id}");
        self.apply(revision, &delivery_id, WorkerCommand::ManagedWorktreeDisposition { event })
    }

    /// Resolve the exact retained worktree for post-restart recovery of a
    /// successful settlement. All identifying path/registration facts come
    /// from P8 pins; current root and terminal evidence are re-resolved.
    pub(crate) fn resolve_settled_managed_worktree_recovery_target(
        &self,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        owner: &AuthenticatedOwnerContext,
        terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        attempt_id: &str,
    ) -> Result<SettledManagedWorktreeRecoveryTargetV1, WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let settlement = self.resolve_managed_settlement_for_attempt_inner(attempt_id, false)?
            .ok_or(WorkerDurableError::NotFound("managed settlement receipt unavailable"))?;
        let pins = self.identities.pre_admission_pins.get(settlement.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("settled worker admission pins unavailable"))?;
        let binding = self.identities.delegation_bindings.get(settlement.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("settled worker binding unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(settlement.worker_execution_id())?;
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let worker = pool.worker(settlement.worker_execution_id()).ok_or(
            WorkerDurableError::ReplayConflict("settled logical worker missing"),
        )?;
        let tree = pool.worktree_snapshot(&pins.worktree.worktree_id).ok_or(
            WorkerDurableError::ReplayConflict("settled worktree row missing"),
        )?;
        if !settlement.disposition_deferred()
            || settlement.disposition() != WorkerManagedSettlementDispositionV1::Released
            || settlement.attempt_id() != attempt_id
            || owner.owner_epoch() != self.resumed_epoch
            || owner.owner_epoch() <= pins.owner_epoch()
            || owner.principal_ref() != pins.principal_ref()
            || owner.workspace_binding() != pins.workspace_binding()
            || owner.session_id() != pins.session_id()
            || owner.run_id() != pins.owner().run_id()
            || owner.task_id() != pins.owner().task_id()
            || owner.attempt_id() != pins.attempt_id()
            || root_owner.goal_id() != pins.goal_id()
            || root_owner.run_id() != pins.owner().run_id()
            || root_owner.principal_ref() != pins.principal_ref()
            || root_owner.workspace_binding() != pins.workspace_binding()
            || root_owner.session_id() != managed_root_session_id(pins.parent_proof())?
            || root_owner.location_id() != pins.location_id()
            || root_owner.owner_epoch() != owner.owner_epoch()
            || root_owner.accepted_spec_digest() != pins.accepted_spec_digest()
            || terminal.goal_id() != pins.goal_id()
            || terminal.run_id() != pins.owner().run_id()
            || terminal.task_id() != pins.owner().task_id()
            || terminal.attempt_id() != pins.attempt_id()
            || terminal.task_revision() != pins.task_revision().parse::<u64>()
                .map_err(|_| WorkerDurableError::ReplayConflict("pinned Task revision invalid"))?
            || terminal.binding_digest() != binding.binding_digest
            || terminal.admission_workspace_revision() != Some(binding.child_workspace_revision()?)
            || terminal.spec_digest() != pins.accepted_spec_digest()
            || terminal.attempt_state() != crate::managed_control::ManagedAttemptTerminalStateV1::Succeeded
            || terminal.task_state() != crate::managed_control::ManagedTaskTerminalStateV1::Verified
            || terminal.child_prompt_state() != crate::managed_control::ManagedChildPromptStateV1::Quiesced
            || terminal.effect_chain_state() != crate::managed_control::ManagedAttemptEffectChainStateV1::AllSettled
            || terminal.evidence_digest() != settlement.evidence_digest()
            || terminal.observed_workspace_head().is_none()
            || terminal.owner_log_sequence() == 0
            || terminal.managed_revision() == 0
            || !valid_digest(terminal.owner_log_event_digest(), "blake3:")
            || !valid_digest(terminal.attempt_state_digest(), "blake3:")
            || !valid_digest(terminal.effect_chain_digest(), "blake3:")
            || terminal.child_prompt_quiescence().is_none_or(|q| {
                let marker = q.proof();
                marker.goal_id() != pins.goal_id()
                    || marker.run_id() != pins.owner().run_id()
                    || marker.task_id() != pins.owner().task_id()
                    || marker.attempt_id() != pins.attempt_id()
                    || marker.parent_session_id() != root_owner.session_id()
                    || marker.session_id() != owner.session_id()
                    || marker.owner_epoch() != owner.owner_epoch()
            })
            || terminal.child_prompt_quiescence_digest().is_none_or(|digest| !valid_digest(digest, "blake3:"))
            || terminal.child_prompt_quiescence_owner_log_id().is_none_or(str::is_empty)
            || terminal.child_prompt_quiescence_owner_log_sequence().is_none_or(|sequence| sequence == 0)
            || terminal.child_prompt_quiescence_owner_log_event_digest().is_none_or(|digest| !valid_digest(digest, "blake3:"))
            || terminal.effects().len() > MAX_BATCH_EVENTS
            || terminal.effects().iter().any(|effect| effect.outcome().is_none()
                || effect.outcome() == Some(crate::managed_control::AttemptEffectOutcomeV1::Unknown)
                || effect.observation_digest().is_none_or(|digest| !valid_digest(digest, "blake3:")))
            || worker.owner.attempt_id != attempt_id
            || worker.state != crate::resource_budget::ReservationState::Released
            || worker.process_identity.is_some()
            || worker.cancellation_requested
            || worker.unknown_effect
            || worker.worktree_lease_id.as_deref() != tree.lease_id.as_deref()
            || pool.worker_reservation_id(settlement.worker_execution_id()) != Some(claim.reservation().budget_lease_id())
            || worker.worktree_lease_id.as_deref() != Some(claim.reservation().workspace_lease_id())
            || tree.status != crate::worktree_pool::WorktreeStatus::Quarantined
            || tree.lease_id.is_none()
            || tree.workspace_binding != pins.workspace_binding()
        {
            return Err(WorkerDurableError::Conflict(
                "fresh settled-worktree recovery authority differs from the exact verified Attempt and retained lease",
            ));
        }
        let registration = self.identities.worktree_registration_records.get(&pins.worktree.worktree_id)
            .filter(|registration| !self.identities.removed_worktree_registrations.contains_key(&pins.worktree.worktree_id)
                && same_worktree_root_lineage(registration.owner(), &root_owner)
                && registration.owner().owner_epoch() == pins.owner_epoch()
                && registration.matches_durable_operations(&self.worktree_operations)
                && registration.verification_digest().is_some_and(|digest|
                    self.identities.verified_worktree_registrations.get(&pins.worktree.worktree_id).map(String::as_str) == Some(digest)))
            .ok_or(WorkerDurableError::Conflict("settled worktree guarded registration unavailable"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "settled worktree Create provenance unavailable",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .ok_or(WorkerDurableError::ReplayConflict("settled worktree Create operation unavailable"))?;
        let target = WorktreeLifecycleTargetV1 {
            owner: root_owner,
            worktree_id: pins.worktree.worktree_id.clone(),
            base_revision: pins.worktree.base_revision.clone(),
            relative_path: create.intent().relative_path().to_path_buf(),
            verification_digest: registration.verification_digest().ok_or(WorkerDurableError::Conflict(
                "settled worktree verification digest unavailable",
            ))?.to_owned(),
        };
        Ok(SettledManagedWorktreeRecoveryTargetV1 {
            target, root: create.intent().root().clone(), attempt_id: attempt_id.to_owned(),
            settlement_receipt_digest: settlement.receipt_digest().to_owned(),
            pool_revision: pool.revision(),
        })
    }

    pub(crate) fn prepare_settled_managed_worktree_recovery_inspect(
        &mut self,
        root: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        owner: &AuthenticatedOwnerContext,
        terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        target: &SettledManagedWorktreeRecoveryTargetV1,
        expected_revision: &str,
    ) -> Result<WorktreeLifecycleOperationPinV1, WorkerDurableError> {
        validate_owner_digest(expected_revision, "blake3:")?;
        let current = self.resolve_settled_managed_worktree_recovery_target(
            root, now_ms, owner, terminal, target.attempt_id(),
        )?;
        if &current != target || terminal.observed_workspace_head() != Some(expected_revision) {
            return Err(WorkerDurableError::Conflict("settlement recovery Inspect target or revision is stale"));
        }
        for record in self.worktree_operations.iter().filter(|record| {
            let intent = record.intent();
            intent.kind() == WorktreeOperationKindV1::Inspect
                && intent.owner() == target.target().owner()
                && intent.worktree_id() == target.target().worktree_id()
                && intent.relative_path() == target.target().relative_path()
                && intent.operation_id() == worktree_operation_id(
                    target.target().owner(), WorktreeOperationKindV1::Inspect,
                    &settled_reconciliation_inspect_key(target.attempt_id(), owner.owner_epoch(), intent.owner_log_sequence()),
                )
        }) {
            match record.state() {
                WorktreeOperationStateV1::Pending => {
                    if record.intent().expected_workspace_revision() != expected_revision {
                        return Err(WorkerDurableError::Conflict("pending settlement recovery Inspect is pinned to another revision"));
                    }
                    return Ok(WorktreeLifecycleOperationPinV1::from_durable_intent(record.intent().clone()));
                }
                WorktreeOperationStateV1::Unknown => return Err(WorkerDurableError::WorktreeIntentUnknown),
                WorktreeOperationStateV1::Quarantined => return Err(WorkerDurableError::WorktreeIntentQuarantined),
                WorktreeOperationStateV1::Completed => return Err(WorkerDurableError::WorktreeIntentCompleted),
                WorktreeOperationStateV1::RetiredNoDispatch => return Err(WorkerDurableError::WorktreeIntentRetired),
            }
        }
        let (owner_log_id, sequence, event_digest, _) = self.owner_log_watermark()?;
        let key = settled_reconciliation_inspect_key(target.attempt_id(), owner.owner_epoch(), &sequence);
        let intent = WorktreeOperationIntentV1::new(
            worktree_operation_id(target.target().owner(), WorktreeOperationKindV1::Inspect, &key),
            WorktreeOperationKindV1::Inspect, target.target().owner().clone(), target.root().clone(),
            target.target().worktree_id().to_owned(), target.target().base_revision().to_owned(),
            target.target().relative_path().to_path_buf(), expected_revision.to_owned(),
            owner_log_id, sequence, event_digest,
        ).map_err(map_worktree_lifecycle_error)?;
        let operation_id = intent.operation_id().to_owned();
        self.persist_worktree_intent(&format!("worktree-settlement-reconcile-intent-{operation_id}"), intent.clone())?;
        Ok(WorktreeLifecycleOperationPinV1::from_durable_intent(intent))
    }

    pub(crate) fn mark_settled_managed_worktree_recovery_inspect_started(
        &mut self,
        root: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        owner: &AuthenticatedOwnerContext,
        terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        target: &SettledManagedWorktreeRecoveryTargetV1,
        pin: &WorktreeLifecycleOperationPinV1,
    ) -> Result<GuardedWorktreeRequestV1, WorkerDurableError> {
        let current = self.resolve_settled_managed_worktree_recovery_target(
            root, now_ms, owner, terminal, target.attempt_id(),
        )?;
        let record = self.worktree_operations.get(pin.operation_id()).ok_or(
            WorkerDurableError::NotFound("settlement recovery Inspect intent unavailable"),
        )?;
        if &current != target || record.intent() != pin.intent()
            || record.state() != WorktreeOperationStateV1::Pending
            || record.intent().kind() != WorktreeOperationKindV1::Inspect
            || record.intent().owner() != target.target().owner()
            || record.intent().root() != target.root()
            || record.intent().owner_epoch() != owner.owner_epoch()
            || terminal.observed_workspace_head() != Some(record.intent().expected_workspace_revision())
            || record.intent().operation_id() != worktree_operation_id(
                target.target().owner(), WorktreeOperationKindV1::Inspect,
                &settled_reconciliation_inspect_key(target.attempt_id(), owner.owner_epoch(), record.intent().owner_log_sequence()),
            )
        {
            return Err(WorkerDurableError::Conflict("settlement recovery Inspect intent is stale or mismatched"));
        }
        let intent = record.intent().clone();
        let revision = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.revision();
        self.apply(revision, &format!("worktree-settlement-reconcile-dispatch-{}", pin.operation_id()),
            WorkerCommand::WorktreeOperationDispatchStarted { operation_id: pin.operation_id().to_owned() })?;
        Ok(GuardedWorktreeRequestV1::from_durable_intent(intent))
    }

    pub(crate) fn persist_settled_managed_worktree_recovery_inspect(
        &mut self,
        root: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        owner: &AuthenticatedOwnerContext,
        terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        target: &SettledManagedWorktreeRecoveryTargetV1,
        receipt: GuardedWorktreeReceiptV1,
    ) -> Result<(), WorkerDurableError> {
        let current = self.resolve_settled_managed_worktree_recovery_target(
            root, now_ms, owner, terminal, target.attempt_id(),
        )?;
        let record = self.worktree_operations.get(receipt.operation_id()).ok_or(
            WorkerDurableError::NotFound("settlement recovery Inspect intent unavailable"),
        )?;
        if &current != target || record.intent().kind() != WorktreeOperationKindV1::Inspect
            || record.intent().owner() != target.target().owner()
            || record.intent().root() != target.root()
            || record.intent().worktree_id() != target.target().worktree_id()
            || record.intent().owner_epoch() != owner.owner_epoch()
            || terminal.observed_workspace_head() != Some(record.intent().expected_workspace_revision())
            || record.intent().operation_id() != worktree_operation_id(
                target.target().owner(), WorktreeOperationKindV1::Inspect,
                &settled_reconciliation_inspect_key(target.attempt_id(), owner.owner_epoch(), record.intent().owner_log_sequence()),
            )
            || record.state() != WorktreeOperationStateV1::Unknown
            || receipt.workspace_binding() != owner.workspace_binding()
            || receipt.registration_generation() != record.intent().root().registration_generation()
            || receipt.observed_workspace_revision() != record.intent().expected_workspace_revision()
            || !receipt.owned() || !receipt.no_follow()
            || !final_inspect_allows_verified_settlement(&receipt)
            || matches!(receipt.status(), WorktreeObservedStatusV1::Missing | WorktreeObservedStatusV1::Unknown)
        {
            return Err(WorkerDurableError::Conflict("settlement recovery Guarded Inspect receipt is mismatched"));
        }
        let revision = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.revision();
        self.apply(revision, &format!("worktree-settlement-reconcile-receipt-{}", target.attempt_id()),
            WorkerCommand::WorktreeOperationReceipt { receipt })
    }

    pub(crate) fn resolve_settled_managed_worktree_recovery_inspect(
        &self,
        root: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        owner: &AuthenticatedOwnerContext,
        terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        attempt_id: &str,
        operation_id: &str,
    ) -> Result<GuardedWorktreeReceiptV1, WorkerDurableError> {
        let target = self.resolve_settled_managed_worktree_recovery_target(
            root, now_ms, owner, terminal, attempt_id,
        )?;
        let operation = self.worktree_operations.get(operation_id).ok_or(
            WorkerDurableError::NotFound("settlement recovery Inspect operation unavailable"),
        )?;
        let intent = operation.intent();
        let expected_operation = worktree_operation_id(
            target.target().owner(), WorktreeOperationKindV1::Inspect,
            &settled_reconciliation_inspect_key(attempt_id, owner.owner_epoch(), intent.owner_log_sequence()),
        );
        let receipt = operation.receipt().ok_or(WorkerDurableError::Conflict(
            "settlement recovery Inspect has no durable Guard receipt",
        ))?;
        if operation_id != expected_operation
            || intent.kind() != WorktreeOperationKindV1::Inspect
            || intent.owner() != target.target().owner()
            || intent.root() != target.root()
            || intent.worktree_id() != target.target().worktree_id()
            || intent.relative_path() != target.target().relative_path()
            || intent.owner_epoch() != owner.owner_epoch()
            || operation.state() != WorktreeOperationStateV1::Completed
            || receipt.operation_id() != operation_id
            || receipt.workspace_binding() != owner.workspace_binding()
            || receipt.registration_generation() != target.root().registration_generation()
            || receipt.observed_workspace_revision() != intent.expected_workspace_revision()
            || terminal.observed_workspace_head() != Some(receipt.observed_workspace_revision())
            || !receipt.owned() || !receipt.no_follow()
            || !final_inspect_allows_verified_settlement(receipt)
            || receipt.contains_user_owned_changes()
            || matches!(receipt.status(), WorktreeObservedStatusV1::Missing | WorktreeObservedStatusV1::Unknown)
        {
            return Err(WorkerDurableError::Conflict(
                "durable settlement recovery Inspect does not match the current Attempt and root",
            ));
        }
        Ok(receipt.clone())
    }

    /// Persist the separate recovered disposition only after the fresh P1/P2
    /// proof has been revalidated. Any changed revision stays quarantined.
    pub(crate) fn reconcile_settled_managed_worktree_disposition(
        &mut self,
        proof: WorkerSettlementDispositionRecoveryProofV1,
        now_ms: u64,
    ) -> Result<WorkerWorktreeDispositionReceiptV1, WorkerDurableError> {
        let receipt = &proof.current_worktree_receipt;
        let terminal = &proof.current_terminal;
        let owner = &proof.current_owner;
        let settlement = self.resolve_managed_settlement_for_attempt_inner(terminal.attempt_id(), false)?
            .ok_or(WorkerDurableError::NotFound("settlement unavailable for disposition recovery"))?;
        if let Some(existing) = self.resolve_managed_worktree_disposition_for_attempt(terminal.attempt_id())? {
            let root_owner = self.resolve_worktree_root_owner(&proof.current_root, now_ms)?;
            let pins = self.identities.pre_admission_pins.get(settlement.worker_execution_id())
                .ok_or(WorkerDurableError::ReplayConflict("settlement admission pins missing"))?;
            let operation = self.worktree_operations.get(proof.current_worktree_receipt.operation_id())
                .ok_or(WorkerDurableError::ReplayConflict("recovered Inspect operation missing"))?;
            let event = self.managed_worktree_disposition_events.get(settlement.worker_execution_id())
                .ok_or(WorkerDurableError::ReplayConflict("recovered disposition event missing"))?;
            let root_session_id = managed_root_session_id(pins.parent_proof())?;
            if existing.reconciliation_owner_epoch() == Some(owner.owner_epoch())
                && owner.owner_epoch() == self.resumed_epoch
                && owner.principal_ref() == pins.principal_ref()
                && owner.workspace_binding() == pins.workspace_binding()
                && owner.session_id() == pins.session_id()
                && owner.run_id() == pins.owner().run_id()
                && owner.task_id() == pins.owner().task_id()
                && owner.attempt_id() == pins.attempt_id()
                && root_owner.owner_epoch() == owner.owner_epoch()
                && root_owner.workspace_binding() == owner.workspace_binding()
                && root_owner.session_id() == root_session_id
                && root_owner.location_id() == pins.location_id()
                && root_owner.accepted_spec_digest() == pins.accepted_spec_digest()
                && terminal.attempt_id() == pins.attempt_id()
                && terminal.goal_id() == pins.goal_id()
                && terminal.binding_digest() == self.identities.delegation_bindings
                    .get(settlement.worker_execution_id()).map(|binding| binding.binding_digest.as_str()).unwrap_or_default()
                && terminal.task_state() == crate::managed_control::ManagedTaskTerminalStateV1::Verified
                && terminal.attempt_state() == crate::managed_control::ManagedAttemptTerminalStateV1::Succeeded
                && terminal.effect_chain_state() == crate::managed_control::ManagedAttemptEffectChainStateV1::AllSettled
                && terminal.observed_workspace_head() == Some(existing.observed_workspace_revision())
                && existing.final_worktree_operation_id() == proof.current_worktree_receipt.operation_id()
                && existing.inspect_receipt_digest() == logical_command_digest(
                    "worker_final_inspect_receipt", &worktree_receipt_value(&proof.current_worktree_receipt),
                )
                && operation.receipt() == Some(&proof.current_worktree_receipt)
                && final_inspect_allows_verified_settlement(&proof.current_worktree_receipt)
                && event.reconciliation_proof_digest.is_some()
            {
                return Ok(existing);
            }
            return Err(WorkerDurableError::ReplayConflict(
                "settlement recovery retry differs from its committed current-epoch disposition",
            ));
        }
        let target = self.resolve_settled_managed_worktree_recovery_target(
            &proof.current_root, now_ms, owner, terminal, terminal.attempt_id(),
        )?;
        let operation = self.worktree_operations.get(receipt.operation_id()).ok_or(
            WorkerDurableError::Conflict("fresh recovery Inspect has no durable operation"),
        )?;
        let intent = operation.intent();
        if target.settlement_receipt_digest() != settlement.receipt_digest()
            || intent.kind() != WorktreeOperationKindV1::Inspect
            || intent.owner() != target.target().owner()
            || intent.root() != target.root()
            || intent.worktree_id() != target.target().worktree_id()
            || intent.relative_path() != target.target().relative_path()
            || intent.owner_epoch() != owner.owner_epoch()
            || intent.operation_id() != worktree_operation_id(
                target.target().owner(), WorktreeOperationKindV1::Inspect,
                &settled_reconciliation_inspect_key(target.attempt_id(), owner.owner_epoch(), intent.owner_log_sequence()),
            )
            || operation.state() != WorktreeOperationStateV1::Completed
            || operation.receipt() != Some(receipt)
            || receipt.workspace_binding() != owner.workspace_binding()
            || receipt.observed_workspace_revision() != terminal.observed_workspace_head().unwrap_or_default()
            || !receipt.owned() || !receipt.no_follow()
            || !final_inspect_allows_verified_settlement(receipt)
            || receipt.contains_user_owned_changes()
            || matches!(receipt.status(), WorktreeObservedStatusV1::Missing | WorktreeObservedStatusV1::Unknown)
        {
            return Err(WorkerDurableError::Conflict(
                "fresh Inspect is not the exact current-epoch guarded recovery receipt for this settlement",
            ));
        }
        let reusable = receipt.status() == WorktreeObservedStatusV1::Clean
            && receipt.dirty_entry_count() == 0;
        let pins = self.identities.pre_admission_pins.get(settlement.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("settlement admission pins missing"))?;
        let mut recovery = blake3::Hasher::new();
        recovery.update(b"horizoncode.worker-settlement-disposition-ownerlog-proof.v1\0");
        for value in [proof.proof_digest.as_str(), settlement.receipt_digest(),
            pins.pins_digest(), settlement.worker_execution_id(), terminal.attempt_id()] {
            append_digest_field(&mut recovery, value);
        }
        recovery.update(&owner.owner_epoch().to_be_bytes());
        let reconciliation_proof_digest = format!("blake3:{}", recovery.finalize().to_hex());
        let event = ManagedWorktreeDispositionEventV1 {
            worker_execution_id: settlement.worker_execution_id().to_owned(),
            attempt_id: terminal.attempt_id().to_owned(),
            owner_epoch: pins.owner_epoch(),
            settlement_receipt_digest: settlement.receipt_digest().to_owned(),
            final_worktree_operation_id: receipt.operation_id().to_owned(),
            final_worktree_host_receipt_ref: receipt.host_receipt_ref().to_owned(),
            observed_workspace_revision: receipt.observed_workspace_revision().to_owned(),
            inspect_receipt_digest: logical_command_digest("worker_final_inspect_receipt", &worktree_receipt_value(receipt)),
            reusable_worktree: reusable,
            reconciliation_owner_epoch: Some(owner.owner_epoch()),
            reconciliation_proof_digest: Some(reconciliation_proof_digest),
        };
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        self.apply(revision, &format!("worker-managed-worktree-reconcile-{}-{}", terminal.attempt_id(), owner.owner_epoch()),
            WorkerCommand::ManagedWorktreeDisposition { event })?;
        self.resolve_managed_worktree_disposition_for_attempt(terminal.attempt_id())?
            .ok_or(WorkerDurableError::Invalid("reconciled disposition receipt was not materialized"))
    }

    pub(crate) fn resolve_managed_worktree_disposition_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<WorkerWorktreeDispositionReceiptV1>, WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let mut matches = self.managed_worktree_disposition_receipts.values()
            .filter(|receipt| receipt.attempt_id() == attempt_id);
        let Some(receipt) = matches.next() else { return Ok(None); };
        if matches.next().is_some() {
            return Err(WorkerDurableError::ReplayConflict(
                "Attempt maps to multiple worktree disposition receipts",
            ));
        }
        let settlement = self.managed_settlement_receipts.get(receipt.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("worktree disposition has no settlement receipt"))?;
        let event = self.managed_worktree_disposition_events.get(receipt.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("worktree disposition event is missing"))?;
        let cursor = CursorV1 {
            owner_kind: OWNER_KIND.to_owned(), owner_id: receipt.owner_log_id().to_owned(),
            seq: receipt.owner_log_sequence().to_owned(),
            event_digest: receipt.owner_log_event_digest().to_owned(),
        };
        let expected = WorkerWorktreeDispositionReceiptV1::from_committed_event(
            event, &cursor, receipt.worker_pool_revision(),
        );
        if &expected != receipt || !settlement.disposition_deferred()
            || settlement.attempt_id() != attempt_id
            || settlement.receipt_digest() != receipt.settlement_receipt_digest()
            || !valid_digest(receipt.receipt_digest(), "blake3:")
        {
            return Err(WorkerDurableError::ReplayConflict(
                "worktree disposition receipt differs from its durable settlement event",
            ));
        }
        let pins = self.identities.pre_admission_pins.get(receipt.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("worktree disposition has no immutable pins"))?;
        if receipt.owner_epoch() != pins.owner_epoch() || event.owner_epoch != pins.owner_epoch() {
            return Err(WorkerDurableError::ReplayConflict(
                "worktree disposition owner epoch differs from immutable admission pins",
            ));
        }
        if event.reconciliation_owner_epoch.is_some_and(|epoch| {
            epoch <= event.owner_epoch
                || (event.reconciliation_proof_digest.as_deref().is_some_and(|digest| !valid_digest(digest, "blake3:")))
                || (event.reconciliation_proof_digest.is_some()
                    && self.worktree_operations.get(&event.final_worktree_operation_id)
                        .is_none_or(|operation| operation.intent().owner_epoch() != epoch))
                || (event.reconciliation_proof_digest.is_none()
                    && settlement.reconciliation_owner_epoch() != Some(epoch))
        }) || event.reconciliation_owner_epoch.is_none() && event.reconciliation_proof_digest.is_some()
        {
            return Err(WorkerDurableError::ReplayConflict(
                "reconciled worktree disposition lost its current-epoch authority pins",
            ));
        }
        let snapshot = self.pool.as_ref()
            .and_then(|pool| pool.worktree_snapshot(&pins.worktree.worktree_id))
            .ok_or(WorkerDurableError::ReplayConflict("worktree disposition pool record is missing"))?;
        let expected_status = match receipt.disposition() {
            WorkerWorktreeDispositionV1::Reusable => crate::worktree_pool::WorktreeStatus::Free,
            WorkerWorktreeDispositionV1::Quarantined => crate::worktree_pool::WorktreeStatus::Quarantined,
        };
        if snapshot.status != expected_status
            || snapshot.observed_revision.as_deref() != Some(receipt.observed_workspace_revision())
            || snapshot.workspace_binding != pins.workspace_binding()
            || snapshot.lease_id.is_some()
        {
            return Err(WorkerDurableError::ReplayConflict(
                "worktree pool state does not match its durable disposition receipt",
            ));
        }
        Ok(Some(receipt.clone()))
    }

    /// Immutable original admission epoch for P1's authenticated recovery
    /// projection. The epoch comes only from P8's durable pre-admission pins,
    /// never from a caller. A committed disposition receipt must carry the
    /// same epoch and digest-bound event field.
    pub(crate) fn managed_worktree_disposition_owner_epoch_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<u64>, WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let Some(settlement) = self.resolve_managed_settlement_for_attempt_inner(attempt_id, false)? else {
            return Ok(None);
        };
        if !settlement.disposition_deferred() {
            return Ok(None);
        }
        let pins = self.identities.pre_admission_pins.get(settlement.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict(
                "worktree disposition epoch has no immutable admission pins",
            ))?;
        if let Some(receipt) = self.resolve_managed_worktree_disposition_for_attempt(attempt_id)? {
            if receipt.owner_epoch() != pins.owner_epoch() {
                return Err(WorkerDurableError::ReplayConflict(
                    "worktree disposition receipt epoch differs from immutable admission pins",
                ));
            }
        }
        Ok(Some(pins.owner_epoch()))
    }

    /// Original admission owner epoch for P1's settlement recovery fence.
    /// This is intentionally sourced from immutable P8 pins rather than a
    /// HostKernel request field or caller-supplied epoch.
    pub(crate) fn managed_settlement_owner_epoch_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<u64>, WorkerDurableError> {
        self.managed_worktree_disposition_owner_epoch_for_attempt(attempt_id)
    }

    /// Report the crash window after logical-worker capacity settlement but
    /// before the independent worktree disposition event. This is deliberately
    /// a projection only: it cannot release the retained lease or reuse the
    /// historical final Inspect after an owner epoch change.
    pub(crate) fn managed_worktree_disposition_pending_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<bool, WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let Some(settlement) = self.resolve_managed_settlement_for_attempt_inner(attempt_id, false)? else {
            return Ok(false);
        };
        if !settlement.disposition_deferred() {
            return Ok(false);
        }
        if self.resolve_managed_worktree_disposition_for_attempt(attempt_id)?.is_some() {
            return Ok(false);
        }
        let pins = self.identities.pre_admission_pins.get(settlement.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict(
                "pending worktree disposition has no immutable Attempt pins",
            ))?;
        let pool = self.pool.as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let worker = pool.worker(settlement.worker_execution_id()).ok_or(
            WorkerDurableError::ReplayConflict("pending worktree disposition worker is missing"),
        )?;
        let tree = pool.worktree_snapshot(&pins.worktree.worktree_id).ok_or(
            WorkerDurableError::ReplayConflict("pending worktree disposition pool row is missing"),
        )?;
        if worker.owner.attempt_id != attempt_id
            || worker.state != crate::resource_budget::ReservationState::Released
            || worker.process_identity.is_some()
            || worker.worktree_lease_id.as_deref() != tree.lease_id.as_deref()
            || tree.status != crate::worktree_pool::WorktreeStatus::Quarantined
            || tree.lease_id.is_none()
            || tree.workspace_binding != pins.workspace_binding()
        {
            return Err(WorkerDurableError::ReplayConflict(
                "pending disposition lost its quarantined worktree lease or process ownership state",
            ));
        }
        Ok(true)
    }

    /// Recovery hook for the crash window after capacity settlement committed
    /// but before the independent worktree disposition event was appended.
    /// It can only complete the exact already-settled Attempt and Inspect; it
    /// cannot dispatch effects or invent a new workspace observation.
    pub(crate) fn complete_pending_managed_worktree_disposition_for_attempt(
        &mut self,
        attempt_id: &str,
    ) -> Result<Option<WorkerWorktreeDispositionReceiptV1>, WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let mut matching = self.managed_settlement_receipts.values()
            .filter(|receipt| receipt.attempt_id() == attempt_id);
        let Some(settlement) = matching.next().cloned() else { return Ok(None); };
        if matching.next().is_some() {
            return Err(WorkerDurableError::ReplayConflict(
                "Attempt maps to multiple settlement receipts during disposition recovery",
            ));
        }
        if !settlement.disposition_deferred() {
            return Ok(None);
        }
        let expected_owner_epoch = self.managed_worktree_disposition_owner_epoch_for_attempt(attempt_id)?
            .ok_or(WorkerDurableError::ReplayConflict(
                "pending worktree disposition lost its immutable admission epoch",
            ))?;
        if self.resumed_epoch != expected_owner_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        self.ensure_managed_worktree_disposition(
            settlement.worker_execution_id(), attempt_id, settlement.reconciliation_owner_epoch(),
        )?;
        self.resolve_managed_worktree_disposition_for_attempt(attempt_id)
    }

    /// Reconciliation requires a new current-epoch Guarded Inspect. The old
    /// success-only final Inspect is historical evidence and cannot stand in
    /// for the current workspace observation after edits or restart.
    fn validate_managed_reconciliation_worktree_receipt(
        &self,
        receipt: &GuardedWorktreeReceiptV1,
        pins: &TrustedPreAdmissionPinsV1,
        current_root_owner: &WorktreeRootOwnerV1,
    ) -> Result<(), WorkerDurableError> {
        let operation = self.worktree_operations.get(receipt.operation_id()).ok_or(
            WorkerDurableError::Conflict("reconciliation Inspect receipt has no durable P8 operation"),
        )?;
        let intent = operation.intent();
        let registration = self.identities.worktree_registration_records
            .get(&pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::Conflict("reconciliation worktree registration is unavailable"))?;
        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
            "reconciliation worktree Create provenance is unavailable",
        ))?;
        let create = self.worktree_operations.get(provenance.create_operation_id())
            .filter(|create| create.state() == WorktreeOperationStateV1::Completed
                && create.intent().kind() == WorktreeOperationKindV1::Create
                && same_worktree_root_lineage(create.intent().owner(), current_root_owner)
                && create.intent().owner().owner_epoch() <= current_root_owner.owner_epoch()
                && create.intent().worktree_id() == pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::Conflict("reconciliation worktree Create receipt is unavailable"))?;
        if !registration.matches_durable_operations(&self.worktree_operations)
            || self.identities.removed_worktree_registrations.contains_key(&pins.worktree.worktree_id)
            || registration.registration().id != pins.worktree.worktree_id
            || registration.registration().workspace_binding != pins.workspace_binding()
            || registration.registration().base_revision != pins.worktree.base_revision
            || registration.owner().goal_id() != pins.goal_id()
            || registration.owner().run_id() != pins.run_id()
            || registration.owner().principal_ref() != pins.principal_ref()
            || registration.owner().workspace_binding() != pins.workspace_binding()
            || registration.owner().session_id() != managed_root_session_id(pins.parent_proof())?
            || registration.owner().location_id() != pins.location_id()
            || registration.owner().owner_epoch() != pins.owner_epoch()
            || !same_worktree_root_lineage(registration.owner(), current_root_owner)
            || operation.state() != WorktreeOperationStateV1::Completed
            || operation.receipt() != Some(receipt)
            || intent.kind() != WorktreeOperationKindV1::Inspect
            || intent.owner() != current_root_owner
            || intent.owner_epoch() != current_root_owner.owner_epoch()
            || intent.worktree_id() != pins.worktree.worktree_id
            || intent.base_revision() != Some(pins.worktree.base_revision.as_str())
            || intent.root() != create.intent().root()
            || intent.root().location_ref() != pins.location_id()
            || intent.root().workspace_binding() != pins.workspace_binding()
            || intent.relative_path() != create.intent().relative_path()
            || intent.expected_workspace_revision() != receipt.observed_workspace_revision()
            || receipt.workspace_binding() != pins.workspace_binding()
            || receipt.registration_generation() != intent.root().registration_generation()
            || matches!(receipt.status(), WorktreeObservedStatusV1::Unknown | WorktreeObservedStatusV1::Missing)
            || !receipt.owned() || !receipt.no_follow()
        {
            return Err(WorkerDurableError::Conflict("current reconciliation Inspect receipt differs from durable worktree and authenticated root lineage"));
        }
        Ok(())
    }

    pub(crate) fn resolve_managed_settlement_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<WorkerSettlementReceiptV1>, WorkerDurableError> {
        self.resolve_managed_settlement_for_attempt_inner(attempt_id, true)
    }

    fn resolve_managed_settlement_for_attempt_inner(
        &self,
        attempt_id: &str,
        require_worktree_disposition: bool,
    ) -> Result<Option<WorkerSettlementReceiptV1>, WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let mut matches = self.managed_settlement_receipts.values()
            .filter(|receipt| receipt.attempt_id() == attempt_id);
        let Some(receipt) = matches.next() else { return Ok(None); };
        if matches.next().is_some() {
            return Err(WorkerDurableError::ReplayConflict(
                "Attempt maps to multiple managed settlement receipts",
            ));
        }
        let pins = self.identities.pre_admission_pins.get(receipt.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("settlement receipt has no durable P8 pins"))?;
        let claim = self.identities.claim_receipts.get(receipt.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("settlement receipt has no durable claim"))?;
        if pins.attempt_id() != attempt_id
            || pins.pins_digest() != claim.pins_digest
            || claim.attempt_id != attempt_id
            || receipt.owner_log_id() != self.pool_id
            || !valid_digest(receipt.proof_digest(), "blake3:")
            || !valid_digest(receipt.owner_log_event_digest(), "blake3:")
            || !valid_digest(receipt.receipt_digest(), "blake3:")
        {
            return Err(WorkerDurableError::ReplayConflict(
                "managed settlement receipt differs from durable claim pins",
            ));
        }
        // Receipt replay is not complete merely because the settlement event
        // survived OwnerLog recovery. Re-resolve the exact P8 Inspect event
        // referenced by that settlement so a missing/truncated/mismatched
        // workspace observation cannot be projected as a recovered success.
        let operation_id = receipt.final_worktree_operation_id().ok_or(
            WorkerDurableError::ReplayConflict("managed settlement lost its final Inspect operation reference"),
        )?;
        let host_receipt_ref = receipt.final_worktree_host_receipt_ref().ok_or(
            WorkerDurableError::ReplayConflict("managed settlement lost its final Inspect receipt reference"),
        )?;
        let workspace_revision = receipt.final_workspace_revision().ok_or(
            WorkerDurableError::ReplayConflict("managed settlement lost its observed workspace revision"),
        )?;
        if !valid_digest(workspace_revision, "blake3:") {
            return Err(WorkerDurableError::ReplayConflict(
                "managed settlement workspace revision is invalid",
            ));
        }
        let inspect = self.worktree_operations.get(operation_id).ok_or(
            WorkerDurableError::ReplayConflict("managed settlement final Inspect event is unavailable after replay"),
        )?;
        let intent = inspect.intent();
        let guarded_receipt = inspect.receipt().ok_or(
            WorkerDurableError::ReplayConflict("managed settlement final Inspect receipt is unavailable after replay"),
        )?;
        let registration = self.identities.worktree_registration_records
            .get(&pins.worktree.worktree_id)
            .ok_or(WorkerDurableError::ReplayConflict("managed settlement worktree registration is unavailable"))?;
        if !registration.matches_durable_operations(&self.worktree_operations)
            || registration.registration().id != pins.worktree.worktree_id
            || registration.registration().workspace_binding != pins.workspace_binding()
            || registration.registration().base_revision != pins.worktree.base_revision
            || !same_worktree_root_lineage(registration.owner(), intent.owner())
            || !matches!(inspect.state(), WorktreeOperationStateV1::Completed | WorktreeOperationStateV1::Quarantined)
            || intent.kind() != WorktreeOperationKindV1::Inspect
            || intent.operation_id() != operation_id
            || intent.operation_id() != worktree_operation_id(
                intent.owner(), WorktreeOperationKindV1::Inspect,
                &managed_final_inspect_idempotency_key(attempt_id),
            )
            || intent.worktree_id() != pins.worktree.worktree_id
            || intent.base_revision() != Some(pins.worktree.base_revision.as_str())
            || intent.root().workspace_binding() != pins.workspace_binding()
            || intent.expected_workspace_revision() != workspace_revision
            || guarded_receipt.operation_id() != operation_id
            || guarded_receipt.host_receipt_ref() != host_receipt_ref
            || guarded_receipt.workspace_binding() != pins.workspace_binding()
            || guarded_receipt.registration_generation() != intent.root().registration_generation()
            || guarded_receipt.observed_workspace_revision() != workspace_revision
            || matches!(guarded_receipt.status(), WorktreeObservedStatusV1::Missing | WorktreeObservedStatusV1::Unknown)
            || !guarded_receipt.owned()
            || !guarded_receipt.no_follow()
        {
            return Err(WorkerDurableError::ReplayConflict(
                "managed settlement final Inspect receipt differs from its exact durable worktree event",
            ));
        }
        if require_worktree_disposition && receipt.disposition_deferred()
        {
            self.resolve_managed_worktree_disposition_for_attempt(attempt_id)?
                .ok_or(WorkerDurableError::Conflict(
                    "managed settlement is durable but its separate worktree disposition is pending",
                ))?;
        }
        Ok(Some(receipt.clone()))
    }

    pub(crate) fn resolve_managed_quarantine_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<WorkerManagedQuarantineReceiptV1>, WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let mut matches = self.managed_quarantine_receipts.values()
            .filter(|receipt| receipt.attempt_id() == attempt_id);
        let Some(receipt) = matches.next() else { return Ok(None); };
        if matches.next().is_some() {
            return Err(WorkerDurableError::ReplayConflict(
                "Attempt maps to multiple managed quarantine receipts",
            ));
        }
        let pins = self.identities.pre_admission_pins.get(receipt.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("quarantine receipt has no durable P8 pins"))?;
        let claim = self.identities.claim_receipts.get(receipt.worker_execution_id())
            .ok_or(WorkerDurableError::ReplayConflict("quarantine receipt has no durable claim"))?;
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(receipt.worker_execution_id()))
            .ok_or(WorkerDurableError::ReplayConflict("quarantine receipt has no durable worker"))?;
        if pins.attempt_id() != attempt_id
            || pins.goal_id() != receipt.goal_id()
            || pins.run_id() != receipt.run_id()
            || pins.task_id() != receipt.task_id()
            || pins.owner_epoch() != receipt.owner_epoch()
            || pins.pins_digest() != claim.pins_digest
            || claim.attempt_id != attempt_id
            || worker.state != crate::resource_budget::ReservationState::Quarantined
            || worker.owner.attempt_id != attempt_id
            || receipt.owner_log_id() != self.pool_id
            || !valid_digest(receipt.terminal_proof_digest(), "blake3:")
            || !valid_digest(receipt.owner_log_event_digest(), "blake3:")
            || !valid_digest(receipt.receipt_digest(), "blake3:")
        {
            return Err(WorkerDurableError::ReplayConflict(
                "managed quarantine receipt differs from durable P8 claim pins",
            ));
        }
        Ok(Some(receipt.clone()))
    }

    /// Reconcile a previously quarantined logical child after an owner epoch
    /// change. A fresh current-epoch Core/root proof must retain the exact Goal,
    /// Run, principal, Session, workspace and Attempt scope. No timeout or
    /// absence of a child PID is itself sufficient to release capacity.
    pub(crate) fn reconcile_managed_worker(
        &mut self,
        proof: WorkerReconciliationProofV1,
        now_ms: u64,
    ) -> Result<WorkerSettlementReceiptV1, WorkerDurableError> {
        let quarantine_proof = proof.quarantine();
        let worker_id = quarantine_proof.worker_execution_id().to_owned();
        let current_owner = proof.current_owner();
        let expected_task_state = match quarantine_proof.reason() {
            WorkerManagedQuarantineReasonV1::FailedAttempt => crate::managed_control::ManagedTaskTerminalStateV1::Failed,
            WorkerManagedQuarantineReasonV1::CancelledTask => crate::managed_control::ManagedTaskTerminalStateV1::Cancelled,
        };
        if current_owner.owner_epoch() != self.resumed_epoch
            || !valid_digest(proof.reconciliation_digest(), "blake3:")
        {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let combined_proof_digest = {
            let mut h = blake3::Hasher::new();
            h.update(b"horizoncode.logical-worker-reconciliation.v1\0");
            h.update(quarantine_proof.terminal_proof_digest().as_bytes());
            h.update(proof.reconciliation_digest().as_bytes());
            format!("blake3:{}", h.finalize().to_hex())
        };
        if let Some(receipt) = self.managed_settlement_receipts.get(&worker_id).cloned() {
            if receipt.proof_digest() == combined_proof_digest
                && receipt.attempt_id() == quarantine_proof.attempt_id()
            {
                self.ensure_managed_worktree_disposition(
                    &worker_id, quarantine_proof.attempt_id(), Some(current_owner.owner_epoch()),
                )?;
                return Ok(receipt);
            }
            return Err(WorkerDurableError::Conflict("worker already has a different settlement receipt"));
        }
        // The old settlement root is immutable lineage evidence only. Current
        // reconciliation authority must come from a newly authenticated root
        // proof in the resumed HostKernel epoch.
        let current_root = proof.current_root();
        let root_owner = self.resolve_quarantined_reconciliation_root_owner(current_root, now_ms)?;
        let pins = self.identities.pre_admission_pins.get(&worker_id)
            .ok_or(WorkerDurableError::NotFound("reconciliation worker pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(&worker_id)?;
        let binding = self.identities.delegation_bindings.get(&worker_id)
            .ok_or(WorkerDurableError::Conflict("reconciliation DelegationBinding missing"))?;
        let prior_owner = pins.owner();
        let terminal = proof.current_terminal();
        let quarantine = self.managed_quarantine_receipts.get(&worker_id)
            .ok_or(WorkerDurableError::Conflict("managed terminal quarantine receipt is unavailable"))?;
        let current_worktree_receipt = proof.current_worktree_receipt();
        let pool_worker = self.pool.as_ref().and_then(|pool| pool.worker(&worker_id))
            .ok_or(WorkerDurableError::NotFound("reconciliation worker lease missing"))?;
        if quarantine != proof.quarantine()
            || quarantine.attempt_id() != pins.attempt_id()
            || quarantine.reservation_id() != claim.reservation().budget_lease_id()
            || quarantine.worktree_lease_id() != claim.reservation().workspace_lease_id()
            || prior_owner.owner_epoch() != quarantine.owner_epoch()
            || current_owner.principal_ref() != prior_owner.principal_ref()
            || current_owner.workspace_binding() != prior_owner.workspace_binding()
            || current_owner.session_id() != prior_owner.session_id()
            || current_owner.run_id() != prior_owner.run_id()
            || current_owner.task_id() != prior_owner.task_id()
            || current_owner.attempt_id() != prior_owner.attempt_id()
            || current_owner.owner_epoch() < prior_owner.owner_epoch()
            || current_root.goal_id() != pins.goal_id()
            || current_root.run_id() != pins.run_id()
            || current_root.principal_ref() != pins.principal_ref()
            || current_root.workspace_binding() != pins.workspace_binding()
            || current_root.session_id() != managed_root_session_id(pins.parent_proof())?
            || current_root.location_id() != pins.location_id()
            || current_root.owner_epoch() != current_owner.owner_epoch()
            || current_root.accepted_spec_digest() != pins.accepted_spec_digest()
            || pool_worker.state != crate::resource_budget::ReservationState::Quarantined
            || pool_worker.process_identity.is_some()
            || terminal.task_revision() != pins.task_revision().parse::<u64>()
                .map_err(|_| WorkerDurableError::Conflict("pinned Task revision is invalid"))?
            || terminal.admission_workspace_revision() != Some(binding.child_workspace_revision()?)
            || terminal.binding_digest() != binding.binding_digest
            || terminal.binding_digest() != claim.binding_digest()
            || terminal.spec_digest() != pins.accepted_spec_digest()
            || terminal.goal_id() != pins.goal_id() || terminal.run_id() != pins.run_id()
            || terminal.task_id() != pins.task_id() || terminal.attempt_id() != pins.attempt_id()
            || terminal.attempt_state() != crate::managed_control::ManagedAttemptTerminalStateV1::Failed
            || terminal.task_state() != expected_task_state
            || terminal.child_prompt_state() != crate::managed_control::ManagedChildPromptStateV1::Quiesced
            || terminal.effect_chain_state() != crate::managed_control::ManagedAttemptEffectChainStateV1::AllSettled
            || terminal.effects().iter().any(|effect| effect.outcome().is_none()
                || effect.outcome() == Some(crate::managed_control::AttemptEffectOutcomeV1::Unknown))
            || root_owner.goal_id() != pins.goal_id() || root_owner.run_id() != pins.run_id()
            || root_owner.principal_ref() != pins.principal_ref()
            || root_owner.workspace_binding() != pins.workspace_binding()
            || root_owner.session_id() != managed_root_session_id(pins.parent_proof())?
            || root_owner.location_id() != pins.location_id()
            || root_owner.owner_epoch() != current_owner.owner_epoch()
            || root_owner.process_incarnation() != current_root.process_incarnation()
            || root_owner.accepted_spec_digest() != pins.accepted_spec_digest()
            || !valid_digest(proof.current_host_quiescence_digest(), "blake3:")
        {
            return Err(WorkerDurableError::Conflict(
                "reconciliation proof does not match the exact quarantined managed child",
            ));
        }
        self.validate_managed_reconciliation_worktree_receipt(
            current_worktree_receipt, pins, &root_owner,
        )?;
        let event = ManagedLogicalSettlementEventV1 {
            schema_version: 4,
            worker_execution_id: worker_id.clone(), attempt_id: pins.attempt_id().to_owned(),
            proof_digest: combined_proof_digest,
            observed_workspace_revision: Some(current_worktree_receipt.observed_workspace_revision().to_owned()),
            final_worktree_operation_id: Some(current_worktree_receipt.operation_id().to_owned()),
            final_worktree_host_receipt_ref: Some(current_worktree_receipt.host_receipt_ref().to_owned()),
            evidence_digest: terminal.evidence_digest().map(str::to_owned),
            evidence_refs: terminal.evidence_refs().to_vec(),
            verification_run_id: None,
            set_identity_digest: None,
            challenge_set_digest: None,
            reusable_worktree: false,
            reconciliation_owner_epoch: Some(current_owner.owner_epoch()),
            disposition_deferred: true,
        };
        let settlement_attempt_id = pins.attempt_id().to_owned();
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let delivery_id = format!("worker-managed-reconcile-{worker_id}");
        self.apply(revision, &delivery_id, WorkerCommand::ManagedLogicalSettled { event })?;
        self.ensure_managed_worktree_disposition(
            &worker_id, &settlement_attempt_id, Some(current_owner.owner_epoch()),
        )?;
        self.managed_settlement_receipts.get(&worker_id).cloned()
            .ok_or(WorkerDurableError::Invalid("reconciliation OwnerLog receipt was not materialized"))
    }

    fn claimed_worker_dispatch_proof(
        &self,
        worker_execution_id: &str,
    ) -> Result<ClaimedWorkerDispatchProofV1, WorkerDurableError> {
        let pins = self.identities.pre_admission_pins.get(worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("claimed worker pins unavailable"))?;
        let binding = self.identities.delegation_bindings.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("claimed worker binding unavailable"))?;
        let receipt = self.identities.claim_receipts.get(worker_execution_id)
            .ok_or(WorkerDurableError::Conflict("durable claim receipt is unavailable"))?;
        let (ticket_id, expected_worker_id, _) = pre_admission_request(pins)?;
        if expected_worker_id.as_str() != worker_execution_id || receipt.ticket_id != ticket_id
            || receipt.attempt_id != pins.attempt_id()
            || receipt.pins_digest != pins.pins_digest()
            || receipt.binding_digest != binding.binding_digest
            || receipt.owner_log_id != self.pool_id
            || receipt.worker_pool_revision == 0
            || receipt.owner_log_sequence.parse::<u64>().ok().is_none_or(|sequence| sequence == 0)
        {
            return Err(WorkerDurableError::Conflict("durable claim receipt differs from its immutable pin"));
        }
        validate_owner_digest(&receipt.owner_log_event_digest, "blake3:")?;
        let cursor = CursorV1 {
            owner_kind: OWNER_KIND.to_owned(),
            owner_id: receipt.owner_log_id.clone(),
            seq: receipt.owner_log_sequence.clone(),
            event_digest: receipt.owner_log_event_digest.clone(),
        };
        let reserved = self.reserved_worker_proof_at(
            pins, &ticket_id, worker_execution_id, Some(&binding.binding_digest),
            &cursor, receipt.worker_pool_revision,
        )?;
        Ok(ClaimedWorkerDispatchProofV1 { reserved })
    }

    /// Consume P1's exact managed OwnerLog/process reconciliation and release
    /// the lease only while P8 independently observes the same candidate still
    /// RESERVED, unclaimed and without an owned process.
    pub(crate) fn reconcile_pre_admission_reservation(
        &mut self,
        proof: &ManagedReservationReconciliationProofV1,
    ) -> Result<PreAdmissionReconciliationReceiptV1, WorkerDurableError> {
        proof.validate()?;
        if let Some(previous) = self.pre_admission_reconciliation_receipts
            .get(proof.worker_execution_id())
        {
            return if previous.reconciliation_proof_digest() == proof.proof_digest()
                && previous.attempt_id() == proof.attempt_id()
                && previous.ticket_id() == proof.ticket_id()
                && previous.pins_digest() == proof.pins_digest()
            {
                Ok(previous.clone())
            } else {
                Err(WorkerDurableError::Conflict(
                    "pre-admission candidate already has a different durable reconciliation",
                ))
            };
        }
        if proof.host_owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let pins = self.identities.pre_admission_pins.get(proof.worker_execution_id())
            .ok_or(WorkerDurableError::NotFound("pre-admission candidate not found"))?;
        let (_, expected_worker_id, _) = pre_admission_ids(pins);
        let (expected_ticket_id, _, _) = pre_admission_ids(pins);
        if expected_worker_id != proof.worker_execution_id()
            || expected_ticket_id != proof.ticket_id()
            || pins.attempt_id() != proof.attempt_id()
            || pins.pins_digest() != proof.pins_digest()
        {
            return Err(WorkerDurableError::Conflict("managed reconciliation proof names another candidate"));
        }
        let worker = self.pool.as_ref().and_then(|pool| pool.worker(proof.worker_execution_id()))
            .ok_or(WorkerDurableError::NotFound("pre-admission worker not found"))?;
        if worker.state != crate::resource_budget::ReservationState::Reserved
            || worker.process_identity.is_some() || worker.unknown_effect
        {
            return Err(WorkerDurableError::Conflict("pre-admission worker is claimed, uncertain or no longer RESERVED"));
        }
        let attached = self.identities.delegation_bindings.get(proof.worker_execution_id());
        match proof.disposition() {
            ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch if attached.is_none()
                && proof.attempt_digest().is_none() && proof.binding_digest().is_none() => {}
            ManagedReservationReconciliationDispositionV1::TerminalNoEffect
                if attached.is_some_and(|binding| Some(binding.binding_digest.as_str()) == proof.binding_digest()) => {}
            _ => return Err(WorkerDurableError::Conflict("managed reconciliation outcome does not match P8 binding state")),
        }
        let delivery_id = format!("worker-pre-admission-reconcile-{}", proof.proof_digest().trim_start_matches("blake3:"));
        let revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
        self.apply(revision, &delivery_id, WorkerCommand::PreAdmissionReconciled { proof: proof.clone() })?;
        self.pre_admission_reconciliation_receipts.get(proof.worker_execution_id())
            .cloned()
            .ok_or(WorkerDurableError::Invalid(
                "durable pre-admission reconciliation receipt was not materialized",
            ))
    }

    /// Recover a previously committed P8 tombstone after a lost response or
    /// owner restart. The caller still proves the matching managed candidate
    /// tombstone; this lookup grants no new release, renewal or dispatch right.
    pub(crate) fn resolve_pre_admission_reconciliation_receipt(
        &self,
        worker_execution_id: &str,
        attempt_id: &str,
        pins_digest: &str,
    ) -> Result<Option<PreAdmissionReconciliationReceiptV1>, WorkerDurableError> {
        validate_owner_token(worker_execution_id)?;
        validate_owner_token(attempt_id)?;
        validate_owner_digest(pins_digest, "blake3:")?;
        let Some(pins) = self.identities.pre_admission_pins.get(worker_execution_id) else {
            return Ok(None);
        };
        if pins.attempt_id() != attempt_id || pins.pins_digest() != pins_digest {
            return Err(WorkerDurableError::Conflict(
                "reconciliation lookup does not match durable candidate pins",
            ));
        }
        Ok(self.pre_admission_reconciliation_receipts.get(worker_execution_id).cloned())
    }

    /// Recovery lookup for P1 after the P8 tombstone append committed but its
    /// reply was lost. It is keyed by the candidate ID from managed state and
    /// returns only an already durable P8 EXPIRED receipt.
    pub(crate) fn resolve_pre_admission_reconciliation_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<(ManagedReadyTaskPinV1, PreAdmissionReconciliationReceiptV1)>, WorkerDurableError> {
        validate_owner_token(attempt_id)?;
        let mut matches = self.identities.pre_admission_pins.iter()
            .filter(|(_, pins)| pins.attempt_id() == attempt_id);
        let Some((worker_execution_id, pins)) = matches.next() else {
            return Ok(None);
        };
        if matches.next().is_some() {
            return Err(WorkerDurableError::Conflict(
                "candidate Attempt identity maps to multiple durable P8 pins",
            ));
        }
        let Some(receipt) = self.pre_admission_reconciliation_receipts.get(worker_execution_id) else {
            return Ok(None);
        };
        if receipt.attempt_id() != attempt_id || receipt.pins_digest() != pins.pins_digest()
            || receipt.worker_execution_id() != worker_execution_id
        {
            return Err(WorkerDurableError::ReplayConflict(
                "durable P8 reconciliation receipt differs from candidate pins",
            ));
        }
        if receipt.disposition() != ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch
            || receipt.terminal_state() != crate::resource_budget::ReservationState::Expired
        {
            return Err(WorkerDurableError::Conflict(
                "candidate generation renewal requires a NotAdmittedNoDispatch EXPIRED receipt",
            ));
        }
        Ok(Some((pins.clone(), receipt.clone())))
    }

    fn reserved_worker_proof(
        &self,
        pins: &TrustedPreAdmissionPinsV1,
        ticket_id: &str,
        worker_execution_id: &str,
        binding_digest: Option<&str>,
    ) -> Result<ReservedWorkerLeaseProofV1, WorkerDurableError> {
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid("worker cursor unavailable"))?;
        self.reserved_worker_proof_at(pins, ticket_id, worker_execution_id, binding_digest, cursor, pool.revision())
    }

    fn reserved_worker_proof_at(
        &self,
        pins: &TrustedPreAdmissionPinsV1,
        ticket_id: &str,
        worker_execution_id: &str,
        binding_digest: Option<&str>,
        cursor: &CursorV1,
        proof_pool_revision: u64,
    ) -> Result<ReservedWorkerLeaseProofV1, WorkerDurableError> {
        let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let worker = pool.worker(worker_execution_id).ok_or(WorkerDurableError::NotFound("worker lease unavailable"))?;
        let ticket = pool.ticket(ticket_id).ok_or(WorkerDurableError::NotFound("worker ticket unavailable"))?;
        let workspace_lease_id = worker.worktree_lease_id.clone()
            .ok_or(WorkerDurableError::Conflict("managed worker has no worktree lease"))?;
        let budget_lease_id = format!("worker-reservation-{worker_execution_id}");
        let resource_lease_ids = vec![workspace_lease_id.clone()];
        if ticket.state != crate::worker_pool::TicketState::Consumed
            || ticket.worker_execution_id.as_deref() != Some(worker_execution_id)
            || worker.owner != OwnerScopeKey::from_owner(pins.owner())
            || worker.goal_id != pins.goal_id
            || ticket.owner.attempt_id != pins.attempt_id()
            || !matches!(worker.state,
                crate::resource_budget::ReservationState::Reserved
                    | crate::resource_budget::ReservationState::Claimed)
            || worker.cancellation_requested || worker.unknown_effect
            || self.identities.pre_admission_pins.get(worker_execution_id) != Some(pins)
        {
            return Err(WorkerDurableError::Conflict("durable worker lease no longer matches READY Task pins"));
        }
        if let Some(expected) = binding_digest {
            if self.identities.delegation_bindings.get(worker_execution_id).map(|b| b.binding_digest.as_str()) != Some(expected) {
                return Err(WorkerDurableError::Conflict("worker delegation digest is not current"));
            }
        }
        Ok(ReservedWorkerLeaseProofV1 {
            attempt_id: pins.attempt_id().to_owned(), worker_execution_id: worker_execution_id.to_owned(),
            ticket_id: ticket_id.to_owned(), budget_lease_id, workspace_lease_id,
            resource_lease_ids, pins_digest: pins.pins_digest().to_owned(),
            context_selection_digest: pins.context_selection_digest.clone(),
            binding_digest: binding_digest.map(str::to_owned), owner_log_id: cursor.owner_id.clone(),
            owner_log_sequence: cursor.seq.clone(), owner_log_event_digest: cursor.event_digest.clone(),
            worker_pool_revision: proof_pool_revision,
        })
    }

    fn validate_managed_parent_pin(
        &self,
        pins: &TrustedPreAdmissionPinsV1,
        now_ms: u64,
    ) -> Result<(), WorkerDurableError> {
        let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid("worker cursor unavailable"))?;
        let revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
        match &pins.parent_proof {
            ManagedParentProofV1::RootCoordinator(proof) => {
                if proof.owner_log_id() != cursor.owner_id || proof.owner_log_sequence() != cursor.seq
                    || proof.owner_log_event_digest() != cursor.event_digest
                    || proof.worker_pool_revision() != revision || proof.expires_at_ms() <= now_ms
                    || proof.owner_epoch() != self.resumed_epoch || proof.goal_id() != pins.goal_id
                    || proof.run_id() != pins.run_id() || proof.principal_ref() != pins.principal_ref()
                    || proof.workspace_binding() != pins.workspace_binding()
                    || proof.location_id() != pins.location_id || proof.process_incarnation() != pins.process_incarnation
                    || proof.accepted_spec_digest() != pins.accepted_spec_digest
                {
                    return Err(WorkerDurableError::Conflict("root coordinator proof is stale or outside child scope"));
                }
            }
            ManagedParentProofV1::ClaimedWorker(_) => {
                return Err(WorkerDurableError::Conflict(
                    "nested managed admission requires durable authenticated Run root Session lineage",
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn worktree_release_is_safe(&self, operation_id: &str) -> bool {
        self.worktree_operations.is_release_safe(operation_id)
    }

    /// Durably retain immutable admission pins before managed DelegationBinding
    /// minting. The reservation must already exist and must be unclaimed.
    pub(crate) fn persist_admission_pins(
        &mut self,
        delivery_id: &str,
        worker_execution_id: &str,
        pins: WorkerAdmissionPinsV1,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<(), WorkerDurableError> {
        pins.validate()?;
        let lease = self.resolve_managed_lease_proof(worker_execution_id, binding, owner, now_ms)?;
        if lease.worker_state() != crate::resource_budget::ReservationState::Reserved
            || pins.owner != OwnerScopeKey::from_owner(owner)
            || pins.goal_id != lease.goal_id()
            || pins.source_revision != lease.source_revision()
            || pins.accepted_spec_digest != lease.accepted_spec_digest()
        {
            return Err(WorkerDurableError::Conflict("admission pins do not match reserved worker"));
        }
        self.apply(lease.worker_pool_revision(), delivery_id, WorkerCommand::AdmissionPinsRecorded {
            worker_execution_id: worker_execution_id.to_owned(), pins,
        })
    }

    /// Resolve the unique reserved/claimed worker for authenticated owner facts.
    /// Worker IDs supplied by RPC are deliberately absent from this API.
    pub(crate) fn resolve_authenticated_managed_lease_proof(
        &self,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        location_id: &str,
        process_incarnation: &str,
        now_ms: u64,
    ) -> Result<DurableManagedLeaseProofV1, WorkerDurableError> {
        let mut candidates = self.identities.admission_pins.iter().filter(|(_, pins)| {
            pins.owner.matches_owner(owner) && pins.goal_id == binding.goal_id()
        });
        let (worker_execution_id, pins) = candidates.next().ok_or(
            WorkerDurableError::NotFound("authenticated worker admission pins unavailable"),
        )?;
        if candidates.next().is_some() || pins.location_id != location_id
            || pins.process_incarnation != process_incarnation
            || pins.source_revision != binding.source_revision()
            || pins.accepted_spec_digest != binding.accepted_spec_digest()
        {
            return Err(WorkerDurableError::Conflict("ambiguous or stale authenticated worker pins"));
        }
        self.resolve_managed_lease_proof(worker_execution_id, binding, owner, now_ms)
    }

    /// Attach only the canonical managed-owner binding after admission has
    /// durably minted it. No dispatch may precede this exact one-way binding.
    pub(crate) fn bind_managed_delegation(
        &mut self,
        delivery_id: &str,
        delegation: &crate::protocol::DelegationBindingV1,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        location_id: &str,
        process_incarnation: &str,
        now_ms: u64,
    ) -> Result<(), WorkerDurableError> {
        let lease = self.resolve_authenticated_managed_lease_proof(
            binding, owner, location_id, process_incarnation, now_ms,
        )?;
        if crate::protocol::DelegationBindingV1::from_value(&delegation.to_value()).as_ref() != Some(delegation)
            || lease.worker_state() != crate::resource_budget::ReservationState::Reserved
            || delegation.run_id != lease.run_id()
            || delegation.task_id != lease.task_id()
            || delegation.attempt_id != lease.attempt_id()
            || delegation.child_execution_id != lease.worker_execution_id()
            || delegation.owner_epoch != lease.owner_epoch()
            || delegation.accepted_spec_digest != lease.accepted_spec_digest()
            || delegation.source_revision != lease.source_revision()
            || delegation.workspace_lease_id != lease.workspace_lease_id()
            || delegation.budget_lease_id != lease.budget_lease_id()
            || delegation.resource_lease_ids != lease.resource_lease_ids()
            || Some(delegation.profile_id.as_str()) != lease.profile_id()
            || Some(delegation.profile_revision) != lease.profile_revision()
            || Some(delegation.profile_digest.as_str()) != lease.profile_digest()
            || Some(delegation.context_selection_digest.as_str()) != lease.context_selection_digest()
            || Some(delegation.capability_ceiling_digest.as_str()) != lease.capability_ceiling_digest()
        {
            return Err(WorkerDurableError::Conflict("managed delegation does not match immutable worker pins"));
        }
        let binding_digest = delegation.digest()
            .map_err(|_| WorkerDurableError::Invalid("delegation digest failed"))?;
        self.apply(lease.worker_pool_revision(), delivery_id, WorkerCommand::DelegationBound {
            worker_execution_id: lease.worker_execution_id().to_owned(),
            binding: BoundWorkerDelegationV1 {
                binding_digest,
                parent_execution_id: delegation.parent_execution_id.clone(),
                worktree_admission: None,
            },
        })
    }

    /// Register a logical root parent using authenticated ServerAuth and a
    /// P1-observed OS peer generation. A guessed PID or caller-supplied frame
    /// incarnation is never sufficient; P1 owns that observation boundary.
    /// Existing live records are not renewed implicitly and consume no separate
    /// worker slot or memory/process reservation.
    pub(crate) fn register_root_coordinator(
        &mut self,
        delivery_id: &str,
        principal: &crate::protocol::AuthenticatedPrincipalV1,
        pins: &WorkerAdmissionPinsV1,
        observed_process: &ProcessIdentity,
        now_ms: u64,
        expires_at_ms: u64,
    ) -> Result<RootCoordinatorExecutionProofV1, WorkerDurableError> {
        pins.validate()?;
        let expected_principal = match principal {
            crate::protocol::AuthenticatedPrincipalV1::ServerAuth { subject }
                if !subject.is_empty() && subject.len() <= 256 && !subject.chars().any(char::is_control) => format!("server_auth:{subject}"),
            _ => return Err(WorkerDurableError::Conflict("root coordinator requires authenticated ServerAuth")),
        };
        if pins.owner.principal_ref != expected_principal
            || pins.owner.owner_epoch != self.resumed_epoch
            || observed_process.pid == 0 || observed_process.start_identity == 0
            || expires_at_ms <= now_ms || expires_at_ms - now_ms > 86_400_000
        {
            return Err(WorkerDurableError::Conflict("root coordinator authenticated process scope unavailable"));
        }
        let execution = root_execution_from_pins(pins, observed_process, expires_at_ms);
        if !self.identities.root_coordinators.contains_key(&execution.worker_execution_id) {
            let revision = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.revision();
            self.apply(revision, delivery_id, WorkerCommand::RootCoordinatorRegistered { execution })?;
        }
        self.resolve_root_coordinator_proof(pins, observed_process, now_ms)
    }

    /// Registers the authenticated existing Core Session/Run as logical root
    /// lineage. P1 supplies a crate-private projection minted only from the
    /// verified local peer credentials and observed PID/start generation.
    pub(crate) fn register_authenticated_root_coordinator(
        &mut self,
        delivery_id: &str,
        pins: &RootCoordinatorRegistrationPinsV1,
        now_ms: u64,
        expires_at_ms: u64,
    ) -> Result<RootCoordinatorExecutionProofV1, WorkerDurableError> {
        pins.validate()?;
        if pins.owner_epoch() != self.resumed_epoch || expires_at_ms <= now_ms
            || expires_at_ms - now_ms > crate::worker_pool::MAX_WORKER_LEASE_MS
        {
            return Err(WorkerDurableError::Conflict("root coordinator pin epoch or expiry is invalid"));
        }
        let execution = root_execution_from_registration_pins(pins, expires_at_ms);
        if let Some(existing) = self.identities.root_coordinators.get(&execution.worker_execution_id) {
            if existing != &execution {
                return Err(WorkerDurableError::Conflict("root coordinator identity is already bound"));
            }
        } else {
            let revision = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.revision();
            self.apply(revision, delivery_id, WorkerCommand::RootCoordinatorRegistered { execution })?;
        }
        self.resolve_authenticated_root_coordinator_proof(pins, now_ms)
    }

    pub(crate) fn resolve_authenticated_root_coordinator_proof(
        &self,
        pins: &RootCoordinatorRegistrationPinsV1,
        now_ms: u64,
    ) -> Result<RootCoordinatorExecutionProofV1, WorkerDurableError> {
        pins.validate()?;
        if pins.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let expected = root_execution_from_registration_pins(pins, 0);
        let execution = self.identities.root_coordinators.get(&expected.worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("durable root coordinator unavailable"))?;
        if execution.worker_execution_id != expected.worker_execution_id
            || execution.goal_id != expected.goal_id || execution.run_id != expected.run_id
            || execution.principal_ref != expected.principal_ref
            || execution.workspace_binding != expected.workspace_binding
            || execution.session_id != expected.session_id || execution.location_id != expected.location_id
            || execution.owner_epoch != expected.owner_epoch
            || execution.process_incarnation != expected.process_incarnation
            || execution.process_identity != expected.process_identity
            || execution.source_revision != expected.source_revision
            || execution.accepted_spec_digest != expected.accepted_spec_digest
            || execution.expires_at_ms <= now_ms
        {
            return Err(WorkerDurableError::Conflict("root coordinator identity, process generation or expiry is stale"));
        }
        let (owner_log_id, owner_log_sequence, owner_log_event_digest, worker_pool_revision) = self.owner_log_watermark()?;
        Ok(RootCoordinatorExecutionProofV1 {
            execution: execution.clone(), owner_log_id, owner_log_sequence,
            owner_log_event_digest, worker_pool_revision,
        })
    }

    /// Rotate only the authenticated Core owner of one already-quarantined
    /// logical child. The durable root ID and immutable Run lineage are kept;
    /// this method returns a capability accepted only by reconciliation APIs.
    pub(crate) fn reauthorize_quarantined_root_coordinator(
        &mut self,
        delivery_id: &str,
        quarantine: &WorkerManagedQuarantineReceiptV1,
        current_owner: &AuthenticatedOwnerContext,
        current_terminal: &crate::managed_control::ManagedAttemptTerminalSnapshotV1,
        pins: &RootCoordinatorRegistrationPinsV1,
        now_ms: u64,
        expires_at_ms: u64,
    ) -> Result<ReadOnlyReconciliationRootProofV1, WorkerDurableError> {
        pins.validate()?;
        if current_owner.owner_epoch() != self.resumed_epoch
            || pins.owner_epoch() != self.resumed_epoch
            || pins.owner_epoch() <= quarantine.owner_epoch()
            || expires_at_ms <= now_ms
            || expires_at_ms - now_ms > crate::worker_pool::MAX_WORKER_LEASE_MS
        {
            return Err(WorkerDurableError::Conflict("read-only root reauthorization epoch or expiry is invalid"));
        }
        let durable_quarantine = self.resolve_managed_quarantine_for_attempt(quarantine.attempt_id())?
            .ok_or(WorkerDurableError::NotFound("durable managed quarantine unavailable"))?;
        self.validate_quarantined_terminal_snapshot(quarantine, current_owner, current_terminal)?;
        let worker_id = quarantine.worker_execution_id();
        let worker_pins = self.identities.pre_admission_pins.get(worker_id)
            .ok_or(WorkerDurableError::NotFound("quarantined worker pins unavailable"))?;
        let historical_root_session = managed_root_session_id(worker_pins.parent_proof())?;
        let (worker_state, worker_has_process) = {
            let pool = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
            let worker = pool.worker(worker_id).ok_or(WorkerDurableError::NotFound("quarantined worker unavailable"))?;
            (worker.state, worker.process_identity.is_some())
        };
        if quarantine != &durable_quarantine
            || quarantine.goal_id() != worker_pins.goal_id()
            || quarantine.run_id() != worker_pins.run_id()
            || quarantine.task_id() != worker_pins.task_id()
            || quarantine.attempt_id() != worker_pins.attempt_id()
            || quarantine.owner_epoch() != worker_pins.owner_epoch()
            || current_owner.principal_ref() != worker_pins.principal_ref()
            || current_owner.workspace_binding() != worker_pins.workspace_binding()
            || current_owner.session_id() != worker_pins.session_id()
            || current_owner.run_id() != worker_pins.run_id()
            || current_owner.task_id() != worker_pins.task_id()
            || current_owner.attempt_id() != worker_pins.attempt_id()
            || current_owner.owner_epoch() <= quarantine.owner_epoch()
            || pins.goal_id() != worker_pins.goal_id()
            || pins.run_id() != worker_pins.run_id()
            || pins.principal_ref() != worker_pins.principal_ref()
            || pins.workspace_binding() != worker_pins.workspace_binding()
            || pins.location_id() != worker_pins.location_id()
            || pins.accepted_spec_digest() != worker_pins.accepted_spec_digest()
            || pins.process_incarnation() == worker_pins.process_incarnation()
            || worker_state != crate::resource_budget::ReservationState::Quarantined
            || worker_has_process
        {
            return Err(WorkerDurableError::Conflict("reauthorization does not match the exact quarantined Run and fresh authenticated Core owner"));
        }

        let mapped_root = self.identities.reconciliation_root_ids.get(quarantine.attempt_id());
        if mapped_root.is_some_and(|(_, digest)| digest != quarantine.receipt_digest()) {
            return Err(WorkerDurableError::Conflict("quarantine receipt changed after root reauthorization"));
        }
        let prior = if let Some((root_id, _)) = mapped_root {
            self.identities.root_coordinators.get(root_id)
                .ok_or(WorkerDurableError::ReplayConflict("reauthorized root mapping is dangling"))?.clone()
        } else {
            let mut matching_roots = self.identities.root_coordinators.values().filter(|root| {
                root.goal_id == quarantine.goal_id()
                    && root.run_id == quarantine.run_id()
                    && root.principal_ref == worker_pins.principal_ref()
                    && root.workspace_binding == worker_pins.workspace_binding()
                    && root.session_id == historical_root_session
                    && root.location_id == worker_pins.location_id()
                    && root.owner_epoch == quarantine.owner_epoch()
                    && root.process_incarnation == worker_pins.process_incarnation()
                    && root.accepted_spec_digest == worker_pins.accepted_spec_digest()
            });
            let prior = matching_roots.next().cloned()
                .ok_or(WorkerDurableError::NotFound("historical authenticated root coordinator unavailable"))?;
            if matching_roots.next().is_some() {
                return Err(WorkerDurableError::Conflict("quarantined Attempt maps to ambiguous historical root coordinators"));
            }
            prior
        };
        if pins.session_id() != prior.session_id
            || prior.session_id != historical_root_session
            || current_terminal.child_prompt_quiescence().is_none_or(|receipt|
                receipt.proof().parent_session_id() != prior.session_id
                    || receipt.proof().session_id() != worker_pins.session_id())
        {
            return Err(WorkerDurableError::Conflict(
                "reauthorized root or child quiescence Session differs from historical lineage",
            ));
        }
        let execution = RootCoordinatorExecutionV1 {
            worker_execution_id: prior.worker_execution_id.clone(),
            goal_id: pins.goal_id().to_owned(), run_id: pins.run_id().to_owned(),
            principal_ref: pins.principal_ref().to_owned(), workspace_binding: pins.workspace_binding().to_owned(),
            session_id: pins.session_id().to_owned(), location_id: pins.location_id().to_owned(),
            owner_epoch: pins.owner_epoch(), process_incarnation: pins.process_incarnation().to_owned(),
            process_identity: pins.process_identity().clone(), source_revision: prior.source_revision.clone(),
            accepted_spec_digest: pins.accepted_spec_digest().to_owned(), expires_at_ms,
        };
        validate_root_execution(&execution)?;
        let already_current = self.identities.root_coordinators.get(&prior.worker_execution_id)
            .is_some_and(|existing| existing.goal_id == execution.goal_id
                && existing.run_id == execution.run_id
                && existing.principal_ref == execution.principal_ref
                && existing.workspace_binding == execution.workspace_binding
                && existing.session_id == execution.session_id
                && existing.location_id == execution.location_id
                && existing.owner_epoch == execution.owner_epoch
                && existing.process_incarnation == execution.process_incarnation
                && existing.process_identity == execution.process_identity
                && existing.source_revision == execution.source_revision
                && existing.accepted_spec_digest == execution.accepted_spec_digest
                && existing.expires_at_ms > now_ms);
        let effective_execution = if already_current {
            self.identities.root_coordinators.get(&prior.worker_execution_id).expect("checked root").clone()
        } else {
            let revision = self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.revision();
            self.apply(revision, delivery_id, WorkerCommand::RootCoordinatorReauthorized {
                attempt_id: quarantine.attempt_id().to_owned(),
                quarantine_receipt_digest: quarantine.receipt_digest().to_owned(),
                prior_execution_digest: root_execution_digest(&prior), execution: execution.clone(),
            })?;
            execution
        };
        self.resolve_read_only_reconciliation_root_proof(&effective_execution, now_ms)
    }

    fn resolve_read_only_reconciliation_root_proof(
        &self,
        execution: &RootCoordinatorExecutionV1,
        now_ms: u64,
    ) -> Result<ReadOnlyReconciliationRootProofV1, WorkerDurableError> {
        let current = self.identities.root_coordinators.get(&execution.worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("reauthorized root coordinator unavailable"))?;
        if current != execution || current.owner_epoch != self.resumed_epoch || current.expires_at_ms <= now_ms {
            return Err(WorkerDurableError::Conflict("read-only reconciliation root proof is stale"));
        }
        let (owner_log_id, owner_log_sequence, owner_log_event_digest, worker_pool_revision) = self.owner_log_watermark()?;
        Ok(ReadOnlyReconciliationRootProofV1 {
            execution: current.clone(), owner_log_id, owner_log_sequence,
            owner_log_event_digest, worker_pool_revision,
        })
    }

    pub(crate) fn resolve_root_coordinator_proof(
        &self,
        pins: &WorkerAdmissionPinsV1,
        observed_process: &ProcessIdentity,
        now_ms: u64,
    ) -> Result<RootCoordinatorExecutionProofV1, WorkerDurableError> {
        let candidate = root_execution_from_pins(pins, observed_process, 0);
        let execution = self.identities.root_coordinators.get(&candidate.worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("durable root coordinator unavailable"))?;
        let mut expected = candidate;
        expected.expires_at_ms = execution.expires_at_ms;
        // The root attachment spans the Run. Its original source revision is
        // provenance, while each child reservation carries its own immutable
        // current workspace revision and P1 re-observes that revision.
        expected.source_revision = execution.source_revision.clone();
        if execution != &expected || execution.owner_epoch != self.resumed_epoch
            || execution.expires_at_ms <= now_ms
        {
            return Err(WorkerDurableError::Conflict("root coordinator scope, process generation or expiry is stale"));
        }
        let (owner_log_id, owner_log_sequence, owner_log_event_digest, worker_pool_revision) = self.owner_log_watermark()?;
        Ok(RootCoordinatorExecutionProofV1 {
            execution: execution.clone(), owner_log_id, owner_log_sequence,
            owner_log_event_digest, worker_pool_revision,
        })
    }

    /// Re-resolve after every durable pool mutation, immediately before P1's
    /// atomic managed admission. Time, owner epoch and exact cursor are fenced.
    pub(crate) fn validate_root_coordinator_proof(
        &self,
        proof: &RootCoordinatorExecutionProofV1,
        pins: &WorkerAdmissionPinsV1,
        observed_process: &ProcessIdentity,
        now_ms: u64,
    ) -> Result<(), WorkerDurableError> {
        if &self.resolve_root_coordinator_proof(pins, observed_process, now_ms)? == proof {
            Ok(())
        } else {
            Err(WorkerDurableError::Conflict("root coordinator proof is stale"))
        }
    }

    /// Claim only a worker whose exact managed binding was durably attached.
    /// P1 still checks Guard, the one-use effect lease and confinement itself.
    pub(crate) fn claim_bound_managed_worker(
        &mut self,
        delivery_id: &str,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        location_id: &str,
        process_incarnation: &str,
        delegation_binding_digest: &str,
        now_ms: u64,
    ) -> Result<(), WorkerDurableError> {
        let proof = self.resolve_authenticated_managed_lease_proof(
            binding, owner, location_id, process_incarnation, now_ms,
        )?;
        if proof.delegation_binding_digest() != Some(delegation_binding_digest) {
            return Err(WorkerDurableError::Conflict("worker has no matching durable delegation binding"));
        }
        self.apply(proof.worker_pool_revision(), delivery_id, WorkerCommand::ClaimWorker {
            scope: OwnerScopeKey::from_owner(owner),
            worker_execution_id: proof.worker_execution_id().to_owned(),
        })
    }

    /// Dispatch only after durable claim and exact delegation attachment. The
    /// injected port belongs to P1's existing Guard/ExecutionHost supervisor;
    /// this adapter creates no process runtime and performs no host spawn itself.
    /// A possibly launched worker is never retried and capacity remains held.
    pub(crate) fn dispatch_bound_managed_worker(
        &mut self,
        delivery_id: &str,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        location_id: &str,
        process_incarnation: &str,
        delegation_binding_digest: &str,
        now_ms: u64,
        launcher: &mut dyn crate::worker_pool::IsolatedWorkerLauncher,
    ) -> Result<ProcessIdentity, WorkerDurableError> {
        // V1 managed WorkerExecution is a logical Core Session/Attempt and may
        // never start a worker-specific process. Keep the generic process-backed
        // pool primitives for a separately approved future mode, but make this
        // managed entry point incapable of crossing the P1 ExecutionHost port.
        // Otherwise a future call-site could accidentally fork a second model
        // runtime despite the logical-child contract.
        let _ = (delivery_id, binding, owner, location_id, process_incarnation,
            delegation_binding_digest, now_ms, launcher);
        Err(WorkerDurableError::Pool(WorkerPoolError::WrongWorkerClass))
    }

    /// Resolve a previously appended intent for one guarded HostKernel call.
    /// UNKNOWN/quarantined/completed operations are never redispatched.
    pub(crate) fn worktree_operation_pin_for_dispatch(
        &self,
        operation_id: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<WorktreeLifecycleOperationPinV1, WorkerDurableError> {
        let intent = self.worktree_operations.dispatchable_intent(operation_id)
            .ok_or(WorkerDurableError::Conflict("worktree operation is not durably pending"))?.clone();
        let live_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        if &live_owner != intent.owner() {
            return Err(WorkerDurableError::Conflict("worktree root proof differs from pending operation"));
        }
        Ok(WorktreeLifecycleOperationPinV1::from_durable_intent(intent))
    }

    /// Resolve the exact pending operation for Guard descriptor construction.
    /// This is read-only and grants no possible-dispatch authority.
    pub(crate) fn resolve_pending_worktree_intent(
        &self,
        operation_id: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<GuardedWorktreeRequestV1, WorkerDurableError> {
        let pin = self.worktree_operation_pin_for_dispatch(operation_id, root_proof, now_ms)?;
        Ok(GuardedWorktreeRequestV1::from_durable_intent(pin.intent().clone()))
    }

    /// Distinguishes a genuinely absent operation from every durable state for
    /// same-request Inspect recovery. `None` is returned only when the
    /// authenticated root scope is current and the exact operation ID has no
    /// OwnerLog intent. A present Pending intent returns its request; all
    /// post-fence, terminal, quarantined, retired, or stale states have typed
    /// errors so callers cannot mistake recovery failure for permission to
    /// create or dispatch a replacement operation.
    pub(crate) fn resolve_pending_worktree_intent_if_present(
        &self,
        operation_id: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<Option<GuardedWorktreeRequestV1>, WorkerDurableError> {
        self.resolve_pending_worktree_operation_pin_if_present(operation_id, root_proof, now_ms)
            .map(|pin| pin.map(|pin| GuardedWorktreeRequestV1::from_durable_intent(pin.intent().clone())))
    }

    /// Pin-preserving form for HostKernel's Guard → durable dispatch-start
    /// sequence. The returned value is the exact persisted pin that
    /// `mark_worktree_dispatch_started_and_get_request` must revalidate before
    /// writing the possible-dispatch fence.
    pub(crate) fn resolve_pending_worktree_operation_pin_if_present(
        &self,
        operation_id: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<Option<WorktreeLifecycleOperationPinV1>, WorkerDurableError> {
        // Authenticate and re-resolve the root before revealing whether an
        // operation ID exists in this owner stream.
        let live_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let Some(record) = self.worktree_operations.get(operation_id) else {
            return Ok(None);
        };
        if record.intent().owner() != &live_owner {
            return Err(WorkerDurableError::WorktreeIntentStale);
        }
        match record.state() {
            WorktreeOperationStateV1::Pending => Ok(Some(
                WorktreeLifecycleOperationPinV1::from_durable_intent(record.intent().clone()),
            )),
            WorktreeOperationStateV1::Unknown => Err(WorkerDurableError::WorktreeIntentUnknown),
            WorktreeOperationStateV1::Quarantined => {
                Err(WorkerDurableError::WorktreeIntentQuarantined)
            }
            WorktreeOperationStateV1::Completed => {
                Err(WorkerDurableError::WorktreeIntentCompleted)
            }
            WorktreeOperationStateV1::RetiredNoDispatch => {
                Err(WorkerDurableError::WorktreeIntentRetired)
            }
        }
    }

    /// Persist the possible-dispatch fence only after P1 has evaluated Guard,
    /// completed any required approval and durably issued the one-use lease.
    pub(crate) fn mark_worktree_dispatch_started_and_get_request(
        &mut self,
        pin: &WorktreeLifecycleOperationPinV1,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<GuardedWorktreeRequestV1, WorkerDurableError> {
        let operation_id = pin.operation_id();
        let current = self.worktree_operation_pin_for_dispatch(operation_id, root_proof, now_ms)?;
        if current != *pin {
            return Err(WorkerDurableError::Conflict(
                "worktree dispatch pin differs from the exact pending durable intent",
            ));
        }
        let intent = pin.intent().clone();
        let revision = self.pool.as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.revision();
        // Persist possible-dispatch before exposing the request to the only
        // executor. An exact retry must not obtain a second executable request.
        self.apply(revision, &format!("worktree-dispatch-{operation_id}"),
            WorkerCommand::WorktreeOperationDispatchStarted {
                operation_id: operation_id.to_owned(),
            })?;
        Ok(GuardedWorktreeRequestV1::from_durable_intent(intent))
    }

    /// Persist an operation intent before P1 performs any filesystem effect.
    pub(crate) fn persist_worktree_intent(
        &mut self,
        delivery_id: &str,
        intent: WorktreeOperationIntentV1,
    ) -> Result<(), WorkerDurableError> {
        if intent.owner_epoch() != self.resumed_epoch
            || !self.identities.root_coordinators.get(intent.owner().coordinator_id())
                .is_some_and(|root| worktree_root_owner_matches_execution(intent.owner(), root))
        {
            return Err(WorkerDurableError::Conflict("worktree intent root proof is stale"));
        }
        let revision = self
            .pool
            .as_ref()
            .map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        self.apply(
            revision,
            delivery_id,
            WorkerCommand::WorktreeOperationIntent { intent },
        )
    }

    /// Persist only a receipt minted from the P1 guarded HostKernel port.
    pub(crate) fn persist_worktree_receipt(
        &mut self,
        delivery_id: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
        receipt: GuardedWorktreeReceiptV1,
    ) -> Result<(), WorkerDurableError> {
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        let intent = self.worktree_operations.get(receipt.operation_id()).ok_or(
            WorkerDurableError::NotFound("worktree receipt intent missing"),
        )?.intent();
        if intent.owner() != &root_owner {
            return Err(WorkerDurableError::Conflict("worktree receipt root proof differs from intent"));
        }
        let revision = self
            .pool
            .as_ref()
            .map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        self.apply(
            revision,
            delivery_id,
            WorkerCommand::WorktreeOperationReceipt { receipt },
        )
    }

    /// Test-only mutable handle for state-machine negatives (cancel/reserve
    /// denials). Production callers must use [`Self::apply`] so the OwnerLog
    /// append wins before any state change.
    #[cfg(test)]
    pub fn pool_mut(&mut self) -> Option<&mut WorkerPool> {
        self.pool.as_mut()
    }

    /// Opens the effectful fan-out gate for this incarnation. Must be called by
    /// the authenticated host ingress that verifies the managed single-Attempt
    /// binding (C15 `managed.v1`) after the P2 gates pass; it is intentionally
    /// not durable so a restart requires explicit re-authorization.
    #[allow(dead_code)]
    pub(crate) fn enable_managed_attempt_fan_out(&mut self) -> Result<(), WorkerDurableError> {
        let pool = self
            .pool
            .as_mut()
            .ok_or(WorkerDurableError::Invalid("worker pool was not opened"))?;
        pool.enable_managed_attempt_fan_out(self.resumed_epoch)?;
        Ok(())
    }

    pub fn fan_out_state(&self) -> FanOutState {
        self.pool
            .as_ref()
            .map(|pool| pool.fan_out_state())
            .unwrap_or(FanOutState::Closed)
    }

    /// Resolves a managed Attempt's budget and workspace leases from the live
    /// replayed OwnerLog-backed worker pool. The authenticated caller supplies
    /// typed owner/binding proofs; raw identifiers, stale revisions, expired,
    /// cancelled, quarantined and unknown workers fail closed.
    pub(crate) fn resolve_managed_lease_proof(
        &self,
        worker_execution_id: &str,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<DurableManagedLeaseProofV1, WorkerDurableError> {
        if owner.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
            "worker OwnerLog cursor is unavailable",
        ))?;
        if cursor.owner_kind != OWNER_KIND
            || cursor.owner_id != self.pool_id
            || cursor.seq == "0"
            || cursor.event_digest.is_empty()
        {
            return Err(WorkerDurableError::Invalid(
                "worker OwnerLog is not durably opened",
            ));
        }
        let pool = self
            .pool
            .as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        let facts =
            pool.resolve_durable_worker_lease_facts(worker_execution_id, binding, owner, now_ms)?;
        Ok(DurableManagedLeaseProofV1 {
            facts,
            purpose: if self.identities.pre_admission_pins.contains_key(worker_execution_id) {
                if self.identities.delegation_bindings.contains_key(worker_execution_id) {
                    DurableManagedLeaseProofPurposeV1::AttachedAttempt
                } else {
                    DurableManagedLeaseProofPurposeV1::PreAdmissionReserved
                }
            } else {
                DurableManagedLeaseProofPurposeV1::LegacyAdmitted
            },
            pre_admission_pins: self.identities.pre_admission_pins.get(worker_execution_id).cloned(),
            admission_pins: self.identities.admission_pins.get(worker_execution_id).cloned(),
            delegation: self.identities.delegation_bindings.get(worker_execution_id).cloned(),
            owner_log_id: cursor.owner_id.clone(),
            worker_pool_revision: pool.revision(),
            owner_log_sequence: cursor.seq.clone(),
            owner_log_event_digest: cursor.event_digest.clone(),
        })
    }

    /// Re-resolves a previously issued proof from the current in-memory state
    /// reconstructed from the canonical worker OwnerLog and requires every
    /// lease fact, pool revision and log cursor to match. Call immediately
    /// before P2 composes the managed effect binding; any intervening pool
    /// mutation invalidates the older proof. P1 must still independently
    /// re-resolve filesystem currentness, authenticated principal, live
    /// Attempt and Guard scope in HostKernel.
    pub(crate) fn validate_managed_lease_proof(
        &self,
        proof: &DurableManagedLeaseProofV1,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<(), WorkerDurableError> {
        let current =
            self.resolve_managed_lease_proof(proof.worker_execution_id(), binding, owner, now_ms)?;
        if &current == proof {
            Ok(())
        } else {
            Err(WorkerDurableError::Conflict(
                "managed worker lease proof is stale",
            ))
        }
    }

    /// Resolve the active parent execution from trusted HostKernel-derived
    /// parent Attempt facts. A worker ID from request JSON is never sufficient:
    /// the identity must match the current replayed OwnerLog worker, active
    /// process generation and exact parent Attempt binding.
    pub(crate) fn resolve_active_parent_execution_proof(
        &self,
        parent_worker_execution_id: &str,
        parent_binding: &VerifiedAttemptBinding,
        parent_owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<DurableParentExecutionProofV1, WorkerDurableError> {
        if parent_owner.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
            "worker OwnerLog cursor is unavailable",
        ))?;
        if cursor.owner_kind != OWNER_KIND
            || cursor.owner_id != self.pool_id
            || cursor.seq == "0"
            || cursor.event_digest.is_empty()
        {
            return Err(WorkerDurableError::Invalid(
                "worker OwnerLog is not durably opened",
            ));
        }
        let pool = self
            .pool
            .as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        let facts = pool.resolve_active_parent_execution_facts(
            parent_worker_execution_id,
            parent_binding,
            parent_owner,
            now_ms,
        )?;
        Ok(DurableParentExecutionProofV1 {
            worker_execution_id: facts.worker_execution_id().to_owned(),
            goal_id: facts.goal_id().to_owned(),
            owner: facts.owner().clone(),
            source_revision: facts.source_revision().to_owned(),
            accepted_spec_digest: facts.accepted_spec_digest().to_owned(),
            process_identity: facts.process_identity().clone(),
            owner_log_id: cursor.owner_id.clone(),
            worker_pool_revision: pool.revision(),
            owner_log_sequence: cursor.seq.clone(),
            owner_log_event_digest: cursor.event_digest.clone(),
        })
    }

    pub(crate) fn validate_active_parent_execution_proof(
        &self,
        proof: &DurableParentExecutionProofV1,
        parent_binding: &VerifiedAttemptBinding,
        parent_owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<(), WorkerDurableError> {
        let current = self.resolve_active_parent_execution_proof(
            proof.worker_execution_id(),
            parent_binding,
            parent_owner,
            now_ms,
        )?;
        if &current == proof {
            Ok(())
        } else {
            Err(WorkerDurableError::Conflict(
                "parent execution proof is stale",
            ))
        }
    }

    /// Returns only PID/start generations already persisted against active or
    /// quarantined P8 worker leases, with the exact OwnerLog watermark used to
    /// derive the set. No process may be selected by caller PID or command-line.
    pub(crate) fn durable_owned_process_leases(
        &self,
    ) -> Result<crate::resource_sampler::DurableOwnedProcessLeaseSetV1, WorkerDurableError> {
        let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
            "worker OwnerLog cursor is unavailable",
        ))?;
        if cursor.owner_kind != OWNER_KIND
            || cursor.owner_id != self.pool_id
            || cursor.seq == "0"
            || cursor.event_digest.is_empty()
        {
            return Err(WorkerDurableError::Invalid(
                "worker OwnerLog is not durably opened",
            ));
        }
        let pool = self
            .pool
            .as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        let leases = pool.durable_process_lease_facts()?;
        crate::resource_sampler::DurableOwnedProcessLeaseSetV1::from_durable_owner(
            cursor.owner_id.clone(),
            cursor.seq.clone(),
            cursor.event_digest.clone(),
            pool.revision(),
            leases,
        )
        .map_err(|_| WorkerDurableError::Invalid("durable process lease set is invalid"))
    }

    /// Produces a bounded, replay-backed telemetry snapshot for one authenticated
    /// Run. The only process identities are live HostKernel Core peer facts and
    /// P8's durable claimed-worker lease set; no caller PID list is accepted.
    /// The result is ephemeral derived telemetry, not a persisted OwnerLog
    /// transition, completion receipt, release proof or OS-quota guarantee.
    pub(crate) fn sample_owned_resources<B: crate::resource_sampler::ProcessBackend>(
        &self,
        backend: &mut B,
        owner: &AuthenticatedOwnerContext,
        authenticated_session_peer: Option<&crate::host_kernel::AuthenticatedCorePeerFactsV1>,
        budget: crate::resource_sampler::SampleBudget,
        sampled_at_ms: u64,
        sample_sequence: u64,
    ) -> Result<crate::resource_sampler::DurableOwnedResourceSnapshotV1, WorkerDurableError> {
        if owner.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let leases = self.durable_owned_process_leases()?;
        crate::resource_sampler::sample_durable_owned_process_leases(
            backend,
            &leases,
            owner,
            authenticated_session_peer,
            budget,
            sampled_at_ms,
            sample_sequence,
        )
        .map_err(|_| WorkerDurableError::Invalid("bounded owned-resource sample is unavailable"))
    }

    /// Revalidates the OwnerLog-backed process sample immediately before any
    /// capacity update. Samples become unusable if a worker/log mutation raced
    /// sampling or if the HostKernel reports an invalid/stale observation time.
    pub(crate) fn validate_resource_snapshot(
        &self,
        snapshot: &crate::resource_sampler::DurableOwnedResourceSnapshotV1,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
        max_age_ms: u64,
    ) -> Result<(), WorkerDurableError> {
        if max_age_ms == 0 || max_age_ms > 60_000 || now_ms < snapshot.sampled_at_ms() {
            return Err(WorkerDurableError::Invalid(
                "resource sample freshness bound is invalid",
            ));
        }
        let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
            "worker OwnerLog cursor is unavailable",
        ))?;
        let pool_revision = self
            .pool
            .as_ref()
            .map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool is unavailable"))?;
        if !snapshot.matches_owner(owner)
            || now_ms - snapshot.sampled_at_ms() > max_age_ms
            || snapshot.owner_log_id() != cursor.owner_id
            || snapshot.owner_log_sequence() != cursor.seq
            || snapshot.owner_log_event_digest() != cursor.event_digest
            || snapshot.worker_pool_revision() != pool_revision
        {
            return Err(WorkerDurableError::Conflict(
                "resource sample owner, revision, or freshness is stale",
            ));
        }
        Ok(())
    }

    /// Consume a fresh owner-attributed PSS sample against the exact
    /// HostKernel-minted resource-policy pin. This produces only an opaque
    /// advisory signal; it is deliberately not persisted and cannot open
    /// admission, terminate a process, evict a cache, or release a lease.
    /// Callers must retain the tracker only for its exact owner epoch and
    /// policy revision. Restart or policy change requires a new calm window.
    pub(crate) fn observe_authenticated_resource_pressure(
        &mut self,
        policy: &crate::resource_budget::AuthenticatedResourcePolicyPinV1,
        snapshot: &crate::resource_sampler::DurableOwnedResourceSnapshotV1,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
        max_age_ms: u64,
        lower_watermark: u64,
        required_calm_samples: u16,
    ) -> Result<crate::resource_budget::AuthenticatedResourcePressureSignalV1, WorkerDurableError> {
        self.validate_resource_snapshot(snapshot, owner, now_ms, max_age_ms)?;
        if !policy.matches_owner(owner) {
            return Err(WorkerDurableError::Conflict(
                "resource pressure policy belongs to another authenticated Attempt",
            ));
        }
        // Pressure history is process-local advisory state without an
        // OwnerLog retention contract. Reclaim only entries whose supporting
        // sample has expired; a returning owner then starts a fresh RECOVERING
        // window. This bounds owner churn without changing any lease or
        // admission state.
        self.resource_pressure_trackers
            .retain(|_, tracker| !tracker.is_expired_at(now_ms, max_age_ms));
        let needs_new_tracker = self.resource_pressure_trackers.get(owner).is_none_or(|tracker|
            !tracker.matches_inputs(
                policy, owner, crate::resource_budget::BudgetDimension::MemoryBytes,
                lower_watermark, required_calm_samples,
            ));
        if needs_new_tracker {
            if !self.resource_pressure_trackers.contains_key(owner)
                && self.resource_pressure_trackers.len() >= crate::worker_pool::MAX_WORKER_RECORDS
            {
                return Err(WorkerDurableError::Invalid(
                    "bounded resource pressure tracker table is full",
                ));
            }
            let tracker = crate::resource_budget::ManagedResourcePressureTrackerV1::from_authenticated_policy(
                policy, crate::resource_budget::BudgetDimension::MemoryBytes,
                lower_watermark, required_calm_samples,
            ).map_err(|_| WorkerDurableError::Conflict(
                "authenticated memory pressure policy is unavailable or invalid",
            ))?;
            self.resource_pressure_trackers.insert(owner.clone(), tracker);
        }
        let usage = match &snapshot.aggregate().pss_bytes {
            crate::resource_sampler::Metric::Measured(value) => u64::try_from(*value).ok(),
            crate::resource_sampler::Metric::Unknown(_) => None,
        };
        let tracker = self.resource_pressure_trackers.get_mut(owner)
            .ok_or(WorkerDurableError::Invalid("resource pressure tracker was not retained"))?;
        tracker.observe_verified_usage(
            policy,
            owner,
            snapshot.sample_sequence(),
            snapshot.sampled_at_ms(),
            snapshot.owner_log_id(),
            snapshot.owner_log_sequence(),
            snapshot.owner_log_event_digest(),
            snapshot.worker_pool_revision(),
            usage,
        ).map_err(|_| WorkerDurableError::Conflict(
            "resource pressure policy, owner or measured sample is unavailable or stale",
        ))
    }

    /// Persists one opaque measured PSS observation for its exact worker lease.
    /// This is telemetry only: it does not update admission capacity or claim
    /// any OS-enforced resource quota. No request can construct the usage value
    /// or select an arbitrary process identity.
    pub(crate) fn record_attributed_memory_usage(
        &mut self,
        snapshot: &crate::resource_sampler::DurableOwnedResourceSnapshotV1,
        usage: &crate::resource_sampler::AttributedWorkerUsageV1,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
        max_age_ms: u64,
        expected_revision: u64,
    ) -> Result<(), WorkerDurableError> {
        self.validate_resource_snapshot(snapshot, owner, now_ms, max_age_ms)?;
        if usage.owner_log_id() != snapshot.owner_log_id()
            || usage.owner_log_sequence() != snapshot.owner_log_sequence()
            || usage.owner_log_event_digest() != snapshot.owner_log_event_digest()
            || usage.worker_pool_revision() != snapshot.worker_pool_revision()
            || usage.sample_sequence() != snapshot.sample_sequence()
            || !snapshot.trees().iter().any(|tree| {
                tree.worker_execution_id() == usage.worker_execution_id()
                    && tree.task_id() == usage.task_id()
                    && tree.attempt_id() == usage.attempt_id()
                    && tree.sample().processes.first() == Some(usage.process_identity())
            })
        {
            return Err(WorkerDurableError::Conflict(
                "resource usage attribution does not match its durable sample",
            ));
        }
        let delivery_id = format!(
            "memory-usage-{}-{}",
            usage.worker_execution_id(),
            usage.sample_sequence()
        );
        self.apply(
            expected_revision,
            &delivery_id,
            WorkerCommand::MemoryUsageObserved {
                scope: OwnerScopeKey::from_owner(owner),
                attribution: usage.clone(),
            },
        )
    }

    /// Durably enqueue a nested child with an authenticated live parent edge.
    /// Parent facts and ID come only from the opaque proof re-resolved against
    /// this OwnerLog; the request cannot assert its own parent.
    pub(crate) fn enqueue_child(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        mut request: EnqueueRequest,
        child_owner: &AuthenticatedOwnerContext,
        parent_proof: &DurableParentExecutionProofV1,
        parent_binding: &VerifiedAttemptBinding,
        parent_owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<(), WorkerDurableError> {
        self.validate_active_parent_execution_proof(
            parent_proof,
            parent_binding,
            parent_owner,
            now_ms,
        )?;
        if request.parent_execution.is_some()
            || parent_proof.owner().principal_ref != child_owner.principal_ref()
            || parent_proof.owner().workspace_binding != child_owner.workspace_binding()
            || parent_proof.owner().session_id != child_owner.session_id()
            || parent_proof.owner().run_id != child_owner.run_id()
            || parent_proof.owner().owner_epoch != child_owner.owner_epoch()
            || parent_proof.owner().task_id == child_owner.task_id()
            || parent_proof.owner().attempt_id == child_owner.attempt_id()
            || parent_proof.goal_id() != request.goal_id
            || parent_proof.accepted_spec_digest() != request.accepted_spec_digest
        {
            return Err(WorkerDurableError::Invalid(
                "parent execution scope mismatch",
            ));
        }
        // The child Task CAS revision is intentionally not compared with the
        // parent's workspace content revision. The managed pre-admission pin
        // carries both separately; enqueue_pre_admission checks the parent
        // lineage against the child's HostKernel-measured workspace revision
        // before it can reserve or dispatch.
        request.parent_execution = Some(parent_proof.child_lineage()?);
        self.apply(
            expected_revision,
            delivery_id,
            WorkerCommand::Enqueue {
                scope: OwnerScopeKey::from_owner(child_owner),
                request,
            },
        )
    }

    /// Applies one trusted capacity sample to the in-memory pool. Capacity
    /// observations are derived telemetry (like managed snapshots), so they
    /// are not OwnerLog commands; the CAS revisions the ingress reads stay
    /// consistent with the replayed log because callers pass the revision they
    /// just read.
    /// Internal telemetry primitive. No RPC accepts caller-supplied limits or
    /// usage; exposing this through an unauthenticated adapter would turn
    /// untrusted measurements into admission authority.
    pub(crate) fn update_capacity(
        &mut self,
        dimension: BudgetDimension,
        hard_limit: Option<u64>,
        measured_total: Option<u64>,
        safety_reserve: u64,
        owner_epoch: u64,
        sample_sequence: u64,
        expected_revision: u64,
    ) -> Result<u64, WorkerDurableError> {
        let pool = self
            .pool
            .as_mut()
            .ok_or(WorkerDurableError::Invalid("worker pool was not opened"))?;
        Ok(pool.update_capacity(
            dimension,
            hard_limit,
            measured_total,
            safety_reserve,
            owner_epoch,
            sample_sequence,
            expected_revision,
        )?)
    }

    /// Applies one command: exact retries are idempotent, a reused delivery key
    /// with a different command fails closed, and the OwnerLog append wins
    /// before the new state is published.
    pub fn apply(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        command: WorkerCommand,
    ) -> Result<(), WorkerDurableError> {
        if delivery_id.is_empty() || delivery_id.len() > 256 {
            return Err(WorkerDurableError::Invalid("invalid delivery ID"));
        }
        let (kind, data) = command.event();
        let logical = logical_command_digest(kind, &data);
        if let Some(previous) = self.deliveries.get(delivery_id) {
            return if previous == &logical {
                Ok(())
            } else {
                Err(WorkerDurableError::Conflict(
                    "delivery key reused for a different worker command",
                ))
            };
        }
        match &command {
            WorkerCommand::PreAdmissionContextBound { worker_execution_id, ticket_id, pins } => {
                pins.validate()?;
                let current = self.identities.pre_admission_pins.get(worker_execution_id)
                    .ok_or(WorkerDurableError::Conflict("context bind has no Stage-A reservation"))?;
                let worker = self.pool.as_ref().and_then(|pool| pool.worker(worker_execution_id))
                    .ok_or(WorkerDurableError::NotFound("context bind worker unavailable"))?;
                let (expected_ticket, expected_worker, _) = pre_admission_ids(pins);
                let mut pre_context = pins.clone();
                pre_context.context_selection_digest = None;
                pre_context.pins_digest = pre_context.compute_digest();
                if !pins.staged_pre_admission || pins.context_selection_digest.is_none()
                    || expected_worker != *worker_execution_id || expected_ticket != *ticket_id
                    || pre_context != *current || current.context_selection_digest.is_some()
                        && current != pins
                    || worker.state != crate::resource_budget::ReservationState::Reserved
                    || worker.cancellation_requested || worker.unknown_effect
                    || worker.process_identity.is_some()
                    || self.identities.delegation_bindings.contains_key(worker_execution_id)
                {
                    return Err(WorkerDurableError::Conflict(
                        "ContextSelection can bind only once to the same unclaimed Stage-A reservation",
                    ));
                }
            }
            WorkerCommand::SettleWorker { worker_execution_id, .. }
            | WorkerCommand::ReconcileRelease { worker_execution_id, .. }
                if self.identities.pre_admission_pins.contains_key(worker_execution_id) =>
            {
                return Err(WorkerDurableError::Conflict(
                    "managed logical workers require opaque proof-backed settlement",
                ));
            }
            _ => {}
        }
        if let WorkerCommand::Enqueue { request, .. } = &command {
            if let Some(parent) = request.parent_execution.as_ref() {
                let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
                    "parent lineage requires an opened OwnerLog",
                ))?;
                if parent.owner_log_id() != cursor.owner_id
                    || parent.owner_log_sequence() != cursor.seq
                    || parent.owner_log_event_digest() != cursor.event_digest
                    || self.pool.as_ref().map(WorkerPool::revision)
                        != Some(parent.worker_pool_revision())
                {
                    return Err(WorkerDurableError::Conflict(
                        "parent execution lineage is stale at child enqueue",
                    ));
                }
            }
        }
        match &command {
            WorkerCommand::RegisterWorktree { owner, registration }
                if registration.owner() != owner || registration.verification_digest().is_none() =>
            {
                return Err(WorkerDurableError::Conflict(
                    "live worktree registration requires matching guarded provenance",
                ));
            }
            WorkerCommand::RegisterWorktree { owner, registration } => {
                if !self.identities.root_coordinators.get(owner.coordinator_id())
                    .is_some_and(|root| worktree_root_owner_matches_execution(owner, root))
                    || self.identities.removed_worktree_registrations.contains_key(&registration.registration().id)
                {
                    return Err(WorkerDurableError::Conflict(
                        "worktree registration root is stale or its ID is tombstoned",
                    ));
                }
            }
            WorkerCommand::WorktreeRegistrationRemoved { owner, operation_id, worktree_id } => {
                let record = self.worktree_operations.get(operation_id).ok_or(
                    WorkerDurableError::NotFound("worktree release operation is not durable"),
                )?;
                if !self.worktree_operations.is_release_safe(operation_id)
                    || record.intent().owner() != owner
                    || record.intent().worktree_id() != worktree_id
                    || !self.identities.verified_worktree_registrations.contains_key(worktree_id)
                    || self.identities.removed_worktree_registrations.contains_key(worktree_id)
                    || !self.identities.root_coordinators.get(owner.coordinator_id())
                        .is_some_and(|root| worktree_root_owner_matches_execution(owner, root))
                {
                    return Err(WorkerDurableError::Conflict(
                        "worktree removal requires exact current root and clean guarded release proof",
                    ));
                }
            }
            WorkerCommand::WorktreeOperationRetiredNoDispatch { current_owner, operation_id, intent_digest } => {
                let record = self.worktree_operations.get(operation_id).ok_or(
                    WorkerDurableError::NotFound("pending worktree operation is missing"),
                )?;
                let expected_digest = worktree_intent_digest(record.intent());
                if record.state() != WorktreeOperationStateV1::Pending
                    || record.receipt().is_some()
                    || expected_digest != *intent_digest
                    || !self.identities.root_coordinators.get(current_owner.coordinator_id())
                        .is_some_and(|root| worktree_root_owner_matches_execution(current_owner, root))
                    || current_owner.owner_epoch() != self.resumed_epoch
                    || !same_worktree_root_lineage(record.intent().owner(), current_owner)
                {
                    return Err(WorkerDurableError::Conflict(
                        "no-dispatch retirement requires exact Pending intent and fresh same-lineage root",
                    ));
                }
            }
            WorkerCommand::ClaimWorker { worker_execution_id, .. }
                if self.identities.claim_receipts.contains_key(worker_execution_id) =>
            {
                return Err(WorkerDurableError::Conflict(
                    "managed worker already has a durable one-use claim receipt",
                ));
            }
            WorkerCommand::WorktreeOperationIntent { intent } => {
                let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
                    "worktree intent requires an opened OwnerLog",
                ))?;
                if intent.owner_log_id() != cursor.owner_id
                    || intent.owner_log_sequence() != cursor.seq
                    || intent.owner_log_event_digest() != cursor.event_digest
                    || intent.owner_epoch() != self.resumed_epoch
                    || !self.identities.root_coordinators.get(intent.owner().coordinator_id())
                        .is_some_and(|root| worktree_root_owner_matches_execution(intent.owner(), root))
                {
                    return Err(WorkerDurableError::Conflict(
                        "worktree intent is stale or from another owner epoch",
                    ));
                }
            }
            WorkerCommand::WorktreeOperationReceipt { receipt } => {
                if self
                    .worktree_operations
                    .get(receipt.operation_id())
                    .is_none()
                {
                    return Err(WorkerDurableError::NotFound(
                        "worktree operation intent was not durably recorded",
                    ));
                }
            }
            WorkerCommand::ManagedFinalInspectCandidatePinned { pin } => {
                let operation = self.worktree_operations.get(&pin.operation_id).ok_or(
                    WorkerDurableError::NotFound("final Inspect intent is not durable"),
                )?;
                let matching_pins = self.identities.pre_admission_pins.iter().filter(|(worker_id, pins)| {
                    pins.attempt_id() == pin.attempt_id
                        && self.identities.delegation_bindings.get(*worker_id)
                            .is_some_and(|binding| binding.binding_digest == pin.binding_digest
                                && binding.worktree_admission.as_ref().is_some_and(|admission|
                                    admission.worktree_id == pins.worktree.worktree_id
                                        && admission.base_revision == pins.worktree.base_revision
                                        && admission.root_location_id == pins.location_id
                                        && admission.p8_workspace_binding == pins.workspace_binding()))
                        && pins.worktree.worktree_id == operation.intent().worktree_id()
                        && pins.worktree.base_revision == operation.intent().base_revision().unwrap_or_default()
                        && pins.workspace_binding() == operation.intent().root().workspace_binding()
                        && pins.location_id() == operation.intent().root().location_ref()
                }).count();
                if operation.intent().kind() != WorktreeOperationKindV1::Inspect
                    || operation.intent().expected_workspace_revision() != pin.final_revision
                    || worktree_operation_id(operation.intent().owner(), WorktreeOperationKindV1::Inspect,
                        &managed_final_inspect_idempotency_key(&pin.attempt_id)) != pin.operation_id
                    || self.managed_final_inspect_candidate_pins.contains_key(&pin.operation_id)
                    || matching_pins != 1
                    || !valid_digest(&pin.candidate_digest, "blake3:")
                    || !valid_digest(&pin.binding_digest, "blake3:")
                    || !valid_digest(&pin.spec_digest, "blake3:")
                    || !valid_digest(&pin.evidence_digest, "blake3:")
                    || !valid_digest(&pin.final_revision, "blake3:")
                    || (pin.verification_run_id.is_some() != pin.set_identity_digest.is_some())
                    || (pin.verification_run_id.is_some() != pin.challenge_set_digest.is_some())
                    || pin.verification_run_id.as_deref().is_some_and(|id| validate_owner_token(id).is_err())
                    || pin.set_identity_digest.as_deref().is_some_and(|digest| !valid_digest(digest, "blake3:"))
                    || pin.challenge_set_digest.as_deref().is_some_and(|digest| !valid_digest(digest, "blake3:"))
                    || validate_owner_token(&pin.attempt_id).is_err()
                    || validate_owner_token(&pin.spec_id).is_err()
                {
                    return Err(WorkerDurableError::Conflict(
                        "final Inspect candidate pin does not match a unique unpinned intent",
                    ));
                }
            }
            WorkerCommand::MemoryUsageObserved { scope, attribution } => {
                let cursor = self.cursor.as_ref().ok_or(WorkerDurableError::Invalid(
                    "resource usage requires an opened OwnerLog",
                ))?;
                let owner = rehydrate(scope)?;
                if attribution.owner_log_id() != cursor.owner_id
                    || attribution.owner_log_sequence() != cursor.seq
                    || attribution.owner_log_event_digest() != cursor.event_digest
                    || attribution.worker_pool_revision()
                        != self
                            .pool
                            .as_ref()
                            .map(WorkerPool::revision)
                            .unwrap_or_default()
                    || owner.task_id() != attribution.task_id()
                    || owner.attempt_id() != attribution.attempt_id()
                {
                    return Err(WorkerDurableError::Conflict(
                        "resource usage attribution is stale or mismatched",
                    ));
                }
            }
            _ => {}
        }
        let next = match &self.pool {
            None => match &command {
                WorkerCommand::PoolOpened {
                    owner_epoch,
                    max_live_workers,
                    max_queued_tickets,
                    max_worktrees,
                } => {
                    if expected_revision != 0 {
                        return Err(WorkerDurableError::StaleRevision);
                    }
                    let mut pool = WorkerPool::new(WorkerPoolConfig {
                        owner_epoch: *owner_epoch,
                        max_live_workers: *max_live_workers,
                        max_queued_tickets: *max_queued_tickets,
                        max_worktrees: *max_worktrees,
                    })?;
                    pool.mark_opened()?;
                    pool
                }
                _ => {
                    return Err(WorkerDurableError::ReplayConflict(
                        "the worker log must start with worker_pool_opened",
                    ));
                }
            },
            Some(pool) => {
                if pool.revision() != expected_revision {
                    return Err(WorkerDurableError::StaleRevision);
                }
                let mut next = pool.clone();
                command.apply_to(&mut next, ApplyMode::Live)?;
                if let WorkerCommand::DelegationBound { worker_execution_id, binding } = &command {
                    if let Some(admission) = binding.worktree_admission.as_ref() {
                        next.bind_managed_child_workspace_revision(
                            worker_execution_id, &admission.child_workspace_revision,
                        )?;
                    }
                }
                next
            }
        };
        let mut next_worktree_operations = self.worktree_operations.clone();
        apply_worktree_journal_command(&mut next_worktree_operations, &command)?;
        let mut next_identities = self.identities.clone();
        apply_worker_identity_command(&mut next_identities, &next, &next_worktree_operations,
            &self.managed_settlement_receipts, &command)?;
        let mut event = OwnerEventInput {
            schema_version: EVENT_SCHEMA_VERSION,
            time_ms: now_ms(),
            kind: kind.to_owned(),
            data,
            delivery_id: None,
            command_digest: None,
        };
        let command_digest = OwnerLogV2::command_digest(delivery_id, &[event.clone()])?;
        event.delivery_id = Some(delivery_id.to_owned());
        event.command_digest = Some(command_digest.clone());
        let receipt =
            self.log
                .append_batch(delivery_id, &command_digest, &[event], self.cursor.as_ref())?;
        self.deliveries.insert(delivery_id.to_owned(), logical);
        self.pool = Some(next);
        self.worktree_operations = next_worktree_operations;
        self.identities = next_identities;
        if let WorkerCommand::ManagedFinalInspectCandidatePinned { pin } = &command {
            self.managed_final_inspect_candidate_pins.insert(pin.operation_id.clone(), pin.clone());
        }
        self.cursor = Some(receipt.owner_cursor);
        if let WorkerCommand::ClaimWorker { worker_execution_id, .. } = &command {
            let committed_cursor = self.cursor.as_ref().expect("committed command has cursor");
            let pool = self.pool.as_ref().expect("committed claim has worker pool");
            record_claim_receipt(&mut self.identities, pool, worker_execution_id, committed_cursor)?;
        }
        if let WorkerCommand::ManagedLogicalSettled { event } = &command {
            let cursor = self.cursor.as_ref().expect("committed managed settlement has cursor").clone();
            let revision = self.pool.as_ref().map(WorkerPool::revision)
                .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
            let receipt = WorkerSettlementReceiptV1::from_committed_event(event, &cursor, revision);
            self.managed_settlement_receipts.insert(event.worker_execution_id.clone(), receipt);
        }
        if let WorkerCommand::ManagedWorktreeDisposition { event } = &command {
            self.managed_worktree_disposition_events.insert(event.worker_execution_id.clone(), event.clone());
            let cursor = self.cursor.as_ref().expect("committed worktree disposition has cursor").clone();
            let revision = self.pool.as_ref().map(WorkerPool::revision)
                .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
            let receipt = WorkerWorktreeDispositionReceiptV1::from_committed_event(event, &cursor, revision);
            self.managed_worktree_disposition_receipts.insert(event.worker_execution_id.clone(), receipt);
        }
        if let WorkerCommand::ManagedTerminalQuarantined { event } = &command {
            let cursor = self.cursor.as_ref().expect("committed quarantine has cursor").clone();
            let revision = self.pool.as_ref().map(WorkerPool::revision)
                .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
            let receipt = WorkerManagedQuarantineReceiptV1::from_committed_event(event, &cursor, revision);
            self.managed_quarantine_receipts.insert(event.worker_execution_id.clone(), receipt);
        }
        if let WorkerCommand::PreAdmissionReconciled { proof } = &command {
            let committed_cursor = self.cursor.as_ref().expect("committed command has cursor");
            let worker_pool_revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
            let receipt = PreAdmissionReconciliationReceiptV1::from_committed_event(
                proof, committed_cursor, worker_pool_revision,
            );
            self.pre_admission_reconciliation_receipts
                .insert(proof.worker_execution_id().to_owned(), receipt);
        }
        if let WorkerCommand::WorktreeOperationRetiredNoDispatch {
            current_owner, operation_id, intent_digest,
        } = &command {
            let old_owner_digest = self.worktree_operations.get(operation_id)
                .ok_or(WorkerDurableError::NotFound("retired operation is missing"))?
                .intent().owner().root_digest().to_owned();
            let cursor = self.cursor.as_ref().expect("committed retirement has cursor").clone();
            let worker_pool_revision = self.pool.as_ref().map(WorkerPool::revision)
                .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
            let receipt = WorktreeOperationRetirementReceiptV1::from_committed_event(
                operation_id.clone(), old_owner_digest, current_owner.clone(),
                intent_digest.clone(), &cursor, worker_pool_revision,
            );
            self.worktree_retirement_receipts.insert(operation_id.clone(), receipt);
        }
        if let WorkerCommand::WorktreeRegistrationRemoved { operation_id, worktree_id, .. } = &command {
            let release_receipt_ref = self.worktree_operations.get(operation_id)
                .and_then(|record| record.receipt())
                .ok_or(WorkerDurableError::NotFound("worktree release receipt is missing"))?
                .host_receipt_ref().to_owned();
            let cursor = self.cursor.as_ref().expect("committed removal has cursor").clone();
            self.build_worktree_removal_receipt(
                delivery_id, worktree_id, operation_id, &release_receipt_ref, &cursor,
            )?;
        }
        Ok(())
    }

    fn replay(&mut self) -> Result<(), WorkerDurableError> {
        let limit = NonZeroUsize::new(MAX_BATCH_EVENTS).expect("nonzero batch limit");
        loop {
            let batch = self.log.read_after(self.cursor.as_ref(), limit)?;
            for event in &batch.events {
                let envelope = event
                    .data
                    .as_object()
                    .ok_or(WorkerDurableError::Invalid("invalid worker envelope"))?;
                let version = envelope.get("schemaVersion").and_then(Value::as_u64);
                if version != Some(u64::from(EVENT_SCHEMA_VERSION)) {
                    return Err(WorkerDurableError::ReplayConflict(
                        "unknown worker schema version",
                    ));
                }
                let payload = envelope
                    .get("payload")
                    .ok_or(WorkerDurableError::Invalid("missing worker payload"))?;
                let delivery = envelope
                    .get("deliveryId")
                    .and_then(Value::as_str)
                    .ok_or(WorkerDurableError::Invalid("missing worker delivery"))?;
                let command_digest = envelope
                    .get("commandDigest")
                    .and_then(Value::as_str)
                    .ok_or(WorkerDurableError::Invalid("missing worker command digest"))?;
                if self.deliveries.contains_key(delivery) {
                    return Err(WorkerDurableError::ReplayConflict(
                        "duplicate worker delivery",
                    ));
                }
                if !command_digest.starts_with("blake3:") {
                    return Err(WorkerDurableError::Invalid(
                        "invalid worker physical command digest",
                    ));
                }
                let command = WorkerCommand::decode(
                    &event.kind,
                    payload,
                    version.expect("validated worker schema version"),
                )?;
                match &command {
                    WorkerCommand::SettleWorker { worker_execution_id, .. }
                    | WorkerCommand::ReconcileRelease { worker_execution_id, .. }
                        if self.identities.pre_admission_pins.contains_key(worker_execution_id) =>
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "managed logical worker used legacy flag-based settlement",
                        ));
                    }
                    _ => {}
                }
                if let WorkerCommand::Enqueue { request, .. } = &command {
                    if let Some(parent) = request.parent_execution.as_ref() {
                        let prior_sequence = event.seq.saturating_sub(1).to_string();
                        let prior_digest = format!("blake3:{}", event.previous_digest.to_hex());
                        if parent.owner_log_id() != self.pool_id
                            || parent.owner_log_sequence() != prior_sequence
                            || parent.owner_log_event_digest() != prior_digest
                            || self.pool.as_ref().map(WorkerPool::revision)
                                != Some(parent.worker_pool_revision())
                        {
                            return Err(WorkerDurableError::ReplayConflict(
                                "child parent lineage does not match the preceding OwnerLog state",
                            ));
                        }
                    }
                }
                if let WorkerCommand::WorktreeOperationIntent { intent } = &command {
                    let prior_sequence = event.seq.saturating_sub(1).to_string();
                    let prior_digest = format!("blake3:{}", event.previous_digest.to_hex());
                    if intent.owner_log_id() != self.pool_id
                        || intent.owner_log_sequence() != prior_sequence
                        || intent.owner_log_event_digest() != prior_digest
                        || self.pool.as_ref().map(WorkerPool::owner_epoch)
                            != Some(intent.owner_epoch())
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "worktree intent does not bind the preceding OwnerLog state",
                        ));
                    }
                }
                if let WorkerCommand::WorktreeOperationRetiredNoDispatch {
                    current_owner, operation_id, intent_digest,
                } = &command {
                    let record = self.worktree_operations.get(operation_id).ok_or(
                        WorkerDurableError::ReplayConflict("retired worktree operation missing"),
                    )?;
                    if record.state() != WorktreeOperationStateV1::Pending
                        || record.receipt().is_some()
                        || worktree_intent_digest(record.intent()) != *intent_digest
                        || !same_worktree_root_lineage(record.intent().owner(), current_owner)
                        || self.pool.as_ref().map(WorkerPool::owner_epoch)
                            != Some(current_owner.owner_epoch())
                        || !self.identities.root_coordinators.get(current_owner.coordinator_id())
                            .is_some_and(|root| worktree_root_owner_matches_execution(current_owner, root))
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "worktree no-dispatch retirement lacks exact pending same-lineage proof",
                        ));
                    }
                }
                if let WorkerCommand::ManagedFinalInspectCandidatePinned { pin } = &command {
                    let intent = self.worktree_operations.get(&pin.operation_id).ok_or(
                        WorkerDurableError::ReplayConflict("final Inspect candidate has no prior intent"),
                    )?;
                    if intent.intent().kind() != WorktreeOperationKindV1::Inspect
                        || intent.intent().expected_workspace_revision() != pin.final_revision
                        || worktree_operation_id(intent.intent().owner(), WorktreeOperationKindV1::Inspect,
                            &managed_final_inspect_idempotency_key(&pin.attempt_id)) != pin.operation_id
                        || self.managed_final_inspect_candidate_pins.contains_key(&pin.operation_id)
                        || (pin.verification_run_id.is_some() != pin.set_identity_digest.is_some())
                        || (pin.verification_run_id.is_some() != pin.challenge_set_digest.is_some())
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "final Inspect candidate pin does not match its unique prior intent",
                        ));
                    }
                }
                self.deliveries.insert(
                    delivery.to_owned(),
                    logical_command_digest(&event.kind, payload),
                );
                match &command {
                    WorkerCommand::PoolOpened {
                        owner_epoch,
                        max_live_workers,
                        max_queued_tickets,
                        max_worktrees,
                    } => {
                        if self.pool.is_some() {
                            return Err(WorkerDurableError::ReplayConflict(
                                "worker pool opened twice",
                            ));
                        }
                        let mut pool = WorkerPool::new(WorkerPoolConfig {
                            owner_epoch: *owner_epoch,
                            max_live_workers: *max_live_workers,
                            max_queued_tickets: *max_queued_tickets,
                            max_worktrees: *max_worktrees,
                        })?;
                        pool.mark_opened()?;
                        // Replay reconstructs already-committed history; the
                        // gate is reopened for reconstruction and closed again
                        // after replay so new work needs fresh authorization.
                        pool.enable_managed_attempt_fan_out(*owner_epoch)?;
                        self.pool = Some(pool);
                    }
                    other => {
                        let pool = self
                            .pool
                            .as_mut()
                            .ok_or(WorkerDurableError::ReplayConflict(
                                "worker command before worker_pool_opened",
                            ))?;
                        other.apply_to(pool, ApplyMode::Replay)?;
                    }
                }
                if let WorkerCommand::DelegationBound { worker_execution_id, binding } = &command {
                    if let Some(admission) = binding.worktree_admission.as_ref() {
                        self.pool.as_mut().ok_or(WorkerDurableError::ReplayConflict(
                            "managed child binding precedes worker pool open",
                        ))?.bind_managed_child_workspace_revision(
                            worker_execution_id, &admission.child_workspace_revision,
                        ).map_err(WorkerDurableError::Pool)?;
                    }
                }
                apply_worker_identity_command(
                    &mut self.identities,
                    self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool missing"))?,
                    &self.worktree_operations,
                    &self.managed_settlement_receipts,
                    &command,
                )?;
                if let WorkerCommand::ClaimWorker { worker_execution_id, .. } = &command {
                    let event_cursor = CursorV1 {
                        owner_kind: OWNER_KIND.to_owned(),
                        owner_id: self.pool_id.clone(),
                        seq: event.seq.to_string(),
                        event_digest: format!("blake3:{}", event.event_digest.to_hex()),
                    };
                    record_claim_receipt(
                        &mut self.identities,
                        self.pool.as_ref().expect("replayed claim has worker pool"),
                        worker_execution_id,
                        &event_cursor,
                    )?;
                }
                if let WorkerCommand::ManagedLogicalSettled { event: settlement } = &command {
                    let event_cursor = CursorV1 {
                        owner_kind: OWNER_KIND.to_owned(), owner_id: self.pool_id.clone(),
                        seq: event.seq.to_string(),
                        event_digest: format!("blake3:{}", event.event_digest.to_hex()),
                    };
                    let revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
                    let receipt = WorkerSettlementReceiptV1::from_committed_event(
                        settlement, &event_cursor, revision,
                    );
                    if let Some(previous) = self.managed_settlement_receipts
                        .insert(settlement.worker_execution_id.clone(), receipt.clone())
                        && previous != receipt
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "managed settlement receipt changed during replay",
                        ));
                    }
                }
                if let WorkerCommand::ManagedWorktreeDisposition { event: disposition } = &command {
                    if let Some(previous) = self.managed_worktree_disposition_events
                        .insert(disposition.worker_execution_id.clone(), disposition.clone())
                        && previous != *disposition
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "managed worktree disposition changed during replay",
                        ));
                    }
                    let event_cursor = CursorV1 {
                        owner_kind: OWNER_KIND.to_owned(), owner_id: self.pool_id.clone(),
                        seq: event.seq.to_string(),
                        event_digest: format!("blake3:{}", event.event_digest.to_hex()),
                    };
                    let revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
                    let receipt = WorkerWorktreeDispositionReceiptV1::from_committed_event(
                        disposition, &event_cursor, revision,
                    );
                    if let Some(previous) = self.managed_worktree_disposition_receipts
                        .insert(disposition.worker_execution_id.clone(), receipt.clone())
                        && previous != receipt
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "managed worktree disposition receipt changed during replay",
                        ));
                    }
                }
                if let WorkerCommand::ManagedTerminalQuarantined { event: quarantine } = &command {
                    let event_cursor = CursorV1 {
                        owner_kind: OWNER_KIND.to_owned(), owner_id: self.pool_id.clone(),
                        seq: event.seq.to_string(),
                        event_digest: format!("blake3:{}", event.event_digest.to_hex()),
                    };
                    let revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
                    let receipt = WorkerManagedQuarantineReceiptV1::from_committed_event(
                        quarantine, &event_cursor, revision,
                    );
                    if let Some(previous) = self.managed_quarantine_receipts
                        .insert(quarantine.worker_execution_id.clone(), receipt.clone())
                        && previous != receipt
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "managed terminal quarantine receipt changed during replay",
                        ));
                    }
                }
                apply_worktree_journal_command(&mut self.worktree_operations, &command)?;
                if let WorkerCommand::ManagedFinalInspectCandidatePinned { pin } = &command {
                    if self.managed_final_inspect_candidate_pins.insert(
                        pin.operation_id.clone(), pin.clone(),
                    ).is_some() {
                        return Err(WorkerDurableError::ReplayConflict(
                            "final Inspect candidate pin was duplicated",
                        ));
                    }
                }
                if let WorkerCommand::WorktreeRegistrationRemoved { operation_id, worktree_id, .. } = &command {
                    let release_receipt_ref = self.worktree_operations.get(operation_id)
                        .and_then(|record| record.receipt())
                        .ok_or(WorkerDurableError::ReplayConflict("worktree removal release receipt missing"))?
                        .host_receipt_ref().to_owned();
                    let cursor = CursorV1 {
                        owner_kind: OWNER_KIND.to_owned(),
                        owner_id: self.pool_id.clone(),
                        seq: event.seq.to_string(),
                        event_digest: format!("blake3:{}", event.event_digest.to_hex()),
                    };
                    let delivery_id = envelope.get("deliveryId").and_then(Value::as_str)
                        .ok_or(WorkerDurableError::Invalid("worktree removal delivery missing"))?;
                    self.build_worktree_removal_receipt(
                        delivery_id, worktree_id, operation_id, &release_receipt_ref, &cursor,
                    )?;
                }
                if let WorkerCommand::WorktreeOperationRetiredNoDispatch {
                    current_owner, operation_id, intent_digest,
                } = &command {
                    let old_owner_digest = self.worktree_operations.get(operation_id)
                        .ok_or(WorkerDurableError::ReplayConflict("retired worktree operation missing"))?
                        .intent().owner().root_digest().to_owned();
                    let cursor = CursorV1 {
                        owner_kind: OWNER_KIND.to_owned(),
                        owner_id: self.pool_id.clone(),
                        seq: event.seq.to_string(),
                        event_digest: format!("blake3:{}", event.event_digest.to_hex()),
                    };
                    let receipt = WorktreeOperationRetirementReceiptV1::from_committed_event(
                        operation_id.clone(), old_owner_digest, current_owner.clone(),
                        intent_digest.clone(), &cursor,
                        self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default(),
                    );
                    if let Some(previous) = self.worktree_retirement_receipts
                        .insert(operation_id.clone(), receipt.clone())
                        && previous != receipt
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "worktree retirement receipt changed during replay",
                        ));
                    }
                }
                if let WorkerCommand::PreAdmissionReconciled { proof } = &command {
                    let event_cursor = CursorV1 {
                        owner_kind: OWNER_KIND.to_owned(),
                        owner_id: self.pool_id.clone(),
                        seq: event.seq.to_string(),
                        event_digest: format!("blake3:{}", event.event_digest.to_hex()),
                    };
                    let worker_pool_revision = self.pool.as_ref().map(WorkerPool::revision).unwrap_or_default();
                    let receipt = PreAdmissionReconciliationReceiptV1::from_committed_event(
                        &proof, &event_cursor, worker_pool_revision,
                    );
                    if let Some(previous) = self.pre_admission_reconciliation_receipts
                        .insert(proof.worker_execution_id().to_owned(), receipt.clone())
                        && previous != receipt
                    {
                        return Err(WorkerDurableError::ReplayConflict(
                            "pre-admission reconciliation receipt changed during replay",
                        ));
                    }
                }
            }
            self.cursor = batch.cursor;
            if !batch.has_more {
                break;
            }
        }
        if let Some(pool) = self.pool.as_mut() {
            pool.close_fan_out();
        }
        Ok(())
    }
}

fn validate_owner_token(value: &str) -> Result<(), WorkerDurableError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        Err(WorkerDurableError::Invalid("invalid owner identity pin"))
    } else { Ok(()) }
}

fn validate_owner_digest(value: &str, prefix: &str) -> Result<(), WorkerDurableError> {
    if !value.strip_prefix(prefix).is_some_and(|hex| hex.len() == 64
        && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
    {
        Err(WorkerDurableError::Invalid("invalid owner digest pin"))
    } else { Ok(()) }
}

fn trusted_pre_admission_value(pins: &TrustedPreAdmissionPinsV1) -> Value {
    let parent = match &pins.parent_proof {
        ManagedParentProofV1::RootCoordinator(proof) => json!({
            "kind": "ROOT_COORDINATOR",
            "execution": root_coordinator_value(&proof.execution),
            "ownerLogId": proof.owner_log_id,
            "ownerLogSequence": proof.owner_log_sequence,
            "ownerLogEventDigest": proof.owner_log_event_digest,
            "workerPoolRevision": proof.worker_pool_revision,
        }),
        ManagedParentProofV1::ClaimedWorker(proof) => json!({
            "kind": "CLAIMED_WORKER",
            "workerExecutionId": proof.worker_execution_id,
            "goalId": proof.goal_id,
            "owner": scope_value(&proof.owner),
            "sourceRevision": proof.source_revision,
            "acceptedSpecDigest": proof.accepted_spec_digest,
            "processIdentity": process_identity_value(&proof.process_identity),
            "ownerLogId": proof.owner_log_id,
            "ownerLogSequence": proof.owner_log_sequence,
            "ownerLogEventDigest": proof.owner_log_event_digest,
            "workerPoolRevision": proof.worker_pool_revision,
        }),
    };
    json!({
        "owner": scope_value(&OwnerScopeKey::from_owner(&pins.owner)),
        "goalId": pins.goal_id,
        "taskRevision": pins.task_revision,
        "taskAttemptCount": pins.task_attempt_count.to_string(),
        "candidateGeneration": pins.candidate_generation.to_string(),
        "acceptedSpecDigest": pins.accepted_spec_digest,
        "workspaceRevision": pins.workspace_revision,
        "locationId": pins.location_id,
        "processIncarnation": pins.process_incarnation,
        "profileId": pins.profile_id,
        "profileRevision": pins.profile_revision.to_string(),
        "profileDigest": pins.profile_digest,
        "profilePermissionCeilingDigest": pins.profile_permission_ceiling_digest,
        "contextSelectionDigest": pins.context_selection_digest,
        "acceptedScopeDigest": pins.accepted_scope_digest,
        "capabilityCeilingDigest": pins.capability_ceiling_digest,
        "specMaxWorkers": pins.spec_max_workers.to_string(),
        "resourcePolicyRevision": pins.resource_policy_revision.to_string(),
        "resourcePolicyDigest": pins.resource_policy_digest,
        "resourceActiveWorkerLimit": pins.resource_active_worker_limit.map(|value| value.to_string()),
        "dimension": pins.dimension.wire_name(),
        "amount": pins.amount,
        "expiresAtMs": pins.expires_at_ms,
        "worktree": {"worktreeId": pins.worktree.worktree_id, "baseRevision": pins.worktree.base_revision},
        "worktreePoolRevision": pins.worktree_pool_revision.to_string(),
        "idempotencyKey": pins.idempotency_key,
        "parentProof": parent,
        "stagedPreAdmission": pins.staged_pre_admission,
        "pinsDigest": pins.pins_digest,
    })
}

fn managed_reservation_reconciliation_value(
    proof: &ManagedReservationReconciliationProofV1,
) -> Value {
    json!({
        "workerExecutionId": proof.worker_execution_id,
        "ticketId": proof.ticket_id,
        "attemptId": proof.attempt_id,
        "pinsDigest": proof.pins_digest,
        "disposition": match proof.disposition {
            ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch => "NOT_ADMITTED_NO_DISPATCH",
            ManagedReservationReconciliationDispositionV1::TerminalNoEffect => "TERMINAL_NO_EFFECT",
        },
        "managedOwnerLogId": proof.managed_owner_log_id,
        "managedOwnerLogSequence": proof.managed_owner_log_sequence,
        "managedOwnerLogEventDigest": proof.managed_owner_log_event_digest,
        "managedOwnerRevision": proof.managed_owner_revision,
        "hostOwnerEpoch": proof.host_owner_epoch,
        "hostProcessIncarnation": proof.host_process_incarnation,
        "noProcessObservationDigest": proof.no_process_observation_digest,
        "attemptDigest": proof.attempt_digest,
        "bindingDigest": proof.binding_digest,
        "proofDigest": proof.proof_digest,
    })
}

fn decode_managed_reservation_reconciliation(
    value: &Value,
) -> Result<ManagedReservationReconciliationProofV1, WorkerDurableError> {
    if value.as_object().map(|fields| fields.len()) != Some(15) {
        return Err(WorkerDurableError::Invalid("invalid managed reconciliation proof shape"));
    }
    let disposition = match text(value, "disposition")?.as_str() {
        "NOT_ADMITTED_NO_DISPATCH" => ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch,
        "TERMINAL_NO_EFFECT" => ManagedReservationReconciliationDispositionV1::TerminalNoEffect,
        _ => return Err(WorkerDurableError::Invalid("unknown managed reconciliation disposition")),
    };
    let optional_text = |key: &str| -> Result<Option<String>, WorkerDurableError> {
        match value.get(key) {
            Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.clone())),
            _ => Err(WorkerDurableError::Invalid("invalid optional reconciliation digest")),
        }
    };
    let expected_digest = text(value, "proofDigest")?;
    let proof = ManagedReservationReconciliationProofV1::from_authenticated_host(
        text(value, "workerExecutionId")?, text(value, "ticketId")?,
        text(value, "attemptId")?, text(value, "pinsDigest")?, disposition,
        text(value, "managedOwnerLogId")?, text(value, "managedOwnerLogSequence")?,
        text(value, "managedOwnerLogEventDigest")?, unsigned(value, "managedOwnerRevision")?,
        unsigned(value, "hostOwnerEpoch")?, text(value, "hostProcessIncarnation")?,
        text(value, "noProcessObservationDigest")?, optional_text("attemptDigest")?,
        optional_text("bindingDigest")?,
    )?;
    if proof.proof_digest() != expected_digest {
        return Err(WorkerDurableError::Conflict("managed reconciliation record digest mismatch"));
    }
    Ok(proof)
}

fn managed_worktree_admission_pin_value(pin: &ManagedWorktreeAdmissionPinV1) -> Value {
    json!({
        "worktreeID": pin.worktree_id,
        "baseRevision": pin.base_revision,
        "poolRevision": pin.pool_revision.to_string(),
        "rootLocationID": pin.root_location_id,
        "p8WorkspaceBinding": pin.p8_workspace_binding,
        "childLocationID": pin.child_location_id,
        "childWorkspaceID": pin.child_workspace_id,
        "childWorkspaceRef": pin.child_workspace_ref,
        "childCanonicalRoot": pin.child_canonical_root,
        "childWorkspaceRevision": pin.child_workspace_revision,
    })
}

fn decode_managed_worktree_admission_pin(value: &Value) -> Result<ManagedWorktreeAdmissionPinV1, WorkerDurableError> {
    let pool_revision = text(value, "poolRevision")?.parse::<u64>()
        .map_err(|_| WorkerDurableError::Invalid("invalid managed worktree pool revision"))?;
    if pool_revision.to_string() != text(value, "poolRevision")? {
        return Err(WorkerDurableError::Invalid("managed worktree pool revision is not canonical decimal"));
    }
    let pin = ManagedWorktreeAdmissionPinV1 {
        worktree_id: text(value, "worktreeID")?,
        base_revision: text(value, "baseRevision")?,
        pool_revision,
        root_location_id: text(value, "rootLocationID")?,
        p8_workspace_binding: text(value, "p8WorkspaceBinding")?,
        child_location_id: text(value, "childLocationID")?,
        child_workspace_id: text(value, "childWorkspaceID")?,
        child_workspace_ref: text(value, "childWorkspaceRef")?,
        child_canonical_root: text(value, "childCanonicalRoot")?,
        child_workspace_revision: text(value, "childWorkspaceRevision")?,
    };
    pin.validate()?;
    Ok(pin)
}

fn decode_trusted_pre_admission(value: &Value) -> Result<TrustedPreAdmissionPinsV1, WorkerDurableError> {
    let shape_len = value.as_object().map(|object| object.len());
    let legacy_without_resource_pin = shape_len == Some(25);
    let legacy_without_staged_mode = shape_len == Some(28);
    if !legacy_without_resource_pin && !legacy_without_staged_mode && shape_len != Some(29) {
        return Err(WorkerDurableError::Invalid("invalid pre-admission pin shape"));
    }
    // Existing durable OwnerLog records used this generic name for the
    // profile's permission ceiling. Accept that one historical spelling on
    // replay; new writes always use the semantically precise field name.
    let profile_permission_ceiling_digest = match (
        value.get("profilePermissionCeilingDigest"),
        value.get("permissionScopeDigest"),
    ) {
        (Some(Value::String(digest)), None) | (None, Some(Value::String(digest))) => digest.clone(),
        _ => return Err(WorkerDurableError::Invalid("invalid profile permission-ceiling pin")),
    };
    let owner = rehydrate(&decode_scope(value.get("owner").ok_or(WorkerDurableError::Invalid("missing pre-admission owner"))?)?)?;
    let worktree = value.get("worktree").ok_or(WorkerDurableError::Invalid("missing pinned worktree"))?;
    if worktree.as_object().map(|object| object.len()) != Some(2) {
        return Err(WorkerDurableError::Invalid("invalid pinned worktree shape"));
    }
    let dimension = crate::resource_budget::BudgetDimension::parse_wire(&text(value, "dimension")?)
        .map_err(|_| WorkerDurableError::Invalid("invalid pinned budget dimension"))?;
    let parent_value = value.get("parentProof").ok_or(WorkerDurableError::Invalid("missing parent proof"))?;
    let parent_proof = match text(parent_value, "kind")?.as_str() {
        "ROOT_COORDINATOR" if parent_value.as_object().map(|object| object.len()) == Some(6) => {
            let execution = decode_root_coordinator(parent_value.get("execution").ok_or(WorkerDurableError::Invalid("missing root execution"))?)?;
            let proof = RootCoordinatorExecutionProofV1 {
                execution,
                owner_log_id: text(parent_value, "ownerLogId")?,
                owner_log_sequence: text(parent_value, "ownerLogSequence")?,
                owner_log_event_digest: text(parent_value, "ownerLogEventDigest")?,
                worker_pool_revision: unsigned(parent_value, "workerPoolRevision")?,
            };
            validate_owner_token(&proof.owner_log_id)?;
            validate_owner_digest(&proof.owner_log_event_digest, "blake3:")?;
            if proof.owner_log_sequence.parse::<u64>().is_err() || proof.worker_pool_revision == 0 {
                return Err(WorkerDurableError::Invalid("invalid root parent proof watermark"));
            }
            ManagedParentProofV1::RootCoordinator(proof)
        }
        "CLAIMED_WORKER" if parent_value.as_object().map(|object| object.len()) == Some(11) => {
            let owner = decode_scope(parent_value.get("owner").ok_or(WorkerDurableError::Invalid("missing parent owner"))?)?;
            let proof = DurableParentExecutionProofV1 {
                worker_execution_id: text(parent_value, "workerExecutionId")?,
                goal_id: text(parent_value, "goalId")?,
                owner,
                source_revision: text(parent_value, "sourceRevision")?,
                accepted_spec_digest: text(parent_value, "acceptedSpecDigest")?,
                process_identity: decode_process_identity(parent_value.get("processIdentity").ok_or(WorkerDurableError::Invalid("missing parent process identity"))?)?,
                owner_log_id: text(parent_value, "ownerLogId")?,
                worker_pool_revision: unsigned(parent_value, "workerPoolRevision")?,
                owner_log_sequence: text(parent_value, "ownerLogSequence")?,
                owner_log_event_digest: text(parent_value, "ownerLogEventDigest")?,
            };
            validate_owner_token(&proof.worker_execution_id)?;
            validate_owner_token(&proof.goal_id)?;
            validate_owner_token(&proof.source_revision)?;
            validate_owner_digest(&proof.accepted_spec_digest, "blake3:")?;
            validate_owner_token(&proof.owner_log_id)?;
            validate_owner_digest(&proof.owner_log_event_digest, "blake3:")?;
            if proof.owner_log_sequence.parse::<u64>().is_err() || proof.worker_pool_revision == 0 {
                return Err(WorkerDurableError::Invalid("invalid claimed parent proof watermark"));
            }
            ManagedParentProofV1::ClaimedWorker(proof)
        }
        _ => return Err(WorkerDurableError::Invalid("invalid managed parent proof")),
    };
    let pins = TrustedPreAdmissionPinsV1 {
        owner,
        goal_id: text(value, "goalId")?,
        task_revision: text(value, "taskRevision")?,
        task_attempt_count: text(value, "taskAttemptCount")?.parse()
            .map_err(|_| WorkerDurableError::Invalid("invalid pinned Task attempt count"))?,
        candidate_generation: text(value, "candidateGeneration")?.parse()
            .map_err(|_| WorkerDurableError::Invalid("invalid pinned candidate generation"))?,
        accepted_spec_digest: text(value, "acceptedSpecDigest")?,
        workspace_revision: text(value, "workspaceRevision")?,
        location_id: text(value, "locationId")?,
        process_incarnation: text(value, "processIncarnation")?,
        profile_id: text(value, "profileId")?,
        profile_revision: text(value, "profileRevision")?.parse().map_err(|_| WorkerDurableError::Invalid("invalid pinned profile revision"))?,
        profile_digest: text(value, "profileDigest")?,
        profile_permission_ceiling_digest,
        context_selection_digest: match value.get("contextSelectionDigest") {
            Some(Value::String(digest)) => Some(digest.clone()),
            Some(Value::Null) if shape_len == Some(29) => None,
            _ => return Err(WorkerDurableError::Invalid("invalid pre-admission ContextSelection digest")),
        },
        accepted_scope_digest: text(value, "acceptedScopeDigest")?,
        capability_ceiling_digest: text(value, "capabilityCeilingDigest")?,
        spec_max_workers: text(value, "specMaxWorkers")?.parse()
            .map_err(|_| WorkerDurableError::Invalid("invalid Spec maxWorkers pin"))?,
        resource_policy_revision: if legacy_without_resource_pin {
            0
        } else {
            parse_canonical_owner_u64(&text(value, "resourcePolicyRevision")?)
                .ok_or(WorkerDurableError::Invalid("invalid resource policy revision pin"))?
        },
        resource_policy_digest: if legacy_without_resource_pin {
            String::new()
        } else {
            text(value, "resourcePolicyDigest")?
        },
        resource_active_worker_limit: if legacy_without_resource_pin {
            None
        } else {
            optional_text(value, "resourceActiveWorkerLimit")?
                .map(|raw| parse_canonical_owner_u64(&raw)
                    .ok_or(WorkerDurableError::Invalid("invalid active-worker resource limit pin")))
                .transpose()?
        },
        dimension,
        amount: unsigned(value, "amount")?,
        expires_at_ms: unsigned(value, "expiresAtMs")?,
        worktree: crate::worker_pool::WorktreeBindingRequest {
            worktree_id: text(worktree, "worktreeId")?,
            base_revision: text(worktree, "baseRevision")?,
        },
        worktree_pool_revision: text(value, "worktreePoolRevision")?.parse()
            .map_err(|_| WorkerDurableError::Invalid("invalid worktree pool revision pin"))?,
        idempotency_key: text(value, "idempotencyKey")?,
        parent_proof,
        staged_pre_admission: if shape_len == Some(29) {
            value.get("stagedPreAdmission").and_then(Value::as_bool)
                .ok_or(WorkerDurableError::Invalid("invalid staged pre-admission mode"))?
        } else { false },
        pins_digest: text(value, "pinsDigest")?,
    };
    pins.validate()?;
    Ok(pins)
}

fn pre_admission_ids(pins: &TrustedPreAdmissionPinsV1) -> (String, String, String) {
    let suffix = pins.pins_digest.strip_prefix("blake3:").unwrap_or_default();
    (
        format!("worker-ticket-{}", suffix),
        format!("worker-execution-{}", suffix),
        format!("worker-pre-admission-{}", suffix),
    )
}

fn pre_admission_parent_execution_id(pins: &TrustedPreAdmissionPinsV1) -> String {
    match &pins.parent_proof {
        ManagedParentProofV1::RootCoordinator(proof) => proof.worker_execution_id().to_owned(),
        ManagedParentProofV1::ClaimedWorker(proof) => proof.worker_execution_id().to_owned(),
    }
}

fn pre_admission_request(
    pins: &TrustedPreAdmissionPinsV1,
) -> Result<(String, String, EnqueueRequest), WorkerDurableError> {
    let (ticket_id, worker_execution_id, _) = pre_admission_ids(pins);
    let parent_execution = match &pins.parent_proof {
        ManagedParentProofV1::RootCoordinator(_) => None,
        ManagedParentProofV1::ClaimedWorker(proof) => Some(proof.child_lineage()?),
    };
    let request = EnqueueRequest {
        ticket_id: ticket_id.clone(),
        goal_id: pins.goal_id.clone(),
        idempotency_key: pins.idempotency_key.clone(),
        dimension: pins.dimension,
        amount: pins.amount,
        expires_at_ms: pins.expires_at_ms,
        expected_task_revision: pins.task_revision.clone(),
        accepted_spec_digest: pins.accepted_spec_digest.clone(),
        class: WorkerClass::IsolatedEffectful,
        worktree: Some(pins.worktree.clone()),
        parent_execution,
    };
    Ok((ticket_id, worker_execution_id, request))
}

fn validate_pre_admission_request(
    pins: &TrustedPreAdmissionPinsV1,
    request: &EnqueueRequest,
    ticket_id: &str,
    worker_execution_id: &str,
) -> Result<(), WorkerDurableError> {
    pins.validate()?;
    let (expected_ticket, expected_worker, _) = pre_admission_ids(pins);
    let expected_parent = match &pins.parent_proof {
        ManagedParentProofV1::RootCoordinator(_) => None,
        ManagedParentProofV1::ClaimedWorker(proof) => Some(proof.child_lineage()?),
    };
    if ticket_id != expected_ticket || worker_execution_id != expected_worker
        || request.ticket_id != ticket_id || request.goal_id != pins.goal_id
        || request.idempotency_key != pins.idempotency_key
        || request.dimension != pins.dimension || request.amount != pins.amount
        || request.expires_at_ms != pins.expires_at_ms
        || request.expected_task_revision != pins.task_revision
        || request.accepted_spec_digest != pins.accepted_spec_digest
        || request.class != WorkerClass::IsolatedEffectful
        || request.worktree.as_ref() != Some(&pins.worktree)
        || request.parent_execution != expected_parent
    {
        return Err(WorkerDurableError::Conflict("pre-admission request differs from trusted pins"));
    }
    Ok(())
}
fn admission_pins_value(pins: &WorkerAdmissionPinsV1) -> Value {
    json!({
        "owner": scope_value(&pins.owner), "goalId": pins.goal_id,
        "sourceRevision": pins.source_revision, "acceptedSpecDigest": pins.accepted_spec_digest,
        "locationId": pins.location_id, "processIncarnation": pins.process_incarnation,
        "profileId": pins.profile_id, "profileRevision": pins.profile_revision.to_string(),
        "profileDigest": pins.profile_digest, "contextSelectionDigest": pins.context_selection_digest,
        "acceptedScopeDigest": pins.accepted_scope_digest,
        "capabilityCeilingDigest": pins.capability_ceiling_digest,
    })
}

fn decode_admission_pins(value: &Value) -> Result<WorkerAdmissionPinsV1, WorkerDurableError> {
    if value.as_object().map(|v| v.len()) != Some(12) {
        return Err(WorkerDurableError::Invalid("invalid admission pin shape"));
    }
    let pins = WorkerAdmissionPinsV1 {
        owner: decode_scope(value.get("owner").ok_or(WorkerDurableError::Invalid("missing pin owner"))?)?,
        goal_id: text(value, "goalId")?, source_revision: text(value, "sourceRevision")?,
        accepted_spec_digest: text(value, "acceptedSpecDigest")?, location_id: text(value, "locationId")?,
        process_incarnation: text(value, "processIncarnation")?, profile_id: text(value, "profileId")?,
        profile_revision: text(value, "profileRevision")?.parse()
            .map_err(|_| WorkerDurableError::Invalid("invalid profile revision"))?,
        profile_digest: text(value, "profileDigest")?, context_selection_digest: text(value, "contextSelectionDigest")?,
        accepted_scope_digest: text(value, "acceptedScopeDigest")?, capability_ceiling_digest: text(value, "capabilityCeilingDigest")?,
    };
    pins.validate()?;
    Ok(pins)
}

fn root_execution_from_pins(
    pins: &WorkerAdmissionPinsV1,
    process: &ProcessIdentity,
    expires_at_ms: u64,
) -> RootCoordinatorExecutionV1 {
    // Length-prefix each field so embedded separators cannot alias identities.
    // No task/attempt enters this key: it is one coordinator per Session/Run.
    let mut preimage = b"horizoncode.root-coordinator-execution.v1\0".to_vec();
    for value in [&pins.goal_id, &pins.owner.run_id, &pins.owner.principal_ref,
        &pins.owner.workspace_binding, &pins.owner.session_id, &pins.location_id,
        &pins.process_incarnation] {
        preimage.extend_from_slice(&(value.len() as u64).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    }
    preimage.extend_from_slice(&pins.owner.owner_epoch.to_be_bytes());
    preimage.extend_from_slice(&process.pid.to_be_bytes());
    preimage.extend_from_slice(&process.start_identity.to_be_bytes());
    RootCoordinatorExecutionV1 {
        worker_execution_id: format!("root-{}", blake3::hash(&preimage).to_hex()),
        goal_id: pins.goal_id.clone(), run_id: pins.owner.run_id.clone(),
        principal_ref: pins.owner.principal_ref.clone(), workspace_binding: pins.owner.workspace_binding.clone(),
        session_id: pins.owner.session_id.clone(), location_id: pins.location_id.clone(),
        owner_epoch: pins.owner.owner_epoch, process_incarnation: pins.process_incarnation.clone(),
        process_identity: process.clone(), source_revision: pins.source_revision.clone(),
        accepted_spec_digest: pins.accepted_spec_digest.clone(), expires_at_ms,
    }
}

fn root_execution_from_registration_pins(
    pins: &RootCoordinatorRegistrationPinsV1,
    expires_at_ms: u64,
) -> RootCoordinatorExecutionV1 {
    let mut preimage = b"horizoncode.root-coordinator-execution.v1\0".to_vec();
    for value in [pins.goal_id(), pins.run_id(), pins.principal_ref(), pins.workspace_binding(),
        pins.session_id(), pins.location_id(), pins.process_incarnation()] {
        preimage.extend_from_slice(&(value.len() as u64).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    }
    preimage.extend_from_slice(&pins.owner_epoch().to_be_bytes());
    preimage.extend_from_slice(&pins.process_identity().pid.to_be_bytes());
    preimage.extend_from_slice(&pins.process_identity().start_identity.to_be_bytes());
    RootCoordinatorExecutionV1 {
        worker_execution_id: format!("root-{}", blake3::hash(&preimage).to_hex()),
        goal_id: pins.goal_id().to_owned(), run_id: pins.run_id().to_owned(),
        principal_ref: pins.principal_ref().to_owned(), workspace_binding: pins.workspace_binding().to_owned(),
        session_id: pins.session_id().to_owned(), location_id: pins.location_id().to_owned(),
        owner_epoch: pins.owner_epoch(), process_incarnation: pins.process_incarnation().to_owned(),
        process_identity: pins.process_identity().clone(), source_revision: pins.source_revision().to_owned(),
        accepted_spec_digest: pins.accepted_spec_digest().to_owned(), expires_at_ms,
    }
}

fn root_coordinator_value(root: &RootCoordinatorExecutionV1) -> Value {
    json!({
        "workerExecutionId": root.worker_execution_id, "goalId": root.goal_id, "runId": root.run_id,
        "principalRef": root.principal_ref, "workspaceBinding": root.workspace_binding,
        "sessionId": root.session_id, "locationId": root.location_id,
        "ownerEpoch": root.owner_epoch, "processIncarnation": root.process_incarnation,
        "processIdentity": process_identity_value(&root.process_identity),
        "sourceRevision": root.source_revision, "acceptedSpecDigest": root.accepted_spec_digest,
        "expiresAtMs": root.expires_at_ms,
    })
}

fn root_execution_digest(root: &RootCoordinatorExecutionV1) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"horizoncode.root-coordinator-execution-digest.v1\0");
    for value in [root.worker_execution_id.as_str(), root.goal_id.as_str(), root.run_id.as_str(),
        root.principal_ref.as_str(), root.workspace_binding.as_str(), root.session_id.as_str(),
        root.location_id.as_str(), root.process_incarnation.as_str(), root.source_revision.as_str(),
        root.accepted_spec_digest.as_str()] {
        append_digest_field(&mut h, value);
    }
    h.update(&root.owner_epoch.to_be_bytes());
    h.update(&root.process_identity.pid.to_be_bytes());
    h.update(&root.process_identity.start_identity.to_be_bytes());
    h.update(&root.expires_at_ms.to_be_bytes());
    format!("blake3:{}", h.finalize().to_hex())
}

fn decode_root_coordinator(value: &Value) -> Result<RootCoordinatorExecutionV1, WorkerDurableError> {
    if value.as_object().map(|v| v.len()) != Some(13) {
        return Err(WorkerDurableError::Invalid("invalid root coordinator shape"));
    }
    let root = RootCoordinatorExecutionV1 {
        worker_execution_id: text(value, "workerExecutionId")?, goal_id: text(value, "goalId")?,
        run_id: text(value, "runId")?, principal_ref: text(value, "principalRef")?,
        workspace_binding: text(value, "workspaceBinding")?, session_id: text(value, "sessionId")?,
        location_id: text(value, "locationId")?, owner_epoch: unsigned(value, "ownerEpoch")?,
        process_incarnation: text(value, "processIncarnation")?,
        process_identity: decode_process_identity(value.get("processIdentity")
            .ok_or(WorkerDurableError::Invalid("missing root process identity"))?)?,
        source_revision: text(value, "sourceRevision")?, accepted_spec_digest: text(value, "acceptedSpecDigest")?,
        expires_at_ms: unsigned(value, "expiresAtMs")?,
    };
    validate_root_execution(&root)?;
    Ok(root)
}

fn validate_root_execution(root: &RootCoordinatorExecutionV1) -> Result<(), WorkerDurableError> {
    for value in [&root.worker_execution_id, &root.goal_id, &root.run_id, &root.principal_ref,
        &root.workspace_binding, &root.session_id, &root.location_id, &root.process_incarnation,
        &root.source_revision] {
        validate_owner_token(value)?;
    }
    validate_owner_digest(&root.accepted_spec_digest, "blake3:")?;
    if root.owner_epoch == 0 || root.process_identity.pid == 0
        || root.process_identity.start_identity == 0 || root.expires_at_ms == 0
        || !root.principal_ref.starts_with("server_auth:")
        || !root.worker_execution_id.starts_with("root-")
    {
        return Err(WorkerDurableError::Invalid("invalid root coordinator identity"));
    }
    Ok(())
}

fn worktree_root_owner_matches_execution(
    owner: &WorktreeRootOwnerV1,
    root: &RootCoordinatorExecutionV1,
) -> bool {
    owner.coordinator_id() == root.worker_execution_id
        && owner.goal_id() == root.goal_id
        && owner.run_id() == root.run_id
        && owner.principal_ref() == root.principal_ref
        && owner.workspace_binding() == root.workspace_binding
        && owner.session_id() == root.session_id
        && owner.location_id() == root.location_id
        && owner.owner_epoch() == root.owner_epoch
        && owner.process_incarnation() == root.process_incarnation
        && owner.process_identity() == &root.process_identity
        && owner.accepted_spec_digest() == root.accepted_spec_digest
}

fn worktree_root_owner_matches_execution_fields(
    proof: &RootCoordinatorExecutionProofV1,
    root: &RootCoordinatorExecutionV1,
) -> bool {
    proof.worker_execution_id() == root.worker_execution_id
        && proof.goal_id() == root.goal_id
        && proof.run_id() == root.run_id
        && proof.principal_ref() == root.principal_ref
        && proof.workspace_binding() == root.workspace_binding
        && proof.session_id() == root.session_id
        && proof.location_id() == root.location_id
        && proof.owner_epoch() == root.owner_epoch
        && proof.process_incarnation() == root.process_incarnation
        && proof.process_identity() == &root.process_identity
        && proof.source_revision() == root.source_revision
        && proof.accepted_spec_digest() == root.accepted_spec_digest
}

fn worktree_removal_digest(
    owner: &WorktreeRootOwnerV1,
    worktree_id: &str,
    operation_id: &str,
    receipt_ref: &str,
    registration_digest: &str,
) -> String {
    let mut bytes = b"horizoncode.worktree-registration-removal.v1\0".to_vec();
    for value in [owner.root_digest(), worktree_id, operation_id, receipt_ref, registration_digest] {
        bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    format!("blake3:{}", blake3::hash(&bytes).to_hex())
}

fn same_worktree_root_lineage(old: &WorktreeRootOwnerV1, current: &WorktreeRootOwnerV1) -> bool {
    old.goal_id() == current.goal_id()
        && old.run_id() == current.run_id()
        && old.principal_ref() == current.principal_ref()
        && old.workspace_binding() == current.workspace_binding()
        && old.session_id() == current.session_id()
        && old.location_id() == current.location_id()
        && old.accepted_spec_digest() == current.accepted_spec_digest()
}

fn worktree_operation_id(
    owner: &WorktreeRootOwnerV1,
    kind: WorktreeOperationKindV1,
    idempotency_key: &str,
) -> String {
    let kind = match kind {
        WorktreeOperationKindV1::Create => b"CREATE".as_slice(),
        WorktreeOperationKindV1::Inspect => b"INSPECT".as_slice(),
        WorktreeOperationKindV1::Release => b"RELEASE".as_slice(),
    };
    let mut bytes = b"horizoncode.worktree-operation-id.v1\0".to_vec();
    for value in [owner.root_digest().as_bytes(), kind, idempotency_key.as_bytes()] {
        bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
        bytes.extend_from_slice(value);
    }
    format!("wtop_{}", blake3::hash(&bytes).to_hex())
}

fn quarantined_reconciliation_inspect_key(attempt_id: &str, owner_epoch: u64, owner_log_sequence: &str) -> String {
    format!("managed-reconcile-inspect-{attempt_id}-{owner_epoch}-{owner_log_sequence}")
}

fn settled_reconciliation_inspect_key(attempt_id: &str, owner_epoch: u64, owner_log_sequence: &str) -> String {
    format!("managed-settlement-reconcile-inspect-{attempt_id}-{owner_epoch}-{owner_log_sequence}")
}

fn managed_final_inspect_idempotency_key(attempt_id: &str) -> String {
    format!("managed-final-inspect-{attempt_id}")
}

fn worktree_candidate_id(operation_id: &str) -> String {
    let mut bytes = b"horizoncode.worktree-candidate-id.v1\0".to_vec();
    bytes.extend_from_slice(&(operation_id.len() as u64).to_be_bytes());
    bytes.extend_from_slice(operation_id.as_bytes());
    format!("wt_{}", blake3::hash(&bytes).to_hex())
}

fn apply_worker_identity_command(
    journal: &mut WorkerIdentityJournalV1,
    pool: &WorkerPool,
    worktree_operations: &WorktreeOperationJournalV1,
    settlement_receipts: &BTreeMap<String, WorkerSettlementReceiptV1>,
    command: &WorkerCommand,
) -> Result<(), WorkerDurableError> {
    match command {
        WorkerCommand::RegisterWorktree { owner, registration } => {
            if registration.owner() != owner
                || !journal.root_coordinators.get(owner.coordinator_id())
                    .is_some_and(|root| worktree_root_owner_matches_execution(owner, root))
                || journal.removed_worktree_registrations.contains_key(&registration.registration().id)
            {
                return Err(WorkerDurableError::Conflict("worktree registration owner mismatch"));
            }
            if let Some(digest) = registration.verification_digest() {
                validate_owner_digest(digest, "blake3:")?;
                if !registration.matches_durable_operations(worktree_operations) {
                    return Err(WorkerDurableError::Conflict(
                        "worktree registration does not match its durable guarded Create/Inspect receipts",
                    ));
                }
                let id = registration.registration().id.clone();
                if let Some(existing) = journal.verified_worktree_registrations.get(&id) {
                    if existing != digest {
                        return Err(WorkerDurableError::Conflict("worktree verification provenance changed"));
                    }
                } else {
                    journal.verified_worktree_registrations.insert(id, digest.to_owned());
                    journal.worktree_registration_records.insert(
                        registration.registration().id.clone(), registration.clone(),
                    );
                }
            }
        }
        WorkerCommand::LegacyRegisterWorktree { .. } => {}
        WorkerCommand::WorktreeRegistrationRemoved { owner, operation_id, worktree_id } => {
            let record = worktree_operations.get(operation_id).ok_or(
                WorkerDurableError::NotFound("worktree release operation is not durable"),
            )?;
            if !worktree_operations.is_release_safe(operation_id)
                || record.intent().owner() != owner
                || record.intent().worktree_id() != worktree_id
                || !journal.root_coordinators.get(owner.coordinator_id())
                    .is_some_and(|root| worktree_root_owner_matches_execution(owner, root))
            {
                return Err(WorkerDurableError::Conflict("worktree tombstone lacks exact release proof"));
            }
            let registration_digest = journal.verified_worktree_registrations.remove(worktree_id)
                .ok_or(WorkerDurableError::NotFound("verified worktree registration missing"))?;
            let receipt = record.receipt().ok_or(WorkerDurableError::NotFound("release receipt missing"))?;
            let tombstone_digest = worktree_removal_digest(
                owner, worktree_id, operation_id, receipt.host_receipt_ref(), &registration_digest,
            );
            if journal.removed_worktree_registrations.insert(worktree_id.clone(), tombstone_digest).is_some() {
                return Err(WorkerDurableError::Conflict("worktree ID already tombstoned"));
            }
        }
        WorkerCommand::AdmissionPinsRecorded { worker_execution_id, pins } => {
            pins.validate()?;
            let worker = pool.worker(worker_execution_id).ok_or(WorkerDurableError::NotFound("worker pin target missing"))?;
            let ticket = pool.ticket(&worker.ticket_id).ok_or(WorkerDurableError::NotFound("worker pin ticket missing"))?;
            if worker.state != crate::resource_budget::ReservationState::Reserved
                || worker.class != WorkerClass::IsolatedEffectful
                || worker.cancellation_requested || worker.unknown_effect
                || worker.owner != pins.owner || worker.goal_id != pins.goal_id
                || ticket.expected_task_revision != pins.source_revision
                || ticket.accepted_spec_digest != pins.accepted_spec_digest
                || pool.owner_epoch() != pins.owner.owner_epoch
            {
                return Err(WorkerDurableError::Conflict("worker pin state or scope mismatch"));
            }
            if let Some(existing) = journal.admission_pins.get(worker_execution_id) {
                if existing != pins { return Err(WorkerDurableError::Conflict("immutable worker pins changed")); }
            } else {
                if journal.admission_pins.len() >= crate::worker_pool::MAX_WORKER_RECORDS {
                    return Err(WorkerDurableError::Invalid("worker pin history full"));
                }
                journal.admission_pins.insert(worker_execution_id.clone(), pins.clone());
            }
        }
        WorkerCommand::PreAdmissionReserved { pins, request, ticket_id, worker_execution_id, .. } => {
            pins.validate()?;
                validate_pre_admission_request(pins, request, ticket_id, worker_execution_id)
                    .map_err(|_| WorkerPoolError::InvalidRequest)?;
            if journal.pre_admission_pins.iter().any(|(existing_worker_id, existing)|
                existing_worker_id != worker_execution_id
                    && existing.attempt_id() == pins.attempt_id()
                    && existing != pins)
            {
                return Err(WorkerDurableError::Conflict(
                    "candidate Attempt ID is already pinned to different pre-admission facts",
                ));
            }
            let worker = pool.worker(worker_execution_id).ok_or(WorkerDurableError::NotFound("pre-admission worker missing"))?;
            let ticket = pool.ticket(ticket_id).ok_or(WorkerDurableError::NotFound("pre-admission ticket missing"))?;
            if worker.state != crate::resource_budget::ReservationState::Reserved
                || worker.class != WorkerClass::IsolatedEffectful
                || worker.owner != OwnerScopeKey::from_owner(pins.owner())
                || worker.goal_id != pins.goal_id
                || ticket.expected_task_revision != pins.workspace_revision
                || ticket.accepted_spec_digest != pins.accepted_spec_digest
                || worker.worktree_lease_id.is_none()
                || ticket.state != crate::worker_pool::TicketState::Consumed
                || ticket.worker_execution_id.as_deref() != Some(worker_execution_id)
            {
                return Err(WorkerDurableError::Conflict("pre-admission reservation differs from pins"));
            }
            let worktree = request.worktree.as_ref().ok_or(WorkerDurableError::Conflict(
                "managed child reservation has no isolated worktree",
            ))?;
            let registration = journal.worktree_registration_records.get(&worktree.worktree_id)
                .ok_or(WorkerDurableError::Conflict("managed child worktree is not registered from guarded evidence"))?;
            let root_owner = registration.owner();
            if journal.removed_worktree_registrations.contains_key(&worktree.worktree_id)
                || registration.verification_digest() != Some(
                    journal.verified_worktree_registrations.get(&worktree.worktree_id)
                        .map(String::as_str).unwrap_or_default(),
                )
                || root_owner.goal_id() != pins.goal_id()
                || root_owner.run_id() != pins.run_id()
                || root_owner.principal_ref() != pins.principal_ref()
                || root_owner.workspace_binding() != pins.workspace_binding()
                // Historical nested records may have no root Session lineage
                // projection. Replay preserves committed facts, while live
                // `validate_managed_parent_pin` now denies new nested admission.
                || managed_root_session_id(pins.parent_proof())
                    .is_ok_and(|root_session_id| root_owner.session_id() != root_session_id)
                || root_owner.location_id() != pins.location_id()
                || root_owner.owner_epoch() != pins.owner_epoch()
                || root_owner.process_incarnation() != pins.process_incarnation()
                || root_owner.accepted_spec_digest() != pins.accepted_spec_digest()
                || worktree.base_revision != registration.registration().base_revision
                || registration.registration().observed_revision.as_deref() != Some(pins.workspace_revision())
                || !registration.matches_durable_operations(worktree_operations)
            {
                return Err(WorkerDurableError::Conflict(
                    "managed child worktree is stale, shared, tombstoned or outside exact Run pins",
                ));
            }
            if let Some(existing) = journal.pre_admission_pins.get(worker_execution_id) {
                if existing != pins {
                    return Err(WorkerDurableError::Conflict("pre-admission pins are immutable"));
                }
            } else {
                if journal.pre_admission_pins.len() >= crate::worker_pool::MAX_WORKER_RECORDS {
                    return Err(WorkerDurableError::Invalid("pre-admission pin history full"));
                }
                journal.pre_admission_pins.insert(worker_execution_id.clone(), pins.clone());
            }
        }
        WorkerCommand::PreAdmissionContextBound { worker_execution_id, ticket_id, pins } => {
            pins.validate()?;
            let existing = journal.pre_admission_pins.get(worker_execution_id)
                .ok_or(WorkerDurableError::ReplayConflict("context bind has no Stage-A pin record"))?;
            let worker = pool.worker(worker_execution_id)
                .ok_or(WorkerDurableError::ReplayConflict("context bind worker is missing"))?;
            let (expected_ticket, expected_worker, _) = pre_admission_ids(pins);
            let mut pre_context = pins.clone();
            pre_context.context_selection_digest = None;
            pre_context.pins_digest = pre_context.compute_digest();
            if !pins.staged_pre_admission || pins.context_selection_digest.is_none()
                || expected_worker != *worker_execution_id || expected_ticket != *ticket_id
                || &pre_context != existing
                || existing.context_selection_digest.is_some() && existing != pins
                || worker.state != crate::resource_budget::ReservationState::Reserved
                || worker.cancellation_requested || worker.unknown_effect
                || worker.process_identity.is_some()
                || journal.delegation_bindings.contains_key(worker_execution_id)
            {
                return Err(WorkerDurableError::ReplayConflict(
                    "ContextSelection bind is not an immutable Stage-A transition",
                ));
            }
            if existing != pins {
                journal.pre_admission_pins.insert(worker_execution_id.clone(), pins.clone());
            }
        }
        WorkerCommand::PreAdmissionReconciled { proof } => {
            proof.validate()?;
            let pins = journal.pre_admission_pins.get(proof.worker_execution_id())
                .ok_or(WorkerDurableError::Conflict("reconciliation candidate pins unavailable"))?;
            let worker = pool.worker(proof.worker_execution_id())
                .ok_or(WorkerDurableError::NotFound("reconciliation worker unavailable"))?;
            if pins.attempt_id() != proof.attempt_id() || pins.pins_digest() != proof.pins_digest()
                || worker.state != crate::resource_budget::ReservationState::Expired
                || worker.process_identity.is_some()
            {
                return Err(WorkerDurableError::Conflict("reconciled worker state differs from proof"));
            }
            match proof.disposition() {
                ManagedReservationReconciliationDispositionV1::NotAdmittedNoDispatch
                    if !journal.delegation_bindings.contains_key(proof.worker_execution_id()) => {}
                ManagedReservationReconciliationDispositionV1::TerminalNoEffect
                    if journal.delegation_bindings.get(proof.worker_execution_id())
                        .is_some_and(|binding| Some(binding.binding_digest.as_str()) == proof.binding_digest()) => {}
                _ => return Err(WorkerDurableError::Conflict("reconciliation proof/binding mismatch")),
            }
        }
        WorkerCommand::ClaimWorker { worker_execution_id, .. }
            if journal.pre_admission_pins.contains_key(worker_execution_id) =>
        {
            let worker = pool.worker(worker_execution_id)
                .ok_or(WorkerDurableError::NotFound("claimed managed worker missing"))?;
            let pins = journal.pre_admission_pins.get(worker_execution_id)
                .expect("guard checked managed pre-admission pins");
            if !journal.delegation_bindings.contains_key(worker_execution_id)
                || worker.state != crate::resource_budget::ReservationState::Claimed
                || worker.owner != OwnerScopeKey::from_owner(pins.owner())
                || worker.cancellation_requested || worker.unknown_effect
                || worker.process_identity.is_some()
            {
                return Err(WorkerDurableError::Conflict(
                    "managed claim requires the exact attached binding and unbound current worker",
                ));
            }
        }
        WorkerCommand::ManagedLogicalSettled { event } => {
            let pins = journal.pre_admission_pins.get(&event.worker_execution_id)
                .ok_or(WorkerDurableError::ReplayConflict("managed settlement has no immutable pre-admission pins"))?;
            let binding = journal.delegation_bindings.get(&event.worker_execution_id)
                .ok_or(WorkerDurableError::ReplayConflict("managed settlement has no attached DelegationBinding"))?;
            let claim = journal.claim_receipts.get(&event.worker_execution_id)
                .ok_or(WorkerDurableError::ReplayConflict("managed settlement has no durable claim"))?;
            if pins.attempt_id() != event.attempt_id
                || pins.pins_digest() != claim.pins_digest
                || binding.binding_digest != claim.binding_digest
                || claim.attempt_id != event.attempt_id
                || event.proof_digest.len() != 71 || !event.proof_digest.starts_with("blake3:")
                || match event.reconciliation_owner_epoch {
                    Some(epoch) => epoch != pool.owner_epoch() || epoch < pins.owner_epoch(),
                    None => pins.owner_epoch() != pool.owner_epoch(),
                }
                || pool.worker(&event.worker_execution_id).is_none_or(|worker|
                    worker.state != crate::resource_budget::ReservationState::Released
                        || worker.process_identity.is_some())
            {
                return Err(WorkerDurableError::ReplayConflict("managed settlement differs from claimed P8 identity"));
            }
            // New successful settlement events carry the verifier ChallengeSet
            // identity. Revalidate the final Inspect against that durable
            // event during replay too; a receipt that was dirty outside the
            // Attempt's ownership or contained user changes cannot release
            // successful worker capacity after a restart.
            if event.verification_run_id.is_some()
                || event.set_identity_digest.is_some()
                || event.challenge_set_digest.is_some()
            {
                let operation_id = event.final_worktree_operation_id.as_deref().ok_or(
                    WorkerDurableError::ReplayConflict(
                        "verified settlement event has no final Inspect operation",
                    ),
                )?;
                let operation = worktree_operations.get(operation_id).ok_or(
                    WorkerDurableError::ReplayConflict(
                        "verified settlement final Inspect operation is missing",
                    ),
                )?;
                let receipt = operation.receipt().ok_or(
                    WorkerDurableError::ReplayConflict(
                        "verified settlement final Inspect receipt is missing",
                    ),
                )?;
                if event.verification_run_id.as_deref().is_none_or(str::is_empty)
                    || event.set_identity_digest.as_deref()
                        .is_none_or(|digest| !valid_digest(digest, "blake3:"))
                    || event.challenge_set_digest.as_deref()
                        .is_none_or(|digest| !valid_digest(digest, "blake3:"))
                    || !final_inspect_allows_verified_settlement(receipt)
                    || event.final_worktree_host_receipt_ref.as_deref()
                        != Some(receipt.host_receipt_ref())
                    || event.observed_workspace_revision.as_deref()
                        != Some(receipt.observed_workspace_revision())
                {
                    return Err(WorkerDurableError::ReplayConflict(
                        "verified settlement event lacks an attributable final Inspect receipt",
                    ));
                }
            }
        }
        WorkerCommand::ManagedWorktreeDisposition { event } => {
            let settlement = settlement_receipts.get(&event.worker_execution_id).ok_or(
                WorkerDurableError::ReplayConflict("worktree disposition has no preceding settlement receipt"),
            )?;
            let pins = journal.pre_admission_pins.get(&event.worker_execution_id).ok_or(
                WorkerDurableError::ReplayConflict("worktree disposition has no immutable P8 admission pins"),
            )?;
            let operation = worktree_operations.get(&event.final_worktree_operation_id).ok_or(
                WorkerDurableError::ReplayConflict("worktree disposition Inspect operation is missing"),
            )?;
            let receipt = operation.receipt().ok_or(
                WorkerDurableError::ReplayConflict("worktree disposition Inspect receipt is missing"),
            )?;
            let expected_receipt_digest = logical_command_digest(
                "worker_final_inspect_receipt", &worktree_receipt_value(receipt),
            );
            let expected_reusable = receipt.status() == WorktreeObservedStatusV1::Clean
                && receipt.dirty_entry_count() == 0
                && !receipt.contains_user_owned_changes()
                && receipt.owned() && receipt.no_follow();
            let worker = pool.worker(&event.worker_execution_id).ok_or(
                WorkerDurableError::ReplayConflict("worktree disposition worker is missing"),
            )?;
            if settlement.attempt_id() != event.attempt_id
                || !settlement.disposition_deferred()
                || event.owner_epoch != pins.owner_epoch()
                || settlement.receipt_digest() != event.settlement_receipt_digest
            || match event.reconciliation_owner_epoch {
                Some(epoch) => {
                    let legacy_reconciliation = event.reconciliation_proof_digest.is_none()
                        && settlement.reconciliation_owner_epoch() == Some(epoch)
                        && settlement.final_worktree_operation_id() == Some(event.final_worktree_operation_id.as_str())
                        && settlement.final_worktree_host_receipt_ref() == Some(event.final_worktree_host_receipt_ref.as_str())
                        && settlement.final_workspace_revision() == Some(event.observed_workspace_revision.as_str());
                    (!legacy_reconciliation && event.reconciliation_proof_digest.as_deref().is_none_or(|digest|
                        !valid_digest(digest, "blake3:"))) || epoch != pool.owner_epoch()
                        || epoch <= event.owner_epoch || operation.intent().owner_epoch() != epoch
                        || (event.reconciliation_proof_digest.is_some()
                            && (settlement.reconciliation_owner_epoch().is_some()
                                || settlement.disposition() != WorkerManagedSettlementDispositionV1::Released
                                || settlement.verification_run_id().is_none()
                                || settlement.set_identity_digest().is_none()
                                || settlement.challenge_set_digest().is_none()
                                || !final_inspect_allows_verified_settlement(receipt)
                                || operation.intent().worktree_id() != pins.worktree.worktree_id
                                || operation.intent().base_revision() != Some(pins.worktree.base_revision.as_str())
                                || operation.intent().owner().workspace_binding() != pins.workspace_binding()
                                || operation.intent().owner().location_id() != pins.location_id()
                                || operation.intent().expected_workspace_revision() != event.observed_workspace_revision))
                        || (event.reconciliation_proof_digest.is_some()
                            && operation.intent().operation_id() != worktree_operation_id(
                                operation.intent().owner(), WorktreeOperationKindV1::Inspect,
                                &settled_reconciliation_inspect_key(
                                    &event.attempt_id, epoch, operation.intent().owner_log_sequence(),
                                ),
                            ))
                }
                None => event.reconciliation_proof_digest.is_some()
                    || settlement.final_worktree_operation_id() != Some(event.final_worktree_operation_id.as_str())
                    || settlement.final_worktree_host_receipt_ref() != Some(event.final_worktree_host_receipt_ref.as_str())
                    || settlement.final_workspace_revision() != Some(event.observed_workspace_revision.as_str()),
            }
                || expected_receipt_digest != event.inspect_receipt_digest
                || receipt.operation_id() != event.final_worktree_operation_id
                || receipt.host_receipt_ref() != event.final_worktree_host_receipt_ref
                || receipt.observed_workspace_revision() != event.observed_workspace_revision
                || matches!(receipt.status(), WorktreeObservedStatusV1::Missing | WorktreeObservedStatusV1::Unknown)
                || event.reusable_worktree != expected_reusable
                || worker.owner.attempt_id != event.attempt_id
                || worker.state != crate::resource_budget::ReservationState::Released
                || worker.process_identity.is_some()
                || worker.worktree_lease_id.is_none()
                || match event.reconciliation_owner_epoch {
                    Some(epoch) => epoch != pool.owner_epoch() || epoch < event.owner_epoch,
                    None => event.owner_epoch != pool.owner_epoch(),
                }
            {
                return Err(WorkerDurableError::ReplayConflict(
                    "worktree disposition does not match exact settlement and final Inspect receipts",
                ));
            }
        }
        WorkerCommand::ExpireUnlaunched { worker_execution_id, .. }
            if journal.pre_admission_pins.contains_key(worker_execution_id) =>
        {
            return Err(WorkerDurableError::Conflict(
                "pre-admission reservations require cross-owner reconciliation, never timeout expiry",
            ));
        }
        WorkerCommand::DelegationBound { worker_execution_id, binding } => {
            validate_owner_digest(&binding.binding_digest, "blake3:")?;
            validate_owner_token(&binding.parent_execution_id)?;
            let worker = pool.worker(worker_execution_id).ok_or(WorkerDurableError::NotFound("delegation worker missing"))?;
            if worker.state != crate::resource_budget::ReservationState::Reserved
                || worker.cancellation_requested || worker.unknown_effect
                || (!journal.pre_admission_pins.contains_key(worker_execution_id)
                    && !journal.admission_pins.contains_key(worker_execution_id))
                || binding.parent_execution_id == *worker_execution_id
            {
                return Err(WorkerDurableError::Conflict("worker cannot bind delegation"));
            }
            if let Some(existing) = journal.delegation_bindings.get(worker_execution_id) {
                if existing != binding { return Err(WorkerDurableError::Conflict("worker delegation is immutable")); }
            } else {
                if let Some(pins) = journal.pre_admission_pins.get(worker_execution_id) {
                    let expected_parent_id = match &pins.parent_proof {
                        ManagedParentProofV1::RootCoordinator(proof) => proof.worker_execution_id(),
                        ManagedParentProofV1::ClaimedWorker(proof) => proof.worker_execution_id(),
                    };
                    if expected_parent_id != binding.parent_execution_id {
                        return Err(WorkerDurableError::Conflict("delegation parent differs from pinned lineage"));
                    }
                    if let Some(admission) = binding.worktree_admission.as_ref() {
                        admission.validate()?;
                        let registration = journal.worktree_registration_records
                            .get(&admission.worktree_id)
                            .filter(|registration| registration.owner().goal_id() == pins.goal_id()
                                && registration.owner().run_id() == pins.run_id()
                                && registration.owner().workspace_binding() == pins.workspace_binding()
                                && registration.owner().location_id() == admission.root_location_id
                                && registration.matches_durable_operations(worktree_operations)
                                && !journal.removed_worktree_registrations.contains_key(&admission.worktree_id))
                            .ok_or(WorkerDurableError::Conflict("child worktree admission has no exact registered root provenance"))?;
                        let provenance = registration.provenance().ok_or(WorkerDurableError::Conflict(
                            "child worktree admission lacks guarded Create provenance",
                        ))?;
                        let create = worktree_operations.get(provenance.create_operation_id())
                            .filter(|record| record.state() == WorktreeOperationStateV1::Completed
                                && record.intent().kind() == WorktreeOperationKindV1::Create
                                && record.intent().worktree_id() == admission.worktree_id
                                && record.intent().base_revision() == Some(admission.base_revision.as_str())
                                && record.intent().root().location_ref() == admission.root_location_id
                                && record.intent().root().workspace_binding() == admission.p8_workspace_binding
                                && record.receipt().is_some_and(|receipt| receipt.owned() && receipt.no_follow()))
                            .ok_or(WorkerDurableError::Conflict("child worktree admission Create proof does not match registered target"))?;
                        if admission.worktree_id != pins.worktree.worktree_id
                            || admission.base_revision != pins.worktree.base_revision
                            || admission.root_location_id != pins.location_id
                            || admission.p8_workspace_binding != pins.workspace_binding()
                            || admission.pool_revision.checked_add(1) != Some(pool.revision())
                            || pool.worker_source_revision(worker_execution_id)
                                != Some(admission.child_workspace_revision.as_str())
                        {
                            return Err(WorkerDurableError::Conflict("child worktree admission differs from exact reservation or measured child revision"));
                        }
                    }
                }
                journal.delegation_bindings.insert(worker_execution_id.clone(), binding.clone());
            }
        }
        WorkerCommand::RootCoordinatorRegistered { execution } => {
            validate_root_execution(execution)?;
            if execution.owner_epoch != pool.owner_epoch() {
                return Err(WorkerDurableError::Conflict("root coordinator epoch mismatch"));
            }
            if let Some(existing) = journal.root_coordinators.get(&execution.worker_execution_id) {
                if existing != execution { return Err(WorkerDurableError::Conflict("root coordinator is immutable")); }
            } else {
                if journal.root_coordinators.len() >= crate::worker_pool::MAX_WORKER_RECORDS {
                    return Err(WorkerDurableError::Invalid("root coordinator history full"));
                }
                journal.root_coordinators.insert(execution.worker_execution_id.clone(), execution.clone());
            }
        }
        WorkerCommand::RootCoordinatorReauthorized { attempt_id, quarantine_receipt_digest, prior_execution_digest, execution } => {
            validate_root_execution(execution)?;
            validate_owner_token(attempt_id)?;
            validate_owner_digest(quarantine_receipt_digest, "blake3:")?;
            let root_binding = (execution.worker_execution_id.clone(), quarantine_receipt_digest.clone());
            if journal.reconciliation_root_ids.get(attempt_id)
                .is_some_and(|previous| previous != &root_binding)
            {
                return Err(WorkerPoolError::InvalidTransition.into());
            }
            if !journal.reconciliation_root_ids.contains_key(attempt_id)
                && journal.reconciliation_root_ids.len() >= crate::worker_pool::MAX_WORKER_RECORDS
            {
                return Err(WorkerDurableError::Invalid("reconciliation root history full"));
            }
            let existing = journal.root_coordinators.get(&execution.worker_execution_id)
                .ok_or(WorkerPoolError::InvalidTransition)?;
            if execution.owner_epoch != pool.owner_epoch()
                || execution.owner_epoch < existing.owner_epoch
                || (execution.owner_epoch == existing.owner_epoch
                    && (execution.process_incarnation != existing.process_incarnation
                        || execution.process_identity != existing.process_identity))
                || root_execution_digest(existing) != *prior_execution_digest
                || existing.goal_id != execution.goal_id
                || existing.run_id != execution.run_id
                || existing.principal_ref != execution.principal_ref
                || existing.workspace_binding != execution.workspace_binding
                || existing.session_id != execution.session_id
                || existing.location_id != execution.location_id
                || existing.source_revision != execution.source_revision
                || existing.accepted_spec_digest != execution.accepted_spec_digest
            {
                return Err(WorkerPoolError::InvalidTransition.into());
            }
            journal.root_coordinators.insert(execution.worker_execution_id.clone(), execution.clone());
            journal.reconciliation_root_ids.insert(attempt_id.clone(), root_binding);
        }
        _ => {}
    }
    Ok(())
}

fn record_claim_receipt(
    journal: &mut WorkerIdentityJournalV1,
    pool: &WorkerPool,
    worker_execution_id: &str,
    cursor: &CursorV1,
) -> Result<(), WorkerDurableError> {
    let Some(pins) = journal.pre_admission_pins.get(worker_execution_id) else {
        return Ok(());
    };
    let binding = journal.delegation_bindings.get(worker_execution_id)
        .ok_or(WorkerDurableError::ReplayConflict("claimed managed worker has no attached binding"))?;
    let worker = pool.worker(worker_execution_id)
        .ok_or(WorkerDurableError::NotFound("claimed managed worker is unavailable"))?;
    let (ticket_id, expected_worker_id, _) = pre_admission_request(pins)?;
    if cursor.owner_kind != OWNER_KIND || cursor.owner_id.is_empty()
        || cursor.seq.parse::<u64>().ok().is_none_or(|sequence| sequence == 0)
        || expected_worker_id.as_str() != worker_execution_id
        || worker.ticket_id != ticket_id
        || worker.owner != OwnerScopeKey::from_owner(pins.owner())
        || worker.state != crate::resource_budget::ReservationState::Claimed
        || worker.cancellation_requested || worker.unknown_effect || worker.process_identity.is_some()
    {
        return Err(WorkerDurableError::ReplayConflict(
            "worker claim event does not establish an unbound managed claim",
        ));
    }
    validate_owner_digest(&cursor.event_digest, "blake3:")?;
    let receipt = WorkerClaimReceiptV1 {
        ticket_id,
        attempt_id: pins.attempt_id().to_owned(),
        pins_digest: pins.pins_digest().to_owned(),
        binding_digest: binding.binding_digest.clone(),
        owner_log_id: cursor.owner_id.clone(),
        owner_log_sequence: cursor.seq.clone(),
        owner_log_event_digest: cursor.event_digest.clone(),
        worker_pool_revision: pool.revision(),
    };
    if let Some(existing) = journal.claim_receipts.get(worker_execution_id) {
        return if existing == &receipt {
            Ok(())
        } else {
            Err(WorkerDurableError::ReplayConflict(
                "managed worker claim receipt changed across replay",
            ))
        };
    }
    if journal.claim_receipts.len() >= crate::worker_pool::MAX_WORKER_RECORDS {
        return Err(WorkerDurableError::Invalid("worker claim receipt history full"));
    }
    journal.claim_receipts.insert(worker_execution_id.to_owned(), receipt);
    Ok(())
}

fn scope_value(scope: &OwnerScopeKey) -> Value {
    json!({
        "principalRef": scope.principal_ref,
        "workspaceBinding": scope.workspace_binding,
        "sessionId": scope.session_id,
        "runId": scope.run_id,
        "taskId": scope.task_id,
        "attemptId": scope.attempt_id,
        "ownerEpoch": scope.owner_epoch,
    })
}

fn decode_scope(value: &Value) -> Result<OwnerScopeKey, WorkerDurableError> {
    Ok(OwnerScopeKey {
        principal_ref: text(value, "principalRef")?,
        workspace_binding: text(value, "workspaceBinding")?,
        session_id: text(value, "sessionId")?,
        run_id: text(value, "runId")?,
        task_id: text(value, "taskId")?,
        attempt_id: text(value, "attemptId")?,
        owner_epoch: unsigned(value, "ownerEpoch")?,
    })
}

fn registration_value(registration: &WorktreeRegistration) -> Value {
    json!({
        "id": registration.id,
        "workspaceBinding": registration.workspace_binding,
        "path": registration.path.to_string_lossy(),
        "baseRevision": registration.base_revision,
        "observedRevision": registration.observed_revision,
        "clean": registration.clean,
        "hasUntracked": registration.has_untracked,
    })
}

fn decode_registration(value: &Value) -> Result<WorktreeRegistration, WorkerDurableError> {
    Ok(WorktreeRegistration {
        id: text(value, "id")?,
        workspace_binding: text(value, "workspaceBinding")?,
        path: std::path::PathBuf::from(text(value, "path")?),
        base_revision: text(value, "baseRevision")?,
        observed_revision: optional_text(value, "observedRevision")?,
        clean: optional_bool(value, "clean")?,
        has_untracked: optional_bool(value, "hasUntracked")?,
    })
}

fn worktree_intent_value(intent: &WorktreeOperationIntentV1) -> Value {
    let kind = match intent.kind() {
        WorktreeOperationKindV1::Create => "CREATE",
        WorktreeOperationKindV1::Inspect => "INSPECT",
        WorktreeOperationKindV1::Release => "RELEASE",
    };
    json!({
        "operationId": intent.operation_id(),
        "kind": kind,
        "owner": worktree_root_owner_value(intent.owner()),
        "root": {
            "locationRef": intent.root().location_ref(),
            "workspaceBinding": intent.root().workspace_binding(),
            "registrationGeneration": intent.root().registration_generation(),
        },
        "worktreeId": intent.worktree_id(),
        "baseRevision": intent.base_revision(),
        "relativePath": intent.relative_path().to_string_lossy(),
        "expectedWorkspaceRevision": intent.expected_workspace_revision(),
        "ownerLogId": intent.owner_log_id(),
        "ownerLogSequence": intent.owner_log_sequence(),
        "ownerLogEventDigest": intent.owner_log_event_digest(),
        "ownerEpoch": intent.owner_epoch(),
    })
}

fn worktree_intent_digest(intent: &WorktreeOperationIntentV1) -> String {
    logical_command_digest("worker_worktree_operation_intent", &worktree_intent_value(intent))
}

fn decode_worktree_intent(value: &Value) -> Result<WorktreeOperationIntentV1, WorkerDurableError> {
    let root = value
        .get("root")
        .ok_or(WorkerDurableError::Invalid("worktree root missing"))?;
    let root_ref = crate::worktree_lifecycle::WorkspaceRootRefV1::from_host_kernel(
        text(root, "locationRef")?,
        text(root, "workspaceBinding")?,
        unsigned(root, "registrationGeneration")?,
    )
    .map_err(map_worktree_lifecycle_error)?;
    let kind = match text(value, "kind")?.as_str() {
        "CREATE" => WorktreeOperationKindV1::Create,
        "INSPECT" => WorktreeOperationKindV1::Inspect,
        "RELEASE" => WorktreeOperationKindV1::Release,
        _ => {
            return Err(WorkerDurableError::Invalid(
                "unknown worktree operation kind",
            ));
        }
    };
    let owner = decode_worktree_root_owner(value.get("owner")
        .ok_or(WorkerDurableError::Invalid("worktree root owner missing"))?)?;
    let intent = WorktreeOperationIntentV1::from_owner_log(
        text(value, "operationId")?,
        kind,
        owner,
        root_ref,
        text(value, "worktreeId")?,
        optional_text(value, "baseRevision")?,
        std::path::PathBuf::from(text(value, "relativePath")?),
        text(value, "expectedWorkspaceRevision")?,
        text(value, "ownerLogId")?,
        text(value, "ownerLogSequence")?,
        text(value, "ownerLogEventDigest")?,
    )
    .map_err(map_worktree_lifecycle_error)?;
    if intent.owner_epoch() != unsigned(value, "ownerEpoch")? {
        return Err(WorkerDurableError::Invalid("worktree owner epoch mismatch"));
    }
    Ok(intent)
}

fn worktree_root_owner_value(owner: &WorktreeRootOwnerV1) -> Value {
    json!({
        "coordinatorId": owner.coordinator_id(),
        "goalId": owner.goal_id(),
        "runId": owner.run_id(),
        "principalRef": owner.principal_ref(),
        "workspaceBinding": owner.workspace_binding(),
        "sessionId": owner.session_id(),
        "locationId": owner.location_id(),
        "ownerEpoch": owner.owner_epoch(),
        "processIncarnation": owner.process_incarnation(),
        "processIdentity": process_identity_value(owner.process_identity()),
        "acceptedSpecDigest": owner.accepted_spec_digest(),
        "rootDigest": owner.root_digest(),
    })
}

fn decode_worktree_root_owner(value: &Value) -> Result<WorktreeRootOwnerV1, WorkerDurableError> {
    WorktreeRootOwnerV1::from_owner_log(
        text(value, "coordinatorId")?, text(value, "goalId")?, text(value, "runId")?,
        text(value, "principalRef")?, text(value, "workspaceBinding")?, text(value, "sessionId")?,
        text(value, "locationId")?, unsigned(value, "ownerEpoch")?, text(value, "processIncarnation")?,
        decode_process_identity(value.get("processIdentity").ok_or(
            WorkerDurableError::Invalid("worktree root process identity missing"),
        )?)?, text(value, "acceptedSpecDigest")?, text(value, "rootDigest")?,
    ).map_err(map_worktree_lifecycle_error)
}

fn worktree_receipt_value(receipt: &GuardedWorktreeReceiptV1) -> Value {
    let status = match receipt.status() {
        WorktreeObservedStatusV1::Clean => "CLEAN",
        WorktreeObservedStatusV1::DirtyOwned => "DIRTY_OWNED",
        WorktreeObservedStatusV1::DirtyUnattributed => "DIRTY_UNATTRIBUTED",
        WorktreeObservedStatusV1::Missing => "MISSING",
        WorktreeObservedStatusV1::Unknown => "UNKNOWN",
    };
    let pre_release = receipt.pre_release().map(|before| json!({
        "status": match before.status() {
            WorktreeObservedStatusV1::Clean => "CLEAN",
            WorktreeObservedStatusV1::DirtyOwned => "DIRTY_OWNED",
            WorktreeObservedStatusV1::DirtyUnattributed => "DIRTY_UNATTRIBUTED",
            WorktreeObservedStatusV1::Missing => "MISSING",
            WorktreeObservedStatusV1::Unknown => "UNKNOWN",
        },
        "dirtyEntryCount": before.dirty_entry_count(),
        "dirtyEntriesDigest": before.dirty_entries_digest(),
        "containsUserOwnedChanges": before.contains_user_owned_changes(),
    }));
    json!({
        "operationId": receipt.operation_id(),
        "hostReceiptRef": receipt.host_receipt_ref(),
        "workspaceBinding": receipt.workspace_binding(),
        "registrationGeneration": receipt.registration_generation(),
        "observedWorkspaceRevision": receipt.observed_workspace_revision(),
        "status": status,
        "dirtyEntryCount": receipt.dirty_entry_count(),
        "dirtyEntriesDigest": receipt.dirty_entries_digest(),
        "containsUserOwnedChanges": receipt.contains_user_owned_changes(),
        "preRelease": pre_release,
        "owned": receipt.owned(),
        "noFollow": receipt.no_follow(),
    })
}

fn decode_worktree_receipt(value: &Value) -> Result<GuardedWorktreeReceiptV1, WorkerDurableError> {
    fn decode_status(value: &str) -> Result<WorktreeObservedStatusV1, WorkerDurableError> {
        match value {
            "CLEAN" => Ok(WorktreeObservedStatusV1::Clean),
            "DIRTY_OWNED" => Ok(WorktreeObservedStatusV1::DirtyOwned),
            "DIRTY_UNATTRIBUTED" => Ok(WorktreeObservedStatusV1::DirtyUnattributed),
            "MISSING" => Ok(WorktreeObservedStatusV1::Missing),
            "UNKNOWN" => Ok(WorktreeObservedStatusV1::Unknown),
            _ => Err(WorkerDurableError::Invalid("unknown worktree status")),
        }
    }
    let status = decode_status(&text(value, "status")?)?;
    let pre_release = match value.get("preRelease") {
        None | Some(Value::Null) => None,
        Some(before) => Some(WorktreePreReleaseEvidenceV1::from_guarded_host(
            decode_status(before.get("status").and_then(Value::as_str).ok_or(
                WorkerDurableError::Invalid("pre-release status missing"),
            )?)?,
            u32::try_from(unsigned(before, "dirtyEntryCount")?)
                .map_err(|_| WorkerDurableError::Invalid("pre-release dirty count overflow"))?,
            text(before, "dirtyEntriesDigest")?,
            boolean(before, "containsUserOwnedChanges")?,
        ).map_err(map_worktree_lifecycle_error)?),
    };
    let root = crate::worktree_lifecycle::WorkspaceRootRefV1::from_host_kernel(
        "replay-placeholder".to_owned(),
        text(value, "workspaceBinding")?,
        unsigned(value, "registrationGeneration")?,
    )
    .map_err(map_worktree_lifecycle_error)?;
    GuardedWorktreeReceiptV1::from_guarded_host(
        text(value, "operationId")?,
        text(value, "hostReceiptRef")?,
        &root,
        text(value, "observedWorkspaceRevision")?,
        status,
        u32::try_from(unsigned(value, "dirtyEntryCount")?)
            .map_err(|_| WorkerDurableError::Invalid("worktree dirty count overflow"))?,
        text(value, "dirtyEntriesDigest")?,
        boolean(value, "containsUserOwnedChanges")?,
        pre_release,
        value.get("owned").and_then(Value::as_bool).unwrap_or(false),
        value.get("noFollow").and_then(Value::as_bool).unwrap_or(false),
    )
    .map_err(map_worktree_lifecycle_error)
}

fn map_worktree_lifecycle_error(error: WorktreeLifecycleErrorV1) -> WorkerDurableError {
    match error {
        WorktreeLifecycleErrorV1::IntentNotFound => {
            WorkerDurableError::NotFound("worktree operation intent missing")
        }
        WorktreeLifecycleErrorV1::IdempotencyConflict => {
            WorkerDurableError::Conflict("worktree operation idempotency conflict")
        }
        WorktreeLifecycleErrorV1::OperationLimitReached => {
            WorkerDurableError::Invalid("worktree operation history limit reached")
        }
        _ => WorkerDurableError::Invalid("invalid worktree lifecycle record"),
    }
}

fn apply_worktree_journal_command(
    journal: &mut WorktreeOperationJournalV1,
    command: &WorkerCommand,
) -> Result<(), WorkerDurableError> {
    match command {
        WorkerCommand::WorktreeOperationDispatchStarted { operation_id } => journal
            .record_dispatch_started(operation_id).map_err(map_worktree_lifecycle_error),
        WorkerCommand::WorktreeOperationIntent { intent } => journal
            .record_intent(intent.clone())
            .map_err(map_worktree_lifecycle_error),
        WorkerCommand::WorktreeOperationReceipt { receipt } => journal
            .record_receipt(receipt.clone())
            .map_err(map_worktree_lifecycle_error),
        WorkerCommand::WorktreeOperationRetiredNoDispatch { operation_id, .. } => journal
            .record_retired_no_dispatch(operation_id)
            .map_err(map_worktree_lifecycle_error),
        _ => Ok(()),
    }
}

fn enqueue_value(request: &EnqueueRequest) -> Value {
    json!({
        "ticketId": request.ticket_id,
        "goalId": request.goal_id,
        "idempotencyKey": request.idempotency_key,
        "dimension": request.dimension.wire_name(),
        "amount": request.amount,
        "expiresAtMs": request.expires_at_ms,
        "expectedTaskRevision": request.expected_task_revision,
        "acceptedSpecDigest": request.accepted_spec_digest,
        "class": worker_class_wire(request.class),
        "worktree": request.worktree.as_ref().map(|worktree| json!({
            "worktreeId": worktree.worktree_id,
            "baseRevision": worktree.base_revision,
        })),
        "parentExecution": request.parent_execution.as_ref().map(parent_lineage_value),
    })
}

fn decode_enqueue(value: &Value) -> Result<EnqueueRequest, WorkerDurableError> {
    let class = match text(value, "class")?.as_str() {
        "READ_ONLY_ATTACHMENT" => WorkerClass::ReadOnlyAttachment,
        "ISOLATED_EFFECTFUL" => WorkerClass::IsolatedEffectful,
        _ => return Err(WorkerDurableError::Invalid("unknown worker class")),
    };
    let dimension = BudgetDimension::parse_wire(&text(value, "dimension")?)
        .map_err(|_| WorkerDurableError::Invalid("unknown budget dimension"))?;
    let worktree = match value.get("worktree") {
        None | Some(Value::Null) => None,
        Some(worktree) => Some(WorktreeBindingRequest {
            worktree_id: text(worktree, "worktreeId")?,
            base_revision: text(worktree, "baseRevision")?,
        }),
    };
    Ok(EnqueueRequest {
        ticket_id: text(value, "ticketId")?,
        goal_id: text(value, "goalId")?,
        idempotency_key: text(value, "idempotencyKey")?,
        dimension,
        amount: unsigned(value, "amount")?,
        expires_at_ms: unsigned(value, "expiresAtMs")?,
        expected_task_revision: text(value, "expectedTaskRevision")?,
        accepted_spec_digest: text(value, "acceptedSpecDigest")?,
        class,
        worktree,
        parent_execution: match value.get("parentExecution") {
            None | Some(Value::Null) => None,
            Some(lineage) => Some(decode_parent_lineage(lineage)?),
        },
    })
}

fn parent_lineage_value(lineage: &ParentExecutionLineageV1) -> Value {
    json!({
        "workerExecutionId": lineage.worker_execution_id(),
        "goalId": lineage.goal_id(),
        "owner": scope_value(lineage.owner()),
        "sourceRevision": lineage.source_revision(),
        "acceptedSpecDigest": lineage.accepted_spec_digest(),
        "ownerLogId": lineage.owner_log_id(),
        "ownerLogSequence": lineage.owner_log_sequence(),
        "ownerLogEventDigest": lineage.owner_log_event_digest(),
        "workerPoolRevision": lineage.worker_pool_revision(),
        "processIdentity": {
            "pid": lineage.process_identity().pid,
            "startIdentity": lineage.process_identity().start_identity,
        },
    })
}

fn decode_parent_lineage(value: &Value) -> Result<ParentExecutionLineageV1, WorkerDurableError> {
    let owner_value = value
        .get("owner")
        .ok_or(WorkerDurableError::Invalid("missing parent owner"))?;
    let scope = decode_scope(owner_value)?;
    let process = value
        .get("processIdentity")
        .ok_or(WorkerDurableError::Invalid(
            "missing parent process identity",
        ))?;
    let pid = u32::try_from(unsigned(process, "pid")?)
        .map_err(|_| WorkerDurableError::Invalid("parent PID exceeds platform bounds"))?;
    ParentExecutionLineageV1::from_owner_log_facts(
        text(value, "workerExecutionId")?,
        text(value, "goalId")?,
        scope,
        text(value, "sourceRevision")?,
        text(value, "acceptedSpecDigest")?,
        text(value, "ownerLogId")?,
        text(value, "ownerLogSequence")?,
        text(value, "ownerLogEventDigest")?,
        unsigned(value, "workerPoolRevision")?,
        ProcessIdentity::new(pid, unsigned(process, "startIdentity")?),
    )
    .map_err(Into::into)
}

fn worker_class_wire(class: WorkerClass) -> &'static str {
    match class {
        WorkerClass::ReadOnlyAttachment => "READ_ONLY_ATTACHMENT",
        WorkerClass::IsolatedEffectful => "ISOLATED_EFFECTFUL",
    }
}

fn binding_value(binding: &VerifiedAttemptBinding) -> Value {
    json!({
        "goalId": binding.goal_id(),
        "runId": binding.run_id(),
        "taskId": binding.task_id(),
        "attemptId": binding.attempt_id(),
        "ownerEpoch": binding.owner_epoch(),
        "sourceRevision": binding.source_revision(),
        "acceptedSpecDigest": binding.accepted_spec_digest(),
    })
}

fn decode_binding(value: &Value) -> Result<VerifiedAttemptBinding, WorkerDurableError> {
    Ok(VerifiedAttemptBinding::from_managed_attempt(
        text(value, "goalId")?,
        text(value, "runId")?,
        text(value, "taskId")?,
        text(value, "attemptId")?,
        unsigned(value, "ownerEpoch")?,
        text(value, "sourceRevision")?,
        text(value, "acceptedSpecDigest")?,
        BindingAttemptPhase::Executing,
    )?)
}

fn reuse_key_value(key: &WorkerReuseKey) -> Value {
    json!({
        "principalRef": key.principal_ref,
        "workspaceBinding": key.workspace_binding,
        "trustProfile": key.trust_profile,
        "sandboxProfile": key.sandbox_profile,
        "providerSelectionDigest": key.provider_selection_digest,
        "harnessDigest": key.harness_digest,
        "environmentDigest": key.environment_digest,
        "policyEpoch": key.policy_epoch,
    })
}

fn decode_reuse_key(value: &Value) -> Result<WorkerReuseKey, WorkerDurableError> {
    Ok(WorkerReuseKey {
        principal_ref: text(value, "principalRef")?,
        workspace_binding: text(value, "workspaceBinding")?,
        trust_profile: text(value, "trustProfile")?,
        sandbox_profile: text(value, "sandboxProfile")?,
        provider_selection_digest: text(value, "providerSelectionDigest")?,
        harness_digest: text(value, "harnessDigest")?,
        environment_digest: text(value, "environmentDigest")?,
        policy_epoch: unsigned(value, "policyEpoch")?,
    })
}

fn process_identity_value(identity: &ProcessIdentity) -> Value {
    json!({
        "pid": identity.pid,
        "startIdentity": identity.start_identity,
    })
}

fn decode_process_identity(value: &Value) -> Result<ProcessIdentity, WorkerDurableError> {
    let pid = unsigned(value, "pid")?;
    let start_identity = unsigned(value, "startIdentity")?;
    if pid == 0 || pid > u64::from(u32::MAX) || start_identity == 0 {
        return Err(WorkerDurableError::Invalid("invalid process identity"));
    }
    Ok(ProcessIdentity::new(pid as u32, start_identity))
}

fn settlement_value(settlement: &WorkerSettlement) -> Value {
    json!({
        "outcome": match settlement.outcome {
            WorkerSettlementOutcome::Settled => "SETTLED",
            WorkerSettlementOutcome::Unknown => "UNKNOWN",
            WorkerSettlementOutcome::Blocked => "BLOCKED",
        },
        "processIdentity": settlement.process_identity.as_ref().map(process_identity_value),
        "ownedProcessExited": settlement.owned_process_exited,
        "effectsSettled": settlement.effects_settled,
        "reconciliationComplete": settlement.reconciliation_complete,
        "evidenceRefs": settlement.evidence_refs,
        "externalEffectRefs": settlement.external_effect_refs,
        "worktree": settlement.worktree.as_ref().map(|facts| json!({
            "observedRevision": facts.observed_revision,
            "clean": facts.clean,
            "hasUntracked": facts.has_untracked,
        })),
    })
}

fn decode_settlement(value: &Value) -> Result<WorkerSettlement, WorkerDurableError> {
    let outcome = match text(value, "outcome")?.as_str() {
        "SETTLED" => WorkerSettlementOutcome::Settled,
        "UNKNOWN" => WorkerSettlementOutcome::Unknown,
        "BLOCKED" => WorkerSettlementOutcome::Blocked,
        _ => return Err(WorkerDurableError::Invalid("unknown settlement outcome")),
    };
    let process_identity = match value.get("processIdentity") {
        None | Some(Value::Null) => None,
        Some(identity) => Some(decode_process_identity(identity)?),
    };
    let worktree = match value.get("worktree") {
        None | Some(Value::Null) => None,
        Some(facts) => Some(WorktreeSettlementFacts {
            observed_revision: optional_text(facts, "observedRevision")?,
            clean: optional_bool(facts, "clean")?,
            has_untracked: optional_bool(facts, "hasUntracked")?,
        }),
    };
    Ok(WorkerSettlement {
        outcome,
        process_identity,
        owned_process_exited: boolean(value, "ownedProcessExited")?,
        effects_settled: boolean(value, "effectsSettled")?,
        reconciliation_complete: boolean(value, "reconciliationComplete")?,
        evidence_refs: list(value, "evidenceRefs")?,
        external_effect_refs: list(value, "externalEffectRefs")?,
        worktree,
    })
}

fn proof_value(proof: &ReservationProof) -> Value {
    json!({
        "noLaunchOrDispatch": proof.no_launch_or_dispatch,
        "ownedProcessExited": proof.owned_process_exited,
        "effectsSettled": proof.effects_settled,
        "reconciliationComplete": proof.reconciliation_complete,
    })
}

fn decode_proof(value: &Value) -> Result<ReservationProof, WorkerDurableError> {
    Ok(ReservationProof {
        no_launch_or_dispatch: boolean(value, "noLaunchOrDispatch")?,
        owned_process_exited: boolean(value, "ownedProcessExited")?,
        effects_settled: boolean(value, "effectsSettled")?,
        reconciliation_complete: boolean(value, "reconciliationComplete")?,
    })
}

fn reconciliation_value(proof: &ReconciliationProof) -> Value {
    json!({
        "ownedProcessExited": proof.owned_process_exited,
        "effectsSettled": proof.effects_settled,
        "reconciliationComplete": proof.reconciliation_complete,
    })
}

fn decode_reconciliation(value: &Value) -> Result<ReconciliationProof, WorkerDurableError> {
    Ok(ReconciliationProof {
        owned_process_exited: boolean(value, "ownedProcessExited")?,
        effects_settled: boolean(value, "effectsSettled")?,
        reconciliation_complete: boolean(value, "reconciliationComplete")?,
    })
}

fn cancel_value(scope: &CancelScope) -> Value {
    match scope {
        CancelScope::Run { run_id } => json!({"kind": "RUN", "runId": run_id}),
        CancelScope::Task { run_id, task_id } => {
            json!({"kind": "TASK", "runId": run_id, "taskId": task_id})
        }
        CancelScope::Attempt {
            run_id,
            task_id,
            attempt_id,
        } => json!({
            "kind": "ATTEMPT",
            "runId": run_id,
            "taskId": task_id,
            "attemptId": attempt_id,
        }),
        CancelScope::Worker {
            worker_execution_id,
        } => json!({"kind": "WORKER", "workerExecutionId": worker_execution_id}),
    }
}

fn decode_cancel(value: &Value) -> Result<CancelScope, WorkerDurableError> {
    match text(value, "kind")?.as_str() {
        "RUN" => Ok(CancelScope::Run {
            run_id: text(value, "runId")?,
        }),
        "TASK" => Ok(CancelScope::Task {
            run_id: text(value, "runId")?,
            task_id: text(value, "taskId")?,
        }),
        "ATTEMPT" => Ok(CancelScope::Attempt {
            run_id: text(value, "runId")?,
            task_id: text(value, "taskId")?,
            attempt_id: text(value, "attemptId")?,
        }),
        "WORKER" => Ok(CancelScope::Worker {
            worker_execution_id: text(value, "workerExecutionId")?,
        }),
        _ => Err(WorkerDurableError::Invalid("unknown cancel scope")),
    }
}

fn rehydrate(
    scope: &OwnerScopeKey,
) -> Result<crate::resource_budget::AuthenticatedOwnerContext, WorkerPoolError> {
    crate::resource_budget::AuthenticatedOwnerContext::rehydrate_from_durable_scope(
        scope.principal_ref.clone(),
        scope.workspace_binding.clone(),
        scope.session_id.clone(),
        scope.run_id.clone(),
        scope.task_id.clone(),
        scope.attempt_id.clone(),
        scope.owner_epoch,
    )
    .map_err(WorkerPoolError::Reservation)
}

fn logical_command_digest(kind: &str, data: &Value) -> String {
    let command = json!({"kind": kind, "data": data});
    format!(
        "blake3:{}",
        blake3::hash(command.to_string().as_bytes()).to_hex()
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn text(value: &Value, name: &str) -> Result<String, WorkerDurableError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(WorkerDurableError::Invalid(
            "worker payload string field missing",
        ))
}

fn optional_text(value: &Value, name: &str) -> Result<Option<String>, WorkerDurableError> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(text) => {
            text.as_str()
                .map(|text| Some(text.to_owned()))
                .ok_or(WorkerDurableError::Invalid(
                    "worker payload optional field invalid",
                ))
        }
    }
}

fn unsigned(value: &Value, name: &str) -> Result<u64, WorkerDurableError> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .ok_or(WorkerDurableError::Invalid(
            "worker payload unsigned field missing",
        ))
}

fn parse_canonical_owner_u64(value: &str) -> Option<u64> {
    let parsed = value.parse::<u64>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}

fn usize_value(value: &Value, name: &str) -> Result<usize, WorkerDurableError> {
    usize::try_from(unsigned(value, name)?)
        .map_err(|_| WorkerDurableError::Invalid("worker pool limit exceeds platform range"))
}

fn boolean(value: &Value, name: &str) -> Result<bool, WorkerDurableError> {
    value
        .get(name)
        .and_then(Value::as_bool)
        .ok_or(WorkerDurableError::Invalid(
            "worker payload boolean field missing",
        ))
}

fn optional_bool(value: &Value, name: &str) -> Result<Option<bool>, WorkerDurableError> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(flag) => flag.as_bool().map(Some).ok_or(WorkerDurableError::Invalid(
            "worker payload optional boolean invalid",
        )),
    }
}

fn list(value: &Value, name: &str) -> Result<Vec<String>, WorkerDurableError> {
    let items = value
        .get(name)
        .and_then(Value::as_array)
        .ok_or(WorkerDurableError::Invalid(
            "worker payload list field missing",
        ))?;
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or(WorkerDurableError::Invalid(
                    "worker payload list item invalid",
                ))
        })
        .collect()
}

#[cfg(test)]
mod pool_open_schema_tests {
    use super::{
        decode_managed_worktree_admission_pin, decode_trusted_pre_admission,
        apply_worktree_journal_command, BoundWorkerDelegationV1, EVENT_SCHEMA_VERSION,
        ManagedFinalInspectCandidatePinV1, ManagedLogicalSettlementEventV1,
        ManagedWorktreeAdmissionPinV1, ManagedWorktreeDispositionEventV1,
        managed_final_inspect_idempotency_key, managed_root_session_id,
        managed_worktree_admission_pin_value, ManagedParentProofV1,
        RootCoordinatorExecutionProofV1, RootCoordinatorExecutionV1,
        trusted_pre_admission_value, worktree_operation_id,
        TrustedPreAdmissionPinsV1, WorkerCommand, WorkerDurableError,
        managed_task_attempt_candidate_id, ManagedTerminalQuarantineEventV1,
        WorkerManagedQuarantineReasonV1,
    };
    use crate::resource_budget::{AuthenticatedOwnerContext, BudgetDimension};
    use crate::resource_sampler::ProcessIdentity;
    use crate::worker_pool::{WorkerPool, WorkerPoolConfig};
    use crate::worktree_lifecycle::{
        GuardedWorktreeReceiptV1, WorktreeOperationIntentV1, WorktreeOperationJournalV1,
        WorktreeOperationKindV1, WorktreeOperationStateV1, WorktreeObservedStatusV1,
        WorktreeRootOwnerV1, WorkspaceRootRefV1,
    };
    use crate::worktree_pool::WorktreeRegistration;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn v1_pool_open_replays_with_its_original_default_limits() {
        assert_eq!(
            WorkerCommand::decode("worker_pool_opened", &json!({"ownerEpoch": 9}), 1),
            Ok(WorkerCommand::PoolOpened {
                owner_epoch: 9,
                max_live_workers: crate::worker_pool::MAX_LIVE_WORKERS,
                max_queued_tickets: crate::worker_pool::MAX_QUEUED_TICKETS,
                max_worktrees: crate::worker_pool::MAX_LIVE_WORKERS,
            })
        );
        assert!(matches!(
            WorkerCommand::decode(
                "worker_pool_opened",
                &json!({"ownerEpoch": 9, "maxLiveWorkers": 4}),
                1,
            ),
            Err(WorkerDurableError::Invalid(_))
        ));
    }

    #[test]
    fn logical_settlement_ownerlog_keeps_legacy_and_typed_receipt_shapes() {
        let legacy = WorkerCommand::decode(
            "worker_managed_logical_settled",
            &json!({
                "workerExecutionId": "worker_1",
                "attemptId": "attempt_1",
                "proofDigest": format!("blake3:{}", "a".repeat(64)),
                "observedWorkspaceRevision": null,
                "reusableWorktree": false,
                "reconciliationOwnerEpoch": null,
            }),
            1,
        ).expect("legacy P8 event remains replayable");
        assert!(matches!(legacy, WorkerCommand::ManagedLogicalSettled { event } if event.schema_version == 1));

        let digest = format!("blake3:{}", "b".repeat(64));
        let typed = WorkerCommand::ManagedLogicalSettled {
            event: ManagedLogicalSettlementEventV1 {
                schema_version: 4,
                worker_execution_id: "worker_1".to_owned(),
                attempt_id: "attempt_1".to_owned(),
                proof_digest: digest.clone(),
                observed_workspace_revision: Some(digest.clone()),
                final_worktree_operation_id: Some("inspect_1".to_owned()),
                final_worktree_host_receipt_ref: Some("host_receipt_1".to_owned()),
                evidence_digest: Some(digest.clone()),
                evidence_refs: vec![crate::protocol::ArtifactRefV1 {
                    artifact_id: "artifact_1".to_owned(),
                    digest: digest.clone(),
                    byte_length: "1".to_owned(),
                    media_type: "application/json".to_owned(),
                    classification: crate::protocol::ArtifactClassificationV1::Workspace,
                }],
                verification_run_id: Some("verification_run_1".to_owned()),
                set_identity_digest: Some(digest.clone()),
                challenge_set_digest: Some(digest.clone()),
                reusable_worktree: false,
                reconciliation_owner_epoch: None,
                disposition_deferred: true,
            },
        };
        let (kind, payload) = typed.event();
        let replayed = WorkerCommand::decode(kind, &payload, 1)
            .expect("typed P8 settlement event roundtrips");
        assert_eq!(replayed, typed);
    }

    #[test]
    fn managed_worktree_disposition_ownerlog_event_is_typed_and_replayable() {
        let digest = format!("blake3:{}", "c".repeat(64));
        let typed = WorkerCommand::ManagedWorktreeDisposition {
            event: ManagedWorktreeDispositionEventV1 {
                worker_execution_id: "worker_1".to_owned(),
                attempt_id: "attempt_1".to_owned(),
                owner_epoch: 7,
                settlement_receipt_digest: digest.clone(),
                final_worktree_operation_id: "inspect_1".to_owned(),
                final_worktree_host_receipt_ref: "host_receipt_1".to_owned(),
                observed_workspace_revision: digest.clone(),
                inspect_receipt_digest: digest,
                reusable_worktree: false,
                reconciliation_owner_epoch: None,
                reconciliation_proof_digest: None,
            },
        };
        let (kind, payload) = typed.event();
        assert_eq!(kind, "worker_managed_worktree_disposition");
        assert_eq!(
            WorkerCommand::decode(kind, &payload, 1)
                .expect("typed disposition event remains replayable"),
            typed,
        );
        let mut missing_epoch = payload;
        missing_epoch.as_object_mut().expect("event payload is an object")
            .remove("ownerEpoch");
        assert!(matches!(
            WorkerCommand::decode(kind, &missing_epoch, 1),
            Err(WorkerDurableError::Invalid(_)),
        ));
    }

    #[test]
    fn managed_terminal_quarantine_event_binds_exact_attempt_lease_epoch_and_reason() {
        let owner = AuthenticatedOwnerContext::test_fixture(
            "server_auth:test", "workspace_test", "ses-child", "run-test",
            "task-test", "attempt-test", 7,
        );
        let typed = WorkerCommand::ManagedTerminalQuarantined {
            event: ManagedTerminalQuarantineEventV1 {
                scope: super::OwnerScopeKey::from_owner(&owner),
                worker_execution_id: "worker-test".to_owned(),
                goal_id: "goal-test".to_owned(), run_id: "run-test".to_owned(),
                task_id: "task-test".to_owned(), attempt_id: "attempt-test".to_owned(),
                owner_epoch: 7,
                reservation_id: "budget-test".to_owned(),
                worktree_lease_id: "worktree-lease-test".to_owned(),
                terminal_proof_digest: format!("blake3:{}", "a".repeat(64)),
                reason: WorkerManagedQuarantineReasonV1::CancelledTask,
            },
        };
        let (kind, payload) = typed.event();
        assert_eq!(kind, "worker_managed_terminal_quarantined");
        assert_eq!(payload["ownerEpoch"], 7);
        assert_eq!(payload["attemptId"], "attempt-test");
        assert_eq!(payload["reservationId"], "budget-test");
        assert_eq!(payload["worktreeLeaseId"], "worktree-lease-test");
        assert_eq!(payload["reason"], "CANCELLED_TASK");
        assert_eq!(
            WorkerCommand::decode(kind, &payload, 1).expect("typed quarantine replay"),
            typed,
        );
    }

    #[test]
    fn replay_restores_exact_guarded_inspect_receipt_and_operation_idempotency() {
        let digest = format!("blake3:{}", "c".repeat(64));
        let root_proof = RootCoordinatorExecutionProofV1 {
            execution: RootCoordinatorExecutionV1 {
                worker_execution_id: "root-test".to_owned(),
                goal_id: "goal-test".to_owned(),
                run_id: "run-test".to_owned(),
                principal_ref: "server_auth:test".to_owned(),
                workspace_binding: "workspace_test".to_owned(),
                session_id: "ses-root".to_owned(),
                location_id: "location-test".to_owned(),
                owner_epoch: 7,
                process_incarnation: "incarnation-test".to_owned(),
                process_identity: ProcessIdentity::new(123, 456),
                source_revision: "source-test".to_owned(),
                accepted_spec_digest: digest.clone(),
                expires_at_ms: 10_000,
            },
            owner_log_id: "worker_pool_test".to_owned(),
            owner_log_sequence: "1".to_owned(),
            owner_log_event_digest: digest.clone(),
            worker_pool_revision: 1,
        };
        let owner = WorktreeRootOwnerV1::from_live_root_proof(&root_proof)
            .expect("valid authenticated root proof binds the worktree owner");
        let root = WorkspaceRootRefV1::from_host_kernel(
            "location-test".to_owned(), "workspace_test".to_owned(), 3,
        ).expect("valid registered root ref");
        let idempotency_key = managed_final_inspect_idempotency_key("attempt-test");
        let operation_id = worktree_operation_id(&owner, WorktreeOperationKindV1::Inspect, &idempotency_key);
        let intent = WorktreeOperationIntentV1::new(
            operation_id.clone(), WorktreeOperationKindV1::Inspect, owner.clone(), root.clone(),
            "worktree-test".to_owned(), "base-test".to_owned(),
            PathBuf::from("worktrees/worktree-test"), digest.clone(),
            "worker_pool_test".to_owned(), "1".to_owned(), digest.clone(),
        ).expect("valid final Inspect intent");
        let receipt = GuardedWorktreeReceiptV1::from_guarded_host(
            operation_id.clone(), "host_receipt_test".to_owned(), &root, digest,
            WorktreeObservedStatusV1::Clean, 0, String::new(), false, None, true, true,
        ).expect("valid clean guarded receipt");

        let commands = [
            WorkerCommand::WorktreeOperationIntent { intent },
            WorkerCommand::WorktreeOperationDispatchStarted { operation_id: operation_id.clone() },
            WorkerCommand::WorktreeOperationReceipt { receipt: receipt.clone() },
        ];
        let mut replayed = WorktreeOperationJournalV1::default();
        for command in commands {
            let (kind, payload) = command.event();
            let decoded = WorkerCommand::decode(kind, &payload, 1)
                .expect("P8 OwnerLog worktree event decodes during restart replay");
            apply_worktree_journal_command(&mut replayed, &decoded)
                .expect("P8 OwnerLog worktree event reconstructs journal");
        }
        let recovered = replayed.get(&operation_id).expect("Inspect record survives replay");
        assert_eq!(recovered.state(), WorktreeOperationStateV1::Completed);
        assert_eq!(recovered.receipt(), Some(&receipt));
        assert_eq!(
            worktree_operation_id(recovered.intent().owner(), WorktreeOperationKindV1::Inspect, &idempotency_key),
            operation_id,
        );
        assert_ne!(
            worktree_operation_id(recovered.intent().owner(), WorktreeOperationKindV1::Inspect, "different-key"),
            operation_id,
        );
        let candidate_pin = WorkerCommand::ManagedFinalInspectCandidatePinned {
            pin: ManagedFinalInspectCandidatePinV1 {
                operation_id: operation_id.clone(),
                candidate_digest: format!("blake3:{}", "d".repeat(64)),
                attempt_id: "attempt-test".to_owned(),
                binding_digest: format!("blake3:{}", "e".repeat(64)),
                spec_id: "spec-test".to_owned(),
                spec_digest: format!("blake3:{}", "f".repeat(64)),
                evidence_digest: format!("blake3:{}", "a".repeat(64)),
                final_revision: format!("blake3:{}", "b".repeat(64)),
                verification_run_id: Some("verification_run_test".to_owned()),
                set_identity_digest: Some(format!("blake3:{}", "c".repeat(64))),
                challenge_set_digest: Some(format!("blake3:{}", "e".repeat(64))),
            },
        };
        let (kind, payload) = candidate_pin.event();
        assert_eq!(
            WorkerCommand::decode(kind, &payload, 1),
            Ok(candidate_pin),
            "managed final Inspect candidate pins survive OwnerLog event replay",
        );
    }

    #[test]
    fn v2_pool_open_roundtrips_explicit_limits_and_rejects_extra_fields() {
        let command = WorkerCommand::PoolOpened {
            owner_epoch: 9,
            max_live_workers: 4,
            max_queued_tickets: 8,
            max_worktrees: 2,
        };
        let (kind, payload) = command.event();
        assert_eq!(WorkerCommand::decode(kind, &payload, 1), Ok(command));
        assert!(matches!(
            WorkerCommand::decode(
                "worker_pool_opened",
                &json!({
                    "poolConfigVersion": 2,
                    "ownerEpoch": 9,
                    "maxLiveWorkers": 4,
                    "maxQueuedTickets": 8,
                    "maxWorktrees": 2,
                    "ignored": true,
                }),
                2,
            ),
            Err(WorkerDurableError::Invalid(_))
        ));
    }

    #[test]
    fn reconciliation_root_rotation_roundtrips_exact_quarantine_binding() {
        let execution = RootCoordinatorExecutionV1 {
            worker_execution_id: "root-stable-v1".to_owned(),
            goal_id: "goal-v1".to_owned(), run_id: "run-v1".to_owned(),
            principal_ref: "server_auth:owner-v1".to_owned(),
            workspace_binding: "workspace-v1".to_owned(), session_id: "session-v1".to_owned(),
            location_id: "location-v1".to_owned(), owner_epoch: 8,
            process_incarnation: "incarnation-new-v1".to_owned(),
            process_identity: ProcessIdentity::new(123, 456),
            source_revision: "source-revision-v1".to_owned(),
            accepted_spec_digest: format!("blake3:{}", "a".repeat(64)), expires_at_ms: 99_000,
        };
        let command = WorkerCommand::RootCoordinatorReauthorized {
            attempt_id: "attempt-v1".to_owned(),
            quarantine_receipt_digest: format!("blake3:{}", "b".repeat(64)),
            prior_execution_digest: format!("blake3:{}", "c".repeat(64)),
            execution,
        };
        let (kind, payload) = command.event();
        assert_eq!(
            WorkerCommand::decode(kind, &payload, u64::from(EVENT_SCHEMA_VERSION)).unwrap(),
            command
        );
    }

    #[test]
    fn pre_admission_pins_keep_distinct_workspace_and_worktree_revisions_and_candidate_generation() {
        let task_id = "task-v1";
        let attempt_count = 2;
        let candidate_generation = 3;
        let attempt_id = managed_task_attempt_candidate_id(task_id, attempt_count, candidate_generation);
        let process = ProcessIdentity::new(123, 456);
        let parent = RootCoordinatorExecutionV1 {
            worker_execution_id: "root-test".to_owned(),
            goal_id: "goal-v1".to_owned(),
            run_id: "run-v1".to_owned(),
            principal_ref: "server_auth:owner-v1".to_owned(),
            workspace_binding: "workspace-v1".to_owned(),
            session_id: "session-v1".to_owned(),
            location_id: "location-v1".to_owned(),
            owner_epoch: 7,
            process_incarnation: "incarnation-v1".to_owned(),
            process_identity: process,
            source_revision: "workspace-source-revision".to_owned(),
            accepted_spec_digest: format!("blake3:{}", "a".repeat(64)),
            expires_at_ms: 10_000,
        };
        let parent_proof = ManagedParentProofV1::RootCoordinator(RootCoordinatorExecutionProofV1 {
            execution: parent,
            owner_log_id: "worker-pool-v1".to_owned(),
            owner_log_sequence: "4".to_owned(),
            owner_log_event_digest: format!("blake3:{}", "b".repeat(64)),
            worker_pool_revision: 4,
        });
        let owner = AuthenticatedOwnerContext::test_fixture(
            "server_auth:owner-v1", "workspace-v1", "session-child-v1", "run-v1",
            task_id, &attempt_id, 7,
        );
        let mut pool = WorkerPool::new(WorkerPoolConfig {
            owner_epoch: 7,
            max_live_workers: 4,
            max_queued_tickets: 8,
            max_worktrees: 4,
        }).expect("worker pool fixture");
        pool.register_worktree(WorktreeRegistration {
            id: "worktree-v1".to_owned(),
            workspace_binding: "workspace-v1".to_owned(),
            path: std::path::PathBuf::from("/tmp/horizoncode-p8-fixture"),
            base_revision: "git-object-v1".to_owned(),
            observed_revision: Some(format!("blake3:{}", "d".repeat(64))),
            clean: Some(true),
            has_untracked: Some(false),
        }, &owner, 0).expect("registered clean fixture");
        let verified_worktrees = std::collections::BTreeSet::from(["worktree-v1".to_owned()]);
        let worktree = pool.resolve_managed_worktree(
            &owner, "location-v1", &format!("blake3:{}", "d".repeat(64)), &verified_worktrees,
        ).expect("P8 resolves only its registered clean tree");
        let pins = TrustedPreAdmissionPinsV1::from_verified_host(
            owner,
            "goal-v1".to_owned(),
            "task-revision-9".to_owned(),
            attempt_count,
            candidate_generation,
            format!("blake3:{}", "a".repeat(64)),
            format!("blake3:{}", "d".repeat(64)),
            "location-v1".to_owned(),
            "incarnation-v1".to_owned(),
            "profile-v1".to_owned(),
            1,
            format!("blake3:{}", "e".repeat(64)),
            format!("blake3:{}", "f".repeat(64)),
            format!("blake3:{}", "1".repeat(64)),
            format!("blake3:{}", "2".repeat(64)),
            format!("sha256:{}", "3".repeat(64)),
            4,
            2,
            format!("blake3:{}", "4".repeat(64)),
            Some(3),
            BudgetDimension::ActiveWorkers,
            1,
            9_000,
            worktree,
            "delivery-v1".to_owned(),
            parent_proof,
        ).expect("trusted pre-admission pin fixture is valid");

        assert_eq!(pins.task_attempt_count(), attempt_count);
        assert_eq!(pins.candidate_generation(), candidate_generation);
        assert_eq!(pins.attempt_id(), attempt_id);
        assert_eq!(pins.task_revision(), "task-revision-9");
        assert_eq!(pins.workspace_revision(), format!("blake3:{}", "d".repeat(64)));
        assert_ne!(pins.workspace_revision(), pins.worktree().base_revision);
        assert_ne!(pins.task_revision(), pins.workspace_revision());
        assert_eq!(pins.spec_max_workers(), 4);
        assert_eq!(pins.resource_policy_revision(), 2);
        assert_eq!(pins.resource_policy_digest(), format!("blake3:{}", "4".repeat(64)).as_str());
        assert_eq!(pins.resource_active_worker_limit(), Some(3));
        assert_eq!(
            decode_trusted_pre_admission(&trusted_pre_admission_value(&pins)).unwrap(),
            pins,
        );

        // Old durable entries remain readable for restart recovery but carry
        // no active-worker policy authority and cannot be used for new live
        // admission. The genuine historical no-resource-pin shape predates
        // `stagedPreAdmission` too, so it is the 25-key form (29 minus the
        // three resource-policy fields and the staged-mode field) — matching
        // the decoder's `legacy_without_resource_pin` branch, which defaults
        // staged mode to false rather than reading it.
        let mut legacy = pins.clone();
        legacy.resource_policy_revision = 0;
        legacy.resource_policy_digest.clear();
        legacy.resource_active_worker_limit = None;
        legacy.pins_digest = legacy.compute_digest();
        let mut legacy_value = trusted_pre_admission_value(&legacy);
        let legacy_fields = legacy_value.as_object_mut().expect("legacy pin map");
        legacy_fields.remove("resourcePolicyRevision");
        legacy_fields.remove("resourcePolicyDigest");
        legacy_fields.remove("resourceActiveWorkerLimit");
        legacy_fields.remove("stagedPreAdmission");
        assert_eq!(legacy_value.as_object().map(|object| object.len()), Some(25));
        assert_eq!(decode_trusted_pre_admission(&legacy_value).unwrap(), legacy);
        assert_eq!(pins.dimension(), BudgetDimension::ActiveWorkers);
        assert_eq!(pins.amount(), 1);
        assert_ne!(pins.session_id(), "session-v1", "child Attempt Session is distinct from Run root Session");
        assert_eq!(managed_root_session_id(pins.parent_proof()).expect("direct root lineage"), "session-v1");
        assert!(pins.worktree_pool_revision() > 0);
        assert_ne!(
            managed_task_attempt_candidate_id(task_id, attempt_count, candidate_generation),
            managed_task_attempt_candidate_id(task_id, attempt_count, candidate_generation + 1),
        );
        assert_ne!(
            managed_task_attempt_candidate_id(task_id, attempt_count, candidate_generation),
            managed_task_attempt_candidate_id(task_id, attempt_count + 1, candidate_generation),
        );
    }

    #[test]
    fn managed_child_worktree_projection_roundtrips_and_legacy_binding_replays_unpinned() {
        let pin = ManagedWorktreeAdmissionPinV1 {
            worktree_id: "worktree-v1".to_owned(),
            base_revision: "git-base-v1".to_owned(),
            pool_revision: 12,
            root_location_id: "location-root-v1".to_owned(),
            p8_workspace_binding: "workspace-v1".to_owned(),
            child_location_id: "location-child-v1".to_owned(),
            child_workspace_id: "workspace-child-v1".to_owned(),
            child_workspace_ref: "workspace-ref-child-v1".to_owned(),
            child_canonical_root: "/tmp/horizoncode-child-v1".to_owned(),
            child_workspace_revision: format!("blake3:{}", "a".repeat(64)),
        };
        let value = managed_worktree_admission_pin_value(&pin);
        assert_eq!(decode_managed_worktree_admission_pin(&value).unwrap(), pin);

        let binding = BoundWorkerDelegationV1 {
            binding_digest: format!("blake3:{}", "b".repeat(64)),
            parent_execution_id: "root-execution-v1".to_owned(),
            worktree_admission: Some(pin),
        };
        let command = WorkerCommand::DelegationBound {
            worker_execution_id: "worker-v1".to_owned(),
            binding,
        };
        let (kind, payload) = command.event();
        assert_eq!(
            WorkerCommand::decode(kind, &payload, u64::from(EVENT_SCHEMA_VERSION)).unwrap(),
            command
        );

        let legacy = json!({
            "workerExecutionId": "worker-v1",
            "bindingDigest": format!("blake3:{}", "c".repeat(64)),
            "parentExecutionId": "root-execution-v1",
        });
        let decoded = WorkerCommand::decode(
            "worker_delegation_bound",
            &legacy,
            u64::from(EVENT_SCHEMA_VERSION),
        )
        .unwrap();
        assert!(matches!(decoded, WorkerCommand::DelegationBound {
            binding: BoundWorkerDelegationV1 { worktree_admission: None, .. }, ..
        }));
    }
}

#[cfg(test)]
#[path = "../tests/support/worker_durable_tests.rs"]
mod worker_durable_tests;
