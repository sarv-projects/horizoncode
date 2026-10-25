import { describe, expect, test } from "bun:test"
import { inspectUtf8ByteLength } from "../../src/util/utf8"

describe("inspectUtf8ByteLength", () => {
  test("counts UTF-8 bytes exactly when under the limit", () => {
    expect(inspectUtf8ByteLength("aé😀", 8)).toEqual({ byteLength: 7, scannedCodeUnits: 4, exceeded: false })
  })

  test("stops at the first code point over the byte cap", () => {
    const result = inspectUtf8ByteLength(`${"a".repeat(64 * 1024)}${"b".repeat(1_000_000)}`, 64 * 1024)
    expect(result.exceeded).toBe(true)
    expect(result.byteLength).toBe(64 * 1024 + 1)
    expect(result.scannedCodeUnits).toBe(64 * 1024 + 1)
  })

  test("does not split a surrogate pair at the cap", () => {
    expect(inspectUtf8ByteLength("a😀", 4)).toEqual({ byteLength: 5, scannedCodeUnits: 3, exceeded: true })
  })
})
