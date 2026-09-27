//! The derived SQLite rollups (`session_usage`, `session_model_usage`,
//! `tool_stats`, `daily_rollup`, `pricing_snapshot`).
//!
//! The ledger is the source of truth; these tables are a **cache** of it. Every
//! one of them can be dropped and rebuilt, and [`Rollups::rebuild`] is the
//! single code path that does so, which is what makes "rollups are correct after
//! a rebuild" a checkable property rather than a claim.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::config::AnalyticsConfig;
use crate::cost::{CostStatus, PricingSnapshot, ResolvedCost, resolve};
use crate::error::AnalyticsError;
use crate::event::{AnalyticsEvent, EventKind, ToolOutcomeKind};
use crate::ledger::read_ledger;

/// The schema version of the rollup index.
pub const ROLLUP_SCHEMA_VERSION: u32 = 1;

/// The derived rollup index.
#[derive(Debug)]
pub struct Rollups {
    connection: Connection,
}

impl Rollups {
    /// Opens (creating if needed) the rollup index at `path`.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] when the database cannot be opened or
    /// migrated.
    pub fn open(path: &Path) -> Result<Self, AnalyticsError> {
        let connection = Connection::open(path).map_err(|error| AnalyticsError::sqlite(&error))?;
        let rollups = Self { connection };
        rollups.migrate()?;
        Ok(rollups)
    }

    /// Creates the schema and records its version.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn migrate(&self) -> Result<(), AnalyticsError> {
        self.connection
            .execute_batch(SCHEMA)
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        self.connection
            .execute(
                "INSERT OR REPLACE INTO rollup_meta(key, value) VALUES('schema_version', ?1)",
                params![ROLLUP_SCHEMA_VERSION.to_string()],
            )
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        Ok(())
    }

    /// Drops every derived table, leaving the ledger untouched.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn drop_all(&self) -> Result<(), AnalyticsError> {
        self.connection
            .execute_batch(
                "DROP TABLE IF EXISTS session_usage;
                 DROP TABLE IF EXISTS session_model_usage;
                 DROP TABLE IF EXISTS tool_stats;
                 DROP TABLE IF EXISTS tool_latency;
                 DROP TABLE IF EXISTS daily_rollup;
                 DROP TABLE IF EXISTS daily_session;
                 DROP TABLE IF EXISTS pricing_snapshot;",
            )
            .map_err(|error| AnalyticsError::sqlite(&error))
    }

    /// Rebuilds every rollup from the ledger.
    ///
    /// This is the same code path a fresh install and a crash recovery take, so
    /// "the rollups match the ledger" is true by construction.
    ///
    /// # Errors
    /// Returns [`AnalyticsError`] when the ledger cannot be read or a table
    /// cannot be written.
    pub fn rebuild(&self, config: &AnalyticsConfig) -> Result<RebuildReport, AnalyticsError> {
        let events = read_ledger(config)?;
        let snapshot = config_snapshot(config)?;
        self.connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        let result = self.rebuild_in_transaction(&events, snapshot.as_ref());
        match result {
            Ok(report) => {
                self.connection
                    .execute_batch("COMMIT")
                    .map_err(|error| AnalyticsError::sqlite(&error))?;
                Ok(report)
            }
            Err(error) => {
                let _ = self.connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn rebuild_in_transaction(
        &self,
        events: &[AnalyticsEvent],
        snapshot: Option<&PricingSnapshot>,
    ) -> Result<RebuildReport, AnalyticsError> {
        self.drop_all()?;
        self.migrate()?;
        for event in events {
            self.absorb(event, snapshot)?;
        }
        if let Some(snapshot) = snapshot {
            self.insert_pricing(snapshot)?;
        }
        let counts = self.row_counts()?;
        Ok(RebuildReport {
            events_read: events.len() as u64,
            session_rows: counts.sessions,
            model_rows: counts.models,
            tool_rows: counts.tools,
            day_rows: counts.days,
            pricing_known: snapshot.is_some_and(|snapshot| !snapshot.is_empty()),
        })
    }

    /// Folds one ledger event into every affected rollup row.
    ///
    /// This is the **single** upsert path. `rebuild` replays the whole ledger
    /// through it and `AnalyticsLog::append` calls it per event, so an
    /// incrementally maintained index and a rebuilt one cannot disagree: both
    /// go through the same `absorb` fold in [`SessionUsage`], [`ModelUsage`],
    /// [`ToolStats`], and [`DailyRollup`].
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] when a row cannot be read or written.
    pub fn absorb(
        &self,
        event: &AnalyticsEvent,
        snapshot: Option<&PricingSnapshot>,
    ) -> Result<(), AnalyticsError> {
        // `None` means the event carries no cost fact at all; only a real cost
        // fact may move a rollup's status or total.
        let cost = resolve(event, snapshot);

        let mut session = self
            .session_usage(&event.session)?
            .unwrap_or_else(|| SessionUsage::new(event.session.clone()));
        session.absorb(event, cost.as_ref());
        self.insert_session(&session)?;

        if let (Some(provider), Some(model)) = (&event.provider, &event.model) {
            let mut row = self
                .model_row(&event.session, provider, model)?
                .unwrap_or_else(|| {
                    ModelUsage::new(event.session.clone(), provider.clone(), model.clone())
                });
            row.absorb(event, cost.as_ref());
            self.insert_model(&row)?;
        }

        if let Some(measurement) = &event.tool
            && let Some(name) = &measurement.tool
        {
            let mut row = self
                .tool_row(&event.session, name)?
                .unwrap_or_else(|| ToolStats::new(event.session.clone(), name.clone()));
            row.absorb(measurement);
            self.insert_tool(&row)?;
            if let Some(latency) = measurement.latency_ms {
                self.connection
                    .execute(
                        "INSERT INTO tool_latency(session, tool, latency_ms) VALUES(?1,?2,?3)",
                        params![event.session, name, latency],
                    )
                    .map_err(|error| AnalyticsError::sqlite(&error))?;
            }
        }

        let day = event.day();
        let mut day_row = self
            .day_row(&day)?
            .unwrap_or_else(|| DailyRollup::new(day.clone()));
        day_row.absorb(event, cost.as_ref());
        self.insert_day(&day_row)?;
        // The distinct-session count is kept in its own table so it stays a
        // count of sessions rather than a count of events.
        self.connection
            .execute(
                "INSERT OR IGNORE INTO daily_session(day, session) VALUES(?1, ?2)",
                params![day, event.session],
            )
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        Ok(())
    }

    fn model_row(
        &self,
        session: &str,
        provider: &str,
        model: &str,
    ) -> Result<Option<ModelUsage>, AnalyticsError> {
        self.connection
            .query_row(
                "SELECT session, provider, model, calls,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        reasoning_tokens, tokens_observed, cost_micros_usd, cost_status,
                        cost_contributors, pricing_version
                 FROM session_model_usage WHERE session = ?1 AND provider = ?2 AND model = ?3",
                params![session, provider, model],
                row_to_model,
            )
            .optional()
            .map_err(|error| AnalyticsError::sqlite(&error))
    }

    /// Reads the stored tool counters for one tool.
    ///
    /// The returned row carries the additive counters but **not** the raw
    /// latency samples: absorbing must not double-count them, so the samples
    /// are re-read on demand by [`Rollups::tool_stats_with_samples`].
    fn tool_row(&self, session: &str, tool: &str) -> Result<Option<ToolStats>, AnalyticsError> {
        Ok(self
            .tool_stats(session)?
            .into_iter()
            .find(|row| row.tool == tool))
    }

    /// Returns the tool rollups for a session with their exact latency
    /// samples attached, so a percentile is computed from real measurements
    /// rather than from a summary that cannot reproduce one.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn tool_stats_with_samples(&self, session: &str) -> Result<Vec<ToolStats>, AnalyticsError> {
        let mut rows = self.tool_stats(session)?;
        for row in &mut rows {
            row.latency_samples = self.latency_samples(session, &row.tool)?;
        }
        Ok(rows)
    }

    fn day_row(&self, day: &str) -> Result<Option<DailyRollup>, AnalyticsError> {
        self.connection
            .query_row(
                "SELECT day, events, turns, steps,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        reasoning_tokens, tokens_observed, cost_micros_usd, cost_status,
                        cost_contributors
                 FROM daily_rollup WHERE day = ?1",
                params![day],
                row_to_day,
            )
            .optional()
            .map_err(|error| AnalyticsError::sqlite(&error))
    }

    fn insert_session(&self, row: &SessionUsage) -> Result<(), AnalyticsError> {
        self.connection
            .execute(
                "INSERT OR REPLACE INTO session_usage(
                     session, turns, steps, tool_calls,
                     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                     reasoning_tokens, tokens_observed, cost_micros_usd, cost_status,
                     cost_contributors, pricing_version, first_ts, last_ts)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                params![
                    row.session,
                    row.turns,
                    row.steps,
                    row.tool_calls,
                    row.tokens.input,
                    row.tokens.output,
                    row.tokens.cache_read,
                    row.tokens.cache_write,
                    row.tokens.reasoning,
                    row.tokens.observed as i64,
                    row.cost_micros_usd,
                    row.cost_status.as_str(),
                    row.contributors as i64,
                    row.pricing_version,
                    row.first_ts,
                    row.last_ts,
                ],
            )
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        Ok(())
    }

    fn insert_model(&self, row: &ModelUsage) -> Result<(), AnalyticsError> {
        self.connection
            .execute(
                "INSERT OR REPLACE INTO session_model_usage(
                     session, provider, model, calls,
                     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                     reasoning_tokens, tokens_observed, cost_micros_usd, cost_status,
                     cost_contributors, pricing_version)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![
                    row.session,
                    row.provider,
                    row.model,
                    row.calls,
                    row.tokens.input,
                    row.tokens.output,
                    row.tokens.cache_read,
                    row.tokens.cache_write,
                    row.tokens.reasoning,
                    row.tokens.observed as i64,
                    row.cost_micros_usd,
                    row.cost_status.as_str(),
                    row.contributors as i64,
                    row.pricing_version,
                ],
            )
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        Ok(())
    }

    fn insert_tool(&self, row: &ToolStats) -> Result<(), AnalyticsError> {
        self.connection
            .execute(
                "INSERT INTO tool_stats(
                     session, tool, calls, accepted, rejected, bypassed, errors,
                     latency_ms_sum, latency_ms_max, latency_samples,
                     lines_added, lines_removed)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                 ON CONFLICT(session, tool) DO UPDATE SET
                     calls = excluded.calls,
                     accepted = excluded.accepted,
                     rejected = excluded.rejected,
                     bypassed = excluded.bypassed,
                     errors = excluded.errors,
                     latency_ms_sum = excluded.latency_ms_sum,
                     latency_ms_max = excluded.latency_ms_max,
                     latency_samples = excluded.latency_samples,
                     lines_added = excluded.lines_added,
                     lines_removed = excluded.lines_removed",
                params![
                    row.session,
                    row.tool,
                    row.calls,
                    row.accepted,
                    row.rejected,
                    row.bypassed,
                    row.errors,
                    row.latency_ms_sum,
                    row.latency_ms_max,
                    row.sample_count,
                    row.lines_added,
                    row.lines_removed,
                ],
            )
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        // The raw samples are owned by `absorb`, which appends exactly the
        // sample it just folded. Writing them here as well would double-count
        // every measurement.
        Ok(())
    }

    fn insert_day(&self, row: &DailyRollup) -> Result<(), AnalyticsError> {
        self.connection
            .execute(
                "INSERT OR REPLACE INTO daily_rollup(
                     day, events, sessions, turns, steps,
                     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                     reasoning_tokens, tokens_observed, cost_micros_usd, cost_status,
                     cost_contributors)
                 VALUES(?1,?2,0,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    row.day,
                    row.events,
                    row.turns,
                    row.steps,
                    row.tokens.input,
                    row.tokens.output,
                    row.tokens.cache_read,
                    row.tokens.cache_write,
                    row.tokens.reasoning,
                    row.tokens.observed as i64,
                    row.cost_micros_usd,
                    row.cost_status.as_str(),
                    row.contributors as i64,
                ],
            )
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        Ok(())
    }

    fn insert_pricing(&self, snapshot: &PricingSnapshot) -> Result<(), AnalyticsError> {
        self.connection
            .execute(
                "INSERT OR REPLACE INTO pricing_snapshot(version, source, fetched_at, routes)
                 VALUES(?1,?2,?3,?4)",
                params![
                    snapshot.version,
                    snapshot.source.clone().unwrap_or_default(),
                    snapshot.fetched_at,
                    serde_json::to_string(&snapshot.routes)
                        .map_err(|error| AnalyticsError::Config(error.to_string()))?,
                ],
            )
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        Ok(())
    }

    /// Returns the per-session rollup, when present.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn session_usage(&self, session: &str) -> Result<Option<SessionUsage>, AnalyticsError> {
        self.connection
            .query_row(
                "SELECT session, turns, steps, tool_calls,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        reasoning_tokens, tokens_observed, cost_micros_usd, cost_status,
                        cost_contributors, pricing_version, first_ts, last_ts
                 FROM session_usage WHERE session = ?1",
                params![session],
                row_to_session,
            )
            .optional()
            .map_err(|error| AnalyticsError::sqlite(&error))
    }

    /// Returns every per-session rollup, ordered by session id.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn all_session_usage(&self) -> Result<Vec<SessionUsage>, AnalyticsError> {
        self.collect(
            "SELECT session, turns, steps, tool_calls,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    reasoning_tokens, tokens_observed, cost_micros_usd, cost_status,
                    cost_contributors, pricing_version, first_ts, last_ts
             FROM session_usage ORDER BY session",
            row_to_session,
            [],
        )
    }

    /// Returns the per-route rollups for a session.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn model_usage(&self, session: &str) -> Result<Vec<ModelUsage>, AnalyticsError> {
        self.collect(
            "SELECT session, provider, model, calls,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    reasoning_tokens, tokens_observed, cost_micros_usd, cost_status,
                    cost_contributors, pricing_version
             FROM session_model_usage WHERE session = ?1 ORDER BY provider, model",
            row_to_model,
            params![session],
        )
    }

    /// Returns the tool rollups for a session.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn tool_stats(&self, session: &str) -> Result<Vec<ToolStats>, AnalyticsError> {
        self.collect(
            "SELECT session, tool, calls, accepted, rejected, bypassed, errors,
                    latency_ms_sum, latency_ms_max,
                    (SELECT COUNT(*) FROM tool_latency l
                      WHERE l.session = tool_stats.session AND l.tool = tool_stats.tool),
                    lines_added, lines_removed
             FROM tool_stats WHERE session = ?1 ORDER BY tool",
            row_to_tool,
            params![session],
        )
    }

    /// Returns the observed latency samples for a tool, in the order recorded.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn latency_samples(&self, session: &str, tool: &str) -> Result<Vec<u64>, AnalyticsError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT latency_ms FROM tool_latency WHERE session = ?1 AND tool = ?2 \
                 ORDER BY rowid",
            )
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        let rows = statement
            .query_map(params![session, tool], |row| row.get::<_, i64>(0))
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|error| AnalyticsError::sqlite(&error))? as u64);
        }
        Ok(out)
    }

    /// Returns the daily rollups, newest day last.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn daily(&self, days: Option<u32>) -> Result<Vec<DailyRollup>, AnalyticsError> {
        let mut rows = self.collect(
            "SELECT day, events, turns, steps,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    reasoning_tokens, tokens_observed, cost_micros_usd, cost_status,
                    cost_contributors
             FROM daily_rollup ORDER BY day",
            row_to_day,
            [],
        )?;
        for row in &mut rows {
            row.sessions = self.sessions_on(&row.day)?;
        }
        if let Some(days) = days
            && rows.len() > days as usize
        {
            rows.drain(..rows.len() - days as usize);
        }
        Ok(rows)
    }

    /// Returns the distinct sessions recorded on a day.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn sessions_on(&self, day: &str) -> Result<Vec<String>, AnalyticsError> {
        let mut statement = self
            .connection
            .prepare("SELECT session FROM daily_session WHERE day = ?1 ORDER BY session")
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        let rows = statement
            .query_map(params![day], |row| row.get::<_, String>(0))
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|error| AnalyticsError::sqlite(&error))?);
        }
        Ok(out)
    }

    /// Returns the recorded pricing snapshot, when one is present.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn pricing_snapshot(&self) -> Result<Option<PricingSnapshot>, AnalyticsError> {
        let row = self
            .connection
            .query_row(
                "SELECT version, source, fetched_at, routes FROM pricing_snapshot LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        let Some((version, source, fetched_at, routes)) = row else {
            return Ok(None);
        };
        let routes: std::collections::BTreeMap<String, crate::cost::RoutePrice> =
            serde_json::from_str(&routes).map_err(|error| {
                AnalyticsError::Config(format!("rollup pricing routes are unreadable: {error}"))
            })?;
        Ok(Some(PricingSnapshot {
            version,
            source: (!source.is_empty()).then_some(source),
            fetched_at,
            routes,
        }))
    }

    /// Returns how many rows each table holds.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] on failure.
    pub fn row_counts(&self) -> Result<RowCounts, AnalyticsError> {
        let count = |table: &str| -> Result<u64, AnalyticsError> {
            self.connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .map(|value| value as u64)
                .map_err(|error| AnalyticsError::sqlite(&error))
        };
        Ok(RowCounts {
            sessions: count("session_usage")?,
            models: count("session_model_usage")?,
            tools: count("tool_stats")?,
            days: count("daily_rollup")?,
            pricing: count("pricing_snapshot")?,
        })
    }

    fn collect<T, P>(
        &self,
        sql: &str,
        mapper: fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
        bind: P,
    ) -> Result<Vec<T>, AnalyticsError>
    where
        P: rusqlite::Params,
    {
        let mut statement = self
            .connection
            .prepare(sql)
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        let rows = statement
            .query_map(bind, mapper)
            .map_err(|error| AnalyticsError::sqlite(&error))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|error| AnalyticsError::sqlite(&error))?);
        }
        Ok(out)
    }
}

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS rollup_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_usage (
    session            TEXT PRIMARY KEY,
    turns              INTEGER NOT NULL,
    steps              INTEGER NOT NULL,
    tool_calls         INTEGER NOT NULL,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    reasoning_tokens   INTEGER NOT NULL,
    tokens_observed    INTEGER NOT NULL,
    cost_micros_usd    INTEGER,
    cost_status        TEXT NOT NULL,
    cost_contributors  INTEGER NOT NULL,
    pricing_version    TEXT,
    first_ts           INTEGER NOT NULL,
    last_ts            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_model_usage (
    session            TEXT NOT NULL,
    provider           TEXT NOT NULL,
    model              TEXT NOT NULL,
    calls              INTEGER NOT NULL,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    reasoning_tokens   INTEGER NOT NULL,
    tokens_observed    INTEGER NOT NULL,
    cost_micros_usd    INTEGER,
    cost_status        TEXT NOT NULL,
    cost_contributors  INTEGER NOT NULL,
    pricing_version    TEXT,
    PRIMARY KEY (session, provider, model)
);
CREATE TABLE IF NOT EXISTS tool_stats (
    session            TEXT NOT NULL,
    tool               TEXT NOT NULL,
    calls              INTEGER NOT NULL,
    accepted           INTEGER NOT NULL,
    rejected           INTEGER NOT NULL,
    bypassed           INTEGER NOT NULL,
    errors             INTEGER NOT NULL,
    latency_ms_sum     INTEGER NOT NULL,
    latency_ms_max     INTEGER NOT NULL,
    latency_samples    INTEGER NOT NULL,
    lines_added        INTEGER NOT NULL,
    lines_removed      INTEGER NOT NULL,
    PRIMARY KEY (session, tool)
);
CREATE TABLE IF NOT EXISTS tool_latency (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session    TEXT NOT NULL,
    tool       TEXT NOT NULL,
    latency_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_rollup (
    day                TEXT PRIMARY KEY,
    events             INTEGER NOT NULL,
    sessions           INTEGER NOT NULL,
    turns              INTEGER NOT NULL,
    steps              INTEGER NOT NULL,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    reasoning_tokens   INTEGER NOT NULL,
    tokens_observed    INTEGER NOT NULL,
    cost_micros_usd    INTEGER,
    cost_status        TEXT NOT NULL,
    cost_contributors  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_session (
    day     TEXT NOT NULL,
    session TEXT NOT NULL,
    PRIMARY KEY (day, session)
);
CREATE TABLE IF NOT EXISTS pricing_snapshot (
    version    TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    routes     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_latency_lookup ON tool_latency(session, tool);
";

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionUsage> {
    Ok(SessionUsage {
        session: row.get(0)?,
        turns: row.get::<_, i64>(1)? as u64,
        steps: row.get::<_, i64>(2)? as u64,
        tool_calls: row.get::<_, i64>(3)? as u64,
        tokens: Tokens {
            input: row.get::<_, i64>(4)? as u64,
            output: row.get::<_, i64>(5)? as u64,
            cache_read: row.get::<_, i64>(6)? as u64,
            cache_write: row.get::<_, i64>(7)? as u64,
            reasoning: row.get::<_, i64>(8)? as u64,
            observed: row.get::<_, i64>(9)? != 0,
        },
        cost_micros_usd: row.get::<_, Option<i64>>(10)?,
        cost_status: status_of(row.get::<_, String>(11)?),
        contributors: row.get::<_, i64>(12)? as u64,
        pricing_version: row.get::<_, Option<String>>(13)?,
        first_ts: row.get::<_, i64>(14)?,
        last_ts: row.get::<_, i64>(15)?,
    })
}

fn row_to_model(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelUsage> {
    Ok(ModelUsage {
        session: row.get(0)?,
        provider: row.get(1)?,
        model: row.get(2)?,
        calls: row.get::<_, i64>(3)? as u64,
        tokens: Tokens {
            input: row.get::<_, i64>(4)? as u64,
            output: row.get::<_, i64>(5)? as u64,
            cache_read: row.get::<_, i64>(6)? as u64,
            cache_write: row.get::<_, i64>(7)? as u64,
            reasoning: row.get::<_, i64>(8)? as u64,
            observed: row.get::<_, i64>(9)? != 0,
        },
        cost_micros_usd: row.get::<_, Option<i64>>(10)?,
        cost_status: status_of(row.get::<_, String>(11)?),
        contributors: row.get::<_, i64>(12)? as u64,
        pricing_version: row.get::<_, Option<String>>(13)?,
    })
}

fn row_to_tool(row: &rusqlite::Row<'_>) -> rusqlite::Result<ToolStats> {
    Ok(ToolStats {
        session: row.get(0)?,
        tool: row.get(1)?,
        calls: row.get::<_, i64>(2)? as u64,
        accepted: row.get::<_, i64>(3)? as u64,
        rejected: row.get::<_, i64>(4)? as u64,
        bypassed: row.get::<_, i64>(5)? as u64,
        errors: row.get::<_, i64>(6)? as u64,
        latency_ms_sum: row.get::<_, i64>(7)? as u64,
        latency_ms_max: row.get::<_, i64>(8)? as u64,
        latency_samples: Vec::new(),
        sample_count: row.get::<_, i64>(9)? as u64,
        lines_added: row.get::<_, i64>(10)? as u64,
        lines_removed: row.get::<_, i64>(11)? as u64,
    })
}

fn row_to_day(row: &rusqlite::Row<'_>) -> rusqlite::Result<DailyRollup> {
    Ok(DailyRollup {
        day: row.get(0)?,
        events: row.get::<_, i64>(1)? as u64,
        sessions: Vec::new(),
        turns: row.get::<_, i64>(2)? as u64,
        steps: row.get::<_, i64>(3)? as u64,
        tokens: Tokens {
            input: row.get::<_, i64>(4)? as u64,
            output: row.get::<_, i64>(5)? as u64,
            cache_read: row.get::<_, i64>(6)? as u64,
            cache_write: row.get::<_, i64>(7)? as u64,
            reasoning: row.get::<_, i64>(8)? as u64,
            observed: row.get::<_, i64>(9)? != 0,
        },
        cost_micros_usd: row.get::<_, Option<i64>>(10)?,
        cost_status: status_of(row.get::<_, String>(11)?),
        contributors: row.get::<_, i64>(12)? as u64,
    })
}

fn status_of(value: String) -> CostStatus {
    CostStatus::parse(&value).unwrap_or(CostStatus::Unknown)
}

/// Loads the pricing snapshot from the analytics root, if one is present.
fn config_snapshot(config: &AnalyticsConfig) -> Result<Option<PricingSnapshot>, AnalyticsError> {
    let path = config.root.join(crate::ledger::PRICING_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => PricingSnapshot::from_json(&text).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AnalyticsError::io(&path, &error)),
    }
}

/// How many rows a rebuild produced.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RebuildReport {
    /// How many ledger events were read.
    pub events_read: u64,
    /// `session_usage` rows.
    pub session_rows: u64,
    /// `session_model_usage` rows.
    pub model_rows: u64,
    /// `tool_stats` rows.
    pub tool_rows: u64,
    /// `daily_rollup` rows.
    pub day_rows: u64,
    /// Whether any pricing was known.
    pub pricing_known: bool,
}

/// How many rows each rollup table holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RowCounts {
    /// `session_usage` rows.
    pub sessions: u64,
    /// `session_model_usage` rows.
    pub models: u64,
    /// `tool_stats` rows.
    pub tools: u64,
    /// `daily_rollup` rows.
    pub days: u64,
    /// `pricing_snapshot` rows.
    pub pricing: u64,
}

use crate::event::{Tokens, ToolMeasurement};

/// Per-session usage and cost.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SessionUsage {
    /// The session id.
    pub session: String,
    /// Turns admitted.
    pub turns: u64,
    /// Provider steps settled.
    pub steps: u64,
    /// Tool calls settled.
    pub tool_calls: u64,
    /// The folded token quadruple.
    pub tokens: Tokens,
    /// The total cost in micro-USD, absent when unknown.
    pub cost_micros_usd: Option<i64>,
    /// The weakest contributing cost status.
    pub cost_status: CostStatus,
    /// The pricing version, when one was consulted.
    pub pricing_version: Option<String>,
    /// First event timestamp.
    pub first_ts: i64,
    /// Last event timestamp.
    pub last_ts: i64,
    /// How many costed events contributed. The pre-seeded `Unknown` is a
    /// *starting* value, not a contributor, so it must not be folded in.
    contributors: u64,
}

impl SessionUsage {
    /// Builds an empty rollup row.
    #[must_use]
    pub fn new(session: String) -> Self {
        Self {
            session,
            turns: 0,
            steps: 0,
            tool_calls: 0,
            tokens: Tokens::unobserved(),
            cost_micros_usd: None,
            cost_status: CostStatus::Unknown,
            pricing_version: None,
            first_ts: i64::MAX,
            last_ts: i64::MIN,
            contributors: 0,
        }
    }

    fn absorb(&mut self, event: &AnalyticsEvent, cost: Option<&ResolvedCost>) {
        // Counters and tokens fold for every event; the cost folds only when
        // this event is a cost fact, so a turn boundary never poisons a total.
        match event.kind {
            EventKind::TurnStart => self.turns = self.turns.saturating_add(1),
            EventKind::StepUsage => self.steps = self.steps.saturating_add(1),
            EventKind::ToolOutcome => self.tool_calls = self.tool_calls.saturating_add(1),
            _ => {}
        }
        if event.tokens.observed {
            self.tokens.add_assign(event.tokens);
        }
        let Some(cost) = cost.cloned() else {
            self.first_ts = self.first_ts.min(event.ts);
            self.last_ts = self.last_ts.max(event.ts);
            return;
        };
        self.cost_status = fold_status(self.cost_status, self.contributors, cost.status);
        self.contributors = self.contributors.saturating_add(1);
        self.cost_micros_usd = merge_cost(self.cost_micros_usd, self.cost_status, &cost);
        if cost.pricing_version.is_some() {
            self.pricing_version.clone_from(&cost.pricing_version);
        }
        self.first_ts = self.first_ts.min(event.ts);
        self.last_ts = self.last_ts.max(event.ts);
    }

    /// Renders the cost, or `unknown`.
    #[must_use]
    pub fn render_cost(&self) -> String {
        match (self.cost_status, self.cost_micros_usd) {
            (CostStatus::Unknown, _) | (_, None) => "unknown".to_owned(),
            (status, Some(micros)) => {
                format!("{:.6} USD ({})", micros as f64 / 1e6, status.as_str())
            }
        }
    }
}

/// Per-session, per-route usage and cost.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelUsage {
    /// The session id.
    pub session: String,
    /// The provider/route id.
    pub provider: String,
    /// The model id.
    pub model: String,
    /// Provider calls.
    pub calls: u64,
    /// The folded token quadruple.
    pub tokens: Tokens,
    /// The total cost in micro-USD, absent when unknown.
    pub cost_micros_usd: Option<i64>,
    /// The weakest contributing cost status.
    pub cost_status: CostStatus,
    /// The pricing version, when one was consulted.
    pub pricing_version: Option<String>,
    /// How many costed events contributed.
    contributors: u64,
}

impl ModelUsage {
    /// Builds an empty rollup row.
    #[must_use]
    pub fn new(session: String, provider: String, model: String) -> Self {
        Self {
            session,
            provider,
            model,
            calls: 0,
            tokens: Tokens::unobserved(),
            cost_micros_usd: None,
            cost_status: CostStatus::Unknown,
            pricing_version: None,
            contributors: 0,
        }
    }

    fn absorb(&mut self, event: &AnalyticsEvent, cost: Option<&ResolvedCost>) {
        if event.tokens.observed {
            self.tokens.add_assign(event.tokens);
        }
        let Some(cost) = cost.cloned() else {
            self.calls = self.calls.saturating_add(1);
            return;
        };
        self.cost_status = fold_status(self.cost_status, self.contributors, cost.status);
        self.contributors = self.contributors.saturating_add(1);
        self.cost_micros_usd = merge_cost(self.cost_micros_usd, self.cost_status, &cost);
        if cost.pricing_version.is_some() {
            self.pricing_version.clone_from(&cost.pricing_version);
        }
        self.calls = self.calls.saturating_add(1);
    }
}

/// Per-session, per-tool counters.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ToolStats {
    /// The session id.
    pub session: String,
    /// The tool name.
    pub tool: String,
    /// Calls settled.
    pub calls: u64,
    /// Calls that ran.
    pub accepted: u64,
    /// Calls policy refused.
    pub rejected: u64,
    /// Calls whose gate was already satisfied.
    pub bypassed: u64,
    /// Calls that failed.
    pub errors: u64,
    /// The sum of measured latencies.
    pub latency_ms_sum: u64,
    /// The largest measured latency.
    pub latency_ms_max: u64,
    /// Every measured latency, for exact percentiles.
    pub latency_samples: Vec<u64>,
    /// How many latencies were measured, when the row came from the database
    /// without its samples attached.
    #[serde(skip)]
    pub sample_count: u64,
    /// Lines added, for edit-class tools.
    pub lines_added: u64,
    /// Lines removed, for edit-class tools.
    pub lines_removed: u64,
}

impl ToolStats {
    /// Builds an empty rollup row.
    #[must_use]
    pub fn new(session: String, tool: String) -> Self {
        Self {
            session,
            tool,
            ..Self::default()
        }
    }

    fn absorb(&mut self, measurement: &ToolMeasurement) {
        self.calls = self.calls.saturating_add(1);
        match measurement.outcome {
            Some(ToolOutcomeKind::Accepted) => self.accepted = self.accepted.saturating_add(1),
            Some(ToolOutcomeKind::Rejected) => self.rejected = self.rejected.saturating_add(1),
            Some(ToolOutcomeKind::Bypassed) => self.bypassed = self.bypassed.saturating_add(1),
            None => {}
        }
        if measurement.error_class.is_some() {
            self.errors = self.errors.saturating_add(1);
        }
        if let Some(latency) = measurement.latency_ms {
            self.latency_ms_sum = self.latency_ms_sum.saturating_add(latency);
            self.latency_ms_max = self.latency_ms_max.max(latency);
            self.latency_samples.push(latency);
            self.sample_count = self.sample_count.saturating_add(1);
        }
        self.lines_added = self
            .lines_added
            .saturating_add(measurement.lines_added.unwrap_or(0));
        self.lines_removed = self
            .lines_removed
            .saturating_add(measurement.lines_removed.unwrap_or(0));
    }

    /// Returns the accept rate, or `None` when nothing was decided.
    #[must_use]
    pub fn accept_rate(&self) -> Option<f64> {
        let decided = self.accepted + self.rejected;
        (decided > 0).then(|| self.accepted as f64 / decided as f64)
    }

    /// Returns the `p` percentile of the observed latencies, using the
    /// nearest-rank method. `None` when nothing was measured.
    #[must_use]
    pub fn latency_percentile(&self, p: f64) -> Option<u64> {
        percentile(&self.latency_samples, p)
    }
}

/// Returns the `p` percentile of `samples` by nearest rank, without mutating
/// the input.
#[must_use]
pub fn percentile(samples: &[u64], p: f64) -> Option<u64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let rank = (p * sorted.len() as f64).ceil().max(1.0) as usize;
    Some(sorted[rank.min(sorted.len()) - 1])
}

/// Per-day usage and cost.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DailyRollup {
    /// The UTC day (`YYYY-MM-DD`).
    pub day: String,
    /// Events recorded.
    pub events: u64,
    /// Distinct sessions seen.
    pub sessions: Vec<String>,
    /// Turns admitted.
    pub turns: u64,
    /// Provider steps settled.
    pub steps: u64,
    /// The folded token quadruple.
    pub tokens: Tokens,
    /// The total cost in micro-USD, absent when unknown.
    pub cost_micros_usd: Option<i64>,
    /// The weakest contributing cost status.
    pub cost_status: CostStatus,
    /// How many costed events contributed.
    contributors: u64,
}

impl DailyRollup {
    /// Builds an empty rollup row.
    #[must_use]
    pub fn new(day: String) -> Self {
        Self {
            day,
            events: 0,
            sessions: Vec::new(),
            turns: 0,
            steps: 0,
            tokens: Tokens::unobserved(),
            cost_micros_usd: None,
            cost_status: CostStatus::Unknown,
            contributors: 0,
        }
    }

    fn absorb(&mut self, event: &AnalyticsEvent, cost: Option<&ResolvedCost>) {
        self.events = self.events.saturating_add(1);
        if !self.sessions.contains(&event.session) {
            self.sessions.push(event.session.clone());
            self.sessions.sort();
        }
        match event.kind {
            EventKind::TurnStart => self.turns = self.turns.saturating_add(1),
            EventKind::StepUsage => self.steps = self.steps.saturating_add(1),
            _ => {}
        }
        if event.tokens.observed {
            self.tokens.add_assign(event.tokens);
        }
        let Some(cost) = cost.cloned() else {
            return;
        };
        self.cost_status = fold_status(self.cost_status, self.contributors, cost.status);
        self.contributors = self.contributors.saturating_add(1);
        self.cost_micros_usd = merge_cost(self.cost_micros_usd, self.cost_status, &cost);
    }
}

/// Folds one contributing status into a running rollup status.
///
/// The accumulator starts at `Unknown` as a *placeholder*, so the first
/// contributor sets the status outright rather than being weakened by a value
/// that was never a real observation. From the second contributor on, the
/// weakest wins: an unknown contributor poisons the total.
fn fold_status(current: CostStatus, contributors: u64, status: CostStatus) -> CostStatus {
    if contributors == 0 {
        status
    } else {
        CostStatus::weakest_of([current, status])
    }
}

/// Folds one resolved cost into a running total.
///
/// An `unknown` contributor poisons the total: a known cost plus an unknown one
/// is still unknown, so the aggregate reports `unknown` rather than the known
/// part as if it were the whole (`REQ-ANALYTICS-002`).
fn merge_cost(total: Option<i64>, status: CostStatus, cost: &ResolvedCost) -> Option<i64> {
    if cost.status == CostStatus::Unknown
        || cost.micros_usd.is_none() && status == CostStatus::Unknown
    {
        return None;
    }
    match (total, cost.micros_usd) {
        (None, None) => None,
        (Some(total), None) => Some(total),
        (None, Some(value)) => Some(value),
        (Some(total), Some(value)) => Some(total.saturating_add(value)),
    }
}
