# 01 — Vision

## What agentX is

A standalone command-line coding agent that a developer runs in a repository and trusts with **long-running, multi-step work**. It is one self-contained binary, it speaks open protocols (ACP, MCP), and its differentiating layers are built first-party rather than assembled from another product's core.

## Who it is for

- Engineers who delegate real, hours-long tasks — cross-repo refactors, migrations, audits — not one-shot edits.
- Teams that require deterministic policy, verifiable execution history, and self-hosting.
- Users who want provider freedom: any hosted model, any local model, any OpenAI-compatible endpoint.

## Why it wins (the five axes)

Every major peer converges on the same commodity shape: a reasoning loop, native tools, and MCP. Parity there is table stakes. agentX wins by owning five things the field either ships closed or does not ship at all:

1. **Long-horizon persistence.** Durable, event-sourced sessions that survive crash and restart; checkpoint and rewind; a persistent task graph; resumable work. *Built for hours, not turns.*
2. **Deterministic policy-as-code + verifiable audit.** An allow/ask/deny guard expressed as configuration, failing closed; plus an append-only, tamper-evident (hash-chained/Merkle) execution log. No leading peer ships both.
3. **Context that survives scale.** A repository map, language-server symbols, and indexed navigation feeding an eval-gated compaction engine — so a fifty-file cross-repo task completes without losing the thread.
4. **Eval-gated routing with published numbers.** Cheap models for locate, mid-tier for edit, frontier for plan/verify — chosen by measured results, with the scores public.
5. **Open, self-hosted parallel orchestration.** Isolated sub-agents on worktrees, receipts instead of transcripts, deterministic merge arbitration, and CI feedback — capabilities currently locked inside closed products.

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
