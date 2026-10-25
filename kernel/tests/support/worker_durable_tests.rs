//! OwnerLog-backed durable worker-pool adapter tests (clone-apply-commit,
//! crash recovery, epoch fence, idempotent delivery).
//!
//! Migrated from a standalone `tests/worker_durable.rs` integration target
//! into the owning `src/worker_durable.rs` lib test build — the same pattern
//! as `worker_pool_tests.rs`, `worktree_pool_tests.rs` and
//! `jc_res_012_wire_tests.rs`. The old target recompiled library sources with
//! `#[path]`, so `crate::…` paths inside them resolved against the test crate
//! root instead of the library crate; as a `#[cfg(test)]` module of
//! `worker_durable` these tests construct the exact crate-private
//! authenticated fixtures the kernel ingress uses, with no visibility changes.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::protocol;
use crate::resource_budget::{
    self, AuthenticatedOwnerContext, BudgetDimension, Capacity, ReservationState,
};
use crate::resource_sampler::ProcessIdentity;
use crate::worker_durable::{WorkerCommand, WorkerDurableError, WorkerPoolControl, WorkerPoolOpenConfig};
use crate::worker_pool::{
    CancelScope, EnqueueRequest, FanOutState, OwnerScopeKey, ReconciliationProof, TicketState,
    VerifiedAttemptBinding, WorkerClass, WorkerPoolError, WorkerSettlement,
    WorkerSettlementOutcome, WorktreeBindingRequest, WorktreeSettlementFacts,
};
use crate::worktree_lifecycle;
use crate::worktree_pool::WorktreeRegistration;

const EPOCH: u64 = 7;
const ATTEMPT: &str = "attempt-a";
const WORKER: &str = "worker-a";
const TICKET: &str = "ticket-a";
const FAR_FUTURE_MS: u64 = 4_000_000_000_000;
const PAST_EXPIRY_MS: u64 = 1;

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn temp_root() -> PathBuf {
    let unique = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "hz-worker-durable-{}-{stamp}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).expect("create temp root");
    #[cfg(unix)]
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
        .expect("owner-private state root");
    root
}

fn digest(seed: char) -> String {
    format!("blake3:{}", seed.to_string().repeat(64))
}

fn owner(epoch: u64) -> AuthenticatedOwnerContext {
    AuthenticatedOwnerContext::test_fixture(
        "principal-a",
        "workspace-a",
        "session-a",
        "run-a",
        "task-a",
        ATTEMPT,
        epoch,
    )
}

fn scope(epoch: u64) -> OwnerScopeKey {
    OwnerScopeKey::from_owner(&owner(epoch))
}

fn binding(epoch: u64) -> VerifiedAttemptBinding {
    VerifiedAttemptBinding::test_fixture(
        "goal-a",
        "run-a",
        "task-a",
        ATTEMPT,
        epoch,
        "rev-1",
        &digest('a'),
    )
}

fn config(epoch: u64) -> WorkerPoolOpenConfig {
    WorkerPoolOpenConfig {
        owner_epoch: epoch,
        max_live_workers: 4,
        max_queued_tickets: 8,
        max_worktrees: 2,
    }
}

fn enqueue_command(epoch: u64, expires_at_ms: u64) -> WorkerCommand {
    WorkerCommand::Enqueue {
        scope: scope(epoch),
        request: EnqueueRequest {
            ticket_id: TICKET.to_owned(),
            goal_id: "goal-a".to_owned(),
            idempotency_key: "key-a".to_owned(),
            dimension: BudgetDimension::MemoryBytes,
            amount: 300,
            expires_at_ms,
            expected_task_revision: "rev-1".to_owned(),
            accepted_spec_digest: digest('a'),
            class: WorkerClass::IsolatedEffectful,
            worktree: Some(WorktreeBindingRequest {
                worktree_id: "wt-a".to_owned(),
                base_revision: "rev-1".to_owned(),
            }),
            parent_execution: None,
        },
    }
}

fn worktree_command(epoch: u64) -> WorkerCommand {
    // The scope-based registration this harness was written against now decodes
    // as `LegacyRegisterWorktree`: the command was split into a verified-root
    // form carrying guarded Create/Inspect provenance plus this historical
    // caller-scoped form. These tests exercise the durable OwnerLog adapter
    // (replay, epoch fencing, crash recovery), not worktree verification
    // provenance, which has dedicated coverage in the in-src schema tests and
    // `worktree_pool_tests.rs`; the pool-level registration semantics (a clean
    // worktree becomes Free and can be leased by Reserve) are identical.
    WorkerCommand::LegacyRegisterWorktree {
        scope: scope(epoch),
        registration: WorktreeRegistration {
            id: "wt-a".to_owned(),
            workspace_binding: "workspace-a".to_owned(),
            path: PathBuf::from("/worktrees/wt-a"),
            base_revision: "rev-1".to_owned(),
            observed_revision: Some("rev-1".to_owned()),
            clean: Some(true),
            has_untracked: Some(false),
        },
    }
}

fn reserve_command(epoch: u64, ticket_id: &str) -> WorkerCommand {
    WorkerCommand::Reserve {
        scope: scope(epoch),
        ticket_id: ticket_id.to_owned(),
        worker_execution_id: WORKER.to_owned(),
        binding: binding(epoch),
        now_ms: 1,
    }
}

fn claim_command(epoch: u64) -> WorkerCommand {
    WorkerCommand::ClaimWorker {
        scope: scope(epoch),
        worker_execution_id: WORKER.to_owned(),
    }
}

fn bind_command(epoch: u64, pid: u32) -> WorkerCommand {
    WorkerCommand::BindProcess {
        scope: scope(epoch),
        worker_execution_id: WORKER.to_owned(),
        process_identity: ProcessIdentity::new(pid, 9001),
    }
}

fn settle_command(epoch: u64, pid: u32) -> WorkerCommand {
    WorkerCommand::SettleWorker {
        scope: scope(epoch),
        worker_execution_id: WORKER.to_owned(),
        settlement: WorkerSettlement {
            outcome: WorkerSettlementOutcome::Settled,
            process_identity: Some(ProcessIdentity::new(pid, 9001)),
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
        },
    }
}

/// Re-supplies the derived capacity sample the way the sampler/ingress does
/// after a restart; capacity telemetry is never durable, so admission fails
/// closed until a fresh trusted sample arrives.
fn resupply_capacity(control: &mut WorkerPoolControl, epoch: u64) {
    let revision = control.pool().expect("pool").revision();
    control
        .update_capacity(
            BudgetDimension::MemoryBytes,
            Some(1_000),
            Some(200),
            100,
            epoch,
            1,
            revision,
        )
        .expect("fresh trusted capacity sample");
}

fn pool_capacity(control: &WorkerPoolControl) -> Capacity {
    control
        .pool()
        .expect("pool")
        .capacity(BudgetDimension::MemoryBytes)
}

/// Seeds capacity, a clean worktree and one durable ticket.
fn seed(control: &mut WorkerPoolControl, epoch: u64, expires_at_ms: u64) {
    let revision = control.pool().expect("pool").revision();
    control
        .update_capacity(
            BudgetDimension::MemoryBytes,
            Some(1_000),
            Some(200),
            100,
            epoch,
            1,
            revision,
        )
        .expect("capacity");
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "wt.register", worktree_command(epoch))
        .expect("register worktree");
    let revision = control.pool().expect("pool").revision();
    control
        .apply(
            revision,
            "ticket.enqueue",
            enqueue_command(epoch, expires_at_ms),
        )
        .expect("enqueue");
}

fn open_and_enable(root: &std::path::Path, epoch: u64) -> WorkerPoolControl {
    let mut control = WorkerPoolControl::open(root, "pool-a", config(epoch)).expect("open");
    control
        .enable_managed_attempt_fan_out()
        .expect("test ingress opens fan-out");
    control
}

#[test]
fn open_creates_the_durable_pool_and_replays_it_after_restart() {
    let root = temp_root();
    let control = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).expect("open");
    let pool = control.pool().expect("pool");
    assert_eq!(pool.owner_epoch(), EPOCH);
    assert_eq!(pool.fan_out_state(), FanOutState::Closed);
    assert_eq!(
        pool.revision(),
        1,
        "PoolOpened is the first durable command"
    );
    drop(control);
    let reopened = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).expect("reopen");
    assert_eq!(reopened.pool().expect("pool").owner_epoch(), EPOCH);
    // A changed epoch is refused rather than silently reinterpreting the log.
    drop(reopened);
    assert!(matches!(
        WorkerPoolControl::open(&root, "pool-a", config(EPOCH - 1)),
        Err(WorkerDurableError::Conflict(_))
    ));
}

#[test]
fn configured_worker_pool_limits_are_durable_and_immutable_on_reopen() {
    let root = temp_root();
    let original = config(EPOCH);
    let control = WorkerPoolControl::open(&root, "pool-limits", original).expect("open");
    let limits = control.pool().expect("pool").limits();
    assert_eq!(limits.max_live_workers, original.max_live_workers);
    assert_eq!(limits.max_queued_tickets, original.max_queued_tickets);
    assert_eq!(limits.max_worktrees, original.max_worktrees);
    drop(control);

    let reopened = WorkerPoolControl::open(&root, "pool-limits", original).expect("reopen");
    let limits = reopened.pool().expect("replayed pool").limits();
    assert_eq!(limits.max_live_workers, original.max_live_workers);
    assert_eq!(limits.max_queued_tickets, original.max_queued_tickets);
    assert_eq!(limits.max_worktrees, original.max_worktrees);
    drop(reopened);

    // Reject a changed configuration before writing an epoch-fence command.
    let mut changed = original;
    changed.owner_epoch += 1;
    changed.max_live_workers -= 1;
    assert!(matches!(
        WorkerPoolControl::open(&root, "pool-limits", changed),
        Err(WorkerDurableError::Conflict(_))
    ));
    assert!(WorkerPoolControl::open(&root, "pool-limits", original).is_ok());
}

#[test]
fn derived_capacity_samples_do_not_advance_the_durable_pool_revision() {
    let root = temp_root();
    let mut control = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).expect("open");
    let durable_revision = control.pool().expect("pool").revision();

    let first_sample_revision = control
        .update_capacity(
            BudgetDimension::MemoryBytes,
            Some(1_000),
            Some(200),
            100,
            EPOCH,
            1,
            durable_revision,
        )
        .expect("first trusted sample");
    assert_eq!(first_sample_revision, durable_revision);
    assert_eq!(control.pool().expect("pool").revision(), durable_revision);

    let second_sample_revision = control
        .update_capacity(
            BudgetDimension::MemoryBytes,
            Some(1_000),
            Some(250),
            100,
            EPOCH,
            2,
            durable_revision,
        )
        .expect("newer trusted sample uses the unchanged durable CAS revision");
    assert_eq!(second_sample_revision, durable_revision);

    // A durable command after derived telemetry must have the same revision in
    // memory and after OwnerLog replay.
    control
        .apply(
            durable_revision,
            "wt.register.after-sample",
            worktree_command(EPOCH),
        )
        .expect("durable command follows capacity samples");
    let committed_revision = control.pool().expect("pool").revision();
    drop(control);

    let reopened = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).expect("reopen");
    assert_eq!(
        reopened.pool().expect("replayed pool").revision(),
        committed_revision,
        "derived capacity samples must not create an unlogged aggregate revision"
    );
    assert_eq!(pool_capacity(&reopened), Capacity::UnknownCapacity);
}

#[test]
fn durable_admission_replays_to_the_released_state() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, FAR_FUTURE_MS);
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.reserve", reserve_command(EPOCH, TICKET))
        .expect("durable reserve");
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.claim", claim_command(EPOCH))
        .expect("durable claim before dispatch");
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.bind", bind_command(EPOCH, 4242))
        .expect("bind the launched OS generation");
    assert_eq!(pool_capacity(&control), Capacity::Remaining(400));
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.settle", settle_command(EPOCH, 4242))
        .expect("durable settle");
    assert_eq!(pool_capacity(&control), Capacity::Remaining(700));
    drop(control);

    let mut reopened = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).expect("reopen");
    let worker = reopened
        .pool()
        .expect("pool")
        .worker(WORKER)
        .expect("worker");
    assert_eq!(worker.state, ReservationState::Released);
    // Capacity telemetry is derived and fail-closed after a restart; once a
    // fresh trusted sample arrives the released worker holds nothing.
    assert_eq!(pool_capacity(&reopened), Capacity::UnknownCapacity);
    resupply_capacity(&mut reopened, EPOCH);
    assert_eq!(pool_capacity(&reopened), Capacity::Remaining(700));
}

#[test]
fn managed_lease_proof_requires_current_durable_attempt_budget_and_worktree() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, FAR_FUTURE_MS);
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.reserve", reserve_command(EPOCH, TICKET))
        .expect("durable reserve");

    let proof = control
        .resolve_managed_lease_proof(WORKER, &binding(EPOCH), &owner(EPOCH), 2)
        .expect("proof from live OwnerLog-backed reservation");
    assert_eq!(proof.worker_execution_id(), WORKER);
    assert_eq!(proof.goal_id(), "goal-a");
    assert_eq!(proof.ticket_id(), TICKET);
    assert_eq!(proof.run_id(), "run-a");
    assert_eq!(proof.task_id(), "task-a");
    assert_eq!(proof.attempt_id(), ATTEMPT);
    assert_eq!(proof.owner_epoch(), EPOCH);
    assert_eq!(proof.source_revision(), "rev-1");
    assert_eq!(proof.accepted_spec_digest(), digest('a'));
    assert_eq!(proof.workspace_lease_id(), "worktree-lease-1");
    assert_eq!(proof.budget_lease_id(), "worker-reservation-worker-a");
    assert_eq!(proof.resource_lease_ids(), &["worktree-lease-1".to_owned()]);
    assert_eq!(proof.worker_state(), ReservationState::Reserved);
    assert_eq!(proof.budget_dimension(), BudgetDimension::MemoryBytes);
    assert_eq!(proof.reserved_amount(), 300);
    assert_eq!(proof.expires_at_ms(), FAR_FUTURE_MS);
    assert!(proof.process_identity().is_none());
    assert!(proof.worker_pool_revision() > 0);
    assert_eq!(proof.owner_log_id(), "pool-a");
    assert_ne!(proof.owner_log_sequence(), "0");
    assert!(proof.owner_log_event_digest().starts_with("blake3:"));
    assert!(
        control
            .validate_managed_lease_proof(&proof, &binding(EPOCH), &owner(EPOCH), 2)
            .is_ok()
    );

    let admitted_revision = proof.worker_pool_revision();
    let admitted_cursor = proof.owner_log_sequence().to_owned();

    let stale_binding = VerifiedAttemptBinding::test_fixture(
        "goal-a",
        "run-a",
        "task-a",
        ATTEMPT,
        EPOCH,
        "rev-stale",
        &digest('a'),
    );
    assert!(
        control
            .resolve_managed_lease_proof(WORKER, &stale_binding, &owner(EPOCH), 2)
            .is_err()
    );
    assert!(
        control
            .resolve_managed_lease_proof(WORKER, &binding(EPOCH), &owner(EPOCH), FAR_FUTURE_MS)
            .is_err(),
        "expired lease must not yield a proof"
    );
    let foreign = AuthenticatedOwnerContext::test_fixture(
        "principal-b",
        "workspace-a",
        "session-a",
        "run-a",
        "task-a",
        ATTEMPT,
        EPOCH,
    );
    assert!(
        control
            .resolve_managed_lease_proof(WORKER, &binding(EPOCH), &foreign, 2)
            .is_err(),
        "a foreign authenticated principal cannot resolve this proof"
    );
    assert_eq!(
        control.pool().expect("pool").revision(),
        admitted_revision,
        "failed proof resolution is read-only"
    );
    assert_eq!(
        control
            .resolve_managed_lease_proof(WORKER, &binding(EPOCH), &owner(EPOCH), 2)
            .expect("same live proof remains resolvable")
            .owner_log_sequence(),
        admitted_cursor
    );

    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.claim", claim_command(EPOCH))
        .expect("durable claim");
    assert!(
        control
            .validate_managed_lease_proof(&proof, &binding(EPOCH), &owner(EPOCH), 3)
            .is_err(),
        "a proof is stale after a later durable pool mutation"
    );
    // CLAIMED is the durable startup fence immediately before launch, so the
    // lease proof still resolves; it is NOT an active-parent proof until a
    // process generation is bound, and that launch-uncertainty window is
    // independently enforced on the active-parent path.
    let claimed_lease = control
        .resolve_managed_lease_proof(WORKER, &binding(EPOCH), &owner(EPOCH), 3)
        .expect("claimed worker resolves its startup-fence lease proof");
    assert_eq!(claimed_lease.worker_state(), ReservationState::Claimed);
    assert!(claimed_lease.process_identity().is_none());
    assert!(
        control
            .resolve_active_parent_execution_proof(WORKER, &binding(EPOCH), &owner(EPOCH), 3)
            .is_err(),
        "claimed but not yet process-bound cannot authorize active parent execution"
    );
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.bind", bind_command(EPOCH, 4242))
        .expect("bind live process generation");
    let active = control
        .resolve_managed_lease_proof(WORKER, &binding(EPOCH), &owner(EPOCH), 4)
        .expect("claimed lease with bound process identity");
    assert_eq!(active.worker_state(), ReservationState::Claimed);
    assert_eq!(
        active.process_identity(),
        Some(&ProcessIdentity::new(4242, 9001))
    );
    let parent_proof = control
        .resolve_active_parent_execution_proof(WORKER, &binding(EPOCH), &owner(EPOCH), 4)
        .expect("active parent execution from current durable worker record");
    assert_eq!(parent_proof.worker_execution_id(), WORKER);
    assert_eq!(parent_proof.goal_id(), "goal-a");
    assert_eq!(parent_proof.owner().attempt_id, ATTEMPT);
    assert_eq!(
        parent_proof.process_identity(),
        &ProcessIdentity::new(4242, 9001)
    );
    assert!(
        control
            .validate_active_parent_execution_proof(
                &parent_proof,
                &binding(EPOCH),
                &owner(EPOCH),
                4
            )
            .is_ok()
    );
    let revision = control.pool().expect("pool").revision();
    control
        .apply(
            revision,
            "worker.cancel",
            WorkerCommand::CancelScope {
                scope: scope(EPOCH),
                cancel: CancelScope::Attempt {
                    run_id: "run-a".to_owned(),
                    task_id: "task-a".to_owned(),
                    attempt_id: ATTEMPT.to_owned(),
                },
                now_ms: 5,
            },
        )
        .expect("durable cancellation fence");
    assert!(
        control
            .resolve_managed_lease_proof(WORKER, &binding(EPOCH), &owner(EPOCH), 6)
            .is_err(),
        "cancelled Attempt cannot retain an admission proof"
    );
    assert!(
        control
            .validate_active_parent_execution_proof(
                &parent_proof,
                &binding(EPOCH),
                &owner(EPOCH),
                6
            )
            .is_err(),
        "cancelled parent cannot authorize new child delivery"
    );
    drop(control);

    let mut reopened = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).expect("reopen");
    reopened
        .enable_managed_attempt_fan_out()
        .expect("authorized ingress reopens fan-out");
    assert!(
        reopened
            .resolve_managed_lease_proof(WORKER, &binding(EPOCH), &owner(EPOCH), 5)
            .is_err(),
        "restart quarantines unsettled work before any proof can be minted"
    );
}

#[test]
fn crash_after_claim_quarantines_until_reconciled() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, FAR_FUTURE_MS);
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.reserve", reserve_command(EPOCH, TICKET))
        .expect("durable reserve");
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.claim", claim_command(EPOCH))
        .expect("claim is durable before any spawn");
    // Simulated host crash: the process may or may not have launched.
    drop(control);

    let mut reopened = open_and_enable(&root, EPOCH);
    let worker = reopened
        .pool()
        .expect("pool")
        .worker(WORKER)
        .expect("worker");
    assert_eq!(worker.state, ReservationState::Quarantined);
    assert!(worker.unknown_effect);
    resupply_capacity(&mut reopened, EPOCH);
    assert_eq!(
        pool_capacity(&reopened),
        Capacity::Remaining(400),
        "uncertain capacity is never silently freed"
    );
    // Reconciliation with all three §11.20 proofs releases it.
    let revision = reopened.pool().expect("pool").revision();
    reopened
        .apply(
            revision,
            "worker.reconcile",
            WorkerCommand::ReconcileRelease {
                scope: scope(EPOCH),
                worker_execution_id: WORKER.to_owned(),
                proof: ReconciliationProof {
                    owned_process_exited: true,
                    effects_settled: true,
                    reconciliation_complete: true,
                },
            },
        )
        .expect("reconcile release");
    assert_eq!(pool_capacity(&reopened), Capacity::Remaining(700));
    drop(reopened);

    // Re-opening twice stays idempotent and never resurrects the worker.
    let final_control = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).expect("reopen");
    assert_eq!(
        final_control
            .pool()
            .expect("pool")
            .worker(WORKER)
            .unwrap()
            .state,
        ReservationState::Released
    );
}

#[test]
fn exact_retry_is_idempotent_and_a_reused_delivery_key_conflicts() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, FAR_FUTURE_MS);
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.reserve", reserve_command(EPOCH, TICKET))
        .expect("first delivery");
    let after = control.pool().expect("pool").revision();
    // An exact replay of the same delivery is a successful no-op even after the
    // aggregate revision advanced.
    control
        .apply(after, "worker.reserve", reserve_command(EPOCH, TICKET))
        .expect("idempotent retry");
    assert_eq!(control.pool().expect("pool").revision(), after);
    // Reusing the key for a different command fails closed.
    assert_eq!(
        control.apply(
            after,
            "worker.reserve",
            WorkerCommand::ClaimWorker {
                scope: scope(EPOCH),
                worker_execution_id: WORKER.to_owned(),
            }
        ),
        Err(WorkerDurableError::Conflict(
            "delivery key reused for a different worker command"
        ))
    );
    // A stale aggregate revision fails closed before any append.
    assert_eq!(
        control.apply(
            after.saturating_sub(1),
            "worker.claim",
            claim_command(EPOCH)
        ),
        Err(WorkerDurableError::StaleRevision)
    );
}

#[test]
fn epoch_advance_on_restart_fences_old_work_and_keeps_capacity_conservative() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, FAR_FUTURE_MS);
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.reserve", reserve_command(EPOCH, TICKET))
        .expect("reserve");
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.claim", claim_command(EPOCH))
        .expect("claim");
    drop(control);

    // New incarnation: a higher epoch fences the old work.
    let mut next = open_and_enable(&root, EPOCH + 1);
    assert_eq!(next.pool().expect("pool").owner_epoch(), EPOCH + 1);
    let worker = next.pool().expect("pool").worker(WORKER).expect("worker");
    assert_eq!(worker.state, ReservationState::Quarantined);
    resupply_capacity(&mut next, EPOCH + 1);
    assert_eq!(pool_capacity(&next), Capacity::Remaining(400));
    // Old-epoch authentication cannot act on the new incarnation.
    assert_eq!(
        next.pool_mut().expect("pool").cancel_scope(
            &CancelScope::Run {
                run_id: "run-a".to_owned()
            },
            &owner(EPOCH),
            0
        ),
        Err(WorkerPoolError::StaleOwnerEpoch)
    );
    // The same trusted scope at the new epoch reconciles it: the command scope
    // carries the current epoch while the record keeps its own epoch.
    let revision = next.pool().expect("pool").revision();
    next.apply(
        revision,
        "worker.reconcile",
        WorkerCommand::ReconcileRelease {
            scope: scope(EPOCH + 1),
            worker_execution_id: WORKER.to_owned(),
            proof: ReconciliationProof {
                owned_process_exited: true,
                effects_settled: true,
                reconciliation_complete: true,
            },
        },
    )
    .expect("current-epoch reconciliation of the fenced record");
    assert_eq!(pool_capacity(&next), Capacity::Remaining(700));
}

#[test]
fn cancelled_and_expired_work_replays_without_freeing_uncertain_capacity() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, PAST_EXPIRY_MS);
    let revision = control.pool().expect("pool").revision();
    control
        .apply(revision, "worker.reserve", reserve_command(EPOCH, TICKET))
        .expect("reserve");
    let revision = control.pool().expect("pool").revision();
    control
        .apply(
            revision,
            "scope.cancel",
            WorkerCommand::CancelScope {
                scope: scope(EPOCH),
                cancel: CancelScope::Task {
                    run_id: "run-a".to_owned(),
                    task_id: "task-a".to_owned(),
                },
                now_ms: 10,
            },
        )
        .expect("cancel fence");
    // Proven unlaunched reservation past its deadline expires.
    let revision = control.pool().expect("pool").revision();
    control
        .apply(
            revision,
            "worker.expire",
            WorkerCommand::ExpireUnlaunched {
                scope: scope(EPOCH),
                worker_execution_id: WORKER.to_owned(),
                now_ms: 10,
                proof: resource_budget::ReservationProof {
                    no_launch_or_dispatch: true,
                    ..resource_budget::ReservationProof::default()
                },
            },
        )
        .expect("expire unlaunched");
    drop(control);

    let mut reopened = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).expect("reopen");
    assert_eq!(
        reopened
            .pool()
            .expect("pool")
            .worker(WORKER)
            .expect("worker")
            .state,
        ReservationState::Expired
    );
    // The ticket was consumed by the reservation; the fence applied to the
    // worker scope rather than to a queued ticket.
    assert_eq!(
        reopened
            .pool()
            .expect("pool")
            .ticket(TICKET)
            .expect("ticket")
            .state,
        TicketState::Consumed
    );
    assert_eq!(pool_capacity(&reopened), Capacity::UnknownCapacity);
    resupply_capacity(&mut reopened, EPOCH);
    assert_eq!(pool_capacity(&reopened), Capacity::Remaining(700));
}

#[test]
fn fan_out_must_be_reopened_by_the_ingress_after_a_restart() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, FAR_FUTURE_MS);
    drop(control);
    let mut reopened = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).expect("reopen");
    assert_eq!(reopened.fan_out_state(), FanOutState::Closed);
    let revision = reopened.pool().expect("pool").revision();
    // The binding facts are valid, but a restart requires explicit
    // re-authorization by the authenticated managed-attempt ingress.
    assert_eq!(
        reopened.pool_mut().expect("pool").reserve(
            TICKET,
            &binding(EPOCH),
            WORKER,
            &owner(EPOCH),
            revision,
            1
        ),
        Err(WorkerPoolError::FanOutClosed)
    );
    reopened
        .enable_managed_attempt_fan_out()
        .expect("ingress reopens");
    // The pre-restart ticket is fenced and capacity telemetry is gone; the
    // coordinator re-enqueues a fresh ticket after a fresh trusted sample.
    resupply_capacity(&mut reopened, EPOCH);
    let revision = reopened.pool().expect("pool").revision();
    reopened
        .apply(
            revision,
            "ticket.enqueue-b",
            WorkerCommand::Enqueue {
                scope: scope(EPOCH),
                request: EnqueueRequest {
                    ticket_id: "ticket-b".to_owned(),
                    goal_id: "goal-a".to_owned(),
                    idempotency_key: "key-b".to_owned(),
                    dimension: BudgetDimension::MemoryBytes,
                    amount: 300,
                    expires_at_ms: FAR_FUTURE_MS,
                    expected_task_revision: "rev-1".to_owned(),
                    accepted_spec_digest: digest('a'),
                    class: WorkerClass::IsolatedEffectful,
                    worktree: Some(WorktreeBindingRequest {
                        worktree_id: "wt-a".to_owned(),
                        base_revision: "rev-1".to_owned(),
                    }),
                    parent_execution: None,
                },
            },
        )
        .expect("fresh ticket after re-authorization");
    let revision = reopened.pool().expect("pool").revision();
    reopened
        .apply(
            revision,
            "worker.reserve-b",
            reserve_command(EPOCH, "ticket-b"),
        )
        .expect("reserve after re-authorization");
}

/// A durable reserve whose crate-internal binding belongs to another managed
/// Goal must be denied with no OwnerLog append, no ticket consumption, no
/// capacity debit, no worktree claim and no worker record.
#[test]
fn durable_reserve_rejects_another_goals_binding_without_state_change() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, FAR_FUTURE_MS);
    let revision = control.pool().expect("pool").revision();
    let other_goal = VerifiedAttemptBinding::test_fixture(
        "goal-b",
        "run-a",
        "task-a",
        ATTEMPT,
        EPOCH,
        "rev-1",
        &digest('a'),
    );
    assert_eq!(
        control.apply(
            revision,
            "worker.reserve-other-goal",
            WorkerCommand::Reserve {
                scope: scope(EPOCH),
                ticket_id: TICKET.to_owned(),
                worker_execution_id: WORKER.to_owned(),
                binding: other_goal,
                now_ms: 1,
            },
        ),
        Err(WorkerDurableError::Pool(
            WorkerPoolError::GoalBindingMismatch
        ))
    );
    let pool = control.pool().expect("pool");
    assert_eq!(
        pool.ticket(TICKET).expect("ticket").state,
        TicketState::Queued
    );
    assert_eq!(pool.live_worker_count(), 0);
    assert!(pool.worker(WORKER).is_none());
    assert_eq!(
        pool.revision(),
        revision,
        "a denied command never advances the aggregate"
    );
    assert_eq!(pool_capacity(&control), Capacity::Remaining(700));

    // The denial never recorded the delivery, so the same delivery key still
    // applies the correct, goal-bound command.
    control
        .apply(
            revision,
            "worker.reserve-other-goal",
            reserve_command(EPOCH, TICKET),
        )
        .expect("correct goal binding applies under the same delivery key");
    assert_eq!(
        control
            .pool()
            .expect("pool")
            .worker(WORKER)
            .expect("worker")
            .goal_id,
        "goal-a"
    );
}


/// Source-only regression for recovery append/replay revision equivalence.
#[test]
fn recovery_fence_revision_replays_exactly_after_a_claimed_worker_crash() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, FAR_FUTURE_MS);
    let revision = control.pool().unwrap().revision();
    control.apply(revision, "reserve.recovery", reserve_command(EPOCH, TICKET)).unwrap();
    let revision = control.pool().unwrap().revision();
    control.apply(revision, "claim.recovery", claim_command(EPOCH)).unwrap();
    drop(control);
    let recovered = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).unwrap();
    let revision = recovered.pool().unwrap().revision();
    assert_eq!(recovered.pool().unwrap().worker(WORKER).unwrap().state, ReservationState::Quarantined);
    drop(recovered);
    let replayed = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).unwrap();
    assert_eq!(replayed.pool().unwrap().revision(), revision);
    assert_eq!(replayed.pool().unwrap().worker(WORKER).unwrap().state, ReservationState::Quarantined);
}

#[test]
fn durable_epoch_delivery_keys_allow_multiple_distinct_restart_epochs() {
    let root = temp_root();
    drop(WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).unwrap());
    drop(WorkerPoolControl::open(&root, "pool-a", config(EPOCH + 1)).unwrap());
    let next = WorkerPoolControl::open(&root, "pool-a", config(EPOCH + 2)).unwrap();
    assert_eq!(next.pool().unwrap().owner_epoch(), EPOCH + 2);
    assert_eq!(next.fan_out_state(), FanOutState::Closed);
}

#[test]
fn explicitly_retained_pre_admission_reservation_does_not_timeout_expire() {
    let root = temp_root();
    let mut control = open_and_enable(&root, EPOCH);
    seed(&mut control, EPOCH, PAST_EXPIRY_MS);
    let revision = control.pool().unwrap().revision();
    control.apply(revision, "reserve.retained", reserve_command(EPOCH, TICKET)).unwrap();
    let pool = control.pool_mut().unwrap();
    let retained = std::collections::BTreeSet::from([WORKER.to_owned()]);
    let report = pool.recover_after_restart_preserving(FAR_FUTURE_MS, &retained).unwrap();
    assert_eq!(report.expired_workers, 0);
    assert_eq!(pool.worker(WORKER).unwrap().state, ReservationState::Reserved);
}

#[test]
fn logical_root_coordinator_is_durable_scoped_and_allocates_no_worker_slot() {
    use crate::worker_durable::WorkerAdmissionPinsV1;
    let root = temp_root();
    let mut control = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).unwrap();
    let owner = AuthenticatedOwnerContext::from_verified_ingress(
        "server_auth:alice".into(), "workspace-a".into(), "session-a".into(),
        "run-a".into(), "task-a".into(), ATTEMPT.into(), EPOCH,
    ).unwrap();
    let pins = WorkerAdmissionPinsV1::from_authenticated_host(
        &owner, &binding(EPOCH), "location-a", "core-incarnation-a",
        "profile-a", 1, &digest('b'), &digest('c'), &digest('d'),
        &format!("sha256:{}", "e".repeat(64)),
    ).unwrap();
    let principal = protocol::AuthenticatedPrincipalV1::ServerAuth { subject: "alice".into() };
    let observed = ProcessIdentity::new(1234, 55);
    let proof = control.register_root_coordinator(
        "root.register", &principal, &pins, &observed, 1, FAR_FUTURE_MS,
    );
    // An unbounded caller-chosen attachment lifetime is rejected.
    assert!(proof.is_err());
    let proof = control.register_root_coordinator(
        "root.register", &principal, &pins, &observed, 1, 10_000,
    ).unwrap();
    assert_eq!(proof.principal_ref(), "server_auth:alice");
    assert_eq!(control.pool().unwrap().live_worker_count(), 0);
    assert_eq!(control.fan_out_state(), FanOutState::Closed);
    assert!(control.resolve_root_coordinator_proof(&pins, &ProcessIdentity::new(1234, 56), 2).is_err());
    assert!(control.resolve_root_coordinator_proof(&pins, &observed, 10_000).is_err());
    drop(control);
    let replayed = WorkerPoolControl::open(&root, "pool-a", config(EPOCH)).unwrap();
    let durable = replayed.resolve_root_coordinator_proof(&pins, &observed, 2).unwrap();
    assert_eq!(durable.worker_execution_id(), proof.worker_execution_id());
    assert_eq!(replayed.pool().unwrap().live_worker_count(), 0);
}

/// Source-only acceptance fixture for the first half of the P8 lifecycle:
/// Guard descriptor construction may resolve a pending create without marking
/// possible dispatch; only the exact settled, current-root Create receipt can
/// produce a target for the follow-up Inspect operation.
#[test]
fn created_worktree_inspect_target_requires_exact_settled_create_receipt() {
    use crate::worker_durable::{RootCoordinatorExecutionProofV1, WorkerAdmissionPinsV1};
    use crate::worktree_lifecycle::{GuardedWorktreeReceiptV1, WorktreeObservedStatusV1, WorkspaceRootRefV1};

    let data_root = temp_root();
    let mut control = open_and_enable(&data_root, EPOCH);
    let root_owner = AuthenticatedOwnerContext::from_verified_ingress(
        "server_auth:alice".into(), "workspace-a".into(), "session-a".into(),
        "run-a".into(), "task-a".into(), ATTEMPT.into(), EPOCH,
    ).unwrap();
    let process = ProcessIdentity::new(1234, 55);
    let admission_pins = WorkerAdmissionPinsV1::from_authenticated_host(
        &root_owner,
        &binding(EPOCH),
        "location-a",
        "core-incarnation-a",
        "profile-a",
        1,
        &digest('b'),
        &digest('c'),
        &digest('d'),
        &format!("sha256:{}", "e".repeat(64)),
    ).unwrap();
    let principal = protocol::AuthenticatedPrincipalV1::ServerAuth { subject: "alice".into() };
    let initial_root_proof = control.register_root_coordinator(
        "root.create-test", &principal, &admission_pins, &process, 1, 10_000,
    ).unwrap();
    let workspace_root = WorkspaceRootRefV1::from_host_kernel(
        "location-a".into(), root_owner.workspace_binding().into(), 3,
    ).unwrap();
    let revision = format!("blake3:{}", "f".repeat(64));
    let create_pin = control.prepare_worktree_create_pin(
        &initial_root_proof, 2, "create-idempotency", workspace_root.clone(),
        "git-base-revision-a", &revision,
    ).unwrap();

    let pre_dispatch_proof = control.resolve_root_coordinator_proof(&admission_pins, &process, 3).unwrap();
    assert!(control.resolve_pending_worktree_intent(create_pin.operation_id(), &pre_dispatch_proof, 3).is_ok());
    assert!(control.worktree_operations().get(create_pin.operation_id())
        .is_some_and(|record| record.state() == worktree_lifecycle::WorktreeOperationStateV1::Pending));

    control.mark_worktree_dispatch_started_and_get_request(
        &create_pin, &pre_dispatch_proof, 3,
    ).unwrap();
    let post_marker_proof: RootCoordinatorExecutionProofV1 =
        control.resolve_root_coordinator_proof(&admission_pins, &process, 4).unwrap();
    let create_receipt = GuardedWorktreeReceiptV1::from_guarded_host(
        create_pin.operation_id().to_owned(), "host-create-receipt".into(), create_pin.root(),
        revision.clone(), WorktreeObservedStatusV1::Clean, 0, String::new(), false,
        None, true, true,
    ).unwrap();
    control.persist_worktree_receipt(
        "create.receipt", &post_marker_proof, 4, create_receipt,
    ).unwrap();

    let settled_proof = control.resolve_root_coordinator_proof(&admission_pins, &process, 5).unwrap();
    let target = control.resolve_created_worktree_target(&create_pin, &settled_proof, 5).unwrap();
    assert_eq!(target.owner().workspace_binding(), root_owner.workspace_binding());
    assert_eq!(target.worktree_id(), create_pin.worktree_id());
    assert_eq!(target.base_revision(), "git-base-revision-a");
    assert_eq!(target.relative_path(), create_pin.relative_path());
}
