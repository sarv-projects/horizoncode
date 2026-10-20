#![cfg(target_os = "linux")]
//! C20 complete atomic ToolBatch admission, proven at the `EffectHost` boundary.
//!
//! The host-scoped `hz-kernel` still refuses multi-call batches in `host_kernel.rs`
//! before they reach the effect owner, so this suite drives the real durable
//! `EffectHost` directly with the exact inner request body the host forwards. It proves
//! the generalized owner behavior end to end: validate/plan the complete set with zero
//! side effects, persist every member in one transaction, keep per-call one-use leases and
//! receipts, reconcile after restart, and cancel only members that have not executed.
//!
//! Source-bound to:
//! - `kernel/src/effect_host.rs` (`prepare_tool_batch`, `plan_*`, `persist_batch`,
//!   `execute_write`, `execute_patch`, `cancel_batch`, `reconcile_prepared`)
//! - `kernel/src/guard.rs` (broker action IDs and trusted-executable validation)
//! - `arch_V1/11-LIFECYCLE.md` §11.6/§11.7 and `arch_V1/13-COMPOSITION-IPC.md` §13.5

use horizoncode_kernel::effect_host::{EFFECTS_SERVICE_ID, EffectHost};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{FrameFence, RpcOutcomeV1, RpcRequestV1, RpcResponseV1};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PRINCIPAL: &str = "host_os_uid:1000";
const INCARNATION: &str = "inc_tool_batch_multi";
const SESSION: &str = "ses_multi_call";
const TURN_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

struct Fixture {
    base: PathBuf,
    state: PathBuf,
    workspace: PathBuf,
    host: EffectHost,
    fence: FrameFence,
    next_request: u64,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "hz-tool-batch-multi-{}-{nonce}",
            std::process::id()
        ));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = fs::canonicalize(&workspace).unwrap();
        let host = EffectHost::open(&state, Some(&workspace)).unwrap();
        let fence = FrameFence::new(21, INCARNATION).unwrap();
        Self {
            base,
            state,
            workspace,
            host,
            fence,
            next_request: 0,
        }
    }

    fn cleanup(self) {
        drop(self.host);
        fs::remove_dir_all(&self.base).unwrap();
    }

    fn reconnect(&mut self) {
        drop(std::mem::replace(
            &mut self.host,
            EffectHost::open(&self.state, Some(&self.workspace)).unwrap(),
        ));
    }

    fn request(&mut self, operation: &str, body: Value) -> RpcResponseV1 {
        self.next_request += 1;
        let request = RpcRequestV1 {
            owner_epoch: 21,
            process_incarnation: INCARNATION.to_owned(),
            request_id: format!("req_multi_{}", self.next_request),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: operation.to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 30_000,
            trace_id: format!("trace_multi_{}", self.next_request),
            body,
        };
        self.host
            .handle_request(SESSION, PRINCIPAL, &request, true, &self.fence)
    }

    fn connection(&self) -> Connection {
        Connection::open_with_flags(
            self.state.join("effects.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap()
    }

    fn challenge_rows(&self, batch_id: &str) -> Vec<(String, String, String)> {
        let connection = self.connection();
        let mut statement = connection
            .prepare(
                "SELECT challenge_id, effect_id, status FROM effect_challenges
                 WHERE batch_id=?1 ORDER BY challenge_id",
            )
            .unwrap();
        let rows = statement
            .query_map([batch_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    }
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

fn response_string<'a>(response: &'a RpcResponseV1, key: &str) -> &'a str {
    let body = response.body.as_ref().expect("response body");
    let Value::Map(map) = body else {
        panic!("expected response map")
    };
    let Some(Value::String(value)) = map.get(key) else {
        panic!("missing string field {key}")
    };
    value
}

fn response_unsigned(response: &RpcResponseV1, key: &str) -> u64 {
    let body = response.body.as_ref().expect("response body");
    let Value::Map(map) = body else {
        panic!("expected response map")
    };
    let Some(Value::Unsigned(value)) = map.get(key) else {
        panic!("missing unsigned field {key}")
    };
    *value
}

fn response_calls(response: &RpcResponseV1) -> &[Value] {
    let body = response.body.as_ref().expect("response body");
    let Value::Map(map) = body else {
        panic!("expected response map")
    };
    let Some(Value::Array(calls)) = map.get("calls") else {
        panic!("missing calls array")
    };
    calls
}

fn call_field<'a>(call: &'a Value, key: &str) -> &'a str {
    let Value::Map(map) = call else {
        panic!("expected call map")
    };
    let Some(Value::String(value)) = map.get(key) else {
        panic!("missing call field {key}")
    };
    value
}

fn base64(bytes: &[u8]) -> String {
    const ENCODE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        output.push(ENCODE[(b[0] >> 2) as usize] as char);
        output.push(ENCODE[(((b[0] & 0b11) << 4) | (b[1] >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(ENCODE[(((b[1] & 0b1111) << 2) | (b[2] >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(ENCODE[(b[2] & 0b111111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn write_call(call_id: &str, path: &Path, content: &str) -> Value {
    value_map([
        ("callId", string(call_id)),
        ("capabilityId", string("files.write")),
        (
            "arguments",
            value_map([
                ("path", string(path.to_str().unwrap())),
                ("content", string(content)),
            ]),
        ),
    ])
}

fn patch_call(call_id: &str, path: &Path, content: &str) -> Value {
    value_map([
        ("callId", string(call_id)),
        ("capabilityId", string("files.patch")),
        (
            "arguments",
            value_map([(
                "operations",
                Value::Array(vec![value_map([
                    ("operation", string("write")),
                    ("path", string(path.to_str().unwrap())),
                    ("expectedBeforeBase64", Value::Nil),
                    ("contentBase64", string(&base64(content.as_bytes()))),
                ])]),
            )]),
        ),
    ])
}

fn broker_call(call_id: &str, profile_id: &str) -> Value {
    value_map([
        ("callId", string(call_id)),
        ("capabilityId", string("language.server.start")),
        (
            "arguments",
            value_map([
                ("executableProfileID", string(profile_id)),
                ("root", string(".")),
            ]),
        ),
    ])
}

fn terminal_call(call_id: &str, shell_profile_id: &str, workspace: &Path) -> Value {
    let cwd = fs::canonicalize(workspace).unwrap();
    value_map([
        ("callId", string(call_id)),
        ("capabilityId", string("terminal.run")),
        (
            "arguments",
            value_map([
                ("shellProfileID", string(shell_profile_id)),
                ("command", string("true")),
                ("cwd", string(cwd.to_str().unwrap())),
                ("timeoutMs", Value::Unsigned(30_000)),
                ("resolvedEnvironment", Value::Map(BTreeMap::new())),
            ]),
        ),
    ])
}

fn prepare_body(batch_id: &str, calls: Vec<Value>) -> Value {
    value_map([
        ("sessionId", string(SESSION)),
        ("batchId", string(batch_id)),
        ("turnContextDigest", string(TURN_DIGEST)),
        ("calls", Value::Array(calls)),
    ])
}

fn approve(fixture: &mut Fixture, challenge_id: &str) -> RpcResponseV1 {
    fixture.request(
        "resolve_approval",
        value_map([
            ("sessionId", string(SESSION)),
            ("challengeId", string(challenge_id)),
            ("approved", Value::Bool(true)),
        ]),
    )
}

fn write(fixture: &mut Fixture, challenge_id: &str, content: &str) -> RpcResponseV1 {
    fixture.request(
        "execute_write",
        value_map([
            ("sessionId", string(SESSION)),
            ("challengeId", string(challenge_id)),
            ("content", string(content)),
        ]),
    )
}

#[test]
fn multi_call_batch_admits_atomically_and_settles_each_member_with_its_own_lease() {
    let mut fixture = Fixture::new();
    let first = fixture.workspace.join("first.txt");
    let second = fixture.workspace.join("second.txt");
    let third = fixture.workspace.join("third.txt");
    let response = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_multi_settle",
            vec![
                write_call("call_first", &first, "first"),
                write_call("call_second", &second, "second"),
                patch_call("call_third", &third, "third"),
            ],
        ),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
    assert_eq!(response_string(&response, "status"), "needs_approval");
    assert_eq!(response_string(&response, "batchId"), "batch_multi_settle");
    let calls = response_calls(&response);
    assert_eq!(calls.len(), 3);

    // Planning admits every member without executing anything.
    assert!(!first.exists());
    assert!(!second.exists());
    assert!(!third.exists());
    let rows = fixture.challenge_rows("batch_multi_settle");
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .all(|(_, _, status)| status == "AWAITING_APPROVAL")
    );

    let challenge = |index: usize| call_field(&calls[index], "challengeId").to_owned();
    let effect = |index: usize| call_field(&calls[index], "effectId").to_owned();
    assert_ne!(challenge(0), challenge(1));
    assert_ne!(effect(0), effect(1));

    for index in 0..3 {
        let approved = approve(&mut fixture, &challenge(index));
        assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);
        assert_eq!(response_string(&approved, "status"), "approved");
    }

    // Each member settles through its own one-use challenge and exact receipt.
    let settled_first = write(&mut fixture, &challenge(0), "first");
    assert_eq!(
        settled_first.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        settled_first.error
    );
    let settled_second = write(&mut fixture, &challenge(1), "second");
    assert_eq!(
        settled_second.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        settled_second.error
    );
    let patch_operations = Value::Array(vec![value_map([
        ("operation", string("write")),
        ("path", string(third.to_str().unwrap())),
        ("expectedBeforeBase64", Value::Nil),
        ("contentBase64", string(&base64(b"third"))),
    ])]);
    let settled_third = fixture.request(
        "execute_patch",
        value_map([
            ("sessionId", string(SESSION)),
            ("challengeId", string(&challenge(2))),
            ("operations", patch_operations),
        ]),
    );
    assert_eq!(
        settled_third.outcome,
        RpcOutcomeV1::Ok,
        "{:?}",
        settled_third.error
    );
    assert_eq!(response_string(&settled_third, "status"), "settled");

    assert_eq!(fs::read_to_string(&first).unwrap(), "first");
    assert_eq!(fs::read_to_string(&second).unwrap(), "second");
    assert_eq!(fs::read_to_string(&third).unwrap(), "third");
    assert_ne!(
        response_string(&settled_first, "receiptDigest"),
        response_string(&settled_second, "receiptDigest")
    );

    let rows = fixture.challenge_rows("batch_multi_settle");
    assert!(rows.iter().all(|(_, _, status)| status == "SETTLED"));

    // A consumed member's challenge cannot execute twice (one-use lease).
    let replay = write(&mut fixture, &challenge(0), "first");
    assert_eq!(replay.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        replay.error.as_ref().map(|error| error.code.as_str()),
        Some("effect_conflict")
    );
    assert_eq!(fs::read_to_string(&first).unwrap(), "first");
    fixture.cleanup();
}

#[test]
fn denied_or_unsafe_member_denies_the_whole_batch_with_zero_durable_rows() {
    let mut fixture = Fixture::new();
    let safe = fixture.workspace.join("safe.txt");
    let response = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_multi_denied",
            vec![
                write_call("call_safe", &safe, "safe"),
                // An absolute path outside the pinned workspace never resolves.
                write_call(
                    "call_outside",
                    Path::new("/etc/definitely-outside.txt"),
                    "x",
                ),
            ],
        ),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
    assert_eq!(response_string(&response, "status"), "denied");
    assert_eq!(
        response_string(&response, "reason"),
        "path_outside_or_unsafe"
    );
    assert!(!safe.exists());
    assert_eq!(fixture.challenge_rows("batch_multi_denied").len(), 0);

    // A duplicate call ID in an otherwise valid batch is refused before persistence.
    let duplicate = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_multi_duplicate",
            vec![
                write_call("call_same", &fixture.workspace.join("a.txt"), "a"),
                write_call("call_same", &fixture.workspace.join("b.txt"), "b"),
            ],
        ),
    );
    assert_eq!(duplicate.outcome, RpcOutcomeV1::Ok, "{:?}", duplicate.error);
    assert_eq!(response_string(&duplicate, "status"), "denied");
    assert_eq!(response_string(&duplicate, "reason"), "duplicate_call_id");
    assert_eq!(fixture.challenge_rows("batch_multi_duplicate").len(), 0);

    // The rejected batches leave the owner healthy: a follow-up valid batch still admits.
    let follow_up = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_multi_follow_up",
            vec![write_call("call_follow_up", &safe, "ok")],
        ),
    );
    assert_eq!(follow_up.outcome, RpcOutcomeV1::Ok, "{:?}", follow_up.error);
    assert_eq!(response_string(&follow_up, "status"), "needs_approval");
    assert_eq!(fixture.challenge_rows("batch_multi_follow_up").len(), 1);
    fixture.cleanup();
}

#[test]
fn batch_call_and_payload_bounds_deny_before_any_durable_state_exists() {
    let mut fixture = Fixture::new();
    let over_limit: Vec<Value> = (0..33)
        .map(|index| {
            write_call(
                &format!("call_limit_{index}"),
                &fixture.workspace.join(format!("limit-{index}.txt")),
                "x",
            )
        })
        .collect();
    let response = fixture.request(
        "prepare_tool_batch",
        prepare_body("batch_multi_limit", over_limit),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
    assert_eq!(response_string(&response, "status"), "denied");
    assert_eq!(response_string(&response, "reason"), "batch_call_limit");
    assert_eq!(fixture.challenge_rows("batch_multi_limit").len(), 0);

    // Three calls whose encoded arguments exceed the 512 KiB aggregate bound are refused
    // even though each stays under the 256 KiB per-call bound.
    let mut chunk = String::new();
    while chunk.len() < 200 * 1024 {
        chunk.push('x');
    }
    let payload: Vec<Value> = (0..3)
        .map(|index| {
            write_call(
                &format!("call_payload_{index}"),
                &fixture.workspace.join(format!("payload-{index}.txt")),
                &chunk,
            )
        })
        .collect();
    let response = fixture.request(
        "prepare_tool_batch",
        prepare_body("batch_multi_payload", payload),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
    assert_eq!(response_string(&response, "status"), "denied");
    assert_eq!(response_string(&response, "reason"), "argument_bytes");
    assert_eq!(fixture.challenge_rows("batch_multi_payload").len(), 0);
    for index in 0..3 {
        assert!(
            !fixture
                .workspace
                .join(format!("payload-{index}.txt"))
                .exists()
        );
    }
    fixture.cleanup();
}

#[test]
fn broker_process_capability_is_typed_unavailable_with_zero_effects() {
    let mut fixture = Fixture::new();
    let marker = fixture.workspace.join("broker-marker.txt");
    let response = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_multi_broker",
            vec![
                write_call("call_before_broker", &marker, "x"),
                broker_call("call_broker", &format!("brp_{}", "0".repeat(64))),
            ],
        ),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        response.error.as_ref().map(|error| error.code.as_str()),
        Some("effect_unavailable")
    );
    assert!(!marker.exists());
    assert_eq!(fixture.challenge_rows("batch_multi_broker").len(), 0);

    // The unavailable capability never leaks into a later supported batch.
    let supported = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_multi_after_broker",
            vec![write_call("call_write", &marker, "ok")],
        ),
    );
    assert_eq!(supported.outcome, RpcOutcomeV1::Ok, "{:?}", supported.error);
    assert_eq!(response_string(&supported, "status"), "needs_approval");
    fixture.cleanup();
}

#[test]
fn cancelled_batch_members_never_execute_and_settled_members_are_preserved() {
    let mut fixture = Fixture::new();
    let first = fixture.workspace.join("cancel-first.txt");
    let second = fixture.workspace.join("cancel-second.txt");
    let third = fixture.workspace.join("cancel-third.txt");
    let response = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_multi_cancel",
            vec![
                write_call("call_first", &first, "first"),
                write_call("call_second", &second, "second"),
                write_call("call_third", &third, "third"),
            ],
        ),
    );
    let calls = response_calls(&response).to_vec();
    let challenge = |index: usize| call_field(&calls[index], "challengeId").to_owned();

    // Approve all three, execute exactly one.
    for index in 0..3 {
        assert_eq!(
            approve(&mut fixture, &challenge(index)).outcome,
            RpcOutcomeV1::Ok
        );
    }
    assert_eq!(
        write(&mut fixture, &challenge(0), "first").outcome,
        RpcOutcomeV1::Ok
    );
    assert!(first.exists());

    // Cancel the batch: the two approved-but-unexecuted members are cancelled durably.
    let cancelled = fixture.request(
        "cancel_batch",
        value_map([
            ("sessionId", string(SESSION)),
            ("batchId", string("batch_multi_cancel")),
        ]),
    );
    assert_eq!(cancelled.outcome, RpcOutcomeV1::Ok, "{:?}", cancelled.error);
    assert_eq!(response_string(&cancelled, "status"), "cancelled");
    assert_eq!(response_unsigned(&cancelled, "cancelled"), 2);
    assert_eq!(response_unsigned(&cancelled, "prepared"), 0);
    assert!(!second.exists());
    assert!(!third.exists());

    // A settled member keeps its receipt and is not reported as cancelled.
    let rows = fixture.challenge_rows("batch_multi_cancel");
    let by_challenge: BTreeMap<&str, &str> = rows
        .iter()
        .map(|(challenge_id, _, status)| (challenge_id.as_str(), status.as_str()))
        .collect();
    assert_eq!(by_challenge.get(challenge(0).as_str()), Some(&"SETTLED"));
    assert_eq!(by_challenge.get(challenge(1).as_str()), Some(&"CANCELLED"));
    assert_eq!(by_challenge.get(challenge(2).as_str()), Some(&"CANCELLED"));

    // A cancelled challenge cannot be approved or executed afterwards.
    let late_approval = approve(&mut fixture, &challenge(1));
    assert_eq!(late_approval.outcome, RpcOutcomeV1::Error);
    let late_write = write(&mut fixture, &challenge(1), "second");
    assert_eq!(late_write.outcome, RpcOutcomeV1::Error);
    assert!(!second.exists());

    // Cancellation is idempotent and never resurrects anything.
    let again = fixture.request(
        "cancel_batch",
        value_map([
            ("sessionId", string(SESSION)),
            ("batchId", string("batch_multi_cancel")),
        ]),
    );
    assert_eq!(again.outcome, RpcOutcomeV1::Ok, "{:?}", again.error);
    assert_eq!(response_unsigned(&again, "cancelled"), 0);
    assert!(!second.exists());
    assert!(!third.exists());
    fixture.cleanup();
}

#[test]
fn restart_keeps_every_prepared_member_pending_and_never_settles_an_unexecuted_batch() {
    let mut fixture = Fixture::new();
    let first = fixture.workspace.join("restart-first.txt");
    let second = fixture.workspace.join("restart-second.txt");
    let response = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_multi_restart",
            vec![
                write_call("call_first", &first, "first"),
                write_call("call_second", &second, "second"),
            ],
        ),
    );
    let calls = response_calls(&response).to_vec();
    let challenge = |index: usize| call_field(&calls[index], "challengeId").to_owned();

    // Approve one member and leave it prepared-but-not-executed, then restart the owner.
    assert_eq!(
        approve(&mut fixture, &challenge(0)).outcome,
        RpcOutcomeV1::Ok
    );
    fixture.reconnect();

    // Nothing was executed by reconciliation: neither file exists and no member is
    // reported settled, while both remain addressable by their durable challenge.
    assert!(!first.exists());
    assert!(!second.exists());
    let rows = fixture.challenge_rows("batch_multi_restart");
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|(_, _, status)| status != "SETTLED"));

    // The batch is still usable after restart: the member approved before the restart
    // stays approved (no effect ran), and the second member can still be approved.
    let still_approved = approve(&mut fixture, &challenge(0));
    assert_eq!(still_approved.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        still_approved
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("effect_conflict")
    );
    let approved = approve(&mut fixture, &challenge(1));
    assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);
    assert_eq!(
        write(&mut fixture, &challenge(0), "first").outcome,
        RpcOutcomeV1::Ok
    );
    assert_eq!(
        write(&mut fixture, &challenge(1), "second").outcome,
        RpcOutcomeV1::Ok
    );
    assert_eq!(fs::read_to_string(&first).unwrap(), "first");
    assert_eq!(fs::read_to_string(&second).unwrap(), "second");
    fixture.cleanup();
}

#[test]
fn cancellation_preserves_prepared_member_for_unknown_reconciliation_without_replay() {
    let mut fixture = Fixture::new();
    let prepared_path = fixture.workspace.join("prepared-unknown.txt");
    let approved_path = fixture.workspace.join("approved-cancelled.txt");
    let response = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_multi_unknown",
            vec![
                write_call("call_prepared", &prepared_path, "uncertain"),
                write_call("call_approved", &approved_path, "cancel me"),
            ],
        ),
    );
    assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
    let calls = response_calls(&response).to_vec();
    let prepared_challenge = call_field(&calls[0], "challengeId").to_owned();
    let prepared_effect = call_field(&calls[0], "effectId").to_owned();
    let approved_challenge = call_field(&calls[1], "challengeId").to_owned();

    assert_eq!(
        approve(&mut fixture, &prepared_challenge).outcome,
        RpcOutcomeV1::Ok
    );
    assert_eq!(
        approve(&mut fixture, &approved_challenge).outcome,
        RpcOutcomeV1::Ok
    );

    // Reproduce the crash boundary after the PREPARED intent is durable but before
    // ExecutionHost reports an observable result. Cancellation may stop the other
    // APPROVED member, but it must not invent a rollback or erase this ambiguity.
    let effect_db_path = fixture.state.join("effects.sqlite");
    let effect_db = Connection::open(&effect_db_path).unwrap();
    let content_digest: String = effect_db
        .query_row(
            "SELECT content_digest FROM effect_challenges WHERE challenge_id=?1",
            [&prepared_challenge],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        effect_db
            .execute(
                "UPDATE effect_challenges SET status='PREPARED', after_digest=?2, receipt_digest=NULL WHERE challenge_id=?1 AND status='APPROVED'",
                rusqlite::params![prepared_challenge, content_digest],
            )
            .unwrap(),
        1,
    );
    drop(effect_db);

    let cancelled = fixture.request(
        "cancel_batch",
        value_map([
            ("sessionId", string(SESSION)),
            ("batchId", string("batch_multi_unknown")),
        ]),
    );
    assert_eq!(cancelled.outcome, RpcOutcomeV1::Ok, "{:?}", cancelled.error);
    assert_eq!(response_string(&cancelled, "status"), "cancelled");
    assert_eq!(response_unsigned(&cancelled, "cancelled"), 1);
    assert_eq!(response_unsigned(&cancelled, "prepared"), 1);
    assert!(!prepared_path.exists());
    assert!(!approved_path.exists());

    fixture.reconnect();
    let reconciled = fixture
        .host
        .reconcile_effect(SESSION, PRINCIPAL, &prepared_effect)
        .expect_err("uncertain prepared work must reconcile to UNKNOWN");
    assert_eq!(reconciled.code, "effect_outcome_unknown");

    let rows = fixture.challenge_rows("batch_multi_unknown");
    let statuses: BTreeMap<&str, &str> = rows
        .iter()
        .map(|(challenge_id, _, status)| (challenge_id.as_str(), status.as_str()))
        .collect();
    assert_eq!(statuses.get(prepared_challenge.as_str()), Some(&"UNKNOWN"));
    assert_eq!(
        statuses.get(approved_challenge.as_str()),
        Some(&"CANCELLED")
    );

    // UNKNOWN is not a retry signal: the old durable challenge remains unusable and
    // neither target is silently replayed after cancellation or owner restart.
    let replay = write(&mut fixture, &prepared_challenge, "uncertain");
    assert_eq!(replay.outcome, RpcOutcomeV1::Error);
    assert!(!prepared_path.exists());
    assert!(!approved_path.exists());
    fixture.cleanup();
}

/// The write executor is a separate boundary from the host relay: even a durable row that
/// has been adversarially retargeted at a workspace file, with its argument digest
/// recomputed to pass every other check, must not execute through `execute_write` unless
/// its canonical capability is exactly `files.write`.
#[test]
fn tampered_non_write_challenge_cannot_execute_through_the_write_path() {
    let mut fixture = Fixture::new();
    let victim = fixture.workspace.join("tampered-victim.txt");
    let content = "tampered";
    let profile = format!("shp_{}", "0".repeat(64));

    // Prepare and approve a genuine `terminal.run` challenge.
    let prepared = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_tampered",
            vec![terminal_call("call_run", &profile, &fixture.workspace)],
        ),
    );
    assert_eq!(prepared.outcome, RpcOutcomeV1::Ok, "{:?}", prepared.error);
    let calls = response_calls(&prepared).to_vec();
    let challenge_id = call_field(&calls[0], "challengeId").to_owned();
    let batch_id = "batch_tampered";
    assert_eq!(call_field(&calls[0], "capabilityId"), "terminal.run");
    assert_eq!(
        approve(&mut fixture, &challenge_id).outcome,
        RpcOutcomeV1::Ok
    );

    let call_id = call_field(&calls[0], "callId").to_owned();
    let content_digest = format!("blake3:{}", blake3::hash(content.as_bytes()).to_hex());
    let requested_path = victim.to_str().unwrap().to_owned();
    let relative_path = "tampered-victim.txt".to_owned();

    // Compute the exact intent digest `execute_write` will recompute for these tampered
    // fields, so the digest check cannot mask the capability binding under test.
    let metadata = fs::metadata(&fixture.workspace).unwrap();
    let workspace_binding = horizoncode_kernel::guard::workspace_binding(
        &fixture.workspace,
        std::os::unix::fs::MetadataExt::dev(&metadata),
        std::os::unix::fs::MetadataExt::ino(&metadata),
    );
    let argument_digest = horizoncode_kernel::guard::argument_digest(
        SESSION,
        batch_id,
        &call_id,
        "terminal.run",
        &requested_path,
        &content_digest,
    );
    let authorization = horizoncode_kernel::guard::AuthorizationRequestV1 {
        request_id: batch_id,
        principal: PRINCIPAL,
        origin: horizoncode_kernel::guard::EffectOriginV1 {
            kind: horizoncode_kernel::guard::EffectOriginKindV1::SessionBatch,
            session_id: SESSION,
            batch_id,
            call_id: &call_id,
        },
        action_id: "terminal.run",
        argument_digest: &argument_digest,
        turn_context_digest: TURN_DIGEST,
        resource_resolution: horizoncode_kernel::guard::ResourceResolutionV1 {
            workspace_root: &fixture.workspace,
            workspace_binding: &workspace_binding,
            target: &victim,
            resource: &relative_path,
        },
        executable: None,
        policy_snapshot_ids: &[horizoncode_kernel::guard::WORKSPACE_WRITE_POLICY_ID],
        requested_guarantees: &[
            "beneath_workspace_root",
            "no_symlink",
            "no_hardlink",
            "one_use",
        ],
    };
    let decision = horizoncode_kernel::guard::authorize(&authorization, &challenge_id);
    assert_eq!(
        decision.decision,
        horizoncode_kernel::guard::DecisionKind::Ask,
        "tampered fields must still satisfy the guard decision shape"
    );
    let intent = horizoncode_kernel::guard::intent_digest(&authorization, &decision);

    {
        let connection = Connection::open(fixture.state.join("effects.sqlite")).unwrap();
        let changed = connection
            .execute(
                "UPDATE effect_challenges
                 SET relative_path=?1, requested_path=?2, target=?3, resource=?4,
                     content_digest=?5, argument_digest=?6
                 WHERE challenge_id=?7 AND capability_id='terminal.run'",
                rusqlite::params![
                    relative_path,
                    requested_path,
                    requested_path,
                    relative_path,
                    content_digest,
                    intent,
                    challenge_id
                ],
            )
            .unwrap();
        assert_eq!(changed, 1);
    }

    // The write executor refuses a non-`files.write` challenge before touching the disk.
    let refused = write(&mut fixture, &challenge_id, content);
    assert_eq!(refused.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        refused.error.as_ref().map(|error| error.code.as_str()),
        Some("effect_denied")
    );
    assert!(!victim.exists());

    // The refusal observed the row without consuming or corrupting it.
    let rows = fixture.challenge_rows(batch_id);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].2, "APPROVED");

    // A genuine files.write challenge still executes in the same owner.
    let genuine = fixture.workspace.join("genuine.txt");
    let prepared = fixture.request(
        "prepare_tool_batch",
        prepare_body(
            "batch_genuine",
            vec![write_call("call_genuine", &genuine, "ok")],
        ),
    );
    let calls = response_calls(&prepared).to_vec();
    let genuine_challenge = call_field(&calls[0], "challengeId").to_owned();
    assert_eq!(
        approve(&mut fixture, &genuine_challenge).outcome,
        RpcOutcomeV1::Ok
    );
    assert_eq!(
        write(&mut fixture, &genuine_challenge, "ok").outcome,
        RpcOutcomeV1::Ok
    );
    assert_eq!(fs::read_to_string(&genuine).unwrap(), "ok");
    fixture.cleanup();
}
