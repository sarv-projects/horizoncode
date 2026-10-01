//! End-to-end loop tests against an in-process chat-completions-compatible
//! mock server.
//!
//! These tests exercise the real provider transport, the loop, the tool
//! registry, and the durable session log together. The only network traffic is
//! loopback to the mock (`REQ-PROV-004` test isolation).

use std::sync::Arc;

use futures::{StreamExt, stream};
use horizoncode_provider::testing::{MockServer, MockTurn};
use horizoncode_provider::{ChatCompletionsProvider, ModelStream, Provider, ProviderConfig};
use horizoncode_runner::{RecordingObserver, RunConfig, RunEvent, RunObserver, Runner};
use horizoncode_session::{ModelRef, SessionCreatedPayload, SessionStore, TurnEndStatus};
use horizoncode_tools::{PermissionGate, PolicyGate, ToolRegistry, register_read_only_builtins};
use horizoncode_types::{
    CancelToken, EventKind, ModelEvent, ModelRequest, ProviderError, SessionId, ToolStatus,
};
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
    let config = RunConfig {
        model: "mock-model".to_owned(),
        workspace: harness.workspace.path().to_path_buf(),
        max_steps,
        ..RunConfig::default()
    };
    build_runner_with_config(harness, server, config)
}

fn build_runner_with_config(harness: &Harness, server: &MockServer, config: RunConfig) -> Runner {
    let provider: Arc<dyn Provider> = Arc::new(
        ChatCompletionsProvider::new(ProviderConfig::new(
            "mock",
            server.base_url(),
            "test-key",
            "mock-model",
        ))
        .unwrap(),
    );
    build_runner_with_provider(harness, provider, config)
}

fn build_runner_with_provider(
    harness: &Harness,
    provider: Arc<dyn Provider>,
    mut config: RunConfig,
) -> Runner {
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
    config.model = "mock-model".to_owned();
    config.workspace = harness.workspace.path().to_path_buf();
    config.sandbox_resolved = Some(Arc::new(resolved));
    Runner::new(
        provider,
        harness.registry.clone(),
        harness.store.clone(),
        gate,
        config,
    )
}

#[derive(Debug)]
struct ScriptedProvider {
    events: Vec<ModelEvent>,
    leave_stream_open: bool,
}

#[async_trait::async_trait]
impl Provider for ScriptedProvider {
    fn name(&self) -> &str {
        "mock"
    }

    fn model(&self) -> &str {
        "mock-model"
    }

    async fn stream(
        &self,
        _request: ModelRequest,
        _cancel: CancelToken,
    ) -> Result<ModelStream, ProviderError> {
        let events = self.events.clone().into_iter().map(Ok::<_, ProviderError>);
        let events = stream::iter(events);
        if self.leave_stream_open {
            Ok(events.chain(stream::pending()).boxed())
        } else {
            Ok(events.boxed())
        }
    }
}

fn tool_delta(index: u32, id: Option<&str>, name: &str, arguments: &str) -> ModelEvent {
    ModelEvent::ToolCallDelta {
        index,
        id: id.map(str::to_owned),
        name: Some(name.to_owned()),
        arguments_delta: arguments.to_owned(),
    }
}

struct CancelOnTextObserver {
    cancel: CancelToken,
}

impl RunObserver for CancelOnTextObserver {
    fn on_event(&mut self, event: RunEvent) {
        if matches!(event, RunEvent::TextDelta { .. }) {
            self.cancel.cancel();
        }
    }
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
async fn response_tool_call_count_cap_rejects_the_entire_batch() {
    let harness = harness();
    let server = MockServer::start(vec![MockTurn::tool_calls(vec![
        ("list".to_owned(), json!({})),
        ("list".to_owned(), json!({})),
    ])])
    .await;
    let config = RunConfig {
        max_steps: 5,
        max_tool_calls_per_response: 1,
        ..RunConfig::default()
    };
    let runner = build_runner_with_config(&harness, &server, config);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "List files twice.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    assert!(outcome.reason.contains("tool-call count"));
    assert_eq!(server.request_count(), 1);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(!events.iter().any(|event| event.kind == EventKind::ToolCall));
    assert!(
        !events
            .iter()
            .any(|event| event.kind == EventKind::ToolResult)
    );
    let rejected = events
        .iter()
        .find(|event| event.kind == EventKind::ModelAttempt)
        .expect("bounded response rejection is durable");
    assert_eq!(rejected.data["code"], "TOOL_CALL_COUNT_LIMIT");
    assert_eq!(rejected.data["limit"], 1);
    assert_eq!(rejected.data["observed"], 2);
}

#[tokio::test]
async fn response_argument_byte_cap_rejects_before_any_tool_is_recorded() {
    let harness = harness();
    let server =
        MockServer::start(vec![MockTurn::tool_call("read", json!({"path": "a.txt"}))]).await;
    let config = RunConfig {
        max_steps: 5,
        max_tool_argument_bytes_per_response: 4,
        ..RunConfig::default()
    };
    let runner = build_runner_with_config(&harness, &server, config);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "Read a.txt.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    assert_eq!(server.request_count(), 1);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(!events.iter().any(|event| event.kind == EventKind::ToolCall));
    assert!(
        !events
            .iter()
            .any(|event| event.kind == EventKind::ToolResult)
    );
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt
            && event.data["code"] == "TOOL_ARGUMENT_BYTES_LIMIT"
            && event.data["limit"] == 4
    }));
}

#[tokio::test]
async fn response_byte_cap_rejects_text_without_claiming_completion() {
    let harness = harness();
    let server = MockServer::start(vec![MockTurn::text("hello")]).await;
    let config = RunConfig {
        max_steps: 5,
        max_response_bytes: 4,
        ..RunConfig::default()
    };
    let runner = build_runner_with_config(&harness, &server, config);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "Say hello.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    assert_eq!(server.request_count(), 1);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(
        !events
            .iter()
            .any(|event| event.kind == EventKind::AssistantMessage)
    );
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt
            && event.data["code"] == "RESPONSE_BYTES_LIMIT"
            && event.data["observed"] == 5
    }));
}

#[tokio::test]
async fn schema_invalid_member_rejects_a_mixed_batch_before_any_tool_dispatch() {
    let harness = harness();
    let server = MockServer::start(vec![MockTurn::tool_calls(vec![
        ("list".to_owned(), json!({"unexpected": "field"})),
        ("read".to_owned(), json!({"path": "a.txt"})),
    ])])
    .await;
    let runner = build_runner(&harness, &server, 5);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "List and read.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    assert_eq!(server.request_count(), 1);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(!events.iter().any(|event| event.kind == EventKind::ToolCall));
    assert!(
        !events
            .iter()
            .any(|event| event.kind == EventKind::ToolResult)
    );
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt && event.data["code"] == "TOOL_SCHEMA_VALIDATION"
    }));
}

#[tokio::test]
async fn malformed_json_member_rejects_the_whole_response_batch() {
    let harness = harness();
    let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
        events: vec![
            ModelEvent::Started,
            tool_delta(0, Some("call-bad-json"), "read", "{\"path\":"),
            tool_delta(1, Some("call-good-json"), "list", "{}"),
            ModelEvent::Finished {
                reason: horizoncode_types::FinishReason::ToolCalls,
            },
        ],
        leave_stream_open: false,
    });
    let runner = build_runner_with_provider(
        &harness,
        provider,
        RunConfig {
            max_steps: 5,
            ..RunConfig::default()
        },
    );
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "Read and list.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(!events.iter().any(|event| event.kind == EventKind::ToolCall));
    assert!(
        !events
            .iter()
            .any(|event| event.kind == EventKind::ToolResult)
    );
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt && event.data["code"] == "INVALID_TOOL_ARGUMENTS"
    }));
}

#[tokio::test]
async fn duplicate_ids_within_one_response_reject_before_dispatch() {
    let harness = harness();
    let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
        events: vec![
            ModelEvent::Started,
            tool_delta(0, Some("call-duplicate"), "list", "{}"),
            tool_delta(1, Some("call-duplicate"), "list", "{}"),
            ModelEvent::Finished {
                reason: horizoncode_types::FinishReason::ToolCalls,
            },
        ],
        leave_stream_open: false,
    });
    let runner = build_runner_with_provider(
        &harness,
        provider,
        RunConfig {
            max_steps: 5,
            ..RunConfig::default()
        },
    );
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "List files twice.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(!events.iter().any(|event| event.kind == EventKind::ToolCall));
    assert!(
        !events
            .iter()
            .any(|event| event.kind == EventKind::ToolResult)
    );
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt && event.data["code"] == "DUPLICATE_TOOL_CALL_ID"
    }));
}

#[tokio::test]
async fn missing_call_id_rejects_before_dispatch() {
    let harness = harness();
    let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
        events: vec![
            ModelEvent::Started,
            tool_delta(0, None, "list", "{}"),
            ModelEvent::Finished {
                reason: horizoncode_types::FinishReason::ToolCalls,
            },
        ],
        leave_stream_open: false,
    });
    let runner = build_runner_with_provider(
        &harness,
        provider,
        RunConfig {
            max_steps: 5,
            ..RunConfig::default()
        },
    );
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "List files.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(!events.iter().any(|event| event.kind == EventKind::ToolCall));
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt && event.data["code"] == "MISSING_TOOL_CALL_ID"
    }));
}

#[tokio::test]
async fn unadvertised_tool_call_rejects_the_whole_response_batch() {
    let harness = harness();
    let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
        events: vec![
            ModelEvent::Started,
            tool_delta(0, Some("call-unknown"), "not_registered", "{}"),
            ModelEvent::Finished {
                reason: horizoncode_types::FinishReason::ToolCalls,
            },
        ],
        leave_stream_open: false,
    });
    let runner = build_runner_with_provider(
        &harness,
        provider,
        RunConfig {
            max_steps: 5,
            ..RunConfig::default()
        },
    );
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "Use the unknown tool.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(!events.iter().any(|event| event.kind == EventKind::ToolCall));
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt && event.data["code"] == "UNADVERTISED_TOOL"
    }));
}

#[tokio::test]
async fn finish_reason_must_match_whether_the_response_contains_tool_calls() {
    let harness = harness();
    let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
        events: vec![
            ModelEvent::Started,
            tool_delta(0, Some("call-wrong-finish"), "list", "{}"),
            ModelEvent::Finished {
                reason: horizoncode_types::FinishReason::Stop,
            },
        ],
        leave_stream_open: false,
    });
    let runner = build_runner_with_provider(
        &harness,
        provider,
        RunConfig {
            max_steps: 5,
            ..RunConfig::default()
        },
    );
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "List files.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(!events.iter().any(|event| event.kind == EventKind::ToolCall));
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt && event.data["code"] == "FINISH_CALLS_MISMATCH"
    }));
}

#[tokio::test]
async fn provider_output_limit_is_partial_and_never_dispatches_tool_calls() {
    let harness = harness();
    let server = MockServer::start(vec![MockTurn::text_with_finish(
        "partial answer",
        Some("length"),
    )])
    .await;
    let runner = build_runner(&harness, &server, 5);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "Answer this.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Partial);
    assert_eq!(outcome.final_text.as_deref(), Some("partial answer"));
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(
        !events
            .iter()
            .any(|event| event.kind == EventKind::AssistantMessage)
    );
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt
            && event.data["code"] == "OUTPUT_LIMIT_REACHED"
            && event.data["outcome"] == "incomplete"
    }));
}

#[tokio::test]
async fn missing_provider_finish_marker_fails_closed() {
    let harness = harness();
    let server =
        MockServer::start(vec![MockTurn::text_with_finish("unconfirmed answer", None)]).await;
    let runner = build_runner(&harness, &server, 5);
    let mut observer = RecordingObserver::new();

    let outcome = runner
        .run_turn(
            &harness.session_id,
            "Answer this.",
            CancelToken::new(),
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Failed);
    assert_eq!(server.request_count(), 1);
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(
        !events
            .iter()
            .any(|event| event.kind == EventKind::AssistantMessage)
    );
    assert!(events.iter().any(|event| {
        event.kind == EventKind::ModelAttempt && event.data["code"] == "UNSUPPORTED_FINISH_REASON"
    }));
}

#[tokio::test]
async fn cancellation_discards_provisional_tool_calls_but_keeps_partial_text() {
    let harness = harness();
    let config = RunConfig {
        max_steps: 5,
        ..RunConfig::default()
    };
    let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
        events: vec![
            ModelEvent::Started,
            tool_delta(0, Some("call-provisional"), "list", "{}"),
            ModelEvent::TextDelta {
                text: "partial response".to_owned(),
            },
        ],
        leave_stream_open: true,
    });
    let runner = build_runner_with_provider(&harness, provider, config);
    let cancel = CancelToken::new();
    let mut observer = CancelOnTextObserver {
        cancel: cancel.clone(),
    };

    let outcome = runner
        .run_turn(&harness.session_id, "List files.", cancel, &mut observer)
        .await
        .unwrap();

    assert_eq!(outcome.status, TurnEndStatus::Interrupted);
    assert_eq!(outcome.final_text.as_deref(), Some("partial response"));
    let events = harness.store.load(&harness.session_id).unwrap().events;
    assert!(!events.iter().any(|event| event.kind == EventKind::ToolCall));
    assert!(
        !events
            .iter()
            .any(|event| event.kind == EventKind::ToolResult)
    );
    let interrupted = events
        .iter()
        .find(|event| event.kind == EventKind::AssistantMessage)
        .expect("interrupted partial text remains inspectable");
    assert_eq!(interrupted.data["interrupted"], true);
    assert!(interrupted.data["tool_calls"].is_null());
    assert!(interrupted.data.to_string().contains("partial response"));
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
