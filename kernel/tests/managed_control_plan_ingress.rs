#![cfg(target_os = "linux")]

//! Authenticated `managed.v1` plan-ingress tests.
//!
//! Goal creation, SpecVersion propose/accept/reject, Run start and Task add/ready are
//! exercised only through the authenticated host socket boundary. Every mutating call
//! is one-use keyed, records the authenticated principal (never a client-supplied
//! identity) and keeps the state machine's governance rules: a SpecVersion author can
//! never approve their own proposal, and the kernel computes the digest it accepts.

use horizoncode_kernel::host_kernel::{
    EFFECTS_SERVICE_ID, HostKernel, MANAGED_SERVICE_ID, RESOURCE_SERVICE_ID,
};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::owner_log::OwnerIdentity;
use horizoncode_kernel::protocol::{
    AuthenticatedPrincipalV1, FrameFence, KernelHelloV1, KernelStartupStatusV1, RpcMessageV1,
    RpcOutcomeV1, RpcRequestV1, RpcResponseV1, read_message, write_message,
};
use horizoncode_kernel::unix_peer::{
    AuthenticatedUnixStream, UnixPeerPolicy, connect_authenticated,
};
use std::fs::{self, File};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const AUTHOR: &str = "host_os_uid:1000";
const REVIEWER: &str = "server_auth:reviewer";
const EPOCH: u64 = 31;
const INCARNATION: &str = "inc_plan_ingress";
const GOAL: &str = "goal-ingress";
const SPEC: &str = "spec-ingress";
const RUN: &str = "run-ingress";
const TASK: &str = "task-ingress";

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

fn b3(seed: char) -> String {
    format!("blake3:{}", seed.to_string().repeat(64))
}

fn session_link_digest(parts: [&str; 15]) -> String {
    let mut preimage = b"horizoncode.session-link.source.v1\0".to_vec();
    for part in parts {
        preimage.extend_from_slice(&(part.len() as u64).to_be_bytes());
        preimage.extend_from_slice(part.as_bytes());
    }
    let digest = ring::digest::digest(&ring::digest::SHA256, &preimage);
    let hex = digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hex}")
}

fn json_to_value(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Nil,
        serde_json::Value::Bool(value) => Value::Bool(*value),
        serde_json::Value::Number(value) if value.is_u64() => {
            Value::Unsigned(value.as_u64().unwrap())
        }
        serde_json::Value::Number(value) if value.is_i64() => {
            Value::Signed(value.as_i64().unwrap())
        }
        serde_json::Value::Number(value) => Value::Float(value.as_f64().unwrap().to_bits()),
        serde_json::Value::String(value) => Value::String(value.clone()),
        serde_json::Value::Array(values) => {
            Value::Array(values.iter().map(json_to_value).collect())
        }
        serde_json::Value::Object(values) => Value::Map(
            values
                .iter()
                .map(|(key, value)| (key.clone(), json_to_value(value)))
                .collect(),
        ),
    }
}

fn profile_selection() -> Value {
    map([
        ("profileId", string("specialist.reader")),
        ("revision", string("1")),
    ])
}

fn profile_definition() -> Value {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/agent-profile-definition-v2.json")).unwrap();
    json_to_value(&fixture["definition"])
}

fn planned_profile_definition() -> Value {
    let mut definition = profile_definition();
    let Value::Map(fields) = &mut definition else {
        panic!("profile definition must be a map");
    };
    let Some(Value::Map(limits)) = fields.get_mut("limits") else {
        panic!("profile limits must be a map");
    };
    limits.insert("tokenBudget".to_owned(), string("4096"));
    definition
}

struct Fixture {
    state: PathBuf,
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
            "hz-plan-ingress-{}-{tick}-{}",
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
        let request = RpcRequestV1 {
            owner_epoch: EPOCH,
            process_incarnation: INCARNATION.to_owned(),
            request_id: "req-register-ingress-location".to_owned(),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: "register_location".to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: "trace-ingress-location".to_owned(),
            body: map([
                ("canonicalRoot", string(workspace.to_str().unwrap())),
                ("workspaceID", string("workspace-one")),
            ]),
        };
        let fence = FrameFence::new(EPOCH, INCARNATION).unwrap();
        let response = host.handle_request(&request, "server_auth:plan-ingress-owner", &fence);
        let registered = ok_body(response);
        // Registration itself is part of the in-process fixture setup; tests that
        // start a Run re-register on their own authenticated socket connection.
        let _location_id = field_text(&registered, "locationID");
        Self {
            state,
            host: Some(host),
            fence: FrameFence::new(EPOCH, INCARNATION).unwrap(),
            sequence: 0,
        }
    }

    fn send(&mut self, operation: &str, body: Value, delivery: Option<&str>) -> RpcResponseV1 {
        if operation == "add_task" {
            self.send_as(
                "server_auth:plan-ingress-task-owner",
                operation,
                body,
                delivery,
            )
        } else {
            self.send_as(AUTHOR, operation, body, delivery)
        }
    }

    fn send_as(
        &mut self,
        principal: &str,
        operation: &str,
        body: Value,
        delivery: Option<&str>,
    ) -> RpcResponseV1 {
        self.sequence += 1;
        let request = RpcRequestV1 {
            owner_epoch: EPOCH,
            process_incarnation: INCARNATION.to_owned(),
            request_id: format!("req-ingress-{}", self.sequence),
            service_id: MANAGED_SERVICE_ID.to_owned(),
            operation: operation.to_owned(),
            delivery_id: delivery.map(str::to_owned),
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: "trace-ingress".to_owned(),
            body,
        };
        let fence = self.fence.clone();
        self.host
            .as_mut()
            .unwrap()
            .handle_request(&request, principal, &fence)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(root) = self.state.parent() {
            let _ = fs::remove_dir_all(root);
        }
    }
}

struct KernelProcess(Child);

struct SocketTestDir(PathBuf);

impl SocketTestDir {
    fn new() -> Self {
        // Keep the private Unix socket path below Linux's SUN_LEN limit even
        // when the repository-local TMPDIR itself is nested under a long path.
        let path = std::env::temp_dir().join(format!(
            "mci-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}

impl Drop for SocketTestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl KernelProcess {
    fn stop(mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for KernelProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start_kernel_process(
    state: &Path,
    socket_name: &str,
    nonce: &str,
    incarnation: &str,
) -> (KernelProcess, AuthenticatedUnixStream, u64) {
    start_kernel_process_with_features(
        state,
        socket_name,
        nonce,
        incarnation,
        vec!["effects.v2".to_owned()],
    )
}

/// Starts `hz-kernel` with an explicit optional-feature set so a test can prove
/// what a *negotiated* feature actually authorizes (and what it does not).
fn start_kernel_process_with_features(
    state: &Path,
    socket_name: &str,
    nonce: &str,
    incarnation: &str,
    optional_features: Vec<String>,
) -> (KernelProcess, AuthenticatedUnixStream, u64) {
    let socket = state.join(socket_name);
    let stderr_path = state.join(format!("{socket_name}.stderr"));
    let core_exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let kernel_exe = fs::canonicalize(env!("CARGO_BIN_EXE_hz-kernel")).unwrap();
    let stderr = File::create(&stderr_path).expect("create repo-local hz-kernel stderr capture");
    let mut child = KernelProcess(
        Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
            .arg(format!("--state-dir={}", state.display()))
            .arg(format!("--socket={}", socket.display()))
            .arg(format!("--host-exe={}", core_exe.display()))
            .arg(format!("--nonce={nonce}"))
            .arg(format!("--incarnation={incarnation}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr))
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(metadata) = fs::metadata(&socket)
            && metadata.file_type().is_socket()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o777 == 0o600
        {
            break;
        }
        if let Some(status) = child.0.try_wait().unwrap() {
            let stderr = fs::read_to_string(&stderr_path).unwrap_or_else(|error| {
                format!("<could not read {}: {error}>", stderr_path.display())
            });
            panic!("hz-kernel exited before private socket bind ({status}); stderr: {stderr}");
        }
        if Instant::now() >= deadline {
            let stderr = fs::read_to_string(&stderr_path).unwrap_or_else(|error| {
                format!("<could not read {}: {error}>", stderr_path.display())
            });
            panic!(
                "hz-kernel did not create a private owner-only socket before timeout; stderr: {stderr}"
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
    let mut stream = connect_authenticated(
        &socket,
        UnixPeerPolicy {
            uid: unsafe { libc::geteuid() },
            executable: kernel_exe,
        },
    )
    .unwrap();
    write_message(
        &mut stream,
        &RpcMessageV1::Hello(Box::new(KernelHelloV1 {
            min_protocol: 1,
            max_protocol: 1,
            host_build_digest: format!("blake3:{}", "a".repeat(64)),
            kernel_build_digest: None,
            host_instance_id: format!("host_{nonce}"),
            process_incarnation: incarnation.to_owned(),
            supervisor_nonce: nonce.to_owned(),
            required_features: Vec::new(),
            optional_features,
        })),
    )
    .unwrap();
    let Some(RpcMessageV1::HelloResult(negotiated)) = read_message(&mut stream).unwrap() else {
        panic!("expected fenced host hello result");
    };
    let mut ready = false;
    for _ in 0..16 {
        match read_message(&mut stream).unwrap().unwrap() {
            RpcMessageV1::StartupStatus(status) if *status == KernelStartupStatusV1::Ready => {
                ready = true;
                break;
            }
            RpcMessageV1::StartupStatus(status) if *status == KernelStartupStatusV1::Starting => {}
            other => panic!("unexpected startup frame before READY: {other:?}"),
        }
    }
    assert!(ready, "hz-kernel did not reach READY");
    (child, stream, negotiated.owner_epoch)
}

fn socket_roundtrip(stream: &mut AuthenticatedUnixStream, request: RpcRequestV1) -> RpcResponseV1 {
    socket_roundtrip_as(stream, request, None)
}

fn socket_roundtrip_as(
    stream: &mut AuthenticatedUnixStream,
    request: RpcRequestV1,
    server_auth_subject: Option<&str>,
) -> RpcResponseV1 {
    let message = match server_auth_subject {
        Some(subject) => RpcMessageV1::AuthenticatedRequest {
            request: Box::new(request),
            principal: AuthenticatedPrincipalV1::ServerAuth {
                subject: subject.to_owned(),
            },
            context: None,
        },
        None => RpcMessageV1::Request(Box::new(request)),
    };
    write_message(stream, &message).unwrap();
    let Some(RpcMessageV1::Response(response)) = read_message(stream).unwrap() else {
        panic!("expected managed RPC response over the authenticated socket");
    };
    *response
}

fn managed_socket_request(
    owner_epoch: u64,
    incarnation: &str,
    request_id: &str,
    operation: &str,
    body: Value,
    delivery: Option<&str>,
) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch,
        process_incarnation: incarnation.to_owned(),
        request_id: request_id.to_owned(),
        service_id: MANAGED_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: delivery.map(str::to_owned),
        expected_cursor: None,
        deadline_unix_ms: now_ms() + 30_000,
        trace_id: format!("trace-{request_id}"),
        body,
    }
}

fn plan_run_body(
    goal_id: &str,
    spec_id: &str,
    run_id: &str,
    session_id: &str,
    spec_digest: &str,
    expected_goal_revision: u64,
    tasks: Vec<Value>,
    request_prefix: &str,
) -> Value {
    map([
        ("goalID", string(goal_id)),
        ("runID", string(run_id)),
        ("specID", string(spec_id)),
        ("specDigest", string(spec_digest)),
        (
            "expectedGoalRevision",
            string(&expected_goal_revision.to_string()),
        ),
        ("idempotencyKey", string(&format!("{request_prefix}-plan"))),
        ("sessionID", string(session_id)),
        ("tasks", Value::Array(tasks)),
    ])
}

fn plan_run_response(
    stream: &mut AuthenticatedUnixStream,
    owner_epoch: u64,
    incarnation: &str,
    goal_id: &str,
    spec_id: &str,
    run_id: &str,
    session_id: &str,
    spec_digest: &str,
    expected_goal_revision: u64,
    tasks: Vec<Value>,
    request_prefix: &str,
) -> RpcResponseV1 {
    socket_roundtrip_as(
        stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            &format!("req-{request_prefix}-plan"),
            "plan_run",
            plan_run_body(
                goal_id,
                spec_id,
                run_id,
                session_id,
                spec_digest,
                expected_goal_revision,
                tasks,
                request_prefix,
            ),
            Some(&format!("{request_prefix}-plan")),
        ),
        Some("reviewer"),
    )
}

fn plan_run_on_socket(
    stream: &mut AuthenticatedUnixStream,
    owner_epoch: u64,
    incarnation: &str,
    goal_id: &str,
    spec_id: &str,
    run_id: &str,
    session_id: &str,
    spec_digest: &str,
    expected_goal_revision: u64,
    tasks: Vec<Value>,
    request_prefix: &str,
) -> Value {
    let planned = ok_body(plan_run_response(
        stream,
        owner_epoch,
        incarnation,
        goal_id,
        spec_id,
        run_id,
        session_id,
        spec_digest,
        expected_goal_revision,
        tasks,
        request_prefix,
    ));
    assert_eq!(field_text(&planned, "runPhase"), "PLAN_ONLY");
    planned
}

/// One immutable planned Task: the accepted-plan ingress requires the complete
/// delivery text, an exact criterion partition and the pinned AgentProfile
/// (including its positive tokenBudget) before any OwnerLog mutation.
fn planned_task(
    task_id: &str,
    title: &str,
    dependencies: &[&str],
    criterion_ids: &[&str],
    required_capabilities: &[&str],
) -> Value {
    map([
        ("taskID", string(task_id)),
        ("title", string(title)),
        ("purpose", string(&format!("{title} purpose"))),
        ("dependencies", strings(dependencies)),
        ("criterionIDs", strings(criterion_ids)),
        ("requiredCapabilities", strings(required_capabilities)),
        ("profileSelection", profile_selection()),
        ("profileDefinition", planned_profile_definition()),
    ])
}

fn numbered_criteria(count: usize) -> Value {
    Value::Array(
        (0..count)
            .map(|index| {
                map([
                    ("id", string(&format!("criterion-{index}"))),
                    (
                        "description",
                        string(&format!("Accepted criterion {index}")),
                    ),
                ])
            })
            .collect(),
    )
}

/// Creates the Goal and initial SpecVersion atomically over the authenticated
/// socket and records an independent reviewer assignment, returning the
/// kernel-computed Spec digest. Acceptance (or rejection) stays a separate
/// reviewer decision.
fn propose_and_assign_reviewer_on_socket(
    stream: &mut AuthenticatedUnixStream,
    owner_epoch: u64,
    incarnation: &str,
    goal_id: &str,
    spec_id: &str,
    proposal: Value,
    request_prefix: &str,
) -> String {
    let proposed = ok_body(socket_roundtrip(
        stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            &format!("req-{request_prefix}-proposal"),
            "create_goal_proposal",
            proposal,
            Some(&format!("{request_prefix}-goal-spec")),
        ),
    ));
    let digest = proposed_spec_digest(&proposed);
    let assigned = socket_roundtrip_as(
        stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            &format!("req-{request_prefix}-assign"),
            "assign_spec_reviewer",
            map([
                ("goalID", string(goal_id)),
                ("specID", string(spec_id)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some(&format!("{request_prefix}-assign-reviewer")),
        ),
        Some("reviewer"),
    );
    assert_eq!(
        assigned.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        assigned.error
    );
    digest
}

fn accept_spec_on_socket(
    stream: &mut AuthenticatedUnixStream,
    owner_epoch: u64,
    incarnation: &str,
    goal_id: &str,
    spec_id: &str,
    spec_digest: &str,
    request_prefix: &str,
) {
    let accepted = socket_roundtrip_as(
        stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            &format!("req-{request_prefix}-accept"),
            "accept_spec",
            map([
                ("goalID", string(goal_id)),
                ("specID", string(spec_id)),
                ("specDigest", string(spec_digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some(&format!("{request_prefix}-accept")),
        ),
        Some("reviewer"),
    );
    assert_eq!(
        accepted.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        accepted.error
    );
}

/// The exact Core SessionLink projection the accepted-plan start must pin: its
/// source digest is recomputed by the kernel, so the fixture only supplies the
/// immutable projection fields for this Goal and Session.
fn session_link_body(goal_id: &str, session_id: &str) -> Value {
    let source_store_id = "store_plan_ingress";
    let source_instance_id = "instance_plan_ingress";
    let event_digest = format!("blake3:{}", "b".repeat(64));
    map([
        ("sessionID", string(session_id)),
        ("sourceStoreID", string(source_store_id)),
        ("sourceInstanceID", string(source_instance_id)),
        (
            "sourceCursor",
            map([
                ("ownerKind", string("session")),
                ("ownerId", string(session_id)),
                ("seq", string("1")),
                ("eventDigest", string(&event_digest)),
            ]),
        ),
        ("sourceEpoch", string("1")),
        ("latestObservedMessageID", Value::Nil),
        ("latestObservedPartID", Value::Nil),
        (
            "sourceDigest",
            string(&session_link_digest([
                session_id,
                source_store_id,
                source_instance_id,
                "session",
                session_id,
                "1",
                &event_digest,
                "1",
                "",
                "",
                "horizon.session-link.ids-only.v1",
                "1",
                goal_id,
                "project-one",
                "workspace-one",
            ])),
        ),
        (
            "redactionProfile",
            string("horizon.session-link.ids-only.v1"),
        ),
        ("protocolVersion", Value::Unsigned(1)),
        ("goalID", string(goal_id)),
        ("projectID", string("project-one")),
        ("workspaceID", string("workspace-one")),
    ])
}

fn start_planned_run_body(
    goal_id: &str,
    spec_id: &str,
    run_id: &str,
    spec_digest: &str,
    expected_goal_revision: u64,
    session_id: &str,
    request_prefix: &str,
) -> Value {
    map([
        ("goalID", string(goal_id)),
        ("runID", string(run_id)),
        ("specID", string(spec_id)),
        ("specDigest", string(spec_digest)),
        (
            "expectedGoalRevision",
            string(&expected_goal_revision.to_string()),
        ),
        ("sessionID", string(session_id)),
        ("idempotencyKey", string(&format!("{request_prefix}-start"))),
        ("sessionLink", session_link_body(goal_id, session_id)),
    ])
}

fn register_location_on_socket(
    stream: &mut AuthenticatedUnixStream,
    owner_epoch: u64,
    incarnation: &str,
    state: &Path,
    request_prefix: &str,
) -> String {
    let workspace = state.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let registered = socket_roundtrip_as(
        stream,
        RpcRequestV1 {
            owner_epoch,
            process_incarnation: incarnation.to_owned(),
            request_id: format!("req-{request_prefix}-register-location"),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: "register_location".to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: format!("trace-{request_prefix}-register-location"),
            body: map([
                ("canonicalRoot", string(workspace.to_str().unwrap())),
                ("workspaceID", string("workspace-one")),
            ]),
        },
        Some("reviewer"),
    );
    assert_eq!(
        registered.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        registered.error
    );
    field_text(registered.body.as_ref().unwrap(), "locationID").to_owned()
}

fn plan_and_start_one_task(
    stream: &mut AuthenticatedUnixStream,
    owner_epoch: u64,
    incarnation: &str,
    goal_id: &str,
    spec_id: &str,
    run_id: &str,
    session_id: &str,
    spec_digest: &str,
    task: Value,
    request_prefix: &str,
) -> (Value, Value) {
    let planned = plan_run_on_socket(
        stream,
        owner_epoch,
        incarnation,
        goal_id,
        spec_id,
        run_id,
        session_id,
        spec_digest,
        3,
        vec![task],
        request_prefix,
    );
    let started = ok_body(socket_roundtrip_as(
        stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            &format!("req-{request_prefix}-start"),
            "start_planned_run",
            start_planned_run_body(
                goal_id,
                spec_id,
                run_id,
                spec_digest,
                field_decimal_u64(&planned, "revision"),
                session_id,
                request_prefix,
            ),
            Some(&format!("{request_prefix}-start")),
        ),
        Some("reviewer"),
    ));
    (planned, started)
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

fn strings(values: &[&str]) -> Value {
    Value::Array(values.iter().map(|value| string(value)).collect())
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    match value {
        Value::Map(fields) => fields
            .get(key)
            .unwrap_or_else(|| panic!("field {key} is missing")),
        other => panic!("expected a map, found {other:?}"),
    }
}

fn field_array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match field(value, key) {
        Value::Array(items) => items,
        other => panic!("field {key} is not an array: {other:?}"),
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
        Value::Unsigned(number) => *number,
        Value::String(text) => text
            .parse::<u64>()
            .unwrap_or_else(|_| panic!("field {key} is not a canonical u64: {text}")),
        other => panic!("field {key} is not a u64: {other:?}"),
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
    assert!(response.body.is_none());
    response
        .error
        .as_ref()
        .expect("error response must carry an error")
        .code
        .as_str()
}

fn criteria() -> Value {
    Value::Array(vec![
        map([
            ("id", string("tests-pass")),
            ("description", string("The focused tests pass")),
        ]),
        map([
            ("id", string("docs-match")),
            ("description", string("Documentation matches the change")),
        ]),
    ])
}

fn budget(max_tasks: u64) -> Value {
    map([
        ("maxTasks", Value::Unsigned(max_tasks)),
        ("maxAttemptsPerTask", Value::Unsigned(2)),
        ("maxRunDurationMs", Value::Unsigned(60_000)),
        ("maxMemoryBytes", Value::Unsigned(1_073_741_824)),
        ("maxDiskBytes", Value::Unsigned(2_147_483_648)),
        ("maxWorkers", Value::Unsigned(1)),
        ("maxTokens", Value::Unsigned(20_000)),
        ("maxCostMicros", Value::Unsigned(0)),
    ])
}

fn goal_proposal_body(goal_id: &str, spec_id: &str) -> Value {
    map([
        ("goalID", string(goal_id)),
        ("specID", string(spec_id)),
        ("objective", string("Complete the managed ingress work")),
        ("projectRef", string("project-one")),
        ("workspaceRef", string("workspace-one")),
        ("capabilityScope", Value::Array(vec![])),
        ("scope", strings(&["kernel/src/**"])),
        ("constraints", strings(&["Preserve user-owned changes"])),
        ("criteria", criteria()),
        ("budget", budget(8)),
        ("sourceDigests", Value::Array(vec![string(&sha('a'))])),
    ])
}

fn owner_directory(state: &Path, kind: &str, id: &str) -> PathBuf {
    let key = OwnerIdentity::new(kind.to_owned(), id.to_owned())
        .unwrap()
        .directory_key();
    state.join("managed-control").join("owners").join(key)
}

fn only_run(snapshot: &Value) -> Value {
    let Value::Array(runs) = field(snapshot, "runs") else {
        panic!("runs must be an array");
    };
    assert_eq!(runs.len(), 1);
    runs[0].clone()
}

fn proposed_spec_digest(proposed: &Value) -> String {
    field_text(proposed, "specDigest").to_owned()
}

fn assign_reviewer(fixture: &mut Fixture, digest: &str, expected_revision: u64) -> Value {
    ok_body(fixture.send_as(
        REVIEWER,
        "assign_spec_reviewer",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("specDigest", string(digest)),
            ("expectedRevision", Value::Unsigned(expected_revision)),
        ]),
        Some("assign-reviewer-1"),
    ))
}

#[test]
fn plan_ingress_persists_capability_scope_and_denies_unproven_attempt_admission() {
    let directory = SocketTestDir::new();
    let state = directory.0.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    let incarnation = "inc_plan_scope";
    let (_child, mut stream, owner_epoch) =
        start_kernel_process(&state, "plan-scope.sock", "plan-scope-nonce", incarnation);
    let proposed = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-proposal",
            "create_goal_proposal",
            goal_proposal_body(GOAL, SPEC),
            Some("goal-spec-1"),
        ),
    ));
    assert_eq!(field_text(&proposed, "status"), "PROPOSED");
    assert_eq!(field_text(&proposed, "goalID"), GOAL);
    assert_eq!(field_text(&proposed, "specID"), SPEC);
    // Creator and proposer come from the authenticated connection, never request data.
    assert_eq!(field_text(&proposed, "createdBy"), AUTHOR);
    assert_eq!(field_text(&proposed, "proposedBy"), AUTHOR);
    let digest = proposed_spec_digest(&proposed);
    assert!(digest.starts_with("blake3:"), "kernel computes the digest");
    assert_eq!(field_unsigned(&proposed, "revision"), 1);
    let assigned = socket_roundtrip_as(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-assign-reviewer",
            "assign_spec_reviewer",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("assign-scope-reviewer"),
        ),
        Some("reviewer"),
    );
    assert_eq!(assigned.outcome, RpcOutcomeV1::Ok, "{:?}", assigned.error);
    let assigned = assigned.body.unwrap();
    assert_eq!(field_text(&assigned, "reviewerID"), REVIEWER);
    assert_eq!(field_unsigned(&assigned, "decisionRevision"), 2);

    // A host OS identity is not a valid independent reviewer, even when it is
    // the principal that proposed the SpecVersion.
    let self_accept = socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-self-accept",
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("accept-self"),
        ),
    );
    assert_eq!(error_code(&self_accept), "independent_verifier_required");

    let accepted = ok_body(socket_roundtrip_as(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-accept",
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("accept-1"),
        ),
        Some("reviewer"),
    ));
    assert_eq!(field_text(&accepted, "status"), "ACCEPTED");
    assert_eq!(field_text(&accepted, "acceptedBy"), REVIEWER);
    assert_eq!(field_text(&accepted, "activeSpecVersionID"), SPEC);
    assert_eq!(field_unsigned(&accepted, "reviewedRevision"), 2);
    assert!(field_unsigned(&accepted, "acceptedAtMs") > 0);
    assert_eq!(field_unsigned(&accepted, "revision"), 3);

    let workspace = state.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let registered = socket_roundtrip_as(
        &mut stream,
        RpcRequestV1 {
            owner_epoch,
            process_incarnation: incarnation.to_owned(),
            request_id: "req-scope-register-location".to_owned(),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: "register_location".to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: "trace-scope-register-location".to_owned(),
            body: map([
                ("canonicalRoot", string(workspace.to_str().unwrap())),
                ("workspaceID", string("workspace-one")),
            ]),
        },
        Some("reviewer"),
    );
    assert_eq!(
        registered.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        registered.error
    );
    let location_id = field_text(registered.body.as_ref().unwrap(), "locationID").to_owned();
    let (planned, started) = plan_and_start_one_task(
        &mut stream,
        owner_epoch,
        incarnation,
        GOAL,
        SPEC,
        RUN,
        "ses_ingress_scope",
        &digest,
        map([
            ("taskID", string(TASK)),
            ("title", string("Persist capability scope")),
            ("purpose", string("Exercise accepted plan persistence")),
            ("dependencies", Value::Array(vec![])),
            ("criterionIDs", strings(&["tests-pass", "docs-match"])),
            ("requiredCapabilities", Value::Array(vec![])),
            ("profileSelection", profile_selection()),
            ("profileDefinition", planned_profile_definition()),
        ]),
        "scope",
    );
    assert_eq!(field_text(&started, "status"), "RUNNING");
    assert_eq!(field_text(&started, "runPhase"), "RUNNING");

    // This legacy denial expectation is intentionally preserved. The current
    // admission route requires the P1/P8-owned immutable pre-admission proof
    // fields before it can reach the missing-adapter capability denial; do not
    // synthesize those facts to force this assertion to pass.
    let admission = socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-admit",
            "admit",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("attemptID", string("attempt-ingress")),
                (
                    "expectedRevision",
                    Value::Unsigned(field_decimal_u64(&started, "revision")),
                ),
                ("locationID", string(&location_id)),
                ("sessionID", string("ses_ingress_scope")),
            ]),
            Some("scope-admit"),
        ),
    );
    assert_eq!(
        error_code(&admission),
        "capability_unavailable",
        "unexpected admission error: {:?}",
        admission.error
    );

    let snapshot = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-snapshot",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    assert_eq!(
        field_unsigned(&snapshot, "revision"),
        field_decimal_u64(&started, "revision")
    );
    let planned_task_pin = field_array(&planned, "taskPins")
        .first()
        .expect("immutable planned Task profile pin");
    let planned_profile_ref = map([
        (
            "profileId",
            string(field_text(planned_task_pin, "profileID")),
        ),
        (
            "revision",
            string(field_text(planned_task_pin, "profileRevision")),
        ),
        (
            "definitionDigest",
            string(field_text(planned_task_pin, "profileDigest")),
        ),
    ]);
    let spec = field_array(&snapshot, "specs")
        .first()
        .expect("persisted Spec");
    assert!(field_array(spec, "capabilityScope").is_empty());
    let run = only_run(&snapshot);
    assert_eq!(field_text(&run, "phase"), "RUNNING");
    let task = field_array(&run, "tasks").first().expect("persisted Task");
    assert!(field_array(task, "requiredCapabilities").is_empty());
    assert_eq!(field(task, "agentProfileRevision"), &planned_profile_ref);
    assert!(field_array(&snapshot, "attempts").is_empty());
    assert_eq!(
        field_text(field(&snapshot, "goal"), "activeSpecVersionID"),
        SPEC
    );
    assert_eq!(
        field_decimal_u64(&planned, "revision") + 1,
        field_decimal_u64(&started, "revision")
    );
}

#[test]
fn capability_scope_and_task_requirements_round_trip_from_owner_state() {
    let directory = SocketTestDir::new();
    let state_dir = directory.0.join("state");
    fs::create_dir(&state_dir).unwrap();
    fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state_dir).unwrap();
    let incarnation = "inc_scope_roundtrip";
    let (_child, mut stream, owner_epoch) = start_kernel_process(
        &state,
        "scope-roundtrip.sock",
        "scope-roundtrip-nonce",
        incarnation,
    );
    let mut proposal = goal_proposal_body(GOAL, SPEC);
    if let Value::Map(fields) = &mut proposal {
        fields.insert("capabilityScope".to_owned(), strings(&["files.read"]));
    }
    let proposed = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-roundtrip-proposal",
            "create_goal_proposal",
            proposal,
            Some("goal-spec-capability"),
        ),
    ));
    let digest = proposed_spec_digest(&proposed);
    let reviewer = socket_roundtrip_as(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-roundtrip-assign",
            "assign_spec_reviewer",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("assign-scope-roundtrip-reviewer"),
        ),
        Some("reviewer"),
    );
    assert_eq!(reviewer.outcome, RpcOutcomeV1::Ok, "{:?}", reviewer.error);
    ok_body(socket_roundtrip_as(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-roundtrip-accept",
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("accept-capability-spec"),
        ),
        Some("reviewer"),
    ));
    let workspace = state.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let registered = socket_roundtrip_as(
        &mut stream,
        RpcRequestV1 {
            owner_epoch,
            process_incarnation: incarnation.to_owned(),
            request_id: "req-scope-roundtrip-location".to_owned(),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: "register_location".to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: "trace-scope-roundtrip-location".to_owned(),
            body: map([
                ("canonicalRoot", string(workspace.to_str().unwrap())),
                ("workspaceID", string("workspace-one")),
            ]),
        },
        Some("reviewer"),
    );
    assert_eq!(registered.outcome, RpcOutcomeV1::Ok, "{:?}", registered.error);
    let (_planned, _started) = plan_and_start_one_task(
        &mut stream,
        owner_epoch,
        incarnation,
        GOAL,
        SPEC,
        RUN,
        "ses_ingress_scope_roundtrip",
        &digest,
        map([
            ("taskID", string(TASK)),
            ("title", string("Round-trip Task capability scope")),
            ("purpose", string("Preserve accepted Task capability scope")),
            ("dependencies", Value::Array(vec![])),
            ("criterionIDs", strings(&["tests-pass", "docs-match"])),
            ("requiredCapabilities", strings(&["files.read"])),
            ("profileSelection", profile_selection()),
            ("profileDefinition", planned_profile_definition()),
        ]),
        "scope-roundtrip",
    );
    let snapshot = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-scope-roundtrip-snapshot",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    let spec = field_array(&snapshot, "specs")
        .first()
        .expect("persisted Spec");
    assert_eq!(
        field_array(spec, "capabilityScope"),
        &[string("files.read")]
    );
    let run = only_run(&snapshot);
    let task = field_array(&run, "tasks").first().expect("persisted Task");
    assert_eq!(
        field_array(task, "requiredCapabilities"),
        &[string("files.read")]
    );
}

#[test]
fn task_profile_selection_and_definition_are_validated_before_owner_mutation() {
    let directory = SocketTestDir::new();
    let state_dir = directory.0.join("state");
    fs::create_dir(&state_dir).unwrap();
    fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state_dir).unwrap();
    let incarnation = "inc_profile_pin";
    let (_child, mut stream, owner_epoch) = start_kernel_process(
        &state,
        "profile-pin.sock",
        "profile-pin-nonce",
        incarnation,
    );
    let goal_id = "goal-profile-pin-forged";
    let session_id = "ses_ingress_profile_pin";
    let plan_task = |task: Value| {
        plan_run_body(
            goal_id,
            SPEC,
            RUN,
            session_id,
            &b3('a'),
            1,
            vec![task],
            "profile",
        )
    };

    // The managed plan carries no out-of-body ServerAuth subject on this
    // connection, so the authenticated profile owner is unavailable before any
    // profile field or OwnerLog is touched.
    let unauthenticated = socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-profile-unauthenticated",
            "plan_run",
            plan_task(planned_task(
                "task-profile-pin",
                "Persist profile pin",
                &[],
                &["tests-pass"],
                &[],
            )),
            Some("profile-plan"),
        ),
    );
    assert_eq!(
        error_code(&unauthenticated),
        "missing_principal",
        "Task profile selection requires the out-of-body authenticated subject"
    );

    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            goal_id,
            SPEC,
            RUN,
            session_id,
            &b3('a'),
            1,
            vec![planned_task(
                "task-profile-pin",
                "Persist profile pin",
                &[],
                &["tests-pass"],
                &[],
            )],
            "valid-profile-pin",
        )),
        "managed_not_found",
        "a valid profile selection proceeds to the owner lookup without creating it"
    );
    assert!(
        !owner_directory(&state, "managed_goal", goal_id).exists(),
        "a valid Task pin must not allocate a nonexistent Goal"
    );

    let mut missing_selection = planned_task(
        "task-profile-pin",
        "Persist profile pin",
        &[],
        &["tests-pass"],
        &[],
    );
    if let Value::Map(fields) = &mut missing_selection {
        fields.remove("profileSelection");
    }
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            goal_id,
            SPEC,
            RUN,
            session_id,
            &b3('a'),
            1,
            vec![missing_selection],
            "missing-profile-selection",
        )),
        "invalid_effect_request"
    );

    let mut malformed_revision = planned_task(
        "task-profile-pin",
        "Persist profile pin",
        &[],
        &["tests-pass"],
        &[],
    );
    if let Value::Map(fields) = &mut malformed_revision {
        fields.insert(
            "profileSelection".to_owned(),
            map([
                ("profileId", string("specialist.reader")),
                ("revision", string("01")),
            ]),
        );
    }
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            goal_id,
            SPEC,
            RUN,
            session_id,
            &b3('a'),
            1,
            vec![malformed_revision],
            "noncanonical-profile-revision",
        )),
        "invalid_effect_request"
    );

    let mut mismatched_profile = planned_task(
        "task-profile-pin",
        "Persist profile pin",
        &[],
        &["tests-pass"],
        &[],
    );
    if let Value::Map(fields) = &mut mismatched_profile {
        fields.insert(
            "profileSelection".to_owned(),
            map([
                ("profileId", string("specialist.reader")),
                ("revision", string("2")),
            ]),
        );
    }
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            goal_id,
            SPEC,
            RUN,
            session_id,
            &b3('a'),
            1,
            vec![mismatched_profile],
            "profile-revision-mismatch",
        )),
        "invalid_effect_request"
    );

    let mut unsupported_source = planned_task(
        "task-profile-pin",
        "Persist profile pin",
        &[],
        &["tests-pass"],
        &[],
    );
    if let Value::Map(fields) = &mut unsupported_source {
        let Some(Value::Map(profile)) = fields.get_mut("profileDefinition") else {
            panic!("profile definition must be a map");
        };
        profile.insert("source".to_owned(), string("project"));
    }
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            goal_id,
            SPEC,
            RUN,
            session_id,
            &b3('a'),
            1,
            vec![unsupported_source],
            "unsupported-profile-source",
        )),
        "invalid_effect_request",
        "project/plugin profile sources have no authenticated owner adapter"
    );
    assert!(
        !owner_directory(&state, "managed_goal", goal_id).exists(),
        "bad profile references must fail before OwnerLog allocation"
    );
}

#[test]
fn plan_ingress_replays_are_idempotent_and_duplicates_fail_closed() {
    let mut fixture = Fixture::new();
    let proposal = goal_proposal_body(GOAL, SPEC);
    let created = ok_body(fixture.send("create_goal_proposal", proposal.clone(), Some("goal-1")));
    assert_eq!(field_unsigned(&created, "revision"), 1);

    // An exact retry of a lost response is idempotent.
    let replayed = ok_body(fixture.send("create_goal_proposal", proposal.clone(), Some("goal-1")));
    assert_eq!(field_unsigned(&replayed, "revision"), 1);
    assert_eq!(
        proposed_spec_digest(&replayed),
        proposed_spec_digest(&created)
    );

    // A fresh key cannot create a second initial proposal for the same Goal.
    assert_eq!(
        error_code(&fixture.send("create_goal_proposal", proposal, Some("goal-2"))),
        "managed_conflict"
    );
    assert_eq!(
        error_code(&fixture.send(
            "create_goal_proposal",
            goal_proposal_body(GOAL, "spec-different"),
            Some("goal-1"),
        )),
        "managed_conflict"
    );

    let digest = proposed_spec_digest(&created);
    let assigned = assign_reviewer(&mut fixture, &digest, 1);
    assert_eq!(field_unsigned(&assigned, "decisionRevision"), 2);
    let accepted = ok_body(fixture.send_as(
        REVIEWER,
        "accept_spec",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("specDigest", string(&digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("accept-1"),
    ));
    assert_eq!(field_unsigned(&accepted, "revision"), 3);
    // Replaying the acceptance with the same key is idempotent.
    let replayed_accept = ok_body(fixture.send_as(
        REVIEWER,
        "accept_spec",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("specDigest", string(&digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("accept-1"),
    ));
    assert_eq!(field_unsigned(&replayed_accept, "revision"), 3);
    assert_eq!(field_unsigned(&replayed_accept, "reviewedRevision"), 2);
    // The proposal was already accepted: a new key cannot re-accept it.
    assert_eq!(
        error_code(&fixture.send_as(
            REVIEWER,
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(3)),
            ]),
            Some("accept-2"),
        )),
        "managed_conflict"
    );
}

#[test]
fn review_decisions_compare_and_swap_the_reviewed_goal_revision() {
    let mut fixture = Fixture::new();
    let proposed = ok_body(fixture.send(
        "create_goal_proposal",
        goal_proposal_body(GOAL, SPEC),
        Some("goal-spec-1"),
    ));
    let digest = proposed_spec_digest(&proposed);
    assert_eq!(field_unsigned(&proposed, "revision"), 1);
    let assigned = assign_reviewer(&mut fixture, &digest, 1);
    assert_eq!(field_unsigned(&assigned, "decisionRevision"), 2);

    // A reviewer looking at revision 1 cannot approve after assignment advances the
    // Goal to revision 2. The refusal does not consume the delivery key or mutate it.
    let stale = fixture.send_as(
        REVIEWER,
        "accept_spec",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("specDigest", string(&digest)),
            ("expectedRevision", Value::Unsigned(1)),
        ]),
        Some("accept-1"),
    );
    assert_eq!(error_code(&stale), "managed_conflict");
    let unchanged = ok_body(fixture.send("snapshot", map([("goalID", string(GOAL))]), None));
    assert_eq!(field_unsigned(&unchanged, "revision"), 2);

    // The exact reviewed revision succeeds. An exact delivery replay remains
    // idempotent, but reusing that key with another revision is a conflict.
    let decision = map([
        ("goalID", string(GOAL)),
        ("specID", string(SPEC)),
        ("specDigest", string(&digest)),
        ("expectedRevision", Value::Unsigned(2)),
    ]);
    let accepted =
        ok_body(fixture.send_as(REVIEWER, "accept_spec", decision.clone(), Some("accept-1")));
    assert_eq!(field_unsigned(&accepted, "reviewedRevision"), 2);
    assert_eq!(field_unsigned(&accepted, "revision"), 3);

    let replayed = ok_body(fixture.send_as(REVIEWER, "accept_spec", decision, Some("accept-1")));
    assert_eq!(field_unsigned(&replayed, "reviewedRevision"), 2);
    assert_eq!(field_unsigned(&replayed, "revision"), 3);

    assert_eq!(
        error_code(&fixture.send_as(
            REVIEWER,
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("accept-1"),
        )),
        "managed_conflict"
    );
}

#[test]
fn plan_ingress_unknown_goals_and_specs_fail_closed_without_allocation() {
    let directory = SocketTestDir::new();
    let state_dir = directory.0.join("state");
    fs::create_dir(&state_dir).unwrap();
    fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state_dir).unwrap();
    let incarnation = "inc_unknown_goal";
    let (_child, mut stream, owner_epoch) = start_kernel_process(
        &state,
        "unknown-goal.sock",
        "unknown-goal-nonce",
        incarnation,
    );

    // Capability aliases/unknown IDs are rejected before resolving a Goal or
    // allocating its OwnerLog.
    let mut noncanonical_scope = goal_proposal_body("goal-capability-alias", SPEC);
    if let Value::Map(fields) = &mut noncanonical_scope {
        fields.insert("capabilityScope".to_owned(), strings(&["terminal.exec"]));
    }
    assert_eq!(
        error_code(&socket_roundtrip(
            &mut stream,
            managed_socket_request(
                owner_epoch,
                incarnation,
                "req-noncanonical-capability-scope",
                "create_goal_proposal",
                noncanonical_scope,
                Some("noncanonical-capability-scope"),
            ),
        )),
        "invalid_managed_request"
    );
    assert!(
        !owner_directory(&state, "managed_goal", "goal-capability-alias").exists(),
        "unknown capability IDs must fail before OwnerLog allocation"
    );

    // A Goal that was never created is NOT_FOUND for every plan step and allocates
    // no durable owner state.
    let forged_task = planned_task(TASK, "Forged Goal Task", &[], &[], &[]);
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            "goal-forged",
            SPEC,
            RUN,
            "ses_ingress_forged",
            &b3('a'),
            1,
            vec![forged_task.clone()],
            "forged-task",
        )),
        "managed_not_found"
    );
    let mut forged_capability = forged_task;
    if let Value::Map(fields) = &mut forged_capability {
        fields.insert(
            "requiredCapabilities".to_owned(),
            strings(&["files.write.alias"]),
        );
    }
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            "goal-forged",
            SPEC,
            RUN,
            "ses_ingress_forged",
            &b3('a'),
            1,
            vec![forged_capability],
            "forged-capability",
        )),
        "invalid_managed_request"
    );
    assert!(
        !owner_directory(&state, "managed_goal", "goal-forged").exists(),
        "unknown Task capability IDs must fail before Goal owner allocation"
    );
    assert_eq!(
        error_code(&socket_roundtrip_as(
            &mut stream,
            managed_socket_request(
                owner_epoch,
                incarnation,
                "req-forged-run",
                "start_planned_run",
                start_planned_run_body(
                    "goal-forged",
                    SPEC,
                    RUN,
                    &b3('a'),
                    1,
                    "ses_ingress_forged",
                    "forged-run",
                ),
                Some("forged-run-start"),
            ),
            Some("reviewer"),
        )),
        "managed_not_found"
    );
    assert_eq!(
        error_code(&socket_roundtrip_as(
            &mut stream,
            managed_socket_request(
                owner_epoch,
                incarnation,
                "req-forged-spec",
                "accept_spec",
                map([
                    ("goalID", string("goal-forged")),
                    ("specID", string(SPEC)),
                    ("specDigest", string(&sha('a'))),
                    ("expectedRevision", Value::Unsigned(1)),
                ]),
                Some("forged-spec"),
            ),
            Some("reviewer"),
        )),
        "managed_not_found"
    );
    assert!(
        !owner_directory(&state, "managed_goal", "goal-forged").exists(),
        "a forged Goal must not allocate durable owner state"
    );

    // A valid atomic proposal creates the Goal; an unknown SpecVersion is a
    // typed conflict, not a partial write.
    ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-goal-spec-create",
            "create_goal_proposal",
            goal_proposal_body(GOAL, SPEC),
            Some("goal-spec-1"),
        ),
    ));
    assert_eq!(
        error_code(&socket_roundtrip_as(
            &mut stream,
            managed_socket_request(
                owner_epoch,
                incarnation,
                "req-accept-absent",
                "accept_spec",
                map([
                    ("goalID", string(GOAL)),
                    ("specID", string("spec-absent")),
                    ("specDigest", string(&b3('a'))),
                    ("expectedRevision", Value::Unsigned(1)),
                ]),
                Some("accept-absent"),
            ),
            Some("reviewer"),
        )),
        "managed_conflict"
    );
    let snapshot = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-goal-snapshot",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    assert_eq!(field_unsigned(&snapshot, "revision"), 1);
}

#[test]
fn plan_ingress_rejects_malformed_oversized_and_misbound_requests() {
    let mut fixture = Fixture::new();

    // Objective bounds are enforced before the Goal owner log is allocated.
    let mut oversized = goal_proposal_body(GOAL, SPEC);
    if let Value::Map(fields) = &mut oversized {
        fields.insert("objective".to_owned(), string(&"x".repeat(16 * 1024 + 1)));
    }
    assert_eq!(
        error_code(&fixture.send("create_goal_proposal", oversized, Some("goal-long"),)),
        "invalid_effect_request"
    );
    let mut blank = goal_proposal_body(GOAL, SPEC);
    if let Value::Map(fields) = &mut blank {
        fields.insert("objective".to_owned(), string("   "));
    }
    assert_eq!(
        error_code(&fixture.send("create_goal_proposal", blank, Some("goal-blank"),)),
        "invalid_effect_request"
    );
    let mut missing_capability_scope = goal_proposal_body(GOAL, SPEC);
    if let Value::Map(fields) = &mut missing_capability_scope {
        fields.remove("capabilityScope");
    }
    assert_eq!(
        error_code(&fixture.send(
            "create_goal_proposal",
            missing_capability_scope,
            Some("goal-missing-capability-scope"),
        )),
        "invalid_effect_request"
    );
    assert!(
        !owner_directory(&fixture.state, "managed_goal", GOAL).exists(),
        "rejected Goal creation must not allocate durable owner state"
    );

    // Every proposal requires its one-use delivery key.
    assert_eq!(
        error_code(&fixture.send("create_goal_proposal", goal_proposal_body(GOAL, SPEC), None)),
        "invalid_effect_request"
    );
    // A malformed spec is a typed validation error from the state machine.
    let mut duplicate_criteria = goal_proposal_body(GOAL, SPEC);
    if let Value::Map(fields) = &mut duplicate_criteria {
        fields.insert(
            "criteria".to_owned(),
            Value::Array(vec![
                map([
                    ("id", string("tests-pass")),
                    ("description", string("first")),
                ]),
                map([
                    ("id", string("tests-pass")),
                    ("description", string("second")),
                ]),
            ]),
        );
    }
    assert_eq!(
        error_code(&fixture.send("create_goal_proposal", duplicate_criteria, Some("spec-dup"))),
        "invalid_managed_request"
    );
    // A request with an unexpected field fails closed.
    let mut extra = goal_proposal_body(GOAL, SPEC);
    if let Value::Map(fields) = &mut extra {
        fields.insert("extraField".to_owned(), string("rejected"));
    }
    assert_eq!(
        error_code(&fixture.send("create_goal_proposal", extra, Some("spec-extra"))),
        "invalid_effect_request"
    );
    // An over-long delivery id fails closed before the durable identifier bound.
    assert_eq!(
        error_code(&fixture.send(
            "create_goal_proposal",
            goal_proposal_body(GOAL, SPEC),
            Some(&"d".repeat(201))
        )),
        "invalid_effect_request"
    );
    // The writer may allocate an empty owner log while validating, but none of
    // these rejected requests can persist a Goal, SpecVersion, or revision.
    let empty = ok_body(fixture.send("snapshot", map([("goalID", string(GOAL))]), None));
    assert_eq!(field_unsigned(&empty, "revision"), 0);
    assert_eq!(field(&empty, "goal"), &Value::Nil);
    assert!(matches!(field(&empty, "specs"), Value::Array(specs) if specs.is_empty()));
    let retried = ok_body(fixture.send(
        "create_goal_proposal",
        goal_proposal_body(GOAL, SPEC),
        Some("goal-spec-1"),
    ));
    assert_eq!(field_unsigned(&retried, "revision"), 1);
}

#[test]
fn plan_ingress_enforces_task_criteria_dependencies_and_budget() {
    let directory = SocketTestDir::new();
    let state = directory.0.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    let incarnation = "inc_plan_budget";
    let (_child, mut stream, owner_epoch) = start_kernel_process(
        &state,
        "plan-budget.sock",
        "plan-budget-nonce",
        incarnation,
    );
    let session_id = "ses_ingress_budget";

    let digest = propose_and_assign_reviewer_on_socket(
        &mut stream,
        owner_epoch,
        incarnation,
        GOAL,
        SPEC,
        goal_proposal_body(GOAL, SPEC),
        "budget",
    );
    accept_spec_on_socket(
        &mut stream,
        owner_epoch,
        incarnation,
        GOAL,
        SPEC,
        &digest,
        "budget",
    );

    // A Run plan must use the accepted active SpecVersion.
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            GOAL,
            "spec-other",
            RUN,
            session_id,
            &b3('a'),
            3,
            vec![planned_task(
                TASK,
                "Accepted plan Task",
                &[],
                &["tests-pass"],
                &[],
            )],
            "run-other",
        )),
        "managed_conflict"
    );

    // Every Task of an accepted plan is validated as one complete immutable
    // unit; the delivery text and requiredCapabilities are mandatory fields.
    let mut missing_task_capabilities = planned_task(
        TASK,
        "Accepted plan Task",
        &[],
        &["tests-pass"],
        &[],
    );
    if let Value::Map(fields) = &mut missing_task_capabilities {
        fields.remove("requiredCapabilities");
    }
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            GOAL,
            SPEC,
            RUN,
            session_id,
            &digest,
            3,
            vec![missing_task_capabilities],
            "task-missing-capabilities",
        )),
        "invalid_effect_request"
    );

    // A criterion outside the accepted SpecVersion is refused.
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            GOAL,
            SPEC,
            RUN,
            session_id,
            &digest,
            3,
            vec![planned_task(
                "task-bad-criterion",
                "Bad criterion Task",
                &[],
                &["invented-criterion"],
                &[],
            )],
            "task-bad-criterion",
        )),
        "managed_conflict"
    );
    // A dependency on a Task that is not part of this plan is refused.
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            GOAL,
            SPEC,
            RUN,
            session_id,
            &digest,
            3,
            vec![planned_task(
                "task-bad-dependency",
                "Bad dependency Task",
                &["task-absent"],
                &["tests-pass"],
                &[],
            )],
            "task-bad-dependency",
        )),
        "managed_conflict"
    );

    // The accepted plan pins both Tasks together with their disjoint criterion
    // partition over the accepted SpecVersion.
    let planned = plan_run_on_socket(
        &mut stream,
        owner_epoch,
        incarnation,
        GOAL,
        SPEC,
        RUN,
        session_id,
        &digest,
        3,
        vec![
            planned_task(TASK, "Accepted plan Task", &[], &["tests-pass"], &[]),
            planned_task(
                "task-dependent",
                "Dependent Task",
                &[TASK],
                &["docs-match"],
                &[],
            ),
        ],
        "task-1",
    );
    // Re-submitting an already planned Run (and therefore its Task identities)
    // is refused even for a fresh one-use key.
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            GOAL,
            SPEC,
            RUN,
            session_id,
            &digest,
            4,
            vec![
                planned_task(TASK, "Accepted plan Task", &[], &["tests-pass"], &[]),
                planned_task(
                    "task-dependent",
                    "Dependent Task",
                    &[TASK],
                    &["docs-match"],
                    &[],
                ),
            ],
            "task-1-again",
        )),
        "managed_conflict"
    );

    // The accepted SpecVersion budget is enforced by the state machine: this
    // focused chain accepts at most eight Tasks, and a ninth fails closed.
    let mut budget_proposal = goal_proposal_body("goal-budget", "spec-budget");
    if let Value::Map(fields) = &mut budget_proposal {
        fields.insert("criteria".to_owned(), numbered_criteria(8));
    }
    let budget_digest = propose_and_assign_reviewer_on_socket(
        &mut stream,
        owner_epoch,
        incarnation,
        "goal-budget",
        "spec-budget",
        budget_proposal,
        "budget-chain",
    );
    accept_spec_on_socket(
        &mut stream,
        owner_epoch,
        incarnation,
        "goal-budget",
        "spec-budget",
        &budget_digest,
        "budget-chain",
    );
    let budget_tasks = |count: usize| -> Vec<Value> {
        (0..count)
            .map(|index| {
                let task_id = format!("task-budget-{index}");
                let title = format!("Budget Task {index}");
                let criterion = format!("criterion-{index}");
                planned_task(&task_id, &title, &[], &[criterion.as_str()], &[])
            })
            .collect()
    };
    plan_run_on_socket(
        &mut stream,
        owner_epoch,
        incarnation,
        "goal-budget",
        "spec-budget",
        "run-budget",
        session_id,
        &budget_digest,
        3,
        budget_tasks(8),
        "budget-8",
    );
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            "goal-budget",
            "spec-budget",
            "run-budget-overflow",
            session_id,
            &budget_digest,
            4,
            budget_tasks(9),
            "budget-overflow",
        )),
        "managed_conflict"
    );

    // The explicit accepted start pins the SessionLink through exactly one
    // registered Location owned by the same authenticated ServerAuth subject.
    register_location_on_socket(
        &mut stream,
        owner_epoch,
        incarnation,
        &state,
        "budget",
    );
    let started = ok_body(socket_roundtrip_as(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-run-start",
            "start_planned_run",
            start_planned_run_body(
                GOAL,
                SPEC,
                RUN,
                &digest,
                field_decimal_u64(&planned, "revision"),
                session_id,
                "run-start",
            ),
            Some("run-start-start"),
        ),
        Some("reviewer"),
    ));
    assert_eq!(field_text(&started, "status"), "RUNNING");

    // The accepted flow proves the readiness invariant directly: after the
    // explicit start only the dependency-free root Task is ready, while the
    // dependent Task stays unready until its prerequisite is verified.
    let readiness_snapshot = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-readiness-snapshot",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    let run = only_run(&readiness_snapshot);
    let mut root_ready = false;
    let mut dependent_ready = true;
    for task in field_array(&run, "tasks") {
        let ready = matches!(field(task, "ready"), Value::Bool(true));
        match field_text(task, "taskID") {
            TASK => root_ready = ready,
            "task-dependent" => dependent_ready = ready,
            other => panic!("unexpected planned Task {other}"),
        }
    }
    assert!(
        root_ready,
        "a dependency-free Task becomes ready at the explicit accepted start"
    );
    assert!(
        !dependent_ready,
        "a Task that depends on an unverified Task cannot become ready until its \
         prerequisite is independently verified"
    );

    // BLOCKED (owning prerequisite: the removed legacy `mark_task_ready` route
    // plus an authenticated independent-verifier verdict for the prerequisite
    // Task — no P1/P8 verifier evidence exists yet). The readiness expectation
    // is preserved verbatim; the supported accepted-plan flow exposes no
    // readiness command, and inventing one (or a verdict) would be fake
    // evidence. This assertion is deliberately last so every reachable
    // criteria/dependency/budget assertion above still executes.
    let readiness = socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-ready-dependent",
            "mark_task_ready",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string("task-dependent")),
            ]),
            Some("ready-dependent"),
        ),
    );
    assert_eq!(
        error_code(&readiness),
        "managed_conflict",
        "a Task that depends on an unverified Task cannot become ready until its \
         prerequisite is independently verified"
    );
}

#[test]
fn plan_ingress_rejects_a_rejected_spec_and_keeps_goals_isolated() {
    let directory = SocketTestDir::new();
    let state = directory.0.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    let incarnation = "inc_rejected_spec";
    let (_child, mut stream, owner_epoch) = start_kernel_process(
        &state,
        "rejected-spec.sock",
        "rejected-spec-nonce",
        incarnation,
    );
    let digest = propose_and_assign_reviewer_on_socket(
        &mut stream,
        owner_epoch,
        incarnation,
        GOAL,
        SPEC,
        goal_proposal_body(GOAL, SPEC),
        "rejected",
    );

    let rejected = ok_body(socket_roundtrip_as(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-reject-spec",
            "reject_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("reject-1"),
        ),
        Some("reviewer"),
    ));
    assert_eq!(field_text(&rejected, "status"), "REJECTED");
    assert_eq!(field_text(&rejected, "rejectedBy"), REVIEWER);
    assert_eq!(field_unsigned(&rejected, "revision"), 3);
    // A rejected SpecVersion is immutable: it can no longer be accepted or
    // planned into a Run.
    assert_eq!(
        error_code(&socket_roundtrip_as(
            &mut stream,
            managed_socket_request(
                owner_epoch,
                incarnation,
                "req-accept-after-reject",
                "accept_spec",
                map([
                    ("goalID", string(GOAL)),
                    ("specID", string(SPEC)),
                    ("specDigest", string(&digest)),
                    ("expectedRevision", Value::Unsigned(2)),
                ]),
                Some("accept-after-reject"),
            ),
            Some("reviewer"),
        )),
        "managed_conflict"
    );
    assert_eq!(
        error_code(&plan_run_response(
            &mut stream,
            owner_epoch,
            incarnation,
            GOAL,
            SPEC,
            RUN,
            "ses_ingress_rejected",
            &digest,
            3,
            vec![planned_task(
                TASK,
                "Plan on a rejected Spec",
                &[],
                &["tests-pass"],
                &[],
            )],
            "run-after-reject",
        )),
        "managed_conflict"
    );

    // A second Goal has its own atomic proposal and durable revision.
    let mut second_proposal = goal_proposal_body("goal-second", "spec-second");
    if let Value::Map(fields) = &mut second_proposal {
        fields.insert("objective".to_owned(), string("Independent goal"));
    }
    let other = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-goal-second",
            "create_goal_proposal",
            second_proposal,
            Some("goal-second"),
        ),
    ));
    assert_eq!(field_unsigned(&other, "revision"), 1);
    let snapshot = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-goal-second-snapshot",
            "snapshot",
            map([("goalID", string("goal-second"))]),
            None,
        ),
    ));
    assert!(matches!(field(&snapshot, "specs"), Value::Array(specs) if specs.len() == 1));
}

#[test]
fn real_socket_review_cas_replay_and_restart_stay_fail_closed_for_single_uid() {
    let directory = SocketTestDir::new();
    let state = directory.0.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    let first_incarnation = "inc_managed_review_1";
    let (first_child, mut first_stream, first_epoch) = start_kernel_process(
        &state,
        "managed-review-1.sock",
        "managed-review-nonce-1",
        first_incarnation,
    );

    let created = socket_roundtrip(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-goal-spec-create",
            "create_goal_proposal",
            goal_proposal_body(GOAL, SPEC),
            Some("goal-spec-socket-1"),
        ),
    );
    assert_eq!(created.outcome, RpcOutcomeV1::Ok, "{:?}", created.error);
    let created_body = created.body.unwrap();
    assert_eq!(field_unsigned(&created_body, "revision"), 1);
    assert_eq!(
        field_text(&created_body, "createdBy"),
        format!("host_os_uid:{}", unsafe { libc::geteuid() })
    );

    let spec_digest = proposed_spec_digest(&created_body);

    let assigned = socket_roundtrip_as(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-reviewer-assign",
            "assign_spec_reviewer",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&spec_digest)),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("reviewer-socket-assign"),
        ),
        Some("reviewer"),
    );
    assert_eq!(assigned.outcome, RpcOutcomeV1::Ok, "{:?}", assigned.error);
    assert_eq!(
        field_unsigned(assigned.body.as_ref().unwrap(), "decisionRevision"),
        2
    );

    // A decision against the pre-assignment revision is rejected and does not
    // consume its delivery key or advance state.
    let stale_body = map([
        ("goalID", string(GOAL)),
        ("specID", string(SPEC)),
        ("specDigest", string(&spec_digest)),
        ("expectedRevision", Value::Unsigned(1)),
    ]);
    let stale = socket_roundtrip_as(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-review-stale",
            "accept_spec",
            stale_body.clone(),
            Some("review-socket-stale"),
        ),
        Some("reviewer"),
    );
    assert_eq!(error_code(&stale), "managed_conflict");
    let after_stale = ok_body(socket_roundtrip(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-snapshot-before-restart",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    assert_eq!(field_unsigned(&after_stale, "revision"), 2);

    // Host restart retains successful delivery records and the exact reviewed
    // revision. The stale request is still stale, while a current revision cannot
    // be approved by the same UID that authored the proposal.
    drop(first_stream);
    first_child.stop();
    let second_incarnation = "inc_managed_review_2";
    let (second_child, mut second_stream, second_epoch) = start_kernel_process(
        &state,
        "managed-review-2.sock",
        "managed-review-nonce-2",
        second_incarnation,
    );
    let proposal_replay = ok_body(socket_roundtrip(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-goal-spec-replay",
            "create_goal_proposal",
            goal_proposal_body(GOAL, SPEC),
            Some("goal-spec-socket-1"),
        ),
    ));
    // Idempotent proposal replay returns the current Goal revision, not the revision
    // at the original delivery; replay itself must not advance it.
    assert_eq!(field_unsigned(&proposal_replay, "revision"), 2);
    assert_eq!(proposed_spec_digest(&proposal_replay), spec_digest);

    let assigned_replay = socket_roundtrip_as(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-reviewer-assign-replay",
            "assign_spec_reviewer",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&spec_digest)),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("reviewer-socket-assign"),
        ),
        Some("reviewer"),
    );
    assert_eq!(
        assigned_replay.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        assigned_replay.error
    );
    assert_eq!(
        field_text(assigned_replay.body.as_ref().unwrap(), "reviewerID"),
        REVIEWER
    );

    let stale_replay = socket_roundtrip_as(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-review-stale-replay",
            "accept_spec",
            stale_body,
            Some("review-socket-stale"),
        ),
        Some("reviewer"),
    );
    assert_eq!(error_code(&stale_replay), "managed_conflict");
    let same_uid_review = socket_roundtrip(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-review-same-uid",
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&spec_digest)),
                ("expectedRevision", Value::Unsigned(3)),
            ]),
            Some("review-socket-current"),
        ),
    );
    assert_eq!(
        error_code(&same_uid_review),
        "independent_verifier_required"
    );

    let accepted = socket_roundtrip_as(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-review-accept",
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&spec_digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("review-socket-accept"),
        ),
        Some("reviewer"),
    );
    assert_eq!(accepted.outcome, RpcOutcomeV1::Ok, "{:?}", accepted.error);
    assert_eq!(
        field_text(accepted.body.as_ref().unwrap(), "acceptedBy"),
        REVIEWER
    );

    // A caller cannot manufacture a distinct reviewer by including a principal in
    // the body; the wire contract rejects unknown identity fields.
    let forged_reviewer = socket_roundtrip(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-review-forged-principal",
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&spec_digest)),
                ("expectedRevision", Value::Unsigned(2)),
                ("principal", string(REVIEWER)),
            ]),
            Some("review-socket-forged"),
        ),
    );
    assert_eq!(error_code(&forged_reviewer), "invalid_effect_request");

    // None of the review decisions or rejected requests above advanced the
    // durable Goal revision: it is still the accepted SpecVersion revision.
    let review_snapshot = ok_body(socket_roundtrip(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-snapshot-final",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    assert_eq!(field_unsigned(&review_snapshot, "revision"), 3);

    // The accepted plan is started on the authenticated socket: a Run needs an
    // exactly registered Location owned by the same ServerAuth subject before
    // `start_planned_run` may pin the SessionLink.
    let workspace = state.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let registered = socket_roundtrip_as(
        &mut second_stream,
        RpcRequestV1 {
            owner_epoch: second_epoch,
            process_incarnation: second_incarnation.to_owned(),
            request_id: "req-review-register-location".to_owned(),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: "register_location".to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: "trace-review-register-location".to_owned(),
            body: map([
                ("canonicalRoot", string(workspace.to_str().unwrap())),
                ("workspaceID", string("workspace-one")),
            ]),
        },
        Some("reviewer"),
    );
    assert_eq!(
        registered.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        registered.error
    );
    let (_planned, started) = plan_and_start_one_task(
        &mut second_stream,
        second_epoch,
        second_incarnation,
        GOAL,
        SPEC,
        RUN,
        "ses_ingress_review",
        &spec_digest,
        planned_task(
            TASK,
            "Review Run Task",
            &[],
            &["tests-pass", "docs-match"],
            &[],
        ),
        "review-run",
    );
    assert_eq!(field_text(&started, "status"), "RUNNING");

    // BLOCKED (owning prerequisites: P1 Guard Attempt admission with bound
    // effect receipts, plus a host-registered independent verifier profile).
    // `begin_verification` on the started Run now reaches the missing
    // authenticated Attempt evidence instead of a missing Run; the expected
    // trusted-adapter `capability_unavailable` denial is preserved verbatim and
    // cannot be reached without that authentic evidence.
    let verifier_without_adapter = socket_roundtrip_as(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-verifier-unavailable",
            "begin_verification",
            map([("goalID", string(GOAL)), ("runID", string(RUN))]),
            Some("verification-socket-unavailable"),
        ),
        Some("reviewer"),
    );
    assert_eq!(
        error_code(&verifier_without_adapter),
        "capability_unavailable"
    );
    let same_uid_verifier = socket_roundtrip(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-verifier-same-uid",
            "verify_task",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("attemptID", string("attempt-socket")),
            ]),
            Some("verify-socket-same-uid"),
        ),
    );
    // BLOCKED (same owning prerequisites as above): this unauthenticated
    // `verify_task` is refused first by the route's ServerAuth requirement, and
    // even an authenticated call needs an admitted Attempt whose executor
    // principal can be compared with this caller. The expected same-UID
    // `independent_verifier_required` verdict is preserved verbatim.
    assert_eq!(
        error_code(&same_uid_verifier),
        "independent_verifier_required"
    );

    drop(second_stream);
    second_child.stop();
}

#[test]
fn real_socket_pause_resume_restart_and_cancel_remain_fenced_before_effect_bootstrap() {
    let directory = SocketTestDir::new();
    let state = directory.0.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();

    let first_incarnation = "inc_managed_lifecycle_1";
    let (first_child, mut first_stream, first_epoch) = start_kernel_process(
        &state,
        "managed-lifecycle-1.sock",
        "managed-lifecycle-nonce-1",
        first_incarnation,
    );
    let proposal = ok_body(socket_roundtrip(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-proposal",
            "create_goal_proposal",
            goal_proposal_body(GOAL, SPEC),
            Some("lifecycle-proposal"),
        ),
    ));
    let digest = proposed_spec_digest(&proposal);
    let assigned = socket_roundtrip_as(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-assign-reviewer",
            "assign_spec_reviewer",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("lifecycle-reviewer"),
        ),
        Some("reviewer"),
    );
    assert_eq!(assigned.outcome, RpcOutcomeV1::Ok, "{:?}", assigned.error);
    let accepted = socket_roundtrip_as(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-accept-spec",
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("lifecycle-accept"),
        ),
        Some("reviewer"),
    );
    assert_eq!(accepted.outcome, RpcOutcomeV1::Ok, "{:?}", accepted.error);
    let workspace = state.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let location_request = RpcRequestV1 {
        owner_epoch: first_epoch,
        process_incarnation: first_incarnation.to_owned(),
        request_id: "req-lifecycle-register-location".to_owned(),
        service_id: EFFECTS_SERVICE_ID.to_owned(),
        operation: "register_location".to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: now_ms() + 30_000,
        trace_id: "trace-lifecycle-register-location".to_owned(),
        body: map([
            ("canonicalRoot", string(workspace.to_str().unwrap())),
            ("workspaceID", string("workspace-one")),
        ]),
    };
    let registered = socket_roundtrip_as(&mut first_stream, location_request, Some("reviewer"));
    assert_eq!(
        registered.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        registered.error
    );

    let planned = socket_roundtrip_as(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-plan-run",
            "plan_run",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedGoalRevision", string("3")),
                ("idempotencyKey", string("lifecycle-plan-run")),
                ("sessionID", string("ses_lifecycle")),
                (
                    "tasks",
                    Value::Array(vec![map([
                        ("taskID", string(TASK)),
                        ("title", string("Lifecycle fencing")),
                        ("purpose", string("Exercise accepted Run lifecycle")),
                        ("dependencies", Value::Array(vec![])),
                        ("criterionIDs", strings(&["tests-pass", "docs-match"])),
                        ("requiredCapabilities", Value::Array(vec![])),
                        ("profileSelection", profile_selection()),
                        ("profileDefinition", planned_profile_definition()),
                    ])]),
                ),
            ]),
            Some("lifecycle-plan-run"),
        ),
        Some("reviewer"),
    );
    assert_eq!(planned.outcome, RpcOutcomeV1::Ok, "{:?}", planned.error);
    let planned_body = planned.body.unwrap();
    assert_eq!(field_text(&planned_body, "runPhase"), "PLAN_ONLY");
    let start = socket_roundtrip_as(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-start-planned-run",
            "start_planned_run",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                (
                    "expectedGoalRevision",
                    string(&field_unsigned(&planned_body, "revision").to_string()),
                ),
                ("sessionID", string("ses_lifecycle")),
                ("idempotencyKey", string("lifecycle-start-planned-run")),
                (
                    "sessionLink",
                    map([
                        ("sessionID", string("ses_lifecycle")),
                        ("sourceStoreID", string("store_lifecycle")),
                        ("sourceInstanceID", string("instance_lifecycle")),
                        (
                            "sourceCursor",
                            map([
                                ("ownerKind", string("session")),
                                ("ownerId", string("ses_lifecycle")),
                                ("seq", string("1")),
                                ("eventDigest", string(&format!("blake3:{}", "b".repeat(64)))),
                            ]),
                        ),
                        ("sourceEpoch", string("1")),
                        ("latestObservedMessageID", Value::Nil),
                        ("latestObservedPartID", Value::Nil),
                        (
                            "sourceDigest",
                            string(&session_link_digest([
                                "ses_lifecycle",
                                "store_lifecycle",
                                "instance_lifecycle",
                                "session",
                                "ses_lifecycle",
                                "1",
                                &format!("blake3:{}", "b".repeat(64)),
                                "1",
                                "",
                                "",
                                "horizon.session-link.ids-only.v1",
                                "1",
                                GOAL,
                                "project-one",
                                "workspace-one",
                            ])),
                        ),
                        (
                            "redactionProfile",
                            string("horizon.session-link.ids-only.v1"),
                        ),
                        ("protocolVersion", Value::Unsigned(1)),
                        ("goalID", string(GOAL)),
                        ("projectID", string("project-one")),
                        ("workspaceID", string("workspace-one")),
                    ]),
                ),
            ]),
            Some("lifecycle-start-planned-run"),
        ),
        Some("reviewer"),
    );
    assert_eq!(start.outcome, RpcOutcomeV1::Ok, "{:?}", start.error);
    // The negotiated effect surface has a real Location, but no Guarded
    // admission proof producer; managed Attempt admission must still fail closed.
    let snapshot = ok_body(socket_roundtrip(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-snapshot-initial",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    let initial_revision = field_unsigned(&snapshot, "revision");

    let paused = ok_body(socket_roundtrip_as(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-pause",
            "pause_run",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("expectedRevision", Value::Unsigned(initial_revision)),
            ]),
            Some("lifecycle-pause"),
        ),
        Some("reviewer"),
    ));
    assert_eq!(field_text(&paused, "runPhase"), "PAUSED");

    let resumed = ok_body(socket_roundtrip_as(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-resume",
            "resume_run",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                (
                    "expectedRevision",
                    Value::Unsigned(field_unsigned(&paused, "revision")),
                ),
            ]),
            Some("lifecycle-resume"),
        ),
        Some("reviewer"),
    ));
    assert_eq!(field_text(&resumed, "runPhase"), "RUNNING");

    let unavailable_admit = socket_roundtrip(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-admit",
            "admit",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("attemptID", string("attempt-lifecycle")),
                (
                    "expectedRevision",
                    Value::Unsigned(field_unsigned(&resumed, "revision")),
                ),
                ("locationID", string("loc-not-registered")),
                ("sessionID", string("ses_lifecycle")),
            ]),
            Some("lifecycle-admit"),
        ),
    );
    assert_eq!(error_code(&unavailable_admit), "invalid_effect_request");
    let before_restart = ok_body(socket_roundtrip(
        &mut first_stream,
        managed_socket_request(
            first_epoch,
            first_incarnation,
            "req-lifecycle-snapshot-before-restart",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    assert!(
        matches!(field(&before_restart, "attempts"), Value::Array(attempts) if attempts.is_empty())
    );
    assert_eq!(
        field_unsigned(&before_restart, "revision"),
        field_unsigned(&resumed, "revision")
    );
    drop(first_stream);
    first_child.stop();

    // The accepted managed plan is durable across the real HostKernel restart.
    // UNKNOWN recovery cannot be exercised because guarded Attempt admission is
    // blocked at the unnegotiated effects.v2/location boundary above.
    let second_incarnation = "inc_managed_lifecycle_2";
    let (second_child, mut second_stream, second_epoch) = start_kernel_process(
        &state,
        "managed-lifecycle-2.sock",
        "managed-lifecycle-nonce-2",
        second_incarnation,
    );
    let recovered = ok_body(socket_roundtrip(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-lifecycle-snapshot-recovered",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    assert!(matches!(field(&recovered, "attempts"), Value::Array(attempts) if attempts.is_empty()));
    assert_eq!(field_text(&only_run(&recovered), "phase"), "RUNNING");

    let cancel = ok_body(socket_roundtrip_as(
        &mut second_stream,
        managed_socket_request(
            second_epoch,
            second_incarnation,
            "req-lifecycle-cancel-unknown",
            "cancel",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                (
                    "expectedRevision",
                    Value::Unsigned(field_unsigned(&recovered, "revision")),
                ),
            ]),
            Some("lifecycle-cancel-unknown"),
        ),
        Some("reviewer"),
    ));
    assert_eq!(field_text(&cancel, "runPhase"), "CANCELLED");
    drop(second_stream);
    second_child.stop();

    let third_incarnation = "inc_managed_lifecycle_3";
    let (third_child, mut third_stream, third_epoch) = start_kernel_process(
        &state,
        "managed-lifecycle-3.sock",
        "managed-lifecycle-nonce-3",
        third_incarnation,
    );
    let cancelled = ok_body(socket_roundtrip(
        &mut third_stream,
        managed_socket_request(
            third_epoch,
            third_incarnation,
            "req-lifecycle-snapshot-cancelled",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    assert_eq!(field_text(&only_run(&cancelled), "phase"), "CANCELLED");
    assert!(matches!(field(&cancelled, "attempts"), Value::Array(attempts) if attempts.is_empty()));
    drop(third_stream);
    third_child.stop();
}

/// The production Core client must emit exactly Rust's closed `admit` key set:
/// the 12 pre-admission common keys plus `managedProviderRoute` and `attemptID`,
/// with **no** optional keys. `strict_fields` rejects an unlisted key (the client
/// used to send `profileSelection`) and a wrong wire encoding before any
/// admission logic runs, so this pins the contract the TS client mirrors.
#[test]
fn managed_admit_body_is_the_exact_closed_key_set_before_any_admission_logic() {
    let mut fixture = Fixture::new();
    let body = |expected_revision: Value| {
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("expectedRevision", expected_revision),
            ("parentSessionID", string("ses_parent")),
            ("locationID", string("loc_unregistered")),
            ("sessionID", string("ses_child")),
            ("profileDefinition", profile_definition()),
            ("contextSelection", map([("schemaVersion", Value::Unsigned(1))])),
            ("resourcePolicyProjectionRevision", string("1")),
            ("resourcePolicyProjectionDigest", string(&b3('c'))),
            ("preAdmissionProofDigest", string(&b3('b'))),
            ("managedProviderRoute", map([("providerID", string("provider"))])),
            ("attemptID", string("attempt-ingress")),
        ])
    };
    let exact = body(string("4"));

    // The exact closed key set with canonical encodings clears `strict_fields`
    // and every field parse: only the typed ServerAuth principal stops it.
    assert_eq!(
        error_code(&fixture.send_as(
            AUTHOR,
            "admit",
            exact.clone(),
            Some("admit-exact-unauthenticated"),
        )),
        "missing_principal",
        "the exact closed key set must reach the typed principal requirement"
    );
    // With a ServerAuth subject the same body passes every pre-Location parse and
    // stops at the first lookup instead of at body validation.
    assert_eq!(
        error_code(&fixture.send_as(
            REVIEWER,
            "admit",
            exact.clone(),
            Some("admit-exact-serverauth"),
        )),
        "location_not_registered",
        "the exact closed key set passes body validation end to end"
    );

    // An unlisted key is rejected before any of it.
    let mut unlisted = exact.clone();
    if let Value::Map(fields) = &mut unlisted {
        fields.insert("profileSelection".to_owned(), profile_selection());
    }
    assert_eq!(
        error_code(&fixture.send_as(AUTHOR, "admit", unlisted, Some("admit-unlisted-key"))),
        "invalid_effect_request",
        "an unlisted key such as profileSelection must be rejected"
    );

    // A missing required resource-policy key is rejected too.
    let mut missing_resource_key = exact.clone();
    if let Value::Map(fields) = &mut missing_resource_key {
        fields.remove("resourcePolicyProjectionDigest");
    }
    assert_eq!(
        error_code(&fixture.send_as(
            AUTHOR,
            "admit",
            missing_resource_key,
            Some("admit-missing-resource-key"),
        )),
        "invalid_effect_request",
        "resourcePolicyProjectionDigest is required, not optional"
    );

    // Revisions cross this boundary as canonical decimal strings (as Stage-A
    // `reserve` already sends them), never as MessagePack uint64.
    let mut uint64_revision = exact.clone();
    if let Value::Map(fields) = &mut uint64_revision {
        fields.insert("expectedRevision".to_owned(), Value::Unsigned(4));
    }
    assert_eq!(
        error_code(&fixture.send_as(
            AUTHOR,
            "admit",
            uint64_revision,
            Some("admit-revision-uint64"),
        )),
        "invalid_effect_request"
    );
    let mut uint64_projection = exact.clone();
    if let Value::Map(fields) = &mut uint64_projection {
        fields.insert(
            "resourcePolicyProjectionRevision".to_owned(),
            Value::Unsigned(1),
        );
    }
    assert_eq!(
        error_code(&fixture.send_as(
            AUTHOR,
            "admit",
            uint64_projection,
            Some("admit-projection-uint64"),
        )),
        "invalid_effect_request"
    );
}

/// The exact Rust-derived candidate Attempt identity `resource-policy.ingress-v1`
/// and Stage-A `reserve` demand (`horizoncode.managed-task-attempt-candidate.v1`).
/// HostKernel keeps the derivation private, so this fixture replicates it; a drift
/// in the derivation fails this test instead of silently loosening it.
fn candidate_attempt_id(task_id: &str, attempt_count: u16, generation: u64) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.managed-task-attempt-candidate.v1\0");
    hasher.update(&(task_id.len() as u64).to_be_bytes());
    hasher.update(task_id.as_bytes());
    hasher.update(&u64::from(attempt_count).to_be_bytes());
    hasher.update(&generation.to_be_bytes());
    format!("attempt_{}", hasher.finalize().to_hex())
}

fn resource_policy_request(
    owner_epoch: u64,
    incarnation: &str,
    request_id: &str,
    body: Value,
) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch,
        process_incarnation: incarnation.to_owned(),
        request_id: request_id.to_owned(),
        service_id: RESOURCE_SERVICE_ID.to_owned(),
        operation: "project_policy".to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: now_ms() + 30_000,
        trace_id: format!("trace-{request_id}"),
        body,
    }
}

/// The nine ordered dimensions, each declaring **no configured policy**: no
/// `effective` block and `UNSUPPORTED` enforcement — the only shape
/// `decode_resource_policy_projection` accepts without one, and the shape for
/// which `worker_admission_limit` never yields a numeric cap.
fn no_configured_policy_projection() -> Value {
    const DIMENSIONS: [&str; 9] = [
        "memoryBytes",
        "cpuMillicores",
        "processes",
        "fds",
        "diskBytes",
        "toolOutputBytes",
        "activeWorkers",
        "tokens",
        "providerCostMicros",
    ];
    let rows = DIMENSIONS
        .iter()
        .copied()
        .map(|dimension| {
            map([
                ("dimension", string(dimension)),
                ("configurationSource", string("unknown")),
                ("policyLock", string("unknown")),
                ("enforcement", string("UNSUPPORTED")),
            ])
        })
        .collect::<Vec<_>>();
    map([
        ("schemaVersion", Value::Unsigned(1)),
        ("limits", Value::Array(rows)),
    ])
}

fn project_policy_body(
    candidate_attempt_id: &str,
    location_id: &str,
    parent_session_id: &str,
    child_session_id: &str,
    revision: u64,
    projection: Value,
) -> Value {
    map([
        ("goalID", string(GOAL)),
        ("runID", string(RUN)),
        ("taskID", string(TASK)),
        ("candidateAttemptID", string(candidate_attempt_id)),
        ("parentSessionID", string(parent_session_id)),
        ("locationID", string(location_id)),
        ("sessionID", string(child_session_id)),
        ("expectedRevision", string(&revision.to_string())),
        ("projection", projection),
    ])
}

/// Stage-A `reserve` body: the 8 required keys, with the two resource-policy
/// keys present only when the caller claims a projection (compare-only).
fn reserve_body(
    revision: u64,
    location_id: &str,
    parent_session_id: &str,
    child_session_id: &str,
    projection: Option<(&str, &str)>,
) -> Value {
    let mut fields = std::collections::BTreeMap::new();
    fields.insert("goalID".to_owned(), string(GOAL));
    fields.insert("runID".to_owned(), string(RUN));
    fields.insert("taskID".to_owned(), string(TASK));
    fields.insert("expectedRevision".to_owned(), string(&revision.to_string()));
    fields.insert("parentSessionID".to_owned(), string(parent_session_id));
    fields.insert("locationID".to_owned(), string(location_id));
    fields.insert("sessionID".to_owned(), string(child_session_id));
    fields.insert("profileDefinition".to_owned(), planned_profile_definition());
    if let Some((projection_revision, projection_digest)) = projection {
        fields.insert(
            "resourcePolicyProjectionRevision".to_owned(),
            string(projection_revision),
        );
        fields.insert(
            "resourcePolicyProjectionDigest".to_owned(),
            string(projection_digest),
        );
    }
    Value::Map(fields)
}

/// A client that offers `resource-policy.ingress-v1` and posts a projection with
/// **no configured policy** still cannot widen admission or bypass a deny: without
/// the negotiated feature no pin can exist, a pin is minted only for the exact
/// authenticated candidate, it creates no Attempt, it cannot be lied about, and
/// Stage-A `reserve` remains denied by the next independent gate either way.
#[test]
fn resource_policy_projection_ingress_fails_closed_without_a_configured_policy() {
    let directory = SocketTestDir::new();
    let state_dir = directory.0.join("state");
    fs::create_dir(&state_dir).unwrap();
    fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state_dir).unwrap();
    let parent_session = "ses_ingress_resource";
    let child_session = format!("ses_managed_{}", candidate_attempt_id(TASK, 0, 0));
    let placeholder_location = "loc_unregistered";

    // (1) Without offering the feature, projection is refused before the body is
    // parsed: this route can never mint a pin on such a connection.
    let off_incarnation = "inc_resource_policy_off";
    let (off_child, mut off_stream, off_epoch) =
        start_kernel_process(&state, "resource-off.sock", "resource-off-nonce", off_incarnation);
    let unoffered = socket_roundtrip_as(
        &mut off_stream,
        resource_policy_request(
            off_epoch,
            off_incarnation,
            "req-rp-unoffered",
            project_policy_body(
                &candidate_attempt_id(TASK, 0, 0),
                placeholder_location,
                parent_session,
                &child_session,
                1,
                no_configured_policy_projection(),
            ),
        ),
        Some("reviewer"),
    );
    assert_eq!(
        error_code(&unoffered),
        "feature_not_negotiated",
        "resource-policy.ingress-v1 must be negotiated before any projection is read"
    );
    drop(off_stream);
    off_child.stop();

    // (2) With the feature negotiated, build the exact Rust scheduler candidate.
    let incarnation = "inc_resource_policy_on";
    let (child, mut stream, owner_epoch) = start_kernel_process_with_features(
        &state,
        "resource-on.sock",
        "resource-on-nonce",
        incarnation,
        vec![
            "effects.v2".to_owned(),
            "resource-policy.ingress-v1".to_owned(),
        ],
    );
    // The projecting subject owns the Goal (`created_by`) and the Location, while
    // an independent reviewer accepts the Spec.
    let proposed = ok_body(socket_roundtrip_as(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-rp-proposal",
            "create_goal_proposal",
            goal_proposal_body(GOAL, SPEC),
            Some("rp-goal-spec"),
        ),
        Some("reviewer"),
    ));
    let digest = proposed_spec_digest(&proposed);
    let assigned = socket_roundtrip_as(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-rp-assign",
            "assign_spec_reviewer",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("rp-assign"),
        ),
        Some("verifier"),
    );
    assert_eq!(assigned.outcome, RpcOutcomeV1::Ok, "{:?}", assigned.error);
    let accepted = socket_roundtrip_as(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-rp-accept",
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("rp-accept"),
        ),
        Some("verifier"),
    );
    assert_eq!(accepted.outcome, RpcOutcomeV1::Ok, "{:?}", accepted.error);
    let location_id =
        register_location_on_socket(&mut stream, owner_epoch, incarnation, &state, "rp");
    let (_planned, started) = plan_and_start_one_task(
        &mut stream,
        owner_epoch,
        incarnation,
        GOAL,
        SPEC,
        RUN,
        parent_session,
        &digest,
        planned_task(
            TASK,
            "Resource policy Task",
            &[],
            &["tests-pass", "docs-match"],
            &[],
        ),
        "rp-run",
    );
    let revision = field_decimal_u64(&started, "revision");
    let candidate = candidate_attempt_id(TASK, 0, 0);
    assert_eq!(child_session, format!("ses_managed_{candidate}"));
    let projection = project_policy_body(
        &candidate,
        &location_id,
        parent_session,
        &child_session,
        revision,
        no_configured_policy_projection(),
    );

    // (3) The projection body is exactly nine keys; an unlisted key is refused.
    let mut unlisted = projection.clone();
    if let Value::Map(fields) = &mut unlisted {
        fields.insert("principal".to_owned(), string(REVIEWER));
    }
    assert_eq!(
        error_code(&socket_roundtrip_as(
            &mut stream,
            resource_policy_request(owner_epoch, incarnation, "req-rp-unlisted", unlisted),
            Some("reviewer"),
        )),
        "invalid_effect_request",
        "project_policy accepts no optional key"
    );

    // (4) Before any pin exists, Stage-A `reserve` stops at the resource-policy
    // gate: the projection cannot be skipped.
    assert_eq!(
        error_code(&socket_roundtrip_as(
            &mut stream,
            managed_socket_request(
                owner_epoch,
                incarnation,
                "req-rp-reserve-before-pin",
                "managed.pre_admission_target.reserve",
                reserve_body(revision, &location_id, parent_session, &child_session, None),
                Some("rp-reserve-before"),
            ),
            Some("reviewer"),
        )),
        "resource_policy_unavailable",
        "admission must not proceed without the candidate resource-policy pin"
    );

    // (5) With no configured policy the exact candidate is pinned — and only
    // that candidate, only for this authenticated owner and epoch.
    let pinned = ok_body(socket_roundtrip_as(
        &mut stream,
        resource_policy_request(owner_epoch, incarnation, "req-rp-project", projection.clone()),
        Some("reviewer"),
    ));
    assert_eq!(field_text(&pinned, "status"), "PINNED");
    let projection_revision = field_text(&pinned, "projectionRevision").to_owned();
    let projection_digest = field_text(&pinned, "projectionDigest").to_owned();

    // (6) The projection mutates nothing managed: no Attempt, no new revision.
    let after_projection = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-rp-snapshot",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    assert!(matches!(
        field(&after_projection, "attempts"),
        Value::Array(attempts) if attempts.is_empty()
    ));
    assert_eq!(field_decimal_u64(&after_projection, "revision"), revision);

    // (7) A caller cannot lie about the projection it presents.
    assert_eq!(
        error_code(&socket_roundtrip_as(
            &mut stream,
            managed_socket_request(
                owner_epoch,
                incarnation,
                "req-rp-reserve-stale",
                "managed.pre_admission_target.reserve",
                reserve_body(
                    revision,
                    &location_id,
                    parent_session,
                    &child_session,
                    Some(("2", projection_digest.as_str())),
                ),
                Some("rp-reserve-stale"),
            ),
            Some("reviewer"),
        )),
        "resource_policy_stale",
        "the projection revision must equal HostKernel's minted pin"
    );

    // (8) An honest projection clears only the resource-policy gate: Stage-A is
    // still refused by the next independent gate, and no Attempt appears.
    assert_eq!(
        error_code(&socket_roundtrip_as(
            &mut stream,
            managed_socket_request(
                owner_epoch,
                incarnation,
                "req-rp-reserve-after-pin",
                "managed.pre_admission_target.reserve",
                reserve_body(
                    revision,
                    &location_id,
                    parent_session,
                    &child_session,
                    Some((
                        projection_revision.as_str(),
                        projection_digest.as_str(),
                    )),
                ),
                Some("rp-reserve-after"),
            ),
            Some("reviewer"),
        )),
        "managed_conflict",
        "a projection satisfies only its own precondition; the root-coordinator/worker-owner gate still denies"
    );

    // (9) Even an aggressive, self-authored projection cannot widen admission:
    // it only ever narrows the accepted Spec ceiling and never reaches a grant.
    let aggressive = project_policy_body(
        &candidate,
        &location_id,
        parent_session,
        &child_session,
        revision,
        map([
            ("schemaVersion", Value::Unsigned(1)),
            (
                "limits",
                Value::Array(
                    [
                        "memoryBytes",
                        "cpuMillicores",
                        "processes",
                        "fds",
                        "diskBytes",
                        "toolOutputBytes",
                        "activeWorkers",
                        "tokens",
                        "providerCostMicros",
                    ]
                    .iter()
                    .copied()
                    .map(|dimension| {
                        map([
                            ("dimension", string(dimension)),
                            ("configurationSource", string("user")),
                            ("policyLock", string("unlocked")),
                            ("enforcement", string("ADMISSION_ONLY")),
                            (
                                "effective",
                                map([
                                    ("dimension", string(dimension)),
                                    ("enforcement", string("ADMISSION_ONLY")),
                                    ("source", string("USER")),
                                    ("hard", string("1048576")),
                                ]),
                            ),
                        ])
                    })
                    .collect::<Vec<_>>(),
                ),
            ),
        ]),
    );
    let repinned = ok_body(socket_roundtrip_as(
        &mut stream,
        resource_policy_request(owner_epoch, incarnation, "req-rp-reproject", aggressive),
        Some("reviewer"),
    ));
    assert_eq!(field_text(&repinned, "status"), "PINNED");
    let aggressive_revision = field_text(&repinned, "projectionRevision").to_owned();
    let aggressive_digest = field_text(&repinned, "projectionDigest").to_owned();
    assert_eq!(
        error_code(&socket_roundtrip_as(
            &mut stream,
            managed_socket_request(
                owner_epoch,
                incarnation,
                "req-rp-reserve-aggressive",
                "managed.pre_admission_target.reserve",
                reserve_body(
                    revision,
                    &location_id,
                    parent_session,
                    &child_session,
                    Some((aggressive_revision.as_str(), aggressive_digest.as_str())),
                ),
                Some("rp-reserve-aggressive"),
            ),
            Some("reviewer"),
        )),
        "managed_conflict",
        "a permissive projection must not bypass the same admission denial"
    );
    let final_snapshot = ok_body(socket_roundtrip(
        &mut stream,
        managed_socket_request(
            owner_epoch,
            incarnation,
            "req-rp-final-snapshot",
            "snapshot",
            map([("goalID", string(GOAL))]),
            None,
        ),
    ));
    assert!(
        matches!(
            field(&final_snapshot, "attempts"),
            Value::Array(attempts) if attempts.is_empty()
        ),
        "no projection attempt may ever create an Attempt"
    );

    drop(stream);
    child.stop();
}
