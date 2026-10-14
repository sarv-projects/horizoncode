#![cfg(target_os = "linux")]

use horizoncode_kernel::managed_control::{ManagedCommand, ManagedControl, ManagedError, RunPhase};
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
    assert!(restored.apply(restored.snapshot().revision, "retry", ManagedCommand::AdmitAttempt {
        run_id: "run-v1".into(), task_id: "task-a".into(), attempt_id: "attempt-two".into(),
    }).is_err());
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
