#![cfg(target_os = "linux")]

//! Managed settlement and verification provenance on the authenticated boundary.
//!
//! A successful Attempt settlement must be backed by an authoritative target receipt
//! reconciled from the registered Location's durable EffectHost record; a
//! request-supplied digest is rejected. Task PASS and Run SUCCEEDED then require an
//! independent authenticated verifier whose evidence the kernel computes over the
//! frozen final integrated Revision. Managed effects remain denied until a trusted
//! adapter produces the immutable delegation binding; negative cases prove denial
//! before durable effect admission and zero managed success.

use horizoncode_kernel::host_kernel::{EFFECTS_SERVICE_ID, HostKernel, MANAGED_SERVICE_ID};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{FrameFence, RpcOutcomeV1, RpcRequestV1, RpcResponseV1};
use rusqlite::{Connection, OpenFlags};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const EXECUTOR: &str = "server_auth:executor";
const VERIFIER: &str = "server_auth:verifier";
const GOAL: &str = "goal-provenance";
const SPEC: &str = "spec-provenance";
const RUN: &str = "run-provenance";
const TASK: &str = "task-provenance";
const ATTEMPT: &str = "attempt-provenance";
const SESSION: &str = "ses_provenance00000000000000000000";
const TURN_CONTEXT: &str =
    "sha256:1111111111111111111111111111111111111111111111111111111111111111";

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn b3(seed: char) -> String {
    format!("blake3:{}", seed.to_string().repeat(64))
}

fn map<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect::<BTreeMap<_, _>>(),
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

fn field_decimal_u64(value: &Value, key: &str) -> u64 {
    match field(value, key) {
        Value::String(text) => text
            .parse::<u64>()
            .unwrap_or_else(|_| panic!("field {key} is not a canonical u64: {text}")),
        other => panic!("field {key} is not a decimal string: {other:?}"),
    }
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
    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    response
        .error
        .as_ref()
        .expect("error response must carry an error")
        .code
        .as_str()
}

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    state: PathBuf,
    host: HostKernel,
    fence: FrameFence,
    sequence: u64,
    location_id: Option<String>,
    managed_attempt_scope: Option<Value>,
}

impl Fixture {
    fn new() -> Self {
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hz-managed-provenance-{}-{tick}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let state = root.join("state");
        let workspace = root.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = fs::canonicalize(workspace).unwrap();
        let mut host = HostKernel::open(&state).unwrap();
        host.set_effects_enabled(true);
        Self {
            root,
            workspace,
            state,
            host,
            fence: FrameFence::new(41, "inc_provenance").unwrap(),
            sequence: 0,
            location_id: None,
            managed_attempt_scope: None,
        }
    }

    fn send(
        &mut self,
        principal: &str,
        service: &str,
        operation: &str,
        body: Value,
        delivery: Option<&str>,
    ) -> RpcResponseV1 {
        self.sequence += 1;
        let request = RpcRequestV1 {
            owner_epoch: 41,
            process_incarnation: "inc_provenance".to_owned(),
            request_id: format!("req-prov-{}", self.sequence),
            service_id: service.to_owned(),
            operation: operation.to_owned(),
            delivery_id: delivery.map(str::to_owned),
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: "trace-prov".to_owned(),
            body,
        };
        let fence = self.fence.clone();
        self.host.handle_request(&request, principal, &fence)
    }

    fn managed(
        &mut self,
        principal: &str,
        operation: &str,
        body: Value,
        delivery: Option<&str>,
    ) -> RpcResponseV1 {
        self.send(principal, MANAGED_SERVICE_ID, operation, body, delivery)
    }

    fn register_location(&mut self) -> String {
        if let Some(location_id) = &self.location_id {
            return location_id.clone();
        }
        let response = self.send(
            "server_auth:provenance-location-owner",
            EFFECTS_SERVICE_ID,
            "register_location",
            map([
                ("canonicalRoot", string(self.workspace.to_str().unwrap())),
                ("workspaceID", string("workspace-one")),
            ]),
            None,
        );
        let body = ok_body(response);
        let location_id = field_text(&body, "locationID").to_owned();
        self.location_id = Some(location_id.clone());
        location_id
    }

    fn attempt_scope(&self) -> Value {
        self.managed_attempt_scope
            .clone()
            .expect("test fixture scope is built for a denied legacy Attempt")
    }

    fn durable_challenge_count(&self, batch: &str) -> i64 {
        let path = self
            .state
            .join("effect-locations")
            .join(self.location_id.as_deref().expect("Location is registered"))
            .join("effects.sqlite");
        if !path.is_file() {
            return 0;
        }
        let connection =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let has_table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='effect_challenges'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        if has_table == 0 {
            return 0;
        }
        connection
            .query_row(
                "SELECT COUNT(*) FROM effect_challenges WHERE batch_id=?1",
                [batch],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn bind_body(&self, location: &str, effect: &str, session: &str) -> Value {
        let mut scope = match self.attempt_scope() {
            Value::Map(fields) => fields,
            _ => unreachable!(),
        };
        scope.insert("locationID".to_owned(), string(location));
        scope.insert("sessionID".to_owned(), string(session));
        map([
            ("goalID", scope["goalID"].clone()),
            ("runID", scope["runID"].clone()),
            ("taskID", scope["taskID"].clone()),
            ("attemptID", scope["attemptID"].clone()),
            ("locationID", string(location)),
            ("effectID", string(effect)),
            ("sessionID", string(session)),
            ("managedAttempt", Value::Map(scope)),
        ])
    }

    /// Sends one managed `files.write` request; admission must deny it until the
    /// trusted immutable binding producer is wired.
    fn prepare_write(
        &mut self,
        location: &str,
        batch: &str,
        path: &str,
        content: &str,
    ) -> RpcResponseV1 {
        let scope = self.attempt_scope();
        self.send(
            EXECUTOR,
            EFFECTS_SERVICE_ID,
            "prepare_tool_batch",
            map([
                ("sessionID", string(SESSION)),
                ("locationID", string(location)),
                ("batchID", string(batch)),
                ("turnContextDigest", string(TURN_CONTEXT)),
                ("managedAttempt", scope),
                (
                    "calls",
                    Value::Array(vec![map([
                        ("callID", string("call_write")),
                        ("capabilityID", string("files.write")),
                        (
                            "arguments",
                            map([("path", string(path)), ("content", string(content))]),
                        ),
                    ])]),
                ),
            ]),
            None,
        )
    }

    fn prepare_unmanaged_write(
        &mut self,
        location: &str,
        batch: &str,
        path: &str,
        content: &str,
    ) -> (String, String) {
        let response = self.send(
            EXECUTOR,
            EFFECTS_SERVICE_ID,
            "prepare_tool_batch",
            map([
                ("sessionID", string(SESSION)),
                ("locationID", string(location)),
                ("batchID", string(batch)),
                ("turnContextDigest", string(TURN_CONTEXT)),
                (
                    "calls",
                    Value::Array(vec![map([
                        ("callID", string("call_write")),
                        ("capabilityID", string("files.write")),
                        (
                            "arguments",
                            map([("path", string(path)), ("content", string(content))]),
                        ),
                    ])]),
                ),
            ]),
            None,
        );
        let body = ok_body(response);
        assert_eq!(field_text(&body, "status"), "needs_approval");
        (
            field_text(&body, "challengeID").to_owned(),
            field_text(&body, "effectID").to_owned(),
        )
    }

    /// Approves one prepared write and returns its one-use capability lease.
    fn approve_write(&mut self, challenge: &str) -> String {
        let approved = self.send(
            EXECUTOR,
            EFFECTS_SERVICE_ID,
            "resolve_approval",
            map([
                ("challengeID", string(challenge)),
                ("decision", string("allow_once")),
            ]),
            None,
        );
        let body = ok_body(approved);
        assert_eq!(field_text(&body, "status"), "approved");
        field_text(&body, "capabilityLeaseDigest").to_owned()
    }

    fn execute_write(
        &mut self,
        location: &str,
        effect: &str,
        lease: &str,
        content: &str,
    ) -> RpcResponseV1 {
        let scope = self.attempt_scope();
        self.send(
            EXECUTOR,
            EFFECTS_SERVICE_ID,
            "execute_write",
            map([
                ("sessionID", string(SESSION)),
                ("locationID", string(location)),
                ("effectID", string(effect)),
                ("capabilityLeaseDigest", string(lease)),
                ("content", string(content)),
                ("managedAttempt", scope),
            ]),
            None,
        )
    }

    fn execute_unmanaged_write(
        &mut self,
        location: &str,
        effect: &str,
        lease: &str,
        content: &str,
    ) -> RpcResponseV1 {
        self.send(
            EXECUTOR,
            EFFECTS_SERVICE_ID,
            "execute_write",
            map([
                ("sessionID", string(SESSION)),
                ("locationID", string(location)),
                ("effectID", string(effect)),
                ("capabilityLeaseDigest", string(lease)),
                ("content", string(content)),
            ]),
            None,
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Seeds the accepted managed plan through a ready Task. The current runtime has
/// no typed owner-proof producer for profile/context/capability/resource facts, so
/// HostKernel admission must fail before creating an Attempt or advancing OwnerLog.
fn seed_ready_chain(fixture: &mut Fixture) -> u64 {
    fixture.register_location();
    let proposed = ok_body(fixture.managed(
        EXECUTOR,
        "create_goal_proposal",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("objective", string("Prove receipt provenance")),
            ("projectRef", string("project-one")),
            ("workspaceRef", string("workspace-one")),
            ("capabilityScope", Value::Array(vec![])),
            ("scope", Value::Array(vec![string("workspace/**")])),
            ("constraints", Value::Array(vec![])),
            (
                "criteria",
                Value::Array(vec![map([
                    ("id", string("write-receipt")),
                    (
                        "description",
                        string("The guarded write receipt is verified"),
                    ),
                ])]),
            ),
            (
                "budget",
                map([
                    ("maxTasks", Value::Unsigned(1)),
                    ("maxAttemptsPerTask", Value::Unsigned(1)),
                    ("maxRunDurationMs", Value::Unsigned(60_000)),
                    ("maxMemoryBytes", Value::Nil),
                    ("maxDiskBytes", Value::Nil),
                    ("maxWorkers", Value::Unsigned(1)),
                    ("maxTokens", Value::Nil),
                    ("maxCostMicros", Value::Nil),
                ]),
            ),
            ("sourceDigests", Value::Array(vec![])),
        ]),
        Some("prov-spec"),
    ));
    let digest = field_text(&proposed, "specDigest").to_owned();
    ok_body(fixture.managed(
        VERIFIER,
        "assign_spec_reviewer",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("specDigest", string(&digest)),
            ("expectedRevision", Value::Unsigned(1)),
        ]),
        Some("prov-reviewer-claim"),
    ));
    ok_body(fixture.managed(
        VERIFIER,
        "accept_spec",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("specDigest", string(&digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("prov-accept"),
    ));
    ok_body(fixture.managed(
        EXECUTOR,
        "start_run",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("specID", string(SPEC)),
        ]),
        Some("prov-run"),
    ));
    ok_body(fixture.managed(
        EXECUTOR,
        "add_task",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("dependencies", Value::Array(vec![])),
            ("criterionIDs", Value::Array(vec![string("write-receipt")])),
            ("requiredCapabilities", Value::Array(vec![])),
        ]),
        Some("prov-task"),
    ));
    ok_body(fixture.managed(
        EXECUTOR,
        "mark_task_ready",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
        ]),
        Some("prov-ready"),
    ));
    let location = fixture.register_location();
    let admission = fixture.managed(
        EXECUTOR,
        "admit",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
            ("expectedRevision", Value::Unsigned(6)),
            ("locationID", string(&location)),
            ("sessionID", string(SESSION)),
        ]),
        Some("prov-admit"),
    );
    assert_eq!(error_code(&admission), "capability_unavailable");
    let snapshot =
        ok_body(fixture.managed(EXECUTOR, "snapshot", map([("goalID", string(GOAL))]), None));
    let revision = field_unsigned(&snapshot, "revision");
    assert_eq!(revision, 6);
    assert!(matches!(field(&snapshot, "attempts"), Value::Array(attempts) if attempts.is_empty()));
    fixture.managed_attempt_scope = Some(map([
        ("goalID", string(GOAL)),
        ("runID", string(RUN)),
        ("taskID", string(TASK)),
        ("attemptID", string(ATTEMPT)),
        ("ownerEpoch", string("41")),
        ("expectedManagedRevision", string(&revision.to_string())),
        ("locationID", string(&location)),
        ("sessionID", string(SESSION)),
        (
            "delegationBindingDigest",
            string(&format!("blake3:{}", "a".repeat(64))),
        ),
        (
            "workspaceRevision",
            string(&format!("blake3:{}", blake3::hash(&[]).to_hex())),
        ),
    ]));
    revision
}

#[test]
fn managed_attempt_effect_admission_rejects_workspace_edit_since_attempt_admission() {
    let mut fixture = Fixture::new();
    seed_ready_chain(&mut fixture);
    let location = fixture.register_location();
    fs::write(
        fixture.workspace.join("human-edit.txt"),
        b"outside the Attempt",
    )
    .unwrap();

    let response = fixture.send(
        EXECUTOR,
        EFFECTS_SERVICE_ID,
        "prepare_tool_batch",
        map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location)),
            ("batchID", string("batch-after-human-edit")),
            ("turnContextDigest", string(TURN_CONTEXT)),
            ("managedAttempt", fixture.attempt_scope()),
            (
                "calls",
                Value::Array(vec![map([
                    ("callID", string("call_write")),
                    ("capabilityID", string("files.write")),
                    (
                        "arguments",
                        map([
                            ("path", string("unauthorized.txt")),
                            ("content", string("x")),
                        ]),
                    ),
                ])]),
            ),
        ]),
        None,
    );
    assert_eq!(error_code(&response), "stale_workspace_revision");
    assert!(!fixture.workspace.join("unauthorized.txt").exists());
    assert_eq!(
        field_unsigned(
            &ok_body(fixture.managed(EXECUTOR, "snapshot", map([("goalID", string(GOAL))]), None)),
            "revision"
        ),
        field_decimal_u64(&fixture.attempt_scope(), "expectedManagedRevision")
    );
}

#[test]
fn an_unrelated_settled_effect_cannot_be_attached_to_an_attempt_after_dispatch() {
    let mut fixture = Fixture::new();
    let admitted_revision = seed_ready_chain(&mut fixture);
    let location = fixture.register_location();
    let (challenge, effect) =
        fixture.prepare_unmanaged_write(&location, "batch-unrelated", "unrelated.txt", "content");
    let lease = fixture.approve_write(&challenge);
    let executed = ok_body(fixture.execute_unmanaged_write(&location, &effect, &lease, "content"));
    assert_eq!(field_text(&executed, "status"), "settled");
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("unrelated.txt")).unwrap(),
        "content"
    );

    // A same-principal, same-Session receipt is not proof that the effect was
    // authorized for this Attempt. The workspace has also changed since admission,
    // so the immutable Attempt revision must deny this late association before the
    // kernel considers the unrelated effect record.
    let late_bind = fixture.managed(
        EXECUTOR,
        "bind_attempt_effect",
        fixture.bind_body(&location, &effect, SESSION),
        Some("prov-late-bind"),
    );
    assert_eq!(error_code(&late_bind), "stale_workspace_revision");

    let settle = fixture.managed(
        EXECUTOR,
        "settle",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
            ("outcome", string("succeeded")),
            ("expectedRevision", Value::Unsigned(admitted_revision)),
        ]),
        Some("prov-unrelated-settle"),
    );
    assert_eq!(error_code(&settle), "managed_conflict");
    let snapshot =
        ok_body(fixture.managed(EXECUTOR, "snapshot", map([("goalID", string(GOAL))]), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), admitted_revision);
    assert!(matches!(field(&snapshot, "attempts"), Value::Array(attempts) if attempts.is_empty()));
}

#[test]
fn managed_effect_preparation_requires_an_authenticated_binding_before_effect_host() {
    let mut fixture = Fixture::new();
    let workspace = fixture.workspace.clone();
    let admitted_revision = seed_ready_chain(&mut fixture);
    let location = fixture.register_location();
    let response = fixture.prepare_write(
        &location,
        "batch-provenance",
        "provenance.txt",
        "guarded content",
    );
    assert_eq!(error_code(&response), "managed_not_found");
    assert_eq!(
        fixture.durable_challenge_count("batch-provenance"),
        0,
        "missing DelegationBinding must create no durable EffectHost challenge"
    );
    assert!(!workspace.join("provenance.txt").exists());
    let snapshot =
        ok_body(fixture.managed(EXECUTOR, "snapshot", map([("goalID", string(GOAL))]), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), admitted_revision);
    let attempts = match field(&snapshot, "attempts") {
        Value::Array(attempts) => attempts.clone(),
        other => panic!("attempts must be an array: {other:?}"),
    };
    assert!(attempts.is_empty());

    // Verification stays fail-closed: no trusted verifier adapter exists that could
    // supply authenticated criterion verdicts with bounded evidence bound to an
    // observed workspace revision, so every verifier path refuses without any
    // durable change. A bare principal or a kernel-computed binding hash must never
    // be treated as inspected evidence.
    let begun = fixture.managed(
        VERIFIER,
        "begin_verification",
        map([("goalID", string(GOAL)), ("runID", string(RUN))]),
        Some("prov-begin"),
    );
    assert_eq!(error_code(&begun), "capability_unavailable");
    let verified = fixture.managed(
        VERIFIER,
        "verify_task",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
        ]),
        Some("prov-verify"),
    );
    assert_eq!(error_code(&verified), "capability_unavailable");
    let evidence = fixture.managed(
        VERIFIER,
        "record_criterion_evidence",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("criterionID", string("write-receipt")),
        ]),
        Some("prov-evidence"),
    );
    assert_eq!(error_code(&evidence), "capability_unavailable");
    let finalized = fixture.managed(
        VERIFIER,
        "finalize_run",
        map([("goalID", string(GOAL)), ("runID", string(RUN))]),
        Some("prov-finalize"),
    );
    assert_eq!(error_code(&finalized), "capability_unavailable");
    let by_executor = fixture.managed(
        EXECUTOR,
        "verify_task",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
        ]),
        Some("prov-verify-executor"),
    );
    assert_eq!(error_code(&by_executor), "capability_unavailable");
    let by_uid = fixture.managed(
        "host_os_uid:1000",
        "verify_task",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
        ]),
        Some("prov-verify-uid"),
    );
    assert_eq!(error_code(&by_uid), "independent_verifier_required");

    // Verification stays closed and the Run remains at its admitted Attempt state.
    let snapshot =
        ok_body(fixture.managed(EXECUTOR, "snapshot", map([("goalID", string(GOAL))]), None));
    let run = match field(&snapshot, "runs") {
        Value::Array(runs) => runs[0].clone(),
        other => panic!("runs must be an array: {other:?}"),
    };
    assert_eq!(field_text(&run, "phase"), "RUNNING");
    assert!(matches!(field(&run, "finalRevision"), Value::Nil));
    let task = match field(&run, "tasks") {
        Value::Array(tasks) => tasks[0].clone(),
        other => panic!("tasks must be an array: {other:?}"),
    };
    assert!(matches!(field(&task, "verifiedRevision"), Value::Nil));
    assert!(matches!(field(&task, "verificationEvidence"), Value::Nil));
    assert!(matches!(
        field(&task, "pendingVerificationAttemptID"),
        Value::Nil
    ));
    assert!(matches!(
        field(&run, "criterionEvidence"),
        Value::Array(evidence) if evidence.is_empty()
    ));
}

#[test]
fn managed_settlement_refuses_forged_receipts_and_missing_attempt_binding() {
    let mut fixture = Fixture::new();
    let workspace = fixture.workspace.clone();
    let admitted_revision = seed_ready_chain(&mut fixture);
    let location = fixture.register_location();
    let (_challenge, effect) =
        fixture.prepare_unmanaged_write(&location, "batch-forged", "forged.txt", "content");
    let before = fixture.managed(EXECUTOR, "snapshot", map([("goalID", string(GOAL))]), None);
    assert_eq!(
        field_unsigned(&ok_body(before), "revision"),
        admitted_revision
    );

    // A caller-supplied receipt digest is not part of the settlement contract.
    let forged_digest = fixture.managed(
        EXECUTOR,
        "settle",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
            ("outcome", string("succeeded")),
            ("receiptDigest", string(&b3('a'))),
            ("expectedRevision", Value::Unsigned(admitted_revision)),
        ]),
        Some("prov-forged-digest"),
    );
    assert_eq!(error_code(&forged_digest), "invalid_effect_request");

    // Success without any bound effect is refused by the boundary.
    let unbound = fixture.managed(
        EXECUTOR,
        "settle",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
            ("outcome", string("succeeded")),
            ("expectedRevision", Value::Unsigned(admitted_revision)),
        ]),
        Some("prov-unbound"),
    );
    assert_eq!(error_code(&unbound), "managed_conflict");

    // The unrelated effect is durable, but a missing immutable Attempt binding
    // denies before it can be attached to this managed Attempt.
    let forged_bind = fixture.managed(
        EXECUTOR,
        "bind_attempt_effect",
        fixture.bind_body(&location, "eff_forged000000000000000000000000", SESSION),
        Some("prov-forged-bind"),
    );
    assert_eq!(error_code(&forged_bind), "managed_not_found");
    // An effect recorded for another Session cannot be bound by this caller.
    let wrong_session = fixture.managed(
        EXECUTOR,
        "bind_attempt_effect",
        fixture.bind_body(&location, &effect, "ses_other0000000000000000000000000"),
        Some("prov-wrong-session"),
    );
    assert_eq!(error_code(&wrong_session), "managed_not_found");
    // A principal that does not own the effect cannot bind it either.
    let wrong_principal = fixture.managed(
        VERIFIER,
        "bind_attempt_effect",
        fixture.bind_body(&location, &effect, SESSION),
        Some("prov-wrong-principal"),
    );
    assert_eq!(error_code(&wrong_principal), "managed_not_found");

    // None of the refusals advanced the durable revision, and the Attempt is
    // still EXECUTING with no bound effect or success.
    let snapshot =
        ok_body(fixture.managed(EXECUTOR, "snapshot", map([("goalID", string(GOAL))]), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), admitted_revision);
    let attempts = match field(&snapshot, "attempts") {
        Value::Array(attempts) => attempts.clone(),
        other => panic!("attempts must be an array: {other:?}"),
    };
    assert!(attempts.is_empty());
    assert!(!workspace.join("forged.txt").exists());

    // An UNKNOWN attempt outcome keeps the Run fenced and cannot be laundered after
    // recovery into success.
    let unknown = fixture.managed(
        EXECUTOR,
        "settle",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
            ("outcome", string("unknown")),
            ("expectedRevision", Value::Unsigned(admitted_revision)),
        ]),
        Some("prov-unknown"),
    );
    assert_eq!(error_code(&unknown), "managed_conflict");
    let laundered = fixture.managed(
        EXECUTOR,
        "settle",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
            ("outcome", string("succeeded")),
            ("expectedRevision", Value::Unsigned(admitted_revision + 1)),
        ]),
        Some("prov-launder"),
    );
    assert_eq!(error_code(&laundered), "managed_conflict");
    // Verification and finalization stay unavailable: no trusted verifier adapter
    // exists, and an unreconciled UNKNOWN Attempt could never be verified regardless.
    let verify = fixture.managed(
        VERIFIER,
        "verify_task",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
        ]),
        Some("prov-verify-fenced"),
    );
    assert_eq!(error_code(&verify), "capability_unavailable");
    let begin = fixture.managed(
        VERIFIER,
        "begin_verification",
        map([("goalID", string(GOAL)), ("runID", string(RUN))]),
        Some("prov-begin-fenced"),
    );
    assert_eq!(error_code(&begin), "capability_unavailable");
}

fn assert_attempt_receipt_nil(attempt: &Value) {
    assert!(
        matches!(field(attempt, "receiptDigest"), Value::Nil),
        "an unsettled Attempt must not carry a receipt digest"
    );
}

#[test]
fn managed_missing_binding_is_denied_before_prepare_and_restart_keeps_unknown_fenced() {
    let mut fixture = Fixture::new();
    let admitted_revision = seed_ready_chain(&mut fixture);
    let location = fixture.register_location();
    let response = fixture.prepare_write(&location, "batch-restart", "restart.txt", "content");
    assert_eq!(error_code(&response), "managed_not_found");
    assert!(!fixture.workspace.join("restart.txt").exists());
    assert_eq!(
        fixture.durable_challenge_count("batch-restart"),
        0,
        "missing DelegationBinding must create no durable EffectHost challenge"
    );

    // A host epoch boundary cannot resume an admitted but unsettled Attempt.
    let state = fixture.state.clone();
    fixture.host = HostKernel::open(&state).unwrap();
    fixture.host.set_effects_enabled(true);
    let recovered =
        ok_body(fixture.managed(EXECUTOR, "snapshot", map([("goalID", string(GOAL))]), None));
    let attempts = match field(&recovered, "attempts") {
        Value::Array(attempts) => attempts.clone(),
        other => panic!("attempts must be an array: {other:?}"),
    };
    assert!(attempts.is_empty());
    let settle_after_restart = fixture.managed(
        EXECUTOR,
        "settle",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("attemptID", string(ATTEMPT)),
            ("outcome", string("succeeded")),
            ("expectedRevision", Value::Unsigned(admitted_revision + 1)),
        ]),
        Some("prov-settle-after-restart"),
    );
    assert_eq!(error_code(&settle_after_restart), "managed_conflict");
    assert!(attempts.is_empty());
}
