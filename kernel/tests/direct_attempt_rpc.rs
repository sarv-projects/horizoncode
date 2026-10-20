#![cfg(target_os = "linux")]

//! Authenticated `managed.v1` direct (Goal-less) subagent Attempt tests.
//!
//! Direct coding does not create a managed Goal, so the dispatch fence for a `Task`
//! child is one durable Attempt owner log. These tests exercise only the
//! authenticated host socket boundary: admit / settle / cancel / snapshot, one-use
//! delivery keys and Attempt ids, fail-closed negatives, restart recovery and goal
//! isolation.

use horizoncode_kernel::host_kernel::{EFFECTS_SERVICE_ID, HostKernel, MANAGED_SERVICE_ID};
use horizoncode_kernel::managed_control::{
    DirectAttemptCommand, DirectAttemptControl, DirectAttemptEffectIntent, DirectAttemptIntent,
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
const REVIEWER: &str = "server_auth:reviewer";
const EPOCH: u64 = 23;
const INCARNATION: &str = "inc_direct_attempt";
const ATTEMPT: &str = "att_direct0000000000000000000000000001";

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

struct Fixture {
    state: PathBuf,
    workspace: PathBuf,
    location_id: String,
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
            "hz-direct-attempt-{}-{tick}-{}",
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
        let mut host = HostKernel::open(&state).unwrap();
        host.set_effects_enabled(true);
        let register = RpcRequestV1 {
            owner_epoch: EPOCH,
            process_incarnation: INCARNATION.to_owned(),
            request_id: "req-register-direct-location".to_owned(),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: "register_location".to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: "trace-direct-location".to_owned(),
            body: map([
                ("canonicalRoot", string(workspace.to_str().unwrap())),
                ("workspaceID", string("workspace-direct")),
            ]),
        };
        let fence = FrameFence::new(EPOCH, INCARNATION).unwrap();
        let location_id = field_text(
            &ok_body(host.handle_request(&register, PRINCIPAL, &fence)),
            "locationID",
        )
        .to_owned();
        Self {
            state,
            workspace,
            location_id,
            host: Some(host),
            fence: FrameFence::new(EPOCH, INCARNATION).unwrap(),
            sequence: 0,
        }
    }

    fn host(&mut self) -> &mut HostKernel {
        self.host.as_mut().unwrap()
    }

    fn send(&mut self, operation: &str, body: Value, delivery: Option<&str>) -> RpcResponseV1 {
        self.send_as(PRINCIPAL, operation, body, delivery)
    }

    fn send_as(
        &mut self,
        principal: &str,
        operation: &str,
        body: Value,
        delivery: Option<&str>,
    ) -> RpcResponseV1 {
        self.sequence += 1;
        let request = managed_request(operation, body, delivery, self.sequence);
        let fence = self.fence.clone();
        self.host().handle_request(&request, principal, &fence)
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
        request_id: format!("req-direct-{sequence}"),
        service_id: MANAGED_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: delivery.map(str::to_owned),
        expected_cursor: None,
        deadline_unix_ms: now_ms() + 30_000,
        trace_id: "trace-direct".to_owned(),
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
    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    assert!(response.body.is_none());
    response
        .error
        .as_ref()
        .expect("error response must carry an error")
        .code
        .as_str()
}

fn admit_body(fixture: &Fixture, attempt_id: &str) -> Value {
    admit_body_for(
        fixture,
        attempt_id,
        "ses_child000000000000000000000000001",
        "general",
        'a',
    )
}

fn admit_body_for(
    fixture: &Fixture,
    attempt_id: &str,
    child_session: &str,
    agent: &str,
    scope_seed: char,
) -> Value {
    map([
        ("attemptID", string(attempt_id)),
        (
            "parentSessionID",
            string("ses_parent00000000000000000000000000"),
        ),
        ("childSessionID", string(child_session)),
        ("agent", string(agent)),
        ("scopeDigest", string(&sha(scope_seed))),
        ("locationID", string(&fixture.location_id)),
        ("workspaceID", string("workspace-direct")),
        ("capabilityDigest", string(&sha('b'))),
        ("permissionsDigest", string(&sha('c'))),
        ("budgetDigest", string(&sha('d'))),
    ])
}

fn owner_directory(state: &Path, kind: &str, id: &str) -> PathBuf {
    let key = OwnerIdentity::new(kind.to_owned(), id.to_owned())
        .unwrap()
        .directory_key();
    state.join("managed-control").join("owners").join(key)
}

#[test]
fn direct_attempt_rpc_admits_settles_and_reads_back_one_attempt() {
    let mut fixture = Fixture::new();

    let admitted = ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("att-admit-1"),
    ));
    assert_eq!(field_text(&admitted, "status"), "ADMITTED");
    assert_eq!(field_text(&admitted, "attemptPhase"), "EXECUTING");
    assert_eq!(field_text(&admitted, "attemptID"), ATTEMPT);
    assert_eq!(
        field_text(&admitted, "parentSessionID"),
        "ses_parent00000000000000000000000000"
    );
    assert_eq!(
        field_text(&admitted, "childSessionID"),
        "ses_child000000000000000000000000001"
    );
    assert_eq!(field_text(&admitted, "agent"), "general");
    assert_eq!(field_text(&admitted, "scopeDigest"), sha('a'));
    let direct_scope = field(&admitted, "directAttempt").clone();
    assert_eq!(field_text(&direct_scope, "attemptID"), ATTEMPT);
    assert_eq!(field_text(&direct_scope, "locationID"), fixture.location_id);
    assert_eq!(field_text(&direct_scope, "workspaceID"), "workspace-direct");
    assert!(field_text(&direct_scope, "workspaceRevision").starts_with("blake3:"));
    assert_eq!(field_unsigned(&direct_scope, "expectedRevision"), 1);
    assert_eq!(field_unsigned(&admitted, "revision"), 1);
    assert_nil(&admitted, "receiptDigest");

    // An exact replay of the same one-use key is idempotent, even though the
    // aggregate revision advanced with the admission itself.
    let replayed = ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("att-admit-1"),
    ));
    assert_eq!(field_text(&replayed, "status"), "ADMITTED");
    assert_eq!(field_unsigned(&replayed, "revision"), 1);

    let settled = ok_body(fixture.send(
        "settle_direct_attempt",
        map([
            ("attemptID", string(ATTEMPT)),
            ("outcome", string("succeeded")),
            ("resultDigest", string(&sha('b'))),
            ("expectedRevision", Value::Unsigned(1)),
        ]),
        Some("att-settle-1"),
    ));
    assert_eq!(field_text(&settled, "status"), "SETTLED");
    assert_eq!(field_text(&settled, "outcome"), "SUCCEEDED");
    assert_eq!(field_text(&settled, "attemptPhase"), "SUCCEEDED");
    assert_eq!(field_text(&settled, "resultDigest"), sha('b'));
    assert!(field_text(&settled, "receiptDigest").starts_with("blake3:"));
    assert_eq!(field_unsigned(&settled, "revision"), 2);
    let receipt = field_text(&settled, "receiptDigest").to_owned();

    // The recorded receipt is reproducible from the durable facts, so a replay of the
    // same settlement returns the identical digest instead of a fresh one.
    let replayed_settle = ok_body(fixture.send(
        "settle_direct_attempt",
        map([
            ("attemptID", string(ATTEMPT)),
            ("outcome", string("succeeded")),
            ("resultDigest", string(&sha('b'))),
            ("expectedRevision", Value::Unsigned(1)),
        ]),
        Some("att-settle-1"),
    ));
    assert_eq!(field_text(&replayed_settle, "receiptDigest"), receipt);
    assert_eq!(field_unsigned(&replayed_settle, "revision"), 2);

    let snapshot = ok_body(fixture.send(
        "direct_attempt_snapshot",
        map([("attemptID", string(ATTEMPT))]),
        None,
    ));
    assert_eq!(field_text(&snapshot, "status"), "SNAPSHOT");
    assert_eq!(field_text(&snapshot, "attemptPhase"), "SUCCEEDED");
    assert_eq!(field_text(&snapshot, "receiptDigest"), receipt);
    assert_eq!(field_text(&snapshot, "resultDigest"), sha('b'));
    assert_nil(&snapshot, "failureCode");
    assert_nil(&snapshot, "retryable");
}

#[test]
fn direct_attempt_effect_scope_rejects_workspace_edits_after_admission() {
    let mut fixture = Fixture::new();
    let admitted = ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("att-admit-workspace-edit"),
    ));
    let direct_scope = field(&admitted, "directAttempt").clone();
    fs::write(
        fixture.workspace.join("human-edit.txt"),
        b"outside the admitted revision",
    )
    .unwrap();

    let response = fixture.send(
        "bind_direct_attempt_effects",
        map([
            ("attemptID", string(ATTEMPT)),
            ("locationID", string(&fixture.location_id)),
            ("sessionID", string("ses_child000000000000000000000000001")),
            (
                "effectIDs",
                Value::Array(vec![string("effect-after-human-edit")]),
            ),
            ("directAttempt", direct_scope),
        ]),
        Some("bind-after-workspace-edit"),
    );
    assert_eq!(error_code(&response), "stale_workspace_revision");
    let snapshot = ok_body(fixture.send(
        "direct_attempt_snapshot",
        map([("attemptID", string(ATTEMPT))]),
        None,
    ));
    assert_eq!(field_unsigned(&snapshot, "revision"), 1);
    assert_eq!(field_text(&snapshot, "attemptPhase"), "EXECUTING");
}

#[test]
fn direct_attempt_effect_batch_rejects_duplicate_members_without_mutation() {
    let mut fixture = Fixture::new();
    let admitted = ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("att-admit-duplicate-effects"),
    ));
    let response = fixture.send(
        "bind_direct_attempt_effects",
        map([
            ("attemptID", string(ATTEMPT)),
            ("locationID", string(&fixture.location_id)),
            ("sessionID", string("ses_child000000000000000000000000001")),
            (
                "effectIDs",
                Value::Array(vec![string("effect-same"), string("effect-same")]),
            ),
            ("directAttempt", field(&admitted, "directAttempt").clone()),
        ]),
        Some("bind-duplicate-effects"),
    );
    assert_eq!(error_code(&response), "invalid_effect_request");
    let snapshot = ok_body(fixture.send(
        "direct_attempt_snapshot",
        map([("attemptID", string(ATTEMPT))]),
        None,
    ));
    assert_eq!(field_unsigned(&snapshot, "revision"), 1);
}

#[test]
fn direct_attempt_effect_batches_are_atomic_revision_bound_and_restart_durable() {
    let fixture = Fixture::new();
    let intent = DirectAttemptIntent {
        parent_session_id: "ses_parent000000000000000000000000001".to_owned(),
        child_session_id: "ses_child000000000000000000000000001".to_owned(),
        agent: "general".to_owned(),
        executor_principal: PRINCIPAL.to_owned(),
        owner_epoch: EPOCH,
        location_id: fixture.location_id.clone(),
        workspace_id: "workspace_direct".to_owned(),
        workspace_revision: format!("blake3:{}", "a".repeat(64)),
        capability_digest: sha('b'),
        permissions_digest: sha('c'),
        budget_digest: sha('d'),
        scope_digest: sha('e'),
    };
    let mut control = DirectAttemptControl::create(&fixture.state, ATTEMPT).unwrap();
    control
        .apply(
            0,
            "admit-direct-batch",
            DirectAttemptCommand::Admit { intent },
        )
        .unwrap();
    let first_batch = DirectAttemptCommand::BindEffects(vec![
        DirectAttemptEffectIntent {
            effect_id: "effect-batch-one".to_owned(),
            location_id: fixture.location_id.clone(),
            session_id: "ses_child000000000000000000000000001".to_owned(),
        },
        DirectAttemptEffectIntent {
            effect_id: "effect-batch-two".to_owned(),
            location_id: fixture.location_id.clone(),
            session_id: "ses_child000000000000000000000000001".to_owned(),
        },
    ]);
    control
        .apply(1, "bind-direct-batch-1", first_batch.clone())
        .unwrap();
    assert_eq!(control.revision(), 2);
    assert_eq!(control.record().unwrap().effect_intents.len(), 2);

    // Exact delivery replay is idempotent; a reused delivery with a different
    // effect set and a stale CAS cannot partially append another member.
    control
        .apply(1, "bind-direct-batch-1", first_batch.clone())
        .unwrap();
    assert_eq!(control.revision(), 2);
    let conflicting_replay = DirectAttemptCommand::BindEffects(vec![DirectAttemptEffectIntent {
        effect_id: "effect-conflict".to_owned(),
        location_id: fixture.location_id.clone(),
        session_id: "ses_child000000000000000000000000001".to_owned(),
    }]);
    assert!(
        control
            .apply(2, "bind-direct-batch-1", conflicting_replay.clone())
            .is_err()
    );
    assert!(
        control
            .apply(1, "bind-direct-batch-2", conflicting_replay.clone())
            .is_err()
    );
    assert_eq!(control.revision(), 2);
    assert_eq!(control.record().unwrap().effect_intents.len(), 2);

    drop(control);
    let reopened = DirectAttemptControl::open_existing(&fixture.state, ATTEMPT).unwrap();
    assert_eq!(reopened.revision(), 2);
    assert_eq!(reopened.record().unwrap().effect_intents.len(), 2);
}

#[test]
fn direct_attempt_rpc_records_a_typed_failure_and_refuses_laundering() {
    let mut fixture = Fixture::new();
    ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("att-admit-1"),
    ));

    // Malformed settlements are rejected before any durable command applies.
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("outcome", string("succeeded")),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("settle-missing-result"),
        )),
        "invalid_effect_request"
    );
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("outcome", string("failed")),
                ("resultDigest", string(&sha('b'))),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("settle-missing-failure-code"),
        )),
        "invalid_effect_request"
    );
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("outcome", string("unknown")),
                ("resultDigest", string(&sha('b'))),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("unknown-with-result"),
        )),
        "invalid_effect_request"
    );
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("outcome", string("invented")),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("invented-outcome"),
        )),
        "invalid_effect_request"
    );

    let failed = ok_body(fixture.send(
        "settle_direct_attempt",
        map([
            ("attemptID", string(ATTEMPT)),
            ("outcome", string("failed")),
            ("resultDigest", string(&sha('c'))),
            ("failureCode", string("child_failed")),
            ("retryable", Value::Bool(false)),
            ("expectedRevision", Value::Unsigned(1)),
        ]),
        Some("settle-failed-1"),
    ));
    assert_eq!(field_text(&failed, "outcome"), "FAILED");
    assert_eq!(field_text(&failed, "attemptPhase"), "FAILED");
    assert_eq!(field_text(&failed, "failureCode"), "child_failed");
    assert_eq!(field(&failed, "retryable"), &Value::Bool(false));
    assert!(field_text(&failed, "receiptDigest").starts_with("blake3:"));

    // A settled Attempt can never be settled again, and cannot be cancelled.
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("outcome", string("succeeded")),
                ("resultDigest", string(&sha('d'))),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("settle-after-terminal"),
        )),
        "managed_conflict"
    );
    assert_eq!(
        error_code(&fixture.send(
            "cancel_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("cancel-after-terminal"),
        )),
        "managed_conflict"
    );
}

#[test]
fn direct_attempt_rpc_cancels_pending_work_and_keeps_unknown_fenced() {
    let mut fixture = Fixture::new();
    let admitted = ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("att-admit-1"),
    ));
    let direct_scope = field(&admitted, "directAttempt").clone();

    let cancelled = ok_body(fixture.send(
        "cancel_direct_attempt",
        map([
            ("attemptID", string(ATTEMPT)),
            ("expectedRevision", Value::Unsigned(1)),
        ]),
        Some("cancel-1"),
    ));
    assert_eq!(field_text(&cancelled, "status"), "CANCELLED");
    assert_eq!(field_text(&cancelled, "attemptPhase"), "CANCELLED");
    assert_eq!(field_unsigned(&cancelled, "revision"), 2);

    // The envelope is bound to the admission revision and cannot be replayed
    // after a durable state transition, even before challenge lookup.
    assert_eq!(
        error_code(&fixture.send(
            "bind_direct_attempt_effects",
            map([
                ("attemptID", string(ATTEMPT)),
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_child000000000000000000000000001")),
                ("effectIDs", Value::Array(vec![string("effect-stale")])),
                ("directAttempt", direct_scope),
            ]),
            Some("bind-stale-revision"),
        )),
        "stale_managed_revision"
    );

    // Repeating the cancellation with a fresh key stays idempotent.
    let repeated = ok_body(fixture.send(
        "cancel_direct_attempt",
        map([
            ("attemptID", string(ATTEMPT)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("cancel-2"),
    ));
    assert_eq!(field_text(&repeated, "attemptPhase"), "CANCELLED");
    assert_eq!(field_unsigned(&repeated, "revision"), 2);

    // A cancelled Attempt cannot be settled as success later.
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("outcome", string("succeeded")),
                ("resultDigest", string(&sha('e'))),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("settle-after-cancel"),
        )),
        "managed_conflict"
    );

    // An explicit UNKNOWN settlement is durable and cannot be laundered either.
    const SECOND: &str = "att_direct0000000000000000000000000002";
    ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body_for(
            &fixture,
            SECOND,
            "ses_child000000000000000000000000002",
            "general",
            'f',
        ),
        Some("att2-admit-1"),
    ));
    let unknown = ok_body(fixture.send(
        "settle_direct_attempt",
        map([
            ("attemptID", string(SECOND)),
            ("outcome", string("unknown")),
            ("expectedRevision", Value::Unsigned(1)),
        ]),
        Some("settle-unknown-1"),
    ));
    assert_eq!(field_text(&unknown, "outcome"), "UNKNOWN");
    assert_eq!(field_text(&unknown, "attemptPhase"), "UNKNOWN");
    assert_nil(&unknown, "receiptDigest");
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(SECOND)),
                ("outcome", string("succeeded")),
                ("resultDigest", string(&sha('a'))),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("launder-unknown"),
        )),
        "managed_conflict"
    );
    assert_eq!(
        error_code(&fixture.send(
            "cancel_direct_attempt",
            map([
                ("attemptID", string(SECOND)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("cancel-unknown"),
        )),
        "managed_conflict"
    );
}

#[test]
fn direct_attempt_rpc_rejects_reused_ids_and_forged_attempts_with_zero_allocation() {
    let mut fixture = Fixture::new();
    ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("att-admit-1"),
    ));

    // Attempt ids are one-use: a fresh key cannot claim an admitted Attempt, and a
    // different logical admission can never reuse the same Attempt id.
    assert_eq!(
        error_code(&fixture.send(
            "admit_direct_attempt",
            admit_body(&fixture, ATTEMPT),
            Some("att-admit-2")
        )),
        "managed_conflict"
    );
    assert_eq!(
        error_code(&fixture.send(
            "admit_direct_attempt",
            admit_body_for(
                &fixture,
                ATTEMPT,
                "ses_child000000000000000000000000009",
                "general",
                'a',
            ),
            Some("att-admit-1"),
        )),
        "managed_conflict"
    );

    // An unknown Attempt is NOT_FOUND and allocates no durable owner state.
    const FORGED: &str = "att_direct00000000000000000000000000ff";
    for (operation, body) in [
        (
            "direct_attempt_snapshot",
            map([("attemptID", string(FORGED))]),
        ),
        (
            "settle_direct_attempt",
            map([
                ("attemptID", string(FORGED)),
                ("outcome", string("succeeded")),
                ("resultDigest", string(&sha('a'))),
                ("expectedRevision", Value::Unsigned(0)),
            ]),
        ),
        (
            "cancel_direct_attempt",
            map([
                ("attemptID", string(FORGED)),
                ("expectedRevision", Value::Unsigned(0)),
            ]),
        ),
    ] {
        let response = fixture.send(operation, body, Some(&format!("forged-{operation}")));
        assert_eq!(error_code(&response), "managed_not_found", "{operation}");
    }
    assert!(
        !owner_directory(&fixture.state, "direct_attempt", FORGED).exists(),
        "a forged Attempt must not allocate durable owner state"
    );

    // A stale revision fence is refused even for a fresh key.
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("outcome", string("succeeded")),
                ("resultDigest", string(&sha('b'))),
                ("expectedRevision", Value::Unsigned(7)),
            ]),
            Some("stale-revision"),
        )),
        "managed_conflict"
    );

    let snapshot = ok_body(fixture.send(
        "direct_attempt_snapshot",
        map([("attemptID", string(ATTEMPT))]),
        None,
    ));
    assert_eq!(field_text(&snapshot, "attemptPhase"), "EXECUTING");
    assert_eq!(field_unsigned(&snapshot, "revision"), 1);
}

#[test]
fn direct_attempt_rpc_one_use_keys_principal_and_fence_negatives() {
    let mut fixture = Fixture::new();
    let fence = fixture.fence.clone();
    let request = managed_request(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("direct-1"),
        1,
    );

    assert_eq!(
        error_code(&fixture.host().handle_request(&request, "", &fence)),
        "missing_principal"
    );
    assert_eq!(
        error_code(&fixture.host().handle_request(&request, "anonymous", &fence)),
        "missing_principal"
    );

    let mut stale = managed_request(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("direct-2"),
        2,
    );
    stale.owner_epoch = EPOCH + 1;
    assert_eq!(
        error_code(&fixture.host().handle_request(&stale, PRINCIPAL, &fence)),
        "stale_fence"
    );

    let expired = RpcRequestV1 {
        deadline_unix_ms: 1,
        ..managed_request(
            "admit_direct_attempt",
            admit_body(&fixture, ATTEMPT),
            Some("direct-3"),
            3,
        )
    };
    assert_eq!(
        error_code(&fixture.host().handle_request(&expired, PRINCIPAL, &fence)),
        "deadline_exceeded"
    );

    let mut unknown_service = managed_request(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("direct-4"),
        4,
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

    // A mutating direct Attempt always requires its one-use delivery key.
    assert_eq!(
        error_code(&fixture.send("admit_direct_attempt", admit_body(&fixture, ATTEMPT), None)),
        "invalid_effect_request"
    );
    assert_eq!(
        error_code(&fixture.send(
            "admit_direct_attempt",
            admit_body(&fixture, ATTEMPT),
            Some(&"d".repeat(201))
        )),
        "invalid_effect_request"
    );
    // Fields are validated before any durable owner state can be allocated.
    assert_eq!(
        error_code(&fixture.send(
            "admit_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                (
                    "parentSessionID",
                    string("ses_parent00000000000000000000000000")
                ),
                (
                    "childSessionID",
                    string("ses_child000000000000000000000000001")
                ),
                ("agent", string("general")),
                ("scopeDigest", string("blake3:not-a-canonical-digest")),
                ("locationID", string(&fixture.location_id)),
                ("workspaceID", string("workspace-direct")),
                ("capabilityDigest", string(&sha('b'))),
                ("permissionsDigest", string(&sha('c'))),
                ("budgetDigest", string(&sha('d'))),
            ]),
            Some("bad-scope-digest"),
        )),
        "invalid_managed_request"
    );
    assert_eq!(
        error_code(&fixture.send(
            "admit_direct_attempt",
            map([
                ("attemptID", string("att_with out spaces")),
                (
                    "parentSessionID",
                    string("ses_parent00000000000000000000000000")
                ),
                (
                    "childSessionID",
                    string("ses_child000000000000000000000000001")
                ),
                ("agent", string("general")),
                ("scopeDigest", string(&sha('a'))),
                ("locationID", string(&fixture.location_id)),
                ("workspaceID", string("workspace-direct")),
                ("capabilityDigest", string(&sha('b'))),
                ("permissionsDigest", string(&sha('c'))),
                ("budgetDigest", string(&sha('d'))),
            ]),
            Some("bad-attempt-id"),
        )),
        "invalid_managed_request"
    );
    // Oversized bodies and unexpected fields fail closed before allocation.
    assert_eq!(
        error_code(&fixture.send(
            "admit_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                (
                    "parentSessionID",
                    string("ses_parent00000000000000000000000000")
                ),
                (
                    "childSessionID",
                    string("ses_child000000000000000000000000001")
                ),
                ("agent", string("general")),
                ("scopeDigest", string(&sha('a'))),
                ("padding", string(&"p".repeat(7 * 1024 * 1024))),
            ]),
            Some("oversized-body"),
        )),
        "invalid_effect_request"
    );
    assert_eq!(
        error_code(&fixture.send(
            "admit_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                (
                    "parentSessionID",
                    string("ses_parent00000000000000000000000000")
                ),
                (
                    "childSessionID",
                    string("ses_child000000000000000000000000001")
                ),
                ("agent", string("general")),
                ("scopeDigest", string(&sha('a'))),
                ("extraField", string("rejected")),
            ]),
            Some("extra-field"),
        )),
        "invalid_effect_request"
    );
    assert!(
        !owner_directory(&fixture.state, "direct_attempt", ATTEMPT).exists(),
        "rejected admissions must not allocate durable owner state"
    );

    // A one-use key cannot be reused for a different logical command.
    ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("direct-5"),
    ));
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("outcome", string("unknown")),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("direct-5"),
        )),
        "managed_conflict"
    );

    let snapshot = ok_body(fixture.send(
        "direct_attempt_snapshot",
        map([("attemptID", string(ATTEMPT))]),
        None,
    ));
    assert_eq!(field_text(&snapshot, "attemptPhase"), "EXECUTING");
}

#[test]
fn direct_attempt_rpc_restart_recovery_fences_an_in_flight_attempt() {
    let mut fixture = Fixture::new();
    ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("att-admit-1"),
    ));

    // A host epoch boundary cannot prove whether the child work launched, so
    // recovery records UNKNOWN and never resumes the Attempt.
    drop(fixture.host.take());
    fixture.host = Some(HostKernel::open(&fixture.state).unwrap());

    let snapshot = ok_body(fixture.send(
        "direct_attempt_snapshot",
        map([("attemptID", string(ATTEMPT))]),
        None,
    ));
    assert_eq!(field_text(&snapshot, "attemptPhase"), "UNKNOWN");
    assert_eq!(field_unsigned(&snapshot, "revision"), 1);
    assert_eq!(
        error_code(&fixture.send(
            "settle_direct_attempt",
            map([
                ("attemptID", string(ATTEMPT)),
                ("outcome", string("succeeded")),
                ("resultDigest", string(&sha('b'))),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("settle-recovered"),
        )),
        "managed_conflict"
    );
    // Replaying the original admission must never look like a fresh dispatch.
    assert_eq!(
        error_code(&fixture.send(
            "admit_direct_attempt",
            admit_body(&fixture, ATTEMPT),
            Some("att-admit-1")
        )),
        "managed_attempt_unknown"
    );

    // A fresh Attempt id is required to retry the child work.
    const RETRY: &str = "att_direct0000000000000000000000000003";
    let retried = ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, RETRY),
        Some("att-retry-admit-1"),
    ));
    assert_eq!(field_text(&retried, "attemptPhase"), "EXECUTING");
}

#[test]
fn direct_attempt_rpc_isolation_and_goal_interoperability() {
    let mut fixture = Fixture::new();
    const OTHER: &str = "att_direct0000000000000000000000000004";

    ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body(&fixture, ATTEMPT),
        Some("att-admit-1"),
    ));
    ok_body(fixture.send(
        "admit_direct_attempt",
        admit_body_for(
            &fixture,
            OTHER,
            "ses_child000000000000000000000000004",
            "explore",
            'b',
        ),
        Some("other-admit-1"),
    ));
    ok_body(fixture.send(
        "cancel_direct_attempt",
        map([
            ("attemptID", string(OTHER)),
            ("expectedRevision", Value::Unsigned(1)),
        ]),
        Some("other-cancel-1"),
    ));

    let first = ok_body(fixture.send(
        "direct_attempt_snapshot",
        map([("attemptID", string(ATTEMPT))]),
        None,
    ));
    assert_eq!(field_text(&first, "attemptPhase"), "EXECUTING");
    assert_eq!(field_text(&first, "agent"), "general");
    let second = ok_body(fixture.send(
        "direct_attempt_snapshot",
        map([("attemptID", string(OTHER))]),
        None,
    ));
    assert_eq!(field_text(&second, "attemptPhase"), "CANCELLED");
    assert_eq!(field_text(&second, "agent"), "explore");

    // A Goal-less direct Attempt and the managed Goal chain share the boundary but
    // not their state: an unknown Goal still fails closed as NOT_FOUND.
    assert_eq!(
        error_code(&fixture.send("snapshot", map([("goalID", string("goal-absent"))]), None)),
        "managed_not_found"
    );

    // The authenticated review principal can also drive direct Attempts; the
    // admitted record keeps the fields the caller supplied.
    const THIRD: &str = "att_direct0000000000000000000000000005";
    let by_reviewer = ok_body(fixture.send_as(
        REVIEWER,
        "admit_direct_attempt",
        admit_body_for(
            &fixture,
            THIRD,
            "ses_child000000000000000000000000005",
            "general",
            'a',
        ),
        Some("third-admit-1"),
    ));
    assert_eq!(field_text(&by_reviewer, "attemptPhase"), "EXECUTING");
}
