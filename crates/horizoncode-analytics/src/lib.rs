//! Local-only engineering analytics (`CMP-analytics`, `ARCH/20-ANALYTICS.md`).
//!
//! ## What this crate is
//!
//! An append-only event ledger that is the **source of truth and rebuildable**,
//! plus a SQLite rollup index derived from it. It answers, on demand: what did
//! this session cost, which tools and models were used, and where did time go.
//!
//! ## The rules it exists to enforce
//!
//! - **Local-only.** No network egress. OpenTelemetry and remote export are off
//!   by default, and *requesting* either is a typed
//!   [`AnalyticsError::Unsupported`] rather than silence, so nobody can believe
//!   a remote export happened when it did not (`REQ-ANALYTICS-004`).
//! - **Unknown is never fabricated.** `CostStatus = actual | estimated |
//!   included | unknown`. A missing price yields `unknown` with no number — not
//!   zero, not a guess. A rollup is only as strong as its weakest contributor
//!   (`REQ-ANALYTICS-002`).
//! - **Observed vs estimated never conflated.** The token quadruple carries an
//!   explicit `observed` flag, so "the provider reported zero" and "the
//!   provider reported nothing" are distinguishable (`REQ-ANALYTICS-001`).
//! - **Engineering, not product, analytics.** Tokens, cost, latency, retries.
//!   No leaderboards, no adoption tracking (`REQ-ANALYTICS-006`).
//! - **Derived, not authoritative.** Sessions and audit own their records;
//!   analytics derives from them and carries a cross-store `audit_seq`
//!   reference (`REQ-AUDIT-006`).

#![forbid(unsafe_code)]

mod config;
mod cost;
mod error;
mod event;
mod ledger;
mod query;
mod rollup;
mod sanitize;

pub use config::{AnalyticsConfig, AnalyticsSettings, OtelMode, RemoteMode};
pub use cost::{
    CostStatus, PRICE_SCALE, PricingSnapshot, ResolvedCost, RoutePrice, TOKENS_PER_PRICE_UNIT,
    resolve,
};
pub use error::AnalyticsError;
pub use event::{
    AnalyticsEvent, EventKind, FailureClass, Tokens, ToolMeasurement, ToolOutcomeKind, day_of,
};
pub use ledger::{
    AnalyticsLog, LEDGER_FILE, PRICING_FILE, ROLLUPS_FILE, default_analytics_root, read_ledger,
};
pub use query::{
    DayWindow, InsightsReport, ModelAggregate, SessionDetail, ToolAggregate, UsageReport, insights,
    insights_ending_on, model_usage, session_detail, tool_stats, usage,
};
pub use rollup::{
    DailyRollup, ModelUsage, RebuildReport, Rollups, RowCounts, SessionUsage, ToolStats, percentile,
};
pub use sanitize::{DENY_FIELDS, SCRUBBED, scrub};

/// The version of the ledger format this build reads and writes.
#[must_use]
pub fn format_version() -> u32 {
    1
}
