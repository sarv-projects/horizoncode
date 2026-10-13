#![cfg(target_os = "linux")]

use horizoncode_kernel::guard;
use horizoncode_kernel::messagepack::{self, Value};
use horizoncode_kernel::protocol::{
    CursorV1, FEATURE_EFFECTS_V2, KernelHelloV1, RpcControlV1, RpcMessageV1, RpcOutcomeV1,
    RpcRequestV1, RpcResponseV1, read_message, write_message,
};
use horizoncode_kernel::transport::write_frame;
use horizoncode_kernel::unix_peer::{UnixPeerPolicy, connect_authenticated};
use rusqlite::{Connection, params};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hc-session-supervisor-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
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

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn source_db(path: &Path) {
    let db = Connection::open(path).unwrap();
    db.execute_batch(
        "CREATE TABLE event (
           id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
           type TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(aggregate_id,seq)
         );",
    )
    .unwrap();
    db.execute(
        "INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(
          'evt_process_0','ses_process',0,'session.next.prompt.admitted.1',?1
        )",
        params![r#"{"messageID":"msg_process","prompt":[{"text":"private"}]}"#],
    )
    .unwrap();
}

fn executable() -> PathBuf {
    PathBuf::from(std::env::var_os("CARGO_BIN_EXE_session_supervisor").unwrap())
}

fn launch(state: &Path, source: &Path, nonce: &str, incarnation: &str) -> ChildGuard {
    launch_with_workspace_root(state, source, nonce, incarnation, None)
}

fn launch_with_workspace_root(
    state: &Path,
    source: &Path,
    nonce: &str,
    incarnation: &str,
    _workspace_root: Option<&Path>,
) -> ChildGuard {
    let mut command = Command::new(executable());
    command
        .arg(format!("--source={}", source.display()))
        .arg(format!("--state-dir={}", state.display()))
        .arg(format!("--socket={}", state.join("session.sock").display()))
        .arg(format!(
            "--host-exe={}",
            std::env::current_exe().unwrap().display()
        ))
        .arg(format!("--nonce={nonce}"))
        .arg(format!("--incarnation={incarnation}"))
        .arg("--owner-epoch=1")
        .arg("--session=ses_process");
    let child = command
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    ChildGuard(child)
}

fn wait_socket(path: &Path) {
    // Under the full parallel workspace suite, several SQLite supervisor children may
    // start together; keep this bounded but leave room for CI scheduling contention.
    let deadline = Instant::now() + Duration::from_secs(15);
    while !path.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        path.exists(),
        "supervisor did not create its private socket"
    );
}

fn host_policy(supervisor: &Path) -> UnixPeerPolicy {
    UnixPeerPolicy {
        uid: unsafe { libc::geteuid() },
        executable: fs::canonicalize(supervisor).unwrap(),
    }
}

fn hello(nonce: &str, incarnation: &str) -> KernelHelloV1 {
    KernelHelloV1 {
        min_protocol: 1,
        max_protocol: 1,
        host_build_digest:
            "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        kernel_build_digest: None,
        host_instance_id: "host_process_test".into(),
        process_incarnation: incarnation.into(),
        supervisor_nonce: nonce.into(),
        required_features: vec![
            "session.events.v1".into(),
            "session.events.page-control.v1".into(),
        ],
        optional_features: vec![],
    }
}

fn ready_host(
    state: &Path,
    supervisor: &Path,
    nonce: &str,
    incarnation: &str,
) -> impl std::io::Read + std::io::Write {
    let mut host =
        connect_authenticated(&state.join("session.sock"), host_policy(supervisor)).unwrap();
    write_message(
        &mut host,
        &RpcMessageV1::Hello(Box::new(hello(nonce, incarnation))),
    )
    .unwrap();
    let Some(RpcMessageV1::HelloResult(result)) = read_message(&mut host).unwrap() else {
        panic!("expected negotiated hello result");
    };
    assert_eq!(result.owner_epoch, 1);
    let statuses = (0..5)
        .map(|_| read_message(&mut host).unwrap().unwrap())
        .collect::<Vec<_>>();
    assert!(
        statuses[..4]
            .iter()
            .all(|message| matches!(message, RpcMessageV1::StartupStatus(_)))
    );
    assert!(
        matches!(&statuses[4], RpcMessageV1::StartupStatus(status) if matches!(status.as_ref(), horizoncode_kernel::protocol::KernelStartupStatusV1::Ready))
    );
    host
}

fn ready_observer_without_effect_feature(
    state: &Path,
    supervisor: &Path,
    nonce: &str,
    incarnation: &str,
) -> impl std::io::Read + std::io::Write {
    let mut host =
        connect_authenticated(&state.join("session.sock"), host_policy(supervisor)).unwrap();
    let mut greeting = hello(nonce, incarnation);
    greeting
        .required_features
        .retain(|feature| feature.as_str() != FEATURE_EFFECTS_V2);
    write_message(&mut host, &RpcMessageV1::Hello(Box::new(greeting))).unwrap();
    let Some(RpcMessageV1::HelloResult(result)) = read_message(&mut host).unwrap() else {
        panic!("expected observer hello result");
    };
    assert!(
        !result
            .enabled_features
            .iter()
            .any(|feature| feature.as_str() == FEATURE_EFFECTS_V2)
    );
    for _ in 0..5 {
        read_message(&mut host).unwrap().unwrap();
    }
    host
}

fn value_map(items: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn send_effect_request<S: std::io::Read + std::io::Write>(
    host: &mut S,
    operation: &str,
    body: Value,
) -> RpcResponseV1 {
    send_effect_request_with_deadline(host, operation, body, deadline_after_30_seconds())
}

fn send_effect_request_with_deadline<S: std::io::Read + std::io::Write>(
    host: &mut S,
    operation: &str,
    body: Value,
    deadline_unix_ms: u64,
) -> RpcResponseV1 {
    write_message(
        host,
        &RpcMessageV1::Request(Box::new(RpcRequestV1 {
            request_id: "effect_req".into(),
            service_id: "effects.v2".into(),
            operation: operation.into(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms,
            trace_id: "effect_trace".into(),
            body,
        })),
    )
    .unwrap();
    match read_message(host).unwrap() {
        Some(RpcMessageV1::Response(response)) => *response,
        other => panic!("expected effect response, got {other:?}"),
    }
}

fn deadline_after_30_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 30_000
}

fn response_string<'a>(response: &'a RpcResponseV1, field: &str) -> &'a str {
    match response.body.as_ref().and_then(|body| match body {
        Value::Map(body) => body.get(field),
        _ => None,
    }) {
        Some(Value::String(value)) => value,
        _ => panic!("response body did not contain string field {field}"),
    }
}

fn subscribe(after: Option<CursorV1>) -> RpcMessageV1 {
    RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
        subscription_id: "sub_process".into(),
        owner_kind: "session".into(),
        owner_id: "ses_process".into(),
        after,
    }))
}

#[test]
fn runnable_supervisor_authenticates_projects_and_resumes_after_restart() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let binary = executable();

    let mut first = launch(&directory.0, &source, "nonce_one", "inc_one");
    let socket = directory.0.join("session.sock");
    wait_socket(&socket);
    let mut host = ready_host(&directory.0, &binary, "nonce_one", "inc_one");
    write_message(
        &mut host,
        &subscribe(Some(CursorV1 {
            owner_kind: "session".into(),
            owner_id: "ses_process".into(),
            seq: "0".into(),
            event_digest: "blake3:0000000000000000000000000000000000000000000000000000000000000000"
                .into(),
        })),
    )
    .unwrap();
    let Some(RpcMessageV1::Event(event)) = read_message(&mut host).unwrap() else {
        panic!("expected redacted Session event");
    };
    assert_eq!(event.cursor.seq, "1");
    assert!(!format!("{:?}", event.payload).contains("private"));
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
            subscription_id: "sub_process".into(),
            through: event.cursor.clone(),
        })),
    )
    .unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::Control(control))
            if matches!(control.as_ref(), RpcControlV1::PageEnd {
                subscription_id, through, has_more: false
            } if subscription_id == "sub_process" && through.seq == "1")
    ));

    // The same authenticated process remains available for a later live cursor poll.
    let db = Connection::open(&source).unwrap();
    db.execute(
        "INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(
          'evt_process_1','ses_process',1,'session.next.prompted.1',?1
        )",
        params![r#"{"messageID":"msg_process"}"#],
    )
    .unwrap();
    drop(db);
    let source_hash = fs::read(&source).unwrap();
    write_message(
        &mut host,
        &subscribe(Some(CursorV1 {
            owner_kind: "session".into(),
            owner_id: "ses_process".into(),
            seq: "1".into(),
            event_digest: event.cursor.event_digest.clone(),
        })),
    )
    .unwrap();
    let Some(RpcMessageV1::Event(second_event)) = read_message(&mut host).unwrap() else {
        panic!("expected event after a repeated Subscribe");
    };
    assert_eq!(second_event.cursor.seq, "2");
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
            subscription_id: "sub_process".into(),
            through: second_event.cursor.clone(),
        })),
    )
    .unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::Control(control))
            if matches!(control.as_ref(), RpcControlV1::PageEnd {
                through, has_more: false, ..
            } if through.seq == "2")
    ));
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Unsubscribe {
            subscription_id: "sub_process".into(),
        })),
    )
    .unwrap();
    assert!(first.0.wait().unwrap().success());
    assert_eq!(fs::read(&source).unwrap(), source_hash);
    assert_eq!(
        fs::read_to_string(directory.0.join("supervisor.epoch")).unwrap(),
        "1"
    );
    drop(host);

    let mut restarted = launch(&directory.0, &source, "nonce_two", "inc_two");
    wait_socket(&socket);
    let mut host = ready_host(&directory.0, &binary, "nonce_two", "inc_two");
    write_message(&mut host, &subscribe(Some(second_event.cursor.clone()))).unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::Control(control))
            if matches!(control.as_ref(), RpcControlV1::PageEnd {
                through, has_more: false, ..
            } if through.seq == "2")
    ));
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Unsubscribe {
            subscription_id: "sub_process".into(),
        })),
    )
    .unwrap();
    assert!(restarted.0.wait().unwrap().success());
    assert_eq!(
        fs::read_to_string(directory.0.join("supervisor.epoch")).unwrap(),
        "2"
    );
}

#[test]
fn corrupt_event_database_fails_before_ready_and_preserves_source_bytes() {
    let directory = TestDir::new();
    let source = directory.0.join("corrupt.db");
    fs::write(&source, b"not a sqlite database").unwrap();
    let before = fs::read(&source).unwrap();

    let mut child = launch(&directory.0, &source, "nonce_bad", "inc_bad");
    let status = child.0.wait().unwrap();
    assert!(!status.success());
    assert!(!directory.0.join("session.sock").exists());
    assert_eq!(fs::read(source).unwrap(), before);
}

#[test]
fn unsupported_event_table_contract_fails_before_ready_and_is_not_modified() {
    let directory = TestDir::new();
    let source = directory.0.join("unsupported.db");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("CREATE TABLE event (id TEXT PRIMARY KEY, payload TEXT NOT NULL);")
        .unwrap();
    drop(db);
    let before = fs::read(&source).unwrap();

    let mut child = launch(&directory.0, &source, "nonce_schema", "inc_schema");
    let status = child.0.wait().unwrap();
    assert!(!status.success());
    assert!(!directory.0.join("session.sock").exists());
    assert_eq!(fs::read(source).unwrap(), before);
}

#[test]
fn missing_retained_projection_cursor_returns_typed_resnapshot_control() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let db = Connection::open(&source).unwrap();
    db.execute(
        "INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(
          'evt_process_1','ses_process',1,'session.next.prompted.1',?1
        )",
        params![r#"{"messageID":"msg_process"}"#],
    )
    .unwrap();
    drop(db);

    let binary = executable();
    let mut child = launch(&directory.0, &source, "nonce_gap", "inc_gap");
    wait_socket(&directory.0.join("session.sock"));
    let projection = Connection::open(directory.0.join("session-projection.sqlite")).unwrap();
    projection
        .execute(
            "DELETE FROM hc_session_receipts WHERE session_id='ses_process' AND seq=0",
            [],
        )
        .unwrap();
    drop(projection);
    let mut host = ready_host(&directory.0, &binary, "nonce_gap", "inc_gap");
    let requested = CursorV1 {
        owner_kind: "session".into(),
        owner_id: "ses_process".into(),
        seq: "1".into(),
        event_digest: "blake3:0000000000000000000000000000000000000000000000000000000000000000"
            .into(),
    };
    write_message(&mut host, &subscribe(Some(requested.clone()))).unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::Control(control))
            if matches!(control.as_ref(), RpcControlV1::ResnapshotRequired {
                subscription_id, requested: got, latest
            } if subscription_id == "sub_process" && got == &requested && latest.seq == "2")
    ));
    assert!(child.0.wait().unwrap().success());
}

#[test]
fn hardlinked_projection_cannot_make_the_supervisor_write_to_opencode() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let before = fs::read(&source).unwrap();
    std::fs::hard_link(&source, directory.0.join("session-projection.sqlite")).unwrap();

    let mut child = launch(&directory.0, &source, "nonce_alias", "inc_alias");
    let status = child.0.wait().unwrap();
    assert!(!status.success());
    assert!(!directory.0.join("session.sock").exists());
    assert_eq!(fs::read(source).unwrap(), before);
}

#[test]
fn malformed_subscribe_owner_cursor_is_rejected_before_event_dispatch() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let binary = executable();
    let mut child = launch(&directory.0, &source, "nonce_owner", "inc_owner");
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_host(&directory.0, &binary, "nonce_owner", "inc_owner");
    let cursor = Value::Map(BTreeMap::from([
        ("ownerKind".into(), Value::String("session".into())),
        ("ownerId".into(), Value::String("ses_process".into())),
        ("seq".into(), Value::String("0".into())),
        (
            "eventDigest".into(),
            Value::String(
                "blake3:0000000000000000000000000000000000000000000000000000000000000000".into(),
            ),
        ),
    ]));
    let malicious = Value::Map(BTreeMap::from([
        ("kind".into(), Value::String("subscribe".into())),
        ("subscriptionId".into(), Value::String("sub_process".into())),
        ("ownerKind".into(), Value::String("session".into())),
        ("ownerId".into(), Value::String("ses_other".into())),
        ("after".into(), cursor),
    ]));
    let frame = messagepack::encode(&malicious, messagepack::FRAME_LIMITS).unwrap();
    write_frame(&mut host, &frame).unwrap();
    assert_eq!(read_message(&mut host).unwrap(), None);
    assert!(!child.0.wait().unwrap().success());
}

#[test]
fn supervisor_refuses_subscribing_to_a_session_outside_its_validated_scope() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let binary = executable();
    let mut child = launch(&directory.0, &source, "nonce_scope", "inc_scope");
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_host(&directory.0, &binary, "nonce_scope", "inc_scope");
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
            subscription_id: "sub_process".into(),
            owner_kind: "session".into(),
            owner_id: "ses_other".into(),
            after: Some(CursorV1 {
                owner_kind: "session".into(),
                owner_id: "ses_other".into(),
                seq: "0".into(),
                event_digest:
                    "blake3:0000000000000000000000000000000000000000000000000000000000000000"
                        .into(),
            }),
        })),
    )
    .unwrap();
    assert_eq!(read_message(&mut host).unwrap(), None);
    assert!(!child.0.wait().unwrap().success());
}

#[test]
fn invalid_arguments_exit_without_creating_runtime_state() {
    let directory = TestDir::new();
    let output = Command::new(executable())
        .arg("--source")
        .arg("missing")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
}

#[test]
fn host_build_digest_cli_hashes_a_regular_file_and_rejects_symlinks() {
    let directory = TestDir::new();
    let host = directory.0.join("host executable");
    fs::write(&host, b"host artifact bytes").unwrap();

    let output = Command::new(executable())
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

    let alias = directory.0.join("host alias");
    std::os::unix::fs::symlink(&host, &alias).unwrap();
    let output = Command::new(executable())
        .arg(format!("--digest-host-executable={}", alias.display()))
        .output()
        .unwrap();
    assert!(!output.status.success());
}

const TEST_TURN_CONTEXT_DIGEST: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
fn tool_call(path: &str, content: &str, capability: &str) -> Value {
    value_map([
        ("callId", Value::String("call_write".into())),
        ("capabilityId", Value::String(capability.into())),
        (
            "arguments",
            value_map([
                ("path", Value::String(path.into())),
                ("content", Value::String(content.into())),
            ]),
        ),
    ])
}

fn prepare_body(path: &str, content: &str) -> Value {
    prepare_body_with_context(path, content, TEST_TURN_CONTEXT_DIGEST)
}

fn prepare_body_with_context(path: &str, content: &str, turn_context_digest: &str) -> Value {
    value_map([
        ("sessionId", Value::String("ses_process".into())),
        ("batchId", Value::String("batch_effect".into())),
        (
            "turnContextDigest",
            Value::String(turn_context_digest.into()),
        ),
        (
            "calls",
            Value::Array(vec![tool_call(path, content, "files.write")]),
        ),
    ])
}

fn approval_body(session_id: &str, challenge_id: &str, approved: bool) -> Value {
    value_map([
        ("sessionId", Value::String(session_id.into())),
        ("challengeId", Value::String(challenge_id.into())),
        ("approved", Value::Bool(approved)),
    ])
}

fn execute_body(session_id: &str, challenge_id: &str, content: &str) -> Value {
    value_map([
        ("sessionId", Value::String(session_id.into())),
        ("challengeId", Value::String(challenge_id.into())),
        ("content", Value::String(content.into())),
    ])
}

fn challenge_id(response: &RpcResponseV1) -> String {
    response_string(response, "challengeId").to_owned()
}

#[test]
fn effects_rpc_requires_one_approved_bound_write_and_fails_closed_on_paths_and_replay() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let outside_dir = directory.0.join("outside");
    fs::create_dir(&outside_dir).unwrap();
    let outside_file = outside_dir.join("outside.txt");
    fs::write(&outside_file, b"outside").unwrap();
    std::os::unix::fs::symlink(&outside_dir, workspace.join("escape")).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();

    let binary = executable();
    let mut child = launch_with_workspace_root(
        &directory.0,
        &source,
        "nonce_effects",
        "inc_effects",
        Some(&workspace),
    );
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_host(&directory.0, &binary, "nonce_effects", "inc_effects");

    let expired_target = workspace.join("expired.txt");
    let expired = send_effect_request_with_deadline(
        &mut host,
        "prepare_tool_batch",
        prepare_body(expired_target.to_str().unwrap(), "must not be prepared"),
        1,
    );
    assert_eq!(expired.outcome, RpcOutcomeV1::Error);
    assert_eq!(expired.error.as_ref().unwrap().code, "deadline_exceeded");
    assert!(!expired_target.exists());
    let invalid_context_target = workspace.join("invalid-context.txt");
    let invalid_context = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body_with_context(
            invalid_context_target.to_str().unwrap(),
            "must not be prepared",
            "not-a-sha256-digest",
        ),
    );
    assert_eq!(invalid_context.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        invalid_context.error.as_ref().unwrap().code,
        "invalid_effect_request"
    );
    assert!(!invalid_context_target.exists());

    let unsupported = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        value_map([
            ("sessionId", Value::String("ses_process".into())),
            ("batchId", Value::String("batch_unsupported".into())),
            (
                "turnContextDigest",
                Value::String(TEST_TURN_CONTEXT_DIGEST.into()),
            ),
            (
                "calls",
                Value::Array(vec![tool_call("unsupported.txt", "secret", "unsupported.capability")]),
            ),
        ]),
    );
    assert_eq!(unsupported.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&unsupported, "status"), "denied");
    assert!(!workspace.join("unsupported.txt").exists());

    let multiple = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        value_map([
            ("sessionId", Value::String("ses_process".into())),
            ("batchId", Value::String("batch_multiple".into())),
            (
                "turnContextDigest",
                Value::String(TEST_TURN_CONTEXT_DIGEST.into()),
            ),
            (
                "calls",
                Value::Array(vec![
                    tool_call("first.txt", "first", "files.write"),
                    tool_call("second.txt", "second", "files.write"),
                ]),
            ),
        ]),
    );
    assert_eq!(multiple.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&multiple, "status"), "denied");
    assert!(!workspace.join("first.txt").exists());

    let malformed = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        value_map([
            ("sessionId", Value::String("ses_process".into())),
            ("batchId", Value::String("batch_malformed".into())),
            (
                "turnContextDigest",
                Value::String(TEST_TURN_CONTEXT_DIGEST.into()),
            ),
            (
                "calls",
                Value::Array(vec![value_map([
                    ("callId", Value::String("call_write".into())),
                    ("capabilityId", Value::String("files.write".into())),
                    (
                        "arguments",
                        value_map([("path", Value::String("malformed.txt".into()))]),
                    ),
                ])]),
            ),
        ]),
    );
    assert_eq!(malformed.outcome, RpcOutcomeV1::Error);
    assert!(!workspace.join("malformed.txt").exists());
    assert!(!workspace.join("second.txt").exists());

    let outside = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body(outside_file.to_str().unwrap(), "outside overwrite"),
    );
    assert_eq!(outside.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&outside, "status"), "denied");
    let escaped = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body("escape/outside.txt", "symlink overwrite"),
    );
    assert_eq!(escaped.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&escaped, "status"), "denied");
    let hardlink_path = workspace.join("hardlink.txt");
    fs::hard_link(&outside_file, &hardlink_path).unwrap();
    let hardlinked = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body("hardlink.txt", "hardlink overwrite"),
    );
    assert_eq!(hardlinked.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&hardlinked, "status"), "denied");
    assert_eq!(fs::read(&outside_file).unwrap(), b"outside");

    let target = workspace.join("new.txt");
    let content = "bound content must not enter durable state";
    let prepared = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body(target.to_str().unwrap(), content),
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&prepared, "status"), "needs_approval");
    assert_eq!(
        response_string(&prepared, "target"),
        target.to_str().unwrap()
    );
    assert!(!target.exists());
    let challenge = challenge_id(&prepared);
    assert_eq!(
        prepared.body.as_ref().unwrap(),
        &value_map([
            ("status", Value::String("needs_approval".into())),
            ("challengeId", Value::String(challenge.clone())),
            (
                "effectId",
                Value::String(response_string(&prepared, "effectId").to_owned()),
            ),
            ("target", Value::String(target.to_str().unwrap().to_owned())),
            (
                "resource",
                Value::String(response_string(&prepared, "resource").to_owned()),
            ),
            ("existed", Value::Bool(false)),
        ])
    );
    let persisted = fs::read(directory.0.join("effects.sqlite")).unwrap();
    assert!(
        !persisted
            .windows(content.len())
            .any(|window| window == content.as_bytes())
    );
    let stored_content_digest: String = Connection::open(directory.0.join("effects.sqlite"))
        .unwrap()
        .query_row(
            "SELECT content_digest FROM effect_challenges WHERE challenge_id=?1",
            [&challenge],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored_content_digest,
        format!("blake3:{}", blake3::hash(content.as_bytes()).to_hex())
    );

    let unapproved = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &challenge, content),
    );
    assert_eq!(unapproved.outcome, RpcOutcomeV1::Error);
    assert!(!target.exists());

    let wrong_session = send_effect_request(
        &mut host,
        "resolve_approval",
        approval_body("ses_other", &challenge, true),
    );
    assert_eq!(wrong_session.outcome, RpcOutcomeV1::Error);
    let approved = send_effect_request(
        &mut host,
        "resolve_approval",
        approval_body("ses_process", &challenge, true),
    );
    assert_eq!(approved.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&approved, "status"), "approved");
    assert_eq!(
        approved.body.as_ref().unwrap(),
        &value_map([("status", Value::String("approved".into()))])
    );

    let wrong_content = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &challenge, "different content"),
    );
    assert_eq!(wrong_content.outcome, RpcOutcomeV1::Error);
    assert!(!target.exists());

    let settled = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &challenge, content),
    );
    assert_eq!(settled.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&settled, "status"), "settled");
    assert_eq!(fs::read(&target).unwrap(), content.as_bytes());
    assert!(response_string(&settled, "receiptDigest").starts_with("blake3:"));
    assert_eq!(
        settled.body.as_ref().unwrap(),
        &value_map([
            ("status", Value::String("settled".into())),
            (
                "effectId",
                Value::String(response_string(&prepared, "effectId").to_owned()),
            ),
            (
                "receiptDigest",
                Value::String(response_string(&settled, "receiptDigest").to_owned()),
            ),
            ("target", Value::String(target.to_str().unwrap().to_owned())),
            (
                "resource",
                Value::String(response_string(&prepared, "resource").to_owned()),
            ),
            ("existed", Value::Bool(false)),
        ])
    );
    let replay = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &challenge, content),
    );
    assert_eq!(replay.outcome, RpcOutcomeV1::Error);
    assert_eq!(fs::read(&target).unwrap(), content.as_bytes());

    let denied_prepared = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body("denied.txt", "never write"),
    );
    let denied_challenge = challenge_id(&denied_prepared);
    let denied = send_effect_request(
        &mut host,
        "resolve_approval",
        approval_body("ses_process", &denied_challenge, false),
    );
    assert_eq!(response_string(&denied, "status"), "denied");
    let denied_execution = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &denied_challenge, "never write"),
    );
    assert_eq!(denied_execution.outcome, RpcOutcomeV1::Error);
    assert!(!workspace.join("denied.txt").exists());

    let expired_prepared = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body("expired.txt", "expired write"),
    );
    let expired_challenge = challenge_id(&expired_prepared);
    send_effect_request(
        &mut host,
        "resolve_approval",
        approval_body("ses_process", &expired_challenge, true),
    );
    Connection::open(directory.0.join("effects.sqlite"))
        .unwrap()
        .execute(
            "UPDATE effect_challenges SET expires_at_ms=0 WHERE challenge_id=?1",
            [&expired_challenge],
        )
        .unwrap();
    let expired = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &expired_challenge, "expired write"),
    );
    assert_eq!(expired.outcome, RpcOutcomeV1::Error);
    assert!(!workspace.join("expired.txt").exists());

    let existing_bom_target = workspace.join("existing-bom.txt");
    fs::write(&existing_bom_target, b"\xef\xbb\xbfold").unwrap();
    let existing_bom_content = "replacement";
    let existing_bom_prepared = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body(existing_bom_target.to_str().unwrap(), existing_bom_content),
    );
    let existing_bom_challenge = challenge_id(&existing_bom_prepared);
    send_effect_request(
        &mut host,
        "resolve_approval",
        approval_body("ses_process", &existing_bom_challenge, true),
    );
    let existing_bom_settled = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &existing_bom_challenge, existing_bom_content),
    );
    assert_eq!(existing_bom_settled.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        fs::read(&existing_bom_target).unwrap(),
        b"\xef\xbb\xbfreplacement"
    );

    let input_bom_target = workspace.join("input-bom.txt");
    fs::write(&input_bom_target, b"old without BOM").unwrap();
    let input_bom_content = "\u{feff}\u{feff}new";
    let input_bom_prepared = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body(input_bom_target.to_str().unwrap(), input_bom_content),
    );
    let input_bom_challenge = challenge_id(&input_bom_prepared);
    send_effect_request(
        &mut host,
        "resolve_approval",
        approval_body("ses_process", &input_bom_challenge, true),
    );
    let input_bom_settled = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &input_bom_challenge, input_bom_content),
    );
    assert_eq!(input_bom_settled.outcome, RpcOutcomeV1::Ok);
    assert_eq!(fs::read(&input_bom_target).unwrap(), b"\xef\xbb\xbfnew");

    drop(host);
    assert!(child.0.wait().unwrap().success());
}

#[test]
fn files_patch_approves_and_applies_ordered_multi_file_operations() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("update.txt"), b"before").unwrap();
    fs::set_permissions(workspace.join("update.txt"),fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(workspace.join("preserve.txt"), b"preserve").unwrap();
    fs::set_permissions(workspace.join("preserve.txt"),fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(workspace.join("remove.txt"), b"remove").unwrap();
    fs::write(workspace.join("move_from.txt"), b"moving").unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut child = launch_with_workspace_root(&directory.0, &source, "nonce_patch", "inc_patch", Some(&workspace));
    wait_socket(&directory.0.join("session.sock"));
    let binary = executable();
    let mut host = ready_host(&directory.0, &binary, "nonce_patch", "inc_patch");
    let prepare_patch = |batch: &str, ops: Value| value_map([
        ("sessionId",Value::String("ses_process".into())),
        ("batchId",Value::String(batch.into())),
        ("turnContextDigest",Value::String(TEST_TURN_CONTEXT_DIGEST.into())),
        ("calls",Value::Array(vec![value_map([
            ("callId",Value::String("patch_call".into())),
            ("capabilityId",Value::String("files.patch".into())),
            ("arguments",value_map([("operations",ops)])),
        ])])),
    ]);
    let duplicate = Value::Array(vec![
        value_map([("operation",Value::String("write".into())),("path",Value::String("duplicate.txt".into())),("expectedBeforeBase64",Value::Nil),("contentBase64",Value::String("YQ==".into()))]),
        value_map([("operation",Value::String("write".into())),("path",Value::String("duplicate.txt".into())),("expectedBeforeBase64",Value::Nil),("contentBase64",Value::String("Yg==".into()))]),
    ]);
    let duplicate_result = send_effect_request(&mut host,"prepare_tool_batch",prepare_patch("patch_duplicate",duplicate));
    assert_eq!(response_string(&duplicate_result,"status"),"denied");
    assert!(!workspace.join("duplicate.txt").exists());
    let malformed = Value::Array(vec![value_map([
        ("operation",Value::String("write".into())),
        ("path",Value::String("malformed.txt".into())),
        ("expectedBeforeBase64",Value::Nil),
        ("contentBase64",Value::String("%%%".into())),
    ])]);
    let malformed_mode = Value::Array(vec![value_map([
        ("operation",Value::String("write".into())),
        ("path",Value::String("malformed-mode.txt".into())),
        ("expectedBeforeBase64",Value::Nil),
        ("contentBase64",Value::String("YQ==".into())),
        ("executable",Value::String("true".into())),
    ])]);
    let malformed_mode_result = send_effect_request(&mut host,"prepare_tool_batch",prepare_patch("patch_malformed_mode",malformed_mode));
    assert_eq!(malformed_mode_result.outcome,RpcOutcomeV1::Error);
    assert!(!workspace.join("malformed-mode.txt").exists());
    let malformed_result = send_effect_request(&mut host,"prepare_tool_batch",prepare_patch("patch_malformed",malformed));
    assert_eq!(malformed_result.outcome,RpcOutcomeV1::Error);
    assert!(!workspace.join("malformed.txt").exists());
    let stale = Value::Array(vec![value_map([
        ("operation",Value::String("write".into())),
        ("path",Value::String("update.txt".into())),
        ("expectedBeforeBase64",Value::String("d3Jvbmc=".into())),
        ("contentBase64",Value::String("YQ==".into())),
    ])]);
    let stale_result = send_effect_request(&mut host,"prepare_tool_batch",prepare_patch("patch_stale",stale));
    assert_eq!(response_string(&stale_result,"status"),"denied");
    assert_eq!(fs::read(workspace.join("update.txt")).unwrap(),b"before");
    let oversized = Value::Array(vec![value_map([
        ("operation",Value::String("write".into())),
        ("path",Value::String("oversized.txt".into())),
        ("expectedBeforeBase64",Value::Nil),
        ("contentBase64",Value::String("A".repeat(2_796_204))),
    ])]);
    let oversized_result = send_effect_request(&mut host,"prepare_tool_batch",prepare_patch("patch_oversized",oversized));
    assert_eq!(response_string(&oversized_result,"status"),"denied");
    assert!(!workspace.join("oversized.txt").exists());
    let outside = directory.0.join("patch-outside.txt");
    fs::write(&outside,b"outside").unwrap();
    std::os::unix::fs::symlink(&outside,workspace.join("patch-symlink.txt")).unwrap();
    std::fs::hard_link(&outside,workspace.join("patch-hardlink.txt")).unwrap();
    for (batch,path) in [
        ("patch_outside","../patch-outside.txt"),
        ("patch_symlink","patch-symlink.txt"),
        ("patch_hardlink","patch-hardlink.txt"),
    ] {
        let request = Value::Array(vec![value_map([
            ("operation",Value::String("write".into())),
            ("path",Value::String(path.into())),
            ("expectedBeforeBase64",Value::String("b3V0c2lkZQ==".into())),
            ("contentBase64",Value::String("bmV3".into())),
        ])]);
        let response = send_effect_request(&mut host,"prepare_tool_batch",prepare_patch(batch,request));
        assert_eq!(response_string(&response,"status"),"denied");
    }
    assert_eq!(fs::read(&outside).unwrap(),b"outside");
    let partially_valid = Value::Array(vec![
        value_map([
            ("operation",Value::String("write".into())),
            ("path",Value::String("should-not-create.txt".into())),
            ("expectedBeforeBase64",Value::Nil),
            ("contentBase64",Value::String("bmV3".into())),
        ]),
        value_map([
            ("operation",Value::String("write".into())),
            ("path",Value::String("patch-hardlink.txt".into())),
            ("expectedBeforeBase64",Value::String("b3V0c2lkZQ==".into())),
            ("contentBase64",Value::String("bmV3".into())),
        ]),
    ]);
    let partial_result = send_effect_request(&mut host,"prepare_tool_batch",prepare_patch("patch_all_validate",partially_valid));
    assert_eq!(response_string(&partial_result,"status"),"denied");
    assert!(!workspace.join("should-not-create.txt").exists());
    let operations = Value::Array(vec![
        value_map([
            ("operation",Value::String("write".into())),
            ("path",Value::String("update.txt".into())),
            ("expectedBeforeBase64",Value::String("YmVmb3Jl".into())),
            ("contentBase64",Value::String("YWZ0ZXI=".into())),
            ("executable",Value::Bool(false)),
        ]),
        value_map([
            ("operation",Value::String("write".into())),
            ("path",Value::String("created.txt".into())),
            ("expectedBeforeBase64",Value::Nil),
            ("contentBase64",Value::String("Y3JlYXRlZA==".into())),
        ]),
        value_map([
            ("operation",Value::String("delete".into())),
            ("path",Value::String("remove.txt".into())),
            ("expectedBeforeBase64",Value::String("cmVtb3Zl".into())),
        ]),
        value_map([
            ("operation",Value::String("write".into())),
            ("path",Value::String("preserve.txt".into())),
            ("expectedBeforeBase64",Value::String("cHJlc2VydmU=".into())),
            ("contentBase64",Value::String("cHJlc2VydmVk".into())),
        ]),
        value_map([
            ("operation",Value::String("write".into())),
            ("path",Value::String("script.sh".into())),
            ("expectedBeforeBase64",Value::Nil),
            ("contentBase64",Value::String("cnVu".into())),
            ("executable",Value::Bool(true)),
        ]),
        value_map([
            ("operation",Value::String("write".into())),
            ("path",Value::String("move_to.txt".into())),
            ("expectedBeforeBase64",Value::Nil),
            ("contentBase64",Value::String("bW92aW5n".into())),
        ]),
        value_map([
            ("operation",Value::String("delete".into())),
            ("path",Value::String("move_from.txt".into())),
            ("expectedBeforeBase64",Value::String("bW92aW5n".into())),
        ]),
    ]);
    let prepare = value_map([
        ("sessionId",Value::String("ses_process".into())),
        ("batchId",Value::String("patch_batch".into())),
        ("turnContextDigest",Value::String(TEST_TURN_CONTEXT_DIGEST.into())),
        ("calls",Value::Array(vec![value_map([
            ("callId",Value::String("patch_call".into())),
            ("capabilityId",Value::String("files.patch".into())),
            ("arguments",value_map([("operations",operations.clone())])),
        ])])),
    ]);
    let prepared = send_effect_request(&mut host,"prepare_tool_batch",prepare);
    assert_eq!(response_string(&prepared,"status"),"needs_approval");
    assert!(matches!(
        prepared.body.as_ref().and_then(|body| match body {
            Value::Map(map) => map.get("targets"),
            _ => None,
        }),
        Some(Value::Array(targets)) if targets.len() == 7
    ));
    let target_descriptors = match prepared.body.as_ref().and_then(|body| match body {
        Value::Map(map) => map.get("targets"),
        _ => None,
    }) {
        Some(Value::Array(targets)) => targets,
        _ => panic!("missing patch target descriptors"),
    };
    assert!(matches!(&target_descriptors[0],Value::Map(map) if map.get("executable")==Some(&Value::Bool(false))));
    assert!(matches!(&target_descriptors[4],Value::Map(map) if map.get("executable")==Some(&Value::Bool(true))));
    let durable = fs::read(directory.0.join("effects.sqlite")).unwrap();
    assert!(!durable.windows(b"Y3JlYXRlZA==".len()).any(|window| window == b"Y3JlYXRlZA=="));
    let challenge = challenge_id(&prepared);
    let approved = send_effect_request(&mut host,"resolve_approval",approval_body("ses_process",&challenge,true));
    assert_eq!(approved.outcome,RpcOutcomeV1::Ok);
    let mismatched = send_effect_request(&mut host,"execute_patch",value_map([
        ("sessionId",Value::String("ses_process".into())),
        ("challengeId",Value::String(challenge.clone())),
        ("operations",Value::Array(vec![])),
    ]));
    assert_eq!(mismatched.outcome,RpcOutcomeV1::Error);
    let mut wrong_postimage = operations.clone();
    if let Value::Array(values) = &mut wrong_postimage
        && let Value::Map(first) = &mut values[0]
    {
        first.insert("contentBase64".into(),Value::String("YWJj".into()));
    }
    let changed = send_effect_request(&mut host,"execute_patch",value_map([
        ("sessionId",Value::String("ses_process".into())),
        ("challengeId",Value::String(challenge.clone())),
        ("operations",wrong_postimage),
    ]));
    assert_eq!(changed.outcome,RpcOutcomeV1::Error);
    let mut wrong_mode = operations.clone();
    if let Value::Array(values) = &mut wrong_mode
        && let Value::Map(first) = &mut values[0]
    {
        first.insert("executable".into(),Value::Bool(true));
    }
    let changed_mode = send_effect_request(&mut host,"execute_patch",value_map([
        ("sessionId",Value::String("ses_process".into())),
        ("challengeId",Value::String(challenge.clone())),
        ("operations",wrong_mode),
    ]));
    assert_eq!(changed_mode.outcome,RpcOutcomeV1::Error);
    let executed = send_effect_request(&mut host,"execute_patch",value_map([
        ("sessionId",Value::String("ses_process".into())),
        ("challengeId",Value::String(challenge.clone())),
        ("operations",operations),
    ]));
    assert_eq!(response_string(&executed,"status"),"settled");
    assert_eq!(fs::read(workspace.join("update.txt")).unwrap(),b"after");
    assert_eq!(fs::read(workspace.join("created.txt")).unwrap(),b"created");
    assert!(!workspace.join("remove.txt").exists());
    assert_eq!(fs::read(workspace.join("move_to.txt")).unwrap(),b"moving");
    assert!(!workspace.join("move_from.txt").exists());
    assert_eq!(fs::metadata(workspace.join("update.txt")).unwrap().permissions().mode() & 0o777,0o644);
    assert_eq!(fs::metadata(workspace.join("created.txt")).unwrap().permissions().mode() & 0o777,0o644);
    assert_eq!(fs::metadata(workspace.join("preserve.txt")).unwrap().permissions().mode() & 0o777,0o755);
    assert_eq!(fs::metadata(workspace.join("script.sh")).unwrap().permissions().mode() & 0o777,0o755);
    let replay = send_effect_request(&mut host,"execute_patch",value_map([
        ("sessionId",Value::String("ses_process".into())),
        ("challengeId",Value::String(challenge)),
        ("operations",Value::Array(vec![])),
    ]));
    assert_eq!(replay.outcome,RpcOutcomeV1::Error);
    let denied_prepared = send_effect_request(&mut host,"prepare_tool_batch",prepare_patch("patch_denied",Value::Array(vec![value_map([
        ("operation",Value::String("write".into())),
        ("path",Value::String("patch-denied.txt".into())),
        ("expectedBeforeBase64",Value::Nil),
        ("contentBase64",Value::String("bm8=".into())),
    ])])));
    let denied_challenge = challenge_id(&denied_prepared);
    send_effect_request(&mut host,"resolve_approval",approval_body("ses_process",&denied_challenge,false));
    let denied_execute = send_effect_request(&mut host,"execute_patch",value_map([
        ("sessionId",Value::String("ses_process".into())),
        ("challengeId",Value::String(denied_challenge)),
        ("operations",Value::Array(vec![value_map([
            ("operation",Value::String("write".into())),
            ("path",Value::String("patch-denied.txt".into())),
            ("expectedBeforeBase64",Value::Nil),
            ("contentBase64",Value::String("bm8=".into())),
        ])])),
    ]));
    assert_eq!(denied_execute.outcome,RpcOutcomeV1::Error);
    assert!(!workspace.join("patch-denied.txt").exists());
    drop(host);
    assert!(child.0.wait().unwrap().success());
}

#[test]
fn files_patch_restart_reconciles_all_before_all_after_and_mixed() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut child = launch_with_workspace_root(&directory.0,&source,"nonce_patch_recovery","inc_patch_recovery",Some(&workspace));
    wait_socket(&directory.0.join("session.sock"));
    let binary = executable();
    let mut host = ready_host(&directory.0,&binary,"nonce_patch_recovery","inc_patch_recovery");
    let prepare = |batch: &str, operations: Value| value_map([
        ("sessionId",Value::String("ses_process".into())),
        ("batchId",Value::String(batch.into())),
        ("turnContextDigest",Value::String(TEST_TURN_CONTEXT_DIGEST.into())),
        ("calls",Value::Array(vec![value_map([
            ("callId",Value::String("patch_recovery".into())),
            ("capabilityId",Value::String("files.patch".into())),
            ("arguments",value_map([("operations",operations)])),
        ])])),
    ]);
    let operation = |path: &str, post: &str| value_map([
        ("operation",Value::String("write".into())),
        ("path",Value::String(path.into())),
        ("expectedBeforeBase64",Value::Nil),
        ("contentBase64",Value::String(post.into())),
    ]);
    let before_challenge = challenge_id(&send_effect_request(&mut host,"prepare_tool_batch",prepare("recover_before",Value::Array(vec![operation("before.txt","YQ==")]))));
    let after_challenge = challenge_id(&send_effect_request(&mut host,"prepare_tool_batch",prepare("recover_after",Value::Array(vec![operation("after.txt","Yg==")]))));
    let mixed_challenge = challenge_id(&send_effect_request(&mut host,"prepare_tool_batch",prepare("recover_mixed",Value::Array(vec![operation("mixed_one.txt","b25l"),operation("mixed_two.txt","dHdv")]))));
    for challenge in [&before_challenge,&after_challenge,&mixed_challenge] {
        send_effect_request(&mut host,"resolve_approval",approval_body("ses_process",challenge,true));
    }
    fs::write(workspace.join("after.txt"),b"b").unwrap();
    fs::set_permissions(workspace.join("after.txt"),fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(workspace.join("mixed_one.txt"),b"one").unwrap();
    fs::set_permissions(workspace.join("mixed_one.txt"),fs::Permissions::from_mode(0o644)).unwrap();
    let digest = |bytes: &[u8]| format!("blake3:{}",blake3::hash(bytes).to_hex());
    let manifest = |entries: &[(&str,&str)]| {
        let mut hasher = blake3::Hasher::new();
        let mode = 0o644u32.to_be_bytes();
        for (path,digest) in entries {
            for field in [path.as_bytes(),digest.as_bytes(),&mode] {
                hasher.update(&(field.len() as u64).to_be_bytes());
                hasher.update(field);
            }
        }
        format!("blake3:{}",hasher.finalize().to_hex())
    };
    let db = Connection::open(directory.0.join("effects.sqlite")).unwrap();
    for (challenge,after) in [
        (&before_challenge,manifest(&[("before.txt",&digest(b"a"))])),
        (&after_challenge,manifest(&[("after.txt",&digest(b"b"))])),
        (&mixed_challenge,manifest(&[("mixed_one.txt",&digest(b"one")),("mixed_two.txt",&digest(b"two"))])),
    ] {
        db.execute("UPDATE effect_challenges SET status='PREPARED',after_digest=?1,lease_id='recovery_lease' WHERE challenge_id=?2",rusqlite::params![after,challenge]).unwrap();
    }
    drop(db);
    drop(host);
    assert!(child.0.wait().unwrap().success());
    let mut restarted = launch_with_workspace_root(&directory.0,&source,"nonce_patch_recovery_2","inc_patch_recovery_2",Some(&workspace));
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_host(&directory.0,&binary,"nonce_patch_recovery_2","inc_patch_recovery_2");
    let db = Connection::open(directory.0.join("effects.sqlite")).unwrap();
    let status = |challenge: &str| db.query_row("SELECT status FROM effect_challenges WHERE challenge_id=?1",[challenge],|row|row.get::<_,String>(0)).unwrap();
    assert_eq!(status(&before_challenge),"NOT_APPLIED");
    assert_eq!(status(&after_challenge),"SETTLED");
    assert_eq!(status(&mixed_challenge),"UNKNOWN");
    assert!(!workspace.join("before.txt").exists());
    assert!(!workspace.join("mixed_two.txt").exists());
    drop(db);
    drop(host);
    assert!(restarted.0.wait().unwrap().success());
}

#[test]
fn effects_rpc_denies_when_workspace_root_is_unconfigured() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let binary = executable();
    let mut child = launch(&directory.0, &source, "nonce_no_root", "inc_no_root");
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_host(&directory.0, &binary, "nonce_no_root", "inc_no_root");
    let response = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body("no-root.txt", "no write"),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&response, "status"), "denied");
    assert_eq!(
        response_string(&response, "reason"),
        "workspace_root_unconfigured"
    );
    assert!(!directory.0.join("no-root.txt").exists());
    drop(host);
    assert!(child.0.wait().unwrap().success());
}

#[test]
fn approved_effect_survives_supervisor_restart_without_requiring_reapproval() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let target = workspace.join("restart-approved.txt");
    let content = "persisted approval";
    let binary = executable();

    let mut first = launch_with_workspace_root(
        &directory.0,
        &source,
        "nonce_approval_first",
        "inc_approval_first",
        Some(&workspace),
    );
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_host(
        &directory.0,
        &binary,
        "nonce_approval_first",
        "inc_approval_first",
    );
    let prepared = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body(target.to_str().unwrap(), content),
    );
    let challenge = challenge_id(&prepared);
    let approval = send_effect_request(
        &mut host,
        "resolve_approval",
        approval_body("ses_process", &challenge, true),
    );
    assert_eq!(response_string(&approval, "status"), "approved");
    drop(host);
    assert!(first.0.wait().unwrap().success());

    let mut restarted = launch_with_workspace_root(
        &directory.0,
        &source,
        "nonce_approval_second",
        "inc_approval_second",
        Some(&workspace),
    );
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_host(
        &directory.0,
        &binary,
        "nonce_approval_second",
        "inc_approval_second",
    );
    let settled = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &challenge, content),
    );
    assert_eq!(settled.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&settled, "status"), "settled");
    assert_eq!(fs::read(&target).unwrap(), content.as_bytes());
    drop(host);
    assert!(restarted.0.wait().unwrap().success());
}

#[test]
fn effect_recovery_settles_matching_prepared_and_blocks_mismatched_target() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let reconciled = workspace.join("reconciled.txt");
    let unknown = workspace.join("unknown.txt");
    fs::write(&reconciled, b"after bytes").unwrap();
    fs::write(&unknown, b"before bytes").unwrap();
    let after_digest = format!("blake3:{}", blake3::hash(b"after bytes").to_hex());
    let wrong_digest = format!("blake3:{}", blake3::hash(b"expected other bytes").to_hex());
    let effects_db = Connection::open(directory.0.join("effects.sqlite")).unwrap();
    effects_db
        .execute_batch(
            "CREATE TABLE effect_challenges (
                challenge_id TEXT PRIMARY KEY,
                effect_id TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                call_id TEXT NOT NULL,
                capability_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                requested_path TEXT NOT NULL,
                target TEXT NOT NULL,
                resource TEXT NOT NULL,
                existed INTEGER NOT NULL CHECK (existed IN (0, 1)),
                argument_digest TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                approved INTEGER,
                after_digest TEXT,
                lease_id TEXT,
                receipt_digest TEXT,
                turn_context_digest TEXT NOT NULL
            );",
        )
        .unwrap();
    let workspace_metadata = fs::metadata(&workspace).unwrap();
    let workspace_binding = guard::workspace_binding(
        &workspace,
        workspace_metadata.dev(),
        workspace_metadata.ino(),
    );
    let content_digest = format!(
        "blake3:{}",
        blake3::hash(b"not persisted test content").to_hex()
    );
    for (challenge_id, effect_id, path, digest) in [
        (
            "prepared_done",
            "effect_done",
            "reconciled.txt",
            &after_digest,
        ),
        (
            "prepared_unknown",
            "effect_unknown",
            "unknown.txt",
            &wrong_digest,
        ),
    ] {
        let target = workspace.join(path);
        let argument_digest = guard::argument_digest(
            "ses_process",
            "batch",
            "call",
            "files.write",
            path,
            &content_digest,
        );
        let policy_snapshot_ids = [guard::WORKSPACE_WRITE_POLICY_ID];
        let requested_guarantees = [
            "beneath_workspace_root",
            "no_symlink",
            "no_hardlink",
            "one_use",
        ];
        let request = guard::AuthorizationRequestV1 {
            request_id: "batch",
            principal: "ses_process",
            origin: guard::EffectOriginV1 {
                session_id: "ses_process",
                batch_id: "batch",
                call_id: "call",
            },
            action_id: "files.write",
            argument_digest: &argument_digest,
            turn_context_digest: TEST_TURN_CONTEXT_DIGEST,
            resource_resolution: guard::ResourceResolutionV1 {
                workspace_root: &workspace,
                workspace_binding: &workspace_binding,
                target: &target,
                resource: path,
            },
            policy_snapshot_ids: &policy_snapshot_ids,
            requested_guarantees: &requested_guarantees,
        };
        let decision = guard::authorize(&request, challenge_id);
        assert_eq!(decision.decision, guard::DecisionKind::Ask);
        let intent_digest = guard::intent_digest(&request, &decision);
        effects_db
            .execute(
                "INSERT INTO effect_challenges (
                    challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
                    relative_path, requested_path, target, resource, existed, argument_digest,
                    content_digest, expires_at_ms, status, approved, after_digest, lease_id,
                    receipt_digest, turn_context_digest
                 ) VALUES (?1, ?2, 'ses_process', 'batch', 'call', 'files.write',
                           ?3, ?4, ?5, ?6, 1, ?7, ?8,
                           9999999999999, 'PREPARED', 1, ?9, 'lease_recovery', NULL, ?10)",
                params![
                    challenge_id,
                    effect_id,
                    path,
                    path,
                    target.to_string_lossy().into_owned(),
                    path,
                    intent_digest,
                    content_digest,
                    digest,
                    TEST_TURN_CONTEXT_DIGEST,
                ],
            )
            .unwrap();
    }
    drop(effects_db);

    let binary = executable();
    let mut child = launch_with_workspace_root(
        &directory.0,
        &source,
        "nonce_recovery",
        "inc_recovery",
        Some(&workspace),
    );
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_host(&directory.0, &binary, "nonce_recovery", "inc_recovery");
    let effects_db = Connection::open(directory.0.join("effects.sqlite")).unwrap();
    let done: (String, Option<String>) = effects_db
        .query_row(
            "SELECT status, receipt_digest FROM effect_challenges WHERE challenge_id='prepared_done'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(done.0, "SETTLED");
    assert!(done.1.unwrap().starts_with("blake3:"));
    let unknown_status: String = effects_db
        .query_row(
            "SELECT status FROM effect_challenges WHERE challenge_id='prepared_unknown'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unknown_status, "UNKNOWN");
    drop(effects_db);
    drop(host);
    assert!(child.0.wait().unwrap().success());
}

#[test]
fn legacy_effect_schema_migrates_and_blocks_contextless_prepared_write() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let target = workspace.join("legacy.txt");
    let content = b"already written before restart";
    fs::write(&target, content).unwrap();
    let content_digest = format!("blake3:{}", blake3::hash(content).to_hex());
    let after_digest = content_digest.clone();

    let effects_db = Connection::open(directory.0.join("effects.sqlite")).unwrap();
    effects_db
        .execute_batch(
            "CREATE TABLE effect_challenges (
                challenge_id TEXT PRIMARY KEY,
                effect_id TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                call_id TEXT NOT NULL,
                capability_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                requested_path TEXT NOT NULL,
                target TEXT NOT NULL,
                resource TEXT NOT NULL,
                existed INTEGER NOT NULL CHECK (existed IN (0, 1)),
                argument_digest TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                approved INTEGER,
                after_digest TEXT,
                lease_id TEXT,
                receipt_digest TEXT
            );
            INSERT INTO effect_challenges (
                challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
                relative_path, requested_path, target, resource, existed, argument_digest,
                content_digest, expires_at_ms, status, approved, after_digest, lease_id,
                receipt_digest
            ) VALUES (
                'legacy_prepared', 'legacy_effect', 'ses_process', 'legacy_batch',
                'legacy_call', 'files.write', 'legacy.txt', 'legacy.txt',
                'LEGACY_TARGET', 'legacy.txt', 0,
                'blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                'LEGACY_CONTENT_DIGEST', 9999999999999, 'PREPARED', 1,
                'LEGACY_AFTER_DIGEST', 'legacy_lease', NULL
            );",
        )
        .unwrap();
    effects_db
        .execute(
            "UPDATE effect_challenges SET target=?1, content_digest=?2, after_digest=?3",
            params![
                target.to_string_lossy().into_owned(),
                content_digest,
                after_digest
            ],
        )
        .unwrap();
    drop(effects_db);

    let binary = executable();
    let mut child = launch_with_workspace_root(
        &directory.0,
        &source,
        "nonce_legacy_effects",
        "inc_legacy_effects",
        Some(&workspace),
    );
    wait_socket(&directory.0.join("session.sock"));
    let host = ready_host(
        &directory.0,
        &binary,
        "nonce_legacy_effects",
        "inc_legacy_effects",
    );
    let effects_db = Connection::open(directory.0.join("effects.sqlite")).unwrap();
    let migrated: (String, Option<String>, String) = effects_db
        .query_row(
            "SELECT status, receipt_digest, turn_context_digest
             FROM effect_challenges WHERE challenge_id='legacy_prepared'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(migrated, ("UNKNOWN".into(), None, String::new()));
    assert_eq!(fs::read(&target).unwrap(), content);
    drop(effects_db);
    drop(host);
    assert!(child.0.wait().unwrap().success());
}
#[test]
fn effects_requests_are_serviced_while_session_page_waits_for_ack() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let target = workspace.join("during-page.txt");
    let binary = executable();
    let mut child = launch_with_workspace_root(
        &directory.0,
        &source,
        "nonce_interleaved",
        "inc_interleaved",
        Some(&workspace),
    );
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_host(
        &directory.0,
        &binary,
        "nonce_interleaved",
        "inc_interleaved",
    );
    write_message(
        &mut host,
        &subscribe(Some(CursorV1 {
            owner_kind: "session".into(),
            owner_id: "ses_process".into(),
            seq: "0".into(),
            event_digest: "blake3:0000000000000000000000000000000000000000000000000000000000000000"
                .into(),
        })),
    )
    .unwrap();
    let Some(RpcMessageV1::Event(event)) = read_message(&mut host).unwrap() else {
        panic!("expected session event before interleaved request");
    };

    let prepared = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body(target.to_str().unwrap(), "interleaved content"),
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok);
    assert_eq!(response_string(&prepared, "status"), "needs_approval");
    let challenge = challenge_id(&prepared);
    assert!(!target.exists());

    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
            subscription_id: "sub_process".into(),
            through: event.cursor,
        })),
    )
    .unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::Control(control))
            if matches!(control.as_ref(), RpcControlV1::PageEnd { .. })
    ));
    let approved = send_effect_request(
        &mut host,
        "resolve_approval",
        approval_body("ses_process", &challenge, true),
    );
    assert_eq!(response_string(&approved, "status"), "approved");
    let settled = send_effect_request(
        &mut host,
        "execute_write",
        execute_body("ses_process", &challenge, "interleaved content"),
    );
    assert_eq!(response_string(&settled, "status"), "settled");
    assert_eq!(fs::read(target).unwrap(), b"interleaved content");

    drop(host);
    assert!(child.0.wait().unwrap().success());
}

#[test]
fn effects_service_is_unavailable_without_effects_handshake_feature() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    source_db(&source);
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let target = workspace.join("old-observer.txt");
    let binary = executable();
    let mut child = launch_with_workspace_root(
        &directory.0,
        &source,
        "nonce_read_only",
        "inc_read_only",
        Some(&workspace),
    );
    wait_socket(&directory.0.join("session.sock"));
    let mut host = ready_observer_without_effect_feature(
        &directory.0,
        &binary,
        "nonce_read_only",
        "inc_read_only",
    );
    let response = send_effect_request(
        &mut host,
        "prepare_tool_batch",
        prepare_body(target.to_str().unwrap(), "must remain unwritten"),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        response.error.as_ref().unwrap().code,
        "feature_not_negotiated"
    );
    assert!(!target.exists());
    drop(host);
    assert!(child.0.wait().unwrap().success());
}
