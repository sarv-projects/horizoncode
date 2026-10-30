/** Bounded text search and line-range projection over verified HostKernel artifacts. */
import { Effect, Option, Schema, Scope } from "effect"
import { AbsolutePath } from "@horizoncode/core/schema"
import { Location as LocationSchema } from "@horizoncode/schema"
import { InstanceState } from "@/effect/instance-state"
import type { ArtifactRefWireV1, DirectAttemptScopeV1 } from "@horizoncode/core/session/supervisor"
import { SessionSupervisor } from "@horizoncode/core/session/supervisor"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { sameManagedAttemptScope, type ManagedAttemptAuthority } from "@/session/managed-control"
import * as ArtifactControl from "../session/artifact-control"
import * as Tool from "./tool"
import { makeArtifactLineMatcher, withArtifactRegexPermit } from "./artifact-search"

const CHUNK_BYTES = 512 * 1024
const MAX_LINE_BYTES = 64 * 1024
const DEFAULT_SCAN_BYTES = 128 * 1024 * 1024
const MAX_SCAN_BYTES = 256 * 1024 * 1024
const MAX_DURATION_MS = 60_000
const DEFAULT_DURATION_MS = 10_000
const MAX_RESULTS = 100
const MAX_EXCERPT_BYTES = 2_048
const MAX_SEARCH_OUTPUT_BYTES = 32 * 1024
const MAX_RANGE_TEXT_BYTES = 60 * 1024

type SearchMetadata = {
  readonly status: string
  readonly generation: string
  readonly fidelity: "FAILED" | "FULL" | "SAMPLE"
  readonly redaction: "APPLIED" | "NOT_NEEDED" | "UNKNOWN"
  readonly classification: "public" | "sensitive" | "workspace"
  readonly count: number
  readonly scannedBytes: number
} | {
  readonly status: "UNAVAILABLE"
  readonly reason: string
}

type RangeMetadata = {
  readonly status: string
  readonly generation: string
  readonly lineStart: number
  readonly lineEndExclusive: number
  readonly bytes: number
  readonly invalidUtf8LinesSkipped: number
  readonly fidelity: "FAILED" | "FULL" | "SAMPLE"
  readonly redaction: "APPLIED" | "NOT_NEEDED" | "UNKNOWN"
  readonly classification: "public" | "sensitive" | "workspace"
} | {
  readonly status: "UNAVAILABLE"
  readonly reason: string
}

/**
 * Fail-closed results, typed once at their exact metadata shape so the
 * `UNAVAILABLE` status stays the literal the API contract exposes.
 */
const SEARCH_READ_UNAVAILABLE: Tool.ExecuteResult<SearchMetadata> = {
  title: "Artifact search unavailable",
  metadata: { status: "UNAVAILABLE", reason: "authenticated_artifact_read_unavailable" },
  output: "status: UNAVAILABLE\nreason: authenticated artifact read failed",
}
const RANGE_READ_UNAVAILABLE: Tool.ExecuteResult<RangeMetadata> = {
  title: "Artifact range unavailable",
  metadata: { status: "UNAVAILABLE", reason: "authenticated_artifact_read_unavailable" },
  output: "status: UNAVAILABLE\nreason: authenticated artifact read failed",
}
const RANGE_ORDER_UNAVAILABLE: Tool.ExecuteResult<RangeMetadata> = {
  title: "Artifact range unavailable",
  metadata: { status: "UNAVAILABLE", reason: "lineEndExclusive must be greater than lineStart" },
  output: "status: UNAVAILABLE\nreason: lineEndExclusive must be greater than lineStart",
}

/**
 * The principal the HostKernel artifact reads must run under: the live
 * `TrustedPrincipalContext` of the current execution when one is present,
 * otherwise the per-call authenticated identity captured on the tool context.
 * Neither source means the read cannot be authorized, so it stays unavailable
 * instead of running without an authenticated principal.
 */
const authenticatedPrincipal = (ctx: Tool.Context) =>
  Effect.gen(function* () {
    const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
    if (Option.isSome(authenticated)) return authenticated.value
    return ctx.trustedPrincipal === undefined ? undefined : { principal: ctx.trustedPrincipal }
  })

const ArtifactRef = Schema.Struct({
  artifactId: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
  digest: Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/)),
  byteLength: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/)),
  mediaType: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
  classification: Schema.Literals(["public", "workspace", "sensitive"]),
})

const SearchParameters = Schema.Struct({
  artifactRef: ArtifactRef,
  query: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
  mode: Schema.optional(Schema.Literals(["literal", "regex"])),
  flags: Schema.optional(Schema.String.check(Schema.isMaxLength(3))),
  maxResults: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RESULTS }))),
  maxScanBytes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SCAN_BYTES }))),
  maxDurationMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_DURATION_MS }))),
})

const RangeParameters = Schema.Struct({
  artifactRef: ArtifactRef,
  lineStart: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  lineEndExclusive: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  maxBytes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RANGE_TEXT_BYTES }))),
})

type Ref = typeof ArtifactRef.Type
type Line = { readonly number: number; readonly byteOffset: number; readonly bytes: Buffer; readonly terminated: boolean }

const isTextArtifact = (mediaType: string) => {
  const normalized = mediaType.toLowerCase().split(";", 1)[0]!.trim()
  return normalized.startsWith("text/") || new Set([
    "application/json", "application/x-ndjson", "application/xml", "application/yaml",
    "application/toml", "application/javascript", "application/x-sh",
  ]).has(normalized)
}

const safeDisplay = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, (char) => {
  const code = char.codePointAt(0) ?? 0
  return `\\x${code.toString(16).padStart(2, "0")}`
})

const asRef = (value: Ref): ArtifactRefWireV1 => ({
  artifactId: value.artifactId,
  digest: value.digest,
  byteLength: value.byteLength,
  mediaType: value.mediaType,
  classification: value.classification,
})

const authorizeArtifact = Effect.fn("ManagedArtifactSearch.authorize")(function* (ctx: Tool.Context, ref: Ref, locationRef: typeof LocationSchema.Ref.Type) {
  const directAuthority = ctx.extra?.directAttempt as { readonly currentScope?: () => DirectAttemptScopeV1 } | undefined
  const managedAuthority = ctx.extra?.managedAttempt as ManagedAttemptAuthority | undefined
  if (directAuthority && managedAuthority) {
    return yield* Effect.fail(new Error("Artifact search denied: ambiguous Attempt authority"))
  }
  let scope: ArtifactControl.ArtifactReadScopeV1
  if (directAuthority && typeof directAuthority.currentScope === "function") {
    scope = yield* Effect.try({
      try: () => ArtifactControl.directAttemptReadScope({ sessionID: ctx.sessionID, directAttempt: directAuthority as { readonly currentScope: () => DirectAttemptScopeV1 } }),
      catch: (error) => error instanceof Error ? error : new Error("Direct Attempt artifact scope is unavailable"),
    })
  } else if (managedAuthority && typeof managedAuthority.currentScope === "function") {
    const current = managedAuthority.currentScope()
    if (current.sessionID !== ctx.sessionID) {
      return yield* Effect.fail(new Error("Artifact search denied: managed Attempt does not own the current Session"))
    }
    const resolved = yield* ArtifactControl.resolveVerifiedScope({
      sessionID: ctx.sessionID,
      locationRef,
      artifactRef: asRef(ref),
    })
    if (!("managedAttempt" in resolved) || !sameManagedAttemptScope(current, resolved.managedAttempt)) {
      return yield* Effect.fail(new Error("Artifact search denied: artifact is not bound to the current managed Attempt revision"))
    }
    scope = resolved
  } else {
    const directSessionScope = yield* ArtifactControl.directSessionReadScope({
      sessionID: ctx.sessionID,
      locationRef,
      artifactRef: asRef(ref),
    })
    if (!directSessionScope) {
      return yield* Effect.fail(new Error("Artifact search denied: no artifact receipt is bound to this root Session"))
    }
    scope = directSessionScope
  }
  if (BigInt(ref.byteLength) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return yield* Effect.fail(new Error("Artifact byte length exceeds the safe bounded reader range"))
  }
  const metadata = yield* ArtifactControl.inspect(scope, asRef(ref))
  if (metadata.redaction === "UNKNOWN") {
    return yield* Effect.fail(new Error("Artifact search is unavailable because redaction status is unknown"))
  }
  if (metadata.fidelity === "FAILED") {
    return yield* Effect.fail(new Error("Artifact search is unavailable because artifact capture failed"))
  }
  if (metadata.artifactRef.classification === "sensitive") {
    return yield* Effect.fail(new Error("Sensitive artifacts are not exposed to model search"))
  }
  if (!isTextArtifact(metadata.artifactRef.mediaType)) {
    return yield* Effect.fail(new Error("Artifact search supports text artifacts only"))
  }
  return { scope, metadata, ref: asRef(ref) }
})

/** Read sequential HostKernel ranges and yield bounded lines without buffering the artifact. */
const scanLines = (input: {
  readonly scope: ArtifactControl.ArtifactReadScopeV1
  readonly ref: ArtifactRefWireV1
  readonly limitBytes: number
  readonly deadline: number
  readonly signal: AbortSignal
  readonly onLine: (line: Line) => Effect.Effect<boolean, Error, Scope.Scope>
  readonly onLongLine: () => void
}) => Effect.gen(function* () {
  const totalBytes = BigInt(input.ref.byteLength)
  let offset = 0
  let pending = Buffer.alloc(0)
  let pendingOffset = 0
  let lineNumber = 0
  let lineTooLong = false
  let longLinesSkipped = 0
  let stop: "eof" | "result_limit" | "scan_limit" | "deadline" | "cancelled" | "incomplete_read" = "eof"

  while (BigInt(offset) < (totalBytes < BigInt(input.limitBytes) ? totalBytes : BigInt(input.limitBytes))) {
    if (input.signal.aborted) { stop = "cancelled"; break }
    if (Date.now() >= input.deadline) { stop = "deadline"; break }
    const remainingTotal = Number(totalBytes - BigInt(offset))
    const take = Math.min(CHUNK_BYTES, input.limitBytes - offset, remainingTotal)
    const range = yield* ArtifactControl.readRange(input.scope, input.ref, String(offset), take)
    if (range.bytes.byteLength === 0 || range.nextOffset === String(offset)) {
      stop = "incomplete_read"
      break
    }
    const chunk = Buffer.from(range.bytes)
    offset = Number(BigInt(range.nextOffset))
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])

    let cursor = 0
    while (true) {
      const newline = pending.indexOf(0x0a, cursor)
      if (newline < 0) break
      if (lineTooLong || newline - cursor > MAX_LINE_BYTES) {
        longLinesSkipped++
        input.onLongLine()
      } else {
        const bytes = pending.subarray(cursor, newline)
        const keepGoing = yield* input.onLine({ number: lineNumber, byteOffset: pendingOffset + cursor, bytes, terminated: true })
        if (!keepGoing) { stop = "result_limit"; break }
      }
      lineNumber++
      cursor = newline + 1
      lineTooLong = false
    }
    if (stop === "result_limit") break
    if (cursor > 0) {
      pending = pending.subarray(cursor)
      pendingOffset += cursor
    }
    if (lineTooLong && pending.length > 0) {
      pendingOffset += pending.length
      pending = Buffer.alloc(0)
    } else if (!lineTooLong && pending.length > MAX_LINE_BYTES) {
      pendingOffset += pending.length
      pending = Buffer.alloc(0)
      lineTooLong = true
    }
  }

  if (stop === "eof" && BigInt(offset) >= totalBytes && pending.length > 0) {
    if (lineTooLong || pending.length > MAX_LINE_BYTES) {
      longLinesSkipped++
      input.onLongLine()
    } else {
      yield* input.onLine({ number: lineNumber, byteOffset: pendingOffset, bytes: pending, terminated: false })
    }
  } else if (stop === "eof" && BigInt(offset) < totalBytes) {
    stop = offset >= input.limitBytes ? "scan_limit" : "incomplete_read"
  }
  return { stop, scannedBytes: offset, totalBytes: totalBytes.toString(), longLinesSkipped }
})

const excerpt = (line: Buffer, index: number) => {
  const start = Math.max(0, index - 16)
  const text = safeDisplay(line.subarray(start, start + MAX_EXCERPT_BYTES).toString("utf8"))
  return { text, excerptTruncated: start > 0 || line.length > start + MAX_EXCERPT_BYTES }
}

const searchTool = (name: "artifacts_search_text" | "terminal_search", capabilityID: "artifacts.search_text" | "terminal.search") => Tool.define(
  name,
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    return {
    description: "Search a verified managed or direct-child terminal artifact using bounded HostKernel range reads. Sensitive or redaction-unknown artifacts are unavailable.",
    parameters: SearchParameters,
    capability: { id: capabilityID, effectClass: "read_only" },
    execute: (params: typeof SearchParameters.Type, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<SearchMetadata>> => Effect.gen(function* () {
      yield* ctx.ask({ permission: "read", patterns: [`artifact:${params.artifactRef.artifactId}`], always: [], metadata: { artifactId: params.artifactRef.artifactId } })
      const principal = yield* authenticatedPrincipal(ctx)
      if (principal === undefined) return SEARCH_READ_UNAVAILABLE
      return yield* Effect.gen(function* () {
      // Per-directory state is resolved here, inside the deferred execute path,
      // so ToolRegistry materialization never depends on an InstanceRef.
      const instance = yield* InstanceState.context
      const locationRef = LocationSchema.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      const authorized = yield* authorizeArtifact(ctx, params.artifactRef, locationRef)
      const mode = params.mode ?? "literal"
      const flags = params.flags ?? ""
      const maxResults = Math.min(params.maxResults ?? 50, MAX_RESULTS)
      const maxScanBytes = Math.min(params.maxScanBytes ?? DEFAULT_SCAN_BYTES, MAX_SCAN_BYTES)
      const maxDurationMs = Math.min(params.maxDurationMs ?? DEFAULT_DURATION_MS, MAX_DURATION_MS)
      const deadline = Date.now() + maxDurationMs
      const matches: Array<{ line: number; byteOffset: number; text: string; excerptTruncated: boolean }> = []
      let invalidUtf8LinesSkipped = 0
      let matcherTimedOut = false
      let outputLimitHit = false
      let renderedBytes = 512
      const operation = Effect.scoped(Effect.gen(function* () {
        const matcher = yield* makeArtifactLineMatcher(params.query, mode, flags, deadline, () => Date.now())
        const scan = yield* scanLines({
          scope: authorized.scope,
          ref: authorized.ref,
          limitBytes: maxScanBytes,
          deadline,
          signal: ctx.abort,
          onLongLine: () => {},
          onLine: (line) => {
            let text: string
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(line.bytes)
            } catch {
              invalidUtf8LinesSkipped++
              return Effect.succeed(true)
            }
            return Effect.gen(function* () {
              const lineBytes = Buffer.from(text, "utf8")
              const found = yield* matcher.index(lineBytes)
              if (found.kind === "deadline") {
                matcherTimedOut = true
                return false
              }
              if (found.index !== undefined) {
                const match = { line: line.number, byteOffset: line.byteOffset, ...excerpt(lineBytes, found.index) }
                const rowBytes = Buffer.byteLength(`line ${match.line} @ byte ${match.byteOffset}: ${match.text}\n`, "utf8")
                if (renderedBytes + rowBytes + 64 > MAX_SEARCH_OUTPUT_BYTES) {
                  outputLimitHit = true
                  return false
                }
                matches.push(match)
                renderedBytes += rowBytes
                return matches.length < maxResults
              }
              return true
            })
          },
        })
        if (scan.stop === "cancelled") return yield* Effect.interrupt
        return scan
      }))
      const scan = yield* (mode === "regex" ? withArtifactRegexPermit(operation) : operation)
      const scanStop = matcherTimedOut ? "deadline" : outputLimitHit ? "output_limit" : scan.stop
      const freshness = scanStop === "eof" ? "current" : "partial"
      const output = [
        `status: ${freshness === "current" ? "COMPLETE" : "PARTIAL"}`,
        `generation: ${authorized.ref.digest}`,
        `fidelity: ${authorized.metadata.fidelity}; redaction: ${authorized.metadata.redaction}; classification: ${authorized.metadata.artifactRef.classification}`,
        `scannedBytes: ${scan.scannedBytes}; totalBytes: ${scan.totalBytes}; longLinesSkipped: ${scan.longLinesSkipped}; invalidUtf8LinesSkipped: ${invalidUtf8LinesSkipped}`,
        ...matches.map((match) => `line ${match.line} @ byte ${match.byteOffset}: ${match.text}${match.excerptTruncated ? " …" : ""}`),
        ...(scanStop !== "eof" ? [`truncatedBy: ${scanStop}`] : []),
      ].join("\n")
      return { title: `Artifact search: ${params.query}`, metadata: { status: freshness, generation: authorized.ref.digest, fidelity: authorized.metadata.fidelity, redaction: authorized.metadata.redaction, classification: authorized.metadata.artifactRef.classification, count: matches.length, scannedBytes: scan.scannedBytes }, output }
      }).pipe(
        Effect.catch(() => Effect.succeed(SEARCH_READ_UNAVAILABLE)),
        Effect.provideService(TrustedPrincipalContext, principal),
      )
      }).pipe(Effect.provideService(SessionSupervisor.Service, supervisor)),
    }
  }),
)

export const ManagedArtifactSearchTool = searchTool("artifacts_search_text", "artifacts.search_text")
export const ManagedTerminalSearchTool = searchTool("terminal_search", "terminal.search")

export const ManagedTerminalOutputRangeTool = Tool.define(
  "terminal_output_range",
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    return {
    description: "Read a bounded zero-based half-open line range from a verified managed text artifact using HostKernel range reads.",
    parameters: RangeParameters,
    capability: { id: "terminal.output_range", effectClass: "read_only" },
    execute: (params: typeof RangeParameters.Type, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<RangeMetadata>> => Effect.gen(function* () {
      if (params.lineEndExclusive <= params.lineStart) return RANGE_ORDER_UNAVAILABLE
      yield* ctx.ask({ permission: "read", patterns: [`artifact:${params.artifactRef.artifactId}`], always: [], metadata: { artifactId: params.artifactRef.artifactId, lineStart: params.lineStart, lineEndExclusive: params.lineEndExclusive } })
      const principal = yield* authenticatedPrincipal(ctx)
      if (principal === undefined) return RANGE_READ_UNAVAILABLE
      return yield* Effect.gen(function* () {
      // Per-directory state is resolved here, inside the deferred execute path,
      // so ToolRegistry materialization never depends on an InstanceRef.
      const instance = yield* InstanceState.context
      const locationRef = LocationSchema.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      const authorized = yield* authorizeArtifact(ctx, params.artifactRef, locationRef)
      const maxBytes = Math.min(params.maxBytes ?? MAX_RANGE_TEXT_BYTES, MAX_RANGE_TEXT_BYTES)
      const lines: string[] = []
      let bytes = 0
      let effectiveEnd = params.lineStart
      let truncated = false
      let invalidUtf8LinesSkipped = 0
      const deadline = Date.now() + DEFAULT_DURATION_MS
      const scan = yield* Effect.scoped(scanLines({
        scope: authorized.scope, ref: authorized.ref, limitBytes: DEFAULT_SCAN_BYTES, deadline, signal: ctx.abort, onLongLine: () => {},
        onLine: (line) => {
          if (line.number < params.lineStart) return Effect.succeed(true)
          if (line.number >= params.lineEndExclusive) return Effect.succeed(false)
          let decoded: string
          try {
            decoded = new TextDecoder("utf-8", { fatal: true }).decode(line.bytes)
          } catch {
            invalidUtf8LinesSkipped++
            effectiveEnd = line.number + 1
            return Effect.succeed(true)
          }
          return Effect.sync(() => {
            const lineText = decoded + (line.terminated ? "\n" : "")
            const size = Buffer.byteLength(lineText, "utf8")
            if (bytes + size > maxBytes) { truncated = true; return false }
            effectiveEnd = line.number + 1
            lines.push(lineText)
            bytes += size
            return line.number + 1 < params.lineEndExclusive
          })
        },
      }))
      if (scan.stop === "cancelled") return yield* Effect.interrupt
      const status = scan.stop === "eof" || scan.stop === "result_limit" ? "COMPLETE" : "PARTIAL"
      return {
        title: `Artifact lines ${params.lineStart}–${params.lineEndExclusive}`,
        metadata: { status: truncated || invalidUtf8LinesSkipped > 0 ? "PARTIAL" : status, generation: authorized.ref.digest, lineStart: params.lineStart, lineEndExclusive: effectiveEnd, bytes, invalidUtf8LinesSkipped, fidelity: authorized.metadata.fidelity, redaction: authorized.metadata.redaction, classification: authorized.metadata.artifactRef.classification },
        output: [`status: ${truncated || invalidUtf8LinesSkipped > 0 || status === "PARTIAL" ? "PARTIAL" : "COMPLETE"}`, `generation: ${authorized.ref.digest}`, `fidelity: ${authorized.metadata.fidelity}; redaction: ${authorized.metadata.redaction}; classification: ${authorized.metadata.artifactRef.classification}`, `lines: [${params.lineStart}, ${effectiveEnd})`, `invalidUtf8LinesSkipped: ${invalidUtf8LinesSkipped}`, ...lines.map((line) => safeDisplay(line.replace(/\n$/u, ""))), ...(truncated ? ["truncatedBy: bytes"] : scan.stop !== "eof" && scan.stop !== "result_limit" ? [`truncatedBy: ${scan.stop}`] : [])].join("\n"),
      }
      }).pipe(
        Effect.catch(() => Effect.succeed(RANGE_READ_UNAVAILABLE)),
        Effect.provideService(TrustedPrincipalContext, principal),
      )
      }).pipe(Effect.provideService(SessionSupervisor.Service, supervisor)),
    }
  }),
)
