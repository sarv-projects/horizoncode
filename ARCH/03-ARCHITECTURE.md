# 03 — Architecture

For each component's current source entry point, test seam, absent implementation,
and pinned upstream research file, follow the owner row in
[29-SOURCE-TRACEABILITY.md](29-SOURCE-TRACEABILITY.md). This design remains the target
contract; source and research links are evidence/navigation, not shipped status.

**Status:** target architecture, not a claim about the current executable. At the
2026-09-28 source snapshot (`23d4ce8`), the workspace contains 16 Rust crates. The
configuration crate, bounded event-log/artifact foundations, typed command/reference
registry, skill discovery, headless CLI, and inbound ACP server have partial
implementations; they do not constitute the full target components described below.
The interactive TUI, repository intelligence/index, secret broker, MCP host, outbound
ACP client, durable run/task controller, worker execution host, independent runtime
verifier, and integrated multi-agent execution remain absent. `TODO.md` tracks
implementation and evidence; `CURRENT_RUN.md` records the checked-out revision and
handoff. Source presence is not verification (`ARCH/00`).

## 1. Shape

A **single Rust workspace** producing one core executable per platform where feasible. The user may run it interactively on a laptop/workstation or headlessly on a user-managed server; no HorizonCode-operated control service is required. A detached-run supervisor may be a local helper process, but it uses the same controller and durable state. Required host capabilities are probed and disclosed per feature: at Rust source baseline `23d4ce8`, the Linux confinement path invokes `bwrap`, and Git/LSP/local inference or detached execution can need external processes. A missing required backend refuses that feature; one-binary packaging is not a claim that every capability works without host tools. ACP/MCP are protocol edges, and the local app server is a client transport around the same control service, never a second engine. Remote UI attachment is not implied by server deployment. `DEC-029..031`, `DEC-046`, `DEC-063`, `ARCH/25`, and `ARCH/31` define the durable run controller in `CMP-orch`; `CMP-execution-host` owns process/adapter lifecycle mechanics under that controller's authority.

```
┌─────────────────────────────────────────────────────────────────────┐
│                            HorizonCode binary                            │
│                                                                     │
│  Clients/surfaces                 Shared control boundary          │
│  TUI · CLI/headless · ACP         typed API / app client           │
│  SDK/IDE adapters (future)  ───►  local app server (optional)       │
│                                      │                              │
│                                      ▼                              │
│  Durable controller: Run / Spec / Task DAG / Attempt / budgets     │
│                                      │                              │
│                         ┌────────────┴────────────┐                 │
│                         ▼                         ▼                 │
│               bounded turn runner          independent verifier     │
│                         │                         │                 │
│                         ▼                         │                 │
│   repository/context · provider/worker adapters · tool registry    │
│                         │                         │                 │
│                         ▼                         ▼                 │
│     Guard → sandbox/egress → effects; Audit records effect truth   │
│                                      │                              │
│                                      ▼                              │
│   Thread/Run streams · SQLite projections/indexes · audit chain    │
│   · immutable artifacts · Git workspaces/checkpoints                 │
└─────────────────────────────────────────────────────────────────────┘
                 │ model traffic                    │ external tools
                 ▼                                  ▼
          Provider transports                  MCP servers / sandboxes
```

The run-control and worker-process ownership chain is:

```text
Durable Run / Task / Attempt (`CMP-orch`)
        │ commits launch intent and fencing epoch
        ▼
`CMP-execution-host` ── launches/observes ──> native or external worker
        │                                         │
        └──── records receipt, events, UNKNOWN ───┘

`CMP-session` stores the durable conversation (`ThreadId`, turns, items, replay); the historic component/crate name does not imply a HorizonCode `Session` domain object (`DEC-069`).
`CMP-verifier` evaluates the resulting workspace/evidence independently.
Only `CMP-orch` advances Task state; process exit or conversation closure is not PASS.
```

This distinction allows a conversation to persist after its runtime exits and lets
the controller reconcile an execution after restart without treating a missing
process handle as proof that the work did not happen. `CMP-execution-host` is a
target component and is not implemented at the source snapshot above.

## 2. Components

| ID | Component | Owner layer | Responsibility |
|---|---|---|---|
| `CMP-runner` | Runner / Loop | Control | One admitted turn's provider/tool step loop, continuation, cancellation and terminal receipt; `CMP-orch` grants system-wide run/work admission before dispatch |
| `CMP-verifier` | Independent runtime verifier | Control plane | Evaluates an exact workspace revision against the approved specification and scenarios and returns typed `PASS \| FAIL \| INSUFFICIENT_EVIDENCE` under a one-use `VerificationPermit` issued by `CMP-orch`; cannot grant tool authority, change run/task state, or write canonical truth (`ARCH/23`, `ARCH/25`) |
| `CMP-execution-host` | Worker execution host | Runtime boundary | Idempotent local process launch, process/adapter handle ownership, heartbeat and exit observation, termination, and restart observations for `WorkerExecution`; no durable task-state, permission, or verification authority |
| `CMP-session` | Thread store | Persistence | Durable HorizonCode Threads (legacy component/crate name), segmented event log, committed head, bounded replay, read-only listing, explicit recovery, checkpoints, canonical Thread artifact references, user-local ProjectIdentity/workspace registry, and rebuildable message/title search projection plus verified navigation (`ARCH/07`) |
| `CMP-artifact` | Artifact store | Persistence | Scoped immutable payload bytes, digest verification, bounded reads, physical emergency-space reservation, owner pins, import/export staging and safe garbage collection (`ARCH/28`) |
| `CMP-context` | Context engine | Capability | Assembly, budget, task-specific repo context, selection, compaction, pins/excludes; consumes revision/freshness evidence from `CMP-repo-intel` |
| `CMP-repo-intel` | Repository intelligence | Capability | Lazy, incremental, revision-bound file/symbol/reference/diagnostic map; lexical fallback and task-scoped context packages (`ARCH/09`); no separate authority or duplicate index owner |
| `CMP-web` | Web search/fetch | Capability | Provider adapters, mediated egress, bounded response cache and optional project URL history (`ARCH/10`); no provider-model catalog ownership or unrestricted browser |
| `CMP-tools` | Tool registry | Capability | Tool definitions, permission-filtered materialization, execution, settle |
| `CMP-provider` | Provider router | Capability | Catalog, route resolution, transports, retries, usage accounting |
| `CMP-orch` | Durable run controller | Control plane | Durable task DAG, system-wide `SupervisorControlStream` and cross-process run/work/maintenance admission, budget/event-storage reservations, physically allocated control reserve, fenced leases, stop/recovery, sub-agent scheduling, bounded Run-scoped agent mailbox/delivery reconciliation, durable `WorkerExecution` lifecycle reconciliation, merge arbitration; invokes independent verifier (`ARCH/16`, `ARCH/25`, `ARCH/32`) |
| `CMP-guard` | Policy guard | Trust | Ordered allow/ask/deny rules; approval lifecycle |
| `CMP-sandbox` | Sandbox | Trust | Platform confinement through explicitly selected backends; current Linux namespaces and macOS Seatbelt source; Windows backend unavailable; Landlock/seccomp remain target layers, not current guarantees |
| `CMP-secrets` | Secret broker | Trust | Credential references/resolution; brokered-value non-disclosure; bounded known-value/pattern redaction |
| `CMP-audit` | Audit log | Trust | Append-only hash-chained execution record; verification |
| `CMP-acp` | ACP edge | Surface | ACP server (stdio) and client modes; protocol mapping |
| `CMP-mcp` | MCP edge | Capability | MCP host: server lifecycle, tool/resource/prompt mirroring, dedupe |
| `CMP-extension-catalog` | Extension catalog | Capability | Federated listing metadata, source adapters, identity/deduplication, bounded search, and compatibility evidence; no package execution, credentials, authorization, or runtime capability state (`ARCH/21`) |
| `CMP-tui` | TUI | Surface | Explorer/editor left dock, central chat, verified Tasks right pane, composer, palette, settings, permissions, telemetry; virtualized and bounded (`ARCH/06`) |
| `CMP-headless` | Headless | Surface | Non-interactive run, structured output, CI use |
| `CMP-config` | Configuration | Capability | Discovery precedence, validation, instructions, skill/plugin/hook configuration, typed memory settings; no memory domain behavior |
| `CMP-memory` | Memory service | Capability | Provenance-bearing candidate records, user review/consent, dedupe/conflict/supersession, retrieval, bounded consolidation and deletion (`ARCH/33`); no policy or verification authority |
| `CMP-analytics` | Analytics | Observability | Usage/cost/tool/session metrics, local ledger, `stats`/`export` surfaces |
| `CMP-command` | Command registry | Surface adapter | Typed slash-command descriptors, completion/help, parse and dispatch to owning services; no business state or permission decisions |
| `CMP-diagnostics` | Diagnostics service | Observability | Bounded local readiness probes, stable findings, human/JSON projections, and named repair plans; read-only report owns no authority, and repair effects use the owning config/service through Guard (`ARCH/27`) |
| `CMP-control-api` | Shared typed control dispatcher | Surface boundary | Versioned requests/responses/events and method registry routed to canonical domain owners; no duplicate state, policy, or agent loop (`ARCH/31`) |
| `CMP-app-server` | Local supervisor IPC and lifecycle | Surface/runtime boundary | Same-host authenticated IPC, bounded lanes, singleton and attach lifecycle; no Run/Session truth or network listener (`ARCH/31`) |
| `CMP-app-client` | Shared surface client | Surface | In-process/IPC transport parity, request idempotency, reconnect and per-aggregate cursor replay; no business decisions (`ARCH/31`) |
| `CMP-agent-directory` | Agent profiles | Capability | Built-in/local/catalog profile records, provenance, install staging, probing, trust/enable state and adapter selection; no run/task truth |
| `CMP-reference` | Composer references | Capability | Namespaced resolution of agents, files, tasks, runs, symbols and skills against current registries and revision-bound repository context; no launch or grant |
| `CMP-update` | Installer/update service | Trust + maintenance | Signed update metadata/target verification, install-method detection, staging, explicit consent, safe activation/rollback; activation requires a one-use quiescence permit from `CMP-orch`; no release signing key or run/task state ownership (`ARCH/30`) |

Adapter edges (`native | acp_stdio | acp_remote | cli_opaque`) are implementation
mechanics of `CMP-execution-host` under `CMP-orch` authority, with the ACP transport
owned by `CMP-acp`; there is no separate `CMP-adapter` component.

`CMP-extension-catalog` is separate from `CMP-provider`: the former indexes external
services and installable extension packages; the latter selects model/inference
routes. The catalog resolves source records into listing metadata and compatibility
evidence. Product-local installers and runtimes remain with `CMP-config`, `CMP-mcp`,
`CMP-tools`, `CMP-secrets`, `CMP-guard`, and `CMP-sandbox`. A connector account and its
secret references are local to the consuming product; a shared catalog never carries
credentials or installation state. HorizonCode's Connector card is the user-facing
service identity, while MCP/native/gateway choices are provider offers below it.

## 3. The agent loop (contract)

The canonical cycle:

```
INPUT → ADMISSION → PLAN → MODEL STEP → SCHEDULER → EXECUTE → OBSERVE → UPDATE → CONTINUATION
```

- **INPUT** — user prompts, queued messages, steers.
- **ADMISSION** — accept/deny the step against guard + budget + policy. A direct
  coding turn begins from its user prompt and uses the ordinary bounded runner path;
  it does not require a goal, durable plan, or Run-start review. The planning phase
  may be a lightweight internal choice or an optional user-requested proposal.
- **MODEL STEP** — resolve route, assemble context, stream the model. Mode and
  policy determine the permission-filtered tool set for that turn.
- **SCHEDULER** — partition tool calls into parallel-safe groups and ordered barriers.
- **EXECUTE** — run tools under guard + sandbox; record effects.
- **OBSERVE** — collect results, split model-content from UI-detail.
- **UPDATE** — `CMP-session` commits turn, model, and tool observations; the runner
  emits typed usage and execution receipts. `CMP-orch` alone updates durable task/run
  state and the authoritative run-cost projection. A turn update is not a task-state
  transition (`ARCH/08`, `ARCH/16`, `ARCH/25`).
- **CONTINUATION** — decide to continue, compact, or terminate.

Terminal states: `completed | failed | interrupted | declined`. Exactly one per turn (`REQ-LOOP-004`).

Direct Code turns edit the selected working tree through the same guarded write path.
They do not automatically stage or commit; the user can inspect the result with
ordinary Git tools or HorizonCode's Turn Diff. Managed Runs may use fenced worktrees
when isolation, unattended execution, or explicit `/explore` warrants it. Run/task
verification and completion semantics remain owned by `CMP-orch` and do not turn
ordinary turns into mandatory Run workflows (`DEC-075`).

## 4. Boundaries

1. **Surfaces ↔ control.** TUI, headless, and ACP are thin clients of one control interface. No surface contains loop logic (`REQ-PROTO-005`).
2. **Tools ↔ policy.** Tools are pure definitions; the registry materializes a permission-filtered set; the guard authorizes effects. A denied tool is absent, not merely blocked (`REQ-TOOL-003`).
3. **Capability ↔ trust.** Every effectful capability call passes through the guard and sandbox and appends to audit. No privileged shortcut exists.
4. **Data ↔ control.** Persistence is event-sourced; the model-visible context is a projection, never the source of truth. Thread/Run logs own artifact references; `CMP-artifact` owns immutable bytes and rebuildable indexes, not Run or Thread truth.
5. **Protocols are edges.** ACP/MCP adapt to the control plane; they never re-implement it. ACP communicates with an agent after it is found and enabled; it is not itself the profile registry or installer.
6. **Commands are dispatch descriptors, not another command engine.** `CMP-command` resolves a stable command ID and typed arguments, then invokes the owning control/config/analytics/guard service. TUI and headless syntax stays separate where appropriate.
7. **Extension families stay distinct.** Agent adapters, provider adapters, MCP servers, skills, plugins, tools, panels, and commands have different trust and lifecycle contracts even when discovered through a shared catalog UI.

## 5. Technology choices

| Concern | Choice | Rationale |
|---|---|---|
| Language | Rust (single workspace) | One native runtime; tiered OS isolation with each guarantee limited to the mechanism and acceptance evidence actually available; strong concurrency/cancellation correctness |
| TUI | `ratatui` + `crossterm` | Mature; retained control of cells; one binary |
| Async runtime | Tokio | Cancellation, timers, process and network IO |
| HTTP | `reqwest` | Provider transports |
| Persistence | SQLite (`rusqlite`) projections/indexes plus segmented Thread/Run event streams, a separate audit chain, and immutable artifact storage | Each store has one authority and explicit replay/reconciliation links; a single JSONL log is not the entire persistence architecture (`ARCH/07`, `ARCH/14`, `ARCH/25`, `ARCH/28`) |
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

- **One provider/model catalog service, multiple explicit sources.** The executable resolves a small curated, provenance-bearing primary offline. OpenCode's provider/model metadata source is a documented, automatically refreshed data feed, enabled by default and disableable in settings; generic enrichment remains opt-in. Catalog breadth is separate from adapter/auth support, and no feed grants credentials, loads code, or changes arbitrary endpoints (`DEC-021`, `DEC-060`).
- **One route abstraction.** A route is the orthogonal tuple `Protocol × Endpoint × Auth × Framing`, plus defaults. Vendor quirks live in protocol adapters, not in the loop (`REQ-PROV-003`).
- **One executor.** Bounded retries with exponential jitter and `Retry-After`; typed failure reasons; brokered-credential non-disclosure and bounded redaction of recognized secret patterns. Arbitrary workspace text is not claimed to be perfectly secret-scanned (`REQ-SEC-009`, `ARCH/22`).
- **One router.** Policy-driven selection (cost, latency, capability, tags), optionally eval-gated; every decision observable (`REQ-PROV-005`).
- **Native Rust OpenCode integration.** The general OpenCode feed and Go `/models` directory are separate fixed-origin data sources; the Go connector uses the user's own eligible Go API key for inference and HorizonCode's own request identity. Go model IDs cannot choose endpoint paths or protocols: a locally versioned route map binds documented `/responses`, `/chat/completions`, and `/messages` paths to native Rust adapters, and unknown/new models remain visible but unavailable until a compatible signed HorizonCode release adds and verifies a mapping. Adapter changes ship in HorizonCode releases; metadata refresh cannot download executable behavior (`DEC-060`, `ARCH/11`).
- **Pinned routes.** Active attempts pin an immutable provider/model descriptor and adapter snapshot. Metadata refresh changes only future picker/route choices; changing a live route requires an explicit controller-mediated replan.

## 7. Distribution and updates

`CMP-update` is the only owner of application update checks, verified staging, install
method handling, and activation. It uses signed TUF metadata rooted in a separately
authenticated installer/bootstrap, performs non-blocking startup checks, and requires
explicit confirmation to install. The updater never interrupts active long-horizon
work. `CMP-orch` serializes run starts, direct-turn/worker execution, and update
maintenance so an executable swap cannot race work outside a durable Run. App metadata,
provider catalogs, and signed executable targets have distinct
schemas, caches, trust roots, permissions, and UI states. Release packaging and
offline signing are described in [`ARCH/30-DISTRIBUTION-UPDATES.md`](30-DISTRIBUTION-UPDATES.md);
there is no release script/workflow in the current checkout.

## 8. Security model

- **Default deny.** Guard posture fails closed; ambiguous actions ask or deny (`REQ-GUARD-002`).
- **Sandbox by default.** Writes scoped to the workspace; egress closed unless
  granted, up to the **tier's declared network guarantee level** — `enforced`,
  `capability`, `best_effort`, or `none` — and a caller requiring a level the tier cannot provide
  is refused (`REQ-GUARD-004`, `DEC-026`).
- **Untrusted input.** Web, files, tool output, and MCP responses are data, never instructions (`REQ-SEC-002`).
- **No secret leakage.** The broker never emits credentials to prompts, logs, telemetry, or audit (`REQ-PROV-004`, `REQ-AUDIT-003`).
- **Provenance.** Every dependency passes a license allowlist gate; provenance headers on adapted files (`REQ-SEC-001`).

## 9. Execution tiers (sandbox)

| Tier | Backend | Use |
|---|---|---|
| Local (default) | Each backend discloses its actual mechanism. Current source provides Linux bubblewrap namespace isolation; Landlock/seccomp stacking is target work. macOS and Windows backends exist in source but have no host acceptance evidence in this audit. | Everyday repo work |
| Container | OCI runtime (Docker/Podman) | Reproducible toolchains |
| Micro-VM | Firecracker-class or lightweight VM sandbox | Untrusted/unsafe tasks |
| Remote | Future adapter to an explicitly user-managed/authorized host; no HorizonCode-operated worker service is implied | Remote execution remains proposed and requires authenticated transport, custody, policy, and acceptance contracts |

Linux and macOS are **implementation targets**, with distinct acceptance obligations.
At baseline `1c7a1c68bab9`, the Linux source invokes bubblewrap with user/mount/PID/IPC/
UTS/cgroup/network namespaces and a scoped mount view; it explicitly says Landlock and
seccomp are not installed. The macOS source emits and invokes Seatbelt rules, but no
host acceptance evidence exists. The Windows confined backend returns unavailable;
current source permits explicit `full-access` runs bare. That behavior violates the
target private-controller boundary: the target design refuses broad access until the
backend isolates worker identity and state from canonical controller data. `check_path`
is a shared in-process gate, not OS containment for the controller. Source code alone
does not establish containment.

**"Network off" is a request, with backend-specific reach evidence** (`DEC-026`,
`DEC-027`, `DEC-037`). A backend record names the tested destinations, mechanism,
descendant/IPC residuals, and build/platform. Namespace isolation is reach isolation,
not a claim that `connect()` is denied. Windows capability denial and macOS descendant
semantics are not asserted until their backend and acceptance evidence exist. All
backends implement one `SandboxProvider` interface, but this does not make their
guarantees equivalent. Until the exact platform acceptance row exists, report the
capability as unverified or unavailable.

## 10. Deployment and host placement

- Precompiled binaries for accepted platform targets. Installers bootstrap an
  authenticated update root, and updates verify signed metadata and artifacts; a
  checksum from the download origin alone is insufficient (`REQ-UPDATE-003`,
  `ARCH/30`).
- The installer reports toolchain prerequisites when a source build is required (`REQ-VISION-002`).
- Config discovery walks from global to project scope; nearest wins; JSONC accepted.
