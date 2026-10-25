use crate::resource_budget;
use crate::resource_sampler;
use crate::worktree_pool;

use std::path::PathBuf;

use resource_budget::{AuthenticatedOwnerContext, ReservationProof, ReservationState};
use resource_sampler::ProcessIdentity;
use worktree_pool::{
    SettlementEvidence, WorktreePool, WorktreePoolError, WorktreeRegistration, WorktreeStatus,
};

fn owner(epoch: u64, session: &str, attempt: &str) -> AuthenticatedOwnerContext {
    AuthenticatedOwnerContext::test_fixture(
        "principal-a",
        "workspace-a",
        session,
        "run-a",
        "task-a",
        attempt,
        epoch,
    )
}

fn pool() -> WorktreePool {
    WorktreePool::new(7, 2, 1).expect("bounded pool")
}

fn register(pool: &mut WorktreePool, id: &str, owner: &AuthenticatedOwnerContext) -> u64 {
    pool.register(
        WorktreeRegistration {
            id: id.to_owned(),
            workspace_binding: "workspace-a".to_owned(),
            path: PathBuf::from(format!("/worktrees/{id}")),
            base_revision: "base-a".to_owned(),
            observed_revision: Some("base-a".to_owned()),
            clean: Some(true),
            has_untracked: Some(false),
        },
        owner,
        pool.revision(),
    )
    .expect("register clean worktree")
}

#[test]
fn pool_is_bounded_and_leases_are_scope_and_idempotency_fenced() {
    let mut pool = pool();
    let auth = owner(7, "session-a", "attempt-a");
    register(&mut pool, "wt-a", &auth);
    register(&mut pool, "wt-b", &auth);
    assert_eq!(
        pool.register(
            WorktreeRegistration {
                id: "wt-c".to_owned(),
                workspace_binding: "workspace-a".to_owned(),
                path: PathBuf::from("/worktrees/wt-c"),
                base_revision: "base-a".to_owned(),
                observed_revision: Some("base-a".to_owned()),
                clean: Some(true),
                has_untracked: Some(false),
            },
            &auth,
            pool.revision(),
        ),
        Err(WorktreePoolError::PoolLimitReached)
    );

    let lease = pool
        .acquire(
            "request-a",
            "wt-a",
            "base-a",
            auth.clone(),
            pool.revision(),
            10_000,
        )
        .expect("lease free worktree");
    let replay = pool
        .acquire("request-a", "wt-a", "base-a", auth.clone(), 0, 10_000)
        .expect("same request replays without a second lease");
    assert_eq!(lease.lease_id, replay.lease_id);
    assert_eq!(
        pool.snapshot("wt-a").unwrap().status,
        WorktreeStatus::Leased
    );

    let other_attempt = owner(7, "session-a", "attempt-b");
    assert_eq!(
        pool.begin_release(&lease.lease_id, &other_attempt, pool.revision()),
        Err(WorktreePoolError::ScopeMismatch)
    );
    assert_eq!(
        pool.acquire(
            "request-b",
            "wt-b",
            "base-a",
            auth.clone(),
            pool.revision(),
            10_000
        ),
        Err(WorktreePoolError::ActiveLeaseLimitReached)
    );
    assert_eq!(
        pool.snapshot("wt-a").unwrap().reservation_state,
        Some(ReservationState::Reserved)
    );
}

#[test]
fn only_proven_unlaunched_reservations_can_expire() {
    let mut pool = pool();
    let auth = owner(7, "session-a", "attempt-a");
    register(&mut pool, "wt-a", &auth);
    let lease = pool
        .acquire(
            "request-a",
            "wt-a",
            "base-a",
            auth.clone(),
            pool.revision(),
            100,
        )
        .expect("reserve worktree");
    assert_eq!(
        pool.expire_unlaunched(
            &lease.lease_id,
            &auth,
            101,
            ReservationProof::default(),
            pool.revision(),
        ),
        Err(WorktreePoolError::MissingProof)
    );
    pool.expire_unlaunched(
        &lease.lease_id,
        &auth,
        101,
        ReservationProof {
            no_launch_or_dispatch: true,
            ..ReservationProof::default()
        },
        pool.revision(),
    )
    .expect("proven unlaunched reservation may expire");
    let snapshot = pool.snapshot("wt-a").unwrap();
    assert_eq!(snapshot.status, WorktreeStatus::Free);
    assert_eq!(snapshot.reservation_state, Some(ReservationState::Expired));
}

#[test]
fn launched_worktree_cannot_expire_and_dirty_settlement_stays_quarantined() {
    let mut pool = pool();
    let auth = owner(7, "session-a", "attempt-a");
    register(&mut pool, "wt-a", &auth);
    let lease = pool
        .acquire(
            "request-a",
            "wt-a",
            "base-a",
            auth.clone(),
            pool.revision(),
            100,
        )
        .expect("reserve worktree");
    let process = ProcessIdentity::new(101, 4_001);
    pool.claim(
        &lease.lease_id,
        &auth,
        "worker-a",
        process.clone(),
        pool.revision(),
    )
    .expect("claim authenticated worker process");
    assert_eq!(
        pool.expire_unlaunched(
            &lease.lease_id,
            &auth,
            101,
            ReservationProof {
                no_launch_or_dispatch: true,
                ..ReservationProof::default()
            },
            pool.revision(),
        ),
        Err(WorktreePoolError::InvalidTransition)
    );
    pool.begin_release(&lease.lease_id, &auth, pool.revision())
        .expect("begin release only after launch is fenced");
    assert_eq!(
        pool.release(
            &lease.lease_id,
            &auth,
            SettlementEvidence {
                process_identity: Some(process.clone()),
                owned_process_exited: true,
                effects_settled: false,
                reconciliation_complete: false,
                observed_revision: Some("changed-revision".to_owned()),
                clean: Some(true),
                has_untracked: Some(false),
            },
            pool.revision(),
        ),
        Err(WorktreePoolError::MissingProof)
    );
    pool.release(
        &lease.lease_id,
        &auth,
        SettlementEvidence {
            process_identity: Some(process),
            owned_process_exited: true,
            effects_settled: true,
            reconciliation_complete: true,
            observed_revision: Some("changed-revision".to_owned()),
            clean: Some(false),
            has_untracked: Some(true),
        },
        pool.revision(),
    )
    .expect("settlement releases capacity but never frees dirty worktree");
    assert_eq!(
        pool.snapshot("wt-a").unwrap().status,
        WorktreeStatus::Quarantined
    );
    assert_eq!(
        pool.snapshot("wt-a").unwrap().reservation_state,
        Some(ReservationState::Released)
    );
}

#[test]
fn stale_owner_epoch_and_reused_pid_cannot_release_or_reuse_a_worktree() {
    let mut pool = pool();
    let auth = owner(7, "session-a", "attempt-a");
    register(&mut pool, "wt-a", &auth);
    let lease = pool
        .acquire(
            "request-a",
            "wt-a",
            "base-a",
            auth.clone(),
            pool.revision(),
            100,
        )
        .expect("reserve worktree");
    let process = ProcessIdentity::new(101, 4_001);
    pool.claim(
        &lease.lease_id,
        &auth,
        "worker-a",
        process.clone(),
        pool.revision(),
    )
    .expect("claim");
    let stale = owner(6, "session-a", "attempt-a");
    assert_eq!(
        pool.quarantine(&lease.lease_id, &stale, pool.revision()),
        Err(WorktreePoolError::StaleOwnerEpoch)
    );
    pool.begin_release(&lease.lease_id, &auth, pool.revision())
        .expect("release pending");
    assert_eq!(
        pool.release(
            &lease.lease_id,
            &auth,
            SettlementEvidence {
                process_identity: Some(ProcessIdentity::new(101, 9_999)),
                owned_process_exited: true,
                effects_settled: true,
                reconciliation_complete: true,
                observed_revision: Some("base-a".to_owned()),
                clean: Some(true),
                has_untracked: Some(false),
            },
            pool.revision(),
        ),
        Err(WorktreePoolError::ProcessIdentityMismatch)
    );
    assert_eq!(
        pool.snapshot("wt-a").unwrap().status,
        WorktreeStatus::Leased
    );
    assert_eq!(
        pool.snapshot("wt-a").unwrap().reservation_state,
        Some(ReservationState::ReleasePending)
    );
}

#[test]
fn sibling_attempt_cannot_reclaim_a_worktree_until_owner_reconciliation_and_release() {
    let mut pool = pool();
    let current = owner(7, "session-a", "attempt-a");
    let sibling = owner(7, "session-a", "attempt-b");
    register(&mut pool, "wt-a", &current);
    let lease = pool
        .acquire(
            "request-attempt-a",
            "wt-a",
            "base-a",
            current.clone(),
            pool.revision(),
            10_000,
        )
        .expect("first Attempt owns the worktree lease");
    let process = ProcessIdentity::new(303, 8_001);
    pool.claim(
        &lease.lease_id,
        &current,
        "worker-attempt-a",
        process.clone(),
        pool.revision(),
    )
    .expect("bind the first Attempt's worker generation");

    assert_eq!(
        pool.acquire(
            "request-attempt-b",
            "wt-a",
            "base-a",
            sibling.clone(),
            pool.revision(),
            10_000,
        ),
        Err(WorktreePoolError::NotAvailable),
        "a sibling Attempt cannot take the active lease"
    );
    assert_eq!(
        pool.begin_release(&lease.lease_id, &sibling, pool.revision()),
        Err(WorktreePoolError::ScopeMismatch),
        "the new Attempt cannot release another Attempt's lease"
    );

    pool.quarantine(&lease.lease_id, &current, pool.revision())
        .expect("uncertain cancellation/restart retains the lease");
    let stale = owner(6, "session-a", "attempt-a");
    let settled = SettlementEvidence {
        process_identity: Some(process.clone()),
        owned_process_exited: true,
        effects_settled: true,
        reconciliation_complete: true,
        observed_revision: Some("base-a".to_owned()),
        clean: Some(true),
        has_untracked: Some(false),
    };
    assert_eq!(
        pool.reconcile_quarantined(&lease.lease_id, &stale, &settled, pool.revision()),
        Err(WorktreePoolError::StaleOwnerEpoch),
        "a stale owner epoch cannot reconcile or reclaim the lease"
    );
    assert_eq!(
        pool.reconcile_quarantined(
            &lease.lease_id,
            &current,
            &SettlementEvidence {
                owned_process_exited: false,
                ..settled.clone()
            },
            pool.revision(),
        ),
        Err(WorktreePoolError::MissingProof),
        "an unresolved owned process keeps the worktree quarantined"
    );
    assert_eq!(
        pool.acquire(
            "request-attempt-b",
            "wt-a",
            "base-a",
            sibling.clone(),
            pool.revision(),
            10_000,
        ),
        Err(WorktreePoolError::NotAvailable)
    );

    pool.reconcile_quarantined(&lease.lease_id, &current, &settled, pool.revision())
        .expect("current owner proves process exit and effect reconciliation");
    assert_eq!(
        pool.acquire(
            "request-attempt-b",
            "wt-a",
            "base-a",
            sibling.clone(),
            pool.revision(),
            10_000,
        ),
        Err(WorktreePoolError::NotAvailable),
        "reconciliation alone does not free or transfer the workspace"
    );
    pool.release(&lease.lease_id, &current, settled, pool.revision())
        .expect("clean unchanged workspace is released after reconciliation");

    pool.acquire(
        "request-attempt-b",
        "wt-a",
        "base-a",
        sibling,
        pool.revision(),
        10_000,
    )
    .expect("only settled release permits the new Attempt to acquire it");
}

#[test]
fn unknown_or_dirty_registration_is_quarantined_without_cleanup() {
    let mut pool = pool();
    let auth = owner(7, "session-a", "attempt-a");
    pool.register(
        WorktreeRegistration {
            id: "wt-dirty".to_owned(),
            workspace_binding: "workspace-a".to_owned(),
            path: PathBuf::from("/worktrees/wt-dirty"),
            base_revision: "base-a".to_owned(),
            observed_revision: Some("base-a".to_owned()),
            clean: Some(false),
            has_untracked: Some(true),
        },
        &auth,
        pool.revision(),
    )
    .expect("record dirty worktree as quarantined");
    pool.register(
        WorktreeRegistration {
            id: "wt-unknown".to_owned(),
            workspace_binding: "workspace-a".to_owned(),
            path: PathBuf::from("/worktrees/wt-unknown"),
            base_revision: "base-a".to_owned(),
            observed_revision: None,
            clean: None,
            has_untracked: None,
        },
        &auth,
        pool.revision(),
    )
    .expect("record ambiguous worktree as quarantined");
    assert_eq!(
        pool.snapshot("wt-dirty").unwrap().status,
        WorktreeStatus::Quarantined
    );
    assert_eq!(
        pool.snapshot("wt-unknown").unwrap().status,
        WorktreeStatus::Quarantined
    );
    assert_eq!(
        pool.acquire(
            "request-a",
            "wt-dirty",
            "base-a",
            auth,
            pool.revision(),
            10_000
        ),
        Err(WorktreePoolError::NotAvailable)
    );
}

#[test]
fn quarantined_lease_requires_reconciliation_before_clean_worktree_reuse() {
    let mut pool = pool();
    let auth = owner(7, "session-a", "attempt-a");
    register(&mut pool, "wt-a", &auth);
    let lease = pool
        .acquire(
            "request-a",
            "wt-a",
            "base-a",
            auth.clone(),
            pool.revision(),
            100,
        )
        .expect("lease worktree");
    let process = ProcessIdentity::new(202, 5_001);
    pool.claim(
        &lease.lease_id,
        &auth,
        "worker-a",
        process.clone(),
        pool.revision(),
    )
    .expect("claim worker process");
    pool.quarantine(&lease.lease_id, &auth, pool.revision())
        .expect("hold uncertain worker in quarantine");

    let incomplete = SettlementEvidence {
        process_identity: Some(process.clone()),
        owned_process_exited: true,
        effects_settled: true,
        reconciliation_complete: false,
        observed_revision: Some("base-a".to_owned()),
        clean: Some(true),
        has_untracked: Some(false),
    };
    let reused_pid = SettlementEvidence {
        process_identity: Some(ProcessIdentity::new(202, 8_888)),
        reconciliation_complete: true,
        ..incomplete.clone()
    };
    assert_eq!(
        pool.reconcile_quarantined(&lease.lease_id, &auth, &reused_pid, pool.revision()),
        Err(WorktreePoolError::ProcessIdentityMismatch)
    );
    assert_eq!(
        pool.begin_release(&lease.lease_id, &auth, pool.revision()),
        Err(WorktreePoolError::MissingProof)
    );
    assert_eq!(
        pool.reconcile_quarantined(&lease.lease_id, &auth, &incomplete, pool.revision()),
        Err(WorktreePoolError::MissingProof)
    );
    let process_still_running = SettlementEvidence {
        owned_process_exited: false,
        reconciliation_complete: true,
        ..incomplete.clone()
    };
    assert_eq!(
        pool.reconcile_quarantined(
            &lease.lease_id,
            &auth,
            &process_still_running,
            pool.revision()
        ),
        Err(WorktreePoolError::MissingProof)
    );
    assert_eq!(
        pool.snapshot("wt-a").unwrap().reservation_state,
        Some(ReservationState::Quarantined)
    );

    let release_pending = SettlementEvidence {
        effects_settled: false,
        reconciliation_complete: true,
        ..incomplete
    };
    assert_eq!(
        pool.reconcile_quarantined(
            &lease.lease_id,
            &auth,
            &release_pending,
            pool.revision() - 1
        ),
        Err(WorktreePoolError::StaleRevision)
    );
    pool.reconcile_quarantined(&lease.lease_id, &auth, &release_pending, pool.revision())
        .expect("reconciled quarantine may enter release-pending");
    assert_eq!(
        pool.release(
            &lease.lease_id,
            &auth,
            release_pending.clone(),
            pool.revision()
        ),
        Err(WorktreePoolError::MissingProof)
    );
    let settled = SettlementEvidence {
        effects_settled: true,
        ..release_pending
    };
    pool.release(&lease.lease_id, &auth, settled, pool.revision())
        .expect("clean unchanged worktree is reusable after settlement");
    assert_eq!(pool.snapshot("wt-a").unwrap().status, WorktreeStatus::Free);
    assert_eq!(
        pool.snapshot("wt-a").unwrap().reservation_state,
        Some(ReservationState::Released)
    );
    pool.acquire("request-b", "wt-a", "base-a", auth, pool.revision(), 10_000)
        .expect("settled clean worktree can be leased again");
}

#[test]
fn competing_release_and_claim_admits_exactly_one_lease_winner() {
    let mut pool = pool();
    let auth = owner(7, "session-a", "attempt-a");
    register(&mut pool, "wt-a", &auth);
    let lease = pool
        .acquire(
            "request-a",
            "wt-a",
            "base-a",
            auth.clone(),
            pool.revision(),
            100,
        )
        .expect("reserve worktree");
    // A reservation that was never claimed cannot skip CLAIMED into release.
    assert_eq!(
        pool.begin_release(&lease.lease_id, &auth, pool.revision()),
        Err(WorktreePoolError::InvalidTransition)
    );
    let process = ProcessIdentity::new(101, 4_001);
    pool.claim(
        &lease.lease_id,
        &auth,
        "worker-a",
        process.clone(),
        pool.revision(),
    )
    .expect("claim worker");
    pool.begin_release(&lease.lease_id, &auth, pool.revision())
        .expect("begin release-pending");
    // The release wins: a competing claim cannot steal a release-pending lease.
    assert_eq!(
        pool.claim(
            &lease.lease_id,
            &auth,
            "worker-b",
            process.clone(),
            pool.revision()
        ),
        Err(WorktreePoolError::InvalidTransition)
    );
    pool.release(
        &lease.lease_id,
        &auth,
        SettlementEvidence {
            process_identity: Some(process),
            owned_process_exited: true,
            effects_settled: true,
            reconciliation_complete: true,
            observed_revision: Some("base-a".to_owned()),
            clean: Some(true),
            has_untracked: Some(false),
        },
        pool.revision(),
    )
    .expect("clean settled release");
    // Terminal lease records are one-way: late expiry is rejected, and only a
    // new request under a new lease identity can reuse the clean worktree.
    assert_eq!(
        pool.expire_unlaunched(
            &lease.lease_id,
            &auth,
            20_000,
            ReservationProof {
                no_launch_or_dispatch: true,
                ..ReservationProof::default()
            },
            pool.revision(),
        ),
        Err(WorktreePoolError::InvalidTransition)
    );
    let next = pool
        .acquire("request-b", "wt-a", "base-a", auth, pool.revision(), 10_000)
        .expect("clean unchanged worktree is reusable under a new lease");
    assert_ne!(next.lease_id, lease.lease_id);
}

#[test]
fn registration_requires_absolute_confined_paths_and_matching_workspace() {
    let mut pool = pool();
    let auth = owner(7, "session-a", "attempt-a");
    let template = |id: &str, path: &str, workspace: &str| WorktreeRegistration {
        id: id.to_owned(),
        workspace_binding: workspace.to_owned(),
        path: PathBuf::from(path),
        base_revision: "base-a".to_owned(),
        observed_revision: Some("base-a".to_owned()),
        clean: Some(true),
        has_untracked: Some(false),
    };
    assert_eq!(
        pool.register(
            template("wt-relative", "worktrees/wt-relative", "workspace-a"),
            &auth,
            pool.revision(),
        ),
        Err(WorktreePoolError::InvalidRegistration)
    );
    assert_eq!(
        pool.register(
            template("wt-escape", "/worktrees/../wt-escape", "workspace-a"),
            &auth,
            pool.revision(),
        ),
        Err(WorktreePoolError::InvalidRegistration)
    );
    assert_eq!(
        pool.register(
            template("wt-foreign", "/worktrees/wt-foreign", "workspace-b"),
            &auth,
            pool.revision(),
        ),
        Err(WorktreePoolError::InvalidRegistration)
    );
    register(&mut pool, "wt-a", &auth);
    assert_eq!(
        pool.register(
            template("wt-b", "/worktrees/wt-a", "workspace-a"),
            &auth,
            pool.revision(),
        ),
        Err(WorktreePoolError::DuplicatePath)
    );
}
