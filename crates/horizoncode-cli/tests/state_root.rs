//! The state-root contract every CLI test depends on.
//!
//! These tests exist to keep the suite **order-independent**: no test may
//! observe, or be influenced by, state another test created. A regression here
//! is silent — the suite still passes, but a bare `cargo test -p horizoncode-cli`
//! starts behaving differently from a workspace run, which is exactly the
//! failure mode this file prevents.

mod support;

use std::collections::BTreeSet;
use std::fs;

use support::{TestHome, text_server};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_homes_are_independent_and_a_run_writes_only_into_its_own() {
    let first = TestHome::new();
    let second = TestHome::new();
    assert_ne!(first.path(), second.path(), "homes must not be shared");

    // A run against the first home must leave the second one untouched.
    let server = text_server("first").await;
    let workspace = TestHome::workspace();
    let output = first.run(&server, workspace.path(), "hello").await;
    assert!(output.status.success(), "{:?}", output.status);

    assert!(first.audit().join("segments/0000.jsonl").is_file());
    assert!(
        first.analytics().join("events.jsonl").is_file(),
        "a run must record analytics in its own home"
    );
    assert!(
        !second.audit().exists() && !second.analytics().exists(),
        "a run must not write into another test's home"
    );
    assert!(!second.sessions().exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fresh_home_is_always_empty_and_never_resolved_from_the_environment() {
    // The point of the helper is that it does not read `HORIZONCODE_HOME` at all: a
    // fresh instance is empty even when the ambient environment points
    // somewhere real.
    let home = TestHome::new();
    assert!(!home.sessions().exists());
    assert!(!home.audit().exists());
    assert!(!home.analytics().exists());
    assert!(
        home.path().starts_with(std::env::temp_dir()),
        "a test home must live under the temp directory, never in the developer's account: {}",
        home.path().display()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_under_many_homes_stay_separate_regardless_of_order() {
    // Interleave three runs across three homes. Whatever order they complete
    // in, each home must contain exactly one session and one audit chain.
    let workspaces: Vec<tempfile::TempDir> = (0..3).map(|_| TestHome::workspace()).collect();
    let mut tasks = Vec::new();
    for (index, workspace_dir) in workspaces.iter().enumerate() {
        let home = TestHome::new();
        let workspace = workspace_dir.path().to_path_buf();
        let server = text_server(&format!("answer {index}")).await;
        tasks.push(tokio::spawn(async move {
            let output = home.run(&server, &workspace, "hello").await;
            (home, output)
        }));
    }
    let mut finished: Vec<(TestHome, support::Output)> = Vec::new();
    for task in tasks {
        let (home, output) = task.await.expect("the run task must not panic");
        assert!(output.status.success(), "{:?}", output.status);
        finished.push((home, output));
    }
    for (index, (home, _output)) in finished.iter().enumerate() {
        let sessions: BTreeSet<_> = fs::read_dir(home.sessions())
            .expect("a session log must exist")
            .flatten()
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(
            sessions.len(),
            1,
            "home {index} must hold exactly one session, found {sessions:?}"
        );
        let log_name = sessions
            .iter()
            .next()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let session = log_name
            .strip_suffix(".jsonl")
            .unwrap_or(&log_name)
            .to_owned();
        // The session log holds the conversation; the audit chain holds refs
        // and counts only. Neither may leak into the other's home.
        let conversation = fs::read_to_string(home.sessions().join(&log_name)).unwrap();
        assert!(
            conversation.contains(&format!("answer {index}")),
            "home {index} must hold its own run's conversation"
        );
        let segment = fs::read_to_string(home.audit().join("segments/0000.jsonl"))
            .expect("a segment must exist");
        assert!(
            segment.contains(session.as_str()),
            "home {index} must hold its own run's audit record"
        );
        // The audit chain never holds prompt or completion text.
        assert!(
            !segment.contains(&format!("answer {index}")),
            "the audit chain must not record completion text: {segment}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_offline_surfaces_work_against_a_fresh_home() {
    // The helper used for the inspection surfaces must work with no provider
    // configuration and no prior run, which is the case a developer hits first.
    let home = TestHome::new();
    for args in [vec!["audit", "verify", "--all"], vec!["analytics", "stats"]] {
        let output = home
            .env_offline()
            .args(&args)
            .output()
            .await
            .expect("the binary must run");
        assert_eq!(
            output.status.code(),
            Some(0),
            "`{}` failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
