//! Shared helpers for the integration tests.
//!
//! Capability-gated tests must not "pass by doing nothing": every skip prints a
//! typed reason, and `HZ_SANDBOX_STRICT=1` turns a missing capability into a
//! failure so the evidence run cannot silently degrade.

#![allow(dead_code)]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use horizoncode_sandbox::{
    Capabilities, ExitOutcome, PreparedExecution, Sandbox, SandboxProfile, SpawnRequest,
    StdioPolicy,
};

/// Probed capabilities, computed once for the whole test binary.
pub fn capabilities() -> &'static Capabilities {
    static CAPABILITIES: OnceLock<Capabilities> = OnceLock::new();
    CAPABILITIES.get_or_init(|| Sandbox::probe().capabilities().clone())
}

/// Strict evidence mode: a missing required capability fails instead of skipping.
pub fn strict_mode() -> bool {
    std::env::var_os("HZ_SANDBOX_STRICT").is_some()
}

/// Gate a capability-dependent test. Returns `true` when the test must run.
/// Otherwise prints (or, in strict mode, fails with) the typed reason.
pub fn capability_gate(test: &str, available: bool, reason: &str) -> bool {
    if available {
        return true;
    }
    let message = format!("SKIP[{test}]: required capability unavailable: {reason}");
    if strict_mode() {
        panic!("{message} (HZ_SANDBOX_STRICT is set)");
    }
    eprintln!("{message}");
    false
}

/// Sandbox plus the typed reason to use when bubblewrap confinement is missing.
pub fn confined_sandbox(test: &str) -> Option<Sandbox> {
    let capabilities = capabilities();
    let status = capabilities.confined_backend(horizoncode_sandbox::ConfinementBackend::Bubblewrap);
    let reason = status.reason().unwrap_or("unknown").to_string();
    if capability_gate(test, status.is_available(), &reason) {
        Some(Sandbox::probe())
    } else {
        None
    }
}

/// `sh` path for scripts, or `None` with a reason.
pub fn sh() -> Option<&'static Path> {
    for candidate in ["/bin/sh", "/usr/bin/sh", "/bin/busybox"] {
        let path = Path::new(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// `bash` path (needed for the `/dev/tcp` connection probe).
pub fn bash() -> Option<&'static Path> {
    for candidate in ["/bin/bash", "/usr/bin/bash"] {
        let path = Path::new(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// A scratch workspace under `CARGO_TARGET_TMPDIR`, removed on drop.
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn new(name: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create test workspace");
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    pub fn mkdir(&self, relative: &str) {
        std::fs::create_dir_all(self.path(relative)).expect("create directory");
    }

    pub fn write(&self, relative: &str, content: &str) {
        let path = self.path(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent directory");
        }
        std::fs::write(&path, content).expect("write file");
    }

    pub fn read(&self, relative: &str) -> String {
        std::fs::read_to_string(self.path(relative)).expect("read file")
    }

    pub fn exists(&self, relative: &str) -> bool {
        self.path(relative).exists()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Run one prepared execution, capturing stdout/stderr and the exit outcome.
pub fn run_capture(
    prepared: &PreparedExecution,
    request: &SpawnRequest,
) -> (ExitOutcome, String, String) {
    let mut request = request.clone();
    request.stdout = StdioPolicy::Piped;
    request.stderr = StdioPolicy::Piped;
    let mut child = prepared.spawn(&request).expect("spawn confined child");
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.take_stdout() {
        pipe.read_to_string(&mut stdout).expect("read stdout");
    }
    if let Some(mut pipe) = child.take_stderr() {
        pipe.read_to_string(&mut stderr).expect("read stderr");
    }
    let outcome = child.wait().expect("wait for confined child");
    (outcome, stdout, stderr)
}

/// The V1 `workspace-write` profile used across tests.
pub fn workspace_write(workspace: &Path) -> SandboxProfile {
    SandboxProfile::workspace_write(workspace)
}

/// Run a bare (unconfined) command for control assertions.
pub fn run_bare(program: &Path, args: &[&str]) -> (Option<i32>, String, String) {
    let output = Command::new(program)
        .args(args)
        .output()
        .expect("run control command");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}
