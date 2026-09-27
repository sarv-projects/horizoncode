//! Durable, event-sourced sessions (`CMP-session`, `ARCH/07-SESSION.md`).
//!
//! The append-only JSONL log under `$HORIZONCODE_HOME/sessions/<id>.jsonl`
//! (default `~/.horizoncode/sessions/<id>.jsonl`) is the **source of truth**. Every
//! event is appended and flushed before the producing phase is considered
//! settled (`REQ-LOOP-006`); a session is resumed by replaying its log
//! (`REQ-SESS-002`). Derived indexes are rebuildable from the log and are not
//! authoritative (`ARCH/03` §4.4).
//!
//! This slice implements the log, the in-memory index, replay, resume, list,
//! close and deterministic interrupted-turn repair. SQLite derived state,
//! checkpoints and rewind are owned by this component but are deferred; their
//! events are reserved in the vocabulary so the format is forward-compatible.

#![forbid(unsafe_code)]

mod error;
mod payload;
mod session;
mod store;

pub use horizoncode_types::ToolStatus;
pub use error::SessionError;
pub use payload::{
    AssistantMessagePayload, InputPromotedPayload, ModelRef, SessionCreatedPayload,
    SessionUpdatedPayload, StepEndPayload, StepStartPayload, ToolCallPayload, ToolResultPayload,
    TurnEndPayload, TurnEndStatus, TurnStartPayload,
};
pub use session::{LoadedSession, SessionStatus, SessionSummary};
pub use store::{SessionStore, default_sessions_root};

/// The session-format version written by this build.
pub const CURRENT_FORMAT_VERSION: u32 = 1;
