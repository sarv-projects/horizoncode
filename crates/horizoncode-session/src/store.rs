//! The append-only log store: create, append, replay, resume, list, close and
//! deterministic interrupted-turn repair.
//!
//! The store is built around one rule from `DEC-056`: **inspection never
//! mutates**. A single pure scanner ([`SessionStore::scan_log`]) reads the log
//! and reports what it found; `read_only`, `scan`, `inspect` and `list` are all
//! built on it and write nothing. Only the explicit repairing load path may
//! reconcile a torn tail, and the durability profile decides what a
//! committed acknowledgement actually flushed (`durability.rs`).

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use horizoncode_types::{Clock, ContentPart, Event, EventKind, SessionId, ToolStatus, TurnId};

use crate::listing::{
    SessionIntegrityState, SessionListEntry, SessionListIssue, SessionListIssueKind,
    SessionListResult,
};
use crate::payload::{
    SessionCreatedPayload, StepEndPayload, ToolResultPayload, TurnEndPayload, TurnEndStatus,
};
use crate::session::{LoadedSession, SessionStatus, summary_from};
use crate::{CURRENT_FORMAT_VERSION, SessionError};
use horizoncode_eventlog::{CommitSink, DurabilityProfile, std_sink};

/// Returns the default `sessions/` root: `<state-root>/sessions`, where the
/// state root is `$HORIZONCODE_HOME` or `~/.horizoncode` (`ARCH/18`).
#[must_use]
pub fn default_sessions_root() -> PathBuf {
    horizoncode_config::state_root().join("sessions")
}

/// The state of a log's final write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TailState {
    /// Every row decoded and the file ends on a row boundary.
    Clean,
    /// The final write was interrupted; its bytes are retained and unreconciled.
    Torn {
        /// How many trailing bytes are incomplete.
        bytes: u64,
    },
}

impl TailState {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Torn { .. } => "torn",
        }
    }
}

/// The outcome of a read-only scan of one log.
#[derive(Clone, Debug, PartialEq)]
pub struct LogScanReport {
    /// The decoded committed rows.
    pub events: Vec<Event>,
    /// What is known about the stored log.
    pub integrity: SessionIntegrityState,
    /// The state of the final write.
    pub tail: TailState,
}

/// What one pure scan found.
struct LogScan {
    events: Vec<Event>,
    header: Option<SessionCreatedPayload>,
    tail: TailState,
}

#[derive(Debug, Default)]
struct StoreState {
    /// Next sequence number to assign, keyed by session id string.
    next_seq: HashMap<String, u64>,
}

/// Owns the on-disk session logs and their in-memory sequence index.
#[derive(Debug)]
pub struct SessionStore {
    root: PathBuf,
    fsync: bool,
    durability: DurabilityProfile,
    sink: Arc<dyn CommitSink>,
    clock: Arc<dyn Clock>,
    state: Mutex<StoreState>,
}

impl SessionStore {
    /// Opens (creating if needed) a session store rooted at `root`.
    ///
    /// # Errors
    /// Returns [`SessionError::Io`] when the directory cannot be created.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, SessionError> {
        let root = root.into();
        horizoncode_config::refuse_symlink(&root)
            .map_err(|error| SessionError::io(&root, error))?;
        fs::create_dir_all(&root).map_err(|error| SessionError::io(&root, error))?;
        horizoncode_config::set_owner_only(&root, horizoncode_config::OwnerOnly::Directory)
            .map_err(|error| SessionError::io(&root, error))?;
        Ok(Self {
            root,
            fsync: true,
            durability: DurabilityProfile::Interactive,
            sink: std_sink(),
            clock: horizoncode_types::system_clock(),
            state: Mutex::new(StoreState::default()),
        })
    }

    /// Opens a store at [`default_sessions_root`].
    ///
    /// # Errors
    /// Returns [`SessionError::Io`] when the directory cannot be created.
    pub fn open_default() -> Result<Self, SessionError> {
        Self::open(default_sessions_root())
    }

    /// Returns the sessions root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Returns the durability profile in force.
    #[must_use]
    pub fn durability(&self) -> DurabilityProfile {
        self.durability
    }

    /// Enables or disables the per-append file sync.
    ///
    /// Durability is on by default (`session.log.fsync`, `ARCH/07-SESSION.md`).
    /// Turning it off is an interactive-only choice: the `run_durable` profile
    /// refuses to coexist with it.
    #[must_use]
    pub fn with_fsync(mut self, fsync: bool) -> Self {
        self.fsync = fsync;
        self
    }

    /// Replaces the clock that stamps records, for deterministic tests.
    #[must_use]
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// Replaces the durability backend.
    #[must_use]
    pub fn with_sink(mut self, sink: Arc<dyn CommitSink>) -> Self {
        self.sink = sink;
        self
    }

    /// Selects the durability profile commits are acknowledged under.
    ///
    /// # Errors
    /// Returns [`SessionError::Durability`] when `run_durable` is requested and
    /// the backend cannot prove the directory-entry step on this host, or when
    /// the per-append sync has been disabled. The refusal is typed: a caller
    /// that needs the crash-durable profile is told, not silently given a weaker
    /// one.
    pub fn with_durability(mut self, profile: DurabilityProfile) -> Result<Self, SessionError> {
        if profile == DurabilityProfile::RunDurable {
            if !self.sink.supports_run_durable() {
                return Err(SessionError::Durability(
                    "run_durable requested but this backend cannot synchronize a directory \
                     entry on this host; use the interactive profile explicitly"
                        .to_owned(),
                ));
            }
            if !self.fsync {
                return Err(SessionError::Durability(
                    "run_durable cannot be combined with a disabled per-append sync".to_owned(),
                ));
            }
        }
        self.durability = profile;
        Ok(self)
    }

    /// Returns the log path for a session.
    #[must_use]
    pub fn log_path(&self, id: &SessionId) -> PathBuf {
        self.root.join(format!("{id}.jsonl"))
    }

    /// Returns whether a session log exists.
    #[must_use]
    pub fn exists(&self, id: &SessionId) -> bool {
        self.log_path(id).is_file()
    }

    /// Creates a new session and durably writes its `session/created` event.
    ///
    /// # Errors
    /// Returns [`SessionError::Io`] on write or sync failure, or
    /// [`SessionError::Payload`] if the header cannot be encoded.
    pub fn create(&self, header: SessionCreatedPayload) -> Result<LoadedSession, SessionError> {
        let id = SessionId::new_v7();
        let path = self.log_path(&id);
        let mut event = Event::payload(EventKind::SessionCreated, &header);
        event.seq = 0;
        event.time = self.clock.now_ms();
        let line = encode(&event)?;
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| SessionError::io(&path, error))?;
        horizoncode_config::set_owner_only(&path, horizoncode_config::OwnerOnly::File)
            .map_err(|error| SessionError::io(&path, error))?;
        let mut file = file;
        file.write_all(line.as_bytes())
            .and_then(|()| file.flush())
            .map_err(|error| SessionError::io(&path, error))?;
        // The acknowledgement follows the file sync and, for `run_durable`, the
        // directory entry: a session whose file is not reachable from the
        // directory is not a created session.
        self.commit_existing_file(&file, &path)?;
        if self.durability == DurabilityProfile::RunDurable {
            self.sink
                .sync_dir(&self.root)
                .map_err(|error| SessionError::io(&self.root, error))?;
        }
        let mut state = self.lock();
        state.next_seq.insert(id.to_string(), 1);
        drop(state);
        LoadedSession::from_events(id, vec![event], &path)
    }

    /// Appends an event to a session log, assigning `seq` and `time`.
    ///
    /// The append is flushed, and synced according to the durability profile,
    /// before returning, so a crash loses no committed step
    /// (`REQ-LOOP-006`).
    ///
    /// # Errors
    /// Returns [`SessionError::NotFound`] for an unknown session and
    /// [`SessionError::Io`]/[`SessionError::Payload`] on failure.
    pub fn append(&self, id: &SessionId, event: Event) -> Result<Event, SessionError> {
        let mut state = self.lock();
        self.ensure_seq(&mut state, id)?;
        let time = self.clock.now_ms();
        self.append_at_locked(&mut state, id, event, time)
    }

    /// Replays a session log and runs the deterministic interrupted-turn
    /// repair.
    ///
    /// This is the **repairing** path: it may truncate an interrupted final
    /// write and append synthetic closers. It must never be used by a read-only
    /// surface; the explicit effect-reconciling recovery operation that replaces
    /// it is `AX-311`.
    ///
    /// # Errors
    /// Returns [`SessionError`] on missing, corrupt or unsupported logs.
    pub fn load(&self, id: &SessionId) -> Result<LoadedSession, SessionError> {
        let mut scan = self.scan_log(id)?;
        if let TailState::Torn { .. } = scan.tail {
            self.repair_torn_tail(id)?;
            scan = self.scan_log(id)?;
        }
        let mut events = scan.events;
        let repairs = plan_repair(&events);
        if repairs.is_empty() {
            let mut state = self.lock();
            self.ensure_seq(&mut state, id)?;
        } else {
            let mut state = self.lock();
            self.ensure_seq(&mut state, id)?;
            for (event, time) in repairs {
                let stored = self.append_at_locked(&mut state, id, event, time)?;
                events.push(stored);
            }
        }
        LoadedSession::from_events(id.clone(), events, &self.log_path(id))
    }

    /// Scans a session log without performing repair.
    ///
    /// The read is byte-preserving: it never truncates a torn tail, appends a
    /// synthetic event, or advances any pointer (`DEC-056`).
    ///
    /// # Errors
    /// Returns [`SessionError`] when the log is missing, unreadable, corrupt, or
    /// written by a newer format version. An interrupted final write is not an
    /// error here: it is reported as `recovery_pending` with its byte count.
    pub fn read_only(&self, id: &SessionId) -> Result<LogScanReport, SessionError> {
        let scan = self.scan_log(id)?;
        let integrity = match scan.tail {
            // An interrupted final write is reported, never repaired here.
            TailState::Torn { .. } => SessionIntegrityState::RecoveryPending,
            TailState::Clean => SessionIntegrityState::Available,
        };
        Ok(LogScanReport {
            integrity,
            tail: scan.tail,
            events: scan.events,
        })
    }

    /// Alias of [`SessionStore::read_only`] for status surfaces.
    ///
    /// # Errors
    /// As [`SessionStore::read_only`].
    pub fn scan(&self, id: &SessionId) -> Result<LogScanReport, SessionError> {
        self.read_only(id)
    }

    /// Appends `session/closed` and returns the closed projection.
    ///
    /// Closing is idempotent.
    ///
    /// # Errors
    /// Returns [`SessionError`] on missing logs or write failure.
    pub fn close(&self, id: &SessionId) -> Result<LoadedSession, SessionError> {
        let session = self.load(id)?;
        if session.status == SessionStatus::Closed {
            return Ok(session);
        }
        let event = Event::payload(
            EventKind::SessionClosed,
            &serde_json::json!({ "reason": "closed" }),
        );
        self.append(id, event)?;
        self.load(id)
    }

    /// Enumerates the store without loading, repairing or truncating any log.
    ///
    /// A store-level failure sets `enumeration_complete = false` and is never
    /// reported as an empty successful list; a per-session failure is a visible
    /// row with its own typed issue (`ARCH/07-SESSION.md`).
    #[must_use]
    pub fn list(&self) -> SessionListResult {
        let mut result = SessionListResult {
            items: Vec::new(),
            enumeration_complete: true,
            issues: Vec::new(),
        };
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) => {
                result.enumeration_complete = false;
                result.issues.push(SessionListIssue::store_level(
                    SessionListIssueKind::DirectoryUnreadable,
                    self.root.clone(),
                    error.to_string(),
                ));
                return result;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    result.enumeration_complete = false;
                    result.issues.push(SessionListIssue::store_level(
                        SessionListIssueKind::IteratorError,
                        self.root.clone(),
                        error.to_string(),
                    ));
                    continue;
                }
            };
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            result
                .items
                .push(self.inspect_session(&SessionId::new(stem)));
        }
        sort_entries(&mut result.items);
        result
    }

    /// Inspects one session, reporting its integrity rather than its absence.
    ///
    /// # Errors
    /// Returns [`SessionError::NotFound`] when no log exists for `id`. Every
    /// other failure is reported as a typed row, so a caller that already knows
    /// the log exists can render the state instead of an error.
    pub fn inspect(&self, id: &SessionId) -> Result<SessionListEntry, SessionError> {
        // Any filesystem entry counts as "present": a log that is a directory,
        // or unreadable for another reason, must be reported as such rather than
        // as an absent session.
        if !self.log_path(id).exists() {
            return Err(SessionError::NotFound(id.clone()));
        }
        Ok(self.inspect_session(id))
    }

    /// Returns the most recently active **readable** session id, if any.
    ///
    /// A corrupt or unreadable session is never silently resumed; the caller is
    /// told by `list()` instead.
    #[must_use]
    pub fn latest(&self) -> Option<SessionId> {
        self.list().available().next().map(|entry| entry.id.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StoreState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Reads one log and reports what it found, writing nothing.
    fn scan_log(&self, id: &SessionId) -> Result<LogScan, SessionError> {
        let path = self.log_path(id);
        horizoncode_config::refuse_symlink(&path)
            .map_err(|error| SessionError::io(&path, error))?;
        let content = fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                SessionError::NotFound(id.clone())
            } else {
                SessionError::io(&path, error)
            }
        })?;
        let mut events: Vec<Event> = Vec::new();
        let mut header: Option<SessionCreatedPayload> = None;
        let mut tail = TailState::Clean;
        let segments: Vec<&[u8]> = split_inclusive(&content);
        let last_index = segments.len().saturating_sub(1);
        for (index, segment) in segments.iter().enumerate() {
            let terminated = segment.last().is_some_and(|byte| *byte == b'\n');
            let text = String::from_utf8_lossy(segment);
            let trimmed = text.trim_end_matches('\n');
            if trimmed.trim().is_empty() {
                if !terminated {
                    tail = TailState::Torn {
                        bytes: segment.len() as u64,
                    };
                }
                continue;
            }
            match serde_json::from_str::<Event>(trimmed) {
                Ok(event) => {
                    if header.is_none() && event.kind == EventKind::SessionCreated {
                        header =
                            Some(event.decode::<SessionCreatedPayload>().map_err(|error| {
                                SessionError::HeaderCorrupt {
                                    path: path.clone(),
                                    message: error.to_string(),
                                }
                            })?);
                    }
                    events.push(event);
                }
                Err(_) if index == last_index && !terminated => {
                    // An interrupted final write is reported, never rewritten.
                    tail = TailState::Torn {
                        bytes: segment.len() as u64,
                    };
                }
                Err(error) => {
                    return Err(SessionError::Corrupt {
                        path,
                        line: index + 1,
                        message: error.to_string(),
                    });
                }
            }
        }
        for (expected, event) in events.iter().enumerate() {
            let expected = expected as u64;
            if event.seq != expected {
                return Err(SessionError::SeqGap {
                    expected,
                    found: event.seq,
                });
            }
        }
        if let Some(header) = &header
            && header.format_version > CURRENT_FORMAT_VERSION
        {
            return Err(SessionError::UnsupportedVersion {
                found: header.format_version,
                supported: CURRENT_FORMAT_VERSION,
            });
        }
        let Some(header) = header else {
            return Err(SessionError::HeaderMissing { path });
        };
        Ok(LogScan {
            events,
            header: Some(header),
            tail,
        })
    }

    /// Builds a listing row, mapping every failure to a typed issue.
    fn inspect_session(&self, id: &SessionId) -> SessionListEntry {
        let path = self.log_path(id);
        let scan = match self.scan_log(id) {
            Ok(scan) => scan,
            Err(error) => {
                let (integrity, kind) = match &error {
                    SessionError::Io { .. } => (
                        SessionIntegrityState::Unreadable,
                        SessionListIssueKind::EntryUnreadable,
                    ),
                    SessionError::Corrupt { line, .. } => {
                        if *line == 1 {
                            (
                                SessionIntegrityState::Corrupt,
                                SessionListIssueKind::HeaderCorrupt,
                            )
                        } else {
                            (
                                SessionIntegrityState::Corrupt,
                                SessionListIssueKind::LogCorrupt,
                            )
                        }
                    }
                    SessionError::HeaderCorrupt { .. } => (
                        SessionIntegrityState::Corrupt,
                        SessionListIssueKind::HeaderCorrupt,
                    ),
                    SessionError::HeaderMissing { .. } => (
                        SessionIntegrityState::Corrupt,
                        SessionListIssueKind::HeaderMissing,
                    ),
                    SessionError::SeqGap { .. } => (
                        SessionIntegrityState::Corrupt,
                        SessionListIssueKind::LogCorrupt,
                    ),
                    SessionError::UnsupportedVersion { .. } => (
                        SessionIntegrityState::Unsupported,
                        SessionListIssueKind::LogUnsupported,
                    ),
                    SessionError::Payload(_) => (
                        SessionIntegrityState::Corrupt,
                        SessionListIssueKind::HeaderCorrupt,
                    ),
                    _ => (
                        SessionIntegrityState::Unknown,
                        SessionListIssueKind::EntryUnreadable,
                    ),
                };
                let mut issue =
                    SessionListIssue::for_session(kind, id.clone(), path, error.to_string());
                if let SessionError::Corrupt { line, .. } = &error {
                    issue = issue.at_line(*line);
                }
                return SessionListEntry {
                    id: id.clone(),
                    summary: None,
                    integrity,
                    issue: Some(issue),
                };
            }
        };
        let torn = matches!(scan.tail, TailState::Torn { .. });
        let header = scan.header.clone().unwrap_or_else(|| {
            unreachable!("scan_log resolves the header or returns a typed error")
        });
        let summary = summary_from(id.clone(), &header, &scan.events);
        let integrity = if torn {
            SessionIntegrityState::RecoveryPending
        } else {
            SessionIntegrityState::Available
        };
        let issue = if torn {
            Some(
                SessionListIssue::for_session(
                    SessionListIssueKind::TailTorn,
                    id.clone(),
                    path,
                    "the final write was interrupted; its bytes are retained and unreconciled"
                        .to_owned(),
                )
                .affecting_bytes(scan.tail_bytes()),
            )
        } else {
            None
        };
        SessionListEntry {
            id: id.clone(),
            summary: Some(summary),
            integrity,
            issue,
        }
    }

    /// Truncates an interrupted final write so a later append cannot glue onto
    /// a partial row.
    ///
    /// This is reachable only from the explicit repairing path; a read-only
    /// surface never calls it (`DEC-056`). It is deliberately *not* the
    /// recovery operation the architecture specifies: that one preserves and
    /// hashes the source bytes, reconciles effect ids, and writes a new
    /// generation (`AX-311`).
    fn repair_torn_tail(&self, id: &SessionId) -> Result<(), SessionError> {
        let path = self.log_path(id);
        let scan = self.scan_log(id)?;
        let TailState::Torn { bytes } = scan.tail else {
            return Ok(());
        };
        let metadata = fs::metadata(&path).map_err(|error| SessionError::io(&path, error))?;
        let keep = metadata.len().saturating_sub(bytes);
        let file = OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|error| SessionError::io(&path, error))?;
        file.set_len(keep)
            .map_err(|error| SessionError::io(&path, error))?;
        if self.fsync {
            self.sink
                .sync_file(&file)
                .map_err(|error| SessionError::io(&path, error))?;
        }
        drop(file);
        if self.durability == DurabilityProfile::RunDurable {
            self.sink
                .sync_dir(&self.root)
                .map_err(|error| SessionError::io(&self.root, error))?;
        }
        Ok(())
    }

    fn ensure_seq(&self, state: &mut StoreState, id: &SessionId) -> Result<(), SessionError> {
        if state.next_seq.contains_key(id.as_str()) {
            return Ok(());
        }
        let scan = self.scan_log(id)?;
        let next = scan
            .events
            .last()
            .map_or(0, |event| event.seq.saturating_add(1));
        state.next_seq.insert(id.to_string(), next);
        Ok(())
    }

    fn append_at_locked(
        &self,
        state: &mut StoreState,
        id: &SessionId,
        mut event: Event,
        time: i64,
    ) -> Result<Event, SessionError> {
        let path = self.log_path(id);
        horizoncode_config::refuse_symlink(&path)
            .map_err(|error| SessionError::io(&path, error))?;
        if !path.is_file() {
            return Err(SessionError::NotFound(id.clone()));
        }
        let next = state.next_seq.entry(id.to_string()).or_insert(0);
        event.seq = *next;
        event.time = time;
        *next = next.saturating_add(1);
        let line = encode(&event)?;
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|error| SessionError::io(&path, error))?;
        let mut file = file;
        file.write_all(line.as_bytes())
            .and_then(|()| file.flush())
            .map_err(|error| SessionError::io(&path, error))?;
        self.commit_existing_file(&file, &path)?;
        Ok(event)
    }

    /// Syncs an already-existing log according to the durability profile.
    ///
    /// Creating a file changes the *directory*; appending to one does not, so
    /// only the file sync applies here.
    fn commit_existing_file(&self, file: &std::fs::File, path: &Path) -> Result<(), SessionError> {
        if !self.fsync {
            return Ok(());
        }
        self.sink
            .sync_file(file)
            .map_err(|error| SessionError::io(path, error))
    }
}

impl LogScan {
    /// Returns the retained incomplete-tail byte count, when there is one.
    fn tail_bytes(&self) -> u64 {
        match self.tail {
            TailState::Torn { bytes } => bytes,
            TailState::Clean => 0,
        }
    }
}

/// Splits raw bytes on newlines, keeping the terminator with each row.
fn split_inclusive(content: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut start = 0usize;
    for (index, byte) in content.iter().enumerate() {
        if *byte == b'\n' {
            out.push(&content[start..=index]);
            start = index + 1;
        }
    }
    if start < content.len() {
        out.push(&content[start..]);
    }
    out
}

/// Sorts listing rows deterministically: newest activity first, then id, with
/// entries that have no projection after every projected entry.
fn sort_entries(entries: &mut [SessionListEntry]) {
    entries.sort_by(|left, right| {
        let left_key = left
            .summary
            .as_ref()
            .map(|summary| (0u8, std::cmp::Reverse(summary.last_active_at)));
        let right_key = right
            .summary
            .as_ref()
            .map(|summary| (0u8, std::cmp::Reverse(summary.last_active_at)));
        match (left_key, right_key) {
            (Some(l), Some(r)) => l
                .cmp(&r)
                .then_with(|| left.id.as_str().cmp(right.id.as_str())),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => left.id.as_str().cmp(right.id.as_str()),
        }
    });
}

fn encode(event: &Event) -> Result<String, SessionError> {
    let mut line =
        serde_json::to_string(event).map_err(|error| SessionError::Payload(error.to_string()))?;
    line.push('\n');
    Ok(line)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Plans the synthetic closer events for an interrupted turn.
///
/// The plan is pure: it inspects the log and returns the events to append with
/// the last real event's timestamp so repair is byte-deterministic for a given
/// log (`REQ-SESS-002`).
fn plan_repair(events: &[Event]) -> Vec<(Event, i64)> {
    let last_time = events.last().map_or_else(now_ms, |event| event.time);
    let mut out = Vec::new();

    // 1. Fail any tool call that recorded no durable result.
    let pending = {
        let mut calls: HashMap<String, (TurnId, horizoncode_types::ToolCall)> = HashMap::new();
        for event in events {
            match event.kind {
                EventKind::ToolCall => {
                    if let Ok(payload) = event.decode::<crate::payload::ToolCallPayload>() {
                        calls.insert(
                            payload.tool_call.id.to_string(),
                            (payload.turn_id, payload.tool_call),
                        );
                    }
                }
                EventKind::ToolResult => {
                    if let Ok(payload) = event.decode::<ToolResultPayload>() {
                        calls.remove(payload.tool_call_id.as_str());
                    }
                }
                _ => {}
            }
        }
        let mut pending: Vec<_> = calls.into_values().collect();
        pending.sort_by(|a, b| a.1.id.as_str().cmp(b.1.id.as_str()));
        pending
    };
    for (turn_id, call) in pending {
        let text = format!(
            "Tool call `{}` did not record a result before the session stopped. \
             Its outcome is unknown; retry only if the operation is read-only or idempotent, \
             otherwise verify the workspace before continuing.",
            call.name
        );
        out.push((
            Event::payload(
                EventKind::ToolResult,
                &ToolResultPayload {
                    turn_id,
                    tool_call_id: call.id,
                    status: ToolStatus::Error,
                    model_content: vec![ContentPart::text(text)],
                    error_code: Some("TOOL_OUTCOME_UNKNOWN".to_owned()),
                    ui_detail: None,
                },
            ),
            last_time,
        ));
    }

    // 2. Close any open step.
    let mut depth: i64 = 0;
    let mut last_turn: Option<TurnId> = None;
    let mut last_step: u64 = 0;
    for event in events {
        match event.kind {
            EventKind::TurnStart => {
                last_turn = event
                    .decode::<crate::payload::TurnStartPayload>()
                    .ok()
                    .map(|payload| payload.turn_id);
                last_step = 0;
            }
            EventKind::StepStart => {
                depth += 1;
                if let Ok(payload) = event.decode::<crate::payload::StepStartPayload>() {
                    last_step = payload.step;
                }
            }
            EventKind::StepEnd => depth -= 1,
            _ => {}
        }
    }
    if depth > 0
        && let Some(turn_id) = last_turn.clone()
    {
        while depth > 0 {
            out.push((
                Event::payload(
                    EventKind::StepEnd,
                    &StepEndPayload {
                        turn_id: turn_id.clone(),
                        step: last_step,
                        input_tokens: 0,
                        output_tokens: 0,
                        cached_read_tokens: 0,
                        cached_write_tokens: 0,
                        reasoning_tokens: 0,
                        tools_disabled: false,
                    },
                ),
                last_time,
            ));
            depth -= 1;
        }
    }

    // 3. Close any open turn.
    let open_turn = {
        let mut open: Option<TurnId> = None;
        for event in events {
            match event.kind {
                EventKind::TurnStart => {
                    open = event
                        .decode::<crate::payload::TurnStartPayload>()
                        .ok()
                        .map(|payload| payload.turn_id);
                }
                EventKind::TurnEnd => open = None,
                _ => {}
            }
        }
        open
    };
    if let Some(turn_id) = open_turn {
        out.push((
            Event::payload(
                EventKind::TurnEnd,
                &TurnEndPayload {
                    turn_id,
                    status: TurnEndStatus::Interrupted,
                    reason: "crash recovery".to_owned(),
                    final_text: None,
                },
            ),
            last_time,
        ));
    }

    out
}
