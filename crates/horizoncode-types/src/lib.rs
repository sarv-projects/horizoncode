//! Shared vocabulary for HorizonCode.
//!
//! `horizoncode-types` owns the small set of values that cross crate boundaries:
//! opaque identifiers, model-visible content and messages, tool-schema
//! definitions, the provider event/error contract, and the append-only session
//! event row. It owns no behaviour beyond constructors, validation and
//! (de)serialization, so every other crate can depend on it without taking a
//! dependency on a subsystem.

#![forbid(unsafe_code)]

pub mod cancel;
pub mod clock;
pub mod content;
pub mod error;
pub mod event;
pub mod ids;
pub mod message;
pub mod model;
pub mod tools;

pub use cancel::CancelToken;
pub use clock::{Clock, SystemClock, system_clock};
pub use content::ContentPart;
pub use error::{ProviderError, ProviderErrorKind};
pub use event::{Event, EventKind, SurfaceOp};
pub use ids::{Id, SessionId, StepId, ToolCallId, TurnId};
pub use message::{Message, Role};
pub use model::{FinishReason, ModelEvent, ModelRequest, ToolChoice, Usage};
pub use tools::{
    MAX_TOOL_NAME_LEN, ToolAction, ToolCall, ToolDefinition, ToolStatus, is_valid_tool_name,
};
