/**
 * RepoIntel — authenticated structural client plus a legacy local-cache adapter.
 *
 * The product structural path uses `repoStructureClientFromSupervisor` below:
 * Core authenticates Session/Location, HostKernel owns the immutable generation and
 * indexd supplies bounded lexical candidates. The `make`/`RepoIntelBackend` API in
 * this file is a separate injectable local-cache adapter retained for isolated tests
 * and non-production callers; its generations are not the product cache owner and it
 * must not be wired as a second authoritative index. This module is deliberately not
 * a search engine:
 *
 * 1. it verifies the requested read scope before any filesystem read;
 * 2. it collects a bounded, UTF-8, indexd-legal snapshot set (`FileSnapshot`);
 * 3. it derives deterministic generation pins from the observed tree;
 * 4. it reuses a bounded in-memory generation cache keyed by (scope, observation);
 * 5. it relays one bounded query (text, symbol or references) through the injected
 *    `RepoIntelBackend` port, optionally against one exact-generation unsaved-buffer
 *    overlay from a trusted editor-buffer producer (none is wired in production yet);
 * 6. it re-verifies the observation and labels results fresh/partial/stale.
 *
 * Symbol and reference operations are relayed truthfully: while the wired backend is
 * the bounded lexical one, they return typed `UNAVAILABLE` with the backend's reason
 * and the adapter never fabricates symbol accuracy from lexical data.
 *
 * Invalidation lifecycle: `invalidate(scopeId)` fences generation reuse. It removes the
 * scope's cached generations, defers handle release until every in-flight user has
 * finished (a handle is never released under a live query), and any operation that
 * observes the invalidation before completing fails typed `stale_generation` instead
 * of returning results built from the invalidated observation. Cache-pressure
 * eviction releases in the same deferred way but does not fail in-flight queries.
 *
 * The local backend port mirrors the crate's legacy text-query API one call at a time
 * and is transport-agnostic. `RepoIntelBackendError` codes retain that API's typed
 * failures. Production structural queries use the distinct authenticated supervisor
 * adapter below; an unavailable local backend never triggers a filesystem or process
 * fallback.
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
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Location as LocationSchema } from "@horizoncode/schema"
import * as RepoIntelligenceSchema from "@horizoncode/schema/repo-intelligence-v1"
import type { Interface as SessionSupervisorInterface, SessionSupervisorError } from "@horizoncode/core/session/supervisor"
import { FSUtil } from "@horizoncode/core/fs-util"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { waitForAbort } from "@horizoncode/core/process"

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
export const DEFAULT_REPO_INTEL_CACHE_TTL_MS = 5 * 60_000
export const MAX_REPORTED_SKIPS = 64
export const DEFAULT_IGNORED_DIRECTORIES = [".git", "node_modules"] as const

// indexd overlay bounds (indexd/src/lib.rs). Keep byte-for-byte aligned.
export const MAX_OVERLAY_CHANGES = 128
export const MAX_OVERLAY_CONTENT_BYTES = 8_388_608
export const MAX_EDITOR_VERSION_BYTES = 4_096

export type RepoIntelOperation = "text" | "symbol" | "references" | "impact" | "expand"

export type RepoIntelErrorCode =
  | "scope_denied"
  | "not_found"
  | "invalid_query"
  | "query_too_large"
  | "multiline_query"
  | "invalid_result_limit"
  | "invalid_overlay"
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
    "invalid_overlay",
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

/**
 * One caller-supplied unsaved-buffer change for a generation-bound overlay.
 * `contents: null` clears the path back to the base bytes. A path must exist in
 * the exact collected generation.
 */
export interface RepoIntelOverlayChange {
  readonly path: string
  readonly contents: string | Uint8Array | null
}

export interface RepoIntelOverlayInput {
  /** Trusted producer's immutable editor/buffer version; model/request values are not accepted. */
  readonly editorVersion: string
  /** Internal service seam only; production requires an authenticated Core producer. */
  readonly changes: ReadonlyArray<RepoIntelOverlayChange>
}

export interface RepoIntelOverlayHandle {
  readonly overlayDigest: string
}

/** Transport-shaped overlay change handed to the backend port. */
export interface RepoIntelBackendOverlayChange {
  readonly path: string
  readonly contents: Uint8Array | null
}

export interface RepoIntelBackendOverlay {
  readonly editorVersion: string
  readonly changes: ReadonlyArray<RepoIntelBackendOverlayChange>
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
  readonly overlay?: RepoIntelOverlayHandle
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
  readonly overlayDigest?: string
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
  /**
   * Optional exact-generation overlay construction. A backend that cannot build
   * overlays must omit this method; the adapter then fails closed with
   * `backend_unavailable` rather than ignoring the requested overlay.
   */
  readonly buildOverlay?: (
    handle: RepoIntelGenerationHandle,
    overlay: RepoIntelBackendOverlay,
  ) => Effect.Effect<RepoIntelOverlayHandle, RepoIntelBackendError>
  readonly releaseOverlay?: (overlay: RepoIntelOverlayHandle) => Effect.Effect<void>
}

/**
 * Typed call boundary for an injected internal HostKernel/indexd implementation.
 * This is deliberately not the binary frame codec or the JSON/base64 RPC adapter:
 * Rust remains the single GenerationPack/frame encoder, and callers must not
 * install this transport as the production default until the bounded HostKernel
 * bridge is implemented and verified.
 */
export type RepoIntelTransportCall =
  | { readonly operation: "build"; readonly pins: RepoIntelPins; readonly snapshots: ReadonlyArray<RepoIntelSnapshot> }
  | {
      readonly operation: "build_overlay"
      readonly generationId: string
      readonly overlay: RepoIntelBackendOverlay
    }
  | { readonly operation: "query"; readonly generationId: string; readonly request: RepoIntelBackendQuery }
  | { readonly operation: "release_generation"; readonly generationId: string }
  | { readonly operation: "release_overlay"; readonly overlayDigest: string }

/**
 * `exchange` returns an unknown response on purpose: the adapter treats the
 * HostKernel boundary as hostile and checks the response kind and bindings at
 * runtime. Interruption of this Effect must cancel the underlying bridge request.
 */
export interface RepoIntelTransport {
  readonly exchange: (call: RepoIntelTransportCall) => Effect.Effect<unknown, RepoIntelBackendError>
}

/** Out-of-body HostKernel identity references supplied by the trusted Core caller. */
export interface RepoStructureRequestV1 {
  readonly sessionID: string
  readonly locationRef: typeof LocationSchema.Ref.Type
  readonly query: Omit<RepoIntelligenceSchema.RepoStructureQueryV1, "sourceGeneration">
  /** Trusted profile projection; not part of the model-authored query DTO. */
  readonly analysisProfile: RepoIntelAnalysisProfileState
}

/** Structural page plus the trusted profile decision used to serve the request.
 * This control-plane provenance does not grant mutation authority. */
export interface RepoIntelStructureResultV1 {
  readonly page: RepoIntelligenceSchema.RepoStructurePageV1
  readonly analysisProfile: RepoIntelAnalysisProfileState
}

/** Core's authenticated SessionSupervisor producer for structural RepoIntel pages. */
export interface RepoStructureTransport<R = never> {
  /** Core performs ensure_generation→query_structure and cancels on interruption. */
  readonly query: (input: RepoStructureRequestV1) => Effect.Effect<unknown, RepoIntelBackendError, R>
}

export interface RepoStructureClient<R = never> {
  readonly query: (input: RepoStructureRequestV1) => Effect.Effect<RepoIntelligenceSchema.RepoStructurePageV1, RepoIntelBackendError, R>
}

const structureTransportRejected = (detail: string) =>
  new RepoIntelBackendError({ code: "rejected", detail })

const FIRST_PAGE_SOURCE_GENERATION_PLACEHOLDER = `blake3:${"0".repeat(64)}`

const validateStructureRequestQuery = (
  query: RepoStructureRequestV1["query"],
): RepoIntelBackendError | undefined => {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    return structureTransportRejected("RepoIntel query does not match the strict query schema")
  }
  if (Object.prototype.hasOwnProperty.call(query, "sourceGeneration")) {
    return structureTransportRejected("RepoIntel query must not carry caller-supplied sourceGeneration")
  }
  if (query.cursor !== undefined) {
    try {
      Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoStructureCursorLeaseRefV1)(query.cursor)
    } catch {
      return structureTransportRejected("RepoIntel continuation cursor is malformed")
    }
  }
  const candidate = query.cursor === undefined
    ? { ...query, sourceGeneration: FIRST_PAGE_SOURCE_GENERATION_PLACEHOLDER }
    : query
  try {
    Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoStructureQueryV1, { onExcessProperty: "error" })(candidate)
  } catch {
    return structureTransportRejected("RepoIntel query does not match the strict query schema")
  }
  return undefined
}

/**
 * Strict consumer for `repo-intel.v1/query_structure`. Identity metadata is
 * passed to the transport out-of-body; only the canonical query DTO is serialized
 * as the RPC body. The HostKernel remains responsible for validating registered
 * Session/Location, Guard read scope, current revision, and opaque cursor binding.
 */
export const repoStructureClientFromTransport = <R>(transport: RepoStructureTransport<R>): RepoStructureClient<R> => ({
  query: (input) =>
    Effect.gen(function* () {
      if (!isRecord(input)) {
        return yield* structureTransportRejected("RepoIntel request envelope is malformed")
      }
      if (typeof input.sessionID !== "string" || !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) {
        return yield* structureTransportRejected("RepoIntel Session ID is malformed")
      }
      const invalidQuery = validateStructureRequestQuery(input.query)
      if (invalidQuery) return yield* Effect.fail(invalidQuery)

      const raw = yield* transport.query(input)
      const page = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoStructurePageV1, { onExcessProperty: "error" })(raw),
        catch: () => structureTransportRejected("HostKernel returned a malformed RepoIntel page"),
      })
      if (page.queryId !== input.query.queryId) {
        return yield* Effect.fail(structureTransportRejected("RepoIntel page queryId does not match request"))
      }
      if (page.status === "STALE" || page.freshness === "stale") {
        return yield* Effect.fail(
          new RepoIntelBackendError({
            code: "generation_mismatch",
            detail: "RepoIntel page is stale; refusing to return it as a current result",
          }),
        )
      }
      if (input.query.overlayRef === undefined) {
        if (page.overlayDigest !== undefined || page.nodes.some((node) => node.overlayDigest !== undefined)) {
          return yield* Effect.fail(structureTransportRejected("base query returned overlay provenance"))
        }
      } else if (page.overlayDigest === undefined) {
        return yield* Effect.fail(
          structureTransportRejected("overlay query returned no overlay digest; refusing a base-only downgrade"),
        )
      }
      if (
        page.nodes.length > input.query.maxNodes ||
        BigInt(page.coverage.files) > 4096n ||
        BigInt(page.coverage.nodes) !== BigInt(page.nodes.length) ||
        BigInt(page.coverage.bytes) > BigInt(input.query.maxBytes) ||
        Buffer.byteLength(JSON.stringify(page), "utf8") > input.query.maxBytes
      ) {
        return yield* Effect.fail(structureTransportRejected("RepoIntel page exceeds or misreports query bounds"))
      }
      // A continuation token is useful only when the authenticated host has
      // actually made bounded progress. Never allow a malformed adapter to
      // return the caller's token unchanged and create an infinite page loop.
      // Cursor authority and owner/generation binding remain HostKernel-owned.
      if (page.nextCursor !== undefined) {
        const cursorBytes = Buffer.byteLength(page.nextCursor, "utf8")
        if (
          cursorBytes === 0 ||
          cursorBytes > RepoIntelligenceSchema.MAX_STRUCTURE_CURSOR_BYTES ||
          page.nextCursor === input.query.cursor ||
          page.nodes.length === 0 ||
          page.nodes.length !== input.query.maxNodes ||
          page.status !== "PARTIAL" ||
          page.freshness !== "current" ||
          page.completeness !== "partial"
        ) {
          return yield* Effect.fail(
            structureTransportRejected(
              "RepoIntel continuation cursor is invalid: only a full current page with a proven continuation may carry one",
            ),
          )
        }
      }
      return page
    }),
})

/** Adapt only the trusted Core SessionSupervisor API; this module never sends
 * identity context or query bodies directly to HostKernel. */
export const repoStructureClientFromSupervisor = (
  supervisor: Pick<SessionSupervisorInterface, "queryRepoStructure">,
): RepoStructureClient<import("@horizoncode/core/trusted-principal").TrustedPrincipalContext> =>
  repoStructureClientFromTransport({
    query: (input) => {
      if (!supervisor.queryRepoStructure) {
        return Effect.fail(new RepoIntelBackendError({ code: "unavailable", detail: "Core RepoIntel read API is unavailable" }))
      }
      return supervisor.queryRepoStructure(input).pipe(
        Effect.mapError((error: SessionSupervisorError) =>
          new RepoIntelBackendError({
            code:
              error.hostCode === "stale_repo_generation"
                ? "generation_mismatch"
                : error.hostCode === "capability_unavailable" || error.hostCode === "overlay_unavailable" || error.stage === "host-kernel-feature"
                  ? "unavailable"
                  : "rejected",
            detail: error.message,
          }),
        ),
      )
    },
  })

export interface RepoIntelSourceStat {
  readonly type: "File" | "Directory" | "Other"
  readonly size: number
  readonly mtimeMs: number
}

export interface RepoIntelSourceFile {
  readonly stat: RepoIntelSourceStat
  readonly contents?: Uint8Array
  readonly tooLarge?: true
}

/**
 * Filesystem access rooted in an open, pinned repository directory. Implementations
 * must not read source bytes until open-time containment has been verified.
 */
export interface RepoIntelSourceRoot {
  readonly stat: (rel: string) => Effect.Effect<RepoIntelSourceStat | undefined>
  /** Directory traversal must stop before materializing more than this many entries. */
  readonly readDirectoryEntriesBounded: (
    rel: string,
    maxEntries: number,
  ) => Effect.Effect<{ readonly entries: ReadonlyArray<FSUtil.DirEntry>; readonly truncated: boolean } | undefined>
  readonly readFile: (rel: string, maxBytes: number) => Effect.Effect<RepoIntelSourceFile | undefined>
  readonly close: Effect.Effect<void>
}

export interface RepoIntelSource {
  readonly openRoot: (root: string) => Effect.Effect<RepoIntelSourceRoot, RepoIntelError>
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

export type RepoIntelAnalysisProfile = "lightweight" | "adaptive" | "full"

/** Raw requested/effective values from the trusted configuration owner. */
export interface RepoIntelProfileResolution {
  readonly requested?: unknown
  readonly effective?: unknown
  readonly configurationSource?: unknown
  /** Owner of the effective projection, never caller/model supplied. */
  readonly effectiveSource?: unknown
  readonly policyLock?: unknown
  /** Why the requested mode was narrowed or cannot currently be served. */
  readonly reason?: unknown
}

/** Trusted Core/P6 requested→effective projection consumed alongside a query.
 * It stays out of RepoStructureQueryV1: model parameters cannot select an
 * analysis profile or smuggle one into HostKernel authority. */
export interface RepoIntelProfileProjectionV1 {
  readonly requested: RepoIntelAnalysisProfile
  readonly effective: RepoIntelAnalysisProfile
  readonly configurationSource: "default" | "user" | "project" | "system_policy" | "unknown"
  readonly effectiveSource: "default" | "settings" | "platform" | "policy" | "resource" | "unknown"
  readonly policyLock: "locked" | "unlocked" | "unknown"
  readonly reason?: RepoIntelProfileReason
}

/** Validated profile provenance attached to every query result. */
export interface RepoIntelAnalysisProfileState {
  readonly requested: RepoIntelAnalysisProfile
  readonly effective: RepoIntelAnalysisProfile
  readonly configurationSource: "default" | "user" | "project" | "system_policy" | "unknown"
  readonly effectiveSource: "default" | "settings" | "platform" | "policy" | "resource" | "unknown"
  readonly policyLock: "locked" | "unlocked" | "unknown"
  readonly reason?:
    | "policy_restriction"
    | "platform_unavailable"
    | "resource_pressure"
    | "feature_unavailable"
    | "invalid_configuration"
}

export type RepoIntelProfileReason = NonNullable<RepoIntelAnalysisProfileState["reason"]>

export const DEFAULT_ANALYSIS_PROFILE: RepoIntelAnalysisProfileState = {
  requested: "lightweight",
  effective: "lightweight",
  configurationSource: "default",
  effectiveSource: "default",
  policyLock: "unlocked",
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
export type CollectionStop = "deadline" | "file_limit" | "byte_limit" | "path_limit" | "directory_limit" | "entry_limit"
export type TruncationReason = "result_limit" | "work_limit" | "unavailable" | CollectionStop | "skipped_files"

export interface TextSearchInput {
  readonly scope: ReadScope
  /** Directory or file relative to `scope.root`. Defaults to the root itself. */
  readonly subpath?: string
  readonly query: string
  readonly maxResults?: number
  readonly cursor?: string
  readonly expectedGenerationId?: string
  /** Optional trusted producer snapshot; no production editor-buffer producer is wired yet. */
  readonly overlay?: RepoIntelOverlayInput
  readonly budget?: SearchBudget
  readonly signal?: AbortSignal
}

export interface RepoIntelTextResult {
  readonly operation: RepoIntelOperation
  readonly analysisProfile: RepoIntelAnalysisProfileState
  readonly status: "PARTIAL" | "UNAVAILABLE"
  /** Truthful indexing mode; lexical matches are never presented as AST symbols. */
  readonly sourceKind: "lexical" | "structural" | "none" | "unknown"
  /** Completeness of the collected/indexed source set for this query. */
  readonly coverage: "complete" | "partial" | "none"
  /** Why a requested structural query fell back to no result, when applicable. */
  readonly fallback?: "structural_parser_unavailable"
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
  /** Present only when an overlay was applied to this query. */
  readonly overlay?: { readonly editorVersion: string; readonly digest: string }
  readonly unavailableReason?: { readonly operation: RepoIntelOperation }
}

export interface Interface {
  readonly searchText: (input: TextSearchInput) => Effect.Effect<RepoIntelTextResult, RepoIntelError>
  /**
   * Symbol query relayed to the RepoIntel backend. The bounded lexical backend
   * reports typed `UNAVAILABLE`; this adapter never guesses symbol accuracy.
   */
  readonly searchSymbols: (input: TextSearchInput) => Effect.Effect<RepoIntelTextResult, RepoIntelError>
  readonly findReferences: (input: TextSearchInput) => Effect.Effect<RepoIntelTextResult, RepoIntelError>
  readonly invalidate: (scopeId: string) => Effect.Effect<number>
  /** Internal owner-only callback: evict one idle, rebuildable generation after its pins drain. */
  readonly evictGeneration: (scopeId: string, generationId: string) => Effect.Effect<{
    readonly status: "evicted" | "blocked_pinned" | "not_found"
    /** Backend release is not a memory measurement; this is always unknown here. */
    readonly reclaimedBytes: null
  }>
  readonly stats: () => Effect.Effect<{
    readonly entries: number
    readonly bytes: number
    readonly inFlightBuilds: number
    readonly buildWaiters: number
  }>
}

/** Cache-owner telemetry from the existing RepoIntel LRU. These are source-byte
 * accounting values, not a claim about physical index memory or reclaimed RAM. */
export interface RepoIntelCacheOwnerObservationV1 {
  readonly event: "register" | "use" | "pin" | "unpin" | "evict" | "release"
  readonly family: "repo-intel-generation"
  readonly cacheKey: string
  readonly scopeId: string
  /** Opaque owner-bound read-scope digest, not a principal credential. */
  readonly ownerScopeDigest: string
  readonly repository?: string
  readonly workspace?: string
  readonly sourceGeneration: string
  readonly sourceRevisionSet: string
  readonly readPolicyDigest: string
  readonly buildVersion: string
  readonly accountedSourceBytes: number
  readonly entryCount: number
  readonly totalAccountedSourceBytes: number
  readonly maxEntries: number
  readonly maxAccountedSourceBytes: number
  readonly ttlMs: number
  readonly lastUsedAt: number
  readonly pinCount: number
  readonly protection: "pinned" | "rebuildable"
  readonly reclaimedBytes: null
}

export class Service extends Context.Service<Service, Interface>()("@horizoncode/RepoIntel") {}

interface CollectedFile {
  readonly rel: string
  readonly contents: Uint8Array
  readonly size: number
  readonly mtimeMs: number
}

interface CollectedDirectory {
  readonly rel: string
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

type EntryRetirement = "none" | "invalidated" | "evicted"

interface CacheEntry {
  readonly key: string
  readonly scopeId: string
  readonly pins: RepoIntelPins
  readonly handle: RepoIntelGenerationHandle
  readonly bytes: number
  lastUsedAt: number
  inflight: number
  retired: EntryRetirement
  releasePending: boolean
  released: boolean
}

interface BuildFlight {
  readonly scopeId: string
  readonly epoch: number
  readonly result: Deferred.Deferred<CacheEntry, RepoIntelError>
  waiters: number
  done: boolean
  entry?: CacheEntry
  fiber?: Fiber.Fiber<void>
}

// This is resource-lifetime sharing, not generic memoization. Effect.cached runs
// the first evaluation in its caller's fiber and caches that Exit, so cancelling
// that caller can publish an Interrupted result to every waiter. A detached
// worker + Deferred lets each waiter leave independently; the refcount interrupts
// the worker only when the final waiter leaves. The flight is also epoch-bound,
// so invalidation cannot hand a fresh caller a build from the retired observation.

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

const procFdPath = (fd: number) => `/proc/self/fd/${fd}`

const sourceStat = (info: Awaited<ReturnType<fs.FileHandle["stat"]>>): RepoIntelSourceStat => ({
  type: info.isFile() ? "File" : info.isDirectory() ? "Directory" : "Other",
  size: Number(info.size),
  mtimeMs: Number(info.mtimeMs),
})

/**
 * Node's FileSystem abstraction intentionally has no descriptor-relative/no-follow
 * open primitive. On Linux, anchor every descendant lookup to a pinned root FD,
 * reject any opened FD whose resolved path is not the exact expected descendant,
 * and read only from that already-verified FD. Other platforms fail closed.
 */
export const nodeSource: RepoIntelSource = {
  openRoot: (rootPath) =>
    Effect.tryPromise({
      try: async () => {
        if (process.platform !== "linux") throw new Error("descriptor-rooted RepoIntel reads require Linux procfs")

        const rootHandle = await fs.open(
          rootPath,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        )
        try {
          const actualRoot = await fs.realpath(procFdPath(rootHandle.fd))
          if (actualRoot !== rootPath || !(await rootHandle.stat()).isDirectory()) {
            throw new Error("the opened repository root does not match the admitted root")
          }
          const rootFdPath = procFdPath(rootHandle.fd)

          const openEntry = async (rel: string, flags: number): Promise<fs.FileHandle | undefined> => {
            if (!isIndexdRelativePath(rel)) return undefined
            let handle: fs.FileHandle | undefined
            try {
              handle = await fs.open(`${rootFdPath}/${rel}`, flags | fsConstants.O_NOFOLLOW)
              const actual = await fs.realpath(procFdPath(handle.fd))
              const expected = path.resolve(rootPath, ...rel.split("/"))
              if (actual !== expected) {
                await handle.close()
                return undefined
              }
              return handle
            } catch {
              if (handle) await handle.close().catch(() => {})
              return undefined
            }
          }

          const withEntry = async <A>(
            rel: string,
            flags: number,
            use: (handle: fs.FileHandle) => Promise<A | undefined>,
          ): Promise<A | undefined> => {
            const handle = rel === "" ? rootHandle : await openEntry(rel, flags)
            if (!handle) return undefined
            try {
              return await use(handle)
            } catch {
              return undefined
            } finally {
              if (handle !== rootHandle) await handle.close().catch(() => {})
            }
          }

          return {
            stat: (rel) =>
              Effect.promise(() =>
                withEntry(rel, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK, async (handle) =>
                  sourceStat(await handle.stat()),
                ),
              ),
            readDirectoryEntriesBounded: (rel, maxEntries) =>
              Effect.promise(() =>
                withEntry(rel, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY, async (handle) => {
                  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) return undefined
                  const directory = await fs.opendir(procFdPath(handle.fd))
                  const entries: FSUtil.DirEntry[] = []
                  let truncated = false
                  try {
                    while (entries.length <= maxEntries) {
                      const entry = await directory.read()
                      if (!entry) break
                      if (entries.length === maxEntries) {
                        truncated = true
                        break
                      }
                      entries.push({
                        name: entry.name,
                        type: entry.isDirectory()
                          ? "directory"
                          : entry.isFile()
                            ? "file"
                            : entry.isSymbolicLink()
                              ? "symlink"
                              : "other",
                      })
                    }
                    return { entries, truncated }
                  } finally {
                    try {
                      await directory.close()
                    } catch {
                      // Closing an already-read directory is best-effort across Bun and Node.
                    }
                  }
                }),
              ),
            readFile: (rel, maxBytes) =>
              Effect.promise(() =>
                withEntry(rel, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK, async (handle) => {
                  const before = await handle.stat()
                  const stat = sourceStat(before)
                  if (stat.type !== "File") return undefined
                  if (stat.size > maxBytes) return { stat, tooLarge: true as const }

                  const buffer = Buffer.allocUnsafe(maxBytes + 1)
                  let bytesRead = 0
                  while (bytesRead < buffer.length) {
                    const read = await handle.read(
                      buffer,
                      bytesRead,
                      Math.min(64 * 1024, buffer.length - bytesRead),
                      bytesRead,
                    )
                    if (read.bytesRead === 0) break
                    bytesRead += read.bytesRead
                  }
                  if (bytesRead > maxBytes) return { stat, tooLarge: true as const }
                  return { stat, contents: buffer.subarray(0, bytesRead) }
                }),
              ),
            close: Effect.promise(async () => {
              await rootHandle.close().catch(() => {})
            }),
          } satisfies RepoIntelSourceRoot
        } catch (error) {
          await rootHandle.close().catch(() => {})
          throw error
        }
      },
      catch: (cause) =>
        new RepoIntelError({
          code: "backend_unavailable",
          detail: `secure RepoIntel source access unavailable: ${String(cause)}`,
        }),
    }),
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

interface ValidatedOverlay {
  readonly editorVersion: string
  readonly changes: ReadonlyArray<RepoIntelBackendOverlayChange>
  readonly totalBytes: number
}

/**
 * Validate caller-supplied overlay changes against one collected generation before
 * the backend sees them. Mirrors indexd's overlay bounds: a path must be a
 * normalized relative path present in the base, at most 128 changes, 8 MiB of
 * replacement bytes, 1 MiB per file, UTF-8 contents, no duplicate paths.
 */
const validateOverlayInput = (
  input: RepoIntelOverlayInput,
  observed: ReadonlySet<string>,
): { readonly value: ValidatedOverlay } | { readonly error: RepoIntelError } => {
  const rejected = (detail: string) => ({ error: new RepoIntelError({ code: "invalid_overlay", detail }) })
  const editorBytes = Buffer.byteLength(input.editorVersion, "utf-8")
  if (editorBytes === 0 || editorBytes > MAX_EDITOR_VERSION_BYTES) {
    return rejected(`editor version must be 1..${MAX_EDITOR_VERSION_BYTES} UTF-8 bytes`)
  }
  if (input.changes.length === 0) return rejected("overlay must contain at least one change")
  if (input.changes.length > MAX_OVERLAY_CHANGES) {
    return rejected(`overlay exceeds ${MAX_OVERLAY_CHANGES} changes`)
  }
  const seen = new Set<string>()
  const changes: RepoIntelBackendOverlayChange[] = []
  let totalBytes = 0
  for (const change of input.changes) {
    if (!isIndexdRelativePath(change.path) || !observed.has(change.path)) {
      return rejected(`overlay path is not in the collected generation: ${change.path}`)
    }
    if (seen.has(change.path)) return rejected(`duplicate overlay change path: ${change.path}`)
    seen.add(change.path)
    if (change.contents === null) {
      changes.push({ path: change.path, contents: null })
      continue
    }
    // Freeze the validated bytes: the caller keeps ownership of the buffer it
    // handed in (an editor producer may reuse it), so the backend must operate on
    // a copy of exactly what was validated, never on live caller memory.
    const bytes =
      typeof change.contents === "string"
        ? new Uint8Array(Buffer.from(change.contents, "utf-8"))
        : change.contents instanceof Uint8Array
          ? new Uint8Array(change.contents)
          : undefined
    if (bytes === undefined) {
      return rejected(`overlay contents must be text or bytes: ${change.path}`)
    }
    if (bytes.length > MAX_FILE_BYTES) return rejected(`overlay file exceeds ${MAX_FILE_BYTES} bytes: ${change.path}`)
    if (decodeUtf8Strict(bytes) === undefined) {
      return rejected(`overlay contents are not UTF-8 text: ${change.path}`)
    }
    totalBytes += bytes.length
    if (totalBytes > MAX_OVERLAY_CONTENT_BYTES) {
      return rejected(`overlay exceeds ${MAX_OVERLAY_CONTENT_BYTES} replacement bytes`)
    }
    changes.push({ path: change.path, contents: bytes })
  }
  return { value: { editorVersion: input.editorVersion, changes, totalBytes } }
}

const pinDigest = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex")

const cacheKey = (scopeId: string, fingerprint: string, pins: RepoIntelPins) =>
  `${scopeId}\u0000${fingerprint}\u0000${JSON.stringify(pins)}`

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
  for (const file of observed.files) {
    hash.update(`f\u0000${file.rel}\u0000${file.size}\u0000${file.mtimeMs}\u0000`)
    hash.update(createHash("sha256").update(file.contents).digest())
    hash.update("\u0000")
  }
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
    case "overlay_generation_mismatch":
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isAnalysisProfile = (value: unknown): value is RepoIntelAnalysisProfile =>
  value === "lightweight" || value === "adaptive" || value === "full"

const ANALYSIS_PROFILE_RANK: Record<RepoIntelAnalysisProfile, number> = {
  lightweight: 0,
  adaptive: 1,
  full: 2,
}

export const resolveAnalysisProfile = (value: unknown): RepoIntelAnalysisProfileState => {
  const resolution = isRecord(value) ? value : undefined
  if (resolution === undefined) return DEFAULT_ANALYSIS_PROFILE
  const requestedValid = isAnalysisProfile(resolution.requested)
  const effectiveValid = isAnalysisProfile(resolution.effective)
  const requested = isAnalysisProfile(resolution?.requested) ? resolution.requested : "lightweight"
  const unauthenticatedPressureClaim =
    resolution?.effectiveSource === "resource" || resolution?.reason === "resource_pressure"
  const candidate = unauthenticatedPressureClaim
    ? requested
    : isAnalysisProfile(resolution?.effective)
      ? resolution.effective
      : "lightweight"
  const overRequested = ANALYSIS_PROFILE_RANK[candidate] > ANALYSIS_PROFILE_RANK[requested]
  const effective = ANALYSIS_PROFILE_RANK[candidate] <= ANALYSIS_PROFILE_RANK[requested] ? candidate : requested
  const effectiveSource = unauthenticatedPressureClaim
    ? "unknown"
    : resolution?.effectiveSource === "default" ||
        resolution?.effectiveSource === "settings" ||
        resolution?.effectiveSource === "platform" ||
        resolution?.effectiveSource === "policy" ||
        resolution?.effectiveSource === "resource" ||
        resolution?.effectiveSource === "unknown"
      ? resolution.effectiveSource
      : "default"
  const configurationSource =
    resolution?.configurationSource === "default" ||
    resolution?.configurationSource === "user" ||
    resolution?.configurationSource === "project" ||
    resolution?.configurationSource === "system_policy" ||
    resolution?.configurationSource === "unknown"
      ? resolution.configurationSource
      : "unknown"
  const policyLock =
    resolution?.policyLock === "locked" || resolution?.policyLock === "unlocked" || resolution?.policyLock === "unknown"
      ? resolution.policyLock
      : "unknown"
  const allowedReasons: ReadonlyArray<RepoIntelProfileReason> = [
    "policy_restriction",
    "platform_unavailable",
    "feature_unavailable",
    "invalid_configuration",
  ]
  const reason = allowedReasons.includes(resolution?.reason as RepoIntelProfileReason)
    ? (resolution?.reason as RepoIntelProfileReason)
    : !requestedValid || !effectiveValid || overRequested
      ? "invalid_configuration"
      : effective !== requested
        ? "feature_unavailable"
        : undefined
  return {
    requested,
    effective,
    configurationSource,
    effectiveSource,
    policyLock,
    ...(reason !== undefined ? { reason } : {}),
  }
}

const isBlake3Digest = (value: unknown): value is string =>
  typeof value === "string" && /^blake3:[0-9a-f]{64}$/.test(value)

const isOperation = (value: unknown): value is RepoIntelOperation =>
  value === "text" || value === "symbol" || value === "references" || value === "impact" || value === "expand"

const bridgeRejected = (detail: string) => new RepoIntelBackendError({ code: "rejected", detail })

const validateTransportPins = (pins: RepoIntelPins): RepoIntelBackendError | undefined => {
  const values = [
    pins.repository,
    ...(pins.workspace === undefined ? [] : [pins.workspace]),
    pins.revisionSet,
    pins.readScope,
    pins.readPolicy,
    pins.sourceReceipt,
    pins.parserSet,
  ]
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf-8") === 0 ||
        Buffer.byteLength(value, "utf-8") > 4_096,
    )
  ) {
    return bridgeRejected("opaque pins must contain 1..=4096 UTF-8 bytes")
  }
}

const validateTransportSnapshots = (snapshots: ReadonlyArray<RepoIntelSnapshot>): RepoIntelBackendError | undefined => {
  if (snapshots.length > MAX_BASE_FILES) {
    return new RepoIntelBackendError({ code: "too_many_base_files", detail: `limit is ${MAX_BASE_FILES}` })
  }
  const paths = new Set<string>()
  let contentBytes = 0
  let pathBytes = 0
  for (const snapshot of snapshots) {
    if (!isIndexdRelativePath(snapshot.path)) {
      return new RepoIntelBackendError({ code: "invalid_path", detail: snapshot.path })
    }
    if (paths.has(snapshot.path)) {
      return new RepoIntelBackendError({ code: "duplicate_path", detail: snapshot.path })
    }
    paths.add(snapshot.path)
    pathBytes += Buffer.byteLength(snapshot.path, "utf-8")
    if (pathBytes > MAX_BASE_PATH_BYTES) {
      return new RepoIntelBackendError({ code: "base_path_limit", detail: `limit is ${MAX_BASE_PATH_BYTES}` })
    }
    if (!(snapshot.contents instanceof Uint8Array)) {
      return bridgeRejected(`snapshot contents must be bytes: ${snapshot.path}`)
    }
    if (snapshot.contents.byteLength > MAX_FILE_BYTES) {
      return new RepoIntelBackendError({ code: "file_too_large", detail: snapshot.path })
    }
    if (decodeUtf8Strict(snapshot.contents) === undefined) {
      return new RepoIntelBackendError({ code: "invalid_utf8", detail: snapshot.path })
    }
    contentBytes += snapshot.contents.byteLength
    if (contentBytes > MAX_BASE_CONTENT_BYTES) {
      return new RepoIntelBackendError({ code: "base_content_limit", detail: `limit is ${MAX_BASE_CONTENT_BYTES}` })
    }
  }
}

const validateTransportQuery = (request: RepoIntelBackendQuery): RepoIntelBackendError | undefined => {
  const queryBytes = Buffer.byteLength(request.query, "utf-8")
  if (queryBytes === 0) return new RepoIntelBackendError({ code: "empty_query" })
  if (queryBytes > MAX_QUERY_BYTES) {
    return new RepoIntelBackendError({ code: "query_too_large", detail: `limit is ${MAX_QUERY_BYTES}` })
  }
  if (request.query.includes("\n") || request.query.includes("\r")) {
    return new RepoIntelBackendError({ code: "multiline_query" })
  }
  if (!Number.isInteger(request.maxResults) || request.maxResults < 1 || request.maxResults > MAX_QUERY_RESULTS) {
    return new RepoIntelBackendError({ code: "invalid_result_limit", detail: `limit is 1..=${MAX_QUERY_RESULTS}` })
  }
  if (request.cursor !== undefined && Buffer.byteLength(request.cursor, "utf-8") > MAX_SEARCH_CURSOR_BYTES) {
    return new RepoIntelBackendError({ code: "invalid_search_cursor", detail: "cursor exceeds the byte limit" })
  }
  if (request.overlay !== undefined && !isBlake3Digest(request.overlay.overlayDigest)) {
    return bridgeRejected("overlay digest is not a tagged BLAKE3 digest")
  }
}

const validateTransportOverlay = (overlay: RepoIntelBackendOverlay): RepoIntelBackendError | undefined => {
  const editorBytes = Buffer.byteLength(overlay.editorVersion, "utf-8")
  if (editorBytes === 0 || editorBytes > MAX_EDITOR_VERSION_BYTES) {
    return bridgeRejected(`editor version must be 1..=${MAX_EDITOR_VERSION_BYTES} UTF-8 bytes`)
  }
  if (overlay.changes.length === 0 || overlay.changes.length > MAX_OVERLAY_CHANGES) {
    return bridgeRejected(`overlay change count must be 1..=${MAX_OVERLAY_CHANGES}`)
  }
  const paths = new Set<string>()
  let replacementBytes = 0
  for (const change of overlay.changes) {
    if (!isIndexdRelativePath(change.path)) {
      return new RepoIntelBackendError({ code: "invalid_path", detail: change.path })
    }
    if (paths.has(change.path)) {
      return bridgeRejected(`duplicate overlay path: ${change.path}`)
    }
    paths.add(change.path)
    if (change.contents === null) continue
    if (!(change.contents instanceof Uint8Array)) {
      return bridgeRejected(`overlay contents must be bytes: ${change.path}`)
    }
    if (change.contents.byteLength > MAX_FILE_BYTES) {
      return new RepoIntelBackendError({ code: "file_too_large", detail: change.path })
    }
    if (decodeUtf8Strict(change.contents) === undefined) {
      return new RepoIntelBackendError({ code: "invalid_utf8", detail: change.path })
    }
    replacementBytes += change.contents.byteLength
    if (replacementBytes > MAX_OVERLAY_CONTENT_BYTES) {
      return bridgeRejected(`overlay replacement bytes exceed ${MAX_OVERLAY_CONTENT_BYTES}`)
    }
  }
}

const decodeTransportQuery = (
  response: unknown,
  generationId: string,
  request: RepoIntelBackendQuery,
): Effect.Effect<RepoIntelBackendResult, RepoIntelBackendError> => {
  if (!isRecord(response) || response.operation !== "query" || !isRecord(response.result)) {
    return Effect.fail(bridgeRejected("malformed query response envelope"))
  }
  const result = response.result
  if (result.generationId !== generationId) {
    return Effect.fail(
      new RepoIntelBackendError({
        code: "generation_mismatch",
        detail: "query response generation does not match request",
      }),
    )
  }
  if (!isBlake3Digest(result.generationId)) {
    return Effect.fail(bridgeRejected("query response has an invalid generation digest"))
  }
  if (result.status !== "PARTIAL" && result.status !== "UNAVAILABLE") {
    return Effect.fail(bridgeRejected("query response has an invalid status"))
  }
  if (!Array.isArray(result.matches) || result.matches.length > MAX_QUERY_RESULTS) {
    return Effect.fail(bridgeRejected("query response has an invalid match list"))
  }
  for (const match of result.matches) {
    if (
      !isRecord(match) ||
      typeof match.path !== "string" ||
      !isIndexdRelativePath(match.path) ||
      typeof match.startLine !== "number" ||
      !Number.isSafeInteger(match.startLine) ||
      (match.startLine as number) < 1 ||
      typeof match.endLine !== "number" ||
      !Number.isSafeInteger(match.endLine) ||
      (match.endLine as number) < (match.startLine as number)
    ) {
      return Effect.fail(bridgeRejected("query response contains a malformed match"))
    }
  }
  if (request.overlay === undefined) {
    if (result.overlayDigest !== undefined) {
      return Effect.fail(
        new RepoIntelBackendError({ code: "overlay_generation_mismatch", detail: "unexpected overlay digest" }),
      )
    }
  } else if (result.overlayDigest !== request.overlay.overlayDigest) {
    return Effect.fail(
      new RepoIntelBackendError({
        code: "overlay_generation_mismatch",
        detail: "query response overlay does not match request",
      }),
    )
  }
  if (result.nextCursor !== undefined) {
    if (
      typeof result.nextCursor !== "string" ||
      Buffer.byteLength(result.nextCursor, "utf-8") === 0 ||
      Buffer.byteLength(result.nextCursor, "utf-8") > MAX_SEARCH_CURSOR_BYTES
    ) {
      return Effect.fail(bridgeRejected("query response has an invalid cursor"))
    }
    // indexd only ever mints a continuation cursor when the result limit was
    // hit; a cursor without that proven truncation is a malformed response.
    if (result.truncatedBy !== "result_limit") {
      return Effect.fail(
        bridgeRejected("query response nextCursor requires result_limit truncation"),
      )
    }
  }
  if (
    result.workUnits !== undefined &&
    (typeof result.workUnits !== "number" || !Number.isSafeInteger(result.workUnits) || result.workUnits < 0)
  ) {
    return Effect.fail(bridgeRejected("query response has invalid work units"))
  }
  if (
    result.truncatedBy !== undefined &&
    result.truncatedBy !== "work_limit" &&
    result.truncatedBy !== "result_limit"
  ) {
    return Effect.fail(bridgeRejected("query response has an invalid truncation reason"))
  }
  if (result.status === "UNAVAILABLE") {
    if (
      result.matches.length !== 0 ||
      result.nextCursor !== undefined ||
      !isRecord(result.unavailableReason) ||
      result.unavailableReason.operation !== request.operation
    ) {
      return Effect.fail(bridgeRejected("unavailable response does not match the requested operation"))
    }
  } else if (result.unavailableReason !== undefined) {
    return Effect.fail(bridgeRejected("partial response cannot carry an unavailable reason"))
  }
  return Effect.succeed(result as unknown as RepoIntelBackendResult)
}

/**
 * Build a RepoIntel backend over a caller-injected typed transport. The adapter
 * checks the Rust wire contract's value limits and correlation bindings, but does
 * not encode frames, base64-aggregate snapshots, start a process, or install itself
 * in `node`/`unavailableLayer`.
 */
export const backendFromTransport = (transport: RepoIntelTransport): RepoIntelBackend => {
  const exchange = <A>(
    call: RepoIntelTransportCall,
    decode: (response: unknown) => Effect.Effect<A, RepoIntelBackendError>,
  ) => Effect.flatMap(transport.exchange(call), decode)

  return {
    build: (pins, snapshots) => {
      const invalidPins = validateTransportPins(pins)
      if (invalidPins) return Effect.fail(invalidPins)
      const invalidSnapshots = validateTransportSnapshots(snapshots)
      if (invalidSnapshots) return Effect.fail(invalidSnapshots)
      return exchange({ operation: "build", pins, snapshots }, (response) => {
        if (!isRecord(response) || response.operation !== "build" || !isBlake3Digest(response.generationId)) {
          return Effect.fail(bridgeRejected("malformed build response"))
        }
        return Effect.succeed({ generationId: response.generationId, generationStatus: "PARTIAL" as const })
      })
    },
    buildOverlay: (handle, overlay) => {
      if (!isBlake3Digest(handle.generationId)) {
        return Effect.fail(bridgeRejected("generation handle is not a tagged BLAKE3 digest"))
      }
      const invalid = validateTransportOverlay(overlay)
      if (invalid) return Effect.fail(invalid)
      return exchange({ operation: "build_overlay", generationId: handle.generationId, overlay }, (response) => {
        if (!isRecord(response) || response.operation !== "build_overlay" || !isBlake3Digest(response.overlayDigest)) {
          return Effect.fail(bridgeRejected("malformed buildOverlay response"))
        }
        if (response.generationId !== handle.generationId) {
          return Effect.fail(
            new RepoIntelBackendError({
              code: "generation_mismatch",
              detail: "overlay response generation does not match request",
            }),
          )
        }
        return Effect.succeed({ overlayDigest: response.overlayDigest })
      })
    },
    query: (handle, request) => {
      if (!isBlake3Digest(handle.generationId)) {
        return Effect.fail(bridgeRejected("generation handle is not a tagged BLAKE3 digest"))
      }
      const invalid = validateTransportQuery(request)
      if (invalid) return Effect.fail(invalid)
      return exchange({ operation: "query", generationId: handle.generationId, request }, (response) =>
        decodeTransportQuery(response, handle.generationId, request),
      )
    },
    release: (handle) => {
      if (!isBlake3Digest(handle.generationId)) return Effect.void
      return exchange({ operation: "release_generation", generationId: handle.generationId }, (response) =>
        isRecord(response) && response.operation === "released"
          ? Effect.void
          : Effect.fail(bridgeRejected("malformed releaseGeneration response")),
      ).pipe(Effect.catch(() => Effect.void))
    },
    releaseOverlay: (overlay) => {
      if (!isBlake3Digest(overlay.overlayDigest)) return Effect.void
      return exchange({ operation: "release_overlay", overlayDigest: overlay.overlayDigest }, (response) =>
        isRecord(response) && response.operation === "released"
          ? Effect.void
          : Effect.fail(bridgeRejected("malformed releaseOverlay response")),
      ).pipe(Effect.catch(() => Effect.void))
    },
  }
}

export const make = (options: {
  readonly fs: FSUtil.Interface
  readonly backend: RepoIntelBackend
  readonly source?: RepoIntelSource
  /**
   * Trusted, pure configuration snapshot seam only. It must not start optional services or do I/O;
   * missing/invalid state resolves to Lightweight and profile changes never split the base cache.
   */
  readonly resolveProfile?: (scope: ReadScope) => unknown
  readonly maxEntries?: number
  readonly maxCacheBytes?: number
  /** Idle derived generations expire after this interval; live query pins defer release. */
  readonly ttlMs?: number
  /** Optional telemetry port for the single RepoIntel LRU owner. */
  readonly onCacheOwnerEvent?: (observation: RepoIntelCacheOwnerObservationV1) => void
  readonly now?: () => number
}): Interface => {
  const fs = options.fs
  const backend = options.backend
  const source = options.source ?? nodeSource
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES
  const maxCacheBytes =
    Number.isSafeInteger(options.maxCacheBytes) && options.maxCacheBytes! >= 0
      ? Math.min(options.maxCacheBytes!, MAX_BASE_CONTENT_BYTES)
      : MAX_BASE_CONTENT_BYTES
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs! > 0
    ? Math.min(options.ttlMs!, 24 * 60 * 60_000)
    : DEFAULT_REPO_INTEL_CACHE_TTL_MS
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, CacheEntry>()
  const builds = new Map<string, BuildFlight>()
  const scopeEpoch = new Map<string, number>()

  const reportCacheEvent = (entry: CacheEntry, event: RepoIntelCacheOwnerObservationV1["event"]) => {
    if (!options.onCacheOwnerEvent) return
    const entries = [...cache.values()]
    const observation: RepoIntelCacheOwnerObservationV1 = {
      event,
      family: "repo-intel-generation",
      cacheKey: pinDigest(entry.key),
      scopeId: entry.scopeId,
      ownerScopeDigest: pinDigest(entry.pins.readScope),
      ...(entry.pins.repository ? { repository: entry.pins.repository } : {}),
      ...(entry.pins.workspace ? { workspace: entry.pins.workspace } : {}),
      sourceGeneration: entry.handle.generationId,
      sourceRevisionSet: entry.pins.revisionSet,
      readPolicyDigest: entry.pins.readPolicy,
      buildVersion: entry.pins.parserSet,
      accountedSourceBytes: entry.bytes,
      entryCount: entries.length,
      totalAccountedSourceBytes: entries.reduce((sum, value) => sum + value.bytes, 0),
      maxEntries,
      maxAccountedSourceBytes: maxCacheBytes,
      ttlMs,
      lastUsedAt: entry.lastUsedAt,
      pinCount: entry.inflight,
      protection: entry.inflight > 0 ? "pinned" : "rebuildable",
      reclaimedBytes: null,
    }
    try {
      options.onCacheOwnerEvent(observation)
    } catch {
      // Cache telemetry is advisory and cannot alter query/cache outcomes.
    }
  }

  const epochOf = (scopeId: string) => scopeEpoch.get(scopeId) ?? 0
  const flightKeyOf = (key: string, scopeId: string, epoch: number) => JSON.stringify([key, scopeId, epoch])

  const releaseWhenIdle = (entry: CacheEntry): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (entry.retired === "none" || entry.inflight > 0 || !entry.releasePending || entry.released) {
        return Effect.void
      }
      entry.released = true
      const released = backend.release ? backend.release(entry.handle).pipe(Effect.catch(() => Effect.void)) : Effect.void
      return released.pipe(Effect.tap(() => Effect.sync(() => reportCacheEvent(entry, "release"))))
    })

  const retire = (entry: CacheEntry, why: Exclude<EntryRetirement, "none">) => {
    entry.retired = why
    entry.releasePending = true
  }

  const retireLostGeneration = (entry: CacheEntry) =>
    Effect.gen(function* () {
      if (entry.retired === "invalidated") return
      if (cache.get(entry.key) === entry) cache.delete(entry.key)
      if (entry.retired === "none") retire(entry, "evicted")
      yield* releaseWhenIdle(entry)
    })

  const collect = Effect.fnUntraced(function* (input: {
    readonly root: string
    readonly sourceRoot: RepoIntelSourceRoot
    readonly subpath: string
    readonly scope: ReadScope
    readonly limits: Limits
    readonly signal?: AbortSignal
    readonly started: number
    readonly deadline: number
  }) {
    const { root, sourceRoot, subpath, limits, signal } = input
    const ignored = new Set(input.scope.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORIES)
    const files: CollectedFile[] = []
    const directories: CollectedDirectory[] = []
    const skipped: Array<{ readonly path: string; readonly reason: SkipReason }> = []
    let skippedCount = 0
    let scannedBytes = 0
    let readBytes = 0
    let pathBytes = 0
    let entriesScanned = 0
    let stoppedBy: CollectionStop | undefined

    const skip = (rel: string, reason: SkipReason) => {
      skippedCount++
      if (skipped.length < MAX_REPORTED_SKIPS) skipped.push({ path: rel, reason })
    }
    const aborted = () => signal?.aborted === true
    const expired = () => now() > input.deadline

    const startAbs = subpath === "" ? root : path.join(root, subpath)
    const startStat = yield* sourceRoot.stat(subpath)
    if (subpath !== "" && startStat === undefined) {
      return yield* new RepoIntelError({ code: "not_found", detail: subpath })
    }

    const candidates: string[] = []
    if (startStat?.type === "File") {
      candidates.push(subpath)
      const parentRel = subpath.includes("/") ? subpath.slice(0, subpath.lastIndexOf("/")) : ""
      const parentStat = yield* sourceRoot.stat(parentRel)
      if (parentStat?.type === "Directory") {
        directories.push({ rel: parentRel, mtimeMs: parentStat.mtimeMs })
      }
    } else {
      const pending: string[] = [subpath]
      const maxEntries = limits.maxFiles + limits.maxDirectories
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
        const info = yield* sourceRoot.stat(relDir)
        if (info?.type !== "Directory") {
          skip(relDir, "unreadable")
          continue
        }
        directories.push({ rel: relDir, mtimeMs: info.mtimeMs })
        const remainingEntries = maxEntries - entriesScanned
        if (remainingEntries <= 0) {
          stoppedBy = "entry_limit"
          break
        }
        const listing = yield* sourceRoot.readDirectoryEntriesBounded(relDir, remainingEntries)
        if (listing === undefined) {
          skip(relDir, "unreadable")
          continue
        }
        // Enforce the caller-side count even for an injected source that violates
        // its bounded-listing contract. Production nodeSource stops enumeration
        // at this limit before materializing the result.
        const entries = listing.entries.slice(0, remainingEntries)
        entriesScanned += entries.length
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
        if (listing.truncated || listing.entries.length > remainingEntries) {
          stoppedBy = "entry_limit"
          break
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
      const info = yield* sourceRoot.stat(rel)
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
      const file = yield* sourceRoot.readFile(rel, limits.maxFileBytes)
      if (file === undefined) {
        skip(rel, "unreadable")
        continue
      }
      if (file.tooLarge === true) {
        skip(rel, "too_large")
        continue
      }
      const bytes = file.contents
      if (bytes === undefined) {
        skip(rel, "unreadable")
        continue
      }
      if (bytes.length > limits.maxFileBytes) {
        skip(rel, "too_large")
        continue
      }
      // The file may grow between stat() and readFile(); enforce the aggregate
      // budget against the bytes actually collected, not only the earlier size.
      // Charge before the decode check so invalid UTF-8 and skipped files can
      // never read past the aggregate budget.
      if (readBytes + bytes.length > limits.maxTotalBytes) {
        stoppedBy = "byte_limit"
        break
      }
      readBytes += bytes.length
      if (decodeUtf8Strict(bytes) === undefined) {
        skip(rel, "not_utf8")
        continue
      }
      files.push({ rel, contents: bytes, size: bytes.length, mtimeMs: file.stat.mtimeMs })
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

  const observationStillCurrent = Effect.fnUntraced(function* (sourceRoot: RepoIntelSourceRoot, observed: Observation) {
    for (const directory of observed.directories) {
      const info = yield* sourceRoot.stat(directory.rel)
      if (info === undefined || info.type !== "Directory" || info.mtimeMs !== directory.mtimeMs) return false
    }
    for (const file of observed.files) {
      const info = yield* sourceRoot.stat(file.rel)
      if (info === undefined || info.type !== "File" || info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
        return false
      }
      const current = yield* sourceRoot.readFile(file.rel, MAX_FILE_BYTES)
      if (
        current === undefined ||
        current.tooLarge === true ||
        current.stat.type !== "File" ||
        current.stat.size !== file.size ||
        current.stat.mtimeMs !== file.mtimeMs ||
        current.contents === undefined ||
        Buffer.compare(Buffer.from(current.contents), Buffer.from(file.contents)) !== 0
      ) {
        return false
      }
    }
    return true
  })

  const promote = Effect.fnUntraced(function* (key: string) {
    const entry = cache.get(key)
    if (entry === undefined) return undefined
    if (now() - entry.lastUsedAt >= ttlMs) {
      cache.delete(key)
      retire(entry, "evicted")
      reportCacheEvent(entry, "evict")
      yield* releaseWhenIdle(entry)
      return undefined
    }
    cache.delete(key)
    entry.lastUsedAt = now()
    cache.set(key, entry)
    reportCacheEvent(entry, "use")
    return entry
  })

  const evictOverflow = Effect.fnUntraced(function* () {
    const bytes = () => [...cache.values()].reduce((total, entry) => total + entry.bytes, 0)
    while (cache.size > maxEntries || bytes() > maxCacheBytes) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) return
      const entry = cache.get(oldest)!
      cache.delete(oldest)
      retire(entry, "evicted")
      reportCacheEvent(entry, "evict")
      yield* releaseWhenIdle(entry)
    }
  })

  const buildShared = Effect.fnUntraced(function* (input: {
    readonly key: string
    readonly scopeId: string
    readonly epoch: number
    readonly pins: RepoIntelPins
    readonly snapshots: ReadonlyArray<RepoIntelSnapshot>
    readonly bytes: number
  }) {
    const flightKey = flightKeyOf(input.key, input.scopeId, input.epoch)
    let flight = builds.get(flightKey)
    if (flight === undefined) {
      flight = {
        scopeId: input.scopeId,
        epoch: input.epoch,
        result: yield* Deferred.make<CacheEntry, RepoIntelError>(),
        waiters: 0,
        done: false,
      }
      builds.set(flightKey, flight)
    } else if (flight.scopeId !== input.scopeId || flight.epoch !== input.epoch) {
      // flightKeyOf makes this unreachable; keep the provenance check local to
      // the join boundary so a future key change cannot silently cross epochs.
      return yield* new RepoIntelError({
        code: "stale_generation",
        detail: `scope ${input.scopeId} requested a build flight from a different invalidation epoch`,
      })
    }
    const activeFlight = flight

    activeFlight.waiters++
    // A caller that joins after the shared builder has allocated its entry must
    // acquire a reference of its own before it can issue a query.
    if (activeFlight.entry !== undefined) activeFlight.entry.inflight++

    if (activeFlight.fiber === undefined && !activeFlight.done) {
      const build = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const handle = yield* restore(
            backend.build(input.pins, input.snapshots).pipe(Effect.mapError(mapBackendError)),
          )
          const built: CacheEntry = {
            key: input.key,
            scopeId: input.scopeId,
            pins: input.pins,
            handle,
            bytes: input.bytes,
            lastUsedAt: now(),
            inflight: activeFlight.waiters,
            retired: "none",
            releasePending: false,
            released: false,
          }
          activeFlight.entry = built

          if (epochOf(activeFlight.scopeId) !== activeFlight.epoch) {
            retire(built, "invalidated")
            yield* releaseWhenIdle(built)
            return yield* new RepoIntelError({
              code: "stale_generation",
              detail: `scope ${activeFlight.scopeId} was invalidated during the generation build`,
            })
          }

          if (maxEntries > 0 && built.bytes <= maxCacheBytes) {
            cache.set(input.key, built)
            reportCacheEvent(built, "register")
            yield* evictOverflow()
          } else {
            retire(built, "evicted")
            yield* releaseWhenIdle(built)
          }
          return built
        }),
      )
      const worker = build.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            activeFlight.done = true
            Deferred.doneUnsafe(activeFlight.result, exit)
            if (activeFlight.waiters === 0 && builds.get(flightKey) === activeFlight) builds.delete(flightKey)
          }),
        ),
      )
      activeFlight.fiber = yield* Effect.forkDetach(worker)
    }

    let handedOff = false
    return yield* Deferred.await(activeFlight.result).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          handedOff = true
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          activeFlight.waiters--
          if (!handedOff && activeFlight.entry !== undefined) {
            activeFlight.entry.inflight--
            yield* releaseWhenIdle(activeFlight.entry)
          }
          if (activeFlight.waiters === 0) {
            if (!activeFlight.done && activeFlight.fiber !== undefined) yield* Fiber.interrupt(activeFlight.fiber)
            if (builds.get(flightKey) === activeFlight) builds.delete(flightKey)
          }
        }),
      ),
    )
  })

  const runOperation = (
    op: RepoIntelOperation,
    input: TextSearchInput,
  ): Effect.Effect<RepoIntelTextResult, RepoIntelError> => {
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
      const epoch = epochOf(input.scope.scopeId)
      const root = yield* fs
        .resolve(input.scope.root)
        .pipe(
          Effect.mapError(
            (cause) => new RepoIntelError({ code: "failed", detail: `scope root ${input.scope.root}: ${cause}` }),
          ),
        )
      let profileResolution: unknown
      try {
        profileResolution = options.resolveProfile?.(input.scope)
      } catch {
        profileResolution = undefined
      }
      const analysisProfile = resolveAnalysisProfile(profileResolution)
      const sourceRoot = yield* source.openRoot(root)
      return yield* Effect.gen(function* () {
        const observed = yield* collect({
          root,
          sourceRoot,
          subpath,
          scope: input.scope,
          limits,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          started,
          deadline: started + limits.maxDurationMs,
        })
        const fingerprint = fingerprintOf(input.scope.scopeId, subpath, observed)
        const pins = derivePins(input.scope, subpath, fingerprint)
        const key = cacheKey(input.scope.scopeId, fingerprint, pins)
        const observedPaths = new Set(observed.files.map((file) => file.rel))

        let entry = yield* promote(key)
        let countedByBuild = false
        if (entry === undefined) {
          entry = yield* buildShared({
            key,
            scopeId: input.scope.scopeId,
            epoch,
            pins,
            snapshots: observed.files.map((file) => ({ path: file.rel, contents: file.contents })),
            bytes: observed.scannedBytes,
          })
          countedByBuild = true
        }
        const active = entry
        if (!countedByBuild) active.inflight += 1
        reportCacheEvent(active, "pin")

        const useEntry = Effect.gen(function* () {
          if (input.expectedGenerationId !== undefined && active.handle.generationId !== input.expectedGenerationId) {
            return yield* new RepoIntelError({
              code: "stale_generation",
              detail: `expected ${input.expectedGenerationId}, current ${active.handle.generationId}`,
            })
          }

          let overlay: RepoIntelOverlayHandle | undefined
          if (input.overlay !== undefined) {
            if (backend.buildOverlay === undefined) {
              return yield* new RepoIntelError({
                code: "backend_unavailable",
                detail: "the wired RepoIntel backend cannot build exact-generation overlays",
              })
            }
            const validated = validateOverlayInput(input.overlay, observedPaths)
            if ("error" in validated) return yield* validated.error
            overlay = yield* backend
              .buildOverlay(active.handle, validated.value)
              .pipe(
                Effect.catch((error) =>
                  error.code === "generation_mismatch"
                    ? retireLostGeneration(active).pipe(Effect.andThen(Effect.fail(mapBackendError(error))))
                    : Effect.fail(mapBackendError(error)),
                ),
              )
          }

          const request: RepoIntelBackendQuery = {
            operation: op,
            query: input.query,
            maxResults: input.maxResults ?? DEFAULT_MAX_RESULTS,
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
            ...(overlay !== undefined ? { overlay } : {}),
          }
          const useQuery = Effect.gen(function* () {
            const response = yield* backend
              .query(active.handle, request)
              .pipe(
                Effect.catch((error) =>
                  error.code === "generation_mismatch"
                    ? retireLostGeneration(active).pipe(Effect.andThen(Effect.fail(mapBackendError(error))))
                    : Effect.fail(mapBackendError(error)),
                ),
              )
            if (response.generationId !== active.handle.generationId) {
              return yield* new RepoIntelError({
                code: "backend_rejected",
                detail: `query returned a different generation than the requested handle: ${response.generationId}`,
              })
            }
            if (
              (request.overlay === undefined && response.overlayDigest !== undefined) ||
              (request.overlay !== undefined && response.overlayDigest !== request.overlay.overlayDigest)
            ) {
              return yield* new RepoIntelError({
                code: "backend_rejected",
                detail:
                  request.overlay === undefined
                    ? "query returned an unexpected overlay digest"
                    : "query returned a different overlay digest than the requested overlay",
              })
            }
            const outOfGeneration = response.matches.find((match) => !observedPaths.has(match.path))
            if (outOfGeneration !== undefined) {
              return yield* new RepoIntelError({
                code: "backend_rejected",
                detail: `query returned a path outside the collected generation: ${outOfGeneration.path}`,
              })
            }
            const stillCurrent = yield* observationStillCurrent(sourceRoot, observed)

            if (active.retired === "invalidated") {
              return yield* new RepoIntelError({
                code: "stale_generation",
                detail: `generation ${active.handle.generationId} was invalidated during the query`,
              })
            }

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
              operation: op,
              analysisProfile,
              status: response.status,
              sourceKind:
                response.status === "UNAVAILABLE" ? "none" : op === "text" ? "lexical" : "unknown",
              coverage:
                response.status === "UNAVAILABLE"
                  ? "none"
                  : truncation.length > 0 || !stillCurrent || op !== "text"
                    ? "partial"
                    : "complete",
              ...(response.status === "UNAVAILABLE" && op !== "text"
                ? { fallback: "structural_parser_unavailable" as const }
                : {}),
              freshness,
              ...(freshness === "stale" ? { staleReason: "source_changed" as const } : {}),
              generationId: response.generationId,
              matches: response.matches,
              ...(response.nextCursor !== undefined ? { nextCursor: response.nextCursor } : {}),
              ...(response.workUnits !== undefined ? { workUnits: response.workUnits } : {}),
              ...(response.unavailableReason !== undefined ? { unavailableReason: response.unavailableReason } : {}),
              truncation,
              skipped: observed.skipped,
              skippedCount: observed.skippedCount,
              scanned: {
                files: observed.files.length,
                bytes: observed.scannedBytes,
                directories: observed.directories.length,
                durationMs: now() - started,
              },
              ...(overlay !== undefined
                ? {
                    overlay: {
                      editorVersion: input.overlay!.editorVersion,
                      digest: response.overlayDigest ?? overlay.overlayDigest,
                    },
                  }
                : {}),
              scopeId: input.scope.scopeId,
              subpath,
              observedAt: observed.observedAt,
            } satisfies RepoIntelTextResult
          })
          if (overlay !== undefined && backend.releaseOverlay) {
            const built = overlay
            return yield* useQuery.pipe(
              Effect.ensuring(backend.releaseOverlay(built).pipe(Effect.catch(() => Effect.void))),
            )
          }
          return yield* useQuery
        })

        return yield* useEntry.pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              active.inflight -= 1
              reportCacheEvent(active, "unpin")
              return releaseWhenIdle(active)
            }),
          ),
        )
      }).pipe(Effect.ensuring(sourceRoot.close))
    })

    if (input.signal === undefined) return operation
    return operation.pipe(
      Effect.raceFirst(waitForAbort(input.signal)),
      Effect.mapError((error) =>
        error instanceof RepoIntelError ? error : new RepoIntelError({ code: "cancelled", detail: String(error) }),
      ),
    )
  }

  const searchText = Effect.fn("RepoIntel.searchText")(function* (input: TextSearchInput) {
    return yield* runOperation("text", input)
  })

  const searchSymbols = Effect.fn("RepoIntel.searchSymbols")(function* (input: TextSearchInput) {
    return yield* runOperation("symbol", input)
  })

  const findReferences = Effect.fn("RepoIntel.findReferences")(function* (input: TextSearchInput) {
    return yield* runOperation("references", input)
  })

  const invalidate = Effect.fn("RepoIntel.invalidate")(function* (scopeId: string) {
    scopeEpoch.set(scopeId, epochOf(scopeId) + 1)
    let removed = 0
    for (const [key, entry] of [...cache.entries()]) {
      if (entry.scopeId !== scopeId) continue
      cache.delete(key)
      removed++
      retire(entry, "invalidated")
      reportCacheEvent(entry, "evict")
      yield* releaseWhenIdle(entry)
    }
    return removed
  })

  const evictGeneration = Effect.fn("RepoIntel.evictGeneration")(function* (scopeId: string, generationId: string) {
    const entry = [...cache.values()].find(
      (candidate) => candidate.scopeId === scopeId && candidate.handle.generationId === generationId,
    )
    if (entry === undefined) return { status: "not_found", reclaimedBytes: null } as const
    if (entry.inflight !== 0) return { status: "blocked_pinned", reclaimedBytes: null } as const
    cache.delete(entry.key)
    retire(entry, "evicted")
    reportCacheEvent(entry, "evict")
    yield* releaseWhenIdle(entry)
    return { status: "evicted", reclaimedBytes: null } as const
  })

  const stats = Effect.fn("RepoIntel.stats")(function* () {
    let bytes = 0
    for (const entry of cache.values()) bytes += entry.bytes
    let inFlightBuilds = 0
    let buildWaiters = 0
    for (const flight of builds.values()) {
      if (!flight.done) inFlightBuilds++
      buildWaiters += flight.waiters
    }
    return { entries: cache.size, bytes, inFlightBuilds, buildWaiters }
  })

  return { searchText, searchSymbols, findReferences, invalidate, evictGeneration, stats }
}

/** Backend that fails closed until a real indexd transport is wired. */
export const unavailableBackend: RepoIntelBackend = {
  build: () => Effect.fail(new RepoIntelBackendError({ code: "unavailable", detail: "no RepoIntel backend is wired" })),
  query: () => Effect.fail(new RepoIntelBackendError({ code: "unavailable", detail: "no RepoIntel backend is wired" })),
}

export const layer = (
  backend: RepoIntelBackend,
  options?: {
    readonly maxEntries?: number
    readonly maxCacheBytes?: number
    readonly ttlMs?: number
    readonly onCacheOwnerEvent?: (observation: RepoIntelCacheOwnerObservationV1) => void
    readonly resolveProfile?: (scope: ReadScope) => unknown
  },
) =>
  Layer.effect(
    Service,
    Effect.map(FSUtil.Service, (fs) => make({ fs, backend, ...options })),
  )

const unavailableServiceError = () =>
  new RepoIntelError({ code: "backend_unavailable", detail: "no authenticated HostKernel RepoIntel backend is wired" })

/**
 * The product default is unavailable at the service boundary, before it resolves
 * a caller-supplied root or collects any source bytes. Tests may still inject a
 * backend into `make`; that seam never becomes the production default by itself.
 */
export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    searchText: () => Effect.fail(unavailableServiceError()),
    searchSymbols: () => Effect.fail(unavailableServiceError()),
    findReferences: () => Effect.fail(unavailableServiceError()),
    invalidate: () => Effect.succeed(0),
    evictGeneration: () => Effect.succeed({ status: "not_found", reclaimedBytes: null }),
    stats: () => Effect.succeed({ entries: 0, bytes: 0, inFlightBuilds: 0, buildWaiters: 0 }),
  }),
)

/** Disabled local-cache service node; production structural queries use the
 * authenticated supervisor adapter and HostKernel-owned generation instead. */
export const node = LayerNode.make({
  service: Service,
  layer: unavailableLayer,
  deps: [FSUtil.node],
})

export * as RepoIntel from "./repo-intel"
