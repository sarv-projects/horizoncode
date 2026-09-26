//! Provider-agnostic conversation messages.

use serde::{Deserialize, Serialize};

use crate::content::ContentPart;
use crate::ids::ToolCallId;
use crate::tools::ToolCall;

/// Who produced a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Operator/system instructions.
    System,
    /// The end user (or a steered/queued input).
    User,
    /// The model.
    Assistant,
    /// A tool's returned observation.
    Tool,
}

impl Role {
    /// Returns the lowercase role name used by wire protocols.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

/// One conversation message, normalized across providers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    /// The author of the message.
    pub role: Role,
    /// Ordered content parts.
    pub content: Vec<ContentPart>,
    /// Tool calls proposed by an assistant message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// The tool call this message answers, for [`Role::Tool`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
}

impl Message {
    /// Builds a message with the given role and content parts.
    #[must_use]
    pub fn new(role: Role, content: Vec<ContentPart>) -> Self {
        Self {
            role,
            content,
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    /// Builds a system message.
    #[must_use]
    pub fn system(text: impl Into<String>) -> Self {
        Self::new(Role::System, vec![ContentPart::text(text)])
    }

    /// Builds a user message.
    #[must_use]
    pub fn user(text: impl Into<String>) -> Self {
        Self::new(Role::User, vec![ContentPart::text(text)])
    }

    /// Builds an assistant message carrying only text.
    #[must_use]
    pub fn assistant(text: impl Into<String>) -> Self {
        Self::new(Role::Assistant, vec![ContentPart::text(text)])
    }

    /// Builds an assistant message carrying tool calls (and optional preamble text).
    #[must_use]
    pub fn assistant_tool_calls(text: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        let mut message = Self::new(Role::Assistant, Vec::new());
        let text = text.into();
        if !text.is_empty() {
            message.content.push(ContentPart::text(text));
        }
        message.tool_calls = tool_calls;
        message
    }

    /// Builds a tool-observation message answering `tool_call_id`.
    #[must_use]
    pub fn tool_result(tool_call_id: ToolCallId, text: impl Into<String>) -> Self {
        let mut message = Self::new(Role::Tool, vec![ContentPart::text(text)]);
        message.tool_call_id = Some(tool_call_id);
        message
    }

    /// Concatenates all text parts of this message.
    #[must_use]
    pub fn text(&self) -> String {
        let mut out = String::new();
        for part in &self.content {
            if let Some(text) = part.as_text() {
                out.push_str(text);
            }
        }
        out
    }

    /// Returns `true` when this message contains no content and no tool calls.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.content.is_empty() && self.tool_calls.is_empty()
    }
}
