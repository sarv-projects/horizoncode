#![cfg(target_os = "linux")]

use horizoncode_kernel::messagepack::{self, Value};
use horizoncode_kernel::protocol::{
    CursorV1, KernelHelloV1, RpcControlV1, RpcMessageV1, read_message, write_message,
};
use horizoncode_kernel::transport::write_frame;
use horizoncode_kernel::unix_peer::{UnixPeerPolicy, connect_authenticated};
use rusqlite::{Connection, params};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

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
    let child = Command::new(executable())
        .arg(format!("--source={}", source.display()))
        .arg(format!("--state-dir={}", state.display()))
        .arg(format!("--socket={}", state.join("session.sock").display()))
        .arg(format!(
            "--host-exe={}",
            std::env::current_exe().unwrap().display()
        ))
        .arg(format!("--nonce={nonce}"))
        .arg(format!("--incarnation={incarnation}"))
        .arg("--session=ses_process")
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
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::HelloResult(_))
    ));
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
