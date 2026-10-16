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

These are **proposed adapters** over the existing public Session/API plus Rust managed control and existing provider transport; do not create a new conversation, Task, Guard, SecretBroker or command catalog.

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
