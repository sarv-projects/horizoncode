//! The chat-completions-compatible adapter (`ARCH/11-PROVIDER.md`).
//!
//! The adapter owns the wire shape (`messages[]` + `tools[]`, SSE `data:`
//! frames, `[DONE]` sentinel), auth header construction, retry classification,
//! and secret redaction. Vendor quirks stay here; the loop only sees
//! [`ModelEvent`] values.

use std::collections::VecDeque;
use std::time::Duration;

use agentx_types::{CancelToken, FinishReason, ModelEvent, ModelRequest, ProviderError, Usage};
use bytes::Bytes;
use futures::StreamExt;
use futures::stream::{self, BoxStream};
use reqwest::Response;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use serde_json::{Map, Value, json};

use crate::Provider;
use crate::redact::{Redactor, truncate};
use crate::retry::{RetryDecision, RetryPolicy, parse_retry_after};
use crate::secret::SecretString;
use crate::sse::{SseBuffer, SseFrame};

const ERROR_BODY_CAP: usize = 512;

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

    async fn open(&self, request: &ModelRequest) -> Result<Response, ProviderError> {
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
        let response =
            builder.json(&body).send().await.map_err(|error| {
                ProviderError::transport(self.redactor.redact(&error.to_string()))
            })?;

        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_retry_after);
        let body_hint = self.redactor.redact(&truncate(
            &response.text().await.unwrap_or_default(),
            ERROR_BODY_CAP,
        ));
        let mut error = ProviderError::from_status(status.as_u16(), &body_hint);
        if let Some(delay) = retry_after {
            error = error.with_retry_after(delay);
        }
        Err(error)
    }

    async fn decode(
        &self,
        response: Response,
    ) -> Result<BoxStream<'static, Result<ModelEvent, ProviderError>>, ProviderError> {
        let is_sse = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
        if is_sse {
            return Ok(sse_stream(response));
        }
        // Non-streaming fallback: decode one complete chat completion.
        let text = response
            .text()
            .await
            .map_err(|error| ProviderError::transport(self.redactor.redact(&error.to_string())))?;
        let value: Value = serde_json::from_str(&text).map_err(|error| {
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
            reason: state.finish.unwrap_or(FinishReason::Stop),
        }));
        Ok(Box::pin(stream::iter(events)))
    }
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
                return Err(ProviderError::transport("request cancelled"));
            }
            match self.open(&request).await {
                Ok(response) => return self.decode(response).await,
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
                                        return Err(ProviderError::transport("request cancelled"));
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
fn sse_stream(response: Response) -> BoxStream<'static, Result<ModelEvent, ProviderError>> {
    let inner = response.bytes_stream();
    let initial = SseState {
        inner: Box::pin(inner),
        sse: SseBuffer::new(),
        pending: VecDeque::new(),
        state: ChunkState::default(),
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
                Some(Ok(bytes)) => match state.sse.push(&bytes) {
                    Ok(frames) => state.absorb(frames),
                    Err(error) => {
                        state.state.done = true;
                        state.pending.push_back(Err(error));
                    }
                },
            }
        }
    }))
}

struct SseState {
    inner: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    sse: SseBuffer,
    pending: VecDeque<Result<ModelEvent, ProviderError>>,
    state: ChunkState,
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
            reason: self.state.finish.clone().unwrap_or(FinishReason::Stop),
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
            agentx_types::Role::Assistant if !message.tool_calls.is_empty() => {
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
            agentx_types::Role::Tool => {
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
                agentx_types::ToolChoice::Auto => "auto",
                agentx_types::ToolChoice::None => "none",
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
    use agentx_types::{Message, ToolCall, ToolCallId, ToolChoice, ToolDefinition};
    use serde_json::json;

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
            agentx_types::ProviderErrorKind::ContextOverflow
        );
    }

    #[test]
    fn status_code_constant_compiles() {
        // Guards against accidental header import drift.
        assert_eq!(reqwest::StatusCode::OK.as_u16(), 200);
    }
}
