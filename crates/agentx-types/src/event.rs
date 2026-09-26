//! The append-only session event row (`ARCH/07-SESSION.md`).
//!
//! The log is the source of truth. Each row carries a dense, monotonic `seq`,
//! an epoch-millisecond timestamp, a dotted `type`, and lossless JSON `data`.
//! Payload structs are owned by the crate that produces the event; this module
//! owns the row envelope and the closed vocabulary of event types.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How a replaying surface folds an event into its projection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceOp {
    /// Append the event to the projection.
    Append,
    /// Replace the projection at this boundary.
    Replace,
}

/// The closed, additively-extensible vocabulary of session event types.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[non_exhaustive]
pub enum EventKind {
    /// Session record created.
    #[serde(rename = "session/created")]
    SessionCreated,
    /// Session metadata updated.
    #[serde(rename = "session/updated")]
    SessionUpdated,
    /// Session closed.
    #[serde(rename = "session/closed")]
    SessionClosed,
    /// Marker recording an inherited cut when a session is forked.
    #[serde(rename = "session/end-seed")]
    SessionEndSeed,
    /// A turn began.
    #[serde(rename = "turn/start")]
    TurnStart,
    /// A turn reached its terminal state.
    #[serde(rename = "turn/end")]
    TurnEnd,
    /// A step (one provider request) began.
    #[serde(rename = "step/start")]
    StepStart,
    /// A step settled.
    #[serde(rename = "step/end")]
    StepEnd,
    /// A provider request was sent.
    #[serde(rename = "model/started")]
    ModelStarted,
    /// A provider turn completed.
    #[serde(rename = "model/done")]
    ModelDone,
    /// A provider attempt failed and may be retried.
    #[serde(rename = "model/attempt")]
    ModelAttempt,
    /// A settled assistant message (text and/or tool calls).
    #[serde(rename = "assistant/message")]
    AssistantMessage,
    /// A tool call was recorded durably before its effects begin.
    #[serde(rename = "tool/call")]
    ToolCall,
    /// A tool call settled (success or typed failure).
    #[serde(rename = "tool/result")]
    ToolResult,
    /// Input was durably admitted.
    #[serde(rename = "input/admitted")]
    InputAdmitted,
    /// Input was promoted at a turn/step boundary.
    #[serde(rename = "input/promoted")]
    InputPromoted,
    /// Input was spliced into an active step.
    #[serde(rename = "input/spliced")]
    InputSpliced,
    /// Context compaction started.
    #[serde(rename = "compaction/started")]
    CompactionStarted,
    /// Context compaction ended.
    #[serde(rename = "compaction/ended")]
    CompactionEnded,
    /// A context epoch snapshot was written.
    #[serde(rename = "context/epoch")]
    ContextEpoch,
    /// A checkpoint was produced.
    #[serde(rename = "checkpoint/created")]
    CheckpointCreated,
    /// A rewind was staged.
    #[serde(rename = "revert/staged")]
    RevertStaged,
    /// A rewind was committed.
    #[serde(rename = "revert/committed")]
    RevertCommitted,
    /// A staged rewind was cleared.
    #[serde(rename = "revert/cleared")]
    RevertCleared,
    /// A child session was catalogued.
    #[serde(rename = "subagent/catalog")]
    SubagentCatalog,
    /// A child session finished.
    #[serde(rename = "subagent/finished")]
    SubagentFinished,
}

impl EventKind {
    /// Returns the dotted wire/type name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionCreated => "session/created",
            Self::SessionUpdated => "session/updated",
            Self::SessionClosed => "session/closed",
            Self::SessionEndSeed => "session/end-seed",
            Self::TurnStart => "turn/start",
            Self::TurnEnd => "turn/end",
            Self::StepStart => "step/start",
            Self::StepEnd => "step/end",
            Self::ModelStarted => "model/started",
            Self::ModelDone => "model/done",
            Self::ModelAttempt => "model/attempt",
            Self::AssistantMessage => "assistant/message",
            Self::ToolCall => "tool/call",
            Self::ToolResult => "tool/result",
            Self::InputAdmitted => "input/admitted",
            Self::InputPromoted => "input/promoted",
            Self::InputSpliced => "input/spliced",
            Self::CompactionStarted => "compaction/started",
            Self::CompactionEnded => "compaction/ended",
            Self::ContextEpoch => "context/epoch",
            Self::CheckpointCreated => "checkpoint/created",
            Self::RevertStaged => "revert/staged",
            Self::RevertCommitted => "revert/committed",
            Self::RevertCleared => "revert/cleared",
            Self::SubagentCatalog => "subagent/catalog",
            Self::SubagentFinished => "subagent/finished",
        }
    }

    /// Parses a dotted type name into an event kind.
    ///
    /// # Errors
    /// Returns `None` for an unknown type so the caller can refuse the session
    /// rather than silently skipping a row (`ARCH/07-SESSION.md`).
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "session/created" => Self::SessionCreated,
            "session/updated" => Self::SessionUpdated,
            "session/closed" => Self::SessionClosed,
            "session/end-seed" => Self::SessionEndSeed,
            "turn/start" => Self::TurnStart,
            "turn/end" => Self::TurnEnd,
            "step/start" => Self::StepStart,
            "step/end" => Self::StepEnd,
            "model/started" => Self::ModelStarted,
            "model/done" => Self::ModelDone,
            "model/attempt" => Self::ModelAttempt,
            "assistant/message" => Self::AssistantMessage,
            "tool/call" => Self::ToolCall,
            "tool/result" => Self::ToolResult,
            "input/admitted" => Self::InputAdmitted,
            "input/promoted" => Self::InputPromoted,
            "input/spliced" => Self::InputSpliced,
            "compaction/started" => Self::CompactionStarted,
            "compaction/ended" => Self::CompactionEnded,
            "context/epoch" => Self::ContextEpoch,
            "checkpoint/created" => Self::CheckpointCreated,
            "revert/staged" => Self::RevertStaged,
            "revert/committed" => Self::RevertCommitted,
            "revert/cleared" => Self::RevertCleared,
            "subagent/catalog" => Self::SubagentCatalog,
            "subagent/finished" => Self::SubagentFinished,
            _ => return None,
        })
    }
}

impl fmt::Display for EventKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One durable row of the append-only session log.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// Dense, monotonic, per-session sequence number starting at 0.
    pub seq: u64,
    /// UTC epoch milliseconds.
    pub time: i64,
    /// The dotted event type.
    #[serde(rename = "type")]
    pub kind: EventKind,
    /// Lossless JSON payload; references are preferred over payload copies.
    #[serde(default)]
    pub data: Value,
    /// How replaying surfaces fold this event.
    #[serde(rename = "surfaceOp", default, skip_serializing_if = "Option::is_none")]
    pub surface_op: Option<SurfaceOp>,
    /// Provenance for synthetic or projected events.
    #[serde(
        rename = "sourceEventSeqs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub source_event_seqs: Option<Vec<u64>>,
}

impl Event {
    /// Builds an event with an empty payload at sequence 0.
    ///
    /// The session store assigns the real `seq` and timestamp on append.
    #[must_use]
    pub fn new(kind: EventKind) -> Self {
        Self {
            seq: 0,
            time: 0,
            kind,
            data: Value::Null,
            surface_op: None,
            source_event_seqs: None,
        }
    }

    /// Builds an event whose `data` is the serialized `payload`.
    ///
    /// # Panics
    /// Panics only if a payload type fails to serialize, which would be a
    /// programming error for a `Serialize` type.
    #[must_use]
    pub fn payload<T: Serialize>(kind: EventKind, payload: &T) -> Self {
        let data = serde_json::to_value(payload)
            .unwrap_or_else(|error| panic!("event payload must serialize: {error}"));
        Self {
            data,
            ..Self::new(kind)
        }
    }

    /// Decodes the event payload as `T`.
    ///
    /// # Errors
    /// Returns the underlying `serde_json` error when the payload does not
    /// match `T`.
    pub fn decode<T: serde::de::DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_value(self.data.clone())
    }

    /// Sets the replay fold semantics.
    #[must_use]
    pub fn with_surface_op(mut self, op: SurfaceOp) -> Self {
        self.surface_op = Some(op);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_round_trips_through_dotted_name() {
        for kind in [
            EventKind::SessionCreated,
            EventKind::TurnStart,
            EventKind::ToolResult,
            EventKind::SubagentFinished,
        ] {
            assert_eq!(EventKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(EventKind::parse("bogus/type"), None);
    }

    #[test]
    fn event_serializes_with_dotted_type_field() {
        let event = Event::payload(EventKind::TurnStart, &serde_json::json!({"turn": "t1"}));
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "turn/start");
        assert_eq!(value["data"]["turn"], "t1");
        // Opted-out optional fields do not leak into the row.
        assert!(value.get("surfaceOp").is_none());
    }

    #[test]
    fn payload_round_trips() {
        #[derive(Serialize, Deserialize, PartialEq, Debug)]
        struct P {
            n: u32,
        }
        let event = Event::payload(EventKind::StepEnd, &P { n: 7 });
        assert_eq!(event.decode::<P>().unwrap(), P { n: 7 });
    }
}
