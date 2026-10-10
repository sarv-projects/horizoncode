#![cfg(target_os = "linux")]

use horizoncode_kernel::supervisor_lease::{SupervisorLease, SupervisorLeaseErrorKind};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hc-supervisor-lease-{}-{}",
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

fn set_epoch(directory: &Path, epoch: &str) {
    fs::write(directory.join("supervisor.epoch"), epoch).unwrap();
    fs::set_permissions(
        directory.join("supervisor.epoch"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
}

#[test]
fn lease_excludes_competitors_and_increments_epoch_after_restart() {
    let directory = TestDir::new();
    let first = SupervisorLease::acquire(&directory.0).unwrap();
    assert_eq!(first.epoch(), 1);
    assert_eq!(
        SupervisorLease::acquire(&directory.0).unwrap_err().kind(),
        SupervisorLeaseErrorKind::Busy
    );
    drop(first);

    let restarted = SupervisorLease::acquire(&directory.0).unwrap();
    assert_eq!(restarted.epoch(), 2);
}

#[test]
fn corrupt_epoch_fails_closed_without_rewriting_it() {
    let directory = TestDir::new();
    set_epoch(&directory.0, "01");

    let error = SupervisorLease::acquire(&directory.0).unwrap_err();
    assert_eq!(error.kind(), SupervisorLeaseErrorKind::CorruptEpoch);
    assert_eq!(
        fs::read(directory.0.join("supervisor.epoch")).unwrap(),
        b"01"
    );
}

#[test]
fn refuses_insecure_directory_and_symlinked_epoch_file() {
    let directory = TestDir::new();
    fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        SupervisorLease::acquire(&directory.0).unwrap_err().kind(),
        SupervisorLeaseErrorKind::InsecureDirectory
    );

    fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o700)).unwrap();
    let outside = directory.0.join("outside");
    fs::write(&outside, b"1").unwrap();
    fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
    std::os::unix::fs::symlink(&outside, directory.0.join("supervisor.epoch")).unwrap();
    assert_eq!(
        SupervisorLease::acquire(&directory.0).unwrap_err().kind(),
        SupervisorLeaseErrorKind::UnsafeFile
    );
    assert_eq!(fs::read(outside).unwrap(), b"1");
}

#[test]
fn refuses_state_directory_beneath_non_sticky_shared_writable_parent() {
    let base = TestDir::new();
    let parent = base.0.join("shared");
    fs::create_dir(&parent).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o777)).unwrap();
    let state = parent.join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(
        SupervisorLease::acquire(&state).unwrap_err().kind(),
        SupervisorLeaseErrorKind::InsecureDirectory
    );
}

#[test]
fn epoch_overflow_does_not_replace_persisted_value() {
    let directory = TestDir::new();
    set_epoch(&directory.0, &u64::MAX.to_string());

    assert_eq!(
        SupervisorLease::acquire(&directory.0).unwrap_err().kind(),
        SupervisorLeaseErrorKind::EpochOverflow
    );
    assert_eq!(
        fs::read_to_string(directory.0.join("supervisor.epoch")).unwrap(),
        u64::MAX.to_string()
    );
}
