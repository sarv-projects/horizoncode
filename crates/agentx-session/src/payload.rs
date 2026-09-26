//! Typed payloads for the session event vocabulary.
//!
//! The session store owns the log *format*; these structs are the lossless
//! `data` payloads written by the runner and the tool plane. New event types
//! are additive: existing payloads never change shape in place.

use agentx_types::{ContentPart, ToolCall, ToolCallId, ToolStatus, TurnId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A resolved model identity recorded on the session (`REQ-SESS-004`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    /// The model id.
    pub id: String,
    /// The provider/route id.
    pub provider: String,
    /// An optional provider variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

/// Payload of `session/created`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionCreatedPayload {
    /// The session-format version this log was written with.
    #[serde(default = "default_format_version")]
    pub format_version: u32,
    /// The resolved workspace identity.
    pub workspace_id: String,
    /// A human title; non-authoritative.
    pub title: String,
    /// The parent session for a child/sub-agent session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// The model, mode and permission snapshot in force (`REQ-SESS-004`).
    pub model: ModelRef,
    /// The interaction mode.
    pub mode: String,
    /// The guard ruleset snapshot in force.
    pub permission_snapshot: Value,
    /// Up to 255 characters that seeded the session, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
}

/// The format version assumed when a header omits it.
fn default_format_version() -> u32 {
    crate::CURRENT_FORMAT_VERSION
}

impl SessionCreatedPayload {
    /// Builds a header for a new session using the current format version.
    #[must_use]
    pub fn new(
        workspace_id: impl Into<String>,
        title: impl Into<String>,
        model: ModelRef,
        mode: impl Into<String>,
        permission_snapshot: Value,
    ) -> Self {
        Self {
            format_version: crate::CURRENT_FORMAT_VERSION,
            workspace_id: workspace_id.into(),
            title: title.into(),
            parent_id: None,
            model,
            mode: mode.into(),
            permission_snapshot,
            seed: None,
        }
    }
}

/// Payload of `session/updated`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionUpdatedPayload {
    /// A replacement title, when changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// A replacement model, when changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
}

/// Payload of `turn/start`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnStartPayload {
    /// The turn identity.
    pub turn_id: TurnId,
    /// The user-facing prompt that opened the turn.
    pub prompt: String,
}

/// The single terminal status of a turn (`REQ-LOOP-004`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnEndStatus {
    /// The completion contract was satisfied.
    Completed,
    /// The turn failed with a surfaced reason.
    Failed,
    /// The turn was interrupted; partial work is retained.
    Interrupted,
    /// A permission/question decision declined the turn.
    Declined,
    /// The step limit was reached with work unfinished; resumable.
    Partial,
}

impl TurnEndStatus {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Declined => "declined",
            Self::Partial => "partial",
        }
    }
}

/// Payload of `turn/end`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnEndPayload {
    /// The turn identity.
    pub turn_id: TurnId,
    /// The terminal status.
    pub status: TurnEndStatus,
    /// A human-readable reason.
    pub reason: String,
    /// The final assistant text, when one was produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_text: Option<String>,
}

/// Payload of `step/start`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StepStartPayload {
    /// The owning turn.
    pub turn_id: TurnId,
    /// The one-based step number within the turn.
    pub step: u64,
}

/// Payload of `step/end`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StepEndPayload {
    /// The owning turn.
    pub turn_id: TurnId,
    /// The one-based step number within the turn.
    pub step: u64,
    /// Non-cached input tokens.
    #[serde(default)]
    pub input_tokens: u64,
    /// Output tokens.
    #[serde(default)]
    pub output_tokens: u64,
    /// Cache-read tokens.
    #[serde(default)]
    pub cached_read_tokens: u64,
    /// Cache-write tokens.
    #[serde(default)]
    pub cached_write_tokens: u64,
    /// Reasoning tokens.
    #[serde(default)]
    pub reasoning_tokens: u64,
    /// Whether tools were disabled for this step (last-step wrap-up).
    #[serde(default)]
    pub tools_disabled: bool,
}

/// Payload of `assistant/message`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessagePayload {
    /// The owning turn.
    pub turn_id: TurnId,
    /// The model message id, when the provider supplied one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// The assistant text parts.
    #[serde(default)]
    pub content: Vec<ContentPart>,
    /// Tool calls proposed by this message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Whether streaming was interrupted mid-message (`REQ-LOOP-005`).
    #[serde(default)]
    pub interrupted: bool,
}

/// Payload of `tool/call`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCallPayload {
    /// The owning turn.
    pub turn_id: TurnId,
    /// The policy action evaluated for this call.
    pub action: String,
    /// The proposed call.
    pub tool_call: ToolCall,
}

/// Payload of `tool/result`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResultPayload {
    /// The owning turn.
    pub turn_id: TurnId,
    /// The answered call.
    pub tool_call_id: ToolCallId,
    /// The outcome class.
    pub status: ToolStatus,
    /// The model-visible observation content (`REQ-TOOL-004`).
    #[serde(default)]
    pub model_content: Vec<ContentPart>,
    /// A stable error code for synthetic/repair results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// The UI-only detail, kept separate from model content (`REQ-TOOL-004`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_detail: Option<Value>,
}

/// Payload of `input/promoted`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InputPromotedPayload {
    /// A stable input identifier for idempotent admission.
    pub input_id: String,
    /// Delivery class: `user` (a turn) or `steer` (mid-turn redirection).
    pub delivery: String,
    /// The promoted text.
    pub text: String,
}
