/** Public caller-authored portion of the HorizonCode agents.message contract.
 * Authority pins and receipts are produced only by authenticated Core/HostKernel.
 */

import { Schema } from "effect"
import { UInt64Decimal } from "./composition-v1"

const Identifier = Schema.String
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/))
const DirectAttemptId = Schema.String.check(Schema.isPattern(/^att_[a-z0-9]{16,64}$/))

export const MAX_MESSAGE_BYTES = 16 * 1024
export const MAX_PENDING_MESSAGES = 32
const PositiveUInt64Decimal = UInt64Decimal.check(Schema.makeFilter((value) =>
  /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) > 0n
    ? undefined
    : "must be a positive canonical unsigned 64-bit decimal string",
))

export interface RequestV1 extends Schema.Schema.Type<typeof RequestV1> {}
export const RequestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  /** Resolved against authenticated parent/child lineage; not an authority pin. */
  childSessionId: Identifier,
  deliveryMode: Schema.Literals(["queued", "follow_up"]),
  content: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(MAX_MESSAGE_BYTES)),
  idempotencyKey: Identifier,
}).check(Schema.makeFilter((value) =>
  new TextEncoder().encode(value.content).byteLength <= MAX_MESSAGE_BYTES
    ? undefined
    : "message content exceeds the UTF-8 byte limit",
)).annotate({ identifier: "Horizon.AgentMessageV1.RequestV1" })

export interface AuthorityPinsV1 extends Schema.Schema.Type<typeof AuthorityPinsV1> {}
export const AuthorityPinsV1 = Schema.Struct({
  parentSessionId: Identifier,
  childSessionId: Identifier,
  childOwnerEpoch: PositiveUInt64Decimal,
  profileId: Identifier,
  profileRevision: PositiveUInt64Decimal,
  profileDigest: Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/)),
  permissionScopeDigest: Schema.String.check(Schema.isPattern(/^(sha256|blake3):[0-9a-f]{64}$/)),
  directAttemptId: DirectAttemptId,
  messageId: Identifier,
  deliveryMode: Schema.Literals(["queued", "follow_up"]),
  payloadDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  payloadBytes: Schema.Number.check(Schema.isInt()).check(Schema.isBetween(1, MAX_MESSAGE_BYTES)),
  mailboxSequence: PositiveUInt64Decimal,
  mailboxCapacity: Schema.Number.check(Schema.isInt()).check(Schema.isBetween(1, MAX_PENDING_MESSAGES)),
}).annotate({ identifier: "Horizon.AgentMessageV1.AuthorityPinsV1" })

export interface ReceiptV1 extends Schema.Schema.Type<typeof ReceiptV1> {}
export const ReceiptV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literals(["QUEUED", "FOLLOW_UP_SCHEDULED", "UNKNOWN"]),
  messageId: Identifier,
  parentSessionId: Identifier,
  childSessionId: Identifier,
  deliveryMode: Schema.Literals(["queued", "follow_up"]),
  mailboxSequence: UInt64Decimal,
  receiptDigest: Schema.String.check(Schema.isPattern(/^(sha256|blake3):[0-9a-f]{64}$/)),
}).annotate({ identifier: "Horizon.AgentMessageV1.ReceiptV1" })

export interface ChildStatusV1 extends Schema.Schema.Type<typeof ChildStatusV1> {}
export const ChildStatusV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Identifier,
  state: Schema.Literals(["queued", "running", "completed", "failed", "cancelled", "unknown"]),
  ownerEpoch: PositiveUInt64Decimal,
  profileId: Identifier,
  profileRevision: PositiveUInt64Decimal,
  profileDigest: Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/)),
  pendingMessages: Schema.Number.check(Schema.isInt()).check(Schema.isBetween(0, MAX_PENDING_MESSAGES)),
  activeRequest: Schema.Boolean,
  lastSequence: UInt64Decimal,
}).annotate({ identifier: "Horizon.AgentMessageV1.ChildStatusV1" })
