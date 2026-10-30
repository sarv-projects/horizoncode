import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect, spyOn } from "bun:test"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { provideTmpdirInstance, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { Format } from "../../src/format"
import * as Formatter from "../../src/format/formatter"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Format.node, CrossSpawnSpawner.node])), NodeFileSystem.layer),
)

describe("Format", () => {
  it.instance("status() returns empty list when no formatters are configured", () =>
    Format.Service.use((fmt) =>
      Effect.gen(function* () {
        expect(yield* fmt.status()).toEqual([])
      }),
    ),
  )

  it.instance(
    "status() returns built-in formatters when formatter is true",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          const gofmt = statuses.find((item) => item.name === "gofmt")
          expect(gofmt).toBeDefined()
          expect(gofmt!.extensions).toContain(".go")
        }),
      ),
    { config: { formatter: true } },
  )

  it.instance(
    "status() keeps built-in formatters when config object is provided",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          const gofmt = statuses.find((item) => item.name === "gofmt")
          const mix = statuses.find((item) => item.name === "mix")
          expect(gofmt).toBeDefined()
          expect(gofmt!.extensions).toContain(".go")
          expect(mix).toBeDefined()
        }),
      ),
    { config: { formatter: { gofmt: {} } } },
  )

  it.instance(
    "status() excludes formatters marked as disabled in config",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          const gofmt = statuses.find((item) => item.name === "gofmt")
          const mix = statuses.find((item) => item.name === "mix")
          expect(gofmt).toBeUndefined()
          expect(mix).toBeDefined()
        }),
      ),
    { config: { formatter: { gofmt: { disabled: true } } } },
  )

  it.instance(
    "status() excludes uv when ruff is disabled",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          expect(statuses.find((item) => item.name === "ruff")).toBeUndefined()
          expect(statuses.find((item) => item.name === "uv")).toBeUndefined()
        }),
      ),
    { config: { formatter: { ruff: { disabled: true } } } },
  )

  it.instance(
    "status() excludes ruff when uv is disabled",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          expect(statuses.find((item) => item.name === "ruff")).toBeUndefined()
          expect(statuses.find((item) => item.name === "uv")).toBeUndefined()
        }),
      ),
    { config: { formatter: { uv: { disabled: true } } } },
  )

  it.instance("service initializes without error", () => Format.Service.use(() => Effect.void))

  it.instance(
    "file() returns false when no formatter runs",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.txt`
        yield* Effect.promise(() => Bun.write(file, "x"))

        const formatted = yield* Format.use.file(file)
        expect(formatted).toBe(false)
      }),
    { config: { formatter: false } },
  )

  testEffect(
    Layer.mergeAll(
      LayerNode.compile(LayerNode.group([Format.node, CrossSpawnSpawner.node])),
      NodeFileSystem.layer,
      testInstanceStoreLayer,
    ),
  ).live("status() initializes formatter state per directory", () =>
    Effect.gen(function* () {
      const a = yield* provideTmpdirInstance(() => Format.use.status(), {
        config: { formatter: false },
      })
      const b = yield* provideTmpdirInstance(() => Format.use.status(), {
        config: {
          formatter: true,
        },
      })

      expect(a).toEqual([])
      expect(b.find((item) => item.name === "gofmt")).toBeDefined()
    }),
  )

  it.instance(
    "never runs formatter enabled probes while the process route is unavailable",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.parallel`
        yield* Effect.promise(() => Bun.write(file, "x"))

        const one = {
          extensions: Formatter.gofmt.extensions,
          enabled: Formatter.gofmt.enabled,
        }
        const two = {
          extensions: Formatter.mix.extensions,
          enabled: Formatter.mix.enabled,
        }

        let probes = 0

        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            Formatter.gofmt.extensions = [".parallel"]
            Formatter.mix.extensions = [".parallel"]
            Formatter.gofmt.enabled = async () => {
              probes++
              return ["sh", "-c", "true"]
            }
            Formatter.mix.enabled = async () => {
              probes++
              return ["sh", "-c", "true"]
            }
          }),
          () =>
            Format.Service.use((fmt) =>
              Effect.gen(function* () {
                yield* fmt.init()
                // The configured formatters match the file, but resolution (and every
                // `--help`-style binary probe) is refused before it can run a process.
                expect(yield* fmt.file(file)).toBe(false)
              }),
            ),
          () =>
            Effect.sync(() => {
              Formatter.gofmt.extensions = one.extensions
              Formatter.gofmt.enabled = one.enabled
              Formatter.mix.extensions = two.extensions
              Formatter.mix.enabled = two.enabled
            }),
        )

        expect(probes).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("x")
      }),
    { config: { formatter: { gofmt: {}, mix: {} } } },
  )

  it.instance(
    "configured formatter commands cannot run and cannot modify files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.marker`
        const marker = `${test.directory}/formatter-ran`
        yield* Effect.promise(() => Bun.write(file, "original"))
        const spawnSpy = spyOn(Bun, "spawn")
        try {
          // The formatter command would both append to the file and create a marker if it
          // ever ran; the process gate must refuse before resolving or spawning it.
          expect(yield* Format.use.file(file)).toBe(false)
        } finally {
          spawnSpy.mockRestore()
        }
        expect(spawnSpy).not.toHaveBeenCalled()
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("original")
        // The status surface reports the same unavailable state instead of claiming
        // formatting while the gate refuses.
        const statuses = yield* Format.use.status()
        expect(statuses.length).toBeGreaterThan(0)
        expect(statuses.every((item) => item.enabled === false)).toBe(true)
      }),
    {
      config: {
        formatter: {
          marker: {
            // The command writes its marker into the formatter's working directory (the
            // instance directory), so a launched formatter is detectable without a static
            // temp path in the config.
            command: [
              "node",
              "-e",
              "require('fs').writeFileSync('formatter-ran', 'ran'); require('fs').appendFileSync(process.argv[1], 'A')",
              "$FILE",
            ],
            extensions: [".marker"],
          },
        },
      },
    },
  )

  it.instance(
    "matching formatters are withheld for the same file and never launch a process",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.seq`
        yield* Effect.promise(() => Bun.write(file, "x"))

        yield* Format.Service.use((fmt) =>
          Effect.gen(function* () {
            yield* fmt.init()
            expect(yield* fmt.file(file)).toBe(false)
          }),
        )

        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("x")
      }),
    {
      config: {
        formatter: {
          first: {
            command: [
              "node",
              "-e",
              "const fs = require('fs'); const file = process.argv[1]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'A')",
              "$FILE",
            ],
            extensions: [".seq"],
          },
          second: {
            command: [
              "node",
              "-e",
              "const fs = require('fs'); const file = process.argv[1]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'B')",
              "$FILE",
            ],
            extensions: [".seq"],
          },
        },
      },
    },
  )
})
