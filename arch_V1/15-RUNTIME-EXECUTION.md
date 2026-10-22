# 15. Runtime execution

Status: normative current-only runtime behavior.

## 15.1 Direct versus managed

Direct Session (normal CLI/TUI coding path):
- ordinary pair coding;
- Core `SessionRunner` owns ordinary direct turns. Managed work enters through a separate `SessionPrompt` path; both must satisfy the shared behavior contract in §15.21;
- HorizonCode direct Session/continuation remains canonical; provider transport is replaceable only behind that owner per A-V2-27;
- no mandatory Goal/Run/Task;
- still uses capability scopes, complete ToolBatch barrier and Guard for effects.

Managed Run:
- explicit objective/spec/criteria/budgets;
- Rust control state;
- scheduling/delegation/recovery/verification;
- references one or more backend-owned Sessions through SessionLink without owning their transcript.

## 15.2 Provider turn

1. Authenticate the user's explicit prompt/continue at Core ingress and resolve only the already-selected provider/model/account/harness; do not infer or substitute a route.
2. Build exact provider-visible input from canonical direct HorizonCode/OpenCode-derived history plus selected ContextLedger refs using Core ContextService.
3. Pin the active AgentProfileV2 revision/digest, direct ContextSelection, exact provider-input digest, the selected Core-catalog route projection (including the fixed adapter, normalized endpoint and their revisions), the HostKernel-authenticated direct permission-mode digest, and the effective privacy/network/output-token/cost policy in Core SessionStore before transport; freeze the normalized input. The permission-mode digest is policy context only and does not authorize tool effects.
4. Start the selected route through configured ProviderTransport only after checking the frozen-input and non-secret SDK transport-request digests. This bounded turn authorization covers ordinary continuation requests without per-step prompts.
   The Core-to-Auth bridge is an in-process `DirectProviderTransport.Service`: Core supplies the frozen Catalog route projection, original request info/init, and SessionStore `pin` callback. It carries no credential reference, credential bytes, placeholder header, or caller-selected route. Auth validates the full destination and prepared request, computes `transportRequestDigest`, commits the `PINNED` journal record through that callback, then commits `DISPATCHING` and sends once through Auth's request-local pinned fetch. The Core default adapter is unavailable; OpenCode replaces it with the Auth-backed adapter. Unsupported or credentialed routes stay unavailable until their Auth/SecretBroker authorization contract exists. Auth response-stream failure or possible-send cancellation records `UNKNOWN`; Core owns response/usage settlement with the matching journal identity.
5. Stream text/thinking into canonical direct Session message parts and derived UI; persist the exact response/usage settlement against its request pin.
6. Collect local tool calls until the provider response/step is complete.
7. Validate every call against request-pinned schemas.
8. If any call is malformed or response incomplete/failed, dispatch no local effect.
9. Read-only calls may execute through scoped fast paths after validation.
10. Effectful batch crosses Rust Guard/ExecutionHost.
11. Persist conversational tool results through the owning direct Session service; each later provider request recompiles and pins its own selection before dispatch.

## 15.3 Context compile

The V1 Core ContextService compiler assembles provider-visible context for both direct and managed
prompt paths. It selects and bounds inputs; it does not replace canonical history. It records
selection provenance, source revisions and measured/estimated/unknown token counts, then applies
the selected model's context window and reserved-output budget. Direct and managed paths share the
compiler and policy; their transcript/control owners remain distinct. For direct requests, Core
SessionStore pins the compiled DTO, input digest, route and effective policy atomically before
transport; no per-request HostKernel bind/advance is used. For managed requests, HostKernel binds
the compiled DTO to the live Attempt and Core dispatches only after the exact digest receipt.

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

CodeMode uses the existing OpenCode-derived interpreter in a short-lived helper process under the existing Rust ExecutionHost supervisor. Existing `$codemode.search` progressively discovers only the current authorized tool tree; existing MCP adapters can be called only through Core's same guarded dispatcher. A bounded versioned stdio protocol returns nested call requests to Core; Core admits each complete wave through SessionSupervisor and the ordinary ToolBatch Guard/lease/receipt path. Pure/read-only compositions require no per-action approval; workspace reads/edits within an explicit active grant are prompt-free. HostKernel applies fixed `CodeModeResourceProfileV1` before first instruction: cgroup-v2 memory 536870912 bytes, CPU `100000 100000`, PIDs 64, and nofile 256. Every limit is mandatory and verified; without all verified OS limits or the fixed `horizoncode:codemode:bun` runtime CodeMode is unavailable on that backend. Bound one script to 64 total nested calls across at most 64 sequential waves of at most 32 concurrent calls, 30 seconds wall time, 64 KiB source/output and the 1 MiB aggregate payload cap. Cancellation terminates/reaps the helper through the existing supervisor. CodeMode cannot mint authority, bypass discovery policy or create another interpreter/runtime.

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

Direct Core child-Session fan-out is a V1 capability, separate from managed Task DAG scheduling.
It is available only after direct child admission, authenticated profile/grant binding, child
effects through Guard, and cancellation/recovery prerequisites are verified. It supports bounded
follow-up messages to an existing direct child only through the guarded direct-lane follow-up
operation after its fresh-turn/recovery proof; it is not arbitrary append or managed DAG fan-out.
Managed multi-Task fan-out remains disabled until every Task settles and Rust durably settles the
aggregate Run outcome.

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

The model-facing request contains query intent, bounded filters and result limits only; it cannot pin provider, account, auth mode, route class, cost policy, endpoint, retry behavior or credential. HostKernel resolves the user-consented route plan and supplies its exact fixed provider/auth/cost policy. Results include source URL/provider/retrieval time and bounded extracted text/metadata.

Fallback (V1 cascade, `DEC-V1-26`):
- after first-use query-sharing consent, the built-in free anonymous cascade is default-enabled in §37.5's fixed initial order (Exa, You.com free profile, Firecrawl Keyless, Parallel); authenticated routes are user-enabled separately in Settings, while grounded-model search is separate and explicit-only;
- the trusted route plan comes from broker/config state, never model-supplied; auth 4xx (401/403/407) failures are recorded per route and fall through only to another explicitly enabled route; other non-rate-limit 4xx stop and surface; timeout/network/5xx and empty-result handling remains bounded;
- each eligible route gets only its §37.5 bounded route-local retry; after one ordered cascade pass, exhaustion surfaces per-route reasons and does not restart the full cascade;
- only default-enabled free anonymous routes (after first-use consent) and explicitly user-enabled BYO routes are used; grounded-model search is explicit-only; never silently change paid/auth class;
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

## 15.21 Shared SessionRunner/SessionPrompt behavior contract

Core `SessionRunner` remains the normal direct CLI/TUI execution path. Managed work may use a
separate `SessionPrompt` entry path to bind an Attempt, but it must reuse the same context compiler,
provider/model/harness pinning rules, tool registry/schema generation, full-batch validation,
stream and terminal-state semantics, usage accounting, cancellation/error mapping, durable
transcript persistence, and Guard/ExecutionHost mediation. Managed execution adds authenticated
Attempt and EffectIntent/lease bindings; it must not fork an alternate runtime or weaker tool policy.
Acceptance covers matched direct-versus-managed requests for ordering, tool validation, usage,
stream completion, cancellation and restart recovery. This contract does not claim both paths are
currently implemented or verified.
### CodeMode and request context truth (2026-10-22)

CodeMode is a model-facing orchestration tool that runs compact code to compose tools,
branch/loop, filter intermediate results and return only useful output. It improves
multi-call/context efficiency; it does not implement the coding loop or grant tool
authority. Existing `$codemode.search` supports progressive discovery. Every nested call
must re-enter Core's authenticated ToolBatch and Rust Guard/lease/receipt boundary. The
current registry is hard-disabled and the in-process adapter rejects nested dispatch, so
there is no usable CodeMode path today; §37.24 is a target contract, not runtime evidence.

Current context selection must not be described as a complete compiler: direct turns pin
a bounded recent-reference set, and managed turns pin the exact prepared request. The
model-aware budget/retrieval/provenance compiler and pressure recovery remain a distinct
V1 implementation target in §30.21. Direct and managed runner parity also remains an
acceptance requirement, not an assumed property.
