# CodeBurn: local coding-agent usage and session observability

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `2a7d9588d88ac4fd938f4f13462de51735d59334`; latest release v0.9.25 (2026-09-21). Focused audit of provider parsers, aggregation, storage, cost and privacy behavior.

## HLD

CodeBurn is an observability/reporting tool for locally stored transcripts and usage records from many coding-agent providers. Provider-specific parsers normalize native logs; shared aggregation produces session/project/day summaries; CLI/TUI and desktop/menu-bar shells consume a JSON-oriented interface. It is not a universal agent runtime and cannot observe events that a provider never writes to disk.

## LLD and data flow

1. Discover provider-specific local stores and session files.
2. Parse each source into a normalized provider-call/session record while preserving provider-specific semantics.
3. Deduplicate and aggregate by session, project, day and provider; attach task, branch, PR, model and cost fields when available.
4. Cache expensive parses/versioned summaries; use worker threads for cold parsing of large histories.
5. Render reports/dashboard/export or expose selected metrics to local hooks/optional sync.

The reviewed implementation uses source adapters (example: provider parser files), a central parse/aggregation path and atomic/versioned JSON caches under the user's cache directory. It keeps daily aggregate history and provider/month session shards rather than defining one canonical relational schema for all agents. Read-only SQL wrappers access some source-agent SQLite stores. Provider-specific cost may be exact or estimated; lineage is available only where source logs preserve parent/child relationships.

## Budget and privacy boundaries

Usage dashboards and quota parsing are telemetry, not a hard execution governor: they do not by themselves reserve budget before a model/tool action and reconcile actual use afterward. The optional guard is implemented through local hooks and must be enabled/configured. The CLI's core reads local data and fetches public pricing/currency data; desktop anonymous telemetry is consent-gated, and sync is separately opt-in. When enabled, sync sends usage-oriented OTLP attributes and is documented not to include prompts/code; verify exact consent/version and payload before deployment.

## Failure modes and limits

- Provider schemas, file locations, cache formats and pricing change; parser gaps can silently undercount cost or omit sessions.
- Missing child-parent lineage means external subagent cost cannot be attributed reliably.
- A local transcript is not necessarily the complete source of tool effects, branch state or verification.
- Token/cost estimates need provenance and confidence. Never treat unreported usage as zero.
- Session cache retention and opt-in sync require an explicit privacy/retention policy.

## Relevance to HorizonCode

Useful for provider-parser modularity, cross-agent cost attribution, usage dashboards and low-friction local hooks. HorizonCode's controller needs a different contract: pre-action reservations, post-action reconciliation, shared-quota visibility, durable parent-child links and an “unknown usage” state. Consume CodeBurn-like data as an observation source, not the budget authority.

## Primary references

[Architecture](https://github.com/getagentseal/codeburn/blob/main/docs/architecture.md) · [Provider index](https://github.com/getagentseal/codeburn/blob/main/docs/providers/README.md) · [SQLite helper](https://github.com/getagentseal/codeburn/blob/main/src/sqlite.ts) · [Sync and privacy](https://github.com/getagentseal/codeburn/blob/main/docs/sync/README.md) · [README](https://github.com/getagentseal/codeburn/blob/main/README.md) · [Releases](https://github.com/getagentseal/codeburn/releases)
