export type SessionScrollMessage = { id: string }
export type SessionScrollPart = { type: string; synthetic?: boolean; ignored?: boolean }
export type SessionScrollChild = { id?: string; y: number }

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
