//! The chat-completions-compatible adapter (`ARCH/11-PROVIDER.md`).
//!
//! The adapter owns the wire shape (`messages[]` + `tools[]`, SSE `data:`
//! frames, `[DONE]` sentinel), auth header construction, retry classification,
//! and secret redaction. Vendor quirks stay here; the loop only sees
//! [`ModelEvent`] values.

use std::collections::VecDeque;
use std::time::Duration;

use bytes::Bytes;
use futures::stream::{self, BoxStream};
use futures::{Stream, StreamExt};
use horizoncode_types::{
    CancelToken, FinishReason, ModelEvent, ModelRequest, ProviderError, Usage,
};
use reqwest::Response;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use serde_json::{Map, Value, json};

use crate::Provider;
use crate::redact::Redactor;
use crate::retry::{RetryDecision, RetryPolicy, parse_retry_after};
use crate::secret::SecretString;
use crate::sse::{MAX_SSE_LINE_BYTES, SseBuffer, SseFrame};

const RESPONSE_LIMITS_VERSION: u16 = 1;
const MAX_PROVIDER_BODY_BYTES: usize = 16_777_216;
const MAX_ERROR_BODY_PREVIEW_BYTES: usize = 8_192;
const MAX_ERROR_PREVIEW_SCALARS: usize = 512;

/// Configuration for [`ChatCompletionsProvider`].
///
/// `Debug` is derived; [`SecretString`]'s `Debug` redacts the credential.
#[derive(Clone, Debug)]
pub struct ProviderConfig {
    /// The provider/route id (not a vendor name).
    pub name: String,
    /// The base URL, e.g. `https://host/v1`. `/chat/completions` is appended.
    pub base_url: String,
    /// The credential; never logged.
    pub api_key: SecretString,
    /// The default model id.
    pub model: String,
    /// Extra request headers (non-secret).
    pub headers: Vec<(String, String)>,
    /// Request-start retry policy.
    pub retry: RetryPolicy,
    /// Per-request timeout.
    pub timeout: Duration,
}

impl ProviderConfig {
    /// Builds a config with default retry and timeout.
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<SecretString>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            base_url: base_url.into(),
            api_key: api_key.into(),
            model: model.into(),
            headers: Vec::new(),
            retry: RetryPolicy::default(),
            timeout: Duration::from_secs(600),
        }
    }

    fn chat_endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
    }
}

/// A chat-completions-compatible provider.
#[derive(Debug)]
pub struct ChatCompletionsProvider {
    config: ProviderConfig,
    client: reqwest::Client,
    redactor: Redactor,
}

impl ChatCompletionsProvider {
    /// Builds a provider.
    ///
    /// # Errors
    /// Returns [`ProviderError::invalid_request`] for a non-HTTP(S) base URL,
    /// or [`ProviderError::transport`] when the HTTP client cannot be built.
    pub fn new(config: ProviderConfig) -> Result<Self, ProviderError> {
        if !(config.base_url.starts_with("http://") || config.base_url.starts_with("https://")) {
            return Err(ProviderError::invalid_request(format!(
                "provider base url must be http(s): {}",
                config.base_url
            )));
        }
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|error| ProviderError::transport(format!("http client: {error}")))?;
        let redactor = Redactor::new([config.api_key.expose().to_owned()]);
        Ok(Self {
            config,
            client,
            redactor,
        })
    }

    /// Returns the configured endpoint.
    #[must_use]
    pub fn endpoint(&self) -> String {
        self.config.chat_endpoint()
    }

    async fn open(
        &self,
        request: &ModelRequest,
        cancel: &CancelToken,
    ) -> Result<Response, ProviderError> {
        let body = build_body(request, true);
        let mut builder = self
            .client
            .post(self.config.chat_endpoint())
            .header(CONTENT_TYPE, "application/json")
            .header(
                AUTHORIZATION,
                format!("Bearer {}", self.config.api_key.expose()),
            );
        for (name, value) in &self.config.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let send = builder.json(&body).send();
        let response = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ProviderError::cancelled()),
            result = send => result.map_err(|error| {
                ProviderError::transport(self.redactor.redact(&error.to_string()))
            })?,
        };

        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_retry_after);
        let body_preview =
            read_error_body_preview(response, MAX_ERROR_BODY_PREVIEW_BYTES, cancel).await?;
        let body_hint = render_error_body_preview(&body_preview, &self.redactor);
        let mut error =
            ProviderError::from_status(status.as_u16(), &body_hint).with_status(status.as_u16());
        if let Some(delay) = retry_after {
            error = error.with_retry_after(delay);
        }
        Err(error)
    }

    async fn decode(
        &self,
        response: Response,
        cancel: &CancelToken,
    ) -> Result<BoxStream<'static, Result<ModelEvent, ProviderError>>, ProviderError> {
        reject_declared_oversize(response.content_length(), MAX_PROVIDER_BODY_BYTES)?;
        let is_sse = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
        if is_sse {
            return Ok(sse_stream(
                response,
                MAX_PROVIDER_BODY_BYTES,
                MAX_SSE_LINE_BYTES,
            ));
        }
        // Non-streaming fallback: decode one complete chat completion.
        let redactor = self.redactor.clone();
        let chunks = response.bytes_stream().map(move |result| {
            result.map_err(|error| ProviderError::transport(redactor.redact(&error.to_string())))
        });
        let body =
            collect_bounded_body_cancellable(chunks, MAX_PROVIDER_BODY_BYTES, cancel).await?;
        let value: Value = serde_json::from_slice(&body).map_err(|error| {
            ProviderError::unknown(format!("malformed provider response: {error}"))
        })?;
        let mut state = ChunkState::default();
        let mut events = Vec::new();
        events.push(Ok(ModelEvent::Started));
        apply_non_streaming(&value, &mut state, &mut events);
        if let Some(usage) = state.usage {
            events.push(Ok(ModelEvent::Usage(usage)));
        }
        events.push(Ok(ModelEvent::Finished {
            reason: state
                .finish
                .unwrap_or_else(|| FinishReason::Other("missing_finish_reason".to_owned())),
        }));
        Ok(Box::pin(stream::iter(events)))
    }
}

#[derive(Debug, Default)]
struct BodyPreview {
    bytes: Vec<u8>,
    capped: bool,
}

fn reject_declared_oversize(length: Option<u64>, limit: usize) -> Result<(), ProviderError> {
    if length.is_some_and(|length| length > limit as u64) {
        return Err(response_limit_error("response body", limit));
    }
    Ok(())
}

fn response_limit_error(subject: &str, limit: usize) -> ProviderError {
    ProviderError::response_limit(format!(
        "provider response limit version {RESPONSE_LIMITS_VERSION}: {subject} exceeds {limit} bytes"
    ))
}

#[cfg(test)]
async fn collect_bounded_body<S>(chunks: S, limit: usize) -> Result<Vec<u8>, ProviderError>
where
    S: Stream<Item = Result<Bytes, ProviderError>>,
{
    futures::pin_mut!(chunks);
    let mut body = Vec::new();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        let remaining = limit.saturating_sub(body.len());
        if chunk.len() > remaining {
            return Err(response_limit_error("response body", limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn collect_bounded_body_cancellable<S>(
    chunks: S,
    limit: usize,
    cancel: &CancelToken,
) -> Result<Vec<u8>, ProviderError>
where
    S: Stream<Item = Result<Bytes, ProviderError>>,
{
    futures::pin_mut!(chunks);
    let mut body = Vec::new();
    loop {
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ProviderError::cancelled()),
            next = chunks.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk?;
        let remaining = limit.saturating_sub(body.len());
        if chunk.len() > remaining {
            return Err(response_limit_error("response body", limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn read_error_body_preview(
    response: Response,
    limit: usize,
    cancel: &CancelToken,
) -> Result<BodyPreview, ProviderError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Ok(BodyPreview {
            bytes: Vec::new(),
            capped: true,
        });
    }
    read_bounded_preview_cancellable(response.bytes_stream(), limit, cancel).await
}

async fn read_bounded_preview_cancellable<S, E>(
    chunks: S,
    limit: usize,
    cancel: &CancelToken,
) -> Result<BodyPreview, ProviderError>
where
    S: Stream<Item = Result<Bytes, E>>,
{
    futures::pin_mut!(chunks);
    let mut preview = BodyPreview::default();
    while preview.bytes.len() < limit {
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ProviderError::cancelled()),
            next = chunks.next() => next,
        };
        let chunk = match next {
            Some(Ok(chunk)) => chunk,
            Some(Err(_)) => {
                preview.capped = true;
                break;
            }
            None => break,
        };
        let remaining = limit.saturating_sub(preview.bytes.len());
        let retained = chunk.len().min(remaining);
        preview.bytes.extend_from_slice(&chunk[..retained]);
        if retained < chunk.len() || preview.bytes.len() == limit {
            preview.capped = true;
            break;
        }
    }
    if limit == 0 {
        preview.capped = true;
    }
    Ok(preview)
}

#[cfg(test)]
async fn read_bounded_preview<S, E>(chunks: S, limit: usize) -> BodyPreview
where
    S: Stream<Item = Result<Bytes, E>>,
{
    futures::pin_mut!(chunks);
    let mut preview = BodyPreview::default();
    while preview.bytes.len() < limit {
        let chunk = match chunks.next().await {
            Some(Ok(chunk)) => chunk,
            Some(Err(_)) => {
                preview.capped = true;
                break;
            }
            None => break,
        };
        let remaining = limit.saturating_sub(preview.bytes.len());
        let retained = chunk.len().min(remaining);
        preview.bytes.extend_from_slice(&chunk[..retained]);
        if retained < chunk.len() || preview.bytes.len() == limit {
            preview.capped = true;
            break;
        }
    }
    if limit == 0 {
        preview.capped = true;
    }
    preview
}

fn render_error_body_preview(preview: &BodyPreview, redactor: &Redactor) -> String {
    let raw = String::from_utf8_lossy(&preview.bytes);
    let redacted = redactor.redact(&raw);
    let single_line = redacted
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let needs_marker = preview.capped || single_line.chars().count() > MAX_ERROR_PREVIEW_SCALARS;
    let content_limit = if needs_marker {
        MAX_ERROR_PREVIEW_SCALARS.saturating_sub(1)
    } else {
        MAX_ERROR_PREVIEW_SCALARS
    };
    let mut rendered = single_line.chars().take(content_limit).collect::<String>();
    if needs_marker {
        rendered.push('…');
    }
    rendered
}

#[async_trait::async_trait]
impl Provider for ChatCompletionsProvider {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn model(&self) -> &str {
        &self.config.model
    }

    async fn stream(
        &self,
        request: ModelRequest,
        cancel: CancelToken,
    ) -> Result<BoxStream<'static, Result<ModelEvent, ProviderError>>, ProviderError> {
        let mut attempt: u32 = 0;
        loop {
            if cancel.is_cancelled() {
                return Err(ProviderError::cancelled());
            }
            match self.open(&request, &cancel).await {
                Ok(response) => return self.decode(response, &cancel).await,
                Err(error) => {
                    if !error.retryable {
                        return Err(error);
                    }
                    let jitter: f64 = rand::random::<f64>();
                    match self.config.retry.decide(attempt, error.retry_after, jitter) {
                        RetryDecision::Stop => return Err(error),
                        RetryDecision::RetryAfter(delay) => {
                            attempt += 1;
                            if !delay.is_zero() {
                                tokio::select! {
                                    () = tokio::time::sleep(delay) => {}
                                    () = cancel.cancelled() => {
                                        return Err(ProviderError::cancelled());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Accumulator shared by the SSE and non-streaming decoders.
#[derive(Debug, Default)]
struct ChunkState {
    started: bool,
    finish: Option<FinishReason>,
    usage: Option<Usage>,
    done: bool,
}

fn map_finish_reason(reason: &str) -> FinishReason {
    match reason {
        "stop" | "end_turn" => FinishReason::Stop,
        "tool_calls" | "function_call" => FinishReason::ToolCalls,
        "length" | "max_tokens" => FinishReason::Length,
        "content_filter" => FinishReason::ContentFilter,
        other => FinishReason::Other(other.to_owned()),
    }
}

// `done` is set in the terminal branch but read on the next poll, not within
// the same call, so the compiler's unused-assignment lint is a false positive.
#[allow(unused_assignments)]
fn sse_stream(
    response: Response,
    max_body_bytes: usize,
    max_line_bytes: usize,
) -> BoxStream<'static, Result<ModelEvent, ProviderError>> {
    sse_stream_from_chunks(
        Box::pin(response.bytes_stream()),
        max_body_bytes,
        max_line_bytes,
    )
}

fn sse_stream_from_chunks(
    inner: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    max_body_bytes: usize,
    max_line_bytes: usize,
) -> BoxStream<'static, Result<ModelEvent, ProviderError>> {
    let initial = SseState {
        inner,
        sse: SseBuffer::with_max_line_bytes(max_line_bytes),
        pending: VecDeque::new(),
        state: ChunkState::default(),
        max_body_bytes,
        body_bytes: 0,
    };
    Box::pin(stream::unfold(initial, |mut state| async move {
        loop {
            if let Some(item) = state.pending.pop_front() {
                return Some((item, state));
            }
            if state.state.done {
                return None;
            }
            match state.inner.next().await {
                None => {
                    let frames = match state.sse.finish() {
                        Ok(frames) => frames,
                        Err(error) => {
                            state.state.done = true;
                            state.pending.push_back(Err(error));
                            continue;
                        }
                    };
                    state.absorb(frames);
                    if state.pending.is_empty() {
                        state.finish_out();
                    }
                    if state.pending.is_empty() {
                        state.state.done = true;
                        return None;
                    }
                }
                Some(Err(error)) => {
                    state.state.done = true;
                    state
                        .pending
                        .push_back(Err(ProviderError::transport(format!(
                            "stream error: {error}"
                        ))));
                }
                Some(Ok(bytes)) => {
                    let remaining = state.max_body_bytes.saturating_sub(state.body_bytes);
                    if bytes.len() > remaining {
                        state.state.done = true;
                        state.pending.push_back(Err(response_limit_error(
                            "response body",
                            state.max_body_bytes,
                        )));
                        continue;
                    }
                    state.body_bytes += bytes.len();
                    match state.sse.push(&bytes) {
                        Ok(frames) => state.absorb(frames),
                        Err(error) => {
                            state.state.done = true;
                            state.pending.push_back(Err(error));
                        }
                    }
                }
            }
        }
    }))
}

struct SseState {
    inner: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    sse: SseBuffer,
    pending: VecDeque<Result<ModelEvent, ProviderError>>,
    state: ChunkState,
    max_body_bytes: usize,
    body_bytes: usize,
}

impl SseState {
    fn absorb(&mut self, frames: Vec<SseFrame>) {
        for frame in frames {
            if self.state.done {
                break;
            }
            match frame {
                SseFrame::Data(payload) => {
                    if !self.state.started {
                        self.state.started = true;
                        self.pending.push_back(Ok(ModelEvent::Started));
                    }
                    match serde_json::from_str::<Value>(&payload) {
                        Ok(value) => apply_chunk(&value, &mut self.state, &mut self.pending),
                        Err(error) => self.pending.push_back(Err(ProviderError::unknown(format!(
                            "malformed provider chunk: {error}"
                        )))),
                    }
                }
                SseFrame::Done => {
                    self.state.done = true;
                    self.finish_out();
                }
            }
        }
    }

    fn finish_out(&mut self) {
        if !self.state.started {
            self.state.started = true;
            self.pending.push_back(Ok(ModelEvent::Started));
        }
        if let Some(usage) = self.state.usage.take() {
            self.pending.push_back(Ok(ModelEvent::Usage(usage)));
        }
        self.pending.push_back(Ok(ModelEvent::Finished {
            reason: self
                .state
                .finish
                .clone()
                .unwrap_or_else(|| FinishReason::Other("missing_finish_reason".to_owned())),
        }));
        self.state.done = true;
    }
}

fn apply_chunk(
    value: &Value,
    state: &mut ChunkState,
    out: &mut VecDeque<Result<ModelEvent, ProviderError>>,
) {
    if let Some(usage) = parse_usage(value.get("usage")) {
        state.usage = Some(match state.usage {
            Some(existing) => {
                let mut merged = existing;
                merged.add_assign(usage);
                merged
            }
            None => usage,
        });
    }
    let Some(choice) = value.get("choices").and_then(|choices| choices.get(0)) else {
        return;
    };
    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
        state.finish = Some(map_finish_reason(reason));
    }
    if let Some(delta) = choice.get("delta") {
        if let Some(text) = delta.get("content").and_then(Value::as_str)
            && !text.is_empty()
        {
            out.push_back(Ok(ModelEvent::TextDelta {
                text: text.to_owned(),
            }));
        }
        let reasoning = delta
            .get("reasoning_content")
            .and_then(Value::as_str)
            .or_else(|| delta.get("reasoning").and_then(Value::as_str));
        if let Some(text) = reasoning
            && !text.is_empty()
        {
            out.push_back(Ok(ModelEvent::ReasoningDelta {
                text: text.to_owned(),
            }));
        }
        if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in tool_calls {
                out.push_back(Ok(parse_tool_call_delta(call)));
            }
        }
    } else if let Some(message) = choice.get("message") {
        if let Some(text) = message.get("content").and_then(Value::as_str)
            && !text.is_empty()
        {
            out.push_back(Ok(ModelEvent::TextDelta {
                text: text.to_owned(),
            }));
        }
        if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in tool_calls {
                out.push_back(Ok(parse_tool_call_delta(call)));
            }
        }
    }
}

fn apply_non_streaming(
    value: &Value,
    state: &mut ChunkState,
    out: &mut Vec<Result<ModelEvent, ProviderError>>,
) {
    if let Some(usage) = parse_usage(value.get("usage")) {
        state.usage = Some(usage);
    }
    if let Some(choice) = value.get("choices").and_then(|choices| choices.get(0)) {
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            state.finish = Some(map_finish_reason(reason));
        }
        if let Some(message) = choice.get("message") {
            if let Some(text) = message.get("content").and_then(Value::as_str)
                && !text.is_empty()
            {
                out.push(Ok(ModelEvent::TextDelta {
                    text: text.to_owned(),
                }));
            }
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    out.push(Ok(parse_tool_call_delta(call)));
                }
            }
        }
    }
}

fn parse_tool_call_delta(call: &Value) -> ModelEvent {
    let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
    let id = call.get("id").and_then(Value::as_str).map(str::to_owned);
    let function = call.get("function");
    let name = function
        .and_then(|f| f.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let arguments_delta = function
        .and_then(|f| f.get("arguments"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    ModelEvent::ToolCallDelta {
        index,
        id,
        name,
        arguments_delta,
    }
}

fn parse_usage(value: Option<&Value>) -> Option<Usage> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    let input_tokens = value
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = value
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached_read_tokens = value
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning_tokens = value
        .get("completion_tokens_details")
        .and_then(|details| details.get("reasoning_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(Usage {
        input_tokens,
        output_tokens,
        cached_read_tokens,
        cached_write_tokens: 0,
        reasoning_tokens,
    })
}

/// Builds the chat-completions request body.
#[must_use]
pub fn build_body(request: &ModelRequest, stream: bool) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    for system in &request.system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for message in &request.messages {
        let text = message.text();
        match message.role {
            horizoncode_types::Role::Assistant if !message.tool_calls.is_empty() => {
                let calls: Vec<Value> = message
                    .tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id.as_str(),
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments.to_string(),
                            }
                        })
                    })
                    .collect();
                let mut entry = Map::new();
                entry.insert("role".to_owned(), json!("assistant"));
                if !text.is_empty() {
                    entry.insert("content".to_owned(), json!(text));
                }
                entry.insert("tool_calls".to_owned(), Value::Array(calls));
                messages.push(Value::Object(entry));
            }
            horizoncode_types::Role::Tool => {
                let mut entry = Map::new();
                entry.insert("role".to_owned(), json!("tool"));
                entry.insert("content".to_owned(), json!(text));
                if let Some(id) = &message.tool_call_id {
                    entry.insert("tool_call_id".to_owned(), json!(id.as_str()));
                }
                messages.push(Value::Object(entry));
            }
            role => {
                messages.push(json!({ "role": role.as_str(), "content": text }));
            }
        }
    }

    let mut body = Map::new();
    body.insert("model".to_owned(), json!(request.model));
    body.insert("messages".to_owned(), Value::Array(messages));
    body.insert("stream".to_owned(), json!(stream));
    if stream {
        body.insert(
            "stream_options".to_owned(),
            json!({ "include_usage": true }),
        );
    }
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    }
                })
            })
            .collect();
        body.insert("tools".to_owned(), Value::Array(tools));
        body.insert(
            "tool_choice".to_owned(),
            json!(match request.tool_choice {
                horizoncode_types::ToolChoice::Auto => "auto",
                horizoncode_types::ToolChoice::None => "none",
            }),
        );
    }
    if let Some(temperature) = request.temperature {
        body.insert("temperature".to_owned(), json!(temperature));
    }
    if let Some(max_output) = request.max_output_tokens {
        body.insert("max_tokens".to_owned(), json!(max_output));
    }
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;
    use horizoncode_types::{Message, ToolCall, ToolCallId, ToolChoice, ToolDefinition};
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct DropSignal(Arc<AtomicBool>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn body_includes_tools_and_tool_choice() {
        let mut request = ModelRequest::new("m")
            .with_system(vec!["be terse".to_owned()])
            .with_messages(vec![
                Message::user("read the file"),
                Message::assistant_tool_calls(
                    "",
                    vec![ToolCall::new(
                        ToolCallId::new("call_1"),
                        "read",
                        json!({"path": "a.txt"}),
                    )],
                ),
                Message::tool_result(ToolCallId::new("call_1"), "contents"),
            ]);
        request.tools = vec![ToolDefinition::new(
            "read",
            "Read a file",
            json!({"type": "object"}),
            None,
        )];
        let body = build_body(&request, true);
        assert_eq!(body["model"], "m");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][2]["role"], "assistant");
        assert_eq!(
            body["messages"][2]["tool_calls"][0]["function"]["name"],
            "read"
        );
        assert_eq!(body["messages"][3]["role"], "tool");
        assert_eq!(body["tools"][0]["function"]["name"], "read");
        assert_eq!(body["tool_choice"], "auto");
    }

    #[test]
    fn body_disables_tools_without_advertising_them() {
        let mut request = ModelRequest::new("m");
        request.tool_choice = ToolChoice::None;
        let body = build_body(&request, false);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn parses_usage_details() {
        let usage = parse_usage(Some(&json!({
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "prompt_tokens_details": {"cached_tokens": 64},
            "completion_tokens_details": {"reasoning_tokens": 8}
        })))
        .unwrap();
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 20);
        assert_eq!(usage.cached_read_tokens, 64);
        assert_eq!(usage.reasoning_tokens, 8);
    }

    #[test]
    fn maps_finish_reasons() {
        assert_eq!(map_finish_reason("stop"), FinishReason::Stop);
        assert_eq!(map_finish_reason("tool_calls"), FinishReason::ToolCalls);
        assert_eq!(map_finish_reason("length"), FinishReason::Length);
        assert_eq!(
            map_finish_reason("weird"),
            FinishReason::Other("weird".to_owned())
        );
    }

    #[test]
    fn rejects_non_http_base_url() {
        let config = ProviderConfig::new("p", "ftp://host", "k", "m");
        assert!(ChatCompletionsProvider::new(config).is_err());
    }

    #[test]
    fn from_status_classifies_retryability() {
        assert!(!ProviderError::from_status(401, "").retryable);
        assert!(ProviderError::from_status(429, "").retryable);
        assert!(ProviderError::from_status(503, "").retryable);
        assert_eq!(
            ProviderError::from_status(413, "").kind,
            horizoncode_types::ProviderErrorKind::ContextOverflow
        );
    }

    #[test]
    fn status_code_constant_compiles() {
        // Guards against accidental header import drift.
        assert_eq!(reqwest::StatusCode::OK.as_u16(), 200);
    }

    #[tokio::test]
    async fn bounded_body_reader_accepts_the_ceiling_and_rejects_the_first_extra_byte() {
        let exact = stream::iter(vec![
            Ok::<_, ProviderError>(Bytes::from_static(b"abc")),
            Ok(Bytes::from_static(b"de")),
        ]);
        assert_eq!(collect_bounded_body(exact, 5).await.unwrap(), b"abcde");

        let over = stream::iter(vec![
            Ok::<_, ProviderError>(Bytes::from_static(b"abc")),
            Ok(Bytes::from_static(b"def")),
        ]);
        let error = collect_bounded_body(over, 5).await.unwrap_err();
        assert_eq!(
            error.kind,
            horizoncode_types::ProviderErrorKind::ResponseLimit
        );
        assert!(!error.retryable);
    }

    #[tokio::test]
    async fn bounded_body_reader_returns_cancelled_while_waiting_for_another_chunk() {
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        let mut waiting_tx = Some(waiting_tx);
        let mut first = true;
        let chunks = stream::poll_fn(move |_| {
            if first {
                first = false;
                std::task::Poll::Ready(Some(Ok::<_, ProviderError>(Bytes::from_static(b"{"))))
            } else {
                if let Some(tx) = waiting_tx.take() {
                    let _ = tx.send(());
                }
                std::task::Poll::Pending
            }
        });
        let cancel = CancelToken::new();
        let reader_cancel = cancel.clone();
        let reader = tokio::spawn(async move {
            collect_bounded_body_cancellable(chunks, 100, &reader_cancel).await
        });
        waiting_rx.await.unwrap();
        cancel.cancel();
        let error = tokio::time::timeout(Duration::from_millis(100), reader)
            .await
            .expect("body reader ignored cancellation")
            .expect("body reader task panicked")
            .unwrap_err();
        assert_eq!(error.kind, horizoncode_types::ProviderErrorKind::Cancelled);
        assert!(!error.retryable);
    }

    #[tokio::test]
    async fn error_preview_reader_returns_cancelled_while_waiting_for_another_chunk() {
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        let mut waiting_tx = Some(waiting_tx);
        let mut first = true;
        let chunks = stream::poll_fn(move |_| {
            if first {
                first = false;
                std::task::Poll::Ready(Some(Ok::<_, ()>(Bytes::from_static(b"error prefix"))))
            } else {
                if let Some(tx) = waiting_tx.take() {
                    let _ = tx.send(());
                }
                std::task::Poll::Pending
            }
        });
        let cancel = CancelToken::new();
        let reader_cancel = cancel.clone();
        let reader = tokio::spawn(async move {
            read_bounded_preview_cancellable(chunks, 8_192, &reader_cancel).await
        });
        waiting_rx.await.unwrap();
        cancel.cancel();
        let error = tokio::time::timeout(Duration::from_millis(100), reader)
            .await
            .expect("preview reader ignored cancellation")
            .expect("preview reader task panicked")
            .unwrap_err();
        assert_eq!(error.kind, horizoncode_types::ProviderErrorKind::Cancelled);
        assert!(!error.retryable);
    }

    #[tokio::test]
    async fn sse_aggregate_limit_preserves_partial_events_without_a_finish() {
        let first = b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n";
        let inner = Box::pin(stream::iter(vec![
            Ok(Bytes::from_static(first)),
            Ok(Bytes::from_static(b":x\n")),
        ]));
        let events = sse_stream_from_chunks(inner, first.len(), 1024)
            .collect::<Vec<_>>()
            .await;

        assert!(events.iter().any(|event| matches!(
            event,
            Ok(ModelEvent::TextDelta { text }) if text == "x"
        )));
        assert!(matches!(
            events.last(),
            Some(Err(error)) if error.kind == horizoncode_types::ProviderErrorKind::ResponseLimit
        ));
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Ok(ModelEvent::Finished { .. })))
        );
    }

    #[tokio::test]
    async fn dropping_sse_consumer_drops_the_underlying_response_stream() {
        let dropped = Arc::new(AtomicBool::new(false));
        let signal = DropSignal(dropped.clone());
        let source = stream::unfold((signal, false), |(signal, sent)| async move {
            if sent {
                std::future::pending().await
            } else {
                Some((
                    Ok::<_, reqwest::Error>(Bytes::from_static(
                        b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n",
                    )),
                    (signal, true),
                ))
            }
        });
        let mut response = sse_stream_from_chunks(Box::pin(source), 1024, 1024);

        assert!(matches!(
            response.next().await,
            Some(Ok(ModelEvent::Started))
        ));
        drop(response);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn error_preview_reader_stops_retaining_bytes_at_its_ceiling() {
        let pulls = Arc::new(AtomicUsize::new(0));
        let source_pulls = pulls.clone();
        let chunks = stream::unfold(0, move |index| {
            let source_pulls = source_pulls.clone();
            async move {
                source_pulls.fetch_add(1, Ordering::SeqCst);
                match index {
                    0 => Some((Ok::<_, ()>(Bytes::from_static(b"1234")), 1)),
                    1 => Some((Ok(Bytes::from_static(b"5678")), 2)),
                    2 => Some((Ok(Bytes::from_static(b"not-read")), 3)),
                    _ => None,
                }
            }
        });
        let preview = read_bounded_preview(chunks, 8).await;
        assert_eq!(preview.bytes, b"12345678");
        assert!(preview.capped);
        assert_eq!(pulls.load(Ordering::SeqCst), 2, "read past preview ceiling");
    }

    #[test]
    fn error_preview_redacts_before_unicode_scalar_truncation() {
        let raw = format!("Bearer very-secret {}", "🙂".repeat(600));
        let preview = BodyPreview {
            bytes: raw.into_bytes(),
            capped: true,
        };
        let rendered =
            render_error_body_preview(&preview, &Redactor::new(["very-secret".to_owned()]));
        assert!(!rendered.contains("very-secret"));
        assert!(rendered.ends_with('…'));
        assert!(rendered.chars().count() <= MAX_ERROR_PREVIEW_SCALARS);
    }

    #[test]
    fn declared_response_length_overflow_is_typed_and_fail_closed() {
        let error = reject_declared_oversize(
            Some(MAX_PROVIDER_BODY_BYTES as u64 + 1),
            MAX_PROVIDER_BODY_BYTES,
        )
        .unwrap_err();
        assert_eq!(
            error.kind,
            horizoncode_types::ProviderErrorKind::ResponseLimit
        );
        assert!(!error.retryable);
        assert!(
            reject_declared_oversize(
                Some(MAX_PROVIDER_BODY_BYTES as u64),
                MAX_PROVIDER_BODY_BYTES
            )
            .is_ok()
        );
    }
}
