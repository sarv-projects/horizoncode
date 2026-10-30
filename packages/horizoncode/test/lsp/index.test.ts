import { describe, expect, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const lspLayer = (flags: Parameters<typeof RuntimeFlags.layer>[0] = {}) =>
  LayerNode.compile(LayerNode.group([LSP.node, Config.node, RuntimeFlags.node, EventV2Bridge.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const it = testEffect(Layer.mergeAll(lspLayer(), LayerNode.compile(CrossSpawnSpawner.node)))
const experimentalTyIt = testEffect(
  Layer.mergeAll(lspLayer({ experimentalLspTy: true }), LayerNode.compile(CrossSpawnSpawner.node)),
)
const disabledDownloadIt = testEffect(
  Layer.mergeAll(lspLayer({ disableLspDownload: true }), LayerNode.compile(CrossSpawnSpawner.node)),
)

describe("lsp.spawn", () => {
  it.instance(
    "does not spawn builtin LSP for files outside instance",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.touchFile(path.join(dir, "..", "outside.ts"))
            yield* lsp.hover({
              file: path.join(dir, "..", "hover.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(0)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance("does not spawn builtin LSP for files inside instance when LSP is unset", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

        try {
          yield* lsp.hover({
            file: path.join(dir, "src", "inside.ts"),
            line: 0,
            character: 0,
          })
          expect(spy).toHaveBeenCalledTimes(0)
        } finally {
          spy.mockRestore()
        }
      }),
    ),
  )

  it.instance(
    "does not spawn builtin LSP for files inside instance when lsp is true",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(0)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "does not run a configured executable and returns empty results until LSP is supervised",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const marker = path.join(dir, ".lsp-executed")
          const file = path.join(dir, "sample.repro")
          yield* Effect.promise(() => Bun.write(file, "sample\n"))
          yield* lsp.touchFile(file)

          const exists = yield* Effect.promise(() =>
            fs.access(marker).then(
              () => true,
              () => false,
            ),
          )
          const definitions = yield* lsp.definition({ file, line: 0, character: 0 })
          const status = yield* lsp.status()
          expect(exists).toBe(false)
          expect(definitions).toEqual([])
          expect(status).toEqual([])
        }),
      ),
    {
      config: {
        lsp: {
          custom: {
            command: [process.execPath, "-e", `require("node:fs").writeFileSync(".lsp-executed", "ran")`],
            extensions: [".repro"],
          },
        },
      },
    },
  )

  it.instance(
    "does not spawn builtin LSP for files inside instance when config object is provided",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(0)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    {
      config: {
        lsp: {
          eslint: { disabled: true },
        },
      },
    },
  )

  it.instance(
    "does not spawn pyright or ty for any runtime selection",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(ty).toHaveBeenCalledTimes(0)
            expect(pyright).toHaveBeenCalledTimes(0)
          } finally {
            ty.mockRestore()
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  experimentalTyIt.instance(
    "does not spawn pyright or ty when experimental LSP selection is enabled",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(ty).toHaveBeenCalledTimes(0)
            expect(pyright).toHaveBeenCalledTimes(0)
          } finally {
            ty.mockRestore()
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  disabledDownloadIt.instance(
    "does not spawn or install a language server when downloads are disabled",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(pyright).toHaveBeenCalledTimes(0)
          } finally {
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )
})
