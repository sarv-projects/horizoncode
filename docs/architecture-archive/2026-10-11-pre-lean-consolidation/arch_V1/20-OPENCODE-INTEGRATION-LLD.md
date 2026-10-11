# OPENCODE INTEGRATION LLD — canonical v2 integration

> **Current repository binding (2026-10-10):** Active packages/ source and opencode/ snapshot both exist and selected provider, runner, tool and worktree files are byte-identical. Avoid introducing a second provider stack; production integration follows the actual root package layout. Existing kernel files remain real code, not hypothetical crates.

## Imported v2 architectural basis

# 10 — OpenCode-first implementation map: packages, interfaces, classes and logic

This chapter SUPERSEDES the greenfield `packages/model-providers`, `packages/agent-worker`, session portions of `studio-agent-control`, and any assumption that Rust should own AI provider SDKs in 02/03. Existing durable Rust services remain. The names below are **proposed new code**, not present in upstream.

## 10.1 Actual source topology (operative, 2026-10-11)

~~~mermaid
flowchart LR
 UI[packages/app, desktop, opencode TUI / API] --> CORE[packages/core Session/runner/tool registry]
 CORE --> LLM[packages/llm provider transport]
 CORE --> SESSION[(OpenCode canonical Session/Message/Part)]
 CORE --> IPC[packages/core SessionSupervisor + proposed managed bridge]
 IPC --> KR[kernel/src: Rust OwnerLog, protocol, IPC, Session projection]
 KR --> GUARD[PROPOSED ToolBatchControl/Guard/Effect/ExecutionHost]
 GUARD --> WORK[PROPOSED scoped execution/browser/MCP workers]
 CORE --> IDX[indexd/src: lexical-only partial]
~~~

The active repository has packages/core, packages/llm, packages/app, packages/desktop, packages/server, packages/opencode, kernel and indexd. The old greenfield Tauri apps/crates/package tree is preserved in the §36 provenance archive but is NOT a directory-creation instruction. New services should integrate into existing composition/layers unless the §09/§24 source audit justifies extraction.

## 10.2 Source-grounded service placement table

| Service/function | EXISTING SOURCE (verified) or PROPOSED PLACEMENT | Status and actual gating |
|---|---|---|
| SessionV2/Input/EventV2/provider turn | packages/core/src/session; packages/core/src/event.ts | EXISTING; keep canonical OpenCode authority |
| Whole-response local tool batch preflight | packages/core/src/session/runner/llm.ts; packages/core/src/tool/registry.ts | EXISTING, focused tests; still Bun dispatch |
| Provider/model protocol and auth | packages/llm/src, packages/opencode/src | EXISTING substrate; avoid second SDK |
| Session supervisor child/IPC client | packages/core/src/session/supervisor.ts | EXISTING bounded read-only integration; lifecycle/native Windows gates remain |
| Read-only Session projection / RPC framing | kernel/src/session_projection.rs; kernel/src/protocol.rs | EXISTING tested primitives only |
| OwnerLog and Rust-managed control | kernel/src/owner_log.rs and kernel/src | EXISTING primitives, planned Goal/Run/Guard extensions; do not claim complete |
| Repository lexical index | indexd/src | EXISTING partial in-memory; persistence/parser/LSP pending |
| Governed AgentProfile/Harness registries | PROPOSED extension in packages/core/src/horizon and matching adopted Core services | NOT WIRED; adopt existing profile/skill registries, no new provider stack |
| Built-in Horizon Docs canonical asset | packages/core/src/horizon/skills/horizon-docs/SKILL.md | FILE EXISTS; embedded runtime registration pending |
| LanguageServiceBroker | PROPOSED near existing packages/opencode/src/lsp and Core adapter boundary | NOT IMPLEMENTED; attach editor-owned LSP safely |
| Browser/DOM normalized backend | PROPOSED adapter using existing application/browser extension seams | NOT VERIFIED; do not invent packages/browser-worker |
| DelegationMailbox/Worktree scheduler | PROPOSED Rust managed control plus existing OpenCode agent tooling adapters | NOT IMPLEMENTED; no second agent loop |
| AutomationService, UiEventMux, Analytics | PROPOSED app/Core derived layers + Rust owned control as specified §37 | NOT IMPLEMENTED end-to-end |
| Rendered artifact/Mermaid viewer | PROPOSED packages/app/desktop/TUI integrated viewer, isolated render worker | NOT IMPLEMENTED as governed Horizon feature |

## 10.3 Cross-owner dependency and contract rule

OpenCode stores conversation and calls models; its complete validated tool-batch proposal crosses authenticated local IPC. Rust admits exact effect intents and dispatches only after durable PREPARED and scoped lease. Receipt/UNKNOWN is returned to Core; Core appends its own conversational tool results. No Rust-written duplicate chat transcript. Context compiler, RepoIntel, UI, analytics and automation are projections/adapters with ordinary typed actions. New services and their errors are enumerated in §37. Verify module/class placement against real imports before any new file is created.

## 10.4 Class / interface map (public contracts)

`OpenCodeBridgeHost` (`packages/opencode-bridge/src/host.ts`): `start(handshake)`, `health()`, `stop(grace)`, `createOrAttachSession(ref)`, `admitPrompt(session,prompt,idempotencyKey)`, `resumeSession(session,cursor)`, `interruptSession(session)`, `subscribeEvents(session,cursor)`, `resolveAgentProfile(profileVersion)`, `resolveModelSelection(pinned)`. Always isolate upstream SDK exceptions into versioned `BridgeError` and NEVER swallow a lost event stream.

`OpenCodeV1Adapter`/`OpenCodeV2Adapter`: same Gateway port; translate messages/parts/streaming tool calls into canonical `SessionEvent`, preserve OpenCode-native IDs; detect a feature unavailable in V2 and fall back to **selected supported adapter**, never silently move DB data. `compatibilityProbe` captures exact upstream package semver/commit and supported protocol version.

`ModelGateway`: `listProviders()`, `listModels(provider)`, `getCapabilities(provider,model)`, `probeProvider(connection)`, `inferStream(selection,history,toolCatalog,cancelToken)`, `resumeProviderContinuation(providerOpaqueMetadata)` when supported; usage record must include `{measured,estimated,unknown}`. The gateway must honor selected model and fail with `UNAVAILABLE` rather than silently choosing another.

`HarnessRegistry`: `listHarnesses()`, `getHarness(id,version)`, `validate(selection,capabilities)`, `encodeTools()`, `decodeToolCall()`, `validateToolCall()`, `formatToolResult()`, `classifyStop()`, `normalizeMalformedOutput()`. A harness is compatibility formatting and decoding, not a tool privilege bypass. Retry malformed model outputs at most configuration threshold; no false tool success.

`SessionLinkRepository`: `link(runId,taskId,attemptId,openCodeSessionId)`, `ackCursor(linkId,sequence)`, `getUnackedEvents(linkId)`, `detectGap(linkId, sequence)`, `reconcileCrossStore(linkId)`. Duplicate OpenCode events may arrive after crash: `unique(opencode_session_id, event_id)` prevents duplicate Run mutations.

`AgentTaskBridge`: `startAttempt(taskEnvelope,agentProfile)`, `injectGoalSnapshot(goalRevision,criteria,acceptedDecisions)`, `proposeToolIntent(openCodeCall)`, `emitTurnResult(outcome)`, `applySteer(userInput)`, `endAttempt(result)`. Agent messages are never counted as independently verified criteria.

`ToolBrokerBridge`: `registerToolProxy(toolId,schema)`, `requestTool(intent,executionFence)`, `awaitApproval(approvalId)`, `deliverResult(result)`, `cancelPending(toolCallId)`; never expose privileged direct Node host-tool implementation in untrusted worker. For tool implementations inseparable from legacy OpenCode, run them in OS-isolated worker with scoped mount/process permissions and record explicitly weaker guarantees.

`GoalController`: `set(objective,criteria)`, `get()`, `edit(revisionPatch)`, `pause()`, `resume()`, `clear()`, `proposeComplete(evidenceRefs)`, `reportBlocked(reason)`, `suspendBudget()`, `reconcileAfterCrash()`. All functions use optimistic revision and append status event. Mark `complete` only after verification and invariant checks; creation/restoration never drops open criteria.

`ProviderHealthRegistry`: `observe(endpoint,measurement)`, `classify(error)`, `tripBreaker(endpoint)`, `allowRequest(endpoint)`, `recordHalfOpenProbe()`, `resetAfterSuccess()`; health decisions operate on endpoint, auth profile and model, not globally. UX offers manual fallback, never automatic model routing.

`WorktreePool`: `ensureWarm(project,base,policy)`, `acquire(requirements)`, `validateIdle(tree)`, `renewLease()`, `release(tree,artifacts)`, `rebaseOrResetCleanIdle()`, `quarantine(tree)`, `planGC(dryRun)`, `sweepSafeGarbage()`; external processes and dirty user work must be inspected before reclamation.

`ParallelismAdvisor`: `computeConflicts(tasks)`, `estimateCriticalPath()`, `estimateSetupAndIntegrationCost()`, `selectParallelGroup()`, `enforceMaxActive()`. Explicit user concurrency cap overrides recommendation; absent proof of independence -> serialize shared mutable resources.

`VerificationGate`: `deriveChecks(criteria)`, `executeChecks(revision,environment)`, `readEvidence()`, `compareBaseline()`, `evaluateCriteria()`, `signRunVerdict()`. This is Rust-authoritative and cannot be issued directly by the model.

`HealingOrchestrator`: `normalizeFailure()`, `runL1()`, `runL2()`, `recordL3Candidate()`, `evaluateL4Candidate()`, `stopOrReplan()`. L1–L4 are separate configurable strategies, not one always-running LLM chain.

## 10.5 Low-overhead fast execution path

**Small safe edit:** UI→Core request→repo index scoped context→OpenCode provider turn→proposed `edit`→Rust broker checks hash/policy→stage patch→incremental parser/linter/tests→evidence→UI. Avoid mandatory large task DAG decomposition: a Run may contain ONE Task, ONE Attempt. Persist only meaningful facts; batch chat tokens in OpenCode store; do not copy token stream into Rust events byte-for-byte.

**Complex delegated work:** UI→goal/criteria→planner proposes DAG→scheduler picks independent tasks→acquire warm workspace/test lease→OpenCode child session per Attempt→effects→verifier→integration staging→final goal gate. Python/CLI agents are optional peer executors through `AgentRuntime` SPI, not used to implement the core loop again.

**Performance SLO proposals, not guaranteed measurements:** UI keystroke responsiveness p95 < 50 ms on a reference desktop; local status/event round trip p95 < 150 ms; engine startup with warm profile < 2 s excluding model startup; model first token and tokens/s measured by chosen provider and never marketed as guaranteed; index cached by file hash; worker pool min=0 idle, max user-defined; prompt preparation target p95 < 300 ms on indexed moderate repositories.

## 10.6 Integration and upstream upgrade rules

(1) Detect `OpenCodeUpstreamRevision`; (2) run provider and session differential tests; (3) regenerate protocol mappings; (4) run tool-broker security tests; (5) run crash/compaction/goal persistence tests; (6) validate migration; (7) update patch ledger + notices; (8) opt-in rollout. The Rust build must compile against our own generated contract, not OpenCode internal module paths.

### Why not simply keep OpenCode's own permission DB and add a second Rust permission engine?

That would create TWO authorities and allow inconsistent approvals. The chosen design uses Rust's permission decision as the ultimate gate for privileged effects; OpenCode permission prompts may be displayed as UI proposals but cannot authorize a tool without Rust consent. If an upstream tool cannot be securely intercepted, disable it in strict modes or place it inside an enforceable restricted sandbox; document weaker mode explicitly.

### 20.7 Source-backed whole-response dispatch barrier increment

`packages/core/src/session/runner/llm.ts` now buffers local `tool-call` events through a
provider `finish` and `step-finish`, validates every local call against the
`ToolRegistry.Materialization` pinned for that request, and begins local dispatch only if
the complete local batch validates. A stream error, cancellation, clean EOF without a
terminal event, missing step settlement, or one invalid local call dispatches zero calls;
all recorded calls receive explicit failed results. Valid calls retain the existing
concurrent settlement behavior. `packages/core/src/tool/tool.ts` and `tool/registry.ts`
expose this input-schema preflight on the materialization without changing Session SQL
or EventV2 schemas.

Focused acceptance: `session-runner.test.ts` checks delayed execution until terminal
completion, provider error after a call, missing finish, missing step settlement, and one
invalid input withholding its valid sibling; the full runner suite passed 91 tests / 296
assertions and the Core typecheck passed on 2026-10-10. This is only the host-side
collection/preflight seam. Rust ToolBatchControl admission, Guard/resource/budget
checks and Rust execution are still missing; the current Core runner still invokes Bun
`ToolRegistry.settle`, so this does not enable a governed production tool route.


---


## 10.10 2026-10-11 LLD additions for §§29–33

These are **logical service seams**. Actual package/file placement is chosen only after the §09/§24
source audit; do not create parallel packages merely because a service name appears here.

### `AgentProfileService`

```ts
interface AgentProfileService {
  resolve(profileId: string, revision?: number): Promise<AgentProfileV2>
  resolveVariant(profile: AgentProfileV2, route: ModelSelection): Promise<ResolvedAgentProfileV2>
  validate(definition: AgentProfileV2Draft): Promise<ProfileValidationReportV2>
  createRevision(expectedRevision: number | null, draft: AgentProfileV2Draft): Promise<ProfileRevisionRef>
  effectiveCapabilities(profile: ProfileRevisionRef, parent?: DelegationAuthorityRef): Promise<AgentCapabilitySnapshotV1>
  matchSpecialists(request: SpecialistMatchRequestV2): Promise<SpecialistCandidateV2[]>
}
```

Algorithm:
1. load exact profile/source/provenance;
2. select one provider/model-specific variant deterministically;
3. resolve the explicit `HarnessProfileV1` independently from provider/model;
4. intersect profile tool/path/skill/MCP/subagent rules with organization/user/project policy;
5. probe adapter/model/wire capabilities;
6. resolve required hooks/skills/tool generation;
7. reject unsupported hard requirements rather than changing provider/model;
8. hash immutable resolved definition and return capability snapshot.

### `HarnessRegistry`

```ts
interface HarnessRegistry {
  list(caller: CapabilityContext): Promise<HarnessProfileSummaryV1[]>
  inspect(id: string, revision?: number): Promise<HarnessProfileV1>
  resolve(selection: HarnessSelectionV1, model: ModelSelection): Promise<ResolvedHarnessV1>
  compileTools(resolved: ResolvedHarnessV1, capabilities: AgentCapabilitySnapshotV1): Promise<ToolProjectionV1>
  encodeTurn(resolved: ResolvedHarnessV1, input: ContextPacketV2): Promise<ModelTurnRequestV1>
  decodeTurn(resolved: ResolvedHarnessV1, response: ProviderResponseV1): Promise<ModelTurnCandidateV1>
}
```

`resolve` validates wire/API/capability compatibility only. It never switches the selected
provider/model. A recommended compatibility harness may be surfaced to the user/profile editor,
but pinning/changing it creates an explicit profile/session revision. `native-minimal` and
`bash-only` remain valid first-class choices for small/open models; all decoded effects still
become ordinary ToolIntent/ToolBatch proposals.

### `DelegationService`

```ts
interface DelegationService {
  estimate(request: SubagentRequestV2): Promise<DelegationEstimateV2>
  admit(request: SubagentRequestV2, parent: WorkerBindingRef): Promise<DelegationAdmissionV2>
  spawn(admissionId: string): Promise<WorkerBindingV1 | DirectWorkerBindingV1>
  message(childId: WorkerExecutionId, message: ArtifactRef): Promise<DeliveryReceiptV1>
  result(childId: WorkerExecutionId): Promise<SubagentReplyV2>
  cancel(childId: WorkerExecutionId): Promise<CancelReceiptV1>
}
```

`estimate` considers dependency/resource conflicts, context bytes/tokens, expected model/tool
cost where known, spawn overhead and whether a maintenance job would be cheaper. It is advisory;
admission still validates policy/budget/resources atomically.

### `SkillRegistry`

```ts
interface SkillRegistry {
  search(query: string, caller: CapabilityContext): Promise<SkillCatalogHitV2[]>
  inspect(id: string, version?: string): Promise<SkillManifestV2>
  resolveInvocation(id: string, args: unknown, caller: CapabilityContext): Promise<ResolvedSkillInvocationV2>
  loadResource(id: string, path: string, expectedDigest: Digest): Promise<ArtifactRef>
}
```

Catalog search returns only metadata. Body/resources load lazily. Script execution is handed to
the normal effect/execution path.

Horizon-owned built-ins are **embedded/bundled product assets**, not project configuration. The
canonical Horizon Docs source is
`packages/core/src/horizon/skills/horizon-docs/SKILL.md`; Core's existing embedded skill-source
mechanism is the preferred wiring seam. The repo-local
`.opencode/skills/horizon-docs/SKILL.md` remains a temporary development adapter until embedded
registration is wired and tested. User/project `.opencode` skills remain supported customization
inputs and are never confused with product ownership.

### `HookRuntime`

```ts
interface HookRuntime {
  resolve(event: string, context: HookResolutionContextV2): Promise<ResolvedHookSetV2>
  runBlocking(set: ResolvedHookSetV2, input: ArtifactRef): Promise<HookDecisionV2>
  runAdvisory(set: ResolvedHookSetV2, input: ArtifactRef): Promise<HookAdviceV2[]>
  enqueueAsync(set: ResolvedHookSetV2, input: ArtifactRef): Promise<DeliveryReceiptV1>
}
```

Blocking hooks may DENY/ASK/REWRITE_TO_SAFE only within their contract; ALLOW never overrides
Guard DENY.

### `McpRegistry`

```ts
interface McpRegistry {
  connect(profile: McpServerProfileV2): Promise<McpServerSnapshotV1>
  disconnect(serverId: string): Promise<void>
  snapshot(serverId: string): Promise<McpServerSnapshotV1>
  tools(serverId: string, generation?: string): Promise<McpToolDescriptorV2[]>
  invoke(ref: McpToolRefV2, args: unknown, effectContext: EffectContextV1): Promise<ToolObservationV2>
}
```

Secrets resolve only at transport dispatch. Reconnect/tool-list change creates a generation;
the current provider turn remains pinned.

### `ContextService`

```ts
interface ContextService {
  plan(input: ContextCompileInputV2): Promise<ContextPlanV2>
  ledger(planId: string): Promise<ContextEntryV2[]>
  tokenize(planId: string): Promise<ContextBudgetV2>
  trimPreview(planId: string): Promise<ContextMutationPreviewV2>
  prunePreview(planId: string, mode: "deterministic" | "model_assisted"): Promise<ContextMutationPreviewV2>
  compactPreview(planId: string): Promise<ContextMutationPreviewV2>
  commitMutation(previewId: string, expectedViewRevision: number): Promise<ContextViewReceiptV2>
  clear(threadId: string, expectedEpoch: number): Promise<ContextEpochReceiptV2>
  compileProviderRequest(planId: string): Promise<CompiledProviderContextV2>
}
```

`compileProviderRequest` fails if the selected route/profile/tool/context generation changed
after planning. Canonical OpenCode history is read, referenced and summarized; never rewritten
as a side effect of context pressure.

### `RepoIntelService`

```ts
interface RepoIntelService {
  ensureGeneration(workspace: WorkspaceBindingRef): Promise<RepoGenerationId>
  detect(generation: RepoGenerationId): Promise<RepoManifestV2>
  searchSymbols(query: SymbolSearchQueryV2): Promise<SymbolSearchResultV2[]>
  outline(path: string, generation: RepoGenerationId): Promise<SymbolRecordV2[]>
  readSymbol(symbolId: string, expectedGeneration?: RepoGenerationId): Promise<SymbolSourceV2>
  findReferences(symbolId: string): Promise<ReferenceEdgeV2[]>
  findDefinition(query: DefinitionQueryV2): Promise<DefinitionResultV2>
  impact(change: ChangeSetRef): Promise<ImpactReportV2>
  diagnostics(scope: DiagnosticScopeV2): Promise<DiagnosticV2[]>
  relatedTests(change: ChangeSetRef): Promise<TestTargetV2[]>
}
```

Index writes go to rebuildable Horizon cache only. Reads apply workspace/path policy before
index lookup and before returning source.

### `ToolCatalogService`

```ts
interface ToolCatalogService {
  search(query: string, context: ToolDiscoveryContextV2): Promise<ToolCatalogHitV2[]>
  descriptor(toolId: ToolId, context: ToolDiscoveryContextV2): Promise<ModelToolDescriptorV2>
  resolveGeneration(requested: ToolId[], context: ToolDiscoveryContextV2): Promise<ToolsetGenerationRef>
}
```

This allows a large product catalog without injecting every schema into every prompt.

### `ArtifactService` UI extension

```ts
interface ArtifactRenderService {
  inspect(id: ArtifactId): Promise<UiArtifactV2>
  preview(id: ArtifactId, renderer: string, options: RenderOptionsV2): Promise<ArtifactPreviewV2>
  export(id: ArtifactId, format?: string): Promise<ArtifactExportReceiptV2>
}
```

Renderers are capability-limited workers. Mermaid preview hashes source+renderer+theme and never
loads remote resources implicitly.

### `AnalyticsService`

```ts
interface AnalyticsService {
  observeInference(observation: InferenceObservationV2): Promise<void>
  observeTool(observation: ToolMetricObservationV2): Promise<void>
  observeRuntime(observation: RuntimeMetricObservationV2): Promise<void>
  query(query: AnalyticsQueryV2): Promise<AnalyticsResultV2>
  export(query: AnalyticsQueryV2, format: "csv" | "json" | "markdown"): Promise<ArtifactRef>
  enforceRetention(now: Timestamp): Promise<RetentionReceiptV2>
}
```

Observation writes are batched and cannot block provider/tool critical paths indefinitely.
Every numeric value preserves measured/estimated/unknown provenance.

### `AutomationService`

```ts
interface AutomationService {
  create(definition: AutomationV2Draft): Promise<AutomationV2>
  update(id: string, expectedRevision: number, patch: AutomationPatchV2): Promise<AutomationV2>
  nextRuns(id: string, count: number): Promise<Timestamp[]>
  trigger(id: string, cause: AutomationCauseV2): Promise<AutomationRunRefV2>
  cancelRun(runId: string): Promise<CancelReceiptV1>
  history(id: string, cursor?: string): Promise<AutomationRunSummaryV2[]>
}
```

Triggering creates an ordinary typed action invocation with the pinned policy/budget/profile
configuration. The scheduler never calls effectful handlers directly.

### `UiEventMux`

```ts
interface UiEventMux {
  subscribe(request: UiSubscriptionV2): AsyncIterable<UiStreamEventV2>
  ack(cursor: string): Promise<void>
  resnapshot(scope: UiSnapshotScopeV2): Promise<UiSnapshotV2>
}
```

Durable semantic events use replay cursors; ephemeral streaming/telemetry may be coalesced or
dropped under declared bounds. This service is a projection/transport, never a domain owner.

## 10.11 Dependency rules

```text
OpenCode Session/provider/store
        ↓ read/reference
ContextService ── RepoIntel ── ToolCatalog/Profile/Skill/MCP resolution
        ↓ compiled request
OpenCode provider turn
        ↓ complete ToolBatch proposal
Rust control/effect owners → ExecutionHost → observations/evidence
        ↓ projections
UiEventMux / Mission Control / Analytics

AutomationService → ActionDescriptor → ordinary owner/Guard/effect path
```

No arrow permits ContextService, Analytics, UI, RepoIntel, skills, hooks or MCP to mutate Goal,
effect, verification or conversation authority directly.

## 20.12 OMP source-to-existing-Horizon implementation seam (2026-10-11)

Keep packages/core, llm, opencode, tui, app, schema and kernel as actual owner roots; no cloned OMP runtime/secondary provider SDK. Detailed existing vs proposed functions/LLD and effect owner contracts are in [source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md); exact immutable source links in [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md); typed service contracts remain §37. Before a coding agent adds a new module, it MUST locate current real source functions/callers/tests, then adapt at the least intrusive seam. New UI ActionPresentation/ModelCatalog/GoalDraft/FigureBlock/ArtifactStore contracts do not exist merely because their types are documented. C4 TS+Rust fixtures and P1.3 Guard bypass denial precede effectful integrations.
