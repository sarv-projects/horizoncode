/** Bounded read-only projection of direct Core child Sessions for owner TUI views. */

export * as SubagentStatusV1 from "./subagent-status-v1"

import { Schema } from "effect"
import { UInt64Decimal } from "./composition-v1"
import { SessionID } from "./session-id"

const Identifier = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256))
const Digest = Schema.String.check(Schema.isPattern(/^(sha256|blake3):[0-9a-f]{64}$/))
const ProfileDigest = Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/))
const ProfileRevision = UInt64Decimal.check(Schema.makeFilter((value) =>
  /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) > 0n
    ? undefined
    : "must be a positive canonical unsigned 64-bit decimal string",
))

export interface ChildV1 extends Schema.Schema.Type<typeof ChildV1> {}
export const ChildV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: SessionID,
  parentSessionId: SessionID,
  title: Schema.String.check(Schema.isMaxLength(512)),
  state: Schema.Literals(["running", "completed", "failed", "cancelled", "unknown"]),
  activeRequest: Schema.Boolean,
  profileId: Identifier,
  profileRevision: ProfileRevision,
  profileDigest: ProfileDigest,
  permissionScopeDigest: Digest,
  directAttemptId: Identifier,
  /** Authenticated aggregate of rows that still reserve bounded mailbox capacity. */
  pendingMessages: Schema.Number.check(Schema.isInt()).check(Schema.isBetween({ minimum: 0, maximum: 32 })),
  deliveryAckState: Schema.Literals(["queued", "delivered", "acknowledged", "expired", "unknown"]),
  lastSequence: UInt64Decimal,
  resultDigest: Schema.NullOr(Digest),
  receiptDigest: Schema.NullOr(Digest),
  failureCode: Schema.NullOr(Identifier),
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Horizon.SubagentStatusV1.ChildV1" })

export interface ListV1 extends Schema.Schema.Type<typeof ListV1> {}
export const ListV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  parentSessionId: SessionID,
  children: Schema.Array(ChildV1).check(Schema.isMaxLength(64)),
  truncated: Schema.Boolean,
}).annotate({ identifier: "Horizon.SubagentStatusV1.ListV1" })

export interface WaitResultV1 extends Schema.Schema.Type<typeof WaitResultV1> {}
export const WaitResultV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  child: ChildV1,
  outcome: Schema.Literals(["terminal", "activity", "timeout"]),
}).annotate({ identifier: "Horizon.SubagentStatusV1.WaitResultV1" })
