import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RepoIntel, type RepoIntelBackend, type RepoIntelSnapshot } from "../../src/tool/repo-intel"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node])))

const withTmp = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-repo-intel-"))),
    (dir) => use(dir),
    (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
  )

const write = (dir: string, rel: string, content: string | Uint8Array) =>
  Effect.promise(async () => {
    const target = path.join(dir, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  })

const scope = (dir: string, scopeId = "ws-1") => ({ root: dir, scopeId })

type QueryRecord = {
  generationId: string
  query: string
  maxResults: number
  cursor?: string
}

const encodeCursor = (generationId: string, matchPath: string, line: number) =>
  Buffer.from(JSON.stringify([generationId, matchPath, line]), "utf-8").toString("base64")

const decodeCursor = (cursor: string) => {
  const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) as [string, string, number]
  return { generationId: parsed[0], path: parsed[1], line: parsed[2] }
}

/**
 * Deterministic in-process backend used only to exercise the adapter's scope,
 * boundary, provenance, invalidation and cancellation behavior. It mirrors the
 * indexd response/error contract but is not an index implementation.
 */
const makeBackend = (options: { onQuery?: () => Effect.Effect<void>; holdQuery?: boolean } = {}) => {
  const generations = new Map<string, ReadonlyArray<RepoIntelSnapshot>>()
  const state = { builds: 0, queries: 0, released: 0 }
  const queries: Array<QueryRecord> = []
  const buildInputs: Array<{ pins: unknown; paths: ReadonlyArray<string> }> = []

  const backend: RepoIntelBackend = {
    build: (pins, snapshots) =>
      Effect.sync(() => {
        state.builds++
        buildInputs.push({ pins, paths: snapshots.map((snapshot) => snapshot.path) })
        const id = createHash("sha256")
          .update(
            JSON.stringify([
              pins,
              snapshots.map((snapshot) => [snapshot.path, Buffer.from(snapshot.contents).toString("base64")]),
            ]),
          )
          .digest("hex")
        generations.set(id, snapshots)
        return { generationId: id, generationStatus: "PARTIAL" as const }
      }),
    query: (handle, request) =>
      Effect.gen(function* () {
        state.queries++
        queries.push({
          generationId: handle.generationId,
          query: request.query,
          maxResults: request.maxResults,
          ...(request.cursor ? { cursor: request.cursor } : {}),
        })
        if (options.onQuery) yield* options.onQuery()
        if (options.holdQuery) yield* Effect.never
        const snapshots = generations.get(handle.generationId)
        if (!snapshots) {
          return yield* Effect.fail(
            new RepoIntel.RepoIntelBackendError({ code: "generation_mismatch", detail: "unknown generation" }),
          )
        }
        let after: { path: string; line: number } | undefined
        if (request.cursor) {
          const decoded = decodeCursor(request.cursor)
          if (decoded.generationId !== handle.generationId) {
            return yield* Effect.fail(
              new RepoIntel.RepoIntelBackendError({
                code: "cursor_generation_mismatch",
                detail: "cursor is bound to another generation",
              }),
            )
          }
          after = { path: decoded.path, line: decoded.line }
        }
        const matches: Array<RepoIntel.RepoIntelMatch> = []
        let resumed = after === undefined
        let truncated = false
        for (const snapshot of snapshots) {
          const lines = new TextDecoder().decode(snapshot.contents).split("\n")
          for (let index = 0; index < lines.length; index++) {
            if (!lines[index]!.includes(request.query)) continue
            const line = index + 1
            if (!resumed) {
              if (after!.path === snapshot.path && after!.line === line) resumed = true
              continue
            }
            if (matches.length >= request.maxResults) {
              truncated = true
              break
            }
            matches.push({ path: snapshot.path, startLine: line, endLine: line })
          }
          if (truncated) break
        }
        if (!resumed) {
          return yield* Effect.fail(
            new RepoIntel.RepoIntelBackendError({ code: "cursor_anchor_not_found", detail: "anchor not found" }),
          )
        }
        const last = matches[matches.length - 1]
        return {
          status: "PARTIAL" as const,
          generationId: handle.generationId,
          matches,
          ...(truncated && last
            ? {
                truncatedBy: "result_limit" as const,
                nextCursor: encodeCursor(handle.generationId, last.path, last.startLine),
              }
            : {}),
        }
      }),
    release: () =>
      Effect.sync(() => {
        state.released++
      }),
  }
  return { backend, state, queries, buildInputs }
}

type Spy = {
  fs: FSUtil.Interface
  counters: { reads: number; readdirs: number }
}

const spyFs = (
  base: FSUtil.Interface,
  options: { abortAfterReads?: number; controller?: AbortController } = {},
): Spy => {
  const counters = { reads: 0, readdirs: 0 }
  const fs = {
    ...base,
    readFile: (target: string) => {
      counters.reads++
      if (options.abortAfterReads !== undefined && counters.reads > options.abortAfterReads) {
        options.controller?.abort()
      }
      return base.readFile(target)
    },
    readDirectoryEntries: (target: string) => {
      counters.readdirs++
      return base.readDirectoryEntries(target)
    },
  } as FSUtil.Interface
  return { fs, counters }
}

const expectFailure = (effect: Effect.Effect<unknown, RepoIntel.RepoIntelError>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) throw new Error("expected repo-intel operation to fail")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(RepoIntel.RepoIntelError)
    return error as RepoIntel.RepoIntelError
  })

describe("tool.repo-intel", () => {
  it.live("returns generation-bound lexical matches for an admitted scope", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "src/a.txt", "let needle = 1;\n")
        yield* write(dir, "src/b.txt", "none\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const result = yield* service.searchText({
          scope: scope(dir),
          subpath: "src",
          query: "needle",
          maxResults: 10,
        })

        expect(result.operation).toBe("text")
        expect(result.status).toBe("PARTIAL")
        expect(result.freshness).toBe("fresh")
        expect(result.generationId.length).toBeGreaterThan(0)
        expect(result.matches).toEqual([{ path: "src/a.txt", startLine: 1, endLine: 1 }])
        expect(result.skipped).toEqual([])
        expect(result.truncation).toEqual([])
        expect(result.scanned.files).toBe(2)
        expect(result.scanned.bytes).toBeGreaterThan(0)
        expect(state.builds).toBe(1)
        expect(state.queries).toBe(1)
      }),
    ),
  )

  it.live("reports partial results truthfully when files are skipped", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "small.txt", "needle\n")
        yield* write(dir, "large.txt", new Uint8Array(RepoIntel.MAX_FILE_BYTES + 1).fill(0x61))
        const base = yield* FSUtil.Service
        const { backend, buildInputs } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const result = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })

        expect(result.matches).toEqual([{ path: "small.txt", startLine: 1, endLine: 1 }])
        expect(result.freshness).toBe("partial")
        expect(result.truncation).toContain("skipped_files")
        expect(result.skipped).toEqual([{ path: "large.txt", reason: "too_large" }])
        expect(result.skippedCount).toBe(1)
        expect(buildInputs[0]!.paths).toEqual(["small.txt"])
      }),
    ),
  )

  it.live("relays result-limit truncation and continues with a cursor in the same generation", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\nneedle\nneedle\n")
        const base = yield* FSUtil.Service
        const { backend, state, queries } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const first = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 1 })
        expect(first.matches).toEqual([{ path: "a.txt", startLine: 1, endLine: 1 }])
        expect(first.freshness).toBe("partial")
        expect(first.truncation).toContain("result_limit")
        expect(first.nextCursor).toBeDefined()

        const second = yield* service.searchText({
          scope: scope(dir),
          query: "needle",
          maxResults: 1,
          cursor: first.nextCursor!,
        })
        expect(second.matches).toEqual([{ path: "a.txt", startLine: 2, endLine: 2 }])
        expect(second.generationId).toBe(first.generationId)

        const third = yield* service.searchText({
          scope: scope(dir),
          query: "needle",
          maxResults: 1,
          cursor: second.nextCursor!,
        })
        expect(third.matches).toEqual([{ path: "a.txt", startLine: 3, endLine: 3 }])
        expect(third.truncation).not.toContain("result_limit")

        const lines = [first, second, third].flatMap((page) => page.matches.map((match) => match.startLine))
        expect(lines.sort()).toEqual([1, 2, 3])
        expect(state.builds).toBe(1)
        expect(queries.map((query) => query.cursor !== undefined)).toEqual([false, true, true])
      }),
    ),
  )

  it.live("labels results stale when the source changes during the query", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend } = makeBackend({ onQuery: () => write(dir, "a.txt", "needle changed\n") })
        const service = RepoIntel.make({ fs: base, backend })

        const result = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })

        expect(result.freshness).toBe("stale")
        expect(result.staleReason).toBe("source_changed")
        // The matches still describe the collected generation; they never authorize a write.
        expect(result.matches).toEqual([{ path: "a.txt", startLine: 1, endLine: 1 }])
      }),
    ),
  )

  it.live("rejects a stale expected generation and rebuilds after a source change", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const first = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(first.freshness).toBe("fresh")
        const reused = yield* service.searchText({
          scope: scope(dir),
          query: "needle",
          maxResults: 10,
          expectedGenerationId: first.generationId,
        })
        expect(reused.generationId).toBe(first.generationId)

        yield* write(dir, "a.txt", "needle needle\nneedle\n")
        const stale = yield* expectFailure(
          service.searchText({
            scope: scope(dir),
            query: "needle",
            maxResults: 10,
            expectedGenerationId: first.generationId,
          }),
        )
        expect(stale.code).toBe("stale_generation")

        const second = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(second.generationId).not.toBe(first.generationId)
        expect(second.freshness).toBe("fresh")
        expect(second.matches.length).toBe(2)
        expect(stale.detail).toContain(first.generationId)
        expect(stale.detail).toContain(second.generationId)
        expect(state.queries).toBeGreaterThanOrEqual(2)
      }),
    ),
  )

  it.live("reuses the cached generation while the observation is unchanged and rebuilds after invalidate", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const first = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        const second = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(second.generationId).toBe(first.generationId)
        expect(state.builds).toBe(1)

        const removed = yield* service.invalidate("ws-1")
        expect(removed).toBe(1)
        expect(state.released).toBe(1)
        expect((yield* service.stats()).entries).toBe(0)

        const third = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(third.generationId).toBe(first.generationId)
        expect(state.builds).toBe(2)
      }),
    ),
  )

  it.live("fails cancelled when the caller aborts during the query", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const controller = new AbortController()
        const { backend } = makeBackend({
          onQuery: () =>
            Effect.sync(() => {
              controller.abort()
            }),
          holdQuery: true,
        })
        const service = RepoIntel.make({ fs: base, backend })

        const failure = yield* expectFailure(
          service.searchText({ scope: scope(dir), query: "needle", maxResults: 10, signal: controller.signal }),
        )
        expect(failure.code).toBe("cancelled")
      }),
    ),
  )

  it.live("stops collection without further reads when the caller aborts mid-scan", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        yield* write(dir, "b.txt", "needle\n")
        yield* write(dir, "c.txt", "needle\n")
        const base = yield* FSUtil.Service
        const controller = new AbortController()
        const spy = spyFs(base, { abortAfterReads: 0, controller })
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: spy.fs, backend })

        const failure = yield* expectFailure(
          service.searchText({ scope: scope(dir), query: "needle", maxResults: 10, signal: controller.signal }),
        )
        expect(failure.code).toBe("cancelled")
        expect(spy.counters.reads).toBe(1)
        expect(state.builds).toBe(0)
      }),
    ),
  )

  it.live("denies an out-of-scope subpath before any read or match", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const base = yield* FSUtil.Service
        const spy = spyFs(base)
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: spy.fs, backend })

        for (const subpath of ["../outside", "/etc", "a/../../b", "..", "a\\..\\b"]) {
          const failure = yield* expectFailure(
            service.searchText({ scope: scope(dir), subpath, query: "needle", maxResults: 10 }),
          )
          expect(failure.code).toBe("scope_denied")
        }
        expect(spy.counters.reads).toBe(0)
        expect(spy.counters.readdirs).toBe(0)
        expect(state.builds).toBe(0)
        expect(state.queries).toBe(0)
      }),
    ),
  )

  it.live("keeps generations isolated between scopes and rejects a cross-scope cursor", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\nneedle\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const first = yield* service.searchText({ scope: scope(dir, "ws-a"), query: "needle", maxResults: 1 })
        expect(first.nextCursor).toBeDefined()
        const other = yield* service.searchText({ scope: scope(dir, "ws-b"), query: "needle", maxResults: 1 })
        expect(other.generationId).not.toBe(first.generationId)
        expect(state.builds).toBe(2)

        const failure = yield* expectFailure(
          service.searchText({
            scope: scope(dir, "ws-b"),
            query: "needle",
            maxResults: 1,
            cursor: first.nextCursor!,
          }),
        )
        expect(failure.code).toBe("stale_generation")
      }),
    ),
  )

  it.live("validates query and result bounds before touching the filesystem", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const spy = spyFs(base)
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: spy.fs, backend })

        const cases: Array<{
          input: Parameters<RepoIntel.Interface["searchText"]>[0]
          code: RepoIntel.RepoIntelErrorCode
        }> = [
          { input: { scope: scope(dir), query: "", maxResults: 10 }, code: "invalid_query" },
          {
            input: { scope: scope(dir), query: "x".repeat(RepoIntel.MAX_QUERY_BYTES + 1), maxResults: 10 },
            code: "query_too_large",
          },
          { input: { scope: scope(dir), query: "a\nb", maxResults: 10 }, code: "multiline_query" },
          { input: { scope: scope(dir), query: "needle", maxResults: 0 }, code: "invalid_result_limit" },
          {
            input: { scope: scope(dir), query: "needle", maxResults: RepoIntel.MAX_QUERY_RESULTS + 1 },
            code: "invalid_result_limit",
          },
        ]
        for (const testCase of cases) {
          const failure = yield* expectFailure(service.searchText(testCase.input))
          expect(failure.code).toBe(testCase.code)
        }
        expect(spy.counters.reads).toBe(0)
        expect(spy.counters.readdirs).toBe(0)
        expect(state.builds).toBe(0)
      }),
    ),
  )

  it.live("skips files whose paths indexd cannot accept and reports them", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        yield* write(dir, "a:b.txt", "needle\n")
        yield* write(dir, "b.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, buildInputs } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const result = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })

        expect(result.matches).toEqual([{ path: "b.txt", startLine: 1, endLine: 1 }])
        expect(result.skipped).toEqual([{ path: "a:b.txt", reason: "invalid_path" }])
        expect(result.freshness).toBe("partial")
        expect(buildInputs[0]!.paths).toEqual(["b.txt"])
      }),
    ),
  )

  it.live("never follows symlinks out of the admitted scope", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const outside = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-repo-intel-outside-"))),
          (target) => Effect.promise(() => fs.rm(target, { recursive: true, force: true })),
        )
        yield* write(outside, "secret.txt", "needle\n")
        yield* Effect.promise(() => fs.symlink(outside, path.join(dir, "linked"), "dir"))
        yield* Effect.promise(() => fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "link.txt")))
        yield* write(dir, "local.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, buildInputs } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const result = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })

        expect(result.matches).toEqual([{ path: "local.txt", startLine: 1, endLine: 1 }])
        expect(result.skipped).toEqual([
          { path: "link.txt", reason: "symlink" },
          { path: "linked", reason: "symlink" },
        ])
        expect(buildInputs[0]!.paths).toEqual(["local.txt"])
        expect(result.freshness).toBe("partial")
      }),
    ),
  )
})
