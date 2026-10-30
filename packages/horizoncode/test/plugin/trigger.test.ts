import { existsSync } from "node:fs"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { Npm } from "@horizoncode/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const guardedHooks = testEffect(LayerNode.compile(Plugin.node))
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin imports", () => {
  it.instance("does not import configured server plugins without Guard mediation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const marker = path.join(test.directory, "plugin-imported")
      yield* withProject(
        [
          'import { writeFileSync } from "node:fs"',
          `writeFileSync(${JSON.stringify(marker)}, "imported")`,
          `export default async () => { writeFileSync(${JSON.stringify(marker)}, "initialized") }`,
        ].join("\n"),
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          expect(yield* plugin.list()).toHaveLength(0)
          expect(yield* triggerSystemTransform()).toEqual([])
          expect(existsSync(marker)).toBe(false)
        }),
      )
    }),
  )

  guardedHooks.effect("built-in plugin hooks are unavailable before Guard mediation", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      expect(yield* plugin.list()).toEqual([])
      const output = { system: [] as string[] }
      yield* plugin.trigger(
        systemHook,
        {
          model: {
            providerID: ProviderV2.ID.anthropic,
            modelID: ModelV2.ID.make("claude-sonnet-4-6"),
          },
        },
        output,
      )
      expect(output.system).toEqual([])
    }),
  )
})
