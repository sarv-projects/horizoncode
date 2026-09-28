//! The segmented log: append, rotation, seals, committed head, and streaming
//! replay (`DEC-055`, `ARCH/07` §Append, rotation, and replay contract).
//!
//! Layout under one stream root:
//!
//! ```text
//! <root>/lock                      writer lock (OS advisory, held for the handle's life)
//! <root>/head.json                 the committed head
//! <root>/segments/00000000.jsonl   event rows, one canonical JSON line each
//! <root>/segments/00000000.seal.json
//! ```
//!
//! Ordering rules, which the crash tests pin:
//!
//! 1. An append writes the event line, synchronizes it under the durability
//!    profile, and only then replaces and synchronizes the head. Bytes beyond
//!    the head are therefore uncommitted by construction and are preserved and
//!    reported, never silently folded into replay or truncated.
//! 2. Rotation writes and synchronizes the seal **before** the successor
//!    segment receives a record, so a seal can never claim less than what was
//!    committed.
//! 3. A new segment file and the head rename are made durable through the
//!    backend before the append is acknowledged (`DEC-057`).
//!
//! Replay validates the head first (including its schema version), then walks
//! segments in order with a bounded line reader, so a corrupt or oversized
//! record cannot force a whole-log allocation.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Seek as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use horizoncode_config::LogLimits;

use crate::durability::{CommitSink, DurabilityProfile, std_sink};
use crate::envelope::{EventRecord, RecordSpec, genesis_digest};
use crate::error::LogError;
use crate::head::{CommittedLogHead, HeadState, check_version, read_head, write_head};
use crate::segment::{ContentHasher, SegmentSeal, SegmentSummary, genesis_segment_digest};

/// The subdirectory holding segments and seals.
pub const SEGMENTS_DIR: &str = "segments";

/// The writer lock file name inside the stream root.
pub const LOCK_FILE: &str = "lock";

/// One acknowledged commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Committed {
    /// The assigned sequence.
    pub seq: u64,
    /// The committed event digest.
    pub event_digest: String,
}

/// What a replay validated and visited.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReplayReport {
    /// Committed events visited.
    pub events: u64,
    /// Segments read.
    pub segments: u32,
    /// Bytes beyond the committed head that were preserved, not replayed.
    pub uncommitted_tail_bytes: u64,
}

/// The open active segment.
#[derive(Debug)]
struct Active {
    index: u32,
    file: File,
    hasher: ContentHasher,
    events: u64,
    bytes: u64,
    first_seq: u64,
    first_digest: String,
    last_seq: u64,
    last_digest: String,
}

/// A bounded, digest-linked segmented event log for one owner.
#[derive(Debug)]
pub struct EventLog {
    root: PathBuf,
    owner_kind: String,
    owner_id: String,
    limits: LogLimits,
    profile: DurabilityProfile,
    sink: Arc<dyn CommitSink>,
    _lock: File,
    generation: u64,
    next_seq: u64,
    previous_digest: String,
    sealed: u32,
    sealed_digest: String,
    active: Option<Active>,
    committed_bytes: u64,
    uncommitted_tail: u64,
}

impl EventLog {
    /// Opens (or creates) the stream at `root` for one owner and takes the
    /// writer lock.
    ///
    /// A stream that has segments but no readable head is refused: recovery of
    /// an uncommitted tail is an explicit operation (`AX-311`), never a side
    /// effect of opening.
    ///
    /// # Errors
    /// Returns [`LogError`] for a lock held elsewhere, an unusable head, a
    /// failed durability contract, or I/O failure.
    pub fn open(
        root: impl Into<PathBuf>,
        owner_kind: &str,
        owner_id: &str,
        limits: LogLimits,
        profile: DurabilityProfile,
    ) -> Result<Self, LogError> {
        Self::open_with_sink(root, owner_kind, owner_id, limits, profile, std_sink())
    }

    /// [`EventLog::open`] with an explicit durability backend.
    ///
    /// # Errors
    /// As [`EventLog::open`].
    pub fn open_with_sink(
        root: impl Into<PathBuf>,
        owner_kind: &str,
        owner_id: &str,
        limits: LogLimits,
        profile: DurabilityProfile,
        sink: Arc<dyn CommitSink>,
    ) -> Result<Self, LogError> {
        let root = root.into();
        if profile == DurabilityProfile::RunDurable && !sink.supports_run_durable() {
            return Err(LogError::DurabilityRefused {
                detail: "this backend cannot provide the run_durable contract".to_owned(),
            });
        }
        fs::create_dir_all(root.join(SEGMENTS_DIR)).map_err(|error| LogError::io(&root, &error))?;
        if profile == DurabilityProfile::RunDurable {
            sink.sync_dir(&root)
                .map_err(|error| LogError::DurabilityRefused {
                    detail: error.to_string(),
                })?;
        }

        let lock_path = root.join(LOCK_FILE);
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|error| LogError::io(&lock_path, &error))?;
        lock.try_lock()
            .map_err(|_| LogError::Locked { root: root.clone() })?;

        let mut log = Self {
            root,
            owner_kind: owner_kind.to_owned(),
            owner_id: owner_id.to_owned(),
            limits,
            profile,
            sink,
            _lock: lock,
            generation: 0,
            next_seq: 0,
            previous_digest: genesis_digest(),
            sealed: 0,
            sealed_digest: genesis_segment_digest(),
            active: None,
            committed_bytes: 0,
            uncommitted_tail: 0,
        };
        log.resume()?;
        Ok(log)
    }

    /// Returns the stream root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Returns the effective limits.
    #[must_use]
    pub fn limits(&self) -> LogLimits {
        self.limits
    }

    /// Returns the durability profile.
    #[must_use]
    pub fn profile(&self) -> DurabilityProfile {
        self.profile
    }

    /// Returns the next sequence the log will assign.
    #[must_use]
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// Returns the committed event bytes across all segments.
    #[must_use]
    pub fn committed_bytes(&self) -> u64 {
        self.committed_bytes
    }

    /// Returns the bytes beyond the committed head, if any.
    #[must_use]
    pub fn uncommitted_tail_bytes(&self) -> u64 {
        self.uncommitted_tail
    }

    /// Returns the recovery generation.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Appends one event and acknowledges it only after it is committed under
    /// the durability profile.
    ///
    /// # Errors
    /// Returns [`LogError::EventTooLarge`] or [`LogError::StreamFull`] before
    /// writing, [`LogError::UncommittedTail`] while a tail is unreconciled, and
    /// I/O or durability errors otherwise.
    pub fn append(&mut self, spec: RecordSpec) -> Result<Committed, LogError> {
        if self.uncommitted_tail > 0 {
            let segment = self.active.as_ref().map_or(0, |active| active.index);
            return Err(LogError::UncommittedTail {
                segment,
                bytes: self.uncommitted_tail,
            });
        }
        let record = EventRecord::new(spec, self.next_seq, &self.previous_digest)?;
        let line = record.to_line()?;
        let bytes = line.len() as u64 + 1;
        if bytes > self.limits.max_event_bytes {
            return Err(LogError::EventTooLarge {
                bytes,
                limit: self.limits.max_event_bytes,
            });
        }
        if self.committed_bytes.saturating_add(bytes) > self.limits.max_stream_event_bytes {
            return Err(LogError::StreamFull {
                limit: self.limits.max_stream_event_bytes,
            });
        }

        if let Some(active) = &self.active {
            let would_rotate = active.events > 0
                && (active.bytes + bytes > self.limits.max_segment_bytes
                    || active.events + 1 > self.limits.max_segment_events);
            if would_rotate {
                self.seal_active()?;
            }
        }
        if self.active.is_none() {
            self.start_segment()?;
        }

        let active = self.active.as_mut().expect("an active segment exists");
        active
            .file
            .write_all(line.as_bytes())
            .and_then(|()| active.file.write_all(b"\n"))
            .map_err(|error| LogError::io(&segment_path(&self.root, active.index), &error))?;
        if self.profile == DurabilityProfile::RunDurable {
            self.sink
                .sync_file(&active.file)
                .map_err(|error| LogError::DurabilityRefused {
                    detail: error.to_string(),
                })?;
        }
        active.hasher.update_line(&line);
        if active.events == 0 {
            active.first_seq = record.seq;
            active.first_digest = record.event_digest.clone();
        }
        active.events += 1;
        active.bytes += bytes;
        active.last_seq = record.seq;
        active.last_digest = record.event_digest.clone();

        self.committed_bytes = self.committed_bytes.saturating_add(bytes);
        self.next_seq = record.seq.saturating_add(1);
        self.previous_digest = record.event_digest.clone();
        self.write_commit_head(record.seq, &record.event_digest)?;
        Ok(Committed {
            seq: record.seq,
            event_digest: record.event_digest,
        })
    }

    /// Validates and streams the committed events in order.
    ///
    /// The visitor sees one event at a time; nothing whole-log is allocated,
    /// and a record whose line exceeds the record ceiling is refused before it
    /// is decoded.
    ///
    /// # Errors
    /// Returns [`LogError::UnsupportedVersion`] before reading any segment when
    /// the head is newer, [`LogError::Corrupt`] on a broken chain, and
    /// [`LogError::Visitor`] when the visitor fails.
    pub fn replay<F>(&self, mut visit: F) -> Result<ReplayReport, LogError>
    where
        F: FnMut(&EventRecord) -> Result<(), LogError>,
    {
        let head = match read_head(&self.root.join(crate::head::HEAD_FILE)) {
            HeadState::Absent => None,
            HeadState::Present(head) => Some(head),
            HeadState::Malformed { detail } => {
                return Err(LogError::HeadMalformed {
                    path: self.root.join(crate::head::HEAD_FILE),
                    detail,
                });
            }
            HeadState::Unreadable { detail } => {
                return Err(LogError::HeadUnreadable {
                    path: self.root.join(crate::head::HEAD_FILE),
                    detail,
                });
            }
        };
        let Some(head) = head else {
            return Ok(ReplayReport::default());
        };
        check_version(&head)?;

        let mut expected_seq = 0u64;
        let mut expected_previous = genesis_digest();
        let mut report = ReplayReport::default();
        let highest = segment_indices(&self.root)
            .last()
            .copied()
            .unwrap_or(head.committed_segment);
        for index in 0..=highest {
            let path = segment_path(&self.root, index);
            if !path.is_file() {
                return Err(LogError::corrupt(index, "the segment file is missing"));
            }
            let sealed = index < self.sealed;
            let seal = if sealed {
                Some(self.read_seal(index)?)
            } else {
                None
            };
            let (visited, tail) = self.replay_segment(
                index,
                &head,
                &mut expected_seq,
                &mut expected_previous,
                &mut visit,
            )?;
            report.events += visited;
            report.uncommitted_tail_bytes += tail;
            report.segments += 1;
            if let Some(seal) = seal {
                let first_seq = expected_seq - visited;
                self.verify_seal(&seal, index, first_seq, visited)?;
            }
            if visited == 0 && tail == 0 && index < highest {
                return Err(LogError::corrupt(index, "an interior segment is empty"));
            }
        }
        if expected_seq != head.committed_seq.saturating_add(1) {
            return Err(LogError::corrupt(
                head.committed_segment,
                format!(
                    "the head acknowledges sequence {} but {} committed events were found",
                    head.committed_seq, expected_seq
                ),
            ));
        }
        if expected_previous != head.committed_event_digest {
            return Err(LogError::corrupt(
                head.committed_segment,
                "the last committed event does not match the head digest".to_owned(),
            ));
        }
        Ok(report)
    }

    fn resume(&mut self) -> Result<(), LogError> {
        let head_path = self.root.join(crate::head::HEAD_FILE);
        let head = match read_head(&head_path) {
            HeadState::Absent => None,
            HeadState::Present(head) => Some(*head),
            HeadState::Malformed { detail } => {
                return Err(LogError::HeadMalformed {
                    path: head_path,
                    detail,
                });
            }
            HeadState::Unreadable { detail } => {
                return Err(LogError::HeadUnreadable {
                    path: head_path,
                    detail,
                });
            }
        };

        let indices = segment_indices(&self.root);
        let seal_indices = seal_indices(&self.root);
        let Some(head) = head else {
            if !indices.is_empty() || !seal_indices.is_empty() {
                return Err(LogError::HeadMissing {
                    root: self.root.clone(),
                });
            }
            return Ok(());
        };
        check_version(&head)?;
        if head.owner_kind != self.owner_kind || head.owner_id != self.owner_id {
            return Err(LogError::OwnerMismatch {
                expected: format!("{} {}", self.owner_kind, self.owner_id),
                found: format!("{} {}", head.owner_kind, head.owner_id),
            });
        }

        // Sealed segments must be contiguous from 0.
        for (position, index) in seal_indices.iter().enumerate() {
            if *index != position as u32 {
                return Err(LogError::corrupt(
                    *index,
                    "sealed segments are not contiguous from 0",
                ));
            }
        }
        self.sealed = seal_indices.len() as u32;
        if let Some(last) = seal_indices.last() {
            let seal = self.read_seal(*last)?;
            self.sealed_digest = seal.segment_digest.clone();
        }
        let unsealed: Vec<u32> = indices
            .iter()
            .copied()
            .filter(|index| !seal_indices.contains(index))
            .collect();
        if unsealed.len() > 1 {
            return Err(LogError::corrupt(
                unsealed[1],
                "more than one segment is unsealed",
            ));
        }

        self.generation = head.generation;
        self.next_seq = head.committed_seq.saturating_add(1);
        self.previous_digest = head.committed_event_digest.clone();

        // Account for sealed bytes without reading them.
        for index in &seal_indices {
            let path = segment_path(&self.root, *index);
            let size = fs::metadata(&path)
                .map_err(|error| LogError::io(&path, &error))?
                .len();
            self.committed_bytes = self.committed_bytes.saturating_add(size);
        }

        match unsealed.first().copied() {
            Some(index) => self.resume_active(index, &head)?,
            None => {
                // The tip must be in the last sealed segment.
                if self.sealed == 0 || head.committed_segment + 1 != self.sealed {
                    return Err(LogError::corrupt(
                        head.committed_segment,
                        "the head names a segment that is neither sealed nor active",
                    ));
                }
                let seal = self.read_seal(head.committed_segment)?;
                if seal.last_seq != head.committed_seq
                    || seal.last_event_digest != head.committed_event_digest
                {
                    return Err(LogError::corrupt(
                        head.committed_segment,
                        "the head disagrees with its segment seal",
                    ));
                }
            }
        }
        Ok(())
    }

    fn resume_active(&mut self, index: u32, head: &CommittedLogHead) -> Result<(), LogError> {
        if index != head.committed_segment {
            return Err(LogError::corrupt(
                index,
                "the active segment is not the one the head names",
            ));
        }
        let path = segment_path(&self.root, index);
        let file = OpenOptions::new()
            .read(true)
            .append(true)
            .open(&path)
            .map_err(|error| LogError::io(&path, &error))?;
        let mut reader = BufReader::new(
            OpenOptions::new()
                .read(true)
                .open(&path)
                .map_err(|error| LogError::io(&path, &error))?,
        );
        let expected_previous = if index == 0 {
            genesis_digest()
        } else {
            self.read_seal(index - 1)?.last_event_digest
        };
        let mut hasher = ContentHasher::new();
        let mut buffer = Vec::new();
        let mut expected_seq = if index == 0 {
            0
        } else {
            self.read_seal(index - 1)?.last_seq.saturating_add(1)
        };
        let mut previous = expected_previous;
        let mut active = Active {
            index,
            file,
            hasher: ContentHasher::new(),
            events: 0,
            bytes: 0,
            first_seq: 0,
            first_digest: String::new(),
            last_seq: 0,
            last_digest: String::new(),
        };
        loop {
            buffer.clear();
            let read = reader
                .read_until(b'\n', &mut buffer)
                .map_err(|error| LogError::io(&path, &error))?;
            if read == 0 {
                break;
            }
            if buffer.len() as u64 > self.limits.max_event_bytes + 1 {
                if expected_seq > head.committed_seq {
                    self.uncommitted_tail = tail_from_line_start(&mut reader, &path, read)?;
                    break;
                }
                return Err(LogError::corrupt(
                    index,
                    "a stored line exceeds the record ceiling",
                ));
            }
            let raw = match std::str::from_utf8(&buffer) {
                Ok(raw) => raw.trim_end_matches('\n').to_owned(),
                Err(_) => {
                    if expected_seq > head.committed_seq {
                        self.uncommitted_tail = tail_from_line_start(&mut reader, &path, read)?;
                        break;
                    }
                    return Err(LogError::corrupt(index, "a stored line is not UTF-8"));
                }
            };
            let record = match EventRecord::from_line(&raw) {
                Ok(record) => record,
                Err(error) => {
                    // Past the committed head, unparseable bytes are the
                    // preserved tail of an interrupted write, not corruption.
                    if expected_seq > head.committed_seq {
                        self.uncommitted_tail = tail_from_line_start(&mut reader, &path, read)?;
                        break;
                    }
                    return Err(LogError::corrupt(index, error.to_string()));
                }
            };
            if record.seq > head.committed_seq {
                // A complete but uncommitted line: everything from here on is
                // the preserved tail.
                self.uncommitted_tail = tail_from_line_start(&mut reader, &path, read)?;
                break;
            }
            record
                .verify(expected_seq, &previous)
                .map_err(|error| LogError::corrupt(index, error.to_string()))?;
            if active.events == 0 {
                active.first_seq = record.seq;
                active.first_digest = record.event_digest.clone();
            }
            hasher.update_line(&raw);
            active.events += 1;
            active.bytes += read as u64;
            active.last_seq = record.seq;
            active.last_digest = record.event_digest.clone();
            expected_seq = record.seq.saturating_add(1);
            previous = record.event_digest;
            if record.seq == head.committed_seq {
                self.uncommitted_tail = tail_after_current_line(&mut reader, &path)?;
                break;
            }
        }
        if active.events == 0 {
            // An empty or fully uncommitted segment. The head must then be in
            // the sealed range, and the file stays active for the next append.
            if head.committed_seq >= expected_seq && self.sealed == 0 {
                return Err(LogError::corrupt(
                    index,
                    "the head names a sequence that is not stored",
                ));
            }
        } else if previous != head.committed_event_digest {
            return Err(LogError::corrupt(
                index,
                "the committed prefix does not match the head digest",
            ));
        } else if hasher.digest() != head.committed_segment_digest {
            return Err(LogError::corrupt(
                index,
                "the committed prefix does not match the head segment digest",
            ));
        }
        active.hasher = hasher;
        self.active = Some(active);
        Ok(())
    }

    fn start_segment(&mut self) -> Result<(), LogError> {
        let index = self.sealed;
        let path = segment_path(&self.root, index);
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .append(true)
            .open(&path)
            .map_err(|error| LogError::io(&path, &error))?;
        if self.profile == DurabilityProfile::RunDurable {
            self.sink
                .sync_file(&file)
                .and_then(|()| self.sink.sync_dir(&self.root.join(SEGMENTS_DIR)))
                .map_err(|error| LogError::DurabilityRefused {
                    detail: error.to_string(),
                })?;
        }
        self.active = Some(Active {
            index,
            file,
            hasher: ContentHasher::new(),
            events: 0,
            bytes: 0,
            first_seq: 0,
            first_digest: String::new(),
            last_seq: 0,
            last_digest: String::new(),
        });
        Ok(())
    }

    fn seal_active(&mut self) -> Result<(), LogError> {
        let Some(active) = self.active.take() else {
            return Ok(());
        };
        if active.events == 0 {
            self.active = Some(active);
            return Ok(());
        }
        let seal = SegmentSeal::from_summary(
            active.index,
            SegmentSummary {
                first_seq: active.first_seq,
                last_seq: active.last_seq,
                event_count: active.events,
                encoded_bytes: active.bytes,
                first_event_digest: active.first_digest,
                last_event_digest: active.last_digest,
            },
            self.sealed_digest.clone(),
        );
        let path = seal_path(&self.root, active.index);
        let line = serde_json::to_string(&seal)
            .map_err(|error| LogError::encode(&path, error.to_string()))?;
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .map_err(|error| LogError::io(&path, &error))?;
        file.write_all(line.as_bytes())
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|error| LogError::io(&path, &error))?;
        if self.profile == DurabilityProfile::RunDurable {
            self.sink
                .sync_dir(&self.root.join(SEGMENTS_DIR))
                .map_err(|error| LogError::DurabilityRefused {
                    detail: error.to_string(),
                })?;
        }
        self.sealed = active.index.saturating_add(1);
        self.sealed_digest = seal.segment_digest;
        Ok(())
    }

    fn write_commit_head(&self, seq: u64, digest: &str) -> Result<(), LogError> {
        let active = self.active.as_ref().expect("an active segment exists");
        let head = CommittedLogHead {
            schema_version: crate::CURRENT_SCHEMA_VERSION,
            owner_kind: self.owner_kind.clone(),
            owner_id: self.owner_id.clone(),
            generation: self.generation,
            committed_seq: seq,
            committed_event_digest: digest.to_owned(),
            committed_segment: active.index,
            committed_segment_digest: active.hasher.digest(),
            durability_profile: self.profile.as_str().to_owned(),
            updated_at: now_ms(),
        };
        let path = self.root.join(crate::head::HEAD_FILE);
        write_head(&path, &head)?;
        if self.profile == DurabilityProfile::RunDurable {
            self.sink
                .sync_dir(&self.root)
                .map_err(|error| LogError::DurabilityRefused {
                    detail: error.to_string(),
                })?;
        }
        Ok(())
    }

    #[allow(clippy::type_complexity)]
    fn replay_segment<F>(
        &self,
        index: u32,
        head: &CommittedLogHead,
        expected_seq: &mut u64,
        expected_previous: &mut String,
        visit: &mut F,
    ) -> Result<(u64, u64), LogError>
    where
        F: FnMut(&EventRecord) -> Result<(), LogError>,
    {
        let path = segment_path(&self.root, index);
        let mut reader =
            BufReader::new(File::open(&path).map_err(|error| LogError::io(&path, &error))?);
        let mut buffer = Vec::new();
        let mut visited = 0u64;
        let mut tail = 0u64;
        loop {
            buffer.clear();
            let read = reader
                .read_until(b'\n', &mut buffer)
                .map_err(|error| LogError::io(&path, &error))?;
            if read == 0 {
                break;
            }
            if buffer.len() as u64 > self.limits.max_event_bytes + 1 {
                if *expected_seq > head.committed_seq {
                    tail += tail_from_line_start(&mut reader, &path, read)?;
                    break;
                }
                return Err(LogError::corrupt(
                    index,
                    "a stored line exceeds the record ceiling",
                ));
            }
            let parsed = std::str::from_utf8(&buffer)
                .map_err(|_| "a stored line is not UTF-8".to_owned())
                .and_then(|line| {
                    EventRecord::from_line(line.trim_end_matches('\n')).map_err(|e| e.to_string())
                });
            let record = match parsed {
                Ok(record) => record,
                Err(detail) => {
                    if *expected_seq > head.committed_seq {
                        tail += tail_from_line_start(&mut reader, &path, read)?;
                        break;
                    }
                    return Err(LogError::corrupt(index, detail));
                }
            };
            if record.seq > head.committed_seq {
                tail += tail_from_line_start(&mut reader, &path, read)?;
                break;
            }
            record
                .verify(*expected_seq, expected_previous)
                .map_err(|error| LogError::corrupt(index, error.to_string()))?;
            visit(&record)?;
            visited += 1;
            *expected_seq = record.seq.saturating_add(1);
            *expected_previous = record.event_digest.clone();
            if record.seq == head.committed_seq {
                tail += tail_after_current_line(&mut reader, &path)?;
                break;
            }
        }
        Ok((visited, tail))
    }

    fn read_seal(&self, index: u32) -> Result<SegmentSeal, LogError> {
        let path = seal_path(&self.root, index);
        let text = fs::read_to_string(&path).map_err(|error| LogError::io(&path, &error))?;
        let seal: SegmentSeal = serde_json::from_str(&text)
            .map_err(|error| LogError::corrupt(index, error.to_string()))?;
        if !seal.verifies() {
            return Err(LogError::SealMismatch {
                segment: index,
                detail: "the seal digest does not match its body".to_owned(),
            });
        }
        Ok(seal)
    }

    fn verify_seal(
        &self,
        seal: &SegmentSeal,
        index: u32,
        first_seq: u64,
        visited: u64,
    ) -> Result<(), LogError> {
        if seal.segment != index
            || seal.first_seq != first_seq
            || seal.event_count != visited
            || seal.last_seq.saturating_add(1) != first_seq.saturating_add(visited)
        {
            return Err(LogError::SealMismatch {
                segment: index,
                detail: "the seal does not cover the segment's committed events".to_owned(),
            });
        }
        Ok(())
    }
}

/// Bytes from the current line's **start** to the end of the file: this line and
/// everything after it are an uncommitted tail.
fn tail_from_line_start(
    reader: &mut BufReader<File>,
    path: &Path,
    read: usize,
) -> Result<u64, LogError> {
    let position = reader
        .stream_position()
        .map_err(|error| LogError::io(path, &error))?;
    let total = fs::metadata(path)
        .map_err(|error| LogError::io(path, &error))?
        .len();
    Ok(total.saturating_sub(position.saturating_sub(read as u64)))
}

/// Bytes **after** the current line: the line is the committed head, so only
/// what follows it is uncommitted.
fn tail_after_current_line(reader: &mut BufReader<File>, path: &Path) -> Result<u64, LogError> {
    let position = reader
        .stream_position()
        .map_err(|error| LogError::io(path, &error))?;
    let total = fs::metadata(path)
        .map_err(|error| LogError::io(path, &error))?
        .len();
    Ok(total.saturating_sub(position))
}

fn segment_path(root: &Path, index: u32) -> PathBuf {
    root.join(SEGMENTS_DIR).join(format!("{index:08}.jsonl"))
}

fn seal_path(root: &Path, index: u32) -> PathBuf {
    root.join(SEGMENTS_DIR)
        .join(format!("{index:08}.seal.json"))
}

fn segment_indices(root: &Path) -> Vec<u32> {
    list_indices(root, ".jsonl")
}

fn seal_indices(root: &Path) -> Vec<u32> {
    list_indices(root, ".seal.json")
}

fn list_indices(root: &Path, suffix: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root.join(SEGMENTS_DIR)) else {
        return out;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(stem) = name.strip_suffix(suffix) else {
            continue;
        };
        if let Ok(index) = stem.parse::<u32>() {
            out.push(index);
        }
    }
    out.sort_unstable();
    out
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
