//! Task-DAG admission, readiness and result-ingestion wire tests.
//!
//! Covers the §32.33 JC-RES-018 style invariants owned by this substrate:
//! cycle/cross-Run rejection before persistence, breadth/member/depth caps,
//! typed artifact edges, revision-bound independent verification, late child
//! and duplicate delivery handling (§21.11 / §29.18).

#[path = "../src/task_dag.rs"]
mod task_dag;

use std::collections::BTreeMap;

use task_dag::{
    ArtifactFidelity, ArtifactRefV1, ArtifactRequirementV1, CandidateErrorV1,
    CandidateTaskResultV1, DagError, DagLimits, DeliveryEnvelopeV1, EstimatedUsage, GraphBinding,
    TaskNodeDraft, TaskPhase, TaskProposalV1, TaskResultStatus, TaskRunState, TouchedAccess,
    TouchedFileV1, ValidatedTaskGraph, VerificationVerdictV1, apply_cancel,
};

const REVISION: &str = "rev-1";

fn digest(seed: char) -> String {
    format!("blake3:{}", seed.to_string().repeat(64))
}

fn sha(seed: char) -> String {
    seed.to_string().repeat(64)
}

fn binding() -> GraphBinding {
    GraphBinding {
        accepted_spec_digest: digest('a'),
        parent_scope_digest: digest('b'),
    }
}

fn draft(task_id: &str) -> TaskNodeDraft {
    TaskNodeDraft {
        task_id: task_id.to_owned(),
        title: format!("task {task_id}"),
        purpose: "bounded unit of work".to_owned(),
        dependencies: Vec::new(),
        criterion_ids: vec!["crit-1".to_owned()],
        input_artifacts: Vec::new(),
        output_artifact_kinds: Vec::new(),
        read_scopes: Vec::new(),
        write_scopes: vec![format!("src/{task_id}/**")],
        read_only: false,
        requires_tools: vec!["files.patch".to_owned()],
        requested_profile: "builder".to_owned(),
        estimated_usage: EstimatedUsage::default(),
    }
}

fn proposal(tasks: Vec<TaskNodeDraft>) -> TaskProposalV1 {
    TaskProposalV1 {
        run_id: "run-1".to_owned(),
        expected_graph_revision: "rev-1".to_owned(),
        base_graph_revision: "rev-1".to_owned(),
        accepted_criteria: vec!["crit-1".to_owned()],
        criteria_deferred: false,
        tasks,
    }
}

fn compile(tasks: Vec<TaskNodeDraft>) -> Result<ValidatedTaskGraph, DagError> {
    ValidatedTaskGraph::compile(proposal(tasks), binding(), DagLimits::default())
}

fn running_state(task_id: &str) -> TaskRunState {
    TaskRunState {
        phase: TaskPhase::Running,
        attempt_id: Some(format!("attempt-{task_id}")),
        worker_execution_id: Some(format!("worker-{task_id}")),
        owner_epoch: Some(7),
        attempt_revision: Some(REVISION.to_owned()),
        ..TaskRunState::default()
    }
}

fn envelope(task_id: &str) -> DeliveryEnvelopeV1 {
    DeliveryEnvelopeV1 {
        run_id: "run-1".to_owned(),
        task_id: task_id.to_owned(),
        attempt_id: format!("attempt-{task_id}"),
        worker_execution_id: format!("worker-{task_id}"),
        owner_epoch: 7,
        accepted_spec_digest: digest('a'),
        source_revision: REVISION.to_owned(),
        parent_scope_digest: digest('b'),
        dependency_artifact_refs: Vec::new(),
        deadline_ms: 60_000,
    }
}

fn produced_result(task_id: &str) -> CandidateTaskResultV1 {
    CandidateTaskResultV1 {
        attempt_id: format!("attempt-{task_id}"),
        worker_execution_id: format!("worker-{task_id}"),
        status: TaskResultStatus::Produced,
        artifacts: Vec::new(),
        touched_files: vec![TouchedFileV1 {
            path_ref: "src/task-a/a.rs".to_owned(),
            source_revision: REVISION.to_owned(),
            access: TouchedAccess::Write,
        }],
        tool_receipt_refs: vec!["receipt-a".to_owned()],
        proposed_evidence_refs: Vec::new(),
        missing_criteria_ids: Vec::new(),
        errors: Vec::new(),
    }
}

#[test]
fn cycles_cross_run_and_self_edges_are_rejected_before_persist() {
    let mut first = draft("task-a");
    first.dependencies = vec!["task-b".to_owned()];
    let mut second = draft("task-b");
    second.dependencies = vec!["task-c".to_owned()];
    let mut third = draft("task-c");
    third.dependencies = vec!["task-a".to_owned()];
    assert_eq!(
        compile(vec![first, second, third]),
        Err(DagError::GraphCycle)
    );

    let mut self_edge = draft("task-a");
    self_edge.dependencies = vec!["task-a".to_owned()];
    assert_eq!(compile(vec![self_edge]), Err(DagError::SelfDependency));

    // A dependency outside this Run's proposal is not resolvable here.
    let mut cross_run = draft("task-a");
    cross_run.dependencies = vec!["task-from-another-run".to_owned()];
    assert_eq!(compile(vec![cross_run]), Err(DagError::UnknownDependency));

    let mut duplicate = draft("task-a");
    duplicate.title = "second".to_owned();
    assert_eq!(
        compile(vec![draft("task-a"), duplicate]),
        Err(DagError::DuplicateTask)
    );
}

#[test]
fn member_depth_and_breadth_caps_are_enforced() {
    // 21 members beyond the configured 20 cap.
    let members: Vec<TaskNodeDraft> = (0..21)
        .map(|index| draft(&format!("task-{index:02}")))
        .collect();
    assert_eq!(compile(members), Err(DagError::MemberLimitExceeded));

    // A tenth dependent level beyond the configured depth of 8.
    let chain: Vec<TaskNodeDraft> = (0..10)
        .map(|index| {
            let mut node = draft(&format!("task-{index}"));
            if index > 0 {
                node.dependencies = vec![format!("task-{}", index - 1)];
            }
            node
        })
        .collect();
    assert_eq!(compile(chain), Err(DagError::DepthLimitExceeded));

    // A 21st direct child beyond the configured breadth of 20 (member cap
    // raised so the breadth rule is the one under test).
    let children: Vec<TaskNodeDraft> = (0..21)
        .map(|index| draft(&format!("child-{index:02}")))
        .collect();
    let mut parent = draft("parent");
    parent.dependencies = children.iter().map(|child| child.task_id.clone()).collect();
    let mut tasks = children;
    tasks.push(parent);
    assert_eq!(
        ValidatedTaskGraph::compile(
            proposal(tasks),
            binding(),
            DagLimits {
                max_members: 32,
                max_depth: 8,
                max_children_per_task: 20,
            }
        ),
        Err(DagError::ChildLimitExceeded)
    );
}

#[test]
fn criterion_coverage_and_invented_criteria_are_rejected() {
    let mut task = draft("task-a");
    task.criterion_ids = vec!["crit-invented".to_owned()];
    assert_eq!(compile(vec![task]), Err(DagError::UnknownCriterion));

    let mut uncovered = proposal(vec![draft("task-a")]);
    uncovered.accepted_criteria = vec!["crit-1".to_owned(), "crit-2".to_owned()];
    assert_eq!(
        ValidatedTaskGraph::compile(uncovered, binding(), DagLimits::default()),
        Err(DagError::CriteriaUncovered)
    );

    let mut deferred = proposal(vec![draft("task-a")]);
    deferred.accepted_criteria = vec!["crit-1".to_owned(), "crit-2".to_owned()];
    deferred.criteria_deferred = true;
    let graph = ValidatedTaskGraph::compile(deferred, binding(), DagLimits::default())
        .expect("explicit user deferral permits uncovered criteria");
    assert_eq!(graph.uncovered_criteria(), &["crit-2".to_owned()]);
    assert!(graph.criteria_deferred());
}

#[test]
fn typed_artifact_edges_must_match_a_declared_producer_output() {
    let mut producer = draft("producer");
    producer.output_artifact_kinds = vec!["patch".to_owned()];
    let mut consumer = draft("consumer");
    consumer.dependencies = vec!["producer".to_owned()];
    consumer.input_artifacts = vec![ArtifactRequirementV1 {
        from_task: "producer".to_owned(),
        kind: "diff".to_owned(), // never declared by the producer
        artifact_id: None,
    }];
    assert_eq!(
        compile(vec![producer, consumer]),
        Err(DagError::ArtifactKindNotProduced)
    );

    // An artifact edge that is not also a dependency edge is rejected.
    let mut producer = draft("producer");
    producer.output_artifact_kinds = vec!["patch".to_owned()];
    let mut consumer = draft("consumer");
    consumer.input_artifacts = vec![ArtifactRequirementV1 {
        from_task: "producer".to_owned(),
        kind: "patch".to_owned(),
        artifact_id: None,
    }];
    assert_eq!(
        compile(vec![producer, consumer]),
        Err(DagError::ArtifactNotADependency)
    );
}

#[test]
fn overlapping_parallel_write_scopes_require_an_ordering_edge() {
    let mut left = draft("left");
    left.write_scopes = vec!["src/shared/**".to_owned()];
    let mut right = draft("right");
    right.write_scopes = vec!["src/shared/inner/**".to_owned()];
    assert_eq!(compile(vec![left, right]), Err(DagError::WriteScopeOverlap));

    // An ordering edge serializes the same scopes.
    let mut left = draft("left");
    left.write_scopes = vec!["src/shared/**".to_owned()];
    let mut right = draft("right");
    right.dependencies = vec!["left".to_owned()];
    right.write_scopes = vec!["src/shared/inner/**".to_owned()];
    compile(vec![left, right]).expect("ordered writers are admitted");

    // Read-only overlap is safe.
    let mut reader = draft("reader");
    reader.read_only = true;
    reader.write_scopes = Vec::new();
    reader.read_scopes = vec!["src/shared/**".to_owned()];
    let mut writer = draft("writer");
    writer.write_scopes = vec!["src/shared/**".to_owned()];
    compile(vec![reader, writer]).expect("readers never block writers");

    // Unknown writes are conservatively rejected, not treated as parallel-safe.
    let mut unknown = draft("unknown");
    unknown.write_scopes = Vec::new();
    assert_eq!(compile(vec![unknown]), Err(DagError::UnknownWriteScope));
}

#[test]
fn graph_revision_binding_and_topological_order_are_deterministic() {
    let mut stale = proposal(vec![draft("task-a")]);
    stale.expected_graph_revision = "rev-old".to_owned();
    stale.base_graph_revision = "rev-new".to_owned();
    assert_eq!(
        ValidatedTaskGraph::compile(stale, binding(), DagLimits::default()),
        Err(DagError::StaleGraphRevision)
    );

    let mut consumer = draft("task-z");
    consumer.dependencies = vec!["task-a".to_owned()];
    let graph = compile(vec![consumer, draft("task-a")]).expect("acyclic graph");
    assert_eq!(graph.topological_order(), &["task-a", "task-z"]);
    assert_eq!(graph.node("task-z").unwrap().depth, 1);
    assert_eq!(graph.node("task-a").unwrap().depth, 0);
    // Same content compiles to the same revision.
    let repeat = compile(vec![
        {
            let mut consumer = draft("task-z");
            consumer.dependencies = vec!["task-a".to_owned()];
            consumer
        },
        draft("task-a"),
    ])
    .expect("acyclic graph");
    assert_eq!(graph.graph_revision(), repeat.graph_revision());
}

#[test]
fn readiness_requires_independent_verified_predecessors_at_the_current_revision() {
    let mut producer = draft("producer");
    producer.output_artifact_kinds = vec!["patch".to_owned()];
    let mut consumer = draft("consumer");
    consumer.dependencies = vec!["producer".to_owned()];
    consumer.input_artifacts = vec![ArtifactRequirementV1 {
        from_task: "producer".to_owned(),
        kind: "patch".to_owned(),
        artifact_id: None,
    }];
    let graph = compile(vec![producer, consumer]).expect("graph");
    let mut states: BTreeMap<String, TaskRunState> = BTreeMap::new();

    states.insert("producer".to_owned(), TaskRunState::default());
    assert_eq!(
        graph.readiness(&states, REVISION).unwrap(),
        vec!["producer".to_owned()]
    );

    // A producer that produced but is not verified keeps the consumer unready.
    let mut produced = TaskRunState {
        phase: TaskPhase::Produced,
        artifacts: vec![ArtifactRefV1 {
            artifact_id: "artifact-p".to_owned(),
            artifact_kind: "patch".to_owned(),
            sha256: sha('d'),
            mime: "text/x-diff".to_owned(),
            source_revision: REVISION.to_owned(),
            fidelity: ArtifactFidelity::Full,
        }],
        ..TaskRunState::default()
    };
    produced.attempt_revision = Some(REVISION.to_owned());
    states.insert("producer".to_owned(), produced);
    assert!(graph.readiness(&states, REVISION).unwrap().is_empty());

    // A verified producer at a stale revision still does not unblock the consumer.
    let verified_stale = TaskRunState {
        phase: TaskPhase::Verified,
        verified_revision: Some("rev-0".to_owned()),
        ..TaskRunState::default()
    };
    states.insert("producer".to_owned(), verified_stale);
    assert!(graph.readiness(&states, REVISION).unwrap().is_empty());

    // Verified at the current revision with the required artifact unblocks it.
    let verified_current = TaskRunState {
        phase: TaskPhase::Verified,
        verified_revision: Some(REVISION.to_owned()),
        artifacts: vec![ArtifactRefV1 {
            artifact_id: "artifact-p".to_owned(),
            artifact_kind: "patch".to_owned(),
            sha256: sha('d'),
            mime: "text/x-diff".to_owned(),
            source_revision: REVISION.to_owned(),
            fidelity: ArtifactFidelity::Full,
        }],
        ..TaskRunState::default()
    };
    states.insert("producer".to_owned(), verified_current);
    assert_eq!(
        graph.readiness(&states, REVISION).unwrap(),
        vec!["consumer".to_owned()]
    );

    // A missing artifact (same kind, wrong revision) keeps it unready again.
    let verified_no_artifact = TaskRunState {
        phase: TaskPhase::Verified,
        verified_revision: Some(REVISION.to_owned()),
        artifacts: vec![ArtifactRefV1 {
            artifact_id: "artifact-p".to_owned(),
            artifact_kind: "patch".to_owned(),
            sha256: sha('d'),
            mime: "text/x-diff".to_owned(),
            source_revision: "rev-0".to_owned(),
            fidelity: ArtifactFidelity::Full,
        }],
        ..TaskRunState::default()
    };
    states.insert("producer".to_owned(), verified_no_artifact);
    assert!(graph.readiness(&states, REVISION).unwrap().is_empty());
}

#[test]
fn cancelled_or_uncertain_work_is_never_ready() {
    let graph = compile(vec![draft("task-a")]).expect("graph");
    let mut states: BTreeMap<String, TaskRunState> = BTreeMap::new();
    states.insert(
        "task-a".to_owned(),
        TaskRunState {
            cancelled: true,
            ..TaskRunState::default()
        },
    );
    assert!(graph.readiness(&states, REVISION).unwrap().is_empty());
    states.insert(
        "task-a".to_owned(),
        TaskRunState {
            unknown_effect: true,
            ..TaskRunState::default()
        },
    );
    assert!(graph.readiness(&states, REVISION).unwrap().is_empty());
    states.insert(
        "task-a".to_owned(),
        TaskRunState {
            attempt_count: 2,
            max_attempts: 2,
            ..TaskRunState::default()
        },
    );
    assert!(graph.readiness(&states, REVISION).unwrap().is_empty());
}

#[test]
fn delivery_identity_revision_and_binding_are_fenced() {
    let graph = compile(vec![draft("task-a")]).expect("graph");
    let state = running_state("task-a");

    graph
        .validate_delivery(&state, &envelope("task-a"), &produced_result("task-a"))
        .expect("matching delivery");

    let mut wrong_worker = envelope("task-a");
    wrong_worker.worker_execution_id = "worker-other".to_owned();
    let mut wrong_worker_result = produced_result("task-a");
    wrong_worker_result.worker_execution_id = "worker-other".to_owned();
    assert_eq!(
        graph.validate_delivery(&state, &wrong_worker, &wrong_worker_result),
        Err(DagError::WrongWorkerExecution)
    );

    let mut stale_attempt = envelope("task-a");
    stale_attempt.owner_epoch = 6;
    assert_eq!(
        graph.validate_delivery(&state, &stale_attempt, &produced_result("task-a")),
        Err(DagError::StaleAttempt)
    );

    let mut stale_revision = envelope("task-a");
    stale_revision.source_revision = "rev-2".to_owned();
    assert_eq!(
        graph.validate_delivery(&state, &stale_revision, &produced_result("task-a")),
        Err(DagError::AttemptRevisionMismatch)
    );

    let mut foreign_spec = envelope("task-a");
    foreign_spec.accepted_spec_digest = digest('c');
    assert_eq!(
        graph.validate_delivery(&state, &foreign_spec, &produced_result("task-a")),
        Err(DagError::BindingDigestMismatch)
    );

    let mut cross_run = envelope("task-a");
    cross_run.run_id = "run-2".to_owned();
    assert_eq!(
        graph.validate_delivery(&state, &cross_run, &produced_result("task-a")),
        Err(DagError::CrossRunDelivery)
    );
}

#[test]
fn delivery_rejects_file_touch_from_a_different_source_revision() {
    let graph = compile(vec![draft("task-a")]).expect("graph");
    let state = running_state("task-a");
    let mut result = produced_result("task-a");
    result.touched_files[0].source_revision = "rev-before-attempt".to_owned();

    assert_eq!(
        graph.validate_delivery(&state, &envelope("task-a"), &result),
        Err(DagError::AttemptRevisionMismatch)
    );
}

#[test]
fn forged_artifacts_and_malformed_results_are_rejected() {
    let mut producer = draft("task-a");
    producer.output_artifact_kinds = vec!["patch".to_owned()];
    let graph = compile(vec![producer]).expect("graph");
    let state = running_state("task-a");

    let artifact = ArtifactRefV1 {
        artifact_id: "artifact-a".to_owned(),
        artifact_kind: "patch".to_owned(),
        sha256: sha('d'),
        mime: "text/x-diff".to_owned(),
        source_revision: REVISION.to_owned(),
        fidelity: ArtifactFidelity::Full,
    };
    let mut valid = produced_result("task-a");
    valid.artifacts = vec![artifact.clone()];
    graph
        .validate_delivery(&state, &envelope("task-a"), &valid)
        .expect("declared artifact");

    let mut wrong_hash = valid.clone();
    wrong_hash.artifacts[0].sha256 = "not-a-digest".to_owned();
    assert_eq!(
        graph.validate_delivery(&state, &envelope("task-a"), &wrong_hash),
        Err(DagError::InvalidArtifactDigest)
    );

    let mut wrong_revision = valid.clone();
    wrong_revision.artifacts[0].source_revision = "rev-0".to_owned();
    assert_eq!(
        graph.validate_delivery(&state, &envelope("task-a"), &wrong_revision),
        Err(DagError::ResultArtifactMismatch)
    );

    let mut undeclared = valid.clone();
    undeclared.artifacts[0].artifact_kind = "binary".to_owned();
    assert_eq!(
        graph.validate_delivery(&state, &envelope("task-a"), &undeclared),
        Err(DagError::UndeclaredArtifactKind)
    );

    // A PRODUCED result missing the declared output kind is rejected.
    let mut missing = produced_result("task-a");
    missing.artifacts = Vec::new();
    assert_eq!(
        graph.validate_delivery(&state, &envelope("task-a"), &missing),
        Err(DagError::MissingOutputArtifact)
    );

    // Failed without an error category, and blocked with no partial evidence.
    let mut failed = produced_result("task-a");
    failed.status = TaskResultStatus::Failed;
    assert_eq!(
        graph.validate_delivery(&state, &envelope("task-a"), &failed),
        Err(DagError::InvalidResultShape)
    );
    let mut blocked = produced_result("task-a");
    blocked.status = TaskResultStatus::Blocked;
    assert_eq!(
        graph.validate_delivery(&state, &envelope("task-a"), &blocked),
        Err(DagError::InvalidResultShape)
    );
    // Blocked with a missing criterion is a valid bounded observation.
    let mut blocked_with_reason = produced_result("task-a");
    blocked_with_reason.status = TaskResultStatus::Blocked;
    blocked_with_reason.missing_criteria_ids = vec!["crit-1".to_owned()];
    assert_eq!(
        graph
            .validate_delivery(&state, &envelope("task-a"), &blocked_with_reason)
            .expect("bounded blocked delivery")
            .phase,
        TaskPhase::Pending
    );

    // A hostile path reference in the touched-file list is rejected.
    let mut hostile = produced_result("task-a");
    hostile.touched_files[0].path_ref = "src/\u{7}a.rs".to_owned();
    assert_eq!(
        graph.validate_delivery(&state, &envelope("task-a"), &hostile),
        Err(DagError::InvalidDraft)
    );
}

#[test]
fn unknown_results_quarantine_and_late_or_duplicate_deliveries_do_not_overwrite() {
    let graph = compile(vec![draft("task-a")]).expect("graph");
    let state = running_state("task-a");

    let mut unknown = produced_result("task-a");
    unknown.status = TaskResultStatus::Unknown;
    let acceptance = graph
        .validate_delivery(&state, &envelope("task-a"), &unknown)
        .expect("unknown is a valid candidate outcome");
    assert_eq!(acceptance.phase, TaskPhase::Unknown);
    assert!(acceptance.unknown_effect);

    // Identical duplicate delivery of the accepted attempt is idempotent.
    let produced_state = TaskRunState {
        phase: TaskPhase::Produced,
        attempt_id: Some("attempt-task-a".to_owned()),
        worker_execution_id: Some("worker-task-a".to_owned()),
        attempt_revision: Some(REVISION.to_owned()),
        artifacts: Vec::new(),
        ..TaskRunState::default()
    };
    assert_eq!(
        graph
            .validate_delivery(
                &produced_state,
                &envelope("task-a"),
                &produced_result("task-a")
            )
            .expect("idempotent duplicate")
            .phase,
        TaskPhase::Produced
    );

    // A late child from an older Attempt cannot overwrite the newer one.
    let mut late = envelope("task-a");
    late.attempt_id = "attempt-old".to_owned();
    late.worker_execution_id = "worker-old".to_owned();
    let mut late_result = produced_result("task-a");
    late_result.attempt_id = "attempt-old".to_owned();
    late_result.worker_execution_id = "worker-old".to_owned();
    assert_eq!(
        graph.validate_delivery(&produced_state, &late, &late_result),
        Err(DagError::LateDeliveryConflict)
    );

    // After cancellation, a child delivery is rejected rather than resurrected.
    let cancelled = TaskRunState {
        cancelled: true,
        ..running_state("task-a")
    };
    assert_eq!(
        graph.validate_delivery(&cancelled, &envelope("task-a"), &produced_result("task-a")),
        Err(DagError::LateDeliveryAfterCancel)
    );

    // apply_cancel keeps the derived view consistent for late children.
    let mut states: BTreeMap<String, TaskRunState> = BTreeMap::new();
    states.insert("task-a".to_owned(), running_state("task-a"));
    apply_cancel(&mut states, &["task-a".to_owned()]);
    assert!(states["task-a"].cancelled);
    assert!(states["task-a"].attempt_id.is_none());
}

#[test]
fn verification_is_revision_bound_and_never_self_approved() {
    let graph = compile(vec![draft("task-a")]).expect("graph");
    let produced = TaskRunState {
        phase: TaskPhase::Produced,
        attempt_id: Some("attempt-task-a".to_owned()),
        worker_execution_id: Some("worker-task-a".to_owned()),
        attempt_revision: Some(REVISION.to_owned()),
        artifacts: Vec::new(),
        ..TaskRunState::default()
    };
    let verdict = VerificationVerdictV1 {
        task_id: "task-a".to_owned(),
        attempt_id: "attempt-task-a".to_owned(),
        verifier_id: "verifier-independent".to_owned(),
        source_revision: REVISION.to_owned(),
        verified_revision: REVISION.to_owned(),
        criterion_ids: vec!["crit-1".to_owned()],
        evidence_digest: digest('f'),
    };
    let outcome = graph
        .validate_verification(&produced, &verdict, REVISION)
        .expect("independent revision-bound verdict");
    assert_eq!(outcome.verified_revision, REVISION);

    // The producing worker/attempt cannot approve itself.
    let mut self_verdict = verdict.clone();
    self_verdict.verifier_id = "worker-task-a".to_owned();
    assert_eq!(
        graph.validate_verification(&produced, &self_verdict, REVISION),
        Err(DagError::SelfVerification)
    );
    let mut self_attempt = verdict.clone();
    self_attempt.verifier_id = "attempt-task-a".to_owned();
    assert_eq!(
        graph.validate_verification(&produced, &self_attempt, REVISION),
        Err(DagError::SelfVerification)
    );

    // A stale revision verdict cannot pass even if it was once valid.
    let mut stale = verdict.clone();
    stale.source_revision = "rev-0".to_owned();
    stale.verified_revision = "rev-0".to_owned();
    assert_eq!(
        graph.validate_verification(&produced, &stale, "rev-2"),
        Err(DagError::VerificationRevisionMismatch)
    );

    // An unreconciled UNKNOWN effect blocks verification.
    let uncertain = TaskRunState {
        unknown_effect: true,
        ..produced.clone()
    };
    assert_eq!(
        graph.validate_verification(&uncertain, &verdict, REVISION),
        Err(DagError::UnreconciledUnknown)
    );

    // Invented criteria and empty verdicts are rejected.
    let mut invented = verdict.clone();
    invented.criterion_ids = vec!["crit-new".to_owned()];
    assert_eq!(
        graph.validate_verification(&produced, &invented, REVISION),
        Err(DagError::UnknownCriterion)
    );
    let mut empty = verdict.clone();
    empty.criterion_ids = Vec::new();
    assert_eq!(
        graph.validate_verification(&produced, &empty, REVISION),
        Err(DagError::MissingProof)
    );

    // Verification of a still-running task is rejected.
    let running = running_state("task-a");
    assert_eq!(
        graph.validate_verification(&running, &verdict, REVISION),
        Err(DagError::TaskNotRunning)
    );

    // A candidate error list is bounded and validated.
    let mut long_error = produced_result("task-a");
    long_error.errors = vec![CandidateErrorV1 {
        category: "PROVIDER".to_owned(),
        safe_message: "x".repeat(600),
    }];
    assert_eq!(
        graph.validate_delivery(&running_state("task-a"), &envelope("task-a"), &long_error),
        Err(DagError::InvalidDraft)
    );
}

#[test]
fn verification_must_cover_every_criterion_assigned_to_the_task() {
    let mut task = draft("task-a");
    task.criterion_ids = vec!["crit-1".to_owned(), "crit-2".to_owned()];
    let mut accepted = proposal(vec![task]);
    accepted.accepted_criteria = vec!["crit-1".to_owned(), "crit-2".to_owned()];
    let graph = ValidatedTaskGraph::compile(accepted, binding(), DagLimits::default())
        .expect("both accepted criteria are assigned to the task");
    let produced = TaskRunState {
        phase: TaskPhase::Produced,
        attempt_id: Some("attempt-task-a".to_owned()),
        worker_execution_id: Some("worker-task-a".to_owned()),
        attempt_revision: Some(REVISION.to_owned()),
        ..TaskRunState::default()
    };
    let mut verdict = VerificationVerdictV1 {
        task_id: "task-a".to_owned(),
        attempt_id: "attempt-task-a".to_owned(),
        verifier_id: "verifier-independent".to_owned(),
        source_revision: REVISION.to_owned(),
        verified_revision: REVISION.to_owned(),
        criterion_ids: vec!["crit-1".to_owned()],
        evidence_digest: digest('f'),
    };

    assert_eq!(
        graph.validate_verification(&produced, &verdict, REVISION),
        Err(DagError::MissingProof),
        "a partial criterion verdict must not produce TaskPhase::Verified"
    );

    verdict.criterion_ids.push("crit-2".to_owned());
    let accepted = graph
        .validate_verification(&produced, &verdict, REVISION)
        .expect("independent verifier covers the complete task criterion set");
    assert_eq!(accepted.criterion_ids, vec!["crit-1", "crit-2"]);
}
