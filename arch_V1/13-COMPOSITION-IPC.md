# 13. Service composition and host/kernel IPC

Status: normative current V1 composition.

## 13.1 Processes

1. OpenCode host/API process
   - canonical Session/provider loop;
   - existing provider/auth/tool registries;
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

No second provider loop, Session database, effect engine or desktop shell is introduced.

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

The host exposes/read-mediates OpenCode Session events. Rust projection is read-only.

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
| Session/provider runner | OpenCode Core |
| Provider/model/account registry | Existing OpenCode/Horizon host |
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
