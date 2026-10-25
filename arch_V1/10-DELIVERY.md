# 10. Implementation sequence and acceptance gates

Status: normative dependency order. Current code/test evidence belongs in HANDOFF.md, not here.

## 10.1 Rule

Implement production-connected slices and prove each boundary with negative/recovery evidence.
The dependency order is an acceptance gate, not a cap on independent phase work: prepare and
implement every unblocked phase/module in parallel, while keeping dependent effectful paths
unavailable until their prerequisite evidence passes. Do not build later UX around a bypass that
the next phase intends to remove.

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
- V1 ContextService compilation of the bounded provider-visible context for direct and managed
  prompt paths, with source/revision/token provenance;
- context operations and progressive authorized tool discovery;
- V1 CodeMode using the existing OpenCode-derived interpreter as a short-lived helper process
  under the existing Rust ExecutionHost supervisor and the existing tool registry. Core handles
  bounded versioned stdio tool RPC through SessionSupervisor and the normal atomic ToolBatch, Guard,
  lease, receipt and UNKNOWN path. Apply the selected ResourceProfile with OS-enforced cgroup-v2
  containment before execution; CodeMode is unavailable without accepted containment. Cap one script
  at 64 calls in waves of at most 32, 30 seconds, 64 KiB source/output and 1 MiB aggregate payload.
  Do not add a second interpreter, supervisor, or capability authority.
- benchmark native walker/grep/AST only if they outperform existing code.

Exit: common coding change remains fast, guarded and source-grounded.

## 10.6 P4 — Language tooling, DAP and persistent REPL

- reuse healthy editor LSP where possible; otherwise supervised LanguageServiceBroker;
- code actions/rename are Guarded effects;
- DebugAdapterBroker for attach, breakpoint, step, variables and guarded evaluate;
- bounded persistent Python/JavaScript REPL workers with explicit lifecycle, OS-enforced resource limits where required/supported, and mediated tool callbacks; keep execution unavailable when required CPU/memory guarantees are not enforced (`DEC-V1-27`);
- no arbitrary host Eval escape.

Exit: crash/restart, stale generation, multi-workspace and permission tests pass.

## 10.7 P5 — Browser/desktop (post-V1) and built-in web search (V1)

Browser automation/attached-browser interaction, desktop/computer control and browser-based visual editing are **deferred post-V1** under A-V2-31. Keep these paths unavailable; a documented service contract or upstream implementation is not a V1 feature. Reopen only through an explicit scope decision and the existing Guard, privacy, auth, cost and platform acceptance gates.

Built-in web search is **in V1** per the 2026-10-18 user scope decision (`DEC-V1-26`): §33.9 `web.search.*`, §37.5 `WebSearchBrokerV1`, §16.7/§16.15 provider settings, `DEC-V1-20` cost/auth/reliability matrix, tests in §32. After first-use search consent, its trusted route plan starts with the default-enabled free anonymous built-in cascade; BYO authenticated routes join only when explicitly user-enabled. Grounded-model search is separate and explicit-only. The model supplies no route/account/auth/cost selection. Record route provenance and failures; auth 4xx may fall through only to another explicitly enabled route. No hidden paid route.

## 10.8 P6 — Agents, extensions, providers and settings UX (V1 CLI/TUI)

- AgentProfile/Harness registry and bounded specialist delegation;
- direct Core child-Session fan-out is a distinct V1 delegation lane, bounded by its profile,
  direct-session grant, resource admission and child limits; it is not contingent on managed
  Goal/Task settlement;
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
- durable artifact wire fidelity `full`/`head_tail_sample`/`failed` (displayed as FULL/SAMPLE/FAILED);
- analytics measured/estimated/unknown provenance;
- durable automation scheduling that still invokes Guarded actions.

V1 renders through CLI/TUI only; web/desktop render surfaces are post-V1. Automations remain owned by Rust and invoke ordinary Guarded actions.

Exit: render fault isolation, keyboard/accessibility fallback, no scroll/focus theft, crash/replay and artifact persistence tests pass.

## 10.10 P8 — Resource efficiency, recovery and real-work evaluation (V1)

- measured process-tree baseline and bounded parallelism/worktree/resource pools;
- managed multi-Task worker/subagent DAG with typed results, enabled only after each Task has
  independent current-revision evidence and Rust has a durable aggregate settlement/final-Run
  contract. Direct-session fan-out is governed separately under P6 and §29;
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

Web and desktop applications, browser/desktop interaction, remote/cloud continuation, shared live collaboration, autonomous self-improvement, broad voice/media features, hosted image generation and external ACP/VIS/DEP journeys remain post-V1 unless a later §17 decision promotes them. **Amended 2026-10-23 by §17.7:** the complete HorizonCode-owned product identity migration is V1 work; the pinned OpenCode tree, genuine vendor/package/API identifiers, legal attribution and compatibility facts remain protected.

**First-party identity during V1:** new and existing HorizonCode-owned package/build/typecheck/generated/user-facing identities migrate to HorizonCode in staged, tested steps under §17.7 and §20.17. Keep upstream source provenance and genuine vendor/API names unchanged; distinguish product-facing identity from source compatibility and legal attribution. This does not authorize rewriting the pinned `opencode/` snapshot or public distribution.

### Deferred engineering TODO — after V1 implementation and verification only

The 2026-10-23 §17.7 amendment promotes HorizonCode-owned identity migration into V1. The following *build-architecture optimization* remains a post-V1 TODO and must not be confused with the required naming migration:

- [ ] Refactor the TypeScript workspace/build/typecheck/test architecture for incremental performance: project references, build graph, caching and focused checks; retain full CI/release verification. This performance modernization remains after V1 unless separately promoted.
- [ ] Preserve upstream OpenCode copyright/license/notices and source attribution even if HorizonCode's product-facing identity is unified. Never falsify authorship or strip legally required metadata.
- [ ] Test Linux/Windows clean install, executable launch, full builds, monorepo and affected-package typechecks, tests/Guard flows, update/migration, npm publish dry-run/tarball contents, backward compatibility and rollback at the final integrated revision.
- [ ] Remove temporary compatibility paths only after their replacement is validated and migration is documented. Avoid unnecessary duplicate builds, disk growth or concurrent heavy compilers.

**V1 identity exit:** all HorizonCode-owned product/package/build/typecheck/generated identifiers and first-party non-legal prose follow §17.7; legacy aliases are tested against the same runtime, genuine upstream/vendor/legal/compatibility identifiers are preserved, and `NAME-001..004` pass on the exact candidate. The separate incremental-build architecture optimization remains post-V1; it is not a prerequisite for the naming exit unless required to make the V1 check reproducible.

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

## 10.17 VEO note review: required phase refinements (A-V2-33)

The complete supplied note review refines existing V1 delivery owners; it adds no phase after P9. Implement the selected requirements within the owning phases:

| Phase | Required refinement | Dependency edge |
|---|---|---|
| P1 | Authenticated child/effect scope, one Guard/ExecutionHost, product confinement, denial before dispatch, cancellation and UNKNOWN reconciliation | Gate before P2 effects and all dependent P4/P5/P7/P8 effects |
| P2 | One bounded managed Attempt, typed lineage-bearing result, distinct authenticated reviewer and independent verifier against live final workspace revision. Accepted deterministic checks may block settlement but cannot grant authority or alter criteria. | P1 dispatch proof; P7 ArtifactStore evidence API |
| P3 | Bounded generation-bound structural navigation with parser/coverage provenance and stale-write refusal | P1 read-scope/source freshness contracts; existing embedded RepoIntel owner |
| P6 | Provider/model-pinned cache/cost provenance; reviewed skill/profile proposals with no automatic activation | P1 for network/effectful probes; existing config and extension registry |
| P7 | Full artifact/evidence refs behind compact redacted UI projection; durable replay separated from ephemeral progress; truthful artifact fidelity | P1/P2 for effectful automation and verifier consumption |
| P8 | Attribute and reserve child/index/test/verifier resources; recover without releasing unsettled authority | P2 verified single Attempt before fan-out |

P3, P6 and non-effectful P7 preparation proceed while P1/P2 dependencies are open. Effectful dependent paths remain unavailable until upstream contract and adversarial/recovery evidence pass. P4, P5 and P9 retain their current V1 scope. VEO-F1..F8 remain optional post-V1 proposals and do not block release. Contract, flow, event and test detail is owned by §§3.21, 4.13, 12.18, 29.20, 30.23–30.25, 31.19, 32.38, 32.47 and 37.22.

## 10.18 V1 competitive adaptation priorities (2026-10-22)

Status: normative **release ordering** distilled from external competitive research (Windsurf/Devin Desktop, OpenCode/mgrep, Cursor indexing, Aider repo-map, code-review-graph, and related MCP marketing). This section does **not** promote competitor features into scope by itself; it records **what V1 must finish wiring and accept** using pinned OpenCode/OMP/Codex **patterns** inside existing owners. Research evidence lives in `docs/research/2026-10-21-pi-codex-harness-decisions.md` and §42.21; product law remains §17 (`DEC-V1-34`, `DEC-V1-35`) and A-V2-31.

**Adapt** means complete integration, negative/recovery tests, and honest feature exposure — **not** bolting on separate products (mgrep, code-review-graph, Windsurf IDE shell) as parallel authorities. **Reject as V1 core:** default cloud semantic indexes, second repository graphs, Wasm plugin VMs, headless browser/desktop surfaces, and episodic vector preference stores (see §10.12 and §30.25).

### 10.18.1 Adapt most for V1 (release-critical)

| Prio | What to adapt | Why V1 | Competitor idea answered (without copying) | Primary owner | Acceptance trace |
|---:|---|---|---|---|---|
| 1 | P1 Guard / ExecutionHost / sandbox / receipts / UNKNOWN + **direct migration parity** (`DEC-V1-36`: read fast path, warm IPC, batched read RPC) | Nothing else is shippable or honest without it; must not regress OpenCode/Cursor/Claude/Codex direct UX | Codex sandbox; competitor CLI speed | §14 §14.3.1, §10.3 P1.3, §31.24 | §32.14, §32.20, §32.49 PERF-DIRECT-* |
| 2 | P2 managed lane: one Task vertical → bounded DAG (`DEC-V1-31`) | Core “agent that doesn’t lie about done” | Codex threads; Pi durable invariants only | §11, §29.18 | §32.9, §32.12, SA-* |
| 3 | §30 context: ledger/selection, **§30.26 cache-anchor vs minimize-tokens**, progressive tools, pressure ops | Token/$ per useful work; stable prefix on cache routes | Aider/Cursor algorithms in one owner | §30.2–30.6, §30.21, §30.26, §37.30 | §32.10–11 (`CX-014`..`021`), CTX-* §32.45 |
| 4 | P3 RepoIntel in `indexd`: generations, authenticated `query_structure`, `repo.tree`/`repo.detect`, bounded repo tools | Local-first `@codebase` baseline | Lexical/structure first; not “99% MCP graph” | §30.7–30.10, §30.22–30.25 | §32.4, RD-*, §32.47 V1-ADAPT-004 |
| 5 | P4 LSP (+ DAP/REPL per A-V2-25): broker, diagnostics, document reads via HostKernel | Correctness (diagnostics), not AST-only | “Smart fix” vs tree-sitter-only | §30.7, §37.6–37.8 | §32.28, LS-* |
| 6 | P5 built-in web search (`DEC-V1-26`): trusted cascade, provenance, no silent paid | V1-promoted capability | Competitor search; page-fetch/cache deferred | §37.5, §33.9 | §32.28, WS-* |
| 7 | P6 providers / settings / Doctor / S1 (OMP-style UX, models.dev metadata) | Daily usability on local + BYO providers | Cursor provider UX; no hidden fallback | §16, §37.16–19 | §32.21, §32.31, PD-* |
| 8 | P7 TUI: streaming lanes, context bar, **activity digest** (§31.22), **fast code/diff** (§31.23), layout (§16.21), artifacts, §31 budgets; P3 **instruction load** (§29.23) | Speed + RAM on CLI/TUI; progressive AGENTS/CLAUDE | Cursor-like **edit digest**; Claude **memory** loading model | §31, §16.21, §29.23 | §32.16–17, §32.48 (`ACT-*`), UI-024–030, INST-* |
| 9 | P8 worktrees / reservations / RC0 resource accounting (fan-out gated) | Parallel workers when P1/P2 prove safe | OpenCode/Codex worktree patterns; not unbounded agent fan-out | §21, §18.17–18 | §32.32–33, JC-RES-*, GS-* |
| 10 | `DEC-V1-28`/`DEC-V1-29`: direct grants + CodeMode over existing tool tree (after P1) | Fewer round-trips without new authority | Cloudflare Code Mode **pattern** only | §14, §29.22, §33 | §32.41 CM-*, GRANT-* |
| 11 | P9 install, `horizoncode`/`hzcode`, release gates | Actually “released” | — | §18, §10.11 | §32 release rows, clean-install gates |

### 10.18.2 Inside P3/P4 — adapt algorithms, same owners

Do **not** add a second stack (Python CRG install, default mgrep cloud sync, or duplicate MCP graph authority).

- **Aider-style repo map** (tree-sitter tags → file/symbol graph → rank to token budget) → `indexd` + `ContextSelection` / Context compile (§30.25).
- **Cursor-style hybrid retrieval** → lexical `indexd` + **optional explicit** embeddings (§30.7: embeddings only when user enables); no default cloud index.
- **LSP diagnostic loop** (edit → publish → diagnostics → bounded retry) → P4 broker + session runner; not a separate Rust LSP product unless a measured ADR says otherwise.

### 10.18.3 Strong V1 “nice to have” (only if critical path is green)

| Item | Note | Owner |
|---|---|---|
| Symbol/reference edges + `impact.analyze` | Large accuracy win; still one `indexd` owner (§42.11 rejects OMP graph port as-is) | §30.8–30.9, §33 |
| Opt-in local embeddings | §30 allows; not required to pass V1 release gates | §30.7, §30.21 recall |
| Light mid-run steering (queue message, goal revision `LH-007`, fresh-turn auth) | Partial V1 via P2/P7; not full CRDT co-editing | §03, §11, §32.12 |
| Persistent `indexd` packs | HostKernel-owned; not a blocker if rebuildable in-process passes acceptance | §30.21, P1/P8 cache |

### 10.18.4 Explicitly post-V1 (do not spend V1 implementation time)

Headless browser/Playwright visual QA; desktop/computer control; web/desktop GUI shells (Windsurf/Devin Desktop-class IDE); mgrep/CRG/**Codebase Memory MCP** as bundled repo engine; default team cloud embeddings; Wasmtime plugin VM (`DEC-V1-05`); kernel Rhai/Lua scripting; LanceDB-style episodic preference learning; full CRDT “grab the wheel” co-editing; Horizon-as-MCP-server (`DEC-V1-23`); external ACP client (`DEC-V1-24`); thin mobile/iOS client (§42.9 candidate #24); competitor marketing token-reduction percentages without §32/HUP evidence.

**Exit:** Every row in §10.18.1 maps to an owning topic document, flow section, schema/capability ID where applicable, and §32.47 traceability ID. Unmapped competitor ideas remain research-only in §42.21.

## 10.19 Product excellence bundle (speed, accuracy, reliability, capabilities, long horizon)

Status: normative V1 product requirements (`DEC-V1-37`, `DEC-V1-38`). Implementation spans P1–P8;
acceptance §§32.49–52, §32.40 HUP-*, §30.27–30.30.

| Pillar | Owner sections | Release-critical behaviors |
|---|---|---|
| **Speed** | §14.3.1, §30.28, §31.24, `DEC-V1-36` | Read fast path, warm IPC, compile overlap, symbol-first, cold index non-blocking |
| **Accuracy** | §30.29, §10.18.2, §33.18 hooks | Edit loop + diagnostics, stale-edit fences, verifier ≠ coder, HUP holdout, local verify job |
| **Reliability** | §30.30, §14 UNKNOWN UX, §16 checkpoints | Pressure ladder, import/export, graceful resource degrade |
| **Capabilities** | §33.32–33, §29.6 `builtin.horizoncode` | Core/Extended/Experimental tiers; skills + tools.search in Core; honest effective counts |
| **Long horizon** | §30.27 epochs, §30.26 tiers, §31.22 digest | `/clear` vs compact vs Goal; cache_anchor; activity not in context |

**Competitor parity:** OpenCode skill catalog + tool registry; Codex scoped instructions + thread
tools—Horizon matches with **metadata-first skills**, **`builtin.horizoncode`** integration
skill, and Guarded mutations (§42.21, §46-V1-MIGRATION-PARITY.md).
