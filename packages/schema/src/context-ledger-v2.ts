/** Read-only, request-bound projection of the model-visible context. */
import { Schema } from "effect"
import { ContextCompilePolicyV1 } from "./context-compile-policy-v1"
import { ContextSelectionV1 } from "./context-selection-v1"
import { SessionID } from "./session-id"

const Digest = Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/))
const Opaque = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(512))
const DecimalU64 = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/))
const BoundedCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 }))

export const ContextEntryKindV2 = Schema.Literals([
  "system", "goal", "user", "assistant", "thinking", "tool_call", "tool_result", "file", "symbol",
  "artifact", "image", "document", "skill", "memory", "subagent_result", "environment",
])

const ContextLedgerEntryV2 = Schema.Struct({
  entryID: Opaque,
  kind: ContextEntryKindV2,
  sourceRef: Opaque,
  sourceRevision: Schema.optional(Opaque),
  trust: Schema.Literals(["system", "user", "workspace", "external", "mixed"]),
  bytes: Schema.optional(BoundedCount),
  bytesKind: Schema.Literals(["exact", "estimated", "unknown"]),
  tokens: Schema.Struct({
    kind: Schema.Literals(["exact", "estimated", "unknown"]),
    value: Schema.optional(BoundedCount),
    tokenizerID: Schema.optional(Opaque),
  }).check(Schema.makeFilter((tokens) => {
    if (tokens.kind === "unknown" && tokens.value !== undefined) return "unknown token evidence must not include a numeric value"
    if (tokens.kind !== "unknown" && tokens.value === undefined) return "exact or estimated token evidence requires a value"
    if (tokens.kind === "exact" && tokens.tokenizerID === undefined) return "exact token evidence requires a tokenizer ID"
    return undefined
  })),
  included: Schema.Boolean,
  inclusionReason: Schema.optional(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256))),
  protected: Schema.Boolean,
  cacheClass: Schema.optional(Schema.Literals(["static", "history", "turn", "attachment", "none"])),
  freshness: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  digest: Digest,
}).check(Schema.makeFilter((entry) => {
  if (entry.bytesKind === "unknown" && entry.bytes !== undefined) return "unknown byte evidence must not include a numeric value"
  if (entry.bytesKind !== "unknown" && entry.bytes === undefined) return "exact or estimated byte evidence requires a value"
  if (entry.included && entry.inclusionReason === undefined) return "included context entries require an inclusion reason"
  return undefined
}))
export type ContextLedgerEntryV2 = typeof ContextLedgerEntryV2.Type

export const ContextLedgerV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  lane: Schema.Literals(["direct", "managed"]),
  sessionID: SessionID.check(Schema.isPattern(/^ses_[A-Za-z0-9_-]{1,128}$/)),
  requestID: Opaque,
  sourceRevision: DecimalU64,
  providerID: Opaque,
  modelID: Opaque,
  harnessID: Opaque,
  harnessRevision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  requestPayloadDigest: Digest,
  requestBytes: BoundedCount,
  contextSelection: ContextSelectionV1,
  contextSelectionDigest: Schema.optional(Digest),
  entries: Schema.Array(ContextLedgerEntryV2).check(Schema.isMaxLength(512)),
  completeness: Schema.Literals(["complete", "partial"]),
  partialReason: Schema.optional(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256))),
  /**
   * §30.26 compile tier, bound into the ledger digest by Core. Optional to
   * match the canonical `arch_V1/contracts-v2/context-ledger-v2.schema.json`
   * (`compilePolicy` is not required); without this mirror field the strict
   * typed decode strips or rejects the policy P3 attaches.
   */
  compilePolicy: Schema.optional(ContextCompilePolicyV1),
}).check(Schema.makeFilter((ledger) => {
  if ((ledger.completeness === "partial") !== (ledger.partialReason !== undefined)) return "partial ledger completeness requires exactly one reason"
  if (ledger.lane === "managed" && ledger.contextSelection.attemptID === undefined) return "managed ledger requires an Attempt-bound ContextSelection"
  if (ledger.lane === "managed" && ledger.contextSelectionDigest === undefined) return "managed ledger requires the exact HostKernel ContextSelection digest"
  const selection = ledger.contextSelection
  if (selection.sessionID !== ledger.sessionID || selection.requestID !== ledger.requestID || selection.sourceRevision !== ledger.sourceRevision) {
    return "ledger identity and revision must match its ContextSelection"
  }
  if (selection.lane !== ledger.lane) return "ledger lane must match ContextSelection authority"
  const refs = new Set(selection.sources.map((source) => `${source.kind}:${source.sourceID}`))
  if (new Set(ledger.entries.map((entry) => entry.entryID)).size !== ledger.entries.length) return "ContextLedger entry IDs must be unique"
  if (ledger.entries.some((entry) => entry.included && !refs.has(entry.sourceRef))) return "included entries must reference a pinned ContextSelection source"
  return undefined
}))
export type ContextLedgerV2 = typeof ContextLedgerV2.Type
