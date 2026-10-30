import { afterAll, describe, expect } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  TransportReason,
  InvalidRequestReason,
  type LLMClientShape,
  type LLMRequest,
} from "@horizoncode/llm"
import * as OpenAIChat from "@horizoncode/llm/protocols/openai-chat"
import { Database } from "@horizoncode/core/database/database"
import { makeLocationNode } from "@horizoncode/core/effect/app-node"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { EventV2 } from "@horizoncode/core/event"
import { PermissionV2 } from "@horizoncode/core/permission"
import { EventTable } from "@horizoncode/core/event/sql"
import { Project } from "@horizoncode/core/project"
import { ProjectTable } from "@horizoncode/core/project/sql"
import { QuestionV2 } from "@horizoncode/core/question"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SessionV2 } from "@horizoncode/core/session"
import { Snapshot } from "@horizoncode/core/snapshot"
import { ContextSnapshotDecodeError } from "@horizoncode/core/session/error"
import { SessionEvent } from "@horizoncode/core/session/event"
import { SessionInput } from "@horizoncode/core/session/input"
import { SessionMessage } from "@horizoncode/core/session/message"
import { Prompt } from "@horizoncode/core/session/prompt"
import { SessionProjector } from "@horizoncode/core/session/projector"
import { SessionExecution } from "@horizoncode/core/session/execution"
import { SessionRunCoordinator } from "@horizoncode/core/session/run-coordinator"
import { SessionRunner } from "@horizoncode/core/session/runner"
import * as SessionRunnerLLM from "@horizoncode/core/session/runner/llm"
import { SessionRunnerModel } from "@horizoncode/core/session/runner/model"
import { SessionSupervisor, SessionSupervisorError, type Interface as SessionSupervisorInterface } from "@horizoncode/core/session/supervisor"
import type { EffectAdmission, GuardedToolCall } from "@horizoncode/core/session/supervisor"
import { sameTrustedPrincipal, TrustedPrincipalContext, type TrustedPrincipal } from "@horizoncode/core/trusted-principal"
import { ToolRegistry } from "@horizoncode/core/tool/registry"
import { ApplicationTools } from "@horizoncode/core/tool/application-tools"
import { AgentV2 } from "@horizoncode/core/agent"
import type * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import { Config } from "@horizoncode/core/config"
import { ConfigCompaction } from "@horizoncode/core/config/compaction"
import { Tool } from "@horizoncode/core/tool/tool"
import { WriteTool } from "@horizoncode/core/tool/write"
import {
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@horizoncode/core/session/sql"
import { DirectProviderRequestTable } from "@horizoncode/core/session/sql"
import { SessionStore } from "@horizoncode/core/session/store"
import { SystemContext } from "@horizoncode/core/system-context"
import { SystemContextRegistry } from "@horizoncode/core/system-context/registry"
import { SkillGuidance } from "@horizoncode/core/skill/guidance"
import { ReferenceGuidance } from "@horizoncode/core/reference/guidance"
import { ModelV2 } from "@horizoncode/core/model"
import { Location } from "@horizoncode/core/location"
import { ProviderV2 } from "@horizoncode/core/provider"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
// Trusted catalog route projection consumed by the runner's direct-provider
// admission. The mock transport pins and dispatches through the real journal
// exactly like P6's pinned provider fetch: PINNED -> DISPATCHING, and EventV2
// Step.Ended settlement commits SETTLED in the same transaction.
const directRoute = {
  routeID: `llm_${"a".repeat(64)}`,
  routeRevision: `llm_${"a".repeat(64)}`,
  endpointRevision: `blake3:${"e".repeat(64)}`,
  endpointBase: "https://api.opencode.ai/v1",
}
const transportRequestDigest = `blake3:${"b".repeat(64)}`
const journalDispatches: string[] = []
// Test-only adversarial pins for the direct-provider fail-closed journeys.
let pinEndpointOverride: string | undefined
let profileModelOverride: { readonly providerId: string; readonly modelId: string } | undefined
type MockExecutorContext = {
  readonly directContext: {
    readonly pin: (input: {
      readonly endpointRevision: string
      readonly transportRequestDigest: string
    }) => Effect.Effect<{
      readonly beginDispatch: () => Effect.Effect<{
        readonly state: "DISPATCHING"
        readonly pinDigest: string
        readonly transportRequestDigest: string
      }>
    }>
  }
}
const dispatchJournal = (executorContext?: MockExecutorContext) =>
  executorContext?.directContext
    ? executorContext.directContext
        .pin({ endpointRevision: pinEndpointOverride ?? directRoute.endpointRevision, transportRequestDigest })
        .pipe(
          Effect.flatMap((binding) => binding.beginDispatch()),
          Effect.tap((dispatch) =>
            Effect.sync(() => {
              journalDispatches.push("dispatched")
              return dispatch
            }),
          ),
        )
    : Effect.void
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest, executorContext?: MockExecutorContext) => {
      requests.push(request)
      let events: Stream.Stream<LLMEvent, LLMError>
      // Journal the direct request exactly like P6's pinned provider fetch for
      // every real scripted provider response. A scripted transport failure or
      // an empty no-op response models a pre-dispatch local failure, which
      // never reaches the durable DISPATCHING transition.
      let shouldDispatch = false
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        events = stream
        shouldDispatch = true
      } else if (streamFailure) {
        events = Stream.fail(streamFailure)
      } else {
        const scripted = responses === undefined ? response : (responses.shift() ?? [])
        events = Stream.fromIterable(scripted)
        shouldDispatch = scripted.length > 0
      }
      if (streamGate) {
        const gated = events
        events = Stream.unwrap(
          (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
            Effect.andThen(Deferred.await(streamGate)),
            Effect.as(gated),
          ),
        )
      }
      return shouldDispatch ? Stream.unwrap(dispatchJournal(executorContext).pipe(Effect.as(events))) : events
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
const authorizations: Tool.Context[] = []
const executions: string[] = []
const effectBatches: GuardedToolCall[][] = []
const effectTurnContextDigests: string[] = []
let writeExecutionCalls = 0
let writePermissionAllowed = false
let preparedEffectAdmission: EffectAdmission | undefined
const writeExecutions: Array<{ readonly content: string; readonly effectID: string }> = []
const effectExecutionOrder: string[] = []
let rustEffectHostUnavailable = false
const defaultPermissionPolicyDigest = `sha256:${"0".repeat(64)}`
let permissionPolicyDigest = defaultPermissionPolicyDigest
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => (writePermissionAllowed ? Effect.void : Effect.die("unused")),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    policySnapshotDigest: () => Effect.succeed(permissionPolicyDigest),
  }),
)
const defaultPermissionScopeDigest = `blake3:${"1".repeat(64)}`
const supervisor = Layer.succeed(
  SessionSupervisor.Service,
  SessionSupervisor.Service.of({
    open: () => Effect.die("unused"),
    openForSession: () => Effect.succeed({ status: "unavailable", reason: "unused" }),
    // HostKernel-authored direct permission-mode provenance. The direct
    // provider authority resolver (opencode LLM) requires the authenticated
    // ServerAuth principal carried by the runner context and this exact
    // host-derived snapshot; it must never fall back to a default posture.
    directSessionPermissionModeSnapshot: (input: { readonly sessionID: string; readonly locationRef: unknown }) =>
      Effect.succeed({
        schemaVersion: 1 as const,
        sessionId: input.sessionID,
        ownerEpoch: "1",
        locationId: "loc_direct",
        workspaceId: "wrk_runner_test",
        workspaceRootDigest: `blake3:${"a".repeat(64)}`,
        executionBackendId: "horizon.host",
        policyDigest: permissionPolicyDigest,
        sandboxMode: "read-only" as const,
        approvalPolicy: "on-request" as const,
        source: "default" as const,
        revision: "1",
        digest: defaultPermissionScopeDigest,
      }),
    directProviderPermissionScope: (input: { readonly sessionID: string }) =>
      Effect.succeed({
        sessionID: input.sessionID,
        locationID: "loc_direct",
        ownerEpoch: "1",
        permissionScopeDigest: defaultPermissionScopeDigest,
        policyDigest: permissionPolicyDigest,
      }),
    prepareToolBatch: (input: { readonly calls: ReadonlyArray<GuardedToolCall>; readonly turnContextDigest: string }) =>
      Effect.sync(() => {
        effectBatches.push([...input.calls])
        effectTurnContextDigests.push(input.turnContextDigest)
        effectExecutionOrder.push(`prepare:${input.calls.length}`)
      }).pipe(
        Effect.andThen(() =>
          rustEffectHostUnavailable
            ? Effect.fail(
                new SessionSupervisorError({
                  stage: "effect",
                  reason: "no active Rust effect owner",
                  hostCode: "effect_unavailable",
                }),
              )
            : Effect.succeed(preparedEffectAdmission ?? { status: "denied" as const, reason: "denied by test Guard" }),
        ),
      ),
    replyGuardApproval: () => Effect.die("unused"),
    awaitManagedVerifierApprovals: () => Effect.die("unused"),
    executePatch: () => Effect.die("unused"),
    runPatch: () => Effect.die("unused"),
    executeWrite: (input: { readonly lease: { readonly effectID: string }; readonly content: string }) =>
      Effect.sync(() => {
        writeExecutionCalls++
        const admission = preparedEffectAdmission
        if (admission?.status !== "prepared_batch") throw new Error("unexpected Rust write execution")
        const member = admission.calls.find((entry) => entry.lease?.effectID === input.lease.effectID)
        const call = effectBatches.at(-1)?.find((entry) => entry.callID === member?.callID)
        const args = call?.arguments
        if (!member || !call || typeof args !== "object" || args === null || !("path" in args) || typeof args.path !== "string") {
          throw new Error("write lease did not match a prepared batch member")
        }
        effectExecutionOrder.push(`execute:${member.callID}`)
        writeExecutions.push({ content: input.content, effectID: input.lease.effectID })
        return {
          effectID: input.lease.effectID,
          receiptDigest: `blake3:${"f".repeat(64)}`,
          target: path.resolve(locationDirectory, args.path),
          resource: args.path,
          existed: false,
        }
      }),
    registerHostLocation: () => Effect.die("unused"),
    prepareUserEffect: () => Effect.die("unused"),
    requestHostKernel: () => Effect.die("unused"),
    hostOwnerEpoch: () => Effect.die("unused"),
    subscribeHostKernelEvents: () => Stream.empty,
    watchSession: () => Effect.void,
    // The runner exercises only the members implemented above; every other
    // supervisor operation is a hard test failure if unexpectedly reached.
  } as unknown as SessionSupervisorInterface),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        capability: { id: "test.echo", effectClass: "read_only" },
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        capability: { id: "test.defect", effectClass: "read_only" },
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.die("unexpected tool defect"),
      }),
    }),
  ),
)
const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [ToolRegistry.node] })
let modelResolveHook = Effect.void
let currentModel = model
let resolvedModelForProfile = model
const resolveModel = (session: { readonly model?: { readonly id: string } | undefined }) =>
  session.model?.id === "replacement" ? replacementModel : currentModel
const models = Layer.succeed(
  SessionRunnerModel.Service,
  SessionRunnerModel.Service.of({
    resolve: (session) => modelResolveHook.pipe(Effect.as(resolveModel(session))),
    resolveSelection: (session) =>
      modelResolveHook.pipe(
        Effect.map(() => {
          const resolved = resolveModel(session)
          resolvedModelForProfile = resolved
          return {
            model: resolved,
            directProviderRoute: {
              providerID: resolved.provider,
              modelID: resolved.id,
              ...directRoute,
            },
          }
        }),
      ),
  }),
)
// The runner admits direct provider requests only through the trusted primary
// AgentProfileV2 pin; the profile tracks the exact catalog-selected model.
const runnerProfile = () =>
  ({
    schemaVersion: 2,
    profileId: "user.runner",
  revision: 1,
  name: "Runner",
  description: "Runner test profile",
  source: "user",
  roles: ["main"],
  purpose: "Exercise the runner",
  whenToUse: "In tests",
  whenNotToUse: "Never",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: profileModelOverride ?? { providerId: resolvedModelForProfile.provider, modelId: resolvedModelForProfile.id },
  harness: "native-minimal",
  reasoning: "low",
  variants: [],
  instructions: { extraRefs: [], maxCompiledTokens: 4096 },
  tools: [],
  allowedSkillIds: [],
  deniedSkillIds: [],
  allowedMcpServers: [],
  allowedMcpToolPatterns: [],
  allowedSubagentIds: [],
  deniedSubagentIds: [],
  pathRules: [],
  context: { isolation: "fresh", allowImages: false, allowDocuments: false, allowArtifacts: false },
  inputMode: "read_only",
  memoryPolicy: "none",
  isolation: "read_only",
  lifecycleHooks: [],
  capabilityCeiling: [],
  limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 1, maxPendingMessages: 1, maxMessageBytes: 4096 },
  maxParallelChildren: 1,
  enabled: true,
}) as unknown as AgentProfileV2.AgentProfileDefinitionV2
const agentProfiles = Layer.succeed(
  Config.AgentProfileService,
  Config.AgentProfileService.of({
    agentProfiles: () => Effect.die("unused"),
    agentProfileSelectors: () => Effect.die("unused"),
    agentProfile: () => Effect.die("unused"),
    agentProfileSelector: () => Effect.die("unused"),
    primaryAgentProfile: () => Effect.sync(runnerProfile),
  }),
)
const systemContextKey = SystemContext.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (systemUnavailable ? SystemContext.unavailable : systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    trustedGitExecutable: () => Effect.succeed(undefined),
    workspaceCommandProfiles: () => Effect.die("unused"),
    workspaceCommandProfile: () => Effect.die("unused"),
    turnSnapshot: () =>
      Effect.sync(() => {
        try {
          return Config.parseTurnSnapshot(readFileSync(path.join(locationDirectory, "config.json"), "utf8"))
        } catch {
          return {}
        }
      }),
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  } as unknown as Config.Interface),
)
const locationDirectory = mkdtempSync(path.join(tmpdir(), "horizoncode-session-runner-"))
afterAll(() => rmSync(locationDirectory, { recursive: true, force: true }))
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionSupervisor.node, supervisor],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make(locationDirectory) })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
  [Config.agentProfileNode, agentProfiles],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError, TrustedPrincipal>({
      sameAuthority: sameTrustedPrincipal,
      drain: (sessionID, force, principal) =>
        sessionRunner.run({ sessionID, force }).pipe(
          Effect.provideService(TrustedPrincipalContext, { principal }),
        ),
    })
    const rejectStaleOwner = () => new SessionSupervisorError({ stage: "authorization", reason: "Session execution owner changed" })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: (sessionID, principal) => coordinator.run(sessionID, principal).pipe(
        Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(rejectStaleOwner())),
      ),
      wake: (sessionID, principal) => coordinator.wake(sessionID, principal).pipe(
        Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(rejectStaleOwner())),
      ),
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      WriteTool.node,
      echoNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionSupervisor.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SessionSupervisor.node, supervisor],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make(locationDirectory) })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      [Config.agentProfileNode, agentProfiles],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_test")
const otherSessionID = SessionV2.ID.make("ses_runner_other")
const sessionTestPrincipal: TrustedPrincipal = { kind: "server_auth", subject: "core-test-user" }
const rustProbe = path.resolve(import.meta.dir, "../../../kernel/target/debug/session_sync_probe")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: locationDirectory,
        title: "test",
        version: "test",
        // Direct provider requests are bound to the authenticated Session owner;
        // the fixture must carry the exact server_auth principal the runner context provides.
        metadata: { horizonPrincipalOwner: { kind: "server_auth", subject: sessionTestPrincipal.subject } },
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  response = []
  rmSync(path.join(locationDirectory, "config.json"), { force: true })
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  currentModel = model
  pinEndpointOverride = undefined
  profileModelOverride = undefined
  journalDispatches.length = 0
  skillBaselines.clear()
  effectBatches.length = 0
  effectTurnContextDigests.length = 0
  writeExecutionCalls = 0
  writePermissionAllowed = false
  preparedEffectAdmission = undefined
  writeExecutions.length = 0
  effectExecutionOrder.length = 0
  permissionPolicyDigest = defaultPermissionPolicyDigest
  rustEffectHostUnavailable = false
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(locationDirectory), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: Prompt.make({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  return session
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    response = fixture.completeEvents

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    const streamed = Array.from(yield* Fiber.join(live)) as Array<{
      data: { assistantMessageID?: string; sequence?: number; sourceGeneration?: string }
    }>
    expect(streamed).toHaveLength(32)
    const expectedSequences: number[] = []
    const expectedOffsets: number[] = []
    let sequence = 0
    let offset = 0
    for (const chunk of chunks) {
      expectedSequences.push(sequence)
      expectedOffsets.push(offset)
      sequence += 1
      offset += chunk.length
    }
    expect(streamed.map((event) => event.data.sequence)).toEqual(expectedSequences)
    expect((streamed as Array<{ data: { offset?: number } }>).map((event) => event.data.offset)).toEqual(expectedOffsets)
    expect((streamed as Array<{ data: { sourceGeneration?: string } }>).map((event) => event.data.sourceGeneration)).toEqual(
      Array.from({ length: streamed.length }, () => streamed[0]!.data.sourceGeneration),
    )
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Fail after ${kind}`
    const id = fragmentID(kind, "partial")
    const fixture = fragmentFixture(kind, id, ["Partial"])
    const expectedContent =
      kind === "tool input"
        ? {
            type: "tool",
            id,
            state: {
              status: "error",
              error: { type: "unknown", message: "Provider did not return a complete tool batch" },
            },
          }
        : fixture.expectedContent
    const failure = providerUnavailable()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [expectedContent],
      },
    ])
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider turn interrupted" },
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

describe("SessionRunnerLLM", () => {
  it.effect("advertises and executes a globally attached application tool", () =>
    Effect.gen(function* () {
      yield* setup
      const applicationTools = yield* ApplicationTools.Service
      const session = yield* SessionV2.Service
      const contexts: Tool.Context[] = []
      yield* applicationTools.register({
        application_context: Tool.make({
          capability: { id: "test.application-context", effectClass: "read_only" },
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use application context" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
      expect(contexts).toEqual([
        expect.objectContaining({
          sessionID,
          agent: AgentV2.ID.make("build"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-application",
          trustedPrincipal: { kind: "server_auth", subject: "core-test-user" },
        }),
      ])
      const projected = yield* session.context(sessionID)
      expect(projected).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-application",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
      const projectedAssistant = projected[1]
      if (projectedAssistant?.type !== "assistant") throw new Error("expected projected assistant")
      expect(projectedAssistant.cost).toBeUndefined()
      expect(projectedAssistant.tokens).toBeUndefined()
    }),
  )

  it.effect("denies the entire ToolBatch before settling any sibling when Rust Guard rejects it", () =>
    Effect.gen(function* () {
      yield* setup
      // Model the eligible first-party WriteTool registration; this test targets
      // HostKernel's explicit denial after complete batch admission, not the
      // separate registry policy that withholds unapproved write tools.
      writePermissionAllowed = true
      executions.length = 0
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Write and echo" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-write", name: "write", input: { path: "denied.txt", content: "blocked" } }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "sibling" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(effectBatches).toEqual([
        [
          { callID: "call-write", capabilityID: "files.write", arguments: { path: "denied.txt", content: "blocked" } },
          { callID: "call-echo", capabilityID: "test.echo", arguments: { text: "sibling" } },
        ],
      ])
      expect(writeExecutionCalls).toBe(0)
      expect(executions).toEqual([])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Write and echo" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-write", state: { status: "error", error: { message: "denied by test Guard" } } },
            { type: "tool", id: "call-echo", state: { status: "error", error: { message: "denied by test Guard" } } },
          ],
        },
      ])

      const initialDigest = effectTurnContextDigests[0]
      expect(initialDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      permissionPolicyDigest = `sha256:${"1".repeat(64)}`
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Write and echo again" }),
        resume: false,
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-write-again",
            name: "write",
            input: { path: "denied-again.txt", content: "blocked again" },
          }),
          LLMEvent.toolCall({ id: "call-echo-again", name: "echo", input: { text: "sibling again" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]
      yield* session.resume(sessionID)
      expect(effectTurnContextDigests).toHaveLength(2)
      expect(effectTurnContextDigests[1]).not.toBe(initialDigest)
    }),
  )
  it.effect("settles each member of a prepared multi-write ToolBatch with its own call-bound lease", () =>
    Effect.gen(function* () {
      yield* setup
      writePermissionAllowed = true
      preparedEffectAdmission = {
        status: "prepared_batch",
        // Deliberately reverse the host order: Core must bind leases by call ID, not array position.
        calls: [
          {
            callID: "call-write-second",
            capabilityID: "files.write",
            lease: { effectID: "effect-second", capabilityLeaseDigest: `blake3:${"b".repeat(64)}` },
          },
          {
            callID: "call-write-first",
            capabilityID: "files.write",
            lease: { effectID: "effect-first", capabilityLeaseDigest: `blake3:${"a".repeat(64)}` },
          },
        ],
      }
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Write two files" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-write-first",
            name: "write",
            input: { path: "first.txt", content: "first" },
          }),
          LLMEvent.toolCall({
            id: "call-write-second",
            name: "write",
            input: { path: "second.txt", content: "second" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(effectBatches).toHaveLength(1)
      expect(effectBatches[0]?.map((call) => call.callID)).toEqual(["call-write-first", "call-write-second"])
      expect(writeExecutionCalls).toBe(2)
      expect(writeExecutions).toHaveLength(2)
      expect(writeExecutions).toContainEqual({ content: "first", effectID: "effect-first" })
      expect(writeExecutions).toContainEqual({ content: "second", effectID: "effect-second" })
      expect(new Set(writeExecutions.map((entry) => entry.effectID)).size).toBe(2)
      expect(effectExecutionOrder[0]).toBe("prepare:2")
      expect(effectExecutionOrder.slice(1).sort()).toEqual(["execute:call-write-first", "execute:call-write-second"])
    }),
  )
  it.effect("denies a mismatched prepared ToolBatch before settling any member", () =>
    Effect.gen(function* () {
      yield* setup
      writePermissionAllowed = true
      preparedEffectAdmission = {
        status: "prepared_batch",
        calls: [
          {
            callID: "call-write-first",
            capabilityID: "files.write",
            lease: { effectID: "effect-first", capabilityLeaseDigest: `blake3:${"a".repeat(64)}` },
          },
          {
            // The provider's second call cannot inherit the first call's lease.
            callID: "call-write-first",
            capabilityID: "files.write",
            lease: { effectID: "effect-second", capabilityLeaseDigest: `blake3:${"b".repeat(64)}` },
          },
        ],
      }
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Write with a malformed Guard response" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-write-first",
            name: "write",
            input: { path: "first.txt", content: "first" },
          }),
          LLMEvent.toolCall({
            id: "call-write-second",
            name: "write",
            input: { path: "second.txt", content: "second" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(effectBatches).toHaveLength(1)
      expect(writeExecutionCalls).toBe(0)
      expect(effectExecutionOrder).toEqual(["prepare:2"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Write with a malformed Guard response" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-write-first",
              state: { status: "error", error: { message: expect.stringContaining("mismatched prepared ToolBatch") } },
            },
            {
              type: "tool",
              id: "call-write-second",
              state: { status: "error", error: { message: expect.stringContaining("mismatched prepared ToolBatch") } },
            },
          ],
        },
      ])
    }),
  )
  it.effect("denies the complete batch when Rust effect preparation is unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      // Keep the first-party write registration available so this fixture reaches
      // the missing Rust effect owner and verifies whole-batch fail-closed behavior.
      writePermissionAllowed = true
      executions.length = 0
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Write and echo while Rust is unavailable" }),
        resume: false,
      })
      rustEffectHostUnavailable = true
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-write-offline",
            name: "write",
            input: { path: "offline.txt", content: "must not be written" },
          }),
          LLMEvent.toolCall({
            id: "call-echo-offline",
            name: "echo",
            input: { text: "must not run" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(effectBatches).toHaveLength(1)
      expect(effectBatches[0]).toHaveLength(2)
      expect(writeExecutionCalls).toBe(0)
      expect(executions).toEqual([])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Write and echo while Rust is unavailable" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-write-offline",
              state: {
                status: "error",
                error: { message: "effect_unavailable: no active Rust effect owner" },
              },
            },
            {
              type: "tool",
              id: "call-echo-offline",
              state: {
                status: "error",
                error: { message: "effect_unavailable: no active Rust effect owner" },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("starts a real runner turn after default prompt recording", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []

      const message = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run automatically" }) })

      expect(requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
    }),
  )

  it.effect("binds the resolved context compile policy into the published ledger", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = fragmentFixture("text", "text-compile-policy", ["policy"]).completeEvents

      // ContextLedger is an in-process (non-durable) projection: it reaches
      // live subscribers only, never the durable EventTable rows.
      const live = yield* events
        .subscribe(SessionEvent.ContextLedger)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Compile policy probe" }), resume: false })
      yield* session.resume(sessionID)

      const collected = Array.from(yield* Fiber.join(live))
      expect(collected).toHaveLength(1)
      const payload = collected[0]!
      const data: Record<string, unknown> = payload.data
      if (typeof data.ledger !== "object" || data.ledger === null || !("compilePolicy" in data.ledger)) {
        throw new Error("context ledger is missing its compilePolicy binding")
      }
      const policyRaw: unknown = data.ledger.compilePolicy
      if (typeof policyRaw !== "object" || policyRaw === null ||
        !("schemaVersion" in policyRaw) || !("requested" in policyRaw) || !("prefixCacheSupport" in policyRaw)) {
        throw new Error("context compile policy is missing required fields")
      }
      const policy = policyRaw as Record<string, unknown>
      expect(policy.schemaVersion).toBe(1)
      expect(policy.requested).toBe("auto")
      // The route prefix-cache capability producer is P6-owned and has not
      // landed; the runner must fail closed to `unknown` instead of guessing.
      expect(policy.prefixCacheSupport).toBe("unknown")
      // §30.26 catalog provenance is *advisory*: it must never become a
      // blocking prerequisite of a direct turn, and it must never resolve a
      // cache tier on its own. With no authenticated catalog row bound to this
      // route the runner pins the contract's fail-closed provenance, so
      // `catalog_hint` stays ineligible and the effective tier stays
      // `minimize_tokens`.
      const hints = policy.catalogHints as Record<string, unknown> | undefined
      if (typeof hints !== "object" || hints === null) throw new Error("context compile policy is missing its catalog hints")
      expect(hints.catalogSource).toBe("unavailable")
      expect(hints.catalogFreshness).toBe("unknown")
      expect(policy.effective).toBe("minimize_tokens")
      expect(policy.resolvedFrom).toBe("conservative_default")
    }),
  )

  it.effect("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["write", "echo", "defect"])
      expect(requests[0]?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
    }),
  )

  it.effect("retries the first provider turn after system context becomes available", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }) })

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("fails gracefully when a stored context snapshot cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      yield* db
        .update(SessionContextEpochTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Build agent instructions", "Initial context"])
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("updates selected-agent skill guidance after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nBuild skills"],
        ["Initial context\n\nBuild skills"],
      ])
      expect(systemTexts(requests[1]!)).toContainEqual(expect.stringContaining("Reviewer skills"))
    }),
  )

  it.effect("keeps the sampled agent when selection changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nBuild skills"],
      ])
    }),
  )

  it.effect("keeps the sampled model when selection changes during model resolution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([model])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([["Initial context"]])
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemRemoved = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("keeps the baseline and chronological System updates after a model switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
        ["Initial context"],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[2]?.messages.filter((message) => message.role === "system")).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "user",
        "system",
        "model-switched",
        "user",
        "system",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(6)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fourth" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves the baseline while context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
        ["Initial context"],
      ])
    }),
  )

  it.effect("rebuilds the baseline directly after completed compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Replacement context"],
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.http?.headers)).toEqual([
        {
          "x-opencode-session-id": sessionID,
          "x-session-affinity": sessionID,
          "X-Session-Id": sessionID,
        },
        {
          "x-opencode-session-id": sessionID,
          "x-session-affinity": sessionID,
          "X-Session-Id": sessionID,
        },
      ])
      expect(userTexts(requests[0])[0]).toContain("## Objective")
      expect(userTexts(requests[1])).toHaveLength(1)
      expect(userTexts(requests[1])[0]).toContain("<summary>\n## Objective\n- Preserve the task\n</summary>")
      expect(userTexts(requests[1])[0]).toContain(`[User]: ${"Recent exact request ".repeat(180)}`)

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the task",
      })

      requests.length = 0
      executions.length = 0
      responses = [
        fragmentFixture("text", "text-summary-2", ["## Objective\n- Preserve the updated task"]).completeEvents,
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain(
        "<prior-summary>\n## Objective\n- Preserve the task\n</prior-summary>",
      )
      expect(userTexts(requests[0])[0]).toContain("Recent exact request")
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the updated task",
      })

      const { db } = yield* Database.Service
      const sourceEvents = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      const projectionDirectory = mkdtempSync(path.join(tmpdir(), "hc-compaction-projection-"))
      const sourcePath = path.join(projectionDirectory, "opencode-events.db")
      const projectionPath = path.join(projectionDirectory, "session-projection.db")
      try {
        const source = new SQLite(sourcePath)
        try {
          source.exec(
            "CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(aggregate_id, seq))",
          )
          const insert = source.prepare("INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?,?,?,?,?)")
          for (const event of sourceEvents) {
            insert.run(event.id, event.aggregate_id, event.seq, event.type, JSON.stringify(event.data))
          }
        } finally {
          source.close()
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const child = Bun.spawn([rustProbe, sourcePath, projectionPath, sessionID], {
            stdout: "ignore",
            stderr: "pipe",
          })
          const exitCode = yield* Effect.promise(() => child.exited)
          const stderr = yield* Effect.promise(() => new Response(child.stderr).text())
          expect(stderr).toBe("")
          expect(exitCode).toBe(0)
        }
        const projection = new SQLite(projectionPath, { readonly: true, strict: true })
        try {
          const projected = projection
            .query("SELECT kind,message_id,seq FROM hc_session_receipts ORDER BY seq")
            .all() as Array<{ kind: string; message_id: string | null; seq: number }>
          const compaction = projected.filter((event) => event.kind.includes(".compaction."))
          expect(compaction.map((event) => event.kind)).toEqual([
            "session.next.compaction.started.1",
            "session.next.compaction.ended.1",
            "session.next.compaction.started.1",
            "session.next.compaction.ended.1",
          ])
          expect(compaction[0]?.message_id).not.toBeNull()
          expect(compaction[0]?.message_id).toBe(compaction[1]?.message_id)
          expect(compaction[2]?.message_id).toBe(compaction[3]?.message_id)
          expect(JSON.stringify(projected)).not.toContain("## Objective")
          expect(JSON.stringify(projected)).not.toContain("Recent exact request")
        } finally {
          projection.close()
        }
      } finally {
        rmSync(projectionDirectory, { recursive: true, force: true })
      }
    }),
  )

  it.effect("applies pending compaction settings on the next turn while pinning model selection", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = compactModel
      yield* Effect.sync(() =>
        writeFileSync(path.join(locationDirectory, "config.json"), JSON.stringify({ compaction: { auto: false, prune: false } })),
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: `Turn one context ${"preserve this detail ".repeat(300)}` }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-turn-one-echo", name: "echo", input: { text: "continuation" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "text-turn-one-final", ["Turn one complete"]).completeEvents,
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      const firstTurn = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)

      yield* Effect.sync(() =>
        writeFileSync(
          path.join(locationDirectory, "config.json"),
          JSON.stringify({ compaction: { auto: true, prune: true }, model: "changed/model", provider: "changed" }),
        ),
      )
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(firstTurn)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.model)).toEqual([compactModel, compactModel])
      expect(requests.some((request) => userTexts(request).some((text) => text.includes("Create a new anchored summary")))).toBe(
        false,
      )

      requests.length = 0
      responses = [
        fragmentFixture("text", "text-turn-two-summary", ["## Objective\n- Apply pending settings"]).completeEvents,
        fragmentFixture("text", "text-turn-two-final", ["Turn two complete"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: `Turn two recent context ${"keep this recent detail ".repeat(300)}` }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.model)).toEqual([compactModel, compactModel])
      expect(userTexts(requests[0])[0]).toContain("Create a new anchored summary")
      expect(userTexts(requests[1])[0]).toContain("<summary>\n## Objective\n- Apply pending settings\n</summary>")
    }),
  )

  it.effect("retains only complete serialized messages during compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const earlier = `EARLIER_BOUNDARY ${"a".repeat(3_000)} EARLIER_END`
      const recent = `RECENT_BOUNDARY ${"b".repeat(3_000)} RECENT_END`
      response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: earlier }), resume: false })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: recent }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const summary = userTexts(requests[0])[0]
      const continuation = userTexts(requests[1])[0]
      expect(summary.match(/EARLIER_BOUNDARY/g)).toHaveLength(1)
      expect(summary).toContain(`EARLIER_BOUNDARY ${"a".repeat(3_000)} EARLIER_END`)
      expect(summary).not.toContain("RECENT_BOUNDARY")
      expect(continuation).not.toContain("EARLIER_BOUNDARY")
      expect(continuation).not.toContain("EARLIER_END")
      expect(continuation).toContain("<recent-context>\n[Assistant]: Earlier answer")
      expect(continuation).toContain(`RECENT_BOUNDARY ${"b".repeat(3_000)} RECENT_END`)
    }),
  )

  it.effect("summarizes an oversized newest message without retaining a fragment", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Earlier question" }), resume: false })
      yield* session.resume(sessionID)

      const oversized = `OVERSIZED_BOUNDARY ${"x".repeat(4_500)} OVERSIZED_END`
      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: oversized }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const summary = userTexts(requests[0])[0]
      const continuation = userTexts(requests[1])[0]
      expect(summary.match(/OVERSIZED_BOUNDARY/g)).toHaveLength(1)
      expect(summary).toContain(oversized)
      expect(continuation).not.toContain("OVERSIZED_BOUNDARY")
      expect(continuation).not.toContain("OVERSIZED_END")
      expect(continuation).toContain("<recent-context>\n\n</recent-context>")
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1])[0]).toContain("## Objective")
      expect(userTexts(requests[2])[0]).toContain("<summary>\n## Objective\n- Recover overflow\n</summary>")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover overflow" },
        { type: "assistant", finish: "stop" },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("persists a second context overflow after one recovery", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover once"]).completeEvents,
        overflow(),
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover raw overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover raw overflow" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("publishes the original overflow when recovery summarization fails", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "text-summary", ["## Objective\n- Interrupted"]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("preserves effective System updates while compaction rebaseline is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Initial context"])
      expect(systemTexts(requests.at(-1)!)).toContain("Changed context")
    }),
  )

  it.effect("projects reasoning and tool events without executing or continuing tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use tools" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
        LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
        LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
            ],
          },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["write", "echo", "defect"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          usageProvenance: {
            providerID: "fake",
            modelID: "fake-model",
            cost: { status: "unknown" },
            tokens: {
              input: { status: "provider-reported", value: 8 },
              output: { status: "provider-reported", value: 3 },
              reasoning: { status: "provider-reported", value: 1 },
              cache: {
                read: { status: "provider-reported", value: 2 },
                write: { status: "unknown" },
              },
            },
          },
          content: [
            { type: "reasoning", id: "reasoning-1", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "unknown", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              provider: { executed: true, metadata: { fake: { source: "provider" } } },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Done" }] },
      ])
    }),
  )

  it.effect("reloads a model switch before a tool-driven continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
      ])
      expect(systemTexts(requests[1]!)).toContain("Replacement context")
    }),
  )

  it.effect("restores durable reasoning provider metadata in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Think first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({ id: "reasoning-anthropic", providerMetadata: { anthropic: { signature: "sig_1" } } }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
            {
              type: "reasoning",
              text: "Encrypted thought",
              providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
            },
          ],
        },
      ])

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages[1]?.content).toEqual([
        { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Search first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        },
      ])
    }),
  )

  it.effect("holds local tools until the provider turn completes, then awaits settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo five times" }), resume: false })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      const providerGate = yield* Deferred.make<void>()
      const providerWaiting = yield* Deferred.make<void>()
      response = []
      responses = undefined
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = undefined
      responseStream = Stream.concat(
        initial,
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(providerWaiting, undefined)
            yield* Deferred.await(providerGate)
          }),
        ).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(providerWaiting)
      yield* Effect.yieldNow

      expect(executions).toHaveLength(0)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Deferred.succeed(providerGate, undefined)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("does not execute a local tool when its provider response fails after the call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do not run partial response" }), resume: false })

      requests.length = 0
      executions.length = 0
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "partial-call", name: "echo", input: { text: "must not execute" } }),
        ]),
        Stream.fail(providerUnavailable()),
      )

      const result = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(executions).toEqual([])
      const history = yield* session.context(sessionID)
      expect(history.at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "tool", id: "partial-call", state: { status: "error" } }],
      })
    }),
  )

  it.effect("does not execute or continue an incomplete provider tool response", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Reject unfinished response" }), resume: false })

      requests.length = 0
      executions.length = 0
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "unfinished-call", name: "echo", input: { text: "must not execute" } }),
      ])

      yield* session.resume(sessionID)

      expect(executions).toEqual([])
      expect(requests).toHaveLength(1)
      const history = yield* session.context(sessionID)
      expect(history.at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "tool", id: "unfinished-call", state: { status: "error" } }],
      })
    }),
  )

  it.effect("requires a completed provider step before executing the collected tool batch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Reject missing step finish" }), resume: false })

      requests.length = 0
      executions.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "missing-step-finish", name: "echo", input: { text: "must not execute" } }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual([])
      expect(requests).toHaveLength(1)
      const history = yield* session.context(sessionID)
      expect(history.at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "tool", id: "missing-step-finish", state: { status: "error" } }],
      })
    }),
  )

  it.effect("rejects the full local tool batch before executing when any call fails schema validation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Validate every tool call" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "valid-call", name: "echo", input: { text: "must be withheld" } }),
          LLMEvent.toolCall({ id: "invalid-call", name: "echo", input: { text: 42 } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual([])
      const history = yield* session.context(sessionID)
      expect(history.at(-1)).toMatchObject({
        type: "assistant",
        content: [
          { type: "tool", id: "valid-call", state: { status: "error" } },
          { type: "tool", id: "invalid-call", state: { status: "error" } },
        ],
      })
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("settles repeated provider-local tool call IDs against their owning assistant messages", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo twice" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "second" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["first", "second"])
      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run once" }), resume: false })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-once" }),
        LLMEvent.textDelta({ id: "text-once", text: "Once" }),
        LLMEvent.textEnd({ id: "text-once" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-once", text: "Once" }] },
      ])
    }),
  )

  it.effect("steers an active provider turn with newly recorded prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.effect("promotes queued input after continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait until continuation ends" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Wait until continuation ends"])
    }),
  )

  it.effect("preserves durable queued input for a later wake after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run after interrupt" }),
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Run after interrupt"])
    }),
  )

  it.effect("preserves durable steering input for a later resume after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Steer after interrupt" }),
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("promotes queued inputs one at a time in FIFO order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("promotes queued input after steering continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start steering" }), resume: false })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue for later" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering", "Queue for later"])
    }),
  )

  it.effect("promotes steers before the next queued input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Steer before next queued input" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Also steer before next queued input" }) })
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
        "Queue second",
      ])
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First steer" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second steer" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      yield* (yield* SessionExecution.Service).wake(sessionID, sessionTestPrincipal)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover with this" }) })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
    }),
  )

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover interrupted tool" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
        sourceGeneration: "generation-interrupted",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
        sequence: 0,
        sourceGeneration: "generation-interrupted",
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        tool: "echo",
        input: { text: "stale" },
        provider: { executed: false },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
        sourceGeneration: "generation-hosted-interrupted",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
        sequence: 0,
        sourceGeneration: "generation-hosted-interrupted",
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        tool: "web_search",
        input: { query: "stale" },
        provider: { executed: true, metadata: { openai: { itemId: "call-hosted-interrupted" } } },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
        sourceGeneration: "generation-pending-interrupted",
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("promotes the first queued input when woken while idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait in queue" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      yield* (yield* SessionExecution.Service).wake(sessionID, sessionTestPrincipal)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait in queue"])
    }),
  )

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.Prompted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover promoted input" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* (yield* SessionExecution.Service).wake(sessionID, sessionTestPrincipal)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type ? Effect.die("fail after prompt promotion commits") : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run committed promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run first" }), resume: false })
      yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Run second" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("adds session correlation headers to model requests", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run correlated request" }), resume: false })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers).toEqual({
        "x-opencode-session-id": sessionID,
        "x-session-affinity": sessionID,
        "X-Session-Id": sessionID,
      })
    }),
  )

  it.effect("adds the parent session header to child model requests", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const parentID = SessionV2.ID.make("ses_runner_parent")
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ parent_id: parentID })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run child request" }), resume: false })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers).toEqual({
        "x-opencode-session-id": sessionID,
        "x-opencode-parent-session-id": parentID,
        "x-session-affinity": sessionID,
        "X-Session-Id": sessionID,
        "x-parent-session-id": parentID,
      })
    }),
  )

  it.effect("bounds 64-character session prompt cache keys", () =>
    Effect.gen(function* () {
      yield* setup
      const longSessionID = SessionV2.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = SessionV2.ID.make(`ses_${"b".repeat(64)}`)
      yield* insertSession(longSessionID)
      yield* insertSession(otherLongSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: longSessionID,
        prompt: Prompt.make({ text: "Run long session" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherLongSessionID,
        prompt: Prompt.make({ text: "Run other long session" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(longSessionID)
      yield* session.resume(otherLongSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry after failure" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles local tool failures before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call missing" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "missing", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-error" }),
          LLMEvent.textDelta({ id: "text-after-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = undefined
      streamStarted = undefined

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: { status: "error", error: { message: "Unknown tool: missing" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-error", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns unexpected local tool defects to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call defect" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-defect", name: "defect", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-defect" }),
          LLMEvent.textDelta({ id: "text-after-defect", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-defect" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "Tool execution failed: unexpected tool defect" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns policy-blocked tools to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        blocked: Tool.make({
          description: "Fail because policy blocked execution",
          capability: { id: "test.blocked", effectClass: "read_only" },
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.BlockedError({ rules: [] })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Permission blocked" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call blocked" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-blocked", name: "blocked", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call blocked" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-blocked", state: { status: "error", error: { message: "Permission blocked" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when permission approval is declined", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        declined: Tool.make({
          description: "Fail because the user declined approval",
          capability: { id: "test.declined", effectClass: "read_only" },
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new PermissionV2.DeclinedError()),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call declined" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-declined", name: "declined", input: {} }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("returns permission corrections to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        corrected: Tool.make({
          description: "Fail with user correction feedback",
          capability: { id: "test.corrected", effectClass: "read_only" },
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.CorrectedError({ feedback: "Use another tool" })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Use another tool" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call corrected" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-corrected", name: "corrected", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call corrected" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-corrected", state: { status: "error", error: { message: "Use another tool" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when a question is dismissed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      yield* registry.register({
        question: Tool.make({
          description: "Ask the user",
          capability: { id: "test.question", effectClass: "control" },
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions
              .ask({
                sessionID: context.sessionID,
                questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] }],
              })
              .pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ask then stop" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-question", name: "question", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list(sessionID)
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list(sessionID)
      }
      yield* questions.reject({ sessionID, requestID: pending[0]!.id })
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("does not execute an uncompleted local tool batch when provider streaming fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Settle before failing" }), resume: false })
      executions.length = 0
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
        ]),
        Stream.fail(failure),
      )

      const result = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(failure)
      expect(executions).toEqual([])

      const history = yield* session.context(sessionID)
      expect(history.at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "tool", id: "call-before-failure", state: { status: "error" } }],
      })
    }),
  )

  it.effect("durably fails blocked local tools when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt blocked tool" }), resume: false })
      executions.length = 0
      const providerBlocked = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
        ]),
        Stream.fromEffect(Deferred.succeed(providerBlocked, undefined)).pipe(Stream.flatMap(() => Stream.never)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(providerBlocked)
      yield* session.interrupt(sessionID)

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      // The interrupted dispatch is recovered as an UNKNOWN outcome and is
      // surfaced once; it is never replayed. A later accepted continuation
      // journals a new request ID instead of reusing the lost one.
      const unknownExit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(
        Exit.isFailure(unknownExit) && String(Cause.squash(unknownExit.cause)).includes("UNKNOWN outcome"),
      ).toBe(true)
      requests.length = 0
      responseStream = undefined
      response = []
      yield* session.resume(sessionID)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    }),
  )

  it.effect("interrupts a blocked provider turn without local tool execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt provider" }), resume: false })
      requests.length = 0
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      yield* session.interrupt(sessionID)

      const { db } = yield* Database.Service
      const sourceEvents = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      const projectionDirectory = mkdtempSync(path.join(tmpdir(), "hc-interrupted-turn-projection-"))
      const sourcePath = path.join(projectionDirectory, "opencode-events.db")
      const projectionPath = path.join(projectionDirectory, "session-projection.db")
      try {
        const source = new SQLite(sourcePath)
        try {
          source.exec(
            "CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(aggregate_id, seq))",
          )
          const insert = source.prepare("INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?,?,?,?,?)")
          for (const event of sourceEvents) {
            insert.run(event.id, event.aggregate_id, event.seq, event.type, JSON.stringify(event.data))
          }
        } finally {
          source.close()
        }
        const child = Bun.spawn([rustProbe, sourcePath, projectionPath, sessionID], {
          stdout: "ignore",
          stderr: "pipe",
        })
        const exitCode = yield* Effect.promise(() => child.exited)
        const stderr = yield* Effect.promise(() => new Response(child.stderr).text())
        expect(stderr).toBe("")
        expect(exitCode).toBe(0)
        const projection = new SQLite(projectionPath, { readonly: true, strict: true })
        try {
          const projected = projection
            .query("SELECT kind,message_id,seq FROM hc_session_receipts ORDER BY seq")
            .all() as Array<{ kind: string; message_id: string | null; seq: number }>
          expect(projected.map((event) => event.kind)).toEqual(sourceEvents.map((event) => event.type))
          expect(projected.some((event) => event.kind === "session.next.prompt.admitted.1")).toBe(true)
          expect(projected.some((event) => event.kind === "session.next.step.started.1")).toBe(false)
          expect(JSON.stringify(projected)).not.toContain("Interrupt provider")
        } finally {
          projection.close()
        }
      } finally {
        rmSync(projectionDirectory, { recursive: true, force: true })
      }
    }),
  )

  it.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt tool settlement" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-await-interrupt", name: "echo", input: { text: "blocked" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const runner = yield* SessionRunner.Service
      const run = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Fiber.interrupt(run)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("forces a text response on an agent's configured final step", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish at the limit" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-terminal", name: "echo", input: { text: "done" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-forbidden", name: "echo", input: { text: "forbidden" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[1]?.tools).toEqual([])
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the limit" },
        { type: "assistant", content: [{ type: "tool", id: "call-terminal", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("resets the configured step allowance when steering input promotes", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start work" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-steer", name: "echo", input: { text: "before" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-after-steer", name: "echo", input: { text: "after" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[1]?.tools).not.toEqual([])
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual(["before", "after"])
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail durably" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail before step" }), resume: false })

      requests.length = 0
      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail after output" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail raw stream durably" }), resume: false })
      const failure = providerUnavailable()
      responseStream = Stream.fail(failure)

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not execute a local tool when a provider error interrupts the batch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not continue failed provider" }),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual([])
      const history = yield* session.context(sessionID)
      expect(history.at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "tool", id: "call-before-provider-error", state: { status: "error" } }],
      })
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool durably" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-provider-error",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved at normal provider EOF", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool at EOF" }), resume: false })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-eof",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
      ]

      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        { type: "assistant", content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-raw-failure",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("keeps interleaved assistant text blocks separate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Two blocks" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", id: "text-1", text: "First" },
            { type: "text", id: "text-2", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    it.effect(`durably closes partial ${kind} when the provider stream fails`, () => verifyPartialFlushOnFailure(kind))

    it.effect(`durably closes partial ${kind} when the provider stream is interrupted`, () =>
      verifyPartialFlushOnInterruption(kind),
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Duplicate text start" }), resume: false })
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-1",
      )
    }),
  )

  it.effect("rejects reusing a streamed text part ID after end to preserve generation fencing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Reused text part" }), resume: false })
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-reused" }),
        LLMEvent.textDelta({ id: "text-reused", text: "first" }),
        LLMEvent.textEnd({ id: "text-reused" }),
        LLMEvent.textStart({ id: "text-reused" }),
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-reused",
      )
    }),
  )

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call provider tool" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolCall({ id: "call-parsed", name: "web_search", input: { query: "hello" }, providerExecuted: true }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
      ])
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Malformed tool input" }), resume: false })
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Tool input delta before start: call-1",
      )
    }),
  )

  it.effect("settles the direct provider journal with the canonical assistant step", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Settle the journal" }), resume: false })
      response = fragmentFixture("text", "text-settle", ["done"]).completeEvents

      yield* session.resume(sessionID)

      const rows = yield* db
        .select()
        .from(DirectProviderRequestTable)
        .where(eq(DirectProviderRequestTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.state).toBe("SETTLED")
      expect(rows[0]!.request_id).toBe(String(requests.at(-1)!.id))
      expect(rows[0]!.provider_id).toBe("fake")
      expect(rows[0]!.model_id).toBe("fake-model")
      expect(rows[0]!.route_revision).toBe(directRoute.routeRevision)
      expect(rows[0]!.endpoint_revision).toBe(directRoute.endpointRevision)
      expect(rows[0]!.transport_request_digest).toBe(transportRequestDigest)
      expect(journalDispatches).toHaveLength(1)
    }),
  )

  it.effect("rejects a selected-route endpoint mismatch before any durable provider pin", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Route mismatch" }), resume: false })
      pinEndpointOverride = `blake3:${"0".repeat(64)}`
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.finish({ reason: "stop" })]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause)).includes("endpoint differs from the trusted route projection")).toBe(true)
      const rows = yield* db
        .select()
        .from(DirectProviderRequestTable)
        .where(eq(DirectProviderRequestTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(0)
      expect(journalDispatches).toHaveLength(0)
    }),
  )

  it.effect("fails closed when the trusted profile pin does not match the selected model", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Profile mismatch" }), resume: false })
      profileModelOverride = { providerId: "fake", modelId: "other-model" }

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause)).includes("authenticated permission scope, selected-route, AgentProfileV2, or ContextSelection pins")).toBe(true)
      const rows = yield* db
        .select()
        .from(DirectProviderRequestTable)
        .where(eq(DirectProviderRequestTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(0)
      expect(journalDispatches).toHaveLength(0)
    }),
  )

  it.effect("marks a lost dispatched response UNKNOWN and requires an explicit fresh continuation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const journalRows = () =>
        db
          .select()
          .from(DirectProviderRequestTable)
          .where(eq(DirectProviderRequestTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Lost response" }), resume: false })
      // The dispatch is durable, but the provider response is lost before any
      // canonical terminal event: the request can never be settled or replayed.
      responseStream = Stream.concat(
        Stream.fromIterable([LLMEvent.stepStart({ index: 0 })]),
        Stream.fail(providerUnavailable()),
      )

      const firstExit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(firstExit._tag).toBe("Failure")
      const dispatchedID = String(requests.at(-1)!.id)
      expect((yield* journalRows()).map((row) => [row.request_id, row.state])).toEqual([[dispatchedID, "DISPATCHING"]])

      const unknownExit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(
        Exit.isFailure(unknownExit) && String(Cause.squash(unknownExit.cause)).includes("UNKNOWN outcome"),
      ).toBe(true)
      expect((yield* journalRows()).map((row) => [row.request_id, row.state])).toEqual([[dispatchedID, "UNKNOWN"]])

      // The surfaced UNKNOWN requires an explicit fresh continuation: the next
      // accepted turn journals a new request ID and the lost one is never replayed.
      responseStream = undefined
      response = fragmentFixture("text", "text-after-unknown", ["fresh"]).completeEvents
      yield* session.resume(sessionID)
      const freshID = String(requests.at(-1)!.id)
      expect(freshID).not.toBe(dispatchedID)
      expect(
        (yield* journalRows()).map((row) => [row.request_id, row.state]).toSorted(),
      ).toEqual([[dispatchedID, "UNKNOWN"], [freshID, "SETTLED"]].toSorted())
    }),
  )
})
