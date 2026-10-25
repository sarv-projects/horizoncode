import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as RepoIntelligenceSchema from "@opencode-ai/schema/repo-intelligence-v1"
import { Digest } from "@opencode-ai/schema/composition-v1"
import { Location as LocationSchema } from "@opencode-ai/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { RepoIntel, type RepoIntelBackend, type RepoIntelSnapshot } from "../../src/tool/repo-intel"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])))
const itUnavailable = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, RepoIntel.node])))

const withTmp = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    return yield* use(dir)
  })

const write = (dir: string, rel: string, content: string | Uint8Array) =>
  Effect.promise(async () => {
    const target = path.join(dir, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  })

const scope = (dir: string, scopeId = "ws-1") => ({ root: dir, scopeId })

type QueryRecord = {
  generationId: string
  operation: RepoIntel.RepoIntelOperation
  query: string
  maxResults: number
  cursor?: string
  overlayDigest?: string
}

const encodeCursor = (generationId: string, matchPath: string, line: number, overlayDigest?: string) =>
  Buffer.from(JSON.stringify([generationId, matchPath, line, overlayDigest ?? null]), "utf-8").toString("base64")

const decodeCursor = (cursor: string) => {
  const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) as [string, string, number, string | null]
  return { generationId: parsed[0], path: parsed[1], line: parsed[2], overlayDigest: parsed[3] ?? null }
}

const structureGeneration = Schema.decodeUnknownSync(Digest)(`blake3:${"1".repeat(64)}`)
const structureRevision = Schema.decodeUnknownSync(Digest)(`blake3:${"2".repeat(64)}`)
const structureQuery: Omit<RepoIntelligenceSchema.RepoStructureQueryV1, "sourceGeneration"> = {
  schemaVersion: 1,
  messageType: "query",
  queryId: "query-1",
  rootRef: ".",
  selector: { symbols: ["entry"] },
  maxNodes: 8,
  maxBytes: 4096,
  maxDepth: 4,
  deadline: "2026-10-19T12:30:45.123Z",
}
const structureRequest = {
  sessionID: "ses_01J9ABCDEF0123456789ABCDEFGH",
  locationRef: LocationSchema.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  query: structureQuery,
  analysisProfile: RepoIntel.DEFAULT_ANALYSIS_PROFILE,
}
const unavailableStructurePage: RepoIntelligenceSchema.RepoStructurePageV1 = {
  schemaVersion: 1,
  messageType: "page",
  queryId: "query-1",
  workspaceBinding: "workspace-binding-1",
  sourceGeneration: structureGeneration,
  sourceRevision: structureRevision,
  sourceKind: "none",
  status: "UNAVAILABLE",
  freshness: "unknown",
  completeness: "unavailable",
  coverage: { files: "0", nodes: "0", bytes: "0" },
  nodes: [],
  fallback: { reason: "parser_unsupported", sourceKind: "none" },
}

type OperationOverride = {
  readonly status: "PARTIAL" | "UNAVAILABLE"
  readonly matches?: ReadonlyArray<RepoIntel.RepoIntelMatch>
  readonly unavailableReason?: { readonly operation: RepoIntel.RepoIntelOperation }
}

/**
 * Deterministic in-process backend used only to exercise the adapter's scope,
 * boundary, provenance, overlay, invalidation and cancellation behavior. It
 * mirrors the indexd response/error contract but is not an index implementation.
 *
 * Text queries run a lexical scan over the exact generation with any applied
 * overlay shadowing base bytes. Symbol and reference queries report typed
 * UNAVAILABLE unless the test overrides that operation's response.
 */
const makeBackend = (
  options: {
    onQuery?: () => Effect.Effect<void>
    onBuild?: () => Effect.Effect<void>
    holdQuery?: boolean
    /** Omit buildOverlay/releaseOverlay to simulate a lexical-only backend. */
    withoutOverlay?: boolean
    /** Fail every overlay construction with this backend error code. */
    overlayFailure?: "overlay_generation_mismatch" | "unavailable"
    /** Per-operation response override; unset operations keep default behavior. */
    operationResponses?: Partial<Record<RepoIntel.RepoIntelOperation, OperationOverride>>
  } = {},
) => {
  const generations = new Map<string, ReadonlyArray<RepoIntelSnapshot>>()
  const overlays = new Map<
    string,
    { generationId: string; changes: ReadonlyArray<RepoIntel.RepoIntelBackendOverlayChange> }
  >()
  const state = { builds: 0, queries: 0, released: 0, overlays: 0, releasedOverlays: 0 }
  const queries: Array<QueryRecord> = []
  const buildInputs: Array<{ pins: unknown; paths: ReadonlyArray<string> }> = []
  const overlayInputs: Array<{
    generationId: string
    editorVersion: string
    changes: ReadonlyArray<RepoIntel.RepoIntelBackendOverlayChange>
    digest: string
  }> = []

  const backend: RepoIntelBackend = {
    build: (pins, snapshots) =>
      Effect.gen(function* () {
        if (options.onBuild) yield* options.onBuild()
        return yield* Effect.sync(() => {
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
        })
      }),
    query: (handle, request) =>
      Effect.gen(function* () {
        state.queries++
        queries.push({
          generationId: handle.generationId,
          operation: request.operation,
          query: request.query,
          maxResults: request.maxResults,
          ...(request.cursor ? { cursor: request.cursor } : {}),
          ...(request.overlay ? { overlayDigest: request.overlay.overlayDigest } : {}),
        })
        if (options.onQuery) yield* options.onQuery()
        if (options.holdQuery) yield* Effect.never
        const base = generations.get(handle.generationId)
        if (!base) {
          return yield* Effect.fail(
            new RepoIntel.RepoIntelBackendError({ code: "generation_mismatch", detail: "unknown generation" }),
          )
        }
        const override = options.operationResponses?.[request.operation]
        if (override !== undefined) {
          return {
            status: override.status,
            generationId: handle.generationId,
            matches: override.matches ?? [],
            ...(override.unavailableReason !== undefined ? { unavailableReason: override.unavailableReason } : {}),
            ...(request.overlay ? { overlayDigest: request.overlay.overlayDigest } : {}),
          }
        }
        if (request.operation !== "text") {
          return {
            status: "UNAVAILABLE" as const,
            generationId: handle.generationId,
            matches: [],
            unavailableReason: { operation: request.operation },
            ...(request.overlay ? { overlayDigest: request.overlay.overlayDigest } : {}),
          }
        }
        let snapshots = base
        if (request.overlay) {
          const applied = overlays.get(request.overlay.overlayDigest)
          if (!applied || applied.generationId !== handle.generationId) {
            return yield* Effect.fail(
              new RepoIntel.RepoIntelBackendError({
                code: "overlay_generation_mismatch",
                detail: "overlay is bound to another generation",
              }),
            )
          }
          snapshots = base.map((snapshot) => {
            const change = applied.changes.find((candidate) => candidate.path === snapshot.path)
            if (change === undefined || change.contents === null) return snapshot
            return { path: snapshot.path, contents: change.contents }
          })
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
          if ((decoded.overlayDigest ?? null) !== (request.overlay?.overlayDigest ?? null)) {
            return yield* Effect.fail(
              new RepoIntel.RepoIntelBackendError({
                code: "cursor_overlay_mismatch",
                detail: "cursor is bound to another overlay",
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
          ...(request.overlay ? { overlayDigest: request.overlay.overlayDigest } : {}),
          ...(truncated && last
            ? {
                truncatedBy: "result_limit" as const,
                nextCursor: encodeCursor(
                  handle.generationId,
                  last.path,
                  last.startLine,
                  request.overlay?.overlayDigest,
                ),
              }
            : {}),
        }
      }),
    release: () =>
      Effect.sync(() => {
        state.released++
      }),
    ...(options.withoutOverlay
      ? {}
      : {
          buildOverlay: (handle: RepoIntel.RepoIntelGenerationHandle, overlay: RepoIntel.RepoIntelBackendOverlay) =>
            Effect.gen(function* () {
              if (options.overlayFailure) {
                return yield* Effect.fail(
                  new RepoIntel.RepoIntelBackendError({
                    code: options.overlayFailure,
                    detail: "simulated overlay construction failure",
                  }),
                )
              }
              const snapshots = generations.get(handle.generationId)
              if (!snapshots) {
                return yield* Effect.fail(
                  new RepoIntel.RepoIntelBackendError({
                    code: "overlay_generation_mismatch",
                    detail: "unknown generation",
                  }),
                )
              }
              return yield* Effect.sync(() => {
                const known = new Set(snapshots.map((snapshot) => snapshot.path))
                for (const change of overlay.changes) {
                  if (!known.has(change.path)) {
                    throw new Error(`the adapter must not relay an overlay path outside the generation: ${change.path}`)
                  }
                }
                const digest = createHash("sha256")
                  .update(
                    JSON.stringify([
                      handle.generationId,
                      overlay.editorVersion,
                      overlay.changes.map((change) => [
                        change.path,
                        change.contents === null ? null : Buffer.from(change.contents).toString("base64"),
                      ]),
                    ]),
                  )
                  .digest("hex")
                overlays.set(digest, { generationId: handle.generationId, changes: overlay.changes })
                overlayInputs.push({
                  generationId: handle.generationId,
                  editorVersion: overlay.editorVersion,
                  changes: overlay.changes,
                  digest,
                })
                state.overlays++
                return { overlayDigest: digest }
              })
            }),
          releaseOverlay: () =>
            Effect.sync(() => {
              state.releasedOverlays++
            }),
        }),
  }
  return { backend, state, queries, buildInputs, overlayInputs }
}

type Spy = {
  fs: FSUtil.Interface
  source: RepoIntel.RepoIntelSource
  counters: { reads: number; readdirs: number }
}

const spyFs = (
  base: FSUtil.Interface,
  options: {
    abortAfterReads?: number
    controller?: AbortController
    afterResolve?: (target: string, resolved: string) => Effect.Effect<void>
  } = {},
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
    resolve: (target: string) => {
      const resolved = base.resolve(target)
      if (!options.afterResolve) return resolved
      return Effect.flatMap(resolved, (value) => Effect.as(options.afterResolve!(target, value), value))
    },
  } as FSUtil.Interface
  const source: RepoIntel.RepoIntelSource = {
    openRoot: (root) =>
      Effect.map(RepoIntel.nodeSource.openRoot(root), (opened) => ({
        ...opened,
        readFile: (rel, maxBytes) => {
          counters.reads++
          if (options.abortAfterReads !== undefined && counters.reads > options.abortAfterReads) {
            options.controller?.abort()
          }
          return opened.readFile(rel, maxBytes)
        },
        readDirectoryEntriesBounded: (rel, maxEntries) => {
          counters.readdirs++
          return opened.readDirectoryEntriesBounded!(rel, maxEntries)
        },
      })),
  }
  return { fs, source, counters }
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
  const bridgeGeneration = `blake3:${"a".repeat(64)}`

  itUnavailable.live("fails unavailable before resolving a repository root without a HostKernel backend", () =>
    Effect.gen(function* () {
      const service = yield* RepoIntel.Service
      const failure = yield* expectFailure(
        service.searchText({
          scope: scope(path.join(os.tmpdir(), "horizon-repo-intel-missing-root")),
          query: "needle",
        }),
      )

      expect(failure.code).toBe("backend_unavailable")
    }),
  )

  it.live("resolves the trusted analysis profile once per query", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "src/a.ts", "const answer = 42\n")
        const base = yield* FSUtil.Service
        let resolutions = 0
        const service = RepoIntel.make({
          fs: base,
          backend: makeBackend().backend,
          resolveProfile: () => {
            resolutions++
            return { requested: "adaptive", effective: "lightweight" }
          },
        })

        const result = yield* service.searchText({ scope: scope(dir), query: "answer" })
        expect(resolutions).toBe(1)
        expect(result.analysisProfile).toMatchObject({ requested: "adaptive", effective: "lightweight" })
      }),
    ),
  )

  it.live("adapts injected HostKernel transport calls without enabling the default backend", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "src/a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const calls: RepoIntel.RepoIntelTransportCall[] = []
        const backend = RepoIntel.backendFromTransport({
          exchange: (call) =>
            Effect.sync(() => {
              calls.push(call)
              switch (call.operation) {
                case "build":
                  return { operation: "build", generationId: bridgeGeneration }
                case "query":
                  return {
                    operation: "query",
                    result:
                      call.request.operation === "text"
                        ? {
                            status: "PARTIAL",
                            generationId: call.generationId,
                            matches: [{ path: "src/a.txt", startLine: 1, endLine: 1 }],
                          }
                        : {
                            status: "UNAVAILABLE",
                            generationId: call.generationId,
                            matches: [],
                            unavailableReason: { operation: call.request.operation },
                          },
                  }
                case "build_overlay":
                  return {
                    operation: "build_overlay",
                    generationId: call.generationId,
                    overlayDigest: `blake3:${"b".repeat(64)}`,
                  }
                case "release_generation":
                case "release_overlay":
                  return { operation: "released" }
              }
            }),
        })
        const service = RepoIntel.make({ fs: base, backend })

        const text = yield* service.searchText({ scope: scope(dir), subpath: "src", query: "needle", maxResults: 7 })
        const symbols = yield* service.searchSymbols({
          scope: scope(dir),
          subpath: "src",
          query: "needle",
          maxResults: 7,
        })
        expect(text.matches).toEqual([{ path: "src/a.txt", startLine: 1, endLine: 1 }])
        expect(symbols.status).toBe("UNAVAILABLE")
        expect(symbols.sourceKind).toBe("none")
        expect(symbols.coverage).toBe("none")
        expect(symbols.fallback).toBe("structural_parser_unavailable")
        expect(symbols.unavailableReason).toEqual({ operation: "symbol" })
        expect(calls.map((call) => call.operation)).toEqual(["build", "query", "query"])
        const build = calls[0]!
        expect(build.operation).toBe("build")
        if (build.operation !== "build") throw new Error("expected build transport call")
        expect(build.pins.readScope).toMatch(/^v1:/)
        expect(build.pins.readPolicy).toMatch(/^v1:/)
        expect(build.snapshots.map((item) => item.path)).toEqual(["src/a.txt"])
        const query = calls[1]!
        expect(query.operation).toBe("query")
        if (query.operation !== "query") throw new Error("expected query transport call")
        expect(query.request).toMatchObject({ operation: "text", query: "needle", maxResults: 7 })

        expect(RepoIntel.unavailableBackend).toBeDefined()
        const unavailable = yield* Effect.exit(RepoIntel.unavailableBackend.build(build.pins, build.snapshots))
        expect(Exit.isFailure(unavailable)).toBe(true)
        if (Exit.isFailure(unavailable)) {
          expect(Cause.squash(unavailable.cause)).toMatchObject({ code: "unavailable" })
        }
      }),
    ),
  )

  it.live("sends RepoRead metadata out of body and decodes a bounded schema page", () =>
    Effect.gen(function* () {
      const calls: RepoIntel.RepoStructureRequestV1[] = []
      const client = RepoIntel.repoStructureClientFromTransport({
        query: (call) =>
          Effect.sync(() => {
            calls.push(call)
            return unavailableStructurePage
          }),
      })

      const page = yield* client.query(structureRequest)

      expect(page).toEqual(unavailableStructurePage)
      expect(calls).toHaveLength(1)
      expect(calls[0].sessionID).toBe(structureRequest.sessionID)
      expect(calls[0].locationRef).toBe(structureRequest.locationRef)
      expect(calls[0].query).toEqual(structureQuery)
      expect(calls[0].query).not.toHaveProperty("sourceGeneration")
    }),
  )

  it.live("routes optional overlay references only through Core and preserves typed host denial", () =>
    Effect.gen(function* () {
      const overlayRef = Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoOverlayRefV1)("ovl_0123456789abcdef")
      const query = { ...structureQuery, overlayRef }
      const request = { ...structureRequest, query }
      const seen: unknown[] = []
      const page = { ...unavailableStructurePage, overlayDigest: structureRevision }
      const client = RepoIntel.repoStructureClientFromSupervisor({
        queryRepoStructure: (input: RepoIntel.RepoStructureRequestV1) =>
          Effect.sync(() => {
            seen.push(input)
            return page
          }),
      } as never)
      const result = yield* client
        .query(request)
        .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "overlay-test" } }))
      expect(result.overlayDigest).toBe(structureRevision)
      expect(seen).toEqual([request])

      const denied = RepoIntel.repoStructureClientFromSupervisor({
        queryRepoStructure: () =>
          Effect.fail({
            _tag: "SessionSupervisorError",
            hostCode: "capability_unavailable",
            message: "overlay snapshot producer unavailable",
          } as never),
      } as never)
      const deniedExit = yield* Effect.exit(
        denied
          .query(request)
          .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "overlay-test" } })),
      )
      expect(Exit.isFailure(deniedExit)).toBe(true)
      if (Exit.isFailure(deniedExit)) expect(Cause.squash(deniedExit.cause)).toMatchObject({ code: "unavailable" })
    }),
  )

  it.live("rejects stale correlations, generations, malformed pages, and over-limit page metadata", () =>
    Effect.gen(function* () {
      const failure = (response: unknown) =>
        RepoIntel.repoStructureClientFromTransport({ query: () => Effect.succeed(response) }).query(structureRequest)

      const wrongQuery = { ...unavailableStructurePage, queryId: "query-other" }
      const queryExit = yield* Effect.exit(failure(wrongQuery))
      expect(Exit.isFailure(queryExit)).toBe(true)
      if (Exit.isFailure(queryExit)) expect(Cause.squash(queryExit.cause)).toMatchObject({ code: "rejected" })

      const malformed = { ...unavailableStructurePage, sourceKind: "mystery" }
      const malformedExit = yield* Effect.exit(failure(malformed))
      expect(Exit.isFailure(malformedExit)).toBe(true)
      if (Exit.isFailure(malformedExit)) expect(Cause.squash(malformedExit.cause)).toMatchObject({ code: "rejected" })

      const excessProperty = { ...unavailableStructurePage, principal: { kind: "server_auth", subject: "forged" } }
      const excessExit = yield* Effect.exit(failure(excessProperty))
      expect(Exit.isFailure(excessExit)).toBe(true)
      if (Exit.isFailure(excessExit)) expect(Cause.squash(excessExit.cause)).toMatchObject({ code: "rejected" })

      const tooManyFiles = {
        ...unavailableStructurePage,
        coverage: { files: "4097", nodes: "0", bytes: "0" },
      }
      const tooManyFilesExit = yield* Effect.exit(failure(tooManyFiles))
      expect(Exit.isFailure(tooManyFilesExit)).toBe(true)
      if (Exit.isFailure(tooManyFilesExit)) expect(Cause.squash(tooManyFilesExit.cause)).toMatchObject({ code: "rejected" })

      const overLimit = {
        ...unavailableStructurePage,
        coverage: { files: "1", nodes: "0", bytes: String(structureQuery.maxBytes + 1) },
      }
      const boundsExit = yield* Effect.exit(failure(overLimit))
      expect(Exit.isFailure(boundsExit)).toBe(true)
      if (Exit.isFailure(boundsExit)) expect(Cause.squash(boundsExit.cause)).toMatchObject({ code: "rejected" })

      const malformedContext = yield* Effect.exit(
        RepoIntel.repoStructureClientFromTransport({ query: () => Effect.succeed(unavailableStructurePage) }).query(
          { ...structureRequest, sessionID: "session-from-body" },
        ),
      )
      expect(Exit.isFailure(malformedContext)).toBe(true)

      const serializedOverLimit = {
        ...unavailableStructurePage,
        queryId: structureQuery.queryId,
        status: "PARTIAL",
        freshness: "current",
        completeness: "partial",
        sourceKind: "parser",
        nodes: [
          {
            workspaceBinding: "workspace-binding-1",
            sourceGeneration: structureGeneration,
            sourceRevision: unavailableStructurePage.sourceRevision,
            pathRef: "src/main.rs",
            fileDigest: `blake3:${"4".repeat(64)}`,
            nodeId: "node-main",
            nodeKind: "function",
            symbol: "x".repeat(1_000),
            byteRange: { start: 1, end: 2 },
            parserId: "tree-sitter-rust",
            parserVersion: "1.0",
          },
        ],
        coverage: { files: "1", nodes: "1", bytes: "10" },
        fallback: undefined,
      }
      const smallRequest = { ...structureRequest, query: { ...structureQuery, maxBytes: 100 } }
      const serializedExit = yield* Effect.exit(
        RepoIntel.repoStructureClientFromTransport({ query: () => Effect.succeed(serializedOverLimit) }).query(
          smallRequest,
        ),
      )
      expect(Exit.isFailure(serializedExit)).toBe(true)
      if (Exit.isFailure(serializedExit)) expect(Cause.squash(serializedExit.cause)).toMatchObject({ code: "rejected" })
    }),
  )

  it.live("rejects nodes whose workspace or source generation differs from the page", () =>
    Effect.gen(function* () {
      const validNode = {
        workspaceBinding: unavailableStructurePage.workspaceBinding,
        sourceGeneration: structureGeneration,
        sourceRevision: structureRevision,
        pathRef: "src/example.ts",
        fileDigest: structureRevision,
        nodeId: "node-example",
        nodeKind: "text_occurrence" as const,
        symbol: "example",
        byteRange: { start: 0, end: 7 },
        parserId: "horizoncode.lexical",
        parserVersion: "1",
      }
      const validPage = {
        ...unavailableStructurePage,
        sourceKind: "lexical" as const,
        status: "PARTIAL" as const,
        freshness: "current" as const,
        completeness: "partial" as const,
        coverage: { files: "1", nodes: "1", bytes: "7" },
        nodes: [validNode],
        fallback: { reason: "parse_partial" as const, sourceKind: "lexical" as const },
      }
      const mismatchedPages = [
        { ...validPage, nodes: [{ ...validNode, workspaceBinding: "another-workspace" }] },
        { ...validPage, nodes: [{ ...validNode, sourceGeneration: structureRevision }] },
      ]

      for (const page of mismatchedPages) {
        const exit = yield* Effect.exit(
          RepoIntel.repoStructureClientFromTransport({ query: () => Effect.succeed(page) }).query(structureRequest),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "rejected" })
      }
    }),
  )

  it.live("requires exact overlay provenance and refuses a base-only downgrade", () =>
    Effect.gen(function* () {
      const overlayQuery = {
        ...structureQuery,
        overlayRef: Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoOverlayRefV1)("ovl_0123456789abcdef"),
      }
      const overlayRequest = { ...structureRequest, query: overlayQuery }
      const withoutDigest = yield* Effect.exit(
        RepoIntel.repoStructureClientFromTransport({ query: () => Effect.succeed(unavailableStructurePage) })
          .query(overlayRequest),
      )
      expect(Exit.isFailure(withoutDigest)).toBe(true)
      if (Exit.isFailure(withoutDigest)) expect(Cause.squash(withoutDigest.cause)).toMatchObject({ code: "rejected" })

      const digest = Schema.decodeUnknownSync(Digest)(`blake3:${"a".repeat(64)}`)
      const overlayPage = { ...unavailableStructurePage, overlayDigest: digest }
      const withDigest = yield* RepoIntel.repoStructureClientFromTransport({
        query: () => Effect.succeed(overlayPage),
      }).query(overlayRequest)
      expect(withDigest.overlayDigest).toBe(digest)

      const downgradedBaseResponse = yield* Effect.exit(
        RepoIntel.repoStructureClientFromTransport({
          query: () => Effect.succeed(overlayPage),
        }).query(structureRequest),
      )
      expect(Exit.isFailure(downgradedBaseResponse)).toBe(true)
      if (Exit.isFailure(downgradedBaseResponse)) {
        expect(Cause.squash(downgradedBaseResponse.cause)).toMatchObject({ code: "rejected" })
      }
    }),
  )

  it.live("accepts structural continuation only after a full current page", () =>
    Effect.gen(function* () {
      const continuationRequest = {
        ...structureRequest,
        query: { ...structureQuery, maxBytes: 16_384 },
      }
      const nodes = Array.from({ length: structureQuery.maxNodes }, (_, index) => ({
        workspaceBinding: unavailableStructurePage.workspaceBinding,
        sourceGeneration: structureGeneration,
        sourceRevision: structureRevision,
        pathRef: `src/${index}.ts`,
        fileDigest: structureRevision,
        nodeId: `node-${index}`,
        nodeKind: "text_occurrence",
        symbol: "entry",
        byteRange: { start: 0, end: 5 },
        parserId: "horizoncode.lexical",
        parserVersion: "1",
      }))
      const page = {
        ...unavailableStructurePage,
        sourceKind: "lexical" as const,
        status: "PARTIAL" as const,
        freshness: "current" as const,
        completeness: "partial" as const,
        coverage: { files: String(nodes.length), nodes: String(nodes.length), bytes: String(nodes.length * 5) },
        nodes,
        fallback: { reason: "parse_partial" as const, sourceKind: "lexical" as const },
        nextCursor: Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoStructureCursorLeaseRefV1)("repo_cur_0123456789abcdef"),
      }
      const accepted = yield* RepoIntel.repoStructureClientFromTransport({
        query: () => Effect.succeed(page),
      }).query(continuationRequest)
      expect(accepted.nextCursor).toBe(page.nextCursor)

      const shortPage = { ...page, nodes: nodes.slice(0, -1), coverage: { ...page.coverage, nodes: nodes.length - 1 } }
      const rejected = yield* Effect.exit(
        RepoIntel.repoStructureClientFromTransport({ query: () => Effect.succeed(shortPage) }).query(continuationRequest),
      )
      expect(Exit.isFailure(rejected)).toBe(true)
      if (Exit.isFailure(rejected)) expect(Cause.squash(rejected.cause)).toMatchObject({ code: "rejected" })
    }),
  )

  it.live("interrupts an in-flight structural query so its HostKernel transport can cancel it", () =>
    Effect.gen(function* () {
      let interrupted = false
      let markStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const client = RepoIntel.repoStructureClientFromTransport({
        query: () =>
          Effect.promise(
            (signal) =>
              new Promise((resolve) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    interrupted = true
                    resolve(unavailableStructurePage)
                  },
                  { once: true },
                )
                markStarted?.()
              }),
          ),
      })
      const fiber = yield* client.query(structureRequest).pipe(Effect.forkChild)
      yield* Effect.promise(() => started)
      yield* Fiber.interrupt(fiber)
      expect(interrupted).toBe(true)
    }),
  )

  it.live("rejects malformed transport responses and stale generation bindings", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const backend = RepoIntel.backendFromTransport({
          exchange: (call) =>
            Effect.succeed(
              call.operation === "build"
                ? { operation: "build", generationId: "not-a-blake3-digest" }
                : call.operation === "query"
                  ? {
                      operation: "query",
                      result: {
                        status: "PARTIAL",
                        generationId: `blake3:${"c".repeat(64)}`,
                        matches: [],
                      },
                    }
                  : { operation: "released" },
            ),
        })
        const buildExit = yield* Effect.exit(
          backend.build(
            {
              repository: "repo",
              revisionSet: "revision",
              readScope: "scope",
              readPolicy: "policy",
              sourceReceipt: "receipt",
              parserSet: "parser",
            },
            [{ path: "a.txt", contents: new TextEncoder().encode("needle\n") }],
          ),
        )
        expect(Exit.isFailure(buildExit)).toBe(true)
        if (Exit.isFailure(buildExit)) {
          expect(Cause.squash(buildExit.cause)).toMatchObject({ code: "rejected" })
        }

        const validBuildBackend = RepoIntel.backendFromTransport({
          exchange: (call) =>
            Effect.succeed(
              call.operation === "build"
                ? { operation: "build", generationId: bridgeGeneration }
                : call.operation === "query"
                  ? {
                      operation: "query",
                      result: {
                        status: "PARTIAL",
                        generationId: `blake3:${"c".repeat(64)}`,
                        matches: [],
                      },
                    }
                  : { operation: "released" },
            ),
        })
        const service = RepoIntel.make({ fs: base, backend: validBuildBackend })
        const failure = yield* expectFailure(service.searchText({ scope: scope(dir), query: "needle" }))
        expect(failure.code).toBe("stale_generation")
      }),
    ),
  )

  it.live("rejects malformed query field types and keeps release cleanup infallible", () =>
    Effect.gen(function* () {
      const malformedResponses: ReadonlyArray<unknown> = [
        {
          operation: "query",
          result: {
            status: "PARTIAL",
            generationId: bridgeGeneration,
            matches: [{ path: 42, startLine: 1, endLine: 1 }],
          },
        },
        {
          operation: "query",
          result: { status: "PARTIAL", generationId: bridgeGeneration, matches: [], workUnits: null },
        },
      ]
      for (const response of malformedResponses) {
        const backend = RepoIntel.backendFromTransport({ exchange: () => Effect.succeed(response) })
        const exit = yield* Effect.exit(
          backend.query(
            { generationId: bridgeGeneration, generationStatus: "PARTIAL" },
            { operation: "text", query: "needle", maxResults: 1 },
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ code: "rejected" })
        }
      }

      const backend = RepoIntel.backendFromTransport({
        exchange: () =>
          Effect.fail(new RepoIntel.RepoIntelBackendError({ code: "rejected", detail: "release failed" })),
      })
      const handle = { generationId: bridgeGeneration, generationStatus: "PARTIAL" as const }
      const release = yield* Effect.exit(backend.release!(handle))
      const releaseOverlay = yield* Effect.exit(backend.releaseOverlay!({ overlayDigest: bridgeGeneration }))
      expect(Exit.isSuccess(release)).toBe(true)
      expect(Exit.isSuccess(releaseOverlay)).toBe(true)
    }),
  )

  it.live("ignores invalid release handles without dispatching transport calls", () =>
    Effect.gen(function* () {
      const calls: RepoIntel.RepoIntelTransportCall[] = []
      const backend = RepoIntel.backendFromTransport({
        exchange: (call) =>
          Effect.sync(() => {
            calls.push(call)
            return { operation: "released" }
          }),
      })

      const release = yield* Effect.exit(backend.release!({ generationId: "invalid", generationStatus: "PARTIAL" }))
      const releaseOverlay = yield* Effect.exit(backend.releaseOverlay!({ overlayDigest: "invalid" }))

      expect(Exit.isSuccess(release)).toBe(true)
      expect(Exit.isSuccess(releaseOverlay)).toBe(true)
      expect(calls).toEqual([])
    }),
  )

  it.live("preserves every indexd wire error and rejects over-limit requests before transport", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const codes: ReadonlyArray<RepoIntel.RepoIntelBackendErrorCode> = [
          "unavailable",
          "rejected",
          "generation_mismatch",
          "cursor_generation_mismatch",
          "cursor_query_mismatch",
          "cursor_overlay_mismatch",
          "cursor_anchor_not_found",
          "cursor_work_limit",
          "invalid_search_cursor",
          "invalid_path",
          "duplicate_path",
          "invalid_utf8",
          "too_many_base_files",
          "file_too_large",
          "base_content_limit",
          "base_path_limit",
          "empty_query",
          "query_too_large",
          "multiline_query",
          "invalid_result_limit",
          "overlay_generation_mismatch",
        ]
        let code: RepoIntel.RepoIntelBackendErrorCode = "unavailable"
        let exchanges = 0
        const backend = RepoIntel.backendFromTransport({
          exchange: () =>
            Effect.sync(() => {
              exchanges++
              return { operation: "released" }
            }).pipe(
              Effect.flatMap(() => Effect.fail(new RepoIntel.RepoIntelBackendError({ code, detail: "wire error" }))),
            ),
        })
        for (const item of codes) {
          code = item
          const exit = yield* Effect.exit(
            backend.query(
              { generationId: bridgeGeneration, generationStatus: "PARTIAL" },
              { operation: "text", query: "needle", maxResults: 1 },
            ),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toMatchObject({ code: item, detail: "wire error" })
          }
        }
        expect(exchanges).toBe(codes.length)

        let invalidBuildCode: RepoIntel.RepoIntelBackendErrorCode | undefined
        const bounded = RepoIntel.backendFromTransport({
          exchange: () =>
            Effect.sync(() => {
              exchanges++
              return { operation: "released" }
            }),
        })
        const oversized = yield* Effect.exit(
          bounded.build(
            {
              repository: "repo",
              revisionSet: "revision",
              readScope: "scope",
              readPolicy: "policy",
              sourceReceipt: "receipt",
              parserSet: "parser",
            },
            [{ path: "large.txt", contents: new Uint8Array(RepoIntel.MAX_FILE_BYTES + 1) }],
          ),
        )
        expect(Exit.isFailure(oversized)).toBe(true)
        if (Exit.isFailure(oversized)) {
          const error = Cause.squash(oversized.cause)
          expect(error).toMatchObject({ code: "file_too_large" })
          invalidBuildCode = (error as RepoIntel.RepoIntelBackendError).code
        }
        expect(invalidBuildCode).toBe("file_too_large")
        expect(exchanges).toBe(codes.length)
      }),
    ),
  )

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
        expect(result.sourceKind).toBe("lexical")
        expect(result.coverage).toBe("complete")
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

  it.live("caps directory enumeration and reports omitted entries as partial", () =>
    Effect.gen(function* () {
      const root = path.resolve(import.meta.dirname, "../../../..")
      const base = yield* FSUtil.Service
      let requestedEntryLimit = 0
      const source: RepoIntel.RepoIntelSource = {
        openRoot: (directory) =>
          Effect.map(RepoIntel.nodeSource.openRoot(directory), (opened) => ({
            ...opened,
            readDirectoryEntriesBounded: (_rel, maxEntries) => {
              requestedEntryLimit = maxEntries
              return Effect.succeed({
                entries: [{ name: "AGENTS.md", type: "file" as const }],
                truncated: true,
              })
            },
          })),
      }
      const { backend } = makeBackend()
      const service = RepoIntel.make({ fs: base, source, backend })
      const result = yield* service.searchText({
        scope: scope(root),
        query: "not present in the bounded fixture listing",
        budget: { maxFiles: 1, maxDirectories: 1 },
      })

      expect(requestedEntryLimit).toBe(2)
      expect(result.freshness).toBe("partial")
      expect(result.truncation).toContain("entry_limit")
      expect(result.scanned.files).toBe(1)
    }),
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

  it.live("rejects backend matches outside the exact collected subpath generation", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "src/allowed.ts", "needle\n")
        yield* write(dir, "outside.ts", "needle\n")
        const base = yield* FSUtil.Service
        const { backend } = makeBackend()
        const untrusted: RepoIntelBackend = {
          ...backend,
          query: (handle) =>
            Effect.succeed({
              status: "PARTIAL",
              generationId: handle.generationId,
              matches: [{ path: "outside.ts", startLine: 1, endLine: 1 }],
            }),
        }
        const service = RepoIntel.make({ fs: base, backend: untrusted })

        const failure = yield* expectFailure(
          service.searchText({ scope: scope(dir), subpath: "src", query: "needle", maxResults: 10 }),
        )

        expect(failure.code).toBe("backend_rejected")
        expect(failure.detail).toContain("outside.ts")
      }),
    ),
  )

  it.live("rejects query results attributed to a different generation handle", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.ts", "needle\n")
        const base = yield* FSUtil.Service
        const { backend } = makeBackend()
        const untrusted: RepoIntelBackend = {
          ...backend,
          query: (handle) =>
            Effect.succeed({
              status: "PARTIAL",
              generationId: `blake3:${"f".repeat(64)}`,
              matches: [{ path: "a.ts", startLine: 1, endLine: 1 }],
            }),
        }
        const service = RepoIntel.make({ fs: base, backend: untrusted })

        const failure = yield* expectFailure(service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 }))

        expect(failure.code).toBe("backend_rejected")
        expect(failure.detail).toContain("different generation")
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

  it.live("detects same-size, same-mtime source changes during the query", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "a.txt")
        const fixedTime = new Date("2020-01-02T03:04:05.000Z")
        yield* write(dir, "a.txt", "needle\n")
        yield* Effect.promise(() => fs.utimes(file, fixedTime, fixedTime))
        const base = yield* FSUtil.Service
        const { backend } = makeBackend({
          onQuery: () =>
            write(dir, "a.txt", "absent\n").pipe(
              Effect.tap(() => Effect.promise(() => fs.utimes(file, fixedTime, fixedTime))),
            ),
        })
        const service = RepoIntel.make({ fs: base, backend })

        const result = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })

        expect(result.freshness).toBe("stale")
        expect(result.staleReason).toBe("source_changed")
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

  it.live("rebuilds when file contents change without size or mtime changes", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "a.txt")
        yield* write(dir, "a.txt", "needle\n")
        const fixedTime = new Date("2020-01-02T03:04:05.000Z")
        yield* Effect.promise(() => fs.utimes(file, fixedTime, fixedTime))
        const base = yield* FSUtil.Service
        const { backend } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const first = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(first.matches).toEqual([{ path: "a.txt", startLine: 1, endLine: 1 }])

        yield* write(dir, "a.txt", "absent\n")
        yield* Effect.promise(() => fs.utimes(file, fixedTime, fixedTime))
        const second = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })

        expect(second.generationId).not.toBe(first.generationId)
        expect(second.matches).toEqual([])
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

  it.live("retires a lost indexd generation and rebuilds after a service restart", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend: delegate, state } = makeBackend()
        const availableGenerations = new Set<string>()
        const backend: RepoIntelBackend = {
          ...delegate,
          build: (pins, snapshots) =>
            Effect.tap(delegate.build(pins, snapshots), (handle) =>
              Effect.sync(() => {
                availableGenerations.add(handle.generationId)
              }),
            ),
          query: (handle, request) =>
            availableGenerations.has(handle.generationId)
              ? delegate.query(handle, request)
              : Effect.fail(
                  new RepoIntel.RepoIntelBackendError({
                    code: "generation_mismatch",
                    detail: "the restarted indexd process no longer owns this handle",
                  }),
                ),
        }
        const service = RepoIntel.make({ fs: base, backend })

        const first = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        availableGenerations.clear()
        const lost = yield* expectFailure(service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 }))

        expect(lost.code).toBe("stale_generation")
        expect((yield* service.stats()).entries).toBe(0)
        expect(state.released).toBe(1)

        const recovered = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(recovered.freshness).toBe("fresh")
        expect(recovered.generationId).toBe(first.generationId)
        expect(state.builds).toBe(2)
      }),
    ),
  )

  it.live("retires a lost generation when overlay construction detects an indexd restart", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend: delegate, state } = makeBackend()
        const availableGenerations = new Set<string>()
        const backend: RepoIntelBackend = {
          ...delegate,
          build: (pins, snapshots) =>
            Effect.tap(delegate.build(pins, snapshots), (handle) =>
              Effect.sync(() => {
                availableGenerations.add(handle.generationId)
              }),
            ),
          buildOverlay: (handle, overlay) =>
            availableGenerations.has(handle.generationId)
              ? delegate.buildOverlay!(handle, overlay)
              : Effect.fail(
                  new RepoIntel.RepoIntelBackendError({
                    code: "generation_mismatch",
                    detail: "the restarted indexd process no longer owns this handle",
                  }),
                ),
        }
        const service = RepoIntel.make({ fs: base, backend })
        const input = {
          scope: scope(dir),
          query: "needle",
          maxResults: 10,
          overlay: { editorVersion: "buffer-1", changes: [{ path: "a.txt", contents: "needle updated\n" }] },
        }

        const first = yield* service.searchText(input)
        availableGenerations.clear()
        const lost = yield* expectFailure(service.searchText(input))

        expect(first.overlay?.digest).toBeDefined()
        expect(lost.code).toBe("stale_generation")
        expect((yield* service.stats()).entries).toBe(0)
        expect(state.released).toBe(1)

        const recovered = yield* service.searchText(input)
        expect(recovered.freshness).toBe("fresh")
        expect(recovered.generationId).toBe(first.generationId)
        expect(state.builds).toBe(2)
      }),
    ),
  )

  it.live("coalesces concurrent compatible generation builds across operations", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const buildStarted = yield* Deferred.make<void>()
        const releaseBuild = yield* Deferred.make<void>()
        const bothCollected = yield* Deferred.make<void>()
        let directoryScans = 0
        const source: RepoIntel.RepoIntelSource = {
          openRoot: (root) =>
            Effect.map(RepoIntel.nodeSource.openRoot(root), (opened) => ({
              ...opened,
              readDirectoryEntriesBounded: (rel, maxEntries) =>
                Effect.tap(opened.readDirectoryEntriesBounded!(rel, maxEntries), () =>
                  Effect.sync(() => {
                    directoryScans++
                    if (directoryScans >= 2) Deferred.doneUnsafe(bothCollected, Effect.void)
                  }),
                ),
            })),
        }
        const { backend, state } = makeBackend({
          onBuild: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(buildStarted, undefined)
              yield* Deferred.await(releaseBuild)
            }),
        })
        const service = RepoIntel.make({ fs: base, source, backend })

        const first = yield* service
          .searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
          .pipe(Effect.forkChild)
        yield* Deferred.await(buildStarted)
        const second = yield* service
          .searchSymbols({ scope: scope(dir), query: "needle", maxResults: 10 })
          .pipe(Effect.forkChild)
        yield* Deferred.await(bothCollected)
        yield* pollWithTimeout(
          Effect.map(service.stats(), (stats) =>
            stats.inFlightBuilds === 1 && stats.buildWaiters === 2 ? stats : undefined,
          ),
          "both RepoIntel operations did not join the same generation build",
        )
        yield* Deferred.succeed(releaseBuild, undefined)

        const [text, symbols] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
        expect(state.builds).toBe(1)
        expect(state.queries).toBe(2)
        expect(text.generationId).toBe(symbols.generationId)
      }),
    ),
  )

  it.live("does not join a prior-epoch build after scope invalidation", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const firstBuildStarted = yield* Deferred.make<void>()
        const secondBuildStarted = yield* Deferred.make<void>()
        const releaseFirstBuild = yield* Deferred.make<void>()
        const releaseSecondBuild = yield* Deferred.make<void>()
        let buildAttempts = 0
        const { backend, state } = makeBackend({
          onBuild: () =>
            Effect.gen(function* () {
              buildAttempts++
              if (buildAttempts === 1) {
                yield* Deferred.succeed(firstBuildStarted, undefined)
                yield* Deferred.await(releaseFirstBuild)
                return
              }
              yield* Deferred.succeed(secondBuildStarted, undefined)
              yield* Deferred.await(releaseSecondBuild)
            }),
        })
        const service = RepoIntel.make({ fs: base, backend })

        const stale = yield* service
          .searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstBuildStarted)
        expect(yield* service.invalidate("ws-1")).toBe(0)

        const current = yield* service
          .searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.sync(() => (buildAttempts >= 2 ? true : undefined)),
          "fresh RepoIntel request joined the prior-epoch build instead of starting its own",
        )
        expect(yield* service.stats()).toEqual({ entries: 0, bytes: 0, inFlightBuilds: 2, buildWaiters: 2 })

        yield* Deferred.succeed(releaseSecondBuild, undefined)
        const result = yield* Fiber.join(current)
        expect(result.freshness).toBe("fresh")
        expect(result.matches).toEqual([{ path: "a.txt", startLine: 1, endLine: 1 }])

        yield* Deferred.succeed(releaseFirstBuild, undefined)
        const failure = yield* expectFailure(Fiber.join(stale))
        expect(failure.code).toBe("stale_generation")
        expect(failure.detail).toContain("invalidated during the generation build")
        expect(state.builds).toBe(2)
        expect(state.queries).toBe(1)
        expect(state.released).toBe(1)
        expect(yield* service.stats()).toEqual({ entries: 1, bytes: 7, inFlightBuilds: 0, buildWaiters: 0 })
      }),
    ),
  )

  it.live("cancelling one waiter preserves a shared build needed by another", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const buildStarted = yield* Deferred.make<void>()
        const releaseBuild = yield* Deferred.make<void>()
        const bothCollected = yield* Deferred.make<void>()
        const controller = new AbortController()
        let directoryScans = 0
        const source: RepoIntel.RepoIntelSource = {
          openRoot: (root) =>
            Effect.map(RepoIntel.nodeSource.openRoot(root), (opened) => ({
              ...opened,
              readDirectoryEntriesBounded: (rel, maxEntries) =>
                Effect.tap(opened.readDirectoryEntriesBounded!(rel, maxEntries), () =>
                  Effect.sync(() => {
                    directoryScans++
                    if (directoryScans >= 2) Deferred.doneUnsafe(bothCollected, Effect.void)
                  }),
                ),
            })),
        }
        const { backend, state } = makeBackend({
          onBuild: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(buildStarted, undefined)
              yield* Deferred.await(releaseBuild)
            }),
        })
        const service = RepoIntel.make({ fs: base, source, backend })

        const first = yield* service
          .searchText({ scope: scope(dir), query: "needle", maxResults: 10, signal: controller.signal })
          .pipe(Effect.forkChild)
        yield* Deferred.await(buildStarted)
        const second = yield* service
          .searchSymbols({ scope: scope(dir), query: "needle", maxResults: 10 })
          .pipe(Effect.forkChild)
        yield* Deferred.await(bothCollected)
        yield* pollWithTimeout(
          Effect.map(service.stats(), (stats) =>
            stats.inFlightBuilds === 1 && stats.buildWaiters === 2 ? stats : undefined,
          ),
          "both RepoIntel operations did not join the same generation build",
        )

        controller.abort()
        const failure = yield* expectFailure(Fiber.join(first))
        expect(failure.code).toBe("cancelled")
        expect(yield* service.stats()).toMatchObject({ buildWaiters: 1 })
        yield* Deferred.succeed(releaseBuild, undefined)

        const result = yield* Fiber.join(second)
        expect(result.status).toBe("UNAVAILABLE")
        expect(state.builds).toBe(1)
        expect(state.queries).toBe(1)
      }),
    ),
  )

  it.live("cancelling the last build waiter interrupts transport and permits a retry", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const buildStarted = yield* Deferred.make<void>()
        const releaseBuild = yield* Deferred.make<void>()
        const controller = new AbortController()
        let holdBuild = true
        let interruptedBuilds = 0
        const { backend, state } = makeBackend({
          onBuild: () => {
            if (!holdBuild) return Effect.void
            return Deferred.succeed(buildStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBuild)),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interruptedBuilds++
                }),
              ),
            )
          },
        })
        const service = RepoIntel.make({ fs: base, backend })

        const fiber = yield* service
          .searchText({ scope: scope(dir), query: "needle", maxResults: 10, signal: controller.signal })
          .pipe(Effect.forkChild)
        yield* Deferred.await(buildStarted)
        controller.abort()
        const failure = yield* expectFailure(Fiber.join(fiber))
        expect(failure.code).toBe("cancelled")
        expect(interruptedBuilds).toBe(1)

        holdBuild = false
        const result = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(result.matches).toEqual([{ path: "a.txt", startLine: 1, endLine: 1 }])
        expect(state.builds).toBe(1)
      }),
    ),
  )

  it.live("does not reuse a generation across repository, workspace, or read-policy identity changes", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })
        const firstScope = {
          ...scope(dir),
          repositoryId: "repo-1",
          workspaceId: "workspace-1",
          policyDigest: "policy-1",
        }

        const first = yield* service.searchText({ scope: firstScope, query: "needle", maxResults: 10 })
        const changedPolicy = yield* service.searchText({
          scope: { ...firstScope, policyDigest: "policy-2" },
          query: "needle",
          maxResults: 10,
        })
        const changedRepository = yield* service.searchText({
          scope: { ...firstScope, repositoryId: "repo-2" },
          query: "needle",
          maxResults: 10,
        })
        const changedWorkspace = yield* service.searchText({
          scope: { ...firstScope, workspaceId: "workspace-2" },
          query: "needle",
          maxResults: 10,
        })

        expect(
          new Set([
            first.generationId,
            changedPolicy.generationId,
            changedRepository.generationId,
            changedWorkspace.generationId,
          ]).size,
        ).toBe(4)
        expect(state.builds).toBe(4)
      }),
    ),
  )

  it.live("resolves profiles conservatively without splitting the immutable base cache", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        let profileState: unknown
        let profileThrows = false
        const service = RepoIntel.make({
          fs: base,
          backend,
          resolveProfile: () => {
            if (profileThrows) throw new Error("configuration is unavailable")
            return profileState
          },
        })

        profileState = undefined
        const missing = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(missing.analysisProfile).toMatchObject({ requested: "lightweight", effective: "lightweight" })

        profileState = { requested: "unrecognized", effective: "full" }
        const invalid = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(invalid.analysisProfile).toMatchObject({ requested: "lightweight", effective: "lightweight" })

        profileState = { requested: "full", effective: "invalid" }
        const invalidEffective = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(invalidEffective.analysisProfile).toMatchObject({ requested: "full", effective: "lightweight" })

        profileThrows = true
        const failedResolution = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        profileThrows = false
        expect(failedResolution.analysisProfile).toMatchObject({ requested: "lightweight", effective: "lightweight" })

        profileState = { requested: "full", effective: "adaptive" }
        const adaptive = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(adaptive.analysisProfile).toMatchObject({ requested: "full", effective: "adaptive" })

        profileState = { requested: "lightweight", effective: "full" }
        const clamped = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(clamped.analysisProfile).toMatchObject({ requested: "lightweight", effective: "lightweight" })
        profileState = {
          requested: "full",
          effective: "lightweight",
          effectiveSource: "resource",
          reason: "resource_pressure",
        }
        const unauthenticatedPressure = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(unauthenticatedPressure.analysisProfile).toMatchObject({
          requested: "full",
          effective: "full",
          effectiveSource: "unknown",
        })
        expect(invalid.generationId).toBe(missing.generationId)
        expect(invalidEffective.generationId).toBe(missing.generationId)
        expect(failedResolution.generationId).toBe(missing.generationId)
        expect(adaptive.generationId).toBe(invalid.generationId)
        expect(clamped.generationId).toBe(invalid.generationId)
        expect(state.builds).toBe(1)
        expect(state.queries).toBe(7)
      }),
    ),
  )

  it.live("keeps cached generations within the configured byte budget", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "a.txt")
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend, maxCacheBytes: 12 })

        yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        yield* write(dir, "a.txt", "changed\n")
        yield* service.searchText({ scope: scope(dir), query: "changed", maxResults: 10 })

        expect(yield* service.stats()).toEqual({ entries: 1, bytes: 8, inFlightBuilds: 0, buildWaiters: 0 })
        expect(state.released).toBe(1)
      }),
    ),
  )

  it.live("expires idle generations, reports owner pins, and never claims reclaimed RAM", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        let now = 1_000
        const events: RepoIntel.RepoIntelCacheOwnerObservationV1[] = []
        const service = RepoIntel.make({
          fs: base,
          backend,
          ttlMs: 50,
          now: () => now,
          onCacheOwnerEvent: (event) => events.push(event),
        })

        const first = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(events.some((event) => event.event === "pin" && event.pinCount > 0 && event.protection === "pinned")).toBe(true)
        expect(events.every((event) => event.reclaimedBytes === null)).toBe(true)
        expect(events.some((event) => event.sourceGeneration === first.generationId && event.ownerScopeDigest.length > 0)).toBe(true)
        now += 51
        const second = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })

        expect(state.builds).toBe(2)
        expect(events.some((event) => event.event === "evict")).toBe(true)
        expect(events.some((event) => event.event === "release")).toBe(true)
        expect(events.every((event) => event.ttlMs === 50)).toBe(true)
        expect(yield* service.evictGeneration("ws-1", second.generationId)).toEqual({
          status: "evicted",
          reclaimedBytes: null,
        })
        expect((yield* service.stats()).entries).toBe(0)
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
        const service = RepoIntel.make({ fs: spy.fs, source: spy.source, backend })

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
        const service = RepoIntel.make({ fs: spy.fs, source: spy.source, backend })

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
        const service = RepoIntel.make({ fs: spy.fs, source: spy.source, backend })

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
        const outside = yield* tmpdirScoped()
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

  it.live("does not re-read a file swapped to an out-of-scope symlink during the query", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const outside = yield* tmpdirScoped()
        const file = path.join(dir, "a.txt")
        const outsideFile = path.join(outside, "secret.txt")
        yield* write(dir, "a.txt", "needle\n")
        yield* write(outside, "secret.txt", "needle\n")
        const fixedTime = new Date("2020-01-02T03:04:05.000Z")
        yield* Effect.promise(() =>
          Promise.all([
            fs.utimes(file, fixedTime, fixedTime),
            fs.utimes(outsideFile, fixedTime, fixedTime),
            fs.utimes(dir, fixedTime, fixedTime),
          ]),
        )
        const base = yield* FSUtil.Service
        const spy = spyFs(base)
        const { backend } = makeBackend({
          onQuery: () =>
            Effect.promise(async () => {
              await fs.rm(file)
              await fs.symlink(outsideFile, file)
              await fs.utimes(dir, fixedTime, fixedTime)
            }),
        })
        const service = RepoIntel.make({ fs: spy.fs, source: spy.source, backend })

        const result = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })

        expect(result.freshness).toBe("stale")
        expect(result.matches).toEqual([{ path: "a.txt", startLine: 1, endLine: 1 }])
        expect(spy.counters.reads).toBe(1)
      }),
    ),
  )

  it.live("does not read an out-of-scope file swapped in after path validation", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        if (process.platform !== "linux") return
        const file = path.join(dir, "a.txt")
        const outside = yield* tmpdirScoped()
        const outsideFile = path.join(outside, "secret.txt")
        yield* write(dir, "a.txt", "safe\n")
        yield* write(outside, "secret.txt", "secret-needle\n")
        const base = yield* FSUtil.Service
        let swapped = false
        const spy = spyFs(base, {
          afterResolve: (target) => {
            if (target !== file || swapped) return Effect.void
            swapped = true
            return Effect.promise(async () => {
              await fs.rm(file)
              await fs.symlink(outsideFile, file)
            })
          },
        })
        const { backend, buildInputs } = makeBackend()
        const service = RepoIntel.make({ fs: spy.fs, source: spy.source, backend })

        const result = yield* service.searchText({ scope: scope(dir), query: "secret-needle", maxResults: 10 })

        expect(result.matches).toEqual([])
        expect(buildInputs[0]!.paths).toEqual([])
      }),
    ),
  )

  it.live("applies an exact-generation overlay to one query and releases it after use", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "src/a.txt", "base\n")
        const base = yield* FSUtil.Service
        const { backend, state, overlayInputs } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const withoutOverlay = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(withoutOverlay.matches).toEqual([])
        expect(withoutOverlay.overlay).toBeUndefined()

        const result = yield* service.searchText({
          scope: scope(dir),
          query: "needle",
          maxResults: 10,
          overlay: { editorVersion: "buffer-7", changes: [{ path: "src/a.txt", contents: "needle in overlay\n" }] },
        })

        expect(result.matches).toEqual([{ path: "src/a.txt", startLine: 1, endLine: 1 }])
        expect(result.overlay?.editorVersion).toBe("buffer-7")
        expect(overlayInputs).toHaveLength(1)
        expect(overlayInputs[0]!.editorVersion).toBe("buffer-7")
        expect(overlayInputs[0]!.generationId).toBe(result.generationId)
        expect(result.overlay?.digest).toBe(overlayInputs[0]!.digest)
        expect(Buffer.from(overlayInputs[0]!.changes[0]!.contents!).toString("utf-8")).toBe("needle in overlay\n")
        expect(state.overlays).toBe(1)
        expect(state.releasedOverlays).toBe(1)
        expect(state.builds).toBe(1)

        const again = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(again.matches).toEqual([])
        expect(again.overlay).toBeUndefined()
        expect(state.builds).toBe(1)
      }),
    ),
  )

  it.live("rejects query results attributed to a different overlay digest", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "base\n")
        const base = yield* FSUtil.Service
        const { backend: delegate } = makeBackend()
        const untrusted: RepoIntelBackend = {
          ...delegate,
          query: (handle, request) =>
            Effect.map(delegate.query(handle, request), (result) => ({
              ...result,
              overlayDigest: `blake3:${"f".repeat(64)}`,
            })),
        }
        const service = RepoIntel.make({ fs: base, backend: untrusted })

        const failure = yield* expectFailure(
          service.searchText({
            scope: scope(dir),
            query: "needle",
            maxResults: 10,
            overlay: { editorVersion: "buffer-1", changes: [{ path: "a.txt", contents: "needle\n" }] },
          }),
        )

        expect(failure.code).toBe("backend_rejected")
        expect(failure.detail).toContain("different overlay")
      }),
    ),
  )

  it.live("relays a null overlay change as a clear back to base bytes", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle base\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const hidden = yield* service.searchText({
          scope: scope(dir),
          query: "needle",
          maxResults: 10,
          overlay: { editorVersion: "v1", changes: [{ path: "a.txt", contents: "hidden\n" }] },
        })
        expect(hidden.matches).toEqual([])

        const restored = yield* service.searchText({
          scope: scope(dir),
          query: "needle",
          maxResults: 10,
          overlay: { editorVersion: "v2", changes: [{ path: "a.txt", contents: null }] },
        })
        expect(restored.matches).toEqual([{ path: "a.txt", startLine: 1, endLine: 1 }])

        expect(state.overlays).toBe(2)
        expect(state.releasedOverlays).toBe(2)
        expect(state.builds).toBe(1)
      }),
    ),
  )

  it.live("rejects invalid overlay inputs before the backend sees them", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "base\n")
        for (let index = 1; index <= 8; index++) yield* write(dir, `bulk-${index}.txt`, "base\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const cases: Array<{ overlay: RepoIntel.RepoIntelOverlayInput; detail: string }> = [
          { overlay: { editorVersion: "", changes: [{ path: "a.txt", contents: "x" }] }, detail: "editor version" },
          { overlay: { editorVersion: "v", changes: [] }, detail: "at least one change" },
          {
            overlay: {
              editorVersion: "v",
              changes: Array.from({ length: RepoIntel.MAX_OVERLAY_CHANGES + 1 }, (_, index) => ({
                path: "a.txt",
                contents: `x${index}`,
              })),
            },
            detail: "overlay exceeds",
          },
          {
            overlay: { editorVersion: "v", changes: [{ path: "missing.txt", contents: "x" }] },
            detail: "not in the collected generation",
          },
          {
            overlay: {
              editorVersion: "v",
              changes: [
                { path: "a.txt", contents: "x" },
                { path: "a.txt", contents: "y" },
              ],
            },
            detail: "duplicate overlay change path",
          },
          {
            overlay: { editorVersion: "v", changes: [{ path: "a.txt", contents: new Uint8Array([0xff, 0xfe]) }] },
            detail: "not UTF-8 text",
          },
          {
            overlay: {
              editorVersion: "v",
              changes: [{ path: "a.txt", contents: new Uint8Array(RepoIntel.MAX_FILE_BYTES + 1).fill(0x61) }],
            },
            detail: "exceeds",
          },
          {
            overlay: {
              editorVersion: "v",
              changes: [
                "a.txt",
                "bulk-1.txt",
                "bulk-2.txt",
                "bulk-3.txt",
                "bulk-4.txt",
                "bulk-5.txt",
                "bulk-6.txt",
                "bulk-7.txt",
                "bulk-8.txt",
              ].map((filePath) => ({ path: filePath, contents: new Uint8Array(RepoIntel.MAX_FILE_BYTES).fill(0x61) })),
            },
            detail: "replacement bytes",
          },
        ]

        for (const testCase of cases) {
          const failure = yield* expectFailure(
            service.searchText({ scope: scope(dir), query: "base", maxResults: 10, overlay: testCase.overlay }),
          )
          expect(failure.code).toBe("invalid_overlay")
          expect(failure.detail).toContain(testCase.detail)
        }
        expect(state.overlays).toBe(0)
        expect(state.queries).toBe(0)
      }),
    ),
  )

  it.live("fails closed when the backend cannot build exact-generation overlays", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "base\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend({ withoutOverlay: true })
        const service = RepoIntel.make({ fs: base, backend })

        const failure = yield* expectFailure(
          service.searchText({
            scope: scope(dir),
            query: "base",
            maxResults: 10,
            overlay: { editorVersion: "v1", changes: [{ path: "a.txt", contents: "x" }] },
          }),
        )
        expect(failure.code).toBe("backend_unavailable")
        expect(state.overlays).toBe(0)
        expect(state.queries).toBe(0)
      }),
    ),
  )

  it.live("maps an overlay generation mismatch to a stale generation", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "base\n")
        const base = yield* FSUtil.Service
        const { backend } = makeBackend({ overlayFailure: "overlay_generation_mismatch" })
        const service = RepoIntel.make({ fs: base, backend })

        const failure = yield* expectFailure(
          service.searchText({
            scope: scope(dir),
            query: "base",
            maxResults: 10,
            overlay: { editorVersion: "v1", changes: [{ path: "a.txt", contents: "x" }] },
          }),
        )
        expect(failure.code).toBe("stale_generation")
      }),
    ),
  )

  it.live("binds overlay cursors to the exact overlay digest", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "plain\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })
        const overlay = (editorVersion: string): RepoIntel.RepoIntelOverlayInput => ({
          editorVersion,
          changes: [{ path: "a.txt", contents: Buffer.from("needle\nneedle\n", "utf-8") }],
        })

        const first = yield* service.searchText({
          scope: scope(dir),
          query: "needle",
          maxResults: 1,
          overlay: overlay("v1"),
        })
        expect(first.matches).toEqual([{ path: "a.txt", startLine: 1, endLine: 1 }])
        expect(first.nextCursor).toBeDefined()

        const second = yield* service.searchText({
          scope: scope(dir),
          query: "needle",
          maxResults: 1,
          cursor: first.nextCursor!,
          overlay: overlay("v1"),
        })
        expect(second.matches).toEqual([{ path: "a.txt", startLine: 2, endLine: 2 }])

        const changed = yield* expectFailure(
          service.searchText({
            scope: scope(dir),
            query: "needle",
            maxResults: 1,
            cursor: first.nextCursor!,
            overlay: overlay("v2"),
          }),
        )
        expect(changed.code).toBe("stale_generation")

        const dropped = yield* expectFailure(
          service.searchText({ scope: scope(dir), query: "needle", maxResults: 1, cursor: first.nextCursor! }),
        )
        expect(dropped.code).toBe("stale_generation")

        expect(state.overlays).toBe(3)
        expect(state.releasedOverlays).toBe(3)
        expect(state.builds).toBe(1)
      }),
    ),
  )

  it.live("relays symbol and reference queries with a truthful typed unavailable status", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "src/a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, state } = makeBackend()
        const service = RepoIntel.make({ fs: base, backend })

        const symbols = yield* service.searchSymbols({
          scope: scope(dir),
          subpath: "src",
          query: "needle",
          maxResults: 10,
        })
        expect(symbols.operation).toBe("symbol")
        expect(symbols.status).toBe("UNAVAILABLE")
        expect(symbols.freshness).toBe("partial")
        expect(symbols.matches).toEqual([])
        expect(symbols.unavailableReason).toEqual({ operation: "symbol" })
        expect(symbols.truncation).toContain("unavailable")

        const references = yield* service.findReferences({
          scope: scope(dir),
          subpath: "src",
          query: "needle",
          maxResults: 10,
        })
        expect(references.operation).toBe("references")
        expect(references.status).toBe("UNAVAILABLE")
        expect(references.sourceKind).toBe("none")
        expect(references.coverage).toBe("none")
        expect(references.fallback).toBe("structural_parser_unavailable")
        expect(references.matches).toEqual([])
        expect(references.unavailableReason).toEqual({ operation: "references" })

        expect(state.builds).toBe(1)
        expect(state.queries).toBe(2)
      }),
    ),
  )

  it.live("relays partial symbol results without fabricating matches", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "src/a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const { backend, queries } = makeBackend({
          operationResponses: {
            symbol: { status: "PARTIAL", matches: [{ path: "src/a.txt", startLine: 1, endLine: 1 }] },
          },
        })
        const service = RepoIntel.make({ fs: base, backend })

        const result = yield* service.searchSymbols({
          scope: scope(dir),
          subpath: "src",
          query: "needle",
          maxResults: 10,
        })

        expect(result.operation).toBe("symbol")
        expect(result.status).toBe("PARTIAL")
        expect(result.sourceKind).toBe("unknown")
        expect(result.coverage).toBe("partial")
        expect(result.matches).toEqual([{ path: "src/a.txt", startLine: 1, endLine: 1 }])
        expect(result.truncation).not.toContain("unavailable")
        expect(queries[0]!.operation).toBe("symbol")
      }),
    ),
  )

  it.live("defers handle release and fails the in-flight query when the scope is invalidated", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        let held = false
        const { backend, state } = makeBackend({
          onQuery: () =>
            held
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(gate)
                })
              : Effect.void,
        })
        const service = RepoIntel.make({ fs: base, backend })

        const first = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(first.freshness).toBe("fresh")
        expect(state.builds).toBe(1)

        held = true
        const fiber = yield* service
          .searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        const removed = yield* service.invalidate("ws-1")
        expect(removed).toBe(1)
        // A generation handle is never released under a live query.
        expect(state.released).toBe(0)
        expect(yield* service.stats()).toEqual({ entries: 0, bytes: 0, inFlightBuilds: 0, buildWaiters: 0 })

        yield* Deferred.succeed(gate, undefined)
        const failure = yield* expectFailure(Fiber.join(fiber))
        expect(failure.code).toBe("stale_generation")
        expect(state.released).toBe(1)

        const rebuilt = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(rebuilt.freshness).toBe("fresh")
        expect(state.builds).toBe(2)
      }),
    ),
  )

  it.live("does not cache a generation built across an invalidated epoch", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(dir, "a.txt", "needle\n")
        const base = yield* FSUtil.Service
        let invalidateScope: (() => Effect.Effect<number>) | undefined
        const { backend, state } = makeBackend({
          onBuild: () => (invalidateScope === undefined ? Effect.void : invalidateScope().pipe(Effect.asVoid)),
        })
        const service = RepoIntel.make({ fs: base, backend })
        invalidateScope = () => service.invalidate("ws-1")

        const failure = yield* expectFailure(service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 }))
        expect(failure.code).toBe("stale_generation")
        expect(failure.detail).toContain("invalidated during the generation build")
        expect(yield* service.stats()).toEqual({ entries: 0, bytes: 0, inFlightBuilds: 0, buildWaiters: 0 })
        expect(state.released).toBe(1)

        invalidateScope = undefined
        const rebuilt = yield* service.searchText({ scope: scope(dir), query: "needle", maxResults: 10 })
        expect(rebuilt.freshness).toBe("fresh")
        expect(state.builds).toBe(2)
        expect((yield* service.stats()).entries).toBe(1)
        expect(state.queries).toBe(1)
      }),
    ),
  )
})
