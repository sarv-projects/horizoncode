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
    WorktreeOperationKindV1, VerifiedWorktreeRegistrationV1, WorktreeRegistrationProvenanceV1,
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
    permission_scope_digest: String,
    context_selection_digest: String,
    accepted_scope_digest: String,
    capability_ceiling_digest: String,
    spec_max_workers: u64,
    dimension: crate::resource_budget::BudgetDimension,
    amount: u64,
    expires_at_ms: u64,
    worktree: crate::worker_pool::WorktreeBindingRequest,
    worktree_pool_revision: u64,
    idempotency_key: String,
    parent_proof: ManagedParentProofV1,
    pins_digest: String,
}

/// Canonical P1-facing name for the immutable READY Task token. It is minted
/// only by the authenticated HostKernel path after checking the current Run,
/// Task, SpecVersion, profile, context, workspace, Guard ceiling and parent.
pub(crate) type ManagedReadyTaskPinV1 = TrustedPreAdmissionPinsV1;

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
        permission_scope_digest: String,
        context_selection_digest: String,
        accepted_scope_digest: String,
        capability_ceiling_digest: String,
        spec_max_workers: u64,
        dimension: crate::resource_budget::BudgetDimension,
        amount: u64,
        expires_at_ms: u64,
        worktree: crate::worker_pool::ResolvedManagedWorktreeV1,
        idempotency_key: String,
        parent_proof: ManagedParentProofV1,
    ) -> Result<Self, WorkerDurableError> {
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
            permission_scope_digest,
            context_selection_digest,
            accepted_scope_digest,
            capability_ceiling_digest,
            spec_max_workers,
            dimension,
            amount,
            expires_at_ms,
            worktree,
            worktree_pool_revision,
            idempotency_key,
            parent_proof,
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
            &self.profile_digest, &self.permission_scope_digest,
            &self.context_selection_digest, &self.accepted_scope_digest] {
            validate_owner_digest(value, "blake3:")?;
        }
        validate_owner_digest(&self.capability_ceiling_digest, "sha256:")?;
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
        let mut bytes = b"horizoncode.trusted-pre-admission-pins.v1\0".to_vec();
        for value in [
            self.owner.principal_ref(), self.owner.workspace_binding(), self.owner.session_id(),
            self.owner.run_id(), self.owner.task_id(), self.owner.attempt_id(), &self.goal_id,
            &self.task_revision, &self.accepted_spec_digest, &self.workspace_revision,
            &self.location_id, &self.process_incarnation, &self.profile_id, &self.profile_digest,
            &self.permission_scope_digest, &self.context_selection_digest,
            &self.accepted_scope_digest, &self.capability_ceiling_digest,
            &self.worktree.worktree_id, &self.worktree.base_revision, &self.idempotency_key,
        ] {
            bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes.extend_from_slice(&self.owner.owner_epoch().to_be_bytes());
        bytes.extend_from_slice(&self.task_attempt_count.to_be_bytes());
        bytes.extend_from_slice(&self.candidate_generation.to_be_bytes());
        bytes.extend_from_slice(&self.profile_revision.to_be_bytes());
        bytes.extend_from_slice(&self.spec_max_workers.to_be_bytes());
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
    pub(crate) fn permission_scope_digest(&self) -> &str { &self.permission_scope_digest }
    pub(crate) fn context_selection_digest(&self) -> &str { &self.context_selection_digest }
    pub(crate) fn accepted_scope_digest(&self) -> &str { &self.accepted_scope_digest }
    pub(crate) fn capability_ceiling_digest(&self) -> &str { &self.capability_ceiling_digest }
    pub(crate) fn spec_max_workers(&self) -> u64 { self.spec_max_workers }
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
    host_quiescence_digest: String,
    final_worktree_receipt: Option<GuardedWorktreeReceiptV1>,
    proof_digest: String,
}

/// Independent P1/P2 reconciliation proof for an already quarantined logical
/// Core child. It is not an escape hatch for an unresolved effect chain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkerReconciliationProofV1 {
    settlement: WorkerSettlementProofV1,
    current_owner: AuthenticatedOwnerContext,
    current_root: RootCoordinatorExecutionProofV1,
    reconciliation_digest: String,
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
            || terminal.effects().len() > MAX_BATCH_EVENTS
            || terminal.effects().iter().any(|effect| {
                effect.effect_id().is_empty()
                    || effect.outcome().is_none()
                    || effect.observation_digest().is_none_or(|digest| !valid_digest(digest, "blake3:"))
            })
        {
            return Err(WorkerDurableError::Conflict(
                "managed logical worker terminal evidence is incomplete or mismatched",
            ));
        }
        if final_worktree_receipt.as_ref().is_some_and(|receipt| {
            receipt.workspace_binding() != owner.workspace_binding()
                || terminal.observed_workspace_head()
                    .is_none_or(|head| head != receipt.observed_workspace_revision())
                || !receipt.owned()
                || !receipt.no_follow()
        }) {
            return Err(WorkerDurableError::Conflict(
                "final guarded workspace receipt differs from terminal workspace observation",
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
            &host_quiescence_digest, final_worktree_receipt.as_ref(),
        );
        Ok(Self {
            execution_kind, claim, root, owner, attempt_binding, terminal,
            host_quiescence_digest, final_worktree_receipt, proof_digest,
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
    pub(crate) fn proof_digest(&self) -> &str { &self.proof_digest }
}

impl WorkerReconciliationProofV1 {
    pub(crate) fn from_host_kernel(
        settlement: WorkerSettlementProofV1,
        current_owner: AuthenticatedOwnerContext,
        current_root: RootCoordinatorExecutionProofV1,
    ) -> Result<Self, WorkerDurableError> {
        let prior = settlement.owner();
        if current_owner.principal_ref() != prior.principal_ref()
            || current_owner.workspace_binding() != prior.workspace_binding()
            || current_owner.session_id() != prior.session_id()
            || current_owner.run_id() != prior.run_id()
            || current_owner.task_id() != prior.task_id()
            || current_owner.attempt_id() != prior.attempt_id()
            || current_owner.owner_epoch() < prior.owner_epoch()
            || current_root.goal_id() != settlement.root().goal_id()
            || current_root.run_id() != settlement.root().run_id()
            || current_root.principal_ref() != prior.principal_ref()
            || current_root.workspace_binding() != prior.workspace_binding()
            || current_root.session_id() != settlement.root().session_id()
            || current_root.location_id() != settlement.root().location_id()
            || current_root.owner_epoch() != current_owner.owner_epoch()
            || current_root.accepted_spec_digest() != settlement.root().accepted_spec_digest()
        {
            return Err(WorkerDurableError::Invalid("worker reconciliation authority or digest is invalid"));
        }
        let mut h = blake3::Hasher::new();
        h.update(b"horizoncode.worker-reconciliation-proof.v1\0");
        append_digest_field(&mut h, settlement.proof_digest());
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
        let reconciliation_digest = format!("blake3:{}", h.finalize().to_hex());
        Ok(Self { settlement, current_owner, current_root, reconciliation_digest })
    }

    pub(crate) fn settlement(&self) -> &WorkerSettlementProofV1 { &self.settlement }
    pub(crate) fn current_owner(&self) -> &AuthenticatedOwnerContext { &self.current_owner }
    pub(crate) fn current_root(&self) -> &RootCoordinatorExecutionProofV1 { &self.current_root }
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
) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"horizoncode.logical-worker-settlement-proof.v1\0");
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
}

#[derive(Clone, Debug, Default)]
struct WorkerIdentityJournalV1 {
    pre_admission_pins: BTreeMap<String, TrustedPreAdmissionPinsV1>,
    admission_pins: BTreeMap<String, WorkerAdmissionPinsV1>,
    delegation_bindings: BTreeMap<String, BoundWorkerDelegationV1>,
    root_coordinators: BTreeMap<String, RootCoordinatorExecutionV1>,
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
    pub(crate) fn context_selection_digest(&self) -> Option<&str> { self.admission_pins.as_ref().map(|p| p.context_selection_digest.as_str()).or_else(|| self.pre_admission_pins.as_ref().map(|p| p.context_selection_digest.as_str())) }
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
    /// Releases only a pinned pre-admission lease with P1's durable
    /// cross-owner proof that no dispatched effect or process can exist.
    PreAdmissionReconciled {
        proof: ManagedReservationReconciliationProofV1,
    },
    AdmissionPinsRecorded { worker_execution_id: String, pins: WorkerAdmissionPinsV1 },
    DelegationBound { worker_execution_id: String, binding: BoundWorkerDelegationV1 },
    RootCoordinatorRegistered { execution: RootCoordinatorExecutionV1 },
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
    CancelScope {
        scope: OwnerScopeKey,
        cancel: CancelScope,
        now_ms: u64,
    },
    WorktreeOperationDispatchStarted { operation_id: String },
    WorktreeOperationIntent {
        intent: WorktreeOperationIntentV1,
    },
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
            Self::PreAdmissionReconciled { proof } => (
                "worker_pre_admission_reconciled",
                managed_reservation_reconciliation_value(proof),
            ),
            Self::AdmissionPinsRecorded { worker_execution_id, pins } => (
                "worker_admission_pins_recorded", json!({"workerExecutionId": worker_execution_id, "pins": admission_pins_value(pins)}),
            ),
            Self::DelegationBound { worker_execution_id, binding } => (
                "worker_delegation_bound", json!({"workerExecutionId": worker_execution_id, "bindingDigest": binding.binding_digest, "parentExecutionId": binding.parent_execution_id}),
            ),
            Self::RootCoordinatorRegistered { execution } => (
                "worker_root_coordinator_registered", root_coordinator_value(execution),
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
            Self::ManagedLogicalSettled { event } => (
                "worker_managed_logical_settled",
                json!({
                    "workerExecutionId": event.worker_execution_id,
                    "attemptId": event.attempt_id,
                    "proofDigest": event.proof_digest,
                    "observedWorkspaceRevision": event.observed_workspace_revision,
                    "reusableWorktree": event.reusable_worktree,
                    "reconciliationOwnerEpoch": event.reconciliation_owner_epoch,
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
                    binding: BoundWorkerDelegationV1 { binding_digest, parent_execution_id: text(payload, "parentExecutionId")? },
                })
            },
            "worker_root_coordinator_registered" if count == 13 => Ok(Self::RootCoordinatorRegistered {
                execution: decode_root_coordinator(payload)?,
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
            "worker_managed_logical_settled" if count == 6 => {
                let observed_workspace_revision = match payload.get("observedWorkspaceRevision") {
                    Some(Value::Null) | None => None,
                    Some(Value::String(value)) => Some(value.clone()),
                    _ => return Err(WorkerDurableError::Invalid("invalid settled workspace revision")),
                };
                let proof_digest = text(payload, "proofDigest")?;
                validate_owner_digest(&proof_digest, "blake3:")?;
                Ok(Self::ManagedLogicalSettled { event: ManagedLogicalSettlementEventV1 {
                    worker_execution_id: text(payload, "workerExecutionId")?,
                    attempt_id: text(payload, "attemptId")?,
                    proof_digest, observed_workspace_revision,
                    reusable_worktree: boolean(payload, "reusableWorktree")?,
                    reconciliation_owner_epoch: match payload.get("reconciliationOwnerEpoch") {
                        Some(Value::Null) | None => None,
                        Some(value) => Some(value.as_u64().ok_or(WorkerDurableError::Invalid("invalid reconciliation epoch"))?),
                    },
                } })
            },
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
            Self::PreAdmissionReconciled { proof } => {
                let owner = pool.worker(proof.worker_execution_id())
                    .ok_or(WorkerPoolError::WorkerNotFound)?;
                let scope = rehydrate(&owner.owner).map_err(|_| WorkerPoolError::ScopeMismatch)?;
                pool.reconcile_pre_admission_no_dispatch(proof.worker_execution_id(), &scope, pool.revision())
            }
            Self::AdmissionPinsRecorded { .. } | Self::DelegationBound { .. }
                | Self::RootCoordinatorRegistered { .. } => Ok(()),
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
                event.reconciliation_owner_epoch,
            ),
            Self::CancelScope { scope, cancel, .. } => {
                let owner = rehydrate(scope)?;
                pool.cancel_scope(cancel, &owner, pool.revision())?;
                Ok(())
            }
            Self::WorktreeOperationDispatchStarted { .. } | Self::WorktreeOperationIntent { .. } | Self::WorktreeOperationReceipt { .. } => Ok(()),
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
    identities: WorkerIdentityJournalV1,
    pre_admission_reconciliation_receipts: BTreeMap<String, PreAdmissionReconciliationReceiptV1>,
    managed_settlement_receipts: BTreeMap<String, WorkerSettlementReceiptV1>,
    worktree_removal_receipts: BTreeMap<String, WorktreeRegistrationRemovalReceiptV1>,
    worktree_retirement_receipts: BTreeMap<String, WorktreeOperationRetirementReceiptV1>,
    resumed_epoch: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkerManagedSettlementDispositionV1 { Released, WorktreeQuarantined }

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
    receipt_digest: String,
}

impl WorkerSettlementReceiptV1 {
    fn from_committed_event(
        event: &ManagedLogicalSettlementEventV1, cursor: &CursorV1, worker_pool_revision: u64,
    ) -> Self {
        let mut h = blake3::Hasher::new();
        h.update(b"horizoncode.worker-settlement-receipt.v1\0");
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
        Self { worker_execution_id: event.worker_execution_id.clone(), attempt_id: event.attempt_id.clone(),
            proof_digest: event.proof_digest.clone(), disposition, owner_log_id: cursor.owner_id.clone(),
            owner_log_sequence: cursor.seq.clone(), owner_log_event_digest: cursor.event_digest.clone(),
            worker_pool_revision, receipt_digest: format!("blake3:{}", h.finalize().to_hex()) }
    }
    pub(crate) fn worker_execution_id(&self) -> &str { &self.worker_execution_id }
    pub(crate) fn attempt_id(&self) -> &str { &self.attempt_id }
    pub(crate) fn proof_digest(&self) -> &str { &self.proof_digest }
    pub(crate) fn disposition(&self) -> WorkerManagedSettlementDispositionV1 { self.disposition }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn receipt_digest(&self) -> &str { &self.receipt_digest }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManagedLogicalSettlementEventV1 {
    worker_execution_id: String,
    attempt_id: String,
    proof_digest: String,
    observed_workspace_revision: Option<String>,
    reusable_worktree: bool,
    reconciliation_owner_epoch: Option<u64>,
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
            identities: WorkerIdentityJournalV1::default(),
            pre_admission_reconciliation_receipts: BTreeMap::new(),
            managed_settlement_receipts: BTreeMap::new(),
            worktree_removal_receipts: BTreeMap::new(),
            worktree_retirement_receipts: BTreeMap::new(),
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
        location_id: &str,
        workspace_revision: &str,
        root_proof: &RootCoordinatorExecutionProofV1,
        now_ms: u64,
    ) -> Result<crate::worker_pool::ResolvedManagedWorktreeV1, WorkerDurableError> {
        if owner.owner_epoch() != self.resumed_epoch {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let root_owner = self.resolve_worktree_root_owner(root_proof, now_ms)?;
        if root_owner.run_id() != owner.run_id()
            || root_owner.principal_ref() != owner.principal_ref()
            || root_owner.workspace_binding() != owner.workspace_binding()
            || root_owner.session_id() != owner.session_id()
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
        if pins.owner() != owner || pins.owner_epoch() != self.resumed_epoch
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
    ) -> Result<ReservedWorkerLeaseProofV1, WorkerDurableError> {
        let pins = self.identities.pre_admission_pins.get(&proof.worker_execution_id)
            .ok_or(WorkerDurableError::NotFound("pre-admission pins unavailable"))?.clone();
        let (_, _, delivery_id) = pre_admission_ids(&pins);
        let binding_digest = delegation.digest()
            .map_err(|_| WorkerDurableError::Invalid("delegation digest failed"))?;
        let attached_digest = self.identities.delegation_bindings
            .get(&proof.worker_execution_id).map(|binding| binding.binding_digest.as_str());
        let current = self.reserved_worker_proof(&pins, &proof.ticket_id, &proof.worker_execution_id, attached_digest)?;
        if &current != proof {
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
            || delegation.source_revision != pins.workspace_revision
            || delegation.owner_epoch != pins.owner_epoch()
            || delegation.profile_id != pins.profile_id
            || delegation.profile_revision != pins.profile_revision
            || delegation.profile_digest != pins.profile_digest
            || delegation.capability_ceiling_digest != pins.capability_ceiling_digest
            || delegation.context_selection_digest != pins.context_selection_digest
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
        };
        if let Some(existing) = self.identities.delegation_bindings.get(&proof.worker_execution_id) {
            if existing != &journal_binding {
                return Err(WorkerDurableError::Conflict("worker binding digest is immutable"));
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
            || attempt_binding.source_revision() != pins.workspace_revision()
            || attempt_binding.accepted_spec_digest() != pins.accepted_spec_digest()
        {
            return Err(WorkerDurableError::Conflict(
                "admitted Attempt differs from immutable pre-admission pins",
            ));
        }

        let worker_execution_id = reservation.worker_execution_id();
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
            || delegation.context_selection_digest != pins.context_selection_digest()
            || delegation.capability_ceiling_digest != pins.capability_ceiling_digest()
            || delegation.source_revision != pins.workspace_revision()
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
                    || attached.parent_execution_id != delegation.parent_execution_id)
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
            || attempt_binding.source_revision() != pins.workspace_revision()
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
            || delegation.context_selection_digest != pins.context_selection_digest()
            || delegation.capability_ceiling_digest != pins.capability_ceiling_digest()
            || delegation.source_revision != pins.workspace_revision()
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
            || delegation.context_selection_digest != pins.context_selection_digest()
            || delegation.capability_ceiling_digest != pins.capability_ceiling_digest()
            || delegation.source_revision != pins.workspace_revision()
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
            || worker.owner.attempt_id() != attempt_id
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
            return if receipt.proof_digest() == proof.proof_digest()
                && receipt.attempt_id() == proof.claim().attempt_id()
            {
                Ok(receipt.clone())
            } else {
                Err(WorkerDurableError::Conflict("managed worker already has a different settlement receipt"))
            };
        }
        let root_owner = self.resolve_worktree_root_owner(proof.root(), now_ms)?;
        let pins = self.identities.pre_admission_pins.get(&worker_id)
            .ok_or(WorkerDurableError::NotFound("settlement worker pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(&worker_id)?;
        let binding = self.identities.delegation_bindings.get(&worker_id)
            .ok_or(WorkerDurableError::Conflict("settlement DelegationBinding missing"))?;
        let terminal = proof.terminal();
        if &claim != proof.claim()
            || proof.owner() != pins.owner()
            || proof.owner().owner_epoch() != self.resumed_epoch
            || proof.attempt_binding().attempt_id() != pins.attempt_id()
            || proof.attempt_binding().source_revision() != pins.workspace_revision()
            || proof.attempt_binding().accepted_spec_digest() != pins.accepted_spec_digest()
            || terminal.task_revision() != pins.task_revision().parse::<u64>()
                .map_err(|_| WorkerDurableError::Conflict("pinned Task revision is invalid"))?
            || terminal.admission_workspace_revision() != Some(pins.workspace_revision())
            || terminal.binding_digest() != binding.binding_digest
            || terminal.binding_digest() != claim.binding_digest()
            || terminal.spec_digest() != pins.accepted_spec_digest()
            || terminal.goal_id() != pins.goal_id() || terminal.run_id() != pins.run_id()
            || terminal.task_id() != pins.task_id() || terminal.attempt_id() != pins.attempt_id()
            || root_owner.goal_id() != pins.goal_id() || root_owner.run_id() != pins.run_id()
            || root_owner.principal_ref() != pins.principal_ref()
            || root_owner.workspace_binding() != pins.workspace_binding()
            || root_owner.session_id() != pins.session_id()
            || root_owner.location_id() != pins.location_id()
            || root_owner.owner_epoch() != pins.owner_epoch()
            || root_owner.process_incarnation() != pins.process_incarnation()
            || root_owner.accepted_spec_digest() != pins.accepted_spec_digest()
        {
            return Err(WorkerDurableError::Conflict("managed settlement differs from current P8/P1/P2 pins"));
        }
        let receipt = proof.final_worktree_receipt();
        let reusable_worktree = receipt.is_some_and(|receipt| {
            terminal.observed_workspace_head() == Some(receipt.observed_workspace_revision())
                && receipt.workspace_binding() == pins.workspace_binding()
                && receipt.status() == WorktreeObservedStatusV1::Clean
                && receipt.dirty_entry_count() == 0
                && !receipt.contains_user_owned_changes()
                && receipt.owned() && receipt.no_follow()
        });
        if receipt.is_some_and(|receipt|
            terminal.observed_workspace_head() != Some(receipt.observed_workspace_revision())
                || receipt.workspace_binding() != pins.workspace_binding()
                || !receipt.owned() || !receipt.no_follow()
        ) {
            return Err(WorkerDurableError::Conflict("final guarded workspace observation differs from P2 terminal head"));
        }
        let event = ManagedLogicalSettlementEventV1 {
            worker_execution_id: worker_id.clone(), attempt_id: pins.attempt_id().to_owned(),
            proof_digest: proof.proof_digest().to_owned(),
            observed_workspace_revision: receipt.map(|receipt| receipt.observed_workspace_revision().to_owned()),
            reusable_worktree,
            reconciliation_owner_epoch: None,
        };
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let delivery_id = format!("worker-managed-settle-{worker_id}");
        self.apply(revision, &delivery_id, WorkerCommand::ManagedLogicalSettled { event })?;
        self.managed_settlement_receipts.get(&worker_id).cloned()
            .ok_or(WorkerDurableError::Invalid("settlement OwnerLog receipt was not materialized"))
    }

    pub(crate) fn resolve_managed_settlement_for_attempt(
        &self,
        attempt_id: &str,
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
        let settlement = proof.settlement();
        let worker_id = settlement.claim().worker_execution_id().to_owned();
        let current_owner = proof.current_owner();
        if current_owner.owner_epoch() != self.resumed_epoch
            || !valid_digest(proof.reconciliation_digest(), "blake3:")
        {
            return Err(WorkerDurableError::Pool(WorkerPoolError::StaleOwnerEpoch));
        }
        let combined_proof_digest = {
            let mut h = blake3::Hasher::new();
            h.update(b"horizoncode.logical-worker-reconciliation.v1\0");
            h.update(settlement.proof_digest().as_bytes());
            h.update(proof.reconciliation_digest().as_bytes());
            format!("blake3:{}", h.finalize().to_hex())
        };
        if let Some(receipt) = self.managed_settlement_receipts.get(&worker_id) {
            return if receipt.proof_digest() == combined_proof_digest
                && receipt.attempt_id() == settlement.claim().attempt_id()
            { Ok(receipt.clone()) }
            else { Err(WorkerDurableError::Conflict("worker already has a different settlement receipt")) };
        }
        // The old settlement root is immutable lineage evidence only. Current
        // reconciliation authority must come from a newly authenticated root
        // proof in the resumed HostKernel epoch.
        let current_root = proof.current_root();
        let root_owner = self.resolve_worktree_root_owner(current_root, now_ms)?;
        let pins = self.identities.pre_admission_pins.get(&worker_id)
            .ok_or(WorkerDurableError::NotFound("reconciliation worker pins unavailable"))?;
        let claim = self.claimed_worker_dispatch_proof(&worker_id)?;
        let binding = self.identities.delegation_bindings.get(&worker_id)
            .ok_or(WorkerDurableError::Conflict("reconciliation DelegationBinding missing"))?;
        let prior_owner = settlement.owner();
        let terminal = settlement.terminal();
        let pool_worker = self.pool.as_ref().and_then(|pool| pool.worker(&worker_id))
            .ok_or(WorkerDurableError::NotFound("reconciliation worker lease missing"))?;
        if &claim != settlement.claim()
            || prior_owner != pins.owner()
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
            || current_root.session_id() != pins.session_id()
            || current_root.location_id() != pins.location_id()
            || current_root.owner_epoch() != current_owner.owner_epoch()
            || current_root.accepted_spec_digest() != pins.accepted_spec_digest()
            || pool_worker.state != crate::resource_budget::ReservationState::Quarantined
            || pool_worker.process_identity.is_some()
            || terminal.task_revision() != pins.task_revision().parse::<u64>()
                .map_err(|_| WorkerDurableError::Conflict("pinned Task revision is invalid"))?
            || terminal.admission_workspace_revision() != Some(pins.workspace_revision())
            || terminal.binding_digest() != binding.binding_digest
            || terminal.binding_digest() != claim.binding_digest()
            || terminal.spec_digest() != pins.accepted_spec_digest()
            || terminal.goal_id() != pins.goal_id() || terminal.run_id() != pins.run_id()
            || terminal.task_id() != pins.task_id() || terminal.attempt_id() != pins.attempt_id()
            || root_owner.goal_id() != pins.goal_id() || root_owner.run_id() != pins.run_id()
            || root_owner.principal_ref() != pins.principal_ref()
            || root_owner.workspace_binding() != pins.workspace_binding()
            || root_owner.session_id() != pins.session_id()
            || root_owner.location_id() != pins.location_id()
            || root_owner.owner_epoch() != current_owner.owner_epoch()
            || root_owner.process_incarnation() != current_root.process_incarnation()
            || root_owner.accepted_spec_digest() != pins.accepted_spec_digest()
        {
            return Err(WorkerDurableError::Conflict(
                "reconciliation proof does not match the exact quarantined managed child",
            ));
        }
        let receipt = settlement.final_worktree_receipt();
        let reusable_worktree = receipt.is_some_and(|receipt| {
            terminal.observed_workspace_head() == Some(receipt.observed_workspace_revision())
                && receipt.workspace_binding() == pins.workspace_binding()
                && receipt.status() == WorktreeObservedStatusV1::Clean
                && receipt.dirty_entry_count() == 0
                && !receipt.contains_user_owned_changes()
                && receipt.owned() && receipt.no_follow()
        });
        if receipt.is_some_and(|receipt|
            terminal.observed_workspace_head() != Some(receipt.observed_workspace_revision())
                || receipt.workspace_binding() != pins.workspace_binding()
                || !receipt.owned() || !receipt.no_follow()
        ) {
            return Err(WorkerDurableError::Conflict("reconciled workspace proof differs from final guarded observation"));
        }
        let event = ManagedLogicalSettlementEventV1 {
            worker_execution_id: worker_id.clone(), attempt_id: pins.attempt_id().to_owned(),
            proof_digest: combined_proof_digest,
            observed_workspace_revision: receipt.map(|receipt| receipt.observed_workspace_revision().to_owned()),
            reusable_worktree,
            reconciliation_owner_epoch: Some(current_owner.owner_epoch()),
        };
        let revision = self.pool.as_ref().map(WorkerPool::revision)
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?;
        let delivery_id = format!("worker-managed-reconcile-{worker_id}");
        self.apply(revision, &delivery_id, WorkerCommand::ManagedLogicalSettled { event })?;
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
                    || proof.workspace_binding() != pins.workspace_binding() || proof.session_id() != pins.session_id()
                    || proof.location_id() != pins.location_id || proof.process_incarnation() != pins.process_incarnation
                    || proof.accepted_spec_digest() != pins.accepted_spec_digest
                {
                    return Err(WorkerDurableError::Conflict("root coordinator proof is stale or outside child scope"));
                }
            }
            ManagedParentProofV1::ClaimedWorker(proof) => {
                if proof.owner_log_id() != cursor.owner_id || proof.owner_log_sequence() != cursor.seq
                    || proof.owner_log_event_digest() != cursor.event_digest || proof.worker_pool_revision() != revision
                    || proof.goal_id() != pins.goal_id || proof.owner_epoch() != self.resumed_epoch
                    || proof.owner.principal_ref != pins.principal_ref()
                    || proof.owner.workspace_binding != pins.workspace_binding()
                    || proof.owner.session_id != pins.session_id() || proof.owner.run_id != pins.run_id()
                {
                    return Err(WorkerDurableError::Conflict("claimed parent proof is stale or outside child scope"));
                }
                let owner = AuthenticatedOwnerContext::rehydrate_from_durable_scope(
                    proof.owner.principal_ref.clone(), proof.owner.workspace_binding.clone(),
                    proof.owner.session_id.clone(), proof.owner.run_id.clone(), proof.owner.task_id.clone(),
                    proof.owner.attempt_id.clone(), proof.owner.owner_epoch,
                ).map_err(|_| WorkerDurableError::Invalid("parent owner proof invalid"))?;
                let binding = VerifiedAttemptBinding::from_managed_attempt(
                    proof.goal_id.clone(), proof.owner.run_id.clone(), proof.owner.task_id.clone(),
                    proof.owner.attempt_id.clone(), proof.owner.owner_epoch, proof.source_revision.clone(),
                    proof.accepted_spec_digest.clone(), BindingAttemptPhase::Executing,
                )?;
                self.validate_active_parent_execution_proof(proof, &binding, &owner, now_ms)?;
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
        if delivery_id.is_empty() || delivery_id.len() > 256
            || delivery_id.chars().any(char::is_control)
            || self.deliveries.contains_key(delivery_id)
        {
            return Err(WorkerDurableError::Conflict("dispatch delivery is invalid or already used"));
        }
        let proof = self.resolve_authenticated_managed_lease_proof(
            binding, owner, location_id, process_incarnation, now_ms,
        )?;
        if proof.worker_state() != crate::resource_budget::ReservationState::Claimed
            || proof.process_identity().is_some()
            || proof.delegation_binding_digest() != Some(delegation_binding_digest)
        {
            return Err(WorkerDurableError::Conflict("worker is not durably claimed for this delegation"));
        }
        // The real projection stays unchanged until BindProcess commits. The
        // already-durable CLAIMED record covers a crash at any launch point.
        let mut dispatch_view = self.pool.as_ref()
            .ok_or(WorkerDurableError::Invalid("worker pool unavailable"))?.clone();
        let process = match dispatch_view.dispatch_isolated_worker(
            proof.worker_execution_id(), launcher, owner, proof.worker_pool_revision(),
        ) {
            Ok(process) => process,
            Err(error) => {
                let quarantine = self.apply(proof.worker_pool_revision(), delivery_id,
                    WorkerCommand::QuarantineWorker {
                        scope: OwnerScopeKey::from_owner(owner),
                        worker_execution_id: proof.worker_execution_id().to_owned(),
                    });
                if let Err(persist_error) = quarantine {
                    if let Some(pool) = self.pool.as_mut() { pool.close_fan_out(); }
                    return Err(persist_error);
                }
                return Err(error.into());
            }
        };
        if let Err(error) = self.apply(proof.worker_pool_revision(), delivery_id,
            WorkerCommand::BindProcess {
                scope: OwnerScopeKey::from_owner(owner),
                worker_execution_id: proof.worker_execution_id().to_owned(),
                process_identity: process.clone(),
            })
        {
            // P1 retains its supervised process and target receipt. Refuse all
            // future dispatch if the process-bind append is ambiguous; restart
            // recovery quarantines the durable claim without relaunching.
            if let Some(pool) = self.pool.as_mut() { pool.close_fan_out(); }
            return Err(error);
        }
        Ok(process)
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
    pub fn update_capacity(
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
                next
            }
        };
        let mut next_worktree_operations = self.worktree_operations.clone();
        apply_worktree_journal_command(&mut next_worktree_operations, &command)?;
        let mut next_identities = self.identities.clone();
        apply_worker_identity_command(&mut next_identities, &next, &next_worktree_operations, &command)?;
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
                apply_worker_identity_command(
                    &mut self.identities,
                    self.pool.as_ref().ok_or(WorkerDurableError::Invalid("worker pool missing"))?,
                    &self.worktree_operations,
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
                apply_worktree_journal_command(&mut self.worktree_operations, &command)?;
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
        "permissionScopeDigest": pins.permission_scope_digest,
        "contextSelectionDigest": pins.context_selection_digest,
        "acceptedScopeDigest": pins.accepted_scope_digest,
        "capabilityCeilingDigest": pins.capability_ceiling_digest,
        "specMaxWorkers": pins.spec_max_workers.to_string(),
        "dimension": pins.dimension.wire_name(),
        "amount": pins.amount,
        "expiresAtMs": pins.expires_at_ms,
        "worktree": {"worktreeId": pins.worktree.worktree_id, "baseRevision": pins.worktree.base_revision},
        "worktreePoolRevision": pins.worktree_pool_revision.to_string(),
        "idempotencyKey": pins.idempotency_key,
        "parentProof": parent,
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

fn decode_trusted_pre_admission(value: &Value) -> Result<TrustedPreAdmissionPinsV1, WorkerDurableError> {
    if value.as_object().map(|object| object.len()) != Some(25) {
        return Err(WorkerDurableError::Invalid("invalid pre-admission pin shape"));
    }
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
        permission_scope_digest: text(value, "permissionScopeDigest")?,
        context_selection_digest: text(value, "contextSelectionDigest")?,
        accepted_scope_digest: text(value, "acceptedScopeDigest")?,
        capability_ceiling_digest: text(value, "capabilityCeilingDigest")?,
        spec_max_workers: text(value, "specMaxWorkers")?.parse()
            .map_err(|_| WorkerDurableError::Invalid("invalid Spec maxWorkers pin"))?,
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
                || worker.attempt_revision != pins.workspace_revision
                || worker.accepted_spec_digest != pins.accepted_spec_digest
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
                || root_owner.session_id() != pins.session_id()
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
        ManagedParentProofV1, RootCoordinatorExecutionProofV1,
        RootCoordinatorExecutionV1, TrustedPreAdmissionPinsV1, WorkerCommand,
        WorkerDurableError, managed_task_attempt_candidate_id,
    };
    use crate::resource_budget::{AuthenticatedOwnerContext, BudgetDimension};
    use crate::resource_sampler::ProcessIdentity;
    use crate::worker_pool::{WorkerPool, WorkerPoolConfig};
    use crate::worktree_pool::WorktreeRegistration;
    use serde_json::json;

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
            "server_auth:owner-v1", "workspace-v1", "session-v1", "run-v1",
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
        assert_eq!(pins.dimension(), BudgetDimension::ActiveWorkers);
        assert_eq!(pins.amount(), 1);
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
}
