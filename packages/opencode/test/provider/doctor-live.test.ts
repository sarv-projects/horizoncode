import { afterEach, expect, test } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Config as EffectConfig, ConfigProvider, Option, Redacted } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth as InstanceServerAuth } from "../../src/server/auth"
import { ServerAuth as ServerPkgAuth } from "@opencode-ai/server/auth"
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
// The production app LayerNode group exposes `WebSearchRuntime.node`, so
// `createRoutes()` builds with the real guarded service and needs no boundary
// stub; these Doctor tests never exercise websearch and assert zero network.
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

const doctorPost = (directory: string, path: string, body: unknown, secret: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`opencode:${secret}`)}`,
      origin: "oc://renderer",
      "x-opencode-directory": directory,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

it.live("catalog and full Doctor tiers reject foreign consent labels and stay pre-dispatch inert", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
    const originalFetch = globalThis.fetch
    let networkRequests = 0
    globalThis.fetch = (async () => {
      networkRequests++
      throw new Error("Doctor tier inspection attempted provider/network access")
    }) as unknown as typeof fetch

    const selection = { providerRef: "provider:opencode", modelRef: "model:opencode/big-pickle" }
    const offline = {
      schemaVersion: 1,
      doctorRunId: "live_offline",
      tier: "offline",
      selection,
      deadlineMs: 5000,
      maxNetworkRequests: 0,
    } as const
    const catalog = {
      ...offline,
      doctorRunId: "live_catalog",
      tier: "catalog",
      maxNetworkRequests: 1,
      networkGrantRef: "grant:display-only",
    } as const
    const full = { ...catalog, doctorRunId: "live_full", tier: "full", spendConsentRef: "consent:display-only" } as const

    const post = (path: string, body: unknown) =>
      Effect.promise(() => webHandler(doctorPost(directory, path, body, "doctor-test-secret"), context))

    try {
      // Every tier only accepts the grant labels it owns. A grant/consent label
      // from another tier, a missing required label, or a forged tier value is
      // rejected at the route boundary before any projection runs.
      const refused: ReadonlyArray<readonly [string, unknown]> = [
        ["/provider/doctor/offline", { ...offline, networkGrantRef: "grant:must-not-apply" }],
        ["/provider/doctor/offline", { ...offline, spendConsentRef: "consent:must-not-apply" }],
        ["/provider/doctor/offline", { ...offline, tier: "catalog" }],
        ["/provider/doctor/catalog", { ...catalog, spendConsentRef: "consent:must-not-apply" }],
        ["/provider/doctor/catalog", { ...offline, tier: "catalog", maxNetworkRequests: 1 }],
        ["/provider/doctor/catalog", { ...catalog, maxNetworkRequests: 0 }],
        ["/provider/doctor/full", { ...full, spendConsentRef: undefined }],
        ["/provider/doctor/full", { ...full, networkGrantRef: undefined }],
        ["/provider/doctor/full", { ...catalog }],
        ["/provider/doctor/full", { ...offline }],
      ]
      for (const [path, body] of refused) {
        const response = yield* post(path, body)
        expect(response.status, `${path} must refuse ${JSON.stringify(body)}`).toBe(400)
      }

      const catalogResponse = yield* post("/provider/doctor/catalog", catalog)
      expect(catalogResponse.status).toBe(200)
      const catalogBody = yield* Effect.promise(() => catalogResponse.json())
      expect(catalogBody).toMatchObject({
        tier: "catalog",
        networkRequestCount: 0,
        credentialAccess: "NOT_READ",
        costStatus: "NOT_INCURRED",
      })
      expect(catalogBody.probes).toContainEqual(
        expect.objectContaining({ phase: "catalog", outcome: "SKIPPED", code: "catalog_pre_dispatch_guard_unavailable" }),
      )

      const fullResponse = yield* post("/provider/doctor/full", full)
      expect(fullResponse.status).toBe(200)
      const fullBody = yield* Effect.promise(() => fullResponse.json())
      expect(fullBody).toMatchObject({
        tier: "full",
        networkRequestCount: 0,
        credentialAccess: "NOT_READ",
        costStatus: "NOT_INCURRED",
      })
      expect(fullBody.probes).toContainEqual(
        expect.objectContaining({ phase: "stream", outcome: "SKIPPED", code: "full_guarded_provider_probe_unavailable" }),
      )
      expect(networkRequests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  }),
)

// CONTRACT (QA-007/PD + ServerAuth): a server whose `OPENCODE_SERVER_PASSWORD`
// resolves to the empty string has authentication NOT configured, so the only
// principal it may mint is `host_os` for a proven loopback peer. The companion
// test above proves the no-credential request is refused; this one proves that
// presenting the trivially guessable `Basic opencode:` (empty password) from a
// non-loopback peer must be refused too. It currently fails: see
// `reports/phases/P6.md` item 42 for the exact root cause and the one-line
// patch, which lives outside the P6 write scope (`src/server/**`).
it.live("Doctor tiers refuse a guessed empty credential on a server with no configured password", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
    const originalFetch = globalThis.fetch
    let networkRequests = 0
    globalThis.fetch = (async () => {
      networkRequests++
      throw new Error("unauthenticated Doctor call attempted provider/network access")
    }) as unknown as typeof fetch
    const selection = { providerRef: "provider:opencode", modelRef: "model:opencode/big-pickle" }
    const tiers: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      [
        "/provider/doctor/offline",
        {
          schemaVersion: 1,
          doctorRunId: "live_unauth_offline",
          tier: "offline",
          selection,
          deadlineMs: 5000,
          maxNetworkRequests: 0,
        },
      ],
      [
        "/provider/doctor/catalog",
        {
          schemaVersion: 1,
          doctorRunId: "live_unauth_catalog",
          tier: "catalog",
          selection,
          deadlineMs: 5000,
          maxNetworkRequests: 1,
          networkGrantRef: "grant:display-only",
        },
      ],
      [
        "/provider/doctor/full",
        {
          schemaVersion: 1,
          doctorRunId: "live_unauth_full",
          tier: "full",
          selection,
          deadlineMs: 5000,
          maxNetworkRequests: 1,
          networkGrantRef: "grant:display-only",
          spendConsentRef: "consent:display-only",
        },
      ],
    ]
    try {
      for (const [path, body] of tiers) {
        const response = yield* Effect.promise(() =>
          webHandlerWithoutAuth(
            new Request(`http://untrusted.invalid${path}`, {
              method: "POST",
              headers: {
                "x-opencode-directory": directory,
                "content-type": "application/json",
                authorization: `Basic ${btoa("opencode:")}`,
              },
              body: JSON.stringify(body),
            }),
            context,
          ),
        )
        expect(response.status, `${path} accepted a guessed empty credential`).toBe(401)
      }
      expect(networkRequests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  }),
)

// Direct unit proof for the RED HTTP case above, covering both granted
// ServerAuth owners. `required()` deliberately reports an empty configured
// password as "auth not configured", so `authorized()` must authorize nothing
// for it in either package; a configured non-empty password is unchanged.
test("both ServerAuth owners refuse an empty configured password", () => {
  const empty = {
    password: Option.some(""),
    username: "opencode",
    reviewerPassword: Option.none<string>(),
    reviewerUsername: Option.none<string>(),
  }
  const configured = { ...empty, password: Option.some("secret") }
  const credential = (password: string) => ({ username: "opencode", password: Redacted.make(password) })

  expect(InstanceServerAuth.required(empty)).toBe(false)
  expect(ServerPkgAuth.required(empty)).toBe(false)

  expect(InstanceServerAuth.authorized(credential(""), empty)).toBe(false)
  expect(InstanceServerAuth.authorized(credential("guessed"), empty)).toBe(false)
  expect(InstanceServerAuth.authenticatedUsername(credential(""), empty)).toBeUndefined()
  expect(ServerPkgAuth.authorized(credential(""), empty)).toBe(false)
  expect(ServerPkgAuth.authorized(credential("guessed"), empty)).toBe(false)
  expect(ServerPkgAuth.authenticatedUsername(credential(""), empty)).toBeUndefined()

  // Configured-password behavior is unchanged in both owners.
  expect(InstanceServerAuth.required(configured)).toBe(true)
  expect(InstanceServerAuth.authorized(credential("secret"), configured)).toBe(true)
  expect(InstanceServerAuth.authorized(credential("wrong"), configured)).toBe(false)
  expect(InstanceServerAuth.authenticatedUsername(credential("secret"), configured)).toBe("opencode")
  expect(ServerPkgAuth.required(configured)).toBe(true)
  expect(ServerPkgAuth.authorized(credential("secret"), configured)).toBe(true)
  expect(ServerPkgAuth.authorized(credential("wrong"), configured)).toBe(false)
  expect(ServerPkgAuth.authenticatedUsername(credential("secret"), configured)).toBe("opencode")
})
