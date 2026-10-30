#![cfg(target_os = "linux")]

use horizoncode_kernel::managed_control::{
    attempt_receipt_digest, successful_task_receipt_basis_digest, verification_evidence_digest,
    AcceptanceCriterion, AttemptEffectOutcomeV1, AttemptPhase, CriterionTestEvidenceV1,
    CriterionVerifierProcessEvidenceV1, GoalDraft, ManagedAttemptEffectReceiptProofV1,
    ManagedAttemptVerifierIntentV1, ManagedCommand, ManagedControl, ManagedError, PlannedTaskV1,
    ProfileRevisionRefV1, RunPhase, SessionLink, SpecBudget, SpecVersionDraft,
    VerificationEvidenceV1, VerificationVerdictV1, VerifierProfileEvidenceV1,
};
use horizoncode_kernel::owner_log::{
    DurabilityProfile, OwnerEventInput, OwnerIdentity, OwnerLogV2,
};
use horizoncode_kernel::protocol::{
    ArtifactClassificationV1, ArtifactRefV1, CursorV1, DelegationBindingV1,
};
use serde_json::json;
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

fn b3(seed: char) -> String {
    format!("blake3:{}", seed.to_string().repeat(64))
}

/// Trusted fixture profile pin for planned Tasks. The reducer validates its
/// exact shape (canonical ID, positive revision, BLAKE3 definition digest) and
/// the scheduler additionally requires the pinned positive token budget; the
/// fixture never fabricates authority beyond these trusted test facts.
fn fixture_profile_revision() -> ProfileRevisionRefV1 {
    ProfileRevisionRefV1 {
        profile_id: "fixture-profile".into(),
        revision: 1,
        definition_digest: b3('a'),
    }
}

fn fixture_planned_task(
    task_id: &str,
    dependencies: &[&str],
    criterion_ids: &[&str],
) -> PlannedTaskV1 {
    PlannedTaskV1 {
        task_id: task_id.into(),
        title: Some(format!("Fixture task {task_id}")),
        purpose: Some(format!("Managed fixture work for {task_id}")),
        dependencies: dependencies
            .iter()
            .map(|dependency| (*dependency).to_owned())
            .collect(),
        criterion_ids: criterion_ids
            .iter()
            .map(|criterion| (*criterion).to_owned())
            .collect(),
        required_capabilities: vec![],
        agent_profile_revision: fixture_profile_revision(),
        profile_token_budget: 16_000,
        profile_owner_binding_digest: b3('b'),
    }
}

/// Planned Task whose execution pins the canonical supervised-test capability
/// that the typed verifier intent requires; used by every Task that settles
/// through the hardened success path.
fn fixture_verifier_task(
    task_id: &str,
    dependencies: &[&str],
    criterion_ids: &[&str],
) -> PlannedTaskV1 {
    let mut task = fixture_planned_task(task_id, dependencies, criterion_ids);
    task.required_capabilities = vec!["test.run".into()];
    task
}

/// Valid root SessionLink pinned by the explicit authenticated planned-run
/// start; the reducer validates every correlation field before pinning it.
fn fixture_session_link(session_id: &str, owner_epoch: u64) -> SessionLink {
    SessionLink {
        session_id: session_id.into(),
        source_store_id: "store-fixture".into(),
        source_instance_id: "instance-fixture".into(),
        source_cursor: CursorV1 {
            owner_kind: "session".into(),
            owner_id: session_id.into(),
            seq: "1".into(),
            event_digest: b3('c'),
        },
        source_epoch: 1,
        latest_observed_message_id: None,
        latest_observed_part_id: None,
        source_digest: sha('c'),
        redaction_profile: "session-redacted-v1".into(),
        owner_epoch,
        protocol_version: 1,
    }
}

/// Exact replica of the kernel's planned-Task-set digest (schema v3) over the
/// same fixture facts, in the same field order the reducer serializes and in
/// the durable plan's `BTreeMap` (task-ID) order. The `StartPlannedRun`
/// transition recomputes this digest from the durable plan and refuses a Run
/// whose task set does not match it byte-for-byte.
fn fixture_plan_digest(tasks: &[PlannedTaskV1]) -> String {
    let mut sorted = tasks.to_vec();
    sorted.sort_by(|left, right| left.task_id.cmp(&right.task_id));
    let values = sorted
        .iter()
        .map(|task| {
            let mut value = json!({
                "taskId": task.task_id,
                "dependencies": task.dependencies,
                "criterionIds": task.criterion_ids,
                "requiredCapabilities": task.required_capabilities,
                "agentProfileRevision": {
                    "profileId": task.agent_profile_revision.profile_id,
                    "revision": task.agent_profile_revision.revision.to_string(),
                    "definitionDigest": task.agent_profile_revision.definition_digest,
                },
                "profileOwnerBindingDigest": task.profile_owner_binding_digest,
            });
            value["profileTokenBudget"] = json!(task.profile_token_budget.to_string());
            value["title"] = json!(task.title);
            value["purpose"] = json!(task.purpose);
            value
        })
        .collect::<Vec<_>>();
    format!(
        "blake3:{}",
        blake3::hash(
            json!({"schemaVersion": 3, "tasks": values})
                .to_string()
                .as_bytes()
        )
        .to_hex()
    )
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
        capability_scope: vec![],
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
    let reviewer = match &command {
        ManagedCommand::AcceptSpec {
            spec_id,
            spec_digest,
            accepted_by,
            ..
        } => Some((spec_id.clone(), spec_digest.clone(), accepted_by.clone())),
        ManagedCommand::RejectSpec {
            spec_id,
            spec_digest,
            rejected_by,
            ..
        } => Some((spec_id.clone(), spec_digest.clone(), rejected_by.clone())),
        _ => None,
    };
    if let Some((spec_id, spec_digest, reviewer_id)) = reviewer {
        let snapshot = store.snapshot();
        if snapshot
            .specs
            .get(&spec_id)
            .is_some_and(|spec| spec.reviewer_id.is_none())
        {
            store
                .apply(
                    snapshot.revision,
                    &format!("{delivery}-reviewer"),
                    ManagedCommand::AssignSpecReviewer {
                        spec_id,
                        spec_digest,
                        reviewer_id,
                    },
                )
                .unwrap();
        }
    }
    if let ManagedCommand::BindAttemptEffect { attempt_id, .. } = &command {
        bind_test_delegation(store, attempt_id);
    }
    let rev = store.snapshot().revision;
    store.apply(rev, delivery, command).unwrap();
}

/// Explicit trusted fixture authority for managed-effect state-machine tests. The
/// production OwnerLog adapter never infers these values from an effect request.
fn bind_test_delegation(store: &mut ManagedControl, attempt_id: &str) {
    let snapshot = store.snapshot();
    let Some(attempt) = snapshot.attempts.get(attempt_id) else {
        panic!("managed test fixture Attempt is missing")
    };
    if attempt.delegation_binding.is_some() {
        return;
    }
    let run_id = attempt.run_id.clone();
    let task_id = attempt.task_id.clone();
    let owner_epoch = attempt.owner_epoch;
    let workspace_revision = attempt
        .workspace_revision
        .clone()
        .unwrap_or_else(|| b3('f'));
    if attempt.workspace_revision.is_none() {
        send(
            store,
            &fixture_delivery("workspace", attempt_id),
            ManagedCommand::BindAttemptWorkspaceRevision {
                attempt_id: attempt_id.to_owned(),
                workspace_revision: workspace_revision.clone(),
            },
        );
    }
    let snapshot = store.snapshot();
    let run = &snapshot.runs[&run_id];
    let task = &run.tasks[&task_id];
    let mut criteria_ids = task.criterion_ids.clone();
    criteria_ids.sort();
    criteria_ids.dedup();
    assert!(
        !criteria_ids.is_empty(),
        "effect fixture Task requires criteria"
    );
    let spec_digest = snapshot.specs[&run.spec_id].digest.clone();
    let binding = DelegationBindingV1 {
        run_id,
        task_id,
        attempt_id: attempt_id.to_owned(),
        parent_execution_id: fixture_execution_id("parent", attempt_id),
        child_execution_id: fixture_execution_id("child", attempt_id),
        accepted_spec_digest: spec_digest,
        profile_id: "fixture-profile".into(),
        profile_revision: 1,
        profile_digest: b3('a'),
        // Trusted fixture authority: the planned Task pins this exact profile
        // revision and positive token budget, so the delegation binding
        // carries the same budget; no managed provider route exists for the
        // fixture, and provider/model identities name the fixture profile's
        // declared selection and never authorize dispatch.
        provider_id: "fixture-provider".into(),
        model_id: "fixture-model".into(),
        managed_provider_route: None,
        profile_token_budget: Some(16_000),
        criteria_ids,
        workspace_lease_id: "fixture-workspace-lease".into(),
        source_revision: workspace_revision,
        capability_ceiling_digest: sha('b'),
        permission_scope_digest: b3('d'),
        context_selection_digest: b3('c'),
        budget_lease_id: "fixture-budget-lease".into(),
        resource_lease_ids: vec![],
        owner_epoch,
        admitted_managed_revision: snapshot.revision + 1,
    };
    store
        .bind_attempt_delegation(
            &fixture_delivery("delegation", attempt_id),
            attempt_id,
            binding,
        )
        .unwrap();
}

fn fixture_delivery(prefix: &str, attempt_id: &str) -> String {
    format!(
        "fixture-{prefix}-{}",
        blake3::hash(attempt_id.as_bytes()).to_hex()
    )
}

fn fixture_execution_id(prefix: &str, attempt_id: &str) -> String {
    format!("{prefix}-{}", blake3::hash(attempt_id.as_bytes()).to_hex())
}

fn accepted_run(store: &mut ManagedControl) {
    accepted_run_with_workers(store, 1);
}

fn accepted_spec(store: &mut ManagedControl, draft: SpecVersionDraft) {
    let mut draft = draft;
    // Typed settlement's verifier intent runs a supervised test process; the
    // canonical capability must be in the accepted scope for planned Tasks
    // that pin it.
    if draft.capability_scope.is_empty() {
        draft.capability_scope = vec!["test.run".into()];
    }
    send(store, "goal1", ManagedCommand::CreateGoal { goal: goal() });
    let spec_digest = draft.digest();
    send(
        store,
        "spec1",
        ManagedCommand::ProposeSpec {
            spec_id: "spec-v1".into(),
            spec: draft,
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
}

fn accepted_run_with_workers(store: &mut ManagedControl, max_workers: u16) {
    let mut spec = spec("server_auth.author", 2);
    spec.budget.max_workers = max_workers;
    accepted_spec(store, spec);
    send(
        store,
        "run1",
        ManagedCommand::StartRun {
            run_id: "run-v1".into(),
            spec_id: "spec-v1".into(),
        },
    );
}

/// Hardened planned-run start: the complete Task set (with immutable profile
/// pins, positive token budgets and delivery text) is durably planned in one
/// command, then the explicit authenticated start pins the root SessionLink
/// that the admission and scheduler gates require. Legacy `AddTask` Tasks
/// carry no profile pin or budget and are never schedulable, so every
/// lifecycle/admission/scheduler test starts its Run through this path.
fn plan_and_start_run(store: &mut ManagedControl, run_id: &str, tasks: Vec<PlannedTaskV1>) {
    let spec_digest = store.snapshot().specs["spec-v1"].digest.clone();
    let plan_digest = fixture_plan_digest(&tasks);
    send(
        store,
        &format!("plan-{run_id}"),
        ManagedCommand::PlanRun {
            run_id: run_id.into(),
            spec_id: "spec-v1".into(),
            spec_digest: spec_digest.clone(),
            tasks,
        },
    );
    send(
        store,
        &format!("start-{run_id}"),
        ManagedCommand::StartPlannedRun {
            run_id: run_id.into(),
            spec_id: "spec-v1".into(),
            spec_digest,
            plan_digest,
            expected_goal_revision: store.snapshot().revision,
            started_by: "server_auth.reviewer".into(),
            session_link: Some(fixture_session_link(&format!("ses-{run_id}"), 1)),
        },
    );
}

fn accepted_planned_run(
    store: &mut ManagedControl,
    max_workers: u16,
    tasks: Vec<PlannedTaskV1>,
) {
    let mut spec = spec("server_auth.author", 2);
    spec.budget.max_workers = max_workers;
    accepted_spec(store, spec);
    plan_and_start_run(store, "run-v1", tasks);
}

#[test]
fn goal_proposal_is_one_durable_transaction_and_failed_spec_can_retry_cleanly() {
    let root = PrivateRoot::new();
    let mut control = ManagedControl::open(root.path(), "goal-atomic").unwrap();
    let mut goal_draft = goal();
    goal_draft.created_by = "host_os_uid:1000".into();
    let mut invalid_spec = spec("host_os_uid:1000", 2);
    invalid_spec.objective = goal_draft.objective.clone();
    invalid_spec.project_ref = "different-project".into();

    let error = control
        .create_goal_proposal(
            0,
            "proposal-delivery",
            "goal-atomic".into(),
            "spec-atomic".into(),
            goal_draft.clone(),
            invalid_spec,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        ManagedError::Conflict("SpecVersion project/workspace mismatch")
    ));
    assert_eq!(control.snapshot().revision, 0);
    assert!(control.snapshot().goal.is_none());
    assert!(control.snapshot().specs.is_empty());

    let mut valid_spec = spec("host_os_uid:1000", 2);
    valid_spec.objective = goal_draft.objective.clone();
    let created = control
        .create_goal_proposal(
            0,
            "proposal-delivery",
            "goal-atomic".into(),
            "spec-atomic".into(),
            goal_draft.clone(),
            valid_spec.clone(),
        )
        .unwrap();
    assert_eq!(created.goal_id, "goal-atomic");
    assert_eq!(created.spec_id, "spec-atomic");
    assert_eq!(created.revision, 1);
    assert_eq!(control.snapshot().revision, 1);
    assert_eq!(
        control.snapshot().goal.as_ref().unwrap().created_by,
        "host_os_uid:1000"
    );
    assert_eq!(control.snapshot().specs.len(), 1);
    assert_eq!(
        control.snapshot().specs["spec-atomic"].digest,
        created.spec_digest
    );

    let replay = control
        .create_goal_proposal(
            0,
            "proposal-delivery",
            "goal-atomic".into(),
            "spec-atomic".into(),
            goal_draft,
            valid_spec,
        )
        .unwrap();
    assert_eq!(replay, created);
    assert_eq!(control.snapshot().revision, 1);

    drop(control);
    let reopened = ManagedControl::open_existing(root.path(), "goal-atomic").unwrap();
    assert_eq!(reopened.snapshot().revision, 1);
    assert!(reopened.snapshot().goal.is_some());
    assert_eq!(reopened.snapshot().specs.len(), 1);
}

/// Exact trusted verifier evidence fixture for one supervised criterion run.
/// The reducer recomputes the digest binding and revalidates every pin against
/// the persisted per-criterion intent before accepting it.
fn fixture_verification_evidence(
    attempt_id: &str,
    criterion_id: &str,
    source_revision: &str,
) -> VerificationEvidenceV1 {
    let mut evidence = VerificationEvidenceV1 {
        verification_run_id: format!("vrun-{attempt_id}"),
        verifier_id: "server_auth.verifier".into(),
        source_revision: source_revision.into(),
        profile: VerifierProfileEvidenceV1 {
            profile_id: "fixture-verifier".into(),
            owner_epoch: 1,
            executable_digest: b3('9'),
            profile_digest: b3('8'),
        },
        aggregate_output_bytes: 512,
        aggregate_duration_ms: 1_000,
        criteria: vec![CriterionTestEvidenceV1 {
            criterion_id: criterion_id.into(),
            verdict: VerificationVerdictV1::Pass,
            test_identity: format!("fixture-test-{attempt_id}"),
            test_run_id: format!("vtest-{attempt_id}"),
            process: CriterionVerifierProcessEvidenceV1 {
                execution_id: format!("vexec-{attempt_id}"),
                generation: 1,
                exit_code: 0,
                stdout_digest: b3('6'),
                stderr_digest: b3('7'),
                output_bytes: 512,
                duration_ms: 1_000,
                truncated: false,
            },
            artifact_refs: vec![ArtifactRefV1 {
                artifact_id: format!("artifact-{attempt_id}"),
                digest: b3('5'),
                byte_length: "128".into(),
                media_type: "text/plain".into(),
                classification: ArtifactClassificationV1::Workspace,
            }],
        }],
        evidence_digest: String::new(),
    };
    evidence.evidence_digest = verification_evidence_digest(&evidence);
    evidence
}

/// Drives one admitted Attempt through the full hardened settlement contract:
/// EXECUTING, a bound coding effect with its authoritative target receipt, the
/// live task-scoped verification start over the exact observed workspace head,
/// a verifier edge carrying one immutable verifier intent and its read-only
/// receipt, typed independent verifier evidence, and finally settlement under
/// the kernel-computed Attempt receipt. Every proof is built from the same
/// trusted fixture facts the reducer revalidates; returns the exact receipt
/// digest the reducer derived so callers can assert durable equality.
fn settle_attempt_success(
    store: &mut ManagedControl,
    delivery_prefix: &str,
    goal_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    receipt_seed: char,
    source_revision: &str,
) -> String {
    send(
        store,
        &format!("{delivery_prefix}-executing"),
        ManagedCommand::StartAttempt {
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
        },
    );

    let snapshot = store.snapshot();
    let attempt = &snapshot.attempts[attempt_id];
    let executor_principal = attempt.executor_principal.clone();
    let owner_epoch = attempt.owner_epoch;
    let location_id = attempt.location_id.clone();
    let session_id = attempt.session_id.clone();
    let criterion_ids = snapshot.runs[run_id].tasks[task_id].criterion_ids.clone();
    let criterion_id = criterion_ids
        .first()
        .expect("settlement fixture Task requires an accepted criterion")
        .clone();
    assert_eq!(
        criterion_ids.len(),
        1,
        "the fixture binds exactly one verifier intent per settlement"
    );

    // One coding edge, settled with its authoritative target receipt. The
    // trusted fixture authority binds the pre-admission workspace revision
    // just before this first edge.
    let coding_effect_id = format!("eff-{delivery_prefix}-coding");
    send(
        store,
        &format!("{delivery_prefix}-effect"),
        ManagedCommand::BindAttemptEffect {
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            effect_id: coding_effect_id.clone(),
            location_id: location_id.clone(),
            session_id: session_id.clone(),
        },
    );
    let coding_state = store.snapshot();
    let coding_bound_revision = coding_state.revision;
    let workspace_revision = coding_state.attempts[attempt_id]
        .workspace_revision
        .clone()
        .expect("effect fixture Attempt has a bound workspace revision");
    send(
        store,
        &format!("{delivery_prefix}-coding-receipt"),
        ManagedCommand::RecordAttemptEffectReceipt {
            proof: ManagedAttemptEffectReceiptProofV1 {
                goal_id: goal_id.into(),
                run_id: run_id.into(),
                task_id: task_id.into(),
                attempt_id: attempt_id.into(),
                effect_id: coding_effect_id.clone(),
                executor_principal: executor_principal.clone(),
                owner_epoch,
                bound_revision: coding_bound_revision,
                location_id: location_id.clone(),
                session_id: session_id.clone(),
                capability_id: "test.run".into(),
                capability_lease_digest: b3('2'),
                outcome: AttemptEffectOutcomeV1::Succeeded,
                target_receipt_digest: Some(b3(receipt_seed)),
                before_workspace_revision: workspace_revision,
                after_workspace_revision: Some(source_revision.into()),
            },
        },
    );

    // Live task-scoped verification over the exact observed coding head.
    let receipt_basis = successful_task_receipt_basis_digest(
        run_id,
        &store.snapshot().runs[run_id],
        &store.snapshot().attempts,
    )
    .expect("fixture verification receipt basis is well formed");
    send(
        store,
        &format!("{delivery_prefix}-begin-task-verification"),
        ManagedCommand::BeginTaskVerification {
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            source_revision: source_revision.into(),
            verifier_id: "server_auth.verifier".into(),
            receipt_basis_digest: receipt_basis,
        },
    );

    // A read-only verifier edge bound after the coding lineage, carrying the
    // immutable per-criterion verifier intent and its observed receipt.
    let verifier_effect_id = format!("eff-{delivery_prefix}-verifier");
    send(
        store,
        &format!("{delivery_prefix}-verifier-effect"),
        ManagedCommand::BindAttemptEffect {
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            effect_id: verifier_effect_id.clone(),
            location_id: location_id.clone(),
            session_id: session_id.clone(),
        },
    );
    let verifier_bound_revision = store.snapshot().revision;
    send(
        store,
        &format!("{delivery_prefix}-verifier-intent"),
        ManagedCommand::BindAttemptVerifierIntent {
            intent: ManagedAttemptVerifierIntentV1 {
                goal_id: goal_id.into(),
                run_id: run_id.into(),
                task_id: task_id.into(),
                attempt_id: attempt_id.into(),
                effect_id: verifier_effect_id.clone(),
                reviewer_principal: "server_auth.reviewer".into(),
                verifier_principal: "server_auth.verifier".into(),
                owner_epoch,
                bound_revision: verifier_bound_revision,
                location_id: location_id.clone(),
                session_id: session_id.clone(),
                capability_id: "test.run".into(),
                verifier_profile_id: "fixture-verifier".into(),
                executable_digest: b3('9'),
                profile_digest: b3('8'),
                criterion_id: criterion_id.clone(),
                test_identity: format!("fixture-test-{attempt_id}"),
                arguments_digest: b3('3'),
                attempt_scope_digest: None,
                source_workspace_revision: source_revision.into(),
                max_duration_ms: 1_000,
                max_output_bytes: 4_096,
            },
        },
    );
    send(
        store,
        &format!("{delivery_prefix}-verifier-receipt"),
        ManagedCommand::RecordAttemptEffectReceipt {
            proof: ManagedAttemptEffectReceiptProofV1 {
                goal_id: goal_id.into(),
                run_id: run_id.into(),
                task_id: task_id.into(),
                attempt_id: attempt_id.into(),
                effect_id: verifier_effect_id.clone(),
                executor_principal: "server_auth.verifier".into(),
                owner_epoch,
                bound_revision: verifier_bound_revision,
                location_id: location_id.clone(),
                session_id: session_id.clone(),
                capability_id: "test.run".into(),
                capability_lease_digest: b3('2'),
                outcome: AttemptEffectOutcomeV1::Succeeded,
                target_receipt_digest: Some(b3('4')),
                before_workspace_revision: source_revision.into(),
                after_workspace_revision: Some(source_revision.into()),
            },
        },
    );

    let mut evidence =
        fixture_verification_evidence(attempt_id, &criterion_id, source_revision);
    send(
        store,
        &format!("{delivery_prefix}-verifier-evidence"),
        ManagedCommand::RecordAttemptVerifierEvidence {
            attempt_id: attempt_id.into(),
            evidence,
        },
    );

    send(
        store,
        &format!("{delivery_prefix}-settling"),
        ManagedCommand::BeginAttemptSettlement {
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
        },
    );
    let attempt_record = store.snapshot().attempts[attempt_id].clone();
    let mut settled = vec![
        (coding_effect_id, b3(receipt_seed)),
        (verifier_effect_id, b3('4')),
    ];
    settled.sort_by(|left, right| left.0.cmp(&right.0));
    let receipt_digest = attempt_receipt_digest(goal_id, &attempt_record, &settled);
    send(
        store,
        &format!("{delivery_prefix}-receipt"),
        ManagedCommand::SettleAttempt {
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            receipt_digest: receipt_digest.clone(),
        },
    );
    receipt_digest
}

/// Exact replica of the reducer's typed task-verification evidence digest over
/// the same durable facts, so tests can assert the kernel-derived value.
fn typed_task_verification_digest(
    task_id: &str,
    attempt_id: &str,
    receipt_digest: &str,
    criterion_ids: &[String],
    evidence: &VerificationEvidenceV1,
) -> String {
    let mut preimage = b"horizoncode.task-verification-evidence.v1\0".to_vec();
    let mut extend = |value: &str| {
        preimage.extend_from_slice(&(value.len() as u32).to_be_bytes());
        preimage.extend_from_slice(value.as_bytes());
    };
    extend(task_id);
    extend(attempt_id);
    extend(receipt_digest);
    extend(&evidence.source_revision);
    extend(&evidence.verifier_id);
    extend(&evidence.evidence_digest);
    let mut sorted = criterion_ids.to_vec();
    sorted.sort();
    for criterion_id in sorted {
        extend(&criterion_id);
    }
    format!("blake3:{}", blake3::hash(&preimage).to_hex())
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
fn task_required_capabilities_must_be_a_subset_of_the_accepted_spec_scope() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-capability-scope").unwrap();
    send(&mut store, "goal", ManagedCommand::CreateGoal { goal: goal() });

    let mut draft = spec("server_auth.author", 1);
    draft.capability_scope = vec!["files.patch".into()];
    let spec_digest = draft.digest();
    send(
        &mut store,
        "propose",
        ManagedCommand::ProposeSpec {
            spec_id: "spec-capabilities".into(),
            spec: draft,
            spec_digest: spec_digest.clone(),
        },
    );
    send(
        &mut store,
        "accept",
        ManagedCommand::AcceptSpec {
            spec_id: "spec-capabilities".into(),
            spec_digest,
            accepted_by: "server_auth.reviewer".into(),
            accepted_at_ms: 1,
        },
    );
    send(
        &mut store,
        "run",
        ManagedCommand::StartRun {
            run_id: "run-capabilities".into(),
            spec_id: "spec-capabilities".into(),
        },
    );

    let revision = store.snapshot().revision;
    let widened = store.apply(
        revision,
        "task-widened",
        ManagedCommand::AddTask {
            run_id: "run-capabilities".into(),
            task_id: "task-widened".into(),
            dependencies: vec![],
            criterion_ids: vec!["tests-pass".into()],
            required_capabilities: vec!["files.read".into()],
        },
    );
    assert!(matches!(widened, Err(ManagedError::Conflict(_))));
    assert_eq!(store.snapshot().revision, revision);
    assert!(!store.snapshot().runs["run-capabilities"].tasks.contains_key("task-widened"));

    store
        .apply(
            revision,
            "task-narrowed",
            ManagedCommand::AddTask {
                run_id: "run-capabilities".into(),
                task_id: "task-narrowed".into(),
                dependencies: vec![],
                criterion_ids: vec!["tests-pass".into()],
                required_capabilities: vec!["files.patch".into()],
            },
        )
        .unwrap();
    assert_eq!(
        store.snapshot().runs["run-capabilities"].tasks["task-narrowed"].required_capabilities,
        ["files.patch"]
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
fn rejected_spec_is_terminal_audited_and_can_be_revised_without_becoming_active() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-rejected-spec").unwrap();
    send(
        &mut store,
        "goal",
        ManagedCommand::CreateGoal { goal: goal() },
    );

    let first = spec("server_auth.author", 2);
    let first_digest = first.digest();
    send(
        &mut store,
        "propose-first",
        ManagedCommand::ProposeSpec {
            spec_id: "spec-v1".into(),
            spec: first,
            spec_digest: first_digest.clone(),
        },
    );
    let proposed_revision = store.snapshot().revision;
    assert!(matches!(
        store.apply(
            proposed_revision,
            "reject-stale-digest",
            ManagedCommand::RejectSpec {
                spec_id: "spec-v1".into(),
                spec_digest: b3('f'),
                rejected_by: "server_auth.reviewer".into(),
                rejected_at_ms: 11,
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert!(matches!(
        store.apply(
            proposed_revision,
            "reject-zero-time",
            ManagedCommand::RejectSpec {
                spec_id: "spec-v1".into(),
                spec_digest: first_digest.clone(),
                rejected_by: "server_auth.reviewer".into(),
                rejected_at_ms: 0,
            }
        ),
        Err(ManagedError::Invalid(_))
    ));
    assert!(matches!(
        store.apply(
            proposed_revision,
            "reject-invalid-reviewer",
            ManagedCommand::RejectSpec {
                spec_id: "spec-v1".into(),
                spec_digest: first_digest.clone(),
                rejected_by: String::new(),
                rejected_at_ms: 11,
            }
        ),
        Err(ManagedError::Invalid(_))
    ));
    assert_eq!(store.snapshot().revision, proposed_revision);
    send(
        &mut store,
        "reject-first",
        ManagedCommand::RejectSpec {
            spec_id: "spec-v1".into(),
            spec_digest: first_digest.clone(),
            rejected_by: "server_auth.reviewer".into(),
            rejected_at_ms: 12,
        },
    );

    let rejected = &store.snapshot().specs["spec-v1"];
    assert!(!rejected.accepted);
    assert_eq!(rejected.accepted_by, None);
    assert_eq!(
        rejected.rejected_by.as_deref(),
        Some("server_auth.reviewer")
    );
    assert_eq!(rejected.rejected_at_ms, Some(12));
    let revision = store.snapshot().revision;
    assert!(matches!(
        store.apply(
            revision,
            "accept-rejected",
            ManagedCommand::AcceptSpec {
                spec_id: "spec-v1".into(),
                spec_digest: first_digest.clone(),
                accepted_by: "server_auth.reviewer".into(),
                accepted_at_ms: 13,
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert!(matches!(
        store.apply(
            revision,
            "reject-again",
            ManagedCommand::RejectSpec {
                spec_id: "spec-v1".into(),
                spec_digest: first_digest.clone(),
                rejected_by: "server_auth.reviewer".into(),
                rejected_at_ms: 14,
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert!(
        store
            .apply(
                revision,
                "run-rejected",
                ManagedCommand::StartRun {
                    run_id: "run-rejected".into(),
                    spec_id: "spec-v1".into(),
                }
            )
            .is_err()
    );
    assert_eq!(store.snapshot().revision, revision);
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-rejected-spec").unwrap();
    assert_eq!(
        restored.snapshot().specs["spec-v1"].rejected_by.as_deref(),
        Some("server_auth.reviewer")
    );
    assert_eq!(
        restored.snapshot().specs["spec-v1"].rejected_at_ms,
        Some(12)
    );

    let mut replacement = spec("server_auth.author", 2);
    replacement.parent_version_id = Some("spec-v1".into());
    let replacement_digest = replacement.digest();
    send(
        &mut restored,
        "propose-replacement",
        ManagedCommand::ProposeSpec {
            spec_id: "spec-v2".into(),
            spec: replacement,
            spec_digest: replacement_digest.clone(),
        },
    );
    send(
        &mut restored,
        "accept-replacement",
        ManagedCommand::AcceptSpec {
            spec_id: "spec-v2".into(),
            spec_digest: replacement_digest,
            accepted_by: "server_auth.reviewer".into(),
            accepted_at_ms: 15,
        },
    );
    send(
        &mut restored,
        "run-replacement",
        ManagedCommand::StartRun {
            run_id: "run-v2".into(),
            spec_id: "spec-v2".into(),
        },
    );
    assert_eq!(restored.snapshot().runs["run-v2"].phase, RunPhase::Running);
    let accepted_revision = restored.snapshot().revision;
    let accepted_digest = restored.snapshot().specs["spec-v2"].digest.clone();
    assert!(matches!(
        restored.apply(
            accepted_revision,
            "reject-accepted-replacement",
            ManagedCommand::RejectSpec {
                spec_id: "spec-v2".into(),
                spec_digest: accepted_digest,
                rejected_by: "server_auth.reviewer".into(),
                rejected_at_ms: 16,
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert_eq!(restored.snapshot().revision, accepted_revision);
    assert_eq!(
        restored
            .snapshot()
            .goal
            .as_ref()
            .unwrap()
            .active_spec_version_id,
        Some("spec-v2".into())
    );
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
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
    assert_eq!(
        store.snapshot().attempts["attempt-one"].receipt_digest,
        None
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Running);

    send(
        &mut store,
        "attempt-two",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-two".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
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
fn immutable_delegation_binding_is_atomic_replayable_and_required_for_effect_intents() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-delegation-binding").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "admit",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    send(
        &mut store,
        "start",
        ManagedCommand::StartAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    let source_revision = b3('c');
    send(
        &mut store,
        "workspace",
        ManagedCommand::BindAttemptWorkspaceRevision {
            attempt_id: "attempt-one".into(),
            workspace_revision: source_revision.clone(),
        },
    );

    let blocked = store.apply(
        store.snapshot().revision,
        "effect-before-binding",
        ManagedCommand::BindAttemptEffect {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            effect_id: "effect-one".into(),
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    assert!(blocked.is_err());
    assert!(store.snapshot().attempts["attempt-one"].effects.is_empty());

    let spec_digest = store.snapshot().specs["spec-v1"].digest.clone();
    let mut binding = DelegationBindingV1 {
        run_id: "run-v1".into(),
        task_id: "task-a".into(),
        attempt_id: "attempt-one".into(),
        parent_execution_id: "exec-parent".into(),
        child_execution_id: "exec-child".into(),
        accepted_spec_digest: spec_digest,
        profile_id: "profile-v1".into(),
        profile_revision: 1,
        profile_digest: b3('a'),
        // Trusted fixture authority: the planned Task pins this exact profile
        // revision and positive token budget, so the delegation binding
        // carries the same budget; no managed provider route exists for the
        // fixture, and provider/model identities name the fixture profile's
        // declared selection and never authorize dispatch.
        provider_id: "provider-v1".into(),
        model_id: "model-v1".into(),
        managed_provider_route: None,
        profile_token_budget: Some(16_000),
        criteria_ids: vec!["tests-pass".into()],
        workspace_lease_id: "workspace-lease-1".into(),
        source_revision,
        capability_ceiling_digest: sha('b'),
        permission_scope_digest: b3('e'),
        context_selection_digest: b3('d'),
        budget_lease_id: "budget-lease-1".into(),
        resource_lease_ids: vec![],
        owner_epoch: 1,
        admitted_managed_revision: store.snapshot().revision + 1,
    };
    let stale_revision = binding.admitted_managed_revision;
    binding.admitted_managed_revision += 1;
    assert!(
        store
            .bind_attempt_delegation("stale-binding", "attempt-one", binding.clone())
            .is_err()
    );
    binding.admitted_managed_revision = stale_revision;
    store
        .bind_attempt_delegation("binding", "attempt-one", binding.clone())
        .unwrap();
    assert_eq!(
        store.snapshot().attempt_delegation_binding("attempt-one"),
        Some(&binding)
    );
    store
        .bind_attempt_delegation("binding", "attempt-one", binding.clone())
        .unwrap();
    send(
        &mut store,
        "effect-after-binding",
        ManagedCommand::BindAttemptEffect {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            effect_id: "effect-one".into(),
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    assert_eq!(store.snapshot().attempts["attempt-one"].effects.len(), 1);
    let effect_edge_revision = store.snapshot().revision;
    assert_eq!(
        store.attempt_effect_bound_revision("attempt-one", "effect-one"),
        Some(effect_edge_revision)
    );
    // A live executing Attempt is never suspended by pause under the
    // hardened admission-fence semantics, so the subsequent run-level command
    // is cancellation; it must not rewrite the durable effect edge either.
    send(
        &mut store,
        "cancel-after-effect-edge",
        ManagedCommand::RequestCancel {
            run_id: "run-v1".into(),
        },
    );
    assert!(store.snapshot().revision > effect_edge_revision);
    assert_eq!(
        store.attempt_effect_bound_revision("attempt-one", "effect-one"),
        Some(effect_edge_revision)
    );
    drop(store);

    let mut reopened = ManagedControl::open(root.path(), "goal-delegation-binding").unwrap();
    assert_eq!(
        reopened
            .snapshot()
            .attempt_delegation_binding("attempt-one"),
        Some(&binding)
    );
    assert_eq!(
        reopened.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Unknown
    );
    assert_eq!(reopened.snapshot().attempts["attempt-one"].effects.len(), 1);
    assert_eq!(
        reopened.attempt_effect_bound_revision("attempt-one", "effect-one"),
        Some(effect_edge_revision)
    );
    assert!(
        reopened
            .apply(
                reopened.snapshot().revision,
                "effect-after-restart",
                ManagedCommand::BindAttemptEffect {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    effect_id: "effect-two".into(),
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
                },
            )
            .is_err()
    );
    assert_eq!(reopened.snapshot().attempts["attempt-one"].effects.len(), 1);
}

#[test]
fn new_final_revision_invalidates_previous_verification_evidence() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-manual-edit").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_verifier_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    // Settlement itself carries the typed independent verification that marks
    // the Task verified at the exact observed workspace head.
    settle_attempt_success(
        &mut store,
        "first-task-attempt",
        "goal-manual-edit",
        "run-v1",
        "task-a",
        "attempt-one",
        'e',
        sha('a').as_str(),
    );
    send(
        &mut store,
        "verify-revision-a",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('a'),
            verifier_id: "server_auth.verifier".into(),
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
            verifier_id: "server_auth.verifier".into(),
        },
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "wrong-verifier-evidence",
                ManagedCommand::RecordCriterionEvidence {
                    run_id: "run-v1".into(),
                    criterion_id: "tests-pass".into(),
                    source_revision: sha('a'),
                    evidence_digest: sha('e'),
                    verifier_id: "server_auth.other".into(),
                }
            )
            .is_err()
    );

    // The trusted workspace observer reports a user edit before finalization.
    send(
        &mut store,
        "verify-revision-b",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('b'),
            verifier_id: "server_auth.verifier".into(),
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
                    verifier_id: "server_auth.verifier".into(),
                }
            )
            .is_err()
    );
    let revision = store.snapshot().revision;
    // The superseded sha('a') final can never finalize after the rebind.
    assert!(matches!(
        store.apply(
            revision,
            "stale-finalize",
            ManagedCommand::FinalizeRun {
                run_id: "run-v1".into(),
                final_revision: sha('a'),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    send(
        &mut store,
        "fresh-criterion-b",
        ManagedCommand::RecordCriterionEvidence {
            run_id: "run-v1".into(),
            criterion_id: "tests-pass".into(),
            source_revision: sha('b'),
            evidence_digest: sha('f'),
            verifier_id: "server_auth.verifier".into(),
        },
    );
    // Finalization is the typed per-Task aggregate, not the run-level
    // digest-only criterion audit trail; with every Task carrying typed
    // independent proof the exact frozen revision finalizes.
    send(
        &mut store,
        "final-b-typed-aggregate",
        ManagedCommand::FinalizeRun {
            run_id: "run-v1".into(),
            final_revision: sha('b'),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Succeeded);
    // SUCCEEDED is terminal: a fresh finalization key cannot reenter it.
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "finalize-after-terminal",
                ManagedCommand::FinalizeRun {
                    run_id: "run-v1".into(),
                    final_revision: sha('b'),
                }
            )
            .is_err()
    );
}

#[test]
fn admitted_attempt_cannot_pass_task_verification_without_a_settled_receipt() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-attempt-receipt").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_verifier_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    assert!(matches!(
        store.apply(
            store.snapshot().revision,
            "receipt-before-execution",
            ManagedCommand::SettleAttempt {
                run_id: "run-v1".into(),
                task_id: "task-a".into(),
                attempt_id: "attempt-one".into(),
                receipt_digest: b3('e'),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    let revision = store.snapshot().revision;

    assert!(matches!(
        store.apply(
            revision,
            "premature-verification",
            ManagedCommand::VerifyTask {
                run_id: "run-v1".into(),
                task_id: "task-a".into(),
                attempt_id: "attempt-one".into(),
                verifier_id: "server_auth.verifier".into(),
                source_revision: sha('a'),
                evidence_digest: sha('d'),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert_eq!(store.snapshot().revision, revision);
    assert_eq!(
        store.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Admitted
    );
    assert_eq!(
        store.snapshot().runs["run-v1"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-one")
    );

    let receipt_digest = settle_attempt_success(
        &mut store,
        "settle-attempt",
        "goal-attempt-receipt",
        "run-v1",
        "task-a",
        "attempt-one",
        'e',
        sha('a').as_str(),
    );
    assert_eq!(
        store.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Succeeded
    );
    assert_eq!(
        store.snapshot().attempts["attempt-one"]
            .receipt_digest
            .as_deref(),
        Some(receipt_digest.as_str())
    );
    let expected_evidence =
        fixture_verification_evidence("attempt-one", "tests-pass", sha('a').as_str());
    let verification = store.snapshot().runs["run-v1"].tasks["task-a"]
        .verification_evidence
        .as_ref()
        .expect("Task verification evidence should be durable");
    assert_eq!(verification.attempt_id, "attempt-one");
    assert_eq!(verification.source_revision, sha('a'));
    assert_eq!(
        verification.evidence_digest,
        typed_task_verification_digest(
            "task-a",
            "attempt-one",
            receipt_digest.as_str(),
            &["tests-pass".to_owned()],
            &expected_evidence,
        )
    );
    drop(store);

    let restored = ManagedControl::open(root.path(), "goal-attempt-receipt").unwrap();
    assert_eq!(
        restored.snapshot().attempts["attempt-one"]
            .receipt_digest
            .as_deref(),
        Some(receipt_digest.as_str())
    );
    let verification = restored.snapshot().runs["run-v1"].tasks["task-a"]
        .verification_evidence
        .as_ref()
        .expect("replayed Task verification evidence should be durable");
    assert_eq!(verification.attempt_id, "attempt-one");
    assert_eq!(verification.source_revision, sha('a'));
    assert_eq!(
        verification.evidence_digest,
        typed_task_verification_digest(
            "task-a",
            "attempt-one",
            receipt_digest.as_str(),
            &["tests-pass".to_owned()],
            &expected_evidence,
        )
    );
}

#[test]
fn settled_attempt_rejects_missing_or_wrong_format_receipt_reference() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-missing-receipt").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    send(
        &mut store,
        "executing",
        ManagedCommand::StartAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "settling",
        ManagedCommand::BeginAttemptSettlement {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    let revision = store.snapshot().revision;

    // The state reducer rejects absent/malformed references. It cannot
    // authenticate a well-formed reference; that remains the future trusted
    // HostKernel adapter's responsibility and is not exposed as RPC ingress.
    for (delivery_id, receipt_digest) in [
        ("missing-receipt", String::new()),
        ("wrong-receipt-algorithm", sha('a')),
    ] {
        assert!(matches!(
            store.apply(
                revision,
                delivery_id,
                ManagedCommand::SettleAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    receipt_digest,
                }
            ),
            Err(ManagedError::Invalid(_))
        ));
    }

    assert_eq!(store.snapshot().revision, revision);
    assert_eq!(
        store.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Settling
    );
    assert_eq!(
        store.snapshot().attempts["attempt-one"].receipt_digest,
        None
    );
}

#[test]
fn managed_attempt_accepts_host_receipt_reference_encoding() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-host-receipt-format").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_verifier_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    // The reducer accepts the HostKernel's exact BLAKE3 receipt reference only
    // when it equals the kernel-computed digest over the durable per-effect
    // target receipts, which the typed settlement helper derives.
    let receipt_digest = settle_attempt_success(
        &mut store,
        "record-host-receipt-reference",
        "goal-host-receipt-format",
        "run-v1",
        "task-a",
        "attempt-one",
        'a',
        sha('a').as_str(),
    );

    let attempt = &store.snapshot().attempts["attempt-one"];
    assert_eq!(attempt.phase, AttemptPhase::Succeeded);
    assert_eq!(
        attempt.receipt_digest.as_deref(),
        Some(receipt_digest.as_str())
    );
    assert!(receipt_digest.starts_with("blake3:"));
}

#[test]
fn post_dispatch_failure_requires_settled_receipt_before_retry_or_needs_you() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-settled-failure").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    send(
        &mut store,
        "attempt-one-executing",
        ManagedCommand::StartAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    let executing_revision = store.snapshot().revision;
    assert!(matches!(
        store.apply(
            executing_revision,
            "unsafe-failure-while-executing",
            ManagedCommand::FailAttempt {
                run_id: "run-v1".into(),
                task_id: "task-a".into(),
                attempt_id: "attempt-one".into(),
                failure_code: "validation-failed".into(),
                retryable: true,
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert!(matches!(
        store.apply(
            executing_revision,
            "failure-settlement-before-settling",
            ManagedCommand::SettleAttemptFailure {
                run_id: "run-v1".into(),
                task_id: "task-a".into(),
                attempt_id: "attempt-one".into(),
                failure_code: "validation-failed".into(),
                retryable: true,
                receipt_digest: Some(b3('b')),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert_eq!(store.snapshot().revision, executing_revision);
    send(
        &mut store,
        "attempt-one-settling",
        ManagedCommand::BeginAttemptSettlement {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );

    let revision = store.snapshot().revision;
    assert!(matches!(
        store.apply(
            revision,
            "unsafe-failure-without-receipt",
            ManagedCommand::FailAttempt {
                run_id: "run-v1".into(),
                task_id: "task-a".into(),
                attempt_id: "attempt-one".into(),
                failure_code: "validation-failed".into(),
                retryable: true,
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert_eq!(store.snapshot().revision, revision);
    assert_eq!(
        store.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Settling
    );
    assert_eq!(
        store.snapshot().runs["run-v1"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-one")
    );

    for (delivery_id, receipt_digest) in [
        ("failure-missing-receipt", String::new()),
        ("failure-wrong-receipt-algorithm", sha('c')),
    ] {
        // An empty or non-BLAKE3 receipt is refused before any durable write; a
        // pre-dispatch failure simply omits the receipt instead of sending a malformed one.
        assert!(matches!(
            store.apply(
                revision,
                delivery_id,
                ManagedCommand::SettleAttemptFailure {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    failure_code: "validation-failed".into(),
                    retryable: true,
                    receipt_digest: Some(receipt_digest),
                }
            ),
            Err(ManagedError::Invalid(_))
        ));
    }

    let failed_attempt = ManagedCommand::SettleAttemptFailure {
        run_id: "run-v1".into(),
        task_id: "task-a".into(),
        attempt_id: "attempt-one".into(),
        failure_code: "validation-failed".into(),
        retryable: true,
        receipt_digest: Some(b3('b')),
    };
    let settlement_revision = store.snapshot().revision;
    store
        .apply(
            settlement_revision,
            "attempt-one-settled-failure",
            failed_attempt.clone(),
        )
        .unwrap();
    let failed = &store.snapshot().attempts["attempt-one"];
    assert_eq!(failed.phase, AttemptPhase::Failed);
    assert_eq!(failed.failure_code.as_deref(), Some("validation-failed"));
    assert_eq!(failed.retryable, Some(true));
    assert_eq!(failed.receipt_digest.as_deref(), Some(b3('b').as_str()));
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Running);
    assert!(store.snapshot().runs["run-v1"].tasks["task-a"].ready);

    let revision_after_settlement = store.snapshot().revision;
    store
        .apply(
            settlement_revision,
            "attempt-one-settled-failure",
            failed_attempt,
        )
        .unwrap();
    assert_eq!(store.snapshot().revision, revision_after_settlement);
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-settled-failure").unwrap();
    assert_eq!(
        restored.snapshot().attempts["attempt-one"]
            .receipt_digest
            .as_deref(),
        Some(b3('b').as_str())
    );
    send(
        &mut restored,
        "attempt-two",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-two".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    send(
        &mut restored,
        "attempt-two-executing",
        ManagedCommand::StartAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-two".into(),
        },
    );
    send(
        &mut restored,
        "attempt-two-settling",
        ManagedCommand::BeginAttemptSettlement {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-two".into(),
        },
    );
    send(
        &mut restored,
        "attempt-two-settled-failure",
        ManagedCommand::SettleAttemptFailure {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-two".into(),
            failure_code: "validation-failed".into(),
            retryable: false,
            receipt_digest: Some(b3('c')),
        },
    );
    assert_eq!(
        restored.snapshot().attempts["attempt-two"].phase,
        AttemptPhase::Failed
    );
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::NeedsYou);
    assert!(!restored.snapshot().runs["run-v1"].tasks["task-a"].ready);
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "attempt-three",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-three".into(),
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
                }
            )
            .is_err()
    );
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
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
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
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
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
                    required_capabilities: vec![],
                }
            )
            .is_err()
    );
}

#[test]
fn cancelling_run_preserves_unknown_attempt_and_cancel_fence_after_restart() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-cancel-unknown").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    send(
        &mut store,
        "cancel",
        ManagedCommand::RequestCancel {
            run_id: "run-v1".into(),
        },
    );
    let unknown_revision = store.snapshot().revision;
    let unknown_command = ManagedCommand::MarkAttemptUnknown {
        run_id: "run-v1".into(),
        task_id: "task-a".into(),
        attempt_id: "attempt-one".into(),
    };
    store
        .apply(unknown_revision, "unknown", unknown_command.clone())
        .unwrap();
    let revision_after_unknown = store.snapshot().revision;
    store
        .apply(unknown_revision, "unknown", unknown_command)
        .unwrap();
    assert_eq!(store.snapshot().revision, revision_after_unknown);

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
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
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
fn unknown_settling_attempt_replays_and_remains_fenced_after_restart() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-settling-unknown").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    send(
        &mut store,
        "executing",
        ManagedCommand::StartAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );
    send(
        &mut store,
        "settling",
        ManagedCommand::BeginAttemptSettlement {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
        },
    );

    let unknown_revision = store.snapshot().revision;
    let unknown_command = ManagedCommand::MarkAttemptUnknown {
        run_id: "run-v1".into(),
        task_id: "task-a".into(),
        attempt_id: "attempt-one".into(),
    };
    store
        .apply(unknown_revision, "unknown", unknown_command.clone())
        .unwrap();
    let revision_after_unknown = store.snapshot().revision;
    store
        .apply(unknown_revision, "unknown", unknown_command)
        .unwrap();
    assert_eq!(store.snapshot().revision, revision_after_unknown);
    assert!(
        store
            .apply(
                revision_after_unknown,
                "unknown-id-reuse",
                ManagedCommand::SettleAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    receipt_digest: b3('a'),
                }
            )
            .is_err()
    );
    assert!(
        store
            .apply(
                revision_after_unknown,
                "failure-after-unknown",
                ManagedCommand::SettleAttemptFailure {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    failure_code: "guessed-failure".into(),
                    retryable: true,
                    receipt_digest: Some(b3('d')),
                }
            )
            .is_err()
    );
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-settling-unknown").unwrap();
    let task = &restored.snapshot().runs["run-v1"].tasks["task-a"];
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Reconciling
    );
    assert_eq!(
        restored.snapshot().attempts["attempt-one"].phase,
        AttemptPhase::Unknown
    );
    assert!(task.unknown_effect);
    assert_eq!(task.active_attempt.as_deref(), Some("attempt-one"));
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "retry-after-settling-unknown",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-two".into(),
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "resume-after-settling-unknown",
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
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    send(
        &mut store,
        "executing",
        ManagedCommand::StartAttempt {
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
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
                }
            )
            .is_err()
    );
}

#[test]
fn unknown_attempt_during_pause_moves_run_to_reconciliation_and_blocks_resume() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-paused-unknown").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    // Pause is a durable admission fence taken before dispatch; the hardened
    // reducer never suspends a live Attempt, so the UNKNOWN Attempt is
    // admitted only after the fence is explicitly resumed.
    send(
        &mut store,
        "pause",
        ManagedCommand::PauseRun {
            run_id: "run-v1".into(),
        },
    );
    assert_eq!(store.snapshot().runs["run-v1"].phase, RunPhase::Paused);
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "blocked-attempt",
                ManagedCommand::AdmitAttempt {
                    run_id: "run-v1".into(),
                    task_id: "task-a".into(),
                    attempt_id: "attempt-one".into(),
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
                }
            )
            .is_err()
    );
    send(
        &mut store,
        "resume",
        ManagedCommand::ResumeRun {
            run_id: "run-v1".into(),
        },
    );
    send(
        &mut store,
        "admit",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
    accepted_planned_run(
        &mut store,
        1,
        vec![
            fixture_planned_task("task-a", &[], &["tests-pass"]),
            fixture_planned_task("task-b", &["task-a"], &[]),
        ],
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
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
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
                    required_capabilities: vec![],
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
                    required_capabilities: vec![],
                }
            )
            .is_err()
    );
}

#[test]
fn spec_max_workers_caps_concurrent_attempt_admission() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-worker-cap").unwrap();
    // The planned set covers the single accepted criterion exactly once; the
    // second Task is unpinned-criteria work that never settles in this test.
    accepted_planned_run(
        &mut store,
        1,
        vec![
            fixture_planned_task("task-a", &[], &["tests-pass"]),
            fixture_planned_task("task-b", &[], &[]),
        ],
    );
    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
                executor_principal: "server_auth.executor".into(),
                owner_epoch: 1,
                location_id: "test-location".into(),
                session_id: "test-session".into(),
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
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
fn managed_single_attempt_gate_prevents_fanout_even_when_spec_budget_allows_it() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-single-attempt").unwrap();
    // The fanout fence is the distinct-Location invariant, not the worker
    // budget: both fixture Attempts deliberately name the same Location, so
    // the second admission must fail even with two worker slots.
    accepted_planned_run(
        &mut store,
        2,
        vec![
            fixture_verifier_task("task-a", &[], &["tests-pass"]),
            fixture_planned_task("task-b", &[], &[]),
        ],
    );

    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    let revision = store.snapshot().revision;
    assert!(matches!(
        store.apply(
            revision,
            "attempt-two-before-verification",
            ManagedCommand::AdmitAttempt {
                run_id: "run-v1".into(),
                task_id: "task-b".into(),
                attempt_id: "attempt-two".into(),
                executor_principal: "server_auth.executor".into(),
                owner_epoch: 1,
                location_id: "test-location".into(),
                session_id: "test-session".into(),
            }
        ),
        Err(ManagedError::Conflict(_))
    ));
    assert_eq!(store.snapshot().revision, revision);
    assert!(!store.snapshot().attempts.contains_key("attempt-two"));

    // Typed settlement carries the independent verification atomically: there
    // is no durable settled-but-unverified state, so the fanout fence is the
    // live Attempt itself, and only the verified settlement frees the slot.
    settle_attempt_success(
        &mut store,
        "settle-attempt-one",
        "goal-single-attempt",
        "run-v1",
        "task-a",
        "attempt-one",
        'e',
        sha('a').as_str(),
    );
    assert_eq!(
        store.snapshot().runs["run-v1"].tasks["task-a"]
            .verified_revision
            .as_deref(),
        Some(sha('a').as_str())
    );

    send(
        &mut store,
        "attempt-two-after-independent-verification",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            attempt_id: "attempt-two".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
fn scheduler_selects_one_deterministic_ready_task_only_after_prior_verification() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-scheduler-candidate").unwrap();
    // Single-worker fixture: the deterministic selector must offer nothing
    // while the prior Attempt is live, and only its independently verified
    // settlement frees the slot for the next candidate.
    accepted_planned_run(
        &mut store,
        1,
        vec![
            fixture_verifier_task("task-a", &[], &["tests-pass"]),
            fixture_planned_task("task-b", &[], &[]),
        ],
    );
    assert_eq!(
        store.snapshot().next_schedulable_task("run-v1"),
        Some("task-a".into())
    );

    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    assert_eq!(store.snapshot().next_schedulable_task("run-v1"), None);
    // Typed settlement verifies the completed Task atomically; only then does
    // the deterministic selector offer the next ready candidate.
    settle_attempt_success(
        &mut store,
        "settle-attempt-one",
        "goal-scheduler-candidate",
        "run-v1",
        "task-a",
        "attempt-one",
        'e',
        sha('a').as_str(),
    );
    assert_eq!(
        store.snapshot().next_schedulable_task("run-v1"),
        Some("task-b".into())
    );
    send(
        &mut store,
        "pause",
        ManagedCommand::PauseRun {
            run_id: "run-v1".into(),
        },
    );
    assert_eq!(store.snapshot().next_schedulable_task("run-v1"), None);
}

#[test]
fn scheduler_skips_lexically_first_task_until_dependency_is_verified() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-scheduler-dependency").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![
            fixture_verifier_task("task-z-source", &[], &["tests-pass"]),
            fixture_planned_task("task-a-dependent", &["task-z-source"], &[]),
        ],
    );
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "ready-dependent-too-early",
                ManagedCommand::MarkTaskReady {
                    run_id: "run-v1".into(),
                    task_id: "task-a-dependent".into(),
                }
            )
            .is_err()
    );
    assert_eq!(
        store.snapshot().next_schedulable_task("run-v1"),
        Some("task-z-source".into())
    );

    send(
        &mut store,
        "source-attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-z-source".into(),
            attempt_id: "source-attempt".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    // The typed settlement verifies the source Task and derives the dependent
    // Task's readiness from that durable PASS evidence in the same transition.
    settle_attempt_success(
        &mut store,
        "settle-source-attempt",
        "goal-scheduler-dependency",
        "run-v1",
        "task-z-source",
        "source-attempt",
        'e',
        sha('a').as_str(),
    );
    assert!(
        store.snapshot().runs["run-v1"].tasks["task-a-dependent"]
            .ready
    );
    assert_eq!(
        store.snapshot().next_schedulable_task("run-v1"),
        Some("task-a-dependent".into())
    );
}

#[test]
fn pause_is_a_durable_admission_fence_and_resume_restores_only_safe_work() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-paused").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
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
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
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
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    assert_eq!(restored.snapshot().runs["run-v1"].phase, RunPhase::Running);
}

#[test]
fn restarting_with_admitted_but_unsettled_attempt_fences_execution_as_unknown() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-crash").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
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
fn verified_task_unblocks_dependency_but_digest_only_evidence_cannot_finalize_run() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-verified").unwrap();
    // Both Tasks settle through the effect/delegation fixture, so each must
    // carry an accepted criterion, and the planned set covers every accepted
    // criterion exactly once.
    let mut two_criteria = spec("server_auth.author", 2);
    two_criteria.criteria.push(AcceptanceCriterion {
        id: "docs-match".into(),
        description: "The fixture documentation matches the change".into(),
    });
    accepted_spec(&mut store, two_criteria);
    plan_and_start_run(
        &mut store,
        "run-v1",
        vec![
            fixture_verifier_task("task-a", &[], &["tests-pass"]),
            fixture_verifier_task("task-b", &["task-a"], &["docs-match"]),
        ],
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
        "attempt-a",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "a-1".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    // Typed settlement verifies task-a and derives task-b's readiness from
    // that durable PASS evidence in the same transition.
    settle_attempt_success(
        &mut store,
        "task-a-attempt",
        "goal-verified",
        "run-v1",
        "task-a",
        "a-1",
        'e',
        sha('a').as_str(),
    );
    assert_eq!(
        store.snapshot().runs["run-v1"].tasks["task-b"].ready,
        true
    );
    send(
        &mut store,
        "attempt-b",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            attempt_id: "b-1".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
                    verifier_id: "server_auth.verifier".into(),
                }
            )
            .is_err()
    );
    // The second typed settlement verifies task-b at its own observed head.
    settle_attempt_success(
        &mut store,
        "task-b-attempt",
        "goal-verified",
        "run-v1",
        "task-b",
        "b-1",
        'd',
        sha('b').as_str(),
    );
    send(
        &mut store,
        "verifying",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('b'),
            verifier_id: "server_auth.verifier".into(),
        },
    );
    // The typed per-Task aggregate is the finalization basis; run-level
    // digest-only criterion evidence is an audit trail, not the proof, so
    // there is no settled-but-unfinalizable gap at this point.
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
                    verifier_id: "server_auth.verifier".into(),
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
            verifier_id: "server_auth.verifier".into(),
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
    assert_eq!(
        restored.snapshot().attempts["a-1"].phase,
        AttemptPhase::Succeeded
    );
    assert_eq!(
        restored.snapshot().attempts["b-1"].phase,
        AttemptPhase::Succeeded
    );
    // Finalization replays the typed per-Task aggregate; the run-level
    // digest-only criterion audit trail is never the deciding proof.
    send(
        &mut restored,
        "final-with-typed-aggregate",
        ManagedCommand::FinalizeRun {
            run_id: "run-v1".into(),
            final_revision: sha('b'),
        },
    );
    assert_eq!(
        restored.snapshot().runs["run-v1"].phase,
        RunPhase::Succeeded
    );
    // SUCCEEDED is terminal: neither a fresh finalization key nor a late
    // cancellation can reenter the finished Run.
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "finalize-after-terminal",
                ManagedCommand::FinalizeRun {
                    run_id: "run-v1".into(),
                    final_revision: sha('b'),
                }
            )
            .is_err()
    );
    assert!(
        restored
            .apply(
                restored.snapshot().revision,
                "cancel-after-terminal",
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
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "a-1".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
                    verifier_id: "server_auth.verifier".into(),
                }
            )
            .is_err()
    );
}

#[test]
fn cancelling_run_unknown_attempt_cannot_settle_verify_or_finalize() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-cancel-settle").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
                    verifier_id: "server_auth.verifier".into(),
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
                    verifier_id: "server_auth.verifier".into(),
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
                    required_capabilities: vec![],
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
                    verifier_id: "server_auth.verifier".into(),
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
    accepted_spec(&mut store, spec("server_auth.author", 2));

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
    plan_and_start_run(
        &mut store,
        "run-verifying",
        vec![fixture_verifier_task("task-v", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt-verifying",
        ManagedCommand::AdmitAttempt {
            run_id: "run-verifying".into(),
            task_id: "task-v".into(),
            attempt_id: "attempt-v".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    // Typed settlement itself carries the independent verification that marks
    // task-v verified at the observed head.
    settle_attempt_success(
        &mut store,
        "verifying-attempt",
        "goal-cancel-matrix",
        "run-verifying",
        "task-v",
        "attempt-v",
        'e',
        sha('a').as_str(),
    );
    send(
        &mut store,
        "begin-verifying",
        ManagedCommand::BeginVerification {
            run_id: "run-verifying".into(),
            final_revision: sha('a'),
            verifier_id: "server_auth.verifier".into(),
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
                    verifier_id: "server_auth.verifier".into(),
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

    // NEEDS_YOU parks the Run on a missing human answer, but it owns no live
    // Attempt: an abandoned question must cancel through the same durable saga
    // as every other phase instead of absorbing the lifecycle forever.
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
    send(
        &mut store,
        "cancel-needs-you",
        ManagedCommand::RequestCancel {
            run_id: "run-needs-you".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-needs-you"].phase,
        RunPhase::Cancelling
    );
    send(
        &mut store,
        "complete-cancel-needs-you",
        ManagedCommand::CompleteCancel {
            run_id: "run-needs-you".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-needs-you"].phase,
        RunPhase::Cancelled
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
        RunPhase::Cancelled
    );
    assert!(
        restored.snapshot().runs["run-verifying"]
            .criterion_evidence
            .is_empty()
    );
}

/// NEEDS_YOU parks a Run on a missing human answer; it must not be an absorbing
/// state. A parked Run owns no live Attempt or UNKNOWN effect, so a human can
/// abandon it (cancel to a terminal Run) or answer it (resume the Run) instead of
/// leaving it pinned forever.
#[test]
fn needs_you_run_resumes_or_cancels_instead_of_absorbing_the_lifecycle() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-needs-you-lifecycle").unwrap();
    accepted_spec(&mut store, spec("server_auth.author", 2));

    // An abandoned question cancels through the normal durable saga and becomes
    // terminal CANCELLED.
    send(
        &mut store,
        "start-cancel",
        ManagedCommand::StartRun {
            run_id: "run-parked-cancel".into(),
            spec_id: "spec-v1".into(),
        },
    );
    send(
        &mut store,
        "park-cancel",
        ManagedCommand::NeedsYou {
            run_id: "run-parked-cancel".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-parked-cancel"].phase,
        RunPhase::NeedsYou
    );
    send(
        &mut store,
        "cancel-parked",
        ManagedCommand::RequestCancel {
            run_id: "run-parked-cancel".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-parked-cancel"].phase,
        RunPhase::Cancelling
    );
    send(
        &mut store,
        "complete-parked-cancel",
        ManagedCommand::CompleteCancel {
            run_id: "run-parked-cancel".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-parked-cancel"].phase,
        RunPhase::Cancelled
    );

    // An answered question reopens the same Run: the human answer itself lives
    // outside this reducer, but reopening the Run must be a legal transition.
    send(
        &mut store,
        "start-resume",
        ManagedCommand::StartRun {
            run_id: "run-parked-resume".into(),
            spec_id: "spec-v1".into(),
        },
    );
    send(
        &mut store,
        "park-resume",
        ManagedCommand::NeedsYou {
            run_id: "run-parked-resume".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-parked-resume"].phase,
        RunPhase::NeedsYou
    );
    send(
        &mut store,
        "resume-parked",
        ManagedCommand::ResumeRun {
            run_id: "run-parked-resume".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-parked-resume"].phase,
        RunPhase::Running
    );

    // The new resume path is still fenced by terminal phases: a cancelled Run
    // never reopens.
    assert!(
        store
            .apply(
                store.snapshot().revision,
                "resume-cancelled",
                ManagedCommand::ResumeRun {
                    run_id: "run-parked-cancel".into(),
                }
            )
            .is_err()
    );
    drop(store);

    // Both outcomes are durable across reopen.
    let restored = ManagedControl::open(root.path(), "goal-needs-you-lifecycle").unwrap();
    assert_eq!(
        restored.snapshot().runs["run-parked-cancel"].phase,
        RunPhase::Cancelled
    );
    assert_eq!(
        restored.snapshot().runs["run-parked-resume"].phase,
        RunPhase::Running
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
    accepted_spec(&mut store, spec("server_auth.author", 2));
    // Attempt identity is owner-log global, but the worker budget is per Run;
    // both Runs are independently planned and pinned by explicit start.
    plan_and_start_run(
        &mut store,
        "run-v1",
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    plan_and_start_run(
        &mut store,
        "run-v2",
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
                executor_principal: "server_auth.executor".into(),
                owner_epoch: 1,
                location_id: "test-location".into(),
                session_id: "test-session".into(),
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
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    assert_eq!(
        store.snapshot().runs["run-v2"].tasks["task-a"]
            .active_attempt
            .as_deref(),
        Some("attempt-two")
    );

    // Settlement must name the Task that owns the active Attempt. A Task
    // added after the explicit start still pins its immutable profile and
    // positive budget at creation, and is not ready until marked.
    send(
        &mut store,
        "task-b",
        ManagedCommand::AddTaskPinnedProfile {
            run_id: "run-v1".into(),
            task_id: "task-b".into(),
            dependencies: vec![],
            criterion_ids: vec![],
            required_capabilities: vec![],
            agent_profile_revision: fixture_profile_revision(),
            profile_token_budget: 16_000,
            profile_owner_binding_digest: b3('b'),
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
                verifier_id: "server_auth.verifier".into(),
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
                verifier_id: "server_auth.verifier".into(),
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
    accepted_planned_run(
        &mut store,
        1,
        vec![
            fixture_planned_task("task-a", &[], &["tests-pass"]),
            fixture_planned_task("task-b", &["task-a"], &[]),
        ],
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
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
                    executor_principal: "server_auth.executor".into(),
                    owner_epoch: 1,
                    location_id: "test-location".into(),
                    session_id: "test-session".into(),
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
    accepted_spec(&mut store, spec("server_auth.author", 2));

    // An unsettled admitted Attempt keeps CANCELLING fenced.
    plan_and_start_run(
        &mut store,
        "run-blocked",
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt-blocked",
        ManagedCommand::AdmitAttempt {
            run_id: "run-blocked".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
    plan_and_start_run(
        &mut store,
        "run-settled",
        vec![fixture_planned_task("task-b", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt-settled",
        ManagedCommand::AdmitAttempt {
            run_id: "run-settled".into(),
            task_id: "task-b".into(),
            attempt_id: "attempt-two".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
                executor_principal: "server_auth.executor".into(),
                owner_epoch: 1,
                location_id: "test-location".into(),
                session_id: "test-session".into(),
            },
        ),
        (
            "add-task-cancelled",
            ManagedCommand::AddTask {
                run_id: "run-settled".into(),
                task_id: "task-c".into(),
                dependencies: vec![],
                criterion_ids: vec![],
                required_capabilities: vec![],
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
                verifier_id: "server_auth.verifier".into(),
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
fn verification_can_rebind_after_restart_only_without_current_revision_evidence() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-verification-rebind").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_verifier_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    // Typed settlement itself marks task-a verified at the observed head.
    settle_attempt_success(
        &mut store,
        "settle",
        "goal-verification-rebind",
        "run-v1",
        "task-a",
        "attempt-one",
        'e',
        sha('a').as_str(),
    );
    send(
        &mut store,
        "begin-verification",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('a'),
            verifier_id: "server_auth.verifier".into(),
        },
    );
    drop(store);

    let mut restored = ManagedControl::open(root.path(), "goal-verification-rebind").unwrap();
    let before_retry_revision = {
        let before_retry = restored.snapshot();
        let run = &before_retry.runs["run-v1"];
        assert_eq!(run.phase, RunPhase::Verifying);
        assert_eq!(run.final_revision.as_deref(), Some(sha('a').as_str()));
        assert_eq!(run.verifier_id.as_deref(), Some("server_auth.verifier"));
        assert!(run.criterion_evidence.is_empty());
        before_retry.revision
    };

    let retry = restored.apply(
        before_retry_revision,
        "begin-verification-after-restart",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('a'),
            verifier_id: "server_auth.verifier".into(),
        },
    );
    assert!(
        retry.is_ok(),
        "a clean same-revision verifier run should rebind after restart"
    );
    let rebound_revision = {
        let rebound = restored.snapshot();
        assert_eq!(rebound.revision, before_retry_revision + 1);
        assert_eq!(rebound.runs["run-v1"].phase, RunPhase::Verifying);
        assert_eq!(
            rebound.runs["run-v1"].final_revision.as_deref(),
            Some(sha('a').as_str())
        );
        assert!(rebound.runs["run-v1"].criterion_evidence.is_empty());
        rebound.revision
    };

    restored
        .apply(
            rebound_revision,
            "record-current-criterion-evidence",
            ManagedCommand::RecordCriterionEvidence {
                run_id: "run-v1".into(),
                criterion_id: "tests-pass".into(),
                source_revision: sha('a'),
                evidence_digest: sha('f'),
                verifier_id: "server_auth.verifier".into(),
            },
        )
        .unwrap();
    let before_evidence_retry_revision = restored.snapshot().revision;
    assert!(
        restored
            .apply(
                before_evidence_retry_revision,
                "begin-verification-with-evidence",
                ManagedCommand::BeginVerification {
                    run_id: "run-v1".into(),
                    final_revision: sha('a'),
                    verifier_id: "server_auth.verifier".into(),
                },
            )
            .is_err()
    );
    assert_eq!(restored.snapshot().revision, before_evidence_retry_revision);
}

#[test]
fn fail_run_from_verifying_records_bounded_code_and_is_terminal() {
    let root = PrivateRoot::new();
    let mut store = ManagedControl::open(root.path(), "goal-fail-verify").unwrap();
    accepted_planned_run(
        &mut store,
        1,
        vec![fixture_verifier_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
        },
    );
    // Typed settlement itself marks task-a verified at the observed head.
    settle_attempt_success(
        &mut store,
        "verifying-attempt",
        "goal-fail-verify",
        "run-v1",
        "task-a",
        "attempt-one",
        'e',
        sha('a').as_str(),
    );
    send(
        &mut store,
        "verifying",
        ManagedCommand::BeginVerification {
            run_id: "run-v1".into(),
            final_revision: sha('a'),
            verifier_id: "server_auth.verifier".into(),
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
                verifier_id: "server_auth.verifier".into(),
            },
        ),
        (
            "evidence-failed",
            ManagedCommand::RecordCriterionEvidence {
                run_id: "run-v1".into(),
                criterion_id: "tests-pass".into(),
                source_revision: sha('a'),
                evidence_digest: sha('e'),
                verifier_id: "server_auth.verifier".into(),
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
                required_capabilities: vec![],
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
    accepted_spec(&mut store, spec("server_auth.author", 2));
    plan_and_start_run(
        &mut store,
        "run-v1",
        vec![fixture_planned_task("task-a", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt-one",
        ManagedCommand::AdmitAttempt {
            run_id: "run-v1".into(),
            task_id: "task-a".into(),
            attempt_id: "attempt-one".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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
    plan_and_start_run(
        &mut store,
        "run-cancelling",
        vec![fixture_planned_task("task-c", &[], &["tests-pass"])],
    );
    send(
        &mut store,
        "attempt-c",
        ManagedCommand::AdmitAttempt {
            run_id: "run-cancelling".into(),
            task_id: "task-c".into(),
            attempt_id: "attempt-c".into(),
            executor_principal: "server_auth.executor".into(),
            owner_epoch: 1,
            location_id: "test-location".into(),
            session_id: "test-session".into(),
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

/// §11.18: durable replay must fail closed on a physically well-formed event
/// that the owner log cannot distinguish from a trusted commit. Unknown kinds
/// and malformed payloads for known kinds must never be silently ignored or
/// partially applied; `ManagedControl::open` must refuse the stream.
#[test]
fn forged_or_unknown_durable_events_fail_closed_on_replay() {
    let cases: [(&str, &str, serde_json::Value); 3] = [
        // Unknown kind with a structurally valid, empty payload.
        ("unknown-kind", "goal_deleted", json!({})),
        // Known kind whose payload passes the dispatch guard but fails nested validation.
        ("malformed-known-kind", "goal_created", json!({"goal": {}})),
        // Known kind with a wrong-typed field.
        ("wrong-typed-field", "run_paused", json!({"runId": 42})),
    ];

    for (name, kind, payload) in cases {
        let root = PrivateRoot::new();
        let goal_id = format!("goal-forged-{name}");
        {
            let mut log = OwnerLogV2::open(
                root.path(),
                OwnerIdentity::new("managed_goal".to_owned(), goal_id.clone()).unwrap(),
                DurabilityProfile::RunDurable,
            )
            .unwrap();
            let event = OwnerEventInput {
                schema_version: 1,
                time_ms: 1_700_000_000_000,
                kind: kind.to_owned(),
                data: payload,
                delivery_id: None,
                command_digest: None,
            };
            let delivery_id = "forged-delivery-1";
            let digest = OwnerLogV2::command_digest(delivery_id, &[event.clone()]).unwrap();
            log.append_batch(delivery_id, &digest, &[event], None)
                .unwrap();
        }

        let error = match ManagedControl::open(root.path(), &goal_id) {
            Ok(_) => panic!("case {name}: forged durable event was accepted on replay"),
            Err(error) => error,
        };
        assert!(
            matches!(error, ManagedError::Invalid(_)),
            "case {name}: expected fail-closed Invalid at replay, got {error:?}"
        );
    }
}
