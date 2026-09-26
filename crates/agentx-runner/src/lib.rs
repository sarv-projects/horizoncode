//! The agent loop (`CMP-runner`, `ARCH/08-LOOP.md`).
//!
//! Implements the canonical cycle
//! `INPUT → ADMISSION → PLAN → MODEL STEP → SCHEDULER → EXECUTE → OBSERVE →
//! UPDATE → CONTINUATION` against the durable session store, the provider
//! trait, and the permission-filtered tool registry. Every turn terminates in
//! exactly one status and every committed phase appends to the log before it
//! settles (`REQ-LOOP-004`, `REQ-LOOP-006`).

#![forbid(unsafe_code)]

mod config;
mod error;
mod observer;
mod runner;

pub use config::RunConfig;
pub use error::LoopError;
pub use observer::{NullObserver, RecordingObserver, RunEvent, RunObserver};
pub use runner::{RunOutcome, Runner};

/// The step-limit wrap-up instruction appended when tools are disabled.
pub const WRAP_UP_INSTRUCTION: &str = "You have reached the maximum number of steps for this turn. Tools are now disabled. \
     Reply with text only, summarizing what is done, what remains, and the next step.";
