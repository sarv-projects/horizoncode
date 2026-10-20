import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { Global } from "../src/global"
import { Flag } from "../src/flag/flag"
import { ModelsDev } from "../src/models-dev"
import { testEffect } from "./lib/effect"

const cache = path.join(os.tmpdir(), `horizon-models-dev-${crypto.randomUUID()}`)
const requests: string[] = []
const originalModelsPath = Flag.OPENCODE_MODELS_PATH
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url)
      return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))
    }),
  ),
)
const runtime = testEffect(
  AppNodeBuilder.build(ModelsDev.node, [
    [Global.node, Global.layerWith({ cache })],
    [LayerNodePlatform.httpClient, http],
  ]),
)

beforeEach(async () => {
  requests.length = 0
  // The shared Core preload points at a pinned fixture. This suite verifies
  // the production cache path, so temporarily remove that explicit override.
  Reflect.set(Flag, "OPENCODE_MODELS_PATH", undefined)
  await fs.rm(cache, { recursive: true, force: true })
})

afterAll(async () => {
  Reflect.set(Flag, "OPENCODE_MODELS_PATH", originalModelsPath)
  await fs.rm(cache, { recursive: true, force: true })
})

runtime.live("service startup and a catalog read do not fetch or write a cache", () =>
  Effect.gen(function* () {
    const models = yield* ModelsDev.Service
    const snapshot = yield* models.getSnapshot()
    expect(typeof snapshot.providers).toBe("object")
    expect(["bundled", "unavailable"]).toContain(snapshot.source)
    expect(["fresh", "unknown"]).toContain(snapshot.freshness)
    expect(requests).toEqual([])
    const cacheWritten = yield* Effect.promise(() =>
      fs.access(path.join(cache, "models.json")).then(
        () => true,
        () => false,
      ),
    )
    expect(cacheWritten).toBe(false)
  }),
)

runtime.live("only an explicit refresh fetches and writes the catalog cache", () =>
  Effect.gen(function* () {
    const models = yield* ModelsDev.Service
    // Bun's shared test bootstrap disables all catalog fetches. Exercise the
    // opt-in path with the injected loopback client only, then restore the
    // process-wide fail-closed default.
    const disabled = Flag.OPENCODE_DISABLE_MODELS_FETCH
    Reflect.set(Flag, "OPENCODE_DISABLE_MODELS_FETCH", false)
    try {
      yield* models.refresh(true)
    } finally {
      Reflect.set(Flag, "OPENCODE_DISABLE_MODELS_FETCH", disabled)
    }
    const source = Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"
    expect(requests).toEqual([`${source}/api.json`])
    const catalog = yield* models.getSnapshot()
    expect(catalog.source).toBe("cache")
    expect(catalog.freshness).toBe("fresh")
    const cacheWritten = yield* Effect.promise(() =>
      fs.access(path.join(cache, "models.json")).then(
        () => true,
        () => false,
      ),
    )
    expect(cacheWritten).toBe(true)

    const cachePath = path.join(cache, "models.json")
    yield* Effect.promise(() => fs.utimes(cachePath, new Date(0), new Date(0)))
    const stale = yield* models.getSnapshot()
    expect(stale.source).toBe("cache")
    expect(stale.freshness).toBe("stale")
    expect(requests).toEqual([`${source}/api.json`])
  }),
)

