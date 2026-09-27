//! The query surfaces: `/usage`, `/insights`, `stats`, and `export`
//! (`REQ-ANALYTICS-003`, `REQ-ANALYTICS-005`).
//!
//! Every surface reads the rollups when they exist and rebuilds them from the
//! ledger when they do not, so a query is never answered from a stale or
//! partially-written index.

use serde::Serialize;

use crate::config::AnalyticsConfig;
use crate::cost::CostStatus;
use crate::error::AnalyticsError;
use crate::event::AnalyticsEvent;
use crate::rollup::{DailyRollup, ModelUsage, Rollups, SessionUsage, ToolStats};

/// Everything `/usage` and `horizoncode stats` render.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UsageReport {
    /// The session filter, when one was applied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Per-session rows.
    pub sessions: Vec<SessionUsage>,
    /// Ledger events in the window.
    pub events: u64,
    /// Whether the cost of any row is unknown.
    pub cost_unknown: bool,
    /// The egress statement, rendered on every surface.
    pub egress: &'static str,
    /// The kind of analytics this is.
    pub scope: &'static str,
}

impl UsageReport {
    /// Renders the report as plain text.
    #[must_use]
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "{} (engineering analytics: tokens, cost, latency, retries)\n",
            self.scope
        ));
        out.push_str(&format!("events: {}\n", self.events));
        if self.sessions.is_empty() {
            out.push_str("no sessions recorded\n");
        }
        for session in &self.sessions {
            out.push_str(&format!(
                "\n{}: {} turn(s), {} step(s), {} tool call(s)\n",
                session.session, session.turns, session.steps, session.tool_calls
            ));
            out.push_str(&format!(
                "  tokens: in={} out={} cache_read={} cache_write={} reasoning={} ({})\n",
                session.tokens.input,
                session.tokens.output,
                session.tokens.cache_read,
                session.tokens.cache_write,
                session.tokens.reasoning,
                if session.tokens.observed {
                    "observed"
                } else {
                    "not observed by the provider"
                }
            ));
            out.push_str(&format!("  cost: {}\n", session.render_cost()));
        }
        if self.cost_unknown {
            out.push_str(
                "\ncost status: some or all costs are unknown; no price was invented for them\n",
            );
        }
        out.push_str(&format!("\n{}\n", self.egress));
        out
    }
}

/// Everything `/insights` renders.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InsightsReport {
    /// The window, in days.
    pub days: u32,
    /// The window's daily rows, oldest first.
    pub daily: Vec<DailyRollup>,
    /// Per-tool aggregates across the window.
    pub tools: Vec<ToolAggregate>,
    /// Per-route aggregates across the window.
    pub models: Vec<ModelAggregate>,
    /// Ledger events in the window.
    pub events: u64,
    /// The egress statement.
    pub egress: &'static str,
}

impl InsightsReport {
    /// Renders the report as plain text.
    #[must_use]
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("insights over the last {} day(s)\n", self.days));
        if self.daily.is_empty() {
            out.push_str("no activity recorded in the window\n");
        }
        for day in &self.daily {
            out.push_str(&format!(
                "{}: {} event(s), {} turn(s), {} step(s), tokens in={} out={}, cost={}\n",
                day.day,
                day.events,
                day.turns,
                day.steps,
                day.tokens.input,
                day.tokens.output,
                render_cost(day.cost_status, day.cost_micros_usd)
            ));
        }
        if !self.models.is_empty() {
            out.push_str("\nper route:\n");
            for model in &self.models {
                out.push_str(&format!(
                    "  {}/{}: {} call(s), tokens in={} out={}, cost={}\n",
                    model.provider,
                    model.model,
                    model.calls,
                    model.tokens.input,
                    model.tokens.output,
                    render_cost(model.cost_status, model.cost_micros_usd)
                ));
            }
        }
        if !self.tools.is_empty() {
            out.push_str("\nper tool:\n");
            for tool in &self.tools {
                out.push_str(&format!(
                    "  {}: {} call(s), accepted={} rejected={} errors={}, p50={} p95={} ms\n",
                    tool.tool,
                    tool.calls,
                    tool.accepted,
                    tool.rejected,
                    tool.errors,
                    tool.p50_ms
                        .map_or_else(|| "-".to_owned(), |value| value.to_string()),
                    tool.p95_ms
                        .map_or_else(|| "-".to_owned(), |value| value.to_string()),
                ));
            }
        }
        out.push_str(&format!("\n{}\n", self.egress));
        out
    }
}

/// Per-tool aggregates across an insights window.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToolAggregate {
    /// The tool name.
    pub tool: String,
    /// Calls settled.
    pub calls: u64,
    /// Calls that ran.
    pub accepted: u64,
    /// Calls policy refused.
    pub rejected: u64,
    /// Calls that failed.
    pub errors: u64,
    /// Median latency, when measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p50_ms: Option<u64>,
    /// 95th-percentile latency, when measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p95_ms: Option<u64>,
    /// The raw latency samples, used while the window is being folded and
    /// dropped before the report is returned.
    #[serde(skip)]
    samples: Option<Vec<u64>>,
}

/// Per-route aggregates across an insights window.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelAggregate {
    /// The provider/route id.
    pub provider: String,
    /// The model id.
    pub model: String,
    /// Provider calls.
    pub calls: u64,
    /// The folded token quadruple.
    pub tokens: crate::event::Tokens,
    /// The total cost, absent when unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_micros_usd: Option<i64>,
    /// The weakest contributing cost status.
    pub cost_status: CostStatus,
}

/// Reads the usage surface, rebuilding the rollups when they are missing.
pub fn usage(
    config: &AnalyticsConfig,
    session: Option<&str>,
) -> Result<UsageReport, AnalyticsError> {
    let events = load_events(config)?;
    let rollups = ensure_rollups(config, &events)?;
    let sessions = match session {
        Some(session) => rollups
            .session_usage(session)?
            .into_iter()
            .collect::<Vec<SessionUsage>>(),
        None => rollups.all_session_usage()?,
    };
    let cost_unknown = sessions
        .iter()
        .any(|row| row.cost_status == CostStatus::Unknown || row.cost_micros_usd.is_none());
    Ok(UsageReport {
        session: session.map(str::to_owned),
        sessions,
        events: events.len() as u64,
        cost_unknown,
        egress: crate::config::AnalyticsSettings::default().egress_statement(),
        scope: "HorizonCode engineering analytics",
    })
}

/// Reads the insights surface over a trailing window of `days` days, anchored
/// on the current UTC day.
pub fn insights(config: &AnalyticsConfig, days: u32) -> Result<InsightsReport, AnalyticsError> {
    insights_ending_on(config, days, &crate::event::day_of(now_ms()))
}

/// Reads the insights surface over a window anchored on an explicit day.
///
/// The anchor is a parameter so a test can pin "today" and a caller can render
/// a fixed reporting period; neither depends on the host clock beyond the
/// explicit argument.
pub fn insights_ending_on(
    config: &AnalyticsConfig,
    days: u32,
    today: &str,
) -> Result<InsightsReport, AnalyticsError> {
    let events = load_events(config)?;
    let rollups = ensure_rollups(config, &events)?;
    let window = DayWindow::ending_on(today, days);
    let in_window: Vec<AnalyticsEvent> = events
        .iter()
        .filter(|event| window.contains(&event.day()))
        .cloned()
        .collect();

    let daily = rollups.daily(None)?;
    let daily: Vec<DailyRollup> = daily
        .into_iter()
        .filter(|row| window.contains(&row.day))
        .collect();

    let mut models: Vec<ModelAggregate> = Vec::new();
    let mut tools: Vec<ToolAggregate> = Vec::new();
    for event in &in_window {
        if let (Some(provider), Some(model)) = (&event.provider, &event.model) {
            if let Some(slot) = models
                .iter_mut()
                .find(|row| &row.provider == provider && &row.model == model)
            {
                slot.calls = slot.calls.saturating_add(1);
                if event.tokens.observed {
                    slot.tokens.add_assign(event.tokens);
                }
            } else {
                models.push(ModelAggregate {
                    provider: provider.clone(),
                    model: model.clone(),
                    calls: 1,
                    tokens: event.tokens,
                    cost_micros_usd: event.cost_micros_usd,
                    cost_status: event.cost_status,
                });
            }
        }
        if let Some(measurement) = &event.tool
            && let Some(name) = &measurement.tool
        {
            let samples: Vec<u64> = tools
                .iter()
                .find(|row| &row.tool == name)
                .and_then(|row| row.samples.clone())
                .unwrap_or_default();
            let mut samples = samples;
            if let Some(latency) = measurement.latency_ms {
                samples.push(latency);
            }
            match tools.iter_mut().find(|row| &row.tool == name) {
                Some(slot) => {
                    slot.calls = slot.calls.saturating_add(1);
                    if measurement.outcome == Some(crate::event::ToolOutcomeKind::Accepted) {
                        slot.accepted = slot.accepted.saturating_add(1);
                    }
                    if measurement.outcome == Some(crate::event::ToolOutcomeKind::Rejected) {
                        slot.rejected = slot.rejected.saturating_add(1);
                    }
                    if measurement.error_class.is_some() {
                        slot.errors = slot.errors.saturating_add(1);
                    }
                }
                None => tools.push(ToolAggregate {
                    tool: name.clone(),
                    calls: 1,
                    accepted: u64::from(
                        measurement.outcome == Some(crate::event::ToolOutcomeKind::Accepted),
                    ),
                    rejected: u64::from(
                        measurement.outcome == Some(crate::event::ToolOutcomeKind::Rejected),
                    ),
                    errors: u64::from(measurement.error_class.is_some()),
                    p50_ms: crate::rollup::percentile(&samples, 0.50),
                    p95_ms: crate::rollup::percentile(&samples, 0.95),
                    samples: Some(samples),
                }),
            }
        }
    }
    for tool in &mut tools {
        if let Some(samples) = tool.samples.clone() {
            tool.p50_ms = crate::rollup::percentile(&samples, 0.50);
            tool.p95_ms = crate::rollup::percentile(&samples, 0.95);
        }
        tool.samples = None;
    }
    tools.retain(|tool| tool.calls > 0);

    Ok(InsightsReport {
        days,
        daily,
        tools,
        models,
        events: in_window.len() as u64,
        egress: crate::config::AnalyticsSettings::default().egress_statement(),
    })
}

/// Returns the tool rollups for a session, filtered to that session.
pub fn tool_stats(rollups: &Rollups, session: &str) -> Result<Vec<ToolStats>, AnalyticsError> {
    Ok(rollups
        .tool_stats_with_samples(session)?
        .into_iter()
        .filter(|row| row.session == session)
        .collect())
}

/// Returns the per-route rollups for a session, filtered to that session.
pub fn model_usage(rollups: &Rollups, session: &str) -> Result<Vec<ModelUsage>, AnalyticsError> {
    Ok(rollups
        .model_usage(session)?
        .into_iter()
        .filter(|row| row.session == session)
        .collect())
}

/// Returns the per-session detail a surface renders: usage, routes, and tools.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionDetail {
    /// The per-session usage row.
    pub usage: SessionUsage,
    /// The per-route rows.
    pub models: Vec<ModelUsage>,
    /// The per-tool rows.
    pub tools: Vec<ToolStats>,
}

/// Reads one session's full detail, rebuilding the rollups when needed.
pub fn session_detail(
    config: &AnalyticsConfig,
    session: &str,
) -> Result<SessionDetail, AnalyticsError> {
    let events = load_events(config)?;
    let rollups = ensure_rollups(config, &events)?;
    let Some(usage) = rollups.session_usage(session)? else {
        return Err(AnalyticsError::Query(format!(
            "no usage recorded for session `{session}`"
        )));
    };
    Ok(SessionDetail {
        usage,
        models: model_usage(&rollups, session)?,
        tools: tool_stats(&rollups, session)?,
    })
}

fn load_events(config: &AnalyticsConfig) -> Result<Vec<AnalyticsEvent>, AnalyticsError> {
    crate::ledger::read_ledger(config)
}

/// Opens the rollups, rebuilding them when the index is absent or empty.
fn ensure_rollups(
    config: &AnalyticsConfig,
    events: &[AnalyticsEvent],
) -> Result<Rollups, AnalyticsError> {
    let path = config.root.join(crate::ledger::ROLLUPS_FILE);
    // The root is created here rather than in `AnalyticsLog::open`, so a query
    // against a home that has never been written answers from an empty ledger
    // instead of failing on a missing directory.
    std::fs::create_dir_all(&config.root)
        .map_err(|error| AnalyticsError::io(&config.root, &error))?;
    if !path.exists() {
        let rollups = Rollups::open(&path)?;
        rollups.rebuild(config)?;
        return Ok(rollups);
    }
    let rollups = Rollups::open(&path)?;
    let counts = rollups.row_counts()?;
    let empty = counts.sessions == 0 && counts.models == 0 && counts.tools == 0 && counts.days == 0;
    if empty && !events.is_empty() {
        rollups.rebuild(config)?;
    }
    Ok(rollups)
}

/// An inclusive trailing day window, anchored at a specific day.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DayWindow {
    days: u32,
    today: String,
}

impl DayWindow {
    /// Anchors the window at a specific `YYYY-MM-DD` day.
    #[must_use]
    pub fn ending_on(today: impl Into<String>, days: u32) -> Self {
        Self {
            days: days.max(1),
            today: today.into(),
        }
    }

    /// Returns the earliest day in the window.
    #[must_use]
    pub fn first_day(&self) -> String {
        let days = parse_day(&self.today).saturating_sub(i64::from(self.days) - 1);
        crate::event::day_of(days * 86_400_000)
    }

    /// Returns whether a day falls in the window.
    #[must_use]
    pub fn contains(&self, day: &str) -> bool {
        day >= self.first_day().as_str() && day <= self.today.as_str()
    }
}

fn parse_day(day: &str) -> i64 {
    let mut parts = day.split('-');
    let year = parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1970);
    let month = parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1);
    let dom = parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1);
    // Days from the civil date, inverted from `civil_from_days`.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + dom - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn render_cost(status: CostStatus, micros: Option<i64>) -> String {
    match (status, micros) {
        (CostStatus::Unknown, _) | (_, None) => "unknown".to_owned(),
        (status, Some(micros)) => {
            format!("{:.6} USD ({})", micros as f64 / 1e6, status.as_str())
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
