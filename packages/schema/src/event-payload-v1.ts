/**
 * Browser-safe logical V1 event metadata and aggregate-transition contracts.
 * These shapes do not specify physical event-log rows, segments, canonical byte
 * encoding, digest calculation, persistence, or event-store ownership.
 */

import { Schema } from "effect"
import * as Composition from "./composition-v1"
import { NonNegativeInt, optional } from "./schema"

const id = <const Identifier extends string>(identifier: Identifier) =>
  Schema.String.annotate({ identifier }).check(Schema.isNonEmpty()).pipe(Schema.brand(identifier))

const UInt16 = NonNegativeInt.check(
  Schema.makeFilter((value) => (value <= 65_535 ? undefined : "must be an unsigned 16-bit integer")),
)

export const EventId = id("Horizon.EventPayloadV1.EventId")
export type EventId = typeof EventId.Type

export const CorrelationId = id("Horizon.EventPayloadV1.CorrelationId")
export type CorrelationId = typeof CorrelationId.Type

export interface EventPayloadMetadataV1 extends Schema.Schema.Type<typeof EventPayloadMetadataV1> {}
export const EventPayloadMetadataV1 = Schema.Struct({
  schemaVersion: UInt16,
  eventId: EventId,
  actorRef: Composition.ActorRefV1,
  causationId: optional(EventId),
  correlationId: optional(CorrelationId),
  payloadDigest: Composition.Digest,
}).annotate({ identifier: "Horizon.EventPayloadV1.EventPayloadMetadataV1" })

export interface AggregateTransitionV1 extends Schema.Schema.Type<typeof AggregateTransitionV1> {}
export const AggregateTransitionV1 = Schema.Struct({
  aggregateId: Schema.String,
  expectedVersion: Composition.UInt64Decimal,
  fromState: Schema.String,
  toState: Schema.String,
  causeIds: Schema.Array(Schema.String),
  guardEvidenceRefs: Schema.Array(Composition.ArtifactRef),
})
  .annotate({ identifier: "Horizon.EventPayloadV1.AggregateTransitionV1" })
  .check(
    Schema.makeFilter((transition) =>
      (transition.fromState === "ABSENT") !== (transition.expectedVersion === "0")
        ? "aggregate creation requires fromState ABSENT and expectedVersion 0 together"
        : undefined,
    ),
  )
