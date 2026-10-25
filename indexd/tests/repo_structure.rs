use horizon_indexd_library::repo_structure::RepoStructurePositionV1;
use horizon_indexd_library::{
    BufferOverlay, FileSnapshot, GenerationPins, OpaquePin, RepoIntelGeneration,
    RepoStructureCompletenessV1, RepoStructureError, RepoStructureFallbackReasonV1,
    RepoStructureFreshnessV1, RepoStructureProvenanceV1, RepoStructureQueryV1,
    RepoStructureSelectorV1, RepoStructureSourceKindV1, RepoStructureStatusV1,
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
fn structure_query_returns_exact_bounded_lexical_evidence_without_ast_claims() {
    let generation = generation();
    let page = generation
        .query_structure(&query(&generation), &provenance(), None)
        .expect("valid query returns lexical evidence, not guessed AST structure");

    assert_eq!(page.schema_version, 1);
    assert_eq!(page.message_type, "page");
    assert_eq!(page.query_id, "query-1");
    assert_eq!(page.source_generation, generation.id().to_string());
    assert_eq!(page.workspace_binding, "workspace-binding-1");
    assert_eq!(page.source_kind, RepoStructureSourceKindV1::Lexical);
    assert_eq!(page.status, RepoStructureStatusV1::Partial);
    assert_eq!(page.freshness, RepoStructureFreshnessV1::Current);
    assert_eq!(page.completeness, RepoStructureCompletenessV1::Partial);
    assert_eq!(page.coverage.files, 1);
    assert_eq!(page.coverage.bytes, b"fn main() {}\n".len());
    assert_eq!(page.coverage.nodes, 1);
    assert_eq!(page.nodes.len(), 1);
    assert_eq!(page.nodes[0].node_kind, "text_occurrence");
    assert_eq!(page.nodes[0].parser_id, "horizoncode.lexical");
    assert_eq!(page.nodes[0].parser_version, "1");
    assert_eq!(page.nodes[0].byte_range.start, 3);
    assert_eq!(page.nodes[0].byte_range.end, 7);
    assert_eq!(page.nodes[0].file_digest, main_file_digest());
    assert_eq!(page.next_cursor, None);
    let fallback = page.fallback.unwrap();
    assert_eq!(
        fallback.reason,
        RepoStructureFallbackReasonV1::ParserUnsupported
    );
    assert_eq!(fallback.source_kind, RepoStructureSourceKindV1::Lexical);
}

#[test]
fn structure_query_marks_lexical_limits_partial_without_minting_a_cursor() {
    let generation = generation();
    let mut bounded = query(&generation);
    bounded.max_nodes = 1;
    bounded.selector.symbols = vec!["n".to_owned()];
    let page = generation
        .query_structure(&bounded, &provenance(), None)
        .unwrap();

    assert_eq!(page.status, RepoStructureStatusV1::Partial);
    assert_eq!(page.completeness, RepoStructureCompletenessV1::Partial);
    assert_eq!(page.nodes.len(), 1);
    assert_eq!(
        page.fallback.unwrap().reason,
        RepoStructureFallbackReasonV1::ParsePartial
    );
    assert_eq!(page.next_cursor, None);
}

#[test]
fn structure_query_skips_over_budget_files_and_keeps_scanning_later_paths() {
    let generation = RepoIntelGeneration::build(
        GenerationPins {
            repository: pin("repo"),
            workspace: Some(pin("workspace")),
            revision_set: pin("revision-set"),
            read_scope: pin("read-scope"),
            read_policy: pin("read-policy"),
            source_receipt: pin("receipt"),
            parser_set: pin("lexical-v1"),
        },
        [
            FileSnapshot::new("a/large.rs", b"hit hit hit hit".to_vec()),
            FileSnapshot::new("z/small.rs", b"hit".to_vec()),
        ],
    )
    .unwrap();
    let mut request = query(&generation);
    request.selector.symbols = vec!["hit".to_owned()];
    request.max_bytes = 3;

    let page = generation
        .query_structure(&request, &provenance(), None)
        .expect("over-budget files are skipped while later paths remain queryable");

    assert_eq!(page.coverage.files, 1);
    assert_eq!(page.coverage.bytes, 3);
    assert_eq!(page.nodes.len(), 1);
    assert_eq!(page.nodes[0].path_ref, "z/small.rs");
    assert_eq!(page.nodes[0].byte_range.start, 0);
    assert_eq!(page.completeness, RepoStructureCompletenessV1::Partial);
    assert_eq!(
        page.fallback.unwrap().reason,
        RepoStructureFallbackReasonV1::ParsePartial
    );
    assert_eq!(page.next_position, None);
}

#[test]
fn structure_query_bounds_repeated_selector_scan_work() {
    let contents = vec![b'x'; 50_000];
    let generation = RepoIntelGeneration::build(
        GenerationPins {
            repository: pin("repo"),
            workspace: Some(pin("workspace")),
            revision_set: pin("revision-set"),
            read_scope: pin("read-scope"),
            read_policy: pin("read-policy"),
            source_receipt: pin("receipt"),
            parser_set: pin("lexical-v1"),
        },
        [FileSnapshot::new("src/large.rs", contents.clone())],
    )
    .unwrap();
    let mut request = query(&generation);
    request.selector.symbols = (0..100).map(|_| "needle".to_owned()).collect();
    request.max_bytes = contents.len();

    let page = generation
        .query_structure(&request, &provenance(), None)
        .expect("bounded work returns typed partial coverage");

    assert_eq!(page.coverage.bytes, contents.len());
    assert!(page.nodes.is_empty());
    assert_eq!(page.source_kind, RepoStructureSourceKindV1::Lexical);
    assert_eq!(page.status, RepoStructureStatusV1::Partial);
    assert_eq!(page.completeness, RepoStructureCompletenessV1::Partial);
    assert_eq!(
        page.fallback.unwrap().reason,
        RepoStructureFallbackReasonV1::ResourceRefused
    );
    assert_eq!(page.next_position, None);
}

#[test]
fn structure_continuation_resumes_after_host_resolved_occurrence() {
    let generation = RepoIntelGeneration::build(
        GenerationPins {
            repository: pin("repo"),
            workspace: Some(pin("workspace")),
            revision_set: pin("revision-set"),
            read_scope: pin("read-scope"),
            read_policy: pin("read-policy"),
            source_receipt: pin("receipt"),
            parser_set: pin("lexical-v1"),
        },
        [FileSnapshot::new("src/hits.rs", b"hit hit hit".to_vec())],
    )
    .unwrap();
    let mut first_request = query(&generation);
    first_request.selector.symbols = vec!["hit".to_owned()];
    first_request.max_nodes = 2;

    let first = generation
        .query_structure(&first_request, &provenance(), None)
        .unwrap();
    let anchor = first
        .next_position
        .clone()
        .expect("a real extra occurrence proves that another page exists");
    assert_eq!(first.nodes.len(), 2);
    assert_eq!(anchor.byte_offset, first.nodes[1].byte_range.start);

    let mut continuation = first_request.clone();
    continuation.cursor = Some("host_cursor_opaque".to_owned());
    let second = generation
        .query_structure_page(&continuation, &provenance(), None, Some(&anchor))
        .unwrap();
    assert_eq!(second.nodes.len(), 1);
    assert_eq!(second.nodes[0].byte_range.start, 8);
    assert_eq!(second.next_position, None);

    let forged = RepoStructurePositionV1 {
        path_ref: "src/hits.rs".to_owned(),
        symbol_index: 0,
        byte_offset: 1,
    };
    assert!(
        generation
            .query_structure_page(&continuation, &provenance(), None, Some(&forged))
            .is_err()
    );
    assert!(
        generation
            .query_structure_page(&continuation, &provenance(), None, None)
            .is_err()
    );
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
    assert!(
        generation
            .query_structure(&scoped, &provenance(), None)
            .is_ok()
    );

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
        [FileSnapshot::new(
            "src/main.rs",
            b"fn first() {}\n".to_vec(),
        )],
    )
    .unwrap();
    let second = BufferOverlay::build(
        generation.base(),
        pin("owner-b/session-b/location-b"),
        [FileSnapshot::new(
            "src/main.rs",
            b"fn second() {}\n".to_vec(),
        )],
    )
    .unwrap();
    let mut first_query = query(&generation);
    first_query.overlay_ref = Some("ovl_0123456789abcdef".to_owned());
    first_query.selector.symbols = vec!["first".to_owned()];

    let base_page = generation
        .query_structure(&query(&generation), &provenance(), None)
        .unwrap();
    assert_eq!(base_page.status, RepoStructureStatusV1::Partial);
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
        [FileSnapshot::new(
            "src/main.rs",
            b"fn foreign() {}\n".to_vec(),
        )],
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
    second_query.selector.symbols = vec!["second".to_owned()];
    let second_page = generation
        .query_structure(&second_query, &provenance(), Some(&second))
        .unwrap();
    assert_eq!(first_page.status, RepoStructureStatusV1::Partial);
    assert_eq!(first_page.source_kind, RepoStructureSourceKindV1::Lexical);
    assert_eq!(first_page.nodes.len(), 1);
    assert_eq!(first_page.nodes[0].symbol, "first");
    assert_eq!(
        first_page.nodes[0].overlay_digest,
        first_page.overlay_digest
    );
    let (first_file_digest, first_file_bytes) = first
        .file_observation(generation.base(), "src/main.rs")
        .unwrap();
    assert_eq!(
        first_page.nodes[0].file_digest,
        first_file_digest.to_string()
    );
    let overlay_write_target = horizon_indexd_library::RepoWriteTargetV1 {
        path_ref: first_page.nodes[0].path_ref.clone(),
        source_generation: first_page.nodes[0].source_generation.clone(),
        source_revision: first_page.nodes[0].source_revision.clone(),
        file_digest: first_page.nodes[0].file_digest.clone(),
        byte_start: first_page.nodes[0].byte_range.start,
        byte_end: first_file_bytes as u64,
    };
    assert_eq!(
        generation.validate_write_target(&overlay_write_target, &provenance().source_revision),
        Err(horizon_indexd_library::RepoWriteRefusalV1::FileDigestMismatch),
        "an overlay observation cannot be reused as a base-workspace write precondition"
    );
    assert_eq!(first_page.overlay_digest, Some(first.digest().to_string()));
    assert_eq!(
        second_page.overlay_digest,
        Some(second.digest().to_string())
    );
    assert_eq!(second_page.nodes.len(), 1);
    assert_eq!(second_page.nodes[0].symbol, "second");
    assert_eq!(
        second_page.nodes[0].overlay_digest,
        second_page.overlay_digest
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
fn overlay_structure_continuation_validates_anchor_against_effective_overlay_bytes() {
    let generation = generation();
    let overlay = BufferOverlay::build(
        generation.base(),
        pin("owner/session/location"),
        [FileSnapshot::new("src/main.rs", b"hit hit hit".to_vec())],
    )
    .unwrap();
    let mut first_query = query(&generation);
    first_query.overlay_ref = Some("ovl_0123456789abcdef".to_owned());
    first_query.selector.symbols = vec!["hit".to_owned()];
    first_query.max_nodes = 2;

    let first = generation
        .query_structure(&first_query, &provenance(), Some(&overlay))
        .unwrap();
    assert_eq!(first.nodes.len(), 2);
    let resume = first
        .next_position
        .expect("the third overlay match proves another page exists");

    let mut continuation = first_query;
    continuation.cursor = Some("host_cursor_opaque".to_owned());
    let second = generation
        .query_structure_page(&continuation, &provenance(), Some(&overlay), Some(&resume))
        .expect("the overlay-derived continuation anchor is valid for the same overlay");

    assert_eq!(second.nodes.len(), 1);
    assert_eq!(second.nodes[0].symbol, "hit");
    assert_eq!(second.nodes[0].byte_range.start, 8);
    assert_eq!(second.overlay_digest, Some(overlay.digest().to_string()));
}

#[test]
fn overlay_node_refs_require_matching_overlay_digest_and_effective_file_digest() {
    let generation = generation();
    let overlay = BufferOverlay::build(
        generation.base(),
        pin("owner/session/location"),
        [FileSnapshot::new(
            "src/main.rs",
            b"fn edited() {}\n".to_vec(),
        )],
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
    assert!(
        generation
            .query_structure(&scoped, &provenance(), Some(&overlay))
            .is_ok()
    );

    scoped.selector.node_refs[0].overlay_digest =
        Some("blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned());
    assert!(matches!(
        generation.query_structure(&scoped, &provenance(), Some(&overlay)),
        Err(RepoStructureError::InvalidQuery(_))
    ));
}

#[test]
fn write_target_revalidation_refuses_stale_generation_revision_digest_and_range() {
    let generation = generation();
    let revision = provenance().source_revision;
    let valid = horizon_indexd_library::RepoWriteTargetV1 {
        path_ref: "src/main.rs".to_owned(),
        source_generation: generation.id().to_string(),
        source_revision: revision.clone(),
        file_digest: main_file_digest(),
        byte_start: 3,
        byte_end: 7,
    };
    assert_eq!(generation.validate_write_target(&valid, &revision), Ok(()));

    let stale_generation = horizon_indexd_library::RepoWriteTargetV1 {
        source_generation:
            "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned(),
        ..valid.clone()
    };
    assert_eq!(
        generation.validate_write_target(&stale_generation, &revision),
        Err(horizon_indexd_library::RepoWriteRefusalV1::StaleGeneration)
    );

    let advanced = "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    assert_eq!(
        generation.validate_write_target(&valid, advanced),
        Err(horizon_indexd_library::RepoWriteRefusalV1::StaleRevision)
    );

    let unknown = horizon_indexd_library::RepoWriteTargetV1 {
        path_ref: "src/other.rs".to_owned(),
        ..valid.clone()
    };
    assert_eq!(
        generation.validate_write_target(&unknown, &revision),
        Err(horizon_indexd_library::RepoWriteRefusalV1::UnknownPath)
    );

    let changed = horizon_indexd_library::RepoWriteTargetV1 {
        file_digest: "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            .to_owned(),
        ..valid.clone()
    };
    assert_eq!(
        generation.validate_write_target(&changed, &revision),
        Err(horizon_indexd_library::RepoWriteRefusalV1::FileDigestMismatch)
    );

    let reversed = horizon_indexd_library::RepoWriteTargetV1 {
        byte_start: 9,
        byte_end: 3,
        ..valid.clone()
    };
    assert_eq!(
        generation.validate_write_target(&reversed, &revision),
        Err(horizon_indexd_library::RepoWriteRefusalV1::InvalidRange)
    );

    let past_end = horizon_indexd_library::RepoWriteTargetV1 {
        byte_end: u64::MAX,
        ..valid
    };
    assert_eq!(
        generation.validate_write_target(&past_end, &revision),
        Err(horizon_indexd_library::RepoWriteRefusalV1::InvalidRange)
    );
}

#[test]
fn structure_root_ref_is_path_segment_scoped_and_never_prefix_matches_siblings() {
    let generation = RepoIntelGeneration::build(
        GenerationPins {
            repository: pin("repo"),
            workspace: Some(pin("workspace")),
            revision_set: pin("revision-set"),
            read_scope: pin("read-scope"),
            read_policy: pin("read-policy"),
            source_receipt: pin("receipt"),
            parser_set: pin("lexical-v1"),
        },
        [
            FileSnapshot::new("src/main.rs", b"fn main() {}\n".to_vec()),
            FileSnapshot::new("src2/main.rs", b"fn main() {}\n".to_vec()),
        ],
    )
    .unwrap();
    let mut scoped = query(&generation);
    scoped.root_ref = "src".to_owned();
    let page = generation
        .query_structure(&scoped, &provenance(), None)
        .expect("scoped query succeeds");
    assert_eq!(page.coverage.files, 1);
    assert!(page.nodes.iter().all(|node| node.path_ref == "src/main.rs"));
    assert!(
        page.nodes
            .iter()
            .all(|node| node.source_revision == provenance().source_revision)
    );
}
