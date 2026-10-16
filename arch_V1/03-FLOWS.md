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
4. Rust starts Run and creates dependency tasks.
5. Scheduler leases resources/workspaces and dispatches bounded attempts.
6. Effects use the same Guard as direct mode.
7. Integration produces a known final revision.
8. Independent verifier checks acceptance/evidence.
9. Run becomes SUCCEEDED/FAILED/NEEDS_YOU/CANCELLED.

## 3.5 Subagent

1. Parent chooses specialist/profile because task separation is beneficial.
2. Kernel/host allocates bounded child dispatch: objective, criteria, refs, capabilities, path, budget.
3. Child works in leased scope.
4. Child returns SubagentDelivery/evidence.
5. Parent/integrator verifies and integrates; child does not mark canonical Task PASS.

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
3. Managed spec is explicitly accepted; Rust persists immutable criteria, DAG dependency edges and Attempt identities. Scheduler computes READY and reserves memory/CPU/disk/worker/worktree capacity before worker launch. A read-only helper may reuse shared headless infrastructure and must not get a new writable worktree by default.
4. Worker creates typed ToolIntent; complete batch is validated; all mutation origins pass Guard, PREPARE, one-use lease and ExecutionHost. File-touch index may warn about concurrent reads/writes but only revision/lease checks can enforce stale-write denial.
5. Stream tool activity through bounded ephemeral tool-tail and stable transcript; apply backpressure and frame coalescing without dropping effect/owner events. Attribute process-tree PSS/CPU and cost/cache/latency to the correct owner, marking unavailable metrics unknown.
6. On user file edit, collision, cancelled worker, loss of provider, resource exhaustion or kernel restart, fence the Attempt, persist UNKNOWN for potentially executed effects, reconcile from receipts/observed source, then replan/retry only safely.
7. Task outputs typed artifact refs and evidence; reviewer/critique checks coverage, dependencies unblock only on independent PASS, and integrated revision is reverified. Report true success/blocked/failed/NeedsYou and clean owned disposable workers/worktrees.
8. Optional external Session import creates a provenance-preserving **snapshot or handoff** under one chosen backend owner. It does not silently merge two live canonical transcripts.

Acceptance journeys and fault injections are §32.32; resource contract is §18.17 and exact interfaces are §37.16. No step above is implicitly CODE_PRESENT merely because documented.
