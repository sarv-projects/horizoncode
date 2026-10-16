use horizon_indexd_library::{
    BufferOverlay, FileSnapshot, GenerationPins, IndexError, OpaquePin, RepoIntelGeneration,
    RepoIntelOperation, RepoIntelQuery, RepoIntelStatus, RepoIntelUnavailableReason,
    SearchTruncation,
};

fn pin(value: &str) -> OpaquePin {
    OpaquePin::new(value.as_bytes().to_vec()).unwrap()
}

fn pins(revision: &str, policy: &str) -> GenerationPins {
    GenerationPins {
        repository: pin("repo-1"),
        workspace: Some(pin("workspace-1")),
        revision_set: pin(revision),
        read_scope: pin("read-scope-1"),
        read_policy: pin(policy),
        source_receipt: pin("receipt-1"),
        parser_set: pin("parser-set-1"),
    }
}

fn snapshot(path: &str, contents: &str) -> FileSnapshot {
    FileSnapshot::new(path, contents.as_bytes().to_vec())
}

fn query(generation: &RepoIntelGeneration, operation: RepoIntelOperation) -> RepoIntelQuery {
    RepoIntelQuery {
        generation_id: generation.id(),
        operation,
        query: "needle".to_owned(),
        max_results: 10,
        overlay: None,
        cursor: None,
    }
}

#[test]
fn text_query_returns_generation_bound_partial_matches() {
    let generation = RepoIntelGeneration::build(
        pins("rev-1", "policy-1"),
        vec![snapshot("src/a.rs", "let needle = 1;\n"), snapshot("src/b.rs", "none\n")],
    )
    .unwrap();

    let result = generation.query(query(&generation, RepoIntelOperation::Text)).unwrap();
    assert_eq!(result.status, RepoIntelStatus::Partial);
    assert_eq!(result.generation_id, generation.id());
    let search = result.text.unwrap();
    assert_eq!(search.matches.len(), 1);
    assert_eq!(search.matches[0].path, "src/a.rs");
    assert_eq!(search.matches[0].start_line, 1);
}

#[test]
fn revision_or_policy_change_invalidates_prior_generation_and_cursor() {
    let snapshots = vec![
        snapshot("a.txt", "needle\nneedle\n"),
        snapshot("b.txt", "needle\n"),
    ];
    let old = RepoIntelGeneration::build(pins("rev-1", "policy-1"), snapshots.clone()).unwrap();
    let first = old
        .query(RepoIntelQuery {
            max_results: 1,
            ..query(&old, RepoIntelOperation::Text)
        })
        .unwrap();
    let cursor = first.text.unwrap().next_cursor.unwrap();

    for changed in [
        RepoIntelGeneration::build(pins("rev-2", "policy-1"), snapshots.clone()).unwrap(),
        RepoIntelGeneration::build(pins("rev-1", "policy-2"), snapshots.clone()).unwrap(),
    ] {
        assert_ne!(old.id(), changed.id());
        let mut stale_identity = query(&changed, RepoIntelOperation::Text);
        stale_identity.generation_id = old.id();
        assert!(matches!(
            changed.query(stale_identity),
            Err(IndexError::GenerationMismatch { .. })
        ));

        let mut stale_cursor = query(&changed, RepoIntelOperation::Text);
        stale_cursor.cursor = Some(cursor.clone());
        assert!(matches!(
            changed.query(stale_cursor),
            Err(IndexError::CursorGenerationMismatch)
        ));
    }
}

#[test]
fn overlay_from_another_generation_is_rejected() {
    let first = RepoIntelGeneration::build(
        pins("rev-1", "policy-1"),
        vec![snapshot("a.txt", "needle\n")],
    )
    .unwrap();
    let second = RepoIntelGeneration::build(
        pins("rev-2", "policy-1"),
        vec![snapshot("a.txt", "needle\n")],
    )
    .unwrap();
    let overlay = BufferOverlay::build(
        first.base(),
        pin("editor-1"),
        vec![snapshot("a.txt", "changed\n")],
    )
    .unwrap();
    let mut request = query(&second, RepoIntelOperation::Text);
    request.overlay = Some(overlay);
    assert!(matches!(
        second.query(request),
        Err(IndexError::OverlayGenerationMismatch { .. })
    ));
}

#[test]
fn result_limit_is_reported_as_partial_with_a_continuation_cursor() {
    let generation = RepoIntelGeneration::build(
        pins("rev-1", "policy-1"),
        vec![snapshot("a.txt", "needle\nneedle\nneedle\n")],
    )
    .unwrap();
    let result = generation
        .query(RepoIntelQuery {
            max_results: 1,
            ..query(&generation, RepoIntelOperation::Text)
        })
        .unwrap();
    let search = result.text.unwrap();
    assert_eq!(search.matches.len(), 1);
    assert_eq!(search.truncated_by, Some(SearchTruncation::ResultLimit));
    assert!(search.next_cursor.is_some());
}

#[test]
fn symbol_and_reference_queries_are_typed_unavailable() {
    let generation = RepoIntelGeneration::build(
        pins("rev-1", "policy-1"),
        vec![snapshot("a.rs", "fn needle() {}\n")],
    )
    .unwrap();

    for operation in [
        RepoIntelOperation::Symbol,
        RepoIntelOperation::References,
        RepoIntelOperation::Impact,
        RepoIntelOperation::Expand,
    ] {
        let result = generation.query(query(&generation, operation)).unwrap();
        assert_eq!(result.status, RepoIntelStatus::Unavailable);
        assert!(result.text.is_none());
        assert_eq!(
            result.unavailable_reason,
            Some(RepoIntelUnavailableReason::UnsupportedOperation(operation))
        );
    }
}
