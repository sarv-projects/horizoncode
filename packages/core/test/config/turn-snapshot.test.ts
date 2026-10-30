import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { FSUtil } from "@horizoncode/core/fs-util"
import { Global } from "@horizoncode/core/global"
import { Config } from "@horizoncode/core/config"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const configLayer = (input: { directory: string; global: string }) =>
  AppNodeBuilder.build(LayerNode.group([Config.node, LayerNodePlatform.filesystem]), [
    [FSUtil.node, LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem]))],
    [Global.node, Global.layerWith({ config: input.global })],
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({ directory: AbsolutePath.make(input.directory) }, { projectDirectory: AbsolutePath.make(input.directory) }),
        ),
      ),
    ],
  ])

describe("Core V2 Config next-turn snapshot", () => {
  it.live("reads only auto/prune from the current instance config.json each time", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "instance")
          const global = path.join(tmp.path, "global")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
          const target = path.join(directory, "config.json")
          yield* Effect.promise(() =>
            fs.writeFile(target, JSON.stringify({ compaction: { auto: false, prune: true }, model: "other/provider", provider: "other" })),
          )

          const snapshot = Config.Service.pipe(
            Effect.flatMap((service) => service.turnSnapshot?.() ?? Effect.die("turnSnapshot unavailable")),
            Effect.provide(configLayer({ directory, global })),
          )
          expect(yield* snapshot).toEqual({ compaction: { auto: false, prune: true } })

          yield* Effect.promise(() => fs.writeFile(target, '{ "compaction": { "auto": true, "prune": false }, "model": "paid/other" }'))
          expect(yield* snapshot).toEqual({ compaction: { auto: true, prune: false } })

          yield* Effect.promise(() => fs.writeFile(target, '{ "compaction": { "auto": "true", "prune": true } }'))
          expect(yield* snapshot).toEqual({})
        }),
      ),
    ),
  )
})
