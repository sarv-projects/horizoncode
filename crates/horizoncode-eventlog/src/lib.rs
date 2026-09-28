//! The shared bounded segmented event log (`DEC-055`, `ARCH/07` §`SessionEvent`,
//! `ARCH/25`).
//!
//! Session history and run history use the **same** framing: one canonical
//! event envelope with a sequence number and a digest chain, immutable bounded
//! segments with a seal, and one committed head that a restart trusts. Building
//! it once is what keeps a second persistence engine from appearing
//! (`DEC-055`).
//!
//! ## Guarantees this crate owns
//!
//! - **Canonical bytes.** An event's digest binds its sequence, time, kind,
//!   canonical data, and predecessor digest, so verification is a pure function
//!   of stored bytes ([`envelope`]).
//! - **Bounded work.** Every record, segment, stream, and replay batch is
//!   bounded by the compiled ceilings published in `DEC-058` and resolved
//!   through `horizoncode-config`; there is no unbounded load path.
//! - **An explicit commit point.** Bytes are durable before the head
//!   acknowledges them; bytes beyond the head are an uncommitted tail that is
//!   preserved and reported, never truncated or folded into replay
//!   ([`log`]).
//! - **Version discipline.** A head that names a newer schema version is
//!   refused before any segment is decoded.
//!
//! ## Not owned here
//!
//! Projections and indexes are rebuildable and live with their consumers;
//! recovery of an uncommitted tail is the explicit recovery operation
//! (`AX-311`); permission and audit authority stay with their components.

#![forbid(unsafe_code)]

/// The schema version this build writes and the newest it can read.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

pub mod durability;
pub mod envelope;
pub mod error;
pub mod head;
pub mod log;
pub mod segment;

pub use durability::{CommitSink, DurabilityProfile, StdCommitSink, UnsupportedSink, std_sink};
pub use envelope::{DIGEST_DOMAIN, EventEnvelopeError, EventRecord, RecordSpec};
pub use error::LogError;
pub use head::{CommittedLogHead, HEAD_FILE, HeadState, read_head, write_head};
pub use log::{Committed, EventLog, LOCK_FILE, ReplayReport, SEGMENTS_DIR};
pub use segment::{ContentHasher, SegmentSeal, SegmentSummary, genesis_segment_digest};
