#![cfg(target_os = "linux")]

use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{
    CursorV1, FEATURE_SESSION_PAGE_CONTROL_V1, HandshakePolicy, KernelHelloV1, RpcControlV1,
    RpcMessageV1, read_message, write_message,
};
use horizoncode_kernel::rpc_handshake::HelloOutcome;
use horizoncode_kernel::session_projection::SessionProjection;
use horizoncode_kernel::startup::StartupPhase;
use horizoncode_kernel::supervisor_lease::SupervisorLease;
use horizoncode_kernel::supervisor_session::AuthenticatedKernelSession;
use horizoncode_kernel::unix_peer::{UnixPeerListener, UnixPeerPolicy, connect_authenticated};
use rusqlite::{Connection, params};
use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hc-session-rpc-{}-{}",
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

fn peer_policy() -> UnixPeerPolicy {
    UnixPeerPolicy {
        uid: unsafe { libc::geteuid() },
        executable: fs::canonicalize(std::env::current_exe().unwrap()).unwrap(),
    }
}

fn hello() -> KernelHelloV1 {
    KernelHelloV1 {
        min_protocol: 1,
        max_protocol: 1,
        host_build_digest:
            "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        kernel_build_digest: None,
        host_instance_id: "host-test".into(),
        process_incarnation: "incarnation-test".into(),
        supervisor_nonce: "nonce-test".into(),
        required_features: vec![
            "session.events.v1".into(),
            FEATURE_SESSION_PAGE_CONTROL_V1.into(),
        ],
        optional_features: vec![],
    }
}

fn policy() -> HandshakePolicy {
    HandshakePolicy {
        min_protocol: 1,
        max_protocol: 1,
        supported_features: BTreeSet::from([
            "session.events.v1".into(),
            FEATURE_SESSION_PAGE_CONTROL_V1.into(),
        ]),
        expected_supervisor_nonce: "nonce-test".into(),
        expected_host_process_incarnation: Some("incarnation-test".into()),
    }
}

fn after() -> CursorV1 {
    CursorV1 {
        owner_kind: "session".into(),
        owner_id: "ses_rpc".into(),
        seq: "0".into(),
        event_digest: "blake3:0000000000000000000000000000000000000000000000000000000000000000"
            .into(),
    }
}

fn source() -> Connection {
    let source = Connection::open_in_memory().unwrap();
    source
        .execute_batch(
            "CREATE TABLE event (
               id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
               type TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(aggregate_id,seq)
             );",
        )
        .unwrap();
    for (seq, kind) in [
        (0, "session.next.prompt.admitted.1"),
        (1, "session.next.prompted.1"),
    ] {
        source
            .execute(
                "INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?1,'ses_rpc',?2,?3,?4)",
                params![
                    format!("evt_rpc_{seq}"),
                    seq,
                    kind,
                    r#"{"messageID":"msg_rpc","prompt":[{"text":"secret"}]}"#
                ],
            )
            .unwrap();
    }
    source
}

#[test]
fn authenticated_rpc_sends_redacted_projection_page_and_waits_for_exact_ack() {
    let directory = TestDir::new();
    let path = directory.0.join("kernel.sock");
    let state_path = directory.0.clone();
    let listener = UnixPeerListener::bind(&path, peer_policy()).unwrap();
    let server = std::thread::spawn(move || {
        let lease = SupervisorLease::acquire(&state_path).unwrap();
        let (channel, _) = listener.accept_authenticated().unwrap();
        let mut session = AuthenticatedKernelSession::new(channel);
        assert!(matches!(
            session.negotiate(&policy()).unwrap(),
            HelloOutcome::Negotiated(_)
        ));
        session.canonical_state_validated().unwrap();
        session.owner_epoch_acquired(&lease).unwrap();
        session.recovery_reconciled().unwrap();
        session.required_services_ready().unwrap();
        assert_eq!(session.phase(), StartupPhase::Ready);
        assert!(matches!(
            session.next_application_message().unwrap(),
            RpcMessageV1::Control(control)
                if matches!(control.as_ref(), RpcControlV1::Subscribe { subscription_id, .. } if subscription_id == "sub_rpc")
        ));

        let source = source();
        let mut projection =
            SessionProjection::open(Connection::open_in_memory().unwrap()).unwrap();
        projection.sync(&source, "ses_rpc", 8).unwrap();
        session
            .send_subscription_page(&projection, "sub_rpc", &after(), 1)
            .unwrap()
    });

    let mut host = connect_authenticated(&path, peer_policy()).unwrap();
    write_message(&mut host, &RpcMessageV1::Hello(Box::new(hello()))).unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::HelloResult(_))
    ));
    for _ in 0..5 {
        read_message(&mut host).unwrap().unwrap();
    }
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
            subscription_id: "sub_rpc".into(),
            owner_kind: "session".into(),
            owner_id: "ses_rpc".into(),
            after: Some(after()),
        })),
    )
    .unwrap();
    let Some(RpcMessageV1::Event(event)) = read_message(&mut host).unwrap() else {
        panic!("expected projected Session event");
    };
    assert_eq!(event.cursor.seq, "1");
    assert_eq!(event.event_type, "session.next.prompt.admitted.1");
    assert_eq!(field(&event.payload, "messageID"), Some("msg_rpc"));
    assert!(!format!("{:?}", event.payload).contains("secret"));
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
            subscription_id: "sub_rpc".into(),
            through: event.cursor.clone(),
        })),
    )
    .unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::Control(control))
            if matches!(control.as_ref(), RpcControlV1::PageEnd { has_more: true, .. })
    ));
    let delivery = server.join().unwrap();
    assert_eq!(delivery.cursor, event.cursor);
    assert!(delivery.has_more);
    assert_eq!(delivery.delivered, 1);
}

#[test]
fn authenticated_rpc_rejects_ack_for_another_subscription() {
    let directory = TestDir::new();
    let path = directory.0.join("kernel.sock");
    let state_path = directory.0.clone();
    let listener = UnixPeerListener::bind(&path, peer_policy()).unwrap();
    let server = std::thread::spawn(move || {
        let lease = SupervisorLease::acquire(&state_path).unwrap();
        let (channel, _) = listener.accept_authenticated().unwrap();
        let mut session = AuthenticatedKernelSession::new(channel);
        assert!(matches!(
            session.negotiate(&policy()).unwrap(),
            HelloOutcome::Negotiated(_)
        ));
        session.canonical_state_validated().unwrap();
        session.owner_epoch_acquired(&lease).unwrap();
        session.recovery_reconciled().unwrap();
        session.required_services_ready().unwrap();
        assert!(matches!(
            session.next_application_message().unwrap(),
            RpcMessageV1::Control(_)
        ));
        let source = source();
        let mut projection =
            SessionProjection::open(Connection::open_in_memory().unwrap()).unwrap();
        projection.sync(&source, "ses_rpc", 8).unwrap();
        session.send_subscription_page(&projection, "sub_rpc", &after(), 1)
    });

    let mut host = connect_authenticated(&path, peer_policy()).unwrap();
    write_message(&mut host, &RpcMessageV1::Hello(Box::new(hello()))).unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::HelloResult(_))
    ));
    for _ in 0..5 {
        read_message(&mut host).unwrap().unwrap();
    }
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
            subscription_id: "sub_rpc".into(),
            owner_kind: "session".into(),
            owner_id: "ses_rpc".into(),
            after: Some(after()),
        })),
    )
    .unwrap();
    let Some(RpcMessageV1::Event(event)) = read_message(&mut host).unwrap() else {
        panic!("expected projected Session event");
    };
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
            subscription_id: "sub_other".into(),
            through: event.cursor,
        })),
    )
    .unwrap();
    let result = server.join().unwrap();
    assert!(matches!(
        result,
        Err(horizoncode_kernel::supervisor_session::SupervisorSessionError::WrongSubscription)
    ));
}

fn field<'a>(payload: &'a Value, name: &str) -> Option<&'a str> {
    let Value::Map(map) = payload else {
        return None;
    };
    let Value::String(value) = map.get(name)? else {
        return None;
    };
    Some(value)
}
