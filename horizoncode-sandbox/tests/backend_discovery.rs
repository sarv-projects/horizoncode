#![cfg(target_os = "linux")]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

#[test]
fn probing_never_executes_backend_or_helper_from_inherited_path() {
    if std::env::var_os("HZ_SANDBOX_DISCOVERY_CHILD").is_some() {
        let sandbox = horizoncode_sandbox::Sandbox::probe();
        if let Some(path) = sandbox.capabilities().bwrap.path() {
            assert!(path.starts_with("/usr/bin") || path.starts_with("/bin"));
        }
        return;
    }
    let root = std::env::temp_dir().join(format!("hz-sandbox-path-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let marker = root.join("fake-was-executed");
    for name in ["bwrap", "true"] {
        let fake = root.join(name);
        fs::write(
            &fake,
            format!(
                "#!/bin/sh\nprintf unsafe > '{}'\nprintf 'bubblewrap 0.11.0\\n'\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(fake, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let outcome = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "probing_never_executes_backend_or_helper_from_inherited_path",
            "--nocapture",
        ])
        .env("HZ_SANDBOX_DISCOVERY_CHILD", "1")
        .env("PATH", &root)
        .output()
        .unwrap();
    let fake_ran = marker.exists();
    fs::remove_dir_all(root).unwrap();
    assert!(
        !fake_ran,
        "untrusted PATH executable ran during sandbox capability preflight"
    );
    assert!(
        outcome.status.success(),
        "{}",
        String::from_utf8_lossy(&outcome.stderr)
    );
}
