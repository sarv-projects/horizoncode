import { describe, expect, test } from "bun:test"
import { Diagnostic } from "@/lsp/diagnostic"
import type { Diagnostic as LspDiagnostic } from "@/lsp/client"

function diag(line: number, severity: number = 1, message = "boom"): LspDiagnostic {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 1 },
    },
    message,
    severity: severity as 1 | 2 | 3 | 4,
  }
}

/** A diagnostic exactly as an untyped server may send it: severity omitted. */
function withoutSeverity(line: number, message = "boom"): LspDiagnostic {
  const { severity: _severity, ...rest } = diag(line, 1, message)
  return rest
}

describe("post-patch diagnostics (ACC-002)", () => {
  test("reports only errors, touched files first, then stable project order", () => {
    const result = Diagnostic.postPatch({
      touched: ["/workspace/src/z.ts"],
      diagnostics: {
        "/workspace/src/b.ts": [diag(1)],
        "/workspace/src/z.ts": [diag(2)],
        "/workspace/src/c.ts": [diag(3, 2)],
      },
    })
    expect(result.files.map((file) => file.file)).toEqual(["/workspace/src/z.ts", "/workspace/src/b.ts"])
    expect(result.files[0]?.block).toContain("ERROR [3:1] boom")
    expect(Diagnostic.postPatchText(result)).toBe(result.files.map((file) => file.block).join("\n\n"))
  })

  test("caps per-file and total output but reports the omitted counts", () => {
    const result = Diagnostic.postPatch({
      touched: ["/workspace/a.ts", "/workspace/b.ts"],
      diagnostics: {
        "/workspace/a.ts": Array.from({ length: 30 }, (_, index) => diag(index)),
        "/workspace/b.ts": [diag(0)],
      },
      maxPerFile: 5,
      maxFiles: 1,
    })
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.shown).toBe(5)
    expect(result.files[0]?.errors).toBe(30)
    expect(result.omittedFiles).toBe(1)
    expect(result.omittedErrors).toBe(26)
    expect(result.files[0]?.block).toContain("... and 25 more")
    expect(Diagnostic.postPatchText(result)).toContain("26 more errors across 2 files omitted")
  })

  test("does not render warnings or hints and never emits a block for a clean patch", () => {
    const result = Diagnostic.postPatch({
      touched: ["/workspace/a.ts"],
      diagnostics: { "/workspace/a.ts": [diag(0, 2), diag(1, 3), diag(2, 4)] },
    })
    expect(result.files).toEqual([])
    expect(Diagnostic.postPatchText(result)).toBe("")
    expect(Diagnostic.report("/workspace/a.ts", [diag(0, 2)])).toBe("")
  })

  test("merges separator variants for the same file and keeps the first reported path", () => {
    const result = Diagnostic.postPatch({
      touched: ["C:\\workspace\\src\\a.ts"],
      diagnostics: {
        "C:/workspace/src/a.ts": [diag(0)],
        "C:\\workspace\\src\\a.ts": [diag(1)],
      },
    })
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.errors).toBe(2)
  })

  test("rejects negative or non-integer budgets instead of silently widening", () => {
    expect(() => Diagnostic.postPatch({ touched: [], diagnostics: {}, maxFiles: -1 })).toThrow(TypeError)
    expect(() => Diagnostic.postPatch({ touched: [], diagnostics: {}, maxPerFile: 1.5 })).toThrow(TypeError)
  })

  test("a partially shown file counts as a file whose errors were omitted", () => {
    const result = Diagnostic.postPatch({
      touched: [],
      diagnostics: { "/workspace/src/a.ts": Array.from({ length: 30 }, (_, index) => diag(index)) },
      maxPerFile: 5,
    })
    expect(result.files).toHaveLength(1)
    expect(result.omittedFiles).toBe(0)
    expect(result.omittedErrors).toBe(25)
    const text = Diagnostic.postPatchText(result)
    expect(text).toContain("... and 25 more")
    expect(text).not.toContain("across 0 files")
    expect(text).toContain("25 more errors across 1 file omitted")
  })

  test("a zero file budget omits every file and still reports the distribution", () => {
    const result = Diagnostic.postPatch({
      touched: [],
      diagnostics: { "/workspace/src/a.ts": [diag(0)], "/workspace/src/b.ts": [diag(0)] },
      maxFiles: 0,
    })
    expect(result.files).toEqual([])
    expect(result.omittedFiles).toBe(2)
    expect(result.omittedErrors).toBe(2)
    expect(Diagnostic.postPatchText(result)).toBe(
      "... 2 more errors across 2 files omitted",
    )
  })

  test("the total error budget stops at 120 shown errors and reports the rest", () => {
    const diagnostics = Object.fromEntries(
      Array.from({ length: 13 }, (_, file) => [
        `/workspace/src/f${String(file).padStart(2, "0")}.ts`,
        Array.from({ length: 10 }, (_, index) => diag(index)),
      ]),
    )
    const result = Diagnostic.postPatch({ touched: [], diagnostics, maxFiles: 20 })
    const shown = result.files.reduce((total, file) => total + file.shown, 0)
    expect(shown).toBe(120)
    expect(result.files).toHaveLength(12)
    expect(result.omittedFiles).toBe(1)
    expect(result.omittedErrors).toBe(10)
    expect(Diagnostic.postPatchText(result)).toContain("10 more errors across 1 file omitted")
  })

  test("the rendered projection is frozen and only error severities reach it", () => {
    const result = Diagnostic.postPatch({
      touched: ["/workspace/src/a.ts"],
      diagnostics: {
        "/workspace/src/a.ts": [diag(0, 1), diag(1, 2), diag(2, 3), diag(3, 4), diag(4, 0), diag(5, 9)],
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.files)).toBe(true)
    expect(Object.isFrozen(result.files[0])).toBe(true)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.errors).toBe(1)
    expect(result.files[0]?.block).not.toContain("WARN")
    expect(result.files[0]?.block).not.toContain("INFO")
    expect(result.files[0]?.block).not.toContain("HINT")
  })
})

describe("diagnostic presentation bounds", () => {
  test("report caps a single file at 20 errors and names the remainder", () => {
    const report = Diagnostic.report("/workspace/src/a.ts", Array.from({ length: 25 }, (_, index) => diag(index)))
    const lines = report.split("\n")
    expect(lines[0]).toBe('<diagnostics file="/workspace/src/a.ts">')
    expect(lines.at(-1)).toBe("</diagnostics>")
    expect(lines.filter((line) => line.startsWith("ERROR"))).toHaveLength(20)
    expect(report).toContain("... and 5 more")
    expect(report).not.toContain("WARN")
  })

  test("report stays empty when a file has no error-severity diagnostics", () => {
    expect(Diagnostic.report("/workspace/src/a.ts", [])).toBe("")
    expect(Diagnostic.report("/workspace/src/a.ts", [diag(0, 2), diag(1, 3), diag(2, 4)])).toBe("")
  })

  test("pretty truncates an overlong message but keeps its severity and position", () => {
    const line = Diagnostic.pretty(diag(41, 1, "x".repeat(5_000)))
    expect(line.startsWith("ERROR [42:1] ")).toBe(true)
    expect(line.endsWith("…")).toBe(true)
    expect(line.length).toBe("ERROR [42:1] ".length + 4096 + 1)
    expect(line).not.toContain("x".repeat(4097))
  })

  test("pretty keeps explicit severities and falls back to ERROR for anything else", () => {
    expect(Diagnostic.pretty(diag(0, 1)).startsWith("ERROR ")).toBe(true)
    expect(Diagnostic.pretty(diag(0, 2)).startsWith("WARN ")).toBe(true)
    expect(Diagnostic.pretty(diag(0, 3)).startsWith("INFO ")).toBe(true)
    expect(Diagnostic.pretty(diag(0, 4)).startsWith("HINT ")).toBe(true)
    for (const severity of [undefined, 0, 5, 99]) {
      const diagnostic = severity === undefined ? withoutSeverity(0) : diag(0, severity)
      expect(Diagnostic.pretty(diagnostic).startsWith("ERROR "), String(severity)).toBe(true)
    }
  })
})
