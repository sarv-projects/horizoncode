# 15. Direct turns, context, repository intelligence and managed work

This document connects the records in `11-LIFECYCLE.md` and `12-DOMAIN-SCHEMAS.md`
into runtime procedures. Direct interaction and durable managed execution share the
Thread runtime, provider layer and authorized tools; they do not share the same
lifecycle aggregate.

## 15.1 Direct versus managed mode

Direct mode is the prompt-first path for ordinary coding:

```text
prompt → durable Thread input → Turn → ContextPacket → one provider turn
       → admitted tools/effects → next provider turn or answer
```

It creates no Goal, SpecVersion, Task DAG or managed Attempt unless the user
explicitly promotes work to managed mode. It can use a bounded native subagent for
delegation, but that delegation is not a managed Task and cannot claim Task PASS.

BudgetService uses its direct Thread/Turn owner branch for provider, tool and native
delegation reservations; it never fabricates a Run to account for direct work. A
delegation reservation is a child of its parent Turn budget, and child provider/effect
usage settles that reservation through the same UsageService/BudgetService path.
`DirectDelegationV1` is a subrecord of the parent Thread stream: ThreadService admits,
fences, cancels and reconciles it. The native Adapter takes `DirectWorkerBindingV1`
and `DirectTaskPackageV1` at the same WorkerAdapter Interface used for managed work;
the child has its own Thread and a concrete WorkerExecutionId, but no managed Task,
Attempt or SpecVersion. Required profile hooks, hard limits, authority intersection,
workspace fences, launch idempotency and UNKNOWN handling apply unchanged.

Managed mode is explicit:

```text
exact request → Goal draft → bounded read-only preparation → immutable SpecVersion
       → Task DAG + verification plan + review digest → user confirmation
       → budget reservation + activation commit → dispatch outbox → workers
       → deterministic integration → independent verification → completion predicate
```

The exact activation review digest is the user approval boundary. No worker is
launched and no effectful preparation occurs before the Run's `GoalActivated` commit.
The preparation profile can read/query only; it cannot write the workspace, contact
external systems, install extensions, or use an unreviewed secret.

## 15.2 Direct Thread runtime contract

1. UI submits an `InputAdmissionRequestV1` with stable `deliveryId`, explicit `steer` or
   `queue` lane, bounded body/artifact refs, Thread ID and expected cursor.
2. ThreadService stores the input and returns its committed cursor before the host
   receives an advisory wake. Exact retry returns the same receipt. Conflicting
   reuse is rejected.
3. The host's process-local Core V2 coordinator serializes a drain for that Thread
   and permits different Threads to execute concurrently. It joins explicit same-
   Thread resumes and coalesces wakeups. This local coordinator is not durable
   execution truth and does not itself recover provider requests after process death.
4. At a safe boundary, ThreadService promotes eligible input and commits a Turn with
   immutable profile/route/policy/toolset references. `steer` inputs are visible at
   the next safe provider-turn boundary while the current Turn continues. `queue`
   input remains pending until the current continuation would otherwise idle, then
   promotes one FIFO item and reevaluates.
5. ContextService builds the deterministic packet from current owner snapshots. The
   kernel commits epoch/projection digests before the host sends the request.
6. The host performs exactly one `packages/llm`/Core V2 provider stream for each
   provider attempt. It renders text deltas without kernel round-trip per token and
   collects tool-call fragments without dispatching them.
7. On provider finish, the host validates complete call schemas and aggregate bounds,
   then submits one whole `ToolBatch`. Kernel admission checks the pinned toolset,
   current policy and all resources before any unstarted call executes.
8. The host receives ordered bounded tool results, appends explicit history, and may
   continue the provider loop. At final/failed/incomplete termination it commits
   message and Turn boundary. Provider acceptance without terminal observation is
    `UNKNOWN_PROVIDER_ACCEPTANCE`; no automatic resend after restart.

An admitted batch reports bounded incremental per-call observations to ThreadService
using §13's `ToolCallObservationV1`/`ToolCallAcknowledgementV1` Seam. ThreadService
commits the immutable ordered result before post-tool hooks run. Dependent calls wait
for the corresponding acknowledgement and completion of required post-hooks; failure
blocks unstarted dependents without rewriting the already-settled result. Independent
calls already admitted may settle, but do not bypass that dependency barrier. A final
ordered report reconciles all observations; it is not the first opportunity to commit
results, and ThreadService alone owns batch suspension and settlement.

Prompt delivery uses explicit vocabulary. For an ordinary main-agent direct Turn,
`steer` can reset the input-scoped provider-turn allowance once per promotion batch;
a queued input resets that allowance when promoted. This is not the worker hard-limit
counter: steering or queued input cannot reset the pinned managed Attempt or direct
delegation limit state. The assistant response must never clear or overwrite
a newer local draft. `/quit` detaches the UI; it does not mean cancel. Direct mode
interruption targets an exact Turn, not an ambiguous Thread with no active operation.

The selected OpenCode Core V2 `Session.prompt`/`SessionRunCoordinator` behavior is
adapted behind `ThreadStoreService` and the durable kernel admission API. The
OpenCode-native SQL Session tables are only projections, test stores and migration
input; they are not a second writable conversation truth. Legacy Core/`packages/opencode`
loops are migration/compatibility only and are not fallback production runners.

## 15.3 Context sources and ContextEpoch

There is one ContextService and one ContextEpoch owner (ThreadService). Context
contributions use the host Effect service registry, but source facts remain owned by
their domains. The core source set is:

1. platform/system invariants;
2. project instructions and explicit user directives;
3. current Thread/Turn/agent identity;
4. active approved Run/Task/spec facts where applicable;
5. effective Guard restrictions and approval posture;
6. current workspace/repository revisions;
7. selected revision-bound repository intelligence;
8. provenance-bearing advisory memory;
9. selected conversation history and durable answers;
10. currently promoted user inputs;
11. the pinned model-visible tool definitions.

Stable ordering is part of the request digest and provider-cache behavior. Context
sources carry a stable `sourceKey`, source version/head digest, scope, trust label,
freshness, required/optional status, size bound and renderer version. Duplicate
source keys fail composition. A missing optional source is represented as unavailable
with its declared fallback; a missing required policy/identity source blocks request
construction. Plugin text is ordinary untrusted context and cannot become privileged
system policy or grant a capability.

If a presentation contributor crashes, disable its view and report the error without
changing work state. If an optional context contributor crashes, mark that source
unavailable at the next safe epoch and apply its declared stale/fallback policy; do
not mutate an already-pinned packet. An optional tool contributor becomes unavailable
at the next safe provider-turn boundary. Failure of a required sealed service blocks
startup or fences its dependent operation; never substitute a weaker provider or
fabricate healthy authority.

An epoch is created at Thread creation and at explicit reset, compaction, workspace
revision change, active SpecVersion change, profile revision/toolset change, or
material policy change. A model change alone does not erase Thread history. Because
the epoch pins its route snapshot, a changed route uses a successor epoch that may
retain the same history/source ranges; provider-specific continuation metadata may
become unavailable. In-flight requests keep their old epoch, route, profile, plugin
generation and toolset. A mid-stream setting edit is pending for the next provider
boundary.

### Deterministic packet construction and DCP policy

`DCP` is a named pruning/compaction policy inside ContextService, not a second
authoritative context engine, plugin, memory store or Thread history. The provider
request packet pins all included/omitted source ranges and artifact references,
source heads, route/profile/toolset/policy/workspace digests, static-prefix digest,
token estimator version, input/output reserves, uncertainty, pruning-policy digest
and final request digest.

Pruning order is conservative and deterministic:

1. remove exact duplicate observations only when source and revision digests match;
2. omit a superseded read only when freshness, scope and content equivalence prove it
   adds no information;
3. replace an oversized tool result in the prompt with a bounded relevant excerpt
   and immutable full-result artifact reference;
4. omit old resolved errors with recoverable source references;
5. preserve active failures/questions, current user inputs, approved requirements,
   current restrictions, unresolved effects, budget/Run/Task state and evidence heads;
6. if long-history summarization is required, create a new ContextEpoch with a
   separate summary artifact, source ranges/digests, model/prompt provenance and
   lossy/untrusted label.

When the packet does not fit, ContextService follows the fixed
`ContextPressureStage` order: exact deduplication; omission of proven superseded
observations; bounded tool-result eviction to excerpt plus immutable artifact ref;
pruning stale/resolved observations with recoverable refs; structured extraction;
deterministic structural compaction; policy-permitted abstractive compaction; then one
deterministic emergency packet retaining every required source. Abstractive output is
lossy/untrusted. No stage may remove current user input, system/Guard restrictions,
approved requirements, unresolved questions/effects, or required Run/Task/Evidence
state. If the required set still cannot fit, fail before provider dispatch.

Before performing extraction, summary provider work or other recovery, ThreadService
commits `compaction/admitted` with the immutable `ContextRecoveryPolicyV1` artifact,
semantic source-set digest, stage, strategy and attempt ordinal. Admission consumes
the finite total/per-stage allowance. Failure or cancellation before preview is still
recorded against that admission; restart aborts or reconciles the interrupted record
without refunding it or retrying an uncertain summary request. No strategy is repeated
for the same semantic source set. `sourceCursor` remains an optimistic-concurrency
binding, not breaker identity: provider-attempt/compaction bookkeeping, cursor advance,
heartbeats and diagnostics do not reset the allowance. `sourceSetDigest` covers actual
selected context content, relevant owner generations/heads, route/profile/toolset,
policy and token-budget digests. The source set changes only when one of these semantic
inputs changes. The rebuildable circuit opens at exhaustion; preview/failure/abort
leaves the active epoch and canonical history intact. A committed successor epoch
counts as a reset only when its effective semantic context changes, not merely its ID.

Only explicitly enabled `CompositionLockV1.globalHookBindings` select global hooks;
registration alone does not activate them. Bindings pin the event, HookId, requiredness
and deterministic ordinal, resolved through the same contribution registry as profiles.
The global `before_compaction` hook runs after a validated preview and before commit;
blocking or failure leaves the prior epoch active. `after_compaction` runs only after
the committed record/epoch is durable and is observational. These use the same
`HookContributionV1` registry as worker lifecycle hooks, but are not profile bindings.
Failure of `after_compaction` is reported without rolling back the committed epoch or
claiming that the hook succeeded.

An explicit structured provider rejection `PROMPT_TOO_LONG` is recoverable only when
the provider adapter can establish a terminal pre-content rejection and no uncertain
acceptance. The failed `ProviderAttempt` remains immutable. ThreadService may then
run the same bounded context-pressure sequence and create a new `ProviderAttempt` with
a fresh attempt ID and request digest on the same pinned route/profile/toolset/policy;
it does not silently switch model or reasoning. No error-string parsing is used to
classify the rejection. Unknown acceptance, partial content or a tool proposal forbids
automatic resend and follows normal reconciliation/failure handling. Exhaustion
returns `CONTEXT_RECOVERY_EXHAUSTED` visibly without sending an oversized request.

Never reconstruct Run truth from transcript or summary; rehydrate its current state
from RunController. Computing/displaying a preview never changes the active context;
its bounded admission/preview bookkeeping is persisted when recovery work is attempted.
Commit occurs only after output
schema/size/source coverage validation. The original event range remains canonical
and recoverable. If new input/ToolResult lands after the source cursor, compaction
must rebase or abort; it cannot silently omit the new event. On failure, the prior
epoch remains active. No compaction operation can rewrite immutable history or
launder untrusted content into a system message.

Token estimates are labeled with estimator and uncertainty; reserve the provider's
configured output budget before sending. If estimates cannot prove the request fits
the selected model's known limit, shorten via the pinned policy or fail visibly. Do
not change model/reasoning to fit. Provider cache hits are reported only if the
provider's protocol returns an authoritative signal.

Keep system baseline, profile, tool schema generation and repository context
projection in deterministic order to improve prefix-cache reuse where supported.
Cache is an optimization, never authority. Reuse a local tool observation only for an
exact fresh pure read (unchanged file at the same revision, query at the same
RepoGeneration, immutable-snapshot status, or symbol lookup at that generation) and
only after the current authorization/read-policy check. Never reuse shell output with
unknown side effects, a write, network result or external mutation. Return original
provenance/time and cache status; do not represent a cached observation as a new
execution or verifier Evidence.

For `reviewed_fork`, prompt-prefix reuse is a provider-cache hint only, never a local
provider-response or continuation cache. The child Thread pins the parent relationship
and explicitly reviewed message ranges. Reuse is eligible only for an exact prefix
digest match across source ranges, static/system prefix, route/model, profile, toolset,
policy, workspace/repository and memory generations; otherwise construct a fresh
prefix and omit `ContextPacketV1.prefixReuseSource`. If eligible, that field references
the parent packet and exact prefix/range digests. Forked Turns, permissions, Guard
decisions, effects and Run state are never reused. Report a cache hit only from an
authoritative provider signal; a miss or unknown signal changes no correctness behavior.

## 15.4 Repository intelligence

RepoIntelService owns one derived repository intelligence system shared by main and
child agents. `hz-indexd` is a supervised worker implementing that service; it is
not a second source of workspace truth. A `RepoGeneration` pins repository/member,
workspace overlay, RevisionSet, read policy, parser set and generation status.
Indexes may include Tree-sitter, lexical/FTS, LSP, SCIP and optional embeddings;
missing parsers produce a visible partial generation, not a false `CURRENT`.

The source-of-change precedence is:

```text
Effect/ChangeReceipt → editor buffer overlay → Git observation → filesystem watcher
                     → reconciliation scan
```

Watchers are invalidation hints; bytes/digests and owner receipts establish state.
Unsaved buffers are a separate overlay tied to a base generation and editor version.
A file edit updates the affected overlay rather than triggering full repository
reindex. Current generation changes never mutate beneath an in-flight request; its
ContextPacket pins the generation.

Queries are bounded and return generation refs, freshness, source ranges, confidence,
partial/unavailable status and provenance. Cursor pagination is bound to query and
generation digest. Results are observations, not authority or proof. Cached read
results may be reused only for the exact source revision, scope and read policy; shell
commands, writes, network calls and external mutations are never result-cache hits.

Scheduling priority is:

| Priority | Work |
|---|---|
| P0 | cancellation, workspace fencing, effect/worker reconciliation and safety control |
| P1 | active interactive query and visible current-file update |
| P2 | active Task neighborhood/changed-file overlay |
| P3 | dirty workspace reconciliation and required verifier indexing |
| P4 | initial repository indexing |
| P5 | optional semantic enrichment/embeddings |

Under contention, defer/drop P5 before blocking keystrokes, cancellation or verification.
The OS/filesystem watcher and index queue have bounded work, backpressure and a
full-rescan fallback. Every index read obeys the same scoped roots/read policy as
the agent; symlink/reparse traversal outside those roots is refused.

## 15.5 Goal preparation and activation

Preparation takes the exact original request as an immutable artifact, current
Project/repository bindings and a pinned preparation profile. It creates candidate
SpecVersion, Task DAG, acceptance scenarios, verification plan, scope, budgets and
assumptions. RunController validates:

- all requirements have stable IDs and each mandatory requirement maps to at least
  one acceptance scenario;
- every Task has explicit inputs/outputs, dependency IDs, repo/member scope, read and
  write scope, profile, attempt/parallelism limits, budget and verification links;
- dependency graph is acyclic and all IDs refer to the same approved spec;
- there is no unbounded external effect, unsupported required capability or
  impossible guarantee requirement;
- the verification plan can observe the claimed outcome without producer authority;
- aggregate estimated reservations are finite and fit the applicable hard limits.

The review bundle binds original request, proposed spec, DAG, requirements/scenarios,
repository base revisions, route/profile/toolset/policy digests, capability gaps,
budgets, execution location and risks. The user explicitly confirms the exact digest;
the owner records that confirmation and invalidates it on any bound change.
Any change invalidates approval and yields a new SpecVersion/review bundle. Budget
reservations are committed immediately before Goal activation; failure to reserve
means no activation. Dispatch outbox rows derive from the activation commit and are
rebuildable from canonical events.

## 15.6 Scheduler, admission and progress

The scheduler is deterministic and policy-driven, not a second agent loop. It admits
only Tasks whose dependencies are currently `PASSED`, active spec is current, Run
allows dispatch, required capability is available, workspace is fenced, hard budget
is reserved, profile selection is valid, no required effect/launch remains unknown,
and concurrency limits allow execution. For multiple ready tasks, use explicit Task
priority followed by stable TaskId; persist the selection reason. No price, token
cost, subscription credit or guessed latency participates in agent/model choice.

Dedicated bounded control capacity serves cancel/fence/reconcile/approval operations
ahead of background work. Initial lane order:

1. cancellation, fencing and reconciliation;
2. active interactive requests;
3. required integration and verification;
4. admitted managed Task work;
5. background subagents;
6. optional indexing/maintenance.

Fairness prevents a lane from starving indefinitely; policy records any aging or
reserved capacity. Concurrency limits apply at host, Run, Task, profile, workspace,
provider and adapter. A capacity change affects only future dispatch; it does not
mutate an in-flight WorkerExecution.

The existing optional indexing/maintenance lane is bounded and remains one scheduler
lane, not a second scheduler or RunController. Admission enforces finite queue entry and
byte limits, per-owner concurrency limits, deadlines and maximum queue age. Equivalent
work for the same owner, generation and operation digest is coalesced; a newer
generation supersedes stale queued work. Jobs are interruptible at safe boundaries and
yield immediately to cancellation, fencing, reconciliation and active interactive
work. Fairness aging applies only within eligible background capacity and cannot
consume the protected control slice. Queue saturation rejects or coalesces visibly;
it never creates unbounded backlog or blocks required control work.

Maintenance diagnostics report queue depth/bytes, oldest age, per-owner active and
coalesced counts, stale/superseded count, last success/failure cursor, deadline status
and the reason work is paused or throttled. They expose metadata/digests, not prompt or
repository content. RepoIntelService and MemoryService retain ownership of their job
state and results; the scheduler only admits and prioritizes bounded work.

Progress is assessed using a semantic signature over Task states, workspace revision
set, Evidence heads, unresolved blockers/effects, integration state, last meaningful
state transition and strategy digest. Heartbeats, token count and repeated no-op
messages do not count as semantic progress. A configured stall/attempt/time budget
may stop dispatch and raise NeedsYou or create a new bounded Attempt; thresholds must
be policy values pinned in Run, not hidden heuristics. No-progress never authorizes
blindly widening scope or budget.

Managed DAG execution proceeds in explicit waves. RunController integrates and verifies
settled producer outputs, commits current Task PASS only from independent Evidence,
then commits `run/next_wave_started` (`VERIFYING → EXECUTING`) when remaining eligible
Tasks exist and prerequisite Evidence, spec, policy, budgets, fences and safety state
are current. Completed verification of one wave does not imply Run completion. A
known terminal producer failure with no permitted retry commits `task/execution_failed`
instead of stranding a Task RUNNING; unresolved outcomes remain nonterminal. No next
wave is dispatched during unresolved integration/verification or on stale Evidence.

A definitive current scenario failure with a permitted distinct bounded strategy uses
`task/verification_failed_retryable` (`VERIFYING → READY`), not a stuck VERIFYING
state or a fabricated execution failure. Admission requires remaining attempts/budget
and all owned operations settled. RunController's next-wave transition revalidates the
retry and unaffected prerequisite Evidence before execution resumes. Exhaustion takes
`task/failed`; stale/insufficient Evidence or unresolved operations cannot authorize retry.

## 15.7 Agent profile selection and worker adapters

There is one AgentProfile registry for main, default-general, specialists, custom,
native and external agents. The default subagent setting is a reference/configuration
for `builtin.general`, not a separate engine or state owner. Built-in specialist
profiles are `architect`, `explorer`, `implementer`, `reviewer` and `test-debugger`;
`verifier` and `recovery` are controlled execution roles with narrower authority.

Selection order is explicit user choice → Task-pinned profile → deterministic
automatic matching → enabled `builtin.general` fallback → ask/remain local. Matching
uses task category, path/language, capability requirements, invocation mode,
runtime health, model/reasoning support, loadout, required lifecycle-hook compatibility,
policy ceiling, workspace conflict, effective turn/tool/token/wall-time limits, budgets
and concurrency. Automatic selection requires a unique eligible result after
stable priority/specificity tie-breaks. Manual-only profiles never auto-launch. No
eligible profile means `CAPABILITY_UNAVAILABLE` or NeedsYou; no quiet switch to a
less capable or cheaper model.

Before dispatch, resolve the profile's lifecycle-hook bindings against the exact
`CompositionGeneration` and the adapter's supported/observable/enforced lifecycle
events. The resulting ordered set, including contribution digests and compatibility
status, is pinned by `WorkerBindingV1.lifecycleHookSetDigest`. A required hook that
cannot be resolved or provided at the required guarantee makes the profile ineligible;
it is never silently dropped. An optional unsupported hook is omitted, shown as
unavailable, and recorded as such in the pinned hook-set resolution.

Hook event boundaries are:

| Event | Boundary |
|---|---|
| `before_start` / `after_start` | Immediately before worker start / after its authenticated start receipt |
| `before_tool` | After call validation and batch admission, before that call reaches its executor |
| `after_tool` / `tool_failure` | After ThreadService commits the per-call result / failed result |
| `before_finish` / `after_finish` | Before the candidate terminal WorkerExecution result / after its terminal event commits |
| `on_failure` | After a typed worker-level failure is recorded |
| `on_idle` | At a safe loop boundary with no provider request or tool call in flight |

`before_tool`, `after_tool` and `tool_failure` bindings require per-tool lifecycle
visibility from the adapter. A blocking hook requires enforced mediation; observing
tool events alone cannot authorize a block on an operation the kernel cannot control.
Opaque ACP/CLI peers that do not expose tool events cannot satisfy required per-tool
hooks. Optional per-tool hooks are marked unavailable for those peers, never described
as enforced. A required `before_finish` hook is compatible only when the adapter can
withhold terminal completion and return its bounded feedback to a continuing worker
loop.

Model precedence is explicit invocation → fixed selection in the chosen profile →
fixed default-general setting → permitted `inherit_parent` → main default → explicit
`peer_managed` when the selected external peer owns model choice. `inherit_parent` is
invalid without an invoking parent; it pins that parent's resolved fixed route only when
the child adapter can apply it and the child independently passes route, capability,
policy, secret and budget checks. Failure is visible/ineligible, never a silent model
substitution. Reasoning precedence follows the same binding, and unsupported fixed
reasoning fails visibly.
An explicitly configured fallback is allowed only before visible content/tool
proposal and only if no uncertain provider acceptance exists, the route satisfies
capability/reasoning/policy requirements, and its budget is reserved. After visible
content, show the incomplete attempt; do not splice a second model's output into it.

Every dispatch creates an immutable binding with parent/child Thread, managed
Run/Task/Attempt or direct-delegation ownership, profile revision (including its `AgentLimits.maxTurns`), invocation
origin, selected route/reasoning, adapter build/capability/loadout/lifecycle-hook-set/
effective-authority/context digests, workspace, budget and outbox refs. A TaskPackage
contains objective, acceptance contracts, bounded context/retrieval refs, source
revisions, tool/skill/MCP manifests, output contract, limits and authority ceiling.
Parent transcript is not copied by default.

Managed dispatch uses `WorkerBindingV1`/`TaskPackageV1`; direct native dispatch uses
`DirectWorkerBindingV1`/`DirectTaskPackageV1`. Both cross one WorkerAdapter Interface,
but their owner identities/results are explicitly typed and cannot be coerced into
one another. Native-only direct delegation fails visibly for an unsupported Adapter
rather than inventing managed IDs. The parent Thread commits the stable delegation
dispatch intent before launch and reconciles its WorkerExecutionId on reply loss.

`AgentLimits.maxTurns` is optional. If set, one turn is one completed provider-response
boundary on the worker Thread; tool calls within that response do not each consume a
turn. For example, a model response, its tool calls/results, then a second model response
consume two turns. The counter increments at the completed response boundary, and the
runtime checks it before admitting another provider request. When present, `maxTurns`
must be a positive integer. A missing profile cap means no profile-specific turn
ceiling; other enclosing execution and aggregate Task/Run limits still apply. A
configured cap is eligible only when the adapter can observe provider-response
boundaries and enforce the stop before another request; opaque peers without both
capabilities are ineligible for that profile. Report configured, observed and enforced
status truthfully.

Resuming one process preserves its WorkerExecutionId. Launching a replacement process
allocates a new WorkerExecutionId and increments incarnation, links the predecessor,
and carries forward the owner-persisted execution-limit state and pinned hook set.
For managed work the counter is scoped to the Attempt; for direct work it is scoped to
the DirectDelegation. It is not reset by process replacement, steering or retry within
that same owner. The old writer must be reconciled/fenced before replacement launch.
A new Attempt starts a fresh profile-limit state, but does not reset aggregate Task/Run
budgets, attempt limits or other shared limits. Worker failures include `TypedErrorV1`
in the existing result Interface, including `AGENT_LIMIT_EXCEEDED` details.

`NativeHzWorkerAdapter`, ACP, CLI, container and remote adapters implement the
WorkerAdapter lifecycle in §11.5/§12.10; local process supervision is the separate
ExecutionHost contract in §14.4. Capability snapshots state separately what
is configured, observed and enforced. External peers may hide model, tool events,
usage, resume, cancellation or internal mediation; display unknown/unavailable
truthfully. A peer message is data; it cannot change another Task. An unresponsive
peer does not permit a second mutable workspace writer.

## 15.8 Integration and independent verification

Workers produce candidate revisions and result artifacts. The integration coordinator
orders by DAG topological order then stable TaskId, confirms the expected base is
still current, applies a deterministic merge/patch strategy and records before/after
RevisionSet plus changed paths. Conflicts become a typed NeedsYou decision. Model
suggestions may be shown as proposals but do not automatically resolve conflicts.
Every integration/formatter/rebase creates a new subject digest; Evidence for the
old subject becomes stale where affected.

For a Project with multiple repositories, every Task/Run/checkpoint identifies the
full relevant `RevisionSet`. Integration records a per-member result. If repository A
integrates while repository B conflicts or remains unknown, retain that explicit
partial state and keep the Run nonterminal; never summarize it as a percentage of
successful completion. Verification binds the complete required set.

After integration, VerificationService issues a single-use `VerificationPermitV1`
bound to the exact approved SpecVersion, complete RevisionSet, workspace manifests,
environment/toolchain, policy, verifier profile and scenario set. It commits permit
consumption against the exact WorkerExecution before launch. The verifier uses a
distinct WorkerExecution on a read-only subject view, lacks producer write capability,
and can observe only the permit's declared sources/capabilities. A changed subject,
policy, profile or environment revokes an unconsumed permit; an uncertain launch
prevents issuing another permit until its WorkerExecution is reconciled. The verifier
returns per-scenario `PASS`/`FAIL`/`NOT_RUN`/`INCONCLUSIVE`, observation refs and
limitations. Its own
report is evidence material; RunController validates mandatory scenario coverage,
freshness, receipt provenance and current predicate before accepting `Task → PASSED`.
Worker self-report, check output, test command exit code or model assertion alone
cannot create PASS.

The permit digest includes its exact `policyDigest` and workspace manifests; consumption
and Evidence production revalidate the same bindings. A changed policy never inherits
a prior unconsumed permit. A consumed permit's Evidence is rejected/staled if those
bindings no longer match; the change cannot turn a producer or hook into a verifier.

High-risk requirements may mandate a different verifier adapter/provider, deterministic
oracle or human review. Same-model verification is procedural separation only and
must not be presented as statistically independent. ProofPack is a bounded exportable
bundle of spec/revision/evidence/check/effect receipts and limitations; it must not
contain secret bytes or expose inaccessible artifact content as if present.

## 15.9 Recovery, cancellation and maintenance

On kernel startup: verify event-log committed heads/seals; rebuild/check projections;
acquire new supervisor owner epoch and fence old writers; reconcile outbox claims;
observe exact processes/peers; reconcile effects; advance/revoke workspace fences;
settle budget reservations; stale invalid evidence; rebuild dispatch eligibility; then
resume only operations proven safe. A projection ahead of the committed head is
corruption and fences writes. Projection lag is repaired by replay; it never changes
canonical history.

Cancellation uses a priority control lane and exact typed target. Run cancellation
commits `CANCELLING`, installs a Run fence and stops new claims before signaling
workers; Task cancellation does not cascade to independent Tasks; Attempt cancel may
return the Task to `READY` only after reconciliation and policy/budget/new-strategy
checks. `/stop-now` is best-effort termination and reconciliation, not rollback.
Unknown external effects remain unknown.

Task and Attempt cancellation remain CANCEL_REQUESTED until all owned execution,
launch and effect outcomes are authoritatively settled; merely recording UNKNOWN is
not terminal cancellation. ThreadService uses `turn/operations_reconciled` for a Turn
blocked on effect/process outcomes, consuming linked owner receipts and revalidating
remaining provider/batch state. Provider uncertainty still requires its distinct
ProviderAttempt reconciliation; no operation receipt substitutes for it.

Maintenance/update acquires a global maintenance admission permit, blocks new
effectful work, allows cancellation/reconciliation and required minimal audit, and
waits until active operations are settled. Fencing preserves uncertain work for
reconciliation but does not authorize automatic binary activation or schema mutation.
Download/staging and read-only diagnostics may proceed without replacing active code.
No updater replaces running binaries beneath unresolved work. A heartbeat timeout is
not process-death evidence. Direct Turns without durable continuation support may
require explicit user retry after `UNKNOWN_PROVIDER_ACCEPTANCE`; managed Runs follow
recovery policy and never automatically duplicate provider-side work.

## 15.10 Legacy Session migration and cutover

Migration is one-way for canonical ownership but keeps the source read-only until
acceptance and retention approval:

1. Take a stable, read-only source-store snapshot and record source identity/digest.
2. Allocate a kernel ThreadId and persist a unique
   `(source_store_id, legacy_session_id) → thread_id` alias before exposure.
3. Import messages/tool history/forks/attachments/compaction metadata with ordering
   and provenance; do not invent missing parent/content data.
4. Represent in-flight provider attempts as `UNKNOWN_ACCEPTANCE` and pending legacy
   effects as `UNKNOWN` with unmediated provenance; never replay automatically.
5. Verify counts, ordering, content digests, aliases, attachment availability and
   relationship links. Exact retry resumes by alias/source digest; conflict refuses.
6. Switch all product writes and reads through `ThreadStoreService`; legacy SQL is
   projection/test/migration only. Never run both stores as writable authorities.
7. Keep the source snapshot for rollback and retention. Rollback changes the read
   adapter cutover but does not erase imported Thread history or permit concurrent
   writes to both stores.

Migration acceptance is a separate gate from architecture design and must be tested
on representative stores with crash/retry and missing/corrupt attachment fixtures.

Historical initialization uses the explicit versioned importer records/events in
§§11–12, not live preparation guards with fabricated reservations or approvals. Each
owner validates the read-only source digest, import delivery key and parent/child
identities before appending its historical facts. Cross-owner imports form a linked,
resumable saga; `thread/legacy_session_imported` confirms a manifest of completed owner
receipts, not an atomic multi-store commit. Imported unresolved operations remain
unmediated/UNKNOWN, cannot execute from replay and enter ordinary owner reconciliation
before any new authorized work. Alias/digest conflicts refuse import without overwriting
source data or acknowledging a partial import as complete.

## 15.11 Checkpoints and rewind

A checkpoint is an immutable, owner-built record of repository RevisionSet, a
restore-capable `DirtyFileRestoreManifestV1`, workspace bindings, Thread/Run/Task owner cursors, profile revisions,
ContextEpochs, composition generations and pinned artifacts. It is not a snapshot of
external effects such as a sent email, created PR, deployment or remote API mutation;
those remain durable history.

The dirty-file manifest pins bounded immutable preimage artifacts plus path, prior
existence, file kind and required metadata; a digest alone cannot restore uncommitted
bytes. Deleted/absent paths are explicit. WorkspaceService captures the manifest under
the exact revision/fence, verifies artifact durability/reachability and retains those
pins before the first admitted write. Missing/unreadable preimages block checkpoint
capture and the protected write; symlink/reparse entries are not followed and restoration
requires the current path-identity/Guard checks. No restore silently overwrites concurrent
changes, recreates an unsafe link or substitutes Git HEAD for a dirty preimage.

`/rewind` never maps to a blind `git reset --hard` or whole-workspace overwrite. The
owner first compares current and target digests and emits a `RewindPlanV1` listing
owned paths to restore, unrelated concurrent edits to preserve, conflicts, Evidence
to stale, and external effects that will remain. An owned path whose current digest
does not match the expected owned revision is preserved and reported as conflict
unless a user resolves the exact plan. Applying the approved plan creates a new
workspace revision and invalidates affected evidence; it never rewrites canonical
event history. Restore is Guarded, scoped to the workspace lease/fence, and has its
own durable effect/receipt.

Direct mode captures an owner-built checkpoint immediately before the first mutating
ToolBatch/effect of a Turn, linked by `CheckpointV1.directTurnRef`; read-only Turns do
not create one. `/rewind turn` previews restoration to that pre-write checkpoint, while
`/rewind files <paths>` is limited to the exact checkpoint-owned paths. Both produce a
`RewindPlanV1` with the requested scope, current/target digests, concurrent changes,
conflicts and evidence to stale. The normal Guard, approval, workspace fence and
receipt path still applies. Neither restores external effects or resets Thread history.

## 15.12 Failure and interruption resolution table

| Failure | Required state/behavior |
|---|---|
| Provider fails after visible content | Commit partial output as incomplete; never splice a fallback model into it |
| Provider fails before content | Retry/fallback only under pinned route, capability, reasoning and budget rules; otherwise fail visibly |
| Provider returns explicit `PROMPT_TOO_LONG` before content/acceptance | Run bounded context recovery and retry only with a new request digest/attempt ID; preserve the failed attempt and pinned route; stop visibly on circuit/exhaustion |
| Host crashes during provider request | Preserve input; outcome is `UNKNOWN_PROVIDER_ACCEPTANCE` absent authoritative terminal observation; never resend blindly |
| Crash after `EffectIntent PREPARED` | Reconcile the same EffectId and target before dispatch/retry; absent proof does not mean no effect |
| Crash after event commit before projection | Replay projection from committed owner cursor; canonical stream wins |
| Projection ahead of canonical log | Fence writes and treat projection as corruption; never promote it |
| Disk full | Use reserved control capacity for cancel/reconcile/minimal audit; stop new work before reserve exhaustion and report `DISK_PRESSURE` |
| Two Attempts contend for overlapping mutable resources | Serialize or isolate by workspace/resource lease; if overlap cannot be proven/disallowed, keep one writer and surface conflict |
| External peer cannot cancel | Request cancel; terminate only an owned containing process; retain `UNKNOWN` and fence same mutable scope if outcome is unclear |
| External peer uses hidden tools | Report internal mediation as `unknown`; disclose only observed/enforced outer workspace, process, network and credential controls |
| MCP disappears during a call | Current call gets typed failure or `UNKNOWN`; retain pinned tool identity for the Turn; mark unavailable/remove only at the next safe boundary; never rebind the name in-place |
| Credential expires | Return `NEEDS_AUTH`, stop automatic retries, and never put credential bytes in transcript or error output |
| TUI disconnects | Supervised Run continues; reconnect by snapshot + durable replay and visibly report any ephemeral output gap; `/quit` is not cancellation |

Repeated automatic retries are suppressed by the exact owner/operation/failure/relevant-state/strategy key in `RetrySuppressionKeyV1`. Only deterministic repeat failures count; transient backoff and reconciliation rules remain owner policy. Suppression is a rebuildable owner projection over existing attempt/operation history, not another retry manager. Its limit is copied from the owning pinned attempt/retry policy; if no finite bound exists, no automatic exact-repeat retry is admitted. It returns typed `RETRY_SUPPRESSED`; a new key (changed owner, operation, failure, relevant state or strategy) is evaluated independently. An operator can request an explicitly reviewed new operation only when its `RetryClass`, reconciliation and Guard requirements permit; suppression never converts `UNKNOWN` to safe-to-retry.

## 15.13 Memory retrieval, extraction and consolidation

MemoryService owns canonical memory records, candidates, extraction/consolidation job
facts and per-scope generations. Search indexes are rebuildable projections. Retrieval
filters by the caller's current principal, profile memory policy and permitted scope
before ranking; result count, content bytes and token estimate are bounded. Only current
records enter model context; stale/expired records may be shown to the authorized user
for inspection but are not returned as model context. Only after authorized structured
memory retrieval may a query perform a bounded fallback over authorized Thread ranges.
Results carry source refs, generation/freshness and advisory trust; memory cannot
authorize tools, replace current repository/effect observations or change an approved
SpecVersion.

Automatic extraction is disabled unless the explicit scoped memory policy enables it.
It reads only newly completed Thread ranges, deduplicated by range/cursor and extractor
digest, and runs in the interruptible low-priority maintenance lane. The model emits
`MemoryCandidateV1` proposals, never canonical records. Every derived candidate
requires user review before acceptance. MemoryService validates source provenance,
scope, retention, sensitivity and supersession against the pinned
`MemoryExtractionPolicyV1` before committing acceptance. Disabling extraction stops
new work but does not delete existing records.

Consolidation is a bounded, interruptible MemoryService job over one pinned scope and
source generation. Orient/gather/consolidate/prune only produce candidate proposals and
proposed supersession links. They never mark active records superseded before review.
MemoryService commits the reviewed replacement and exact reviewed supersession set in
one owner append after revalidating source generations, content/provenance digests,
scope and review receipt. Changed inputs invalidate the review and require a new proposal;
no silent rebase changes approved content. Deterministic owner-observation supersession
is a separately explicit source-backed action, never auto-acceptance of model output.
Neither path erases source records, revives tombstones or changes Guard/spec/Evidence.
