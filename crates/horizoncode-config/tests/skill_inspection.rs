//! AX-405 content-free, digest-bound skill inspection.
use horizoncode_config::{SkillError, discover_skills_with, inspect_skill};

fn fixture(body: &str) -> (tempfile::TempDir, horizoncode_config::SkillSummary) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("repo/.horizoncode/skills/review/SKILL.md");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        format!("---\nname: review\ndescription: inspect changes\n---\n{body}"),
    )
    .unwrap();
    let catalog = discover_skills_with(&dir.path().join("repo"), &dir.path().join("home"));
    (dir, catalog.get("review").unwrap().clone())
}

#[test]
fn inspection_counts_utf8_bytes_and_rounds_up_without_returning_content() {
    for (body, bytes, tokens) in [
        ("", 0, 0),
        ("a", 1, 1),
        ("abcd", 4, 1),
        ("abcde", 5, 2),
        ("秘密\r\n", 8, 2),
        ("SECRET BODY TEXT\n", 17, 5),
    ] {
        let (_dir, summary) = fixture(body);
        let result = inspect_skill(&summary).unwrap();
        assert_eq!(result.body_bytes, bytes);
        assert_eq!(result.estimated_body_tokens, tokens);
        assert!(!format!("{result:?}").contains("SECRET BODY TEXT"));
    }
}

#[test]
fn inspection_refuses_body_changed_since_discovery() {
    let (_dir, summary) = fixture("old body");
    std::fs::write(
        &summary.location,
        "---\nname: review\ndescription: changed\n---\nnew",
    )
    .unwrap();
    assert!(matches!(
        inspect_skill(&summary),
        Err(SkillError::Changed { .. })
    ));
}

#[test]
fn inspection_refuses_missing_file() {
    let (_dir, summary) = fixture("body");
    std::fs::remove_file(&summary.location).unwrap();
    assert!(matches!(
        inspect_skill(&summary),
        Err(SkillError::Unreadable { .. })
    ));
}

#[cfg(unix)]
#[test]
fn inspection_refuses_replacement_symlink_even_with_identical_bytes() {
    let (dir, summary) = fixture("body");
    let replacement = dir.path().join("replacement.md");
    std::fs::copy(&summary.location, &replacement).unwrap();
    std::fs::remove_file(&summary.location).unwrap();
    std::os::unix::fs::symlink(replacement, &summary.location).unwrap();
    assert!(matches!(
        inspect_skill(&summary),
        Err(SkillError::Unreadable { .. })
    ));
}
