/** Pure compiler for the read-only, exact-request ContextLedger projection. */
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Schema } from "effect"
import {
  ContextLedgerV2,
  type ContextLedgerEntryV2,
  type ContextLedgerV2 as ContextLedgerValueV2,
} from "@opencode-ai/schema/context-ledger-v2"
import type { ContextSelectionV1 as ContextSelectionValueV1 } from "@opencode-ai/schema/context-selection-v1"

const MAX_NODES = 20_000
const MAX_DEPTH = 24

export type ContextLedgerCompileInputV2 = {
  readonly lane: "direct" | "managed"
  readonly sessionID: string
  readonly requestID: string
  readonly sourceRevision: string
  readonly providerID: string
  readonly modelID: string
  readonly harnessID: string
  readonly harnessRevision: number
  /** BLAKE3 over P7's exact bounded canonical LanguageModelV3CallOptions.params. */
  readonly requestPayloadDigest: string
  readonly requestBytes: number
  readonly contextSelection?: ContextSelectionValueV1
  /** Managed lane supplies the exact HostKernel receipt digest for this selection. */
  readonly contextSelectionDigest?: string
  readonly entries?: ReadonlyArray<ContextLedgerEntryV2>
  readonly completeness?: "complete" | "partial"
  readonly partialReason?: string
}

export type CompiledContextLedgerV2 = {
  readonly ledger: ContextLedgerValueV2
  readonly ledgerDigest: string
}

function canonicalJson(value: unknown): string {
  let nodes = 0
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new RangeError("ContextLedger exceeds its canonicalization bound")
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || item < 0) throw new TypeError("ContextLedger contains an invalid numeric value")
      return item
    }
    if (Array.isArray(item)) return item.map((value) => visit(value, depth + 1))
    if (typeof item === "object") {
      const output: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(item as Record<string, unknown>).toSorted()) {
        const value = (item as Record<string, unknown>)[key]
        if (value !== undefined) output[key] = visit(value, depth + 1)
      }
      return output
    }
    throw new TypeError("ContextLedger contains a non-serializable value")
  }
  return JSON.stringify(visit(value, 0))
}

const digestJson = (value: unknown) => `blake3:${bytesToHex(blake3(new TextEncoder().encode(canonicalJson(value))))}`

/**
 * Build a typed projection for one exact provider request. The raw request and
 * credentials never enter this API or the returned ledger. Direct Core callers
 * supply the request-bound ContextSelection compiled from the exact prompt and
 * provider payload; managed callers additionally supply HostKernel's digest.
 */
export function compileContextLedgerV2(input: ContextLedgerCompileInputV2): CompiledContextLedgerV2 {
  let entries = input.entries ? [...input.entries] : []
  let completeness = input.completeness ?? "complete"
  let partialReason = input.partialReason

  if (!input.contextSelection) {
    throw new TypeError("ContextLedger requires an exact ContextSelection in every lane")
  }
  const selection = input.contextSelection
  if (selection.sessionID !== input.sessionID || selection.requestID !== input.requestID || selection.sourceRevision !== input.sourceRevision) {
    throw new TypeError("ContextLedger identity differs from its ContextSelection")
  }
  if (selection.lane !== input.lane) {
    throw new TypeError("ContextLedger lane differs from its ContextSelection authority")
  }
  if (input.lane === "managed" && !input.contextSelectionDigest) {
    throw new TypeError("managed ContextLedger requires the exact HostKernel ContextSelection digest")
  }
  const refs = new Set(selection.sources.map((source) => `${source.kind}:${source.sourceID}`))
  if (entries.some((entry) => entry.included && !refs.has(entry.sourceRef))) {
    throw new TypeError("ContextLedger entry does not match a pinned ContextSelection source")
  }
  const represented = new Set(entries.filter((entry) => entry.included).map((entry) => entry.sourceRef))
  if (selection.sources.some((source) => !represented.has(`${source.kind}:${source.sourceID}`))) {
    throw new TypeError("ContextLedger omits an included ContextSelection source")
  }

  const ledger = Schema.decodeUnknownSync(ContextLedgerV2, { onExcessProperty: "error" })({
    schemaVersion: 2,
    lane: input.lane,
    sessionID: input.sessionID,
    requestID: input.requestID,
    sourceRevision: input.sourceRevision,
    providerID: input.providerID,
    modelID: input.modelID,
    harnessID: input.harnessID,
    harnessRevision: input.harnessRevision,
    requestPayloadDigest: input.requestPayloadDigest,
    requestBytes: input.requestBytes,
    contextSelection: input.contextSelection,
    ...(input.contextSelectionDigest ? { contextSelectionDigest: input.contextSelectionDigest } : {}),
    entries,
    completeness,
    ...(partialReason ? { partialReason } : {}),
  })
  return { ledger, ledgerDigest: digestJson(ledger) }
}
