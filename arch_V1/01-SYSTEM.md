# 1. System topology and authority

Status: normative V1 process/ownership architecture.

## 1.1 Product shape

HorizonCode is an OpenCode-derived coding-agent product with:
- existing OpenCode-derived Session, tool and application surfaces retained while provider transport remains an explicit replaceable seam;
- a supervised Rust kernel for managed control, authorization, recovery and verification;
- one progressive UX across TUI, web and desktop;
- optional supervised workers for index/LSP/DAP/browser/desktop/REPL/rendering/external agents.

Under A-V2-31, the V1 release surface is Linux/WSL-first CLI/TUI. Web/desktop applications and browser/desktop control remain post-V1 and unavailable; their presence in this product-topology target does not make them V1 requirements or runtime capabilities. Built-in web search is V1 per `DEC-V1-26` (2026-10-18).

The product has one HorizonCode control plane. Create/Develop/Delegate/Operate views do not own separate runtimes; an explicitly selected native backend may own its own external Session without becoming a second Horizon control plane.

## 1.2 Process topology

User/TUI/Web/Desktop/CLI
-> HorizonCode public API/Core (OpenCode-derived)
-> provider transport seam (current packages/llm; staged OMP pi-ai/pi-catalog candidate)
-> canonical direct HorizonCode Session/messages
-> complete local tool-batch staging
-> Rust kernel Guard/EffectService/ExecutionHost for effects
-> supervised workers/OS targets.

Rust kernel separately owns managed Goal/Run/Task/Attempt/evidence and leases.

Derived services:
- ContextService;
- RepoIntel/indexd;
- Agent/Skill/Hook/MCP registries;
- BrowserBackend;
- DesktopActionService;
- WebSearchBroker;
- LanguageServiceBroker;
- DebugAdapterBroker;
- ReplBroker;
- Artifact/UiEvent services;
- Automation.

## 1.3 Canonical owners

| Domain | Owner |
|---|---|
| Direct Session/Input/Message/Part/continuation | HorizonCode Core (OpenCode-derived) |
| Provider/model/account transport/config | HorizonCode host; current OpenCode-derived implementation, staged A-V2-27 adapter seam |
| Goal/SpecVersion/Run/Task/Attempt | Rust kernel |
| ToolBatch authorization/control refs | Rust kernel |
| Effects/leases/receipts | Rust Guard/EffectService/ExecutionHost |
| Verification/evidence | Rust kernel |
| Resource/worktree/process leases | Rust kernel |
| Context view | ContextService; source history remains OpenCode |
| Repository index | RepoIntel/indexd derived store |
| UI/render | derived presentation only |
| Artifact bytes/metadata | authorized artifact store |
| Automation schedule/control | Rust automation owner |

No two writable owners.

## 1.4 Direct and managed modes

Direct:
- normal pair coding;
- no required Goal;
- effects still Guarded.

Managed:
- explicit Goal/accepted SpecVersion;
- durable Run/Task/Attempt;
- recovery and independent verification.

A Session can outlive a Run and a Run can reference a Session without owning its transcript.

## 1.5 Persistence

OpenCode persistence remains canonical for conversational data.

Rust OwnerLog persists only Rust-owned aggregates and correlations.

Derived indexes/UI caches may always be rebuilt from source owners and must never be treated as source truth.

## 1.6 IPC

Host/kernel communication is private authenticated local IPC, versioned and bounded. See 13.

No public kernel listener, no FFI authority shortcut.

## 1.7 Effect boundary

Every mutation, regardless of origin, uses:
resolve canonical action/target -> Guard/policy/approval -> durable prepare -> one-use lease -> ExecutionHost/worker -> observation -> receipt/reconciliation.

Origins such as user, model, plugin, MCP, browser, automation, LSP, DAP or REPL do not grant authority.

## 1.8 Provider/model/harness law

Provider/model/harness are separate concepts.

User selection is stable unless an explicit configured fallback authorizes a change. Cost/auth provenance is visible. Local/free models are first-class.

## 1.9 Extension law

Skills/hooks/MCP/plugins can contribute functionality and presentation, but:
- sealed built-in IDs cannot be shadowed;
- extension code is capability-limited;
- extension tool effects cross the same Guard;
- extension state cannot replace canonical Session/Run/effect stores.

## 1.10 Performance law

The direct coding path must not pay managed-work overhead unless needed. Indexing/rendering/analytics use asynchronous bounded derived lanes. UI keystrokes and streaming cannot block on durable analytics.

## 1.11 Implementation map

Exact existing package/service placement is 20 and runtime interfaces are 37. Capability names are 33. Current implementation status is HANDOFF.md.

## 1.12 Multi-session resource topology and isolation

**Observed versus target:** current `packages/core/src/session/supervisor.ts` spawns one Linux Rust `session_supervisor` process for each watched Session; `kernel/src/bin/session_supervisor.rs` is a one-connection observer/effect endpoint. The desired shared Rust kernel in §1.2 is architecture, **not evidence of an already deployed daemon**.

A benchmark-gated shared process shall multiplex authenticated SessionLink observation, owner-epoch fenced Rust managed control and pre-authorized effects without owning Core transcripts or creating another scheduler. Each virtual Session scope holds its own principal, workspace binding, cursor, epoch, subscriptions, quotas, cancellation generation, permitted capability set and durable effect correlation. Shared object/index/provider-client caches are immutable, owner-scoped or safe to share; sensitive per-session contents and secret references must never cross scopes. Reconnect and restart restore from canonical owners, not UI state.

Separate process isolation remains mandatory for untrusted execution (shell/build/test, plugin/MCP where required, browser/REPL/LSP/DAP/local inference), with OS-backed containment, process-tree accounting and bounded cleanup. Do not replace a security boundary with in-process checks only. One session's malformed frame, CPU-heavy subscription, infinite output, dead worker or failure must not monopolize the daemon or cause cross-session data leaks. Admission remains fail-closed if the kernel/Guard is unavailable.

Architecture choice is decided by comparable task outcomes **and** PSS/private footprint, cold start, p95 input latency, fault containment, restart/cancel and authorization tests. Preserve the existing supervisor interface during migration and keep a rollback path. See §13.11, §18.17 and §32.32.

## 1.13 Reference HLD — actual authority and target execution lanes

The following is the **target composition** for post-RC1/R2, not a deployed architecture claim. The existing Linux implementation starts one Rust `session_supervisor` per watched Session and supports guarded `files.write` only (§20.12). Shared virtual attachments and generic process ExecutionHost must be implemented and verified before replacing it.

~~~mermaid
flowchart TD
  UI["TUI / GUI / CLI / SDK<br/>Derived UI state + user intent"]
  CORE["HorizonCode Core<br/>Canonical direct Session / Messages / Parts"]
  PROV["Selected Provider Transport<br/>pinned account/model/harness"]
  CTX["ContextService + indexd<br/>derived context, immutable index, scoped recall"]
  GATE["Complete ToolBatch validation<br/>request-pinned registry"]
  KERNEL["Authenticated Rust kernel<br/>Guard / EffectService / OwnerLog"]
  MGR["Rust managed control<br/>Goal / SpecVersion / Run / Task / Attempt"]
  WPOOL["Resource-aware WorkerExecution<br/>leases / workspace pool / DAG"]
  EXEC["ExecutionHost + supervised OS workers<br/>process/container/job isolation"]
  MET["ResourceSampler / paint metrics<br/>derived, bounded, redacted"]
  STORE["SourceArtifact and receipt refs<br/>durable by owning store"]
  UI --> CORE
  CORE <--> PROV
  CORE <--> CTX
  PROV --> GATE
  GATE --> KERNEL
  MGR --> KERNEL
  MGR --> WPOOL
  WPOOL --> KERNEL
  KERNEL --> EXEC
  EXEC --> STORE
  KERNEL --> STORE
  CORE --> UI
  MET -. observe .-> CORE
  MET -. sample .-> EXEC
  MET -. sample .-> KERNEL
~~~

**Owned durable lane:** Core canonical Session history and Rust OwnerLog control/effect/verification records are separate stores. Every effect is Guarded and has a single Rust owner; user/model/provider/worker process is an origin, not authority. **Derived lane:** index, context/recall projection, file touches, process metrics, UI tail and paint caches can be reconstructed or evicted. **OS trust lane:** untrusted subprocesses remain isolated even if a shared Rust kernel multiplexes authenticated SessionLink subscriptions. **Hot path:** ordinary direct read/edit does not create managed Run/Task; UI and sampling never block keystrokes or overwrite durable event ordering. **Native external backend:** optional explicit native OpenCode client owns its own upstream Sessions only, linked via a bounded adapter, never combined with the same Horizon direct Session writer.

Lifecycle ordering: start trusted host → private kernel hello/peer authentication → negotiate supported capabilities/OS guarantees → rehydrate OwnerLog and reconcile uncertain effects → attach canonical Session source cursors → optionally run direct turn or accept managed SpecVersion → admit worker budget+Guard lease → execute/settle/verify → UI/cost metrics projection. Kernel unavailable means fail closed for effects; keep source-safe UI and read-only operations only if verified. UI disconnect does not prove managed work stopped.

The enforceable contracts are §11.20 state transitions, §12.16 machine schema inventory, §13.12 IPC, §14 effect law, §18.18 pressure state, §21.11 worktree/worker algorithm, §29.18 dataflow, §30.21 context, §31.17 renderer and §37.17–19 proposed interfaces. §32.33–34 is verification. No separate HLD file may override these topic owners.

## 1.14 Evidence-bound managed delegation HLD (A-V2-33)

Managed delegation is a flow across the existing owners. It does not add a delegate daemon, index authority, event bus or verifier trust root.

~~~mermaid
sequenceDiagram
  participant UI as TUI
  participant Core as HorizonCode Core
  participant Owner as Rust Managed OwnerLog
  participant Guard as Guard / ExecutionHost
  participant Repo as RepoIntel (read only)
  participant Store as ArtifactStore
  participant Verify as Independent Verifier
  participant Mux as UiEventMux projection
  UI->>Core: accepted SpecVersion and reviewer action
  Core->>Owner: authenticated Attempt admission
  Owner-->>Core: immutable DelegationBinding + current owner cursor
  Core->>Repo: bounded generation/revision-bound query
  Repo-->>Core: source refs, coverage and freshness
  Core->>Guard: action with Attempt scope + binding digest + one-use lease
  Guard->>Owner: resolve live binding, budget, workspace and capability state
  Guard-->>Core: receipt or UNKNOWN
  Core->>Store: immutable artifact capture after settled effect
  Core->>Owner: attach evidence to exact source revision
  Owner->>Verify: criteria, source revision and trusted artifact refs
  Verify->>Owner: independent verdict and evidence
  Owner-->>Mux: durable owner cursor events
  Core-->>Mux: bounded ephemeral progress
  Mux-->>UI: replayable decisions/evidence + coalescible progress
~~~

The owner cursor is authoritative for durable transitions; UI progress is only a projection. Every action checks the immutable binding digest and current expected owner revision independently. RepoIntel returns read references only. Artifact and verifier inputs bind to exact source digests and a fresh workspace observation. A stale reference, missing lease, untrusted verdict, receipt loss or unresolved UNKNOWN halts settlement and finalization. Details and acceptance are §§3.21, 4.13, 12.18, 32.38 and 37.22; effectful dispatch remains unavailable until P1 and P7 prerequisites pass.
