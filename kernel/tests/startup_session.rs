#![cfg(target_os = "linux")]

use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{
    HandshakePolicy, KernelHelloV1, KernelStartupStatusV1, RpcMessageV1, RpcOutcomeV1,
    RpcRequestV1, RpcResponseV1, read_message, write_message,
};
use horizoncode_kernel::rpc_handshake::HelloOutcome;
use horizoncode_kernel::startup::StartupPhase;
use horizoncode_kernel::supervisor_lease::SupervisorLease;
use horizoncode_kernel::supervisor_session::{AuthenticatedKernelSession, SupervisorSessionError};
use horizoncode_kernel::unix_peer::{UnixPeerListener, UnixPeerPolicy, connect_authenticated};
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
            "hc-startup-session-{}-{}",
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
        required_features: vec!["session.events.v1".into()],
        optional_features: vec![],
    }
}

fn policy() -> HandshakePolicy {
    HandshakePolicy {
        min_protocol: 1,
        max_protocol: 1,
        supported_features: BTreeSet::from(["session.events.v1".into()]),
        expected_supervisor_nonce: "nonce-test".into(),
        expected_host_process_incarnation: Some("incarnation-test".into()),
        owner_epoch: 7,
    }
}

#[test]
fn startup_statuses_follow_negotiation_and_gate_requests_until_ready() {
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
        assert_eq!(
            session.phase(),
            StartupPhase::AwaitingCanonicalStateValidation
        );
        assert!(session.next_application_request().is_err());
        session.canonical_state_validated().unwrap();
        session.owner_epoch_acquired(lease.epoch()).unwrap();
        session.recovery_reconciled().unwrap();
        session.required_services_ready().unwrap();
        assert_eq!(session.phase(), StartupPhase::Ready);
        assert_eq!(
            session.next_application_request().unwrap().request_id,
            "req_1"
        );
        session
            .write_application_message(&RpcMessageV1::Response(Box::new(RpcResponseV1 {
                owner_epoch: 7,
                process_incarnation: "incarnation-test".into(),
                request_id: "req_1".into(),
                outcome: RpcOutcomeV1::Ok,
                owner_cursor: None,
                receipt_digest: None,
                body: Some(Value::Map(Default::default())),
                error: None,
            })))
            .unwrap();
    });

    let mut host = connect_authenticated(&path, peer_policy()).unwrap();
    write_message(&mut host, &RpcMessageV1::Hello(Box::new(hello()))).unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::HelloResult(_))
    ));
    let statuses = (0..5)
        .map(|_| read_message(&mut host).unwrap().unwrap())
        .collect::<Vec<_>>();
    assert!(statuses[..4].iter().all(|message| matches!(
        message,
        RpcMessageV1::StartupStatus(status)
            if matches!(status.as_ref(), KernelStartupStatusV1::Starting)
    )));
    assert!(matches!(
        &statuses[4],
        RpcMessageV1::StartupStatus(status)
            if matches!(status.as_ref(), KernelStartupStatusV1::Ready)
    ));
    write_message(
        &mut host,
        &RpcMessageV1::Request(Box::new(RpcRequestV1 {
            owner_epoch: 7,
            process_incarnation: "incarnation-test".into(),
            request_id: "req_1".into(),
            service_id: "health".into(),
            operation: "get".into(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: 1_800_000_000_000,
            trace_id: "trace_1".into(),
            body: Value::Map(Default::default()),
        })),
    )
    .unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::Response(_))
    ));
    server.join().unwrap();
}

#[test]
fn application_frames_fail_closed_on_wrong_owner_epoch_or_incarnation() {
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
        session.owner_epoch_acquired(lease.epoch()).unwrap();
        session.recovery_reconciled().unwrap();
        session.required_services_ready().unwrap();

        // Wrong owner epoch fails closed even though everything else is valid.
        assert!(matches!(
            session.next_application_request(),
            Err(SupervisorSessionError::FrameFenceMismatch)
        ));
        // Wrong process incarnation fails closed too.
        assert!(matches!(
            session.next_application_request(),
            Err(SupervisorSessionError::FrameFenceMismatch)
        ));
        // A correctly fenced request is accepted afterwards: the channel survives.
        assert_eq!(
            session.next_application_request().unwrap().request_id,
            "req_good"
        );
        // Outbound frames must carry the negotiated fence as well.
        assert!(matches!(
            session.write_application_message(&RpcMessageV1::Response(Box::new(RpcResponseV1 {
                owner_epoch: 6,
                process_incarnation: "incarnation-test".into(),
                request_id: "req_good".into(),
                outcome: RpcOutcomeV1::Ok,
                owner_cursor: None,
                receipt_digest: None,
                body: None,
                error: None,
            }))),
            Err(SupervisorSessionError::FrameFenceMismatch)
        ));
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

    let request_for = |request_id: &str, owner_epoch: u64, process_incarnation: &str| {
        RpcMessageV1::Request(Box::new(RpcRequestV1 {
            owner_epoch,
            process_incarnation: process_incarnation.into(),
            request_id: request_id.into(),
            service_id: "health".into(),
            operation: "get".into(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: 1_800_000_000_000,
            trace_id: "trace_1".into(),
            body: Value::Map(Default::default()),
        }))
    };
    write_message(&mut host, &request_for("req_epoch", 6, "incarnation-test")).unwrap();
    write_message(
        &mut host,
        &request_for("req_incarnation", 7, "incarnation-other"),
    )
    .unwrap();
    write_message(&mut host, &request_for("req_good", 7, "incarnation-test")).unwrap();
    server.join().unwrap();
}

#[test]
fn failed_negotiation_fences_the_connection_and_reports_failed_startup() {
    let directory = TestDir::new();
    let path = directory.0.join("kernel.sock");
    let listener = UnixPeerListener::bind(&path, peer_policy()).unwrap();
    let server = std::thread::spawn(move || {
        let (channel, _) = listener.accept_authenticated().unwrap();
        let mut session = AuthenticatedKernelSession::new(channel);
        let result = session.negotiate(&policy()).unwrap();
        assert!(matches!(result, HelloOutcome::Rejected(_)));
        assert_eq!(session.phase(), StartupPhase::Failed);
        assert!(session.next_application_request().is_err());
    });

    let mut host = connect_authenticated(&path, peer_policy()).unwrap();
    let mut incompatible = hello();
    incompatible.supervisor_nonce = "wrong-nonce".into();
    write_message(&mut host, &RpcMessageV1::Hello(Box::new(incompatible))).unwrap();
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::HelloRejected(_))
    ));
    assert!(matches!(
        read_message(&mut host).unwrap(),
        Some(RpcMessageV1::StartupStatus(status))
            if matches!(status.as_ref(), KernelStartupStatusV1::Failed(_))
    ));
    server.join().unwrap();
}
