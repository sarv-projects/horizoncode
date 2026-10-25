//! Bounded, process-local model of the Rust-owned worktree lease lifecycle.
//!
//! This module records registrations and leases only. It does not create, inspect,
//! merge, delete, or clean filesystem worktrees, and it is not backed by OwnerLog.
//! Production admission must persist transitions before dispatch and must obtain
//! registration/settlement facts from the guarded workspace and process owners.
//! A lease ID is a reference, never authorization by itself.

use std::collections::{BTreeMap, HashMap};
use std::path::{Component, PathBuf};

use crate::resource_budget::{
    AuthenticatedOwnerContext, ReservationProof, ReservationState, ReservationTransitionError,
};
use crate::resource_sampler::ProcessIdentity;
use crate::worktree_lifecycle::WorktreeRootOwnerV1;

const MAX_WORKTREES: usize = 4096;
const MAX_LEASE_HISTORY_RECORDS: usize = 4096;
const MAX_ID_LENGTH: usize = 128;
const MAX_REVISION_LENGTH: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorktreeStatus {
    Free,
    Leased,
    Quarantined,
    Removed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorktreePoolError {
    InvalidConfiguration,
    InvalidRegistration,
    InvalidRequest,
    StaleRevision,
    StaleOwnerEpoch,
    ScopeMismatch,
    IdempotencyConflict,
    PoolLimitReached,
    ActiveLeaseLimitReached,
    LeaseHistoryLimitReached,
    DuplicateWorktree,
    DuplicatePath,
    NotAvailable,
    BaseRevisionMismatch,
    ReservationNotFound,
    InvalidTransition,
    MissingProof,
    NotExpired,
    WorkerIdentityConflict,
    ProcessIdentityMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeRegistration {
    pub id: String,
    pub workspace_binding: String,
    pub path: PathBuf,
    pub base_revision: String,
    pub observed_revision: Option<String>,
    pub clean: Option<bool>,
    pub has_untracked: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeLease {
    pub lease_id: String,
    pub worktree_id: String,
    /// Stable Git/worktree base locator. This is intentionally independent of
    /// the measured content revision used by an admitted Attempt.
    pub base_revision: String,
    pub source_revision: String,
    pub owner: AuthenticatedOwnerContext,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementEvidence {
    pub process_identity: Option<ProcessIdentity>,
    pub owned_process_exited: bool,
    pub effects_settled: bool,
    pub reconciliation_complete: bool,
    pub observed_revision: Option<String>,
    pub clean: Option<bool>,
    pub has_untracked: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeSnapshot {
    pub id: String,
    pub workspace_binding: String,
    pub path: PathBuf,
    pub base_revision: String,
    pub observed_revision: Option<String>,
    pub status: WorktreeStatus,
    pub reservation_state: Option<ReservationState>,
    pub lease_id: Option<String>,
}

#[derive(Clone, Debug)]
struct WorktreeRecord {
    registration: WorktreeRegistration,
    status: WorktreeStatus,
    reservation_state: Option<ReservationState>,
    active_lease_id: Option<String>,
}

#[derive(Clone, Debug)]
struct LeaseRecord {
    lease: WorktreeLease,
    state: ReservationState,
    worker_execution_id: Option<String>,
    process_identity: Option<ProcessIdentity>,
    settlement: Option<SettlementEvidence>,
}

/// A bounded lease state machine, not a production scheduler or worktree manager.
#[derive(Clone, Debug)]
pub struct WorktreePool {
    owner_epoch: u64,
    max_worktrees: usize,
    max_active_leases: usize,
    revision: u64,
    next_lease_number: u64,
    worktrees: BTreeMap<String, WorktreeRecord>,
    leases: BTreeMap<String, LeaseRecord>,
    idempotency: HashMap<(AuthenticatedOwnerContext, String), String>,
}

impl WorktreePool {
    pub fn new(
        owner_epoch: u64,
        max_worktrees: usize,
        max_active_leases: usize,
    ) -> Result<Self, WorktreePoolError> {
        if owner_epoch == 0
            || max_worktrees == 0
            || max_worktrees > MAX_WORKTREES
            || max_active_leases == 0
            || max_active_leases > max_worktrees
        {
            return Err(WorktreePoolError::InvalidConfiguration);
        }
        Ok(Self {
            owner_epoch,
            max_worktrees,
            max_active_leases,
            revision: 0,
            next_lease_number: 1,
            worktrees: BTreeMap::new(),
            leases: BTreeMap::new(),
            idempotency: HashMap::new(),
        })
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Select an already registered clean tree for this exact authenticated
    /// workspace and measured content revision. Iteration is over the ordered
    /// registry so retries choose deterministically. The caller receives no
    /// filesystem path and cannot nominate a worktree ID.
    pub(crate) fn resolve_clean_registered(
        &self,
        owner: &AuthenticatedOwnerContext,
        source_revision: &str,
        verified_ids: &std::collections::BTreeSet<String>,
    ) -> Result<(String, String), WorktreePoolError> {
        self.check_owner(owner)?;
        validate_revision(source_revision)?;
        self.worktrees.iter().find_map(|(id, record)| {
            let registration = &record.registration;
            (record.status == WorktreeStatus::Free
                && verified_ids.contains(id)
                && record.active_lease_id.is_none()
                && registration.workspace_binding == owner.workspace_binding()
                && registration.observed_revision.as_deref() == Some(source_revision)
                && registration_is_clean(registration))
                .then(|| (id.clone(), registration.base_revision.clone()))
        }).ok_or(WorktreePoolError::NotAvailable)
    }

    /// See [`crate::resource_budget::ResourceReservationOwner::owner_epoch`].
    #[allow(dead_code)]
    pub(crate) fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }

    pub fn register(
        &mut self,
        registration: WorktreeRegistration,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        self.register_scoped(registration, owner.workspace_binding(), owner.owner_epoch(), expected_revision)
    }

    pub(crate) fn register_root_owned(
        &mut self,
        registration: WorktreeRegistration,
        owner: &WorktreeRootOwnerV1,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        if owner.owner_epoch() != self.owner_epoch {
            return Err(WorktreePoolError::StaleOwnerEpoch);
        }
        self.register_scoped(registration, owner.workspace_binding(), owner.owner_epoch(), expected_revision)
    }

    fn register_scoped(
        &mut self,
        registration: WorktreeRegistration,
        workspace_binding: &str,
        owner_epoch: u64,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        if owner_epoch != self.owner_epoch {
            return Err(WorktreePoolError::StaleOwnerEpoch);
        }
        validate_registration(&registration, workspace_binding)?;
        self.check_revision(expected_revision)?;
        if self.worktrees.contains_key(&registration.id) {
            return Err(WorktreePoolError::DuplicateWorktree);
        }
        if self
            .worktrees
            .values()
            .any(|worktree| worktree.registration.path == registration.path)
        {
            return Err(WorktreePoolError::DuplicatePath);
        }
        if self.worktrees.len() >= self.max_worktrees {
            return Err(WorktreePoolError::PoolLimitReached);
        }
        let revision = self.next_revision()?;
        let status = if registration_is_clean(&registration) {
            WorktreeStatus::Free
        } else {
            WorktreeStatus::Quarantined
        };
        self.worktrees.insert(
            registration.id.clone(),
            WorktreeRecord {
                registration,
                status,
                reservation_state: None,
                active_lease_id: None,
            },
        );
        self.revision = revision;
        Ok(revision)
    }

    /// Replays of the same owner/request return the original lease without a new debit.
    /// A new request is admitted only against the current pool revision.
    pub fn acquire(
        &mut self,
        request_id: &str,
        worktree_id: &str,
        base_revision: &str,
        owner: AuthenticatedOwnerContext,
        expected_revision: u64,
        expires_at_ms: u64,
    ) -> Result<WorktreeLease, WorktreePoolError> {
        self.acquire_pinned(
            request_id,
            worktree_id,
            base_revision,
            base_revision,
            owner,
            expected_revision,
            expires_at_ms,
        )
    }

    /// Acquire against two independent pins: the worktree's base locator and
    /// the HostKernel-measured content revision. The latter may change as
    /// work is integrated without changing the worktree's base locator.
    pub(crate) fn acquire_pinned(
        &mut self,
        request_id: &str,
        worktree_id: &str,
        base_revision: &str,
        source_revision: &str,
        owner: AuthenticatedOwnerContext,
        expected_revision: u64,
        expires_at_ms: u64,
    ) -> Result<WorktreeLease, WorktreePoolError> {
        self.check_owner(&owner)?;
        validate_acquire(request_id, worktree_id, base_revision, expires_at_ms)?;
        validate_revision(source_revision)?;

        let idempotency_key = (owner.clone(), request_id.to_owned());
        if let Some(lease_id) = self.idempotency.get(&idempotency_key) {
            let existing = self
                .leases
                .get(lease_id)
                .ok_or(WorktreePoolError::ReservationNotFound)?;
            if existing.lease.worktree_id == worktree_id
                && existing.lease.base_revision == base_revision
                && existing.lease.source_revision == source_revision
                && existing.lease.expires_at_ms == expires_at_ms
                && existing.lease.owner == owner
            {
                return Ok(existing.lease.clone());
            }
            return Err(WorktreePoolError::IdempotencyConflict);
        }

        self.check_revision(expected_revision)?;
        let worktree = self
            .worktrees
            .get(worktree_id)
            .ok_or(WorktreePoolError::NotAvailable)?;
        if worktree.registration.workspace_binding != owner.workspace_binding() {
            return Err(WorktreePoolError::ScopeMismatch);
        }
        if worktree.status != WorktreeStatus::Free || worktree.active_lease_id.is_some() {
            return Err(WorktreePoolError::NotAvailable);
        }
        if worktree.registration.base_revision != base_revision
            || worktree.registration.observed_revision.as_deref() != Some(source_revision)
        {
            return Err(WorktreePoolError::BaseRevisionMismatch);
        }
        if self
            .worktrees
            .values()
            .filter(|item| item.active_lease_id.is_some())
            .count()
            >= self.max_active_leases
        {
            return Err(WorktreePoolError::ActiveLeaseLimitReached);
        }
        if self.leases.len() >= MAX_LEASE_HISTORY_RECORDS {
            return Err(WorktreePoolError::LeaseHistoryLimitReached);
        }

        let revision = self.next_revision()?;
        let next_lease_number = self
            .next_lease_number
            .checked_add(1)
            .ok_or(WorktreePoolError::InvalidConfiguration)?;
        let lease_id = format!("worktree-lease-{}", self.next_lease_number);
        let lease = WorktreeLease {
            lease_id: lease_id.clone(),
            worktree_id: worktree_id.to_owned(),
            base_revision: base_revision.to_owned(),
            source_revision: source_revision.to_owned(),
            owner,
            expires_at_ms,
        };

        self.leases.insert(
            lease_id.clone(),
            LeaseRecord {
                lease: lease.clone(),
                state: ReservationState::Reserved,
                worker_execution_id: None,
                process_identity: None,
                settlement: None,
            },
        );
        self.idempotency.insert(idempotency_key, lease_id.clone());
        let worktree = self
            .worktrees
            .get_mut(worktree_id)
            .expect("worktree checked before lease creation");
        worktree.status = WorktreeStatus::Leased;
        worktree.reservation_state = Some(ReservationState::Reserved);
        worktree.active_lease_id = Some(lease_id);
        self.next_lease_number = next_lease_number;
        self.revision = revision;
        Ok(lease)
    }

    pub fn claim(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        worker_execution_id: &str,
        process_identity: ProcessIdentity,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        validate_worker(worker_execution_id, &process_identity)?;
        let record = self
            .leases
            .get(lease_id)
            .ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if record.state == ReservationState::Claimed {
            if record.worker_execution_id.as_deref() == Some(worker_execution_id)
                && record.process_identity.as_ref() == Some(&process_identity)
            {
                return Ok(self.revision);
            }
            return Err(WorktreePoolError::WorkerIdentityConflict);
        }
        self.check_revision(expected_revision)?;
        record
            .state
            .validate_transition(ReservationState::Claimed, ReservationProof::default())
            .map_err(map_transition_error)?;
        let revision = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        let current = self.leases.get_mut(lease_id).expect("lease checked");
        current.state = ReservationState::Claimed;
        current.worker_execution_id = Some(worker_execution_id.to_owned());
        current.process_identity = Some(process_identity);
        let worktree = self
            .worktrees
            .get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime");
        worktree.reservation_state = Some(ReservationState::Claimed);
        self.revision = revision;
        Ok(revision)
    }

    /// Claims the workspace lease for an admitted worker *before* any process
    /// spawn, without an OS process identity yet. A lease consumed this way can
    /// never `EXPIRED`-free its capacity: it must be settled or quarantined,
    /// and [`Self::bind_process`] records the OS generation afterwards.
    pub fn claim_unlaunched(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        worker_execution_id: &str,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        if worker_execution_id.is_empty() || worker_execution_id.len() > MAX_ID_LENGTH {
            return Err(WorktreePoolError::InvalidRequest);
        }
        let record = self
            .leases
            .get(lease_id)
            .ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if record.state == ReservationState::Claimed {
            return if record.worker_execution_id.as_deref() == Some(worker_execution_id) {
                Ok(self.revision)
            } else {
                Err(WorktreePoolError::WorkerIdentityConflict)
            };
        }
        self.check_revision(expected_revision)?;
        record
            .state
            .validate_transition(ReservationState::Claimed, ReservationProof::default())
            .map_err(map_transition_error)?;
        let revision = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        let current = self.leases.get_mut(lease_id).expect("lease checked");
        current.state = ReservationState::Claimed;
        current.worker_execution_id = Some(worker_execution_id.to_owned());
        let worktree = self
            .worktrees
            .get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime");
        worktree.reservation_state = Some(ReservationState::Claimed);
        self.revision = revision;
        Ok(revision)
    }

    /// Binds the OS process generation to an already-claimed lease. Replays of
    /// the same identity are idempotent; a different generation is rejected so
    /// a reused PID cannot inherit the lease.
    pub fn bind_process(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        process_identity: ProcessIdentity,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        if process_identity.pid == 0 || process_identity.start_identity == 0 {
            return Err(WorktreePoolError::InvalidRequest);
        }
        let record = self
            .leases
            .get(lease_id)
            .ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if record.state != ReservationState::Claimed {
            return Err(WorktreePoolError::InvalidTransition);
        }
        if let Some(existing) = &record.process_identity {
            return if *existing == process_identity {
                Ok(self.revision)
            } else {
                Err(WorktreePoolError::ProcessIdentityMismatch)
            };
        }
        self.check_revision(expected_revision)?;
        let revision = self.next_revision()?;
        self.leases
            .get_mut(lease_id)
            .expect("lease checked")
            .process_identity = Some(process_identity);
        self.revision = revision;
        Ok(revision)
    }

    pub fn begin_release(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        let record = self
            .leases
            .get(lease_id)
            .ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if record.state == ReservationState::ReleasePending {
            return Ok(self.revision);
        }
        self.check_revision(expected_revision)?;
        record
            .state
            .validate_transition(
                ReservationState::ReleasePending,
                ReservationProof::default(),
            )
            .map_err(map_transition_error)?;
        let revision = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        self.leases.get_mut(lease_id).expect("lease checked").state =
            ReservationState::ReleasePending;
        self.worktrees
            .get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime")
            .reservation_state = Some(ReservationState::ReleasePending);
        self.revision = revision;
        Ok(revision)
    }

    pub fn expire_unlaunched(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
        proof: ReservationProof,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        let record = self
            .leases
            .get(lease_id)
            .ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if record.state == ReservationState::Expired {
            return Ok(self.revision);
        }
        if record.state != ReservationState::Reserved
            || record.worker_execution_id.is_some()
            || record.process_identity.is_some()
        {
            return Err(WorktreePoolError::InvalidTransition);
        }
        if now_ms < record.lease.expires_at_ms {
            return Err(WorktreePoolError::NotExpired);
        }
        self.check_revision(expected_revision)?;
        record
            .state
            .validate_transition(ReservationState::Expired, proof)
            .map_err(map_transition_error)?;
        let revision = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        self.leases.get_mut(lease_id).expect("lease checked").state = ReservationState::Expired;
        let worktree = self
            .worktrees
            .get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime");
        worktree.status = WorktreeStatus::Free;
        worktree.reservation_state = Some(ReservationState::Expired);
        worktree.active_lease_id = None;
        self.revision = revision;
        Ok(revision)
    }

    pub(crate) fn expire_unlaunched_reconciled(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        proof: ReservationProof,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        let record = self.leases.get(lease_id).ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if record.state == ReservationState::Expired { return Ok(self.revision); }
        if record.state != ReservationState::Reserved || record.worker_execution_id.is_some()
            || record.process_identity.is_some() || !proof.no_launch_or_dispatch
            || !proof.reconciliation_complete
        {
            return Err(WorktreePoolError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        record.state.validate_transition(ReservationState::Expired, proof)
            .map_err(map_transition_error)?;
        let revision = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        self.leases.get_mut(lease_id).expect("lease checked").state = ReservationState::Expired;
        let worktree = self.worktrees.get_mut(&worktree_id).expect("registered worktree retained for lease lifetime");
        worktree.status = WorktreeStatus::Free;
        worktree.reservation_state = Some(ReservationState::Expired);
        self.revision = revision;
        Ok(revision)
    }

    pub fn quarantine(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        let record = self
            .leases
            .get(lease_id)
            .ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if record.state == ReservationState::Quarantined {
            return Ok(self.revision);
        }
        self.check_revision(expected_revision)?;
        record
            .state
            .validate_transition(ReservationState::Quarantined, ReservationProof::default())
            .map_err(map_transition_error)?;
        let revision = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        self.leases.get_mut(lease_id).expect("lease checked").state = ReservationState::Quarantined;
        let worktree = self
            .worktrees
            .get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime");
        worktree.status = WorktreeStatus::Quarantined;
        worktree.reservation_state = Some(ReservationState::Quarantined);
        self.revision = revision;
        Ok(revision)
    }

    /// Reconciliation moves a quarantined lease to release-pending only after
    /// reconciliation and owned-process exit are confirmed. This does not free
    /// capacity or make the worktree reusable; final release still requires
    /// settled effects and a clean unchanged workspace.
    pub fn reconcile_quarantined(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        evidence: &SettlementEvidence,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        let record = self
            .leases
            .get(lease_id)
            .ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        self.check_process_evidence(record, evidence)?;
        if !evidence.owned_process_exited || !evidence.reconciliation_complete {
            return Err(WorktreePoolError::MissingProof);
        }
        if record.state == ReservationState::ReleasePending {
            return Ok(self.revision);
        }
        if record.state != ReservationState::Quarantined {
            return Err(WorktreePoolError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        record
            .state
            .validate_transition(
                ReservationState::ReleasePending,
                ReservationProof {
                    owned_process_exited: true,
                    reconciliation_complete: true,
                    ..ReservationProof::default()
                },
            )
            .map_err(map_transition_error)?;

        let revision = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        self.leases.get_mut(lease_id).expect("lease checked").state =
            ReservationState::ReleasePending;
        self.worktrees
            .get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime")
            .reservation_state = Some(ReservationState::ReleasePending);
        self.revision = revision;
        Ok(revision)
    }

    pub fn release(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        evidence: SettlementEvidence,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        let record = self
            .leases
            .get(lease_id)
            .ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if record.state == ReservationState::Released {
            return if record.settlement.as_ref() == Some(&evidence) {
                Ok(self.revision)
            } else {
                Err(WorktreePoolError::IdempotencyConflict)
            };
        }
        if record.state != ReservationState::ReleasePending {
            return Err(WorktreePoolError::InvalidTransition);
        }
        self.check_process_evidence(record, &evidence)?;
        if !evidence.owned_process_exited
            || !evidence.effects_settled
            || !evidence.reconciliation_complete
        {
            return Err(WorktreePoolError::MissingProof);
        }
        self.check_revision(expected_revision)?;
        let proof = ReservationProof {
            owned_process_exited: evidence.owned_process_exited,
            effects_settled: evidence.effects_settled,
            reconciliation_complete: evidence.reconciliation_complete,
            ..ReservationProof::default()
        };
        record
            .state
            .validate_transition(ReservationState::Released, proof)
            .map_err(map_transition_error)?;
        let revision = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        let current = self.leases.get_mut(lease_id).expect("lease checked");
        current.state = ReservationState::Released;
        current.settlement = Some(evidence.clone());
        let worktree = self
            .worktrees
            .get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime");
        let reusable = evidence.observed_revision.as_ref().is_some_and(|revision| {
            validate_revision(revision).is_ok()
        }) && evidence.clean == Some(true)
            && evidence.has_untracked == Some(false);
        worktree.registration.observed_revision = evidence.observed_revision;
        worktree.registration.clean = evidence.clean;
        worktree.registration.has_untracked = evidence.has_untracked;
        worktree.status = if reusable {
            WorktreeStatus::Free
        } else {
            WorktreeStatus::Quarantined
        };
        worktree.reservation_state = Some(ReservationState::Released);
        worktree.active_lease_id = None;
        self.revision = revision;
        Ok(revision)
    }

    /// Logical managed child finalization. The caller is WorkerPool's
    /// proof-consuming durable adapter; this method is crate-private and has no
    /// caller-supplied process-exit flags. Missing/dirty observations preserve
    /// the worktree in QUARANTINED state.
    pub(crate) fn settle_logical_managed(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        observed_revision: Option<String>,
        clean: bool,
        has_untracked: bool,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        let record = self.leases.get(lease_id).ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if record.process_identity.is_some()
            || !matches!(record.state, ReservationState::Claimed | ReservationState::Quarantined)
        {
            return Err(WorktreePoolError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        if let Some(revision) = observed_revision.as_deref() {
            validate_revision(revision)?;
        }
        let next = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        let reusable = observed_revision.is_some() && clean && !has_untracked;
        let lease = self.leases.get_mut(lease_id).expect("checked lease");
        lease.state = if reusable { ReservationState::Released } else { ReservationState::Quarantined };
        lease.settlement = None;
        let worktree = self.worktrees.get_mut(&worktree_id).expect("registered worktree retained for lease lifetime");
        worktree.status = if reusable { WorktreeStatus::Free } else { WorktreeStatus::Quarantined };
        worktree.reservation_state = Some(lease.state);
        worktree.registration.observed_revision = observed_revision;
        worktree.registration.clean = Some(clean);
        worktree.registration.has_untracked = Some(has_untracked);
        worktree.active_lease_id = None;
        self.revision = next;
        Ok(next)
    }

    pub(crate) fn settle_logical_managed_reconciled(
        &mut self,
        lease_id: &str,
        recorded_owner: &AuthenticatedOwnerContext,
        current_owner_epoch: u64,
        observed_revision: Option<String>,
        clean: bool,
        has_untracked: bool,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        let record = self.leases.get(lease_id).ok_or(WorktreePoolError::ReservationNotFound)?;
        if &record.lease.owner != recorded_owner
            || current_owner_epoch != self.owner_epoch
            || current_owner_epoch < recorded_owner.owner_epoch()
            || record.process_identity.is_some()
            || record.state != ReservationState::Quarantined
        {
            return Err(WorktreePoolError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        if let Some(revision) = observed_revision.as_deref() { validate_revision(revision)?; }
        let reusable = observed_revision.is_some() && clean && !has_untracked;
        let next = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        let lease = self.leases.get_mut(lease_id).expect("checked lease");
        lease.state = if reusable { ReservationState::Released } else { ReservationState::Quarantined };
        lease.settlement = None;
        let worktree = self.worktrees.get_mut(&worktree_id).expect("registered worktree retained for lease lifetime");
        worktree.status = if reusable { WorktreeStatus::Free } else { WorktreeStatus::Quarantined };
        worktree.reservation_state = Some(lease.state);
        worktree.registration.observed_revision = observed_revision;
        worktree.registration.clean = Some(clean);
        worktree.registration.has_untracked = Some(has_untracked);
        worktree.active_lease_id = None;
        self.revision = next;
        Ok(next)
    }

    /// Apply the second, independently durable transition for a managed
    /// logical child. Worker capacity must already be settled; this transition
    /// alone releases the worktree lease and makes it Free only when the exact
    /// final Inspect proved a clean, no-user-change revision.
    pub(crate) fn finalize_logical_managed_worktree_disposition(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        current_owner_epoch: Option<u64>,
        observed_revision: &str,
        reusable: bool,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        let record = self.leases.get(lease_id).ok_or(WorktreePoolError::ReservationNotFound)?;
        if let Some(epoch) = current_owner_epoch {
            if &record.lease.owner != owner || epoch != self.owner_epoch
                || epoch < owner.owner_epoch() || record.process_identity.is_some()
                || !matches!(record.state, ReservationState::Claimed | ReservationState::Quarantined)
            {
                return Err(WorktreePoolError::InvalidTransition);
            }
        } else {
            self.check_owner(owner)?;
            self.check_lease_owner(record, owner)?;
            if record.process_identity.is_some()
                || !matches!(record.state, ReservationState::Claimed | ReservationState::Quarantined)
            {
                return Err(WorktreePoolError::InvalidTransition);
            }
        }
        validate_revision(observed_revision)?;
        self.check_revision(expected_revision)?;
        let next = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        self.leases.get_mut(lease_id).expect("lease checked").state = ReservationState::Released;
        let worktree = self.worktrees.get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime");
        worktree.status = if reusable { WorktreeStatus::Free } else { WorktreeStatus::Quarantined };
        worktree.reservation_state = Some(ReservationState::Released);
        worktree.registration.observed_revision = Some(observed_revision.to_owned());
        worktree.registration.clean = Some(reusable);
        // A dirty final Inspect can include modified tracked files or
        // user-owned changes. The bounded Inspect summary does not identify
        // untracked entries separately, so quarantine must not fabricate
        // `has_untracked=true`; only a clean reusable observation proves
        // that it is false.
        worktree.registration.has_untracked = reusable.then_some(false);
        worktree.active_lease_id = None;
        self.revision = next;
        Ok(next)
    }

    /// Keep a settled worker's worktree unavailable while the second durable
    /// disposition event is pending. The lease remains attached so a crash in
    /// the gap cannot make the worktree selectable or infer a clean state.
    pub(crate) fn quarantine_managed_disposition_pending(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        current_owner_epoch: Option<u64>,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        let record = self.leases.get(lease_id).ok_or(WorktreePoolError::ReservationNotFound)?;
        if let Some(epoch) = current_owner_epoch {
            if &record.lease.owner != owner || epoch != self.owner_epoch
                || epoch < owner.owner_epoch() || record.process_identity.is_some()
            {
                return Err(WorktreePoolError::InvalidTransition);
            }
        } else {
            self.check_owner(owner)?;
            self.check_lease_owner(record, owner)?;
            if record.process_identity.is_some() {
                return Err(WorktreePoolError::InvalidTransition);
            }
        }
        self.check_revision(expected_revision)?;
        if record.state == ReservationState::Quarantined {
            let worktree_id = record.lease.worktree_id.as_str();
            let worktree = self.worktrees.get(worktree_id).ok_or(WorktreePoolError::ReservationNotFound)?;
            if worktree.status == WorktreeStatus::Quarantined
                && worktree.active_lease_id.as_deref() == Some(lease_id)
            {
                return Ok(self.revision);
            }
            return Err(WorktreePoolError::InvalidTransition);
        }
        if record.state != ReservationState::Claimed {
            return Err(WorktreePoolError::InvalidTransition);
        }
        let next = self.next_revision()?;
        let worktree_id = record.lease.worktree_id.clone();
        self.leases.get_mut(lease_id).expect("lease checked").state = ReservationState::Quarantined;
        let worktree = self.worktrees.get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime");
        worktree.status = WorktreeStatus::Quarantined;
        worktree.reservation_state = Some(ReservationState::Quarantined);
        self.revision = next;
        Ok(next)
    }

    /// Reconciliation-only release for a quarantined lease whose OS process
    /// generation was never bound (crash window between the durable claim and
    /// the process bind). The trusted reconciler must supply target-side
    /// evidence for all three §11.20 proofs; the worktree itself stays
    /// quarantined for the workspace owner because no clean final revision was
    /// observed. Never a live success path.
    #[allow(dead_code)]
    pub fn reconcile_and_release_reconciled(
        &mut self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        proof: ReservationProof,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        let record = self
            .leases
            .get(lease_id)
            .ok_or(WorktreePoolError::ReservationNotFound)?;
        self.check_lease_owner(record, owner)?;
        if !proof.owned_process_exited || !proof.effects_settled || !proof.reconciliation_complete {
            return Err(WorktreePoolError::MissingProof);
        }
        if record.state == ReservationState::Released {
            return Ok(self.revision);
        }
        self.check_revision(expected_revision)?;
        let worktree_id = record.lease.worktree_id.clone();
        if record.state == ReservationState::Quarantined {
            record
                .state
                .validate_transition(
                    ReservationState::ReleasePending,
                    ReservationProof {
                        reconciliation_complete: true,
                        ..ReservationProof::default()
                    },
                )
                .map_err(map_transition_error)?;
            self.leases.get_mut(lease_id).expect("lease checked").state =
                ReservationState::ReleasePending;
        } else if record.state != ReservationState::ReleasePending {
            return Err(WorktreePoolError::InvalidTransition);
        }
        let release_proof = ReservationProof {
            owned_process_exited: proof.owned_process_exited,
            effects_settled: proof.effects_settled,
            reconciliation_complete: proof.reconciliation_complete,
            ..ReservationProof::default()
        };
        self.leases
            .get(lease_id)
            .expect("lease checked")
            .state
            .validate_transition(ReservationState::Released, release_proof)
            .map_err(map_transition_error)?;
        let revision = self.next_revision()?;
        self.leases.get_mut(lease_id).expect("lease checked").state = ReservationState::Released;
        let worktree = self
            .worktrees
            .get_mut(&worktree_id)
            .expect("registered worktree retained for lease lifetime");
        worktree.status = WorktreeStatus::Quarantined;
        worktree.reservation_state = Some(ReservationState::Released);
        worktree.active_lease_id = None;
        self.revision = revision;
        Ok(revision)
    }

    pub fn snapshot(&self, worktree_id: &str) -> Option<WorktreeSnapshot> {
        self.worktrees
            .get(worktree_id)
            .map(|record| WorktreeSnapshot {
                id: record.registration.id.clone(),
                workspace_binding: record.registration.workspace_binding.clone(),
                path: record.registration.path.clone(),
                base_revision: record.registration.base_revision.clone(),
                observed_revision: record.registration.observed_revision.clone(),
                status: record.status,
                reservation_state: record.reservation_state,
                lease_id: record.active_lease_id.clone(),
            })
    }

    /// Durable OwnerLog projections call this only after a guarded Release
    /// receipt proves clean pre-delete state and a missing post-state. Keeping
    /// the row permanently tombstoned prevents both accidental reselection and
    /// worktree-ID reuse while preserving lease/history references.
    pub(crate) fn mark_removed(
        &mut self,
        worktree_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        self.check_owner(owner)?;
        self.mark_removed_scoped(worktree_id, owner.workspace_binding(), owner.owner_epoch(), expected_revision)
    }

    pub(crate) fn mark_removed_root_owned(
        &mut self,
        worktree_id: &str,
        owner: &WorktreeRootOwnerV1,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        if owner.owner_epoch() != self.owner_epoch {
            return Err(WorktreePoolError::StaleOwnerEpoch);
        }
        self.mark_removed_scoped(worktree_id, owner.workspace_binding(), owner.owner_epoch(), expected_revision)
    }

    fn mark_removed_scoped(
        &mut self,
        worktree_id: &str,
        workspace_binding: &str,
        owner_epoch: u64,
        expected_revision: u64,
    ) -> Result<u64, WorktreePoolError> {
        if owner_epoch != self.owner_epoch { return Err(WorktreePoolError::StaleOwnerEpoch); }
        let record = self.worktrees.get(worktree_id).ok_or(WorktreePoolError::NotAvailable)?;
        if record.registration.workspace_binding != workspace_binding {
            return Err(WorktreePoolError::ScopeMismatch);
        }
        if record.status == WorktreeStatus::Removed {
            return Ok(self.revision);
        }
        if record.status != WorktreeStatus::Free
            || record.active_lease_id.is_some()
            || !matches!(record.reservation_state, None | Some(ReservationState::Released) | Some(ReservationState::Expired))
        {
            return Err(WorktreePoolError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        let revision = self.next_revision()?;
        let record = self.worktrees.get_mut(worktree_id).expect("checked worktree");
        record.status = WorktreeStatus::Removed;
        record.registration.clean = Some(false);
        record.registration.has_untracked = None;
        self.revision = revision;
        Ok(revision)
    }

    /// Read-only snapshot of the worktree currently bound to one lease. This is
    /// a reference for diagnostic/launch plumbing, never an authorization.
    pub fn snapshot_of_lease(&self, lease_id: &str) -> Option<WorktreeSnapshot> {
        let record = self.leases.get(lease_id)?;
        self.snapshot(&record.lease.worktree_id)
    }

    /// Verifies the durable worktree lease lineage used by the managed worker
    /// proof. This checks the pool's replayed owner facts only; the HostKernel
    /// still has to re-open the canonical root and verify current filesystem
    /// revision/cleanliness through its guarded workspace collector.
    pub(crate) fn verify_live_managed_lease(
        &self,
        lease_id: &str,
        owner: &AuthenticatedOwnerContext,
        worker_execution_id: &str,
        source_revision: &str,
        expires_at_ms: u64,
        expected_state: ReservationState,
    ) -> bool {
        let Some(record) = self.leases.get(lease_id) else {
            return false;
        };
        let Some(worktree) = self.worktrees.get(&record.lease.worktree_id) else {
            return false;
        };
        let allowed_state = matches!(
            expected_state,
            ReservationState::Reserved | ReservationState::Claimed
        );
        let expected_lease_state = record.state == expected_state;
        let worker_binding_matches = match expected_state {
            ReservationState::Reserved => record.worker_execution_id.is_none(),
            ReservationState::Claimed => {
                record.worker_execution_id.as_deref() == Some(worker_execution_id)
            }
            _ => false,
        };
        allowed_state
            && expected_lease_state
            && record.lease.owner == *owner
            && worker_binding_matches
            && record.lease.expires_at_ms == expires_at_ms
            && record.lease.source_revision == source_revision
            && worktree.registration.workspace_binding == owner.workspace_binding()
            && worktree.registration.observed_revision.as_deref() == Some(source_revision)
            && worktree.status == WorktreeStatus::Leased
            && worktree.active_lease_id.as_deref() == Some(lease_id)
            && record.settlement.is_none()
    }

    fn check_owner(&self, owner: &AuthenticatedOwnerContext) -> Result<(), WorktreePoolError> {
        if owner.owner_epoch() == self.owner_epoch {
            Ok(())
        } else {
            Err(WorktreePoolError::StaleOwnerEpoch)
        }
    }

    fn check_lease_owner(
        &self,
        record: &LeaseRecord,
        owner: &AuthenticatedOwnerContext,
    ) -> Result<(), WorktreePoolError> {
        if &record.lease.owner == owner {
            Ok(())
        } else {
            Err(WorktreePoolError::ScopeMismatch)
        }
    }

    fn check_process_evidence(
        &self,
        record: &LeaseRecord,
        evidence: &SettlementEvidence,
    ) -> Result<(), WorktreePoolError> {
        let Some(expected) = record.process_identity.as_ref() else {
            return Err(WorktreePoolError::MissingProof);
        };
        match evidence.process_identity.as_ref() {
            Some(actual) if actual == expected => Ok(()),
            Some(_) => Err(WorktreePoolError::ProcessIdentityMismatch),
            None => Err(WorktreePoolError::MissingProof),
        }
    }

    fn check_revision(&self, expected_revision: u64) -> Result<(), WorktreePoolError> {
        if expected_revision == self.revision {
            Ok(())
        } else {
            Err(WorktreePoolError::StaleRevision)
        }
    }

    fn next_revision(&self) -> Result<u64, WorktreePoolError> {
        self.revision
            .checked_add(1)
            .ok_or(WorktreePoolError::InvalidConfiguration)
    }
}

fn validate_registration(
    registration: &WorktreeRegistration,
    workspace_binding: &str,
) -> Result<(), WorktreePoolError> {
    if registration.id.is_empty()
        || registration.id.len() > MAX_ID_LENGTH
        || registration.workspace_binding.is_empty()
        || registration.workspace_binding.len() > MAX_ID_LENGTH
        || registration.workspace_binding != workspace_binding
        || registration.base_revision.is_empty()
        || registration.base_revision.len() > MAX_REVISION_LENGTH
        || !registration.path.is_absolute()
        || registration
            .path
            .components()
            .any(|component| component == Component::ParentDir)
        || registration
            .observed_revision
            .as_ref()
            .is_some_and(|revision| revision.is_empty() || revision.len() > MAX_REVISION_LENGTH)
    {
        return Err(WorktreePoolError::InvalidRegistration);
    }
    Ok(())
}

fn registration_is_clean(registration: &WorktreeRegistration) -> bool {
    registration.observed_revision.as_ref().is_some_and(|revision| {
        validate_revision(revision).is_ok()
    }) && registration.clean == Some(true)
        && registration.has_untracked == Some(false)
}

fn validate_revision(revision: &str) -> Result<(), WorktreePoolError> {
    if revision.is_empty() || revision.len() > MAX_REVISION_LENGTH
        || revision.chars().any(char::is_control)
    {
        Err(WorktreePoolError::InvalidRequest)
    } else {
        Ok(())
    }
}

fn validate_acquire(
    request_id: &str,
    worktree_id: &str,
    base_revision: &str,
    expires_at_ms: u64,
) -> Result<(), WorktreePoolError> {
    if request_id.is_empty()
        || request_id.len() > MAX_ID_LENGTH
        || worktree_id.is_empty()
        || worktree_id.len() > MAX_ID_LENGTH
        || base_revision.is_empty()
        || base_revision.len() > MAX_REVISION_LENGTH
        || expires_at_ms == 0
    {
        return Err(WorktreePoolError::InvalidRequest);
    }
    Ok(())
}

fn validate_worker(
    worker_execution_id: &str,
    process_identity: &ProcessIdentity,
) -> Result<(), WorktreePoolError> {
    if worker_execution_id.is_empty()
        || worker_execution_id.len() > MAX_ID_LENGTH
        || process_identity.pid == 0
        || process_identity.start_identity == 0
    {
        return Err(WorktreePoolError::InvalidRequest);
    }
    Ok(())
}

fn map_transition_error(error: ReservationTransitionError) -> WorktreePoolError {
    match error {
        ReservationTransitionError::ForbiddenTransition => WorktreePoolError::InvalidTransition,
        ReservationTransitionError::MissingProof => WorktreePoolError::MissingProof,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(epoch: u64, attempt: &str) -> AuthenticatedOwnerContext {
        AuthenticatedOwnerContext::test_fixture(
            "principal-a",
            "workspace-a",
            "session-a",
            "run-a",
            "task-a",
            attempt,
            epoch,
        )
    }

    fn registration(id: &str) -> WorktreeRegistration {
        WorktreeRegistration {
            id: id.to_owned(),
            workspace_binding: "workspace-a".to_owned(),
            path: PathBuf::from(format!("/worktrees/{id}")),
            base_revision: "base-a".to_owned(),
            observed_revision: Some("base-a".to_owned()),
            clean: Some(true),
            has_untracked: Some(false),
        }
    }

    fn process() -> ProcessIdentity {
        ProcessIdentity::new(101, 4_001)
    }

    /// Full deterministic pool state used to prove a failed operation did not
    /// partially register, lease or settle anything.
    fn pool_dump(pool: &WorktreePool) -> String {
        let mut idempotency: Vec<_> = pool
            .idempotency
            .iter()
            .map(|((owner, key), lease_id)| {
                (owner.attempt_id().to_owned(), key.clone(), lease_id.clone())
            })
            .collect();
        idempotency.sort();
        format!(
            "revision={} next_lease={} worktrees={:?} leases={:?} idempotency={idempotency:?}",
            pool.revision, pool.next_lease_number, pool.worktrees, pool.leases
        )
    }

    #[test]
    fn revision_overflow_leaves_pool_state_untouched() {
        let auth = owner(7, "attempt-a");
        let mut pool = WorktreePool::new(7, 4, 3).expect("bounded pool");
        for id in ["wt-a", "wt-b", "wt-c"] {
            pool.register(registration(id), &auth, pool.revision())
                .expect("register clean worktree");
        }
        let claimed = pool
            .acquire(
                "request-a",
                "wt-a",
                "base-a",
                auth.clone(),
                pool.revision(),
                100,
            )
            .expect("lease wt-a");
        pool.claim(
            &claimed.lease_id,
            &auth,
            "worker-a",
            process(),
            pool.revision(),
        )
        .expect("claim lease-a");
        let reserved = pool
            .acquire(
                "request-b",
                "wt-b",
                "base-a",
                auth.clone(),
                pool.revision(),
                100,
            )
            .expect("lease wt-b");

        pool.revision = u64::MAX;
        let before = pool_dump(&pool);
        assert_eq!(
            pool.register(registration("wt-d"), &auth, u64::MAX),
            Err(WorktreePoolError::InvalidConfiguration)
        );
        assert_eq!(pool_dump(&pool), before);
        assert_eq!(
            pool.acquire("request-c", "wt-c", "base-a", auth.clone(), u64::MAX, 100),
            Err(WorktreePoolError::InvalidConfiguration)
        );
        assert_eq!(pool_dump(&pool), before);
        assert_eq!(
            pool.claim(&reserved.lease_id, &auth, "worker-b", process(), u64::MAX),
            Err(WorktreePoolError::InvalidConfiguration)
        );
        assert_eq!(pool_dump(&pool), before);
        assert_eq!(
            pool.begin_release(&claimed.lease_id, &auth, u64::MAX),
            Err(WorktreePoolError::InvalidConfiguration)
        );
        assert_eq!(pool_dump(&pool), before);
        assert_eq!(
            pool.quarantine(&claimed.lease_id, &auth, u64::MAX),
            Err(WorktreePoolError::InvalidConfiguration)
        );
        assert_eq!(pool_dump(&pool), before);
        assert_eq!(
            pool.expire_unlaunched(
                &reserved.lease_id,
                &auth,
                200,
                ReservationProof {
                    no_launch_or_dispatch: true,
                    ..ReservationProof::default()
                },
                u64::MAX,
            ),
            Err(WorktreePoolError::InvalidConfiguration)
        );
        assert_eq!(pool_dump(&pool), before);
        assert_eq!(
            pool.snapshot("wt-c").expect("registered").status,
            WorktreeStatus::Free
        );
    }

    #[test]
    fn quarantine_and_release_overflow_is_fail_closed() {
        let auth = owner(7, "attempt-a");
        let settled = |process_identity: Option<ProcessIdentity>| SettlementEvidence {
            process_identity,
            owned_process_exited: true,
            effects_settled: true,
            reconciliation_complete: true,
            observed_revision: Some("base-a".to_owned()),
            clean: Some(true),
            has_untracked: Some(false),
        };

        // reconcile_quarantined only advances after reconciliation proof.
        let mut pool = WorktreePool::new(7, 1, 1).expect("bounded pool");
        pool.register(registration("wt-a"), &auth, pool.revision())
            .expect("register");
        let lease = pool
            .acquire(
                "request-a",
                "wt-a",
                "base-a",
                auth.clone(),
                pool.revision(),
                100,
            )
            .expect("lease");
        pool.claim(
            &lease.lease_id,
            &auth,
            "worker-a",
            process(),
            pool.revision(),
        )
        .expect("claim");
        pool.quarantine(&lease.lease_id, &auth, pool.revision())
            .expect("quarantine uncertain worker");
        pool.revision = u64::MAX;
        let before = pool_dump(&pool);
        assert_eq!(
            pool.reconcile_quarantined(&lease.lease_id, &auth, &settled(Some(process())), u64::MAX),
            Err(WorktreePoolError::InvalidConfiguration)
        );
        assert_eq!(pool_dump(&pool), before);

        // release only advances from release-pending with full settlement.
        let mut pool = WorktreePool::new(7, 1, 1).expect("bounded pool");
        pool.register(registration("wt-a"), &auth, pool.revision())
            .expect("register");
        let lease = pool
            .acquire(
                "request-a",
                "wt-a",
                "base-a",
                auth.clone(),
                pool.revision(),
                100,
            )
            .expect("lease");
        pool.claim(
            &lease.lease_id,
            &auth,
            "worker-a",
            process(),
            pool.revision(),
        )
        .expect("claim");
        pool.begin_release(&lease.lease_id, &auth, pool.revision())
            .expect("release pending");
        pool.revision = u64::MAX;
        let before = pool_dump(&pool);
        assert_eq!(
            pool.release(&lease.lease_id, &auth, settled(Some(process())), u64::MAX),
            Err(WorktreePoolError::InvalidConfiguration)
        );
        assert_eq!(pool_dump(&pool), before);
        assert_eq!(
            pool.snapshot("wt-a").expect("registered").status,
            WorktreeStatus::Leased,
            "a failed release must not free the worktree"
        );
    }

    #[test]
    fn lease_number_overflow_is_fail_closed() {
        let auth = owner(7, "attempt-a");
        let mut pool = WorktreePool::new(7, 1, 1).expect("bounded pool");
        pool.register(registration("wt-a"), &auth, pool.revision())
            .expect("register");
        pool.next_lease_number = u64::MAX;
        let before = pool_dump(&pool);
        assert_eq!(
            pool.acquire("request-a", "wt-a", "base-a", auth, pool.revision(), 10_000),
            Err(WorktreePoolError::InvalidConfiguration)
        );
        assert_eq!(pool_dump(&pool), before);
        assert_eq!(
            pool.snapshot("wt-a").expect("registered").status,
            WorktreeStatus::Free
        );
    }
}

#[cfg(test)]
#[path = "../tests/support/worktree_pool_tests.rs"]
mod worktree_pool_tests;
