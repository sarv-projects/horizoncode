# OPENCODE UPSTREAM REUSE — canonical v2 integration

> **Current repository binding (2026-10-10):** Local repository pin b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322, rather than the upstream moving dev branch, is the implementable baseline. Repository-specific parity evidence and licenses must be checked again on any update.

## Imported v2 architectural basis

# 09 — Upstream source audit, incorporation boundaries and licensing

**Inspection date:** 2026-10-10. **Design rule:** OpenCode is the PRIMARY implementation substrate, not merely an optional adapter. Read this before any Rust port. URLs reference public repositories; confirm exact commit before copying code. File-level observations were made against the upstream `dev`/`main` branches on this date, not exhaustive validation of all behaviors.

## 9.1 Upstream reuse matrix

| Source | Verified implementation/design observation | Decision | Exact integration seam | Do NOT transplant | Tests before adoption |
|---|---|---|---|---|---|
| `anomalyco/opencode` | `packages/opencode/src/provider/provider.ts` (~2,095 lines), SDK-based/provider-specific mapping; separate `packages/llm`, newer `packages/core` and `packages/protocol` plus `packages/opencode` legacy | **BASE / retain TS** | versioned fork/subtree of the supported provider, model catalog, auth, token accounting, streaming, AI-SDK shims | rebuilding every provider SDK in Rust; dependence on incidental globals | streaming and tool call contract across selected hosted, free-tier and local providers; usage errors and auth |
| OpenCode sessions | `packages/opencode/src/session/session.ts`, `prompt.ts`, `compaction.ts`, `packages/core/src/session/runner/llm.ts`, `specs/v2/session.md` | **BASE / retain** | SessionGateway maps `SessionID` ↔ logical conversation/execution ID; OpenCode retains turn/prompt/message state, Rust owns goal/task/attempt/evidence | duplicate independent transcript as mutable authority; importing legacy giant loop into Rust | durable inbox, compaction, model switch, replay, user steer, disconnect |
| OpenCode tool registry/agent profiles | `packages/opencode/src/tool/registry.ts`, `tool/task.ts`, `agent/`, `command/`, `skill/`, `mcp/`, `acp/` | **BASE, selected** | `ToolCatalogAdapter` and `AgentProfileAdapter`; typed cross-process `ToolIntent` | granting JS SDK direct host shell access outside broker; assuming old subagent sessions are durable work tasks | task-to-child mapping, cancellation, policy, plugin/version compatibility |
| OpenCode core v2 | `packages/core/src/session/runner/llm.ts` notes unfinished durable ownership, bounded retries, duplicate-call detection, scoped runtime context | **UPSTREAM WATCH / selectively migrate** | `opencode-bridge` hides V1/V2 details; one canonical translation of session events | coding against unstable internal APIs in UI / Rust | V1→V2 contract golden traces; no lost `ToolCall`/reasoning/usage |
| `OpenHands/software-agent-sdk` | documented stateless agent loop, immutable conversation state, tools/workspace/security/condenser boundaries | **BORROW PATTERN / optional adapter** | task/evidence events; optional Python worker through AgentRuntime SPI | embedding the complete OpenHands application into OpenCode core | long-run pause/resume, condensed context, action event ordering |
| `OpenHands/OpenHands` | current Canvas frontend is deliberately separate from Agent Server; GUI handles events, not execution | **BORROW UI separation** | UI projections and backend registry; no second full frontend | copying its entire stateful React provider or adopting alternate authoritative DB | event stream replay and browser/terminal presentation |
| `openai/codex` | persisted thread goal state, `codex-rs/ext/goal/src/tool.rs` get/create/update handlers, `spec.rs`; `/goal` statuses incl. active, paused, blocked, usage_limited, budget_limited, complete | **BORROW / own implementation** | GoalController in Rust; tool-facing `get_goal`, `propose_goal_complete`, `report_goal_blocked` | treating an agent-set complete status as verified product outcome | goal survives crash and compaction; external intervention; insufficient evidence never passes |
| `SWE-agent/mini-swe-agent` | `src/minisweagent/agents/default.py`: small model-environment loop, step/cost/time limits, explicit format errors; interactive `/u`, `/c`, `/y` modes | **BORROW CONCEPT / optional minimal harness** | `HarnessProfile = minimal` and harness-compat tests | permanently restricting the product to a one-command shell agent | runs with no native tool calling, progress limits, low-memory endpoints |
| `openinterpreter/openinterpreter` | October 2026 main is a Codex fork, not merely legacy Python interpreter; README advertises low-cost model harness emulation and /harness variants, `docs/open-interpreter-delta.md` describes provider transport | **BORROW STRATEGIES / optional worker** | user-selected `HarnessProfile` with model-specific codecs, translation and strict tool validation | importing its full Codex fork as a second competing session/runtime authority | Ollama/LM Studio/OpenAI-compatible interoperability, malformed tool outputs |
| `anthropics/claude-code` | public repo contains docs/plugins, official docs describe CLAUDE.md/AGENTS.md, auto memory, skills, hooks and permissions | **BORROW DOCUMENTED UX PATTERNS ONLY** | skills, rules, hooks, memory lifecycle, command palette; support via external ACP/CLI adapter where permitted | reproducing proprietary leaked bundles or claiming Claude has the supplied four-layer architecture | rule precedence, capability scoping, hook denies and tool trust |

## 9.2 Source-level inspections and pinned path list

- OpenCode: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts ; https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts ; https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts ; https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts ; https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts ; https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/llm.ts ; https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md .
- Codex: https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/tool.rs ; https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/spec.rs ; https://github.com/openai/codex/blob/main/codex-rs/state/src/model/thread_goal.rs ; https://github.com/openai/codex/blob/main/codex-rs/core/src/context/user_goal.rs ; https://github.com/openai/codex/blob/main/codex-rs/tui/src/slash_command.rs .
- mini-SWE: https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py .
- Open Interpreter: https://github.com/openinterpreter/openinterpreter/blob/main/README.md ; https://github.com/openinterpreter/openinterpreter/blob/main/docs/open-interpreter-delta.md .
- OpenHands: https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/agent/agent.py ; https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/conversation.py ; https://github.com/OpenHands/OpenHands/blob/main/docs/architecture.md ; https://docs.openhands.dev/sdk/ .
- Claude public documentation: https://code.claude.com/docs/en/memory ; https://code.claude.com/docs/en/skills ; https://code.claude.com/docs/en/interactive-mode ; https://code.claude.com/docs/en/hooks ; https://code.claude.com/docs/en/permissions .

## 9.3 Key OpenCode discovery: two concurrent generations

As inspected, `packages/opencode` remains a substantial shipping surface while `packages/core/src/session/runner/llm.ts` already isolates an Effect-native runner. The latter explicitly identifies TODOs for durable cross-node ownership, status transitions, bounded retries, repeated tool calls and scoped context. `specs/v2/session.md` describes admitted prompts and execution separately; an inbox row is admitted before it is promoted to model-visible history, and session resume is keyed by ID. These details make it incorrect to label core V2 either absent or fully complete.

**Implementation:** begin with an OpenCode-derived Node/Bun compatibility host exporting stable `SessionGateway` and `ModelGateway` RPC contracts. Preserve upstream internals behind that seam. The Rust supervisor adds goal/task/effect authority without changing OpenCode's message database semantics. If OpenCode's new core stabilizes, swap the internal adapter behind the same contract and verify event golden fixtures. Do not make a simultaneous V2 port and new Rust rewrite a prerequisite to shipping.

**Storage ownership:** OpenCode's session store is authoritative for message chronology/tool-call parts. Rust DB is authoritative for Run/Task/Attempt/Effect/Evidence/Approval and project/workspace leases. Write `SessionLink { run_id, task_id?, attempt_id?, opencode_session_id, adapter_version }` transactionally; session events ingested with stable `(session_id, sequence,event_id)` idempotency keys. Avoid distributed two-phase commits across the two stores. A bridge reconciliation scan is required after crash; monotonic acknowledged cursors and pending intents are recorded.

## 9.4 Providers and local models: do not throw away a mature subsystem

Retain upstream provider adapters, model capability metadata, streaming, response adaptation, authentication methods and token accounting, but isolate them behind `ModelGateway`. Implement a single user-controlled `ModelSelection` with pinned `{provider,model,variant,harness,auth_profile}`. No hidden price-driven or quality-driven automatic model selection. A connection failure returns an error and a choice prompt, not a silent switch.

`HarnessProfile` is independent of provider and model: `native_tools`, `xml_tool_adapter`, `json_strict`, `single_shell`, `minimal_shell`, `custom`; choose explicitly in UI, with tested recommended defaults but no model-switch. Capability detection tests whether tools/JSON/context/vision are ACTUALLY supported. Free-tier and local inference supported; features degrade clearly rather than making unearned claims. Do not assume local models reliably obey structured calls.

Prevent local model waste using smaller prompts, LSP discovery, bounded output, deterministic checks, prompt template selection and adaptive task granularity **without silently upgrading to a paid model**. Missing or unpriced token usage is `unknown`, never `$0`; local inference has wall-time/energy advisory rather than invented dollar billing.

## 9.5 Licensing, upstream update and provenance

At inspection OpenCode's root `LICENSE` is MIT; Codex, the inspected Open Interpreter fork and mini-SWE carry Apache-2.0/ MIT licensing respectively. **License is not the same as universal reusability:** check each package, generated client, asset, model provider SDK, vendored dependency, trademark, and applicable notice. Preserve source copyright and required notices for any copied code. Do not imply proprietary Claude Code leaked bundles are open source; use only legitimately published code and docs. A GitHub mirror claiming to contain private source is not a validated or endorsed integration reference.

Create `UPSTREAM_LOCK.json` with base commit, files imported, license, local patch ledger, license-notice path and golden test status. Use a small downstream fork with patch queue; upstream changes enter a review branch, not automatic production merges. Build CI against current pinned base and a periodic candidate upstream branch. Changelog must distinguish adopted behavior from experimental features.

## 9.6 Reuse decision criteria

A dependency is accepted only when (a) it removes meaningful implementation burden, (b) can run behind a stable interface, (c) has clear license and update story, (d) fits user-selected models and existing auth, (e) honors safety contracts, and (f) passes contract/fault-injection tests. If upstream does not expose a clean interface, isolate with a process adapter rather than directly importing private implementation everywhere.


---

## 19.7 Complete pinned comparison source register (2026-10-11)

OpenCode remains the adopted source substrate, not a disposable competitor; exact source pin and changed-tree checking are required. New [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md) and [machine readable source routes](external-source-register.json) cover OpenCode, OMP, DeepSeek Harness, Codex, Cline, Grok Build, Claude Code public reference, OpenHands, OpenHands SDK, mini-SWE-agent and Open Interpreter, plus first-party Horizon. Extraction requires source-specific license/attribution/dependency checks and test-backed owner mapping as in [source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md). Do NOT infer all competitor code is open/reusable or installed.
