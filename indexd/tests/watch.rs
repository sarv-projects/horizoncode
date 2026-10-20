use horizon_indexd_library::{
    FileSnapshot, GenerationLifecycle, GenerationPins, IndexError, LifecycleState, OpaquePin,
    RepoIntelGeneration, RepoIntelOperation, RepoIntelQuery, RepoIntelStatus, WatchBatch,
    WatchBatcher, WatchChange, WatchChangeKind, WatchClassification, WatchDecision,
};

fn pin(value: &str) -> OpaquePin {
    OpaquePin::new(value.as_bytes().to_vec()).unwrap()
}

fn pins(revision: &str) -> GenerationPins {
    GenerationPins {
        repository: pin("repo-1"),
        workspace: Some(pin("workspace-1")),
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

fn change(path: &str, kind: WatchChangeKind) -> WatchChange {
    WatchChange {
        path: path.to_owned(),
        kind,
    }
}

#[test]
fn watcher_batcher_debounces_and_coalesces_a_path_to_its_net_change() {
    let mut batcher = WatchBatcher::new(20);
    batcher
        .push(100, change("src/new.rs", WatchChangeKind::Added))
        .unwrap();
    batcher
        .push(105, change("src/new.rs", WatchChangeKind::Modified))
        .unwrap();
    assert!(batcher.take_due(124).is_none());
    let batch = batcher.take_due(125).unwrap();
    assert_eq!(
        batch,
        WatchBatch::Changes(vec![change("src/new.rs", WatchChangeKind::Added)])
    );
    assert!(batcher.is_empty());
}

#[test]
fn watcher_batcher_keeps_ambiguous_create_remove_invalidating_and_marks_overflow() {
    let mut batcher = WatchBatcher::new(10);
    batcher
        .push(0, change("src/temp.rs", WatchChangeKind::Added))
        .unwrap();
    batcher
        .push(1, change("src/temp.rs", WatchChangeKind::Removed))
        .unwrap();
    assert_eq!(
        batcher.take_due(11),
        Some(WatchBatch::Changes(vec![change(
            "src/temp.rs",
            WatchChangeKind::Removed,
        )]))
    );

    for index in 0..=horizon_indexd_library::MAX_WATCH_CHANGES {
        batcher
            .push(
                20,
                change(&format!("src/{index}.rs"), WatchChangeKind::Modified),
            )
            .unwrap();
    }
    assert_eq!(batcher.take_due(30), Some(WatchBatch::FullRescanRequired));
}

#[test]
fn invalidation_epoch_prevents_an_old_build_from_replacing_newer_source_state() {
    let generation =
        RepoIntelGeneration::build(pins("rev-1"), vec![snapshot("a.txt", "needle\n")]).unwrap();
    let mut lifecycle = GenerationLifecycle::default();
    let old_build = lifecycle.begin_build().unwrap();
    assert_eq!(lifecycle.state(), LifecycleState::Building);
    lifecycle.invalidate().unwrap();
    let new_build = lifecycle.begin_build().unwrap();

    assert!(!lifecycle.complete(old_build, generation.id(), true));
    assert_eq!(lifecycle.state(), LifecycleState::Building);
    assert!(lifecycle.complete(new_build, generation.id(), false));
    assert_eq!(lifecycle.state(), LifecycleState::Partial);
}

fn query(generation: &RepoIntelGeneration) -> RepoIntelQuery {
    RepoIntelQuery {
        generation_id: generation.id(),
        operation: RepoIntelOperation::Text,
        query: "needle".to_owned(),
        max_results: 10,
        overlay: None,
        cursor: None,
    }
}

#[test]
fn reusable_classification_keeps_the_generation_and_cursor_valid() {
    let generation =
        RepoIntelGeneration::build(pins("rev-1"), vec![snapshot("a.txt", "needle\nneedle\n")])
            .unwrap();
    let first = generation
        .query(RepoIntelQuery {
            max_results: 1,
            ..query(&generation)
        })
        .unwrap();
    let cursor = first.text.unwrap().next_cursor.unwrap();

    let classification = WatchClassification::classify(generation.base(), &[]).unwrap();
    assert_eq!(classification.decision, WatchDecision::Reusable);
    assert_eq!(classification.base_generation_digest, generation.id());

    let second = generation
        .query(RepoIntelQuery {
            max_results: 1,
            cursor: Some(cursor),
            ..query(&generation)
        })
        .unwrap();
    assert_eq!(second.status, RepoIntelStatus::Partial);
    assert_eq!(second.text.unwrap().matches.len(), 1);
}

#[test]
fn disk_modification_requires_rebuild_and_never_becomes_an_editor_overlay() {
    let generation = RepoIntelGeneration::build(
        pins("rev-1"),
        vec![snapshot("a.txt", "needle\n"), snapshot("b.txt", "other\n")],
    )
    .unwrap();

    let classification = WatchClassification::classify(
        generation.base(),
        &[change("a.txt", WatchChangeKind::Modified)],
    )
    .unwrap();
    assert_eq!(classification.decision, WatchDecision::RebuildRequired);
    assert_eq!(classification.modified_paths, vec!["a.txt".to_owned()]);

    let rebuilt = RepoIntelGeneration::build(
        pins("rev-2"),
        vec![
            snapshot("a.txt", "needle needle\n"),
            snapshot("b.txt", "other\n"),
        ],
    )
    .unwrap();
    assert_ne!(rebuilt.id(), generation.id());
    assert_eq!(
        rebuilt
            .query(query(&rebuilt))
            .unwrap()
            .text
            .unwrap()
            .matches
            .len(),
        1
    );
    assert!(matches!(
        generation.query(query(&rebuilt)),
        Err(IndexError::GenerationMismatch { .. })
    ));
}

#[test]
fn rebuild_required_classification_produces_a_new_generation_and_stales_old_cursors() {
    let generation =
        RepoIntelGeneration::build(pins("rev-1"), vec![snapshot("a.txt", "needle\nneedle\n")])
            .unwrap();
    let first = generation
        .query(RepoIntelQuery {
            max_results: 1,
            ..query(&generation)
        })
        .unwrap();
    let cursor = first.text.unwrap().next_cursor.unwrap();

    let classification = WatchClassification::classify(
        generation.base(),
        &[
            change("a.txt", WatchChangeKind::Modified),
            change("c.txt", WatchChangeKind::Added),
        ],
    )
    .unwrap();
    assert_eq!(classification.decision, WatchDecision::RebuildRequired);
    assert_eq!(classification.added_paths, vec!["c.txt".to_owned()]);
    assert_eq!(classification.modified_paths, vec!["a.txt".to_owned()]);

    let rebuilt = RepoIntelGeneration::build(
        pins("rev-2"),
        vec![
            snapshot("a.txt", "needle needle\n"),
            snapshot("c.txt", "needle\n"),
        ],
    )
    .unwrap();
    assert_ne!(rebuilt.id(), generation.id());

    let stale = RepoIntelQuery {
        cursor: Some(cursor),
        ..query(&rebuilt)
    };
    assert!(matches!(
        rebuilt.query(stale),
        Err(IndexError::CursorGenerationMismatch)
    ));

    let fresh = rebuilt.query(query(&rebuilt)).unwrap();
    assert_eq!(fresh.text.unwrap().matches.len(), 2);
}
