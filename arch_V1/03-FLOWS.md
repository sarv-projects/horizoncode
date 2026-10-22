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
5. As each local tool call becomes structurally valid, classify read vs mutation (`DEC-V1-36`, §14.3.1).
6. **Read-class** calls in direct Sessions may execute immediately through scoped adapters + batched kernel read admission (warm IPC).
7. Provider response completes; entire batch validates; **mutation-class** calls admit through Guard/ExecutionHost (closed batch).
8. Results are recorded in OpenCode; dependent tools respect batch ordering (reads may already be in flight).
9. UI renders derived status/evidence.

No Goal required. Managed coding Attempts may disable read streaming and use strict wave admission.

**Migration parity:** steps 1–4 and 9 match OpenCode/Cursor/Claude Code direct chat; steps 5–8 add Guard only where competitors would already enforce workspace scope—reads are not artificially delayed to the end of the stream.

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

HorizonCode has two subagent entry paths. Direct Core child-Session fan-out is a V1 goal
without requiring a Goal or managed verifier. It is bounded by the authenticated profile,
parent direct-session grant, resource admission, and child limits. Managed Task fan-out remains
behind the aggregate settlement and independent-verification gate. Both paths share profile
resolution, bounded context, child lifecycle reporting and the universal Guard/ExecutionHost
effect path, but they do not share a transcript or task-state owner.

**Direct-session delegation (no Goal required):**

1. The parent Core Session selects an allowed specialist profile and creates or resumes a
   linked child Core Session through the existing Task/agent seam. Core pins the resolved
   profile/model/harness and compiles only the selected bounded context; it does not fork the
   full parent transcript by default.
2. The shared Rust worker/resource owner admits bounded child capacity and workspace/runtime
   resources. The parent grant is intersected with profile, current policy and platform
   support. Child effects still require ordinary Guard/ExecutionHost admission; child identity
   or completion text is never authority.
3. The parent may submit a message, queue input, wait for activity/completion, inspect/list the
   tree, or cancel an owned child. A queued message is consumed only at a later safe Core input
   boundary. Direct-lane `follow_up` is a supported V1 operation that requests exactly one fresh
   child turn, only after its one-use fresh-turn proof and recovery prerequisites are implemented
   and verified; until then it remains unavailable. It is not an arbitrary append or managed DAG
   operation. Delivery is bounded
   and correlated. A timeout or lost reply does not imply that the child stopped.
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

After first-use search consent, Core submits only query intent, bounded filters and authenticated
Session/tool-call correlation. HostKernel resolves and pins the trusted ordered route plan from
current consent, Settings and fixed provider profiles, beginning with the default-enabled
free-anonymous built-in cascade; BYO authenticated routes join only when the user explicitly
enables/configures them in Settings. HostKernel returns the trusted plan projection and digest to
Core; Core cannot synthesize or change provider IDs, accounts, credentials, route order, retry
policy or cost class. Grounded-model search is separate and explicit-only. Guard admits the
aggregate request against that HostKernel-pinned plan before dispatch. Record each attempted
route's order, auth/cost class, response status, retry and bounded failure; return bounded
citations/results and truthful exhaustion. An auth 4xx can advance only to another explicitly
enabled route. Do not silently enter a paid or authenticated route.

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

Managed child messages use a Core inbox separate from the direct Session inbox. Core derives the
Attempt and authority pins from HostKernel, commits the bounded payload before prepare, and
acknowledges the append with its durable inbox receipt. `queued` only persists input. Managed
`follow_up` remains unavailable until the P7 managed child prompt callback accepts the exact live
Attempt scope and inspected HostKernel receipt, including the completed-turn receipt, one-use wake
receipt and next-request sequence. At the next safe input boundary, that callback must revalidate
the current workspace revision, atomically claim the inbox row once, then persist the HostKernel
claim receipt in the Core row before advancing. A completed provider turn can advance only with
that exact `CLAIMED` receipt: `managed_context.advance` binds the new `ContextSelectionV1` request
ID and sequence to it and persists the selection in the managed OwnerLog before provider request
preparation. Provider dispatch still needs its separate route/Guard authorization. The callback
then runs the existing serialized Attempt pipeline. Consumption and HostKernel ACK must be durable
before the row becomes consumed. The consumption proof keeps the claim-time delivery scope digest
separate from the post-advance live consuming scope digest; follow_up ACK also names the exact
wake-claim receipt and next request ID/sequence. Queue ACKs carry no wake proof.
The transitions are `preparing -> approval_required/admitted -> appended -> committed ->
delivering -> consumed`, with uncertain outcomes moving to `unknown`. On restart a `delivering`
row is inspection-only and cannot be reinjected without exact owner and consumption proof. P2 owns
the managed inbox and its admission/recovery; P7 owns the managed prompt callback. This source
contract does not enable managed follow-up or establish acceptance.

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

## 3.23 Direct workspace grant and CodeMode orchestration (V1, DEC-V1-28/29)

1. The authenticated user selects sandbox scope and approval policy independently through `DirectSessionPermissionModeV1`; missing state defaults to `workspace-write` + `on-request` (Ask for approval). Normal reads, edits and supported commands inside the selected workspace proceed without repeated prompts; crossing the sandbox boundary opens a Guard challenge with the normalized action, exact resource and backend guarantees. `always` prompts before each effect; `on-request` prompts at the boundary; `never` does not prompt within the selected sandbox. Full access is `danger-full-access` + `never`, explicitly selected for the current Session, with no HorizonCode filesystem or network sandbox. All modes still use the same Guard, leases, receipts and recovery.
2. The protected Core-to-HostKernel grant route takes only grant class and bounded user-selected scope. HostKernel derives principal from out-of-body authentication and derives Session/owner epoch, registered Location/workspace/root, backend, guarantee-set and current policy digests, issue/expiry, and grant identity from trusted state. Rust persists the immutable grant and separate revocation transition in the canonical Guard/EffectHost authority journal, not managed Attempt OwnerLog. Grant issuance does not dispatch the pending effect; it is freshly prepared under current state and follows normal Guard/intent/lease/ExecutionHost/receipt lifecycle. Legacy permission state and model output cannot create or answer grants.
3. Before presenting a batch prompt, Core asks HostKernel for a non-consuming preflight over the exact authenticated scope and complete challenge set. An exact active grant makes an effect prompt-free only for action classes whose boundary passed backend acceptance; preflight returns only candidate versus prompt-required and never authorizes dispatch. The existing atomic Guard approval resolution revalidates the full set, reserves grant usage and issues one-use leases before any dispatch. Current baseline is bounded workspace read/edit; build/test/process classes are added only with their own accepted process/filesystem/network enforcement. Every complete batch still passes Guard, budget, durable intent, one-use lease and ExecutionHost. Crossing scope raises one exact batch approval; denial or lost guarantees prevents dispatch.
4. Direct CodeMode requires explicit `CodeModeEnablementV1` for the user's current Session, bound to authenticated principal/owner epoch, `codemode.execute`, fixed selector and resolved helper digest, resource-profile ID/digest, backend/guarantee and policy digests, expiry and revocation generation. This is separate from DirectSessionGrant and is not arbitrary process authority. Matching helper launches do not repeat the enablement prompt. Managed CodeMode instead requires accepted SpecVersion capability plus Task-pinned AgentProfileV2 authority, revalidated against the live Attempt; it does not accept a direct grant. After the canonical nested dispatcher and wave admission are wired, the existing interpreter runs under the existing Rust ExecutionHost and receives only the current authorized tool tree. Core dispatches each complete nested wave through SessionSupervisor ToolBatch; every call is admitted by Guard and settled by receipts before results return. One script shares a 30-second deadline, 64 KiB source/output cap, 64-call cap across up to 64 sequential waves of at most 32 each, and 1 MiB aggregate payload bound. ExecutionHost applies cgroup-v2 limits; unsupported containment means unavailable. Cancellation terminates/reaps only the supervised helper. A settled prior wave and fresh authority check are prerequisites to the next; UNKNOWN stops the script and is reconciled without replay. Revocation or Session/selector/profile/backend drift fences the next direct helper launch. §32.41 is integrated release acceptance.

Grant state and CodeMode activity are projections of their canonical persisted records; reconnect resnapshots and never re-dispatches. Direct flow has no managed Run. Managed CodeMode calls remain bound to the live Attempt. The UI choices are §16.10; event provenance is §4.16; machine shapes are §12.21 and `contracts-v2`; detailed service behavior is §37.24.
### Direct workspace grant and trusted command-profile flow (DEC-V1-28)

This is the low-friction direct coding path. A user grants exact workspace read/edit
scope and, when desired, one or more selected build/test profiles. Subsequent matching
effects still receive fresh Guard admission, EffectIntent, one-use lease, ExecutionHost
dispatch and receipt. The grant suppresses repeated dialogs only for exact active scope.
Profile resolution, argv construction and hard OS guarantees are defined in §§12.21 and
37.25–37.27. A stale/missing profile or any out-of-scope action goes to ordinary Guard
ASK/DENY before dispatch; model-provided shell text never becomes a trusted profile.

### Managed DAG delivery and aggregate settlement (DEC-V1-31)

After the accepted one-Task managed vertical proves the complete guarded Attempt and
independent-verification loop, V1 expands to bounded Rust-owned Task DAGs. Rust commits
one graph revision, derives READY only from independently verified prerequisites, and
binds each child Attempt to the exact SpecVersion, Task, profile, workspace revision,
budget and live Guard authority. Each Task is independently verified against its actual
final workspace revision; Run SUCCEEDED requires every required Task terminal-successful,
all receipts settled, no UNKNOWN, and aggregate criteria verified. Conflicting write
scopes serialize or fail admission. The current one-Task source gate remains until this
entire aggregate path passes its acceptance; it is an implementation gate, not final V1
scope. Direct Core child Sessions remain a distinct, non-managed lane.

## 3.24 Direct-session Git workspace inspection (V1, §17.31)

1. Core receives a model or user-initiated read for bounded Git facts inside the authenticated workspace.
2. Core normalizes the request to one of the fixed operations in `§14.28` and checks current `files.read` / workspace-grant scope and workspace revision pins.
3. Core calls HostKernel `GitWorkspaceReadServiceV1` (`§37.29`) with authenticated principal, Location, operation ID, bounded paths/object IDs, and deadline.
4. HostKernel validates scope, prepares Guard read admission if required by permission mode, issues a one-use lease when policy demands it, launches the fixed `git` argv template through ExecutionHost, captures bounded output, and persists receipt or artifact ref.
5. Core surfaces typed partial/truncated results to the model; replay returns the same receipt only when every pin matches. Ambiguous dispatch remains `UNKNOWN` without automatic retry.
6. Mutating Git tools (`git.commit`, branch create/switch) use separate guarded flows and are not satisfied by this read path.

