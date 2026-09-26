//! The append-only log store: create, append, replay, resume, list, close and
//! deterministic interrupted-turn repair.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use agentx_types::{ContentPart, Event, EventKind, SessionId, ToolStatus, TurnId};

use crate::payload::{
    SessionCreatedPayload, StepEndPayload, ToolResultPayload, TurnEndPayload, TurnEndStatus,
};
use crate::session::{LoadedSession, SessionStatus, SessionSummary};
use crate::{CURRENT_FORMAT_VERSION, SessionError};

/// Returns the default `sessions/` root: `$AGENTX_HOME/sessions` when
/// `AGENTX_HOME` is set, otherwise `~/.agentx/sessions`.
#[must_use]
pub fn default_sessions_root() -> PathBuf {
    let base = std::env::var_os("AGENTX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("sessions")
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
    state: Mutex<StoreState>,
}

impl SessionStore {
    /// Opens (creating if needed) a session store rooted at `root`.
    ///
    /// # Errors
    /// Returns [`SessionError::Io`] when the directory cannot be created.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, SessionError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|error| SessionError::io(&root, error))?;
        Ok(Self {
            root,
            fsync: true,
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

    /// Enables or disables `fsync` on every append.
    ///
    /// Durability is on by default (`session.log.fsync`, `ARCH/07-SESSION.md`).
    #[must_use]
    pub fn with_fsync(mut self, fsync: bool) -> Self {
        self.fsync = fsync;
        self
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
    /// Returns [`SessionError::Io`] on write failure or [`SessionError::Payload`]
    /// if the header cannot be encoded.
    pub fn create(&self, header: SessionCreatedPayload) -> Result<LoadedSession, SessionError> {
        let id = SessionId::new_v7();
        let path = self.log_path(&id);
        let mut event = Event::payload(EventKind::SessionCreated, &header);
        event.seq = 0;
        event.time = now_ms();
        let line = encode(&event)?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| SessionError::io(&path, error))?;
        file.write_all(line.as_bytes())
            .and_then(|()| file.flush())
            .and_then(|()| if self.fsync { file.sync_data() } else { Ok(()) })
            .map_err(|error| SessionError::io(&path, error))?;
        let mut state = self.lock();
        state.next_seq.insert(id.to_string(), 1);
        drop(state);
        LoadedSession::from_events(id, vec![event])
    }

    /// Appends an event to a session log, assigning `seq` and `time`.
    ///
    /// The append is flushed (and `fsync`ed by default) before returning so a
    /// crash loses no committed step (`REQ-LOOP-006`).
    ///
    /// # Errors
    /// Returns [`SessionError::NotFound`] for an unknown session and
    /// [`SessionError::Io`]/[`SessionError::Payload`] on failure.
    pub fn append(&self, id: &SessionId, event: Event) -> Result<Event, SessionError> {
        let mut state = self.lock();
        self.ensure_seq(&mut state, id)?;
        let time = now_ms();
        self.append_at_locked(&mut state, id, event, time)
    }

    /// Replays a session log, running deterministic interrupted-turn repair
    /// first (`ARCH/07-SESSION.md` §10).
    ///
    /// # Errors
    /// Returns [`SessionError`] on missing, corrupt or unsupported logs.
    pub fn load(&self, id: &SessionId) -> Result<LoadedSession, SessionError> {
        let mut events = self.read_events(id)?;
        let repairs = plan_repair(&events);
        if !repairs.is_empty() {
            let mut state = self.lock();
            self.ensure_seq(&mut state, id)?;
            for (event, time) in repairs {
                let stored = self.append_at_locked(&mut state, id, event, time)?;
                events.push(stored);
            }
        } else {
            let mut state = self.lock();
            self.ensure_seq(&mut state, id)?;
        }
        LoadedSession::from_events(id.clone(), events)
    }

    /// Replays a session log without performing repair.
    ///
    /// # Errors
    /// Returns [`SessionError`] on missing, corrupt or unsupported logs.
    pub fn read_only(&self, id: &SessionId) -> Result<Vec<Event>, SessionError> {
        self.read_events(id)
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

    /// Lists session summaries, newest activity first.
    ///
    /// Unreadable logs are skipped so one corrupt artifact cannot break the
    /// listing; `load` still reports them explicitly.
    #[must_use]
    pub fn list(&self) -> Vec<SessionSummary> {
        let mut summaries = Vec::new();
        let Ok(entries) = fs::read_dir(&self.root) else {
            return summaries;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let id = SessionId::new(stem);
            if let Ok(session) = self.load(&id) {
                summaries.push(session.summary());
            }
        }
        summaries.sort_by(|a, b| {
            b.last_active_at
                .cmp(&a.last_active_at)
                .then_with(|| b.id.as_str().cmp(a.id.as_str()))
        });
        summaries
    }

    /// Returns the most recently active session id, if any.
    #[must_use]
    pub fn latest(&self) -> Option<SessionId> {
        self.list().into_iter().next().map(|summary| summary.id)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StoreState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn ensure_seq(&self, state: &mut StoreState, id: &SessionId) -> Result<(), SessionError> {
        if state.next_seq.contains_key(id.as_str()) {
            return Ok(());
        }
        let events = self.read_events(id)?;
        let next = events.last().map_or(0, |event| event.seq.saturating_add(1));
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
        if !path.is_file() {
            return Err(SessionError::NotFound(id.clone()));
        }
        let next = state.next_seq.entry(id.to_string()).or_insert(0);
        event.seq = *next;
        event.time = time;
        *next = next.saturating_add(1);
        let line = encode(&event)?;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|error| SessionError::io(&path, error))?;
        file.write_all(line.as_bytes())
            .and_then(|()| file.flush())
            .and_then(|()| if self.fsync { file.sync_data() } else { Ok(()) })
            .map_err(|error| SessionError::io(&path, error))?;
        Ok(event)
    }

    fn read_events(&self, id: &SessionId) -> Result<Vec<Event>, SessionError> {
        let path = self.log_path(id);
        let content = fs::read_to_string(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                SessionError::NotFound(id.clone())
            } else {
                SessionError::io(&path, error)
            }
        })?;
        let mut events: Vec<Event> = Vec::new();
        let segments: Vec<&str> = content.split_inclusive('\n').collect();
        let last_index = segments.len().saturating_sub(1);
        // Bytes of the prefix that decoded cleanly. A torn final write is
        // truncated from the file so a later append cannot glue onto it.
        let mut consumed: usize = 0;
        let mut torn = false;
        for (index, segment) in segments.iter().enumerate() {
            let terminated = segment.ends_with('\n');
            let trimmed = segment.trim_end_matches('\n');
            if trimmed.trim().is_empty() {
                consumed += segment.len();
                continue;
            }
            match serde_json::from_str::<Event>(trimmed) {
                Ok(event) => {
                    consumed += segment.len();
                    events.push(event);
                }
                Err(error) => {
                    if index == last_index && !terminated {
                        torn = true;
                        break;
                    }
                    return Err(SessionError::Corrupt {
                        path,
                        line: index + 1,
                        message: error.to_string(),
                    });
                }
            }
        }
        if torn && consumed < content.len() {
            let file = OpenOptions::new()
                .write(true)
                .open(&path)
                .map_err(|error| SessionError::io(&path, error))?;
            file.set_len(consumed as u64)
                .map_err(|error| SessionError::io(&path, error))?;
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
        if let Some(created) = events
            .iter()
            .find(|event| event.kind == EventKind::SessionCreated)
            && let Ok(header) = created.decode::<SessionCreatedPayload>()
        {
            let found = header.format_version;
            if found > CURRENT_FORMAT_VERSION {
                return Err(SessionError::UnsupportedVersion {
                    found,
                    supported: CURRENT_FORMAT_VERSION,
                });
            }
        }
        Ok(events)
    }
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
        let mut calls: HashMap<String, (TurnId, agentx_types::ToolCall)> = HashMap::new();
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
