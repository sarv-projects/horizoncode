/**
 * ArtifactSearch — bounded, generation-bound retrieval over managed tool-output artifacts.
 *
 * P3 / Gate 4 slice for `artifacts.search_text`, `terminal.search` and
 * `terminal.output_range` (`arch_V1/30-CONTEXT-INDEXING-LOCAL-MODELS.md §30.17`,
 * `arch_V1/33-BUILTIN-CAPABILITIES-CATALOG.md §33.23`). It reads the managed
 * truncation directory (`Truncate.write`), never a caller-supplied filesystem path:
 * callers pass an opaque artifact id that must be a single path segment.
 *
 * Contract:
 * - Lines are zero-based; ranges are half-open `[lineStart, lineEndExclusive)`.
 *   Matches report the line number plus the line's byte offset in the artifact.
 * - Every operation binds a generation derived from (id, size, mtime, ctime, inode).
 *   Rotation, truncation or replacement advances the generation. A caller that
 *   supplies `expectedGeneration` is rejected with `stale_generation` (the
 *   TM-002 "log rotates while the model holds a range ref" case) instead of
 *   silently resolving old references to different content.
 * - Scans are chunked, memory-bounded (one chunk plus one line), interruptible
 *   between chunks and capped by bytes, duration, results, excerpt size and
 *   line length. Every stop is reported (scan_limit/deadline/result_limit/
 *   long_lines) and results are labeled fresh/partial/stale.
 * - Read-only: no writes, no Guard lease, no effect authority. Results are
 *   advisory references and must never authorize a write or effect.
 */

import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import nodeFs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Schema, Scope, Semaphore } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { waitForAbort } from "@opencode-ai/core/process"
import { TRUNCATION_DIR } from "./truncation-dir"

export const MAX_ARTIFACT_ID_BYTES = 255
export const MAX_QUERY_BYTES = 256
export const MAX_PATTERN_BYTES = 256
export const DEFAULT_MAX_RESULTS = 50
export const MAX_RESULTS = 100
export const DEFAULT_MAX_EXCERPT_BYTES = 200
export const MAX_EXCERPT_BYTES = 8_192
export const DEFAULT_MAX_SCAN_BYTES = 134_217_728
export const MAX_SCAN_BYTES = 268_435_456
export const DEFAULT_MAX_DURATION_MS = 5_000
/** Keep duration inputs within reliable host timer semantics and hard-bounded. */
export const MAX_DURATION_MS = 60_000
export const CHUNK_BYTES = 262_144
export const MAX_LINE_BYTES = 65_536
export const EXCERPT_CONTEXT_BYTES = 16
export const DEFAULT_RANGE_BYTES = 65_536
export const MAX_RANGE_BYTES = 1_048_576

export type ArtifactSearchErrorCode =
  | "invalid_artifact_id"
  | "not_found"
  | "invalid_query"
  | "invalid_pattern"
  | "invalid_range"
  | "stale_generation"
  | "cancelled"
  | "failed"

export class ArtifactSearchError extends Schema.TaggedErrorClass<ArtifactSearchError>()("ArtifactSearchError", {
  code: Schema.Literals([
    "invalid_artifact_id",
    "not_found",
    "invalid_query",
    "invalid_pattern",
    "invalid_range",
    "stale_generation",
    "cancelled",
    "failed",
  ]),
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.detail === undefined
      ? `Artifact search failed: ${this.code}`
      : `Artifact search failed: ${this.code}: ${this.detail}`
  }
}

export interface Match {
  /** Zero-based line index containing the match. */
  readonly line: number
  /** Byte offset of the start of that line in the artifact. */
  readonly byteOffset: number
  /** Bounded excerpt of the line, windowed around the match start. */
  readonly text: string
  readonly excerptTruncated: boolean
}

export type SearchTruncation = "result_limit" | "scan_limit" | "deadline" | "long_lines"

export interface SearchInput {
  readonly artifactId: string
  readonly query: string
  readonly mode?: "literal" | "regex"
  /** Regex flags; only `i`, `m` and `s` are accepted. */
  readonly flags?: string
  readonly expectedGeneration?: string
  readonly maxResults?: number
  readonly maxBytesPerExcerpt?: number
  readonly maxScanBytes?: number
  readonly maxDurationMs?: number
  readonly signal?: AbortSignal
}

export interface SearchResult {
  readonly artifactId: string
  readonly generation: string
  readonly freshness: "fresh" | "partial" | "stale"
  readonly staleReason?: "source_changed"
  readonly matches: ReadonlyArray<Match>
  readonly scannedBytes: number
  readonly totalBytes: number
  readonly truncation: ReadonlyArray<SearchTruncation>
  readonly longLinesSkipped: number
}

export interface ReadRangeInput {
  readonly artifactId: string
  /** Zero-based inclusive first line. */
  readonly lineStart: number
  /** Zero-based exclusive end line. */
  readonly lineEndExclusive: number
  readonly expectedGeneration?: string
  readonly maxBytes?: number
  readonly maxScanBytes?: number
  readonly maxDurationMs?: number
  readonly signal?: AbortSignal
}

export interface ReadRangeResult {
  readonly artifactId: string
  readonly generation: string
  readonly lineStart: number
  /** Exclusive end of the lines actually returned (clamped to EOF or byte cap). */
  readonly lineEndExclusive: number
  readonly text: string
  readonly truncated: boolean
  readonly truncationReason?: "bytes" | "scan_limit" | "deadline"
  readonly bytes: number
}

export interface Interface {
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, ArtifactSearchError>
  readonly readRange: (input: ReadRangeInput) => Effect.Effect<ReadRangeResult, ArtifactSearchError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ArtifactSearch") {}

export interface ArtifactStat {
  readonly type: string
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly ino: number
}

export interface ArtifactSearchFile {
  readonly stat: ArtifactStat
  readonly read: (size: number, position: number) => Effect.Effect<Uint8Array, ArtifactSearchError>
  readonly close: Effect.Effect<void>
}

export interface ArtifactSearchRoot {
  readonly openArtifact: (artifactId: string) => Effect.Effect<ArtifactSearchFile | undefined, ArtifactSearchError>
  readonly close: Effect.Effect<void>
}

export interface ArtifactSearchSource {
  readonly openRoot: (root: string) => Effect.Effect<ArtifactSearchRoot, ArtifactSearchError>
}

interface ScanLine {
  readonly number: number
  readonly byteOffset: number
  readonly buffer: Buffer
  readonly terminated: boolean
}

type ScanOutcome = "eof" | "early" | "scan_limit" | "deadline" | "cancelled"

interface ScanResult {
  readonly outcome: ScanOutcome
  readonly scannedBytes: number
}

const invalidArtifactId = (artifactId: string) =>
  new ArtifactSearchError({ code: "invalid_artifact_id", detail: `not a managed artifact id: ${artifactId}` })

const cancelled = () =>
  new ArtifactSearchError({ code: "cancelled", detail: "the caller aborted the artifact operation" })

const validateArtifactId = (artifactId: string): ArtifactSearchError | undefined => {
  if (artifactId.length === 0 || Buffer.byteLength(artifactId, "utf-8") > MAX_ARTIFACT_ID_BYTES) {
    return invalidArtifactId(artifactId)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifactId)) return invalidArtifactId(artifactId)
  return undefined
}

const validateQuery = (query: string, mode: "literal" | "regex"): ArtifactSearchError | undefined => {
  if (query.length === 0) return new ArtifactSearchError({ code: "invalid_query", detail: "query must not be empty" })
  const maximum = mode === "regex" ? MAX_PATTERN_BYTES : MAX_QUERY_BYTES
  if (Buffer.byteLength(query, "utf-8") > maximum) {
    return new ArtifactSearchError({ code: "invalid_query", detail: `query exceeds ${maximum} UTF-8 bytes` })
  }
  if (query.includes("\n") || query.includes("\r")) {
    return new ArtifactSearchError({ code: "invalid_query", detail: "query must be a single line" })
  }
  return undefined
}

const compileRegex = (
  pattern: string,
  flags: string,
): { readonly value: RegExp } | { readonly error: ArtifactSearchError } => {
  if (!/^[ims]*$/.test(flags)) {
    return { error: new ArtifactSearchError({ code: "invalid_pattern", detail: `unsupported regex flags: ${flags}` }) }
  }
  try {
    return { value: new RegExp(pattern, flags) }
  } catch (cause) {
    return { error: new ArtifactSearchError({ code: "invalid_pattern", detail: String(cause) }) }
  }
}

const clampPositive = (value: number | undefined, fallback: number, maximum: number) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), maximum)
}

const generationOf = (artifactId: string, stat: ArtifactStat) =>
  `a2:${createHash("sha256")
    .update(`artifact\u0000${artifactId}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${stat.ctimeMs}\u0000${stat.ino}`)
    .digest("hex")}`

const procFdPath = (fd: number) => `/proc/self/fd/${fd}`

const statFromHandle = async (handle: FileHandle): Promise<ArtifactStat> => {
  const info = await handle.stat()
  return {
    type: info.isFile() ? "File" : info.isDirectory() ? "Directory" : "Other",
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
    ctimeMs: Number(info.ctimeMs),
    ino: Number(info.ino),
  }
}

/**
 * The Effect FileSystem API does not expose descriptor-relative O_NOFOLLOW opens.
 * On Linux, keep the managed artifact directory pinned and open each single-segment
 * artifact beneath that descriptor. Verify the opened descriptor's resolved path
 * before inspecting metadata or reading bytes; other platforms fail closed.
 */
export const nodeSource: ArtifactSearchSource = {
  openRoot: (rootPath) =>
    Effect.tryPromise({
      try: async () => {
        if (process.platform !== "linux") throw new Error("descriptor-rooted artifact reads require Linux procfs")

        const rootHandle = await nodeFs.open(
          rootPath,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        )
        try {
          const actualRoot = await nodeFs.realpath(procFdPath(rootHandle.fd))
          if (actualRoot !== rootPath || !(await rootHandle.stat()).isDirectory()) {
            throw new Error("the opened artifact root does not match the configured root")
          }

          const rootFdPath = procFdPath(rootHandle.fd)
          return {
            openArtifact: (artifactId) =>
              Effect.tryPromise({
                try: async () => {
                  if (validateArtifactId(artifactId)) return undefined
                  let handle: FileHandle | undefined
                  try {
                    handle = await nodeFs.open(
                      `${rootFdPath}/${artifactId}`,
                      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
                    )
                    const actual = await nodeFs.realpath(procFdPath(handle.fd))
                    const expected = path.resolve(rootPath, artifactId)
                    if (actual !== expected) {
                      await handle.close()
                      return undefined
                    }
                    const stat = await statFromHandle(handle)
                    if (stat.type !== "File") {
                      await handle.close()
                      return undefined
                    }

                    const sourceHandle = handle
                    return {
                      stat,
                      read: (size, position) =>
                        Effect.tryPromise({
                          try: async () => {
                            if (!Number.isSafeInteger(size) || size < 0 || size > CHUNK_BYTES) {
                              throw new Error(`invalid artifact read size: ${size}`)
                            }
                            const buffer = Buffer.allocUnsafe(size)
                            const result = await sourceHandle.read(buffer, 0, size, position)
                            return buffer.subarray(0, result.bytesRead)
                          },
                          catch: (cause) =>
                            new ArtifactSearchError({
                              code: "failed",
                              detail: `cannot read artifact ${artifactId}: ${String(cause)}`,
                            }),
                        }),
                      close: Effect.promise(async () => {
                        await sourceHandle.close().catch(() => {})
                      }),
                    } satisfies ArtifactSearchFile
                  } catch {
                    if (handle) await handle.close().catch(() => {})
                    return undefined
                  }
                },
                catch: (cause) =>
                  new ArtifactSearchError({
                    code: "failed",
                    detail: `cannot open artifact ${artifactId}: ${String(cause)}`,
                  }),
              }),
            close: Effect.promise(async () => {
              await rootHandle.close().catch(() => {})
            }),
          } satisfies ArtifactSearchRoot
        } catch (cause) {
          await rootHandle.close().catch(() => {})
          throw cause
        }
      },
      catch: (cause) =>
        new ArtifactSearchError({
          code: "failed",
          detail: `secure artifact access unavailable: ${String(cause)}`,
        }),
    }),
}

export type ArtifactMatcherResult = { readonly kind: "match"; readonly index?: number } | { readonly kind: "deadline" }

export type ArtifactLineMatcher = { readonly index: (line: Buffer) => Effect.Effect<ArtifactMatcherResult, ArtifactSearchError> }

type MatcherIndex = ArtifactMatcherResult

type Matcher = ArtifactLineMatcher

const regexWorkers = Semaphore.makeUnsafe(1)

const REGEX_WORKER_SOURCE = `
self.onmessage = (event) => {
  const { pattern, flags, line } = event.data
  try {
    const match = new RegExp(pattern, flags).exec(line)
    self.postMessage({ index: match === null ? null : match.index })
  } catch (error) {
    self.postMessage({ error: String(error) })
  }
}
`

const literalMatcher = (query: string): Matcher => {
  const needle = Buffer.from(query, "utf-8")
  return {
    index: (line) =>
      Effect.sync(() => {
        const at = line.indexOf(needle)
        return at === -1 ? { kind: "match" } : { kind: "match", index: at }
      }),
  }
}

const regexMatcher = (
  pattern: string,
  flags: string,
  deadline: number,
  now: () => number,
): Effect.Effect<Matcher, ArtifactSearchError, Scope.Scope> =>
  Effect.gen(function* () {
    let workerUrl: string | undefined
    const worker = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          workerUrl = URL.createObjectURL(new Blob([REGEX_WORKER_SOURCE], { type: "text/javascript" }))
          try {
            return new Worker(workerUrl)
          } catch (cause) {
            URL.revokeObjectURL(workerUrl)
            throw cause
          }
        },
        catch: (cause) => new ArtifactSearchError({ code: "failed", detail: `cannot start isolated regex worker: ${String(cause)}` }),
      }),
      (worker) =>
        Effect.sync(() => {
          worker.terminate()
          if (workerUrl !== undefined) URL.revokeObjectURL(workerUrl)
        }),
    )

    const index: Matcher["index"] = (line) =>
      Effect.tryPromise({
        try: (signal) =>
          new Promise<MatcherIndex>((resolve, reject) => {
            let settled = false
            const remainingMs = Math.max(0, deadline - now())
            let timer: ReturnType<typeof setTimeout> | undefined
            const finish = (result: MatcherIndex) => {
              if (settled) return
              settled = true
              if (timer !== undefined) clearTimeout(timer)
              signal.removeEventListener("abort", onAbort)
              resolve(result)
            }
            const fail = (cause: unknown) => {
              if (settled) return
              settled = true
              if (timer !== undefined) clearTimeout(timer)
              signal.removeEventListener("abort", onAbort)
              reject(cause)
            }
            const onAbort = () => {
              worker.terminate()
              fail(new Error("regex evaluation was interrupted"))
            }

            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener("abort", onAbort, { once: true })
            if (remainingMs === 0) {
              finish({ kind: "deadline" })
              return
            }
            timer = setTimeout(() => {
              worker.terminate()
              finish({ kind: "deadline" })
            }, remainingMs)
            worker.onmessage = (event: MessageEvent<{ index?: number | null; error?: string }>) => {
              if (event.data.error !== undefined) {
                fail(new Error(event.data.error))
                return
              }
              const match = event.data.index
              finish(match === null || match === undefined ? { kind: "match" } : { kind: "match", index: match })
            }
            worker.onerror = (event: ErrorEvent) => fail(event.error ?? new Error(event.message))
            try {
              worker.postMessage({ pattern, flags, line: line.toString("utf-8") })
            } catch (cause) {
              fail(cause)
            }
          }),
        catch: (cause) =>
          cause instanceof ArtifactSearchError
            ? cause
            : new ArtifactSearchError({ code: "failed", detail: `isolated regex evaluation failed: ${String(cause)}` }),
      })

    return {
      index: (line) =>
        Effect.map(index(line), (result) => {
          if (result.kind === "deadline" || result.index === undefined) return result
          const text = line.toString("utf-8")
          return { kind: "match", index: Buffer.byteLength(text.slice(0, result.index), "utf-8") }
        }),
    } satisfies Matcher
  })

/**
 * Create the same bounded literal/isolated-regex line matcher for authenticated
 * HostKernel artifact range readers. The returned matcher owns no file access;
 * callers must supply bounded lines and hold a Scope for regex worker cleanup.
 */
export const makeArtifactLineMatcher = (
  query: string,
  mode: "literal" | "regex",
  flags: string,
  deadline: number,
  now: () => number,
): Effect.Effect<ArtifactLineMatcher, ArtifactSearchError, Scope.Scope> => {
  const error = validateQuery(query, mode)
  if (error) return Effect.fail(error)
  if (mode === "literal") return Effect.succeed(literalMatcher(query))
  const compiled = compileRegex(query, flags)
  if ("error" in compiled) return Effect.fail(compiled.error)
  return regexMatcher(query, flags, deadline, now)
}

/** Keep regex workers globally serialized across local and HostKernel readers. */
export const withArtifactRegexPermit = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  regexWorkers.withPermits(1)(operation)

const excerptOf = (line: Buffer, matchIndex: number, maxExcerptBytes: number) => {
  const start = Math.max(0, matchIndex - EXCERPT_CONTEXT_BYTES)
  const excerpt = line.subarray(start, start + maxExcerptBytes)
  return {
    text: excerpt.toString("utf-8"),
    excerptTruncated: start > 0 || excerpt.length < line.length,
  }
}

export const make = (options: {
  readonly fs: FSUtil.Interface
  readonly root: string
  readonly source?: ArtifactSearchSource
  readonly now?: () => number
}): Interface => {
  const fs = options.fs
  const source = options.source ?? nodeSource
  const now = options.now ?? (() => Date.now())

  const withArtifact = <A>(input: {
    readonly artifactId: string
    readonly expectedGeneration?: string
    readonly use: (value: {
      readonly root: ArtifactSearchRoot
      readonly file: ArtifactSearchFile
      readonly generation: string
    }) => Effect.Effect<A, ArtifactSearchError, Scope.Scope>
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const rootPath = yield* fs
          .resolve(options.root)
          .pipe(
            Effect.mapError(
              () => new ArtifactSearchError({ code: "failed", detail: `artifact root ${options.root} is unavailable` }),
            ),
          )
        const root = yield* Effect.acquireRelease(source.openRoot(rootPath), (opened) => opened.close)
        const file = yield* Effect.acquireRelease(
          root.openArtifact(input.artifactId),
          (opened) => opened?.close ?? Effect.void,
        )
        if (file === undefined) return yield* new ArtifactSearchError({ code: "not_found", detail: input.artifactId })

        const generation = generationOf(input.artifactId, file.stat)
        if (input.expectedGeneration !== undefined && input.expectedGeneration !== generation) {
          return yield* new ArtifactSearchError({
            code: "stale_generation",
            detail: `expected ${input.expectedGeneration}, current ${generation}`,
          })
        }
        return yield* input.use({ root, file, generation })
      }),
    )

  const sourceChanged = Effect.fnUntraced(function* (root: ArtifactSearchRoot, artifactId: string, generation: string) {
    const current = yield* Effect.acquireRelease(
      root.openArtifact(artifactId),
      (opened) => opened?.close ?? Effect.void,
    )
    return current === undefined || generationOf(artifactId, current.stat) !== generation
  })

  const scanLines = (input: {
    readonly handle: ArtifactSearchFile
    readonly size: number
    readonly maxScanBytes: number
    readonly deadline: number
    readonly signal?: AbortSignal
    readonly onLine: (line: ScanLine) => Effect.Effect<boolean, ArtifactSearchError>
    readonly onLongLine: () => void
  }): Effect.Effect<ScanResult, ArtifactSearchError> =>
    Effect.gen(function* () {
      const limited = input.size > input.maxScanBytes
      const limit = Math.min(input.size, input.maxScanBytes)
      let position = 0
      let pending = Buffer.alloc(0)
      let pendingStart = 0
      let lineNumber = 0
      let lineIsLong = false
      let outcome: ScanOutcome = "eof"

      while (position < limit) {
        if (input.signal?.aborted === true) {
          outcome = "cancelled"
          break
        }
        if (now() > input.deadline) {
          outcome = "deadline"
          break
        }
        const take = Math.min(CHUNK_BYTES, limit - position)
        const chunk = yield* input.handle.read(take, position)
        if (chunk.length === 0) break
        position += chunk.length
        pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, Buffer.from(chunk)])

        let cursor = 0
        let stopped = false
        while (true) {
          const newline = pending.indexOf(0x0a, cursor)
          if (newline === -1) break
          if (lineIsLong) {
            input.onLongLine()
          } else {
            const buffer = pending.subarray(cursor, newline)
            if (buffer.length > MAX_LINE_BYTES) {
              input.onLongLine()
            } else if (
              !(yield* input.onLine({ number: lineNumber, byteOffset: pendingStart + cursor, buffer, terminated: true }))
            ) {
              outcome = "early"
              stopped = true
              break
            }
          }
          lineNumber++
          cursor = newline + 1
          lineIsLong = false
        }
        if (stopped) break
        if (cursor > 0) {
          pending = pending.subarray(cursor)
          pendingStart += cursor
        }
        if (pending.length > MAX_LINE_BYTES) {
          pendingStart += pending.length
          pending = Buffer.alloc(0)
          lineIsLong = true
        }
      }

      const reachedEnd = position >= input.size
      if (outcome === "eof" && reachedEnd && pending.length > 0) {
        if (lineIsLong || pending.length > MAX_LINE_BYTES) {
          input.onLongLine()
        } else {
          yield* input.onLine({ number: lineNumber, byteOffset: pendingStart, buffer: pending, terminated: false })
        }
      }
      if (outcome === "eof" && limited && !reachedEnd) outcome = "scan_limit"
      return { outcome, scannedBytes: position }
    })

  const guard = <A>(
    operation: Effect.Effect<A, ArtifactSearchError>,
    signal: AbortSignal | undefined,
  ): Effect.Effect<A, ArtifactSearchError> => {
    if (signal === undefined) return operation
    return operation.pipe(
      Effect.raceFirst(waitForAbort(signal)),
      Effect.mapError((error) =>
        error instanceof ArtifactSearchError
          ? error
          : new ArtifactSearchError({ code: "cancelled", detail: String(error) }),
      ),
    )
  }

  const search = Effect.fn("ArtifactSearch.search")(function* (input: SearchInput) {
    const mode = input.mode ?? "literal"
    return yield* guard(
      Effect.gen(function* () {
        const idError = validateArtifactId(input.artifactId)
        if (idError) return yield* idError
        const queryError = validateQuery(input.query, mode)
        if (queryError) return yield* queryError
        const maxResults = clampPositive(input.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS)
        const maxExcerpt = clampPositive(input.maxBytesPerExcerpt, DEFAULT_MAX_EXCERPT_BYTES, MAX_EXCERPT_BYTES)
        const maxScanBytes = clampPositive(input.maxScanBytes, DEFAULT_MAX_SCAN_BYTES, MAX_SCAN_BYTES)
        const maxDurationMs = clampPositive(input.maxDurationMs, DEFAULT_MAX_DURATION_MS, MAX_DURATION_MS)
        if (mode === "regex") {
          const compiled = compileRegex(input.query, input.flags ?? "")
          if ("error" in compiled) return yield* compiled.error
        }
        const deadline = now() + maxDurationMs
        const operation = withArtifact({
          artifactId: input.artifactId,
          ...(input.expectedGeneration !== undefined ? { expectedGeneration: input.expectedGeneration } : {}),
          use: ({ root, file, generation }) =>
            Effect.scoped(
              Effect.gen(function* () {
                const matcher =
                  mode === "literal"
                    ? literalMatcher(input.query)
                    : yield* regexMatcher(input.query, input.flags ?? "", deadline, now)
              const matches: Match[] = []
              let longLinesSkipped = 0
              let regexTimedOut = false
              const scan = yield* scanLines({
                handle: file,
                size: file.stat.size,
                maxScanBytes,
                deadline,
                ...(input.signal !== undefined ? { signal: input.signal } : {}),
                onLine: (line) =>
                  Effect.gen(function* () {
                    const found = yield* matcher.index(line.buffer)
                    if (found.kind === "deadline") {
                      regexTimedOut = true
                      return false
                    }
                    if (found.index === undefined) return true
                    const excerpt = excerptOf(line.buffer, found.index, maxExcerpt)
                    matches.push({ line: line.number, byteOffset: line.byteOffset, ...excerpt })
                    return matches.length < maxResults
                  }),
                onLongLine: () => {
                  longLinesSkipped++
                },
              })
              if (scan.outcome === "cancelled") return yield* cancelled()

              const changed = yield* sourceChanged(root, input.artifactId, generation)
              const truncation: SearchTruncation[] = []
              if (regexTimedOut || scan.outcome === "deadline") truncation.push("deadline")
              if (scan.outcome === "early" && !regexTimedOut) truncation.push("result_limit")
              if (scan.outcome === "scan_limit") truncation.push("scan_limit")
              if (longLinesSkipped > 0) truncation.push("long_lines")
              const freshness: SearchResult["freshness"] = changed
                ? "stale"
                : truncation.length === 0
                  ? "fresh"
                  : "partial"

              return {
                artifactId: input.artifactId,
                generation,
                freshness,
                ...(freshness === "stale" ? { staleReason: "source_changed" as const } : {}),
                matches,
                scannedBytes: scan.scannedBytes,
                totalBytes: file.stat.size,
                truncation,
                longLinesSkipped,
              } satisfies SearchResult
              }),
            ),
        })
        return yield* (mode === "regex" ? regexWorkers.withPermits(1)(operation) : operation)
      }),
      input.signal,
    )
  })

  const readRange = Effect.fn("ArtifactSearch.readRange")(function* (input: ReadRangeInput) {
    return yield* guard(
      Effect.gen(function* () {
        const idError = validateArtifactId(input.artifactId)
        if (idError) return yield* idError
        if (
          !Number.isInteger(input.lineStart) ||
          input.lineStart < 0 ||
          !Number.isInteger(input.lineEndExclusive) ||
          input.lineEndExclusive <= input.lineStart
        ) {
          return yield* new ArtifactSearchError({
            code: "invalid_range",
            detail: `[${input.lineStart}, ${input.lineEndExclusive})`,
          })
        }
        const maxBytes = clampPositive(input.maxBytes, DEFAULT_RANGE_BYTES, MAX_RANGE_BYTES)
        const maxScanBytes = clampPositive(input.maxScanBytes, DEFAULT_MAX_SCAN_BYTES, MAX_SCAN_BYTES)
        const maxDurationMs = clampPositive(input.maxDurationMs, DEFAULT_MAX_DURATION_MS, MAX_DURATION_MS)
        return yield* withArtifact({
          artifactId: input.artifactId,
          ...(input.expectedGeneration !== undefined ? { expectedGeneration: input.expectedGeneration } : {}),
          use: ({ root, file, generation }) =>
            Effect.gen(function* () {
              const deadline = now() + maxDurationMs
              const parts: string[] = []
              let bytes = 0
              let effectiveEnd = input.lineStart
              let truncatedByBytes = false
              const scan = yield* scanLines({
                handle: file,
                size: file.stat.size,
                maxScanBytes,
                deadline,
                ...(input.signal !== undefined ? { signal: input.signal } : {}),
                onLine: (line) =>
                  Effect.sync(() => {
                    if (line.number < input.lineStart) return true
                    if (line.number >= input.lineEndExclusive) return false
                    const piece = line.buffer.toString("utf-8") + (line.terminated ? "\n" : "")
                    const size = Buffer.byteLength(piece, "utf-8")
                    if (bytes + size > maxBytes) {
                      truncatedByBytes = true
                      return false
                    }
                    parts.push(piece)
                    bytes += size
                    effectiveEnd = line.number + 1
                    return line.number + 1 < input.lineEndExclusive
                  }),
                onLongLine: () => {},
              })
              if (scan.outcome === "cancelled") return yield* cancelled()
              const changed = yield* sourceChanged(root, input.artifactId, generation)
              if (changed) {
                return yield* new ArtifactSearchError({
                  code: "stale_generation",
                  detail: `artifact ${input.artifactId} changed during range read`,
                })
              }
              const truncationReason: ReadRangeResult["truncationReason"] = truncatedByBytes
                ? "bytes"
                : scan.outcome === "scan_limit"
                  ? "scan_limit"
                  : scan.outcome === "deadline"
                    ? "deadline"
                    : undefined
              return {
                artifactId: input.artifactId,
                generation,
                lineStart: input.lineStart,
                lineEndExclusive: effectiveEnd,
                text: parts.join(""),
                truncated: truncationReason !== undefined,
                ...(truncationReason !== undefined ? { truncationReason } : {}),
                bytes,
              } satisfies ReadRangeResult
            }),
        })
      }),
      input.signal,
    )
  })

  return { search, readRange }
}

export const layer = (options?: { readonly root?: string }) =>
  Layer.effect(
    Service,
    Effect.map(FSUtil.Service, (fs) => make({ fs, root: options?.root ?? TRUNCATION_DIR })),
  )

/** Layer wired to the managed tool-output artifact root. */
export const defaultLayer = layer()

export * as ArtifactSearch from "./artifact-search"
