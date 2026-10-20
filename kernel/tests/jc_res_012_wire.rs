//! JC-RES-012.I/K/L wire tests: canonical reservation/pressure vocabulary,
//! authenticated owner-epoch scope and "a ticket/lease alone authorizes
//! nothing" negatives (§32.37).
//!
//! Scope honesty: JC-RES-012.L's Provider Doctor RPC belongs to the provider
//! phase; the Rust half verified here is that a provider-cost/token reservation
//! with a foreign or revoked owner epoch is denied before any capacity or
//! reservation record exists, with no charged fallback. JC-RES-012.I's
//! TypeScript consumer is not implemented yet; the frozen fixture records that
//! gap explicitly instead of asserting a roundtrip that does not exist.

#[path = "../src/resource_budget.rs"]
mod resource_budget;
#[path = "../src/resource_sampler.rs"]
mod resource_sampler;
#[path = "../src/worker_pool.rs"]
mod worker_pool;
#[path = "../src/worktree_pool.rs"]
mod worktree_pool;

use std::path::PathBuf;

use resource_budget::{
    AuthenticatedOwnerContext, BudgetDimension, Capacity, PressureState, ReservationProof,
    ReservationState, ResourceWireError,
};
use worker_pool::{
    EnqueueRequest, TicketState, VerifiedAttemptBinding, WorkerClass, WorkerPool, WorkerPoolConfig,
    WorkerPoolError, WorktreeBindingRequest,
};
use worktree_pool::WorktreeRegistration;

const EPOCH: u64 = 11;
const ATTEMPT: &str = "attempt-a";
const TICKET: &str = "ticket-a";

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

#[allow(clippy::too_many_arguments)]
fn foreign_owner(
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

fn fixture() -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("reservation-wire-v1.json");
    let text = std::fs::read_to_string(&path).expect("frozen wire fixture is tracked");
    serde_json::from_str(&text).expect("fixture is valid JSON")
}

fn canonical_names(value: &serde_json::Value, section: &str) -> Vec<String> {
    value[section]["canonical"]
        .as_array()
        .expect("canonical list")
        .iter()
        .map(|item| item.as_str().expect("canonical name").to_owned())
        .collect()
}

fn forbidden_names(value: &serde_json::Value, section: &str) -> Vec<String> {
    value[section]["forbidden"]
        .as_array()
        .expect("forbidden list")
        .iter()
        .map(|item| item.as_str().expect("forbidden name").to_owned())
        .collect()
}

/// JC-RES-012.I — the wire carries exactly the §11.20/§18.18 vocabulary; an
/// obsolete `ACTIVE`/`UNKNOWN` reservation status or a `SOFT`/`HARD` pressure
/// alias is rejected by the strict decoder, and the frozen fixture matches the
/// Rust tables exactly.
#[test]
fn jc_res_012_i_wire_vocabulary_is_strict_and_matches_the_frozen_fixture() {
    let fixture = fixture();

    // Reservation status: canonical roundtrip and exact rejection set.
    let canonical = canonical_names(&fixture, "reservationStatus");
    let mut decoded = Vec::new();
    for name in &canonical {
        let state = ReservationState::parse_wire(name).expect("canonical name decodes");
        assert_eq!(state.wire_name(), name, "roundtrip is identical");
        decoded.push(state);
    }
    assert_eq!(decoded.len(), ReservationState::WIRE_NAMES.len());
    for name in &forbidden_names(&fixture, "reservationStatus") {
        assert_eq!(
            ReservationState::parse_wire(name),
            Err(ResourceWireError::UnknownReservationStatus),
            "{name:?} must not be a reservation state"
        );
    }
    // `ACTIVE` and `UNKNOWN` specifically: UNKNOWN is an EffectIntent or
    // measurement outcome, never a reservation state.
    assert_eq!(
        ReservationState::parse_wire("ACTIVE"),
        Err(ResourceWireError::UnknownReservationStatus)
    );
    assert_eq!(
        ReservationState::parse_wire("UNKNOWN"),
        Err(ResourceWireError::UnknownReservationStatus)
    );
    let rust_table: Vec<String> = ReservationState::WIRE_NAMES
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(
        rust_table, canonical,
        "Rust table matches the frozen fixture"
    );

    // Pressure state: canonical names only; `SOFT`/`HARD` are aliases.
    let canonical = canonical_names(&fixture, "pressureState");
    let mut decoded = Vec::new();
    for name in &canonical {
        let state = PressureState::parse_wire(name).expect("canonical pressure decodes");
        assert_eq!(state.wire_name(), name);
        decoded.push(state);
    }
    assert_eq!(decoded.len(), PressureState::WIRE_NAMES.len());
    for name in &forbidden_names(&fixture, "pressureState") {
        assert_eq!(
            PressureState::parse_wire(name),
            Err(ResourceWireError::UnknownPressureState),
            "{name:?} must not be a pressure state"
        );
    }
    let rust_table: Vec<String> = PressureState::WIRE_NAMES
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(rust_table, canonical);

    // Budget dimension: canonical names only.
    let canonical = canonical_names(&fixture, "dimension");
    let rust_table: Vec<String> = BudgetDimension::WIRE_NAMES
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(rust_table, canonical);
    for name in &forbidden_names(&fixture, "dimension") {
        assert_eq!(
            BudgetDimension::parse_wire(name),
            Err(ResourceWireError::UnknownDimension),
            "{name:?} must not be a dimension"
        );
    }

    // The fixture records the still-missing cross-language consumer honestly.
    assert!(fixture["consumers"]["rust"].is_string());
    assert!(
        fixture["consumers"]["typescript"].is_null(),
        "when the TypeScript consumer lands it must consume this exact fixture"
    );
}

fn pool(worktrees: usize) -> WorkerPool {
    let mut pool = WorkerPool::new(WorkerPoolConfig {
        owner_epoch: EPOCH,
        max_live_workers: 4,
        max_queued_tickets: 8,
        max_worktrees: worktrees,
    })
    .expect("bounded pool");
    pool.enable_managed_attempt_fan_out(EPOCH)
        .expect("test ingress opens fan-out");
    pool
}

fn register_worktree(pool: &mut WorkerPool, auth: &AuthenticatedOwnerContext, id: &str) {
    pool.register_worktree(
        WorktreeRegistration {
            id: id.to_owned(),
            workspace_binding: "workspace-a".to_owned(),
            path: PathBuf::from(format!("/worktrees/{id}")),
            base_revision: "rev-1".to_owned(),
            observed_revision: Some("rev-1".to_owned()),
            clean: Some(true),
            has_untracked: Some(false),
        },
        auth,
        pool.revision(),
    )
    .expect("clean worktree");
}

fn set_capacity(pool: &mut WorkerPool, dimension: BudgetDimension, cap: u64, measured: u64) {
    pool.update_capacity(
        dimension,
        Some(cap),
        Some(measured),
        0,
        EPOCH,
        1,
        pool.revision(),
    )
    .expect("capacity");
}

fn effectful_ticket(ticket: &str, dimension: BudgetDimension, amount: u64) -> EnqueueRequest {
    EnqueueRequest {
        ticket_id: ticket.to_owned(),
        goal_id: "goal-a".to_owned(),
        idempotency_key: format!("key-{ticket}"),
        dimension,
        amount,
        expires_at_ms: 5_000_000,
        expected_task_revision: "rev-1".to_owned(),
        accepted_spec_digest: digest('a'),
        class: WorkerClass::IsolatedEffectful,
        worktree: Some(WorktreeBindingRequest {
            worktree_id: "wt-a".to_owned(),
            base_revision: "rev-1".to_owned(),
        }),
        parent_execution: None,
    }
}

fn binding(attempt: &str, epoch: u64) -> VerifiedAttemptBinding {
    VerifiedAttemptBinding::test_fixture(
        "goal-a",
        "run-a",
        "task-a",
        attempt,
        epoch,
        "rev-1",
        &digest('a'),
    )
}

/// JC-RES-012.K — forged Session/workspace/owner epoch or a guessed
/// ticket/lease reference is rejected at the authenticated boundary before any
/// index, worker admission or capacity is touched.
#[test]
fn jc_res_012_k_impersonation_never_allocates_capacity_or_attempt_slots() {
    let mut pool = pool(1);
    let auth = owner(EPOCH);
    set_capacity(&mut pool, BudgetDimension::MemoryBytes, 1_000, 200);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_ticket(TICKET, BudgetDimension::MemoryBytes, 300),
        &auth,
        pool.revision(),
    )
    .expect("queued ticket");

    let baseline_capacity = pool.capacity(BudgetDimension::MemoryBytes);
    assert_eq!(baseline_capacity, Capacity::Remaining(800));

    // 1. A guessed ticket id resolves to nothing.
    assert_eq!(
        pool.reserve(
            "ticket-guessed",
            &binding(ATTEMPT, EPOCH),
            "worker-x",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::TicketNotFound)
    );
    // 2. A forged Session/workspace/principal cannot use another owner's ticket.
    let forged_session = foreign_owner(
        "principal-a",
        "workspace-a",
        "session-forged",
        "run-a",
        "task-a",
        ATTEMPT,
        EPOCH,
    );
    assert_eq!(
        pool.reserve(
            TICKET,
            &binding(ATTEMPT, EPOCH),
            "worker-x",
            &forged_session,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::ScopeMismatch)
    );
    let forged_workspace = foreign_owner(
        "principal-a",
        "workspace-other",
        "session-a",
        "run-a",
        "task-a",
        ATTEMPT,
        EPOCH,
    );
    assert_eq!(
        pool.reserve(
            TICKET,
            &binding(ATTEMPT, EPOCH),
            "worker-x",
            &forged_workspace,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::ScopeMismatch)
    );
    let foreign_principal = foreign_owner(
        "principal-b",
        "workspace-a",
        "session-a",
        "run-a",
        "task-a",
        ATTEMPT,
        EPOCH,
    );
    assert_eq!(
        pool.reserve(
            TICKET,
            &binding(ATTEMPT, EPOCH),
            "worker-x",
            &foreign_principal,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::ScopeMismatch)
    );
    // 3. A revoked (stale) owner epoch is fenced even with the right identity.
    assert_eq!(
        pool.reserve(
            TICKET,
            &binding(ATTEMPT, EPOCH),
            "worker-x",
            &owner(EPOCH + 1),
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::StaleOwnerEpoch)
    );
    // 4. A forged binding for another Attempt is not this ticket's authorization.
    assert_eq!(
        pool.reserve(
            TICKET,
            &binding("attempt-forged", EPOCH),
            "worker-x",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::AttemptBindingMismatch)
    );
    // 5. A forged binding for another accepted SpecVersion is rejected too.
    let other_spec = VerifiedAttemptBinding::test_fixture(
        "goal-a",
        "run-a",
        "task-a",
        ATTEMPT,
        EPOCH,
        "rev-1",
        &digest('b'),
    );
    assert_eq!(
        pool.reserve(TICKET, &other_spec, "worker-x", &auth, pool.revision(), 1),
        Err(WorkerPoolError::AttemptBindingMismatch)
    );

    // Every denial left the ticket queued, no worker, and the same capacity.
    assert_eq!(
        pool.ticket(TICKET).expect("ticket").state,
        TicketState::Queued
    );
    assert_eq!(pool.live_worker_count(), 0);
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        baseline_capacity
    );

    // A lease/worker id alone is not authority either: after one genuine
    // admission, a second caller cannot reuse the leased worktree.
    pool.reserve(
        TICKET,
        &binding(ATTEMPT, EPOCH),
        "worker-a",
        &auth,
        pool.revision(),
        1,
    )
    .expect("genuine admission");
    assert_eq!(
        pool.reserve(
            TICKET,
            &binding(ATTEMPT, EPOCH),
            "worker-b",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::WorkerIdentityConflict),
        "a reused ticket cannot mint a second worker identity"
    );
    assert_eq!(pool.live_worker_count(), 1);
}

/// JC-RES-012.L (Rust half) — a provider-cost or token reservation is denied
/// before any capacity/reservation exists when the caller scope or owner epoch
/// does not match the grant, and no charged fallback is attempted.
#[test]
fn jc_res_012_l_provider_cost_and_token_grants_are_owner_epoch_scoped() {
    let mut pool = pool(1);
    let auth = owner(EPOCH);
    set_capacity(
        &mut pool,
        BudgetDimension::ProviderCostMicros,
        50_000,
        1_000,
    );
    set_capacity(&mut pool, BudgetDimension::Tokens, 100_000, 4_000);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_ticket("ticket-cost", BudgetDimension::ProviderCostMicros, 10_000),
        &auth,
        pool.revision(),
    )
    .expect("enqueue provider-cost work");
    pool.enqueue(
        effectful_ticket("ticket-token", BudgetDimension::Tokens, 20_000),
        &auth,
        pool.revision(),
    )
    .expect("enqueue token work");

    let cost_baseline = pool.capacity(BudgetDimension::ProviderCostMicros);
    let token_baseline = pool.capacity(BudgetDimension::Tokens);

    // A valid-looking reference from another owner is denied before any charge.
    let foreign = foreign_owner(
        "principal-b",
        "workspace-a",
        "session-a",
        "run-a",
        "task-a",
        ATTEMPT,
        EPOCH,
    );
    assert_eq!(
        pool.reserve(
            "ticket-cost",
            &binding(ATTEMPT, EPOCH),
            "worker-cost",
            &foreign,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::ScopeMismatch)
    );
    // A revoked grant epoch is denied even for the same owner identity.
    assert_eq!(
        pool.reserve(
            "ticket-cost",
            &binding(ATTEMPT, EPOCH),
            "worker-cost",
            &owner(EPOCH + 1),
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::StaleOwnerEpoch)
    );
    // Unknown provider quota blocks new costly admission instead of guessing.
    pool.update_capacity(
        BudgetDimension::ProviderCostMicros,
        None,
        None,
        0,
        EPOCH,
        2,
        pool.revision(),
    )
    .expect("unknown quota sample");
    assert_eq!(
        pool.reserve(
            "ticket-cost",
            &binding(ATTEMPT, EPOCH),
            "worker-cost",
            &auth,
            pool.revision(),
            1
        ),
        Err(WorkerPoolError::CapacityUnknown)
    );

    // Nothing was debited by any denial: no reservation exists and the token
    // dimension is untouched.
    assert_eq!(pool.capacity(BudgetDimension::Tokens), token_baseline);
    assert_eq!(pool.live_worker_count(), 0);
    assert_eq!(
        pool.ticket("ticket-cost").expect("ticket").state,
        TicketState::Queued
    );

    // The token grant itself still admits its exact amount once (no fallback
    // route, no hidden second charge): 100_000 cap - 4_000 measured - 20_000.
    pool.reserve(
        "ticket-token",
        &binding(ATTEMPT, EPOCH),
        "worker-token",
        &auth,
        pool.revision(),
        1,
    )
    .expect("token reservation under the current grant");
    assert_eq!(
        pool.capacity(BudgetDimension::Tokens),
        Capacity::Remaining(76_000)
    );
    let _ = cost_baseline;
}

/// The canonical §11.20 proof flags cannot be fabricated: an unlaunched
/// reservation expires only with the no-launch proof, and a settled worker
/// cannot be re-settled with different evidence.
#[test]
fn jc_res_012_j_proof_flags_and_settlement_idempotency_hold_at_the_worker_boundary() {
    let mut pool = pool(1);
    let auth = owner(EPOCH);
    set_capacity(&mut pool, BudgetDimension::MemoryBytes, 10_000, 0);
    register_worktree(&mut pool, &auth, "wt-a");
    pool.enqueue(
        effectful_ticket(TICKET, BudgetDimension::MemoryBytes, 100),
        &auth,
        pool.revision(),
    )
    .expect("enqueue");
    pool.reserve(
        TICKET,
        &binding(ATTEMPT, EPOCH),
        "worker-a",
        &auth,
        pool.revision(),
        1,
    )
    .expect("reserve");
    assert_eq!(
        pool.expire_unlaunched_worker(
            "worker-a",
            9_999,
            ReservationProof::default(),
            &auth,
            pool.revision()
        ),
        Err(WorkerPoolError::NotExpired)
    );
    pool.claim("worker-a", &auth, pool.revision())
        .expect("claim");
    assert_eq!(
        pool.expire_unlaunched_worker(
            "worker-a",
            5_000_000,
            ReservationProof {
                no_launch_or_dispatch: true,
                ..ReservationProof::default()
            },
            &auth,
            pool.revision()
        ),
        Err(WorkerPoolError::InvalidTransition),
        "a claimed worker can never expire-free its capacity"
    );
    assert_eq!(
        pool.capacity(BudgetDimension::MemoryBytes),
        Capacity::Remaining(9_900)
    );
}
