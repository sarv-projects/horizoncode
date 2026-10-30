import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { AppProcess } from "@horizoncode/core/process"
import { Global } from "@horizoncode/core/global"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { Snapshot } from "@horizoncode/core/snapshot"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("Snapshot", () => {
  testEffect(Layer.empty).live("keeps legacy Git-backed snapshot effects unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
          let spawnCount = 0
          const appProcess = Layer.succeed(
            AppProcess.Service,
            AppProcess.Service.of({
              run: () => Effect.sync(() => {
                spawnCount++
                throw new globalThis.Error("Snapshot must not spawn a process")
              }),
              runStream: () => {
                spawnCount++
                throw new globalThis.Error("Snapshot must not spawn a process")
              },
            } as unknown as AppProcess.Interface),
          )

          const snapshot = yield* Snapshot.Service.pipe(
            Effect.provide(snapshotLayer(tmp.path, project, appProcess)),
          )
          expect(yield* snapshot.capture()).toBeUndefined()
          expect(spawnCount).toBe(0)
          const privateStore = yield* Effect.promise(() =>
            fs.stat(path.join(tmp.path, "snapshot")).catch(() => undefined),
          )
          expect(privateStore).toBeUndefined()
          expect(
            yield* Effect.exit(snapshot.restorePlan({ files: new Map() })),
          ).toMatchObject({ _tag: "Failure" })
          expect(spawnCount).toBe(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function snapshotLayer(data: string, directory: string, appProcess: Layer.Layer<AppProcess.Service>) {
  return AppNodeBuilder.build(Snapshot.node, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
    [Global.node, Global.layerWith({ data, config: path.join(data, "config") })],
    [AppProcess.node, appProcess],
  ])
}
