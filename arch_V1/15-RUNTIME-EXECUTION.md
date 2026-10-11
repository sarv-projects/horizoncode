# 15. Runtime execution

Status: normative current-only runtime behavior.

## 15.1 Direct versus managed

Direct Session:
- ordinary pair coding;
- OpenCode Session/provider loop remains canonical;
- no mandatory Goal/Run/Task;
- still uses capability scopes, complete ToolBatch barrier and Guard for effects.

Managed Run:
- explicit objective/spec/criteria/budgets;
- Rust control state;
- scheduling/delegation/recovery/verification;
- references one or more OpenCode Sessions without owning their transcript.

## 15.2 Provider turn

1. Build context from canonical OpenCode history plus selected ContextLedger refs.
2. Pin provider/model/harness/tool-registry generation and permission/cost policy for the turn.
3. Start provider request through packages/llm.
4. Stream text/thinking into canonical OpenCode message parts and derived UI.
5. Collect local tool calls until the provider response/step is complete.
6. Validate every call against request-pinned schemas.
7. If any call is malformed or response incomplete/failed, dispatch no local effect.
8. Read-only calls may execute through scoped fast paths after validation.
9. Effectful batch crosses Rust Guard/ExecutionHost.
10. Persist conversational tool results in OpenCode.

## 15.3 Context compile

ContextService selects, it does not replace canonical history.

Priority:
- system/product safety;
- accepted Goal/Spec for managed work;
- project instructions;
- current task/files/symbols;
- recent relevant Session parts;
- explicit user-pinned refs;
- retrieved history/memory/index refs.

Each derived entry carries source/revision/provenance. Token counts are measured/estimated/unknown.

trim/prune/compact/clear retain their distinct semantics from 30.

## 15.4 Repository intelligence

Use cheapest precise source first:
1. known exact file/range;
2. RepoIntel symbol/definition/reference index;
3. healthy LSP source;
4. parser/AST;
5. lexical/text search;
6. bounded broader file reads.

Embeddings are optional enhancement, never required to open a repo.

Index generations are invalidated by workspace/source revision and overlay changes.

## 15.5 Tool discovery

Models receive a bounded starter toolset based on AgentProfile/Harness and current task.

tools.search exposes additional canonical capabilities by ID. Discovery never changes permission/effect class.

A tiny model may see compressed meta-tools, but they map to the same underlying capability IDs and Guard.

## 15.6 Managed scheduling

Scheduler considers:
- dependency readiness;
- workspace/worktree/resource leases;
- capability availability;
- user-selected provider/model/harness policy;
- concurrency/budget;
- integration collision risk.

It does not automatically choose a cheaper/different model.

Parallelism is used only when net benefit exceeds coordination/integration cost.

## 15.7 Subagents

Child gets:
- bounded objective and acceptance;
- explicit context refs;
- allowed capability subset;
- path/workspace scope;
- model/harness route according to profile/inheritance rules;
- time/token/tool budget.

Child returns SubagentDelivery/evidence. Parent or verifier decides integration/completion.

## 15.8 Language service and DAP

Language queries prefer an already compatible editor service, then Horizon-supervised service, then index/parser fallback.

Query results report source/generation.

Rename/code action starts a normal effect.

DebugAdapterBroker owns debugger session lifecycle. Read stack/variables are scoped queries; launch/attach/breakpoint/continue/step/evaluate are classified according to mutation/risk and Guarded. Evaluate cannot become arbitrary unrestricted host execution.

## 15.9 Persistent REPL

REPL is a supervised worker, not an ambient shell privilege.

Supported V1 target:
- Python and JavaScript where runtime is available;
- persistent variables/imports within one bounded session;
- explicit reset/stop;
- bounded stdout/stderr and artifactization;
- CPU/memory/time/network/filesystem limits;
- tool callbacks only through canonical ActionDescriptor/Guard;
- source/workspace generation awareness.

Use terminal.start/input for generic terminals; use repl.* only when structured persistence/callback semantics are required.

## 15.10 Browser

Read path: tabs, DOM/ARIA snapshot, screenshot, console/network diagnostics.

Mutation path: navigate, click, type, select, upload, downloads/state changes, authenticated network actions.

Every action pins browser profile/tab owner and observation generation. Stale refs trigger re-observation, not blind retry.

Attached user browser profiles require explicit connection/consent policy.

## 15.11 Desktop/computer control

Desktop backend exposes:
- displays/windows/process targets;
- screenshots;
- accessibility tree/query;
- pointer/keyboard/scroll;
- app/window focus;
- clipboard only when explicitly allowed.

Mutation uses Rust effect mediation and exact observation generation. Coordinate actions bind display/window geometry. Unsupported OS features are unavailable rather than guessed.

No unrestricted desktop Eval primitive.

## 15.12 Built-in web search

WebSearchBroker separates:
- direct search providers;
- model-grounded search providers.

Request pins provider/account/cost policy. Results include source URL/provider/retrieval time and bounded extracted text/metadata.

Fallback:
- only explicit configured routes;
- never silent paid/auth-class change;
- no claim a source adapter is usable merely because code exists.

Search is network access and follows privacy/domain/provider policy.

## 15.13 Effects and recovery

Mutations use 14.

Failure classifications:
- deterministic validation: fix input without consuming a new risky effect;
- provider pre-content failure: retry according to same selected route policy;
- provider post-content/acceptance uncertainty: preserve output state, do not replay blindly;
- effect FAILED: retry only if policy/idempotency permits;
- effect UNKNOWN: reconcile actual target or require user;
- worker crash: restart only when state can be safely reconstructed.

## 15.14 Verification

Managed Task/Run success is independent from producer.

Verifier checks:
- exact accepted criteria;
- final integrated revision;
- build/test/lint/security/UI evidence as required;
- unresolved effects;
- scope regressions;
- relevant user journey.

No evidence freshness/revision match means no PASS.

## 15.15 Checkpoints and rewind

Checkpoint records references/digests to source/workspace/control state. Restore is previewed, conflict-checked and Guarded.

Never reset over later human/user-owned changes without explicit reviewed action.

## 15.16 Performance

Critical path should avoid:
- loading entire architecture;
- loading entire logs;
- spawning new processes for simple native reads where a safe existing service is faster;
- redundant model calls;
- unnecessary worktrees.

Use measured budgets in 31 and release tests in 32.

## 15.17 Implementation boundary

Exact package/function seams live in 20 and service interfaces in 37. Current implementation status lives in HANDOFF.md.

Historical competing conversation-owner runtime designs are archived and are not V1 authority.
