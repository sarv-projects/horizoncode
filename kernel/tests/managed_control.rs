#![cfg(target_os = "linux")]

use horizoncode_kernel::managed_control::{AttemptPhase, ManagedCommand, ManagedControl, ManagedError, RunPhase};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct PrivateRoot(PathBuf);
impl PrivateRoot {
    fn new() -> Self {
        let tick = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!(
            "horizon-managed-{}-{tick}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path { &self.0 }
}
impl Drop for PrivateRoot {
    fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); }
}

fn sha(seed: char) -> String { format!("sha256:{}", seed.to_string().repeat(64)) }

fn send(store: &mut ManagedControl, delivery: &str, command: ManagedCommand) {
    let rev = store.snapshot().revision;
    store.apply(rev, delivery, command).unwrap();
}

fn accepted_run(store: &mut ManagedControl) {
    send(store, "goal1", ManagedCommand::CreateGoal { objective_digest: sha('a') });
    send(store, "spec1", ManagedCommand::ProposeSpec {
        spec_id: "spec-v1".into(), digest: sha('b'), criteria: vec!["tests-pass".into()],
    });
    send(store, "approval1", ManagedCommand::AcceptSpec { spec_id: "spec-v1".into() });
    send(store, "run1", ManagedCommand::StartRun {
        run_id: "run-v1".into(), spec_id: "spec-v1".into(),
    });
}

#[test]
fn run_requires_accepted_immutable_spec_and_revision_fence() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-example").unwrap();
    send(&mut store, "goal1", ManagedCommand::CreateGoal { objective_digest: sha('a') });
    let unapproved = ManagedCommand::StartRun { run_id: "r1".into(), spec_id: "s1".into() };
    assert!(matches!(store.apply(store.snapshot().revision, "bad1", unapproved), Err(ManagedError::Conflict(_))));
    send(&mut store, "spec1", ManagedCommand::ProposeSpec {
        spec_id: "s1".into(), digest: sha('b'), criteria: vec!["criterion-1".into()],
    });
    assert!(store.apply(0, "stale", ManagedCommand::AcceptSpec { spec_id: "s1".into() }).is_err());
    assert!(store.apply(store.snapshot().revision, "bad2", ManagedCommand::StartRun {
        run_id: "r1".into(), spec_id: "s1".into(),
    }).is_err());
    send(&mut store, "approve", ManagedCommand::AcceptSpec { spec_id: "s1".into() });
    send(&mut store, "run", ManagedCommand::StartRun {
        run_id: "r1".into(), spec_id: "s1".into(),
    });
    assert!(store.snapshot().specs["s1"].accepted);
    assert_eq!(store.snapshot().runs["r1"].phase, RunPhase::Running);
    assert!(store.apply(store.snapshot().revision, "approve-again", ManagedCommand::AcceptSpec {
        spec_id: "s1".into(),
    }).is_err());
}

#[test]
fn idempotent_delivery_replays_same_command_without_duplicate_effects() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-idempotent").unwrap();
    let create = ManagedCommand::CreateGoal { objective_digest: sha('a') };
    send(&mut store, "once", create.clone());
    let rev = store.snapshot().revision;
    store.apply(0, "once", create).unwrap();
    assert_eq!(store.snapshot().revision, rev);
    assert!(matches!(
        store.apply(rev, "once", ManagedCommand::CreateGoal { objective_digest: sha('b') }),
        Err(ManagedError::Conflict(_))
    ));
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-idempotent").unwrap();
    restored.apply(0, "once", ManagedCommand::CreateGoal { objective_digest: sha('a') }).unwrap();
    assert_eq!(restored.snapshot().revision, rev);
}

#[test]
fn cancellation_fences_task_admission_durably_across_restart() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-cancel").unwrap();
    accepted_run(&mut store);
    send(&mut store, "task1", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-a".into(), dependencies: vec![],
    });
    send(&mut store, "ready", ManagedCommand::MarkTaskReady { run_id: "run-v1".into(), task_id: "task-a".into() });
    send(&mut store, "cancel", ManagedCommand::RequestCancel { run_id: "run-v1".into() });
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-cancel").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Cancelling);
    assert!(restored.apply(restored.snapshot().revision, "attempt", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "att1".into(),
    }).is_err());
    assert!(restored.apply(restored.snapshot().revision, "task2", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-b".into(), dependencies: vec![],
    }).is_err());
}

#[test]
fn unknown_attempt_blocks_retries_and_remains_unknown_after_replay() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-unknown").unwrap();
    accepted_run(&mut store);
    send(&mut store, "task", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-a".into(), dependencies: vec![],
    });
    send(&mut store, "ready", ManagedCommand::MarkTaskReady { run_id: "run-v1".into(), task_id: "task-a".into() });
    send(&mut store, "attempt", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-one".into(),
    });
    send(&mut store, "unknown", ManagedCommand::MarkAttemptUnknown {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-one".into(),
    });
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-unknown").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Reconciling);
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert_eq!(restored.snapshot().attempts["attempt-one"].phase, AttemptPhase::Unknown);
    assert!(restored.apply(restored.snapshot().revision, "retry", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-two".into(),
    }).is_err());
}

#[test]
fn unknown_attempt_during_pause_moves_run_to_reconciliation_and_blocks_resume() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-paused-unknown").unwrap();
    accepted_run(&mut store);
    send(&mut store, "task", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-a".into(), dependencies: vec![],
    });
    send(&mut store, "ready", ManagedCommand::MarkTaskReady {
        run_id: "run-v1".into(), task_id: "task-a".into(),
    });
    send(&mut store, "admit", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-one".into(),
    });
    send(&mut store, "pause", ManagedCommand::PauseRun { run_id: "run-v1".into() });
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Paused);
    send(&mut store, "unknown", ManagedCommand::MarkAttemptUnknown {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-one".into(),
    });
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Reconciling);
    assert!(store.apply(store.snapshot().revision, "resume-unsafe", ManagedCommand::ResumeRun {
        run_id: "run-v1".into(),
    }).is_err());
    drop(store);
    let restored = ManagedControl::open(root.path(), "goal-paused-unknown").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Reconciling);
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
}

#[test]
fn dependencies_are_not_claimed_passed_from_worker_or_model_output() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-deps").unwrap();
    accepted_run(&mut store);
    send(&mut store, "task-a", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-a".into(), dependencies: vec![],
    });
    send(&mut store, "task-b", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-b".into(), dependencies: vec!["task-a".into()],
    });
    assert!(store.apply(store.snapshot().revision, "unverified", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-b".into(), attempt_id: "att-b".into(),
    }).is_err());
    assert!(store.apply(store.snapshot().revision, "self-dep", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "cycle".into(), dependencies: vec!["cycle".into()],
    }).is_err());
}


#[test]
fn pause_is_a_durable_admission_fence_and_resume_restores_only_safe_work() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-paused").unwrap();
    accepted_run(&mut store);
    send(&mut store, "task", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-a".into(), dependencies: vec![],
    });
    send(&mut store, "ready", ManagedCommand::MarkTaskReady { run_id: "run-v1".into(), task_id: "task-a".into() });
    send(&mut store, "pause", ManagedCommand::PauseRun { run_id: "run-v1".into() });
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-paused").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Paused);
    assert!(restored.apply(restored.snapshot().revision, "blocked-attempt", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-one".into(),
    }).is_err());
    send(&mut restored, "resume", ManagedCommand::ResumeRun { run_id: "run-v1".into() });
    send(&mut restored, "attempt", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-one".into(),
    });
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Running);
}


#[test]
fn restarting_with_admitted_but_unsettled_attempt_fences_execution_as_unknown() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-crash").unwrap();
    accepted_run(&mut store);
    send(&mut store, "task", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-a".into(), dependencies: vec![],
    });
    send(&mut store, "ready", ManagedCommand::MarkTaskReady {
        run_id: "run-v1".into(), task_id: "task-a".into(),
    });
    send(&mut store, "attempt", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-one".into(),
    });
    drop(store); // Crash between task admission and any observed receipt.
    let mut restored = ManagedControl::open(root.path(), "goal-crash").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Reconciling);
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert_eq!(restored.snapshot().attempts["attempt-one"].phase, AttemptPhase::Unknown);
    assert!(restored.apply(restored.snapshot().revision, "new", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-two".into(),
    }).is_err());
    assert!(restored.apply(restored.snapshot().revision, "resume", ManagedCommand::ResumeRun {
        run_id: "run-v1".into(),
    }).is_err());
}


#[test]
fn verified_task_unblocks_dependency_but_run_requires_fresh_all_criteria_evidence() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-verified").unwrap();
    accepted_run(&mut store);
    send(&mut store, "task-a", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-a".into(), dependencies: vec![],
    });
    send(&mut store, "task-b", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-b".into(), dependencies: vec!["task-a".into()],
    });
    assert!(store.apply(store.snapshot().revision, "too-early", ManagedCommand::MarkTaskReady {
        run_id: "run-v1".into(), task_id: "task-b".into(),
    }).is_err());
    send(&mut store, "ready-a", ManagedCommand::MarkTaskReady { run_id: "run-v1".into(), task_id: "task-a".into() });
    send(&mut store, "attempt-a", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "a-1".into(),
    });
    send(&mut store, "verified-a", ManagedCommand::VerifyTask {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "a-1".into(),
        source_revision: sha('a'), evidence_digest: sha('c'),
    });
    send(&mut store, "ready-b", ManagedCommand::MarkTaskReady { run_id: "run-v1".into(), task_id: "task-b".into() });
    send(&mut store, "attempt-b", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-b".into(), attempt_id: "b-1".into(),
    });
    assert!(store.apply(store.snapshot().revision, "verify-running", ManagedCommand::BeginVerification {
        run_id: "run-v1".into(), final_revision: sha('b'),
    }).is_err());
    send(&mut store, "verified-b", ManagedCommand::VerifyTask {
        run_id: "run-v1".into(), task_id: "task-b".into(), attempt_id: "b-1".into(),
        source_revision: sha('b'), evidence_digest: sha('d'),
    });
    send(&mut store, "verifying", ManagedCommand::BeginVerification {
        run_id: "run-v1".into(), final_revision: sha('b'),
    });
    assert!(store.apply(store.snapshot().revision, "premature", ManagedCommand::FinalizeRun {
        run_id: "run-v1".into(), final_revision: sha('b'),
    }).is_err());
    assert!(store.apply(store.snapshot().revision, "stale-proof", ManagedCommand::RecordCriterionEvidence {
        run_id: "run-v1".into(), criterion_id: "tests-pass".into(),
        source_revision: sha('a'), evidence_digest: sha('d'), verifier_id: "rust-test-runner".into(),
    }).is_err());
    send(&mut store, "fresh-proof", ManagedCommand::RecordCriterionEvidence {
        run_id: "run-v1".into(), criterion_id: "tests-pass".into(),
        source_revision: sha('b'), evidence_digest: sha('d'), verifier_id: "rust-test-runner".into(),
    });
    assert!(store.apply(store.snapshot().revision, "wrong-final", ManagedCommand::FinalizeRun {
        run_id: "run-v1".into(), final_revision: sha('a'),
    }).is_err());
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-verified").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Verifying);
    send(&mut restored, "final", ManagedCommand::FinalizeRun {
        run_id: "run-v1".into(), final_revision: sha('b'),
    });
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Succeeded);
    assert_eq!(restored.snapshot().attempts["a-1"].phase, AttemptPhase::Verified);
    assert_eq!(restored.snapshot().attempts["b-1"].phase, AttemptPhase::Verified);
    assert!(restored.apply(restored.snapshot().revision, "late-cancel", ManagedCommand::RequestCancel {
        run_id: "run-v1".into(),
    }).is_err());
}

#[test]
fn a_run_with_unsettled_unknown_attempt_cannot_enter_verification() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-verify-unknown").unwrap();
    accepted_run(&mut store);
    send(&mut store, "task", ManagedCommand::AddTask {
        run_id: "run-v1".into(), task_id: "task-a".into(), dependencies: vec![],
    });
    send(&mut store, "ready", ManagedCommand::MarkTaskReady { run_id: "run-v1".into(), task_id: "task-a".into() });
    send(&mut store, "attempt", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "a-1".into(),
    });
    send(&mut store, "unknown", ManagedCommand::MarkAttemptUnknown {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "a-1".into(),
    });
    assert!(store.apply(store.snapshot().revision, "bad-verification", ManagedCommand::BeginVerification {
        run_id: "run-v1".into(), final_revision: sha('a'),
    }).is_err());
}
