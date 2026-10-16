import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, FileSystem } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ArtifactSearch } from "../../src/tool/artifact-search"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node])))

const withTmp = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-artifact-search-"))),
    (dir) => use(dir),
    (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
  )

const write = (dir: string, rel: string, content: string | Uint8Array) =>
  Effect.promise(() => fs.writeFile(path.join(dir, rel), content))

const spyFs = (base: FSUtil.Interface, options: { onOpen?: (target: string) => Effect.Effect<void> } = {}) => {
  const counters = { opens: 0, stats: 0 }
  const fs = {
    ...base,
    open: (...args: Parameters<FSUtil.Interface["open"]>) => {
      counters.opens++
      const opened = base.open(...args)
      if (!options.onOpen) return opened
      const hook = options.onOpen
      return Effect.flatMap(opened, (handle) => Effect.as(hook(args[0]), handle))
    },
    stat: (...args: Parameters<FSUtil.Interface["stat"]>) => {
      counters.stats++
      return base.stat(...args)
    },
  } as FSUtil.Interface
  return { fs, counters }
}

const expectFailure = (effect: Effect.Effect<unknown, ArtifactSearch.ArtifactSearchError>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) throw new Error("expected artifact search to fail")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(ArtifactSearch.ArtifactSearchError)
    return error as ArtifactSearch.ArtifactSearchError
  })

describe("tool.artifact-search", () => {
  it.live("finds a bounded literal match with generation provenance", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const contents = "line one\nneedle here\nlast line\n"
        yield* write(dir, "tool_1.log", contents)
        const base = yield* FSUtil.Service
        const service = ArtifactSearch.make({ fs: base, root: dir })

        const result = yield* service.search({ artifactId: "tool_1.log", query: "needle" })

        expect(result.artifactId).toBe("tool_1.log")
        expect(result.generation.startsWith("a1:")).toBe(true)
        expect(result.freshness).toBe("fresh")
        expect(result.matches).toEqual([{ line: 1, byteOffset: 9, text: "needle here", excerptTruncated: false }])
        expect(result.scannedBytes).toBe(Buffer.byteLength(contents))
        expect(result.totalBytes).toBe(Buffer.byteLength(contents))
        expect(result.longLinesSkipped).toBe(0)
        expect(result.truncation).toEqual([])
      }),
    ),
  )

  it.live("locates a target line in a large artifact without flooding output", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const header = "noise line\n".repeat(150_000)
        const target = "ERROR target found\n"
        const tail = "trailing noise\n".repeat(1_000)
        yield* write(dir, "tool_large.log", header + target + tail)
        const base = yield* FSUtil.Service
        const service = ArtifactSearch.make({ fs: base, root: dir })

        const result = yield* service.search({ artifactId: "tool_large.log", query: "ERROR target found" })

        expect(result.matches.length).toBe(1)
        expect(result.matches[0]!.line).toBe(150_000)
        expect(result.matches[0]!.byteOffset).toBe(Buffer.byteLength(header))
        expect(result.matches[0]!.text).toBe("ERROR target found")
        expect(result.scannedBytes).toBe(Buffer.byteLength(header + target + tail))
        expect(result.freshness).toBe("fresh")
      }),
    ),
  )

  it.live("bounds excerpt bytes and keeps the match start in the excerpt", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const line = "x".repeat(100) + "needle" + "y".repeat(100)
        yield* write(dir, "tool_excerpt.log", `${line}\n`)
        const base = yield* FSUtil.Service
        const service = ArtifactSearch.make({ fs: base, root: dir })

        const result = yield* service.search({
          artifactId: "tool_excerpt.log",
          query: "needle",
          maxBytesPerExcerpt: 32,
        })

        const match = result.matches[0]!
        expect(Buffer.byteLength(match.text)).toBeLessThanOrEqual(32)
        expect(match.text).toContain("needle")
        expect(match.excerptTruncated).toBe(true)
      }),
    ),
  )

  it.live("reports result-limit truncation as partial", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "tool_many.log", "needle\n".repeat(5))
        const base = yield* FSUtil.Service
        const service = ArtifactSearch.make({ fs: base, root: dir })

        const result = yield* service.search({ artifactId: "tool_many.log", query: "needle", maxResults: 2 })

        expect(result.matches.map((match) => match.line)).toEqual([0, 1])
        expect(result.truncation).toContain("result_limit")
        expect(result.freshness).toBe("partial")
      }),
    ),
  )

  it.live("stops at the scan limit and reports it truthfully", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "tool_scan.log", "aaaa\n".repeat(1_024))
        const base = yield* FSUtil.Service
        const service = ArtifactSearch.make({ fs: base, root: dir })

        const result = yield* service.search({ artifactId: "tool_scan.log", query: "needle", maxScanBytes: 1_024 })

        expect(result.scannedBytes).toBe(1_024)
        expect(result.truncation).toContain("scan_limit")
        expect(result.freshness).toBe("partial")
        expect(result.matches).toEqual([])
      }),
    ),
  )

  it.live("rejects a stale expected generation after the artifact changes", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "tool_4.log", "keep\nneedle\n")
        const base = yield* FSUtil.Service
        const service = ArtifactSearch.make({ fs: base, root: dir })

        const first = yield* service.search({ artifactId: "tool_4.log", query: "needle" })
        const reused = yield* service.search({
          artifactId: "tool_4.log",
          query: "needle",
          expectedGeneration: first.generation,
        })
        expect(reused.generation).toBe(first.generation)

        yield* write(dir, "tool_4.log", "rotated away\n")
        const staleSearch = yield* expectFailure(
          service.search({ artifactId: "tool_4.log", query: "needle", expectedGeneration: first.generation }),
        )
        expect(staleSearch.code).toBe("stale_generation")

        const staleRange = yield* expectFailure(
          service.readRange({
            artifactId: "tool_4.log",
            lineStart: 0,
            lineEndExclusive: 1,
            expectedGeneration: first.generation,
          }),
        )
        expect(staleRange.code).toBe("stale_generation")
      }),
    ),
  )

  it.live("labels results stale when the artifact changes during the scan", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "tool_5.log", "needle\n" + "x".repeat(300_000))
        const base = yield* FSUtil.Service
        const spy = spyFs(base, {
          onOpen: (target) => Effect.promise(() => fs.truncate(target, 6)),
        })
        const service = ArtifactSearch.make({ fs: spy.fs, root: dir })

        const result = yield* service.search({ artifactId: "tool_5.log", query: "needle" })

        expect(result.freshness).toBe("stale")
        expect(result.staleReason).toBe("source_changed")
        expect(spy.counters.opens).toBe(1)
      }),
    ),
  )

  it.live("cancels without reading unbounded data", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "tool_6.log", "line\n".repeat(60_000))
        const base = yield* FSUtil.Service
        const controller = new AbortController()
        const reads = { count: 0 }
        const spy = spyFs(base, {
          onOpen: () => Effect.void,
        })
        // Wrap opens to hand back a read-counting, aborting handle for the scan.
        const hooked = {
          ...spy.fs,
          open: (...args: Parameters<FSUtil.Interface["open"]>) =>
            Effect.map(base.open(...args), (handle) => {
              const proxied = new Proxy(handle, {
                get(target, prop, receiver) {
                  if (prop === "readAlloc") {
                    return (size: number) => {
                      reads.count++
                      if (reads.count === 1) controller.abort()
                      return target.readAlloc(size)
                    }
                  }
                  const value = Reflect.get(target, prop, receiver)
                  return typeof value === "function" ? value.bind(target) : value
                },
              }) as FileSystem.File
              return proxied
            }),
        } as FSUtil.Interface
        const service = ArtifactSearch.make({ fs: hooked, root: dir })

        const failure = yield* expectFailure(
          service.search({ artifactId: "tool_6.log", query: "line", signal: controller.signal }),
        )
        expect(failure.code).toBe("cancelled")
        expect(reads.count).toBe(1)
      }),
    ),
  )

  it.live("denies path-like or invalid artifact ids before any open", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "tool_ok.log", "needle\n")
        const base = yield* FSUtil.Service
        const spy = spyFs(base)
        const service = ArtifactSearch.make({ fs: spy.fs, root: dir })

        for (const artifactId of ["../escape", "/etc/passwd", "a/b", "..", "", "a\\b", ".hidden", "a:b"]) {
          const failure = yield* expectFailure(service.search({ artifactId, query: "needle" }))
          expect(failure.code).toBe("invalid_artifact_id")
        }
        expect(spy.counters.opens).toBe(0)
      }),
    ),
  )

  it.live("returns not_found for a missing artifact", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const base = yield* FSUtil.Service
        const spy = spyFs(base)
        const service = ArtifactSearch.make({ fs: spy.fs, root: dir })

        const failure = yield* expectFailure(service.search({ artifactId: "tool_missing.log", query: "needle" }))

        expect(failure.code).toBe("not_found")
        expect(spy.counters.opens).toBe(0)
      }),
    ),
  )

  it.live("supports bounded regex mode and rejects invalid patterns", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "tool_7.log", "alpha\nbeta needle\n")
        const base = yield* FSUtil.Service
        const service = ArtifactSearch.make({ fs: base, root: dir })

        const result = yield* service.search({ artifactId: "tool_7.log", query: "beta|alpha", mode: "regex" })
        expect(result.matches.map((match) => match.line)).toEqual([0, 1])

        for (const input of [
          { query: "(", mode: "regex" as const },
          { query: "ok", mode: "regex" as const, flags: "g" },
          { query: "ok", mode: "regex" as const, flags: "z" },
        ]) {
          const failure = yield* expectFailure(service.search({ artifactId: "tool_7.log", ...input }))
          expect(failure.code).toBe("invalid_pattern")
        }
      }),
    ),
  )

  it.live("skips over-long lines but keeps counting them", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const long = "x".repeat(ArtifactSearch.MAX_LINE_BYTES + 5_000)
        yield* write(dir, "tool_long.log", `${long}\nneedle after long line\n`)
        const base = yield* FSUtil.Service
        const service = ArtifactSearch.make({ fs: base, root: dir })

        const result = yield* service.search({ artifactId: "tool_long.log", query: "needle" })

        expect(result.longLinesSkipped).toBe(1)
        expect(result.truncation).toContain("long_lines")
        expect(result.freshness).toBe("partial")
        expect(result.matches.length).toBe(1)
        expect(result.matches[0]!.line).toBe(1)
        expect(result.matches[0]!.byteOffset).toBe(Buffer.byteLength(long) + 1)
      }),
    ),
  )

  it.live("reads a bounded zero-based line range with generation binding", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "tool_8.log", "l0\nl1\nl2\nl3\n")
        const base = yield* FSUtil.Service
        const service = ArtifactSearch.make({ fs: base, root: dir })

        const range = yield* service.readRange({ artifactId: "tool_8.log", lineStart: 1, lineEndExclusive: 3 })
        expect(range.text).toBe("l1\nl2\n")
        expect(range.bytes).toBe(6)
        expect(range.truncated).toBe(false)
        expect(range.lineEndExclusive).toBe(3)

        const bounded = yield* service.readRange({
          artifactId: "tool_8.log",
          lineStart: 1,
          lineEndExclusive: 3,
          maxBytes: 3,
        })
        expect(bounded.text).toBe("l1\n")
        expect(bounded.truncated).toBe(true)
        expect(bounded.lineEndExclusive).toBe(2)

        const clamped = yield* service.readRange({ artifactId: "tool_8.log", lineStart: 2, lineEndExclusive: 99 })
        expect(clamped.text).toBe("l2\nl3\n")
        expect(clamped.lineEndExclusive).toBe(4)

        for (const input of [
          { lineStart: -1, lineEndExclusive: 2 },
          { lineStart: 2, lineEndExclusive: 2 },
          { lineStart: 0, lineEndExclusive: 0 },
        ]) {
          const failure = yield* expectFailure(service.readRange({ artifactId: "tool_8.log", ...input }))
          expect(failure.code).toBe("invalid_range")
        }
      }),
    ),
  )
})
