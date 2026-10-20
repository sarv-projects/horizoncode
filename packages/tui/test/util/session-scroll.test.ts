import { describe, expect, test } from "bun:test"
import { findNextVisibleMessage } from "../../src/util/session-scroll"

type Message = { id: string }
type Part = { type: string; synthetic?: boolean; ignored?: boolean }
type Child = { id?: string; y: number }

function find(
  messages: Message[],
  children: Child[],
  parts: Record<string, Part[] | undefined>,
  scrollTop: number,
  direction: "next" | "prev",
) {
  return findNextVisibleMessage(messages, children, parts, scrollTop, direction)
}

describe("session scroll message navigation", () => {
  const messages = ["visible-top", "synthetic", "ignored", "no-text", "no-parts", "visible-bottom"].map((id) => ({ id }))
  const parts: Record<string, Part[] | undefined> = {
    "visible-top": [{ type: "text" }],
    synthetic: [{ type: "text", synthetic: true }],
    ignored: [{ type: "text", ignored: true }],
    "no-text": [{ type: "reasoning" }, { type: "tool" }],
    "visible-bottom": [{ type: "text", ignored: true }, { type: "text" }],
  }
  const children = [
    { id: "visible-bottom", y: 50 },
    { id: "synthetic", y: 20 },
    { id: "not-a-message", y: 25 },
    { y: 30 },
    { id: "no-parts", y: 35 },
    { id: "ignored", y: 40 },
    { id: "visible-top", y: 15 },
    { id: "no-text", y: 45 },
  ]

  test("next selects the nearest lower visible message in y order", () => {
    expect(find(messages, children, parts, 0, "next")).toBe("visible-top")
    expect(find(messages, children, parts, 10, "next")).toBe("visible-bottom")
  })

  test("previous selects the nearest upper visible message in y order", () => {
    expect(find(messages, children, parts, 61, "prev")).toBe("visible-bottom")
    expect(find(messages, children, parts, 50, "prev")).toBe("visible-top")
  })

  test("keeps the existing ten-cell boundary and returns null when no target qualifies", () => {
    expect(find(messages, children, parts, 0, "next")).toBe("visible-top")
    expect(find(messages, children, parts, 20, "next")).toBe("visible-bottom")
    expect(find(messages, children, parts, 10, "prev")).toBeNull()
    expect(find(messages, children, parts, 50, "next")).toBeNull()
    expect(find(messages, children, parts, 0, "prev")).toBeNull()
  })

  test("finds correct targets across 10,000 messages", () => {
    const longMessages = Array.from({ length: 10_000 }, (_, index) => ({ id: `message-${index}` }))
    const longParts = Object.fromEntries(longMessages.map(({ id }) => [id, [{ type: "text" }]]))
    const longChildren = longMessages.map(({ id }, index) => ({ id, y: index * 2 }))

    expect(find(longMessages, longChildren, longParts, 19_998, "prev")).toBe("message-9993")
    expect(find(longMessages, longChildren, longParts, 19_978, "next")).toBe("message-9995")
    expect(find(longMessages, longChildren, longParts, 10_000, "prev")).toBe("message-4994")
    expect(find(longMessages, longChildren, longParts, 10_000, "next")).toBe("message-5006")
  })

})
