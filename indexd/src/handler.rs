//! In-memory indexd-side handler for decoded RepoIntel transport requests.
//!
//! [`TransportHandler`] is the reference implementation of the wire contract's
//! *semantics*: it owns decoded generations and overlays, applies exactly one
//! request at a time, and answers every semantic failure with a typed
//! [`TransportResponse::Error`] instead of panicking or silently degrading. The
//! supervised `hz-indexd` process will own process-level concerns (sockets,
//! leases, scheduling, eviction); this handler is the crate-side behavior it must
//! match, and the fixture the kernel bridge's tests can drive without any I/O.
//!
//! What this handler deliberately does **not** do: no filesystem or network I/O,
//! no authentication or authorization, no lease/ownership state, no retention
//! policy. It retains generations and overlays until they are released, and an
//! equal generation id (same pinned content) is adopted idempotently.

use std::collections::BTreeMap;

use crate::transport::{
    QueryResponse, TransportError, TransportRequest, TransportResponse, WireErrorCode,
    response_from_index_error,
};
use crate::{
    BufferOverlay, Digest, GenerationPack, OpaquePin, OverlayChange, RepoIntelGeneration,
    RepoIntelOperation, RepoIntelQuery, RepoIntelQueryResult, RepoIntelStatus,
    RepoIntelUnavailableReason, SearchCursor, validate_query,
};

/// In-memory reference handler for decoded RepoIntel transport requests.
///
/// Request semantics, in the order the handler applies them:
///
/// 1. `build` decodes the contained [`GenerationPack`] and adopts the generation;
///    a pack failure is a typed error response, never a frame failure.
/// 2. `buildOverlay` requires a retained generation, a non-empty change batch
///    without duplicate paths, and changes confined to existing paths.
/// 3. `query` requires a retained generation, validates the query and result
///    limit, resolves an optional overlay digest against that exact generation,
///    parses an optional cursor, and dispatches through [`RepoIntelGeneration`],
///    so the lexical engine and its typed mismatches are shared with the direct
///    API and never re-implemented here. Cursor *binding* checks apply to text
///    operations; a malformed cursor is rejected for every operation.
/// 4. releases are idempotent; releasing a generation also drops every overlay
///    built against it, because no such overlay can ever be used again.
#[derive(Default)]
pub struct TransportHandler {
    generations: BTreeMap<Digest, RepoIntelGeneration>,
    overlays: BTreeMap<Digest, BufferOverlay>,
}

impl TransportHandler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of retained generations.
    pub fn generation_count(&self) -> usize {
        self.generations.len()
    }

    /// Number of retained overlays.
    pub fn overlay_count(&self) -> usize {
        self.overlays.len()
    }

    /// Decode one request frame, apply it and encode the response frame.
    ///
    /// A frame-level failure returns `Err` and no response frame is produced; a
    /// semantic failure is encoded as a typed error response.
    pub fn handle_frame(&mut self, frame: &[u8]) -> Result<Vec<u8>, TransportError> {
        let request = TransportRequest::decode(frame)?;
        self.handle(request).encode()
    }

    /// Apply one decoded request; every semantic failure becomes a typed error response.
    pub fn handle(&mut self, request: TransportRequest) -> TransportResponse {
        match request {
            TransportRequest::Build { pack } => self.build(pack),
            TransportRequest::BuildOverlay {
                generation_id,
                editor_version,
                changes,
            } => self.build_overlay(generation_id, &editor_version, changes),
            TransportRequest::Query {
                generation_id,
                operation,
                query,
                max_results,
                overlay_digest,
                cursor,
            } => self.query(
                generation_id,
                operation,
                query,
                max_results,
                overlay_digest,
                cursor,
            ),
            TransportRequest::ReleaseGeneration { generation_id } => {
                self.generations.remove(&generation_id);
                self.overlays
                    .retain(|_, overlay| overlay.base_generation_digest() != generation_id);
                TransportResponse::Released
            }
            TransportRequest::ReleaseOverlay { overlay_digest } => {
                self.overlays.remove(&overlay_digest);
                TransportResponse::Released
            }
        }
    }

    fn build(&mut self, pack: GenerationPack) -> TransportResponse {
        let generation = match GenerationPack::decode(pack.as_bytes()) {
            Ok(generation) => generation,
            Err(error) => return response_from_index_error(&error),
        };
        let generation_id = generation.digest();
        self.generations
            .insert(generation_id, RepoIntelGeneration::from_base(generation));
        TransportResponse::Build { generation_id }
    }

    fn build_overlay(
        &mut self,
        generation_id: Digest,
        editor_version: &OpaquePin,
        changes: Vec<OverlayChange>,
    ) -> TransportResponse {
        if changes.is_empty() {
            return TransportResponse::error(
                WireErrorCode::Rejected,
                "overlay batch must contain at least one change",
            );
        }

        let overlay = {
            let Some(generation) = self.generations.get(&generation_id) else {
                return unknown_generation(generation_id);
            };
            let base = generation.base();
            // An empty overlay plus the library's own bounded batch application
            // reuses the single authoritative validation/apply path.
            let empty = match BufferOverlay::build(base, editor_version.clone(), []) {
                Ok(empty) => empty,
                Err(error) => return response_from_index_error(&error),
            };
            match empty.apply_changes(base, editor_version.clone(), changes) {
                Ok(overlay) => overlay,
                Err(error) => return response_from_index_error(&error),
            }
        };

        let base_generation_id = overlay.base_generation_digest();
        let overlay_digest = overlay.digest();
        self.overlays.insert(overlay_digest, overlay);
        TransportResponse::Overlay {
            base_generation_id,
            overlay_digest,
        }
    }

    fn query(
        &self,
        generation_id: Digest,
        operation: RepoIntelOperation,
        query: String,
        max_results: usize,
        overlay_digest: Option<Digest>,
        cursor: Option<String>,
    ) -> TransportResponse {
        let Some(generation) = self.generations.get(&generation_id) else {
            return unknown_generation(generation_id);
        };

        if let Err(error) = validate_query(&query, max_results) {
            return response_from_index_error(&error);
        }

        let overlay = match overlay_digest {
            None => None,
            Some(digest) => {
                let Some(overlay) = self.overlays.get(&digest) else {
                    return TransportResponse::error(
                        WireErrorCode::OverlayGenerationMismatch,
                        format!("overlay {digest} is not built or was released"),
                    );
                };
                if overlay.base_generation_digest() != generation_id {
                    return TransportResponse::error(
                        WireErrorCode::OverlayGenerationMismatch,
                        format!(
                            "overlay {digest} is bound to {} not {generation_id}",
                            overlay.base_generation_digest()
                        ),
                    );
                }
                Some(overlay.clone())
            }
        };

        let cursor = match cursor {
            None => None,
            Some(token) => match SearchCursor::parse(&token) {
                Ok(cursor) => Some(cursor),
                Err(error) => return response_from_index_error(&error),
            },
        };

        let request = RepoIntelQuery {
            generation_id,
            operation,
            query,
            max_results,
            overlay,
            cursor,
        };
        match generation.query(request) {
            Ok(result) => query_response(result, overlay_digest),
            Err(error) => response_from_index_error(&error),
        }
    }
}

fn unknown_generation(generation_id: Digest) -> TransportResponse {
    TransportResponse::error(
        WireErrorCode::GenerationMismatch,
        format!("generation {generation_id} is not built or was released"),
    )
}

fn query_response(
    result: RepoIntelQueryResult,
    overlay_digest: Option<Digest>,
) -> TransportResponse {
    let RepoIntelQueryResult {
        status,
        generation_id,
        text,
        unavailable_reason,
    } = result;
    match status {
        RepoIntelStatus::Partial => {
            let Some(text) = text else {
                return TransportResponse::error(
                    WireErrorCode::Rejected,
                    "PARTIAL query result carried no text payload",
                );
            };
            TransportResponse::Query(QueryResponse::Partial {
                generation_id: text.generation_digest,
                overlay_digest: text.overlay_digest,
                matches: text.matches,
                next_cursor: text.next_cursor.map(|cursor| cursor.as_token().to_owned()),
                work_units: text.work_units as u64,
                truncated_by: text.truncated_by,
            })
        }
        RepoIntelStatus::Unavailable => {
            let Some(RepoIntelUnavailableReason::UnsupportedOperation(operation)) =
                unavailable_reason
            else {
                return TransportResponse::error(
                    WireErrorCode::Rejected,
                    "UNAVAILABLE query result carried no operation reason",
                );
            };
            TransportResponse::Query(QueryResponse::Unavailable {
                generation_id,
                overlay_digest,
                operation,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BaseGeneration, FileSnapshot, GenerationPins, SearchTruncation};

    fn pin(value: &str) -> OpaquePin {
        OpaquePin::new(value.as_bytes().to_vec()).expect("valid pin")
    }

    fn pins(revision: &str) -> GenerationPins {
        GenerationPins {
            repository: pin("repo-1"),
            workspace: None,
            revision_set: pin(revision),
            read_scope: pin("scope-1"),
            read_policy: pin("policy-1"),
            source_receipt: pin("receipt-1"),
            parser_set: pin("parser-1"),
        }
    }

    fn pack(revision: &str, files: Vec<(&str, &str)>) -> GenerationPack {
        let generation = BaseGeneration::build(
            pins(revision),
            files
                .into_iter()
                .map(|(path, contents)| FileSnapshot::new(path, contents.as_bytes().to_vec()))
                .collect::<Vec<_>>(),
        )
        .expect("generation");
        GenerationPack::from_generation(&generation).expect("pack")
    }

    fn build(handler: &mut TransportHandler, pack: GenerationPack) -> Digest {
        match handler.handle(TransportRequest::Build { pack }) {
            TransportResponse::Build { generation_id } => generation_id,
            other => panic!("expected a build response, got {other:?}"),
        }
    }

    fn error_code(response: TransportResponse) -> WireErrorCode {
        match response {
            TransportResponse::Error { code, .. } => code,
            other => panic!("expected an error response, got {other:?}"),
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
    fn building_an_equal_generation_is_idempotent() {
        let mut handler = TransportHandler::new();
        let first = build(&mut handler, pack("rev-1", vec![("a.txt", "alpha\n")]));
        let second = build(&mut handler, pack("rev-1", vec![("a.txt", "alpha\n")]));
        let changed = build(&mut handler, pack("rev-2", vec![("a.txt", "alpha\n")]));

        assert_eq!(first, second);
        assert_ne!(first, changed);
        assert_eq!(handler.generation_count(), 2);
        assert_ne!(first, Digest([0; 32]));
    }

    #[test]
    fn corrupt_packs_become_typed_error_responses() {
        let mut handler = TransportHandler::new();
        let good = pack("rev-1", vec![("a.txt", "alpha\n")]);
        let mut corrupted = good.as_bytes().to_vec();
        let position = corrupted.len() / 2;
        corrupted[position] ^= 0x01;
        let corrupt_pack = GenerationPack::from_encoded(corrupted).expect("bounded wrap");
        assert_eq!(
            error_code(handler.handle(TransportRequest::Build { pack: corrupt_pack })),
            WireErrorCode::Rejected
        );

        let garbage = GenerationPack::from_encoded(vec![0u8; 64]).expect("bounded wrap");
        assert_eq!(
            error_code(handler.handle(TransportRequest::Build { pack: garbage })),
            WireErrorCode::Rejected
        );
        assert_eq!(handler.generation_count(), 0);
    }

    #[test]
    fn unknown_generations_and_overlays_are_typed_mismatches() {
        let mut handler = TransportHandler::new();
        let generation_id = build(&mut handler, pack("rev-1", vec![("a.txt", "alpha\n")]));

        assert_eq!(
            error_code(handler.handle(text_query(Digest([9; 32]), "alpha", 10, None, None))),
            WireErrorCode::GenerationMismatch
        );
        assert_eq!(
            error_code(handler.handle(text_query(
                generation_id,
                "alpha",
                10,
                Some(Digest([8; 32])),
                None
            ))),
            WireErrorCode::OverlayGenerationMismatch
        );
        assert_eq!(
            error_code(handler.handle(TransportRequest::BuildOverlay {
                generation_id: Digest([9; 32]),
                editor_version: pin("editor-1"),
                changes: vec![OverlayChange::Clear {
                    path: "a.txt".to_owned()
                }],
            })),
            WireErrorCode::GenerationMismatch
        );
    }

    #[test]
    fn releases_are_idempotent_and_cascade_overlays() {
        let mut handler = TransportHandler::new();
        let generation_id = build(&mut handler, pack("rev-1", vec![("a.txt", "alpha\n")]));
        let TransportResponse::Overlay { overlay_digest, .. } =
            handler.handle(TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: vec![OverlayChange::Replace(FileSnapshot::new(
                    "a.txt",
                    b"beta\n".to_vec(),
                ))],
            })
        else {
            panic!("expected an overlay response");
        };
        assert_eq!(handler.overlay_count(), 1);

        assert_eq!(
            handler.handle(TransportRequest::ReleaseGeneration { generation_id }),
            TransportResponse::Released
        );
        assert_eq!(handler.generation_count(), 0);
        assert_eq!(handler.overlay_count(), 0);
        assert_eq!(
            handler.handle(TransportRequest::ReleaseGeneration { generation_id }),
            TransportResponse::Released
        );
        assert_eq!(
            handler.handle(TransportRequest::ReleaseOverlay { overlay_digest }),
            TransportResponse::Released
        );
    }

    #[test]
    fn overlay_batches_are_validated_against_the_exact_generation() {
        let mut handler = TransportHandler::new();
        let generation_id = build(
            &mut handler,
            pack("rev-1", vec![("a.txt", "alpha\n"), ("b.txt", "beta\n")]),
        );

        assert_eq!(
            error_code(handler.handle(TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: Vec::new(),
            })),
            WireErrorCode::Rejected
        );
        assert_eq!(
            error_code(handler.handle(TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: vec![OverlayChange::Clear {
                    path: "missing.txt".to_owned()
                }],
            })),
            WireErrorCode::Rejected
        );
        assert_eq!(
            error_code(handler.handle(TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: vec![
                    OverlayChange::Clear {
                        path: "a.txt".to_owned()
                    },
                    OverlayChange::Replace(FileSnapshot::new("a.txt", b"gamma\n".to_vec())),
                ],
            })),
            WireErrorCode::Rejected
        );
        assert_eq!(handler.overlay_count(), 0);
    }

    #[test]
    fn query_validation_is_typed() {
        let mut handler = TransportHandler::new();
        let generation_id = build(&mut handler, pack("rev-1", vec![("a.txt", "alpha\n")]));

        for (query, max_results, expected) in [
            ("", 10, WireErrorCode::EmptyQuery),
            ("line\nline", 10, WireErrorCode::MultilineQuery),
            ("alpha", 0, WireErrorCode::InvalidResultLimit),
            ("alpha", 101, WireErrorCode::InvalidResultLimit),
        ] {
            assert_eq!(
                error_code(handler.handle(text_query(
                    generation_id,
                    query,
                    max_results,
                    None,
                    None
                ))),
                expected,
                "{query:?} / {max_results}"
            );
        }
        assert_eq!(
            error_code(handler.handle(text_query(generation_id, &"q".repeat(257), 10, None, None))),
            WireErrorCode::QueryTooLarge
        );
    }

    #[test]
    fn symbol_queries_are_typed_unavailable() {
        let mut handler = TransportHandler::new();
        let generation_id = build(
            &mut handler,
            pack("rev-1", vec![("a.rs", "fn alpha() {}\n")]),
        );
        let TransportResponse::Overlay { overlay_digest, .. } =
            handler.handle(TransportRequest::BuildOverlay {
                generation_id,
                editor_version: pin("editor-1"),
                changes: vec![OverlayChange::Replace(FileSnapshot::new(
                    "a.rs",
                    b"fn beta() {}\n".to_vec(),
                ))],
            })
        else {
            panic!("expected an overlay response");
        };

        assert_eq!(
            handler.handle(TransportRequest::Query {
                generation_id,
                operation: RepoIntelOperation::Symbol,
                query: "alpha".to_owned(),
                max_results: 10,
                overlay_digest: Some(overlay_digest),
                cursor: None,
            }),
            TransportResponse::Query(QueryResponse::Unavailable {
                generation_id,
                overlay_digest: Some(overlay_digest),
                operation: RepoIntelOperation::Symbol,
            })
        );
    }

    #[test]
    fn cursors_are_parsed_and_bound_to_their_generation() {
        let mut handler = TransportHandler::new();
        let first_id = build(
            &mut handler,
            pack("rev-1", vec![("a.txt", "alpha\nalpha\n")]),
        );
        let second_id = build(
            &mut handler,
            pack("rev-2", vec![("a.txt", "alpha\nalpha\n")]),
        );

        assert_eq!(
            error_code(handler.handle(text_query(
                first_id,
                "alpha",
                10,
                None,
                Some("not-a-cursor".to_owned())
            ))),
            WireErrorCode::InvalidSearchCursor
        );

        let first_page = partial(handler.handle(text_query(first_id, "alpha", 1, None, None)));
        let cursor = match first_page {
            QueryResponse::Partial {
                next_cursor: Some(cursor),
                truncated_by,
                ..
            } => {
                assert_eq!(truncated_by, Some(SearchTruncation::ResultLimit));
                cursor
            }
            other => panic!("expected a truncated page, got {other:?}"),
        };

        let second_page =
            partial(handler.handle(text_query(first_id, "alpha", 1, None, Some(cursor.clone()))));
        match second_page {
            QueryResponse::Partial { matches, .. } => {
                assert_eq!(matches.len(), 1);
                assert_eq!(matches[0].start_line, 2);
            }
            other => panic!("expected a second page, got {other:?}"),
        }

        assert_eq!(
            error_code(handler.handle(text_query(second_id, "alpha", 1, None, Some(cursor)))),
            WireErrorCode::CursorGenerationMismatch
        );
    }

    #[test]
    fn handle_frame_round_trips_one_request_and_response() {
        let mut handler = TransportHandler::new();
        let pack = pack("rev-1", vec![("a.txt", "alpha\n")]);
        let frame = TransportRequest::Build { pack: pack.clone() }
            .encode()
            .expect("encode");
        let response_frame = handler.handle_frame(&frame).expect("handle");
        let response = TransportResponse::decode(&response_frame).expect("decode");
        let TransportResponse::Build { generation_id } = response else {
            panic!("expected a build response");
        };

        let query_frame = text_query(generation_id, "alpha", 10, None, None)
            .encode()
            .expect("encode");
        let response =
            TransportResponse::decode(&handler.handle_frame(&query_frame).expect("handle"))
                .expect("decode");
        match partial(response) {
            QueryResponse::Partial { matches, .. } => {
                assert_eq!(matches.len(), 1);
                assert_eq!(matches[0].path, "a.txt");
            }
            other => panic!("expected a partial response, got {other:?}"),
        }

        let mut corrupt = frame.clone();
        let position = corrupt.len() - 1;
        corrupt[position] ^= 0x01;
        assert!(matches!(
            handler.handle_frame(&corrupt),
            Err(TransportError::ChecksumMismatch)
        ));
    }
}
