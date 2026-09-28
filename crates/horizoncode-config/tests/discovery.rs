//! Discovery order and fail-safe reporting (`ARCH/18` §Discovery walk).

use std::fs;
use std::path::Path;

use horizoncode_config::{ConfigLayer, discover_with};

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn the_order_is_global_then_outermost_to_nearest() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let project = dir.path().join("project");
    write(&home.join("config.jsonc"), "{}");
    write(&project.join(".horizoncode/config.jsonc"), "{}");
    write(&project.join("sub/.horizoncode/config.jsonc"), "{}");

    let discovery = discover_with(&project.join("sub"), Some(&home));
    assert!(discovery.issues.is_empty(), "{:?}", discovery.issues);
    let layers: Vec<ConfigLayer> = discovery.sources.iter().map(|s| s.layer).collect();
    assert_eq!(
        layers,
        vec![
            ConfigLayer::Global,
            ConfigLayer::Project,
            ConfigLayer::Project
        ]
    );
    assert_eq!(
        discovery.sources[0].path,
        home.join("config.jsonc"),
        "global first"
    );
    assert_eq!(
        discovery.sources[1].path,
        project.join(".horizoncode/config.jsonc"),
        "outer before nearest"
    );
    assert_eq!(
        discovery.sources[2].path,
        project.join("sub/.horizoncode/config.jsonc"),
        "nearest last"
    );
}

#[test]
fn a_missing_file_is_absent_not_an_issue() {
    let dir = tempfile::tempdir().unwrap();
    let discovery = discover_with(dir.path(), Some(&dir.path().join("no-home")));
    assert!(discovery.sources.is_empty());
    assert!(discovery.issues.is_empty());
}

#[test]
fn a_layer_path_that_exists_but_cannot_be_used_is_reported() {
    // A directory where a config file belongs is silently skipped by a
    // `is_file()` check; discovery must say so instead.
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir_all(project.join(".horizoncode/config.jsonc")).unwrap();

    let discovery = discover_with(&project, None);
    assert!(discovery.sources.is_empty());
    assert_eq!(discovery.issues.len(), 1, "{:?}", discovery.issues);
    assert_eq!(
        discovery.issues[0].path,
        project.join(".horizoncode/config.jsonc")
    );
    assert!(
        discovery.issues[0].detail.contains("not a regular file"),
        "{}",
        discovery.issues[0].detail
    );
}

#[test]
fn a_home_environment_override_is_a_single_directory() {
    // The environment variable names the state root itself, and every store
    // joins onto it; the fallback appends `.horizoncode` instead of writing
    // into the home directory (see `state_root_from`).
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("state");
    write(&home.join("config.jsonc"), "{}");
    let discovery = discover_with(dir.path(), Some(&home));
    assert_eq!(discovery.sources.len(), 1);
    assert_eq!(discovery.sources[0].path, home.join("config.jsonc"));
}
