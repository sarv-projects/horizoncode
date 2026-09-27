//! The ACP surface's usage and evidence updates.
//!
//! These drive the built binary over stdio against a loopback mock provider, so
//! every frame asserted here is a frame the real server emitted
//! (`REQ-PROTO-002`, `REQ-ANALYTICS-005`).

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use horizoncode_provider::testing::{MockServer, MockTurn};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct AcpClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl AcpClient {
    async fn spawn(server_url: &str, home: &Path, extra: &[&str], ask: Option<&str>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_horizoncode"));
        // Global options precede the subcommand; a global flag placed after it
        // is not parsed and the server exits instead of starting.
        command
            .args(extra)
            .arg("acp")
            .env("HORIZONCODE_BASE_URL", server_url)
            .env("HORIZONCODE_API_KEY", "test-key")
            .env("HORIZONCODE_MODEL", "mock-model")
            .env("HORIZONCODE_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        match ask {
            Some(actions) => {
                command.env("HORIZONCODE_ASK_ACTIONS", actions);
            }
            None => {
                command.env_remove("HORIZONCODE_ASK_ACTIONS");
            }
        }
        let mut child = command.spawn().expect("spawn horizoncode acp");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Self {
            child,
            stdin,
            stdout,
        }
    }

    async fn send(&mut self, value: Value) {
        let line = value.to_string();
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.write_all(b"\n").await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    async fn read(&mut self) -> Value {
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(20), self.stdout.read_line(&mut line))
            .await
            .expect("acp read timed out")
            .expect("acp read");
        assert!(read > 0, "acp server closed the connection: {line:?}");
        serde_json::from_str(&line)
            .unwrap_or_else(|error| panic!("invalid json-rpc line {line:?}: {error}"))
    }

    async fn read_response(&mut self, id: i64) -> Value {
        loop {
            let message = self.read().await;
            if message.get("method").is_none() && message.get("id") == Some(&json!(id)) {
                return message;
            }
        }
    }

    /// Runs a prompt turn, answering any permission request with allow-once.
    async fn prompt(&mut self, id: i64) -> (Vec<Value>, Value) {
        let mut updates = Vec::new();
        loop {
            let message = self.read().await;
            match message.get("method").and_then(Value::as_str) {
                Some("session/update") => updates.push(message),
                Some("session/request_permission") => {
                    let request_id = message["id"].clone();
                    self.send(json!({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "result": { "outcome": { "outcome": "selected", "optionId": "allow_once" } }
                    }))
                    .await;
                }
                Some(_) => {}
                None => {
                    if message.get("id") == Some(&json!(id)) {
                        return (updates, message);
                    }
                }
            }
        }
    }
}

async fn handshake(client: &mut AcpClient) {
    client
        .send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": 1, "clientCapabilities": {} }
        }))
        .await;
    let response = client.read_response(1).await;
    assert_eq!(response["result"]["protocolVersion"], 1);
}

async fn new_session(client: &mut AcpClient, cwd: &Path) -> String {
    client
        .send(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": { "cwd": cwd.to_str().unwrap(), "mcpServers": [] }
        }))
        .await;
    client.read_response(2).await["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_owned()
}

/// A frame is a `usage_update` notification.
fn usage_updates(updates: &[Value]) -> Vec<&Value> {
    updates
        .iter()
        .filter(|update| update["params"]["update"]["sessionUpdate"] == "usage_update")
        .map(|update| &update["params"]["update"])
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_emits_usage_update_with_the_declared_context_window() {
    let server = MockServer::start(vec![MockTurn::text("All done.")]).await;
    let home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    // The context window is declared explicitly: with no declared window the
    // surface emits no `usage_update` rather than inventing a figure.
    let mut client = AcpClient::spawn(
        server.base_url(),
        home.path(),
        &["--context-window", "200000"],
        None,
    )
    .await;

    handshake(&mut client).await;
    let session_id = new_session(&mut client, workspace.path()).await;
    client
        .send(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "hello" }]
            }
        }))
        .await;
    let (updates, response) = client.prompt(3).await;
    assert_eq!(response["result"]["stopReason"], "end_turn");

    let usage = usage_updates(&updates);
    assert_eq!(
        usage.len(),
        1,
        "one usage update per settled step: {updates:?}"
    );
    assert_eq!(usage[0]["used"].as_u64(), Some(15), "{:?}", usage[0]);
    assert_eq!(usage[0]["size"].as_u64(), Some(200_000));
    // The mock route is unpriced, so no cost is claimed: an unknown cost is
    // omitted rather than reported as zero.
    assert!(
        usage[0].get("cost").is_none(),
        "an unpriced route must not report a cost: {:?}",
        usage[0]
    );

    let _ = client.child.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_declared_context_window_means_no_usage_update() {
    let server = MockServer::start(vec![MockTurn::text("All done.")]).await;
    let home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let mut client = AcpClient::spawn(server.base_url(), home.path(), &[], None).await;

    handshake(&mut client).await;
    let session_id = new_session(&mut client, workspace.path()).await;
    client
        .send(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "hello" }]
            }
        }))
        .await;
    let (updates, response) = client.prompt(3).await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    assert!(
        usage_updates(&updates).is_empty(),
        "a fabricated context window must not be reported: {updates:?}"
    );
    // The run still recorded its usage locally.
    let ledger =
        std::fs::read_to_string(home.path().join("analytics/events.jsonl")).expect("a ledger");
    assert!(ledger.contains("step_usage"), "{ledger}");

    let _ = client.child.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_approval_is_surfaced_on_the_call_it_belongs_to() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("read", json!({ "path": "a.txt" })),
        MockTurn::text("Read it."),
    ])
    .await;
    let home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("a.txt"), "alpha\n").unwrap();
    // Force an `ask` so the run really exercises the approval path rather than
    // a plain rule-allowed effect.
    let mut client = AcpClient::spawn(server.base_url(), home.path(), &[], Some("read")).await;

    handshake(&mut client).await;
    let session_id = new_session(&mut client, workspace.path()).await;
    client
        .send(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "read a.txt" }]
            }
        }))
        .await;
    let (updates, response) = client.prompt(3).await;
    assert_eq!(response["result"]["stopReason"], "end_turn");

    // The audit outcome is visible on the session surface, as a thought chunk
    // rather than as agent output, so it cannot be mistaken for model text.
    let audit_notes: Vec<&str> = updates
        .iter()
        .filter(|update| update["params"]["update"]["sessionUpdate"] == "agent_thought_chunk")
        .filter_map(|update| update["params"]["update"]["content"]["text"].as_str())
        .filter(|text| text.starts_with("[audit]"))
        .collect();
    assert!(
        !audit_notes.is_empty(),
        "the audited decisions must be visible on the session surface: {updates:?}"
    );
    assert!(
        audit_notes
            .iter()
            .any(|note| note.contains("policy_decision")),
        "{audit_notes:?}"
    );
    // The approval the client answered is recorded on the same call.
    assert!(
        updates.iter().any(|update| {
            update["params"]["update"]["sessionUpdate"] == "tool_call_update"
                && update["params"]["update"]["title"]
                    .as_str()
                    .is_some_and(|title| title.contains("approval"))
        }),
        "the resolved approval must be surfaced: {updates:?}"
    );

    let _ = client.child.kill().await;
}
