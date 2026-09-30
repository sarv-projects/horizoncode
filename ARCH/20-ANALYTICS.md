# 20 — Analytics

`CMP-analytics`. Observability for long-horizon work. **Local-first** (`DEC-017`): the default analytics path performs no network egress. An explicitly enabled OTEL/remote exporter is a separate guarded, sanitized outbound effect, disabled by default and subject to managed policy.

## Source status

The schema and lifecycle below are the **proposed target**, not the current
analytics database contract. At Rust baseline `23d4ce8` (source-map commit `cbba87b`,
2026-09-28), `AnalyticsEvent` is session/turn/step oriented and records
USD-specific `cost_micros_usd`; run/task/attempt attribution, native source
currency, quota provenance, and pinned pricing snapshots are not established by
the present event type. Inspect `crates/horizoncode-analytics/src/event.rs` and
`cost.rs`; delivery remains tracked by AX-109/334. Do not label target fields as
stored or verified until migrations and evidence land.

## Purpose

Answer, truthfully and on demand: what did this session/turn cost, which tools and models were used, how well did routing work, and where did time and money go. Analytics exists to make long runs *inspectable*, not to decorate the UI.

## Responsibilities

- Record per-turn usage and cost, attributable per session, model, and project.
- Record per-tool execution outcomes (started/settled/denied/error, latency, bytes changed), distinct from independently verified Task/Run acceptance.
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

The append-only `~/.horizoncode/analytics/events.jsonl` is a durable, rebuildable **analytics projection**, not a canonical source of execution truth. Its rows are derived from canonical Thread, audit, provider, tool, and controller facts. SQLite rollups are derived again from this ledger. A rebuild must validate the source references and digests; it must not infer missing facts or promote an analytics-only row into an execution/audit fact. The event ledger itself is recoverable from its canonical sources and may be compacted only after the configured retention/export contract is satisfied.

`analytics_event` (one per turn/step/tool): `{event_id, run_id?, task_id?, attempt_id?, thread_id, turn_id, project, agent, model, kind, source_refs[], audit_seq?, effect_id?, effect_receipt_ref?, ts, tokens{input,output,cache_read,cache_creation,reasoning}, money{amount_decimal?, currency?, basis, source, pricing_version?, observed_at?}, quota{units?, unit?, basis, source?, observation_ref?}, tool{name,outcome,latency_ms,bytes}, retry{reason,attempt}, error_class}`. `source_refs[]` contains one or more `DurableFactRef` values: `{store_id, aggregate_type, aggregate_id, seq, event_id, payload_digest, schema_version}`. A ref identifies the canonical persisted fact from which the analytics row was derived; it is not a copied payload. Every event that represents a security-relevant effect MUST carry its authoritative audit `DurableFactRef` (including `audit_seq`) or stable `effect_receipt_ref` and `effect_id`; ordinary usage-only rows still require a canonical source ref and must not invent an effect link. Provider quota analytics rows MUST reference a canonical provider-owned `QuotaObservation`; analytics never polls providers or becomes quota truth. Missing, unreadable, or digest-mismatched source facts quarantine the projection row and raise an integrity diagnostic; they do not become zero usage or successful work. `basis = actual | estimated | included | unknown`; an unknown amount has no fabricated numeric value. Currency uses ISO 4217 where known. Preserve the original source amount as immutable evidence. Imported legacy session events retain their source payload/digest; a versioned projection maps their verified local conversation ID to `thread_id`.

For direct interactive turns, `run_id`, `task_id`, and `attempt_id` are absent/null;
the canonical attribution key is `(thread_id, turn_id)`. Do not invent a ghost Run to
fit a managed-run dashboard. Cache-read and cache-write/creation usage remain distinct
provider observations. Preserve the provider's original usage fields and normalize
only documented equivalents; provider route pricing determines their cost and an
unknown cache field is not zero. The data model already permits absent Run/Task/Attempt
IDs; this paragraph makes that direct-turn accounting contract explicit (`REQ-ANALYTICS-009`).

Derived tables: `thread_usage`, `thread_model_usage` (per-route upsert), `tool_stats`, `daily_rollup`, `pricing_snapshot{version, source, fetched_at}`. Existing `session_usage` projections are rebuildable and migrate from canonical Thread events; they do not create a second conversation identity.

Machine export envelope: `AnalyticsExport = {export_id, schema_version, generated_at, query, rows[], source_coverage: COMPLETE | INCOMPLETE, missing_ranges[], source_manifest_digest}`. A complete export requires validated source refs for the entire declared query range. An incomplete export names unavailable/corrupt owner ranges and must not be presented as a complete total. Sanitization changes the exported view but never rewrites canonical source facts.

Cost semantics: **observed vs estimated** must never be conflated. `Money` rows preserve source currency, amount basis, pricing provenance, and observation time. Missing price is unknown, not zero. Mixed currencies are grouped separately; an optional converted view records its rate, source, timestamp, and rounding without rewriting the original. If a run budget is denominated in one currency, provider amounts are converted only using the run's pinned, policy-approved rate snapshot; if no usable rate exists, reserve/fail-closed according to the configured budget policy instead of inventing a total. Tokens, quota usage, billed amount, included plan benefit, and provider-reported estimate remain distinct (`REQ-ANALYTICS-007`, `DEC-034`).
Provider quota observations are external, time-bounded account snapshots, not consumed-token events or HorizonCode reservation balances. Preserve provider/account reference, each window/unit, reported values, and freshness through the referenced source fact; never sum or compare unlike windows/units. Stale observations can remain visible with an age label but must not be presented as current quota.

Metric definitions:
- **Usage/cost**: token classes + original money amount by model and currency, with actual/estimated/included/unknown basis; optional converted view is separately identified.
- **Tool**: calls, `executed|denied|failed|cancelled`, error count, p50/p95 latency, bytes changed (lines added/removed for edit-class tools). “Executed” does not mean the resulting Task passed or the user accepted it.
- **Thread/run**: Threads, turns/Thread, tool-calls/turn, commits/PRs attributed, prompt-cache hit-rate.
- **Reliability**: latency histogram, retries, failure taxonomy (auth / rate-limit / timeout / tool-error / cancelled), cancel rate.
- **Routing**: per-model verified-task pass rate only when linked verifier evidence exists; separately report invocation error rate, unknown outcome, cost per verified pass, and fallback frequency. Never use a worker/tool's self-reported completion as success.

## Lifecycle & flows

1. `CMP-provider`, `CMP-tools`, `CMP-guard`, and `CMP-orch` append canonical facts through their owning durable stores; Thread events persist model-visible step boundaries.
2. Analytics reads committed canonical facts, appends derived ledger rows with `source_refs[]` (coalesced writes), then rolls up affected keys. A row is not visible as complete until its source refs validate.
3. Queries read rollups; if a rollup is missing/corrupt, it is rebuilt from the derived ledger. If the ledger is missing/corrupt, it is rebuilt from the referenced canonical facts within the retention window, with explicit incomplete-coverage status if a source is unavailable.
4. `export` streams a versioned export that includes source-reference coverage (optionally sanitized); `stats`/`insights` aggregate on read.

## Failure modes

- **Missing/unknown pricing** → mark `estimated`/`unknown`; never guess.
- **Clock skew** → events carry monotonic sequence as tiebreak; rollups keyed by session+turn, not wall time alone.
- **Crash mid-rollup** → rollup is derived; rebuild from the derived ledger.
- **Ledger missing/corrupt or source unavailable** → replay verified canonical source facts; report exact missing ranges rather than silently claiming complete totals.
- **Ledger unbounded growth** → bounded retention/rotation policy; preserve required canonical sources and export receipts before compacting derived rows. Aggregates survive only with coverage metadata showing the source range.
- **Sanitization miss** → a deny-list scrub runs before any export; prompts and file contents are excluded by default.
- **Mixed currency rollup** → emit separate currency buckets and no combined total unless a traceable conversion snapshot is selected.
- **Provider reports included/zero billed usage** → record monetary basis and quota consumption independently; zero invoice amount never erases tokens or limits.
- **Pricing update or FX change** → append a new pricing/rate version; historical analytics and budget evidence keep the source version that applied at execution time.

## Configuration

`analytics.enabled`, `analytics.retention`, `analytics.pricing_source` (+ `offline`), `analytics.display_currency` (optional, view-only), `analytics.fx_source` (explicit/pinned when conversion is enabled), `analytics.otel` (**off** by default), `analytics.remote_optin` (**off**; explicit and sanitized when on), managed lockdown respected.

## Requirements mapping

`REQ-ANALYTICS-001..008`.

## Open questions

- Exact analytics projection retention/window and coverage metadata when canonical source facts themselves expire or are exported.
- Optional OTEL attribute set and stability guarantees.
- Whether "commits/PRs attributed" belongs here or in the orchestration/CI layer.
