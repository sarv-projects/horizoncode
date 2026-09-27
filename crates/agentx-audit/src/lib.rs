//! The tamper-evident, append-only execution record (`CMP-audit`,
//! `ARCH/14-AUDIT.md`).
//!
//! ## What this crate is
//!
//! An append-only JSONL log whose entries are chained by `blake3` over their
//! canonical bytes, whose finalized segments carry **signed** Merkle roots, and
//! whose roots are **anchored** at a declared level. It is the evidence store —
//! not the replayable session log, which `CMP-session` owns.
//!
//! ## The scheme as built
//!
//! - **Canonical bytes.** An entry serializes in a fixed field order with
//!   sorted metadata keys and no floats, so hashing is deterministic.
//! - **Chain.** `entry_hash = blake3(canonical_body || prev_hash)`, where the
//!   body excludes `entry_hash` itself. `seq` 0 references the genesis marker
//!   `blake3("agentx/audit/genesis/v1")`; the chain crosses segment boundaries,
//!   so the first entry of a segment references the last entry hash of the
//!   previous one.
//! - **Segment roots.** At rollover (or `finish_turn`) the segment is
//!   finalized: `merkle_root` over its ordered entry hashes, signed with the
//!   device key, and appended to `roots.jsonl` chain-linked by `prev_root`.
//! - **Signing.** Unconditional. A `sign: false` configuration is an error,
//!   not a posture. The primitive is a `blake3` keyed hash (a MAC), labelled as
//!   such everywhere the level is rendered.
//! - **Anchoring.** `local-sink` by default: signed roots are appended to a
//!   distinct, ownership- and mode-validated sink **outside** the audit store
//!   root. `local-trust` (no sink) survives only as an explicit, acknowledged,
//!   labelled posture. `off-box` is required when a deployment declares an
//!   off-box trust requirement and is refused as `Unsupported` by this build
//!   rather than downgraded. A configured-but-unreachable sink **fails
//!   closed**.
//! - **Redaction before hashing.** The pass runs on the record before the hash
//!   is computed, so a secret can never enter the chain; the redaction itself
//!   is noted, never the value.
//!
//! ## What `verify` proves, and what it does not
//!
//! See [`verify::claim_boundary`]. Given a trusted anchor, it proves that
//! already-anchored history was not modified by a principal that does not hold
//! the anchoring credential. It does **not** prove content authenticity, does
//! **not** detect fabrication by a principal with local write access (and, at
//! `local-sink`, sink-write access), and does **not** cover the unanchored
//! tail, which is reported rather than passed or failed (`REQ-AUDIT-007`).

#![forbid(unsafe_code)]

mod anchor;
mod census;
mod entry;
mod error;
mod key;
mod merkle;
mod meta;
mod redact;
mod replay;
mod store;
mod verify;

pub use anchor::{
    AnchorCadence, AnchorConfig, AnchorSink, DEFAULT_SINK_DIR, FinalizeOptions, GENESIS_PREV_ROOT,
    GENESIS_ROOT_LABEL, HashAlgorithm, OffBox, RootRecord, SINK_FILE, TrustRequirement,
    default_sink_path,
};
pub use census::{
    CensusError, CensusReport, CensusWindow, ClassCensus, census, census_strict, write_artifact,
};
pub use entry::{
    Actor, AnchorLevelName, AuditEntry, AuditRecord, EffectClass, EntryKind, GENESIS_LABEL,
    GENESIS_PREV_HASH, HASH_HEX_LEN, Outcome, PolicyEffect,
};
pub use error::AuditError;
pub use key::{DeviceKey, SIGNATURE_ALGORITHM, SignedDigest, device_key_path};
pub use merkle::{digest, keyed_digest, merkle_root};
pub use meta::{Meta, MetaValue};
pub use redact::{REDACTED, Redactor};
pub use replay::{ReplayError, ReplayItem, ReplayReport, ReplayWindow, replay};
pub use store::{
    AuditConfig, AuditLog, HeadSnapshot, RedactionConfig, SegmentContents, default_audit_root,
    indices_with_gaps, now_ms, read_roots, read_segment, read_segment_lines, read_segments,
    segment_indices,
};
pub use verify::{
    ClaimBoundary, Divergence, DivergenceReason, SegmentSummary, UnanchoredTail, VerifyError,
    VerifyReport, claim_boundary, verify,
};

/// Returns the version of the audit store format this build reads and writes.
#[must_use]
pub fn format_version() -> u32 {
    1
}

/// Returns a digest of canonical bytes, for producers that need an
/// `inputs_digest` before submitting a record (`REQ-AUDIT-001`).
#[must_use]
pub fn inputs_digest(value: &serde_json::Value) -> String {
    digest(value.to_string().as_bytes())
}
