//! Bounded immutable segments and their seals (`ARCH/07` §Append, rotation, and
//! replay contract).
//!
//! A segment is a plain JSONL file of [`crate::EventRecord`] rows; it receives
//! appends until a ceiling from `DEC-058` would be crossed, then it is sealed.
//! A seal is an immutable record of what the segment contained: its sequence
//! range, count, encoded bytes, first/last event digests, the predecessor
//! segment's digest, and a digest over the seal body. Sealing changes physical
//! layout only; it never renumbers, rewrites, or deletes history.

use serde::{Deserialize, Serialize};

use crate::CURRENT_SCHEMA_VERSION;

/// The seal digest domain separator, versioned with the schema.
pub const SEAL_DOMAIN: &str = "horizoncode/eventlog/seal/v1";

/// The rolling segment-content domain separator, versioned with the schema.
pub const CONTENT_DOMAIN: &str = "horizoncode/eventlog/segment-content/v1";

/// The label hashed into the genesis predecessor segment digest.
pub const GENESIS_SEGMENT_LABEL: &str = "horizoncode/eventlog/segment/genesis/v1";

/// One finalized segment's seal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SegmentSeal {
    /// The schema version the segment was written under.
    pub schema_version: u32,
    /// The segment index, dense from 0.
    pub segment: u32,
    /// The first committed sequence in the segment.
    pub first_seq: u64,
    /// The last committed sequence in the segment.
    pub last_seq: u64,
    /// The number of committed events.
    pub event_count: u64,
    /// The committed encoded bytes, including line terminators.
    pub encoded_bytes: u64,
    /// The first event's digest.
    pub first_event_digest: String,
    /// The last event's digest.
    pub last_event_digest: String,
    /// The predecessor seal's `segment_digest`, or the genesis digest.
    pub previous_segment_digest: String,
    /// `blake3` over the canonical seal body; excludes this field.
    pub segment_digest: String,
}

/// What a segment contributed to its seal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentSummary {
    /// The first committed sequence.
    pub first_seq: u64,
    /// The last committed sequence.
    pub last_seq: u64,
    /// The committed event count.
    pub event_count: u64,
    /// The committed encoded bytes.
    pub encoded_bytes: u64,
    /// The first event's digest.
    pub first_event_digest: String,
    /// The last event's digest.
    pub last_event_digest: String,
}

impl SegmentSeal {
    /// Builds a seal with the digest computed over the canonical body.
    #[must_use]
    pub fn from_summary(
        segment: u32,
        summary: SegmentSummary,
        previous_segment_digest: String,
    ) -> Self {
        let mut seal = Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            segment,
            first_seq: summary.first_seq,
            last_seq: summary.last_seq,
            event_count: summary.event_count,
            encoded_bytes: summary.encoded_bytes,
            first_event_digest: summary.first_event_digest,
            last_event_digest: summary.last_event_digest,
            previous_segment_digest,
            segment_digest: String::new(),
        };
        seal.segment_digest = seal.compute_digest();
        seal
    }

    /// Recomputes the seal digest from the stored fields.
    #[must_use]
    pub fn compute_digest(&self) -> String {
        #[derive(Serialize)]
        struct Body<'a> {
            schema_version: u32,
            segment: u32,
            first_seq: u64,
            last_seq: u64,
            event_count: u64,
            encoded_bytes: u64,
            first_event_digest: &'a str,
            last_event_digest: &'a str,
            previous_segment_digest: &'a str,
        }
        let body = serde_json::to_string(&Body {
            schema_version: self.schema_version,
            segment: self.segment,
            first_seq: self.first_seq,
            last_seq: self.last_seq,
            event_count: self.event_count,
            encoded_bytes: self.encoded_bytes,
            first_event_digest: &self.first_event_digest,
            last_event_digest: &self.last_event_digest,
            previous_segment_digest: &self.previous_segment_digest,
        })
        .expect("a seal body is encodable");
        let mut hasher = blake3::Hasher::new();
        hasher.update(SEAL_DOMAIN.as_bytes());
        hasher.update(b"\n");
        hasher.update(body.as_bytes());
        hasher.finalize().to_hex().to_string()
    }

    /// Whether the stored digest matches the stored body.
    #[must_use]
    pub fn verifies(&self) -> bool {
        self.segment_digest == self.compute_digest()
    }
}

/// The rolling digest over a segment's committed line bytes.
///
/// The head stores this value, so a restart can prove that the active segment's
/// committed prefix is unchanged without trusting the seal of a segment that is
/// still open.
#[derive(Clone, Debug)]
pub struct ContentHasher {
    hasher: blake3::Hasher,
}

impl Default for ContentHasher {
    fn default() -> Self {
        Self::new()
    }
}

impl ContentHasher {
    /// Starts a fresh content digest for a new segment.
    #[must_use]
    pub fn new() -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(CONTENT_DOMAIN.as_bytes());
        hasher.update(b"\n");
        Self { hasher }
    }

    /// Folds one committed line (without its terminator) into the digest.
    pub fn update_line(&mut self, line: &str) {
        self.hasher.update(line.as_bytes());
        self.hasher.update(b"\n");
    }

    /// Returns the digest of everything folded so far.
    #[must_use]
    pub fn digest(&self) -> String {
        self.hasher.finalize().to_hex().to_string()
    }
}

/// The genesis predecessor segment digest for segment 0.
#[must_use]
pub fn genesis_segment_digest() -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(GENESIS_SEGMENT_LABEL.as_bytes());
    hasher.finalize().to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seal_verifies_and_its_digest_covers_every_field() {
        let seal = SegmentSeal::from_summary(
            0,
            SegmentSummary {
                first_seq: 0,
                last_seq: 3,
                event_count: 4,
                encoded_bytes: 120,
                first_event_digest: "a".repeat(64),
                last_event_digest: "b".repeat(64),
            },
            genesis_segment_digest(),
        );
        assert!(seal.verifies());
        let mut changed = seal.clone();
        changed.last_seq = 4;
        assert!(!changed.verifies());
        let mut changed = seal.clone();
        changed.previous_segment_digest = "c".repeat(64);
        assert!(!changed.verifies());
    }

    #[test]
    fn the_content_digest_changes_with_the_lines_and_is_stable_for_a_fresh_segment() {
        let empty = ContentHasher::new().digest();
        assert_eq!(empty, ContentHasher::new().digest());
        let mut hasher = ContentHasher::new();
        hasher.update_line("{\"seq\":0}");
        assert_ne!(hasher.digest(), empty);
        let once = hasher.digest();
        hasher.update_line("{\"seq\":1}");
        assert_ne!(hasher.digest(), once);
    }
}
