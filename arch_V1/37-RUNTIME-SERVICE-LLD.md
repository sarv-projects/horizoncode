# 37. Runtime service LLD

Status: normative service interfaces. A service marked proposed is not implemented until source and tests prove it. Under A-V2-31, V1 runtime exposure is Linux/WSL CLI/TUI; browser and desktop services below are post-V1 and unavailable. Built-in web search is V1 per the 2026-10-18 promotion (`DEC-V1-26`). LSP/DAP/REPL and web search are V1 goals but still require their own Guarded implementation and tests.

## 37.1 Common contract

Every service operation defines:
- canonical capability/action ID;
- caller identity and scope;
- input schema/version;
- owner/resource generation;
- effect class;
- cancellation/deadline;
- size/count bounds;
- stable error codes;
- provenance/source;
- result generation/revision;
- support/unavailable reason.

Unknown versions/capabilities/effect classes deny.

## 37.2 Capability registry

33 is the canonical human-readable capability catalog.
contracts-v2/capability-registry-v1.json is the machine design/alias seed.

Sealed builtin IDs cannot be shadowed. Alias resolution happens before policy. UI, CLI, model tool schemas and SDK project from the same IDs.

## 37.3 BrowserBackendV1 (post-V1)

Target capabilities:
browser.open/navigate/back/reload/snapshot/screenshot/console/network_errors/wait/assert
and dom.query/get/click/type/select/source_candidates.

Core interface:
- listContexts/listTabs
- observe(tab, requested views) -> observationGeneration
- act(tab, generation, BrowserActionV1) -> effect receipt/post-observation
- close/recover owned context.

Rules:
- distinguish managed versus attached user profile;
- stale generation denies mutation;
- CDP/network visibility is not a sandbox;
- upload/download/authenticated mutation uses Guard;
- worker crash invalidates references.

## 37.4 DesktopActionServiceV1 (post-V1)

Canonical family: desktop.*

Capabilities:
desktop.displays
desktop.windows
desktop.snapshot
desktop.ax.query
desktop.pointer.move
desktop.click
desktop.scroll
desktop.key
desktop.type
desktop.focus
desktop.clipboard.read
desktop.clipboard.write

Read-only/mutation classification is explicit; screenshots/AX reads are scoped observations, focus/input/clipboard mutation is effectful.

Interface:
- capabilities(osBackend)
- listDisplays/listWindows
- capture(target) -> DesktopObservationV1 with generation/geometry
- queryAx(observationGeneration, query)
- act(DesktopActionV1) -> receipt + next observation ref.

Required guards:
- exact OS/backend support;
- target window/display/process scope;
- stale capture denial;
- DPI/coordinate transform;
- emergency cancellation;
- no unrestricted Eval.

## 37.5 WebSearchBrokerV1 (V1 per `DEC-V1-26`; `DEC-V1-20` owns the cost/auth/reliability matrix)

Canonical family: web.search.*

Minimal capabilities:
web.search
web.search.providers
web.search.inspect_provider

Provider route classes:
DIRECT_SEARCH and GROUNDED_MODEL_SEARCH.

Interface:
- listProviders() -> capabilities/auth/cost/status/freshness
- search(WebSearchRequestV1) -> bounded results with URL/title/snippet/source/provider/retrievedAt
- cancel(requestId)

Route configuration and cascade (V1 contract):
- The default is the built-in anonymous/free provider cascade after a one-time first-use disclosure and consent that sends the query to external providers. The cascade contains only the fixed keyless routes listed below. GROUNDED_MODEL_SEARCH is a separate explicit opt-in and is never preferred or selected implicitly, even when the active provider offers it.
- BYO-key providers (Brave, Exa, You.com, Tavily, Firecrawl and Parallel; TinyFish remains optional and is not in the first route set) are enabled per provider in Settings (§16.7/§16.15) with credentials from the existing SecretBroker owner. Every API endpoint and authentication profile is fixed by the provider adapter and Rust route policy; config cannot supply a host, path, header or raw key.
- The anonymous/free routes join one trusted ordered cascade, shown in Settings and reorderable. BYO routes join only after separate user enablement and authentication/cost disclosure. Disabled or unconfigured routes are absent.
- Route failures are recorded per route. Authentication 4xx statuses (401, 403, 407) fall through to the next explicitly enabled/configured route without retrying that route; other non-rate-limit 4xx errors stop and surface. A timeout or connection error is retryable only when the trusted in-process transport durably proves that no request bytes left the process; settle a `NOT_DISPATCHED` route receipt with null HTTP status/result count/body digest/retry delay, zero body bytes and `responseComplete=false`, then permit at most one retry on that same explicitly enabled route. Any failure after request bytes may have left, including an ambiguous timeout, settles `UNKNOWN` and is never retried. A received HTTP 408, 425 or 5xx response uses the bounded same-route retry once; a second transient failure advances to the next enabled route. 429 observes `Retry-After` and continues. A recognized empty result is a complete HTTP 2xx with a provider result array containing zero rows; record it as terminal `EMPTY`, do not retry that route, and continue to the next enabled route. Cancellation after plan admission returns `CANCELLED` with the exact route-plan digest and any settled per-route receipts; it is not represented as exhausted or ambiguous. When the cascade is exhausted, surface per-route reasons — never a fabricated result.
- First-use consent enables only the anonymous/free default cascade. A paid, trial, or authenticated route requires separate explicit enablement and consent for its exact auth/cost class; a failed free route cannot silently route to one. The user can disable search or any route at any time.
- Every successful result carries provider, route class, cost class, auth source, freshness, retrievedAt, aggregate measured latency, truncation truth, and the bounded ordered route-attempt summary. `contracts-v2/web-search-result-v1.schema.json` and `packages/schema/src/web-search-v1.ts` define that exact success projection. A no-result outcome uses `WebSearchFailureV1` (`web-search-failure-v1.schema.json`) and retains `not_dispatched | failed | exhausted | cancelled | unknown | completed_result_unavailable`, bounded reason, and the same route status/auth/cost/receipt provenance. `not_dispatched` is reserved for pre-plan/no-attempt rejection. A known terminal non-auth/non-rate-limit HTTP 4xx returns `failed` with its exact settled route receipt and plan digest. Cancellation after plan admission is `cancelled` and preserves the exact plan digest and any durable per-route receipts; it is not mislabeled as route exhaustion or ambiguous UNKNOWN. `web.search.inspect_provider` reports configured/enabled state, auth/cost/rate-limit/last-error/freshness status per route. Unknown current cost is rendered as UNKNOWN and requires visible user consent; it cannot be presented as free.
- A pre-dispatch `not_dispatched` failure may omit `routePlanDigest` only when HostKernel never minted a trusted route plan; every outcome after plan admission (`failed`, `exhausted`, `cancelled`, `unknown`, or `completed_result_unavailable`) requires the exact HostKernel routePlanDigest. TypeScript cannot synthesize this authority digest.
- The model-facing `WebSearchRequestV1` carries only query intent and bounded options (query, result limit, optional domain filters, deadline and cancellation identity). Domain filters narrow query intent; they are not a network or authorization boundary. Validate their syntax and count/byte bounds, then require exact equality with the authenticated Guard-approved arguments. No separate domain allowlist is implied. It cannot select provider, route class, account, credential, cost policy, endpoint, auth mode, retry policy or budget. Core submits the model intent with protected Session/message/tool-call identity. HostKernel resolves the authenticated Attempt/principal where applicable, current search consent, user route settings, fixed route profiles/auth refs, approved aggregate plan, effects/leases, durable intent/receipt and UNKNOWN recovery. Only HostKernel's trusted route-plan projection carries provider IDs, per-route auth/cost class, retry/cooldown policy and opaque SecretBroker references. Caller-supplied endpoint, method, headers, native payload, principal and Attempt ID are forbidden.
- Exhaustion returns sanitized per-route status/retry provenance with the bounded result metadata. It never includes raw response bodies, query copies in route state, credentials, or provider exception text.

Rules:
- provider/model search are different adapters;
- auth comes from existing provider/SecretBroker owner;
- cost class FREE/PAID/TRIAL/UNKNOWN is explicit;
- fallback cannot silently change cost/auth class;
- source adapter existence does not imply enabled/working service;
- query-filter bounds and fixed-route network policy enforced; domain filters are not authorization (search content is untrusted data; injection handling per §5.8);
- results and responses are bounded; large fetched content becomes an artifact rather than prompt context;
- cancellation uses the canonical request-cancellation path.

**Route-class acceptance gates:** anonymous/keyless routes are exposed only when
`WEB_SEARCH_ANONYMOUS_RUNTIME_READY` is true; BYO/authenticated routes are exposed only when
`WEB_SEARCH_BYO_RUNTIME_READY` is true. Both also require negotiated
`execution.v1.web-search-cascade` and `effects.v2` at visibility and dispatch. BYO additionally
requires the exact configured SecretBroker reference and route-specific user consent. A false
gate disables only its route class: an unavailable BYO sender does not suppress accepted keyless
search, and an unavailable keyless route does not authorize BYO. No gate may silently change route
or cost class. Both gates remain false until their respective integrated Guard/transport/recovery
acceptance passes; source presence or consent cannot flip them.

Provider matrix seed (owner `DEC-V1-20`; research 2026-10-18; recheck route terms and availability before release):

- Built-in no-key cascade, initial order: Exa hosted MCP → You.com hosted MCP `?profile=free` → Firecrawl Keyless MCP → Parallel Search MCP. Current first-party documentation describes these exact endpoints as no-key; You.com discloses 100 queries/day and Firecrawl's free quota is capped per IP/day, while Exa and Parallel enforce vendor-side limits. These are distinct from account/API-key products. The adapter pins exact public endpoints/profiles, discloses query sharing/quota, and stops honestly on provider failure or exhaustion. A route is labeled FREE only when its exact endpoint is confirmed not to bill or use a paid account.
- Authenticated V1 routes available for explicit Settings enablement: You.com API/OAuth, Exa Search API/account, Tavily OAuth/API-key, Brave API, Firecrawl account/API and Parallel API, only when the exact current endpoint, auth mode, cost and terms are pinned. TinyFish is a post-V1 candidate alongside Kagi, Jina (Reader/SERP), Linkup and Serper. Discovery alone never makes a route runnable; credentials remain opaque SecretBroker refs, and price/auth details remain `UNKNOWN` absent current first-party evidence.
- Excluded: Google CSE (closed to new customers), Bing Search (retired), DuckDuckGo (no authorized API). SearXNG / custom endpoint is a deferred post-V1 option.
- Failover: 429 ⇒ honor `Retry-After` (default 60 s) cooldown then next enabled route; auth 4xx (401/403/407) ⇒ record the failure and continue to the next explicitly enabled/configured route without retrying the failed route; other 4xx ⇒ stop and surface the reason; a positively proven pre-dispatch connection failure ⇒ durable `NOT_DISPATCHED` receipt, at most one same-route retry; HTTP 408/425/5xx ⇒ one same-route retry after a durable response receipt; any possibly-dispatched timeout or connection ambiguity ⇒ `UNKNOWN`, no retry; a complete 2xx with a recognized zero-row result array ⇒ record terminal `EMPTY` and advance to the next route without a same-route retry. Exhaustion returns an honest no-results/failure projection. A later route may have a different cost/auth class only because the user explicitly enabled it.
- Consent: first-use disclosure offers allow the anonymous/free cascade, choose among its routes, or disable search. This does not consent to authenticated/paid routes. Each keyed route is separately enabled in Settings with its auth/cost disclosure; never upgrade a vendor's keyless route to its keyed or paid API. An optional per-query Guard challenge can be configured, but is not repeated for an already consented anonymous/free route by default.
- Page-content caching is post-V1: the V1 `WebSearchRequestV1`/`web.search` contract returns bounded link metadata and snippets and defines neither page fetching nor a cache-bypass input. Do not fetch or cache page content as an implicit search side effect. If a later V1 revision adds explicit page retrieval, it must define consent, URL/domain policy, content-hash identity, TTL, bypass, and artifact provenance together. V1 result provenance still records provider, credential mode, measured aggregate latency, attempts, freshness, and truncation.
- Provider endpoints are fixed to the sources registered in §42.1. Authenticated API routes require a SecretBroker reference and an accepted Rust HTTP route policy; route discovery or settings enablement alone does not create an executable route. Raw secrets are never supplied to the TypeScript adapter.
- A refreshed matrix replaces this seed whenever pricing/auth facts change; `DEC-V1-20` remains the owner.

**Implementation status (2026-10-20):** Horizon source contains an ordered bounded
cascade policy, per-route failure/cooldown provenance, a pre-admission aggregate-plan
projection bound to exact ToolBatch effect arguments, a read-only
`web.search.inspect_provider` tool, and TUI route enable/order controls. `WebSearchRuntime.node`
is composed in the production ToolRegistry. Its HostKernel adapter sends one aggregate
`execution.v1/execute_search_cascade` using the admitted route plan, challenge, one-use lease,
session and cancellation signal. HostKernel's fixed keyless MCP and BYO HTTP dispatchers,
aggregate durable intent/receipt, UNKNOWN recovery, per-route SecretBroker attempts, one-use
dispatch/settlement, continuation and cancellation are now source-present. Core composes
Auth's fixed SecretBroker sender and resumes from the exact settled response receipt. The
the historical single global gate predates the route-class gates above; refer to that contract.
Neither class is enabled by source presence or consent alone.
Core projects only opaque, unique AVAILABLE SecretRefs into the admitted route plan. No
credential bytes cross Core and no fallback can silently change route class or cost.
Inspection reports sanitized last-attempt
and cooldown state separately from provider health (`not_probed`); retention is process-local
and resets on restart. Each bounded route-attempt projection retains explicit UNKNOWN state
and derives cost/auth provenance only from fixed route identity (keyless=`FREE`/`none`,
BYO=`UNKNOWN`/`secret_broker`); attempt writes preserve route order. The legacy Core
Exa/Parallel HttpClient path is disabled. Settings inspection now projects all supported
routes, including disabled BYO routes with an existing opaque SecretBroker reference;
disabled routes remain absent from the executable cascade. An enabled BYO route without a
reference is reported unconfigured. This metadata projection performs no provider or network
request. New default-cascade and disabled-route inspection regression fixtures are
source-present but unrun.
Successful result `latencyMs` is measured with a monotonic clock around the aggregate
Core→HostKernel dispatch, so it includes bounded retries and transport overhead; it is not
presented as provider-server time. Per-route provider duration remains unavailable unless
HostKernel adds a trusted per-route measurement.
If the aggregate RPC loses its reply or is interrupted after invocation, Core reports UNKNOWN,
does not retry a route, and stops later serial effects. Exact durable receipt inspection/replay
after that transport loss uses exact-pin read-only reconciliation and never replays a provider
request or persisted response body. P1 exposes the read-only
`execution.v1/inspect_search_cascade` recovery RPC. Its request carries exact session, effect,
challenge, registered Location, lease digest, approved-arguments digest, and HostKernel-minted
route-plan digest, with no query or response body. The route-plan digest is BLAKE3 over the
canonical MessagePack encoding of the exact approved routes array and is compared against the
durable aggregate row. A settled successful aggregate returns
`RECONCILED_RESULT_UNAVAILABLE` with receipt references and never replays the body; a settled
cascade without a successful route recovers its exact terminal outcome (`FAILED`, `CANCELLED`,
or `EXHAUSTED`) with durable receipt references; `EXHAUSTED` is reserved for full approved-route
consumption. Unresolved or missing durable route state returns `UNKNOWN`. The HostKernel
approval projection carries `routePlanDigest`; Core must preserve it through approval/lease
state and call inspect after transport loss.
The ToolBatch projection takes query/result limit from model arguments but route order and
enablement from trusted Config, and fixed supported route IDs plus opaque SecretBroker refs
from trusted adapters. Missing SecretBroker refs omit only BYO routes, so they do not block
eligible keyless routes; no supported route fails closed before admission. P6 owns the trusted
provider-to-SecretRef lookup and fixed sender; P1 owns Rust one-use consumption, fixed route
policy, durable receipts and aggregate continuation.
HostKernel now offers the optional `execution.v1.web-search-cascade` handshake feature
only when the Guard execution backend is ready, and gates the RPC on that negotiated
feature plus `effects.v2`. Core requests the optional feature and checks both negotiated
features at the production dispatch boundary before sending the cascade RPC. This does not
change the production runtime gate. Core carries the exact Guard-pinned opaque
`credentialRefsByRoute` alongside routes in the aggregate request. HostKernel now exposes
`execution.v1/authorize_search_secret_use`, a metadata-only projection bound to the retained
Guard-approved route, exact lease digest, authenticated principal, fixed provider request,
and current direct/managed profile pins. The projection expires after 15 seconds and limits
each approved route to two ordered attempt grants in the current HostKernel epoch. It returns
no credential bytes or SecretBroker lease. Core must use the returned `request` and `trusted`
metadata with the existing in-process SecretBroker/ProviderTransport path. HostKernel now
persists a per-route `SearchSecretAttemptV1` PREPARED row before returning this projection and
returns an opaque attempt reference/digest. Core must call
`execution.v1/begin_search_secret_dispatch` immediately before the fixed SecretBroker sender;
that one-use transition durably marks DISPATCHING before bytes may leave. It then calls
`settle_search_secret_attempt` with bounded status/result/body-digest metadata, or
`mark_search_secret_attempt_unknown` if the outcome is uncertain. HostKernel persists the
route receipt without response bodies or credentials. On restart, PREPARED becomes ABORTED
and DISPATCHING becomes UNKNOWN; neither authorizes replay. The authenticated attempt/profile
scope is revalidated on each transition. Core's production composition calls the existing
Auth-owned fixed ProviderTransport path, validates the bounded body against its durable
SETTLED receipt, and supplies that exact receipt/body to the Rust-owned continuation. Core
never independently retries an aggregate RPC after transport loss; a same-route retry is
permitted only from the durable HostKernel cursor after an exact `NOT_DISPATCHED` receipt or a
known bounded transient HTTP response. Cancellation and lost replies use HostKernel cancellation
or read-only reconciliation; an ambiguous possible send remains UNKNOWN and is never replayed.
The complete cascade remains unavailable and
The corresponding route-class gate remains false pending its integrated acceptance.
Core's strict cascade receipt validator also treats a per-route `UNKNOWN` as terminal and
rejects any later route attempt in the same receipt; `UNKNOWN` cannot coexist with a successful
route, and `RECONCILED_RESULT_UNAVAILABLE` requires a final successful route receipt. This
prevents malformed HostKernel projections from erasing or retrying settled outcomes. Source
regressions were added but not executed, and this validation does not enable the runtime.
Grounded-model search has no production adapter. All search effects remain unavailable and
P5 is PARTIAL / NOT VERIFIED; no checks or live provider calls were run under the
implementation-first hold.

**P5 source review checkpoint (2026-10-21; no execution checks):** Test-only
policy fixtures cover the default ordered keyless cascade, explicit route
enablement and reordering, disabled/unconfigured route omission, bounded retry
and exhaustion, 429 cooldown, auth 401/403/407 fall-through only to explicitly
enabled routes, stop-on-other-4xx, sanitized failure provenance, and bounded
result parsing. Product-source fixtures cover the false runtime gate, zero
outbound requests, the absence of a raw callback executor, metadata-only route
inspection, and Settings consent/order persistence. These fixtures have not been
executed on the current integrated revision and do not substitute for the real
HostKernel/provider transport journey. P5's remaining release dependencies are outside
its owned implementation: the aggregate outbound dispatch stays closed on
the anonymous and BYO route-class gates remain false until their respective P1 Guard/ExecutionHost
(and, for BYO, P6 SecretBroker) acceptance, and
BYO route execution/credential provisioning stays unavailable until P6's
authenticated SecretBroker path is accepted. No P5 source change may promote
either gate based on fixture coverage alone.

**P5 provenance-contract alignment (2026-10-21; source only):** the canonical
result projection now matches the typed runtime metadata: auth source, freshness,
measured aggregate latency, truncation, bounded result items, and ordered
per-route attempts with status/cost/auth, sanitized reason, HTTP/retry status,
observation time and opaque receipt ref. A separate strict failure projection
retains not-dispatched, exhausted, UNKNOWN and reconciled-result-unavailable
outcomes without fabricating result data. The tool validates both projections
through `packages/schema/src/web-search-v1.ts`; the convergence fixture was updated
for both machine contracts. This is source alignment only. No fixture/schema check
was run; the Guarded runtime gate remains false until P1 acceptance, and BYO
credential routes remain unavailable until P6 SecretBroker acceptance.

**P5 projection closure (2026-10-21; source only):** successful tool text and
metadata now render the same bounded result projection; duplicate route-attempt
metadata is bounded and sanitized, and aggregate failures do not expose runtime
or provider exception messages. A generic runtime error is `unknown` because
dispatch may have occurred; empty cascade admission remains `not_dispatched`.
The TypeScript `ProviderId` bound now matches the machine schema's identifier
pattern. This does not change the false runtime gate or claim integrated acceptance.

**P5 callback-boundary hardening (2026-10-21; source only):** the former exported
TypeScript `runSearchCascade` callback executor has been removed from the production broker.
Provider metadata descriptors no longer carry a `search()` callback. The old retry-policy
simulator now lives only in a test fixture; production effects can enter only through the
HostKernel-backed `WebSearchRuntime`. A source fixture asserts that the production broker has
no callback executor and that it cannot invoke a route callback. This does not change either
the HostKernel interface or the false runtime gate; dispatch remains unavailable pending P1/P6
acceptance. No checks were run.

**P1 continuation source update (2026-10-20; not acceptance evidence):** The HostKernel
aggregate now pauses at an exact prepared BYO route and resumes only from its persisted
one-use SETTLED transport receipt plus bounded MessagePack response bytes. Rust checks the
body digest/length, derives fixed-provider result semantics, appends the route receipt once,
continues only in the approved order (including a subsequent keyless route through the
existing fixed executor), and persists complete bounded attempt history with terminal
aggregate receipts. The history cursor binds principal, session, Location, effect, challenge,
lease, route plan, query, owner epoch and Attempt-scope digest across every advance. The
read-only `execution.v1/inspect_search_cascade_continuation` can recover only an exact
prepared metadata projection or a receipt-only terminal/UNKNOWN result; provider bodies are
not persisted. Its exact request is `{cascadeRef,cascadeDigest,routePlanDigest,
lastReceiptDigest,query,limit,sessionID,effectID,challengeID,locationID,
capabilityLeaseDigest,directAttempt? | managedAttempt?}`; `lastReceiptDigest` is null only
before the first BYO settlement. `execution.v1/cancel_search_cascade` accepts exactly
`{cascadeRef,cascadeDigest,sessionID,effectID,challengeID,locationID,
capabilityLeaseDigest,directAttempt? | managedAttempt?}` with one authenticated Attempt
scope. PREPARED becomes ABORTED and UNKNOWN, while an in-flight dispatch row remains
unchanged and the aggregate is fenced UNKNOWN. For a managed Attempt, cancellation may
revalidate the exact one-revision `RequestCancel` transition to CANCELLING; it does not relax
effect admission or secret dispatch. Core must check interruption before dispatch and call
cancel with a fresh signal. The search runtime gate remains false; these source paths have
not been tested or accepted.
Credential put/rotation/revoke remains unavailable: the current Auth-side byte-to-handle
helper accepts host-JS bytes and there is no authenticated ServerAuth/principal/profile write
context or protected native-input bridge for a Guarded credential mutation. Do not expose
SecretBroker writes until those exact owners provide that context; TTY input alone is not
principal authorization. P1 also corrected the `terminal.run/start` consent projection to
report an empty residual only after the exact profile/executable, bounded argv/env, workspace
root and sandbox preflight completes; the one-use lease remains a dispatch-time check. The
previous residual IDs came from a different policy and caused supported command interpolation
approval to fail before the user could decide. This correction is source-only and awaits
integration evidence.

**P5 status-route source update (2026-10-21; not acceptance evidence):** the authenticated
`GET /websearch/providers` projection is registered through the existing workspace and
authorization middleware and additionally requires `TrustedPrincipalContext` plus an active
instance directory. It returns a bounded list of supported routes with enablement, opaque
SecretBroker-reference presence, cost/auth class, local dispatch availability, `not_probed`
health, unknown metadata freshness, and sanitized last-attempt/cooldown state. It performs no
provider call and returns no credential bytes. The CLI/TUI exposes the Settings dialog through
the `/web-search` command; enabling BYO routes states the possible-charge and UNKNOWN-cost
consent clearly. These source changes do not alter the route-class acceptance gates; P5 remains
PARTIAL / NOT VERIFIED pending P1/P6 integrated acceptance and the full web-search matrix.

**P5 zero-send receipt parser correction (2026-10-22; source only):** the TypeScript HostKernel
response decoder now treats explicit JSON `null` for HTTP status, retry delay, and result count
as the canonical empty-response projection of a proven `NOT_DISPATCHED` receipt, then requires
all three fields to be present and null. Previously it rejected `retryAfterMs: null` before that
exact-shape check, so the documented durable zero-send retry path could not consume its valid
HostKernel receipt. The allowed policy remains one same-route retry only for `timed_out` or
`transport_failure` (not `cancelled`); possible-send failures remain UNKNOWN and are never
retried. This is source-only and unverified. Both route-class gates remain false pending the
integrated P1 Guard/ExecutionHost acceptance, with BYO additionally dependent on P6 SecretBroker.

## 37.6 LanguageServiceBrokerV1

Canonical query capabilities include language.status/sources/diagnostics plus existing definitions.find/references.find/symbols.*.

Identity key:
workspace + language + root + config digest + executable/version + owner type.

Interface:
- discover/attach/start/restart/stop supervised service;
- diagnostics/definitions/references/outline;
- prepareCodeAction/rename returns versioned edits;
- apply mutation only through files.patch/Guard.

Editor-owned service is never restarted by a model query. Result reports source/generation/document version.

The broker coalesces concurrent starts only when the full compatible identity matches: source owner, authenticated principal/read scope, workspace/root/config/toolchain/executable/version, policy generation, and sandbox profile. These bindings are resolved by trusted owners, not caller-supplied. It tracks service lifecycle separately from health. A bounded query pin binds to one service generation through query completion/cancel/deadline; it is not a Guard or resource lease. Before starting a supervised service, obtain the existing Rust resource admission and Guarded ExecutionHost path. Idle eviction is permitted only for a confirmed Horizon-owned process after query pins drain and all effects settle. Editor/external owners may be detached from or marked degraded, never killed, restarted, reconfigured, or evicted by this broker. Startup failure, stale generation, or resource denial returns typed partial/unavailable status and explicit fallback provenance.

Workspace/config identity is necessary but not sufficient for reuse: principal/read scope, executable and config digests, policy generation, and sandbox profile must also match. Source/project content is read-only by default; only a dedicated scoped cache location may be writable. If the platform cannot enforce the needed filesystem/process/network profile, the server-backed operation remains unavailable.

**V1 launch authority:** Core Config owns the trusted LSP/DAP launch definition and supplies
the strict immutable `ExecutionLaunchProfileDefinitionV1` projection to HostKernel over
authenticated private IPC. The projection contains stable profile ID/revision, kind, the
Core-configured executable selector, literal argv, and fixed `registered_location_root` /
`sanitized_host` policies. HostKernel recomputes the profile digest, resolves and validates
the executable, and derives cwd from the authenticated registered Location. Arguments have
no interpolation or caller additions; runtime protocol data is sent only after launch. The
language/debug broker sends `ExecutionLaunchProfileRefV1` plus authenticated
Session/Location/Attempt scope. It never supplies executable path, argv, env, cwd, PID or OS
handle as authority. Built-in and explicitly user-owned launch profiles may be projected;
project/plugin/external definitions remain unavailable until trust resolution is implemented.
For DAP only, the definition may additionally carry the exact optional object
`dapPolicy:{allowEvaluate:boolean}`. Omission is default-deny; explicit `false` is also
denied, and either wire representation remains distinct in the canonical profile digest.
LSP/REPL definitions carrying this field are invalid. HostKernel retains the derived
permission with the exact launched generation and checks it both before Guard challenge
creation and again before operation dispatch. `allowEvaluate:true` is necessary but not
sufficient: every `evaluate` still requires the separate fresh `debug.evaluate` Guard
challenge and one-use lease, bounded typed expression/deadline/output, and exact process,
Attempt and workspace pins. The field never authorizes variables, attach, shell access, or
ambient target execution.
Guard and resource admission then dispatch through the single existing ExecutionHost and
return a minted `HostProcessRefV1`. A DAP adapter profile does not authorize launching or
attaching to the debuggee; that is a separate Guarded effect. There is no second supervisor
or independent mutable launch-profile registry. A launch request must be fenced by the
exact profile revision/digest, owner epoch, workspace revision and confinement guarantees
before spawn; uncertain launch is UNKNOWN and cannot be retried by starting a replacement
process. The strict schema is
`contracts-v2/execution-launch-profile-v1.schema.json`; Rust/TypeScript golden fixtures are
required before enabling launch. The existing OpenCode `LSP.Server.command` shape is not
authority.

**HostKernel source status (2026-10-20): CODE_PRESENT, NOT VERIFIED.** The private
`execution.resolve_launch_profile` operation currently validates authenticated Core
ServerAuth and the registered Location, resolves the strict definition through the
installation-owned selector map, and creates the canonical broker Guard challenge while
retaining the immutable definition/ref/executable pin in the ephemeral challenge binding.
The existing `execution.prepare`/`execution.launch` sequence accepts the profile ref,
revalidates selector and executable digest, and uses the same stdio supervisor with
read-only workspace confinement. The LSP Guard ID is canonical `language.start`; DAP uses
`debug.start`. REPL remains unavailable because this backend does not
enforce CPU/memory/FD limits. No runtime acceptance or test evidence is claimed yet; P4
must supply the Core Config projection and exercise the exact approval/launch DTO.

**P4 Core adapter source status (2026-10-20):** `packages/opencode/src/lsp/launch-profile.ts`
defines the strict Core-side `ExecutionLaunchProfileDefinitionV1` decoder, shared LSP/DAP
`execution.v1/resolve_launch_profile` and process-profile adapters, and a projection for
explicit global legacy config entries. The config bridge now exposes global-only LSP/DAP
profiles; DAP selectors are mapped to the HostKernel-owned `debugpy` and `lldb-dap` selectors.
No workspace/project config is authority, revisions are content-pinned, and environment
overrides are rejected. The resolver returns Guard challenge/effect/capability and opaque
profile refs; it does not launch or complete approval. REPL definitions remain rejected
without OS-enforced CPU/memory/process/FD limits.

Core also contains method-bounded LSP/DAP protocol DTOs and journals, codeAction/rename
WorkspaceEdit proposal validators, DAP command/capability argument checks, and bounded,
generation-scoped REPL callback state. Core LSP operation and server-reply DTOs now enforce
the exact canonical Guard capability for every accepted method, including lifecycle
notifications and bounded callbacks; callback parameters are method-validated before Core
handlers consume them, and only the diagnostic registration subset is accepted. The LSP
client now projects code-action and rename
results as proposals; application remains the canonical `files.patch` flow. P1's fixed query
mapping is codeAction → `language.diagnostics` and rename → `references.find`.
These are source components only. The shared HostKernel protocol journal/event parser, P1
Guarded process IO and OS confinement acceptance remain incomplete, so protocol adapters stay
unavailable and no LSP/DAP process path is enabled. There is no authenticated production
editor ingress; document sync still requires P3 `repo-intel.v1/read_document`. REPL callbacks
have no Rust RPC/recovery route and remain unavailable. No checks have run under the
implementation-first hold.

The minted `HostProcessRefV1` additionally carries the exact profile ID/revision/digest and
HostKernel-resolved executable content digest as immutable identity fields. They are
revalidated against the durable process record on every IO/control operation; callers
cannot manufacture a matching ref. A settled launch receipt records these pins as well.

Process stdin is not an opaque byte-write capability. HostKernel accepts only a typed,
lease-bound protocol operation and records a bounded receipt for the exact process
generation and payload digest. LSP open/change/close/cancel/shutdown synchronization is
bound to the active service and authenticated RepoRead scope. Read-only LSP requests map to
their canonical query capability (`language.diagnostics`, `definitions.find`,
`references.find`, or `symbols.*`); unknown/custom methods and `workspace/executeCommand`
are rejected. Code-action/rename results remain proposals until separately Guarded through
`files.patch`. DAP requests map to their existing `debug.*` operation IDs; REPL protocol
execution remains unavailable until the OS resource-limit requirement is enforced.
The fixed query mapping is `textDocument/codeAction` → `language.diagnostics` and
`textDocument/rename` → `references.find`. Both are non-write operations bound to the exact
HostProcessRef generation, Location, workspace revision, request source versions and returned
WorkspaceEdit. They cannot mutate files; accepted edits re-enter through versioned `files.patch`.

The typed protocol transport uses separate per-process sequences: Core→HostKernel
`protocol_op` and `protocol_reply` share a strictly increasing outbound `requestSequence`;
HostKernel→Core buffered notifications/server requests use a distinct contiguous
`eventSequence`. A reply correlates to the exact buffered server request ID and method and
never uses its `eventSequence` as an outbound request sequence. Reads are bounded by the
retained event cursor (at most 64 events and 1 MiB per page); each operation payload is at most
1 MiB with strict JSON-compatible value/depth/node bounds. Unknown methods, malformed or
non-finite values, duplicate/out-of-order sequences, stale process generation/owner epoch,
workspace revision change, and mismatched reply correlation are rejected before dispatch.
For a server→Core callback, Core first reads the exact buffered request, then prepares a new
Guard decision for that method's canonical capability. `protocol_reply` consumes that callback's
own fresh one-use lease; it never reuses the process-launch lease or a prior protocol operation's
lease. The nested reply carries the server request ID and method; the event sequence remains an
internal retained-row correlation pin and is not a top-level reply field.
The strict machine contract is `ExecutionProtocolDispatchReceiptV1` in
`contracts-v2/execution-protocol-receipt-v1.schema.json`. An accepted
`protocol_op`/`protocol_reply` returns a typed `schemaVersion: 1` receipt containing the exact
HostProcessRef, canonical `requestSequence`, monotonic `processIOSequence`, typed-operation
`operationDigest`, `dispatchReceiptDigest`, and `DISPATCHED` status. The operation digest is
BLAKE3 over canonical MessagePack
`["ExecutionProtocolOperationV1", protocol, requestSequence, operation]`, where `protocol` is
`lsp` or `dap`. For an LSP callback reply, `operation` is the nested strict
`LanguageProtocolReplyV1` subject; its retained server-request event correlation is checked
internally and excluded from the digest. The dispatch receipt digest is BLAKE3 over canonical MessagePack
`["ExecutionProtocolDispatchReceiptV1.dispatch", hostProcessRef, effectID, challengeID,
capabilityID, capabilityLeaseDigest, requestSequence, processIOSequence, operationDigest,
acceptedFrameBytes]`; HostProcessRef carries owner/profile/executable pins. The immutable intent
is durably committed before consuming the one-use lease or writing process bytes; the
terminal receipt is durably committed after a complete framed write and before the ACK is
returned. An identical retry returns the existing receipt without another write; a sequence
reuse with different content, skipped sequence, partial write, or lost/uncertain receipt never
replays and instead fences the process generation UNKNOWN. `processIOSequence` orders HostKernel
stdin frames and is distinct from both Core's `requestSequence` and inbound `eventSequence`.
If a cursor was evicted, an event sequence is missing, or an IO receipt is lost after possible
dispatch, the process generation becomes UNKNOWN/quarantined and the client receives
`resnapshot_required`; it cannot skip/reset the cursor or automatically relaunch. V1 has no
in-place LSP/DAP reinitialization path. Recovery requires a separately Guarded launch under a
new process generation and explicit Core initialization; uncertainty never authorizes reuse of
the old generation.

The Core `RepoDocumentReader` preserves typed stale-revision, out-of-scope, and over-limit
failures as LSP document-availability reasons instead of collapsing every HostKernel read
refusal into generic unavailability. It still sends no text to the server on any failed or
mismatched read and has no direct filesystem fallback.

The P4 process adapter reuses `execution.v1`: `prepare_process` records a non-dispatching
intent; `launch_process` revalidates live scope and consumes the exact one-use lease before
spawn; bounded `read`/`write`, `cancel` and `status` resolve only the minted HostProcessRef.
`write` is separately authorized and receipt-tracked. HostProcessRef binds process
generation, owner epoch and kind without exposing PID or executable path. A timeout or lost
launch/IO receipt is UNKNOWN and cannot trigger a replacement launch.

**Implementation status (2026-10-20):** Core source contains strict LSP/DAP protocol
projections, sequence/replay journals, typed HostKernel adapters, and Core protocol clients.
`HostKernelLspProtocolClientV1` dispatches operations and callback replies through fresh
authorization, consumes bounded event pages, serializes outbound sequences, correlates
responses, and quarantines cursor or process uncertainty. `HostKernelDapProtocolClientV1`
applies the same fresh-lease, ordered-dispatch, bounded-replay and UNKNOWN rules to DAP
responses/events. HostProcessRef pins the execution launch profile and executable; the
authenticated Attempt is independently bound by its full HostKernel scope digest. AgentProfileV2
and ExecutionLaunchProfileV1 are distinct authorities and their profile IDs/digests must not be
compared for equality. These
clients are not installed into product services because launch and protocol gates remain
closed. P1 now has source for a typed operation/event journal and the distinct LSP reply
subject; HostKernel still returns `capability_unavailable` while
`TYPED_PROCESS_PROTOCOL_RUNTIME_READY` is false, and the durable reply journal can independently
report unavailable. This does not establish Guard or OS acceptance. Generic DAP protocol dispatch rejects
attach pending shared PID-namespace/ptrace acceptance and rejects evaluate unless the immutable
adapter profile explicitly grants it and a fresh `debug.evaluate` Guard challenge is approved.
DAP session authorization accepts attach targets only as
HostKernel-issued `terminal_run` refs in the same owner epoch. REPL callback envelopes now reject
accessors, custom prototypes, sparse arrays and oversized/non-JSON values before schema
decoding; callback admission, generation fencing, and UNKNOWN settlement remain bounded Core
bookkeeping without a Rust Guarded invocation/recovery route. REPL start/reset/execute remain
unavailable until OS enforcement for CPU time, memory, process count and file descriptors is
accepted. No P4 runtime journey or acceptance tests have been run on the integrated revision.

**P4 integration blocker (2026-10-20; source review only; superseded at source level by the lifecycle update below):** At this checkpoint, Core Config projection and
`execution.resolve_launch_profile` have matching strict source DTOs, and HostKernel source has
`execution.prepare`/`launch`/`read`/`cancel`/`status`; however, Core has no production P4
lifecycle adapter that completes Guard approval through the TUI, passes the resulting one-use
lease into prepare/launch, validates the process receipt, and connects that exact HostProcessRef
to the protocol clients. `SessionSupervisor.requestHostKernel` is only a generic RPC and the
public supervisor interface has no P4 process lifecycle methods. Do not compose process effects
through an unrelated user-action or terminal path. P1 must finish and accept the shared
Guard/ExecutionHost dispatch and journal before P4 can wire those effects; until then both LSP
process and protocol gates remain false. The authenticated RepoIntel `read_document` adapter is
source-wired with no filesystem fallback, but production editor ingress and end-to-end acceptance
are absent. REPL additionally requires OS-enforced CPU, memory, process-count and FD limits; DAP
attach/evaluate/variables require their separate trusted target/profile policy. No P4 runtime
acceptance or tests are claimed.

**P1 editor-process gate (2026-10-20; source-only):** HostKernel has a separate
default-false `GUARDED_EDITOR_PROCESS_RUNTIME_READY` gate at launch-profile approval
and the prepare/launch dispatch boundary. It blocks only LSP/DAP profiles; `terminal.run`
continues through its existing guarded route. If startup succeeds but protocol HostProcessRef
or journal registration fails, HostKernel requests cancellation before marking execution and
EffectHost state UNKNOWN. The gate remains closed until P4's Core approval-to-lease lifecycle
adapter and OS acceptance are complete.

**P4 lifecycle adapter source update (2026-10-20; implementation only):** The former
integration blocker above is closed at the source-adapter level. `packages/core/src/session/
supervisor.ts` now exposes `resolveEditorProcessApproval`, which requires authenticated
ServerAuth, accepts only the existing `language.start`/`debug.start` Guard challenge, validates
the full HostKernel consent projection, completes the existing approval Deferred, and consumes
the one-use `effects.v2/resolve_approval` lease. The Core LSP lifecycle adapter projects only
trusted global profiles, resolves the Rust launch challenge, binds the lease and exact profile
to `execution.v1/prepare` and `launch`, and validates the minted process identity. Bounded
`read`, `cancel`, and `status` request/response projections are present; output pages preserve
binary stream records and contiguous per-stream cursors, and status reconciliation never retries
launch. These calls remain behind `languageServiceProcessRouteAvailable() === false`; this is
source integration only, not a runnable route or acceptance evidence.

Source reuse decision: adapt OpenCode's pinned LSP server/client split, per-root/server spawn
deduplication, diagnostic lifecycle, and protocol request/cancel semantics as Core orchestration
patterns. Reject its direct `Process.spawn` boundary, implicit executable resolution/downloads,
and process-owned authority; HorizonCode routes launches and bytes only through the single
HostKernel supervisor and canonical Guard. No Codex-specific LSP/DAP lifecycle implementation
was found in the inspected in-repository Codex tree; generic command execution is not treated as
an editor-service equivalent. No external source was copied and no dependency was added.

`makeEditorProcessProtocolBindingV1` now supplies the exact returned HostProcessRef, Attempt-pinned
workspace scope, and authenticated `SessionSupervisor.requestHostKernel` transport expected by
the existing LSP/DAP clients; it still requires the caller's fresh per-operation Guard authorizer
and is behind the same false runtime gate. Remaining P4 work: install that binding in production
LSP/DAP services and complete editor ingress once the P1 protocol journal, Guard dispatch, OS
confinement, and P3 authenticated document reader have passed acceptance. LSP mutation and DAP attach/evaluate remain
unavailable under their existing policy gates; REPL remains unavailable because required OS
resource limits are unsupported. No tests/builds/typechecks or runtime journeys were run for this
source update; P4 remains partial and unverified.

**P4 same-epoch launch recovery source update (2026-10-20):** The Core launch adapter now treats
a lost `launch` acknowledgement as uncertain and asks only `execution.v1/status` with the original
execution/effect/challenge/Location IDs and exact managed/direct Attempt scope. It accepts a
HostProcessRef only from HostKernel's same-epoch RUNNING projection after checking generation,
owner epoch, process kind and profile pins. PREPARED, UNKNOWN, malformed, cross-epoch or missing-ref
responses fail closed; Core never repeats spawn or synthesizes a process identity. This source path
is not acceptance evidence while the runtime gates remain false.


P4 integrates lost-launch status recovery in Core: after a lost launch reply it requests only exact scoped status and accepts a retained same-epoch HostProcessRef; it never retries spawn. The former per-operation authorization blocker is now source-addressed: P1's `effects.v2/prepare_user_effect` accepts typed `ExecutionProtocolAuthorizationV1`, requires one live Attempt scope, exact same-epoch HostProcessRef/current workspace revision/next journal sequence, and Rust-derived canonical operation digest. LSP replies must match the exact retained callback event/request/method. P4 owns the Core authorizer/consumer and is integrating against this API; all routes remain disabled pending exact lease-consumption/receipt and adversarial acceptance.

**P4 per-operation Guard seam (2026-10-20; source only):** Core declares
`EditorProtocolAuthorizationRequestV1` and its lease projection on the shared
`SessionSupervisor` interface. It calls the existing `effects.v2/prepare_user_effect`
with the typed authorization subject and exactly one Attempt scope, then routes the
standard challenge through the shared approval Deferred and resolves the one-use lease.
The subject pins HostProcessRef (including generation, epoch, profile and executable
digests), Session/Location/workspace revision, protocol sequence and typed operation,
canonical capability, and (for LSP replies) callback event sequence/request identity.
Rust derives the canonical operation digest; Core does not introduce JSON hashing or a
second codec. The supervised composition helper supplies per-frame operations, verifies
the returned lease and scope pins, and projects only the standard dispatch lease fields.
This adapter remains unverified and all runtime gates remain false. Canonical LSP
capability mapping remains `language.start/stop`, `language.diagnostics`,
`definitions.find`, `references.find`, `symbols.outline`, and `symbols.search`; DAP
remains restricted to its existing `debug.*` registry. Attach and evaluate stay denied
pending their separate target/profile policy.

**P4 remaining acceptance blockers:** P1's source API requires integrated acceptance;
P3 must accept authenticated `repo-intel.v1/read_document` production ingress; OS
confinement and editor lifecycle/protocol runtime gates must pass. The composition helper
is not installed into the LSP service or editor ingress.
DAP attach/evaluate stay unavailable, and REPL start/reset/execute stay unavailable until
HostKernel enforces CPU, memory, process-count and file-descriptor limits and adds the
Rust Guarded invocation/recovery route. Source presence is not runnable integration; no
P4 tests, builds, typechecks or runtime journeys are claimed.


P1's per-operation protocol Guard path is now source-landed inside existing `effects.v2/prepare_user_effect`: Rust strictly decodes the typed authorization, derives/checks its canonical MessagePack+BLAKE3 operation digest, matches exact process/Attempt/workspace/sequence scope, and retains the approved authorization in the CapabilityBinding. Protocol dispatch/reply must match the entire retained DTO before the durable journal records PREPARED, consumes the one-use lease and returns its dispatch receipt. Exact replay returns the prior receipt without a second write; conflicts and stale authority reject; cancellation/crash/receipt loss remain receipt-or-UNKNOWN/quarantine. P4's Core authorizer/consumer now has source scaffolding for the exact request, approval, lease pins and per-frame LSP/DAP adapter; runtime gates remain false and acceptance is NOT VERIFIED. DAP attach/evaluate remain denied.

**P4 Core Guard consumer composition (2026-10-20; source only):** The previous
“source scaffolding” description is superseded. Core's
`authorizeEditorProtocolOperation` now calls the existing authenticated
`effects.v2/prepare_user_effect` operation with the exact `ExecutionProtocolAuthorizationV1`
subject and one direct or managed Attempt scope. It uses the existing Guard approval owner
and one-use `effects.v2/resolve_approval` flow; it verifies the challenge's capability,
Location, effect, digest, expiry and consent projection, then validates the resolved lease
and binds the returned frame lease to the operation and Attempt. Rust remains the sole
canonical operation-digest producer. The LSP and DAP protocol clients pass their typed
operation subjects and exact scope to this consumer; the LSP callback path includes the
retained event sequence, and DAP authorization arguments are bounded and validated before
approval. The shared supervisor is the only HostKernel transport. This adapter is source
composed, not installed in production: `EDITOR_PROTOCOL_GUARD_RUNTIME_READY=false`, the
HostKernel protocol runtime gate remains false, and the editor process route remains
unavailable. P4 has not run tests, builds, typechecks, or runtime journeys.

Remaining P4 blockers are integrated P1 Guard/lease/receipt, crash/replay and OS-confinement
acceptance; production editor ingress/service installation after those gates; and P3's
authenticated `repo-intel.v1/read_document` acceptance for document synchronization. DAP
attach, evaluate and variables remain unavailable under their separate trusted-target and
non-evaluating-inspection requirements. REPL start/reset/execute remain unavailable until
HostKernel has accepted OS-enforced CPU, memory, process-count and file-descriptor limits and
a Guarded invocation/recovery route. No source status here claims runtime availability.

**P4 Attempt-scope source hardening (2026-10-20; implementation only):** editor process
launch rejects missing or simultaneous direct/managed Attempt lanes before profile resolution,
approval, or process preparation. REPL registry creation and effect admission apply the same
exactly-one-lane rule before retaining a session or reaching an authorization route. These
checks preserve the HostKernel-owned scope model; editor and REPL runtime gates remain false,
and this change has not been validated.

**P4 Core process lifecycle adapter update (2026-10-20; source review only):** the previously
missing Core lifecycle adapter is now source-present in
`packages/opencode/src/lsp/process-lifecycle.ts`. It routes profile approval, prepare, launch,
status recovery, bounded output reads and cancellation through the existing `execution.v1`
HostKernel owner; binds exactly one direct or managed Attempt, the immutable profile ref, the
one-use Guard lease and returned HostProcessRef; and never spawns or retries a launch locally.
Lost launch acknowledgement permits only exact-scope `status` reconciliation, accepting a live
HostProcessRef only from the same HostKernel epoch. The per-operation Core Guard bridge is also
source-present in `packages/opencode/src/lsp/guard-authorizer.ts` and delegates approval and
lease resolution to the shared authenticated SessionSupervisor owner. Neither adapter is
installed in a production editor route. `GUARDED_EDITOR_PROCESS_RUNTIME_READY`,
`EDITOR_PROTOCOL_GUARD_RUNTIME_READY` and the Core language-service route remain false; source
presence does not establish a runnable or accepted process path.

The Core output-page decoder now matches HostKernel's top-level envelope: `state` and nullable
`receiptDigest` accompany the bounded stream records and cursors, with an optional settled
`receipt`. The maximum page is 256 KiB, matching HostKernel's configured limit. It validates
per-stream contiguous sequences, exact returned cursors, page byte bounds and receipt pins.

Remaining P4 dependencies are P1 integrated Guard/lease consumption, durable receipt,
cancellation/restart recovery and OS-confinement acceptance; P3 acceptance of the authenticated
RepoIntel document-read path and production editor ingress; and the required real-project LSP
and DAP journeys. DAP attach/evaluate/variables remain unavailable pending trusted target and
non-evaluating inspection policy. REPL start/reset/execute remain unavailable until the OS
backend enforces CPU time, memory, process-count and file-descriptor limits and P1 supplies its
Guarded invocation/recovery route. No tests, builds, typechecks or runtime journeys were run;
P4 remains partial and unverified.

**P4 Core lifecycle/protocol continuation (2026-10-20; source only):** `lsp/supervised.ts`
now composes trusted global-profile projection, HostKernel launch approval and exact process
identity, the existing per-operation Guard authorizer/protocol client, and P3's authenticated
`read_document` callback. The document sync path has no filesystem fallback and rejects stale,
oversized, malformed and out-of-scope reads before sending document content. `dap/supervised.ts`
now composes the same launch/approval/HostProcessRef/Guarded-protocol owners for configured
global adapters; it provides only the adapter process and exact stop closure, not debuggee
attach/launch authority. Neither composition is registered into product LSP/DAP ingress.
The LSP composition now installs its stop closure before protocol/client construction and
memoizes cancellation for the exact launch lease, so failures during protocol setup or document
reader initialization still attempt one exact process cancellation; cleanup failure remains
surfaced with the original setup error. The LSP protocol client also invokes this same memoized
stop closure on terminal protocol/read uncertainty, callback mismatch or process exit, after
closing pending requests and quarantining its local generation. Cleanup failure is retained as
the client failure and reported by subsequent operations; already-pending work receives its
original uncertain-outcome error.
The DAP composition now also binds terminal protocol-client failure to one memoized cancel
request for that exact HostProcessRef/launch lease; uncertain protocol dispatch or failed
protocol reads therefore close the client and request supervised process termination. If that
cancel cannot be confirmed, the client retains the failure and reports it to subsequent calls;
setup-time cleanup failure is surfaced with the original setup error. Neither path retries
with a second lease.

LSP/DAP outbound protocol sequences are allocated inside their shared serialized dispatch queue.
Only a typed Guard or explicitly recognized pre-dispatch HostKernel denial rolls back the latest
sequence, so a denied approval cannot create a journal gap. Generic `effect_conflict` is not
treated as safe because HostKernel also uses it for journal/future-cursor conflicts. A valid
dispatch acknowledgement with malformed receipt, local journal mismatch, uncertain HostKernel
error, or possible partial write becomes typed dispatch-uncertain and quarantines the generation;
there is no retry. HostKernel protocol-read framing/event/retention uncertainty also stops the
current generation and requires a fresh snapshot. These semantics are source-present only; the
false runtime gates prevent the client from starting or dispatching.

The Prompt run boundary now provides a fiber-local `LSP.ExecutionScopeV1` only when P2 passes
exactly one live authenticated ManagedAttemptAuthority or DirectAttemptAuthority. It binds the
Session, Location reference, workspace ID/revision and immutable current Attempt snapshot; the
scope is not stored in the shared LSP service or taken from request/model data. This closes the
authority handoff gap between the P2 child runner and P4 adapter. The source now includes a lazy
per-scope installer: only built-in servers with an explicitly configured, HostKernel-approved
global profile are considered; each client cache and cleanup closure belongs to that exact
prompt scope. Stale Attempt snapshots invalidate clients, and status reads do not start them.
`getClients` remains unreachable while either process/protocol gate is false; root prompts without
an Attempt and non-prompt callers remain clientless. P3 document-read acceptance, P1
Guard/lease/receipt and crash/restart acceptance, OS confinement, production route acceptance, and
real-project LSP/DAP journeys remain unverified. DAP
attach/evaluate and unproven variable inspection remain unavailable; REPL remains unavailable
without HostKernel-enforced CPU, memory, process-count and file-descriptor limits plus a Guarded
callback/invocation route. No tests, builds, typechecks, audits or runtime journeys were run for
this source update; P4 remains PARTIAL / NOT VERIFIED.

**P4 Attempt-scoped Prompt handoff (2026-10-21; source only):** `session/prompt.ts` wraps the
authenticated runLoop in `LSP.withExecutionScope` using the authority supplied by the P2 owner.
The scope validator rejects both-lane, missing-lane, stale Session/Location/workspace pins and
does not create a fallback identity. P2 remains the sole owner of Attempt admission, refresh,
child lifecycle and TaskTool/runner dispatch; P4 consumes its current snapshot only. The lazy
installer resolves only trusted global profiles, passes each HostKernel-issued launch/process
pin into the existing Guarded protocol client, and binds RepoIntel reads through P3's authenticated
reader. A changed Attempt snapshot closes the cached clients; a new scope requires fresh approval
and HostKernel resolution. Every route is still behind the constant-false process/protocol gates.

The prompt-local LSP cache identity now also includes a SHA-256 of the complete trusted projected
launch-profile definition, so a reused profile ID/revision cannot share a client entry across
different projected command vectors. This is cache isolation only; the actual resolved profile
digest remains the HostKernel-minted HostProcessRef pin and is revalidated by the shared lifecycle.
No launch or protocol route is enabled by the local cache digest.

The REPL registry also exposes owner-bound activation, crash, execute-request validation,
result acceptance, and output-reference issuance alongside owner-bound lookup, callback
admission/settlement, status, reset, stop, and output resolution. Execute validation and output
issuance call shared internal functions without relying on object-method `this` binding.
Cancellation, process crash, idle expiry, reset, stop, oversized output, timeout/cancellation
results, and callback UNKNOWN invalidate generation output references; UNKNOWN also quarantines
pending callbacks so a late settlement cannot be mistaken for success. These are in-memory
lifecycle safeguards only: they do not supervise, stop, persist, or recover an interpreter
process. There is no accepted HostKernel interpreter status/reconciliation API for P4 and no
REPL production ingress. Start/reset/execute/callback/stop remain unavailable. Restart recovery
requires P1's durable receipt and process reconciliation contract plus an OS backend that
confirms CPU-time, memory, process-count, and file-descriptor enforcement. Core authorization
also now has an explicit constant-false REPL runtime gate before it can call a registered route;
caller-supplied resource-guarantee booleans cannot enable an interpreter effect. No validation
commands were run for this source update.

**P4 status and document-ingress source correction (2026-10-21; unverified):** the supervised
LSP client now exposes a read-only HostKernel `execution.v1/status` lookup pinned to its exact
HostProcessRef, launch effect/challenge, Session/Location/workspace and Attempt. `LSP.status`
uses only already-cached clients, reports connected only for a retained RUNNING process, and
does not start or replace a server. LSP diagnostics remain sourced from that pinned client;
code-action and rename results are reduced to bounded, versioned `documentChanges` proposals and
must still pass the existing `files.patch` path. `RepoDocumentReader` synchronizes only the
HostKernel-authenticated persisted workspace snapshot. There is still no authenticated editor
buffer owner/DTO for unsaved editor contents, so Core does not accept request/model-supplied
buffer text or represent this path as production editor ingress. The former statement above
that no interpreter status/reconciliation API exists is superseded: Core has exact-scope wrappers
over the shared HostKernel process `status`, bounded `read`, and `cancel` operations for a
retained `interpreter` HostProcessRef. These do not authorize start or input. Execute/reset use
the separate `repl_next_sequence` + Guard + `repl_op` receipt path; callback event/reply receipts,
CPU/memory/process-count/FD enforcement and all runtime acceptance remain outstanding. No
verification was run; gates remain false.

**P4 LSP proposal surface (2026-10-21; source only):** the existing optional `lsp` tool
source now defines `codeAction` and `rename` through the already-composed Attempt-scoped
LSP service. The registry withholds the tool while either shared readiness gate is false.
Inputs are bounded and passed through the typed protocol client; outputs contain only bounded,
versioned `documentChanges` proposals. The tool labels these as untrusted suggestions, includes
the rename target in the user permission prompt, and performs no filesystem mutation or
server-command execution. Any accepted change returns through the existing `files.patch` Guard
path and must match the current workspace preimages. The experimental tool flag and the shared
HostKernel process/protocol gates remain closed; this adds no editor ingress, launch route, or
runtime availability. Tests and end-to-end acceptance remain outstanding.

## 37.7 DebugAdapterBrokerV1

Source contract addition (2026-10-21): the typed DAP operation envelope admits
`attach` only with `arguments.targetHostProcessRef`; HostKernel resolves that
HostKernel-minted `terminal_run` reference internally and requires identical
principal, Session, Location, Attempt scope, owner epoch, and workspace revision.
Core never supplies a PID. `evaluate` maps to `debug.evaluate` and requires a
bounded expression, deadline, output ceiling, and optional frame/context. This
DTO path remains behind the constant-false typed-process runtime gate; variables
remain unavailable. No runtime acceptance is claimed.

The internal REPL lane uses `execution.v1/repl_next_sequence` to read the exact
next per-process operation sequence from the durable HostKernel journal. The
read is bound to HostProcessRef, principal, owner epoch, Session, Location,
workspace revision, and exactly one Attempt scope; it does not reserve or
increment the sequence. Core fetches immediately before Guard admission and
binds that value into the approved operation subject. `execution.v1/repl_op`
must match the journal's exact next sequence and records durable intent before
lease consumption or process IO. A stale/future sequence rejected before PREPARED
returns `effect_conflict` with no dispatch; after PREPARED, any ambiguity returns
`effect_outcome_unknown` and is never retried with a fresh sequence. Both calls remain denied
until interpreter OS quotas and callback/result receipts are accepted.

Canonical family: debug.*

Capabilities:
debug.start
debug.attach
debug.stop
debug.breakpoints
debug.breakpoint.set
debug.breakpoint.remove
debug.continue
debug.pause
debug.step.over
debug.step.into
debug.step.out
debug.stack
debug.scopes
debug.variables
debug.evaluate

Interface:
- create(adapter/workspace/launch config) -> session generation
- command(DebugSessionActionV1)
- snapshot(thread/frame/scopes)
- terminate.

The DAP `threads` and `stackTrace` protocol commands map to the existing canonical
read-only `debug.stack` capability, scoped to the live adapter process generation. `scopes`
maps to `debug.scopes`. `variables` remains unavailable unless the exact trusted adapter profile
proves that its inspection mode cannot invoke getters, lazy formatters, callbacks, or target
code; there is no `debug.threads` alias/capability.

Security:
- launch/attach/process control and breakpoint mutation are effects;
- evaluate is an effect and may be disabled by profile;
- variable/stack reads are scoped and generation-bound; if the adapter invokes getters, lazy evaluation, formatters, or target code to produce a value, the operation is effectful or unavailable rather than assumed read-only;
- no adapter command may execute outside declared workspace/process capability;
- session loss invalidates frame/variable refs.

Attach and every process-control operation use a private HostKernel-minted `HostProcessRefV1 { executionID, generation: DecimalU64, ownerEpoch: DecimalU64, kind }`; PIDs and executable paths are never accepted as authority. The DAP service generation is separate from the process execution generation. Each request also binds authenticated Session/Location context, the freshly resolved workspace revision digest and managed Attempt/effect scope where applicable. HostKernel resolves the authenticated owner and verifies the retained process kind, generation, owner epoch and RUNNING state before Guard admission. Missing/changed revision, stale DAP refs, process exit, owner restart, or UNKNOWN outcome rejects or quarantines the operation; it never attaches to an arbitrary PID or silently starts a replacement process. This private identity contract is not a public capability or launcher.

**P4 DAP source integration status (2026-10-20; implementation only):** The supervised
DAP protocol client now sends each bounded command through Core's per-operation Guard
consumer, which uses the existing `prepare_user_effect` challenge and one-use lease path;
HostKernel independently resolves the canonical command capability and binds the typed
operation to the exact process, Attempt, workspace revision and request sequence. Attach
and evaluate are rejected before authorization, and variables remain unmapped pending a
trusted proof that adapter inspection cannot execute getters or target code. The client
and Core composition helper are not installed in product ingress. `EDITOR_PROTOCOL_GUARD_RUNTIME_READY=false`;
P1 integrated Guard/receipt/OS acceptance and P3 authenticated document-read acceptance
remain blockers to any production editor route. This is source presence only, not runtime
acceptance.

**P4 DAP process composition update (2026-10-20; source only):**
`packages/opencode/src/dap/supervised.ts` now projects only configured global DAP profiles,
uses authenticated launch approval and the shared HostKernel lifecycle, passes the exact
HostProcessRef and Attempt pins to the per-command Guard client, exposes exact status recovery,
and binds stop to the same one-use launch lease. Client setup failure attempts cancellation of
that exact process; an unconfirmed cancel is reported with both failures. The shared process gate remains false, and
this adapter is not installed in DAP product ingress. It cannot attach to a debuggee or enable
evaluate/variables. No validation was run.

**P4 DAP fail-closed boundary correction (2026-10-21; implementation only):** the Core DAP
session helper now has an explicit constant-false runtime gate, matching LSP and REPL. Merely
registering the exported effect-route callback cannot make `authorizeEffect` call it before
integrated P1 Guard, confinement and receipt-recovery acceptance; `debugEffectRouteAvailable`
also remains false. Fixtures now require registered routes to remain uncalled for stop, attach,
and evaluate. This closes an adapter-registration path, but does not add production DAP ingress
or claim protocol availability. Tests remain unrun.

**P4 DAP typed-dispatch dependency (2026-10-21; historical source checkpoint):** at this
checkpoint the Core protocol client rejected attach/evaluate pending P1's typed target contract.
The later source update below supersedes the attach assessment. Product DAP ingress and real
Guard/lease/receipt, confinement, cancellation/recovery journeys remain unaccepted. Raw PID
authority remains prohibited. No validation was run.

**P4 DAP target-ref source update (2026-10-21; unverified):** P1 has accepted a typed
`attach` operation with exactly `{targetHostProcessRef}`; HostKernel resolves only a previously
Guard-launched `terminal_run` under the same principal, Session, Location, Attempt, owner epoch,
and workspace revision. Core's DAP client accepts the target only as a host-supplied opaque ref,
rejects caller-provided attach arguments, and places the ref inside the exact Guard-approved
operation. The validator rejects non-terminal refs, stale scope, extra PID/path fields, and refs
from another owner epoch. The supervised composition accepts this optional target binding but
does not discover or mint it. Both DAP and process runtime gates remain false; the Rust parser
and same-scope target resolution are source present, not acceptance evidence. `evaluate` stays
disabled because no trusted adapter-profile
evaluation permission is projected into the immutable launch profile; variables/getters remain
unavailable. No checks or real debugger journey have run.

**P4 DAP namespace constraint (2026-10-21; unverified):** HostKernel's same-scope
`targetHostProcessRef` contract is necessary but does not establish that the adapter can attach.
The current Linux bwrap plans use per-process `--unshare-all`; a separately confined DAP adapter
may therefore be unable to observe or ptrace the guarded `terminal_run` target. Core's
`DAP_ATTACH_RUNTIME_READY` is a separate constant-false gate, so even a valid target ref is
rejected before Guard authorization. Keep attach unavailable until the same ExecutionHost
provides an explicitly shared, same-authority debuggee namespace and the applicable ptrace
policy is enforced and accepted. HostKernel's private PID resolution does not prove namespace
visibility or authorize broadening ptrace access. No attach or real debugger acceptance is
claimed.

**P4 DAP evaluation-policy source update (2026-10-21; unverified):** Core Config now accepts
an optional immutable `dapPolicy: { allowEvaluate: boolean }` only on trusted global DAP
profiles. Core's profile projection emits an explicit `false` default and binds the policy to
the content-derived profile identity; the supervised DAP client forwards that retained value
to the per-call protocol authorizer. Evaluation still requires both this pinned opt-in and a
fresh `debug.evaluate` Guard decision with bounded expression/deadline/output arguments.
The shared JSON schema and HostKernel source retain and check the DAP policy in the
launch-profile binding. This does not enable evaluation: process/protocol gates
remain false, and the policy parser, profile digest and Guard path still require integrated
acceptance. Attach remains separately unavailable pending the shared namespace/ptrace condition
above; variables/getters remain unavailable. Authored Core fixtures are unrun.

**P4 DAP evaluate decoder alignment (2026-10-21; source only):** the Core DAP path's
bounded `evaluate` argument validator now requires the retained trusted profile policy
`allowEvaluate=true`, and the strict HostKernel protocol envelope preserves the
canonical `debug.evaluate` operation for the independent P1 profile-policy and fresh
Guard checks. Missing/false policy still rejects before Guard. This corrects the prior
Core decoder mismatch; it does not enable DAP because process/protocol gates remain
false and integrated Guard, receipt recovery, confinement, and platform acceptance
remain outstanding. The standalone LSP/DAP typed callback-dispatch helpers now also
consult that same false protocol-readiness gate before invoking an injected dispatch
callback, so they cannot become an alternate effect route. No check or debugger journey
was run.

## 37.8 ReplBrokerV1

Canonical family: repl.*

Capabilities:
repl.start
repl.execute
repl.reset
repl.status
repl.output_range
repl.stop

Initial languages: python and javascript when installed/supported.

Interface:
- start(language/runtime, scope, resource limits, callback capability set)
- execute(sessionGeneration, code/input, deadline) -> structured value/stdout/stderr/artifact refs
- reset/stop.

Rules:
- process supervised by ExecutionHost;
- wall-time/output are bounded by their host controls; CPU/memory bounds are available only
  when the selected OS backend enforces them. Because bounded REPL execution requires those
  resource guarantees, keep REPL execution unavailable while `ResourceLimits` is unsupported
  (`DEC-V1-27`); admission and monitoring alone do not satisfy the bound;
- filesystem/network explicit;
- callback to agent tools goes through canonical ActionDescriptor and Guard;
- no raw kernel/secret access;
- idle TTL and crash quarantine.

Each REPL session binds an authenticated owner, workspace/source generation, sandbox generation, and immutable capability ceiling. The ceiling constrains direct code execution as well as callbacks; callback checks do not substitute for OS-enforced filesystem/network/process/secret isolation. Reset/restart creates a new generation and cannot inherit authority or references from the prior one.

**P4 REPL typed-dispatch dependency (2026-10-21; historical source checkpoint):** the shared launch-profile
definition/reference schema includes `kind=repl`, and Core now projects fixed Python/JavaScript
selectors to the canonical `repl.start` approval path. HostKernel still rejects Interpreter during
profile resolution while its editor route is disabled and OS resource limits are unsupported; no
accepted interpreter start/execute/reset authorization or per-operation receipt path exists. The
generic HostProcessRef status/read/cancel DTOs can address only an already-retained interpreter
execution; Core now binds that identity once to the created REPL generation and validates it
against the owned profile/scope before reconciliation, bounded output reads, or cancellation. A
supervised composition adapter uses the shared profile approval, process lifecycle and Guard owner;
the HostKernel profile resolver and Core process gate still deny interpreter launch. Execute, reset,
callback dispatch and output publication remain unavailable. The Core generation registry, bounded
protocol envelopes, owner/workspace/capability pins, callback admission ledger, and constant-false
effect route are source present.
The registry is bookkeeping only and is not a production interpreter ingress. All start, execute,
reset, callback, output, and stop effects remain unavailable; callback execution must re-enter the
invoked tool's canonical ActionDescriptor/Guard path. Keep REPL unavailable until P1 supplies that
typed HostKernel boundary and the selected OS backend proves CPU, memory, process-count, and
file-descriptor enforcement; resource admission or monitoring alone is insufficient. The later
per-call DTO and adapter updates below supersede the source-contract assessment; runtime remains
false-gated. No validation was run.

**P4 per-call REPL DTO source delta (2026-10-21; unverified):** Core now has strict
source-only projections for a post-Guard execute/reset dispatch envelope and a candidate
callback-event projection. The proposed execute/reset DTO pins the exact interpreter
HostProcessRef, Session/Location/workspace revision, exactly one managed/direct Attempt,
HostKernel-provided request sequence, canonical capability, challenge, and one-use lease; its
operation payload is bounded and reset must retain the same immutable launch profile. The
callback projection cross-checks a candidate buffered event against the retained process,
Session, Location and workspace pins and a declared capability, then leaves the tool call to the
normal ActionDescriptor/Guard path. No HostKernel callback-read DTO currently authenticates the
event source. The projection deliberately provides no process
reply operation: a callback reply needs its own typed HostKernel authorization and durable
receipt, and callback UNKNOWN must quarantine the interpreter generation. At this checkpoint the
Core execute/reset projection had no accepted HostKernel DTO and did not authorize input; the
later typed adapter update below supersedes that assessment. Callback provenance/reply receipts,
integrated Guard/receipt/recovery evidence, and OS CPU, memory, process-count, and FD enforcement
under DEC-V1-27 remain open. Added focused fixtures are authored but unrun.

**P4 typed REPL adapter update (2026-10-21; unverified):** P1 now owns the strict
`ExecutionReplOperationRequestV1` / receipt parser and `execution.v1/repl_op` route. Core has a
matching request/receipt validator, obtains the next sequence from the new authenticated,
read-only `execution.v1/repl_next_sequence` journal projection immediately before Guard
admission, binds that value into the approved subject, and never allocates it locally. A
pre-PREPARED `effect_conflict` is definitive and may be re-read/re-authorized; transport loss
or `effect_outcome_unknown` quarantines the generation and requires reconciliation before a
new sequence peek.
Reset accepts only HostKernel's fresh `replacementHostProcessRef`; the old process ref cannot be
reused. Core limits each call to 30 seconds and 64 KiB output to match the Rust DTO. The Guard
authorization method is now included in the returned Core supervisor service. P1's `repl_op`
handler still denies execution while DEC-V1-27 CPU, memory, process-count and FD guarantees and
callback/result receipts are incomplete. Callback event provenance/reply receipt remains a
separate blocker. All REPL routes remain false-gated; authored fixtures are unrun and no runtime
acceptance is claimed.

The Core callback candidate projection now has an independent constant-false ingress gate. It
cannot turn caller-provided event-shaped data into a callback invocation until HostKernel
provides an authenticated bounded event read plus a durable callback reply/settlement receipt.
The in-memory callback ledger remains bookkeeping only and cannot dispatch an action or reply
to an interpreter.

**P4 current source inventory (2026-10-21; implementation only):** the LSP prompt path now
installs an Attempt-scoped, lazy `ExecutionScopeV1` in `session/prompt.ts`; `lsp/lsp.ts`
resolves clients only through that scope and both HostKernel readiness gates. The optional LSP
tool includes bounded code-action and rename proposals, and the existing HostKernel-backed
`files.patch` path remains the only mutation route. This is source-composed, not an accepted
runtime path. No production DAP session ingress or REPL execution/callback ingress is registered.
The DAP supervised composition and typed per-command authorization exist, while attach remains
constant-false pending a shared debuggee namespace and ptrace policy; evaluate additionally needs
trusted profile opt-in and its separate fresh Guard lease, and variable inspection remains
unavailable. REPL execute/reset now have exact HostKernel sequence, Guard lease, typed request and
receipt source adapters, but HostKernel still rejects them until CPU, memory, process-count and
FD enforcement and callback/result receipts are accepted. Its callback candidate and reply path
remain constant-false because there is no authenticated HostKernel callback event/read and durable
reply-receipt contract. These closures are intentional. P1/P3 integration and OS acceptance,
real-project diagnostics/debugger/REPL journeys, recovery and denial matrices remain unverified;
no tests or validation commands were run for this checkpoint.

**P4 source reconciliation (2026-10-21; source only, not acceptance):** the current Core
adapters now match the landed P1 typed `execution.v1` protocol and REPL operation surfaces.
LSP/DAP protocol clients use HostKernel event cursors, ordered request journals, fresh
per-operation authorization and receipt validation; LSP callback replies pin the buffered
event/request/method. The shared editor process lifecycle resolves only immutable global Core
Config profiles, passes profile definitions to HostKernel, consumes the existing Guard approval
flow, and performs exact-scope status/cancel recovery without retrying a possibly dispatched
launch. The prompt-local LSP composition supplies the authenticated Attempt and Core's
`readRepoDocument` effect; the normal LSP service still returns no clients while the process or
protocol readiness gate is false. Code-action and rename outputs remain bounded, versioned
proposals and file mutation remains on the Guarded `files.patch` path.

REPL execute/reset source uses HostKernel's durable next-sequence projection and exact typed
operation/receipt DTOs, with per-call Guard authorization and generation quarantine on uncertain
dispatch. Core now also has strict callback page and reply-receipt projections for the P1-planned
`repl_callback_read`/`repl_callback_reply` APIs. Reads enforce exact process/workspace pins,
bounded page size, contiguous cursors and callback payload limits; reply source cites the
ordinary callback action's Guard/EffectHost settlement and consumes no second Guard lease. The
reply's operation digest is BLAKE3 over the `horizoncode.repl-callback-reply.v1\0` domain and
canonical MessagePack of the exact request with `operationDigest` omitted; the nested callback
result carries generation as a decimal u64 string. Core and the SubagentDelivery authority
digest share the bounded schema MessagePack encoder. P1 now has the durable EffectHost callback
event/reply journal seams, including receipt replay and UNKNOWN fences. The HostKernel dispatcher
does not yet expose the two callback RPC routes that invoke them, and Guard DENIED still needs a
durable decision receipt before a no-lease denied reply can be formed. Core must keep denied
callbacks unavailable until that receipt and the routes land; successful/error replies require a matching settled
action receipt and lease. Core's settlement input is discriminated: `denied` carries the durable
Guard decision receipt with no lease, while `settled` carries the exact one-use lease and
EffectHost receipt. The Core callback ingress constant must
remain false until those APIs and their acceptance pass. Likewise, no production DAP session ingress is registered; the supervised
adapter remains a private composition. DAP attach remains false-gated pending same-authority
debuggee namespace and ptrace acceptance; evaluate requires trusted profile opt-in plus a fresh
Guard lease and remains inaccessible through product ingress. Interpreter launch/execute/reset
remain false-gated until HostKernel confirms OS-enforced CPU, memory, process-count and FD limits.
P3's authenticated document reader must pass its integrated acceptance before LSP document sync
can be enabled. Required remaining evidence is the integrated LSP diagnostics journey, DAP debug
journey, bounded REPL callback/recovery journey, denial/crash/cancel/restart/UNKNOWN cases, and
platform acceptance (native Windows remains unavailable without native evidence). No tests,
builds, typechecks, or runtime journeys were run for this source reconciliation.

**P4 buffer-overlay boundary (2026-10-21; source review):** `didOpen`/`didChange` currently
receive only bytes reread by the authenticated HostKernel disk reader. There is no trusted editor
buffer source in the prompt/TUI caller and no HostKernel-only overlay-mint RPC exposed to Core.
P4 therefore cannot mint a RepoIntel overlay from those LSP notifications without mislabeling
persisted disk content as unsaved editor state. Keep divergent unsaved-buffer overlay requests
unavailable until P3 supplies its private bounded snapshot producer contract and P1 exposes the
authenticated Session/Location/base-revision/read-policy mint seam. P4 must then feed that seam
only from an authenticated buffer owner; LSP `didOpen` alone is not such an owner.

## 37.9 DelegationMailboxV1

This is the delivery seam for the two lanes in §§3.5 and 29.5, not a third agent runtime.
Use the existing `SubagentRequestV2`, `SubagentReplyV2`, `SubagentDeliveryV1`,
`TaskDeliveryEnvelopeV1` and `DelegationBindingV1` contracts. Do not add a second message
store, task graph, transcript owner or event bus.

**Admission and start:** parent submits an idempotent request naming its own execution and
the selected profile revision, objective/output contract, bounded context refs, optional
workspace request, deadline, finite context/message/admission limits and reply mode. CPU,
memory, process-count and FD bounds are claimed as hard only when the OS backend enforces
them; monitoring is not enforcement (§14.5/`DEC-V1-27`). Authenticated ingress supplies
parent identity; a request body cannot assert parent, child, Attempt, epoch, workspace,
capability, provider/model entitlement or budget ownership. The Core direct-session owner
validates profile resolution, context selection and Session lineage; Rust validates and
reserves only its owned runtime/resource capacity and effect scope. In managed mode, Rust
additionally validates the accepted Task/Attempt and persists that lineage. Each lane's
canonical owner persists its own lineage before reporting success. If launch may have
occurred but cannot be observed, return UNKNOWN under that request identity and reconcile;
never report “not started” or launch a second child based on a timeout.

**Direct-session lane:** Core owns the parent and child canonical Session histories, their
parent/child linkage and queued/triggered child-turn delivery. The mailbox transports
 bounded, correlated data to a safe child input boundary. The canonical `agents.message`
request carries `deliveryMode: "queued" | "follow_up"`: `queued` never starts a turn;
`follow_up` requests exactly one serialized child turn at the next safe input boundary.
It cannot mutate an active request or splice into an in-flight token stream. No separate
follow-up capability is added. Parent operations use the
canonical `agents.*` capability surface (§33.12): list/inspect/graph are read projections;
`message` is a bounded mutation and `result` is a bounded read; wait observes activity or terminal status to a
deadline; cancel first fences new work and reports observed cancelled/still-running/unknown
state. Wait timeout does not cancel. Core projects child activity/results into the parent
Session/TUI without copying all child history into the parent transcript. Direct child
completion never settles a managed Task or Goal.

**Guarded message admission and recovery:** `agents.message` cannot use the
`question.ask` standalone-control exception. It mutates the durable child inbox, and
`follow_up` can cause a provider turn. Core obtains HostKernel admission through the existing
Guard owner before appending input. The private `direct.message.prepare` request is built only
from authenticated Core state and pins the parent/child Session IDs, current child owner epoch,
AgentProfileV2 ID/revision/digest, effective permission-scope digest, the exact durable
`directAttemptID` for both modes, Core-generated message ID, delivery mode, payload
digest/byte count, mailbox sequence and bounded capacity reservation. HostKernel re-resolves
that exact admitted Attempt and validates its durable parent/child/profile/scope/epoch/workspace
binding; a child Session ID alone is insufficient. A body-supplied identity or digest is never
authority. HostKernel returns a strict
`DENIED`, `NEEDS_APPROVAL` or `ADMITTED` projection; only `ADMITTED` carries an opaque one-use
lease bound to all pins, expiry and capacity reservation. Core persists the inbox row only
under that exact lease. `direct.message.commit` records the exact durable Core append receipt
and returns `QUEUED` or `FOLLOW_UP_SCHEDULED`; `direct.message.inspect` reconciles a lost
commit response. Exact retry returns the same receipt, mismatched idempotency reuse conflicts,
and an ambiguous durable boundary remains `UNKNOWN` until inspected. A lost `prepare` reply is
recovered only while the Core row remains `preparing`, by replaying the exact same message ID,
authority pins and payload against the same live child Attempt and owner epoch. HostKernel's
OwnerLog returns its retained PREPARED challenge or ADMITTED lease for that exact journal entry;
it never creates a replacement challenge or lease. Core leaves a transport-ambiguous row
`preparing` for this bounded retry. On owner-epoch change, unresolved entries recover as UNKNOWN;
Core may inspect the old exact pins but must not prepare again or append payload. No message,
lease, capacity reservation or turn authorization is reissued after epoch uncertainty.

Direct child admission also has a V1 aggregate lifetime ceiling of 64 child Sessions per
authenticated parent Session, across all selected profiles. The Rust durable profile-admission
OwnerLog enforces this cap atomically alongside each profile's stricter `maxTotalChildren` and
active/parallel limits; Core list counts are not admission authority. An exact retry of an
already-reserved Attempt is not counted twice, while a terminal child still consumes one of
the 64 lifetime slots. Only a reservation proven uncreated may be abandoned without consuming
that slot.

`queued` admission never schedules or starts a child turn. `follow_up` additionally requires
a distinct HostKernel-minted fresh-turn authorization bound to the same child/profile/owner
epoch and next-turn sequence; it queues exactly one runner turn at the next safe input
boundary. It cannot join an active request. If the Guarded mailbox operations, durable receipt
reconciliation or fresh-turn proof are unavailable, model-visible message/follow-up dispatch
is unavailable. The Core inbox/TUI projections may still be implemented and inspected without
claiming dispatch readiness.

Private IPC uses service `direct.message.v1` operations `turn_begin`, `turn_complete`,
`issue_fresh_turn_authorization`, `prepare`, `commit`, `inspect`, and
`acknowledge_consumed`. HostKernel owns a durable child-turn journal in the same
child-keyed OwnerLog as mailbox receipts. It initializes the next cycle sequence to 1.
`turn_begin` accepts only the authenticated live DirectAttempt and either starts sequence 1
or consumes the exact committed fresh-turn authorization for the current next sequence. It
mints a random `runnerCycleID`, persists the active cycle, and returns a `DirectTurnScopeV1`
containing the exact current DirectAttempt scope, owner epoch, cycle ID, sequence, and cycle
digest. The cycle ID and sequence come from HostKernel; Core cannot select or skip a sequence.
All subsequent guarded effects for that provider turn carry this DirectTurnScope. Ordinary
reusable DirectAttemptScope is not sufficient for a post-initial turn.

The cycle digest binds the complete current DirectAttempt scope, including its mutable Attempt
revision, workspace revision and scope digest. Therefore a settled effect that advances any of
those values must also advance the active turn scope: HostKernel validates the effect against the
pre-effect scope, records its exact terminal receipt, resolves the resulting live DirectAttempt
scope, and returns a newly minted DirectTurnScope with the same cycle ID/sequence and a digest
over that refreshed snapshot. Core durably records the refresh before starting a dependent or
subsequent effect. Batch effects refresh only after every member has a terminal reconciled
receipt, and the returned scope represents the final authorized state. A stale prior scope is
rejected; Core cannot rebase it. A lost refresh reply is recovered by resolving the exact effect
receipt, never by redispatch. If an effect is UNKNOWN, or its refreshed scope cannot be resolved,
the active cycle becomes UNKNOWN and no further effect, completion, or follow-up authorization
is allowed. This preserves the full-snapshot digest contract while allowing successive Guarded
effects in one live child turn.

After the provider request returns, Core calls `turn_complete` with the exact active
DirectTurnScope and a stable result digest. HostKernel checks that the cycle ID, sequence, latest
refreshed Attempt/workspace revision, profile/scope pins and owner epoch still match; it rejects
duplicate, late, stale, or skipped boundaries. It also refuses completion while any scoped effect lease is
DISPATCHING or UNKNOWN, or any direct Attempt effect intent lacks a terminal non-UNKNOWN
receipt. A successful completion durably closes that cycle and advances the next sequence by
exactly one. A lost reply reconciles against the same cycle/result digest. An owner restart
with an active cycle makes it UNKNOWN; it cannot mint a new cycle or follow-up authorization.

`issue_fresh_turn_authorization` accepts the exact FollowUp authority pins and the most
recent completed child turn. HostKernel resolves the next sequence from its own durable cycle
journal and requires an idle child, the same live DirectAttempt/profile/permission/epoch,
the next mailbox sequence, and no existing fresh-turn reservation for that sequence. It
persists and returns a one-use `FreshTurnAuthorizationV1` bound to message ID, payload digest,
mailbox sequence, DirectAttempt ID, child/profile/permission pins, owner epoch, next turn
sequence, issuance ID, expiry and authorization digest. Exact retry returns the same proof;
mismatched reuse or a second message for the reserved sequence conflicts. Core cannot supply
the next sequence as authority.

`prepare` carries that exact fresh-turn authorization for `follow_up` and no such proof for
`queue`. HostKernel validates and consumes/reserves it in the same durable mailbox admission
before Guard can authorize the append. Commit and inspect retain the same proof digest and
turn sequence; an unresolved reservation after restart/lease loss is UNKNOWN and never
reissued. `turn_begin` consumes a committed proof for the exact next sequence. Follow-up stays
disabled until the turn-cycle, proof and recovery operations have an integrated Core caller
and crash/restart acceptance.

The exact strict private JSON shapes are defined by
`contracts-v2/direct-turn-v1.schema.json` and the Rust DTOs
`DirectTurnScopeV1`, `FreshTurnAuthorizationV1`, `DirectTurnBeginRequestV1`,
`DirectTurnCompleteRequestV1`, and `FreshTurnAuthorizationRequestV1` in
`kernel/src/protocol.rs`:

```text
turn_begin request = { directAttempt, freshTurnAuthorization? }
turn_begin reply   = { status: "ACTIVE", directTurnScope }
turn_complete request = { directTurnScope, resultDigest: sha256:<hex> }
turn_complete reply   = { status: "COMPLETED", nextTurnSequence, receiptDigest }
issue_fresh_turn_authorization request = { authorityPins, completedTurnScope }
issue_fresh_turn_authorization reply   = { freshTurnAuthorization }
DirectTurnScopeV1 = { directAttempt, runnerCycleID, turnSequence, cycleDigest }; every successful
scoped effect settlement that advances the DirectAttempt returns the refreshed DirectTurnScopeV1
before Core may submit another effect or `turn_complete`.
FreshTurnAuthorizationV1 = {
  authorityPins, completedTurnScope, nextTurnSequence, issuanceID,
  expiresAtUnixMs, authorizationDigest
}
```

Every direct provider-turn ToolBatch request carries one `directTurnScope` beside its
`sessionID`, `locationID`, `batchID`, and complete `calls` array; `managedAttempt` and
legacy `directAttempt` are mutually exclusive with it and are not accepted as substitute
turn authority. HostKernel validates the full scope against the active child-keyed turn
journal before creating Guard challenges. Atomic Attempt binding is persisted together
with `(runnerCycleID, turnSequence, cycleDigest, batchID, ordered effectIDs)` before any
one-use lease is issued. If binding advances the Attempt revision, the HostKernel-minted
refreshed `directTurnScope` is included in the approval projection and Core must durably
save it before execution. Member effects retain immutable batch-start pins; each exact
terminal receipt is journaled against its effect ID. Intermediate receipts do not open
another batch or mint a public refreshed scope. Only the final terminal/reconciled receipt
returns the one refreshed scope for the final live Attempt head. Exact replay returns the
same receipts and scope without dispatch. UNKNOWN, missing receipts, stale scope, an active
batch, or a lost/unresolvable refresh fences the cycle UNKNOWN and rejects further effects
and completion. The strict envelope and reply shape are included as
`directEffectBatchAdmission`, `directEffectBatchAdmissionReply`, and
`directEffectBatchSettlement` in the schema above.

All decimal-string counters are canonical positive u64 values. `cycleDigest` is BLAKE3 of
domain `horizoncode.direct.runner-cycle.v1\0` plus canonical MessagePack of the exact
`directAttempt`, `runnerCycleID`, and `turnSequence` fields. `authorizationDigest` is BLAKE3
of domain `horizoncode.direct.fresh-turn-authorization.v1\0` plus canonical MessagePack of
the exact proof fields except `authorizationDigest`. `resultDigest` is the Core-produced
stable SHA-256 digest of the completed turn result. Rust DTOs, operation routing and a
child-keyed OwnerLog journal are now CODE_PRESENT. The journal shares the mailbox OwnerLog,
replays its own and mailbox event families, returns exact cycle/completion receipts, and fences
old-epoch active cycles and unresolved/expired authorizations as UNKNOWN. A turn start and
fresh-authorization issue also persist the HostKernel process incarnation: recovery marks an
uncompleted cycle from another incarnation UNKNOWN even if the connection owner epoch is
unchanged, and a consumed proof with no successor cycle is UNKNOWN. This closes the
same-epoch HostKernel restart ambiguity in the journal source; it has not been exercised by
restart acceptance. Follow-up prepare
reserves the proof before Guard challenge creation, while `turn_begin` requires the exact
committed mailbox receipt. HostKernel ToolBatch source now requires the full scope, checks the
active cycle before challenge creation, journals atomic batch binding before lease issuance, and
retains the scope on each member binding. Write, patch and terminal dispatch consume that
retained binding; terminal direct receipts append batch-member receipt/final-scope events, and
UNKNOWN Attempts fence the cycle. The Core lifecycle caller and receipt refresh decoder are still
being wired, and web-search/other effect settlement paths plus restart/replay acceptance have not
been reconciled against this contract. Therefore effectful non-initial turns and `follow_up`
remain unavailable; the direct-message service gate remains false by default. Source presence is
not acceptance evidence.

The consume acknowledgement carries the original exact
`authorityPins`, `inboxReceiptDigest`, immutable Core `consumption` proof and its stable
ordered SHA-256 `consumptionAckDigest`, plus a separately resolved live `currentConsumer`
DirectAttempt scope. Rust checks the immutable proof against the committed mailbox OwnerLog;
it checks `currentConsumer` against the authenticated live Attempt and requires the same child,
profile revision/digest, permission scope, owner epoch and workspace. Exact replay returns the
same consumption receipt; a fresh same-authority live consumer may retry when the first reply
was lost. Terminal or mismatched consumers cannot release pending capacity.
`prepare` carries nested `authorityPins` with `directAttemptID` for both modes, plus a
`freshTurnAuthorization` only for `follow_up`; the private mode is `queue|follow_up` (Core maps
public `queued` to `queue`). `DirectTurnScopeV1` is the exact DirectAttemptScope plus
`runnerCycleID`, canonical positive `turnSequence`, and HostKernel-minted `cycleDigest`.
Authority u64 values are canonical decimal strings, payload byte count and mailbox capacity are
bounded unsigned integers, UTF-8 payload is ≤16,384 bytes, and pending mailbox capacity is ≤32
rows. `commit` repeats exact pins and carries the one-use `capabilityLeaseDigest` plus the
authenticated Core inbox `inboxReceiptDigest`; `inspect` takes only the exact pins. Replies use
`DENIED|NEEDS_APPROVAL|ADMITTED` at prepare and `QUEUED|FOLLOW_UP_SCHEDULED|UNKNOWN` after
commit/reconciliation. Rust HostKernel source now uses one child-Session-keyed OwnerLog for
prepare/lease/commit and consumption receipts across successive Attempts. It validates the Core
append receipt against the exact ordered authority-pin digest and returns only committed
receipts from inspect; unresolved or expired appends recover as UNKNOWN. The 32-row limit counts
PREPARED, ADMITTED, and committed-but-unconsumed rows; only a persisted exact consumed ACK frees
a slot, while retained lifetime receipts remain bounded at 256 per child and sequence stays
monotonic. A post-restart legacy per-Attempt journal is unavailable/UNKNOWN rather than treated
as an empty mailbox. Approval still uses the existing Guard challenge and one-use lease path.
The Rust service gate remains false until Core's authenticated approval-to-lease continuation
and integrated crash/restart acceptance pass; source presence is not dispatch readiness.

**Core direct-message continuation (2026-10-20, source only):** the Core adapter now uses a
dedicated Session-owned SQLite inbox, with transactional bounded reservation and stable
`(parent, child, requestId)` idempotency, at most 32 pending messages and 256 lifetime receipt
rows per child. It clears payload text after a denial or confirmed consumption while retaining
the digest and authority receipt for idempotency. It persists the original payload and authority pins
before prepare so a pending approval or lost reply remains inspectable; only an admitted
one-use lease advances the entry to appended and permits `commit`. A lost prepare reply retains
the `preparing` state and is recovered by exact same-epoch prepare replay; after owner-epoch
restart the journal is UNKNOWN and inspection-only. Lost commit replies are reconciled with
`inspect`, never re-prepared. A later TaskTool prompt
claims committed `queued` rows atomically in mailbox order and injects them before provider
dispatch; no active token stream is mutated. After prompt return, Core transactionally records
each consumed row with the prompt message ID, immutable DirectAttempt authority-scope digest, workspace
binding and immutable consumption-ack digest. Core then calls
`direct.message.acknowledge_consumed`; the HostKernel acknowledgement is persisted separately
and only then releases pending capacity. A lost response leaves the row consumed but capacity
occupied; a later live same-profile/permission/epoch/workspace Attempt retries the exact
immutable consumption proof with its separately authenticated current-consumer scope. It never
redelivers consumed model input. Uncertain provider dispatch remains UNKNOWN. Follow-up remains
unavailable without the fresh-turn authority issuer. The Rust operation and Core caller remain
gated until integrated acceptance passes. No runtime test or verification evidence is claimed
here.

**P2 direct-turn Core lifecycle source update (2026-10-21; not acceptance evidence):** Core now
contains the TaskTool and HTTP follow-up callers for the complete §37.9 protocol. Both reserve
the exact bounded inbox row, resolve the authenticated live child Attempt and completed turn,
request HostKernel's one-use fresh-turn authorization, prepare/commit/inspect the same
message identity, and enter the serialized child runner only after the exact committed receipt.
The runner claims only that follow-up row at a safe boundary, calls `turn_begin`, persists the
HostKernel-minted scope before provider dispatch, and carries the scope through ToolBatch.
Settled ToolBatch receipts persist the refreshed same-cycle scope before another batch; turn
completion intent is persisted before `turn_complete`, and a lost completion response only
replays that exact scope/result digest. Consumption and HostKernel acknowledgement are durable
and idempotent. On restart, a `delivering` row or unresolved turn is fenced UNKNOWN; Core does
not reconstruct a runner or replay provider work. This closes the earlier source-only note that
the Core lifecycle caller and receipt-refresh decoder were still being wired. `DIRECT_CHILD_TURN_RPC_ENABLED`
and the Rust direct-message/turn dispatch gates remain false; P1 Guard/ToolBatch/receipt and
restart acceptance, effect-settlement coverage for all enabled origins, and P8 integration are
still prerequisites. Managed dispatch and verifier execution also remain unavailable until the
P1 authenticated dispatch/receipt/quiescence path and P8 settlement proof are accepted. No
tests, builds, typechecks, or end-to-end journeys were run for this source update; P2 remains
CODE_PRESENT, NOT WIRED/TESTED/VERIFIED for runtime acceptance.

**P2/P4 ownership handoff (2026-10-21; source only):** P2 owns minting and refreshing the
authenticated Attempt authorities and passing them through the serialized child prompt runner.
P4 consumes the exact current scope at the Prompt run boundary through the fiber-local
`LSP.ExecutionScopeV1`; it does not mint, refresh, or reconstruct child authority. LSP/DAP/REPL
process and callback routes remain unavailable until P1 Guard/ExecutionHost and OS acceptance,
plus the applicable P3 reader and integrated P4 journeys, pass.

The direct child status projection also exposes only the authenticated aggregate count of inbox
rows that still reserve the 32-entry pending capacity; it never returns payload text or message
authority. It omits an inconsistent list projection rather than clipping a count above the
HostKernel-enforced bound. This is source-only; the route/schema fixture remains unrun.

The direct child profile is resolved from Core Config's immutable `AgentProfileV2` catalog.
The selected revision must drive runtime model/harness/instructions and the effective
permission/tool projection, then be pinned with its resolved digest in the child Session and
Direct Attempt before prompt dispatch. Legacy Agent configuration may feed an explicit
versioned migration or stable alias mapping, but cannot independently define child authority.
If mapping, immutable revision recovery, or runtime projection is unavailable, deny dispatch
and resume before child creation/prompting; do not bind a digest to different runtime values.

**Managed Task lane:** Rust is authoritative for Run/Task/Attempt and mints the immutable
delegation binding only after accepted-SpecVersion Attempt admission. The delivery envelope
binds child identity/epoch, criteria, source revision, parent capability ceiling, provider/
harness selection, budget/deadline and resource/workspace leases. Each effect re-resolves the
live Attempt and uses the common Guard, one-use lease and ExecutionHost. Rust retains durable
lifecycle/effect/evidence cursors; artifacts are immutable refs. A child can return only a
candidate delivery, never transition canonical Task/Run state or mark criteria passed.

**Delivery and recovery:** one lane-tagged `SubagentDeliveryV1` binds request, parent,
child, message, payload ref/digest, owner epoch, sequence, expiry, lane-specific authority
claims and authority digest. The direct lane binds Core parent/child Session identity to the
trusted agent-profile revision and effective direct permission scope; the managed lane binds
the exact Rust `DelegationBindingV1` digest and Goal/Run/Task/Attempt identity. The digest is
domain-separated BLAKE3 over canonical MessagePack `["SubagentDeliveryV1.authority", lane,
parentExecutionId, childExecutionId, ownerEpoch, authority]`;
it is correlation/integrity metadata and never substitutes for authenticated owner lookup or
live Attempt/permission checks. The coordinator
validates payload bounds, current ownership/epoch, sequence/idempotency and expiry before
delivery or acknowledgement. Queue limits cover message count, encoded bytes and age; a
full queue reports backpressure and does not drop a result/receipt silently. Messages are
consumed at safe model-input boundaries. Terminal completion produces a typed bounded reply
with status, artifact/evidence refs, changed revision and limitations. A late or duplicate
delivery is idempotently acknowledged or marked stale; it cannot overwrite a newer child
execution. Restart reconstructs managed delivery from OwnerLog/artifact refs and direct
message history from Core's canonical Session owner. Cancellation fences admissions first;
already-dispatched effects still settle or remain UNKNOWN and are reconciled before reuse.

The existing `contracts-v2/subagent-delivery-v1.schema.json` is the machine shape for the
delivery envelope; its strict Rust/TypeScript validation and golden fixtures must agree with
the bounds and counter representation in §12.18 before a wire implementation is enabled.
§32.12/§32.33 own lifecycle, stale-delivery, queue-pressure, cancel/restart and receipt
acceptance. Direct and managed flows are separately illustrated in §45.8.

## 37.10 AutomationServiceV2

Durable Rust-owned definition/occurrence state.

Interface:
- list/inspect/create/update/enable/disable/runNow/history;
- deterministic overlap, missed-run, retry and timezone policy;
- each occurrence invokes the target canonical action through normal authorization.

Scheduler availability is shown accurately when no executor is running.

Persistence is rooted only under HostKernel's existing private state subtree; requests never
provide a filesystem path. HostKernel derives an owner scope from the
authenticated ServerAuth owner binding and registered Location/workspace, so definitions and
history survive Session changes but cannot cross principals or Locations. A bounded Rust-owned
registry/index is required for list and create/update revision CAS; a standalone per-definition
`AutomationJournalV1` does not by itself provide discovery or atomic definition updates. The
single scope `AutomationRegistryV1` OwnerLog and occurrence state are opened/reconciled by Rust,
with no directory scan or Core-owned database as authority. `runNow` is returned as unavailable
until the canonical Guarded invocation and receipt/recovery path exists.

Rust source now contains the bounded registry snapshot/replay, guarded create/update/enable/disable
CAS, deterministic occurrence transitions, and restart recovery of in-flight occurrences as
`UNKNOWN`. A guarded mutation receipt durably binds BLAKE3 digests for the exact Guard challenge,
persisted EffectIntent, consumed one-use lease, and canonical post-CAS execution receipt core. The
last digest covers the immutable receipt tuple (idempotency key, approved input digest, automation
ID, resulting definition version, operation), excluding its attached proof to avoid a circular hash;
all proof fields are committed atomically with the OwnerLog snapshot. `reconcile_mutation` is
read-only and matches the exact key, approved input digest, operation, automation ID and three
Guard binding digests. HostKernel combines that retained receipt with durable EffectHost state;
registry absence alone never proves NOT_FOUND. Snapshots write v2 proof records and still decode
v1 records as legacy unguarded history. The Core supervisor returns the exact HostKernel-approved
`inputDigest`; TypeScript must not re-encode the request to derive it.

The required Core route sequence is `prepare_user_effect` → explicit authenticated approval if
requested → the exact HostKernel mutation operation → read-only `automations.reconcile` after a
lost reply. Reconciliation repeats the exact location/action/challenge/effect/lease/input/key
pins plus `automationID` and canonical `hostOperation` (`automations.create|update|enable|disable`).
Core must never retry the mutation after the one-use lease is issued. Any
mismatch/UNKNOWN remains visible and requires a new action after durable reconciliation. The Core
and HostKernel mutation/reconciliation source paths implement this sequence. The ASK approval is a
sessionless authenticated workspace-owner action: the event is Location-scoped and carries the
HostKernel-minted `locationID`, `origin=user_action`, `source=authenticated.user_action`, exact
automation capability, challenge/effect digests, and assessed guarantees. The TUI may enable
`allow_once` for only `automations.create|update|enable|disable` with that exact owner-lane source
and a valid HostKernel Location ID; it must not invent a Session or Run identity. All other
approval origins retain the existing Session/Run requirement. TUI mutation controls now have
source wiring; status remains **CODE_PRESENT / PARTIAL** until the Core/TUI round-trip, restart
recovery, and acceptance evidence pass. `runNow` and scheduled invocation remain closed until their
independent target action Guard/lease/supervised dispatch/receipt/cancellation recovery path passes.

**Fixed action-input binding (2026-10-21):** the definition CAS persists one bounded canonical
user-authored JSON object and the `blake3:` digest of its schema as resolved from the existing
canonical machine registry. Its payload digest is BLAKE3 over
`horizoncode.automation-fixed-input.v1\0` + u64 big-endian byte length + exact canonical UTF-8
bytes; the effect-intent digest additionally binds automation ID/version, action ID/version and
implementation digest, schema digest, payload digest, and occurrence ID using the v2
length-prefixed intent domain. The TUI must request the trusted schema projection for the
selected exact action version, validate before submit, and never display stored input contents.
HostKernel/Rust must repeat schema validation and secret-field/opaque-reference checks before
the guarded definition CAS and again before invocation. It may not accept Core- or
caller-provided schema as authority. V1 dispatch stays unavailable until the authenticated
`automation_action.describe` projection, `AutomationRun` Guard origin, one-use lease, supervised
dispatch, durable receipt, and UNKNOWN/cancellation recovery are integrated and accepted. The
Rust OwnerLog currently stores only externally resolved `DueOccurrenceV1`; no canonical
timezone scheduler producer exists in this checkout, so schedule invocation also remains closed.

## 37.11 UiEventMuxV2

Derived presentation only.

Properties:
- bounded queues per surface/session;
- coalesce replaceable paint/status events;
- never drop durable canonical event/receipt references;
- source sequence/revision;
- reconnect from durable source, not UI queue;
- subscriber backpressure policy.

No UI event mutates canonical state.

**Instance SSE source bound (2026-10-21):** the HTTP event adapter filters instance/Location before queue admission, applies authenticated Session-owner filtering to question events before projection, and closes on bounded queue overflow for reconnect/resnapshot. **Shipping seams (2026-10-26):** `packages/server/src/handlers/event.ts` (instance SSE handler) and `packages/core/src/session/owner.ts` (`ownerMatchesPrincipal`, `legacyHostRootCompatible` for question visibility). It incrementally walks keys without first allocating a key array, stops wide-object/sparse-array traversal at 8,192 aggregate value/key nodes per event, clones/freezes and serializes the exact outbound `{id,type,properties}` JSON under 64 KiB/depth-32 limits, then queues the immutable snapshot and serialized bytes. Aggregate queued snapshots also stop at 65,536 nodes and 2 MiB. This prevents a mutable bus event from changing the question-owner-filtered projection after admission. The adapter is not a durable replay owner: Session state is rebuilt from canonical message owners; transient non-Session events still lack a canonical replay/list source. Source fixtures exist but are unrun.

**V1 replay boundary (2026-10-21):** instance SSE is live-only: the adapter emits no SSE `id` and does not accept a global `Last-Event-ID` replay cursor. Session part deltas carry their own monotonic `sequence` and `sourceGeneration`; the UI mux rejects duplicates, gaps, stale generations, and overflowed queues. On reconnect, gap, generation change, or queue overflow, the TUI reloads canonical Session messages and rereads durable managed projections through their owning APIs. A canonical Session fetch that overlaps newer live deltas detects that overlap, retries one bounded pass, and preserves the live projection/cursor if the source continues advancing. Transient non-Session notifications without a canonical owner API are not replayable and must not be represented as durable state. This contract does not add a second event store. Replay, reconnect, resnapshot, and large-history journeys remain unverified on the final integrated revision.

## 37.12 ArtifactRenderServiceV2

Inputs: immutable source/ref plus render kind/theme/geometry generation.

Renderers:
- Markdown/code/diff;
- bounded Mermaid to text/graphics;
- safe SVG raster;
- deterministic numeric table chart;
- image/PDF metadata/preview where supported.

Security:
- untrusted parser in bounded/crash-isolated worker;
- no SVG script/network/filesystem;
- stale async result discarded by source/theme/geometry generation;
- accessible source/text fallback.

Terminal graphics:
- detect protocol support;
- per-surface image budget/leases;
- transmit/place/evict lifecycle;
- no assumption Kitty/SIXEL/Tern is available.

**Source status (2026-10-20):** P7's bounded protocol/budget planner exists, but the pinned OpenTUI renderer integration in this checkout exposes no image transmit/place/evict seam. Do not write graphics escape sequences directly beside the active renderer; keep terminal image transmission unavailable with source/text fallback until OpenTUI can own placement, geometry and cleanup.

Durable export is a separate Guarded artifact action.

**Code display slice (§31.23):** `ArtifactRenderServiceV2` owns a shared
`CodeDisplayPipelineV1` used by transcript markdown, activity card previews, and review
overlays. Inputs: immutable text ref or line-index handle, `CodeDisplayPolicyV1`, theme/
geometry generation, viewport `(lineStart,lineEnd)`. Outputs: styled cell spans for that window
only. The pipeline must not allocate a full-file syntax tree above `lazyHighlightMaxBytes`;
queue at most `maxConcurrentHighlightJobs` highlight tasks per foreground tab; coalesce duplicate
viewport requests; drop stale results when `sourceGeneration` or theme epoch changes. File open
and diff overlay call the same pipeline after optional `repo-document-reader` / artifact range
admission. RAM counters feed §18.18 pressure and §31.16 diagnostics.

**Direct-session artifact retrieval (V1):** reuse the existing ArtifactStore and
`artifacts.search_text` capability; do not add a second artifact database or expose a path.
A direct `SourceArtifactV1` is resolved only when its `sessionId`/`ownerRef` match the
authenticated current Session, and its producer request, producer tool call, effect ID and
effect receipt are the exact settled records for that Session. Managed artifacts resolve
only against their Rust-owned Attempt and evidence refs. A managed Attempt cannot resolve,
read, or cite a direct artifact ID or content. If it needs equivalent bytes, a producer inside
that Attempt must independently create a new managed artifact and its own evidence refs; no
cross-lane promotion/capture exists. Every search/range request is generation-bound, bounded,
cancellation-aware and reports digest, wire fidelity (`full`, `head_tail_sample`, `failed`) and
redaction truth; the UI may label these `FULL`, `SAMPLE`, `FAILED` but cannot alter or
hide the wire value. A missing or uncertain producer receipt is lifecycle `UNKNOWN`, never a
fidelity value. Current HostKernel/Core artifact DTOs still serialize uppercase fidelity labels;
this is a source-contract mismatch and remains unaccepted until the wire projection uses the
canonical lowercase enum. No
filesystem fallback is available. Existing tool-output capture and ArtifactStore are the
owners; this is a read-only projection, not an effect or evidence authority.

For a root direct Session, HostKernel maintains a narrow immutable ToolBatch-admission index in
its existing durable location authority store. It is derived atomically from authenticated
`prepare_tool_batch` admission and binds Session, Location, owner epoch, request ID, batch ID,
canonical ordered call IDs/effect IDs, and the canonical batch digest. A PREPARING row is never
an artifact source; only a fully admitted batch may become ADMITTED. Restart or partial admission
is UNKNOWN and exposes no artifacts until reconciled from the existing EffectHost journal.
Artifact IDs/content supplied by Core or a caller are never trusted as provenance. P1's
EffectHost remains the receipt authority; the index only resolves the admitted effect identity
needed to join that receipt to ArtifactStore metadata. Retrieval requires the exact terminal
settled receipt and matching producer/session/effect/artifact metadata. This adds no receipt
database and cannot promote direct artifacts into managed evidence.

## 37.13 TerminalExecutionServiceV1

One host-scoped Rust kernel is the sole process/effect owner, multiplexed across
Locations and Sessions. Core `Pty.Service` is only the V1 `/pty`, V2 `/api/pty`,
WebSocket and replay adapter; tickets/origins authenticate transport only and never
authorize Guard effects. No per-Location/per-PTY kernel or parallel process manager.
The host derives principal from validated `ServerAuth`, or requires loopback listener
and peer and derives OS UID/SID itself; missing proof denies. Both V1 and V2 create
adapters preserve public `Pty.CreateInput` `command`, `args`, `cwd`, `env` semantics
(omitted command/args/cwd mean configured shell, empty args and Location directory,
including login-shell behavior) and unchanged public `Pty.Info`; Core projects the
kernel result, retains `title` metadata and never directly spawns, writes, resizes or
kills.
For terminal WebSocket attach, ticket requests and reconnect, Origin must be present
and match exactly `oc://renderer`, `tauri://localhost`, `http://tauri.localhost`,
`https://tauri.localhost`, an exact configured origin, or exact configured listener
origin. Prefer one-use tickets bound to principal, terminal, Location and exact
Origin. V2 obtains a ticket. Preserve ticketless V1 only with validated required
`ServerAuth` Basic/`auth_token` credentials; with auth not required, ticketless attach
is allowed only under the loopback-only listener/peer plus host-derived OS-principal
rule. No ticketless path bypasses principal proof. Check terminal existence before
query/ticket/origin validation (authorized unknown ID stays the established empty
404); validate the requested subprotocol before WebSocket upgrade. Redact tickets
and `auth_token` from logs.


All operations use the common §37.1 envelope: protocol/schema version, authenticated
caller and scope, owner/resource generation, effect class, deadline/cancellation,
input/output byte and item bounds, stable errors, provenance, result generation and
support/unavailable reason. Unknown capability/version, malformed frame, missing
principal proof, stale generation/fence, or exceeded bound fails closed. The service
does not echo/log raw environment values or terminal input. Provenance records
authenticated principal source, ingress/origin and surface, Location/workspace,
terminal/artifact ID and generation, effect/grant/receipt IDs, backend/guarantees,
owner epoch/fence and operation outcome; never records tickets, auth tokens, raw
environment or raw input.
The process owner is a separate host singleton in the existing kernel crate, launched
as `hz-kernel --state-dir=<state-dir> --socket=<socket> --host-exe=<host-exe> --nonce=<nonce> --incarnation=<incarnation>`.
Its authenticated HelloResult returns a durable, monotonically increasing positive
`ownerEpoch`; `session_supervisor` receives that epoch and remains projection/ACK-only.
There is no host-wide single `workspace-root`.

Before effect admission, register a trusted Location internally with
`effects.v2/register_location {canonicalRoot,workspaceID?}`. The root must originate
from a trusted `Location.Ref`, never a request or model; Rust canonicalizes it. It
returns `locationID = "loc_" + lowercase BLAKE3 hex(UTF-8("horizon.location.v1\0" +
canonicalRoot + "\0" + (workspaceID ?? "")))` and rejects rebind. TypeScript does
not duplicate path canonicalization.
Model `bash` and other model effect batches use `effects.v2.prepare_tool_batch`: ALLOW returns
`{status:"prepared",effectID,capabilityLeaseDigest}`, ASK returns a Guard challenge
and no digest. Only explicit matching `allow_once` allows
`effects.v2.resolve_approval` to return
`{status:"approved",effectID,capabilityLeaseDigest}`; denial, expiry, mismatch or
missing approval yields no digest. The kernel-issued opaque digest binds challenge,
input, Location, principal and owner epoch, and is consumed once by `terminal.run`
or `terminal.start`.

**Direct read fast path (`DEC-V1-36`):** read-class tools use
`effects.v2.prepare_tool_batch_read` to admit up to **8** read calls per provider
response in **one** RPC when session grant or Guard ALLOW covers them. Returns per-call
lease digests or a batched read lease; does not authorize mutations. Mutations continue
to use `prepare_tool_batch` on closed batches only (§14.3.1).

Admission blocks on approval: `effects.v2.prepare_tool_batch` does not return a
challenge for the caller to answer later. It resolves when the approval surface
replies through `replyGuardApproval({approvalID,decision})`, so a caller that tries
to approve *after* prepare returns deadlocks; approve concurrently, as the HTTP
adapter and the event broker do. Normalized effect targets carry
`operation ∈ {"write","delete","run"}`: `run` is the process-effect target of a
`terminal.run` challenge (target = canonical working directory, resource = location-relative
path) and never carries `executable`, which is a filesystem-only field. A settlement
record must echo the operation that was admitted — a terminal challenge reconciles as
`run`, never as `write`. Host deadlines such as `expiresAtUnixMs` are unsigned
64-bit MessagePack integers encoded in the shortest form, so any timestamp beyond
32 bits reaches a TypeScript reader as `BigInt`; readers normalize through
`wireUnixMs` and must not assume a plain safe integer, while values that stay within
32 bits (owner epoch, generation, sequence, exit code, timeout) remain numbers.

User-originated `terminal.start` and `terminal.run` use only
`effects.v2/prepare_user_effect {locationID,sessionID?,userActionID,capabilityID,arguments}`.
The server generates `userActionID`; Core injects the typed principal only from
validated ServerAuth middleware (username only) or a host-OS marker; Rust
independently derives UID/SID and binds any ServerAuth subject. Do not fabricate a
Session when none exists. This remains distinct from a model batch.

Approval is projected as `GuardApproval` EventV2. The protected
`POST /api/guard/approval/:approvalID/reply` accepts only
`{decision:"allow_once"|"deny"}`; the server generates `approvalID`. There is no
`always`, auto-accept or `ctx.ask` approval route. The UI shows exact normalized
action, resolved resources, policy and expiry, never raw environment secrets.
The protected reply adapter calls
`replyGuardApproval({approvalID,decision})`; Core resolves the challenge/Location
from the server-generated ID and the trusted principal context. Missing or
wrong-principal IDs share 404; expired/replayed/stale requests return 409 and invalid
decisions return 400. ServerAuth context contains only the validated username;
without ServerAuth the host OS identity is kernel-derived.


| Operation | Input → result | Class and bound |
|---|---|---|
| `terminal.run` | `{effectID, capabilityLeaseDigest, locationID, sessionID?, shellProfileID, command, cwd, timeoutMs, resolvedEnvironment}` → `{status: exited\|timed_out\|cancelled\|unknown, exitCode?, preview, previewTruncated, artifactTruncated, artifactRef, receiptRef}` | `guarded_effect` → runtime `effect`; one-shot PREPARED/lease/ExecutionHost/settlement; command ≤64 KiB UTF-8, cwd ≤4 KiB, timeout 120 s default / ≤600 s (over-limit is `TIMEOUT_LIMIT`, never clamped); max 100 MiB stored per log, then drain and report truncation; 50 KiB/2,000-line preview; 1 GiB host artifact quota; 7-day retention. `previewTruncated` reports the preview slice and `artifactTruncated` the artifact cap/drain independently; Core rejects a result that omits either flag, so a caller can never present a truncated run as complete. Environment resolved by host, not model. |
| `terminal.start` | `{effectID, capabilityLeaseDigest, locationID, sessionID?, terminalID, shellProfileID?, command?, args?, cwd?, cols?, rows?, env?}` → `{terminalID, generation, grantID, leaseRef, expiresAt, backend, cols, rows, byteCursor, pid}` | `guarded_effect` → runtime `effect`; durable PREPARED + one-use launch lease becomes InteractiveTerminalGrantV1, explicit approval, at most 60 min. command ≤64 KiB UTF-8, args ≤256 entries/≤256 KiB total UTF-8, cwd ≤4 KiB, env ≤128 entries/≤64 KiB total key/value UTF-8, cols 1–500, rows 1–300. Bind exact normalized launch/config and approved environment; never inherit ambient `process.env`. |
| `terminal.input` | `{terminalID, generation, grantID, attachmentID, sequence, bytes}` → ack `{terminalID, generation, attachmentID, acknowledgedSequence, state}` | `guarded_effect` → runtime `effect`; continuation under current grant/Guard; bytes ≤16 KiB. |
| `terminal.resize` | `{terminalID, generation, grantID, attachmentID, sequence, cols, rows}` → ack `{terminalID, generation, attachmentID, acknowledgedSequence, state}` | `guarded_effect` → runtime `effect`; same checked continuation lane; cols 1–500, rows 1–300. |
| `terminal.cancel` | `{effectID, terminalID, generation, reason}` → `{terminalID, generation, state, receiptRef}` | registry `guarded_effect` → owner-only runtime `control`; fences before scoped signal/terminate; no new launch or authority. |
| `terminal.status` | `{terminalID, generation, afterSequence?, afterByteCursor?, maxBytes?}` → bounded state plus optional replay | `read_only` → runtime `read_only`; read status/replay only, not a new replay capability; replay/output ≤64 KiB. |
| `terminal.search` | `{artifactID, generation, query\|regex, maxResults, maxBytesPerExcerpt}` → matches `{lineStart, lineEndExclusive, byteStart, byteEnd, excerpt}` | `read_only` → runtime `read_only`; exact current direct Session artifact or exact managed Attempt artifact; UTF-8 pattern ≤4 KiB, `maxResults` 1–100, each excerpt ≤4 KiB; stable zero-based line refs. |
| `terminal.output_range` | `{artifactID, generation, lineStart, lineEndExclusive, maxBytes}` → bounded lines/bytes and digest | `read_only` → runtime `read_only`; exact current direct Session artifact or exact managed Attempt artifact; zero-based half-open ranges; `maxBytes` and response ≤64 KiB. |
On any listed wire-bound overflow or invalid dimension, return a typed rejection;
never clamp or silently truncate the request. These request-validation rules do not
change the separate managed-log storage cap and drain/truncation behavior above.


Every search/range request checks the lane-specific artifact owner and exact generation; rotated,
truncated or replaced output returns `STALE_GENERATION`. No caller path or full-log
result. Search refs and output-range refs are the same artifactID/generation and
zero-based line/range model as §30.17 and §33.23. `query|regex` is explicit literal
versus regex mode. Input/resize sequence is monotonic per attachment and generation:
only next sequence dispatches, duplicates re-ack without redispatch, gaps/stale
sequence reject; attachment ID is server-generated after one-use ticket consumption
or validated V1 credential auth. Uncertain input is never replayed after owner loss.
Terminal EventV2 cursors use `ownerKind:"terminal"` and `ownerId:terminalID`.
Sequence `"0"` is the base sentinel
`blake3:0000000000000000000000000000000000000000000000000000000000000000`; each
event increments decimal sequence. `eventDigest` is `blake3:` plus lowercase BLAKE3
hex of canonical MessagePack map
`{terminalID,generation,sequence,byteCursor,kind,payload}` with sorted map keys.
Exclude `subscriptionId` so replay to another subscriber retains the same digest;
cursor sequence equals event payload sequence.


PTY replay is separate from managed logs: 2 MiB ring per terminal; output frame ≤64
KiB, input frame ≤16 KiB, WebSocket outbox ≤2 MiB; close slow clients and report a
gap/reconnect state rather than silently dropping output. Byte cursors are canonical;
legacy UTF-16 cursors translate only at adapter boundaries. Preserve existing V1
`/pty/{ptyID}/connect` and V2 `/api/pty/{ptyID}/connect` ticket/origin rules and
no-subprotocol legacy framing. New binary protocol requires exactly one
`horizon.terminal.v1`; validate before upgrade, reject unknown/multiple values with
HTTP 400. Binary envelope is `HPTY`, version 1, kind, sequence u64 BE, byte cursor
u64 BE, payload length u32 BE, exact payload; output `0x01`, state `0x02`, gap
`0x03`, exit `0x04`, error `0x05`; client input `0x10`, resize `0x11`.

Stable errors: `DENIED`, `APPROVAL_REQUIRED`, `GRANT_EXPIRED`, `STALE_GENERATION`,
`STALE_SEQUENCE`, `BAD_FRAME`, `TOO_LARGE`, `TIMEOUT_LIMIT`, `UNAVAILABLE`,
`OUTPUT_LIMIT`, `OWNER_LOST`, `UNKNOWN`. `DENIED` is current Guard/policy denial;
`APPROVAL_REQUIRED` means a matching challenge/approval is absent; `GRANT_EXPIRED`
means interactive grant expired or was revoked; `STALE_GENERATION` means terminal or
artifact generation mismatch; `STALE_SEQUENCE` means stream sequence is out-of-window
or has a gap (the last acknowledged duplicate is re-acked); `BAD_FRAME` means invalid
protocol/type/length/checksum; `TOO_LARGE` means a declared byte/count bound was
exceeded; `TIMEOUT_LIMIT` means requested run timeout exceeds policy; `UNAVAILABLE`
means backend/operation unsupported or unavailable; `OUTPUT_LIMIT` means artifact
storage limit/truncation; `OWNER_LOST` means host owner epoch changed; `UNKNOWN` means
dispatch/termination outcome cannot be established. Kernel loss fences the host epoch
and requests process-tree termination; report terminated only when observed, otherwise
`UNKNOWN`/`session-lost`, and require explicit recreation. Never retry a run with
unknown dispatch. Windows V1 requires native ConPTY, named-pipe process-bound
authentication and Job Object process-tree cleanup; WSL or cross-compilation is not
acceptance.

### Linux cgroup-v2 durable cleanup

The shared ExecutionHost owns one owner-only janitor and exclusive lock for its
canonical `horizoncode-execution-v1` namespace. Cgroup creation, startup recovery,
normal terminal settlement and janitor cleanup serialize through this lock.
The janitor loads each cgroup identity from EffectHost's durable execution row,
revalidates boot/delegated-root/device/inode/path plus the exact execution, effect,
lease, principal, owner-epoch, process-generation, profile and Attempt pins, and
proves the cgroup empty. For a live, nonterminal or UNKNOWN process it first writes
`cgroup.kill`, waits for kernel `populated=0`, and durably records the quiescence
digest; this never upgrades an UNKNOWN effect to a known terminal receipt.

Linux lacks inode-targeted cgroup rmdir. Therefore name-based removal is allowed
traversal, comparing the exact device/inode, checking emptiness again and proving
no live durable execution row owns the identity. The namespace must not be visible
or writable to confined launched children or other principals. Host-derived
`cgroupHierarchyHidden` is true only for the validated confined mount view; Full
Access and unknown/legacy identities set it false. Missing authority, stale or changed
identity, lock/owner loss, malformed rows, uncertain emptiness or failed removal
quarantines and retains the cgroup. Startup recovery and bounded pre-create
maintenance use the same procedure. A temporary 256-entry admission cap remains
until durable cleanup and its race/crash acceptance are implemented. Unsupported
cgroup layouts and native Windows remain unavailable.


## 37.14 CacheObservationAdapterV1

Reports cache/local-model observations with measured/estimated/unknown provenance. Never fabricate provider cache hit or token savings.

**Context compile bridge (§30.26):** after each **SETTLED** provider request, map usage fields (`cache_read`, `cache_write`, input/output) into analytics with the same provenance rules as **`CX-013`**. If the ledger recorded `effective: cache_anchor` but usage reports no cache buckets, surface **“no observed cache”** (not a fabricated hit). Optional `measured_usage` may inform UI hints only; it never changes selected provider/model or rewrites pinned prefix bytes mid-turn.

## 37.15 Contract adoption gate

Before any service becomes WIRED:
1. find existing source seam;
2. finalize one machine schema;
3. generate/validate TypeScript + Rust where cross-process;
4. positive/malformed/version fixtures;
5. Guard/effect classification;
6. restart/cancel/UNKNOWN tests;
7. real OS/provider/backend integration where applicable;
8. performance/resource measurements;
9. 32 task/UAT case;
10. update HANDOFF status.

Research/source extraction in 42 does not skip these gates.

## 37.16 ResourceSnapshot, ProviderDoctor, FileTouch and virtual Session LLD (A-V2-30)

These are **proposed interfaces**, not existing RPC operations. Reuse the current `SessionSupervisor.Service`, Rust kernel/owner log, provider host, SessionStore, indexd and derived UI lanes. Before adding any new wire operation, define a single authoritative machine schema and versioned positive/negative fixture, map it into existing action IDs in §33 and preserve §14 Guard.

**Canonical interface details:** §37.17 owns ResourceSampler metric names/units/decimal counter types; §37.18 owns Provider Doctor, file touches, worker and UI algorithms; §37.19 owns import/SDK/steering/canary. Any earlier illustrative wire fields must be interpreted using §12.16's generated machine schema, not as competing definitions.

**ResourceSampler adapter:** owns platform-specific process-tree discovery and per-owner quota/pressure sampling. PIDs must be combined with OS process-start generation/owner lease to prevent PID-reuse attribution; detached/unowned processes are not silently claimed. Linux PSS samples may be costly: rate-limit, sample off the UI event loop, redact paths, separate local inference and cap history. Platform unsupported counters remain unknown. Worker accounting includes child trees and OS hard limits where available, with no accidental foreign process cleanup.

**VirtualSessionBroker candidate:** `attach(authPeer, sourceSession, hostEpoch, policyRevision)`, `subscribe_page/ack_page(afterCursor)`, `cancel_scope`, guarded `effect_prepare/dispatch/reconcile`, `detach`. Each virtual session has isolated principal, workspace, message/cursor, cancellation generation, owned leases, queue and credits. **No shared Guard mutation API is released** until peer auth, session confusion and crash recovery pass. A shared daemon is the candidate; existing per-session supervisors remain a functional rollback and measurable baseline.

**ProviderDoctor adapter:** `inspectOffline` no network/credentials; `probeCatalog` bounded declared endpoint discovery; `probeFull` chat+stream+tool with explicit user-approved cost ref and audit receipt. Every step returns typed error/provider/model/capability/evidence and request budget; no hidden provider switch, secret echo or stale catalog claim.

**FileTouch projection:** `recordObservedTouch`, `listForPath`, `invalidateGeneration`, `evictExpired` with strict cardinality/TTL and canonical workspace mapping. Advisory only; actual writes still require Guard, lease and source hash/version. **TaskGraph/HeadlessBroker:** Rust managed scheduler controls DAG/readiness/admission; bound worker identities and artifact refs; background clients do not own another Task or transcript. **RendererDiagnostics:** bounded redraw reason/counters and tool-tail status, no durable state writes.

These proposed signatures require schema/real-code review; do not mark them WIRED or advertise a public API from this document.

## 37.17 ResourceSamplerV1 — implementable interface and algorithms (A-V2-30)

**Boundary/placement:** `ResourceSampler` is a supervised diagnostic adapter, **not** a new authority: it reads OS counters and Rust-owned WorkerExecution/process leases; its public projections are through existing §33 action IDs and `RuntimeObservationV1`. Collector may run on the host or kernel side according to OS support, but only Rust can allocate/revoke worker capacity or authorize process termination. Never authorize from a sample.

~~~ts
type MeasurementV1 = {
  metric: "process.pss_bytes" | "process.rss_bytes" | "process.private_bytes" |
    "process.cpu_ns" | "process.fd_count" | "process.thread_count" |
    "process.count" | "memory.cache_bytes" | "memory.vram_bytes" |
    "disk.owned_bytes" | "ui.input_latency_us";
  unit: "bytes" | "nanoseconds" | "microseconds" | "count";
  valueDecimal?: string; // nonnegative integer; absent for UNKNOWN
  quality: "MEASURED" | "ESTIMATED" | "UNKNOWN";
  method: string; sourceTimestampMs: string; reason?: string;
};
type ResourceOwnerV1 = {
  principalRef: string; workspaceBinding?: string; sessionId?: string;
  runId?: string; taskId?: string; attemptId?: string;
  workerExecutionId?: string; processGeneration?: string; cacheFamily?: string;
};
type ResourceSnapshotRequestV1 = {
  scope: ResourceOwnerV1; metrics: MeasurementV1["metric"][];
  includeDescendants: boolean; maxAgeMs: number; deadlineMs: number;
};
type ResourceSnapshotResultV1 = {
  schemaVersion: 1; sampleId: string; sampledAtMs: string; os: string;
  owner: ResourceOwnerV1; measurement: MeasurementV1[];
  processCount: number; partialReasons: string[]; expiresAtMs: string;
};
interface ResourceSamplerV1 {
  sample(input: ResourceSnapshotRequestV1, auth: AuthenticatedOwnerContext): Promise<ResourceSnapshotResultV1>;
  snapshotHistory(scope: ResourceOwnerV1, cursor: string|undefined, limit: number): Promise<{samples:ResourceSnapshotResultV1[];next?:string}>;
  releaseHistory(owner: ResourceOwnerV1): Promise<void>; // derived, never OwnerLog
}
~~~

**Implementation functions and order:**
1. `resolveOwner(auth, scope)`: ignore untrusted caller-supplied principal; compare authenticated owner and resource/Session/Run ACL. Reject cross-workspace and foreign process inspection.
2. `walkOwnedProcesses(ownerLeaseSet)`: obtain OS PID + process **start identity** + lease/job/container ID, enumerate known descendants, recheck start identity before and after sampling; do not scan an arbitrary user's process tree by command-line substring.
3. `readCounters(pid, capabilityProfile)`: Linux use `smaps_rollup` PSS when permitted, `statm/status` RSS and FD/thread metrics; macOS footprint via supported task API; native Windows private/commit/working-set and Job Object process membership. Permission denied returns UNKNOWN with error reason; RSS is *not* substituted for missing PSS. Distinguish bytes from MiB (MiB = bytes / 1048576).
4. `deduplicateTree(children, processStartKey)`: visit each confirmed process once per snapshot; PSS sum only when sampling OS supports it; classify uncertain or detached descendant as partial. Report separate agent-only and declared inclusive model-runtime totals.
5. `attributeByLease(sample, ownerLogRefs)`: exclusive owner = owning lease; when a process serves multiple Sessions, keep its physical measured bytes **once** in global total and optionally allocate logical share by an explicitly ESTIMATED algorithm, never sum shared logical shares into global measured total.
6. `publishRedactedObservation(snapshot)`: bounded and rate-limited; no argv, environment, raw path, prompt or secret; carry quality/method/platform/source/age. Use same cursor/event generation as existing UI projection, no second metrics database as authority.
7. `sampleWithBudget`: initial collection interval (configurable) 2 s while resource panel open, 15 s in background, 30 s deep idle; at most 512 snapshots per owner in memory and capped derived storage by bytes/TTL. Slow `smaps_rollup` never executes on UI paint path. Under overload drop older **metric samples only**, record loss count; persist effect receipts independently.
8. `evaluatePressure` runs against known OS quotas and **configured** run/session/user capacity. Unknown capacity blocks **new costly worker admission** conservatively, not the whole user UI. Only measured + reserved resources are used in a hard admission decision, with explicit safety margin; do not turn a stale `ESTIMATED` sample into a security guarantee. Notify and queue; do not kill foreign processes.

**Control/evidence tests:** PID reuse during sampling, orphan/detached child, missing proc permission, 10/20 parallel Sessions, shared kernel double-count, macOS/Windows unsupported metrics, process exited mid-walk, local model separately owned, secret redaction, >2^53 byte counter roundtrip, slow smaps stall and snapshot eviction without losing an EffectReceipt. Refer to §18.18 for recording and §32.33 for fixtures.

## 37.18 ProviderDoctorV1, FileTouchIndexV1, HeadlessBrokerV1 and renderer algorithms

These signatures are **target contracts**. Implement each as a thin existing-owner adapter and generate canonical contracts-v2 schemas first (§12.16). Proposed source path names are placement candidates, not proof files exist.

~~~ts
type DoctorTier = "offline" | "catalog" | "full";
type DoctorProbeResultV1 = {
  phase: "config" | "auth" | "catalog" | "capability" | "stream" | "tool_call" | "cache";
  outcome: "PASS" | "FAIL" | "SKIPPED" | "UNKNOWN"; code?: string;
  elapsedMs?: number; modelRef?: string; priceSource?: string;
  credentialSource?: string; redactedDetails?: string;
};
type DoctorResultV1 = {doctorRunId:string;tier:DoctorTier;providerId:string;requestedModel?:string; probes:DoctorProbeResultV1[];actualUsageRef?:string;warning?:string};
interface ProviderDoctorV1 {
  inspectOffline(ref: ProviderSelectionRef, auth: AuthenticatedOwnerContext): Promise<DoctorResultV1>;
  probeCatalog(ref: ProviderSelectionRef, networkLease: NetworkReadGrantV1, auth: AuthenticatedOwnerContext): Promise<DoctorResultV1>;
  probeFull(ref: ProviderSelectionRef, consent: SpendApprovalRef, effectLease: CapabilityLeaseRef, auth: AuthenticatedOwnerContext): Promise<DoctorResultV1>;
}
type FileTouchRecordV1 = {workspaceBinding:string;pathRef:string;sourceGeneration:string;sourceRevision:string;sessionId:string;ownerEpoch:string;attemptId?:string;kind:"READ"|"WRITE";startMs:number;expiresMs:number;optionalRange?:{start:number;end:number}};
interface FileTouchIndexV1 {
  recordObservedTouch(input: FileTouchRecordV1, auth: AuthenticatedOwnerContext): void;
  listForPath(scope:WorkspaceScope, canonicalPathRef:string, auth: AuthenticatedOwnerContext, cursor?:string): {records:FileTouchRecordV1[];next?:string};
  invalidateGeneration(workspaceBinding:string, generation:string, auth: AuthenticatedOwnerContext): void;
  evictExpired(nowMs:number): number; // internal-only timer, not user RPC
}
interface HeadlessBrokerV1 {
  enqueue(taskId:string, expectedTaskRevision:string, budget:WorkerBudgetRef, auth: AuthenticatedOwnerContext): Promise<{queueTicket:string}>;
  reserve(ticket:string, ownerEpoch:string, auth: AuthenticatedOwnerContext): Promise<{workerExecutionId:string;leaseRef:string}>;
  attachExistingCoreClient(workerExecutionId:string, sessionLinkRef:string, auth: AuthenticatedOwnerContext): Promise<{attachmentId:string}>;
  startIsolatedWorker(workerExecutionId:string, sandboxProfile:string, effectLeaseRef:string, auth: AuthenticatedOwnerContext): Promise<{launchRef:string}>;
  settleWorker(workerExecutionId:string, evidenceRefs:string[], externalEffectRefs:string[], auth: AuthenticatedOwnerContext): Promise<{status:"SETTLED"|"UNKNOWN"|"BLOCKED"}>;
}
~~~

**Doctor algorithm:** offline resolves pinned provider/model/harness and effective config without network, secret bytes or inference. Catalog checks only consented endpoint/auth, capability hints and model IDs with explicit request/time limits, returns stale/UNKNOWN rather than guessing. Full probes selected chat+stream+structured tool call via normal transport, with explicit estimated spend cap, user approval and Guard/EffectReceipt where model inference is billable. Cancel shuts off new sends but reconciles any already billed request. Provider 429, partial stream, malformed tool, proxy route and local model load exhaustion are separate error categories; never silently try another provider. No credential or paid probe in offline tier. Cache hit is MEASURED only when provider returns authoritative counters.

**File-touch algorithm:** only trusted authenticated producer identity may insert or invalidate a record; derive `sessionId`, `ownerEpoch`, workspace binding and source generation from trusted observation or cross-check them against `auth` rather than accepting submitted values as owner proof. Bind list queries to the caller's allowed scope and reject foreign workspace/cursor. Normalize workspace through a trusted root handle; canonicalize path on same platform with symlink/reparse policy, owner epoch and source revision; store reverse indexes `byPath` and `bySession` with bounded count/bytes/TTL, evict atomically from both. Treat touch event as advisory and optionally incomplete; absent touch record **cannot** authorize a write. Notify overlapping writes and stale edits; final Guard write always compares target handle, revision digest and lease. Never infer a mutable file from a read-only overlap. Session close evicts only derived touch records.

**Headless broker algorithm:** `AuthenticatedOwnerContext` is created by a verified trusted ingress/lease authority, never from a worker's own asserted ID. `enqueue` checks accepted SpecVersion and Task revision; `reserve` atomically checks owner epoch, admission and resource/workspace leases; attach/start/settle each recheck worker principal, Task/Attempt and cancellation fence. A queue ticket, supplied `ownerEpoch`, `WorkerBudgetRef` or `effectLeaseRef` is not by itself authorization. Rust scheduler alone evaluates dependency readiness and reserves exclusive worker capacity. Warm reuse requires identical principal, workspace binding, trust/sandbox guarantee, provider/harness selection, environment hash, policy epoch and clean resource state; sanitize secrets/stdio/cancel state before reassigning, else dispose **owned** worker and spawn isolated new one. Read-only exploration attaches to Core without a new transcript/worktree; effects require an independently authorized process/lease. Worker completion supplies *candidate* evidence and typed artifact refs; only trusted verifier can mark Task PASSED. On crash, expire current epoch, mark uncertain external effects UNKNOWN, reconcile before reassignment and quarantine dirty workspace. Parent cancellation fences queued tickets, then active workers, without assuming already-dispatched effects rolled back.

**Renderer update algorithm:** accept canonical event identity+source generation into bounded per-Session queue; stable committed prefix is immutable, live tool-tail has byte/line cap and is replaceable; coalesce only UI paint deltas, never receipts/approval/cancel. Maintain `dirtyRegion`, resize/theme generation, queued focus/scroll ownership; request immediate redraw for input, explicit deep-idle backoff for animations. Count repaint reason and render queue drops; persist full tool logs as artifact refs with canonical wire fidelity `full`/`head_tail_sample`/`failed` and UI-only FULL/SAMPLE/FAILED labels. On reconnect reconstruct from canonical parts plus event cursor, never from ephemeral tail cache.

**Error/failure contract:** use canonical §12 `ErrorV1` code registry, not ad-hoc error strings. Before registering new names, map to existing stable codes (e.g. CONFLICT for a reused idempotency key), update schema/tests together and reject unknown error codes. Operational categories: `UNAVAILABLE` (unsupported platform/feature); `DENIED` (scope/policy); `STALE` (revision/epoch/cursor); `RESOURCE_BLOCKED` (bounded queue/capacity); `RECONCILING_UNKNOWN` (potentially executed effect); `PROVIDER_COST_APPROVAL_REQUIRED` (full Doctor); `PARTIAL_OBSERVATION` (measurement missing). These labels are **semantic categories**, not newly registered error-code enumerants. Every result includes typed category, retry class, origin, support status and redacted evidence ref.

## 37.19 Multi-client SDK, source import/resume and opt-in developer service algorithms

These are **proposed adapters** over the existing public Session/API plus Rust managed control and existing provider transport; do not create a new conversation, Task, Guard, SecretBroker or command catalog. Under A-V2-31, V1 SDK/client scope is CLI/TUI only. Web/desktop/mobile clients, remote/cloud continuation and externally hosted clients are post-V1 and unavailable; their type entries below preserve future contract design, not V1 support.

~~~ts
type SessionOriginV1 = {source:"HORIZON"|"OPENCODE"|"CODEX"|"CLAUDE"|"PI"|"OTHER"; sourceVersion?:string; sourceSessionRef:string; importTimeMs?:string};
type ImportPreviewV1 = {
  previewId:string; source:SessionOriginV1; availableParts:number;
  originalOwner:string; formatVersion:string; omittedFields:string[];
  warnings:string[]; containsSecrets:boolean; sourceDigest:string;
};
type ImportDecisionV1 = {
  previewId:string; expectedSourceDigest:string; destinationBackend:string;
  mode:"HISTORICAL_SNAPSHOT"|"NATIVE_RESUME"; userApprovalRef:string;
};
type ClientAttachmentV1 = {
  attachmentId:string; canonicalSessionId:string; principalRef:string;
  clientType:"TUI"|"CLI"|"DESKTOP"|"WEB"|"SDK"|"MOBILE";
  ownerEpoch:string; eventCursor:string; readOnly:boolean;
};
type SteeringRequestV1 = {sessionId:string;expectedTurnEpoch:string;intent:"NEXT_TURN"|"CANCEL_AND_REPLACE"|"QUEUE";contentRef:string;idempotencyKey:string};
~~~

**Session import:** 
1. `detectSources` enumerates supported source stores without reading arbitrary home-directory files or exporting credentials; unsupported format is UNAVAILABLE, not lossy silent import.
2. `previewImport` validates structural version, bounded byte/part count, redacts token/keys and prompt-injection-bearing metadata, returns source digest and exact known field loss. Parsing is untrusted data; never run imported tool commands, install plugins or replay effects from source history.
3. `commitImport` revalidates source digest/ACL/user approval/backend choice; for HISTORICAL_SNAPSHOT creates a new canonical Horizon-owned Session with immutable provenance and clearly historic tool parts; for NATIVE_RESUME binds to the selected external owner without duplicating its message writer. A backend-specific importer must not claim capability support or transfer credential identities by inference.
4. Concurrent import with same idempotency key is once-only; changed source/destination causes CONFLICT. If source changes after preview, require a new preview; if source cannot be completely parsed, return typed partial/unavailable rather than silently dropping user conversations.
5. `detachExternalSession` invalidates ClientAttachment and controlled SessionLink observation, not the external backend's unrelated processes; final import acceptance verifies owner, message count/hash lineage, secrets and CLI/TUI presentation.

**Public multi-client SDK:** versioned authenticated read/control API projects existing Session messages/events, resource diagnostics and managed Run state. `attachClient(auth,session,afterCursor) → attachment+capabilities`; `subscribe/ack/replay` follow §13 and retain exact immutable source generation; `sendUserInput/steer/cancel` are user-origin actions with expected turn epoch and idempotency, not raw effect leases. Distinguish several viewing clients from the *one Session conversation writer/continuation owner*: input serialization ensures two clients cannot race to produce contradictory turns. A disconnected SDK cannot mark a Run cancelled unless its authorised control request committed; offline buffering is bounded and requires revalidation on reconnect.

**Steering semantics:** NEXT_TURN queues an owned user message for after current settled provider step; QUEUE appends with stable FIFO/idempotency; CANCEL_AND_REPLACE first requests bounded fence, waits for current tool effects to settle or reports UNKNOWN, then creates a new turn epoch. A TUI keybinding or tmux paste is just a UI input mapping to the same API; terminal control sequences are sanitized. Untrusted model text cannot steer another Session, and current active effect arguments cannot be mutated after PREPARED.

**Thin mobile/remote client:** a supported remote transport requires explicit user opt-in, authenticated TLS endpoint, per-user/session grants, nonce/replay/CSRF protections according to transport, bounded event replay and secret-free capability projection. No public Rust kernel socket, direct process lease API or credentials export. Unsupported remote hosting remains UNAVAILABLE, not a localhost listener exposed to the internet. Mobile is a client of existing SDK/API, not its own agent engine. Test network disconnect, revoked device, hostile event payload and concurrent desktop/mobile steering.

**Developer self-code canary:** behind §17 A-V2-29 Experimental OFF by default, accept a reviewed candidate diff/spec only in a disposable isolated worktree; build/test/lint and signed/hash-attested artifact; measure resource/build outputs, require user approval and reversible activation point; drain old in-flight effects, rotate owner/process epoch, preserve canonical stores, run canary fixture with explicit acceptance, and rollback on failure. Never hot-swap Rust security/policy/guard code during active uncertain effects or let a model self-approve broad privileges. Build cache/worker cleanup uses ownership rules (§18.19). This is separately gated post-V1 work; defining it here does not make it available.

**Cross-cutting error classes:** unsupported backend/version, malformed source, permission denied, stale preview/turn epoch, dual-writer conflict, client disconnected, approval missing, unconfirmed effects and canary rollback failure must each preserve a typed redacted outcome and never fabricate historical tool success.

## 37.20 External agent ACP adapter — source-bound client/service LLD

This is **PROPOSED** HorizonCode interoperability work, not an implemented external-agent client. The pinned OpenCode source at `opencode/packages/opencode/src/acp/{service,session,permission,event}.ts` and `cli/cmd/acp.ts` implements an **agent-side ACP server**; it is not evidence that HorizonCode can act as an ACP **client** controlling arbitrary external agents. The `AgentProfileV2.adapter.kind = "acp"` and the optional native OpenCode backend are accepted product integration seams (§29/§17). Do not create an additional direct Session authority.

**Implementation status (2026-10-18):** this remains the retained plan for the post-V1 journey. The 2026-10-16 V1 scope decision defers external ACP client integration (with visual source-edit and deployment) out of V1; tests ACP-001..008 in §32.35 stay the acceptance target for promotion. Editor-integration breadth beyond the CLI/TUI is gated by `DEC-V1-24`.

~~~ts
type ExternalAgentAdapterV1 = {
  adapterId: string; kind: "acp"|"cli"|"container"|"remote";
  executableDigest?: string; protocolVersion: string; supportedFeatures: string[];
  sandboxProfile: string; sourceVersion: string; status: "AVAILABLE"|"UNAVAILABLE";
};
type ExternalAgentSessionLinkV1 = {
  adapterId: string; backendSessionRef: string; horizonSessionLinkRef: string;
  ownerEpoch: string; workspaceBinding: string; principalScopeDigest: string;
  selectedProviderModelRef?: string; sourceCursor?: string;
};
type ExternalAgentDeliveryV1 = {
  dispatchId: string; parentTaskId?: string; workerExecutionId: string;
  adapterSessionRef: string; status: "RETURNED"|"FAILED"|"CANCELLED"|"UNKNOWN";
  textArtifactRef?: string; typedArtifactRefs: string[]; effectReceiptRefs: string[];
  observedSourceRevision?: string; boundedWarnings: string[];
};
interface ExternalAgentClientAdapterV1 {
  discover(ref: string, deadlineMs: number): Promise<ExternalAgentAdapterV1>;
  initialize(ref: string, authScopeRef: string): Promise<{negotiatedVersion:string;capabilityDigest:string}>;
  startOrAttach(input: {profileRef:string;workspaceBinding:string;parentGrantRef:string;ownerEpoch:string;resumeRef?:string}): Promise<ExternalAgentSessionLinkV1>;
  sendTask(input: {link:ExternalAgentSessionLinkV1;requestRef:string;idempotencyKey:string;deadlineMs:number}): Promise<{dispatchId:string}>;
  receiveBounded(link: ExternalAgentSessionLinkV1, cursor?:string): Promise<{eventsRef:string;nextCursor?:string;hasMore:boolean}>;
  cancelOrDetach(link:ExternalAgentSessionLinkV1, reason:string): Promise<{settlement:"CANCELLED"|"STILL_RUNNING"|"UNKNOWN"}>;
  reconcile(dispatchId:string): Promise<ExternalAgentDeliveryV1>;
}
~~~

**Protocol and authority:** the ACP client handles initialize/version negotiation, optional auth/config, new/load/resume session, prompt, permitted streaming updates, cancellation and close; each message is size/time bounded and associated with the authenticated backend owner. ACP protocol compatibility **does not grant filesystem/network/process authority**. Launch of local external agent binary is a Rust Guarded effect through ExecutionHost with OS profile and process identity; any external agent capability that can mutate outside HorizonCode's pre-dispatch Guard must be restricted to trusted separately owned native mode with a clear weaker-safety label, or disabled in governed mode. An MCP server furnished by the remote ACP agent is untrusted data, not an implicit local MCP installation.

**Parent/child transfer:** bind exact parent Run/Task/Attempt, accepted SpecVersion digest, workspace/base revision, provider/harness selection, capability intersection, spend/token/deadline budget, source cursor and approved output schema. Use existing `SubagentDeliveryV1`/typed artifact/evidence refs (§29.18), not another Task database. External agent "done" is candidate evidence; trusted Horizon verifier owns PASS. The native OpenCode adapter stays the separately authorized backend's conversation writer; an ACP child in Horizon direct mode is a delegated worker, never a second writer to the same Session.

**Failure cases:** handle protocol mismatch, auth challenge, provider restriction, disabled mode, byte/rate flood, malformed ACP part, duplicate/late update, crashed child, host restart, cancellation racing with remote action, hidden outbound connector, stale workspace, unexplained cost and orphaned backend session. Preserve UNKNOWN for any unobservable side effect. Fail closed on unsupported permission mediation, maintain bounded buffers and redacted telemetry, and do not silently switch agent/provider.

## 37.21 Visual source selection and deployment verification LLD

These two flows already exist normatively in §§3.17–3.18; this section **fills their missing service contract**. It does not declare new deployed functionality or grant an unrestricted cloud credential.

~~~ts
type VisualTargetObservationV1 = {
  previewId:string; pageUrlRef:string; browserGeneration:string;
  nodeRef:string; boundingBox?:{x:number;y:number;width:number;height:number};
  accessibilityName?:string; sourceCandidates:{pathRef:string;lineStart?:number;
    lineEnd?:number;sourceDigest:string;confidence:"EXACT"|"HEURISTIC"|"UNKNOWN"}[];
  sourceMapDigest?:string; assetBuildRevision:string;
};
type DeploymentPlanV1 = {
  planId:string; workspaceRevision:string; targetId:string;
  accountRef:string; environment:"LOCAL"|"PREVIEW"|"STAGING"|"PRODUCTION";
  artifactDigest:string; manifestRef:string; externalEffects:string[];
  estimatedCostClass:"FREE"|"PAID"|"UNKNOWN"; requiredSecretRefs:string[];
  requestedCapabilities:string[]; rollbackTargetRef?:string;
};
type DeploymentReceiptV1 = {
  deploymentId:string; targetId:string; artifactDigest:string;
  externalOperationRef?:string; observedUrlRef?:string; revisionRef?:string;
  state:"PREPARED"|"DISPATCHED"|"OBSERVED"|"VERIFIED"|"FAILED"|"UNKNOWN";
  effectReceiptRefs:string[]; healthEvidenceRefs:string[]; rollbackRef?:string;
};
interface VisualSourceMapAdapterV1 {
  observe(previewId:string,auth:AuthenticatedOwnerContext):Promise<VisualTargetObservationV1[]>;
  candidates(nodeRef:string,expectedBrowserGeneration:string,limit:number):Promise<VisualTargetObservationV1>;
  requestGuardedEdit(candidateRef:string,expectedSourceDigest:string,patchRef:string):Promise<{effectId:string}>;
}
interface DeploymentAdapterV1 {
  inspectTargets(scopeRef:string):Promise<{targetsRef:string;providerProvenance:string}>;
  prepare(plan:DeploymentPlanV1):Promise<{normalizedPlanDigest:string;requiredApprovals:string[]}>;
  apply(planId:string,consentRef:string,effectLeaseRef:string):Promise<DeploymentReceiptV1>;
  verify(deploymentId:string,checksRef:string,deadlineMs:number):Promise<DeploymentReceiptV1>;
  reconcile(deploymentId:string):Promise<DeploymentReceiptV1>;
  rollback(deploymentId:string,approvalRef:string,effectLeaseRef:string):Promise<DeploymentReceiptV1>;
}
~~~

**Visual flow:** start/observe approved local preview and record browser/DOM/AX generation + app build revision; user selects a bounded element reference. Resolve source-map candidates with file hashes, confidence and build timestamp. Ambiguous/no map returns UNKNOWN with candidate explanation; never guess an edit target from a pixel alone. A user-reviewed patch is applied via canonical `files.patch`/`files.write` under Rust Guard/expected digest and workspace lease; rebuild, recapture and compare user-visible result/test evidence. Race with hot reload, tab navigation, symlinked source, untrusted DOM/remote URL or stale line map invalidates the selection. Source maps and DOM text are untrusted.

**Deployment flow:** select explicit target/account/environment; run read-only discovery without using secrets in the model prompt; prepare exact artifact/revision/config/secret scopes and estimated cost; obtain separately bound approval for potentially costly or public external side effects. Guard PREPARE and one-use lease **before** upload, config change, secret use or remote command. Save external idempotency token if provided and bounded logs/artifact receipts, then health/critical-route verification against target revision and accepted criteria. Build success or HTTP 200 on upload is **not** deployment VERIFIED. Remote effect after network timeout is UNKNOWN and must be reconciled with provider state before replay; rollback is a new approved Guarded effect with independent receipt/verification, never assumed safe. Production access and unimplemented adapters remain UNAVAILABLE rather than silently inferred from a generic shell command.

**Tests:** stale DOM/AX generation, source-map mismatch, wrong repo file, malicious markup, patch racing user edit, preview process leak, deployment credential redaction, wrong account/environment, failed upload after remote success, health mismatch, approval revoked, spending denied, canary URL expires, remote duplicate deployment ID, rollback fails and final revision verification. §32.35 defines traceability.

## 37.22 Managed delegation and RepoIntel query boundaries (A-V2-33)

This section refines existing Rust managed control, Guard/ExecutionHost and RepoIntel owners; it creates no second broker/runtime. Managed dispatch uses a Rust-minted §12.18 `DelegationBindingV1` after live Attempt admission. `dispatch` consumes only the opaque binding and bounded context/artifact references. Each child operation resolves current Attempt, owner epoch, accepted criteria, capability ceiling, workspace/source revision and budget; stale or revoked state denies before effect dispatch. `cancel` fences new operations and records unresolved effects as UNKNOWN. `reconcile` accepts only owner-observed receipt/target evidence and never replays non-idempotent UNKNOWN work.

The managed lifecycle requires a distinct authenticated `goal.start` after the SpecVersion
has been accepted and a bounded plan has been recorded. `goal.plan` remains effect-free and
records the exact Run plus profile-pinned dependency Tasks as `PLANNED`, all unready and
non-dispatchable. `goal.start` takes only the expected Goal revision, existing Run ID,
accepted SpecVersion reference/digest and idempotency key; actor identity is derived from
authenticated ingress. Rust validates that the entire persisted plan is complete and unchanged, recomputes its
canonical Task-set digest and records it in the start event, then atomically transitions the Run to `RUNNING` and marks only dependency-ready root Tasks
ready. Downstream Tasks remain unready until their predecessors settle successfully. The start
body cannot supply or alter Task/profile data. Exact retries return the same transition,
mismatched idempotency reuse conflicts, and stale/unauthorized/superseded/incomplete state
rejects without readiness changes. This creates no Attempt or effect lease; later
Task/Attempt/resource admission and Guarded effect dispatch remain separate.
After the authenticated root-coordinator registration, the `goal.start` Core adapter may call
the Rust-selected scheduler/TaskTool path. `HORIZONCODE_MANAGED_TASK_DISPATCH` defaults false;
keep it false until P1 Guard and P8 admission/settlement acceptance pass. When disabled, start
still reports `dispatchStatus: DISABLED` and performs no Attempt admission or provider call.
When enabled, the response reports `NO_TASK`, `PROMPT_RETURNED`,
`PROMPT_RETURNED_ERROR`, `PROMPT_UNKNOWN`, or `UNAVAILABLE`; these statuses do not
represent verification or terminal settlement. `PROMPT_UNKNOWN` means a consumed child
Attempt may have crossed provider dispatch but its exact durable return/quiescence proof
cannot be recovered. It is fenced against prompt replay and requires owner reconciliation;
it must not be shown as success, failure, or an automatic retry. The later
authenticated verifier route must bind its durable verdict/evidence/current revision and settle
the same P8 child lease before capacity is released.

Each managed provider request has a request-bound ContextSelection. Admission pins sequence
1; before every subsequent model request, Core compiles the exact next model-visible source
set and calls `managed_context.advance` with the live Attempt scope, exact child Session,
next sequence (bounded to 2–1024), request ID and ContextSelection. HostKernel verifies the
same Attempt/profile/owner epoch/current revision, persists the ref-only selection, and
returns its canonical digest receipt. Exact retries replay; gaps, conflicts, stale or terminal
authority reject before provider dispatch. The child Session ID must match the Attempt's
actual prompt/transcript owner; the parent Session ID remains a separate lineage field. Core
must pass the exact immutable prompt compiled for that selection and its returned digest to
the provider adapter. A prior Attempt-level digest cannot stand in for later prompts after
tool outputs or history change. This operation grants no effect authority and cannot widen
the bound capability set. P1 owns HostKernel/protocol/schema, P2 the managed-control adapter,
and P7 the provider pre-dispatch compiler seam; all managed prompt dispatch remains disabled
until the complete chain is source-wired and subsequently accepted.

The first provider request has the same freeze-before-dispatch rule. The target and exact
ContextSelection have a two-stage pre-admission handoff because Core must compile against the
reserved child worktree, while the P8 reservation must ultimately bind the compiled selection.
First, authenticated HostKernel operation `managed.pre_admission_target.reserve` selects the
exact READY Task/candidate and asks P8 to reserve a child target against all facts already known
before prompt compilation: accepted Goal/Run/Spec/Task revisions, Task-pinned profile definition
and permission ceiling, capability ceiling, authenticated parent/root proof, workspace and
resource policy, owner epoch, and stable candidate/idempotency identity. This reservation is
explicitly context-unbound and grants no Attempt, claim, effect, or provider authority. P8 returns
the target only from this exact opaque RESERVED proof; Core cannot derive it from the parent root
or `workspaceRef`. Stage A carries no placeholder or synthetic ContextSelection/digest; the private
P8 staged-pin constructor must represent the absent context explicitly.

The reserve request is `{goalID,runID,taskID,expectedRevision,parentSessionID,locationID,sessionID,
profileDefinition}`. Optional resource-policy revision/digest values are compare-only against the
authoritative P8 policy. HostKernel derives candidate Attempt/idempotency identity from live Rust
Task counters. The unbound response includes `candidateAttemptID`, `taskRevision`, opaque P8 proof
`{proofDigest,leaseProofDigest,pinsDigest,ownerLogID,ownerLogSequence,ownerLogEventDigest,ownerEpoch,
workerPoolRevision,workerExecutionID,ticketID}`, and `preAdmissionTarget`. Stage-A `proofDigest`
is the stable context-free candidate receipt. An exact reserve retry after Stage B committed returns
`RESERVED_CONTEXT_BOUND`, the saved `contextSelectionDigest`, and bound proof fields
`{proofDigest,receiptDigest,leaseProofDigest,...commonPins}`: `proofDigest` remains the Stage-A
identity, `receiptDigest` is the stable Stage-B ContextSelection receipt, and `leaseProofDigest`
plus OwnerLog cursor/pool fields are refreshed current P8 state. This recovers a lost bind response
without allowing Core to replace the saved context. Bind request adds the Stage-A
`preAdmissionProofDigest` and exact `contextSelection`; its response returns the canonical
ContextSelection digest and the same bound proof tuple. Core supplies the Stage-B stable
`receiptDigest` as the admit `preAdmissionProofDigest`; HostKernel compares that replay identity,
then independently resolves and validates the current cursor-bound lease proof before admission.
Core-supplied candidate IDs, idempotency keys, deadlines, resource ceilings, and permission facts
are never authority.

Core then prepares the candidate child Session and exact provider-visible request on that target
without dispatch, and compiles sequence-1 `ContextSelectionV1`. Authenticated HostKernel operation
`managed.pre_admission_target.bind_context` validates the complete selection against the same
live Task/profile/owner facts and immutably appends P8's `PreAdmissionContextBound` OwnerLog event
for the canonical digest on the still-RESERVED lease. Exact retries return the same receipt; a
different selection, stale pin, or replay under a different candidate conflicts. Attempt admission
consumes this already-bound reservation and
attaches the exact `DelegationBindingV1`; it must not create a second reservation. Core then passes
the same opaque immutable prepared request through admission, claim, and consume to the provider
adapter. Rebuilding prompt/tool/system inputs after binding is not equivalent to dispatching the
admitted selection. A crash between reserve and bind leaves only a context-unbound, non-dispatchable
reservation that can be resumed for the same candidate or reconciled through P8; after bind,
recovery must reproduce the exact saved selection and digest. Until both stages and the shared
no-dispatch preflight are wired, no managed provider request is eligible for dispatch.
Subsequent selection changes append
`managed_context_advanced` to the same managed OwnerLog and retain the bounded reference-only
selection, request identity, canonical digest and resulting revision for replay/recovery; they
do not create a parallel context registry or transcript.

An `ADMITTED` Attempt recovered after restart but before dispatch consumption is not permission
to rebuild the initial prompt. HostKernel must return its persisted sequence-1 reference-only
ContextSelection with the live Attempt scope. Core re-prepares without dispatch on the exact
reserved target, compares the full compiled DTO and digest pins to that saved selection, and
only then may it claim and consume the existing handoff. If the persisted selection, source
revision, idempotent child staging, or prepared request cannot be recovered exactly, the
Attempt remains unconsumed and dispatch returns unavailable; it must not reconstruct or guess.
For sequence 2 and later, a persisted context-selection receipt alone is not proof that the
provider request did or did not start. Recovery must not replay such a request from that event
alone; absent a distinct durable provider-dispatch outcome, it remains UNKNOWN/unavailable for
owner reconciliation.

Every managed model request, including sequence 1, also has a durable provider-request
lifecycle in that same OwnerLog. After admission/context advance and before any provider bytes
may be sent, `managed_provider.prepare` binds the live Attempt scope, owner epoch and child
Session to request ID/sequence, ContextSelection digest, exact provider ID, model ID, selected
harness/route/endpoint revision, opaque SecretBroker `SecretRef`, HostKernel-created Guard challenge ID,
capability-lease digest, BLAKE3 digest of the normalized provider input (`requestDigest`),
digest of the exact non-secret SDK transport request (`transportRequestDigest`), and the
separate SecretBroker operation digest (`operationDigest`). `transportRequestDigest` covers
method, canonical destination, non-credential headers, body and credential-header profile
together with provider/model/harness/route and endpoint revision. These are
non-secret references; this `SecretRef` is not a one-use credential lease. Rust validates its
provider/version metadata and derives/consumes the one-use SecretBroker use lease internally at
the guarded dispatch boundary. Credential bytes, one-use lease tokens and endpoint URLs never
enter the OwnerLog or cross the HostKernel/Core boundary. Exact retries
may return the same PREPARED reference only when all pins match; mismatch conflicts. The
HostKernel rechecks the route/model/harness allowlist, per-request Guard approval bound
to the exact route and billing pins, current token and cost ceilings, and current owner before
issuing that ref. This Guard challenge is explicit consent for one inference; no caller consent
reference or persistent inference-route enable setting is accepted. A different route or model
is never an implicit fallback.

Immediately before network dispatch, Core consumes that one-use ref with
`managed_provider.begin`. HostKernel durably records DISPATCHING before returning send
authority and performs the live Attempt/owner/Guard/budget recheck at that boundary. Only this
transition permits the provider adapter to send the exact prepared input to the exact selected
route. All three digests are bound to the same request ID/sequence, ContextSelection digest,
selected route, live Attempt and owner epoch. The first begin atomically consumes its one-use
permit and returns an opaque send authorization consumed only inside the existing Auth/Provider
callback; Auth derives `TrustedSecretUseContext` from that authorization, never caller fields.
A replay returns no send authorization. The callback revalidates the frozen normalized input
and exact SDK transport digests, then consumes the SecretBroker lease using the independently
pinned operation digest and sends once. After the assistant response is durably appended to the child Session, Core calls
`managed_provider.settle` with the exact ref, response entry ID/digest, provider operation ID,
and reported usage, before any ToolBatch effect or following provider dispatch can proceed.
Each actual provider dispatch has its own monotonically increasing Attempt request sequence and
providerRequestID, including multiple SDK steps that update one assistant message. HostKernel
OwnerLog identity is unique per providerRequestID/sequence, not merely per assistant message.
SETTLED is idempotently replayable only for identical facts. Response content remains in the
canonical child transcript, not the OwnerLog. A missing step snapshot or settlement after
DISPATCHING is UNKNOWN; startup/restart converts unresolved DISPATCHING to UNKNOWN and never
retries. PREPARED without begin is safe to abandon. These transitions do not create a second
scheduler, transcript or usage authority; the existing Usage receipt chain still accounts each
settled response. No following managed provider dispatch may proceed until the prior dispatch
has a known settlement.

**Canonical provider response receipt:** `responseDigest` is BLAKE3 over a canonical MessagePack
payload `{assistantInfo,stepFinishPart,stepFinishIndex}` prefixed by
`horizoncode.managed-provider-response-step.v2\0`. `assistantInfo` is the exact strict
schema-decoded persisted V1 Assistant info. `stepFinishPart` is the first-party strict
`ManagedProviderStepFinishV1` projection of the persisted `step-finish` part, including its
persisted `stepFinishIndex` and exact `UsageProvenance`; the index is also repeated at payload
top level and must agree. The inherited
OpenCode `StepFinishPart` schema does not define the latter two fields; HorizonCode must validate
them through its own versioned projection without rewriting the pinned upstream schema. It is a
point-in-time durable snapshot committed after that step finishes; later parts appended
to the same Assistant message do not change the historical snapshot. Core computes it only
after the step and snapshot are durably persisted; it is never computed from stream chunks or
reconstructed response text. HostKernel binds the authenticated Core receipt's entry ID and
digest to the live DISPATCHING request and stores only receipt digests in OwnerLog.
`usageDigest` remains separate: §12's managed usage receipt is
`BLAKE3("horizoncode.managed-provider-usage.v1\0" || canonical-json({attemptID,
assistantMessageID,stepFinishIndex,usageProvenance}))`. The two digests cannot substitute for
each other.

Each settlement also pins its explicit `stepFinishIndex`; HostKernel stores and echoes that
index through inspect/recovery and rejects an index that differs from the prepared request.
The persisted assistant snapshot may contain pending calls emitted by that exact provider step;
unresolved calls from earlier or unrelated work invalidate the snapshot. Core settles each
dispatch before any associated ToolBatch reaches Guard and before the next provider dispatch.
Request settlement is not turn completion: a SETTLED response may contain tool calls and
continue the same provider turn. At the processor's persisted final-assistant boundary (latest
assistant entry belongs to the current user message, has a final finish reason, and has no tool
calls), Core calls `managed_provider.complete_turn` with the exact current ManagedAttemptScope
and providerRequestID, assistantEntryID, responseDigest and usageDigest retained from the
HostKernel SETTLED receipt. HostKernel resolves the ordered SETTLED dispatch rows itself from
the sequence after the preceding completed turn through the final request sequence, rejects
gaps and any PREPARED/DISPATCHING/UNKNOWN row, and returns a BLAKE3
`dispatchSettlementDigest` over the ordered request/response/usage receipts. Core cannot submit
or choose the dispatch list. HostKernel also requires exact final request/selection/response/usage equality,
a live EXECUTING Attempt, and no unresolved or UNKNOWN effect receipt. It
persists `managed_provider_turn_completed` in the Attempt-keyed durable control journal and
returns an idempotent completionReceiptDigest. Exact retry returns REPLAY only for the same
Attempt, owner epoch, request sequence and response pins. Following Core restart, the exact
settlement is rehydrated through authenticated `managed_provider.inspect_settlement`; response
and usage digests are never rebuilt from transcript text. A stale owner epoch, unresolved request
or missing settlement stays unavailable/UNKNOWN.

Managed follow_up requires a distinct one-use wake consume bound to that completion receipt,
the exact committed message ID/payload digest and mailbox sequence, and the next provider request
sequence. It is not the direct lane's DirectTurnScope/FreshTurnAuthorization. The queue path
never invokes this consume and never wakes a child. The coordinator now compiles the exact
follow-up prompt and ContextSelection without dispatch, claims the one-use HostKernel wake,
advances the durable managed request, and injects a pre-dispatch recovery callback. That callback
reconciles only the exact committed inbox row and persisted Host ACK; missing, stale, conflicting
or UNKNOWN evidence blocks provider dispatch. The managed follow-up dispatch gate remains false
until this source path is integrated and accepted. Strict request/reply fields are specified in
`contracts-v2/managed-provider-turn-v1.schema.json` and source DTOs in
`kernel/src/protocol.rs` / `packages/opencode/src/session/managed-control.ts`.

**P2 managed follow-up source correction (2026-10-21; source-only, not acceptance evidence):** the canonical
Core managed Attempt scope now includes the immutable BLAKE3 `permissionScopeDigest` from the
HostKernel DelegationBindingV1, and Core's identity-transition comparisons retain that pin across
provider, context-advance, consumption and wake-claim receipts. `workspaceRevision` is decoded as
the exact BLAKE3 live-workspace digest. The authenticated HTTP message route accepts managed
`follow_up` through the shared Guard admission and durable inbox path: it requires the latest
completed assistant entry, obtains its HostKernel completion receipt, persists that proof before
OwnerLog commit, then records and returns the exact scheduled wake/next-sequence pins. Queue still
has no completion/wake fields. `managed_context.advance`, one-use HostKernel wake-claim APIs,
the Core no-dispatch ContextSelection compiler, and managed pre-provider-dispatch recovery callback
are source-present. Provider transport also remains unavailable until P1's Guarded
dispatch/settlement and P6's exact transport/SecretBroker authorization are wired. Do not report
managed follow-up as enabled or accepted from these source seams.

**P2 restart-boundary source update (2026-10-21; not acceptance evidence):** the managed Task
adapter injects `ManagedPreDispatchRecoveryV1` only into the authenticated managed child prompt.
Immediately before each managed provider call, it inspects the current Session's managed inbox
for the unique follow_up whose persisted claim request ID and next sequence match the live
Attempt scope. For a `delivering` row it commits the exact prompt-message consumption proof;
for an already `consumed` row it reuses the stored proof. Both paths revalidate payload, prompt
ID, inbox/wake/claim receipts, delivery and current scope digests, then idempotently recover the
HostKernel ACK and persist its receipt before provider dispatch. Missing, stale, conflicting,
duplicate or UNKNOWN state raises before `handle.process`; queue rows are never selected. This
source does not establish behavior under process crash until the accepted restart journey runs.

**Current implementation gate:** Rust OwnerLog has the provider-request record, event parser,
reducer, and strict `managed_provider.*` HostKernel operation DTOs. P1 has supplied the
`providers.infer` EffectHost prepare/authorize/consume/settle/recovery APIs and a separate
EffectHost resolver that revalidates the exact provider binding before recording the
authenticated allow/deny. TUI parsing and allow eligibility now accept only the dedicated
`host.managed_provider` source with the canonical provider guarantee list and zero residual
guarantees. HostKernel has not integrated these APIs or emitted that provider-specific
approval projection; its current managed-run projection remains verifier-only. Prepare and begin echo the
exact route/request pins and unchanged managed revision in their `UNAVAILABLE` projections;
begin accepts the same strict pins and always returns null send authorization. The required
`credentialLeaseRef` DTO field is nullable for the P6 anonymous-route projection. Core emits
null only when its canonical active-provider registry independently proves the exact selected
OpenCode model is active, explicitly zero-priced across all published price fields, and
credential-free. HostKernel pins that six-field projection in the immutable Attempt binding
at admission and compares it at prepare/begin; no second route registry is introduced. The
Guard challenge and one-use lease are HostKernel-created per request and bind route, endpoint,
request digests, Attempt and budget. The OwnerLog stores immutable challenge/effect identity,
lease and final EffectHost binding digest, never the raw send authorization. Fresh begin returns
the effect identity and binding digest with the one-use authorization and Host-authored
SecretBroker context; replay returns no authority. Until the exact P1 approval/dispatch adapter,
P6 Auth consume/transport, persisted step-finish receipt and UNKNOWN recovery are all wired,
provider sends remain unavailable. Caller response fields cannot manufacture settlement.

**P6 dual-digest source checkpoint (2026-10-21; source-only):** Core prepares the exact SDK
transport request without sending it and computes `transportRequestDigest` plus the separate
SecretBroker `operationDigest`; the ContextSelection path computes normalized `requestDigest`.
The Core/Rust request pins and OwnerLog retain all three digests. P2 HostKernel dispatch stays
gated until it integrates P1's HostKernel-created Guard challenge/lease and EffectHost one-use
send authorization with exact OwnerLog DISPATCHING, settle and UNKNOWN transitions. Neither
digest persistence nor a provider projection alone authorizes outbound requests.

The exact RPC operations are `managed.v1/managed.pre_admission_target.reserve` and
`managed.v1/managed.pre_admission_target.bind_context`; both require authenticated ServerAuth
whose subject owns the registered Goal Location. `reserve` accepts the exact `goalID`, `runID`,
`taskID`, `expectedRevision`, `parentSessionID`, `locationID`, `sessionID`, and validated
`profileDefinition`. Optional `resourcePolicyProjectionRevision` and
`resourcePolicyProjectionDigest` are compare-only expectations; HostKernel independently resolves
the current owner-scoped policy and rejects mismatch. Core cannot supply Attempt ID, Task
generation/count, P8 idempotency key, root proof, worktree, deadline, lease, or authority digest.
HostKernel derives the exact READY candidate from the Rust-owned Task count/generation. Its stable
P8 idempotency key is a domain-separated BLAKE3 digest over Goal/Run/Task/candidate IDs; retries
cannot choose another key. HostKernel obtains the profile, capability, permission, workspace,
resource, deadline, parent/root, and worktree pins from their trusted owners. Stage A returns
`{status:"RESERVED_CONTEXT_UNBOUND", goalID, runID, taskID, candidateAttemptID, taskRevision,
preAdmissionProof:{proofDigest,pinsDigest,ownerLogID,ownerLogSequence,ownerLogEventDigest,
ownerEpoch,workerPoolRevision,workerExecutionID,ticketID}, preAdmissionTarget}`. The target is a
read-only HostKernel projection of the exact P8 reservation. Its proof is opaque and cannot be
used for Attempt admission, claim, effect, or provider dispatch.

`bind_context` accepts the same candidate/task/parent/location/session/profile identity, the echoed
`candidateAttemptID`, Stage-A `preAdmissionProofDigest`, and the bounded sequence-1
`contextSelection`. HostKernel revalidates
all trusted Stage-A facts, validates the selection against Rust-owned Task/accepted Spec/profile
and its exact provider input, computes the canonical selection digest itself, and asks P8 to append
the immutable `PreAdmissionContextBound` event to the same still-RESERVED identity. It returns
`{status:"RESERVED_CONTEXT_BOUND", goalID, runID, taskID, candidateAttemptID, taskRevision,
contextSelectionDigest, preAdmissionProof:{proofDigest,receiptDigest,leaseProofDigest,pinsDigest,
ownerLogID,ownerLogSequence,ownerLogEventDigest,ownerEpoch,workerPoolRevision,workerExecutionID,ticketID},
preAdmissionTarget}`. The Stage-B `receiptDigest` remains stable after Attempt attachment and later
OwnerLog events; `leaseProofDigest` is the current cursor/pool-bound proof. Only the Stage-B receipt
resolves to full admission pins. `managed.v1/admit` must resolve and consume
that same Stage-B reservation; it must never create or select a second reservation. Exact same-input
retries recover the persisted Stage-A or Stage-B proof. Changed pins conflict and require the
existing no-dispatch reconciliation/tombstone path; neither stage grants dispatch authority.

`managed.ready_task_selection` intentionally returns only the selected candidate. P1 owns the two
HostKernel operations and strict protocol; P8 owns the context-unbound reservation, target
projection, immutable context binding, and recovery/reconciliation semantics; P2/P7 consume the
receipts and preserve the exact prepared request. Recovery requires the same reserved target and
bound ContextSelection before claim/consume. Core must not derive the target from the parent
Session or root `workspaceRef`.

Verifier approval UI context is resolved from the active `VerifierChallengeSetV1.location_id`
through HostKernel's registered Location record. `begin_verification` returns the exact
`approvalLocation` projection `{locationID, workspaceID, canonicalRoot, workspaceRevision}`;
its revision must equal the challenge set's frozen final revision and every challenge Location
must match. Core constructs the modal `Location.Ref` from that HostKernel-minted path only. The
root Instance directory and all caller-supplied paths are excluded from verifier approval
authority; missing or mismatched projection keeps verification unavailable.

The first managed Task has no parent Task worker. Its `parentExecutionID` uses a Rust-durable logical root-coordinator WorkerExecution bound to the authenticated top-level Core Session/Run, current OwnerLog, transport/process incarnation and private OS-authenticated peer context (PID, UID/GID, executable identity and process-start identity). The listener derives that context from kernel peer credentials and the live process; it is propagated internally to HostKernel and is never accepted in an RPC payload. The negotiated frame nonce/epoch alone is not a substitute for OS process identity. This is lineage over the existing Core coordinator, not another scheduler, transcript, model host or spawned process. P8 owns creation/resume/fencing of this root record and durable child resource reservations. The child lease is reserved against immutable pre-admission pins, then P1 atomically commits the Attempt and DelegationBinding; P8 persists the exact binding digest on the RESERVED lease before any worker claim or dispatch. Nested managed Tasks use the active claimed parent worker proof. Resource accounting must attribute the Core process once and never label logical root lineage as a distinct OS-enforced worker quota. Failure to authenticate the peer/start identity or recover the durable root/lease returns unavailable and keeps fan-out closed.

P2 managed control and the selected provider adapter own token and monetary-cost
charging for each Attempt; P8 owns only the durable ActiveWorkers/resource/worktree
reservation and does not maintain a second spend ledger. The accepted SpecVersion and
pinned profile ceilings must be carried into each provider dispatch. The effective token
ceiling is `min(accepted SpecVersion.maxTokens, AgentProfileV2.limits.tokenBudget)` over
the values present; the monetary ceiling is `accepted SpecVersion.maxCostMicros` only.
Before another child turn or effect-capable provider call
is admitted, P2 must durably account for authoritative provider-reported token usage
and cost (or preserve an explicit UNKNOWN/estimated state where the provider cannot
report exact values), then atomically deny further dispatch when either ceiling is
reached. The terminal Attempt projection must expose the exact accounting cursor,
ceiling digest, usage/cost values with provenance, and any UNKNOWN remainder so the
independent verifier and P8 settlement can bind the same Attempt. Request estimates or
model self-reports alone cannot release budget or authorize another dispatch. This
accounting uses the authenticated private `managed.record_usage` operation before the
next provider request. The OwnerLog identity is the Rust-derived Attempt + assistant
message ID + canonical step-finish index; Rust derives the operation key/digest, verifies
provider/model against the pinned DelegationBinding, computes cumulative totals, and
returns ACCOUNTED or STOPPED with an exact revision cursor. Usage replay is idempotent.
UNKNOWN or ESTIMATED data under an applicable ceiling stops the Attempt before another
provider dispatch; provider-reported decimal cost is conservatively rounded up to integer
micros, and measured cost requires verified billing-receipt evidence. This P2/provider
interface and its stop-before-next-dispatch acceptance evidence remain required before
managed fan-out is enabled.

The private P8-to-RC0 owner-sample envelope is an ingestion format, not a public
`ResourceSnapshotV1` wire operation or a release attestation. It carries the authenticated
Core process sample separately from each capacity-holding process-backed worker tree, and binds
the v2 envelope owner to Session, Run, Task and Attempt IDs plus the P8 OwnerLog cursor (the
ingester retains v1 as legacy unverified input), including
each such worker's own aggregate metrics and confirmed PID/start-generation pairs, plus the run
aggregate. V1 managed children are logical Core Sessions with no worker PID; they do not get a
synthetic worker process tree or per-worker OS counter attribution. Metric
values are canonical nonnegative decimal strings. `UNKNOWN` carries only a bounded reason enum
and never a numeric value; consumers must preserve that status rather than substitute zero or
RSS for missing PSS. The Python RC0 harness validates this exact shape but labels input
NOT_ATTESTED until trusted HostRun and independent-verifier evidence are bound to the same
Session/Run and source revision. Linux-only sampling does not qualify as native Windows
evidence, and no sample claims OS resource enforcement.

Logical managed-child settlement is also a typed P8 OwnerLog projection, not caller JSON.
P8 accepts only the opaque HostKernel-minted `WorkerSettlementProofV1`; the proof binds the
Rust terminal snapshot, exact claimed Attempt/DelegationBinding, and P1 Guarded final Inspect
receipt. The durable receipt exposes the observed final workspace revision, Inspect operation
and Host receipt refs, P2 evidence digest and bounded artifact refs, and exact P8 settlement
OwnerLog watermark. `HostRunReceiptRefV1` is minted only from that committed receipt and binds
WorkerExecution/Attempt, settlement proof digest, OwnerLog cursor/event digest, and settlement
receipt digest. P1's authenticated post-verification projection must additionally bind the live
Core peer incarnation, current measured workspace revision, verifier identity/run and evidence;
RC0 remains `NOT_ATTESTED` until that complete chain and P2 terminal evidence are present.
Successful verified settlement requires evidence refs and a final Guarded Inspect; missing or
mismatched observations retain/quarantine the worktree. The Inspect target is resolved only
from the exact active P8 claim, admission pins, and guarded worktree registration/Create
provenance; callers cannot nominate an ID or path.

**P8 source status (2026-10-20):** `prepare_managed_final_inspect_pin` consumes the typed P2
`ManagedAttemptSettlementCandidateV1` and binds its evidence revision to the exact P8 claim,
DelegationBinding digest, admission pins, and registered worktree. After restart,
`resolve_managed_final_inspect_receipt` checks the supplied idempotency key against the operation
ID recomputed from its historical root owner, then reconstructs a receipt only from the exact
durable completed OwnerLog Inspect record, a fresh same-lineage root proof, durable claim/binding
pins, and matching candidate revision. It can read the receipt from a quarantined worker after
restart but cannot settle or release capacity. A missing receipt, UNKNOWN dispatch, cancellation,
process binding, stale lineage/revision, or any mismatch remains a conflict. Source replay coverage
was added but not run; this does not attest RC0 or enable worker fan-out. `settle_managed_worker`
now releases ActiveWorkers only for `SUCCEEDED` + `VERIFIED`; FAILED/CANCELLED terminal proof
cannot enter the capacity-releasing settlement event. P8 now appends a distinct typed
`worker_managed_terminal_quarantined` OwnerLog event for exact FAILED/FAILED or FAILED/CANCELLED
logical Core child proof. Its receipt binds the terminal proof, Attempt, Goal/Run/Task, owner
epoch, reservation and worktree lease; the transition retains capacity and quarantines the
worktree. It does not claim a per-child process exit. UNKNOWN, incomplete effect receipts,
stale scope and ambiguous prompt outcomes remain unavailable before this event. This source
change is unverified. A separate epoch-change release now requires the stored quarantine
receipt, fresh authenticated root/owner, fresh exact terminal snapshot with quiesced child turn
and AllSettled effects, fresh HostKernel quiescence digest, and a new current-epoch Guarded
Inspect persisted in P8's worktree journal. `resolve_quarantined_managed_reconciliation_target`
is the read-only P8 target resolver: it revalidates the exact retained quarantine/Attempt/claim/
lease pins and current root before returning the registered worktree target; it does not reopen
claim or dispatch. P1 source now exposes `managed.prepare_reconciliation_inspect` and
`managed.execute_reconciliation_inspect` to resolve a fresh authenticated root and persist/replay
the separate Inspect intent/receipt for a stopped Run without reopening effectful dispatch. The
worker-pool reconciliation method checks that current Inspect against the registered worktree;
CLEAN and DIRTY_OWNED are valid observations, while only clean/no-user-change makes the worktree
reusable. Missing/UNKNOWN current observations do not release. P1 still needs a fresh-supervisor
proof that the prior Inspect process is no longer live before creating a new operation generation;
until that proof and exact child-turn quiescence are integrated, capacity and the worktree remain
quarantined. These source APIs are not acceptance evidence. Reconciliation observation of a
failed/cancelled managed Run must remain read-only and must not transition or reopen effectful
dispatch. The P8
`CacheRegistryV1` metadata table is now connected to authenticated HostKernel
RepoIntel observations and has an exact-generation retirement composer. It remains
unavailable to product callers because no trusted policy/pressure trigger exists, and
source accounting does not establish physical reclaimed memory.
P8 now receives HostKernel's typed `ManagedWorktreeAdmissionProjectionV1` on exact binding
attachment and writes its child Location, Workspace reference/root, measured child revision and
P8 worktree/base/root-location/pool pins into the durable `worker_delegation_bound` record. Replay
retains the separate child revision in the worker lease while the original parent-root revision
continues to validate the P8 worktree registration; historical records without this projection
remain readable but cannot qualify for managed dispatch or settlement. Read-only P8 target
resolvers return the persisted child projection after attachment. This source integration is
untested; P1/P2 runtime integration and acceptance are still open. RC0 accepts v3 owner samples
with a per-worker source-revision digest, while v2 samples remain legacy inputs bound to
Session/Run/Task/Attempt and v1 remains legacy unverified input; product attestation remains
`NOT_ATTESTED`. The aggregate now includes the authenticated Core Session
process sample as well as disjoint worker trees; overlap makes the aggregate UNKNOWN. It remains
ephemeral telemetry and does not debit capacity or establish an OS quota.
The RC0 aggregation now derives worker totals from each worker's own metric row
and adds each authenticated Core process generation once; it does not sum the
per-Session aggregate (which already includes Core) and then add Core again.
Regression cases are present but remain unrun under the implementation-first
hold.

P8's Rust sampler now also defines a typed `RepoIntelProfileProjectionV1`
adapter shape matching Core's projection schema. Under `SOFT_PRESSURE`,
`HARD_PRESSURE`, or `RECOVERING`, it preserves the requested profile and
projects only `effective=lightweight`, `effectiveSource=resource`, and
`reason=resource_pressure`; serialization is metadata-only and grants no
indexing, process, provider, or worker authority. This is source-present only:
there is not yet a live authenticated pressure producer or P3/Core consumption
path. Until both exist and are verified, no resource-pressure projection is
claimed as active runtime behavior; unknown quota remains unknown and fan-out
stays disabled.

P8 source now adds an owner-bound pressure consumer seam: a fresh P8 owner sample
is revalidated against the current OwnerLog cursor, then measured PSS is paired
with the exact HostKernel policy pin. The resulting opaque advisory signal binds
the Attempt owner epoch, policy revision/digest, sample time/sequence and OwnerLog
cursor. Unknown PSS, absent/unsupported effective limits, stale samples or changed
owner/policy return unavailable. The lower watermark and sustained-calm count are
explicit trusted inputs, not P8 defaults. Its bounded process-local tracker resets
on restart and begins in `RECOVERING`; entries whose supporting sample expires under
the caller's freshness bound are reclaimed, so returning owners also start in
`RECOVERING`. No durable hysteresis, HostKernel ingress, or P3/Core consumer is
wired. This does not change admission authority, and worker fan-out remains closed.

P8's cache registry defines a non-Clone HostKernel-minted observation envelope
and receiver that enforces exact-generation owner epoch, monotonic observation
sequence, and a bounded freshness window. HostKernel now mints observations from
the exact authenticated RepoRead lease and retained generation. RepoIntel supplies
accounted source bytes, which map to `AccountedOnly` and leave physical
`allocated_bytes` unknown. The HostKernel-owned composer invokes the exact cache
retirement path, rechecks live generation references and lease expiry, and records
an opaque retirement acknowledgement. P8 also supplies an internal cache-row
invalidation operation for exact HostKernel generation expiry/revision removal;
those HostKernel callsites remain to be connected. No trusted caller currently
invokes the composer; post-retirement physical memory remains UNKNOWN until
independently measured.

P8 terminal settlement also consumes P2's durable usage-accounting summary. A
VERIFIED worker cannot reach its P8 settlement proof without a nonempty,
bounded receipt chain, valid accounting cursor/ceiling/chain digests, and explicit
usage/cost status. P8 proof digests include the exact summary fields; failed
quarantine reconciliation binds a summary when one exists and preserves the
unavailable marker otherwise. This does not replace HostKernel quiescence,
settled effects, final Inspect, or independent-verifier requirements.

After P2 transitions the Attempt to Succeeded, HostKernel can use
`resolve_managed_final_inspect_receipt_for_terminal` with the successful terminal projection.
It requires Verified/AllSettled/Quiesced state and validates the terminal evidence, binding,
Attempt identity and observed head against the exact P8 claim and completed Inspect. The current
durable P8 stream also records a typed `ManagedFinalInspectCandidatePinV1` event, binding the
Inspect operation to a v2 canonical digest of P2's full SETTLING candidate, including every
field in its durable usage-accounting summary, and separately retaining
Attempt, SpecVersion, binding, evidence and final-revision fields. The terminal resolver checks
those shared fields against the candidate pin and operation intent; it remains read-only and
grants no settlement or capacity-release authority. Legacy Inspect records without this pin do
not qualify for managed final settlement.

P8's fresh-challenge resolver now also accepts the exact durable Pending operation or a Completed
operation after validating the same candidate pin, current claimed worktree registration/Create
provenance, root/path/worktree/base/revision, and (for Completed) the exact durable Guard receipt.
It is read-only: Pending remains subject to the separate pending-only Guard dispatch path, and
Completed/UNKNOWN never authorizes redispatch. This repairs lost-response challenge recovery at
the source boundary; it is not acceptance evidence.

The RepoIntel cache source has advanced beyond the initial inert receiver: HostKernel mints a
bounded authenticated observation from its live RepoRead lease and retained generation, and a
HostKernel-owned composer plans retirement, rechecks the exact generation's lease expiry and
live `Arc` references, then records an opaque retirement acknowledgement. It remains uncalled
because there is no trusted policy/pressure trigger in the authenticated RepoIntel lifecycle;
source-accounted bytes are not measured allocation and no reclaimed-RAM claim is made. RC0's
Rust snapshot schema is v3 and binds each worker's sampled process tree to its durable child
workspace revision; the bounded local parser validates that pin. RC0 remains `NOT_ATTESTED`,
resource pressure remains disconnected from admission/cache policy, unsupported OS resource
quotas remain unavailable, and worker fan-out remains closed pending integrated acceptance.

The pre-admission handoff is a private typed sequence, never a caller-constructed wire claim:

1. HostKernel authenticates Core ingress and resolves the exact accepted Ready Task, SpecVersion,
   Task-pinned AgentProfile definition/permission ceiling, current Guard capability ceiling,
   registered parent Location/Session/workspace observation, budget and parent lineage. It mints
   stable candidate identity and immutable known-fact pins; no ContextSelection digest is claimed
   at this stage. P8 durably reserves the exact worker/resource/worktree target against these pins
   and returns an opaque `ReservedWorkerLeaseProofV1` plus read-only target projection. A replay
   with the same candidate and facts returns the same proof; mismatched reuse conflicts.
2. Core compiles the exact child request without dispatch on that target. HostKernel validates the
   returned bounded `ContextSelectionV1`, resolves every owner revision/digest, and rechecks the
   unchanged Task/profile/Spec/Guard/resource/root facts. P8 immutably binds the canonical
   ContextSelection digest through `PreAdmissionContextBound` on the same still-RESERVED lease. A
   different selection conflicts; an incomplete reservation remains fenced and can only be resumed for the same candidate or
   safely reconciled. The stable candidate `pinsDigest` intentionally remains context-free so A and B address the same lease;
   the Stage-B `ReservedWorkerLeaseProofV1::proofDigest` additionally binds the actual ContextSelection digest, OwnerLog cursor,
   pool revision and exact lease IDs. HostKernel consumes the Stage-B proof digest for admission.
3. P1 atomically appends the Attempt and `DelegationBindingV1` with those exact lease refs and
   admitted managed revision. P8 durably attaches the canonical binding digest to the same
   RESERVED lease, rechecking all pins. Claim and dispatch require both that attachment and the
   current HostKernel/OwnerLog state. Admission never creates a second reservation.
4. After attachment, authenticated `managed.claim_dispatch` consumes the claim once and returns
   an opaque `ManagedDispatchHandoffV1` to the existing Core TaskTool path. Core resolves the
   Task-pinned profile from its trusted Config owner and includes the exact definition for
   HostKernel digest validation; it cannot synthesize or alter handoff fields. Before every
   effect, HostKernel revalidates the live Attempt, binding, lease, current workspace and Guard
   decision.

P8's read-only target projections derive the stable worktree/base, exact registered Create path
and root generation, workspace binding and current pool revision from durable reservation and
registration provenance. The RESERVED pre-admission projection is available from the exact opaque
reservation proof before P2 creates the Attempt/DelegationBinding; the attached RESERVED/CLAIMED
projection additionally checks that exact binding. HostKernel resolves the actual child
WorkspaceID through its authenticated Location registry and freshly measures the child workspace
revision at admission/handoff/consume. That child revision is then bound to the admitted Attempt
and DelegationBinding, while the original parent-root revision remains independently bound to
root Session/Goal lineage. No generic equality between the two revisions is permitted. The P8
projection itself grants no effect or dispatch authority.

Core Config supplies the exact Task-pinned `AgentProfileV2` definition in authenticated
`managed.claim_dispatch` and `managed.consume_dispatch`. HostKernel strictly validates that
definition and recomputes its canonical Rust domain-separated MessagePack BLAKE3 definition and
permission-ceiling digests. Both must match the durable Task profile pin, DelegationBinding and
P8 pins before claim or consume. This prevents same-revision Config content drift without a
second digest implementation in Core. The supplied definition is comparison evidence only; Rust
OwnerLog pins remain authoritative. Missing or changed profile content keeps prompt dispatch
unavailable.

P8's OwnerLog durably records the one-use worker claim and exposes an opaque
`ClaimedWorkerDispatchProofV1`: Attempt ID, WorkerExecution ID, attached binding digest, pins
digest, OwnerLog ID/sequence/event digest, worker-pool revision and a stable `claim_nonce` bound
to those fields. The nonce is a replay/idempotency cursor, never bearer authority. P8's OwnerLog
is separate and no cross-log atomicity is assumed. The Core caller
persists the handoff before entering the model path, then invokes authenticated
`managed.consume_dispatch` with its exact handoff identity and idempotency key. HostKernel checks
the live Attempt, DelegationBinding, attached P8 claim/nonce and current epoch, then appends the
consumed marker to the canonical managed-control OwnerLog and returns a typed receipt. Exact
retries return the same receipt; changed identity, digest or authority conflicts. Consumption
only fences duplicate Core prompt dispatch: it creates no worker, effect, lease, Guard approval
or scheduling authority. Core durably records the receipt and pending prompt-dispatch state
before invoking the provider. If Core restarts after consume while prompt outcome is ambiguous,
the attempt becomes UNKNOWN and is never automatically sent to the provider again. Every
subsequent tool effect still uses the normal Guard/ExecutionHost path. This pessimistic recovery
trades availability for no-duplicate execution after an ambiguous crash.

P2 owns the `ConsumeManagedDispatch` reducer event and crate-private proof/receipt types in the
managed-control OwnerLog; only P1's authenticated HostKernel boundary may construct the proof.
The event includes a delivery identity for durable exact-retry replay. `claim_nonce` is BLAKE3
over the NUL-terminated domain `horizoncode.claimed-worker-dispatch-proof.v1`, then each UTF-8
field (Attempt ID, WorkerExecution ID, binding digest, pins digest, OwnerLog ID, sequence, event
digest) prefixed by its big-endian u64 byte length, then the big-endian u64 worker-pool revision.
`claimedProofDigest` uses domain `horizoncode.claimed-worker-dispatch-proof-digest.v1\0`, the
same length-prefixed encoding plus the claim nonce as the eighth field, and the revision as the
trailing big-endian u64. P2's reducer recomputes both values before persisting consume.

The stable candidate identity makes reserve and admission retries idempotent. A crash or lost response between the P8 reservation, Attempt/binding append, digest attachment, claim and Core handoff never authorizes dispatch by itself. P8 retains the reservation until owner-log reconciliation proves that no Attempt binding, claim or process launch exists; an ambiguous or possible dispatch becomes UNKNOWN/quarantined and is never automatically relaunched. Cancellation after claim follows effect receipt reconciliation and retains capacity until safe terminal proof. No timeout-only release is permitted.

P8 persists the exact pre-admission RESERVED worker IDs retained during restart and owner-epoch
recovery. These reservations are excluded from timeout expiry until cross-owner reconciliation
proves whether a managed Attempt was committed; CLAIMED and RELEASE_PENDING workers remain
quarantined. Historical recovery events without a retention list decode as empty for replay
compatibility, but new pre-admission paths must record the explicit retention set.

Releasing a retained RESERVED reservation requires an opaque P1-minted
`ManagedReservationReconciliationProofV1`, not caller-supplied booleans or status strings. P1 may
prove only `NotAdmittedNoDispatch` after durably fencing the exact candidate against later
admission, or `TerminalNoEffect` after proving the exact Attempt terminal with no dispatched or
UNKNOWN effect. The proof binds the candidate worker/ticket/Attempt, optional exact binding,
managed OwnerLog cursor/event digest, HostKernel epoch/incarnation and a no-process observation.
P8 rechecks its own lease remains exactly RESERVED and unclaimed before release. Any claim,
possible process/effect dispatch, stale cursor or uncertainty keeps the reservation quarantined;
no timeout-only release is permitted.

After the `NotAdmittedNoDispatch` reconciliation append, P8 returns a distinct opaque durable
tombstone receipt carrying its own OwnerLog ID/sequence/event digest, exact worker/ticket/candidate
Attempt IDs, pins digest, worker-pool revision, reconciliation-proof digest, receipt digest and
terminal `EXPIRED` outcome. P1 cannot infer that cursor from the
earlier managed OwnerLog proof. It passes this P8 receipt through the private
`AbandonPreAdmissionCandidate` HostKernel proof to P2's ManagedControl reducer. The event binds
the current READY Task revision, admitted attempt count and candidate generation to that exact
tombstone and increments generation once, with exact-delivery replay and changed-proof conflict.
P1 derives candidate identity from the durable Task ID/`attempt_count`/`candidate_generation`
tuple; admission increments the first counter, and a pre-admission tombstone increments the
second. Old identities
remain permanently unusable, and this recovery transition cannot admit an Attempt or dispatch
anything. The P8 tombstone and P2 generation advance are separate durable logs; a crash between
them is retried with the same receipt/delivery until the P2 advance is confirmed.

The Core Config service resolves the pinned `AgentProfileV2` under the authenticated user's profile namespace; the Core ContextService compiles `ContextSelectionV1` without replacing the canonical Session or treating `ContextLedgerV2` as mutable storage. Both cross to HostKernel only as authenticated typed proofs. HostKernel checks accepted Task/Spec membership, the Task's durable profile revision and owner binding against the authenticated principal, current Guard policy ceiling and live lease owners before appending the binding. Rust OwnerLog retains immutable per-Task and per-Attempt revision/digest/owner/ref lineage, not a global duplicate profile registry or transcript. Project/plugin/external profile sources remain unavailable in the first managed V1 vertical until trust resolution is executable.

RepoIntel uses the existing authenticated `repo-intel.v1` service for bounded generation, structural-query and document-read operations. `ensure_generation` accepts only §12.18 `RepoGenerationRequestV1` plus authenticated out-of-body RepoRead context; HostKernel validates ServerAuth principal, Session, registered Location, negotiated feature and current Guard `files.read`, then collects bounded no-follow snapshots and builds/reuses one immutable index generation. Location registration persists a domain-separated principal binding; a missing legacy binding or mismatched principal has no read authority and is rejected before source revision or file observation. It returns `RepoGenerationPinV1` with separate index `sourceGeneration` digest and measured workspace `sourceRevision`, plus bounded coverage and expiry. Core immediately submits `query_structure` with that returned generation pin and a bounded §12.18 query; it never sends source snapshots or body-supplied principal/scope. If source or policy changes between calls, HostKernel returns typed STALE with no nodes. Results carry generation/revision, digest/ranges, parser and coverage/fallback quality. `readPage` cursors bind owner, query digest and generation and have byte/node/deadline limits. The additive `read_document` operation accepts §12.18 `RepoDocumentReadRequestV1`; each request names its revision domain (`workspace` or `discovery_observation`) and is capped at 131,072 UTF-8 bytes. HostKernel validates the same authenticated principal/Session/Location, negotiated read context, current Guard `files.read`, exact pre/post revision in that explicit domain and no-follow regular-file access, then returns the same `revisionKind` with the bounded text and content digest. It supports LSP document synchronization and exact-revision manifest reads, never an edit grant or app-process fallback. A reference has no mutation authority. `preparePatch` must call the existing source-digest and Guard path; no AST service writes files directly.

**RepoDiscoveryV1 source addition (2026-10-21; not accepted):** the same service now has
`discover`, using the identical authenticated ServerAuth + RepoRead(Session, Location) envelope
and current Guard `files.read` authority. Its strict request is
`{schemaVersion:1,messageType:"discover",requestId,rootRef,mode:"tree"|"manifests",maxEntries,
maxBytes,maxDepth,deadline}` with hard maxima 512 entries, 256 KiB accounting and depth 16.
Identity, principal, Session, Location, owner epoch, workspace/revision and Guard read-policy
digest never come from the request body. Replies pin those values plus exact root/mode/limits and
typed CURRENT/PARTIAL coverage; entries contain names/metadata only. Descriptor-rooted
enumeration does not follow symlinks. `manifests` returns regular-file candidates only; Core
reads each candidate through `read_document` using the exact `sourceRevision` and fails closed
if any requested read is stale or unavailable. The Core `SessionSupervisor.discoverRepo` and
OpenCode adapters are source-present. `repo_tree`/`repo_detect` remain absent from the model
registry until integrated cross-process acceptance; no validation has run.

Child results are typed bounded candidate deliveries with artifact/evidence refs. For the first V1 coding Task, keep its Attempt live through independent verification. `Attempt.workspaceRevision` and `DelegationBinding.sourceRevision` remain immutable admission provenance. HostKernel derives the live revision head from the deterministic OwnerLog effect-edge order: each preceding effect needs one SUCCEEDED receipt linked by exact before/after digests, and the registered root is re-observed against that head before dispatch. Serialize mutating effects in this Attempt. The current aggregate OwnerLog revision is checked against request `expectedManagedRevision`; per-edge `boundRevision` is edge-local. Each verifier process gets a separate Guarded EffectIntent and one-use lease linked to that Attempt and current head; its read-only receipt must prove before equals after equals the head. P1 re-resolves all live scope before dispatch; the managed reducer independently validates the receipt chain. HostKernel captures output only after supervised exit and settled receipt, then re-observes the same workspace revision before P2 appends typed evidence. P2 advances to SETTLING/Verified and exposes a settlement-candidate projection; P8 pins the final Inspect from that candidate. After the exact Inspect receipt is durable, P2 settles the Attempt to Succeeded and exposes the terminal projection; P8 settles its worker only from that terminal projection and Inspect receipt. Candidate and terminal projections are separate to avoid a terminal-state/Inspect dependency cycle. Failure, UNKNOWN, missing/mismatched/out-of-order receipt, cancellation, crash, owner-epoch change, out-of-chain human edit, lost receipt, stale revision or partial capture after possible dispatch fences later effects and remains UNKNOWN/reconciliation-only; callers cannot rebase or relaunch. The canonical record/transition contract is §12.19. Until P1 confinement/dispatch and P7 artifact-store APIs pass their acceptance tests, managed verifier dispatch and finalization stay unavailable. See §32.38 for mandatory forged-scope, stale-generation, artifact-integrity, denial-before-dispatch and restart/UNKNOWN cases.

The managed verifier intent is persisted before the lease and records immutable execution facts, not the one-use lease digest. Refresh the aggregate scope after writing it; the Guard lease is bound to the exact Attempt edge, immutable intent digest and current revision/workspace fence. EffectHost durably consumes the one-use lease, and the HostKernel-authenticated settled receipt records its digest. Approval uses the authenticated distinct reviewer; the child process uses the trusted verifier profile principal. Any intervening OwnerLog/workspace change before launch invalidates the pending authorization.

Attempt-bound model ToolBatch uses that same post-bind lease boundary for both managed and direct children. Complete-batch validation and Guard evaluation happen before any dispatch; after explicit approval when required, HostKernel atomically binds the exact batch effects, returns the new authenticated scope revision, revalidates the current OwnerLog/workspace/policy and exact edges, and only then issues leases bound to the refreshed scope plus each edge/intent. For managed effects, Core must first append the exact provider-step usage receipt and accept its refreshed Attempt scope after complete-batch validation but before Guard preparation; absent, STOPPED, or uncertain accounting withholds the whole batch before Guard. The later `step-finish` projection reuses the receipt. Direct-session ToolBatch does not require or synthesize managed usage authority. The initial challenge scope is not reusable to consume or execute a lease. ALLOW also defers lease issuance until the bind; ASK approval is invalidated by intervening scope changes. A challenge may transition its scope binding once before any lease exists; an issued lease is immutable. Stale/raced/lost outcomes deny or reconcile as UNKNOWN without caller rebasing or automatic replay. VEO-019 is the required cross-language/HostKernel regression.

For repeated model turns, the Core `ManagedAttemptAuthority` may advance only from the exact
previous HostKernel response and stable Attempt identity. Atomic batch bind advances aggregate
revision by one and preserves workspace head; a successful settled write receipt can advance
both the aggregate revision and workspace head. HostKernel returns the new scope only after
deriving the latter from the ordered receipt chain. Core must carry that correlated scope into
the next prompt/batch; failed, UNKNOWN, cancelled, stale-epoch or lost-receipt states do not
yield dispatchable refreshed authority (VEO-020).

**Restart rule for the live verification Attempt:** recovery may preserve only the same Attempt and owner epoch on a durable `VERIFYING` Run with the exact frozen verifier and `finalRevision`. Before any verifier intent exists, recovery is limited to a complete successful contiguous coding-receipt chain whose observed head equals that revision; the verifier may then be newly admitted through the normal Guard path. If verifier intents already exist, recovery may continue only by reconciling those exact intents to terminal, non-UNKNOWN receipts for that frozen revision and reconstructing evidence from complete HostKernel-authenticated durable output/artifact refs; a receipt digest or byte count alone is insufficient, and verifier intents must never be redispatched. If typed evidence is already durable and the Attempt is `SETTLING`, recovery may finish settlement only when the evidence digest, complete criterion set, profile/executable/epoch pins, and every terminal receipt match the same revision. Any missing, partial, UNKNOWN, stale, mismatched, or uncorrelated receipt/evidence makes the Attempt/Run UNKNOWN or RECONCILING and requires explicit reconciliation; no owner-epoch renewal, cursor reset, or verifier relaunch is permitted. The current source now commits typed evidence and bounded artifact refs to OwnerLog before projecting `SETTLING`, and can recover that committed projection without rerunning verifier children. A crash before that evidence commit remains UNKNOWN/reconciliation-only. These are requirements/source branches, not phase acceptance.

**Begin-verification recovery response:** `begin_verification` remains the authenticated entry point and derives reviewer identity from ServerAuth. For an existing `Approved` challenge set, `RESUME_EXECUTION` may be returned only when Goal/Run/Attempt, reviewer, owner epoch, accepted SpecVersion/digest, final revision and immutable verifier profile all match, every one-use lease digest is durably retained, and no member has a process execution identity; the response contains no old lease or challenge. For an `Executing` set, only already persisted complete typed evidence for the same verificationRunID, Attempt, frozen revision and owner epoch may return the `SETTLING` candidate/evidence/artifact response; execution without that evidence is UNKNOWN/reconciliation-only. Both responses carry `approvalLocation` from the exact HostKernel registered child Location, `{locationID, workspaceID, canonicalRoot, workspaceRevision}`, with the latter equal to frozen `finalRevision`. No recovery response may recreate challenges, renew a lease, or dispatch a verifier.

**P2 Core/TUI source integration (2026-10-20; not acceptance evidence):** Core strictly decodes the three recovery states above and uses only the HostKernel-projected `approvalLocation`. The final-inspection prepare body is exactly `{goalID,runID,taskID,attemptID}`. Its Guard challenge is shown through the existing modal stack only for `origin=managed_root`, `source=host.managed_worktree`, capability `git.worktree.list`, policy `broker-process.local.v1`, guarantees `[configured_executable,bounded_argv_env,beneath_workspace_root,one_use]`, and an assessed empty residual set. The execute body is exactly `{goalID,runID,taskID,attemptID,challengeID,effectID,locationID,capabilityLeaseDigest}`. Its response has exactly `{status,operationID,hostReceiptRef,workspaceRevision,worktreeStatus,dirtyEntryCount,dirtyEntriesDigest,containsUserOwnedChanges,owned,noFollow}`. Core accepts only the frozen revision with `owned=true`, `noFollow=true`, and `containsUserOwnedChanges=false`, and only `CLEAN` or exact `DIRTY_OWNED`; the former may release the P8 worktree, while the latter is valid final evidence but must settle with `WORKTREE_QUARANTINED` and remain unavailable for reuse. `DIRTY_UNATTRIBUTED`, `MISSING`, and `UNKNOWN` remain conflicts. Core then sends authenticated `managed.settle` with `outcome=succeeded` and `expectedRevision=settlementCandidate.managedRevision`, followed by deterministic P8 `settle_dispatch` for the same Attempt. Denial is retryable only by preparing a fresh challenge; Core never reuses the denied challenge or lease. After restart, Core can prepare a fresh challenge against the same deterministic P8 Inspect pin and, after fresh approval, resolve an already-completed receipt without redispatch. Exact same-challenge replay is served from the bounded HostKernel replay cache; after a full Core restart, Core prepares a fresh challenge for the deterministic P8 Inspect operation and resolves only its exact completed receipt. After managed Attempt settlement but before P8 dispatch settlement, authenticated terminal-settlement recovery resumes only the existing settlement delivery. These source paths remain unverified and never replay verifier or coding work.

P2 source map (not acceptance evidence): `packages/opencode/src/session/managed-control.ts` owns the strict HostKernel projections, authenticated review/Attempt scope transitions, verifier and final-Inspect lifecycle; `packages/opencode/src/session/managed-run-coordinator.ts` owns exact-child dispatch/restart recovery; `packages/opencode/src/server/routes/instance/httpapi/handlers/goal-review.ts` owns authenticated Core API and cancel fencing; `packages/tui/src/app.tsx` and `packages/tui/src/component/dialog-goal-review.tsx` own proposal/review/plan/start/run controls; `packages/tui/src/component/dialog-goal-verification.tsx` presents evidence, outer P8 `RELEASED`/`WORKTREE_QUARANTINED`, and nested `REUSABLE`/`QUARANTINED` receipt disposition. Normative contract: §12.19; dirty-owned acceptance: JC-RES-021, JC-RES-021.A/B. No P2 validation or acceptance is claimed.

**P2 managed-plan selector source update (2026-10-21; not acceptance evidence):** the authenticated `goal-review` snapshot now projects the accepted SpecVersion objective, scope, capability scope, constraints, criteria and budget, together with up to 128 enabled user-owned subagent AgentProfileV2 references from Core Config (ID, revision, role, capability ceiling and token budget only), and explicitly reports when more profiles were truncated. Core resolves the selected immutable profile revision; HostKernel returns canonical PLAN_ONLY profile, accepted-scope and profile-permission-ceiling digests, and Core/TUI validates and displays those exact pins before the separate authenticated `goal.start`. The pre-Attempt accepted-scope and profile-ceiling digests are not the effective `permissionScopeDigest`; that value is minted only after authenticated Attempt admission. The current HostKernel discovery operation is explicitly `list_pending_reviews`, and its projection contains only Goals with pending SpecVersions; single-Goal `snapshot` requires a Goal ID. There is no accepted-Goal discovery API for an idle workspace, and the Core database/Session list is not an authority for durable managed Goals. Therefore the TUI asks for a bounded Goal ID and then offers trusted accepted-Spec/profile selections; it does not infer Goal identity from local sessions or fabricate an all-Goals list. Add a separate bounded authenticated HostKernel all-Goal projection only if accepted-only discovery becomes a V1 requirement. The implementation source remains unverified; P2 integration and lifecycle acceptance are still required.

**Historical source checkpoint (2026-10-20):** the TUI Run-plan entry rejected task arrays whose length was not exactly one, and Rust also rejected multi-Task plans. This was an implementation gate for the initial single-Task vertical, not the final V1 plan/admission contract. P2 must replace the UI and reducer count ceiling with bounded DAG validation and aggregate settlement under DEC-V1-31; multi-Task dispatch remains gated until that full acceptance passes.

The Core decoder for P8 `settle_dispatch` requires the existing `SETTLED` receipt fields plus the exact nested `worktreeDisposition` projection: `{ownerEpoch,disposition,settlementReceiptDigest,finalWorktreeOperationID,finalWorktreeHostReceiptRef,observedWorkspaceRevision,inspectReceiptDigest,ownerLogID,ownerLogSequence,ownerLogEventDigest,workerPoolRevision,receiptDigest}`. It validates canonical positive decimal epoch/cursors/revisions, BLAKE3 digests, nested settlement-digest binding to the outer logical settlement receipt, exact Goal/Run/Task/Attempt identity, and (on the live final-Inspect path) the operation, host receipt reference and observed workspace revision against the exact Inspect. `DIRTY_OWNED` requires outer `WORKTREE_QUARANTINED` and nested `QUARANTINED`; `CLEAN` requires outer `RELEASED` and nested `REUSABLE`. After restart, only the exact `SETTLEMENT_PENDING` terminal projection can resume the stable dispatch-settlement delivery; its nested receipt is preserved, and its observed revision must equal the recovered frozen final revision. The TUI requires and presents the nested disposition, so quarantine remains an explicit successful Attempt/Run settlement with an unavailable worktree, never a reusable one. This is source integration only. Remaining P2 blockers are P1's accepted Guarded verifier/output receipt, quiescence and fresh-process UNKNOWN handling, plus integrated acceptance for pause/cancel/restart/stale-review/workspace-conflict and the P8 nested-receipt recovery path; none is VERIFIED.

**P2 recovery-source correction (2026-10-20; not acceptance evidence):** The HostKernel source now implements exact same-challenge final-Inspect response replay from its bounded replay cache, full-Core-restart recovery by issuing a fresh Guard challenge for the deterministic P8 operation and resolving only its exact completed receipt, and authenticated `managed.settlement_recovery` from the durable terminal OwnerLog snapshot before reusing the existing `settle_dispatch` identity. Thus the replay and terminal-projection gaps named in the preceding dated P2 source note are closed in source; integration/restart acceptance remains open. The recovery APIs never re-dispatch Git, verifier, or coding work.

**P2 managed-verification source checkpoint (2026-10-20; not acceptance evidence):** The Rust reducer permits a same-verifier/same-final-revision retry after restart only when no current-revision typed verification evidence exists; a same-revision retry is rejected once typed evidence is present. The HostKernel verifier adapter is still hard-disabled (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false`), and P1 process-tree quiescence plus integrated end-to-end acceptance remain open. Previously reported focused reducer evidence is historical and was not rerun on this checkpoint. Therefore these state/recovery paths are source-present, not verified or released.

**P2 stable verifier-set source checkpoint (2026-10-21; not acceptance evidence):** Core starts one invocation with a fresh delivery ID and threads HostKernel-returned `verificationRunID` and `challengeSetDigest` unchanged through approval resolution and execution. The response contract now includes direct owner-epoch, accepted SpecVersion, verifier profile revision/digest, frozen revision, evidence-plan, set-identity, and challenge-set pins; see §12.19 and `contracts-v2/verifier-challenge-set-response-v1.schema.json`. The HostKernel projection is source-present for NEEDS_APPROVAL, RESUME_EXECUTION, SETTLING, and UNKNOWN. Core's strict decoder and P8's settlement-receipt echo of `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest` remain cross-phase integration work. Exact retries may return only the same persisted awaiting set; mismatched tuples conflict. Approved, aborted, expired, partial, or UNKNOWN sets are never recreated or redispatched; owner-epoch changes remain recovery-only. The TUI verification control and trusted verifier adapter remain disabled. No acceptance or verification is claimed.

**P2/P1 verifier-set source recheck (2026-10-21; not acceptance evidence):** HostKernel derives deterministic `verificationRunID` and `setIdentityDigest` internally from the authenticated Goal/Run/Task/Attempt, owner epoch and managed revision, accepted SpecVersion ID/digest, registered verifier profile/executable/sandbox pins, assigned reviewer, Location/root, frozen workspace revision, receipt basis, cancel generation, and ordered criterion/test-identity/argv evidence plan. The source projection now carries the exact versioned DTO pins on all response branches, including SETTLING recovery and UNKNOWN. Its schema and wire representation are specified in §12.19 and `contracts-v2/verifier-challenge-set-response-v1.schema.json`; P2 Core strict decoding and P8 terminal-receipt echo remain integration work. The host persists the complete set before exposing challenge IDs and replays only an exact awaiting set; Core must not manufacture set IDs or refresh/replace a partial, expired, approved, or UNKNOWN set. `TRUSTED_VERIFIER_ADAPTER_AVAILABLE` and the HTTP/TUI verification gates remain false. This source review is not proof of durable admission ordering, restart recovery, Guard dispatch, typed evidence, artifact integrity, final-revision fencing, or acceptance.

**P1/P2/P8 settlement verifier-pin boundary (2026-10-21; source-only):** After authenticated
`managed.settlement_recovery` returns `SETTLEMENT_PENDING`, Core sends the exact ChallengeSet
pins on `managed.settle_dispatch`: `schemaVersion`, Goal/Run/Task/Attempt IDs, owner epoch,
accepted SpecVersion ID/digest, verifier profile ID/revision/digest, final revision,
evidence-plan digest, `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest`.
P1 HostKernel rejects missing/extra/malformed pins and compares the complete tuple to its
retained SETTLED ChallengeSet, accepted SpecVersion, live Run final revision, and committed
Attempt evidence before P8 settlement can start. The `SETTLEMENT_PENDING` recovery response
uses the same flat pin projection plus `terminalSnapshot`; `NO_SETTLEMENT_PENDING` keeps its
existing no-set shape. P8's durable settlement receipt must bind and echo
`verificationRunID`, `setIdentityDigest`, and `challengeSetDigest`, and P1 must compare that
receipt with the retained ChallengeSet on exact settlement replay. This source contract is
not acceptance evidence; Core/P8 integration and restart receipt proof remain open.

ManagedControl's durable reducer cannot determine whether a persisted owner epoch is current
because it has no authenticated current-epoch input. HostKernel must compare the persisted
Attempt epoch with its current authenticated epoch and live durable lease/challenge state at
startup and before verifier begin/execute. A stale epoch must be durably marked UNKNOWN or
RECONCILING (preserving CANCELLING when cancellation is already in progress) before any
recovery response; no stale Attempt can renew its epoch or dispatch.


### V1 trusted lease inputs for §37.22 (2026-10-19)

P1 derives one `ActiveWorkers` reservation unit per child Attempt, bounded by the configured WorkerPool live-worker ceiling and accepted SpecVersion `maxWorkers`. This is admission accounting only. CPU/memory/disk/FD samples are monitoring/backpressure, not OS enforcement; requested memory/disk guarantees remain unavailable until the selected backend proves enforcement. The Attempt deadline uses Task-pinned AgentProfileV2 `limits.wallTimeMs` when present, otherwise accepted SpecVersion `maxRunDurationMs`, capped by 24 hours and the remaining Run duration from the trusted, persisted `goal.start` timestamp. P2 persists that timestamp in the canonical start event; callers cannot submit or extend it.

P8 resolves the `WorktreeBindingRequestV1` from its durable worktree registration owner. The registration must be eligible, clean, current and scoped to the Goal's authenticated workspace; its worktree ID and base-revision locator are never request-supplied. HostKernel independently measures and pins workspace content revision. If there is no eligible registration or required capacity/currentness is unknown, admission returns unavailable. Lease expiry only fences use; release still requires the exact cross-owner no-dispatch or terminal settlement proof.

Pre-Task worktree lifecycle is scoped to a P8-minted `WorktreeRootOwnerV1` derived from the
authenticated root-coordinator proof after explicit Run start. It grants lifecycle lineage
only; it does not fabricate a Task/Attempt or replace P1 Guard. P8 selects and durably
records operation IDs, candidate worktree IDs, paths and immutable root/workspace/base
revision pins in an opaque `WorktreeLifecycleOperationPinV1`. P1 consumes the pin to build
the canonical Guard descriptor and resolves executable inputs from the trusted Location;
no public model ToolBatch or caller-selected path/argv is involved.

The dispatch sequence is deliberately split: P1 can resolve a read-only pending request
for Guard/approval evaluation without consuming the intent. After approval and durable
one-use lease issuance, P8 appends the possible-dispatch marker and returns the exact
request immediately before supervisor invocation. If the marker or supervisor response is
ambiguous, the operation is UNKNOWN and never automatically redispatched. An intent-only
operation remains safely pending. Registration follows a settled guarded Create and fresh
no-follow clean/owned Inspect. Release requires clean pre-delete and post-delete MISSING;
P8 then commits the permanent ID tombstone and returns an exact cursor-bound removal
receipt. Tombstoned IDs cannot be reused or selected, including after restart.

The sole Git executable authority is Core Config's global user-owned `git_executable`
absolute path, projected privately through authenticated
`terminal.v1/register_git_profile { executable }`. HostKernel canonicalizes the file,
requires a regular executable, computes and pins immutable profile/executable digests,
and rechecks the executable immediately before spawn. Project/plugin configuration,
ambient `PATH`, caller/model argv and caller/model paths are never used. Missing or
changed executable state makes worktree lifecycle effects unavailable.

The existing `StdioExecutionSupervisor` is the only process boundary. Its ordinary
workspace profile continues to protect all of `.git`. A separate broker-only profile
mounts the workspace read-only and allows writes only to the independently canonicalized
Git common-directory `worktrees` subtree plus P8's fixed `.horizon/worktrees` destination
parent. The rest of `.git` remains read-only; if the selected OS backend cannot prove
these exact nested binds and required confinement guarantees, dispatch remains unavailable.
Create uses fixed detached `--no-checkout` argv with hooks and ambient Git config disabled;
Inspect and Release also use fixed command forms. `.git` indirection is unavailable unless
HostKernel resolves and pins the common directory from trusted inspection. Guard, approval,
one-use lease, P8 dispatch marker, observed receipt and P8 registration/tombstone remain
mandatory in that order.


### Managed TaskTool process boundary (2026-10-19)

The handoff produced by §37.22 is consumed by the existing Core TaskTool and runs as a logical
child Session/Attempt in the existing Core process. Core Config's immutable Task-pinned
AgentProfileV2 selects the provider/model/harness and bounded child policy. P8 WorkerExecution
records lineage, lease and worktree ownership; a P8 claim is not an OS process claim and cannot
spawn. LSP/DAP executable profiles are a distinct P4 boundary. Any actual shell/process or other
mutation remains subject to the same P1 Guard/ExecutionHost supervisor and live Attempt scope.

Each Task Attempt binds a distinct durable Core child Session whose `parentID` is the Run's
root/coordinator Session. The Run `SessionLink` and P8 root-coordinator proof continue to identify
the root; the Attempt, child lease, prompt-pending record and Guard scope identify the child.
HostKernel's bounded scheduler projection selects Goal/Run/Task/Attempt/profile facts; Core
creates or reopens the corresponding child Session and persists the exact handoff/pending state.
Core is an execution adapter, not a second task scheduler. For Rust's canonical candidate ID
`attempt_<64 lowercase BLAKE3 hex>`, Core derives the child ID as the exact string
`ses_managed_${candidateAttemptID}` using one shared helper. The authenticated coordinator
derives it only from READY_TASK, submits that ID at admission, and rejects any changed ID in
the admission or handoff; HostKernel independently validates and pins the same mapping in the
Attempt/DelegationBinding. Exact retries reopen that same ID, while mismatched reuse conflicts.
Child IDs and task selectors are never accepted from model/tool arguments.

The HostKernel READY_TASK projection includes the exact immutable planned `title` and `purpose`
used by this child prompt (`title` ≤256 UTF-8 bytes; `purpose` ≤8192 UTF-8 bytes). Rust includes
both exact strings in the versioned Task-plan digest; Core rejects missing, blank, invalid, or
oversized strings. They are descriptive only and grant no authority. READY_TASK does not contain
or imply a reserved worktree target; Core obtains that exact target through the authenticated
two-stage operations above after Task selection. After `promptManaged` returns,
Core records the durable child Session projection and calls the prompt-return completion operation.
HostKernel appends `managed_dispatch_quiesced` only while the coding Attempt is still EXECUTING and
the Task is PENDING_VERIFICATION, after validating the authenticated child/root, consumed handoff,
P8 claim, process inventory, and complete settled effect chain. This receipt only fences the coding
prompt callback; it is not terminal completion. Independent verification then binds real verdict,
artifact and test evidence to the re-observed current workspace head. Only after Rust durably records
that evidence does Rust expose a typed SETTLING settlement candidate. HostKernel asks P8 to pin the
exact final Inspect from that candidate; Core presents its `git.worktree.list` Guard challenge in the
existing approval UX. A separate `managed.execute_final_inspect` call requires the resulting one-use
lease, refreshes root proof after each P8 OwnerLog append, persists the possible-dispatch fence, and
runs fixed Git Inspect through the existing supervisor. Only after P1 persists the exact Guarded
Inspect receipt does Rust transition the Attempt to Succeeded and expose the terminal snapshot for
P8 settlement. P8 settlement consumes that terminal snapshot and exact Inspect receipt together.
For Core restart after ManagedControl has committed Succeeded but before P8 settlement has
returned, `managed.settlement_recovery` accepts only Goal/Run IDs under ServerAuth and derives
the unique terminal Task/Attempt from the durable OwnerLog. Its `SETTLEMENT_PENDING` response
contains the exact durably settled `verificationRunID` and `challengeSetDigest` plus a read-only
terminal snapshot (revisions and OwnerLog cursors as canonical decimal strings, plus
binding/evidence/effect-chain/quiescence digests, final revision, and typed evidence artifact
references); no Task/Attempt IDs or verifier IDs are
accepted from the caller. `NO_SETTLEMENT_PENDING` is an explicit empty result. Core may resume only the
existing `managed.settle_dispatch` identity; that operation revalidates the snapshot, claim,
terminal Inspect receipt and P8 lease, and remains the only worker-release authority. Ambiguous
or multiple matches stay uncertain and do not release capacity.

For FAILED/CANCELLED quarantine after a HostKernel epoch change, P8 exposes a separate
`ReadOnlyReconciliationRootProofV1`; it is minted only from the exact durable quarantine,
current authenticated Core peer pins, current owner epoch, and immutable Goal/Run/principal/
workspace/parent-Session/Location/source/accepted-Spec lineage. The parent Run SessionLink and
child Attempt Session are separate identities: HostKernel proves the child Attempt's parent ID,
P8 binds the root proof/worktree to the parent Session and the worker lease/terminal owner to
the child Session, and the quiescence marker must bind both exact IDs. Nested ClaimedWorker
admission stays unavailable until the durable proof carries the Run root Session through that
parent chain. The OwnerLog records a root
reauthorization transition while preserving the stable coordinator ID. This proof type is
accepted only by P8's quarantine reconciliation methods and cannot authorize admission, claim,
ordinary worktree operations, or worker dispatch. P8 resolves the retained registered worktree,
persists one Inspect intent against the HostKernel-measured current revision, fences possible
dispatch, and accepts only the matching Guarded Inspect receipt. Core must refresh the
read-only root proof after each P8 OwnerLog append. An UNKNOWN Inspect remains unreplayable;
restart requires a fresh independently Guarded Inspect intent and one-use lease under the same
quarantine. `resolve_quarantined_reconciliation_inspect_receipt` can recover only the exact
durable completed receipt after a lost execute response; it rejects pending, UNKNOWN, missing,
or mismatched operations. The receipt alone keeps the worker and worktree quarantined; release additionally
requires a fresh terminal/quiescence/effect-chain proof and independent exact reconciliation
settlement. These APIs are source-present but P1's authenticated HostKernel integration and
acceptance are still open.

An RPC retry of `managed.execute_final_inspect` after its one-use Guard challenge was consumed may
return only the same exact P8 completed Inspect receipt after matching the original Attempt,
candidate, operation key and approval pins. It may not reuse an old lease or dispatch Git again.
A full Core restart instead obtains a new Guard challenge for the same deterministic P8 operation,
then resolves its completed receipt before any possible redispatch.
After ambiguous dispatch, recovery may reconcile the same child/session/receipt identity but must
never replay the prompt or create a replacement child automatically.

Core's child completion projection binds the Supervisor-acknowledged `{seq,eventDigest}` and a
separate `childSessionStateDigest`. The latter is BLAKE3 over domain
`horizoncode.managed-child-session-state.v1\0` followed by ordered UTF-8 fields
`["1", sessionID, parentSessionID, goalID, runID, taskID, attemptID, ownerEpoch, "RETURNED",
outcomeKind, cursorSeq, cursorEventDigest, handoffDigest, consumeReceiptDigest, outputDigest,
outputBytes]`; each field is prefixed by an 8-byte unsigned big-endian byte length. `outcomeKind`
is exactly `assistant_completed`, `assistant_error`, or `tool_error`. Any definite prompt return,
including a provider or tool error, is durably recorded and quiesced; only `assistant_completed`
is eligible to feed candidate evidence. The output projection is capped at 8 MiB of complete
UTF-8; an oversized response records the digest/byte count of its bounded prefix and is classified
as `assistant_error`, never candidate evidence. An Effect that exits without a definite returned result
remains ambiguous and is never replayed. The quiescence delivery ID is deterministic from the
domain `horizoncode.managed-completion-delivery.v1\0` and length-prefixed Attempt ID, handoff
digest, and consume receipt digest, encoded as `managed_dispatch_` plus the full lowercase
SHA-256 hex. Core obtains the outcome and completion refs from durable child metadata and the
exact event cursor, not reconstructed transcript text. HostKernel recomputes this same digest
before it mints the quiescence proof.

After an exact prompt-return receipt, the TUI's separate **Verify accepted managed Run** action
uses a fresh authenticated ServerAuth principal; neither Goal/Run entry nor a request-body
reviewer name is identity authority. A fresh begin returns the active Task/Attempt, frozen final
workspace revision, challenge-set digest, null evidence and empty refs plus the exact registered
child `approvalLocation`. On retry, `NEEDS_APPROVAL` is returned only for the same awaiting set;
an already approved set with no recorded execution returns `RESUME_EXECUTION`, exact original IDs
and pins, and no prior challenge or lease. If complete verifier evidence and the SETTLING candidate
are already durable, begin returns `SETTLING` with the exact evidence digest, bounded artifact refs,
candidate and child approvalLocation. Core must match every response to the same authenticated
Task/Attempt and frozen revision. Only `SETTLING` with complete evidence/candidate or terminal
`SUCCEEDED` with its terminal projection can continue the final Inspect/settlement flow; neither is
proof of success by itself. The separate final Inspect approval/execution hop remains mandatory
before P8 settlement. The TUI shows the verified revision, evidence digest, artifact count and P8
disposition.
`FAILED`, `UNKNOWN`,
abort, stale revision or missing artifacts never mark success or release P8 capacity; they remain
available for explicit reconciliation.

**P1 HostKernel source delta (2026-10-20; not yet verified):** HostKernel exposes the private
`managed.prepare_reconciliation_inspect` and `managed.execute_reconciliation_inspect` operations
for an exact P8-quarantined FAILED/CANCELLED logical child. Prepare accepts only Goal/Run/Task/
Attempt identity, resolves the current terminal snapshot and durable quarantine, registers no
caller path, measures the P8 child Location revision, persists a restricted P8 Inspect intent,
and emits a fresh `managed_root` Guard challenge with the trusted child `approvalLocation`.
Execute requires the exact challenge/effect/Location/one-use lease, appends P8's possible-dispatch
fence before fixed Git status through the existing child-root-only read-constrained supervisor,
and persists a receipt only after remeasuring an unchanged workspace revision. A lost response
can resolve only the same completed receipt by exact operation ID; UNKNOWN/missing/mismatch stays
uncertain and never releases capacity. With the persisted current receipt, fresh terminal,
quiescence, root and settled-effect proofs, HostKernel submits P8's typed reconciliation proof;
the response includes the exact Inspect and settlement receipt projections. Dirty observations
release active capacity while keeping the worktree quarantined; clean/no-user-change may recycle
it. A current supervisor state of `Exited` is the only process-state proof accepted before a new
Inspect generation; `Unknown` does not establish that a process stopped. After a HostKernel restart,
a prior UNKNOWN Inspect without an exact supervisor no-live proof remains unavailable. Parent-root
Session and child Attempt Session remain separate proof domains.
No runtime acceptance is claimed.

**P1 terminal settlement source correction (2026-10-21; source-only):** The Linux PTY
janitor now relays an observed leader exit only after its bounded descendant sweep obtains
a complete `/proc` ancestry snapshot and proves the supervisor-owned tree empty. Failure
to open/read `/proc`, a truncated process snapshot, a live process with unreadable identity,
or sweep-budget exhaustion closes the relay without an exit frame; HostKernel therefore
records UNKNOWN instead of settling the command from leader exit alone. This closes the
normal-exit/escaped-descendant settlement race. It does not yet provide a durable janitor
completion receipt that a fresh HostKernel can verify after abrupt owner loss, so restart
reconciliation remains UNKNOWN/fail-closed until that independent proof is available.
`terminal_process::tests::observed_exit_waits_for_escaped_descendant_quiescence` is the
required regression fixture; it has not been run and is not acceptance evidence.

**P1 cgroup lifecycle source checkpoint (2026-10-22; source-only):** The
`StdioExecutionSupervisor`, guarded terminal and external-editor launches create a Linux
cgroup-v2 child under an O_NOFOLLOW-pinned delegated subtree. Its durable identity binds
execution/effect/lease, principal, owner epoch, HostProcessRef generation/kind/profile,
executable, Attempt scope, delegated-root/cgroup device/inode/owner, and a host-derived
confinement-view proof. EffectHost stores identity before dispatch, persists kernel
`populated=0` quiescence, and preserves UNKNOWN after recovery. The owner-only janitor now
removes only exact durably quiescent identities from confined launches whose mount view
excludes the cgroup hierarchy. Full Access and legacy identities remain retained. Startup
recovery retries cleanup after status reconciliation; settled stdio, terminal and editor
effects attempt immediate cleanup after durable settlement. Eligible hidden-hierarchy entries
are reaped and free capacity; UNKNOWN, Full Access, legacy or otherwise unprovable entries stay
in bounded quarantine, and the 256-entry cap fails closed when that retained quarantine fills.
Before deletion the janitor also rejects any exact cgroup identity still referenced by a live
terminal, stdio or editor row, and requires the matching durable terminal status in its owning
challenge. Legacy identities decode with unknown owner and visibility false. Containment does not imply
CPU, memory, process-count or FD quotas;
CodeMode retains its separate verified-resource gate. No tests/builds/typechecks ran for
this implementation-first pass; this is not OS or release acceptance evidence.

HostKernel now exposes authenticated `checkpoint.restore_preview` with strict
`{checkpointID,locationID,sessionID,mode,selectedPaths}` input and a digest-bound preview
projection containing the checkpoint identity/artifact, current revision, selected paths,
actions and conflicts. It uses the existing no-follow workspace observation and rechecks the
revision before returning. That observation still has no complete same-boundary fixed-Git
dirty/untracked facts, so previews report `WORKSPACE_STATUS_UNAVAILABLE` and contain no restore
actions; selected paths remain conflicts. Capture, effectful restore and restore receipt
settlement stay unavailable. This is source-only and has no runtime acceptance evidence.

Core now strictly decodes that preview DTO and exposes authenticated
`POST /experimental/checkpoint/restore-preview`; the `/checkpoints` TUI selection requests
`FULL` preview and shows only bounded revision/digest/conflict information. Core rejects mixed
action/conflict projections, and the TUI never invokes restore. The endpoint documents a
read-only preview, not an available rewind path. Its source fixture was added but not run.

**P1 search recovery source delta (2026-10-20; not yet verified):** the private
`execution.v1/inspect_search_cascade` is metadata-only and never dispatches transport or returns
stored provider bodies. It authenticates challenge/effect/Location/lease, approved-argument and
route-plan digests against the durable HTTP aggregate and per-route receipts. A settled success
with a lost result returns `RECONCILED_RESULT_UNAVAILABLE`; fully settled no-hit/exhaustion returns
`EXHAUSTED`; incomplete or ambiguous state returns `UNKNOWN`. The route-plan digest is minted on
the Guard approval and persisted with the aggregate intent. Direct Attempt recovery remains closed
until its external-effect receipt transition exists.

**P1 process-origin closure (2026-10-20; source-only):** The shared Ripgrep adapter now
refuses before resolving its binary or spawning `rg`; this keeps Core/OpenCode-derived
`grep` and `glob` unavailable until a HostKernel Guarded read service exists. The native
OpenCode Git inspector similarly refuses before `AppProcess.run`; read-only Git flags are
not a Guard lease. Core's legacy Git service wraps its injected `AppProcess.run` port with a
fail-closed adapter, so discovery, remote/history queries, index-ignore checks, tree reads/diffs,
change capture, and worktree listing cannot spawn Git through that service. Those Core Git
read paths remain unavailable until they use an authenticated HostKernel route. macOS
managed-preference loading omits its `plutil` process source, and
the package uninstall, formatter, plugin-shell and external TUI plugin-install paths remain
closed. These closures cover the identified raw process origins without creating a second
process runner. They are source safeguards, not proof that all process origins or enabled-origin
negative cases pass; the full P1 origin matrix remains a post-implementation acceptance
requirement.

**P1/P8 settlement-disposition source delta (2026-10-20; not yet verified):** P8's
logical worker settlement and worktree disposition are separate durable OwnerLog
records. `settle_dispatch` now recognizes the exact pending-disposition crash window,
requires the immutable pre-admission owner epoch to equal the current HostKernel
epoch, completes only that exact P8 disposition, then resolves the ordinary strict
settlement and worktree-disposition receipts. A cross-epoch pending disposition is
not projected as settled and still requires a fresh current-epoch guarded Inspect
and current terminal/quiescence proof. Every SETTLED projection carries the nested
`worktreeDisposition` receipt (`ownerEpoch`, disposition, settlement receipt digest,
final worktree operation/Host receipt, observed revision, Inspect digest, OwnerLog
cursor/digest, worker-pool revision and receipt digest), resolved from P8 rather than
caller input. This source path has not been validated or accepted.

**P8 cross-epoch successful-settlement recovery source delta (2026-10-21; not yet verified):**
P8 now exposes `WorkerSettlementDispositionRecoveryProofV1::from_host_kernel(current_root,
current_owner, current_terminal, current_worktree_receipt, current_host_quiescence_digest)`
and `WorkerPoolControl::reconcile_settled_managed_worktree_disposition(proof, now_ms)`.
Its source-owned Inspect seam is `resolve_settled_managed_worktree_recovery_target` →
`prepare_settled_managed_worktree_recovery_inspect` →
`mark_settled_managed_worktree_recovery_inspect_started` →
`persist_settled_managed_worktree_recovery_inspect` →
`resolve_settled_managed_worktree_recovery_inspect`. The proof binds a fresh P1
RootCoordinator proof and authenticated owner epoch, P2's current succeeded/verified,
quiescent terminal Attempt and exact workspace head, a fresh current-epoch Guarded Inspect
Host receipt, and HostKernel live process/effect quiescence. P8 revalidates the original
settlement receipt and immutable worker/Attempt/admission pins before appending the
separate disposition event. The earlier note that the P8 recovery transition itself was
absent is superseded. P1 must still provide authenticated ingress and HostKernel-owned
quiescence/root facts; P2 must provide its current terminal projection. Until then, the
retained lease stays quarantined; this source delta does not reactivate effects.

Pressure policy triggering, cache retirement, and RC0 promotion remain unavailable.
Pressure lacks trusted watermark/calm-window policy, authenticated ingress, and durable
recovery retention; it cannot trigger admission, cancellation, or eviction. Cache metadata
has no authenticated Core/HostKernel RPC or retained-generation handle and cannot claim
reclaimed bytes without measurement. RC0 has no trusted attestation sources or P1
HostRun/P2 independent-verifier attestation of the exact revision. Bounded resource
accounting is not OS quota enforcement; unsupported CPU/memory/FD/disk and native Windows
guarantees remain disabled.

**P1/P3 RepoIntel cursor source delta (2026-10-20; not yet verified):** indexd now
provides deterministic immutable-generation paging with internal exclusive
last-emitted position `(path_ref, symbol_index, byte_offset)`; it does not mint
authority. If an immutable file suffix exceeds a page's independent byte budget,
indexd marks the page partial and continues with later files; it mints no cursor
unless an extra matching occurrence proves that results remain beyond the node cap.
This preserves the approved emitted-occurrence cursor contract without inventing
scan checkpoints. HostKernel resolves one-use opaque `repo_cur_<64hex>` leases before source
collection, binding authenticated principal/Session/Location, owner epoch, retained
generation lease, workspace/generation/revision, canonical selector+limits digest,
position and expiry. Continuation omits caller `sourceGeneration`; HostKernel fills
it only from the retained lease. It remeasures the current Guard read grant and
workspace/policy pins, then mints a next token from indexd's internal position.
Tokens are invalidated on consume, cancellation, stale source/policy and generation
retirement; restart drops them. `repo-intel.cursor-lease-v1` is defined but deliberately
not advertised and the HostKernel gate defaults false until integrated acceptance.
Expired, foreign, replayed or stale tokens remain unavailable with no nodes.

**P1/P8 shared cache-lease source correction (2026-10-20; not yet verified):** the
HostKernel registry key is source-generation scoped while request leases are
lease-scoped. HostKernel now keeps exact parser-set/buildVersion and coverage on each
lease, reuses one immutable Arc for matching owner/generation leases, and rejects a
same-lease-key overwrite whose immutable scope differs. Removing one request lease
does not invalidate the shared P8 row while a sibling lease remains; the last lease
can be removed only after no non-HostKernel Arc owner remains and P8 accepts exact
cache invalidation. A failed pin/invalidation check retains the lease and Arc. Cache
eviction remains gated until a trusted pressure policy is available. This is source
only, not acceptance evidence.

**P1/P3 RepoIntel generation reuse source correction (2026-10-21; source-only):**
`hz-kernel` handles requests synchronously through one mutable HostKernel, so compatible
requests queue; this is not an overlapping-build singleflight implementation. After each
request collects and authenticates a bounded source snapshot, `ensure_repo_generation`
looks for a live retained immutable generation before invoking the index builder. Its base
scope pin is keyed by authenticated principal, Location, relative read root and policy,
alongside workspace/revision, parser and source-receipt pins; Session is retained on each
request lease and checked again on query, rather than fragmenting a shareable immutable
base. Reuse also requires the current owner epoch, exact root, effective collection bounds,
observed file/byte counts and every immutable generation pin to match. Each Session still
gets its own lease, and the current source snapshot is revalidated before returning. Thus
queued compatible requests avoid rebuilding the same generation within one HostKernel
epoch, although each request still recollects its snapshot. This source path has not been
exercised by acceptance evidence.

**P2 managed child token boundary (2026-10-21; source-only):** Core resolves the exact
versioned `AgentProfileV2` from its authenticated Config owner; HostKernel validates and
persists the profile's immutable `limits.tokenBudget` with the Task pin. P1 is adding the
Rust scheduler projection for the effective token ceiling as `min(accepted SpecVersion.maxTokens,
AgentProfileV2.limits.tokenBudget)` where both are present, plus the exact remaining allowance
from durable Attempt usage; the HostKernel DTO update is in progress. Core rejects absent,
noncanonical, increased, or profile-mismatched values. A zero remainder is accepted only as
an authenticated exhausted accounting projection; managed LLM continuation and Core/OpenCode
ToolBatch admission stop before another provider step, batch, Guard request, or lease. Initial
READY_TASK admission requires a positive remainder. Each managed provider step is clamped to
the current Rust-backed remainder. A stopped child prompt is durably marked as an error and
settled FAILED after the exact returned-child/quiescence receipt; restart recovery applies the
same failure settlement without replaying the prompt. The SpecVersion `maxCostMicros` remains the cost ceiling. This adapter does not
claim an OS memory/CPU/FD limit; such limits remain unavailable until the selected backend
enforces them. The model path remains gated until P1's Guard/cgroup/quiescence evidence and
the integrated P2/P8 journey are accepted. `managedTaskDispatch` is hard-disabled in
RuntimeFlags rather than relying on an operator-set environment toggle. The Goal
verification endpoint also returns unavailable while its source readiness constant is
false, so callers cannot invoke independent verification or Run finalization early.
Authored fixtures remain unrun.

## 37.23 Internal managed provider inference Guard action (2026-10-21)

The existing capability machine inventory contains the sealed `providers.infer`
`kind: action`. HostKernel may create it only from a current authenticated managed
Attempt and a trusted route resolver result; it is not projected to model-callable
tools or accepted by ToolBatch. Its immutable binding includes Attempt/owner epoch,
profile/provider/model/harness/route/endpoint revisions, ContextSelection and request
sequence, normalized `requestDigest`, exact non-secret `transportRequestDigest`,
SecretBroker `operationDigest`, current permission-scope digest, and budget
authority/remaining limits. A per-request HostKernel-created Guard challenge bound to
these exact route, request and billing pins is the explicit inference consent; there is
no separate persistent provider-route setting or caller-projected `consentRef`. Prepare
persists the exact binding before explicit approval. Begin rechecks the live Attempt and
route, consumes the Guard lease once, appends durable DISPATCHING, then returns an opaque
permit usable only by the existing Core Provider/SecretBroker callback. Immediately
before credential use and transport, that callback consumes the permit through the
authenticated HostKernel boundary; a lost or ambiguous consume is UNKNOWN and cannot be
replayed. That callback validates both normalized input and exact serialized SDK
request before sending; it accepts no arbitrary URL, secret bytes or fallback route.
Settlement binds the actual assistant entry, response and usage; a lost or ambiguous
post-DISPATCHING outcome is UNKNOWN and is never automatically replayed. Until P1,
P2 and P6 complete integration and acceptance, all managed sends remain unavailable.

**P2 approval-flow source update (2026-10-21; source only):** HostKernel prepare now returns
a non-secret `providers.infer` Guard projection containing the exact selected route revision,
Attempt token/cost ceilings, canonical policy/guarantees, and challenge/effect identity. Core
validates that projection, publishes it through the existing Guard approval event, and waits
for an authenticated ServerAuth decision before calling `managed_provider.resolve_approval`.
The resolver records only the exact challenge decision; the subsequent HostKernel begin still
creates the one-use lease and DISPATCHING receipt. P6 must call Core's
`awaitManagedProviderApproval` between prepare and begin. No provider request is enabled by
this approval-flow source alone; send/settlement integration and acceptance remain open.

**P2 provider lifecycle source continuation (2026-10-21; not acceptance evidence):** strict
HostKernel/Core RPCs now cover prepare, authenticated challenge decision, begin, one-use send
authorization consumption, per-dispatch settlement, completed-turn proof, read-only settlement
inspection and UNKNOWN. Core captures the selected route from the Task-pinned profile and
existing provider registry at Attempt admission; a later route revision mismatch is rejected.
The HostKernel mints SecretBroker requester/profile/run references from authenticated identity
and live managed state. The persisted response digest binds exact read-back Assistant info, the
selected persisted `step-finish` part and its `stepFinishIndex` using canonical MessagePack and
domain `horizoncode.managed-provider-response-step.v2\0`; usage provenance is separately
digested. HostKernel derives the ordered settlement set for turn completion from its OwnerLog.
P6's production transport integration and all acceptance evidence remain pending, so provider
sends stay disabled. The final-assistant completion callback and P8 current-epoch guarded
worktree disposition reconciliation are now source-wired; neither is acceptance evidence.

**P2 managed request/recovery source update (2026-10-22; implementation only):** managed
`ContextSelectionV1` now requires an explicit `lane`, and HostKernel/OwnerLog reject lane,
Attempt, profile, sequence, or authenticated child-Session mismatches before request admission.
The provider lifecycle retains three distinct digests: normalized provider input
`requestDigest`, exact SDK `transportRequestDigest`, and SecretBroker `operationDigest`
(SHA-256). The processor persists exact settled assistant/step-finish/usage pins; the prompt
loop calls `managed_provider.complete_turn` only after reloading the final assistant entry,
confirming its current-user parent, final finish and no outstanding tool calls. After restart,
Core rehydrates only through `managed_provider.inspect_settlement`, never by hashing transcript
text. The managed follow-up coordinator binds its inbox row, completion receipt, one-use wake,
next ContextSelection, prompt consumption and HostKernel ACK; queue remains non-waking. P6's
provider transport callsites and P1's Guard/ExecutionHost acceptance are still required before
managed dispatch/follow-up can be enabled. No P2 tests or integrated runtime journeys are
claimed in this source-only update.

**P2 managed budget and child-turn source correction (2026-10-21; not acceptance evidence):**
The HostKernel/Core projection now carries both the effective token ceiling and durable
remaining allowance derived from the accepted SpecVersion and Task-pinned AgentProfileV2;
Core/OpenCode validate the pins, clamp each managed provider step (including the native
adapter), and stop before another provider/effect admission when the remaining allowance is
zero. The prior note that the Rust scheduler projection was still in progress is superseded.
Core also has the serialized direct-child follow-up caller and HTTP wake/replay path, using
the exact live DirectAttempt, completed turn, fresh-turn proof, committed inbox receipt and
persisted completion/consume ACK. These paths remain unavailable until P1 proves guarded
verifier intent/one-use lease dispatch, exact terminal receipt and output/artifact capture,
cgroup-empty process-tree quiescence, and fresh-HostKernel UNKNOWN reconciliation; P8 must
prove the final-Inspect receipt and exact terminal worker-settlement recovery. Integrated
pause/cancel/restart, stale-review and current-workspace-conflict acceptance also remains
open. No tests, builds or typechecks have run on this source checkpoint.

### 37.23.1 Direct provider request pin (V1, DEC-V1-32)

The direct path is owned by Core `SessionRunner` and uses the existing Core
`ContextService`, `SessionStore`, ProviderTransport and protected SecretBroker callback.
It has no managed Attempt and does not call `providers.infer` or add a per-request
HostKernel round trip. Core ingress accepts only an authenticated explicit user
`prompt`/`continue`; the selected provider/model/account/harness and configured
privacy/network/token/cost policy are resolved from the active Core Config AgentProfileV2
and trusted user settings and pinned at the turn boundary. This authorizes ordinary model
continuation calls inside that turn,
not tool-originated network access. The authoritative decision is §17.26; provider or
account selection never falls back silently.

For each actual model request, Core assigns one request ID, compiles one
`ContextSelectionV1{lane: "direct"}`, freezes the exact normalized provider-visible
input, computes its BLAKE3 provider-input digest, and atomically persists in SessionStore
the DTO and domain-separated canonical MessagePack digest, observed Session cursor, exact
AgentProfileV2 ID/revision/digest and effective permission-scope digest, selected
provider/model/account/harness/route/endpoint revisions, effective policy
revision, non-secret SDK transport-request digest, and state `PINNED`. Core must send the
same frozen input and exact selected route only after that transaction commits. It marks
`DISPATCHING` durably before transport bytes may leave; after successful response, the
canonical assistant entry, usage and `SETTLED` state commit atomically against the same
request ID and pins. This journal stores bounded references/digests/state only, never prompt or secret
bytes. It is Core Session state, not a second transcript or Rust OwnerLog.

**Implementation status (2026-10-22, source only):** Core `SessionStore` now exposes durable direct request pin, dispatch-CAS, settlement, UNKNOWN and recovery operations backed by `direct_provider_request`. The authenticated Session owner is checked, and the journal stores bounded ContextSelection plus non-secret references/digests only. P6 added an internal Core `DirectProviderTransport.Service` at the existing `RequestExecutor.Service` boundary and an Auth implementation that validates the selected OpenCode route and exact SDK request, computes the transport digest, commits PINNED through the Core callback, marks DISPATCHING before one request-local send, refuses redirects/replay, and marks post-dispatch ambiguity UNKNOWN. Credentialed providers and live Doctor probes remain gated. No provider calls, acceptance or inference evidence are claimed.

**Remaining direct-runner integration (source only; updated 2026-10-22):** `packages/core/src/session/runner/llm.ts` now obtains the trusted `selectedRoute` from `SessionRunnerModel.resolveSelection`, binds it with the direct ContextSelection and profile/scope pins, and commits assistant usage plus provider-request `SETTLED` through the canonical `Step.Ended` EventV2 transaction. Restart recovery calls `recoverProviderRequests` and surfaces `UNKNOWN` without replay. This is source integration only: no provider request or integrated acceptance has been run, so no route is proven usable.

The unique key is authenticated Session owner + Session ID + request ID. An exact retry
with identical payload, route and policy pins returns the prior state; changed bytes or
pins conflict before send. On restart, `PINNED` may proceed only with the exact immutable
payload/route. `DISPATCHING` with no exact response/settlement becomes `UNKNOWN`; it is
never retried automatically because the provider may already have charged or answered.
The UI surfaces interruption and a user's explicit new continuation receives a fresh
request ID. A route/account/credential, harness, privacy/network or policy drift denies
before dispatch; Core does not recompile the same request under changed state. The
configured hard cost/token ceiling is enforced using conservative reservation or settled
usage before each next provider request; unknown usage stops when remaining authority
cannot be proved. SecretBroker returns only a one-use credential callback bound to the
selected route/operation; no credential or lease token enters SessionStore. Effectful
tools from the response still go through whole-batch Guard, lease, ExecutionHost and
receipt settlement independently of model-inference authorization.

## 37.24 CodeMode orchestration service contract (V1, DEC-V1-29)

CodeMode is a product capability implemented by the existing OpenCode-derived
interpreter at `packages/opencode/src/tool/code-mode.ts`; this section adds no
interpreter, session runtime, tool executor or capability authority. The package's
model-facing function name remains `execute`; its canonical HorizonCode capability
ID is `codemode.execute`. The production registry may expose it only after the
complete CM-001..CM-012 acceptance in §32.41 passes on the integrated revision.

The model-visible `execute` arguments contain only bounded code/script input. The host adds
authenticated Session, request and optional Attempt correlation plus lane enablement and fixed
runtime/resource pins out of band; none are model arguments, helper-script authority or
caller-selected fields. The interpreter receives only the exact authorized tool definitions
available to the authenticated direct Session or managed Attempt, plus the same scoped dispatcher
used by the ordinary tool loop. Existing `$codemode.search` returns bounded descriptions
for tools already admitted to that caller's tree; it cannot reveal a hidden tool or
change capability exposure. Existing MCP capability adapters may be called through
Core only if they use this same scoped dispatcher; there is no raw plugin/MCP executor
or helper-owned MCP client. The helper has no ambient host filesystem/process/network/
credential/registry APIs. The script is orchestration input, not authority.

One script has one shared budget: at most 64 nested calls total; each complete,
schema-valid wave is admitted atomically with at most 32 calls; a trusted 30,000 ms
deadline; 65,536 aggregate output bytes; and one cancellation token. Each wave
re-enters resource resolution, current Guard evaluation, budget reservation,
durable EffectIntent, one-use leases, the existing ExecutionHost and receipt path.
No effect in the wave dispatches until the entire wave validates and obtains its
required authority. A bounded pure-computation script may complete with zero nested
calls; its result has `waves=[]` and `totalCalls=0` and omits the aggregate nested
`receiptDigest`, because no nested effect receipt exists. The outer helper process is
still an ordinary Guarded process effect with its normal process-effect receipt. If
nested calls occur, all waves must settle with exact per-call receipts and the result
includes the ordered aggregate `receiptDigest` defined in §12.21. In a direct Session, an exact
active DirectSessionGrant may suppress repeated user dialogs only for effects within its scope;
a managed Attempt never consumes a direct Session/workspace grant and instead uses its live
Attempt/Spec/profile Guard authority. A boundary-crossing direct wave creates one
challenge over the exact wave and waits before dispatch. The next wave cannot begin
until every prior effect has a terminal receipt and the live Session/Attempt,
Location, profile, grant, policy and workspace revision are revalidated. Any
UNKNOWN member stops later waves and follows ordinary reconciliation; it is never
rerun by the interpreter.

Before exposing or launching CodeMode, Core supplies a strict host-authenticated
`CodeModeEnablementV1` for the active lane (`contracts-v2/codemode-enablement-v1.schema.json`).
For a direct Session, this is an explicit user choice bound to authenticated principal,
Session/owner epoch, `codemode.execute`, fixed helper selector and resolved helper digest, exact
resource-profile ID/digest, Linux backend and guarantee digest, current policy digest, expiry and
revocation generation. It enables only this helper in this Session. Nested tool effects remain
independently Guarded and require the applicable direct grant or exact challenge approval. A
CodeMode enablement choice does not run a pending script; launch requires a fresh execute request.
For a managed Attempt, there is no direct-session CodeMode grant. The accepted SpecVersion must
explicitly include `codemode.execute`, the Task-pinned AgentProfileV2 ceiling must permit it, and
HostKernel reloads and checks those exact references plus the fixed resource-profile digest,
Attempt identity and owner epoch immediately before launch. Any missing, stale or changed pin
denies before spawn. This authorization is separate from model inference authorization and does
not use `providers.infer`.

Timeout, user cancellation, outer-turn abort and any child failure stop admission of later waves. The existing Rust ExecutionHost launches and supervises the helper process under the same supervisor and authenticated owner scope as other process effects. It resolves only the fixed trusted packaged runtime selector `horizoncode:codemode:bun`; there is no Node fallback and it never accepts executable path/argv from the model or Core request. HostKernel applies the fixed schema-versioned `CodeModeResourceProfileV1` before first instruction: cgroup-v2 `memory.max=536870912`, `cpu.max=100000 100000`, `pids.max=64`, and `RLIMIT_NOFILE=256`. Its BLAKE3 profile digest binds the schema version and all exact limits. The supervisor verifies each setting after application; if any cannot be enforced and verified, CodeMode is unavailable before spawn. Do not substitute Node Worker limits or another supervisor. The exact profile is `contracts-v2/codemode-resource-profile-v1.schema.json`.

The helper has no ambient filesystem, process, network, credential or tool-registry access. Its only host channel is bounded versioned stdio RPC. Core sends a start frame containing the host request ID, source code and the already-authorized bounded tool definitions. The helper may return `completed` without a `wave_request` only for the zero-nested-call pure-computation case defined above. Otherwise, it returns each complete `wave_request` frame (1..32 nested calls collected from one interpreter scheduling turn, each with call ID, canonical capability ID, JSON arguments and measured argument bytes); Core validates all members, then calls the existing `SessionSupervisor.prepareToolBatch` once for the whole wave using the authenticated root direct-Session scope, an actual direct-child `DirectTurnScope` when applicable, or the live managed-Attempt scope. A root direct Session has no Attempt and must not receive a synthetic one. Calls that depend on prior results form later sequential waves. A malformed member rejects the whole pre-dispatch wave. In managed scope, P2 appends `attempt_effect_wave_bound` at one OwnerLog revision after approval and before leases become consumable; HostKernel refreshes scope and revalidates before issuing leases. Guard, durable intents, one-use leases, ExecutionHost, receipt settlement and UNKNOWN reconciliation remain canonical. Core returns a bounded `wave_result` frame only after every call in the wave has terminal settled/rejected/cancelled/UNKNOWN state and includes only the standard redacted bounded tool results. Its result array must exactly match the dispatched calls by count, order and `callId`; each known terminal result carries its exact `receiptRef`, `receiptKind` and `receiptDigest`. The public wave digest is recomputed from canonical MessagePack tuples `[waveIndex,callIndex,callId,status,receiptKind,receiptRef,receiptDigest]` under `horizoncode.codemode-wave-receipts.v2\\0`; the run digest uses the same tuple shape under `horizoncode.codemode-receipts.v2\\0`, ordered by wave then call index. Rust separately recomputes EffectHost’s private settlement digest; it is domain-separated and never projected as the public digest. `effect_receipt` is Guard receipt provenance, `host_decision` is a durable pre-dispatch decision with no output claim, and `tool_result` is bounded Core-reported output, not independent evidence. UNKNOWN carries no receipt fields or public aggregate digest, requires the wave and enclosing execution to be marked UNKNOWN, and stops later waves until authoritative reconciliation. A `cancel` frame is advisory; supervisor cancellation and process termination are authoritative. The helper cannot declare a batch settled, choose authority/scope, select a runtime or extend a budget. Unknown, invalid, duplicate, reordered, oversized or uncorrelated frames terminate the helper and preserve pending effect reconciliation state.

**HostKernel RPC operation map (P2 implementation requirement; same authenticated length-prefixed `HzKernelRpcV1`, no second protocol):**

| Operation | Core input | HostKernel responsibility and response |
|---|---|---|
| `execution.v1/codemode_enablement` | `{schemaVersion:1, lane, sessionID}` for direct Session or `{schemaVersion:1, lane, runID, taskID, attemptID}` for managed Attempt, plus `action=inspect|enable|revoke`; direct enable carries `approvalRef` for the exact completed UserAction. No model input. | Persist and return strict `CodeModeEnablementV1` or `null`. Direct enablement is an explicit Session-only user decision; managed access is recomputed from accepted SpecVersion plus Task-pinned profile and is never represented as a direct grant. Bind helper, resource, backend, policy, owner epoch and expiry/revocation pins. |
| `execution.v1/codemode_start` | `{schemaVersion:1, <lane binding>, requestId, enablementRef, startFrame}`. `startFrame` is the bounded `CodeModeStartV1` object, round-tripped through the existing frame codec; the enablement reference is non-secret. | Re-resolve the installed fixed helper and cgroup profile, revalidate enablement and lane authority immediately before spawn, launch only through the existing ExecutionHost, and return exactly `{executionID, frame}` where `frame` is the first validated helper `wave_request` or `completed` frame correlated to `requestId`. |
| `execution.v1/codemode_resume` | `{schemaVersion:1, <lane binding>, requestId, executionID, waveIndex, waveResult}`. `waveResult` is the bounded `CodeModeWaveResultV1` object round-tripped through the existing frame codec. | Accept only the currently outstanding host-correlated wave; independently verify each known terminal receipt binding against Rust's ToolBatch settlement before writing the result frame to the helper. Return exactly `{executionID, frame}` with the same execution ID and the next correlated helper frame. Never accept caller-authored receipts or UNKNOWN recovery as success. |
| `execution.v1/codemode_cancel` | `{schemaVersion:1, <lane binding>, requestId, executionID, reason}` where reason is `user_abort|deadline|parent_failure|shutdown`. | Stop admission, cancel the helper and owned effects through the existing supervisor, terminate/reap the contained helper, and return strict `CodeModeHostStateV1` or UNKNOWN. |
| `execution.v1/codemode_inspect` | `{schemaVersion:1, <lane binding>, requestId, executionID}`. | Read-only reconciliation of the durable outer process receipt and nested wave cursor. Return strict `CodeModeHostStateV1`. A lost response or possible dispatch remains UNKNOWN; inspection never resumes interpreter execution or redispatches a nested call. |

The RPC channel supplies principal, owner epoch, current policy and Attempt scope out of band;
request JSON cannot replace them. `codemode_start`/`codemode_resume` form a bounded
request/response turn loop over the existing length-prefixed RPC. Core owns each wave's normal
ToolBatch admission and settlement while HostKernel owns the helper process and frame cursor.
`CodeModeHostStateV1` has exactly `{requestId, executionID, status, nextWave, pendingBatchID, outerReceipt}`; status is `READY|WAVE_PENDING|COMPLETE|CANCELLED|UNKNOWN`, pendingBatchID is null except for WAVE_PENDING, and outerReceipt is null while active, `{status:"settled",receiptRef,receiptDigest}` for known terminal state, or `{status:"unknown"}` for UNKNOWN. The existing Core adapter validates these shapes and never retries a request. HostKernel must return `UNAVAILABLE` before spawn when fixed helper identity, OS limits,
enablement or required containment cannot be proved. This operation map is a P2 source target,
not evidence those operations exist.

**P5 effective-catalog projection source checkpoint (2026-10-22; source only):**
`SessionTools.resolve` now places a typed `codeModeTools` projection alongside the existing
`toolDiscovery` projection. It is constructed from the resolver's bounded authorized
candidate set after registry classification, permission denials and harness selection. It
includes eligible deferred candidates for CodeMode's own progressive search without adding
them to the provider's active tool list. It uses each matching `ToolBatchDefinition`
capability/effect class and provider-transformed input schema, then passes the set through
`projectCodeModeEffectiveToolsV1` and
`canonicalizeCodeModeToolSetV1` for bounded canonical schemas and per-schema digests.
The same projection is returned by `prepareNextProviderRequest`; only the provider tool map
changes at that normal request boundary. Internal, unclassified, denied and recursive
`codemode.execute` entries are excluded; authorized deferred descriptors remain available
to the helper's search projection.
This is data-only: no callback, MCP client, filesystem handle, provider or execution
authority is captured in the catalog. `LLM.StreamInput.toolDiscovery` now retains this
typed field through its next-request projection. The ToolBatch context constructor still
needs P7's binding of this catalog together with its ordinary
`SessionSupervisor.prepareToolBatch` wave callback. Do not read the
catalog directly from untrusted RPC or interpreter values. Registry exposure remains off:
the current CodeMode registry gate, authenticated HostKernel enablement/start/resume/cancel/
inspect operations and supervised runtime profile enforcement are absent. Until those P1/P2
and P7 dependencies land and CM-001..CM-012 pass, CodeMode stays unavailable; this source
checkpoint is not integration or acceptance evidence.

**P5 strict RPC-adapter source checkpoint (2026-10-22; source only):**
`packages/opencode/src/tool/code-mode.ts` now has a typed adapter that calls only the
existing Core `SessionSupervisor.requestHostKernel` callback with `serviceID=execution.v1`
and the five §37.24 operation names. Lane bindings are exact direct-Session or managed
Run/Task/Attempt IDs. Direct `enable` requires a completed UserAction `approvalRef`; a
managed lane can only inspect HostKernel-derived authority. Enablement replies are checked
against every exact required key and fixed selector/profile/pin in
`CodeModeEnablementV1`. Start/resume request frames are round-tripped through the existing
strict worker-message codec before RPC; reply frames must be exact correlated helper
`wave_request`/`completed` frames. Cancel/inspect replies use the strict
`CodeModeHostStateV1` source projection (`requestId`, `executionID`, `status`, `nextWave`,
`pendingBatchID`, and exact settled/UNKNOWN outer receipt), with no replay on errors.
P2 still must implement and feature-negotiate the handlers on the existing length-prefixed
RPC; P1/P2 still own authenticated enablement, launch, containment and receipt authority;
P7 still owns binding the catalog to the ordinary ToolBatch callback. Adapter source alone
does not make any route runnable; all gates above remain closed.

One script has at most 64 nested calls across at most 64 sequential waves of at most 32, 65,536 UTF-8 source bytes, 65,536 aggregate result bytes, 524,288 serialized argument bytes per wave, 1,048,576 serialized argument bytes across the script, one trusted monotonic 30,000 ms deadline and one cancellation identity. The frame contract is `contracts-v2/codemode-worker-message-v1.schema.json`; the request/result contract is `contracts-v2/codemode-execution-v1.schema.json`. Each newline-terminated serialized frame is at most 2,097,152 UTF-8 bytes; canonical JSON serialization of the `start.tools` array is separately at most 1,048,576 UTF-8 bytes, and the complete start frame must still fit the 2 MiB cap. The host computes `toolDefinitionsBytes`; the receiver recomputes and exact-compares it. Argument bytes have separate 256 KiB per-call, 512 KiB per-wave, and 1 MiB script-total caps. JSON Schema `maxLength` is a character bound only, so strict receivers recompute UTF-8 byte counts for source, tool definitions, arguments, outputs and frames. The existing Rust `CodeModeFrameV1` framed codec is the sole byte/depth/node validator before helper launch; no parallel validator may disagree. The Rust supervisor terminates and reaps only the helper before the outer call settles. A possible-dispatch effect still settles only from its exact EffectHost receipt or remains UNKNOWN; helper exit cannot manufacture an effect receipt or prove an external effect absent. Known result provenance is typed per call: `effect_receipt` is only a settled Guard effect receipt; `host_decision` is a durable Rust pre-dispatch decision with no output claim; `tool_result` is bounded Core-reported callback output and is not independent evidence. Core retains raw tool output and sends only status/errorCode plus digest and UTF-8 byte count for the exact bounded redacted `{output}` projection sent to the helper. Aggregate tuples bind call index, call ID, status, receipt kind, receipt ref and receipt digest. UNKNOWN is durable and receiptless, fences the execution, and prevents subsequent waves. Read/control callbacks have no synthetic lease; HostKernel returns an explicit ordered `kind:'host_callback'` projection, while effect calls carry ordinary Guard leases. Interactive control tools such as `question.ask` are singleton waves. These normative bounds do not claim current source wiring; §32.41 CM-001..CM-012 remains integrated release acceptance. The ToolBatch maximum of 32 is per admission wave, not the script total.

**Core packaging adapter status (2026-10-22; source only):** the OpenCode-derived build
embeds the fixed Linux GNU helper asset and its SHA-256 manifest. Core's
`SessionSupervisor.RuntimeConfig` installs the exact helper and manifest atomically under
the owner-only `Global.Path.bin/codemode-helper` directory, verifies the helper digest and
strict manifest fields, and pins the directory/files before adding the optional
`--codemode-helper-root=<absolute path>` HostKernel startup argument. Core's process
allowlist accepts that argument only for the in-memory-pinned private root. P2 owns
HostKernel manifest parsing and fixed-selector resolution. This adapter does not make
CodeMode available: the helper launch, Guarded wave, cancellation, receipts and
cgroup-v2 acceptance gates above remain required. No checks or helper execution ran.

**P5 Core exposure audit (2026-10-22; implementation incomplete):** the canonical capability
`codemode.execute` and the existing interpreter/helper protocol are present, but the production
ToolRegistry does not initialize or include `CodeModeTool`; `SessionTools.resolve` therefore has
no model-visible CodeMode entry. Its current supported-effect projection also does not admit
`codemode.execute`. The context key and strict authorized-tool descriptor projection exist, but
`codeModeToolContextFromBatchContext` intentionally returns `undefined`, so there is no nested
ordinary ToolBatch dispatcher today. HostKernel currently exposes only a metadata-only
`codemode_helper_snapshot`; P5's new strict Core adapter targets the documented operations,
but those authenticated Session enablement/helper lifecycle handlers are not routed there yet.
P5 owns the Core registry/catalog and interpreter adapter; P1/P2 own the fixed ExecutionHost
launch, HostKernel resolution, per-lane enablement and settlement protocol; P7 owns the ordinary
ToolBatch wave dispatcher. Do not expose `execute` based only on helper
packaging, a feature flag, or registry presence. Keep it absent until these exact interfaces are
connected and CM-001..CM-012 pass. No CodeMode checks or helper execution ran.

**P7 ToolBatch adapter update (2026-10-22; source only):** P7 now supplies the exact
post-filter/post-transform `SessionTools` executors to a request-scoped nested adapter. Each
complete helper wave is decoded and normalized before one atomic HostKernel CodeMode-aware
ToolBatch prepare call. HostKernel-owned `effect` leases/challenges and `host_callback` rows are
validated separately; callbacks run only after wave binding, bounded terminal callback results
are journaled, and ordered `effect_receipt`/`host_decision`/`tool_result` provenance is checked
before producing the helper result. A typed `pre_dispatch_terminal` is returned directly without
running callbacks. UNKNOWN is persisted and stops later waves. The adapter's cancellation path
still lacks P2's wave-correlated terminal projection, so cancellation/recovery remains unavailable
and CodeMode exposure stays closed. P2 has added the Rust `DirectSessionArtifactRead` authenticated
context for inspect/range: the exact ArtifactRef must first resolve through the bounded root
DirectSession batch index, exact EffectHost terminal receipt and ArtifactStore metadata before the
GuardedArtifactIngress reads it. Core supplies only the authenticated Session/Location and exact
listed ref; it cannot promote a root ref into managed scope. P7 owns the typed Core inspect/range
producer. Wave-correlated cancellation and the complete CodeMode launch/prepare/settle/recovery
route remain unimplemented and gated. No tests, builds, typechecks or helper runs were executed.

This adapter is currently attached only to the OpenCode-derived `SessionTools.resolve` prompt
lane. The direct Core V2 runner still supplies a fail-closed
`dispatchPreparedToolBatch` callback and does not construct the CodeMode helper context or inject
the exact current SessionTools catalog. P5's registry/helper integration must provide that
request-scoped context before the Core lane can reuse this same P7 wave dispatcher; do not add a
second tool executor or treat the OpenCode-lane adapter as direct-session integration. Root
DirectSession artifact search also no longer falls through a missing root receipt binding to
managed verified-artifact resolution. Managed reads must match the current live managed Attempt
scope exactly; root reads remain unavailable until P2 supplies authenticated inspect/range methods.

## 37.25 Direct-session permission mode projection

Core exposes `/permissions` over the existing trusted Config/TUI path. The
user-facing selection is the strict `DirectSessionPermissionModeV1` contract
from §12.21, not arbitrary policy JSON. The protected HostKernel operation
`effects.v1/set_direct_session_permission_mode` accepts only
`{sessionID, locationID, sandboxMode, approvalPolicy, expectedRevision}` under
authenticated user interaction. HostKernel derives principal, owner epoch,
registered workspace/root, backend, effective policy digest and next revision
from trusted state; the body cannot assert them. Exact replay is idempotent;
stale expected revision returns conflict. The returned projection contains only
the strict schema fields and is emitted as a source-generation-fenced event
under §4.16.

The default is `workspace-write` + `on-request`. Guard's policy adapter treats
that as automatic admission for supported effects inside the selected sandbox,
and asks only when the effect crosses its boundary. `always` asks before every
effect. `never` does not request user approval and admits supported effects
inside the selected sandbox; it does not suppress technical denials, stale
identity/scope, explicit config policy, budget failures, platform gaps or
receipt uncertainty. `danger-full-access` + `never` is explicit per Session and
means HorizonCode does not restrict filesystem/network scope. Do not report it
as sandboxed or OS-contained. It still uses HostKernel identity, Guard decision,
budget, durable intent, one-use lease, ExecutionHost, receipt and UNKNOWN
reconciliation. No effect is dispatched by changing the mode itself. A mode
change advances the policy binding and conflicts any stale prepared challenge;
the next effect is freshly resolved. Managed Attempts never consume direct
Session mode and remain constrained by SpecVersion and AgentProfileV2.

Provider/search cost consent, API-key disclosure and paid-route choice remain
separate controls. `approve_for_me` / automatic review is not exposed in V1
without an authenticated independent reviewer. Root/session ownership comes
from the existing authenticated ServerAuth/host-OS owner, never the request.

## 37.26 DirectSessionGrantV1 issuance and revocation

The direct-session grant is a quiet-workspace policy input with one authenticated
issuer and one durable Rust authority. It is not created by ToolRegistry, an Agent
profile, a model call, project configuration, or Core's legacy permission store.

The CLI/TUI presents a Guard challenge only when the selected `DirectSessionPermissionModeV1`
requires it. The approval policy is not a grant and remains independent of persisted
`DirectSessionGrantV1` records.
`allow_once` approves only the challenged exact action or complete batch and may dispatch it
after fresh validation. `allow_this_session` and `remember_for_workspace` are grant choices,
not approvals of the pending action. A grant choice is an explicit authenticated interaction;
Core sends only the chosen grant class and
bounded selected action/resource scope to HostKernel. Principal, Session/owner epoch,
registered Location/workspace/root, backend/guarantee-set digest, current policy digest,
issue/expiry time, grant ID, digest and revocation generation are derived by HostKernel
from authenticated out-of-body identity and current trusted owner records. Profile selection
is not grant authority; every admission intersects the active grant with the current profile
ceiling. The request body cannot supply or override those fields. Session grants expire on
close/replacement or any principal, owner, workspace, backend, guarantee or policy change;
workspace grants expire no later than 30 days and are immediately revocable. Unknown/missing principal, unsupported UI origin, stale challenge or any
unresolved required pin returns a typed rejection and creates no record.

HostKernel calls the existing Rust Guard/ExecutionHost authority through private
`execution.v1/issue_direct_session_grant` and
`execution.v1/revoke_direct_session_grant` operations. Issue accepts only the strict
schema-decoded `DirectSessionGrantV1` with host-derived pins; Rust recomputes
`BLAKE3("horizoncode.direct-session-grant.v1\\0" ||
encodeCanonicalMessagePackV1(immutable grant claims excluding grantDigest and mutable
revocation))`, validates lifetime/scope/policy/backend guarantee, and appends the grant
atomically to the existing EffectHost/Guard append-only durable authority journal, not the
managed Attempt OwnerLog. Revoke appends a monotonic revocation by grant ID and advances its
revocation generation; it never rewrites the issued grant.
Guard's pre-dispatch decision may use only an active exact-pin grant and still creates
the normal EffectIntent, one-use lease, ExecutionHost dispatch and durable receipt.
Every new ToolBatch/wave re-resolves workspace revision, scope and policy. A stale,
expired, revoked or mismatched grant cannot authorize dispatch; an already dispatched
effect keeps its ordinary receipt/UNKNOWN lifecycle and is not described as rolled
back by revocation.

Before Core asks the user about any member of a complete batch, it may call the private
`effects.v1/preflight_direct_session_grant_batch` with exactly
`{sessionID, locationID, batchID, challengeIDs}` for the complete ordered challenge set.
HostKernel returns exactly `{batchID, challengeSetDigest, status}`, with status
`eligible` or `prompt_required`; the digest is HostKernel-computed correlation data over
the exact ordered `challengeIDs` array, not authority. It is
`BLAKE3("horizoncode.direct-grant-challenge-set.v1\\0" ||
encodeCanonicalMessagePackV1(orderedChallengeIDs))`; Core computes and compares the same
digest from its validated request IDs. HostKernel separately resolves every retained
challenge and checks the complete binding against authenticated principal/owner fence,
Session, Location, batch and unleased state. The strict request/response contract is
`contracts-v2/direct-session-grant-preflight-v1.schema.json`. The authenticated principal
and owner fence come from the RPC envelope, never the body. `eligible` is returned only
for a matching direct-session or workspace grant; managed Attempts always return
`prompt_required`. Any RPC error, malformed response, batch mismatch or challenge-set
digest mismatch is treated by Core as prompt-required. This operation is read-only: it
does not admit, reserve budget, consume grant capacity, mutate a journal, extend a TTL,
issue approval or lease, or authorize dispatch. Core may suppress dialogs only after an
exact `eligible` response. The existing atomic Guard approval-set operation then
revalidates the same complete challenge set and current scope, reserves grant usage, and
issues one-use leases in one durable decision. A stale, revoked, ambiguous, conflicting,
over-budget, or changed candidate fails that operation before dispatch and returns to the
ordinary prompt/deny path. The preflight is an optimization for quiet routine work, never
an authorization token.

For a single root direct-Session LSP/DAP operation prepared through the same typed
protocol challenge path, Core may use the read-only
`effects.v1/preflight_direct_session_grant_protocol_effect` operation with exactly
`{sessionID, locationID, challengeID}`. It returns exactly
`{challengeID, challengeSetDigest, status}` with `eligible` or `prompt_required`.
The digest uses the same singleton ordered-ID encoding/domain as batch preflight.
HostKernel resolves the retained typed authorization and validates the live
HostProcessRef, owner epoch, process generation, journal sequence, current workspace
revision, registered Location/root/backend/guarantees/policy and active read grant;
the request supplies none of those pins. Only read-only LSP queries and DAP inspection
may be candidates. Managed Attempts, callback replies, LSP synchronization/lifecycle,
and DAP control/attach/evaluate remain on ordinary Guard approval. This check is
read-only and cannot reserve grant usage or approve. If Core auto-resolves a matching
candidate, it includes the exact returned digest as `grantPreflightDigest` with
`resolve_approval`; HostKernel revalidates and reserves usage before the ordinary
Guard transition and one-use lease. If that candidate changed, Core returns to the
normal prompt. An explicit user `allow_once` omits this marker and remains a one-action
Guard decision. The strict wire contract is
`contracts-v2/direct-session-protocol-grant-preflight-v1.schema.json`.

Root direct-Session editor scope may obtain its current workspace and owner pins
through the read-only `execution.v1/direct_session_workspace_snapshot` operation with
exact request `{sessionID, locationID}`. It returns
`{sessionID, locationID, ownerEpoch, workspaceRevision, workspaceRootDigest,
observedAtUnixMs}`; counters are decimal strings. HostKernel requires authenticated
ServerAuth and a principal-bound registered Location, and computes every returned pin
from the current owner fence and canonical Location. This snapshot is not a launch
profile, process reference or authorization. Any subsequent launch, protocol challenge
or effect revalidates the live process and current workspace and follows ordinary Guard,
one-use lease and receipt handling. Its strict schema is
`contracts-v2/direct-session-workspace-snapshot-v1.schema.json`.

The client-visible projection reports only opaque grant ID, selected scope summary,
expiry and active/revoked/stale state. It never exposes challenge internals or raw
principal/backend secrets. The Guard dialog may offer grant choices only after
showing the exact effect whose boundary prompted the decision. Choosing a grant only persists
policy; it does not dispatch or resume the pending effect. That batch is discarded. A later
submitted batch is freshly prepared under current workspace state and evaluated by Guard, which
may use the matching grant to avoid a repeated dialog. This prevents a stale challenge from being
converted into an effect by grant issuance. Direct grant issuance and revocation event
projections are specified in §4.16; canonical shape and digest are §12.21 and
`contracts-v2/direct-session-grant-v1.schema.json`.

## 37.27 Trusted workspace command profiles for low-friction build/test

The product policy has three outcomes for a direct-session action: hard DENY from
immutable policy, prompt-free ADMIT under an exact active grant, or ASK when a grant
does not cover the action. “Safe auto” and “YOLO” are presentation choices over these
same outcomes; neither may bypass Guard. This removes repeat prompts for the routine
work a user deliberately grants while keeping network, secrets, publishing, destructive
operations, and out-of-workspace effects outside that grant.

Core Config owns `WorkspaceCommandProfileV1`. Profiles are user-owned, versioned and
immutable by revision. A profile identifies a trusted executable selector and resolved
binary digest, action set (`build` and/or `test`), exact positional argv policy, registered
workspace cwd, sanitized environment-name allowlist, workspace/temp filesystem boundary,
network policy, output/wall/process bounds, and required OS-enforced guarantees. No model
or project config may create or mutate one. No arbitrary shell text, shell interpolation,
path override, cwd override, environment value or executable selector comes from a model
call. Arguments are direct argv elements and each variable position must match its
configured literal set. Environment values are resolved by trusted host configuration;
secrets are excluded.

Grant issue records bind `{profileId, revision, profileDigest, action}` for each allowed
build/test action. HostKernel authenticates the Core Config projection, re-computes its
canonical digest, validates ownership and current resolved executable identity, checks
the requested action is in the profile, then persists those pins into the
`DirectSessionGrantV1` digest. Before each launch, HostKernel repeats profile, executable,
workspace-root, policy, backend and guarantee-set checks. A profile edit creates a new
revision; existing grants do not silently follow it. Revocation, expiry or any bound
identity change stops the quiet path before dispatch and returns to the normal Guard
decision.

Call flow: (1) user chooses “Allow this Session” or “Remember for this workspace” in
the exact-effect Guard prompt; (2) Core submits the canonical `terminal.run` invocation
with `mode="workspace_profile"`, selected action, exact profile ID/revision/digest and
bounded configured argument vector; (3) HostKernel derives principal/session/location/
root/backend/policy pins and validates the current profile; (4) Guard appends the grant;
(5) each invocation builds fixed argv from the profile, resolves fresh Guard/
EffectIntent/budget and one-use lease, then uses the existing ExecutionHost; (6) bounded
stdout/stderr and terminal status are persisted as a receipt or UNKNOWN. A grant does
not skip any of steps 3–6.

Missing profile, digest drift, executable replacement, unsupported guarantee, unbounded
argument, workspace escape or stale grant produces no process start. Hard CPU/memory/PID/FD
limits are included only when the selected OS backend verifies them before start; bounded
admission or monitoring is never described as an OS quota. Until the command profile,
Rust issuer/validator, Guard fast path, Core Config/UI flow and negative/recovery acceptance
are integrated, build/test keeps the normal approval prompt. Canonical schema:
`contracts-v2/workspace-command-profile-v1.schema.json`; invocation discriminator and
exact branches are `contracts-v2/terminal-run-invocation-v1.schema.json`; grant reference
is part of `direct-session-grant-v1.schema.json`; acceptance: §32.43.

**Source checkpoint (2026-10-22; implementation evidence is not acceptance):** Core Config
resolves versioned `WorkspaceCommandProfileV1` definitions. Core's `Pty.prepareToolBatch`
projects each profile definition as private sibling RPC metadata bound one-to-one to a
`terminal.run` call; the Rust batch parser now rejects missing, extra, duplicate, malformed
or mismatched profile bindings and validates the immutable profile digest, selected action,
revision and bounded literal arguments before any Guard admission. The separate HostKernel
projection validator recomputes profile digests and checks selected refs against the
consented scope. The canonical invocation is explicitly discriminated by
`TerminalRunInvocationV1`: shell mode preserves `{command,cwd,timeoutMs}` with trusted
shell-profile/environment projection; workspace-profile mode carries only
`{action,profileID,revision,profileDigest,arguments}`. Both retain canonical capability
`terminal.run`; profile mode never becomes shell text or a new capability ID. Core and
HostKernel/EffectHost validate the private profile binding and bounded environment
projection before Guard challenge creation; the durable challenge pins exact profile/action
and fixed-argv intent, and grant preflight compares its exact `commandProfiles` ref. The
authenticated root-Session grant preflight recognizes the no-Attempt/no-child-turn lane.
Launch-time grant revalidation and the Rust fixed-argv ExecutionHost consumer remain
incomplete. Both profile and shell terminal dispatch remain behind
`GUARDED_PTY_RUNTIME_READY=false`. Direct-session grants can cover exact file write/patch
scopes or exact profile/action refs; they never cover shell text. Do not enable
the profile path until current Config ownership, executable digest, exact grant match, fixed
argv and backend guarantees are revalidated immediately before start and GRANT-011..016 pass.
A separate raw `rg` launch through Core `AppProcess.spawn` was found during source
inspection; P1 owns mediation through Guard/ExecutionHost or disabling it before spawn.
An application permission check alone is not a Guard boundary.

## 37.28 ExternalEditorServiceV1 (V1, DEC-V1-33)

The external editor action lets a user keep the editor they already know while using the
HorizonCode CLI/TUI. It covers prompt scratch editing and an explicit single workspace
file selected by the user. It is not an editor extension, ACP integration, or model tool.
Core Config is the only profile owner. The user may create named profiles such as `nano`,
`vim`, `nvim`, `subl`, `code --wait`, or `zed --wait`; `EDITOR`/`VISUAL` may prefill a
profile suggestion but is never parsed as a command string or invoked directly.

Each immutable revision stores a trusted executable selector, literal argv vector, target
insertion index, `foreground_tty` or `wait` mode, target kind, and sanitized environment
policy. HostKernel resolves the selector to a binary digest and constructs argv by
inserting exactly one host-validated target token. It rejects shell syntax, parent
traversal, symlink escape, control bytes, oversized values, stale profile or file
revisions, and unsupported platform guarantees before start. The current
`ExecutionLaunchProfileV1` is LSP/DAP/REPL-only; editor profiles use the additive strict
`external-editor-profile-v1.schema.json` contract but share the same HostKernel
`execution.v1` lifecycle, Guard, EffectHost journal, one-use lease, sole ExecutionHost,
HostProcessRef and receipt/reconciliation machinery. No new supervisor is created.

**TUI lifecycle:** the default is a single-pane session with no Explorer/editor surface
mounted. (1) user invokes `/editor`, which opens Explorer as an overlay, selects prompt
scratch or one regular file, and chooses Open; `/editor --side` is an explicit per-session
alternate layout with the Explorer/editor on the right. Settings → Editors is reached
through `/settings`. (2) Core reads the current target through its trusted owner,
pins the workspace revision and takes an exclusive workspace write fence; (3) Core resolves the
profile and HostKernel derives authenticated scope and permission mode; (4) Guard applies
the current Ask/Full access, sandbox and approval settings; (5) for a terminal profile,
the TUI suspends its renderer and the editor runs in the foreground PTY; for a GUI
profile, the configured wait mode holds the supervised process until close; (6) the TUI
resumes; prompt-scratch content is imported into the composer, while a workspace-file
result is read from private host scratch and applied only through ordinary Guarded
`files.patch` after the current workspace revision and original preview digest still
match; (7) scratch and the exclusive fence are released after known settlement. A stale
base or uncertain process receipt is surfaced as conflict/UNKNOWN, never silently rebased
or applied.

`prompt_scratch` is a host-generated private bounded file; its successful content is
returned to the prompt composer without a workspace mutation. For `workspace_file`,
HostKernel copies the user-selected file into a separate private per-launch scratch file;
the editor receives only that scratch path, never the workspace path. Core applies the
result through a distinct Guarded `files.patch` carrying its own receipt. The original
path and preview digest stay bound in HostKernel authority and are never passed as shell
text. A workspace file target is never selected by model output. Agent workspace writes
wait behind the exclusive fence; read-only work and unrelated user actions remain available.
If a GUI command delegates to an already-running daemon and exits before the user closes
the file, it does not satisfy `wait` semantics and the profile is rejected for workspace
editing.

Workspace launch under `workspace-write` requires verified OS filesystem containment at
the registered root and child-process-tree ownership. Under explicit `danger-full-access`,
the editor runs with the user's ordinary host rights and no HorizonCode filesystem/network
sandbox; the UI surfaces the existing risk warning. `read-only` cannot open a workspace
file for editing. Approval policy remains orthogonal: `always` asks each time,
`on-request` allows a launch inside the selected supported sandbox, and `never` suppresses
prompts but does not widen it. Unsupported containment is not converted to an approval
prompt; the UI states the platform limitation and offers the explicit Full access mode.

Every launch is tied to `editor.launch`, one UserAction, one EffectIntent, one profile
revision/digest, the current Session/owner epoch/Location/root/workspace/mode revision,
one HostProcessRef and a durable settlement receipt. The Core projection preserves the
EffectHost outcome's `effectID`, `executionID`, `bindingDigest`, exact external-editor
process reference, nullable `receiptDigest`, terminal status, exit code, result-file
digest and observed workspace revision. `prepared`, `running` and `unknown` are
nonterminal and have no receipt or result evidence; terminal `cancelled`, `completed`
and `conflict` outcomes require the durable receipt. Cancellation before dispatch removes
the prepared action; cancellation after possible start reconciles status and remains
UNKNOWN until exact process/receipt evidence is available. No automatic relaunch occurs.
The client projection is the redacted `ExternalEditorChangedV1` (§4.17). No file body,
argv, executable path, environment or raw identity appears in events or logs.

Source status (2026-10-22): immutable user-global profile storage/projection and the
`/settings` → Editors selector are present in Core Config and TUI. `/editor` opens the
bounded Explorer overlay, while the default session remains single-pane. The Explorer
preview retains exact `sourceRevision` and `contentDigest`. The P1 EffectHost editor
journal seam exists, but there is no public HostKernel launch/reconcile operation, Core
SessionSupervisor bridge, TUI PTY suspend/resume adapter, or revision-checked files.patch
settlement path. Therefore the preview's Open action remains unavailable until the P2
authenticated bridge, OS containment/receipt acceptance, Core file-revision adapter and
§32.44 journey are complete; never substitute a Core spawn or direct shell.

## 37.29 GitWorkspaceReadServiceV1 (V1, §17.31)

**Purpose:** execute bounded, read-only Git inspection inside an authenticated workspace
without shell parsing or caller-selected executables.

**Operations (closed set):** `git.status`, `git.diff`, `git.log`, `git.show`,
`git.branch.list`. Each maps to a fixed argv template, maximum output bytes, wall-clock
deadline, and allowed path/object-id argument shapes validated before Guard admission.

**Authority:** authenticated principal, registered Location, current workspace revision,
and effective `files.read` / workspace-grant scope. RepoIntel generation pins are not
substituted for workspace revision on this service.

**Lifecycle:** `prepare` (scope + argument validation) → optional Guard challenge per
permission mode → one-use lease when required → ExecutionHost fixed `git` spawn → bounded
capture → `settle` with receipt digest or artifact ref → exact replay on idempotent retry;
`UNKNOWN` when dispatch may have occurred without recoverable output.

**Errors:** use canonical `ErrorV1` categories (`DENIED`, `STALE`, `UNAVAILABLE`,
`RECONCILING_UNKNOWN`, `PARTIAL_OBSERVATION`); no ad-hoc strings.

**Integration:** Core tool projection `§20.15`; effect law `§14.28`; flow `§3.24`;
acceptance `§32.46`. Mutating `git.*` capabilities use separate guarded tool contracts.

## 37.30 ContextCompileBridgeV1 and PrefixCacheAdapterV1 (§30.26)

**Purpose:** connect **Models.dev catalog hints**, **AgentProfileV2** policy, and **ProviderTransport** capabilities to Core `ContextService` without a second prompt builder or Rust string assembly.

### 37.30.1 `resolveContextCompilePolicyV1` (Core)

```ts
type ResolveContextCompilePolicyInputV1 = {
  requested: "auto" | "cache_anchor" | "minimize_tokens"
  route: { providerID: string; modelID: string; routeRevision: string; endpointRevision: string }
  prefixCacheSupport: "none" | "ephemeral" | "explicit_breakpoints" | "unknown"
  catalogSnapshot: {
    source: "cache" | "bundled" | "override" | "unavailable"
    freshness: "fresh" | "stale" | "unknown"
    model?: {
      limit: { context: number; output: number; input?: number }
      cost?: { cache_read?: number; cache_write?: number }
    }
  }
}

type ResolveContextCompilePolicyOutputV1 = ContextCompilePolicyV1 // schema context-compile-policy-v1
```

Implements §30.26.4 algorithm. **Fail closed** when `requested === cache_anchor` and `prefixCacheSupport === none` unless an explicit product downgrade path is enabled in Settings.

### 37.30.2 `PrefixCacheAdapterV1` (ProviderTransport)

```ts
type PrefixCachePlanV1 = {
  support: "none" | "ephemeral" | "explicit_breakpoints" | "unknown"
  breakpoints: Array<{
    segmentDigest: string // blake3 of normalized block bytes
    providerMetadata: Record<string, unknown> // adapter-owned; never persisted with secrets
  }>
}

interface PrefixCacheAdapterV1 {
  readonly supportForRoute: (routeRevision: string) => Effect<PrefixCacheSupportV1>
  readonly planBreakpoints: (
    normalizedMessages: unknown,
    ledger: ContextLedgerV2,
  ) => Effect<PrefixCachePlanV1>
}
```

**Rules:**

1. Breakpoints apply only to segments with ledger `cacheClass: "static"` (anchor, harness, static system).
2. Never insert cache metadata into model-visible text bodies.
3. `supportForRoute` is authoritative over catalog `cache_read` pricing hints.
4. Doctor **`phase: "cache"`** (§37.18) exercises this adapter on user-approved full tier.

### 37.30.3 `RepoContextAnchorBuilderV1` (HostKernel + Core)

```ts
type BuildRepoContextAnchorInputV1 = {
  sessionID: string
  workspaceBindingDigest: string
  sourceRevision: string
  repoGenerationDigest: string
  maxBytes: number // default 8_388_608
}

type BuildRepoContextAnchorOutputV1 = RepoContextAnchorV1 & {
  artifactRef: string
  fullText: Uint8Array
  compressedText: Uint8Array
}
```

HostKernel/indexd enumerate bounded structure; Core stores artifact and returns metadata. **P3** owns generation; **P6/P7** own compile consumption.

### 37.30.4 Adoption gate (extends §37.15)

Before WIRED: fixtures for resolver (auto/hint/deny), adapter breakpoint planning (golden digests), anchor epoch invalidation, negative “mutate anchor mid-session”, Doctor cache phase on ≥1 real provider, and §32.10 **`CX-014`..`CX-021`** with the empirical cache note in §30.26.10.

## 37.31 HostRun paired-evaluation binding and reconciliation (DEC-V1-39)

**Owner boundary:** P8 owns the frozen evaluator invocation, its stable pair key, durable `HostRunDispatchBoundV1` mirror event and receipt returned from the append. P2 owns the authenticated managed.v1 HostKernel routes and managed OwnerLog binding/receipt/reconciliation state. P1 owns the complete authenticated ToolBatch/effect projection. The independent verifier and P8 final worker settlement remain separate authorities. This contract does not add a scheduler, public capability, provider transport, or dispatch operation.

**Stable key:** reuse exactly the existing `host_run_dispatch_key` source algorithm: SHA-256 of canonical UTF-8 JSON `{armId, lane:"HUP_PAIRED_HOST_RUN_V1", manifestDigest, taskId}`, prefixed `sha256:`; then BLAKE3 over the UTF-8 bytes of that full key, prefixed `blake3:`. Canonical JSON uses sorted object keys, compact separators, UTF-8, preserved non-ASCII and rejects NaN. P2 recomputes/validates `dispatchKeyDigest`; P8 checks manifest/task/arm/group against the immutable invocation. Raw key is not transmitted or persisted. Do not change the key recipe without a versioned migration.

**Private operations (strict DTOs in `contracts-v2/host-run-dispatch-v1.schema.json`):**

1. `managed.v1/host_run.bind`: ServerAuth-only, no dispatch. Resolve the specified Goal and a live EXECUTING Attempt; derive Run/Task/Attempt, accepted Spec, DelegationBinding, root Run SessionLink, process generation, owner epoch, P8 worker/OwnerLog identity, workspace/principal pins and admitted revision from their canonical owners. Request evaluator IDs/digests are untrusted correlation claims and must match the P8 frozen invocation proof. Persist one immutable `HostRunDispatchBindingV1` and return its exact managed OwnerLog commitment receipt. `evaluationSessionId` is the run-start root SessionLink; the child Attempt Session remains separate and HostKernel/P8-derived.
2. P8 validates the returned binding against its own frozen manifest/task/arm/group, appends one durable mirror event, and obtains `{ownerLogID, ownerLogSequence, ownerLogEventDigest}` from that committed append. Its event binds schema, delivery identity, evaluator tuple, Run/Task/Attempt, dispatch-key digest and binding digest.
3. `managed.v1/host_run.bind_receipt`: accept only after the exact P8 mirror event/cursor is verifiably committed in the canonical P8 OwnerLog and matches the immutable P2 binding. A request body's cursor values are claims, not proof. **The current route only shape-validates and persists those values; P2/P8 must implement an authenticated, replayable proof/lookup seam before this operation can satisfy the contract or be WIRED.** Exact same receipt replay is idempotent; changed cursor/binding/key conflicts without mutation.
4. Only after P2 binding, P8 mirror append and P2-recorded checked P8 receipt are durable may a future HostRun adapter dispatch. No current adapter is installed by this LLD.
5. `managed.v1/host_run.inspect`: read-only join by dispatch-key digest. It cannot dispatch, invoke a verifier, mutate terminal state, clear UNKNOWN, or release capacity. Reconciliation is UNKNOWN when binding/projection/managed terminal/verifier pins/P8 receipt/settlement are absent, stale, conflicting or ambiguous.

`SUCCEEDED` requires the exact committed P1 ToolBatch/effect projection, terminal managed Attempt and Task state, independent verifier evidence pinned to the exact final workspace revision, final Guarded Inspect, and committed P8 settlement receipt for the same binding/Attempt/worker. FAILED and CANCELLED are distinct non-success outcomes and do not imply evidence or capacity release. Any exception/restart/lost response after possible dispatch is UNKNOWN/quarantined; inspect/reconcile the same key/Attempt only. Never retry, redispatch, relaunch the verifier, or clear UNKNOWN based on timeout/model self-report.

**Gate:** source/schema presence remains DESIGNED/CODE_PRESENT only. Keep HostRun exposure, managed readiness, RC0 attestation and release gates false until `HOST-RUN-001..008` in §32.54 pass across real authenticated P1/P2/P8 owners, including the P8 cursor-proof seam, positive bind/receipt/inspect, cross-identity substitutions, exact replay/conflict, crash/restart/lost-ack UNKNOWN and no-redispatch. No HUP provider run is authorized by this contract.
