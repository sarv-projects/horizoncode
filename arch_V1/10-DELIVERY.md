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

## 10.7 P5 — Browser, desktop and built-in web search (post-V1)

Browser automation/attached-browser interaction, desktop/computer control, browser-based visual editing and built-in web search are **deferred post-V1** under A-V2-31. Keep these paths unavailable; a documented service contract or upstream implementation is not a V1 feature. Reopen only through an explicit scope decision and the existing Guard, privacy, auth, cost and platform acceptance gates.

## 10.8 P6 — Agents, extensions, providers and settings UX (V1 CLI/TUI)

- AgentProfile/Harness registry and bounded specialist delegation;
- skills/hooks/MCP/plugin registry with sealed IDs and capability scoping;
- one ActionDescriptor for slash/menu/keybinding/API;
- session model picker plus provider/model/role hub, with OMP as the preferred source for compatible provider/UI patterns;
- schema-driven CLI/TUI settings with requested/effective/source/locked values;
- Goal review UI that cannot start effects without accepted SpecVersion.

V1 scope is CLI/TUI only. Preserve one config/auth/Session owner and prove credential/cost/no-fallback behavior. Web/desktop parity is post-V1.

Exit: CLI/TUI state and action semantics agree, and credential/cost/Guard tests pass.

## 10.9 P7 — Streaming TUI, artifacts, analytics and automations (V1)

- stable-prefix streaming and bounded UiEventMux;
- safe SVG preview, closed-fence Mermaid, deterministic table charts;
- terminal graphics capability negotiation and bounded image leases;
- durable artifact FULL/SAMPLE/FAILED truth;
- analytics measured/estimated/unknown provenance;
- durable automation scheduling that still invokes Guarded actions.

V1 renders through CLI/TUI only; web/desktop render surfaces are post-V1. Automations remain owned by Rust and invoke ordinary Guarded actions.

Exit: render fault isolation, keyboard/accessibility fallback, no scroll/focus theft, crash/replay and artifact persistence tests pass.

## 10.10 P8 — Resource efficiency, recovery and real-work evaluation (V1)

- measured process-tree baseline and bounded parallelism/worktree/resource pools;
- worker/subagent DAG with typed results, added only after the single managed Attempt and independent verifier pass;
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

Web and desktop applications, browser/desktop interaction, built-in web search, remote/cloud continuation, shared live collaboration, autonomous self-improvement, broad voice/media features, hosted image generation, external ACP/VIS/DEP journeys, and full product identity/build migration remain post-V1 unless a later §17 decision promotes them.

**Targeted adapted-code identity during V1:** newly adapted first-party modules, packages, folders and configuration identifiers use HorizonCode naming as they are created. Preserve upstream notices and genuine dependency names. This does not mean a wholesale rename of the pinned OpenCode-derived source or a public package migration during V1.

### Deferred engineering TODO — after V1 implementation and verification only

Do **not** start this migration during P1–P9 or use it to block core V1 delivery. Once V1 is implemented, its end-to-end acceptance gates pass, and there is a stable release/build baseline:

- [ ] Refactor the TypeScript workspace/build/typecheck/test architecture for HorizonCode ownership: package boundaries, project references, build graph, caching and incremental checks; retain full CI/release verification while making routine development checks faster.
- [ ] Migrate public npm/package, executable, product, generated-client, artifact, script, environment/config, CI/workflow, release and displayed identifiers consistently to **HorizonCode** (public npm/CLI name: `horizoncode`; `hzcode` may be an alias). Remove obsolete OpenCode *product branding* where owned by HorizonCode.
- [ ] Where feasible, migrate first-party TypeScript package scopes, internal import aliases and generated declarations away from `@opencode-ai/*` behind compatibility shims, in a versioned, staged manner; never blindly rename genuine upstream dependencies or break the pinned-source hydration model.
- [ ] Preserve upstream OpenCode copyright/license/notices and source attribution even if HorizonCode's product-facing identity is unified. Never falsify authorship or strip legally required metadata.
- [ ] Test Linux/Windows clean install, executable launch, full builds, monorepo and affected-package typechecks, tests/Guard flows, update/migration, npm publish dry-run/tarball contents, backward compatibility and rollback at the final integrated revision.
- [ ] Remove temporary compatibility paths only after their replacement is validated and migration is documented. Avoid unnecessary duplicate builds, disk growth or concurrent heavy compilers.

**Exit:** supported HorizonCode-facing naming is consistent, no legacy product-name leaks remain outside genuine upstream dependency/license references, development validation is efficient, and clean-install/release tests pass. Treat the global migration as a **deferred post-V1 TODO**; the targeted naming rule for new adapted modules is in force during V1.

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

## 10.16 Accepted journeys outside the V1 CLI/TUI boundary: ACP, visual edit and deploy

These previously had normative user journeys (§§3.16–3.18), but not the same explicit function/contract/test coverage as resource work. Under A-V2-31, they are **not V1 release blockers** and remain unavailable unless separately promoted.

- **ACP outbound adapter:** external ACP protocol/client integration is post-V1. Local Rust-owned subagents/workers remain V1 under §29 and the V1 tracker; a native OpenCode backend remains an explicit separate session owner if selected.
- **Visual source edit:** depends on browser/DOM observation and is post-V1. Keep it unavailable; preserve VIS-001..004 as future acceptance.
- **Deployment with verification:** production/provider deployment journeys are post-V1. Keep remote mutation unavailable; preserve DEP-001..008 as future acceptance.
- **No automatic availability promotion:** §33.30 candidate IDs are design-reserved; actual runtime, platform and credential adapters require compiled contracts and tests first. Unsupported remote/hosted effects must be disabled in governed mode.
- **Release evidence:** test an actual user-selected available backend against a disposable example application, with mutation isolation and outcome proof, before describing these as working. Running a generic shell command does not fulfill the deployment API, and the existence of OpenCode's ACP server does not fulfill Horizon's outbound adapter.

The single operative dependency order is P0–P9 plus RC0–RC5 in the current plan; `implementationtov1release.md` owns the user-requested V1 scope/status crosswalk. Work can proceed on source-verified read-only adapter discovery in parallel with P1, but **no effectful rollout before universal Guard**.
