# 15. Runtime execution

Status: normative current-only runtime behavior.

## 15.1 Direct versus managed

Direct Session:
- ordinary pair coding;
- HorizonCode direct Session/continuation remains canonical; provider transport is replaceable only behind that owner per A-V2-27;
- no mandatory Goal/Run/Task;
- still uses capability scopes, complete ToolBatch barrier and Guard for effects.

Managed Run:
- explicit objective/spec/criteria/budgets;
- Rust control state;
- scheduling/delegation/recovery/verification;
- references one or more backend-owned Sessions through SessionLink without owning their transcript.

## 15.2 Provider turn

1. Build context from canonical direct HorizonCode/OpenCode-derived history plus selected ContextLedger refs.
2. Pin provider/model/harness/tool-registry generation and permission/cost policy for the turn.
3. Start provider request through the configured ProviderTransport (current `packages/llm`; future verified A-V2-27 OMP adapter).
4. Stream text/thinking into canonical direct Session message parts and derived UI.
5. Collect local tool calls until the provider response/step is complete.
6. Validate every call against request-pinned schemas.
7. If any call is malformed or response incomplete/failed, dispatch no local effect.
8. Read-only calls may execute through scoped fast paths after validation.
9. Effectful batch crosses Rust Guard/ExecutionHost.
10. Persist conversational tool results through the owning direct Session service.

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
- time/network/filesystem policy plus CPU/memory bounds only where OS-enforced; if the REPL profile requires unavailable CPU/memory enforcement, execution stays unavailable (`DEC-V1-27`);
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

Fallback (V1 cascade, `DEC-V1-26`):
- the built-in default route is enabled without a key; BYO-key providers are enabled per route in Settings;
- every enabled route joins one ordered cascade; auth 4xx (401/403/407) failures are recorded per route and fall through to the next explicitly enabled route; other non-rate-limit 4xx stop and surface; timeout/network/5xx and empty-result handling remains bounded;
- an exhausted chain applies one bounded normal retry and surfaces per-route reasons;
- only explicitly enabled/configured routes are used; never silent paid/auth-class change;
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

## 15.18 Future provider/adapter execution boundary

Staged OMP provider integration replaces only transport/catalog functions under the existing direct-session owner. Use a reversible feature gate; prove tool-call batching, auth, streaming, cancellation, compaction, usage, retries and Guard enforcement with each provider. Never attach a second full OMP coding runtime.
The separate official OpenCode runtime adapter has its own native sessions and process supervision. HorizonCode records session links and event projections only; reconnect after restart, distinguish permission requests, and fail clearly for restricted free models. Mode changes start a new explicit session rather than rewriting a live conversation.

## 15.19 Headless execution, provider readiness and memory-aware runtime

Foreground TUI, CLI, SDK and background managed jobs are views over the *same* authorised Core Session, Rust Task/Attempt and effect owners. A headless read-only specialist is an RPC/client attachment to shared services, not automatically another full provider host, terminal renderer and session supervisor. A writable worker retains a separately enforceable process/workspace isolation and precise Attempt lease. Multiple sessions must not share mutable prompt assembly, secrets, cancellation signals or SDK tool state without an owner key.

- **Scheduler:** admit work only after dependency PASS, policy/lease/worker-capacity checks and current process-tree resource capacity. Optimize useful verified task throughput, not simply maximum concurrent model calls. Resource shortage is a typed blocked/queued state with user-visible estimates/unknowns; no silent model/provider fallback.
- **Provider Doctor:** `offline` validates config, routing and model-picker projection without credentials/network spend; `catalog` verifies only the declared endpoint/auth and current model availability with bounded requests; `full` uses explicit cost consent for chat, stream and tool-call roundtrip. Distinguish transport errors, stale catalogs, model capability mismatches, provider cold start, local-model RAM/VRAM exhaustion, tool decoding and rate limits. Never store raw credentials in observations.
- **Prewarm:** reusable DNS/TLS/client pools and selected-model caches may be prepared lazily when permission and privacy rules allow, without unauthorized billing, background request loops or sending a user's prompt to a provider. Local model loading is a separately consented heavy resource. Warmup never changes the selected model.
- **Context and memory:** reuse compatible immutable tokenizer/index entries, not unbounded duplicate provider history copies; enforce per-session payload limits, cancellation-safe release and bounded cache pruning. Section 30 owns context truth and optional recall.
- **Interruption:** signal queued/active workers without polling spin loops; generation/epoch prevents a racing prior cancel from cancelling a new Attempt or being silently reset. Process-group/job-object cancellation must settle or mark UNKNOWN, not just cancel a local future.
- **Session import/resume:** enumerate supported external source formats, preview redacted metadata and ownership, user confirms snapshot import vs backend-native resume; never copy external credentials or claim live tool capabilities for a historic imported transcript.

These are target runtime behaviours, subject to negative/long-run proof. §20 owns insertion points and §18 owns measurement methodology.

## 15.20 End-to-end provider, tool, worker and completion algorithm

This is the target implementation call graph, not a claim of current wiring. **Direct mode must remain cheap**: no automatic Goal, spec acceptance, Task DAG or 20 worker pool solely to answer a normal coding question.

~~~text
Core Session input + provider selection snapshot
 -> freeze model/harness/account + user permissions + context epoch
 -> build scoped context and bounded ActionDescriptor tool list
 -> Provider transport stream with hard byte/call/finish deadlines
 -> complete ToolBatch validation and pinned tool-schema digest
 -> Rust Guard admission for each effectful origin (batch transactional preflight)
 -> immutable PREPARED intent + single-use lease + optional approval
 -> ExecutionHost with OS-backed effect boundary/process-tree ownership
 -> bounded observation + receipt/UNKNOWN and Session-owned tool-result Part
 -> updated source revision/context projection
 -> optionally Rust managed Task verifier and next DAG-ready child
 -> independent final integrated revision verification + Run terminal state
 -> derived TUI/CLI/SDK events + resource/cost metrics
~~~

**Exact real source anchors at audited main:** `packages/core/src/session/supervisor.ts` exports `SessionSupervisor.Service.openForSession/watchSession/prepareToolBatch/approveEffect/executeWrite` and `SessionSupervisorClient.request/subscribe/receive/ack`; `packages/opencode/src/session/tool-batch.ts` exports `gateToolCallStream`/`requireToolExecution` with hard 32 calls, 256 KiB per-call arguments, 512 KiB total, 16,384 delta chunks, 10-minute maximum stream. Rust `kernel/src/guard.rs` permits narrow guarded `files.write` only; `kernel/src/effect_host.rs` prepares challenge, approval, write and receipt, **not universal process execution**. `kernel/src/managed_control.rs` is explicitly non-executing. Any further names below are future contracts, not callable code.

**Provider turn algorithm:** create immutable turn snapshot {Session/message refs, selected provider/model/harness, tool registry generation, scope, context ledger epoch, max spend}. Provider output is untrusted; accumulate and size-check partial tool input, require the terminal finish/step conditions, normalize supported tool IDs before permissions, reject entire batch on schema/unknown effect class/oversize/unfinished stream, and forbid callback dispatch until Rust admissions are known. Pure reads get scoped bounded authorization; effects additionally get the durable §14 path. If a partly executed parallel approved batch fails, settle each admitted effect independently and present ordered results; do not claim atomic rollback of external operations.

**Provider Doctor decision table:** offline missing account/model → FAIL configuration without network; catalog network/auth unavailable → UNKNOWN/typed route or auth error, no fallback; full user consent absent → NEEDS_APPROVAL before model call; full partial stream/no terminal → FAILED/UNKNOWN cost status (query provider if possible); 429 → bounded same route retry only if user consent/cost policy permits; unsupported structured tools → explicit capability UNAVAILABLE; local model out of VRAM → resource blocked and no remote fallback. All returned identifiers are redacted/opaque; spend observed only when usage from authoritative provider exists.

**Managed executor (requires P2):** authenticated accepted SpecVersion → initialize Goal/Run immutable criteria and workspace scope → add finite DAG → compute READY after independent PASSED parents → resource and spend capacity admission → reserve Task/Attempt/WorkerExecution workspace/sandbox leases → spawn/attach headless agent → stream task context/progress/artifact refs → effectful worker calls use same Rust Guard → settle/reconcile → trusted Task verifier → dependency unblock → guarded integration → final Run-level independent verifier against current revision. A child does not acquire Session or Run ownership merely by having a process ID.

**Interruption semantics:** new user steer may affect *future* provider step only; once a batch/effect is prepared its digest, args and lease are frozen, and cancellation fences later dispatch. Cancellation/timeout before send returns no effect; after send but before receipt returns UNKNOWN unless actual target proof resolves it. Host/kernel restart rotates owner epoch; never reuse prior one-use lease. A user request to stop all work is propagated to each owned child and reported per Task, distinguishing cancelled, still running, unknown and settled. No silent cross-session kill.

**Runtime error mapping:** keep separate _validation DENIED_ vs _policy NEEDS_APPROVAL_ vs _unsupported UNAVAILABLE_ vs _capacity RESOURCE_BLOCKED_ vs _stale revision CONFLICT_ vs _transport retryable_ vs _effect UNKNOWN_. Use canonical typed error registry (§12) and preserve idempotency delivery key; log origin/session/attempt/source revision without raw secret/prompt contents. A failed provider call after a tool was dispatched cannot be replayed as a fresh tool effect merely by restarting the model request.

**Fast path:** direct read/search/patch stays one canonical Session and existing host runner, mediated as needed; render/index/telemetry are bounded asynchronous derivatives. Managed background tasks reuse existing Core/provider connections when safe, with OS-sandboxed effectful children. Benchmark complete user-visible verified tasks, including retries and tool outputs, rather than only first-token latency.
