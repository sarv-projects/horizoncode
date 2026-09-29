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

## 2026-09-29 quota-observation follow-up

The preceding note remains a focused review at `2a7d9588d88ac4fd938f4f13462de51735d59334`.
A separate targeted source-path audit used CodeBurn pin
[`b8a9f3cc5290adfd17add6c92444dc56f2aea3e9`](https://github.com/getagentseal/codeburn/tree/b8a9f3cc5290adfd17add6c92444dc56f2aea3e9)
and KiloCode pin
[`2dfe6fc876fd7c99132c0dc7565d4edd1ce2b8c0`](https://github.com/Kilo-Org/kilocode/tree/2dfe6fc876fd7c99132c0dc7565d4edd1ce2b8c0).
This is not an exhaustive source-tree read; neither upstream tests nor live quota APIs
were executed.

CodeBurn's quota reader has useful operational distinctions: connected, stale,
transient, access-denied, and rate-limited states; independent provider refreshes;
coalescing in-flight requests; per-provider opt-out; cancellation generations; a
minimum refresh floor; and persisted 429 backoff. One package also disables a live
quota query where fetching would require write access to another application's auth
file. These observations support read-only credential boundaries and retained stale
state, but do not establish a shared budget authority.

KiloCode's `command-budget.ts` is a timeout/quarantine policy for spawned Git/GitHub
polling commands, not model token or money budgeting. Its `MaxCostNudge` is a volatile
per-session soft notification with a user continuation prompt; usage aggregation can
include descendant agents. HorizonCode already has durable controller-owned warnings,
hard caps, per-agent/provider attribution, and explicit unknown usage. These are not
gaps to copy from KiloCode.

HorizonCode disposition is `DEC-071` / `REQ-PROV-014` / `AX-386`: add optional,
documented, read-only provider quota observation with opt-in polling, bounded refresh,
per-account coalescing, explicit window/unit/freshness and separate provider-owned
observations. The provider's observation can never release or enlarge HorizonCode's
atomic local reservation. Importing CodeBurn's arbitrary local transcript readers or
cross-app credential access is deferred because it introduces privacy/schema-drift
and credential-ownership contracts not required for in-product quota visibility.

Focused source references: CodeBurn `src/providers/types.ts:28-63,110-164`,
`app/electron/quota/types.ts:1-27`, `app/electron/quota/index.ts:38-197`; KiloCode
`packages/kilo-vscode/src/agent-manager/command-budget.ts:1-50`,
`packages/core/src/kilocode/cost/max-cost-nudge.ts:1-12,24-45,101-127`,
`packages/opencode/src/kilocode/session/model-usage.ts:10-42,66-200`, and
`packages/opencode/src/kilocode/session/cost-propagation.ts:7-65`.
