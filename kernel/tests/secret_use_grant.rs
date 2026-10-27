#![cfg(target_os = "linux")]

//! HostKernel authenticated dispatch coverage for the `secret.v1` one-use
//! provider **use** authorization (`authorize_use` / `redeem_use`).
//!
//! These tests never carry credential bytes. The request is metadata only: the
//! exact target secret, provider, destination, operation digest, purpose and a
//! bounded expiry window. Identity is derived from the typed ServerAuth
//! principal or the kernel-attested `host_os_uid` principal, never from request
//! fields.

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

const OWNER: &str = "secret-use-owner";
const FORGED_OWNER: &str = "not-the-use-owner";
const EPOCH: u64 = 89;
const INCARNATION: &str = "inc_secret_use";
const PROVIDER: &str = "openai";
const DESTINATION: &str = "https://api.openai.com/v1/responses";
const PURPOSE: &str = "PROVIDER_REQUEST";
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
fn digest(seed: char) -> String {
    format!("blake3:{}", seed.to_string().repeat(64))
}
fn request(operation: &str, body: Value) -> RpcRequestV1 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    RpcRequestV1 {
        owner_epoch: EPOCH,
        process_incarnation: INCARNATION.to_owned(),
        request_id: format!("req-secret-use-{operation}-{id}"),
        service_id: SECRET_SERVICE_ID.to_owned(),
        operation: operation.to_owned(),
        delivery_id: None,
        expected_cursor: None,
        deadline_unix_ms: now_ms() + 30_000,
        trace_id: "trace-secret-use".to_owned(),
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
fn nested<'a>(value: &'a Value, key: &str) -> &'a Value {
    map_fields(value)
        .get(key)
        .unwrap_or_else(|| panic!("missing nested field {key}: {value:?}"))
}
fn status(value: &Value) -> &str {
    text_field(value, "status")
}
fn issued_lease(body: &Value) -> &Value {
    assert_eq!(status(body), "COMMITTED", "body={body:?}");
    nested(body, "lease")
}
fn replayed_lease(body: &Value) -> &Value {
    assert_eq!(status(body), "REPLAY", "body={body:?}");
    nested(body, "lease")
}
fn lease_receipt(body: &Value) -> &Value {
    nested(body, "receipt")
}
fn assert_no_credential_material(value: &Value) {
    for key in map_fields(value).keys() {
        let lowered = key.to_ascii_lowercase();
        assert!(
            !lowered.contains("credential")
                && !lowered.contains("secretbytes")
                && !lowered.contains("plaintext")
                && lowered != "value"
                && lowered != "bytes",
            "metadata projection leaked a credential-shaped field {key}: {value:?}"
        );
    }
    for child in map_fields(value).values() {
        if let Value::Binary(_) = child {
            panic!("metadata projection must never carry binary material: {value:?}");
        }
    }
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
            "hz-secret-use-{}-{tick}-{}",
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
    fn restart(&mut self) {
        let state = self.state.clone();
        self.host = None;
        let mut host = HostKernel::open(&state).unwrap();
        host.set_effects_enabled(true);
        self.host = Some(host);
    }
    /// Create one AVAILABLE secret owned by the authenticated ServerAuth owner
    /// and return its `secretRef`.
    fn put_secret(&mut self, provider: &str, label: &str, idempotency_key: &str) -> String {
        let created = ok_body(self.send(&request(
            "authorize_put",
            value_map([
                ("providerId", string(provider)),
                ("label", string(label)),
                ("idempotencyKey", string(idempotency_key)),
            ]),
        )));
        let grant = nested(&created, "grant");
        text_field(grant, "secretRef").to_owned()
    }
    fn revoke(&mut self, provider: &str, secret_ref: &str, version: &str, idempotency_key: &str) {
        let revoked = ok_body(self.send(&request(
            "authorize_revoke",
            value_map([
                ("providerId", string(provider)),
                ("secretRef", string(secret_ref)),
                ("expectedVersion", string(version)),
                ("idempotencyKey", string(idempotency_key)),
            ]),
        )));
        assert_eq!(text_field(nested(&revoked, "grant"), "operation"), "revoke");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(root) = self.state.parent() {
            let _ = fs::remove_dir_all(root);
        }
    }
}

fn use_body(
    secret_ref: &str,
    provider: &str,
    destination: &str,
    operation_digest: &str,
    purpose: &str,
    window: (&str, Value),
    idempotency_key: &str,
) -> Value {
    value_map([
        ("secretRef", string(secret_ref)),
        ("providerId", string(provider)),
        ("destination", string(destination)),
        ("operationDigest", string(operation_digest)),
        ("purpose", string(purpose)),
        (window.0, window.1),
        ("idempotencyKey", string(idempotency_key)),
    ])
}
fn valid_use_body(
    secret_ref: &str,
    operation_digest: &str,
    idempotency_key: &str,
) -> Value {
    use_body(
        secret_ref,
        PROVIDER,
        DESTINATION,
        operation_digest,
        PURPOSE,
        ("ttlMs", Value::Unsigned(30_000)),
        idempotency_key,
    )
}
fn redeem_body(lease_id: &str, idempotency_key: &str) -> Value {
    value_map([
        ("leaseId", string(lease_id)),
        ("idempotencyKey", string(idempotency_key)),
    ])
}

#[test]
fn authenticated_owner_authorizes_one_use_provider_lease() {
    let mut fixture = Fixture::new();
    let secret_ref = fixture.put_secret(PROVIDER, "primary", "idem-seed");
    let operation_digest = digest('a');
    let body = valid_use_body(&secret_ref, &operation_digest, "idem-use-1");

    let committed = ok_body(fixture.send(&request("authorize_use", body.clone())));
    assert_eq!(status(&committed), "COMMITTED");
    let lease = issued_lease(&committed);
    assert_no_credential_material(&committed);
    assert_no_credential_material(lease);
    assert_eq!(text_field(lease, "secretRef"), secret_ref);
    assert_eq!(text_field(lease, "secretVersion"), "1");
    assert_eq!(text_field(lease, "providerId"), PROVIDER);
    assert_eq!(text_field(lease, "operationDigest"), operation_digest);
    assert_eq!(text_field(lease, "destination"), DESTINATION);
    assert_eq!(text_field(lease, "purpose"), PURPOSE);
    assert_eq!(text_field(lease, "state"), "ISSUED");
    assert_eq!(unsigned_field(lease, "maxRequests"), 1);
    let issued_at = unsigned_field(lease, "issuedAt");
    let expires_at = unsigned_field(lease, "expiresAt");
    assert!(issued_at > 0 && issued_at <= now_ms());
    assert!(expires_at > issued_at && expires_at <= issued_at + 120_000);
    let lease_id = text_field(lease, "leaseId").to_owned();
    assert!(lease_id.starts_with("secret_lease_"), "lease={lease:?}");

    let receipt = lease_receipt(&committed);
    let receipt_id = text_field(receipt, "receiptID").to_owned();
    let receipt_digest = text_field(receipt, "receiptDigest").to_owned();
    assert_eq!(text_field(receipt, "leaseID"), lease_id);
    assert_eq!(text_field(receipt, "secretRef"), secret_ref);
    assert!(receipt_digest.starts_with("blake3:"));
    assert_eq!(receipt_digest.len(), "blake3:".len() + 64);

    // Exact replay resolves only the durable receipt; it never mints a second
    // lease or a second one-use token.
    let replayed = ok_body(fixture.send(&request("authorize_use", body.clone())));
    let replay = replayed_lease(&replayed);
    assert_eq!(text_field(replay, "leaseId"), lease_id);
    assert_eq!(text_field(replay, "state"), "ISSUED");
    assert_eq!(text_field(replay, "destination"), DESTINATION);
    assert_eq!(
        text_field(lease_receipt(&replayed), "receiptID"),
        receipt_id
    );
    assert_eq!(
        text_field(lease_receipt(&replayed), "receiptDigest"),
        receipt_digest
    );

    // The lease is redeemed exactly once by the calling owner.
    let redeemed = ok_body(fixture.send(&request(
        "redeem_use",
        redeem_body(&lease_id, "redeem-1"),
    )));
    assert_eq!(status(&redeemed), "CONSUMED");
    let redemption = nested(&redeemed, "redemption");
    assert_no_credential_material(redemption);
    assert_eq!(text_field(redemption, "leaseID"), lease_id);
    assert_eq!(text_field(redemption, "secretRef"), secret_ref);
    assert_eq!(text_field(redemption, "providerId"), PROVIDER);
    assert_eq!(text_field(redemption, "operationDigest"), operation_digest);
    assert_eq!(text_field(redemption, "destination"), DESTINATION);
    assert_eq!(text_field(redemption, "purpose"), PURPOSE);
    assert_eq!(text_field(redemption, "state"), "CONSUMED");
    assert_eq!(unsigned_field(redemption, "maxRequests"), 1);
    assert!(unsigned_field(redemption, "redeemedAt") >= issued_at);
    assert!(
        text_field(redemption, "redemptionDigest").starts_with("blake3:"),
        "redemption={redemption:?}"
    );

    // A second redemption of a consumed lease always fails closed.
    let second = fixture.send(&request(
        "redeem_use",
        redeem_body(&lease_id, "redeem-2"),
    ));
    assert_eq!(error_code(second), "secret_use_consumed");

    // Replaying the issue receipt after consumption returns the same immutable
    // lease identity, now projected as CONSUMED; it does not re-open the lease.
    let replayed_after =
        ok_body(fixture.send(&request("authorize_use", body.clone())));
    assert_eq!(status(&replayed_after), "REPLAY");
    assert_eq!(text_field(replayed_lease(&replayed_after), "leaseId"), lease_id);
    assert_eq!(
        text_field(replayed_lease(&replayed_after), "state"),
        "CONSUMED"
    );
    assert_eq!(
        text_field(lease_receipt(&replayed_after), "receiptID"),
        receipt_id
    );
}

#[test]
fn host_os_principal_authorizes_use_only_inside_its_own_scope() {
    let mut fixture = Fixture::new();
    let local_put = ok_body(fixture.send_untyped(
        "host_os_uid:1000",
        &request(
            "authorize_put",
            value_map([
                ("providerId", string(PROVIDER)),
                ("label", string("host-os")),
                ("idempotencyKey", string("idem-host-os-seed")),
            ]),
        ),
    ));
    let local_ref = text_field(nested(&local_put, "grant"), "secretRef").to_owned();

    let local_use = ok_body(fixture.send_untyped(
        "host_os_uid:1000",
        &request(
            "authorize_use",
            valid_use_body(&local_ref, &digest('b'), "idem-host-os-use"),
        ),
    ));
    assert_eq!(status(&local_use), "COMMITTED");
    assert_eq!(text_field(issued_lease(&local_use), "secretRef"), local_ref);

    // A ServerAuth owner has a different owner scope and cannot see that target.
    let cross_owner = fixture.send(&request(
        "authorize_use",
        valid_use_body(&local_ref, &digest('c'), "idem-cross-owner-use"),
    ));
    assert_eq!(error_code(cross_owner), "secret_not_found");

    // The host OS owner cannot redeem a lease minted for the ServerAuth owner.
    let owner_secret = fixture.put_secret(PROVIDER, "owner", "idem-owner-seed");
    let owner_use = ok_body(fixture.send(&request(
        "authorize_use",
        valid_use_body(&owner_secret, &digest('d'), "idem-owner-use"),
    )));
    let owner_lease_id = text_field(issued_lease(&owner_use), "leaseId").to_owned();
    let foreign_redeem = fixture.send_untyped(
        "host_os_uid:1000",
        &request(
            "redeem_use",
            redeem_body(&owner_lease_id, "redeem-foreign"),
        ),
    );
    assert_eq!(error_code(foreign_redeem), "secret_not_found");
}

#[test]
fn forged_or_malformed_owner_identity_never_mints_a_use_lease() {
    let mut fixture = Fixture::new();
    let secret_ref = fixture.put_secret(PROVIDER, "guarded", "idem-guarded-seed");

    let forged = AuthenticatedPrincipalV1::ServerAuth {
        subject: FORGED_OWNER.to_owned(),
    };
    let forged_use = fixture.send_as(
        &forged,
        &request(
            "authorize_use",
            valid_use_body(&secret_ref, &digest('e'), "idem-forged-use"),
        ),
    );
    assert_eq!(
        error_code(forged_use),
        "secret_not_found",
        "a foreign owner must not see another owner's target"
    );

    let malformed = fixture.send_untyped(
        "host_os_uid:abc",
        &request(
            "authorize_use",
            valid_use_body(&secret_ref, &digest('f'), "idem-malformed-use"),
        ),
    );
    assert_eq!(error_code(malformed), "missing_principal");
    let unattested = fixture.send_untyped(
        "server_auth:someone-else",
        &request(
            "authorize_use",
            valid_use_body(&secret_ref, &digest('f'), "idem-unattested-use"),
        ),
    );
    // A host-supplied `server_auth:` binding becomes its own owner scope, so
    // the forged subject is a foreign owner rather than an unattested principal.
    assert_eq!(error_code(unattested), "secret_not_found");

    // The owner still reaches its own target: the denials wrote no receipt.
    let own = ok_body(fixture.send(&request(
        "authorize_use",
        valid_use_body(&secret_ref, &digest('0'), "idem-forged-use"),
    )));
    assert_eq!(status(&own), "COMMITTED");
}

#[test]
fn missing_and_revoked_targets_are_denied_before_any_lease_exists() {
    let mut fixture = Fixture::new();
    let missing = fixture.send(&request(
        "authorize_use",
        valid_use_body("secret_missing", &digest('a'), "idem-missing-use"),
    ));
    assert_eq!(error_code(missing), "secret_not_found");

    let secret_ref = fixture.put_secret(PROVIDER, "revoked", "idem-revoked-seed");
    fixture.revoke(PROVIDER, &secret_ref, "1", "idem-revoked");
    let revoked = fixture.send(&request(
        "authorize_use",
        valid_use_body(&secret_ref, &digest('b'), "idem-revoked-use"),
    ));
    assert_eq!(error_code(revoked), "secret_revoked");

    // Reusing the denied key after the target is still revoked stays denied, so
    // the first denial left no receipt or PREPARED intent behind.
    let retried = fixture.send(&request(
        "authorize_use",
        valid_use_body(&secret_ref, &digest('b'), "idem-revoked-use"),
    ));
    assert_eq!(error_code(retried), "secret_revoked");
}

#[test]
fn provider_mismatch_is_denied_and_a_corrected_request_reuses_the_key() {
    let mut fixture = Fixture::new();
    let secret_ref = fixture.put_secret(PROVIDER, "provider", "idem-provider-seed");

    let mismatch = fixture.send(&request(
        "authorize_use",
        use_body(
            &secret_ref,
            "anthropic",
            DESTINATION,
            &digest('a'),
            PURPOSE,
            ("ttlMs", Value::Unsigned(30_000)),
            "idem-provider-use",
        ),
    ));
    assert_eq!(error_code(mismatch), "secret_provider_mismatch");

    // The same idempotency key succeeds after correction, proving the denied
    // attempt persisted no receipt and no unsettled intent.
    let corrected = ok_body(fixture.send(&request(
        "authorize_use",
        valid_use_body(&secret_ref, &digest('a'), "idem-provider-use"),
    )));
    assert_eq!(status(&corrected), "COMMITTED");
    assert_eq!(text_field(issued_lease(&corrected), "providerId"), PROVIDER);
}

#[test]
fn malformed_digest_destination_and_request_shape_are_rejected() {
    let mut fixture = Fixture::new();
    let secret_ref = fixture.put_secret(PROVIDER, "strict", "idem-strict-seed");
    let ok_digest = digest('a');
    let time = || ("ttlMs", Value::Unsigned(30_000));

    let mut bodies: Vec<Value> = Vec::new();
    for digest_value in [
        "blake3:".to_owned() + &"A".repeat(64),
        "sha256:".to_owned() + &"a".repeat(64),
        "blake3:".to_owned() + &"a".repeat(63),
        "blake3:".to_owned() + &"g".repeat(64),
        "a".repeat(64),
    ] {
        bodies.push(use_body(
            &secret_ref,
            PROVIDER,
            DESTINATION,
            &digest_value,
            PURPOSE,
            time(),
            "idem-malformed-digest",
        ));
    }
    for destination in [
        "http://api.openai.com/v1/responses",
        "https://user:pass@api.openai.com/v1/responses",
        "https://api.openai.com/v1/responses?debug=1",
        "https://api.openai.com/v1/responses#fragment",
        "https://",
        "/v1/responses",
        "ftp://api.openai.com/v1/responses",
    ] {
        bodies.push(use_body(
            &secret_ref,
            PROVIDER,
            destination,
            &ok_digest,
            PURPOSE,
            time(),
            "idem-malformed-destination",
        ));
    }
    let oversized = format!("https://api.openai.com/{}", "a".repeat(2_100));
    bodies.push(use_body(
        &secret_ref,
        PROVIDER,
        &oversized,
        &ok_digest,
        PURPOSE,
        time(),
        "idem-oversized-destination",
    ));
    bodies.push(use_body(
        &secret_ref,
        PROVIDER,
        DESTINATION,
        &ok_digest,
        "LOGIN",
        time(),
        "idem-wrong-purpose",
    ));
    // No expiry window at all, and both windows at once, are invalid.
    bodies.push(value_map([
        ("secretRef", string(&secret_ref)),
        ("providerId", string(PROVIDER)),
        ("destination", string(DESTINATION)),
        ("operationDigest", string(&ok_digest)),
        ("purpose", string(PURPOSE)),
        ("idempotencyKey", string("idem-no-window")),
    ]));
    bodies.push(value_map([
        ("secretRef", string(&secret_ref)),
        ("providerId", string(PROVIDER)),
        ("destination", string(DESTINATION)),
        ("operationDigest", string(&ok_digest)),
        ("purpose", string(PURPOSE)),
        ("ttlMs", Value::Unsigned(30_000)),
        ("maxExpiresAt", Value::Unsigned(now_ms() + 30_000)),
        ("idempotencyKey", string("idem-two-windows")),
    ]));
    // Strict field set: caller identity, credential material and effect handles
    // are never accepted as request metadata.
    for (key, value) in [
        (
            "credentialBytes",
            Value::Binary(vec![0x73, 0x6b, 0x2d, 0x74, 0x65, 0x73, 0x74]),
        ),
        ("principal", string("server_auth:someone-else")),
        ("secureInputHandle", string("handle-raw-credential")),
        ("challengeID", string("ch_secret_use")),
        ("effectID", string("eff_secret_use")),
        ("secretBytes", Value::Binary(vec![0x00, 0x01])),
    ] {
        let mut fields = BTreeMap::new();
        for (field, field_value) in [
            ("secretRef", string(&secret_ref)),
            ("providerId", string(PROVIDER)),
            ("destination", string(DESTINATION)),
            ("operationDigest", string(&ok_digest)),
            ("purpose", string(PURPOSE)),
            ("ttlMs", Value::Unsigned(30_000)),
            ("idempotencyKey", string("idem-extra-field")),
        ] {
            fields.insert(field.to_owned(), field_value);
        }
        fields.insert(key.to_owned(), value);
        bodies.push(Value::Map(fields));
    }

    for (index, body) in bodies.into_iter().enumerate() {
        assert_eq!(
            error_code(fixture.send(&request("authorize_use", body))),
            "invalid_effect_request",
            "body #{index} must be rejected"
        );
    }

    // The exact valid request still succeeds: no rejection wrote a binding.
    let accepted = ok_body(fixture.send(&request(
        "authorize_use",
        valid_use_body(&secret_ref, &ok_digest, "idem-strict-seed"),
    )));
    assert_eq!(status(&accepted), "COMMITTED");
}

#[test]
fn expired_or_out_of_window_expiry_is_denied() {
    let mut fixture = Fixture::new();
    let secret_ref = fixture.put_secret(PROVIDER, "expiry", "idem-expiry-seed");
    let now = now_ms();
    for (index, window) in [
        ("maxExpiresAt", Value::Unsigned(now.saturating_sub(1))),
        ("maxExpiresAt", Value::Unsigned(now + 130_000)),
        ("ttlMs", Value::Unsigned(0)),
        ("ttlMs", Value::Unsigned(120_001)),
        ("ttlMs", Value::Unsigned(86_400_000)),
    ]
    .into_iter()
    .enumerate()
    {
        let body = use_body(
            &secret_ref,
            PROVIDER,
            DESTINATION,
            &digest('a'),
            PURPOSE,
            window,
            "idem-expired-window",
        );
        assert_eq!(
            error_code(fixture.send(&request("authorize_use", body))),
            "expired",
            "window #{index} must be rejected as expired"
        );
    }

    // The upper bound itself is accepted.
    let accepted = ok_body(fixture.send(&request(
        "authorize_use",
        use_body(
            &secret_ref,
            PROVIDER,
            DESTINATION,
            &digest('a'),
            PURPOSE,
            ("maxExpiresAt", Value::Unsigned(now + 119_000)),
            "idem-window-bound",
        ),
    )));
    let lease = issued_lease(&accepted);
    assert!(unsigned_field(lease, "expiresAt") <= now + 120_000);
}

#[test]
fn replay_mismatch_is_a_conflict_and_exact_replay_is_stable() {
    let mut fixture = Fixture::new();
    let secret_ref = fixture.put_secret(PROVIDER, "replay", "idem-replay-seed");
    let operation_digest = digest('a');
    let body = valid_use_body(&secret_ref, &operation_digest, "idem-replay-use");
    let first = ok_body(fixture.send(&request("authorize_use", body.clone())));
    let lease_id = text_field(issued_lease(&first), "leaseId").to_owned();
    let receipt_id = text_field(lease_receipt(&first), "receiptID").to_owned();

    let same = ok_body(fixture.send(&request("authorize_use", body.clone())));
    assert_eq!(status(&same), "REPLAY");
    assert_eq!(text_field(replayed_lease(&same), "leaseId"), lease_id);
    assert_eq!(text_field(lease_receipt(&same), "receiptID"), receipt_id);

    for mismatched in [
        use_body(
            &secret_ref,
            PROVIDER,
            "https://api.anthropic.com/v1/messages",
            &operation_digest,
            PURPOSE,
            ("ttlMs", Value::Unsigned(30_000)),
            "idem-replay-use",
        ),
        valid_use_body(&secret_ref, &digest('b'), "idem-replay-use"),
    ] {
        assert_eq!(
            error_code(fixture.send(&request("authorize_use", mismatched))),
            "secret_conflict"
        );
    }

    // The original binding is still the only receipt under that key.
    let still_original = ok_body(fixture.send(&request("authorize_use", body)));
    assert_eq!(
        text_field(replayed_lease(&still_original), "leaseId"),
        lease_id
    );
}

#[test]
fn consumed_and_expired_leases_cannot_be_redeemed() {
    let mut fixture = Fixture::new();
    let secret_ref = fixture.put_secret(PROVIDER, "redeem", "idem-redeem-seed");

    let issued = ok_body(fixture.send(&request(
        "authorize_use",
        valid_use_body(&secret_ref, &digest('a'), "idem-redeem-use"),
    )));
    let lease_id = text_field(issued_lease(&issued), "leaseId").to_owned();
    let receipt_digest =
        text_field(lease_receipt(&issued), "receiptDigest").to_owned();

    let redeemed = ok_body(fixture.send(&request(
        "redeem_use",
        redeem_body(&lease_id, "redeem-once"),
    )));
    let redemption = nested(&redeemed, "redemption");
    assert_eq!(status(&redeemed), "CONSUMED");
    assert_eq!(
        text_field(redemption, "leaseReceiptDigest"),
        receipt_digest
    );
    assert_eq!(
        error_code(fixture.send(&request(
            "redeem_use",
            redeem_body(&lease_id, "redeem-twice"),
        ))),
        "secret_use_consumed"
    );

    // A short-lived lease is redeemable only inside its window.
    let expiring = ok_body(fixture.send(&request(
        "authorize_use",
        use_body(
            &secret_ref,
            PROVIDER,
            DESTINATION,
            &digest('c'),
            PURPOSE,
            ("ttlMs", Value::Unsigned(1)),
            "idem-expiring-use",
        ),
    )));
    let expiring_id = text_field(issued_lease(&expiring), "leaseId").to_owned();
    std::thread::sleep(std::time::Duration::from_millis(10));
    assert_eq!(
        error_code(fixture.send(&request(
            "redeem_use",
            redeem_body(&expiring_id, "redeem-late"),
        ))),
        "expired"
    );

    // Redeeming an unknown lease is not found; malformed identity is rejected.
    assert_eq!(
        error_code(fixture.send(&request(
            "redeem_use",
            redeem_body("secret_lease_unknown", "redeem-unknown"),
        ))),
        "secret_not_found"
    );
    assert_eq!(
        error_code(fixture.send(&request(
            "redeem_use",
            value_map([("leaseId", string(&lease_id))]),
        ))),
        "invalid_effect_request"
    );
}

#[test]
fn use_receipt_and_consumption_survive_host_restart() {
    let mut fixture = Fixture::new();
    let secret_ref = fixture.put_secret(PROVIDER, "restart", "idem-restart-seed");
    let body = valid_use_body(&secret_ref, &digest('a'), "idem-restart-use");
    let issued = ok_body(fixture.send(&request("authorize_use", body.clone())));
    let lease_id = text_field(issued_lease(&issued), "leaseId").to_owned();
    let receipt_id = text_field(lease_receipt(&issued), "receiptID").to_owned();

    fixture.restart();
    let replayed = ok_body(fixture.send(&request("authorize_use", body.clone())));
    assert_eq!(status(&replayed), "REPLAY");
    assert_eq!(text_field(replayed_lease(&replayed), "leaseId"), lease_id);
    assert_eq!(
        text_field(lease_receipt(&replayed), "receiptID"),
        receipt_id
    );

    let consumed = ok_body(fixture.send(&request(
        "redeem_use",
        redeem_body(&lease_id, "redeem-restart"),
    )));
    assert_eq!(status(&consumed), "CONSUMED");
    fixture.restart();
    assert_eq!(
        error_code(fixture.send(&request(
            "redeem_use",
            redeem_body(&lease_id, "redeem-restart-again"),
        ))),
        "secret_use_consumed"
    );
    let after = ok_body(fixture.send(&request("authorize_use", body)));
    assert_eq!(text_field(replayed_lease(&after), "state"), "CONSUMED");
    assert_eq!(
        text_field(lease_receipt(&after), "receiptID"),
        receipt_id
    );
}
