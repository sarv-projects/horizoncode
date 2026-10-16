#![cfg(target_os = "linux")]

use horizoncode_kernel::managed_control::{
    AcceptanceCriterion, AttemptPhase, GoalDraft, ManagedCommand, ManagedControl, ManagedError,
    RunPhase, SessionLink, SpecBudget, SpecVersionDraft,
};
use horizoncode_kernel::protocol::CursorV1;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct PrivateRoot(PathBuf);
impl PrivateRoot {
    fn new() -> Self {
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "horizon-managed-{}-{tick}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for PrivateRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn sha(seed: char) -> String {
    format!("sha256:{}", seed.to_string().repeat(64))
}

fn goal() -> GoalDraft {
    GoalDraft {
        objective: "Complete the managed task".into(),
        project_ref: "project-one".into(),
        workspace_ref: "workspace-one".into(),
        created_by: "server_auth.author".into(),
    }
}

fn spec(proposed_by: &str, max_attempts_per_task: u16) -> SpecVersionDraft {
    SpecVersionDraft {
        parent_version_id: None,
        objective: "Complete the managed task without changing unrelated files".into(),
        project_ref: "project-one".into(),
        workspace_ref: "workspace-one".into(),
        scope: vec!["kernel/src/**".into()],
        constraints: vec!["Preserve user-owned changes".into()],
        criteria: vec![AcceptanceCriterion {
            id: "tests-pass".into(),
            description: "The focused Rust tests pass".into(),
        }],
        budget: SpecBudget {
            max_tasks: 8,
            max_attempts_per_task,
            max_run_duration_ms: 60_000,
            max_memory_bytes: Some(1_073_741_824),
            max_disk_bytes: Some(2_147_483_648),
            max_workers: 1,
            max_tokens: Some(20_000),
            max_cost_micros: Some(0),
        },
        source_digests: vec![sha('a')],
        proposed_by: proposed_by.into(),
    }
}

fn send(store: &mut ManagedControl, delivery: &str, command: ManagedCommand) {
    let rev = store.snapshot().revision;
    store.apply(rev, delivery, command).unwrap();
}

fn accepted_run(store: &mut ManagedControl) {
    send(store, "goal1", ManagedCommand::CreateGoal { goal: goal() });
    let spec = spec("server_auth.author", 2);
    let spec_digest = spec.digest();
    send(
        store,
        "spec1",
        ManagedCommand::ProposeSpec {
            spec_id: "spec-v1".into(),
            spec,
            spec_digest: spec_digest.clone(),
        },
    );
    send(
        store,
        "approval1",
        ManagedCommand::AcceptSpec {
            spec_id: "spec-v1".into(),
            spec_digest,
            accepted_by: "server_auth.reviewer".into(),
            accepted_at_ms: 1,
        },
    );
    send(
        store,
        "run1",
        ManagedCommand::StartRun {
            run_id: "run-v1".into(),
            spec_id: "spec-v1".into(),
        },
    );
}

#[test]
fn run_requires_accepted_immutable_spec_and_revision_fence() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-example").unwrap();
    send(
        &mut store,
        "goal1",
        ManagedCommand::CreateGoal { goal: goal() },
    );
    let unapproved = ManagedCommand::StartRun {
        run_id: "r1".into(),
        spec_id: "s1".into(),
    };
    assert!(matches!(
        store.apply(store.snapshot().revision, "bad1", unapproved),
        Err(ManagedError::Conflict(_))
    ));
    let draft = spec("server_auth.author", 2);
    let spec_digest = draft.digest();
    send(
        &mut store,
        "spec1",
        ManagedCommand::ProposeSpec {
            spec_id: "s1".into(),
            spec: draft,
            spec_digest: spec_digest.clone(),
        },
    );
    assert!(
        store
            .apply(
                0,
                "stale",
                ManagedCommand::AcceptSpec {
                    spec_id: "s1".into(),
                    spec_digest: spec_digest.clone(),
                    accepted_by: "server_auth.reviewer".into(),
                    accepted_at_ms: 1,
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "bad2",
                ManagedCommand::StartRun {
                    run_id: "r1".into(),
                    spec_id: "s1".into(),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "approve",
        ManagedCommand::AcceptSpec {
            spec_id: "s1".into(),
            spec_digest: spec_digest.clone(),
            accepted_by: "server_auth.reviewer".into(),
            accepted_at_ms: 2,
        },
    );
    send(
        &mut store,
        "run",
        ManagedCommand::StartRun {
            run_id: "r1".into(),
            spec_id: "s1".into(),
        },
    );
    assert!(store.snapshot().specs["s1"].accepted);
    assert_eq!(store.snapshot().runs["r1"].phase, RunPhase::Running);
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "approve-again",
                ManagedCommand::AcceptSpec {
                    spec_id: "s1".into(),
                    spec_digest,
                    accepted_by: "server_auth.reviewer".into(),
                    accepted_at_ms: 3,
                }
            )
            .is_err()
    );
}

#[test]
fn full_spec_digest_and_acceptance_are_bound_to_distinct_review_identity() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-full-spec").unwrap();
    send(
        &mut store,
        "goal",
        ManagedCommand::CreateGoal { goal: goal() },
    );

    let draft = spec("server_auth.author", 2);
    let spec_digest = draft.digest();
    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "forged-spec-digest",
            ManagedCommand::ProposeSpec {
                spec_id: "spec-v1".into(),
                spec: draft.clone(),
                spec_digest: format!("blake3:{}", "f".repeat(64)),
            }
        ),
        Err(ManagedError::Invalid(_))
    ));
    send(
        &mut store,
        "propose",
        ManagedCommand::ProposeSpec {
            spec_id: "spec-v1".into(),
            spec: draft.clone(),
            spec_digest: spec_digest.clone(),
        },
    );

    assert!(
        store
            .apply(
                store.snapshot().revision,
                "wrong-acceptance-digest",
                ManagedCommand::AcceptSpec {
                    spec_id: "spec-v1".into(),
                    spec_digest: format!("blake3:{}", "e".repeat(64)),
                    accepted_by: "server_auth.reviewer".into(),
                    accepted_at_ms: 10,
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "self-approval",
                ManagedCommand::AcceptSpec {
                    spec_id: "spec-v1".into(),
                    spec_digest: spec_digest.clone(),
                    accepted_by: "server_auth.author".into(),
                    accepted_at_ms: 10,
                }
            )
            .is_err()
    );

    send(
        &mut store,
        "accept",
        ManagedCommand::AcceptSpec {
            spec_id: "spec-v1".into(),
            spec_digest: spec_digest.clone(),
            accepted_by: "server_auth.reviewer".into(),
            accepted_at_ms: 11,
        },
    );
    let accepted = &store.snapshot().specs["spec-v1"];
    assert!(accepted.accepted);
    assert_eq!(accepted.digest, spec_digest);
    assert_eq!(
        accepted.accepted_by.as_deref(),
        Some("server_auth.reviewer")
    );
    assert_eq!(accepted.accepted_at_ms, Some(11));
    assert_eq!(accepted.content.objective, draft.objective);
    assert_eq!(accepted.content.scope, draft.scope);
    assert_eq!(accepted.content.constraints, draft.constraints);
    assert_eq!(accepted.content.criteria, draft.criteria);
    assert_eq!(accepted.content.budget, draft.budget);
    assert_eq!(accepted.content.source_digests, draft.source_digests);
}

#[test]
fn session_link_replay_preserves_only_bounded_correlation_metadata() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-session-link").unwrap();
    accepted_run(&mut store);
    let link = SessionLink {
        session_id: "ses-source".into(),
        source_store_id: "store-one".into(),
        source_instance_id: "instance-one".into(),
        source_cursor: CursorV1 {
            owner_kind: "session".into(),
            owner_id: "ses-source".into(),
            seq: "7".into(),
            event_digest: format!("blake3:{}", "a".repeat(64)),
        },
        source_epoch: 3,
        latest_observed_message_id: Some("msg-latest".into()),
        latest_observed_part_id: Some("part-latest".into()),
        source_digest: sha('c'),
        redaction_profile: "session-redacted-v1".into(),
        owner_epoch: 9,
        protocol_version: 1,
    };
    send(
        &mut store,
        "link-session",
        ManagedCommand::AttachSessionLink {
            run_id: "run-v1".into(),
            link: link.clone(),
        },
    );
    // A Run has exactly one SessionLink: rebinding or replacing it fails closed.
    let mut other_link = link.clone();
    other_link.session_id = "ses-other".into();
    other_link.source_cursor.owner_id = "ses-other".into();
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "link-rebind",
                ManagedCommand::AttachSessionLink {
                    run_id: "run-v1".into(),
                    link: other_link.clone(),
                }
            )
            .is_err()
    );
    // A non-running Run cannot attach or rebind a SessionLink either.
    send(
        &mut store,
        "pause-linked-run",
        ManagedCommand::PauseRun {
            run_id: "run-v1".into(),
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "link-paused",
                ManagedCommand::AttachSessionLink {
                    run_id: "run-v1".into(),
                    link: other_link,
                }
            )
            .is_err()
    );
    assert_eq!(
        store.snapshot().runs["run-v1"].session_link,
        Some(link.clone())
    );
    drop(store);

    let restored = ManagedControl::open(root.path(), "goal-session-link").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].session_link, Some(link));
}

#[test]
fn retry_exhaustion_fences_attempt_admission_and_requires_user() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-retries").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec!["tests-pass".into()],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "fail-one",
        ManagedCommand::FailAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            failure_code: "validation-failed".into(),
            retryable: true,
        },
    );
    assert_eq!(
        store.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Failed
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Running);

    send(
        &mut store,
        "attempt-two",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-two".into(),
        },
    );
    send(
        &mut store,
        "fail-two",
        ManagedCommand::FailAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-two".into(),
            failure_code: "validation-failed".into(),
            retryable: true,
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::NeedsYou);
    assert!(
        store.snapshot().runs["run-v1"].tasks["task-a"]
            .active_attempt
            .is_none()
    );
    assert!(!store.snapshot().runs["run-v1"].tasks["task-a"].ready);
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "attempt-three",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-three".into(),
                }
            )
            .is_err()
    );
    drop(store);

    let restored = ManagedControl::open(root.path(), "goal-retries").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::NeedsYou);
    assert_eq!(
        restored.snapshot().attempts["attempt-two"].phase,
        AttemptPhase::Failed
    );
    assert_eq!(
        restored.snapshot().attempts["attempt-two"]
            .failure_code
            .as_deref(),
        Some("validation-failed")
    );
    assert_eq!(
        restored.snapshot().attempts["attempt-two"].retryable,
        Some(true)
    );
}

#[test]
fn new_final_revision_invalidates_previous_verification_evidence() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-manual-edit").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec!["tests-pass".into()],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "verified-task",
        ManagedCommand::VerifyTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            source_revision: sha('a'),
            evidence_digest: sha('d'),
        },
    );
    send(
        &mut store,
        "verify-revision-a",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('a'),
        },
    );
    send(
        &mut store,
        "criterion-a",
        ManagedCommand::RecordCriterionEvidence {
            run_id: "run-v1".into(),
            criterion_id: "tests-pass".into(),
            source_revision: sha('a'),
            evidence_digest: sha('e'),
            verifier_id: "test-verifier".into(),
        },
    );

    // The trusted workspace observer reports a user edit before finalization.
    send(
        &mut store,
        "verify-revision-b",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('b'),
        },
    );
    assert!(
        store.snapshot().runs["run-v1"]
            .criterion_evidence
            .is_empty()
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "stale-criterion",
                ManagedCommand::RecordCriterionEvidence {
                    run_id: "run-v1".into(),
                    criterion_id: "tests-pass".into(),
                    source_revision: sha('a'),
                    evidence_digest: sha('f'),
                    verifier_id: "test-verifier".into(),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "stale-finalize",
                ManagedCommand::FinalizeRun {
                    run_id: "run-v1".into(),
                    final_revision: sha('b'),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "fresh-criterion-b",
        ManagedCommand::RecordCriterionEvidence {
            run_id: "run-v1".into(),
            criterion_id: "tests-pass".into(),
            source_revision: sha('b'),
            evidence_digest: sha('f'),
            verifier_id: "test-verifier".into(),
        },
    );
    send(
        &mut store,
        "final-b",
        ManagedCommand::FinalizeRun {
            run_id: "run-v1".into(),
            final_revision: sha('b'),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Succeeded);
}

#[test]
fn idempotent_delivery_replays_same_command_without_duplicate_effects() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-idempotent").unwrap();
    let create = ManagedCommand::CreateGoal { goal: goal() };
    send(&mut store, "once", create.clone());
    let rev = store.snapshot().revision;
    store.apply(0, "once", create).unwrap();
    assert_eq!(store.snapshot().revision, rev);
    assert!(matches!(
        store.apply(
            rev,
            "once",
            ManagedCommand::CreateGoal {
                goal: GoalDraft {
                    objective: "Different objective".into(),
                    ..goal()
                }
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-idempotent").unwrap();
    restored
        .apply(0, "once", ManagedCommand::CreateGoal { goal: goal() })
        .unwrap();
    assert_eq!(restored.snapshot().revision, rev);
}

#[test]
fn cancellation_fences_task_admission_durably_across_restart() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-cancel").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task1",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "cancel",
        ManagedCommand::RequestCancel {
            run_id: "run-v1".into(),
        },
    );
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-cancel").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Cancelling
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "attempt",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "att1".into(),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "task2",
                ManagedCommand::AddTask {
                    run_id: "run-v1".into(),
                    task_id: "task-b".into(),
                    dependencies: vec![],
                    criterion_ids: vec![],
                }
            )
            .is_err()
    );
}

#[test]
fn cancelling_run_preserves_unknown_attempt_and_cancel_fence_after_restart() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-cancel-unknown").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "cancel",
        ManagedCommand::RequestCancel {
            run_id: "run-v1".into(),
        },
    );
    send(
        &mut store,
        "unknown",
        ManagedCommand::MarkAttemptUnknown {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );

    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Cancelling);
    assert!(store.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert_eq!(
        store.snapshot().runs["run-v1"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-one")
    );
    assert_eq!(
        store.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Unknown
    );
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-cancel-unknown").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Cancelling
    );
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert_eq!(
        restored.snapshot().runs["run-v1"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-one")
    );
    assert_eq!(
        restored.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Unknown
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "unsafe-retry",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-two".into(),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "late-resume",
                ManagedCommand::ResumeRun {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
}

#[test]
fn unknown_attempt_blocks_retries_and_remains_unknown_after_replay() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-unknown").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "unknown",
        ManagedCommand::MarkAttemptUnknown {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-unknown").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Reconciling
    );
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert_eq!(
        restored.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Unknown
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "retry",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-two".into(),
                }
            )
            .is_err()
    );
}

#[test]
fn unknown_attempt_during_pause_moves_run_to_reconciliation_and_blocks_resume() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-paused-unknown").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "admit",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "pause",
        ManagedCommand::PauseRun {
            run_id: "run-v1".into(),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Paused);
    send(
        &mut store,
        "unknown",
        ManagedCommand::MarkAttemptUnknown {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Reconciling);
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "resume-unsafe",
                ManagedCommand::ResumeRun {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
    drop(store);
    let restored = ManagedControl::open(root.path(), "goal-paused-unknown").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Reconciling
    );
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
}

#[test]
fn dependencies_are_not_claimed_passed_from_worker_or_model_output() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-deps").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task-a",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "task-b",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            dependencies: vec!["task-a".into()],
            criterion_ids: vec![],
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "unverified",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-b".into(),
                    attempt_id: "att-b".into(),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "self-dep",
                ManagedCommand::AddTask {
                    run_id: "run-v1".into(),
                    task_id: "cycle".into(),
                    dependencies: vec!["cycle".into()],
                    criterion_ids: vec![],
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "unknown-criterion",
                ManagedCommand::AddTask {
                    run_id: "run-v1".into(),
                    task_id: "task-c".into(),
                    dependencies: vec![],
                    criterion_ids: vec!["not-in-spec".into()],
                }
            )
            .is_err()
    );
}

#[test]
fn spec_max_workers_caps_concurrent_attempt_admission() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-worker-cap").unwrap();
    accepted_run(&mut store);
    for task_id in ["task-a", "task-b"] {
        send(
            &mut store,
            &format!("propose-{task_id}"),
            ManagedCommand::AddTask {
                run_id: "run-v1".into(),
                task_id: task_id.into(),
                dependencies: vec![],
                criterion_ids: vec![],
            },
        );
        send(
            &mut store,
            &format!("ready-{task_id}"),
            ManagedCommand::MarkTaskReady {
                run_id: "run-v1".into(),
                task_id: task_id.into(),
            },
        );
    }
    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );

    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "attempt-two",
            ManagedCommand::AdmitAttempt {
                run_id: "run-v1".into(),
                task_id: "task-b".into(),
                attempt_id: "attempt-two".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));

    // A settled Attempt releases its worker slot for the next admission.
    send(
        &mut store,
        "fail-one",
        ManagedCommand::FailAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            failure_code: "transient".into(),
            retryable: true,
        },
    );
    send(
        &mut store,
        "attempt-two",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            attempt_id: "attempt-two".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-v1"].tasks["task-b"]
            .active_attempt
            .as_deref(),
        Some("attempt-two")
    );
}

#[test]
fn pause_is_a_durable_admission_fence_and_resume_restores_only_safe_work() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-paused").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "pause",
        ManagedCommand::PauseRun {
            run_id: "run-v1".into(),
        },
    );
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-paused").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Paused);
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "blocked-attempt",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                }
            )
            .is_err()
    );
    send(
        &mut restored,
        "resume",
        ManagedCommand::ResumeRun {
            run_id: "run-v1".into(),
        },
    );
    send(
        &mut restored,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Running);
}

#[test]
fn restarting_with_admitted_but_unsettled_attempt_fences_execution_as_unknown() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-crash").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    drop(store); // Crash between task admission and any observed receipt.
    let mut restored = ManagedControl::open(root.path(), "goal-crash").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Reconciling
    );
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert_eq!(
        restored.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Unknown
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "new",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-two".into(),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "resume",
                ManagedCommand::ResumeRun {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
}

#[test]
fn verified_task_unblocks_dependency_but_run_requires_fresh_all_criteria_evidence() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-verified").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task-a",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec!["tests-pass".into()],
        },
    );
    send(
        &mut store,
        "task-b",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            dependencies: vec!["task-a".into()],
            criterion_ids: vec![],
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "too-early",
                ManagedCommand::MarkTaskReady {
                    run_id: "run-v1".into(),
                    task_id: "task-b".into(),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "ready-a",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt-a",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "a-1".into(),
        },
    );
    send(
        &mut store,
        "verified-a",
        ManagedCommand::VerifyTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "a-1".into(),
            source_revision: sha('a'),
            evidence_digest: sha('c'),
        },
    );
    send(
        &mut store,
        "ready-b",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
        },
    );
    send(
        &mut store,
        "attempt-b",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            attempt_id: "b-1".into(),
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "verify-running",
                ManagedCommand::BeginVerification {
                    run_id: "run-v1".into(),
                    final_revision: sha('b'),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "verified-b",
        ManagedCommand::VerifyTask {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            attempt_id: "b-1".into(),
            source_revision: sha('b'),
            evidence_digest: sha('d'),
        },
    );
    send(
        &mut store,
        "verifying",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('b'),
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "premature",
                ManagedCommand::FinalizeRun {
                    run_id: "run-v1".into(),
                    final_revision: sha('b'),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "stale-proof",
                ManagedCommand::RecordCriterionEvidence {
                    run_id: "run-v1".into(),
                    criterion_id: "tests-pass".into(),
                    source_revision: sha('a'),
                    evidence_digest: sha('d'),
                    verifier_id: "rust-test-runner".into(),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "fresh-proof",
        ManagedCommand::RecordCriterionEvidence {
            run_id: "run-v1".into(),
            criterion_id: "tests-pass".into(),
            source_revision: sha('b'),
            evidence_digest: sha('d'),
            verifier_id: "rust-test-runner".into(),
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "wrong-final",
                ManagedCommand::FinalizeRun {
                    run_id: "run-v1".into(),
                    final_revision: sha('a'),
                }
            )
            .is_err()
    );
    drop(store);
    let mut restored = ManagedControl::open(root.path(), "goal-verified").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Verifying
    );
    send(
        &mut restored,
        "final",
        ManagedCommand::FinalizeRun {
            run_id: "run-v1".into(),
            final_revision: sha('b'),
        },
    );
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Succeeded
    );
    assert_eq!(
        restored.snapshot().attempts["a-1"].phase,
        AttemptPhase::Verified
    );
    assert_eq!(
        restored.snapshot().attempts["b-1"].phase,
        AttemptPhase::Verified
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "late-cancel",
                ManagedCommand::RequestCancel {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
}

#[test]
fn a_run_with_unsettled_unknown_attempt_cannot_enter_verification() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-verify-unknown").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "a-1".into(),
        },
    );
    send(
        &mut store,
        "unknown",
        ManagedCommand::MarkAttemptUnknown {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "a-1".into(),
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "bad-verification",
                ManagedCommand::BeginVerification {
                    run_id: "run-v1".into(),
                    final_revision: sha('a'),
                }
            )
            .is_err()
    );
}

#[test]
fn cancelling_run_unknown_attempt_cannot_settle_verify_or_finalize() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-cancel-settle").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "cancel",
        ManagedCommand::RequestCancel {
            run_id: "run-v1".into(),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Cancelling);

    // While the Attempt is still active, cancellation fences settlement and
    // every other mutation; failed commands must leave no trace.
    let revision = store.snapshot().revision;
    assert!(
        store
            .apply(
                revision,
                "fail-active-attempt",
                ManagedCommand::FailAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    failure_code: "worker-exit".into(),
                    retryable: false,
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "pause-cancelling",
                ManagedCommand::PauseRun {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "needs-you-cancelling",
                ManagedCommand::NeedsYou {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "cancel-again",
                ManagedCommand::RequestCancel {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
    assert_eq!(store.snapshot().revision, revision);
    assert_eq!(
        store.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Admitted
    );

    send(
        &mut store,
        "unknown",
        ManagedCommand::MarkAttemptUnknown {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    // CANCELLING remains the durable user-intent fence; the UNKNOWN Attempt
    // reconciles separately and cannot be settled here.
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Cancelling);
    assert!(store.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    let revision = store.snapshot().revision;
    assert!(
        store
            .apply(
                revision,
                "settle-unknown",
                ManagedCommand::FailAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    failure_code: "guessed".into(),
                    retryable: true,
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "verify-unknown",
                ManagedCommand::VerifyTask {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    source_revision: sha('a'),
                    evidence_digest: sha('d'),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "begin-verification",
                ManagedCommand::BeginVerification {
                    run_id: "run-v1".into(),
                    final_revision: sha('a'),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "finalize",
                ManagedCommand::FinalizeRun {
                    run_id: "run-v1".into(),
                    final_revision: sha('a'),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "resume",
                ManagedCommand::ResumeRun {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "mark-ready-again",
                ManagedCommand::MarkTaskReady {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "new-task",
                ManagedCommand::AddTask {
                    run_id: "run-v1".into(),
                    task_id: "task-b".into(),
                    dependencies: vec![],
                    criterion_ids: vec![],
                }
            )
            .is_err()
    );
    assert_eq!(store.snapshot().revision, revision);
    assert_eq!(
        store.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Unknown
    );
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-cancel-settle").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Cancelling
    );
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert_eq!(
        restored.snapshot().runs["run-v1"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-one")
    );
    let revision = restored.snapshot().revision;
    assert!(
        restored
            .apply(
                revision,
                "fail-after-restart",
                ManagedCommand::FailAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    failure_code: "guessed".into(),
                    retryable: true,
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                revision,
                "verify-after-restart",
                ManagedCommand::VerifyTask {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    source_revision: sha('a'),
                    evidence_digest: sha('d'),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                revision,
                "finalize-after-restart",
                ManagedCommand::FinalizeRun {
                    run_id: "run-v1".into(),
                    final_revision: sha('a'),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                revision,
                "resume-after-restart",
                ManagedCommand::ResumeRun {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
    assert_eq!(restored.snapshot().revision, revision);
    assert_eq!(
        restored.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Unknown
    );
}

#[test]
fn cancel_fence_matches_lifecycle_from_paused_verifying_and_needs_you() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-cancel-matrix").unwrap();
    accepted_run(&mut store);

    // PAUSED -> CANCELLING is a lifecycle transition; resume must not revive it.
    send(
        &mut store,
        "start-paused",
        ManagedCommand::StartRun {
            run_id: "run-paused".into(),
            spec_id: "spec-v1".into(),
        },
    );
    send(
        &mut store,
        "pause-paused",
        ManagedCommand::PauseRun {
            run_id: "run-paused".into(),
        },
    );
    send(
        &mut store,
        "cancel-paused",
        ManagedCommand::RequestCancel {
            run_id: "run-paused".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-paused"].phase,
        RunPhase::Cancelling
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "resume-paused",
                ManagedCommand::ResumeRun {
                    run_id: "run-paused".into(),
                }
            )
            .is_err()
    );

    // VERIFYING -> CANCELLING freezes criterion evidence and finalization.
    send(
        &mut store,
        "start-verifying",
        ManagedCommand::StartRun {
            run_id: "run-verifying".into(),
            spec_id: "spec-v1".into(),
        },
    );
    send(
        &mut store,
        "task-verifying",
        ManagedCommand::AddTask {
            run_id: "run-verifying".into(),
            task_id: "task-v".into(),
            dependencies: vec![],
            criterion_ids: vec!["tests-pass".into()],
        },
    );
    send(
        &mut store,
        "ready-verifying",
        ManagedCommand::MarkTaskReady {
            run_id: "run-verifying".into(),
            task_id: "task-v".into(),
        },
    );
    send(
        &mut store,
        "attempt-verifying",
        ManagedCommand::AdmitAttempt {
            run_id: "run-verifying".into(),
            task_id: "task-v".into(),
            attempt_id: "attempt-v".into(),
        },
    );
    send(
        &mut store,
        "pass-verifying",
        ManagedCommand::VerifyTask {
            run_id: "run-verifying".into(),
            task_id: "task-v".into(),
            attempt_id: "attempt-v".into(),
            source_revision: sha('a'),
            evidence_digest: sha('c'),
        },
    );
    send(
        &mut store,
        "begin-verifying",
        ManagedCommand::BeginVerification {
            run_id: "run-verifying".into(),
            final_revision: sha('a'),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-verifying"].phase,
        RunPhase::Verifying
    );
    send(
        &mut store,
        "cancel-verifying",
        ManagedCommand::RequestCancel {
            run_id: "run-verifying".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-verifying"].phase,
        RunPhase::Cancelling
    );
    let revision = store.snapshot().revision;
    assert!(
        store
            .apply(
                revision,
                "late-evidence",
                ManagedCommand::RecordCriterionEvidence {
                    run_id: "run-verifying".into(),
                    criterion_id: "tests-pass".into(),
                    source_revision: sha('a'),
                    evidence_digest: sha('d'),
                    verifier_id: "rust-test-runner".into(),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision,
                "late-finalize",
                ManagedCommand::FinalizeRun {
                    run_id: "run-verifying".into(),
                    final_revision: sha('a'),
                }
            )
            .is_err()
    );
    assert_eq!(store.snapshot().revision, revision);

    // NEEDS_YOU is a terminal outcome and cannot be cancelled.
    send(
        &mut store,
        "start-needs-you",
        ManagedCommand::StartRun {
            run_id: "run-needs-you".into(),
            spec_id: "spec-v1".into(),
        },
    );
    send(
        &mut store,
        "needs-you",
        ManagedCommand::NeedsYou {
            run_id: "run-needs-you".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-needs-you"].phase,
        RunPhase::NeedsYou
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "cancel-needs-you",
                ManagedCommand::RequestCancel {
                    run_id: "run-needs-you".into(),
                }
            )
            .is_err()
    );
    drop(store);

    let restored = ManagedControl::open(root.path(), "goal-cancel-matrix").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-paused"].phase,
        RunPhase::Cancelling
    );
    assert_eq!(
        restored.snapshot().runs["run-verifying"].phase,
        RunPhase::Cancelling
    );
    assert_eq!(
        restored.snapshot().runs["run-needs-you"].phase,
        RunPhase::NeedsYou
    );
    assert!(
        restored.snapshot().runs["run-verifying"]
            .criterion_evidence
            .is_empty()
    );
}

#[test]
fn stale_revision_invalid_delivery_and_reuse_fail_closed_without_mutation() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-delivery").unwrap();
    accepted_run(&mut store);
    let revision = store.snapshot().revision;

    // The expected revision must match the aggregate revision exactly.
    assert!(matches!(
        store.apply(
            revision + 1,
            "revision-ahead",
            ManagedCommand::PauseRun {
                run_id: "run-v1".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert!(matches!(
        store.apply(
            revision - 1,
            "revision-behind",
            ManagedCommand::PauseRun {
                run_id: "run-v1".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));

    // Delivery identifiers are bounded owner-log ids, not arbitrary strings.
    for forged in ["", "contains space", "contains/slash", "with#hash"] {
        assert!(matches!(
            store.apply(
                revision,
                forged,
                ManagedCommand::PauseRun {
                    run_id: "run-v1".into(),
                }
            ),
            Err(ManagedError::Invalid(_))
        ));
    }
    assert_eq!(store.snapshot().revision, revision);
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Running);

    send(
        &mut store,
        "pause-once",
        ManagedCommand::PauseRun {
            run_id: "run-v1".into(),
        },
    );
    let revision = store.snapshot().revision;
    // An exact logical retry is a successful no-op even with a stale expected
    // revision, because the aggregate must not advance twice for one command.
    store
        .apply(
            0,
            "pause-once",
            ManagedCommand::PauseRun {
                run_id: "run-v1".into(),
            },
        )
        .unwrap();
    assert_eq!(store.snapshot().revision, revision);
    // Reusing the idempotency key for a different command fails closed.
    assert!(matches!(
        store.apply(
            revision,
            "pause-once",
            ManagedCommand::ResumeRun {
                run_id: "run-v1".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Paused);
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-delivery").unwrap();
    assert_eq!(restored.snapshot().revision, revision);
    restored
        .apply(
            0,
            "pause-once",
            ManagedCommand::PauseRun {
                run_id: "run-v1".into(),
            },
        )
        .unwrap();
    assert_eq!(restored.snapshot().revision, revision);
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Paused);
}

#[test]
fn attempt_ids_are_global_and_settlement_requires_exact_ownership() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-ownership").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "second-run",
        ManagedCommand::StartRun {
            run_id: "run-v2".into(),
            spec_id: "spec-v1".into(),
        },
    );
    send(
        &mut store,
        "task-one",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready-one",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "task-two",
        ManagedCommand::AddTask {
            run_id: "run-v2".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready-two",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v2".into(),
            task_id: "task-a".into(),
        },
    );
    // Attempt identity is unique across the whole owner log, not per Run.
    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "reuse-attempt-id",
            ManagedCommand::AdmitAttempt {
                run_id: "run-v2".into(),
                task_id: "task-a".into(),
                attempt_id: "attempt-one".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    // A second Run has its own worker budget, so its admission succeeds.
    send(
        &mut store,
        "attempt-two",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v2".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-two".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-v2"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-two")
    );

    // Settlement must name the Task that owns the active Attempt.
    send(
        &mut store,
        "task-b",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready-b",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
        },
    );
    let revision = store.snapshot().revision;
    for (delivery, command) in [
        (
            "wrong-task-fail",
            ManagedCommand::FailAttempt {
                run_id: "run-v1".into(),
                task_id: "task-b".into(),
                attempt_id: "attempt-one".into(),
                failure_code: "worker-exit".into(),
                retryable: true,
            },
        ),
        (
            "wrong-task-unknown",
            ManagedCommand::MarkAttemptUnknown {
                run_id: "run-v1".into(),
                task_id: "task-b".into(),
                attempt_id: "attempt-one".into(),
            },
        ),
        (
            "wrong-task-verify",
            ManagedCommand::VerifyTask {
                run_id: "run-v1".into(),
                task_id: "task-b".into(),
                attempt_id: "attempt-one".into(),
                source_revision: sha('a'),
                evidence_digest: sha('d'),
            },
        ),
    ] {
        assert!(matches!(
            store.apply(revision, delivery, command),
            Err(ManagedError::Conflict(_))
        ));
    }
    // Cross-Run references never settle another Run's Attempt.
    assert!(matches!(
        store.apply(
            revision,
            "cross-run-verify",
            ManagedCommand::VerifyTask {
                run_id: "run-v2".into(),
                task_id: "task-a".into(),
                attempt_id: "attempt-one".into(),
                source_revision: sha('a'),
                evidence_digest: sha('d'),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert!(matches!(
        store.apply(
            revision,
            "cross-run-unknown",
            ManagedCommand::MarkAttemptUnknown {
                run_id: "run-v2".into(),
                task_id: "task-a".into(),
                attempt_id: "attempt-one".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert!(matches!(
        store.apply(
            revision,
            "cross-run-fail",
            ManagedCommand::FailAttempt {
                run_id: "run-v1".into(),
                task_id: "task-a".into(),
                attempt_id: "attempt-two".into(),
                failure_code: "worker-exit".into(),
                retryable: true,
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    // Rejected settlement leaves every record untouched.
    assert_eq!(store.snapshot().revision, revision);
    assert_eq!(
        store.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Admitted
    );
    assert_eq!(
        store.snapshot().attempts["attempt-two"].phase,
        AttemptPhase::Admitted
    );
    assert_eq!(
        store.snapshot().runs["run-v1"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-one")
    );
    assert_eq!(
        store.snapshot().runs["run-v2"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-two")
    );
}

#[test]
fn task_depending_on_unknown_effect_task_never_becomes_ready() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-unknown-dep").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task-a",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "task-b",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            dependencies: vec!["task-a".into()],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready-a",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    // A dependency is satisfied only by an independent PASS, never by presence.
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "early-ready-b",
                ManagedCommand::MarkTaskReady {
                    run_id: "run-v1".into(),
                    task_id: "task-b".into(),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "attempt-a",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "active-ready-b",
                ManagedCommand::MarkTaskReady {
                    run_id: "run-v1".into(),
                    task_id: "task-b".into(),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "unknown-a",
        ManagedCommand::MarkAttemptUnknown {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Reconciling);
    assert!(store.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert!(!store.snapshot().runs["run-v1"].tasks["task-b"].ready);
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "ready-b-after-unknown",
                ManagedCommand::MarkTaskReady {
                    run_id: "run-v1".into(),
                    task_id: "task-b".into(),
                }
            )
            .is_err()
    );
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-unknown-dep").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Reconciling
    );
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert!(!restored.snapshot().runs["run-v1"].tasks["task-b"].ready);
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "ready-b-after-restart",
                ManagedCommand::MarkTaskReady {
                    run_id: "run-v1".into(),
                    task_id: "task-b".into(),
                }
            )
            .is_err()
    );

    // Cancelling during reconciliation keeps the UNKNOWN Attempt and its worker
    // slot fenced; nothing here may settle or re-admit it.
    send(
        &mut restored,
        "cancel-reconciling",
        ManagedCommand::RequestCancel {
            run_id: "run-v1".into(),
        },
    );
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Cancelling
    );
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert_eq!(
        restored.snapshot().runs["run-v1"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-one")
    );
    let revision = restored.snapshot().revision;
    assert!(
        restored
            .apply(
                revision,
                "admit-b-after-cancel",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-b".into(),
                    attempt_id: "attempt-two".into(),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                revision,
                "resume-after-cancel",
                ManagedCommand::ResumeRun {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                revision,
                "settle-after-cancel",
                ManagedCommand::FailAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    failure_code: "guessed".into(),
                    retryable: true,
                }
            )
            .is_err()
    );
    assert_eq!(restored.snapshot().revision, revision);
}

#[test]
fn derived_spec_requires_accepted_parent_and_activation_is_explicit() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-spec-graph").unwrap();
    send(
        &mut store,
        "goal",
        ManagedCommand::CreateGoal { goal: goal() },
    );

    // A parent SpecVersion must already be accepted.
    let v1_draft = spec("server_auth.author", 2);
    let v1_digest = v1_draft.digest();
    send(
        &mut store,
        "v1-propose",
        ManagedCommand::ProposeSpec {
            spec_id: "spec-v1".into(),
            spec: v1_draft,
            spec_digest: v1_digest.clone(),
        },
    );
    let mut derived = spec("server_auth.author", 2);
    derived.parent_version_id = Some("spec-v1".into());
    derived.objective = "Follow-up managed task".into();
    let derived_digest = derived.digest();
    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "derived-before-accept",
            ManagedCommand::ProposeSpec {
                spec_id: "spec-v2".into(),
                spec: derived.clone(),
                spec_digest: derived_digest.clone(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    send(
        &mut store,
        "v1-accept",
        ManagedCommand::AcceptSpec {
            spec_id: "spec-v1".into(),
            spec_digest: v1_digest,
            accepted_by: "server_auth.reviewer".into(),
            accepted_at_ms: 1,
        },
    );
    send(
        &mut store,
        "derived-propose",
        ManagedCommand::ProposeSpec {
            spec_id: "spec-v2".into(),
            spec: derived,
            spec_digest: derived_digest.clone(),
        },
    );
    // A Run is pinned to the accepted active SpecVersion until supersession.
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "run-derived",
                ManagedCommand::StartRun {
                    run_id: "run-v2".into(),
                    spec_id: "spec-v2".into(),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "derived-accept",
        ManagedCommand::AcceptSpec {
            spec_id: "spec-v2".into(),
            spec_digest: derived_digest,
            accepted_by: "server_auth.reviewer".into(),
            accepted_at_ms: 2,
        },
    );
    send(
        &mut store,
        "run-v2",
        ManagedCommand::StartRun {
            run_id: "run-v2".into(),
            spec_id: "spec-v2".into(),
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "run-v1-stale-spec",
                ManagedCommand::StartRun {
                    run_id: "run-v1".into(),
                    spec_id: "spec-v1".into(),
                }
            )
            .is_err()
    );
    // A SpecVersion cannot be moved to another project/workspace.
    let mut foreign = spec("server_auth.author", 2);
    foreign.project_ref = "project-two".into();
    let foreign_digest = foreign.digest();
    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "foreign-project",
            ManagedCommand::ProposeSpec {
                spec_id: "spec-v3".into(),
                spec: foreign,
                spec_digest: foreign_digest,
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
}

#[test]
fn cancellation_completes_only_after_every_attempt_settles_and_is_terminal() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-cancel-complete").unwrap();
    accepted_run(&mut store);

    // An unsettled admitted Attempt keeps CANCELLING fenced.
    send(
        &mut store,
        "start-blocked",
        ManagedCommand::StartRun {
            run_id: "run-blocked".into(),
            spec_id: "spec-v1".into(),
        },
    );
    send(
        &mut store,
        "task-blocked",
        ManagedCommand::AddTask {
            run_id: "run-blocked".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready-blocked",
        ManagedCommand::MarkTaskReady {
            run_id: "run-blocked".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt-blocked",
        ManagedCommand::AdmitAttempt {
            run_id: "run-blocked".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "cancel-blocked",
        ManagedCommand::RequestCancel {
            run_id: "run-blocked".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-blocked"].phase,
        RunPhase::Cancelling
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "complete-with-active-attempt",
                ManagedCommand::CompleteCancel {
                    run_id: "run-blocked".into(),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "unknown-blocked",
        ManagedCommand::MarkAttemptUnknown {
            run_id: "run-blocked".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    let revision = store.snapshot().revision;
    assert!(matches!(
        store.apply(
            revision,
            "complete-with-unknown-attempt",
            ManagedCommand::CompleteCancel {
                run_id: "run-blocked".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert_eq!(store.snapshot().revision, revision);
    assert_eq!(
        store.snapshot().runs["run-blocked"].phase,
        RunPhase::Cancelling
    );

    // Once every admitted Attempt has settled, cancellation completes.
    send(
        &mut store,
        "start-settled",
        ManagedCommand::StartRun {
            run_id: "run-settled".into(),
            spec_id: "spec-v1".into(),
        },
    );
    send(
        &mut store,
        "task-settled",
        ManagedCommand::AddTask {
            run_id: "run-settled".into(),
            task_id: "task-b".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready-settled",
        ManagedCommand::MarkTaskReady {
            run_id: "run-settled".into(),
            task_id: "task-b".into(),
        },
    );
    send(
        &mut store,
        "attempt-settled",
        ManagedCommand::AdmitAttempt {
            run_id: "run-settled".into(),
            task_id: "task-b".into(),
            attempt_id: "attempt-two".into(),
        },
    );
    send(
        &mut store,
        "settle-attempt",
        ManagedCommand::FailAttempt {
            run_id: "run-settled".into(),
            task_id: "task-b".into(),
            attempt_id: "attempt-two".into(),
            failure_code: "transient".into(),
            retryable: true,
        },
    );
    send(
        &mut store,
        "cancel-settled",
        ManagedCommand::RequestCancel {
            run_id: "run-settled".into(),
        },
    );
    send(
        &mut store,
        "complete-cancellation",
        ManagedCommand::CompleteCancel {
            run_id: "run-settled".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-settled"].phase,
        RunPhase::Cancelled
    );

    // Exact retry is idempotent; a fresh command from CANCELLED conflicts.
    let revision = store.snapshot().revision;
    store
        .apply(
            revision,
            "complete-cancellation",
            ManagedCommand::CompleteCancel {
                run_id: "run-settled".into(),
            },
        )
        .unwrap();
    assert_eq!(store.snapshot().revision, revision);
    assert!(matches!(
        store.apply(
            revision,
            "complete-again",
            ManagedCommand::CompleteCancel {
                run_id: "run-settled".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));

    // CANCELLED is terminal: no work, phase or settlement transition applies.
    for (delivery, command) in [
        (
            "cancel-cancelled",
            ManagedCommand::RequestCancel {
                run_id: "run-settled".into(),
            },
        ),
        (
            "pause-cancelled",
            ManagedCommand::PauseRun {
                run_id: "run-settled".into(),
            },
        ),
        (
            "resume-cancelled",
            ManagedCommand::ResumeRun {
                run_id: "run-settled".into(),
            },
        ),
        (
            "needs-you-cancelled",
            ManagedCommand::NeedsYou {
                run_id: "run-settled".into(),
            },
        ),
        (
            "fail-cancelled",
            ManagedCommand::FailRun {
                run_id: "run-settled".into(),
                failure_code: "late-failure".into(),
            },
        ),
        (
            "admit-cancelled",
            ManagedCommand::AdmitAttempt {
                run_id: "run-settled".into(),
                task_id: "task-b".into(),
                attempt_id: "attempt-three".into(),
            },
        ),
        (
            "add-task-cancelled",
            ManagedCommand::AddTask {
                run_id: "run-settled".into(),
                task_id: "task-c".into(),
                dependencies: vec![],
                criterion_ids: vec![],
            },
        ),
        (
            "ready-cancelled",
            ManagedCommand::MarkTaskReady {
                run_id: "run-settled".into(),
                task_id: "task-b".into(),
            },
        ),
        (
            "begin-verification-cancelled",
            ManagedCommand::BeginVerification {
                run_id: "run-settled".into(),
                final_revision: sha('a'),
            },
        ),
        (
            "finalize-cancelled",
            ManagedCommand::FinalizeRun {
                run_id: "run-settled".into(),
                final_revision: sha('a'),
            },
        ),
    ] {
        assert!(matches!(
            store.apply(revision, delivery, command),
            Err(ManagedError::Conflict(_))
        ));
    }
    assert_eq!(store.snapshot().revision, revision);
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-cancel-complete").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-blocked"].phase,
        RunPhase::Cancelling
    );
    assert!(restored.snapshot().runs["run-blocked"].tasks["task-a"].unknown_effect);
    assert_eq!(
        restored.snapshot().runs["run-settled"].phase,
        RunPhase::Cancelled
    );
    let revision = restored.snapshot().revision;
    assert!(
        restored
            .apply(
                revision,
                "complete-blocked-after-restart",
                ManagedCommand::CompleteCancel {
                    run_id: "run-blocked".into(),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                revision,
                "resume-cancelled-after-restart",
                ManagedCommand::ResumeRun {
                    run_id: "run-settled".into(),
                }
            )
            .is_err()
    );
    assert_eq!(restored.snapshot().revision, revision);
}

#[test]
fn fail_run_from_verifying_records_bounded_code_and_is_terminal() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-fail-verify").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec!["tests-pass".into()],
        },
    );
    send(
        &mut store,
        "ready",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "verified",
        ManagedCommand::VerifyTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            source_revision: sha('a'),
            evidence_digest: sha('d'),
        },
    );
    send(
        &mut store,
        "verifying",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('a'),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Verifying);

    // Failure codes are bounded managed identifiers.
    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "forged-failure-code",
            ManagedCommand::FailRun {
                run_id: "run-v1".into(),
                failure_code: "bad code!".into(),
            }
        ),
        Err(ManagedError::Invalid(_))
    ));

    send(
        &mut store,
        "fail-verification",
        ManagedCommand::FailRun {
            run_id: "run-v1".into(),
            failure_code: "verification-unmet".into(),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Failed);
    assert_eq!(
        store.snapshot().runs["run-v1"].failure_code.as_deref(),
        Some("verification-unmet")
    );

    // Exact retry is idempotent across the terminal transition.
    let revision = store.snapshot().revision;
    store
        .apply(
            revision,
            "fail-verification",
            ManagedCommand::FailRun {
                run_id: "run-v1".into(),
                failure_code: "verification-unmet".into(),
            },
        )
        .unwrap();
    assert_eq!(store.snapshot().revision, revision);

    // FAILED is terminal: no phase, settlement or verification transition applies.
    for (delivery, command) in [
        (
            "cancel-failed",
            ManagedCommand::RequestCancel {
                run_id: "run-v1".into(),
            },
        ),
        (
            "pause-failed",
            ManagedCommand::PauseRun {
                run_id: "run-v1".into(),
            },
        ),
        (
            "resume-failed",
            ManagedCommand::ResumeRun {
                run_id: "run-v1".into(),
            },
        ),
        (
            "needs-you-failed",
            ManagedCommand::NeedsYou {
                run_id: "run-v1".into(),
            },
        ),
        (
            "complete-failed",
            ManagedCommand::CompleteCancel {
                run_id: "run-v1".into(),
            },
        ),
        (
            "fail-again",
            ManagedCommand::FailRun {
                run_id: "run-v1".into(),
                failure_code: "second-reason".into(),
            },
        ),
        (
            "begin-verification-failed",
            ManagedCommand::BeginVerification {
                run_id: "run-v1".into(),
                final_revision: sha('a'),
            },
        ),
        (
            "evidence-failed",
            ManagedCommand::RecordCriterionEvidence {
                run_id: "run-v1".into(),
                criterion_id: "tests-pass".into(),
                source_revision: sha('a'),
                evidence_digest: sha('e'),
                verifier_id: "rust-test-runner".into(),
            },
        ),
        (
            "finalize-failed",
            ManagedCommand::FinalizeRun {
                run_id: "run-v1".into(),
                final_revision: sha('a'),
            },
        ),
        (
            "add-task-failed",
            ManagedCommand::AddTask {
                run_id: "run-v1".into(),
                task_id: "task-c".into(),
                dependencies: vec![],
                criterion_ids: vec![],
            },
        ),
    ] {
        assert!(matches!(
            store.apply(revision, delivery, command),
            Err(ManagedError::Conflict(_))
        ));
    }
    assert_eq!(store.snapshot().revision, revision);
    assert_eq!(
        store.snapshot().runs["run-v1"].failure_code.as_deref(),
        Some("verification-unmet")
    );
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-fail-verify").unwrap();
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Failed);
    assert_eq!(
        restored.snapshot().runs["run-v1"].failure_code.as_deref(),
        Some("verification-unmet")
    );
    let revision = restored.snapshot().revision;
    assert!(
        restored
            .apply(
                revision,
                "cancel-after-restart",
                ManagedCommand::RequestCancel {
                    run_id: "run-v1".into(),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                revision,
                "fail-after-restart",
                ManagedCommand::FailRun {
                    run_id: "run-v1".into(),
                    failure_code: "other-reason".into(),
                }
            )
            .is_err()
    );
    assert_eq!(restored.snapshot().revision, revision);
}

#[test]
fn fail_run_is_fenced_by_unsettled_attempts_and_wrong_phases() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-fail-fenced").unwrap();
    accepted_run(&mut store);
    send(
        &mut store,
        "task-a",
        ManagedCommand::AddTask {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready-a",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
        },
    );
    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "unknown",
        ManagedCommand::MarkAttemptUnknown {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Reconciling);

    // RECONCILING carries an UNKNOWN unsettled Attempt: failure stays fenced
    // until a future authenticated EffectService reconciles it with proof.
    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "fail-reconciling",
            ManagedCommand::FailRun {
                run_id: "run-v1".into(),
                failure_code: "unrelated-failure".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Reconciling);
    assert!(store.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert!(store.snapshot().runs["run-v1"].failure_code.is_none());

    // RUNNING cannot fail directly (RUNNING -> VERIFYING -> FAILED).
    send(
        &mut store,
        "start-direct",
        ManagedCommand::StartRun {
            run_id: "run-direct".into(),
            spec_id: "spec-v1".into(),
        },
    );
    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "fail-running",
            ManagedCommand::FailRun {
                run_id: "run-direct".into(),
                failure_code: "direct-failure".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));

    // CANCELLING can only complete cancellation, never fail.
    send(
        &mut store,
        "start-cancelling",
        ManagedCommand::StartRun {
            run_id: "run-cancelling".into(),
            spec_id: "spec-v1".into(),
        },
    );
    send(
        &mut store,
        "task-c",
        ManagedCommand::AddTask {
            run_id: "run-cancelling".into(),
            task_id: "task-c".into(),
            dependencies: vec![],
            criterion_ids: vec![],
        },
    );
    send(
        &mut store,
        "ready-c",
        ManagedCommand::MarkTaskReady {
            run_id: "run-cancelling".into(),
            task_id: "task-c".into(),
        },
    );
    send(
        &mut store,
        "attempt-c",
        ManagedCommand::AdmitAttempt {
            run_id: "run-cancelling".into(),
            task_id: "task-c".into(),
            attempt_id: "attempt-c".into(),
        },
    );
    send(
        &mut store,
        "cancel-c",
        ManagedCommand::RequestCancel {
            run_id: "run-cancelling".into(),
        },
    );
    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "fail-cancelling",
            ManagedCommand::FailRun {
                run_id: "run-cancelling".into(),
                failure_code: "cancelled-work".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert_eq!(
        store.snapshot().runs["run-cancelling"].phase,
        RunPhase::Cancelling
    );
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-fail-fenced").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Reconciling
    );
    assert!(restored.snapshot().runs["run-v1"].tasks["task-a"].unknown_effect);
    assert_eq!(
        restored.snapshot().runs["run-cancelling"].phase,
        RunPhase::Cancelling
    );
    let revision = restored.snapshot().revision;
    assert!(matches!(
        restored.apply(
            revision,
            "fail-reconciling-after-restart",
            ManagedCommand::FailRun {
                run_id: "run-v1".into(),
                failure_code: "unrelated-failure".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert!(restored.snapshot().runs["run-v1"].failure_code.is_none());
    assert_eq!(restored.snapshot().revision, revision);
}
