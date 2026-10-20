# 3. End-to-end flows

Status: normative V1 flows.

## 3.1 Startup

1. Load config/state/credential references.
2. Start/compose HorizonCode host surfaces derived from the pinned OpenCode base.
3. Start authenticated Rust kernel.
4. Negotiate version/features/incarnation.
5. Recover Rust-owned state and Session observer cursors.
6. Start derived/index/worker services lazily.
7. Expose only capabilities whose required owners/backends are ready.

## 3.2 Direct coding turn

1. User submits to a direct HorizonCode Session.
2. ContextService compiles bounded context.
3. User-selected provider/model/harness is pinned for the turn.
4. The configured provider transport (current OpenCode-derived host; future A-V2-27 adapter when verified) streams canonical Message/Parts.
5. Local tool calls are collected through response completion.
6. Entire batch validates.
7. Read-only calls execute through scoped adapters.
8. Effectful calls cross kernel Guard/ExecutionHost.
9. Results are recorded in OpenCode.
10. UI renders derived status/evidence.

No Goal required.

## 3.3 Effectful action

Action from UI/model/plugin/MCP/LSP/DAP/browser/desktop/REPL/automation:
1. resolve canonical capability/action and alias;
2. validate schema/scope/source generation;
3. canonicalize target;
4. check budget/cost/network/secret policy;
5. Guard decides deny/approval/admit;
6. PREPARE EffectIntent and one-use lease;
7. authorized worker executes;
8. capture target observation;
9. settle receipt or UNKNOWN;
10. attach result/evidence to owning workflow.

## 3.4 Managed goal

1. User drafts objective/criteria/budget.
2. System prepares reviewable Goal/SpecVersion without effects.
3. User accepts SpecVersion.
4. Core submits a bounded plan; Rust records the exact Run and pinned dependency Tasks in non-dispatchable `PLANNED` state, all unready.
5. User explicitly invokes authenticated `goal.start` for that planned Run and current accepted SpecVersion; planning or acceptance alone does not start execution.
6. Rust atomically transitions the complete planned Run to RUNNING and readies only dependency-root Tasks under the current Goal revision; each Task already pins its immutable `ProfileRevisionRef`.
7. Scheduler leases resources/workspaces and dispatches bounded attempts.
8. Effects use the same Guard as direct mode.
9. Integration produces a known final revision.
10. Independent verifier checks acceptance/evidence.
11. Run becomes SUCCEEDED/FAILED/NEEDS_YOU/CANCELLED.

`goal.start` authenticates the actor from the trusted request context, verifies the exact
currently accepted SpecVersion and current Goal revision, and commits the start transition
atomically in Rust OwnerLog. The request identifies the existing planned Run and accepted
SpecVersion; it cannot supply or alter Task/profile data. A repeated identical idempotency key
returns the same transition; reuse with different pins conflicts. Stale, unauthorized,
superseded, incomplete-plan, or terminal state is rejected without making any Task ready. Only dependency-satisfied Tasks become READY; downstream Tasks remain unready until predecessors settle successfully.
Starting a Run creates no effect lease: every Attempt and effect still requires its own current
admission, resource reservation, Guard decision and one-use lease.

The start request also selects the active top-level Core Session that will own the Run root link.
Core resolves that Session from durable storage and supplies its authenticated principal/Goal/
project/workspace binding, persistent source-store and project-directory source-instance IDs,
per-Session source epoch, and exact SessionSupervisor ACK cursor. HostKernel stamps the current
OwnerLog/process epoch and Rust pins the link atomically with start. A missing or ambiguous source
owner or cursor rejects start before any Task becomes ready.

The canonical `planned_run_started` OwnerLog envelope timestamp is the trusted Run start time;
exact delivery replay reuses the persisted event and timestamp. Each child Attempt reserves one
`ActiveWorkers` unit bounded by both the WorkerPool ceiling and accepted SpecVersion `maxWorkers`.
Profile `limits.wallTimeMs`, when present, and remaining SpecVersion `maxRunDurationMs` bound its
lease deadline. CPU/memory/disk/FD samples inform backpressure only unless OS enforcement is
proven. P8 selects the worktree and base locator from its durable eligible clean registrations;
HostKernel separately pins measured workspace content revision.

## 3.5 Subagent

HorizonCode has two subagent entry paths. They share profile resolution, bounded context,
resource admission, child lifecycle reporting and the universal Guard/ExecutionHost effect
path, but they do not share a transcript or task-state owner.

**Direct-session delegation (no Goal required):**

1. The parent Core Session selects an allowed specialist profile and creates or resumes a
   linked child Core Session through the existing Task/agent seam. Core pins the resolved
   profile/model/harness and compiles only the selected bounded context; it does not fork the
   full parent transcript by default.
2. The shared Rust worker/resource owner admits bounded child capacity and workspace/runtime
   resources. The parent grant is intersected with profile, current policy and platform
   support. Child effects still require ordinary Guard/ExecutionHost admission; child identity
   or completion text is never authority.
3. The parent may submit a message, queue a follow-up that triggers a child turn, wait for
   activity/completion, inspect/list the tree, or cancel an owned child. Delivery is bounded,
   correlated and consumed at a safe Core input boundary. A timeout or lost reply does not
   imply that the child stopped.
4. The child keeps its own canonical Core Session history and returns a bounded result plus
   artifact/evidence references. Core projects lifecycle/activity into the parent TUI; the
   Rust kernel does not become a second transcript store.
5. The parent may review and integrate the result. Direct-session completion is not a managed
   Task PASS or verified Goal outcome.

**Managed delegation (accepted Goal/SpecVersion):**

A managed child runs as a logical Core Session/Task/Attempt inside the existing Core process;
its claimed handoff does not launch a second model host. The immutable AgentProfileV2 selects
provider/model/harness and child policy. P8 WorkerExecution identifies durable lineage and
workspace/resource leases. Actual shell/process mutations still cross Guard and the single
ExecutionHost supervisor.

1. Rust admits a Task Attempt against the accepted immutable SpecVersion and mints the
   Attempt-bound DelegationBinding before dispatch.
2. Core resolves the Task-pinned profile and bounded context. Rust admits child capacity,
   workspace and resource leases and checks the accepted criteria, capability ceiling and
   budget. The child receives an immutable Task delivery envelope.
3. Child effects use the same Guard/ExecutionHost and one-use Attempt-bound effect leases;
   settled receipts and immutable artifacts are attached to that Attempt.
4. The child returns a typed candidate delivery. Rust—not the child—owns Task/Attempt state;
   an independent verifier checks required criteria against the actual final workspace
   revision before settlement.
5. Cancellation fences new dispatch first. Restart, missing replies, or uncertain effects are
   reconciled under the child/Attempt identity; they are never blindly replayed.

Only the managed path requires a Goal, Task, Attempt and independent verification. Both paths
have configured nesting/fan-out, context, token, deadline, disk-admission and message bounds.
CPU/memory/process-count/FD are hard limits only where the OS backend enforces them; absent
that enforcement, profiles requiring those guarantees are unavailable and monitoring or
admission is labeled only for what it actually bounds/observes. No path creates a second Core
continuation owner, Rust transcript store, or Guard bypass.

Both paths use the single lane-tagged `SubagentDeliveryV1` envelope. `direct_session`
authority binds Core's parent/child Session IDs, trusted profile revision/digest, effective
permission-scope digest and Core owner epoch. `managed_attempt` authority binds the exact
Rust `DelegationBindingV1` digest plus Goal/Run/Task/Attempt IDs and Rust owner epoch.
`authorityDigest` is domain-separated BLAKE3 over canonical MessagePack
`["SubagentDeliveryV1.authority", lane, parentExecutionId, childExecutionId, ownerEpoch,
authority]`; owners recompute it, and it never replaces authentication or live policy/Attempt
checks. See §12.11 and §37.9 for the machine contract.

For both lanes, the selected profile authority is Core Config's immutable
`AgentProfileV2` revision. In the direct lane, Core resolves a trusted profile and executes
that resolved profile's model, harness, instructions and narrowed permission scope; it pins
the exact revision/digests to the child Session and Direct Attempt before prompt dispatch.
Legacy `Agent` entries may be migration inputs or stable selector aliases to an already
materialized profile revision. They are never hashed as a substitute profile or used to
authorize a child while the runtime executes different profile values. An unresolved,
changed or unavailable profile revision denies dispatch and resume; it never silently selects
the latest profile or inherits an unpinned parent model.

## 3.6 Context pressure

1. Detect pressure with measured/estimated token data.
2. Preserve safety/spec/current-task/protected refs.
3. trim/prune/compact according to explicit semantics.
4. canonical history remains unchanged.
5. rebuild context packet and continue selected model.

No silent model switch.

## 3.7 Repository change

1. identify exact/symbol target;
2. inspect relevant source;
3. produce patch with source revision/stale guard;
4. Guard effect;
5. apply through canonical file tool;
6. diagnostics/related tests;
7. inspect diff/evidence;
8. managed mode verifies criteria.

Hashline/native editing is an implementation strategy inside the same files.patch contract.

## 3.8 LSP/DAP

LSP:
query diagnostics/symbols -> prepare versioned edit -> Guard mutation -> apply through file capability -> re-diagnose.

DAP:
start/attach Guarded session -> breakpoint/step/read variables -> optional guarded evaluate -> terminate/reconcile.

Debugger cannot bypass ExecutionHost.

## 3.9 Persistent REPL

start bounded Python/JS worker -> execute chunks preserving worker state -> bounded outputs/artifacts -> any tool callback routes through canonical action/Guard -> reset/stop or idle expiry.

## 3.10 Browser

observe tab/DOM/ARIA/screenshot -> pin generation -> validate action -> Guard mutation -> execute -> re-observe.

Stale refs cause re-observation.

## 3.11 Desktop

capture displays/windows/AX -> pin geometry/generation -> Guard input/focus/clipboard mutation -> execute -> recapture evidence.

Unsupported OS feature reports unavailable.

## 3.12 Web search

validate query/privacy -> select explicitly allowed provider route -> show auth/cost class -> request -> return bounded source-provenance results -> optional extraction with network policy.

No hidden paid fallback.

## 3.13 Artifact rendering

provider streams source text -> stable-prefix UI -> recognize SVG/Mermaid/table only when safe -> isolated bounded render -> generation check -> display derived result with source fallback.

Durable export is separate Guarded action.

## 3.14 Automation

scheduler claims occurrence -> checks live executor and action version -> dispatches canonical action under ordinary authorization -> records outcome/retry/missed policy.

## 3.15 Recovery

On crash/restart:
- recover canonical owners first;
- restore Session observer from completed ACK;
- fence stale epochs/leases;
- reconcile PREPARED/EXECUTING effects;
- re-open derived services;
- resume only safe/idempotent work;
- surface NEEDS_YOU for irreducible uncertainty.

## 3.16 Native OpenCode backend

1. User explicitly starts a native OpenCode-backed Session rather than converting a live direct Session.
2. HorizonCode version-probes and starts or attaches to the supported official OpenCode runtime.
3. OpenCode owns its native Session, provider request, native tool protocol and persistence.
4. HorizonCode records only the bounded SessionLink/event/progress/permission projection needed for UX and verification.
5. Mutating integrations exposed through HorizonCode require equivalent Guard policy; unsupported native effects are reported unavailable rather than bypassed.
6. Cancellation/restart reconnects by native Session ID and version-compatible protocol.
7. Restricted/free-model eligibility errors surface unchanged; no client spoofing or paid fallback.

## 3.17 Visual edit (post-V1)

This browser/preview-dependent journey is outside the V1 CLI/TUI scope under A-V2-31 and remains unavailable; retain it as a future acceptance flow.

1. Start a local preview through an approved process capability.
2. Capture route, DOM/ARIA, source-map and build generation.
3. User clicks/selects an element; map it to a stable visual target and source candidates with confidence.
4. User describes the desired change.
5. Agent inspects exact source and produces a focused patch.
6. Patch crosses the ordinary file Guard/ExecutionHost.
7. Rebuild/reload and re-observe the same behavior.
8. Run targeted regression checks; show diff/evidence and offer focused undo.

Pixel selection alone is never treated as guaranteed source mapping.

## 3.18 Deploy and verify (post-V1)

This hosted deployment journey is outside the V1 CLI/TUI scope under A-V2-31 and remains unavailable; retain it as a future acceptance flow.

1. Detect deployment target and required account/config without exposing secrets to the model.
2. Show provider, environment, estimated/known cost class and requested external effects.
3. User explicitly approves credential use and deployment effect.
4. Execute through an authorized deployment adapter; capture logs/artifacts.
5. Obtain the resulting URL/revision and perform bounded health plus critical-path checks.
6. Compare observable result with accepted criteria.
7. Mark deployment successful only after verification; otherwise surface failure/UNKNOWN.
8. Record rollback target and support guarded rollback.

A successful local build or upload command alone is not deployment completion.

## 3.19 Stop

Stop when objective satisfied and verified, user cancels/pauses, required authority/secret/payment/platform decision is missing, budget is exhausted, or unsafe UNKNOWN/retry exhaustion requires review.

## 3.20 Resource-aware concurrent coding journey (A-V2-30)

1. Host starts direct Session via existing Core; selected provider/model/harness stay pinned. Authenticate and attach the SessionLink; existing Linux implementation may create a per-Session Rust observer until the shared variant is proven.
2. Direct or managed task compiles only required context; symbol/file query uses scope-checked index/LSP/lexical fallback. Optional memory recall is bounded, opt-in and labeled by provenance; no automatic paid retrieval.
3. Managed spec is explicitly accepted; Rust persists immutable criteria, DAG dependency edges and Attempt identities. Scheduler computes READY and reserves configured admission capacity for memory/CPU/disk/worker/worktree before launch; this is not an OS quota. Any Attempt whose profile requires unavailable OS CPU/memory/process-count/FD enforcement is denied before spawn. A read-only helper may reuse shared headless infrastructure and must not get a new writable worktree by default.
4. Worker creates typed ToolIntent; complete batch is validated; all mutation origins pass Guard, PREPARE, one-use lease and ExecutionHost. File-touch index may warn about concurrent reads/writes but only revision/lease checks can enforce stale-write denial.
5. Stream tool activity through bounded ephemeral tool-tail and stable transcript; apply backpressure and frame coalescing without dropping effect/owner events. Attribute process-tree PSS/CPU and cost/cache/latency to the correct owner, marking unavailable metrics unknown.
6. On user file edit, collision, cancelled worker, loss of provider, resource exhaustion or kernel restart, fence the Attempt, persist UNKNOWN for potentially executed effects, reconcile from receipts/observed source, then replan/retry only safely.
7. Task outputs typed artifact refs and evidence; reviewer/critique checks coverage, dependencies unblock only on independent PASS, and integrated revision is reverified. Report true success/blocked/failed/NeedsYou and clean owned disposable workers/worktrees.
8. Optional external Session import creates a provenance-preserving **snapshot or handoff** under one chosen backend owner. It does not silently merge two live canonical transcripts.

Acceptance journeys and fault injections are §32.32; resource contract is §18.17 and exact interfaces are §37.16. No step above is implicitly CODE_PRESENT merely because documented.

## 3.21 Evidence-bound delegation and source navigation (A-V2-33)

Managed delegation extends §3.4–3.5 without creating child authority:

1. The proposal records canonical `capabilityScope` IDs in its immutable digest; a distinct authenticated reviewer sees and accepts that exact scope. Each Task declares a capability subset, and Rust rejects any Task widening. Rust admits a Task Attempt against the accepted SpecVersion, then mints the delegation binding from authenticated Run/Task/Attempt state, profile revision, the Task/spec/profile/current-Guard capability intersection, workspace/source revision, owner epoch and live budget/resource leases. These IDs form only a ceiling; each operation still requires Guard and its one-use lease.
2. Core sends only bounded context and provenance-bearing source/artifact references. The child cannot supply or widen the binding, accept criteria, choose another provider/model, or settle managed work.
3. RepoIntel references identify exact source generation, revision, file digest and byte range. They are read handles only; a patch revalidates live source and goes through canonical `files.patch` plus Guard.
4. Child completion returns bounded status, missing-criteria IDs and immutable artifact/evidence references. Rust validates child identity, receipt settlement, artifact digest/fidelity and current workspace revision before attaching evidence.
5. A distinct authenticated reviewer decides the accepted criteria; an independent verifier checks the actual current revision and source-bound artifacts. Missing, contradictory, stale or UNKNOWN evidence prevents PASS.
6. Cancellation fences new dispatch first. Restart/disconnect reconciles receipts and owner epoch; a lost child response never authorizes replay or fabricates a result.

Direct-session delegation may use the existing direct-mode contract without Goal/Attempt, but cannot settle a managed Task. Effects still require P1 Guard/ExecutionHost. Field constraints are §12.18; runtime bounds are §37.22; acceptance is §32.38.

## 3.22 Single-Attempt independent-verification lifecycle (V1)

The first managed V1 vertical contains one coding Task and one Attempt. Keep that Attempt live/EXECUTING while independent verification runs; do not settle it before verification or create an unplanned synthetic verifier Task.

1. The accepted SpecVersion and Task are durably admitted. Each coding or verifier process operation receives its own Attempt-bound EffectIntent and one-use lease from Rust. Verifier profile, executable, criteria, arguments and workspace come from trusted owners, never the request body.
2. A Guarded coding action runs and its receipt is durably attached to the still-live Attempt. The immutable Attempt/delegation source revision is the admission base; each successful coding receipt advances a HostKernel-derived revision head only when its before digest equals the prior head and its after digest is freshly observed. Mutating effects in this V1 Attempt are serialized. The aggregate OwnerLog revision fences the request separately from each edge's immutable bound revision.
3. The independent verifier is separately authorized as a read-only effect under the same Attempt and current chain head, through the common Guard, ExecutionHost and OS-confinement path. Its settled receipt must prove before and after equal that head. HostKernel captures verifier output and immutable artifacts only after observed process exit and receipt settlement, then freshly observes that same workspace revision before typed evidence append. A changed revision invalidates the evidence; failed/UNKNOWN/missing/out-of-order receipts and human edits outside the chain fence dispatch, with no caller-supplied rebase.
4. Only after required evidence is persisted may Rust settle the Attempt, Task and Run. Verifier failure yields a non-success outcome; missing, partial, contradictory or stale evidence cannot produce PASS.
5. Before dispatch, denial leaves no effect. After a possible dispatch, cancellation, crash, lost receipt, owner-epoch change, partial capture or unavailable reconciliation persists UNKNOWN and fences replay. Recovery reconciles the same effect identity and never relaunches it automatically.

The verifier's durable immutable intent (Attempt edge, trusted profile/executable, criterion, arguments and current chain head) is written before Guard issues its one-use lease. Refresh the aggregate managed revision after that append. The lease is bound to the exact Attempt edge and immutable intent digest; its digest is recorded in the HostKernel-authenticated settled receipt, not written back into the managed log before dispatch. Guard approval uses the distinct authenticated reviewer principal, while the supervised process uses the trusted verifier profile principal. Revision/workspace changes while approval is pending invalidate the authorization.

The verifier EffectIntent has its own bounded Attempt edge and lease; the coding receipt, reviewer decision, challenge digest and Attempt binding alone do not authorize it. This reuses canonical managed, effect and evidence stores; it adds no event bus, worker runtime or public verification authority. Typed records and transitions are owned by §§12.19 and 37.22; acceptance is VEO-001, VEO-002, VEO-012 and the managed lifecycle cases in §32.
