/**
 * §30.26 / §37.30 context compile policy and RepoContextAnchor projection.
 *
 * These are pure Core projections. They never select a provider/model, send a
 * cache breakpoint, store an artifact, or grant effect authority. The resolver
 * only derives `requested -> effective` from the already-pinned route capability
 * and the advisory Models.dev snapshot. The anchor builder only canonicalizes a
 * bounded, query-independent repository map; the HostKernel/indexd generation
 * and ArtifactStore remain the owners of the underlying bytes.
 */
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Schema } from "effect"
import {
  ContextCompilePolicyV1 as ContextCompilePolicySchema,
  ContextCompilePolicyRequestedV1 as ContextCompilePolicyRequestedSchema,
  ModelsDevCatalogFreshnessV1 as ModelsDevCatalogFreshnessSchema,
  ModelsDevCatalogSourceV1 as ModelsDevCatalogSourceSchema,
  PrefixCacheSupportV1 as PrefixCacheSupportSchema,
  type ContextCompilePolicyV1,
} from "@horizoncode/schema/context-compile-policy-v1"
import { canonicalProviderInputJson } from "./context-selection"

type ContextCompilePolicyRequestedV1 = typeof ContextCompilePolicyRequestedSchema.Type
type PrefixCacheSupportV1 = typeof PrefixCacheSupportSchema.Type
type ModelsDevCatalogSourceV1 = typeof ModelsDevCatalogSourceSchema.Type
type ModelsDevCatalogFreshnessV1 = typeof ModelsDevCatalogFreshnessSchema.Type

export const MAX_ANCHOR_BYTES = 8_388_608
export const MAX_ANCHOR_FILES = 4096
export const MAX_ANCHOR_PATH_BYTES = 4096
export const MAX_ANCHOR_SYMBOL_BYTES = 512
export const MAX_ANCHOR_SYMBOLS_PER_FILE = 96
export const DEFAULT_COMPILE_OVERLAP_MS = 250
const MIN_ANCHOR_BYTES = 42

const MAX_IDENTIFIER_BYTES = 512
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u
const CREDENTIAL_SHAPED = /(?:^|[/._-])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|credential|cookie)(?:[/._-]|$)/iu

/** Typed fail-closed result for an explicit `cache_anchor` request on a route with no prefix cache. */
export class ContextCompilePolicyUnavailableError extends Error {
  readonly code = "CONTEXT_COMPILE_PREFIX_CACHE_UNAVAILABLE"
  readonly requested: ContextCompilePolicyRequestedV1 = "cache_anchor"
  readonly providerID: string
  readonly modelID: string
  readonly routeRevision: string

  constructor(input: { readonly providerID: string; readonly modelID: string; readonly routeRevision: string }) {
    super("the pinned route does not support prefix caching; cache_anchor cannot be applied")
    this.name = "ContextCompilePolicyUnavailableError"
    this.providerID = input.providerID
    this.modelID = input.modelID
    this.routeRevision = input.routeRevision
  }
}

export type ContextCompilePolicyRequestSourceV1 = "profile" | "settings"

export type ContextCompileCatalogModelV1 = {
  readonly limit: {
    readonly context: number
    readonly output: number
    readonly input?: number
  }
  readonly cost?: {
    readonly cache_read?: number
    readonly cache_write?: number
  }
}

export type ResolveContextCompilePolicyInputV1 = {
  /** First explicit value wins at the caller; omit for the documented `auto` default. */
  readonly requested?: {
    readonly value: ContextCompilePolicyRequestedV1
    readonly source: ContextCompilePolicyRequestSourceV1
  }
  readonly route: {
    readonly providerID: string
    readonly modelID: string
    readonly routeRevision: string
    readonly endpointRevision: string
  }
  /** Authoritative capability from the selected ProviderTransport adapter. */
  readonly prefixCacheSupport: PrefixCacheSupportV1
  /** Advisory Models.dev row for the exact pinned provider/model. */
  readonly catalogSnapshot: {
    readonly source: ModelsDevCatalogSourceV1
    readonly freshness: ModelsDevCatalogFreshnessV1
    readonly model?: ContextCompileCatalogModelV1
  }
  /**
   * Explicit product downgrade path. Default false: an explicit cache_anchor
   * request on a `none` route fails closed before dispatch (§30.26.4 step 4).
   */
  readonly allowCacheAnchorDowngrade?: boolean
  /** Attached only when the effective tier is cache_anchor. */
  readonly anchorArtifactRef?: string
}

const digestJson = (domain: string, value: unknown) =>
  `blake3:${bytesToHex(blake3(new TextEncoder().encode(`${domain}\0${canonicalProviderInputJson(value)}`)))}`

const identifier = (value: string, label: string) => {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes === 0 || bytes > MAX_IDENTIFIER_BYTES) throw new TypeError(`${label} must contain 1-512 UTF-8 bytes`)
  if (CONTROL_OR_BIDI.test(value)) throw new TypeError(`${label} must not contain control or bidi characters`)
}

const positiveBound = (value: number, label: string, max = 100_000_000) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new RangeError(`${label} is outside its bound`)
}

/**
 * §30.26.4 normative resolver. Route capability is authoritative over advisory
 * catalog pricing: an unverifiable `none` route never resolves to cache_anchor
 * under `auto` (CX-017), even when the catalog advertises `cache_read`.
 */
export function resolveContextCompilePolicyV1(input: ResolveContextCompilePolicyInputV1): ContextCompilePolicyV1 {
  identifier(input.route.providerID, "providerID")
  identifier(input.route.modelID, "modelID")
  identifier(input.route.routeRevision, "routeRevision")
  identifier(input.route.endpointRevision, "endpointRevision")

  const requested = input.requested ?? { value: "auto" as const, source: "profile" as const }
  if (requested.value !== "auto" && requested.value !== "cache_anchor" && requested.value !== "minimize_tokens") {
    throw new TypeError("requested context compile policy is invalid")
  }
  const requestedFrom = requested.value === "auto" ? undefined : requested.source
  if (requestedFrom !== undefined && requestedFrom !== "profile" && requestedFrom !== "settings") {
    throw new TypeError("requested context compile policy source is invalid")
  }

  const catalog = input.catalogSnapshot
  if (catalog === undefined || typeof catalog !== "object") {
    throw new TypeError("context compile policy requires a catalog snapshot provenance")
  }
  if (
    catalog.source !== "cache" &&
    catalog.source !== "bundled" &&
    catalog.source !== "override" &&
    catalog.source !== "unavailable"
  ) {
    throw new TypeError("catalog snapshot source is invalid")
  }
  if (catalog.freshness !== "fresh" && catalog.freshness !== "stale" && catalog.freshness !== "unknown") {
    throw new TypeError("catalog snapshot freshness is invalid")
  }
  if (catalog.source === "unavailable" && catalog.model !== undefined) {
    throw new TypeError("an unavailable catalog snapshot cannot carry a model row")
  }
  if (catalog.model) {
    positiveBound(catalog.model.limit.context, "catalog context limit")
    positiveBound(catalog.model.limit.output, "catalog output limit")
    if (catalog.model.limit.input !== undefined) positiveBound(catalog.model.limit.input, "catalog input limit")
    if (catalog.model.cost?.cache_read !== undefined) {
      if (!Number.isFinite(catalog.model.cost.cache_read) || catalog.model.cost.cache_read < 0) {
        throw new RangeError("catalog cache_read price is invalid")
      }
    }
    if (catalog.model.cost?.cache_write !== undefined) {
      if (!Number.isFinite(catalog.model.cost.cache_write) || catalog.model.cost.cache_write < 0) {
        throw new RangeError("catalog cache_write price is invalid")
      }
    }
  }

  const support = input.prefixCacheSupport
  if (support !== "none" && support !== "ephemeral" && support !== "explicit_breakpoints" && support !== "unknown") {
    throw new TypeError("prefix cache support is invalid")
  }

  const priceCacheReadKnown = catalog.model?.cost?.cache_read !== undefined
  const priceCacheWriteKnown = catalog.model?.cost?.cache_write !== undefined
  const catalogHintEligible = priceCacheReadKnown && catalog.freshness !== "stale" && catalog.source !== "unavailable"

  let effective: "cache_anchor" | "minimize_tokens"
  let resolvedFrom:
    | "profile"
    | "settings"
    | "route_adapter"
    | "catalog_hint"
    | "measured_usage"
    | "conservative_default"

  if (requested.value === "cache_anchor") {
    if (support === "none") {
      if (input.allowCacheAnchorDowngrade !== true) {
        throw new ContextCompilePolicyUnavailableError({
          providerID: input.route.providerID,
          modelID: input.route.modelID,
          routeRevision: input.route.routeRevision,
        })
      }
      effective = "minimize_tokens"
      resolvedFrom = "settings"
    } else {
      effective = "cache_anchor"
      resolvedFrom = requested.source
    }
  } else if (requested.value === "minimize_tokens") {
    effective = "minimize_tokens"
    resolvedFrom = requested.source
  } else if (support === "explicit_breakpoints" || support === "ephemeral") {
    effective = "cache_anchor"
    resolvedFrom = "route_adapter"
  } else if (support === "none") {
    // The route says it cannot cache a prefix. Catalog pricing is advisory and
    // must never turn this into a claimed cache tier.
    effective = "minimize_tokens"
    resolvedFrom = "conservative_default"
  } else if (catalogHintEligible) {
    effective = "cache_anchor"
    resolvedFrom = "catalog_hint"
  } else {
    effective = "minimize_tokens"
    resolvedFrom = "conservative_default"
  }

  let anchorArtifactRef: string | undefined
  if (effective === "cache_anchor" && input.anchorArtifactRef !== undefined) {
    identifier(input.anchorArtifactRef, "anchorArtifactRef")
    anchorArtifactRef = input.anchorArtifactRef
  }

  return Schema.decodeUnknownSync(ContextCompilePolicySchema, { onExcessProperty: "error" })({
    schemaVersion: 1,
    requested: requested.value,
    effective,
    resolvedFrom,
    prefixCacheSupport: support,
    catalogHints: {
      providerID: input.route.providerID,
      modelID: input.route.modelID,
      catalogSource: catalog.source,
      catalogFreshness: catalog.freshness,
      ...(catalog.model?.limit.context !== undefined ? { contextLimitTokens: catalog.model.limit.context } : {}),
      ...(catalog.model?.limit.output !== undefined ? { outputLimitTokens: catalog.model.limit.output } : {}),
      priceCacheReadKnown,
      priceCacheWriteKnown,
    },
    ...(anchorArtifactRef !== undefined ? { anchorArtifactRef } : {}),
    anchorProjection: effective === "cache_anchor" ? "full" : "compressed",
  })
}

/** Stable digest of one compile-policy value for ledger/selection pinning. */
export function contextCompilePolicyDigestV1(policy: ContextCompilePolicyV1): string {
  const validated = Schema.decodeUnknownSync(ContextCompilePolicySchema, { onExcessProperty: "error" })(policy)
  if (validated.effective === "cache_anchor" && validated.prefixCacheSupport === "none") {
    throw new TypeError("ContextCompilePolicy cannot claim cache_anchor without prefix-cache support")
  }
  if (
    (validated.effective === "cache_anchor" && validated.anchorProjection !== "full") ||
    (validated.effective === "minimize_tokens" && validated.anchorProjection !== "compressed")
  ) {
    throw new TypeError("ContextCompilePolicy projection does not match its effective tier")
  }
  return digestJson("horizon.context-compile-policy.v1", validated)
}

/**
 * Anchor epoch identity. A change to any pin invalidates the cached anchor
 * bytes; a per-user-message change does not (§30.26.5).
 */
export type RepoContextAnchorEpochV1 = {
  readonly sessionID: string
  readonly workspaceBindingDigest: string
  readonly sourceRevision: string
  readonly harnessID: string
  readonly harnessRevision: number
  readonly profileID: string
  readonly profileRevision: string
  readonly permissionScopeDigest: string
}

export function repoContextAnchorEpochDigestV1(epoch: RepoContextAnchorEpochV1): string {
  identifier(epoch.sessionID, "sessionID")
  identifier(epoch.workspaceBindingDigest, "workspaceBindingDigest")
  identifier(epoch.sourceRevision, "sourceRevision")
  identifier(epoch.harnessID, "harnessID")
  identifier(epoch.profileID, "profileID")
  identifier(epoch.profileRevision, "profileRevision")
  identifier(epoch.permissionScopeDigest, "permissionScopeDigest")
  positiveBound(epoch.harnessRevision, "harnessRevision", Number.MAX_SAFE_INTEGER)
  return digestJson("horizon.repo-context-anchor-epoch.v1", {
    ...epoch,
    harnessRevision: epoch.harnessRevision,
  })
}

/** Reuse is allowed only for a byte-identical, fully current anchor epoch. */
export function shouldReuseRepoContextAnchorV1(input: {
  readonly stored: RepoContextAnchorEpochV1
  readonly current: RepoContextAnchorEpochV1
}): boolean {
  return repoContextAnchorEpochDigestV1(input.stored) === repoContextAnchorEpochDigestV1(input.current)
}

/** Public metadata mirror of `repo-context-anchor-v1.schema.json`; no artifact bytes. */
export type RepoContextAnchorV1 = {
  readonly schemaVersion: 1
  readonly sessionID: string
  readonly workspaceBindingDigest: string
  readonly sourceRevision: string
  readonly repoGenerationDigest: string
  readonly contentDigest: string
  readonly byteLength: number
  readonly projectionFullDigest: string
  readonly projectionCompressedDigest: string
  readonly fileCount?: number
  readonly completeness: "complete" | "partial"
  readonly partialReason?: string
}

export type RepoContextAnchorFileV1 = {
  /** Workspace-relative, normalized, authorized path. */
  readonly pathRef: string
  /** Public/lexical symbol names; no source text or secrets. */
  readonly symbols: ReadonlyArray<string>
}

export type CompileRepoContextAnchorInputV1 = {
  readonly sessionID: string
  readonly workspaceBindingDigest: string
  readonly sourceRevision: string
  readonly repoGenerationDigest: string
  /** Already authorized by the RepoIntel read boundary. */
  readonly files: ReadonlyArray<RepoContextAnchorFileV1>
  readonly maxBytes?: number
  readonly maxFiles?: number
  /** Optional externally stored artifact ref; never synthesized here. */
  readonly artifactRef?: string
}

export type CompiledRepoContextAnchorV1 = {
  readonly anchor: RepoContextAnchorV1
  readonly fullText: Uint8Array
  readonly compressedText: Uint8Array
}

const DIGEST_PATTERN = /^blake3:[0-9a-f]{64}$/

const sanitizeAnchorLabel = (value: string): string | undefined => {
  if (value.length === 0) return undefined
  if (CONTROL_OR_BIDI.test(value)) return undefined
  return CREDENTIAL_SHAPED.test(value) ? value.replace(/[^\s/]+/gu, "[redacted]") : value
}

const validRelativePath = (value: string): boolean => {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_ANCHOR_PATH_BYTES) return false
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value)) return false
  const parts = value.split("/")
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..")
}

/**
 * Deterministically compile the bounded universal repo map for one anchor epoch.
 * Paths are sorted by UTF-8 bytes; symbols retain their supplied order after
 * deduplication. Query-specific ranking, snippets, source text and secrets are
 * never part of the anchor. Callers must store the returned bytes and attach the
 * resulting artifact ref through the ordinary ArtifactStore contract.
 */
export function compileRepoContextAnchorV1(input: CompileRepoContextAnchorInputV1): CompiledRepoContextAnchorV1 {
  identifier(input.sessionID, "sessionID")
  if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) throw new TypeError("sessionID is not a Session ID")
  if (!DIGEST_PATTERN.test(input.workspaceBindingDigest)) throw new TypeError("workspaceBindingDigest is invalid")
  if (!DIGEST_PATTERN.test(input.repoGenerationDigest)) throw new TypeError("repoGenerationDigest is invalid")
  if (input.sourceRevision.length === 0 || Buffer.byteLength(input.sourceRevision, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new TypeError("sourceRevision is outside its bound")
  }
  if (input.artifactRef !== undefined) identifier(input.artifactRef, "artifactRef")

  const maxBytes = input.maxBytes ?? MAX_ANCHOR_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ANCHOR_BYTES) {
    throw new RangeError("anchor maxBytes is outside its bound")
  }
  if (maxBytes < MIN_ANCHOR_BYTES) {
    throw new RangeError("anchor maxBytes cannot fit its headers")
  }
  const maxFiles = input.maxFiles ?? MAX_ANCHOR_FILES
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || maxFiles > MAX_ANCHOR_FILES) {
    throw new RangeError("anchor maxFiles is outside its bound")
  }
  if (input.files.length > MAX_ANCHOR_FILES) {
    throw new RangeError("anchor source file count exceeds its bound")
  }

  const byPath = new Map<string, string[]>()
  let omitted = 0
  let symbolLimited = false
  for (const file of input.files) {
    if (!validRelativePath(file.pathRef)) {
      omitted += 1
      continue
    }
    const label = sanitizeAnchorLabel(file.pathRef)
    if (label === undefined) {
      omitted += 1
      continue
    }
    const symbols: string[] = []
    const seen = new Set<string>()
    for (const raw of file.symbols) {
      if (symbols.length >= MAX_ANCHOR_SYMBOLS_PER_FILE) {
        // The per-file cap stopped emission; partial only when a still-valid
        // symbol was actually omitted (mirrors the omitted-entry path check above).
        symbolLimited ||= file.symbols.some((candidate) => {
          if (candidate.length === 0 || Buffer.byteLength(candidate, "utf8") > MAX_ANCHOR_SYMBOL_BYTES) return false
          const sanitized = sanitizeAnchorLabel(candidate)
          return sanitized !== undefined && !seen.has(sanitized)
        })
        break
      }
      if (raw.length === 0 || Buffer.byteLength(raw, "utf8") > MAX_ANCHOR_SYMBOL_BYTES) continue
      const symbol = sanitizeAnchorLabel(raw)
      if (symbol === undefined || seen.has(symbol)) continue
      seen.add(symbol)
      symbols.push(symbol)
    }
    const existing = byPath.get(label)
    if (existing) {
      for (const symbol of symbols) if (!existing.includes(symbol)) existing.push(symbol)
    } else {
      byPath.set(label, symbols)
    }
  }

  const ordered = [...byPath.entries()]
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
    .slice(0, maxFiles)
  const fileLimited = byPath.size > maxFiles
  const encoder = new TextEncoder()
  const fullHeader = "horizon.repo-context-anchor.v1"
  const lines: string[] = [fullHeader]
  let byteLength = encoder.encode(`${fullHeader}\n`).byteLength
  let byteLimited = false
  for (const [pathRef, symbols] of ordered) {
    const symbolsPart = symbols.length > 0 ? symbols.join(" ") : "-"
    const line = `${pathRef}\t${symbolsPart}`
    const lineBytes = encoder.encode(`${line}\n`).byteLength
    if (byteLength + lineBytes > maxBytes) {
      byteLimited = true
      break
    }
    byteLength += lineBytes
    lines.push(line)
  }
  const fullText = encoder.encode(`${lines.join("\n")}\n`)

  const compressedHeader = "horizon.repo-context-anchor.compressed.v1"
  const compressedLines: string[] = [compressedHeader]
  let compressedBytes = encoder.encode(`${compressedHeader}\n`).byteLength
  let compressedLimited = false
  for (const [pathRef, symbols] of ordered) {
    const line = `${pathRef}\t${symbols.length}`
    const lineBytes = encoder.encode(`${line}\n`).byteLength
    if (compressedBytes + lineBytes > maxBytes) {
      compressedLimited = true
      break
    }
    compressedBytes += lineBytes
    compressedLines.push(line)
  }
  const compressedText = encoder.encode(`${compressedLines.join("\n")}\n`)

  const emittedFiles = lines.length - 1
  const partialReason = fileLimited
    ? "file_limit"
    : byteLimited
      ? "byte_limit"
      : omitted > 0
        ? "invalid_or_sensitive_entries_omitted"
        : compressedLimited
          ? "compressed_byte_limit"
          : symbolLimited
            ? "symbol_limit"
            : undefined
  const anchor: RepoContextAnchorV1 = {
    schemaVersion: 1,
    sessionID: input.sessionID,
    workspaceBindingDigest: input.workspaceBindingDigest,
    sourceRevision: input.sourceRevision,
    repoGenerationDigest: input.repoGenerationDigest,
    contentDigest: `blake3:${bytesToHex(blake3(fullText))}`,
    byteLength: fullText.byteLength,
    projectionFullDigest: `blake3:${bytesToHex(blake3(fullText))}`,
    projectionCompressedDigest: `blake3:${bytesToHex(blake3(compressedText))}`,
    ...(emittedFiles <= MAX_ANCHOR_FILES ? { fileCount: emittedFiles } : {}),
    completeness: partialReason === undefined ? "complete" : "partial",
    ...(partialReason === undefined ? {} : { partialReason }),
  }
  return { anchor, fullText, compressedText }
}

export type RepoContextAnchorWithArtifactRefV1 = RepoContextAnchorV1 & { readonly artifactRef: string }

/** Report an externally stored artifact ref for an already-compiled anchor. */
export function attachRepoContextAnchorArtifactRefV1(
  anchor: RepoContextAnchorV1,
  artifactRef: string,
): RepoContextAnchorWithArtifactRefV1 {
  identifier(artifactRef, "artifactRef")
  return { ...anchor, artifactRef }
}

/**
 * §30.28 SP-A overlap decision. Provider start may overlap only when the exact
 * ledger digest and compile policy are unchanged; any drift waits for the new
 * compile so a stale payload can never be dispatched.
 */
export type ContextCompileOverlapDecisionV1 = {
  readonly overlap: boolean
  readonly reason: "no_previous_ledger" | "digest_unchanged" | "digest_changed" | "compile_policy_changed"
  readonly maxOverlapMs: number
}

export function decideContextCompileOverlapV1(input: {
  readonly previous?: { readonly ledgerDigest: string; readonly compilePolicyDigest?: string }
  readonly current: { readonly ledgerDigest: string; readonly compilePolicyDigest?: string }
  readonly maxOverlapMs?: number
}): ContextCompileOverlapDecisionV1 {
  const maxOverlapMs = input.maxOverlapMs ?? DEFAULT_COMPILE_OVERLAP_MS
  if (!Number.isSafeInteger(maxOverlapMs) || maxOverlapMs < 0 || maxOverlapMs > 5_000) {
    throw new RangeError("compile overlap bound is invalid")
  }
  const digestPattern = /^blake3:[0-9a-f]{64}$/
  if (!digestPattern.test(input.current.ledgerDigest)) throw new TypeError("current ledgerDigest is invalid")
  if (input.current.compilePolicyDigest !== undefined && !digestPattern.test(input.current.compilePolicyDigest)) {
    throw new TypeError("current compilePolicyDigest is invalid")
  }
  if (input.previous) {
    if (!digestPattern.test(input.previous.ledgerDigest)) throw new TypeError("previous ledgerDigest is invalid")
    if (input.previous.compilePolicyDigest !== undefined && !digestPattern.test(input.previous.compilePolicyDigest)) {
      throw new TypeError("previous compilePolicyDigest is invalid")
    }
  }
  if (!input.previous) return { overlap: false, reason: "no_previous_ledger", maxOverlapMs }
  if (input.previous.compilePolicyDigest !== input.current.compilePolicyDigest) {
    return { overlap: false, reason: "compile_policy_changed", maxOverlapMs }
  }
  return input.previous.ledgerDigest === input.current.ledgerDigest
    ? { overlap: true, reason: "digest_unchanged", maxOverlapMs }
    : { overlap: false, reason: "digest_changed", maxOverlapMs }
}

export type RepoIntelIndexStatusV1 = "absent" | "building" | "current" | "stale" | "partial" | "failed"

/**
 * §30.28 SP-B/C/D speed plan. Cold or stale RepoIntel never blocks Send: the
 * caller receives an honest lexical fallback plan plus symbol-first tool bias.
 */
export type ContextSpeedPlanV1 = {
  readonly sendBlocked: false
  readonly indexWarming: boolean
  readonly indexMode: "index" | "lexical_fallback"
  readonly symbolFirst: true
  readonly toolBias: ReadonlyArray<"repo.tree" | "symbols.search" | "files.read">
  readonly harnessPreference: "native-rich" | "native-minimal"
  readonly reason: "index_current" | "index_warming" | "index_unavailable"
}

export function resolveContextSpeedPlanV1(input: {
  readonly indexStatus: RepoIntelIndexStatusV1
  readonly contextLimitTokens?: number
  readonly nativeTools: boolean
}): ContextSpeedPlanV1 {
  if (
    input.indexStatus !== "absent" &&
    input.indexStatus !== "building" &&
    input.indexStatus !== "current" &&
    input.indexStatus !== "stale" &&
    input.indexStatus !== "partial" &&
    input.indexStatus !== "failed"
  ) {
    throw new TypeError("RepoIntel index status is invalid")
  }
  if (input.contextLimitTokens !== undefined) positiveBound(input.contextLimitTokens, "contextLimitTokens")
  if (typeof input.nativeTools !== "boolean") throw new TypeError("nativeTools must be a boolean")
  const current = input.indexStatus === "current"
  return {
    sendBlocked: false,
    indexWarming: !current,
    indexMode: current ? "index" : "lexical_fallback",
    symbolFirst: true,
    toolBias: ["repo.tree", "symbols.search", "files.read"],
    harnessPreference:
      input.contextLimitTokens !== undefined && input.contextLimitTokens <= 8_000
        ? "native-minimal"
        : input.nativeTools
          ? "native-rich"
          : "native-minimal",
    reason: current ? "index_current" : input.indexStatus === "failed" || input.indexStatus === "absent" ? "index_unavailable" : "index_warming",
  }
}

/* ------------------------------------------------------------------------- */
/* §30.3/§30.4 recovery planning                                             */
/* ------------------------------------------------------------------------- */

/** One canonical history entry as the compile/compaction boundary sees it. */
export type ContextCompactionEntryV1 = {
  readonly seq: number
  readonly message: import("./message").SessionMessage.Message
}

const TRIM_PROTECTED_TOOLS = new Set([
  "task",
  "question",
  "plan_exit",
  "goal",
  "goal_review",
  "todo_write",
  "todowrite",
])

/** Read-only tools whose exact output can be regenerated from the same authorized source. */
const REREADABLE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "list",
  "ls",
  "find",
  "repo_tree",
  "repo_detect",
  "symbols_search",
  "references_find",
  "definitions_find",
])

type AssistantPart = import("./message").SessionMessage.AssistantContent
type ToolPart = Extract<AssistantPart, { type: "tool" }>

const isToolPart = (part: AssistantPart): part is ToolPart => part.type === "tool"

const artifactRefOf = (part: ToolPart): string | undefined => {
  const structured =
    part.state.status === "completed" || part.state.status === "error" ? part.state.structured : undefined
  const candidate =
    structured?.["artifactRef"] ?? structured?.["artifactID"] ?? structured?.["artifact_id"] ?? structured?.["outputPath"]
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 512 ? candidate : undefined
}

const toolPartBytes = (part: ToolPart): number => {
  if (part.state.status === "completed") {
    return part.state.content.reduce((sum, item) => {
      if (item.type === "text") return sum + Buffer.byteLength(item.text, "utf8")
      return sum + Buffer.byteLength(`[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`, "utf8")
    }, 0)
  }
  if (part.state.status === "error") return Buffer.byteLength(part.state.error.message, "utf8")
  return 0
}

const protectedUserBoundary = (entries: ReadonlyArray<ContextCompactionEntryV1>, protectRecentUserTurns: number) => {
  const userIndexes = entries.flatMap((entry, index) => (entry.message.type === "user" ? [index] : []))
  return {
    userIndexes,
    boundary: userIndexes.length <= protectRecentUserTurns ? 0 : userIndexes[userIndexes.length - protectRecentUserTurns]!,
  }
}

export type TrimCandidateV1 = {
  readonly messageID: string
  readonly partID: string
  readonly tool: string
  readonly bytes: number
  /** Surviving artifact or regenerable read reference. */
  readonly reference: string
  readonly placeholder: string
}

export type TrimPlanV1 = {
  readonly candidates: ReadonlyArray<TrimCandidateV1>
  /** Exact message/part refs that must stay model-visible. */
  readonly protectedRefs: ReadonlyArray<string>
  readonly removableBytes: number
  readonly protectedRecentUserTurns: number
  readonly reasons: ReadonlyArray<{ readonly ref: string; readonly reason: string }>
}

/**
 * §30.3 `/trim`: deterministic removal of paired old verbose tool payloads that
 * retain an artifact or a re-readable source. Canonical history is not deleted;
 * this is a model-visible projection plan. Goal/criteria, approvals, current
 * batches, unsettled effects and error evidence are never candidates.
 */
export function planContextTrimV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly protectRecentUserTurns?: number
  readonly minimumBytes?: number
}): TrimPlanV1 {
  const protectRecentUserTurns = input.protectRecentUserTurns ?? 2
  if (!Number.isSafeInteger(protectRecentUserTurns) || protectRecentUserTurns < 1 || protectRecentUserTurns > 32) {
    throw new RangeError("trim protected user-turn count is invalid")
  }
  const minimumBytes = input.minimumBytes ?? 512
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 0 || minimumBytes > 1_048_576) {
    throw new RangeError("trim minimum byte bound is invalid")
  }
  const { userIndexes, boundary } = protectedUserBoundary(input.entries, protectRecentUserTurns)
  const candidates: TrimCandidateV1[] = []
  const protectedRefs: string[] = []
  const reasons: Array<{ ref: string; reason: string }> = []

  for (let index = 0; index < input.entries.length; index += 1) {
    const message = input.entries[index]!.message
    if (message.type === "user") {
      if (index >= boundary || index === userIndexes[userIndexes.length - 1]) protectedRefs.push(message.id)
      continue
    }
    if (message.type !== "assistant") {
      if (index >= boundary && (message.type === "compaction" || message.type === "system" || message.type === "synthetic")) {
        protectedRefs.push(message.id)
      }
      continue
    }
    for (const part of message.content) {
      const ref = `${message.id}:${part.id}`
      if (!isToolPart(part)) {
        if (index >= boundary) protectedRefs.push(ref)
        continue
      }
      if (part.state.status === "pending" || part.state.status === "running") {
        protectedRefs.push(ref)
        reasons.push({ ref, reason: "unsettled_effect" })
        continue
      }
      if (part.state.status === "error") {
        protectedRefs.push(ref)
        reasons.push({ ref, reason: "error_evidence" })
        continue
      }
      if (index >= boundary) {
        protectedRefs.push(ref)
        reasons.push({ ref, reason: "recent_turn" })
        continue
      }
      if (TRIM_PROTECTED_TOOLS.has(part.name)) {
        protectedRefs.push(ref)
        reasons.push({ ref, reason: "protected_tool_evidence" })
        continue
      }
      const bytes = toolPartBytes(part)
      if (bytes < minimumBytes) continue
      const artifact = artifactRefOf(part)
      const rereadable = REREADABLE_TOOLS.has(part.name)
      if (!artifact && !rereadable) {
        protectedRefs.push(ref)
        reasons.push({ ref, reason: "no_recoverable_reference" })
        continue
      }
      const reference = artifact ?? `tool:${part.name}`
      candidates.push({
        messageID: message.id,
        partID: part.id,
        tool: part.name,
        bytes,
        reference,
        placeholder: `[trimmed ${part.name} output: ${reference}; re-read on demand]`,
      })
    }
  }
  return {
    candidates,
    protectedRefs,
    removableBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    protectedRecentUserTurns: protectRecentUserTurns,
    reasons,
  }
}

export type PruneCandidateV1 = {
  readonly messageID: string
  readonly reason: "stale_assistant_narration"
  readonly bytes: number
  readonly digest: string
}

export type PrunePlanV1 = {
  readonly candidates: ReadonlyArray<PruneCandidateV1>
  readonly protectedRefs: ReadonlyArray<string>
  readonly removableBytes: number
  /** Accepted prune records keep a source range/digest so history search can recover them. */
  readonly sourceRange: { readonly firstMessageID?: string; readonly lastMessageID?: string }
}

/**
 * §30.3 `/prune`: deterministic stale-history preview. Recent user turns and
 * pinned entries are protected; a caller may apply the plan through the Session
 * projection and retain the returned source range/digest for later retrieval.
 */
const MAX_PROTECTED_REFS = 4_096

export function planContextPruneV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly protectRecentUserTurns?: number
  readonly protectedRefs?: ReadonlyArray<string>
}): PrunePlanV1 {
  const protectRecentUserTurns = input.protectRecentUserTurns ?? 2
  if (!Number.isSafeInteger(protectRecentUserTurns) || protectRecentUserTurns < 1 || protectRecentUserTurns > 32) {
    throw new RangeError("prune protected user-turn count is invalid")
  }
  if (input.protectedRefs !== undefined) {
    if (!Array.isArray(input.protectedRefs)) throw new TypeError("protectedRefs must be an array")
    if (input.protectedRefs.length > MAX_PROTECTED_REFS) throw new RangeError("protectedRefs exceeds its bound")
    if (input.protectedRefs.some((ref) => typeof ref !== "string")) {
      throw new TypeError("protectedRefs must contain only strings")
    }
  }
  const pinned = new Set(input.protectedRefs ?? [])
  const { boundary } = protectedUserBoundary(input.entries, protectRecentUserTurns)
  const candidates: PruneCandidateV1[] = []
  const protectedRefs: string[] = []
  for (let index = 0; index < input.entries.length; index += 1) {
    const message = input.entries[index]!.message
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      const ref = `${message.id}:${part.id}`
      if (pinned.has(ref) || pinned.has(message.id) || index >= boundary) {
        protectedRefs.push(ref)
        continue
      }
      if (part.type !== "text" && part.type !== "reasoning") continue
      if (part.text.trim().length === 0) continue
      candidates.push({
        messageID: message.id,
        reason: "stale_assistant_narration",
        bytes: Buffer.byteLength(part.text, "utf8"),
        digest: `blake3:${bytesToHex(blake3(new TextEncoder().encode(part.text)))}`,
      })
    }
  }
  const first = candidates[0]?.messageID
  const last = candidates[candidates.length - 1]?.messageID
  return {
    candidates,
    protectedRefs,
    removableBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    sourceRange: {
      ...(first === undefined ? {} : { firstMessageID: first }),
      ...(last === undefined ? {} : { lastMessageID: last }),
    },
  }
}

export type PressureRecoveryPlanV1 =
  | { readonly status: "none" | "unknown_context_limit"; readonly estimatedInputTokens: number; readonly softPressureLimit?: number }
  | {
      readonly status: "auto_trim"
      readonly epochID: string
      readonly plan: TrimPlanV1
      readonly estimatedInputTokens: number
      readonly softPressureLimit: number
    }
  | {
      readonly status: "compact"
      readonly epochID: string
      readonly estimatedInputTokens: number
      readonly softPressureLimit: number
    }
  | {
      readonly status: "context_budget_exceeded"
      readonly epochID: string
      readonly estimatedInputTokens: number
      readonly softPressureLimit: number
      readonly diagnostics: {
        readonly contextLimit: number
        readonly outputReserve: number
        readonly toolReserve: number
        readonly safetyMargin: number
      }
    }

/**
 * §30.4 pressure recovery step 0. At soft pressure, auto-trim once per context
 * epoch; then fall through to compaction. This function never mutates history or
 * claims a successful trim. Goal/current-request protection is delegated to
 * `planContextTrimV1`; the caller applies the plan at the next compile boundary.
 */
export function planPressureRecoveryV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly request: import("@horizoncode/llm").LLMRequest
  readonly model: import("@horizoncode/llm").Model
  readonly epochID: string
  readonly autoTrimmedEpochIDs?: ReadonlyArray<string>
  readonly maxOutputTokens?: number
  readonly safetyMarginTokens?: number
}): PressureRecoveryPlanV1 {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.epochID)) throw new TypeError("context epoch identity is invalid")
  if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 0)) {
    throw new RangeError("maxOutputTokens is invalid")
  }
  if (input.safetyMarginTokens !== undefined && (!Number.isSafeInteger(input.safetyMarginTokens) || input.safetyMarginTokens < 0)) {
    throw new RangeError("safetyMarginTokens is invalid")
  }
  const estimate = (value: unknown) => Math.max(0, Math.round(JSON.stringify(value).length / 4))
  const estimatedInputTokens = estimate({
    system: input.request.system,
    messages: input.request.messages,
    tools: input.request.tools,
  })
  const context = input.model.route.defaults.limits?.context
  if (context === undefined || !Number.isSafeInteger(context) || context <= 0) {
    return { status: "unknown_context_limit", estimatedInputTokens }
  }
  const outputReserve =
    input.maxOutputTokens ?? input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
  if (!Number.isSafeInteger(outputReserve) || outputReserve < 0) {
    return { status: "unknown_context_limit", estimatedInputTokens }
  }
  const toolReserve = estimate(input.request.tools ?? [])
  const safetyMargin = input.safetyMarginTokens ?? Math.max(2_048, Math.floor(context * 0.02))
  if (!Number.isSafeInteger(safetyMargin) || safetyMargin < 0) {
    return { status: "unknown_context_limit", estimatedInputTokens }
  }
  const softPressureLimit = context - outputReserve - toolReserve - safetyMargin
  if (softPressureLimit <= 0) {
    return {
      status: "context_budget_exceeded",
      epochID: input.epochID,
      estimatedInputTokens,
      softPressureLimit,
      diagnostics: { contextLimit: context, outputReserve, toolReserve, safetyMargin },
    }
  }
  if (estimatedInputTokens < softPressureLimit) return { status: "none", estimatedInputTokens, softPressureLimit }
  if (!(input.autoTrimmedEpochIDs ?? []).includes(input.epochID)) {
    const plan = planContextTrimV1({ entries: input.entries })
    if (plan.candidates.length > 0) {
      return { status: "auto_trim", epochID: input.epochID, plan, estimatedInputTokens, softPressureLimit }
    }
  }
  const canCompact = input.entries.some(
    (entry) => entry.message.type === "assistant" || entry.message.type === "compaction",
  )
  if (canCompact) return { status: "compact", epochID: input.epochID, estimatedInputTokens, softPressureLimit }
  return {
    status: "context_budget_exceeded",
    epochID: input.epochID,
    estimatedInputTokens,
    softPressureLimit,
    diagnostics: { contextLimit: context, outputReserve, toolReserve, safetyMargin },
  }
}

/* ------------------------------------------------------------------------- */
/* A-V2-13 / DEC-V1-13 context-ledger window operations: trim/prune/clear    */
/* ------------------------------------------------------------------------- */

/**
 * Canonical history is never deleted. `trim`, `prune` and `clear` are ledger
 * operations over the *model window*: exactly the entries lowered into the next
 * provider request. Every operation returns the rewritten window and never a
 * deletion instruction, so the durable rows the projection read stay intact.
 */
export type ContextWindowOperationV1 = "trim" | "prune" | "clear"

/** One assistant tool part, plus the call/result pair that must move together. */
export type ContextWindowToolPairV1 = {
  readonly messageID: string
  readonly partID: string
  readonly tool: string
  readonly bytes: number
  /** Assistant `tool_call` ref. Removing it without `resultRef` is a 400 risk. */
  readonly callRef: string
  /** `tool_result` ref paired with that `callRef`. */
  readonly resultRef: string
}

export type ContextWindowPayloadReplacementV1 = {
  readonly messageID: string
  readonly partID: string
  /** Surviving artifact or regenerable read reference. */
  readonly reference: string
  readonly placeholder: string
}

export type ContextWindowPlanV1 = {
  readonly operation: ContextWindowOperationV1
  /** Whole messages leaving the model window. Ids only; durable rows stay. */
  readonly excludedMessages: ReadonlyArray<string>
  /** Tool parts leaving whole: the assistant tool_call and its result together. */
  readonly excludedToolPairs: ReadonlyArray<ContextWindowToolPairV1>
  /** Trim payload rewrites that free bytes without dropping the call. */
  readonly replacedToolPayloads: ReadonlyArray<ContextWindowPayloadReplacementV1>
  /** Refs that must stay model-visible (system, pinned, protected evidence). */
  readonly retainedRefs: ReadonlyArray<string>
  readonly removedBytes: number
}

export type ContextWindowRewriteV1 = {
  readonly operation: ContextWindowOperationV1
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly removedMessages: ReadonlyArray<string>
  readonly removedToolPairs: ReadonlyArray<ContextWindowToolPairV1>
  readonly replacedToolPayloads: ReadonlyArray<ContextWindowPayloadReplacementV1>
  readonly removedBytes: number
  readonly retainedRefs: ReadonlyArray<string>
  /** True only when the rewritten window carries no orphaned tool pair. */
  readonly toolPairsIntact: true
}

/** A plan tried to separate a provider tool pair, or the rewrite produced one. */
export class ContextWindowPairError extends Error {
  readonly code = "CONTEXT_WINDOW_TOOL_PAIR_UNPAIRED"
  readonly ref: string

  constructor(message: string, ref: string) {
    super(message)
    this.name = "ContextWindowPairError"
    this.ref = ref
  }
}

export const contextWindowCallRef = (messageID: string, partID: string) => `${messageID}:${partID}#call`
export const contextWindowResultRef = (messageID: string, partID: string) => `${messageID}:${partID}#result`

export type ContextWindowToolPairTableV1 = {
  readonly calls: ReadonlyArray<{ readonly callID: string; readonly messageID: string }>
  readonly results: ReadonlyArray<{ readonly callID: string; readonly messageID: string }>
}

export type ContextWindowToolPairErrorV1 = {
  readonly callID: string
  readonly messageID: string
  readonly reason: "orphan_tool_call" | "orphan_tool_result"
}

/**
 * Provider-level pairing table for a settled window. A completed or errored
 * assistant tool part lowers to a `tool_call` and its `tool_result`; a
 * pending/running part is still in flight, so it is intentionally outside the
 * pairing check until its batch settles. A settled call without its result (or a
 * result without its call) is the 400 shape this guard exists to catch.
 */
export function contextWindowToolPairsV1(
  entries: ReadonlyArray<ContextCompactionEntryV1>,
): ContextWindowToolPairTableV1 {
  const calls: Array<{ callID: string; messageID: string }> = []
  const results: Array<{ callID: string; messageID: string }> = []
  for (const entry of entries) {
    const message = entry.message
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (!isToolPart(part)) continue
      if (part.state.status !== "completed" && part.state.status !== "error") continue
      calls.push({ callID: part.id, messageID: message.id })
      results.push({ callID: part.id, messageID: message.id })
    }
  }
  return { calls, results }
}

/** Exact provider pairing check: every call answered, every result preceded. */
export function toolPairErrorsV1(
  input: ContextWindowToolPairTableV1,
): ReadonlyArray<ContextWindowToolPairErrorV1> {
  const calls = new Set(input.calls.map((call) => call.callID))
  const results = new Set(input.results.map((result) => result.callID))
  const errors: ContextWindowToolPairErrorV1[] = []
  for (const call of input.calls) {
    if (!results.has(call.callID)) {
      errors.push({ callID: call.callID, messageID: call.messageID, reason: "orphan_tool_call" })
    }
  }
  for (const result of input.results) {
    if (!calls.has(result.callID)) {
      errors.push({ callID: result.callID, messageID: result.messageID, reason: "orphan_tool_result" })
    }
  }
  return errors
}

export function contextWindowToolPairErrorsV1(
  entries: ReadonlyArray<ContextCompactionEntryV1>,
): ReadonlyArray<ContextWindowToolPairErrorV1> {
  return toolPairErrorsV1(contextWindowToolPairsV1(entries))
}

const toolPairOf = (messageID: string, part: ToolPart): ContextWindowToolPairV1 => ({
  messageID,
  partID: part.id,
  tool: part.name,
  bytes: toolPartBytes(part),
  callRef: contextWindowCallRef(messageID, part.id),
  resultRef: contextWindowResultRef(messageID, part.id),
})

const boundedProtectedRefs = (protectedRefs: ReadonlyArray<string> | undefined) => {
  if (protectedRefs === undefined) return
  if (!Array.isArray(protectedRefs)) throw new TypeError("protectedRefs must be an array")
  if (protectedRefs.length > MAX_PROTECTED_REFS) throw new RangeError("protectedRefs exceeds its bound")
  if (protectedRefs.some((ref) => typeof ref !== "string")) {
    throw new TypeError("protectedRefs must contain only strings")
  }
}

/**
 * `/trim`: drop the oldest non-canonical payloads from the model window. The
 * §30.3 trim planner already proves which old tool payloads are recoverable and
 * protects recent turns, evidence and unsettled effects; this projection only
 * rewrites those payloads to their placeholder and keeps every message, every
 * assistant tool_call and every tool result in place.
 */
export function planContextTrimWindowV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly protectRecentUserTurns?: number
  readonly minimumBytes?: number
}): ContextWindowPlanV1 {
  const plan = planContextTrimV1(input)
  return {
    operation: "trim",
    excludedMessages: [],
    excludedToolPairs: [],
    replacedToolPayloads: plan.candidates.map((candidate) => ({
      messageID: candidate.messageID,
      partID: candidate.partID,
      reference: candidate.reference,
      placeholder: candidate.placeholder,
    })),
    retainedRefs: plan.protectedRefs,
    removedBytes: plan.removableBytes,
  }
}

/**
 * `/prune`: remove eligible old tool results from the model window. A tool
 * result never leaves alone — the assistant tool part that carries the
 * `tool_call` leaves with it as one atomic pair, so the provider never sees an
 * orphaned tool_call/tool_result (the 400 risk called out on the compaction
 * projection). Only settled, recoverable, unprotected, out-of-recent-turn tool
 * evidence is eligible; error evidence and unsettled effects always stay.
 */
export function planContextPruneWindowV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly protectRecentUserTurns?: number
  readonly minimumBytes?: number
  readonly protectedRefs?: ReadonlyArray<string>
}): ContextWindowPlanV1 {
  const protectRecentUserTurns = input.protectRecentUserTurns ?? 2
  if (!Number.isSafeInteger(protectRecentUserTurns) || protectRecentUserTurns < 1 || protectRecentUserTurns > 32) {
    throw new RangeError("prune protected user-turn count is invalid")
  }
  boundedProtectedRefs(input.protectedRefs)
  const minimumBytes = input.minimumBytes ?? 512
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 0 || minimumBytes > 1_048_576) {
    throw new RangeError("prune minimum byte bound is invalid")
  }
  const pinned = new Set(input.protectedRefs ?? [])
  const { boundary } = protectedUserBoundary(input.entries, protectRecentUserTurns)
  const excludedToolPairs: ContextWindowToolPairV1[] = []
  const retainedRefs: string[] = []
  for (let index = 0; index < input.entries.length; index += 1) {
    const message = input.entries[index]!.message
    if (message.type !== "assistant") {
      if (index >= boundary) retainedRefs.push(message.id)
      continue
    }
    for (const part of message.content) {
      const ref = `${message.id}:${part.id}`
      if (!isToolPart(part)) {
        if (index >= boundary) retainedRefs.push(ref)
        continue
      }
      if (index >= boundary || pinned.has(ref) || pinned.has(message.id)) {
        retainedRefs.push(ref)
        continue
      }
      // Error evidence and unsettled effects answer authority questions.
      if (part.state.status !== "completed") {
        retainedRefs.push(ref)
        continue
      }
      if (TRIM_PROTECTED_TOOLS.has(part.name)) {
        retainedRefs.push(ref)
        continue
      }
      if (toolPartBytes(part) < minimumBytes) {
        retainedRefs.push(ref)
        continue
      }
      const artifact = artifactRefOf(part)
      if (!artifact && !REREADABLE_TOOLS.has(part.name)) {
        retainedRefs.push(ref)
        continue
      }
      excludedToolPairs.push(toolPairOf(message.id, part))
    }
  }
  return {
    operation: "prune",
    excludedMessages: [],
    excludedToolPairs,
    replacedToolPayloads: [],
    retainedRefs,
    removedBytes: excludedToolPairs.reduce((sum, pair) => sum + pair.bytes, 0),
  }
}

/**
 * `/clear`: reset the model window to system context plus pinned messages.
 * System rows (the Baseline System Context projection) and pinned refs stay;
 * every other message leaves the window. Nothing is deleted from the store, so
 * the canonical conversation remains readable and auditable.
 */
export function planContextClearWindowV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly pinnedRefs?: ReadonlyArray<string>
}): ContextWindowPlanV1 {
  boundedProtectedRefs(input.pinnedRefs)
  const pinned = new Set(input.pinnedRefs ?? [])
  const excludedMessages: string[] = []
  const retainedRefs: string[] = []
  for (const entry of input.entries) {
    const message = entry.message
    if (message.type === "system" || pinned.has(message.id)) {
      retainedRefs.push(message.id)
      continue
    }
    excludedMessages.push(message.id)
  }
  return {
    operation: "clear",
    excludedMessages,
    excludedToolPairs: [],
    replacedToolPayloads: [],
    retainedRefs,
    removedBytes: 0,
  }
}

type AssistantMessage = Extract<import("./message").SessionMessage.Message, { type: "assistant" }>

const replaceToolPayload = (part: ToolPart, placeholder: string): ToolPart => {
  if (part.state.status !== "completed") return part
  return {
    ...part,
    state: {
      ...part.state,
      attachments: [],
      content: [{ type: "text", text: placeholder }],
    },
    time: {
      ...part.time,
      pruned: part.time.completed ?? part.time.created,
    },
  }
}

/**
 * Apply a window plan. The rewrite is validated before it is returned: every
 * excluded tool pair must name the exact `#call`/`#result` refs derived from the
 * part it removes, and the resulting window must carry no orphaned pair.
 */
export function applyContextWindowPlanV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly plan: ContextWindowPlanV1
}): ContextWindowRewriteV1 {
  const excludedMessages = new Set(input.plan.excludedMessages)
  const pairs = new Map<string, ContextWindowToolPairV1>()
  for (const pair of input.plan.excludedToolPairs) {
    if (
      pair.callRef !== contextWindowCallRef(pair.messageID, pair.partID) ||
      pair.resultRef !== contextWindowResultRef(pair.messageID, pair.partID)
    ) {
      throw new ContextWindowPairError(
        "a tool_result cannot leave the model window without its paired assistant tool_call",
        pair.callRef,
      )
    }
    pairs.set(`${pair.messageID}:${pair.partID}`, pair)
  }
  const replacements = new Map(
    input.plan.replacedToolPayloads.map((replacement) => [
      `${replacement.messageID}:${replacement.partID}`,
      replacement,
    ]),
  )
  const removedMessages: string[] = []
  const removedToolPairs: ContextWindowToolPairV1[] = []
  const replacedToolPayloads: ContextWindowPayloadReplacementV1[] = []
  let removedBytes = 0

  const entries = input.entries.flatMap((entry) => {
    const message = entry.message
    if (excludedMessages.has(message.id)) {
      removedMessages.push(message.id)
      removedBytes += Buffer.byteLength(JSON.stringify(message), "utf8")
      return []
    }
    if (message.type !== "assistant") return [entry]
    let dropped = 0
    const content = message.content.flatMap((part): Array<AssistantPart> => {
      const pair = pairs.get(`${message.id}:${part.id}`)
      if (pair !== undefined) {
        if (!isToolPart(part)) {
          throw new ContextWindowPairError("a window pair must name an assistant tool part", pair.callRef)
        }
        dropped += 1
        removedToolPairs.push(pair)
        removedBytes += pair.bytes
        return []
      }
      const replacement = replacements.get(`${message.id}:${part.id}`)
      if (replacement !== undefined) {
        if (!isToolPart(part)) {
          throw new ContextWindowPairError(
            "a trim payload replacement must name an assistant tool part",
            `${message.id}:${part.id}`,
          )
        }
        const next = replaceToolPayload(part, replacement.placeholder)
        replacedToolPayloads.push(replacement)
        removedBytes += Math.max(0, toolPartBytes(part) - toolPartBytes(next))
        return [next]
      }
      return [part]
    })
    // A message that carried only pruned tool parts leaves the window whole;
    // an empty assistant turn is not a valid provider message either.
    if (content.length === 0 && message.content.length > 0 && dropped > 0) {
      removedMessages.push(message.id)
      return []
    }
    return [{ seq: entry.seq, message: { ...message, content } as AssistantMessage }]
  })

  const errors = contextWindowToolPairErrorsV1(entries)
  if (errors.length > 0) {
    const first = errors[0]!
    throw new ContextWindowPairError(
      `the rewritten model window carries an orphaned ${
        first.reason === "orphan_tool_call" ? "tool_call" : "tool_result"
      }`,
      first.callID,
    )
  }

  return {
    operation: input.plan.operation,
    entries,
    removedMessages,
    removedToolPairs,
    replacedToolPayloads,
    removedBytes,
    retainedRefs: input.plan.retainedRefs,
    toolPairsIntact: true,
  }
}

/** The three ledger operations over one exact model window. */
export function trimContextWindowV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly protectRecentUserTurns?: number
  readonly minimumBytes?: number
}): ContextWindowRewriteV1 {
  return applyContextWindowPlanV1({ entries: input.entries, plan: planContextTrimWindowV1(input) })
}

export function pruneContextWindowV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly protectRecentUserTurns?: number
  readonly minimumBytes?: number
  readonly protectedRefs?: ReadonlyArray<string>
}): ContextWindowRewriteV1 {
  return applyContextWindowPlanV1({ entries: input.entries, plan: planContextPruneWindowV1(input) })
}

export function clearContextWindowV1(input: {
  readonly entries: ReadonlyArray<ContextCompactionEntryV1>
  readonly pinnedRefs?: ReadonlyArray<string>
}): ContextWindowRewriteV1 {
  return applyContextWindowPlanV1({ entries: input.entries, plan: planContextClearWindowV1(input) })
}
