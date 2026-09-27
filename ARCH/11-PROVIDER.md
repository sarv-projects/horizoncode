# 11 — Provider

Module LLD for `CMP-provider`. One catalog, one route abstraction, one executor, one router. No vendor SDK is linked; provider and model metadata is consumed as data, never vendored.

## Purpose

Turn a vendor-neutral model request into provider traffic and back, and choose which route serves it. `CMP-provider` is the only layer that knows wire protocols, endpoints, auth schemes, and streaming framing; everything above it speaks one request type and one typed event stream. It owns model metadata, failure classification, retry, redaction, usage/cost accounting, and routing policy. It does not own the loop, context assembly, tools, credentials, or policy rules.

## Responsibilities

**Owned.**
- **Catalog service.** Fetch, cache, refresh, and snapshot provider/model metadata from an external source of truth; project it into resolvable records. The catalog *code* is external data, not a vendored registry (`REQ-PROV-002`).
- **Route abstraction.** The orthogonal tuple `Protocol × Endpoint × Auth × Framing` plus per-route defaults; vendor quirks live only in protocol adapters (`REQ-PROV-003`).
- **Wire protocol adapters.** A fixed, small adapter set plus one generic compatible adapter for arbitrary endpoints. Adding a provider is route data, not a new code path.
- **Executor.** Request send, bounded retries, watchdogs, `Retry-After` handling, full secret redaction, typed error classification.
- **Usage and cost accounting.** Observed vs estimated split; inclusive totals plus a non-overlapping breakdown.
- **Router.** Strategy-based selection, health/cooldown, typed fallback chains, optional eval gating, fail-closed budget gates, and an observable decision record.
- **Model projection.** Availability, defaults, small-utility-model selection, and per-model option/variant merge.

**Not owned.** Turn lifecycle and continuation (`CMP-runner`); context assembly, token budgets and compaction (`CMP-context`); tool schema semantics (`CMP-tools`); credential storage (`CMP-secrets`); allow/ask/deny rules and egress grants (`CMP-guard`); durable sessions (`CMP-session`); audit chain (`CMP-audit`).

## Interfaces

**Depends on.**
- `CMP-context` — resolved context window and reserve constants used by pre-turn feasibility; tokenizer ref for estimation.
- `CMP-secrets` — credential *references* only; the broker resolves and redacts, values never enter this module's logs.
- `CMP-guard` — egress authorization for every outbound request; a denial is a typed failure, never a silent fallback.
- `CMP-session` — the logical session id used for a stable per-conversation affinity header.
- `CMP-audit` — route decisions, usage/cost records, and redaction events append here.

**Exposes to.**
- `CMP-runner` — `stream(request) -> Stream<ModelEvent, ProviderError>` for the model step.
- `CMP-orch` — route resolution for child sessions and role-based model selection.
- `CMP-headless` / `CMP-tui` — catalog and routing views through the control interface; no surface calls a transport directly.
- `CMP-mcp` — nothing; MCP tool schemas are lowered into the common request shape by `CMP-tools`, not here.

**Public surface (language-neutral sketch).**

```
Catalog.models()            -> [ModelDescriptor]
Catalog.providers()         -> [ProviderRecord]
Catalog.default()           -> Option<ModelRef>
Catalog.small(provider)     -> Option<ModelRef>
Router.resolve(prefs, constraints) -> RoutingDecision
Executor.prepare(route, request)   -> Prepared
Executor.stream(prepared)          -> Stream<ModelEvent, ProviderError>
```

## Data / state model

**Route** — deployment facts separated from protocol semantics.

```
Route {
  id, protocol, endpoint{baseURL, path, query}, auth, framing, transport,
  defaults{headers, limits, generation, providerOptions, http}, body
}
```

**Wire protocol adapters** — named by framing grammar, never by vendor. Protocol owns request-body construction and the streaming state machine; it does not know URL, headers, or auth.

| Adapter | Wire shape (generic) |
|---|---|
| `chat` | Flat `messages[]`; SSE `data:` frames; sentinel-terminated |
| `responses` | Stateful typed input/output items; typed event stream |
| `messages` | Role/content-block arrays; named SSE event types |
| `generate` | `contents[]` + generation config; model id embedded in the URL |
| `converse` | Single `messages[]` with tool-use blocks; length-prefixed binary event stream |
| `compatible` | Generic chat-completions-compatible adapter for custom/local endpoints |

**ModelDescriptor** — declared capabilities only; the loop may not offer what the descriptor does not declare.

| Field | Meaning |
|---|---|
| `id`, `provider` | stable identity |
| `context_window`, `max_output` | limits feeding `CMP-context` arithmetic |
| `tool_calling` | `none · basic · parallel` |
| `reasoning_modes[]` | normalized effort levels the model supports |
| `vision`, `streaming`, `structured_output` | transport/normalization flags |
| `cost{in,out,cache_read,cache_write,tiers[],over_200k?,reported_actual?}` | cache-class-aware; estimates unless provider-reported |
| `latency_class`, `locality` | ranking inputs; `locality: local` means zero egress |
| `tokenizer` | tokenizer ref for budget estimation |
| `status`, `family`, `release_date` | lifecycle and visibility |
| `variants`, `options`, `headers`, `prompt_cache`, `privacy` | per-model overrides and disclosure |

**ProviderRecord** — id, base api, environment key names, auth-method enum (`api-key · oauth · well-known`), models map, and one or more `transport_ref`s for gateways that expose several wire protocols per model.

**Catalog cache** — a cache file with a short TTL, a cross-process lock, atomic `tmp`+rename writes, a small curated primary catalog with per-row provenance, and opt-in enrichment. No full upstream dataset is bundled by default (`DEC-021`). Refresh failures leave the validated primary available and show staleness.

**Usage record** — inclusive totals plus a non-overlapping breakdown (`non_cached_input · cache_read · cache_write · reasoning`), clamped, with unnormalized provider fields retained only for billing audit. Show billed amount, quota impact, estimate, and unknown fields separately; an included plan may bill zero while still consuming a finite quota.

**Router state** — per-deployment health, cooldown expiry, latency estimate, in-flight count, observed rate-limit hints, and (optional) published eval scores.

## Lifecycle & flows

1. **Catalog load.** On boot, load the curated primary and validated cache, then refresh enrichment only when opted in. Resolve records lazily. Projection merges provider and model fields (`provider.api` defaults overlaid by model overrides).
2. **Model step.** `Router.resolve` picks a route → `Executor.prepare` applies auth, lowers tool schemas, and builds the protocol body → transport sends → framing decodes bytes → protocol translates frames into the common typed stream (`step-start · text/reasoning/tool-input deltas · tool-call · tool-result · step-finish · finish · usage · provider-error`) → usage is recorded. Consumers never branch on provider id.
3. **Retry ownership (single-owner rule).** Transport retries only for request-start failures, bounded with exponential backoff + jitter, honoring `Retry-After` in seconds, milliseconds, or HTTP-date. Pre-content stream interruptions retry via buffer-until-proven, summing discarded-attempt usage. Post-content failures are handed to `CMP-runner`'s turn-level recovery. A user abort anywhere vetoes retry. Context overflow is **terminal** here: the adapter surfaces a typed overflow flag and does not re-request; `CMP-context` owns the single compact-and-retry.
4. **Routing.** Filter (policy-allowed, healthy, not cooling down, meets task requirements: context size, vision, tool-calling, reasoning) → rank by configured strategy → pick → declare a fallback chain → record an observable decision. On a typed retryable failure the chain advances; cooldown is applied to the failed deployment.
5. **Eval gating.** When enabled, selection is bounded by published per-model suite scores and a configured threshold; the gate is deterministic and the score set is versioned.
6. **Budget gates.** Token/cost ceilings are evaluated before sending; an exhausted budget fails closed with a typed reason and no silent downgrade.

**Routing strategies** (configurable, composable): weighted, lowest-latency, lowest-cost, least-busy, rate-limit-aware, and tag/class-based (task class → model class). Degrade rules are explicit: if a requirement cannot be met the result is guidance/requires-user-action, never a silent capability downgrade.

## Failure modes

| Failure | Behavior |
|---|---|
| Authentication (missing/invalid/expired/insufficient) | Typed `auth`; no silent failover; refresh once where supported, else re-auth guidance |
| Rate limit | Typed `rate-limit` with `retryAfterMs` and observed limit/remaining/reset; backoff + queue |
| Quota exhausted | Typed `quota`; not retryable; surface plan/limit guidance |
| Content policy | Typed `content-policy`; not retryable; no rephrase-and-retry loop |
| Invalid request | Typed `invalid-request`; carries a `context-overflow` flag when classified so; otherwise bounded request context |
| Provider internal / 5xx | Typed `provider-internal`; retryable within bounds |
| Transport / timeout / idle watchdog | Typed `transport`; explicit abort reason; step retried only per the single-owner rule |
| Unknown | Typed `unknown`; contains no secret and no raw body beyond the redacted, truncated cap |
| Route absent | Typed `no-route`; guidance, not a crash |
| Catalog fetch failure | Served from cache/snapshot; failure logged and swallowed; never blocks the loop |
| Malformed provider output | Adapter validates before anything is applied; typed failure, deployment marked degraded, nothing partial applied |
| Egress denial | Typed denial from `CMP-guard`; audited; never a silent fallback |
| Cost mismatch | Provider-reported actual overrides estimate; mismatch emitted as an audit event |

## Configuration

- `catalog.source`, `catalog.ttl`, `catalog.refresh_interval`, `catalog.offline_snapshot`.
- Provider entries: id, base endpoint, auth-method ref, env key names, per-model overrides, extra headers (values are secret refs).
- `routing.strategy`, `routing.weights`, `routing.fallbacks[]`, `routing.cooldown`, `routing.eval{gates,threshold,scores_ref}`.
- `retry.max`, `retry.base_delay_ms`, `retry.max_delay_ms`, `retry.respect_retry_after`.
- `budget.max_tokens`, `budget.max_spend` (per session/run; fail closed).
- `redaction.sensitive_names[]` (headers, query keys, body fields) — extend-only, never reduce the built-in set.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-PROV-001` | Hosted compatible endpoints, local runtimes, a broad catalog, and arbitrary custom endpoints via the generic adapter |
| `REQ-PROV-002` | Catalog is external data with cache/refresh/offline snapshot; its code is never vendored |
| `REQ-PROV-003` | Quirk handling (thinking passthrough, reasoning fields, streaming framing) isolated inside each protocol adapter |
| `REQ-PROV-004` | Credentials are refs; redaction covers headers, query, and echoed body values; nothing reaches logs/prompts/telemetry/audit |
| `REQ-PROV-005` | Policy-configurable, optionally eval-gated routing with an observable decision record |
| `REQ-HORIZON-003` | Token/cost ceilings evaluated pre-send and fail closed |
| `REQ-CTX-004` | Overflow surfaced as a terminal typed flag so the context engine performs exactly one compact-and-retry |
| `REQ-LOOP-005` | Cancellation promptly aborts in-flight streaming, leaving partial work inspectable |
| `REQ-AUDIT-003` | Redaction runs before any request/response detail can reach audit |
| `REQ-SEC-002` | Provider output is decoded as untrusted data and schema-validated before use |

## Open questions

1. **Wire-shape naming.** Adapters are named by framing grammar to preserve `DEC-011`; confirm this is acceptable in code identifiers versus assigning neutral protocol ids in the schema. The upstream identity mapping stays in `ARCH/05-SOURCE-LEDGER.md`.
2. **Catalog data license.** The exact external catalog source and its data license must be confirmed before any snapshot is committed (tracked in `TODO.md`).
3. **Cross-provider failover invalidation.** Semantics for failing over mid-stream with prompt-cache breakpoints, signed/opaque reasoning blocks, and in-flight tool-call ids are unresolved.
4. **Tokenizer strategy.** Per-provider exact tokenizers versus one conservative estimate shared with `CMP-context`.
5. **Reasoning partial support.** Whether a model that supports *some* normalized effort levels ignores, maps, or errors on the rest.
6. **Eval suite ownership.** Which suite, who publishes scores, and how the score artifact is signed/versioned is not yet fixed.
