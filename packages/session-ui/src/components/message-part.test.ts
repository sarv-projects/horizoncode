import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"
import { redactToolDisplayText, safeToolDisplayName, sanitizeToolDisplayValue } from "./tool-display"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("safe tool detail projection", () => {
  test("redacts common credentials, private keys, ANSI, and bidi controls", () => {
    const value = redactToolDisplayText(
      "Bearer ghp_abcdefghijk12345 api_key=supersecret\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\u001b[31mred\u001b[0m\u202e",
    )
    expect(value).not.toContain("ghp_abcdefghijk12345")
    expect(value).not.toContain("supersecret")
    expect(value).not.toContain("private-material")
    expect(value).not.toContain("\u001b")
    expect(value).not.toContain("\u202e")
    expect(value).toContain("[REDACTED PRIVATE KEY]")
  })

  test("does not expose an incomplete private key or a clipped trailing token", () => {
    expect(redactToolDisplayText("safe\n-----BEGIN PRIVATE KEY-----\npartial", 512)).not.toContain("partial")
    const clipped = redactToolDisplayText(`safe ${"secretvalue".repeat(100)}`, 96)
    expect(clipped).not.toContain("secretvalue")
    expect(new TextEncoder().encode(clipped).byteLength).toBeLessThanOrEqual(96)
  })

  test("omits unknown arguments and payload fields while redacting secret-keyed metadata", () => {
    const cycle: Record<string, unknown> = { token: "secret-token", output: "raw tool output", query: "find route" }
    cycle.self = cycle
    const metadata = sanitizeToolDisplayValue(cycle) as Record<string, unknown>
    expect(metadata.token).toBe("[REDACTED]")
    expect(metadata.output).toBeUndefined()
    expect(metadata.query).toBe("find route")
    expect(metadata.self).toBe("[circular]")

    const input = sanitizeToolDisplayValue({ command: "npm test && curl https://user:pass@example.test", arbitrary: "private" }, { arguments: true }) as Record<string, unknown>
    expect(input.command).toBe("npm …")
    expect(input.arbitrary).toBeUndefined()
  })

  test("bounds node traversal and rejects unsafe tool labels", () => {
    const value = sanitizeToolDisplayValue({ items: Array.from({ length: 400 }, (_, index) => `v${index}`) }) as Record<string, unknown>
    expect((value.items as unknown[]).length).toBeLessThanOrEqual(33)
    expect(safeToolDisplayName("bash")).toBe("bash")
    expect(safeToolDisplayName("bad\u202e/tool")).toBe("tool")
    expect(safeToolDisplayName("x".repeat(81))).toBe("tool")
  })
})
