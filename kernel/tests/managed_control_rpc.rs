#![cfg(target_os = "linux")]

//! Authenticated `managed.v1` kernel-RPC boundary tests.
//!
//! The durable managed state machine is seeded exactly the way the internal
//! scheduler/plan-ingress writers seed it (`ManagedControl::open`), then exercised
//! only through the authenticated host socket boundary: admit / settle / cancel /
//! snapshot. Every negative case asserts the fail-closed typed rejection.

use horizoncode_kernel::host_kernel::{EFFECTS_SERVICE_ID, HostKernel, MANAGED_SERVICE_ID};
use horizoncode_kernel::managed_control::{
    AcceptanceCriterion, GoalDraft, ManagedCommand, ManagedControl, SpecBudget, SpecVersionDraft,
};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::owner_log::OwnerIdentity;
use horizoncode_kernel::protocol::{FrameFence, RpcOutcomeV1, RpcRequestV1, RpcResponseV1};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const PRINCIPAL: &str = "host_os_uid:1000";
const EPOCH: u64 = 11;
const INCARNATION: &str = "inc_managed_rpc";
const GOAL: &str = "goal-managed";
const RUN: &str = "run-v1";
const TASK: &str = "task-v1";
const SPEC: &str = "spec-v1";

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn sha(seed: char) -> String {
    format!("sha256:{}", seed.to_string().repeat(64))
}

fn goal() -> GoalDraft {
    GoalDraft {
        objective: "Complete the managed task".into(),
        project_ref: "project-one".into(),
        workspace_ref: "workspace-one".into(),
        created_by: "server_auth:author".into(),
    }
}

fn spec() -> SpecVersionDraft {
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
            max_attempts_per_task: 2,
            max_run_duration_ms: 60_000,
            max_memory_bytes: Some(1_073_741_824),
            max_disk_bytes: Some(2_147_483_648),
            max_workers: 1,
            max_tokens: Some(20_000),
            max_cost_micros: Some(0),
        },
        source_digests: vec![sha('a')],
        proposed_by: "server_auth:author".into(),
    }
}

/// Seeds one durable Goal with an accepted SpecVersion, a Run and one ready Task.
/// This is the same sequence the internal plan-ingress writers use; the RPC never
/// creates Goal/SpecVersion/Run state in this milestone.
fn seed_ready_run(root: &Path, goal_id: &str) {
    let mut control = ManagedControl::open(root, goal_id).unwrap();
    let mut send = |delivery: &str, command: ManagedCommand| {
        let revision = control.snapshot().revision;
        control.apply(revision, delivery, command).unwrap();
    };
    send("goal-1", ManagedCommand::CreateGoal { goal: goal() });
    let draft = spec();
    let digest = draft.digest();
    send(
        "spec-1",
        ManagedCommand::ProposeSpec {
            spec_id: SPEC.into(),
            spec: draft,
            spec_digest: digest.clone(),
        },
    );
    send(
        "assign-reviewer-1",
        ManagedCommand::AssignSpecReviewer {
            spec_id: SPEC.into(),
            spec_digest: digest.clone(),
            reviewer_id: "server_auth:reviewer".into(),
        },
    );
    send(
        "accept-1",
        ManagedCommand::AcceptSpec {
            spec_id: SPEC.into(),
            spec_digest: digest,
            accepted_by: "server_auth:reviewer".into(),
            accepted_at_ms: 1,
        },
    );
    send(
        "run-1",
        ManagedCommand::StartRun {
            run_id: RUN.into(),
            spec_id: SPEC.into(),
        },
    );
    send(
        "task-1",
        ManagedCommand::AddTask {
            run_id: RUN.into(),
            task_id: TASK.into(),
            dependencies: vec![],
            criterion_ids: vec!["tests-pass".into()],
            required_capabilities: vec![],
        },
    );
    send(
        "ready-1",
        ManagedCommand::MarkTaskReady {
            run_id: RUN.into(),
            task_id: TASK.into(),
        },
    );
}

fn seed_pending_goal(root: &Path, goal_id: &str) {
    let mut control = ManagedControl::open(root, goal_id).unwrap();
    let draft = spec();
    let digest = draft.digest();
    control
        .apply(
            0,
            "pending-goal-create",
            ManagedCommand::CreateGoal { goal: goal() },
        )
        .unwrap();
    control
        .apply(
            1,
            "pending-goal-propose",
            ManagedCommand::ProposeSpec {
                spec_id: "spec-pending".into(),
                spec: draft,
                spec_digest: digest,
            },
        )
        .unwrap();
}

struct Fixture {
    state: PathBuf,
    location_id: String,
    workspace: PathBuf,
    host: Option<HostKernel>,
    fence: FrameFence,
    sequence: u64,
}

impl Fixture {
    fn new() -> Self {
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "hz-managed-rpc-{}-{tick}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = fs::canonicalize(workspace).unwrap();
        seed_ready_run(&state.join("managed-control"), GOAL);
        let mut host = HostKernel::open(&state).unwrap();
        host.set_effects_enabled(true);
        let request = RpcRequestV1 {
            owner_epoch: EPOCH,
            process_incarnation: INCARNATION.to_owned(),
            request_id: "req-register-managed-location".to_owned(),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: "register_location".to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: "trace-managed-location".to_owned(),
            body: map([
                ("canonicalRoot", string(workspace.to_str().unwrap())),
                ("workspaceID", string("workspace-one")),
            ]),
        };
        let fence = FrameFence::new(EPOCH, INCARNATION).unwrap();
        let response = host.handle_request(&request, "server_auth:managed-rpc-owner", &fence);
        let body = ok_body(response);
        let location_id = field_text(&body, "locationID").to_owned();
        Self {
            state,
            location_id,
            workspace,
            host: Some(host),
            fence: FrameFence::new(EPOCH, INCARNATION).unwrap(),
            sequence: 0,
        }
    }

    fn host(&mut self) -> &mut HostKernel {
        self.host.as_mut().unwrap()
    }

    fn send(&mut self, operation: &str, body: Value, delivery: Option<&str>) -> RpcResponseV1 {
        self.sequence += 1;
        let request = managed_request(operation, body, delivery, self.sequence);
        let fence = self.fence.clone();
        self.host().handle_request(&request, PRINCIPAL, &fence)
    }

    fn send_reviewer(
        &mut self,
        username: &str,
        operation: &str,
        body: Value,
        delivery: Option<&str>,
    ) -> RpcResponseV1 {
        self.sequence += 1;
        let request = managed_request(operation, body, delivery, self.sequence);
        let fence = self.fence.clone();
        self.host()
            .handle_request(&request, &format!("server_auth:{username}"), &fence)
    }

    fn send_as_peer(
        &mut self,
        peer: &str,
        operation: &str,
        body: Value,
        delivery: Option<&str>,
    ) -> RpcResponseV1 {
        self.sequence += 1;
        let request = managed_request(operation, body, delivery, self.sequence);
        let fence = self.fence.clone();
        self.host().handle_request(&request, peer, &fence)
    }
}

impl Fixture {
    fn admit_body(&self, attempt_id: &str, expected_revision: u64) -> Value {
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(attempt_id)),
            ("expectedRevision", Value::Unsigned(expected_revision)),
            ("locationID", string(&self.location_id)),
            ("sessionID", string("ses_managed_rpc")),
        ])
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(root) = self.state.parent() {
            let _ = fs::remove_dir_all(root);
        }
    }
}

fn managed_request(
    operation: &str,
    body: Value,
    delivery: Option<&str>,
    sequence: u64,
) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch: EPOCH,
        process_incarnation: INCARNATION.to_owned(),
        request_id: format!("req-managed-{sequence}"),
        service_id: MANAGED_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: delivery.map(str::to_owned),
        expected_cursor: None,
        deadline_unix_ms: now_ms() + 30_000,
        trace_id: "trace-managed".to_owned(),
        body,
    }
}

fn map<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    match value {
        Value::Map(fields) => fields
            .get(key)
            .unwrap_or_else(|| panic!("field {key} is missing")),
        other => panic!("expected a map, found {other:?}"),
    }
}

fn field_text<'a>(value: &'a Value, key: &str) -> &'a str {
    match field(value, key) {
        Value::String(text) => text,
        other => panic!("field {key} is not a string: {other:?}"),
    }
}

fn field_unsigned(value: &Value, key: &str) -> u64 {
    match field(value, key) {
        Value::Unsigned(number) => *number,
        other => panic!("field {key} is not an unsigned integer: {other:?}"),
    }
}

fn field_array<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    match field(value, key) {
        Value::Array(items) => items,
        other => panic!("field {key} is not an array: {other:?}"),
    }
}

fn assert_nil(value: &Value, key: &str) {
    assert!(
        matches!(field(value, key), Value::Nil),
        "field {key} must be nil"
    );
}

fn ok_body(response: RpcResponseV1) -> Value {
    assert_eq!(
        response.outcome,
        RpcOutcomeV1::Ok,
        "unexpected error {:?}",
        response.error
    );
    response.body.expect("success response must carry a body")
}

fn error_code(response: &RpcResponseV1) -> &str {
    assert_eq!(
        response.outcome,
        RpcOutcomeV1::Error,
        "unexpected success response: {response:?}"
    );
    assert!(response.body.is_none());
    response
        .error
        .as_ref()
        .expect("error response must carry an error")
        .code
        .as_str()
}

fn snapshot_body() -> Value {
    map([("goalID", string(GOAL))])
}

fn only_run(snapshot: &Value) -> Value {
    let runs = field_array(snapshot, "runs");
    assert_eq!(runs.len(), 1);
    runs[0].clone()
}

#[test]
fn managed_rpc_admission_without_typed_owner_proofs_has_zero_owner_or_effect_mutation() {
    let mut fixture = Fixture::new();
    let before = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&before, "revision"), 7);
    assert!(field_array(&before, "attempts").is_empty());

    let database = fixture
        .state
        .join("effect-locations")
        .join(&fixture.location_id)
        .join("effects.sqlite");
    let challenges_before = if database.exists() {
        let connection = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        connection
            .query_row("SELECT COUNT(*) FROM effect_challenges", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
    } else {
        0
    };

    assert_eq!(
        error_code(&fixture.send(
            "admit",
            fixture.admit_body("attempt-without-proof", 7),
            Some("delivery-admit-without-proof"),
        )),
        "capability_unavailable"
    );

    let after = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&after, "revision"), 7);
    assert!(field_array(&after, "attempts").is_empty());
    let challenges_after = if database.exists() {
        let connection = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        connection
            .query_row("SELECT COUNT(*) FROM effect_challenges", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
    } else {
        0
    };
    assert_eq!(challenges_after, challenges_before);
    assert!(
        !fixture
            .workspace
            .join("attempt-without-proof.marker")
            .exists()
    );
}

#[test]
fn managed_review_inbox_discovers_only_durable_pending_specs_after_restart() {
    let mut fixture = Fixture::new();
    seed_pending_goal(&fixture.state.join("managed-control"), "goal-inbox");
    fixture.host.take();
    fixture.host = Some(HostKernel::open(&fixture.state).unwrap());

    let response = fixture.send("list_pending_reviews", map([]), None);
    let body = ok_body(response);
    let goals = field_array(&body, "goals");
    assert_eq!(goals.len(), 1);
    assert_eq!(field_text(&goals[0], "goalID"), "goal-inbox");
    assert_eq!(field_unsigned(&goals[0], "revision"), 2);
    assert_eq!(
        field_text(field(&goals[0], "goal"), "projectRef"),
        "project-one"
    );
    assert_eq!(
        field_text(field(&goals[0], "goal"), "workspaceRef"),
        "workspace-one"
    );
    let specs = field_array(&goals[0], "specs");
    assert_eq!(specs.len(), 1);
    assert_eq!(field_text(&specs[0], "specID"), "spec-pending");
    assert_eq!(field_array(&goals[0], "runs").len(), 0);
    assert_eq!(field_array(&goals[0], "attempts").len(), 0);
}

#[test]
fn managed_review_assignment_is_durable_distinct_and_required_for_decisions() {
    let mut fixture = Fixture::new();
    seed_pending_goal(&fixture.state.join("managed-control"), "goal-review-claim");
    let spec_digest = spec().digest();

    let self_claim = fixture.send_reviewer(
        "author",
        "assign_spec_reviewer",
        map([
            ("goalID", string("goal-review-claim")),
            ("specID", string("spec-pending")),
            ("specDigest", string(&spec_digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("claim-self-review"),
    );
    assert_eq!(error_code(&self_claim), "managed_conflict");

    let unassigned_decision = fixture.send_reviewer(
        "reviewer",
        "accept_spec",
        map([
            ("goalID", string("goal-review-claim")),
            ("specID", string("spec-pending")),
            ("specDigest", string(&spec_digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("accept-before-claim"),
    );
    assert_eq!(error_code(&unassigned_decision), "managed_conflict");

    // An unauthenticated peer cannot claim a reviewer slot. The real-socket
    // envelope and body-spoof cases are covered in managed_control_plan_ingress.
    let forged = fixture.send_as_peer(
        "unauthenticated-peer",
        "assign_spec_reviewer",
        map([
            ("goalID", string("goal-review-claim")),
            ("specID", string("spec-pending")),
            ("specDigest", string(&spec_digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("claim-forged-reviewer"),
    );
    assert_eq!(
        forged.outcome,
        RpcOutcomeV1::Error,
        "forged response: {forged:?}"
    );
    assert_eq!(
        error_code(&forged),
        "missing_principal",
        "forged reviewer response: {forged:?}"
    );

    let assigned = ok_body(fixture.send_reviewer(
        "reviewer",
        "assign_spec_reviewer",
        map([
            ("goalID", string("goal-review-claim")),
            ("specID", string("spec-pending")),
            ("specDigest", string(&spec_digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("claim-reviewer-1"),
    ));
    assert_eq!(field_text(&assigned, "status"), "ASSIGNED");
    assert_eq!(field_text(&assigned, "reviewerID"), "server_auth:reviewer");
    assert_eq!(field_unsigned(&assigned, "assignedAtRevision"), 2);
    assert_eq!(field_unsigned(&assigned, "decisionRevision"), 3);

    // Assignment survives an owner restart and an exact lost-response retry keeps
    // the original compare-and-swap revision.
    fixture.host.take();
    fixture.host = Some(HostKernel::open(&fixture.state).unwrap());
    let replayed = ok_body(fixture.send_reviewer(
        "reviewer",
        "assign_spec_reviewer",
        map([
            ("goalID", string("goal-review-claim")),
            ("specID", string("spec-pending")),
            ("specDigest", string(&spec_digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("claim-reviewer-1"),
    ));
    assert_eq!(field_unsigned(&replayed, "assignedAtRevision"), 2);
    assert_eq!(field_unsigned(&replayed, "decisionRevision"), 3);

    let competing = fixture.send_reviewer(
        "other-reviewer",
        "assign_spec_reviewer",
        map([
            ("goalID", string("goal-review-claim")),
            ("specID", string("spec-pending")),
            ("specDigest", string(&spec_digest)),
            ("expectedRevision", Value::Unsigned(3)),
        ]),
        Some("claim-reviewer-2"),
    );
    assert_eq!(error_code(&competing), "independent_verifier_required");

    // The assigned reviewer can make the revision-bound decision; the proposer and
    // an unassigned authenticated account cannot.
    let wrong_reviewer = fixture.send_reviewer(
        "other-reviewer",
        "accept_spec",
        map([
            ("goalID", string("goal-review-claim")),
            ("specID", string("spec-pending")),
            ("specDigest", string(&spec_digest)),
            ("expectedRevision", Value::Unsigned(3)),
        ]),
        Some("accept-wrong-reviewer"),
    );
    assert_eq!(error_code(&wrong_reviewer), "independent_verifier_required");

    let accepted = ok_body(fixture.send_reviewer(
        "reviewer",
        "accept_spec",
        map([
            ("goalID", string("goal-review-claim")),
            ("specID", string("spec-pending")),
            ("specDigest", string(&spec_digest)),
            ("expectedRevision", Value::Unsigned(3)),
        ]),
        Some("accept-assigned-reviewer"),
    ));
    assert_eq!(field_text(&accepted, "status"), "ACCEPTED");
}

#[test]
fn managed_rpc_retry_admission_stays_fail_closed_without_owner_mutation() {
    let mut fixture = Fixture::new();
    for (attempt_id, expected_revision, delivery_id) in [
        ("attempt-v1", 7, "delivery-admit-1"),
        ("attempt-v2", 8, "delivery-admit-2"),
    ] {
        assert_eq!(
            error_code(&fixture.send(
                "admit",
                fixture.admit_body(attempt_id, expected_revision),
                Some(delivery_id),
            )),
            "capability_unavailable"
        );
    }
    let snapshot = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), 7);
    assert!(field_array(&snapshot, "attempts").is_empty());
    let task = field_array(&only_run(&snapshot), "tasks")[0].clone();
    assert_eq!(field_unsigned(&task, "attemptCount"), 0);
}

#[test]
fn managed_rpc_rejects_unknown_goals_and_forged_attempt_ids() {
    let mut fixture = Fixture::new();

    // Admission fails closed before revealing whether the Goal exists or opening
    // an OwnerLog. The forged Goal must not allocate state.
    let unknown = fixture.send(
        "admit",
        map([
            ("goalID", string("goal-forged")),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string("attempt-forged")),
            ("expectedRevision", Value::Unsigned(7)),
            ("locationID", string(&fixture.location_id)),
            ("sessionID", string("ses_managed_rpc")),
        ]),
        Some("delivery-forged"),
    );
    assert_eq!(error_code(&unknown), "capability_unavailable");
    let owner_key = OwnerIdentity::new("managed_goal".to_owned(), "goal-forged".to_owned())
        .unwrap()
        .directory_key();
    assert!(
        !fixture
            .state
            .join("managed-control")
            .join("owners")
            .join(owner_key)
            .exists(),
        "a forged Goal must not allocate durable owner state"
    );
    assert_eq!(
        error_code(&fixture.send("snapshot", map([("goalID", string("goal-forged"))]), None)),
        "managed_not_found"
    );

    // A forged Attempt id inside an existing Goal is a typed conflict.
    assert_eq!(
        error_code(&fixture.send(
            "settle",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("attemptID", string("attempt-forged")),
                ("outcome", string("succeeded")),
                ("expectedRevision", Value::Unsigned(7)),
            ]),
            Some("delivery-forged-attempt"),
        )),
        "managed_conflict"
    );

    // A shaped admission for the real Goal is also unavailable until the
    // trusted owner proof producer is wired; no legacy Attempt is created.
    assert_eq!(
        error_code(&fixture.send(
            "admit",
            fixture.admit_body("attempt-v1", 7),
            Some("delivery-admit-1"),
        )),
        "capability_unavailable"
    );
    assert_eq!(
        error_code(&fixture.send(
            "settle",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string("task-other")),
                ("attemptID", string("attempt-v1")),
                ("outcome", string("succeeded")),
                ("expectedRevision", Value::Unsigned(9)),
            ]),
            Some("delivery-mismatched-task"),
        )),
        "managed_conflict"
    );
    assert_eq!(
        error_code(&fixture.send(
            "cancel",
            map([
                ("goalID", string(GOAL)),
                ("runID", string("run-missing")),
                ("expectedRevision", Value::Unsigned(9)),
            ]),
            Some("delivery-cancel-missing-run"),
        )),
        "managed_conflict"
    );

    // No partial Attempt was written, and malformed calls changed no revision.
    let snapshot = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), 7);
    assert!(field_array(&snapshot, "attempts").is_empty());
}

#[test]
fn managed_rpc_rejects_unauthorized_operations_and_stale_fences() {
    let mut fixture = Fixture::new();
    let fence = fixture.fence.clone();
    let request = managed_request(
        "admit",
        fixture.admit_body("attempt-v1", 7),
        Some("delivery-1"),
        1,
    );

    let anonymous = fixture.host().handle_request(&request, "", &fence);
    assert_eq!(error_code(&anonymous), "missing_principal");
    let forged_principal = fixture.host().handle_request(&request, "anonymous", &fence);
    assert_eq!(error_code(&forged_principal), "missing_principal");

    let mut stale = managed_request(
        "admit",
        fixture.admit_body("attempt-v1", 7),
        Some("delivery-2"),
        2,
    );
    stale.owner_epoch = EPOCH + 1;
    assert_eq!(
        error_code(&fixture.host().handle_request(&stale, PRINCIPAL, &fence)),
        "stale_fence"
    );
    let mut stale_incarnation = managed_request(
        "admit",
        fixture.admit_body("attempt-v1", 7),
        Some("delivery-3"),
        3,
    );
    stale_incarnation.process_incarnation = "inc_other".to_owned();
    assert_eq!(
        error_code(
            &fixture
                .host()
                .handle_request(&stale_incarnation, PRINCIPAL, &fence)
        ),
        "stale_fence"
    );

    let expired = RpcRequestV1 {
        deadline_unix_ms: 1,
        ..managed_request(
            "admit",
            fixture.admit_body("attempt-v1", 7),
            Some("delivery-4"),
            4,
        )
    };
    assert_eq!(
        error_code(&fixture.host().handle_request(&expired, PRINCIPAL, &fence)),
        "deadline_exceeded"
    );

    let mut unknown_service = managed_request(
        "admit",
        fixture.admit_body("attempt-v1", 7),
        Some("delivery-5"),
        5,
    );
    unknown_service.service_id = "managed.v2".to_owned();
    assert_eq!(
        error_code(
            &fixture
                .host()
                .handle_request(&unknown_service, PRINCIPAL, &fence)
        ),
        "capability_unavailable"
    );
    assert_eq!(
        error_code(&fixture.send(
            "admit_all",
            fixture.admit_body("attempt-v1", 7),
            Some("delivery-6")
        )),
        "capability_unavailable"
    );

    // managed.v1 does not depend on effects.v2 negotiation. Location setup
    // enabled effects on this fixture, so disable it before this fail-closed check.
    fixture.host().set_effects_enabled(false);
    let effects = RpcRequestV1 {
        service_id: horizoncode_kernel::host_kernel::EFFECTS_SERVICE_ID.to_owned(),
        operation: "register_location".to_owned(),
        ..managed_request("admit", map([("canonicalRoot", string("/"))]), None, 7)
    };
    assert_eq!(
        error_code(&fixture.host().handle_request(&effects, PRINCIPAL, &fence)),
        "feature_not_negotiated"
    );

    assert_eq!(
        error_code(&fixture.send(
            "admit",
            fixture.admit_body("attempt-v1", 7),
            Some("delivery-7"),
        )),
        "capability_unavailable"
    );
    let snapshot = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), 7);
    assert!(field_array(&snapshot, "attempts").is_empty());
}

#[test]
fn unauthenticated_profile_admission_is_rejected_before_owner_or_effect_mutation() {
    let mut fixture = Fixture::new();
    let before = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&before, "revision"), 7);
    let effect_db = fixture
        .state
        .join("effect-locations")
        .join(&fixture.location_id)
        .join("effects.sqlite");
    let effect_state_before = fs::read(&effect_db).ok();

    // Neither a body-supplied principal nor a caller-supplied profile can stand in
    // for the OS-authenticated peer and out-of-body ServerAuth principal.
    let mut body = fixture.admit_body("attempt-unauth-profile", 7);
    let Value::Map(fields) = &mut body else {
        unreachable!()
    };
    fields.insert("principal".into(), string(PRINCIPAL));
    fields.insert(
        "profileDefinition".into(),
        map([
            ("schemaVersion", Value::Unsigned(2)),
            ("profileId", string("caller.admin")),
            ("source", string("project")),
            ("adapter", map([("unexpected", Value::Bool(true))])),
        ]),
    );
    let denied = fixture.send_as_peer(
        "unauthenticated-peer",
        "admit",
        body,
        Some("unauthenticated-profile-admission"),
    );
    assert_eq!(error_code(&denied), "missing_principal");

    let after = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&after, "revision"), 7);
    assert!(field_array(&after, "attempts").is_empty());
    assert_eq!(
        fs::read(effect_db).ok(),
        effect_state_before,
        "unauthenticated profile input must not change EffectHost state"
    );
}

#[test]
fn malformed_profile_is_rejected_before_owner_or_effect_mutation() {
    let mut fixture = Fixture::new();
    let before = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&before, "revision"), 7);
    let effect_db = fixture
        .state
        .join("effect-locations")
        .join(&fixture.location_id)
        .join("effects.sqlite");
    let effect_state_before = fs::read(&effect_db).ok();

    let mut body = fixture.admit_body("attempt-malformed-profile", 7);
    let Value::Map(fields) = &mut body else {
        unreachable!()
    };
    fields.insert(
        "profileDefinition".into(),
        map([
            ("schemaVersion", Value::Unsigned(2)),
            ("profileId", string("caller.project-profile")),
            ("source", string("project")),
            (
                "adapter",
                map([
                    ("kind", string("native")),
                    ("unexpected", Value::Bool(true)),
                ]),
            ),
        ]),
    );
    let denied = fixture.send("admit", body, Some("malformed-profile-admission"));
    assert_eq!(error_code(&denied), "invalid_effect_request");

    let after = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&after, "revision"), 7);
    assert!(field_array(&after, "attempts").is_empty());
    assert_eq!(
        fs::read(effect_db).ok(),
        effect_state_before,
        "malformed profile input must not change EffectHost state"
    );
}

#[test]
fn foreign_session_context_selection_is_rejected_before_owner_or_effect_mutation() {
    let mut fixture = Fixture::new();
    let before = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&before, "revision"), 7);
    let effect_db = fixture
        .state
        .join("effect-locations")
        .join(&fixture.location_id)
        .join("effects.sqlite");
    let effect_state_before = fs::read(&effect_db).ok();

    let mut body = fixture.admit_body("attempt-foreign-context", 7);
    let Value::Map(fields) = &mut body else {
        unreachable!()
    };
    fields.insert(
        "contextSelection".into(),
        map([
            ("schemaVersion", Value::Unsigned(1)),
            ("sessionID", string("ses_foreign")),
            ("mode", string("fresh")),
            ("sourceRevision", string("0")),
            ("sources", Value::Array(vec![])),
        ]),
    );
    let denied = fixture.send("admit", body, Some("foreign-context-selection"));
    assert_eq!(error_code(&denied), "invalid_effect_request");

    let after = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&after, "revision"), 7);
    assert!(field_array(&after, "attempts").is_empty());
    assert_eq!(fs::read(effect_db).ok(), effect_state_before);
}

#[test]
fn managed_rpc_rejects_missing_keys_malformed_and_oversized_bodies() {
    let mut fixture = Fixture::new();

    assert_eq!(
        error_code(&fixture.send("admit", fixture.admit_body("attempt-v1", 7), None)),
        "capability_unavailable"
    );
    assert_eq!(
        error_code(&fixture.send(
            "admit",
            fixture.admit_body("attempt-v1", 7),
            Some(&"d".repeat(230))
        )),
        "capability_unavailable"
    );
    // The unsupported admission route denies before interpreting identifiers or
    // opening any Goal state.
    assert_eq!(
        error_code(&fixture.send(
            "admit",
            fixture.admit_body("attempt-v1", 7),
            Some("delivery:with:colons")
        )),
        "capability_unavailable"
    );
    assert_eq!(
        error_code(&fixture.send(
            "admit",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("attemptID", string("attempt-v1")),
                ("expectedRevision", Value::Unsigned(7)),
                ("extraField", string("rejected")),
            ]),
            Some("delivery-extra")
        )),
        "invalid_effect_request"
    );
    assert_eq!(
        error_code(&fixture.send(
            "admit",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("attemptID", string("attempt-v1")),
                ("expectedRevision", string("6")),
            ]),
            Some("delivery-string-revision")
        )),
        "invalid_effect_request"
    );
    assert_eq!(
        error_code(&fixture.send(
            "admit",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("attemptID", string("attempt-v1")),
                ("expectedRevision", Value::Unsigned(7)),
                ("padding", string(&"p".repeat(7 * 1024 * 1024))),
            ]),
            Some("delivery-oversized")
        )),
        "invalid_effect_request"
    );
    assert_eq!(
        error_code(&fixture.send(
            "snapshot",
            map([
                ("goalID", string(GOAL)),
                ("includeSecrets", Value::Bool(true)),
            ]),
            None
        )),
        "invalid_effect_request"
    );

    // None of the malformed or unavailable calls advanced the durable revision.
    let snapshot = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), 7);
    assert!(field_array(&snapshot, "attempts").is_empty());
}

#[test]
fn managed_rpc_admission_does_not_claim_delivery_or_attempt_ids_without_proofs() {
    let mut fixture = Fixture::new();
    for (attempt_id, expected_revision, delivery_id) in [
        ("attempt-v1", 7, "delivery-1"),
        ("attempt-v2", 8, "delivery-1"),
        ("attempt-v1", 8, "delivery-2"),
        ("attempt-v3", 7, "delivery-3"),
    ] {
        assert_eq!(
            error_code(&fixture.send(
                "admit",
                fixture.admit_body(attempt_id, expected_revision),
                Some(delivery_id),
            )),
            "capability_unavailable"
        );
    }

    let snapshot = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), 7);
    assert!(field_array(&snapshot, "attempts").is_empty());
}

#[test]
fn managed_rpc_cannot_manufacture_unknown_without_an_admitted_attempt() {
    let mut fixture = Fixture::new();
    assert_eq!(
        error_code(&fixture.send(
            "settle",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("attemptID", string("attempt-v1")),
                ("outcome", string("succeeded")),
                ("expectedRevision", Value::Unsigned(7)),
            ]),
            Some("delivery-launder"),
        )),
        "managed_conflict"
    );
    let unchanged = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&unchanged, "revision"), 7);
    assert!(field_array(&unchanged, "attempts").is_empty());
}

#[test]
fn managed_rpc_restart_does_not_recover_an_attempt_that_was_never_admitted() {
    let mut fixture = Fixture::new();
    assert_eq!(
        error_code(&fixture.send(
            "admit",
            fixture.admit_body("attempt-v1", 7),
            Some("delivery-admit-1"),
        )),
        "capability_unavailable"
    );

    // No partial Attempt exists for startup recovery to misclassify.
    drop(fixture.host.take());
    fixture.host = Some(HostKernel::open(&fixture.state).unwrap());

    let snapshot = ok_body(fixture.send("snapshot", snapshot_body(), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), 7);
    assert!(field_array(&snapshot, "attempts").is_empty());
    assert_eq!(
        error_code(&fixture.send(
            "admit",
            fixture.admit_body("attempt-v1", 7),
            Some("delivery-admit-1")
        )),
        "capability_unavailable"
    );
}

#[test]
fn managed_rpc_bounds_the_live_goal_set_without_evicting_work() {
    // The kernel holds at most 64 live managed Goals and never evicts one:
    // reopening a Goal whose Attempt may still be in flight would record a false
    // UNKNOWN outcome.
    const LIVE_GOAL_LIMIT: usize = 64;
    let mut fixture = Fixture::new();
    for index in 1..LIVE_GOAL_LIMIT {
        seed_ready_run(
            &fixture.state.join("managed-control"),
            &format!("goal-fill-{index}"),
        );
    }
    seed_ready_run(&fixture.state.join("managed-control"), "goal-overflow");

    // GOAL plus 63 fills occupy every live slot; each read also opens that Goal.
    ok_body(fixture.send("snapshot", snapshot_body(), None));
    for index in 1..LIVE_GOAL_LIMIT {
        let goal_id = format!("goal-fill-{index}");
        ok_body(fixture.send("snapshot", map([("goalID", string(&goal_id))]), None));
    }
    // Durable or not, the 65th Goal fails closed instead of evicting live work.
    assert_eq!(
        error_code(&fixture.send("snapshot", map([("goalID", string("goal-overflow"))]), None)),
        "managed_goal_limit"
    );
    // Already-open Goals keep serving reads.
    ok_body(fixture.send("snapshot", snapshot_body(), None));
}

#[test]
fn managed_rpc_goal_bindings_stay_isolated() {
    const OTHER_GOAL: &str = "goal-other";
    let mut fixture = Fixture::new();
    seed_ready_run(&fixture.state.join("managed-control"), OTHER_GOAL);

    assert_eq!(
        error_code(&fixture.send(
            "admit",
            fixture.admit_body("attempt-v1", 7),
            Some("delivery-admit-1"),
        )),
        "capability_unavailable"
    );

    let other = ok_body(fixture.send("snapshot", map([("goalID", string(OTHER_GOAL))]), None));
    assert_eq!(field_text(&other, "goalID"), OTHER_GOAL);
    assert_eq!(field_unsigned(&other, "revision"), 7);
    assert!(field_array(&other, "attempts").is_empty());
    let other_run = only_run(&other);
    assert_eq!(field_text(&other_run, "phase"), "RUNNING");
    let isolated_task = field_array(&other_run, "tasks")[0].clone();
    assert_nil(&isolated_task, "activeAttemptID");
}
