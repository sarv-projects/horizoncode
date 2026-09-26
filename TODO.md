# TODO — agentX Delivery Tracker

Delivery tracker only. Design authority is `ARCH/`. Phases come from `DEC-001`; each phase must ship a measurable differentiator before the next begins.

## P0 — Skeleton that runs inside an ACP editor (weeks 0–3)

Target: an ACP client drives a real turn with streamed tool calls; sessions are portable and replayable.

| ID | Task | Refs |
|---|---|---|
| `AX-001` | Initialize Rust workspace, crates, CI, license allowlist gate | `DEC-002`, `DEC-012` |
| `AX-002` | Event-sourced session store + append-only JSONL log | `DEC-004` |
| `AX-003` | Runner skeleton: admission → model step → continuation | `REQ-LOOP-001..006` |
| `AX-004` | Read-only tools: read, glob, grep, list | `REQ-TOOL-001..005` |
| `AX-005` | One OpenAI-compatible provider transport + executor retries | `REQ-PROV-001..004` |
| `AX-006` | ACP stdio server: session lifecycle + streamed updates | `REQ-PROTO-001..002` |
| `AX-007` | Headless `-p` run mode (default + JSON) | `REQ-PROTO-005` |
| `AX-008` | Config discovery + `AGENTS.md` instruction context | `REQ-CTX-005` |
| `AX-009` | Minimal TUI transcript + fixed composer dock | `REQ-UI-002..004` |

**Exit:** ACP-driven turn with streamed tool calls, replayable session log.

## P1 — Safe agent you can trust (weeks 3–8)

Target: end-to-end coding task in a sandbox with guard + verified audit.

| ID | Task | Refs |
|---|---|---|
| `AX-101` | Full tool plane: write, edit, apply-patch, shell | `REQ-TOOL-001` |
| `AX-102` | Sandbox tier 1: Landlock + seccomp, network off, workspace writes | `DEC-008`, `REQ-GUARD-004` |
| `AX-103` | Policy guard: ordered rules, fail-closed, approval lifecycle | `DEC-005`, `REQ-GUARD-001..003` |
| `AX-104` | Audit log: hash chain + verification command + redaction | `DEC-005`, `REQ-AUDIT-001..003` |
| `AX-105` | Secret broker + never-log guarantees | `REQ-PROV-004` |
| `AX-106` | MCP host: stdio + streamable HTTP, per-session dedupe | `REQ-PROTO-003` |
| `AX-107` | Multi-provider + catalog fetch/cache/offline snapshot | `DEC-007`, `REQ-PROV-002` |
| `AX-108` | `ratatui` TUI: overlays, permission modal, telemetry | `REQ-UI-*` |

**Exit:** guarded, sandboxed, audited coding task; policy changes behavior with no code change. **Differentiator: guard + verifiable audit.**

## P2 — Context that survives scale + routing (weeks 8–16)

| ID | Task | Refs |
|---|---|---|
| `AX-201` | Tree-sitter repo map + reference-graph ranking | `DEC-006`, `REQ-CTX-001` |
| `AX-202` | LSP symbols + SCIP ingest | `REQ-CTX-001` |
| `AX-203` | Eval-gated compaction (tail + summary + retrieval eval) | `DEC-006`, `REQ-CTX-002..004` |
| `AX-204` | Sub-agents: worktree isolation, receipts, depth/count bounds | `REQ-ORCH-001..002/005` |
| `AX-205` | Merge arbitration (deterministic) | `REQ-ORCH-003..004` |
| `AX-206` | Eval-gated routing + published scores | `DEC-007`, `REQ-PROV-005` |
| `AX-207` | Checkpoint + rewind | `REQ-SESS-003` |
| `AX-208` | Worktree cockpit: dockable pane + tree + diffs + embedded editor | `DEC-010`, `REQ-UI-005..006` |

**Exit:** >50-file cross-repo task without context loss; routing beats a single-frontier baseline on the published suite. **Differentiator: cross-repo context + transparent routing.**

## P3 — Long-horizon + self-hosted orchestration (weeks 16–24)

| ID | Task | Refs |
|---|---|---|
| `AX-301` | Durable task graph surviving compaction/restart | `DEC-009`, `REQ-HORIZON-002` |
| `AX-302` | Budgets: token/cost/wall-clock, fail closed | `REQ-HORIZON-003` |
| `AX-303` | Parallel self-hosted team orchestration + CI feedback loop | `REQ-ORCH-*` |
| `AX-304` | ACP client mode (drive peer agents as subordinates) | `REQ-PROTO-004` |
| `AX-305` | Local/offline models | `REQ-PROV-001` |
| `AX-306` | Sandboxed WASM skills/plugins | `DEC-008` |
| `AX-307` | Published benchmark harness | `REQ-HORIZON-*` |

**Exit:** N agents work a real backlog in parallel, auto-merge clean work, surface conflicts with evidence. **Differentiator: open parallel orchestration.**

## Open decisions

- Exact model catalog source and its data license must be confirmed before any snapshot is committed.
- Worktree cockpit layout details are pending the UI design lane (see `DEC-010`).
