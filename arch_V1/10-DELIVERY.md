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

### Deferred engineering TODO — after V1 implementation and verification only

Do **not** start this migration during P1–P9 or use it to block core V1 delivery. Once V1 is implemented, its end-to-end acceptance gates pass, and there is a stable release/build baseline:

- [ ] Refactor the TypeScript workspace/build/typecheck/test architecture for HorizonCode ownership: package boundaries, project references, build graph, caching and incremental checks; retain full CI/release verification while making routine development checks faster.
- [ ] Migrate public npm/package, executable, product, generated-client, artifact, script, environment/config, CI/workflow, release and displayed identifiers consistently to **HorizonCode** (public npm/CLI name: `horizoncode`; `hzcode` may be an alias). Remove obsolete OpenCode *product branding* where owned by HorizonCode.
- [ ] Where feasible, migrate first-party TypeScript package scopes, internal import aliases and generated declarations away from `@opencode-ai/*` behind compatibility shims, in a versioned, staged manner; never blindly rename genuine upstream dependencies or break the pinned-source hydration model.
- [ ] Preserve upstream OpenCode copyright/license/notices and source attribution even if HorizonCode's product-facing identity is unified. Never falsify authorship or strip legally required metadata.
- [ ] Test Linux/Windows clean install, executable launch, full builds, monorepo and affected-package typechecks, tests/Guard flows, update/migration, npm publish dry-run/tarball contents, backward compatibility and rollback at the final integrated revision.
- [ ] Remove temporary compatibility paths only after their replacement is validated and migration is documented. Avoid unnecessary duplicate builds, disk growth or concurrent heavy compilers.

**Exit:** supported HorizonCode-facing naming is consistent, no legacy product-name leaks remain outside genuine upstream dependency/license references, development validation is efficient, and clean-install/release tests pass. Treat this as a **deferred post-V1 TODO**, not an implementation task for the current gate.

## 10.13 Current gate

Do not encode current progress here. HANDOFF.md is the bounded status checkpoint. The implementation agent starts from its first incomplete dependency, currently P1.3 after checking current source/tests prove those gates complete.
