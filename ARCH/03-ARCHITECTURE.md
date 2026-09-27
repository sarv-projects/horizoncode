# 03 — Architecture

**Status:** target architecture, not a claim about the current executable. At the
2026-09-27 code snapshot, the workspace contains 11 Rust crates; TUI, configuration,
repository intelligence, secret broker, MCP, ACP client, and durable orchestration are
not yet implemented as their target components. `TODO.md` tracks the implementation;
`CURRENT_RUN.md` records the inspected revision. Source presence is not verification
(`ARCH/00`).

## 1. Shape

A **single Rust workspace** producing one core binary per platform. Required host capabilities are probed and disclosed per feature: the current Linux confinement path invokes `bwrap`, and Git/LSP/local inference or detached execution can need external processes. A missing required backend refuses that feature; one-binary packaging is not a claim that every capability works without host tools. Protocols (ACP, MCP) are edges, not a second engine. `DEC-029..031` and `ARCH/25` define the durable run controller inside the existing `CMP-orch` boundary.

```
┌─────────────────────────────────────────────────────────────────────┐
│                            HorizonCode binary                            │
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
| `CMP-orch` | Durable run controller | Control plane | Task DAG, budget reservations, fenced leases, stop/recovery, sub-agent scheduling, merge arbitration; invokes independent verifier (`ARCH/25`) |
| `CMP-guard` | Policy guard | Trust | Ordered allow/ask/deny rules; approval lifecycle |
| `CMP-sandbox` | Sandbox | Trust | Platform confinement through explicitly selected backends; current Linux namespaces and macOS Seatbelt source; Windows backend unavailable; Landlock/seccomp remain target layers, not current guarantees |
| `CMP-secrets` | Secret broker | Trust | Credential resolution; redaction; never-log guarantees |
| `CMP-audit` | Audit log | Trust | Append-only hash-chained execution record; verification |
| `CMP-acp` | ACP edge | Surface | ACP server (stdio) and client modes; protocol mapping |
| `CMP-mcp` | MCP edge | Capability | MCP host: server lifecycle, tool/resource/prompt mirroring, dedupe |
| `CMP-tui` | TUI | Surface | Transcript, dock, cockpit, palette, permissions, telemetry |
| `CMP-headless` | Headless | Surface | Non-interactive run, structured output, CI use |
| `CMP-config` | Configuration | Capability | Discovery precedence, validation, instructions, skills, plugins, hooks, memory |
| `CMP-analytics` | Analytics | Observability | Usage/cost/tool/session metrics, local ledger, `stats`/`export` surfaces |

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
| Language | Rust (single workspace) | One native runtime; tiered OS isolation with each guarantee limited to the mechanism and acceptance evidence actually available; strong concurrency/cancellation correctness |
| TUI | `ratatui` + `crossterm` | Mature; retained control of cells; one binary |
| Async runtime | Tokio | Cancellation, timers, process and network IO |
| HTTP | `reqwest` | Provider transports |
| Persistence | SQLite (`rusqlite`) + append-only JSONL event log | Durable state + replayable stream |
| Git | `gitoxide`, shelling to system git for worktrees | Worktree isolation and diff/status |
| Parsing | `tree-sitter` | Repo map, syntax highlight |
| Language servers | LSP client | Symbols and diagnostics |
| Indexing | SCIP ingest | Precise cross-repo symbol data where available |
| Sandbox | bubblewrap subprocess; Seatbelt source; future Landlock/seccomp and native AppContainer implementation | Tiered confinement only after per-tier acceptance; do not infer linked or enforced from a dependency name |
| Hashing | `blake3` | Audit chain and content hashing |
| Plugins/skills | WASM (`wasmtime`) | Sandboxed extensibility |
| ACP/MCP | Protocol SDKs (permissive) | Avoid re-implementing wire protocol |
| CLI | `clap` | Argument parsing |

## 6. Provider model

- **One catalog, curated primary and opt-in enrichment.** The executable can resolve its curated, provenance-bearing primary without network; optional refresh is explicit and policy checked. No full upstream dataset or logos are bundled by default (`DEC-021`).
- **One route abstraction.** A route is the orthogonal tuple `Protocol × Endpoint × Auth × Framing`, plus defaults. Vendor quirks live in protocol adapters, not in the loop (`REQ-PROV-003`).
- **One executor.** Bounded retries with exponential jitter and `Retry-After`; typed failure reasons; full secret redaction.
- **One router.** Policy-driven selection (cost, latency, capability, tags), optionally eval-gated; every decision observable (`REQ-PROV-005`).

## 7. Security model

- **Default deny.** Guard posture fails closed; ambiguous actions ask or deny (`REQ-GUARD-002`).
- **Sandbox by default.** Writes scoped to the workspace; egress closed unless
  granted, up to the **tier's declared network guarantee level** — `enforced`,
  `capability`, `best_effort`, or `none` — and a caller requiring a level the tier cannot provide
  is refused (`REQ-GUARD-004`, `DEC-026`).
- **Untrusted input.** Web, files, tool output, and MCP responses are data, never instructions (`REQ-SEC-002`).
- **No secret leakage.** The broker never emits credentials to prompts, logs, telemetry, or audit (`REQ-PROV-004`, `REQ-AUDIT-003`).
- **Provenance.** Every dependency passes a license allowlist gate; provenance headers on adapted files (`REQ-SEC-001`).

## 8. Execution tiers (sandbox)

| Tier | Backend | Use |
|---|---|---|
| Local (default) | Each backend discloses its actual mechanism. Current source provides Linux bubblewrap namespace isolation; Landlock/seccomp stacking is target work. macOS and Windows backends exist in source but have no host acceptance evidence in this audit. | Everyday repo work |
| Container | OCI runtime (Docker/Podman) | Reproducible toolchains |
| Micro-VM | Firecracker-class or lightweight VM sandbox | Untrusted/unsafe tasks |
| Remote | Managed sandbox behind one interface | Hostile or elastic workloads |

Linux and macOS are **implementation targets**, with distinct acceptance obligations.
At baseline `1c7a1c68bab9`, the Linux source invokes bubblewrap with user/mount/PID/IPC/
UTS/cgroup/network namespaces and a scoped mount view; it explicitly says Landlock and
seccomp are not installed. The macOS source emits and invokes Seatbelt rules, but no
host acceptance evidence exists. The Windows confined backend returns unavailable;
only explicit `full-access` runs bare. `check_path` is a shared in-process gate, not OS
containment for the controller. Source code alone does not establish containment.

**"Network off" is a request, with backend-specific reach evidence** (`DEC-026`,
`DEC-027`, `DEC-037`). A backend record names the tested destinations, mechanism,
descendant/IPC residuals, and build/platform. Namespace isolation is reach isolation,
not a claim that `connect()` is denied. Windows capability denial and macOS descendant
semantics are not asserted until their backend and acceptance evidence exist. All
backends implement one `SandboxProvider` interface, but this does not make their
guarantees equivalent. Until the exact platform acceptance row exists, report the
capability as unverified or unavailable.

## 9. Deployment and distribution

- Precompiled binaries per platform; an install script that verifies the checksum.
- The installer reports toolchain prerequisites when a source build is required (`REQ-VISION-002`).
- Config discovery walks from global to project scope; nearest wins; JSONC accepted.
