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
- The built-in default route requires no user key; GROUNDED_MODEL_SEARCH is preferred when the active model/provider offers a native, consented search route.
- BYO-key providers (initial set: Brave, Exa; the full matrix is `DEC-V1-20`) are enabled per provider in Settings (§16.7/§16.15) with credentials from the existing SecretBroker owner.
- Every enabled route joins one ordered cascade (settings-defined order, inspectable and reorderable). Disabled or unconfigured providers are simply absent; no explicit per-provider "off" step is needed beyond not enabling them.
- Route failures are recorded per route. Authentication 4xx statuses (401, 403, 407) fall through to the next explicitly enabled/configured route without retrying that route; other non-rate-limit 4xx errors stop and surface. Timeout/network/5xx use the bounded retry policy; 429 observes `Retry-After` and continues. Empty results continue once. When the cascade is exhausted, surface per-route reasons — never a fabricated result.
- No route is used unless enabled/configured by the user; enabling a paid or authenticated route is the explicit consent for its cost/auth class. No silent paid fallback; a failed free route cannot silently route to a paid provider.
- Every result carries provider, route class, cost class, auth source, freshness and retrievedAt provenance; web.search.inspect_provider reports auth/cost/rate-limit/last-error/freshness status per route.

Rules:
- provider/model search are different adapters;
- auth comes from existing provider/SecretBroker owner;
- cost class FREE/PAID/TRIAL/UNKNOWN is explicit;
- fallback cannot silently change cost/auth class;
- source adapter existence does not imply enabled/working service;
- privacy/domain/network policy enforced; search content is untrusted data (injection handling per §5.8);
- results and responses are bounded; large fetched content becomes an artifact rather than prompt context;
- cancellation uses the canonical request-cancellation path.

Provider matrix seed (owner `DEC-V1-20`; research 2026-10-18):

- Built-in no-key chain, default order: Exa MCP → You.com `profile=free` MCP → Tavily search MCP keyless mode → Firecrawl Keyless MCP → Parallel Search MCP. Each route is separately addressable, ordered, rate-limited and attributable. These provider routes currently advertise no-key/free search, with vendor-side rate limits; their current behavior and limits must be rechecked before release.
- BYO-key providers for Settings: Exa, Tavily, Brave, Parallel, You.com, Firecrawl; TinyFish is an optional account/API-key route and is not part of the no-key default. Tier 2: Kagi, Jina (Reader/SERP), Linkup, Serper. No provider becomes runnable from discovery alone; each key is a SecretBroker reference, and provider costs remain `UNKNOWN` unless the adapter has current sourced pricing.
- Excluded: Google CSE (closed to new customers), Bing Search (retired), DuckDuckGo (no authorized API). SearXNG / custom endpoint is a deferred post-V1 option.
- Failover: 429 ⇒ honor `Retry-After` (default 60 s) cooldown then next enabled route; auth 4xx (401/403/407) ⇒ record the failure and continue to the next explicitly enabled/configured route without retrying the failed route; other 4xx ⇒ stop and surface the reason; timeout/network/5xx ⇒ one short retry then next route; empty result ⇒ next route once, then an honest no-results message. A later route may have a different cost/auth class only because the user explicitly enabled it.
- Consent: first-use resolution form (allow / choose route / disable) with a configurable per-query permission; the built-in anonymous no-key chain is enabled by the default setting, and enabling a keyed route is the recorded consent; never auto-upgrade a vendor's keyless route to that vendor's keyed or paid API.
- Caching: per-URL 5–15 min TTL keyed by URL + content hash with explicit bypass; provenance fields per result (provider, credential mode, latency, attempts, truncation).
- A refreshed matrix replaces this seed whenever pricing/auth facts change; `DEC-V1-20` remains the owner.

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

The typed protocol transport uses separate per-process sequences: Core→HostKernel
`protocol_op` and `protocol_reply` share a strictly increasing outbound `requestSequence`;
HostKernel→Core buffered notifications/server requests use a distinct contiguous
`eventSequence`. A reply correlates to the exact buffered server request ID and method and
never uses its `eventSequence` as an outbound request sequence. Reads are bounded by the
retained event cursor (at most 64 events and 1 MiB per page); each operation payload is at most
1 MiB with strict JSON-compatible value/depth/node bounds. Unknown methods, malformed or
non-finite values, duplicate/out-of-order sequences, stale process generation/owner epoch,
workspace revision change, and mismatched reply correlation are rejected before dispatch.
The strict machine contract is `ExecutionProtocolDispatchReceiptV1` in
`contracts-v2/execution-protocol-receipt-v1.schema.json`. An accepted
`protocol_op`/`protocol_reply` returns a typed `schemaVersion: 1` receipt containing the exact
HostProcessRef, canonical `requestSequence`, monotonic `processIOSequence`, typed-operation
`operationDigest`, `dispatchReceiptDigest`, and `DISPATCHED` status. The operation digest is
BLAKE3 over canonical MessagePack
`["ExecutionProtocolOperationV1", protocol, requestSequence, operation]`, where `protocol` is
`lsp` or `dap`. The dispatch receipt digest is BLAKE3 over canonical MessagePack
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

The P4 process adapter reuses `execution.v1`: `prepare_process` records a non-dispatching
intent; `launch_process` revalidates live scope and consumes the exact one-use lease before
spawn; bounded `read`/`write`, `cancel` and `status` resolve only the minted HostProcessRef.
`write` is separately authorized and receipt-tracked. HostProcessRef binds process
generation, owner epoch and kind without exposing PID or executable path. A timeout or lost
launch/IO receipt is UNKNOWN and cannot trigger a replacement launch.

**Implementation status (2026-10-19):** Core source now contains strict LSP/DAP protocol
projections, sequence/replay journals, and typed HostKernel client adapters. These are
source components only: HostKernel `protocol_op`/`protocol_read`/`protocol_reply` still
return unavailable before process IO, and the trusted-profile process prepare/launch route,
durable IO journal, and retained event buffer are not wired. Consequently language-service
launch and DAP effects remain unavailable. REPL start/reset/execute also remain unavailable
until HostKernel reports actual OS enforcement for CPU time, memory, process count and file
descriptors. No P4 runtime journey or acceptance tests have been run on the integrated
revision.

## 37.7 DebugAdapterBrokerV1

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
bounded, correlated data to a safe child input boundary; a normal message
does not start a turn, while an explicit follow-up may request one. Parent operations use the
canonical `agents.*` capability surface (§33.12): list/inspect/graph are read projections;
message/result are bounded data operations; wait observes activity or terminal status to a
deadline; cancel first fences new work and reports observed cancelled/still-running/unknown
state. Wait timeout does not cancel. Core projects child activity/results into the parent
Session/TUI without copying all child history into the parent transcript. Direct child
completion never settles a managed Task or Goal.

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

Persistence is rooted only under HostKernel's existing private `state_dir/automations/`
subtree; requests never provide a filesystem path. HostKernel derives an owner scope from the
authenticated ServerAuth owner binding and registered Location/workspace, so definitions and
history survive Session changes but cannot cross principals or Locations. A bounded Rust-owned
registry/index is required for list and create/update revision CAS; a standalone per-definition
`AutomationJournalV1` does not by itself provide discovery or atomic definition updates. The
registry and occurrence journals are opened/reconciled by Rust, with no directory scan or
Core-owned database as authority. `runNow` is returned as unavailable until the canonical
Guarded invocation and receipt/recovery path exists.

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

Durable export is a separate Guarded artifact action.
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
| `terminal.search` | `{artifactID, generation, query\|regex, maxResults, maxBytesPerExcerpt}` → matches `{lineStart, lineEndExclusive, byteStart, byteEnd, excerpt}` | `read_only` → runtime `read_only`; opaque managed artifact only; UTF-8 pattern ≤4 KiB, `maxResults` 1–100, each excerpt ≤4 KiB; stable zero-based line refs. |
| `terminal.output_range` | `{artifactID, generation, lineStart, lineEndExclusive, maxBytes}` → bounded lines/bytes and digest | `read_only` → runtime `read_only`; opaque managed artifact only; zero-based half-open ranges; `maxBytes` and response ≤64 KiB. |
On any listed wire-bound overflow or invalid dimension, return a typed rejection;
never clamp or silently truncate the request. These request-validation rules do not
change the separate managed-log storage cap and drain/truncation behavior above.


Every search/range request checks artifact ownership and exact generation; rotated,
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


## 37.14 CacheObservationAdapterV1

Reports cache/local-model observations with measured/estimated/unknown provenance. Never fabricate provider cache hit or token savings.

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

**Renderer update algorithm:** accept canonical event identity+source generation into bounded per-Session queue; stable committed prefix is immutable, live tool-tail has byte/line cap and is replaceable; coalesce only UI paint deltas, never receipts/approval/cancel. Maintain `dirtyRegion`, resize/theme generation, queued focus/scroll ownership; request immediate redraw for input, explicit deep-idle backoff for animations. Count repaint reason and render queue drops; persist full tool logs as artifact refs with truthful FULL/SAMPLE tag. On reconnect reconstruct from canonical parts plus event cursor, never from ephemeral tail cache.

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

The first managed Task has no parent Task worker. Its `parentExecutionID` uses a Rust-durable logical root-coordinator WorkerExecution bound to the authenticated top-level Core Session/Run, current OwnerLog, transport/process incarnation and private OS-authenticated peer context (PID, UID/GID, executable identity and process-start identity). The listener derives that context from kernel peer credentials and the live process; it is propagated internally to HostKernel and is never accepted in an RPC payload. The negotiated frame nonce/epoch alone is not a substitute for OS process identity. This is lineage over the existing Core coordinator, not another scheduler, transcript, model host or spawned process. P8 owns creation/resume/fencing of this root record and durable child resource reservations. The child lease is reserved against immutable pre-admission pins, then P1 atomically commits the Attempt and DelegationBinding; P8 persists the exact binding digest on the RESERVED lease before any worker claim or dispatch. Nested managed Tasks use the active claimed parent worker proof. Resource accounting must attribute the Core process once and never label logical root lineage as a distinct OS-enforced worker quota. Failure to authenticate the peer/start identity or recover the durable root/lease returns unavailable and keeps fan-out closed.

The pre-admission handoff is a private typed sequence, never a caller-constructed wire claim:

1. HostKernel authenticates Core ingress and resolves the exact accepted Ready Task, SpecVersion, Task-pinned AgentProfile revision, bounded ContextSelection, current Guard capability ceiling, registered Location/Session/workspace observation, budget and parent lineage. It mints an opaque crate-private `TrustedPreAdmissionPinsV1`, including a stable idempotent candidate Attempt identity and immutable digests/revisions. The measured workspace content revision and worktree base revision locator are distinct facts; both are independently validated and pinned, with no equality or substitution rule. Raw principal, paths, budgets, profile definitions and authority are not accepted back from Core as proof.
2. P8 `reserve_pre_admission` consumes only that opaque token and durably records the exact pins with RESERVED worker/resource/worktree lease refs. It returns an opaque `ReservedWorkerLeaseProofV1` bound to the pin digest and OwnerLog revision. Replays with the same admission identity return the same proof; mismatched reuse conflicts.
3. P1 atomically appends the Attempt and `DelegationBindingV1` with those exact lease refs and admitted managed revision. P8 then durably attaches the canonical binding digest to the still-RESERVED lease, rechecking all pinned facts. Claim and dispatch require both that attachment and the current HostKernel/OwnerLog state.
4. After attachment, authenticated `managed.claim_dispatch` consumes the claim once and returns an opaque `ManagedDispatchHandoffV1` to the existing Core TaskTool path. Core resolves the Task-pinned profile from its trusted Config owner and includes the exact definition for HostKernel digest validation; it cannot synthesize or alter handoff fields. Before every effect, HostKernel revalidates the live Attempt, binding, lease, current workspace and Guard decision.

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

RepoIntel uses the existing authenticated `repo-intel.v1` service for bounded generation, structural-query and document-read operations. `ensure_generation` accepts only §12.18 `RepoGenerationRequestV1` plus authenticated out-of-body RepoRead context; HostKernel validates ServerAuth principal, Session, registered Location, negotiated feature and current Guard `files.read`, then collects bounded no-follow snapshots and builds/reuses one immutable index generation. Location registration persists a domain-separated principal binding; a missing legacy binding or mismatched principal has no read authority and is rejected before source revision or file observation. It returns `RepoGenerationPinV1` with separate index `sourceGeneration` digest and measured workspace `sourceRevision`, plus bounded coverage and expiry. Core immediately submits `query_structure` with that returned generation pin and a bounded §12.18 query; it never sends source snapshots or body-supplied principal/scope. If source or policy changes between calls, HostKernel returns typed STALE with no nodes. Results carry generation/revision, digest/ranges, parser and coverage/fallback quality. `readPage` cursors bind owner, query digest and generation and have byte/node/deadline limits. The additive `read_document` operation accepts §12.18 `RepoDocumentReadRequestV1`; it returns only bounded UTF-8 text and content digest after HostKernel validates the same authenticated principal/Session/Location, negotiated read context, current Guard `files.read`, exact pre/post workspace revision and no-follow regular-file access. It supports LSP document synchronization, never an edit grant or app-process fallback. A reference has no mutation authority. `preparePatch` must call the existing source-digest and Guard path; no AST service writes files directly.

Child results are typed bounded candidate deliveries with artifact/evidence refs. For the first V1 coding Task, keep its Attempt live through independent verification. `Attempt.workspaceRevision` and `DelegationBinding.sourceRevision` remain immutable admission provenance. HostKernel derives the live revision head from the deterministic OwnerLog effect-edge order: each preceding effect needs one SUCCEEDED receipt linked by exact before/after digests, and the registered root is re-observed against that head before dispatch. Serialize mutating effects in this Attempt. The current aggregate OwnerLog revision is checked against request `expectedManagedRevision`; per-edge `boundRevision` is edge-local. Each verifier process gets a separate Guarded EffectIntent and one-use lease linked to that Attempt and current head; its read-only receipt must prove before equals after equals the head. P1 re-resolves all live scope before dispatch; the managed reducer independently validates the receipt chain. HostKernel captures output only after supervised exit and settled receipt, then re-observes the same workspace revision before P2 appends typed evidence. Rust settles the Attempt/Task/Run only after evidence is durable. Failure, UNKNOWN, missing/mismatched/out-of-order receipt, cancellation, crash, owner-epoch change, out-of-chain human edit, lost receipt, stale revision or partial capture after possible dispatch fences later effects and remains UNKNOWN/reconciliation-only; callers cannot rebase or relaunch. The canonical record/transition contract is §12.19. Until P1 confinement/dispatch and P7 artifact-store APIs pass their acceptance tests, managed verifier dispatch and finalization stay unavailable. See §32.38 for mandatory forged-scope, stale-generation, artifact-integrity, denial-before-dispatch and restart/UNKNOWN cases.

The managed verifier intent is persisted before the lease and records immutable execution facts, not the one-use lease digest. Refresh the aggregate scope after writing it; the Guard lease is bound to the exact Attempt edge, immutable intent digest and current revision/workspace fence. EffectHost durably consumes the one-use lease, and the HostKernel-authenticated settled receipt records its digest. Approval uses the authenticated distinct reviewer; the child process uses the trusted verifier profile principal. Any intervening OwnerLog/workspace change before launch invalidates the pending authorization.

Attempt-bound model ToolBatch uses that same post-bind lease boundary for both managed and direct children. Complete-batch validation and Guard evaluation happen before any dispatch; after explicit approval when required, HostKernel atomically binds the exact batch effects, returns the new authenticated scope revision, revalidates the current OwnerLog/workspace/policy and exact edges, and only then issues leases bound to the refreshed scope plus each edge/intent. The initial challenge scope is not reusable to consume or execute a lease. ALLOW also defers lease issuance until the bind; ASK approval is invalidated by intervening scope changes. A challenge may transition its scope binding once before any lease exists; an issued lease is immutable. Stale/raced/lost outcomes deny or reconcile as UNKNOWN without caller rebasing or automatic replay. VEO-019 is the required cross-language/HostKernel regression.

For repeated model turns, the Core `ManagedAttemptAuthority` may advance only from the exact
previous HostKernel response and stable Attempt identity. Atomic batch bind advances aggregate
revision by one and preserves workspace head; a successful settled write receipt can advance
both the aggregate revision and workspace head. HostKernel returns the new scope only after
deriving the latter from the ordered receipt chain. Core must carry that correlated scope into
the next prompt/batch; failed, UNKNOWN, cancelled, stale-epoch or lost-receipt states do not
yield dispatchable refreshed authority (VEO-020).

**Restart rule for the live verification Attempt:** recovery may preserve only the same Attempt and owner epoch on a durable `VERIFYING` Run with the exact frozen verifier and `finalRevision`. Before any verifier intent exists, recovery is limited to a complete successful contiguous coding-receipt chain whose observed head equals that revision; the verifier may then be newly admitted through the normal Guard path. If verifier intents already exist, recovery may continue only by reconciling those exact intents to terminal, non-UNKNOWN receipts for that frozen revision and reconstructing evidence from complete HostKernel-authenticated durable output/artifact refs; a receipt digest or byte count alone is insufficient, and verifier intents must never be redispatched. If typed evidence is already durable and the Attempt is `SETTLING`, recovery may finish settlement only when the evidence digest, complete criterion set, profile/executable/epoch pins, and every terminal receipt match the same revision. Any missing, partial, UNKNOWN, stale, mismatched, or uncorrelated receipt/evidence makes the Attempt/Run UNKNOWN or RECONCILING and requires explicit reconciliation; no owner-epoch renewal, cursor reset, or verifier relaunch is permitted. Current P1 journal source does not yet persist enough verifier output/artifact data to satisfy the middle branch; until P1/P2 close that integration, a crash after possible verifier dispatch and before durable typed evidence remains UNKNOWN. These are requirements/source branches, not phase acceptance.

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
Core is an execution adapter, not a second task scheduler. Child IDs and task selectors are
resolved by this trusted path and never accepted from model/tool arguments.
