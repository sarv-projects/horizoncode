//! Read-only projection of OpenCode EventV2 SQLite session events.
//!
//! OpenCode remains the authoritative Session/Message/Part owner. This store keeps
//! only immutable correlation metadata and a replay cursor, never a second transcript.
//! The source connection is supplied by the caller and MUST be opened read-only.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

use crate::messagepack::Value as RpcValue;
use crate::protocol::{
    CursorV1, FrameFence, ProtocolError, RpcControlV1, RpcEventV1, RpcMessageV1,
};

const MAX_BATCH: usize = 4096;
const MAX_DATA_BYTES: usize = 16 * 1024 * 1024;
const MAX_SUBSCRIPTION_PAGE: usize = 256;
const BASE_SESSION_CURSOR_DIGEST: &str =
    "blake3:0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug)]
pub enum ProjectionError {
    Sql(rusqlite::Error),
    Invalid(&'static str),
    SourceGap {
        session_id: String,
        expected: i64,
        found: i64,
    },
    SourceDrift {
        session_id: String,
        sequence: i64,
    },
    LinkConflict,
}

#[derive(Debug)]
pub enum SubscriptionPageError {
    Projection(ProjectionError),
    Protocol(ProtocolError),
    Invalid(&'static str),
    CursorConflict,
    ResnapshotRequired,
    SourceGap { expected: i64, found: i64 },
}

impl fmt::Display for SubscriptionPageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Projection(error) => write!(f, "session projection: {error}"),
            Self::Protocol(error) => write!(f, "session subscription message: {error}"),
            Self::Invalid(reason) => write!(f, "invalid session subscription: {reason}"),
            Self::CursorConflict => {
                f.write_str("session subscription cursor conflicts with history")
            }
            Self::ResnapshotRequired => {
                f.write_str("session subscription cursor is outside retained projection history")
            }
            Self::SourceGap { expected, found } => {
                write!(
                    f,
                    "projected session event gap: expected {expected}, found {found}"
                )
            }
        }
    }
}

impl std::error::Error for SubscriptionPageError {}

impl From<ProjectionError> for SubscriptionPageError {
    fn from(error: ProjectionError) -> Self {
        Self::Projection(error)
    }
}

impl From<rusqlite::Error> for SubscriptionPageError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Projection(ProjectionError::Sql(error))
    }
}

impl From<ProtocolError> for SubscriptionPageError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

pub struct SessionSubscriptionPage {
    pub events: Vec<RpcEventV1>,
    pub has_more: bool,
}

impl fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql(error) => write!(f, "SQLite: {error}"),
            Self::Invalid(reason) => write!(f, "invalid OpenCode event: {reason}"),
            Self::SourceGap {
                session_id,
                expected,
                found,
            } => write!(
                f,
                "session {session_id} has event gap: expected {expected}, got {found}"
            ),
            Self::SourceDrift {
                session_id,
                sequence,
            } => write!(
                f,
                "source history changed for session {session_id}, seq {sequence}"
            ),
            Self::LinkConflict => {
                f.write_str("session/run link already references a different identity")
            }
        }
    }
}

impl std::error::Error for ProjectionError {}
impl From<rusqlite::Error> for ProjectionError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value)
    }
}

pub type Result<T> = std::result::Result<T, ProjectionError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCursor {
    pub session_id: String,
    pub last_seq: i64,
    pub count: u64,
    pub last_event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncReport {
    pub imported: usize,
    pub cursor: SessionCursor,
}

pub type SessionEventCorrelation = (String, Option<String>, Option<String>);

#[derive(Debug)]
struct SourceEvent {
    id: String,
    session_id: String,
    seq: i64,
    kind: String,
    data: String,
}

fn valid_identity(input: &str) -> bool {
    !input.is_empty()
        && input.len() <= 256
        && input
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_:.-".contains(&c))
}

fn event_hash(event: &SourceEvent) -> String {
    let mut h = blake3::Hasher::new();
    for item in [&event.id, &event.session_id, &event.kind, &event.data] {
        h.update(&(item.len() as u64).to_le_bytes());
        h.update(item.as_bytes());
    }
    h.update(&event.seq.to_le_bytes());
    h.finalize().to_hex().to_string()
}

fn validate(event: &SourceEvent, expected_session: &str) -> Result<Value> {
    if event.session_id != expected_session
        || !valid_identity(&event.session_id)
        || !valid_identity(&event.id)
        || !valid_identity(&event.kind)
        || event.seq < 0
    {
        return Err(ProjectionError::Invalid("invalid identifiers or sequence"));
    }
    if event.data.len() > MAX_DATA_BYTES {
        return Err(ProjectionError::Invalid("oversized payload"));
    }
    let parsed: Value = serde_json::from_str(&event.data)
        .map_err(|_| ProjectionError::Invalid("payload is not JSON"))?;
    if !parsed.is_object() {
        return Err(ProjectionError::Invalid("payload is not an object"));
    }
    Ok(parsed)
}

fn optional_identity(data: &Value, field: &str) -> Result<Option<String>> {
    let Some(v) = data.get(field) else {
        return Ok(None);
    };
    let Some(s) = v.as_str() else {
        return Err(ProjectionError::Invalid("correlation ID is not a string"));
    };
    if !valid_identity(s) {
        return Err(ProjectionError::Invalid("invalid correlation ID"));
    }
    Ok(Some(s.to_owned()))
}

fn extract_message_id(data: &Value) -> Result<Option<String>> {
    if let Some(v) = optional_identity(data, "messageID")? {
        return Ok(Some(v));
    }
    optional_identity(data, "assistantMessageID")
}

/// Durable, independently rebuildable read model; cannot issue Session commands.
pub struct SessionProjection {
    db: Connection,
}

impl SessionProjection {
    pub fn open(db: Connection) -> Result<Self> {
        db.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS hc_session_cursor (
                session_id TEXT PRIMARY KEY,
                last_seq INTEGER NOT NULL DEFAULT -1,
                last_event_id TEXT,
                event_count INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS hc_session_receipts (
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                source_event_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                event_hash TEXT NOT NULL,
                message_id TEXT,
                tool_call_id TEXT,
                PRIMARY KEY (session_id, seq),
                UNIQUE(source_event_id)
             );
             CREATE TABLE IF NOT EXISTS hc_session_attempt_link (
                attempt_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                run_id TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS hc_session_receipts_kind
                ON hc_session_receipts(session_id,kind,seq);",
        )?;
        Ok(Self { db })
    }

    pub fn cursor(&self, session_id: &str) -> Result<SessionCursor> {
        if !valid_identity(session_id) {
            return Err(ProjectionError::Invalid("session ID"));
        }
        Ok(self.db.query_row(
            "SELECT last_seq,event_count,last_event_id FROM hc_session_cursor WHERE session_id=?1",
            [session_id],
            |r| Ok(SessionCursor {
                session_id: session_id.to_owned(),
                last_seq: r.get(0)?,
                count: r.get::<_, i64>(1)? as u64,
                last_event_id: r.get(2)?,
            })
        ).optional()?.unwrap_or(SessionCursor {
            session_id: session_id.to_owned(), last_seq: -1, count: 0, last_event_id: None
        }))
    }

    /// Returns the exact current projection cursor, or the stable before-first-event
    /// cursor when this Session has no projected events yet.
    pub fn subscription_cursor(&self, session_id: &str) -> Result<CursorV1> {
        let current = self.cursor(session_id)?;
        if current.last_seq < 0 {
            return Ok(CursorV1 {
                owner_kind: "session".to_owned(),
                owner_id: session_id.to_owned(),
                seq: "0".to_owned(),
                event_digest: BASE_SESSION_CURSOR_DIGEST.to_owned(),
            });
        }
        let event_hash: String = self.db.query_row(
            "SELECT event_hash FROM hc_session_receipts WHERE session_id=?1 AND seq=?2",
            params![session_id, current.last_seq],
            |row| row.get(0),
        )?;
        let seq = current
            .last_seq
            .checked_add(1)
            .ok_or(ProjectionError::Invalid("subscription cursor overflow"))?;
        Ok(CursorV1 {
            owner_kind: "session".to_owned(),
            owner_id: session_id.to_owned(),
            seq: seq.to_string(),
            event_digest: format!("blake3:{event_hash}"),
        })
    }

    /// Read a bounded, redacted page after an exact projection cursor. Source prompt
    /// payloads are never stored in or returned from the Session projection.
    pub fn subscription_page(
        &self,
        subscription_id: &str,
        after: &CursorV1,
        limit: usize,
        fence: &FrameFence,
    ) -> std::result::Result<SessionSubscriptionPage, SubscriptionPageError> {
        if !(1..=MAX_SUBSCRIPTION_PAGE).contains(&limit) {
            return Err(SubscriptionPageError::Invalid("page size"));
        }
        fence.validate_message(&RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
            owner_epoch: fence.owner_epoch(),
            process_incarnation: fence.process_incarnation().to_owned(),
            subscription_id: subscription_id.to_owned(),
            owner_kind: "session".to_owned(),
            owner_id: after.owner_id.clone(),
            after: Some(after.clone()),
        })))?;
        if after.owner_kind != "session" || !valid_identity(&after.owner_id) {
            return Err(SubscriptionPageError::Invalid("owner identity"));
        }
        let after_seq: u64 = after
            .seq
            .parse()
            .map_err(|_| SubscriptionPageError::Invalid("cursor sequence"))?;
        let source_after = if after_seq == 0 {
            if after.event_digest != BASE_SESSION_CURSOR_DIGEST {
                return Err(SubscriptionPageError::CursorConflict);
            }
            -1
        } else {
            let source_seq_u64 = after_seq - 1;
            let source_seq = i64::try_from(source_seq_u64)
                .map_err(|_| SubscriptionPageError::Invalid("cursor sequence"))?;
            let stored = self
                .db
                .query_row(
                    "SELECT event_hash FROM hc_session_receipts WHERE session_id=?1 AND seq=?2",
                    params![after.owner_id, source_seq],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(stored) = stored else {
                let latest = self.subscription_cursor(&after.owner_id)?;
                let latest_seq: u64 = latest
                    .seq
                    .parse()
                    .map_err(|_| SubscriptionPageError::Invalid("projection cursor"))?;
                return if after_seq < latest_seq {
                    Err(SubscriptionPageError::ResnapshotRequired)
                } else {
                    Err(SubscriptionPageError::CursorConflict)
                };
            };
            if after.event_digest != format!("blake3:{stored}") {
                return Err(SubscriptionPageError::CursorConflict);
            }
            source_seq
        };

        let mut statement = self.db.prepare(
            "SELECT seq,source_event_id,kind,event_hash,message_id,tool_call_id
             FROM hc_session_receipts WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = statement
            .query_map(
                params![after.owner_id, source_after, (limit + 1) as i64],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let has_more = rows.len() > limit;
        let rows = rows.into_iter().take(limit);
        let mut expected = source_after
            .checked_add(1)
            .ok_or(SubscriptionPageError::Invalid("source sequence overflow"))?;
        let mut events = Vec::with_capacity(limit);
        for (seq, event_id, kind, digest, message_id, tool_call_id) in rows {
            if seq != expected {
                return Err(SubscriptionPageError::SourceGap {
                    expected,
                    found: seq,
                });
            }
            if !valid_identity(&event_id) || !valid_identity(&kind) {
                return Err(SubscriptionPageError::Invalid("projected event identity"));
            }
            let mut payload = BTreeMap::new();
            payload.insert("eventID".to_owned(), RpcValue::String(event_id));
            if let Some(message_id) = message_id {
                if !valid_identity(&message_id) {
                    return Err(SubscriptionPageError::Invalid("projected message ID"));
                }
                payload.insert("messageID".to_owned(), RpcValue::String(message_id));
            }
            if let Some(call_id) = tool_call_id {
                if !valid_identity(&call_id) {
                    return Err(SubscriptionPageError::Invalid("projected call ID"));
                }
                payload.insert("callID".to_owned(), RpcValue::String(call_id));
            }
            let cursor_seq = seq.checked_add(1).ok_or(SubscriptionPageError::Invalid(
                "subscription cursor overflow",
            ))?;
            let event = RpcEventV1 {
                owner_epoch: fence.owner_epoch(),
                process_incarnation: fence.process_incarnation().to_owned(),
                subscription_id: subscription_id.to_owned(),
                cursor: CursorV1 {
                    owner_kind: "session".to_owned(),
                    owner_id: after.owner_id.clone(),
                    seq: cursor_seq.to_string(),
                    event_digest: format!("blake3:{digest}"),
                },
                event_type: kind,
                payload: RpcValue::Map(payload),
            };
            fence.validate_message(&RpcMessageV1::Event(Box::new(event.clone())))?;
            events.push(event);
            expected = expected
                .checked_add(1)
                .ok_or(SubscriptionPageError::Invalid("source sequence overflow"))?;
        }
        Ok(SessionSubscriptionPage { events, has_more })
    }

    /// A run-to-session link is observational, not permission to mutate OpenCode.
    pub fn link_attempt(&mut self, attempt_id: &str, run_id: &str, session_id: &str) -> Result<()> {
        if !valid_identity(attempt_id) || !valid_identity(run_id) || !valid_identity(session_id) {
            return Err(ProjectionError::Invalid("attempt/run/session ID"));
        }
        self.db.execute(
            "INSERT INTO hc_session_attempt_link(attempt_id,run_id,session_id) VALUES(?1,?2,?3)
             ON CONFLICT(attempt_id) DO NOTHING",
            params![attempt_id, run_id, session_id],
        )?;
        let current: (String, String) = self.db.query_row(
            "SELECT run_id,session_id FROM hc_session_attempt_link WHERE attempt_id=?1",
            [attempt_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if current != (run_id.to_owned(), session_id.to_owned()) {
            return Err(ProjectionError::LinkConflict);
        }
        Ok(())
    }

    /// Consume the actual OpenCode `event` table in sequence, without writing to it.
    ///
    /// Callers open source with SQLITE_OPEN_READ_ONLY. Each batch commits all
    /// receipt rows and its cursor in a single projection transaction.
    pub fn sync(
        &mut self,
        source: &Connection,
        session_id: &str,
        limit: usize,
    ) -> Result<SyncReport> {
        if !valid_identity(session_id) {
            return Err(ProjectionError::Invalid("session ID"));
        }
        if limit == 0 || limit > MAX_BATCH {
            return Err(ProjectionError::Invalid("batch size"));
        }
        let before = self.cursor(session_id)?;
        // Pin a consistent WAL snapshot across boundary verification and the
        // next event batch. Concurrent OpenCode writes become visible on the
        // next sync, never midway through a single reconciliation attempt.
        let source_snapshot = source.unchecked_transaction()?;

        // Recheck the replay boundary before moving it. A replaced OpenCode DB
        // must never be silently interpreted as continuation of older history.
        if before.last_seq >= 0 {
            let boundary = source_snapshot
                .query_row(
                    "SELECT id,aggregate_id,seq,type,data FROM event
                 WHERE aggregate_id=?1 AND seq=?2",
                    params![session_id, before.last_seq],
                    |r| {
                        Ok(SourceEvent {
                            id: r.get(0)?,
                            session_id: r.get(1)?,
                            seq: r.get(2)?,
                            kind: r.get(3)?,
                            data: r.get(4)?,
                        })
                    },
                )
                .optional()?;
            let stored: String = self.db.query_row(
                "SELECT event_hash FROM hc_session_receipts WHERE session_id=?1 AND seq=?2",
                params![session_id, before.last_seq],
                |r| r.get(0),
            )?;
            if boundary.as_ref().map(event_hash).as_deref() != Some(stored.as_str()) {
                return Err(ProjectionError::SourceDrift {
                    session_id: session_id.to_owned(),
                    sequence: before.last_seq,
                });
            }
        }

        let events = {
            let mut stmt = source_snapshot.prepare(
                "SELECT id,aggregate_id,seq,type,data FROM event
                 WHERE aggregate_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![session_id, before.last_seq, limit as i64], |r| {
                Ok(SourceEvent {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    seq: r.get(2)?,
                    kind: r.get(3)?,
                    data: r.get(4)?,
                })
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };

        // Validate everything before starting a write transaction: malformed or
        // reordered history cannot partially move the cursor.
        let first_expected = before
            .last_seq
            .checked_add(1)
            .ok_or(ProjectionError::Invalid("source sequence overflow"))?;
        let mut validated = Vec::with_capacity(events.len());
        for (offset, event) in events.iter().enumerate() {
            let expected = first_expected
                .checked_add(offset as i64)
                .ok_or(ProjectionError::Invalid("source sequence overflow"))?;
            if event.seq != expected {
                return Err(ProjectionError::SourceGap {
                    session_id: session_id.to_owned(),
                    expected,
                    found: event.seq,
                });
            }
            let data = validate(event, session_id)?;
            validated.push((
                event_hash(event),
                extract_message_id(&data)?,
                optional_identity(&data, "callID")?,
            ));
        }

        source_snapshot.commit()?;
        if events.is_empty() {
            return Ok(SyncReport {
                imported: 0,
                cursor: before,
            });
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (event, (digest, message_id, call_id)) in events.iter().zip(&validated) {
            tx.execute(
                "INSERT INTO hc_session_receipts
                 (session_id,seq,source_event_id,kind,event_hash,message_id,tool_call_id)
                 VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    session_id, event.seq, event.id, event.kind, digest, message_id, call_id
                ],
            )?;
        }
        let final_event = events.last().expect("nonempty");
        tx.execute(
            "INSERT INTO hc_session_cursor(session_id,last_seq,last_event_id,event_count)
             VALUES(?1,?2,?3,?4)
             ON CONFLICT(session_id) DO UPDATE SET last_seq=excluded.last_seq,
             last_event_id=excluded.last_event_id,
             event_count=hc_session_cursor.event_count+excluded.event_count",
            params![
                session_id,
                final_event.seq,
                final_event.id,
                events.len() as i64
            ],
        )?;
        tx.commit()?;
        Ok(SyncReport {
            imported: events.len(),
            cursor: self.cursor(session_id)?,
        })
    }

    pub fn event_count(&self, session_id: &str) -> Result<u64> {
        Ok(self.cursor(session_id)?.count)
    }

    /// For bounded diagnostics and tests; content is intentionally never stored.
    pub fn correlation(
        &self,
        session_id: &str,
        seq: i64,
    ) -> Result<Option<SessionEventCorrelation>> {
        Ok(self.db.query_row(
            "SELECT kind,message_id,tool_call_id FROM hc_session_receipts WHERE session_id=?1 AND seq=?2",
            params![session_id,seq],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))
        ).optional()?)
    }
}
