/**
 * RepoIntel — Location/workspace-scoped, generation-bound lexical text-search adapter.
 *
 * P3 / Gate 4 slice. This module is the caller side of the existing Rust `indexd`
 * primitives (`indexd/src/lib.rs`: `BaseGeneration`, `BufferOverlay`, `RepoIntelGeneration`,
 * `SearchCursor`, bounded lexical search). It is deliberately not a search engine:
 *
 * 1. it verifies the requested read scope before any filesystem read;
 * 2. it collects a bounded, UTF-8, indexd-legal snapshot set (`FileSnapshot`);
 * 3. it derives deterministic generation pins from the observed tree;
 * 4. it reuses a bounded in-memory generation cache keyed by (scope, observation);
 * 5. it relays one bounded text query through the injected `RepoIntelBackend` port;
 * 6. it re-verifies the observation and labels results fresh/partial/stale.
 *
 * The backend port mirrors the Rust API one call at a time and is transport-agnostic.
 * `RepoIntelBackendError` codes are the exact `IndexError` variant names, so the real
 * transport (host-kernel / `hz-indexd` owned, bounded request/response with its own
 * time and byte budgets) can map them mechanically. Until that transport exists the
 * service fails closed with `backend_unavailable` instead of fabricating results.
 *
 * Safety invariants:
 * - Read-only: this module never writes, never acquires a Guard lease, and its results
 *   are advisory references only. They must never authorize a write; Guard/lease and
 *   source-hash preconditions remain authoritative.
 * - Scope: every candidate path is derived from `scope.root` plus directory-listing
 *   names. A caller-supplied `subpath` is rejected before any read when it is absolute
 *   or contains traversal, NUL/control bytes, ":" or platform separators. Symlinked
 *   entries are never followed; file paths are realpath-checked for containment before
 *   their bytes are read.
 * - Bounds: indexd's file/count/byte/path/query/result limits are enforced caller-side,
 *   so the backend never receives an invalid snapshot set.
 * - Provenance: results always carry the generation id plus fresh/partial/stale with
 *   concrete truncation/skip reasons. A stale generation is rejected when the caller
 *   pins `expectedGenerationId` and when a cursor stopped being valid.
 */

import { createHash } from "node:crypto"
import path from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { waitForAbort } from "@opencode-ai/core/process"

// indexd/src/lib.rs bounds. Keep these byte-for-byte aligned with the Rust constants.
export const MAX_BASE_FILES = 4_096
export const MAX_FILE_BYTES = 1_048_576
export const MAX_BASE_CONTENT_BYTES = 67_108_864
export const MAX_BASE_PATH_BYTES = 4_194_304
export const MAX_PATH_BYTES = 1_024
export const MAX_QUERY_BYTES = 256
export const MAX_QUERY_RESULTS = 100
export const MAX_SEARCH_CURSOR_BYTES = 2_400

export const DEFAULT_MAX_RESULTS = 50
export const DEFAULT_MAX_DIRECTORIES = MAX_BASE_FILES * 2
export const DEFAULT_MAX_DURATION_MS = 5_000
export const DEFAULT_MAX_CACHE_ENTRIES = 8
export const MAX_REPORTED_SKIPS = 64
export const DEFAULT_IGNORED_DIRECTORIES = [".git", "node_modules"] as const

export type RepoIntelOperation = "text" | "symbol" | "references" | "impact" | "expand"

export type RepoIntelErrorCode =
  | "scope_denied"
  | "not_found"
  | "invalid_query"
  | "query_too_large"
  | "multiline_query"
  | "invalid_result_limit"
  | "stale_generation"
  | "invalid_cursor"
  | "cancelled"
  | "backend_unavailable"
  | "backend_rejected"
  | "failed"

export class RepoIntelError extends Schema.TaggedErrorClass<RepoIntelError>()("RepoIntelError", {
  code: Schema.Literals([
    "scope_denied",
    "not_found",
    "invalid_query",
    "query_too_large",
    "multiline_query",
    "invalid_result_limit",
    "stale_generation",
    "invalid_cursor",
    "cancelled",
    "backend_unavailable",
    "backend_rejected",
    "failed",
  ]),
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.detail === undefined
      ? `RepoIntel failed: ${this.code}`
      : `RepoIntel failed: ${this.code}: ${this.detail}`
  }
}

/**
 * `IndexError` variant names, plus `unavailable` for "no transport wired yet" and
 * `rejected` for a transport-level failure that has no indexd counterpart.
 */
export type RepoIntelBackendErrorCode =
  | "unavailable"
  | "rejected"
  | "generation_mismatch"
  | "cursor_generation_mismatch"
  | "cursor_query_mismatch"
  | "cursor_overlay_mismatch"
  | "cursor_anchor_not_found"
  | "cursor_work_limit"
  | "invalid_search_cursor"
  | "invalid_path"
  | "duplicate_path"
  | "invalid_utf8"
  | "too_many_base_files"
  | "file_too_large"
  | "base_content_limit"
  | "base_path_limit"
  | "empty_query"
  | "query_too_large"
  | "multiline_query"
  | "invalid_result_limit"
  | "overlay_generation_mismatch"

export class RepoIntelBackendError extends Schema.TaggedErrorClass<RepoIntelBackendError>()("RepoIntelBackendError", {
  code: Schema.Literals([
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
  ]),
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.detail === undefined
      ? `RepoIntel backend failed: ${this.code}`
      : `RepoIntel backend failed: ${this.code}: ${this.detail}`
  }
}

/** Opaque caller pins bound into one generation. Deterministic for equal observations. */
export interface RepoIntelPins {
  readonly repository: string
  readonly workspace?: string
  readonly revisionSet: string
  readonly readScope: string
  readonly readPolicy: string
  readonly sourceReceipt: string
  readonly parserSet: string
}

/** One bounded UTF-8 snapshot handed to the backend. `path` is indexd-normalized. */
export interface RepoIntelSnapshot {
  readonly path: string
  readonly contents: Uint8Array
}

export interface RepoIntelGenerationHandle {
  readonly generationId: string
  readonly generationStatus: "PARTIAL"
}

export interface RepoIntelBackendQuery {
  readonly operation: RepoIntelOperation
  readonly query: string
  readonly maxResults: number
  readonly cursor?: string
}

export interface RepoIntelMatch {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
}

export interface RepoIntelBackendResult {
  readonly status: "PARTIAL" | "UNAVAILABLE"
  readonly generationId: string
  readonly matches: ReadonlyArray<RepoIntelMatch>
  readonly nextCursor?: string
  readonly workUnits?: number
  readonly truncatedBy?: "work_limit" | "result_limit"
  readonly unavailableReason?: { readonly operation: RepoIntelOperation }
}

export interface RepoIntelBackend {
  readonly build: (
    pins: RepoIntelPins,
    snapshots: ReadonlyArray<RepoIntelSnapshot>,
  ) => Effect.Effect<RepoIntelGenerationHandle, RepoIntelBackendError>
  readonly query: (
    handle: RepoIntelGenerationHandle,
    request: RepoIntelBackendQuery,
  ) => Effect.Effect<RepoIntelBackendResult, RepoIntelBackendError>
  readonly release?: (handle: RepoIntelGenerationHandle) => Effect.Effect<void>
}

export interface ReadScope {
  /** Absolute admitted root. The caller must already hold read permission for this root. */
  readonly root: string
  /** Opaque stable scope identity bound into generation pins and cache keys (Location/workspace). */
  readonly scopeId: string
  /** Optional digest of the caller's read policy/permission state. */
  readonly policyDigest?: string
  readonly repositoryId?: string
  readonly workspaceId?: string
  /** Extra directory names skipped during collection. Defaults to `.git` and `node_modules`. */
  readonly ignoredDirectoryNames?: ReadonlyArray<string>
}

export interface SearchBudget {
  readonly maxFiles?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
  readonly maxPathBytes?: number
  readonly maxDirectories?: number
  readonly maxDurationMs?: number
}

export type SkipReason = "symlink" | "non_file" | "invalid_path" | "too_large" | "not_utf8" | "unreadable"
export type CollectionStop = "deadline" | "file_limit" | "byte_limit" | "path_limit" | "directory_limit"
export type TruncationReason = "result_limit" | "work_limit" | "unavailable" | CollectionStop | "skipped_files"

export interface TextSearchInput {
  readonly scope: ReadScope
  /** Directory or file relative to `scope.root`. Defaults to the root itself. */
  readonly subpath?: string
  readonly query: string
  readonly maxResults?: number
  readonly cursor?: string
  readonly expectedGenerationId?: string
  readonly budget?: SearchBudget
  readonly signal?: AbortSignal
}

export interface RepoIntelTextResult {
  readonly operation: "text"
  readonly status: "PARTIAL" | "UNAVAILABLE"
  readonly freshness: "fresh" | "partial" | "stale"
  readonly staleReason?: "source_changed"
  readonly generationId: string
  readonly matches: ReadonlyArray<RepoIntelMatch>
  readonly nextCursor?: string
  readonly workUnits?: number
  readonly truncation: ReadonlyArray<TruncationReason>
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: SkipReason }>
  readonly skippedCount: number
  readonly scanned: {
    readonly files: number
    readonly bytes: number
    readonly directories: number
    readonly durationMs: number
  }
  readonly scopeId: string
  readonly subpath: string
  readonly observedAt: number
}

export interface Interface {
  readonly searchText: (input: TextSearchInput) => Effect.Effect<RepoIntelTextResult, RepoIntelError>
  readonly invalidate: (scopeId: string) => Effect.Effect<number>
  readonly stats: () => Effect.Effect<{ readonly entries: number; readonly bytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RepoIntel") {}

interface CollectedFile {
  readonly rel: string
  readonly abs: string
  readonly contents: Uint8Array
  readonly size: number
  readonly mtimeMs: number
}

interface CollectedDirectory {
  readonly rel: string
  readonly abs: string
  readonly mtimeMs: number
}

interface Observation {
  readonly files: ReadonlyArray<CollectedFile>
  readonly directories: ReadonlyArray<CollectedDirectory>
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: SkipReason }>
  readonly skippedCount: number
  readonly scannedBytes: number
  readonly stoppedBy?: CollectionStop
  readonly observedAt: number
}

interface Limits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly maxPathBytes: number
  readonly maxDirectories: number
  readonly maxDurationMs: number
}

interface CacheEntry {
  readonly key: string
  readonly scopeId: string
  readonly handle: RepoIntelGenerationHandle
  readonly bytes: number
  lastUsedAt: number
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

const cancelled = () => new RepoIntelError({ code: "cancelled", detail: "the caller aborted the query" })

const validateQuery = (query: string): RepoIntelError | undefined => {
  if (query.length === 0) return new RepoIntelError({ code: "invalid_query", detail: "query must not be empty" })
  if (Buffer.byteLength(query, "utf-8") > MAX_QUERY_BYTES) {
    return new RepoIntelError({ code: "query_too_large", detail: `query exceeds ${MAX_QUERY_BYTES} UTF-8 bytes` })
  }
  if (query.includes("\n") || query.includes("\r")) {
    return new RepoIntelError({ code: "multiline_query", detail: "query must be a single line" })
  }
  return undefined
}

const validateMaxResults = (value: number): RepoIntelError | undefined => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUERY_RESULTS) {
    return new RepoIntelError({
      code: "invalid_result_limit",
      detail: `result limit must be an integer between 1 and ${MAX_QUERY_RESULTS}`,
    })
  }
  return undefined
}

/** Mirrors indexd's `validate_path` on a caller-supplied relative subpath. */
const normalizeSubpath = (subpath: string): { readonly value: string } | { readonly error: RepoIntelError } => {
  const candidate = subpath.replaceAll("\\", "/")
  if (candidate === "" || candidate === ".") return { value: "" }
  if (
    candidate.startsWith("/") ||
    candidate.includes(":") ||
    CONTROL_CHARACTERS.test(candidate) ||
    candidate.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return {
      error: new RepoIntelError({
        code: "scope_denied",
        detail: `subpath is not an admitted relative path: ${subpath}`,
      }),
    }
  }
  return { value: candidate }
}

const isIndexdRelativePath = (value: string) => {
  if (value.length === 0 || Buffer.byteLength(value, "utf-8") > MAX_PATH_BYTES) return false
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")) return false
  if (CONTROL_CHARACTERS.test(value)) return false
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

const clamp = (value: number | undefined, fallback: number, maximum: number) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), maximum)
}

const resolveLimits = (budget: SearchBudget | undefined): Limits => ({
  maxFiles: clamp(budget?.maxFiles, MAX_BASE_FILES, MAX_BASE_FILES),
  maxFileBytes: clamp(budget?.maxFileBytes, MAX_FILE_BYTES, MAX_FILE_BYTES),
  maxTotalBytes: clamp(budget?.maxTotalBytes, MAX_BASE_CONTENT_BYTES, MAX_BASE_CONTENT_BYTES),
  maxPathBytes: clamp(budget?.maxPathBytes, MAX_BASE_PATH_BYTES, MAX_BASE_PATH_BYTES),
  maxDirectories: clamp(budget?.maxDirectories, DEFAULT_MAX_DIRECTORIES, DEFAULT_MAX_DIRECTORIES),
  maxDurationMs:
    typeof budget?.maxDurationMs === "number" && Number.isFinite(budget.maxDurationMs) && budget.maxDurationMs > 0
      ? Math.floor(budget.maxDurationMs)
      : DEFAULT_MAX_DURATION_MS,
})

const decodeUtf8Strict = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

const pinDigest = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex")

const cacheKey = (scopeId: string, fingerprint: string) => `${scopeId}\u0000${fingerprint}`

const fingerprintOf = (scopeId: string, subpath: string, observed: Observation) => {
  const hash = createHash("sha256")
  hash.update("horizon.repo-intel.observation.v1\u0000")
  hash.update(scopeId)
  hash.update("\u0000")
  hash.update(subpath)
  hash.update("\u0000")
  hash.update(
    `stopped:${observed.stoppedBy ?? "-"}\u0000skipped:${observed.skippedCount}\u0000bytes:${observed.scannedBytes}\u0000`,
  )
  const directories = [...observed.directories].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const directory of directories) hash.update(`d\u0000${directory.rel}\u0000${directory.mtimeMs}\u0000`)
  for (const file of observed.files) hash.update(`f\u0000${file.rel}\u0000${file.size}\u0000${file.mtimeMs}\u0000`)
  return hash.digest("hex")
}

const derivePins = (scope: ReadScope, subpath: string, fingerprint: string): RepoIntelPins => ({
  repository: `v1:${pinDigest(`repository\u0000${scope.repositoryId ?? scope.scopeId}`)}`,
  ...(scope.workspaceId !== undefined ? { workspace: `v1:${pinDigest(`workspace\u0000${scope.workspaceId}`)}` } : {}),
  revisionSet: `v1:observed:${fingerprint}`,
  readScope: `v1:${pinDigest(`scope\u0000${scope.scopeId}\u0000${subpath}`)}`,
  readPolicy: `v1:${pinDigest(`policy\u0000${scope.policyDigest ?? "default"}`)}`,
  sourceReceipt: `v1:observation:${fingerprint}`,
  parserSet: "v1:lexical:none",
})

const mapBackendError = (error: RepoIntelBackendError): RepoIntelError => {
  switch (error.code) {
    case "generation_mismatch":
    case "cursor_generation_mismatch":
    case "cursor_overlay_mismatch":
      return new RepoIntelError({ code: "stale_generation", detail: `${error.code}: ${error.message}` })
    case "cursor_query_mismatch":
    case "cursor_anchor_not_found":
    case "cursor_work_limit":
    case "invalid_search_cursor":
      return new RepoIntelError({ code: "invalid_cursor", detail: `${error.code}: ${error.message}` })
    case "empty_query":
      return new RepoIntelError({ code: "invalid_query", detail: error.message })
    case "query_too_large":
      return new RepoIntelError({ code: "query_too_large", detail: error.message })
    case "multiline_query":
      return new RepoIntelError({ code: "multiline_query", detail: error.message })
    case "invalid_result_limit":
      return new RepoIntelError({ code: "invalid_result_limit", detail: error.message })
    case "unavailable":
      return new RepoIntelError({ code: "backend_unavailable", detail: error.message })
    default:
      return new RepoIntelError({ code: "backend_rejected", detail: `${error.code}: ${error.message}` })
  }
}

export const make = (options: {
  readonly fs: FSUtil.Interface
  readonly backend: RepoIntelBackend
  readonly maxEntries?: number
  readonly now?: () => number
}): Interface => {
  const fs = options.fs
  const backend = options.backend
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, CacheEntry>()

  const statOf = Effect.fnUntraced(function* (target: string) {
    const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (info === undefined) return undefined
    return {
      type: info.type as string,
      size: Number(info.size),
      mtimeMs: Option.getOrElse(info.mtime, () => new Date(0)).getTime(),
    }
  })

  const collect = Effect.fnUntraced(function* (input: {
    readonly root: string
    readonly subpath: string
    readonly scope: ReadScope
    readonly limits: Limits
    readonly signal?: AbortSignal
    readonly started: number
    readonly deadline: number
  }) {
    const { root, subpath, limits, signal } = input
    const ignored = new Set(input.scope.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORIES)
    const files: CollectedFile[] = []
    const directories: CollectedDirectory[] = []
    const skipped: Array<{ readonly path: string; readonly reason: SkipReason }> = []
    let skippedCount = 0
    let scannedBytes = 0
    let pathBytes = 0
    let stoppedBy: CollectionStop | undefined

    const skip = (rel: string, reason: SkipReason) => {
      skippedCount++
      if (skipped.length < MAX_REPORTED_SKIPS) skipped.push({ path: rel, reason })
    }
    const aborted = () => signal?.aborted === true
    const expired = () => now() > input.deadline

    const startAbs = subpath === "" ? root : path.join(root, subpath)
    const startStat = yield* statOf(startAbs)
    if (subpath !== "" && startStat === undefined) {
      return yield* new RepoIntelError({ code: "not_found", detail: subpath })
    }

    const candidates: string[] = []
    if (startStat?.type === "File") {
      candidates.push(subpath)
      const parentRel = subpath.includes("/") ? subpath.slice(0, subpath.lastIndexOf("/")) : ""
      const parentAbs = parentRel === "" ? root : path.join(root, parentRel)
      const parentStat = yield* statOf(parentAbs)
      if (parentStat?.type === "Directory") {
        directories.push({ rel: parentRel, abs: parentAbs, mtimeMs: parentStat.mtimeMs })
      }
    } else {
      const pending: string[] = [subpath]
      while (pending.length > 0) {
        if (aborted()) return yield* cancelled()
        if (expired()) {
          stoppedBy = "deadline"
          break
        }
        if (directories.length >= limits.maxDirectories) {
          stoppedBy = "directory_limit"
          break
        }
        const relDir = pending.shift()!
        const absDir = relDir === "" ? root : path.join(root, relDir)
        if (!FSUtil.contains(root, absDir)) {
          return yield* new RepoIntelError({ code: "scope_denied", detail: relDir })
        }
        const info = yield* statOf(absDir)
        if (info?.type !== "Directory") {
          skip(relDir, "unreadable")
          continue
        }
        directories.push({ rel: relDir, abs: absDir, mtimeMs: info.mtimeMs })
        const entries = yield* fs.readDirectoryEntries(absDir).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (entries === undefined) {
          skip(relDir, "unreadable")
          continue
        }
        for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
          const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`
          if (entry.type === "directory") {
            if (!ignored.has(entry.name)) pending.push(rel)
          } else if (entry.type === "file") {
            candidates.push(rel)
          } else {
            skip(rel, entry.type === "symlink" ? "symlink" : "non_file")
          }
        }
      }
    }

    candidates.sort()
    for (const rel of candidates) {
      if (aborted()) return yield* cancelled()
      if (expired()) {
        stoppedBy = "deadline"
        break
      }
      if (files.length >= limits.maxFiles) {
        stoppedBy = "file_limit"
        break
      }
      if (!isIndexdRelativePath(rel)) {
        skip(rel, "invalid_path")
        continue
      }
      pathBytes += Buffer.byteLength(rel, "utf-8")
      if (pathBytes > limits.maxPathBytes) {
        stoppedBy = "path_limit"
        break
      }
      const abs = path.join(root, rel)
      if (!FSUtil.contains(root, abs)) {
        return yield* new RepoIntelError({ code: "scope_denied", detail: rel })
      }
      const resolved = yield* fs.resolve(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (resolved === undefined || !FSUtil.contains(root, resolved)) {
        skip(rel, "symlink")
        continue
      }
      const info = yield* statOf(abs)
      if (info === undefined || info.type !== "File") {
        skip(rel, "unreadable")
        continue
      }
      if (info.size > limits.maxFileBytes) {
        skip(rel, "too_large")
        continue
      }
      if (scannedBytes + info.size > limits.maxTotalBytes) {
        stoppedBy = "byte_limit"
        break
      }
      const bytes = yield* fs.readFile(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (bytes === undefined) {
        skip(rel, "unreadable")
        continue
      }
      if (bytes.length > limits.maxFileBytes) {
        skip(rel, "too_large")
        continue
      }
      if (decodeUtf8Strict(bytes) === undefined) {
        skip(rel, "not_utf8")
        continue
      }
      files.push({ rel, abs, contents: bytes, size: bytes.length, mtimeMs: info.mtimeMs })
      scannedBytes += bytes.length
    }

    return {
      files,
      directories,
      skipped,
      skippedCount,
      scannedBytes,
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
      observedAt: now(),
    } satisfies Observation
  })

  const observationStillCurrent = Effect.fnUntraced(function* (observed: Observation) {
    for (const directory of observed.directories) {
      const info = yield* statOf(directory.abs)
      if (info === undefined || info.type !== "Directory" || info.mtimeMs !== directory.mtimeMs) return false
    }
    for (const file of observed.files) {
      const info = yield* statOf(file.abs)
      if (info === undefined || info.type !== "File" || info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
        return false
      }
    }
    return true
  })

  const promote = (key: string): CacheEntry | undefined => {
    const entry = cache.get(key)
    if (entry === undefined) return undefined
    cache.delete(key)
    entry.lastUsedAt = now()
    cache.set(key, entry)
    return entry
  }

  const evictOverflow = Effect.fnUntraced(function* () {
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) return
      const entry = cache.get(oldest)!
      cache.delete(oldest)
      if (backend.release) yield* backend.release(entry.handle).pipe(Effect.catch(() => Effect.void))
    }
  })

  const searchText = Effect.fn("RepoIntel.searchText")(function* (input: TextSearchInput) {
    const operation: Effect.Effect<RepoIntelTextResult, RepoIntelError> = Effect.gen(function* () {
      const queryError = validateQuery(input.query)
      if (queryError) return yield* queryError
      const limitError = validateMaxResults(input.maxResults ?? DEFAULT_MAX_RESULTS)
      if (limitError) return yield* limitError
      const normalized = normalizeSubpath(input.subpath ?? "")
      if ("error" in normalized) return yield* normalized.error
      const subpath = normalized.value
      const limits = resolveLimits(input.budget)
      const started = now()
      const root = yield* fs
        .resolve(input.scope.root)
        .pipe(
          Effect.mapError(
            (cause) => new RepoIntelError({ code: "failed", detail: `scope root ${input.scope.root}: ${cause}` }),
          ),
        )
      const observed = yield* collect({
        root,
        subpath,
        scope: input.scope,
        limits,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        started,
        deadline: started + limits.maxDurationMs,
      })
      const fingerprint = fingerprintOf(input.scope.scopeId, subpath, observed)
      const pins = derivePins(input.scope, subpath, fingerprint)
      const key = cacheKey(input.scope.scopeId, fingerprint)

      let entry = promote(key)
      if (entry === undefined) {
        const handle = yield* backend
          .build(
            pins,
            observed.files.map((file) => ({ path: file.rel, contents: file.contents })),
          )
          .pipe(Effect.mapError(mapBackendError))
        entry = { key, scopeId: input.scope.scopeId, handle, bytes: observed.scannedBytes, lastUsedAt: now() }
        cache.set(key, entry)
        yield* evictOverflow()
      }

      if (input.expectedGenerationId !== undefined && entry.handle.generationId !== input.expectedGenerationId) {
        return yield* new RepoIntelError({
          code: "stale_generation",
          detail: `expected ${input.expectedGenerationId}, current ${entry.handle.generationId}`,
        })
      }

      const request: RepoIntelBackendQuery = {
        operation: "text",
        query: input.query,
        maxResults: input.maxResults ?? DEFAULT_MAX_RESULTS,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      }
      const response = yield* backend.query(entry.handle, request).pipe(Effect.mapError(mapBackendError))
      const stillCurrent = yield* observationStillCurrent(observed)

      const truncation: TruncationReason[] = []
      if (response.truncatedBy !== undefined) truncation.push(response.truncatedBy)
      if (response.status === "UNAVAILABLE") truncation.push("unavailable")
      if (observed.stoppedBy !== undefined) truncation.push(observed.stoppedBy)
      if (observed.skippedCount > 0) truncation.push("skipped_files")

      const freshness: RepoIntelTextResult["freshness"] = !stillCurrent
        ? "stale"
        : truncation.length === 0
          ? "fresh"
          : "partial"

      return {
        operation: "text",
        status: response.status,
        freshness,
        ...(freshness === "stale" ? { staleReason: "source_changed" as const } : {}),
        generationId: response.generationId,
        matches: response.matches,
        ...(response.nextCursor !== undefined ? { nextCursor: response.nextCursor } : {}),
        ...(response.workUnits !== undefined ? { workUnits: response.workUnits } : {}),
        truncation,
        skipped: observed.skipped,
        skippedCount: observed.skippedCount,
        scanned: {
          files: observed.files.length,
          bytes: observed.scannedBytes,
          directories: observed.directories.length,
          durationMs: now() - started,
        },
        scopeId: input.scope.scopeId,
        subpath,
        observedAt: observed.observedAt,
      } satisfies RepoIntelTextResult
    })

    if (input.signal === undefined) return yield* operation
    return yield* operation.pipe(
      Effect.raceFirst(waitForAbort(input.signal)),
      Effect.mapError((error) =>
        error instanceof RepoIntelError ? error : new RepoIntelError({ code: "cancelled", detail: String(error) }),
      ),
    )
  })

  const invalidate = Effect.fn("RepoIntel.invalidate")(function* (scopeId: string) {
    let removed = 0
    for (const [key, entry] of [...cache.entries()]) {
      if (entry.scopeId !== scopeId) continue
      cache.delete(key)
      removed++
      if (backend.release) yield* backend.release(entry.handle).pipe(Effect.catch(() => Effect.void))
    }
    return removed
  })

  const stats = Effect.fn("RepoIntel.stats")(function* () {
    let bytes = 0
    for (const entry of cache.values()) bytes += entry.bytes
    return { entries: cache.size, bytes }
  })

  return { searchText, invalidate, stats }
}

/** Backend that fails closed until a real indexd transport is wired. */
export const unavailableBackend: RepoIntelBackend = {
  build: () => Effect.fail(new RepoIntelBackendError({ code: "unavailable", detail: "no RepoIntel backend is wired" })),
  query: () => Effect.fail(new RepoIntelBackendError({ code: "unavailable", detail: "no RepoIntel backend is wired" })),
}

export const layer = (backend: RepoIntelBackend, options?: { readonly maxEntries?: number }) =>
  Layer.effect(
    Service,
    Effect.map(FSUtil.Service, (fs) => make({ fs, backend, ...options })),
  )

export const unavailableLayer = layer(unavailableBackend)

export * as RepoIntel from "./repo-intel"
