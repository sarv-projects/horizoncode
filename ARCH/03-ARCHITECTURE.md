# 03 — Architecture

## 1. Shape

A **single Rust workspace** producing one binary per platform. The binary contains every layer; nothing is a required external process except the tools the user's work actually invokes. Protocols (ACP, MCP) are edges, not a second engine.

```
┌─────────────────────────────────────────────────────────────────────┐
│                            agentX binary                            │
│                                                                     │
│  Surfaces                          Control plane (first-party)      │
│  ┌───────────────┐                 ┌──────────────────────────────┐ │
│  │ TUI           │                 │  Runner / Loop               │ │
│  │ (ratatui)     │                 │   · admission                │ │
│  │  · transcript │                 │   · model step               │ │
│  │  · cockpit    │◄───────────────►│   · scheduler / tool settle  │ │
│  │  · palette    │   one control   │   · observe / continuation   │ │
│  └───────────────┘   interface     └──────────────┬───────────────┘ │
│  ┌───────────────┐                                │                 │
│  │ Headless (-p) │                                ▼                 │
│  └───────────────┘                 ┌──────────────────────────────┐ │
│  ┌───────────────┐                 │  Capability layer            │ │
│  │ ACP server    │                 │   · tool registry (filtered) │ │
│  │ (stdio)       │                 │   · context engine           │ │
│  └───────────────┘                 │   · provider router          │ │
│  ┌───────────────┐                 │   · sub-agent orchestrator   │ │
│  │ ACP client    │                 └──────────────┬───────────────┘ │
│  └───────────────┘                                │                 │
│                                    ┌──────────────▼───────────────┐ │
│                                    │  Trust layer (fail-closed)   │ │
│                                    │   · policy guard             │ │
│                                    │   · sandbox / egress         │ │
│                                    │   · secret broker            │ │
│                                    │   · audit (hash-chained)     │ │
│                                    └──────────────┬───────────────┘ │
│                                    ┌──────────────▼───────────────┐ │
│                                    │  Persistence                 │ │
│                                    │   · event log (JSONL)        │ │
│                                    │   · SQLite state / index     │ │
│                                    │   · worktrees / checkpoints   │ │
│                                    └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                 │ model traffic                    │ external tools
                 ▼                                  ▼
          Provider transports                  MCP servers / sandboxes
```

## 2. Components

| ID | Component | Owner layer | Responsibility |
|---|---|---|---|
| `CMP-runner` | Runner / Loop | Control | Turn lifecycle, admission, step loop, scheduler, continuation, cancellation |
| `CMP-session` | Session store | Persistence | Durable sessions, event log, replay, resume, checkpoint |
| `CMP-context` | Context engine | Capability | Assembly, budget, repo map, selection, compaction, pins/excludes |
| `CMP-tools` | Tool registry | Capability | Tool definitions, permission-filtered materialization, execution, settle |
| `CMP-provider` | Provider router | Capability | Catalog, route resolution, transports, retries, usage accounting |
| `CMP-orch` | Orchestrator | Capability | Sub-agent spawn/isolation/receipts, parallel scheduling, merge arbitration |
| `CMP-guard` | Policy guard | Trust | Ordered allow/ask/deny rules; approval lifecycle |
| `CMP-sandbox` | Sandbox | Trust | Landlock/seccomp/namespace confinement; egress control |
| `CMP-secrets` | Secret broker | Trust | Credential resolution; redaction; never-log guarantees |
| `CMP-audit` | Audit log | Trust | Append-only hash-chained execution record; verification |
| `CMP-acp` | ACP edge | Surface | ACP server (stdio) and client modes; protocol mapping |
| `CMP-mcp` | MCP edge | Capability | MCP host: server lifecycle, tool/resource/prompt mirroring, dedupe |
| `CMP-tui` | TUI | Surface | Transcript, dock, cockpit, palette, permissions, telemetry |
| `CMP-headless` | Headless | Surface | Non-interactive run, structured output, CI use |

## 3. The agent loop (contract)

The canonical cycle:

```
INPUT → ADMISSION → PLAN → MODEL STEP → SCHEDULER → EXECUTE → OBSERVE → UPDATE → CONTINUATION
```

- **INPUT** — user prompts, queued messages, steers.
- **ADMISSION** — accept/deny the step against guard + budget + policy.
- **MODEL STEP** — resolve route, assemble context, stream the model.
- **SCHEDULER** — partition tool calls into parallel-safe groups and ordered barriers.
- **EXECUTE** — run tools under guard + sandbox; record effects.
- **OBSERVE** — collect results, split model-content from UI-detail.
- **UPDATE** — append events, update task graph and cost.
- **CONTINUATION** — decide to continue, compact, or terminate.

Terminal states: `completed | failed | interrupted | declined`. Exactly one per turn (`REQ-LOOP-004`).

## 4. Boundaries

1. **Surfaces ↔ control.** TUI, headless, and ACP are thin clients of one control interface. No surface contains loop logic (`REQ-PROTO-005`).
2. **Tools ↔ policy.** Tools are pure definitions; the registry materializes a permission-filtered set; the guard authorizes effects. A denied tool is absent, not merely blocked (`REQ-TOOL-003`).
3. **Capability ↔ trust.** Every effectful capability call passes through the guard and sandbox and appends to audit. No privileged shortcut exists.
4. **Data ↔ control.** Persistence is event-sourced; the model-visible context is a projection, never the source of truth.
5. **Protocols are edges.** ACP/MCP adapt to the control plane; they never re-implement it.

## 5. Technology choices

| Concern | Choice | Rationale |
|---|---|---|
| Language | Rust (single workspace) | One static binary; syscall-level sandbox; strong concurrency/cancellation correctness |
| TUI | `ratatui` + `crossterm` | Mature; retained control of cells; one binary |
| Async runtime | Tokio | Cancellation, timers, process and network IO |
| HTTP | `reqwest` | Provider transports |
| Persistence | SQLite (`rusqlite`) + append-only JSONL event log | Durable state + replayable stream |
| Git | `gitoxide`, shelling to system git for worktrees | Worktree isolation and diff/status |
| Parsing | `tree-sitter` | Repo map, syntax highlight |
| Language servers | LSP client | Symbols and diagnostics |
| Indexing | SCIP ingest | Precise cross-repo symbol data where available |
| Sandbox | `landlock`, seccomp, bubblewrap-as-subprocess | Tiered confinement without linking copyleft |
| Hashing | `blake3` | Audit chain and content hashing |
| Plugins/skills | WASM (`wasmtime`) | Sandboxed extensibility |
| ACP/MCP | Protocol SDKs (permissive) | Avoid re-implementing wire protocol |
| CLI | `clap` | Argument parsing |

## 6. Provider model

- **One catalog, external source of truth.** Provider/model metadata is fetched, cached, refreshed, and snapshotted for offline use; the catalog code is not vendored (`REQ-PROV-002`).
- **One route abstraction.** A route is the orthogonal tuple `Protocol × Endpoint × Auth × Framing`, plus defaults. Vendor quirks live in protocol adapters, not in the loop (`REQ-PROV-003`).
- **One executor.** Bounded retries with exponential jitter and `Retry-After`; typed failure reasons; full secret redaction.
- **One router.** Policy-driven selection (cost, latency, capability, tags), optionally eval-gated; every decision observable (`REQ-PROV-005`).

## 7. Security model

- **Default deny.** Guard posture fails closed; ambiguous actions ask or deny (`REQ-GUARD-002`).
- **Sandbox by default.** Writes scoped to the workspace; egress closed unless granted (`REQ-GUARD-004`).
- **Untrusted input.** Web, files, tool output, and MCP responses are data, never instructions (`REQ-SEC-002`).
- **No secret leakage.** The broker never emits credentials to prompts, logs, telemetry, or audit (`REQ-PROV-004`, `REQ-AUDIT-003`).
- **Provenance.** Every dependency passes a license allowlist gate; provenance headers on adapted files (`REQ-SEC-001`).

## 8. Execution tiers (sandbox)

| Tier | Backend | Use |
|---|---|---|
| Local (default) | bubblewrap + Landlock + seccomp, network off, workspace writes only | Everyday repo work |
| Container | OCI runtime (Docker/Podman) | Reproducible toolchains |
| Micro-VM | Firecracker-class or lightweight VM sandbox | Untrusted/unsafe tasks |
| Remote | Managed sandbox behind one interface | Hostile or elastic workloads |

All tiers implement one `SandboxProvider` interface so callers never branch on backend.

## 9. Deployment and distribution

- Precompiled binaries per platform; an install script that verifies the checksum.
- The installer reports toolchain prerequisites when a source build is required (`REQ-VISION-002`).
- Config discovery walks from global to project scope; nearest wins; JSONC accepted.
