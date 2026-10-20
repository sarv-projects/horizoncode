export type SessionScrollMessage = { id: string }
export type SessionScrollPart = { type: string; synthetic?: boolean; ignored?: boolean }
export type SessionScrollChild = { id?: string; y: number }
export type TranscriptWindow = { startIndex: number; endIndex: number }

function boundedCount(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
}

/** Select a contiguous, bounded range of canonical messages to mount. */
export function transcriptWindowAt(messageCount: number, startIndex: number, maxMounted: number): TranscriptWindow {
  const total = boundedCount(messageCount)
  const limit = boundedCount(maxMounted)
  const start = Math.min(total, boundedCount(startIndex))
  return { startIndex: start, endIndex: Math.min(total, start + limit) }
}

/** Move a fixed-size mounted window while retaining overlap for scroll anchoring. */
export function shiftTranscriptWindow(
  current: TranscriptWindow,
  messageCount: number,
  maxMounted: number,
  pageSize: number,
  direction: "older" | "newer",
): TranscriptWindow {
  const total = boundedCount(messageCount)
  const limit = boundedCount(maxMounted)
  const start = Math.min(total, boundedCount(current.startIndex))
  const end = Math.max(start, Math.min(total, boundedCount(current.endIndex)))
  const page = boundedCount(pageSize)
  if (limit === 0 || page === 0) return { startIndex: start, endIndex: end }

  if (direction === "older") {
    return transcriptWindowAt(total, Math.max(0, start - page), limit)
  }
  const nextEnd = Math.min(total, end + page)
  return transcriptWindowAt(total, Math.max(0, nextEnd - limit), limit)
}

/** Keep a reader's range stable, or move a tail-following range with new history. */
export function reconcileTranscriptWindow(
  current: TranscriptWindow,
  previousCount: number,
  messageCount: number,
  maxMounted: number,
  followTail: boolean,
): TranscriptWindow {
  const previousTotal = boundedCount(previousCount)
  const total = boundedCount(messageCount)
  const limit = boundedCount(maxMounted)
  if (followTail && current.endIndex >= previousTotal) {
    return transcriptWindowAt(total, Math.max(0, total - limit), limit)
  }
  return transcriptWindowAt(total, Math.min(total, boundedCount(current.startIndex)), limit)
}

export function findNextVisibleMessage(
  messages: SessionScrollMessage[],
  children: SessionScrollChild[],
  partsByMessage: Record<string, SessionScrollPart[] | undefined>,
  scrollTop: number,
  direction: "next" | "prev",
): string | null {
  const messageByID = new Map<string, SessionScrollMessage>()
  for (const message of messages) {
    // Preserve Array.find's first-match behavior for duplicate IDs.
    if (!messageByID.has(message.id)) messageByID.set(message.id, message)
  }

  const visibleMessages: SessionScrollChild[] = []
  for (const child of children) {
    if (!child.id) continue
    const message = messageByID.get(child.id)
    if (!message) continue
    const parts = partsByMessage[message.id]
    if (!Array.isArray(parts)) continue
    if (!parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)) continue
    visibleMessages.push(child)
  }

  visibleMessages.sort((a, b) => a.y - b.y)
  if (direction === "next") {
    return visibleMessages.find((child) => child.y > scrollTop + 10)?.id ?? null
  }
  for (let index = visibleMessages.length - 1; index >= 0; index--) {
    if (visibleMessages[index].y < scrollTop - 10) return visibleMessages[index].id ?? null
  }
  return null
}
