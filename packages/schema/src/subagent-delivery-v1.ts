/**
 * Lane-tagged child delivery envelope shared by direct Core Sessions and managed
 * Rust Attempts. The authority digest is correlation/integrity metadata only;
 * each owner must resolve the referenced lineage and recompute it before use.
 */

import { blake3 } from "@noble/hashes/blake3.js"
import { Schema } from "effect"
import { Digest, Timestamp, UInt64Decimal } from "./composition-v1"
import { encodeCanonicalMessagePackV1 } from "./canonical-msgpack-v1"

const Identifier = Schema.String
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/))

const ProfileRevision = UInt64Decimal
const WireDigest = Schema.String.check(Schema.isPattern(/^(sha256|blake3):[0-9a-f]{64}$/))

export interface DirectSessionAuthorityV1 extends Schema.Schema.Type<typeof DirectSessionAuthorityV1> {}
export const DirectSessionAuthorityV1 = Schema.Struct({
  parentSessionId: Identifier,
  childSessionId: Identifier,
  profileId: Identifier,
  profileRevision: ProfileRevision,
  profileDigest: Digest,
  permissionScopeDigest: WireDigest,
}).annotate({ identifier: "Horizon.SubagentDeliveryV1.DirectSessionAuthorityV1" })

export interface ManagedAttemptAuthorityV1 extends Schema.Schema.Type<typeof ManagedAttemptAuthorityV1> {}
export const ManagedAttemptAuthorityV1 = Schema.Struct({
  delegationBindingDigest: Digest,
  goalId: Identifier,
  runId: Identifier,
  taskId: Identifier,
  attemptId: Identifier,
}).annotate({ identifier: "Horizon.SubagentDeliveryV1.ManagedAttemptAuthorityV1" })

export interface SubagentDeliveryV1 extends Schema.Schema.Type<typeof SubagentDeliveryV1> {}
export const SubagentDeliveryV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  lane: Schema.Literals(["direct_session", "managed_attempt"]),
  deliveryId: Identifier,
  requestId: Identifier,
  parentExecutionId: Identifier,
  childExecutionId: Identifier,
  messageId: Identifier,
  payloadRef: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(512)).check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/)),
  payloadDigest: WireDigest,
  replyTo: Identifier.pipe(Schema.optional),
  kind: Schema.Literals(["task", "question", "response", "progress", "result", "cancel"]),
  ackState: Schema.Literals(["queued", "delivered", "acknowledged", "expired", "unknown"]),
  ownerEpoch: UInt64Decimal,
  sequence: UInt64Decimal,
  expiresAt: Timestamp,
  authorityDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  authority: Schema.Union([DirectSessionAuthorityV1, ManagedAttemptAuthorityV1]),
}).annotate({ identifier: "Horizon.SubagentDeliveryV1.SubagentDeliveryV1" })

export type Lane = "direct_session" | "managed_attempt"
export type Authority = DirectSessionAuthorityV1 | ManagedAttemptAuthorityV1

function validU64(value: string): boolean {
  const max = "18446744073709551615"
  return /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    (value.length < max.length || (value.length === max.length && value <= max))
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted()
  const sorted = [...expected].toSorted()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[^\s\u0000-\u001f\u007f]{1,256}$/.test(value)
}

export function authorityDigest(input: {
  readonly lane: Lane
  readonly parentExecutionId: string
  readonly childExecutionId: string
  readonly ownerEpoch: string
  readonly authority: Authority
}): string {
  if (!validIdentifier(input.parentExecutionId) ||
      !validIdentifier(input.childExecutionId) ||
      !validU64(input.ownerEpoch) ||
      !validAuthorityForLane(input.lane, input.parentExecutionId, input.childExecutionId, input.authority)) {
    throw new TypeError("SubagentDelivery authority does not match its lane or execution lineage")
  }
  // Keep the Rust domain preimage and decimal-u64 representation byte exact.
  // The shared bounded encoder also serves the REPL callback operation digest.
  const preimage = encodeCanonicalMessagePackV1([
    "SubagentDeliveryV1.authority",
    input.lane,
    input.parentExecutionId,
    input.childExecutionId,
    input.ownerEpoch,
    input.authority,
  ], { maxEncodedBytes: 16 * 1024, maxDepth: 8, maxNodes: 64, maxCollectionItems: 32, maxScalarBytes: 512 })
  return `blake3:${Array.from(blake3(preimage), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export function validateAuthorityLane(value: SubagentDeliveryV1): boolean {
  return validAuthorityForLane(value.lane, value.parentExecutionId, value.childExecutionId, value.authority)
}

function validAuthorityForLane(lane: Lane, parent: string, child: string, authority: Authority): boolean {
  if (parent === child) return false
  if (lane === "direct_session") {
    return "parentSessionId" in authority && exactKeys(authority, [
      "parentSessionId", "childSessionId", "profileId", "profileRevision", "profileDigest", "permissionScopeDigest",
    ]) && validIdentifier(authority.parentSessionId) && validIdentifier(authority.childSessionId) &&
      validIdentifier(authority.profileId) && validU64(authority.profileRevision) &&
      /^blake3:[a-f0-9]{64}$/.test(authority.profileDigest) &&
      /^(sha256|blake3):[a-f0-9]{64}$/.test(authority.permissionScopeDigest)
  }
  return "delegationBindingDigest" in authority && exactKeys(authority, [
    "delegationBindingDigest", "goalId", "runId", "taskId", "attemptId",
  ]) && validIdentifier(authority.attemptId) && validIdentifier(authority.goalId) &&
    validIdentifier(authority.runId) && validIdentifier(authority.taskId) &&
    /^blake3:[a-f0-9]{64}$/.test(authority.delegationBindingDigest)
}
