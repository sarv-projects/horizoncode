import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as Composition from "../src/composition-v1"
import * as EventPayload from "../src/event-payload-v1"

const digest = Schema.decodeUnknownSync(Composition.Digest)(
  "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)

const artifact = {
  artifactId: "artifact.guard-evidence",
  digest,
  byteLength: "18",
  mediaType: "application/json",
  classification: "workspace",
} as const

const roundTrip = (schema: Schema.Codec<unknown, unknown, never, never>, input: unknown) => {
  const decoded = Schema.decodeUnknownSync(schema)(input)
  expect(Schema.encodeSync(schema)(decoded)).toEqual(input)
}

describe("Horizon Event Payload V1 contracts", () => {
  test("round trips event metadata and aggregate transitions", () => {
    const metadata = {
      schemaVersion: 1,
      eventId: "event.one",
      actorRef: { kind: "host", id: "host.one" },
      causationId: "event.cause",
      correlationId: "correlation.one",
      payloadDigest: digest,
    } as const
    const transition = {
      aggregateId: "thread.one",
      expectedVersion: "0",
      fromState: "ABSENT",
      toState: "ACTIVE",
      causeIds: ["delivery.one"],
      guardEvidenceRefs: [artifact],
    } as const

    expect(
      Schema.encodeSync(EventPayload.EventPayloadMetadataV1)(
        Schema.decodeUnknownSync(EventPayload.EventPayloadMetadataV1)(metadata),
      ),
    ).toEqual(metadata)
    expect(
      Schema.encodeSync(EventPayload.AggregateTransitionV1)(
        Schema.decodeUnknownSync(EventPayload.AggregateTransitionV1)(transition),
      ),
    ).toEqual(transition)
    expect(() =>
      Schema.decodeUnknownSync(EventPayload.AggregateTransitionV1)({
        ...transition,
        expectedVersion: "1",
      }),
    ).toThrow()
  })

  test("bounds logical metadata schema versions to unsigned 16-bit integers", () => {
    const metadata = {
      schemaVersion: 0,
      eventId: "event.one",
      actorRef: { kind: "host", id: "host.one" },
      payloadDigest: digest,
    } as const

    expect(Schema.decodeUnknownSync(EventPayload.EventPayloadMetadataV1)(metadata).schemaVersion).toBe(0)
    expect(
      Schema.decodeUnknownSync(EventPayload.EventPayloadMetadataV1)({
        ...metadata,
        schemaVersion: 65_535,
      }).schemaVersion,
    ).toBe(65_535)
    expect(() =>
      Schema.decodeUnknownSync(EventPayload.EventPayloadMetadataV1)({
        ...metadata,
        schemaVersion: 65_536,
      }),
    ).toThrow()
  })

  test("requires aggregate creation state and zero version to match bidirectionally", () => {
    const create = {
      aggregateId: "thread.one",
      expectedVersion: "0",
      fromState: "ABSENT",
      toState: "ACTIVE",
      causeIds: [],
      guardEvidenceRefs: [],
    } as const
    const later = {
      ...create,
      expectedVersion: "1",
      fromState: "ACTIVE",
      toState: "ARCHIVED",
    } as const

    roundTrip(EventPayload.AggregateTransitionV1, create)
    roundTrip(EventPayload.AggregateTransitionV1, later)
    expect(() =>
      Schema.decodeUnknownSync(EventPayload.AggregateTransitionV1)({
        ...create,
        expectedVersion: "1",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(EventPayload.AggregateTransitionV1)({
        ...later,
        expectedVersion: "0",
      }),
    ).toThrow()
  })

  test("omits absent optional metadata fields and rejects malformed identities", () => {
    const decoded = Schema.decodeUnknownSync(EventPayload.EventPayloadMetadataV1)({
      schemaVersion: 1,
      eventId: "event.one",
      actorRef: { kind: "user", id: "user.one" },
      payloadDigest: digest,
    })
    const encoded = Schema.encodeUnknownSync(EventPayload.EventPayloadMetadataV1)({
      ...decoded,
      causationId: undefined,
      correlationId: undefined,
    })

    expect(encoded).not.toHaveProperty("causationId")
    expect(encoded).not.toHaveProperty("correlationId")
    expect(() => Schema.decodeUnknownSync(EventPayload.EventId)("")).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(EventPayload.EventPayloadMetadataV1)({
        schemaVersion: -1,
        eventId: "event.one",
        actorRef: { kind: "user", id: "user.one" },
        payloadDigest: digest,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(EventPayload.EventPayloadMetadataV1)({
        schemaVersion: 1,
        eventId: "event.one",
        actorRef: { kind: "service", id: "service.one" },
        payloadDigest: digest,
      }),
    ).toThrow()
  })

  test("publishes unique stable schema identifiers and reuses the canonical ActorRef", () => {
    const schemas = [
      EventPayload.EventId,
      EventPayload.CorrelationId,
      EventPayload.EventPayloadMetadataV1,
      EventPayload.AggregateTransitionV1,
    ]
    const identifiers = schemas.map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers).toEqual([
      "Horizon.EventPayloadV1.EventId",
      "Horizon.EventPayloadV1.CorrelationId",
      "Horizon.EventPayloadV1.EventPayloadMetadataV1",
      "Horizon.EventPayloadV1.AggregateTransitionV1",
    ])
    expect(new Set(identifiers).size).toBe(identifiers.length)
    const metadataAst = EventPayload.EventPayloadMetadataV1.ast
    if (metadataAst._tag !== "Objects") throw new Error("expected event metadata object schema")
    expect(metadataAst.propertySignatures.find((field) => field.name === "actorRef")?.type).toBe(
      Composition.ActorRefV1.ast,
    )
  })
})
