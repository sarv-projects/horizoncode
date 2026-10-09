use horizoncode_kernel::owner_log::{
    Digest, DurabilityProfile, OwnerEventInput, OwnerHeadV2, OwnerIdentity, OwnerLogV2,
    PhysicalRecordV2, SegmentSealV2,
};

const ZERO_DIGEST: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const EXPECTED_EVENT_DIGEST: &str =
    "fdcdc963ab56868451dbef5f7b638824f627e4f934e4f7b2f6c1e9fc17f1985a";

fn sample_record() -> PhysicalRecordV2 {
    let data =
        serde_json::from_str(r#"{"z":[3,2,1],"schemaVersion":1,"payload":{"z":"é","a":"value"}}"#)
            .unwrap();
    PhysicalRecordV2::new(
        7,
        1_700_000_000_123,
        "thread.created".to_owned(),
        data,
        Digest::parse_hex(ZERO_DIGEST).unwrap(),
    )
    .unwrap()
}

fn sample_head(record: &PhysicalRecordV2) -> OwnerHeadV2 {
    let owner = OwnerIdentity::new("thread".to_owned(), "thr_1".to_owned()).unwrap();
    OwnerHeadV2::new(
        &owner,
        1,
        1,
        DurabilityProfile::InteractiveOnly,
        record.seq,
        record.event_digest,
        1,
        316,
    )
    .unwrap()
}

#[test]
fn record_bytes_match_the_shared_v2_fixture() {
    let encoded = OwnerLogV2::encode_record(&sample_record()).unwrap();
    assert_eq!(
        encoded,
        include_bytes!("fixtures/owner-log-v2/record-v2.jsonl")
    );
}

#[test]
fn event_digest_matches_the_shared_v2_golden_value() {
    let record = sample_record();
    assert_eq!(
        OwnerLogV2::event_digest(&record).unwrap().to_hex(),
        EXPECTED_EVENT_DIGEST
    );
}

#[test]
fn digest_wrapper_matches_the_blake3_published_empty_input_vector() {
    assert_eq!(
        Digest::from_blake3(b"").to_hex(),
        "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
    );
}

#[test]
fn owner_path_key_uses_length_prefixed_utf8_not_path_text() {
    let owner = OwnerIdentity::new("thread".to_owned(), "../thr-é".to_owned()).unwrap();
    assert_eq!(
        owner.directory_key(),
        "b7173f2e0743e0b5ce75103ce52a6421861ad5e025b1a6347191d52f3cfc83f8"
    );
}

#[test]
fn rejects_malformed_digest_owner_and_unrepresentable_numeric_data() {
    assert!(Digest::parse_hex(&"a".repeat(64).to_uppercase()).is_err());
    assert!(Digest::parse_hex("abcd").is_err());
    assert!(OwnerIdentity::new(String::new(), "id".to_owned()).is_err());
    assert!(OwnerIdentity::new("thread".to_owned(), "é".repeat(129)).is_err());

    let unsafe_integer = serde_json::json!({"count": 9_007_199_254_740_992_u64});
    assert!(
        PhysicalRecordV2::new(
            7,
            1_700_000_000_123,
            "thread.created".to_owned(),
            unsafe_integer,
            Digest::parse_hex(ZERO_DIGEST).unwrap(),
        )
        .is_err()
    );
}

#[test]
fn rejects_non_object_and_oversized_event_data() {
    assert!(
        PhysicalRecordV2::new(
            1,
            1,
            "thread.created".to_owned(),
            serde_json::json!(["not", "an", "object"]),
            Digest::parse_hex(ZERO_DIGEST).unwrap(),
        )
        .is_err()
    );

    let oversized = serde_json::json!({"payload": "x".repeat(1_048_577)});
    assert!(
        PhysicalRecordV2::new(
            1,
            1,
            "thread.created".to_owned(),
            oversized,
            Digest::parse_hex(ZERO_DIGEST).unwrap(),
        )
        .is_err()
    );
}

#[test]
fn json_value_limits_bound_depth_nodes_and_escaped_record_bytes() {
    let mut deeply_nested = serde_json::json!(null);
    for _ in 0..65 {
        deeply_nested = serde_json::json!([deeply_nested]);
    }
    assert!(
        PhysicalRecordV2::new(
            1,
            1,
            "thread.created".to_owned(),
            serde_json::json!({"payload": deeply_nested}),
            Digest::ZERO,
        )
        .is_err()
    );

    let many_nodes = serde_json::json!({"items": vec![0; 32_768]});
    assert!(
        PhysicalRecordV2::new(1, 1, "thread.created".to_owned(), many_nodes, Digest::ZERO,)
            .is_err()
    );

    let escaped = serde_json::json!({"payload": "\0".repeat(200_000)});
    assert!(
        PhysicalRecordV2::new(1, 1, "thread.created".to_owned(), escaped, Digest::ZERO,).is_err()
    );
}

#[test]
fn head_encoding_has_fixed_field_order_and_a_verified_head_digest() {
    let record = sample_record();
    let head = sample_head(&record);
    let encoded = OwnerLogV2::encode_head(&head).unwrap();
    assert_eq!(
        std::str::from_utf8(&encoded).unwrap(),
        "{\"format_version\":2,\"owner_kind\":\"thread\",\"owner_id\":\"thr_1\",\"schema_version\":1,\"generation\":1,\"durability_profile\":\"interactive_only\",\"committed_seq\":7,\"committed_event_digest\":\"fdcdc963ab56868451dbef5f7b638824f627e4f934e4f7b2f6c1e9fc17f1985a\",\"active_segment_id\":1,\"committed_offset\":316,\"head_digest\":\"aa9e7801f610411f7dbcca77f1d1e7ba886d5324ffa174f77659bc9d2cf48af6\"}\n"
    );
    assert_eq!(OwnerLogV2::head_digest(&head).unwrap(), head.head_digest);

    let mut corrupted = head;
    corrupted.committed_seq += 1;
    assert!(OwnerLogV2::encode_head(&corrupted).is_err());

    let owner = OwnerIdentity::new("thread".to_owned(), "thr_empty".to_owned()).unwrap();
    assert!(
        OwnerHeadV2::new(
            &owner,
            1,
            1,
            DurabilityProfile::InteractiveOnly,
            0,
            Digest::ZERO,
            1,
            1,
        )
        .is_err()
    );
}

#[test]
fn segment_seal_binds_the_exact_committed_prefix_bytes() {
    let record = sample_record();
    let bytes = OwnerLogV2::encode_record(&record).unwrap();
    let seal = SegmentSealV2::new(
        1,
        bytes.len() as u64,
        record.seq,
        record.seq,
        1,
        record.event_digest,
        &bytes,
    )
    .unwrap();
    assert_eq!(
        seal.segment_digest().to_hex(),
        "367b26a8c8454fbf2935ecb60f54755015b40f7fedbb95ff4d53250a940aacdd"
    );
    assert_eq!(
        std::str::from_utf8(&OwnerLogV2::encode_seal(&seal).unwrap()).unwrap(),
        "{\"format_version\":2,\"segment_id\":1,\"committed_offset\":316,\"first_seq\":7,\"last_seq\":7,\"record_count\":1,\"last_event_digest\":\"fdcdc963ab56868451dbef5f7b638824f627e4f934e4f7b2f6c1e9fc17f1985a\",\"segment_digest\":\"367b26a8c8454fbf2935ecb60f54755015b40f7fedbb95ff4d53250a940aacdd\"}\n"
    );
    assert!(
        SegmentSealV2::new(
            1,
            bytes.len() as u64 + 1,
            record.seq,
            record.seq,
            1,
            record.event_digest,
            &bytes,
        )
        .is_err()
    );
}

#[test]
fn event_input_commits_delivery_and_schema_metadata_with_the_payload() {
    let input = OwnerEventInput {
        schema_version: 1,
        time_ms: 1_700_000_000_123,
        kind: "thread.created".to_owned(),
        data: serde_json::json!({"threadId": "thr_1"}),
        delivery_id: Some("delivery-1".to_owned()),
        command_digest: Some(format!("blake3:{}", "a".repeat(64))),
    };
    let data = input.physical_data().unwrap();
    assert_eq!(
        data,
        serde_json::json!({
            "commandDigest": format!("blake3:{}", "a".repeat(64)),
            "deliveryId": "delivery-1",
            "payload": {"threadId": "thr_1"},
            "schemaVersion": 1,
        })
    );

    let mut partial_delivery = input;
    partial_delivery.command_digest = None;
    assert!(partial_delivery.physical_data().is_err());
}

#[test]
fn record_encoder_refuses_a_changed_format_or_digest() {
    let mut record = sample_record();
    record.event_digest = Digest::ZERO;
    assert!(OwnerLogV2::encode_record(&record).is_err());

    let mut record = sample_record();
    record.format_version = 1;
    assert!(OwnerLogV2::encode_record(&record).is_err());
}
