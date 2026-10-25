//! Cross-module worker-pool wire tests (§21.11 / §29.18 / §32.33 / §32.37).
//!
//! The sources are included directly so the tests can construct authenticated
//! owner fixtures exactly the way the kernel crate does and exercise the real
//! reservation, worktree and worker state machines together.

use crate::resource_budget;
use crate::resource_sampler;
use crate::worker_pool;
use crate::worktree_pool;

use std::path::PathBuf;

use resource_budget::{AuthenticatedOwnerContext, BudgetDimension, Capacity, ReservationProof};
use resource_sampler::ProcessIdentity;
use worker_pool::{
    CancelScope, EnqueueRequest, IsolatedWorkerLauncher, LaunchPermit, ReconciliationProof,
    TicketState, VerifiedAttemptBinding, WorkerClass, WorkerPool, WorkerPoolConfig,
    WorkerPoolError, WorkerReuseKey, WorkerSettlement, WorkerSettlementOutcome,
    WorkerSettlementResult, WorktreeBindingRequest, WorktreeSettlementFacts,
};
use worktree_pool::WorktreeRegistration;

const EPOCH: u64 = 7;
const GOAL: &str = "goal-a";
const ATTEMPT: &str = "attempt-a";
const TASK: &str = "task-a";
const RUN: &str = "run-a";
const SESSION: &str = "session-a";
const WORKSPACE: &str = "workspace-a";
const PRINCIPAL: &str = "principal-a";

fn digest(seed: char) -> String {
    format!("blake3:{}", seed.to_string().repeat(64))
}

fn owner(epoch: u64, attempt: &str) -> AuthenticatedOwnerContext {
    owner_with(PRINCIPAL, WORKSPACE, SESSION, RUN, TASK, attempt, epoch)
}

#[allow(clippy::too_many_arguments)]
fn owner_with(
    principal: &str,
    workspace: &str,
    session: &str,
    run: &str,
    task: &str,
    attempt: &str,
    epoch: u64,
) -> AuthenticatedOwnerContext {
    AuthenticatedOwnerContext::test_fixture(
        principal, workspace, session, run, task, attempt, epoch,
    )
}

fn pool(live: usize, queued: usize, worktrees: usize) -> WorkerPool {
    WorkerPool::new(WorkerPoolConfig {
        owner_epoch: EPOCH,
        max_live_workers: live,
        max_queued_tickets: queued,
        max_worktrees: worktrees,
    })
    .expect("valid bounded worker pool")
}

fn enable(pool: &mut WorkerPool) {
    pool.enable_managed_attempt_fan_out(EPOCH)
        .expect("test ingress opens the managed-attempt fan-out gate");
}

fn binding(attempt: &str, revision: &str, spec_seed: char) -> VerifiedAttemptBinding {
    binding_for_goal(GOAL, attempt, revision, spec_seed)
}

fn binding_for_goal(
    goal: &str,
    attempt: &str,
    revision: &str,
    spec_seed: char,
) -> VerifiedAttemptBinding {
    VerifiedAttemptBinding::test_fixture(
        goal,
        RUN,
        TASK,
        attempt,
        EPOCH,
        revision,
        &digest(spec_seed),
    )
}

fn set_memory_capacity(pool: &mut WorkerPool, cap: u64, measured: u64, reserve: u64) {
    pool.update_capacity(
        BudgetDimension::MemoryBytes,
        Some(cap),
        Some(measured),
        reserve,
        EPOCH,
        1,
        pool.revision(),
    )
    .expect("capacity update");
}

fn register_worktree(pool: &mut WorkerPool, owner: &AuthenticatedOwnerContext, id: &str) {
    pool.register_worktree(
        WorktreeRegistration {
            id: id.to_owned(),
            workspace_binding: WORKSPACE.to_owned(),
            path: PathBuf::from(format!("/worktrees/{id}")),
            base_revision: "rev-1".to_owned(),
            observed_revision: Some("rev-1".to_owned()),
            clean: Some(true),
            has_untracked: Some(false),
        },
        owner,
        pool.revision(),
    )
    .expect("register clean worktree");
}

fn effectful_request(ticket: &str, amount: u64, worktree: Option<&str>) -> EnqueueRequest {
    EnqueueRequest {
        ticket_id: ticket.to_owned(),
        goal_id: GOAL.to_owned(),
        idempotency_key: format!("key-{ticket}"),
        dimension: BudgetDimension::MemoryBytes,
        amount,
        expires_at_ms: 10_000,
        expected_task_revision: "rev-1".to_owned(),
        accepted_spec_digest: digest('a'),
        class: WorkerClass::IsolatedEffectful,
        worktree: worktree.map(|worktree_id| WorktreeBindingRequest {
            worktree_id: worktree_id.to_owned(),
            base_revision: "rev-1".to_owned(),
        }),
        parent_execution: None,
    }
}

#[derive(Default)]
struct RecordingLauncher {
    identity: Option<ProcessIdentity>,
    launches: usize,
}

impl IsolatedWorkerLauncher for RecordingLauncher {
    fn launch(&mut self, permit: &LaunchPermit) -> Result<ProcessIdentity, WorkerPoolError> {
        assert_eq!(permit.run_id, RUN);
        assert_eq!(permit.source_revision, "rev-1");
        assert!(permit.worktree_path.is_some());
        self.launches += 1;
        Ok(self
            .identity
            .clone()
            .unwrap_or_else(|| ProcessIdentity::new(4242, 9001)))
    }
}

fn settlement_settled(identity: &ProcessIdentity) -> WorkerSettlement {
    WorkerSettlement {
        outcome: WorkerSettlementOutcome::Settled,
        process_identity: Some(identity.clone()),
        owned_process_exited: true,
        effects_settled: true,
        reconciliation_complete: true,
        evidence_refs: vec!["receipt-a".to_owned()],
        external_effect_refs: Vec::new(),
        worktree: Some(WorktreeSettlementFacts {
            observed_revision: Some("rev-1".to_owned()),
            clean: Some(true),
            has_untracked: Some(false),
        }),
    }
}

/// Reserve one effectful worker end-to-end and return its process identity.
fn reserve_and_launch(
    pool: &mut WorkerPool,
    auth: &AuthenticatedOwnerContext,
    ticket: &str,
    worker_execution_id: &str,
) -> ProcessIdentity {
    let binding = binding(ATTEMPT, "rev-1", 'a');
    pool.reserve(
        ticket,
        &binding,
        worker_execution_id,
        auth,
        pool.revision(),
        1,
    )
    .expect("reserve against admitted binding");
    pool.claim(worker_execution_id, auth, pool.revision())
        .expect("claim before dispatch");
    let mut launcher = RecordingLauncher::default();
    pool.dispatch_isolated_worker(worker_execution_id, &mut launcher, auth, pool.revision())
        .expect("dispatch through the Guard-owned launch port")
}

#[test]
fn fan_out_is_closed_until_the_authenticated_binding_ingress_opens_it() {
    let mut pool = pool(2, 2, 1);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 1_000, 200, 100);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 300, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    let binding = binding(ATTEMPT, "rev-1", 'a');
    assert_eq!(
        pool.reserve("ticket-a", &binding, "worker-a", &auth, pool.revision(), 1),
        Err(WorkerPoolError::FanOutClosed)
    );
    // Nothing was reserved and no attempt slot was consumed.
    assert_eq!(pool.live_worker_count(), 0);
    assert_eq!(pool.ticket("ticket-a").unwrap().state, TicketState::Queued);
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(700)
    );
    enable(&mut pool);
    assert_eq!(
        pool.reserve("ticket-a", &binding, "worker-a", &auth, pool.revision(), 1)
            .expect("reserve")
            .worker_execution_id,
        "worker-a"
    );
}

#[test]
fn reserve_debits_measured_headroom_once_and_releases_only_after_settlement() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 1_000, 200, 100);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 300, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    let identity = reserve_and_launch(&mut pool, &auth, "ticket-a", "worker-a");
    // JC-RES-012.C/D: cap 1000 - reserve 100 - measured 200 - worker 300 = 400.
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(400)
    );
    assert_eq!(
        pool.settle_worker(
            "worker-a",
            settlement_settled(&identity),
            &auth,
            pool.revision()
        ),
        Ok(WorkerSettlementResult::Released)
    );
    assert_eq!(pool.live_worker_count(), 0);
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(700)
    );
    // A duplicate identical settlement is an idempotent no-op.
    assert_eq!(
        pool.settle_worker(
            "worker-a",
            settlement_settled(&identity),
            &auth,
            pool.revision()
        ),
        Ok(WorkerSettlementResult::Released)
    );
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(700)
    );
}

#[test]
fn unknown_settlement_quarantines_and_holds_capacity_until_reconciliation() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 1_000, 200, 100);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 300, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    let identity = reserve_and_launch(&mut pool, &auth, "ticket-a", "worker-a");
    let unknown = WorkerSettlement {
        outcome: WorkerSettlementOutcome::Unknown,
        process_identity: Some(identity.clone()),
        owned_process_exited: false,
        effects_settled: false,
        reconciliation_complete: false,
        evidence_refs: vec!["receipt-unknown".to_owned()],
        external_effect_refs: vec!["effect-a".to_owned()],
        worktree: None,
    };
    assert_eq!(
        pool.settle_worker("worker-a", unknown, &auth, pool.revision()),
        Ok(WorkerSettlementResult::Quarantined)
    );
    let worker = pool.worker("worker-a").expect("worker retained");
    assert!(worker.unknown_effect);
    // Capacity is retained while the effect stays uncertain.
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(400)
    );
    assert_eq!(
        pool.reconcile_and_release_worker(
            "worker-a",
            ReconciliationProof {
                owned_process_exited: false,
                effects_settled: true,
                reconciliation_complete: true,
            },
            pool.revision(),
            &auth
        ),
        Err(WorkerPoolError::MissingProof)
    );
    assert_eq!(
        pool.reconcile_and_release_worker(
            "worker-a",
            ReconciliationProof {
                owned_process_exited: true,
                effects_settled: true,
                reconciliation_complete: true,
            },
            pool.revision(),
            &auth
        ),
        Ok(WorkerSettlementResult::Released)
    );
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(700)
    );
}

#[test]
fn capacity_blocks_new_admission_visibly_and_keeps_the_ticket_queued() {
    let mut pool = pool(4, 4, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 400, 200, 100);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 300, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    // Remaining is 100 < 300: ResourceBlocked, ticket still queued.
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-a",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::InsufficientCapacity)
    );
    assert_eq!(pool.ticket("ticket-a").unwrap().state, TicketState::Queued);
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(100)
    );
    // Unknown capacity never means infinite free resources.
    pool.update_capacity(
        BudgetDimension::MemoryBytes,
        None,
        Some(200),
        100,
        EPOCH,
        2,
        pool.revision(),
    )
    .expect("unknown capacity update");
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-a",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::CapacityUnknown)
    );
    // A working capacity restores admission.
    pool.update_capacity(
        BudgetDimension::MemoryBytes,
        Some(1_000),
        Some(200),
        100,
        EPOCH,
        3,
        pool.revision(),
    )
    .expect("capacity restores");
    pool.reserve(
        "ticket-a",
        &binding(ATTEMPT, "rev-1", 'a'),
        "worker-a",
        &auth,
        pool.revision(),
        1,
    )
    .expect("admitted once capacity is known");
}

#[test]
fn ticket_epoch_binding_and_identity_impersonation_all_fail_closed() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 1_000, 200, 100);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 300, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");

    // A guessed ticket grants nothing.
    assert_eq!(
        pool.reserve(
            "ticket-guessed",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-a",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::TicketNotFound)
    );
    // Another principal/id/epoch cannot use the ticket.
    let foreign = owner_with("principal-b", WORKSPACE, SESSION, RUN, TASK, ATTEMPT, EPOCH);
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-a",
            &foreign,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::ScopeMismatch)
    );
    let foreign_workspace =
        owner_with(PRINCIPAL, "workspace-b", SESSION, RUN, TASK, ATTEMPT, EPOCH);
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-a",
            &foreign_workspace,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::ScopeMismatch)
    );
    let stale_epoch = owner(EPOCH + 1, ATTEMPT);
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-a",
            &stale_epoch,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::StaleOwnerEpoch)
    );
    // A valid owner with a forged attempt binding (different attempt) fails.
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &binding("attempt-foreign", "rev-1", 'a'),
            "worker-a",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::AttemptBindingMismatch)
    );
    // A binding for a different revision fails.
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &binding(ATTEMPT, "rev-2", 'a'),
            "worker-a",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::AttemptRevisionMismatch)
    );
    // A binding for a different SpecVersion is not this ticket's work.
    let other_spec = VerifiedAttemptBinding::test_fixture(
        "goal-a",
        RUN,
        TASK,
        ATTEMPT,
        EPOCH,
        "rev-1",
        &digest('b'),
    );
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &other_spec,
            "worker-a",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::AttemptBindingMismatch)
    );
    // The correctly frozen binding is admitted.
    pool.reserve(
        "ticket-a",
        &binding(ATTEMPT, "rev-1", 'a'),
        "worker-a",
        &auth,
        pool.revision(),
        1,
    )
    .expect("admitted binding for this revision admits the ticket");
    // No reservation or attempt slot was consumed by any denial.
    assert_eq!(pool.live_worker_count(), 1);
    assert_eq!(
        pool.worker("worker-a").unwrap().state,
        resource_budget::ReservationState::Reserved
    );
}

#[test]
fn one_attempt_admits_exactly_one_competing_worker() {
    let mut pool = pool(4, 4, 2);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 10_000, 0, 0);
    register_worktree(&mut pool, &auth, "wt-a");
    register_worktree(&mut pool, &auth, "wt-b");
    pool.enqueue(
        effectful_request("ticket-a", 100, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    pool.enqueue(
        effectful_request("ticket-b", 100, Some("wt-b")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    let binding = binding(ATTEMPT, "rev-1", 'a');
    pool.reserve("ticket-a", &binding, "worker-a", &auth, pool.revision(), 1)
        .expect("first worker wins");
    // A competing worker for the same attempt loses before touching capacity.
    assert_eq!(
        pool.reserve("ticket-b", &binding, "worker-b", &auth, pool.revision(), 1),
        Err(WorkerPoolError::AttemptConflict)
    );
    assert_eq!(pool.live_worker_count(), 1);
    // Its ticket stays queued for the next attempt.
    assert_eq!(pool.ticket("ticket-b").unwrap().state, TicketState::Queued);
}

#[test]
fn bounded_admission_caps_live_workers_queue_and_records() {
    let mut pool = pool(1, 1, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 10_000, 0, 0);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 100, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    // Queue cap: the second queued ticket is visibly rejected.
    assert_eq!(
        pool.enqueue(
            effectful_request("ticket-b", 100, Some("wt-a")),
            &auth,
            pool.revision()
        ),
        Err(WorkerPoolError::QueueLimitReached)
    );
    pool.reserve(
        "ticket-a",
        &binding(ATTEMPT, "rev-1", 'a'),
        "worker-a",
        &auth,
        pool.revision(),
        1,
    )
    .expect("first worker admitted");
    // Live cap: a second live worker (distinct attempt) is rejected.
    let second = owner_with(PRINCIPAL, WORKSPACE, SESSION, RUN, TASK, "attempt-b", EPOCH);
    pool.enqueue(
        effectful_request("ticket-b", 100, Some("wt-a")),
        &second,
        pool.revision(),
    )
    .expect("queue slot freed when the first ticket was consumed");
    assert_eq!(
        pool.reserve(
            "ticket-b",
            &VerifiedAttemptBinding::test_fixture(
                "goal-a",
                RUN,
                TASK,
                "attempt-b",
                EPOCH,
                "rev-1",
                &digest('a'),
            ),
            "worker-b",
            &second,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::LiveWorkerLimitReached)
    );
    assert_eq!(pool.live_worker_count(), 1);
}

#[test]
fn effectful_worker_requires_a_free_matching_worktree_lease() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 10_000, 0, 0);
    // No worktree at all: rejected at enqueue time.
    assert_eq!(
        pool.enqueue(
            effectful_request("ticket-a", 100, None),
            &auth,
            pool.revision()
        ),
        Err(WorkerPoolError::WorktreeRequired)
    );
    register_worktree(&mut pool, &auth, "wt-a");
    let second = owner_with(PRINCIPAL, WORKSPACE, SESSION, RUN, TASK, "attempt-b", EPOCH);
    pool.enqueue(
        effectful_request("ticket-a", 100, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue with a worktree");
    pool.enqueue(
        effectful_request("ticket-b", 100, Some("wt-a")),
        &second,
        pool.revision(),
    )
    .expect("second ticket for the same worktree");
    pool.reserve(
        "ticket-a",
        &binding(ATTEMPT, "rev-1", 'a'),
        "worker-a",
        &auth,
        pool.revision(),
        1,
    )
    .expect("first lease wins");
    // The worktree is now leased: a second worker cannot take it.
    assert_eq!(
        pool.reserve(
            "ticket-b",
            &VerifiedAttemptBinding::test_fixture(
                "goal-a",
                RUN,
                TASK,
                "attempt-b",
                EPOCH,
                "rev-1",
                &digest('a'),
            ),
            "worker-b",
            &second,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::WorktreeUnavailable)
    );
    // Read-only class never needs a worktree and never takes a lease.
    pool.update_capacity(
        BudgetDimension::Processes,
        Some(4),
        Some(1),
        0,
        EPOCH,
        1,
        pool.revision(),
    )
    .expect("process capacity");
    let read_only = EnqueueRequest {
        ticket_id: "ticket-ro".to_owned(),
        goal_id: GOAL.to_owned(),
        idempotency_key: "key-ticket-ro".to_owned(),
        dimension: BudgetDimension::Processes,
        amount: 1,
        expires_at_ms: 10_000,
        expected_task_revision: "rev-1".to_owned(),
        accepted_spec_digest: digest('a'),
        class: WorkerClass::ReadOnlyAttachment,
        worktree: None,
        parent_execution: None,
    };
    pool.enqueue(read_only.clone(), &second, pool.revision())
        .expect("read-only enqueue");
    pool.reserve(
        "ticket-ro",
        &VerifiedAttemptBinding::test_fixture(
            "goal-a",
            RUN,
            TASK,
            "attempt-b",
            EPOCH,
            "rev-1",
            &digest('a'),
        ),
        "worker-ro",
        &second,
        pool.revision(),
        1,
    )
    .expect("read-only reserve");
    pool.claim("worker-ro", &second, pool.revision())
        .expect("read-only claim");
    let reuse = WorkerReuseKey {
        principal_ref: PRINCIPAL.to_owned(),
        workspace_binding: WORKSPACE.to_owned(),
        trust_profile: "default".to_owned(),
        sandbox_profile: "none".to_owned(),
        provider_selection_digest: digest('c'),
        harness_digest: digest('d'),
        environment_digest: digest('e'),
        policy_epoch: 3,
    };
    pool.attach_existing_core_client(
        "worker-ro",
        "session-link-a",
        reuse.clone(),
        &second,
        pool.revision(),
    )
    .expect("compatible read-only attach");
    // An incompatible reuse key (changed sandbox) must not silently reuse.
    let mut changed = reuse.clone();
    changed.sandbox_profile = "strict".to_owned();
    assert_eq!(
        pool.attach_existing_core_client(
            "worker-ro",
            "session-link-a",
            changed,
            &second,
            pool.revision()
        ),
        Err(WorkerPoolError::ReuseIncompatible)
    );
    // An effectful worker cannot attach to the shared Core client.
    assert_eq!(
        pool.attach_existing_core_client(
            "worker-a",
            "session-link-a",
            reuse,
            &auth,
            pool.revision()
        ),
        Err(WorkerPoolError::WrongWorkerClass)
    );
}

#[test]
fn cancellation_fences_tickets_without_freeing_launched_capacity() {
    let mut pool = pool(3, 3, 2);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 10_000, 0, 0);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 100, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    let identity = reserve_and_launch(&mut pool, &auth, "ticket-a", "worker-a");
    pool.enqueue(
        effectful_request("ticket-b", 100, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("second queued ticket");
    let fence = pool
        .cancel_scope(
            &CancelScope::Run {
                run_id: RUN.to_owned(),
            },
            &auth,
            pool.revision(),
        )
        .expect("run-scoped cancel fence");
    assert_eq!(fence.fenced_tickets, 1);
    assert_eq!(fence.fenced_workers, 1);
    // Fenced ticket can never reserve.
    assert_eq!(
        pool.reserve(
            "ticket-b",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-b",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::TicketFenced)
    );
    // The launched worker keeps its conservative capacity until settlement.
    assert!(pool.worker("worker-a").unwrap().cancellation_requested);
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(9_900)
    );
    assert_eq!(
        pool.settle_worker(
            "worker-a",
            settlement_settled(&identity),
            &auth,
            pool.revision()
        ),
        Ok(WorkerSettlementResult::Released)
    );
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(10_000)
    );
    // A foreign scope cannot fence this Run's work: the fence is empty.
    let foreign = owner_with("principal-b", WORKSPACE, SESSION, RUN, TASK, ATTEMPT, EPOCH);
    let foreign_fence = pool
        .cancel_scope(
            &CancelScope::Run {
                run_id: RUN.to_owned(),
            },
            &foreign,
            pool.revision(),
        )
        .expect("fence evaluation never mutates foreign scopes");
    assert_eq!(foreign_fence.fenced_tickets, 0);
    assert_eq!(foreign_fence.fenced_workers, 0);
    assert_eq!(pool.live_worker_count(), 0);
}

#[test]
fn expiry_of_a_proven_unlaunched_reservation_is_idempotent_and_time_gated() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 1_000, 200, 100);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 300, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    pool.reserve(
        "ticket-a",
        &binding(ATTEMPT, "rev-1", 'a'),
        "worker-a",
        &auth,
        pool.revision(),
        1,
    )
    .expect("reserve");
    let proof = ReservationProof {
        no_launch_or_dispatch: true,
        ..ReservationProof::default()
    };
    assert_eq!(
        pool.expire_unlaunched_worker("worker-a", 9_999, proof, &auth, pool.revision()),
        Err(WorkerPoolError::NotExpired)
    );
    pool.expire_unlaunched_worker("worker-a", 10_000, proof, &auth, pool.revision())
        .expect("proven unlaunched expiry at the deadline");
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(700)
    );
    // Duplicate expiry delivery is an idempotent no-op.
    pool.expire_unlaunched_worker("worker-a", 10_001, proof, &auth, pool.revision())
        .expect("idempotent duplicate expiry");
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(700)
    );
}

#[test]
fn launched_workers_cannot_expire_free_and_settlement_requires_matching_process() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 10_000, 0, 0);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 100, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    let identity = reserve_and_launch(&mut pool, &auth, "ticket-a", "worker-a");
    assert_eq!(
        pool.expire_unlaunched_worker(
            "worker-a",
            20_000,
            ReservationProof {
                no_launch_or_dispatch: true,
                ..ReservationProof::default()
            },
            &auth,
            pool.revision()
        ),
        Err(WorkerPoolError::InvalidTransition)
    );
    // A settlement that claims a different OS process generation is rejected.
    let mut forged = settlement_settled(&identity);
    forged.process_identity = Some(ProcessIdentity::new(4242, 9999));
    assert_eq!(
        pool.settle_worker("worker-a", forged, &auth, pool.revision()),
        Err(WorkerPoolError::ProcessIdentityMismatch)
    );
    let mut missing_exit = settlement_settled(&identity);
    missing_exit.owned_process_exited = false;
    assert_eq!(
        pool.settle_worker("worker-a", missing_exit, &auth, pool.revision()),
        Err(WorkerPoolError::MissingProof)
    );
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(9_900)
    );
}

#[test]
fn crash_recovery_quarantines_claimed_workers_and_fences_queued_tickets() {
    let mut pool = pool(3, 3, 2);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 10_000, 0, 0);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 100, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    let identity = reserve_and_launch(&mut pool, &auth, "ticket-a", "worker-a");
    pool.enqueue(
        effectful_request("ticket-b", 100, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("queued ticket");
    let report = pool.recover_after_restart(50).expect("recovery");
    assert_eq!(report.quarantined_workers, 1);
    assert_eq!(report.fenced_tickets, 1);
    let worker = pool.worker("worker-a").expect("worker retained");
    assert_eq!(worker.state, resource_budget::ReservationState::Quarantined);
    assert!(worker.unknown_effect);
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(9_900)
    );
    // Repeated recovery is idempotent.
    let second = pool.recover_after_restart(50).expect("second recovery");
    assert_eq!(second.quarantined_workers, 0);
    assert_eq!(second.fenced_tickets, 0);
    // The process generation is still known for reconciliation.
    assert_eq!(worker.process_identity, Some(identity));
}

#[test]
fn epoch_advance_fences_old_work_and_allows_reconciliation_under_the_new_epoch() {
    let mut pool = pool(3, 3, 2);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 10_000, 0, 0);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 100, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    reserve_and_launch(&mut pool, &auth, "ticket-a", "worker-a");
    pool.advance_owner_epoch(EPOCH, EPOCH + 1, 50)
        .expect("epoch advance fences old work");
    // Old-epoch callers are fenced out entirely.
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-b",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::StaleOwnerEpoch)
    );
    // The current epoch, same trusted scope, reconciles the quarantined worker.
    let current = owner(EPOCH + 1, ATTEMPT);
    assert_eq!(
        pool.reconcile_and_release_worker(
            "worker-a",
            ReconciliationProof {
                owned_process_exited: true,
                effects_settled: true,
                reconciliation_complete: true,
            },
            pool.revision(),
            &current
        ),
        Ok(WorkerSettlementResult::Released)
    );
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(10_000)
    );
    // A different principal at the current epoch still cannot touch it.
    let foreign = owner_with(
        "principal-b",
        WORKSPACE,
        SESSION,
        RUN,
        TASK,
        ATTEMPT,
        EPOCH + 1,
    );
    assert_eq!(
        pool.reconcile_and_release_worker(
            "worker-a",
            ReconciliationProof {
                owned_process_exited: true,
                effects_settled: true,
                reconciliation_complete: true,
            },
            pool.revision(),
            &foreign
        ),
        Err(WorkerPoolError::ScopeMismatch)
    );
}

#[test]
fn enqueue_idempotency_returns_the_same_ticket_and_conflicts_on_reuse() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 1_000, 0, 0);
    register_worktree(&mut pool, &auth, "wt-a");
    let request = effectful_request("ticket-a", 300, Some("wt-a"));
    let first = pool
        .enqueue(request.clone(), &auth, pool.revision())
        .expect("enqueue");
    let replay = pool
        .enqueue(request.clone(), &auth, pool.revision())
        .expect("identical retry replays");
    assert_eq!(first.ticket_id, replay.ticket_id);
    let mut changed = request.clone();
    changed.amount = 999;
    assert_eq!(
        pool.enqueue(changed, &auth, pool.revision()),
        Err(WorkerPoolError::IdempotencyConflict)
    );
    // A different attempt scope cannot reuse another attempt's key.
    let other = owner_with(PRINCIPAL, WORKSPACE, SESSION, RUN, TASK, "attempt-b", EPOCH);
    let mut second_request = request.clone();
    second_request.ticket_id = "ticket-c".to_owned();
    second_request.idempotency_key = "key-ticket-a".to_owned();
    pool.enqueue(second_request, &other, pool.revision())
        .expect("key is scoped per authenticated attempt");
}

/// The same Run/Task/Attempt identifiers may exist under two different managed
/// Goals. A valid binding for another Goal must never admit this ticket, and
/// the denial must leave no ticket consumption, capacity debit, worktree claim
/// or worker record behind.
#[test]
fn another_goals_binding_with_identical_ids_never_admits_this_ticket() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 1_000, 200, 100);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 300, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue under goal-a");

    let baseline = pool.capacity(BudgetDimension::MemoryBytes);
    let other_goal = binding_for_goal("goal-b", ATTEMPT, "rev-1", 'a');
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &other_goal,
            "worker-a",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::GoalBindingMismatch),
        "a valid binding for another Goal must never admit this ticket"
    );
    // No ticket consumption, no capacity debit, no worktree claim, no record.
    assert_eq!(pool.ticket("ticket-a").unwrap().state, TicketState::Queued);
    assert_eq!(pool.live_worker_count(), 0);
    assert!(pool.worker("worker-a").is_none());
    assert_eq!(pool.capacity(BudgetDimension::MemoryBytes), baseline);

    // The deterministic OwnerLog replay path enforces the same Goal binding.
    assert_eq!(
        pool.reserve_replayed("ticket-a", &other_goal, "worker-a", &auth),
        Err(WorkerPoolError::GoalBindingMismatch)
    );
    assert_eq!(pool.ticket("ticket-a").unwrap().state, TicketState::Queued);
    assert_eq!(pool.live_worker_count(), 0);
    assert_eq!(pool.capacity(BudgetDimension::MemoryBytes), baseline);

    // The goal-bound binding still admits its own ticket and takes the worktree
    // lease, proving the denial was specifically the Goal binding.
    let lease = pool
        .reserve(
            "ticket-a",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-a",
            &auth,
            pool.revision(),
            1,
        )
        .expect("goal-a binding admits its own ticket");
    assert!(lease.worktree_lease_id.is_some());
    assert_eq!(pool.worker("worker-a").unwrap().goal_id, GOAL);
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(400)
    );
}

/// A consumed ticket replayed with another Goal's binding is denied too; the
/// existing worker and capacity stay exactly as they were.
#[test]
fn consumed_ticket_replay_is_goal_fenced() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 1_000, 200, 100);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 300, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    pool.reserve(
        "ticket-a",
        &binding(ATTEMPT, "rev-1", 'a'),
        "worker-a",
        &auth,
        pool.revision(),
        1,
    )
    .expect("goal-a admission");
    let after_admission = pool.capacity(BudgetDimension::MemoryBytes);

    let other_goal = binding_for_goal("goal-b", ATTEMPT, "rev-1", 'a');
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &other_goal,
            "worker-a",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::GoalBindingMismatch)
    );
    assert_eq!(
        pool.reserve_replayed("ticket-a", &other_goal, "worker-a", &auth),
        Err(WorkerPoolError::GoalBindingMismatch)
    );
    assert_eq!(pool.live_worker_count(), 1);
    assert_eq!(pool.capacity(BudgetDimension::MemoryBytes), after_admission);
    // The genuine same-goal replay remains idempotent.
    pool.reserve(
        "ticket-a",
        &binding(ATTEMPT, "rev-1", 'a'),
        "worker-a",
        &auth,
        pool.revision(),
        1,
    )
    .expect("same-goal retry replays the lease");
    assert_eq!(pool.live_worker_count(), 1);
}

/// A cross-Goal caller must not be able to mutate another Goal's ticket, not
/// even the conservative time-based expiry: Goal identity is refused before any
/// live reserve state mutation, and the rightful Goal then processes the normal
/// expiry transition.
#[test]
fn goal_binding_mismatch_precedes_any_ticket_mutation_even_past_expiry() {
    let mut pool = pool(2, 2, 1);
    enable(&mut pool);
    let auth = owner(EPOCH, ATTEMPT);
    set_memory_capacity(&mut pool, 1_000, 200, 100);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_request("ticket-a", 300, Some("wt-a")),
        &auth,
        pool.revision(),
    )
    .expect("enqueue under goal-a");
    // `effectful_request` freezes expires_at_ms = 10_000, so reserving at
    // 20_000 observes an already-past deadline.
    let revision = pool.revision();
    let baseline = pool.capacity(BudgetDimension::MemoryBytes);
    assert_eq!(pool.ticket("ticket-a").unwrap().state, TicketState::Queued);

    let other_goal = binding_for_goal("goal-b", ATTEMPT, "rev-1", 'a');
    assert_eq!(
        pool.reserve("ticket-a", &other_goal, "worker-a", &auth, revision, 20_000),
        Err(WorkerPoolError::GoalBindingMismatch),
        "a cross-Goal binding must refuse before the expiry transition"
    );
    // Nothing changed: no ticket consumption/expiry, no reservation, no worker,
    // no worktree claim and no capacity debit.
    assert_eq!(pool.ticket("ticket-a").unwrap().state, TicketState::Queued);
    assert_eq!(
        pool.revision(),
        revision,
        "a cross-Goal reserve changes nothing"
    );
    assert_eq!(pool.live_worker_count(), 0);
    assert!(pool.worker("worker-a").is_none());
    assert_eq!(pool.capacity(BudgetDimension::MemoryBytes), baseline);

    // The rightful Goal processes the normal expiry transition.
    assert_eq!(
        pool.reserve(
            "ticket-a",
            &binding(ATTEMPT, "rev-1", 'a'),
            "worker-a",
            &auth,
            pool.revision(),
            20_000
        ),
        Err(WorkerPoolError::TicketExpired)
    );
    assert_eq!(pool.ticket("ticket-a").unwrap().state, TicketState::Expired);
    assert_eq!(pool.capacity(BudgetDimension::MemoryBytes), baseline);
    assert!(pool.worker("worker-a").is_none());

    // Neither the denied nor the expired path took the worktree lease: a fresh
    // attempt can still acquire the same worktree, which would otherwise be
    // unavailable.
    let fresh = owner_with(PRINCIPAL, WORKSPACE, SESSION, RUN, TASK, "attempt-b", EPOCH);
    pool.enqueue(
        effectful_request("ticket-b", 300, Some("wt-a")),
        &fresh,
        pool.revision(),
    )
    .expect("fresh ticket after expiry");
    let lease = pool
        .reserve(
            "ticket-b",
            &binding_for_goal(GOAL, "attempt-b", "rev-1", 'a'),
            "worker-b",
            &fresh,
            pool.revision(),
            1,
        )
        .expect("the worktree was never claimed by the denied or expired path");
    assert!(lease.worktree_lease_id.is_some());
}
