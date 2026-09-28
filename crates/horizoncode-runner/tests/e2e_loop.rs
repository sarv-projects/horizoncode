//! End-to-end loop tests against an in-process chat-completions-compatible
//! mock server.
//!
//! These tests exercise the real provider transport, the loop, the tool
//! registry, and the durable session log together. The only network traffic is
//! loopback to the mock (`REQ-PROV-004` test isolation).

use std::sync::Arc;

use horizoncode_provider::testing::{MockServer, MockTurn};
use horizoncode_provider::{ChatCompletionsProvider, Provider, ProviderConfig};
use horizoncode_runner::{RecordingObserver, RunConfig, RunEvent, Runner};
use horizoncode_session::{ModelRef, SessionCreatedPayload, SessionStore, TurnEndStatus};
use horizoncode_tools::{PermissionGate, PolicyGate, ToolRegistry, register_read_only_builtins};
use horizoncode_types::{CancelToken, EventKind, SessionId, ToolStatus};
use serde_json::json;

struct Harness {
    _dir: tempfile::TempDir,
    store: Arc<SessionStore>,
    session_id: SessionId,
    workspace: tempfile::TempDir,
    registry: Arc<ToolRegistry>,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SessionStore::open(dir.path().join("sessions")).unwrap());
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("a.txt"), "alpha\n").unwrap();
    std::fs::write(workspace.path().join("b.txt"), "beta\n").unwrap();
    let session = store
        .create(SessionCreatedPayload::new(
            "workspace:test",
            "loop test",
            ModelRef {
                id: "mock-model".to_owned(),
                provider: "mock".to_owned(),
                variant: None,
            },
            "chat",
            json!({"rules": []}),
        ))
        .unwrap();
    let mut registry = ToolRegistry::new();
    register_read_only_builtins(&mut registry).unwrap();
    Harness {
        session_id: session.id,
        store,
        workspace,
        registry: Arc::new(registry),
        _dir: dir,
    }
}

fn build_runner(harness: &Harness, server: &MockServer, max_steps: usize) -> Runner {
    let provider: Arc<dyn Provider> = Arc::new(
        ChatCompletionsProvider::new(ProviderConfig::new(
            "mock",
            server.base_url(),
            "test-key",
            "mock-model",
        ))
        .unwrap(),
    );
    let gate: Arc<dyn PermissionGate> = Arc::new(PolicyGate::read_only());
    // The tool plane scopes its own filesystem operations through the resolved
    // plan and fails closed without one, so the harness carries the plan a
    // workspace profile resolves to.
    let profile =
        horizoncode_sandbox::ConfinementProfile::workspace_write(harness.workspace.path());
    let resolved = horizoncode_sandbox::ResolvedProfile {
        backend: "test".to_owned(),
        profile: profile.profile,
        network: profile.network.clone(),
        workspace: profile.workspace.clone(),
        writable_roots: profile.writable_roots(),
        readable_roots: profile.readable_roots(),
        protected: profile.protected.clone(),
        deny: profile.deny.clone(),
        session_dir: None,
        limits: profile.limits,
        applied: Vec::new(),
        epoch: 1,
        bare: false,
    };
    let config = RunConfig {
        model: "mock-model".to_owned(),
        workspace: harness.workspace.path().to_path_buf(),
        max_steps,
        sandbox_resolved: Some(Arc::new(resolved)),
        ..RunConfig::default()
    };
    Runner::new(
        provider,
        harness.registry.clone(),
        harness.store.clone(),
        gate,
        config,
    )
}

/// `AX-356`: a provider that reuses a correlation id inside one turn is refused
/// at admission, so the turn fails with a typed reason instead of the loop
/// correlating a second result to a call that already spent its authorization.
#[tokio::test]
async fn a_reused_tool_call_id_fails_the_turn_at_admission() {
    let harness = harness();
    let server = MockServer::start(vec![
        MockTurn::tool_call_with_id("call_dup", "list", json!({})),
        MockTurn::tool_call_with_id("call_dup", "list", json!({})),
        MockTurn::text("should never be reached"),
    ])
    .await;
    let runner = build_runner(&harness, &server, 5);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "List the workspace twice under one id.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    assert!(
        outcome.reason.contains("duplicate tool-call id `call_dup`"),
        "the refusal must name the id: {}",
        outcome.reason
    );
    // The first call still ran and recorded a result; the refused response was
    // never dispatched, so no second result exists under that id.
    let loaded = harness.store.load(&harness.session_id).unwrap();
    let results = loaded
        .events
        .iter()
        .filter(|event| event.kind == EventKind::ToolResult)
        .count();
    assert_eq!(results, 1, "only the admitted call may produce a result");
}

#[tokio::test]
async fn loop_executes_a_tool_call_then_returns_the_final_answer() {
    let harness = harness();
    let server = MockServer::start(vec![
        MockTurn::tool_call("list", json!({})),
        MockTurn::text("Done. The workspace has a.txt and b.txt."),
    ])
    .await;
    let runner = build_runner(&harness, &server, 10);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "List the workspace files, then summarize.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(
        outcome.status,
        TurnEndStatus::Completed,
        "{:?}",
        outcome.reason
    );
    assert_eq!(outcome.steps, 2);
    let final_text = outcome.final_text.unwrap();
    assert!(final_text.contains("a.txt"));

    // The mock saw two requests: the initial one and the tool-result turn.
    assert_eq!(server.request_count(), 2);
    let requests = server.requests();
    assert_eq!(requests[0]["tools"].as_array().unwrap().len(), 4);
    let second_messages = requests[1]["messages"].as_array().unwrap();
    let tool_message = second_messages
        .iter()
        .find(|message| message["role"] == "tool")
        .expect("second request must carry the tool result");
    assert!(tool_message["content"].as_str().unwrap().contains("a.txt"));
    assert_eq!(tool_message["tool_call_id"], "call_mock_1");

    // The log records the call, its result, and a terminal turn.
    let loaded = harness.store.load(&harness.session_id).unwrap();
    assert!(
        loaded
            .events
            .iter()
            .any(|event| event.kind == EventKind::ToolCall)
    );
    let results: Vec<_> = loaded
        .events
        .iter()
        .filter(|event| event.kind == EventKind::ToolResult)
        .collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].data["status"], "success");
    assert_eq!(loaded.last_turn_status(), Some(TurnEndStatus::Completed));
    assert!(loaded.pending_tool_calls().is_empty());
    assert!(loaded.usage_totals().total() > 0);

    // The observer streamed the tool lifecycle and the final text.
    let events = observer.events();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, RunEvent::ToolStarted { .. }))
    );
    assert!(events.iter().any(|event| matches!(
        event,
        RunEvent::ToolFinished { settlement } if settlement.status == ToolStatus::Success
    )));
    assert!(observer.streamed_text().contains("Done."));
}

#[tokio::test]
async fn loop_retries_a_transient_provider_failure() {
    let harness = harness();
    let server = MockServer::start(vec![
        MockTurn::Error {
            status: 429,
            body: "{\"error\":\"slow down\"}".to_owned(),
            retry_after: Some("0".to_owned()),
        },
        MockTurn::text("Recovered after retry."),
    ])
    .await;
    let runner = build_runner(&harness, &server, 5);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "hello",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();
    assert_eq!(outcome.status, TurnEndStatus::Completed);
    assert_eq!(server.request_count(), 2);
    assert!(outcome.final_text.unwrap().contains("Recovered"));
}

#[tokio::test]
async fn loop_terminates_interrupted_when_cancelled() {
    let harness = harness();
    let server = MockServer::start(vec![MockTurn::text("never seen")]).await;
    let runner = build_runner(&harness, &server, 5);
    let mut observer = RecordingObserver::new();
    let cancel = CancelToken::new();
    cancel.cancel();

    let outcome = runner
        .run_turn(&harness.session_id, "hello", cancel, &mut observer)
        .await
        .unwrap();
    assert_eq!(outcome.status, TurnEndStatus::Interrupted);
    assert_eq!(server.request_count(), 0);
    let loaded = harness.store.load(&harness.session_id).unwrap();
    assert_eq!(loaded.last_turn_status(), Some(TurnEndStatus::Interrupted));
    assert_eq!(loaded.open_turn(), None);
}

#[tokio::test]
async fn loop_disables_tools_on_the_last_step() {
    let harness = harness();
    let server = MockServer::start(vec![MockTurn::tool_call("list", json!({}))]).await;
    let runner = build_runner(&harness, &server, 1);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "list files",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();
    assert_eq!(outcome.status, TurnEndStatus::Partial);

    // The wrap-up request advertised no tools. `tool_choice` is omitted rather
    // than sent as `none` because some endpoints reject it without `tools`;
    // an empty tool set is the stronger equivalent guarantee.
    let requests = server.requests();
    assert!(requests[0].get("tools").is_none());
    let choice = requests[0].get("tool_choice");
    assert!(choice.is_none() || choice == Some(&json!("none")));

    // The late tool call failed unsettled with a typed result.
    let loaded = harness.store.load(&harness.session_id).unwrap();
    let results: Vec<_> = loaded
        .events
        .iter()
        .filter(|event| event.kind == EventKind::ToolResult)
        .collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].data["error_code"], "TOOLS_DISABLED");
    assert!(loaded.pending_tool_calls().is_empty());
}

#[tokio::test]
async fn resume_continues_from_the_replayed_log() {
    let harness = harness();
    let first = MockServer::start(vec![MockTurn::text("First answer.")]).await;
    let runner = build_runner(&harness, &first, 5);
    let mut observer = RecordingObserver::new();
    let outcome = runner
        .run_turn(
            &harness.session_id,
            "first",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();
    assert_eq!(outcome.status, TurnEndStatus::Completed);

    // A fresh runner over a fresh mock server simulates a resumed process.
    let second = MockServer::start(vec![MockTurn::text("Second answer.")]).await;
    let resumed = build_runner(&harness, &second, 5);
    let outcome = resumed
        .run_turn(
            &harness.session_id,
            "second",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();
    assert_eq!(outcome.status, TurnEndStatus::Completed);
    assert_eq!(outcome.final_text.as_deref(), Some("Second answer."));

    // The resumed request replayed the first turn's user message and answer.
    let requests = second.requests();
    let messages = requests[0]["messages"].as_array().unwrap();
    let roles: Vec<&str> = messages
        .iter()
        .map(|message| message["role"].as_str().unwrap())
        .collect();
    assert!(roles.contains(&"user"));
    assert!(roles.iter().filter(|role| **role == "user").count() >= 2);
    assert!(roles.contains(&"assistant"));
}
