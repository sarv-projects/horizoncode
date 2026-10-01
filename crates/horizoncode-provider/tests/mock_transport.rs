//! Provider transport tests against the in-process mock server.
//!
//! Gated on the `testing` feature. When the workspace is built for tests the
//! runner/cli dev-dependencies enable it, so this file runs under
//! `cargo test --workspace`.

#![cfg(feature = "testing")]

use futures::StreamExt;
use horizoncode_provider::testing::{MockServer, MockTurn};
use horizoncode_provider::{ChatCompletionsProvider, Provider, ProviderConfig};
use horizoncode_types::{CancelToken, ModelEvent, ModelRequest, ProviderErrorKind};
use serde_json::json;
use std::time::Duration;

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
async fn missing_finish_reason_is_preserved_as_unsupported() {
    let server = MockServer::start(vec![MockTurn::text_with_finish("answer", None)]).await;
    let provider = provider(&server);
    let stream = provider
        .stream(ModelRequest::new("mock-model"), CancelToken::new())
        .await
        .unwrap();
    let events = collect(stream).await;

    assert!(matches!(
        events.last(),
        Some(ModelEvent::Finished {
            reason: horizoncode_types::FinishReason::Other(reason)
        }) if reason == "missing_finish_reason"
    ));
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

#[tokio::test]
async fn declared_oversized_non_stream_response_is_refused_before_json_parsing() {
    let server = MockServer::start(vec![horizoncode_provider::testing::MockTurn::RawResponse {
        status: 200,
        content_type: "application/json".to_owned(),
        body: b"{}".to_vec(),
        content_length: Some(16_777_217),
        retry_after: None,
    }])
    .await;
    let provider = provider(&server);
    let error = match provider
        .stream(ModelRequest::new("mock-model"), CancelToken::new())
        .await
    {
        Ok(_) => panic!("expected a response-limit error"),
        Err(error) => error,
    };

    assert_eq!(error.kind, ProviderErrorKind::ResponseLimit);
    assert!(!error.retryable);
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn chunked_sse_body_overflow_ends_without_a_successful_finish() {
    let limit = 16_777_216;
    let mut comment_line = vec![b'x'; 1023];
    comment_line[0] = b':';
    comment_line.push(b'\n');
    let mut body = Vec::with_capacity(limit + comment_line.len());
    while body.len() <= limit {
        body.extend_from_slice(&comment_line);
    }
    let server = MockServer::start(vec![horizoncode_provider::testing::MockTurn::RawResponse {
        status: 200,
        content_type: "text/event-stream".to_owned(),
        body,
        content_length: None,
        retry_after: None,
    }])
    .await;
    let provider = provider(&server);
    let stream = provider
        .stream(ModelRequest::new("mock-model"), CancelToken::new())
        .await
        .unwrap();
    let events = stream.collect::<Vec<_>>().await;

    assert!(events.iter().any(|event| matches!(
        event,
        Err(error) if error.kind == ProviderErrorKind::ResponseLimit && !error.retryable
    )));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Ok(ModelEvent::Finished { .. })))
    );
}

#[tokio::test]
async fn oversized_error_preview_keeps_http_class_and_retry_after_without_echoing_secrets() {
    let body = format!("Bearer test-key {}", "x".repeat(9_000));
    let server = MockServer::start(vec![horizoncode_provider::testing::MockTurn::Error {
        status: 401,
        body,
        retry_after: Some("4".to_owned()),
    }])
    .await;
    let provider = provider(&server);
    let error = match provider
        .stream(ModelRequest::new("mock-model"), CancelToken::new())
        .await
    {
        Ok(_) => panic!("expected an auth error"),
        Err(error) => error,
    };

    assert_eq!(error.kind, ProviderErrorKind::Auth);
    assert_eq!(error.status, Some(401));
    assert_eq!(error.retry_after, Some(Duration::from_secs(4)));
    assert!(!error.retryable);
    assert!(!error.message.contains("test-key"));
    assert!(error.message.contains('…'));
}
