#![cfg(target_os = "linux")]

use horizoncode_kernel::unix_peer::{
    UnixPeerErrorKind, UnixPeerListener, UnixPeerPolicy, connect_authenticated,
};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hc-unix-peer-{}-{}",
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

fn current_policy() -> UnixPeerPolicy {
    UnixPeerPolicy {
        uid: unsafe { libc::geteuid() },
        executable: std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap(),
    }
}

#[test]
fn authenticates_peer_credentials_and_executable_before_returning_channel() {
    let directory = TestDir::new();
    let socket = directory.0.join("supervisor.sock");
    let policy = current_policy();
    let listener = UnixPeerListener::bind(&socket, policy.clone()).unwrap();
    let client_socket = socket.clone();
    let client_policy = policy.clone();
    let client = std::thread::spawn(move || {
        let mut stream = connect_authenticated(&client_socket, client_policy).unwrap();
        stream.write_all(b"hello").unwrap();
        let mut response = [0; 2];
        stream.read_exact(&mut response).unwrap();
        response
    });

    let (mut stream, peer) = listener.accept_authenticated().unwrap();
    assert_eq!(peer.uid, policy.uid);
    assert_eq!(peer.executable, policy.executable);
    let mut request = [0; 5];
    stream.read_exact(&mut request).unwrap();
    assert_eq!(&request, b"hello");
    stream.write_all(b"ok").unwrap();
    assert_eq!(&client.join().unwrap(), b"ok");
}

#[test]
fn rejects_a_peer_with_the_wrong_executable() {
    let directory = TestDir::new();
    let socket = directory.0.join("supervisor.sock");
    let mut policy = current_policy();
    policy.executable = PathBuf::from("/bin/sh");
    let listener = UnixPeerListener::bind(&socket, policy).unwrap();
    let client_socket = socket.clone();
    let client_policy = current_policy();
    let client = std::thread::spawn(move || connect_authenticated(&client_socket, client_policy));

    let error = match listener.accept_authenticated() {
        Err(error) => error,
        Ok(_) => panic!("unexpectedly authenticated wrong executable"),
    };
    assert!(error.is_peer_mismatch());
    let _ = client.join().unwrap();
}

#[test]
fn refuses_a_socket_directory_accessible_to_other_users() {
    let directory = TestDir::new();
    fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o755)).unwrap();
    let socket = directory.0.join("supervisor.sock");

    let error = match UnixPeerListener::bind(&socket, current_policy()) {
        Err(error) => error,
        Ok(_) => panic!("unexpectedly bound socket in a public directory"),
    };
    assert!(error.is_insecure_directory());
    assert!(!socket.exists());
}

#[test]
fn client_rejects_a_socket_whose_permissions_were_broadened() {
    let directory = TestDir::new();
    let socket = directory.0.join("supervisor.sock");
    let listener = UnixPeerListener::bind(&socket, current_policy()).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o666)).unwrap();

    let error = match connect_authenticated(&socket, current_policy()) {
        Err(error) => error,
        Ok(_) => panic!("unexpectedly connected to a public socket"),
    };
    assert_eq!(error.kind(), UnixPeerErrorKind::UnsafeSocket);
    drop(listener);
}

#[test]
fn refuses_a_socket_path_reached_through_a_symlinked_parent() {
    use std::os::unix::fs::symlink;

    let directory = TestDir::new();
    let alias = directory.0.join("alias");
    symlink(&directory.0, &alias).unwrap();
    let socket = alias.join("supervisor.sock");

    let error = match UnixPeerListener::bind(&socket, current_policy()) {
        Err(error) => error,
        Ok(_) => panic!("unexpectedly bound through a symlinked parent"),
    };
    assert!(error.is_insecure_directory());
}
