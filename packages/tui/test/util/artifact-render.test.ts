import { expect, test } from "bun:test"
import { renderTuiArtifacts } from "../../src/util/artifact-render"

test("removes terminal control sequences from untrusted markdown text", () => {
  const result = renderTuiArtifacts("safe\u001b[31mred\u001b[0m\u001b]8;;https://bad.invalid\u0007link", { complete: true })
  expect(result.content).toBe("saferedlink")
})

test("removes non-ANSI terminal controls and expands tabs before markdown rendering", () => {
  const result = renderTuiArtifacts("left\tright\u0007\u0000\u0085done", { complete: false })
  expect(result.content).toBe("left  rightdone")
})

test("renders only a closed, supported Mermaid flowchart and keeps the source", () => {
  const source = "```mermaid\nflowchart LR\nA[Start] --> B[Finish]\n```"
  const rendered = renderTuiArtifacts(source, { complete: true })
  expect(rendered.content).toContain(source)
  expect(rendered.content).toContain("Start (A) → Finish (B)")
  expect(rendered.diagnostics).toEqual([])

  const partial = renderTuiArtifacts("```mermaid\nflowchart LR\nA --> B", { complete: false })
  expect(partial.content).toBe("```mermaid\nflowchart LR\nA --> B")
})

test("keeps unsupported Mermaid and SVG as inert source with a diagnostic", () => {
  const mermaid = "```mermaid\nstateDiagram-v2\n[*] --> Ready\n```"
  const unsupported = renderTuiArtifacts(mermaid, { complete: true })
  expect(unsupported.content).toContain(mermaid)
  expect(unsupported.diagnostics).toHaveLength(1)

  const svg = '```svg\n<svg onload="run()"><script>run()</script></svg>\n```'
  const fallback = renderTuiArtifacts(svg, { complete: true })
  expect(fallback.content).toContain(svg)
  expect(fallback.diagnostics).toHaveLength(1)
  expect(fallback.content).toContain("SVG preview unavailable")
})

test("does not render Mermaid directives or unsupported grammar", () => {
  const source = "```mermaid\n%%{init: {'securityLevel': 'loose'}}%%\nflowchart LR\nA[Start] --> B[Finish]\n```"
  const rendered = renderTuiArtifacts(source, { complete: true })
  expect(rendered.content).toContain(source)
  expect(rendered.content).not.toContain("Start (A) → Finish (B)")
  expect(rendered.diagnostics).toHaveLength(1)
})

test("charts only complete numeric tables and preserves original values and units", () => {
  const table = "| Build | Duration |\n| --- | ---: |\n| Fast | 12 ms |\n| Safe | 18 ms |"
  expect(renderTuiArtifacts(table, { complete: false }).content).toBe(table)
  const rendered = renderTuiArtifacts(table, { complete: true })
  expect(rendered.content).toContain(table)
  expect(rendered.content).toContain("Fast")
  expect(rendered.content).toContain("12 ms")
  expect(rendered.content).toContain("18 ms")
  expect(rendered.content).toContain("█")
})

test("does not chart numeric tables with mixed units", () => {
  const table = "| Build | Duration |\n| --- | ---: |\n| Fast | 12 ms |\n| Safe | 18 s |"
  const rendered = renderTuiArtifacts(table, { complete: true })
  expect(rendered.content).toBe(table)
  expect(rendered.diagnostics).toEqual([])
})

test("checks the render limit without allocating an encoded copy of the source", () => {
  const originalEncode = TextEncoder.prototype.encode
  TextEncoder.prototype.encode = () => {
    throw new Error("unexpected full-source UTF-8 encoding")
  }

  try {
    expect(renderTuiArtifacts("plain text", { complete: true }).content).toBe("plain text")
  } finally {
    TextEncoder.prototype.encode = originalEncode
  }
})

test("uses UTF-8 byte length at the exact render limit", () => {
  const maxBytes = 256 * 1024
  const exactLimit = `${"a".repeat(maxBytes - 2)}é`
  const overLimit = `${"a".repeat(maxBytes - 1)}é`

  expect(renderTuiArtifacts(exactLimit, { complete: true }).content).toBe(exactLimit)
  expect(renderTuiArtifacts(overLimit, { complete: true }).diagnostics).toHaveLength(1)
})

test("keeps an unclosed Mermaid fence and trailing text as inert source", () => {
  const source = "```mermaid\nflowchart LR\nA --> B"
  const rendered = renderTuiArtifacts(source, { complete: true })
  expect(rendered.content).toBe(source)
  expect(rendered.diagnostics).toEqual([])
})

test("does not render Mermaid graphs beyond the node or edge caps", () => {
  const nodeLines = Array.from({ length: 65 }, (_, index) => `N${index} --> N${index + 1}`).join("\n")
  const nodes = "```mermaid\nflowchart LR\n" + nodeLines + "\n```"
  const nodeResult = renderTuiArtifacts(nodes, { complete: true })
  expect(nodeResult.content).toContain(nodes)
  expect(nodeResult.diagnostics).toHaveLength(1)

  const edgeLines = Array.from({ length: 129 }, () => "A --> B").join("\n")
  const edges = "```mermaid\nflowchart LR\n" + edgeLines + "\n```"
  const edgeResult = renderTuiArtifacts(edges, { complete: true })
  expect(edgeResult.content).toContain(edges)
  expect(edgeResult.diagnostics).toHaveLength(1)
})

test("marks additional renderable blocks when the preview budget is exhausted", () => {
  const blocks = Array.from(
    { length: 33 },
    (_, index) => "```mermaid\nflowchart LR\nA" + index + " --> B" + index + "\n```",
  ).join("\n")
  const rendered = renderTuiArtifacts(blocks, { complete: true })
  expect(rendered.content).toContain("Preview limit reached; 1 additional block kept as source only.")
  expect(rendered.diagnostics).toHaveLength(1)
})

test("keeps chart previews inside their text fence when labels contain backticks", () => {
  const table = "| Build | Duration |\n| --- | ---: |\n| `a` | 12 ms |\n| ```b``` | 18 ms |"
  const rendered = renderTuiArtifacts(table, { complete: true })
  expect(rendered.content).toContain(table)
  expect(rendered.content).toContain("\n````text\n")
  expect(rendered.content).toContain("```b```")
  expect(rendered.content.endsWith("\n````")).toBe(true)
})

test("produces identical chart output for identical source", () => {
  const table = "| Build | Duration |\n| --- | ---: |\n| Fast | 12 ms |\n| Safe | 18 ms |"
  expect(renderTuiArtifacts(table, { complete: true }).content).toBe(renderTuiArtifacts(table, { complete: true }).content)
})

test("does not chart numeric tables with fewer than two rows or a non-positive maximum", () => {
  const singleRow = "| Build | Duration |\n| --- | ---: |\n| Fast | 12 ms |"
  expect(renderTuiArtifacts(singleRow, { complete: true }).content).toBe(singleRow)

  const zero = "| Build | Duration |\n| --- | ---: |\n| Fast | 0 ms |\n| Safe | 0 ms |"
  expect(renderTuiArtifacts(zero, { complete: true }).content).toBe(zero)
})
