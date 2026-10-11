# 35 — User-request coverage matrix and competitor-source reconciliation

**Status:** normative audit ledger for the 2026-10-11 architecture pass. This chapter answers
whether the requested coding/system-agent capabilities were actually given an owner, contract,
failure model and release gate. It does not claim implementation merely because coverage exists.

Status vocabulary:
- **SPECIFIED** — explicit normative owner/contract exists;
- **CODE_PRESENT** — relevant current code/asset exists but may not be wired/accepted;
- **PARTIAL** — some design/source exists but an important contract or implementation gate remains;
- **POST-V1** — intentionally deferred;
- **REJECTED** — deliberately not part of the design.

## 35.1 Comparison sources actually reviewed

| Source | What was inspected/used | Confidence / use in HorizonCode |
|---|---|---|
| OpenCode pinned/current source | provider/model auth, Session/input/message/provider continuation, tools, skills, config, MCP, LSP, permissions, worktrees, app/TUI/server | primary implementation base; reuse instead of rebuilding |
| OpenAI Codex public source/docs | goal/thread lifecycle, sandbox/approval, multi-agent patterns, app-server/control surfaces, context/recovery patterns | high-confidence comparison; no code copying beyond license-compatible reuse decisions |
| Cline public source/docs | checkpoints, context/compaction, subagent/team patterns, cost/usage/E2E task harness | high-confidence comparison |
| Claude Code official docs/public repo | agents/subagents, commands, hooks, permissions, memory/config behavior | authoritative only for public behavior |
| `chauncygu/collection-claude-code-source-code` | reconstruction/decompiled patterns only | low-confidence research; never architecture authority or copy source |
| xAI Grok Build public source/docs | Rust execution/TUI/pager, hooks, skills, subagents, worktrees, Mermaid/rendering, custom endpoints, session UX | high-confidence pattern/reference |
| OpenHands current public architecture/docs | Agent Canvas vs Agent Server boundaries, sandbox/workspace/backend choice, automation service, persistence/condenser/memory | high-confidence public architecture; reviewed after initial pass |
| mini-SWE-agent v2 public source/docs | minimal model/environment/agent loop, independent subprocess actions, bash-only interface, local/sandbox environments, confirm/yolo modes | high-confidence minimal-baseline reference; reviewed after initial pass |
| Open Interpreter current Rust public repo/docs | low-cost/local models, provider/model setup, harness emulation, ACP/Codex compatibility, sandbox/approval surface | high-confidence harness/local-model reference; reviewed after initial pass |

**Correction to the earlier audit:** Codex/OpenCode/Cline/Grok Build/Claude patterns were examined
more deeply in the first comparison pass. OpenHands, mini-SWE-agent and Open Interpreter were not
covered to the same depth until this follow-up. Their resulting requirements are now included
below and in §§29–33.

## 35.2 Base reuse, modularity and ownership

| Requested capability / decision | Status | Horizon owner / decision | Remaining gate |
|---|---|---|---|
| Use OpenCode as the base instead of rebuilding providers/sessions | SPECIFIED | §§17,19,20; OpenCode owns canonical Session/Input/Message/Part/provider continuation | route/effect mediation acceptance |
| Reuse battle-tested provider/model/auth/session pieces | SPECIFIED + CODE_PRESENT | OpenCode packages retained; no parallel Rust provider stack | compatibility + regression tests |
| Rust only where it materially improves durability/security/process ownership | SPECIFIED | Rust managed control/effects/leases/recovery/evidence; TS/OpenCode provider/session remains | native Windows + control seam |
| Modular/decoupled components | SPECIFIED | typed owners/services, CompositionService, adapters, schemas, §20 LLD | implementation convergence |
| Upgrade upstream without redoing Horizon architecture | SPECIFIED | pinned upstream/reference + adapter seam + source map | actual upgrade procedure/tests |
| Product-owned built-ins belong to HorizonCode, not `.opencode` | SPECIFIED + CODE_PRESENT | canonical `packages/core/src/horizon/...`; `.opencode` only customization/compat shim | embedded registration/UI tests |
| Complete HorizonCode branding/systemwide rename | POST-V1 mandatory P10 | §10 identity migration | begin only after V1 gates |

## 35.3 Agent profiles, specialists and multi-agent orchestration

| Request | Status | Coverage |
|---|---|---|
| Build + Plan primary agents | SPECIFIED | §§29,33 |
| Explorer / architecture-oracle / librarian / looker / reviewer / debugger / history / verifier | SPECIFIED | §§29,33 |
| System-operation specialist | SPECIFIED | `builtin.system-operator`; ordinary Guard authority only |
| Browser/UI QA specialist | SPECIFIED | `builtin.browser-qa`; scoped browser authority, no implicit source write |
| User-defined agents/subagents | SPECIFIED | `AgentProfileV2`, immutable revisions |
| Per-agent provider/model | SPECIFIED | explicit selection; no hidden routing |
| Per-agent reasoning/effort budget | SPECIFIED | profile reasoning + limits |
| Allowed/denied tools, skills, MCP, subagents | SPECIFIED | profile capability rules + parent intersection |
| Path allow/deny rules | SPECIFIED | `PathRuleV2` + Guard |
| Context isolation: fresh/slice/fork | SPECIFIED | §29 |
| Input modes: normal/read-only/careful/sandbox-auto | SPECIFIED | §29 + execution-boundary enforcement §14 |
| Provider-specific variants | SPECIFIED | deterministic profile variant resolution |
| Typed parent↔child messaging | SPECIFIED | DelegationService / TaskPackage / bounded ArtifactRefs |
| Blocking request/reply between agents | SPECIFIED | typed delivery/reply; no authority transfer through text |
| Parallel subagents only when useful | SPECIFIED | estimate/admit checks cost, dependency/resource conflict and overhead |
| Unified progress/worker panel | SPECIFIED | §31 Mission Control |
| Child crash/replacement without losing state | SPECIFIED | durable Task/Attempt/Worker binding + recovery |
| Independent verifier separate from author | SPECIFIED | verifier permit + VerificationService |

## 35.4 Harnesses and local/cheap/weak models

| Request | Status | Coverage |
|---|---|---|
| Local/free/inexpensive models first-class | SPECIFIED | §30 |
| Ollama | SPECIFIED | LocalEndpointProfile |
| LM Studio | SPECIFIED | LocalEndpointProfile |
| LiteLLM | SPECIFIED | compatibility endpoint/gateway |
| Any OpenAI-compatible endpoint | SPECIFIED | generic endpoint profile |
| Never silently switch to paid provider/model | SPECIFIED / REJECT hidden routing | §§17,29,30,33 |
| Separate model/provider from agent harness | SPECIFIED | `HarnessProfileV1` §29/§20 |
| Native rich harness | SPECIFIED | `harness.native-rich` |
| Minimal small-context harness | SPECIFIED | `harness.native-minimal` |
| Bash-only/minimal action harness | SPECIFIED | `harness.bash-only`, inspired by mini-SWE simplicity |
| Compatibility harnesses for provider-tuned surfaces | SPECIFIED | `harness.compatibility:<name>`; versioned, no provider switch |
| Weak function-calling models | SPECIFIED | strict text/structured codec, bounded repair, no ambiguous execution |
| 4K/8K context operation | SPECIFIED | compact prompt, lazy tools/skills/context, retrieval-first tests |
| Cold local model loading | SPECIFIED | connect/health separate from load/queue/TTFT |
| Hardware insufficient | SPECIFIED | diagnostics, no automatic cloud fallback |
| Measure harness overhead separately from model quality | SPECIFIED | runtime observation/perf contracts |

## 35.5 Context engineering, memory and history

| Request | Status | Coverage |
|---|---|---|
| Live context bar segmented by type | SPECIFIED | §§30–31 |
| Typed entries: system/user/assistant/thinking/tool/subagent/image/doc/file/artifact/memory | SPECIFIED | `ContextEntryV2` / context-ledger schema |
| `@` file/folder/symbol/thread attachment | SPECIFIED | ContextRef/mention UX |
| `/trim` tool payload removal | SPECIFIED | canonical history preserved |
| `/prune` AI-assisted stale-text proposal | SPECIFIED | preview + protected entries |
| `/compact` summarization | SPECIFIED | model-visible projection only |
| `/clear` without deleting conversation | SPECIFIED | ContextEpochMarker |
| protected recent turns | SPECIFIED | configurable protected policy; no destructive cleanup |
| History-search agent can recover old content | SPECIFIED | `builtin.history-search` |
| Named memory blocks | SPECIFIED | reviewed named blocks/provenance |
| Project/user durable knowledge | SPECIFIED | MemoryService; untrusted/reviewed provenance |
| Persistent memory must not silently become instruction authority | SPECIFIED | trust classification + prompt-injection rules |
| Auto-compaction under pressure | SPECIFIED | threshold policy; actual threshold configurable/benchmarked, not hard-coded marketing claim |
| Large bash/terminal output stored outside prompt | SPECIFIED | bounded model output + terminal/artifact range/search |
| Provider cache breakpoints / cache visibility | SPECIFIED conceptually | §30/§31 cache classes + analytics | exact provider cache support must be probed |
| Context cleanup visible to user | SPECIFIED | context panel/operations UI |

## 35.6 Repository intelligence and IDE coexistence

| Request | Status | Coverage |
|---|---|---|
| Repository discovery | SPECIFIED | repo.detect/tree/dependencies/status |
| Semantic symbol search | SPECIFIED; implementation PARTIAL | RepoIntel + symbols.* | persistent implementation remains open |
| Definitions/references/callers/implementations | SPECIFIED | LanguageServiceBroker + index/LSP |
| File outline / symbol-range reads | SPECIFIED | `symbols.outline/read` |
| BM25/fuzzy camelCase/snake_case search | SPECIFIED | §30 index design |
| Persistent index with watcher | SPECIFIED; CODE_PARTIAL | current `indexd` lexical only | persistence/watcher acceptance |
| Drift-safe symbol IDs | SPECIFIED | signature/generation identity |
| Cross-file reference confidence | SPECIFIED | source/confidence metadata |
| Large repo scaling >50K files | TEST TARGET | §32/RepoIntel performance fixtures | benchmark implementation |
| LSP coexistence with Pyright/rust-analyzer/tsserver/etc. | SPECIFIED | `LanguageServiceBroker` | runtime adapter tests |
| Do not duplicate/kill editor-owned LSP | SPECIFIED | §14/§30 |
| Built-in indexing helps even without MCP/browser plugins | SPECIFIED | native capability baseline |
| Optional MCP/LSP/browser extensions augment rather than replace built-ins | SPECIFIED | adapter/catalog model |

## 35.7 Coding, terminal, Git, browser and system execution

| Request | Status | Coverage |
|---|---|---|
| Precise multi-file editing | SPECIFIED | version/fence-aware patch/file tools |
| Test/lint/build/format execution | SPECIFIED | typed wrappers + terminal fallback |
| Integrated terminal with logs/cancel/exit code | SPECIFIED | terminal.* |
| Large terminal search without prompt flood | SPECIFIED | output_range + artifact search |
| Debugging/tracing | SPECIFIED | trace.inspect, diagnostics, process/runtime evidence |
| Browser functional testing | SPECIFIED | browser/DOM tool family |
| Built-in DOM/browser even without MCP | SPECIFIED | normalized native backend |
| Browser MCPs/extensions can coexist | SPECIFIED | capability adapter/generation + Guard |
| Git diff/branches/commits/uncommitted work | SPECIFIED | git.* + human-work protection |
| Review/PR preparation | SPECIFIED | review skill/jobs; remote effect approval |
| Refactor/migration with compatibility protection | SPECIFIED | impact + tests + migration skill |
| Deployment support | SPECIFIED | staged approval/evidence; no automatic prod write |
| Autocomplete/inline editing | SPECIFIED target | editor integration §31 | implementation not accepted |
| Multi-language IDE integration | SPECIFIED | editor + LSP broker |
| System execution beyond code | SPECIFIED | System Operator + ExecutionHost |

## 35.8 Long-horizon reliability and self-healing

| Request | Status | Coverage |
|---|---|---|
| Durable goal survives compaction | SPECIFIED | Goal/Run/Task outside model context |
| Hierarchical task/DAG planning | SPECIFIED | Task dependencies/acceptance |
| Structured Plan→Build handoff | SPECIFIED | `PlanHandoffV1` |
| Checkpoint/resume | SPECIFIED | recovery lineage and evidence |
| False-completion prevention | SPECIFIED | completion requires acceptance evidence |
| Explicit completed/blocked/failed/paused | SPECIFIED | lifecycle FSM |
| Loop/no-progress detection | SPECIFIED | repeated action/error/progress signatures |
| Error classification | SPECIFIED | code/tool/permission/provider/environment classes |
| Safe retries / idempotency | SPECIFIED | effect receipts/reconciliation |
| Explicit stopping conditions | SPECIFIED | acceptance verified or exact blocker |
| Background execution after UI disconnect | SPECIFIED | server/worker ownership; host must remain available |
| L1 deterministic code healer | SPECIFIED | diagnostics/preflight/rollback/strategy change |
| L2 provider circuit breaker | SPECIFIED with constraint | health/latency/error telemetry; fallback only if user explicitly configured |
| L3 empirical error/repair analytics | V1 advisory | reviewed repair memory + analytics |
| L4 self-modifying policy/config | POST-V1 experimental | cannot self-authorize |
| EWMA/provider health | SPECIFIED | analytics/health observation |
| Error-signature repetition | SPECIFIED | no-progress signatures |
| Last-known-green rollback without clobbering user work | SPECIFIED | checkpoint lineage/targeted revert |

## 35.9 Parallel engineering, worktree/resource pools and cleanup

| Request | Status | Coverage |
|---|---|---|
| Dependency-aware scheduling | SPECIFIED | scheduler DAG |
| Workspace/worktree isolation | SPECIFIED | WorkspaceProvider/pool |
| Active/inactive reusable worktree pool | SPECIFIED | lease/pool/hygiene |
| Do not create endless worktrees | SPECIFIED | bounded pool + admission estimate |
| Cleanup after agent completion | SPECIFIED | hygiene job/lease ownership |
| Preserve dirty human work | SPECIFIED | quarantine/conflict, never blind delete/reset |
| Runtime isolation: ports/processes/services | SPECIFIED | resource leases/ExecutionHost |
| Test DB/data isolation | SPECIFIED | per-worker resources |
| Agent communication without human clipboard | SPECIFIED | typed inter-agent messages |
| Merge coordination / integrated verification | SPECIFIED | merge stage + final integrated-revision verifier |
| Resource leak detection | SPECIFIED | release/test metrics |

## 35.10 User control, commands, extensions and customization

| Request | Status | Coverage |
|---|---|---|
| Ask mode | SPECIFIED | permission profile |
| Safe Auto | SPECIFIED | only classified safe effects; enforced boundary |
| YOLO-in-sandbox | SPECIFIED | only when sandbox is real; no fake YOLO |
| Avoid repetitive permission prompts | SPECIFIED | saved scoped grants/permission profiles |
| Custom skills with resources/scripts/assets | SPECIFIED | SkillManifestV2 |
| Inline/fork/deterministic skill execution | SPECIFIED | execution mode |
| Skill tool allowlists/model/agent overrides | SPECIFIED | manifest/profile ceilings |
| Custom hooks on file/tool/agent/session events | SPECIFIED | HookBindingV2 |
| Shell/skill/deterministic hook handlers | SPECIFIED | ordinary effect path |
| MCP HTTP/stdio/auth/headers/tool allow-deny | SPECIFIED | MCP profile/SecretBroker/Guard |
| Custom slash commands | SPECIFIED | ActionDescriptor/command binding |
| Custom keybindings | SPECIFIED | UI action binding |
| Security rules | SPECIFIED | managed/user/project precedence |
| Quick actions | SPECIFIED | pinned typed actions/prompts |
| Agent-specific tools/commands/config preserved | SPECIFIED | profile/adapters |

## 35.11 UX, Control Center, artifacts and editor

| Request | Status | Coverage |
|---|---|---|
| Unified Create / Develop / Delegate / Operate | SPECIFIED | one engine, progressive UX |
| Clear objective/current action/changes/risks/outcome | SPECIFIED | Work/Inspect/Mission Control views |
| Live thread statuses Running/Needs Input/Idle/Errored | SPECIFIED | Mission Control projection |
| Pause/resume/stop any thread | SPECIFIED | owner commands |
| Live model-call/tool feed | SPECIFIED with privacy controls | redacted event/trace view |
| Chat artifacts like generated files/diagrams | SPECIFIED | UiArtifact/ArtifactService |
| Mermaid inline rendering | SPECIFIED | isolated renderer, source fallback |
| File list/file viewer/Git/terminal/browser/context panels | SPECIFIED | dockable workspace |
| Drag/split/pin and per-project layout persistence | SPECIFIED | §31 |
| Search terminal output | SPECIFIED | terminal/artifact search |
| Thread history remains recoverable after cleanup | SPECIFIED | canonical history + history-search |
| CodeMirror 6 preferred over Monaco for weight | SPECIFIED TARGET | measured ADR may override |
| Lazy language packs / Lezer / compartments | SPECIFIED TARGET | §31 |
| Hover/go-to-definition/diagnostics | SPECIFIED | LSP/editor bridge |
| Split + inline diff/merge | SPECIFIED | editor UX |
| Markdown/rich artifact editor (Lexical-like capability) | SPECIFIED capability, library not hard dependency | implementation ADR remains |
| Slash/mention/table/annotation in rich docs | SPECIFIED UX target | implementation ADR remains |

## 35.12 Smoothness, speed, bundle/runtime weight

| Request | Status | Coverage |
|---|---|---|
| Smooth token streaming without jitter | SPECIFIED | coalesced stream buffers + stable anchors |
| User scroll-up is never fought by auto-scroll | SPECIFIED | stick-to-bottom state machine |
| Resize above viewport does not jump view | SPECIFIED | anchor compensation/measurement |
| Predict/measure message heights | SPECIFIED approach | implementation may choose equivalent measured virtualizer |
| Multi-thread streaming | SPECIFIED | multiplexed event subscriptions |
| Reconnect from last durable event/cursor | SPECIFIED | replay/resnapshot; ephemeral deltas may coalesce |
| Lazy history pages | SPECIFIED | bounded pagination |
| Startup HTTP/request collapse/bootstrap | SPECIFIED performance target | exact endpoint design measured before commitment |
| Lightweight editor/runtime | SPECIFIED principle | bundle/startup/RSS budgets §31 |
| Background indexing/analytics yield to foreground | SPECIFIED | performance scheduler |
| Measure action/context/IPC/Guard/dispatch/index/render stages | SPECIFIED | RuntimeObservationV1 |

## 35.13 Analytics, cost and storage

| Request | Status | Coverage |
|---|---|---|
| Per run/model/action/subagent tokens/cost | SPECIFIED | AnalyticsService/usage ledger |
| Latency/TTFT/TPS/RPM/cache/tool success | SPECIFIED | measured/estimated/unknown provenance |
| Filter by workspace/project/provider/model/time | SPECIFIED | analytics UI |
| Compare agents/models by budget/result | SPECIFIED | comparison view; no automatic routing implication |
| Export analytics | SPECIFIED | derived export artifact |
| Cache hit visibility | SPECIFIED when provider exposes trustworthy counters | unknown otherwise |
| Bounded local event/storage retention | SPECIFIED | retention/rotation/maintenance |
| WAL/event database growth controls | SPECIFIED | retention/checkpoint/compaction policies |
| Deep analytics in V1 | SPECIFIED | V1 |
| Autonomous self-improvement | POST-V1 | experiment/canary/review only |

## 35.14 Automations, hooks, remote/team

| Request | Status | Coverage |
|---|---|---|
| Cron/scheduled automations | SPECIFIED | AutomationService |
| Visual cron builder | SPECIFIED UI target |
| Event-triggered runs | SPECIFIED | automation trigger adapters |
| Run logs | SPECIFIED | durable invocation/run refs |
| Workspace/project scoping | SPECIFIED |
| Quick-action buttons | SPECIFIED |
| Remote/mobile monitoring | P2/V1-optional surface | backend/API permits; release scope may defer mobile UI |
| Team collaboration | P2 | share task context/evidence/audit through scoped backend |

## 35.15 Problems explicitly called out by the user

| Failure mode | Horizon response |
|---|---|
| Says done while replacements remain | acceptance criteria re-scan + verifier |
| Loses goal after compaction | Goal/Task state outside model context |
| Re-reads same files after compaction | checkpoint/evidence refs + history/index retrieval + no-progress detection |
| Overwrites newer/human changes | expected revision/hash/fence + targeted revert |
| Makes architecturally poor local change | architecture/impact analysis + conventions + reviewer |
| Ignores plan/instructions | execution-boundary policy + structured PlanHandoff |
| Breaks unrelated behavior | impact radius + relevant regression tests + integrated verification |
| Cost spike | per-call/task ledger + budgets |
| Context grows with no progress | context budgets + loop detection |
| Slows as history grows | typed retrieval, pagination, compaction, cache-aware assembly |
| Stops prematurely | explicit Goal/Task/Run FSM and pending-work check |
| Burns context locating code | symbol/index-first bounded reads |
| Repeats same failed action | signature/no-progress strategy switch |
| Local storage grows indefinitely | retention/rotation/maintenance |

## 35.16 Newly added requirements from the follow-up source review

### OpenHands-derived
- Keep UI/control center separate from execution backend ownership.
- Treat local/direct, sandbox/container, remote/VM and hosted backends as explicit trust/execution
  backends behind the same work surface.
- Persistence/pause/resume and condenser/memory are runtime services, not reasons to duplicate
  conversation authority.
- Automation scheduling/dispatch is separate from the agent executor; an automation creates an
  ordinary authorized run.

### mini-SWE-agent-derived
- Maintain a minimal baseline harness with a tiny agent loop and independent action execution.
- Support a guarded bash-only harness for weak/local models rather than requiring rich function
  calling.
- Prefer independent subprocess actions for the minimal harness so one bad shell state is less
  likely to poison later actions; stateful terminal sessions remain a separate explicit tool.
- Completion must be typed/verified in HorizonCode; do **not** adopt a magic output sentinel as
  authoritative completion.

### Open Interpreter-derived
- Model/provider choice and harness shaping are separate first-class selections.
- Harness shaping may change system prompt, tool projection, message codec and response parser
  while still executing through Horizon's native Guard/ExecutionHost.
- Compatibility harnesses are versioned assets; they never authorize a provider/model change.
- Provider/model catalog membership should be data-driven where possible, not a hand-maintained
  hard-coded list.

## 35.17 Deliberate non-goals / rejected shortcuts

- **No automatic model router by default.** Recommendations are allowed; silent model/provider
  replacement is not.
- **No `.opencode` dependency for Horizon-owned built-ins.** `.opencode` remains an OpenCode
  compatibility/customization input until post-V1 identity migration.
- **No model-said-done success state.** Verification decides outcome.
- **No prompt-only security.** Guard/Effect/ExecutionHost enforce effects.
- **No unlimited subagents/worktrees/retries.** Admission and budgets are bounded.
- **No autonomous V1 policy/self-modification.** Analytics and reviewed advisory learning only.

## 35.18 Remaining implementation gaps after this audit

These are the important gaps; they are not missing product ideas:

1. complete ManagedControl/SessionLink + ToolBatchControl → Guard → EffectIntent → lease →
   ExecutionHost → reconciliation mediation;
2. wire Horizon-owned embedded built-in skills, beginning with `builtin.horizon-docs`, and remove
   the need for the development `.opencode` shim;
3. implement/test `HarnessRegistry` and native-rich/minimal/bash-only projections against actual
   local/hosted models without changing provider selection;
4. finish persistent RepoIntel symbol/reference index + watcher + LanguageServiceBroker;
5. implement ContextLedger/context UI/history retrieval and small-model prompt compiler;
6. implement browser/DOM normalized backend and coexistence adapters;
7. implement Mission Control, artifact/Mermaid rendering, editor/diff and performance system;
8. implement analytics/usage accuracy, retention and automations;
9. implement full real-work §32 fixtures and run them across chosen small/local and hosted models;
10. complete platform/security/recovery acceptance, especially native Windows and crash/unknown
    effect reconciliation.

**Conclusion:** every major capability family from the user's request now has an explicit owner
or an explicit defer/rejection. The remaining work is implementation and empirical validation,
not an unowned feature bucket. Any future user-requested capability must be added here with its
owner and release gate so it cannot disappear into prose.

## 35.19 Service-contract convergence follow-up

The coverage categories in this matrix continue to mean SPECIFIED, not IMPLEMENTED. §36 explicitly gates HLD/LLD/schema convergence. §37 now owns BrowserBackendV1, LanguageServiceBrokerV1, DelegationMailboxV1, AutomationServiceV2, UiEventMuxV2, ArtifactRenderServiceV2 and CacheObservationAdapterV1 logical contract details. Eight new JSON wire-shape schemas and one governed canonical alias registry seed were added under contracts-v2. Runtime generation/bindings, TS/Rust cross-language contract tests, effect mediation, local-model inference, browser UI and platform performance tests remain mandatory implementation work. Do not upgrade status on the strength of this audit pass alone.

## 2026-10-11 OMP audit research status

[§38](38-OMP-SOURCE-COMPETITIVE-AUDIT.md) supplies an evidence-backed candidate list from the pinned can1357/oh-my-pi repository, including all named tools and all pi-natives modules. All proposed imports remain SPECIFIED/RESEARCH, not CODE_PRESENT or VERIFIED. New Browser/Computer/WebSearch/DAP/Additive native contracts require design authorization, licensing checks and test-first implementation after the current P1.2/P1.3 gates. Do not confuse OMP's native addon model with Horizon's Rust Guard/ExecutionHost.

## 2026-10-11 OMP terminal/settings/provider follow-up

User requested source-deep comparison of OMP's slash-command icon UI, all settings buttons/tabs, model/provider browser, OAuth/API/local connection options and goal input. Source inventory/result: [§39](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md) and JSON inventory of 85 builtin slash command definitions and 409 UI-settings declarations; pinned provider/source roster includes 20 pure web engines and 6 grounded web engines plus 92 provider-rule KDL filenames. [§40](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md) is an implementation-oriented non-normative design candidate with exact action/state/UI classes and regression tests. Product code, UI integration and accepted semantics remain NOT IMPLEMENTED.

## 2026-10-11 OMP streaming visual artifacts follow-up

User requested inspection of OMP streaming and visual terminal artifacts. [§41](41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md) covers provider delta stream through TUI, partial SVG repaired/rasterized at 200ms baseline, auto-graphs, Mermaid ASCII, Kitty/SIXEL/Tern native image paths, separate artifact:// and blob:sha256 persistence, and public omp stream screen patches; includes proposed Horizon contracts, faults/tests and implementation sequencing. Research/specification only; Horizon renderer work and adoption remain NOT IMPLEMENTED.

## 35.20 Requested final source-provenance and implementer handoff (2026-10-11)

Coverage: exact immutable URLs of first party+12 external upstream reference repos in [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md)/external-source-register.json; selected OMP code paths and logic SRC-003..016; accepted discoverable UI/role/provider/settings/goal target A-V2-22; accepted visual streaming/chart/terminal artifact target A-V2-23; mandatory provenance/source-license A-V2-24; dependency ordered executable plan [converged implementation plan](../docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md) and LLD [source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md). A repo hash scan and docs/schema validator are source/document evidence only. Agent must not claim these feature implementations are complete: P1.2-B/P1.3 and real tests are open.
