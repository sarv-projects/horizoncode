/// One coalesced run inside a queue: the source ordinal of its first delta and
/// the number of source events merged into it.
type EnvelopeRun = {
  sessionID: string
  partID: string
  sourceGeneration: string
  sequence: number
  advance: number
}

type QueuedItem<T> = {
  event: T
  key: string
  size: number
  run?: EnvelopeRun
}

type Queue<T> = {
  events: QueuedItem<T>[]
  bytes: number
  timer?: ReturnType<typeof setTimeout>
}

export type StreamCursorV1 = {
  sessionID: string
  partID: string
  sourceGeneration: string
  sequence: number
}

/// The TUI stream envelope cursor. `sequence` is the source-owned event ordinal;
/// `advance` is the count of source events represented by this queued item.
/// Text offsets are carried separately by the event payload and never authorize replay.
export type StreamDeltaEnvelopeV1 = StreamCursorV1 & { advance: number }

export type StreamReplayDecisionV1 = "apply" | "duplicate" | "resnapshot_required"
export type StreamEnvelopeDecisionV1 = StreamReplayDecisionV1
export type MetricProvenanceV1 = "measured" | "estimated" | "unknown"

const MAX_STREAM_CURSOR_COMPONENT_LENGTH = 256

export type UiEventMuxObservationV1 = {
  metric:
    | "ui.queue.pending_events"
    | "ui.queue.pending_bytes"
    | "ui.queue.coalesced_events"
    | "ui.queue.direct_deliveries"
    | "ui.stream.duplicates_suppressed"
    | "ui.stream.resnapshots_required"
  value: number
  unit: "events" | "bytes"
  provenance: MetricProvenanceV1
  source: "ui-event-mux"
  observedAtMs: number
}

type StreamCursorState = {
  sourceGeneration: string
  sequence: number
}

type EnvelopeState = {
  sourceGeneration: string
  committed: number
  accepted: number
  acceptedRanges: Map<number, number>
}

const MAX_UNCOMMITTED_STREAM_RANGES = 4096

/**
 * Reconciles replayable stream deltas against a canonical source cursor.
 * The owning Session/message store remains the source of text; this helper only
 * gates duplicate, stale-generation, and gap events before they reach that store.
 */
export function createStreamReplayGuard(input: { maxCursors?: number } = {}) {
  const rawLimit = input.maxCursors ?? 4096
  const maxCursors = Number.isFinite(rawLimit)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(rawLimit)))
    : 0
  const cursors = new Map<string, StreamCursorState>()

  function keyOf(cursor: Pick<StreamCursorV1, "sessionID" | "partID">) {
    return JSON.stringify([cursor.sessionID, cursor.partID])
  }

  function valid(cursor: StreamCursorV1) {
    return (
      typeof cursor === "object" &&
      cursor !== null &&
      typeof cursor.sessionID === "string" &&
      cursor.sessionID.length > 0 &&
      cursor.sessionID.length <= MAX_STREAM_CURSOR_COMPONENT_LENGTH &&
      typeof cursor.partID === "string" &&
      cursor.partID.length > 0 &&
      cursor.partID.length <= MAX_STREAM_CURSOR_COMPONENT_LENGTH &&
      typeof cursor.sourceGeneration === "string" &&
      cursor.sourceGeneration.length > 0 &&
      cursor.sourceGeneration.length <= MAX_STREAM_CURSOR_COMPONENT_LENGTH &&
      Number.isSafeInteger(cursor.sequence) &&
      cursor.sequence >= 0
    )
  }

  function touch(key: string, state: StreamCursorState) {
    cursors.delete(key)
    cursors.set(key, state)
  }

  return {
    /** Seed or replace a cursor from canonical message/part state. */
    seed(cursor: StreamCursorV1) {
      if (maxCursors === 0 || !valid(cursor)) return false
      const key = keyOf(cursor)
      touch(key, { sourceGeneration: cursor.sourceGeneration, sequence: cursor.sequence })
      while (cursors.size > maxCursors) {
        const oldest = cursors.keys().next().value
        if (oldest === undefined) break
        cursors.delete(oldest)
      }
      return cursors.has(key)
    },
    /**
     * Apply only the next delta. Replayed sequences are harmless; gaps or a
     * changed source generation require rebuilding from canonical state.
     */
    accept(cursor: StreamCursorV1): StreamReplayDecisionV1 {
      if (!valid(cursor)) return "resnapshot_required"
      const key = keyOf(cursor)
      const state = cursors.get(key)
      if (!state || state.sourceGeneration !== cursor.sourceGeneration) return "resnapshot_required"

      touch(key, state)
      if (cursor.sequence <= state.sequence) return "duplicate"
      if (state.sequence === Number.MAX_SAFE_INTEGER || cursor.sequence !== state.sequence + 1) {
        return "resnapshot_required"
      }
      state.sequence = cursor.sequence
      return "apply"
    },
    forget(sessionID: string, partID?: string) {
      if (partID !== undefined) {
        cursors.delete(keyOf({ sessionID, partID }))
        return
      }
      for (const key of cursors.keys()) {
        const parsed = JSON.parse(key) as [string, string]
        if (parsed[0] === sessionID) cursors.delete(key)
      }
    },
    stats() {
      return { trackedCursors: cursors.size }
    },
  }
}

function validEnvelope(cursor: StreamDeltaEnvelopeV1) {
  return (
    typeof cursor === "object" &&
    cursor !== null &&
    typeof cursor.sessionID === "string" &&
    cursor.sessionID.length > 0 &&
    cursor.sessionID.length <= MAX_STREAM_CURSOR_COMPONENT_LENGTH &&
    typeof cursor.partID === "string" &&
    cursor.partID.length > 0 &&
    cursor.partID.length <= MAX_STREAM_CURSOR_COMPONENT_LENGTH &&
    typeof cursor.sourceGeneration === "string" &&
    cursor.sourceGeneration.length > 0 &&
    cursor.sourceGeneration.length <= MAX_STREAM_CURSOR_COMPONENT_LENGTH &&
    Number.isSafeInteger(cursor.sequence) &&
    cursor.sequence >= 0 &&
    Number.isSafeInteger(cursor.advance) &&
    cursor.advance > 0
  )
}

/**
 * Source-ordinal replay guard for TUI stream envelopes.
 *
 * `sequence` is the source-emitted event ordinal. The guard reserves accepted
 * ordinal ranges, suppresses exact duplicate ranges, and requires the next range
 * to begin at the current accepted ordinal. A gap, overlap, generation
 * change, or unknown/evicted cursor requires a canonical resnapshot.
 *
 * `accept` reserves source ordinals while text is queued; `commit` advances the
 * delivered ordinal only after the text reached canonical state. Every canonical
 * rebuild must call `seed` again.
 */
export function createStreamEnvelopeGuard(input: { maxCursors?: number } = {}) {
  const rawLimit = input.maxCursors ?? 4096
  const maxCursors = Number.isFinite(rawLimit)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(rawLimit)))
    : 0
  const cursors = new Map<string, EnvelopeState>()
  const sealed = new Set<string>()

  function touch(key: string, state: EnvelopeState) {
    cursors.delete(key)
    cursors.set(key, state)
  }

  function evictOverLimit() {
    while (cursors.size > maxCursors) {
      const oldest = cursors.keys().next().value
      if (oldest === undefined) break
      cursors.delete(oldest)
    }
    while (sealed.size > maxCursors) {
      const oldest = sealed.values().next().value
      if (oldest === undefined) break
      sealed.delete(oldest)
    }
  }

  return {
    /** Replace the committed source ordinal from an authoritative event cursor. */
    seed(cursor: StreamCursorV1) {
      // Seed carries a cursor, not a delta. Use a valid positive sentinel only
      // for the shared shape validator; the seed stores sequence directly.
      const envelope = { ...cursor, advance: 1 }
      if (maxCursors === 0 || !validEnvelope(envelope)) return false
      const key = JSON.stringify([cursor.sessionID, cursor.partID])
      touch(key, {
        sourceGeneration: cursor.sourceGeneration,
        committed: cursor.sequence,
        accepted: cursor.sequence,
        acceptedRanges: new Map(),
      })
      evictOverLimit()
      return cursors.has(key)
    },
    /** Decide a delta against the committed source ordinal. */
    accept(cursor: StreamDeltaEnvelopeV1): StreamEnvelopeDecisionV1 {
      if (!validEnvelope(cursor)) return "resnapshot_required"
      const key = JSON.stringify([cursor.sessionID, cursor.partID])
      const state = cursors.get(key)
      if (!state || state.sourceGeneration !== cursor.sourceGeneration) return "resnapshot_required"
      touch(key, state)
      // An ended stream is final: a later delta for it can only be a replay.
      if (sealed.has(key)) return "duplicate"
      if (cursor.sequence < state.committed) return "duplicate"
      if (cursor.sequence < state.accepted) {
        return state.acceptedRanges.get(cursor.sequence) === cursor.advance ? "duplicate" : "resnapshot_required"
      }
      if (cursor.sequence > state.accepted || state.acceptedRanges.size >= MAX_UNCOMMITTED_STREAM_RANGES) {
        return "resnapshot_required"
      }
      const accepted = cursor.sequence + cursor.advance
      if (!Number.isSafeInteger(accepted)) return "resnapshot_required"
      state.acceptedRanges.set(cursor.sequence, cursor.advance)
      state.accepted = accepted
      return "apply"
    },
    /**
     * Seal a stream whose durable `ended` bracket was applied; further deltas for
     * it are replays until the stream is explicitly reset (`forget`) or restarted.
     */
    seal(cursor: StreamCursorV1) {
      const key = JSON.stringify([cursor.sessionID, cursor.partID])
      const state = cursors.get(key)
      if (!state || state.sourceGeneration !== cursor.sourceGeneration) return false
      sealed.add(key)
      evictOverLimit()
      return sealed.has(key)
    },
    /** Advance committed state after the delta was delivered to canonical state. */
    commit(cursor: StreamDeltaEnvelopeV1) {
      if (!validEnvelope(cursor)) return false
      const key = JSON.stringify([cursor.sessionID, cursor.partID])
      const state = cursors.get(key)
      if (!state || state.sourceGeneration !== cursor.sourceGeneration) return false
      if (cursor.sequence !== state.committed) return false
      const committed = cursor.sequence + cursor.advance
      if (!Number.isSafeInteger(committed) || committed > state.accepted) return false
      state.committed = committed
      for (const sequence of state.acceptedRanges.keys()) {
        if (sequence < committed) state.acceptedRanges.delete(sequence)
      }
      touch(key, state)
      return true
    },
    forget(sessionID: string, partID?: string) {
      if (partID !== undefined) {
        const key = JSON.stringify([sessionID, partID])
        cursors.delete(key)
        sealed.delete(key)
        return
      }
      for (const key of cursors.keys()) {
        const parsed = JSON.parse(key) as [string, string]
        if (parsed[0] === sessionID) cursors.delete(key)
      }
      for (const key of sealed.values()) {
        const parsed = JSON.parse(key) as [string, string]
        if (parsed[0] === sessionID) sealed.delete(key)
      }
    },
    /** Drop every cursor after a stream reconnect; returns the forgotten count. */
    forgetAll() {
      const forgotten = cursors.size
      cursors.clear()
      sealed.clear()
      return forgotten
    },
    stats() {
      return { trackedCursors: cursors.size }
    },
  }
}

export function createUiEventMux<T>(input: {
  sessionID: (event: T) => string
  key: (event: T) => string
  merge: (previous: T, next: T) => T
  size: (event: T) => number
  sizeProvenance?: MetricProvenanceV1
  deliver: (events: readonly T[]) => void
  maxQueuedEvents: number
  maxQueuedBytes: number
  maxQueuedSessions?: number
  flushAfterMs: number
  /**
   * Canonical envelope of a replayable event. `undefined` keeps the event on the
   * legacy paint path, which is coalesced but never replay-gated.
   */
  cursor?: (event: T) => StreamDeltaEnvelopeV1 | undefined
  /** Called after the session queue was flushed because canonical state must be rebuilt. */
  onResnapshotRequired?: (cursor: StreamDeltaEnvelopeV1) => void
  maxStreamCursors?: number
}) {
  const pending = new Map<string, Queue<T>>()
  const boundedLimit = (value: number) =>
    Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0
  const maxQueuedEvents = boundedLimit(input.maxQueuedEvents)
  const maxQueuedBytes = boundedLimit(input.maxQueuedBytes)
  const maxQueuedSessions = boundedLimit(input.maxQueuedSessions ?? 64)
  const envelopes = input.cursor
    ? createStreamEnvelopeGuard({ maxCursors: input.maxStreamCursors ?? 4096 })
    : undefined
  let coalesced = 0
  let directDeliveries = 0
  let duplicatesSuppressed = 0
  let resnapshotsRequired = 0
  let closed = false

  function commitRun(run: EnvelopeRun | undefined) {
    if (run && envelopes) return envelopes.commit(run)
    return false
  }

  function flushOne(sessionID: string) {
    const queue = pending.get(sessionID)
    if (!queue) return
    if (queue.timer) clearTimeout(queue.timer)
    pending.delete(sessionID)
    input.deliver(queue.events.map((item) => item.event))
    for (const item of queue.events) commitRun(item.run)
  }

  function schedule(sessionID: string, queue: Queue<T>) {
    if (queue.timer) return
    const delay = Number.isFinite(input.flushAfterMs) ? Math.max(0, input.flushAfterMs) : 0
    queue.timer = setTimeout(() => flushOne(sessionID), delay)
  }

  function sizeOf(event: T) {
    const size = input.size(event)
    if (!Number.isFinite(size)) return Number.POSITIVE_INFINITY
    return Math.max(0, Math.ceil(size))
  }

  function runContiguous(run: EnvelopeRun | undefined, envelope: StreamDeltaEnvelopeV1 | undefined) {
    if (!run || !envelope) return run === undefined && envelope === undefined
    // While a run is queued its committed ordinal cannot advance, so each next
    // source event must begin where the queued run's ordinal range currently ends.
    return (
      run.sourceGeneration === envelope.sourceGeneration &&
      run.sequence + run.advance === envelope.sequence
    )
  }

  function currentStats() {
    return {
      pendingEvents: [...pending.values()].reduce((sum, queue) => sum + queue.events.length, 0),
      pendingBytes: [...pending.values()].reduce((sum, queue) => sum + queue.bytes, 0),
      coalesced,
    }
  }

  function createQueue(sessionID: string) {
    const queue: Queue<T> = { events: [], bytes: 0 }
    pending.set(sessionID, queue)
    return queue
  }

  return {
    /** Queue an event; returns the replay decision when the event is gated by a cursor. */
    push(event: T): StreamEnvelopeDecisionV1 | undefined {
      const sessionID = input.sessionID(event)
      const envelope = envelopes ? input.cursor!(event) : undefined
      if (envelope && validEnvelope(envelope) && envelope.sessionID !== sessionID) {
        resnapshotsRequired++
        flushOne(sessionID)
        flushOne(envelope.sessionID)
        envelopes?.forget(envelope.sessionID, envelope.partID)
        input.onResnapshotRequired?.(envelope)
        return "resnapshot_required"
      }
      const decision = envelope ? envelopes!.accept(envelope) : undefined
      if (decision === "duplicate") {
        duplicatesSuppressed++
        return decision
      }
      if (decision === "resnapshot_required") {
        resnapshotsRequired++
        flushOne(sessionID)
        if (envelope && validEnvelope(envelope)) {
          flushOne(envelope.sessionID)
          envelopes?.forget(envelope.sessionID, envelope.partID)
          input.onResnapshotRequired?.(envelope)
        } else {
          // Invalid cursor fields cannot safely identify a stream to pass to the
          // resnapshot callback. Forget this event's owning session instead.
          envelopes?.forget(sessionID)
        }
        return decision
      }

      const run = envelope
        ? {
            sessionID: envelope.sessionID,
            partID: envelope.partID,
            sourceGeneration: envelope.sourceGeneration,
            sequence: envelope.sequence,
            advance: envelope.advance,
          }
        : undefined
      if (closed) {
        directDeliveries++
        input.deliver([event])
        commitRun(run)
        return decision
      }

      const size = sizeOf(event)
      if (size > maxQueuedBytes && envelope && run) {
        // An oversized canonical delta cannot be allowed to bypass the stream
        // byte bound through direct delivery. Rebuild from the owning store.
        flushOne(sessionID)
        resnapshotsRequired++
        envelopes?.forget(envelope.sessionID, envelope.partID)
        input.onResnapshotRequired?.(envelope)
        return "resnapshot_required"
      }
      if (maxQueuedEvents === 0 || size > maxQueuedBytes) {
        directDeliveries++
        flushOne(sessionID)
        input.deliver([event])
        commitRun(run)
        return decision
      }

      let queue = pending.get(sessionID)
      if (!queue && (maxQueuedSessions === 0 || pending.size >= maxQueuedSessions)) {
        directDeliveries++
        input.deliver([event])
        commitRun(run)
        return decision
      }
      const key = input.key(event)
      const last = queue?.events.at(-1)
      if (queue && last?.key === key && runContiguous(last.run, envelope)) {
        const merged = input.merge(last.event, event)
        const mergedSize = sizeOf(merged)
        const mergedQueueBytes = queue.bytes - last.size + mergedSize
        if (mergedSize <= maxQueuedBytes && mergedQueueBytes <= maxQueuedBytes) {
          last.event = merged
          queue.bytes = mergedQueueBytes
          last.size = mergedSize
          if (last.run && envelope) last.run.advance += envelope.advance
          coalesced++
          schedule(sessionID, queue)
          return decision
        }
        flushOne(sessionID)
        queue = undefined
      }

      if (queue && (queue.events.length >= maxQueuedEvents || queue.bytes + size > maxQueuedBytes)) {
        flushOne(sessionID)
        queue = undefined
      }

      queue ??= createQueue(sessionID)
      queue.events.push({ event, key, size, run })
      queue.bytes += size
      schedule(sessionID, queue)
      return decision
    },
    flush(sessionID?: string) {
      if (sessionID !== undefined) {
        flushOne(sessionID)
        return
      }
      for (const key of [...pending.keys()]) flushOne(key)
    },
    /** Replace the committed ordinal of one stream from an authoritative cursor. */
    seedStream(cursor: StreamCursorV1) {
      return envelopes?.seed(cursor) ?? false
    },
    /** Drop cursor state for a session/part whose canonical state is being rebuilt. */
    forgetStream(sessionID: string, partID?: string) {
      envelopes?.forget(sessionID, partID)
    },
    /** Replace cursor state and clear any seal (a stream part restarted). */
    resetStream(cursor: StreamCursorV1) {
      envelopes?.forget(cursor.sessionID, cursor.partID)
      return envelopes?.seed(cursor) ?? false
    },
    /** Seal a stream whose durable end bracket was applied; later deltas are replays. */
    sealStream(cursor: StreamCursorV1) {
      return envelopes?.seal(cursor) ?? false
    },
    /**
     * Stream reconnected: apply everything already accepted, then forget every
     * cursor so the next delta proves itself against a fresh canonical
     * resnapshot instead of trusting pre-reconnect cursors.
     */
    reconnect() {
      let flushedSessions = 0
      for (const key of [...pending.keys()]) {
        flushOne(key)
        flushedSessions++
      }
      return { flushedSessions, forgottenCursors: envelopes?.forgetAll() ?? 0 }
    },
    streamStats() {
      return {
        trackedCursors: envelopes?.stats().trackedCursors ?? 0,
        duplicatesSuppressed,
        resnapshotsRequired,
      }
    },
    close() {
      if (closed) return
      closed = true
      this.flush()
    },
    stats() {
      return currentStats()
    },
    observations(): UiEventMuxObservationV1[] {
      const stats = currentStats()
      const observedAtMs = Date.now()
      return [
        {
          metric: "ui.queue.pending_events",
          value: stats.pendingEvents,
          unit: "events",
          provenance: "measured",
          source: "ui-event-mux",
          observedAtMs,
        },
        {
          metric: "ui.queue.pending_bytes",
          value: stats.pendingBytes,
          unit: "bytes",
          provenance: input.sizeProvenance ?? "unknown",
          source: "ui-event-mux",
          observedAtMs,
        },
        {
          metric: "ui.queue.coalesced_events",
          value: stats.coalesced,
          unit: "events",
          provenance: "measured",
          source: "ui-event-mux",
          observedAtMs,
        },
        {
          metric: "ui.queue.direct_deliveries",
          value: directDeliveries,
          unit: "events",
          provenance: "measured",
          source: "ui-event-mux",
          observedAtMs,
        },
        {
          metric: "ui.stream.duplicates_suppressed",
          value: duplicatesSuppressed,
          unit: "events",
          provenance: "measured",
          source: "ui-event-mux",
          observedAtMs,
        },
        {
          metric: "ui.stream.resnapshots_required",
          value: resnapshotsRequired,
          unit: "events",
          provenance: "measured",
          source: "ui-event-mux",
          observedAtMs,
        },
      ]
    },
  }
}
