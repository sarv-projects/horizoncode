export type PartDeltaStreamIdentityV1 = {
  sessionID: string
  messageID: string
  partID: string
  field: string
}

export type PartDeltaCursorV1 = {
  sequence: number
  offset: number
  sourceGeneration: string
}

/** Source-owned event ordinals and separate UTF-16 edit offsets for legacy deltas. */
export function createPartDeltaCursorV1() {
  const cursors = new Map<string, { sequence: number; offset: number; sourceGeneration: string }>()
  const key = (identity: PartDeltaStreamIdentityV1) =>
    JSON.stringify([identity.sessionID, identity.messageID, identity.partID, identity.field])

  return {
    begin(identity: PartDeltaStreamIdentityV1) {
      cursors.set(key(identity), { sequence: 0, offset: 0, sourceGeneration: randomUUID() })
    },
    append(identity: PartDeltaStreamIdentityV1, delta: string): PartDeltaCursorV1 | undefined {
      const id = key(identity)
      const current = cursors.get(id)
      if (
        !current ||
        !Number.isSafeInteger(current.sequence + 1) ||
        !Number.isSafeInteger(current.offset + delta.length)
      ) return
      const result = {
        sequence: current.sequence,
        offset: current.offset,
        sourceGeneration: current.sourceGeneration,
      }
      current.sequence++
      current.offset += delta.length
      return result
    },
    end(identity: PartDeltaStreamIdentityV1) {
      cursors.delete(key(identity))
    },
  }
}
import { randomUUID } from "node:crypto"

