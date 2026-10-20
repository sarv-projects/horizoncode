use horizon_indexd_library::{
    BaseGeneration, FileSnapshot, GenerationPack, GenerationPins, GenerationUploadError,
    GenerationUploadId, GenerationUploadStore, OpaquePin, PackDigest, MAX_UPLOAD_CHUNK_BYTES,
    MAX_UPLOAD_TTL_MS,
};

fn pin(value: &str) -> OpaquePin {
    OpaquePin::new(value.as_bytes().to_vec()).unwrap()
}

fn valid_pack() -> GenerationPack {
    let generation = BaseGeneration::build(
        GenerationPins {
            repository: pin("repo"),
            workspace: Some(pin("workspace")),
            revision_set: pin("revision"),
            read_scope: pin("scope"),
            read_policy: pin("policy"),
            source_receipt: pin("receipt"),
            parser_set: pin("parsers"),
        },
        [FileSnapshot::new(
            "src/lib.rs",
            b"fn sample() {}\n".to_vec(),
        )],
    )
    .unwrap();
    GenerationPack::from_generation(&generation).unwrap()
}

fn id(value: &'static [u8]) -> GenerationUploadId {
    GenerationUploadId::from_host_token(value).unwrap()
}

#[test]
fn upload_id_length_is_checked_at_the_borrowed_boundary() {
    assert!(matches!(
        GenerationUploadId::from_host_token(&[]),
        Err(GenerationUploadError::InvalidUploadId)
    ));
    assert!(matches!(
        GenerationUploadId::from_host_token(&[0; 15]),
        Err(GenerationUploadError::InvalidUploadId)
    ));
    assert!(GenerationUploadId::from_host_token(&[0; 16]).is_ok());
    assert!(GenerationUploadId::from_host_token(&[0; 64]).is_ok());
    assert!(matches!(
        GenerationUploadId::from_host_token(&[0; 65]),
        Err(GenerationUploadError::InvalidUploadId)
    ));
}

#[test]
fn staged_pack_commits_only_after_complete_digest_verified_decode() {
    let pack = valid_pack();
    let digest = PackDigest::of_bytes(pack.as_bytes());
    let mut uploads = GenerationUploadStore::default();
    let upload_id = id(b"host-generated-upload-01");

    uploads
        .begin(upload_id.clone(), pack.len(), digest, 10)
        .unwrap();
    uploads.append(&upload_id, 0, pack.as_bytes(), 11).unwrap();

    let decoded = uploads.commit(&upload_id, 12).unwrap();
    assert_eq!(
        decoded.digest(),
        GenerationPack::decode(pack.as_bytes()).unwrap().digest()
    );
    assert_eq!(uploads.upload_count(), 0);
    assert_eq!(uploads.reserved_bytes(), 0);
}

#[test]
fn upload_rejects_gap_without_advancing_and_accepts_exact_next_offset() {
    let pack = valid_pack();
    let digest = PackDigest::of_bytes(pack.as_bytes());
    let split = pack.len() / 2;
    let mut uploads = GenerationUploadStore::default();
    let upload_id = id(b"host-generated-upload-02");
    uploads
        .begin(upload_id.clone(), pack.len(), digest, 20)
        .unwrap();
    uploads
        .append(&upload_id, 0, &pack.as_bytes()[..split], 21)
        .unwrap();

    assert!(matches!(
        uploads.append(&upload_id, split + 1, &pack.as_bytes()[split..], 22),
        Err(GenerationUploadError::OffsetMismatch { expected, actual }) if expected == split && actual == split + 1
    ));
    uploads
        .append(&upload_id, split, &pack.as_bytes()[split..], 23)
        .unwrap();
    assert!(uploads.commit(&upload_id, 24).is_ok());
}

#[test]
fn upload_rejects_overlapping_duplicate_and_oversized_chunks() {
    let pack = valid_pack();
    let digest = PackDigest::of_bytes(pack.as_bytes());
    let mut uploads = GenerationUploadStore::default();
    let upload_id = id(b"host-generated-upload-03");
    uploads
        .begin(upload_id.clone(), pack.len(), digest, 30)
        .unwrap();
    uploads.append(&upload_id, 0, b"abc", 31).unwrap();

    assert!(matches!(
        uploads.append(&upload_id, 0, b"abc", 32),
        Err(GenerationUploadError::OffsetMismatch { .. })
    ));
    assert!(matches!(
        uploads.append(&upload_id, 2, b"x", 32),
        Err(GenerationUploadError::OffsetMismatch { .. })
    ));
    let oversized = vec![0; MAX_UPLOAD_CHUNK_BYTES + 1];
    assert!(matches!(
        uploads.append(&upload_id, 3, &oversized, 33),
        Err(GenerationUploadError::ChunkTooLarge { .. })
    ));
    uploads.abort(&upload_id).unwrap();
}

#[test]
fn invalid_digest_drops_upload_and_prevents_commit() {
    let pack = valid_pack();
    let wrong_digest = PackDigest::of_bytes(b"different pack");
    let mut uploads = GenerationUploadStore::default();
    let upload_id = id(b"host-generated-upload-04");
    uploads
        .begin(upload_id.clone(), pack.len(), wrong_digest, 40)
        .unwrap();
    uploads.append(&upload_id, 0, pack.as_bytes(), 41).unwrap();

    assert!(matches!(
        uploads.commit(&upload_id, 42),
        Err(GenerationUploadError::DigestMismatch)
    ));
    assert_eq!(uploads.upload_count(), 0);
    assert_eq!(uploads.reserved_bytes(), 0);
}

#[test]
fn expiry_abort_and_restart_release_all_staged_bytes() {
    let pack = valid_pack();
    let digest = PackDigest::of_bytes(pack.as_bytes());
    let mut uploads = GenerationUploadStore::default();
    let expired_id = id(b"host-generated-upload-05");
    let aborted_id = id(b"host-generated-upload-06");
    uploads
        .begin(expired_id.clone(), pack.len(), digest, 100)
        .unwrap();
    uploads
        .begin(aborted_id.clone(), pack.len(), digest, 100)
        .unwrap();
    uploads.append(&aborted_id, 0, b"partial", 101).unwrap();
    uploads.abort(&aborted_id).unwrap();
    assert_eq!(uploads.reserved_bytes(), pack.len());

    assert!(matches!(
        uploads.append(&expired_id, 0, b"x", 100 + MAX_UPLOAD_TTL_MS + 1),
        Err(GenerationUploadError::Expired)
    ));
    let sweep_id = id(b"host-generated-upload-10");
    uploads
        .begin(sweep_id, pack.len(), digest, 100 + MAX_UPLOAD_TTL_MS + 2)
        .unwrap();
    assert_eq!(uploads.expire(100 + 2 * MAX_UPLOAD_TTL_MS + 2), 1);
    assert_eq!(uploads.reserved_bytes(), 0);
    assert_eq!(uploads.upload_count(), 0);

    let restart_id = id(b"host-generated-upload-07");
    uploads
        .begin(restart_id.clone(), pack.len(), digest, 200)
        .unwrap();
    uploads.append(&restart_id, 0, b"partial", 201).unwrap();
    uploads.clear_for_restart();
    assert_eq!(uploads.upload_count(), 0);
    assert_eq!(uploads.reserved_bytes(), 0);
}

#[test]
fn declared_total_and_duplicate_upload_handles_are_bounded() {
    let pack = valid_pack();
    let digest = PackDigest::of_bytes(pack.as_bytes());
    let mut uploads = GenerationUploadStore::default();
    let upload_id = id(b"host-generated-upload-08");
    uploads
        .begin(upload_id.clone(), pack.len(), digest, 300)
        .unwrap();
    assert!(matches!(
        uploads.begin(upload_id, pack.len(), digest, 301),
        Err(GenerationUploadError::DuplicateUpload)
    ));
    assert!(matches!(
        uploads.begin(
            id(b"host-generated-upload-09"),
            horizon_indexd_library::DEFAULT_MAX_PACK_BYTES + 1,
            digest,
            302
        ),
        Err(GenerationUploadError::TotalTooLarge { .. })
    ));
}

#[test]
fn upload_slots_and_aggregate_declared_bytes_are_bounded_without_preallocation() {
    let digest = PackDigest::of_bytes(b"pack");
    let mut uploads = GenerationUploadStore::default();
    let full_budget_id = id(b"host-generated-upload-11");
    uploads
        .begin(
            full_budget_id,
            horizon_indexd_library::MAX_STAGED_BYTES,
            digest,
            400,
        )
        .unwrap();
    assert_eq!(
        uploads.reserved_bytes(),
        horizon_indexd_library::MAX_STAGED_BYTES
    );
    assert!(matches!(
        uploads.begin(id(b"host-generated-upload-12"), 1, digest, 401),
        Err(GenerationUploadError::StagingBudgetExceeded { .. })
    ));

    uploads.clear_for_restart();
    uploads
        .begin(id(b"host-generated-upload-13"), 1, digest, 500)
        .unwrap();
    uploads
        .begin(id(b"host-generated-upload-14"), 1, digest, 500)
        .unwrap();
    assert!(matches!(
        uploads.begin(id(b"host-generated-upload-15"), 1, digest, 500),
        Err(GenerationUploadError::TooManyUploads { .. })
    ));
}

#[test]
fn incomplete_and_malformed_pack_commits_never_return_a_generation() {
    let bytes = vec![0; 64];
    let digest = PackDigest::of_bytes(&bytes);
    let mut uploads = GenerationUploadStore::default();
    let incomplete_id = id(b"host-generated-upload-16");
    uploads
        .begin(incomplete_id.clone(), bytes.len(), digest, 600)
        .unwrap();
    uploads
        .append(&incomplete_id, 0, &bytes[..16], 601)
        .unwrap();
    assert!(matches!(
        uploads.commit(&incomplete_id, 602),
        Err(GenerationUploadError::Incomplete {
            expected: 64,
            actual: 16
        })
    ));
    uploads
        .append(&incomplete_id, 16, &bytes[16..], 603)
        .unwrap();
    assert!(matches!(
        uploads.commit(&incomplete_id, 604),
        Err(GenerationUploadError::InvalidPack(_))
    ));
    assert_eq!(uploads.upload_count(), 0);
    assert_eq!(uploads.reserved_bytes(), 0);
}
