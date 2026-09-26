//! Streaming observation of a running turn.
//!
//! Surfaces (headless, ACP, TUI) implement [`RunObserver`] to translate loop
//! progress into their own event vocabulary. The observer is synchronous and
//! must not block; it is called from the loop's task.

use std::sync::{Arc, Mutex};

use agentx_session::TurnEndStatus;
use agentx_tools::Settlement;
use agentx_types::{ToolCall, TurnId, Usage};

/// A progress event emitted during a turn.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum RunEvent {
    /// A turn was admitted and started.
    TurnStarted {
        /// The turn identity.
        turn_id: TurnId,
    },
    /// A text delta from the model.
    TextDelta {
        /// The incremental text.
        text: String,
    },
    /// A settled assistant message.
    AssistantMessage {
        /// The one-based step number.
        step: u64,
        /// The assistant text.
        text: String,
        /// Tool calls proposed by the message.
        tool_calls: Vec<ToolCall>,
    },
    /// A tool call is about to execute.
    ToolStarted {
        /// The proposed call.
        tool_call: ToolCall,
        /// The policy action.
        action: String,
    },
    /// A tool call settled.
    ToolFinished {
        /// The settlement.
        settlement: Settlement,
    },
    /// A step settled with usage.
    StepFinished {
        /// The one-based step number.
        step: u64,
        /// Usage for the step.
        usage: Usage,
    },
    /// The turn reached its terminal state.
    TurnFinished {
        /// The terminal status.
        status: TurnEndStatus,
        /// A human-readable reason.
        reason: String,
        /// The final assistant text, when produced.
        final_text: Option<String>,
    },
}

/// A sink for [`RunEvent`] values.
pub trait RunObserver: Send {
    /// Records one event.
    fn on_event(&mut self, event: RunEvent);
}

/// An observer that discards everything.
#[derive(Debug, Default)]
pub struct NullObserver;

impl RunObserver for NullObserver {
    fn on_event(&mut self, _event: RunEvent) {}
}

/// An observer that records events in memory, for tests and JSON streaming.
#[derive(Clone, Debug, Default)]
pub struct RecordingObserver {
    events: Arc<Mutex<Vec<RunEvent>>>,
}

impl RecordingObserver {
    /// Builds an empty recording observer.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns a snapshot of the recorded events.
    #[must_use]
    pub fn events(&self) -> Vec<RunEvent> {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Returns all recorded text-delta text concatenated.
    #[must_use]
    pub fn streamed_text(&self) -> String {
        let mut out = String::new();
        for event in self.events() {
            if let RunEvent::TextDelta { text } = event {
                out.push_str(&text);
            }
        }
        out
    }
}

impl RunObserver for RecordingObserver {
    fn on_event(&mut self, event: RunEvent) {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(event);
    }
}
