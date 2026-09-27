# 20 — Analytics

`CMP-analytics`. Observability for long-horizon work. **Local-first**: the analytics path performs no network egress.

## Purpose

Answer, truthfully and on demand: what did this session/turn cost, which tools and models were used, how well did routing work, and where did time and money go. Analytics exists to make long runs *inspectable*, not to decorate the UI.

## Responsibilities

- Record per-turn usage and cost, attributable per session, model, and project.
- Record per-tool outcomes (accept/reject, errors, latency, bytes changed).
- Record reliability signals (retries, failure reasons, cancellations) and routing outcomes.
- Roll events up into queryable aggregates; serve them to the TUI and headless surfaces.
- Export machine-readable data locally.
- Keep **engineering analytics** (tokens/cost/latency/retries) distinct from any **product analytics** (leaderboards, adoption).

Out of scope: being a source of truth for sessions or audit. `CMP-session` and `CMP-audit` own those; analytics *derives*.

## Interfaces

| Direction | Component | Contract |
|---|---|---|
| Reads | `CMP-session` | step/usage events, turn boundaries |
| Reads | `CMP-provider` | usage triple, provider metadata, pricing version |
| Reads | `CMP-tools` | tool call/result outcome, timing |
| Reads | `CMP-guard` | approval decisions (counts only) |
| Reads | `CMP-orch` | subagent/job lifecycle |
| Refs | `CMP-audit` | step-receipt ids (link, never duplicate raw payloads) |
| Serves | `CMP-tui`, `CMP-headless`, `CMP-acp` | `/usage`, `/insights`, `stats`, `export`, ACP `usage_update` |

## Data / state model

Append-only **event ledger** `~/.horizoncode/analytics/events.jsonl` (source of truth, rebuildable) plus an SQLite rollup index.

`analytics_event` (one per turn/step/tool): `{event_id, run_id?, task_id?, attempt_id?, turn_id, session_id, project, agent, model, kind, seq, ts, tokens{input,output,cache_read,cache_creation,reasoning}, money{amount_decimal?, currency?, basis, source, pricing_version?, observed_at?}, quota{units?, unit?, basis, source?}, tool{name,outcome,latency_ms,bytes}, retry{reason,attempt}, error_class}`. `basis = actual | estimated | included | unknown`; an unknown amount has no fabricated numeric value. Currency uses ISO 4217 where known. Preserve the original source amount as immutable evidence.

Derived tables: `session_usage`, `session_model_usage` (per-route upsert), `tool_stats`, `daily_rollup`, `pricing_snapshot{version, source, fetched_at}`.

Cost semantics: **observed vs estimated** must never be conflated. `Money` rows preserve source currency, amount basis, pricing provenance, and observation time. Missing price is unknown, not zero. Mixed currencies are grouped separately; an optional converted view records its rate, source, timestamp, and rounding without rewriting the original. If a run budget is denominated in one currency, provider amounts are converted only using the run's pinned, policy-approved rate snapshot; if no usable rate exists, reserve/fail-closed according to the configured budget policy instead of inventing a total. Tokens, quota usage, billed amount, included plan benefit, and provider-reported estimate remain distinct (`REQ-ANALYTICS-007`, `DEC-034`).

Metric definitions:
- **Usage/cost**: token classes + original money amount by model and currency, with actual/estimated/included/unknown basis; optional converted view is separately identified.
- **Tool**: calls, `accepted|rejected|bypassed`, accept-rate, error count, p50/p95 latency, bytes changed (lines added/removed for edit-class tools).
- **Session/run**: sessions, turns/session, tool-calls/turn, commits/PRs attributed, prompt-cache hit-rate.
- **Reliability**: latency histogram, retries, failure taxonomy (auth / rate-limit / timeout / tool-error / cancelled), cancel rate.
- **Routing**: per-model accept-rate, cost-per-success, fallback frequency.

## Lifecycle & flows

1. `CMP-provider` and `CMP-tools` emit usage/outcome facts during a step; `CMP-session` already persists the step.
2. Analytics appends ledger events (coalesced writes), then rolls up affected keys.
3. Queries read rollups; if a rollup is missing/corrupt, it is rebuilt from the ledger.
4. `export` streams the ledger (optionally sanitized); `stats`/`insights` aggregate on read.

## Failure modes

- **Missing/unknown pricing** → mark `estimated`/`unknown`; never guess.
- **Clock skew** → events carry monotonic sequence as tiebreak; rollups keyed by session+turn, not wall time alone.
- **Crash mid-rollup** → rollup is derived; rebuild from ledger (same recovery stance as sessions).
- **Ledger unbounded growth** → retention/rotation policy; aggregates survive compaction.
- **Sanitization miss** → a deny-list scrub runs before any export; prompts and file contents are excluded by default.
- **Mixed currency rollup** → emit separate currency buckets and no combined total unless a traceable conversion snapshot is selected.
- **Provider reports included/zero billed usage** → record monetary basis and quota consumption independently; zero invoice amount never erases tokens or limits.
- **Pricing update or FX change** → append a new pricing/rate version; historical analytics and budget evidence keep the source version that applied at execution time.

## Configuration

`analytics.enabled`, `analytics.retention`, `analytics.pricing_source` (+ `offline`), `analytics.display_currency` (optional, view-only), `analytics.fx_source` (explicit/pinned when conversion is enabled), `analytics.otel` (**off** by default), `analytics.remote_optin` (**off**; explicit and sanitized when on), managed lockdown respected.

## Requirements mapping

`REQ-ANALYTICS-001..007`.

## Open questions

- Rollup retention window vs ledger retention.
- Optional OTEL attribute set and stability guarantees.
- Whether "commits/PRs attributed" belongs here or in the orchestration/CI layer.
