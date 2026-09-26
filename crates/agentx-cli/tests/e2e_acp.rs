//! End-to-end test of the ACP stdio server driven through the built binary.
//!
//! The test speaks newline-delimited JSON-RPC 2.0 to `agentx acp` and asserts
//! the initialize handshake, session creation, streamed `session/update`
//! notifications, `session/request_permission`, and the terminal prompt
//! response (`REQ-PROTO-001`, `REQ-PROTO-002`).

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use agentx_provider::testing::{MockServer, MockTurn};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct AcpClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl AcpClient {
    fn spawn(server_url: &str, home: &Path, ask_actions: Option<&str>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_agentx"));
        command
            .arg("acp")
            .env("AGENTX_BASE_URL", server_url)
            .env("AGENTX_API_KEY", "test-key")
            .env("AGENTX_MODEL", "mock-model")
            .env("AGENTX_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        match ask_actions {
            Some(actions) => {
                command.env("AGENTX_ASK_ACTIONS", actions);
            }
            None => {
                command.env_remove("AGENTX_ASK_ACTIONS");
            }
        }
        let mut child = command.spawn().expect("spawn agentx acp");
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

    /// Reads until the response with `id` arrives, skipping notifications and
    /// server-initiated requests.
    async fn read_response(&mut self, id: i64) -> Value {
        loop {
            let message = self.read().await;
            if message.get("method").is_none() && message.get("id") == Some(&json!(id)) {
                return message;
            }
        }
    }

    /// Runs a prompt turn, answering permission requests with allow-once and
    /// collecting every `session/update` notification.
    async fn prompt(&mut self, id: i64) -> (Vec<Value>, Value, bool) {
        let mut updates = Vec::new();
        let mut saw_permission = false;
        loop {
            let message = self.read().await;
            match message.get("method").and_then(Value::as_str) {
                Some("session/update") => updates.push(message),
                Some("session/request_permission") => {
                    saw_permission = true;
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
                        return (updates, message, saw_permission);
                    }
                }
            }
        }
    }
}

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "alpha\n").unwrap();
    dir
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
    assert!(response["result"]["agentCapabilities"].is_object());
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
    let response = client.read_response(2).await;
    response["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_initializes_creates_a_session_and_streams_updates() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("list", json!({})),
        MockTurn::text("ACP final answer."),
    ])
    .await;
    let workspace = workspace();
    let home = tempfile::tempdir().unwrap();
    let mut client = AcpClient::spawn(server.base_url(), home.path(), None);

    handshake(&mut client).await;
    let session_id = new_session(&mut client, workspace.path()).await;
    assert!(session_id.starts_with("ses_"));

    client
        .send(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "list files then summarize" }]
            }
        }))
        .await;
    let (updates, response, saw_permission) = client.prompt(3).await;

    assert!(
        !saw_permission,
        "read-only actions must not prompt by default"
    );
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let streamed: String = updates
        .iter()
        .filter(|update| update["params"]["update"]["sessionUpdate"] == "agent_message_chunk")
        .filter_map(|update| update["params"]["update"]["content"]["text"].as_str())
        .collect();
    assert!(streamed.contains("ACP final answer."), "{streamed}");
    assert!(updates.iter().any(|update| {
        update["params"]["update"]["sessionUpdate"] == "tool_call"
            && update["params"]["update"]["name"] == "list"
    }));
    assert!(
        updates.iter().any(|update| {
            update["params"]["update"]["sessionUpdate"] == "tool_call_update"
                && update["params"]["update"]["status"] == "completed"
        }),
        "updates: {updates:?}"
    );
    assert_eq!(server.request_count(), 2);

    let _ = client.child.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_requests_and_honors_permission() {
    let server = MockServer::start(vec![
        MockTurn::tool_call("read", json!({ "path": "a.txt" })),
        MockTurn::text("Read the file."),
    ])
    .await;
    let workspace = workspace();
    let home = tempfile::tempdir().unwrap();
    // Force a permission prompt for the `read` action.
    let mut client = AcpClient::spawn(server.base_url(), home.path(), Some("read"));

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
    let (updates, response, saw_permission) = client.prompt(3).await;

    assert!(
        saw_permission,
        "expected a session/request_permission request"
    );
    assert_eq!(response["result"]["stopReason"], "end_turn");
    // The allowed read executed and its result was fed back to the model.
    assert_eq!(server.request_count(), 2);
    assert!(updates.iter().any(|update| {
        update["params"]["update"]["sessionUpdate"] == "tool_call_update"
            && update["params"]["update"]["status"] == "completed"
    }));

    let _ = client.child.kill().await;
}
