type Queued<T> = {
  event: T
  key: string
  size: number
}

type Queue<T> = {
  events: Queued<T>[]
  bytes: number
  timer?: ReturnType<typeof setTimeout>
}

export function createUiEventMux<T>(input: {
  sessionID: (event: T) => string
  key: (event: T) => string
  merge: (previous: T, next: T) => T
  size: (event: T) => number
  deliver: (events: readonly T[]) => void
  maxQueuedEvents: number
  maxQueuedBytes: number
  flushAfterMs: number
}) {
  const pending = new Map<string, Queue<T>>()
  const maxQueuedEvents = Math.max(0, Math.floor(input.maxQueuedEvents))
  const maxQueuedBytes = Math.max(0, Math.floor(input.maxQueuedBytes))
  let coalesced = 0
  let closed = false

  function flushOne(sessionID: string) {
    const queue = pending.get(sessionID)
    if (!queue) return
    if (queue.timer) clearTimeout(queue.timer)
    pending.delete(sessionID)
    input.deliver(queue.events.map((item) => item.event))
  }

  function schedule(sessionID: string, queue: Queue<T>) {
    if (queue.timer) return
    queue.timer = setTimeout(() => flushOne(sessionID), Math.max(0, input.flushAfterMs))
  }

  function sizeOf(event: T) {
    const size = input.size(event)
    if (!Number.isFinite(size)) return Number.POSITIVE_INFINITY
    return Math.max(0, Math.ceil(size))
  }

  function createQueue(sessionID: string) {
    const queue: Queue<T> = { events: [], bytes: 0 }
    pending.set(sessionID, queue)
    return queue
  }

  return {
    push(event: T) {
      if (closed) {
        input.deliver([event])
        return
      }

      const sessionID = input.sessionID(event)
      const size = sizeOf(event)
      if (maxQueuedEvents === 0 || size > maxQueuedBytes) {
        flushOne(sessionID)
        input.deliver([event])
        return
      }

      let queue = pending.get(sessionID)
      const key = input.key(event)
      const last = queue?.events.at(-1)
      if (queue && last?.key === key) {
        const merged = input.merge(last.event, event)
        const mergedSize = sizeOf(merged)
        if (mergedSize <= maxQueuedBytes) {
          last.event = merged
          queue.bytes += mergedSize - last.size
          last.size = mergedSize
          coalesced++
          schedule(sessionID, queue)
          return
        }
        flushOne(sessionID)
        queue = undefined
      }

      if (queue && (queue.events.length >= maxQueuedEvents || queue.bytes + size > maxQueuedBytes)) {
        flushOne(sessionID)
        queue = undefined
      }

      queue ??= createQueue(sessionID)
      queue.events.push({ event, key, size })
      queue.bytes += size
      schedule(sessionID, queue)
    },
    flush(sessionID?: string) {
      if (sessionID !== undefined) {
        flushOne(sessionID)
        return
      }
      for (const key of [...pending.keys()]) flushOne(key)
    },
    close() {
      if (closed) return
      closed = true
      this.flush()
    },
    stats() {
      return {
        pendingEvents: [...pending.values()].reduce((sum, queue) => sum + queue.events.length, 0),
        pendingBytes: [...pending.values()].reduce((sum, queue) => sum + queue.bytes, 0),
        coalesced,
      }
    },
  }
}
