#![cfg(target_os = "linux")]

use horizoncode_kernel::protocol::{
    ErrorCategoryV1, HandshakePolicy, KernelHelloV1, RetryClassV1, RpcMessageV1, TypedErrorV1,
    read_message, validate_hello_result_binding, write_message,
};
use horizoncode_kernel::rpc_handshake::{
    HelloExchangeError, HelloOutcome, serve_authenticated_unix_hello,
};
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
            "hc-unix-hello-{}-{}",
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

fn hello(nonce: &str) -> KernelHelloV1 {
    KernelHelloV1 {
        min_protocol: 1,
        max_protocol: 2,
        host_build_digest:
            "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        kernel_build_digest: None,
        host_instance_id: "host-test".into(),
        process_incarnation: "incarnation-test".into(),
        supervisor_nonce: nonce.into(),
        required_features: vec!["session.events.v1".into()],
        optional_features: vec!["managed.goals.v1".into()],
    }
}

fn handshake_policy() -> HandshakePolicy {
    HandshakePolicy {
        min_protocol: 1,
        max_protocol: 1,
        supported_features: BTreeSet::from(["session.events.v1".into()]),
        expected_supervisor_nonce: "nonce-test".into(),
        expected_host_process_incarnation: Some("incarnation-test".into()),
        owner_epoch: 7,
    }
}

fn expected_rejection() -> TypedErrorV1 {
    TypedErrorV1 {
        code: "TRANSPORT_INCOMPATIBLE".into(),
        category: ErrorCategoryV1::Capability,
        message: "kernel RPC peers have no compatible protocol/features".into(),
        retry_class: RetryClassV1::Never,
        retry_after_ms: None,
        owner_cursor: None,
        subject_ids: vec![],
        details: None,
    }
}

#[test]
fn authenticated_socket_binds_version_features_nonce_and_incarnation() {
    let directory = TestDir::new();
    let path = directory.0.join("kernel.sock");
    let policy = peer_policy();
    let listener = UnixPeerListener::bind(&path, policy.clone()).unwrap();
    let service = std::thread::spawn(move || {
        let (mut channel, peer) = listener.accept_authenticated().unwrap();
        assert_eq!(peer.executable, policy.executable);
        serve_authenticated_unix_hello(&mut channel, &handshake_policy()).unwrap()
    });

    let mut host = connect_authenticated(&path, peer_policy()).unwrap();
    let hello = hello("nonce-test");
    write_message(&mut host, &RpcMessageV1::Hello(Box::new(hello.clone()))).unwrap();
    let response = read_message(&mut host).unwrap().unwrap();
    let RpcMessageV1::HelloResult(result) = response else {
        panic!("expected negotiated hello result, got {response:?}");
    };
    validate_hello_result_binding(&hello, &result).unwrap();
    assert_eq!(result.protocol, 1);
    assert_eq!(result.enabled_features, ["session.events.v1"]);
    assert_eq!(result.unavailable_optional_features, ["managed.goals.v1"]);
    assert_eq!(service.join().unwrap(), HelloOutcome::Negotiated(*result));
}

#[test]
fn authenticated_socket_returns_bounded_rejection_for_wrong_nonce() {
    let directory = TestDir::new();
    let path = directory.0.join("kernel.sock");
    let policy = peer_policy();
    let listener = UnixPeerListener::bind(&path, policy.clone()).unwrap();
    let service = std::thread::spawn(move || {
        let (mut channel, _) = listener.accept_authenticated().unwrap();
        serve_authenticated_unix_hello(&mut channel, &handshake_policy()).unwrap()
    });

    let mut host = connect_authenticated(&path, peer_policy()).unwrap();
    write_message(
        &mut host,
        &RpcMessageV1::Hello(Box::new(hello("attacker-controlled-nonce"))),
    )
    .unwrap();
    let response = read_message(&mut host).unwrap().unwrap();
    let RpcMessageV1::HelloRejected(rejected) = response else {
        panic!("expected typed hello rejection, got {response:?}");
    };
    assert_eq!(rejected.error, expected_rejection());
    assert_eq!(
        service.join().unwrap(),
        HelloOutcome::Rejected(rejected.error)
    );
}

#[test]
fn authenticated_socket_rejects_unknown_required_features() {
    let directory = TestDir::new();
    let path = directory.0.join("kernel.sock");
    let listener = UnixPeerListener::bind(&path, peer_policy()).unwrap();
    let service = std::thread::spawn(move || {
        let (mut channel, _) = listener.accept_authenticated().unwrap();
        serve_authenticated_unix_hello(&mut channel, &handshake_policy()).unwrap()
    });

    let mut host = connect_authenticated(&path, peer_policy()).unwrap();
    let mut unsupported = hello("nonce-test");
    unsupported.required_features = vec!["session.admin.v9".into()];
    write_message(&mut host, &RpcMessageV1::Hello(Box::new(unsupported))).unwrap();
    let Some(RpcMessageV1::HelloRejected(rejected)) = read_message(&mut host).unwrap() else {
        panic!("expected typed rejection for an unknown required feature");
    };
    assert_eq!(rejected.error.code, "TRANSPORT_INCOMPATIBLE");
    assert_eq!(
        service.join().unwrap(),
        HelloOutcome::Rejected(rejected.error)
    );
}

#[test]
fn application_message_cannot_replace_the_initial_hello() {
    let directory = TestDir::new();
    let path = directory.0.join("kernel.sock");
    let listener = UnixPeerListener::bind(&path, peer_policy()).unwrap();
    let service = std::thread::spawn(move || {
        let (mut channel, _) = listener.accept_authenticated().unwrap();
        serve_authenticated_unix_hello(&mut channel, &handshake_policy())
    });

    let mut host = connect_authenticated(&path, peer_policy()).unwrap();
    write_message(
        &mut host,
        &RpcMessageV1::Control(Box::new(horizoncode_kernel::protocol::RpcControlV1::Ping {
            nonce: "pre-hello".into(),
        })),
    )
    .unwrap();
    assert!(read_message(&mut host).unwrap().is_none());
    assert!(matches!(
        service.join().unwrap(),
        Err(HelloExchangeError::ExpectedHello)
    ));
}
