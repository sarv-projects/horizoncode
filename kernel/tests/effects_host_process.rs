#![cfg(target_os = "linux")]

use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{
    AuthenticatedPrincipalV1, CursorV1, FEATURE_EFFECTS_V2, KernelHelloV1,
    KernelStartupStatusV1, RpcControlV1, RpcMessageV1, RpcOutcomeV1, RpcRequestV1,
    RpcResponseV1, read_message, write_message,
};
use horizoncode_kernel::unix_peer::{
    AuthenticatedUnixStream, UnixPeerPolicy, connect_authenticated,
};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static NEXT: AtomicU64 = AtomicU64::new(0);
const INCARNATION: &str = "inc_effect_process";
const SESSION: &str = "ses_effect_process";
const CONTEXT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hz-effects-process-{}-{}-{}",
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

struct HostProcess {
    _child: TestProcess,
    stream: AuthenticatedUnixStream,
    epoch: u64,
    next_request: u64,
}

impl HostProcess {
    fn launch(state: &std::path::Path, nonce: &str, incarnation: &str, effects: bool) -> Self {
        fs::create_dir_all(state).unwrap();
        fs::set_permissions(state, fs::Permissions::from_mode(0o700)).unwrap();
        let state = fs::canonicalize(state).unwrap();
        // Production starts each host with a nonce-derived socket name, so a restarted host
        // never collides with the stale socket file left by its predecessor.
        let socket = state.join(format!("hz-kernel-{nonce}.sock"));
        let host_exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
        let kernel_exe = fs::canonicalize(env!("CARGO_BIN_EXE_hz-kernel")).unwrap();
        let mut child = TestProcess(
            Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
                .arg(format!("--state-dir={}", state.display()))
                .arg(format!("--socket={}", socket.display()))
                .arg(format!("--host-exe={}", host_exe.display()))
                .arg(format!("--nonce={nonce}"))
                .arg(format!("--incarnation={incarnation}"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !matches!(
            fs::symlink_metadata(&socket),
            Ok(metadata)
                if metadata.file_type().is_socket()
                    && metadata.permissions().mode() & 0o777 == 0o600
        ) {
            assert!(
                Instant::now() < deadline,
                "hz-kernel did not create its owner-only private socket"
            );
            thread::sleep(Duration::from_millis(5));
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
            host_instance_id: "effects_process_test".into(),
            process_incarnation: incarnation.into(),
            supervisor_nonce: nonce.into(),
            required_features: if effects {
                vec![FEATURE_EFFECTS_V2.into()]
            } else {
                vec![]
            },
            optional_features: vec![],
        };
        write_message(&mut stream, &RpcMessageV1::Hello(Box::new(hello))).unwrap();
        let Some(RpcMessageV1::HelloResult(hello)) = read_message(&mut stream).unwrap() else {
            panic!("expected host hello result");
        };
        if effects {
            assert!(
                hello
                    .enabled_features
                    .contains(&FEATURE_EFFECTS_V2.to_owned())
            );
        } else {
            assert!(
                !hello
                    .enabled_features
                    .contains(&FEATURE_EFFECTS_V2.to_owned())
            );
        }
        let mut ready = false;
        for _ in 0..16 {
            match read_message(&mut stream).unwrap().unwrap() {
                RpcMessageV1::StartupStatus(status) if *status == KernelStartupStatusV1::Ready => {
                    ready = true;
                    break;
                }
                RpcMessageV1::StartupStatus(status)
                    if *status == KernelStartupStatusV1::Starting => {}
                other => panic!("unexpected startup frame: {other:?}"),
            }
        }
        assert!(ready, "hz-kernel did not reach READY");
        Self {
            _child: child,
            stream,
            epoch: hello.owner_epoch,
            next_request: 0,
        }
    }

    fn request(&mut self, service: &str, operation: &str, body: Value) -> RpcResponseV1 {
        self.next_request += 1;
        let id = self.next_request;
        let request = RpcRequestV1 {
            owner_epoch: self.epoch,
            process_incarnation: INCARNATION.into(),
            request_id: format!("req_effect_{id}"),
            service_id: service.into(),
            operation: operation.into(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: format!("trace_effect_{id}"),
            body,
        };
        write_message(&mut self.stream, &RpcMessageV1::Request(Box::new(request))).unwrap();
        match read_message(&mut self.stream).unwrap() {
            Some(RpcMessageV1::Response(response)) => *response,
            other => panic!("expected host RPC response, got {other:?}"),
        }
    }

    fn request_server_auth(
        &mut self,
        service: &str,
        operation: &str,
        body: Value,
        subject: &str,
    ) -> RpcResponseV1 {
        self.next_request += 1;
        let id = self.next_request;
        let request = RpcRequestV1 {
            owner_epoch: self.epoch,
            process_incarnation: INCARNATION.into(),
            request_id: format!("req_effect_{id}"),
            service_id: service.into(),
            operation: operation.into(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: now_ms() + 30_000,
            trace_id: format!("trace_effect_{id}"),
            body,
        };
        let request_id = request.request_id.clone();
        write_message(
            &mut self.stream,
            &RpcMessageV1::AuthenticatedRequest {
                request: Box::new(request),
                principal: AuthenticatedPrincipalV1::ServerAuth {
                    subject: subject.to_owned(),
                },
                context: None,
            },
        )
        .unwrap();
        match read_message(&mut self.stream).unwrap() {
            Some(RpcMessageV1::Response(response)) => *response,
            other => panic!("expected host RPC response for {request_id}, got {other:?}"),
        }
    }

    fn register_location(&mut self, root: &std::path::Path) -> String {
        let response = self.request_server_auth(
            FEATURE_EFFECTS_V2,
            "register_location",
            value_map([("canonicalRoot", string(root.to_str().unwrap()))]),
            "effects-process-user",
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
        value_string(response.body.as_ref().unwrap(), "locationID").to_owned()
    }

    fn prepare(
        &mut self,
        location_id: &str,
        batch: &str,
        capability: &str,
        arguments: Value,
    ) -> RpcResponseV1 {
        self.request(
            FEATURE_EFFECTS_V2,
            "prepare_tool_batch",
            value_map([
                ("sessionID", string(SESSION)),
                ("locationID", string(location_id)),
                ("batchID", string(batch)),
                ("turnContextDigest", string(CONTEXT)),
                (
                    "calls",
                    Value::Array(vec![value_map([
                        ("callID", string("call_effect")),
                        ("capabilityID", string(capability)),
                        ("arguments", arguments),
                    ])]),
                ),
            ]),
        )
    }

    fn approve(&mut self, challenge_id: &str, decision: &str) -> RpcResponseV1 {
        self.request(
            FEATURE_EFFECTS_V2,
            "resolve_approval",
            value_map([
                ("challengeID", string(challenge_id)),
                ("decision", string(decision)),
            ]),
        )
    }

    fn execute_write(
        &mut self,
        location_id: &str,
        effect_id: &str,
        lease: &str,
        content: &str,
    ) -> RpcResponseV1 {
        self.request(
            FEATURE_EFFECTS_V2,
            "execute_write",
            value_map([
                ("sessionID", string(SESSION)),
                ("locationID", string(location_id)),
                ("effectID", string(effect_id)),
                ("capabilityLeaseDigest", string(lease)),
                ("content", string(content)),
            ]),
        )
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn value_map<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect::<BTreeMap<_, _>>(),
    )
}

fn value_string<'a>(value: &'a Value, key: &str) -> &'a str {
    let Value::Map(map) = value else {
        panic!("expected map")
    };
    let Some(Value::String(value)) = map.get(key) else {
        panic!("missing string field {key}")
    };
    value
}

fn prepare_write(
    host: &mut HostProcess,
    location: &str,
    batch: &str,
    path: &str,
    content: &str,
) -> (String, String) {
    let prepared = host.prepare(
        location,
        batch,
        "files.write",
        value_map([("path", string(path)), ("content", string(content))]),
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok, "{:?}", prepared.error);
    let body = prepared.body.unwrap();
    assert_eq!(value_string(&body, "status"), "needs_approval");
    (
        value_string(&body, "challengeID").to_owned(),
        value_string(&body, "effectID").to_owned(),
    )
}

#[test]
fn hz_kernel_process_effects_require_guard_approval_and_settle_one_use_write_and_patch() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut host = HostProcess::launch(&state, "effects_nonce", INCARNATION, true);
    let location = host.register_location(&workspace);

    let (challenge, effect) = prepare_write(
        &mut host,
        &location,
        "write_batch",
        "approved.txt",
        "approved content",
    );
    assert!(!workspace.join("approved.txt").exists());
    let unapproved = host.execute_write(&location, &effect, "missing-lease", "approved content");
    assert_eq!(unapproved.outcome, RpcOutcomeV1::Error);
    let approval = host.approve(&challenge, "allow_once");
    assert_eq!(approval.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        value_string(approval.body.as_ref().unwrap(), "status"),
        "approved"
    );
    let lease = value_string(approval.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
    let settled = host.execute_write(&location, &effect, &lease, "approved content");
    assert_eq!(settled.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        value_string(settled.body.as_ref().unwrap(), "status"),
        "settled"
    );
    assert!(value_string(settled.body.as_ref().unwrap(), "receiptDigest").starts_with("blake3:"));
    assert_eq!(
        fs::read(workspace.join("approved.txt")).unwrap(),
        b"approved content"
    );
    let effect_db = state
        .join("effect-locations")
        .join(&location)
        .join("effects.sqlite");
    let durable = fs::read(&effect_db).unwrap();
    assert!(
        !durable
            .windows(b"approved content".len())
            .any(|window| window == b"approved content")
    );
    let content_digest: String = Connection::open(effect_db)
        .unwrap()
        .query_row(
            "SELECT content_digest FROM effect_challenges WHERE effect_id=?1",
            [&effect],
            |row| row.get(0),
        )
        .unwrap();
    assert!(content_digest.starts_with("blake3:"));
    assert_eq!(
        host.execute_write(&location, &effect, &lease, "approved content")
            .outcome,
        RpcOutcomeV1::Error
    );

    let operation = value_map([
        ("operation", string("write")),
        ("path", string("patched.txt")),
        ("expectedBeforeBase64", Value::Nil),
        ("contentBase64", string("cGF0Y2hlZA==")),
    ]);
    let prepared = host.prepare(
        &location,
        "patch_batch",
        "files.patch",
        value_map([("operations", Value::Array(vec![operation.clone()]))]),
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok);
    let body = prepared.body.unwrap();
    assert_eq!(value_string(&body, "status"), "needs_approval");
    let challenge = value_string(&body, "challengeID").to_owned();
    let effect = value_string(&body, "effectID").to_owned();
    let approved = host.approve(&challenge, "allow_once");
    assert_eq!(approved.outcome, RpcOutcomeV1::Ok);
    let lease = value_string(approved.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
    let patched = host.request(
        FEATURE_EFFECTS_V2,
        "execute_patch",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location)),
            ("effectID", string(&effect)),
            ("capabilityLeaseDigest", string(&lease)),
            ("operations", Value::Array(vec![operation])),
        ]),
    );
    assert_eq!(patched.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        value_string(patched.body.as_ref().unwrap(), "status"),
        "settled"
    );
    assert_eq!(fs::read(workspace.join("patched.txt")).unwrap(), b"patched");
}

#[test]
fn hz_kernel_cancel_keeps_prepared_effect_for_unknown_reconciliation() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut host = HostProcess::launch(&state, "prepared_cancel_one", INCARNATION, true);
    let location = host.register_location(&workspace);
    let target = workspace.join("prepared-cancelled.txt");
    let (challenge, effect) = prepare_write(
        &mut host,
        &location,
        "batch_prepared_cancel",
        "prepared-cancelled.txt",
        "must-not-be-replayed",
    );
    assert!(!target.exists());
    let approved = host.approve(&challenge, "allow_once");
    assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);
    let lease = value_string(approved.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();

    // Model the durable crash window after PREPARED is recorded and before the
    // filesystem result is observed. Cancellation must leave this row alone so
    // startup reconciliation, not cancel_batch, determines its final outcome.
    let effect_db = state
        .join("effect-locations")
        .join(&location)
        .join("effects.sqlite");
    let db = Connection::open(&effect_db).unwrap();
    let content_digest: String = db
        .query_row(
            "SELECT content_digest FROM effect_challenges WHERE challenge_id=?1",
            [&challenge],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        db.execute(
            "UPDATE effect_challenges SET status='PREPARED', after_digest=?2, receipt_digest=NULL WHERE challenge_id=?1 AND status='APPROVED'",
            rusqlite::params![challenge, content_digest],
        )
        .unwrap(),
        1,
    );
    drop(db);

    let cancelled = host.request(
        FEATURE_EFFECTS_V2,
        "cancel_batch",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location)),
            ("batchID", string("batch_prepared_cancel")),
        ]),
    );
    assert_eq!(cancelled.outcome, RpcOutcomeV1::Ok, "{:?}", cancelled.error);
    let body = cancelled.body.as_ref().unwrap();
    assert_eq!(value_string(body, "status"), "cancelled");
    let Value::Map(fields) = body else {
        panic!("expected cancellation response map");
    };
    assert_eq!(fields.get("cancelled"), Some(&Value::Unsigned(0)));
    assert_eq!(fields.get("prepared"), Some(&Value::Unsigned(1)));
    let still_prepared: String = Connection::open(&effect_db)
        .unwrap()
        .query_row(
            "SELECT status FROM effect_challenges WHERE challenge_id=?1",
            [&challenge],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(still_prepared, "PREPARED");
    assert!(!target.exists());
    drop(host);

    let mut restarted = HostProcess::launch(&state, "prepared_cancel_two", INCARNATION, true);
    assert_eq!(restarted.register_location(&workspace), location);
    let reconciled = restarted.request(
        FEATURE_EFFECTS_V2,
        "reconcile_effect",
        value_map([
            ("effectID", string(&effect)),
            ("locationID", string(&location)),
            ("sessionID", string(SESSION)),
        ]),
    );
    assert_eq!(reconciled.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        reconciled.error.as_ref().map(|error| error.code.as_str()),
        Some("effect_outcome_unknown")
    );
    let after_restart: String = Connection::open(&effect_db)
        .unwrap()
        .query_row(
            "SELECT status FROM effect_challenges WHERE challenge_id=?1",
            [&challenge],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after_restart, "UNKNOWN");
    let late_execute = restarted.execute_write(&location, &effect, &lease, "must-not-be-replayed");
    assert_eq!(late_execute.outcome, RpcOutcomeV1::Error);
    assert!(!target.exists());
}

#[test]
fn hz_kernel_process_patch_prevalidates_every_target_and_applies_approved_operations_atomically() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(workspace.join("update.txt"), b"before").unwrap();
    fs::set_permissions(
        workspace.join("update.txt"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(workspace.join("preserve.txt"), b"preserve").unwrap();
    fs::set_permissions(
        workspace.join("preserve.txt"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(workspace.join("remove.txt"), b"remove").unwrap();
    fs::write(workspace.join("move_from.txt"), b"moving").unwrap();
    let outside = directory.0.join("outside.txt");
    fs::write(&outside, b"outside").unwrap();
    std::os::unix::fs::symlink(&outside, workspace.join("symlink.txt")).unwrap();
    fs::hard_link(&outside, workspace.join("hardlink.txt")).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut host = HostProcess::launch(&state, "effects_patch_nonce", INCARNATION, true);
    let location = host.register_location(&workspace);

    let patch = |path: &str, before: Value, after: Option<&str>| {
        let mut fields = vec![
            ("operation", string("write")),
            ("path", string(path)),
            ("expectedBeforeBase64", before),
        ];
        if let Some(after) = after {
            fields.push(("contentBase64", string(after)));
        } else {
            fields[0] = ("operation", string("delete"));
        }
        Value::Map(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        )
    };
    let prepare_patch = |host: &mut HostProcess, batch: &str, operations: Value| {
        host.prepare(
            &location,
            batch,
            "files.patch",
            value_map([("operations", operations)]),
        )
    };
    let denied = prepare_patch(
        &mut host,
        "duplicate",
        Value::Array(vec![
            patch("duplicate.txt", Value::Nil, Some("YQ==")),
            patch("duplicate.txt", Value::Nil, Some("Yg==")),
        ]),
    );
    assert_eq!(
        value_string(denied.body.as_ref().unwrap(), "status"),
        "denied"
    );
    assert!(!workspace.join("duplicate.txt").exists());

    let malformed = prepare_patch(
        &mut host,
        "malformed",
        Value::Array(vec![value_map([
            ("operation", string("write")),
            ("path", string("malformed.txt")),
            ("expectedBeforeBase64", Value::Nil),
            ("contentBase64", string("%%%")),
        ])]),
    );
    assert_eq!(malformed.outcome, RpcOutcomeV1::Error);
    assert!(!workspace.join("malformed.txt").exists());
    let malformed_mode = prepare_patch(
        &mut host,
        "malformed_mode",
        Value::Array(vec![value_map([
            ("operation", string("write")),
            ("path", string("malformed-mode.txt")),
            ("expectedBeforeBase64", Value::Nil),
            ("contentBase64", string("YQ==")),
            ("executable", string("true")),
        ])]),
    );
    assert_eq!(malformed_mode.outcome, RpcOutcomeV1::Error);
    assert!(!workspace.join("malformed-mode.txt").exists());

    let stale = prepare_patch(
        &mut host,
        "stale",
        Value::Array(vec![patch("update.txt", string("d3Jvbmc="), Some("YQ=="))]),
    );
    assert_eq!(
        value_string(stale.body.as_ref().unwrap(), "status"),
        "denied"
    );
    assert_eq!(fs::read(workspace.join("update.txt")).unwrap(), b"before");
    let oversized = prepare_patch(
        &mut host,
        "oversized",
        Value::Array(vec![patch(
            "oversized.txt",
            Value::Nil,
            Some(&"A".repeat(2_796_204)),
        )]),
    );
    // This exceeds the canonical per-call admission bound before it reaches the
    // patch planner, so the host returns a typed request error with no body.
    assert_eq!(oversized.outcome, RpcOutcomeV1::Error);
    assert!(oversized.error.is_some());
    assert!(!workspace.join("oversized.txt").exists());

    for (batch, path) in [
        ("outside", "../outside.txt"),
        ("symlink", "symlink.txt"),
        ("hardlink", "hardlink.txt"),
    ] {
        let response = prepare_patch(
            &mut host,
            batch,
            Value::Array(vec![patch(path, string("b3V0c2lkZQ=="), Some("bmV3"))]),
        );
        assert_eq!(
            value_string(response.body.as_ref().unwrap(), "status"),
            "denied"
        );
    }
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    let partial = prepare_patch(
        &mut host,
        "all_validate",
        Value::Array(vec![
            patch("should-not-create.txt", Value::Nil, Some("bmV3")),
            patch("hardlink.txt", string("b3V0c2lkZQ=="), Some("bmV3")),
        ]),
    );
    assert_eq!(
        value_string(partial.body.as_ref().unwrap(), "status"),
        "denied"
    );
    assert!(!workspace.join("should-not-create.txt").exists());

    let operations = Value::Array(vec![
        patch("update.txt", string("YmVmb3Jl"), Some("YWZ0ZXI=")),
        patch("created.txt", Value::Nil, Some("Y3JlYXRlZA==")),
        patch("remove.txt", string("cmVtb3Zl"), None),
        patch("preserve.txt", string("cHJlc2VydmU="), Some("cHJlc2VydmVk")),
        value_map([
            ("operation", string("write")),
            ("path", string("script.sh")),
            ("expectedBeforeBase64", Value::Nil),
            ("contentBase64", string("cnVu")),
            ("executable", Value::Bool(true)),
        ]),
        patch("move_to.txt", Value::Nil, Some("bW92aW5n")),
        patch("move_from.txt", string("bW92aW5n"), None),
    ]);
    let prepared = prepare_patch(&mut host, "apply", operations.clone());
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        value_string(prepared.body.as_ref().unwrap(), "status"),
        "needs_approval"
    );
    let challenge = value_string(prepared.body.as_ref().unwrap(), "challengeID").to_owned();
    let effect = value_string(prepared.body.as_ref().unwrap(), "effectID").to_owned();
    let approval = host.approve(&challenge, "allow_once");
    assert_eq!(approval.outcome, RpcOutcomeV1::Ok);
    let lease = value_string(approval.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
    let changed = host.request(
        FEATURE_EFFECTS_V2,
        "execute_patch",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location)),
            ("effectID", string(&effect)),
            ("capabilityLeaseDigest", string(&lease)),
            ("operations", Value::Array(vec![])),
        ]),
    );
    assert_eq!(changed.outcome, RpcOutcomeV1::Error);
    let executed = host.request(
        FEATURE_EFFECTS_V2,
        "execute_patch",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location)),
            ("effectID", string(&effect)),
            ("capabilityLeaseDigest", string(&lease)),
            ("operations", operations.clone()),
        ]),
    );
    assert_eq!(executed.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        value_string(executed.body.as_ref().unwrap(), "status"),
        "settled"
    );
    assert_eq!(fs::read(workspace.join("update.txt")).unwrap(), b"after");
    assert_eq!(fs::read(workspace.join("created.txt")).unwrap(), b"created");
    assert!(!workspace.join("remove.txt").exists());
    assert_eq!(fs::read(workspace.join("move_to.txt")).unwrap(), b"moving");
    assert!(!workspace.join("move_from.txt").exists());
    // A write that does not request an executable mode preserves the pre-image mode,
    // exactly like a truncating rewrite; `created.txt` below proves the fresh-file default.
    assert_eq!(
        fs::metadata(workspace.join("update.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    assert_eq!(
        fs::metadata(workspace.join("created.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
    assert_eq!(
        fs::metadata(workspace.join("preserve.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    assert_eq!(
        fs::metadata(workspace.join("script.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    let replay = host.request(
        FEATURE_EFFECTS_V2,
        "execute_patch",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location)),
            ("effectID", string(&effect)),
            ("capabilityLeaseDigest", string(&lease)),
            ("operations", operations),
        ]),
    );
    assert_eq!(replay.outcome, RpcOutcomeV1::Error);
}

#[test]
fn hz_kernel_process_effects_fail_closed_for_unregistered_location_bad_paths_denial_and_replay() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    let outside = directory.0.join("outside.txt");
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&outside, b"outside").unwrap();
    std::os::unix::fs::symlink(&outside, workspace.join("escape.txt")).unwrap();
    fs::hard_link(&outside, workspace.join("hardlink.txt")).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut host = HostProcess::launch(&state, "effects_denial_nonce", INCARNATION, true);

    let unregistered = host.prepare(
        "loc_unregistered",
        "unregistered",
        "files.write",
        value_map([
            ("path", string("no-root.txt")),
            ("content", string("must not write")),
        ]),
    );
    assert_ne!(unregistered.outcome, RpcOutcomeV1::Ok);
    assert!(!directory.0.join("no-root.txt").exists());
    let location = host.register_location(&workspace);
    for (batch, path) in [
        ("outside", "../outside.txt"),
        ("symlink", "escape.txt"),
        ("hardlink", "hardlink.txt"),
    ] {
        let response = host.prepare(
            &location,
            batch,
            "files.write",
            value_map([("path", string(path)), ("content", string("overwrite"))]),
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok);
        assert_eq!(
            value_string(response.body.as_ref().unwrap(), "status"),
            "denied"
        );
    }
    assert_eq!(fs::read(&outside).unwrap(), b"outside");

    let (challenge, effect) = prepare_write(
        &mut host,
        &location,
        "denied",
        "denied.txt",
        "must remain absent",
    );
    let denied = host.approve(&challenge, "deny");
    assert_eq!(denied.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        value_string(denied.body.as_ref().unwrap(), "status"),
        "denied"
    );
    let replay = host.execute_write(&location, &effect, "not-issued", "must remain absent");
    assert_eq!(replay.outcome, RpcOutcomeV1::Error);
    assert!(!workspace.join("denied.txt").exists());
}

#[test]
fn hz_kernel_process_effect_lease_is_fenced_across_restart_and_receipt_reconciles() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut host = HostProcess::launch(&state, "effects_restart_one", INCARNATION, true);
    let location = host.register_location(&workspace);
    let (challenge, effect) = prepare_write(
        &mut host,
        &location,
        "restart_batch",
        "restart.txt",
        "persisted approval",
    );
    let approval = host.approve(&challenge, "allow_once");
    assert_eq!(approval.outcome, RpcOutcomeV1::Ok);
    let lease = value_string(approval.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
    drop(host);

    let mut restarted = HostProcess::launch(&state, "effects_restart_two", INCARNATION, true);
    let location_after_restart = restarted.register_location(&workspace);
    assert_eq!(location_after_restart, location);
    let stale = restarted.execute_write(&location, &effect, &lease, "persisted approval");
    assert_eq!(stale.outcome, RpcOutcomeV1::Error);
    assert!(!workspace.join("restart.txt").exists());

    let (challenge, effect) = prepare_write(
        &mut restarted,
        &location,
        "receipt_batch",
        "receipt.txt",
        "settled before disconnect",
    );
    let approval = restarted.approve(&challenge, "allow_once");
    assert_eq!(approval.outcome, RpcOutcomeV1::Ok);
    let lease = value_string(approval.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
    let executed = restarted.execute_write(&location, &effect, &lease, "settled before disconnect");
    assert_eq!(executed.outcome, RpcOutcomeV1::Ok);
    drop(restarted);

    let mut reconciler = HostProcess::launch(&state, "effects_restart_three", INCARNATION, true);
    let response = reconciler.request(
        FEATURE_EFFECTS_V2,
        "reconcile_effect",
        value_map([
            ("effectID", string(&effect)),
            ("locationID", string(&location)),
            ("sessionID", string(SESSION)),
        ]),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok);
    let body = response.body.unwrap();
    assert_eq!(value_string(&body, "status"), "settled");
    assert!(value_string(&body, "receiptDigest").starts_with("blake3:"));
    assert_eq!(
        fs::read(workspace.join("receipt.txt")).unwrap(),
        b"settled before disconnect"
    );
    let status: String = Connection::open(
        state
            .join("effect-locations")
            .join(&location)
            .join("effects.sqlite"),
    )
    .unwrap()
    .query_row(
        "SELECT status FROM effect_challenges WHERE effect_id=?1",
        [&effect],
        |row| row.get(0),
    )
    .unwrap();
    assert_eq!(status, "SETTLED");
}

#[test]
fn hz_kernel_process_effects_require_negotiated_feature() {
    let directory = TestDir::new();
    let mut host = HostProcess::launch(
        &directory.0.join("state"),
        "effects_observer_nonce",
        INCARNATION,
        false,
    );
    let response = host.request(
        FEATURE_EFFECTS_V2,
        "register_location",
        value_map([("canonicalRoot", string(directory.0.to_str().unwrap()))]),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        response.error.as_ref().unwrap().code,
        "feature_not_negotiated"
    );
}
#[test]
fn hz_kernel_process_mixed_patch_recovery_remains_unknown_without_replaying_missing_target() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut host = HostProcess::launch(&state, "effects_mixed_recovery_one", INCARNATION, true);
    let location = host.register_location(&workspace);
    let operation = |path: &str, content: &str| {
        value_map([
            ("operation", string("write")),
            ("path", string(path)),
            ("expectedBeforeBase64", Value::Nil),
            ("contentBase64", string(content)),
        ])
    };
    let operations = Value::Array(vec![
        operation("mixed-first.txt", "Zmlyc3Q="),
        operation("mixed-second.txt", "c2Vjb25k"),
    ]);
    let prepared = host.prepare(
        &location,
        "mixed_recovery",
        "files.patch",
        value_map([("operations", operations.clone())]),
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok);
    let challenge = value_string(prepared.body.as_ref().unwrap(), "challengeID").to_owned();
    let effect = value_string(prepared.body.as_ref().unwrap(), "effectID").to_owned();
    let approval = host.approve(&challenge, "allow_once");
    assert_eq!(approval.outcome, RpcOutcomeV1::Ok);
    let lease = value_string(approval.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
    let executed = host.request(
        FEATURE_EFFECTS_V2,
        "execute_patch",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location)),
            ("effectID", string(&effect)),
            ("capabilityLeaseDigest", string(&lease)),
            ("operations", operations),
        ]),
    );
    assert_eq!(executed.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        fs::read(workspace.join("mixed-first.txt")).unwrap(),
        b"first"
    );
    fs::remove_file(workspace.join("mixed-second.txt")).unwrap();
    drop(host);

    let effect_db = state
        .join("effect-locations")
        .join(&location)
        .join("effects.sqlite");
    let db = Connection::open(effect_db).unwrap();
    assert_eq!(db.execute(
        "UPDATE effect_challenges SET status='PREPARED', receipt_digest=NULL WHERE effect_id=?1",
        [&effect],
    ).unwrap(), 1);
    drop(db);

    let mut restarted =
        HostProcess::launch(&state, "effects_mixed_recovery_two", INCARNATION, true);
    let restarted_location = restarted.register_location(&workspace);
    assert_eq!(restarted_location, location);
    let reconciled = restarted.request(
        FEATURE_EFFECTS_V2,
        "reconcile_effect",
        value_map([
            ("effectID", string(&effect)),
            ("locationID", string(&location)),
            ("sessionID", string(SESSION)),
        ]),
    );
    assert_eq!(reconciled.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        reconciled.error.as_ref().map(|error| error.code.as_str()),
        Some("effect_outcome_unknown")
    );
    assert_eq!(
        fs::read(workspace.join("mixed-first.txt")).unwrap(),
        b"first"
    );
    assert!(!workspace.join("mixed-second.txt").exists());
}

#[test]
fn hz_kernel_process_patch_restart_classifies_all_before_all_after_and_mixed_without_replay() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut host = HostProcess::launch(&state, "effects_patch_recovery_one", INCARNATION, true);
    let location = host.register_location(&workspace);

    let operation = |path: &str, content: &str| {
        value_map([
            ("operation", string("write")),
            ("path", string(path)),
            ("expectedBeforeBase64", Value::Nil),
            ("contentBase64", string(content)),
        ])
    };
    let prepare_and_execute = |host: &mut HostProcess, batch: &str, operations: Value| {
        let prepared = host.prepare(
            &location,
            batch,
            "files.patch",
            value_map([("operations", operations.clone())]),
        );
        assert_eq!(prepared.outcome, RpcOutcomeV1::Ok);
        let challenge = value_string(prepared.body.as_ref().unwrap(), "challengeID").to_owned();
        let effect = value_string(prepared.body.as_ref().unwrap(), "effectID").to_owned();
        let approved = host.approve(&challenge, "allow_once");
        assert_eq!(approved.outcome, RpcOutcomeV1::Ok);
        let lease =
            value_string(approved.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
        let executed = host.request(
            FEATURE_EFFECTS_V2,
            "execute_patch",
            value_map([
                ("sessionID", string(SESSION)),
                ("locationID", string(&location)),
                ("effectID", string(&effect)),
                ("capabilityLeaseDigest", string(&lease)),
                ("operations", operations),
            ]),
        );
        assert_eq!(executed.outcome, RpcOutcomeV1::Ok);
        (
            effect,
            value_string(executed.body.as_ref().unwrap(), "receiptDigest").to_owned(),
        )
    };
    let (before_effect, _) = prepare_and_execute(
        &mut host,
        "recover_before",
        Value::Array(vec![operation("before.txt", "YQ==")]),
    );
    let (after_effect, _) = prepare_and_execute(
        &mut host,
        "recover_after",
        Value::Array(vec![operation("after.txt", "Yg==")]),
    );
    let (mixed_effect, _) = prepare_and_execute(
        &mut host,
        "recover_mixed",
        Value::Array(vec![
            operation("mixed-one.txt", "b25l"),
            operation("mixed-two.txt", "dHdv"),
        ]),
    );
    assert_eq!(fs::read(workspace.join("before.txt")).unwrap(), b"a");
    assert_eq!(fs::read(workspace.join("after.txt")).unwrap(), b"b");
    assert_eq!(fs::read(workspace.join("mixed-one.txt")).unwrap(), b"one");
    assert_eq!(fs::read(workspace.join("mixed-two.txt")).unwrap(), b"two");

    let (mismatch_challenge, mismatch_effect) = prepare_write(
        &mut host,
        &location,
        "recover_target_mismatch",
        "target-mismatch.txt",
        "written once",
    );
    let mismatch_approval = host.approve(&mismatch_challenge, "allow_once");
    assert_eq!(mismatch_approval.outcome, RpcOutcomeV1::Ok);
    let mismatch_lease = value_string(
        mismatch_approval.body.as_ref().unwrap(),
        "capabilityLeaseDigest",
    )
    .to_owned();
    let mismatch_settled =
        host.execute_write(&location, &mismatch_effect, &mismatch_lease, "written once");
    assert_eq!(mismatch_settled.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        fs::read(workspace.join("target-mismatch.txt")).unwrap(),
        b"written once"
    );

    fs::remove_file(workspace.join("before.txt")).unwrap();
    fs::remove_file(workspace.join("mixed-two.txt")).unwrap();
    drop(host);
    let effect_db = state
        .join("effect-locations")
        .join(&location)
        .join("effects.sqlite");
    let db = Connection::open(&effect_db).unwrap();
    for effect in [&before_effect, &after_effect, &mixed_effect] {
        assert_eq!(db.execute(
            "UPDATE effect_challenges SET status='PREPARED', receipt_digest=NULL WHERE effect_id=?1",
            [effect],
        ).unwrap(), 1);
    }
    assert_eq!(db.execute(
        "UPDATE effect_challenges SET status='PREPARED', receipt_digest=NULL, target=?1 WHERE effect_id=?2",
        [directory.0.join("wrong-target.txt").to_str().unwrap(), &mismatch_effect],
    ).unwrap(), 1);
    drop(db);

    let mut restarted =
        HostProcess::launch(&state, "effects_patch_recovery_two", INCARNATION, true);
    assert_eq!(restarted.register_location(&workspace), location);
    let db = Connection::open(&effect_db).unwrap();
    let load = |effect: &str| {
        db.query_row(
            "SELECT status, receipt_digest FROM effect_challenges WHERE effect_id=?1",
            [effect],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .unwrap()
    };
    assert_eq!(load(&before_effect), ("NOT_APPLIED".into(), None));
    let after = load(&after_effect);
    assert_eq!(after.0, "SETTLED");
    assert!(
        after
            .1
            .as_deref()
            .is_some_and(|receipt| receipt.starts_with("blake3:"))
    );
    assert_eq!(load(&mixed_effect).0, "UNKNOWN");
    assert_eq!(load(&mismatch_effect).0, "UNKNOWN");
    assert!(!workspace.join("before.txt").exists());
    assert_eq!(fs::read(workspace.join("after.txt")).unwrap(), b"b");
    assert_eq!(fs::read(workspace.join("mixed-one.txt")).unwrap(), b"one");
    assert!(!workspace.join("mixed-two.txt").exists());
    assert_eq!(
        fs::read(workspace.join("target-mismatch.txt")).unwrap(),
        b"written once"
    );

    for effect in [
        &before_effect,
        &after_effect,
        &mixed_effect,
        &mismatch_effect,
    ] {
        let response = restarted.request(
            FEATURE_EFFECTS_V2,
            "reconcile_effect",
            value_map([
                ("effectID", string(effect)),
                ("locationID", string(&location)),
                ("sessionID", string(SESSION)),
            ]),
        );
        if effect == &before_effect {
            assert_eq!(
                value_string(response.body.as_ref().unwrap(), "status"),
                "not_applied"
            );
        } else if effect == &after_effect {
            assert_eq!(
                value_string(response.body.as_ref().unwrap(), "status"),
                "settled"
            );
            assert!(
                value_string(response.body.as_ref().unwrap(), "receiptDigest")
                    .starts_with("blake3:")
            );
        } else {
            assert_eq!(
                response.error.as_ref().map(|error| error.code.as_str()),
                Some("effect_outcome_unknown")
            );
        }
    }
}

#[test]
fn session_page_ack_wait_does_not_block_independent_host_effect_service() {
    let directory = TestDir::new();
    let source = directory.0.join("opencode.db");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(
        "CREATE TABLE event (
           id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
           type TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(aggregate_id,seq)
         );",
    )
    .unwrap();
    db.execute(
        "INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(
          'evt_effect_interleave','ses_process',0,'session.next.prompt.admitted.1',?1
        )",
        [r#"{"messageID":"msg_effect_interleave","prompt":[{"text":"private"}]}"#],
    )
    .unwrap();
    drop(db);

    let supervisor_state = directory.0.join("supervisor");
    fs::create_dir(&supervisor_state).unwrap();
    fs::set_permissions(&supervisor_state, fs::Permissions::from_mode(0o700)).unwrap();
    let socket = supervisor_state.join("session.sock");
    let supervisor_exe = fs::canonicalize(env!("CARGO_BIN_EXE_session_supervisor")).unwrap();
    let supervisor_process = TestProcess(
        Command::new(&supervisor_exe)
            .arg(format!("--source={}", source.display()))
            .arg(format!("--state-dir={}", supervisor_state.display()))
            .arg(format!("--socket={}", socket.display()))
            .arg(format!(
                "--host-exe={}",
                fs::canonicalize(std::env::current_exe().unwrap())
                    .unwrap()
                    .display()
            ))
            .arg("--nonce=effects_interleave_nonce")
            .arg("--incarnation=inc_effects_interleave")
            .arg("--owner-epoch=1")
            .arg("--session=ses_process")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !socket.exists() {
        assert!(
            Instant::now() < deadline,
            "session_supervisor did not create its private socket"
        );
        thread::sleep(Duration::from_millis(5));
    }
    let mut session_stream = connect_authenticated(
        &socket,
        UnixPeerPolicy {
            uid: unsafe { libc::geteuid() },
            executable: supervisor_exe,
        },
    )
    .unwrap();
    write_message(
        &mut session_stream,
        &RpcMessageV1::Hello(Box::new(KernelHelloV1 {
            min_protocol: 1,
            max_protocol: 1,
            host_build_digest: format!("blake3:{}", "a".repeat(64)),
            kernel_build_digest: None,
            host_instance_id: "effects_interleave_test".into(),
            process_incarnation: "inc_effects_interleave".into(),
            supervisor_nonce: "effects_interleave_nonce".into(),
            required_features: vec![
                "session.events.v1".into(),
                "session.events.page-control.v1".into(),
            ],
            optional_features: vec![],
        })),
    )
    .unwrap();
    let Some(RpcMessageV1::HelloResult(hello)) = read_message(&mut session_stream).unwrap() else {
        panic!("expected supervisor hello result");
    };
    let mut ready = false;
    for _ in 0..16 {
        match read_message(&mut session_stream).unwrap().unwrap() {
            RpcMessageV1::StartupStatus(status) if *status == KernelStartupStatusV1::Ready => {
                ready = true;
                break;
            }
            RpcMessageV1::StartupStatus(status) if *status == KernelStartupStatusV1::Starting => {}
            other => panic!("unexpected supervisor startup frame: {other:?}"),
        }
    }
    assert!(ready, "session_supervisor did not reach READY");
    write_message(
        &mut session_stream,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
            owner_epoch: hello.owner_epoch,
            process_incarnation: "inc_effects_interleave".into(),
            subscription_id: "sub_effects_interleave".into(),
            owner_kind: "session".into(),
            owner_id: "ses_process".into(),
            after: Some(CursorV1 {
                owner_kind: "session".into(),
                owner_id: "ses_process".into(),
                seq: "0".into(),
                event_digest: "blake3:0000000000000000000000000000000000000000000000000000000000000000"
                    .into(),
            }),
        })),
    )
    .unwrap();
    let pending_event = loop {
        match read_message(&mut session_stream).unwrap().unwrap() {
            RpcMessageV1::Event(event) => break event,
            other => panic!("expected an event page awaiting its ACK, got {other:?}"),
        }
    };

    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let mut host = HostProcess::launch(
        &directory.0.join("host-state"),
        "effects_independent_nonce",
        INCARNATION,
        true,
    );
    let location = host.register_location(&workspace);
    let (challenge, effect) = prepare_write(
        &mut host,
        &location,
        "independent_batch",
        "while-page-pending.txt",
        "independent service",
    );
    let approval = host.approve(&challenge, "allow_once");
    assert_eq!(approval.outcome, RpcOutcomeV1::Ok);
    let lease = value_string(approval.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
    let settled = host.execute_write(&location, &effect, &lease, "independent service");
    assert_eq!(settled.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        fs::read(workspace.join("while-page-pending.txt")).unwrap(),
        b"independent service"
    );
    // The event remains unacknowledged on SessionSupervisor's socket while hz-kernel
    // independently completes the Guard-authorized process effect on its own socket.
    // Event cursors are 1-based after the base cursor: source row seq 0 projects as cursor 1.
    assert_eq!(pending_event.cursor.seq, "1");
    drop(session_stream);
    drop(supervisor_process);
}

#[test]
fn hz_kernel_process_legacy_prepared_contextless_write_is_unknown_and_never_replayed() {
    let directory = TestDir::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let target = workspace.join("legacy.txt");
    let content = b"already written before restart";
    fs::write(&target, content).unwrap();

    let mut first = HostProcess::launch(&state, "effects_legacy_one", INCARNATION, true);
    let location = first.register_location(&workspace);
    drop(first);
    let effect_db = state
        .join("effect-locations")
        .join(&location)
        .join("effects.sqlite");
    fs::remove_file(&effect_db).unwrap();
    let db = Connection::open(&effect_db).unwrap();
    db.execute_batch(
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
        );",
    )
    .unwrap();
    let digest = format!("blake3:{}", blake3::hash(content).to_hex());
    db.execute(
        "INSERT INTO effect_challenges (
            challenge_id, effect_id, session_id, batch_id, call_id, capability_id,
            relative_path, requested_path, target, resource, existed, argument_digest,
            content_digest, expires_at_ms, status, approved, after_digest, lease_id,
            receipt_digest
         ) VALUES (
            'legacy_prepared', 'legacy_effect', 'ses_legacy', 'legacy_batch',
            'legacy_call', 'files.write', 'legacy.txt', 'legacy.txt', ?1, 'legacy.txt',
            0, 'blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ?2, 9999999999999, 'PREPARED', 1, ?2, 'legacy_lease', NULL
         )",
        rusqlite::params![target.to_string_lossy(), digest],
    )
    .unwrap();
    drop(db);

    let mut restarted = HostProcess::launch(&state, "effects_legacy_two", INCARNATION, true);
    assert_eq!(restarted.register_location(&workspace), location);
    let db = Connection::open(&effect_db).unwrap();
    let migrated: (String, Option<String>, String, String) = db
        .query_row(
            "SELECT status, receipt_digest, turn_context_digest, origin_kind
         FROM effect_challenges WHERE challenge_id='legacy_prepared'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        migrated,
        (
            "UNKNOWN".into(),
            None,
            String::new(),
            "session_batch".into()
        )
    );
    assert_eq!(fs::read(&target).unwrap(), content);
    let reconciliation = restarted.request(
        FEATURE_EFFECTS_V2,
        "reconcile_effect",
        value_map([
            ("effectID", string("legacy_effect")),
            ("locationID", string(&location)),
            ("sessionID", string("ses_legacy")),
        ]),
    );
    assert_eq!(reconciliation.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        reconciliation
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("effect_outcome_unknown"),
    );
    assert_eq!(fs::read(&target).unwrap(), content);
}
