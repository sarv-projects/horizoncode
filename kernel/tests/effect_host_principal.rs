#![cfg(target_os = "linux")]

use horizoncode_kernel::host_kernel::{EFFECTS_SERVICE_ID, HostKernel, TERMINAL_SERVICE_ID};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{FrameFence, RpcOutcomeV1, RpcRequestV1};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const PRINCIPAL: &str = "host_os_uid:1000";
const INCARNATION: &str = "inc_effect_test";

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
        let base =
            std::env::temp_dir().join(format!("hz-effect-host-{}-{nonce}", std::process::id()));
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
                value_map([("canonicalRoot", string(workspace.to_str().unwrap()))]),
                1,
            ),
            "server_auth:effect-host-location-owner",
            &fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok);
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
        fs::remove_dir_all(self.base).unwrap();
    }

    fn prepare(&mut self, capability: &str, arguments: Value, call_id: &str) -> (String, String) {
        let body = value_map([
            ("sessionID", string("ses_effect_test")),
            ("locationID", string(&self.location_id)),
            ("batchID", string("batch_effect_test")),
            (
                "turnContextDigest",
                string(&format!("sha256:{}", "0".repeat(64))),
            ),
            (
                "calls",
                Value::Array(vec![value_map([
                    ("callID", string(call_id)),
                    ("capabilityID", string(capability)),
                    ("arguments", arguments),
                ])]),
            ),
        ]);
        let response = self.host.handle_request(
            &request("prepare_tool_batch", body, 2),
            PRINCIPAL,
            &self.fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok);
        let body = response.body.unwrap();
        assert_eq!(value_string(&body, "status"), "needs_approval");
        (
            value_string(&body, "challengeID").to_owned(),
            value_string(&body, "effectID").to_owned(),
        )
    }

    fn approve(&mut self, challenge_id: &str) -> String {
        let response = self.host.handle_request(
            &request(
                "resolve_approval",
                value_map([
                    ("challengeID", string(challenge_id)),
                    ("decision", string("allow_once")),
                ]),
                3,
            ),
            PRINCIPAL,
            &self.fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok);
        let body = response.body.unwrap();
        assert_eq!(value_string(&body, "status"), "approved");
        value_string(&body, "capabilityLeaseDigest").to_owned()
    }
}

fn request(operation: &str, body: Value, id: u64) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch: 11,
        process_incarnation: INCARNATION.to_owned(),
        request_id: format!("req_effect_{id}"),
        service_id: EFFECTS_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 30_000,
        trace_id: format!("trace_effect_{id}"),
        body,
    }
}

fn request_for_epoch(operation: &str, body: Value, id: u64, epoch: u64) -> RpcRequestV1 {
    let mut request = request(operation, body, id);
    request.owner_epoch = epoch;
    request
}

fn terminal_request(operation: &str, body: Value, id: u64) -> RpcRequestV1 {
    let mut request = request(operation, body, id);
    request.service_id = TERMINAL_SERVICE_ID.to_owned();
    request
}

fn registered_profile_id(body: &Value) -> String {
    let Value::Map(map) = body else {
        panic!("expected registration map")
    };
    let Some(Value::Array(profiles)) = map.get("profiles") else {
        panic!("missing registered profiles")
    };
    assert_eq!(profiles.len(), 1);
    value_string(&profiles[0], "shellProfileID").to_owned()
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
    registered_profile_id(registered.body.as_ref().unwrap())
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

#[test]
fn explicit_allow_once_settles_a_registered_location_write() {
    let mut fixture = Fixture::new();
    let (challenge_id, effect_id) = fixture.prepare(
        "files.write",
        value_map([
            ("path", string("write.txt")),
            ("content", string("approved write")),
        ]),
        "call_write",
    );
    let lease = fixture.approve(&challenge_id);
    let response = fixture.host.handle_request(
        &request(
            "execute_write",
            value_map([
                ("sessionID", string("ses_effect_test")),
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("content", string("approved write")),
            ]),
            4,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        value_string(response.body.as_ref().unwrap(), "status"),
        "settled"
    );
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("write.txt")).unwrap(),
        "approved write"
    );
    fixture.cleanup();
}

#[test]
fn explicit_allow_once_settles_a_registered_location_patch() {
    let mut fixture = Fixture::new();
    let operation = value_map([
        ("operation", string("write")),
        ("path", string("patch.txt")),
        ("expectedBeforeBase64", Value::Nil),
        ("contentBase64", string("cGF0Y2hlZA==")),
    ]);
    let (challenge_id, effect_id) = fixture.prepare(
        "files.patch",
        value_map([("operations", Value::Array(vec![operation.clone()]))]),
        "call_patch",
    );
    let lease = fixture.approve(&challenge_id);
    let response = fixture.host.handle_request(
        &request(
            "execute_patch",
            value_map([
                ("sessionID", string("ses_effect_test")),
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("operations", Value::Array(vec![operation])),
            ]),
            5,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        value_string(response.body.as_ref().unwrap(), "status"),
        "settled"
    );
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("patch.txt")).unwrap(),
        "patched"
    );
    fixture.cleanup();
}

#[test]
fn wrong_authenticated_principal_cannot_approve_or_create_a_file() {
    let mut fixture = Fixture::new();
    let (challenge_id, _) = fixture.prepare(
        "files.write",
        value_map([
            ("path", string("denied.txt")),
            ("content", string("must not exist")),
        ]),
        "call_deny",
    );
    let denied = fixture.host.handle_request(
        &request(
            "resolve_approval",
            value_map([
                ("challengeID", string(&challenge_id)),
                ("decision", string("allow_once")),
            ]),
            6,
        ),
        "host_os_uid:1001",
        &fixture.fence,
    );
    assert_eq!(denied.outcome, RpcOutcomeV1::Error);
    assert!(!fixture.workspace.join("denied.txt").exists());
    fixture.cleanup();
}

#[test]
fn restart_does_not_reuse_a_prior_epoch_lease() {
    let mut fixture = Fixture::new();
    let (challenge_id, effect_id) = fixture.prepare(
        "files.write",
        value_map([
            ("path", string("restart.txt")),
            ("content", string("must not replay")),
        ]),
        "call_restart",
    );
    let lease = fixture.approve(&challenge_id);
    drop(fixture.host);
    let mut restarted = HostKernel::open(&fixture.state).unwrap();
    restarted.set_effects_enabled(true);
    let response = restarted.handle_request(
        &request_for_epoch(
            "execute_write",
            value_map([
                ("sessionID", string("ses_effect_test")),
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("content", string("must not replay")),
            ]),
            7,
            12,
        ),
        PRINCIPAL,
        &FrameFence::new(12, INCARNATION).unwrap(),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    assert!(!fixture.workspace.join("restart.txt").exists());
    drop(restarted);
    fs::remove_dir_all(fixture.base).unwrap();
}

#[test]
fn settled_write_receipt_is_queryable_after_restart_when_execute_response_was_lost() {
    let mut fixture = Fixture::new();
    let (challenge_id, effect_id) = fixture.prepare(
        "files.write",
        value_map([
            ("path", string("lost-response.txt")),
            ("content", string("settled before disconnect")),
        ]),
        "call_lost_response",
    );
    let lease = fixture.approve(&challenge_id);
    let _lost_response = fixture.host.handle_request(
        &request(
            "execute_write",
            value_map([
                ("sessionID", string("ses_effect_test")),
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("content", string("settled before disconnect")),
            ]),
            8,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(_lost_response.outcome, RpcOutcomeV1::Ok);
    drop(fixture.host);

    let mut restarted = HostKernel::open(&fixture.state).unwrap();
    restarted.set_effects_enabled(true);
    let reconciled = restarted.handle_request(
        &request_for_epoch(
            "reconcile_effect",
            value_map([
                ("effectID", string(&effect_id)),
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_effect_test")),
            ]),
            9,
            12,
        ),
        PRINCIPAL,
        &FrameFence::new(12, INCARNATION).unwrap(),
    );
    assert_eq!(reconciled.outcome, RpcOutcomeV1::Ok);
    let body = reconciled.body.unwrap();
    assert_eq!(value_string(&body, "status"), "settled");
    assert_eq!(value_string(&body, "effectID"), effect_id);
    assert!(value_string(&body, "receiptDigest").starts_with("blake3:"));
    let wrong_principal = restarted.handle_request(
        &request_for_epoch(
            "reconcile_effect",
            value_map([
                ("effectID", string(&effect_id)),
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_effect_test")),
            ]),
            12,
            12,
        ),
        "host_os_uid:1001",
        &FrameFence::new(12, INCARNATION).unwrap(),
    );
    assert_eq!(wrong_principal.outcome, RpcOutcomeV1::Error);
    let wrong_session = restarted.handle_request(
        &request_for_epoch(
            "reconcile_effect",
            value_map([
                ("effectID", string(&effect_id)),
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_other")),
            ]),
            13,
            12,
        ),
        PRINCIPAL,
        &FrameFence::new(12, INCARNATION).unwrap(),
    );
    assert_eq!(wrong_session.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("lost-response.txt")).unwrap(),
        "settled before disconnect"
    );
    drop(restarted);
    fs::remove_dir_all(fixture.base).unwrap();
}

#[test]
fn prepared_applied_write_is_settled_from_location_after_state_on_restart() {
    let mut fixture = Fixture::new();
    let (challenge_id, effect_id) = fixture.prepare(
        "files.write",
        value_map([
            ("path", string("prepared-write.txt")),
            ("content", string("applied before crash")),
        ]),
        "call_prepared_recovery",
    );
    let lease = fixture.approve(&challenge_id);
    let executed = fixture.host.handle_request(
        &request(
            "execute_write",
            value_map([
                ("sessionID", string("ses_effect_test")),
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("content", string("applied before crash")),
            ]),
            8,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(executed.outcome, RpcOutcomeV1::Ok);
    drop(fixture.host);

    let effect_db = fixture
        .state
        .join("effect-locations")
        .join(&fixture.location_id)
        .join("effects.sqlite");
    let connection = Connection::open(effect_db).unwrap();
    assert_eq!(
        connection.execute(
            "UPDATE effect_challenges SET status='PREPARED', receipt_digest=NULL WHERE effect_id=?1",
            [&effect_id],
        ).unwrap(),
        1,
    );
    drop(connection);

    let mut restarted = HostKernel::open(&fixture.state).unwrap();
    restarted.set_effects_enabled(true);
    let reconciled = restarted.handle_request(
        &request_for_epoch(
            "reconcile_effect",
            value_map([
                ("effectID", string(&effect_id)),
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_effect_test")),
            ]),
            9,
            12,
        ),
        PRINCIPAL,
        &FrameFence::new(12, INCARNATION).unwrap(),
    );
    assert_eq!(reconciled.outcome, RpcOutcomeV1::Ok);
    let body = reconciled.body.unwrap();
    assert_eq!(value_string(&body, "status"), "settled");
    assert!(value_string(&body, "receiptDigest").starts_with("blake3:"));
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("prepared-write.txt")).unwrap(),
        "applied before crash"
    );
    drop(restarted);
    fs::remove_dir_all(fixture.base).unwrap();
}

#[test]
fn mixed_patch_recovery_stays_unknown_and_does_not_replay_missing_target() {
    let mut fixture = Fixture::new();
    let first = value_map([
        ("operation", string("write")),
        ("path", string("mixed-first.txt")),
        ("expectedBeforeBase64", Value::Nil),
        ("contentBase64", string("Zmlyc3Q=")),
    ]);
    let second = value_map([
        ("operation", string("write")),
        ("path", string("mixed-second.txt")),
        ("expectedBeforeBase64", Value::Nil),
        ("contentBase64", string("c2Vjb25k")),
    ]);
    let (challenge_id, effect_id) = fixture.prepare(
        "files.patch",
        value_map([(
            "operations",
            Value::Array(vec![first.clone(), second.clone()]),
        )]),
        "call_mixed_patch",
    );
    let lease = fixture.approve(&challenge_id);
    let executed = fixture.host.handle_request(
        &request(
            "execute_patch",
            value_map([
                ("sessionID", string("ses_effect_test")),
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("operations", Value::Array(vec![first, second])),
            ]),
            10,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(executed.outcome, RpcOutcomeV1::Ok);
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("mixed-first.txt")).unwrap(),
        "first"
    );
    fs::remove_file(fixture.workspace.join("mixed-second.txt")).unwrap();
    drop(fixture.host);

    let effect_db = fixture
        .state
        .join("effect-locations")
        .join(&fixture.location_id)
        .join("effects.sqlite");
    let connection = Connection::open(effect_db).unwrap();
    connection.execute(
        "UPDATE effect_challenges SET status='PREPARED', receipt_digest=NULL WHERE effect_id=?1",
        [&effect_id],
    ).unwrap();
    drop(connection);

    let mut restarted = HostKernel::open(&fixture.state).unwrap();
    restarted.set_effects_enabled(true);
    let unresolved = restarted.handle_request(
        &request_for_epoch(
            "reconcile_effect",
            value_map([
                ("effectID", string(&effect_id)),
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_effect_test")),
            ]),
            11,
            12,
        ),
        PRINCIPAL,
        &FrameFence::new(12, INCARNATION).unwrap(),
    );
    assert_eq!(unresolved.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        unresolved.error.as_ref().map(|error| error.code.as_str()),
        Some("effect_outcome_unknown")
    );
    assert!(!fixture.workspace.join("mixed-second.txt").exists());
    drop(restarted);
    fs::remove_dir_all(fixture.base).unwrap();
}

#[test]
fn settled_terminal_run_reconciles_as_a_run_effect() {
    let mut fixture = Fixture::new();
    let shell_profile_id = register_bash_profile(&mut fixture);
    let cwd = fs::canonicalize(&fixture.workspace).unwrap();
    let cwd = cwd.to_str().unwrap();
    let arguments = value_map([
        ("shellProfileID", string(&shell_profile_id)),
        ("command", string("printf run-effect")),
        ("cwd", string(cwd)),
        ("timeoutMs", Value::Unsigned(30_000)),
        ("resolvedEnvironment", Value::Map(BTreeMap::new())),
    ]);
    let (challenge_id, effect_id) = fixture.prepare("terminal.run", arguments, "call_terminal");
    let lease = fixture.approve(&challenge_id);
    let executed = fixture.host.handle_request(
        &terminal_request(
            "run",
            value_map([
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("sessionID", string("ses_effect_test")),
                ("shellProfileID", string(&shell_profile_id)),
                ("command", string("printf run-effect")),
                ("cwd", string(cwd)),
                ("timeoutMs", Value::Unsigned(30_000)),
                ("resolvedEnvironment", Value::Map(BTreeMap::new())),
            ]),
            21,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(executed.outcome, RpcOutcomeV1::Ok, "{:?}", executed.error);
    let body = executed.body.unwrap();
    assert_eq!(value_string(&body, "status"), "exited");
    assert_eq!(value_string(&body, "preview"), "run-effect");
    let Value::Map(settled) = &body else {
        panic!("expected settled run map")
    };
    assert_eq!(settled.get("previewTruncated"), Some(&Value::Bool(false)));
    assert_eq!(settled.get("artifactTruncated"), Some(&Value::Bool(false)));
    assert_eq!(settled.get("exitCode"), Some(&Value::Unsigned(0)));
    let reconciled = fixture.host.handle_request(
        &request(
            "reconcile_effect",
            value_map([
                ("effectID", string(&effect_id)),
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_effect_test")),
            ]),
            22,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(reconciled.outcome, RpcOutcomeV1::Ok);
    let body = reconciled.body.unwrap();
    assert_eq!(value_string(&body, "status"), "settled");
    let Value::Map(map) = &body else {
        panic!("expected reconcile map")
    };
    let Some(Value::Array(targets)) = map.get("targets") else {
        panic!("missing reconcile targets")
    };
    assert_eq!(targets.len(), 1);
    assert_eq!(value_string(&targets[0], "operation"), "run");
    assert_eq!(value_string(&targets[0], "resource"), ".");
    fixture.cleanup();
}

#[test]
fn legacy_effect_schema_without_origin_kind_is_upgraded_on_open() {
    let fixture = Fixture::new();
    let effect_db = fixture
        .state
        .join("effect-locations")
        .join(&fixture.location_id)
        .join("effects.sqlite");
    drop(fixture.host);
    let connection = Connection::open(&effect_db).unwrap();
    connection
        .execute_batch("ALTER TABLE effect_challenges DROP COLUMN origin_kind;")
        .unwrap();
    let present = |connection: &Connection| -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('effect_challenges') WHERE name='origin_kind'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    assert_eq!(present(&connection), 0);
    drop(connection);

    // Reopening the Location must upgrade the durable schema before any effect is admitted.
    let host = HostKernel::open(&fixture.state).unwrap();
    let mut host = host;
    host.set_effects_enabled(true);
    let connection = Connection::open(&effect_db).unwrap();
    assert_eq!(present(&connection), 1);
    let default: String = connection
        .query_row(
            "SELECT dflt_value FROM pragma_table_info('effect_challenges') WHERE name='origin_kind'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(default, "'session_batch'");
    drop(connection);
    drop(host);
    fs::remove_dir_all(&fixture.base).unwrap();
}

#[test]
fn user_origin_terminal_run_is_admitted_by_principal_and_settles_after_approval() {
    let mut fixture = Fixture::new();
    let shell_profile_id = register_bash_profile(&mut fixture);
    let cwd = fs::canonicalize(&fixture.workspace).unwrap();
    let cwd = cwd.to_str().unwrap();
    // A user action records the Session as a label only; the host never asserts it, so
    // the authenticated principal plus the explicit approval carry its authority.
    let prepared = fixture.host.handle_request(
        &request(
            "prepare_user_effect",
            value_map([
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_effect_test")),
                ("userActionID", string("act_user_terminal")),
                ("capabilityID", string("terminal.run")),
                (
                    "arguments",
                    value_map([
                        ("shellProfileID", string(&shell_profile_id)),
                        ("command", string("printf user-effect")),
                        ("cwd", string(cwd)),
                        ("timeoutMs", Value::Unsigned(30_000)),
                        ("resolvedEnvironment", Value::Map(BTreeMap::new())),
                    ]),
                ),
            ]),
            31,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok, "{:?}", prepared.error);
    let body = prepared.body.unwrap();
    assert_eq!(value_string(&body, "status"), "needs_approval");
    let challenge_id = value_string(&body, "challengeID").to_owned();
    let effect_id = value_string(&body, "effectID").to_owned();
    let lease = fixture.approve(&challenge_id);
    let executed = fixture.host.handle_request(
        &terminal_request(
            "run",
            value_map([
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("sessionID", string("ses_effect_test")),
                ("shellProfileID", string(&shell_profile_id)),
                ("command", string("printf user-effect")),
                ("cwd", string(cwd)),
                ("timeoutMs", Value::Unsigned(30_000)),
                ("resolvedEnvironment", Value::Map(BTreeMap::new())),
            ]),
            32,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(executed.outcome, RpcOutcomeV1::Ok, "{:?}", executed.error);
    let body = executed.body.unwrap();
    assert_eq!(value_string(&body, "status"), "exited");
    assert_eq!(value_string(&body, "preview"), "user-effect");
    fixture.cleanup();
}

#[test]
fn user_origin_cannot_admit_a_filesystem_effect() {
    let mut fixture = Fixture::new();
    let prepared = fixture.host.handle_request(
        &request(
            "prepare_user_effect",
            value_map([
                ("locationID", string(&fixture.location_id)),
                ("sessionID", string("ses_effect_test")),
                ("userActionID", string("act_user_write")),
                ("capabilityID", string("files.write")),
                (
                    "arguments",
                    value_map([
                        ("path", string("user-write.txt")),
                        ("content", string("must not exist")),
                    ]),
                ),
            ]),
            33,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        prepared.error.as_ref().map(|error| error.code.as_str()),
        Some("effect_unavailable")
    );
    assert!(!fixture.workspace.join("user-write.txt").exists());
    fixture.cleanup();
}
