import { expect, test } from "bun:test"
import { collapseToolOutput } from "../../src/util/collapse-tool-output"

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
