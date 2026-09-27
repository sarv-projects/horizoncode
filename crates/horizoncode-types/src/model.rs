//! The vendor-neutral model request and the typed event stream providers emit.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::message::Message;
use crate::tools::ToolDefinition;

/// How the model should treat available tools for a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolChoice {
    /// The model may call zero or more tools.
    Auto,
    /// Tools are advertised but the model must answer with text only.
    ///
    /// Used by the last-step wrap-up (`ARCH/08-LOOP.md`).
    None,
}

/// A normalized request for one provider turn.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelRequest {
    /// The resolved model id.
    pub model: String,
    /// Static system instructions, joined in order before history.
    pub system: Vec<String>,
    /// Conversation history, oldest first.
    pub messages: Vec<Message>,
    /// Tools advertised to the model (empty disables tool use).
    pub tools: Vec<ToolDefinition>,
    /// Tool-selection mode.
    pub tool_choice: ToolChoice,
    /// Optional sampling temperature.
    pub temperature: Option<f32>,
    /// Optional output-token ceiling.
    pub max_output_tokens: Option<u32>,
}

impl ModelRequest {
    /// Builds a request with defaults for optional knobs.
    #[must_use]
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            system: Vec::new(),
            messages: Vec::new(),
            tools: Vec::new(),
            tool_choice: ToolChoice::Auto,
            temperature: None,
            max_output_tokens: None,
        }
    }

    /// Sets the system instructions.
    #[must_use]
    pub fn with_system(mut self, system: Vec<String>) -> Self {
        self.system = system;
        self
    }

    /// Sets the conversation history.
    #[must_use]
    pub fn with_messages(mut self, messages: Vec<Message>) -> Self {
        self.messages = messages;
        self
    }
}

/// Token accounting for one provider turn (`REQ-ANALYTICS-001`).
///
/// All fields are provider-reported observations; unknown values are zero
/// rather than fabricated estimates.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    /// Non-cached input tokens.
    pub input_tokens: u64,
    /// Output (completion) tokens.
    pub output_tokens: u64,
    /// Tokens served from the prompt cache.
    pub cached_read_tokens: u64,
    /// Tokens written to the prompt cache.
    pub cached_write_tokens: u64,
    /// Reasoning/thought tokens, when the provider reports them separately.
    pub reasoning_tokens: u64,
}

impl Usage {
    /// Folds another usage record into this one.
    pub fn add_assign(&mut self, other: Usage) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cached_read_tokens = self
            .cached_read_tokens
            .saturating_add(other.cached_read_tokens);
        self.cached_write_tokens = self
            .cached_write_tokens
            .saturating_add(other.cached_write_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
    }

    /// Returns the inclusive token total.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cached_read_tokens)
            .saturating_add(self.cached_write_tokens)
    }
}

/// Why an assistant turn finished.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    /// The model produced a final answer.
    Stop,
    /// The model emitted tool calls.
    ToolCalls,
    /// The output-token ceiling was reached.
    Length,
    /// The provider's content policy stopped generation.
    ContentFilter,
    /// A provider-specific reason we do not model.
    Other(String),
}

/// A typed event in the provider's streaming response.
///
/// Token deltas are ephemeral and are not persisted individually
/// (`REQ-LOOP-006`); the loop folds them into a settled assistant message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum ModelEvent {
    /// The provider accepted the request and began streaming.
    Started,
    /// A text delta of the assistant message.
    TextDelta {
        /// The incremental text.
        text: String,
    },
    /// A reasoning/thought delta kept out of the model-visible message.
    ReasoningDelta {
        /// The incremental reasoning text.
        text: String,
    },
    /// An incremental fragment of a tool call.
    ToolCallDelta {
        /// Zero-based index of the call within this turn.
        index: u32,
        /// The call id, present on the first fragment for the index.
        id: Option<String>,
        /// The tool name, present on the first fragment for the index.
        name: Option<String>,
        /// Appended JSON-argument text.
        arguments_delta: String,
    },
    /// Provider-reported usage for the turn.
    Usage(Usage),
    /// The provider finished the turn.
    Finished {
        /// Why generation stopped.
        reason: FinishReason,
    },
}

/// Construction and classification of provider failures.
pub use crate::error::{ProviderError, ProviderErrorKind};

/// A retry decision derived from a provider error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryAdvice {
    /// Retry after the supplied delay.
    RetryAfter(Duration),
    /// Do not retry.
    Terminal,
}

impl ProviderError {
    /// Returns retry guidance for this error.
    ///
    /// `Retry-After` (when the provider supplied it) takes precedence over the
    /// caller's computed backoff.
    #[must_use]
    pub fn retry_advice(&self) -> RetryAdvice {
        if !self.retryable {
            return RetryAdvice::Terminal;
        }
        match self.retry_after {
            Some(delay) => RetryAdvice::RetryAfter(delay),
            None => RetryAdvice::RetryAfter(Duration::ZERO),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_folds_and_totals() {
        let mut usage = Usage {
            input_tokens: 10,
            output_tokens: 3,
            ..Usage::default()
        };
        usage.add_assign(Usage {
            input_tokens: 5,
            cached_read_tokens: 2,
            ..Usage::default()
        });
        assert_eq!(usage.input_tokens, 15);
        assert_eq!(usage.total(), 20);
    }

    #[test]
    fn retry_advice_prefers_retry_after() {
        let err = ProviderError::rate_limit("slow down").with_retry_after(Duration::from_secs(7));
        assert_eq!(
            err.retry_advice(),
            RetryAdvice::RetryAfter(Duration::from_secs(7))
        );
        let terminal = ProviderError::auth("bad key");
        assert_eq!(terminal.retry_advice(), RetryAdvice::Terminal);
    }
}
