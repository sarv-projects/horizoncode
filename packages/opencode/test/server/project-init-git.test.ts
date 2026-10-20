import { afterEach, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import path from "path"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const testInstanceStore = AppNodeBuilder.build(InstanceStore.node, [[InstanceStore.bootstrapNode, noopBootstrap]])

const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(FSUtil.node), testInstanceStore, httpApiLayer))

function request(directory: string, url: string, init: RequestInit = {}) {
  return requestInDirectory(url, directory, init)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function collectGlobalEvents() {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const seen: GlobalEvent[] = []
      const on = (event: GlobalEvent) => {
        seen.push(event)
      }
      GlobalBus.on("event", on)
      return { seen, on }
    }),
    ({ on }) => Effect.sync(() => GlobalBus.off("event", on)),
  )
}

const disposedEvents = (seen: GlobalEvent[], dir: string) =>
  seen.filter((evt) => evt.directory === dir && evt.payload.type === "server.instance.disposed").length

describe("project.initGit endpoint", () => {
  it.instance("is unavailable before spawning git", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const fs = yield* FSUtil.Service
      const events = yield* collectGlobalEvents()

      const init = yield* request(tmp.directory, "/project/git/init", {
        method: "POST",
      })
      expect(init.status).toBe(503)
      expect(yield* json(init)).toMatchObject({
        _tag: "ServiceUnavailableError",
        message: "project git initialization is unavailable",
        service: "project",
      })
      expect(yield* fs.exists(path.join(tmp.directory, ".git"))).toBe(false)
      expect(disposedEvents(events.seen, tmp.directory)).toBe(0)
      expect(yield* fs.exists(path.join(tmp.directory, ".git", "opencode"))).toBe(false)
    }),
  )

  it.instance("remains unavailable in an existing git repository", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const fs = yield* FSUtil.Service
      const events = yield* collectGlobalEvents()

      const init = yield* request(tmp.directory, "/project/git/init", {
        method: "POST",
      })
      expect(init.status).toBe(503)
      expect(yield* json(init)).toMatchObject({
        _tag: "ServiceUnavailableError",
        message: "project git initialization is unavailable",
        service: "project",
      })
      expect(yield* fs.exists(path.join(tmp.directory, ".git"))).toBe(true)
      expect(disposedEvents(events.seen, tmp.directory)).toBe(0)
    }),
    { git: true },
  )
})

describe("project.update endpoint", () => {
  it.instance("is unavailable before changing project state or publishing an update", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const events = yield* collectGlobalEvents()
      const beforeResponse = yield* request(tmp.directory, "/project/current")
      expect(beforeResponse.status).toBe(200)
      const before = yield* json<{ id: string; name?: string }>(beforeResponse)

      const update = yield* request(tmp.directory, `/project/${before.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "unguarded project update probe" }),
      })
      expect(update.status).toBe(503)
      expect(yield* json(update)).toMatchObject({
        _tag: "ServiceUnavailableError",
        message: "project updates are unavailable until guarded execution is implemented",
        service: "project",
      })

      const afterResponse = yield* request(tmp.directory, "/project/current")
      expect(afterResponse.status).toBe(200)
      const after = yield* json<{ id: string; name?: string }>(afterResponse)
      expect(after.name).toBe(before.name)
      expect(events.seen.filter((event) => event.payload.type === "project.updated")).toHaveLength(0)
    }),
  )
})
