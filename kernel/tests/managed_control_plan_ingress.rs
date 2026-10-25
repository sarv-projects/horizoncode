#![cfg(target_os = "linux")]

//! Authenticated `managed.v1` plan-ingress tests.
//!
//! Goal creation, SpecVersion propose/accept/reject, Run start and Task add/ready are
//! exercised only through the authenticated host socket boundary. Every mutating call
//! is one-use keyed, records the authenticated principal (never a client-supplied
//! identity) and keeps the state machine's governance rules: a SpecVersion author can
//! never approve their own proposal, and the kernel computes the digest it accepts.

use horizoncode_kernel::host_kernel::{EFFECTS_SERVICE_ID, HostKernel, MANAGED_SERVICE_ID};
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

fn session_link_digest(parts: [&str; 15]) -> String {
    let mut preimage = b"horizoncode.session-link.source.v1\0".to_vec();
    for part in parts {
        preimage.extend_from_slice(&(part.len() as u64).to_be_bytes());
        preimage.extend_from_slice(part.as_bytes());
    }
    let digest = ring::digest::digest(&ring::digest::SHA256, &preimage);
    let hex = digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
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

fn persisted_profile_revision_ref() -> Value {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/agent-profile-definition-v2.json")).unwrap();
    map([
        ("profileId", string("specialist.reader")),
        ("revision", string("1")),
        (
            "definitionDigest",
            string(fixture["definitionDigest"].as_str().unwrap()),
        ),
    ])
}

struct Fixture {
    state: PathBuf,
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
        let location_id = field_text(&registered, "locationID").to_owned();
        Self {
            state,
            location_id,
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
            panic!("hz-kernel did not create a private owner-only socket before timeout; stderr: {stderr}");
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
            optional_features: vec!["effects.v2".to_owned()],
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

/// Creates the Goal and initial SpecVersion atomically, then starts the Run, returning the
/// spec digest computed by the kernel. The author cannot approve their own spec, so
/// acceptance is always a separate principal step.
fn seed_proposed_run(fixture: &mut Fixture) -> String {
    let proposed = ok_body(fixture.send(
        "create_goal_proposal",
        goal_proposal_body(GOAL, SPEC),
        Some("goal-spec-1"),
    ));
    let digest = proposed_spec_digest(&proposed);
    let assigned = assign_reviewer(fixture, &digest, 1);
    assert_eq!(field_text(&assigned, "reviewerID"), REVIEWER);
    assert_eq!(field_unsigned(&assigned, "decisionRevision"), 2);
    digest
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
    let mut fixture = Fixture::new();

    let proposed = ok_body(fixture.send(
        "create_goal_proposal",
        goal_proposal_body(GOAL, SPEC),
        Some("goal-spec-1"),
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
    let assigned = assign_reviewer(&mut fixture, &digest, 1);
    assert_eq!(field_text(&assigned, "reviewerID"), REVIEWER);
    assert_eq!(field_unsigned(&assigned, "decisionRevision"), 2);

    // A host OS identity is not a valid independent reviewer, even when it is
    // the principal that proposed the SpecVersion.
    let self_accept = fixture.send_as(
        AUTHOR,
        "accept_spec",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("specDigest", string(&digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("accept-self"),
    );
    assert_eq!(error_code(&self_accept), "independent_verifier_required");

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
    assert_eq!(field_text(&accepted, "status"), "ACCEPTED");
    assert_eq!(field_text(&accepted, "acceptedBy"), REVIEWER);
    assert_eq!(field_text(&accepted, "activeSpecVersionID"), SPEC);
    assert_eq!(field_unsigned(&accepted, "reviewedRevision"), 2);
    assert!(field_unsigned(&accepted, "acceptedAtMs") > 0);
    assert_eq!(field_unsigned(&accepted, "revision"), 3);

    let started = ok_body(fixture.send(
        "start_run",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("specID", string(SPEC)),
        ]),
        Some("run-1"),
    ));
    assert_eq!(field_text(&started, "status"), "STARTED");
    assert_eq!(field_text(&started, "runPhase"), "RUNNING");
    assert_eq!(field_unsigned(&started, "revision"), 4);

    let added = ok_body(fixture.send(
        "add_task",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("dependencies", Value::Array(vec![])),
            ("criterionIDs", strings(&["tests-pass"])),
            ("requiredCapabilities", Value::Array(vec![])),
            ("profileSelection", profile_selection()),
            ("profileDefinition", profile_definition()),
        ]),
        Some("task-1"),
    ));
    assert_eq!(field_text(&added, "status"), "ADDED");
    assert_eq!(field(&added, "ready"), &Value::Bool(false));
    assert_eq!(field_unsigned(&added, "attemptCount"), 0);
    assert!(field_array(&added, "requiredCapabilities").is_empty());
    assert_eq!(
        field(&added, "agentProfileRevision"),
        &persisted_profile_revision_ref()
    );
    assert_eq!(field_unsigned(&added, "revision"), 5);

    let ready = ok_body(fixture.send(
        "mark_task_ready",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
        ]),
        Some("ready-1"),
    ));
    assert_eq!(field_text(&ready, "status"), "READY");
    assert_eq!(field(&ready, "ready"), &Value::Bool(true));
    assert_eq!(field_unsigned(&ready, "revision"), 6);

    // No production adapter supplies immutable profile/context/resource proofs
    // yet. Admission must fail before mutating the ready Task or creating an
    // Attempt, while the snapshot still reports the persisted capability scope.
    assert_eq!(
        error_code(&fixture.send(
            "admit",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("attemptID", string("attempt-ingress")),
                ("expectedRevision", Value::Unsigned(6)),
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_ingress")),
            ]),
            Some("admit-1"),
        )),
        "capability_unavailable"
    );

    let snapshot = ok_body(fixture.send("snapshot", map([("goalID", string(GOAL))]), None));
    assert_eq!(field_unsigned(&snapshot, "revision"), 6);
    let spec = field_array(&snapshot, "specs")
        .first()
        .expect("persisted Spec");
    assert!(field_array(spec, "capabilityScope").is_empty());
    let run = only_run(&snapshot);
    assert_eq!(field_text(&run, "phase"), "RUNNING");
    let task = field_array(&run, "tasks").first().expect("persisted Task");
    assert!(field_array(task, "requiredCapabilities").is_empty());
    assert_eq!(
        field(task, "agentProfileRevision"),
        &persisted_profile_revision_ref()
    );
    assert!(field_array(&snapshot, "attempts").is_empty());
    assert_eq!(
        field_text(field(&snapshot, "goal"), "activeSpecVersionID"),
        SPEC
    );
}

#[test]
fn capability_scope_and_task_requirements_round_trip_from_owner_state() {
    let mut fixture = Fixture::new();
    let mut proposal = goal_proposal_body(GOAL, SPEC);
    if let Value::Map(fields) = &mut proposal {
        fields.insert("capabilityScope".to_owned(), strings(&["files.write"]));
    }
    let proposed = ok_body(fixture.send(
        "create_goal_proposal",
        proposal,
        Some("goal-spec-capability"),
    ));
    let digest = proposed_spec_digest(&proposed);
    assign_reviewer(&mut fixture, &digest, 1);
    ok_body(fixture.send_as(
        REVIEWER,
        "accept_spec",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("specDigest", string(&digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("accept-capability-spec"),
    ));
    ok_body(fixture.send(
        "start_run",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("specID", string(SPEC)),
        ]),
        Some("start-capability-run"),
    ));
    let added = ok_body(fixture.send(
        "add_task",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("dependencies", Value::Array(vec![])),
            ("criterionIDs", strings(&["tests-pass"])),
            ("requiredCapabilities", strings(&["files.write"])),
            ("profileSelection", profile_selection()),
            ("profileDefinition", profile_definition()),
        ]),
        Some("add-capability-task"),
    ));
    assert_eq!(
        field_array(&added, "requiredCapabilities"),
        &[string("files.write")]
    );

    let snapshot = ok_body(fixture.send("snapshot", map([("goalID", string(GOAL))]), None));
    let spec = field_array(&snapshot, "specs")
        .first()
        .expect("persisted Spec");
    assert_eq!(
        field_array(spec, "capabilityScope"),
        &[string("files.write")]
    );
    let run = only_run(&snapshot);
    let task = field_array(&run, "tasks").first().expect("persisted Task");
    assert_eq!(
        field_array(task, "requiredCapabilities"),
        &[string("files.write")]
    );
}

#[test]
fn task_profile_selection_and_definition_are_validated_before_owner_mutation() {
    let mut fixture = Fixture::new();
    let goal_id = "goal-profile-pin-forged";
    let base = map([
        ("goalID", string(goal_id)),
        ("runID", string(RUN)),
        ("taskID", string("task-profile-pin")),
        ("dependencies", Value::Array(vec![])),
        ("criterionIDs", strings(&["tests-pass"])),
        ("requiredCapabilities", Value::Array(vec![])),
        ("profileSelection", profile_selection()),
        ("profileDefinition", profile_definition()),
    ]);

    assert_eq!(
        error_code(&fixture.send_as(
            AUTHOR,
            "add_task",
            base.clone(),
            Some("untrusted-profile-proposal"),
        )),
        "missing_principal",
        "Task profile selection requires the out-of-body authenticated subject"
    );

    assert_eq!(
        error_code(&fixture.send("add_task", base.clone(), Some("valid-profile-pin"))),
        "managed_not_found",
        "a valid profile selection proceeds to the owner lookup without creating it"
    );
    assert!(
        !owner_directory(&fixture.state, "managed_goal", goal_id).exists(),
        "a valid Task pin must not allocate a nonexistent Goal"
    );

    let mut missing_selection = base.clone();
    if let Value::Map(fields) = &mut missing_selection {
        fields.remove("profileSelection");
    }
    assert_eq!(
        error_code(&fixture.send(
            "add_task",
            missing_selection,
            Some("missing-profile-selection"),
        )),
        "invalid_effect_request"
    );

    let mut malformed_revision = base.clone();
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
        error_code(&fixture.send(
            "add_task",
            malformed_revision,
            Some("noncanonical-profile-revision"),
        )),
        "invalid_effect_request"
    );

    let mut mismatched_profile = base.clone();
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
        error_code(&fixture.send(
            "add_task",
            mismatched_profile,
            Some("profile-revision-mismatch"),
        )),
        "invalid_effect_request"
    );

    let mut unsupported_source = base.clone();
    if let Value::Map(fields) = &mut unsupported_source {
        let Some(Value::Map(profile)) = fields.get_mut("profileDefinition") else {
            panic!("profile definition must be a map");
        };
        profile.insert("source".to_owned(), string("project"));
    }
    assert_eq!(
        error_code(&fixture.send(
            "add_task",
            unsupported_source,
            Some("unsupported-profile-source"),
        )),
        "invalid_effect_request",
        "project/plugin profile sources have no authenticated owner adapter"
    );
    assert!(
        !owner_directory(&fixture.state, "managed_goal", goal_id).exists(),
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
    let mut fixture = Fixture::new();

    // Capability aliases/unknown IDs are rejected before resolving a Goal or
    // allocating its OwnerLog.
    let mut noncanonical_scope = goal_proposal_body("goal-capability-alias", SPEC);
    if let Value::Map(fields) = &mut noncanonical_scope {
        fields.insert("capabilityScope".to_owned(), strings(&["terminal.exec"]));
    }
    assert_eq!(
        error_code(&fixture.send(
            "create_goal_proposal",
            noncanonical_scope,
            Some("noncanonical-capability-scope"),
        )),
        "invalid_managed_request"
    );
    assert!(
        !owner_directory(&fixture.state, "managed_goal", "goal-capability-alias").exists(),
        "unknown capability IDs must fail before OwnerLog allocation"
    );

    // A Goal that was never created is NOT_FOUND for every plan step and allocates
    // no durable owner state.
    let forged_goal = map([
        ("goalID", string("goal-forged")),
        ("runID", string(RUN)),
        ("taskID", string(TASK)),
        ("dependencies", Value::Array(vec![])),
        ("criterionIDs", Value::Array(vec![])),
        ("requiredCapabilities", Value::Array(vec![])),
        ("profileSelection", profile_selection()),
        ("profileDefinition", profile_definition()),
    ]);
    assert_eq!(
        error_code(&fixture.send("add_task", forged_goal.clone(), Some("forged-task"))),
        "managed_not_found"
    );
    let mut forged_capability = forged_goal;
    if let Value::Map(fields) = &mut forged_capability {
        fields.insert(
            "requiredCapabilities".to_owned(),
            strings(&["files.write.alias"]),
        );
    }
    assert_eq!(
        error_code(&fixture.send("add_task", forged_capability, Some("forged-capability"),)),
        "invalid_managed_request"
    );
    assert!(
        !owner_directory(&fixture.state, "managed_goal", "goal-forged").exists(),
        "unknown Task capability IDs must fail before Goal owner allocation"
    );
    assert_eq!(
        error_code(&fixture.send(
            "start_run",
            map([
                ("goalID", string("goal-forged")),
                ("runID", string(RUN)),
                ("specID", string(SPEC)),
            ]),
            Some("forged-run"),
        )),
        "managed_not_found"
    );
    assert_eq!(
        error_code(&fixture.send_as(
            REVIEWER,
            "accept_spec",
            map([
                ("goalID", string("goal-forged")),
                ("specID", string(SPEC)),
                ("specDigest", string(&sha('a'))),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("forged-spec"),
        )),
        "managed_not_found"
    );
    assert!(
        !owner_directory(&fixture.state, "managed_goal", "goal-forged").exists(),
        "a forged Goal must not allocate durable owner state"
    );

    // A valid atomic proposal creates the Goal; an unknown SpecVersion is a
    // typed conflict, not a partial write.
    ok_body(fixture.send(
        "create_goal_proposal",
        goal_proposal_body(GOAL, SPEC),
        Some("goal-spec-1"),
    ));
    assert_eq!(
        error_code(&fixture.send_as(
            REVIEWER,
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string("spec-absent")),
                ("specDigest", string(&format!("blake3:{}", "a".repeat(64)))),
                ("expectedRevision", Value::Unsigned(1)),
            ]),
            Some("accept-absent"),
        )),
        "managed_conflict"
    );
    let snapshot = ok_body(fixture.send("snapshot", map([("goalID", string(GOAL))]), None));
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
    let mut fixture = Fixture::new();
    let digest = seed_proposed_run(&mut fixture);
    ok_body(fixture.send_as(
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
    // A Run must use the accepted active SpecVersion.
    assert_eq!(
        error_code(&fixture.send(
            "start_run",
            map([
                ("goalID", string(GOAL)),
                ("runID", string("run-other")),
                ("specID", string("spec-other")),
            ]),
            Some("run-other"),
        )),
        "managed_conflict"
    );
    ok_body(fixture.send(
        "start_run",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("specID", string(SPEC)),
        ]),
        Some("run-1"),
    ));

    let mut missing_task_capabilities = map([
        ("goalID", string(GOAL)),
        ("runID", string(RUN)),
        ("taskID", string("task-missing-capabilities")),
        ("dependencies", Value::Array(vec![])),
        ("criterionIDs", strings(&["tests-pass"])),
        ("requiredCapabilities", Value::Array(vec![])),
        ("profileSelection", profile_selection()),
        ("profileDefinition", profile_definition()),
    ]);
    if let Value::Map(fields) = &mut missing_task_capabilities {
        fields.remove("requiredCapabilities");
    }
    assert_eq!(
        error_code(&fixture.send(
            "add_task",
            missing_task_capabilities,
            Some("task-missing-capabilities"),
        )),
        "invalid_effect_request"
    );

    // A criterion outside the accepted SpecVersion is refused.
    assert_eq!(
        error_code(&fixture.send(
            "add_task",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string("task-bad-criterion")),
                ("dependencies", Value::Array(vec![])),
                ("criterionIDs", strings(&["invented-criterion"])),
                ("requiredCapabilities", Value::Array(vec![])),
                ("profileSelection", profile_selection()),
                ("profileDefinition", profile_definition()),
            ]),
            Some("task-bad-criterion"),
        )),
        "managed_conflict"
    );
    // A dependency on a Task that does not exist is refused.
    assert_eq!(
        error_code(&fixture.send(
            "add_task",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string("task-bad-dependency")),
                ("dependencies", strings(&["task-absent"])),
                ("criterionIDs", strings(&["tests-pass"])),
                ("requiredCapabilities", Value::Array(vec![])),
                ("profileSelection", profile_selection()),
                ("profileDefinition", profile_definition()),
            ]),
            Some("task-bad-dependency"),
        )),
        "managed_conflict"
    );

    ok_body(fixture.send(
        "add_task",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string(TASK)),
            ("dependencies", Value::Array(vec![])),
            ("criterionIDs", strings(&["tests-pass"])),
            ("requiredCapabilities", Value::Array(vec![])),
            ("profileSelection", profile_selection()),
            ("profileDefinition", profile_definition()),
        ]),
        Some("task-1"),
    ));
    // A Task that depends on an unverified Task cannot become ready.
    ok_body(fixture.send(
        "add_task",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("taskID", string("task-dependent")),
            ("dependencies", strings(&[TASK])),
            ("criterionIDs", strings(&["docs-match"])),
            ("requiredCapabilities", Value::Array(vec![])),
            ("profileSelection", profile_selection()),
            ("profileDefinition", profile_definition()),
        ]),
        Some("task-dependent"),
    ));
    assert_eq!(
        error_code(&fixture.send(
            "mark_task_ready",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string("task-dependent")),
            ]),
            Some("ready-dependent"),
        )),
        "managed_conflict"
    );
    // Reusing a Task id is refused even for a fresh key.
    assert_eq!(
        error_code(&fixture.send(
            "add_task",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(TASK)),
                ("dependencies", Value::Array(vec![])),
                ("criterionIDs", strings(&["tests-pass"])),
                ("requiredCapabilities", Value::Array(vec![])),
                ("profileSelection", profile_selection()),
                ("profileDefinition", profile_definition()),
            ]),
            Some("task-1-again"),
        )),
        "managed_conflict"
    );

    // The accepted SpecVersion budget is enforced by the state machine: the focused
    // chain accepts at most eight Tasks, and the ninth fails closed.
    let mut fixture = Fixture::new();
    let digest = seed_proposed_run(&mut fixture);
    ok_body(fixture.send_as(
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
    ok_body(fixture.send(
        "start_run",
        map([
            ("goalID", string(GOAL)),
            ("runID", string(RUN)),
            ("specID", string(SPEC)),
        ]),
        Some("run-1"),
    ));
    for index in 1..=8 {
        ok_body(fixture.send(
            "add_task",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string(&format!("task-budget-{index}"))),
                ("dependencies", Value::Array(vec![])),
                ("criterionIDs", strings(&["tests-pass"])),
                ("requiredCapabilities", Value::Array(vec![])),
                ("profileSelection", profile_selection()),
                ("profileDefinition", profile_definition()),
            ]),
            Some(&format!("task-budget-{index}")),
        ));
    }
    assert_eq!(
        error_code(&fixture.send(
            "add_task",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("taskID", string("task-budget-overflow")),
                ("dependencies", Value::Array(vec![])),
                ("criterionIDs", strings(&["tests-pass"])),
                ("requiredCapabilities", Value::Array(vec![])),
                ("profileSelection", profile_selection()),
                ("profileDefinition", profile_definition()),
            ]),
            Some("task-budget-overflow"),
        )),
        "managed_conflict"
    );
}

#[test]
fn plan_ingress_rejects_a_rejected_spec_and_keeps_goals_isolated() {
    let mut fixture = Fixture::new();
    let digest = seed_proposed_run(&mut fixture);

    let rejected = ok_body(fixture.send_as(
        REVIEWER,
        "reject_spec",
        map([
            ("goalID", string(GOAL)),
            ("specID", string(SPEC)),
            ("specDigest", string(&digest)),
            ("expectedRevision", Value::Unsigned(2)),
        ]),
        Some("reject-1"),
    ));
    assert_eq!(field_text(&rejected, "status"), "REJECTED");
    assert_eq!(field_text(&rejected, "rejectedBy"), REVIEWER);
    assert_eq!(field_unsigned(&rejected, "revision"), 3);
    // A rejected SpecVersion is immutable: it can no longer be accepted or started.
    assert_eq!(
        error_code(&fixture.send_as(
            REVIEWER,
            "accept_spec",
            map([
                ("goalID", string(GOAL)),
                ("specID", string(SPEC)),
                ("specDigest", string(&digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ]),
            Some("accept-after-reject"),
        )),
        "managed_conflict"
    );
    assert_eq!(
        error_code(&fixture.send(
            "start_run",
            map([
                ("goalID", string(GOAL)),
                ("runID", string(RUN)),
                ("specID", string(SPEC)),
            ]),
            Some("run-after-reject"),
        )),
        "managed_conflict"
    );

    // A second Goal has its own atomic proposal and durable revision.
    let mut second_proposal = goal_proposal_body("goal-second", "spec-second");
    if let Value::Map(fields) = &mut second_proposal {
        fields.insert("objective".to_owned(), string("Independent goal"));
    }
    let other = ok_body(fixture.send("create_goal_proposal", second_proposal, Some("goal-second")));
    assert_eq!(field_unsigned(&other, "revision"), 1);
    let snapshot =
        ok_body(fixture.send("snapshot", map([("goalID", string("goal-second"))]), None));
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
    assert_eq!(
        error_code(&same_uid_verifier),
        "independent_verifier_required"
    );
    let final_snapshot = ok_body(socket_roundtrip(
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
    assert_eq!(field_unsigned(&final_snapshot, "revision"), 3);

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
    let registered = socket_roundtrip_as(
        &mut first_stream,
        location_request,
        Some("reviewer"),
    );
    assert_eq!(registered.outcome, RpcOutcomeV1::Ok, "{:?}", registered.error);

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
                (
                    "idempotencyKey",
                    string("lifecycle-start-planned-run"),
                ),
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
                        ("redactionProfile", string("horizon.session-link.ids-only.v1")),
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
