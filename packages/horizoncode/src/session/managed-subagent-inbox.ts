/** Core-owned durable inbox for messages addressed to a Rust-managed Attempt.
 * Message bytes stay in Core. HostKernel receives only bounded digests and pins. */
import { createHash } from "node:crypto"

export const MANAGED_SUBAGENT_INBOX_MAX_PENDING = 32
export const MANAGED_SUBAGENT_INBOX_MAX_RECEIPTS_PER_ATTEMPT = 256

export type ManagedSubagentInboxStateV1 =
  | "preparing" | "approval_required" | "admitted" | "appended" | "committed"
  | "delivering" | "consumed" | "unknown" | "denied"

export type ManagedSubagentInboxDraftV1 = {
  readonly messageID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly requestID: string
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly ownerEpoch: string
  readonly bindingDigest: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly permissionScopeDigest: string
  readonly payload: string
  readonly payloadDigest: string
  readonly payloadBytes: number
  readonly deliveryMode: "queued" | "follow_up"
  readonly mailboxCapacity: number
}

/** Core proof that one managed inbox row crossed the exact safe prompt boundary. */
export type ManagedSubagentConsumptionProofV1 = {
  readonly messageID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly deliveryMode: "queued" | "follow_up"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly mailboxSequence: string
  readonly inboxReceiptDigest: string
  readonly promptMessageID: string
  readonly consumingAttemptID: string
  readonly consumingOwnerEpoch: string
  readonly consumingRequestID: string
  readonly consumingRequestSequence: string
  readonly deliveryScopeDigest: string
  readonly consumingScopeDigest: string
  readonly wakeClaimReceiptDigest?: string
  readonly consumingWorkspaceID: string
  readonly consumingWorkspaceRevision: string
  readonly consumedPayloadDigest: string
  readonly completedTurnReceiptDigest?: string
  readonly wakeReceiptDigest?: string
  readonly nextRequestSequence?: string
  readonly consumptionAckDigest: string
}

export function managedMessageConsumptionAckDigest(input: Omit<ManagedSubagentConsumptionProofV1, "consumptionAckDigest">): string {
  const canonical = JSON.stringify({
    lane: "managed_attempt",
    messageID: input.messageID,
    parentSessionID: input.parentSessionID,
    childSessionID: input.childSessionID,
    deliveryMode: input.deliveryMode === "queued" ? "queue" : "follow_up",
    goalID: input.goalID,
    runID: input.runID,
    taskID: input.taskID,
    attemptID: input.attemptID,
    mailboxSequence: input.mailboxSequence,
    inboxReceiptDigest: input.inboxReceiptDigest,
    promptMessageID: input.promptMessageID,
    consumingAttemptID: input.consumingAttemptID,
    consumingOwnerEpoch: input.consumingOwnerEpoch,
    deliveryScopeDigest: input.deliveryScopeDigest,
    consumingScopeDigest: input.consumingScopeDigest,
    consumedPayloadDigest: input.consumedPayloadDigest,
    ...(input.deliveryMode === "follow_up" ? {
      completedTurnReceiptDigest: input.completedTurnReceiptDigest,
      wakeReceiptDigest: input.wakeReceiptDigest,
      wakeClaimReceiptDigest: input.wakeClaimReceiptDigest,
      nextRequestSequence: input.nextRequestSequence,
    } : {}),
  })
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`
}

export function managedMessageInboxReceiptDigest(input: ManagedSubagentInboxDraftV1 & {
  readonly mailboxSequence: string
}): string {
  const canonical = JSON.stringify({
    lane: "managed_attempt",
    messageID: input.messageID,
    parentSessionID: input.parentSessionID,
    childSessionID: input.childSessionID,
    deliveryMode: input.deliveryMode === "queued" ? "queue" : "follow_up",
    goalID: input.goalID,
    runID: input.runID,
    taskID: input.taskID,
    attemptID: input.attemptID,
    ownerEpoch: input.ownerEpoch,
    bindingDigest: input.bindingDigest,
    profileID: input.profileID,
    profileRevision: input.profileRevision,
    profileDigest: input.profileDigest,
    permissionScopeDigest: input.permissionScopeDigest,
    payloadDigest: input.payloadDigest,
    payloadBytes: input.payloadBytes,
    mailboxSequence: input.mailboxSequence,
    mailboxCapacity: input.mailboxCapacity,
  })
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`
}
