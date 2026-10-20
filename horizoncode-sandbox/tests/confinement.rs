//! Real OS-confinement tests (DEC-V1-03 evidence).
//!
//! Every test in this file exercises an actual confined child process and
//! checks the host filesystem/network afterwards. Tests that depend on a
//! probed kernel capability are gated: a missing capability prints a typed
//! `SKIP[...]` reason, and `HZ_SANDBOX_STRICT=1` (used for the evidence run)
//! turns that skip into a failure so a degraded host cannot pass silently.
//!
//! Coverage map (P1-SB acceptance):
//! (a) write inside a scoped root succeeds and lands on the host,
//! (b) write outside any scoped root is denied and the host is untouched,
//! (c) TCP connect to a live host listener is denied inside the sandbox,
//! (d) protected subpaths stay read-only (with host-side control) and missing
//!     protected subpaths leave no placeholder behind,
//! (e) deny masks hide existing directories and files without modifying them,
//! (f) private `/tmp` is a fresh tmpfs, not the host `/tmp`,
//! (g) the Landlock write-scope backend really denies writes outside its
//!     allowlist while truthfully staying read-open,
//! (h) `full-access` is explicit and never reported as confined,
//! (i) spawn validation rejects relative programs and invisible cwds,
//! (j) the environment is cleared and only explicitly allowed entries pass
//!     (bubblewrap itself injects `PWD=<cwd>`, which is asserted and documented
//!     as a named residual — nothing from the parent environment may appear).

mod common;

use std::net::TcpListener;
use std::path::{Path, PathBuf};

use common::{Workspace, bash, capability_gate, confined_sandbox, run_bare, run_capture, sh};
use horizoncode_sandbox::{
    ConfinedProfile, ConfinementBackend, ExpectedLevel, GuaranteeDimension, GuaranteeLevel,
    Sandbox, SandboxError, SandboxProfile, ScopedRoot, SpawnRequest,
};

/// A shell script request: `<sh> -c <script>`.
fn command(sh: &Path, script: &str) -> SpawnRequest {
    SpawnRequest::new(sh).arg("-c").arg(script)
}

/// Absolute `/usr/bin/env` (or `/bin/env`) for the environment test.
fn env_binary() -> Option<&'static Path> {
    for candidate in ["/usr/bin/env", "/bin/env"] {
        let path = Path::new(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// (a) write inside the scoped root
// ---------------------------------------------------------------------------

#[test]
fn write_inside_scoped_root_succeeds() {
    const TEST: &str = "write_inside_scoped_root_succeeds";
    let Some(sandbox) = confined_sandbox(TEST) else {
        return;
    };
    let Some(sh) = sh() else {
        capability_gate(TEST, false, "no POSIX shell found");
        return;
    };
    let workspace = Workspace::new("confinement-inside-write");
    let prepared = sandbox
        .prepare(&SandboxProfile::workspace_write(workspace.root()))
        .expect("prepare workspace-write");
    prepared
        .require(GuaranteeDimension::FilesystemWrite, ExpectedLevel::ENFORCED)
        .expect("workspace-write must enforce filesystem_write");

    let request = command(
        sh,
        "mkdir -p nested && printf 'hello inside' > nested/created.txt",
    )
    .cwd(workspace.root());
    let (outcome, stdout, stderr) = run_capture(&prepared, &request);
    assert!(
        outcome.success(),
        "confined write inside the scoped root failed: code={:?} stdout={stdout:?} stderr={stderr:?}",
        outcome.code
    );
    assert_eq!(
        workspace.read("nested/created.txt"),
        "hello inside",
        "the write did not land on the host workspace"
    );
    assert!(
        outcome.cleanup_warnings.is_empty(),
        "{:?}",
        outcome.cleanup_warnings
    );
}

// ---------------------------------------------------------------------------
// (b) write outside every scoped root
// ---------------------------------------------------------------------------

#[test]
fn write_outside_scoped_root_is_denied() {
    const TEST: &str = "write_outside_scoped_root_is_denied";
    let Some(sandbox) = confined_sandbox(TEST) else {
        return;
    };
    let Some(sh) = sh() else {
        capability_gate(TEST, false, "no POSIX shell found");
        return;
    };
    let workspace = Workspace::new("confinement-outside-write");
    let outside = Workspace::new("confinement-outside-target");
    outside.write("sentinel.txt", "untouched");

    // Control: without the sandbox this exact write succeeds, so a failure
    // inside the sandbox is confinement, not a broken command.
    let control = format!(
        "printf control > '{}/control.txt'",
        outside.root().display()
    );
    let (code, _, stderr) = run_bare(sh, &["-c", &control]);
    assert_eq!(code, Some(0), "bare control write failed: {stderr}");
    std::fs::remove_file(outside.path("control.txt")).expect("remove control file");

    let prepared = sandbox
        .prepare(&SandboxProfile::workspace_write(workspace.root()))
        .expect("prepare workspace-write");
    let attack = format!(
        "printf intruder > '{}/intruder.txt'",
        outside.root().display()
    );
    let (outcome, _, stderr) = run_capture(&prepared, &command(sh, &attack).cwd(workspace.root()));
    assert!(
        !outcome.success(),
        "write outside the scoped root unexpectedly succeeded: stderr={stderr:?}"
    );
    assert!(
        !outside.exists("intruder.txt"),
        "the host filesystem was modified outside the scoped root"
    );
    assert_eq!(outside.read("sentinel.txt"), "untouched");
}

// ---------------------------------------------------------------------------
// (c) network egress
// ---------------------------------------------------------------------------

#[test]
fn network_connect_to_host_listener_is_denied() {
    const TEST: &str = "network_connect_to_host_listener_is_denied";
    let Some(sandbox) = confined_sandbox(TEST) else {
        return;
    };
    let Some(bash) = bash() else {
        capability_gate(TEST, false, "no /bin/bash for the /dev/tcp connect probe");
        return;
    };
    // A live listener on the host loopback: the identical command must succeed
    // outside the sandbox and fail inside it.
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback listener");
    let port = listener.local_addr().expect("listener addr").port();
    let script = format!("printf '' > /dev/tcp/127.0.0.1/{port}");
    let (code, _, stderr) = run_bare(bash, &["-c", &script]);
    assert_eq!(
        code,
        Some(0),
        "bare control connect to 127.0.0.1:{port} failed: {stderr}"
    );

    let workspace = Workspace::new("confinement-network");
    let prepared = sandbox
        .prepare(&SandboxProfile::workspace_write(workspace.root()))
        .expect("prepare workspace-write");
    prepared
        .require(GuaranteeDimension::NetworkEgress, ExpectedLevel::ENFORCED)
        .expect("workspace-write must enforce network_egress");

    let request = SpawnRequest::new(bash)
        .arg("-c")
        .arg(&script)
        .cwd(workspace.root());
    let (outcome, stdout, stderr) = run_capture(&prepared, &request);
    assert!(
        !outcome.success(),
        "TCP connect to 127.0.0.1:{port} succeeded inside the sandbox: stdout={stdout:?} stderr={stderr:?}"
    );
    eprintln!("{TEST}: confined connect failed as required: stderr={stderr:?}");
    drop(listener);
}

// ---------------------------------------------------------------------------
// (d) protected subpaths
// ---------------------------------------------------------------------------

#[test]
fn protected_subpaths_reject_writes_and_preserve_the_host() {
    const TEST: &str = "protected_subpaths_reject_writes_and_preserve_the_host";
    let Some(sandbox) = confined_sandbox(TEST) else {
        return;
    };
    let Some(sh) = sh() else {
        capability_gate(TEST, false, "no POSIX shell found");
        return;
    };
    let workspace = Workspace::new("confinement-protected");
    workspace.mkdir(".git");
    workspace.write(".git/config", "original-config");
    let prepared = sandbox
        .prepare(&SandboxProfile::workspace_write(workspace.root()))
        .expect("prepare workspace-write");

    // Reading a protected path stays possible (protection is read-only, not
    // hidden).
    let request = command(sh, "cat .git/config").cwd(workspace.root());
    let (outcome, stdout, stderr) = run_capture(&prepared, &request);
    assert!(outcome.success(), "reading .git/config failed: {stderr:?}");
    assert_eq!(stdout.trim(), "original-config");

    for (label, script) in [
        ("rewrite", "printf mutated > .git/config"),
        ("creation", "printf new > .git/confined-file"),
        ("deletion", "rm .git/config"),
    ] {
        let request = command(sh, script).cwd(workspace.root());
        let (outcome, _, stderr) = run_capture(&prepared, &request);
        assert!(
            !outcome.success(),
            "protected subpath {label} unexpectedly succeeded: stderr={stderr:?}"
        );
    }

    // Control: this process may write inside `.git` without the sandbox.
    let control = format!(
        "printf bare > '{}/.git/bare-control.txt'",
        workspace.root().display()
    );
    let (code, _, stderr) = run_bare(sh, &["-c", &control]);
    assert_eq!(
        code,
        Some(0),
        "bare control write into .git failed: {stderr}"
    );
    assert_eq!(
        workspace.read(".git/config"),
        "original-config",
        "the protected file was modified through the sandbox"
    );

    // Missing protected subpaths (`.agents`, `.codex`, `.horizoncode` in the
    // workspace-write vector) are enforced placeholders: no writes, and no
    // leftover mount targets on the host after the child exits.
    let request = command(sh, "printf x > .agents/confined-file").cwd(workspace.root());
    let (outcome, _, _) = run_capture(&prepared, &request);
    assert!(
        !outcome.success(),
        "writing into a missing protected subpath succeeded"
    );
    for missing in [".agents", ".codex", ".horizoncode"] {
        assert!(
            !workspace.exists(missing),
            "placeholder mount target `{missing}` was left behind on the host"
        );
    }
}

// ---------------------------------------------------------------------------
// (e) deny masks
// ---------------------------------------------------------------------------

#[test]
fn deny_masks_hide_and_freeze_paths() {
    const TEST: &str = "deny_masks_hide_and_freeze_paths";
    let Some(sandbox) = confined_sandbox(TEST) else {
        return;
    };
    let Some(sh) = sh() else {
        capability_gate(TEST, false, "no POSIX shell found");
        return;
    };
    let workspace = Workspace::new("confinement-deny-masks");
    workspace.mkdir("secret");
    workspace.write("secret/file.txt", "classified");
    workspace.write("secret.txt", "hidden-file");

    let SandboxProfile::Confined(mut confined) = SandboxProfile::workspace_write(workspace.root())
    else {
        unreachable!("workspace_write is confined")
    };
    confined.deny_masks = vec![workspace.path("secret"), workspace.path("secret.txt")];
    let prepared = sandbox
        .prepare(&SandboxProfile::Confined(confined))
        .expect("prepare deny-mask profile");

    // Directory mask: not listable, not readable through, not creatable.
    for script in ["ls secret", "cat secret/file.txt", "printf x > secret/new"] {
        let request = command(sh, script).cwd(workspace.root());
        let (outcome, stdout, stderr) = run_capture(&prepared, &request);
        assert!(
            !outcome.success(),
            "`{script}` unexpectedly succeeded through a deny mask: stdout={stdout:?} stderr={stderr:?}"
        );
    }

    // File mask: content hidden, and a write fails with EROFS instead of being
    // silently discarded.
    let request = command(sh, "cat secret.txt").cwd(workspace.root());
    let (outcome, stdout, stderr) = run_capture(&prepared, &request);
    assert!(
        outcome.success(),
        "cat of a masked file failed to open: {stderr:?}"
    );
    assert_eq!(
        stdout, "",
        "the masked file content was visible inside the sandbox"
    );
    let request = command(sh, "printf intruder > secret.txt").cwd(workspace.root());
    let (outcome, _, _) = run_capture(&prepared, &request);
    assert!(
        !outcome.success(),
        "write through a file deny mask succeeded"
    );

    // The host state is untouched.
    assert_eq!(workspace.read("secret/file.txt"), "classified");
    assert_eq!(workspace.read("secret.txt"), "hidden-file");
    assert!(!workspace.exists("secret/new"));
}

// ---------------------------------------------------------------------------
// (f) private /tmp
// ---------------------------------------------------------------------------

#[test]
fn private_tmp_is_isolated_from_host_tmp() {
    const TEST: &str = "private_tmp_is_isolated_from_host_tmp";
    let Some(sandbox) = confined_sandbox(TEST) else {
        return;
    };
    let Some(sh) = sh() else {
        capability_gate(TEST, false, "no POSIX shell found");
        return;
    };
    let pid = std::process::id();
    let host_leak = PathBuf::from(format!("/tmp/hz-sandbox-leak-{pid}"));
    let host_sentinel = PathBuf::from(format!("/tmp/hz-sandbox-host-sentinel-{pid}"));
    let _ = std::fs::remove_file(&host_leak);
    std::fs::write(&host_sentinel, "host-only").expect("write host sentinel");

    let workspace = Workspace::new("confinement-private-tmp");
    let prepared = sandbox
        .prepare(&SandboxProfile::workspace_write(workspace.root()))
        .expect("prepare workspace-write");

    // Writing to `/tmp` works inside the view...
    let script = format!("printf inside > {}", host_leak.display());
    let request = command(sh, &script).cwd(workspace.root());
    let (outcome, _, stderr) = run_capture(&prepared, &request);
    assert!(
        outcome.success(),
        "write into the private /tmp failed: {stderr:?}"
    );
    // ...but the host `/tmp` never sees it.
    assert!(
        !host_leak.exists(),
        "a private /tmp write leaked into the host /tmp"
    );
    // ...and a host `/tmp` entry is not visible inside the private tmpfs.
    let request = command(sh, &format!("cat {}", host_sentinel.display())).cwd(workspace.root());
    let (outcome, stdout, _) = run_capture(&prepared, &request);
    assert!(
        !outcome.success(),
        "a host /tmp entry was readable inside the private tmpfs: stdout={stdout:?}"
    );
    let _ = std::fs::remove_file(&host_sentinel);
}

// ---------------------------------------------------------------------------
// (g) Landlock write scope
// ---------------------------------------------------------------------------

#[test]
fn landlock_write_scope_permits_inside_and_denies_outside() {
    const TEST: &str = "landlock_write_scope_permits_inside_and_denies_outside";
    let sandbox = Sandbox::probe();
    let capabilities = common::capabilities();
    let status = capabilities.confined_backend(ConfinementBackend::LandlockWriteScope);
    if !capability_gate(
        TEST,
        status.is_available(),
        status
            .reason()
            .unwrap_or("Landlock write scoping unavailable"),
    ) {
        return;
    }
    let Some(sh) = sh() else {
        capability_gate(TEST, false, "no POSIX shell found");
        return;
    };
    let workspace = Workspace::new("confinement-landlock");
    let outside = Workspace::new("confinement-landlock-outside");
    outside.write("sentinel.txt", "outside-read");

    let mut confined = ConfinedProfile::default();
    confined.backend = ConfinementBackend::LandlockWriteScope;
    confined.scoped_roots = vec![ScopedRoot::write(workspace.root())];
    let prepared = sandbox
        .prepare(&SandboxProfile::Confined(confined))
        .expect("prepare Landlock profile");
    prepared
        .require(GuaranteeDimension::FilesystemWrite, ExpectedLevel::ENFORCED)
        .expect("Landlock ABI>=3 must enforce filesystem_write");

    // Inside the allowlist: the write succeeds and lands on the host.
    let request = command(sh, "printf inside > ok.txt").cwd(workspace.root());
    let (outcome, _, stderr) = run_capture(&prepared, &request);
    assert!(
        outcome.success(),
        "Landlock denied an allowed write: {stderr:?}"
    );
    assert_eq!(workspace.read("ok.txt"), "inside");

    // Outside the allowlist: denied, host untouched.
    let attack = format!("printf bad > '{}/bad.txt'", outside.root().display());
    let request = command(sh, &attack).cwd(workspace.root());
    let (outcome, _, stderr) = run_capture(&prepared, &request);
    assert!(
        !outcome.success(),
        "Landlock allowed a write outside the scoped root: stderr={stderr:?}"
    );
    assert!(!outside.exists("bad.txt"));

    // Documented residual, asserted so a future read-scoping layer cannot land
    // silently: this backend does not confine reads.
    let read = format!("cat '{}/sentinel.txt'", outside.root().display());
    let request = command(sh, &read).cwd(workspace.root());
    let (outcome, stdout, stderr) = run_capture(&prepared, &request);
    assert!(
        outcome.success(),
        "read-open residual no longer holds: {stderr:?}"
    );
    assert_eq!(stdout.trim(), "outside-read");

    // ABI>=4 additionally denies TCP connect through Landlock rules.
    if let Some(abi) = capabilities.landlock_abi {
        if abi >= 4 {
            if let Some(bash) = bash() {
                let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind listener");
                let port = listener.local_addr().expect("listener addr").port();
                let script = format!("printf '' > /dev/tcp/127.0.0.1/{port}");
                let (code, _, stderr) = run_bare(bash, &["-c", &script]);
                assert_eq!(code, Some(0), "bare control connect failed: {stderr}");
                let request = SpawnRequest::new(bash)
                    .arg("-c")
                    .arg(&script)
                    .cwd(workspace.root());
                let (outcome, _, stderr) = run_capture(&prepared, &request);
                assert!(
                    !outcome.success(),
                    "Landlock ABI {abi} TCP denial did not hold: stderr={stderr:?}"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// (h) full-access is explicit, never confined
// ---------------------------------------------------------------------------

#[test]
fn full_access_is_explicit_and_never_reported_as_confined() {
    let sandbox = Sandbox::probe();
    let prepared = sandbox
        .prepare(&SandboxProfile::full_access())
        .expect("full-access always prepares");
    assert_eq!(prepared.backend(), "none");
    assert_eq!(prepared.profile().descriptor_id(), "full-access");
    for dimension in GuaranteeDimension::ALL {
        let level = prepared
            .guarantee(dimension)
            .map(|assessment| assessment.level)
            .unwrap_or(GuaranteeLevel::Unsupported);
        assert_ne!(
            level,
            GuaranteeLevel::Enforced,
            "full-access reported an enforced {dimension}"
        );
        let error = prepared
            .require(dimension, ExpectedLevel::ENFORCED)
            .expect_err("full-access must fail an enforced requirement");
        assert!(
            matches!(error, SandboxError::GuaranteeNotMet { dimension: failing, .. } if failing == dimension),
            "unexpected error for {dimension}: {error}"
        );
    }

    // full-access executes the real program unconfined (that is the point of
    // the explicit opt-in).
    let Some(sh) = sh() else {
        return;
    };
    let scratch = Workspace::new("confinement-full-access");
    let script = format!("printf free > '{}/free.txt'", scratch.root().display());
    let (outcome, _, stderr) = run_capture(&prepared, &command(sh, &script));
    assert!(outcome.success(), "full-access spawn failed: {stderr:?}");
    assert_eq!(scratch.read("free.txt"), "free");
}

// ---------------------------------------------------------------------------
// (i) spawn validation
// ---------------------------------------------------------------------------

#[test]
fn spawn_validation_rejects_relative_program_and_invisible_cwd() {
    const TEST: &str = "spawn_validation_rejects_relative_program_and_invisible_cwd";
    let Some(sandbox) = confined_sandbox(TEST) else {
        return;
    };
    let Some(sh) = sh() else {
        capability_gate(TEST, false, "no POSIX shell found");
        return;
    };
    let workspace = Workspace::new("confinement-validation");
    let prepared = sandbox
        .prepare(&SandboxProfile::workspace_write(workspace.root()))
        .expect("prepare workspace-write");

    let error = prepared
        .spawn(&SpawnRequest::new("sh"))
        .expect_err("relative program must be rejected");
    assert!(
        matches!(error, SandboxError::ProfileInvalid { .. }),
        "unexpected error for a relative program: {error}"
    );

    for invisible in ["/hz-sandbox-no-such-cwd", "/no/such/hz-sandbox/path"] {
        let request = command(sh, "true").cwd(Path::new(invisible));
        let error = prepared
            .spawn(&request)
            .expect_err("cwd outside the prepared view must be rejected");
        assert!(
            matches!(error, SandboxError::ProfileInvalid { .. }),
            "unexpected error for invisible cwd `{invisible}`: {error}"
        );
    }
}

// ---------------------------------------------------------------------------
// (j) environment policy
// ---------------------------------------------------------------------------

#[test]
fn environment_is_cleared_and_only_allowed_entries_pass() {
    const TEST: &str = "environment_is_cleared_and_only_allowed_entries_pass";
    let Some(sandbox) = confined_sandbox(TEST) else {
        return;
    };
    let Some(env) = env_binary() else {
        capability_gate(TEST, false, "no /usr/bin/env found");
        return;
    };
    let workspace = Workspace::new("confinement-environment");
    let prepared = sandbox
        .prepare(&SandboxProfile::workspace_write(workspace.root()))
        .expect("prepare workspace-write");

    let request = SpawnRequest::new(env).cwd(workspace.root());
    let (outcome, stdout, stderr) = run_capture(&prepared, &request);
    assert!(
        outcome.success(),
        "bare env failed inside the sandbox: {stderr:?}"
    );
    for line in stdout.lines() {
        assert!(
            line.starts_with("PWD="),
            "the parent environment leaked into the sandbox: {line:?}"
        );
    }

    let request = SpawnRequest::new(env)
        .cwd(workspace.root())
        .env_allow("HZ_SANDBOX_TEST", "allowed");
    let (outcome, stdout, stderr) = run_capture(&prepared, &request);
    assert!(outcome.success(), "env with allowlist failed: {stderr:?}");
    let mut lines: Vec<String> = stdout.lines().map(str::to_string).collect();
    lines.sort();
    assert_eq!(
        lines,
        vec![
            "HZ_SANDBOX_TEST=allowed".to_string(),
            format!("PWD={}", workspace.root().display()),
        ],
        "the sandbox environment must contain only the allowlisted entry plus bubblewrap's own PWD"
    );
}
