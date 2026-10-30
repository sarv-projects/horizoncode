import { createHash } from "node:crypto"

export type DirectSubagentInboxStateV1 =
  | "preparing" | "approval_required" | "admitted" | "appended" | "committed"
  | "delivering" | "consumed" | "unknown" | "denied"

export const DIRECT_SUBAGENT_INBOX_MAX_PENDING = 32
export const DIRECT_SUBAGENT_INBOX_MAX_RECEIPTS_PER_CHILD = 256

export type DirectSubagentInboxDraftV1 = {
  readonly messageId: string
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly requestId: string
  readonly payload: string
  readonly payloadDigest: string
  readonly payloadBytes: number
  readonly deliveryMode: "queue" | "follow_up"
  readonly mailboxSequence?: string
  readonly childAttemptId: string
  readonly childOwnerEpoch: string
  readonly profileId: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly permissionScopeDigest: string
  readonly mailboxCapacity: number
  readonly inboxReceiptDigest: string
}

export function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
}

/** Stable DirectAttempt authorization-scope digest; the full live scope is sent separately. */
export function consumingScopeDigest(scope: {
  readonly scopeDigest: string
}): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(scope.scopeDigest)) throw new Error("DirectAttempt scope digest is malformed")
  return scope.scopeDigest
}

export type DirectInboxConsumptionProofV1 = {
  readonly messageID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly mailboxSequence: string
  readonly inboxReceiptDigest: string
  readonly promptMessageID: string
  readonly consumingAttemptID: string
  readonly consumingOwnerEpoch: string
  readonly consumingScopeDigest: string
  readonly consumedPayloadDigest: string
}

/** Stable SHA-256 identity for replaying the exact Core→HostKernel consume ACK. */
export function consumptionAckDigest(proof: DirectInboxConsumptionProofV1): string {
  return digestText(JSON.stringify({
    messageID: proof.messageID,
    parentSessionID: proof.parentSessionID,
    childSessionID: proof.childSessionID,
    mailboxSequence: proof.mailboxSequence,
    inboxReceiptDigest: proof.inboxReceiptDigest,
    promptMessageID: proof.promptMessageID,
    consumingAttemptID: proof.consumingAttemptID,
    consumingOwnerEpoch: proof.consumingOwnerEpoch,
    consumingScopeDigest: proof.consumingScopeDigest,
    consumedPayloadDigest: proof.consumedPayloadDigest,
  }))
}

export function inboxReceiptDigest(entry: {
  readonly messageID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly deliveryMode: "queued" | "follow_up"
  readonly directAttemptID: string
  readonly childOwnerEpoch: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly permissionScopeDigest: string
  readonly payloadDigest: string
  readonly payloadBytes: number
  readonly mailboxSequence: string
  readonly mailboxCapacity: number
}): string {
  const canonical = JSON.stringify({
    messageID: entry.messageID,
    parentSessionID: entry.parentSessionID,
    childSessionID: entry.childSessionID,
    deliveryMode: entry.deliveryMode,
    directAttemptID: entry.directAttemptID,
    childOwnerEpoch: entry.childOwnerEpoch,
    profileID: entry.profileID,
    profileRevision: entry.profileRevision,
    profileDigest: entry.profileDigest,
    permissionScopeDigest: entry.permissionScopeDigest,
    payloadDigest: entry.payloadDigest,
    payloadBytes: entry.payloadBytes,
    mailboxSequence: entry.mailboxSequence,
    mailboxCapacity: entry.mailboxCapacity,
  })
  return digestText(canonical)
}
