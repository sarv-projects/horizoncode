# 28 — Competitive gap audit: Codex, OpenCode, Cline, Claude Code, Grok Build

**Audit date:** 2026-10-11  
**Status:** normative gap-resolution input for HorizonCode V1. It does not copy competitor code and it does not make unverified competitor behavior a Horizon guarantee.

## 28.1 Source confidence and method

This review compares public architecture, documentation, source and tests against the complete HorizonCode architecture corpus. Evidence priority is:

1. official repository source/tests from the vendor or project;
2. official product documentation;
3. public changelogs and release notes;
4. user-provided product descriptions used as design prompts, not implementation facts;
5. third-party reconstructed/decompiled repositories used only as low-confidence pattern research.

Primary comparison sources reviewed:

- OpenAI Codex: `openai/codex`, including app-server/thread/goal, multi-agent, context, permission and sandbox source/tests; official Codex Goals documentation.
- OpenCode: `anomalyco/opencode` and official OpenCode V2 docs for agents, permissions, tools, providers, skills and MCP.
- Cline: `cline/cline`, including SDK architecture, context/compaction, checkpoints, subagents/teams, UI/runtime tests and E2E task harness.
- Anthropic Claude Code: official `anthropics/claude-code` repository/documentation where public. The user-provided `chauncygu/collection-claude-code-source-code` is **not authoritative**; it is used only to identify patterns worth independently designing.
- xAI Grok Build: `xai-org/grok-build`, especially Rust shell/pager, skills, hooks, subagents, custom model endpoints, sessions/worktrees, sandbox, scrollback rendering and Mermaid support.
- Follow-up sources requested by the user: OpenHands current public architecture/docs (Agent Canvas, Agent Server/SDK, workspace/sandbox backends, automations/persistence), SWE-agent `mini-swe-agent` v2 (minimal model/environment/agent loop, independent subprocess actions, bash-only/local environments), and current Rust Open Interpreter (local/cheap models, harness emulation/shaping, sandbox/approval/ACP surfaces). These were added after the initial five-source comparison and are explicitly reconciled later in this chapter and §35.

The audit asks, for each feature: **does HorizonCode have an owner, schema, lifecycle, security boundary, UI surface, performance contract, failure behavior and acceptance test?** A mention is not coverage.

## 28.2 High-level comparison

| Capability | Codex | OpenCode | Cline | Claude Code public/research | Grok Build | HorizonCode audit result |
|---|---|---|---|---|---|---|
| Durable objective across turns | Strong Goal/thread model | Session/task oriented | Task/session persistence | Tasks/subagents/memory patterns | Sessions/goals/workflows | Designed, but old Rust/OpenCode transcript ownership conflict must be removed |
| Main + specialist/subagents | Multi-agent handlers | Primary/subagent profiles | Subagents + persistent teams | Custom agents/subagents | Rich agent/persona/subagent definitions | **Partial**: core profile exists; richer profile resolution/context/path/input policies needed |
| Fine-grained permissions | Sandbox/approval profiles | Ordered action/resource rules | Approval/runtime policies | Permission modes/hooks | Tool/path sandbox profiles | Strong design; complete interception still implementation-gated |
| Skills | Skills/tool dependencies | Skills + permission integration | Rules/skills/plugins evolving | Skills/plugins | Rich SKILL.md with resources, model/effort and allowed-tools | **Partial**: lazy skill model exists; manifest/resource execution contract needs expansion |
| Hooks | Lifecycle/tool hooks | Extensions/events | Hook runtime | Rich lifecycle hooks | Rich blocking/advisory hooks | Strong base; event vocabulary and trust/runtime contracts need consolidation |
| MCP/extensions | MCP + plugins | MCP/ACP/plugins | MCP + connectors | MCP/plugins | MCP/plugins | Strong base; explicit server profile/auth/tool-filter schema needed |
| Context engineering | Compaction/goals/context telemetry | Session compaction | Actual-token compaction | Snip/compact/memory patterns | Compact subagent prompts/sessions | **Gap**: typed live context ledger and user-visible trim/prune/clear semantics need first-class spec |
| Symbol code intelligence | Search/LSP/tooling | LSP/search | IDE/search | Search/read tooling | LSP/index helpers | **Gap**: persistent symbol index contract not sufficiently explicit |
| Local/small model support | Configurable providers | Many providers/local | Many providers | Primarily Claude | OpenAI-compatible/local endpoints | **Critical gap**: local model support exists conceptually but tiny-context prompt/tool exposure contract is insufficient |
| Browser/DOM | Tool/environment dependent | Web tools | Browser automation | Browser/tool integrations | Browser/computer tools | Partial: visual flow exists; built-in DOM/browser tool contract needs explicit catalog and fallback |
| Checkpoint/rewind | Thread/history mechanisms | Session controls | Shadow-Git checkpoints | Session history | Rewind/worktree sessions | Strong design, but user-safe dirty-file behavior remains release-gated |
| Worktree isolation | Multiple environments/worktrees | Worktree support | Worktree tasks | Worktree patterns | Fast worktrees + GC | Strong design; pool/resource isolation tests required |
| Artifacts/diagrams | Structured outputs/tools | Files/UI | Attachments/artifacts | Artifacts in surfaces | Inline media + Mermaid | **Gap**: artifact renderer/file contract and safe Mermaid rendering need explicit UI/runtime design |
| Multi-thread control center | Thread/agents views | Session UI | Teams/session UI | Agent/task views | Dashboard/subagent/session UI | **Gap**: Mission Control exists conceptually; live call/tool feed and privacy/redaction need explicit contract |
| Analytics | Analytics crate/usage | Usage/cost | Detailed usage/telemetry | Usage/cost surfaces | Telemetry | **Gap**: exact event-backed token/cost/cache/latency dashboard contract required |
| Automations | Background/goal workflows | Commands/plugins | Schedules/teams SDK | Hooks/tasks | Scheduled workflows/hooks | Partial: workflow notion exists; user-visible scheduler/cron/run-log model missing |
| Streaming/UI performance | Rust TUI, app-server | OpenTUI/Solid | Desktop/CLI optimization | Terminal UI | Rust pager with render cache/benchmarks | **Gap**: measurable streaming/virtualization performance contract needed |
| Self-improvement | No autonomous policy mutation requirement | No requirement | Analytics, recovery | Memory/adaptation patterns | Memory/learning facilities | **Decision**: V1 analytics only; self-improvement experiments post-V1 and never self-authorize |
| Task-based E2E evaluation | Extensive integration suites | source/unit/UI tests | cline-bench E2E real tasks | integration/task patterns | PTY/render/session suites | **Gap**: one model-independent Horizon task catalog required |

## 28.3 Patterns to adopt

### A. Durable objective is state, not prompt text

Codex Goals are persistent objectives with lifecycle operations and completion conditions; Codex source also treats goal edits separately from compaction snapshots. HorizonCode must keep Goal/Spec/acceptance state outside model-visible context and re-inject a bounded reference/snapshot on every relevant attempt.

**Adopt:** durable objective + criteria + decision ledger + completion predicate.  
**Do not adopt:** a large repeated natural-language goal block in every request.

### B. Agent profiles should be powerful, but agent count should stay small

OpenCode, Claude Code patterns and Grok Build all show value in reusable specialist profiles. HorizonCode should support rich profiles but distinguish:

- **context-bearing agents:** Build, Plan, Explorer, Architect/Oracle, Librarian, Looker, Reviewer, Test-Debugger, System Operator, Browser QA, History Search, Verifier under a permit;
- **micro-jobs/services:** title generation, commit message, query rewriting, tool-result trim, context prune proposal, conversation summary, artifact cleanup.

A micro-job does not need a durable child Thread, worktree or full system prompt. This avoids token, latency and persistence overhead.

### C. Lazy context/tool disclosure is required for small models

Few-billion-parameter and small-context models cannot receive the same prompt/tool catalog as a 100K+ hosted model. The runtime must expose a compact control prompt, selected task facts and a small tool surface first, then let the model discover additional tools/skills/context through typed lookup.

Grok Build's compact subagent prompt audience and skill progressive disclosure support this direction. Cline's context-overflow recovery and actual-token-based compaction show why character estimates alone are unsafe.

### D. Real code intelligence should beat blind grep

Use a persistent, revision-aware symbol index for definitions/references/outlines and a text index for fallback. LSP remains authoritative for language-server semantics when available. The model reads only bounded symbol ranges whenever possible.

### E. Hooks are policy-adjacent, never policy authority

Hooks may block, annotate, request approval, add bounded context or schedule telemetry. A hook cannot widen Guard permissions. Project hooks execute only after workspace trust and with declared capability bounds.

### F. Worktree safety includes runtime and data isolation

A worktree is not sufficient isolation. Every parallel execution must also lease ports, services, process groups, temporary directories, test databases and external test resources. Cleanup is an explicit state transition; dirty/user-owned state is quarantined, not deleted.

### G. UI performance is an architecture concern

Grok Build has explicit render caches, scrollback state and render benchmarks; Cline changelogs contain multiple fixes for UI/session performance; OpenCode tests cover terminal scroll behavior. HorizonCode therefore needs budgets and regression tests for stream coalescing, scroll anchoring, history pagination, thread switching and memory.

## 28.4 Patterns to reject or constrain

1. **Automatic model routing as a default.** The user selects provider/model/harness. Any fallback is an explicit pre-authorized route, never a surprise paid call.
2. **One huge universal system prompt.** It harms local/small models, cache efficiency, speed and accuracy.
3. **Every helper as a subagent.** Use deterministic services or tiny jobs for maintenance tasks.
4. **Unbounded child-agent fanout.** Scheduler uses dependency/resource analysis and expected-value admission.
5. **Blind global worktree cleanup.** Only leased clean owned resources are reclaimable.
6. **Persist every stream delta.** Persist durable semantic events; keep high-frequency render deltas ephemeral/coalesced.
7. **Treat grep as semantic code intelligence.** Text search remains fallback, not the only repository primitive.
8. **Hooks as arbitrary trusted shell.** Hook code is an effect with provenance, timeout, permission and sandbox controls.
9. **Context cleanup that mutates history.** `trim/prune/compact/clear` change the provider context view; the canonical conversation/history remains recoverable.
10. **Self-modifying policy in V1.** Analytics may generate post-V1 experimental candidates, but V1 does not autonomously rewrite security, routing or architecture.

## 28.5 Critical architecture gaps found

### GAP-01 — conversation/control ownership wording is still inconsistent

Several historical sections say Rust ThreadService owns canonical message/input/Turn transcript state and OpenCode Session is only a projection. The current OpenCode-first decision is the opposite for conversation content.

**Resolution:** OpenCode remains the canonical conversation/message/provider-continuation owner in V1. Rust owns durable **managed-control records**: Goal/Spec/Run/Task/Attempt, ToolBatch admission/control metadata, EffectIntent, approval, leases, evidence, recovery and immutable correlation references. A Rust control record may reference an OpenCode Session/Message/Turn but does not duplicate message bodies as a second canonical transcript.

Any historical text claiming production migration to a Rust canonical transcript is superseded. OwnerLog remains useful for Rust-owned control aggregates.

### GAP-02 — custom agent contract lacks several requested dimensions

Add:
- provider/model/harness + effort/reasoning;
- allowed/denied tools, skills, MCP servers/tools and child-agent IDs;
- path read/write allow/deny;
- input/approval posture;
- parent-context isolation mode;
- memory scope;
- provider-specific profile variants;
- per-agent limits and concurrency;
- explicit capability requirement/fallback behavior.

See chapter 29.

### GAP-03 — context is not sufficiently user-visible or typed

Add a `ContextLedger` projection with typed entries, exact/estimated tokens, source/trust, inclusion reason, cache status and protected state. Define `trim`, `prune`, `compact`, `clear` as different operations. See chapter 30.

### GAP-04 — persistent symbol index needs a normative service contract

RepoIntel exists, but user-facing symbol tools, drift-safe IDs, persistent BM25/name index, watcher behavior, confidence tiers and fallback rules are not explicit enough. See chapter 30.

### GAP-05 — tiny/local model mode needs its own runtime profile

Ollama, LM Studio, LiteLLM and arbitrary OpenAI-compatible endpoints must be first-class. Tool/schema exposure, prompt budget, retry/repair and context retrieval must scale down to small context windows without silently selecting another model. See chapter 30.

### GAP-06 — streaming and editor performance lacks measurable acceptance

Define stream coalescing, stable scroll anchoring, lazy history, parked thread UI state, render-height cache invalidation, editor lazy loading, startup/memory budgets and performance telemetry. See chapter 31.

### GAP-07 — artifacts and Mermaid are not first-class enough

Define artifact types, lifecycle, safe renderers, generated-file download/open actions and safe Mermaid rendering with bounded size/time and no active script execution. See chapter 31.

### GAP-08 — analytics/mission control need exact telemetry semantics

Deep analytics is V1: tokens, cost, cache, latency, TPS, tool success, retries, subagent overhead, context pressure, indexing and resource usage. Every number must be measured/estimated/unknown with provenance. Self-improvement remains post-V1 experimental. See chapters 31 and 32.

### GAP-09 — automation scheduling needs a durable owner

Hooks and workflows exist, but schedules need durable schedule/run identities, missed-run policy, concurrency, approvals and logs. See chapter 31.

### GAP-10 — no single exhaustive built-in capability catalog

Create one normative catalog of built-in agents, tools, skills, maintenance jobs and optional integrations so UI, prompt compiler and tests cannot drift. See chapter 33.

### GAP-11 — task-based agent evaluation is fragmented

Existing tests are excellent low-level contracts, but V1 needs a model-independent end-to-end catalog that measures work completion, safety, tokens and time across hosted/local/small models. See chapter 32.

## 28.6 Existing strengths to preserve

The current architecture is already stronger than many coding-agent designs in several areas:

- separate Attempt versus WorkerExecution versus Evidence;
- exact UNKNOWN/reconciliation semantics instead of blind retries;
- explicit effect preparation and capability leases;
- independent verification bound to final integrated revision;
- worktree/resource fencing and quarantine;
- user-pinned model policy;
- versioned plugin/composition generations;
- explicit recovery and disk-pressure behavior;
- distinction between configured, observed and enforced capabilities;
- provenance-aware memory and no prompt-based security authority.

The competitive pass must add missing product/runtime capabilities **without weakening these invariants**.

## 28.7 Second-pass source findings and narrow gaps

The first pass closed the large feature families. A deeper source pass found additional
operational details that must be explicit before V1 can claim parity or superiority.

### GAP-12 — language-service coexistence, not duplicate language servers

HorizonCode must cooperate with an already-running/editor-owned Pyright, rust-analyzer,
TypeScript server, clangd, jdtls or equivalent when a safe attach/reuse contract exists.
It must not spawn redundant servers merely because RepoIntel wants definitions.

**Resolution:** RepoIntel owns normalized queries/results, not every LSP process.
A LanguageServiceBroker discovers compatible project/editor/supervised servers, pins one
configuration generation, reuses a healthy instance where possible, and falls back to
parser/lexical indexing when no trustworthy LSP is available. The result always records
provider (`lsp|parser|index|lexical`), generation and confidence. Optional LSP/MCP adapters
augment this family; they do not create a second permission model.

### GAP-13 — plan/read-only modes need execution-time mutation enforcement

Hiding edit tools is insufficient because shell commands, package managers, scripts,
formatters, notebooks or MCP aliases can mutate state.

**Resolution:** read-only/Plan profiles carry an execution policy that rejects filesystem,
VCS, package, service, database and external mutations at Guard/ExecutionHost. Diagnostic
commands are allowed only when their resolved effect class is read-only. A model claim that a
command is "safe" is not authorization.

### GAP-14 — weak/local model structured calls must fail closed

Small models and compatibility gateways can emit truncated or malformed tool JSON. Repairing an
unterminated string by inventing bytes can execute the wrong command.

**Resolution:** framing/JSON/schema validation is strict. Only deterministic normalization that
does not invent semantic values is allowed. A bounded model-assisted repair may produce a
*new proposal* requiring complete revalidation; the original malformed proposal is never
executed.

### GAP-15 — local-model cold start is different from network failure

A local Ollama/LM Studio model can need substantial time to load weights even though the
endpoint is healthy.

**Resolution:** provider timing distinguishes connect/health latency, queue latency,
model-load/response-start latency, first-token latency and steady-state generation. Cold-load
timeouts are separately configurable/cancelable and do not trip a provider outage breaker merely
because a large local model loads slowly.

### GAP-16 — checkpoint/rewind after later user commits needs a hard safety guard

A checkpoint can be valid while later human commits or branch changes make destructive reset
unsafe.

**Resolution:** restore operates against exact repository identity/revision lineage. If commits,
untracked ownership, branch head or user edits diverged, default restore becomes preview +
targeted patch/revert or explicit conflict; never blind reset.

### GAP-17 — Plan→Build handoff should be a typed artifact

A plan written only as chat/markdown forces the Build agent to reinterpret requirements and can
lose dependencies/acceptance criteria.

**Resolution:** Plan emits a versioned PlanHandoff artifact containing objective/spec refs, task
DAG, scope, assumptions, decisions, acceptance criteria, relevant symbols/files, hazards and
unresolved questions. Build accepts a pinned artifact revision and reports deviations explicitly.

### GAP-18 — terminal output must be searchable without re-injecting logs

Large build/test output should remain artifact-backed and queryable by range/search. Models
should not reread megabytes to locate one error.

**Resolution:** add bounded terminal/log search over immutable or append-only output artifacts,
with line/range references and source process identity.

### GAP-19 — runtime latency needs budgets below the UI layer

Smooth rendering cannot compensate for slow prompt compilation, IPC, tool admission, index
queries or event fanout.

**Resolution:** §31 adds critical-path budgets and stage telemetry for provider request
preparation, Context compilation, capability lookup, private IPC, Guard admission,
ExecutionHost dispatch, index queries, event projection/fanout and cleanup. Optimize measured
hot paths; do not assume Rust alone makes the product fast.

### Source-backed performance patterns worth independently adopting

The Grok Build source demonstrates several useful implementation patterns rather than a generic
"Rust is fast" conclusion: cached scrollback layout/height data, windowed rendering benchmarks,
incremental Markdown with a frozen stable prefix, lazy Mermaid rendering isolated in a
short-lived child process with timeout/kill/reap, lazy code-index startup, dedicated bounded
subagent worker coordination and per-stage startup telemetry. HorizonCode adopts the
*behavioral contracts and benchmarks*, not those implementations verbatim.

Codex reinforces persistent goal state, bounded agent depth, centralized sandbox/network
approval, retained-context/tool-output accounting and goal blocking after exhausted fatal
turns. Cline adds practical regression lessons around checkpoint restore after later commits,
disjoint cache-token accounting, local-model cold starts, and rejection of truncated tool-call
payloads. OpenCode remains the reuse base for providers, Sessions, tools and application
surfaces. Claude Code reconstruction material remains low-confidence pattern research only.

### Follow-up source reconciliation: OpenHands, mini-SWE-agent, Open Interpreter

The first comparison pass was not equally deep for all repositories requested by the user.
A follow-up pass reviewed current public OpenHands, mini-SWE-agent and Open Interpreter source/docs
and adds these requirements:

**OpenHands**
- separate the visual/control-center client from the backend that owns agent execution,
  persistence, workspace and sandbox backends;
- treat local/direct, container/sandbox, VM/remote and hosted execution as explicit backend/trust
  profiles behind one work surface rather than separate products;
- keep automation scheduling/dispatch separate from the executor so scheduled work creates an
  ordinary authorized Run;
- condenser/persistent-memory services may improve long-horizon context but must not become a
  second conversation authority.

**mini-SWE-agent**
- preserve a deliberately minimal reference harness: model + environment + bounded loop;
- support an independent-subprocess, guarded `bash-only` mode for models with poor function
  calling or very small context;
- keep completion typed and verifier-backed; a text sentinel from the model is not authoritative;
- use the minimal harness as a regression baseline so richer Horizon machinery can justify its
  latency/token overhead.

**Open Interpreter**
- model/provider selection and **harness shaping are separate architectural choices**;
- harness shaping may change system prompt, tool schema/projection, message lowering and response
  parsing while still executing through Horizon's native Guard/ExecutionHost;
- compatibility harnesses are explicit/versioned and never silently switch provider/model;
- provider/model discovery should be data/capability driven where possible rather than maintained
  as a fragile hard-coded list.

These findings are normalized into `HarnessProfileV1`, §20 `HarnessRegistry`, §33 harness
families, §32 LM/EX fixtures and §35's complete user-request matrix. They do not change the
OpenCode-first ownership decision or current P1.2/P1.3 implementation priority.

## 28.8 Required follow-through

Chapters 29–33 turn the major and second-pass gaps above into normative contracts. Chapter 34
records the document-by-document audit, and §35 records explicit user-request/source coverage. Existing chapters 01–27 remain topic owners, but
conflicts are resolved by the 2026-10-11 audit amendments and governance decisions.

Do not start a full HorizonCode/OpenCode identity rename during V1; the complete identity
migration remains deferred mandatory P10 after V1 acceptance.

## 2026-10-11 Oh My Pi pin and source comparison

The separately pinned competitor audit is [§38](38-OMP-SOURCE-COMPETITIVE-AUDIT.md), with source/document inventory and Rust native-module inventories linked in the architecture README. Important candidate gaps: native hashline edit/stale recovery, fast Rust walker and AST, browser tab supervision, desktop screenshot+AX freshness, search-provider chaining without hidden paid routes, shared LSP multiplexing, an explicit DAP broker, and native terminal Mermaid. No source changes or architecture adoption are implied. Source-backed safety exceptions (computer Eval full-host access, browser origin interception not sandbox, LSP mutating edits, partial multi-file writes) must not be imported unchanged.
