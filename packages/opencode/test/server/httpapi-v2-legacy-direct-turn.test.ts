import { afterAll, afterEach, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { LLMClient, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config as CoreConfig } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionSupervisor, SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Snapshot } from "@opencode-ai/core/snapshot"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"
import { Permission } from "@opencode-ai/schema/permission"
import { Config, ConfigProvider, Deferred, Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { Auth } from "../../src/auth"
import { Provider } from "../../src/provider/provider"
import { ProviderTest } from "../fake/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

/**
 * Legacy direct turns (no managed Attempt, no direct-child Attempt/turn and no
 * caller-supplied §15.2 projection) make no authority claim, so they must reach
 * the ordinary provider credential gate even when the configuration carries NO
 * primary AgentProfileV2 and NO HostKernel permission-mode snapshot is
 * reachable. §15.2 pins are an authority projection: they may never be
 * fabricated, and a turn that claims nothing must not fail at
 * `direct_provider_authority`. Managed/authority-bound turns keep the strict
 * resolver (covered by `test/session/direct-provider-authority.test.ts`).
 */

const testDataParent = path.resolve(import.meta.dir, "../../tmp")
mkdirSync(testDataParent, { recursive: true })
const testDataRoot = mkdtempSync(path.join(testDataParent, "p7-legacy-direct-"))
const databasePath = path.join(testDataRoot, "opencode.db")
const instanceDirectory = path.join(testDataRoot, "instance")
mkdirSync(instanceDirectory)

const testDatabase = makeGlobalNode({
  service: Database.Service,
  layer: Database.layerFromPath(databasePath),
  deps: [],
})

const model = Model.make({ id: "p7-legacy-direct-model", provider: "p7-legacy-direct", route: OpenAIChat.route })
const providerModel = ProviderTest.model({
  id: ModelV2.ID.make(model.id),
  providerID: ProviderV2.ID.make(model.provider),
  api: { id: model.id, url: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible" },
})
const directRoute = {
  routeID: `llm_${"a".repeat(64)}`,
  routeRevision: `llm_${"a".repeat(64)}`,
  endpointRevision: `blake3:${"e".repeat(64)}`,
  endpointBase: "https://api.opencode.ai/v1",
}
const modelLayer = Layer.succeed(
  SessionRunnerModel.Service,
  SessionRunnerModel.Service.of({
    resolve: () => Effect.succeed(model),
    resolveSelection: () =>
      Effect.succeed({
        model,
        directProviderRoute: {
          providerID: model.provider,
          modelID: model.id,
          ...directRoute,
        },
      }),
  }),
)

const configuredProfile = Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2)({
  schemaVersion: 2,
  profileId: "user.p7-legacy-direct",
  revision: "1",
  name: "P7 legacy direct",
  description: "Profile available when the resolver must instead fail on the HostKernel snapshot",
  source: "user",
  roles: ["main"],
  purpose: "Prove a legacy direct turn still falls back when only the HostKernel snapshot is missing",
  whenToUse: "In the P7 legacy direct turn test",
  whenNotToUse: "Never",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: { providerId: model.provider, modelId: model.id },
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
  isolation: "read_only",
  lifecycleHooks: [],
  capabilityCeiling: [],
  limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 1, maxPendingMessages: 1, maxMessageBytes: 4096 },
  maxParallelChildren: 1,
  enabled: true,
})

/** The two E2E-reachable §15.2 gaps: no configured primary profile, or no HostKernel. */
type Scenario = {
  readonly primary: AgentProfileV2.AgentProfileDefinitionV2 | undefined
  readonly snapshot: "reachable" | "unavailable"
}
let scenario: Scenario = { primary: undefined, snapshot: "unavailable" }

const profileReads: (AgentProfileV2.AgentProfileDefinitionV2 | undefined)[] = []
const observations: string[] = []
const stages: string[] = []
const profileLayer = Layer.succeed(
  CoreConfig.AgentProfileService,
  CoreConfig.AgentProfileService.of({
    agentProfiles: () => Effect.die("unused"),
    agentProfileSelectors: () => Effect.succeed([]),
    agentProfile: () => Effect.die("unused"),
    agentProfileSelector: () => Effect.die("unused"),
    primaryAgentProfile: () =>
      Effect.sync(() => {
        observations.push("primary-profile")
        profileReads.push(scenario.primary)
        return scenario.primary
      }),
  }),
)

const buildAgentID = AgentV2.ID.make("build")
const buildAgent = {
  ...AgentV2.Info.empty(buildAgentID),
  mode: "primary" as const,
  permissions: [{ action: "question", resource: "*", effect: "allow" as const } satisfies Permission.Rule],
}
const agentLayer = Layer.mock(AgentV2.Service, {
  select: () => Effect.succeed({ id: buildAgentID, info: buildAgent }),
  resolve: () => Effect.succeed(buildAgent),
})

const permissionPolicyDigest = `sha256:${"0".repeat(64)}`
const permissionScopeDigest = `blake3:${"1".repeat(64)}`
const supervisorLayer = Layer.mock(SessionSupervisor.Service, {
  watchSession: (_sessionID, _source, _workspaceRoot, _turnComplete, ready) => Deferred.succeed(ready, undefined),
  directProviderPermissionScope: (input: { readonly sessionID: string }) =>
    Effect.succeed({
      sessionID: input.sessionID,
      locationID: "loc_direct",
      ownerEpoch: "1",
      permissionScopeDigest,
      policyDigest: permissionPolicyDigest,
    }),
  directSessionPermissionModeSnapshot: (input: { readonly sessionID: string; readonly locationRef: unknown }) =>
    Effect.gen(function* () {
      observations.push("permission-snapshot")
      if (scenario.snapshot === "unavailable") {
        // Exactly what the TypeScript-only `opencode serve` produces when no
        // Rust `hz-kernel` is installed: a typed HostKernel failure.
        return yield* new SessionSupervisorError({ stage: "host-kernel", reason: "host kernel is unavailable" })
      }
      return {
        schemaVersion: 1 as const,
        sessionId: input.sessionID,
        ownerEpoch: "1",
        locationId: "loc_direct",
        workspaceId: "wrk_p7_legacy_direct",
        workspaceRootDigest: `blake3:${"a".repeat(64)}`,
        executionBackendId: "horizon.host",
        policyDigest: permissionPolicyDigest,
        sandboxMode: "read-only" as const,
        approvalPolicy: "on-request" as const,
        source: "default" as const,
        revision: "7",
        digest: permissionScopeDigest,
      }
    }),
})

let providerDispatchCount = 0
const unexpectedProviderDispatch = (message: string) =>
  Effect.sync(() => {
    providerDispatchCount++
    throw new Error(message)
  })
const providerLayer = Layer.mock(Provider.Service, {
  getModel: () => Effect.succeed(providerModel),
  getProvider: () => unexpectedProviderDispatch("unexpected provider resolution before the credential gate"),
  getLanguage: () => unexpectedProviderDispatch("unexpected legacy provider construction before the credential gate"),
  getDirectLanguage: () => unexpectedProviderDispatch("unexpected direct provider construction before the credential gate"),
  getDirectFreeLanguage: () => unexpectedProviderDispatch("unexpected free-provider construction before the credential gate"),
  getManagedLanguage: () => unexpectedProviderDispatch("unexpected managed provider construction before the credential gate"),
})

let clientDispatchCount = 0
const unexpectedClientDispatch = (message: string) =>
  Effect.sync(() => {
    clientDispatchCount++
    throw new Error(message)
  })
const clientLayer = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => unexpectedClientDispatch("unexpected LLM client prepare before the credential gate"),
    stream: ((_request: LLMRequest) => {
      clientDispatchCount++
      return Stream.die(new Error("unexpected LLM client stream before the credential gate"))
    }) as LLMClientShape["stream"],
    generate: () => unexpectedClientDispatch("unexpected LLM client generate before the credential gate"),
  }),
)

const authLayer = Layer.mock(Auth.Service, {
  all: () => Effect.succeed({}),
  get: (providerID: string) =>
    Effect.sync(() => {
      if (providerID !== model.provider) return undefined
      observations.push("auth-lookup")
      return { type: "api", key: "fixture-only-no-dispatch-credential" } satisfies Auth.Info
    }),
})

const replacements = [
  [Database.node, testDatabase],
  [LayerNodePlatform.llmClient, clientLayer],
  [SessionRunnerModel.node, modelLayer],
  [AgentV2.node, agentLayer],
  [SessionSupervisor.node, supervisorLayer],
  [CoreConfig.agentProfileNode, profileLayer],
  [Provider.node, providerLayer],
  [Auth.node, authLayer],
  [Snapshot.node, Snapshot.noopLayer],
] as const

const serverPassword = "p7-legacy-direct-test-password"
const authorization = ServerAuth.header({ username: "opencode", password: serverPassword }) ?? ""
const serverAuthLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: serverPassword }))

const servedRoutes: Layer.Layer<never, Config.ConfigError | SessionSupervisorError, HttpServer.HttpServer> =
  HttpRouter.serve(
    HttpApiApp.createRoutes(undefined, replacements).pipe(Layer.provide(serverAuthLayer)),
    { disableListenLog: true, disableLogger: true },
  )
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(httpApiLayer)

const ServerEvent = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
})

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  headers.set("authorization", authorization)
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  const url = new URL(route, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, { ...init, headers })).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function eventReader(response: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(Stream.runForEach((chunk) => Queue.offer(queue, chunk)), Effect.forkScoped)
    const decoder = new TextDecoder()
    let buffer = ""

    const read = Effect.fnUntraced(function* () {
      while (true) {
        const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
        if (boundary?.index !== undefined) {
          const record = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          const data = record
            .split(/\r\n|\r|\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
          if (data.length > 0) {
            const payload = JSON.parse(data.join("\n")) as Record<string, unknown>
            return Schema.decodeUnknownSync(ServerEvent)({ ...payload, data: payload.properties ?? payload.data })
          }
        }

        const chunk = yield* Queue.take(queue).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.fail(new Error("timed out waiting for a V2 session error")),
          }),
        )
        buffer += decoder.decode(chunk, { stream: true })
      }
    })

    const readType = Effect.fnUntraced(function* (type: string) {
      return yield* Effect.gen(function* () {
        for (let count = 0; count < 100; count++) {
          const event = yield* read()
          if (event.type === type) return event
        }
        return yield* Effect.fail(new Error(`timed out waiting for ${type}`))
      }).pipe(
        Effect.timeoutOrElse({
          duration: "12 seconds",
          orElse: () => Effect.fail(new Error(`timed out waiting for ${type}`)),
        }),
      )
    })

    return { readType }
  })
}

/** Last recorded assistant error message, or undefined while the turn is unset. */
const readAssistantError = (sessionID: string) =>
  Effect.gen(function* () {
    const response = yield* request(`/session/${sessionID}/message`, instanceDirectory).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (response === undefined || response.status !== 200) return undefined
    const body = yield* json<unknown>(response).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (body === undefined || body === null) return undefined
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { data?: unknown }).data)
        ? ((body as { data: unknown[] }).data)
        : Array.isArray((body as { messages?: unknown }).messages)
          ? ((body as { messages: unknown[] }).messages)
          : []
    let last: string | undefined
    for (const row of rows as Record<string, unknown>[]) {
      const info = (row ?? {}).info as Record<string, unknown> | undefined
      if (!info || info.role !== "assistant") continue
      const error = info.error as { message?: unknown; data?: { message?: unknown } } | undefined
      const message =
        typeof error?.message === "string"
          ? error.message
          : typeof error?.data?.message === "string"
            ? error.data.message
            : undefined
      if (typeof message === "string" && message.length > 0) last = message
    }
    return last
  })

/** Bounded raw message dump used only when a gate assertion fails. */
const readRawMessages = (sessionID: string) =>
  request(`/session/${sessionID}/message`, instanceDirectory)
    .pipe(
      Effect.flatMap((response) => json<unknown>(response)),
      Effect.map((body) => JSON.stringify(body).slice(0, 4000)),
      Effect.catch(() => Effect.succeed("<messages unreadable>")),
    )

afterEach(async () => {
  scenario = { primary: undefined, snapshot: "unavailable" }
  profileReads.length = 0
  observations.length = 0
  stages.length = 0
  providerDispatchCount = 0
  clientDispatchCount = 0
  await disposeAllInstances()
  rmSync(databasePath, { force: true })
  rmSync(`${databasePath}-wal`, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
})

afterAll(async () => {
  await disposeAllInstances()
  rmSync(testDataRoot, { recursive: true, force: true })
})

const openSession = (title: string) => Effect.gen(function* () {
  const eventResponse = yield* request("/event", instanceDirectory)
  expect(eventResponse.status).toBe(200)
  const events = yield* eventReader(eventResponse)
  expect((yield* events.readType("server.connected")).type).toBe("server.connected")
  stages.push("event-connected")

  const create = yield* request("/session", instanceDirectory, {
    method: "POST",
    body: JSON.stringify({ agent: "build", title }),
  })
  expect(create.status).toBe(200)
  const session = yield* json<{ id: string }>(create)
  stages.push("session-created")

  // Observations from boot are irrelevant; only the turn under test matters.
  observations.length = 0
  profileReads.length = 0

  const prompt = yield* awaitWithTimeout(
    request(`/session/${session.id}/prompt_async`, instanceDirectory, {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: model.provider, modelID: model.id },
        parts: [{ type: "text", text: "Start one legacy direct turn." }],
      }),
    }),
    "timed out waiting for prompt_async HTTP response",
    "10 seconds",
  ).pipe(
    Effect.map((response) => response.status),
  )
  stages.push(`prompt-async-${prompt}`)
  expect(prompt).toBe(204)
  return session.id
})

const settleAndAssert = (sessionID: string) =>
  Effect.gen(function* () {
    const abort = yield* request(`/session/${sessionID}/abort`, instanceDirectory, { method: "POST" }).pipe(
      Effect.map((response) => response.status),
      Effect.catch(() => Effect.succeed(0)),
    )
    expect(abort).toBe(200)
    yield* pollWithTimeout(
      request("/session/status", instanceDirectory).pipe(
        Effect.flatMap(json<Record<string, { type: string }>>),
        Effect.map((current) => {
          const state = current[sessionID]
          return state === undefined || state.type === "idle" ? true : undefined
        }),
      ),
      "session did not become idle after abort",
      "5 seconds",
    ).pipe(Effect.catch(() => Effect.succeed(true)))
    const failure = yield* readAssistantError(sessionID)
    if (failure !== undefined) expect(failure).not.toContain("direct_provider_authority")
    expect(providerDispatchCount).toBe(0)
    expect(clientDispatchCount).toBe(0)
    return failure
  })

it.live("legacy direct turn without a configured primary AgentProfileV2 reaches the credential gate", () =>
  Effect.gen(function* () {
    scenario = { primary: undefined, snapshot: "unavailable" }
    stages.push("scenario-no-primary-profile")
    const sessionID = yield* openSession("P7 legacy direct without primary profile")

    const reached = yield* pollWithTimeout(
      Effect.gen(function* () {
        if (observations.includes("auth-lookup")) return "credential-gate" as const
        const failure = yield* readAssistantError(sessionID)
        return failure !== undefined ? { assistantError: failure } : undefined
      }),
      "timed out waiting for the legacy direct turn to reach the provider credential gate",
      "15 seconds",
    ).pipe(
      Effect.catch((error) => Effect.succeed({ timeout: String((error as Error).message), observations: [...observations] })),
    )
    if (reached !== "credential-gate") {
      const dump = yield* readRawMessages(sessionID)
      const diagnostic = `reached=${JSON.stringify(reached)} observations=${observations.join(",")} stages=${stages.join(",")} messages=${dump}`
      expect(diagnostic).toBe("credential-gate")
    }
    expect(observations).toContain("auth-lookup")
    const failure = yield* settleAndAssert(sessionID)
    expect(failure === undefined || !failure.includes("direct_provider_authority")).toBe(true)
    stages.push("settled")
  }),
  { timeout: 60000 },
)

it.live("legacy direct turn without a reachable HostKernel permission-mode snapshot reaches the credential gate", () =>
  Effect.gen(function* () {
    scenario = { primary: configuredProfile, snapshot: "unavailable" }
    stages.push("scenario-no-hostkernel-snapshot")
    const sessionID = yield* openSession("P7 legacy direct without HostKernel snapshot")

    const reached = yield* pollWithTimeout(
      Effect.gen(function* () {
        if (observations.includes("auth-lookup")) return "credential-gate" as const
        const failure = yield* readAssistantError(sessionID)
        return failure !== undefined ? { assistantError: failure } : undefined
      }),
      "timed out waiting for the legacy direct turn to reach the provider credential gate",
      "15 seconds",
    ).pipe(
      Effect.catch((error) => Effect.succeed({ timeout: String((error as Error).message), observations: [...observations] })),
    )
    if (reached !== "credential-gate") {
      const dump = yield* readRawMessages(sessionID)
      const diagnostic = `reached=${JSON.stringify(reached)} observations=${observations.join(",")} stages=${stages.join(",")} messages=${dump}`
      expect(diagnostic).toBe("credential-gate")
    }
    expect(observations).toContain("auth-lookup")
    const failure = yield* settleAndAssert(sessionID)
    expect(failure === undefined || !failure.includes("direct_provider_authority")).toBe(true)
    stages.push("settled")
  }),
  { timeout: 60000 },
)