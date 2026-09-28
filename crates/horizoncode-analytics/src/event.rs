//! The analytics event: one row of the append-only ledger.
//!
//! The ledger is the **source of truth and is rebuildable**; the SQLite tables
//! are derived from it and can be dropped at any time
//! (`ARCH/20-ANALYTICS.md` §Data / state model).

use serde::{Deserialize, Serialize};

use crate::cost::CostStatus;

/// The kind of fact an event records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum EventKind {
    /// A turn was admitted.
    TurnStart,
    /// A turn reached a terminal state.
    TurnEnd,
    /// A provider step settled with usage.
    StepUsage,
    /// A tool call settled.
    ToolOutcome,
    /// A guard decision was made (counts only, never the prompt).
    Approval,
    /// A step was retried.
    Retry,
}

impl EventKind {
    /// The declared registry, in a stable order.
    pub const ALL: &'static [EventKind] = &[
        EventKind::TurnStart,
        EventKind::TurnEnd,
        EventKind::StepUsage,
        EventKind::ToolOutcome,
        EventKind::Approval,
        EventKind::Retry,
    ];

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TurnStart => "turn_start",
            Self::TurnEnd => "turn_end",
            Self::StepUsage => "step_usage",
            Self::ToolOutcome => "tool_outcome",
            Self::Approval => "approval",
            Self::Retry => "retry",
        }
    }

    /// Parses a wire name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        EventKind::ALL
            .iter()
            .copied()
            .find(|kind| kind.as_str() == value)
    }
}

/// The token quadruple plus reasoning, where the provider reports it.
///
/// Every field is a provider-reported **observation**. A provider that does not
/// report a field leaves it at zero and the event says so through
/// [`Tokens::observed`]; nothing is estimated into this struct
/// (`REQ-ANALYTICS-001`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    /// Non-cached input tokens.
    pub input: u64,
    /// Output (completion) tokens.
    pub output: u64,
    /// Tokens served from the prompt cache.
    pub cache_read: u64,
    /// Tokens written to the prompt cache.
    pub cache_write: u64,
    /// Reasoning/thought tokens, when reported separately.
    pub reasoning: u64,
    /// Whether the provider reported usage at all for this step. `false` means
    /// "not observed", which is **not** the same as zero.
    pub observed: bool,
}

impl Tokens {
    /// Builds an observed quadruple.
    #[must_use]
    pub fn observed(input: u64, output: u64) -> Self {
        Self {
            input,
            output,
            observed: true,
            ..Self::default()
        }
    }

    /// Adds cache accounting.
    #[must_use]
    pub fn with_cache(mut self, cache_read: u64, cache_write: u64) -> Self {
        self.cache_read = cache_read;
        self.cache_write = cache_write;
        self
    }

    /// Adds reasoning accounting.
    #[must_use]
    pub fn with_reasoning(mut self, reasoning: u64) -> Self {
        self.reasoning = reasoning;
        self
    }

    /// The unobserved (default) value: explicitly not zero-by-observation.
    #[must_use]
    pub fn unobserved() -> Self {
        Self::default()
    }

    /// Folds another quadruple in.
    pub fn add_assign(&mut self, other: Tokens) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
        self.reasoning = self.reasoning.saturating_add(other.reasoning);
        self.observed = self.observed || other.observed;
    }

    /// Returns the total token count across the quadruple.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }

    /// Returns the billable token total (input + output + cache write).
    #[must_use]
    pub fn billable(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_write)
    }
}

/// A tool call's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ToolOutcomeKind {
    /// The call ran and returned.
    Accepted,
    /// Policy refused the call.
    Rejected,
    /// The gate was already satisfied, so the call was not re-authorized.
    Bypassed,
}

impl ToolOutcomeKind {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Bypassed => "bypassed",
        }
    }

    /// Parses a wire name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "accepted" => Some(Self::Accepted),
            "rejected" => Some(Self::Rejected),
            "bypassed" => Some(Self::Bypassed),
            _ => None,
        }
    }
}

/// Tool-plane measurements for one call.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolMeasurement {
    /// The tool name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// How the call ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ToolOutcomeKind>,
    /// Wall-clock latency in milliseconds, when measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Lines added, for edit-class tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<u64>,
    /// Lines removed, for edit-class tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<u64>,
    /// A stable error class, never the raw message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
}

/// The failure taxonomy a retry or error falls into.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum FailureClass {
    /// The provider rejected the credentials.
    Auth,
    /// The provider throttled the request.
    RateLimit,
    /// The request exceeded its deadline.
    Timeout,
    /// The tool itself failed.
    ToolError,
    /// The provider's response could not be admitted: it is well-formed HTTP but
    /// not a usable step (for example two tool calls sharing one correlation id).
    Protocol,
    /// The turn was cancelled.
    Cancelled,
}

impl FailureClass {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::RateLimit => "rate_limit",
            Self::Timeout => "timeout",
            Self::ToolError => "tool_error",
            Self::Protocol => "protocol",
            Self::Cancelled => "cancelled",
        }
    }
}

/// One row of the append-only analytics ledger.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsEvent {
    /// The ledger's own monotonic sequence. Rollups key on it, never on
    /// wall-clock time alone (`ARCH/20-ANALYTICS.md` §Failure modes).
    pub seq: u64,
    /// UTC epoch milliseconds.
    pub ts: i64,
    /// The event kind.
    pub kind: EventKind,
    /// The owning session.
    pub session: String,
    /// The owning turn, when inside one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
    /// The owning step, when inside one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<u64>,
    /// The project (workspace) the work belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The provider/route id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The model id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Token accounting.
    #[serde(default)]
    pub tokens: Tokens,
    /// The cost, in millionths of a US dollar. `None` when unknown, which is
    /// carried by [`Self::cost_status`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_micros_usd: Option<i64>,
    /// How the cost was arrived at.
    pub cost_status: CostStatus,
    /// The pricing snapshot version the cost was resolved against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing_version: Option<String>,
    /// Tool-plane measurements.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolMeasurement>,
    /// The failure taxonomy, when the event records a failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<FailureClass>,
    /// The attempt number, for a retry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    /// The cross-store audit `seq` that references this effect
    /// (`REQ-AUDIT-006`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_seq: Option<u64>,
    /// Bounded scalar notes: counts, classes, replies, and digests.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub notes: std::collections::BTreeMap<String, String>,
}

impl AnalyticsEvent {
    /// Starts a ledger event for a session and kind.
    #[must_use]
    pub fn new(seq: u64, ts: i64, session: impl Into<String>, kind: EventKind) -> Self {
        Self {
            seq,
            ts,
            kind,
            session: session.into(),
            turn: None,
            step: None,
            project: None,
            provider: None,
            model: None,
            tokens: Tokens::unobserved(),
            cost_micros_usd: None,
            cost_status: CostStatus::Unknown,
            pricing_version: None,
            tool: None,
            failure: None,
            attempt: None,
            audit_seq: None,
            notes: std::collections::BTreeMap::new(),
        }
    }

    /// Sets the owning turn.
    #[must_use]
    pub fn with_turn(mut self, turn: impl Into<String>) -> Self {
        self.turn = Some(turn.into());
        self
    }

    /// Sets the owning step.
    #[must_use]
    pub fn with_step(mut self, step: u64) -> Self {
        self.step = Some(step);
        self
    }

    /// Sets the project (workspace).
    #[must_use]
    pub fn with_project(mut self, project: impl Into<String>) -> Self {
        self.project = Some(project.into());
        self
    }

    /// Sets the route.
    #[must_use]
    pub fn with_route(mut self, provider: impl Into<String>, model: impl Into<String>) -> Self {
        self.provider = Some(provider.into());
        self.model = Some(model.into());
        self
    }

    /// Sets the token quadruple.
    #[must_use]
    pub fn with_tokens(mut self, tokens: Tokens) -> Self {
        self.tokens = tokens;
        self
    }

    /// Sets an **observed** cost, in millionths of a US dollar.
    #[must_use]
    pub fn with_observed_cost(
        mut self,
        micros_usd: i64,
        pricing_version: impl Into<String>,
    ) -> Self {
        self.cost_micros_usd = Some(micros_usd);
        self.cost_status = CostStatus::Actual;
        self.pricing_version = Some(pricing_version.into());
        self
    }

    /// Sets the tool measurement.
    #[must_use]
    pub fn with_tool(mut self, tool: ToolMeasurement) -> Self {
        self.tool = Some(tool);
        self
    }

    /// Sets the failure taxonomy.
    #[must_use]
    pub fn with_failure(mut self, failure: FailureClass) -> Self {
        self.failure = Some(failure);
        self
    }

    /// Sets the retry attempt number.
    #[must_use]
    pub fn with_attempt(mut self, attempt: u32) -> Self {
        self.attempt = Some(attempt);
        self
    }

    /// Sets the cross-store audit reference.
    #[must_use]
    pub fn with_audit_seq(mut self, audit_seq: u64) -> Self {
        self.audit_seq = Some(audit_seq);
        self
    }

    /// Sets a free-form bounded note. Values are scalar metadata only: no
    /// prompt text, completion text, or file content has a field here.
    #[must_use]
    pub fn with_meta_note(mut self, key: &str, value: &str) -> Self {
        self.notes.insert(key.to_owned(), value.to_owned());
        self
    }

    /// Sets the approval reply, counted only.
    #[must_use]
    pub fn with_meta_reply(self, reply: &str) -> Self {
        self.with_meta_note("reply", reply)
    }

    /// Sets the cross-store reference from a digest, when the audit `seq` is
    /// not yet known. A digest is a reference, never a payload
    /// (`REQ-AUDIT-006`).
    #[must_use]
    pub fn with_audit_seq_digest(self, digest: &str) -> Self {
        self.with_meta_note("audit_digest", digest)
    }

    /// Returns the UTC day this event belongs to (`YYYY-MM-DD`), derived from
    /// `ts` in UTC so no locale or timezone can change a rollup.
    #[must_use]
    pub fn day(&self) -> String {
        day_of(self.ts)
    }

    /// Returns the canonical line written to the ledger.
    #[must_use]
    pub fn to_line(&self) -> String {
        let mut line = serde_json::to_string(self).expect("analytics event must serialize");
        line.push('\n');
        line
    }
}

/// Returns the UTC `YYYY-MM-DD` day for epoch milliseconds.
#[must_use]
pub fn day_of(ts_ms: i64) -> String {
    let (year, month, day) = civil_from_days(ts_ms.div_euclid(86_400_000));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Converts days since the Unix epoch to a civil `(year, month, day)`.
///
/// This is the standard Howard Hinnant civil-from-days algorithm, so a rollup
/// day is the same on every host regardless of the local timezone.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_quadruple_folds_and_never_confuses_unobserved_with_zero() {
        let mut tokens = Tokens::observed(10, 3).with_cache(4, 2).with_reasoning(1);
        assert!(tokens.observed);
        assert_eq!(tokens.billable(), 15);
        tokens.add_assign(Tokens::observed(5, 1));
        assert_eq!(tokens.input, 15);
        assert_eq!(tokens.output, 4);
        assert_eq!(tokens.cache_read, 4);
        assert_eq!(tokens.cache_write, 2);
        assert_eq!(tokens.reasoning, 1);
        assert_eq!(tokens.billable(), 21);
        assert_eq!(tokens.total(), 25, "cache reads count toward the total");
        // An unobserved quadruple is explicitly flagged, so a zero is never
        // passed off as a measurement.
        assert!(!Tokens::unobserved().observed);
        assert_eq!(Tokens::unobserved().billable(), 0);
    }

    #[test]
    fn folding_preserves_the_observed_flag() {
        let mut tokens = Tokens::unobserved();
        tokens.add_assign(Tokens::unobserved());
        assert!(!tokens.observed, "unobserved + unobserved is unobserved");
        tokens.add_assign(Tokens::observed(1, 1));
        assert!(tokens.observed, "any observation makes the sum observed");
    }

    #[test]
    fn days_are_utc_and_timezone_independent() {
        // 2024-01-01T00:00:00Z and the last millisecond of the prior day.
        assert_eq!(day_of(1_704_067_200_000), "2024-01-01");
        assert_eq!(day_of(1_704_067_199_999), "2023-12-31");
        assert_eq!(day_of(0), "1970-01-01");
        assert_eq!(day_of(-1), "1969-12-31");
    }

    #[test]
    fn leap_day_is_handled() {
        // 2024-02-29T12:00:00Z
        assert_eq!(day_of(1_709_208_000_000), "2024-02-29");
    }

    #[test]
    fn events_round_trip_through_the_ledger_line() {
        let event = AnalyticsEvent::new(3, 1_704_067_200_000, "ses_1", EventKind::StepUsage)
            .with_turn("turn_1")
            .with_step(2)
            .with_project("workspace")
            .with_route("compatible", "mock-model")
            .with_tokens(Tokens::observed(11, 7).with_cache(3, 1))
            .with_observed_cost(1234, "pricing-v1")
            .with_audit_seq(9);
        let line = event.to_line();
        let back: AnalyticsEvent = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(back, event);
        assert_eq!(back.day(), "2024-01-01");
    }

    #[test]
    fn notes_are_bounded_scalars_only() {
        let event =
            AnalyticsEvent::new(0, 0, "ses_1", EventKind::Approval).with_meta_reply("allow_always");
        let line = event.to_line();
        assert!(
            line.contains("\"notes\":{\"reply\":\"allow_always\"}"),
            "{line}"
        );
        let back: AnalyticsEvent = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(back.notes.get("reply").unwrap(), "allow_always");
        // An event with no notes omits the field entirely.
        let plain = AnalyticsEvent::new(0, 0, "ses_1", EventKind::TurnStart).to_line();
        assert!(!plain.contains("notes"), "{plain}");
    }

    #[test]
    fn an_unknown_cost_serializes_without_a_number() {
        let event = AnalyticsEvent::new(0, 0, "ses_1", EventKind::TurnStart);
        let line = event.to_line();
        assert!(!line.contains("cost_micros_usd"), "{line}");
        assert!(line.contains("\"cost_status\":\"unknown\""), "{line}");
    }
}
