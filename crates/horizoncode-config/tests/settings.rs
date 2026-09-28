//! Typed merge, provenance, and the documented fail-safe behavior
//! (`ARCH/18` §Data / state model, §Failure modes).

use std::fs;
use std::path::Path;

use horizoncode_config::{ApplyBoundary, ConfigLayer, SettingScope, discover_with, load};
use serde_json::json;

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn the_nearest_layer_wins_a_scalar_and_the_earlier_layer_is_recorded_as_shadowed() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let project = dir.path().join("project");
    write(
        &home.join("config.jsonc"),
        r#"{ "ui": { "accessibility": { "reduced_motion": true } } }"#,
    );
    write(
        &project.join(".horizoncode/config.jsonc"),
        r#"{ "ui": { "accessibility": { "reduced_motion": false } } }"#,
    );

    let config = load(&discover_with(&project, Some(&home)));
    assert!(
        config.diagnostics().is_empty(),
        "{:?}",
        config.diagnostics()
    );
    let view = config
        .get("ui.accessibility.reduced_motion")
        .expect("schema key");
    assert_eq!(view.effective_value, json!(false));
    assert_eq!(view.requested_value, Some(json!(false)));
    assert_eq!(view.source_scope, SettingScope::Project);
    assert_eq!(
        view.source_ref.as_deref(),
        Some(project.join(".horizoncode/config.jsonc").as_path())
    );
    assert_eq!(
        view.shadowed_sources,
        vec![home.join("config.jsonc")],
        "the overridden global value stays visible"
    );
    assert_eq!(view.validation_error, None);
    assert_eq!(view.apply_boundary, ApplyBoundary::Immediate);
    assert_eq!(view.schema_version, 1);
}

#[test]
fn the_compiled_default_stands_when_no_layer_sets_a_key() {
    let dir = tempfile::tempdir().unwrap();
    let config = load(&discover_with(dir.path(), None));
    let view = config
        .get("ui.notifications.terminal_bell")
        .expect("schema key");
    assert_eq!(view.effective_value, json!(false));
    assert_eq!(view.requested_value, None);
    assert_eq!(view.source_scope, SettingScope::Default);
    assert_eq!(view.source_ref, None);
    assert!(view.contributors.is_empty());
}

#[test]
fn an_unknown_group_or_key_is_reported_and_never_effective() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    write(
        &home.join("config.jsonc"),
        r#"{ "mystery": { "a": 1 }, "ui": { "mystery": true } }"#,
    );

    let config = load(&discover_with(dir.path(), Some(&home)));
    let details: Vec<&str> = config
        .diagnostics()
        .iter()
        .map(|diagnostic| diagnostic.detail.as_str())
        .collect();
    assert!(
        details
            .iter()
            .any(|d| d.contains("unknown configuration group `mystery`")),
        "{details:?}"
    );
    assert!(
        details
            .iter()
            .any(|d| d.contains("unknown configuration key `ui.mystery`")),
        "{details:?}"
    );
    assert!(
        config
            .diagnostics()
            .iter()
            .all(|diagnostic| diagnostic.path.as_deref()
                == Some(home.join("config.jsonc").as_path()))
    );
}

#[test]
fn a_wrongly_typed_value_is_not_coerced() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let project = dir.path().join("project");
    write(
        &home.join("config.jsonc"),
        r#"{ "ui": { "accessibility": { "reduced_motion": true } } }"#,
    );
    write(
        &project.join(".horizoncode/config.jsonc"),
        r#"{ "ui": { "accessibility": { "reduced_motion": "yes" } } }"#,
    );

    let config = load(&discover_with(&project, Some(&home)));
    let view = config
        .get("ui.accessibility.reduced_motion")
        .expect("schema key");
    assert_eq!(
        view.effective_value,
        json!(true),
        "the last valid value stays effective"
    );
    assert_eq!(
        view.requested_value,
        Some(json!("yes")),
        "the requested value is preserved for display"
    );
    assert_eq!(view.validation_error.as_deref(), Some("must be a boolean"));
    assert_eq!(view.source_scope, SettingScope::Global);
    assert!(
        config
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.key.as_deref() == Some("ui.accessibility.reduced_motion")),
        "the rejection is reported with its key"
    );
}

#[test]
fn a_malformed_layer_contributes_nothing_and_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let project = dir.path().join("project");
    write(
        &home.join("config.jsonc"),
        r#"{ "ui": { "accessibility": { "reduced_motion": true } } }"#,
    );
    write(
        &project.join(".horizoncode/config.jsonc"),
        r#"{ "ui": { "accessibility": "#,
    );

    let config = load(&discover_with(&project, Some(&home)));
    let view = config
        .get("ui.accessibility.reduced_motion")
        .expect("schema key");
    assert_eq!(
        view.effective_value,
        json!(true),
        "a malformed nearer layer cannot blank the value"
    );
    assert_eq!(view.source_scope, SettingScope::Global);
    assert!(
        config.diagnostics().iter().any(|diagnostic| {
            diagnostic.path.as_deref() == Some(project.join(".horizoncode/config.jsonc").as_path())
                && diagnostic.detail.contains("invalid JSON")
        }),
        "{:?}",
        config.diagnostics()
    );
}

#[test]
fn an_unusable_layer_path_is_a_diagnostic_of_the_load_too() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir_all(project.join(".horizoncode/config.jsonc")).unwrap();

    let config = load(&discover_with(&project, None));
    assert!(
        config
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.detail.contains("not a regular file")),
        "{:?}",
        config.diagnostics()
    );
}

#[test]
fn extra_instruction_paths_concatenate_and_resolve_against_the_declaring_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let project = dir.path().join("project");
    write(
        &home.join("config.jsonc"),
        r#"{ "instructions": { "extra": ["global-notes.md"] } }"#,
    );
    write(
        &project.join(".horizoncode/config.jsonc"),
        r#"{ "instructions": { "extra": ["/absolute/extra.md", "docs/extra.md"] } }"#,
    );

    let config = load(&discover_with(&project, Some(&home)));
    let extras = config.extra_instruction_paths();
    assert_eq!(
        extras,
        vec![
            (home.join("global-notes.md"), ConfigLayer::Global),
            (
                std::path::PathBuf::from("/absolute/extra.md"),
                ConfigLayer::Project
            ),
            (project.join("docs/extra.md"), ConfigLayer::Project),
        ]
    );
    let view = config.get("instructions.extra").expect("schema key");
    assert_eq!(
        view.effective_value,
        json!([
            home.join("global-notes.md").to_string_lossy(),
            "/absolute/extra.md",
            project.join("docs/extra.md").to_string_lossy(),
        ])
    );
    assert_eq!(view.apply_boundary, ApplyBoundary::NextTurn);
}

#[test]
fn the_effective_digest_is_stable_and_value_sensitive() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    write(
        &home.join("config.jsonc"),
        r#"{ "ui": { "accessibility": { "screen_reader": true } } }"#,
    );
    let discovery = discover_with(dir.path(), Some(&home));
    let first = load(&discovery)
        .get("ui.accessibility.screen_reader")
        .unwrap()
        .effective_digest
        .clone();
    let again = load(&discovery)
        .get("ui.accessibility.screen_reader")
        .unwrap()
        .effective_digest
        .clone();
    assert_eq!(first, again);

    write(
        &home.join("config.jsonc"),
        r#"{ "ui": { "accessibility": { "screen_reader": false } } }"#,
    );
    let changed = load(&discover_with(dir.path(), Some(&home)))
        .get("ui.accessibility.screen_reader")
        .unwrap()
        .effective_digest
        .clone();
    assert_ne!(first, changed);
}
