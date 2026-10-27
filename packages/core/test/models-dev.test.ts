import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { afterAll, beforeEach, expect } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import * as TestConsole from "effect/testing/TestConsole"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { FSUtil } from "../src/fs-util"
import { Flag } from "../src/flag/flag"
import { ModelsDev } from "../src/models-dev"
import { Hash } from "../src/util/hash"
import { testEffect } from "./lib/effect"

const cache = path.join(process.cwd(), "tmp", `horizon-models-dev-${crypto.randomUUID()}`)
const requests: string[] = []
let responseStatus = 200
let responseBody: BodyInit = "{}"
const originalModelsPath = Flag.OPENCODE_MODELS_PATH
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url)
       return HttpClientResponse.fromWeb(request, new Response(responseBody, { status: responseStatus }))
    }),
  ),
)
const runtime = testEffect(
  AppNodeBuilder.build(ModelsDev.node, [
    [Global.node, Global.layerWith({ cache })],
    [LayerNodePlatform.httpClient, http],
  ]),
)
let failSidecarWriteTarget: string | undefined
let sidecarWriteAttempts = 0
const sidecarFilesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      writeWithDirs: (target, content, mode) => {
        if (failSidecarWriteTarget && target.startsWith(`${failSidecarWriteTarget}.`) && target.endsWith(".tmp")) {
          sidecarWriteAttempts += 1
          return Effect.fail(
            new FSUtil.FileSystemError({ method: "writeWithDirs", cause: new Error("P6_RAW_SIDECAR_CAUSE") }),
          )
        }
        return fs.writeWithDirs(target, content, mode)
      },
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const sidecarLogEntries: Array<{ logLevel: unknown; message: unknown; cause: unknown }> = []
const sidecarLogger = Logger.make((options) => {
  sidecarLogEntries.push({ logLevel: options.logLevel, message: options.message, cause: options.cause })
})
const sidecarRuntime = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(ModelsDev.node, [
      [FSUtil.node, sidecarFilesystem],
      [Global.node, Global.layerWith({ cache })],
      [LayerNodePlatform.httpClient, http],
    ]),
    Logger.layer([sidecarLogger], { mergeWithExisting: false }),
  ),
)

beforeEach(async () => {
  requests.length = 0
  responseBody = "{}"
  failSidecarWriteTarget = undefined
  sidecarWriteAttempts = 0
  sidecarLogEntries.length = 0
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
    expect(snapshot.provenance).toMatchObject({
      project: "models.dev",
      license: "MIT",
      attribution: "Models.dev (https://models.dev)",
    })
    expect(snapshot.provenance?.retrievedAt).toBeUndefined()
    expect(snapshot.provenance?.contentDigest).toBeUndefined()
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

runtime.live("an oversized local catalog is not loaded into the cache projection", () =>
  Effect.gen(function* () {
    const catalogPath = path.join(cache, "models.json")
    const marker = `{"oversized-local":{"name":"Oversized","env":[],"id":"oversized-local","models":{}}}`
    yield* Effect.promise(() => fs.mkdir(cache, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(catalogPath, `${marker}${" ".repeat(16 * 1024 * 1024)}`))

    const models = yield* ModelsDev.Service
    const snapshot = yield* models.getSnapshot()
    expect(snapshot.source).not.toBe("cache")
    expect(snapshot.providers).not.toHaveProperty("oversized-local")
  }),
)

runtime.live("an oversized provenance sidecar is ignored", () =>
  Effect.gen(function* () {
    const catalogText = "{}"
    const catalogPath = path.join(cache, "models.json")
    const metadataPath = `${catalogPath}.meta.json`
    yield* Effect.promise(() => fs.mkdir(cache, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(catalogPath, catalogText))
    yield* Effect.promise(() => fs.writeFile(metadataPath, JSON.stringify({
      schemaVersion: 1,
      sourceURL: "https://models.opencode.ai",
      retrievedAt: Date.now(),
      contentDigest: `sha256:${createHash("sha256").update(catalogText).digest("hex")}`,
      attribution: "a".repeat(32 * 1024),
    })))

    const models = yield* ModelsDev.Service
    const snapshot = yield* models.getSnapshot()
    expect(snapshot.source).toBe("cache")
    expect(snapshot.freshness).toBe("unknown")
    expect(snapshot.provenance?.retrievedAt).toBeUndefined()
    expect(snapshot.provenance?.attribution).not.toContain("a".repeat(1024))
  }),
)

runtime.live("retains raw catalog source URL only in its local sidecar", () =>
  Effect.gen(function* () {
    const catalogText = "{}"
    const source = Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"
    const sourceURL = "https://fixture@catalog.example.test/api?x=1#fragment"
    const catalogPath = path.join(
      cache,
      source === "https://models.opencode.ai" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const metadataPath = `${catalogPath}.meta.json`
    yield* Effect.promise(() => fs.mkdir(cache, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(catalogPath, catalogText))
    yield* Effect.promise(() => fs.writeFile(metadataPath, JSON.stringify({
      schemaVersion: 1,
      sourceURL,
      retrievedAt: Date.now(),
      contentDigest: `sha256:${createHash("sha256").update(catalogText).digest("hex")}`,
    })))

    const models = yield* ModelsDev.Service
    const snapshot = yield* models.getSnapshot()
    expect(snapshot.source).toBe("cache")
    expect(snapshot.provenance).not.toHaveProperty("sourceURL")
    const sidecar = yield* Effect.promise(() => fs.readFile(metadataPath, "utf8"))
    expect(JSON.parse(sidecar)).toMatchObject({ sourceURL })
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
    expect(catalog.provenance).toMatchObject({
      project: "models.dev",
      license: "MIT",
      attribution: "Models.dev (https://models.dev)",
    })
    expect(catalog.provenance).not.toHaveProperty("sourceURL")
    expect(catalog.provenance?.retrievedAt).toBeNumber()
    expect(catalog.provenance?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const catalogPath = path.join(
      cache,
      source === "https://models.opencode.ai" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const metadata = yield* Effect.promise(() => fs.readFile(`${catalogPath}.meta.json`, "utf8"))
    expect(JSON.parse(metadata)).toMatchObject({ sourceURL: source })
    const cacheWritten = yield* Effect.promise(() =>
      fs.access(path.join(cache, "models.json")).then(
        () => true,
        () => false,
      ),
    )
    expect(cacheWritten).toBe(true)
    const metadataWritten = yield* Effect.promise(() =>
      fs.access(path.join(cache, "models.json.meta.json")).then(
        () => true,
        () => false,
      ),
    )
    expect(metadataWritten).toBe(true)

    const cachePath = path.join(cache, "models.json")
    yield* Effect.promise(() => fs.utimes(cachePath, new Date(0), new Date(0)))
    const stale = yield* models.getSnapshot()
    expect(stale.source).toBe("cache")
    expect(stale.freshness).toBe("stale")
    expect(requests).toEqual([`${source}/api.json`])
  }),
)

runtime.live("a failed forced refresh preserves the last known-good catalog", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        disabled: Flag.OPENCODE_DISABLE_MODELS_FETCH,
        status: responseStatus,
      }
      Reflect.set(Flag, "OPENCODE_DISABLE_MODELS_FETCH", false)
      responseStatus = 200
      return previous
    }),
    () =>
      Effect.gen(function* () {
        const models = yield* ModelsDev.Service
        yield* models.refresh(true)
        const before = yield* models.getSnapshot()
        expect(before.source).toBe("cache")
        expect(before.provenance?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

        const loggedErrorsBefore = yield* TestConsole.errorLines
        responseStatus = 503
        yield* models.refresh(true)
        const refreshLog = JSON.stringify((yield* TestConsole.errorLines).slice(loggedErrorsBefore.length))
        expect(refreshLog).not.toContain("models.opencode.ai")
        expect(refreshLog).not.toContain("503")
        const after = yield* models.getSnapshot()

        expect(requests).toHaveLength(4)
        expect(new Set(requests)).toEqual(new Set([`${Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"}/api.json`]))
        expect(after.source).toBe("cache")
        expect(after.providers).toEqual(before.providers)
        expect(after.provenance?.contentDigest).toBe(before.provenance?.contentDigest)
      }),
    (previous) =>
      Effect.sync(() => {
        Reflect.set(Flag, "OPENCODE_DISABLE_MODELS_FETCH", previous.disabled)
        responseStatus = previous.status
      }),
  ),
)

sidecarRuntime.live("a failed provenance write does not log its raw filesystem cause", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        disabled: Flag.OPENCODE_DISABLE_MODELS_FETCH,
        status: responseStatus,
        target: failSidecarWriteTarget,
      }
      Reflect.set(Flag, "OPENCODE_DISABLE_MODELS_FETCH", false)
      responseStatus = 200
      sidecarWriteAttempts = 0
      return previous
    }),
    () =>
      Effect.gen(function* () {
        const source = Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"
        const catalogPath = path.join(
          cache,
          source === "https://models.opencode.ai" ? "models.json" : `models-${Hash.fast(source)}.json`,
        )
        failSidecarWriteTarget = `${catalogPath}.meta.json`

        const models = yield* ModelsDev.Service
        yield* models.refresh(true)

        expect(requests).toHaveLength(1)
        expect(sidecarWriteAttempts).toBe(1)
        expect(sidecarLogEntries).toHaveLength(1)
        const logged = JSON.stringify(sidecarLogEntries, (_key, value) =>
          value instanceof Error ? { name: value.name, message: value.message } : value,
        )
        expect(logged).toContain("Failed to persist Models.dev provenance")
        expect(logged).not.toContain("P6_RAW_SIDECAR_CAUSE")
      }),
    (previous) =>
      Effect.sync(() => {
        Reflect.set(Flag, "OPENCODE_DISABLE_MODELS_FETCH", previous.disabled)
        responseStatus = previous.status
        failSidecarWriteTarget = previous.target
        sidecarWriteAttempts = 0
      }),
  ),
)

runtime.live("an oversized catalog response cancels the HTTP body stream", () =>
  Effect.gen(function* () {
    const chunk = new Uint8Array(8 * 1024 * 1024)
    let pulls = 0
    let canceled = false
    responseBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls <= 4) controller.enqueue(chunk)
        else controller.close()
      },
      cancel() {
        canceled = true
      },
    })
    const previous = Flag.OPENCODE_DISABLE_MODELS_FETCH
    Reflect.set(Flag, "OPENCODE_DISABLE_MODELS_FETCH", false)
    try {
      const models = yield* ModelsDev.Service
      yield* models.refresh(true)
      expect(requests).toHaveLength(1)
      expect(canceled).toBe(true)
      expect(pulls).toBeLessThan(5)
      const cacheWritten = yield* Effect.promise(() =>
        fs.access(path.join(cache, "models.json")).then(
          () => true,
          () => false,
        ),
      )
      expect(cacheWritten).toBe(false)
    } finally {
      Reflect.set(Flag, "OPENCODE_DISABLE_MODELS_FETCH", previous)
    }
  }),
)
