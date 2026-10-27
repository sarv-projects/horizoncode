import { describe, expect } from "bun:test"
import { Effect, Layer, Ref, Schema } from "effect"
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ContextSelectionV1 } from "@opencode-ai/schema/context-selection-v1"
import { LLMError } from "../src"
import { DirectProviderTransport, RequestExecutor } from "../src/route"
import type { DirectProviderRequestContextV1 } from "../src/route"
import { it } from "./lib/effect"

/**
 * Direct-lane route/transport negatives for the pinned executor path.
 *
 * The direct context names exactly one selected route. These tests prove the
 * executor never retries that route, never rewrites it, and above all never
 * silently degrades to the ordinary ambient HTTP client — a direct request
 * that cannot use its transport must fail closed, not fall back to a
 * credentialed or default path. Offline and in-process only: no provider or
 * network call of any kind is made.
 */

const request = HttpClientRequest.post("https://opencode.example/v1/chat/completions").pipe(
  HttpClientRequest.setHeaders(Headers.fromInput({ "content-type": "application/json" })),
)

const digest = (kind: "sha256" | "blake3") => `${kind}:${"a".repeat(64)}`

const contextSelection = Schema.decodeUnknownSync(ContextSelectionV1)({
  schemaVersion: 1,
  lane: "direct",
  sessionID: "ses_direct1",
  requestID: "req_1",
  mode: "fresh",
  sourceRevision: "1",
  sources: [
    {
      kind: "provider-input",
      sourceID: "req_1",
      sourceRevision: "1",
      contentDigest: digest("sha256"),
      sourceAuthority: "core-prompt-compiler",
      trust: "mixed",
      included: true,
      inclusionReason: "current_request",
    },
    {
      kind: "agent-profile",
      sourceID: "builtin.horizon-coding",
      sourceRevision: "1",
      contentDigest: digest("blake3"),
      sourceAuthority: "core-config",
      trust: "system",
      included: true,
      inclusionReason: "profile",
    },
  ],
})

const directContext = (overrides: Partial<DirectProviderRequestContextV1> = {}): DirectProviderRequestContextV1 => ({
  schemaVersion: 1,
  lane: "direct",
  sessionID: "ses_direct1",
  requestID: "req_1",
  sourceRevision: "1",
  profile: {
    profileID: "builtin.horizon-coding",
    revision: "1",
    profileDigest: digest("blake3"),
  },
  permissionScopeDigest: digest("sha256"),
  policyDigest: digest("sha256"),
  providerID: "opencode",
  modelID: "big-pickle",
  harnessID: "native-rich",
  harnessRevision: "1",
  route: {
    routeID: `llm_${"b".repeat(64)}`,
    routeRevision: "route-1",
    endpointRevision: digest("blake3"),
    endpointBase: "https://opencode.example/v1",
  },
  contextSelection,
  pin: () => Effect.fail(new Error("the executor tests never reach a journal pin")),
  ...overrides,
})

const ambientClient = (attempts: Ref.Ref<number>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((input) =>
      Effect.gen(function* () {
        yield* Ref.update(attempts, (value) => value + 1)
        return HttpClientResponse.fromWeb(input, new Response("ambient-ok", { status: 200 }))
      }),
    ),
  )

interface TransportHarness {
  readonly attempts: Ref.Ref<number>
  readonly dispatches: Ref.Ref<number>
  readonly routes: DirectProviderTransport.DirectProviderRouteV1[]
}

type Transport = (input: {
  readonly route: DirectProviderTransport.DirectProviderRouteV1
  readonly request: Request
}) => Effect.Effect<Response, unknown>

const executorLayer = (harness: TransportHarness, transport?: Transport) => {
  const provided = RequestExecutor.layer.pipe(Layer.provide(ambientClient(harness.attempts)))
  if (transport === undefined) return provided
  return provided.pipe(
    Layer.provide(
      Layer.succeed(
        DirectProviderTransport.Service,
        DirectProviderTransport.Service.of({
          dispatch: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(harness.dispatches, (value) => value + 1)
              harness.routes.push(input.route)
              return yield* transport({ route: input.route, request: input.request })
            }),
        }),
      ),
    ),
  )
}

// Annotating the *generator* itself (`function* (): Effect.Effect<…>`) is the
// wrong position: TypeScript then checks every `yield*` operand against that
// annotation and erases the success type, so `yield* makeHarness` resolved to
// `unknown` at all eight call sites. Type the produced value instead — that
// still proves the fixture satisfies `TransportHarness` and keeps each call
// site fully typed without weakening any assertion.
const makeHarness: Effect.Effect<TransportHarness> = Effect.gen(function* () {
  const harness: TransportHarness = {
    attempts: yield* Ref.make(0),
    dispatches: yield* Ref.make(0),
    routes: [],
  }
  return harness
})

const expectLLMError = (error: unknown) => {
  expect(error).toBeInstanceOf(LLMError)
  if (!(error instanceof LLMError)) throw new Error("expected LLMError")
  return error
}

describe("RequestExecutor direct route denial", () => {
  it.effect("fails closed without a transport and never uses the ambient HTTP client", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness
      const error = yield* RequestExecutor.Service.pipe(
        Effect.flatMap((executor) =>
          executor.execute(request, { requestID: "req_1", directContext: directContext() }),
        ),
        Effect.flip,
        Effect.provide(executorLayer(harness)),
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "Transport", message: "Direct provider transport is unavailable" })
      expect(yield* Ref.get(harness.dispatches)).toBe(0)
      expect(yield* Ref.get(harness.attempts)).toBe(0)
    }),
  )

  it.effect("rejects a malformed direct context before any transport or ambient request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness
      const malformed = directContext({
        route: { ...directContext().route, endpointRevision: "not-a-digest" },
      })
      const error = yield* RequestExecutor.Service.pipe(
        Effect.flatMap((executor) =>
          executor.execute(request, { requestID: "req_1", directContext: malformed }),
        ),
        Effect.flip,
        Effect.provide(
          executorLayer(harness, () => Effect.succeed(new Response("must not be reached", { status: 200 }))),
        ),
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({
        _tag: "Transport",
        message: "Authenticated direct provider request context is malformed",
      })
      expect(yield* Ref.get(harness.dispatches)).toBe(0)
      expect(yield* Ref.get(harness.attempts)).toBe(0)
    }),
  )

  it.effect("rejects an endpoint base that is not a bounded absolute URL", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness
      const transport = () => Effect.succeed(new Response("must not be reached", { status: 200 }))
      const reject = (endpointBase: string) =>
        RequestExecutor.Service.pipe(
          Effect.flatMap((executor) =>
            executor.execute(request, {
              requestID: "req_1",
              directContext: directContext({ route: { ...directContext().route, endpointBase } }),
            }),
          ),
          Effect.flip,
          Effect.provide(executorLayer(harness, transport)),
        )

      for (const endpointBase of [
        "opencode.example/v1",
        `https://opencode.example/v1/${"a".repeat(2_100)}`,
      ]) {
        const error = yield* reject(endpointBase)
        expectLLMError(error)
        expect(error.reason).toMatchObject({
          _tag: "Transport",
          message: "Authenticated direct provider request context is malformed",
        })
      }
      expect(yield* Ref.get(harness.dispatches)).toBe(0)
      expect(yield* Ref.get(harness.attempts)).toBe(0)
    }),
  )

  it.effect("rejects a frozen request identity that differs from this call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness
      const error = yield* RequestExecutor.Service.pipe(
        Effect.flatMap((executor) =>
          executor.execute(request, { requestID: "req_other", directContext: directContext() }),
        ),
        Effect.flip,
        Effect.provide(
          executorLayer(harness, () => Effect.succeed(new Response("must not be reached", { status: 200 }))),
        ),
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "Transport" })
      expect(yield* Ref.get(harness.dispatches)).toBe(0)
      expect(yield* Ref.get(harness.attempts)).toBe(0)
    }),
  )

  it.effect("dispatches exactly the pinned route once with no retry and no fallback", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness
      const error = yield* RequestExecutor.Service.pipe(
        Effect.flatMap((executor) =>
          executor.execute(request, { requestID: "req_1", directContext: directContext() }),
        ),
        Effect.flip,
        Effect.provide(
          executorLayer(harness, () =>
            Effect.succeed(
              new Response("rate limited", {
                status: 429,
                headers: { "retry-after-ms": "0" },
              }),
            ),
          ),
        ),
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "RateLimit" })
      // The status is retryable in general, but a pinned direct request is
      // one-shot: it must never be re-dispatched or rerouted by the executor.
      expect(error.retryable).toBe(true)
      expect(yield* Ref.get(harness.dispatches)).toBe(1)
      expect(yield* Ref.get(harness.attempts)).toBe(0)
      expect(harness.routes).toHaveLength(1)
      expect(harness.routes[0]).toMatchObject({
        providerID: "opencode",
        modelID: "big-pickle",
        harnessID: "native-rich",
        endpointBase: "https://opencode.example/v1",
      })
    }),
  )

  it.effect("maps a direct transport denial to a typed error without the ambient client", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness
      const error = yield* RequestExecutor.Service.pipe(
        Effect.flatMap((executor) =>
          executor.execute(request, { requestID: "req_1", directContext: directContext() }),
        ),
        Effect.flip,
        Effect.provide(
          executorLayer(harness, () =>
            Effect.fail(new Error("Direct provider request escaped its fixed selected endpoint")),
          ),
        ),
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "Transport" })
      expect(yield* Ref.get(harness.dispatches)).toBe(1)
      expect(yield* Ref.get(harness.attempts)).toBe(0)
    }),
  )

  it.effect("classifies an unauthorized direct response without retrying it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness
      const error = yield* RequestExecutor.Service.pipe(
        Effect.flatMap((executor) =>
          executor.execute(request, { requestID: "req_1", directContext: directContext() }),
        ),
        Effect.flip,
        Effect.provide(
          executorLayer(harness, () =>
            Effect.succeed(
              new Response("bad key", {
                status: 401,
                headers: { "x-request-id": "req_denied" },
              }),
            ),
          ),
        ),
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "Authentication", kind: "invalid" })
      expect(error.retryable).toBe(false)
      expect(yield* Ref.get(harness.dispatches)).toBe(1)
      expect(yield* Ref.get(harness.attempts)).toBe(0)
    }),
  )

  it.effect("returns the pinned transport response and never the ambient one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness
      const response = yield* RequestExecutor.Service.pipe(
        Effect.flatMap((executor) =>
          executor.execute(request, { requestID: "req_1", directContext: directContext() }),
        ),
        Effect.provide(
          executorLayer(harness, () => Effect.succeed(new Response("direct-ok", { status: 200 }))),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* response.text).toBe("direct-ok")
      expect(yield* Ref.get(harness.dispatches)).toBe(1)
      expect(yield* Ref.get(harness.attempts)).toBe(0)
    }),
  )
})
