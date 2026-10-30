import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Schema } from "effect"
import { encodeCanonicalMessagePackV1, ManagedProviderStepFinishV1 } from "@horizoncode/schema"
import { SessionMessage } from "@horizoncode/schema/session-message"
import { SessionV1 } from "@horizoncode/core/v1/session"

const RESPONSE_DOMAIN = new TextEncoder().encode("horizoncode.managed-provider-response-step.v2\0")

/**
 * Build the HostKernel receipt only from the exact persisted V1 message and
 * step-finish part. This is a per-dispatch snapshot: later tool results or
 * assistant-message mutations cannot change the receipt.
 */
export function managedProviderStepFinish(input: {
  readonly info: SessionV1.Assistant
  readonly stepFinishPart: unknown
  readonly stepFinishIndex: number
}): {
  readonly stepFinishPart: ManagedProviderStepFinishV1.ManagedProviderStepFinishV1
  readonly responseDigest: string
  readonly usageProvenance: ManagedProviderStepFinishV1.ManagedProviderStepFinishV1["usageProvenance"]
} {
  if (typeof input.info !== "object" || input.info === null || Array.isArray(input.info)) {
    throw new TypeError("managed provider receipt requires a persisted assistant info object")
  }
  const rawInfo = input.info as Record<string, unknown>
  const assistantFields = new Set([
    "id", "sessionID", "role", "time", "parentID", "agent", "modelID", "providerID", "mode",
    "path", "cost", "tokens", "finish", "summary", "error", "variant", "structured", "usageProvenance",
  ])
  if (Object.keys(rawInfo).some((key) => !assistantFields.has(key))) {
    throw new TypeError("managed provider receipt assistant info contains an unsupported persisted field")
  }
  // `usageProvenance` is a known Core projection consumed by analytics, but it
  // is not part of the pinned V1 Assistant schema. The indexed step part below
  // is its authoritative, hashed location.
  const { usageProvenance: infoUsageProvenance, ...assistantInfoProjection } = rawInfo
  const info = Schema.decodeUnknownSync(SessionV1.Assistant, { onExcessProperty: "error" })(assistantInfoProjection)
  if (typeof input.stepFinishPart !== "object" || input.stepFinishPart === null || Array.isArray(input.stepFinishPart)) {
    throw new TypeError("managed provider receipt requires a persisted step-finish object")
  }
  const rawStepFinish = input.stepFinishPart as Record<string, unknown>
  const allowedPersistedFields = new Set([
    "id", "sessionID", "messageID", "type", "reason", "snapshot", "cost", "tokens",
    "stepFinishIndex", "usageProvenance", "managedUsageReceipt",
  ])
  if (Object.keys(rawStepFinish).some((key) => !allowedPersistedFields.has(key))) {
    throw new TypeError("managed provider receipt step-finish contains an unsupported persisted field")
  }
  // managedUsageReceipt is a separate OwnerLog control receipt. Its presence is
  // recognized but intentionally excluded from the provider response digest.
  const { managedUsageReceipt: _managedUsageReceipt, ...stepFinishProjection } = rawStepFinish
  const stepFinishPart = Schema.decodeUnknownSync(ManagedProviderStepFinishV1.ManagedProviderStepFinishV1, { onExcessProperty: "error" })(stepFinishProjection)
  if (infoUsageProvenance !== undefined) {
    const infoProvenance = Schema.decodeUnknownSync(SessionMessage.UsageProvenance, { onExcessProperty: "error" })(infoUsageProvenance)
    const infoBytes = encodeCanonicalMessagePackV1(infoProvenance)
    const stepBytes = encodeCanonicalMessagePackV1(stepFinishPart.usageProvenance)
    if (infoBytes.byteLength !== stepBytes.byteLength || infoBytes.some((byte, index) => byte !== stepBytes[index])) {
      throw new TypeError("assistant analytics provenance differs from the indexed persisted step-finish")
    }
  }
  if (!Number.isSafeInteger(input.stepFinishIndex) || input.stepFinishIndex < 0 || input.stepFinishIndex > 1024 ||
    stepFinishPart.stepFinishIndex !== input.stepFinishIndex ||
    stepFinishPart.messageID !== info.id || stepFinishPart.sessionID !== info.sessionID) {
    throw new TypeError("managed provider receipt does not match the exact persisted assistant step")
  }

  const payload = Schema.decodeUnknownSync(ManagedProviderStepFinishV1.ManagedProviderResponseEntryV2, { onExcessProperty: "error" })({
    assistantInfo: info,
    stepFinishPart,
    stepFinishIndex: input.stepFinishIndex,
  })
  const bytes = encodeCanonicalMessagePackV1(payload, {
    maxEncodedBytes: 2 * 1024 * 1024,
    maxDepth: 32,
    maxNodes: 32_768,
    maxCollectionItems: 16_384,
    maxScalarBytes: 512 * 1024,
  })
  const preimage = new Uint8Array(RESPONSE_DOMAIN.byteLength + bytes.byteLength)
  preimage.set(RESPONSE_DOMAIN)
  preimage.set(bytes, RESPONSE_DOMAIN.byteLength)
  return {
    stepFinishPart,
    responseDigest: `blake3:${bytesToHex(blake3(preimage))}`,
    usageProvenance: stepFinishPart.usageProvenance,
  }
}
