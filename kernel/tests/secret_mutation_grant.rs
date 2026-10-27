#![cfg(target_os = "linux")]

//! HostKernel authenticated dispatch coverage for the `secret.v1` Guard grant.
//!
//! These tests intentionally never carry credential bytes. The request shape is
//! exactly the metadata-only contract from §12.17/§14.22: provider, optional
//! target/version, idempotency key and a bounded label. Identity comes from the
//! typed ServerAuth principal supplied out of band.

use horizoncode_kernel::host_kernel::{HostKernel, SECRET_SERVICE_ID};
use horizoncode_kernel::messagepack::Value;
use horizoncode_kernel::protocol::{
    AuthenticatedPrincipalV1, FrameFence, RpcOutcomeV1, RpcRequestV1, RpcResponseV1,
};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const OWNER: &str = "secret-mutation-owner";
const EPOCH: u64 = 83;
const INCARNATION: &str = "inc_secret_mutation";
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn value_map<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}
fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn request(operation: &str, body: Value) -> RpcRequestV1 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    RpcRequestV1 {
        owner_epoch: EPOCH,
        process_incarnation: INCARNATION.to_owned(),
        request_id: format!("req-secret-{operation}-{id}"),
        service_id: SECRET_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: now_ms() + 30_000,
        trace_id: "trace-secret-mutation".to_owned(),
        body,
    }
}
fn ok_body(response: RpcResponseV1) -> Value {
    assert_eq!(
        response.outcome,
        RpcOutcomeV1::Ok,
        "unexpected error: {:?}",
        response.error
    );
    response
        .body
        .expect("success response must carry a body")
}
fn error_code(response: RpcResponseV1) -> String {
    assert_eq!(response.outcome, RpcOutcomeV1::Error);
    response
        .error
        .expect("error response must carry error")
        .code
}
fn map_fields(value: &Value) -> &BTreeMap<String, Value> {
    let Value::Map(fields) = value else {
        panic!("expected map, got {value:?}");
    };
    fields
}
fn text_field<'a>(value: &'a Value, key: &str) -> &'a str {
    match map_fields(value).get(key) {
        Some(Value::String(value)) => value,
        other => panic!("missing string field {key}: {other:?}"),
    }
}
fn unsigned_field(value: &Value, key: &str) -> u64 {
    match map_fields(value).get(key) {
        Some(Value::Unsigned(value)) => *value,
        other => panic!("missing unsigned field {key}: {other:?}"),
    }
}
fn grant(body: &Value) -> &Value {
    assert_eq!(text_field(body, "status"), "COMMITTED", "body={body:?}");
    map_fields(body)
        .get("grant")
        .expect("committed grant must be present")
}
fn replay_grant(body: &Value) -> &Value {
    assert_eq!(text_field(body, "status"), "REPLAY", "body={body:?}");
    map_fields(body)
        .get("grant")
        .expect("replayed grant must be present")
}

struct Fixture {
    state: PathBuf,
    host: Option<HostKernel>,
    fence: FrameFence,
    auth: AuthenticatedPrincipalV1,
}
impl Fixture {
    fn new() -> Self {
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "hz-secret-mutation-{}-{tick}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let state = base.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        let state = fs::canonicalize(state).unwrap();
        let fence = FrameFence::new(EPOCH, INCARNATION).unwrap();
        let auth = AuthenticatedPrincipalV1::ServerAuth {
            subject: OWNER.to_owned(),
        };
        let mut host = HostKernel::open(&state).unwrap();
        host.set_effects_enabled(true);
        Self {
            state,
            host: Some(host),
            fence,
            auth,
        }
    }
    fn send_as(
        &mut self,
        auth: &AuthenticatedPrincipalV1,
        request: &RpcRequestV1,
    ) -> RpcResponseV1 {
        self.host
            .as_mut()
            .unwrap()
            .handle_authenticated_request_with_context_and_cancellation(
                request, auth, &self.fence, None, None,
            )
    }
    fn send(&mut self, request: &RpcRequestV1) -> RpcResponseV1 {
        self.send_as(&self.auth.clone(), request)
    }
    fn restart(&mut self) {
        let state = self.state.clone();
        self.host = None;
        let mut host = HostKernel::open(&state).unwrap();
        host.set_effects_enabled(true);
        self.host = Some(host);
    }
    fn send_untyped(&mut self, principal: &str, request: &RpcRequestV1) -> RpcResponseV1 {
        self.host
            .as_mut()
            .unwrap()
            .handle_request_with_authenticated_context_and_cancellation(
                request,
                principal,
                &self.fence,
                None,
                None,
            )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(root) = self.state.parent() {
            let _ = fs::remove_dir_all(root);
        }
    }
}

fn put_body(provider: &str, label: &str, idempotency_key: &str) -> Value {
    value_map([
        ("providerId", string(provider)),
        ("label", string(label)),
        ("idempotencyKey", string(idempotency_key)),
    ])
}
fn targeted_body(
    provider: &str,
    secret_ref: &str,
    expected_version: &str,
    idempotency_key: &str,
) -> Value {
    value_map([
        ("providerId", string(provider)),
        ("secretRef", string(secret_ref)),
        ("expectedVersion", string(expected_version)),
        ("idempotencyKey", string(idempotency_key)),
    ])
}

#[test]
fn authenticated_principal_authorizes_put_and_receives_one_use_grant() {
    let mut fixture = Fixture::new();
    let put = request(
        "authorize_put",
        put_body("openai", "primary", "idem-put-1"),
    );
    let committed = ok_body(fixture.send(&put));
    let first = grant(&committed);
    assert_eq!(text_field(first, "operation"), "put");
    assert_eq!(text_field(first, "providerId"), "openai");
    assert!(
        text_field(first, "secretRef").starts_with("secret_"),
        "grant={first:?}"
    );
    assert_eq!(text_field(first, "version"), "1");
    assert_eq!(text_field(first, "label"), "primary");
    assert!(text_field(first, "receiptID").len() > 8);
    assert!(
        text_field(first, "grantDigest").starts_with("blake3:"),
        "grant={first:?}"
    );
    assert_eq!(
        text_field(first, "grantDigest").len(),
        "blake3:".len() + 64
    );
    assert!(unsigned_field(first, "expiresAtUnixMs") > now_ms());

    let secret_ref = text_field(first, "secretRef").to_owned();
    let receipt_id = text_field(first, "receiptID").to_owned();
    let grant_digest = text_field(first, "grantDigest").to_owned();

    // The exact same request resolves only the exact durable receipt. It does
    // not mint a second secret or a second one-use token.
    let replayed = ok_body(fixture.send(&put));
    let second = replay_grant(&replayed);
    assert_eq!(text_field(second, "secretRef"), secret_ref);
    assert_eq!(text_field(second, "receiptID"), receipt_id);
    assert_eq!(text_field(second, "grantDigest"), grant_digest);
    assert_eq!(text_field(second, "version"), "1");

    // A changed body under the same idempotency key is a conflict, never an
    // implicit replacement.
    let conflicting = fixture.send(&request(
        "authorize_put",
        put_body("openai", "other-label", "idem-put-1"),
    ));
    assert_eq!(error_code(conflicting), "secret_conflict");
    let still_original = ok_body(fixture.send(&put));
    assert_eq!(
        text_field(replay_grant(&still_original), "receiptID"),
        receipt_id
    );
}

#[test]
fn forged_and_absent_principals_cannot_mutate_another_owners_secret() {
    let mut fixture = Fixture::new();
    let created = ok_body(fixture.send(&request(
        "authorize_put",
        put_body("openai", "owner-secret", "idem-owner-put"),
    )));
    let secret_ref = text_field(grant(&created), "secretRef").to_owned();

    let forged = AuthenticatedPrincipalV1::ServerAuth {
        subject: "not-the-owner".to_owned(),
    };
    for operation in ["authorize_rotate", "authorize_revoke"] {
        let response = fixture.send_as(
            &forged,
            &request(
                operation,
                targeted_body("openai", &secret_ref, "1", "idem-forged"),
            ),
        );
        assert_eq!(
            error_code(response),
            "secret_not_found",
            "forged owner must not see another owner's target"
        );
    }

    // A malformed, unattested principal string never mints a grant.
    let untyped = fixture.send_untyped(
        "host_os_uid:abc",
        &request(
            "authorize_rotate",
            targeted_body("openai", &secret_ref, "1", "idem-untyped"),
        ),
    );
    assert_eq!(error_code(untyped), "missing_principal");

    // The kernel-attested local OS principal owns its own credential scope and
    // can authorize its own put/rotate; neither owner can reach the other's.
    let local_put = ok_body(fixture.send_untyped(
        "host_os_uid:1000",
        &request(
            "authorize_put",
            put_body("openai", "host-os-secret", "idem-host-os-put"),
        ),
    ));
    let local_ref = text_field(grant(&local_put), "secretRef").to_owned();
    let local_rotate = ok_body(fixture.send_untyped(
        "host_os_uid:1000",
        &request(
            "authorize_rotate",
            targeted_body("openai", &local_ref, "1", "idem-host-os-rotate"),
        ),
    ));
    assert_eq!(text_field(grant(&local_rotate), "version"), "2");
    let cross_owner = fixture.send(&request(
        "authorize_rotate",
        targeted_body("openai", &local_ref, "2", "idem-cross-owner"),
    ));
    assert_eq!(
        error_code(cross_owner),
        "secret_not_found",
        "a ServerAuth owner must not reach a host OS owner scope"
    );

    let rotated = ok_body(fixture.send(&request(
        "authorize_rotate",
        targeted_body("openai", &secret_ref, "1", "idem-owner-rotate"),
    )));
    assert_eq!(text_field(grant(&rotated), "version"), "2");
    assert_eq!(text_field(grant(&rotated), "secretRef"), secret_ref);
}

#[test]
fn rotate_and_revoke_require_exact_target_and_version_and_deny_before_state_change() {
    let mut fixture = Fixture::new();
    let created = ok_body(fixture.send(&request(
        "authorize_put",
        put_body("openai", "versioned", "idem-create"),
    )));
    let secret_ref = text_field(grant(&created), "secretRef").to_owned();

    // Stale rotation is denied. Reusing the same key with the correct version
    // succeeds, proving the denied attempt wrote no receipt.
    let stale = fixture.send(&request(
        "authorize_rotate",
        targeted_body("openai", &secret_ref, "2", "idem-rotate"),
    ));
    assert_eq!(error_code(stale), "secret_stale_version");
    let fixed = ok_body(fixture.send(&request(
        "authorize_rotate",
        targeted_body("openai", &secret_ref, "1", "idem-rotate"),
    )));
    assert_eq!(text_field(grant(&fixed), "version"), "2");

    // Missing target and mismatched provider are denied before any mutation.
    let missing = fixture.send(&request(
        "authorize_rotate",
        targeted_body("openai", "secret_missing", "1", "idem-missing"),
    ));
    assert_eq!(error_code(missing), "secret_not_found");
    let provider_mismatch = fixture.send(&request(
        "authorize_rotate",
        targeted_body("anthropic", &secret_ref, "2", "idem-provider"),
    ));
    assert_eq!(error_code(provider_mismatch), "secret_provider_mismatch");
    let corrected = ok_body(fixture.send(&request(
        "authorize_rotate",
        targeted_body("openai", &secret_ref, "2", "idem-provider"),
    )));
    assert_eq!(text_field(grant(&corrected), "version"), "3");

    // Missing or half-specified target/version is a validation error.
    for body in [
        value_map([
            ("providerId", string("openai")),
            ("secretRef", string(&secret_ref)),
            ("idempotencyKey", string("idem-half-1")),
        ]),
        value_map([
            ("providerId", string("openai")),
            ("expectedVersion", string("3")),
            ("idempotencyKey", string("idem-half-2")),
        ]),
    ] {
        assert_eq!(
            error_code(fixture.send(&request("authorize_rotate", body))),
            "invalid_effect_request"
        );
    }

    // Revoke is version-fenced too. A stale key can be reused after the exact
    // version is supplied because no receipt was written for the stale attempt.
    let stale_revoke = fixture.send(&request(
        "authorize_revoke",
        targeted_body("openai", &secret_ref, "2", "idem-revoke"),
    ));
    assert_eq!(error_code(stale_revoke), "secret_stale_version");
    let revoked = ok_body(fixture.send(&request(
        "authorize_revoke",
        targeted_body("openai", &secret_ref, "3", "idem-revoke"),
    )));
    assert_eq!(text_field(grant(&revoked), "operation"), "revoke");
    assert_eq!(text_field(grant(&revoked), "version"), "4");
    let revocation = map_fields(&revoked)
        .get("revocation")
        .expect("revoke must return its revocation receipt");
    assert_eq!(text_field(revocation, "secretRef"), secret_ref);
    assert_eq!(text_field(revocation, "revokedVersion"), "3");
}

#[test]
fn revoke_returns_receipt_and_only_an_exact_replay_is_accepted() {
    let mut fixture = Fixture::new();
    let created = ok_body(fixture.send(&request(
        "authorize_put",
        put_body("openai", "revoked-secret", "idem-create"),
    )));
    let secret_ref = text_field(grant(&created), "secretRef").to_owned();

    let revoke_body = targeted_body("openai", &secret_ref, "1", "idem-revoke");
    let revoked = ok_body(fixture.send(&request("authorize_revoke", revoke_body.clone())));
    let receipt = grant(&revoked);
    let receipt_id = text_field(receipt, "receiptID").to_owned();
    assert_eq!(text_field(receipt, "operation"), "revoke");
    assert_eq!(text_field(receipt, "revokedVersion"), "1");
    assert_eq!(text_field(receipt, "version"), "2");
    let revocation = map_fields(&revoked)
        .get("revocation")
        .expect("revocation receipt is required");
    assert_eq!(text_field(revocation, "receiptID"), receipt_id);
    assert_eq!(text_field(revocation, "secretRef"), secret_ref);

    // Exact replay is served from the exact receipt, not a fresh revocation.
    let replayed = ok_body(fixture.send(&request("authorize_revoke", revoke_body.clone())));
    let replay = replay_grant(&replayed);
    assert_eq!(text_field(replay, "receiptID"), receipt_id);
    assert_eq!(text_field(replay, "revokedVersion"), "1");
    assert_eq!(text_field(replay, "version"), "2");

    // A replay that is not the exact receipt is denied and cannot advance state.
    let mismatched = fixture.send(&request(
        "authorize_revoke",
        targeted_body("openai", &secret_ref, "2", "idem-revoke"),
    ));
    assert_eq!(error_code(mismatched), "secret_conflict");

    // The target is now version 2 and REVOKED. A new revoke or rotate at the
    // current version is fenced and writes no new receipt.
    for operation in ["authorize_revoke", "authorize_rotate"] {
        let denied = fixture.send(&request(
            operation,
            targeted_body("openai", &secret_ref, "2", "idem-after-revoke"),
        ));
        assert_eq!(error_code(denied), "secret_revoked");
    }
}

#[test]
fn request_rejects_credential_bytes_and_caller_principal_fields() {
    let mut fixture = Fixture::new();
    for body in [
        value_map([
            ("providerId", string("openai")),
            ("idempotencyKey", string("idem-bytes")),
            (
                "credentialBytes",
                Value::Binary(vec![0x73, 0x6b, 0x2d, 0x74, 0x65, 0x73, 0x74]),
            ),
        ]),
        value_map([
            ("providerId", string("openai")),
            ("idempotencyKey", string("idem-principal")),
            ("principal", string("server_auth:someone-else")),
        ]),
        value_map([
            ("providerId", string("openai")),
            ("idempotencyKey", string("idem-secure-input")),
            ("secureInputHandle", string("handle-raw-credential")),
        ]),
    ] {
        assert_eq!(
            error_code(fixture.send(&request("authorize_put", body))),
            "invalid_effect_request"
        );
    }
}

#[test]
fn exact_receipt_survives_host_restart_without_reissuing_authority() {
    let mut fixture = Fixture::new();
    let put = request(
        "authorize_put",
        put_body("openai", "restart-secret", "idem-restart"),
    );
    let created = ok_body(fixture.send(&put));
    let receipt_id = text_field(grant(&created), "receiptID").to_owned();
    let grant_digest = text_field(grant(&created), "grantDigest").to_owned();
    let secret_ref = text_field(grant(&created), "secretRef").to_owned();

    // Reopen the exact same durable HostKernel state. The journal, EffectHost
    // settlement and target version must all survive; the replay serves only the
    // retained receipt.
    fixture.restart();
    let replayed = ok_body(fixture.send(&put));
    let replay = replay_grant(&replayed);
    assert_eq!(text_field(replay, "receiptID"), receipt_id);
    assert_eq!(text_field(replay, "grantDigest"), grant_digest);
    assert_eq!(text_field(replay, "secretRef"), secret_ref);
    assert_eq!(text_field(replay, "version"), "1");

    // A new idempotency key still sees the durable target version and is fenced.
    let stale = fixture.send(&request(
        "authorize_rotate",
        targeted_body("openai", &secret_ref, "2", "idem-restart-stale"),
    ));
    assert_eq!(error_code(stale), "secret_stale_version");
    let rotated = ok_body(fixture.send(&request(
        "authorize_rotate",
        targeted_body("openai", &secret_ref, "1", "idem-restart-rotate"),
    )));
    assert_eq!(text_field(grant(&rotated), "version"), "2");
}

#[test]
fn probe_cli_put_only_body_without_label() {
    let mut fixture = Fixture::new();
    let body = value_map([
        ("providerId", string("openrouter")),
        ("idempotencyKey", string("put_2f6a1c3e-1111-2222-3333-444455556666")),
    ]);
    let response = fixture.send_untyped("host_os_uid:1000", &request("authorize_put", body));
    match response.outcome {
        RpcOutcomeV1::Ok => println!("PROBE_OK"),
        RpcOutcomeV1::Error => println!(
            "PROBE_ERROR {:?}",
            response.error.as_ref().map(|e| (e.code.clone(), e.message.clone()))
        ),
    }
}
