import { afterAll, afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import {
  LLMClient,
  LLMEvent,
  Model,
  type LLMClientShape,
  type LLMEvent as LLMEventType,
  type LLMRequest,
} from "@horizoncode/llm"
import { AgentV2 } from "@horizoncode/core/agent"
import { Config as CoreConfig } from "@horizoncode/core/config"
import { Database } from "@horizoncode/core/database/database"
import { SessionTable } from "@horizoncode/core/session/sql"
import { eq } from "drizzle-orm"
import { makeGlobalNode } from "@horizoncode/core/effect/app-node"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { EventV2 } from "@horizoncode/core/event"
import { Location } from "@horizoncode/core/location"
import { SessionSupervisor, SessionSupervisorError } from "@horizoncode/core/session/supervisor"
import { SessionRunnerModel } from "@horizoncode/core/session/runner/model"
import { AbsolutePath } from "@horizoncode/core/schema"
import { Snapshot } from "@horizoncode/core/snapshot"
import type * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import { Permission } from "@horizoncode/schema/permission"
import { Config, ConfigProvider, Deferred, Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { OpenAIChat } from "@horizoncode/llm/protocols/openai-chat"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { Question } from "../../src/question"
import { QuestionID } from "../../src/question/schema"
import { SessionID } from "@horizoncode/schema/session-id"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const databaseRoot = mkdtempSync(path.join(tmpdir(), "opencode-v2-question-live-"))
const databasePath = path.join(databaseRoot, "opencode.db")
const testDatabase = makeGlobalNode({
  service: Database.Service,
  layer: Database.layerFromPath(databasePath),
  deps: [],
})

const model = Model.make({ id: "question-live-model", provider: "question-live", route: OpenAIChat.route })
// Trusted catalog route projection consumed by the runner's direct-provider
// admission. The mock transport pins and dispatches through the real journal
// exactly like the production pinned provider fetch (PINNED -> DISPATCHING),
// and Step.Ended settlement commits SETTLED in the same transaction.
const directRoute = {
  routeID: `llm_${"a".repeat(64)}`,
  routeRevision: `llm_${"a".repeat(64)}`,
  endpointRevision: `blake3:${"e".repeat(64)}`,
  endpointBase: "https://api.opencode.ai/v1",
}
const transportRequestDigest = `blake3:${"b".repeat(64)}`
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
let scriptedResponses: LLMEventType[][] = []
const llmRequests: LLMRequest[] = []
let pendingQuestions: Question.Request[] = []
const questionLayer = Layer.succeed(
  Question.Service,
  Question.Service.of({
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("denied question must not be replied to"),
    reject: () => Effect.die("denied question must not be rejected"),
    list: () => Effect.sync(() => pendingQuestions),
  }),
)
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
const clientLayer = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest, executorContext?: MockExecutorContext) => {
      llmRequests.push(request)
      const events = Stream.fromIterable(scriptedResponses.shift() ?? [])
      // A scripted provider response is a real transport dispatch: journal the
      // exact direct-provider request before the stream can emit.
      return Stream.unwrap(
        executorContext!.directContext
          .pin({ endpointRevision: directRoute.endpointRevision, transportRequestDigest })
          .pipe(
            Effect.flatMap((binding) => binding.beginDispatch()),
            Effect.as(events),
          ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

// The direct-provider admission requires the canonical primary AgentProfileV2
// pin for the exact catalog-selected model and a trusted host permission scope.
const primaryProfile = {
  schemaVersion: 2,
  profileId: "user.question-live",
  revision: 1,
  name: "Question live",
  description: "Question live test profile",
  source: "user",
  roles: ["main"],
  purpose: "Exercise the question live path",
  whenToUse: "In tests",
  whenNotToUse: "Never",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: { providerId: model.provider, modelId: model.id },
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
} as unknown as AgentProfileV2.AgentProfileDefinitionV2
const agentProfilesLayer = Layer.succeed(
  CoreConfig.AgentProfileService,
  CoreConfig.AgentProfileService.of({
    agentProfiles: () => Effect.die("unused"),
    agentProfileSelectors: () => Effect.die("unused"),
    agentProfile: () => Effect.die("unused"),
    agentProfileSelector: () => Effect.die("unused"),
    primaryAgentProfile: () => Effect.sync(() => primaryProfile),
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
// The question path has no host effects; satisfy the local Session runner's
// observer-readiness handshake and direct provider permission scope without
// starting a second Rust process here.
const observerLayer = Layer.mock(SessionSupervisor.Service, {
  watchSession: (_sessionID, _source, _workspaceRoot, _turnComplete, ready) => Deferred.succeed(ready, undefined),
  directProviderPermissionScope: (input: { readonly sessionID: string }) =>
    Effect.succeed({
      sessionID: input.sessionID,
      locationID: "loc_direct",
      ownerEpoch: "1",
      permissionScopeDigest,
      policyDigest: permissionPolicyDigest,
    }),
})

const replacements = [
  [Database.node, testDatabase],
  [LayerNodePlatform.llmClient, clientLayer],
  [SessionRunnerModel.node, modelLayer],
  [AgentV2.node, agentLayer],
  [SessionSupervisor.node, observerLayer],
  [CoreConfig.agentProfileNode, agentProfilesLayer],
  [Snapshot.node, Snapshot.noopLayer],
  [Question.node, questionLayer],
] as const

// The production app LayerNode group exposes `WebSearchRuntime.node`, so the
// committed HttpApi route tree builds the real guarded service with no
// boundary stub. This test's prompt turn is answered entirely by the question
// tool, so websearch is never invoked here; an accidental invocation would use
// the real Guard/HostKernel-gated runtime rather than a test double.

// The live question path is a security/authorization acceptance: a foreign
// Session must be denied and question events are only visible to their
// authenticated owner. Configured server auth is therefore part of the tested
// topology, so every request carries the same authenticated principal.
const serverPassword = "question-live-secret"
const authorization = ServerAuth.header({ username: "opencode", password: serverPassword }) ?? ""
const authLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: serverPassword }))

const servedRoutes: Layer.Layer<never, Config.ConfigError | SessionSupervisorError, HttpServer.HttpServer> =
  HttpRouter.serve(
    HttpApiApp.createRoutes(undefined, replacements).pipe(Layer.provide(authLayer)),
    { disableListenLog: true, disableLogger: true },
  )
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(httpApiLayer)

const Event = Schema.Struct({
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
          if (data.length > 0) return Schema.decodeUnknownSync(Event)(JSON.parse(data.join("\n")))
        }

        const chunk = yield* Queue.take(queue).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new Error("timed out waiting for a V2 event")),
          }),
        )
        buffer += decoder.decode(chunk, { stream: true })
      }
    })

    const readType = Effect.fnUntraced(function* (type: string) {
      for (let count = 0; count < 100; count++) {
        const event = yield* read()
        if (event.type === type) return event
      }
      return yield* Effect.fail(new Error(`timed out waiting for ${type}`))
    })

    return { read, readType }
  })
}

function toolCall(
  id: string,
  questions: ReadonlyArray<{
    question: string
    header: string
    options: ReadonlyArray<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>,
) {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolCall({ id, name: "question", input: { questions } }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ]
}

function finalText(text: string) {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "question-followup" }),
    LLMEvent.textDelta({ id: "question-followup", text }),
    LLMEvent.textEnd({ id: "question-followup" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
}

function sessionContext(directory: string, sessionID: string) {
  return request(`/api/session/${sessionID}/context`, directory).pipe(Effect.flatMap(json<{ data: unknown[] }>))
}

function waitForIdle(directory: string, sessionID: string) {
  return pollWithTimeout(
    request("/api/session/active", directory).pipe(
      Effect.flatMap(json<{ data: Record<string, unknown> }>),
      Effect.map((active) => (Object.hasOwn(active.data, sessionID) ? undefined : true)),
    ),
    `session ${sessionID} did not become idle`,
  )
}

afterEach(async () => {
  scriptedResponses = []
  pendingQuestions = []
  llmRequests.length = 0
  await disposeAllInstances()
  rmSync(databasePath, { force: true })
  rmSync(`${databasePath}-wal`, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
})

afterAll(async () => {
  await disposeAllInstances()
  rmSync(databaseRoot, { recursive: true, force: true })
})

describe("V2 question live path", () => {
  it.live("answers Core question.ask through V2 events and denies a foreign session", () =>
    Effect.gen(function* () {
      scriptedResponses = [
        toolCall("call-question-answer", [
          {
            question: "Which API should we use?",
            header: "API",
            options: [
              { label: "Core", description: "Use the Core API" },
              { label: "HTTP", description: "Use the HTTP API" },
            ],
            custom: false,
          },
          {
            question: "Which tests should run?",
            header: "Tests",
            options: [
              { label: "Focused", description: "Run focused tests" },
              { label: "Full", description: "Run the full suite" },
            ],
            multiple: true,
          },
        ]),
        finalText("I will use the Core API and run focused and full tests."),
      ]

      const directory = yield* tmpdirScoped({ git: true })
      const eventResponse = yield* request("/api/event", directory)
      expect(eventResponse.status).toBe(200)
      expect(eventResponse.headers["content-type"]).toContain("text/event-stream")
      const events = yield* eventReader(eventResponse)
      expect((yield* events.read()).type).toBe("server.connected")

      const create = (title: string) =>
        request("/api/session", directory, {
          method: "POST",
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "question-live", id: "question-live-model" },
            location: { directory: AbsolutePath.make(directory) },
            title,
          }),
        })
      const ownerResponse = yield* create("question owner")
      const foreignResponse = yield* create("foreign session")
      expect(ownerResponse.status).toBe(200)
      expect(foreignResponse.status).toBe(200)
      const owner = (yield* json<{ data: { id: string } }>(ownerResponse)).data
      const foreign = (yield* json<{ data: { id: string } }>(foreignResponse)).data

      const prompt = yield* request(`/api/session/${owner.id}/prompt`, directory, {
        method: "POST",
        body: JSON.stringify({ prompt: { text: "Ask me which API and test plan to use." } }),
      })
      expect(prompt.status).toBe(200)

      const asked = yield* events.readType("question.v2.asked")
      const question = asked.data as {
        id: string
        sessionID: string
        questions: ReadonlyArray<{ question: string }>
        tool?: { messageID: string; callID: string }
      }
      expect(question).toMatchObject({
        sessionID: owner.id,
        questions: [
          { question: "Which API should we use?" },
          { question: "Which tests should run?" },
        ],
        tool: { callID: "call-question-answer" },
      })

      const foreignReply = yield* request(`/api/session/${foreign.id}/question/${question.id}/reply`, directory, {
        method: "POST",
        body: JSON.stringify({ answers: [["HTTP"], ["Full"]] }),
      })
      expect(foreignReply.status).toBe(404)
      const invalidReply = yield* request(`/api/session/${owner.id}/question/${question.id}/reply`, directory, {
        method: "POST",
        body: JSON.stringify({ answers: [["not-an-option"], ["Full"]] }),
      })
      expect(invalidReply.status).toBe(400)
      expect(
        yield* json<{ data: Array<{ id: string }> }>(
          yield* request(`/api/session/${owner.id}/question`, directory),
        ),
      ).toMatchObject({ data: [{ id: question.id }] })

      const answers = [["Core"], ["Focused", "Full"]]
      const reply = yield* request(`/api/session/${owner.id}/question/${question.id}/reply`, directory, {
        method: "POST",
        body: JSON.stringify({ answers }),
      })
      expect(reply.status).toBe(204)
      expect(yield* events.readType("question.v2.replied")).toMatchObject({
        data: { sessionID: owner.id, requestID: question.id, answers },
      })

      yield* waitForIdle(directory, owner.id)
      expect(llmRequests).toHaveLength(2)
      expect(llmRequests[1]?.messages.at(-1)).toMatchObject({
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call-question-answer",
            result: {
              type: "text",
              value:
                'User has answered your questions: "Which API should we use?"="Core", "Which tests should run?"="Focused, Full". You can now continue with the user\'s answers in mind.',
            },
          },
        ],
      })
      const context = yield* sessionContext(directory, owner.id)
      expect(JSON.stringify(context.data)).toContain("I will use the Core API and run focused and full tests.")
    }),
  )

  it.live("rejects a Core question.ask through the V2 route without continuing the model turn", () =>
    Effect.gen(function* () {
      scriptedResponses = [
        toolCall("call-question-dismiss", [
          {
            question: "Continue with the proposed change?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ]),
      ]

      const directory = yield* tmpdirScoped({ git: true })
      const eventResponse = yield* request("/api/event", directory)
      const events = yield* eventReader(eventResponse)
      expect((yield* events.read()).type).toBe("server.connected")

      const created = yield* request("/api/session", directory, {
        method: "POST",
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "question-live", id: "question-live-model" },
          location: { directory: AbsolutePath.make(directory) },
        }),
      })
      const session = (yield* json<{ data: { id: string } }>(created)).data
      const prompt = yield* request(`/api/session/${session.id}/prompt`, directory, {
        method: "POST",
        body: JSON.stringify({ prompt: { text: "Ask before continuing." } }),
      })
      expect(prompt.status).toBe(200)

      const asked = yield* events.readType("question.v2.asked")
      const question = asked.data as { id: string; sessionID: string }
      const rejected = yield* request(`/api/session/${session.id}/question/${question.id}/reject`, directory, {
        method: "POST",
      })
      expect(rejected.status).toBe(204)
      expect(yield* events.readType("question.v2.rejected")).toMatchObject({
        data: { sessionID: session.id, requestID: question.id },
      })

      yield* waitForIdle(directory, session.id)
      expect(llmRequests).toHaveLength(1)
      const context = yield* sessionContext(directory, session.id)
      expect(JSON.stringify(context.data)).toContain("Tool execution interrupted")
      expect(yield* json<{ data: unknown[] }>(yield* request(`/api/session/${session.id}/question`, directory))).toEqual({
        data: [],
      })
    }),
  )

  it.live("fails closed when a matching child owner has a conflicting ancestor", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const create = (title: string) =>
        request("/api/session", directory, {
          method: "POST",
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "question-live", id: "question-live-model" },
            location: { directory: AbsolutePath.make(directory) },
            title,
          }),
        })
      const rootResponse = yield* create("question ancestry root")
      const childResponse = yield* create("question ancestry child")
      const root = (yield* json<{ data: { id: string } }>(rootResponse)).data
      const child = (yield* json<{ data: { id: string } }>(childResponse)).data
      const sid = (id: string) => SessionID.make(id)
      const updateSession = (id: string, values: Partial<typeof SessionTable.$inferInsert>) =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.update(SessionTable).set(values).where(eq(SessionTable.id, sid(id))).run().pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.layerFromPath(databasePath)))
      const readSession = (id: string) =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid(id))).get().pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.layerFromPath(databasePath)))
      const matchingOwner = (yield* readSession(root.id))?.metadata?.horizonPrincipalOwner
      expect(matchingOwner).toBeDefined()
      yield* updateSession(child.id, { parent_id: sid(root.id) })

      const question = {
        id: QuestionID.ascending(),
        sessionID: sid(child.id),
        questions: [
          {
            question: "What is the confidential deployment target?",
            header: "Deployment",
            options: [{ label: "private-cluster", description: "Internal target" }],
            custom: false,
          },
        ],
      } satisfies Question.Request
      pendingQuestions = [question]

      const sameOwnerList = yield* request("/question", directory)
      expect(sameOwnerList.status).toBe(200)
      expect(JSON.stringify(yield* json(sameOwnerList))).toContain(question.id)

      yield* updateSession(root.id, {
        metadata: { horizonPrincipalOwner: { kind: "server_auth", subject: "different-user" } },
      })
      expect((yield* readSession(child.id))?.parent_id).toBe(sid(root.id))
      expect((yield* readSession(root.id))?.metadata?.horizonPrincipalOwner).toEqual({
        kind: "server_auth",
        subject: "different-user",
      })

      const listed = yield* request("/question", directory)
      expect(listed.status).toBe(200)
      const listBody = JSON.stringify(yield* json(listed))
      expect(listBody).not.toContain(question.id)
      expect(listBody).not.toContain("confidential deployment target")
      expect(listBody).not.toContain("private-cluster")

      const reply = yield* request(`/question/${question.id}/reply`, directory, {
        method: "POST",
        body: JSON.stringify({ answers: [["private-cluster"]] }),
      })
      expect(reply.status).toBe(404)
      const replyBody = yield* reply.text
      expect(replyBody).not.toContain("confidential deployment target")
      expect(replyBody).not.toContain("private-cluster")

      const reject = yield* request(`/question/${question.id}/reject`, directory, {
        method: "POST",
      })
      expect(reject.status).toBe(404)
      const rejectBody = yield* reject.text
      expect(rejectBody).not.toContain("confidential deployment target")
      expect(rejectBody).not.toContain("private-cluster")
      pendingQuestions = []
    }),
  )

  it.live("SSE hides a question event after conflicting ancestor update", () =>
    Effect.gen(function* () {
      scriptedResponses = [
        toolCall("call-sse-question-before", [
          { question: "What is the visible child question?", header: "Before", options: [{ label: "Visible", description: "Visible" }] },
        ]),
        finalText("The owner answered the visible question."),
        toolCall("call-sse-question-after", [
          { question: "What is the confidential SSE deployment target?", header: "After", options: [{ label: "Hidden", description: "Hidden" }] },
        ]),
      ]
      const directory = yield* tmpdirScoped({ git: true })
      const eventResponse = yield* request("/api/event", directory)
      expect(eventResponse.status).toBe(200)
      const events = yield* eventReader(eventResponse)
      expect((yield* events.read()).type).toBe("server.connected")
      const create = (title: string) =>
        request("/api/session", directory, {
          method: "POST",
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "question-live", id: "question-live-model" },
            location: { directory: AbsolutePath.make(directory) },
            title,
          }),
        })
      const rootResponse = yield* create("SSE ancestry root")
      const childResponse = yield* create("SSE ancestry child")
      const conflictingChildResponse = yield* create("SSE ancestry conflicting child")
      const root = (yield* json<{ data: { id: string } }>(rootResponse)).data
      const child = (yield* json<{ data: { id: string } }>(childResponse)).data
      const conflictingChild = (yield* json<{ data: { id: string } }>(conflictingChildResponse)).data
      const sid = (id: string) => SessionID.make(id)
      const updateSession = (id: string, values: Partial<typeof SessionTable.$inferInsert>) =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.update(SessionTable).set(values).where(eq(SessionTable.id, sid(id))).run().pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.layerFromPath(databasePath)))
      const readSession = (id: string) =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid(id))).get().pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.layerFromPath(databasePath)))
      const matchingOwner = (yield* readSession(root.id))?.metadata?.horizonPrincipalOwner
      expect(matchingOwner).toBeDefined()
      yield* updateSession(child.id, { parent_id: sid(root.id) })
      yield* updateSession(conflictingChild.id, { parent_id: sid(root.id) })
      const prompt = (sessionID: string) =>
        request(`/api/session/${sessionID}/prompt`, directory, {
          method: "POST",
          body: JSON.stringify({ prompt: { text: "Ask the configured question." } }),
        })
      expect((yield* prompt(child.id)).status).toBe(200)
      const sameOwner = yield* events.readType("question.v2.asked")
      expect(JSON.stringify(sameOwner.data)).toContain("What is the visible child question?")
      const sameOwnerQuestion = sameOwner.data as { id: string }
      expect((yield* request(`/api/session/${child.id}/question/${sameOwnerQuestion.id}/reply`, directory, {
        method: "POST",
        body: JSON.stringify({ answers: [["Visible"]] }),
      })).status).toBe(204)
      yield* waitForIdle(directory, child.id)

      yield* updateSession(root.id, {
        metadata: { horizonPrincipalOwner: { kind: "server_auth", subject: "different-user" } },
      })
      expect((yield* readSession(child.id))?.parent_id).toBe(sid(root.id))
      expect((yield* readSession(conflictingChild.id))?.parent_id).toBe(sid(root.id))
      expect((yield* readSession(root.id))?.metadata?.horizonPrincipalOwner).toEqual({
        kind: "server_auth",
        subject: "different-user",
      })
      expect((yield* prompt(conflictingChild.id)).status).toBe(200)
      yield* pollWithTimeout(
        Effect.sync(() => (llmRequests.length >= 3 ? true : undefined)),
        "conflicting child did not dispatch its scripted question turn",
      )
      const sentinelResponse = yield* create("SSE ancestry sentinel")
      expect(sentinelResponse.status).toBe(200)
      const sentinel = (yield* json<{ data: { id: string } }>(sentinelResponse)).data
      let sawSentinel = false
      let sawQuestionAfterConflict = false
      for (let count = 0; count < 100 && !sawSentinel; count++) {
        const event = yield* events.read()
        const body = JSON.stringify(event.data)
        if (event.type === "question.v2.asked") {
          sawQuestionAfterConflict = true
          expect((event.data as { sessionID: string }).sessionID).toBe(conflictingChild.id)
          expect(body).not.toContain("What is the confidential SSE deployment target?")
        }
        sawSentinel = event.type === "session.created" && body.includes(sentinel.id)
      }
      expect(sawQuestionAfterConflict).toBe(false)
      expect(sawSentinel).toBe(true)
    }),
    20_000,
  )

  it.live(
    "question ancestry fails closed for a depth overflow, foreign directory, foreign workspace, and a cycle",
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const otherDirectory = yield* tmpdirScoped({ git: true })
        const create = (title: string) =>
          request("/api/session", directory, {
            method: "POST",
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "question-live", id: "question-live-model" },
              location: { directory: AbsolutePath.make(directory) },
              title,
            }),
          })
        const sid = (id: string) => SessionID.make(id)
        const updateSession = (id: string, values: Partial<typeof SessionTable.$inferInsert>) =>
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* db.update(SessionTable).set(values).where(eq(SessionTable.id, sid(id))).run().pipe(Effect.orDie)
          }).pipe(Effect.provide(Database.layerFromPath(databasePath)))
        const attach = (from: string, to: string | null) =>
          updateSession(from, { parent_id: to === null ? null : sid(to) })

        const ids: string[] = []
        for (let index = 0; index < 34; index++) {
          const response = yield* create(`qa007 ancestry ${index}`)
          expect(response.status).toBe(200)
          ids.push((yield* json<{ data: { id: string } }>(response)).data.id)
        }
        // ids[0] is the question session; ids[1..] are its ancestors.
        const chainThrough = (last: number) =>
          Effect.gen(function* () {
            for (let index = 0; index < last; index++) yield* attach(ids[index]!, ids[index + 1]!)
            yield* attach(ids[last]!, null)
            for (let index = last + 1; index < ids.length; index++) yield* attach(ids[index]!, null)
          })
        const questionOn = (sessionID: string) => {
          pendingQuestions = [
            {
              id: QuestionID.ascending(),
              sessionID: sid(sessionID),
              questions: [
                {
                  question: "What is the confidential deployment target?",
                  header: "Deployment",
                  options: [{ label: "private-cluster", description: "Internal target" }],
                  custom: false,
                },
              ],
            } satisfies Question.Request,
          ]
        }
        const list = () => request("/question", directory)
        const expectHidden = Effect.gen(function* () {
          const listed = yield* list()
          expect(listed.status).toBe(200)
          const body = JSON.stringify(yield* json(listed))
          expect(body).not.toContain("confidential deployment target")
          expect(body).not.toContain("private-cluster")
        })
        const requestOnQuestion = (suffix: string) =>
          request(`/question/${pendingQuestions[0]!.id}${suffix}`, directory, {
            method: "POST",
            ...(suffix === "/reply" ? { body: JSON.stringify({ answers: [["private-cluster"]] }) } : {}),
          })

        // Positive control: the owner chain exactly at the 32-level bound stays usable.
        yield* chainThrough(31)
        questionOn(ids[0]!)
        const visible = yield* list()
        expect(visible.status).toBe(200)
        expect(JSON.stringify(yield* json(visible))).toContain(pendingQuestions[0]!.id)

        // Depth overflow: one level past the bound fails closed, and neither
        // reply nor reject may reach the Question service.
        yield* chainThrough(33)
        yield* expectHidden
        for (const suffix of ["/reply", "/reject"] as const) {
          const response = yield* requestOnQuestion(suffix)
          expect(response.status).toBe(404)
          expect(response.text).not.toContain("private-cluster")
        }

        // Directory: a question session recorded outside this instance directory.
        yield* chainThrough(31)
        yield* updateSession(ids[0]!, { directory: otherDirectory })
        yield* expectHidden
        yield* updateSession(ids[0]!, { directory })

        // Workspace: a question session bound to a different workspace.
        yield* updateSession(ids[0]!, { workspace_id: "ws_qa007_foreign" as never })
        yield* expectHidden
        yield* updateSession(ids[0]!, { workspace_id: null })

        // Cycle: a parent chain that never reaches a root.
        yield* attach(ids[0]!, ids[1]!)
        yield* attach(ids[1]!, ids[0]!)
        yield* expectHidden
        for (const suffix of ["/reply", "/reject"] as const) {
          const response = yield* requestOnQuestion(suffix)
          expect(response.status).toBe(404)
          expect(response.text).not.toContain("private-cluster")
        }

        pendingQuestions = []
      }),
    60_000,
  )

})
