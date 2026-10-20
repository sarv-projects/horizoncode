import { createHash } from "node:crypto"
import { Schema } from "effect"
import { ContextSelectionV1, type ContextSelectionModeV1 } from "@opencode-ai/schema/context-selection-v1"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const MAX_SOURCES = 64
const MAX_SOURCE_BYTES = 256 * 1024

/** Builds immutable refs from the canonical Session context; no message payload crosses this boundary. */
export const compile = (input: {
  readonly sessionID: SessionSchema.ID
  readonly mode: ContextSelectionModeV1
  readonly sourceRevision: number
  readonly messages: readonly SessionMessage.Message[]
}) => {
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0) {
    throw new RangeError("Session context revision is invalid")
  }
  const selected = input.mode === "fresh" ? [] : input.messages.slice(-MAX_SOURCES)
  const sources = selected.map((message) => {
    const bytes = Buffer.from(JSON.stringify(encodeMessage(message)), "utf8")
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new RangeError("Session context source exceeds its bound")
    return {
      kind: "session-message" as const,
      messageID: message.id,
      contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }
  })
  return Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })({
    schemaVersion: 1,
    sessionID: input.sessionID,
    mode: input.mode,
    sourceRevision: String(input.sourceRevision),
    sources,
  })
}
