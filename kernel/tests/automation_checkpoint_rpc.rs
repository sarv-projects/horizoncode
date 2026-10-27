#![cfg(target_os = "linux")]

//! HostKernel authenticated dispatch coverage for automation.v1 and checkpoint.v1.

use horizoncode_kernel::host_kernel::{AUTOMATION_SERVICE_ID, CHECKPOINT_SERVICE_ID, EFFECTS_SERVICE_ID, HostKernel};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{AuthenticatedPrincipalV1, FrameFence, RpcOutcomeV1, RpcRequestV1, RpcResponseV1};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const OWNER: &str = "automation-checkpoint-owner";
const EPOCH: u64 = 71;
const INCARNATION: &str = "inc_automation_checkpoint";
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn value_map<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(items.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}
fn string(value: &str) -> Value { Value::String(value.to_owned()) }
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }
fn request(service: &str, operation: &str, body: Value) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch: EPOCH, process_incarnation: INCARNATION.to_owned(),
        request_id: format!("req-{operation}"), service_id: service.to_owned(), operation: operation.to_owned(),
        delivery_id: None, expected_cursor: None, deadline_unix_ms: now_ms() + 30_000,
        trace_id: "trace-automation-checkpoint".to_owned(), body,
    }
}
fn body(response: RpcResponseV1) -> Value {
    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "unexpected error: {:?}", response.error);
    response.body.expect("success response must carry a body")
}
fn error_code(response: &RpcResponseV1) -> &str {
    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    response.error.as_ref().expect("error response must carry error").code.as_str()
}

struct Fixture { state: PathBuf, location_id: String, host: HostKernel, fence: FrameFence, auth: AuthenticatedPrincipalV1 }
impl Fixture {
    fn new() -> Self {
        let tick = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("hz-automation-checkpoint-{}-{tick}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)));
        let state = base.join("state"); let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap(); fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = fs::canonicalize(workspace).unwrap();
        let fence = FrameFence::new(EPOCH, INCARNATION).unwrap();
        let auth = AuthenticatedPrincipalV1::ServerAuth { subject: OWNER.to_owned() };
        let mut host = HostKernel::open(&state).unwrap();
        host.set_effects_enabled(true);
        let register = request(EFFECTS_SERVICE_ID, "register_location", value_map([
            ("canonicalRoot", string(workspace.to_str().unwrap())),
            ("workspaceID", string("automation-checkpoint-workspace")),
        ]));
        let response = host.handle_authenticated_request_with_context_and_cancellation(&register, &auth, &fence, None, None);
        let registered = body(response);
        let location_id = match &registered {
            Value::Map(fields) => match fields.get("locationID") { Some(Value::String(id)) => id.clone(), other => panic!("missing locationID: {other:?}") },
            other => panic!("expected registration map, got {other:?}"),
        };
        Self { state, location_id, host, fence, auth }
    }
    fn send_as(&mut self, auth: &AuthenticatedPrincipalV1, request: &RpcRequestV1) -> RpcResponseV1 {
        self.host.handle_authenticated_request_with_context_and_cancellation(request, auth, &self.fence, None, None)
    }
    fn send(&mut self, request: &RpcRequestV1) -> RpcResponseV1 { self.send_as(&self.auth.clone(), request) }
}
impl Drop for Fixture {
    fn drop(&mut self) { if let Some(root) = self.state.parent() { let _ = fs::remove_dir_all(root); } }
}

#[test]
fn authenticated_dispatch_reaches_automation_and_checkpoint_read_handlers() {
    let mut fixture = Fixture::new();
    let list_automations = request(AUTOMATION_SERVICE_ID, "automations.list", value_map([("locationID", string(&fixture.location_id))]));
    let automations = body(fixture.send(&list_automations));
    assert!(matches!(&automations, Value::Map(fields) if matches!(fields.get("automations"), Some(Value::Array(items)) if items.is_empty())));

    let list_checkpoints = request(CHECKPOINT_SERVICE_ID, "checkpoint.list", value_map([
        ("locationID", string(&fixture.location_id)), ("sessionID", string("ses_checkpoint_test")),
    ]));
    let checkpoints = body(fixture.send(&list_checkpoints));
    assert!(matches!(&checkpoints, Value::Map(fields) if matches!(fields.get("checkpointIDs"), Some(Value::Array(items)) if items.is_empty())));

    let preview = request(CHECKPOINT_SERVICE_ID, "checkpoint.restore_preview", value_map([
        ("checkpointID", string("checkpoint_missing")), ("locationID", string(&fixture.location_id)),
        ("sessionID", string("ses_checkpoint_test")), ("mode", string("FULL")), ("selectedPaths", Value::Array(Vec::new())),
    ]));
    assert_eq!(error_code(&fixture.send(&preview)), "checkpoint_not_found");
}

#[test]
fn automation_mutation_without_guard_admission_proof_stays_unknown_and_unmutated() {
    let mut fixture = Fixture::new();
    let mutation = request(AUTOMATION_SERVICE_ID, "automations.enable", value_map([
        ("locationID", string(&fixture.location_id)), ("userActionID", string("act_forged_action")),
        ("challengeID", string("challenge_forged")), ("effectID", string("effect_forged")),
        ("capabilityLeaseDigest", string(&format!("blake3:{}", "a".repeat(64)))),
        ("inputDigest", string(&format!("blake3:{}", "b".repeat(64)))),
        ("automationID", string("automation_forged")), ("expectedVersion", Value::String("1".to_owned())),
        ("idempotencyKey", string("idem_forged")),
    ]));
    assert_eq!(error_code(&fixture.send(&mutation)), "automation_outcome_unknown");
    let list = request(AUTOMATION_SERVICE_ID, "automations.list", value_map([("locationID", string(&fixture.location_id))]));
    let listed = body(fixture.send(&list));
    assert!(matches!(&listed, Value::Map(fields) if matches!(fields.get("automations"), Some(Value::Array(items)) if items.is_empty())));
}

#[test]
fn forged_owner_principal_cannot_read_another_owners_service_scope() {
    let mut fixture = Fixture::new();
    let forged = AuthenticatedPrincipalV1::ServerAuth { subject: "not-the-owner".to_owned() };
    let automation_list = request(AUTOMATION_SERVICE_ID, "automations.list", value_map([("locationID", string(&fixture.location_id))]));
    assert_eq!(error_code(&fixture.send_as(&forged, &automation_list)), "effect_denied");
    let checkpoint_list = request(CHECKPOINT_SERVICE_ID, "checkpoint.list", value_map([
        ("locationID", string(&fixture.location_id)), ("sessionID", string("ses_checkpoint_test")),
    ]));
    assert_eq!(error_code(&fixture.send_as(&forged, &checkpoint_list)), "effect_denied");
}
