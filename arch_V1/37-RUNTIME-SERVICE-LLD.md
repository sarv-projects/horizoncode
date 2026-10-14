# 37. Runtime service LLD

Status: normative service interfaces. A service marked proposed is not implemented until source and tests prove it.

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

## 37.3 BrowserBackendV1

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

## 37.4 DesktopActionServiceV1

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

## 37.5 WebSearchBrokerV1

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

Rules:
- provider/model search are different adapters;
- auth comes from existing provider/SecretBroker owner;
- cost class FREE/PAID/TRIAL/UNKNOWN is explicit;
- fallback cannot silently change cost/auth class;
- source adapter existence does not imply enabled/working service;
- privacy/domain/network policy enforced.

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

Security:
- launch/attach/process control and breakpoint mutation are effects;
- evaluate is an effect and may be disabled by profile;
- variable/stack reads are scoped;
- no adapter command may execute outside declared workspace/process capability;
- session loss invalidates frame/variable refs.

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
- bounded memory/CPU/wall-time/output;
- filesystem/network explicit;
- callback to agent tools goes through canonical ActionDescriptor and Guard;
- no raw kernel/secret access;
- idle TTL and crash quarantine.

## 37.9 DelegationMailboxV1

Parent creates one child dispatch with:
- objective/criteria;
- context refs;
- capability/path/network subset;
- workspace lease;
- budget;
- profile/harness/model route.

Messages/results are bounded and typed. Child cannot mutate canonical Run/Task state directly. Parent/kernel owns cancellation and acceptance.

## 37.10 AutomationServiceV2

Durable Rust-owned definition/occurrence state.

Interface:
- list/inspect/create/update/enable/disable/runNow/history;
- deterministic overlap, missed-run, retry and timezone policy;
- each occurrence invokes the target canonical action through normal authorization.

Scheduler availability is shown accurately when no executor is running.

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

## 37.13 CacheObservationAdapterV1

Reports cache/local-model observations with measured/estimated/unknown provenance. Never fabricate provider cache hit or token savings.

## 37.14 Contract adoption gate

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

## 37.15 ResourceSnapshot, ProviderDoctor, FileTouch and virtual Session LLD (A-V2-30)

These are **proposed interfaces**, not existing RPC operations. Reuse the current `SessionSupervisor.Service`, Rust kernel/owner log, provider host, SessionStore, indexd and derived UI lanes. Before adding any new wire operation, define a single authoritative machine schema and versioned positive/negative fixture, map it into existing action IDs in §33 and preserve §14 Guard.

```ts
type ResourceSampleV1 = {
  owner: { kind: "host" | "kernel" | "session" | "run" | "attempt" | "worker" | "cache" | "local_model"; id: string };
  metric: "pss_mib" | "rss_mib" | "private_bytes_mib" | "cpu_pct" | "threads" | "fds" | "vram_mib" | "disk_bytes";
  value?: number; // absent when unknown
  accuracy: "measured" | "estimated" | "unknown";
  platform: "linux" | "macos" | "windows" | "other";
  source: string; observedAt: string; processTreeGeneration: string;
}
type ProviderDoctorRequestV1 = {
  providerId: string; modelId?: string; tier: "offline" | "catalog" | "full";
  maxNetworkRequests: number; deadlineMs: number; costConsentRef?: string;
}
type FileTouchV1 = {
  canonicalWorkspaceId: string; filePathRef: string; sessionId: string;
  attemptId?: string; access: "read" | "write"; sourceRevision: string;
  observedAt: string; expiresAt?: string;
}
```

**ResourceSampler adapter:** owns platform-specific process-tree discovery and per-owner quota/pressure sampling. PIDs must be combined with OS process-start generation/owner lease to prevent PID-reuse attribution; detached/unowned processes are not silently claimed. Linux PSS samples may be costly: rate-limit, sample off the UI event loop, redact paths, separate local inference and cap history. Platform unsupported counters remain unknown. Worker accounting includes child trees and OS hard limits where available, with no accidental foreign process cleanup.

**VirtualSessionBroker candidate:** `attach(authPeer, sourceSession, hostEpoch, policyRevision)`, `subscribe/ack(snapshotCursor)`, `admitBatch`, `reconcile`, `detach`. Each virtual session has isolated principal, workspace, message/cursor, cancellation generation, owned leases, queue and credits. **No shared Guard mutation API is released** until peer auth, session confusion and crash recovery pass. A shared daemon is the candidate; existing per-session supervisors remain a functional rollback and measurable baseline.

**ProviderDoctor adapter:** `inspectOffline` no network/credentials; `inspectCatalog` bounded declared endpoint discovery; `testLive` chat+stream+tool with explicit user-approved cost ref and audit receipt. Every step returns typed error/provider/model/capability/evidence and request budget; no hidden provider switch, secret echo or stale catalog claim.

**FileTouch projection:** `recordTouch`, `activitiesForPath`, `activitiesForSession`, `clearExpired` with strict cardinality/TTL and canonical workspace mapping. Advisory only; actual writes still require Guard, lease and source hash/version. **TaskGraph/HeadlessBroker:** Rust managed scheduler controls DAG/readiness/admission; bound worker identities and artifact refs; background clients do not own another Task or transcript. **RendererDiagnostics:** bounded redraw reason/counters and tool-tail status, no durable state writes.

These proposed signatures require schema/real-code review; do not mark them WIRED or advertise a public API from this document.
