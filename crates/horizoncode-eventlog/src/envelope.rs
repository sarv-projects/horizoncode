//! The canonical event envelope and its digest binding (`ARCH/07` §`SessionEvent`).
//!
//! An event's stored form is an [`EventRecord`]: the producer's data plus the
//! assigned sequence, the predecessor digest, and the event digest. The digest
//! is `blake3(DOMAIN || canonical_body)` where the body is a fixed field order
//! with recursively sorted object keys, so the same logical event hashes the
//! same on every machine and a verifier recomputes it from the stored bytes
//! alone.
//!
//! The digest detects corruption, reordering, and truncation. It does not
//! authenticate the writer: that is the audit chain's separate responsibility
//! (`ARCH/14`).
//!
//! The hash is `blake3` because `ARCH/03` §5 names it as the hashing dependency;
//! the `sha256` wording in an earlier `ARCH/07` draft is superseded (`DEC-059`).
//! Changing the algorithm or the canonical form is a schema-version change.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The digest domain separator, versioned with the envelope schema.
pub const DIGEST_DOMAIN: &str = "horizoncode/eventlog/event/v1";

/// The label hashed into the genesis `previous_digest`.
pub const GENESIS_LABEL: &str = "horizoncode/eventlog/event/genesis/v1";

/// The longest accepted event kind name.
pub const MAX_KIND_BYTES: usize = 128;

/// Why an event could not be built or verified.
#[derive(Debug, thiserror::Error)]
pub enum EventEnvelopeError {
    /// The event could not be encoded.
    #[error("the event cannot be encoded: {0}")]
    Encode(String),
    /// The event kind is empty or too long.
    #[error("the event kind must be 1..={MAX_KIND_BYTES} bytes")]
    Kind,
    /// The event data is not a JSON object.
    #[error("the event data must be a JSON object")]
    Data,
    /// The stored digest does not match the stored body.
    #[error("the stored event digest does not match its body at sequence {seq}")]
    DigestMismatch {
        /// The sequence whose digest failed.
        seq: u64,
    },
    /// The stored sequence is not the expected one.
    #[error("expected sequence {expected}, found {found}")]
    Sequence {
        /// The next expected sequence.
        expected: u64,
        /// The stored sequence.
        found: u64,
    },
    /// The stored predecessor digest is not the expected one.
    #[error("the event at sequence {seq} does not link to its predecessor")]
    Link {
        /// The sequence whose link failed.
        seq: u64,
    },
}

/// What a producer supplies for one event; the log assigns sequence and linkage.
#[derive(Clone, Debug, PartialEq)]
pub struct RecordSpec {
    /// UTC epoch milliseconds.
    pub time_ms: i64,
    /// The dotted event kind (`turn.started`, `tool.settled`, ...).
    pub kind: String,
    /// Bounded JSON object payload; large payloads are references, not bytes.
    pub data: Value,
}

impl RecordSpec {
    /// Builds a spec with no validation beyond what [`EventRecord::new`] does.
    #[must_use]
    pub fn new(time_ms: i64, kind: impl Into<String>, data: Value) -> Self {
        Self {
            time_ms,
            kind: kind.into(),
            data,
        }
    }
}

/// One stored event row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventRecord {
    /// Monotonic per stream, dense from 0.
    pub seq: u64,
    /// UTC epoch milliseconds.
    pub time_ms: i64,
    /// The dotted event kind.
    pub kind: String,
    /// The bounded JSON payload.
    pub data: Value,
    /// The predecessor's `event_digest`, or the genesis digest at sequence 0.
    pub previous_digest: String,
    /// `blake3` over the canonical body; excludes this field.
    pub event_digest: String,
}

impl EventRecord {
    /// Builds a record at `seq` linked to `previous_digest`.
    ///
    /// # Errors
    /// Returns [`EventEnvelopeError`] when the kind or data are invalid or the
    /// body cannot be encoded.
    pub fn new(
        spec: RecordSpec,
        seq: u64,
        previous_digest: &str,
    ) -> Result<Self, EventEnvelopeError> {
        validate(spec.kind.as_str(), &spec.data)?;
        let mut record = Self {
            seq,
            time_ms: spec.time_ms,
            kind: spec.kind,
            data: spec.data,
            previous_digest: previous_digest.to_owned(),
            event_digest: String::new(),
        };
        record.event_digest = record.compute_digest()?;
        Ok(record)
    }

    /// Recomputes the digest from the stored fields.
    ///
    /// # Errors
    /// Returns [`EventEnvelopeError`] when the body cannot be encoded.
    pub fn compute_digest(&self) -> Result<String, EventEnvelopeError> {
        let body = self.canonical_body()?;
        let mut hasher = blake3::Hasher::new();
        hasher.update(DIGEST_DOMAIN.as_bytes());
        hasher.update(b"\n");
        hasher.update(body.as_bytes());
        Ok(hasher.finalize().to_hex().to_string())
    }

    /// The canonical encoded body, with object keys sorted recursively and the
    /// digest field excluded.
    ///
    /// # Errors
    /// Returns [`EventEnvelopeError::Encode`] when encoding fails.
    pub fn canonical_body(&self) -> Result<String, EventEnvelopeError> {
        #[derive(Serialize)]
        struct Body<'a> {
            seq: u64,
            time_ms: i64,
            kind: &'a str,
            data: &'a Value,
            previous_digest: &'a str,
        }
        let data = canonicalize(self.data.clone());
        serde_json::to_string(&Body {
            seq: self.seq,
            time_ms: self.time_ms,
            kind: &self.kind,
            data: &data,
            previous_digest: &self.previous_digest,
        })
        .map_err(|error| EventEnvelopeError::Encode(error.to_string()))
    }

    /// Verifies that this record is the one expected at `expected_seq` after
    /// `expected_previous`.
    ///
    /// # Errors
    /// Returns [`EventEnvelopeError::Sequence`], [`EventEnvelopeError::Link`],
    /// or [`EventEnvelopeError::DigestMismatch`].
    pub fn verify(
        &self,
        expected_seq: u64,
        expected_previous: &str,
    ) -> Result<(), EventEnvelopeError> {
        if self.seq != expected_seq {
            return Err(EventEnvelopeError::Sequence {
                expected: expected_seq,
                found: self.seq,
            });
        }
        if self.previous_digest != expected_previous {
            return Err(EventEnvelopeError::Link { seq: self.seq });
        }
        if self.compute_digest()? != self.event_digest {
            return Err(EventEnvelopeError::DigestMismatch { seq: self.seq });
        }
        Ok(())
    }

    /// Encodes the record as one JSON line (no trailing newline).
    ///
    /// # Errors
    /// Returns [`EventEnvelopeError::Encode`] when encoding fails.
    pub fn to_line(&self) -> Result<String, EventEnvelopeError> {
        serde_json::to_string(self).map_err(|error| EventEnvelopeError::Encode(error.to_string()))
    }

    /// Decodes one stored JSON line.
    ///
    /// # Errors
    /// Returns [`EventEnvelopeError::Encode`] when the line is not a record.
    pub fn from_line(line: &str) -> Result<Self, EventEnvelopeError> {
        serde_json::from_str(line).map_err(|error| EventEnvelopeError::Encode(error.to_string()))
    }
}

/// The genesis `previous_digest` for sequence 0.
#[must_use]
pub fn genesis_digest() -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(GENESIS_LABEL.as_bytes());
    hasher.finalize().to_hex().to_string()
}

fn validate(kind: &str, data: &Value) -> Result<(), EventEnvelopeError> {
    if kind.is_empty() || kind.len() > MAX_KIND_BYTES {
        return Err(EventEnvelopeError::Kind);
    }
    if !data.is_object() {
        return Err(EventEnvelopeError::Data);
    }
    Ok(())
}

/// Sorts object keys recursively so canonical bytes do not depend on insertion
/// order or on a feature-unified map implementation.
fn canonicalize(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonicalize).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec() -> RecordSpec {
        RecordSpec::new(1_700_000_000_000, "tool.settled", json!({"b": 2, "a": 1}))
    }

    #[test]
    fn the_digest_does_not_depend_on_object_insertion_order() {
        let first = EventRecord::new(
            RecordSpec::new(1, "tool.settled", json!({"a": 1, "b": {"y": 2, "x": 3}})),
            0,
            &genesis_digest(),
        )
        .unwrap();
        // The same logical data, parsed with a different textual key order.
        let data: Value = serde_json::from_str(r#"{"b":{"x":3,"y":2},"a":1}"#).unwrap();
        let second = EventRecord::new(
            RecordSpec::new(1, "tool.settled", data),
            0,
            &genesis_digest(),
        )
        .unwrap();
        assert_eq!(first.event_digest, second.event_digest);
        assert_eq!(
            first.canonical_body().unwrap(),
            second.canonical_body().unwrap()
        );
    }

    #[test]
    fn every_field_is_covered_by_the_digest() {
        let base = EventRecord::new(spec(), 0, &genesis_digest()).unwrap();
        let mut changed = base.clone();
        changed.data = json!({"b": 2, "a": 9});
        assert_ne!(
            base.compute_digest().unwrap(),
            changed.compute_digest().unwrap()
        );

        let mut changed = base.clone();
        changed.seq = 1;
        assert_ne!(
            base.compute_digest().unwrap(),
            changed.compute_digest().unwrap()
        );

        let mut changed = base.clone();
        changed.time_ms += 1;
        assert_ne!(
            base.compute_digest().unwrap(),
            changed.compute_digest().unwrap()
        );

        let mut changed = base.clone();
        changed.kind = "tool.started".to_owned();
        assert_ne!(
            base.compute_digest().unwrap(),
            changed.compute_digest().unwrap()
        );

        let mut changed = base.clone();
        changed.previous_digest = genesis_digest().repeat(2);
        assert_ne!(
            base.compute_digest().unwrap(),
            changed.compute_digest().unwrap()
        );
    }

    #[test]
    fn verify_checks_sequence_link_and_digest() {
        let record = EventRecord::new(spec(), 7, &genesis_digest()).unwrap();
        assert!(record.verify(7, &genesis_digest()).is_ok());

        assert!(matches!(
            record.verify(8, &genesis_digest()),
            Err(EventEnvelopeError::Sequence { .. })
        ));
        assert!(matches!(
            record.verify(7, "deadbeef"),
            Err(EventEnvelopeError::Link { .. })
        ));

        let mut tampered = record.clone();
        tampered.data = json!({"b": 2, "a": 2});
        assert!(matches!(
            tampered.verify(7, &genesis_digest()),
            Err(EventEnvelopeError::DigestMismatch { seq: 7 })
        ));
    }

    #[test]
    fn invalid_kinds_and_non_object_data_are_refused() {
        assert!(matches!(
            EventRecord::new(RecordSpec::new(1, "", json!({})), 0, "x"),
            Err(EventEnvelopeError::Kind)
        ));
        assert!(matches!(
            EventRecord::new(
                RecordSpec::new(1, "a".repeat(MAX_KIND_BYTES + 1), json!({})),
                0,
                "x"
            ),
            Err(EventEnvelopeError::Kind)
        ));
        assert!(matches!(
            EventRecord::new(RecordSpec::new(1, "tool.settled", json!([1, 2])), 0, "x"),
            Err(EventEnvelopeError::Data)
        ));
    }

    #[test]
    fn the_line_round_trips() {
        let record = EventRecord::new(spec(), 3, &genesis_digest()).unwrap();
        let line = record.to_line().unwrap();
        assert!(!line.contains('\n'));
        assert_eq!(EventRecord::from_line(&line).unwrap(), record);
    }

    #[test]
    fn the_genesis_digest_is_stable_and_distinct() {
        assert_eq!(genesis_digest(), genesis_digest());
        assert_ne!(genesis_digest(), DIGEST_DOMAIN);
        assert_eq!(genesis_digest().len(), 64);
    }
}
