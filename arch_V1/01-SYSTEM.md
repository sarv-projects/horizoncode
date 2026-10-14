# 1. System topology and authority

Status: normative V1 process/ownership architecture.

## 1.1 Product shape

HorizonCode is an OpenCode-derived coding-agent product with:
- existing OpenCode-derived Session, tool and application surfaces retained while provider transport remains an explicit replaceable seam;
- a supervised Rust kernel for managed control, authorization, recovery and verification;
- one progressive UX across TUI, web and desktop;
- optional supervised workers for index/LSP/DAP/browser/desktop/REPL/rendering/external agents.

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
