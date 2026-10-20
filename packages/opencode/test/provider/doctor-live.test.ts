import { afterEach, expect, test } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Config as EffectConfig, ConfigProvider } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const context = HttpApiApp.context
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)
const testRoutes = HttpApiApp.createRoutes().pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: "doctor-test-secret" }))),
)
const testRoutesWithoutAuth = HttpApiApp.createRoutes().pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: "" }))),
)
const servedRoutes: Layer.Layer<never, EffectConfig.ConfigError | SessionSupervisorError, HttpServer.HttpServer> =
  HttpRouter.serve(testRoutes, { disableListenLog: true, disableLogger: true })
const webHandler = HttpRouter.toWebHandler(testRoutes, { disableLogger: true }).handler
const webHandlerWithoutAuth = HttpRouter.toWebHandler(testRoutesWithoutAuth, { disableLogger: true }).handler
const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    Socket.layerWebSocketConstructorGlobal,
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.live("offline Provider Doctor rejects spoofed identity before inspection and derives valid output from selection", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
    const originalFetch = globalThis.fetch
    const apiKey = process.env["OPENCODE_API_KEY"]
    let networkRequests = 0
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      networkRequests++
      throw new Error(`offline Doctor attempted provider/network access: ${String(args[0])}`)
    }) as unknown as typeof fetch
    process.env["OPENCODE_API_KEY"] = "doctor-secret-must-not-be-read-or-echoed"

    const request = (body: unknown) =>
      new Request("http://localhost/provider/doctor/offline", {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa("opencode:doctor-test-secret")}`,
          origin: "oc://renderer",
          "x-opencode-directory": directory,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    const valid = {
      schemaVersion: 1,
      doctorRunId: "doctor_live_offline",
      tier: "offline",
      selection: { providerRef: "provider:opencode", modelRef: "model:opencode/big-pickle" },
      deadlineMs: 5000,
      maxNetworkRequests: 0,
    }

    try {
      const spoofed = yield* Effect.promise(() => webHandler(request({ ...valid, ownerRef: "spoofed-owner", ownerEpoch: "spoofed-epoch" }), context))
      expect(spoofed.status).toBe(400)
      const rejected = yield* Effect.promise(() => spoofed.json())
      expect(rejected).toMatchObject({ name: "BadRequest", data: { kind: "Payload" } })
      expect(rejected).not.toHaveProperty("tier")

      const response = yield* Effect.promise(() => webHandler(request(valid), context))
      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body).toMatchObject({
        schemaVersion: 1,
        doctorRunId: "doctor_live_offline",
        tier: "offline",
        // The shared test preload provides an explicit catalog override. Its
        // age is not authoritative, so offline Doctor must not claim READY.
        localReadiness: "UNKNOWN",
        remoteChecks: { entitlement: "UNCHECKED", quota: "UNCHECKED", service: "UNCHECKED" },
        credentialAccess: "NOT_READ",
        networkRequestCount: 0,
        costStatus: "NOT_APPLICABLE",
      })
      expect(body).not.toHaveProperty("ownerRef")
      expect(body).not.toHaveProperty("ownerEpoch")
      expect(body.selection.configurationStatus).toBe("UNKNOWN")
      expect(JSON.stringify(body)).not.toContain("doctor-secret-must-not-be-read-or-echoed")
      expect(networkRequests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      if (apiKey === undefined) delete process.env["OPENCODE_API_KEY"]
      else process.env["OPENCODE_API_KEY"] = apiKey
    }
  }),
)

it.live("offline Provider Doctor refuses an untrusted caller when auth middleware supplies no principal", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
    const originalFetch = globalThis.fetch
    let networkRequests = 0
    globalThis.fetch = (async () => {
      networkRequests++
      throw new Error("offline Doctor attempted provider/network access")
    }) as unknown as typeof fetch

    try {
      const response = yield* Effect.promise(() =>
        webHandlerWithoutAuth(
          new Request("http://untrusted.invalid/provider/doctor/offline", {
            method: "POST",
            headers: { "x-opencode-directory": directory, "content-type": "application/json" },
            body: JSON.stringify({
              schemaVersion: 1,
              doctorRunId: "doctor_untrusted_offline",
              tier: "offline",
              selection: { providerRef: "provider:opencode", modelRef: "model:opencode/big-pickle" },
              deadlineMs: 5000,
              maxNetworkRequests: 0,
            }),
          }),
          context,
        ),
      )
      expect(response.status).toBe(401)
      expect(networkRequests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  }),
)
