//! Provider transport tests against the in-process mock server.
//!
//! Gated on the `testing` feature. When the workspace is built for tests the
//! runner/cli dev-dependencies enable it, so this file runs under
//! `cargo test --workspace`.

#![cfg(feature = "testing")]

use horizoncode_provider::testing::{MockServer, MockTurn};
use horizoncode_provider::{ChatCompletionsProvider, Provider, ProviderConfig};
use horizoncode_types::{CancelToken, ModelEvent, ModelRequest, ProviderErrorKind};
use futures::StreamExt;
use serde_json::json;

fn provider(server: &MockServer) -> ChatCompletionsProvider {
    ChatCompletionsProvider::new(ProviderConfig::new(
        "mock",
        server.base_url(),
        "test-key",
        "mock-model",
    ))
    .unwrap()
}

async fn collect(stream: horizoncode_provider::ModelStream) -> Vec<ModelEvent> {
    stream
        .filter_map(|item| async move { item.ok() })
        .collect()
        .await
}

#[tokio::test]
async fn streams_text_and_finishes() {
    let server = MockServer::start(vec![MockTurn::text("hello world")]).await;
    let provider = provider(&server);
    let stream = provider
        .stream(ModelRequest::new("mock-model"), CancelToken::new())
        .await
        .unwrap();
    let events = collect(stream).await;

    assert!(matches!(events.first(), Some(ModelEvent::Started)));
    let text: String = events
        .iter()
        .filter_map(|event| match event {
            ModelEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "hello world");
    assert!(
        events
            .iter()
            .any(|event| matches!(event, ModelEvent::Usage(_)))
    );
    assert!(matches!(events.last(), Some(ModelEvent::Finished { .. })));
}

#[tokio::test]
async fn assembles_streamed_tool_call_arguments() {
    let server = MockServer::start(vec![MockTurn::tool_call(
        "read",
        json!({ "path": "src/main.rs" }),
    )])
    .await;
    let provider = provider(&server);
    let stream = provider
        .stream(ModelRequest::new("mock-model"), CancelToken::new())
        .await
        .unwrap();
    let events = collect(stream).await;

    let mut name = String::new();
    let mut arguments = String::new();
    for event in &events {
        if let ModelEvent::ToolCallDelta {
            name: delta_name,
            arguments_delta,
            ..
        } = event
        {
            if let Some(delta_name) = delta_name {
                name = delta_name.clone();
            }
            arguments.push_str(arguments_delta);
        }
    }
    assert_eq!(name, "read");
    let parsed: serde_json::Value = serde_json::from_str(&arguments).unwrap();
    assert_eq!(parsed["path"], "src/main.rs");
    assert!(matches!(events.last(), Some(ModelEvent::Finished { .. })));
}

#[tokio::test]
async fn auth_failure_is_terminal_and_classified() {
    let server = MockServer::start(vec![MockTurn::Error {
        status: 401,
        body: "{\"error\":\"bad key\"}".to_owned(),
        retry_after: None,
    }])
    .await;
    let provider = provider(&server);
    let error = match provider
        .stream(ModelRequest::new("mock-model"), CancelToken::new())
        .await
    {
        Ok(_) => panic!("expected an auth failure"),
        Err(error) => error,
    };
    assert_eq!(error.kind, ProviderErrorKind::Auth);
    assert!(!error.retryable);
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn rate_limit_is_retried() {
    let server = MockServer::start(vec![
        MockTurn::Error {
            status: 429,
            body: "{\"error\":\"slow down\"}".to_owned(),
            retry_after: Some("0".to_owned()),
        },
        MockTurn::text("recovered"),
    ])
    .await;
    let provider = provider(&server);
    let stream = provider
        .stream(ModelRequest::new("mock-model"), CancelToken::new())
        .await
        .unwrap();
    let events = collect(stream).await;
    let text: String = events
        .iter()
        .filter_map(|event| match event {
            ModelEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "recovered");
    assert_eq!(server.request_count(), 2);
}
