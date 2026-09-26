//! End-to-end tool-plane tests: the built `agentx` binary performs real writes,
//! an edit and a sandboxed shell command against a mock provider, and policy
//! (deny rules, plan mode) changes behavior with no code change.

use std::path::Path;

use agentx_provider::testing::{MockServer, MockTurn};
use serde_json::{Value, json};
use tokio::process::Command;

fn workspace() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn sandbox_available() -> bool {
    agentx_sandbox::local_provider().probe().is_available()
}

/// Reads every session event written under `AGENTX_HOME`.
fn session_events(home: &Path) -> Vec<Value> {
    let dir = home.join("sessions");
    let mut events = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return events;
    };
    for entry in entries.flatten() {
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        for line in content.lines() {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                events.push(value);
            }
        }
    }
    events
}

fn tool_results(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event["type"] == "tool/result")
        .cloned()
        .collect()
}

fn result_text(result: &Value) -> String {
    result["data"]["model_content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

async fn run_agentx(server: &MockServer, home: &Path, args: &[&str]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_agentx"));
    command
        .args(args)
        .env("AGENTX_BASE_URL", server.base_url())
        .env("AGENTX_API_KEY", "test-key")
        .env("AGENTX_MODEL", "mock-model")
        .env("AGENTX_HOME", home);
    command.output().await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn headless_write_edit_and_sandboxed_bash() {
    if !sandbox_available() {
        eprintln!("skipping: no sandbox backend available");
        return;
    }
    let server = MockServer::start(vec![
        MockTurn::tool_call("write", json!({"path": "hello.txt", "content": "hi"})),
        MockTurn::tool_call(
            "edit",
            json!({"path": "hello.txt", "oldString": "hi", "newString": "hello world"}),
        ),
        MockTurn::tool_call("bash", json!({"command": "echo sandboxed"})),
        MockTurn::text("All done."),
    ])
    .await;
    let workspace = workspace();
    let home = tempfile::tempdir().unwrap();

    let output = run_agentx(
        &server,
        home.path(),
        &[
            "-p",
            "write, edit and echo",
            "--cwd",
            workspace.path().to_str().unwrap(),
        ],
    )
    .await;
    assert!(
        output.status.success(),
        "exit={:?} stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );

    // The file changes are asserted on disk.
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("hello.txt")).unwrap(),
        "hello world"
    );

    let results = tool_results(&session_events(home.path()));
    assert!(
        results.iter().any(|result| {
            result["data"]["status"] == "success" && result_text(result).contains("sandboxed")
        }),
        "expected a successful sandboxed bash result: {results:?}"
    );
    assert!(
        results
            .iter()
            .filter(|result| result["data"]["status"] == "success")
            .count()
            >= 3,
        "expected write, edit and bash to succeed: {results:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deny_rule_blocks_a_write() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("write", json!({"path": "blocked.txt", "content": "nope"})),
        MockTurn::text("Could not write."),
    ])
    .await;
    let workspace = workspace();
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(workspace.path().join(".agentx")).unwrap();
    std::fs::write(
        workspace.path().join(".agentx/config.jsonc"),
        r#"{ "guard": { "rules": [
            { "action": "fs.write", "resource": "**", "effect": "deny" }
        ] } }"#,
    )
    .unwrap();

    let output = run_agentx(
        &server,
        home.path(),
        &[
            "-p",
            "write it",
            "--cwd",
            workspace.path().to_str().unwrap(),
        ],
    )
    .await;
    assert!(output.status.success());

    assert!(
        !workspace.path().join("blocked.txt").exists(),
        "a deny rule must prevent the write"
    );
    let results = tool_results(&session_events(home.path()));
    assert!(
        results
            .iter()
            .any(|result| result["data"]["status"] == "denied"),
        "expected a denied tool result: {results:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plan_mode_refuses_a_mutating_call() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("write", json!({"path": "plan.txt", "content": "nope"})),
        MockTurn::text("Planned only."),
    ])
    .await;
    let workspace = workspace();
    let home = tempfile::tempdir().unwrap();

    let output = run_agentx(
        &server,
        home.path(),
        &[
            "-p",
            "plan the write",
            "--mode",
            "plan",
            "--cwd",
            workspace.path().to_str().unwrap(),
        ],
    )
    .await;
    assert!(output.status.success());

    assert!(
        !workspace.path().join("plan.txt").exists(),
        "plan mode must refuse the mutating call"
    );
    // The denied tool is absent from the model's advertised set.
    let requests = server.requests();
    let tools = requests[0]["tools"].as_array().cloned().unwrap_or_default();
    assert!(
        !tools.iter().any(|tool| tool["function"]["name"] == "write"),
        "plan mode must not advertise the write tool: {tools:?}"
    );
    let results = tool_results(&session_events(home.path()));
    assert!(
        results
            .iter()
            .any(|result| result["data"]["status"] == "denied"),
        "expected a denied tool result: {results:?}"
    );
}
