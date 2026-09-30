# 11 — Provider

Module LLD for `CMP-provider`. One catalog service, one route abstraction, one executor, one router. HorizonCode owns Rust transport/auth adapters; provider and model metadata is consumed as validated data. No upstream TypeScript runtime is embedded.

## Purpose

Turn a vendor-neutral model request into provider traffic and back, and choose which route serves it. `CMP-provider` is the only layer that knows wire protocols, endpoints, auth schemes, and streaming framing; everything above it speaks one request type and one typed event stream. It owns model metadata, failure classification, retry, redaction, usage/cost accounting, and routing policy. It does not own the loop, context assembly, tools, credentials, or policy rules.

## Responsibilities

**Owned.**
- **Catalog service.** Load a versioned primary catalog offline; refresh approved OpenCode/Models.dev provider/model metadata in the background by default, and allow generic enrichment only when enabled. Validate and record provenance and project records into descriptors. External metadata is advisory data, never code, credential, auth-method, or arbitrary-host authority (`REQ-PROV-002`, `REQ-SEC-017`, `DEC-007`, `DEC-021`, `DEC-060`).
- **Route abstraction.** The orthogonal tuple `Protocol × Endpoint × Auth × Framing` plus per-route defaults; vendor quirks live only in protocol adapters (`REQ-PROV-003`).
- **Wire protocol adapters.** Versioned, HorizonCode-owned adapters cover provider integrations in the monitored OpenCode and Cline source matrices, plus a generic compatible adapter for user-configured compatible endpoints. Adding a provider uses an existing route family where conformance permits; provider-specific auth, framing, request shaping, or lifecycle behavior may require a dedicated local adapter. Catalog records alone never make a route usable.
- **Executor.** Request send, bounded retries, watchdogs, `Retry-After` handling, typed error classification, and the bounded credential-redaction guarantees in `REQ-PROV-004` / `ARCH/14`; do not claim perfect scanning of arbitrary payload text.
- **Usage and cost accounting.** Observed vs estimated split; inclusive totals plus a non-overlapping breakdown.
- **Quota observation.** Optional read-only adapters for documented provider account/quota endpoints. `CMP-provider` owns capability checks, user opt-in/manual refresh, normalization, bounded coalescing/backoff, freshness, and a protected bounded observation cache. It does not own HorizonCode budget reservations or infer limits from response headers unless a provider contract explicitly defines them.
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
| `tool_calling` | `supported: none · basic · parallel`, or `unknown`; missing metadata never defaults to enabled |
| `reasoning_modes[]` | normalized effort levels the model supports |
| `vision`, `streaming`, `structured_output` | tri-state `supported | unsupported | unknown`; unknown does not satisfy a route requirement |
| `in_history_system_prompt_update` | `supported | unsupported | unknown`; `supported` means the route treats a later system message as the complete effective prompt. Unknown/unsupported uses full prompt replacement. This is not a prompt-cache capability. |
| `cost{in,out,cache_read,cache_write,tiers[],currency,basis,over_200k?,reported_actual?}` | source-currency-aware; each value has currency and `actual | estimated | included | unknown` basis; never combine unlike currencies (`REQ-ANALYTICS-007`) |
| `latency_class`, `locality` | ranking inputs; `local` describes configured endpoint placement only and does not prove zero egress, privacy, or offline behavior |
| `tokenizer` | tokenizer ref for budget estimation |
| `status`, `family`, `release_date` | lifecycle and visibility |
| `variants`, `options`, `headers`, `prompt_cache`, `privacy` | per-model overrides and disclosure |

**Provider catalog and integration records are separate.** A model-directory record
describes what a source advertises. A locally shipped `ProviderIntegrationRecord`
describes what this HorizonCode build knows how to call and authorize. The picker may
display every discovered provider, but it must label a provider unavailable until a
local protocol adapter, user credential route, service prerequisites, terms/client
registration state, and required conformance evidence all agree. No fetched record
may add an authentication flow or implementation.

```text
AuthMethodRecord {
  id, provider_id, method_kind,
  documentation_ref, source_revision, reviewed_at,
  credential_ref_kind, scopes[], client_registration_state,
  terms_state, implementation_state, availability_reason
}

ProviderIntegrationRecord {
  id, display_name, catalog_presence, auth_methods[],
  protocol_adapter_ids[], capability_evidence_refs[],
  service_prerequisites[], availability, reviewed_source_revision
}
```

## Upstream provider maintenance

`DEC-076` changes provider breadth from “catalog visibility” to a maintained
integration target. `research docs/opencode-provider-inventory.md` and the Cline
provider inventory enumerate the exact upstream snapshot, documented connector/auth
paths, HorizonCode adapter family, per-file source/license provenance, route
conformance, and availability reason. Every monitored connector is either locally
usable with evidence or visibly blocked; unknown/ineligible auth must not disappear
behind a catalog entry.

A scheduled source monitor compares pinned OpenCode and Cline revisions and reports
provider/auth/protocol changes. It prepares a reviewable HorizonCode-native update
candidate and refreshed conformance fixtures. Candidate implementation may selectively
adapt source only after the exact file and applicable license/notice are reviewed under
`ARCH/05`; otherwise implement behavior from public protocol documentation. It may
not copy OAuth/client identity, tokens, cookies, auth stores, or remote code. Merge and
distribution use the ordinary reviewed source tree and signed release/update process.
No provider code is downloaded, compiled, or executed by the installed application,
and a source update cannot modify an active route snapshot. `DEC-060`'s inert metadata
and fixed endpoint rules remain in force.

“Support all OpenCode/Cline providers” is the product target: every connector in the
pinned monitored inventories must reach `usable` with a HorizonCode-owned adapter, an
authorized credential flow, fixed reviewed origin/protocol, terms/client-registration
clearance, and route-specific conformance. An unavailable entry states its exact blocker
and means full parity is incomplete; it is not counted as supported. The maintenance
process revisits blockers as sources or authorized integration options change. HorizonCode
does not impersonate the upstream client or claim that its own conformance means
upstream endorsement.

## Route-specific prompt-cache behavior

Stable prompt prefixes, tool ordering, cache writes/reads, affinity, and in-history
prompt updates remain route capabilities. No V1 requirement promises cache-neutral
mode changes or identical tool schemas across modes; `REQ-TOOL-003` continues to omit
tools denied by hard/user policy. The provider must preserve raw usage fields and
separately normalize cache-read and cache-write/creation values only where the route
documents their meaning. Absence remains unknown. This is accounting evidence, not a
promise of a cache hit or cost reduction (`DEC-075`, `AX-384`).

`method_kind` is typed, not free-form (`api_key`, `bearer_token`,
`oauth_authorization_code`, `oauth_pkce`, `oauth_device_code`,
`provider_customer_registered_oauth`, `cloud_cli_identity`, `cloud_identity_chain`,
`service_account`, `local_no_auth_documented`, `custom_endpoint`, `unknown`).
`client_registration_state` is `not_required | HorizonCode_owned_registered |
customer_owned_registered | unavailable | unknown`; `terms_state` is
`documented_for_independent_client | restriction_found | sources_conflict |
not_reviewed`; and `implementation_state` is `not_implemented | implemented |
conformance_tested | blocked`. A documentation claim is not legal approval, a
customer credential is not HorizonCode's client registration, and presence in an
upstream connector is not evidence that our adapter works. Unknown/conflicting values
fail closed for use and stay inspectable in `/providers`.

The `ProviderModelCatalogRecord` is an inert projection of allowlisted fields:
provider/model ID, display name, limits, modalities, reasoning/tool flags, costs,
release/status labels, and the upstream protocol-family identifier if it maps to a
locally registered adapter. The current OpenCode `models-dev.ts` schema also has
`npm`, `env`, and provider-defined body/header fields. HorizonCode MUST NOT evaluate,
download, execute, or trust those as adapter packages, secret discovery instructions,
arbitrary headers, endpoints, or authentication authority. Preserve unknown fields
only as bounded inert diagnostics and record the source digest (`REQ-PROV-002`,
`REQ-PROV-011`).

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
model_attempt_id, logical_step_id, route_fingerprint, usage_ref?, partial_usage_ref?,
usage_status: COMPLETE | PARTIAL_REPORTED | ESTIMATED | UNKNOWN }`. Raw finish codes are retained as
bounded, redacted metadata for diagnosis, not interpreted by UI or loop code. A
generic `length`/`max_tokens` response is `explicit_output_cap` only when the
request's configured output ceiling is the demonstrated limiting cap; it is
`remaining_context_cap` only under a matching validated profile and the route's
observed semantics; otherwise it is `unknown_truncation`. It is never promoted to
normal completion because content parses as plausible prose or JSON. Usage reported
on a terminal completion or partial/interrupted stream is retained and reconciled
exactly once even when the attempt fails. If the provider does not report usage after
failure, HorizonCode records `UNKNOWN` or a clearly labeled estimate; it never
silently charges zero or fabricates exact tokens. The pinned Codex sampling error
path passes emitted items to `record_failed` but does not pass `token_usage`, which is
handled on `ResponseEvent::Completed`; this is a risk signal in that path, not proof
of final provider billing or every Codex accounting surface (`research docs/codex.md`).

`context_overflow` has a narrower meaning than a generic provider error: the adapter
has evidence that the request was rejected for context-window size before any
response content/tool proposal was exposed. Only that typed cause may enter the
pre-content recovery path in `CMP-context` (`REQ-CTX-004`). HTTP 413, a generic
`invalid_request`, local payload-size failure, or a provider error is not sufficient
by itself; absent route/protocol evidence it remains `provider_error` (or another
typed non-recoverable error). It must not be conflated with
`remaining_context_cap`, which describes a response truncated after generation began.

**Catalog data and cache** — the curated primary is bundled as HorizonCode-owned records with per-row source/retrieval/method/revision provenance and a content hash. Optional enrichment is opt-in and cached with a short TTL, cross-process lock, atomic temp+rename writes, validation, and a visible freshness state. Do not bundle a full upstream snapshot or third-party marks. Refresh failure retains the curated primary plus any still-valid cache, marks their source/freshness separately, and never blocks inference; missing enrichment must not be described as a cached full catalog (`DEC-021`).

**OpenCode data refresh** — these source sets have separate identities and authority.
At the pinned OpenCode revision, `packages/core/src/models-dev.ts` fetches
`https://models.opencode.ai/api.json` by default (five-minute freshness check and a
sixty-minute background refresh in that client); the live OpenCode provider page
describes a 75+ provider ecosystem. A credential-free retrieval on 2026-09-28
returned 225 feed provider IDs and 8,253 models. This dated count is inventory
evidence, not a route-support count. OpenCode Go is separate: its current documented
model-list endpoint is `https://opencode.ai/zen/go/v1/models`, and its Go inference
service is rooted at `https://opencode.ai/zen/go/v1`. In the same-day snapshot, the Go
directory returned 43 model IDs, the global feed's `opencode-go` record contained 33,
and the documentation mapped 30 IDs to endpoints. The mismatches are deliberate
drift signals: ID presence alone never supplies a protocol, route, price, capability,
auth method, or executable adapter. OpenCode source permits its own feed overrides,
but HorizonCode does not expose a feed-origin override. The fixed origins, digests,
counts, and source paths are recorded in `research docs/opencode-provider-inventory.md`
and `ARCH/29`.

Refresh both explicit feeds in the background on a bounded one-hour HorizonCode
default interval; `/settings providers` can disable the refresh. Each source has its
own fixed trusted origin, parser/schema version, maximum response size, cache TTL,
digest, retrieval time, and freshness state. A shared single-flight key and OS-backed
cache lock prevent duplicate/corrupt writers; a fully validated snapshot is atomically
replaced. Generic enrichment remains opt-in. Do not bundle a full upstream snapshot
or third-party marks. A refresh failure retains the curated primary and last valid
source cache and marks stale/unavailable status; it does not block a route already
explicitly configured.

**Provider route snapshot** — before an attempt starts, persist `ProviderRouteSnapshot = {provider_id, model_id, endpoint_origin, endpoint_path, protocol_id, adapter_version, auth_method_id, capability_digest, system_prompt_update_mode, limits_digest, price_digest, metadata_source, metadata_retrieved_at, catalog_digest, model_record_digest, credential_ref_id}`. `system_prompt_update_mode` is `REPLACE` by default or `APPEND_EFFECTIVE` only for a conformance-proven route; it is never `UNKNOWN` at dispatch because unknown resolves to `REPLACE`. It contains no credential value or refresh token. Endpoint, auth ref, and protocol must come from local configuration or the fixed OpenCode connector, never from arbitrary catalog metadata. The snapshot is immutable for that route attempt and is referenced by its context epoch, model attempt, usage, verification, and recovery records. A managed attempt also pins the selected route and permitted ordered fallback chain (`DEC-070`); each route actually dispatched has its own snapshot. Refresh may alter later picker results, not an active attempt. A deliberate route change creates a new attempt/context epoch and reruns capability, policy, and budget checks (`REQ-PROV-008`, `REQ-PROV-012`).

**Prompt caching is a negotiated route capability, not a universal provider feature.** A provider adapter may advertise explicit cache-write/cache-read semantics only where the concrete provider/model API documents them and a conformance test verifies request encoding and usage reporting. The context renderer may preserve stable-prefix ordering for any route, but it MUST NOT claim remote cache hits, inject provider-specific cache markers, or calculate savings without that route capability. Local compatible endpoints report cache usage as `unknown` unless the concrete server/model probe establishes it. Cache accounting is a separate usage class and never reduces the recorded input-token total. Provider-specific cache keys, retention, privacy, and invalidation rules stay within that adapter and its pinned capability snapshot.

System-prompt update semantics are independently route-scoped. Full effective-prompt replacement is the fallback. In-history updates are enabled only if the exact model/endpoint documents that the latest system message replaces the effective prompt and adapter fixtures verify request reconstruction across source addition, update, removal, compaction, resume, and tool-schema change. Cache support does not imply in-history update support; unknown behavior forces replacement.

## OpenCode registry and native Go adapter

The upstream does not have one provider inventory. HorizonCode tracks (1) the dynamic
global model feed, (2) named provider setup documentation, (3) first-party provider and
auth integrations/protocols, and (4) OpenCode Go's separate model-list and inference
service. At the recorded retrieval, the global feed had 225 provider IDs and the
documentation had 51 named sections plus Custom; the pinned core provider directory
had 32 modules plus supplemental plugins elsewhere. Go's current `/models` endpoint
returned 43 IDs but the Go endpoint table mapped 30 of them to documented wire paths.
These counts describe different snapshots and surfaces. Keep the dated full provider
ID and Go model inventories, all documented provider auth methods, source filenames,
and drift limits in `research docs/opencode-provider-inventory.md`. A newly discovered
provider or model remains visible as `unknown`/unavailable until its auth, endpoint,
protocol, and terms state are locally reviewed. Each HorizonCode row has distinct
fields:

```text
catalog_status: listed | absent | retired | unknown
auth_status: api_key | bearer_token | oauth_pkce | oauth_device_code |
             customer_owned_oauth | cloud_cli_identity | cloud_identity_chain |
             service_account | local_no_auth_documented | custom_endpoint |
             unknown | policy_unavailable
protocol_status: supported(protocol_id) | adapter_required | unsupported | unknown
capability_status: declared | conformance_tested | failed | not_tested | stale
availability: usable | needs_configuration | needs_registration | unavailable |
              temporarily_unavailable
```

These are distinct facts. A provider is `usable` only after its credential route,
wire adapter, required capability evidence, and service prerequisites pass. OAuth
requires a HorizonCode client registration and a provider-documented flow. Never
reuse another product's client ID, auth file, token, cookie, or undocumented endpoint.
If an independent client is not authorized or a required registration is unavailable,
keep the provider/auth row visible as unavailable; do not impersonate an existing
client or bypass access terms. This preserves complete discovery without falsely
claiming universal support (`REQ-PROV-010`, `REQ-SEC-027`). A provider whose
documentation is internally conflicting must remain `sources_conflict` until checked
against the provider's primary terms and a valid independent-client path.

The native Rust OpenCode Go connector follows this request contract. The OpenCode-wide
feed, Go model directory, and Go inference endpoint are never interchangeable:

1. Fetch the general OpenCode model feed only from the fixed reviewed origin
   `https://models.opencode.ai/api.json`. For OpenCode Go, query the separately
   documented `https://opencode.ai/zen/go/v1/models` endpoint. The latter returned
   HTTP 200 without credentials in the 2026-09-28 snapshot; this is a dated observation,
   not a promise that authentication will never be required. Do not send a Go key to
   the general model feed. Validate source-specific response bounds and schemas;
   redirects must remain within each source's exact approved origin. Never let remote
   metadata select an origin, arbitrary path, auth scheme, provider implementation,
   or executable.
2. The Go model directory's observed schema exposed model IDs but no per-model
   protocol, cost, capability, or auth details. Build routes from a local, versioned
   map checked against the published Go endpoint table: `/responses` uses the local
   OpenAI Responses adapter, `/chat/completions` the local OpenAI-compatible adapter,
   and `/messages` the local Anthropic Messages adapter. All paths are fixed allowlist
   entries under `https://opencode.ai/zen/go/v1`. A new model ID without a reviewed
   model-to-path mapping is shown but unavailable; never guess from its name or a feed
   `npm`/`api` field. The 2026-09-28 docs mapped 30 of the 43 returned IDs, so tests
   must cover this drift explicitly.
3. Resolve a user-authorized Go API key through `CMP-secrets` for inference; never
   inspect OpenCode's auth store or copy its access token. Go currently requires a
   subscription/API key according to its docs, although limited-time zero-listed-price
   models exist. Use HorizonCode's own User-Agent and the stable opaque HorizonCode
   conversation ID in `x-opencode-session`. Do not send repository name, user
   identity, or workspace path in that affinity header (`REQ-PROV-009`).
4. Render the locally mapped route through the native Rust protocol adapter. Normalize
   stream events, tool-call ID uniqueness, finish reasons, cancellation, usage,
   `Retry-After`, and failures via `CMP-provider`. An advertised protocol/capability is
   not usable until its exact request, stream, and error behavior has a passing
   route-conformance record.
5. On refresh, use a new catalog digest only for future route choices. A model removal
   or changed endpoint/protocol marks future resolution stale/unavailable; it does not
   mutate active attempts that hold the previous pinned snapshot. Starting a new task
   after incompatible metadata requires explicit reselection/replanning.
6. Show `free`, included, limited-time, price, and quota labels only with source and
   freshness. “Free” means the current record reports no price; it does not mean the Go
   subscription is free, unlimited quota, stable availability, or guaranteed
   tool/coding capability. On 2026-09-28 the official Go page described two
   limited-time free models; availability must be re-read from current official sources
   at test time.

The live official provider page describes a 75+ provider ecosystem and a partial set
of named provider sections; the 225 feed IDs are a dated model-feed snapshot. Neither
count guarantees a working HorizonCode route. OpenCode Go documents a client-owned
User-Agent, stable session ID, and finite/variable plan usage; it says compatibility
for validated clients is not guaranteed indefinitely. Exact inventory, prices, auth
methods, terms, and model availability are volatile.
`research docs/opencode-provider-inventory.md`, `research docs/opencode.md`, and
`ARCH/29` pin the reviewed source paths and retrieval date; implementation must
compare a newly pinned snapshot rather than assume this design-time directory is
current.

**Usage record** — inclusive totals plus a non-overlapping breakdown (`non_cached_input · cache_read · cache_write · reasoning`), clamped, with unnormalized provider fields retained only for billing audit. Preserve source amount/currency and pricing version. Each `model_attempt_id`, including partial and recovered model generations, gets its own usage evidence; compaction calls and retry calls are separate debits. For media, retain only counts/encoded bytes and route-reported or clearly estimated token usage, never artifact bytes in analytics. Show billed amount, quota impact, estimate, and unknown fields separately; an included plan may bill zero while still consuming a finite quota. Any display conversion is separately labeled and cannot mutate the recorded amount.

**Router state** — per-deployment health, cooldown expiry, latency estimate, in-flight count, observed rate-limit hints, and (optional) published eval scores.

**Provider quota observation contract.** A provider integration may advertise `quota_observation: supported | unsupported | unknown` independently of inference/auth support (`DEC-071`). Only documented endpoints and the exact authorized account credential may be used; no hidden endpoint probing, another CLI's credential cache, or refresh outside `CMP-secrets`. Background polling is user opt-in per provider and disabled by default; project settings/instructions cannot enable network refresh. Explicit `/providers quota refresh <provider>` is available where documented. Refresh uses one in-flight request per provider/account, bounded timeout/body/window count, cancellation generations, provider-specific minimum intervals, and persisted 429/backoff state. Timeout, 401/403, 429, provider error, parse error, and missing capability produce distinct states and do not erase last-good data. Authentication and quota denial are not retried as transient failures. The user can clear the local observation cache without changing the provider account or credential.

```text
QuotaObservation {
  observation_id, provider_id, account_ref, source_endpoint_id,
  retrieved_at, observed_state,
  windows: [{window_id, kind, unit, used?, remaining?, limit?,
             starts_at?, resets_at?, reported_at?, basis}],
  response_digest, schema_version
}
```

`account_ref` is a stable locally keyed pseudonym derived from the local auth-reference identity; do not persist email, raw account ID, credential, or response body. `observed_state` is `connected | stale | transient_error | rate_limited | access_denied | unsupported | unknown`; each window's `basis` is `provider_reported | locally_configured | unknown`. Missing fields stay absent/unknown, not zero. Validate window count, unique window IDs, unit/value consistency, nonnegative values where defined, timestamp ordering, and schema bounds before append. `CMP-provider` owns immutable-while-retained quota-observation records and a rebuildable latest-by-account projection in its protected provider-state store; commit an observation before publishing it to analytics/UI, and never rewrite a retained observation during projection rebuild. The append path is locked across processes, validates schema version and digest, and fails visibly rather than silently resetting on corrupt state. Bound record bytes, entry count, retention age, and per-account windows; pruning retains the latest valid snapshot. Explicit clear/retention deletion removes whole expired records and their derived analytics rows rather than editing an observation in place. `CMP-analytics` references these source facts and is not the owner. Quota observations may produce a clearly labeled UI warning only; they do not influence routing or dispatch. Opaque external agents keep quota `unknown` unless the adapter reports a provenance-backed value.

## Lifecycle & flows

1. **Catalog load.** On boot, load the curated primary and validated caches, then schedule due OpenCode metadata refresh in the background; generic enrichment refresh runs only when opted in. Resolve records lazily. Projection merges provider and model fields (`provider.api` defaults overlaid by model overrides). Each view shows source, retrieval time, expiry, and stale/error state.
2. **Model step.** `Router.resolve` picks a route → `Executor.prepare` applies auth, lowers tool schemas, and builds the protocol body → transport sends → framing decodes bytes → protocol translates frames into the common typed stream (`step-start · text/reasoning/tool-input deltas · tool-call · tool-result · step-finish · FinishRecord · usage · provider-error`) → usage is recorded against immutable `model_attempt_id` and `logical_step_id`, including partial attempts. These IDs are distinct from orchestration's task-attempt ID. Consumers branch on normalized capability/evidence, never raw provider id/reason text.
3. **Retry ownership (single-owner rule).** Transport retries only for request-start failures and other explicitly classified safe cases, bounded by controller-owned attempt count, total elapsed deadline, maximum backoff multiplier, and maximum absolute delay, with bounded jitter. Parse `Retry-After` in seconds, milliseconds, or HTTP-date, sample wall time before converting to a monotonic deadline, and clamp it to the remaining controller ceiling; peer values cannot extend that ceiling. A request body that may be replayed or incur provider-side work/billing is retryable only when acceptance is known not to have occurred or a provider-documented idempotency mechanism is used with the same stable request/effect key. No key and uncertain acceptance means no replay. On exhaustion, retain the actual terminal typed error, request ID, and attempt identity; do not replace it with a synthetic status. Pre-content stream interruptions retry via buffer-until-proven and reconcile usage across discarded attempts. Post-content transport failures are handed to `CMP-runner`'s turn-level recovery. A user abort anywhere vetoes retry. Context overflow is **terminal** here: the adapter surfaces typed `context_overflow` and does not re-request; `CMP-context` owns the existing single compact-and-retry. Output truncation is classified in the `FinishRecord`; only `CMP-runner`/the durable controller may request the separate bounded remaining-context recovery in `ARCH/08`/`DEC-054`.
4. **Routing.** Filter (policy-allowed, healthy, not cooling down, meets task requirements: context size, vision, tool-calling, reasoning) → rank by configured strategy → pick → persist the selected route and ordered permitted fallback chain at managed-attempt admission → record an observable decision. A catalog refresh cannot change an admitted chain. Cross-provider fallback follows `DEC-070`/`REQ-PROV-012`: it is allowed only for a typed transient failure before any provider content or tool-call delta is exposed, and only to a pre-pinned compatible, authorized route with a successful budget reservation. Auth, authorization, quota, policy/egress, protocol/schema, capability, cancellation, and post-exposure failures never silently switch providers. Each actual dispatch has its own immutable route snapshot and usage record; cooldown is applied to the failed deployment.
5. **Eval gating.** When enabled, selection is bounded by published per-model suite scores and a configured threshold; the gate is deterministic and the score set is versioned.
6. **Budget gates.** Token/cost ceilings are evaluated before sending; an exhausted budget fails closed with a typed reason and no silent downgrade.
7. **Quota refresh.** When enabled, resolve the documented provider quota capability and account reference → coalesce a refresh → call through the owning Guard/secret broker → validate and normalize bounded windows → append a provider-owned observation and atomically advance its latest projection → publish a redacted freshness event. On failure, retain last-good data and publish the stale/error state. No observed value changes a local reservation.

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
| Catalog refresh failure | Keep the curated primary and any valid cached source snapshot; expose stale/unavailable provenance and a redacted diagnostic; never invent rows or block an explicitly configured route |
| Quota refresh unavailable, denied, rate-limited, or malformed | Preserve last-good snapshot; expose distinct state and age; never coerce missing values to zero, erase state, or change local reservations |
| Multiple quota consumers refresh simultaneously | Coalesce by provider/account; cancellation of one waiter must not cancel other waiters; forced refresh obeys provider minimum interval and backoff |
| Provider exposes only some quota windows or units | Store each reported window independently; mark omitted windows unknown and do not combine unlike units or reset periods |
| Metadata changes during a run | Keep the attempt's pinned route/adapter/context snapshot; apply changes only to future route choices and require explicit replanning if the route is no longer available |
| Go record contains an unknown origin, host, auth type, protocol, or path | Refuse that model route with a typed reason; do not follow the host, guess an adapter, or attempt credentials |
| Provider has an unregistered or unauthorized sign-in flow | Keep the provider/auth row in the complete inventory as `needs_registration` or `policy_unavailable`; do not imitate another client or read its credential cache |
| Malformed provider output | Adapter validates before anything is applied; typed failure, deployment marked degraded, nothing partial applied |
| Generation ends at output limit | Persist a typed `FinishRecord`, partial attempt and usage. Explicit output cap or unknown cause returns incomplete output; proven remaining-context cap is eligible only for the controller's once-only safe recovery. Never dispatch partial tool arguments or call this a completed answer. |
| Egress denial | Typed denial from `CMP-guard`; audited; never a silent fallback |
| Cost mismatch | Preserve provider-reported actual and prior estimate with provenance; do not overwrite history; mismatch emitted as an audit event |

## Configuration

- `catalog.primary_revision`, `catalog.enrichment.enabled` (false by default), `catalog.enrichment.source`, `catalog.enrichment.ttl`, `catalog.enrichment.refresh_interval`, `catalog.cache_path`; `providers.opencode.metadata_refresh.enabled` (true by default), `providers.opencode.metadata_refresh.interval` (one hour by default), and a connector-owned fixed origin; there is no bundled full-dataset `offline_snapshot` setting.
- User-scope `providers.<id>.quota_observation.enabled` (false by default), `.refresh_interval` (provider minimum and managed maximum enforced), `.cache_max_age`, `.cache_max_entries`, `.cache_max_bytes`; project scope cannot enable polling. Explicit refresh remains available when automatic observation is disabled. These settings control observation/warnings only and do not alter routing or budget ceilings.
- Provider entries: id, base endpoint, auth-method ref, env key names, per-model overrides, extra headers (values are secret refs).
- `routing.strategy`, `routing.weights`, `routing.fallbacks[]`, `routing.cooldown`, `routing.eval{gates,threshold,scores_ref}`.
- `retry.max`, `retry.base_delay_ms`, `retry.max_delay_ms`, `retry.respect_retry_after`.
- `budget.max_tokens`, `budget.max_spend` (per direct Thread or managed Run; nested
  Attempt/worker reservations are atomic within the owning ceiling and fail closed).
- `redaction.sensitive_names[]` (headers, query keys, body fields) — extend-only, never reduce the built-in set.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-PROV-001` | Hosted compatible endpoints, local runtimes, a broad catalog, and arbitrary custom endpoints via the generic adapter |
| `REQ-PROV-002` | Curated primary data works offline; OpenCode metadata refresh is enabled by default but disableable, source-pinned, validated, provenance-carrying advisory input and cannot replace active route snapshots or grant auth/host authority |
| `REQ-PROV-003` | Quirk handling (thinking passthrough, reasoning fields, streaming framing) isolated inside each protocol adapter |
| `REQ-PROV-004` | Credentials are references; broker-resolved values are never intentionally supplied to prompts or persisted. Typed provider diagnostics and receipts exclude secret fields and apply known-value plus bounded pattern redaction before persistence; arbitrary echoed text retains the explicit residual in `ARCH/14` and `ARCH/22`. |
| `REQ-PROV-005` | Policy-configurable, optionally eval-gated routing with an observable decision record |
| `REQ-PROV-008..012` | Immutable route and fallback snapshots, native Go request identity, complete provider/auth coverage states, bounded refresh, and capability-gated provider cache semantics |
| `REQ-PROV-014` | Documented, opt-in read-only quota observation with bounded refresh, retained freshness, and no authority over local reservations |
| `REQ-HORIZON-003` | Token/cost ceilings evaluated pre-send and fail closed |
| `REQ-ANALYTICS-007` | Preserve source currency and amount basis; mixed-currency totals are bucketed or explicitly converted with provenance |
| `REQ-CTX-004` | Overflow surfaced as a terminal typed flag so the context engine performs exactly one compact-and-retry |
| `REQ-CTX-011` | Preserve provider finish evidence and partial usage; expose version-bound termination semantics to the loop, without retrying in the adapter |
| `REQ-LOOP-005` | Cancellation promptly aborts in-flight streaming, leaving partial work inspectable |
| `REQ-AUDIT-003` | Redaction runs before any request/response detail can reach audit |
| `REQ-SEC-002` | Provider output is decoded as untrusted data and schema-validated before use |

## Open questions

1. **Wire-shape naming.** Adapters are named by framing grammar to preserve `DEC-011`; confirm this is acceptable in code identifiers versus assigning neutral protocol ids in the schema. The upstream identity mapping stays in `ARCH/05-SOURCE-LEDGER.md`.
2. **OAuth registrations.** Each sign-in provider needs its own current documentation, terms, client registration, scope review, and callback/device-flow evidence. Providers needing another application's client identity remain unavailable until a lawful HorizonCode client integration is approved.
3. **Cross-provider failover invalidation.** Semantics for failing over mid-stream with prompt-cache breakpoints, signed/opaque reasoning blocks, and in-flight tool-call ids are unresolved.
4. **Tokenizer strategy.** Per-provider exact tokenizers versus one conservative estimate shared with `CMP-context`.
5. **Reasoning partial support.** Whether a model that supports *some* normalized effort levels ignores, maps, or errors on the rest.
6. **Eval suite ownership.** Which suite, who publishes scores, and how the score artifact is signed/versioned is not yet fixed.
