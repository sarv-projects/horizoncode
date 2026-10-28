#![cfg(target_os = "linux")]

use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{
    AuthenticatedPrincipalV1, FEATURE_EFFECTS_V2, KernelHelloV1, KernelStartupStatusV1,
    RpcMessageV1, RpcOutcomeV1, RpcRequestV1, read_message, write_message,
};
use horizoncode_kernel::unix_peer::{UnixPeerPolicy, connect_authenticated};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        // SUN_LEN budget: the kernel socket beneath this directory must stay
        // within ~108 bytes on a repository-local TMPDIR.
        let path = std::env::temp_dir().join(format!(
            "p1te-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn map<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect::<BTreeMap<_, _>>(),
    )
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    let Value::Map(fields) = value else {
        panic!("expected map")
    };
    let Some(Value::String(value)) = fields.get(key) else {
        panic!("missing {key}")
    };
    value
}

fn host_process_with_argv0_running(marker: &str) -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            return false;
        };
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let Some((_, fields)) = stat.rsplit_once(") ") else {
            return false;
        };
        let mut fields = fields.split_whitespace();
        let Some(state) = fields.next() else {
            return false;
        };
        if state == "Z" || state == "X" {
            return false;
        }
        fs::read(format!("/proc/{pid}/cmdline"))
            .ok()
            .is_some_and(|cmdline| {
                cmdline
                    .split(|byte| *byte == 0)
                    .any(|argument| argument == marker.as_bytes())
            })
    })
}

fn rpc(
    owner_epoch: u64,
    incarnation: &str,
    id: &str,
    service: &str,
    operation: &str,
    body: Value,
) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch,
        process_incarnation: incarnation.to_owned(),
        request_id: format!("req_{id}"),
        service_id: service.to_owned(),
        operation: operation.to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 30_000,
        trace_id: format!("trace_{id}"),
        body,
    }
}

fn request(
    stream: &mut horizoncode_kernel::unix_peer::AuthenticatedUnixStream,
    owner_epoch: u64,
    incarnation: &str,
    id: &str,
    service: &str,
    operation: &str,
    body: Value,
) -> Value {
    let message = rpc(owner_epoch, incarnation, id, service, operation, body);
    if operation == "register_location" {
        write_message(
            stream,
            &RpcMessageV1::AuthenticatedRequest {
                request: Box::new(message),
                principal: AuthenticatedPrincipalV1::ServerAuth {
                    subject: "terminal-events-user".to_owned(),
                },
                context: None,
            },
        )
        .unwrap();
    } else {
        write_message(stream, &RpcMessageV1::Request(Box::new(message))).unwrap();
    }
    match read_message(stream).unwrap().unwrap() {
        RpcMessageV1::Response(response) => {
            assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
            response.body.unwrap()
        }
        other => panic!("expected host response, got {other:?}"),
    }
}

#[test]
fn authenticated_hz_kernel_terminal_start_cleans_escaped_processes_on_owner_loss() {
    let directory = Directory::new();
    let state = directory.0.join("state");
    let workspace = directory.0.join("workspace");
    fs::create_dir(&state).unwrap();
    fs::create_dir(&workspace).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
    let state = fs::canonicalize(state).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let socket = state.join("hz-kernel.sock");
    let core_exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let kernel_exe = fs::canonicalize(env!("CARGO_BIN_EXE_hz-kernel")).unwrap();
    let nonce = "host-terminal-events-nonce";
    let incarnation = "inc_host_terminal_events";
    let mut child = Process(
        Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
            .arg(format!("--state-dir={}", state.display()))
            .arg(format!("--socket={}", socket.display()))
            .arg(format!("--host-exe={}", core_exe.display()))
            .arg(format!("--nonce={nonce}"))
            .arg(format!("--incarnation={incarnation}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            // The kernel's own startup diagnostics are the only evidence when it
            // refuses to come up; never discard them.
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stderr = child.0.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut captured = String::new();
            let _ = std::io::Read::read_to_string(&mut pipe, &mut captured);
            captured
        })
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    let exited = loop {
        if child.0.try_wait().unwrap().is_some() {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        thread::sleep(Duration::from_millis(10));
    };
    if !socket.exists() {
        let detail = if exited {
            let captured = stderr
                .and_then(|handle| handle.join().ok())
                .unwrap_or_default();
            let captured = captured.trim();
            if captured.is_empty() {
                "<exited without stderr>".to_owned()
            } else {
                captured.to_owned()
            }
        } else {
            "<child still running when the startup deadline expired>".to_owned()
        };
        panic!("hz-kernel did not create its private socket (exited={exited}): {detail}");
    }
    let mut stream = connect_authenticated(
        &socket,
        UnixPeerPolicy {
            uid: unsafe { libc::geteuid() },
            executable: kernel_exe,
        },
    )
    .unwrap();
    write_message(
        &mut stream,
        &RpcMessageV1::Hello(Box::new(KernelHelloV1 {
            min_protocol: 1,
            max_protocol: 1,
            host_build_digest: format!("blake3:{}", "a".repeat(64)),
            kernel_build_digest: None,
            host_instance_id: "host_terminal_events_test".to_owned(),
            process_incarnation: incarnation.to_owned(),
            supervisor_nonce: nonce.to_owned(),
            required_features: vec![FEATURE_EFFECTS_V2.to_owned()],
            optional_features: Vec::new(),
        })),
    )
    .unwrap();
    let owner_epoch = match read_message(&mut stream).unwrap().unwrap() {
        RpcMessageV1::HelloResult(result) => result.owner_epoch,
        other => panic!("expected negotiated hello, got {other:?}"),
    };
    let mut ready = false;
    for _ in 0..16 {
        match read_message(&mut stream).unwrap().unwrap() {
            RpcMessageV1::StartupStatus(status) if *status == KernelStartupStatusV1::Ready => {
                ready = true;
                break;
            }
            RpcMessageV1::StartupStatus(status) if *status == KernelStartupStatusV1::Starting => {}
            other => panic!("unexpected startup frame: {other:?}"),
        }
    }
    assert!(ready, "hz-kernel did not reach READY");

    let location = request(
        &mut stream,
        owner_epoch,
        incarnation,
        "register_location",
        FEATURE_EFFECTS_V2,
        "register_location",
        map([("canonicalRoot", string(workspace.to_str().unwrap()))]),
    );
    let location_id = text(&location, "locationID").to_owned();
    let profiles = request(
        &mut stream,
        owner_epoch,
        incarnation,
        "register_profiles",
        "terminal.v1",
        "register_shell_profiles",
        map([
            ("defaultProfileKey", string("posix:bash")),
            (
                "profiles",
                Value::Array(vec![map([
                    ("profileKey", string("posix:bash")),
                    ("kind", string("posix.bash")),
                    ("executable", string("/bin/bash")),
                    ("login", Value::Bool(false)),
                ])]),
            ),
        ]),
    );
    let Value::Map(profile_fields) = &profiles else {
        panic!("expected profile map")
    };
    let Some(Value::Array(profile_list)) = profile_fields.get("profiles") else {
        panic!("missing profile list")
    };
    let shell_profile_id = text(&profile_list[0], "shellProfileID").to_owned();
    let executable = text(&profile_list[0], "executable").to_owned();
    let terminal_id = "pty_auth_events_1";
    let pid_path = workspace.join("authenticated-start-pid");
    let process_marker = format!("hz-terminal-owner-loss-{}", std::process::id());
    let shell_command = format!(
        "/usr/bin/setsid /bin/bash -c 'echo $$ > \"{}\"; exec -a {} sleep 60'",
        pid_path.display(),
        process_marker,
    );
    let arguments = map([
        ("terminalID", string(terminal_id)),
        ("shellProfileID", string(&shell_profile_id)),
        ("command", string(&executable)),
        (
            "args",
            Value::Array(vec![string("-c"), string(&shell_command)]),
        ),
        ("cwd", string(workspace.to_str().unwrap())),
        ("cols", Value::Unsigned(80)),
        ("rows", Value::Unsigned(24)),
        ("env", map([])),
    ]);
    let prepared = request(
        &mut stream,
        owner_epoch,
        incarnation,
        "prepare_start",
        FEATURE_EFFECTS_V2,
        "prepare_user_effect",
        map([
            ("locationID", string(&location_id)),
            ("userActionID", string("act_auth_terminal_event")),
            ("capabilityID", string("terminal.start")),
            ("arguments", arguments),
        ]),
    );
    assert_eq!(text(&prepared, "status"), "needs_approval");
    let challenge_id = text(&prepared, "challengeID").to_owned();
    let effect_id = text(&prepared, "effectID").to_owned();
    let approved = request(
        &mut stream,
        owner_epoch,
        incarnation,
        "approve_start",
        FEATURE_EFFECTS_V2,
        "resolve_approval",
        map([
            ("challengeID", string(&challenge_id)),
            ("decision", string("allow_once")),
        ]),
    );
    let lease = text(&approved, "capabilityLeaseDigest").to_owned();
    let start_body = map([
        ("effectID", string(&effect_id)),
        ("capabilityLeaseDigest", string(&lease)),
        ("locationID", string(&location_id)),
        ("terminalID", string(terminal_id)),
        ("shellProfileID", string(&shell_profile_id)),
        ("command", string(&executable)),
        (
            "args",
            Value::Array(vec![string("-c"), string(&shell_command)]),
        ),
        ("cwd", string(workspace.to_str().unwrap())),
        ("cols", Value::Unsigned(80)),
        ("rows", Value::Unsigned(24)),
        ("env", map([])),
    ]);
    write_message(
        &mut stream,
        &RpcMessageV1::Request(Box::new(rpc(
            owner_epoch,
            incarnation,
            "start_terminal",
            "terminal.v1",
            "start",
            start_body.clone(),
        ))),
    )
    .unwrap();
    let started = match read_message(&mut stream).unwrap().unwrap() {
        RpcMessageV1::Response(response) => response,
        other => panic!("expected terminal start response, got {other:?}"),
    };
    assert_eq!(started.outcome, RpcOutcomeV1::Ok, "{:?}", started.error);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pid_path.exists() {
        assert!(Instant::now() < deadline, "terminal child did not start");
        thread::sleep(Duration::from_millis(10));
    }
    let _pid: u32 = fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(
        host_process_with_argv0_running(&process_marker),
        "unique escaped child argv must be alive before owner loss"
    );

    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while host_process_with_argv0_running(&process_marker) {
        assert!(
            Instant::now() < deadline,
            "unique escaped child argv survived owner loss"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let _ = stream.shutdown();
}
