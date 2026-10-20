#![cfg(target_os = "linux")]

use horizoncode_kernel::host_kernel::{EXECUTION_SERVICE_ID, TERMINAL_SERVICE_ID};
use horizoncode_kernel::managed_control::{
    AcceptanceCriterion, GoalDraft, ManagedCommand, ManagedControl, SpecBudget, SpecVersionDraft,
};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{
    AuthenticatedPrincipalV1, AuthenticatedRequestContextV1, FEATURE_EFFECTS_V2,
    FEATURE_REPO_INTEL_READ_CONTEXT_V1, KernelHelloV1, KernelStartupStatusV1, RpcMessageV1,
    RpcOutcomeV1, RpcRequestV1, RpcResponseV1, read_message, write_message,
};
use horizoncode_kernel::unix_peer::{
    AuthenticatedUnixStream, UnixPeerPolicy, connect_authenticated,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Service identifier of the authenticated managed-control ingress.
const MANAGED_SERVICE_ID: &str = "managed.v1";
const MANAGED_GOAL: &str = "goal-process";

static NEXT: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hz-kernel-process-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct TestProcess(Child);

impl Drop for TestProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn value_map<const N: usize>(items: [(&str, Value); N]) -> Value {
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
            .unwrap_or_else(|| panic!("response field {key} is missing")),
        other => panic!("expected a response map, found {other:?}"),
    }
}

fn field_text<'a>(value: &'a Value, key: &str) -> &'a str {
    match field(value, key) {
        Value::String(text) => text,
        other => panic!("response field {key} is not a string: {other:?}"),
    }
}

fn field_unsigned(value: &Value, key: &str) -> u64 {
    match field(value, key) {
        Value::Unsigned(number) => *number,
        other => panic!("response field {key} is not an unsigned integer: {other:?}"),
    }
}

fn request_for_socket(
    owner_epoch: u64,
    incarnation: &str,
    service_id: &str,
    operation: &str,
    request_id: &str,
    body: Value,
    deadline_unix_ms: u64,
) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch,
        process_incarnation: incarnation.to_owned(),
        request_id: request_id.to_owned(),
        service_id: service_id.to_owned(),
        operation: operation.to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms,
        trace_id: format!("trace_{request_id}"),
        body,
    }
}

fn timestamp_unix_ms(value: u64) -> String {
    let seconds = (value / 1000) as i64;
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60,
        value % 1000
    )
}

/// Seeds one durable managed Goal exactly as the internal plan-ingress writer does,
/// before the kernel process starts. The RPC never creates Goal state itself.
fn seed_managed_goal(state: &Path) {
    let mut control = ManagedControl::open(&state.join("managed-control"), MANAGED_GOAL).unwrap();
    let mut send = |delivery: &str, command: ManagedCommand| {
        let revision = control.snapshot().revision;
        control.apply(revision, delivery, command).unwrap();
    };
    send(
        "goal-1",
        ManagedCommand::CreateGoal {
            goal: GoalDraft {
                objective: "Complete the managed task".to_owned(),
                project_ref: "project-one".to_owned(),
                workspace_ref: "workspace-one".to_owned(),
                created_by: "server_auth:author".to_owned(),
            },
        },
    );
    let draft = SpecVersionDraft {
        parent_version_id: None,
        objective: "Complete the managed task without changing unrelated files".to_owned(),
        project_ref: "project-one".to_owned(),
        workspace_ref: "workspace-one".to_owned(),
        capability_scope: vec![],
        scope: vec!["kernel/src/**".to_owned()],
        constraints: vec!["Preserve user-owned changes".to_owned()],
        criteria: vec![AcceptanceCriterion {
            id: "tests-pass".to_owned(),
            description: "The focused Rust tests pass".to_owned(),
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
        source_digests: vec![format!("sha256:{}", "a".repeat(64))],
        proposed_by: "server_auth:author".to_owned(),
    };
    let digest = draft.digest();
    send(
        "spec-1",
        ManagedCommand::ProposeSpec {
            spec_id: "spec-v1".to_owned(),
            spec: draft,
            spec_digest: digest.clone(),
        },
    );
    send(
        "assign-reviewer-1",
        ManagedCommand::AssignSpecReviewer {
            spec_id: "spec-v1".to_owned(),
            spec_digest: digest.clone(),
            reviewer_id: "server_auth:reviewer".to_owned(),
        },
    );
    send(
        "accept-1",
        ManagedCommand::AcceptSpec {
            spec_id: "spec-v1".to_owned(),
            spec_digest: digest,
            accepted_by: "server_auth:reviewer".to_owned(),
            accepted_at_ms: 1,
        },
    );
    send(
        "run-1",
        ManagedCommand::StartRun {
            run_id: "run-v1".to_owned(),
            spec_id: "spec-v1".to_owned(),
        },
    );
    send(
        "task-1",
        ManagedCommand::AddTask {
            run_id: "run-v1".to_owned(),
            task_id: "task-v1".to_owned(),
            dependencies: vec![],
            criterion_ids: vec!["tests-pass".to_owned()],
            required_capabilities: vec![],
        },
    );
    send(
        "ready-1",
        ManagedCommand::MarkTaskReady {
            run_id: "run-v1".to_owned(),
            task_id: "task-v1".to_owned(),
        },
    );
}

#[test]
fn hz_kernel_authenticates_core_fences_rpc_and_reaches_ready_after_recovery() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    let socket = state.join("hz-kernel.sock");
    // The host owner authenticates the Core peer; this test process plays Core, so the
    // kernel is launched with this test executable and the client pins the kernel binary.
    let core_exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let kernel_exe = fs::canonicalize(env!("CARGO_BIN_EXE_hz-kernel")).unwrap();
    let nonce = "host-process-test-nonce";
    let incarnation = "inc_host_process_test";
    let mut child = TestProcess(
        Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
            .arg(format!("--state-dir={}", state.display()))
            .arg(format!("--socket={}", socket.display()))
            .arg(format!("--host-exe={}", core_exe.display()))
            .arg(format!("--nonce={nonce}"))
            .arg(format!("--incarnation={incarnation}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );

    (|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !socket.exists() {
            if child.0.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                panic!("hz-kernel did not create its private socket");
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
        let hello = KernelHelloV1 {
            min_protocol: 1,
            max_protocol: 1,
            host_build_digest: format!("blake3:{}", "a".repeat(64)),
            kernel_build_digest: None,
            host_instance_id: "host_process_test".to_owned(),
            process_incarnation: incarnation.to_owned(),
            supervisor_nonce: nonce.to_owned(),
            required_features: vec![FEATURE_EFFECTS_V2.to_owned()],
            optional_features: Vec::new(),
        };
        write_message(&mut stream, &RpcMessageV1::Hello(Box::new(hello))).unwrap();
        let Some(RpcMessageV1::HelloResult(negotiated)) = read_message(&mut stream).unwrap() else {
            panic!("expected fenced host hello result");
        };
        assert!(
            negotiated
                .enabled_features
                .contains(&FEATURE_EFFECTS_V2.to_owned())
        );
        assert!(negotiated.owner_epoch > 0);
        let mut ready = false;
        for _ in 0..16 {
            match read_message(&mut stream).unwrap().unwrap() {
                RpcMessageV1::StartupStatus(status) if *status == KernelStartupStatusV1::Ready => {
                    ready = true;
                    break;
                }
                RpcMessageV1::StartupStatus(status)
                    if *status == KernelStartupStatusV1::Starting => {}
                other => panic!("unexpected startup frame before READY: {other:?}"),
            }
        }
        assert!(ready, "hz-kernel did not reach READY");

        let request = RpcRequestV1 {
            owner_epoch: negotiated.owner_epoch,
            process_incarnation: incarnation.to_owned(),
            request_id: "req_process_register_location".to_owned(),
            service_id: FEATURE_EFFECTS_V2.to_owned(),
            operation: "register_location".to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 30_000,
            trace_id: "trace_process_register_location".to_owned(),
            body: value_map([("canonicalRoot", string(state.to_str().unwrap()))]),
        };
        let response = roundtrip_server_auth(&mut stream, request, "process-test-user");
        assert_eq!(response.outcome, RpcOutcomeV1::Ok);
        assert_eq!(response.owner_epoch, negotiated.owner_epoch);
        assert_eq!(response.process_incarnation, incarnation);
        assert_eq!(response.request_id, "req_process_register_location");
    })();
}

#[test]
fn host_build_digest_cli_reports_a_canonical_digest_without_runtime_state() {
    let directory = TestDir::new();
    let host = directory.0.join("host executable");
    fs::write(&host, b"host artifact bytes").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
        .arg(format!("--digest-host-executable={}", host.display()))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("blake3:{}", blake3::hash(b"host artifact bytes").to_hex())
    );
    // The observer invocation must not create sockets, lease files, or state directories.
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);

    let combined = Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
        .arg(format!("--digest-host-executable={}", host.display()))
        .arg("--nonce=nonce")
        .output()
        .unwrap();
    assert!(!combined.status.success());
    assert!(combined.stdout.is_empty());

    let missing = Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
        .arg(format!(
            "--digest-host-executable={}",
            directory.0.join("absent").display()
        ))
        .output()
        .unwrap();
    assert!(!missing.status.success());
    assert!(missing.stdout.is_empty());
    assert!(missing.stderr.len() <= 1024);

    let alias = directory.0.join("host alias");
    std::os::unix::fs::symlink(&host, &alias).unwrap();
    let aliased = Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
        .arg(format!("--digest-host-executable={}", alias.display()))
        .output()
        .unwrap();
    assert!(!aliased.status.success());
    assert!(aliased.stdout.is_empty());
}

/// Sends one request over the authenticated stream and returns its response.
fn roundtrip(stream: &mut AuthenticatedUnixStream, request: RpcRequestV1) -> RpcResponseV1 {
    let request_id = request.request_id.clone();
    write_message(stream, &RpcMessageV1::Request(Box::new(request))).unwrap();
    match read_message(stream).unwrap() {
        Some(RpcMessageV1::Response(response)) => *response,
        Some(other) => panic!("expected host RPC response for {request_id}, got {other:?}"),
        None => panic!("host closed IPC before response for {request_id}"),
    }
}

/// Sends one request with identity delegated by the authenticated Core channel,
/// never by operation JSON.
fn roundtrip_server_auth(
    stream: &mut AuthenticatedUnixStream,
    request: RpcRequestV1,
    subject: &str,
) -> RpcResponseV1 {
    roundtrip_server_auth_context(stream, request, subject, None)
}

fn roundtrip_server_auth_context(
    stream: &mut AuthenticatedUnixStream,
    request: RpcRequestV1,
    subject: &str,
    context: Option<AuthenticatedRequestContextV1>,
) -> RpcResponseV1 {
    let request_id = request.request_id.clone();
    write_message(
        stream,
        &RpcMessageV1::AuthenticatedRequest {
            request: Box::new(request),
            principal: AuthenticatedPrincipalV1::ServerAuth {
                subject: subject.to_owned(),
            },
            context,
        },
    )
    .unwrap();
    match read_message(stream).unwrap() {
        Some(RpcMessageV1::Response(response)) => *response,
        Some(other) => panic!("expected host RPC response for {request_id}, got {other:?}"),
        None => panic!("host closed IPC before response for {request_id}"),
    }
}

/// Starts one hz-kernel process against `state`, negotiates a fence on a fresh socket
/// and returns the process, the authenticated stream and the owner epoch.
fn start_kernel(
    state: &Path,
    socket_name: &str,
    nonce: &str,
    incarnation: &str,
    enable_effects: bool,
) -> (TestProcess, AuthenticatedUnixStream, u64) {
    start_kernel_with_features(
        state,
        socket_name,
        nonce,
        incarnation,
        enable_effects,
        false,
    )
}

fn start_kernel_with_features(
    state: &Path,
    socket_name: &str,
    nonce: &str,
    incarnation: &str,
    enable_effects: bool,
    enable_repo_intel: bool,
) -> (TestProcess, AuthenticatedUnixStream, u64) {
    let socket = state.join(socket_name);
    let core_exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let kernel_exe = fs::canonicalize(env!("CARGO_BIN_EXE_hz-kernel")).unwrap();
    let child = TestProcess(
        Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
            .arg(format!("--state-dir={}", state.display()))
            .arg(format!("--socket={}", socket.display()))
            .arg(format!("--host-exe={}", core_exe.display()))
            .arg(format!("--nonce={nonce}"))
            .arg(format!("--incarnation={incarnation}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(if nonce.starts_with("stdio-execution") {
                Stdio::inherit()
            } else {
                Stdio::null()
            })
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() {
        if Instant::now() >= deadline {
            panic!("hz-kernel did not create its private socket");
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
    let hello = KernelHelloV1 {
        min_protocol: 1,
        max_protocol: 1,
        host_build_digest: format!("blake3:{}", "e".repeat(64)),
        kernel_build_digest: None,
        host_instance_id: format!("host_{nonce}"),
        process_incarnation: incarnation.to_owned(),
        supervisor_nonce: nonce.to_owned(),
        required_features: if enable_effects {
            vec![FEATURE_EFFECTS_V2.to_owned()]
        } else {
            Vec::new()
        },
        optional_features: if enable_repo_intel {
            vec![FEATURE_REPO_INTEL_READ_CONTEXT_V1.to_owned()]
        } else {
            Vec::new()
        },
    };
    write_message(&mut stream, &RpcMessageV1::Hello(Box::new(hello))).unwrap();
    let Some(RpcMessageV1::HelloResult(negotiated)) = read_message(&mut stream).unwrap() else {
        panic!("expected fenced host hello result");
    };
    if enable_repo_intel {
        assert!(
            negotiated
                .enabled_features
                .contains(&FEATURE_REPO_INTEL_READ_CONTEXT_V1.to_owned()),
            "RepoIntel read context must negotiate only when the host backend is ready"
        );
    }
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

#[test]
fn authenticated_socket_repo_intel_binds_generation_and_fails_closed() {
    let directory = TestDir::new();
    let state = directory.0.join("repo-state");
    let workspace = directory.0.join("repo-workspace");
    fs::create_dir(&state).unwrap();
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(workspace.join("readme.txt"), "base source\n").unwrap();
    let state = fs::canonicalize(state).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let incarnation = "inc_repo_intel_process_1";
    let (child, mut stream, owner_epoch) = start_kernel_with_features(
        &state,
        "hz-repo-intel.sock",
        "repo-intel-process-nonce",
        incarnation,
        true,
        true,
    );
    let deadline_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 20_000;
    let deadline = timestamp_unix_ms(deadline_unix_ms);
    let body = |request_id: &str| {
        value_map([
            ("schemaVersion", Value::Unsigned(1)),
            ("messageType", string("ensure_generation")),
            ("requestId", string(request_id)),
            ("rootRef", string(".")),
            ("maxFiles", Value::Unsigned(32)),
            ("maxBytes", Value::Unsigned(1_048_576)),
            ("maxFileBytes", Value::Unsigned(262_144)),
            ("deadline", string(&deadline)),
        ])
    };
    let context_for = |location_id: &str| AuthenticatedRequestContextV1::RepoRead {
        session_id: "ses_repo_intel_socket".to_owned(),
        location_id: location_id.to_owned(),
    };
    let register = roundtrip_server_auth_context(
        &mut stream,
        request_for_socket(
            owner_epoch,
            incarnation,
            FEATURE_EFFECTS_V2,
            "register_location",
            "repo_register_location",
            value_map([("canonicalRoot", string(workspace.to_str().unwrap()))]),
            deadline_unix_ms,
        ),
        "repo-intel-owner",
        None,
    );
    assert_eq!(register.outcome, RpcOutcomeV1::Ok, "{:?}", register.error);
    let location_id = field_text(register.body.as_ref().unwrap(), "locationID").to_owned();
    let context = context_for(&location_id);

    let foreign_owner = roundtrip_server_auth_context(
        &mut stream,
        request_for_socket(
            owner_epoch,
            incarnation,
            "repo-intel.v1",
            "ensure_generation",
            "repo_foreign_owner",
            body("repo_foreign_owner"),
            deadline_unix_ms,
        ),
        "repo-intel-foreign",
        Some(context.clone()),
    );
    assert_eq!(foreign_owner.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        foreign_owner.error.as_ref().unwrap().code,
        "location_owner_conflict"
    );

    let pin = roundtrip_server_auth_context(
        &mut stream,
        request_for_socket(
            owner_epoch,
            incarnation,
            "repo-intel.v1",
            "ensure_generation",
            "repo_ensure_generation",
            body("repo_generation_1"),
            deadline_unix_ms,
        ),
        "repo-intel-owner",
        Some(context.clone()),
    );
    assert_eq!(pin.outcome, RpcOutcomeV1::Ok, "{:?}", pin.error);
    let generation = field_text(pin.body.as_ref().unwrap(), "sourceGeneration").to_owned();
    assert!(!generation.is_empty());

    let query_body = |overlay_ref: Option<&str>| {
        let mut fields = vec![
            ("schemaVersion", Value::Unsigned(1)),
            ("messageType", string("query")),
            ("queryId", string("repo_generation_1")),
            ("rootRef", string(".")),
            ("sourceGeneration", string(&generation)),
            (
                "selector",
                value_map([
                    ("symbols", Value::Array(Vec::new())),
                    ("includeCallers", Value::Bool(true)),
                ]),
            ),
            ("maxNodes", Value::Unsigned(10)),
            ("maxBytes", Value::Unsigned(4096)),
            ("maxDepth", Value::Unsigned(4)),
            ("deadline", string(&deadline)),
        ];
        if let Some(overlay_ref) = overlay_ref {
            fields.push(("overlayRef", string(overlay_ref)));
        }
        Value::Map(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        )
    };
    let query = |stream: &mut AuthenticatedUnixStream, id: &str, overlay_ref: Option<&str>| {
        roundtrip_server_auth_context(
            stream,
            request_for_socket(
                owner_epoch,
                incarnation,
                "repo-intel.v1",
                "query_structure",
                id,
                query_body(overlay_ref),
                deadline_unix_ms,
            ),
            "repo-intel-owner",
            Some(context.clone()),
        )
    };

    let source = workspace.join("readme.txt");
    let hidden_source = workspace.join("readme.txt.overlay-denial-test");
    fs::rename(&source, &hidden_source).unwrap();
    let overlay_denied = query(
        &mut stream,
        "repo_overlay_denied",
        Some("ovl_0123456789abcdef"),
    );
    assert_eq!(overlay_denied.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        overlay_denied.error.as_ref().unwrap().code,
        "capability_unavailable"
    );
    fs::rename(&hidden_source, &source).unwrap();

    let page = query(&mut stream, "repo_query_page", None);
    assert_eq!(page.outcome, RpcOutcomeV1::Ok, "{:?}", page.error);
    let page_body = page.body.as_ref().unwrap();
    assert_eq!(field_text(page_body, "status"), "UNAVAILABLE");
    assert_eq!(field_text(page_body, "freshness"), "unknown");
    assert_eq!(field_text(page_body, "completeness"), "unavailable");
    assert_eq!(field_text(page_body, "sourceKind"), "none");
    assert!(matches!(field(page_body, "nodes"), Value::Array(nodes) if nodes.is_empty()));

    fs::write(&source, "changed source\n").unwrap();
    let stale = query(&mut stream, "repo_query_stale", None);
    assert_eq!(stale.outcome, RpcOutcomeV1::Error);
    assert_eq!(stale.error.as_ref().unwrap().code, "stale_repo_generation");
    drop(stream);
    drop(child);

    let (_child, mut unnegotiated_stream, unnegotiated_epoch) = start_kernel(
        &state,
        "hz-repo-intel-unnegotiated.sock",
        "repo-intel-unnegotiated-nonce",
        "inc_repo_intel_process_2",
        false,
    );
    let unnegotiated = roundtrip_server_auth_context(
        &mut unnegotiated_stream,
        request_for_socket(
            unnegotiated_epoch,
            "inc_repo_intel_process_2",
            "repo-intel.v1",
            "ensure_generation",
            "repo_not_negotiated",
            body("repo_not_negotiated"),
            deadline_unix_ms,
        ),
        "repo-intel-owner",
        Some(context),
    );
    assert_eq!(unnegotiated.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        unnegotiated.error.as_ref().unwrap().code,
        "feature_not_negotiated"
    );
}

/// Real-socket plan ingress plus a Goal-less direct subagent Attempt: Goal creation
/// and SpecVersion review over the authenticated boundary, self-approval refusal for
/// the single uid principal, one-use Attempt admission/settlement, and a restart
/// boundary that records the in-flight Attempt UNKNOWN.
#[test]
fn authenticated_socket_serves_plan_ingress_and_direct_attempts_with_restart_recovery() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&state).unwrap();
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let (mut child, mut stream, owner_epoch) = start_kernel(
        &state,
        "hz-direct.sock",
        "direct-process-nonce",
        "inc_direct_process_1",
        true,
    );
    let incarnation = "inc_direct_process_1";

    (|| {
        let request =
            |operation: &str, body: Value, delivery: Option<&str>, id: &str| RpcRequestV1 {
                owner_epoch,
                process_incarnation: incarnation.to_owned(),
                request_id: id.to_owned(),
                service_id: MANAGED_SERVICE_ID.to_owned(),
                operation: operation.to_owned(),
                delivery_id: delivery.map(str::to_owned),
                expected_cursor: None,
                deadline_unix_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 30_000,
                trace_id: format!("trace_{operation}"),
                body,
            };

        let registered_location = roundtrip(
            &mut stream,
            RpcRequestV1 {
                owner_epoch,
                process_incarnation: incarnation.to_owned(),
                request_id: "req_register_direct_workspace".to_owned(),
                service_id: FEATURE_EFFECTS_V2.to_owned(),
                operation: "register_location".to_owned(),
                delivery_id: None,
                expected_cursor: None,
                deadline_unix_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 30_000,
                trace_id: "trace_register_direct_workspace".to_owned(),
                body: value_map([
                    ("canonicalRoot", string(workspace.to_str().unwrap())),
                    ("workspaceID", string("workspace-process")),
                ]),
            },
        );
        assert_eq!(
            registered_location.outcome,
            RpcOutcomeV1::Ok,
            "{:?}",
            registered_location.error
        );
        let location_id =
            field_text(registered_location.body.as_ref().unwrap(), "locationID").to_owned();

        // The authenticated principal of this real connection is the peer uid.
        let created = roundtrip(
            &mut stream,
            request(
                "create_goal",
                value_map([
                    ("goalID", string("goal-direct-process")),
                    ("objective", string("Ingress-created goal")),
                    ("projectRef", string("project-one")),
                    ("workspaceRef", string("workspace-one")),
                ]),
                Some("goal-direct-1"),
                "req_create_goal",
            ),
        );
        assert_eq!(created.outcome, RpcOutcomeV1::Ok, "{:?}", created.error);
        let created = created.body.unwrap();
        assert_eq!(field_text(&created, "status"), "CREATED");
        assert_eq!(field_unsigned(&created, "revision"), 1);
        assert_eq!(
            field_text(&created, "createdBy"),
            format!("host_os_uid:{}", unsafe { libc::geteuid() })
        );

        let proposed = roundtrip(
            &mut stream,
            request(
                "propose_spec",
                value_map([
                    ("goalID", string("goal-direct-process")),
                    ("specID", string("spec-direct-process")),
                    ("objective", string("Ingress-created spec")),
                    ("projectRef", string("project-one")),
                    ("workspaceRef", string("workspace-one")),
                    ("capabilityScope", Value::Array(vec![])),
                    ("scope", Value::Array(vec![string("kernel/src/**")])),
                    (
                        "constraints",
                        Value::Array(vec![string("No unrelated files")]),
                    ),
                    (
                        "criteria",
                        Value::Array(vec![value_map([
                            ("id", string("tests-pass")),
                            ("description", string("Focused tests pass")),
                        ])]),
                    ),
                    (
                        "budget",
                        value_map([
                            ("maxTasks", Value::Unsigned(4)),
                            ("maxAttemptsPerTask", Value::Unsigned(1)),
                            ("maxRunDurationMs", Value::Unsigned(60_000)),
                            ("maxMemoryBytes", Value::Nil),
                            ("maxDiskBytes", Value::Nil),
                            ("maxWorkers", Value::Unsigned(1)),
                            ("maxTokens", Value::Nil),
                            ("maxCostMicros", Value::Nil),
                        ]),
                    ),
                    (
                        "sourceDigests",
                        Value::Array(vec![string(&format!("sha256:{}", "a".repeat(64)))]),
                    ),
                ]),
                Some("spec-direct-1"),
                "req_propose_spec",
            ),
        );
        assert_eq!(proposed.outcome, RpcOutcomeV1::Ok, "{:?}", proposed.error);
        let proposed = proposed.body.unwrap();
        let digest = field_text(&proposed, "specDigest").to_owned();
        assert!(digest.starts_with("blake3:"));

        // The single uid principal is also the author, so approving the SpecVersion
        // over this connection stays refused by the state machine.
        let self_accept = roundtrip(
            &mut stream,
            request(
                "accept_spec",
                value_map([
                    ("goalID", string("goal-direct-process")),
                    ("specID", string("spec-direct-process")),
                    ("specDigest", string(&digest)),
                    ("expectedRevision", Value::Unsigned(2)),
                    ("principal", value_map([("source", string("host_os"))])),
                ]),
                Some("accept-direct-1"),
                "req_accept_spec",
            ),
        );
        assert_eq!(self_accept.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            self_accept.error.as_ref().unwrap().code.as_str(),
            "independent_verifier_required"
        );

        // On the authenticated Core channel, the identity delegated by HTTP
        // ServerAuth middleware claims the reviewer slot and decides at the
        // resulting exact aggregate revision. Public request bodies never supply
        // this field; the adjacent HTTP middleware test proves its source.
        let assigned = roundtrip(
            &mut stream,
            request(
                "assign_spec_reviewer",
                value_map([
                    ("goalID", string("goal-direct-process")),
                    ("specID", string("spec-direct-process")),
                    ("specDigest", string(&digest)),
                    ("expectedRevision", Value::Unsigned(2)),
                    (
                        "principal",
                        value_map([
                            ("source", string("server_auth")),
                            ("username", string("reviewer")),
                        ]),
                    ),
                ]),
                Some("claim-direct-reviewer"),
                "req_assign_reviewer",
            ),
        );
        assert_eq!(assigned.outcome, RpcOutcomeV1::Ok, "{:?}", assigned.error);
        let assigned = assigned.body.unwrap();
        assert_eq!(field_text(&assigned, "reviewerID"), "server_auth:reviewer");
        assert_eq!(field_unsigned(&assigned, "decisionRevision"), 3);

        let accepted = roundtrip(
            &mut stream,
            request(
                "accept_spec",
                value_map([
                    ("goalID", string("goal-direct-process")),
                    ("specID", string("spec-direct-process")),
                    ("specDigest", string(&digest)),
                    ("expectedRevision", Value::Unsigned(3)),
                    (
                        "principal",
                        value_map([
                            ("source", string("server_auth")),
                            ("username", string("reviewer")),
                        ]),
                    ),
                ]),
                Some("accept-direct-reviewer"),
                "req_accept_reviewer",
            ),
        );
        assert_eq!(accepted.outcome, RpcOutcomeV1::Ok, "{:?}", accepted.error);
        assert_eq!(
            field_text(accepted.body.as_ref().unwrap(), "acceptedBy"),
            "server_auth:reviewer"
        );

        // Goal-less direct Attempt: admit, settle, read back.
        let admitted = roundtrip(
            &mut stream,
            request(
                "admit_direct_attempt",
                value_map([
                    ("attemptID", string("att_process000000000000000000000001")),
                    (
                        "parentSessionID",
                        string("ses_parent00000000000000000000000000"),
                    ),
                    (
                        "childSessionID",
                        string("ses_child000000000000000000000000001"),
                    ),
                    ("agent", string("general")),
                    ("scopeDigest", string(&format!("sha256:{}", "b".repeat(64)))),
                    ("locationID", string(&location_id)),
                    ("workspaceID", string("workspace-process")),
                    (
                        "capabilityDigest",
                        string(&format!("sha256:{}", "c".repeat(64))),
                    ),
                    (
                        "permissionsDigest",
                        string(&format!("sha256:{}", "d".repeat(64))),
                    ),
                    (
                        "budgetDigest",
                        string(&format!("sha256:{}", "e".repeat(64))),
                    ),
                ]),
                Some("att-process-admit-1"),
                "req_admit_direct",
            ),
        );
        assert_eq!(admitted.outcome, RpcOutcomeV1::Ok, "{:?}", admitted.error);
        let admitted = admitted.body.unwrap();
        assert_eq!(field_text(&admitted, "attemptPhase"), "EXECUTING");
        assert_eq!(field_unsigned(&admitted, "revision"), 1);

        let settled = roundtrip(
            &mut stream,
            request(
                "settle_direct_attempt",
                value_map([
                    ("attemptID", string("att_process000000000000000000000001")),
                    ("outcome", string("succeeded")),
                    (
                        "resultDigest",
                        string(&format!("sha256:{}", "c".repeat(64))),
                    ),
                    ("expectedRevision", Value::Unsigned(1)),
                ]),
                Some("att-process-settle-1"),
                "req_settle_direct",
            ),
        );
        assert_eq!(settled.outcome, RpcOutcomeV1::Ok, "{:?}", settled.error);
        let settled = settled.body.unwrap();
        assert_eq!(field_text(&settled, "attemptPhase"), "SUCCEEDED");
        assert!(field_text(&settled, "receiptDigest").starts_with("blake3:"));

        // Verification and acceptance require an independently authenticated
        // principal. The production kernel derives every principal from the single
        // authenticated Core peer as `host_os_uid:<uid>`, so both are refused over
        // the real socket: neither verification nor user review is reachable through
        // this channel alone.
        let verify_by_uid = roundtrip(
            &mut stream,
            request(
                "verify_task",
                value_map([
                    ("goalID", string("goal-direct-process")),
                    ("runID", string("run-v1")),
                    ("taskID", string("task-v1")),
                    ("attemptID", string("attempt-process")),
                ]),
                Some("process-verify-uid"),
                "req_verify_uid",
            ),
        );
        assert_eq!(verify_by_uid.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            verify_by_uid.error.as_ref().unwrap().code.as_str(),
            "independent_verifier_required"
        );

        // A second Attempt stays in flight so the restart boundary can fence it.
        let in_flight = roundtrip(
            &mut stream,
            request(
                "admit_direct_attempt",
                value_map([
                    ("attemptID", string("att_process000000000000000000000002")),
                    (
                        "parentSessionID",
                        string("ses_parent00000000000000000000000000"),
                    ),
                    (
                        "childSessionID",
                        string("ses_child000000000000000000000000002"),
                    ),
                    ("agent", string("explore")),
                    ("scopeDigest", string(&format!("sha256:{}", "d".repeat(64)))),
                    ("locationID", string(&location_id)),
                    ("workspaceID", string("workspace-process")),
                    (
                        "capabilityDigest",
                        string(&format!("sha256:{}", "c".repeat(64))),
                    ),
                    (
                        "permissionsDigest",
                        string(&format!("sha256:{}", "e".repeat(64))),
                    ),
                    (
                        "budgetDigest",
                        string(&format!("sha256:{}", "f".repeat(64))),
                    ),
                ]),
                Some("att-process-admit-2"),
                "req_admit_direct_2",
            ),
        );
        assert_eq!(in_flight.outcome, RpcOutcomeV1::Ok, "{:?}", in_flight.error);
        // A forged Attempt stays NOT_FOUND over the real socket.
        let forged = roundtrip(
            &mut stream,
            request(
                "direct_attempt_snapshot",
                value_map([("attemptID", string("att_forged00000000000000000000000f"))]),
                None,
                "req_forged",
            ),
        );
        assert_eq!(forged.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            forged.error.as_ref().unwrap().code.as_str(),
            "managed_not_found"
        );
    })();

    // Restart boundary: a new kernel epoch cannot prove whether the in-flight
    // Attempt launched child work, so recovery records UNKNOWN.
    let _ = child.0.kill();
    let _ = child.0.wait();
    let (mut child, mut stream, owner_epoch) = start_kernel(
        &state,
        "hz-direct-2.sock",
        "direct-process-nonce-2",
        "inc_direct_process_2",
        true,
    );
    (|| {
        let request =
            |operation: &str, body: Value, delivery: Option<&str>, id: &str| RpcRequestV1 {
                owner_epoch,
                process_incarnation: "inc_direct_process_2".to_owned(),
                request_id: id.to_owned(),
                service_id: MANAGED_SERVICE_ID.to_owned(),
                operation: operation.to_owned(),
                delivery_id: delivery.map(str::to_owned),
                expected_cursor: None,
                deadline_unix_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 30_000,
                trace_id: format!("trace_{operation}"),
                body,
            };
        let snapshot = roundtrip(
            &mut stream,
            request(
                "direct_attempt_snapshot",
                value_map([("attemptID", string("att_process000000000000000000000002"))]),
                None,
                "req_snapshot_recovered",
            ),
        );
        assert_eq!(snapshot.outcome, RpcOutcomeV1::Ok, "{:?}", snapshot.error);
        assert_eq!(
            field_text(&snapshot.body.unwrap(), "attemptPhase"),
            "UNKNOWN"
        );
        // The settled Attempt keeps its recorded phase and receipt across restart.
        let settled = roundtrip(
            &mut stream,
            request(
                "direct_attempt_snapshot",
                value_map([("attemptID", string("att_process000000000000000000000001"))]),
                None,
                "req_snapshot_settled",
            ),
        );
        assert_eq!(
            field_text(&settled.body.unwrap(), "attemptPhase"),
            "SUCCEEDED"
        );
        // The Goal created through the ingress is durable across restart as well.
        let goal = roundtrip(
            &mut stream,
            request(
                "snapshot",
                value_map([("goalID", string("goal-direct-process"))]),
                None,
                "req_snapshot_goal",
            ),
        );
        assert_eq!(goal.outcome, RpcOutcomeV1::Ok, "{:?}", goal.error);
        let goal = goal.body.unwrap();
        assert_eq!(field_text(&goal, "goalID"), "goal-direct-process");
        assert_eq!(field_unsigned(&goal, "revision"), 4);
        // Settling the recovered Attempt as success is refused.
        let launder = roundtrip(
            &mut stream,
            request(
                "settle_direct_attempt",
                value_map([
                    ("attemptID", string("att_process000000000000000000000002")),
                    ("outcome", string("succeeded")),
                    (
                        "resultDigest",
                        string(&format!("sha256:{}", "e".repeat(64))),
                    ),
                    ("expectedRevision", Value::Unsigned(1)),
                ]),
                Some("att-process-launder"),
                "req_launder",
            ),
        );
        assert_eq!(launder.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            launder.error.as_ref().unwrap().code.as_str(),
            "managed_conflict"
        );
    })();
    let _ = child.0.kill();
    let _ = child.0.wait();
}

#[test]
fn authenticated_socket_serves_managed_rpc_without_effects_negotiation() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    seed_managed_goal(&state);
    let socket = state.join("hz-kernel.sock");
    let core_exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let kernel_exe = fs::canonicalize(env!("CARGO_BIN_EXE_hz-kernel")).unwrap();
    let nonce = "host-managed-process-nonce";
    let incarnation = "inc_managed_process";
    let mut child = TestProcess(
        Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
            .arg(format!("--state-dir={}", state.display()))
            .arg(format!("--socket={}", socket.display()))
            .arg(format!("--host-exe={}", core_exe.display()))
            .arg(format!("--nonce={nonce}"))
            .arg(format!("--incarnation={incarnation}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );

    (|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !socket.exists() {
            if child.0.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                panic!("hz-kernel did not create its private socket");
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
        // This Core peer negotiates no optional feature at all: the managed.v1
        // admission boundary must still serve an authenticated, fenced request.
        let hello = KernelHelloV1 {
            min_protocol: 1,
            max_protocol: 1,
            host_build_digest: format!("blake3:{}", "b".repeat(64)),
            kernel_build_digest: None,
            host_instance_id: "host_managed_process".to_owned(),
            process_incarnation: incarnation.to_owned(),
            supervisor_nonce: nonce.to_owned(),
            required_features: Vec::new(),
            optional_features: Vec::new(),
        };
        write_message(&mut stream, &RpcMessageV1::Hello(Box::new(hello))).unwrap();
        let Some(RpcMessageV1::HelloResult(negotiated)) = read_message(&mut stream).unwrap() else {
            panic!("expected fenced host hello result");
        };
        assert!(negotiated.enabled_features.is_empty());
        let mut ready = false;
        for _ in 0..16 {
            match read_message(&mut stream).unwrap().unwrap() {
                RpcMessageV1::StartupStatus(status) if *status == KernelStartupStatusV1::Ready => {
                    ready = true;
                    break;
                }
                RpcMessageV1::StartupStatus(status)
                    if *status == KernelStartupStatusV1::Starting => {}
                other => panic!("unexpected startup frame before READY: {other:?}"),
            }
        }
        assert!(ready, "hz-kernel did not reach READY");

        let request = |operation: &str, body: Value, delivery: Option<&str>| RpcRequestV1 {
            owner_epoch: negotiated.owner_epoch,
            process_incarnation: incarnation.to_owned(),
            request_id: format!("req_managed_{operation}"),
            service_id: MANAGED_SERVICE_ID.to_owned(),
            operation: operation.to_owned(),
            delivery_id: delivery.map(str::to_owned),
            expected_cursor: None,
            deadline_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 30_000,
            trace_id: format!("trace_managed_{operation}"),
            body,
        };

        let snapshot = roundtrip(
            &mut stream,
            request(
                "snapshot",
                value_map([("goalID", string(MANAGED_GOAL))]),
                None,
            ),
        );
        assert_eq!(snapshot.outcome, RpcOutcomeV1::Ok, "{:?}", snapshot.error);
        let snapshot = snapshot.body.unwrap();
        assert_eq!(field_text(&snapshot, "goalID"), MANAGED_GOAL);
        assert_eq!(field(&snapshot, "revision"), &Value::Unsigned(7));
        let spec_digest = match field(&snapshot, "specs") {
            Value::Array(specs) if specs.len() == 1 => {
                field_text(&specs[0], "specDigest").to_owned()
            }
            other => panic!("expected one seeded SpecVersion, got {other:?}"),
        };

        let reviewer_body = || {
            value_map([
                ("goalID", string(MANAGED_GOAL)),
                ("specID", string("spec-v1")),
                ("specDigest", string(&spec_digest)),
                ("expectedRevision", Value::Unsigned(7)),
            ])
        };
        let forged_body = {
            let mut fields = match reviewer_body() {
                Value::Map(fields) => fields,
                _ => unreachable!(),
            };
            fields.insert("principal".to_owned(), string("server_auth:reviewer"));
            Value::Map(fields)
        };
        let forged = roundtrip(
            &mut stream,
            request(
                "assign_spec_reviewer",
                forged_body,
                Some("review-forged-body"),
            ),
        );
        assert_eq!(forged.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            forged.error.as_ref().unwrap().code,
            "invalid_effect_request"
        );

        // A body-only ServerAuth claim cannot replace authenticated envelope metadata.
        let missing_metadata = roundtrip(
            &mut stream,
            request(
                "assign_spec_reviewer",
                reviewer_body(),
                Some("review-missing-metadata"),
            ),
        );
        assert_eq!(missing_metadata.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            missing_metadata.error.as_ref().unwrap().code,
            "independent_verifier_required"
        );

        // A middleware-authenticated identity remains out of the operation body
        // and is accepted only on the already-authenticated Core socket.
        let valid_envelope = roundtrip_server_auth(
            &mut stream,
            request(
                "snapshot",
                value_map([("goalID", string(MANAGED_GOAL))]),
                None,
            ),
            "reviewer",
        );
        assert_eq!(
            valid_envelope.outcome,
            RpcOutcomeV1::Ok,
            "{:?}",
            valid_envelope.error
        );
        assert_eq!(
            field_text(valid_envelope.body.as_ref().unwrap(), "goalID"),
            MANAGED_GOAL
        );

        // Exercise the full real-socket independent-review path against a fresh,
        // atomically created proposal. Host OS may author it, but cannot claim the
        // reviewer role; a separately authenticated ServerAuth principal can.
        let proposal = roundtrip(
            &mut stream,
            request(
                "create_goal_proposal",
                value_map([
                    ("goalID", string("goal-socket-review")),
                    ("specID", string("spec-socket-review")),
                    ("objective", string("Review a bounded proposal")),
                    ("projectRef", string("project-socket")),
                    ("workspaceRef", string("workspace-socket")),
                    ("capabilityScope", Value::Array(vec![])),
                    ("scope", Value::Array(vec![string("review-scope")])),
                    ("constraints", Value::Array(vec![string("bounded")])),
                    (
                        "criteria",
                        Value::Array(vec![value_map([
                            ("id", string("tests-pass")),
                            ("description", string("Required tests pass")),
                        ])]),
                    ),
                    (
                        "budget",
                        value_map([
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
                    ("sourceDigests", Value::Array(Vec::new())),
                ]),
                Some("socket-review-proposal"),
            ),
        );
        assert_eq!(proposal.outcome, RpcOutcomeV1::Ok, "{:?}", proposal.error);
        let proposal = proposal.body.unwrap();
        let proposal_digest = field_text(&proposal, "specDigest").to_owned();
        assert_eq!(field_unsigned(&proposal, "revision"), 1);

        let review_body = || {
            value_map([
                ("goalID", string("goal-socket-review")),
                ("specID", string("spec-socket-review")),
                ("specDigest", string(&proposal_digest)),
                ("expectedRevision", Value::Unsigned(1)),
            ])
        };
        let host_reviewer = roundtrip(
            &mut stream,
            request(
                "assign_spec_reviewer",
                review_body(),
                Some("socket-review-host-denied"),
            ),
        );
        assert_eq!(host_reviewer.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            host_reviewer.error.as_ref().unwrap().code,
            "independent_verifier_required"
        );

        let assigned = roundtrip_server_auth(
            &mut stream,
            request(
                "assign_spec_reviewer",
                review_body(),
                Some("socket-review-assign"),
            ),
            "reviewer",
        );
        assert_eq!(assigned.outcome, RpcOutcomeV1::Ok, "{:?}", assigned.error);
        assert_eq!(
            field_text(assigned.body.as_ref().unwrap(), "reviewerID"),
            "server_auth:reviewer"
        );
        assert_eq!(
            field_unsigned(assigned.body.as_ref().unwrap(), "decisionRevision"),
            2
        );

        let accept_body = || {
            value_map([
                ("goalID", string("goal-socket-review")),
                ("specID", string("spec-socket-review")),
                ("specDigest", string(&proposal_digest)),
                ("expectedRevision", Value::Unsigned(2)),
            ])
        };
        let wrong_reviewer = roundtrip_server_auth(
            &mut stream,
            request(
                "accept_spec",
                accept_body(),
                Some("socket-review-wrong-reviewer"),
            ),
            "other-reviewer",
        );
        assert_eq!(wrong_reviewer.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            wrong_reviewer.error.as_ref().unwrap().code,
            "independent_verifier_required"
        );

        let accepted = roundtrip_server_auth(
            &mut stream,
            request("accept_spec", accept_body(), Some("socket-review-accept")),
            "reviewer",
        );
        assert_eq!(accepted.outcome, RpcOutcomeV1::Ok, "{:?}", accepted.error);
        assert_eq!(
            field_text(accepted.body.as_ref().unwrap(), "acceptedBy"),
            "server_auth:reviewer"
        );

        let admitted = roundtrip(
            &mut stream,
            request(
                "admit",
                value_map([
                    ("goalID", string(MANAGED_GOAL)),
                    ("runID", string("run-v1")),
                    ("taskID", string("task-v1")),
                    ("attemptID", string("attempt-process")),
                    ("expectedRevision", Value::Unsigned(7)),
                    ("locationID", string("not-registered-without-effects")),
                    ("sessionID", string("session-process")),
                ]),
                Some("process-managed-admit-1"),
            ),
        );
        assert_eq!(admitted.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            admitted.error.as_ref().unwrap().code,
            "location_not_registered",
            "managed Attempt dispatch requires a registered Location even when the Core peer did not negotiate effects",
        );

        // The admitted Attempt is durable and visible on the same connection.
        let after = roundtrip(
            &mut stream,
            request(
                "snapshot",
                value_map([("goalID", string(MANAGED_GOAL))]),
                None,
            ),
        );
        let after = after.body.unwrap();
        let attempts = match field(&after, "attempts") {
            Value::Array(items) => items.clone(),
            other => panic!("attempts must be an array: {other:?}"),
        };
        assert!(
            attempts.is_empty(),
            "unregistered Attempt scope must allocate no durable Attempt"
        );

        // The old two-call authoring path is disabled before creating an OwnerLog;
        // callers must submit Goal plus initial SpecVersion atomically.
        for operation in ["create_goal", "propose_spec"] {
            let disabled = roundtrip(
                &mut stream,
                request(
                    operation,
                    value_map([
                        ("goalID", string("goal-legacy-split")),
                        ("specID", string("spec-legacy-split")),
                        ("objective", string("never persist a half-authored Goal")),
                        ("projectRef", string("project")),
                        ("workspaceRef", string("workspace")),
                        ("scope", Value::Array(Vec::new())),
                        ("constraints", Value::Array(Vec::new())),
                        ("criteria", Value::Array(Vec::new())),
                        ("budget", Value::Map(Default::default())),
                        ("sourceDigests", Value::Array(Vec::new())),
                    ]),
                    Some(&format!("disabled-split-{operation}")),
                ),
            );
            assert_eq!(disabled.outcome, RpcOutcomeV1::Error);
            assert_eq!(
                disabled.error.as_ref().unwrap().code,
                "capability_unavailable"
            );
        }
        assert!(
            !ManagedControl::goal_exists(&state.join("managed-control"), "goal-legacy-split"),
            "disabled split authoring must not create a durable Goal owner"
        );

        // A caller-supplied receipt digest is no longer part of the settlement
        // contract: it is rejected as an unknown field before any durable write.
        let forged_receipt = roundtrip(
            &mut stream,
            request(
                "settle",
                value_map([
                    ("goalID", string(MANAGED_GOAL)),
                    ("runID", string("run-v1")),
                    ("taskID", string("task-v1")),
                    ("attemptID", string("attempt-process")),
                    ("outcome", string("succeeded")),
                    (
                        "receiptDigest",
                        string(&format!("blake3:{}", "c".repeat(64))),
                    ),
                    ("expectedRevision", Value::Unsigned(8)),
                ]),
                Some("process-managed-forged-receipt"),
            ),
        );
        assert_eq!(forged_receipt.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            forged_receipt.error.as_ref().unwrap().code.as_str(),
            "invalid_effect_request"
        );
        // A successful settlement without any bound, settled target receipt fails
        // closed over the real socket as well.
        let unbound = roundtrip(
            &mut stream,
            request(
                "settle",
                value_map([
                    ("goalID", string(MANAGED_GOAL)),
                    ("runID", string("run-v1")),
                    ("taskID", string("task-v1")),
                    ("attemptID", string("attempt-process")),
                    ("outcome", string("succeeded")),
                    ("expectedRevision", Value::Unsigned(8)),
                ]),
                Some("process-managed-unbound"),
            ),
        );
        assert_eq!(unbound.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            unbound.error.as_ref().unwrap().code.as_str(),
            "managed_conflict"
        );

        // A forged Attempt over the real socket is a typed conflict, not a partial write.
        let forged = roundtrip(
            &mut stream,
            request(
                "settle",
                value_map([
                    ("goalID", string(MANAGED_GOAL)),
                    ("runID", string("run-v1")),
                    ("taskID", string("task-v1")),
                    ("attemptID", string("attempt-forged")),
                    ("outcome", string("succeeded")),
                    ("expectedRevision", Value::Unsigned(8)),
                ]),
                Some("process-managed-forged-1"),
            ),
        );
        assert_eq!(forged.outcome, RpcOutcomeV1::Error);
        assert_eq!(forged.error.as_ref().unwrap().code, "managed_conflict");

        // effects.v2 remains fail-closed on this connection while managed.v1 served.
        let effects = roundtrip(
            &mut stream,
            RpcRequestV1 {
                service_id: FEATURE_EFFECTS_V2.to_owned(),
                operation: "register_location".to_owned(),
                body: value_map([("canonicalRoot", string(state.to_str().unwrap()))]),
                ..request(
                    "snapshot",
                    value_map([("goalID", string(MANAGED_GOAL))]),
                    None,
                )
            },
        );
        assert_eq!(effects.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            effects.error.as_ref().unwrap().code.as_str(),
            "feature_not_negotiated"
        );
    })();
}

/// A verifier dispatch recovered as UNKNOWN is returned as a typed managed RPC
/// error over the authenticated kernel socket, before HostKernel opens or creates
/// the corresponding managed Goal owner.
#[test]
fn authenticated_socket_reports_verifier_unknown_after_restart_without_replay() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    let journal_path = state.join("managed-verifier-journal.v1.json");
    let journal = serde_json::json!({
        "version": 1,
        "entries": {
            "verification-socket-unknown": {
                "goal_id": "goal-socket-unknown",
                "run_id": "run-socket-unknown",
                "spec_id": "spec-socket-unknown",
                "spec_digest": format!("blake3:{}", "a".repeat(64)),
                "verification_run_id": "verification-socket-unknown",
                "challenge_set_digest": format!("blake3:{}", "b".repeat(64)),
                "owner_epoch": 7,
                "cancel_generation": 9,
                "delivery_id": "delivery-socket-unknown",
                "reviewer_principal": "server_auth:reviewer",
                "profile_id": "missing-profile",
                "profile_digest": format!("blake3:{}", "c".repeat(64)),
                "location_id": "location-socket-unknown",
                "final_revision": format!("blake3:{}", "d".repeat(64)),
                "created_at_unix_ms": 1,
                "state": "unknown",
                "members": [{
                    "criterion_id": "tests-pass",
                    "challenge_id": "challenge-socket-unknown",
                    "effect_id": "effect-socket-unknown",
                    "guard_argument_digest": format!("blake3:{}", "e".repeat(64)),
                    "canonical_content_digest": format!("blake3:{}", "f".repeat(64)),
                    "expires_at_unix_ms": 2,
                    "normalized_targets_hex": "81a12e",
                    "lease_digest": Some(format!("blake3:{}", "1".repeat(64))),
                    "execution_id": "execution-socket-unknown",
                    "execution_generation": 11,
                    "state": "unknown"
                }]
            }
        }
    });
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    fs::set_permissions(&journal_path, fs::Permissions::from_mode(0o600)).unwrap();

    let (mut child, mut stream, owner_epoch) = start_kernel(
        &state,
        "hz-verifier-unknown.sock",
        "verifier-unknown-nonce",
        "inc_verifier_unknown",
        false,
    );
    let response = roundtrip_server_auth(
        &mut stream,
        RpcRequestV1 {
            owner_epoch,
            process_incarnation: "inc_verifier_unknown".to_owned(),
            request_id: "req_verifier_unknown_restart".to_owned(),
            service_id: MANAGED_SERVICE_ID.to_owned(),
            operation: "begin_verification".to_owned(),
            delivery_id: Some("delivery-verifier-unknown-retry".to_owned()),
            expected_cursor: None,
            deadline_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 30_000,
            trace_id: "trace_verifier_unknown_restart".to_owned(),
            body: value_map([
                ("goalID", string("goal-socket-unknown")),
                ("runID", string("run-socket-unknown")),
            ]),
        },
        "reviewer",
    );

    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    let error = response.error.expect("recovered UNKNOWN is typed");
    assert_eq!(error.code, "verification_unknown");
    assert_eq!(
        error.category,
        horizoncode_kernel::protocol::ErrorCategoryV1::Conflict
    );
    assert!(!ManagedControl::goal_exists(
        &state.join("managed-control"),
        "goal-socket-unknown"
    ));
    drop(stream);
    child.0.kill().unwrap();
    child.0.wait().unwrap();
}

/// Exercises managed pause/resume/cancel through the authenticated Unix socket,
/// including stale revision rejection and restart persistence of the terminal
/// cancellation state.
#[test]
fn authenticated_socket_fences_pause_resume_cancel_and_persists_after_restart() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    seed_managed_goal(&state);

    let (mut child, mut stream, owner_epoch) = start_kernel(
        &state,
        "hz-managed-lifecycle.sock",
        "managed-lifecycle-nonce-1",
        "inc_managed_lifecycle_1",
        false,
    );
    let request = |incarnation: &str,
                   owner_epoch: u64,
                   operation: &str,
                   body: Value,
                   delivery: Option<&str>,
                   id: &str| RpcRequestV1 {
        owner_epoch,
        process_incarnation: incarnation.to_owned(),
        request_id: id.to_owned(),
        service_id: MANAGED_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: delivery.map(str::to_owned),
        expected_cursor: None,
        deadline_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 30_000,
        trace_id: format!("trace_{operation}"),
        body,
    };
    let lifecycle_body = |revision: u64| {
        value_map([
            ("goalID", string(MANAGED_GOAL)),
            ("runID", string("run-v1")),
            ("expectedRevision", Value::Unsigned(revision)),
        ])
    };

    let paused = roundtrip(
        &mut stream,
        request(
            "inc_managed_lifecycle_1",
            owner_epoch,
            "pause_run",
            lifecycle_body(7),
            Some("managed-lifecycle-pause"),
            "req_pause_run",
        ),
    );
    assert_eq!(paused.outcome, RpcOutcomeV1::Ok, "{:?}", paused.error);
    let paused = paused.body.unwrap();
    assert_eq!(field_text(&paused, "runPhase"), "PAUSED");
    assert_eq!(field_unsigned(&paused, "revision"), 8);

    let stale_pause = roundtrip(
        &mut stream,
        request(
            "inc_managed_lifecycle_1",
            owner_epoch,
            "pause_run",
            lifecycle_body(7),
            Some("managed-lifecycle-stale-pause"),
            "req_stale_pause",
        ),
    );
    assert_eq!(stale_pause.outcome, RpcOutcomeV1::Error);
    assert_eq!(stale_pause.error.as_ref().unwrap().code, "managed_conflict");

    let resumed = roundtrip(
        &mut stream,
        request(
            "inc_managed_lifecycle_1",
            owner_epoch,
            "resume_run",
            lifecycle_body(8),
            Some("managed-lifecycle-resume"),
            "req_resume_run",
        ),
    );
    assert_eq!(resumed.outcome, RpcOutcomeV1::Ok, "{:?}", resumed.error);
    let resumed = resumed.body.unwrap();
    assert_eq!(field_text(&resumed, "runPhase"), "RUNNING");
    assert_eq!(field_unsigned(&resumed, "revision"), 9);

    let cancelled = roundtrip(
        &mut stream,
        request(
            "inc_managed_lifecycle_1",
            owner_epoch,
            "cancel",
            lifecycle_body(9),
            Some("managed-lifecycle-cancel"),
            "req_cancel_run",
        ),
    );
    assert_eq!(cancelled.outcome, RpcOutcomeV1::Ok, "{:?}", cancelled.error);
    let cancelled = cancelled.body.unwrap();
    assert_eq!(field_text(&cancelled, "status"), "CANCELLED");
    assert_eq!(field_text(&cancelled, "runPhase"), "CANCELLED");

    let repeated_cancel = roundtrip(
        &mut stream,
        request(
            "inc_managed_lifecycle_1",
            owner_epoch,
            "cancel",
            lifecycle_body(field_unsigned(&cancelled, "revision")),
            Some("managed-lifecycle-cancel-replay"),
            "req_cancel_replay",
        ),
    );
    assert_eq!(repeated_cancel.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        field_text(repeated_cancel.body.as_ref().unwrap(), "runPhase"),
        "CANCELLED"
    );

    let _ = child.0.kill();
    let _ = child.0.wait();
    let (_child, mut stream, owner_epoch) = start_kernel(
        &state,
        "hz-managed-lifecycle-restart.sock",
        "managed-lifecycle-nonce-2",
        "inc_managed_lifecycle_2",
        false,
    );
    let snapshot = roundtrip(
        &mut stream,
        request(
            "inc_managed_lifecycle_2",
            owner_epoch,
            "snapshot",
            value_map([("goalID", string(MANAGED_GOAL))]),
            None,
            "req_lifecycle_snapshot",
        ),
    );
    assert_eq!(snapshot.outcome, RpcOutcomeV1::Ok, "{:?}", snapshot.error);
    let snapshot = snapshot.body.unwrap();
    assert_eq!(
        field_unsigned(&snapshot, "revision"),
        field_unsigned(&cancelled, "revision")
    );
    let runs = match field(&snapshot, "runs") {
        Value::Array(runs) => runs,
        other => panic!("runs must be an array: {other:?}"),
    };
    assert_eq!(runs.len(), 1);
    assert_eq!(field_text(&runs[0], "phase"), "CANCELLED");

    let stale_resume = roundtrip(
        &mut stream,
        request(
            "inc_managed_lifecycle_2",
            owner_epoch,
            "resume_run",
            lifecycle_body(8),
            Some("managed-lifecycle-stale-resume"),
            "req_stale_resume",
        ),
    );
    assert_eq!(stale_resume.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        stale_resume.error.as_ref().unwrap().code,
        "managed_conflict"
    );
}

/// A real authenticated socket exercises the first ExecutionHost adapter end-to-end:
/// Guard approval, preflight bound to the exact approved TerminalRun arguments, durable
/// one-use dispatch, bounded raw output, settled receipt, and read-only status after
/// HostKernel restart. The request never supplies executable/argv/cwd authority.
#[test]
fn authenticated_socket_runs_guarded_stdio_and_recovers_its_settled_receipt() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&state).unwrap();
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let incarnation = "inc_stdio_execution_1";
    let (mut child, mut stream, owner_epoch) = start_kernel(
        &state,
        "hz-stdio-execution.sock",
        "stdio-execution-nonce-1",
        incarnation,
        true,
    );
    let request =
        |incarnation: &str, epoch: u64, service: &str, operation: &str, body: Value, id: &str| {
            RpcRequestV1 {
                owner_epoch: epoch,
                process_incarnation: incarnation.to_owned(),
                request_id: id.to_owned(),
                service_id: service.to_owned(),
                operation: operation.to_owned(),
                delivery_id: None,
                expected_cursor: None,
                deadline_unix_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 30_000,
                trace_id: format!("trace_{id}"),
                body,
            }
        };
    (|| {
        let registered = roundtrip_server_auth(
            &mut stream,
            request(
                incarnation,
                owner_epoch,
                FEATURE_EFFECTS_V2,
                "register_location",
                value_map([("canonicalRoot", string(workspace.to_str().unwrap()))]),
                "stdio_register_location",
            ),
            "stdio-test-user",
        );
        assert_eq!(
            registered.outcome,
            RpcOutcomeV1::Ok,
            "{:?}",
            registered.error
        );
        let location_id = field_text(registered.body.as_ref().unwrap(), "locationID").to_owned();
        let session_id = "ses_stdio_execution";

        let profiles = roundtrip(
            &mut stream,
            request(
                incarnation,
                owner_epoch,
                TERMINAL_SERVICE_ID,
                "register_shell_profiles",
                value_map([
                    ("defaultProfileKey", string("posix:bash")),
                    (
                        "profiles",
                        Value::Array(vec![value_map([
                            ("profileKey", string("posix:bash")),
                            ("kind", string("posix.bash")),
                            ("executable", string("/bin/bash")),
                            ("login", Value::Bool(false)),
                        ])]),
                    ),
                ]),
                "stdio_register_profile",
            ),
        );
        assert_eq!(profiles.outcome, RpcOutcomeV1::Ok, "{:?}", profiles.error);
        let profiles_body = profiles.body.unwrap();
        let Value::Array(profile_list) = field(&profiles_body, "profiles") else {
            panic!("registered profile response must contain profiles")
        };
        let profile = field_text(&profile_list[0], "shellProfileID").to_owned();
        let arguments = value_map([
            ("shellProfileID", string(&profile)),
            (
                "command",
                string("printf 'stdio-out'; printf 'stdio-err' >&2"),
            ),
            ("cwd", string(workspace.to_str().unwrap())),
            ("timeoutMs", Value::Unsigned(10_000)),
            ("resolvedEnvironment", value_map([])),
        ]);
        let prepared_effect = roundtrip(
            &mut stream,
            request(
                incarnation,
                owner_epoch,
                FEATURE_EFFECTS_V2,
                "prepare_user_effect",
                value_map([
                    ("locationID", string(&location_id)),
                    ("sessionID", string(session_id)),
                    ("userActionID", string("action_stdio_execution")),
                    ("capabilityID", string("terminal.run")),
                    ("arguments", arguments),
                ]),
                "stdio_prepare_effect",
            ),
        );
        assert_eq!(
            prepared_effect.outcome,
            RpcOutcomeV1::Ok,
            "{:?}",
            prepared_effect.error
        );
        let effect_body = prepared_effect.body.unwrap();
        let challenge_id = field_text(&effect_body, "challengeID").to_owned();
        let effect_id = field_text(&effect_body, "effectID").to_owned();
        let approved = roundtrip(
            &mut stream,
            request(
                incarnation,
                owner_epoch,
                FEATURE_EFFECTS_V2,
                "resolve_approval",
                value_map([
                    ("challengeID", string(&challenge_id)),
                    ("decision", string("allow_once")),
                ]),
                "stdio_approve_effect",
            ),
        );
        assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);
        let lease = field_text(approved.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();

        let execution_id = "exec_stdio_socket_1";
        let prepare = roundtrip(
            &mut stream,
            request(
                incarnation,
                owner_epoch,
                EXECUTION_SERVICE_ID,
                "prepare",
                value_map([
                    ("executionID", string(execution_id)),
                    ("effectID", string(&effect_id)),
                    ("challengeID", string(&challenge_id)),
                    ("locationID", string(&location_id)),
                    ("capabilityLeaseDigest", string(&lease)),
                    ("sessionID", string(session_id)),
                ]),
                "stdio_execution_prepare",
            ),
        );
        assert_eq!(prepare.outcome, RpcOutcomeV1::Ok, "{:?}", prepare.error);
        let prepared = prepare.body.unwrap();
        let generation = field_unsigned(&prepared, "generation");
        assert_eq!(field_text(&prepared, "state"), "PREPARED");
        assert!(
            matches!(prepared, Value::Map(ref fields) if !fields.contains_key("argv") && !fields.contains_key("executable"))
        );

        let launch = roundtrip(
            &mut stream,
            request(
                incarnation,
                owner_epoch,
                EXECUTION_SERVICE_ID,
                "launch",
                value_map([
                    ("executionID", string(execution_id)),
                    ("effectID", string(&effect_id)),
                    ("challengeID", string(&challenge_id)),
                    ("locationID", string(&location_id)),
                    ("capabilityLeaseDigest", string(&lease)),
                    ("generation", Value::Unsigned(generation)),
                    ("sessionID", string(session_id)),
                ]),
                "stdio_execution_launch",
            ),
        );
        assert_eq!(launch.outcome, RpcOutcomeV1::Ok, "{:?}", launch.error);
        assert_eq!(
            field_text(launch.body.as_ref().unwrap(), "state"),
            "RUNNING"
        );

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut stdout_sequence = 0;
        let mut stderr_sequence = 0;
        let mut settled = false;
        for index in 0..100 {
            let page = roundtrip(
                &mut stream,
                request(
                    incarnation,
                    owner_epoch,
                    EXECUTION_SERVICE_ID,
                    "read",
                    value_map([
                        ("executionID", string(execution_id)),
                        ("effectID", string(&effect_id)),
                        ("challengeID", string(&challenge_id)),
                        ("locationID", string(&location_id)),
                        ("capabilityLeaseDigest", string(&lease)),
                        ("generation", Value::Unsigned(generation)),
                        ("sessionID", string(session_id)),
                        ("afterStdoutSequence", Value::Unsigned(stdout_sequence)),
                        ("afterStderrSequence", Value::Unsigned(stderr_sequence)),
                        ("maxBytes", Value::Unsigned(4096)),
                    ]),
                    &format!("stdio_execution_read_{index}"),
                ),
            );
            assert_eq!(page.outcome, RpcOutcomeV1::Ok, "{:?}", page.error);
            let body = page.body.unwrap();
            let Value::Array(records) = field(&body, "records") else {
                panic!("execution output records must be an array")
            };
            for record in records {
                let Value::Binary(bytes) = field(record, "bytes") else {
                    panic!("execution output must remain raw bytes")
                };
                match field_text(record, "source") {
                    "stdout" => stdout.extend_from_slice(bytes),
                    "stderr" => stderr.extend_from_slice(bytes),
                    other => panic!("unknown execution output stream {other}"),
                }
            }
            stdout_sequence = field_unsigned(&body, "nextStdoutSequence");
            stderr_sequence = field_unsigned(&body, "nextStderrSequence");
            if matches!(field(&body, "eof"), Value::Bool(true)) {
                assert_eq!(field_text(&body, "state"), "SETTLED");
                let receipt = field(&body, "receipt");
                assert_eq!(field_text(receipt, "effectID"), effect_id);
                assert_eq!(field_unsigned(receipt, "exitCode"), 0);
                assert!(field_text(receipt, "receiptDigest").starts_with("blake3:"));
                settled = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(settled, "stdio process did not reach bounded EOF/receipt");
        assert_eq!(stdout, b"stdio-out");
        assert_eq!(stderr, b"stdio-err");

        // Restart changes the authenticated FrameFence. Status recovery accepts only
        // the opaque identifiers and peer identity, then returns the persisted receipt.
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        drop(stream);
        let next_incarnation = "inc_stdio_execution_2";
        let (mut restarted, mut stream, next_epoch) = start_kernel(
            &state,
            "hz-stdio-execution-restart.sock",
            "stdio-execution-nonce-2",
            next_incarnation,
            true,
        );
        let recovered = roundtrip(
            &mut stream,
            request(
                next_incarnation,
                next_epoch,
                EXECUTION_SERVICE_ID,
                "status",
                value_map([
                    ("executionID", string(execution_id)),
                    ("effectID", string(&effect_id)),
                    ("challengeID", string(&challenge_id)),
                    ("locationID", string(&location_id)),
                ]),
                "stdio_execution_recover",
            ),
        );
        assert_eq!(recovered.outcome, RpcOutcomeV1::Ok, "{:?}", recovered.error);
        assert_eq!(
            field_text(recovered.body.as_ref().unwrap(), "state"),
            "SETTLED"
        );
        assert_eq!(
            field_unsigned(recovered.body.as_ref().unwrap(), "exitCode"),
            0
        );
        assert!(
            field_text(recovered.body.as_ref().unwrap(), "receiptDigest").starts_with("blake3:")
        );
        restarted.0.kill().unwrap();
        restarted.0.wait().unwrap();
    })();
}

/// A real authenticated socket carries one accepted managed Attempt through the
/// canonical Guard batch, durable Attempt intent, one-use approval lease, guarded
/// write receipt, and successful managed settlement. A subsequent human edit makes
/// the admitted workspace revision stale and a follow-up effect is denied before
/// writing its target.
#[test]
fn authenticated_socket_binds_managed_attempt_to_guarded_write_and_rejects_human_conflict() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&state).unwrap();
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(workspace.join("same-content.txt"), b"managed result").unwrap();
    let state = fs::canonicalize(state).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let incarnation = "inc_managed_effect_socket_1";
    let (mut child, mut stream, owner_epoch) = start_kernel(
        &state,
        "hz-managed-effect.sock",
        "managed-effect-nonce-1",
        incarnation,
        true,
    );
    let request =
        |service: &str, operation: &str, body: Value, delivery: Option<&str>, id: &str| {
            RpcRequestV1 {
                owner_epoch,
                process_incarnation: incarnation.to_owned(),
                request_id: id.to_owned(),
                service_id: service.to_owned(),
                operation: operation.to_owned(),
                delivery_id: delivery.map(str::to_owned),
                expected_cursor: None,
                deadline_unix_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 30_000,
                trace_id: format!("trace_{id}"),
                body,
            }
        };

    (|| {
        let registered = roundtrip_server_auth(
            &mut stream,
            request(
                FEATURE_EFFECTS_V2,
                "register_location",
                value_map([
                    ("canonicalRoot", string(workspace.to_str().unwrap())),
                    ("workspaceID", string("workspace-one")),
                ]),
                None,
                "managed_register_location",
            ),
            "managed-test-user",
        );
        assert_eq!(
            registered.outcome,
            RpcOutcomeV1::Ok,
            "{:?}",
            registered.error
        );
        let location_id = field_text(registered.body.as_ref().unwrap(), "locationID").to_owned();
        let session_id = "ses_managed_effect";
        let goal_id = "goal-process";
        let run_id = "run-v1";
        let task_id = "task-v1";
        let attempt_id = "att_managed00000000000000000000001";

        // Build and accept the managed plan through the authenticated RPC ingress;
        // the guarded effect below must belong to this real accepted SpecVersion.
        let proposed = roundtrip(
            &mut stream,
            request(
                MANAGED_SERVICE_ID,
                "create_goal_proposal",
                value_map([
                    ("goalID", string(goal_id)),
                    ("specID", string("spec-v1")),
                    ("objective", string("Complete the managed task")),
                    ("projectRef", string("project-one")),
                    ("workspaceRef", string("workspace-one")),
                    ("capabilityScope", Value::Array(vec![])),
                    ("scope", Value::Array(vec![string("**")])),
                    (
                        "constraints",
                        Value::Array(vec![string("Preserve user-owned changes")]),
                    ),
                    (
                        "criteria",
                        Value::Array(vec![value_map([
                            ("id", string("tests-pass")),
                            (
                                "description",
                                string("The guarded write is receipted and verified"),
                            ),
                        ])]),
                    ),
                    (
                        "budget",
                        value_map([
                            ("maxTasks", Value::Unsigned(8)),
                            ("maxAttemptsPerTask", Value::Unsigned(2)),
                            ("maxRunDurationMs", Value::Unsigned(60_000)),
                            ("maxMemoryBytes", Value::Unsigned(1_073_741_824)),
                            ("maxDiskBytes", Value::Unsigned(2_147_483_648)),
                            ("maxWorkers", Value::Unsigned(1)),
                            ("maxTokens", Value::Unsigned(20_000)),
                            ("maxCostMicros", Value::Unsigned(0)),
                        ]),
                    ),
                    (
                        "sourceDigests",
                        Value::Array(vec![string(&format!("sha256:{}", "a".repeat(64)))]),
                    ),
                ]),
                Some("managed_goal_proposal"),
                "managed_create_goal_proposal_for_write",
            ),
        );
        assert_eq!(proposed.outcome, RpcOutcomeV1::Ok, "{:?}", proposed.error);
        assert_eq!(
            field_text(proposed.body.as_ref().unwrap(), "status"),
            "PROPOSED"
        );
        let spec_digest = field_text(proposed.body.as_ref().unwrap(), "specDigest").to_owned();
        assert_eq!(
            field_unsigned(proposed.body.as_ref().unwrap(), "revision"),
            1
        );
        let assigned = roundtrip_server_auth(
            &mut stream,
            request(
                MANAGED_SERVICE_ID,
                "assign_spec_reviewer",
                value_map([
                    ("goalID", string(goal_id)),
                    ("specID", string("spec-v1")),
                    ("specDigest", string(&spec_digest)),
                    ("expectedRevision", Value::Unsigned(1)),
                ]),
                Some("managed_reviewer_assign"),
                "managed_assign_reviewer_for_write",
            ),
            "reviewer",
        );
        assert_eq!(assigned.outcome, RpcOutcomeV1::Ok, "{:?}", assigned.error);
        assert_eq!(
            field_text(assigned.body.as_ref().unwrap(), "reviewerID"),
            "server_auth:reviewer"
        );
        assert_eq!(
            field_unsigned(assigned.body.as_ref().unwrap(), "decisionRevision"),
            2
        );
        let accepted = roundtrip_server_auth(
            &mut stream,
            request(
                MANAGED_SERVICE_ID,
                "accept_spec",
                value_map([
                    ("goalID", string(goal_id)),
                    ("specID", string("spec-v1")),
                    ("specDigest", string(&spec_digest)),
                    ("expectedRevision", Value::Unsigned(2)),
                ]),
                Some("managed_spec_accept"),
                "managed_accept_spec_for_write",
            ),
            "reviewer",
        );
        assert_eq!(accepted.outcome, RpcOutcomeV1::Ok, "{:?}", accepted.error);
        assert_eq!(
            field_text(accepted.body.as_ref().unwrap(), "acceptedBy"),
            "server_auth:reviewer"
        );
        for (operation, body, delivery, request_id) in [
            (
                "start_run",
                value_map([
                    ("goalID", string(goal_id)),
                    ("runID", string(run_id)),
                    ("specID", string("spec-v1")),
                ]),
                "managed_run_start",
                "managed_start_run_for_write",
            ),
            (
                "add_task",
                value_map([
                    ("goalID", string(goal_id)),
                    ("runID", string(run_id)),
                    ("taskID", string(task_id)),
                    ("dependencies", Value::Array(vec![])),
                    ("criterionIDs", Value::Array(vec![string("tests-pass")])),
                    ("requiredCapabilities", Value::Array(vec![])),
                ]),
                "managed_task_add",
                "managed_add_task_for_write",
            ),
            (
                "mark_task_ready",
                value_map([
                    ("goalID", string(goal_id)),
                    ("runID", string(run_id)),
                    ("taskID", string(task_id)),
                ]),
                "managed_task_ready",
                "managed_ready_task_for_write",
            ),
        ] {
            let result = roundtrip(
                &mut stream,
                request(
                    MANAGED_SERVICE_ID,
                    operation,
                    body,
                    Some(delivery),
                    request_id,
                ),
            );
            assert_eq!(
                result.outcome,
                RpcOutcomeV1::Ok,
                "{operation}: {:?}",
                result.error
            );
        }

        let admitted = roundtrip(
            &mut stream,
            request(
                MANAGED_SERVICE_ID,
                "admit",
                value_map([
                    ("goalID", string(goal_id)),
                    ("runID", string(run_id)),
                    ("taskID", string(task_id)),
                    ("attemptID", string(attempt_id)),
                    ("expectedRevision", Value::Unsigned(6)),
                    ("locationID", string(&location_id)),
                    ("sessionID", string(session_id)),
                ]),
                Some("managed_effect_admit"),
                "managed_admit_attempt",
            ),
        );
        assert_eq!(admitted.outcome, RpcOutcomeV1::Ok, "{:?}", admitted.error);
        let admitted = admitted.body.unwrap();
        assert_eq!(field_text(&admitted, "attemptPhase"), "EXECUTING");
        let workspace_revision = field_text(&admitted, "workspaceRevision").to_owned();
        let attempt_scope = value_map([
            ("goalID", string(goal_id)),
            ("runID", string(run_id)),
            ("taskID", string(task_id)),
            ("attemptID", string(attempt_id)),
            (
                "ownerEpoch",
                Value::Unsigned(field_unsigned(&admitted, "ownerEpoch")),
            ),
            (
                "expectedManagedRevision",
                Value::Unsigned(field_unsigned(&admitted, "revision")),
            ),
            ("locationID", string(&location_id)),
            ("sessionID", string(session_id)),
            ("workspaceRevision", string(&workspace_revision)),
        ]);

        let prepared = roundtrip(
            &mut stream,
            request(
                FEATURE_EFFECTS_V2,
                "prepare_tool_batch",
                value_map([
                    ("sessionID", string(session_id)),
                    ("locationID", string(&location_id)),
                    ("batchID", string("managed-write-batch")),
                    (
                        "turnContextDigest",
                        string(&format!("sha256:{}", "a".repeat(64))),
                    ),
                    (
                        "calls",
                        Value::Array(vec![value_map([
                            ("callID", string("managed-write-call")),
                            ("capabilityID", string("files.write")),
                            (
                                "arguments",
                                value_map([
                                    ("path", string("same-content.txt")),
                                    ("content", string("managed result")),
                                ]),
                            ),
                        ])]),
                    ),
                    ("managedAttempt", attempt_scope.clone()),
                ]),
                Some("managed_write_prepare"),
                "managed_prepare_guarded_write",
            ),
        );
        assert_eq!(prepared.outcome, RpcOutcomeV1::Ok, "{:?}", prepared.error);
        let prepared = prepared.body.unwrap();
        assert_eq!(field_text(&prepared, "status"), "needs_approval");
        let challenge_id = field_text(&prepared, "challengeID").to_owned();
        let effect_id = field_text(&prepared, "effectID").to_owned();

        let bound = roundtrip(
            &mut stream,
            request(
                MANAGED_SERVICE_ID,
                "bind_attempt_effect",
                value_map([
                    ("goalID", string(goal_id)),
                    ("runID", string(run_id)),
                    ("taskID", string(task_id)),
                    ("attemptID", string(attempt_id)),
                    ("locationID", string(&location_id)),
                    ("sessionID", string(session_id)),
                    ("effectID", string(&effect_id)),
                    ("managedAttempt", attempt_scope.clone()),
                ]),
                Some("managed_bind_effect"),
                "managed_bind_guarded_write",
            ),
        );
        assert_eq!(bound.outcome, RpcOutcomeV1::Ok, "{:?}", bound.error);
        assert_eq!(field_text(bound.body.as_ref().unwrap(), "status"), "BOUND");
        let bound_revision = field_unsigned(bound.body.as_ref().unwrap(), "revision");

        let approved = roundtrip(
            &mut stream,
            request(
                FEATURE_EFFECTS_V2,
                "resolve_approval",
                value_map([
                    ("challengeID", string(&challenge_id)),
                    ("decision", string("allow_once")),
                ]),
                Some("managed_approve_write"),
                "managed_approve_guarded_write",
            ),
        );
        assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);
        let lease = field_text(approved.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
        let executed = roundtrip(
            &mut stream,
            request(
                FEATURE_EFFECTS_V2,
                "execute_write",
                value_map([
                    ("sessionID", string(session_id)),
                    ("locationID", string(&location_id)),
                    ("effectID", string(&effect_id)),
                    ("capabilityLeaseDigest", string(&lease)),
                    ("content", string("managed result")),
                    ("managedAttempt", attempt_scope.clone()),
                ]),
                Some("managed_execute_write"),
                "managed_execute_guarded_write",
            ),
        );
        assert_eq!(executed.outcome, RpcOutcomeV1::Ok, "{:?}", executed.error);
        let executed = executed.body.unwrap();
        assert_eq!(field_text(&executed, "status"), "settled");
        assert_eq!(field_text(&executed, "effectID"), effect_id);
        assert!(field_text(&executed, "receiptDigest").starts_with("blake3:"));
        assert_eq!(
            fs::read(workspace.join("same-content.txt")).unwrap(),
            b"managed result"
        );

        let settled = roundtrip(
            &mut stream,
            request(
                MANAGED_SERVICE_ID,
                "settle",
                value_map([
                    ("goalID", string(goal_id)),
                    ("runID", string(run_id)),
                    ("taskID", string(task_id)),
                    ("attemptID", string(attempt_id)),
                    ("outcome", string("succeeded")),
                    ("expectedRevision", Value::Unsigned(bound_revision)),
                ]),
                Some("managed_settle_attempt"),
                "managed_settle_receipted_attempt",
            ),
        );
        assert_eq!(settled.outcome, RpcOutcomeV1::Ok, "{:?}", settled.error);
        assert_eq!(
            field_text(settled.body.as_ref().unwrap(), "attemptPhase"),
            "SUCCEEDED"
        );
        assert!(field_text(settled.body.as_ref().unwrap(), "receiptDigest").starts_with("blake3:"));

        fs::write(workspace.join("human-edit.txt"), b"human-owned change").unwrap();
        let conflict = roundtrip(
            &mut stream,
            request(
                FEATURE_EFFECTS_V2,
                "prepare_tool_batch",
                value_map([
                    ("sessionID", string(session_id)),
                    ("locationID", string(&location_id)),
                    ("batchID", string("managed-write-after-human-edit")),
                    (
                        "turnContextDigest",
                        string(&format!("sha256:{}", "b".repeat(64))),
                    ),
                    (
                        "calls",
                        Value::Array(vec![value_map([
                            ("callID", string("managed-write-after-edit")),
                            ("capabilityID", string("files.write")),
                            (
                                "arguments",
                                value_map([
                                    ("path", string("must-not-write.txt")),
                                    ("content", string("denied")),
                                ]),
                            ),
                        ])]),
                    ),
                    ("managedAttempt", attempt_scope),
                ]),
                Some("managed_write_after_human_edit"),
                "managed_stale_write_admission",
            ),
        );
        assert_eq!(conflict.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            conflict.error.as_ref().unwrap().code.as_str(),
            "stale_workspace_revision"
        );
        assert!(!workspace.join("must-not-write.txt").exists());
        assert_eq!(
            fs::read(workspace.join("human-edit.txt")).unwrap(),
            b"human-owned change"
        );
    })();
    child.0.kill().unwrap();
    child.0.wait().unwrap();
}
