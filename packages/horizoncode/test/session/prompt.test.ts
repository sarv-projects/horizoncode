import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { ConfigV1 } from "@horizoncode/core/v1/config/config"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { Database } from "@horizoncode/core/database/database"
import { Project } from "@horizoncode/core/project"
import { ProjectTable } from "@horizoncode/core/project/sql"
import { AbsolutePath } from "@horizoncode/core/schema"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { makeGlobalNode } from "@horizoncode/core/effect/app-node"
import { SessionProjector } from "@horizoncode/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { afterAll, expect, test } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Schema, Stream } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@horizoncode/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import type { DirectProviderRouteV1 } from "@/auth/provider-transport"
import { AgentProfileService } from "@horizoncode/core/config"
import * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import { ProviderTest } from "../fake/provider"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@horizoncode/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@horizoncode/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import type { DirectAttemptAuthority } from "../../src/session/tool-batch"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@horizoncode/core/session"
import { SessionExecution } from "@horizoncode/core/session/execution"
import {
  GuardApprovalRequested,
  SessionSupervisor,
  SessionSupervisorError,
  type GuardApprovalRequest,
} from "@horizoncode/core/session/supervisor"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { WebSearchRuntime } from "@/tool/websearch-runtime"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { Ripgrep } from "@horizoncode/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect, testEffectShared } from "../lib/effect"
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectV2 } from "@horizoncode/core/project"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import {
  buildLocationServiceMap,
  LocationServiceMap,
  locationServiceMapLayer,
  locationServiceMapNode,
} from "@horizoncode/core/location-services"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function errorTool(parts: SessionV1.Part[]): ErrorToolPart | undefined {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      approve: () => Effect.succeed({ status: "disabled" as const }),
      revokeApproval: () => Effect.succeed({ status: "disabled" as const }),
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    // Prompt tests never enter a workspace-bound execution scope; the mock
    // passes the effect through unchanged and fails closed for proposals.
    withExecutionScope: (input, effect) => Effect.provideService(effect, LSP.ExecutionScope, input),
    postPatchDiagnostics: () => Effect.die("unexpected post-patch diagnostics"),
    codeAction: () => Effect.die("unexpected code action"),
    rename: () => Effect.die("unexpected rename proposal"),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const activeRustOwners = new Set<string>()
const rustOwnerStarts: Array<{ sessionID: string; source: string; workspaceRoot: string }> = []
const testSupervisorLayer = Layer.succeed(
  SessionSupervisor.Service,
  SessionSupervisor.Service.of({
    open: () => Effect.die("unexpected direct supervisor open"),
    openForSession: () => Effect.die("unexpected direct supervisor open"),
    registerHostLocation: () => Effect.die("unexpected host location registration"),
    prepareUserEffect: () => Effect.die("unexpected user effect preparation"),
    replyGuardApproval: () => Effect.die("unexpected guard approval reply"),
    awaitManagedVerifierApprovals: () => Effect.die("unexpected managed verifier approval"),
    prepareToolBatch: () => Effect.die("unexpected effect preparation"),
    executeWrite: () => Effect.die("unexpected effect execution"),
    executePatch: () => Effect.die("unexpected patch execution"),
    runPatch: () => Effect.die("unexpected patch execution"),
    requestHostKernel: () => Effect.die("unexpected host kernel request"),
    hostOwnerEpoch: () => Effect.die("unexpected host owner epoch read"),
    directSessionPermissionModeSnapshot: (input: { sessionID: string }) =>
      Effect.succeed({
        schemaVersion: 1 as const,
        sessionId: input.sessionID,
        ownerEpoch: "1",
        locationId: "loc_prompt_test",
        workspaceId: "wrk_prompt_test",
        workspaceRootDigest: `blake3:${"a".repeat(64)}`,
        executionBackendId: "horizon.host",
        policyDigest: `sha256:${"c".repeat(64)}`,
        sandboxMode: "read-only" as const,
        approvalPolicy: "on-request" as const,
        source: "default" as const,
        revision: "7",
        digest: `blake3:${"b".repeat(64)}`,
      }),
    // Host features stay closed in these prompt tests (fail-closed projection).
    hostFeatureEnabled: () => Effect.succeed(false),
    // Root direct turns treat a typed projection failure as "no trusted
    // workspace snapshot": the optional LSP/repo-intel context is withheld and
    // the ordinary direct model turn continues.
    directSessionWorkspaceSnapshot: () =>
      Effect.fail(
        new SessionSupervisorError({
          stage: "host-kernel",
          reason: "workspace snapshot unavailable in prompt tests",
        }),
      ),
    directProviderPermissionScope: () => Effect.die("unexpected direct provider permission scope"),
    setDirectSessionPermissionMode: () => Effect.die("unexpected direct permission mode write"),
    issueDirectSessionGrant: () => Effect.die("unexpected direct session grant"),
    revokeDirectSessionGrant: () => Effect.die("unexpected direct session grant revocation"),
    resolveEditorProcessApproval: () => Effect.die("unexpected editor process approval"),
    authorizeEditorProtocolOperation: () => Effect.die("unexpected editor protocol authorization"),
    authorizeReplOperation: () => Effect.die("unexpected repl authorization"),
    awaitManagedProviderApproval: () => Effect.die("unexpected managed provider approval"),
    awaitManagedRootApproval: () => Effect.die("unexpected managed root approval"),
    managedEffectWaveReceipts: () => Effect.die("unexpected managed effect wave receipts"),
    managedCurrentEpochRecoveryQuiescence: () => Effect.die("unexpected managed epoch recovery quiescence"),
    directCodeModeWaveReceipts: () => Effect.die("unexpected direct code mode wave receipts"),
    codeModeHostRequest: () => Effect.die("unexpected code mode host request"),
    settleCodeModeToolResults: () => Effect.die("unexpected code mode tool result settlement"),
    prepareCodeModeToolBatch: () => Effect.die("unexpected code mode tool batch preparation"),
    codeModeWaveReceipts: () => Effect.die("unexpected code mode wave receipts"),
    listDirectAttemptArtifacts: () => Effect.die("unexpected direct attempt artifact listing"),
    listDirectSessionArtifacts: () => Effect.die("unexpected direct session artifact listing"),
    inspectDirectSessionArtifact: () => Effect.die("unexpected direct session artifact inspection"),
    readDirectSessionArtifactRange: () => Effect.die("unexpected direct session artifact range read"),
    sessionProjectionCursor: () =>
      Effect.fail(
        new SessionSupervisorError({
          stage: "host-kernel",
          reason: "session projection cursor unavailable in prompt tests",
        }),
      ),
    subscribeHostKernelEvents: () => Stream.die("unexpected host kernel event subscription"),
    watchSession: (sessionID, source, workspaceRoot, turnComplete, ready) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          activeRustOwners.add(sessionID)
          rustOwnerStarts.push({ sessionID, source, workspaceRoot })
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => activeRustOwners.delete(sessionID)))
        yield* Deferred.succeed(ready, undefined)
        while (!(yield* Ref.get(turnComplete))) yield* Effect.sleep("1 millis")
      }),
  }),
)
const testSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: testSupervisorLayer,
  deps: [],
  tag: SessionSupervisor.node.tag,
})

// Direct-session prompt tests act as the local host owner; Guard/effect
// boundaries require an explicit trusted principal context.
const trustedPrincipalLayer = Layer.succeed(TrustedPrincipalContext, {
  // The direct-provider authority pins require an authenticated ServerAuth
  // principal; host-os callers stay fail-closed in the resolver itself.
  principal: { kind: "server_auth" as const, subject: "core-prompt-test" },
})

// Rust needs an owner-only parent for its pinned executable and observer state.
// Keep it directly under the repository root so generated Unix socket paths
// fit the platform limit even when TMPDIR is package-nested.
const rustTestRoot = mkdtempSync(path.join(path.resolve(import.meta.dir, "../../../.."), "x"))
afterAll(() => rmSync(rustTestRoot, { recursive: true, force: true }))
const observerSocketPath = path.join(rustTestRoot, `s-${"0".repeat(20)}`, `s-${"0".repeat(16)}.sock`)
const hostKernelSocketPath = path.join(rustTestRoot, `host-${"0".repeat(16)}.sock`)
if ([observerSocketPath, hostKernelSocketPath].some((socket) => Buffer.byteLength(socket, "utf8") >= 108)) {
  throw new Error("prompt test supervisor socket root exceeds the Unix socket path limit")
}
const rustSupervisorPath = path.resolve(import.meta.dir, "../../../../kernel/target/debug/session_supervisor")
const hostKernelPath = path.resolve(import.meta.dir, "../../../../kernel/target/debug/hz-kernel")
const hostKernelAvailable = process.platform === "linux" && existsSync(hostKernelPath)
const rustSupervisorAvailable = process.platform === "linux" && existsSync(rustSupervisorPath) && hostKernelAvailable
const rustSupervisorDigest = rustSupervisorAvailable
  ? createHash("sha256").update(readFileSync(rustSupervisorPath)).digest("hex")
  : undefined
const hostKernelDigest = hostKernelAvailable ? createHash("sha256").update(readFileSync(hostKernelPath)).digest("hex") : undefined
const rustSupervisorRuntimeNode = LayerNode.make({
  service: SessionSupervisor.RuntimeConfig,
  layer: Layer.succeed(
    SessionSupervisor.RuntimeConfig,
    SessionSupervisor.RuntimeConfig.of({
      assetPath: rustSupervisorAvailable ? rustSupervisorPath : undefined,
      manifestJSON: rustSupervisorDigest
        ? JSON.stringify({
            schemaVersion: 1,
            status: "available",
            binaryName: "session_supervisor",
            target: `linux-${process.arch}-gnu`,
            sha256: rustSupervisorDigest,
          })
        : undefined,
      installRoot: path.join(rustTestRoot, "session-observer"),
      stateRoot: rustTestRoot,
      hostKernelAssetPath: hostKernelAvailable ? hostKernelPath : undefined,
      hostKernelManifestJSON: hostKernelDigest
        ? JSON.stringify({
            schemaVersion: 1,
            status: "available",
            binaryName: "hz-kernel",
            target: `linux-${process.arch}-gnu`,
            sha256: hostKernelDigest,
          })
        : undefined,
      hostKernelInstallRoot: path.join(rustTestRoot, "host-kernel-install"),
      hostKernelStateRoot: rustTestRoot,
    }),
  ),
  deps: [],
})
const rustLocationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: buildLocationServiceMap([[SessionSupervisor.runtimeConfigNode, rustSupervisorRuntimeNode]]),
  deps: [],
})

const rustSessionDatabaseNode = makeGlobalNode({
  service: Database.Service,
  layer: Database.layerFromPath(path.join(rustTestRoot, "horizoncode-v1-guard.sqlite")),
  deps: [],
})

const promptTestProfile = Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2)({
  schemaVersion: 2,
  profileId: "prompt.direct",
  revision: "1",
  name: "Prompt Direct",
  description: "Direct prompt test profile",
  source: "user",
  roles: ["main"],
  purpose: "Exercise the direct prompt path",
  whenToUse: "In prompt tests",
  whenNotToUse: "Never",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: { providerId: "test", modelId: "test-model" },
  harness: "native-minimal",
  reasoning: "low",
  variants: [],
  instructions: { extraRefs: [], maxCompiledTokens: "4096" },
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
  isolation: "workspace",
  lifecycleHooks: [],
  capabilityCeiling: [],
  limits: { maxDepth: 4, maxActiveChildren: 4, maxTotalChildren: 8, maxPendingMessages: 16, maxMessageBytes: 32768 },
  maxParallelChildren: 2,
  enabled: true,
})

const agentProfileNode = LayerNode.make({
  service: AgentProfileService,
  layer: Layer.succeed(
    AgentProfileService,
    AgentProfileService.of({
      agentProfiles: () => Effect.succeed([promptTestProfile]),
      agentProfileSelectors: () => Effect.succeed([]),
      agentProfile: () => Effect.die("prompt tests resolve the primary profile only"),
      agentProfileSelector: () => Effect.die("prompt tests resolve the primary profile only"),
      primaryAgentProfile: () => Effect.succeed(promptTestProfile),
    }),
  ),
  deps: [],
})

/**
 * Typed direct-transport double at the Provider seam: llm.run resolves the real
 * §15.2 authority pins and then builds the language model through
 * `getDirectLanguage`. The double returns a loopback language model for the
 * primed TestLLMServer plus an exact route projection; no production check is
 * weakened and no external route is contacted.
 */
const directModel = ProviderTest.model({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("test-model"),
  api: { id: ModelV2.ID.make("test-model"), url: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible" },
  // Reasoning-effort variants the config-loaded model advertises; agent-variant
  // selection checks `model.variants[ag.variant]` before applying it.
  variants: { xhigh: {}, high: {} },
})
const directInfo = ProviderTest.info({ id: ProviderV2.ID.make("test") }, directModel)

const directLanguage = (model: { readonly api: { readonly id: string } }) => {
  const baseURL = directTestServerURL
  if (!baseURL) throw new Error("TestLLMServer is not primed for the direct provider transport double")
  return createOpenAICompatible({ name: "test-direct", baseURL, apiKey: "public" }).languageModel(model.api.id)
}

const directRoute = (harnessID: string): DirectProviderRouteV1 => ({
  providerID: directModel.providerID,
  modelID: directModel.id,
  harnessID,
  routeID: "llm_p7_prompt_direct",
  routeRevision: "llm_p7_prompt_direct",
  endpointRevision: `blake3:${"d".repeat(64)}`,
  endpointBase: directTestServerURL ?? "http://127.0.0.1:1/v1",
  anonymousOpenCodeFree: false,
  credentialHeader: { name: "authorization", prefix: "Bearer " },
})

const providerDouble = ProviderTest.fake({
  model: directModel,
  info: directInfo,
  getDirectLanguage: Effect.fn("PromptTest.getDirectLanguage")((input) =>
    Effect.succeed({ language: directLanguage(input.model), route: directRoute(input.harnessID) })),
  getLanguage: Effect.fn("PromptTest.getLanguage")(() => Effect.succeed(directLanguage(directModel))),
  getManagedLanguage: Effect.fn("PromptTest.getManagedLanguage")(() => Effect.succeed(directLanguage(directModel))),
})

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  agentProfileNode,
  SessionRunState.node,
  SessionSupervisor.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  // SessionTools.resolve requires WebSearchRuntime in the caller's context, so
  // the prompt test graph must expose it as a member (not only as a dep).
  WebSearchRuntime.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

function makePrompt(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
    [SessionSupervisor.node, testSupervisorNode],
    [ProviderSvc.node, providerDouble.layer],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]]).pipe(
      Layer.provideMerge(trustedPrincipalLayer),
    )
  }
  return LayerNode.compile(promptRoot, replacements).pipe(Layer.provideMerge(trustedPrincipalLayer))
}

function makeHttp(input?: {
  mcpInstructions?: MCP.ServerInstructions[]
  processor?: "blocking"
  rustSupervisor?: boolean
}) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  if (input?.rustSupervisor) {
    const replacements = [
      [SessionSummary.node, summary],
      [Database.node, rustSessionDatabaseNode],
      [LSP.node, lsp],
      [MCP.node, makeMcp(input.mcpInstructions)],
      [RuntimeFlags.node, runtimeFlags],
      [SessionSupervisor.runtimeConfigNode, rustSupervisorRuntimeNode],
      [locationServiceMapNode, rustLocationServiceMapNode],
    [ProviderSvc.node, providerDouble.layer],
    ] as const
    if (input.processor === "blocking") {
      return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]]).pipe(
        Layer.provideMerge(trustedPrincipalLayer),
      )
    }
    return LayerNode.compile(root, replacements).pipe(Layer.provideMerge(trustedPrincipalLayer))
  }
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
    [SessionSupervisor.node, testSupervisorNode],
    [ProviderSvc.node, providerDouble.layer],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]]).pipe(
      Layer.provideMerge(trustedPrincipalLayer),
    )
  }
  return LayerNode.compile(root, replacements).pipe(Layer.provideMerge(trustedPrincipalLayer))
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

// The prompt graph consumes SessionStatus (and other member services) through
// dependency chains; the shared memoMap build keeps the dep-consumed and
// member-exposed instances identical, so bodies observe the same SessionStatus
// the prompt path mutates. ToolRegistry/TaskTool init also reads the instance
// context at layer build, so the graph gets a build-scope InstanceRef (the same
// recipe P3 used for repo-tools); it is never used for filesystem access here.
const fixtureInstanceRef = Layer.succeed(InstanceRef, {
  directory: "/home/sarvesh/business_Dev/agentx/.p7-fixture",
  worktree: "/home/sarvesh/business_Dev/agentx/.p7-fixture",
  project: {
    id: ProjectV2.ID.make("proj-p7-prompt-fixture"),
    worktree: "/home/sarvesh/business_Dev/agentx/.p7-fixture",
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
})
const it = testEffectShared(makeHttp().pipe(Layer.provide(fixtureInstanceRef)))
const noLLMServer = testEffectShared(makeHttpNoLLMServer().pipe(Layer.provide(fixtureInstanceRef)))
const raceNoLLMServer = testEffectShared(makeHttpNoLLMServer({ processor: "blocking" }).pipe(Layer.provide(fixtureInstanceRef)))

const liveRustSupervisor = testEffectShared(makeHttp({ rustSupervisor: true }).pipe(Layer.provide(fixtureInstanceRef)))
const withRustSupervisor = rustSupervisorAvailable ? liveRustSupervisor.instance : liveRustSupervisor.instance.skip
const withMcpInstructions = testEffectShared(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }).pipe(Layer.provide(fixtureInstanceRef)),
)

test("pending feature settings apply only at root turn boundaries", () => {
  expect(SessionPrompt.shouldApplyPendingFeatures()).toBe(true)
  expect(SessionPrompt.shouldApplyPendingFeatures({} as unknown as DirectAttemptAuthority)).toBe(false)
})

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        // No user credential: Auth owns credentials and the direct lane only
        // admits the credential-free route.
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

/** Set whenever a test primes its loopback TestLLMServer; the transport double targets it. */
let directTestServerURL: string | undefined

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  directTestServerURL = llm.url
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "legacy prompt rejects a V2-owned Session before persisting the user message",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const before = yield* sessions.messages({ sessionID: chat.id })
      const result = yield* Effect.scoped(
        SessionSupervisor.acquireExecutionOwner(chat.id, "core-v2").pipe(
          Effect.andThen(
            prompt.prompt({
              sessionID: chat.id,
              agent: "build",
              noReply: true,
              parts: [{ type: "text", text: "must not be stored" }],
            }),
          ),
        ),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toMatchObject({
          _tag: "SessionBusyError",
          sessionID: chat.id,
        })
      }
      expect(yield* sessions.messages({ sessionID: chat.id })).toEqual(before)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "applies pending next-turn feature settings before persisting the next root prompt",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Feature apply boundary" })
      const before = yield* config.get()
      expect(before.compaction?.auto ?? true).toBe(true)

      yield* config.updateFeature({ featureId: "compaction.auto", expectedEnabled: null, enabled: false })
      expect((yield* config.get()).compaction?.auto ?? true).toBe(true)

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "apply the pending setting" }],
      })

      expect((yield* config.get()).compaction?.auto).toBe(false)
    }),
  { config: cfg },
)

noLLMServer.instance("legacy command rejects a V2-owned Session before shell interpolation", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const marker = path.join(directory, ".busy-command-shell-expansion")
    yield* writeConfig(directory, {
      ...cfg,
      command: { probe: { template: `Probe !\`touch '${marker}'\`` } },
    })
    const { prompt, chat } = yield* boot()
    const result = yield* Effect.scoped(
      SessionSupervisor.acquireExecutionOwner(chat.id, "core-v2").pipe(
        Effect.andThen(
          prompt.command({
            sessionID: chat.id,
            command: "probe",
            arguments: "",
          }),
        ),
      ),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toMatchObject({
        _tag: "SessionBusyError",
        sessionID: chat.id,
      })
    }
    const fs = yield* FSUtil.Service
    expect(yield* fs.existsSafe(marker)).toBe(false)
  }),
)

raceNoLLMServer.instance(
  "legacy loop holds the Rust effect owner before model execution and releases it on cancel",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      rustOwnerStarts.length = 0
      activeRustOwners.clear()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
          rustOwnerStarts.length = 0
          activeRustOwners.clear()
        }),
      )

      const { prompt, chat, sessions } = yield* boot()
      const database = yield* Database.Service
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "start a guarded turn" }],
      })

      const processorStarted = defer<void>()
      let ownerActiveAtDispatch = false
      processorCreateStarted.push(() => {
        ownerActiveAtDispatch = activeRustOwners.has(chat.id)
        processorStarted.resolve()
      })
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => processorStarted.promise)

      expect(ownerActiveAtDispatch).toBe(true)
      const session = yield* sessions.get(chat.id)
      expect(rustOwnerStarts.at(-1)).toEqual({
        sessionID: chat.id,
        source: database.path,
        workspaceRoot: session.directory,
      })

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(activeRustOwners.has(chat.id)).toBe(false)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits for a completed parent turn with nonmonotonic message IDs",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const userID = MessageID.make("msg_z_user")
      const assistantID = MessageID.make("msg_a_assistant")
      yield* sessions.updateMessage({
        id: userID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: userID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 200, completed: 201 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.id).toBe(assistantID)
    }),
  { config: cfg },
)

it.instance(
  "registry preserves canonical Guard capabilities",
  () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* AgentSvc.Service
      const agent = yield* agents.get("build")
      if (!agent) throw new Error("build agent is unavailable")

      const tools = yield* registry.tools({
        providerID: ref.providerID,
        modelID: ref.modelID,
        agent,
      })
      expect(tools.find((tool) => tool.id === "read")?.capability).toEqual({
        id: "files.read",
        effectClass: "read_only",
      })
      expect(tools.find((tool) => tool.id === "write")?.capability).toEqual({
        id: "files.write",
        effectClass: "effect",
      })
    }),
  { config: cfg },
)

it.instance(
  "model write is withheld when the Rust Guard owner is unavailable",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const filepath = path.join(dir, "guarded-write.txt")
      yield* writeText(filepath, "original")
      const session = yield* sessions.create({
        title: "Guarded write",
        permission: [{ permission: "edit", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "overwrite the file" }],
      })
      yield* llm.tool("write", { filePath: filepath, content: "unapproved" })

      const result = yield* prompt.loop({ sessionID: session.id })
      const content = yield* Effect.promise(() => Bun.file(filepath).text())
      expect(content).toBe("original")
      // A denied full-response batch may expose no tool parts at all.
      // Whether omitted or emitted as error, a denied write must never complete.
      expect(
        result.parts.some((part) => part.type === "tool" && part.tool === "write" && part.state.status === "completed"),
      ).toBe(false)
    }),
  { config: cfg },
)

withRustSupervisor(
  "V1 model write is admitted, approved, and receipted by the real Rust supervisor",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      // The file-backed observer fixture uses a distinct test database.
      // Seed the owning project there before inserting a Session FK.
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const filepath = path.join(dir, "rust-guarded-write.txt")
      yield* writeText(filepath, "original")
      const session = yield* sessions.create({
        title: "Rust guarded write",
        permission: [{ permission: "edit", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "overwrite the file" }],
      })
      yield* llm.tool("write", { filePath: filepath, content: "approved by Rust" })

      const events = yield* EventV2Bridge.Service
      const supervisor = yield* SessionSupervisor.Service
      // The default direct-session mode auto-approves an in-workspace write, so
      // the Guard approval dialog this test exists to observe would never open.
      // Opt this session into prompt-for-every-effect first; the assertions below
      // then cover the real prompt -> allow_once -> lease -> receipt journey.
      yield* supervisor.setDirectSessionPermissionMode({
        sessionID: session.id,
        locationRef: { directory: AbsolutePath.make(dir) },
        sandboxMode: "workspace-write",
        approvalPolicy: "always",
        expectedRevision: "1",
      })
      const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
      const off = yield* events.listen((event) => {
        if (event.type === GuardApprovalRequested.type) {
          Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
        }
        return Effect.void
      })
      yield* Effect.all(
        [
          prompt.loop({ sessionID: session.id }),
          Effect.gen(function* () {
            const request = yield* awaitWithTimeout(
              Queue.take(approvals),
              "timed out waiting for Rust Guard approval",
              "10 seconds",
            )
            expect(request.capabilityID).toBe("files.write")
            expect(request.sessionID).toBe(session.id)
            yield* supervisor.replyGuardApproval({ approvalID: request.approvalID, decision: "allow_once" })
          }),
        ] as const,
        { concurrency: "unbounded" },
      ).pipe(Effect.ensuring(off))
      const content = yield* Effect.promise(() => Bun.file(filepath).text())
      expect(content).toBe("approved by Rust")

      const messages = yield* sessions.messages({ sessionID: session.id })
      const toolCall = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "write")
      expect(toolCall?.type).toBe("tool")
      if (toolCall?.type !== "tool") return
      expect(toolCall.state.status).toBe("completed")
      if (toolCall.state.status !== "completed") return
      expect(toolCall.state.metadata.effectID).toBeString()
      expect(toolCall.state.metadata.receiptDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
    }),
  { config: cfg },
  180000,
)

withRustSupervisor(
  "V1 model bash waits for Rust approval and runs only with a receipted lease",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const events = yield* EventV2Bridge.Service
      const supervisor = yield* SessionSupervisor.Service
      const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
      const off = yield* events.listen((event) => {
        if (event.type === GuardApprovalRequested.type) {
          Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
        }
        return Effect.void
      })

      const runBash = (title: string, command: string, marker: string, decision: "allow_once" | "deny") =>
        Effect.gen(function* () {
          const session = yield* sessions.create({
            title,
            permission: [{ permission: "bash", pattern: "*", action: "allow" }],
          })
            // The default direct-session mode auto-approves an in-workspace terminal
            // run, so the Guard dialog this journey asserts would never open.
            yield* supervisor.setDirectSessionPermissionMode({
              sessionID: session.id,
              locationRef: { directory: AbsolutePath.make(dir) },
              sandboxMode: "workspace-write",
              approvalPolicy: "always",
              expectedRevision: "1",
            })
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: title }],
          })
          yield* llm.tool("bash", { command, timeout: 30_000 })

          const [result] = yield* Effect.all(
            [
              prompt.loop({ sessionID: session.id }),
              Effect.gen(function* () {
                const request = yield* awaitWithTimeout(
                  Queue.take(approvals),
                  "timed out waiting for Rust terminal.run approval",
                  "10 seconds",
                )
                expect(request.capabilityID).toBe("terminal.run")
                expect(request.sessionID).toBe(session.id)
                expect(existsSync(marker)).toBe(false)
                yield* supervisor.replyGuardApproval({ approvalID: request.approvalID, decision })
              }),
            ] as const,
            { concurrency: "unbounded" },
          )
          return { sessionID: session.id, result }
        })

      yield* Effect.gen(function* () {
        const deniedMarker = path.join(dir, "rust-guarded-bash-denied.txt")
        const denied = yield* runBash(
          "Rust-denied bash",
          `printf 'DENIED_MODEL_BASH\\n' && touch '${deniedMarker}'`,
          deniedMarker,
          "deny",
        )
        expect(existsSync(deniedMarker)).toBe(false)
        const deniedMessages = yield* sessions.messages({ sessionID: denied.sessionID })
        expect(
          deniedMessages
            .flatMap((message) => message.parts)
            .some((part) => part.type === "tool" && part.tool === "bash" && part.state.status === "completed"),
        ).toBe(false)

        const approvedMarker = path.join(dir, "rust-guarded-bash-approved.txt")
        const approved = yield* runBash(
          "Rust-approved bash",
          `printf 'APPROVED_MODEL_BASH\\n' && touch '${approvedMarker}'`,
          approvedMarker,
          "allow_once",
        )
        expect(existsSync(approvedMarker)).toBe(true)

        const approvedMessages = yield* sessions.messages({ sessionID: approved.sessionID })
        const toolCall = approvedMessages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "bash")
        expect(toolCall?.type).toBe("tool")
        if (toolCall?.type !== "tool") return
        expect(toolCall.state.status).toBe("completed")
        if (toolCall.state.status !== "completed") return
        expect(toolCall.state.metadata.output).toContain("APPROVED_MODEL_BASH")
        expect(toolCall.state.metadata.receiptRef).toBeString()
        // The settled terminal receipt publishes a structured SourceArtifactV1
        // reference (id + digest + length + media type), never a bare string.
        const artifactRef = toolCall.state.metadata.artifactRef as {
          artifactId: string
          digest: string
          byteLength: string
          mediaType: string
        }
        expect(artifactRef.artifactId).toMatch(/^terminal_[0-9a-f]{64}$/)
        expect(artifactRef.digest).toMatch(/^blake3:[0-9a-f]{64}$/)
        expect(artifactRef.mediaType).toBe("application/octet-stream")
        expect(Number(artifactRef.byteLength)).toBeGreaterThan(0)
        expect(toolCall.state.metadata.truncated).toBe(false)
        expect(approved.result.info.role).toBe("assistant")
      }).pipe(Effect.ensuring(off))
    }),
  { config: cfg },
  180000,
)

withRustSupervisor(
  "provider abort automatically cancels a host-approved but unexecuted batch",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const target = path.join(dir, "provider-cancelled-after-host-approval.txt")
      const session = yield* sessions.create({
        title: "Cancel after host approval",
        permission: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run a command that must be cancelled" }],
      })
      yield* llm.tool("bash", { command: `touch '${target}'`, timeout: 30_000 })

      const events = yield* EventV2Bridge.Service
      const supervisor = yield* SessionSupervisor.Service
      const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
      const off = yield* events.listen((event) => {
        if (event.type === GuardApprovalRequested.type) {
          Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
        }
        return Effect.void
      })

      yield* Effect.addFinalizer(() => off)

      const loop = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
      const request = yield* awaitWithTimeout(
        Queue.take(approvals),
        "timed out waiting for real-host bash approval",
        "10 seconds",
      )
      expect(request.capabilityID).toBe("terminal.run")
      expect(request.sessionID).toBe(session.id)
      expect(existsSync(target)).toBe(false)

      // Advance the durable host challenge to APPROVED while Core is still waiting
      // for its approval reply. Cancelling the provider turn must reach cancel_batch
      // through llm.ts, rather than relying on a test-side cancellation RPC.
      const approved = yield* supervisor.requestHostKernel("effects.v2", "resolve_approval", {
        challengeID: request.challengeID,
        decision: "allow_once",
      })
      expect(approved.status).toBe("approved")
      yield* prompt.cancel(session.id)
      const loopExit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(loopExit)).toBe(true)

      const reconciled = yield* supervisor.requestHostKernel("effects.v2", "reconcile_effect", {
        effectID: request.effectID,
        locationID: request.locationID,
        sessionID: session.id,
      })
      expect(reconciled).toMatchObject({ status: "cancelled", effectID: request.effectID })
      const lateExecute = yield* Effect.exit(
        supervisor.requestHostKernel("effects.v2", "execute_write", {
          sessionID: session.id,
          locationID: request.locationID,
          effectID: request.effectID,
          capabilityLeaseDigest: approved.capabilityLeaseDigest,
          content: "must-not-be-written",
        }),
      )
      expect(Exit.isFailure(lateExecute)).toBe(true)
      expect(existsSync(target)).toBe(false)
    }),
  { config: cfg },
  180000,
)

withRustSupervisor(
  "single slash-command shell interpolation waits for Rust approval and does not spawn when denied",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const marker = path.join(dir, "command-shell-denied-marker")
      yield* writeConfig(dir, {
        ...providerCfg(llm.url),
        command: { probe: { template: `Probe !\`touch '${marker}'\`` } },
      })

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const events = yield* EventV2Bridge.Service
      const supervisor = yield* SessionSupervisor.Service
      const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
      const off = yield* events.listen((event) => {
        if (event.type === GuardApprovalRequested.type) {
          Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      const session = yield* sessions.create({ title: "guarded command interpolation" })
      const command = yield* prompt
        .command({ sessionID: session.id, command: "probe", arguments: "" })
        .pipe(
          Effect.provideService(TrustedPrincipalContext, {
            principal: { kind: "server_auth", subject: "command-interpolation-test" },
          }),
        )
        .pipe(Effect.forkChild)
      const request = yield* awaitWithTimeout(
        Queue.take(approvals),
        "timed out waiting for slash-command terminal.run approval",
        "10 seconds",
      )

      expect(request.capabilityID).toBe("terminal.run")
      expect(request.sessionID).toBe(session.id)
      expect(existsSync(marker)).toBe(false)
      yield* supervisor
        .replyGuardApproval({ approvalID: request.approvalID, decision: "deny" })
        .pipe(
          Effect.provideService(TrustedPrincipalContext, {
            principal: { kind: "server_auth", subject: "command-interpolation-test" },
          }),
        )

      const exit = yield* Fiber.await(command)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(existsSync(marker)).toBe(false)
    }),
  { config: cfg },
  180000,
)

withRustSupervisor(
  "single slash-command shell interpolation executes after Rust approval and returns its outcome",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const marker = path.join(dir, "command-shell-approved-marker")
      const localConfig = providerCfg(llm.url)
      yield* writeConfig(dir, {
        ...localConfig,
        provider: {
          ...localConfig.provider,
          test: {
            ...localConfig.provider.test,
            options: { ...localConfig.provider.test.options, apiKey: "" },
          },
        },
        command: {
          probe: {
            template: `Probe !\`API_TOKEN=interpolation-secret printf 'INTERPOLATION_APPROVED\\n' --password 'private interpolation value'; touch '${marker}'\``,
          },
        },
      })

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(dir), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const events = yield* EventV2Bridge.Service
      const supervisor = yield* SessionSupervisor.Service
      const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
      const off = yield* events.listen((event) => {
        if (event.type === GuardApprovalRequested.type) {
          Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      const session = yield* sessions.create({ title: "approved command interpolation" })
      // The default direct-session mode auto-approves an in-workspace terminal
      // run, so the Guard dialog this journey asserts would never open. A slash
      // command runs under its own explicit ServerAuth subject and a Location is
      // bound to the subject that registered it, so the mode is set under that
      // same principal.
      const commandPrincipal = {
        principal: { kind: "server_auth" as const, subject: "command-interpolation-test" },
      }
      yield* supervisor
        .setDirectSessionPermissionMode({
          sessionID: session.id,
          locationRef: { directory: AbsolutePath.make(dir) },
          sandboxMode: "workspace-write",
          approvalPolicy: "always",
          expectedRevision: "1",
        })
        .pipe(Effect.provideService(TrustedPrincipalContext, commandPrincipal))
      const command = yield* prompt
        .command({ sessionID: session.id, command: "probe", arguments: "", agent: "build", model: "test/test-model" })
        .pipe(Effect.provideService(TrustedPrincipalContext, commandPrincipal))
        .pipe(Effect.forkChild)
      const request = yield* awaitWithTimeout(
        Queue.take(approvals),
        "timed out waiting for slash-command terminal.run approval",
        "10 seconds",
      )

      expect(request.capabilityID).toBe("terminal.run")
      expect(request.sessionID).toBe(session.id)
      expect(request.inputDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
      expect(request.argumentSummary.status).toBe("available")
      if (request.argumentSummary.status !== "available") throw new Error("expected a safe command summary")
      expect(request.argumentSummary.text).toContain("printf")
      expect(request.argumentSummary.text).toContain("API_TOKEN=[redacted]")
      expect(request.argumentSummary.text).toContain("--password [redacted]")
      expect(request.argumentSummary.text).not.toContain("interpolation-secret")
      expect(request.argumentSummary.text).not.toContain("private interpolation value")
      expect(existsSync(marker)).toBe(false)
      yield* supervisor
        .replyGuardApproval({ approvalID: request.approvalID, decision: "allow_once" })
        .pipe(
          Effect.provideService(TrustedPrincipalContext, {
            principal: { kind: "server_auth", subject: "command-interpolation-test" },
          }),
        )

      const exit = yield* Fiber.await(command)
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(existsSync(marker)).toBe(true)
      expect(JSON.stringify(yield* llm.inputs)).toContain("INTERPOLATION_APPROVED")
    }),
  { config: cfg },
  180000,
)

withRustSupervisor(
  "slash-command rejects multiple shell interpolations before any process is dispatched",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const firstMarker = path.join(dir, "command-shell-first-marker")
      const secondMarker = path.join(dir, "command-shell-second-marker")
      yield* writeConfig(dir, {
        ...providerCfg(llm.url),
        command: {
          probe: {
            template: `First !\`touch '${firstMarker}'\` then !\`touch '${secondMarker}'\``,
          },
        },
      })

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const { directory } = yield* TestInstance
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const events = yield* EventV2Bridge.Service
      const supervisor = yield* SessionSupervisor.Service
      const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
      const off = yield* events.listen((event) => {
        if (event.type === GuardApprovalRequested.type) {
          Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      const session = yield* sessions.create({ title: "mixed command interpolation" })
      const observed = yield* Effect.gen(function* () {
        const command = yield* prompt
          .command({ sessionID: session.id, command: "probe", arguments: "" })
          .pipe(
            Effect.provideService(TrustedPrincipalContext, {
              principal: { kind: "server_auth", subject: "command-interpolation-test" },
            }),
          )
          .pipe(Effect.forkChild)
        const first = yield* Effect.raceFirst(
          Fiber.await(command).pipe(Effect.map((exit) => ({ type: "completed" as const, exit }))),
          Queue.take(approvals).pipe(Effect.map((approval) => ({ type: "approval" as const, approval }))),
        )
        let markerAtSecondApproval = false
        let exit: Exit.Exit<unknown, unknown>
        if (first.type === "completed") {
          exit = first.exit
        } else {
          expect(first.approval.capabilityID).toBe("terminal.run")
          yield* supervisor
            .replyGuardApproval({ approvalID: first.approval.approvalID, decision: "allow_once" })
            .pipe(
              Effect.provideService(TrustedPrincipalContext, {
                principal: { kind: "server_auth", subject: "command-interpolation-test" },
              }),
            )
          const second = yield* Effect.raceFirst(
            Fiber.await(command).pipe(Effect.map((result) => ({ type: "completed" as const, exit: result }))),
            Queue.take(approvals).pipe(Effect.map((approval) => ({ type: "approval" as const, approval }))),
          )
          if (second.type === "completed") {
            exit = second.exit
          } else {
            expect(second.approval.capabilityID).toBe("terminal.run")
            markerAtSecondApproval = existsSync(firstMarker)
            yield* supervisor
              .replyGuardApproval({ approvalID: second.approval.approvalID, decision: "deny" })
              .pipe(
                Effect.provideService(TrustedPrincipalContext, {
                  principal: { kind: "server_auth", subject: "command-interpolation-test" },
                }),
              )
            exit = yield* Fiber.await(command)
          }
        }
        return { first, markerAtSecondApproval, exit }
      })
      expect(observed.markerAtSecondApproval).toBe(false)
      expect(existsSync(firstMarker)).toBe(false)
      expect(existsSync(secondMarker)).toBe(false)
      expect(observed.first.type).toBe("completed")
      expect(Exit.isFailure(observed.exit)).toBe(true)
      if (Exit.isFailure(observed.exit)) {
        expect(Cause.squash(observed.exit.cause)).toMatchObject({
          _tag: "SessionSupervisorError",
          stage: "host-kernel",
          reason: "multiple shell interpolations require atomic Guard admission",
        })
      }
    }),
  { config: cfg },
  180000,
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("loop continues when finish is unknown", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("incomplete tool batch with stop finish cannot write", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "incomplete-tool-batch.txt")
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("write", { filePath: file, content: "must not persist" }).stop())

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error).toBeDefined()
    const fs = yield* FSUtil.Service
    expect(yield* fs.existsSafe(file)).toBe(false)
  }),
)

it.instance("persisted subtask fails closed without creating a child session", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(1)
    expect(yield* sessions.children(chat.id)).toHaveLength(0)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") throw new Error("missing subtask result message")

    const tool = errorTool(taskMsg.parts)
    if (!tool) throw new Error("missing failed subtask result")
    expect(tool.state.error).toBe(
      "Agent delegation is unavailable until agents.spawn is mediated by Rust Guard and ExecutionHost.",
    )
    expect(tool.state.metadata).toBeUndefined()
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "unavailable subtask completes as a denial and cancellation leaves no child",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const taskTool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "error") return tool
        }),
        "timed out waiting for the denied subtask result",
      )

      if (taskTool.state.status !== "error") throw new Error("expected failed task tool state")
      expect(taskTool.state.error).toContain("agents.spawn")
      expect(taskTool.state.metadata).toBeUndefined()
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      yield* prompt.cancel(chat.id)
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  5_000,
)

it.instance("model-requested task call does not create a child session", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    yield* user(chat.id, "hello")

    yield* prompt.loop({ sessionID: chat.id })
    expect(yield* sessions.children(chat.id)).toHaveLength(0)
  }),
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Effect origins without the Rust Guard/ExecutionHost boundary stay unavailable.

noLLMServer.instance(
  "legacy session shell is unavailable and never launches a command",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const marker = path.join(directory, ".shell-unavailable")
      const { prompt, chat, run } = yield* boot()
      const exit = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: `touch '${marker}'` })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "SessionSupervisorError",
          stage: "host-kernel",
          reason: "host kernel is unavailable",
        })
      }
      const fs = yield* FSUtil.Service
      expect(yield* fs.existsSafe(marker)).toBe(false)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "slash-command shell interpolation is unavailable and never launches a command",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const marker = path.join(directory, ".command-shell-unavailable")
      yield* writeConfig(directory, {
        ...cfg,
        command: { probe: { template: `Probe !\`touch '${marker}'\`` } },
      })
      const { prompt, chat } = yield* boot()
      const exit = yield* prompt.command({ sessionID: chat.id, command: "probe", arguments: "" }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "SessionSupervisorError",
          stage: "host-kernel",
          reason: "host kernel is unavailable",
        })
      }
      const fs = yield* FSUtil.Service
      expect(yield* fs.existsSafe(marker)).toBe(false)
    }),
  { config: cfg },
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/horizoncode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
