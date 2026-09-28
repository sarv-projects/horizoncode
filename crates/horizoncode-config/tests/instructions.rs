//! Hierarchical `AGENTS.md` discovery and rendering (`ARCH/09` §6,
//! `REQ-CTX-005`).

use std::fs;
use std::path::{Path, PathBuf};

use horizoncode_config::{
    InstructionScope, InstructionsError, discover_instructions_with, discover_with, load,
    read_instruction, render_instructions,
};

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn canon(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap()
}

#[test]
fn the_walk_is_global_then_outermost_to_nearest_and_renders_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let repo = dir.path().join("repo");
    write(&home.join("AGENTS.md"), "global rules\n");
    fs::create_dir_all(repo.join(".git")).unwrap();
    write(&repo.join("AGENTS.md"), "repo rules\n");
    write(&repo.join("sub/AGENTS.md"), "sub rules\n");
    let cwd = repo.join("sub/deep");
    fs::create_dir_all(&cwd).unwrap();

    let sources = discover_instructions_with(&cwd, &home).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(
        paths,
        vec![
            canon(&home.join("AGENTS.md")),
            canon(&repo.join("AGENTS.md")),
            canon(&repo.join("sub/AGENTS.md")),
        ]
    );
    let scopes: Vec<InstructionScope> = sources.iter().map(|source| source.scope).collect();
    assert_eq!(
        scopes,
        vec![
            InstructionScope::Global,
            InstructionScope::Project,
            InstructionScope::Project
        ]
    );

    let rendered = render_instructions(&sources);
    assert_eq!(
        rendered,
        format!(
            "Instructions from: {}\nglobal rules\n\nInstructions from: {}\nrepo rules\n\nInstructions from: {}\nsub rules",
            canon(&home.join("AGENTS.md")).display(),
            canon(&repo.join("AGENTS.md")).display(),
            canon(&repo.join("sub/AGENTS.md")).display(),
        )
    );
}

#[test]
fn identical_content_is_deduplicated_by_digest() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let repo = dir.path().join("repo");
    fs::create_dir_all(repo.join(".git")).unwrap();
    write(&repo.join("AGENTS.md"), "the same words\n");
    write(&repo.join("sub/AGENTS.md"), "the same words\n");

    let sources = discover_instructions_with(&repo.join("sub"), &home).unwrap();
    assert_eq!(sources.len(), 1, "{sources:?}");
    assert_eq!(sources[0].path, canon(&repo.join("AGENTS.md")));
}

#[test]
fn without_a_project_marker_nothing_above_the_working_directory_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let above = dir.path().join("above");
    write(&above.join("AGENTS.md"), "must not leak\n");
    let work = above.join("work");
    write(&work.join("AGENTS.md"), "the working directory\n");

    let sources = discover_instructions_with(&work, &home).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(paths, vec![canon(&work.join("AGENTS.md"))]);
}

#[test]
fn a_discovered_file_that_cannot_be_read_is_typed_not_omitted() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir_all(repo.join("AGENTS.md")).unwrap();

    let error = discover_instructions_with(&repo, &dir.path().join("home")).unwrap_err();
    assert!(
        matches!(error, InstructionsError::Unreadable { .. }),
        "{error}"
    );
    assert!(error.to_string().contains("AGENTS.md"), "{error}");
}

#[test]
fn a_missing_global_file_is_simply_absent() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    fs::create_dir_all(repo.join(".git")).unwrap();
    write(&repo.join("AGENTS.md"), "repo rules\n");

    let sources = discover_instructions_with(&repo, &dir.path().join("no-home")).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].scope, InstructionScope::Project);
}

#[test]
fn configured_extra_instructions_load_after_the_walk() {
    // The full loop: config declares an extra file, discovery reads it, and the
    // rendered source names it after the in-repo instructions.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let repo = dir.path().join("repo");
    fs::create_dir_all(repo.join(".git")).unwrap();
    write(&repo.join("AGENTS.md"), "repo rules\n");
    write(&repo.join("docs/team.md"), "team rules\n");
    write(
        &repo.join(".horizoncode/config.jsonc"),
        r#"{ "instructions": { "extra": ["docs/team.md"] } }"#,
    );

    let config = load(&discover_with(&repo, Some(&home)));
    assert!(
        config.diagnostics().is_empty(),
        "{:?}",
        config.diagnostics()
    );
    let mut sources = discover_instructions_with(&repo, &home).unwrap();
    for (path, layer) in config.extra_instruction_paths() {
        sources.push(read_instruction(path, InstructionScope::from_layer(*layer)).unwrap());
    }

    let rendered = render_instructions(&sources);
    assert!(
        rendered.find("repo rules").unwrap() < rendered.find("team rules").unwrap(),
        "extras come after in-repo instructions: {rendered}"
    );
    assert!(rendered.contains(&format!(
        "Instructions from: {}",
        canon(&repo.join("docs/team.md")).display()
    )));
}
