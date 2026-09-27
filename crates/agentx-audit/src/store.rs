//! The append-only audit store: segment files, the head pointer, the local
//! root chain, and the append lock (`ARCH/14-AUDIT.md` §Storage layout).
//!
//! ```text
//! <state-dir>/audit/
//!   segments/0000.jsonl   one canonical entry per line, append-only
//!   segments/0001.jsonl
//!   roots.jsonl           one signed SegmentRoots record per finalized segment
//!   head                  atomic-replace pointer + sealed/anchored bookkeeping
//!   device.key            0600, the unconditional root-signing key
//! <state-dir>/audit-anchor/roots.jsonl   the default local-sink, outside the
//!                                        audit store root
//! ```
//!
//! Appends advance the chain under an exclusive in-process lock, are flushed
//! and `fsync`ed before returning, and the `head` pointer is replaced
//! atomically. The chain tip is always re-derived from the segment files, so a
//! crash between the segment append and the head replace is repaired rather than
//! mistaken for tampering.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::anchor::{
    AnchorCadence, AnchorConfig, AnchorSink, FinalizeOptions, GENESIS_PREV_ROOT, HashAlgorithm,
    RootRecord,
};
use crate::entry::{
    Actor, AnchorLevelName, AuditEntry, AuditRecord, EntryKind, GENESIS_PREV_HASH, Outcome,
};
use crate::error::AuditError;
use crate::key::{DeviceKey, load_device_key, load_or_create_device_key, set_owner_only};
use crate::redact::Redactor;

/// Default maximum entries per segment.
pub const DEFAULT_SEGMENT_MAX_ENTRIES: u64 = 4096;
/// Default maximum bytes per segment.
pub const DEFAULT_SEGMENT_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// The head pointer format version.
pub const HEAD_FORMAT_VERSION: u32 = 1;
/// The `roots.jsonl` file name.
pub const ROOTS_FILE: &str = "roots.jsonl";
/// The `head` pointer file name.
pub const HEAD_FILE: &str = "head";
/// The `segments/` directory name.
pub const SEGMENTS_DIR: &str = "segments";

/// Returns the default audit store root: `$AGENTX_HOME/audit` when
/// `AGENTX_HOME` is set, otherwise `~/.agentx/audit`.
#[must_use]
pub fn default_audit_root() -> PathBuf {
    let base = std::env::var_os("AGENTX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("audit")
}

/// Values that must never reach the chain.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedactionConfig {
    /// Secret values registered ahead of time.
    #[serde(default)]
    pub secrets: Vec<String>,
}

impl RedactionConfig {
    /// Builds a redactor from this configuration plus the process environment.
    #[must_use]
    pub fn redactor(&self, env: &[(String, String)]) -> Redactor {
        let mut redactor = Redactor::from_env_vars(env);
        for secret in &self.secrets {
            redactor.add_secret(secret.clone());
        }
        redactor
    }
}

/// The audit store configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditConfig {
    /// The audit store root.
    pub root: PathBuf,
    /// Entries per segment before rollover.
    #[serde(default = "default_segment_max_entries")]
    pub segment_max_entries: u64,
    /// Bytes per segment before rollover.
    #[serde(default = "default_segment_max_bytes")]
    pub segment_max_bytes: u64,
    /// The hash function; only `blake3` is implemented.
    #[serde(default)]
    pub hash: HashAlgorithm,
    /// The anchoring configuration.
    #[serde(default)]
    pub anchor: AnchorConfig,
    /// Registered secret values.
    #[serde(default)]
    pub redaction: RedactionConfig,
}

fn default_segment_max_entries() -> u64 {
    DEFAULT_SEGMENT_MAX_ENTRIES
}

fn default_segment_max_bytes() -> u64 {
    DEFAULT_SEGMENT_MAX_BYTES
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            root: default_audit_root(),
            segment_max_entries: DEFAULT_SEGMENT_MAX_ENTRIES,
            segment_max_bytes: DEFAULT_SEGMENT_MAX_BYTES,
            hash: HashAlgorithm::Blake3,
            anchor: AnchorConfig::default(),
            redaction: RedactionConfig::default(),
        }
    }
}

impl AuditConfig {
    /// Builds a config rooted at `root` with the default posture
    /// (`local-sink`, signed roots, blake3).
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            ..Self::default()
        }
    }

    /// Parses an `audit` configuration document.
    ///
    /// # Errors
    /// Returns [`AuditError::Config`] for an invalid value, including
    /// `sign: false`.
    pub fn from_json(root: PathBuf, value: &serde_json::Value) -> Result<Self, AuditError> {
        let anchor = AnchorConfig::from_json(value)?;
        let number = |key: &str, fallback: u64| -> Result<u64, AuditError> {
            match value.get(key) {
                None | Some(serde_json::Value::Null) => Ok(fallback),
                Some(serde_json::Value::Number(number)) => number.as_u64().ok_or_else(|| {
                    AuditError::Config(format!("audit.{key} must be a non-negative integer"))
                }),
                Some(_) => Err(AuditError::Config(format!(
                    "audit.{key} must be an integer"
                ))),
            }
        };
        let config = Self {
            root,
            segment_max_entries: number("segment_max_entries", DEFAULT_SEGMENT_MAX_ENTRIES)?,
            segment_max_bytes: number("segment_max_bytes", DEFAULT_SEGMENT_MAX_BYTES)?,
            hash: HashAlgorithm::Blake3,
            anchor,
            redaction: RedactionConfig::default(),
        };
        if let Some(value) = value.get("enabled").and_then(|v| v.as_bool())
            && !value
        {
            return Err(AuditError::Config(
                "audit.enabled is false; an unrecorded effect must not be committed \
                 unrecorded"
                    .to_owned(),
            ));
        }
        config.validate()?;
        Ok(config)
    }

    /// Validates the configuration.
    ///
    /// # Errors
    /// Returns [`AuditError::Config`] for a zero rollover bound or an
    /// inconsistent anchor configuration.
    pub fn validate(&self) -> Result<(), AuditError> {
        if self.segment_max_entries == 0 {
            return Err(AuditError::Config(
                "audit.segment_max_entries must be at least 1".to_owned(),
            ));
        }
        if self.segment_max_bytes == 0 {
            return Err(AuditError::Config(
                "audit.segment_max_bytes must be at least 1".to_owned(),
            ));
        }
        if let AnchorCadence::EveryNSegments(count) = self.anchor.cadence
            && count == 0
        {
            return Err(AuditError::Config(
                "audit.anchor.cadence every_n_segments must be at least 1".to_owned(),
            ));
        }
        self.anchor.validate()
    }

    /// Returns the segments directory.
    #[must_use]
    pub fn segments_dir(&self) -> PathBuf {
        self.root.join(SEGMENTS_DIR)
    }

    /// Returns the local root-chain file.
    #[must_use]
    pub fn roots_path(&self) -> PathBuf {
        self.root.join(ROOTS_FILE)
    }

    /// Returns the head pointer file.
    #[must_use]
    pub fn head_path(&self) -> PathBuf {
        self.root.join(HEAD_FILE)
    }

    /// Returns the segment file for an index.
    #[must_use]
    pub fn segment_path(&self, index: u32) -> PathBuf {
        self.segments_dir().join(format!("{index:04}.jsonl"))
    }
}

/// The head pointer. The chain tip itself is always re-derived from the segment
/// files; this records the bookkeeping that must survive a crash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Head {
    version: u32,
    /// The highest segment index the store has written to.
    segment: u32,
    /// How many entries the store believed were committed when the pointer was
    /// last replaced.
    next_seq: u64,
    /// The last committed entry hash when the pointer was last replaced.
    last_hash: String,
    /// Segment indices with a finalized, signed root.
    sealed: Vec<u32>,
    /// Segment indices whose signed root is present in the sink.
    anchored: Vec<u32>,
}

impl Head {
    fn empty() -> Self {
        Self {
            version: HEAD_FORMAT_VERSION,
            segment: 0,
            next_seq: 0,
            last_hash: GENESIS_PREV_HASH.to_owned(),
            sealed: Vec::new(),
            anchored: Vec::new(),
        }
    }
}

/// One segment's parsed contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentContents {
    /// The segment index.
    pub index: u32,
    /// The entries in order.
    pub entries: Vec<AuditEntry>,
    /// The exact stored line for each entry, so canonical-form drift is
    /// detectable rather than normalized away by the parser.
    pub raw_lines: Vec<String>,
    /// Bytes of an unterminated, unparseable trailing write.
    pub torn_tail_bytes: usize,
    /// 1-based line numbers whose bytes are not a parseable entry.
    ///
    /// A corrupted line is a **finding**, not a reason to refuse to look: the
    /// caller reports it as the first divergence, naming the segment and the
    /// line, instead of failing with an opaque "cannot read" error.
    pub corrupt_lines: Vec<usize>,
}

impl SegmentContents {
    /// Returns the entry hashes in order.
    #[must_use]
    pub fn leaves(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|entry| entry.entry_hash.clone())
            .collect()
    }
}

/// The append-only audit store.
#[derive(Debug)]
pub struct AuditLog {
    config: AuditConfig,
    level: AnchorLevelName,
    key: DeviceKey,
    sink: Option<AnchorSink>,
    /// The exclusive append lock.
    head: Mutex<Head>,
    writable: bool,
    redactor: Redactor,
}

impl AuditLog {
    /// Opens the store for append, creating and validating everything the
    /// configured posture requires.
    ///
    /// # Errors
    /// Fails closed on: an invalid configuration, a `remote` sink this build
    /// cannot provide, an unreachable or unsafe configured sink, and a
    /// on-disk state that diverges from the recorded head.
    pub fn open(config: AuditConfig, env: &[(String, String)]) -> Result<Self, AuditError> {
        Self::open_inner(config, env, true)
    }

    /// Opens the store for reading only (verify, replay, census).
    ///
    /// The device key and the configured sink are still required, so a missing
    /// or unreachable anchor is reported rather than ignored.
    ///
    /// # Errors
    /// As [`AuditLog::open`], without mutating the store.
    pub fn open_read_only(config: AuditConfig) -> Result<Self, AuditError> {
        let key_path = crate::key::device_key_path(&config.root);
        if !key_path.exists() {
            return Err(AuditError::DeviceKey(format!(
                "{} is missing; signed roots cannot be verified",
                key_path.display()
            )));
        }
        Self::open_inner(config, &[], false)
    }

    fn open_inner(
        config: AuditConfig,
        env: &[(String, String)],
        writable: bool,
    ) -> Result<Self, AuditError> {
        config.validate()?;
        // Validate the declared anchor **before** creating anything: a
        // configured-but-unreachable sink must fail closed without leaving a
        // half-built store behind to write into.
        let level = config.anchor.level();
        let sink = match config.anchor.resolve_sink(&config.root)? {
            Some(path) => Some(AnchorSink::open(&path)?),
            None => None,
        };
        if writable {
            fs::create_dir_all(config.segments_dir())
                .map_err(|error| AuditError::io(config.segments_dir(), &error))?;
            crate::key::set_dir_owner_only(&config.root)?;
        } else if !config.root.is_dir() {
            return Err(AuditError::Config(format!(
                "audit store root {} does not exist",
                config.root.display()
            )));
        }
        let redactor = config.redaction.redactor(env);
        let key = if writable {
            load_or_create_device_key(&config.root)?
        } else {
            load_device_key(&crate::key::device_key_path(&config.root))?
        };

        let segments = read_segments(&config)?;
        if writable {
            let gaps = indices_with_gaps(&segments);
            if !gaps.is_empty() {
                return Err(AuditError::Config(format!(
                    "audit segment(s) {gaps:?} are missing below the highest present index; \
                     refusing to append into a gapped store"
                )));
            }
        }
        let mut head = read_head(&config).unwrap_or_else(Head::empty);
        if head.version != HEAD_FORMAT_VERSION {
            return Err(AuditError::Config(format!(
                "audit head format version {} is not supported by this build (expected {})",
                head.version, HEAD_FORMAT_VERSION
            )));
        }
        // The active segment is derived from the sealed roots as well as the
        // segment files: once a segment has a root it is immutable, so the next
        // append must open a new file even though no file exists for it yet.
        let roots = read_roots(&config)?;
        let sealed_indices: Vec<u32> = roots.iter().map(|record| record.segment).collect();
        let tip = derive_tip(&segments, &sealed_indices);
        if head.next_seq > tip.next_seq {
            return Err(AuditError::StateMismatch {
                segment: head.segment,
                disk_entries: tip.next_seq,
                head_entries: head.next_seq,
            });
        }
        if writable {
            // A crash between a segment append and the head replace leaves the
            // disk ahead of the pointer; that is repaired and noted, not
            // mistaken for tampering.
            let recovered = tip.next_seq.saturating_sub(head.next_seq);
            head.segment = tip.segment;
            head.next_seq = tip.next_seq;
            head.last_hash = tip.last_hash.clone();
            head.sealed = sealed_indices;
            // The anchored set is a fact about the sink, not about the pointer.
            if let Some(sink) = &sink {
                head.anchored = sink
                    .read_roots()?
                    .iter()
                    .map(|record| record.segment)
                    .collect();
            }
            let log = Self {
                config,
                level,
                key,
                sink,
                head: Mutex::new(head),
                writable: true,
                redactor,
            };
            for segment in &segments {
                if segment.torn_tail_bytes > 0 {
                    log.repair_torn_tail(segment)?;
                }
            }
            if recovered > 0 {
                log.append(
                    AuditRecord::new("-", EntryKind::Run)
                        .with_actor(Actor::System)
                        .with_action("head_repair")
                        .with_outcome(Outcome::Ok)
                        .with_meta("recovered_entries", recovered),
                )?;
            }
            return Ok(log);
        }
        Ok(Self {
            config,
            level,
            key,
            sink,
            head: Mutex::new(head),
            writable: false,
            redactor,
        })
    }

    /// Returns the configuration.
    #[must_use]
    pub fn config(&self) -> &AuditConfig {
        &self.config
    }

    /// Returns the audit store root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.config.root
    }

    /// Returns the anchoring level in force.
    #[must_use]
    pub fn level(&self) -> AnchorLevelName {
        self.level
    }

    /// Returns the anchoring cadence.
    #[must_use]
    pub fn cadence(&self) -> AnchorCadence {
        self.config.anchor.cadence
    }

    /// Returns the device key, for signing and verification.
    #[must_use]
    pub fn device_key(&self) -> &DeviceKey {
        &self.key
    }

    /// Returns the resolved sink path, when a sink is configured.
    #[must_use]
    pub fn sink_path(&self) -> Option<&Path> {
        self.sink.as_ref().map(AnchorSink::path)
    }

    /// Returns the recorded head pointer.
    #[must_use]
    pub fn head(&self) -> HeadSnapshot {
        let head = self.lock();
        HeadSnapshot {
            segment: head.segment,
            next_seq: head.next_seq,
            last_hash: head.last_hash.clone(),
            sealed: head.sealed.clone(),
            anchored: head.anchored.clone(),
        }
    }

    /// Appends one record, timestamping it with the wall clock.
    ///
    /// # Errors
    /// Returns [`AuditError`] when the record is invalid, cannot be redacted,
    /// or cannot be durably written. The caller must fail the guarded action
    /// closed rather than proceed unrecorded.
    pub fn append(&self, record: AuditRecord) -> Result<AuditEntry, AuditError> {
        self.append_at(record, now_ms())
    }

    /// Appends one record with an explicit timestamp, for deterministic tests.
    ///
    /// # Errors
    /// As [`AuditLog::append`].
    pub fn append_at(&self, record: AuditRecord, ts: i64) -> Result<AuditEntry, AuditError> {
        if !self.writable {
            return Err(AuditError::Config(
                "this audit store was opened read-only".to_owned(),
            ));
        }
        let mut record = record;
        record.redact_in_place(&self.redactor);
        record.validate()?;
        let mut head = self.lock();
        let line_len = {
            let probe = AuditEntry::from_record(&record, head.next_seq, ts, &head.last_hash)?;
            probe.to_line().len() as u64
        };
        // Rollover happens before the append so a finalized segment is exactly
        // the set of entries its root covers.
        if self.segment_full(&head, line_len)? {
            self.seal_locked(&mut head, ts)?;
        }
        let entry = AuditEntry::from_record(&record, head.next_seq, ts, &head.last_hash)?;
        let path = self.config.segment_path(head.segment);
        append_line(&path, &entry)?;
        head.next_seq = head.next_seq.saturating_add(1);
        head.last_hash = entry.entry_hash.clone();
        self.write_head(&head)?;
        Ok(entry)
    }

    /// Finalizes the active segment: Merkle root, signature, local root chain.
    ///
    /// Returns `None` when the active segment is empty. Anchoring then follows
    /// the configured cadence.
    ///
    /// # Errors
    /// Returns [`AuditError`] when the root cannot be written durably, or when
    /// a due anchor fails — in which case the failure is **not** swallowed and
    /// the run is not presented as anchored.
    pub fn seal_current_segment(&self) -> Result<Option<RootRecord>, AuditError> {
        let mut head = self.lock();
        self.seal_locked(&mut head, now_ms())
    }

    /// Seals the active segment and then anchors every sealed-but-unanchored
    /// root, regardless of cadence.
    ///
    /// # Errors
    /// As [`AuditLog::seal_current_segment`].
    pub fn finish_turn(&self) -> Result<Option<RootRecord>, AuditError> {
        let sealed = self.seal_current_segment()?;
        if sealed.is_none() {
            return Ok(None);
        }
        self.anchor_pending()?;
        Ok(sealed)
    }

    /// Anchors every sealed root that is not yet in the sink.
    ///
    /// # Errors
    /// Returns [`AuditError::SinkUnreachable`] when the configured sink cannot
    /// be written; the caller must fail the evidence gate closed.
    pub fn anchor_pending(&self) -> Result<usize, AuditError> {
        let mut head = self.lock();
        self.anchor_pending_locked(&mut head)
    }

    /// Anchors the pending roots. The caller holds the append lock.
    fn anchor_pending_locked(&self, head: &mut Head) -> Result<usize, AuditError> {
        let pending = pending_roots(head);
        if pending.is_empty() {
            return Ok(0);
        }
        let records = read_roots(&self.config)?;
        let mut anchored = 0usize;
        // A declared sink is always present at `local-sink`/`off-box`
        // (`resolve_sink` would have failed otherwise), so its absence here is
        // the explicit `local-trust` posture: the roots are signed and kept in
        // the store, and `verify` labels them as carrying no independent
        // verification claim. Nothing is degraded silently.
        let Some(sink) = self.sink.as_ref() else {
            return Ok(0);
        };
        for index in pending {
            let Some(record) = records.iter().find(|record| record.segment == index) else {
                return Err(AuditError::StateMismatch {
                    segment: index,
                    disk_entries: 0,
                    head_entries: 1,
                });
            };
            sink.append_root(record)?;
            head.anchored.push(index);
            anchored += 1;
        }
        head.anchored.sort_unstable();
        head.anchored.dedup();
        self.write_head(head)?;
        Ok(anchored)
    }

    /// Reads every entry, in order, across all segments.
    ///
    /// # Errors
    /// Returns [`AuditError`] when a segment cannot be read.
    pub fn entries(&self) -> Result<Vec<AuditEntry>, AuditError> {
        Ok(read_segments(&self.config)?
            .into_iter()
            .flat_map(|segment| segment.entries)
            .collect())
    }

    /// Reads every finalized root record.
    ///
    /// # Errors
    /// Returns [`AuditError`] when `roots.jsonl` cannot be read.
    pub fn roots(&self) -> Result<Vec<RootRecord>, AuditError> {
        read_roots(&self.config)
    }

    /// Appends an audit note recording that this record was read.
    ///
    /// Reading the record is itself security-relevant access
    /// (`ARCH/14-AUDIT.md` §Open questions 5). The note is suppressed for a
    /// read-only store, which cannot write.
    ///
    /// # Errors
    /// Returns [`AuditError`] when the note cannot be written.
    pub fn note_access(
        &self,
        action: &str,
        resource: &str,
    ) -> Result<Option<AuditEntry>, AuditError> {
        if !self.writable {
            return Ok(None);
        }
        let entry = self.append(
            AuditRecord::new("-", EntryKind::RecordAccess)
                .with_actor(Actor::System)
                .with_action(action)
                .with_resource(resource)
                .with_outcome(Outcome::Ok)
                .with_anchor_level(self.level),
        )?;
        Ok(Some(entry))
    }

    fn segment_full(&self, head: &Head, line_len: u64) -> Result<bool, AuditError> {
        let path = self.config.segment_path(head.segment);
        let Ok(metadata) = fs::metadata(&path) else {
            return Ok(false);
        };
        let entries = count_lines(&path)?;
        Ok(u64::from(entries) >= self.config.segment_max_entries
            || metadata.len().saturating_add(line_len) > self.config.segment_max_bytes)
    }

    /// Seals the active segment. The caller holds the append lock.
    fn seal_locked(&self, head: &mut Head, ts: i64) -> Result<Option<RootRecord>, AuditError> {
        if head.sealed.contains(&head.segment) {
            return Ok(None);
        }
        let segment = read_segment(&self.config, head.segment)?;
        if segment.entries.is_empty() {
            return Ok(None);
        }
        let roots = read_roots(&self.config)?;
        let prev_root = roots
            .last()
            .map_or(GENESIS_PREV_ROOT, |record| record.root_chain.as_str());
        let first = segment.entries.first().map_or(0, |entry| entry.seq);
        let last = segment.entries.last().map_or(0, |entry| entry.seq);
        let leaves = segment.leaves();
        let record = RootRecord::finalize(FinalizeOptions {
            segment: head.segment,
            leaves: &leaves,
            first_seq: first,
            last_seq: last,
            prev_root,
            key: &self.key,
            ts,
            level: self.level,
        });
        let path = self.config.roots_path();
        append_line(&path, &record)?;
        head.sealed.push(head.segment);
        head.sealed.sort_unstable();
        // The finalized segment is immutable; the next append opens a new file.
        head.segment = head.segment.saturating_add(1);
        head.next_seq = record.last_seq.saturating_add(1);
        self.write_head(head)?;
        // A cadence that is not due leaves the root sealed but unanchored. The
        // unanchored tail is reported by `verify` and never claimed as anchored.
        self.anchor_if_due(head)?;
        Ok(Some(record))
    }

    /// Anchors when the configured cadence is due.
    fn anchor_if_due(&self, head: &mut Head) -> Result<(), AuditError> {
        let due = match self.config.anchor.cadence {
            AnchorCadence::SessionClose => true,
            AnchorCadence::EveryNSegments(count) => {
                let sealed = head.sealed.len();
                sealed > 0 && sealed.is_multiple_of(count as usize)
            }
        };
        if !due {
            return Ok(());
        }
        self.anchor_pending_locked(head).map(|_| ())
    }

    /// Truncates a torn trailing write and records the repair.
    fn repair_torn_tail(&self, segment: &SegmentContents) -> Result<(), AuditError> {
        let path = self.config.segment_path(segment.index);
        let metadata = fs::metadata(&path).map_err(|error| AuditError::io(&path, &error))?;
        let keep = metadata
            .len()
            .saturating_sub(segment.torn_tail_bytes as u64);
        let file = OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|error| AuditError::io(&path, &error))?;
        file.set_len(keep)
            .map_err(|error| AuditError::io(&path, &error))?;
        file.sync_data()
            .map_err(|error| AuditError::io(&path, &error))?;
        drop(file);
        let mut record = AuditRecord::new("-", EntryKind::Run)
            .with_actor(Actor::System)
            .with_action("tail_repair")
            .with_outcome(Outcome::Ok)
            .with_meta("segment", segment.index as i64)
            .with_meta("truncated_bytes", segment.torn_tail_bytes as i64);
        record.redact_in_place(&self.redactor);
        let tip = self.derive_tip_from_disk();
        let entry = AuditEntry::from_record(&record, tip.0, now_ms(), &tip.1)?;
        append_line(&path, &entry)?;
        Ok(())
    }

    fn derive_tip_from_disk(&self) -> (u64, String) {
        match (read_segments(&self.config), read_roots(&self.config)) {
            (Ok(segments), Ok(roots)) => {
                let sealed: Vec<u32> = roots.iter().map(|record| record.segment).collect();
                let tip = derive_tip(&segments, &sealed);
                (tip.next_seq, tip.last_hash)
            }
            _ => (0, GENESIS_PREV_HASH.to_owned()),
        }
    }

    fn write_head(&self, head: &Head) -> Result<(), AuditError> {
        let path = self.config.head_path();
        let temp = path.with_extension("new");
        let line =
            serde_json::to_string(head).map_err(|error| AuditError::Config(error.to_string()))?;
        {
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&temp)
                .map_err(|error| AuditError::io(&temp, &error))?;
            file.write_all(line.as_bytes())
                .and_then(|()| file.write_all(b"\n"))
                .and_then(|()| file.flush())
                .and_then(|()| file.sync_data())
                .map_err(|error| AuditError::io(&temp, &error))?;
        }
        set_owner_only(&temp)?;
        fs::rename(&temp, &path).map_err(|error| AuditError::io(&path, &error))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Head> {
        self.head
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A read-only view of the head pointer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeadSnapshot {
    /// The highest segment index written to.
    pub segment: u32,
    /// The next audit sequence to assign.
    pub next_seq: u64,
    /// The last committed entry hash.
    pub last_hash: String,
    /// Finalized segment indices.
    pub sealed: Vec<u32>,
    /// Anchored segment indices.
    pub anchored: Vec<u32>,
}

/// The derived chain tip.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Tip {
    segment: u32,
    next_seq: u64,
    last_hash: String,
}

fn derive_tip(segments: &[SegmentContents], sealed: &[u32]) -> Tip {
    let last_entry = segments
        .iter()
        .flat_map(|segment| segment.entries.last())
        .next_back();
    let highest = segments.last().map_or(0, |segment| segment.index);
    // A finalized segment never receives another entry, so the active segment
    // is one past the highest sealed index.
    let highest_sealed = sealed.iter().copied().max().map_or(0, |index| index + 1);
    Tip {
        segment: highest.max(highest_sealed),
        next_seq: last_entry.map_or(0, |entry| entry.seq.saturating_add(1)),
        last_hash: last_entry.map_or_else(
            || GENESIS_PREV_HASH.to_owned(),
            |entry| entry.entry_hash.clone(),
        ),
    }
}

/// The sealed roots that are not yet present in the sink.
fn pending_roots(head: &Head) -> Vec<u32> {
    head.sealed
        .iter()
        .copied()
        .filter(|index| !head.anchored.contains(index))
        .collect()
}

fn read_head(config: &AuditConfig) -> Option<Head> {
    let raw = fs::read_to_string(config.head_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Reads every segment file in index order.
pub fn read_segments(config: &AuditConfig) -> Result<Vec<SegmentContents>, AuditError> {
    let dir = config.segments_dir();
    let mut indices: Vec<u32> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if let Ok(index) = stem.parse::<u32>() {
                indices.push(index);
            }
        }
    }
    indices.sort_unstable();
    let mut out = Vec::with_capacity(indices.len());
    for index in indices {
        out.push(read_segment(config, index)?);
    }
    Ok(out)
}

/// Returns the segment indices missing below the highest present index.
#[must_use]
pub fn indices_with_gaps(segments: &[SegmentContents]) -> Vec<u32> {
    let mut present: Vec<u32> = segments.iter().map(|segment| segment.index).collect();
    present.sort_unstable();
    present.dedup();
    // A store with no segment files at all has no gap.
    let Some(highest) = present.last().copied() else {
        return Vec::new();
    };
    (0..=highest)
        .filter(|index| !present.contains(index))
        .collect()
}

/// Reads one segment file, reporting (not repairing) a torn trailing write.
pub fn read_segment(config: &AuditConfig, index: u32) -> Result<SegmentContents, AuditError> {
    let path = config.segment_path(index);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SegmentContents {
                index,
                entries: Vec::new(),
                raw_lines: Vec::new(),
                torn_tail_bytes: 0,
                corrupt_lines: Vec::new(),
            });
        }
        Err(error) => return Err(AuditError::io(&path, &error)),
    };
    let mut entries: Vec<AuditEntry> = Vec::new();
    let mut raw_lines: Vec<String> = Vec::new();
    let mut torn_tail_bytes = 0usize;
    let mut corrupt_lines: Vec<usize> = Vec::new();
    let segments: Vec<&str> = content.split_inclusive('\n').collect();
    let last_index = segments.len().saturating_sub(1);
    for (position, segment) in segments.iter().enumerate() {
        let terminated = segment.ends_with('\n');
        let trimmed = segment.trim_end_matches('\n');
        if trimmed.trim().is_empty() {
            if !terminated {
                torn_tail_bytes = segment.len();
            }
            continue;
        }
        match serde_json::from_str::<AuditEntry>(trimmed) {
            Ok(entry) => {
                raw_lines.push(trimmed.to_owned());
                entries.push(entry);
            }
            Err(_) if position == last_index && !terminated => {
                torn_tail_bytes = segment.len();
            }
            Err(_) => corrupt_lines.push(position + 1),
        }
    }
    Ok(SegmentContents {
        index,
        entries,
        raw_lines,
        torn_tail_bytes,
        corrupt_lines,
    })
}

/// Lists the segment indices present on disk, in order.
///
/// This is the raw reader the coverage census uses: it does not deserialize an
/// entry, so a record whose effect class is *not* declared — or one that does
/// not verify — is still census-able. Coverage and integrity are separate
/// deliverables.
#[must_use]
pub fn segment_indices(config: &AuditConfig) -> Vec<u32> {
    let mut indices: Vec<u32> = Vec::new();
    let Ok(entries) = fs::read_dir(config.segments_dir()) else {
        return indices;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if let Ok(index) = stem.parse::<u32>() {
            indices.push(index);
        }
    }
    indices.sort_unstable();
    indices
}

/// Reads one segment's stored lines as raw text, without deserializing them.
///
/// # Errors
/// Returns [`AuditError`] when the segment file cannot be read.
pub fn read_segment_lines(config: &AuditConfig, index: u32) -> Result<Vec<String>, AuditError> {
    let path = config.segment_path(index);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AuditError::io(&path, &error)),
    };
    Ok(content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect())
}

/// Reads `roots.jsonl`.
pub fn read_roots(config: &AuditConfig) -> Result<Vec<RootRecord>, AuditError> {
    let path = config.roots_path();
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AuditError::io(&path, &error)),
    };
    let mut out = Vec::new();
    for (index, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let record = serde_json::from_str::<RootRecord>(line).map_err(|error| {
            AuditError::Config(format!(
                "audit root record {} in {} is not valid: {error}",
                index + 1,
                path.display()
            ))
        })?;
        out.push(record);
    }
    Ok(out)
}

fn append_line(path: &Path, entry: &impl ToLine) -> Result<(), AuditError> {
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .map_err(|error| AuditError::io(path, &error))?;
    file.write_all(entry.to_line().as_bytes())
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_data())
        .map_err(|error| AuditError::io(path, &error))
}

/// One line of canonical bytes to append to a store file.
pub trait ToLine {
    /// Returns the newline-terminated line.
    fn to_line(&self) -> String;
}

impl ToLine for AuditEntry {
    fn to_line(&self) -> String {
        AuditEntry::to_line(self)
    }
}

impl ToLine for RootRecord {
    fn to_line(&self) -> String {
        RootRecord::to_line(self)
    }
}

fn count_lines(path: &Path) -> Result<u32, AuditError> {
    let content = fs::read(path).map_err(|error| AuditError::io(path, &error))?;
    Ok(content.iter().filter(|byte| **byte == b'\n').count() as u32)
}

/// UTC epoch milliseconds, saturating at zero before the epoch.
#[must_use]
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::EntryKind;
    use tempfile::TempDir;

    pub(crate) struct Fixture {
        pub dir: TempDir,
        pub config: AuditConfig,
    }

    impl Fixture {
        pub(crate) fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let config = AuditConfig {
                root: dir.path().join("audit"),
                segment_max_entries: 3,
                ..AuditConfig::default()
            };
            Self { dir, config }
        }
    }

    fn record(kind: EntryKind, action: &str) -> AuditRecord {
        AuditRecord::new("ses_1", kind)
            .with_actor(Actor::Agent)
            .with_action(action)
            .with_outcome(Outcome::Ok)
    }

    #[test]
    fn appends_are_chained_and_sequenced() {
        let fixture = Fixture::new();
        let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
        let first = log
            .append_at(record(EntryKind::Run, "turn_start"), 1)
            .unwrap();
        assert_eq!(first.seq, 0);
        assert_eq!(first.prev_hash, GENESIS_PREV_HASH);
        let second = log
            .append_at(record(EntryKind::Step, "step_start"), 2)
            .unwrap();
        assert_eq!(second.seq, 1);
        assert_eq!(second.prev_hash, first.entry_hash);
        assert_eq!(log.entries().unwrap().len(), 2);
    }

    #[test]
    fn the_chain_tip_is_derived_from_disk_after_reopen() {
        let fixture = Fixture::new();
        {
            let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
            log.append_at(record(EntryKind::Run, "turn_start"), 1)
                .unwrap();
            log.append_at(record(EntryKind::Run, "turn_end"), 2)
                .unwrap();
        }
        let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
        assert_eq!(log.head().next_seq, 2);
        let next = log.append_at(record(EntryKind::Run, "next"), 3).unwrap();
        assert_eq!(next.seq, 2);
    }

    #[test]
    fn rollover_seals_a_segment_and_anchors_its_signed_root() {
        let fixture = Fixture::new();
        let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
        for index in 0..4 {
            log.append_at(record(EntryKind::Step, "step"), index as i64 + 1)
                .unwrap();
        }
        let segments = read_segments(&fixture.config).unwrap();
        assert_eq!(
            segments.len(),
            2,
            "3-entry segments must roll over at 4 entries"
        );
        assert_eq!(segments[0].entries.len(), 3);
        assert_eq!(segments[1].entries.len(), 1);
        // The chain crosses the segment boundary.
        assert_eq!(
            segments[1].entries[0].prev_hash,
            segments[0].entries[2].entry_hash
        );
        let roots = log.roots().unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].segment, 0);
        assert_eq!(roots[0].count, 3);
        assert!(roots[0].signature_ok(log.device_key()));
        let anchored = log.sink_path().unwrap();
        let sink = AnchorSink::open(anchored).unwrap();
        assert_eq!(sink.read_roots().unwrap().len(), 1);
    }

    #[test]
    fn finish_turn_seals_and_anchors() {
        let fixture = Fixture::new();
        let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
        log.append_at(record(EntryKind::Run, "turn_start"), 1)
            .unwrap();
        let sealed = log.finish_turn().unwrap();
        assert!(sealed.is_some());
        assert_eq!(log.head().anchored, vec![0]);
        // Nothing left to seal or anchor.
        assert!(log.finish_turn().unwrap().is_none());
    }

    #[test]
    fn a_truncated_tail_is_repaired_and_noted() {
        let fixture = Fixture::new();
        {
            let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
            log.append_at(record(EntryKind::Run, "turn_start"), 1)
                .unwrap();
            log.append_at(record(EntryKind::Run, "turn_end"), 2)
                .unwrap();
        }
        let path = fixture.config.segment_path(0);
        let mut raw = fs::read_to_string(&path).unwrap();
        raw.push_str("{\"seq\":2,\"ts\":3,\"sess");
        fs::write(&path, raw).unwrap();

        let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
        let entries = log.entries().unwrap();
        assert_eq!(entries.len(), 3, "the repair note is a new entry");
        assert_eq!(entries[2].action.as_deref(), Some("tail_repair"));
        assert_eq!(
            entries[2]
                .meta
                .get("truncated_bytes")
                .and_then(|v| v.as_int()),
            Some(21)
        );
    }

    #[test]
    fn a_head_that_claims_more_entries_than_exist_fails_closed() {
        let fixture = Fixture::new();
        {
            let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
            log.append_at(record(EntryKind::Run, "turn_start"), 1)
                .unwrap();
        }
        let head_path = fixture.config.head_path();
        let mut head: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&head_path).unwrap()).unwrap();
        head["next_seq"] = serde_json::json!(9);
        fs::write(&head_path, serde_json::to_string(&head).unwrap()).unwrap();

        let error = AuditLog::open(fixture.config.clone(), &[]).unwrap_err();
        assert!(matches!(error, AuditError::StateMismatch { .. }), "{error}");
    }

    #[test]
    fn a_read_only_store_refuses_appends() {
        let fixture = Fixture::new();
        {
            let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
            log.append_at(record(EntryKind::Run, "turn_start"), 1)
                .unwrap();
        }
        let log = AuditLog::open_read_only(fixture.config.clone()).unwrap();
        assert!(log.append(record(EntryKind::Run, "x")).is_err());
        assert_eq!(log.entries().unwrap().len(), 1);
    }

    #[test]
    fn a_missing_segment_gap_fails_closed() {
        let fixture = Fixture::new();
        {
            let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
            for index in 0..4 {
                log.append_at(record(EntryKind::Step, "step"), index as i64 + 1)
                    .unwrap();
            }
        }
        fs::remove_file(fixture.config.segment_path(0)).unwrap();
        let error = AuditLog::open(fixture.config.clone(), &[]).unwrap_err();
        assert!(matches!(error, AuditError::Config(_)), "{error}");
        // The gap is also visible to a reader, which is what `verify` reports.
        let segments = read_segments(&fixture.config).unwrap();
        assert_eq!(crate::store::indices_with_gaps(&segments), vec![0]);
    }

    #[test]
    fn a_configured_but_unreachable_sink_fails_closed_at_open() {
        let fixture = Fixture::new();
        let blocker = fixture.dir.path().join("blocker");
        fs::write(&blocker, b"x").unwrap();
        let config = AuditConfig {
            anchor: crate::anchor::AnchorConfig {
                sink_path: Some(blocker.join("roots.jsonl")),
                ..crate::anchor::AnchorConfig::default()
            },
            ..fixture.config.clone()
        };
        let error = AuditLog::open(config, &[]).unwrap_err();
        assert!(
            matches!(error, AuditError::SinkUnreachable { .. }),
            "{error}"
        );
        assert!(
            !fixture.config.segments_dir().exists(),
            "a refused store must not create a chain to write into"
        );
    }

    #[test]
    fn the_default_posture_is_a_signed_local_sink() {
        let fixture = Fixture::new();
        let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
        assert_eq!(log.level(), AnchorLevelName::LocalSink);
        assert!(
            log.sink_path()
                .is_some_and(|path| !path.starts_with(&fixture.config.root))
        );
    }
}
