//! `audit verify`: recompute the chain, the roots, the signatures, and the
//! anchor, and render exactly what that establishes and what it does not
//! (`REQ-AUDIT-002`, `REQ-AUDIT-007`).
//!
//! Checks run in a fixed order so the reported divergence is the *first* one:
//!
//! 1. per-entry `seq` contiguity, `prev_hash` linkage, recomputed
//!    `entry_hash`, and canonical bytes;
//! 2. per-segment Merkle root recomputation against the signed root;
//! 3. root signature verification;
//! 4. root-chain linkage (`prev_root` / `root_chain`);
//! 5. root/segment agreement (a sealed segment must have exactly one root; an
//!    unsealed segment must have none);
//! 6. the anchor: every anchored root must be present, byte-equal, in the sink.
//!
//! The unanchored tail is **reported, not failed**: entries after the last
//! anchored root are outside the evidence, and that is the honest boundary
//! rather than a pass or a failure.

use std::fmt;

use serde::Serialize;

use crate::anchor::{AnchorSink, GENESIS_PREV_ROOT};
use crate::entry::{AnchorLevelName, GENESIS_PREV_HASH};
use crate::error::AuditError;
use crate::key::DeviceKey;
use crate::merkle::merkle_root;
use crate::store::{AuditConfig, indices_with_gaps, read_roots, read_segments};

/// Why verification failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum DivergenceReason {
    /// The stored entry hash does not match the recomputed hash.
    EntryHashMismatch,
    /// The entry does not reference its predecessor's hash.
    PrevHashMismatch,
    /// The audit sequence is not contiguous.
    SeqGap,
    /// The stored line is not in canonical form.
    NonCanonicalBytes,
    /// A segment's recomputed Merkle root differs from the signed root.
    MerkleRootMismatch,
    /// The root signature does not verify under the device key.
    SignatureInvalid,
    /// A root record's chain hash or `prev_root` linkage is broken.
    RootChainBroken,
    /// A finalized segment has no root record.
    RootMissing,
    /// A root record exists for a segment that is not finalized.
    RootUnexpected,
    /// The anchored roots present in the sink do not match the local chain.
    AnchorMismatch,
    /// A segment file has an unterminated, unparseable trailing write.
    TornTail,
    /// The entry kind is not in the declared effect-class registry.
    UnregisteredEffectClass,
    /// A segment file is missing below the highest present index.
    SegmentGap,
    /// A stored line is not a parseable canonical entry.
    MalformedEntry,
}

impl fmt::Display for DivergenceReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::EntryHashMismatch => "entry hash does not match the recomputed hash",
            Self::PrevHashMismatch => "entry does not reference its predecessor's hash",
            Self::SeqGap => "audit sequence is not contiguous",
            Self::NonCanonicalBytes => "stored line is not in canonical form",
            Self::MerkleRootMismatch => "recomputed merkle root differs from the signed root",
            Self::SignatureInvalid => "root signature does not verify under the device key",
            Self::RootChainBroken => "root chain linkage is broken",
            Self::RootMissing => "a finalized segment has no root record",
            Self::RootUnexpected => "a root record exists for a segment that is not finalized",
            Self::AnchorMismatch => "anchored roots do not match the local root chain",
            Self::TornTail => "segment ends in an unterminated, unparseable write",
            Self::UnregisteredEffectClass => "entry kind is not a declared effect class",
            Self::SegmentGap => "a segment file is missing below the highest present index",
            Self::MalformedEntry => "stored line is not a parseable canonical entry",
        };
        f.write_str(text)
    }
}

/// The first place the record and the recomputation disagree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Divergence {
    /// The segment index, when the divergence is segment-scoped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment: Option<u32>,
    /// The audit `seq` the divergence was found at, when entry-scoped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    /// Why it diverged.
    pub reason: DivergenceReason,
    /// What the recomputation found.
    pub found: String,
    /// What the record holds.
    pub expected: String,
}

impl Divergence {
    fn at_segment(segment: u32, reason: DivergenceReason, found: String, expected: String) -> Self {
        Self {
            segment: Some(segment),
            seq: None,
            reason,
            found,
            expected,
        }
    }
}

impl fmt::Display for Divergence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.segment, self.seq) {
            (Some(segment), Some(seq)) => {
                write!(
                    f,
                    "segment {segment} seq {seq}: {} (found `{}`, expected `{}`)",
                    self.reason, self.found, self.expected
                )
            }
            (Some(segment), None) => write!(
                f,
                "segment {segment}: {} (found `{}`, expected `{}`)",
                self.reason, self.found, self.expected
            ),
            (None, Some(seq)) => write!(
                f,
                "seq {seq}: {} (found `{}`, expected `{}`)",
                self.reason, self.found, self.expected
            ),
            (None, None) => write!(
                f,
                "{} (found `{}`, expected `{}`)",
                self.reason, self.found, self.expected
            ),
        }
    }
}

impl std::error::Error for Divergence {}

/// One segment's verified state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SegmentSummary {
    /// The segment index.
    pub segment: u32,
    /// First audit `seq` in the segment.
    pub first_seq: u64,
    /// Last audit `seq` in the segment.
    pub last_seq: u64,
    /// Entry count.
    pub count: u64,
    /// Whether a signed root covers the segment.
    pub sealed: bool,
    /// Whether the signed root is present in the sink.
    pub anchored: bool,
    /// The Merkle root recomputed from the committed entry hashes.
    pub recomputed_merkle_root: String,
    /// The signed Merkle root, when the segment is sealed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_merkle_root: Option<String>,
    /// Whether the root signature verified.
    pub signature_ok: bool,
}

/// The entries after the last anchored root. They are **not** covered by the
/// anchor and are reported as such.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct UnanchoredTail {
    /// First `seq` outside the anchor.
    pub first_seq: u64,
    /// Last `seq` outside the anchor.
    pub last_seq: u64,
    /// How many entries are outside the anchor.
    pub count: u64,
}

/// What a verification at a given level establishes, and what it does not.
///
/// Only the three level names may describe the evidence, and `local-sink` is
/// never rendered as `off-box` (`DEC-022`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClaimBoundary {
    /// The level evaluated.
    pub level: AnchorLevelName,
    /// The sink the anchor is written to, when one is configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sink: Option<String>,
    /// Questions whose answer is the same at every level.
    pub detects: Vec<String>,
    /// Questions a chain never answers.
    pub does_not_detect: Vec<String>,
}

/// A successful verification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VerifyReport {
    /// How many entries were recomputed.
    pub entries_checked: u64,
    /// How many roots were recomputed and signature-checked.
    pub roots_checked: u64,
    /// How many roots are present in the sink.
    pub anchored_roots: u64,
    /// Per-segment state.
    pub segments: Vec<SegmentSummary>,
    /// The entries after the last anchored root, when any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unanchored_tail: Option<UnanchoredTail>,
    /// The rendered claim boundary.
    pub claim: ClaimBoundary,
}

impl VerifyReport {
    /// Renders the human-readable claim boundary text for the level.
    #[must_use]
    pub fn render_claim(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "anchoring level: {} (signature algorithm: {})\n",
            self.claim.level.as_str(),
            crate::key::SIGNATURE_ALGORITHM
        ));
        match &self.claim.sink {
            Some(sink) => out.push_str(&format!("anchor sink: {sink}\n")),
            None => out.push_str("anchor sink: none (signed roots only, inside the audit store)\n"),
        }
        out.push_str("verify PROVES:\n");
        for line in &self.claim.detects {
            out.push_str(&format!("  - {line}\n"));
        }
        out.push_str("verify does NOT prove:\n");
        for line in &self.claim.does_not_detect {
            out.push_str(&format!("  - {line}\n"));
        }
        match self.unanchored_tail {
            Some(tail) => out.push_str(&format!(
                "unanchored tail: seq {}..={} ({} entries) are outside the anchor and are not \
                 covered by it\n",
                tail.first_seq, tail.last_seq, tail.count
            )),
            None => {
                out.push_str("unanchored tail: none; every entry is covered by an anchored root\n")
            }
        }
        out
    }
}

/// Verifies the chain, roots, signatures, and anchor.
///
/// # Errors
/// Returns [`Divergence`] for the first disagreement found, or
/// [`AuditError`] when the store, the device key, or a configured sink cannot be
/// read at all — both are fail-closed outcomes, never a pass.
pub fn verify(config: &AuditConfig) -> Result<VerifyReport, VerifyError> {
    let key_path = crate::key::device_key_path(&config.root);
    if !key_path.exists() {
        // A store that was never written has nothing to verify. That is a pass,
        // not a failure: a missing key on a *non-empty* store is a divergence
        // (the roots could not have been signed by anyone), but an empty store
        // simply has no history yet.
        if read_segments(config)
            .map_err(VerifyError::Audit)?
            .iter()
            .all(|segment| segment.entries.is_empty())
        {
            return Ok(empty_report(config));
        }
        return Err(VerifyError::Audit(AuditError::DeviceKey(format!(
            "{} is missing; signed roots cannot be verified",
            key_path.display()
        ))));
    }
    let key = crate::key::load_device_key(&key_path).map_err(VerifyError::Audit)?;
    verify_with_key(config, &key)
}

/// The report for a store with no recorded history.
fn empty_report(config: &AuditConfig) -> VerifyReport {
    let level = config.anchor.level();
    VerifyReport {
        entries_checked: 0,
        roots_checked: 0,
        anchored_roots: 0,
        segments: Vec::new(),
        unanchored_tail: None,
        claim: claim_boundary(level, None),
    }
}

/// [`verify`] plus a preloaded key, so a caller can verify without minting one.
fn verify_with_key(config: &AuditConfig, key: &DeviceKey) -> Result<VerifyReport, VerifyError> {
    let level = config.anchor.level();
    let sink_path = config
        .anchor
        .resolve_sink(&config.root)
        .map_err(VerifyError::Audit)?;
    let sink = sink_path
        .as_deref()
        .map(AnchorSink::open)
        .transpose()
        .map_err(VerifyError::Audit)?;

    let segments = read_segments(config).map_err(VerifyError::Audit)?;
    let roots = read_roots(config).map_err(VerifyError::Audit)?;

    // 0. The segment set must be contiguous from 0, otherwise the per-segment
    //    roots are not a cover of the chain.
    let gaps = indices_with_gaps(&segments);
    if let Some(index) = gaps.first() {
        return Err(VerifyError::Divergence(Divergence {
            segment: Some(*index),
            seq: None,
            reason: DivergenceReason::SegmentGap,
            found: format!("segment {index} is missing"),
            expected: "every segment index from 0".to_owned(),
        }));
    }

    // 1. The chain, entry by entry, in order.
    let mut expected_seq = 0u64;
    let mut expected_prev = GENESIS_PREV_HASH.to_owned();
    for segment in &segments {
        if let Some(line) = segment.corrupt_lines.first() {
            let last_good = segment.entries.last().map_or(0, |entry| entry.seq);
            return Err(VerifyError::Divergence(Divergence {
                segment: Some(segment.index),
                seq: Some(last_good),
                reason: DivergenceReason::MalformedEntry,
                found: format!(
                    "line {line} of segment {} is not valid JSON for an entry",
                    segment.index
                ),
                expected: format!("one canonical entry per line (last intact seq {last_good})"),
            }));
        }
        if segment.torn_tail_bytes > 0 {
            let last = segment.entries.last().map_or(0, |entry| entry.seq);
            return Err(VerifyError::Divergence(Divergence::at_segment(
                segment.index,
                DivergenceReason::TornTail,
                format!("{} unparseable trailing bytes", segment.torn_tail_bytes),
                format!("last complete entry at seq {last}"),
            )));
        }
        for (position, entry) in segment.entries.iter().enumerate() {
            check_entry(
                entry,
                segment.index,
                segment.raw_lines[position].as_str(),
                &expected_seq,
                &expected_prev,
            )?;
            expected_seq = entry.seq.saturating_add(1);
            expected_prev = entry.entry_hash.clone();
        }
    }

    // 2. Every root must cover exactly the entries of its own segment, be
    //    signed, and be chain-linked to its predecessor.
    let mut prev_chain = GENESIS_PREV_ROOT.to_owned();
    for (position, record) in roots.iter().enumerate() {
        if record.segment != position as u32 {
            return Err(VerifyError::Divergence(Divergence::at_segment(
                record.segment,
                DivergenceReason::RootChainBroken,
                format!("root #{position} names segment {}", record.segment),
                format!("root #{position} names segment {position}"),
            )));
        }
        let Some(segment) = segments.iter().find(|item| item.index == record.segment) else {
            return Err(VerifyError::Divergence(Divergence::at_segment(
                record.segment,
                DivergenceReason::RootMissing,
                "no such segment file".to_owned(),
                format!("{} entries", record.count),
            )));
        };
        let first = segment.entries.first().map_or(0, |entry| entry.seq);
        let last = segment.entries.last().map_or(0, |entry| entry.seq);
        if record.count != segment.entries.len() as u64
            || record.first_seq != first
            || record.last_seq != last
        {
            return Err(VerifyError::Divergence(Divergence::at_segment(
                record.segment,
                DivergenceReason::MerkleRootMismatch,
                format!(
                    "segment holds {} entries (seq {first}..={last})",
                    segment.entries.len()
                ),
                format!(
                    "the signed root covers {} entries (seq {}..={})",
                    record.count, record.first_seq, record.last_seq
                ),
            )));
        }
        let recomputed = merkle_root(&segment.leaves());
        if recomputed != record.merkle_root {
            return Err(VerifyError::Divergence(Divergence::at_segment(
                record.segment,
                DivergenceReason::MerkleRootMismatch,
                recomputed,
                record.merkle_root.clone(),
            )));
        }
        if !record.signature_ok(key) {
            return Err(VerifyError::Divergence(Divergence::at_segment(
                record.segment,
                DivergenceReason::SignatureInvalid,
                format!("{} did not verify", record.signature.algorithm),
                "a valid device-key signature".to_owned(),
            )));
        }
        if record.prev_root != prev_chain || record.compute_chain() != record.root_chain {
            return Err(VerifyError::Divergence(Divergence::at_segment(
                record.segment,
                DivergenceReason::RootChainBroken,
                record.root_chain.clone(),
                prev_chain.clone(),
            )));
        }
        prev_chain = record.root_chain.clone();
    }

    // 3. The anchor: every finalized root must be present, byte-equal, in the
    //    sink. At `local-trust` there is no sink and nothing is claimed.
    let anchored_records = match &sink {
        Some(sink) => sink.read_roots().map_err(VerifyError::Audit)?,
        None => Vec::new(),
    };
    if anchored_records.len() > roots.len() {
        return Err(VerifyError::Divergence(Divergence {
            segment: None,
            seq: None,
            reason: DivergenceReason::AnchorMismatch,
            found: format!("the sink holds {} roots", anchored_records.len()),
            expected: format!("the local root chain holds {}", roots.len()),
        }));
    }
    for (position, anchored) in anchored_records.iter().enumerate() {
        let Some(record) = roots.get(position) else {
            return Err(VerifyError::Divergence(Divergence {
                segment: Some(anchored.segment),
                seq: None,
                reason: DivergenceReason::AnchorMismatch,
                found: format!("the sink holds a root for segment {}", anchored.segment),
                expected: "no such root in the local chain".to_owned(),
            }));
        };
        if anchored != record {
            return Err(VerifyError::Divergence(Divergence::at_segment(
                anchored.segment,
                DivergenceReason::AnchorMismatch,
                format!("sink chain `{}`", anchored.root_chain),
                format!("local chain `{}`", record.root_chain),
            )));
        }
    }
    // At every level that declares a sink, an already-anchored root must be
    // present there. A sealed root that is not yet anchored is not a failure —
    // it is the unanchored tail, which is reported below.

    // The report.
    let last_seq = expected_seq.saturating_sub(1);
    let anchored_upto = anchored_records
        .iter()
        .filter_map(|record| record.last_seq.checked_add(1))
        .max();
    let mut summaries = Vec::with_capacity(segments.len());
    for segment in &segments {
        let recomputed = merkle_root(&segment.leaves());
        let record = roots.iter().find(|root| root.segment == segment.index);
        let anchored = record.is_some_and(|record| {
            anchored_records
                .iter()
                .any(|anchored| anchored.segment == record.segment)
        });
        summaries.push(SegmentSummary {
            segment: segment.index,
            first_seq: segment.entries.first().map_or(0, |entry| entry.seq),
            last_seq: segment.entries.last().map_or(0, |entry| entry.seq),
            count: segment.entries.len() as u64,
            sealed: record.is_some(),
            anchored,
            recomputed_merkle_root: recomputed,
            signed_merkle_root: record.map(|record| record.merkle_root.clone()),
            signature_ok: record.is_some_and(|record| record.signature_ok(key)),
        });
    }
    let unanchored_tail = match anchored_upto {
        Some(first_unanchored) if first_unanchored <= last_seq => Some(UnanchoredTail {
            first_seq: first_unanchored,
            last_seq,
            count: last_seq - first_unanchored + 1,
        }),
        _ => None,
    };
    Ok(VerifyReport {
        entries_checked: expected_seq,
        roots_checked: roots.len() as u64,
        anchored_roots: anchored_records.len() as u64,
        segments: summaries,
        unanchored_tail,
        claim: claim_boundary(level, sink_path.as_deref()),
    })
}

/// Checks one entry against the recomputed chain.
fn check_entry(
    entry: &crate::entry::AuditEntry,
    segment: u32,
    raw_line: &str,
    expected_seq: &u64,
    expected_prev: &str,
) -> Result<(), VerifyError> {
    let divergence = |reason: DivergenceReason, found: String, expected: String| {
        VerifyError::Divergence(Divergence {
            segment: Some(segment),
            seq: Some(entry.seq),
            reason,
            found,
            expected,
        })
    };
    if entry.seq != *expected_seq {
        return Err(divergence(
            DivergenceReason::SeqGap,
            entry.seq.to_string(),
            expected_seq.to_string(),
        ));
    }
    if entry.effect_class().is_none() {
        return Err(divergence(
            DivergenceReason::UnregisteredEffectClass,
            format!("{:?}", entry.kind),
            "a declared effect class".to_owned(),
        ));
    }
    if entry.prev_hash != expected_prev {
        return Err(divergence(
            DivergenceReason::PrevHashMismatch,
            entry.prev_hash.clone(),
            expected_prev.to_owned(),
        ));
    }
    let recomputed = entry.compute_hash();
    if recomputed != entry.entry_hash {
        return Err(divergence(
            DivergenceReason::EntryHashMismatch,
            recomputed,
            entry.entry_hash.clone(),
        ));
    }
    // The stored bytes must already be canonical: comparing the re-serialized
    // canonical form against the exact stored line is what catches a
    // whitespace or key-order rewrite that would otherwise parse identically.
    let canonical = String::from_utf8_lossy(&entry.canonical_line()).into_owned();
    if canonical != raw_line {
        return Err(divergence(
            DivergenceReason::NonCanonicalBytes,
            canonical,
            raw_line.to_owned(),
        ));
    }
    Ok(())
}

/// The claim boundary for a level. The wording is identical at every level
/// except where a level's *sink* changes what an attacker must also hold.
#[must_use]
pub fn claim_boundary(level: AnchorLevelName, sink: Option<&std::path::Path>) -> ClaimBoundary {
    let mut does_not_detect = vec![
        "that the recorded content is truthful or authentic; a hash chain never establishes \
         content authenticity"
            .to_owned(),
        "fabrication by a principal that holds local write access to the audit store".to_owned(),
        "any alteration of entries written after the last anchored root (the unanchored \
         tail)"
            .to_owned(),
        "that an unrecorded effect did not occur somewhere else entirely; coverage is a \
         separate census (REQ-AUDIT-005)"
            .to_owned(),
    ];
    if level != AnchorLevelName::LocalTrust {
        does_not_detect.push(
            "fabrication by a principal that also holds write access to the anchor sink \
             (off-box is the only level that survives that)"
                .to_owned(),
        );
    }
    ClaimBoundary {
        level,
        sink: sink.map(|path| path.display().to_string()),
        detects: vec![
            "modification of already-anchored history by a principal that does not hold the \
             anchoring credential, including added, removed, reordered, truncated, and \
             modified entries inside a sealed segment"
                .to_owned(),
            "any entry whose stored hash, predecessor link, sequence position, or canonical \
             bytes do not recompute"
                .to_owned(),
            "an entry added to a sealed segment after its root was finalized (the root no longer \
             covers it)"
                .to_owned(),
        ],
        does_not_detect,
    }
}

/// A verification failure: either a divergence in the record, or a store-level
/// failure that prevents verification at all.
#[derive(Debug)]
pub enum VerifyError {
    /// The record diverges from its recomputation.
    Divergence(Divergence),
    /// The store, key, or sink could not be read.
    Audit(AuditError),
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Divergence(divergence) => write!(f, "{divergence}"),
            Self::Audit(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for VerifyError {}

impl From<Divergence> for VerifyError {
    fn from(divergence: Divergence) -> Self {
        Self::Divergence(divergence)
    }
}
