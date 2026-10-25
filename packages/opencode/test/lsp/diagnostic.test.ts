import { describe, expect, test } from "bun:test"
import { Diagnostic } from "@/lsp/diagnostic"

function diag(line: number, severity: 1 | 2 | 3 | 4 = 1, message = "boom") {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 1 },
    },
    message,
    severity,
  }
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
    expect(Diagnostic.postPatchText(result)).toContain("26 more errors across 1 file omitted")
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
})
