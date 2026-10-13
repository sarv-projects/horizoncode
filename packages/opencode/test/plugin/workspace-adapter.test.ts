import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Npm } from "@opencode-ai/core/npm"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import path from "path"
import { pathToFileURL } from "url"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Workspace } from "../../src/control-plane/workspace"
import { Plugin } from "../../src/plugin/index"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceState } from "../../src/effect/instance-state"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, Workspace.node, InstanceStore.node, Ripgrep.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [InstanceStore.bootstrapNode, noopBootstrapLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true, experimentalWorkspaces: true })],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("plugin.workspace", () => {
  it.instance("does not register a configured external workspace adapter before Guard mediation", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const type = `plug-${Math.random().toString(36).slice(2)}`
      const file = path.join(dir, "plugin.ts")
      const imported = path.join(dir, "plugin-imported")
      const mark = path.join(dir, "created.json")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          [
            "import { writeFileSync } from 'node:fs'",
            `writeFileSync(${JSON.stringify(imported)}, "imported")`,
            "export default async ({ experimental_workspace }) => {",
            `  experimental_workspace.register(${JSON.stringify(type)}, {`,
            '    name: "plug",',
            '    description: "plugin workspace adapter",',
            "    configure(input) { return input },",
            `    async create() { await Bun.write(${JSON.stringify(mark)}, "created") },`,
            "    async remove() {},",
            "    target(input) { return { type: 'local', directory: input.directory } },",
            "  })",
            "  return {}",
            "}",
            "",
          ].join("\n"),
        ),
      )

      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
          }),
        ),
      )

      const plugin = yield* Plugin.Service
      yield* plugin.init()
      const workspace = yield* Workspace.Service
      const ctx = yield* InstanceState.context
      const result = yield* Effect.exit(
        workspace.create({
          type,
          branch: null,
          extra: { key: "value" },
          projectID: ctx.project.id,
        }),
      )

      expect(result._tag).toBe("Failure")
      expect(yield* Effect.promise(() => Bun.file(imported).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(mark).exists())).toBe(false)
    }),
  )
})
