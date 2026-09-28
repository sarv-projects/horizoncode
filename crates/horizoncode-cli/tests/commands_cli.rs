//! The slash-command registry as the headless surface exposes it
//! (`ARCH/27` §Target slash-command registry, `AX-344`).
//!
//! These run the binary with no provider environment on purpose: a registry
//! command must answer without a run, and an unknown or malformed command must
//! be a typed refusal rather than model text.

use std::process::Command;

fn run(prompt: &str) -> std::process::Output {
    let home = tempfile::tempdir().unwrap();
    Command::new(env!("CARGO_BIN_EXE_horizoncode"))
        .args(["-p", prompt])
        .env_remove("HORIZONCODE_BASE_URL")
        .env_remove("HORIZONCODE_API_KEY")
        .env_remove("HORIZONCODE_MODEL")
        .env("HORIZONCODE_HOME", home.path())
        .output()
        .unwrap()
}

#[test]
fn help_lists_the_registry_with_owners() {
    let output = run("/help");
    assert!(output.status.success(), "{:?}", output.status);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("/usage"), "{stdout}");
    assert!(stdout.contains("/insights"), "{stdout}");
    assert!(stdout.contains("CMP-analytics"), "{stdout}");
    assert!(stdout.contains("CMP-commands"), "{stdout}");
}

#[test]
fn help_for_one_command_shows_its_owner_and_effect_class() {
    let output = run("/help usage");
    assert!(output.status.success(), "{:?}", output.status);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("CMP-analytics"), "{stdout}");
    assert!(stdout.contains("read_only"), "{stdout}");
}

#[test]
fn commands_filter_comes_from_the_registry() {
    let output = run("/commands analytics");
    assert!(output.status.success(), "{:?}", output.status);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("/usage"), "{stdout}");
    assert!(stdout.contains("/insights"), "{stdout}");
    assert!(
        !stdout.contains("  /help "),
        "a filtered list must not include an unmatched row: {stdout}"
    );
}

#[test]
fn an_unknown_command_is_a_typed_refusal_with_suggestions_and_never_a_prompt() {
    let output = run("/usagee");
    assert_eq!(output.status.code(), Some(4), "{:?}", output.status);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unknown command `/usagee`"), "{stderr}");
    assert!(stderr.contains("/usage"), "suggestions are shown: {stderr}");
    assert!(
        output.stdout.is_empty(),
        "nothing may be sent to a model or printed as an answer"
    );
}

#[test]
fn a_malformed_argument_is_a_typed_refusal() {
    let output = run("/insights --days nope");
    assert_eq!(output.status.code(), Some(4), "{:?}", output.status);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("is not a number of days"), "{stderr}");
    assert!(
        stderr.contains("[--days N]"),
        "the grammar is shown: {stderr}"
    );
}

#[test]
fn an_unknown_help_topic_is_refused() {
    let output = run("/help nonsense");
    assert_eq!(output.status.code(), Some(4), "{:?}", output.status);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unknown command `/nonsense`"), "{stderr}");
}
