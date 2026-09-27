//! Integration proofs for the analytics ledger and rollups
//! (`CMP-analytics`).
//!
//! Every test drives the real ledger file and a real SQLite database in a temp
//! root. Nothing is mocked: no fake clock (timestamps are explicit), no fake
//! filesystem, and no network is reachable from this crate at all.

use std::path::PathBuf;

use horizoncode_analytics::{
    AnalyticsConfig, AnalyticsEvent, AnalyticsLog, CostStatus, EventKind, PricingSnapshot, Rollups,
    RoutePrice, Tokens, ToolMeasurement, ToolOutcomeKind, insights_ending_on, session_detail,
    usage,
};

/// The UTC day the seeded run is stamped with, so every window assertion is
/// pinned rather than depending on the host clock.
const SEED_DAY: &str = "2024-01-01";
use tempfile::TempDir;

struct Harness {
    /// Held so the temp root outlives the log.
    _dir: TempDir,
    config: AnalyticsConfig,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        Self {
            config: AnalyticsConfig::new(dir.path().join("analytics")),
            _dir: dir,
        }
    }

    fn open(&self) -> AnalyticsLog {
        AnalyticsLog::open(self.config.clone()).unwrap()
    }

    fn rollups(&self) -> Rollups {
        Rollups::open(&self.config.root.join("rollup.sqlite3")).unwrap()
    }

    /// Removes the derived rollups, leaving the ledger untouched — the
    /// "rollup is derived, not authoritative" stance made concrete.
    fn drop_rollups(&self) {
        std::fs::remove_file(self.config.root.join("rollup.sqlite3")).unwrap();
        for suffix in ["-wal", "-shm"] {
            let path: PathBuf = self.config.root.join(format!("rollup.sqlite3{suffix}"));
            let _ = std::fs::remove_file(path);
        }
    }
}

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

/// A deterministic, representative run: two sessions, two steps each, tools,
/// and an approval.
fn seed(config: &AnalyticsConfig) {
    let log = AnalyticsLog::open(config.clone()).unwrap();
    let base = 1_704_067_200_000; // 2024-01-01T00:00:00Z
    let mut ts = base;
    for (index, session) in ["ses_1", "ses_2"].iter().enumerate() {
        let offset = i64::try_from(index).unwrap();
        ts += 1;
        log.append(
            AnalyticsEvent::new(0, ts, *session, EventKind::TurnStart)
                .with_turn(format!("turn_{session}"))
                .with_project("workspace")
                .with_audit_seq(index as u64 * 100),
        )
        .unwrap();
        for step in 1..=2u64 {
            ts += 1;
            log.append(
                AnalyticsEvent::new(0, ts, *session, EventKind::StepUsage)
                    .with_turn(format!("turn_{session}"))
                    .with_step(step)
                    .with_project("workspace")
                    .with_route("compatible", "mock-model")
                    .with_tokens(
                        Tokens::observed(1000 + offset as u64 * 10, 500)
                            .with_cache(100, 50)
                            .with_reasoning(25),
                    )
                    .with_audit_seq(index as u64 * 100 + step),
            )
            .unwrap();
        }
        ts += 1;
        log.append(
            AnalyticsEvent::new(0, ts, *session, EventKind::ToolOutcome)
                .with_turn(format!("turn_{session}"))
                .with_tool(ToolMeasurement {
                    tool: Some("read".to_owned()),
                    outcome: Some(ToolOutcomeKind::Accepted),
                    latency_ms: Some(10 + offset as u64 * 5),
                    ..ToolMeasurement::default()
                }),
        )
        .unwrap();
        ts += 1;
        log.append(
            AnalyticsEvent::new(0, ts, *session, EventKind::ToolOutcome)
                .with_turn(format!("turn_{session}"))
                .with_tool(ToolMeasurement {
                    tool: Some("write".to_owned()),
                    outcome: Some(ToolOutcomeKind::Rejected),
                    latency_ms: Some(30),
                    error_class: Some("policy".to_owned()),
                    lines_added: Some(4),
                    lines_removed: Some(1),
                }),
        )
        .unwrap();
        ts += 1;
        log.append(
            AnalyticsEvent::new(0, ts, *session, EventKind::TurnEnd)
                .with_turn(format!("turn_{session}")),
        )
        .unwrap();
    }
}

#[test]
fn rollups_are_correct_after_a_rebuild_from_the_ledger() {
    let harness = Harness::new();
    seed(&harness.config);

    let first = harness.open().rebuild().unwrap();
    assert_eq!(first.events_read, 12);
    assert_eq!(first.session_rows, 2);
    assert_eq!(first.model_rows, 2);
    assert_eq!(first.tool_rows, 4, "two tools per session");
    assert_eq!(first.day_rows, 1);

    // Record the rows as a canonical snapshot.
    let before = harness.rollups().all_session_usage().unwrap();
    let models_before = harness.rollups().model_usage("ses_1").unwrap();
    let tools_before = harness.rollups().tool_stats("ses_1").unwrap();
    let days_before = harness.rollups().daily(None).unwrap();

    // Drop the derived index entirely; the ledger is untouched.
    harness.drop_rollups();
    assert!(!harness.config.root.join("rollup.sqlite3").exists());
    assert_eq!(
        std::fs::read_to_string(harness.config.root.join("events.jsonl"))
            .unwrap()
            .lines()
            .count(),
        12,
        "the ledger survives a rollup wipe"
    );

    // A query against the missing index rebuilds it rather than failing.
    let report = usage(&harness.config, None).unwrap();
    assert_eq!(report.events, 12);
    let rollups = harness.rollups();
    assert_eq!(rollups.row_counts().unwrap().sessions, 2);

    // The rebuilt rows are identical to the pre-wipe rows.
    assert_eq!(rollups.all_session_usage().unwrap(), before);
    assert_eq!(rollups.model_usage("ses_1").unwrap(), models_before);
    assert_eq!(rollups.tool_stats("ses_1").unwrap(), tools_before);
    assert_eq!(rollups.daily(None).unwrap(), days_before);

    // And the arithmetic is right, not merely stable.
    let session = rollups.session_usage("ses_1").unwrap().unwrap();
    assert_eq!(session.turns, 1);
    assert_eq!(session.steps, 2);
    assert_eq!(session.tool_calls, 2);
    assert_eq!(session.tokens.input, 2000);
    assert_eq!(session.tokens.output, 1000);
    assert_eq!(session.tokens.cache_read, 200);
    assert_eq!(session.tokens.cache_write, 100);
    assert_eq!(session.tokens.reasoning, 50);
    assert!(session.tokens.observed);
}

#[test]
fn unknown_pricing_stays_unknown_across_a_rebuild() {
    let harness = Harness::new();
    seed(&harness.config);

    // No pricing snapshot: every cost is unknown, with no number attached.
    let rollups = harness.rollups();
    for session in rollups.all_session_usage().unwrap() {
        assert_eq!(session.cost_status, CostStatus::Unknown, "{session:?}");
        assert_eq!(session.cost_micros_usd, None, "{session:?}");
        assert_eq!(session.render_cost(), "unknown");
    }
    for model in rollups.model_usage("ses_1").unwrap() {
        assert_eq!(model.cost_status, CostStatus::Unknown);
        assert_eq!(model.cost_micros_usd, None);
    }
    let day = &rollups.daily(None).unwrap()[0];
    assert_eq!(day.cost_status, CostStatus::Unknown);
    assert_eq!(day.cost_micros_usd, None);
    assert!(rollups.pricing_snapshot().unwrap().is_none());

    // The surface says so out loud rather than printing a zero.
    let report = usage(&harness.config, None).unwrap();
    assert!(report.cost_unknown);
    assert!(
        report.render().contains("cost: unknown"),
        "{}",
        report.render()
    );
    assert!(
        report.render().contains("no price was invented"),
        "{}",
        report.render()
    );

    // Wipe and rebuild: still unknown, still no number, still not zero.
    harness.drop_rollups();
    let rebuilt = harness.open().rebuild().unwrap();
    assert!(!rebuilt.pricing_known);
    let rollups = harness.rollups();
    for session in rollups.all_session_usage().unwrap() {
        assert_eq!(session.cost_status, CostStatus::Unknown);
        assert_eq!(session.cost_micros_usd, None);
    }
    assert!(
        !rollups
            .all_session_usage()
            .unwrap()
            .iter()
            .any(|row| row.cost_micros_usd == Some(0)),
        "an unknown cost must never be stored as zero"
    );
}

#[test]
fn a_pricing_snapshot_produces_estimated_costs_that_survive_a_rebuild() {
    let harness = Harness::new();
    seed(&harness.config);
    let snapshot = PricingSnapshot::new("pricing-v1", "local-test", 42).with_route(price(
        3_000_000,  // 3 USD per million input tokens
        15_000_000, // 15 USD per million output tokens
    ));
    harness.open().save_pricing(&snapshot).unwrap();

    let before = harness.open().rebuild().unwrap();
    assert!(before.pricing_known);
    let rollups = harness.rollups();
    let session = rollups.session_usage("ses_1").unwrap().unwrap();
    // 2 steps x (1000 in, 500 out) = 2000 in, 1000 out.
    // 2000/1e6 * 3_000_000 = 6_000 ; 1000/1e6 * 15_000_000 = 15_000.
    assert_eq!(session.cost_micros_usd, Some(21_000));
    assert_eq!(session.cost_status, CostStatus::Estimated);
    assert_eq!(session.pricing_version.as_deref(), Some("pricing-v1"));
    assert_eq!(session.render_cost(), "0.021000 USD (estimated)");

    harness.drop_rollups();
    harness.open().rebuild().unwrap();
    let after = harness.rollups().session_usage("ses_1").unwrap().unwrap();
    assert_eq!(after, session, "a rebuild reproduces the same cost");
    assert_eq!(
        harness
            .rollups()
            .pricing_snapshot()
            .unwrap()
            .unwrap()
            .version,
        "pricing-v1"
    );
}

#[test]
fn an_observed_cost_is_never_overwritten_by_the_local_snapshot() {
    let harness = Harness::new();
    let log = harness.open();
    log.append(
        AnalyticsEvent::new(0, 1, "ses_1", EventKind::StepUsage)
            .with_route("compatible", "mock-model")
            .with_tokens(Tokens::observed(1_000_000, 1_000_000))
            .with_observed_cost(4242, "provider-invoice"),
    )
    .unwrap();
    log.save_pricing(
        &PricingSnapshot::new("pricing-v1", "local-test", 0)
            .with_route(price(3_000_000, 15_000_000)),
    )
    .unwrap();
    log.rebuild().unwrap();

    let session = harness.rollups().session_usage("ses_1").unwrap().unwrap();
    assert_eq!(session.cost_status, CostStatus::Actual);
    assert_eq!(session.cost_micros_usd, Some(4242));
    assert_eq!(session.pricing_version.as_deref(), Some("provider-invoice"));
}

#[test]
fn an_unknown_contributor_poisons_a_rollup_total() {
    let harness = Harness::new();
    let log = harness.open();
    // One priced, observable step.
    log.append(
        AnalyticsEvent::new(0, 1, "ses_1", EventKind::StepUsage)
            .with_route("compatible", "mock-model")
            .with_tokens(Tokens::observed(1_000_000, 0)),
    )
    .unwrap();
    // One step the provider reported nothing for: it cannot be priced.
    log.append(
        AnalyticsEvent::new(0, 2, "ses_1", EventKind::StepUsage)
            .with_route("compatible", "mock-model")
            .with_tokens(Tokens::unobserved()),
    )
    .unwrap();
    log.save_pricing(
        &PricingSnapshot::new("v1", "test", 0).with_route(price(3_000_000, 15_000_000)),
    )
    .unwrap();
    log.rebuild().unwrap();

    let session = harness.rollups().session_usage("ses_1").unwrap().unwrap();
    assert_eq!(
        session.cost_status,
        CostStatus::Unknown,
        "a known cost plus an unknown one is still unknown"
    );
    assert_eq!(session.cost_micros_usd, None);
    // Only the observed step contributes tokens; the unobserved one contributes
    // nothing rather than a fabricated zero-and-therefore-free.
    assert_eq!(session.tokens.input, 1_000_000);
    assert_eq!(session.tokens.output, 0);
    assert!(session.tokens.observed);
    assert_eq!(
        session.steps, 2,
        "both steps are counted even without usage"
    );
}

#[test]
fn tool_metrics_expose_calls_outcomes_and_latency_percentiles() {
    let harness = Harness::new();
    let log = harness.open();
    for (index, latency) in [5u64, 10, 15, 20, 100].iter().enumerate() {
        log.append(
            AnalyticsEvent::new(0, index as i64 + 1, "ses_1", EventKind::ToolOutcome).with_tool(
                ToolMeasurement {
                    tool: Some("bash".to_owned()),
                    outcome: Some(if index == 0 {
                        ToolOutcomeKind::Rejected
                    } else {
                        ToolOutcomeKind::Accepted
                    }),
                    latency_ms: Some(*latency),
                    error_class: (index == 0).then(|| "policy".to_owned()),
                    ..ToolMeasurement::default()
                },
            ),
        )
        .unwrap();
    }
    log.rebuild().unwrap();

    let stats = harness.rollups().tool_stats_with_samples("ses_1").unwrap();
    let bash = stats
        .iter()
        .find(|row| row.tool == "bash")
        .expect("the bash row must exist");
    assert_eq!(bash.calls, 5);
    assert_eq!(bash.accepted, 4);
    assert_eq!(bash.rejected, 1);
    assert_eq!(bash.errors, 1);
    assert_eq!(bash.latency_ms_sum, 150);
    assert_eq!(bash.latency_ms_max, 100);
    let samples = harness.rollups().latency_samples("ses_1", "bash").unwrap();
    assert_eq!(samples, vec![5, 10, 15, 20, 100]);
    assert_eq!(bash.latency_percentile(0.50), Some(15));
    assert_eq!(bash.latency_percentile(0.95), Some(100));
    assert_eq!(bash.accept_rate(), Some(0.8));
}

#[test]
fn the_usage_surface_renders_tokens_and_an_honest_cost() {
    let harness = Harness::new();
    seed(&harness.config);
    let report = usage(&harness.config, Some("ses_1")).unwrap();
    assert_eq!(report.sessions.len(), 1);
    let rendered = report.render();
    assert!(rendered.contains("engineering analytics"), "{rendered}");
    assert!(rendered.contains("tokens: in=2000"), "{rendered}");
    assert!(rendered.contains("cost: unknown"), "{rendered}");
    assert!(rendered.contains("network egress: none"), "{rendered}");
    assert!(rendered.contains("not observed by the provider") || rendered.contains("observed"));
}

#[test]
fn the_insights_surface_aggregates_a_window_and_reports_percentiles() {
    let harness = Harness::new();
    seed(&harness.config);
    let report = insights_ending_on(&harness.config, 7, SEED_DAY).unwrap();
    assert_eq!(report.days, 7);
    assert_eq!(report.events, 12, "the seeded run is inside a 7-day window");
    assert_eq!(report.tools.len(), 2, "read and write");
    let read = report
        .tools
        .iter()
        .find(|tool| tool.tool == "read")
        .expect("the read aggregate must exist");
    assert_eq!(read.calls, 2);
    assert_eq!(read.accepted, 2);
    assert_eq!(read.p50_ms, Some(10));
    let write = report
        .tools
        .iter()
        .find(|tool| tool.tool == "write")
        .expect("the write aggregate must exist");
    assert_eq!(write.rejected, 2);
    assert_eq!(write.errors, 2);
    assert_eq!(report.models.len(), 1);
    assert_eq!(report.models[0].calls, 4);
    let rendered = report.render();
    assert!(
        rendered.contains("insights over the last 7 day(s)"),
        "{rendered}"
    );
    assert!(rendered.contains("network egress: none"), "{rendered}");
}

#[test]
fn a_window_older_than_the_run_is_empty_rather_than_guessing() {
    let harness = Harness::new();
    seed(&harness.config);
    // The seeded run is stamped 2024-01-01, so a window ending long after it
    // contains nothing — and says so instead of widening itself.
    let later = insights_ending_on(&harness.config, 7, "2024-02-01").unwrap();
    assert_eq!(later.events, 0);
    assert!(later.daily.is_empty());
    assert!(later.tools.is_empty());
    assert!(
        later
            .render()
            .contains("no activity recorded in the window"),
        "{}",
        later.render()
    );
    // A window that does contain the run is not empty.
    let covering = insights_ending_on(&harness.config, 7, SEED_DAY).unwrap();
    assert_eq!(covering.events, 12);
    // A zero-day window is honoured as a zero-day window, not silently widened.
    let zero = insights_ending_on(&harness.config, 0, SEED_DAY).unwrap();
    assert_eq!(zero.days, 0);
    assert_eq!(
        zero.events, 12,
        "day 0 still includes the anchor day itself"
    );
}

#[test]
fn session_detail_exposes_usage_routes_and_tools() {
    let harness = Harness::new();
    seed(&harness.config);
    let detail = session_detail(&harness.config, "ses_1").unwrap();
    assert_eq!(detail.usage.session, "ses_1");
    assert_eq!(detail.models.len(), 1);
    assert_eq!(detail.models[0].model, "mock-model");
    assert_eq!(detail.tools.len(), 2);
    assert!(session_detail(&harness.config, "ses_missing").is_err());
}

#[test]
fn export_streams_the_ledger_and_sanitize_scrubs_the_denied_fields() {
    let harness = Harness::new();
    seed(&harness.config);
    let log = harness.open();

    let mut plain = Vec::new();
    assert_eq!(log.export(&mut plain, false).unwrap(), 12);
    let text = String::from_utf8(plain).unwrap();
    assert_eq!(text.lines().count(), 12);
    assert!(text.contains("mock-model"), "a raw export keeps the route");
    assert!(text.contains("workspace"), "a raw export keeps the project");

    let mut scrubbed = Vec::new();
    assert_eq!(log.export(&mut scrubbed, true).unwrap(), 12);
    let text = String::from_utf8(scrubbed).unwrap();
    assert_eq!(text.lines().count(), 12);
    assert!(
        !text.contains("mock-model"),
        "a sanitized export drops the route"
    );
    assert!(
        !text.contains("workspace"),
        "a sanitized export drops the project"
    );
    assert!(
        text.contains("\"input\":1000"),
        "counts survive sanitization"
    );
    // No prompt or completion text is ever present: the schema has no field for
    // it, which is stronger than a scrubber.
    assert!(!text.contains("prompt"));
    assert!(!text.contains("content"));
}

#[test]
fn an_empty_ledger_produces_empty_rollups_rather_than_no_table() {
    let harness = Harness::new();
    harness.open();
    let rollups = harness.rollups();
    assert_eq!(rollups.row_counts().unwrap().sessions, 0);
    let report = harness.open().rebuild().unwrap();
    assert_eq!(report.events_read, 0);
    assert_eq!(report.session_rows, 0);
    assert!(!report.pricing_known);
}
