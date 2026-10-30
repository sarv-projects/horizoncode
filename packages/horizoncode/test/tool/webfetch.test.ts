import { describe, expect, test } from "bun:test"
import { localCliOriginRoutesEnabled } from "../../src/util/local-cli-origin"

describe("tool.webfetch", () => {
  test("local origin routes stay off without audited env flags", () => {
    expect(localCliOriginRoutesEnabled()).toBe(false)
  })
})
