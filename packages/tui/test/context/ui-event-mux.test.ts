import { expect, test } from "bun:test"
import {
  createStreamEnvelopeGuard,
  createStreamReplayGuard,
  createUiEventMux,
  type StreamCursorV1,
} from "../../src/context/ui-event-mux"

type Delta = {
  sessionID: string
  partID: string
  text: string
  cursor?: StreamCursorV1 & { advance: number }
}

function mux(
  options: {
    maxQueuedEvents?: number
    maxQueuedBytes?: number
    maxQueuedSessions?: number
    sizeProvenance?: "measured" | "estimated" | "unknown"
    flushAfterMs?: number
  } = {},
) {
  const batches: Delta[][] = []
  const queue = createUiEventMux<Delta>({
    sessionID: (event) => event.sessionID,
    key: (event) => event.partID,
    merge: (previous, next) => ({ ...previous, text: previous.text + next.text }),
    size: (event) => new TextEncoder().encode(event.text).byteLength,
    deliver: (events) => batches.push([...events]),
    maxQueuedEvents: options.maxQueuedEvents ?? 8,
    maxQueuedBytes: options.maxQueuedBytes ?? 64,
    maxQueuedSessions: options.maxQueuedSessions,
    sizeProvenance: options.sizeProvenance,
    flushAfterMs: options.flushAfterMs ?? 10_000,
  })
  return { queue, batches }
}

function envelopedMux(
  options: {
    maxQueuedEvents?: number
    maxQueuedBytes?: number
    maxQueuedSessions?: number
    maxStreamCursors?: number
    flushAfterMs?: number
  } = {},
) {
  const batches: Delta[][] = []
  const resnapshots: Array<StreamCursorV1 & { advance: number }> = []
  const queue = createUiEventMux<Delta>({
    sessionID: (event) => event.sessionID,
    key: (event) => event.partID,
    merge: (previous, next) => ({ ...previous, text: previous.text + next.text }),
    size: (event) => new TextEncoder().encode(event.text).byteLength,
    sizeProvenance: "measured",
    cursor: (event) => event.cursor,
    onResnapshotRequired: (cursor) => resnapshots.push(cursor),
    maxStreamCursors: options.maxStreamCursors,
    maxQueuedSessions: options.maxQueuedSessions,
    deliver: (events) => batches.push([...events]),
    maxQueuedEvents: options.maxQueuedEvents ?? 8,
    maxQueuedBytes: options.maxQueuedBytes ?? 64,
    flushAfterMs: options.flushAfterMs ?? 10_000,
  })
  return { queue, batches, resnapshots }
}

function envelope(
  sessionID: string,
  partID: string,
  sequence: number,
  text: string,
  sourceGeneration = "generation-1",
): Delta {
  return {
    sessionID,
    partID,
    text,
    cursor: { sessionID, partID, sourceGeneration, sequence, advance: 1 },
  }
}

test("coalesces adjacent paint deltas without changing text or crossing session order", () => {
  const { queue, batches } = mux()
  queue.push({ sessionID: "a", partID: "text-1", text: "hel" })
  queue.push({ sessionID: "a", partID: "text-1", text: "lo" })
  queue.push({ sessionID: "b", partID: "text-1", text: "other" })

  expect(queue.stats()).toEqual({ pendingEvents: 2, pendingBytes: 10, coalesced: 1 })
  queue.flush("a")
  expect(batches).toEqual([[{ sessionID: "a", partID: "text-1", text: "hello" }]])
  expect(queue.stats()).toEqual({ pendingEvents: 1, pendingBytes: 5, coalesced: 1 })
  queue.close()
  expect(batches[1]).toEqual([{ sessionID: "b", partID: "text-1", text: "other" }])
})

test("flushes before queue limits are exceeded and delivers oversized deltas directly", () => {
  const { queue, batches } = mux({ maxQueuedEvents: 2, maxQueuedBytes: 4 })
  queue.push({ sessionID: "a", partID: "one", text: "a" })
  queue.push({ sessionID: "a", partID: "two", text: "b" })
  expect(queue.stats()).toEqual({ pendingEvents: 2, pendingBytes: 2, coalesced: 0 })

  queue.push({ sessionID: "a", partID: "three", text: "c" })
  expect(batches).toEqual([
    [
      { sessionID: "a", partID: "one", text: "a" },
      { sessionID: "a", partID: "two", text: "b" },
    ],
  ])
  expect(queue.stats()).toEqual({ pendingEvents: 1, pendingBytes: 1, coalesced: 0 })

  queue.push({ sessionID: "a", partID: "large", text: "12345" })
  expect(batches[1]).toEqual([{ sessionID: "a", partID: "three", text: "c" }])
  expect(batches[2]).toEqual([{ sessionID: "a", partID: "large", text: "12345" }])
  expect(queue.stats()).toEqual({ pendingEvents: 0, pendingBytes: 0, coalesced: 0 })
  queue.close()
})

test("closed mux still resnapshots oversized cursor-backed deltas instead of bypassing the byte cap", () => {
  const { queue, batches, resnapshots } = envelopedMux({ maxQueuedBytes: 2 })
  const cursor = {
    sessionID: "a",
    partID: "text",
    sourceGeneration: "generation-1",
    sequence: 0,
  }
  expect(queue.seedStream(cursor)).toBe(true)
  queue.close()

  expect(queue.push(envelope("a", "text", 0, "oversized"))).toBe("resnapshot_required")
  expect(batches).toEqual([])
  expect(resnapshots).toEqual([{ ...cursor, advance: 1 }])
})

test("delivers queued deltas on the flush deadline without further pushes", async () => {
  const { queue, batches } = mux({ flushAfterMs: 5 })
  queue.push({ sessionID: "a", partID: "text-1", text: "one" })
  queue.push({ sessionID: "a", partID: "text-1", text: "two" })
  expect(batches).toEqual([])

  await Bun.sleep(30)
  expect(batches).toEqual([[{ sessionID: "a", partID: "text-1", text: "onetwo" }]])
  expect(queue.stats()).toEqual({ pendingEvents: 0, pendingBytes: 0, coalesced: 1 })
  queue.close()
})

test("only coalesces adjacent deltas and preserves push order across keys", () => {
  const { queue, batches } = mux()
  queue.push({ sessionID: "a", partID: "k1", text: "one" })
  queue.push({ sessionID: "a", partID: "k2", text: "two" })
  queue.push({ sessionID: "a", partID: "k1", text: "three" })
  expect(queue.stats()).toEqual({ pendingEvents: 3, pendingBytes: 11, coalesced: 0 })

  queue.flush()
  expect(batches).toEqual([
    [
      { sessionID: "a", partID: "k1", text: "one" },
      { sessionID: "a", partID: "k2", text: "two" },
      { sessionID: "a", partID: "k1", text: "three" },
    ],
  ])
  queue.close()
})

test("drops a merge that would exceed the byte budget instead of coalescing", () => {
  const { queue, batches } = mux({ maxQueuedBytes: 6 })
  queue.push({ sessionID: "a", partID: "k1", text: "aaaaa" })
  expect(queue.stats()).toEqual({ pendingEvents: 1, pendingBytes: 5, coalesced: 0 })

  queue.push({ sessionID: "a", partID: "k1", text: "bbbbb" })
  expect(batches).toEqual([[{ sessionID: "a", partID: "k1", text: "aaaaa" }]])
  expect(queue.stats()).toEqual({ pendingEvents: 1, pendingBytes: 5, coalesced: 0 })

  queue.flush()
  expect(batches[1]).toEqual([{ sessionID: "a", partID: "k1", text: "bbbbb" }])
  queue.close()
})

test("flushes before an adjacent merge would exceed the aggregate session byte budget", () => {
  const { queue, batches } = mux({ maxQueuedBytes: 10 })
  queue.push({ sessionID: "a", partID: "first", text: "123" })
  queue.push({ sessionID: "a", partID: "second", text: "4567" })

  queue.push({ sessionID: "a", partID: "second", text: "8901" })

  expect(batches).toEqual([
    [
      { sessionID: "a", partID: "first", text: "123" },
      { sessionID: "a", partID: "second", text: "4567" },
    ],
  ])
  expect(queue.stats()).toEqual({ pendingEvents: 1, pendingBytes: 4, coalesced: 0 })
  queue.close()
  expect(batches[1]).toEqual([{ sessionID: "a", partID: "second", text: "8901" }])
})

test("delivers events with an unmeasurable size directly", () => {
  const batches: Delta[][] = []
  const queue = createUiEventMux<Delta>({
    sessionID: (event) => event.sessionID,
    key: (event) => event.partID,
    merge: (previous, next) => ({ ...previous, text: previous.text + next.text }),
    size: () => Number.NaN,
    deliver: (events) => batches.push([...events]),
    maxQueuedEvents: 8,
    maxQueuedBytes: 64,
    flushAfterMs: 10_000,
  })

  queue.push({ sessionID: "a", partID: "k1", text: "one" })
  expect(batches).toEqual([[{ sessionID: "a", partID: "k1", text: "one" }]])
  expect(queue.stats()).toEqual({ pendingEvents: 0, pendingBytes: 0, coalesced: 0 })
  queue.close()
})

test("close drains every session once and later pushes deliver directly", () => {
  const { queue, batches } = mux()
  queue.push({ sessionID: "a", partID: "k1", text: "one" })
  queue.push({ sessionID: "b", partID: "k1", text: "two" })
  queue.close()
  expect(batches).toEqual([
    [{ sessionID: "a", partID: "k1", text: "one" }],
    [{ sessionID: "b", partID: "k1", text: "two" }],
  ])
  expect(queue.stats()).toEqual({ pendingEvents: 0, pendingBytes: 0, coalesced: 0 })

  queue.close()
  queue.push({ sessionID: "a", partID: "k1", text: "three" })
  expect(batches[2]).toEqual([{ sessionID: "a", partID: "k1", text: "three" }])
})

test("delivers every event directly when no queueing is configured", () => {
  const { queue, batches } = mux({ maxQueuedEvents: 0 })
  queue.push({ sessionID: "a", partID: "k1", text: "one" })
  queue.push({ sessionID: "a", partID: "k1", text: "two" })
  expect(batches).toEqual([
    [{ sessionID: "a", partID: "k1", text: "one" }],
    [{ sessionID: "a", partID: "k1", text: "two" }],
  ])
  queue.close()
})

test("bounds the number of queued sessions and delivers excess sessions without dropping deltas", () => {
  const { queue, batches } = mux({ maxQueuedSessions: 1 })
  queue.push({ sessionID: "a", partID: "k1", text: "one" })
  queue.push({ sessionID: "b", partID: "k1", text: "two" })

  expect(queue.stats().pendingEvents).toBe(1)
  expect(batches).toEqual([[{ sessionID: "b", partID: "k1", text: "two" }]])

  queue.close()
  expect(batches).toEqual([
    [{ sessionID: "b", partID: "k1", text: "two" }],
    [{ sessionID: "a", partID: "k1", text: "one" }],
  ])
})

test("keeps a slow session bounded while other streaming sessions flush independently", () => {
  const { queue, batches } = mux({ maxQueuedEvents: 1024, maxQueuedBytes: 4096, maxQueuedSessions: 16 })
  for (let index = 0; index < 1000; index++) {
    queue.push({ sessionID: "slow", partID: "text", text: "x" })
  }

  for (let index = 0; index < 15; index++) {
    const sessionID = `session-${index}`
    queue.push({ sessionID, partID: "text", text: sessionID })
    queue.flush(sessionID)
  }

  expect(queue.stats()).toEqual({ pendingEvents: 1, pendingBytes: 1000, coalesced: 999 })
  expect(batches.flat().map((event) => event.sessionID)).toEqual(
    Array.from({ length: 15 }, (_, index) => `session-${index}`),
  )

  queue.flush("slow")
  expect(batches.flat().filter((event) => event.sessionID === "slow")).toEqual([
    { sessionID: "slow", partID: "text", text: "x".repeat(1000) },
  ])
  expect(queue.stats()).toEqual({ pendingEvents: 0, pendingBytes: 0, coalesced: 999 })
  queue.close()
})

test("treats non-finite queue limits as direct-delivery mode", () => {
  const { queue, batches } = mux({ maxQueuedBytes: Number.NaN })
  queue.push({ sessionID: "a", partID: "k1", text: "one" })
  expect(batches).toEqual([[{ sessionID: "a", partID: "k1", text: "one" }]])
  expect(queue.stats().pendingEvents).toBe(0)
  queue.close()
})

test("accepts one next stream sequence and suppresses replayed prefixes", () => {
  const replay = createStreamReplayGuard({ maxCursors: 2 })
  const cursor = {
    sessionID: "a",
    partID: "text-1",
    sourceGeneration: "generation-1",
    sequence: 4,
  }

  expect(replay.seed(cursor)).toBe(true)
  expect(replay.accept({ ...cursor, sequence: 5 })).toBe("apply")
  expect(replay.accept({ ...cursor, sequence: 5 })).toBe("duplicate")
  expect(replay.accept({ ...cursor, sequence: 3 })).toBe("duplicate")
  expect(replay.accept({ ...cursor, sequence: 6 })).toBe("apply")
})

test("requires canonical resnapshot after sequence gaps, generation changes or cursor eviction", () => {
  const replay = createStreamReplayGuard({ maxCursors: 1 })
  const first = {
    sessionID: "a",
    partID: "text-1",
    sourceGeneration: "generation-1",
    sequence: 4,
  }
  expect(replay.seed(first)).toBe(true)
  expect(replay.accept({ ...first, sequence: 6 })).toBe("resnapshot_required")
  expect(replay.accept({ ...first, sourceGeneration: "generation-2", sequence: 5 })).toBe("resnapshot_required")

  expect(
    replay.seed({
      sessionID: "b",
      partID: "text-2",
      sourceGeneration: "generation-1",
      sequence: 0,
    }),
  ).toBe(true)
  expect(replay.accept({ ...first, sequence: 5 })).toBe("resnapshot_required")
})

test("rejects malformed runtime cursors without throwing or changing tracked state", () => {
  const replay = createStreamReplayGuard()
  const valid = {
    sessionID: "a",
    partID: "text-1",
    sourceGeneration: "generation-1",
    sequence: 4,
  }
  expect(replay.seed(valid)).toBe(true)

  const malformed = { ...valid, sessionID: null } as unknown as typeof valid
  expect(() => replay.seed(malformed)).not.toThrow()
  expect(() => replay.accept(malformed)).not.toThrow()
  expect(replay.seed(malformed)).toBe(false)
  expect(replay.accept(malformed)).toBe("resnapshot_required")
  expect(replay.stats()).toEqual({ trackedCursors: 1 })
  expect(replay.accept({ ...valid, sequence: 5 })).toBe("apply")
})

test("rejects oversized replay cursor identities before retaining them", () => {
  const replay = createStreamReplayGuard()
  const oversized = {
    sessionID: "s".repeat(257),
    partID: "text-1",
    sourceGeneration: "generation-1",
    sequence: 1,
  }

  expect(replay.seed(oversized)).toBe(false)
  expect(replay.accept(oversized)).toBe("resnapshot_required")
  expect(replay.stats()).toEqual({ trackedCursors: 0 })
})

test("reports queue analytics with explicit measured and size provenance", () => {
  const { queue } = mux({ sizeProvenance: "estimated" })
  queue.push({ sessionID: "a", partID: "k1", text: "one" })

  const observations = queue.observations()
  expect(observations.map(({ observedAtMs: _time, ...observation }) => observation)).toEqual([
    {
      metric: "ui.queue.pending_events",
      value: 1,
      unit: "events",
      provenance: "measured",
      source: "ui-event-mux",
    },
    {
      metric: "ui.queue.pending_bytes",
      value: 3,
      unit: "bytes",
      provenance: "estimated",
      source: "ui-event-mux",
    },
    {
      metric: "ui.queue.coalesced_events",
      value: 0,
      unit: "events",
      provenance: "measured",
      source: "ui-event-mux",
    },
    {
      metric: "ui.queue.dropped_events",
      value: 0,
      unit: "events",
      provenance: "measured",
      source: "ui-event-mux",
    },
    {
      metric: "ui.queue.direct_deliveries",
      value: 0,
      unit: "events",
      provenance: "measured",
      source: "ui-event-mux",
    },
    {
      metric: "ui.stream.duplicates_suppressed",
      value: 0,
      unit: "events",
      provenance: "measured",
      source: "ui-event-mux",
    },
    {
      metric: "ui.stream.resnapshots_required",
      value: 0,
      unit: "events",
      provenance: "measured",
      source: "ui-event-mux",
    },
  ])
  expect(observations.every((observation) => Number.isSafeInteger(observation.observedAtMs))).toBe(true)
  queue.close()
})

test("reports unknown byte provenance until the caller declares how sizes are measured", () => {
  const { queue } = mux()
  queue.push({ sessionID: "a", partID: "k1", text: "one" })

  const pendingBytes = queue.observations().find((observation) => observation.metric === "ui.queue.pending_bytes")
  expect(pendingBytes).toMatchObject({ value: 3, unit: "bytes", provenance: "unknown" })
  queue.close()
})

test("counts oversized and session-capped bypasses as measured direct deliveries", () => {
  const oversized = mux({ maxQueuedBytes: 4 })
  oversized.queue.push({ sessionID: "a", partID: "k1", text: "abc" })
  oversized.queue.push({ sessionID: "a", partID: "k2", text: "12345" })
  expect(
    oversized.queue.observations().find((observation) => observation.metric === "ui.queue.direct_deliveries"),
  ).toMatchObject({ value: 1, unit: "events", provenance: "measured" })
  expect(oversized.batches).toEqual([
    [{ sessionID: "a", partID: "k1", text: "abc" }],
    [{ sessionID: "a", partID: "k2", text: "12345" }],
  ])
  oversized.queue.close()

  const capped = mux({ maxQueuedSessions: 1 })
  capped.queue.push({ sessionID: "a", partID: "k1", text: "a" })
  capped.queue.push({ sessionID: "b", partID: "k1", text: "b" })
  expect(
    capped.queue.observations().find((observation) => observation.metric === "ui.queue.direct_deliveries"),
  ).toMatchObject({ value: 1, unit: "events", provenance: "measured" })
  expect(capped.batches).toEqual([[{ sessionID: "b", partID: "k1", text: "b" }]])
  capped.queue.close()
})

test("counts post-close deliveries as measured direct deliveries", () => {
  const { queue, batches } = mux()
  queue.push({ sessionID: "a", partID: "k1", text: "a" })
  queue.close()
  queue.push({ sessionID: "a", partID: "k1", text: "b" })

  expect(
    queue.observations().find((observation) => observation.metric === "ui.queue.direct_deliveries"),
  ).toMatchObject({ value: 1, unit: "events", provenance: "measured" })
  expect(batches).toEqual([
    [{ sessionID: "a", partID: "k1", text: "a" }],
    [{ sessionID: "a", partID: "k1", text: "b" }],
  ])
})

test("envelope guard reserves source ordinals and suppresses duplicates or gaps", () => {
  const guard = createStreamEnvelopeGuard()
  const cursor = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 4 }
  expect(guard.seed(cursor)).toBe(true)

  expect(guard.accept({ ...cursor, advance: 1 })).toBe("apply")
  expect(guard.commit({ ...cursor, advance: 1 })).toBe(true)
  expect(guard.accept({ ...cursor, sequence: 5, advance: 1 })).toBe("apply")
  expect(guard.accept({ ...cursor, sequence: 5, advance: 1 })).toBe("duplicate")
  expect(guard.commit({ ...cursor, sequence: 5, advance: 1 })).toBe(true)
  expect(guard.accept({ ...cursor, sequence: 6, advance: 1 })).toBe("apply")
  expect(guard.accept({ ...cursor, sequence: 4, advance: 1 })).toBe("duplicate")
  expect(guard.accept({ ...cursor, sequence: 10, advance: 1 })).toBe("resnapshot_required")
  expect(guard.accept({ ...cursor, sequence: 5, advance: 1 })).toBe("duplicate")
  expect(guard.accept({ ...cursor, sequence: 6, advance: 2 })).toBe("resnapshot_required")
  expect(guard.accept({ ...cursor, sourceGeneration: "generation-2", sequence: 6, advance: 1 })).toBe(
    "resnapshot_required",
  )
})

test("envelope guard fails closed after cursor eviction and after forget", () => {
  const guard = createStreamEnvelopeGuard({ maxCursors: 1 })
  const first = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 }
  expect(guard.seed(first)).toBe(true)

  const second = { sessionID: "a", partID: "text-2", sourceGeneration: "generation-1", sequence: 0 }
  expect(guard.seed(second)).toBe(true)
  expect(guard.stats()).toEqual({ trackedCursors: 1 })
  expect(guard.accept({ ...first, advance: 1 })).toBe("resnapshot_required")
  expect(guard.accept({ ...second, advance: 1 })).toBe("apply")
  expect(guard.commit({ ...second, advance: 1 })).toBe(true)
  expect(guard.accept({ ...second, sequence: 1, advance: 1 })).toBe("apply")

  guard.forget("a")
  expect(guard.stats()).toEqual({ trackedCursors: 0 })
  expect(guard.accept({ ...second, sequence: 2, advance: 1 })).toBe("resnapshot_required")
})

test("envelope guard rejects malformed and non-advancing cursors without throwing", () => {
  const guard = createStreamEnvelopeGuard()
  const cursor = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 }
  expect(guard.seed(cursor)).toBe(true)

  const malformed = { ...cursor, advance: 1, sequence: Number.NaN } as typeof cursor & { advance: number }
  expect(() => guard.accept(malformed)).not.toThrow()
  expect(guard.accept(malformed)).toBe("resnapshot_required")
  expect(guard.seed({ ...cursor, sourceGeneration: "x".repeat(257) })).toBe(false)
  expect(guard.accept({ ...cursor, advance: -1 })).toBe("resnapshot_required")
  expect(guard.stats()).toEqual({ trackedCursors: 1 })
})

test("mux coalesces contiguous envelope deltas and commits them on delivery", () => {
  const { queue, batches } = envelopedMux()
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  expect(queue.push(envelope("a", "text-1", 0, "hel"))).toBe("apply")
  expect(queue.push(envelope("a", "text-1", 1, "lo"))).toBe("apply")
  expect(queue.streamStats()).toMatchObject({ duplicatesSuppressed: 0, resnapshotsRequired: 0 })

  queue.flush("a")
  expect(batches).toEqual([[{ sessionID: "a", partID: "text-1", text: "hello", cursor: expect.anything() }]])
  expect(queue.streamStats().duplicatesSuppressed).toBe(0)

  expect(queue.push(envelope("a", "text-1", 2, "!"))).toBe("apply")
  queue.flush("a")
  expect(batches[1]?.[0]?.text).toBe("!")
  queue.close()
})

test("mux drops replayed envelope deltas without delivering duplicated text", () => {
  const { queue, batches } = envelopedMux()
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  queue.push(envelope("a", "text-1", 0, "hello"))
  queue.flush("a")
  expect(batches).toEqual([[{ sessionID: "a", partID: "text-1", text: "hello", cursor: expect.anything() }]])

  expect(queue.push(envelope("a", "text-1", 0, "llo"))).toBe("duplicate")
  expect(queue.push(envelope("a", "text-1", 0, "hello"))).toBe("duplicate")
  queue.flush("a")
  expect(batches).toHaveLength(1)
  expect(queue.streamStats().duplicatesSuppressed).toBe(2)
  expect(
    queue.observations().find((observation) => observation.metric === "ui.stream.duplicates_suppressed"),
  ).toMatchObject({ value: 2, unit: "events", provenance: "measured" })
  queue.close()
})

test("mux flushes accepted deltas then requests a resnapshot for a gap or a stale generation", () => {
  const { queue, batches, resnapshots } = envelopedMux()
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  queue.push(envelope("a", "text-1", 0, "hel"))
  expect(queue.push(envelope("a", "text-1", 9, "gap"))).toBe("resnapshot_required")
  expect(batches).toEqual([[{ sessionID: "a", partID: "text-1", text: "hel", cursor: expect.anything() }]])
  expect(resnapshots).toEqual([
    { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 9, advance: 1 },
  ])

  // Resnapshot cursor is the next expected source ordinal after the canonical
  // rebuild included the ordinal 9 event; the following delta is 10.
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 10 })
  expect(queue.push(envelope("a", "text-1", 10, "lo"))).toBe("apply")
  queue.flush("a")
  expect(batches[1]?.[0]?.text).toBe("lo")

  expect(queue.push(envelope("a", "text-1", 11, "!", "generation-2"))).toBe("resnapshot_required")
  expect(resnapshots).toHaveLength(2)
  expect(queue.streamStats().resnapshotsRequired).toBe(2)
  expect(
    queue.observations().find((observation) => observation.metric === "ui.stream.resnapshots_required"),
  ).toMatchObject({ value: 2, unit: "events", provenance: "measured" })
  queue.close()
})

test("mux requires a seed before accepting envelope deltas after a reload", () => {
  const { queue, batches, resnapshots } = envelopedMux()
  expect(queue.push(envelope("a", "text-1", 0, "hel"))).toBe("resnapshot_required")
  expect(batches).toEqual([])
  expect(resnapshots).toHaveLength(1)

  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  expect(queue.push(envelope("a", "text-1", 0, "hel"))).toBe("apply")
  queue.flush("a")
  expect(batches[0]?.[0]?.text).toBe("hel")

  queue.forgetStream("a", "text-1")
  expect(queue.push(envelope("a", "text-1", 2, "lo"))).toBe("resnapshot_required")
  queue.close()
})

test("oversized canonical deltas request a resnapshot instead of bypassing the stream bound", () => {
  const { queue, batches, resnapshots } = envelopedMux({ maxQueuedBytes: 4 })
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  expect(queue.push(envelope("a", "text-1", 0, "12345"))).toBe("resnapshot_required")
  expect(batches).toEqual([])
  expect(resnapshots).toEqual([
    { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0, advance: 1 },
  ])
  expect(
    queue.observations().find((observation) => observation.metric === "ui.stream.resnapshots_required"),
  ).toMatchObject({ value: 1, unit: "events", provenance: "measured" })
  queue.close()
})

test("direct-delivers canonical deltas when the queue is disabled and commits only after delivery", () => {
  const { queue, batches } = envelopedMux({ maxQueuedEvents: 0 })
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  expect(queue.push(envelope("a", "text-1", 0, "x"))).toBe("apply")
  expect(batches).toEqual([[{ sessionID: "a", partID: "text-1", text: "x", cursor: expect.anything() }]])
  expect(queue.push(envelope("a", "text-1", 1, "y"))).toBe("apply")
  expect(batches).toHaveLength(2)
  expect(
    queue.observations().find((observation) => observation.metric === "ui.queue.direct_deliveries"),
  ).toMatchObject({ value: 2, unit: "events", provenance: "measured" })
  queue.close()
})

test("mux keeps legacy paint events coalescing alongside gated envelope deltas", () => {
  const { queue, batches } = envelopedMux()
  queue.push({ sessionID: "a", partID: "legacy", text: "one" })
  queue.push({ sessionID: "a", partID: "legacy", text: "two" })
  queue.flush("a")
  expect(batches).toEqual([[{ sessionID: "a", partID: "legacy", text: "onetwo" }]])

  expect(queue.push(envelope("a", "text-1", 0, "x"))).toBe("resnapshot_required")
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  expect(queue.push(envelope("a", "text-1", 0, "x"))).toBe("apply")
  queue.push({ sessionID: "a", partID: "text-1", text: "y" })
  queue.flush("a")
  expect(batches[1]?.map((item) => item.text)).toEqual(["x", "y"])
  queue.close()
})

test("required replay cursor rejects malformed source metadata and requests a canonical resnapshot", () => {
  const batches: Delta[][] = []
  const resnapshots: string[] = []
  const queue = createUiEventMux<Delta>({
    sessionID: (event) => event.sessionID,
    key: (event) => event.partID,
    merge: (previous, next) => ({ ...previous, text: previous.text + next.text }),
    size: (event) => Buffer.byteLength(event.text),
    deliver: (events) => batches.push([...events]),
    maxQueuedEvents: 8,
    maxQueuedBytes: 64,
    flushAfterMs: 10_000,
    cursor: () => undefined,
    requireCursor: true,
    onInvalidCursor: (sessionID) => resnapshots.push(sessionID),
  })

  expect(queue.push({ sessionID: "a", partID: "text-1", text: "unfenced" })).toBe("resnapshot_required")
  expect(batches).toEqual([])
  expect(resnapshots).toEqual(["a"])
  expect(queue.streamStats().resnapshotsRequired).toBe(1)
  queue.close()
})

test("delivery exceptions forget accepted replay state and request a canonical resnapshot", () => {
  const resnapshots: string[] = []
  const queue = createUiEventMux<Delta>({
    sessionID: (event) => event.sessionID,
    key: (event) => event.partID,
    merge: (previous, next) => ({ ...previous, text: previous.text + next.text }),
    size: (event) => Buffer.byteLength(event.text),
    deliver: () => {
      throw new Error("consumer partially applied the batch")
    },
    maxQueuedEvents: 8,
    maxQueuedBytes: 64,
    flushAfterMs: 10_000,
    cursor: (event) => event.cursor,
    requireCursor: true,
    onInvalidCursor: (sessionID) => resnapshots.push(sessionID),
  })
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })

  expect(queue.push(envelope("a", "text-1", 0, "first"))).toBe("apply")
  expect(() => queue.flush("a")).not.toThrow()
  expect(resnapshots).toEqual(["a"])
  expect(queue.streamStats().trackedCursors).toBe(0)
  expect(queue.push(envelope("a", "text-1", 1, "next"))).toBe("resnapshot_required")
  expect(queue.streamStats().trackedCursors).toBe(0)
  queue.close()
})

test("rejects a cursor from another subscription generation and requires a resnapshot (AC-011)", () => {
  const { queue, batches, resnapshots } = envelopedMux()
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "subscription-1", sequence: 0 })
  expect(queue.push(envelope("a", "text-1", 0, "x", "subscription-1"))).toBe("apply")
  queue.flush("a")
  expect(batches).toHaveLength(1)

  // A durable cursor from another subscription/owner epoch cannot apply.
  expect(queue.push(envelope("a", "text-1", 1, "y", "subscription-2"))).toBe("resnapshot_required")
  expect(resnapshots).toEqual([
    { sessionID: "a", partID: "text-1", sourceGeneration: "subscription-2", sequence: 1, advance: 1 },
  ])
  queue.close()
})

test("reconnect flushes accepted deltas then forgets cursors so pre-reconnect offsets cannot apply", () => {
  const { queue, batches, resnapshots } = envelopedMux()
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  queue.push(envelope("a", "text-1", 0, "hel"))
  queue.push(envelope("a", "text-1", 1, "lo"))
  expect(queue.streamStats().trackedCursors).toBe(1)

  expect(queue.reconnect()).toEqual({ flushedSessions: 1, forgottenCursors: 1 })
  expect(batches).toEqual([[{ sessionID: "a", partID: "text-1", text: "hello", cursor: expect.anything() }]])
  expect(queue.streamStats().trackedCursors).toBe(0)

  // After reconnect the next delta must be proven against a fresh canonical state.
  expect(queue.push(envelope("a", "text-1", 2, "!"))).toBe("resnapshot_required")
  expect(resnapshots).toHaveLength(1)
  queue.close()
})

test("keeps 16 streaming sessions bounded while a slow session drains (AC-012)", () => {
  const { queue, batches } = envelopedMux({ maxQueuedEvents: 1024, maxQueuedBytes: 4096, maxQueuedSessions: 16 })
  for (let index = 0; index < 16; index++) {
    const sessionID = `session-${index}`
    queue.seedStream({ sessionID, partID: "text", sourceGeneration: sessionID, sequence: 0 })
    for (let delta = 0; delta < 40; delta++) {
      expect(queue.push(envelope(sessionID, "text", delta, "x", sessionID))).toBe("apply")
    }
  }
  expect(queue.stats().pendingEvents).toBe(16)
  expect(queue.stats().pendingBytes).toBeLessThanOrEqual(4096)

  queue.flush()
  expect(batches).toHaveLength(16)
  expect(new Set(batches.flat().map((event) => event.sessionID)).size).toBe(16)
  expect(
    batches
      .flat()
      .map((event) => event.sessionID)
      .toSorted((a, b) => Number(a.slice("session-".length)) - Number(b.slice("session-".length))),
  ).toEqual(Array.from({ length: 16 }, (_, index) => `session-${index}`))
  for (const batch of batches) expect(batch[0]?.text).toBe("x".repeat(40))
  expect(queue.stats()).toEqual({ pendingEvents: 0, pendingBytes: 0, coalesced: 16 * 39 })
  queue.close()
})

test("seals an ended stream so a late delta cannot re-append text, and a restart unseals it", () => {
  const { queue, batches } = envelopedMux()
  const cursor = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 }
  queue.resetStream(cursor)
  expect(queue.push(envelope("a", "text-1", 0, "hel"))).toBe("apply")
  queue.flush("a")
  expect(batches[0]?.[0]?.text).toBe("hel")

  expect(queue.seedStream({ ...cursor, sequence: 1 })).toBe(true)
  expect(queue.sealStream({ ...cursor, sequence: 1 })).toBe(true)
  expect(queue.push(envelope("a", "text-1", 1, "lo"))).toBe("duplicate")
  queue.flush("a")
  expect(batches).toHaveLength(1)

  // A restarted part clears the seal and accepts fresh deltas.
  expect(queue.resetStream(cursor)).toBe(true)
  expect(queue.push(envelope("a", "text-1", 0, "fresh"))).toBe("apply")
  queue.flush("a")
  expect(batches[1]?.[0]?.text).toBe("fresh")
  queue.close()
})

test("resetting a stream discards queued deltas from its previous generation", () => {
  const { queue, batches } = envelopedMux()
  const old = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 }
  const fresh = { ...old, sourceGeneration: "generation-2", sequence: 0 }
  queue.resetStream(old)
  expect(queue.push(envelope("a", "text-1", 0, "stale", "generation-1"))).toBe("apply")

  queue.resetStream(fresh)
  expect(queue.push(envelope("a", "text-1", 0, "fresh", "generation-2"))).toBe("apply")
  queue.flush("a")

  expect(batches).toEqual([[{ ...envelope("a", "text-1", 0, "fresh", "generation-2") }]])
  queue.close()
})

test("cursor pressure forgets an ended cursor when its bounded seal is evicted", () => {
  const guard = createStreamEnvelopeGuard({ maxCursors: 2 })
  const first = { sessionID: "a", partID: "part-a", sourceGeneration: "g1", sequence: 0 }
  const second = { sessionID: "b", partID: "part-b", sourceGeneration: "g1", sequence: 0 }
  const third = { sessionID: "c", partID: "part-c", sourceGeneration: "g1", sequence: 0 }

  expect(guard.seed(first)).toBe(true)
  expect(guard.seal(first)).toBe(true)
  expect(guard.seed(second)).toBe(true)
  expect(guard.seal(second)).toBe(true)
  expect(guard.accept({ ...first, advance: 1 })).toBe("duplicate")
  expect(guard.seed(third)).toBe(true)
  expect(guard.seal(third)).toBe(true)

  // Evicting a seal must also discard its cursor; otherwise a later ordinal
  // could be accepted after the bounded ended-stream record was forgotten.
  expect(guard.accept({ ...first, sequence: 1, advance: 1 })).toBe("resnapshot_required")
})

test("refuses an envelope whose session identity differs from its owning event", () => {
  const { queue, batches, resnapshots } = envelopedMux()
  // Stream a/text-1 is live, so without the identity fence the substituted
  // cursor below would be accepted as a normal delta of that stream.
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  queue.push({ sessionID: "a", partID: "legacy", text: "queued-a" })
  queue.push({ sessionID: "b", partID: "legacy", text: "queued-b" })

  // The event owner is session b while the cursor claims session a: a
  // cross-session substitution must never be admitted to either stream.
  const decision = queue.push({
    sessionID: "b",
    partID: "text-1",
    text: "substituted",
    cursor: { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0, advance: 1 },
  })

  expect(decision).toBe("resnapshot_required")
  const delivered = batches.flat().map((event) => event.text)
  expect([...delivered].sort()).toEqual(["queued-a", "queued-b"])
  expect(delivered).not.toContain("substituted")
  expect(resnapshots).toEqual([
    { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0, advance: 1 },
  ])
  expect(queue.streamStats()).toMatchObject({ resnapshotsRequired: 1, duplicatesSuppressed: 0 })
  queue.close()
})

test("commits only at the committed frontier and never past accepted progress", () => {
  const guard = createStreamEnvelopeGuard()
  const cursor = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 }
  expect(guard.seed(cursor)).toBe(true)
  expect(guard.accept({ ...cursor, advance: 3 })).toBe("apply")

  // An out-of-order commit must not move the frontier, and a commit beyond the
  // accepted progress must not invent ordinals that were never reserved.
  expect(guard.commit({ ...cursor, sequence: 1, advance: 1 })).toBe(false)
  expect(guard.commit({ ...cursor, advance: 5 })).toBe(false)

  // The reservation is still exactly the range that was accepted.
  expect(guard.accept({ ...cursor, advance: 3 })).toBe("duplicate")
  expect(guard.accept({ ...cursor, sequence: 3, advance: 1 })).toBe("apply")

  expect(guard.commit({ ...cursor, advance: 3 })).toBe(true)
  expect(guard.commit({ ...cursor, sequence: 3, advance: 1 })).toBe(true)
  expect(guard.accept({ ...cursor, sequence: 4, advance: 1 })).toBe("apply")
  // A replayed ordinal below the committed frontier stays a suppressed duplicate.
  expect(guard.accept({ ...cursor, advance: 1 })).toBe("duplicate")
  expect(guard.commit({ ...cursor, sequence: 4, advance: 1 })).toBe(true)
  expect(guard.accept({ ...cursor, sequence: 5, advance: 1 })).toBe("apply")
  expect(guard.stats()).toEqual({ trackedCursors: 1 })
})

test("refuses to seal an unknown stream or one from another source generation", () => {
  const guard = createStreamEnvelopeGuard()
  const cursor = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 }
  expect(guard.seed(cursor)).toBe(true)

  expect(guard.seal({ sessionID: "z", partID: "text-9", sourceGeneration: "generation-1", sequence: 0 })).toBe(false)
  expect(guard.seal({ ...cursor, sourceGeneration: "generation-2" })).toBe(false)

  // Neither refusal may leave a seal behind: the live stream still applies.
  expect(guard.accept({ ...cursor, advance: 1 })).toBe("apply")
  expect(guard.commit({ ...cursor, advance: 1 })).toBe(true)

  // Only the matching generation can seal it, and the seal then suppresses
  // every later delta as a replay.
  expect(guard.seal({ ...cursor, sequence: 1 })).toBe(true)
  expect(guard.accept({ ...cursor, sequence: 1, advance: 1 })).toBe("duplicate")
})

test("bounds uncommitted envelope reservations and admits again after a commit", () => {
  const guard = createStreamEnvelopeGuard()
  const cursor = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 }
  expect(guard.seed(cursor)).toBe(true)

  let applied = 0
  for (let sequence = 0; sequence < 4096; sequence++) {
    if (guard.accept({ ...cursor, sequence, advance: 1 }) === "apply") applied++
  }
  expect(applied).toBe(4096)

  // Without a commit the reservation set is at its bound: the next delta falls
  // back to a canonical resnapshot instead of growing the set without limit.
  expect(guard.accept({ ...cursor, sequence: 4096, advance: 1 })).toBe("resnapshot_required")

  // Committing the frontier prunes the accepted ranges and admits again.
  expect(guard.commit({ ...cursor, advance: 1 })).toBe(true)
  expect(guard.accept({ ...cursor, sequence: 4096, advance: 1 })).toBe("apply")
  expect(guard.stats()).toEqual({ trackedCursors: 1 })
})

test("fails closed when a guard may retain no stream cursors at all", () => {
  const envelopes = createStreamEnvelopeGuard({ maxCursors: 0 })
  const replay = createStreamReplayGuard({ maxCursors: 0 })
  const cursor = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 }

  expect(envelopes.seed(cursor)).toBe(false)
  expect(envelopes.accept({ ...cursor, advance: 1 })).toBe("resnapshot_required")
  expect(envelopes.commit({ ...cursor, advance: 1 })).toBe(false)
  expect(envelopes.seal(cursor)).toBe(false)
  expect(envelopes.forgetAll()).toBe(0)
  expect(envelopes.stats()).toEqual({ trackedCursors: 0 })

  expect(replay.seed(cursor)).toBe(false)
  expect(replay.accept(cursor)).toBe("resnapshot_required")
  expect(replay.stats()).toEqual({ trackedCursors: 0 })
})

test("a delta burst reports measured coalesced, duplicate and resnapshot counts (AN-009)", () => {
  const { queue, batches, resnapshots } = envelopedMux({ maxQueuedEvents: 1024, maxQueuedBytes: 4096 })
  queue.seedStream({ sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 })
  for (let sequence = 0; sequence < 100; sequence++) {
    expect(queue.push(envelope("a", "text-1", sequence, "x"))).toBe("apply")
  }
  expect(queue.push(envelope("a", "text-1", 40, "replayed"))).toBe("duplicate")
  expect(queue.push(envelope("a", "text-1", 500, "gap"))).toBe("resnapshot_required")

  const byMetric = new Map(queue.observations().map((observation) => [observation.metric, observation]))
  expect(byMetric.get("ui.queue.coalesced_events")).toMatchObject({ value: 99, provenance: "measured" })
  expect(byMetric.get("ui.queue.pending_events")).toMatchObject({ value: 0, provenance: "measured" })
  expect(byMetric.get("ui.queue.pending_bytes")).toMatchObject({ value: 0, provenance: "measured" })
  expect(byMetric.get("ui.stream.duplicates_suppressed")).toMatchObject({ value: 1, provenance: "measured" })
  expect(byMetric.get("ui.stream.resnapshots_required")).toMatchObject({ value: 1, provenance: "measured" })

  // The gap flushed the accepted burst before requesting the canonical rebuild,
  // and the replayed delta never reached the consumer a second time.
  expect(batches).toHaveLength(1)
  expect(batches[0]?.[0]?.text).toBe("x".repeat(100))
  expect(resnapshots).toHaveLength(1)
  queue.close()
})

test("counts ephemeral deltas dropped when a stream generation resets (AN-009)", () => {
  const { queue, batches } = envelopedMux()
  const old = { sessionID: "a", partID: "text-1", sourceGeneration: "generation-1", sequence: 0 }
  const fresh = { ...old, sourceGeneration: "generation-2", sequence: 0 }

  // Seed generation-1 first so the guard accepts the stale delta into the
  // queue; the reset is what discards it.
  queue.resetStream(old)
  expect(queue.push(envelope("a", "text-1", 0, "stale", "generation-1"))).toBe("apply")
  queue.resetStream(fresh)
  expect(queue.push(envelope("a", "text-1", 0, "fresh", "generation-2"))).toBe("apply")
  queue.flush("a")

  // The stale delta is discarded rather than delivered, so it must be
  // observable alongside the coalesced count (§31.16, §31.17, AN-009).
  expect(batches).toEqual([[envelope("a", "text-1", 0, "fresh", "generation-2")]])
  const dropped = queue
    .observations()
    .find((observation) => observation.metric === "ui.queue.dropped_events")
  expect(dropped).toMatchObject({
    metric: "ui.queue.dropped_events",
    value: 1,
    unit: "events",
    provenance: "measured",
    source: "ui-event-mux",
  })
  queue.close()
})

test("reports a zero dropped count when queued deltas are never discarded (AN-009)", () => {
  const { queue } = mux()
  queue.push({ sessionID: "a", partID: "text-1", text: "one" })
  queue.push({ sessionID: "a", partID: "text-1", text: "two" })

  const dropped = queue
    .observations()
    .find((observation) => observation.metric === "ui.queue.dropped_events")
  expect(dropped).toMatchObject({ value: 0, provenance: "measured" })
  queue.close()
})
