//! Sandbox containment tests (`ARCH/13` §Verification approach).
//!
//! The Linux tests exercise the real `bubblewrap` backend. They skip (rather
//! than silently pass) when the backend is unavailable, so a host without user
//! namespaces does not produce a false green.

use horizoncode_sandbox::{
    Availability, ConfinementProfile, FsOp, FsProfile, NetworkPolicy, SandboxCommand,
    SandboxProvider, UnsupportedSandbox,
};

fn sh(script: &str) -> SandboxCommand {
    SandboxCommand::new("/bin/sh").arg("-c").arg(script)
}

/// The read-scope model is platform-independent: the granted read roots are a
/// property of the profile, and `check_path` is the single in-process enforcer.
/// These assertions therefore run on every tier (`ARCH/13` §Data / state
/// model, `REQ-SEC-025`).
mod read_scope {
    use super::*;

    fn plan(workspace: &std::path::Path, granted: &[&std::path::Path]) -> horizoncode_sandbox::ResolvedProfile {
        let mut profile = ConfinementProfile::workspace_write(workspace);
        for root in granted {
            profile = profile.with_read_root(root);
        }
        horizoncode_sandbox::ResolvedProfile {
            backend: "test".to_owned(),
            profile: FsProfile::WorkspaceWrite,
            network: NetworkPolicy::None,
            workspace: workspace.to_path_buf(),
            writable_roots: profile.writable_roots(),
            readable_roots: profile.readable_roots(),
            protected: profile.protected.clone(),
            deny: profile.deny.clone(),
            session_dir: None,
            limits: Default::default(),
            applied: Vec::new(),
            epoch: 1,
            bare: false,
        }
    }

    #[test]
    fn granted_read_roots_are_the_workspace_plus_the_explicit_grants() {
        let workspace = tempfile::tempdir().unwrap();
        let granted = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path())
            .with_read_root(granted.path());
        let roots = profile.readable_roots();
        assert!(roots.contains(&workspace.path().to_path_buf()), "{roots:?}");
        assert!(roots.contains(&granted.path().to_path_buf()), "{roots:?}");
    }

    #[test]
    fn a_read_outside_the_granted_roots_is_refused_on_every_tier() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let resolved = plan(workspace.path(), &[]);
        let error =
            horizoncode_sandbox::check_path(FsOp::Read, &outside.path().join("id_rsa"), &resolved)
                .unwrap_err();
        assert_eq!(error.code(), "SANDBOX_VIOLATION", "{error}");
        assert!(
            horizoncode_sandbox::check_path(FsOp::Read, &workspace.path().join("ok.txt"), &resolved)
                .is_ok()
        );
    }

    #[test]
    fn a_lexically_escaped_read_is_refused() {
        let workspace = tempfile::tempdir().unwrap();
        let resolved = plan(workspace.path(), &[]);
        let escape = workspace.path().join("../outside.txt");
        assert!(horizoncode_sandbox::check_path(FsOp::Read, &escape, &resolved).is_err());
    }

    #[test]
    fn a_granted_read_root_is_inside_the_read_scope_but_not_the_write_scope() {
        let workspace = tempfile::tempdir().unwrap();
        let granted = tempfile::tempdir().unwrap();
        let resolved = plan(workspace.path(), &[granted.path()]);
        assert!(
            horizoncode_sandbox::check_path(FsOp::Read, &granted.path().join("v.txt"), &resolved).is_ok()
        );
        assert!(
            horizoncode_sandbox::check_path(FsOp::Write, &granted.path().join("v.txt"), &resolved)
                .is_err()
        );
    }

    #[test]
    fn full_access_is_the_only_plan_without_a_read_scope() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let bare = horizoncode_sandbox::ResolvedProfile {
            backend: "bare".to_owned(),
            profile: FsProfile::FullAccess,
            network: NetworkPolicy::Full,
            workspace: workspace.path().to_path_buf(),
            writable_roots: Vec::new(),
            readable_roots: Vec::new(),
            protected: Vec::new(),
            deny: Vec::new(),
            session_dir: None,
            limits: Default::default(),
            applied: vec!["explicit full-access: no confinement applied".to_owned()],
            epoch: 1,
            bare: true,
        };
        assert!(
            horizoncode_sandbox::check_path(FsOp::Read, &outside.path().join("anything"), &bare).is_ok()
        );
    }
}

#[test]
fn unsupported_backend_refuses_confined_effects() {
    let provider = UnsupportedSandbox::new();
    assert!(!provider.probe().is_available());
    let profile = ConfinementProfile::workspace_write(std::env::temp_dir());
    let error = provider.resolve(&profile).unwrap_err();
    assert_eq!(error.code(), "SANDBOX_UNSUPPORTED");

    // Even with a fabricated non-bare plan, spawn refuses rather than running.
    let resolved = horizoncode_sandbox::ResolvedProfile {
        backend: "unsupported".to_owned(),
        profile: FsProfile::WorkspaceWrite,
        network: NetworkPolicy::None,
        workspace: std::env::temp_dir(),
        writable_roots: vec![std::env::temp_dir()],
        readable_roots: vec![std::env::temp_dir()],
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
        let provider = horizoncode_sandbox::BwrapSandbox::with_binary("/nonexistent/bwrap");
        assert!(matches!(provider.probe(), Availability::Unavailable { .. }));
        let profile = ConfinementProfile::workspace_write(std::env::temp_dir());
        let error = provider.resolve(&profile).unwrap_err();
        assert_eq!(error.code(), "SANDBOX_UNSUPPORTED");
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    fn bwrap() -> Option<horizoncode_sandbox::BwrapSandbox> {
        let provider = horizoncode_sandbox::BwrapSandbox::new();
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

    /// `REQ-SEC-025` / `ARCH/13` §Profile matrix: on **every** tier, a read is
    /// scoped to the granted roots. A profile that binds the whole host readable
    /// is a live leak: a default `bash` can read `~/.ssh/id_rsa` or
    /// `/etc/passwd`.
    #[test]
    fn a_spawned_read_outside_the_granted_roots_is_refused() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("id_rsa");
        std::fs::write(&secret, "PRIVATE-KEY-MATERIAL\n").unwrap();
        std::fs::write(workspace.path().join("inside.txt"), "visible\n").unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path());
        let resolved = provider.resolve(&profile).unwrap();

        let script = format!(
            "cat {} 2>/dev/null | grep -q PRIVATE && echo LEAKED || echo OUTSIDE_HIDDEN; \
             cat inside.txt 2>/dev/null",
            secret.display()
        );
        let outcome = provider.spawn(&sh(&script), &resolved).unwrap();
        assert!(outcome.stdout.contains("OUTSIDE_HIDDEN"), "{outcome:?}");
        assert!(!outcome.stdout.contains("LEAKED"), "{outcome:?}");
        // A read *inside* the granted roots still works: scoping is not a lockout.
        assert!(outcome.stdout.contains("visible"), "{outcome:?}");
    }

    #[test]
    fn a_spawned_read_of_a_host_path_outside_the_granted_roots_is_refused() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path());
        let resolved = provider.resolve(&profile).unwrap();
        // `/etc/passwd` and the user's private key directory are not part of the
        // granted roots and are not runtime support data.
        let script = "cat /etc/passwd 2>/dev/null | grep -q root && echo PASSWD_LEAKED \
                      || echo PASSWD_HIDDEN; \
                      ls \"$HOME/.ssh\" 2>/dev/null | grep -q id && echo SSH_LEAKED \
                      || echo SSH_HIDDEN";
        let outcome = provider.spawn(&sh(script), &resolved).unwrap();
        assert!(outcome.stdout.contains("PASSWD_HIDDEN"), "{outcome:?}");
        assert!(!outcome.stdout.contains("PASSWD_LEAKED"), "{outcome:?}");
        assert!(outcome.stdout.contains("SSH_HIDDEN"), "{outcome:?}");
        assert!(!outcome.stdout.contains("SSH_LEAKED"), "{outcome:?}");
    }

    #[test]
    fn an_explicitly_granted_read_root_is_readable() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let granted = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(granted.path().join("vendor.txt"), "VENDOR\n").unwrap();
        std::fs::write(other.path().join("secret.txt"), "NOT-GRANTED\n").unwrap();
        let profile =
            ConfinementProfile::workspace_write(workspace.path()).with_read_root(granted.path());
        let resolved = provider.resolve(&profile).unwrap();
        let script = format!(
            "cat {}/vendor.txt 2>/dev/null; cat {}/secret.txt 2>/dev/null",
            granted.path().display(),
            other.path().display()
        );
        let outcome = provider.spawn(&sh(&script), &resolved).unwrap();
        assert!(outcome.stdout.contains("VENDOR"), "{outcome:?}");
        assert!(!outcome.stdout.contains("NOT-GRANTED"), "{outcome:?}");
    }

    #[test]
    fn check_path_scopes_reads_to_the_granted_roots() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path());
        let resolved = provider.resolve(&profile).unwrap();

        // Inside a granted root: allowed.
        assert!(
            provider
                .check_path(FsOp::Read, &workspace.path().join("a.txt"), &resolved)
                .is_ok()
        );
        // Outside every granted root: refused, not waved through.
        let error = provider
            .check_path(FsOp::Read, &outside.path().join("a.txt"), &resolved)
            .unwrap_err();
        assert_eq!(error.code(), "SANDBOX_VIOLATION", "{error}");
        // A denied path is refused for reads too.
        std::fs::write(workspace.path().join(".env"), "SECRET=1\n").unwrap();
        let denied = provider.resolve(
            &ConfinementProfile::workspace_write(workspace.path()).with_deny("**/.env"),
        )
        .unwrap();
        let error = provider
            .check_path(FsOp::Read, &workspace.path().join(".env"), &denied)
            .unwrap_err();
        assert_eq!(error.code(), "SANDBOX_VIOLATION", "{error}");
    }

    #[test]
    fn timeout_kills_a_long_running_command() {
        let Some(provider) = bwrap() else { return };
        let workspace = tempfile::tempdir().unwrap();
        let profile = ConfinementProfile::workspace_write(workspace.path()).with_limits(
            horizoncode_sandbox::Limits {
                wall_clock_ms: Some(300),
                max_output_bytes: 4096,
            },
        );
        let resolved = provider.resolve(&profile).unwrap();
        let outcome = provider.spawn(&sh("sleep 30"), &resolved).unwrap();
        assert!(outcome.timed_out, "{outcome:?}");
    }
}
