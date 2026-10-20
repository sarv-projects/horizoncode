use horizon_indexd_library::{
    BufferOverlay, FileSnapshot, GenerationPins, OpaquePin, RepoIntelGeneration, RepoStructureCompletenessV1,
    RepoStructureError, RepoStructureFallbackReasonV1, RepoStructureFreshnessV1,
    RepoStructureProvenanceV1, RepoStructureQueryV1, RepoStructureSelectorV1,
    RepoStructureSourceKindV1, RepoStructureStatusV1,
};

fn pin(value: &str) -> OpaquePin {
    OpaquePin::new(value.as_bytes().to_vec()).unwrap()
}

fn generation() -> RepoIntelGeneration {
    RepoIntelGeneration::build(
        GenerationPins {
            repository: pin("repo"),
            workspace: Some(pin("workspace")),
            revision_set: pin("revision-set"),
            read_scope: pin("read-scope"),
            read_policy: pin("read-policy"),
            source_receipt: pin("receipt"),
            parser_set: pin("lexical-v1"),
        },
        [FileSnapshot::new("src/main.rs", b"fn main() {}\n".to_vec())],
    )
    .unwrap()
}

fn provenance() -> RepoStructureProvenanceV1 {
    RepoStructureProvenanceV1 {
        workspace_binding: "workspace-binding-1".to_owned(),
        source_revision: "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            .to_owned(),
    }
}

fn query(generation: &RepoIntelGeneration) -> RepoStructureQueryV1 {
    RepoStructureQueryV1 {
        schema_version: 1,
        message_type: "query".to_owned(),
        query_id: "query-1".to_owned(),
        root_ref: ".".to_owned(),
        source_generation: generation.id().to_string(),
        overlay_ref: None,
        selector: RepoStructureSelectorV1 {
            symbols: vec!["main".to_owned()],
            node_refs: Vec::new(),
            include_callers: false,
        },
        cursor: None,
        max_nodes: 20,
        max_bytes: 32_768,
        max_depth: 8,
        deadline: "2026-10-19T12:30:45.123Z".to_owned(),
    }
}

fn main_file_digest() -> String {
    let contents = b"fn main() {}\n";
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizon.indexd.file-content.v1\0");
    hasher.update(&(contents.len() as u64).to_be_bytes());
    hasher.update(contents);
    format!("blake3:{}", hasher.finalize().to_hex())
}

#[test]
fn unsupported_structure_query_returns_an_explicit_bounded_unavailable_page() {
    let generation = generation();
    let page = generation
        .query_structure(&query(&generation), &provenance(), None)
        .expect("valid query returns an unavailable page, not guessed structure");

    assert_eq!(page.schema_version, 1);
    assert_eq!(page.message_type, "page");
    assert_eq!(page.query_id, "query-1");
    assert_eq!(page.source_generation, generation.id().to_string());
    assert_eq!(page.workspace_binding, "workspace-binding-1");
    assert_eq!(page.source_kind, RepoStructureSourceKindV1::None);
    assert_eq!(page.status, RepoStructureStatusV1::Unavailable);
    assert_eq!(page.freshness, RepoStructureFreshnessV1::Unknown);
    assert_eq!(page.completeness, RepoStructureCompletenessV1::Unavailable);
    assert_eq!(page.coverage.files, 0);
    assert_eq!(page.coverage.nodes, 0);
    assert!(page.nodes.is_empty());
    assert_eq!(page.next_cursor, None);
    let fallback = page.fallback.unwrap();
    assert_eq!(
        fallback.reason,
        RepoStructureFallbackReasonV1::ParserUnsupported
    );
    assert_eq!(fallback.source_kind, RepoStructureSourceKindV1::None);
}

#[test]
fn stale_generation_is_rejected_and_never_relabelled_as_current() {
    let generation = generation();
    let mut stale = query(&generation);
    stale.source_generation =
        "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();

    assert!(matches!(
        generation.query_structure(&stale, &provenance(), None),
        Err(RepoStructureError::GenerationMismatch { .. })
    ));
}

#[test]
fn malformed_scope_selectors_bounds_and_host_provenance_fail_closed() {
    let generation = generation();
    let valid = query(&generation);

    let mut traversal = valid.clone();
    traversal.root_ref = "../outside".to_owned();
    assert!(matches!(
        generation.query_structure(&traversal, &provenance(), None),
        Err(RepoStructureError::InvalidQuery(_))
    ));

    let mut empty_selector = valid.clone();
    empty_selector.selector = RepoStructureSelectorV1::default();
    assert!(matches!(
        generation.query_structure(&empty_selector, &provenance(), None),
        Err(RepoStructureError::InvalidQuery(_))
    ));

    let mut oversized = valid.clone();
    oversized.max_nodes = horizon_indexd_library::MAX_STRUCTURE_NODES + 1;
    assert!(matches!(
        generation.query_structure(&oversized, &provenance(), None),
        Err(RepoStructureError::InvalidQuery(_))
    ));

    let mut bad_provenance = provenance();
    bad_provenance.source_revision = "caller-value".to_owned();
    assert!(matches!(
        generation.query_structure(&valid, &bad_provenance, None),
        Err(RepoStructureError::InvalidProvenance(_))
    ));
}

#[test]
fn node_reference_selector_is_bound_to_workspace_generation_revision_and_range() {
    let generation = generation();
    let mut scoped = query(&generation);
    scoped.selector.symbols.clear();
    scoped
        .selector
        .node_refs
        .push(horizon_indexd_library::RepoNodeRefV1 {
            workspace_binding: "workspace-binding-1".to_owned(),
            source_generation: generation.id().to_string(),
            source_revision: provenance().source_revision,
            overlay_digest: None,
            path_ref: "src/main.rs".to_owned(),
            file_digest: main_file_digest(),
            node_id: "node-main".to_owned(),
            node_kind: "function".to_owned(),
            symbol: "main".to_owned(),
            byte_range: horizon_indexd_library::StructureByteRangeV1 { start: 3, end: 7 },
            parser_id: "tree-sitter-rust".to_owned(),
            parser_version: "1".to_owned(),
        });

    // A structurally unsupported parser still returns honest UNAVAILABLE for a
    // correctly scoped reference. These caller-held refs never authorize access.
    assert!(generation.query_structure(&scoped, &provenance(), None).is_ok());

    let mut foreign_generation = scoped.clone();
    foreign_generation.selector.node_refs[0].source_generation =
        "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned();
    assert!(matches!(
        generation.query_structure(&foreign_generation, &provenance(), None),
        Err(RepoStructureError::InvalidQuery(_))
    ));

    let mut foreign_workspace = scoped.clone();
    foreign_workspace.selector.node_refs[0].workspace_binding = "other-workspace".to_owned();
    assert!(matches!(
        generation.query_structure(&foreign_workspace, &provenance(), None),
        Err(RepoStructureError::InvalidQuery(_))
    ));

    let mut foreign_revision = scoped.clone();
    foreign_revision.selector.node_refs[0].source_revision =
        "blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned();
    assert!(matches!(
        generation.query_structure(&foreign_revision, &provenance(), None),
        Err(RepoStructureError::InvalidQuery(_))
    ));

    let mut outside_root = scoped.clone();
    outside_root.root_ref = "src".to_owned();
    outside_root.selector.node_refs[0].path_ref = "tests/main.rs".to_owned();
    assert!(matches!(
        generation.query_structure(&outside_root, &provenance(), None),
        Err(RepoStructureError::InvalidQuery(_))
    ));

    let mut invalid_range = scoped;
    invalid_range.selector.node_refs[0].byte_range.end = 2;
    assert!(matches!(
        generation.query_structure(&invalid_range, &provenance(), None),
        Err(RepoStructureError::InvalidQuery(_))
    ));

    let mut wrong_file_digest = query(&generation);
    wrong_file_digest
        .selector
        .node_refs
        .push(horizon_indexd_library::RepoNodeRefV1 {
            workspace_binding: "workspace-binding-1".to_owned(),
            source_generation: generation.id().to_string(),
            source_revision: provenance().source_revision,
            overlay_digest: None,
            path_ref: "src/main.rs".to_owned(),
            file_digest: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_owned(),
            node_id: "node-main".to_owned(),
            node_kind: "function".to_owned(),
            symbol: "main".to_owned(),
            byte_range: horizon_indexd_library::StructureByteRangeV1 { start: 3, end: 7 },
            parser_id: "tree-sitter-rust".to_owned(),
            parser_version: "1".to_owned(),
        });
    assert!(matches!(
        generation.query_structure(&wrong_file_digest, &provenance(), None),
        Err(RepoStructureError::InvalidQuery(_))
    ));
}

#[test]
fn overlay_query_requires_host_resolved_overlay_and_preserves_owner_isolated_digest() {
    let generation = generation();
    let first = BufferOverlay::build(
        generation.base(),
        pin("owner-a/session-a/location-a"),
        [FileSnapshot::new("src/main.rs", b"fn first() {}\n".to_vec())],
    )
    .unwrap();
    let second = BufferOverlay::build(
        generation.base(),
        pin("owner-b/session-b/location-b"),
        [FileSnapshot::new("src/main.rs", b"fn second() {}\n".to_vec())],
    )
    .unwrap();
    let mut first_query = query(&generation);
    first_query.overlay_ref = Some("ovl_0123456789abcdef".to_owned());

    let base_page = generation
        .query_structure(&query(&generation), &provenance(), None)
        .unwrap();
    assert_eq!(base_page.status, RepoStructureStatusV1::Unavailable);
    assert_eq!(base_page.overlay_digest, None);

    assert!(matches!(
        generation.query_structure(&first_query, &provenance(), None),
        Err(RepoStructureError::OverlayMismatch)
    ));
    let foreign_generation = RepoIntelGeneration::build(
        GenerationPins {
            repository: pin("repo-foreign"),
            workspace: Some(pin("workspace-foreign")),
            revision_set: pin("revision-set-foreign"),
            read_scope: pin("read-scope-foreign"),
            read_policy: pin("read-policy-foreign"),
            source_receipt: pin("receipt-foreign"),
            parser_set: pin("lexical-v1"),
        },
        [FileSnapshot::new("src/main.rs", b"fn main() {}\n".to_vec())],
    )
    .unwrap();
    let foreign_overlay = BufferOverlay::build(
        foreign_generation.base(),
        pin("owner-foreign/session-foreign/location-foreign"),
        [FileSnapshot::new("src/main.rs", b"fn foreign() {}\n".to_vec())],
    )
    .unwrap();
    assert!(matches!(
        generation.query_structure(&first_query, &provenance(), Some(&foreign_overlay)),
        Err(RepoStructureError::OverlayMismatch)
    ));
    let first_page = generation
        .query_structure(&first_query, &provenance(), Some(&first))
        .unwrap();
    let mut second_query = first_query.clone();
    second_query.overlay_ref = Some("ovl_abcdef0123456789".to_owned());
    let second_page = generation
        .query_structure(&second_query, &provenance(), Some(&second))
        .unwrap();
    assert_eq!(first_page.status, RepoStructureStatusV1::Unavailable);
    assert!(first_page.nodes.is_empty());
    assert_eq!(
        first_page.overlay_digest,
        Some(first.digest().to_string())
    );
    assert_eq!(
        second_page.overlay_digest,
        Some(second.digest().to_string())
    );
    assert_ne!(first_page.overlay_digest, second_page.overlay_digest);

    let mut invalid_ref = first_query.clone();
    invalid_ref.overlay_ref = Some("../../foreign".to_owned());
    assert!(matches!(
        generation.query_structure(&invalid_ref, &provenance(), Some(&first)),
        Err(RepoStructureError::InvalidQuery(_))
    ));
}

#[test]
fn overlay_node_refs_require_matching_overlay_digest_and_effective_file_digest() {
    let generation = generation();
    let overlay = BufferOverlay::build(
        generation.base(),
        pin("owner/session/location"),
        [FileSnapshot::new("src/main.rs", b"fn edited() {}\n".to_vec())],
    )
    .unwrap();
    let mut scoped = query(&generation);
    scoped.overlay_ref = Some("ovl_0123456789abcdef".to_owned());
    scoped.selector.symbols.clear();
    scoped
        .selector
        .node_refs
        .push(horizon_indexd_library::RepoNodeRefV1 {
            workspace_binding: "workspace-binding-1".to_owned(),
            source_generation: generation.id().to_string(),
            source_revision: provenance().source_revision,
            overlay_digest: Some(overlay.digest().to_string()),
            path_ref: "src/main.rs".to_owned(),
            file_digest: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_owned(),
            node_id: "node-edited".to_owned(),
            node_kind: "function".to_owned(),
            symbol: "edited".to_owned(),
            byte_range: horizon_indexd_library::StructureByteRangeV1 { start: 3, end: 9 },
            parser_id: "tree-sitter-rust".to_owned(),
            parser_version: "1".to_owned(),
        });
    assert!(matches!(
        generation.query_structure(&scoped, &provenance(), Some(&overlay)),
        Err(RepoStructureError::InvalidQuery(_))
    ));

    let (effective_digest, effective_bytes) = overlay
        .file_observation(generation.base(), "src/main.rs")
        .expect("overlay provides the effective path observation");
    scoped.selector.node_refs[0].file_digest = effective_digest.to_string();
    scoped.selector.node_refs[0].byte_range.end = effective_bytes as u64;
    assert!(generation
        .query_structure(&scoped, &provenance(), Some(&overlay))
        .is_ok());

    scoped.selector.node_refs[0].overlay_digest = Some(
        "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
    );
    assert!(matches!(
        generation.query_structure(&scoped, &provenance(), Some(&overlay)),
        Err(RepoStructureError::InvalidQuery(_))
    ));
}
