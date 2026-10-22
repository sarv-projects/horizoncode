//! Bounded, Rust-owned worker pool and worker-lease lifecycle.
//!
//! One WorkerExecution corresponds to at most one admitted Attempt of one
//! Ready Task. This module composes the canonical reservation owner
//! ([`crate::resource_budget::ResourceReservationOwner`]) and the worktree
//! lease pool ([`crate::worktree_pool::WorktreePool`]) so that capacity,
//! workspace and Attempt admission are reserved in one deterministic step
//! (§21.11 `AcquireResourceLease`). It is a process-local state machine, not a
//! scheduler authority, process supervisor or Guard bypass:
//!
//! - a queue ticket, reservation ID, lease ID, owner epoch or
//!   `WorkerBudgetRef` is a reference and never authorization;
//! - fan-out is **closed until the authenticated single-Attempt binding owner
//!   (C15 `managed.v1`) installs the binding and opens the gate**; the opaque
//!   [`VerifiedAttemptBinding`] cannot be constructed outside trusted,
//!   crate-internal ingress code;
//! - every ticket/reservation additionally carries the canonical managed Goal
//!   ID supplied by that trusted coordinator, and admission requires it to
//!   equal the crate-internal binding's `goal_id()`: Task/Attempt identifiers
//!   are only unique within one Goal, so an equal-looking binding for another
//!   Goal fails as `GoalBindingMismatch` before any ticket, capacity, worktree
//!   or worker-record change;
//! - V1 managed WorkerExecution is a logical child Core Session/Attempt in the
//!   shared Core process. It does not launch or claim a worker-specific PID;
//!   effects still cross Guard/ExecutionHost under the Attempt lease;
//! - the process-backed launcher and PID binding below are a disabled legacy/
//!   future mode. V1 logical capacity is released only by opaque terminal,
//!   effect-receipt and prompt-quiescence proof; any uncertainty quarantines
//!   its conservative reservation. A future process-backed mode must also
//!   prove exit of its exact OS process generation.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use crate::resource_budget::{
    AuthenticatedOwnerContext, BudgetDimension, Capacity, ReservationProof, ReservationRequest,
    ReservationState, ResourceOwnerError, ResourceReservationOwner,
};
use crate::resource_sampler::ProcessIdentity;
use crate::worktree_lifecycle::WorktreeRootOwnerV1;
use crate::worktree_pool::{
    SettlementEvidence as WorktreeSettlementEvidence, WorktreeLease, WorktreePool,
    WorktreePoolError, WorktreeRegistration, WorktreeSnapshot, WorktreeStatus,
};

/// §32.32/§29.18: a 21st concurrent worker beyond the configured 20 limit is
/// rejected unless an explicit architecture decision raises this bound.
pub const MAX_LIVE_WORKERS: usize = 20;
pub const MAX_QUEUED_TICKETS: usize = 256;
/// Bounded audit history; deliberately below the worktree lease-history bound.
pub const MAX_WORKER_RECORDS: usize = 2048;
pub(crate) const MAX_WORKER_LEASE_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_ID_LENGTH: usize = 128;
const MAX_REF_LENGTH: usize = 256;
const MAX_EVIDENCE_REFS: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerPoolError {
    InvalidConfiguration,
    InvalidRequest,
    StaleRevision,
    StaleOwnerEpoch,
    ScopeMismatch,
    IdempotencyConflict,
    QueueLimitReached,
    LiveWorkerLimitReached,
    WorkerRecordLimitReached,
    TicketNotFound,
    TicketExpired,
    TicketFenced,
    FanOutClosed,
    /// The authenticated binding belongs to a different managed Goal than the
    /// admitted ticket. Task/Attempt identifiers are only unique within one
    /// Goal, so this can never be treated as the same work.
    GoalBindingMismatch,
    AttemptBindingMismatch,
    AttemptRevisionMismatch,
    AttemptConflict,
    CapacityUnknown,
    InsufficientCapacity,
    WorkerNotFound,
    InvalidTransition,
    MissingProof,
    NotExpired,
    WorkerIdentityConflict,
    ProcessIdentityMismatch,
    WorktreeRequired,
    WorktreeUnavailable,
    WrongWorkerClass,
    ReuseIncompatible,
    ReservationNotFound,
    Worktree(WorktreePoolError),
    Reservation(ResourceOwnerError),
    /// Internal invariant failure. A correct path never returns this; state is
    /// left inspectable and no capacity is silently freed.
    Internal,
}

impl From<WorktreePoolError> for WorkerPoolError {
    fn from(error: WorktreePoolError) -> Self {
        Self::Worktree(error)
    }
}

impl From<ResourceOwnerError> for WorkerPoolError {
    fn from(error: ResourceOwnerError) -> Self {
        Self::Reservation(error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerClass {
    /// Read-only exploration that may attach to existing Core/provider
    /// infrastructure without allocating a worktree or a new transcript.
    ReadOnlyAttachment,
    /// Untrusted effectful child that needs an isolated workspace. V1 executes
    /// it as a logical Core Session/Attempt; this class does not authorize an
    /// additional process or runtime.
    IsolatedEffectful,
}

/// Stable, digestible view of an authenticated owner scope. It is derived from
/// [`AuthenticatedOwnerContext`] and re-checked against it on every operation.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct OwnerScopeKey {
    pub principal_ref: String,
    pub workspace_binding: String,
    pub session_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub owner_epoch: u64,
}

impl OwnerScopeKey {
    pub fn from_owner(owner: &AuthenticatedOwnerContext) -> Self {
        Self {
            principal_ref: owner.principal_ref().to_owned(),
            workspace_binding: owner.workspace_binding().to_owned(),
            session_id: owner.session_id().to_owned(),
            run_id: owner.run_id().to_owned(),
            task_id: owner.task_id().to_owned(),
            attempt_id: owner.attempt_id().to_owned(),
            owner_epoch: owner.owner_epoch(),
        }
    }

    pub fn matches_owner(&self, owner: &AuthenticatedOwnerContext) -> bool {
        self.owner_epoch == owner.owner_epoch()
            && self.principal_ref == owner.principal_ref()
            && self.workspace_binding == owner.workspace_binding()
            && self.session_id == owner.session_id()
            && self.run_id == owner.run_id()
            && self.task_id == owner.task_id()
            && self.attempt_id == owner.attempt_id()
    }

    /// Same trusted principal, workspace, Session, Run and epoch. Task/Attempt
    /// may differ because a coordinator cancels or reconciles a whole Run.
    pub fn same_run_scope(&self, owner: &AuthenticatedOwnerContext) -> bool {
        self.owner_epoch == owner.owner_epoch()
            && self.principal_ref == owner.principal_ref()
            && self.workspace_binding == owner.workspace_binding()
            && self.session_id == owner.session_id()
            && self.run_id == owner.run_id()
    }

    /// Exact scope match except for the owner epoch. Only fenced old-epoch
    /// records may be settled by the current epoch under this weaker match.
    pub fn matches_owner_ignoring_epoch(&self, owner: &AuthenticatedOwnerContext) -> bool {
        self.principal_ref == owner.principal_ref()
            && self.workspace_binding == owner.workspace_binding()
            && self.session_id == owner.session_id()
            && self.run_id == owner.run_id()
            && self.task_id == owner.task_id()
            && self.attempt_id == owner.attempt_id()
    }
}

/// Attempt phase facts the worker pool accepts. Only a live `EXECUTING`
/// Attempt may reserve fan-out work; every other phase is fail-closed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BindingAttemptPhase {
    /// A HostKernel-minted READY Task pin with a stable candidate Attempt ID.
    /// It reserves capacity but cannot resolve an active lease proof or claim.
    PreAdmission,
    Executing,
}

/// Opaque proof that an authenticated ingress (`managed.v1`, C15 owner)
/// verified an admitted, executing single Attempt for this owner scope.
///
/// Constructing this value is **not** an authentication API: only crate-internal
/// trusted ingress code may call [`VerifiedAttemptBinding::from_managed_attempt`].
/// Until that ingress is wired, no production caller can satisfy
/// [`WorkerPool::reserve`] and fan-out stays closed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedAttemptBinding {
    goal_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    owner_epoch: u64,
    source_revision: String,
    accepted_spec_digest: String,
    phase: BindingAttemptPhase,
}

impl VerifiedAttemptBinding {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_managed_attempt(
        goal_id: String,
        run_id: String,
        task_id: String,
        attempt_id: String,
        owner_epoch: u64,
        source_revision: String,
        accepted_spec_digest: String,
        phase: BindingAttemptPhase,
    ) -> Result<Self, WorkerPoolError> {
        let binding = Self {
            goal_id,
            run_id,
            task_id,
            attempt_id,
            owner_epoch,
            source_revision,
            accepted_spec_digest,
            phase,
        };
        for value in [
            &binding.goal_id,
            &binding.run_id,
            &binding.task_id,
            &binding.attempt_id,
            &binding.source_revision,
        ] {
            validate_id("attempt binding field", value)?;
        }
        validate_digest("accepted SpecVersion digest", &binding.accepted_spec_digest)?;
        if binding.owner_epoch == 0 {
            return Err(WorkerPoolError::InvalidRequest);
        }
        Ok(binding)
    }

    /// Internal bridge used only while replaying/admitting a trusted P8
    /// pre-admission reservation. This phase cannot be used by the public
    /// Attempt lease resolver, which still requires `Executing`.
    pub(crate) fn from_pre_admission_pins(
        pins: &crate::worker_durable::TrustedPreAdmissionPinsV1,
    ) -> Result<Self, WorkerPoolError> {
        let binding = Self {
            goal_id: pins.goal_id().to_owned(),
            run_id: pins.run_id().to_owned(),
            task_id: pins.task_id().to_owned(),
            attempt_id: pins.attempt_id().to_owned(),
            owner_epoch: pins.owner_epoch(),
            source_revision: pins.workspace_revision().to_owned(),
            accepted_spec_digest: pins.accepted_spec_digest().to_owned(),
            phase: BindingAttemptPhase::PreAdmission,
        };
        for value in [
            &binding.goal_id,
            &binding.run_id,
            &binding.task_id,
            &binding.attempt_id,
            &binding.source_revision,
        ] {
            validate_id("pre-admission pin field", value)?;
        }
        validate_digest("pre-admission SpecVersion digest", &binding.accepted_spec_digest)?;
        if binding.owner_epoch == 0 {
            return Err(WorkerPoolError::InvalidRequest);
        }
        Ok(binding)
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn test_fixture(
        goal_id: &str,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        owner_epoch: u64,
        source_revision: &str,
        accepted_spec_digest: &str,
    ) -> Self {
        Self::from_managed_attempt(
            goal_id.to_owned(),
            run_id.to_owned(),
            task_id.to_owned(),
            attempt_id.to_owned(),
            owner_epoch,
            source_revision.to_owned(),
            accepted_spec_digest.to_owned(),
            BindingAttemptPhase::Executing,
        )
        .expect("test binding must be valid")
    }

    pub fn goal_id(&self) -> &str {
        &self.goal_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }

    pub fn source_revision(&self) -> &str {
        &self.source_revision
    }

    pub fn accepted_spec_digest(&self) -> &str {
        &self.accepted_spec_digest
    }

    pub fn phase(&self) -> BindingAttemptPhase {
        self.phase
    }
}

/// Wiring state of the effectful fan-out path. `Closed` is the only initial
/// state; only the trusted host ingress that owns the authenticated
/// single-Attempt binding may open it once the P2 gates are verified.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FanOutState {
    Closed,
    ManagedAttemptBinding,
}

/// Read-only composition of one fan-out worker.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerSnapshot {
    pub worker_execution_id: String,
    pub ticket_id: String,
    pub goal_id: String,
    pub owner: OwnerScopeKey,
    pub class: WorkerClass,
    pub state: ReservationState,
    pub dimension: BudgetDimension,
    pub amount: u64,
    pub cancellation_requested: bool,
    pub unknown_effect: bool,
    pub worktree_lease_id: Option<String>,
    pub process_identity: Option<ProcessIdentity>,
    pub expires_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TicketState {
    Queued,
    Consumed,
    Fenced,
    Expired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeBindingRequest {
    pub worktree_id: String,
    pub base_revision: String,
}

/// Opaque result of P8 selecting a registered, clean worktree for a trusted
/// owner and measured workspace revision. Only WorkerPool can mint it; P1 may
/// carry it into the immutable pre-admission pin but cannot choose its ID/base.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedManagedWorktreeV1 {
    worktree_id: String,
    base_revision: String,
    workspace_binding: String,
    location_id: String,
    source_revision: String,
    pool_revision: u64,
}

impl ResolvedManagedWorktreeV1 {
    pub(crate) fn worktree_id(&self) -> &str { &self.worktree_id }
    pub(crate) fn base_revision(&self) -> &str { &self.base_revision }
    pub(crate) fn workspace_binding(&self) -> &str { &self.workspace_binding }
    pub(crate) fn location_id(&self) -> &str { &self.location_id }
    pub(crate) fn source_revision(&self) -> &str { &self.source_revision }
    pub(crate) fn pool_revision(&self) -> u64 { self.pool_revision }
}

/// A bounded admission request. The ticket is a reference only.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnqueueRequest {
    pub ticket_id: String,
    /// Canonical managed Goal this ticket belongs to, supplied by the trusted
    /// coordinator from the authenticated managed request. It is a comparison
    /// fact, never authorization: [`WorkerPool::reserve`] additionally requires
    /// it to equal the crate-internal binding's `goal_id()`.
    pub goal_id: String,
    pub idempotency_key: String,
    pub dimension: BudgetDimension,
    pub amount: u64,
    pub expires_at_ms: u64,
    /// Accepted Task revision this ticket was frozen against. The eventual
    /// Attempt binding must prove execution against this same revision.
    pub expected_task_revision: String,
    /// Accepted SpecVersion digest the ticket was frozen against; a binding for
    /// any other accepted spec can never admit this ticket.
    pub accepted_spec_digest: String,
    pub class: WorkerClass,
    pub worktree: Option<WorktreeBindingRequest>,
    /// Opaque lineage from the trusted durable worker owner. Root coordinator
    /// tasks have no parent worker; nested child delivery must include this.
    pub parent_execution: Option<ParentExecutionLineageV1>,
}

/// Durable parent→child edge carried by the enqueue OwnerLog event. Its fields
/// are private so request decoders cannot assert parent identity; only a
/// current proof from WorkerPoolControl can construct it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParentExecutionLineageV1 {
    worker_execution_id: String,
    goal_id: String,
    owner: OwnerScopeKey,
    source_revision: String,
    accepted_spec_digest: String,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    process_identity: ProcessIdentity,
}

impl ParentExecutionLineageV1 {
    pub(crate) fn from_owner_log_facts(
        worker_execution_id: String,
        goal_id: String,
        owner: OwnerScopeKey,
        source_revision: String,
        accepted_spec_digest: String,
        owner_log_id: String,
        owner_log_sequence: String,
        owner_log_event_digest: String,
        worker_pool_revision: u64,
        process_identity: ProcessIdentity,
    ) -> Result<Self, WorkerPoolError> {
        validate_id("parent worker execution ID", &worker_execution_id)?;
        validate_id("parent Goal ID", &goal_id)?;
        validate_id("parent source revision", &source_revision)?;
        validate_digest("parent accepted Spec digest", &accepted_spec_digest)?;
        if owner_log_id.is_empty()
            || owner_log_sequence.parse::<u64>().is_err()
            || !owner_log_event_digest.starts_with("blake3:")
            || worker_pool_revision == 0
            || process_identity.pid == 0
            || process_identity.start_identity == 0
        {
            return Err(WorkerPoolError::InvalidRequest);
        }
        Ok(Self {
            worker_execution_id,
            goal_id,
            owner,
            source_revision,
            accepted_spec_digest,
            owner_log_id,
            owner_log_sequence,
            owner_log_event_digest,
            worker_pool_revision,
            process_identity,
        })
    }

    pub(crate) fn worker_execution_id(&self) -> &str {
        &self.worker_execution_id
    }
    pub(crate) fn goal_id(&self) -> &str {
        &self.goal_id
    }
    pub(crate) fn owner(&self) -> &OwnerScopeKey {
        &self.owner
    }
    pub(crate) fn source_revision(&self) -> &str {
        &self.source_revision
    }
    pub(crate) fn accepted_spec_digest(&self) -> &str {
        &self.accepted_spec_digest
    }
    pub(crate) fn owner_log_id(&self) -> &str {
        &self.owner_log_id
    }
    pub(crate) fn owner_log_sequence(&self) -> &str {
        &self.owner_log_sequence
    }
    pub(crate) fn owner_log_event_digest(&self) -> &str {
        &self.owner_log_event_digest
    }
    pub(crate) fn worker_pool_revision(&self) -> u64 {
        self.worker_pool_revision
    }
    pub(crate) fn process_identity(&self) -> &ProcessIdentity {
        &self.process_identity
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueueTicket {
    pub ticket_id: String,
    pub goal_id: String,
    pub owner: OwnerScopeKey,
    pub expected_task_revision: String,
    pub accepted_spec_digest: String,
    pub dimension: BudgetDimension,
    pub amount: u64,
    pub expires_at_ms: u64,
    pub class: WorkerClass,
    pub worktree: Option<WorktreeBindingRequest>,
    pub parent_execution: Option<ParentExecutionLineageV1>,
    pub state: TicketState,
    pub worker_execution_id: Option<String>,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerLeaseView {
    pub worker_execution_id: String,
    pub ticket_id: String,
    pub goal_id: String,
    pub state: ReservationState,
    pub dimension: BudgetDimension,
    pub amount: u64,
    pub worktree_lease_id: Option<String>,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
}

/// Provider/harness/environment snapshot a warm reuse decision is keyed on
/// (§21.11 "Worker reuse"). Any mismatch requires a fresh isolated worker.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerReuseKey {
    pub principal_ref: String,
    pub workspace_binding: String,
    pub trust_profile: String,
    pub sandbox_profile: String,
    pub provider_selection_digest: String,
    pub harness_digest: String,
    pub environment_digest: String,
    pub policy_epoch: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerSettlementOutcome {
    Settled,
    Unknown,
    Blocked,
}

/// Workspace facts a settled worker reports so its worktree lease can be
/// released instead of quarantined. Absent facts keep the lease conservative.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeSettlementFacts {
    pub observed_revision: Option<String>,
    pub clean: Option<bool>,
    pub has_untracked: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerSettlement {
    pub outcome: WorkerSettlementOutcome,
    pub process_identity: Option<ProcessIdentity>,
    pub owned_process_exited: bool,
    pub effects_settled: bool,
    pub reconciliation_complete: bool,
    pub evidence_refs: Vec<String>,
    pub external_effect_refs: Vec<String>,
    /// Present only when the workspace owner verified the final workspace fact.
    pub worktree: Option<WorktreeSettlementFacts>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerSettlementResult {
    Released,
    Quarantined,
    Blocked,
}

/// Reconciliation proof for a quarantined worker. All three facts are the
/// canonical §11.20 proof flags and cannot be inferred from a sample.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ReconciliationProof {
    pub owned_process_exited: bool,
    pub effects_settled: bool,
    pub reconciliation_complete: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CancelScope {
    Run {
        run_id: String,
    },
    Task {
        run_id: String,
        task_id: String,
    },
    Attempt {
        run_id: String,
        task_id: String,
        attempt_id: String,
    },
    Worker {
        worker_execution_id: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CancellationFence {
    pub fence_epoch: u64,
    pub fenced_tickets: usize,
    pub fenced_workers: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RecoveryReport {
    pub quarantined_workers: usize,
    pub expired_workers: usize,
    pub fenced_tickets: usize,
}

/// Real launch port, owned by the Guard/ExecutionHost boundary. The worker pool
/// never spawns processes; it only records the claim and binds the OS process
/// generation this port returns after a Guarded launch.
pub trait IsolatedWorkerLauncher {
    fn launch(&mut self, permit: &LaunchPermit) -> Result<ProcessIdentity, WorkerPoolError>;
}

/// Everything a Guarded launcher needs. Possession is still not permission:
/// the launcher must run its own Guard pre-dispatch checks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchPermit {
    pub worker_execution_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub owner_epoch: u64,
    pub workspace_binding: String,
    pub worktree_path: Option<PathBuf>,
    pub base_revision: Option<String>,
    pub source_revision: String,
    pub accepted_spec_digest: String,
}

/// Distinguishes live ingress application from OwnerLog replay. Replay must
/// not re-evaluate derived telemetry gates (capacity samples, quota, worker
/// caps) that were already decided when the command was first committed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApplyMode {
    Live,
    Replay,
}

/// Bounds for one machine-scope worker pool. The pool deliberately does *not*
/// bind a single Goal: `ResourceReservationOwner` accounts machine-wide
/// capacity shared by every Goal this kernel serves. The canonical Goal ID
/// lives on each [`QueueTicket`]/reservation and must equal the crate-internal
/// binding's `goal_id()`, so cross-Goal identifier collisions can never admit
/// work while capacity stays globally accounted.
#[derive(Clone, Copy, Debug)]
pub struct WorkerPoolConfig {
    pub owner_epoch: u64,
    pub max_live_workers: usize,
    pub max_queued_tickets: usize,
    pub max_worktrees: usize,
}

#[derive(Clone, Debug)]
struct WorkerRecord {
    ticket_id: String,
    goal_id: String,
    owner: OwnerScopeKey,
    class: WorkerClass,
    dimension: BudgetDimension,
    amount: u64,
    state: ReservationState,
    reservation_id: String,
    attempt_revision: String,
    /// P8's parent/root workspace head remains in `attempt_revision`; this
    /// separate HostKernel-measured child head is attached with DelegationBound.
    child_workspace_revision: Option<String>,
    accepted_spec_digest: String,
    worktree_lease_id: Option<String>,
    worktree_quarantined: bool,
    process_identity: Option<ProcessIdentity>,
    cancellation_requested: bool,
    unknown_effect: bool,
    reuse_key: Option<WorkerReuseKey>,
    settlement: Option<WorkerSettlement>,
    expires_at_ms: u64,
}

/// Bounded process-local worker pool. Clone-apply-commit durable adapters
/// ([`crate::worker_durable`]) clone this value, apply one command, then append
/// the command to the OwnerLog before publishing the new value.
#[derive(Clone, Debug)]
pub struct WorkerPool {
    owner_epoch: u64,
    revision: u64,
    max_live_workers: usize,
    max_queued_tickets: usize,
    max_worktrees: usize,
    fan_out: FanOutState,
    fence_epoch: u64,
    reservations: ResourceReservationOwner,
    worktrees: WorktreePool,
    tickets: BTreeMap<String, QueueTicket>,
    ticket_idempotency: HashMap<(String, String), String>,
    workers: BTreeMap<String, WorkerRecord>,
}

/// Owner-checked durable lease facts used only by `WorkerPoolControl` to mint
/// a proof after it has replayed the canonical worker OwnerLog. This value is
/// intentionally crate-private and contains no filesystem-currentness claim;
/// HostKernel must re-resolve the live workspace and Guard scope before use.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DurableWorkerLeaseFactsV1 {
    worker_execution_id: String,
    goal_id: String,
    ticket_id: String,
    principal_ref: String,
    workspace_binding: String,
    session_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    owner_epoch: u64,
    source_revision: String,
    accepted_spec_digest: String,
    workspace_lease_id: String,
    budget_lease_id: String,
    resource_lease_ids: Vec<String>,
    worker_state: ReservationState,
    budget_dimension: BudgetDimension,
    reserved_amount: u64,
    expires_at_ms: u64,
    process_identity: Option<ProcessIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ActiveParentExecutionFactsV1 {
    worker_execution_id: String,
    goal_id: String,
    owner: OwnerScopeKey,
    source_revision: String,
    accepted_spec_digest: String,
    process_identity: ProcessIdentity,
}

impl ActiveParentExecutionFactsV1 {
    pub(crate) fn worker_execution_id(&self) -> &str {
        &self.worker_execution_id
    }
    pub(crate) fn goal_id(&self) -> &str {
        &self.goal_id
    }
    pub(crate) fn owner(&self) -> &OwnerScopeKey {
        &self.owner
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
}

impl DurableWorkerLeaseFactsV1 {
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
    ) -> Self {
        Self {
            worker_execution_id: worker_execution_id.to_owned(),
            goal_id: goal_id.to_owned(),
            ticket_id: ticket_id.to_owned(),
            principal_ref: owner.principal_ref().to_owned(),
            workspace_binding: owner.workspace_binding().to_owned(),
            session_id: owner.session_id().to_owned(),
            run_id: owner.run_id().to_owned(),
            task_id: owner.task_id().to_owned(),
            attempt_id: owner.attempt_id().to_owned(),
            owner_epoch: owner.owner_epoch(),
            source_revision: binding.source_revision().to_owned(),
            accepted_spec_digest: binding.accepted_spec_digest().to_owned(),
            workspace_lease_id: workspace_lease_id.to_owned(),
            budget_lease_id: budget_lease_id.to_owned(),
            resource_lease_ids,
            worker_state: ReservationState::Reserved,
            budget_dimension: BudgetDimension::MemoryBytes,
            reserved_amount: 1,
            expires_at_ms: u64::MAX,
            process_identity: None,
        }
    }

    pub(crate) fn worker_execution_id(&self) -> &str {
        &self.worker_execution_id
    }
    pub(crate) fn goal_id(&self) -> &str {
        &self.goal_id
    }
    pub(crate) fn ticket_id(&self) -> &str {
        &self.ticket_id
    }
    pub(crate) fn principal_ref(&self) -> &str {
        &self.principal_ref
    }
    pub(crate) fn workspace_binding(&self) -> &str {
        &self.workspace_binding
    }
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }
    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }
    pub(crate) fn task_id(&self) -> &str {
        &self.task_id
    }
    pub(crate) fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
    pub(crate) fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }
    pub(crate) fn source_revision(&self) -> &str {
        &self.source_revision
    }
    pub(crate) fn accepted_spec_digest(&self) -> &str {
        &self.accepted_spec_digest
    }
    pub(crate) fn workspace_lease_id(&self) -> &str {
        &self.workspace_lease_id
    }
    pub(crate) fn budget_lease_id(&self) -> &str {
        &self.budget_lease_id
    }
    pub(crate) fn resource_lease_ids(&self) -> &[String] {
        &self.resource_lease_ids
    }
    pub(crate) fn worker_state(&self) -> ReservationState {
        self.worker_state
    }
    pub(crate) fn budget_dimension(&self) -> BudgetDimension {
        self.budget_dimension
    }
    pub(crate) fn reserved_amount(&self) -> u64 {
        self.reserved_amount
    }
    pub(crate) fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
    pub(crate) fn process_identity(&self) -> Option<&ProcessIdentity> {
        self.process_identity.as_ref()
    }
}

impl WorkerPool {
    pub fn new(config: WorkerPoolConfig) -> Result<Self, WorkerPoolError> {
        if config.owner_epoch == 0
            || config.max_live_workers == 0
            || config.max_live_workers > MAX_LIVE_WORKERS
            || config.max_queued_tickets == 0
            || config.max_queued_tickets > MAX_QUEUED_TICKETS
            || config.max_worktrees == 0
            || config.max_worktrees > config.max_live_workers
        {
            return Err(WorkerPoolError::InvalidConfiguration);
        }
        let mut reservations = ResourceReservationOwner::new(config.owner_epoch, MAX_WORKER_RECORDS)?;
        // ActiveWorkers is a Rust scheduling ceiling, not an OS resource quota.
        // Rebuilt as zero measured usage on replay; durable reservation rows
        // then account every live worker exactly once.
        reservations.update_capacity(
            BudgetDimension::ActiveWorkers,
            Some(config.max_live_workers as u64),
            Some(0),
            0,
            config.owner_epoch,
            1,
            0,
        )?;
        let worktrees = WorktreePool::new(
            config.owner_epoch,
            config.max_worktrees,
            config.max_worktrees,
        )?;
        Ok(Self {
            owner_epoch: config.owner_epoch,
            revision: 0,
            max_live_workers: config.max_live_workers,
            max_queued_tickets: config.max_queued_tickets,
            max_worktrees: config.max_worktrees,
            fan_out: FanOutState::Closed,
            fence_epoch: 0,
            reservations,
            worktrees,
            tickets: BTreeMap::new(),
            ticket_idempotency: HashMap::new(),
            workers: BTreeMap::new(),
        })
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }

    pub fn limits(&self) -> WorkerPoolConfig {
        WorkerPoolConfig {
            owner_epoch: self.owner_epoch,
            max_live_workers: self.max_live_workers,
            max_queued_tickets: self.max_queued_tickets,
            max_worktrees: self.max_worktrees,
        }
    }

    /// Resolve a worktree only from P8's durable registry. A clean/current
    /// candidate must match the HostKernel-measured content revision and the
    /// authenticated Goal workspace; a missing or busy candidate is unavailable.
    pub(crate) fn resolve_managed_worktree(
        &self,
        owner: &AuthenticatedOwnerContext,
        location_id: &str,
        workspace_revision: &str,
        verified_worktree_ids: &std::collections::BTreeSet<String>,
    ) -> Result<ResolvedManagedWorktreeV1, WorkerPoolError> {
        self.check_owner(owner)?;
        validate_id("managed worktree location", location_id)?;
        let (worktree_id, base_revision) = self.worktrees
            .resolve_clean_registered(owner, workspace_revision, verified_worktree_ids)?;
        Ok(ResolvedManagedWorktreeV1 {
            worktree_id,
            base_revision,
            workspace_binding: owner.workspace_binding().to_owned(),
            location_id: location_id.to_owned(),
            source_revision: workspace_revision.to_owned(),
            pool_revision: self.revision,
        })
    }

    pub fn fan_out_state(&self) -> FanOutState {
        self.fan_out
    }

    pub fn capacity(&self, dimension: BudgetDimension) -> Capacity {
        self.reservations.capacity(dimension)
    }

    /// Opens the effectful fan-out gate. Only the authenticated host ingress
    /// that verifies the managed single-Attempt binding (C15 `managed.v1`) may
    /// call this, after the P2 gates pass; the binding is still required per
    /// request, so opening the gate alone authorizes nothing.
    #[allow(dead_code)]
    pub(crate) fn enable_managed_attempt_fan_out(
        &mut self,
        owner_epoch: u64,
    ) -> Result<(), WorkerPoolError> {
        if owner_epoch != self.owner_epoch {
            return Err(WorkerPoolError::StaleOwnerEpoch);
        }
        self.fan_out = FanOutState::ManagedAttemptBinding;
        Ok(())
    }

    /// Reconstruction-only gate close used after OwnerLog replay: new work
    /// still requires explicit ingress re-authorization.
    pub(crate) fn close_fan_out(&mut self) {
        self.fan_out = FanOutState::Closed;
    }

    /// Counts the durable `PoolOpened` command so the first live CAS revision
    /// is 1 and command replay stays revision-comparable.
    pub(crate) fn mark_opened(&mut self) -> Result<u64, WorkerPoolError> {
        if self.revision != 0 {
            return Err(WorkerPoolError::InvalidTransition);
        }
        let revision = self.next_revision()?;
        self.revision = revision;
        Ok(revision)
    }

    /// Internal telemetry primitive. External callers cannot nominate a
    /// capacity limit or usage sample; authenticated HostKernel ingress must
    /// validate owner policy and observation before this can be exposed.
    pub(crate) fn update_capacity(
        &mut self,
        dimension: BudgetDimension,
        hard_limit: Option<u64>,
        measured_total: Option<u64>,
        safety_reserve: u64,
        owner_epoch: u64,
        sample_sequence: u64,
        expected_revision: u64,
    ) -> Result<u64, WorkerPoolError> {
        if dimension == BudgetDimension::ActiveWorkers {
            return Err(WorkerPoolError::InvalidRequest);
        }
        self.check_epoch(owner_epoch)?;
        self.check_revision(expected_revision)?;
        // The inner reservation owner keeps the epoch it was created with; the
        // pool-level epoch fence is enforced by `check_epoch` above.
        self.reservations.update_capacity(
            dimension,
            hard_limit,
            measured_total,
            safety_reserve,
            self.reservations.owner_epoch(),
            sample_sequence,
            self.reservations.revision(),
        )?;
        // Capacity samples are derived telemetry, not OwnerLog commands. They
        // update the in-memory reservation view but must not consume the pool's
        // durable CAS revision: replay cannot reconstruct this sample without
        // a corresponding persisted event.
        Ok(self.revision)
    }

    /// Records sample-derived worker memory against the matching machine
    /// capacity sequence. The opaque sample is minted only by the durable
    /// process sampler; this path is not available from request payloads.
    pub(crate) fn record_attributed_memory_usage(
        &mut self,
        usage: &crate::resource_sampler::AttributedWorkerUsageV1,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<u64, WorkerPoolError> {
        self.check_owner(owner)?;
        self.check_revision(expected_revision)?;
        let record = self
            .workers
            .get(usage.worker_execution_id())
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        if record.owner != OwnerScopeKey::from_owner(owner)
            || owner.task_id() != usage.task_id()
            || owner.attempt_id() != usage.attempt_id()
            || record.process_identity.as_ref() != Some(usage.process_identity())
            || !matches!(
                record.state,
                ReservationState::Claimed
                    | ReservationState::ReleasePending
                    | ReservationState::Quarantined
            )
        {
            return Err(WorkerPoolError::ScopeMismatch);
        }
        // Resource telemetry is persisted by the P8 OwnerLog command and does
        // not debit admission capacity or imply an OS-enforced quota.
        Ok(self.revision)
    }

    pub fn register_worktree(
        &mut self,
        registration: WorktreeRegistration,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_owner(owner)?;
        self.check_revision(expected_revision)?;
        if registration.workspace_binding != owner.workspace_binding() {
            return Err(WorkerPoolError::ScopeMismatch);
        }
        let worktree_revision = self.worktrees.revision();
        self.worktrees
            .register(registration, owner, worktree_revision)?;
        let revision = self.next_revision()?;
        self.revision = revision;
        Ok(())
    }

    pub(crate) fn register_verified_root_worktree(
        &mut self,
        registration: WorktreeRegistration,
        owner: &WorktreeRootOwnerV1,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_revision(expected_revision)?;
        if owner.owner_epoch() != self.owner_epoch
            || registration.workspace_binding != owner.workspace_binding()
        {
            return Err(WorkerPoolError::ScopeMismatch);
        }
        let worktree_revision = self.worktrees.revision();
        self.worktrees.register_root_owned(registration, owner, worktree_revision)?;
        self.revision = self.next_revision()?;
        Ok(())
    }

    pub(crate) fn remove_verified_root_worktree(
        &mut self,
        worktree_id: &str,
        owner: &WorktreeRootOwnerV1,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_revision(expected_revision)?;
        if owner.owner_epoch() != self.owner_epoch {
            return Err(WorkerPoolError::StaleOwnerEpoch);
        }
        self.worktrees.mark_removed_root_owned(worktree_id, owner, self.worktrees.revision())?;
        self.revision = self.next_revision()?;
        Ok(())
    }

    pub(crate) fn worktree_snapshot(&self, worktree_id: &str) -> Option<WorktreeSnapshot> {
        self.worktrees.snapshot(worktree_id)
    }

    pub fn enqueue(
        &mut self,
        request: EnqueueRequest,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<QueueTicket, WorkerPoolError> {
        let parent_source_revision = request.expected_task_revision.clone();
        self.enqueue_with_parent_revision(request, owner, expected_revision, &parent_source_revision)
    }

    pub(crate) fn enqueue_pre_admission(
        &mut self,
        request: EnqueueRequest,
        pins: &crate::worker_durable::TrustedPreAdmissionPinsV1,
        expected_revision: u64,
    ) -> Result<QueueTicket, WorkerPoolError> {
        if request.expected_task_revision != pins.task_revision() {
            return Err(WorkerPoolError::AttemptRevisionMismatch);
        }
        self.enqueue_with_parent_revision(
            request,
            pins.owner(),
            expected_revision,
            pins.workspace_revision(),
        )
    }

    fn enqueue_with_parent_revision(
        &mut self,
        request: EnqueueRequest,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
        parent_source_revision: &str,
    ) -> Result<QueueTicket, WorkerPoolError> {
        self.check_owner(owner)?;
        validate_enqueue(&request)?;
        let idempotency_key = (
            owner.attempt_id().to_owned(),
            request.idempotency_key.clone(),
        );
        if let Some(existing_id) = self.ticket_idempotency.get(&idempotency_key) {
            let existing = self
                .tickets
                .get(existing_id)
                .ok_or(WorkerPoolError::TicketNotFound)?;
            if existing.owner.matches_owner(owner)
                && existing.ticket_id == request.ticket_id
                && existing.goal_id == request.goal_id
                && existing.expected_task_revision == request.expected_task_revision
                && existing.accepted_spec_digest == request.accepted_spec_digest
                && existing.dimension == request.dimension
                && existing.amount == request.amount
                && existing.expires_at_ms == request.expires_at_ms
                && existing.class == request.class
                && existing.worktree == request.worktree
                && existing.parent_execution == request.parent_execution
            {
                return Ok(existing.clone());
            }
            return Err(WorkerPoolError::IdempotencyConflict);
        }
        self.check_revision(expected_revision)?;
        if let Some(parent) = request.parent_execution.as_ref() {
            self.validate_parent_lineage(
                parent,
                owner,
                &request.goal_id,
                parent_source_revision,
                &request.accepted_spec_digest,
                expected_revision,
                true,
                0,
            )?;
        }
        if self.tickets.contains_key(&request.ticket_id) {
            return Err(WorkerPoolError::IdempotencyConflict);
        }
        let queued = self
            .tickets
            .values()
            .filter(|ticket| ticket.state == TicketState::Queued)
            .count();
        if queued >= self.max_queued_tickets {
            return Err(WorkerPoolError::QueueLimitReached);
        }
        if request.class == WorkerClass::IsolatedEffectful && request.worktree.is_none() {
            // Effectful children require an isolated workspace; a read-only
            // attachment never does.
            return Err(WorkerPoolError::WorktreeRequired);
        }
        if request.class == WorkerClass::ReadOnlyAttachment && request.worktree.is_some() {
            return Err(WorkerPoolError::WrongWorkerClass);
        }
        let revision = self.next_revision()?;
        let ticket = QueueTicket {
            ticket_id: request.ticket_id.clone(),
            goal_id: request.goal_id,
            owner: OwnerScopeKey::from_owner(owner),
            expected_task_revision: request.expected_task_revision,
            accepted_spec_digest: request.accepted_spec_digest,
            dimension: request.dimension,
            amount: request.amount,
            expires_at_ms: request.expires_at_ms,
            class: request.class,
            worktree: request.worktree,
            parent_execution: request.parent_execution,
            state: TicketState::Queued,
            worker_execution_id: None,
            idempotency_key: request.idempotency_key,
        };
        self.tickets
            .insert(ticket.ticket_id.clone(), ticket.clone());
        self.ticket_idempotency
            .insert(idempotency_key, ticket.ticket_id.clone());
        self.revision = revision;
        Ok(ticket)
    }

    /// Atomically reserves capacity, the optional worktree lease and the single
    /// Attempt admission identity. The authenticated binding replaces the
    /// caller-supplied ticket/epoch as the authorization proof.
    pub fn reserve(
        &mut self,
        ticket_id: &str,
        binding: &VerifiedAttemptBinding,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
        now_ms: u64,
    ) -> Result<WorkerLeaseView, WorkerPoolError> {
        self.reserve_inner(
            ticket_id, binding, worker_execution_id, owner, expected_revision,
            now_ms, false, None, binding.source_revision(),
        )
    }

    /// P8-only reservation before Attempt admission. The pin was minted by
    /// authenticated HostKernel state and includes the exact candidate Attempt
    /// and all immutable profile/spec/context/workspace facts. The resulting
    /// worker remains RESERVED until P1 commits its DelegationBinding and P8
    /// durably attaches that binding digest.
    pub(crate) fn reserve_pre_admission(
        &mut self,
        ticket_id: &str,
        pins: &crate::worker_durable::TrustedPreAdmissionPinsV1,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
        now_ms: u64,
    ) -> Result<WorkerLeaseView, WorkerPoolError> {
        if pins.owner() != owner {
            return Err(WorkerPoolError::ScopeMismatch);
        }
        if pins.dimension() != BudgetDimension::ActiveWorkers || pins.amount() != 1
            || pins.spec_max_workers() == 0 || pins.resource_policy_revision() == 0
            || pins.resource_policy_digest().is_empty()
        {
            return Err(WorkerPoolError::InvalidRequest);
        }
        if pins.expires_at_ms() <= now_ms
            || pins.expires_at_ms().saturating_sub(now_ms) > MAX_WORKER_LEASE_MS
        {
            return Err(if pins.expires_at_ms() <= now_ms {
                WorkerPoolError::TicketExpired
            } else {
                WorkerPoolError::InvalidRequest
            });
        }
        let active_for_run = self.workers.values().filter(|worker| {
            worker.goal_id == pins.goal_id()
                && worker.owner.run_id == pins.run_id()
                && is_capacity_holding(worker.state)
        }).count();
        // A HostKernel-authenticated ResourcePolicy pin can narrow this Run's
        // Spec ceiling. It is stored in the immutable pre-admission pins and
        // never applied to the global pool ceiling, which is independently
        // enforced by reserve_inner below.
        let run_limit = pins.resource_active_worker_limit()
            .map_or(pins.spec_max_workers(), |limit| pins.spec_max_workers().min(limit));
        if active_for_run >= usize::try_from(run_limit).unwrap_or(usize::MAX) {
            return Err(WorkerPoolError::LiveWorkerLimitReached);
        }
        let binding = VerifiedAttemptBinding::from_pre_admission_pins(pins)?;
        self.reserve_inner(
            ticket_id, &binding, worker_execution_id, owner, expected_revision,
            now_ms, true, Some(pins.task_revision()), pins.workspace_revision(),
        )
    }

    pub(crate) fn reserve_pre_admission_replayed(
        &mut self,
        ticket_id: &str,
        pins: &crate::worker_durable::TrustedPreAdmissionPinsV1,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
    ) -> Result<WorkerLeaseView, WorkerPoolError> {
        if pins.owner() != owner || pins.task_revision().is_empty() {
            return Err(WorkerPoolError::ScopeMismatch);
        }
        let binding = VerifiedAttemptBinding::from_pre_admission_pins(pins)?;
        self.reserve_replayed_inner(
            ticket_id, &binding, worker_execution_id, owner,
            Some(pins.task_revision()), pins.workspace_revision(),
        )
    }

    fn reserve_inner(
        &mut self,
        ticket_id: &str,
        binding: &VerifiedAttemptBinding,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
        now_ms: u64,
        allow_pre_admission: bool,
        expected_task_revision: Option<&str>,
        source_revision: &str,
    ) -> Result<WorkerLeaseView, WorkerPoolError> {
        self.check_owner(owner)?;
        if self.fan_out != FanOutState::ManagedAttemptBinding {
            return Err(WorkerPoolError::FanOutClosed);
        }
        validate_id("worker execution ID", worker_execution_id)?;
        let record = self
            .tickets
            .get(ticket_id)
            .ok_or(WorkerPoolError::TicketNotFound)?;
        if !record.owner.matches_owner(owner) {
            return Err(WorkerPoolError::ScopeMismatch);
        }
        match record.state {
            TicketState::Fenced => return Err(WorkerPoolError::TicketFenced),
            TicketState::Expired => return Err(WorkerPoolError::TicketExpired),
            TicketState::Consumed => {
                let existing = self
                    .workers
                    .get(worker_execution_id)
                    .ok_or(WorkerPoolError::WorkerIdentityConflict)?;
                if existing.goal_id != binding.goal_id() {
                    return Err(WorkerPoolError::GoalBindingMismatch);
                }
                if existing.ticket_id == ticket_id
                    && existing.owner.matches_owner(owner)
                    && existing.accepted_spec_digest == binding.accepted_spec_digest()
                {
                    return Ok(lease_view_named(worker_execution_id, existing));
                }
                return Err(WorkerPoolError::WorkerIdentityConflict);
            }
            TicketState::Queued => {}
        }
        // Goal identity is resolved before *any* live reserve state mutation.
        // Task/Attempt identifiers are only unique within one managed Goal, so
        // a binding for another Goal must refuse before the conservative
        // time-based expiry transition, which the rightful Goal then performs
        // normally.
        if binding.goal_id() != record.goal_id {
            return Err(WorkerPoolError::GoalBindingMismatch);
        }
        if let Some(parent) = record.parent_execution.as_ref() {
            self.validate_parent_lineage(
                parent,
                owner,
                &record.goal_id,
                &record.expected_task_revision,
                &record.accepted_spec_digest,
                self.revision,
                false,
                now_ms,
            )?;
        }
        if now_ms > record.expires_at_ms {
            self.check_revision(expected_revision)?;
            let revision = self.next_revision()?;
            self.tickets
                .get_mut(ticket_id)
                .expect("ticket checked")
                .state = TicketState::Expired;
            self.revision = revision;
            return Err(WorkerPoolError::TicketExpired);
        }
        if binding.phase() != BindingAttemptPhase::Executing
            && !(allow_pre_admission && binding.phase() == BindingAttemptPhase::PreAdmission)
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        if binding.run_id() != owner.run_id()
            || binding.task_id() != owner.task_id()
            || binding.attempt_id() != owner.attempt_id()
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        if binding.owner_epoch() != owner.owner_epoch() {
            return Err(WorkerPoolError::StaleOwnerEpoch);
        }
        if allow_pre_admission
            && expected_task_revision != Some(record.expected_task_revision.as_str())
        {
            return Err(WorkerPoolError::AttemptRevisionMismatch);
        }
        if (!allow_pre_admission && binding.source_revision() != record.expected_task_revision)
            || binding.source_revision() != source_revision
        {
            return Err(WorkerPoolError::AttemptRevisionMismatch);
        }
        if binding.accepted_spec_digest() != record.accepted_spec_digest {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        if self.live_worker_count() >= self.max_live_workers {
            return Err(WorkerPoolError::LiveWorkerLimitReached);
        }
        if self.workers.len() >= MAX_WORKER_RECORDS {
            return Err(WorkerPoolError::WorkerRecordLimitReached);
        }
        if self.workers.values().any(|worker| {
            is_capacity_holding(worker.state) && worker_binding_matches(worker, binding)
        }) {
            return Err(WorkerPoolError::AttemptConflict);
        }
        self.check_revision(expected_revision)?;
        match self.reservations.capacity(record.dimension) {
            Capacity::UnknownCapacity => return Err(WorkerPoolError::CapacityUnknown),
            Capacity::Remaining(remaining) if remaining < record.amount => {
                return Err(WorkerPoolError::InsufficientCapacity);
            }
            Capacity::Remaining(_) => {}
        }
        if let Some(worktree) = &record.worktree {
            let available =
                self.worktrees
                    .snapshot(&worktree.worktree_id)
                    .is_some_and(|snapshot| {
                        snapshot.status == WorktreeStatus::Free
                            && snapshot.base_revision == worktree.base_revision
                    });
            if !available {
                return Err(WorkerPoolError::WorktreeUnavailable);
            }
        }

        let ticket = self
            .tickets
            .get(ticket_id)
            .ok_or(WorkerPoolError::TicketNotFound)?
            .clone();
        self.apply_reservation(
            &ticket,
            binding,
            worker_execution_id,
            owner,
            source_revision,
            ApplyMode::Live,
        )
    }

    /// Durable replay of an already-committed reservation. The live admission
    /// gates (capacity samples, quota, worker caps, the ticket deadline) were
    /// evaluated when the command was first appended; replay re-applies only
    /// the deterministic state transitions so derived telemetry cannot rewrite
    /// committed history.
    pub(crate) fn reserve_replayed(
        &mut self,
        ticket_id: &str,
        binding: &VerifiedAttemptBinding,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
    ) -> Result<WorkerLeaseView, WorkerPoolError> {
        self.reserve_replayed_inner(ticket_id, binding, worker_execution_id, owner, None, binding.source_revision())
    }

    fn reserve_replayed_inner(
        &mut self,
        ticket_id: &str,
        binding: &VerifiedAttemptBinding,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_task_revision: Option<&str>,
        source_revision: &str,
    ) -> Result<WorkerLeaseView, WorkerPoolError> {
        self.check_owner(owner)?;
        validate_id("worker execution ID", worker_execution_id)?;
        let record = self
            .tickets
            .get(ticket_id)
            .ok_or(WorkerPoolError::TicketNotFound)?;
        if !record.owner.matches_owner(owner) {
            return Err(WorkerPoolError::ScopeMismatch);
        }
        match record.state {
            TicketState::Consumed => {
                let existing = self
                    .workers
                    .get(worker_execution_id)
                    .ok_or(WorkerPoolError::WorkerIdentityConflict)?;
                if existing.goal_id != binding.goal_id() {
                    return Err(WorkerPoolError::GoalBindingMismatch);
                }
                return Ok(lease_view_named(worker_execution_id, existing));
            }
            TicketState::Fenced | TicketState::Expired => {
                return Err(WorkerPoolError::TicketFenced);
            }
            TicketState::Queued => {}
        }
        if binding.goal_id() != record.goal_id {
            return Err(WorkerPoolError::GoalBindingMismatch);
        }
        let pre_admission = binding.phase() == BindingAttemptPhase::PreAdmission;
        if (!pre_admission && binding.phase() != BindingAttemptPhase::Executing)
            || binding.run_id() != owner.run_id()
            || binding.task_id() != owner.task_id()
            || binding.attempt_id() != owner.attempt_id()
            || binding.accepted_spec_digest() != record.accepted_spec_digest
            || (pre_admission && expected_task_revision != Some(record.expected_task_revision.as_str()))
            || (!pre_admission && binding.source_revision() != record.expected_task_revision)
            || binding.source_revision() != source_revision
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        let ticket = record.clone();
        self.apply_reservation(
            &ticket,
            binding,
            worker_execution_id,
            owner,
            source_revision,
            ApplyMode::Replay,
        )
    }

    fn apply_reservation(
        &mut self,
        ticket: &QueueTicket,
        binding: &VerifiedAttemptBinding,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
        source_revision: &str,
        mode: ApplyMode,
    ) -> Result<WorkerLeaseView, WorkerPoolError> {
        // The caller validated every gate against the current revisions, so
        // the ordered inner applies are deterministic. Any residual error is an
        // internal invariant failure; no capacity is silently freed and the
        // partial state stays inspectable.
        let reservation_id = format!("worker-reservation-{worker_execution_id}");
        let reservation = self
            .reservations
            .propose(
                ReservationRequest {
                    reservation_id: reservation_id.clone(),
                    idempotency_key: format!("worker-{worker_execution_id}"),
                    dimension: ticket.dimension,
                    amount: ticket.amount,
                    expires_at_ms: ticket.expires_at_ms,
                },
                owner.clone(),
                self.reservations.revision(),
            )
            .map_err(map_reservation_error)?;
        let reservation_revision = self.reservations.revision();
        match mode {
            ApplyMode::Live => {
                self.reservations
                    .reserve(&reservation.reservation_id, owner, reservation_revision)
                    .map_err(map_reservation_error)?;
            }
            ApplyMode::Replay => {
                self.reservations
                    .reserve_replayed(&reservation.reservation_id, owner, reservation_revision)
                    .map_err(map_reservation_error)?;
            }
        }
        let worktree_lease_id = if let Some(worktree) = &ticket.worktree {
            let lease: WorktreeLease = self.worktrees.acquire_pinned(
                worker_execution_id,
                &worktree.worktree_id,
                &worktree.base_revision,
                source_revision,
                owner.clone(),
                self.worktrees.revision(),
                ticket.expires_at_ms,
            )?;
            Some(lease.lease_id)
        } else {
            None
        };
        let revision = self.next_revision()?;
        self.workers.insert(
            worker_execution_id.to_owned(),
            WorkerRecord {
                ticket_id: ticket.ticket_id.clone(),
                goal_id: ticket.goal_id.clone(),
                owner: OwnerScopeKey::from_owner(owner),
                class: ticket.class,
                dimension: ticket.dimension,
                amount: ticket.amount,
                state: ReservationState::Reserved,
                reservation_id,
                attempt_revision: source_revision.to_owned(),
                child_workspace_revision: None,
                accepted_spec_digest: binding.accepted_spec_digest().to_owned(),
                worktree_lease_id: worktree_lease_id.clone(),
                worktree_quarantined: false,
                process_identity: None,
                cancellation_requested: false,
                unknown_effect: false,
                reuse_key: None,
                settlement: None,
                expires_at_ms: ticket.expires_at_ms,
            },
        );
        let current = self
            .tickets
            .get_mut(&ticket.ticket_id)
            .expect("ticket checked");
        current.state = TicketState::Consumed;
        current.worker_execution_id = Some(worker_execution_id.to_owned());
        self.revision = revision;
        let record = self
            .workers
            .get(worker_execution_id)
            .expect("worker inserted");
        Ok(lease_view_named(worker_execution_id, record))
    }

    /// Claims the worker startup lease (the durable append must win before any
    /// process spawn) and moves the worktree lease out of the expirable state.
    pub fn claim(
        &mut self,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_owner(owner)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_exact(record, owner)?;
        if record.cancellation_requested {
            return Err(WorkerPoolError::TicketFenced);
        }
        if record.state == ReservationState::Claimed {
            return Ok(());
        }
        if record.state != ReservationState::Reserved {
            return Err(WorkerPoolError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        let reservation_id = record.reservation_id.clone();
        let worktree_lease_id = record.worktree_lease_id.clone();
        self.reservations.claim(
            &reservation_id,
            owner,
            worker_execution_id,
            self.reservations.revision(),
        )?;
        if let Some(worktree_lease_id) = &worktree_lease_id {
            self.worktrees.claim_unlaunched(
                worktree_lease_id,
                owner,
                worker_execution_id,
                self.worktrees.revision(),
            )?;
        }
        let revision = self.next_revision()?;
        self.workers
            .get_mut(worker_execution_id)
            .expect("worker checked")
            .state = ReservationState::Claimed;
        self.revision = revision;
        Ok(())
    }

    /// Read-only headless attach. No worktree, no new transcript, and warm
    /// reuse requires an identical trusted reuse key with zero active tool
    /// calls (the caller asserts the reset; the pool records the key).
    pub fn attach_existing_core_client(
        &mut self,
        worker_execution_id: &str,
        session_link_ref: &str,
        reuse_key: WorkerReuseKey,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_owner(owner)?;
        validate_id("SessionLink reference", session_link_ref)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_exact(record, owner)?;
        if record.class != WorkerClass::ReadOnlyAttachment {
            return Err(WorkerPoolError::WrongWorkerClass);
        }
        if record.cancellation_requested {
            return Err(WorkerPoolError::TicketFenced);
        }
        if record.state != ReservationState::Claimed {
            return Err(WorkerPoolError::InvalidTransition);
        }
        if record.process_identity.is_some() || record.worktree_lease_id.is_some() {
            return Err(WorkerPoolError::WrongWorkerClass);
        }
        if reuse_key.principal_ref != owner.principal_ref()
            || reuse_key.workspace_binding != owner.workspace_binding()
        {
            return Err(WorkerPoolError::ScopeMismatch);
        }
        if reuse_key.policy_epoch == 0 {
            return Err(WorkerPoolError::InvalidRequest);
        }
        if record
            .reuse_key
            .as_ref()
            .is_some_and(|key| key != &reuse_key)
        {
            return Err(WorkerPoolError::ReuseIncompatible);
        }
        self.check_revision(expected_revision)?;
        let revision = self.next_revision()?;
        self.workers
            .get_mut(worker_execution_id)
            .expect("worker checked")
            .reuse_key = Some(reuse_key);
        self.revision = revision;
        Ok(())
    }

    /// Launches one already-claimed isolated worker through the Guard-owned
    /// launch port and binds the returned OS process generation. The durable
    /// caller must have appended [`Self::claim`] before calling this.
    pub fn dispatch_isolated_worker(
        &mut self,
        worker_execution_id: &str,
        launcher: &mut dyn IsolatedWorkerLauncher,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<ProcessIdentity, WorkerPoolError> {
        self.check_owner(owner)?;
        // Validate the CAS and gate before crossing the effect boundary. A
        // post-launch bind failure cannot undo a process that already started.
        self.check_revision(expected_revision)?;
        if self.fan_out != FanOutState::ManagedAttemptBinding {
            return Err(WorkerPoolError::FanOutClosed);
        }
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_exact(record, owner)?;
        if record.class != WorkerClass::IsolatedEffectful {
            return Err(WorkerPoolError::WrongWorkerClass);
        }
        if record.cancellation_requested {
            return Err(WorkerPoolError::TicketFenced);
        }
        if record.state != ReservationState::Claimed {
            return Err(WorkerPoolError::InvalidTransition);
        }
        if record.process_identity.is_some() {
            return Err(WorkerPoolError::WorkerIdentityConflict);
        }
        let Some(worktree_lease_id) = record.worktree_lease_id.clone() else {
            return Err(WorkerPoolError::WorktreeRequired);
        };
        let worktree: Option<WorktreeSnapshot> =
            self.worktrees.snapshot_of_lease(&worktree_lease_id);
        if !worktree.as_ref().is_some_and(|tree| {
            tree.status == WorktreeStatus::Leased
                && tree.reservation_state == Some(ReservationState::Claimed)
                && tree.lease_id.as_deref() == Some(worktree_lease_id.as_str())
                && tree.observed_revision.as_deref() == Some(record.attempt_revision.as_str())
        }) {
            return Err(WorkerPoolError::WorktreeUnavailable);
        }
        let permit = LaunchPermit {
            worker_execution_id: worker_execution_id.to_owned(),
            run_id: owner.run_id().to_owned(),
            task_id: owner.task_id().to_owned(),
            attempt_id: owner.attempt_id().to_owned(),
            owner_epoch: owner.owner_epoch(),
            workspace_binding: owner.workspace_binding().to_owned(),
            worktree_path: worktree.as_ref().map(|snapshot| snapshot.path.clone()),
            base_revision: worktree
                .as_ref()
                .map(|snapshot| snapshot.base_revision.clone()),
            source_revision: record.attempt_revision.clone(),
            accepted_spec_digest: record.accepted_spec_digest.clone(),
        };
        let process_identity = match launcher.launch(&permit) {
            Ok(identity) => identity,
            Err(error) => {
                // The port may have failed after possible launch. Preserve the
                // claim/capacity and fence this worker pending reconciliation.
                self.quarantine_record(worker_execution_id)?;
                return Err(error);
            }
        };
        if let Err(error) = self.bind_process_record(
            worker_execution_id,
            process_identity.clone(),
            owner,
            expected_revision,
        ) {
            self.quarantine_record(worker_execution_id)?;
            return Err(error);
        }
        Ok(process_identity)
    }

    /// Records an OS process generation for an already-claimed worker. The
    /// durable adapter appends this fact after the Guard-owned launcher
    /// returned; a crash before the append leaves the worker quarantined.
    pub fn bind_process_record(
        &mut self,
        worker_execution_id: &str,
        process_identity: ProcessIdentity,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_owner(owner)?;
        if process_identity.pid == 0 || process_identity.start_identity == 0 {
            return Err(WorkerPoolError::InvalidRequest);
        }
        if self.workers.iter().any(|(other_id, worker)| {
            other_id != worker_execution_id
                && worker.process_identity.as_ref() == Some(&process_identity)
                && !matches!(worker.state, ReservationState::Released | ReservationState::Expired)
        }) {
            return Err(WorkerPoolError::ProcessIdentityMismatch);
        }
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_exact(record, owner)?;
        if record.state != ReservationState::Claimed {
            return Err(WorkerPoolError::InvalidTransition);
        }
        if let Some(existing) = &record.process_identity {
            return if *existing == process_identity {
                Ok(())
            } else {
                Err(WorkerPoolError::ProcessIdentityMismatch)
            };
        }
        self.check_revision(expected_revision)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        let reservation_id = record.reservation_id.clone();
        let worktree_lease_id = record.worktree_lease_id.clone();
        self.reservations.bind_process(
            &reservation_id,
            owner,
            process_identity.clone(),
            self.reservations.revision(),
        )?;
        if let Some(worktree_lease_id) = &worktree_lease_id {
            self.worktrees.bind_process(
                worktree_lease_id,
                owner,
                process_identity.clone(),
                self.worktrees.revision(),
            )?;
        }
        let revision = self.next_revision()?;
        self.workers
            .get_mut(worker_execution_id)
            .expect("worker checked")
            .process_identity = Some(process_identity);
        self.revision = revision;
        Ok(())
    }

    /// Rebinds the revision carried by a pre-admission reservation from its
    /// parent-root admission observation to the HostKernel-measured child
    /// worktree revision when P8 durably attaches the exact managed binding.
    /// The OwnerLog adapter records the accompanying child Location projection
    /// in the same event, so replay derives this value from that event only.
    pub(crate) fn bind_managed_child_workspace_revision(
        &mut self,
        worker_execution_id: &str,
        child_revision: &str,
    ) -> Result<(), WorkerPoolError> {
        if !child_revision.starts_with("blake3:") || child_revision.len() != 71
            || !child_revision[7..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(WorkerPoolError::InvalidRequest);
        }
        let record = self.workers.get(worker_execution_id).ok_or(WorkerPoolError::WorkerNotFound)?;
        if record.state != ReservationState::Reserved || record.cancellation_requested
            || record.unknown_effect || record.process_identity.is_some()
        {
            return Err(WorkerPoolError::InvalidTransition);
        }
        if record.child_workspace_revision.as_deref() == Some(child_revision) {
            return Ok(());
        }
        if record.child_workspace_revision.is_some() {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        let revision = self.next_revision()?;
        self.workers.get_mut(worker_execution_id).expect("worker checked")
            .child_workspace_revision = Some(child_revision.to_owned());
        self.revision = revision;
        Ok(())
    }

    /// Settles one worker. Capacity is released only on proven owned-process
    /// exit plus effect settlement; an UNKNOWN outcome quarantines and keeps
    /// its conservative budget until an explicit reconciliation.
    pub fn settle_worker(
        &mut self,
        worker_execution_id: &str,
        settlement: WorkerSettlement,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<WorkerSettlementResult, WorkerPoolError> {
        self.check_owner(owner)?;
        validate_settlement(&settlement)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_exact(record, owner)?;
        if record.state == ReservationState::Released {
            return if record.settlement.as_ref() == Some(&settlement) {
                Ok(WorkerSettlementResult::Released)
            } else {
                Err(WorkerPoolError::IdempotencyConflict)
            };
        }
        self.check_revision(expected_revision)?;
        match settlement.outcome {
            WorkerSettlementOutcome::Settled => {
                if record.state != ReservationState::Claimed {
                    return Err(WorkerPoolError::InvalidTransition);
                }
                if !settlement.owned_process_exited || !settlement.effects_settled {
                    return Err(WorkerPoolError::MissingProof);
                }
                let Some(recorded_identity) = record.process_identity.clone() else {
                    return Err(WorkerPoolError::MissingProof);
                };
                if settlement.process_identity.as_ref() != Some(&recorded_identity) {
                    return Err(WorkerPoolError::ProcessIdentityMismatch);
                }
                let reservation_id = record.reservation_id.clone();
                let worktree_lease_id = record.worktree_lease_id.clone();
                let worktree_evidence =
                    worktree_settlement_evidence(&settlement, &recorded_identity);
                self.reservations.begin_release(
                    &reservation_id,
                    owner,
                    ReservationProof::default(),
                    self.reservations.revision(),
                )?;
                self.reservations.release(
                    &reservation_id,
                    owner,
                    ReservationProof {
                        owned_process_exited: true,
                        effects_settled: true,
                        ..ReservationProof::default()
                    },
                    self.reservations.revision(),
                )?;
                let mut worktree_quarantined = false;
                if let Some(worktree_lease_id) = &worktree_lease_id {
                    let reusable = worktree_evidence.observed_revision.is_some()
                        && worktree_evidence.clean == Some(true)
                        && worktree_evidence.has_untracked == Some(false);
                    if reusable {
                        self.worktrees.begin_release(
                            worktree_lease_id,
                            owner,
                            self.worktrees.revision(),
                        )?;
                        self.worktrees.release(
                            worktree_lease_id,
                            owner,
                            worktree_evidence,
                            self.worktrees.revision(),
                        )?;
                    } else {
                        // Dirty, unknown or unreported workspace facts stay
                        // quarantined; only a later workspace-owner
                        // reconciliation decides reuse.
                        self.worktrees.quarantine(
                            worktree_lease_id,
                            owner,
                            self.worktrees.revision(),
                        )?;
                        worktree_quarantined = true;
                    }
                }
                let revision = self.next_revision()?;
                let record = self
                    .workers
                    .get_mut(worker_execution_id)
                    .expect("worker checked");
                record.state = ReservationState::Released;
                record.settlement = Some(settlement);
                record.worktree_quarantined = worktree_quarantined;
                self.revision = revision;
                Ok(WorkerSettlementResult::Released)
            }
            WorkerSettlementOutcome::Unknown => {
                self.quarantine_record(worker_execution_id)?;
                Ok(WorkerSettlementResult::Quarantined)
            }
            WorkerSettlementOutcome::Blocked => {
                if record.state == ReservationState::Reserved {
                    // Never launched: capacity is freed through the canonical
                    // EXPIRED transition once the expiry deadline passes.
                    Ok(WorkerSettlementResult::Blocked)
                } else {
                    self.quarantine_record(worker_execution_id)?;
                    Ok(WorkerSettlementResult::Blocked)
                }
            }
        }
    }

    pub(crate) fn settle_logical_managed_worker_event(
        &mut self,
        worker_execution_id: &str,
        attempt_id: &str,
        proof_digest: &str,
        observed_workspace_revision: Option<String>,
        reusable_worktree: bool,
        defer_worktree_disposition: bool,
        reconciliation_owner_epoch: Option<u64>,
    ) -> Result<(), WorkerPoolError> {
        let record = self.workers.get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        if record.owner.attempt_id != attempt_id
            || record.state == ReservationState::Released
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        let owner = rehydrate(&record.owner).map_err(|_| WorkerPoolError::ScopeMismatch)?;
        let reconciled = reconciliation_owner_epoch.is_some();
        if record.process_identity.is_some()
            || (reconciled && (record.state != ReservationState::Quarantined
                || reconciliation_owner_epoch != Some(self.owner_epoch)
                || self.owner_epoch < record.owner.owner_epoch))
            || (!reconciled && (record.owner.owner_epoch != self.owner_epoch
                || !matches!(record.state, ReservationState::Claimed | ReservationState::Quarantined)))
            || record.dimension != BudgetDimension::ActiveWorkers
            || proof_digest.len() != 71 || !proof_digest.starts_with("blake3:")
        {
            return Err(WorkerPoolError::MissingProof);
        }
        let reservation_id = record.reservation_id.clone();
        let worktree_lease_id = record.worktree_lease_id.clone();
        if defer_worktree_disposition {
            if let Some(lease_id) = worktree_lease_id.as_deref() {
                self.worktrees.quarantine_managed_disposition_pending(
                    lease_id, &owner, reconciliation_owner_epoch, self.worktrees.revision(),
                )?;
            }
        }
        if !defer_worktree_disposition {
            if let Some(lease_id) = worktree_lease_id.as_deref() {
                if let Some(current_epoch) = reconciliation_owner_epoch {
                    self.worktrees.settle_logical_managed_reconciled(
                        lease_id, &owner, current_epoch, observed_workspace_revision.clone(),
                        reusable_worktree, !reusable_worktree, self.worktrees.revision(),
                    )?;
                } else {
                    self.worktrees.settle_logical_managed(
                        lease_id, &owner, observed_workspace_revision.clone(),
                        reusable_worktree, !reusable_worktree, self.worktrees.revision(),
                    )?;
                }
            }
        }
        if let Some(current_epoch) = reconciliation_owner_epoch {
            self.reservations.release_logical_managed_worker_reconciled(
                &reservation_id, &owner, current_epoch, self.reservations.revision(),
            )?;
        } else {
            self.reservations.release_logical_managed_worker(
                &reservation_id, &owner, self.reservations.revision(),
            )?;
        }
        let next_revision = self.next_revision()?;
        let record = self.workers.get_mut(worker_execution_id).expect("worker checked");
        record.state = ReservationState::Released;
        // Worktree disposition is a separate OwnerLog transition. Until that
        // event is committed, retain the active lease and mark it unavailable.
        record.worktree_quarantined = worktree_lease_id.is_some()
            && (defer_worktree_disposition || !reusable_worktree);
        record.reuse_key = None;
        record.settlement = Some(WorkerSettlement {
            outcome: WorkerSettlementOutcome::Settled,
            process_identity: None,
            owned_process_exited: false,
            effects_settled: true,
            reconciliation_complete: true,
            evidence_refs: Vec::new(),
            external_effect_refs: vec![proof_digest.to_owned()],
            worktree: observed_workspace_revision.map(|observed_revision| WorktreeSettlementFacts {
                observed_revision: Some(observed_revision),
                clean: (!defer_worktree_disposition).then_some(reusable_worktree),
                has_untracked: (!defer_worktree_disposition).then_some(!reusable_worktree),
            }),
        });
        self.revision = next_revision;
        Ok(())
    }

    pub(crate) fn finalize_logical_managed_worktree_disposition(
        &mut self,
        worker_execution_id: &str,
        attempt_id: &str,
        observed_revision: &str,
        reusable: bool,
        reconciliation_owner_epoch: Option<u64>,
    ) -> Result<(), WorkerPoolError> {
        let record = self.workers.get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        if record.owner.attempt_id != attempt_id || record.state != ReservationState::Released
            || record.process_identity.is_some()
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        let owner = rehydrate(&record.owner).map_err(|_| WorkerPoolError::ScopeMismatch)?;
        let lease_id = record.worktree_lease_id.as_deref().ok_or(WorkerPoolError::WorktreeRequired)?;
        self.worktrees.finalize_logical_managed_worktree_disposition(
            lease_id, &owner, reconciliation_owner_epoch, observed_revision, reusable,
            self.worktrees.revision(),
        )?;
        let next_revision = self.next_revision()?;
        let record = self.workers.get_mut(worker_execution_id).expect("worker checked");
        record.worktree_quarantined = !reusable;
        if let Some(settlement) = record.settlement.as_mut() {
            settlement.worktree = Some(WorktreeSettlementFacts {
                observed_revision: Some(observed_revision.to_owned()),
                clean: Some(reusable),
                // Inspect does not report an untracked-only count. Preserve
                // unknown for quarantined trees instead of inferring it from
                // the broader dirty disposition.
                has_untracked: reusable.then_some(false),
            });
        }
        self.revision = next_revision;
        Ok(())
    }

    /// Watchdog path: the owned process can no longer be observed. This never
    /// kills anything and never frees capacity.
    pub fn record_process_lost(
        &mut self,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_owner(owner)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_fenced(record, owner)?;
        self.check_revision(expected_revision)?;
        self.quarantine_record(worker_execution_id)
    }

    /// Idempotent explicit quarantine (UNKNOWN effect or lost worker).
    pub fn quarantine_worker(
        &mut self,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_owner(owner)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_fenced(record, owner)?;
        if record.state == ReservationState::Quarantined {
            return Ok(());
        }
        self.check_revision(expected_revision)?;
        self.quarantine_record(worker_execution_id)
    }

    /// Only a reservation that provably never launched may expire. A record
    /// fenced to an older owner epoch may still be expired (never claimed, no
    /// process) by the current epoch under the same trusted scope.
    pub fn expire_unlaunched_worker(
        &mut self,
        worker_execution_id: &str,
        now_ms: u64,
        proof: ReservationProof,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_owner(owner)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_fenced(record, owner)?;
        if record.state == ReservationState::Expired {
            return Ok(());
        }
        if record.state != ReservationState::Reserved
            || record.process_identity.is_some()
            || record.worktree_quarantined
        {
            return Err(WorkerPoolError::InvalidTransition);
        }
        if now_ms < record.expires_at_ms {
            return Err(WorkerPoolError::NotExpired);
        }
        self.check_revision(expected_revision)?;
        self.expire_record_inner(worker_execution_id, now_ms, proof)?;
        Ok(())
    }

    /// Immediate release of a pre-admission reservation after P8 has consumed
    /// P1's durable no-dispatch reconciliation proof. Unlike timeout expiry,
    /// this requires explicit reconciliation evidence and the worker must still
    /// be RESERVED with no process generation.
    pub(crate) fn reconcile_pre_admission_no_dispatch(
        &mut self,
        worker_execution_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<(), WorkerPoolError> {
        let record = self.workers.get(worker_execution_id).ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_fenced(record, owner)?;
        if record.state != ReservationState::Reserved || record.process_identity.is_some()
            || record.unknown_effect || record.worktree_quarantined
        {
            return Err(WorkerPoolError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        self.expire_record_reconciled(worker_execution_id)?;
        Ok(())
    }

    fn expire_record_reconciled(&mut self, worker_execution_id: &str) -> Result<(), WorkerPoolError> {
        let record = self.workers.get(worker_execution_id).ok_or(WorkerPoolError::WorkerNotFound)?;
        if record.state != ReservationState::Reserved || record.process_identity.is_some() {
            return Err(WorkerPoolError::InvalidTransition);
        }
        let owner = rehydrate_owner(&record.owner);
        let reservation_id = record.reservation_id.clone();
        let worktree_lease_id = record.worktree_lease_id.clone();
        let proof = ReservationProof {
            no_launch_or_dispatch: true,
            reconciliation_complete: true,
            ..ReservationProof::default()
        };
        self.reservations.expire_unlaunched_reconciled(&reservation_id, &owner, proof, self.reservations.revision())?;
        if let Some(worktree_lease_id) = &worktree_lease_id {
            self.worktrees.expire_unlaunched_reconciled(worktree_lease_id, &owner, proof, self.worktrees.revision())?;
        }
        let revision = self.next_revision()?;
        self.workers.get_mut(worker_execution_id).expect("worker checked").state = ReservationState::Expired;
        self.revision = revision;
        Ok(())
    }

    /// Reconciliation of a quarantined worker. All three §11.20 proof flags are
    /// required, plus an idempotent final release; capacity is freed only here.
    pub fn reconcile_and_release_worker(
        &mut self,
        worker_execution_id: &str,
        proof: ReconciliationProof,
        expected_revision: u64,
        owner: &AuthenticatedOwnerContext,
    ) -> Result<WorkerSettlementResult, WorkerPoolError> {
        self.check_owner(owner)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_fenced(record, owner)?;
        if record.state != ReservationState::Quarantined {
            return Err(WorkerPoolError::InvalidTransition);
        }
        if !proof.owned_process_exited || !proof.effects_settled || !proof.reconciliation_complete {
            return Err(WorkerPoolError::MissingProof);
        }
        self.check_revision(expected_revision)?;
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        let reservation_id = record.reservation_id.clone();
        let worktree_lease_id = record.worktree_lease_id.clone();
        let quarantined_worktree = record.worktree_quarantined;
        let process_identity = record.process_identity.clone();
        let scope_owner = rehydrate_owner(&record.owner);
        self.reservations.begin_release(
            &reservation_id,
            &scope_owner,
            ReservationProof {
                reconciliation_complete: true,
                ..ReservationProof::default()
            },
            self.reservations.revision(),
        )?;
        self.reservations.release_reconciled(
            &reservation_id,
            &scope_owner,
            ReservationProof {
                owned_process_exited: true,
                effects_settled: true,
                reconciliation_complete: true,
                ..ReservationProof::default()
            },
            self.reservations.revision(),
        )?;
        if let Some(worktree_lease_id) = &worktree_lease_id
            && quarantined_worktree
        {
            match process_identity {
                Some(identity) => {
                    let settlement = WorktreeSettlementEvidence {
                        process_identity: Some(identity),
                        owned_process_exited: true,
                        effects_settled: true,
                        reconciliation_complete: true,
                        observed_revision: None,
                        clean: None,
                        has_untracked: None,
                    };
                    self.worktrees.reconcile_quarantined(
                        worktree_lease_id,
                        &scope_owner,
                        &settlement,
                        self.worktrees.revision(),
                    )?;
                    self.worktrees.release(
                        worktree_lease_id,
                        &scope_owner,
                        settlement,
                        self.worktrees.revision(),
                    )?;
                }
                None => {
                    // No OS generation was ever bound: the reconciler proved
                    // absence, and the workspace stays quarantined for its owner.
                    self.worktrees.reconcile_and_release_reconciled(
                        worktree_lease_id,
                        &scope_owner,
                        ReservationProof {
                            owned_process_exited: true,
                            effects_settled: true,
                            reconciliation_complete: true,
                            ..ReservationProof::default()
                        },
                        self.worktrees.revision(),
                    )?;
                }
            }
        }
        let revision = self.next_revision()?;
        let record = self
            .workers
            .get_mut(worker_execution_id)
            .expect("worker checked");
        record.state = ReservationState::Released;
        record.reuse_key = None;
        record.worktree_quarantined = false;
        self.revision = revision;
        Ok(WorkerSettlementResult::Released)
    }

    /// Advances the pool owner epoch after a new kernel incarnation. Old-epoch
    /// queued tickets are fenced, claimed/uncertain workers are quarantined and
    /// keep their capacity, and provably unlaunched reservations past their
    /// deadline expire. Records keep the scope that owned them, so only the
    /// same trusted scope at the current epoch can later settle them.
    pub(crate) fn advance_owner_epoch(
        &mut self,
        from: u64,
        to: u64,
        now_ms: u64,
    ) -> Result<(), WorkerPoolError> {
        self.advance_owner_epoch_preserving(from, to, now_ms, &std::collections::BTreeSet::new())
    }

    pub(crate) fn advance_owner_epoch_preserving(
        &mut self,
        from: u64,
        to: u64,
        now_ms: u64,
        retain_reserved: &std::collections::BTreeSet<String>,
    ) -> Result<(), WorkerPoolError> {
        if self.owner_epoch != from {
            return Err(WorkerPoolError::StaleOwnerEpoch);
        }
        if to <= from {
            return Err(WorkerPoolError::InvalidConfiguration);
        }
        for ticket in self.tickets.values_mut() {
            if ticket.state == TicketState::Queued {
                ticket.state = TicketState::Fenced;
            }
        }
        let unsettled: Vec<String> = self
            .workers
            .iter()
            .filter(|(_, record)| {
                matches!(
                    record.state,
                    ReservationState::Claimed | ReservationState::ReleasePending
                )
            })
            .map(|(worker_execution_id, _)| worker_execution_id.clone())
            .collect();
        for worker_execution_id in unsettled {
            self.quarantine_record(&worker_execution_id)?;
        }
        let expirable: Vec<String> = self
            .workers
            .iter()
            .filter(|(worker_execution_id, record)| {
                record.state == ReservationState::Reserved
                    && record.process_identity.is_none()
                    && !record.worktree_quarantined
                    && !retain_reserved.contains(*worker_execution_id)
                    && now_ms >= record.expires_at_ms
            })
            .map(|(worker_execution_id, _)| worker_execution_id.clone())
            .collect();
        for worker_execution_id in expirable {
            self.expire_record_inner(
                &worker_execution_id,
                now_ms,
                ReservationProof {
                    no_launch_or_dispatch: true,
                    ..ReservationProof::default()
                },
            )?;
        }
        self.owner_epoch = to;
        let revision = self.next_revision()?;
        self.revision = revision;
        Ok(())
    }

    /// Recovery after a host crash: an admitted/claimed worker may already have
    /// launched external work, so it is conservatively quarantined and keeps its
    /// capacity. Queued tickets are fenced because the dispatch context that
    /// admitted them is gone, and provably unlaunched reservations past their
    /// deadline expire. Idempotent across repeated recovery.
    pub fn recover_after_restart(
        &mut self,
        now_ms: u64,
    ) -> Result<RecoveryReport, WorkerPoolError> {
        self.recover_after_restart_preserving(now_ms, &std::collections::BTreeSet::new())
    }

    /// Restart recovery for OwnerLog-backed pools. Pre-admission leases are
    /// retained even past their deadline because P1 may have durably admitted
    /// the Attempt immediately before a crash. Only explicit reconciliation
    /// may release that cross-journal ambiguity.
    pub(crate) fn recover_after_restart_preserving(
        &mut self,
        now_ms: u64,
        retain_reserved: &std::collections::BTreeSet<String>,
    ) -> Result<RecoveryReport, WorkerPoolError> {
        let mut report = RecoveryReport::default();
        let unsettled: Vec<String> = self
            .workers
            .iter()
            .filter(|(_, record)| {
                matches!(
                    record.state,
                    ReservationState::Claimed | ReservationState::ReleasePending
                )
            })
            .map(|(worker_execution_id, _)| worker_execution_id.clone())
            .collect();
        for worker_execution_id in unsettled {
            self.quarantine_record(&worker_execution_id)?;
            report.quarantined_workers += 1;
        }
        let expirable: Vec<String> = self
            .workers
            .iter()
            .filter(|(worker_execution_id, record)| {
                record.state == ReservationState::Reserved
                    && record.process_identity.is_none()
                    && !record.worktree_quarantined
                    && !retain_reserved.contains(*worker_execution_id)
                    && now_ms >= record.expires_at_ms
            })
            .map(|(worker_execution_id, _)| worker_execution_id.clone())
            .collect();
        for worker_execution_id in expirable {
            self.expire_record_inner(
                &worker_execution_id,
                now_ms,
                ReservationProof {
                    no_launch_or_dispatch: true,
                    ..ReservationProof::default()
                },
            )?;
            report.expired_workers += 1;
        }
        for ticket in self.tickets.values_mut() {
            if ticket.state == TicketState::Queued {
                ticket.state = TicketState::Fenced;
                report.fenced_tickets += 1;
            }
        }
        if report.quarantined_workers > 0 || report.expired_workers > 0 || report.fenced_tickets > 0
        {
            let revision = self.next_revision()?;
            self.revision = revision;
        }
        Ok(report)
    }

    /// Cancellation fence (§21.11/§11.20): queued tickets under the scope are
    /// fenced so they can never reserve afterwards, and live workers are marked
    /// cancellation-requested. Capacity is *not* freed here: an unlaunched
    /// reservation frees through the canonical `EXPIRED` transition at its
    /// deadline, and a launched process keeps its conservative budget until
    /// proven exit and settlement. This never kills a process.
    pub fn cancel_scope(
        &mut self,
        scope: &CancelScope,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<CancellationFence, WorkerPoolError> {
        self.check_owner(owner)?;
        self.check_revision(expected_revision)?;
        if !owner_matches_scope(scope, owner) {
            return Err(WorkerPoolError::ScopeMismatch);
        }
        let revision = self.next_revision()?;
        let fence_epoch = self
            .fence_epoch
            .checked_add(1)
            .ok_or(WorkerPoolError::InvalidConfiguration)?;
        self.fence_epoch = fence_epoch;
        let mut fenced_tickets = 0usize;
        for ticket in self.tickets.values_mut() {
            if ticket.state != TicketState::Queued {
                continue;
            }
            if scope_matches(scope, &ticket.owner) && ticket.owner.same_run_scope(owner) {
                ticket.state = TicketState::Fenced;
                fenced_tickets += 1;
            }
        }
        let mut fenced_workers = 0usize;
        for (worker_execution_id, record) in self.workers.iter_mut() {
            if !is_capacity_holding(record.state) {
                continue;
            }
            let matches = match scope {
                CancelScope::Worker {
                    worker_execution_id: scoped,
                } => scoped == worker_execution_id,
                _ => scope_matches(scope, &record.owner),
            };
            if matches && record.owner.same_run_scope(owner) {
                record.cancellation_requested = true;
                fenced_workers += 1;
            }
        }
        self.revision = revision;
        Ok(CancellationFence {
            fence_epoch,
            fenced_tickets,
            fenced_workers,
        })
    }

    /// Recovery after a host crash: an admitted/claimed worker may already have
    /// launched external work, so it is conservatively quarantined and keeps its
    /// capacity. Queued tickets are fenced because the dispatch context that
    /// admitted them is gone. Idempotent across repeated recovery.
    pub fn ticket(&self, ticket_id: &str) -> Option<&QueueTicket> {
        self.tickets.get(ticket_id)
    }

    pub fn worker(&self, worker_execution_id: &str) -> Option<WorkerSnapshot> {
        self.workers
            .get(worker_execution_id)
            .map(|record| WorkerSnapshot {
                worker_execution_id: worker_execution_id.to_owned(),
                ticket_id: record.ticket_id.clone(),
                goal_id: record.goal_id.clone(),
                owner: record.owner.clone(),
                class: record.class,
                state: record.state,
                dimension: record.dimension,
                amount: record.amount,
                cancellation_requested: record.cancellation_requested,
                unknown_effect: record.unknown_effect,
                worktree_lease_id: record.worktree_lease_id.clone(),
                process_identity: record.process_identity.clone(),
                expires_at_ms: record.expires_at_ms,
            })
    }

    pub(crate) fn worker_reservation_id(&self, worker_execution_id: &str) -> Option<&str> {
        self.workers.get(worker_execution_id).map(|record| record.reservation_id.as_str())
    }

    pub(crate) fn worker_source_revision(&self, worker_execution_id: &str) -> Option<&str> {
        self.workers.get(worker_execution_id).and_then(|record| record.child_workspace_revision.as_deref())
    }

    /// Resolves P8's durable budget/worktree lease lineage for a current
    /// authenticated managed Attempt. The outer `WorkerPoolControl` exposes
    /// this only after OwnerLog open/replay and attaches the durable cursor.
    /// This is not a filesystem-currentness or Guard authorization proof.
    pub(crate) fn resolve_durable_worker_lease_facts(
        &self,
        worker_execution_id: &str,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<DurableWorkerLeaseFactsV1, WorkerPoolError> {
        self.check_owner(owner)?;
        if self.fan_out != FanOutState::ManagedAttemptBinding {
            return Err(WorkerPoolError::FanOutClosed);
        }
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_exact(record, owner)?;
        if record.cancellation_requested
            || record.unknown_effect
            || record.worktree_quarantined
            || record.expires_at_ms <= now_ms
            || record.class != WorkerClass::IsolatedEffectful
            || record.goal_id != binding.goal_id()
            || record.owner.run_id != binding.run_id()
            || record.owner.task_id != binding.task_id()
            || record.owner.attempt_id != binding.attempt_id()
            || record.owner.owner_epoch != binding.owner_epoch()
            || record.child_workspace_revision.as_deref().unwrap_or(&record.attempt_revision)
                != binding.source_revision()
            || record.accepted_spec_digest != binding.accepted_spec_digest()
            || binding.phase() != BindingAttemptPhase::Executing
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        if !matches!(
            record.state,
            ReservationState::Reserved | ReservationState::Claimed
        ) {
            return Err(WorkerPoolError::InvalidTransition);
        }

        let reservation = self
            .reservations
            .reservation(&record.reservation_id)
            .ok_or(WorkerPoolError::ReservationNotFound)?;
        if reservation.owner != *owner
            || reservation.state != record.state
            || reservation.dimension != record.dimension
            || reservation.amount != record.amount
            || reservation.expires_at_ms != record.expires_at_ms
            || (record.state == ReservationState::Claimed
                && reservation.worker_execution_id.as_deref() != Some(worker_execution_id))
            || reservation.process_identity != record.process_identity
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }

        let worktree_lease_id = record
            .worktree_lease_id
            .as_deref()
            .ok_or(WorkerPoolError::WorktreeRequired)?;
        if !self.worktrees.verify_live_managed_lease(
            worktree_lease_id,
            owner,
            worker_execution_id,
            &record.attempt_revision,
            record.expires_at_ms,
            record.state,
        ) {
            return Err(WorkerPoolError::WorktreeUnavailable);
        }
        // CLAIMED may be the durable startup fence immediately before launch.
        // It is not an active-parent proof until a process generation is bound;
        // resolve_active_parent_execution_facts independently requires that.

        Ok(DurableWorkerLeaseFactsV1 {
            worker_execution_id: worker_execution_id.to_owned(),
            goal_id: record.goal_id.clone(),
            ticket_id: record.ticket_id.clone(),
            principal_ref: owner.principal_ref().to_owned(),
            workspace_binding: owner.workspace_binding().to_owned(),
            session_id: owner.session_id().to_owned(),
            run_id: owner.run_id().to_owned(),
            task_id: owner.task_id().to_owned(),
            attempt_id: owner.attempt_id().to_owned(),
            owner_epoch: owner.owner_epoch(),
            source_revision: record.child_workspace_revision.clone().unwrap_or_else(|| record.attempt_revision.clone()),
            accepted_spec_digest: record.accepted_spec_digest.clone(),
            workspace_lease_id: worktree_lease_id.to_owned(),
            budget_lease_id: record.reservation_id.clone(),
            resource_lease_ids: vec![worktree_lease_id.to_owned()],
            worker_state: record.state,
            budget_dimension: record.dimension,
            reserved_amount: record.amount,
            expires_at_ms: record.expires_at_ms,
            process_identity: record.process_identity.clone(),
        })
    }

    /// Admission-only projection for a P8 pre-admitted RESERVED candidate.
    /// It proves the exact durable reservation and lease references needed by
    /// P2's atomic Attempt+DelegationBinding append. It carries no process,
    /// claim or effect authority; post-append execution uses the stricter
    /// `resolve_durable_worker_lease_facts` path above.
    pub(crate) fn resolve_pre_admission_lease_facts(
        &self,
        pins: &crate::worker_durable::ManagedReadyTaskPinV1,
        proof: &crate::worker_durable::ReservedWorkerLeaseProofV1,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<DurableWorkerLeaseFactsV1, WorkerPoolError> {
        self.check_owner(owner)?;
        if self.fan_out != FanOutState::ManagedAttemptBinding
            || pins.owner() != owner
            || pins.owner_epoch() != self.owner_epoch
            || pins.dimension() != BudgetDimension::ActiveWorkers
            || pins.amount() != 1
            || pins.expires_at_ms() <= now_ms
            || pins.expires_at_ms().saturating_sub(now_ms) > MAX_WORKER_LEASE_MS
            || proof.attempt_id() != pins.attempt_id()
            || proof.pins_digest() != pins.pins_digest()
            || proof.binding_digest().is_some()
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        let worker_execution_id = proof.worker_execution_id();
        let record = self.workers.get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_exact(record, owner)?;
        let ticket = self.tickets.get(proof.ticket_id())
            .ok_or(WorkerPoolError::TicketNotFound)?;
        if record.state != ReservationState::Reserved
            || record.process_identity.is_some()
            || record.cancellation_requested
            || record.unknown_effect
            || record.worktree_quarantined
            || record.class != WorkerClass::IsolatedEffectful
            || record.dimension != BudgetDimension::ActiveWorkers
            || record.amount != 1
            || record.goal_id != pins.goal_id()
            || record.owner.run_id != pins.run_id()
            || record.owner.task_id != pins.task_id()
            || record.owner.attempt_id != pins.attempt_id()
            || record.attempt_revision != pins.workspace_revision()
            || record.accepted_spec_digest != pins.accepted_spec_digest()
            || record.expires_at_ms != pins.expires_at_ms()
            || ticket.ticket_id != proof.ticket_id()
            || ticket.expected_task_revision != pins.task_revision()
            || ticket.state != TicketState::Consumed
            || ticket.worker_execution_id.as_deref() != Some(worker_execution_id)
            || ticket.dimension != BudgetDimension::ActiveWorkers
            || ticket.amount != 1
            || ticket.worktree.as_ref().is_none_or(|worktree|
                worktree.worktree_id != pins.worktree().worktree_id
                    || worktree.base_revision != pins.worktree().base_revision)
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        let reservation = self.reservations.reservation(&record.reservation_id)
            .ok_or(WorkerPoolError::ReservationNotFound)?;
        let worktree_lease_id = record.worktree_lease_id.as_deref()
            .ok_or(WorkerPoolError::WorktreeRequired)?;
        if reservation.owner != *owner
            || reservation.state != ReservationState::Reserved
            || reservation.dimension != BudgetDimension::ActiveWorkers
            || reservation.amount != 1
            || reservation.expires_at_ms != pins.expires_at_ms()
            || reservation.process_identity.is_some()
            || proof.budget_lease_id() != record.reservation_id
            || proof.workspace_lease_id() != worktree_lease_id
            || proof.resource_lease_ids().len() != 1
            || proof.resource_lease_ids()[0] != worktree_lease_id
            || !self.worktrees.verify_live_managed_lease(
                worktree_lease_id, owner, worker_execution_id,
                pins.workspace_revision(), pins.expires_at_ms(), ReservationState::Reserved,
            )
        {
            return Err(WorkerPoolError::WorktreeUnavailable);
        }
        Ok(DurableWorkerLeaseFactsV1 {
            worker_execution_id: worker_execution_id.to_owned(),
            goal_id: record.goal_id.clone(),
            ticket_id: record.ticket_id.clone(),
            principal_ref: owner.principal_ref().to_owned(),
            workspace_binding: owner.workspace_binding().to_owned(),
            session_id: owner.session_id().to_owned(),
            run_id: owner.run_id().to_owned(),
            task_id: owner.task_id().to_owned(),
            attempt_id: owner.attempt_id().to_owned(),
            owner_epoch: owner.owner_epoch(),
            source_revision: pins.workspace_revision().to_owned(),
            accepted_spec_digest: record.accepted_spec_digest.clone(),
            workspace_lease_id: worktree_lease_id.to_owned(),
            budget_lease_id: record.reservation_id.clone(),
            resource_lease_ids: vec![worktree_lease_id.to_owned()],
            worker_state: record.state,
            budget_dimension: record.dimension,
            reserved_amount: record.amount,
            expires_at_ms: record.expires_at_ms,
            process_identity: None,
        })
    }

    pub(crate) fn resolve_active_parent_execution_facts(
        &self,
        worker_execution_id: &str,
        binding: &VerifiedAttemptBinding,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
    ) -> Result<ActiveParentExecutionFactsV1, WorkerPoolError> {
        // A claimed worker record alone is insufficient lineage proof. Resolve
        // its reservation and worktree too, rejecting divergent lease state,
        // stale process incarnation, expiry, cancellation and quarantine.
        let lease = self.resolve_durable_worker_lease_facts(
            worker_execution_id, binding, owner, now_ms,
        )?;
        if lease.worker_state() != ReservationState::Claimed {
            return Err(WorkerPoolError::InvalidTransition);
        }
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        self.check_worker_owner_exact(record, owner)?;
        let process_identity = record
            .process_identity
            .clone()
            .ok_or(WorkerPoolError::ProcessIdentityMismatch)?;
        if self.fan_out != FanOutState::ManagedAttemptBinding
            || record.state != ReservationState::Claimed
            || record.class != WorkerClass::IsolatedEffectful
            || record.cancellation_requested
            || record.unknown_effect
            || record.worktree_quarantined
            || record.expires_at_ms <= now_ms
            || record.goal_id != binding.goal_id()
            || record.owner.run_id != binding.run_id()
            || record.owner.task_id != binding.task_id()
            || record.owner.attempt_id != binding.attempt_id()
            || record.owner.owner_epoch != binding.owner_epoch()
            || record.child_workspace_revision.as_deref().unwrap_or(&record.attempt_revision)
                != binding.source_revision()
            || record.accepted_spec_digest != binding.accepted_spec_digest()
            || binding.phase() != BindingAttemptPhase::Executing
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        Ok(ActiveParentExecutionFactsV1 {
            worker_execution_id: worker_execution_id.to_owned(),
            goal_id: record.goal_id.clone(),
            owner: record.owner.clone(),
            source_revision: record.child_workspace_revision.clone().unwrap_or_else(|| record.attempt_revision.clone()),
            accepted_spec_digest: record.accepted_spec_digest.clone(),
            process_identity,
        })
    }

    pub(crate) fn durable_process_lease_facts(
        &self,
    ) -> Result<Vec<crate::resource_sampler::OwnedProcessLeaseV1>, WorkerPoolError> {
        let mut leases = Vec::new();
        for (worker_execution_id, record) in &self.workers {
            if !is_capacity_holding(record.state) {
                continue;
            }
            let Some(process_identity) = record.process_identity.clone() else {
                continue;
            };
            let owner = AuthenticatedOwnerContext::rehydrate_from_durable_scope(
                record.owner.principal_ref.clone(),
                record.owner.workspace_binding.clone(),
                record.owner.session_id.clone(),
                record.owner.run_id.clone(),
                record.owner.task_id.clone(),
                record.owner.attempt_id.clone(),
                record.owner.owner_epoch,
            )
            .map_err(WorkerPoolError::Reservation)?;
            let state = record.state;
            let source_revision = record.child_workspace_revision.clone().ok_or(
                WorkerPoolError::AttemptBindingMismatch,
            )?;
            let lease = crate::resource_sampler::OwnedProcessLeaseV1::from_durable_owner(
                worker_execution_id.clone(),
                owner,
                source_revision,
                process_identity,
                state,
            )
            .map_err(|_| WorkerPoolError::InvalidTransition)?;
            leases.push(lease);
        }
        Ok(leases)
    }

    pub fn live_worker_count(&self) -> usize {
        self.workers
            .values()
            .filter(|record| is_capacity_holding(record.state))
            .count()
    }

    fn quarantine_record(&mut self, worker_execution_id: &str) -> Result<(), WorkerPoolError> {
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        match record.state {
            ReservationState::Quarantined => return Ok(()),
            ReservationState::Claimed | ReservationState::ReleasePending => {}
            _ => return Err(WorkerPoolError::InvalidTransition),
        }
        let reservation_id = record.reservation_id.clone();
        let worktree_lease_id = record.worktree_lease_id.clone();
        let scope_owner = rehydrate_owner(&record.owner);
        self.reservations.quarantine(
            &reservation_id,
            &scope_owner,
            self.reservations.revision(),
        )?;
        if let Some(worktree_lease_id) = &worktree_lease_id {
            self.worktrees.quarantine(
                worktree_lease_id,
                &scope_owner,
                self.worktrees.revision(),
            )?;
        }
        let revision = self.next_revision()?;
        let record = self
            .workers
            .get_mut(worker_execution_id)
            .expect("worker checked");
        record.state = ReservationState::Quarantined;
        record.unknown_effect = true;
        record.worktree_quarantined = worktree_lease_id.is_some();
        self.revision = revision;
        Ok(())
    }

    fn expire_record_inner(
        &mut self,
        worker_execution_id: &str,
        now_ms: u64,
        proof: ReservationProof,
    ) -> Result<(), WorkerPoolError> {
        let record = self
            .workers
            .get(worker_execution_id)
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        if record.state == ReservationState::Expired {
            return Ok(());
        }
        if record.state != ReservationState::Reserved
            || record.process_identity.is_some()
            || record.worktree_quarantined
        {
            return Err(WorkerPoolError::InvalidTransition);
        }
        let reservation_id = record.reservation_id.clone();
        let worktree_lease_id = record.worktree_lease_id.clone();
        let scope_owner = rehydrate_owner(&record.owner);
        self.reservations.expire_unlaunched(
            &reservation_id,
            &scope_owner,
            now_ms,
            proof,
            self.reservations.revision(),
        )?;
        if let Some(worktree_lease_id) = &worktree_lease_id {
            self.worktrees.expire_unlaunched(
                worktree_lease_id,
                &scope_owner,
                now_ms,
                proof,
                self.worktrees.revision(),
            )?;
        }
        let revision = self.next_revision()?;
        self.workers
            .get_mut(worker_execution_id)
            .expect("worker checked")
            .state = ReservationState::Expired;
        self.revision = revision;
        Ok(())
    }

    fn check_owner(&self, owner: &AuthenticatedOwnerContext) -> Result<(), WorkerPoolError> {
        self.check_epoch(owner.owner_epoch())
    }

    pub(crate) fn validate_parent_lineage(
        &self,
        lineage: &ParentExecutionLineageV1,
        child_owner: &AuthenticatedOwnerContext,
        child_goal_id: &str,
        child_source_revision: &str,
        child_spec_digest: &str,
        expected_revision: u64,
        require_exact_proof_revision: bool,
        now_ms: u64,
    ) -> Result<(), WorkerPoolError> {
        self.check_revision(expected_revision)?;
        let record = self
            .workers
            .get(lineage.worker_execution_id())
            .ok_or(WorkerPoolError::WorkerNotFound)?;
        // `lineage.owner` is the parent Attempt, while `child_owner` is the
        // newly admitted child Attempt. Their logical Session IDs are distinct
        // by contract; HostKernel's authenticated Attempt/parent-ID proof
        // verifies the relationship. Keep the shared principal/workspace/Run
        // and owner-epoch fences here without collapsing the two Session IDs.
        if !lineage
            .owner()
            .matches_owner(&rehydrate_parent_owner(record))
            || lineage.goal_id() != record.goal_id
            || record.state != ReservationState::Claimed
            || record.process_identity.as_ref() != Some(lineage.process_identity())
            || record.cancellation_requested
            || record.unknown_effect
            || record.worktree_quarantined
            || record.expires_at_ms == 0
            || record.owner.principal_ref != child_owner.principal_ref()
            || record.owner.workspace_binding != child_owner.workspace_binding()
            || record.owner.run_id != child_owner.run_id()
            || record.owner.owner_epoch != child_owner.owner_epoch()
            || record.goal_id != child_goal_id
            || child_source_revision != lineage.source_revision()
            || child_spec_digest != lineage.accepted_spec_digest()
            || record.attempt_revision != lineage.source_revision()
            || record.accepted_spec_digest != lineage.accepted_spec_digest()
            || record.owner.task_id == child_owner.task_id()
            || record.owner.attempt_id == child_owner.attempt_id()
            || (now_ms != 0 && record.expires_at_ms <= now_ms)
            || (require_exact_proof_revision && lineage.worker_pool_revision() != self.revision)
            || (!require_exact_proof_revision && lineage.worker_pool_revision() > self.revision)
            || lineage.owner_log_id().is_empty()
            || lineage.owner_log_sequence().parse::<u64>().is_err()
            || !lineage.owner_log_event_digest().starts_with("blake3:")
        {
            return Err(WorkerPoolError::AttemptBindingMismatch);
        }
        Ok(())
    }

    fn check_epoch(&self, owner_epoch: u64) -> Result<(), WorkerPoolError> {
        if owner_epoch == self.owner_epoch {
            Ok(())
        } else {
            Err(WorkerPoolError::StaleOwnerEpoch)
        }
    }

    fn check_worker_owner_exact(
        &self,
        record: &WorkerRecord,
        owner: &AuthenticatedOwnerContext,
    ) -> Result<(), WorkerPoolError> {
        if record.owner.matches_owner(owner) {
            Ok(())
        } else {
            Err(WorkerPoolError::ScopeMismatch)
        }
    }

    /// A record fenced to an older owner epoch may be settled by the same
    /// trusted scope at the current epoch (quarantine reconciliation, expiry of
    /// a provably unlaunched reservation). It can never be claimed, dispatched
    /// or settled as a success under a new epoch.
    fn check_worker_owner_fenced(
        &self,
        record: &WorkerRecord,
        owner: &AuthenticatedOwnerContext,
    ) -> Result<(), WorkerPoolError> {
        if record.owner.matches_owner(owner) {
            return Ok(());
        }
        if record.owner.owner_epoch < self.owner_epoch
            && record.owner.matches_owner_ignoring_epoch(owner)
        {
            return Ok(());
        }
        Err(WorkerPoolError::ScopeMismatch)
    }

    fn check_revision(&self, expected_revision: u64) -> Result<(), WorkerPoolError> {
        if expected_revision == self.revision {
            Ok(())
        } else {
            Err(WorkerPoolError::StaleRevision)
        }
    }

    fn next_revision(&self) -> Result<u64, WorkerPoolError> {
        self.revision
            .checked_add(1)
            .ok_or(WorkerPoolError::InvalidConfiguration)
    }
}

fn lease_view_named(worker_execution_id: &str, record: &WorkerRecord) -> WorkerLeaseView {
    WorkerLeaseView {
        worker_execution_id: worker_execution_id.to_owned(),
        ticket_id: record.ticket_id.clone(),
        goal_id: record.goal_id.clone(),
        state: record.state,
        dimension: record.dimension,
        amount: record.amount,
        worktree_lease_id: record.worktree_lease_id.clone(),
        run_id: record.owner.run_id.clone(),
        task_id: record.owner.task_id.clone(),
        attempt_id: record.owner.attempt_id.clone(),
    }
}

fn is_capacity_holding(state: ReservationState) -> bool {
    matches!(
        state,
        ReservationState::Reserved
            | ReservationState::Claimed
            | ReservationState::ReleasePending
            | ReservationState::Quarantined
    )
}

fn worker_binding_matches(worker: &WorkerRecord, binding: &VerifiedAttemptBinding) -> bool {
    worker.goal_id == binding.goal_id()
        && worker.owner.run_id == binding.run_id()
        && worker.owner.task_id == binding.task_id()
        && worker.owner.attempt_id == binding.attempt_id()
        && worker.owner.owner_epoch == binding.owner_epoch()
        && worker.accepted_spec_digest == binding.accepted_spec_digest()
}

fn worktree_settlement_evidence(
    settlement: &WorkerSettlement,
    process_identity: &ProcessIdentity,
) -> WorktreeSettlementEvidence {
    WorktreeSettlementEvidence {
        process_identity: Some(process_identity.clone()),
        owned_process_exited: settlement.owned_process_exited,
        effects_settled: settlement.effects_settled,
        reconciliation_complete: settlement.reconciliation_complete,
        observed_revision: settlement
            .worktree
            .as_ref()
            .and_then(|facts| facts.observed_revision.clone()),
        clean: settlement.worktree.as_ref().and_then(|facts| facts.clean),
        has_untracked: settlement
            .worktree
            .as_ref()
            .and_then(|facts| facts.has_untracked),
    }
}

fn scope_matches(scope: &CancelScope, owner: &OwnerScopeKey) -> bool {
    match scope {
        CancelScope::Run { run_id } => &owner.run_id == run_id,
        CancelScope::Task { run_id, task_id } => {
            &owner.run_id == run_id && &owner.task_id == task_id
        }
        CancelScope::Attempt {
            run_id,
            task_id,
            attempt_id,
        } => {
            &owner.run_id == run_id && &owner.task_id == task_id && &owner.attempt_id == attempt_id
        }
        CancelScope::Worker { .. } => false,
    }
}

fn owner_matches_scope(scope: &CancelScope, owner: &AuthenticatedOwnerContext) -> bool {
    match scope {
        CancelScope::Run { run_id } => owner.run_id() == run_id,
        CancelScope::Task { run_id, task_id } => {
            owner.run_id() == run_id && owner.task_id() == task_id
        }
        CancelScope::Attempt {
            run_id,
            task_id,
            attempt_id,
        } => {
            owner.run_id() == run_id
                && owner.task_id() == task_id
                && owner.attempt_id() == attempt_id
        }
        CancelScope::Worker {
            worker_execution_id,
        } => !worker_execution_id.is_empty(),
    }
}

fn rehydrate_owner(scope: &OwnerScopeKey) -> AuthenticatedOwnerContext {
    AuthenticatedOwnerContext::rehydrate_from_durable_scope(
        scope.principal_ref.clone(),
        scope.workspace_binding.clone(),
        scope.session_id.clone(),
        scope.run_id.clone(),
        scope.task_id.clone(),
        scope.attempt_id.clone(),
        scope.owner_epoch,
    )
    .expect("persisted owner scope is bounded and non-zero")
}

fn validate_enqueue(request: &EnqueueRequest) -> Result<(), WorkerPoolError> {
    validate_id("ticket ID", &request.ticket_id)?;
    validate_id("goal ID", &request.goal_id)?;
    validate_id("idempotency key", &request.idempotency_key)?;
    validate_id("expected task revision", &request.expected_task_revision)?;
    validate_digest("accepted SpecVersion digest", &request.accepted_spec_digest)?;
    if request.amount == 0 || request.expires_at_ms == 0 {
        return Err(WorkerPoolError::InvalidRequest);
    }
    if let Some(worktree) = &request.worktree {
        validate_id("worktree ID", &worktree.worktree_id)?;
        validate_id("worktree base revision", &worktree.base_revision)?;
    }
    Ok(())
}

fn rehydrate_parent_owner(record: &WorkerRecord) -> AuthenticatedOwnerContext {
    AuthenticatedOwnerContext::rehydrate_from_durable_scope(
        record.owner.principal_ref.clone(),
        record.owner.workspace_binding.clone(),
        record.owner.session_id.clone(),
        record.owner.run_id.clone(),
        record.owner.task_id.clone(),
        record.owner.attempt_id.clone(),
        record.owner.owner_epoch,
    )
    .expect("worker owner scope was validated at ingress")
}

fn validate_settlement(settlement: &WorkerSettlement) -> Result<(), WorkerPoolError> {
    if settlement.evidence_refs.len() > MAX_EVIDENCE_REFS
        || settlement.external_effect_refs.len() > MAX_EVIDENCE_REFS
    {
        return Err(WorkerPoolError::InvalidRequest);
    }
    for reference in settlement
        .evidence_refs
        .iter()
        .chain(settlement.external_effect_refs.iter())
    {
        if reference.is_empty() || reference.len() > MAX_REF_LENGTH {
            return Err(WorkerPoolError::InvalidRequest);
        }
    }
    Ok(())
}

fn validate_id(_label: &str, value: &str) -> Result<(), WorkerPoolError> {
    if value.is_empty() || value.len() > MAX_ID_LENGTH || !value.is_ascii() {
        return Err(WorkerPoolError::InvalidRequest);
    }
    if value
        .bytes()
        .any(|byte| byte.is_ascii_control() || byte == b'/' || byte == b'\\')
    {
        return Err(WorkerPoolError::InvalidRequest);
    }
    Ok(())
}

fn validate_digest(_label: &str, value: &str) -> Result<(), WorkerPoolError> {
    let Some(hex) = value.strip_prefix("blake3:") else {
        return Err(WorkerPoolError::InvalidRequest);
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkerPoolError::InvalidRequest);
    }
    Ok(())
}

fn map_reservation_error(error: ResourceOwnerError) -> WorkerPoolError {
    match error {
        ResourceOwnerError::UnknownCapacity => WorkerPoolError::CapacityUnknown,
        ResourceOwnerError::CapacityUnknown => WorkerPoolError::CapacityUnknown,
        other => WorkerPoolError::Reservation(other),
    }
}
