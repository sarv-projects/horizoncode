//! The artifact store's contract: bounded streaming, content addressing,
//! idempotent operations, verified reads, and typed refusals.

use horizoncode_artifact::{
    ArtifactError, ArtifactStore, BlobRef, NamespaceId, PutOutcome, REFERENCE_SCHEMA_VERSION,
};
use horizoncode_config::ArtifactLimits;

fn limits(max_object_bytes: u64, namespace_bytes: u64) -> ArtifactLimits {
    ArtifactLimits {
        max_inline_event_bytes: 65_536,
        max_object_bytes,
        namespace_bytes,
        max_decoded_bytes: 268_435_456,
        max_decoded_pixels: 16_777_216,
        max_expansion_ratio: 128,
        decode_timeout_ms: 5_000,
        retention_days: 30,
        orphan_grace_hours: 24,
    }
}

fn store(dir: &tempfile::TempDir, max_object: u64, namespace: u64) -> ArtifactStore {
    ArtifactStore::open(dir.path().join("artifacts"), limits(max_object, namespace)).unwrap()
}

fn put(store: &ArtifactStore, ns: &NamespaceId, op: &str, bytes: &[u8]) -> PutOutcome {
    let mut reader = std::io::Cursor::new(bytes.to_vec());
    store.put(ns, op, "text/plain", &mut reader).unwrap()
}

#[test]
fn a_round_trip_publishes_verifies_and_lists() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir, 1024, 4096);
    let ns = NamespaceId::session("ses_1");
    let PutOutcome::Published(reference) = put(&store, &ns, "op-1", b"hello artifact") else {
        panic!("expected a publication");
    };
    assert_eq!(reference.encoded_bytes, 14);
    assert_eq!(reference.schema_version, REFERENCE_SCHEMA_VERSION);
    assert_eq!(reference.digest.len(), 64);

    let bytes = store.read(&ns, &reference, 1024).unwrap();
    assert_eq!(bytes, b"hello artifact");
    let stat = store.stat(&ns, &reference).unwrap();
    assert_eq!(stat.stored_bytes, 14);
    assert_eq!(
        store.list(&ns).unwrap(),
        vec![(reference.digest.clone(), 14)]
    );
    assert_eq!(store.committed_bytes(&ns).unwrap(), 14);
}

#[test]
fn a_payload_above_the_object_ceiling_is_refused_unpublished() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir, 16, 4096);
    let ns = NamespaceId::session("ses_1");
    let mut reader = std::io::Cursor::new(vec![7u8; 64]);
    let error = store
        .put(&ns, "op-big", "text/plain", &mut reader)
        .unwrap_err();
    assert!(
        matches!(error, ArtifactError::ObjectTooLarge { limit: 16 }),
        "{error}"
    );
    assert!(store.list(&ns).unwrap().is_empty(), "nothing is published");
    assert_eq!(store.committed_bytes(&ns).unwrap(), 0);
}

#[test]
fn the_namespace_ceiling_refuses_before_publishing_and_keeps_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir, 1024, 20);
    let ns = NamespaceId::session("ses_1");
    put(&store, &ns, "op-1", &[1u8; 12]);
    let mut reader = std::io::Cursor::new(vec![2u8; 12]);
    let error = store
        .put(&ns, "op-2", "text/plain", &mut reader)
        .unwrap_err();
    assert!(
        matches!(
            error,
            ArtifactError::NamespaceFull {
                committed: 12,
                limit: 20,
                ..
            }
        ),
        "{error}"
    );
    assert_eq!(store.list(&ns).unwrap().len(), 1);
    assert_eq!(store.committed_bytes(&ns).unwrap(), 12);
}

#[test]
fn writes_are_idempotent_by_operation_and_conflict_on_different_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir, 1024, 4096);
    let ns = NamespaceId::run("run_1");
    let PutOutcome::Published(first) = put(&store, &ns, "op-1", b"same bytes") else {
        panic!("published");
    };
    let PutOutcome::AlreadyPublished(second) = put(&store, &ns, "op-1", b"same bytes") else {
        panic!("idempotent repeat");
    };
    assert_eq!(
        first.blob_id, second.blob_id,
        "the original reference is returned"
    );
    assert_eq!(store.committed_bytes(&ns).unwrap(), 10);

    let mut reader = std::io::Cursor::new(b"different".to_vec());
    let error = store
        .put(&ns, "op-1", "text/plain", &mut reader)
        .unwrap_err();
    assert!(
        matches!(error, ArtifactError::OperationConflict { .. }),
        "{error}"
    );
}

#[test]
fn a_tampered_object_is_reported_corrupt_not_returned() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir, 1024, 4096);
    let ns = NamespaceId::session("ses_1");
    let PutOutcome::Published(reference) = put(&store, &ns, "op-1", b"original bytes") else {
        panic!("published");
    };
    let object = dir
        .path()
        .join("artifacts/session/ses_1/blobs/blake3")
        .join(&reference.digest);
    std::fs::write(&object, b"tampered bytes").unwrap();
    let error = store.read(&ns, &reference, 1024).unwrap_err();
    assert!(matches!(error, ArtifactError::Corrupt { .. }), "{error}");
}

#[test]
fn missing_unsupported_and_over_limit_reads_are_typed() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir, 1024, 4096);
    let ns = NamespaceId::session("ses_1");
    let PutOutcome::Published(reference) = put(&store, &ns, "op-1", b"payload") else {
        panic!("published");
    };
    let mut missing = reference.clone();
    missing.digest = "0".repeat(64);
    assert!(matches!(
        store.read(&ns, &missing, 1024),
        Err(ArtifactError::Missing { .. })
    ));

    let mut newer = reference.clone();
    newer.schema_version = REFERENCE_SCHEMA_VERSION + 1;
    assert!(matches!(
        store.read(&ns, &newer, 1024),
        Err(ArtifactError::UnsupportedSchema { .. })
    ));

    assert!(matches!(
        store.read(&ns, &reference, 3),
        Err(ArtifactError::ReadTooLarge { bytes: 7, limit: 3 })
    ));
}

#[test]
fn the_ledger_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let ns = NamespaceId::session("ses_1");
    {
        let store = store(&dir, 1024, 4096);
        put(&store, &ns, "op-1", &[9u8; 100]);
    }
    let store = store(&dir, 1024, 200);
    assert_eq!(store.committed_bytes(&ns).unwrap(), 100, "quota is durable");
    let mut reader = std::io::Cursor::new(vec![9u8; 150]);
    let error = store
        .put(&ns, "op-2", "text/plain", &mut reader)
        .unwrap_err();
    assert!(
        matches!(error, ArtifactError::NamespaceFull { committed: 100, .. }),
        "{error}"
    );
}

#[cfg(unix)]
#[test]
fn state_is_owner_only_and_symlinks_are_refused() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir, 1024, 4096);
    let ns = NamespaceId::session("ses_1");
    let PutOutcome::Published(reference) = put(&store, &ns, "op-1", b"bytes") else {
        panic!("published");
    };
    let base = dir.path().join("artifacts/session/ses_1");
    let object = base.join("blobs/blake3").join(&reference.digest);
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir.path().join("artifacts")), 0o700);
    assert_eq!(mode(&base.join("blobs/blake3")), 0o700);
    assert_eq!(mode(&object), 0o600);
    assert_eq!(mode(&base.join("quota.json")), 0o600);

    // A link planted at the object path must not be read through.
    let victim = dir.path().join("victim");
    std::fs::write(&victim, b"host bytes").unwrap();
    std::fs::remove_file(&object).unwrap();
    std::os::unix::fs::symlink(&victim, &object).unwrap();
    let error = store.read(&ns, &reference, 1024).unwrap_err();
    assert!(matches!(error, ArtifactError::UnsafePath { .. }), "{error}");
}

#[test]
fn a_blob_reference_round_trips_through_json() {
    let reference = BlobRef {
        blob_id: "blob_1".to_owned(),
        digest: "a".repeat(64),
        media_type: "image/png".to_owned(),
        encoded_bytes: 42,
        schema_version: REFERENCE_SCHEMA_VERSION,
    };
    let text = serde_json::to_string(&reference).unwrap();
    let decoded: BlobRef = serde_json::from_str(&text).unwrap();
    assert_eq!(decoded, reference);
}
