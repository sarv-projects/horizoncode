# 34 — Document-by-document line audit ledger

**Audit date:** 2026-10-11  
**Purpose:** record which HorizonCode documents were read, what each document owns, where conflicts/gaps were found, and how the 2026-10-11 competitive audit resolves them.

## 34.1 Audit scope and method

The active HorizonCode documentation corpus was enumerated from the working repository before this chapter was created.

Primary audit set at the first snapshot:

- **49 Markdown files**
- **17,922 physical lines**
- all `arch_V1/*.md` files then present;
- root operational documents used by coding agents and maintainers;
- HorizonCode `docs/` architecture/spec/plan material;
- the preserved v2 architecture input.

**That number is historical, not the current corpus size.** The repository changed during the
same audit: §§28–35 were added/expanded and current implementation evidence evolved. A
second-pass recount after the final amendments measured **36 `arch_V1` Markdown files / 14,647
physical lines** and **5 `docs/` Markdown files / 3,278 physical lines**. The broader
`.opencode/.superpowers` evidence tree changes independently and is therefore classified rather
than folded into a misleading fixed grand total. The second-pass scope uses document classes
instead of pretending one early count remains authoritative:

1. **Normative architecture:** every current `arch_V1/*.md` file, read as the product/system
   contract.
2. **Tracked operational control:** `AGENTS.md`, `HANDOFF.md`, `IMPLEMENTER_PROMPT.md` and root
   project/security/context/statistics/contributor docs that affect active work.
3. **Tracked specs/plans:** current `docs/**/*.md`, classified as normative, plan, provenance or
   superseded before use.
4. **Repo-local extension instructions:** `.opencode/skills/*/SKILL.md` and
   `.opencode/agent/*.md`; these are OpenCode compatibility/customization inputs, not HorizonCode product authority. Product-owned built-in assets live under Horizon-owned package paths such as `packages/core/src/horizon/`.
5. **Implementation-local subsystem docs:** for example `indexd/src/README.md`, which is
   implementation evidence and must truthfully constrain readiness claims.
6. **Transient implementation evidence:** `.superpowers/sdd/**/*.md` task briefs/progress/reports.
   These are consistency-scanned for stale ownership/status claims but never promoted above the
   tracked architecture/handoff. Logs/diffs are evidence, not product requirements.
7. **Upstream/vendor/reference repos:** pinned `opencode/` and comparison checkouts are research
   substrate. Their README/docs are read when relevant to parity or implementation, but are not
   HorizonCode-owned specification and are not rewritten during this audit.

Translated marketing README copies are one product-content family rather than independent
architecture owners; P10 handles final product-owned identity migration.

The audit uses complementary passes:

1. **Physical line pass:** every file in the primary set is opened/read in full, with headings, references, architecture terms, status assertions and conflict markers inventoried. This prevents an old paragraph hidden deep in a long chapter from being ignored.
2. **Semantic subsystem pass:** every line is evaluated in the context of its owner subsystem — authority, lifecycle, schema, IPC, effects/security, agent profiles, context, repository intelligence, UI, performance, analytics, local models, recovery, release and testing.

This ledger does **not** claim that every sentence has been formally proven correct by implementation. The audit distinguishes:
`NORMATIVE`, `HISTORICAL/SUPERSEDED`, `PROVENANCE`, `IMPLEMENTATION EVIDENCE`, and `PLAN`.

Pinned/upstream OpenCode documentation is comparison substrate, not HorizonCode product authority. Package-local README/AGENTS documents are compatibility-scanned where they guide active implementation; they do not override `arch_V1`.

## 34.2 Authority order after this audit

When text conflicts:

1. security/system instructions and legally required policy;
2. adopted decisions in `17-GOVERNANCE-DECISIONS.md`;
3. 2026-10-11 audit resolutions in §§28–34;
4. current topic-owning chapters 01–27 after their explicit reconciliation amendments;
5. current tracked `HANDOFF.md` for implementation position only;
6. historical plans/specs and preserved architecture inputs;
7. upstream/package guidance.

A current implementation plan may refine sequencing but cannot silently reverse a normative architecture decision.

## 34.3 Cross-cutting conflict resolution

### CR-01 — canonical conversation ownership

**Resolved V1 decision:** OpenCode Session/Input/Message/Part/provider continuation remains canonical conversation state.

Rust OwnerLog owns HorizonCode control-plane state:
- Goal / SpecVersion / Run / Task / Attempt;
- worker/delegation control state;
- ToolBatch admission metadata and immutable correlation references;
- EffectIntent / approvals / capability leases;
- workspace/resource leases;
- recovery/reconciliation state;
- Evidence / verification and acceptance;
- automation/control-plane facts where introduced.

Rust may retain OpenCode IDs, sequence/cursor references, digests, redacted receipts and immutable artifacts needed to prove/control Horizon state. It does **not** become a second canonical message transcript in V1.

Historical documents describing a full Rust ThreadService transcript cutover are retained for audit/provenance only and are superseded.

### CR-02 — model routing

User-selected provider/model/harness remains pinned. No automatic cost/quality router and no surprise paid fallback. An explicitly user-configured fallback list is a separately versioned choice and applies only where its policy says it may.

### CR-03 — agent system

One profile registry supports main agents, specialists, custom agents and external adapters. Rich profile configuration is adopted (§29). Lightweight maintenance tasks are jobs, not automatically child agents.

### CR-04 — context

Context is a deterministic, user-visible compilation of canonical references. `trim`, `prune`, `compact` and `clear` have distinct semantics (§30). Context cleanup never destroys canonical conversation history merely to fit a model window.

### CR-05 — repository intelligence

Persistent lexical/symbol indexing is a rebuildable projection. Workspace/Git remains source truth. LSP enrichment is on demand; embeddings are optional and never required merely to open a repository.

### CR-06 — local/small models

Ollama, LM Studio, LiteLLM and generic OpenAI-compatible endpoints are first-class. Small-context models receive smaller control prompts and progressively exposed tools/context; lack of capability never triggers silent cloud/model substitution.

### CR-07 — performance

Streaming/UI/indexing performance has explicit budgets and regression tests (§31). High-frequency deltas are not automatically durable events. Responsiveness is a design property, not late polish.

### CR-08 — learning/self-improvement

V1 includes deep analytics, reviewed repair-memory retrieval and user-visible suggestions. Autonomous self-modifying policy/profile/routing remains post-V1 experimental and cannot self-authorize. Mandatory P10 identity migration remains a separate post-V1 release milestone.

## 34.4 Architecture file audit

| File | Classification | Primary ownership | Audit result / required action |
|---|---|---|---|
| `01-SYSTEM.md` | NORMATIVE | process topology, owners | Good coverage. Historical Rust transcript language must be read under CR-01. Add explicit new Context/RepoIntel/Analytics/UI performance services as projections/services, not new truth owners. |
| `02-DOMAIN.md` | NORMATIVE | identity/aggregates | Strong aggregate model. Clarify conversational identity remains OpenCode-owned; Rust Thread-like records are control/correlation only. Adopt richer AgentProfileV2 refs from §29. |
| `03-FLOWS.md` | NORMATIVE | end-to-end flows | Strong recovery/effect flows. Add tiny-local-model flow, symbol-first edit flow, context pressure flow, agent specialist flow, automation run, artifact/Mermaid render and Mission Control recovery flow. |
| `04-STATE-EVENTS.md` | NORMATIVE | event/replay/outbox | Strong durability/replay. Ensure UI token deltas remain ephemeral unless semantically durable. Add analytics/context/index/automation event ownership without duplicating source facts. |
| `05-SECURITY.md` | NORMATIVE | threat model | Strong. Extend threat model to skill/profile variants, context/index leakage, browser DOM injection, analytics/content telemetry and local endpoint trust. |
| `06-CAPABILITIES.md` | NORMATIVE | capability availability | Strong configured/observed/enforced distinction. Add built-in catalog status and local endpoint/model capability probes. |
| `07-UX-COMMANDS.md` | NORMATIVE | actions/commands | Expand with distinct context commands, symbol/artifact/automation/analytics quick actions; keep typed ActionDescriptor single path. |
| `08-RECONCILIATION.md` | NORMATIVE/HISTORICAL | old→new decisions | Must record CR-01 explicitly and label previous Rust-canonical transcript proposal superseded. |
| `09-SOURCE-MAP.md` | NORMATIVE/IMPLEMENTATION MAP | code mapping | Good path mapping. Add target seams for context ledger, RepoIntel symbol index, agent profile v2, analytics and UI performance. |
| `10-DELIVERY.md` | NORMATIVE | implementation/release sequence | Add V1 gates for local models/context/indexing, agents/extensions, UI/performance/artifacts/analytics/automation. Keep P10 identity migration deferred mandatory. |
| `11-LIFECYCLE.md` | NORMATIVE | state machines | Very strong. Remove implication that Rust owns conversation transcript; add context cleanup/index/automation states by reference, not duplicate huge lifecycle trees. |
| `12-DOMAIN-SCHEMAS.md` | NORMATIVE | canonical wire/domain shapes | Strongest schema chapter. Add compatibility section pointing to V2 extension schemas in §§29–31 and conversation ownership correction. |
| `13-COMPOSITION-IPC.md` | NORMATIVE | composition/private IPC | Strong bounded/private IPC. Preserve Rust control ownership; avoid creating transcript-mirroring RPC. Add context/index/analytics stream boundaries. |
| `14-EFFECTS-EXECUTION-SECURITY.md` | NORMATIVE | Guard/effects/execution | Strong. Extend resource mediation to browser/DOM/automation/hook scripts/local endpoints and path rules. |
| `15-RUNTIME-EXECUTION.md` | NORMATIVE | execution/context/agents | Strong agent hooks/budgets. Integrate ContextLedger, small-model prompt compiler and profile V2. Replace full Rust transcript ownership language. |
| `16-UX-SETTINGS-ECOSYSTEM.md` | NORMATIVE | UI/settings/extensions | Already rich. Add context bar, Mission Control call feed, CodeMirror preference, Mermaid/artifact viewer, analytics/automations and local endpoints; correct Session DB ownership row. |
| `17-GOVERNANCE-DECISIONS.md` | NORMATIVE DECISIONS | ADR authority | Add 2026-10-11 decisions from CR-01..08. This chapter resolves any old contradictory decision table. |
| `18-OPERATIONS-RELEASE.md` | NORMATIVE | persistence/release | Strong. Replace release requirement that Rust becomes sole transcript store; add perf/local-model/index/analytics retention and task-catalog gates. |
| `19-OPENCODE-UPSTREAM-REUSE.md` | NORMATIVE INTEGRATION | reuse boundaries | Strong OpenCode-first intent. Make it the explicit source for conversation/provider reuse decision. |
| `20-OPENCODE-INTEGRATION-LLD.md` | NORMATIVE LLD | classes/functions/adapters | Strong. Extend exact seams for ProfileV2/ContextLedger/RepoIntel/Analytics/Artifact UI; remove any adapter description that implies transcript duplication. |
| `21-HEALING-PERMISSIONS-WORKTREE-POOL.md` | NORMATIVE | recovery/pool | Strong. Explicitly freeze V1 at analytics + reviewed advisory repair knowledge; self-tuning L4 is post-V1 experimental. |
| `22-UNIVERSAL-UI-COMMANDS-MEMORY.md` | NORMATIVE | universal UX/tools/memory/local | Good basis. Expand local endpoints, context operations, symbols/index, artifacts, analytics, automation and built-in Horizon Docs skill. |
| `23-ADOPTION-GATES-TESTS.md` | NORMATIVE | phased test gates | Strong but sparse compared to full task suite. Make §32 mandatory end-to-end catalog and add performance/context/small-model gates. |
| `24-LOCAL-CODE-AUDIT-AND-MIGRATION.md` | IMPLEMENTATION EVIDENCE | current source map | Keep factual. Append new target seams only when code is inspected. Do not call §§28–33 implemented. |
| `25-DATA-AND-CONTROL-PLANE-CROSSWALK.md` | NORMATIVE/PROTOTYPE | data/API crosswalk | Clarify Rust control-plane vs OpenCode conversation. Add references to context/index/analytics projections; prototypes remain design-only. |
| `26-UX-ACCEPTANCE-AND-RELEASE.md` | NORMATIVE | user journeys | Add small/local-model, Mission Control, context cleanup, artifacts/Mermaid, automation and perf journeys. |
| `27-IMPLEMENTATION-READINESS-AUDIT.md` | AUDIT | code/design truth | Update with §§28–34 gaps. Keep implementation status separate from designed status. |
| `28-COMPETITIVE-GAP-AUDIT.md` | NORMATIVE AUDIT INPUT | comparison/gaps | New. Records evidence confidence, competitor patterns, gaps and decisions. |
| `29-AGENTS-SKILLS-HOOKS-MCP.md` | NORMATIVE | profiles/extensions | New. Rich custom/specialist agent, skill, hook, MCP, command and subagent contract. |
| `30-CONTEXT-INDEXING-LOCAL-MODELS.md` | NORMATIVE | context/repo intel/local models | New. Makes small/local models and symbol-first retrieval first-class. |
| `31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md` | NORMATIVE | UI perf/artifacts/analytics/automation | New. Defines smooth streaming, editor strategy, Mermaid, Mission Control, metrics and scheduling. |
| `32-TASK-BASED-AGENT-TEST-CATALOG.md` | NORMATIVE TEST CATALOG | real work evaluation | New. Model-independent end-to-end task catalog plus performance suites. |
| `33-BUILTIN-CAPABILITIES-CATALOG.md` | NORMATIVE CATALOG | agents/tools/skills/jobs | New. Single catalog for UI, prompt compiler and tests. |
| `34-DOCUMENT-LINE-AUDIT-LEDGER.md` | AUDIT LEDGER | this audit | New. Tracks coverage/conflicts/actions. |
| `35-USER-REQUEST-COVERAGE-MATRIX.md` | NORMATIVE AUDIT/COVERAGE | user request/source coverage | Added in follow-up. Maps every major requested capability/source to owner, status, defer/rejection and remaining implementation gate. |
| `GLOSSARY.md` | NORMATIVE REFERENCE | terminology | Updated with ContextLedger/profile/local-model/artifact/automation terms plus `LanguageServiceBroker`, `PlanHandoffV1`, `ContextEpochMarker`, cold-loading model, terminal artifact and runtime stage budget. |
| `README.md` | NORMATIVE INDEX | reading order | Updated through §§28–34, machine-readable schema links, authority order and the 2026-10-11 `horizon-docs` implementation handoff. |

## 34.5 Root operational documents

| File | Classification | Audit result |
|---|---|---|
| `AGENTS.md` | CODING-AGENT OPERATING CONTRACT | Updated: §§28–34 precedence is explicit; `horizon-docs` is the bounded per-slice retrieval path; stale 115-test baseline was corrected to the newer `CURRENT_RUN` verification record. Keep product specifics in architecture. |
| `HANDOFF.md` | CURRENT IMPLEMENTATION CHECKPOINT | Updated with second-pass competitive contracts, `system-operator`/`browser-qa`, `horizon-docs` and truthful lexical-only `indexd` status without changing the current P1.2/P1.3 dependency order. |
| `IMPLEMENTER_PROMPT.md` | LAUNCH PROMPT | Updated to consume §§28–34/`horizon-docs`, enforce OpenCode/Rust ownership, and start from the current ManagedControl/SessionLink + ToolBatchControl/effect boundary rather than the pre-audit P1.2 wording. |
| `CURRENT_RUN.md` | IMPLEMENTATION EVIDENCE LOG | Valuable but very long. Latest audit completion/validation/limitations are appended; treat as evidence/history, not normative architecture. New sessions use HANDOFF + bounded retrieval. |
| `CONTEXT.md` | RETAINED OPENCODE IMPLEMENTATION REFERENCE | Read line-by-line and bannered. Useful Session/SystemContext/client-runtime design, but non-authoritative for Horizon ownership/ContextLedger; §17/§30/§34 win and beta/open questions require source/tests. |
| `STATS.md` | UPSTREAM METRICS SNAPSHOT | Read line-by-line and bannered. Historical OpenCode GitHub/npm download counts only; not Horizon adoption, analytics, benchmark or release evidence. |
| `SECURITY.md` | UPSTREAM SECURITY/REPORTING POLICY | Read line-by-line and bannered. Upstream `No Sandbox` threat model/reporting guidance is retained but cannot override Horizon §05/§14/§21 Guard/ExecutionHost/sandbox requirements. |
| `CONTRIBUTING.md` | UPSTREAM CONTRIBUTION GUIDE | Read line-by-line and bannered. Useful base build/style/PR guidance only; Horizon workflow/precedence/test/cleanup rules come from AGENTS/HANDOFF/IMPLEMENTER_PROMPT/`arch_V1`. |
| root `README.md` | PRODUCT/DEV ENTRY | Updated to the 2026-10-11 §§01–34 architecture, adopted OpenCode/Rust ownership, evidence-gated repository status, current HANDOFF/CURRENT_RUN distinction and §34 implementer entry point; stale P2-branch/merge claims removed. |

## 34.6 `docs/` audit

| File | Classification | Audit result |
|---|---|---|
| `docs/architecture-input/universal-software-agent-v2-source.md` | PROVENANCE / NON-NORMATIVE | Preserved input. Do not implement directly when it conflicts with later reconciled chapters. |
| `docs/superpowers/specs/2026-10-09-horizon-p2-kernel-foundation-design.md` | HISTORICAL DESIGN | Read and banner verified. Old Rust-canonical transcript body is explicitly superseded; OwnerLog/durability/artifact/IPC work remains usable only for Rust-owned Horizon control aggregates. |
| `docs/superpowers/plans/2026-10-09-horizon-p2-foundation.md` | HISTORICAL PLAN / EVIDENCE | Read and banner verified. Sequencing/durability evidence may be reused, but OpenCode conversation ownership and current HANDOFF supersede canonical-Thread assertions. |
| `docs/superpowers/plans/2026-10-10-horizon-p2-thread-cutover.md` | HISTORICAL PLAN | Read and superseded-plan banner verified. Do not execute as written; only still-valid control-plane/IPC/effect/recovery tasks may be extracted under §17/§34/HANDOFF. |
| `docs/superpowers/plans/2026-10-10-session-observer-supervisor.md` | IMPLEMENTATION PLAN | Read and compatible with current ownership: read-only Session observer, OpenCode canonical Session/provider state, Rust metadata projection. Current HANDOFF determines residual lifecycle gates. |

## 34.7 Package/vendor documentation rule

Active package-local `README.md`, `AGENTS.md`, architecture notes and generated docs describe implementation conventions for that package. During implementation, the coding agent must read the nearest package instructions before editing.

However:
- package docs cannot reverse the authority decisions above;
- pinned `opencode/` documentation is upstream provenance/reference;
- translated/readme/marketing copies are not separate architecture owners;
- post-V1 P10 handles product-owned OpenCode identity strings; required upstream attribution stays.

A package compatibility scan should flag:
- direct raw host effects bypassing Guard;
- alternate session/message authority;
- generated-file edit instructions;
- conflicting package-manager/runtime versions;
- unbounded output/storage;
- network/auth behavior inconsistent with local/offline mode.

## 34.8 Coverage conclusion

After §§28–33, the architecture now explicitly covers the gaps raised in this audit:

- rich custom/specialist agents and typed subagent messaging;
- per-agent provider/model/harness/effort/tool/skill/MCP/path/context/input controls;
- progressive skills/hooks/custom commands/keybindings/quick actions;
- built-in Horizon documentation retrieval;
- typed context ledger and distinct trim/prune/compact/clear;
- persistent symbol-level repository intelligence with text/LSP fallback;
- very small-context and local model operation;
- Ollama/LM Studio/LiteLLM/OpenAI-compatible endpoints;
- built-in browser/DOM plus optional MCP adapters;
- first-class artifacts and safe Mermaid;
- dockable editor/terminal/Git/test/preview UI;
- smooth multi-thread streaming/virtualization;
- Mission Control and live operational feed;
- deep V1 token/cost/cache/latency/tool/resource analytics;
- automations and hooks;
- model-independent real-work test catalog;
- self-improvement deferred to a post-V1 experimental lane;
- mandatory P10 identity migration still post-V1.

The deeper source pass then found and resolved narrower contract gaps:
- language-service coexistence with editor/project Pyright, rust-analyzer, tsserver and peers;
- execution-time read-only/Plan enforcement through generic shell/LSP/MCP aliases;
- strict malformed/truncated structured-call handling for weak/local models;
- local endpoint cold-load timing separated from health/connect failure;
- checkpoint/rewind safety after later commits/dirty/untracked human work;
- structured `PlanHandoffV1` rather than a markdown-only Plan→Build transfer;
- bounded terminal/artifact text search;
- critical-path runtime latency budgets below the UI layer;
- managed Goal/Task blocking after fatal/exhausted retries;
- incremental frozen-prefix rendering and crash-isolated expensive renderers.

### Repo-local instruction findings

- `.opencode/skills/effect/SKILL.md` is relevant and consistent with current Effect v4/effect-smol
  development: verify exact Effect APIs/source, keep service/layer composition explicit and use
  live/scoped tests for real resources.
- `packages/core/src/horizon/skills/horizon-docs/SKILL.md` is now the canonical Horizon-owned
  product asset for bounded architecture/status retrieval. Core source inspection shows OpenCode
  already supports embedded SkillV2 sources, which is the preferred V1 registration seam.
- `.opencode/skills/horizon-docs/SKILL.md` is now only a development compatibility shim for the
  current OpenCode harness. Governed product behavior must not depend on this project-local path.
  Embedded registration, stable/sealed skill-ID anti-shadowing, UI discovery and runtime
  acceptance remain unverified.
- `.opencode/skills/rtl-aware-development/SKILL.md` supplies necessary UI implementation/test
  constraints for bidirectionality and remains compatible with §31.
- `.opencode/agent/triage.md` and `duplicate-pr.md` are inherited hidden repository-maintenance
  agent definitions, not HorizonCode's target built-in specialist catalog. Do not infer product
  model defaults from them; post-V1 P10 handles product-owned identity where these remain shipped.
- `indexd/src/README.md` explicitly reports the implementation as a bounded in-memory lexical
  library with PARTIAL status, no persistent watcher/parser/LSP/SCIP/vector/supervisor. This is
  authoritative implementation evidence against prematurely marking §30 RepoIntel VERIFIED.
- `.superpowers/sdd` briefs/reports/progress are implementation evidence/handoffs. Any old claim
  that contradicts current §17/§34/HANDOFF is historical evidence, not a command to reintroduce a
  superseded owner or cutover.

Remaining risk is therefore mostly **implementation and empirical validation**, not absence of a
named subsystem. The local lexical-only RepoIntel slice, universal ToolIntent mediation,
supervisor/platform acceptance, rich profile runtime, ContextLedger, local/small-model harness,
UI performance system, artifact renderers, analytics, automations and full real-work fixtures
remain implementation gates. Any newly discovered gap must be added to this ledger and mapped to
an owner/schema/test before coding it.

## 34.9 2026-10-11 normative-contract convergence addendum

Read §36 plan and §37 service LLD before implementing any covered subsystem. Six older operative topology/ownership/flow sections were replaced in §§01–04,13,20, and their exact displaced text is preserved as historical evidence in docs/architecture-input/2026-10-11-superseded-contract-excerpts.md. The corrected owner rule is OpenCode Session/Input/Message/Part/provider continuation vs Rust managed Goal/Run/Task and ToolBatchControl/Effect/Guard/evidence. Old Rust Thread schemas elsewhere remain historical and cannot be directly implemented. §20 now labels existing vs proposed paths instead of directing developers to create a Tauri/greenfield tree. §37 closes conceptual services and schemas, but TS/Rust implementation verification remains open. The 2026-10-11 physical corpus recount supersedes the previous archived numbers.

## 34.10 Repository-wide mechanical coverage and external source correction (2026-10-11)

Full per-file SHA256 and line counts are now recorded in [repo-file-line-audit-manifest.json](repo-file-line-audit-manifest.json) and reviewed in [§44](44-FINAL-REPO-AUDIT-LEDGER.md). All Git-visible local file contents were read/hash-scanned mechanically and Markdown relative links checked; that cannot substitute for semantic reading of 1.5M code lines. All nine preexisting primary external reference owners plus newly user-requested OMP/competitor pins are in [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md). Older P2 Rust canonical Thread checklists are explicitly historical; the [reconciled 2026-10-11 plan](../docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md) is the operative successor. Do not misrepresent a syntactic pass as a complete production-system proof.
