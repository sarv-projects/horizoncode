# 10. Implementation sequence and acceptance gates

Status: normative dependency order. Current code/test evidence belongs in HANDOFF.md, not here.

## 10.1 Rule

Implement the smallest vertical slice that crosses real production owners, then prove it with negative/recovery tests before advancing. Do not build later UX around a bypass that the next phase intends to remove.

## 10.2 P0 — Preserve and pin the base

- preserve user changes and current OpenCode-derived source;
- record immutable upstream pins and license/provenance;
- keep one provider/session/tool substrate;
- keep build/package generators working.

Exit: source/provenance known and no competing runtime introduced.

## 10.3 P1 — Session observation and universal effect boundary

### P1.2-B Session observer/supervisor

Finish the authenticated, bounded, restartable read-only Core Session observer:
- OpenCode remains the only conversational writer;
- SessionLink uses stable source IDs/cursor/epoch/digest/redaction scope;
- authenticated private IPC, snapshot/replay, exact ACK and retention-gap behavior;
- automatic lifecycle/cursor owner and active-turn crash recovery;
- native platform acceptance where claimed.

### P1.3 ToolBatch Guard/ExecutionHost

Before any new effectful subsystem:
- enumerate every local/legacy/plugin/MCP/LSP/DAP/browser/desktop/REPL/provider-hosted effect path;
- collect the complete provider tool batch;
- validate every call against the request-pinned registry;
- Guard the whole batch before any mutation;
- PREPARE immutable EffectIntent and one-use lease;
- execute only through authorized ExecutionHost;
- persist receipt/outcome and reconcile UNKNOWN;
- disable unmediated hosted effects.

Exit: no mutation bypass in tested production paths.

## 10.4 P2 — Managed control plane

Add Rust-owned Goal, SpecVersion, Run, Task, Attempt, Evidence and Verification around SessionLink.

No Rust Thread/message database.

Exit:
- direct Session remains direct;
- managed Run survives restart;
- pause/cancel fence new work;
- verification binds final repository revision and acceptance criteria;
- non-idempotent UNKNOWN is not replayed blindly.

## 10.5 P3 — Fast coding path and repository intelligence

- files/search/edit Git/process/build/test wrappers through canonical capabilities;
- Hashline-style stale-edit strategy inside files.patch, not a second editor API;
- RepoIntel symbol/index generation and bounded lexical fallback;
- context operations and tool discovery;
- benchmark native walker/grep/AST only if they outperform existing code.

Exit: common coding change remains fast, guarded and source-grounded.

## 10.6 P4 — Language tooling, DAP and persistent REPL

- reuse healthy editor LSP where possible; otherwise supervised LanguageServiceBroker;
- code actions/rename are Guarded effects;
- DebugAdapterBroker for attach, breakpoint, step, variables and guarded evaluate;
- bounded persistent Python/JavaScript REPL workers with explicit lifecycle, resource caps and mediated tool callbacks;
- no arbitrary host Eval escape.

Exit: crash/restart, stale generation, multi-workspace and permission tests pass.

## 10.7 P5 — Browser, desktop and built-in web search

- BrowserBackend with owned/attached profile distinction and observation generation;
- DesktopAction service with window/display/AX/screenshot generation and OS capability matrix;
- WebSearch broker with direct search versus model-grounded search distinction, source provenance, auth and cost class;
- all mutations through Guard; no hidden paid fallback.

Exit: real platform journeys plus stale-ref, auth, privacy and denial tests pass.

## 10.8 P6 — Agents, extensions and provider/model UX

- AgentProfile/Harness registry and bounded specialist delegation;
- skills/hooks/MCP/plugin registry with sealed IDs and capability scoping;
- one ActionDescriptor for slash/menu/keybinding/API;
- session model picker plus broader provider/model/role hub;
- schema-driven settings with requested/effective/source/locked values;
- Goal review UI that cannot start effects without accepted SpecVersion.

Exit: TUI/desktop parity and credential/cost tests pass.

## 10.9 P7 — Streaming UI, artifacts, analytics and automations

- stable-prefix streaming and bounded UiEventMux;
- safe SVG preview, closed-fence Mermaid, deterministic table charts;
- terminal graphics capability negotiation and bounded image leases;
- durable artifact FULL/SAMPLE/FAILED truth;
- analytics measured/estimated/unknown provenance;
- durable automation scheduling that still invokes Guarded actions.

Exit: render fault isolation, accessibility fallback, no scroll/focus theft, crash/replay and artifact persistence tests pass.

## 10.10 P8 — Long horizon, recovery and real-work evaluation

- bounded parallelism/worktree pool;
- deterministic recovery and effect reconciliation;
- stopping criteria and quota-aware execution without hidden rerouting;
- task catalog across strong/small/local models;
- security/performance/platform release suites.

Exit: user intent is independently verified on final integrated revision.

## 10.11 P9 — Packaging/release

- license/notices;
- signing/update policy;
- platform support truth;
- config/data migration;
- clean-machine installation and upgrade;
- final UX/security/performance acceptance.

## 10.12 Post-V1 / separately gated

Remote/cloud continuation, shared live collaboration, autonomous self-improvement, broad voice/media features, hosted image generation, and full product identity migration remain separate product decisions unless 17 explicitly promotes them.

## 10.13 Current gate

Do not encode current progress here. HANDOFF.md is the bounded status checkpoint. The implementation agent starts from its first incomplete dependency, currently P1.3 after checking current source/tests prove those gates complete.

## 10.14 JCode-informed capability adoption and resource gate dependencies (A-V2-30)

This is accepted engineering work, **not a feature-cut list**. Preserve the P0–P9 dependency order and execute independent read-only measurement/UX research alongside P1/P2, without allowing an unguarded feature implementation to leapfrog the authoritative effect boundary.

1. **Baseline and instrumentation (parallel with P1):** add whole-process-tree PSS/CPU/FD/disk/renderer/provider metrics, reference-hardware task fixtures (1/5/10/20 sessions), cold/warm/long-run controls and local redacted diagnostic export. Write a raw baseline with no invented JCode speed or Horizon RAM claim. §18.17/§32.32.
2. **P1 effect and session boundary:** close shell/process, Task/subagent, MCP/plugin, provider-hosted and remaining mutations; complete cancellation/receipt/UNKNOWN tests. Instrument present Linux per-Session Rust observer before replacing it. A shared read-only observer prototype may be evaluated in isolation; no merged shared mutation host before equivalent isolation/authorization/recovery proof.
3. **P2 managed end-to-end control:** authenticated accepted Goal/Spec, persistent DAG scheduler, bounded headless WorkerExecution/Attempt and artifact-based dependency passing, scope-safe worktree/resource leases, independent verifier and final-revision proof. Deduplicate sessions/caches/resources without ever duplicating task authority. §15/§21/§29.
4. **P3/P6 developer essentials:** provider doctor (offline/catalog/full, paid consent), cross-session file-touch advisory and hashline/revision fences, safe external session import/resume, live provider/model/cost and worker health; add one public ActionDescriptor per capability, not a separate registry. §20/§33/§37.
5. **P7 user-experience and memory:** adaptive paint/dirty-region redraw, compact live tool-tail, bounded output/Markdown/Mermaid/image/index caches, local memory dashboard and opt-in retrieval; operational alerts and Mission Control resource columns. Performance regression fixtures and local diagnostics are mandatory for claimed support.
6. **P8/P9 proof and shipping:** 10/20-session real-work concurrency; exact error injections; cross-OS resource/security tests; installer/upgrade; legal/license review of any transplanted code; reproducible warm/cold startup and memory baseline. Only ship enabled capabilities whose own end-to-end gates pass.

**Implementation tracker:** `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` contains exact checkboxes and ordering. `HANDOFF.md` is the current observed status; `CURRENT_RUN.md` is a dated evidence/work log, not an architecture authority. A source signature, Markdown contract or JCode benchmark never upgrades `DESIGNED` to `TESTED`.

## 10.15 Implementation-ready slice definition and source-to-test ordering

“Only code left to fill” means an implementing agent can identify the canonical owner, exact ingress/egress, state/durability, function behaviour, failure class, test and release evidence without inventing a second architecture. The following table defines **what code remains to write** (not that these slices are shipped). Execute P1 universal Guard before effectful shared-kernel, workers, Doctor full tier or remote clients; RC0 read-only measurement can run in parallel.

| Work unit | Function owner/entry | Required first vertical output | Negative/recovery proof |
|---|---|---|---|
| R0.1 baseline | `scripts/perf/` harness + `ResourceSamplerV1.sample` | controlled 1/5/10/20 Sessions and raw process-tree PSS/private bytes + correct tasks | missing metric, PID reuse, shared daemon double count; JC-RES-001/004 |
| R0.2 cache accounting | existing context/index/TUI cache owners, `insertIfCurrent/evictToBudget` | byte/entry budget + per-family metrics, no canonical data eviction | concurrent pinned entry, 100MB output; JC-RES-005 |
| P1.3 guard origins | Core and legacy tool dispatch → Rust `Guard.authorize` and `EffectHost` | real shell/process first, then Task/subagent and other origins; complete pre-dispatch authorization | denied spawn count zero, callback/MCP/hosted bypass, cancellation/UNKNOWN; §14/§32 |
| R1.1 virtual Session | `SessionSupervisor.Service` + Rust `VirtualSessionBroker.attach/subscribe/ack` | safe read-only multi-Session event pages behind existing API | wrong peer/session, slow consumer, restart/retention gap; JC-RES-008/009/010 |
| R1.2 shared effects | same §14 Rust effect owner | **only after P1** route one supported effect through shared broker with rollback | exactly-once lease claim where possible, UNKNOWN reconciler and old/new exclusive authority |
| P2.1 admitted spec | `ManagedControl.open/apply` + authenticated RPC | accepted full SpecVersion, durable Run and Task dependency graph | stale revision, invalid criterion/scope, graph cycle and replay |
| P2.2 worker pool | Rust scheduler/resource reservations + `ExecutionHost` | one Task → supervised Attempt → typed artifact and effect receipts | user edit, denied subagent, crash/lease/UNKNOWN; JC-RES-007/011/012 |
| P2.3 finalizer | trusted verifier adapter and Rust final revision fence | Task independent PASS, dependent READY, final Run SUCCESS only on current revision | forged verifier, stale repo, missing criterion/effect; JC-RES-018 |
| R3 Doctor | existing provider transport/config + `ProviderDoctorV1` | offline then catalog then consented full stream/tool probe | unavailable account, 429, spend/cancel, no fallback; JC-RES-013–015 |
| R3 file activity | canonical file/read/write observation + `FileTouchIndexV1` | reverse path/session read-write advisory, hard precondition still Guard | false read conflict, symlink, user patch; JC-RES-011 |
| R3 context/import | ContextLedger/indexd + Session import adapter | scoped token-bounded recall and explicit single-owner snapshot/resume | secret/path isolation, old preview, malformed import; JC-RES-019/020 |
| R4 renderer/ops | existing TUI event loop + `UiRedrawBudgetV1` | dirty-region paint, bounded live tail, resource panel | slow consumer, idle CPU, reconnect, terminal injection; JC-RES-016/017 |
| R5 SDK/steering | canonical public Session API + typed `ClientAttachmentV1` | two clients see one transcript with scoped steering | conflicting writer, stale turn epoch, revoked remote session |
| R5 developer canary | existing build tooling + Guarded rollout | explicit OFF developer preview with rollback, **not unreviewed self-modification** | security code hot-swap during UNKNOWN denied, failed rollback, build disk pressure |

**Per-slice sign-off:** 1. exact owner/source/hydrated paths; 2. wire schema version + typed error; 3. user authorization/feature exposure; 4. state transition with durable vs derived distinction; 5. happy path **and** timeout/cancel/crash/unknown; 6. process/disk/token/cost resource charge; 7. source-revision/final outcome proof; 8. benchmark/task regression and native platform qualification; 9. raw CI commit/test/OS evidence in HANDOFF. Checklist owner: existing `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md`. A task is not complete because its HLD/LLD is present.
