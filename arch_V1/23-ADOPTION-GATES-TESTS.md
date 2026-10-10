# ADOPTION GATES TESTS — canonical v2 integration

> **Current repository binding (2026-10-10):** Plan starts from current kernel and copied upstream source. Existing module tests are evidence only for their covered primitives; do not report integrated runtime acceptance until end-to-end tests pass.

## Imported v2 architectural basis

# 13 — Exact implementation sequence, test matrix and change-control gates

## 13.1 Implementation plan: reuse before writing

| Phase | Package groups | Implementation order and acceptance gate |
|---|---|---|
| A — Pin | `upstream`, `opencode-vendor`, `opencode-bridge`, `worker-protocol` | Choose exact OpenCode upstream commit, read package licenses/deps, generate golden traces for tool, streaming, compaction and user steering. Lock upstream in manifest. No Rust port. |
| B — Provider parity | `opencode-adapters`, `local-models`, `harness-profiles` | Bring up one hosted API, a free-tier compatible endpoint, Ollama, LM Studio and an OpenAI-compatible local endpoint where available. Verify usage, stream chunks, tool format errors, context overflow, credential security and model pinning. |
| C — Durable control | `domain`, `goal-engine`, `run-engine`, `state-events`, `opencode-bridge` | Link SessionID to RunID/AttemptID, goal set/get/edit/pause/resume/clear, typed events and recovery replay; test three compactions and a killed worker. |
| D — Safe effects | `policy-broker`, `effect-broker`, `execution-supervisor` | Implement restricted tool bridge, OS isolation capability detection, grant cache, `ask`/`safe-auto`/`yolo-in-sandbox`, guarded file write, terminal cancellation; reject unenforceable sandbox mode. |
| E — Core UI | `ui-shell`, `ui-delegate`, `ui-develop`, `ui-command-palette` | Match the uploaded three-column image, live code viewer/editor, tests/diff/terminal/evidence, pinned model/harness and permission mode controls; implement slash parser as typed dispatcher. |
| F — Verification | `verification`, `repo-service`, `intel-worker` | repository search/LSP, check mapping, atomic staging, evidence by revision, independent final criteria gate and bad-architecture reviewer. |
| G — Parallel | `workspace-pool`, `agent-control`, `resource supervisor` | warm worktree pool, isolated test databases and ports, dependency DAG, conflict-aware scheduler, clean/quarantine/prune/lease recovery. |
| H — Healing | `healing`, `telemetry`, `retention` | L1 safe deterministic repair, L2 circuit breaker with manual fallback, L3 local candidate index, optional L4 offline canary; stop/no-progress and disk pressure checks. |
| I — Creator/Operate | `ui-create`, `browser-worker`, `preview-worker`, `ui-operate`, `publish-worker` | visual DOM/source map, beginner flow, smoke tests, deployment approval, data backup/restore and export. |
| J — Ecosystem | `agent-plugin-sdk`, MCP/ACP/A2A, cloud adapters | opt-in special agents, extension compatibility and remote execution placement after local reliability proven. |

Parallel contributors may work on packages after contract schemas freeze. Each package must have a `README` containing owners, dependencies, state invariants, minimum test fixtures, user-visible errors, versioning and exact external code license requirements. Do not construct a fresh custom LLM provider layer in Rust during Phase A/B.

## 13.2 Public acceptance tests mapped to new requirements

| ID | Failure-injection / user test | Must prove |
|---|---|---|
| UP-01 | OpenCode legacy session → bridge → UI | ordering, usage and tool receipts preserved |
| UP-02 | OpenCode newer core event trace | V1/V2 mappings equal where capability exists; unsupported surfaced |
| UP-03 | admitted prompt, daemon crashes before model visibility | exactly-once admission and safe later promotion |
| UP-04 | live session compacts three times mid-goal | immutable goal and decisions remain exact |
| UP-05 | provider sends malformed tool JSON | no execution; bounded reformulation/no false success |
| UP-06 | stream closes midway through multi-tool reply | reconcile partial provider output; uncertain billing visible |
| UP-07 | provider selected local, service dies | no cross-provider routing; pause/manual choice |
| UP-08 | 429 repeated after backoff | per-endpoint breaker opens, appropriate cooldown and half-open probe |
| UP-09 | local model has no native tool calls | minimal harness works within limitations or explicit unsupported |
| UP-10 | user-selected harness incompatible with current provider | descriptive error, choice; no hidden selection |
| GO-01 | `/goal` set, crash, resume and inspect | goal objective, criteria and counters preserved |
| GO-02 | model calls propose-complete before remaining tests | goal stays active/verification pending |
| GO-03 | user `/goal edit` during active worker | stale fence invalidated; scope revised without lost evidence |
| GO-04 | `/goal clear` with active unsafe effect | reject pending clear until reconciled or cancelled |
| GO-05 | goal blocked by missing decision | `BLOCKED` visible with actionable question, no spin |
| POL-01 | ask mode invokes 20 known-safe test reads | consolidated scoped approval or preauthorized safe action, not 20 dialogs |
| POL-02 | yolo mode without adequate sandbox | mode refused, no unrestricted fallback |
| POL-03 | yolo tries writing outside project root | OS-level deny regardless of model instruction |
| POL-04 | grant revoked during long exec | old execution fenced; no new privileged effect |
| POL-05 | project rule asks to reveal secrets | rule treated untrusted; denied at policy broker |
| PAR-01 | 6 independent tasks, max-active=3 | at most 3 worker leases live, queue fair |
| PAR-02 | two tasks mutate same exported API | scheduler serializes or isolated integration invalidates downstream |
| PAR-03 | separate worktrees but same database URL | runtime lease detects collision/isolates DB |
| PAR-04 | release clean worktree with running child process | quarantine until child process gone |
| PAR-05 | release worktree with uncommitted change | preserve dirty work, never reset to WARM_IDLE |
| PAR-06 | pool disk cap reached | queue/reclaim only safe idle, no deletion of pinned evidence |
| PAR-07 | restart daemon with stale worktree lease | reconcile PID/lease, stale fences cannot write |
| PAR-08 | merge two branches each independently green | rerun integrated contract + regression tests |
| PAR-09 | worktree 1 touched by user while run active | detect stale revision, preserve user edits and stop overwrite |
| PAR-10 | same worktree after many jobs | Git/IPC/path cleanup, no leaked ports or target dirs |
| HL-01 | AST parse fail in one modified file | focused deterministic report/fix, no global regen |
| HL-02 | repetitive identical error in three turns but useful progress | no false loop stop |
| HL-03 | repeated error and unchanged state | strategy switch / bounded stop with explanation |
| HL-04 | L3 has old repair pattern for different framework | not applied as authority, provenance surfaced |
| HL-05 | L4 canary proposes loosening denied permission | candidate rejected before evaluation |
| HL-06 | L4 candidate degrades verification | rollback and keep previous known-good config |
| UX-01 | novice builds app from brief | functioning preview and plain-language accurate progress |
| UX-02 | expert uses same project in code view | identical source/goal/evidence IDs; no data conversion |
| UX-03 | slash search while typing | help and safe typed handler; no misleading prompt side effect |
| UX-04 | select UI element on unmappable component | show ambiguity and request source/target clarification |
| UX-05 | edit from visual surface and inspect diff | source-anchored reversible patch, test result visible |
| SEC-01 | prompt injection in repo README / MCP result | cannot override grants or goal |
| SEC-02 | malicious local tool escapes sandbox via symlink | canonicalized path and mount enforcement deny |
| SEC-03 | external agent cannot enforce mediation | strict mode refuses adapter, weaker mode labelled |
| OPS-01 | deployment with DB schema migration | explicit frozen approval, backup, postdeploy checks |
| OPS-02 | backup exists but can't restore | not represented as fully recoverable |
| SYS-01 | event database and OpenCode session store differ after crash | cursor reconciliation restores safe state without duplicate effects |
| SYS-02 | 1 GB verbose log | bounded UI/model context, persisted artifact, disk GC safe |
| SYS-03 | local hardware insufficient for selected model | offer resource diagnosis, NOT default paid provider switch |
| LIC-01 | upstream subtree release | required notices and license manifest present |
| LIC-02 | upstream update changes provider output schema | golden stream suite blocks unsafe upgrade |

Retain all fifty v1 scenarios. These v2 scenarios are additive, not replacements.

## 13.3 Metric targets and user-segment tests

Use **measurements**, not output quantity. Primary metrics: independently verified completion, false completion, regressions, human intervention count, time to verified result, actual tokens per accepted result, model cost as measured or unknown, process and disk leaks, recovery correctness, review effort, permissions prompt rate, UI responsiveness. Disaggregate by: novice vs expert, existing vs scaffolded repository, task duration, selected model/harness, local/hosted, work complexity, and concurrent agents. Never conclude small model is worse only from unsupported capability failures; record capability support separately.

Acceptance studies: novice should be able to create and revise a live preview without reading source; expert must be able to inspect/edit every changed file and tool action. A task is successful only if accepted criteria pass on the integrated revision, even if screenshots look impressive. A run can be accurately *blocked* without being falsely labelled successful or failed.

## 13.4 Upstream-risk matrix

- **OpenCode V1/V2 churn:** adapter golden traces, pinned revision, minimal patch queue, no direct UI imports of internal SDK.
- **Provider SDK auth and terms:** support officially documented auth only; no assumption that paid chat subscriptions confer third-party API access.
- **Local-model quality:** capability-first detection, smaller context/selected harness, explicit limitations; no hidden model replacement.
- **Third-party agent bypass:** restricted execution environment or refuse strict mode.
- **SQLite dual stores:** acknowledge cursor and reconcile bridge; versioned schema, no shared WAL across hosts.
- **Unbounded tokens/disk:** cost ceilings, artifact pin/GC, auto-stop on no progress, visible unknown provider billing.
- **Worktree accumulation:** bounded warm pool plus quarantine, startup recovery and periodic sweep.
- **Feature availability:** CLI/SDK/agent provider capabilities can change; test before exposing an affordance.

## 13.5 Decisions still requiring spikes (do not falsely freeze)

1. Which OpenCode commit and API family is safe to pin for the first integration? Must benchmark realistic long-run workloads and provider parity.
2. Which existing built-in OpenCode tools can be policy-proxied without monkeypatching? Audit code paths and OS sandbox behavior.
3. Bun vs Node per worker on each desktop OS; measure cold start and memory.
4. Strict sandbox cross-platform parity (Linux namespaces/container, macOS sandbox, Windows restricted tokens/Job Objects/WSL); test actual escape protections.
5. Monaco vs CodeMirror in Tauri with LSP and debugging affordances.
6. Whether visual DOM-to-source mapping works on real imported React/Vue/Next/Angular repos without instrumenting source build; fail gracefully where impossible.
7. Exact remote runner authentication, durable transfer, and isolation contract.
8. Optional fallback policy UX; never silently enable it, A/B test only with informed permission.

## 13.6 Definition of done for the architecture package

A complete **design document** must pass syntax/structural tests but is not a runnable product. CI should verify machine contracts parse, schema migration works, all links to proposed code are labelled proposal, no duplicative provider ownership, no unbounded goal continuation, correct permission-mode labels, event schema versioning, no prototype assumed production-ready, and old v1 features remain mapped to an owner and verification test.

## Coding-agent continuous delivery contract

Agent startup and handoff are governed by repository-root `AGENTS.md`, `HANDOFF.md`, and [27](27-IMPLEMENTATION-READINESS-AUDIT.md). For each gate: requirements → exact source seam → typed function/schema/event/API → test proof → independent review → cleanup → next gate. Using subagents, MCP or a skill is conditional on actual available capability and file/resource isolation. Passing one narrow gate never constitutes a whole phase or release. Preserve user changes and prohibit paid model routing or irreversible release actions without explicit consent.

### 13.7 Core provider ToolBatch collection regression evidence

The Core runner regression suite now exercises the required zero-dispatch barrier for
incomplete/failed provider responses and schema-invalid batches: a local call followed by
transport failure, provider error, clean EOF without `finish`, `finish` without
`step-finish`, and a two-call batch with one invalid schema all produce zero local
executions. A valid five-call response proves concurrency starts only after the terminal
step is received and all call schemas pass. On 2026-10-10, `bun test
--timeout 30000 ./test/session-runner.test.ts` passed **91 tests / 296 assertions** and
`bun run typecheck` passed from `packages/core`. The recorded HTTP fixture remains green.
This does not test Rust-owned ToolBatch transitions, Guard, resource resolution, aggregate
byte/call limits, ordered result acknowledgements, or OS-enforced execution.
