import { afterAll, afterEach, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { LLMClient, Model, type LLMClientShape, type LLMRequest } from "@horizoncode/llm"
import { AgentV2 } from "@horizoncode/core/agent"
import { Config as CoreConfig } from "@horizoncode/core/config"
import { Database } from "@horizoncode/core/database/database"
import { makeGlobalNode } from "@horizoncode/core/effect/app-node"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { EventV2 } from "@horizoncode/core/event"
import { Location } from "@horizoncode/core/location"
import { ModelV2 } from "@horizoncode/core/model"
import { ProviderV2 } from "@horizoncode/core/provider"
import { SessionSupervisor, SessionSupervisorError } from "@horizoncode/core/session/supervisor"
import { SessionRunnerModel } from "@horizoncode/core/session/runner/model"
import { Snapshot } from "@horizoncode/core/snapshot"
import * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import { Permission } from "@horizoncode/schema/permission"
import { Config, ConfigProvider, Deferred, Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { OpenAIChat } from "@horizoncode/llm/protocols/openai-chat"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { Auth } from "../../src/auth"
import { Provider } from "../../src/provider/provider"
import { ProviderTest } from "../fake/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

// Keep the test database and instance inside the repository workspace.
const testDataParent = path.resolve(import.meta.dir, "../../tmp")
mkdirSync(testDataParent, { recursive: true })
const testDataRoot = mkdtempSync(path.join(testDataParent, "p7-direct-profile-map-"))
const databasePath = path.join(testDataRoot, "opencode.db")
const instanceDirectory = path.join(testDataRoot, "instance")
mkdirSync(instanceDirectory)

const testDatabase = makeGlobalNode({
  service: Database.Service,
  layer: Database.layerFromPath(databasePath),
  deps: [],
})

const model = Model.make({ id: "p7-profile-map-model", provider: "p7-profile-map", route: OpenAIChat.route })
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

const replacementProfile = Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2)({
  schemaVersion: 2,
  profileId: "user.p7-direct-profile-map",
  revision: "1",
  name: "P7 direct profile map",
  description: "App LLM location-map integration test profile",
  source: "user",
  roles: ["main"],
  purpose: "Prove the App LLM reads the route's exact profile replacement",
  whenToUse: "In the P7 route composition test",
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

const profileReads: AgentProfileV2.AgentProfileDefinitionV2[] = []
const observations: string[] = []
const stages: string[] = []
const profileLayer = Layer.succeed(
  CoreConfig.AgentProfileService,
  CoreConfig.AgentProfileService.of({
    agentProfiles: () => Effect.die("unused"),
    // Tool discovery lists configured subagent selectors before the direct-turn profile gate.
    agentProfileSelectors: () =>
      Effect.sync(() => {
        observations.push("profile-selectors")
        return []
      }),
    agentProfile: () => Effect.die("unused"),
    agentProfileSelector: () => Effect.die("unused"),
    primaryAgentProfile: () =>
      Effect.sync(() => {
        observations.push("profile")
        profileReads.push(replacementProfile)
        return replacementProfile
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
    Effect.sync(() => {
      observations.push("permission-snapshot")
      return {
        schemaVersion: 1 as const,
        sessionId: input.sessionID,
        ownerEpoch: "1",
        locationId: "loc_direct",
        workspaceId: "wrk_p7_direct_profile_map",
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
  // Model lookup is local fixture data; all transport/provider construction is trapped.
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

const serverPassword = "p7-direct-profile-map-test-password"
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

afterEach(async () => {
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

it.live("reads the route's exact AgentProfileV2 replacement before the credential gate without dispatch", () =>
  Effect.gen(function* () {
    const eventResponse = yield* request("/event", instanceDirectory)
    expect(eventResponse.status).toBe(200)
    expect(eventResponse.headers["content-type"]).toContain("text/event-stream")
    const events = yield* eventReader(eventResponse)
    expect((yield* events.readType("server.connected")).type).toBe("server.connected")
    stages.push("event-connected")

    const create = yield* request("/session", instanceDirectory, {
      method: "POST",
      body: JSON.stringify({ agent: "build", title: "P7 direct profile map" }),
    })
    expect(create.status).toBe(200)
    const session = yield* json<{ id: string }>(create)

    stages.push("session-created")
    let promptStatus: number | undefined
    let promptContentType: string | undefined
    let promptBody = ""
    const failWithDiagnostic = (cause: unknown) =>
      Effect.gen(function* () {
        const snapshot = (route: string) =>
          awaitWithTimeout(
            request(route, instanceDirectory).pipe(Effect.flatMap(json<unknown>)),
            `timed out reading ${route}`,
            "2 seconds",
          ).pipe(Effect.exit)
        const sessionSnapshot = yield* snapshot(`/session/${session.id}`)
        const messagesSnapshot = yield* snapshot(`/session/${session.id}/message`)
        const statusSnapshot = yield* snapshot("/session/status")
        const abortSnapshot = yield* awaitWithTimeout(
          request(`/session/${session.id}/abort`, instanceDirectory, { method: "POST" }).pipe(
            Effect.map((response) => response.status),
          ),
          "timed out aborting session after diagnostic snapshot",
          "2 seconds",
        ).pipe(Effect.exit)
        const diagnostic = {
          cause: String(cause),
          stages: [...stages],
          promptStatus,
          promptContentType,
          promptBody: promptBody.slice(0, 512),
          profileReads: profileReads.map((profile) => ({ profileId: profile.profileId, revision: profile.revision })),
          observations: [...observations],
          authLookupCount: observations.filter((value) => value === "auth-lookup").length,
          providerDispatchCount,
          clientDispatchCount,
          sessionSnapshot,
          messagesSnapshot,
          statusSnapshot,
          abortSnapshot,
        }
        return yield* Effect.fail(new Error(`P7 direct-profile diagnostics: ${JSON.stringify(diagnostic).slice(0, 4096)}`))
      })

    stages.push("prompt-async-request-start")
    const prompt = yield* awaitWithTimeout(
      request(`/session/${session.id}/prompt_async`, instanceDirectory, {
        method: "POST",
        body: JSON.stringify({
          agent: "build",
          model: { providerID: model.provider, modelID: model.id },
          parts: [{ type: "text", text: "Start one direct turn; the credential gate must stop it." }],
        }),
      }),
      "timed out waiting for prompt_async HTTP response",
      "10 seconds",
    ).pipe(
      Effect.catch((error) => {
        stages.push("prompt-async-request-timeout")
        return failWithDiagnostic(error)
      }),
    )
    promptStatus = prompt.status
    promptContentType = prompt.headers["content-type"]
    promptBody = yield* prompt.text
    stages.push("prompt-async-response")
    if (prompt.status !== 204) return yield* failWithDiagnostic(`prompt HTTP ${prompt.status}`)

    stages.push("auth-boundary-wait-start")
    yield* pollWithTimeout(
      Effect.sync(() => {
        const profile = observations.lastIndexOf("profile")
        const permission = observations.lastIndexOf("permission-snapshot")
        const authLookup = observations.lastIndexOf("auth-lookup")
        return profile >= 0 && permission > profile && authLookup > permission ? true : undefined
      }),
      "timed out waiting for profile → permission snapshot → auth lookup",
      "10 seconds",
    ).pipe(
      Effect.catch((error) => {
        stages.push("auth-boundary-timeout")
        return failWithDiagnostic(error)
      }),
    )
    stages.push("auth-boundary-observed")

    // The local credential denial is retried by the legacy SessionRetry policy;
    // abort as soon as its first pre-dispatch boundary is observed.
    const abort = yield* request(`/session/${session.id}/abort`, instanceDirectory, { method: "POST" }).pipe(
      Effect.catch((error) => failWithDiagnostic(error)),
    )
    expect(abort.status).toBe(200)
    expect(yield* json<boolean>(abort)).toBe(true)
    stages.push("session-abort-returned")

    yield* pollWithTimeout(
      request("/session/status", instanceDirectory).pipe(
        Effect.flatMap(json<Record<string, { type: string }>>),
        Effect.map((current) => {
          const state = current[session.id]
          return state === undefined || state.type === "idle" ? true : undefined
        }),
      ),
      "session did not become idle after abort",
      "5 seconds",
    ).pipe(
      Effect.catch((error) => {
        stages.push("session-idle-timeout")
        return failWithDiagnostic(error)
      }),
    )
    stages.push("session-idle")

    expect(profileReads).toContain(replacementProfile)
    const profileObservation = observations.lastIndexOf("profile")
    const snapshotObservation = observations.lastIndexOf("permission-snapshot")
    const authObservation = observations.lastIndexOf("auth-lookup")
    expect(profileObservation).toBeGreaterThanOrEqual(0)
    expect(snapshotObservation).toBeGreaterThan(profileObservation)
    expect(authObservation).toBeGreaterThan(snapshotObservation)
    expect(providerDispatchCount).toBe(0)
    expect(clientDispatchCount).toBe(0)
  }),
)
