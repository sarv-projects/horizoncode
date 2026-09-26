//! The in-memory session projection built by replaying the log.

use agentx_types::{Event, EventKind, Message, SessionId, ToolCall, ToolCallId, TurnId, Usage};

use crate::payload::{
    AssistantMessagePayload, InputPromotedPayload, ModelRef, SessionCreatedPayload, StepEndPayload,
    ToolResultPayload, TurnEndPayload, TurnEndStatus,
};

/// Lifecycle status of a session record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// The session can admit work.
    Active,
    /// The session is parked and can be resumed.
    Hibernated,
    /// The session is retained but not listed by default.
    Archived,
    /// The session refuses further admission but remains replayable.
    Closed,
}

impl SessionStatus {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Hibernated => "hibernated",
            Self::Archived => "archived",
            Self::Closed => "closed",
        }
    }
}

/// A row of the `list` projection.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionSummary {
    /// The session id.
    pub id: SessionId,
    /// A non-authoritative title.
    pub title: String,
    /// The workspace identity.
    pub workspace_id: String,
    /// The model in force.
    pub model: ModelRef,
    /// The derived lifecycle status.
    pub status: SessionStatus,
    /// Creation time in epoch milliseconds.
    pub created_at: i64,
    /// Last activity time in epoch milliseconds.
    pub last_active_at: i64,
    /// Number of durable events.
    pub event_count: usize,
}

/// A session replayed from its append-only log.
#[derive(Clone, Debug)]
pub struct LoadedSession {
    /// The session id.
    pub id: SessionId,
    /// The `session/created` payload.
    pub header: SessionCreatedPayload,
    /// The derived lifecycle status.
    pub status: SessionStatus,
    /// Creation time in epoch milliseconds.
    pub created_at: i64,
    /// Last activity time in epoch milliseconds.
    pub last_active_at: i64,
    /// The full event stream, including deterministic repair closers.
    pub events: Vec<Event>,
}

impl LoadedSession {
    /// Builds a projection from a validated event stream.
    ///
    /// # Errors
    /// Returns [`crate::SessionError::Payload`] when the header event is missing
    /// or malformed.
    pub(crate) fn from_events(
        id: SessionId,
        events: Vec<Event>,
    ) -> Result<Self, crate::SessionError> {
        let created = events
            .iter()
            .find(|event| event.kind == EventKind::SessionCreated)
            .ok_or_else(|| {
                crate::SessionError::Payload("session log has no session/created event".to_owned())
            })?;
        let header: SessionCreatedPayload = created.decode().map_err(|error| {
            crate::SessionError::Payload(format!("invalid session/created payload: {error}"))
        })?;
        let created_at = created.time;
        let last_active_at = events.last().map_or(created_at, |event| event.time);
        let status = derive_status(&events);
        Ok(Self {
            id,
            header,
            status,
            created_at,
            last_active_at,
            events,
        })
    }

    /// Folds the log into the model-visible conversation history.
    ///
    /// This is the replay projection consumed by the runner: identical logs
    /// produce identical histories (`REQ-SESS-002`).
    #[must_use]
    pub fn history(&self) -> Vec<Message> {
        let mut history = Vec::new();
        for event in &self.events {
            match event.kind {
                EventKind::InputPromoted => {
                    if let Ok(payload) = event.decode::<InputPromotedPayload>() {
                        history.push(Message::user(payload.text));
                    }
                }
                EventKind::AssistantMessage => {
                    if let Ok(payload) = event.decode::<AssistantMessagePayload>() {
                        let text = concat_text(&payload);
                        if payload.tool_calls.is_empty() {
                            if !text.is_empty() {
                                history.push(Message::assistant(text));
                            }
                        } else {
                            history.push(Message::assistant_tool_calls(text, payload.tool_calls));
                        }
                    }
                }
                EventKind::ToolResult => {
                    if let Ok(payload) = event.decode::<ToolResultPayload>() {
                        let text = payload
                            .model_content
                            .iter()
                            .filter_map(|part| part.as_text())
                            .collect::<Vec<_>>()
                            .join("");
                        history.push(Message::tool_result(payload.tool_call_id, text));
                    }
                }
                _ => {}
            }
        }
        history
    }

    /// Returns the text of the most recent assistant message.
    #[must_use]
    pub fn last_assistant_text(&self) -> Option<String> {
        self.events
            .iter()
            .rev()
            .find(|event| event.kind == EventKind::AssistantMessage)
            .and_then(|event| event.decode::<AssistantMessagePayload>().ok())
            .map(|payload| concat_text(&payload))
    }

    /// Returns the terminal status of the most recent turn, if any.
    #[must_use]
    pub fn last_turn_status(&self) -> Option<TurnEndStatus> {
        self.events
            .iter()
            .rev()
            .find(|event| event.kind == EventKind::TurnEnd)
            .and_then(|event| event.decode::<TurnEndPayload>().ok())
            .map(|payload| payload.status)
    }

    /// Returns the currently open turn, if the log ends inside one.
    #[must_use]
    pub fn open_turn(&self) -> Option<TurnId> {
        let mut open = None;
        for event in &self.events {
            match event.kind {
                EventKind::TurnStart => {
                    open = event
                        .decode::<crate::payload::TurnStartPayload>()
                        .ok()
                        .map(|payload| payload.turn_id);
                }
                EventKind::TurnEnd => open = None,
                _ => {}
            }
        }
        open
    }

    /// Returns `true` when the log ends inside an open step.
    #[must_use]
    pub fn has_open_step(&self) -> bool {
        let mut depth: i64 = 0;
        for event in &self.events {
            match event.kind {
                EventKind::StepStart => depth += 1,
                EventKind::StepEnd => depth -= 1,
                _ => {}
            }
        }
        depth > 0
    }

    /// Returns tool calls recorded without a durable result.
    #[must_use]
    pub fn pending_tool_calls(&self) -> Vec<(TurnId, ToolCall)> {
        use std::collections::HashMap;
        let mut calls: HashMap<ToolCallId, (TurnId, ToolCall)> = HashMap::new();
        for event in &self.events {
            match event.kind {
                EventKind::ToolCall => {
                    if let Ok(payload) = event.decode::<crate::payload::ToolCallPayload>() {
                        calls.insert(
                            payload.tool_call.id.clone(),
                            (payload.turn_id, payload.tool_call),
                        );
                    }
                }
                EventKind::ToolResult => {
                    if let Ok(payload) = event.decode::<ToolResultPayload>() {
                        calls.remove(&payload.tool_call_id);
                    }
                }
                _ => {}
            }
        }
        let mut pending: Vec<_> = calls.into_values().collect();
        // Deterministic order independent of hash iteration.
        pending.sort_by(|a, b| a.1.id.as_str().cmp(b.1.id.as_str()));
        pending
    }

    /// Folds per-step usage into session totals (`REQ-HORIZON-003`).
    #[must_use]
    pub fn usage_totals(&self) -> Usage {
        let mut totals = Usage::default();
        for event in &self.events {
            if event.kind == EventKind::StepEnd
                && let Ok(payload) = event.decode::<StepEndPayload>()
            {
                totals.add_assign(Usage {
                    input_tokens: payload.input_tokens,
                    output_tokens: payload.output_tokens,
                    cached_read_tokens: payload.cached_read_tokens,
                    cached_write_tokens: payload.cached_write_tokens,
                    reasoning_tokens: payload.reasoning_tokens,
                });
            }
        }
        totals
    }

    /// Summarizes this session for the `list` projection.
    #[must_use]
    pub fn summary(&self) -> SessionSummary {
        SessionSummary {
            id: self.id.clone(),
            title: self.header.title.clone(),
            workspace_id: self.header.workspace_id.clone(),
            model: self.header.model.clone(),
            status: self.status,
            created_at: self.created_at,
            last_active_at: self.last_active_at,
            event_count: self.events.len(),
        }
    }
}

fn concat_text(payload: &AssistantMessagePayload) -> String {
    payload
        .content
        .iter()
        .filter_map(|part| part.as_text())
        .collect::<Vec<_>>()
        .join("")
}

fn derive_status(events: &[Event]) -> SessionStatus {
    if events
        .iter()
        .any(|event| event.kind == EventKind::SessionClosed)
    {
        SessionStatus::Closed
    } else {
        SessionStatus::Active
    }
}
