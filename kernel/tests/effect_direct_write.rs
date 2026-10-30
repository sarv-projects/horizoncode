#![cfg(target_os = "linux")]
//! Direct-session guarded write acceptance for the root (non-Attempt) lane.
//!
//! These cases bind the exact production sequence used by the model-facing
//! `write` tool: one `effects.v2/prepare_tool_batch` admission for
//! `files.write`, then one `effects.v2/execute_write` settlement. They prove,
//! against the real in-process `HostKernel` and durable `EffectHost` journal:
//!
//! - the default direct-session mode (workspace-write + on-request) admits the
//!   call as `prepared` with a one-use lease, executes it through the Guarded
//!   write path, returns the canonical `receiptDigest`/`effectID`, and persists
//!   `SETTLED` plus that receipt in `effect_challenges`;
//! - the same lease can never settle the effect twice;
//! - a persisted read-only + never direct-session mode fails closed with the
//!   typed `permission_mode_boundary` denial, writes no file and admits no
//!   durable effect challenge.
//!
//! Source owners: `kernel/src/host_kernel.rs` (`prepare_tool_batch`,
//! `execute_write`), `kernel/src/effect_host.rs` (`classify_direct_mode_batch`,
//! `execute_write`), arch_V1/14 §14.2/§14.3 and DEC-V1-28.

use horizoncode_kernel::host_kernel::{EFFECTS_SERVICE_ID, HostKernel};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{FrameFence, RpcOutcomeV1, RpcRequestV1};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const PRINCIPAL: &str = "server_auth:effect-direct-write-owner";
const INCARNATION: &str = "inc_effect_direct_write";
const SESSION: &str = "ses_effect_direct_write";
const TURN_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

struct Fixture {
    base: PathBuf,
    state: PathBuf,
    workspace: PathBuf,
    host: HostKernel,
    location_id: String,
    fence: FrameFence,
    next_request: u64,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("edw-{name}-{}-{nonce}", std::process::id()));
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
                    // Direct-session admission requires a Location bound to a
                    // registered workspace, not just a canonical root.
                    ("workspaceID", string("wrk_effect_direct_write")),
                ]),
                1,
            ),
            PRINCIPAL,
            &fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
        let location_id = value_string(response.body.as_ref().unwrap(), "locationID");
        Self {
            base,
            state,
            workspace,
            host,
            location_id,
            fence,
            next_request: 2,
        }
    }

    fn cleanup(self) {
        drop(self.host);
        let _ = fs::remove_dir_all(&self.base);
    }

    fn request(
        &mut self,
        operation: &str,
        body: Value,
    ) -> horizoncode_kernel::protocol::RpcResponseV1 {
        let id = self.next_request;
        self.next_request += 1;
        self.host
            .handle_request(&request(operation, body, id), PRINCIPAL, &self.fence)
    }

    fn effect_database(&self) -> Option<PathBuf> {
        let path = self
            .state
            .join("effect-locations")
            .join(&self.location_id)
            .join("effects.sqlite");
        path.is_file().then_some(path)
    }

    /// Durable `effect_challenges` count for one batch. A Location that never
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

    fn prepare_write(&mut self, batch_id: &str, path: &str, content: &str) -> Value {
        let response = self.request(
            "prepare_tool_batch",
            value_map([
                ("sessionID", string(SESSION)),
                ("locationID", string(&self.location_id)),
                ("batchID", string(batch_id)),
                ("turnContextDigest", string(TURN_DIGEST)),
                (
                    "calls",
                    Value::Array(vec![value_map([
                        ("callID", string("call_direct_write")),
                        ("capabilityID", string("files.write")),
                        (
                            "arguments",
                            value_map([("path", string(path)), ("content", string(content))]),
                        ),
                    ])]),
                ),
            ]),
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
        response.body.unwrap()
    }
}

fn request(operation: &str, body: Value, id: u64) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch: 11,
        process_incarnation: INCARNATION.to_owned(),
        request_id: format!("req_effect_direct_write_{id}"),
        service_id: EFFECTS_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 30_000,
        trace_id: format!("trace_effect_direct_write_{id}"),
        body,
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

fn value_string(value: &Value, key: &str) -> String {
    let Value::Map(map) = value else {
        panic!("expected map")
    };
    let Some(Value::String(value)) = map.get(key) else {
        panic!("missing string field {key}")
    };
    value.clone()
}

#[test]
fn direct_session_default_mode_write_settles_with_durable_receipt_and_one_use_lease() {
    let mut fixture = Fixture::new("settle");
    let content = "guarded direct-session write\n";
    let prepared = fixture.prepare_write("batch_direct_write", "probe.txt", content);
    // Default mode (workspace-write + on-request) admits an in-workspace write
    // quietly: no approval surface is required, but the lease still authorizes
    // execution only and preparation itself must write nothing.
    assert_eq!(value_string(&prepared, "status"), "prepared");
    let effect_id = value_string(&prepared, "effectID");
    let lease = value_string(&prepared, "capabilityLeaseDigest");
    assert!(lease.starts_with("blake3:"));
    assert!(!fixture.workspace.join("probe.txt").exists());
    assert_eq!(fixture.durable_challenge_count("batch_direct_write"), 1);

    let location_id = fixture.location_id.clone();
    let settle_body = |effect_id: &str, lease: &str, content: &str| {
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location_id)),
            ("effectID", string(effect_id)),
            ("capabilityLeaseDigest", string(lease)),
            ("content", string(content)),
        ])
    };
    let settled = fixture.request("execute_write", settle_body(&effect_id, &lease, content));
    assert_eq!(settled.outcome, RpcOutcomeV1::Ok, "{:?}", settled.error);
    let body = settled.body.unwrap();
    assert_eq!(value_string(&body, "status"), "settled");
    assert_eq!(value_string(&body, "effectID"), effect_id);
    let receipt_digest = value_string(&body, "receiptDigest");
    assert!(receipt_digest.starts_with("blake3:"));
    let expected_target = fs::canonicalize(&fixture.workspace).unwrap().join("probe.txt");
    assert_eq!(
        value_string(&body, "target"),
        expected_target.to_str().unwrap()
    );
    assert_eq!(value_string(&body, "resource"), "probe.txt");
    assert_eq!(body.get("existed"), Some(&Value::Bool(false)));
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("probe.txt")).unwrap(),
        content
    );

    // Durable receipt: the journal row is SETTLED and carries exactly the
    // receipt digest returned to Core. The raw content is never persisted.
    let database = fixture.effect_database().expect("durable effect journal");
    let durable: (String, String) =
        Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap()
            .query_row(
                "SELECT status, receipt_digest FROM effect_challenges WHERE effect_id=?1",
                [&effect_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
    assert_eq!(durable.0, "SETTLED");
    assert_eq!(durable.1, receipt_digest);
    assert!(
        !fs::read(&database)
            .unwrap()
            .windows(content.len())
            .any(|window| window == content.as_bytes())
    );

    // The one-use lease is consumed: replaying it must fail closed and must not
    // rewrite the target.
    let replay = fixture.request("execute_write", settle_body(&effect_id, &lease, content));
    assert_ne!(replay.outcome, RpcOutcomeV1::Ok);
    assert!(
        replay.error.is_some(),
        "lease replay must return a typed error"
    );
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("probe.txt")).unwrap(),
        content
    );
    fixture.cleanup();
}

#[test]
fn direct_session_read_only_mode_denies_write_before_admission() {
    let mut fixture = Fixture::new("deny");
    let persisted = fixture.request(
        "set_direct_session_permission_mode",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&fixture.location_id)),
            ("sandboxMode", string("read-only")),
            ("approvalPolicy", string("never")),
            ("expectedRevision", string("1")),
        ]),
    );
    assert_eq!(persisted.outcome, RpcOutcomeV1::Ok, "{:?}", persisted.error);
    let mode = persisted.body.as_ref().unwrap();
    assert_eq!(value_string(mode, "sandboxMode"), "read-only");
    assert_eq!(value_string(mode, "approvalPolicy"), "never");
    assert_eq!(value_string(mode, "revision"), "2");

    let denied = fixture.prepare_write("batch_direct_write_denied", "denied.txt", "must not exist");
    // Typed Guard denial, not a protocol error and not an approval prompt: a
    // read-only + never Session can never admit a files.write.
    assert_eq!(value_string(&denied, "status"), "denied");
    assert_eq!(value_string(&denied, "reason"), "permission_mode_boundary");
    assert!(!fixture.workspace.join("denied.txt").exists());
    assert_eq!(fixture.durable_challenge_count("batch_direct_write_denied"), 0);

    // Nothing durable exists, so no fabricated lease can reach the write path.
    let fabricated = fixture.request(
        "execute_write",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&fixture.location_id)),
            ("effectID", string("effect_denied_direct")),
            (
                "capabilityLeaseDigest",
                string(format!("blake3:{}", "0".repeat(64)).as_str()),
            ),
            ("content", string("must not exist")),
        ]),
    );
    assert_ne!(fabricated.outcome, RpcOutcomeV1::Ok);
    assert!(!fixture.workspace.join("denied.txt").exists());
    fixture.cleanup();
}

/// Defect A1: the first `files.write` into a fresh directory tree was denied
/// with `path_unavailable_or_unsafe` because planning could not open a parent
/// that did not exist yet. A contained write whose parent chain is missing must
/// be admitted and must create the chain inside the effect, component by
/// component, without ever leaving the workspace root.
#[test]
fn direct_session_write_creates_missing_parent_directories() {
    let mut fixture = Fixture::new("nested");
    let content = "nested guarded write\n";
    let prepared = fixture.prepare_write("batch_nested_write", "a/b/c/file.txt", content);
    assert_eq!(value_string(&prepared, "status"), "prepared");
    let effect_id = value_string(&prepared, "effectID");
    let lease = value_string(&prepared, "capabilityLeaseDigest");
    // Preparation is still non-mutating: no directory and no file may exist yet.
    assert!(!fixture.workspace.join("a").exists());
    assert_eq!(fixture.durable_challenge_count("batch_nested_write"), 1);

    let location_id = fixture.location_id.clone();
    let settled = fixture.request(
        "execute_write",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location_id)),
            ("effectID", string(&effect_id)),
            ("capabilityLeaseDigest", string(&lease)),
            ("content", string(content)),
        ]),
    );
    assert_eq!(settled.outcome, RpcOutcomeV1::Ok, "{:?}", settled.error);
    let body = settled.body.unwrap();
    assert_eq!(value_string(&body, "status"), "settled");
    assert_eq!(value_string(&body, "effectID"), effect_id);
    // Receipt shape is unchanged: the target is still the root-joined normalized
    // path the TS side computes from the resolved parent.
    let expected_target = fs::canonicalize(&fixture.workspace)
        .unwrap()
        .join("a/b/c/file.txt");
    assert_eq!(
        value_string(&body, "target"),
        expected_target.to_str().unwrap()
    );
    assert_eq!(value_string(&body, "resource"), "a/b/c/file.txt");
    assert_eq!(body.get("existed"), Some(&Value::Bool(false)));
    assert!(value_string(&body, "receiptDigest").starts_with("blake3:"));
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("a/b/c/file.txt")).unwrap(),
        content
    );
    for directory in ["a", "a/b", "a/b/c"] {
        let metadata = fs::metadata(fixture.workspace.join(directory)).unwrap();
        assert!(metadata.is_dir(), "{directory} must be a directory");
        assert_eq!(
            metadata.permissions().mode() & 0o777,
            0o755,
            "{directory} must carry the workspace directory mode"
        );
    }
    fixture.cleanup();
}

/// A path that climbs out of the workspace stays a planning denial; nothing is
/// created anywhere on disk and no durable challenge is admitted.
#[test]
fn direct_session_write_outside_workspace_is_denied() {
    let mut fixture = Fixture::new("escape");
    let prepared = fixture.prepare_write("batch_escape_write", "../../escape.txt", "nope\n");
    assert_eq!(value_string(&prepared, "status"), "denied");
    assert_eq!(value_string(&prepared, "reason"), "path_outside_or_unsafe");
    assert_eq!(fixture.durable_challenge_count("batch_escape_write"), 0);
    assert!(!fixture.workspace.join("escape.txt").exists());
    assert!(!fixture.base.join("escape.txt").exists());
    fixture.cleanup();
}

/// Regression: an existing target is still truncated and overwritten in place,
/// and the receipt still reports `existed: true`.
#[test]
fn direct_session_write_overwrites_an_existing_target() {
    let mut fixture = Fixture::new("overwrite");
    let directory = fixture.workspace.join("src");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("main.rs"), "old content\n").unwrap();

    let content = "new content\n";
    let prepared = fixture.prepare_write("batch_overwrite", "src/main.rs", content);
    assert_eq!(value_string(&prepared, "status"), "prepared");
    let effect_id = value_string(&prepared, "effectID");
    let lease = value_string(&prepared, "capabilityLeaseDigest");

    let location_id = fixture.location_id.clone();
    let settled = fixture.request(
        "execute_write",
        value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&location_id)),
            ("effectID", string(&effect_id)),
            ("capabilityLeaseDigest", string(&lease)),
            ("content", string(content)),
        ]),
    );
    assert_eq!(settled.outcome, RpcOutcomeV1::Ok, "{:?}", settled.error);
    let body = settled.body.unwrap();
    assert_eq!(value_string(&body, "status"), "settled");
    assert_eq!(value_string(&body, "resource"), "src/main.rs");
    assert_eq!(body.get("existed"), Some(&Value::Bool(true)));
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("src/main.rs")).unwrap(),
        content
    );
    // No spurious directory was created and the parent survived the overwrite.
    assert!(fixture.workspace.join("src").is_dir());
    fixture.cleanup();
}
