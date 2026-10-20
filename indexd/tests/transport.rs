//! End-to-end coverage of the RepoIntel transport frames and handler.
//!
//! These tests drive the exact bytes a host bridge would: they encode request
//! frames, hand them to [`TransportHandler::handle_frame`], decode the response
//! frames, and assert the typed results, bounds and mismatch rejections that the
//! kernel bridge and the TypeScript `RepoIntelBackend` port depend on.

use horizon_indexd_library::{
    operation_from_tag, operation_tag, peek_request_frame, BaseGeneration, Digest, FileSnapshot,
    GenerationPack, GenerationPins, IndexError, OpaquePin, OverlayChange, QueryResponse,
    RepoIntelOperation, SearchTruncation, TransportError, TransportHandler, TransportRequest,
    TransportResponse, WireErrorCode, MAX_OVERLAY_CHANGES, MAX_QUERY_BODY_BYTES, MAX_QUERY_RESULTS,
    MAX_TRANSPORT_BODY_BYTES, REQUEST_BUILD, REQUEST_OVERLAY, REQUEST_QUERY,
    REQUEST_RELEASE_GENERATION, REQUEST_RELEASE_OVERLAY, TRANSPORT_VERSION,
};

fn pin(value: &str) -> OpaquePin {
    OpaquePin::new(value.as_bytes().to_vec()).expect("valid pin")
}

fn pins(revision: &str) -> GenerationPins {
    GenerationPins {
        repository: pin("repo-1"),
        workspace: Some(pin("workspace-1")),
        revision_set: pin(revision),
        read_scope: pin("scope-1"),
        read_policy: pin("policy-1"),
        source_receipt: pin("receipt-1"),
        parser_set: pin("parser-1"),
    }
}

fn pack(revision: &str, files: &[(&str, &str)]) -> GenerationPack {
    let generation = BaseGeneration::build(
        pins(revision),
        files
            .iter()
            .map(|(path, contents)| FileSnapshot::new(*path, contents.as_bytes().to_vec()))
            .collect::<Vec<_>>(),
    )
    .expect("generation");
    GenerationPack::from_generation(&generation).expect("pack")
}

/// Serve one request frame through the handler and decode the response frame.
fn serve(handler: &mut TransportHandler, request: &TransportRequest) -> TransportResponse {
    let request_frame = request.encode().expect("encode request");
    let peeked = peek_request_frame(&request_frame).expect("peek request");
    assert_eq!(peeked.kind, request.kind_tag());
    assert_eq!(peeked.frame_len, request_frame.len());
    let response_frame = handler
        .handle_frame(&request_frame)
        .expect("handle request");
    TransportResponse::decode(&response_frame).expect("decode response")
}

fn expect_error(response: TransportResponse, expected: WireErrorCode) -> Option<String> {
    match response {
        TransportResponse::Error { code, detail } => {
            assert_eq!(code, expected, "detail: {detail:?}");
            assert_eq!(code.as_str(), port_code(expected), "detail: {detail:?}");
            detail
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

/// The exact `RepoIntelBackendErrorCode` string each code must report.
fn port_code(code: WireErrorCode) -> &'static str {
    match code {
        WireErrorCode::Unavailable => "unavailable",
        WireErrorCode::Rejected => "rejected",
        WireErrorCode::GenerationMismatch => "generation_mismatch",
        WireErrorCode::CursorGenerationMismatch => "cursor_generation_mismatch",
        WireErrorCode::CursorQueryMismatch => "cursor_query_mismatch",
        WireErrorCode::CursorOverlayMismatch => "cursor_overlay_mismatch",
        WireErrorCode::CursorAnchorNotFound => "cursor_anchor_not_found",
        WireErrorCode::CursorWorkLimit => "cursor_work_limit",
        WireErrorCode::InvalidSearchCursor => "invalid_search_cursor",
        WireErrorCode::InvalidPath => "invalid_path",
        WireErrorCode::DuplicatePath => "duplicate_path",
        WireErrorCode::InvalidUtf8 => "invalid_utf8",
        WireErrorCode::TooManyBaseFiles => "too_many_base_files",
        WireErrorCode::FileTooLarge => "file_too_large",
        WireErrorCode::BaseContentLimit => "base_content_limit",
        WireErrorCode::BasePathLimit => "base_path_limit",
        WireErrorCode::EmptyQuery => "empty_query",
        WireErrorCode::QueryTooLarge => "query_too_large",
        WireErrorCode::MultilineQuery => "multiline_query",
        WireErrorCode::InvalidResultLimit => "invalid_result_limit",
        WireErrorCode::OverlayGenerationMismatch => "overlay_generation_mismatch",
    }
}

fn build(handler: &mut TransportHandler, pack: GenerationPack) -> Digest {
    match serve(handler, &TransportRequest::Build { pack }) {
        TransportResponse::Build { generation_id } => generation_id,
        other => panic!("expected a build response, got {other:?}"),
    }
}

fn text_query(
    generation_id: Digest,
    query: &str,
    max_results: usize,
    overlay_digest: Option<Digest>,
    cursor: Option<String>,
) -> TransportRequest {
    TransportRequest::Query {
        generation_id,
        operation: RepoIntelOperation::Text,
        query: query.to_owned(),
        max_results,
        overlay_digest,
        cursor,
    }
}

fn partial(response: TransportResponse) -> QueryResponse {
    match response {
        TransportResponse::Query(partial @ QueryResponse::Partial { .. }) => partial,
        other => panic!("expected a partial query response, got {other:?}"),
    }
}

#[test]
fn build_and_text_query_round_trip_over_frames() {
    let mut handler = TransportHandler::new();
    let pack = pack(
        "rev-1",
        &[
            ("src/a.rs", "let needle = 1;\n"),
            ("src/b.rs", "nothing here\n"),
        ],
    );
    let expected_id = GenerationPack::decode(pack.as_bytes())
        .expect("decode pack")
        .digest();
    let generation_id = build(&mut handler, pack);
    assert_eq!(generation_id, expected_id);
    assert_eq!(handler.generation_count(), 1);

    let response = partial(serve(
        &mut handler,
        &text_query(generation_id, "needle", 10, None, None),
    ));
    let QueryResponse::Partial {
        generation_id: echoed,
        overlay_digest,
        matches,
        next_cursor,
        work_units,
        truncated_by,
    } = response
    else {
        unreachable!("partial() narrows the variant");
    };
    assert_eq!(echoed, generation_id);
    assert_eq!(overlay_digest, None);
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].path, "src/a.rs");
    assert_eq!(matches[0].start_line, 1);
    assert_eq!(matches[0].end_line, 1);
    assert_eq!(next_cursor, None);
    assert_eq!(truncated_by, None);
    assert!(work_units > 0);
}

#[test]
fn cursor_pagination_is_contiguous_over_the_wire() {
    let mut handler = TransportHandler::new();
    let identical = pack("rev-1", &[("a.txt", "needle\nmiss\nneedle\nneedle\n")]);
    let generation_id = build(&mut handler, identical.clone());
    assert_eq!(
        GenerationPack::decode(identical.as_bytes())
            .expect("decode")
            .digest(),
        generation_id,
        "the served generation must be the pack the host built"
    );

    let first = partial(serve(
        &mut handler,
        &text_query(generation_id, "needle", 2, None, None),
    ));
    let QueryResponse::Partial {
        matches: first_matches,
        next_cursor: Some(cursor),
        truncated_by: Some(SearchTruncation::ResultLimit),
        ..
    } = first
    else {
        panic!("expected a truncated first page");
    };
    assert_eq!(first_matches.len(), 2);

    let second = partial(serve(
        &mut handler,
        &text_query(generation_id, "needle", 2, None, Some(cursor)),
    ));
    let QueryResponse::Partial {
        matches: second_matches,
        next_cursor,
        ..
    } = second
    else {
        unreachable!("partial() narrows the variant");
    };
    assert_eq!(second_matches.len(), 1);
    assert_eq!(second_matches[0].start_line, 4);
    assert_eq!(next_cursor, None);

    let mut paged = first_matches;
    paged.extend(second_matches);
    let direct = GenerationPack::decode(identical.as_bytes())
        .expect("decode")
        .search("needle", MAX_QUERY_RESULTS)
        .expect("search");
    assert_eq!(paged, direct.matches);
}

#[test]
fn overlay_build_query_and_release_round_trip_over_frames() {
    let mut handler = TransportHandler::new();
    let generation_id = build(
        &mut handler,
        pack("rev-1", &[("a.txt", "needle\n"), ("b.txt", "needle\n")]),
    );

    let overlay_response = serve(
        &mut handler,
        &TransportRequest::BuildOverlay {
            generation_id,
            editor_version: pin("editor-1"),
            changes: vec![
                OverlayChange::Replace(FileSnapshot::new("a.txt", b"edited\n".to_vec())),
                OverlayChange::Clear {
                    path: "b.txt".to_owned(),
                },
            ],
        },
    );
    let TransportResponse::Overlay {
        base_generation_id,
        overlay_digest,
    } = overlay_response
    else {
        panic!("expected an overlay response");
    };
    assert_eq!(base_generation_id, generation_id);
    assert_eq!(handler.overlay_count(), 1);

    // The replace shadows a.txt's base bytes; the clear reveals b.txt's base bytes.
    let replaced = partial(serve(
        &mut handler,
        &text_query(generation_id, "edited", 10, Some(overlay_digest), None),
    ));
    assert_eq!(replaced_matches(&replaced), 1);
    assert_eq!(replaced_overlay_digest(&replaced), Some(overlay_digest));
    let revealed = partial(serve(
        &mut handler,
        &text_query(generation_id, "needle", 10, Some(overlay_digest), None),
    ));
    assert_eq!(replaced_matches(&revealed), 1);
    assert_eq!(revealed_matches_path(&revealed), "b.txt");

    // The base generation is untouched by the overlay.
    let base = partial(serve(
        &mut handler,
        &text_query(generation_id, "needle", 10, None, None),
    ));
    assert_eq!(replaced_matches(&base), 2);

    // Releasing the overlay makes its digest unusable; the generation survives.
    assert_eq!(
        serve(
            &mut handler,
            &TransportRequest::ReleaseOverlay { overlay_digest }
        ),
        TransportResponse::Released
    );
    assert_eq!(handler.overlay_count(), 0);
    expect_error(
        serve(
            &mut handler,
            &text_query(generation_id, "needle", 10, Some(overlay_digest), None),
        ),
        WireErrorCode::OverlayGenerationMismatch,
    );
    assert_eq!(handler.generation_count(), 1);
}

fn replaced_matches(response: &QueryResponse) -> usize {
    match response {
        QueryResponse::Partial { matches, .. } => matches.len(),
        QueryResponse::Unavailable { .. } => panic!("expected a partial response"),
    }
}

fn replaced_overlay_digest(response: &QueryResponse) -> Option<Digest> {
    match response {
        QueryResponse::Partial { overlay_digest, .. } => *overlay_digest,
        QueryResponse::Unavailable { .. } => panic!("expected a partial response"),
    }
}

fn revealed_matches_path(response: &QueryResponse) -> &str {
    match response {
        QueryResponse::Partial { matches, .. } => &matches[0].path,
        QueryResponse::Unavailable { .. } => panic!("expected a partial response"),
    }
}

#[test]
fn generation_cursor_and_overlay_bindings_are_enforced() {
    let mut handler = TransportHandler::new();
    let first_id = build(
        &mut handler,
        pack("rev-1", &[("a.txt", "needle\nneedle\n")]),
    );
    let second_id = build(
        &mut handler,
        pack("rev-2", &[("a.txt", "needle\nneedle\n")]),
    );
    assert_ne!(first_id, second_id);
    let TransportResponse::Overlay { overlay_digest, .. } = serve(
        &mut handler,
        &TransportRequest::BuildOverlay {
            generation_id: first_id,
            editor_version: pin("editor-1"),
            changes: vec![OverlayChange::Replace(FileSnapshot::new(
                "a.txt",
                b"needle\nneedle\nneedle\n".to_vec(),
            ))],
        },
    ) else {
        panic!("expected an overlay response");
    };

    // An overlay built for one generation is refused for another.
    expect_error(
        serve(
            &mut handler,
            &text_query(second_id, "needle", 10, Some(overlay_digest), None),
        ),
        WireErrorCode::OverlayGenerationMismatch,
    );

    // A cursor from one generation is refused for another.
    let first_page = partial(serve(
        &mut handler,
        &text_query(first_id, "needle", 1, None, None),
    ));
    let QueryResponse::Partial {
        next_cursor: Some(cursor),
        ..
    } = first_page
    else {
        panic!("expected a continuation cursor");
    };
    expect_error(
        serve(
            &mut handler,
            &text_query(second_id, "needle", 1, None, Some(cursor.clone())),
        ),
        WireErrorCode::CursorGenerationMismatch,
    );
    // A cursor from one query is refused for a different query in the same generation.
    expect_error(
        serve(
            &mut handler,
            &text_query(first_id, "different", 1, None, Some(cursor.clone())),
        ),
        WireErrorCode::CursorQueryMismatch,
    );
    // A cursor bound to an overlay is refused without that overlay.
    let overlay_page = partial(serve(
        &mut handler,
        &text_query(first_id, "needle", 1, Some(overlay_digest), None),
    ));
    let QueryResponse::Partial {
        next_cursor: Some(overlay_cursor),
        ..
    } = overlay_page
    else {
        panic!("expected an overlay continuation cursor");
    };
    expect_error(
        serve(
            &mut handler,
            &text_query(first_id, "needle", 1, None, Some(overlay_cursor.clone())),
        ),
        WireErrorCode::CursorOverlayMismatch,
    );
    // ... and a cursor bound to no overlay is refused when one is attached.
    expect_error(
        serve(
            &mut handler,
            &text_query(
                first_id,
                "needle",
                1,
                Some(overlay_digest),
                Some(cursor.clone()),
            ),
        ),
        WireErrorCode::CursorOverlayMismatch,
    );
    // The same cursor against the same overlay continues cleanly.
    let continued = partial(serve(
        &mut handler,
        &text_query(
            first_id,
            "needle",
            10,
            Some(overlay_digest),
            Some(overlay_cursor),
        ),
    ));
    assert_eq!(replaced_matches(&continued), 2);
}

#[test]
fn released_generations_reject_queries_and_cascade_to_overlays() {
    let mut handler = TransportHandler::new();
    let generation_id = build(&mut handler, pack("rev-1", &[("a.txt", "needle\n")]));
    serve(
        &mut handler,
        &TransportRequest::BuildOverlay {
            generation_id,
            editor_version: pin("editor-1"),
            changes: vec![OverlayChange::Clear {
                path: "a.txt".to_owned(),
            }],
        },
    );
    assert_eq!(handler.overlay_count(), 1);

    assert_eq!(
        serve(
            &mut handler,
            &TransportRequest::ReleaseGeneration { generation_id }
        ),
        TransportResponse::Released
    );
    assert_eq!(handler.generation_count(), 0);
    assert_eq!(handler.overlay_count(), 0);
    expect_error(
        serve(
            &mut handler,
            &text_query(generation_id, "needle", 10, None, None),
        ),
        WireErrorCode::GenerationMismatch,
    );
    expect_error(
        serve(
            &mut handler,
            &TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: vec![OverlayChange::Clear {
                    path: "a.txt".to_owned(),
                }],
            },
        ),
        WireErrorCode::GenerationMismatch,
    );
    // Releases are idempotent.
    assert_eq!(
        serve(
            &mut handler,
            &TransportRequest::ReleaseGeneration { generation_id }
        ),
        TransportResponse::Released
    );
}

#[test]
fn query_validation_and_unavailable_operations_are_typed() {
    let mut handler = TransportHandler::new();
    let generation_id = build(&mut handler, pack("rev-1", &[("a.rs", "fn needle() {}\n")]));

    expect_error(
        serve(&mut handler, &text_query(generation_id, "", 10, None, None)),
        WireErrorCode::EmptyQuery,
    );
    expect_error(
        serve(
            &mut handler,
            &text_query(generation_id, &"q".repeat(300), 10, None, None),
        ),
        WireErrorCode::QueryTooLarge,
    );
    expect_error(
        serve(
            &mut handler,
            &text_query(generation_id, "line\nline", 10, None, None),
        ),
        WireErrorCode::MultilineQuery,
    );
    for limit in [0, MAX_QUERY_RESULTS + 1] {
        expect_error(
            serve(
                &mut handler,
                &text_query(generation_id, "needle", limit, None, None),
            ),
            WireErrorCode::InvalidResultLimit,
        );
    }
    expect_error(
        serve(
            &mut handler,
            &text_query(
                generation_id,
                "needle",
                10,
                None,
                Some("garbage".to_owned()),
            ),
        ),
        WireErrorCode::InvalidSearchCursor,
    );

    for operation in [
        RepoIntelOperation::Symbol,
        RepoIntelOperation::References,
        RepoIntelOperation::Impact,
        RepoIntelOperation::Expand,
    ] {
        assert_eq!(
            operation_from_tag(operation_tag(operation)),
            Some(operation)
        );
        let response = serve(
            &mut handler,
            &TransportRequest::Query {
                generation_id,
                operation,
                query: "needle".to_owned(),
                max_results: 10,
                overlay_digest: None,
                cursor: None,
            },
        );
        assert_eq!(
            response,
            TransportResponse::Query(QueryResponse::Unavailable {
                generation_id,
                overlay_digest: None,
                operation,
            })
        );
    }
}

#[test]
fn overlay_batches_are_bounded_and_typed_over_the_wire() {
    let mut handler = TransportHandler::new();
    let generation_id = build(&mut handler, pack("rev-1", &[("a.txt", "needle\n")]));

    // More changes than the batch bound are rejected while decoding.
    let too_many: Vec<OverlayChange> = (0..=MAX_OVERLAY_CHANGES)
        .map(|index| OverlayChange::Clear {
            path: format!("file-{index}.txt"),
        })
        .collect();
    let frame = TransportRequest::BuildOverlay {
        generation_id,
        editor_version: pin("editor-1"),
        changes: too_many,
    }
    .encode()
    .expect("encode");
    assert!(matches!(
        handler.handle_frame(&frame),
        Err(TransportError::Index(
            IndexError::TooManyOverlayChanges { .. }
        ))
    ));

    // Value-level overlay failures are typed error responses.
    expect_error(
        serve(
            &mut handler,
            &TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: vec![OverlayChange::Clear {
                    path: "../escape".to_owned(),
                }],
            },
        ),
        WireErrorCode::InvalidPath,
    );
    expect_error(
        serve(
            &mut handler,
            &TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: vec![OverlayChange::Clear {
                    path: "missing.txt".to_owned(),
                }],
            },
        ),
        WireErrorCode::Rejected,
    );
    expect_error(
        serve(
            &mut handler,
            &TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: vec![
                    OverlayChange::Clear {
                        path: "a.txt".to_owned(),
                    },
                    OverlayChange::Replace(FileSnapshot::new("a.txt", b"twice\n".to_vec())),
                ],
            },
        ),
        WireErrorCode::Rejected,
    );
    expect_error(
        serve(
            &mut handler,
            &TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: vec![OverlayChange::Replace(FileSnapshot::new(
                    "a.txt",
                    vec![0xff, 0xfe],
                ))],
            },
        ),
        WireErrorCode::InvalidUtf8,
    );
    assert_eq!(handler.overlay_count(), 0);
}

#[test]
fn frame_bounds_truncation_and_direction_are_rejected() {
    // A declared body beyond the hard cap never allocates and never asks for a checksum.
    let mut oversized = Vec::new();
    oversized.extend_from_slice(b"HZRQ");
    oversized.push(TRANSPORT_VERSION);
    oversized.push(REQUEST_BUILD);
    oversized.extend_from_slice(
        &u32::try_from(MAX_TRANSPORT_BODY_BYTES + 1)
            .expect("fits u32")
            .to_be_bytes(),
    );
    oversized.extend_from_slice(&[0u8; 32]);
    let error = TransportRequest::decode(&oversized).expect_err("oversized frame");
    assert!(matches!(error, TransportError::TooLarge { .. }));
    assert_eq!(error.wire_code(), WireErrorCode::Rejected);

    // Real frames survive a peek and are rejected when truncated, flipped or reversed.
    let request = text_query(Digest::from_bytes([7; 32]), "needle", 10, None, None);
    let frame = request.encode().expect("encode");
    let truncated = &frame[..frame.len() - 1];
    assert!(matches!(
        TransportRequest::decode(truncated),
        Err(TransportError::Truncated)
    ));
    let mut flipped = frame.clone();
    let position = frame.len() - 40;
    flipped[position] ^= 0x01;
    assert!(matches!(
        TransportRequest::decode(&flipped),
        Err(TransportError::ChecksumMismatch)
    ));
    assert!(matches!(
        TransportResponse::decode(&frame),
        Err(TransportError::InvalidDirection)
    ));
    assert!(matches!(
        TransportRequest::decode(&TransportResponse::Released.encode().expect("encode")),
        Err(TransportError::InvalidDirection)
    ));

    // A pack larger than the hard pack bound cannot even be wrapped.
    assert!(matches!(
        GenerationPack::from_encoded(vec![0u8; MAX_TRANSPORT_BODY_BYTES + 1]),
        Err(IndexError::PackTooLarge { .. })
    ));

    // A query whose encoded body exceeds the query cap cannot be sent.
    let oversized_query = text_query(
        Digest::from_bytes([7; 32]),
        &"q".repeat(MAX_QUERY_BODY_BYTES),
        10,
        None,
        None,
    );
    let error = oversized_query.encode().expect_err("oversized query body");
    assert!(matches!(
        error,
        TransportError::TooLarge {
            limit: MAX_QUERY_BODY_BYTES
        }
    ));

    // Corrupt packs become typed error responses, not frame failures.
    let mut handler = TransportHandler::new();
    let good = pack("rev-1", &[("a.txt", "needle\n")]);
    let mut corrupted = good.as_bytes().to_vec();
    let position = corrupted.len() / 2;
    corrupted[position] ^= 0x01;
    let corrupt_pack = GenerationPack::from_encoded(corrupted).expect("bounded wrap");
    expect_error(
        serve(
            &mut handler,
            &TransportRequest::Build { pack: corrupt_pack },
        ),
        WireErrorCode::Rejected,
    );
}

#[test]
fn every_request_kind_round_trips_and_peeks() {
    let mut handler = TransportHandler::new();
    let generation_id = build(&mut handler, pack("rev-1", &[("a.txt", "needle\n")]));

    let requests = [
        TransportRequest::Build {
            pack: pack("rev-1", &[("a.txt", "needle\n")]),
        },
        TransportRequest::BuildOverlay {
            generation_id,
            editor_version: pin("editor-1"),
            changes: vec![OverlayChange::Clear {
                path: "a.txt".to_owned(),
            }],
        },
        text_query(generation_id, "needle", 10, None, None),
        TransportRequest::ReleaseGeneration { generation_id },
        TransportRequest::ReleaseOverlay {
            overlay_digest: Digest::from_bytes([3; 32]),
        },
    ];
    let expected_kinds = [
        REQUEST_BUILD,
        REQUEST_OVERLAY,
        REQUEST_QUERY,
        REQUEST_RELEASE_GENERATION,
        REQUEST_RELEASE_OVERLAY,
    ];

    for (request, expected_kind) in requests.iter().zip(expected_kinds) {
        let frame = request.encode().expect("encode");
        assert_eq!(TransportRequest::decode(&frame).expect("decode"), *request);
        let peeked = peek_request_frame(&frame).expect("peek");
        assert_eq!(peeked.kind, expected_kind);
        assert_eq!(peeked.frame_len, frame.len());
        let _ = handler.handle_frame(&frame).expect("handle");
    }
}
