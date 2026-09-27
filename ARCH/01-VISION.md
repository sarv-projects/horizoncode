# 01 — Vision

## What HorizonCode is

A terminal-first coding agent that a developer runs in a repository and can trust with **long-running, multi-step work only after the acceptance evidence exists**. Its core is packaged as one Rust binary per platform; sandbox, Git, language-server, local-model, and detached-worker capabilities may require host services that are probed and disclosed. It speaks open protocols (ACP, MCP), and its differentiating control plane is built first-party (`DEC-029..031`).

## Who it is for

- Engineers who delegate real, hours-long tasks — cross-repo refactors, migrations, audits — not one-shot edits.
- Teams that require deterministic policy, verifiable execution history, and self-hosting.
- Users who want provider freedom: any hosted model, any local model, any OpenAI-compatible endpoint.

## Candidate differentiators to prove

These are product hypotheses, not current benchmark results. The priority is verified multi-hour completion; cost, latency, integrations and usability are measured alongside it (`DEC-029`, `ARCH/25`). Public peer research is summarized in `ARCH/24` with its evidence limits.

1. **Long-horizon persistence.** Durable, event-sourced sessions, a separately persisted run/task graph, checkpoints and reconciled restart.
2. **Deterministic policy and inspectable audit.** An allow/ask/deny guard, confinement and per-effect receipts with explicit anchoring limits.
3. **Repository context with freshness.** Revision-bound maps, symbol navigation and eval-gated compaction that preserve task evidence across large changes.
4. **Measured model routing.** Route selection by demonstrated task outcomes, capabilities and total cost, including local models when conformance is proven.
5. **Open parallel orchestration.** Isolated worktrees, external-agent attempt tracking, fenced leases, independent verification and integration checks.

## Signature surfaces

- **Long-horizon cockpit.** A dockable, extensible pane (VS Code-style: drag, dock, collapse, remove, top-right toggles) that shows the whole worktree, live git diffs with colored highlights, and lets the user view **and edit** files in-terminal with an embedded mini-editor. It is the user's persistent "state of the world" during long runs.
- **Portable sessions.** Every session is a durable, movable, replayable artifact from day one.
- **Protocol-first.** Drives and is driven by other agents over ACP; integrates tools over MCP.

## Non-goals

- Not a web product, not a hosted service, not a cloud IDE.
- Not a general chat client.
- Not an editor or IDE replacement; it is a terminal agent with an in-terminal file surface.
- Not a re-implementation of a peer's codebase; peer designs inform ours, they do not constitute it.
- No second orchestration engine, provider registry, or permission system — one of each.

## Design principles

1. **Own the control plane; vendor the leaves; reimplement the moat; use protocols as seams.**
2. **Truthful state.** No fake progress. A spinner means a real operation is in flight; timers reflect real elapsed time.
3. **Fail closed.** Unknown permission, unknown license, unknown capability ⇒ deny or refuse, never allow by default.
4. **Prove it.** A capability is not complete without executable evidence.
5. **Smallest justified change.** Prefer the existing owner and interface over a new abstraction.
