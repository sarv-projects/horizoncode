# 3. End-to-end flows

Status: normative V1 flows.

## 3.1 Startup

1. Load config/state/credential references.
2. Start/compose existing OpenCode host surfaces.
3. Start authenticated Rust kernel.
4. Negotiate version/features/incarnation.
5. Recover Rust-owned state and Session observer cursors.
6. Start derived/index/worker services lazily.
7. Expose only capabilities whose required owners/backends are ready.

## 3.2 Direct coding turn

1. User submits to OpenCode Session.
2. ContextService compiles bounded context.
3. User-selected provider/model/harness is pinned for the turn.
4. Provider streams canonical Message/Parts.
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

## 3.16 Stop

Stop when objective satisfied and verified, user cancels/pauses, required authority/secret/payment/platform decision is missing, budget is exhausted, or unsafe UNKNOWN/retry exhaustion requires review.
