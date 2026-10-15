#![cfg(target_os = "linux")]

use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{
    FEATURE_EFFECTS_V2, KernelHelloV1, KernelStartupStatusV1, RpcMessageV1, RpcOutcomeV1,
    RpcRequestV1, read_message, write_message,
};
use horizoncode_kernel::unix_peer::{UnixPeerPolicy, connect_authenticated};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
        write_message(&mut stream, &RpcMessageV1::Request(Box::new(request))).unwrap();
        let Some(RpcMessageV1::Response(response)) = read_message(&mut stream).unwrap() else {
            panic!("expected host RPC response");
        };
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
