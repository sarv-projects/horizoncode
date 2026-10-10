# 13. Service composition and host/kernel IPC

This document fixes the runtime seam between the OpenCode-derived TypeScript host
and the Rust authority kernel. It does not add a second public API, event store,
provider registry or service-composition framework.

## 13.1 Process contract

| Process | Owns | Must not own |
|---|---|---|
| `hzcode` (Bun/TypeScript) | OpenCode Core V2 runner, `packages/llm`, public app API, UI composition, plugin resolver/runtime, direct-turn coordination and rebuildable projections; collects complete provider tool batches | Canonical Thread/Run facts, ToolBatch transitions, Guard decisions, effect settlement, process/effect execution, workspace fences, usage observations, Task PASS, audit head |
| `hz-kernel` (Rust) | Canonical owner streams, Supervisor, ThreadService, RunController, ToolExecutionCoordinator, Guard, EffectService, Rust ExecutionHost, UsageService, WorkspaceService, CompositionService, BudgetService, verification admission, artifact metadata, memory owner, secret broker and recovery | Provider loop, TUI state, arbitrary plugin execution, public client listener |
| `hz-indexd` (Rust) | Derived, revision-pinned repository generations and bounded queries | Canonical state, Guard, external effects, secret access |
| Restricted worker | One expiring, scoped operation or plugin/peer adapter | State-root access, ambient credentials, authority beyond its capability lease |

There is one product composition root. `hz-kernel` and `hz-indexd` are supervised
processes, not alternative applications. The kernel may refuse a caller, but the
host cannot write around it. Conversely, `hz-indexd` cannot be promoted to a
canonical authority service by registering it as a plugin.

`ExecutionHost` is a Rust module within `hz-kernel`, not a third process and not the
Bun/TypeScript `hzcode` host. It owns the supervised operation/process seam and invokes
the selected OS sandbox or subprocess backend only after Guard, EffectService and the
one-use capability lease have admitted the exact operation. `hzcode` may collect model
output and submit a whole ToolBatch, but it does not execute effect-capable tools.
`ToolExecutionCoordinator` orchestrates admitted calls and returns observations/results;
ThreadService alone commits ToolBatch state and ordered result links.

### Process startup and shutdown

1. Resolve the state root from trusted user/managed configuration; reject symlink,
   ownership, ACL or permission conditions that violate the platform contract.
2. Acquire the single-instance/supervisor lock and start or attach to the configured
   kernel process using an inherited private channel where possible.
3. Complete `KernelHelloV1` negotiation and peer authentication. The kernel validates
   canonical stream heads/projections, takes a new owner epoch and reconciles pending
   effects, worker launches, workspace fences and budget reservations before
   advertising readiness.
4. Host fetches the current immutable composition lock from CompositionService,
   verifies exact plugin bytes/schemas/trust metadata, and activates the pinned graph
   in deterministic topological order. Activation/health receipts are returned to the
   owner; host observations alone do not publish a new canonical generation.
5. Start public app listeners only after required sealed services are ready. Optional
   service failure is visible as unavailable and cannot be silently replaced with a
   weaker provider. Required sealed service failure fences dependent actions and
   prevents readiness.
6. Shutdown closes admission first, persists/fences active owner work, drains host
   registrations and workers, settles or marks unknown operations, and then releases
   process ownership. A client disconnect alone does not stop a supervised Run.

Only the supervisor holding the current `owner_epoch` may dispatch or reconcile
managed work. A restart increments the epoch and fences stale dispatchers. The
`hzcode` host may reconnect but cannot mint an epoch or claim ownership.

## 13.2 Service Definition and composition graph

Each service has one stable typed definition; consumers import the definition, not a
concrete implementation. The interface includes method schemas, authorization
requirements, ordering, lifecycle, limits and error model—not only a TypeScript
type.

```ts
type ServiceDefinitionV1 = {
  serviceId: string
  apiVersion: string
  schemaDigest: Digest
  cardinality: "one" | "many"
  replaceability: "sealed" | "startup_replaceable" | "hot_swappable"
  authority: "canonical" | "derived" | "advisory" | "presentation"
  executionClass: "kernel" | "host_trusted" | "presentation" | "wasm" | "restricted_process"
  capabilities: CapabilityDescriptor[]
  operations: OperationDescriptor[]
  readiness: "required" | "optional"
}
type ServiceOfferV1 = {
  serviceId: string
  version: string
  schemaDigest: Digest
  cardinality: "one" | "many"
  replaceability: "sealed" | "startup_replaceable" | "hot_swappable"
  authority: "canonical" | "derived" | "advisory" | "presentation"
  implementationRef: string // package digest + exported provider symbol; never downloaded source text
}
type ServiceRequirementV1 = {
  serviceId: string
  versionRange: string
  schemaDigest?: Digest
  cardinality: "one" | "many"
  optional: boolean
}
type OperationDescriptor = {
  operationId: string
  inputSchema: JsonSchemaRef
  outputSchema: JsonSchemaRef
  effectClass: "query" | "local_preference" | "guarded_effect" | "control"
  authorizationOwner?: string
  idempotency: "read_only" | "delivery_id" | "target_idempotency" | "not_retryable"
  maxInputBytes: number
  maxOutputBytes: number
  maxDurationMs: number
}
type CapabilityDescriptor = {
  capabilityId: string
  version: string
  operationIds: string[]
  resourceKinds: string[]
  executionLocations: string[]
  maxLeaseMs: number
  revocable: boolean
  scopeSchema: JsonSchemaRef
}
type CapabilityRequest = {
  capabilityId: string
  requestedScope: ArtifactRef
  purpose: string
  required: boolean
}
type HookEventContractV1 = {
  event: HookEventV1
  mode: "OBSERVATIONAL" | "BLOCKING"
  inputSchema: JsonSchemaRef
  resultSchema: JsonSchemaRef
  maxInputBytes: number
  maxOutputBytes: number
  maxDurationMs: number
}
type HookContributionV1 = {
  schemaVersion: 1
  hookId: HookId
  pluginId: string
  version: string
  packageDigest: Digest
  implementationRef: string // locked package export/handler, never inline source
  events: HookEventContractV1[]
  capabilityRequestDigests: Digest[]
}
type HookResultV1 =
  | { decision: "CONTINUE" }
  | { decision: "BLOCK"; reason: ArtifactRef }
type GlobalHookBindingV1 = {
  event: "before_compaction" | "after_compaction"
  hookId: HookId
  required: boolean
  ordinal: number
}
type GlobalHookResolutionV1 = {
  event: GlobalHookBindingV1["event"]; hookId: HookId; ordinal: number
  status: "RESOLVED" | "OPTIONAL_UNAVAILABLE"
  contributionDigest?: Digest; implementationDigest?: Digest; eventContractDigest?: Digest
  reasonCode?: string
}
type PluginManifestV1 = {
  manifestVersion: 1
  pluginId: string
  version: string
  packageDigest: Digest
  targets: Array<"host" | "tui" | "web" | "desktop" | "kernel-adapter" | "worker">
  trustClass: "sealed_system" | "first_party" | "presentation" | "wasm" | "external_process" | "opencode_compat" | "mcp" | "declarative"
  provides: ServiceOfferV1[]
  requires: ServiceRequirementV1[]
  optionalRequires: ServiceRequirementV1[]
  capabilityRequests: CapabilityRequest[]
  contributionRefs: ArtifactRef[]
  provenance: { source: string; publisher?: string; signatureRef?: ArtifactRef; digest: Digest }
  configSchema?: JsonSchemaRef
}
type CompositionLockV1 = {
  schemaVersion: 1
  generation: CompositionGenerationId
  profileId: string
  resolverVersion: string
  nodes: Array<{ pluginId: string; version: string; packageDigest: Digest; schemaDigests: Digest[]; contributionDigests: Digest[]; activationOrdinal: number }>
  providers: Array<{ serviceId: string; pluginId: string; providerRef: string; schemaDigest: Digest }>
  edges: Array<{ consumerPluginId: string; serviceId: string; providerPluginId: string }>
  approvedCapabilityDigests: Digest[]
  globalHookBindings: GlobalHookBindingV1[]
  resolvedGlobalHooks: GlobalHookResolutionV1[]
  configDigest: Digest
  activationOrder: string[]
  resolvedAt: Timestamp
  lockDigest: Digest
}
type CompositionGenerationStateV1 =
  | "CANDIDATE" | "ACTIVATING" | "READY" | "CURRENT" | "DRAINING"
  | "FAILED" | "QUARANTINED" | "RETIRED"
type CompositionGenerationV1 = {
  schemaVersion: 1
  generation: CompositionGenerationId
  lockDigest: Digest
  previousGeneration?: CompositionGenerationId
  state: CompositionGenerationStateV1
  activationReceipt?: ArtifactRef
  failure?: TypedErrorV1
  createdAt: Timestamp
  updatedAt: Timestamp
}
type CompositionStateV1 = {
  schemaVersion: 1
  currentGeneration?: CompositionGenerationId
  candidateGeneration?: CompositionGenerationId
  generationCounter: UInt64Decimal
  generations: CompositionGenerationV1[]
  plugins: PluginGenerationV1[]
  updatedAt: Timestamp
}
type PluginLifecycleStateV1 =
  | "STAGED" | "VALIDATED" | "ENABLED" | "ACTIVATING" | "READY"
  | "DRAINING" | "DISABLED" | "FAILED" | "QUARANTINED" | "REMOVED"
type PluginGenerationV1 = {
  schemaVersion: 1
  compositionGeneration: CompositionGenerationId
  pluginId: string
  packageDigest: Digest
  compositionLockDigest?: Digest
  configDigest: Digest
  capabilityApprovalDigests: Digest[]
  state: PluginLifecycleStateV1
  activationReceipt?: ArtifactRef
  failure?: TypedErrorV1
  createdAt: Timestamp
  updatedAt: Timestamp
}
```

Production sealed owner services are `hz.thread`, `hz.run-controller`, `hz.supervisor`,
`hz.usage`, `hz.budget`, `hz.guard`, `hz.effects`, `hz.audit`, `hz.workspace`,
`hz.verification`, `hz.artifacts`, `hz.secrets`, `hz.composition`, and
`hz.kernel-transport`. Sealed means production provider selection is fixed by the
product composition; it does not prohibit test adapters. `hz.repo-intelligence-owner`
and `hz.memory-owner` are also first-party canonical owners for their own
derived/advisory records, but neither gains authority over Guard or Run state.

`HookContributionV1` is the single registered contract for host, worker and
profile-bound lifecycle hooks. A plugin exposes its immutable contribution artifact
through `PluginManifestV1.contributionRefs`; CompositionService validates the schema,
unique `hookId`, package/provenance digests, event contracts and references to existing
manifest capability requests, then pins the contribution artifact digest in the
CompositionGeneration. Profiles bind only an event, `hookId` and requiredness; they
cannot embed implementation or widen the
contribution contract. There is at most one contract per event in a contribution.
Event input is bounded and schema-validated. `resultSchema` is the shared versioned
`HookResultV1` schema. Only `before_start`, `before_tool`, `before_finish` and
`before_compaction` may declare `BLOCKING`; every post-event is observational. A hook
may return `BLOCK` only on a declared `BLOCKING` event; on an observational event only
`CONTINUE` is accepted. The fixed `HookResultV1` result and any referenced reason
artifact are bounded by the contract. Unknown events, malformed results, timeout and
failure follow §14.8 and required/optional binding semantics; a required hook never
degrades silently. Capability-request digests resolve only to requests already declared
by the enclosing PluginManifest and do not constitute grants.

Global compaction hooks use explicit `globalHookBindings` in the existing lock, not
another registry or profile field. Trusted user/product composition may select them;
project text or package registration cannot silently activate one. For each event,
ordinals are unique nonnegative integers and bindings execute in ordinal order;
duplicate (event, hookId), unresolved required hooks, incompatible blocking guarantees
or unknown handler exports reject the candidate lock. Optional unavailable bindings
retain explicit resolution status. Empty bindings mean no global hook runs.
The lock digest covers ordered bindings and exact contribution/event/implementation
digests. Turns/compactions pin that immutable generation; changes apply only at a safe
successor operation. Draining/quarantine and Guard ceilings apply as for profile hooks.

`resolvedGlobalHooks` contains exactly one entry per binding in the same order.
RESOLVED requires all three digests; OPTIONAL_UNAVAILABLE requires a bounded reason
and is legal only for an optional binding. Required unavailability rejects publication.
The lock digest covers these resolutions as well as requested bindings. Compaction
admission pins the composition generation, lock digest and immutable resolved-hook-set
artifact; restart uses those pins, never current composition. Revocation/quarantine
still prevents executing an unsafe pinned hook and produces required failure or explicit
optional unavailability, not silent replacement by another contribution.

`ToolExecutionCoordinator` and `ExecutionHost` are sealed Rust kernel executor modules,
not owners of additional canonical streams. The former reports ToolBatch observations
to ThreadService; the latter performs leased operations and reports execution
observations to EffectService or RunController. Neither can commit Thread, Usage, or
Budget owner facts directly.

Per-call observations use this internal executor-to-owner Interface, not a new public
callback or event stream:

```ts
type ToolCallObservationV1 = {
  toolBatchId: ToolBatchId; toolCallId: ToolCallId
  ordinal: number; deliveryId: DeliveryId; observationDigest: Digest
  result: ToolResultV1
}
type ToolCallAcknowledgementV1 = {
  toolBatchId: ToolBatchId; toolCallId: ToolCallId; observationDigest: Digest
  resultCursor: Cursor
  dependentDispatch: "PERMITTED" | "WAITING_HOOKS" | "BLOCKED"
  hookSetDigest: Digest; hookReceiptRefs: ArtifactRef[]; error?: TypedErrorV1
}
```

ThreadService validates the observation against the admitted batch's call ID/order,
resource/effect receipts and pinned result schema, then commits the ordered result
link before returning an acknowledgement. Exact delivery retry returns the same
result cursor; conflicting result bytes are rejected. Acknowledgement is queried or
reconciled under the same delivery identity on response loss, never by replaying the
effect. Required post-tool hooks must settle before PERMITTED authorizes an unstarted
dependent call. Their failure records a bounded diagnostic and BLOCKED; the original
settled tool outcome is immutable. Unstarted dependent calls receive explicit typed
blocked/cancelled results before batch settlement. Independent in-flight calls settle
normally. The final ordered batch report contains exactly these committed observations;
it cannot replace/reorder them or bypass a WAITING_HOOKS/BLOCKED barrier. ThreadService
alone commits suspension/resumption/settlement, including explicit UNKNOWN outcomes.

The post-tool barrier is durable Thread owner bookkeeping linked to the result cursor,
hook-set digest and stable per-call delivery identity. Before dispatching hooks the
owner records WAITING_HOOKS; before releasing dependent work it commits PERMITTED or
BLOCKED with bounded completion/failure receipts. This is result/control bookkeeping,
not a canonical callback event or another hook stream. On crash, reconstruct the barrier
from owner facts and reconcile any linked uncertain hook effects. Do not reinvoke an
effectful hook or release dependents from absence of a receipt. Reexecution is permitted
only for a proven effect-free/idempotent invocation under its pinned contract; otherwise
keep the barrier unresolved and surface recovery. Lost acknowledgement replies return
the same committed barrier outcome; they do not rerun settled hooks/effects.
Uncertain hook effects keep WAITING_HOOKS with linked UNKNOWN owner outcomes; BLOCKED
does not certify their cancellation or settlement. `tool/post_hook_barrier_updated`
persists these control facts in the existing Thread stream (§§4/11), not callback events.

The host resolver may construct a candidate lock, but it submits that exact lock,
manifest digests, configuration digest and approval evidence to CompositionService.
The owner validates sealed-service constraints, capability grants, schema/API
compatibility, dependency graph and generation monotonicity, then durably commits the
lock before host activation. Host activation, disposal and health are runtime
observations linked to that committed generation; an activation failure records a
failed/quarantined outcome and never rewrites the prior lock or makes a partial graph
current. CompositionService publishes the new generation by one owner-committed
current-pointer transition only after every required host activation receipt is
validated. A failed candidate leaves the previous generation current. Replacing the
current pointer moves the old generation to `DRAINING`; it becomes `RETIRED` only
after all pinned consumers release, unless quarantined for an emergency revoke.

Required resolver algorithm:

1. Parse and schema-check every candidate manifest without executing it.
2. Apply user/project scope policy; project configuration may select but cannot
   replace sealed system providers or grant permission.
3. Resolve exact version/digest/API/schema for every provider and requirement.
4. Reject duplicate `one` providers unless an explicit trusted composition profile
   selects exactly one; order `many` providers by stable `(priority, plugin_id,
   package_digest)`.
5. Detect missing required edges, incompatible ranges, undeclared capability
   requests and cycles; report the complete deterministic cycle/path.
6. Produce a candidate immutable `CompositionLockV1` containing sorted node identities, package
   and schema digests, resolved edges, capabilities, config digest, generation and
   activation order. Hash the canonical lock bytes and submit it to CompositionService
   for validation and durable commit before activation.
7. Activate each provider in an owned `Scope`. On activation failure, dispose already
   activated nodes in reverse order; do not publish a partial generation.

Composition profiles are named, locked graphs, not separate service registries:
`base`, `terminal`, `desktop`, `headless`, `managed-work`, and `development`. Profile
inheritance is acyclic and expands to one final lock. `base` includes kernel bridge,
Thread adapter, provider runtime, direct runner, Guard/effect bridge, context,
artifacts, direct budget/reservation consumers and basic tools. `managed-work` adds
RunController consumers, managed worker fabric, workspace integration, hierarchical
Run budget consumers, verification and recovery. A profile cannot omit required
sealed services while retaining their dependent capabilities.

Plugin/service lifecycle is staged and generation-pinned. New work binds to the new
generation only after it is ready. Existing Turns/Attempts keep their generation;
disable first drains leases, then disposes registrations. Emergency quarantine
revokes new capability leases immediately and explicitly drives in-flight work into
failure/recovery. A UI green `enabled` flag must not conflate installed, trusted,
enabled, activated, healthy, available, permitted, or materialized states.

## 13.3 Private kernel protocol

The first protocol version is `HzKernelRpcV1`: length-prefixed MessagePack frames over
an OS-local private channel. Transport selection is platform-specific:

| Deployment | Preferred channel | Required peer check |
|---|---|---|
| Supervised same-user host/kernel | Inherited anonymous/duplex pipe or inherited socket pair | Handle inherited only by the intended child; bind handshake to supervisor nonce and process incarnation |
| Unix local attach | Unix-domain socket in owner-only state directory | Socket owner/mode, peer credentials, expected executable/process policy and handshake nonce |
| Windows local attach | Named pipe with explicit DACL | Client/server PID and token/SID validation, pipe ACL and handshake nonce |

No loopback/public TCP listener is allowed for kernel authority. A public HTTP route
on `hzcode` is a separate client surface and cannot expose arbitrary kernel methods.
Peer authentication identifies the host process, not the human caller by itself;
the application ingress binds an authenticated principal and scoped request context.
Never accept principal, policy, Task, owner epoch, or authorization claims from a
plugin/model as trusted RPC fields.

### Frame shapes

```ts
type KernelHelloV1 = {
  kind: "hello"
  minProtocol: number
  maxProtocol: number
  hostBuildDigest: Digest
  kernelBuildDigest?: Digest
  hostInstanceId: string
  processIncarnation: string
  supervisorNonce: string
  requiredFeatures: string[]
  optionalFeatures: string[]
}
type KernelHelloResultV1 = {
  kind: "hello_result"
  protocol: 1
  enabledFeatures: string[]
  unavailableOptionalFeatures: string[]
  supervisorNonce: string // exact nonce bound to the authenticated launch/channel
  processIncarnation: string // exact host incarnation from KernelHelloV1
}
type KernelHelloRejectedV1 = {
  kind: "hello_rejected"
  error: TypedErrorV1 // incompatible protocol or unavailable required feature
}
type KernelStartupStatusV1 =
  | { kind: "startup_status"; protocol: 1; state: "STARTING" }
  | { kind: "startup_status"; protocol: 1; state: "READY" }
  | { kind: "startup_status"; protocol: 1; state: "FAILED"; error: TypedErrorV1 }
type RpcRequestV1 = {
  kind: "request"
  protocol: 1
  requestId: string
  serviceId: string
  operation: string
  deliveryId?: DeliveryId
  expectedCursor?: Cursor
  deadlineUnixMs: number
  traceId: string
  body: unknown
}
type RpcResponseV1 = {
  kind: "response"
  protocol: 1
  requestId: string
  outcome: "ok" | "error"
  ownerCursor?: Cursor
  receiptDigest?: Digest
  body?: unknown
  error?: TypedErrorV1
}
type RpcEventV1 = {
  kind: "event"
  protocol: 1
  subscriptionId: string
  cursor: Cursor
  eventType: string
  payload: unknown
}
type RpcControlV1 =
  | { kind: "subscribe"; subscriptionId: string; ownerKind: string; ownerId: string; after?: Cursor }
  | { kind: "unsubscribe"; subscriptionId: string }
  | { kind: "ack"; subscriptionId: string; through: Cursor }
  | { kind: "cancel_request"; requestId: string }
  | { kind: "ping"; nonce: string }
```

The outer frame is `{length:u32be, payload:length bytes}`. V1 limits: 8 MiB encoded
frame maximum; 1 MiB decoded request/response body maximum; 256 KiB event payload
maximum; 64 KiB error/diagnostic details; no unbounded strings/arrays; nested
schema depth at most 64; deadlines at most 24 hours for durable managed operations
and 5 minutes for ordinary interactive calls. Artifact transfer uses a distinct
chunk operation with a 768 KiB maximum chunk body (so the full request stays under
the decoded-body bound), declared total length/digest, sequential offsets and an
owner-authorized ArtifactRef. An artifact is at most 256 MiB total; owner policy may lower
that ceiling, never raise it. Transfer limits may also be lowered by policy, never raised by
the caller. Oversize input is rejected before decode/allocation beyond the configured frame
ceiling.

The supervisor authenticates the exact OS peer/channel before accepting `KernelHelloV1`;
the nonce is an additional binding, not peer authentication. The kernel responds with
`KernelHelloResultV1` or bounded `KernelHelloRejectedV1`. The success response echoes the
authenticated-launch supervisor nonce and the exact host process incarnation from hello.
Handshake chooses the highest mutually supported protocol version. Required unknown
features fail startup with `TRANSPORT_INCOMPATIBLE`; optional features are listed as
unavailable. After successful negotiation, the kernel emits `KernelStartupStatusV1`
`STARTING` while it validates canonical owner state, acquires the owner epoch, reconciles
recovery, and readies required services. It emits `READY` only after those milestones, or
`FAILED` with a typed error and fences startup. The host sends no application request
before `READY`; the kernel rejects every application RPC received before it. None of these
frames asserts a human principal or authorization. Major version incompatibility never
falls back to an untyped or public transport. Schema/API changes are additive within a
major version only when old clients can safely ignore the field; changing owner semantics
or enum meaning requires a major protocol/schema version.

### Request and delivery semantics

- `requestId` correlates one in-flight exchange; it is not a durable deduplication ID.
- Mutations use stable `deliveryId` and payload digest. Same ID + same canonical
  payload returns the original committed receipt; same ID + different payload is
  `REPLAY_CONFLICT`. Every state transition also requires the expected owner cursor
  or aggregate version; `expectedCursor` may be absent only for operations whose
  contract explicitly declares no optimistic-concurrency precondition.
- Queries may be retried until deadline. Mutation retry is safe only through
  owner-side idempotency; caller timeout is not evidence of rejection.
- Each owner stream has its own `Cursor`; no global sequence is fabricated.
- Mutation responses identify the committed owner cursor and receipt digest. A missing
  response or absent/unknown commit result must be reconciled by retrying the
  same delivery ID or querying its receipt, never issuing a new ID blindly.
- A deadline expiring after dispatch returns `UNKNOWN_OUTCOME` if the owner cannot
  prove the command was not committed.
- Cancellation of an RPC request is advisory. It does not roll back a committed
  transition or external effect; effect/run cancellation uses typed domain commands.

No transaction spans independent owner streams or the event log plus projection
database. One owner validates, appends and durably commits its event; projections and
cross-owner work use cursors, stable IDs and explicit outboxes. Dispatch is claimed
with an owner epoch and lease. A process crash after an external launch but before
receipt yields `UNKNOWN_WORKER_LAUNCH` and reconciles the exact dispatch identity; it
does not create a second launch.

### Subscription and backpressure

Durable subscription is owner-scoped and starts after an exact cursor. The server
returns a snapshot cursor when requested, followed by committed events after that
cursor. If retained history no longer covers the cursor, return `RESNAPSHOT_REQUIRED`
and do not send a partial approximation. Client acknowledgements are flow-control
only; they do not delete canonical history. A bounded queue overflow terminates the
subscription with a typed gap marker and required resnapshot.

Token deltas, PTY bytes, UI focus, animation frames, high-rate indexing samples and
transient worker heartbeats do not traverse the durable kernel event stream. Provider
streams remain host-to-surface, frame-coalesced; complete provider-attempt boundaries,
validated tool batches, committed messages, UsageService observations and owner events
cross the kernel seam. Ephemeral subscriptions identify a visible gap after reconnect
and never claim replay.

## 13.4 Public application API

OpenCode Server/Protocol/SDK remains the public app surface. Horizon features are
added as typed, generated API groups under `/horizon/v1`; public request types never
expose internal file paths, database tables, bearer secrets, kernel handles or
unvalidated event append operations.

| API group | Read/query | Mutations |
|---|---|---|
| `threads` | list/get/search, messages, input queue, context epoch | create/rename/archive/fork, admit input, interrupt exact Turn |
| `projects` | project and repository members | create/edit bindings through validated actions |
| `goals` | drafts, preparation, review bundle, spec history | draft, prepare, answer clarification, approve exact review digest, revise |
| `runs` | summary, event cursor, timeline, tasks, proof pack, recovery | activate, pause, resume after reconciliation, cancel, stop-now |
| `tasks` | task/attempt/worker detail, evidence, dependencies | claim/assign where authorized, cancel exact Task/Attempt, request verification |
| `workspaces` | revisions, lease and conflict projections | acquire/release through owner, request integration, resolve conflict with previewed action |
| `effects` | pending approvals and settlement receipts | resolve exact challenge, request effect reconciliation |
| `agents` | profiles, capabilities, direct delegations and configured/observed/enforced state | version profile, probe, stage adapter, dispatch bound Task or native direct delegation through the appropriate owner |
| `providers` | catalog, route/capability and usage observations | select explicit route, connect through secret broker, request catalog refresh |
| `extensions` | plugin/service graph, provenance, lifecycle and diagnostics | stage/enable/disable/upgrade through lifecycle actions |
| `artifacts` | bounded metadata/read by authorized reference | create/attach/detach/export via owner-specific action |
| `memory` | search, scope generations, candidate/job status and provenance | remember/edit/tombstone/purge by scope, accept/reject exact reviewed candidate |
| `settings` | descriptors, requested/effective values, locks and pending apply state | validated setting change through the existing configuration Module and its declared apply boundary |
| `diagnostics` | read-only doctor, health and operational inspector | explicit registered repair action only |

The public API reports owner cursors and typed errors. List/search pagination uses a
stable opaque cursor bound to query digest, scope and projection generation. Any
write action is authorized by its owner at the point of effect; UI action availability
is advisory. Generated clients are derived from the public contract; private kernel
RPC schemas are not generated from public routes or hand-maintained in a second
package.

## 13.5 Existing source seams and implementation consequence

At the pinned OpenCode revision, Core V2 has schema/protocol/core/server/client
separation and an Effect-based `SessionRunCoordinator`; the coordinator is explicitly
process-local, keyed by Session ID, and its wake/drain is not a durable supervisor.
`SessionV2.prompt` persists admission before an advisory wake. This is useful host
behavior, but the Rust Thread owner remains the sole durable history and the kernel
Supervisor remains the only managed dispatch owner.

OpenCode's current public `Session` groups are the app API precedent; Horizon integration must
add a Horizon group and generated client, rather than handing a client the kernel
socket. Private RPC and public HTTP contracts are independently versioned because
their trust and lifecycle differ. The pinned source paths and reviewed ranges are
listed in `09-SOURCE-MAP.md`.

## 13.6 Contract and failure tests

The service contract kit must test every provider through the same typed interface:
valid/invalid schema, authorization at executor, state publication after commit,
bounded result encoding, cancellation, stale generation and deterministic errors.
IPC integration fixtures cover: peer identity/ACL refusal; protocol major mismatch;
unknown required feature; truncated/oversize frame; duplicate delivery; conflicting
delivery; commit then lost response; owner restart/epoch fencing; bounded subscriber
overflow; retention gap/resnapshot; projection lag; and kernel unavailable. A public
API test proves ordinary app clients cannot connect to private RPC or submit an
arbitrary event.

Executor fixtures additionally prove incremental result acknowledgement precedes
dependent dispatch, required post-hook failure dispatches zero unstarted dependents,
lost acknowledgements do not replay effects, and the final report cannot substitute
uncommitted or reordered results. Composition fixtures prove registration does not
activate a global hook, binding order is deterministic, required resolution fails
closed, and in-flight generations do not change. Direct delegation uses the same
Adapter contract kit but cannot fabricate Task/Attempt IDs or produce Task PASS.

Barrier fixtures crash after result commit/before invocation, during an effectful hook,
and after barrier completion/before acknowledgement delivery; uncertainty blocks
dependent dispatch without repeating effects. Compaction fixtures change current
composition or quarantine a contribution after admission, and replay an optional
unavailable resolution without substituting the current hook generation.
