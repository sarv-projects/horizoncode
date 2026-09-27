//! Cost status and local pricing resolution (`REQ-ANALYTICS-002`).
//!
//! The single rule this module exists to enforce: **an unknown price is
//! reported as unknown.** It is never replaced by an invented number, never
//! rounded to zero, and never silently omitted so a total can be printed.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::AnalyticsError;
use crate::event::{EventKind, Tokens};

/// Micro-USD per million tokens. Prices are held as integers in millionths of a
/// dollar so a total is exact and reproducible.
pub const PRICE_SCALE: i64 = 1_000_000;
/// The price unit a snapshot's rates are expressed in.
pub const TOKENS_PER_PRICE_UNIT: u64 = 1_000_000;

/// How a cost figure was arrived at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum CostStatus {
    /// The provider reported the cost.
    Actual,
    /// Computed from a local pricing snapshot.
    Estimated,
    /// The route is covered by a subscription or a local model, so there is no
    /// per-token charge.
    Included,
    /// No price is available. The cost is absent, not zero.
    Unknown,
}

impl CostStatus {
    /// The declared registry, in a stable order.
    pub const ALL: &'static [CostStatus] = &[
        CostStatus::Actual,
        CostStatus::Estimated,
        CostStatus::Included,
        CostStatus::Unknown,
    ];

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Actual => "actual",
            Self::Estimated => "estimated",
            Self::Included => "included",
            Self::Unknown => "unknown",
        }
    }

    /// Parses a wire name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        CostStatus::ALL
            .iter()
            .copied()
            .find(|status| status.as_str() == value)
    }

    /// The weaker statuses, for combining a rollup from its members.
    ///
    /// A rollup is only `actual` when every contributing row is; a single
    /// `unknown` poisons the total, because an unknown added to a known total
    /// is still unknown.
    #[must_use]
    pub fn weakest_of(statuses: impl IntoIterator<Item = Self>) -> Self {
        let mut worst = CostStatus::Actual;
        let mut any = false;
        for status in statuses {
            any = true;
            if status > worst {
                worst = status;
            }
        }
        if any { worst } else { CostStatus::Unknown }
    }
}

/// One route's per-million-token rates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutePrice {
    /// The provider/route id.
    pub provider: String,
    /// The model id.
    pub model: String,
    /// Micro-USD per million input tokens.
    pub input_micros_per_mtok: i64,
    /// Micro-USD per million output tokens.
    pub output_micros_per_mtok: i64,
    /// Micro-USD per million cache-read tokens.
    #[serde(default)]
    pub cache_read_micros_per_mtok: i64,
    /// Micro-USD per million cache-write tokens.
    #[serde(default)]
    pub cache_write_micros_per_mtok: i64,
    /// Whether the route is covered by a subscription, making the per-token
    /// rates irrelevant.
    #[serde(default)]
    pub included: bool,
}

impl RoutePrice {
    /// Returns the `(provider, model)` key this price is filed under.
    #[must_use]
    pub fn key(&self) -> (String, String) {
        (self.provider.clone(), self.model.clone())
    }

    /// Resolves a cost for an observed token quadruple, in micro-USD.
    #[must_use]
    pub fn cost_micros(&self, tokens: Tokens) -> i64 {
        let rate = |per_mtok: i64, count: u64| -> i64 {
            // Integer arithmetic only: no float ever enters a stored total.
            let scaled = i128::from(per_mtok) * i128::from(count);
            (scaled / i128::from(TOKENS_PER_PRICE_UNIT)) as i64
        };
        rate(self.input_micros_per_mtok, tokens.input)
            .saturating_add(rate(self.output_micros_per_mtok, tokens.output))
            .saturating_add(rate(self.cache_read_micros_per_mtok, tokens.cache_read))
            .saturating_add(rate(self.cache_write_micros_per_mtok, tokens.cache_write))
    }
}

/// A versioned, local pricing snapshot (`pricing_snapshot{version, source,
/// fetched_at}`).
///
/// There is **no built-in price table**. A fresh install has no prices, so every
/// cost resolves to `unknown` until an operator or a configured local source
/// supplies a snapshot. That is the honest zero-configuration posture: a wrong
/// number is worse than an absent one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PricingSnapshot {
    /// The snapshot version, recorded on every cost it produces.
    pub version: String,
    /// Where the prices came from (a local file, an operator, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// When the snapshot was taken (epoch milliseconds).
    #[serde(default)]
    pub fetched_at: i64,
    /// The prices, keyed by `provider/model` in declaration order.
    #[serde(default)]
    pub routes: BTreeMap<String, RoutePrice>,
}

impl PricingSnapshot {
    /// Builds an empty snapshot with a version and source.
    #[must_use]
    pub fn new(version: impl Into<String>, source: impl Into<String>, fetched_at: i64) -> Self {
        Self {
            version: version.into(),
            source: Some(source.into()),
            fetched_at,
            routes: BTreeMap::new(),
        }
    }

    /// Adds a route's price.
    #[must_use]
    pub fn with_route(mut self, price: RoutePrice) -> Self {
        let (provider, model) = price.key();
        self.routes.insert(format!("{provider}/{model}"), price);
        self
    }

    /// Returns the price for a route, when the snapshot has one.
    #[must_use]
    pub fn price(&self, provider: &str, model: &str) -> Option<&RoutePrice> {
        self.routes.get(&format!("{provider}/{model}"))
    }

    /// How many routes the snapshot prices.
    #[must_use]
    pub fn len(&self) -> usize {
        self.routes.len()
    }

    /// Returns whether the snapshot prices nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.routes.is_empty()
    }

    /// Validates the snapshot.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Config`] for an empty version or a negative
    /// rate, either of which would make a stored total meaningless.
    pub fn validate(&self) -> Result<(), AnalyticsError> {
        if self.version.trim().is_empty() {
            return Err(AnalyticsError::Config(
                "pricing snapshot version must not be empty".to_owned(),
            ));
        }
        for price in self.routes.values() {
            let rates = [
                price.input_micros_per_mtok,
                price.output_micros_per_mtok,
                price.cache_read_micros_per_mtok,
                price.cache_write_micros_per_mtok,
            ];
            if rates.iter().any(|rate| *rate < 0) {
                return Err(AnalyticsError::Config(format!(
                    "pricing for {}/{} has a negative rate",
                    price.provider, price.model
                )));
            }
        }
        Ok(())
    }

    /// Renders the snapshot as indented JSON.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Config`] when serialization fails, which would
    /// be a programming error for this type.
    pub fn to_json(&self) -> Result<String, AnalyticsError> {
        serde_json::to_string_pretty(self)
            .map_err(|error| AnalyticsError::Config(error.to_string()))
    }

    /// Parses a snapshot from JSON.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Config`] for malformed JSON or a snapshot that
    /// fails [`PricingSnapshot::validate`].
    pub fn from_json(text: &str) -> Result<Self, AnalyticsError> {
        let snapshot: Self = serde_json::from_str(text).map_err(|error| {
            AnalyticsError::Config(format!("invalid pricing snapshot: {error}"))
        })?;
        snapshot.validate()?;
        Ok(snapshot)
    }
}

/// A resolved cost with its status attached.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedCost {
    /// The cost in micro-USD, absent when unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub micros_usd: Option<i64>,
    /// How it was arrived at.
    pub status: CostStatus,
    /// The pricing version, when a snapshot was consulted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing_version: Option<String>,
}

impl ResolvedCost {
    /// The unknown cost. Never zero, never `Some(0)`.
    #[must_use]
    pub fn unknown() -> Self {
        Self {
            micros_usd: None,
            status: CostStatus::Unknown,
            pricing_version: None,
        }
    }

    /// Returns the cost as a decimal string, or `unknown`.
    ///
    /// A cost is never rendered as `0` unless it *is* zero, which only happens
    /// for a genuinely free or genuinely zero-priced route.
    #[must_use]
    pub fn render(&self) -> String {
        match (self.status, self.micros_usd) {
            (CostStatus::Unknown, _) | (_, None) => "unknown".to_owned(),
            (status, Some(micros)) => {
                format!("{:.6} USD ({})", micros as f64 / 1e6, status.as_str())
            }
        }
    }
}

/// Resolves the cost of one event against a local snapshot.
///
/// Returns `None` when the event carries **no cost fact at all** — a turn
/// boundary or a tool outcome, for instance. Such an event must not be folded
/// into a cost rollup, because treating "no information" as `unknown` would
/// poison every total it touched (`REQ-ANALYTICS-002`).
///
/// An event that *is* about cost but cannot be priced returns
/// `Some(ResolvedCost::unknown())`, which does poison the total, because that
/// genuinely is an unknown cost.
///
/// An event that already carries an **observed** cost keeps it: observation
/// always beats estimation.
#[must_use]
pub fn resolve(
    event: &crate::event::AnalyticsEvent,
    snapshot: Option<&PricingSnapshot>,
) -> Option<ResolvedCost> {
    if event.cost_status == CostStatus::Actual {
        return Some(ResolvedCost {
            micros_usd: event.cost_micros_usd,
            status: CostStatus::Actual,
            pricing_version: event.pricing_version.clone(),
        });
    }
    // Only a provider step is a cost fact. Everything else carries none.
    if event.kind != EventKind::StepUsage {
        return None;
    }
    let (Some(provider), Some(model)) = (&event.provider, &event.model) else {
        return Some(ResolvedCost::unknown());
    };
    let Some(snapshot) = snapshot else {
        return Some(ResolvedCost::unknown());
    };
    let Some(price) = snapshot.price(provider, model) else {
        return Some(ResolvedCost::unknown());
    };
    if price.included {
        return Some(ResolvedCost {
            micros_usd: Some(0),
            status: CostStatus::Included,
            pricing_version: Some(snapshot.version.clone()),
        });
    }
    if !event.tokens.observed {
        // Without an observation there is nothing to price. Reporting `0` here
        // would be a fabricated free call.
        return Some(ResolvedCost {
            micros_usd: None,
            status: CostStatus::Unknown,
            pricing_version: Some(snapshot.version.clone()),
        });
    }
    Some(ResolvedCost {
        micros_usd: Some(price.cost_micros(event.tokens)),
        status: CostStatus::Estimated,
        pricing_version: Some(snapshot.version.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::AnalyticsEvent;

    fn price(input: i64, output: i64) -> RoutePrice {
        RoutePrice {
            provider: "compatible".to_owned(),
            model: "mock-model".to_owned(),
            input_micros_per_mtok: input,
            output_micros_per_mtok: output,
            cache_read_micros_per_mtok: 0,
            cache_write_micros_per_mtok: 0,
            included: false,
        }
    }

    fn usage_event(tokens: Tokens) -> AnalyticsEvent {
        AnalyticsEvent::new(0, 0, "ses_1", EventKind::StepUsage)
            .with_route("compatible", "mock-model")
            .with_tokens(tokens)
    }

    fn resolve_of(
        event: &crate::event::AnalyticsEvent,
        snapshot: Option<&PricingSnapshot>,
    ) -> ResolvedCost {
        resolve(event, snapshot).expect("a step usage event is a cost fact")
    }

    #[test]
    fn an_event_with_no_cost_fact_resolves_to_nothing() {
        let snapshot =
            PricingSnapshot::new("v1", "test", 0).with_route(price(3_000_000, 15_000_000));
        for kind in [
            EventKind::TurnStart,
            EventKind::TurnEnd,
            EventKind::ToolOutcome,
            EventKind::Approval,
            EventKind::Retry,
        ] {
            let event = crate::event::AnalyticsEvent::new(0, 0, "ses_1", kind);
            assert_eq!(
                resolve(&event, Some(&snapshot)),
                None,
                "{} must not be a cost fact",
                kind.as_str()
            );
        }
    }

    #[test]
    fn no_snapshot_means_unknown_not_zero() {
        let cost = resolve_of(&usage_event(Tokens::observed(1000, 1000)), None);
        assert_eq!(cost.status, CostStatus::Unknown);
        assert_eq!(cost.micros_usd, None);
        assert_eq!(cost.render(), "unknown");
    }

    #[test]
    fn an_unpriced_route_stays_unknown() {
        let snapshot = PricingSnapshot::new("v1", "test", 0);
        let cost = resolve_of(&usage_event(Tokens::observed(1000, 1000)), Some(&snapshot));
        assert_eq!(cost.status, CostStatus::Unknown);
        assert_eq!(cost.micros_usd, None);
    }

    #[test]
    fn a_priced_route_resolves_to_estimated() {
        // 1_000_000 tokens at 3_000_000 micro-USD per million == 3_000_000.
        let snapshot =
            PricingSnapshot::new("v1", "test", 0).with_route(price(3_000_000, 15_000_000));
        let cost = resolve_of(
            &usage_event(Tokens::observed(1_000_000, 1_000_000)),
            Some(&snapshot),
        );
        assert_eq!(cost.status, CostStatus::Estimated);
        assert_eq!(cost.micros_usd, Some(18_000_000));
        assert_eq!(cost.pricing_version.as_deref(), Some("v1"));
    }

    #[test]
    fn an_observed_cost_is_never_overwritten_by_an_estimate() {
        let snapshot =
            PricingSnapshot::new("v1", "test", 0).with_route(price(3_000_000, 15_000_000));
        let event =
            usage_event(Tokens::observed(1_000_000, 1_000_000)).with_observed_cost(42, "billed");
        let cost = resolve_of(&event, Some(&snapshot));
        assert_eq!(cost.status, CostStatus::Actual);
        assert_eq!(cost.micros_usd, Some(42));
        assert_eq!(cost.pricing_version.as_deref(), Some("billed"));
    }

    #[test]
    fn an_included_route_reports_zero_without_faking_a_price() {
        let mut price = price(0, 0);
        price.included = true;
        let snapshot = PricingSnapshot::new("v1", "test", 0).with_route(price);
        let cost = resolve_of(
            &usage_event(Tokens::observed(1_000_000, 1_000_000)),
            Some(&snapshot),
        );
        assert_eq!(cost.status, CostStatus::Included);
        assert_eq!(cost.micros_usd, Some(0));
    }

    #[test]
    fn unobserved_tokens_stay_unknown_even_with_a_price() {
        let snapshot =
            PricingSnapshot::new("v1", "test", 0).with_route(price(3_000_000, 15_000_000));
        let cost = resolve_of(&usage_event(Tokens::unobserved()), Some(&snapshot));
        assert_eq!(cost.status, CostStatus::Unknown);
        assert_eq!(cost.micros_usd, None);
    }

    #[test]
    fn a_rollup_is_only_as_strong_as_its_weakest_member() {
        assert_eq!(
            CostStatus::weakest_of([CostStatus::Actual, CostStatus::Actual]),
            CostStatus::Actual
        );
        assert_eq!(
            CostStatus::weakest_of([CostStatus::Actual, CostStatus::Estimated]),
            CostStatus::Estimated
        );
        assert_eq!(
            CostStatus::weakest_of([CostStatus::Estimated, CostStatus::Unknown]),
            CostStatus::Unknown
        );
        assert_eq!(CostStatus::weakest_of([]), CostStatus::Unknown);
    }

    #[test]
    fn a_negative_rate_is_refused() {
        let snapshot = PricingSnapshot::new("v1", "test", 0).with_route(price(-1, 0));
        assert!(snapshot.validate().is_err());
    }

    #[test]
    fn an_empty_version_is_refused() {
        let snapshot = PricingSnapshot::new("  ", "test", 0);
        assert!(snapshot.validate().is_err());
    }

    #[test]
    fn a_snapshot_round_trips_through_json() {
        let snapshot = PricingSnapshot::new("v2", "local-file", 42).with_route(price(1, 2));
        let text = snapshot.to_json().unwrap();
        assert_eq!(PricingSnapshot::from_json(&text).unwrap(), snapshot);
    }
}
