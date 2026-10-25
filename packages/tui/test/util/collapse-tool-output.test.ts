import { expect, test } from "bun:test"
import {
  boundToolOutput,
  collapseToolOutput,
  redactToolText,
  sanitizeToolDisplayValue,
  safeToolName,
  safeTimelineTitle,
  toolArtifactFidelity,
  toolArgumentPreview,
} from "../../src/util/collapse-tool-output"

test("tool labels accept only printable capability identifiers", () => {
  expect(safeToolName("repo.search_text")).toBe("repo.search_text")
  expect(safeToolName(`${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m`)).toBe("tool")
  expect(safeToolName("tool\u202ename")).toBe("tool")
  expect(safeToolName("x".repeat(81))).toBe("tool")
})

test("tool text strips C1 controls and all bidi formatting controls", () => {
  const c1Csi = `left${String.fromCharCode(0x009b)}2Jright`
  expect(redactToolText(c1Csi)).toBe("leftright")

  const unsafe = `left${String.fromCharCode(0x0085)}${String.fromCharCode(0x061c)}${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}${String.fromCharCode(0x202e)}${String.fromCharCode(0x206f)}right`
  expect(redactToolText(unsafe)).toBe("leftright")
})

test("timeline labels redact credentials and cap prompt text before rendering", () => {
  const title = safeTimelineTitle(`Review Bearer private-token-value\n${"x".repeat(4096)}`)
  expect(title).toContain("Bearer [REDACTED]")
  expect(title).not.toContain("private-token-value")
  expect(new TextEncoder().encode(title).byteLength).toBeLessThanOrEqual(512)
  expect(title).not.toContain("\n")
})

test("passes through output within the line and character budget", () => {
  const output = "one\ntwo\nthree"
  expect(collapseToolOutput(output, 3, 100)).toEqual({
    output,
    overflow: false,
    truncated: false,
    totalLines: 3,
    shownLines: 3,
    shownChars: 13,
  })

  expect(collapseToolOutput("", 3, 100).overflow).toBe(false)
  expect(collapseToolOutput("👍", 1, 1).shownChars).toBe(1)
})

test("labels truncation by lines and preserves the received line count", () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n")
  const collapsed = collapseToolOutput(output, 2, 10_000)
  expect(collapsed.truncated).toBe("lines")
  expect(collapsed.overflow).toBe(true)
  expect(collapsed.output).toBe("line 0\nline 1\n…")
  expect(collapsed.totalLines).toBe(10)
  expect(collapsed.shownLines).toBe(2)
})

test("labels truncation by characters when a single line exceeds the char budget", () => {
  const collapsed = collapseToolOutput("x".repeat(100), 3, 10)
  expect(collapsed.truncated).toBe("chars")
  expect(collapsed.output).toBe(`${"x".repeat(9)}…`)
  expect(collapsed.shownChars).toBe(10)
  expect(collapsed.totalLines).toBe(1)
})

test("never splits surrogate pairs when truncating by characters", () => {
  const collapsed = collapseToolOutput("👍👍👍", 1, 2)
  expect(collapsed.truncated).toBe("chars")
  expect(collapsed.output).toBe("👍…")
  expect(collapsed.shownChars).toBe(2)
  expect(collapsed.output.length).toBe(3)
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(collapsed.output)).toBe(false)
})

test("tool argument previews redact secret fields and credential patterns", () => {
  const preview = toolArgumentPreview({
    command: "curl -H 'Authorization: Bearer bearer-secret-value' https://example.invalid",
    filePath: "src/session.ts",
    apiKey: "sk-live-secret-value",
    content: "private source text",
    unknown: "unclassified value",
  })

  expect(preview).toContain("command=")
  expect(preview).toContain("filePath=")
  expect(preview).toContain("apiKey=[REDACTED]")
  expect(preview).toContain("content=[omitted]")
  expect(preview).toContain("unknown=[omitted]")
  expect(preview).not.toContain("bearer-secret-value")
  expect(preview).not.toContain("sk-live-secret-value")
  expect(preview).not.toContain("private source text")
})

test("tool command previews omit arbitrary arguments that cannot be reliably redacted", () => {
  const command = "curl --data 'private form payload' 'https://example.invalid/?session=private-session-value'"
  const preview = toolArgumentPreview({ command })
  const expanded = JSON.stringify(sanitizeToolDisplayValue({ input: { command } }))

  expect(preview).toContain('command="curl …"')
  expect(expanded).toContain('"command":"curl …"')
  expect(preview).not.toContain("private form payload")
  expect(preview).not.toContain("private-session-value")
  expect(expanded).not.toContain("private form payload")
  expect(expanded).not.toContain("private-session-value")
})

test("tool argument previews and output have hard presentation bounds", () => {
  expect(toolArgumentPreview({ command: "x".repeat(1000) }, 48).length).toBeLessThanOrEqual(48)

  const output = boundToolOutput(`api_key=hidden-secret\n${"line\n".repeat(20)}`, 64, 3)
  expect(output.truncated).toBe(true)
  expect(output.output.split("\n").length).toBeLessThanOrEqual(4)
  expect(new TextEncoder().encode(output.output).byteLength).toBeLessThanOrEqual(68)
  expect(output.output).not.toContain("hidden-secret")

  const redactionExpansion = boundToolOutput("token=x", 8)
  expect(new TextEncoder().encode(redactionExpansion.output).byteLength).toBeLessThanOrEqual(8)
  expect(redactionExpansion.output).not.toContain("token=x")
})

test("expanded tool details recursively redact secret fields and cap payload size", () => {
  const display = sanitizeToolDisplayValue({
    input: { apiKey: "sk-live-private-value", filePath: "src/main.ts" },
    nested: { password: "hidden-password" },
    content: "x".repeat(1000),
  }, 80)
  const encoded = JSON.stringify(display)

  expect(encoded).not.toContain("sk-live-private-value")
  expect(encoded).not.toContain("hidden-password")
  expect(encoded).toContain("[REDACTED]")
  expect(encoded).toContain("src/main.ts")
  expect(encoded.length).toBeLessThan(160)
})

test("artifact output fidelity requires producer truth and a usable reference", () => {
  expect(toolArtifactFidelity({ artifactRef: "artifact_1", artifactFidelity: "FULL" })).toEqual({
    visible: true,
    fidelity: "FULL",
  })
  expect(toolArtifactFidelity({ artifactRef: "artifact_1", artifactTruncated: true })).toEqual({
    visible: true,
    fidelity: "SAMPLE",
  })
  expect(toolArtifactFidelity({ artifactRef: "artifact_1", truncated: true })).toEqual({
    visible: true,
    fidelity: "UNKNOWN",
  })
  expect(toolArtifactFidelity({ artifactFidelity: "FULL" })).toEqual({
    visible: true,
    fidelity: "UNKNOWN",
  })
  expect(toolArtifactFidelity({ artifactFidelity: "FAILED" })).toEqual({
    visible: true,
    fidelity: "FAILED",
  })
})

test("expanded tool detail byte budget includes keys and empty nested collections", () => {
  const value = {
    nested: Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`long-empty-key-${index}`, [[], {}, null]]),
    ),
  }

  for (const maxBytes of [32, 64, 256]) {
    const encoded = JSON.stringify(sanitizeToolDisplayValue(value, maxBytes))
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(maxBytes)
  }
})

test("expanded tool details enforce aggregate node and collection-entry limits", () => {
  const value = Array.from({ length: 16 }, () =>
    Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => null)),
  )
  const display = sanitizeToolDisplayValue(value, 64 * 1024)
  let nodes = 0
  let collectionEntries = 0
  const visit = (item: unknown) => {
    nodes++
    if (Array.isArray(item)) {
      collectionEntries += item.length
      item.forEach(visit)
    } else if (typeof item === "object" && item !== null) {
      const entries = Object.entries(item)
      collectionEntries += entries.length
      entries.forEach(([, child]) => visit(child))
    }
  }
  visit(display)

  expect(nodes).toBeLessThanOrEqual(512)
  expect(collectionEntries).toBeLessThanOrEqual(512)
})

test("expanded serialized arguments retain only safe fields and omit payloads", () => {
  const display = sanitizeToolDisplayValue({
    input: JSON.stringify({
      filePath: "src/safe.ts",
      apiKey: "sk-live-private-value",
      content: "private source payload",
      unknown: "unclassified data",
    }),
  })
  const encoded = JSON.stringify(display)

  expect(encoded).toContain("src/safe.ts")
  expect(encoded).not.toContain("sk-live-private-value")
  expect(encoded).not.toContain("private source payload")
  expect(encoded).not.toContain("unclassified data")
})
