# Vision

## What HorizonCode is

A terminal-first coding agent for both fast interactive work and long-running, multi-step work. An ordinary turn can explain code, locate behavior, debug a failure, make a focused edit, run a relevant check, inspect the diff, and continue from a natural-language prompt. Managed Runs add durable planning, bounded unattended execution, recovery, and independent verification when the user asks for them or the task warrants them. The user chooses the managed host: a laptop/workstation or a user-managed server. Its core is packaged as one Rust executable per platform where feasible; sandbox, Git, language-server, local-model, and detached-worker capabilities may require host services that are probed and disclosed. It speaks open protocols (ACP, MCP), and its first-party control plane supports both everyday turns and managed work (`DEC-029..031`, `DEC-046`). A server deployment is self-hosted/headless use, not a required HorizonCode-operated cloud service.

## Who it is for

- Developers who want a capable coding agent for everyday questions, focused edits, debugging, and checks, as well as multi-step refactors, migrations, and audits.
- Teams that require deterministic policy, verifiable execution history, and deployment on infrastructure they control.
- Users who want a broad choice of hosted and local providers. A route is usable only
  when its authentication flow and concrete model/server/template capabilities have
  been documented and pass the applicable conformance checks; API compatibility or a
  catalog entry alone does not establish support (`REQ-PROV-001`, `REQ-PROV-006`).

## Product outcomes

Fast interactive coding and dependable long-horizon execution are co-equal requirements. Validate verified task success, regression rate, latency, total cost, permission friction and usability on representative tasks.
1. **Long-horizon persistence.** Durable, event-sourced sessions, a separately persisted run/task graph, checkpoints and reconciled restart.
2. **Deterministic policy and inspectable audit.** An allow/ask/deny guard, confinement and per-effect receipts with explicit anchoring limits.
3. **Repository context with freshness.** Revision-bound maps, symbol navigation and eval-gated compaction that preserve task evidence across large changes.
4. **Measured model routing.** Route selection by demonstrated task outcomes, capabilities and total cost, including local models when conformance is proven.
5. **Open parallel orchestration.** Isolated worktrees, external-agent attempt tracking, fenced leases, independent verification and integration checks.
6. **Atomic resource governance.** Reserve nested Run/Task/Attempt/worker, verification, recovery, event, and artifact ceilings before dispatch; concurrent workers cannot each spend the same remaining allowance (`REQ-HORIZON-003`).
7. **Mediated egress with honest claims.** State required enforcement level, mechanism, backend and residual; reject unsupported guarantees and prove actual connected destinations per tier.
8. **Bounded control delivery.** Bounded queues, prompt cancel/permission latency, durable cursors, and explicit gap/resnapshot or disconnect behavior (`REQ-HORIZON-013`). A bounded queue is a product choice with an explicit memory ceiling and overflow contract; it must not trade away liveness silently.
9. **Whole-response tool admission.** Validate and bound the complete provider tool-call batch before dispatching any call, preventing partial admission when a response is oversized or contains a user-input boundary (`ARCH/core/TOOLS.md`, `ARCH/execution/LONG-HORIZON.md`).
## Signature surfaces

- **Direct coding loop.** Ordinary turns start from a prompt and move directly through
  explanation, exploration, edits, checks, diff review, and correction; no goal, plan,
  or Run review is a prerequisite. Managed Runs remain available when useful.
- **Long-horizon cockpit.** A dockable, extensible pane that shows the worktree,
  live Git diffs, and a governed file-inspection/editing flow. Editing has a governed
  in-terminal path and an external-editor handoff; an embedded mini-editor is an
  optional implementation choice, not a product dependency (`REQ-UI-005`). It is the
  user's persistent view of run state during long work.
- **Portable conversations.** Every HorizonCode Thread is a durable, movable, replayable conversation artifact. This does not make its associated managed Run portable; Run/task/evidence export is a separate explicit bundle with new identity and no transferred authority (`ARCH/core/SESSION-AND-THREADS.md`, `ARCH/execution/LONG-HORIZON.md`, `ARCH/product/ARTIFACTS.md`).
- **Protocol-first.** Drives and is driven by other agents over ACP; integrates tools over MCP.
- **User-selected execution host.** Runtime, state, and workspaces stay on the laptop or server chosen by the user. A provider receives only the request/context required by the selected route and policy. Remote UI attachment is a separate capability and is not implied by deploying headlessly on a server.

## Non-goals

- Not a HorizonCode-operated hosted service or cloud IDE. Users may run the headless agent on a server they control.
- Not a general-purpose chat client; direct coding questions and explanations are part of the coding workflow.
- Not an editor or IDE replacement; it is a coding agent with Explorer/diff surfaces and native-editor handoff.
- Not a re-implementation of a peer's codebase; peer designs inform ours, they do not constitute it.
- No second orchestration engine, provider registry, or permission system — one of each.

## Design principles

1. **Own the control plane; vendor the leaves; reimplement the moat; use protocols as seams.**
2. **Truthful state.** No fake progress. A spinner means a real operation is in flight; timers reflect real elapsed time.
3. **Fail closed.** Unknown permission, unknown license, unknown capability ⇒ deny or refuse, never allow by default.
4. **Prove it.** A capability is not complete without executable evidence.
5. **Smallest justified change.** Prefer the existing owner and interface over a new abstraction.
## Operating tempos

HorizonCode serves two operating tempos: fast interactive pair coding in ordinary
Threads, and managed Runs that may span hours or days. Terminal-first describes the
delivery surface, not a chat-only layout: the same three-pane workspace may adapt its
content to Pair, Mission Control, Review, or Explore. A verified Run should expose a
task graph and an inspectable Proof Pack, not require the user to reconstruct status
from terminal scrollback. Models, providers, workers, protocols, workspaces, and
execution environments are replaceable behind HorizonCode-owned contracts; the user's
software job and its approved intent remain canonical. These are target
capabilities (`DEC-083..089`, `ARCH/product/UI.md`, `ARCH/execution/LONG-HORIZON.md`).

## First-use clarity

The first screen offers a useful composer, selected workspace, and one next action.
Ordinary requests use the direct coding path; managed goals, workflow builders,
dependency graphs, and proof inspectors are discoverable optional depth. Default
surfaces explain the requested outcome, changed files, checks, blockers, and next
step in plain language. IDs, hashes, transport mechanics, storage counters, and full
tracebacks belong in detail inspectors. Material permissions, cost uncertainty,
verification failures, and unsafe recovery must remain visible. These defaults are
product hypotheses to validate with the usability acceptance plan, not measured
claims about what all users prefer.

## Interaction quality

Ordinary coding remains prompt-led: exact paste/images and inspectable artifacts improve daily interaction. Attractive themes and restrained feedback serve legibility; measured speed is a product requirement, not an unverified superiority claim.
