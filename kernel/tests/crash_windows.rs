#![cfg(target_os = "linux")]

//! Durable crash windows around the guarded filesystem effect lifecycle.
//!
//! `EffectHost::execute_write` crosses two durable boundaries that a process
//! death can land between, and neither was covered by a regression:
//!
//! 1. **PREPARE -> settlement.** `persist_prepared` commits `status='PREPARED'`
//!    plus the intended `after_digest` and the one-use `lease_id` *before*
//!    `ExecutionHost` writes the target. A crash here leaves the effect intent
//!    durable and the target untouched.
//! 2. **Settlement -> receipt.** The target bytes are durable and observed to
//!    match `after_digest`, but the settle `UPDATE` that mints `receipt_digest`
//!    never committed.
//!
//! Both tests drive the real recovery path - `HostKernel::open` recovers every
//! registered Location through `EffectHost::open` (not `open_live`), which runs
//! `reconcile_prepared` before READY - and then query the real `reconcile_effect`
//! RPC. Only the durable pre/post-crash row state is reconstructed with SQL, at
//! the exact columns the production writers touch, because a test cannot
//! SIGKILL itself between two statements inside one function; every assertion
//! after reconstruction is production behaviour.

use horizoncode_kernel::host_kernel::{EFFECTS_SERVICE_ID, HostKernel};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{FrameFence, RpcOutcomeV1, RpcRequestV1};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

// Root direct-session admission resolves the typed ServerAuth subject from the
// host binding (14/DEC-V1-28); the same subject that registered the Location
// fronts every request so the owner binding matches.
const PRINCIPAL: &str = "server_auth:crash-window-location-owner";
const INCARNATION: &str = "inc_crash_window";
const SESSION: &str = "ses_crash_window";

/// The durable `effect_challenges` facts a crash window turns on.
struct ChallengeRow {
    status: String,
    receipt_digest: Option<String>,
    after_digest: Option<String>,
    lease_id: Option<String>,
    target: String,
    resource: String,
    existed: bool,
}

struct Fixture {
    base: PathBuf,
    state: PathBuf,
    workspace: PathBuf,
    host: HostKernel,
    location_id: String,
    epoch: u64,
    fence: FrameFence,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("hz-crash-window-{}-{nonce}", std::process::id()));
        let state = base.join("state");
        let workspace = base.join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = fs::canonicalize(workspace).unwrap();
        let mut host = HostKernel::open(&state).unwrap();
        host.set_effects_enabled(true);
        let epoch = 11;
        let fence = FrameFence::new(epoch, INCARNATION).unwrap();
        let response = host.handle_request(
            &request(
                "register_location",
                value_map([
                    ("canonicalRoot", string(workspace.to_str().unwrap())),
                    ("workspaceID", string("wrk_crash_window")),
                ]),
                1,
                epoch,
            ),
            PRINCIPAL,
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
            epoch,
            fence,
        }
    }

    /// The crash: the process dies and the same durable state is reopened by a
    /// fresh owner epoch. `HostKernel::open` runs `EffectHost::open` recovery
    /// for every registered Location before READY.
    fn restart(&mut self) {
        let previous = std::mem::replace(&mut self.host, HostKernel::open(&self.state).unwrap());
        drop(previous);
        self.host.set_effects_enabled(true);
        self.epoch += 1;
        self.fence = FrameFence::new(self.epoch, INCARNATION).unwrap();
    }

    fn cleanup(self) {
        drop(self.host);
        fs::remove_dir_all(self.base).unwrap();
    }

    fn effect_db(&self) -> PathBuf {
        self.state
            .join("effect-locations")
            .join(&self.location_id)
            .join("effects.sqlite")
    }

    fn connection(&self) -> Connection {
        Connection::open(self.effect_db()).unwrap()
    }

    fn row(&self, effect_id: &str) -> ChallengeRow {
        self.connection()
            .query_row(
                "SELECT status, receipt_digest, after_digest, lease_id, target, resource, existed
                 FROM effect_challenges WHERE effect_id=?1",
                [effect_id],
                |row| {
                    Ok(ChallengeRow {
                        status: row.get(0)?,
                        receipt_digest: row.get(1)?,
                        after_digest: row.get(2)?,
                        lease_id: row.get(3)?,
                        target: row.get(4)?,
                        resource: row.get(5)?,
                        existed: row.get::<_, i64>(6)? != 0,
                    })
                },
            )
            .unwrap()
    }

    fn challenge_count(&self, effect_id: &str) -> i64 {
        self.connection()
            .query_row(
                "SELECT COUNT(*) FROM effect_challenges WHERE effect_id=?1",
                [effect_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// Prepare one `files.write` and return `(effect_id, capability_lease)`.
    /// Approval is resolved for the issued challenge exactly as Core would.
    fn prepare_write(&mut self, path: &str, content: &str) -> (String, String) {
        let body = value_map([
            ("sessionID", string(SESSION)),
            ("locationID", string(&self.location_id)),
            ("batchID", string("batch_crash_window")),
            (
                "turnContextDigest",
                string(&format!("sha256:{}", "0".repeat(64))),
            ),
            (
                "calls",
                Value::Array(vec![value_map([
                    ("callID", string("call_write")),
                    ("capabilityID", string("files.write")),
                    (
                        "arguments",
                        value_map([("path", string(path)), ("content", string(content))]),
                    ),
                ])]),
            ),
        ]);
        let response = self.host.handle_request(
            &request("prepare_tool_batch", body, 2, self.epoch),
            PRINCIPAL,
            &self.fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
        let body = response.body.unwrap();
        let effect_id = value_string(&body, "effectID").to_owned();
        let lease = match value_string(&body, "status") {
            "prepared" => value_string(&body, "capabilityLeaseDigest").to_owned(),
            "needs_approval" => {
                let challenge_id = value_string(&body, "challengeID").to_owned();
                let approved = self.host.handle_request(
                    &request(
                        "resolve_approval",
                        value_map([
                            ("challengeID", string(&challenge_id)),
                            ("decision", string("allow_once")),
                        ]),
                        3,
                        self.epoch,
                    ),
                    PRINCIPAL,
                    &self.fence,
                );
                assert_eq!(approved.outcome, RpcOutcomeV1::Ok, "{:?}", approved.error);
                let approved = approved.body.unwrap();
                assert_eq!(value_string(&approved, "status"), "approved");
                value_string(&approved, "capabilityLeaseDigest").to_owned()
            }
            status => panic!("unexpected prepared effect status: {status}"),
        };
        (effect_id, lease)
    }

    fn execute_write(&mut self, effect_id: &str, lease: &str, content: &str) -> Value {
        let response = self.host.handle_request(
            &request(
                "execute_write",
                value_map([
                    ("sessionID", string(SESSION)),
                    ("locationID", string(&self.location_id)),
                    ("effectID", string(effect_id)),
                    ("capabilityLeaseDigest", string(lease)),
                    ("content", string(content)),
                ]),
                4,
                self.epoch,
            ),
            PRINCIPAL,
            &self.fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
        response.body.unwrap()
    }

    /// Query the real reconciliation RPC: the only production read path that
    /// classifies an effect whose execute response was lost.
    fn reconcile(&mut self, effect_id: &str, request_id: u64) -> RpcOutcomeV1 {
        self.host
            .handle_request(
                &request(
                    "reconcile_effect",
                    value_map([
                        ("effectID", string(effect_id)),
                        ("locationID", string(&self.location_id)),
                        ("sessionID", string(SESSION)),
                    ]),
                    request_id,
                    self.epoch,
                ),
                PRINCIPAL,
                &self.fence,
            )
            .outcome
    }

    fn reconcile_error_code(&mut self, effect_id: &str, request_id: u64) -> String {
        let response = self.host.handle_request(
            &request(
                "reconcile_effect",
                value_map([
                    ("effectID", string(effect_id)),
                    ("locationID", string(&self.location_id)),
                    ("sessionID", string(SESSION)),
                ]),
                request_id,
                self.epoch,
            ),
            PRINCIPAL,
            &self.fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Error);
        response.error.unwrap().code
    }

    fn reconcile_receipt(&mut self, effect_id: &str, request_id: u64) -> String {
        let response = self.host.handle_request(
            &request(
                "reconcile_effect",
                value_map([
                    ("effectID", string(effect_id)),
                    ("locationID", string(&self.location_id)),
                    ("sessionID", string(SESSION)),
                ]),
                request_id,
                self.epoch,
            ),
            PRINCIPAL,
            &self.fence,
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok, "{:?}", response.error);
        value_string(response.body.as_ref().unwrap(), "receiptDigest").to_owned()
    }

    /// Reconstruct the PREPARE -> settlement crash exactly as `persist_prepared`
    /// leaves it: `status='PREPARED'`, the intended `after_digest`, and the
    /// one-use execution lease all durable, with nothing written to the target.
    fn reconstruct_prepared_before_execute(
        &self,
        effect_id: &str,
        intended_digest: &str,
        lease_id: &str,
    ) {
        let row = self.row(effect_id);
        assert_eq!(
            row.status, "APPROVED",
            "the crash boundary follows the approval lease, not a settled write"
        );
        assert!(row.receipt_digest.is_none());
        let changed = self
            .connection()
            .execute(
                "UPDATE effect_challenges SET status='PREPARED', after_digest=?1, lease_id=?2
                 WHERE effect_id=?3 AND status='APPROVED'",
                rusqlite::params![intended_digest, lease_id, effect_id],
            )
            .unwrap();
        assert_eq!(changed, 1);
    }

    /// Reconstruct the settlement -> receipt crash: the target bytes, the
    /// `after_digest` and the execution `lease_id` are durable; the settle
    /// UPDATE that mints `receipt_digest` is not.
    fn reconstruct_settled_without_receipt(&self, effect_id: &str) {
        let row = self.row(effect_id);
        assert_eq!(row.status, "SETTLED");
        assert!(row.receipt_digest.is_some());
        assert!(row.after_digest.is_some());
        assert!(row.lease_id.is_some());
        let changed = self
            .connection()
            .execute(
                "UPDATE effect_challenges SET status='PREPARED', receipt_digest=NULL
                 WHERE effect_id=?1 AND status='SETTLED'",
                [effect_id],
            )
            .unwrap();
        assert_eq!(changed, 1);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn request(operation: &str, body: Value, id: u64, epoch: u64) -> RpcRequestV1 {
    RpcRequestV1 {
        owner_epoch: epoch,
        process_incarnation: INCARNATION.to_owned(),
        request_id: format!("req_crash_{id}"),
        service_id: EFFECTS_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 30_000,
        trace_id: format!("trace_crash_{id}"),
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

fn value_string<'a>(value: &'a Value, key: &str) -> &'a str {
    let Value::Map(map) = value else {
        panic!("expected map")
    };
    let Some(Value::String(value)) = map.get(key) else {
        panic!("missing string field {key}")
    };
    value
}

fn blake3_digest(bytes: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(bytes).to_hex())
}

/// Exact replica of the kernel's target receipt preimage. Recovery must derive
/// this value from durable facts alone; the test recomputes it independently so
/// a fabricated or re-randomized digest cannot pass.
fn target_receipt(
    effect_id: &str,
    target: &str,
    resource: &str,
    existed: bool,
    after_digest: &str,
    lease_id: &str,
) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in [effect_id, target, resource, after_digest, lease_id] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(&[u8::from(existed)]);
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn expected_receipt(effect_id: &str, row: &ChallengeRow) -> String {
    target_receipt(
        effect_id,
        &row.target,
        &row.resource,
        row.existed,
        row.after_digest
            .as_deref()
            .expect("crash window always has a durable after_digest"),
        row.lease_id
            .as_deref()
            .expect("crash window always has a durable execution lease"),
    )
}

/// Window 1 - process death after the PREPARED row is durable and before the
/// effect executes. The recovered effect must be UNKNOWN, must carry no
/// receipt, and must settle only once exact target evidence exists.
#[test]
fn prepared_effect_crash_before_execution_reopens_unknown_and_needs_target_evidence() {
    let mut fixture = Fixture::new();
    let content = "crash-before-execution";
    let (effect_id, _lease) = fixture.prepare_write("prepare-crash.txt", content);
    let intended_digest = blake3_digest(content.as_bytes());
    fixture.reconstruct_prepared_before_execute(&effect_id, &intended_digest, "lease-crash-1");
    assert!(
        !fixture.workspace.join("prepare-crash.txt").exists(),
        "the crash window is exactly: durable intent, no applied effect"
    );

    fixture.restart();

    // The reopened effect is UNKNOWN, never Succeeded, and replay does not
    // invent a receipt for an effect whose target was never written.
    let row = fixture.row(&effect_id);
    assert_eq!(row.status, "UNKNOWN", "recovered effect must be UNKNOWN");
    assert_eq!(
        row.receipt_digest, None,
        "a receipt may never be minted without observed target evidence"
    );
    assert!(!fixture.workspace.join("prepare-crash.txt").exists());
    assert_eq!(
        fixture.reconcile_error_code(&effect_id, 5),
        "effect_outcome_unknown"
    );

    // A second restart is stable: still UNKNOWN, still no receipt.
    fixture.restart();
    assert_eq!(fixture.row(&effect_id).status, "UNKNOWN");
    assert_eq!(fixture.row(&effect_id).receipt_digest, None);

    // Exact target evidence is what settles it. Only now - with the bytes on
    // disk matching the durable after_digest - may recovery mint the receipt.
    fs::write(fixture.workspace.join("prepare-crash.txt"), content).unwrap();
    fixture.restart();
    let row = fixture.row(&effect_id);
    let receipt = expected_receipt(&effect_id, &row);
    assert_eq!(row.status, "SETTLED");
    assert_eq!(row.receipt_digest.as_deref(), Some(receipt.as_str()));
    assert_eq!(fixture.reconcile_receipt(&effect_id, 6), receipt);
    assert_eq!(fixture.challenge_count(&effect_id), 1);

    fixture.cleanup();
}

/// Window 2 - the effect executed and its bytes are durable, but the settle
/// UPDATE that mints the receipt never committed. Recovery must derive the one
/// exact receipt from durable facts, be idempotent across further restarts, and
/// never replace a committed receipt with one derived from conflicting evidence.
#[test]
fn settlement_crash_without_receipt_derives_the_exact_receipt_and_rejects_conflicts() {
    let mut fixture = Fixture::new();
    let content = "settled-before-the-crash";
    let (effect_id, lease) = fixture.prepare_write("settle-crash.txt", content);
    let executed = fixture.execute_write(&effect_id, &lease, content);
    assert_eq!(value_string(&executed, "status"), "settled");
    let live_receipt = fixture
        .row(&effect_id)
        .receipt_digest
        .clone()
        .expect("the live execute mints one receipt");
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("settle-crash.txt")).unwrap(),
        content
    );

    // Crash between the applied write and the receipt mint.
    fixture.reconstruct_settled_without_receipt(&effect_id);
    assert_eq!(fixture.row(&effect_id).receipt_digest, None);

    fixture.restart();

    // Recovery re-mints exactly the receipt the live path had produced: derived
    // from the durable effect, target, resource, existence, after_digest and
    // one-use lease - not a fresh or invented digest.
    let row = fixture.row(&effect_id);
    let derived = expected_receipt(&effect_id, &row);
    assert_eq!(row.status, "SETTLED");
    assert_eq!(
        row.receipt_digest.as_deref(),
        Some(derived.as_str()),
        "recovery must derive the durable receipt, not invent a new one"
    );
    assert_eq!(derived, live_receipt);
    assert_eq!(fixture.reconcile_receipt(&effect_id, 5), derived);
    assert_eq!(fixture.challenge_count(&effect_id), 1);

    // Re-settlement for the exact same durable cursor is idempotent: another
    // restart neither mints a second receipt nor replaces the committed one.
    fixture.restart();
    let after_second_restart = fixture.row(&effect_id);
    assert_eq!(after_second_restart.status, "SETTLED");
    assert_eq!(
        after_second_restart.receipt_digest.as_deref(),
        Some(derived.as_str())
    );
    assert_eq!(fixture.challenge_count(&effect_id), 1);
    assert_eq!(fixture.reconcile(&effect_id, 6), RpcOutcomeV1::Ok);

    // Replaying the settled execute is refused and leaves the receipt intact.
    let replayed = fixture.host.handle_request(
        &request(
            "execute_write",
            value_map([
                ("sessionID", string(SESSION)),
                ("locationID", string(&fixture.location_id)),
                ("effectID", string(&effect_id)),
                ("capabilityLeaseDigest", string(&lease)),
                ("content", string(content)),
            ]),
            7,
            fixture.epoch,
        ),
        PRINCIPAL,
        &fixture.fence,
    );
    assert_eq!(replayed.outcome, RpcOutcomeV1::Error);
    assert_eq!(
        fixture.row(&effect_id).receipt_digest.as_deref(),
        Some(derived.as_str())
    );

    // Conflicting evidence never settles and never mints a receipt: the durable
    // intent (after_digest) disagrees with the bytes actually on disk.
    let (conflict_id, conflict_lease) =
        fixture.prepare_write("conflict-crash.txt", "observed-on-disk");
    let observed = fixture.execute_write(&conflict_id, &conflict_lease, "observed-on-disk");
    assert_eq!(value_string(&observed, "status"), "settled");
    fixture.reconstruct_settled_without_receipt(&conflict_id);
    let conflicting_intent = blake3_digest(b"a-different-intended-payload");
    let changed = fixture
        .connection()
        .execute(
            "UPDATE effect_challenges SET after_digest=?1 WHERE effect_id=?2",
            rusqlite::params![conflicting_intent, conflict_id],
        )
        .unwrap();
    assert_eq!(changed, 1);

    fixture.restart();
    let conflicted = fixture.row(&conflict_id);
    assert_eq!(
        conflicted.status, "UNKNOWN",
        "a conflicting durable cursor must not re-settle"
    );
    assert_eq!(
        conflicted.receipt_digest, None,
        "conflicting evidence may never produce a receipt"
    );
    assert_eq!(
        fixture.reconcile_error_code(&conflict_id, 8),
        "effect_outcome_unknown"
    );
    assert_eq!(fixture.challenge_count(&conflict_id), 1);

    fixture.cleanup();
}
