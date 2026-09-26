//! End-to-end tests that invoke the built `agentx` binary against a localhost
//! mock provider.

use agentx_provider::testing::{MockServer, MockTurn};
use serde_json::json;
use tokio::process::Command;

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "alpha\n").unwrap();
    std::fs::write(dir.path().join("b.txt"), "beta\n").unwrap();
    dir
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn headless_one_shot_prints_the_final_answer() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("list", json!({})),
        MockTurn::text("Final answer: the workspace has two files."),
    ])
    .await;
    let workspace = workspace();
    let home = tempfile::tempdir().unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_agentx"))
        .args([
            "-p",
            "List the files and summarize.",
            "--cwd",
            workspace.path().to_str().unwrap(),
        ])
        .env("AGENTX_BASE_URL", server.base_url())
        .env("AGENTX_API_KEY", "test-key")
        .env("AGENTX_MODEL", "mock-model")
        .env("AGENTX_HOME", home.path())
        .output()
        .await
        .unwrap();

    assert!(
        output.status.success(),
        "exit={:?} stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Final answer"), "{stdout}");
    assert_eq!(server.request_count(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn headless_json_format_streams_ndjson_events() {
    let server = MockServer::start(vec![MockTurn::text("Json answer.")]).await;
    let workspace = workspace();
    let home = tempfile::tempdir().unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_agentx"))
        .args([
            "-p",
            "hello",
            "--format",
            "json",
            "--cwd",
            workspace.path().to_str().unwrap(),
        ])
        .env("AGENTX_BASE_URL", server.base_url())
        .env("AGENTX_API_KEY", "test-key")
        .env("AGENTX_MODEL", "mock-model")
        .env("AGENTX_HOME", home.path())
        .output()
        .await
        .unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let events: Vec<serde_json::Value> = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("each line is a JSON event"))
        .collect();
    assert!(events.iter().any(|event| event["type"] == "turn_started"));
    assert!(events.iter().any(|event| event["type"] == "text_delta"));
    let finished = events
        .iter()
        .find(|event| event["type"] == "turn_finished")
        .expect("turn_finished event");
    assert_eq!(finished["status"], "completed");
    let streamed: String = events
        .iter()
        .filter(|event| event["type"] == "text_delta")
        .filter_map(|event| event["text"].as_str())
        .collect();
    assert!(streamed.contains("Json answer."));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continue_resumes_the_most_recent_session() {
    let server = MockServer::start(vec![
        MockTurn::text("First answer."),
        MockTurn::text("Second answer."),
    ])
    .await;
    let workspace = workspace();
    let home = tempfile::tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_agentx");

    let run = |prompt: &'static str, extra: Vec<&'static str>| {
        let server_url = server.base_url().to_owned();
        let ws = workspace.path().to_str().unwrap().to_owned();
        let home = home.path().to_str().unwrap().to_owned();
        async move {
            let mut args = vec!["-p", prompt, "--cwd", ws.as_str()];
            args.extend(extra);
            Command::new(bin)
                .args(args)
                .env("AGENTX_BASE_URL", server_url)
                .env("AGENTX_API_KEY", "test-key")
                .env("AGENTX_MODEL", "mock-model")
                .env("AGENTX_HOME", home)
                .output()
                .await
                .unwrap()
        }
    };

    let first = run("first", vec![]).await;
    assert!(first.status.success());
    assert!(String::from_utf8_lossy(&first.stdout).contains("First answer."));

    let second = run("second", vec!["--continue"]).await;
    assert!(second.status.success());
    assert!(String::from_utf8_lossy(&second.stdout).contains("Second answer."));

    // The resumed request replayed the first user turn.
    let requests = server.requests();
    let second_messages = requests[1]["messages"].as_array().unwrap();
    let user_turns = second_messages
        .iter()
        .filter(|message| message["role"] == "user")
        .count();
    assert!(user_turns >= 2, "expected the replayed first turn");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_configuration_exits_with_the_config_code() {
    let workspace = workspace();
    let home = tempfile::tempdir().unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_agentx"))
        .args(["-p", "hello", "--cwd", workspace.path().to_str().unwrap()])
        .env_remove("AGENTX_BASE_URL")
        .env_remove("AGENTX_API_KEY")
        .env("AGENTX_HOME", home.path())
        .output()
        .await
        .unwrap();

    assert_eq!(output.status.code(), Some(4));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("AGENTX_BASE_URL"), "{stderr}");
}
