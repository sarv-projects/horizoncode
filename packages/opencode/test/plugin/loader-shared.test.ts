import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])), testInstanceStoreLayer),
)

function load(directory: string) {
  return Effect.gen(function* () {
    const config = yield* Effect.promise(
      () => Bun.file(path.join(directory, "opencode.json")).json() as Promise<{ plugin?: string[] }>,
    )
    const plugins = config.plugin ?? []
    return yield* Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      return yield* plugin.list()
    }).pipe(
      Effect.provide(
        LayerNode.compile(Plugin.node, [
          [
            Config.node,
            TestConfig.layer({
              get: () =>
                Effect.succeed({
                  plugin: plugins,
                  plugin_origins: plugins.map((spec) => ({
                    spec,
                    source: path.join(directory, "opencode.json"),
                    scope: "local" as const,
                  })),
                }),
              directories: () => Effect.succeed([directory]),
            }),
          ],
          [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
        ]),
      ),
      provideInstance(directory),
    )
  })
}

it.live("does not import configured external server plugins before Guard mediation", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const pluginFile = path.join(directory, "plugin.ts")
    const marker = path.join(directory, "imported")
    yield* Effect.promise(() =>
      Bun.write(
        pluginFile,
        [
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported")`,
          `export default async () => { writeFileSync(${JSON.stringify(marker)}, "initialized"); return {} }`,
          "",
        ].join("\n"),
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(directory, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(pluginFile).href] })),
    )

    const hooks = yield* load(directory)
    expect(hooks).toEqual([])
    expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
  }),
)
