/** Attempt-pinned references to the bounded context Core selected from its canonical Session. */

import { Schema } from "effect"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

const Digest = Schema.String.check(Schema.isPattern(/^(?:sha256:[0-9a-f]{64}|blake3:[0-9a-f]{64})$/))
const DecimalU64 = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/))

export const ContextSelectionSourceV1 = Schema.Struct({
  kind: Schema.Literal("session-message"),
  messageID: SessionMessage.ID,
  contentDigest: Digest,
})

export const ContextSelectionModeV1 = Schema.Literals(["fresh", "conversation_slice", "fork"])
export type ContextSelectionModeV1 = typeof ContextSelectionModeV1.Type

export const ContextSelectionV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionID: SessionID.check(Schema.isPattern(/^ses_[A-Za-z0-9_-]{1,128}$/)),
  mode: ContextSelectionModeV1,
  /** Latest durable Session aggregate cursor observed by Core when compiling this selection. */
  sourceRevision: DecimalU64,
  /** Ordered as selected by Core; Rust computes the immutable selection digest. */
  sources: Schema.Array(ContextSelectionSourceV1).check(Schema.isMaxLength(64)),
}).check(Schema.makeFilter((selection) => {
  const max = "18446744073709551615"
  if (
    selection.sourceRevision.length > max.length ||
    (selection.sourceRevision.length === max.length && selection.sourceRevision > max)
  ) return "sourceRevision exceeds u64"
  if (selection.mode === "fresh" && selection.sources.length !== 0) return "fresh selection cannot include parent messages"
  if (selection.mode !== "fresh" && selection.sources.length === 0) return "non-fresh selection requires at least one source"
  const ids = selection.sources.map((source) => source.messageID)
  if (new Set(ids).size !== ids.length) return "context source message IDs must be unique"
  return undefined
}))

export type ContextSelectionV1 = typeof ContextSelectionV1.Type
