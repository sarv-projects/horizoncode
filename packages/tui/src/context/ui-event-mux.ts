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
    | "ui.queue.dropped_events"
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
  const sealed = new Map<string, string>()

  function touch(key: string, state: EnvelopeState) {
    cursors.delete(key)
    cursors.set(key, state)
  }

  function evictOverLimit() {
    while (cursors.size > maxCursors) {
      const oldest = cursors.keys().next().value
      if (oldest === undefined) break
      cursors.delete(oldest)
      sealed.delete(oldest)
    }
    while (sealed.size > maxCursors) {
      const oldest = sealed.keys().next().value
      if (oldest === undefined) break
      sealed.delete(oldest)
      // Losing the seal while retaining a cursor could reopen an ended stream.
      // Forget both so the next delta requires an authoritative resnapshot.
      cursors.delete(oldest)
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
      const previous = cursors.get(key)
      // A durable `ended` marker seals only its source generation. Reusing the
      // same Session/part identity in a replacement generation must admit the
      // new stream after canonical resnapshot; otherwise the old seal would
      // classify every first delta as a harmless duplicate forever.
      if (previous && previous.sourceGeneration !== cursor.sourceGeneration) sealed.delete(key)
      if (sealed.has(key) && sealed.get(key) !== cursor.sourceGeneration) sealed.delete(key)
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
      // An ended stream is final: a later delta for it can only be a replay.
      if (sealed.get(key) === cursor.sourceGeneration) return "duplicate"
      if (cursor.sequence < state.committed) return "duplicate"
      if (cursor.sequence < state.accepted) {
        return state.acceptedRanges.get(cursor.sequence) === cursor.advance ? "duplicate" : "resnapshot_required"
      }
      if (cursor.sequence > state.accepted || state.acceptedRanges.size >= MAX_UNCOMMITTED_STREAM_RANGES) {
        return "resnapshot_required"
      }
      const accepted = cursor.sequence + cursor.advance
      if (!Number.isSafeInteger(accepted)) return "resnapshot_required"
      // Only accepted progress refreshes the bounded LRU. A replayed duplicate
      // must not keep an ended/old cursor alive under pressure.
      touch(key, state)
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
      sealed.delete(key)
      sealed.set(key, cursor.sourceGeneration)
      touch(key, state)
      evictOverLimit()
      return sealed.get(key) === cursor.sourceGeneration
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
      for (const key of sealed.keys()) {
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
   * legacy paint path unless `requireCursor` is enabled for a source whose
   * deltas must always carry sequence and generation authority.
   */
  cursor?: (event: T) => StreamDeltaEnvelopeV1 | undefined
  /** Reject deltas for which the canonical cursor projection is unavailable. */
  requireCursor?: boolean
  /** Rebuild canonical state when a required cursor is missing or malformed. */
  onInvalidCursor?: (sessionID: string) => void
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
  let droppedEvents = 0
  let directDeliveries = 0
  let duplicatesSuppressed = 0
  let resnapshotsRequired = 0
  let closed = false

  function commitRun(run: EnvelopeRun | undefined) {
    if (run && envelopes) return envelopes.commit(run)
    return false
  }

  function deliver(sessionID: string, events: readonly T[], runs: readonly (EnvelopeRun | undefined)[]) {
    try {
      input.deliver(events)
    } catch {
      // A consumer can fail after partially applying a batch. Its in-memory
      // projection is then ambiguous, so never advance any accepted cursor;
      // discard that session's replay authority and rebuild from canonical
      // state before accepting another delta.
      envelopes?.forget(sessionID)
      input.onInvalidCursor?.(sessionID)
      return false
    }
    for (const run of runs) commitRun(run)
    return true
  }

  function flushOne(sessionID: string) {
    const queue = pending.get(sessionID)
    if (!queue) return
    if (queue.timer) clearTimeout(queue.timer)
    pending.delete(sessionID)
    deliver(
      sessionID,
      queue.events.map((item) => item.event),
      queue.events.map((item) => item.run),
    )
  }

  function discardQueuedStream(sessionID: string, partID: string) {
    const queue = pending.get(sessionID)
    if (!queue) return
    const retained = queue.events.filter((item) => item.run?.partID !== partID)
    if (retained.length === queue.events.length) return
    // §31.16/§31.17 and AN-009 require the dropped ephemeral count to be
    // observable alongside the coalesced count; these deltas are never
    // delivered, so count exactly what was discarded here.
    droppedEvents += queue.events.length - retained.length
    queue.events = retained
    queue.bytes = retained.reduce((total, item) => total + item.size, 0)
    if (retained.length > 0) return
    if (queue.timer) clearTimeout(queue.timer)
    pending.delete(sessionID)
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
      if (envelopes && input.requireCursor && !envelope) {
        resnapshotsRequired++
        flushOne(sessionID)
        envelopes.forget(sessionID)
        input.onInvalidCursor?.(sessionID)
        return "resnapshot_required"
      }
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
          // cursor callback. Forget this event's owning session and rebuild it.
          envelopes?.forget(sessionID)
          input.onInvalidCursor?.(sessionID)
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
      const size = sizeOf(event)
      if (size > maxQueuedBytes && envelope && run) {
        // An oversized canonical delta cannot be allowed to bypass the stream
        // byte bound through direct delivery.
        flushOne(sessionID)
        resnapshotsRequired++
        envelopes?.forget(envelope.sessionID, envelope.partID)
        input.onResnapshotRequired?.(envelope)
        return "resnapshot_required"
      }
      if (closed) {
        directDeliveries++
        deliver(sessionID, [event], [run])
        return decision
      }
      if (maxQueuedEvents === 0 || size > maxQueuedBytes) {
        directDeliveries++
        flushOne(sessionID)
        deliver(sessionID, [event], [run])
        return decision
      }

      let queue = pending.get(sessionID)
      if (!queue && (maxQueuedSessions === 0 || pending.size >= maxQueuedSessions)) {
        directDeliveries++
        deliver(sessionID, [event], [run])
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
      // A new generation replaces the canonical stream. Pending paint deltas
      // from its prior generation must not be delivered after the reset.
      discardQueuedStream(cursor.sessionID, cursor.partID)
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
          metric: "ui.queue.dropped_events",
          value: droppedEvents,
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
