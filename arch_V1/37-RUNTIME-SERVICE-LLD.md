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

## 37.16 ResourceSamplerV1 — implementable interface and algorithms (A-V2-30)

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

## 37.17 ProviderDoctorV1, FileTouchIndexV1, HeadlessBrokerV1 and renderer algorithms

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
  probeCatalog(ref: ProviderSelectionRef, networkLease: NetworkReadGrantV1): Promise<DoctorResultV1>;
  probeFull(ref: ProviderSelectionRef, consent: SpendApprovalRef, effectLease: CapabilityLeaseRef): Promise<DoctorResultV1>;
}
type FileTouchRecordV1 = {workspaceBinding:string;pathRef:string;sourceRevision:string;sessionId:string;attemptId?:string;kind:"READ"|"WRITE";startMs:number;expiresMs:number;optionalRange?:{start:number;end:number}};
interface FileTouchIndexV1 {
  recordObservedTouch(input: FileTouchRecordV1): void;
  listForPath(scope:WorkspaceScope, canonicalPathRef:string, cursor?:string): {records:FileTouchRecordV1[];next?:string};
  invalidateGeneration(workspaceBinding:string, generation:string): void;
  evictExpired(nowMs:number): number;
}
interface HeadlessBrokerV1 {
  enqueue(taskId:string, expectedTaskRevision:string, budget:WorkerBudgetRef): Promise<{queueTicket:string}>;
  reserve(ticket:string, ownerEpoch:string): Promise<{workerExecutionId:string;leaseRef:string}>;
  attachExistingCoreClient(workerExecutionId:string, sessionLinkRef:string): Promise<{attachmentId:string}>;
  startIsolatedWorker(workerExecutionId:string, sandboxProfile:string, effectLeaseRef:string): Promise<{launchRef:string}>;
  settleWorker(workerExecutionId:string, evidenceRefs:string[], externalEffectRefs:string[]): Promise<{status:"SETTLED"|"UNKNOWN"|"BLOCKED"}>;
}
~~~

**Doctor algorithm:** offline resolves pinned provider/model/harness and effective config without network, secret bytes or inference. Catalog checks only consented endpoint/auth, capability hints and model IDs with explicit request/time limits, returns stale/UNKNOWN rather than guessing. Full probes selected chat+stream+structured tool call via normal transport, with explicit estimated spend cap, user approval and Guard/EffectReceipt where model inference is billable. Cancel shuts off new sends but reconciles any already billed request. Provider 429, partial stream, malformed tool, proxy route and local model load exhaustion are separate error categories; never silently try another provider. No credential or paid probe in offline tier. Cache hit is MEASURED only when provider returns authoritative counters.

**File-touch algorithm:** normalize workspace through a trusted root handle; canonicalize path on same platform with symlink/reparse policy, owner epoch and source revision; store reverse indexes `byPath` and `bySession` with bounded count/bytes/TTL, evict atomically from both. Treat touch event as advisory and optionally incomplete; absent touch record **cannot** authorize a write. Notify overlapping writes and stale edits; final Guard write always compares target handle, revision digest and lease. Never infer a mutable file from a read-only overlap. Session close evicts only derived touch records.

**Headless broker algorithm:** Rust scheduler alone evaluates dependency readiness and reserves exclusive worker capacity. Warm reuse requires identical principal, workspace binding, trust/sandbox guarantee, provider/harness selection, environment hash, policy epoch and clean resource state; sanitize secrets/stdio/cancel state before reassigning, else dispose **owned** worker and spawn isolated new one. Read-only exploration attaches to Core without a new transcript/worktree; effects require an independently authorized process/lease. Worker completion supplies *candidate* evidence and typed artifact refs; only trusted verifier can mark Task PASSED. On crash, expire current epoch, mark uncertain external effects UNKNOWN, reconcile before reassignment and quarantine dirty workspace. Parent cancellation fences queued tickets, then active workers, without assuming already-dispatched effects rolled back.

**Renderer update algorithm:** accept canonical event identity+source generation into bounded per-Session queue; stable committed prefix is immutable, live tool-tail has byte/line cap and is replaceable; coalesce only UI paint deltas, never receipts/approval/cancel. Maintain `dirtyRegion`, resize/theme generation, queued focus/scroll ownership; request immediate redraw for input, explicit deep-idle backoff for animations. Count repaint reason and render queue drops; persist full tool logs as artifact refs with truthful FULL/SAMPLE tag. On reconnect reconstruct from canonical parts plus event cursor, never from ephemeral tail cache.

**Error/failure contract:** use canonical §12 `ErrorV1` code registry, not ad-hoc error strings. Before registering new names, map to existing stable codes (e.g. CONFLICT for a reused idempotency key), update schema/tests together and reject unknown error codes. Operational categories: `UNAVAILABLE` (unsupported platform/feature); `DENIED` (scope/policy); `STALE` (revision/epoch/cursor); `RESOURCE_BLOCKED` (bounded queue/capacity); `RECONCILING_UNKNOWN` (potentially executed effect); `PROVIDER_COST_APPROVAL_REQUIRED` (full Doctor); `PARTIAL_OBSERVATION` (measurement missing). These labels are **semantic categories**, not newly registered error-code enumerants. Every result includes typed category, retry class, origin, support status and redacted evidence ref.
