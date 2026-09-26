//! Sandbox containment tests (`ARCH/13` §Verification approach).
//!
//! The Linux tests exercise the real `bubblewrap` backend. They skip (rather
//! than silently pass) when the backend is unavailable, so a host without user
//! namespaces does not produce a false green.

use agentx_sandbox::{
    Availability, ConfinementProfile, FsOp, FsProfile, NetworkPolicy, SandboxCommand,
    SandboxProvider, UnsupportedSandbox,
};

fn sh(script: &str) -> SandboxCommand {
    SandboxCommand::new("/bin/sh").arg("-c").arg(script)
}

#[test]
fn unsupported_backend_refuses_confined_effects() {
    let provider = UnsupportedSandbox::new();
    assert!(!provider.probe().is_available());
    let profile = ConfinementProfile::workspace_write(std::env::temp_dir());
    let error = provider.resolve(&profile).unwrap_err();
    assert_eq!(error.code(), "SANDBOX_UNSUPPORTED");

    // Even with a fabricated non-bare plan, spawn refuses rather than running.
    let resolved = agentx_sandbox::ResolvedProfile {
        backend: "unsupported".to_owned(),
        profile: FsProfile::WorkspaceWrite,
        network: NetworkPolicy::None,
        workspace: std::env::temp_dir(),
        writable_roots: vec![std::env::temp_dir()],
        protected: Vec::new(),
        deny: Vec::new(),
        session_dir: None,
        limits: Default::default(),
        applied: Vec::new(),
        epoch: 1,
        bare: false,
    };
    let error = provider.spawn(&sh("echo hi"), &resolved).unwrap_err();
    assert_eq!(error.code(), "SANDBOX_UNSUPPORTED");
}

#[test]
fn unsupported_backend_runs_bare_only_for_full_access() {
    let provider = UnsupportedSandbox::new();
    let profile = ConfinementProfile::full_access(std::env::temp_dir());
    let resolved = provider.resolve(&profile).unwrap();
    assert!(resolved.bare);
    let outcome = provider.spawn(&sh("echo bare-ok"), &resolved).unwrap();
    assert!(outcome.success(), "{outcome:?}");
    assert!(outcome.stdout.contains("bare-ok"));
}

#[test]
fn missing_backend_binary_is_unavailable() {
    #[cfg(target_os = "linux")]
    {
        let provider = agentx_sandbox::BwrapSandbox::with_binary("/nonexistent/bwrap");
        assert!(matches!(provider.probe(), Availability::Unavailable { .. }));
        let profile = ConfinementProfile::workspace_write(std::env::temp_dir());
        let error = provider.resolve(&profile).unwrap_err();
        assert_eq!(error.code(), "SANDBOX_UNSUPPORTED");
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    fn bwrap() -> Option<agentx_sandbox::BwrapSandbox> {
        let provider = agentx_sandbox::BwrapSandbox::new();
        if provider.probe().is_available() {
            Some(provider)
        } else {
            eprintln!(
                "skipping bubblewrap test: {}",
                provider.probe().reason().unwrap_or("unavailable")
            );
            None
        }
    }

    #[test]
    fn workspace_write_allows_inside_and_refuses_outside() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("keep.txt"), "keep\n").unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path());
        let resolved = provider.resolve(&profile).unwrap();
        assert!(!resolved.bare);

        let escaped = outside.path().join("escaped.txt");
        let script = format!(
            "echo wrote > inside.txt && echo WROTE_INSIDE; \
             (echo nope > {}) 2>/dev/null && echo ESCAPED || echo ESCAPE_DENIED; \
             cat keep.txt",
            escaped.display()
        );
        let outcome = provider.spawn(&sh(&script), &resolved).unwrap();
        assert!(outcome.stdout.contains("WROTE_INSIDE"), "{outcome:?}");
        assert!(outcome.stdout.contains("ESCAPE_DENIED"), "{outcome:?}");
        assert!(outcome.stdout.contains("keep"), "{outcome:?}");
        assert!(workspace.path().join("inside.txt").is_file());
        assert!(!escaped.exists(), "the sandbox must not write outside");
    }

    #[test]
    fn workspace_write_denies_network_by_default() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path());
        let resolved = provider.resolve(&profile).unwrap();
        let script = "if (exec 3<>/dev/tcp/1.1.1.1/80) 2>/dev/null; then echo NET_OPEN; \
                      else echo NET_BLOCKED; fi";
        let outcome = provider
            .spawn(
                &SandboxCommand::new("/bin/bash").arg("-c").arg(script),
                &resolved,
            )
            .unwrap();
        assert!(outcome.stdout.contains("NET_BLOCKED"), "{outcome:?}");
        assert!(!outcome.stdout.contains("NET_OPEN"), "{outcome:?}");
    }

    #[test]
    fn read_only_profile_refuses_workspace_writes() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::read_only(workspace.path());
        let resolved = provider.resolve(&profile).unwrap();
        let outcome = provider
            .spawn(
                &sh("echo nope > ro.txt 2>/dev/null && echo WROTE || echo RO_DENIED"),
                &resolved,
            )
            .unwrap();
        assert!(outcome.stdout.contains("RO_DENIED"), "{outcome:?}");
        assert!(!workspace.path().join("ro.txt").exists());
    }

    #[test]
    fn deny_glob_hides_content_and_writes() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join(".env"), "SECRET=1\n").unwrap();
        std::fs::create_dir_all(workspace.path().join(".ssh")).unwrap();
        std::fs::write(workspace.path().join(".ssh/id_rsa"), "KEY\n").unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path())
            .with_deny("**/.env")
            .with_deny("**/.ssh");
        let resolved = provider.resolve(&profile).unwrap();
        let script = "cat .env 2>/dev/null | grep -q SECRET && echo LEAKED || echo ENV_HIDDEN; \
                      (echo x > .env) 2>/dev/null && echo ENV_WROTE || echo ENV_RO; \
                      cat .ssh/id_rsa 2>/dev/null | grep -q KEY && echo KEY_LEAKED || echo KEY_HIDDEN";
        let outcome = provider.spawn(&sh(script), &resolved).unwrap();
        assert!(outcome.stdout.contains("ENV_HIDDEN"), "{outcome:?}");
        assert!(outcome.stdout.contains("ENV_RO"), "{outcome:?}");
        assert!(outcome.stdout.contains("KEY_HIDDEN"), "{outcome:?}");
        assert!(!outcome.stdout.contains("LEAKED"), "{outcome:?}");
    }

    #[test]
    fn check_path_enforces_writable_roots_and_protection() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join(".git/hooks")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path());
        let resolved = provider.resolve(&profile).unwrap();

        assert!(
            provider
                .check_path(FsOp::Write, &workspace.path().join("src.txt"), &resolved)
                .is_ok()
        );
        let error = provider
            .check_path(FsOp::Write, &outside.path().join("x.txt"), &resolved)
            .unwrap_err();
        assert_eq!(error.code(), "SANDBOX_VIOLATION");
        let error = provider
            .check_path(
                FsOp::Write,
                &workspace.path().join(".git/hooks/pre-commit"),
                &resolved,
            )
            .unwrap_err();
        assert_eq!(error.code(), "SANDBOX_VIOLATION");
    }

    #[test]
    fn full_access_runs_bare() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::full_access(workspace.path());
        let resolved = provider.resolve(&profile).unwrap();
        assert!(resolved.bare);
        let outcome = provider.spawn(&sh("echo full-ok"), &resolved).unwrap();
        assert!(outcome.success());
        assert!(outcome.stdout.contains("full-ok"));
    }

    #[test]
    fn allowlist_network_is_refused_not_opened() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path())
            .with_network(NetworkPolicy::Allowlist(vec!["api.example:443".to_owned()]));
        let error = provider.resolve(&profile).unwrap_err();
        assert_eq!(error.code(), "SANDBOX_UNSUPPORTED");
    }

    #[test]
    fn timeout_kills_a_long_running_command() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path()).with_limits(
            agentx_sandbox::Limits {
                wall_clock_ms: Some(300),
                max_output_bytes: 4096,
            },
        );
        let resolved = provider.resolve(&profile).unwrap();
        let outcome = provider.spawn(&sh("sleep 30"), &resolved).unwrap();
        assert!(outcome.timed_out, "{outcome:?}");
    }
}
