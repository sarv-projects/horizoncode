import { afterAll, afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import {
  LLMClient,
  LLMEvent,
  Model,
  type LLMClientShape,
  type LLMEvent as LLMEventType,
  type LLMRequest,
} from "@opencode-ai/llm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { SessionSupervisor, SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Permission } from "@opencode-ai/schema/permission"
import { Config, Deferred, Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
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
const modelLayer = SessionRunnerModel.layerWith(() => Effect.succeed(model))
let scriptedResponses: LLMEventType[][] = []
const llmRequests: LLMRequest[] = []
const clientLayer = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      llmRequests.push(request)
      return Stream.fromIterable(scriptedResponses.shift() ?? [])
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
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

// The question path has no host effects; satisfy the local Session runner's
// observer-readiness handshake without starting a second Rust process here.
const observerLayer = Layer.mock(SessionSupervisor.Service, {
  watchSession: (_sessionID, _source, _workspaceRoot, _turnComplete, ready) => Deferred.succeed(ready, undefined),
})

const replacements = [
  [Database.node, testDatabase],
  [LayerNodePlatform.llmClient, clientLayer],
  [SessionRunnerModel.node, modelLayer],
  [AgentV2.node, agentLayer],
  [SessionSupervisor.node, observerLayer],
] as const

const servedRoutes: Layer.Layer<
  never,
  Config.ConfigError | SessionSupervisorError,
  HttpServer.HttpServer
> = HttpRouter.serve(
  HttpApiApp.createRoutes(undefined, replacements),
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
})
