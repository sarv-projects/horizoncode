#![cfg(target_os = "linux")]

use horizoncode_kernel::host_kernel::{EFFECTS_SERVICE_ID, HostKernel, TERMINAL_SERVICE_ID};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{
    CursorV1, FrameFence, RpcControlV1, RpcEventV1, RpcMessageV1, RpcOutcomeV1, RpcRequestV1,
};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PRINCIPAL: &str = "host_os_uid:1000";
const INCARNATION: &str = "inc_host_terminal";
/// Prefix of the unique `argv[0]` riders use to resolve the C22 escapee. Terminal
/// commands run inside the sandbox's fresh PID namespace, so a pid announced by the
/// escapee is namespace-local and cannot be probed from the test's (outer) namespace;
/// the escapee is instead located here by a per-run argv0, exactly like the
/// supervisor's outer-namespace `/proc` sweep that must find and kill it.
const ESCAPEE_ARGV0_PREFIX: &str = "hz_c22_escapee";

struct Fixture {
    base: PathBuf,
    workspace: PathBuf,
    host: Option<HostKernel>,
    location_id: String,
    shell_profile_id: String,
    executable: String,
    fence: FrameFence,
    escapee_argv0: String,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("hz-host-terminal-{}-{nonce}", std::process::id()));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let mut opened = HostKernel::open(&state).unwrap();
        // The host only serves effects.v2 after a successful feature negotiation.
        opened.set_effects_enabled(true);
        let mut host = Some(opened);
        let fence = FrameFence::new(11, INCARNATION).unwrap();
        let response = host.as_mut().unwrap().handle_request(
            &request(
                EFFECTS_SERVICE_ID,
                "register_location",
                map([("canonicalRoot", string(workspace.to_str().unwrap()))]),
                1,
            ),
            "server_auth:host-terminal-location-owner",
            &fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
        let location_id = text(response.body.as_ref().unwrap(), "locationID").to_owned();
        let registered = host.as_mut().unwrap().handle_request(
            &request(
                TERMINAL_SERVICE_ID,
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
                2,
            ),
            PRINCIPAL,
            &fence,
        );
        let body = registered.body.as_ref().unwrap();
        let Value::Map(fields) = body else {
            panic!("expected registration map")
        };
        let Some(Value::Array(profiles)) = fields.get("profiles") else {
            panic!("missing profiles")
        };
        let profile_id = text(&profiles[0], "shellProfileID").to_owned();
        let executable = text(&profiles[0], "executable").to_owned();
        Self {
            base,
            workspace,
            host,
            location_id,
            shell_profile_id: profile_id,
            executable,
            fence,
            escapee_argv0: format!("{ESCAPEE_ARGV0_PREFIX}_{nonce}"),
        }
    }

    fn cleanup(self) {
        drop(self.host);
        fs::remove_dir_all(self.base).unwrap();
    }

    fn start_arguments(&self, marker: &str) -> Value {
        let marker_path = self.workspace.join("interactive-start-marker");
        let escapee_path = self.workspace.join("interactive-escapee-pid");
        let command = format!(
            "printf '{marker}'; /usr/bin/setsid /bin/bash -c 'echo $$ > \"{}\"; touch \"{}\"; exec -a {} /usr/bin/sleep 600' & exec /bin/bash",
            escapee_path.display(),
            marker_path.display(),
            self.escapee_argv0
        );
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("shellProfileID", string(&self.shell_profile_id)),
            ("command", string(&self.executable)),
            ("args", Value::Array(vec![string("-c"), string(&command)])),
            ("cwd", string(self.workspace.to_str().unwrap())),
            ("cols", Value::Unsigned(80)),
            ("rows", Value::Unsigned(24)),
            ("env", map([])),
        ])
    }
    fn restart(&mut self) {
        self.host.take();
        self.fence = FrameFence::new(12, "inc_host_terminal_restart").unwrap();
        self.host = Some(HostKernel::open(&self.base.join("state")).unwrap());
    }

    fn request(
        &mut self,
        service: &str,
        operation: &str,
        body: Value,
        id: u64,
    ) -> horizoncode_kernel::protocol::RpcResponseV1 {
        self.request_as(service, operation, body, id, PRINCIPAL)
    }

    fn request_as(
        &mut self,
        service: &str,
        operation: &str,
        body: Value,
        id: u64,
        principal: &str,
    ) -> horizoncode_kernel::protocol::RpcResponseV1 {
        let mut request = request(service, operation, body, id);
        request.owner_epoch = self.fence.owner_epoch();
        request.process_incarnation = self.fence.process_incarnation().to_owned();
        self.host
            .as_mut()
            .unwrap()
            .handle_request(&request, principal, &self.fence)
    }
}

fn request(service: &str, operation: &str, body: Value, id: u64) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch: 11,
        process_incarnation: INCARNATION.to_owned(),
        request_id: format!("req_host_terminal_{id}"),
        service_id: service.to_owned(),
        operation: operation.to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 30_000,
        trace_id: format!("trace_host_terminal_{id}"),
        body,
    }
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn map<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect::<BTreeMap<_, _>>(),
    )
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

fn unsigned(value: &Value, key: &str) -> u64 {
    let Value::Map(fields) = value else {
        panic!("expected map")
    };
    let Some(Value::Unsigned(value)) = fields.get(key) else {
        panic!("missing {key}")
    };
    *value
}

fn process_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Outer-namespace pids of this test's C22 escapee(s), located by the per-run
/// `argv[0]` marker. Zombies are excluded: the supervisor must fully terminate and
/// reap the escaped descendant, not merely leave a zombie in its tree.
fn escapee_outer_pids(marker: &str) -> Vec<u32> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut pids = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((_, fields)) = stat.rsplit_once(") ") else {
            continue;
        };
        if matches!(fields.split_whitespace().next(), Some("Z" | "X")) {
            continue;
        }
        let matched = fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmdline| {
            cmdline
                .split(|byte| *byte == 0)
                .any(|argument| argument == marker.as_bytes())
        });
        if matched {
            pids.push(pid);
        }
    }
    pids
}

fn terminal_event_cursor_matches(event: &RpcEventV1) -> bool {
    let Value::Map(fields) = &event.payload else {
        return false;
    };
    let Some(Value::String(terminal_id)) = fields.get("terminalID") else {
        return false;
    };
    let Some(Value::Unsigned(generation)) = fields.get("generation") else {
        return false;
    };
    let Some(Value::Unsigned(sequence)) = fields.get("sequence") else {
        return false;
    };
    let Some(Value::Unsigned(byte_cursor)) = fields.get("byteCursor") else {
        return false;
    };
    let Some(Value::String(kind)) = fields.get("kind") else {
        return false;
    };
    let Some(payload @ Value::Binary(_)) = fields.get("payload") else {
        return false;
    };
    let canonical = map([
        ("terminalID", string(terminal_id)),
        ("generation", Value::Unsigned(*generation)),
        ("sequence", Value::Unsigned(*sequence)),
        ("byteCursor", Value::Unsigned(*byte_cursor)),
        ("kind", string(kind)),
        ("payload", payload.clone()),
    ]);
    let Ok(encoded) = horizoncode_kernel::messagepack::encode(
        &canonical,
        horizoncode_kernel::messagepack::FRAME_LIMITS,
    ) else {
        return false;
    };
    event.cursor.owner_kind == "terminal"
        && event.cursor.owner_id == terminal_id.as_str()
        && event.cursor.seq == sequence.to_string()
        && event.cursor.event_digest == format!("blake3:{}", blake3::hash(&encoded).to_hex())
}

#[test]
fn unapproved_start_never_launches_a_process() {
    let mut fixture = Fixture::new();
    let response = fixture.request(
        TERMINAL_SERVICE_ID,
        "start",
        map([
            ("effectID", string("eff_missing")),
            (
                "capabilityLeaseDigest",
                string(&format!("blake3:{}", "0".repeat(64))),
            ),
            ("locationID", string(&fixture.location_id)),
            ("terminalID", string("pty_host_terminal_1")),
            ("shellProfileID", string(&fixture.shell_profile_id)),
            ("command", string("/bin/bash")),
            ("args", Value::Array(vec![])),
            ("cwd", string(fixture.workspace.to_str().unwrap())),
            ("cols", Value::Unsigned(80)),
            ("rows", Value::Unsigned(24)),
            ("env", map([])),
        ]),
        3,
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    assert!(!fixture.workspace.join("denied-start-marker").exists());
    fixture.cleanup();
}

#[test]
fn ticket_requests_require_bound_origin_principal_and_terminal() {
    let mut fixture = Fixture::new();
    // A renderer origin outside the host allowlist fails before any terminal lookup.
    let bad_origin = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_acquire",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string("https://evil.example")),
            ("protocol", string("horizon.terminal.v1")),
            ("principal", map([("source", string("host_os"))])),
        ]),
        200,
    );
    assert_eq!(bad_origin.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        bad_origin.error.as_ref().map(|error| error.code.as_str()),
        Some("BAD_FRAME")
    );
    // Declaring a `server_auth` subject the transport session did not authenticate is denied.
    let unattested_principal = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_acquire",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string("oc://renderer")),
            ("protocol", string("horizon.terminal.v1")),
            ("principal", map([("source", string("server_auth")), ("username", string("intruder"))])),
        ]),
        201,
    );
    assert_eq!(unattested_principal.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        unattested_principal
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("DENIED")
    );
    // Only the V2 ticket protocol is accepted.
    let legacy_protocol = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_acquire",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string("oc://renderer")),
            ("protocol", string("legacy")),
            ("principal", map([("source", string("host_os"))])),
        ]),
        202,
    );
    assert_eq!(legacy_protocol.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        legacy_protocol
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("BAD_FRAME")
    );
    // Consumption of an unknown token is denied without revealing whether it existed.
    let unknown_token = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_consume",
        map([
            ("ticket", string(&"y".repeat(64))),
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string("oc://renderer")),
            ("protocol", string("horizon.terminal.v1")),
            ("principal", map([("source", string("host_os"))])),
        ]),
        203,
    );
    assert_eq!(unknown_token.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        unknown_token.error.as_ref().map(|error| error.code.as_str()),
        Some("DENIED")
    );
    // Revocation against an unknown terminal reports a typed not-found.
    let unknown_terminal = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_revoke",
        map([
            ("ticketID", string("ticket_never_issued")),
            ("terminalID", string("pty_host_terminal_missing")),
        ]),
        204,
    );
    assert_eq!(unknown_terminal.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        unknown_terminal
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("effect_not_found")
    );
    fixture.cleanup();
}

#[test]
fn interactive_lifecycle_requires_approved_guard_lease() {
    let mut fixture = Fixture::new();
    let arguments = fixture.start_arguments("host-terminal-output");
    let marker_path = fixture.workspace.join("interactive-start-marker");
    let prepare = fixture.request(
        EFFECTS_SERVICE_ID,
        "prepare_user_effect",
        map([
            ("locationID", string(&fixture.location_id)),
            ("userActionID", string("act_host_terminal")),
            ("capabilityID", string("terminal.start")),
            ("arguments", arguments.clone()),
        ]),
        4,
    );
    assert_eq!(prepare.outcome, RpcOutcomeV1::Ok, "{:?}", prepare.error);
    let prepared = prepare.body.unwrap();
    assert_eq!(text(&prepared, "status"), "needs_approval");
    let challenge = text(&prepared, "challengeID").to_owned();
    let effect = text(&prepared, "effectID").to_owned();
    let approved = fixture.request(
        EFFECTS_SERVICE_ID,
        "resolve_approval",
        map([
            ("challengeID", string(&challenge)),
            ("decision", string("allow_once")),
        ]),
        5,
    );
    assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);
    let lease = text(approved.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned();
    let Value::Map(mut start_body) = arguments else {
        panic!("expected approved terminal argument map");
    };
    start_body.insert("effectID".to_owned(), string(&effect));
    start_body.insert("capabilityLeaseDigest".to_owned(), string(&lease));
    start_body.insert("locationID".to_owned(), string(&fixture.location_id));
    let start_body = Value::Map(start_body);
    let started = fixture.request(TERMINAL_SERVICE_ID, "start", start_body.clone(), 6);
    if !horizoncode_kernel::terminal_process::TerminalProcess::owner_loss_tree_cleanup_supported() {
        assert_eq!(started.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            started.error.as_ref().map(|error| error.code.as_str()),
            Some("UNAVAILABLE")
        );
        assert!(started.error.as_ref().is_some_and(|error| {
            error
                .message
                .contains("cannot guarantee process-tree cleanup")
        }));
        assert!(
            !marker_path.exists(),
            "fail-closed start must not spawn the command"
        );
        let retry = fixture.request(TERMINAL_SERVICE_ID, "start", start_body, 7);
        assert_eq!(retry.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            retry.error.as_ref().map(|error| error.code.as_str()),
            Some("UNAVAILABLE"),
            "failed admission must not consume the one-use lease"
        );
        assert!(!marker_path.exists());
        let status = fixture.request(
            TERMINAL_SERVICE_ID,
            "status",
            map([
                ("terminalID", string("pty_host_terminal_1")),
                ("generation", Value::Unsigned(1)),
            ]),
            8,
        );
        assert_eq!(
            status.error.as_ref().map(|error| error.code.as_str()),
            Some("effect_not_found"),
            "refused start must not persist a terminal session"
        );
        fixture.cleanup();
        return;
    }
    assert_eq!(started.outcome, RpcOutcomeV1::Ok, "{:?}", started.error);
    let started_body = started.body.as_ref().unwrap();
    assert_eq!(text(started_body, "status"), "running");
    assert_eq!(text(started_body, "backend"), "linux_pty");
    let generation = unsigned(started_body, "generation");
    let leader = unsigned(started_body, "pid") as i32;

    // C22 acceptance: a session descendant that escapes the PTY session (setsid)
    // must announce its pid and must be terminated by the terminal supervisor
    // once the terminal is cancelled.
    let escapee_path = fixture.workspace.join("interactive-escapee-pid");
    let announce_deadline = Instant::now() + Duration::from_secs(10);
    let escapee = loop {
        if marker_path.exists()
            && let Ok(raw) = fs::read_to_string(&escapee_path)
            && let Ok(pid) = raw.trim().parse::<i32>()
        {
            break pid;
        }
        assert!(
            Instant::now() < announce_deadline,
            "escaped session descendant must announce its pid"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    // The announced pid is namespace-local (the command runs under the sandbox's
    // fresh PID namespace); resolve the live escapee from this outer namespace via
    // its unique argv0, which is also what the supervisor's sweep operates on.
    let outer_escapees = escapee_outer_pids(&fixture.escapee_argv0);
    assert!(process_alive(leader), "PTY leader must be alive while running");
    assert!(
        !outer_escapees.is_empty(),
        "escaped session descendant must be alive before cancellation (announced namespace-local pid {escapee})"
    );
    let grant = text(started_body, "grantID").to_owned();
    let after = CursorV1 {
        owner_kind: "terminal".to_owned(),
        owner_id: "pty_host_terminal_1".to_owned(),
        seq: "0".to_owned(),
        event_digest: format!("blake3:{}", "0".repeat(64)),
    };
    let control = RpcControlV1::Subscribe {
        owner_epoch: fixture.fence.owner_epoch(),
        process_incarnation: fixture.fence.process_incarnation().to_owned(),
        subscription_id: "sub_host_terminal_output".to_owned(),
        owner_kind: "terminal".to_owned(),
        owner_id: "pty_host_terminal_1".to_owned(),
        after: Some(after),
    };
    let mut saw_subscribed_output = false;
    let mut outgoing = fixture
        .host
        .as_mut()
        .unwrap()
        .handle_terminal_control(&control, &fixture.fence);
    for _ in 0..30 {
        outgoing.extend(
            fixture
                .host
                .as_mut()
                .unwrap()
                .poll_terminal_events(&fixture.fence),
        );
        saw_subscribed_output |= outgoing.iter().any(|message| match message {
            RpcMessageV1::Event(event) => {
                let RpcEventV1 { event_type, cursor, payload, .. } = event.as_ref();
                event_type == "terminal.output"
                    && terminal_event_cursor_matches(event)
                    && cursor.owner_kind == "terminal"
                    && cursor.owner_id == "pty_host_terminal_1"
                    && matches!(payload, Value::Map(fields)
                        if matches!(fields.get("terminalID"), Some(Value::String(id)) if id == "pty_host_terminal_1")
                        && matches!(fields.get("generation"), Some(Value::Unsigned(value)) if *value == generation)
                        && matches!(fields.get("sequence"), Some(Value::Unsigned(value)) if *value == cursor.seq.parse::<u64>().unwrap())
                        && matches!(fields.get("byteCursor"), Some(Value::Unsigned(value)) if *value > 0)
                        && matches!(fields.get("kind"), Some(Value::String(kind)) if kind == "output")
                        && matches!(fields.get("payload"), Some(Value::Binary(bytes)) if bytes.windows(b"host-terminal-output".len()).any(|window| window == b"host-terminal-output")))
            }
            _ => false,
        });
        if saw_subscribed_output {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(
        saw_subscribed_output,
        "live PTY output must reach a terminal owner-event subscriber"
    );
    let mut saw_initial_output = false;
    for id in 18..38 {
        let status = fixture.request(
            TERMINAL_SERVICE_ID,
            "status",
            map([
                ("terminalID", string("pty_host_terminal_1")),
                ("generation", Value::Unsigned(generation)),
                ("afterSequence", Value::Unsigned(0)),
                ("afterByteCursor", Value::Unsigned(0)),
                ("maxBytes", Value::Unsigned(64 * 1024)),
            ]),
            id,
        );
        assert_eq!(status.outcome, RpcOutcomeV1::Ok, "{:?}", status.error);
        if let Some(Value::Map(fields)) = status.body.as_ref()
            && let Some(Value::Array(events)) = fields.get("replay")
        {
            saw_initial_output |= events.iter().any(|event| match event {
                Value::Map(fields) => matches!(fields.get("payload"), Some(Value::Binary(bytes)) if bytes.windows(b"host-terminal-output".len()).any(|window| window == b"host-terminal-output")),
                _ => false,
            });
        }
        if saw_initial_output {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(
        saw_initial_output,
        "initial PTY output must be replayable from the byte cursor"
    );
    let origin = "oc://renderer";
    let ticket = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_acquire",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string(origin)),
            ("protocol", string("horizon.terminal.v1")),
            ("principal", map([("source", string("host_os"))])),
        ]),
        7,
    );
    assert_eq!(ticket.outcome, RpcOutcomeV1::Ok, "{:?}", ticket.error);
    let ticket_body = ticket.body.as_ref().unwrap();
    let ticket_id = text(ticket_body, "ticketID").to_owned();
    let token = text(ticket_body, "ticket").to_owned();
    // A valid token is bound to the acquiring origin, principal and terminal; consuming
    // it from a different renderer origin, with an unknown token, or under a different
    // transport principal must all be denied, and none of the attempts may consume it.
    let foreign_origin = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_consume",
        map([
            ("ticket", string(&token)),
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string("http://tauri.localhost")),
            ("protocol", string("horizon.terminal.v1")),
            ("principal", map([("source", string("host_os"))])),
        ]),
        190,
    );
    assert_eq!(foreign_origin.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        foreign_origin.error.as_ref().map(|error| error.code.as_str()),
        Some("DENIED")
    );
    let unknown_token = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_consume",
        map([
            ("ticket", string(&"x".repeat(64))),
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string(origin)),
            ("protocol", string("horizon.terminal.v1")),
            ("principal", map([("source", string("host_os"))])),
        ]),
        191,
    );
    assert_eq!(unknown_token.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        unknown_token.error.as_ref().map(|error| error.code.as_str()),
        Some("DENIED")
    );
    let foreign_principal = fixture.request_as(
        TERMINAL_SERVICE_ID,
        "ticket_consume",
        map([
            ("ticket", string(&token)),
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string(origin)),
            ("protocol", string("horizon.terminal.v1")),
            ("principal", map([("source", string("server_auth")), ("username", string("intruder"))])),
        ]),
        192,
        "server_auth:intruder",
    );
    assert_eq!(foreign_principal.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        foreign_principal
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("DENIED")
    );
    let consume = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_consume",
        map([
            ("ticket", string(&token)),
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string(origin)),
            ("protocol", string("horizon.terminal.v1")),
            ("principal", map([("source", string("host_os"))])),
        ]),
        8,
    );
    assert_eq!(consume.outcome, RpcOutcomeV1::Ok, "{:?}", consume.error);
    let consumed = consume.body.as_ref().unwrap();
    assert_eq!(text(consumed, "ticketID"), ticket_id);
    let attachment = text(consumed, "attachmentID").to_owned();
    let replayed = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_consume",
        map([
            ("ticket", string(&token)),
            ("terminalID", string("pty_host_terminal_1")),
            ("locationID", string(&fixture.location_id)),
            ("origin", string(origin)),
            ("protocol", string("horizon.terminal.v1")),
            ("principal", map([("source", string("host_os"))])),
        ]),
        9,
    );
    assert_eq!(replayed.outcome, RpcOutcomeV1::Error);

    let bad_grant = fixture.request(
        TERMINAL_SERVICE_ID,
        "input",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("generation", Value::Unsigned(generation)),
            ("grantID", string("wrong")),
            ("attachmentID", string(&attachment)),
            ("sequence", Value::Unsigned(0)),
            ("bytes", Value::Binary(b"echo never\\n".to_vec())),
        ]),
        10,
    );
    assert_eq!(bad_grant.outcome, RpcOutcomeV1::Error);
    let bytes = b"echo terminal-input-marker\n";
    let input = fixture.request(
        TERMINAL_SERVICE_ID,
        "input",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("generation", Value::Unsigned(generation)),
            ("grantID", string(&grant)),
            ("attachmentID", string(&attachment)),
            ("sequence", Value::Unsigned(0)),
            ("bytes", Value::Binary(bytes.to_vec())),
        ]),
        11,
    );
    assert_eq!(input.outcome, RpcOutcomeV1::Ok, "{:?}", input.error);
    let duplicate = fixture.request(
        TERMINAL_SERVICE_ID,
        "input",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("generation", Value::Unsigned(generation)),
            ("grantID", string(&grant)),
            ("attachmentID", string(&attachment)),
            ("sequence", Value::Unsigned(0)),
            ("bytes", Value::Binary(bytes.to_vec())),
        ]),
        12,
    );
    assert_eq!(duplicate.outcome, RpcOutcomeV1::Ok, "{:?}", duplicate.error);
    let resize = fixture.request(
        TERMINAL_SERVICE_ID,
        "resize",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("generation", Value::Unsigned(generation)),
            ("grantID", string(&grant)),
            ("attachmentID", string(&attachment)),
            ("sequence", Value::Unsigned(1)),
            ("cols", Value::Unsigned(120)),
            ("rows", Value::Unsigned(40)),
        ]),
        13,
    );
    assert_eq!(resize.outcome, RpcOutcomeV1::Ok, "{:?}", resize.error);
    let too_large = fixture.request(
        TERMINAL_SERVICE_ID,
        "input",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("generation", Value::Unsigned(generation)),
            ("grantID", string(&grant)),
            ("attachmentID", string(&attachment)),
            ("sequence", Value::Unsigned(2)),
            ("bytes", Value::Binary(vec![b'x'; 16 * 1024 + 1])),
        ]),
        14,
    );
    assert_eq!(too_large.outcome, RpcOutcomeV1::Error);
    let overflow_input = fixture.request(
        TERMINAL_SERVICE_ID,
        "input",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("generation", Value::Unsigned(generation)),
            ("grantID", string(&grant)),
            ("attachmentID", string(&attachment)),
            ("sequence", Value::Unsigned(2)),
            (
                "bytes",
                Value::Binary(b"head -c 2200000 /dev/zero\n".to_vec()),
            ),
        ]),
        15,
    );
    assert_eq!(
        overflow_input.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        overflow_input.error
    );
    // Keep pumping the original live subscriber while the process writes enough
    // output to evict the beginning of the replay ring. A live subscription has
    // already been offered its events, so its cursor may advance without requiring
    // a resnapshot when older bytes are evicted.
    for _ in 0..200 {
        let _messages = fixture
            .host
            .as_mut()
            .unwrap()
            .poll_terminal_events(&fixture.fence);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let replay_state = fixture.request(
        TERMINAL_SERVICE_ID,
        "status",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("generation", Value::Unsigned(generation)),
            ("afterSequence", Value::Unsigned(0)),
            ("afterByteCursor", Value::Unsigned(0)),
            ("maxBytes", Value::Unsigned(64 * 1024)),
        ]),
        181,
    );
    let retained_cursor = replay_state
        .body
        .as_ref()
        .and_then(|body| match body {
            Value::Map(fields) => fields.get("byteCursor"),
            _ => None,
        })
        .and_then(|value| match value {
            Value::Unsigned(value) => Some(*value),
            _ => None,
        })
        .unwrap_or(0);
    assert!(
        retained_cursor > horizoncode_kernel::terminal::REPLAY_CAPACITY as u64,
        "overflow fixture must produce more than the 2 MiB replay cap; observed byteCursor={retained_cursor}"
    );
    let reconnect = RpcControlV1::Subscribe {
        owner_epoch: fixture.fence.owner_epoch(),
        process_incarnation: fixture.fence.process_incarnation().to_owned(),
        subscription_id: "sub_host_terminal_reconnect".to_owned(),
        owner_kind: "terminal".to_owned(),
        owner_id: "pty_host_terminal_1".to_owned(),
        after: Some(CursorV1 {
            owner_kind: "terminal".to_owned(),
            owner_id: "pty_host_terminal_1".to_owned(),
            seq: "0".to_owned(),
            event_digest: format!("blake3:{}", "0".repeat(64)),
        }),
    };
    let reconnect_messages = fixture
        .host
        .as_mut()
        .unwrap()
        .handle_terminal_control(&reconnect, &fixture.fence);
    let reconnect_requires_snapshot = reconnect_messages.iter().any(|message| {
        matches!(
            message,
            RpcMessageV1::Control(control)
                if matches!(control.as_ref(), RpcControlV1::ResnapshotRequired {
                    subscription_id,
                    requested,
                    latest,
                    ..
                } if subscription_id == "sub_host_terminal_reconnect"
                    && requested.owner_kind == "terminal"
                    && requested.owner_id == "pty_host_terminal_1"
                    && latest.owner_id == "pty_host_terminal_1")
        )
    });
    assert!(
        reconnect_requires_snapshot,
        "a reconnect from the evicted zero cursor must require a resnapshot; observed cursor={retained_cursor}, retained limit={} bytes",
        horizoncode_kernel::terminal::REPLAY_CAPACITY,
    );

    let cancelled = fixture.request(
        TERMINAL_SERVICE_ID,
        "cancel",
        map([
            ("effectID", string(&effect)),
            ("terminalID", string("pty_host_terminal_1")),
            ("generation", Value::Unsigned(generation)),
            ("reason", string("user_removed")),
        ]),
        40,
    );
    assert_eq!(cancelled.outcome, RpcOutcomeV1::Ok, "{:?}", cancelled.error);
    let death_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = escapee_outer_pids(&fixture.escapee_argv0);
        if remaining.is_empty() {
            break;
        }
        assert!(
            Instant::now() < death_deadline,
            "cancelled terminal must terminate the escaped session descendant (announced namespace-local pid {escapee}, outer pids {remaining:?})"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut observed_cancelled = false;
    for id in 50..80 {
        let status = fixture.request(
            TERMINAL_SERVICE_ID,
            "status",
            map([
                ("terminalID", string("pty_host_terminal_1")),
                ("generation", Value::Unsigned(generation)),
            ]),
            id,
        );
        assert_eq!(status.outcome, RpcOutcomeV1::Ok, "{:?}", status.error);
        if let Some(body) = status.body.as_ref()
            && text(body, "status") == "cancelled"
        {
            observed_cancelled = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        observed_cancelled,
        "cancellation must settle into the cancelled terminal status"
    );
    assert!(
        !process_alive(leader),
        "PTY leader must be reaped after cancellation"
    );
    let revoked = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_revoke",
        map([
            ("ticketID", string(&ticket_id)),
            ("terminalID", string("pty_host_terminal_1")),
            ("attachmentID", string(&attachment)),
        ]),
        41,
    );
    assert_eq!(revoked.outcome, RpcOutcomeV1::Ok, "{:?}", revoked.error);
    let revoked_again = fixture.request(
        TERMINAL_SERVICE_ID,
        "ticket_revoke",
        map([
            ("ticketID", string(&ticket_id)),
            ("terminalID", string("pty_host_terminal_1")),
            ("attachmentID", string(&attachment)),
        ]),
        42,
    );
    assert_eq!(
        revoked_again.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        revoked_again.error
    );
    fixture.restart();
    let after_restart = fixture.request(
        TERMINAL_SERVICE_ID,
        "status",
        map([
            ("terminalID", string("pty_host_terminal_1")),
            ("generation", Value::Unsigned(generation)),
            ("afterSequence", Value::Unsigned(0)),
            ("afterByteCursor", Value::Unsigned(0)),
        ]),
        43,
    );
    assert_eq!(
        after_restart.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        after_restart.error
    );
    let lost = after_restart.body.as_ref().unwrap();
    assert_eq!(text(lost, "status"), "unknown");
    assert!(
        matches!(lost, Value::Map(fields) if matches!(fields.get("sessionLost"), Some(Value::Bool(true))) && matches!(fields.get("replay"), Some(Value::Array(events)) if events.is_empty()))
    );
}
