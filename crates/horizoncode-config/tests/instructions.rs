//! Hierarchical `AGENTS.md` discovery and rendering (`ARCH/09` §6,
//! `REQ-CTX-005`).

use std::fs;
use std::path::{Path, PathBuf};

use horizoncode_config::{
    InstructionScope, InstructionsError, discover_instructions_with, discover_skills_with,
    discover_with, load, read_instruction, render_instructions,
};

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn git_repo(path: &Path) {
    write(&path.join(".git/HEAD"), "ref: refs/heads/main\n");
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
    git_repo(&repo);
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
    git_repo(&repo);
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
    // An empty `.git` directory is not repository metadata and must not become
    // a false boundary (for example, when the host has an empty /tmp/.git).
    fs::create_dir_all(above.join(".git")).unwrap();
    write(&above.join("AGENTS.md"), "must not leak\n");
    write(
        &above.join(".horizoncode/skills/parent/SKILL.md"),
        "---\nname: parent\ndescription: parent skill\n---\n",
    );
    let work = above.join("work");
    write(&work.join("AGENTS.md"), "the working directory\n");
    write(
        &work.join(".horizoncode/skills/local/SKILL.md"),
        "---\nname: local\ndescription: local skill\n---\n",
    );

    let sources = discover_instructions_with(&work, &home).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(paths, vec![canon(&work.join("AGENTS.md"))]);

    let skills = discover_skills_with(&work, &home);
    let names: Vec<&str> = skills
        .skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["local"],
        "invalid ambient marker must bound neither instructions nor skills"
    );
}

#[test]
fn a_discovered_file_that_cannot_be_read_is_typed_not_omitted() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    git_repo(&repo);
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
    git_repo(&repo);
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
    git_repo(&repo);
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

#[cfg(unix)]
#[test]
fn a_symlinked_instruction_file_is_refused_not_read() {
    // A repository can plant `AGENTS.md` as a link to a host file; following it
    // would pull that file into the model's context.
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    git_repo(&repo);
    let secret = dir.path().join("outside-secret.txt");
    fs::write(&secret, "host secret\n").unwrap();
    std::os::unix::fs::symlink(&secret, repo.join("AGENTS.md")).unwrap();

    let error = discover_instructions_with(&repo, &dir.path().join("home")).unwrap_err();
    assert!(
        matches!(error, InstructionsError::Unreadable { .. }),
        "{error}"
    );
    assert!(error.to_string().contains("symlink"), "{error}");
}

#[test]
fn a_worktree_gitdir_pointer_is_a_project_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let repo = dir.path().join("repo");
    let gitdir = dir.path().join("metadata/worktrees/repo");
    write(&gitdir.join("HEAD"), "ref: refs/heads/topic\n");
    write(&repo.join(".git"), "gitdir: ../metadata/worktrees/repo\n");
    write(&dir.path().join("AGENTS.md"), "outside worktree\n");
    write(&repo.join("AGENTS.md"), "worktree rules\n");
    let cwd = repo.join("src");
    fs::create_dir_all(&cwd).unwrap();

    let sources = discover_instructions_with(&cwd, &home).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(paths, vec![canon(&repo.join("AGENTS.md"))]);
}

#[test]
fn an_absolute_worktree_pointer_with_spaces_and_crlf_is_a_project_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let repo = dir.path().join("repo");
    let gitdir = dir.path().join("git metadata/worktrees/repo");
    write(&gitdir.join("HEAD"), "ref: refs/heads/topic\n");
    write(
        &repo.join(".git"),
        &format!("gitdir: {}\r\n", gitdir.display()),
    );
    write(&repo.join("AGENTS.md"), "worktree rules\n");
    let cwd = repo.join("src");
    fs::create_dir_all(&cwd).unwrap();

    let sources = discover_instructions_with(&cwd, &home).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(paths, vec![canon(&repo.join("AGENTS.md"))]);
}

#[test]
fn a_git_directory_with_malformed_head_is_not_a_boundary() {
    for head in [
        "not a HEAD record\n",
        "ref: refs/../main\n",
        "ref: refs/heads/a..b\n",
        "ref: refs/heads/foo.lock\n",
        "ref: refs/heads/foo/\n",
        "ref: refs/heads//foo\n",
        "ref: refs/heads/.hidden\n",
        "ref: refs/heads/@{x\n",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let above = dir.path().join("above");
        write(&above.join(".git/HEAD"), head);
        write(&above.join("AGENTS.md"), "outside invalid marker\n");
        let work = above.join("work");
        write(&work.join("AGENTS.md"), "working directory\n");

        let sources = discover_instructions_with(&work, &dir.path().join("home")).unwrap();
        let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
        assert_eq!(paths, vec![canon(&work.join("AGENTS.md"))], "{head:?}");
    }
}

#[test]
fn long_symbolic_and_detached_git_heads_are_project_boundaries() {
    for head in [
        format!("ref: refs/heads/{}\n", "a".repeat(256)),
        format!("{}\n", "a".repeat(40)),
        format!("{}\n", "b".repeat(64)),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        write(&repo.join(".git/HEAD"), &head);
        write(&repo.join("AGENTS.md"), "repo rules\n");
        let cwd = repo.join("src");
        fs::create_dir_all(&cwd).unwrap();

        let sources = discover_instructions_with(&cwd, &dir.path().join("home")).unwrap();
        let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
        assert_eq!(paths, vec![canon(&repo.join("AGENTS.md"))], "{head:?}");
    }
}

#[test]
fn oversized_git_pointer_and_head_files_are_ignored_without_unbounded_reads() {
    let dir = tempfile::tempdir().unwrap();
    let above = dir.path().join("above");
    write(&above.join(".git"), &format!("x{}", "x".repeat(8_192)));
    write(&above.join("AGENTS.md"), "outside invalid marker\n");
    let work = above.join("work");
    write(&work.join("AGENTS.md"), "working directory\n");
    let sources = discover_instructions_with(&work, &dir.path().join("home")).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(paths, vec![canon(&work.join("AGENTS.md"))]);

    let dir = tempfile::tempdir().unwrap();
    let above = dir.path().join("above");
    write(
        &above.join(".git/HEAD"),
        &format!("ref: refs/heads/{}\n", "a".repeat(65_536)),
    );
    write(&above.join("AGENTS.md"), "outside invalid marker\n");
    let work = above.join("work");
    write(&work.join("AGENTS.md"), "working directory\n");
    let sources = discover_instructions_with(&work, &dir.path().join("home")).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(paths, vec![canon(&work.join("AGENTS.md"))]);
}

#[cfg(unix)]
#[test]
fn a_symlinked_git_head_is_not_a_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let above = dir.path().join("above");
    let outside_head = dir.path().join("outside-head");
    write(&outside_head, "ref: refs/heads/main\n");
    fs::create_dir_all(above.join(".git")).unwrap();
    std::os::unix::fs::symlink(&outside_head, above.join(".git/HEAD")).unwrap();
    write(&above.join("AGENTS.md"), "outside invalid marker\n");
    let work = above.join("work");
    write(&work.join("AGENTS.md"), "working directory\n");

    let sources = discover_instructions_with(&work, &dir.path().join("home")).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(paths, vec![canon(&work.join("AGENTS.md"))]);
}

#[cfg(unix)]
#[test]
fn an_unreadable_git_head_conservatively_stops_the_walk() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let above = dir.path().join("above");
    let head = above.join(".git/HEAD");
    write(&head, "ref: refs/heads/main\n");
    fs::set_permissions(&head, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read_to_string(&head).is_ok() {
        // Root and privileged test runners can still read mode-000 files.
        return;
    }
    write(
        &dir.path().join("AGENTS.md"),
        "must not load above boundary\n",
    );
    write(&above.join("AGENTS.md"), "boundary rules\n");
    let work = above.join("work");
    write(&work.join("AGENTS.md"), "nearest rules\n");

    let sources = discover_instructions_with(&work, &dir.path().join("home")).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(
        paths,
        vec![
            canon(&above.join("AGENTS.md")),
            canon(&work.join("AGENTS.md"))
        ]
    );
}

#[test]
fn malformed_or_dangling_git_markers_do_not_stop_the_walk() {
    for marker in [
        "not git metadata\n",
        "gitdir: missing/metadata\n",
        "gitdir: \0/metadata\n",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let above = dir.path().join("above");
        write(&above.join(".git"), marker);
        write(&above.join("AGENTS.md"), "outside invalid marker\n");
        let work = above.join("work");
        write(&work.join("AGENTS.md"), "working directory\n");

        let sources = discover_instructions_with(&work, &dir.path().join("home")).unwrap();
        let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
        assert_eq!(paths, vec![canon(&work.join("AGENTS.md"))], "{marker:?}");
    }
}

#[cfg(unix)]
#[test]
fn a_symlinked_git_marker_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let above = dir.path().join("above");
    let metadata = dir.path().join("real-git");
    git_repo(&metadata);
    fs::create_dir_all(&above).unwrap();
    std::os::unix::fs::symlink(metadata.join(".git"), above.join(".git")).unwrap();
    write(&above.join("AGENTS.md"), "outside symlink marker\n");
    let work = above.join("work");
    write(&work.join("AGENTS.md"), "working directory\n");

    let sources = discover_instructions_with(&work, &dir.path().join("home")).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(paths, vec![canon(&work.join("AGENTS.md"))]);
}

#[cfg(unix)]
#[test]
fn a_symlinked_project_config_directory_is_not_a_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let above = dir.path().join("above");
    let external = dir.path().join("external-config");
    fs::create_dir_all(&above).unwrap();
    fs::create_dir_all(&external).unwrap();
    std::os::unix::fs::symlink(&external, above.join(".horizoncode")).unwrap();
    write(&above.join("AGENTS.md"), "outside symlink marker\n");
    let work = above.join("work");
    write(&work.join("AGENTS.md"), "working directory\n");

    let sources = discover_instructions_with(&work, &dir.path().join("home")).unwrap();
    let paths: Vec<PathBuf> = sources.iter().map(|source| source.path.clone()).collect();
    assert_eq!(paths, vec![canon(&work.join("AGENTS.md"))]);
}
