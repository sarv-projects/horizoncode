#![cfg(target_os = "linux")]
//! P1 Guard adversarial matrix for ToolBatch admission bounds, multi-call
//! fail-closed behavior, cross-session lease binding and post-approval TOCTOU.
//!
//! These cases run against the in-process `HostKernel` with real durable effect
//! state and real terminal processes. They are source-bound to:
//! - `kernel/src/host_kernel.rs` (`prepare_tool_batch`, `consume_lease`, `run_terminal`)
//! - `kernel/src/effect_host.rs` (`begin_terminal_effect`, `prepare_terminal_effect`)
//! - `arch_V1/14-EFFECTS-EXECUTION-SECURITY.md` §14.2/§14.3 and the C13/C20/C25 rows
//!   in `implementationtov1release.md`.
//!
//! This suite proves the host relay's complete atomic multi-call admission.
//! The owner-level multi-call admission, cancellation and restart matrix is
//! `kernel/tests/tool_batch_multi_call.rs`.

use horizoncode_kernel::host_kernel::{EFFECTS_SERVICE_ID, HostKernel, TERMINAL_SERVICE_ID};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{FrameFence, RpcOutcomeV1, RpcRequestV1};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::fs;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// Root direct-session admission resolves the typed ServerAuth subject from
// the host binding (§14/DEC-V1-28); the same subject that registered the
// Location fronts every request so the owner binding matches.
const PRINCIPAL: &str = "server_auth:tool-batch-location-owner";
const INCARNATION: &str = "inc_tool_batch_matrix";
const SESSION_A: &str = "ses_matrix_a";
const SESSION_B: &str = "ses_matrix_b";
const TURN_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

struct Fixture {
    base: PathBuf,
    state: PathBuf,
    workspace: PathBuf,
    host: HostKernel,
    location_id: String,
    fence: FrameFence,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // SUN_LEN budget: the kernel socket beneath base/state must fit within
        // ~108 bytes on a repository-local TMPDIR.
        let base = std::env::temp_dir().join(format!(
            "p1tbm-{}-{nonce}",
            std::process::id()
        ));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let mut host = HostKernel::open(&state).unwrap();
        host.set_effects_enabled(true);
        let fence = FrameFence::new(11, INCARNATION).unwrap();
        let response = host.handle_request(
            &request(
                "register_location",
                value_map([
                    ("canonicalRoot", string(workspace.to_str().unwrap())),
                    // Direct-session admission requires a Location bound
                    // to a registered workspace, not just a canonical root.
                    ("workspaceID", string("wrk_tool_batch_matrix")),
                ]),
                1,
            ),
            "server_auth:tool-batch-location-owner",
            &fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
        let location_id = value_string(response.body.as_ref().unwrap(), "locationID").to_owned();
        Self {
            base,
            state,
            workspace,
            host,
            location_id,
            fence,
        }
    }

    fn cleanup(self) {
        drop(self.host);
        fs::remove_dir_all(&self.base).unwrap();
    }

    fn effect_database(&self) -> Option<PathBuf> {
        let path = self
            .state
            .join("effect-locations")
            .join(&self.location_id)
            .join("effects.sqlite");
        path.is_file().then_some(path)
    }

    /// Count durable `effect_challenges` rows for a batch. A location that never
    /// admitted an effect has no database at all, which counts as zero rows.
    fn durable_challenge_count(&self, batch_id: &str) -> i64 {
        let Some(path) = self.effect_database() else {
            return 0;
        };
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let has_table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='effect_challenges'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        if has_table == 0 {
            return 0;
        }
        connection
            .query_row(
                "SELECT COUNT(*) FROM effect_challenges WHERE batch_id=?1",
                [batch_id],
                |row| row.get(0),
            )
            .unwrap()
    }
}

fn write_call(call_id: &str, path: &str, content: &str) -> Value {
    value_map([
        ("callID", string(call_id)),
        ("capabilityID", string("files.write")),
        (
            "arguments",
            value_map([("path", string(path)), ("content", string(content))]),
        ),
    ])
}

fn terminal_call(call_id: &str, shell_profile_id: &str, workspace: &Path, command: &str) -> Value {
    let cwd = fs::canonicalize(workspace).unwrap();
    value_map([
        ("callID", string(call_id)),
        ("capabilityID", string("terminal.run")),
        (
            "arguments",
            value_map([
                // Plain-shell launch contract: every terminal argument set is
                // mode-typed (`shell` vs `workspace_profile`).
                ("mode", string("shell")),
                ("shellProfileID", string(shell_profile_id)),
                ("command", string(command)),
                ("cwd", string(cwd.to_str().unwrap())),
                ("timeoutMs", Value::Unsigned(30_000)),
                ("resolvedEnvironment", Value::Map(BTreeMap::new())),
            ]),
        ),
    ])
}

fn prepare_batch_body(
    location_id: &str,
    session_id: &str,
    batch_id: &str,
    calls: Vec<Value>,
) -> Value {
    value_map([
        ("sessionID", string(session_id)),
        ("locationID", string(location_id)),
        ("batchID", string(batch_id)),
        ("turnContextDigest", string(TURN_DIGEST)),
        ("calls", Value::Array(calls)),
    ])
}

fn request(operation: &str, body: Value, id: u64) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch: 11,
        process_incarnation: INCARNATION.to_owned(),
        request_id: format!("req_matrix_{id}"),
        service_id: EFFECTS_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 30_000,
        trace_id: format!("trace_matrix_{id}"),
        body,
    }
}

fn terminal_request(operation: &str, body: Value, id: u64) -> RpcRequestV1 {
    let mut request = request(operation, body, id);
    request.service_id = TERMINAL_SERVICE_ID.to_owned();
    request
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn value_map<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect::<BTreeMap<_, _>>(),
    )
}

fn value_string<'a>(value: &'a Value, key: &str) -> &'a str {
    let Value::Map(map) = value else {
        panic!("expected map")
    };
    let Some(Value::String(value)) = map.get(key) else {
        panic!("missing string field {key}")
    };
    value
}

fn error_code(response: &horizoncode_kernel::protocol::RpcResponseV1) -> Option<&str> {
    response.error.as_ref().map(|error| error.code.as_str())
}

/// Register the host-owned Linux Bash profile every terminal case resolves.
fn register_bash_profile(fixture: &mut Fixture) -> String {
    let registered = fixture.host.handle_request(
        &terminal_request(
            "register_shell_profiles",
            value_map([
                ("defaultProfileKey", string("posix:bash")),
                (
                    "profiles",
                    Value::Array(vec![value_map([
                        ("profileKey", string("posix:bash")),
                        ("kind", string("posix.bash")),
                        ("executable", string("/bin/bash")),
                        ("login", Value::Bool(false)),
                    ])]),
                ),
            ]),
            20,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(
        registered.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        registered.error
    );
    let body = registered.body.as_ref().unwrap();
    let Value::Map(map) = body else {
        panic!("expected registration map")
    };
    let Some(Value::Array(profiles)) = map.get("profiles") else {
        panic!("missing registered profiles")
    };
    value_string(&profiles[0], "shellProfileID").to_owned()
}

/// Prepare one approved `terminal.run` call and return `(challengeID, effectID, leaseDigest)`.
fn approve_terminal_run(
    fixture: &mut Fixture,
    shell_profile_id: &str,
    session_id: &str,
    batch_id: &str,
    command: &str,
) -> (String, String, String) {
    let prepared = fixture.host.handle_request(
        &request(
            "prepare_tool_batch",
            prepare_batch_body(
                &fixture.location_id,
                session_id,
                batch_id,
                vec![terminal_call(
                    "call_matrix_terminal",
                    shell_profile_id,
                    &fixture.workspace,
                    command,
                )],
            ),
            30,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok, "{:?}", prepared.error);
    let body = prepared.body.unwrap();
    assert_eq!(value_string(&body, "status"), "needs_approval");
    let challenge_id = value_string(&body, "challengeID").to_owned();
    let effect_id = value_string(&body, "effectID").to_owned();

    let approved = fixture.host.handle_request(
        &request(
            "resolve_approval",
            value_map([
                ("challengeID", string(&challenge_id)),
                ("decision", string("allow_once")),
            ]),
            31,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);
    let body = approved.body.unwrap();
    assert_eq!(value_string(&body, "status"), "approved");
    let lease = value_string(&body, "capabilityLeaseDigest").to_owned();
    (challenge_id, effect_id, lease)
}

#[test]
fn multi_call_tool_batch_is_admitted_atomically_without_dispatching_effects() {
    let mut fixture = Fixture::new();
    let response = fixture.host.handle_request(
        &request(
            "prepare_tool_batch",
            prepare_batch_body(
                &fixture.location_id,
                SESSION_A,
                "batch_matrix_multi",
                vec![
                    write_call("call_multi_a", "marker-multi-a.txt", "a"),
                    write_call("call_multi_b", "marker-multi-b.txt", "b"),
                ],
            ),
            40,
        ),
        PRINCIPAL,
        &fixture.fence,
    );

    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
    let Value::Map(body) = response.body.unwrap() else {
        panic!("batch response map")
    };
    // The default direct-session mode is workspace-write + on-request. These
    // writes resolve inside the registered workspace, so Guard admits the
    // complete batch quietly and returns one exact lease per call rather than
    // prompting for approval. The leases authorize later execution only; this
    // prepare request itself must not dispatch either write.
    assert_eq!(body.get("status"), Some(&string("admitted_batch")));
    assert_eq!(body.get("batchID"), Some(&string("batch_matrix_multi")));
    let Some(Value::Array(calls)) = body.get("calls") else {
        panic!("batch members")
    };
    assert_eq!(calls.len(), 2);
    for (index, member) in calls.iter().enumerate() {
        assert_eq!(
            value_string(member, "callId"),
            ["call_multi_a", "call_multi_b"][index]
        );
        assert_eq!(value_string(member, "capabilityId"), "files.write");
        assert_eq!(value_string(member, "locationID"), fixture.location_id);
        assert!(!value_string(member, "policySummary").is_empty());
        let lease = member
            .get("lease")
            .unwrap_or_else(|| panic!("admitted call {index} has no lease"));
        assert_eq!(value_string(lease, "effectID"), value_string(member, "effectId"));
        assert!(value_string(lease, "capabilityLeaseDigest").starts_with("blake3:"));
    }
    assert!(!fixture.workspace.join("marker-multi-a.txt").exists());
    assert!(!fixture.workspace.join("marker-multi-b.txt").exists());
    assert_eq!(fixture.durable_challenge_count("batch_matrix_multi"), 2);

    // A rejected multi-call batch must not corrupt later single-call admission.
    let follow_up = fixture.host.handle_request(
        &request(
            "prepare_tool_batch",
            prepare_batch_body(
                &fixture.location_id,
                SESSION_A,
                "batch_matrix_follow_up",
                vec![write_call("call_follow_up", "marker-follow-up.txt", "ok")],
            ),
            41,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(follow_up.outcome, RpcOutcomeV1::Ok, "{:?}", follow_up.error);
    assert_eq!(value_string(follow_up.body.as_ref().unwrap(), "status"), "prepared");
    assert!(value_string(follow_up.body.as_ref().unwrap(), "capabilityLeaseDigest").starts_with("blake3:"));
    assert_eq!(fixture.durable_challenge_count("batch_matrix_follow_up"), 1);
    assert_eq!(fixture.durable_challenge_count("batch_matrix_multi"), 2);
    fixture.cleanup();
}

#[test]
fn tool_batch_count_bounds_reject_empty_and_over_32_calls() {
    let mut fixture = Fixture::new();

    let empty = fixture.host.handle_request(
        &request(
            "prepare_tool_batch",
            prepare_batch_body(
                &fixture.location_id,
                SESSION_A,
                "batch_matrix_empty",
                vec![],
            ),
            42,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(empty.outcome, RpcOutcomeV1::Error);
    assert_eq!(error_code(&empty), Some("invalid_effect_request"));

    let over_limit: Vec<Value> = (0..33)
        .map(|index| {
            write_call(
                &format!("call_over_{index}"),
                &format!("over-{index}.txt"),
                "x",
            )
        })
        .collect();
    let over = fixture.host.handle_request(
        &request(
            "prepare_tool_batch",
            prepare_batch_body(
                &fixture.location_id,
                SESSION_A,
                "batch_matrix_over",
                over_limit,
            ),
            43,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(over.outcome, RpcOutcomeV1::Error);
    assert_eq!(error_code(&over), Some("invalid_effect_request"));

    let at_limit: Vec<Value> = (0..32)
        .map(|index| {
            write_call(
                &format!("call_limit_{index}"),
                &format!("limit-{index}.txt"),
                "x",
            )
        })
        .collect();
    let at = fixture.host.handle_request(
        &request(
            "prepare_tool_batch",
            prepare_batch_body(
                &fixture.location_id,
                SESSION_A,
                "batch_matrix_limit",
                at_limit,
            ),
            44,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(at.outcome, RpcOutcomeV1::Ok, "{:?}", at.error);
    assert_eq!(fixture.durable_challenge_count("batch_matrix_empty"), 0);
    assert_eq!(fixture.durable_challenge_count("batch_matrix_over"), 0);
    assert_eq!(fixture.durable_challenge_count("batch_matrix_limit"), 32);
    fixture.cleanup();
}

#[test]
fn unsupported_or_duplicate_member_rejects_whole_batch_without_durable_partial_admission() {
    let mut fixture = Fixture::new();
    for (batch, second) in [
        (
            "batch_matrix_unknown",
            value_map([
                ("callID", string("call_unsupported")),
                ("capabilityID", string("automation.invoke")),
                ("arguments", value_map([])),
            ]),
        ),
        (
            "batch_matrix_duplicate",
            write_call("call_first", "duplicate.txt", "x"),
        ),
    ] {
        let response = fixture.host.handle_request(
            &request(
                "prepare_tool_batch",
                prepare_batch_body(
                    &fixture.location_id,
                    SESSION_A,
                    batch,
                    vec![write_call("call_first", "first.txt", "x"), second],
                ),
                55,
            ),
            PRINCIPAL,
            &fixture.fence,
        );
        if response.outcome == RpcOutcomeV1::Ok {
            assert_eq!(
                value_string(response.body.as_ref().unwrap(), "status"),
                "denied"
            );
        }
        assert_eq!(fixture.durable_challenge_count(batch), 0);
        assert!(!fixture.workspace.join("first.txt").exists());
        assert!(!fixture.workspace.join("duplicate.txt").exists());
    }
    fixture.cleanup();
}

#[test]
fn mixed_effectful_multi_call_batch_never_starts_a_process() {
    let mut fixture = Fixture::new();
    let shell_profile_id = register_bash_profile(&mut fixture);
    let marker = fixture.workspace.join("marker-mixed.txt");
    let response = fixture.host.handle_request(
        &request(
            "prepare_tool_batch",
            prepare_batch_body(
                &fixture.location_id,
                SESSION_A,
                "batch_matrix_mixed",
                vec![
                    write_call("call_mixed_write", "marker-mixed-write.txt", "x"),
                    terminal_call(
                        "call_mixed_run",
                        &shell_profile_id,
                        &fixture.workspace,
                        &format!("touch '{}'", marker.display()),
                    ),
                ],
            ),
            45,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
    assert_eq!(
        value_string(response.body.as_ref().unwrap(), "status"),
        "needs_approval"
    );
    assert!(!marker.exists());
    assert!(!fixture.workspace.join("marker-mixed-write.txt").exists());
    assert_eq!(fixture.durable_challenge_count("batch_matrix_mixed"), 2);
    fixture.cleanup();
}

#[test]
fn cross_session_terminal_run_lease_reuse_is_denied_without_spawn() {
    let mut fixture = Fixture::new();
    let shell_profile_id = register_bash_profile(&mut fixture);
    let marker = fixture.workspace.join("marker-cross-session.txt");
    let command = format!("touch '{}'", marker.display());
    let (_challenge_id, effect_id, lease) = approve_terminal_run(
        &mut fixture,
        &shell_profile_id,
        SESSION_A,
        "batch_matrix_cross",
        &command,
    );
    let cwd = fs::canonicalize(&fixture.workspace).unwrap();
    let run_arguments = |session: &str| {
        value_map([
            ("locationID", string(&fixture.location_id)),
            ("effectID", string(&effect_id)),
            ("capabilityLeaseDigest", string(&lease)),
            ("sessionID", string(session)),
            ("shellProfileID", string(&shell_profile_id)),
            ("command", string(&command)),
            ("cwd", string(cwd.to_str().unwrap())),
            ("timeoutMs", Value::Unsigned(30_000)),
            ("resolvedEnvironment", Value::Map(BTreeMap::new())),
        ])
    };

    // A lease admitted for Session A must not execute under Session B.
    let cross = fixture.host.handle_request(
        &terminal_request("run", run_arguments(SESSION_B), 46),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(cross.outcome, RpcOutcomeV1::Error);
    assert_eq!(error_code(&cross), Some("effect_denied"));
    assert!(!marker.exists(), "cross-session attempt must not spawn");

    // The rejected attempt must not consume the one-use lease or spawn.
    let correct = fixture.host.handle_request(
        &terminal_request("run", run_arguments(SESSION_A), 47),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(correct.outcome, RpcOutcomeV1::Ok, "{:?}", correct.error);
    let body = correct.body.unwrap();
    assert_eq!(value_string(&body, "status"), "exited");
    assert!(marker.exists());
    fixture.cleanup();
}

#[test]
fn guarded_terminal_run_confines_workspace_write_and_denies_outside_metadata_write() {
    let mut fixture = Fixture::new();
    let shell_profile_id = register_bash_profile(&mut fixture);
    let outside = fixture.base.join("outside.txt");
    let metadata = fixture.workspace.join(".git/config");
    fs::create_dir_all(metadata.parent().unwrap()).unwrap();
    fs::write(&outside, "outside-before").unwrap();
    fs::write(&metadata, "metadata-before").unwrap();
    let inside = fixture.workspace.join("inside.txt");
    let command = format!(
        "printf inside > '{}'; (printf escaped > '{}') 2>/dev/null; (printf forged > '{}') 2>/dev/null; printf CONFINED_DONE",
        inside.display(),
        outside.display(),
        metadata.display(),
    );
    let (_challenge_id, effect_id, lease) = approve_terminal_run(
        &mut fixture,
        &shell_profile_id,
        SESSION_A,
        "batch_matrix_confined_fs",
        &command,
    );
    let cwd = fs::canonicalize(&fixture.workspace).unwrap();
    let response = fixture.host.handle_request(
        &terminal_request(
            "run",
            value_map([
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("sessionID", string(SESSION_A)),
                ("shellProfileID", string(&shell_profile_id)),
                ("command", string(&command)),
                ("cwd", string(cwd.to_str().unwrap())),
                ("timeoutMs", Value::Unsigned(30_000)),
                ("resolvedEnvironment", Value::Map(BTreeMap::new())),
            ]),
            48,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
    let body = response.body.unwrap();
    assert_eq!(value_string(&body, "status"), "exited");
    assert!(value_string(&body, "preview").contains("CONFINED_DONE"));
    assert_eq!(fs::read_to_string(inside).unwrap(), "inside");
    assert_eq!(fs::read_to_string(outside).unwrap(), "outside-before");
    assert_eq!(fs::read_to_string(metadata).unwrap(), "metadata-before");
    fixture.cleanup();
}

#[test]
fn guarded_terminal_run_cannot_connect_to_a_host_network_listener() {
    let mut fixture = Fixture::new();
    let shell_profile_id = register_bash_profile(&mut fixture);
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let command = format!(
        "if echo probe >/dev/tcp/127.0.0.1/{port} 2>/dev/null; then printf NETWORK_CONNECTED; else printf NETWORK_DENIED; fi"
    );
    let (_challenge_id, effect_id, lease) = approve_terminal_run(
        &mut fixture,
        &shell_profile_id,
        SESSION_A,
        "batch_matrix_confined_net",
        &command,
    );
    let cwd = fs::canonicalize(&fixture.workspace).unwrap();
    let response = fixture.host.handle_request(
        &terminal_request(
            "run",
            value_map([
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("sessionID", string(SESSION_A)),
                ("shellProfileID", string(&shell_profile_id)),
                ("command", string(&command)),
                ("cwd", string(cwd.to_str().unwrap())),
                ("timeoutMs", Value::Unsigned(30_000)),
                ("resolvedEnvironment", Value::Map(BTreeMap::new())),
            ]),
            49,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
    let body = response.body.unwrap();
    assert_eq!(value_string(&body, "status"), "exited");
    assert!(value_string(&body, "preview").contains("NETWORK_DENIED"));
    assert!(
        listener.accept().is_err(),
        "confined command reached host listener"
    );
    fixture.cleanup();
}

#[test]
fn mutated_terminal_command_after_approval_is_denied_without_spawn() {
    let mut fixture = Fixture::new();
    let shell_profile_id = register_bash_profile(&mut fixture);
    let original_marker = fixture.workspace.join("marker-original.txt");
    let mutated_marker = fixture.workspace.join("marker-mutated.txt");
    let original = format!("touch '{}'", original_marker.display());
    let mutated = format!("touch '{}'", mutated_marker.display());
    let (_challenge_id, effect_id, lease) = approve_terminal_run(
        &mut fixture,
        &shell_profile_id,
        SESSION_A,
        "batch_matrix_mutation",
        &original,
    );
    let cwd = fs::canonicalize(&fixture.workspace).unwrap();
    let run = |command: &str, id: u64| {
        terminal_request(
            "run",
            value_map([
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("sessionID", string(SESSION_A)),
                ("shellProfileID", string(&shell_profile_id)),
                ("command", string(command)),
                ("cwd", string(cwd.to_str().unwrap())),
                ("timeoutMs", Value::Unsigned(30_000)),
                ("resolvedEnvironment", Value::Map(BTreeMap::new())),
            ]),
            id,
        )
    };

    // Approval is bound to the exact normalized command digest; a different
    // command in the run continuation must not execute.
    let mutated_attempt =
        fixture
            .host
            .handle_request(&run(&mutated, 48), PRINCIPAL, &fixture.fence);
    assert_eq!(
        mutated_attempt.outcome,
        RpcOutcomeV1::Error,
        "unexpected mutated command response: body={:?}, error={:?}",
        mutated_attempt.body,
        mutated_attempt.error
    );
    assert_eq!(error_code(&mutated_attempt), Some("effect_denied"));
    assert!(!mutated_marker.exists());
    assert!(!original_marker.exists());

    // The mismatched attempt is a denied dispatch, not a reusable approval: the
    // one-use lease is consumed and the original command cannot be replayed.
    let replay = fixture
        .host
        .handle_request(&run(&original, 49), PRINCIPAL, &fixture.fence);
    assert_eq!(replay.outcome, RpcOutcomeV1::Error);
    assert_eq!(error_code(&replay), Some("effect_denied"));
    assert!(!original_marker.exists());
    fixture.cleanup();
}

#[test]
fn files_write_lease_cannot_execute_a_terminal_run() {
    let mut fixture = Fixture::new();
    let shell_profile_id = register_bash_profile(&mut fixture);
    let prepared = fixture.host.handle_request(
        &request(
            "prepare_tool_batch",
            prepare_batch_body(
                &fixture.location_id,
                SESSION_A,
                "batch_matrix_capability_swap",
                vec![write_call("call_swap_write", "marker-swap.txt", "swap")],
            ),
            50,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok, "{:?}", prepared.error);
    let body = prepared.body.unwrap();
    let effect_id = value_string(&body, "effectID").to_owned();
    let lease = match value_string(&body, "status") {
        // Quiet direct-mode candidates already carry the exact one-use lease;
        // they do not have a challenge to resolve.
        "prepared" => value_string(&body, "capabilityLeaseDigest").to_owned(),
        "needs_approval" => {
            let challenge_id = value_string(&body, "challengeID").to_owned();
            let approved = fixture.host.handle_request(
                &request(
                    "resolve_approval",
                    value_map([
                        ("challengeID", string(&challenge_id)),
                        ("decision", string("allow_once")),
                    ]),
                    51,
                ),
                PRINCIPAL,
                &fixture.fence,
            );
            assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);
            value_string(approved.body.as_ref().unwrap(), "capabilityLeaseDigest").to_owned()
        }
        status => panic!("unexpected files.write admission status: {status}"),
    };

    let marker = fixture.workspace.join("marker-capability-swap.txt");
    let cwd = fs::canonicalize(&fixture.workspace).unwrap();
    let swapped = fixture.host.handle_request(
        &terminal_request(
            "run",
            value_map([
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("sessionID", string(SESSION_A)),
                ("shellProfileID", string(&shell_profile_id)),
                ("command", string(&format!("touch '{}'", marker.display()))),
                ("cwd", string(cwd.to_str().unwrap())),
                ("timeoutMs", Value::Unsigned(30_000)),
                ("resolvedEnvironment", Value::Map(BTreeMap::new())),
            ]),
            52,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(swapped.outcome, RpcOutcomeV1::Error);
    assert_eq!(error_code(&swapped), Some("effect_denied"));
    assert!(!marker.exists());
    assert!(!fixture.workspace.join("marker-swap.txt").exists());
    fixture.cleanup();
}
