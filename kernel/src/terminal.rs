//! Bounded, generation-scoped terminal state primitives used by `terminal.v1`.
//!
//! Process creation and Guard admission are deliberately not inferred by these data
//! structures: a caller must supply an admitted grant and an authenticated attachment.

use crate::messagepack::{self, FRAME_LIMITS, Value};
use crate::protocol::{CursorV1, ErrorCategoryV1, RetryClassV1, TypedErrorV1};
use std::collections::{BTreeMap, VecDeque};

pub const REPLAY_CAPACITY: usize = 2 * 1024 * 1024;
pub const MAX_OUTPUT_FRAME: usize = 64 * 1024;
pub const MAX_INPUT_FRAME: usize = 16 * 1024;
pub const MAX_INTERACTIVE_GRANT_MS: u64 = 60 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalError {
    Denied,
    ApprovalRequired,
    GrantExpired,
    StaleGeneration,
    StaleSequence,
    BadFrame,
    TooLarge,
    TimeoutLimit,
    Unavailable,
    OutputLimit,
    OwnerLost,
    Unknown,
}

impl TerminalError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Denied => "DENIED",
            Self::ApprovalRequired => "APPROVAL_REQUIRED",
            Self::GrantExpired => "GRANT_EXPIRED",
            Self::StaleGeneration => "STALE_GENERATION",
            Self::StaleSequence => "STALE_SEQUENCE",
            Self::BadFrame => "BAD_FRAME",
            Self::TooLarge => "TOO_LARGE",
            Self::TimeoutLimit => "TIMEOUT_LIMIT",
            Self::Unavailable => "UNAVAILABLE",
            Self::OutputLimit => "OUTPUT_LIMIT",
            Self::OwnerLost => "OWNER_LOST",
            Self::Unknown => "UNKNOWN",
        }
    }

    pub fn typed_error(&self) -> TypedErrorV1 {
        let category = match self {
            Self::Denied => ErrorCategoryV1::Authorization,
            Self::ApprovalRequired => ErrorCategoryV1::Capability,
            Self::GrantExpired | Self::StaleGeneration | Self::StaleSequence => {
                ErrorCategoryV1::Conflict
            }
            Self::BadFrame | Self::TooLarge | Self::TimeoutLimit => ErrorCategoryV1::Validation,
            Self::Unavailable | Self::OutputLimit => ErrorCategoryV1::Unavailable,
            Self::OwnerLost | Self::Unknown => ErrorCategoryV1::Uncertain,
        };
        TypedErrorV1 {
            code: self.code().to_owned(),
            category,
            message: "terminal request could not be admitted or completed".to_owned(),
            retry_class: RetryClassV1::Never,
            retry_after_ms: None,
            owner_cursor: None,
            subject_ids: Vec::new(),
            details: None,
        }
    }
}

/// Immutable grant binding: all values are checked on every continuation operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InteractiveGrantV1 {
    pub grant_id: String,
    pub principal: String,
    pub host_id: String,
    pub location_id: String,
    pub terminal_id: String,
    pub launch_digest: String,
    pub config_digest: String,
    pub backend: String,
    pub owner_epoch: u64,
    pub fence_generation: u64,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

impl InteractiveGrantV1 {
    pub fn validate(
        &self,
        now_ms: u64,
        owner_epoch: u64,
        fence_generation: u64,
    ) -> Result<(), TerminalError> {
        let duration = self
            .expires_at_ms
            .checked_sub(self.issued_at_ms)
            .ok_or(TerminalError::BadFrame)?;
        if duration == 0 || duration > MAX_INTERACTIVE_GRANT_MS {
            return Err(TerminalError::BadFrame);
        }
        if now_ms >= self.expires_at_ms {
            return Err(TerminalError::GrantExpired);
        }
        if self.owner_epoch != owner_epoch || self.fence_generation != fence_generation {
            return Err(TerminalError::OwnerLost);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayChunk {
    pub generation: u64,
    pub sequence: u64,
    pub byte_cursor: u64,
    pub kind: String,
    pub payload: Vec<u8>,
}

impl ReplayChunk {
    /// The event payload used both on the wire and in the canonical cursor digest.
    pub fn event_payload(&self) -> Result<Value, TerminalError> {
        match self.kind.as_str() {
            "exit" => {
                let code = std::str::from_utf8(&self.payload)
                    .ok()
                    .and_then(|value| value.parse::<u32>().ok())
                    .ok_or(TerminalError::BadFrame)?;
                Ok(Value::Map(BTreeMap::from([(
                    "exitCode".to_owned(),
                    Value::Unsigned(code as u64),
                )])))
            }
            _ => Ok(Value::Binary(self.payload.clone())),
        }
    }

    pub fn cursor(&self, terminal_id: &str) -> Result<CursorV1, TerminalError> {
        let value = Value::Map(BTreeMap::from([
            (
                "terminalID".to_owned(),
                Value::String(terminal_id.to_owned()),
            ),
            ("generation".to_owned(), Value::Unsigned(self.generation)),
            ("sequence".to_owned(), Value::Unsigned(self.sequence)),
            ("byteCursor".to_owned(), Value::Unsigned(self.byte_cursor)),
            ("kind".to_owned(), Value::String(self.kind.clone())),
            ("payload".to_owned(), self.event_payload()?),
        ]));
        let bytes =
            messagepack::encode(&value, FRAME_LIMITS).map_err(|_| TerminalError::BadFrame)?;
        Ok(CursorV1 {
            owner_kind: "terminal".to_owned(),
            owner_id: terminal_id.to_owned(),
            seq: self.sequence.to_string(),
            event_digest: format!("blake3:{}", blake3::hash(&bytes).to_hex()),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayGap {
    pub first_sequence: u64,
    pub last_sequence_exclusive: u64,
    pub first_byte_cursor: u64,
    pub last_byte_cursor_exclusive: u64,
}

/// Raw-byte replay ring. Appends are bounded to one wire frame and evict whole frames.
#[derive(Debug)]
pub struct ReplayRing {
    generation: u64,
    next_sequence: u64,
    byte_cursor: u64,
    retained_bytes: usize,
    chunks: VecDeque<ReplayChunk>,
}

impl ReplayRing {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            next_sequence: 1,
            byte_cursor: 0,
            retained_bytes: 0,
            chunks: VecDeque::new(),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn byte_cursor(&self) -> u64 {
        self.byte_cursor
    }
    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    pub fn reset(&mut self, generation: u64) {
        self.generation = generation;
        self.next_sequence = 1;
        self.byte_cursor = 0;
        self.retained_bytes = 0;
        self.chunks.clear();
    }

    pub fn append(&mut self, kind: &str, bytes: &[u8]) -> Result<Vec<ReplayChunk>, TerminalError> {
        if kind.is_empty() || bytes.len() > MAX_OUTPUT_FRAME {
            return Err(TerminalError::TooLarge);
        }
        let advances_byte_cursor = kind == "output";
        let end = self
            .byte_cursor
            .checked_add(if advances_byte_cursor {
                bytes.len() as u64
            } else {
                0
            })
            .ok_or(TerminalError::OutputLimit)?;
        let mut emitted = Vec::new();
        for part in bytes.chunks(MAX_OUTPUT_FRAME) {
            let byte_delta = if advances_byte_cursor {
                part.len() as u64
            } else {
                0
            };
            let chunk_end = self
                .byte_cursor
                .checked_add(byte_delta)
                .ok_or(TerminalError::OutputLimit)?;
            let chunk = ReplayChunk {
                generation: self.generation,
                sequence: self.next_sequence,
                byte_cursor: chunk_end,
                kind: kind.to_owned(),
                payload: part.to_vec(),
            };
            self.next_sequence = self
                .next_sequence
                .checked_add(1)
                .ok_or(TerminalError::OutputLimit)?;
            self.byte_cursor = chunk_end;
            self.retained_bytes += part.len();
            self.chunks.push_back(chunk.clone());
            emitted.push(chunk);
            while self.retained_bytes > REPLAY_CAPACITY {
                if let Some(oldest) = self.chunks.pop_front() {
                    self.retained_bytes -= oldest.payload.len();
                } else {
                    break;
                }
            }
        }
        debug_assert_eq!(self.byte_cursor, end);
        Ok(emitted)
    }

    /// Replays chunks after the acknowledged sequence and reports a gap if history expired.
    pub fn cursor_at(&self, terminal_id: &str, sequence: u64) -> Option<(CursorV1, u64)> {
        if sequence == 0 {
            return Some((
                CursorV1 {
                    owner_kind: "terminal".to_owned(),
                    owner_id: terminal_id.to_owned(),
                    seq: "0".to_owned(),
                    event_digest: format!("blake3:{}", "0".repeat(64)),
                },
                0,
            ));
        }
        self.chunks
            .iter()
            .find(|chunk| chunk.sequence == sequence)
            .and_then(|chunk| {
                chunk
                    .cursor(terminal_id)
                    .ok()
                    .map(|cursor| (cursor, chunk.byte_cursor))
            })
    }
    pub fn replay_after(
        &self,
        generation: u64,
        after_sequence: u64,
        byte_cursor: u64,
    ) -> Result<(Option<ReplayGap>, Vec<ReplayChunk>), TerminalError> {
        if generation != self.generation {
            return Err(TerminalError::StaleGeneration);
        }
        if after_sequence >= self.next_sequence || byte_cursor > self.byte_cursor {
            return Err(TerminalError::StaleSequence);
        }
        if let Some(chunk) = self
            .chunks
            .iter()
            .find(|chunk| chunk.sequence == after_sequence)
            && chunk.byte_cursor != byte_cursor
        {
            return Err(TerminalError::StaleSequence);
        }
        if after_sequence == 0 && byte_cursor != 0 {
            return Err(TerminalError::StaleSequence);
        }
        let first = self.chunks.front();
        let gap = match first {
            Some(chunk)
                if after_sequence.saturating_add(1) < chunk.sequence
                    || byte_cursor < chunk_start_byte_cursor(chunk) =>
            {
                Some(ReplayGap {
                    first_sequence: after_sequence.saturating_add(1),
                    last_sequence_exclusive: chunk.sequence,
                    first_byte_cursor: byte_cursor,
                    last_byte_cursor_exclusive: chunk_start_byte_cursor(chunk),
                })
            }
            None if after_sequence.saturating_add(1) < self.next_sequence
                || byte_cursor < self.byte_cursor =>
            {
                Some(ReplayGap {
                    first_sequence: after_sequence.saturating_add(1),
                    last_sequence_exclusive: self.next_sequence,
                    first_byte_cursor: byte_cursor,
                    last_byte_cursor_exclusive: self.byte_cursor,
                })
            }
            _ => None,
        };
        let chunks = self
            .chunks
            .iter()
            .filter(|chunk| chunk.sequence > after_sequence)
            .cloned()
            .collect();
        Ok((gap, chunks))
    }
    pub fn replay_after_limited(
        &self,
        generation: u64,
        after_sequence: u64,
        byte_cursor: u64,
        max_bytes: usize,
    ) -> Result<(Option<ReplayGap>, Vec<ReplayChunk>), TerminalError> {
        if max_bytes > MAX_OUTPUT_FRAME {
            return Err(TerminalError::TooLarge);
        }
        let (gap, chunks) = self.replay_after(generation, after_sequence, byte_cursor)?;
        let mut replay = Vec::new();
        let mut total = 0usize;
        for chunk in chunks {
            let next = total
                .checked_add(chunk.payload.len())
                .ok_or(TerminalError::OutputLimit)?;
            if next > max_bytes {
                break;
            }
            total = next;
            replay.push(chunk);
        }
        Ok((gap, replay))
    }
}
fn chunk_start_byte_cursor(chunk: &ReplayChunk) -> u64 {
    chunk.byte_cursor.saturating_sub(if chunk.kind == "output" {
        chunk.payload.len() as u64
    } else {
        0
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SequenceAck {
    pub sequence: u64,
    pub digest: [u8; 32],
}

/// Per-attachment sequence checkpoint; stores only a digest, never user input bytes.
#[derive(Debug, Default)]
pub struct AttachmentSequence {
    last: Option<SequenceAck>,
}

impl AttachmentSequence {
    pub fn accept(&mut self, sequence: u64, bytes: &[u8]) -> Result<bool, TerminalError> {
        if bytes.len() > MAX_INPUT_FRAME {
            return Err(TerminalError::TooLarge);
        }
        self.accept_digest(sequence, *blake3::hash(bytes).as_bytes())
    }

    fn accept_digest(&mut self, sequence: u64, digest: [u8; 32]) -> Result<bool, TerminalError> {
        match &self.last {
            Some(previous) if sequence == previous.sequence => {
                if digest == previous.digest {
                    Ok(false)
                } else {
                    Err(TerminalError::StaleSequence)
                }
            }
            Some(previous) if sequence == previous.sequence.saturating_add(1) => {
                self.last = Some(SequenceAck { sequence, digest });
                Ok(true)
            }
            None if sequence == 0 => {
                self.last = Some(SequenceAck { sequence, digest });
                Ok(true)
            }
            _ => Err(TerminalError::StaleSequence),
        }
    }

    pub fn last_ack(&self) -> Option<&SequenceAck> {
        self.last.as_ref()
    }
}

/// Session-independent terminal owner projection; attachment counters are connection-scoped.
#[derive(Debug)]
pub struct TerminalState {
    pub terminal_id: String,
    pub generation: u64,
    pub grant: InteractiveGrantV1,
    pub status: TerminalStatus,
    pub replay: ReplayRing,
    attachments: BTreeMap<String, AttachmentSequence>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalStatus {
    Running,
    Exited(i32),
    TimedOut,
    Cancelled,
    Unknown,
}

impl TerminalState {
    pub fn new(terminal_id: String, generation: u64, grant: InteractiveGrantV1) -> Self {
        Self {
            terminal_id,
            generation,
            grant,
            status: TerminalStatus::Running,
            replay: ReplayRing::new(generation),
            attachments: BTreeMap::new(),
        }
    }

    pub fn admit_attachment(&mut self, attachment_id: String) -> Result<(), TerminalError> {
        if attachment_id.is_empty()
            || attachment_id.len() > 256
            || self.attachments.contains_key(&attachment_id)
        {
            return Err(TerminalError::BadFrame);
        }
        if self.attachments.len() >= 64 {
            return Err(TerminalError::TooLarge);
        }
        self.attachments
            .insert(attachment_id, AttachmentSequence::default());
        Ok(())
    }

    pub fn revoke_attachment(&mut self, attachment_id: &str) -> bool {
        self.attachments.remove(attachment_id).is_some()
    }

    /// `true` means dispatch once to the already-admitted PTY; `false` means duplicate ACK only.
    pub fn accept_input(
        &mut self,
        attachment_id: &str,
        generation: u64,
        grant_id: &str,
        sequence: u64,
        bytes: &[u8],
        now_ms: u64,
        owner_epoch: u64,
        fence_generation: u64,
    ) -> Result<bool, TerminalError> {
        if generation != self.generation {
            return Err(TerminalError::StaleGeneration);
        }
        if grant_id != self.grant.grant_id {
            return Err(TerminalError::Denied);
        }
        self.grant.validate(now_ms, owner_epoch, fence_generation)?;
        match self.status {
            TerminalStatus::Running => {}
            // Only owner loss sets `Unknown`; it fences without projecting an exit.
            TerminalStatus::Unknown => return Err(TerminalError::OwnerLost),
            _ => return Err(TerminalError::Unknown),
        }
        self.attachments
            .get_mut(attachment_id)
            .ok_or(TerminalError::Denied)?
            .accept(sequence, bytes)
    }
    /// Resize shares the attachment's sequence lane with input and stores only a digest.
    pub fn accept_resize(
        &mut self,
        attachment_id: &str,
        generation: u64,
        grant_id: &str,
        sequence: u64,
        cols: u16,
        rows: u16,
        now_ms: u64,
        owner_epoch: u64,
        fence_generation: u64,
    ) -> Result<bool, TerminalError> {
        if !(1..=500).contains(&cols) || !(1..=300).contains(&rows) {
            return Err(TerminalError::BadFrame);
        }
        if generation != self.generation {
            return Err(TerminalError::StaleGeneration);
        }
        if grant_id != self.grant.grant_id {
            return Err(TerminalError::Denied);
        }
        self.grant.validate(now_ms, owner_epoch, fence_generation)?;
        match self.status {
            TerminalStatus::Running => {}
            // Only owner loss sets `Unknown`; it fences without projecting an exit.
            TerminalStatus::Unknown => return Err(TerminalError::OwnerLost),
            _ => return Err(TerminalError::Unknown),
        }
        let mut digest = blake3::Hasher::new_derive_key("horizon.terminal.resize.v1");
        digest.update(&cols.to_be_bytes());
        digest.update(&rows.to_be_bytes());
        self.attachments
            .get_mut(attachment_id)
            .ok_or(TerminalError::Denied)?
            .accept_digest(sequence, *digest.finalize().as_bytes())
    }

    pub fn mark_owner_lost(&mut self, new_fence_generation: u64) {
        self.status = TerminalStatus::Unknown;
        self.attachments.clear();
        self.grant.fence_generation = new_fence_generation;
    }
}

/// TM-001: a compiler log up to 100 MB must stay line-searchable while search answers
/// remain bounded (results, excerpt bytes). Retention is a hard byte bound, not a hint.
pub const RETAINED_LOG_CAPACITY: usize = 100 * 1024 * 1024;
pub const MAX_SEARCH_RESULTS: usize = 100;
pub const MAX_SEARCH_EXCERPT_BYTES: usize = 4 * 1024;
pub const MAX_OUTPUT_RANGE_BYTES: usize = 64 * 1024;
pub const MAX_RETAINED_LOGS: usize = 64;

/// One bounded, line-addressed search hit. `generation` is the retained-log view the
/// offset belongs to; a later truncation/rotation makes the ref stale instead of
/// silently re-pointing at different content (TM-002).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogLineRef {
    pub generation: u64,
    /// 1-based line number inside the retained view.
    pub line_number: u64,
    pub line_start_byte: u64,
    pub excerpt: Vec<u8>,
    pub excerpt_truncated: bool,
}

/// One bounded range read of retained lines. Ranges are clamped to the retained view
/// and byte-truncated to the request cap, never flooded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogRangePage {
    pub generation: u64,
    /// 1-based inclusive first line returned.
    pub line_start: u64,
    /// 1-based exclusive end actually returned (clamped to the retained view).
    pub line_end_exclusive: u64,
    pub bytes: Vec<u8>,
    /// `true` when the requested range or the byte cap cut the answer short.
    pub truncated: bool,
}

/// Bounded (100 MB), line-indexed, generation-scoped retained log used by
/// `terminal.search` / `terminal.output_range`.
///
/// Line numbers are stable only inside one generation. Evicting whole lines to stay
/// inside the byte bound, or an explicit rotation/truncation, advances the generation
/// so a held range ref is reported stale instead of being reused for different lines.
#[derive(Debug)]
pub struct RetainedLog {
    generation: u64,
    bytes: Vec<u8>,
    /// Byte offset of every line start; always begins with 0 while any bytes are kept.
    line_starts: Vec<u64>,
    invalidations: u64,
}

impl RetainedLog {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            bytes: Vec::new(),
            line_starts: vec![0],
            invalidations: 0,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn retained_bytes(&self) -> usize {
        self.bytes.len()
    }

    pub fn line_count(&self) -> usize {
        self.line_starts.len()
    }

    /// Number of generation advances caused by eviction or rotation; observability for
    /// tests and status, not an identity.
    pub fn invalidations(&self) -> u64 {
        self.invalidations
    }

    pub fn append(&mut self, chunk: &[u8]) {
        let base = self.bytes.len();
        self.bytes.extend_from_slice(chunk);
        for (offset, byte) in chunk.iter().enumerate() {
            if *byte == b'\n' {
                self.line_starts.push((base + offset + 1) as u64);
            }
        }
        self.evict();
    }

    /// External truncation/rotation: the log restarts empty under a newer generation so
    /// every held ref is stale. A non-advancing request generation is advanced locally.
    pub fn rotate(&mut self, generation: u64) {
        self.generation = if generation > self.generation {
            generation
        } else {
            self.generation.saturating_add(1)
        };
        self.bytes.clear();
        self.line_starts.clear();
        self.line_starts.push(0);
        self.invalidations = self.invalidations.saturating_add(1);
    }

    fn evict(&mut self) {
        if self.bytes.len() <= RETAINED_LOG_CAPACITY {
            return;
        }
        let overflow = self.bytes.len() - RETAINED_LOG_CAPACITY;
        let cut_index = self.line_starts.partition_point(|start| *start < overflow as u64);
        if cut_index < self.line_starts.len() {
            let cut = self.line_starts[cut_index] as usize;
            self.bytes.drain(..cut);
            self.line_starts.drain(..cut_index);
            for start in &mut self.line_starts {
                *start -= cut as u64;
            }
        } else {
            // A single line exceeds the whole bound; keep its tail so retention stays bounded.
            let cut = self.bytes.len() - RETAINED_LOG_CAPACITY;
            self.bytes.drain(..cut);
            self.line_starts.clear();
            self.line_starts.push(0);
        }
        self.generation = self.generation.saturating_add(1);
        self.invalidations = self.invalidations.saturating_add(1);
    }

    /// Literal, bounded search. Answers are distinct lines in order, each excerpt being
    /// the matching line capped at `max_bytes_per_excerpt`; scanning stops at
    /// `max_results` hits so a 100 MB log can never flood the caller.
    pub fn search(
        &self,
        generation: u64,
        query: &str,
        max_results: usize,
        max_bytes_per_excerpt: usize,
    ) -> Result<Vec<LogLineRef>, TerminalError> {
        if generation != self.generation {
            return Err(TerminalError::StaleGeneration);
        }
        if query.is_empty() || query.len() > 4 * 1024 {
            return Err(TerminalError::BadFrame);
        }
        if max_results == 0 || max_results > MAX_SEARCH_RESULTS {
            return Err(TerminalError::TooLarge);
        }
        if max_bytes_per_excerpt == 0 || max_bytes_per_excerpt > MAX_SEARCH_EXCERPT_BYTES {
            return Err(TerminalError::TooLarge);
        }
        let needle = query.as_bytes();
        let mut results = Vec::new();
        let mut from = 0usize;
        let mut last_line: Option<usize> = None;
        while results.len() < max_results {
            let Some(offset) = find_bytes(&self.bytes[from..], needle) else {
                break;
            };
            let absolute = from + offset;
            let line_index = self.line_starts.partition_point(|start| *start <= absolute as u64) - 1;
            if last_line != Some(line_index) {
                last_line = Some(line_index);
                let line_start = self.line_starts[line_index];
                let line_end = self
                    .line_starts
                    .get(line_index + 1)
                    .copied()
                    .unwrap_or(self.bytes.len() as u64);
                let excerpt_len = (line_end - line_start).min(max_bytes_per_excerpt as u64) as usize;
                results.push(LogLineRef {
                    generation: self.generation,
                    line_number: line_index as u64 + 1,
                    line_start_byte: line_start,
                    excerpt: self.bytes[line_start as usize..line_start as usize + excerpt_len]
                        .to_vec(),
                    excerpt_truncated: (line_end - line_start) > excerpt_len as u64,
                });
            }
            from = absolute + needle.len();
            if from >= self.bytes.len() {
                break;
            }
        }
        Ok(results)
    }

    /// Bounded range read. Stale generations are refused outright; in-generation ranges
    /// are clamped to the retained view and byte-capped.
    pub fn output_range(
        &self,
        generation: u64,
        line_start: u64,
        line_end_exclusive: u64,
        max_bytes: usize,
    ) -> Result<LogRangePage, TerminalError> {
        if generation != self.generation {
            return Err(TerminalError::StaleGeneration);
        }
        if line_start == 0 || line_end_exclusive <= line_start {
            return Err(TerminalError::BadFrame);
        }
        if max_bytes == 0 || max_bytes > MAX_OUTPUT_RANGE_BYTES {
            return Err(TerminalError::TooLarge);
        }
        let line_count = self.line_count() as u64;
        let end = line_end_exclusive.min(line_count + 1);
        let mut bytes = Vec::new();
        let mut truncated = end < line_end_exclusive;
        for line in line_start..end {
            let start = self.line_starts[(line - 1) as usize];
            let segment_end = self
                .line_starts
                .get(line as usize)
                .copied()
                .unwrap_or(self.bytes.len() as u64);
            let segment = &self.bytes[start as usize..segment_end as usize];
            if bytes.len() + segment.len() > max_bytes {
                let remaining = max_bytes.saturating_sub(bytes.len());
                bytes.extend_from_slice(&segment[..remaining]);
                truncated = true;
                break;
            }
            bytes.extend_from_slice(segment);
        }
        Ok(LogRangePage {
            generation: self.generation,
            line_start,
            line_end_exclusive: end,
            bytes,
            truncated,
        })
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let first = needle[0];
    let last_index = haystack.len() - needle.len();
    let mut index = 0usize;
    while index <= last_index {
        if haystack[index] == first && &haystack[index..index + needle.len()] == needle {
            return Some(index);
        }
        index += 1;
    }
    None
}

/// Bounded registry of retained logs keyed by artifact ID. Lookups on an unknown or
/// evicted artifact fail closed with `Unavailable`; the count is capped so a long
/// session cannot retain unbounded log views.
#[derive(Debug, Default)]
pub struct RetainedLogRegistry {
    logs: BTreeMap<String, RetainedLog>,
    recency: VecDeque<String>,
}

impl RetainedLogRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.logs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.logs.is_empty()
    }

    fn touch(&mut self, artifact_id: &str) {
        if let Some(position) = self.recency.iter().position(|id| id == artifact_id) {
            self.recency.remove(position);
        }
        self.recency.push_back(artifact_id.to_owned());
    }

    pub fn append(&mut self, artifact_id: &str, generation: u64, chunk: &[u8]) {
        if !self.logs.contains_key(artifact_id) {
            while self.logs.len() >= MAX_RETAINED_LOGS {
                let Some(evicted) = self.recency.pop_front() else {
                    break;
                };
                self.logs.remove(&evicted);
            }
            self.logs
                .insert(artifact_id.to_owned(), RetainedLog::new(generation));
        }
        if let Some(log) = self.logs.get_mut(artifact_id) {
            log.append(chunk);
        }
        self.touch(artifact_id);
    }

    pub fn rotate(&mut self, artifact_id: &str, generation: u64) {
        if let Some(log) = self.logs.get_mut(artifact_id) {
            log.rotate(generation);
        }
        self.touch(artifact_id);
    }

    pub fn remove(&mut self, artifact_id: &str) -> bool {
        let removed = self.logs.remove(artifact_id).is_some();
        if let Some(position) = self.recency.iter().position(|id| id == artifact_id) {
            self.recency.remove(position);
        }
        removed
    }

    pub fn generation(&self, artifact_id: &str) -> Option<u64> {
        self.logs.get(artifact_id).map(RetainedLog::generation)
    }

    pub fn search(
        &mut self,
        artifact_id: &str,
        generation: u64,
        query: &str,
        max_results: usize,
        max_bytes_per_excerpt: usize,
    ) -> Result<Vec<LogLineRef>, TerminalError> {
        let log = self
            .logs
            .get(artifact_id)
            .ok_or(TerminalError::Unavailable)?;
        let result = log.search(generation, query, max_results, max_bytes_per_excerpt);
        self.touch(artifact_id);
        result
    }

    pub fn output_range(
        &mut self,
        artifact_id: &str,
        generation: u64,
        line_start: u64,
        line_end_exclusive: u64,
        max_bytes: usize,
    ) -> Result<LogRangePage, TerminalError> {
        let log = self
            .logs
            .get(artifact_id)
            .ok_or(TerminalError::Unavailable)?;
        let result = log.output_range(generation, line_start, line_end_exclusive, max_bytes);
        self.touch(artifact_id);
        result
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalOperation {
    Run,
    Start,
    Input,
    Resize,
    Cancel,
    Status,
    Search,
    OutputRange,
}

impl TerminalOperation {
    pub fn parse(name: &str, body: &Value) -> Result<Self, TerminalError> {
        let (operation, required, optional): (Self, &[&str], &[&str]) = match name {
            "run" => (
                Self::Run,
                &[
                    "effectID",
                    "capabilityLeaseDigest",
                    "locationID",
                    "shellProfileID",
                    "command",
                    "cwd",
                    "timeoutMs",
                    "resolvedEnvironment",
                ],
                &["sessionID"],
            ),
            "start" => (
                Self::Start,
                &[
                    "effectID",
                    "capabilityLeaseDigest",
                    "locationID",
                    "terminalID",
                ],
                &[
                    "sessionID",
                    "shellProfileID",
                    "command",
                    "args",
                    "cwd",
                    "cols",
                    "rows",
                    "env",
                ],
            ),
            "input" => (
                Self::Input,
                &[
                    "terminalID",
                    "generation",
                    "grantID",
                    "attachmentID",
                    "sequence",
                    "bytes",
                ],
                &[],
            ),
            "resize" => (
                Self::Resize,
                &[
                    "terminalID",
                    "generation",
                    "grantID",
                    "attachmentID",
                    "sequence",
                    "cols",
                    "rows",
                ],
                &[],
            ),
            "cancel" => (
                Self::Cancel,
                &["effectID", "terminalID", "generation", "reason"],
                &[],
            ),
            "status" => (
                Self::Status,
                &["terminalID", "generation"],
                &["afterSequence", "afterByteCursor", "maxBytes"],
            ),
            "search" => (
                Self::Search,
                &[
                    "artifactID",
                    "generation",
                    "queryOrRegex",
                    "maxResults",
                    "maxBytesPerExcerpt",
                ],
                &[],
            ),
            "output_range" => (
                Self::OutputRange,
                &[
                    "artifactID",
                    "generation",
                    "lineStart",
                    "lineEndExclusive",
                    "maxBytes",
                ],
                &[],
            ),
            _ => return Err(TerminalError::BadFrame),
        };
        let Value::Map(fields) = body else {
            return Err(TerminalError::BadFrame);
        };
        if fields.len() > required.len() + optional.len()
            || fields
                .keys()
                .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
            || required.iter().any(|key| !fields.contains_key(*key))
        {
            return Err(TerminalError::BadFrame);
        }
        for (key, value) in fields {
            if let Value::String(text) = value {
                let max = match key.as_str() {
                    "command" => 64 * 1024,
                    "cwd" => 4 * 1024,
                    "queryOrRegex" => 4 * 1024,
                    "effectID"
                    | "capabilityLeaseDigest"
                    | "locationID"
                    | "sessionID"
                    | "shellProfileID"
                    | "terminalID"
                    | "grantID"
                    | "attachmentID"
                    | "reason"
                    | "artifactID" => 256,
                    _ => usize::MAX,
                };
                if text.len() > max {
                    return Err(TerminalError::TooLarge);
                }
            }
        }
        for (key, value) in fields {
            let valid = match key.as_str() {
                "generation" | "sequence" | "timeoutMs" | "cols" | "rows" | "afterSequence"
                | "afterByteCursor" | "maxBytes" | "maxResults" | "maxBytesPerExcerpt"
                | "lineStart" | "lineEndExclusive" => matches!(value, Value::Unsigned(_)),
                "bytes" => match value {
                    Value::Binary(data) if data.len() <= MAX_INPUT_FRAME => true,
                    Value::Binary(_) => return Err(TerminalError::TooLarge),
                    _ => false,
                },
                "args" => match value {
                    Value::Array(args) if args.len() <= 256 => {
                        let mut total = 0usize;
                        for arg in args {
                            let Value::String(arg) = arg else {
                                return Err(TerminalError::BadFrame);
                            };
                            total = total
                                .checked_add(arg.len())
                                .ok_or(TerminalError::TooLarge)?;
                        }
                        if total > 256 * 1024 {
                            return Err(TerminalError::TooLarge);
                        }
                        true
                    }
                    Value::Array(_) => return Err(TerminalError::TooLarge),
                    _ => false,
                },
                "env" | "resolvedEnvironment" => match value {
                    Value::Map(map) if map.len() <= 128 => {
                        let mut total = 0usize;
                        for (name, value) in map {
                            let Value::String(value) = value else {
                                return Err(TerminalError::BadFrame);
                            };
                            total = total
                                .checked_add(name.len())
                                .and_then(|n| n.checked_add(value.len()))
                                .ok_or(TerminalError::TooLarge)?;
                        }
                        if total > 64 * 1024 {
                            return Err(TerminalError::TooLarge);
                        }
                        true
                    }
                    Value::Map(_) => return Err(TerminalError::TooLarge),
                    _ => false,
                },
                "command" => {
                    matches!(value, Value::String(text) if !text.is_empty() && text.len() <= 64 * 1024)
                }
                "cwd" => {
                    matches!(value, Value::String(text) if !text.is_empty() && text.len() <= 4 * 1024)
                }
                "queryOrRegex" => {
                    matches!(value, Value::String(text) if !text.is_empty() && text.len() <= 4 * 1024)
                }
                "effectID"
                | "capabilityLeaseDigest"
                | "locationID"
                | "sessionID"
                | "shellProfileID"
                | "terminalID"
                | "grantID"
                | "attachmentID"
                | "reason"
                | "artifactID" => {
                    matches!(value, Value::String(text) if !text.is_empty() && text.len() <= 256)
                }
                _ => false,
            };
            if !valid {
                return Err(TerminalError::BadFrame);
            }
        }
        if matches!(fields.get("timeoutMs"), Some(Value::Unsigned(value)) if *value > 600_000) {
            return Err(TerminalError::TimeoutLimit);
        }
        for key in ["cols", "rows"] {
            if let Some(Value::Unsigned(value)) = fields.get(key) {
                let upper = if key == "cols" { 500 } else { 300 };
                if *value == 0 || *value > upper {
                    return Err(TerminalError::BadFrame);
                }
            }
        }
        if matches!(fields.get("maxBytes"), Some(Value::Unsigned(value)) if *value > 64 * 1024)
            || matches!(fields.get("maxBytesPerExcerpt"), Some(Value::Unsigned(value)) if *value > 4 * 1024)
            || matches!(fields.get("maxResults"), Some(Value::Unsigned(value)) if *value == 0 || *value > 100)
            || matches!(fields.get("lineEndExclusive"), Some(Value::Unsigned(end)) if matches!(fields.get("lineStart"), Some(Value::Unsigned(start)) if end <= start))
        {
            return Err(TerminalError::TooLarge);
        }
        Ok(operation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> InteractiveGrantV1 {
        InteractiveGrantV1 {
            grant_id: "grant".into(),
            principal: "principal".into(),
            host_id: "host".into(),
            location_id: "location".into(),
            terminal_id: "terminal".into(),
            launch_digest: "launch".into(),
            config_digest: "config".into(),
            backend: "pty".into(),
            owner_epoch: 4,
            fence_generation: 8,
            issued_at_ms: 10,
            expires_at_ms: 100,
        }
    }

    #[test]
    fn grant_is_fenced_by_expiry_epoch_and_generation() {
        let grant = grant();
        assert_eq!(grant.validate(99, 4, 8), Ok(()));
        assert_eq!(grant.validate(100, 4, 8), Err(TerminalError::GrantExpired));
        assert_eq!(grant.validate(99, 5, 8), Err(TerminalError::OwnerLost));
        assert_eq!(grant.validate(99, 4, 9), Err(TerminalError::OwnerLost));
    }
    #[test]
    fn output_cursor_binds_canonical_messagepack_event_and_end_byte_cursor() {
        let mut ring = ReplayRing::new(5);
        let event = ring.append("output", b"abc").unwrap().remove(0);
        assert_eq!(event.sequence, 1);
        assert_eq!(event.byte_cursor, 3);
        let cursor = event.cursor("terminal").unwrap();
        assert_eq!(cursor.owner_kind, "terminal");
        assert_eq!(cursor.owner_id, "terminal");
        assert_eq!(cursor.seq, "1");
        assert!(cursor.event_digest.starts_with("blake3:"));
    }

    #[test]
    fn operation_validation_enforces_timeout_and_input_limits() {
        let too_long_input = Value::Map(BTreeMap::from([
            ("terminalID".into(), Value::String("terminal".into())),
            ("generation".into(), Value::Unsigned(1)),
            ("grantID".into(), Value::String("grant".into())),
            ("attachmentID".into(), Value::String("attachment".into())),
            ("sequence".into(), Value::Unsigned(0)),
            ("bytes".into(), Value::Binary(vec![0; MAX_INPUT_FRAME + 1])),
        ]));
        assert_eq!(
            TerminalOperation::parse("input", &too_long_input),
            Err(TerminalError::TooLarge)
        );

        let too_long_timeout = Value::Map(BTreeMap::from([
            ("effectID".into(), Value::String("effect".into())),
            (
                "capabilityLeaseDigest".into(),
                Value::String("digest".into()),
            ),
            ("locationID".into(), Value::String("location".into())),
            ("shellProfileID".into(), Value::String("shell".into())),
            ("command".into(), Value::String("true".into())),
            ("cwd".into(), Value::String("/".into())),
            ("timeoutMs".into(), Value::Unsigned(600_001)),
            ("resolvedEnvironment".into(), Value::Map(BTreeMap::new())),
        ]));
        assert_eq!(
            TerminalOperation::parse("run", &too_long_timeout),
            Err(TerminalError::TimeoutLimit)
        );
    }

    #[test]
    fn replay_ring_reports_evicted_byte_and_sequence_ranges() {
        let mut ring = ReplayRing::new(2);
        for _ in 0..=(REPLAY_CAPACITY / MAX_OUTPUT_FRAME) {
            ring.append("output", &vec![0; MAX_OUTPUT_FRAME]).unwrap();
        }
        let (gap, chunks) = ring.replay_after(2, 0, 0).unwrap();
        let gap = gap.unwrap();
        assert!(gap.last_sequence_exclusive > gap.first_sequence);
        assert!(gap.last_byte_cursor_exclusive > gap.first_byte_cursor);
        assert_eq!(
            chunks.first().unwrap().sequence,
            gap.last_sequence_exclusive
        );
        assert_eq!(
            ring.replay_after(1, 0, 0),
            Err(TerminalError::StaleGeneration)
        );
    }

    #[test]
    fn input_duplicate_is_acked_without_reexecution() {
        let mut state = TerminalState::new("terminal".into(), 1, grant());
        state.admit_attachment("attachment".into()).unwrap();
        assert!(
            state
                .accept_input("attachment", 1, "grant", 0, b"secret", 11, 4, 8)
                .unwrap()
        );
        assert!(
            !state
                .accept_input("attachment", 1, "grant", 0, b"secret", 12, 4, 8)
                .unwrap()
        );
        assert_eq!(
            state.accept_input("attachment", 1, "grant", 0, b"other", 12, 4, 8),
            Err(TerminalError::StaleSequence)
        );
        assert_eq!(
            state.accept_input("attachment", 1, "grant", 2, b"gap", 12, 4, 8),
            Err(TerminalError::StaleSequence)
        );
    }

    #[test]
    fn resize_shares_attachment_sequence_and_rechecks_bounds() {
        let mut state = TerminalState::new("terminal".into(), 1, grant());
        state.admit_attachment("attachment".into()).unwrap();
        assert!(
            state
                .accept_input("attachment", 1, "grant", 0, b"x", 11, 4, 8)
                .unwrap()
        );
        assert!(
            state
                .accept_resize("attachment", 1, "grant", 1, 120, 40, 12, 4, 8)
                .unwrap()
        );
        assert!(
            !state
                .accept_resize("attachment", 1, "grant", 1, 120, 40, 13, 4, 8)
                .unwrap()
        );
        assert_eq!(
            state.accept_resize("attachment", 1, "grant", 1, 121, 40, 13, 4, 8),
            Err(TerminalError::StaleSequence)
        );
        assert_eq!(
            state.accept_resize("attachment", 1, "grant", 2, 501, 40, 13, 4, 8),
            Err(TerminalError::BadFrame)
        );
    }

    #[test]
    fn owner_loss_never_projects_exit() {
        let mut state = TerminalState::new("terminal".into(), 1, grant());
        state.mark_owner_lost(9);
        assert_eq!(state.status, TerminalStatus::Unknown);
        assert_eq!(
            state.accept_input("missing", 1, "grant", 0, b"x", 11, 4, 9),
            Err(TerminalError::OwnerLost)
        );
    }
}

#[cfg(test)]
mod log_tests {
    use super::*;

    const ERROR_LINE: &[u8] = b"[error] src/main.rs(42,7): unresolved import `missing_crate`\n";

    /// Fill a bounded chunk with fixed 200-byte lines so the 100 MB case builds fast and
    /// every line boundary is deterministic.
    fn filler_chunk() -> Vec<u8> {
        let line: Vec<u8> = {
            let mut line = b"[build] unit ".to_vec();
            line.resize(199, b'.');
            line.push(b'\n');
            line
        };
        let mut chunk = Vec::with_capacity(65_400);
        for _ in 0..327 {
            chunk.extend_from_slice(&line);
        }
        chunk
    }

    #[test]
    fn hundred_megabyte_compiler_log_search_is_bounded_and_stales_on_truncation() {
        let mut log = RetainedLog::new(1);
        let chunk = filler_chunk();
        let mut appended = 0usize;
        while appended < RETAINED_LOG_CAPACITY + 2 * 1024 * 1024 {
            log.append(&chunk);
            appended += chunk.len();
        }
        assert!(log.retained_bytes() <= RETAINED_LOG_CAPACITY);
        assert!(log.invalidations() > 0, "retention must have evicted lines");

        log.append(ERROR_LINE);
        let generation = log.generation();
        let hits = log
            .search(generation, "unresolved import `missing_crate`", 100, 4096)
            .expect("search must find the single target error");
        assert_eq!(hits.len(), 1, "bounded search must return one line ref");
        // The error is the last complete line; the trailing newline starts an empty view line.
        assert_eq!(hits[0].line_number, log.line_count() as u64 - 1);
        assert_eq!(hits[0].generation, generation);
        assert_eq!(hits[0].excerpt, ERROR_LINE);
        assert!(!hits[0].excerpt_truncated);

        // TM-002: truncation after the caller holds the line ref must report staleness
        // instead of re-pointing the same line number at different content.
        for _ in 0..40 {
            log.append(&chunk);
        }
        assert!(log.generation() > generation);
        assert_eq!(
            log.search(generation, "missing_crate", 100, 4096),
            Err(TerminalError::StaleGeneration)
        );
        assert_eq!(
            log.output_range(generation, hits[0].line_number, hits[0].line_number + 1, 4096),
            Err(TerminalError::StaleGeneration)
        );
        // The old line number does address different bytes in the newer generation,
        // which is exactly why stale refs are refused rather than reused.
        let reused = log
            .output_range(log.generation(), hits[0].line_number, hits[0].line_number + 1, 4096)
            .expect("current generation range stays readable");
        assert_ne!(reused.bytes, ERROR_LINE);
    }

    #[test]
    fn rotation_reports_stale_generation_for_held_line_refs() {
        let mut log = RetainedLog::new(3);
        log.append(b"first target here\nsecond line\n");
        let hits = log.search(3, "target", 10, 4096).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line_number, 1);

        log.rotate(9);
        assert_eq!(log.generation(), 9);
        assert_eq!(log.line_count(), 1);
        assert_eq!(log.retained_bytes(), 0);
        assert_eq!(
            log.search(3, "target", 10, 4096),
            Err(TerminalError::StaleGeneration)
        );
        assert_eq!(
            log.output_range(3, 1, 2, 4096),
            Err(TerminalError::StaleGeneration)
        );

        log.append(b"rotated log\n");
        assert_eq!(log.search(9, "rotated", 10, 4096).unwrap()[0].line_number, 1);
        // A rotation request that does not advance the generation still must not leave
        // old refs valid.
        let before = log.generation();
        log.rotate(before);
        assert!(log.generation() > before);
        assert_eq!(
            log.search(before, "rotated", 10, 4096),
            Err(TerminalError::StaleGeneration)
        );
    }

    #[test]
    fn output_range_is_clamped_and_byte_bounded() {
        let mut log = RetainedLog::new(1);
        log.append(b"one\ntwo\nthree\n");
        let generation = log.generation();

        let all = log.output_range(generation, 1, 10, MAX_OUTPUT_RANGE_BYTES).unwrap();
        assert_eq!(all.line_start, 1);
        // The view is `one\ntwo\nthree\n`; line 4 is the empty view line the trailing
        // newline starts, so the clamped exclusive end is one past it.
        assert_eq!(all.line_end_exclusive, 5);
        assert_eq!(all.bytes, b"one\ntwo\nthree\n");
        assert!(all.truncated, "a clamped range is reported as truncated");

        let capped = log.output_range(generation, 1, 3, 5).unwrap();
        assert_eq!(capped.bytes, b"one\nt");
        assert!(capped.truncated);

        let exact = log.output_range(generation, 1, 2, 4).unwrap();
        assert_eq!(exact.bytes, b"one\n");
        assert!(!exact.truncated);

        assert_eq!(
            log.output_range(generation, 0, 2, 64),
            Err(TerminalError::BadFrame)
        );
        assert_eq!(
            log.output_range(generation, 2, 2, 64),
            Err(TerminalError::BadFrame)
        );
        assert_eq!(
            log.output_range(generation, 1, 2, 0),
            Err(TerminalError::TooLarge)
        );
        assert_eq!(
            log.output_range(generation, 1, 2, MAX_OUTPUT_RANGE_BYTES + 1),
            Err(TerminalError::TooLarge)
        );
    }

    #[test]
    fn search_is_line_deduplicated_and_respects_result_and_excerpt_bounds() {
        let mut log = RetainedLog::new(1);
        log.append(b"alpha hit one\nhit hit hit\nbeta hit two\ngamma\n");
        let generation = log.generation();

        let hits = log.search(generation, "hit", 100, 4).unwrap();
        // Three of the four lines match. Exactly one ref per matching line: the
        // three occurrences inside line 2 collapse into its single ref (per-
        // occurrence or context rows would return 5 refs), and non-matching line
        // 4 is never returned.
        assert_eq!(hits.len(), 3, "one ref per matching line, no context flooding");
        assert_eq!(hits[0].line_number, 1);
        assert_eq!(hits[1].line_number, 2);
        assert_eq!(hits[2].line_number, 3);
        assert_eq!(hits[0].excerpt, b"alph");
        assert!(hits[0].excerpt_truncated);
        assert_eq!(hits[1].excerpt, b"hit ");
        assert!(hits[1].excerpt_truncated);
        assert_eq!(hits[2].excerpt, b"beta");
        assert!(hits[2].excerpt_truncated);

        assert_eq!(log.search(generation, "hit", 1, 4096).unwrap().len(), 1);
        assert_eq!(
            log.search(generation, "hit", 0, 4096),
            Err(TerminalError::TooLarge)
        );
        assert_eq!(
            log.search(generation, "hit", MAX_SEARCH_RESULTS + 1, 4096),
            Err(TerminalError::TooLarge)
        );
        assert_eq!(
            log.search(generation, "hit", 1, MAX_SEARCH_EXCERPT_BYTES + 1),
            Err(TerminalError::TooLarge)
        );
        assert_eq!(
            log.search(generation, "", 1, 4096),
            Err(TerminalError::BadFrame)
        );
        assert_eq!(
            log.search(generation + 1, "hit", 1, 4096),
            Err(TerminalError::StaleGeneration)
        );
    }

    #[test]
    fn registry_bounds_retained_logs_and_fails_closed_on_eviction() {
        let mut registry = RetainedLogRegistry::new();
        for index in 0..=MAX_RETAINED_LOGS {
            registry.append(&format!("artifact-{index}"), 1, b"line\n");
        }
        assert_eq!(registry.len(), MAX_RETAINED_LOGS);
        assert_eq!(registry.generation("artifact-0"), None);
        assert_eq!(
            registry.search("artifact-0", 1, "line", 1, 64),
            Err(TerminalError::Unavailable)
        );
        assert_eq!(registry.generation("artifact-1"), Some(1));
        assert_eq!(
            registry.search(&format!("artifact-{MAX_RETAINED_LOGS}"), 1, "line", 1, 64)
                .unwrap()
                .len(),
            1
        );
        assert!(registry.remove(&format!("artifact-{MAX_RETAINED_LOGS}")));
        assert!(!registry.remove(&format!("artifact-{MAX_RETAINED_LOGS}")));
        registry.append("fresh", 5, b"fresh line\n");
        assert_eq!(registry.generation("fresh"), Some(5));
        assert_eq!(
            registry
                .output_range("fresh", 5, 1, 2, 64)
                .unwrap()
                .bytes,
            b"fresh line\n"
        );
        assert_eq!(
            registry.output_range("fresh", 4, 1, 2, 64),
            Err(TerminalError::StaleGeneration)
        );
    }

    #[test]
    fn search_and_output_range_operation_parsing_enforces_bounds() {
        let search = |max_results: u64, max_excerpt: u64| {
            Value::Map(BTreeMap::from([
                ("artifactID".into(), Value::String("artifact".into())),
                ("generation".into(), Value::Unsigned(2)),
                ("queryOrRegex".into(), Value::String("error".into())),
                ("maxResults".into(), Value::Unsigned(max_results)),
                ("maxBytesPerExcerpt".into(), Value::Unsigned(max_excerpt)),
            ]))
        };
        assert_eq!(
            TerminalOperation::parse("search", &search(100, 4096)),
            Ok(TerminalOperation::Search)
        );
        assert_eq!(
            TerminalOperation::parse("search", &search(0, 4096)),
            Err(TerminalError::TooLarge)
        );
        assert_eq!(
            TerminalOperation::parse("search", &search(101, 4096)),
            Err(TerminalError::TooLarge)
        );
        assert_eq!(
            TerminalOperation::parse("search", &search(10, 4097)),
            Err(TerminalError::TooLarge)
        );

        let range = |start: u64, end: u64, max_bytes: u64| {
            Value::Map(BTreeMap::from([
                ("artifactID".into(), Value::String("artifact".into())),
                ("generation".into(), Value::Unsigned(2)),
                ("lineStart".into(), Value::Unsigned(start)),
                ("lineEndExclusive".into(), Value::Unsigned(end)),
                ("maxBytes".into(), Value::Unsigned(max_bytes)),
            ]))
        };
        assert_eq!(
            TerminalOperation::parse("output_range", &range(10, 20, 64 * 1024)),
            Ok(TerminalOperation::OutputRange)
        );
        assert_eq!(
            TerminalOperation::parse("output_range", &range(10, 10, 64)),
            Err(TerminalError::TooLarge)
        );
        assert_eq!(
            TerminalOperation::parse("output_range", &range(10, 20, 64 * 1024 + 1)),
            Err(TerminalError::TooLarge)
        );
    }
}
