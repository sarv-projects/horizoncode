//! An in-process chat-completions-compatible mock server for tests.
//!
//! Enabled by the `testing` feature. It binds an ephemeral localhost port and
//! replays a scripted sequence of responses, recording every request body so
//! tests can assert what the loop actually sent. It never reaches the network
//! beyond the loopback listener (`REQ-PROV-004` test isolation).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use horizoncode_types::CancelToken;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One scripted provider response.
#[derive(Clone, Debug)]
pub enum MockTurn {
    /// Stream a text completion.
    Text(String),
    /// Stream a tool call, optionally preceded by assistant text.
    ToolCall {
        /// Assistant preamble text.
        preamble: String,
        /// The tool name.
        name: String,
        /// The tool arguments.
        arguments: Value,
    },
    /// Fail the request with a status and body.
    Error {
        /// The HTTP status.
        status: u16,
        /// The response body.
        body: String,
        /// An optional `Retry-After` header value.
        retry_after: Option<String>,
    },
}

impl MockTurn {
    /// Builds a plain text turn.
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text(text.into())
    }

    /// Builds a tool-call turn with no preamble.
    #[must_use]
    pub fn tool_call(name: impl Into<String>, arguments: Value) -> Self {
        Self::ToolCall {
            preamble: String::new(),
            name: name.into(),
            arguments,
        }
    }
}

/// A running mock provider.
pub struct MockServer {
    base_url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    shutdown: CancelToken,
    handle: tokio::task::JoinHandle<()>,
}

impl std::fmt::Debug for MockServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MockServer")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl MockServer {
    /// Starts a mock server that replays `turns` in order.
    ///
    /// # Panics
    /// Panics if the loopback listener cannot be bound, which would indicate a
    /// broken test environment.
    pub async fn start(turns: Vec<MockTurn>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock provider listener");
        let addr = listener.local_addr().expect("mock provider local addr");
        let turns = Arc::new(Mutex::new(VecDeque::from(turns)));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let shutdown = CancelToken::new();
        let stop = shutdown.clone();
        let recorded = requests.clone();
        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = stop.cancelled() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        let turns = turns.clone();
                        let recorded = recorded.clone();
                        tokio::spawn(async move {
                            let _ = handle_connection(stream, turns, recorded).await;
                        });
                    }
                }
            }
        });
        Self {
            base_url: format!("http://{addr}/v1"),
            requests,
            shutdown,
            handle,
        }
    }

    /// Returns the base URL to hand to the provider config.
    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Returns every recorded request body, oldest first.
    #[must_use]
    pub fn requests(&self) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Returns the number of recorded requests.
    #[must_use]
    pub fn request_count(&self) -> usize {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
        self.handle.abort();
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    turns: Arc<Mutex<VecDeque<MockTurn>>>,
    recorded: Arc<Mutex<Vec<Value>>>,
) -> std::io::Result<()> {
    let mut buffer: Vec<u8> = Vec::new();
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
    };
    let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let content_length = parse_content_length(&headers);
    let body_start = header_end + 4;
    while buffer.len() < body_start + content_length {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = &buffer[body_start..(body_start + content_length).min(buffer.len())];
    // The request number doubles as the response identity, so a tool call this
    // mock emits carries a unique id the way a real provider's does. A tool-call
    // id is a correlation token: it is what the tool result is matched against,
    // so reusing one id across responses would model a provider that breaks its
    // own protocol, and the tool plane is right to refuse to spend a grant
    // against an identity that has already been spent (`F-66`).
    let response_number = {
        let mut recorded = recorded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Ok(value) = serde_json::from_slice::<Value>(body) {
            recorded.push(value);
        }
        recorded.len()
    };

    let turn = turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .pop_front();
    let response = match turn {
        Some(MockTurn::Text(text)) => sse_response(text_chunks(&text, "stop")),
        Some(MockTurn::ToolCall {
            preamble,
            name,
            arguments,
        }) => sse_response(tool_call_chunks(
            &preamble,
            &name,
            &arguments,
            response_number,
        )),
        Some(MockTurn::Error {
            status,
            body,
            retry_after,
        }) => error_response(status, &body, retry_after.as_deref()),
        None => error_response(500, "mock server exhausted", None),
    };
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    stream.shutdown().await?;
    Ok(())
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(headers: &str) -> usize {
    headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0)
}

fn sse_response(chunks: Vec<Value>) -> String {
    let mut body = String::new();
    for chunk in chunks {
        body.push_str("data: ");
        body.push_str(&chunk.to_string());
        body.push_str("\n\n");
    }
    body.push_str("data: [DONE]\n\n");
    http_response(200, "text/event-stream", &body, None)
}

fn error_response(status: u16, body: &str, retry_after: Option<&str>) -> String {
    http_response(status, "application/json", body, retry_after)
}

fn http_response(status: u16, content_type: &str, body: &str, retry_after: Option<&str>) -> String {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    };
    let mut extra = String::new();
    if let Some(after) = retry_after {
        extra.push_str(&format!("Retry-After: {after}\r\n"));
    }
    format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         {extra}\r\n{body}",
        len = body.len(),
    )
}

fn chunk(delta: Value, finish_reason: Option<&str>) -> Value {
    json!({
        "id": "chatcmpl-mock",
        "object": "chat.completion.chunk",
        "model": "mock-model",
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }]
    })
}

fn usage_chunk(input: u64, output: u64) -> Value {
    json!({
        "id": "chatcmpl-mock",
        "object": "chat.completion.chunk",
        "model": "mock-model",
        "choices": [],
        "usage": {
            "prompt_tokens": input,
            "completion_tokens": output,
            "total_tokens": input + output,
            "prompt_tokens_details": {"cached_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 0}
        }
    })
}

fn text_chunks(text: &str, finish: &str) -> Vec<Value> {
    let mut chunks = vec![chunk(json!({"role": "assistant", "content": ""}), None)];
    // Split into two deltas so the decoder is exercised across chunks.
    let split = text.len() / 2;
    let split = (0..=split)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    for part in [&text[..split], &text[split..]] {
        if !part.is_empty() {
            chunks.push(chunk(json!({"content": part}), None));
        }
    }
    chunks.push(chunk(json!({}), Some(finish)));
    chunks.push(usage_chunk(10, 5));
    chunks
}

/// Builds the streamed chunks for one tool call, identified by `response_number`.
fn tool_call_chunks(
    preamble: &str,
    name: &str,
    arguments: &Value,
    response_number: usize,
) -> Vec<Value> {
    let mut chunks = vec![chunk(json!({"role": "assistant", "content": ""}), None)];
    if !preamble.is_empty() {
        chunks.push(chunk(json!({"content": preamble}), None));
    }
    chunks.push(chunk(
        json!({"tool_calls": [{
            "index": 0,
            "id": format!("call_mock_{response_number}"),
            "type": "function",
            "function": {"name": name, "arguments": ""}
        }]}),
        None,
    ));
    let arguments = arguments.to_string();
    let split = (0..=arguments.len() / 2)
        .rev()
        .find(|i| arguments.is_char_boundary(*i))
        .unwrap_or(0);
    for part in [&arguments[..split], &arguments[split..]] {
        if !part.is_empty() {
            chunks.push(chunk(
                json!({"tool_calls": [{"index": 0, "function": {"arguments": part}}]}),
                None,
            ));
        }
    }
    chunks.push(chunk(json!({}), Some("tool_calls")));
    chunks.push(usage_chunk(20, 8));
    chunks
}
