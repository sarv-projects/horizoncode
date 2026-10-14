# 13. Service composition and host/kernel IPC

Status: normative current V1 composition.

## 13.1 Processes

1. HorizonCode host/API process (OpenCode-derived)
   - canonical direct Session/continuation loop;
   - current provider/auth/tool registries behind an explicit provider-transport seam;
   - TUI/web/desktop/server composition;
   - host-local read/query adapters.

2. Rust hz-kernel supervised process
   - managed Goal/Run control;
   - Guard/EffectService/ExecutionHost;
   - durable owner log for Rust-owned aggregates;
   - resource/worktree/process leases;
   - verification/evidence;
   - automation control.

3. Supervised workers
   - shell/build/test;
   - LSP/DAP;
   - browser/desktop;
   - persistent REPL;
   - renderer/index helpers;
   - external agent adapters.
   Workers never receive authority beyond explicit lease/capability scope.

In direct mode, no second provider loop, Session database, effect engine or desktop shell is introduced. A-V2-27's optional native OpenCode backend is an explicit external Session owner behind an adapter, not a second direct-mode Horizon runtime.

## 13.2 Startup

1. Host resolves config/state roots without exposing secret bytes.
2. Host creates a private kernel endpoint and starts the pinned kernel binary.
3. OS peer authentication succeeds.
4. Hello negotiates protocol/features/nonce/incarnation.
5. Kernel opens/recover Rust-owned stores and reports STARTING.
6. Session observer validates source cursor/snapshot/replay as required.
7. Kernel reports READY with supported capabilities.
8. Host exposes only capabilities whose required owners are READY.

Application/effect RPC is rejected before READY.

Shutdown:
- stop new admissions;
- cancel/settle bounded workers;
- reconcile unknown effects;
- persist owner cursors;
- release owned resources;
- close kernel endpoint.

## 13.3 Private protocol

Private transport is authenticated local IPC using bounded length-prefixed MessagePack HzKernelRpcV1.

Every frame carries:
- protocol version;
- request/event ID;
- caller/service;
- owner epoch/incarnation;
- payload type;
- payload byte bound/checksum where required.

Unknown message/version/oversize payload fails closed.

## 13.4 Session observation

The host exposes/read-mediates events from the owning Session backend. The current direct source is OpenCode-derived; a native adapter maps its separate upstream Session stream. Rust projection is read-only.

Subscription contract:
- SessionLink identity;
- source cursor and epoch;
- bounded page;
- exact page-end cursor;
- ACK only completed pages;
- hasMore/retention-gap/resnapshot result;
- redaction scope.

Restart replays from last completed ACK. Partial pages are never advanced.

## 13.5 Effect mediation

The provider loop proposes tool calls; host validates request-pinned schemas and complete-batch structure.

For any effectful action:
1. host sends the whole proposed ToolBatchControl to kernel;
2. Guard returns DENIED/NEEDS_APPROVAL/ADMITTED;
3. kernel PREPAREs EffectIntent and one-use leases;
4. ExecutionHost/authorized worker performs the action;
5. worker reports bounded observation;
6. kernel settles receipt or UNKNOWN;
7. host records conversational tool result in OpenCode.

No Bun/worker/plugin side-channel may perform the same effect outside this path.

## 13.6 Service placement

| Service | Owner/process |
|---|---|
| Direct Session/continuation runner | HorizonCode Core (OpenCode-derived) |
| Provider/model/account registry/transport | HorizonCode host; current OpenCode-derived path, staged A-V2-27 migration |
| Action/tool presentation catalog | Host projection from canonical capability registry |
| ContextService | Host-facing service; canonical conversation remains OpenCode |
| RepoIntel | indexd/host derived service |
| AgentProfile/Harness/Skill/Hook/MCP registries | Host config/registry with kernel effect enforcement |
| Guard/EffectService/ExecutionHost | Rust kernel |
| Goal/Run/Task/Verification | Rust kernel |
| Resource/worktree/process leases | Rust kernel |
| Browser observation adapter | supervised host/worker; effects via kernel |
| Desktop backend | supervised OS worker; effects via kernel |
| WebSearch broker | host/service adapter; network/cost policy via Guard/config |
| LanguageServiceBroker | host/supervised worker; mutations via Guard |
| DebugAdapterBroker | supervised worker; attach/evaluate/mutation via Guard |
| ReplBroker | supervised bounded worker; callbacks via canonical actions/Guard |
| Artifact store | authorized durable service |
| UiEventMux/rendering | derived host/TUI/app plane |
| Automation scheduler/control | Rust durable owner plus host action invocation |

## 13.7 Public API

Keep OpenCode public Session/API compatibility. Add Horizon managed-control routes rather than replacing Session routes.

Public clients never receive private kernel capability leases or raw SecretBroker material.

## 13.8 Capability negotiation

Kernel/worker capability report includes:
- service/version;
- OS/backend;
- supported operations;
- containment dimensions;
- max bounds;
- unavailable reason.

The UI/catalog shows unavailable rather than emulating unsupported privileged behavior.

## 13.9 Failure rules

- kernel loss: pause managed admissions/effects, keep safe direct read-only UI where possible;
- host loss: kernel fences host epoch and stops orphan admissions;
- worker loss: mark owned operation failed/unknown and reconcile;
- retention gap: resnapshot Session projection;
- protocol mismatch: fail startup capability, no compatibility guess;
- duplicated request/idempotency key: return existing durable outcome;
- cancellation race: persist fence then reconcile already-started work.

## 13.10 Contract tests

Required:
- peer-auth rejection;
- wrong nonce/incarnation;
- protocol/version/oversize rejection;
- restart/replay/ACK;
- stale epoch;
- cross-session/cross-scope denial;
- complete ToolBatch admission before effect;
- worker cannot execute without lease;
- lease replay rejection;
- kernel/worker crash and UNKNOWN reconciliation;
- supported/unavailable capability negotiation.

Runtime status is tracked in HANDOFF.md, not in this chapter.

## 13.11 Shared-kernel candidate and virtual session wire contract

The deployed Linux observer is currently one child process per Session. Evaluate a single, reusable `hz-kernel` service *behind* `SessionSupervisor.Service`, not a parallel provider/execution runtime. Initial prototype may multiplex read-only SessionLink subscribers before guarded writes; do not cut over effect execution without complete Guard parity.

- Host-to-kernel connection: authenticated OS peer, negotiated protocol/features, app installation, owner epoch and revocable session attachment. Neither a client-supplied `sessionID`, workspace path, principal, effect origin nor an opaque route may confer authority.
- Virtual owner table: `{sessionId, hostEpoch, incarnation, sourceCursor, workspaceBinding, policyRevision, resourceLeaseSet, cancelGeneration, limits}`; each request binds its authenticated connection plus virtual owner. Every subscription/ACK/approval/effect/result is checked against that binding. Cross-session ID substitution is denied and audited.
- Scheduling: bounded per-session mailboxes, fair queues, backpressure and priority for cancellation/receipts; global overload must reject new work with a typed outcome rather than buffering indefinitely. Durable control/effect events never disappear because UI paints were dropped.
- Crash semantics: an individual worker fault becomes its owner's FAILED/UNKNOWN state; a kernel crash fences all active leases, restarts under a new epoch, revalidates canonical state and reconciles unsettled effects before re-admission. Never treat transport disconnect as proof an external effect did not execute.
- Workers: separate OS processes for trust, filesystem/network isolation and interruptible execution. Process-tree owner identifiers and resource accounting attach to each WorkerExecution/Attempt; worker capacity respects §21 and §18.
- Rollout: reference existing per-session process path, shared read-only prototype, negative isolation tests, same-machine benchmarks, feature/capability negotiation, Linux qualification, then macOS/native Windows qualification. Windows named-pipe/ACL and storage semantics need independent proof; WSL results do not qualify native Windows.

The machine schema must be versioned through §12/§13 protocol ownership; do not install a second self-asserting actor registry.

## 13.12 Wire-level shared-session migration sequence and race handling (A-V2-30)

**No second private protocol.** Extend current authenticated, length-prefixed MessagePack `HzKernelRpcV1` only through a feature-negotiated, versioned operation family. Existing constants in `kernel/src/protocol.rs` include `PROTOCOL_V1 = 1`, `MAX_BODY_BYTES = 1 MiB`, `MAX_EVENT_PAYLOAD_BYTES = 256 KiB`, `MAX_IDENTIFIER_BYTES = 256`, and interactive/durable deadline caps. Respect those hard limits; do not silently expand them for new telemetry/batches. Current `SessionSupervisorClient` provides `resumeCursor/subscribe/receive/ack/unsubscribe/stop/request`, plus `SessionSupervisor.Service.openForSession/watchSession/prepareToolBatch/approveEffect/executeWrite`. Keep that host API working through an adapter.

**Proposed virtual-attachment operations** (reserve names under one negotiated feature such as `sessions.virtual.v1`; these are not in the current Rust dispatch yet):

| Operation | Caller → owner | Request binding | Durable or derived result |
|---|---|---|---|
| `attach` | authenticated host → kernel | host build digest, peer identity, source store/instance, Session ID, workspace handle binding, policy revision, requested capabilities | revocable virtual attachment ID, owner epoch, authenticated scope, bounded cursor/window |
| `subscribe_page` | host → kernel projection | attachment+source epoch+afterCursor+maxEvents+credit | ordered scoped events+pageEnd/retention-gap |
| `ack_page` | host → projection | attachment+page ID+exact completed cursor | idempotent ACK or STALE; no partial advancement |
| `detach` | host → kernel | attachment ID+epoch | drain subscriptions, revoke future ingress, **do not** cancel unrelated Run unless policy requests |
| `cancel_scope` | trusted host → kernel | request/Attempt/Run ID+epoch+generation, authenticated owner | durable cancellation fence followed by best-effort signal and settlement |
| `resource_snapshot` | scoped diagnostic caller → adapter | owner+metric set+age/deadline+bounded history | derived measured/unknown with redaction, never lease granting |
| `effect_prepare/dispatch/reconcile` | existing guarded API bridge | same batch/intent/lease binding and single-use semantics as current §14 | Rust durable owner only, enabled **after** universal P1 proof |

**Attach algorithm:** validate peer OS credentials and installation/build identity, then resolve Session/workspace identity from trusted host-owned mapping; caller cannot assert its own policy/principal. Allocate monotonically increasing attachment generation and opaque ID. Register bounded source cursor/queue credits, verify feature capability/OS support, report READY. A duplicate attach with the **same authenticated idempotency key and identical binding** returns existing attachment; changed binding fails CONFLICT. A stale attachment cannot be revived by choosing a new opaque ID without reauthentication.

**Event order:** source owner emits ordered cursor → broker buffers bounded records per attachment → page boundary/checksum → client receives full page → client commits canonical projection page → client ACKs exact end cursor → broker releases page credits. Reconnect resumes from the last completed ACK; if retention gap, perform authenticated resnapshot and invalidate stale UI/read caches. A partial page or timeout advances **no** cursor. One slow Session must not block another; enforce fair credits and per-attachment output quotas.

**Priority order:** durable cancellation/lease revocation/receipt acknowledgement > Guard mutation admission > Session snapshot/control > derived telemetry/paint. Use bounded weighted fair scheduling, **not** a global FIFO where a noisy Session starves cancel. Reject with typed queue capacity status when full; never queue an unbounded full prompt/raw tool stdout in Rust.

**Crash/fence:** kernel supervisor incarnation rotates; all attached generations and leases from old incarnation reject. A new kernel reads Rust OwnerLog first, recovers unsettled effects as UNKNOWN, then reestablishes source projections from canonical Session backend. External process receipts use OS process-start identity/launch nonce, never PID alone. A daemon crash must not trigger blind replay of an external effect. A host crash revokes its owner epoch and only its authenticated attachments; unrelated users/workspaces remain contained.

**Migration sequence:** (1) retain one-per-Session Linux child baseline; (2) add read-only multiplex feature negotiated with existing API; (3) prove concurrent attach/ACK, mixed authorization scopes, 20 Sessions, crash and slow-consumer protection; (4) explicitly compare process-tree PSS, RAM/fault containment and task correctness; (5) route one guarded effect class via proven shared broker; (6) progressive opt-in and rollback, Linux first, then native Windows/macOS. If shared service fails, revoke/settle existing leases **before** reconnecting to per-Session fallback; do not dual-run old and new effects. Signed binaries, install state and private socket ACLs remain release gates.
