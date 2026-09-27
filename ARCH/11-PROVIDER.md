# 11 — Provider

Module LLD for `CMP-provider`. One catalog, one route abstraction, one executor, one router. No vendor SDK is linked; provider and model metadata is consumed as data, never vendored.

## Purpose

Turn a vendor-neutral model request into provider traffic and back, and choose which route serves it. `CMP-provider` is the only layer that knows wire protocols, endpoints, auth schemes, and streaming framing; everything above it speaks one request type and one typed event stream. It owns model metadata, failure classification, retry, redaction, usage/cost accounting, and routing policy. It does not own the loop, context assembly, tools, credentials, or policy rules.

## Responsibilities

**Owned.**
- **Catalog service.** Load a small, curated, versioned primary catalog offline; optionally enrich it from an explicitly enabled source, validate and record provenance, and project records into resolvable descriptors. External metadata is advisory data, never an endpoint/auth/credential authority (`REQ-PROV-002`, `REQ-SEC-017`, `DEC-021`).
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
| `cost{in,out,cache_read,cache_write,tiers[],currency,basis,over_200k?,reported_actual?}` | source-currency-aware; each value has currency and `actual | estimated | included | unknown` basis; never combine unlike currencies (`REQ-ANALYTICS-007`) |
| `latency_class`, `locality` | ranking inputs; `local` describes configured endpoint placement only and does not prove zero egress, privacy, or offline behavior |
| `tokenizer` | tokenizer ref for budget estimation |
| `status`, `family`, `release_date` | lifecycle and visibility |
| `variants`, `options`, `headers`, `prompt_cache`, `privacy` | per-model overrides and disclosure |

**ProviderRecord** — id, base api, environment key names, auth-method enum (`api-key · oauth · well-known`), models map, and one or more `transport_ref`s for gateways that expose several wire protocols per model.

**Per-deployment termination profile** — not model-catalog metadata, because local
server behavior depends on server build, model, template, context configuration and
adapter. `RouteTerminationProfile = { profile_id, route_fingerprint,
output_cap_semantics: requested_cap | remaining_context_cap | unknown,
evidence_ref, adapter_version, validated_at }`. A profile that declares
`remaining_context_cap` is usable only when it is produced by a version-pinned
adapter contract or a passing route-conformance record; user-entered labels and model
catalog claims alone are not evidence. Any relevant fingerprint change invalidates
the profile. If the server version or effective context configuration cannot be
identified, semantics stay `unknown`.

**Normalized termination schema.** Every finished generation carries
`FinishRecord = { finish: completed | context_overflow | explicit_output_cap |
remaining_context_cap | unknown_truncation | provider_error,
raw_reason_code?, reason_source: protocol | validated_route_profile | unknown,
model_attempt_id, logical_step_id, route_fingerprint, usage_ref? }`. Raw finish codes are retained as
bounded, redacted metadata for diagnosis, not interpreted by UI or loop code. A
generic `length`/`max_tokens` response is `explicit_output_cap` only when the
request's configured output ceiling is the demonstrated limiting cap; it is
`remaining_context_cap` only under a matching validated profile and the route's
observed semantics; otherwise it is `unknown_truncation`. It is never promoted to
normal completion because content parses as plausible prose or JSON.

**Catalog data and cache** — the curated primary is bundled as HorizonCode-owned records with per-row source/retrieval/method/revision provenance and a content hash. Optional enrichment is opt-in and cached with a short TTL, cross-process lock, atomic temp+rename writes, validation, and a visible freshness state. Do not bundle a full upstream snapshot or third-party marks. Refresh failure retains the curated primary plus any still-valid cache, marks their source/freshness separately, and never blocks inference; missing enrichment must not be described as a cached full catalog (`DEC-021`).

**Usage record** — inclusive totals plus a non-overlapping breakdown (`non_cached_input · cache_read · cache_write · reasoning`), clamped, with unnormalized provider fields retained only for billing audit. Preserve source amount/currency and pricing version. Each `model_attempt_id`, including partial and recovered model generations, gets its own usage evidence; compaction calls and retry calls are separate debits. For media, retain only counts/encoded bytes and route-reported or clearly estimated token usage, never artifact bytes in analytics. Show billed amount, quota impact, estimate, and unknown fields separately; an included plan may bill zero while still consuming a finite quota. Any display conversion is separately labeled and cannot mutate the recorded amount.

**Router state** — per-deployment health, cooldown expiry, latency estimate, in-flight count, observed rate-limit hints, and (optional) published eval scores.

## Lifecycle & flows

1. **Catalog load.** On boot, load the curated primary and validated cache, then refresh enrichment only when opted in. Resolve records lazily. Projection merges provider and model fields (`provider.api` defaults overlaid by model overrides).
2. **Model step.** `Router.resolve` picks a route → `Executor.prepare` applies auth, lowers tool schemas, and builds the protocol body → transport sends → framing decodes bytes → protocol translates frames into the common typed stream (`step-start · text/reasoning/tool-input deltas · tool-call · tool-result · step-finish · FinishRecord · usage · provider-error`) → usage is recorded against immutable `model_attempt_id` and `logical_step_id`, including partial attempts. These IDs are distinct from orchestration's task-attempt ID. Consumers branch on normalized capability/evidence, never raw provider id/reason text.
3. **Retry ownership (single-owner rule).** Transport retries only for request-start failures, bounded with exponential backoff + jitter, honoring `Retry-After` in seconds, milliseconds, or HTTP-date. Pre-content stream interruptions retry via buffer-until-proven, summing discarded-attempt usage. Post-content transport failures are handed to `CMP-runner`'s turn-level recovery. A user abort anywhere vetoes retry. Context overflow is **terminal** here: the adapter surfaces typed `context_overflow` and does not re-request; `CMP-context` owns the existing single compact-and-retry. Output truncation is classified in the `FinishRecord`; only `CMP-runner`/the durable controller may request the separate bounded remaining-context recovery in `ARCH/08`/`DEC-054`.
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
| Catalog enrichment fetch failure | Keep the curated primary and any valid cached enrichment; expose stale/unavailable provenance and log a redacted diagnostic; never invent rows or block a request whose route is already configured |
| Malformed provider output | Adapter validates before anything is applied; typed failure, deployment marked degraded, nothing partial applied |
| Generation ends at output limit | Persist a typed `FinishRecord`, partial attempt and usage. Explicit output cap or unknown cause returns incomplete output; proven remaining-context cap is eligible only for the controller's once-only safe recovery. Never dispatch partial tool arguments or call this a completed answer. |
| Egress denial | Typed denial from `CMP-guard`; audited; never a silent fallback |
| Cost mismatch | Preserve provider-reported actual and prior estimate with provenance; do not overwrite history; mismatch emitted as an audit event |

## Configuration

- `catalog.primary_revision`, `catalog.enrichment.enabled` (false by default), `catalog.enrichment.source`, `catalog.enrichment.ttl`, `catalog.enrichment.refresh_interval`, `catalog.cache_path`; there is no bundled full-dataset `offline_snapshot` setting.
- Provider entries: id, base endpoint, auth-method ref, env key names, per-model overrides, extra headers (values are secret refs).
- `routing.strategy`, `routing.weights`, `routing.fallbacks[]`, `routing.cooldown`, `routing.eval{gates,threshold,scores_ref}`.
- `retry.max`, `retry.base_delay_ms`, `retry.max_delay_ms`, `retry.respect_retry_after`.
- `budget.max_tokens`, `budget.max_spend` (per session/run; fail closed).
- `redaction.sensitive_names[]` (headers, query keys, body fields) — extend-only, never reduce the built-in set.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-PROV-001` | Hosted compatible endpoints, local runtimes, a broad catalog, and arbitrary custom endpoints via the generic adapter |
| `REQ-PROV-002` | Curated primary data works offline; opt-in enrichment is validated, provenance-carrying advisory input and cannot silently replace pinned fixtures or route/auth policy |
| `REQ-PROV-003` | Quirk handling (thinking passthrough, reasoning fields, streaming framing) isolated inside each protocol adapter |
| `REQ-PROV-004` | Credentials are refs; redaction covers headers, query, and echoed body values; nothing reaches logs/prompts/telemetry/audit |
| `REQ-PROV-005` | Policy-configurable, optionally eval-gated routing with an observable decision record |
| `REQ-HORIZON-003` | Token/cost ceilings evaluated pre-send and fail closed |
| `REQ-ANALYTICS-007` | Preserve source currency and amount basis; mixed-currency totals are bucketed or explicitly converted with provenance |
| `REQ-CTX-004` | Overflow surfaced as a terminal typed flag so the context engine performs exactly one compact-and-retry |
| `REQ-CTX-011` | Preserve provider finish evidence and partial usage; expose version-bound termination semantics to the loop, without retrying in the adapter |
| `REQ-LOOP-005` | Cancellation promptly aborts in-flight streaming, leaving partial work inspectable |
| `REQ-AUDIT-003` | Redaction runs before any request/response detail can reach audit |
| `REQ-SEC-002` | Provider output is decoded as untrusted data and schema-validated before use |

## Open questions

1. **Wire-shape naming.** Adapters are named by framing grammar to preserve `DEC-011`; confirm this is acceptable in code identifiers versus assigning neutral protocol ids in the schema. The upstream identity mapping stays in `ARCH/05-SOURCE-LEDGER.md`.
2. **Enrichment source operations.** `DEC-021` resolves the catalog source/license posture. Still specify refresh concurrency, cache expiry under wall-clock rollback, primary-catalog release cadence, and degraded UI wording; these details must not weaken the offline curated primary.
3. **Cross-provider failover invalidation.** Semantics for failing over mid-stream with prompt-cache breakpoints, signed/opaque reasoning blocks, and in-flight tool-call ids are unresolved.
4. **Tokenizer strategy.** Per-provider exact tokenizers versus one conservative estimate shared with `CMP-context`.
5. **Reasoning partial support.** Whether a model that supports *some* normalized effort levels ignores, maps, or errors on the rest.
6. **Eval suite ownership.** Which suite, who publishes scores, and how the score artifact is signed/versioned is not yet fixed.
