use horizon_indexd_library::{
    BaseGeneration, FileSnapshot, GenerationPack, GenerationPins, IndexError, OpaquePin,
    SearchTruncation, DEFAULT_MAX_PACK_BYTES,
};

fn pin(value: &str) -> OpaquePin {
    OpaquePin::new(value.as_bytes().to_vec()).unwrap()
}

fn pins(workspace: Option<&str>, revision: &str) -> GenerationPins {
    GenerationPins {
        repository: pin("repo-1"),
        workspace: workspace.map(pin),
        revision_set: pin(revision),
        read_scope: pin("read-scope-1"),
        read_policy: pin("read-policy-1"),
        source_receipt: pin("receipt-1"),
        parser_set: pin("parser-set-1"),
    }
}

fn snapshot(path: &str, contents: &str) -> FileSnapshot {
    FileSnapshot::new(path, contents.as_bytes().to_vec())
}

fn generation(inputs: Vec<FileSnapshot>) -> BaseGeneration {
    BaseGeneration::build(pins(Some("workspace-1"), "rev-1"), inputs).unwrap()
}

#[test]
fn round_trip_preserves_generation_identity_pins_and_content() {
    let original = generation(vec![
        snapshot("src/empty.txt", ""),
        snapshot("src/ünïcode.txt", "héllo wörld\n"),
        snapshot("src/z.txt", "needle\n"),
        snapshot("a.txt", "plain\n"),
    ]);

    let pack = GenerationPack::from_generation(&original).unwrap();
    let decoded = GenerationPack::decode(pack.as_bytes()).unwrap();

    assert_eq!(decoded.digest(), original.digest());
    assert_eq!(decoded.pins(), original.pins());
    assert_eq!(decoded.file_count(), original.file_count());
    assert_eq!(decoded.content_bytes(), original.content_bytes());
    assert_eq!(
        decoded.search("héllo", 10).unwrap().matches,
        original.search("héllo", 10).unwrap().matches
    );
    assert_eq!(
        decoded.search("needle", 10).unwrap().matches.len(),
        1,
        "decoded generation must answer lexical queries identically"
    );
}

#[test]
fn encoding_is_deterministic_and_input_order_independent() {
    let ordered = generation(vec![snapshot("a.txt", "a\n"), snapshot("b.txt", "b\n")]);
    let reversed = generation(vec![snapshot("b.txt", "b\n"), snapshot("a.txt", "a\n")]);

    let first = GenerationPack::from_generation(&ordered).unwrap();
    let second = GenerationPack::from_generation(&ordered).unwrap();
    let third = GenerationPack::from_generation(&reversed).unwrap();

    assert_eq!(first.as_bytes(), second.as_bytes());
    assert_eq!(first.as_bytes(), third.as_bytes());
    assert_eq!(first, third);
}

#[test]
fn empty_generation_round_trips() {
    let original = generation(Vec::new());
    let pack = GenerationPack::from_generation(&original).unwrap();
    let decoded = GenerationPack::decode(pack.as_bytes()).unwrap();
    assert_eq!(decoded.digest(), original.digest());
    assert_eq!(decoded.file_count(), 0);
}

#[test]
fn any_single_byte_flip_is_rejected_by_the_checksum() {
    let original = generation(vec![
        snapshot("a.txt", "needle\n"),
        snapshot("b.txt", "other\n"),
    ]);
    let pack = GenerationPack::from_generation(&original).unwrap();

    for position in 0..pack.len() {
        let mut tampered = pack.as_bytes().to_vec();
        tampered[position] ^= 0x20;
        assert!(
            matches!(
                GenerationPack::decode(&tampered),
                Err(IndexError::PackChecksumMismatch)
            ),
            "flip at byte {position} must be rejected"
        );
    }
}

#[test]
fn truncation_at_every_boundary_is_rejected() {
    let original = generation(vec![snapshot("a.txt", "needle\n")]);
    let pack = GenerationPack::from_generation(&original).unwrap();

    for length in 0..pack.len() {
        assert!(
            GenerationPack::decode(&pack.as_bytes()[..length]).is_err(),
            "truncation to {length} bytes must be rejected"
        );
    }
}

#[test]
fn trailing_bytes_are_rejected() {
    let original = generation(vec![snapshot("a.txt", "needle\n")]);
    let pack = GenerationPack::from_generation(&original).unwrap();
    let mut extended = pack.as_bytes().to_vec();
    extended.push(0);
    assert!(GenerationPack::decode(&extended).is_err());
}

#[test]
fn caller_limit_is_clamped_to_the_hard_bound() {
    let original = generation(vec![snapshot("a.txt", "needle\n")]);
    let pack = GenerationPack::from_generation(&original).unwrap();

    assert!(matches!(
        GenerationPack::decode_with_limit(pack.as_bytes(), 16),
        Err(IndexError::PackTooLarge { limit: 16 })
    ));
    assert!(pack.len() <= DEFAULT_MAX_PACK_BYTES);
    let decoded = GenerationPack::decode_with_limit(pack.as_bytes(), usize::MAX).unwrap();
    assert_eq!(decoded.digest(), original.digest());
}

#[test]
fn pagination_cursor_survives_a_persistence_round_trip() {
    let original = generation(vec![snapshot("a.txt", "needle\nneedle\nneedle\n")]);
    let first = original.search("needle", 1).unwrap();
    assert_eq!(first.truncated_by, Some(SearchTruncation::ResultLimit));
    let cursor = first.next_cursor.unwrap();

    let pack = GenerationPack::from_generation(&original).unwrap();
    let decoded = GenerationPack::decode(pack.as_bytes()).unwrap();
    let second = decoded.search_page("needle", 1, Some(&cursor)).unwrap();

    assert_eq!(second.matches.len(), 1);
    assert_eq!(second.matches[0].start_line, 2);
    assert_eq!(second.generation_digest, original.digest());
}
