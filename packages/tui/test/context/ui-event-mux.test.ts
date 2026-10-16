import { expect, test } from "bun:test"
import { createUiEventMux } from "../../src/context/ui-event-mux"

type Delta = {
  sessionID: string
  partID: string
  text: string
}

function mux(options: { maxQueuedEvents?: number; maxQueuedBytes?: number; flushAfterMs?: number } = {}) {
  const batches: Delta[][] = []
  const queue = createUiEventMux<Delta>({
    sessionID: (event) => event.sessionID,
    key: (event) => event.partID,
    merge: (previous, next) => ({ ...previous, text: previous.text + next.text }),
    size: (event) => new TextEncoder().encode(event.text).byteLength,
    deliver: (events) => batches.push([...events]),
    maxQueuedEvents: options.maxQueuedEvents ?? 8,
    maxQueuedBytes: options.maxQueuedBytes ?? 64,
    flushAfterMs: options.flushAfterMs ?? 10_000,
  })
  return { queue, batches }
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
  expect(batches).toEqual([[{ sessionID: "a", partID: "one", text: "a" }, { sessionID: "a", partID: "two", text: "b" }]])
  expect(queue.stats()).toEqual({ pendingEvents: 1, pendingBytes: 1, coalesced: 0 })

  queue.push({ sessionID: "a", partID: "large", text: "12345" })
  expect(batches[1]).toEqual([{ sessionID: "a", partID: "three", text: "c" }])
  expect(batches[2]).toEqual([{ sessionID: "a", partID: "large", text: "12345" }])
  expect(queue.stats()).toEqual({ pendingEvents: 0, pendingBytes: 0, coalesced: 0 })
  queue.close()
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
