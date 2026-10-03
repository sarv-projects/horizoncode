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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn provider(server: &MockServer) -> ChatCompletionsProvider {
    ChatCompletionsProvider::new(ProviderConfig::new(
        "mock",
        server.base_url(),
        "test-key",
        "mock-model",
    ))
    .unwrap()
}

async fn stalled_response(
    prefix: &'static [u8],
) -> (
    std::net::SocketAddr,
    tokio::sync::oneshot::Receiver<()>,
    tokio::sync::oneshot::Receiver<bool>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        let (header_end, content_length) = loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0, "client closed before sending an HTTP request");
            request.extend_from_slice(&buffer[..count]);
            if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .expect("provider request has a content length");
                break (header_end, content_length);
            }
        };
        let request_end = header_end + 4 + content_length;
        while request.len() < request_end {
            let count = socket.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0, "client closed before completing the HTTP request");
            request.extend_from_slice(&buffer[..count]);
        }
        if !prefix.is_empty() {
            socket.write_all(prefix).await.unwrap();
            socket.flush().await.unwrap();
        }
        let _ = started_tx.send(());
        let closed = match socket.read(&mut buffer[..1]).await {
            Ok(0) => true,
            Ok(_) => false,
            Err(error) => matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
            ),
        };
        let no_retry = tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err();
        let _ = closed_tx.send(closed && no_retry);
    });
    (address, started_rx, closed_rx, server)
}

async fn assert_cancel_during_stalled_response(prefix: &'static [u8]) {
    let (address, started, closed, server) = stalled_response(prefix).await;
    let mut config = ProviderConfig::new(
        "mock",
        format!("http://{address}/v1"),
        "test-key",
        "mock-model",
    );
    config.timeout = Duration::from_secs(30);
    let provider = ChatCompletionsProvider::new(config).unwrap();
    let cancel = CancelToken::new();
    let request_cancel = cancel.clone();
    let request = tokio::spawn(async move {
        provider
            .stream(ModelRequest::new("mock-model"), request_cancel)
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), started)
        .await
        .expect("server did not receive the request")
        .expect("server dropped the request-start signal");
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_millis(500), request)
        .await
        .expect("provider did not promptly return after cancellation")
        .expect("provider task panicked");
    let error = match result {
        Ok(_) => panic!("cancelled provider request unexpectedly returned a stream"),
        Err(error) => error,
    };
    assert_eq!(error.kind, ProviderErrorKind::Cancelled);
    assert!(!error.retryable);
    assert!(
        tokio::time::timeout(Duration::from_secs(2), closed)
            .await
            .expect("provider kept the socket open after cancellation")
            .expect("loopback server dropped the close signal")
    );
    server.await.unwrap();
}

#[tokio::test]
async fn cancellation_drops_request_stalled_before_response_headers() {
    assert_cancel_during_stalled_response(b"").await;
}

#[tokio::test]
async fn cancellation_closes_connection_after_partial_non_success_response() {
    assert_cancel_during_stalled_response(
        b"HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: 100\r\nconnection: keep-alive\r\n\r\n{\"error\":",
    )
    .await;
}

#[tokio::test]
async fn cancellation_closes_connection_after_partial_non_streaming_response() {
    assert_cancel_during_stalled_response(
        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\nconnection: keep-alive\r\n\r\n{\"choices\":",
    )
    .await;
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
async fn cancellation_during_retry_backoff_is_typed_and_does_not_retry() {
    let server = MockServer::start(vec![MockTurn::Error {
        status: 429,
        body: "slow down".to_owned(),
        retry_after: Some("30".to_owned()),
    }])
    .await;
    let provider = provider(&server);
    let cancel = CancelToken::new();
    let request_cancel = cancel.clone();
    let request = tokio::spawn(async move {
        provider
            .stream(ModelRequest::new("mock-model"), request_cancel)
            .await
    });

    tokio::time::timeout(Duration::from_secs(2), async {
        while server.request_count() == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("provider did not dispatch its first request");
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_millis(500), request)
        .await
        .expect("provider did not leave retry backoff after cancellation")
        .expect("provider task panicked");
    let error = match result {
        Ok(_) => panic!("cancelled retry unexpectedly returned a stream"),
        Err(error) => error,
    };
    assert_eq!(error.kind, ProviderErrorKind::Cancelled);
    assert!(!error.retryable);
    assert_eq!(server.request_count(), 1);
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
async fn dropping_sse_stream_on_cancellation_closes_loopback_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        let (header_end, content_length) = loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0, "client closed before sending an HTTP request");
            request.extend_from_slice(&buffer[..count]);
            if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .expect("provider request has a content length");
                break (header_end, content_length);
            }
        };
        let request_end = header_end + 4 + content_length;
        while request.len() < request_end {
            let count = socket.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0, "client closed before completing the HTTP request");
            request.extend_from_slice(&buffer[..count]);
        }

        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\n\r\n",
            )
            .await
            .unwrap();
        let event = b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n";
        socket
            .write_all(format!("{:X}\r\n", event.len()).as_bytes())
            .await
            .unwrap();
        socket.write_all(event).await.unwrap();
        socket.write_all(b"\r\n").await.unwrap();
        socket.flush().await.unwrap();

        let closed = match socket.read(&mut buffer[..1]).await {
            Ok(0) => true,
            Ok(_) => false,
            Err(error) => matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
            ),
        };
        let _ = closed_tx.send(closed);
    });

    let cancel = CancelToken::new();
    let provider = ChatCompletionsProvider::new(ProviderConfig::new(
        "mock",
        format!("http://{address}/v1"),
        "test-key",
        "mock-model",
    ))
    .unwrap();
    let mut stream = provider
        .stream(ModelRequest::new("mock-model"), cancel.clone())
        .await
        .unwrap();

    assert!(matches!(stream.next().await, Some(Ok(ModelEvent::Started))));
    assert!(matches!(
        stream.next().await,
        Some(Ok(ModelEvent::TextDelta { text })) if text == "x"
    ));
    cancel.cancel();
    drop(stream);

    assert!(
        tokio::time::timeout(Duration::from_secs(2), closed_rx)
            .await
            .expect("provider kept the socket open after cancellation")
            .expect("loopback server dropped the disconnect signal")
    );
    server.await.unwrap();
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
