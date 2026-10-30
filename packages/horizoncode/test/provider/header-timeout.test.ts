import { afterEach, expect } from "bun:test"
import { createServer, type Server } from "node:http"
import { streamText } from "ai"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import type { SecretBrokerV1 } from "@horizoncode/schema/secret-broker-v1"
import { Auth } from "@/auth"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

// §30.26 managed mock harness: these suites exercise SDK request plumbing
// (timeouts, abort signals, gateway routing) for providers whose credentials
// live behind SecretBroker. The mock issues an opaque lease reference so the
// route projection is exercised end-to-end; no credential bytes, credential
// write, HostKernel permit, or real provider dispatch is involved — requests
// only reach the in-test loopback/gateway double through the passed fetch.
const managedAuthNode = (refs: Partial<Record<string, SecretBrokerV1.SecretRef>>) =>
  LayerNode.make({
    service: Auth.Service,
    layer: Layer.mock(Auth.Service, {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      credentialRefsForProviders: () => Effect.succeed(refs),
    }),
    deps: [],
    tag: Auth.node.tag,
  })

const itManaged = testEffect(
  LayerNode.compile(
    LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node, Auth.node]),
    [[Auth.node, managedAuthNode({
      test: "p6-managed-ref" as SecretBrokerV1.SecretRef,
      "cloudflare-ai-gateway": "p6-managed-ref" as SecretBrokerV1.SecretRef,
    })]],
  ),
)

itManaged.live("headerTimeout does not abort delayed SSE body after headers arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(1_000)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getManagedLanguage({ model, harnessID: "native-rich", fetch: globalThis.fetch }),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("late")
        }),
      { config: providerConfig(server.url, { headerTimeout: 500 }) },
    )
  }),
)

for (const timeout of ["chunkTimeout", "headerTimeout"] as const) {
  itManaged.live(`default ${timeout} is applied at fetch without changing provider options`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => delayedBodyServer(250)),
        (server) => Effect.sync(() => server.server.close()),
      )

      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
            const signals: (AbortSignal | null | undefined)[] = []
            const spyFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
              signals.push(init?.signal)
              return fetch(input, init)
            }) as typeof fetch
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const language = yield* provider.getManagedLanguage({ model, harnessID: "native-rich", fetch: spyFetch })
            yield* Effect.acquireRelease(
              Effect.promise(() =>
                language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
              ),
              (result) => Effect.promise(() => result.stream.cancel()),
            )

            expect(signals).toHaveLength(1)
            expect(signals[0]).toBeInstanceOf(AbortSignal)
            expect(configured.options[timeout]).toBeUndefined()
          }),
        {
          config: providerConfig(server.url, {
            [timeout === "chunkTimeout" ? "headerTimeout" : "chunkTimeout"]: false,
          }),
        },
      )
    }),
  )
}

itManaged.live("configured chunkTimeout raises a retryable response stream error when SSE body stalls", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getManagedLanguage({ model, harnessID: "native-rich", fetch: globalThis.fetch }),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const error = yield* Effect.promise(async () => {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "error") return part.error
              }
            } catch (error) {
              return error
            }
          })
          expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
          expect(
            SessionRetry.retryable(MessageV2.fromError(error, { providerID: model.providerID }), model.providerID),
          ).toEqual({ message: "SSE read timed out" })
        }),
      { config: providerConfig(server.url, { chunkTimeout: 50 }) },
    )
  }),
)

itManaged.live("chunkTimeout can be disabled with false", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
          expect(configured.options.chunkTimeout).toBe(false)
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getManagedLanguage({ model, harnessID: "native-rich", fetch: globalThis.fetch }),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("late")
        }),
      { config: providerConfig(server.url, { chunkTimeout: false }) },
    )
  }),
)

itManaged.live("headerTimeout aborts when response headers do not arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getManagedLanguage({ model, harnessID: "native-rich", fetch: globalThis.fetch }),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const errors = yield* Effect.promise(async () => {
            const errors: string[] = []
            for await (const part of result.fullStream) {
              if (part.type === "error") errors.push(String(part.error))
            }
            return errors
          })
          expect(errors.join("\n")).toContain("response headers timed out")
        }),
      { config: providerConfig(server.url, { headerTimeout: 50 }) },
    )
  }),
)

itManaged.live("headerTimeout can be disabled with false for non-OpenAI providers", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(100)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getManagedLanguage({ model, harnessID: "native-rich", fetch: globalThis.fetch }),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("ok")
        }),
      { config: providerConfig(server.url, { headerTimeout: false }) },
    )
  }),
)

it.live("OpenAI Codex header and chunk timeout defaults can be disabled by config", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              const openai = yield* provider.getProvider(ProviderV2.ID.openai)
              expect(openai.options.headerTimeout).toBe(false)
              expect(openai.options.chunkTimeout).toBe(false)
            }),
          { config: { provider: { openai: { options: { headerTimeout: false, chunkTimeout: false } } } } },
        )
      }),
    )
  }),
)

it.live("OpenAI API auth gets default headerTimeout", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        const previousKey = process.env.OPENAI_API_KEY
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              // Seed providers[openai] through the environment path BEFORE the
              // custom loader runs, so the authenticated-openai default lands
              // without depending on the host's Models.dev cache.
              yield* Env.use.set("OPENAI_API_KEY", "sk-test-api")
              const provider = yield* Provider.Service
              const openai = yield* provider.getProvider(ProviderV2.ID.openai)
              expect(openai.options.headerTimeout).toBe(300_000)
            }),
        )
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = previousKey
      }),
      { openai: { type: "api", key: "sk-test" } },
    )
  }),
)

const gatewayModels = {
  "native passthrough": "anthropic/claude-sonnet-4-6",
  "REST catalog": "google/gemini-2.5-flash",
}

for (const [route, modelID] of Object.entries(gatewayModels)) {
  itManaged.live(`cloudflare-ai-gateway ${route} applies chunkTimeout when the SSE body stalls`, () =>
    Effect.gen(function* () {
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const urls = yield* setupGateway(() =>
              Promise.resolve(new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })),
            )
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(
              ProviderV2.ID.make("cloudflare-ai-gateway"),
              ModelV2.ID.make(modelID),
            )
            // The gateway provider registers a custom getModel loader, which is
            // not a fixed bundled adapter: both sanctioned lanes refuse it
            // fail-closed, so no provider bytes leave the process and the
            // legacy resolveSDK gateway client path stays closed.
            const outcome = yield* provider
              .getManagedLanguage({ model, harnessID: "native-rich", fetch: globalThis.fetch })
              .pipe(Effect.catch(() => Effect.succeed("unavailable" as const)))

            expect(outcome).toBe("unavailable")
            expect(urls).toHaveLength(0)
          }),
        { config: gatewayConfig({ chunkTimeout: 50 }) },
      )
    }),
  )
}

itManaged.live("cloudflare-ai-gateway applies headerTimeout when response headers do not arrive", () =>
  Effect.gen(function* () {
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const urls = yield* setupGateway(
            (init) =>
              new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
          )
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(
            ProviderV2.ID.make("cloudflare-ai-gateway"),
            ModelV2.ID.make(gatewayModels["native passthrough"]),
          )
          // Same fail-closed refusal as above: the custom gateway loader never
          // reaches a dispatch, so there is no request URL and no timeout to
          // observe — the timeout wrapper itself is covered by the `test`
          // provider cases above.
          const outcome = yield* provider
            .getManagedLanguage({ model, harnessID: "native-rich", fetch: globalThis.fetch })
            .pipe(Effect.catch(() => Effect.succeed("unavailable" as const)))

          expect(outcome).toBe("unavailable")
          expect(urls).toHaveLength(0)
        }),
      { config: gatewayConfig({ headerTimeout: 50 }) },
    )
  }),
)

// Routes the gateway provider's requests to `respond` through the configured custom fetch, which
// the timeout wrapper calls instead of the global fetch. Returns the requested URLs.
function setupGateway(respond: (init?: RequestInit) => Promise<Response>) {
  return Effect.gen(function* () {
    yield* Env.use.set("CLOUDFLARE_ACCOUNT_ID", "test-account")
    yield* Env.use.set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
    yield* Env.use.set("CLOUDFLARE_API_TOKEN", "test-token")
    const provider = yield* Provider.Service
    const configured = yield* provider.getProvider(ProviderV2.ID.make("cloudflare-ai-gateway"))
    const urls: string[] = []
    configured.options.fetch = (input: string, init?: RequestInit) => {
      urls.push(input)
      return respond(init)
    }
    return urls
  })
}

function gatewayConfig(options: Record<string, unknown>) {
  return {
    provider: {
      "cloudflare-ai-gateway": {
        options,
        models: {
          // The gateway loader builds its own client; a bundled npm keeps resolveSDK off the network.
          [gatewayModels["REST catalog"]]: { name: "Gemini 2.5 Flash", provider: { npm: "@ai-sdk/openai-compatible" } },
        },
      },
    },
  }
}


function providerConfig(url: string, options: Record<string, unknown> = {}) {
  const base = testProviderConfig(url)
  const model = base.provider.test.models["test-model"]
  return {
    ...base,
    provider: {
      test: {
        ...base.provider.test,
        // The managed lane takes its endpoint from the pinned route
        // (model.api.url) and supplies an isolated credential placeholder, so
        // the fixture carries the loopback URL as the provider endpoint and
        // only the timeout options under test — no baseURL/apiKey overrides.
        api: url,
        models: { "test-model": { ...model, provider: { api: url } } },
        options,
      },
    },
  }
}

async function delayedHeaderServer(delay: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function delayedBodyServer(delay: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    setTimeout(() => {
      res.end('data: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function withAuthContent<A, E, R>(self: Effect.Effect<A, E, R>, value: Record<string, unknown> = defaultAuthContent()) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(value)
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previous
      }),
  )
}

function defaultAuthContent() {
  return {
    openai: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
  }
}
