import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters as ShellParameters } from "../../src/tool/shell/prompt"
import { formatVerifyOutput, verificationStatus } from "../../src/tool/verify/parameters"

describe("verify tool helpers", () => {
  test("verificationStatus maps exit code 0 to passed", () => {
    expect(verificationStatus(0)).toBe("passed")
    expect(verificationStatus(1)).toBe("failed")
    expect(verificationStatus(undefined)).toBe("failed")
  })

  test("formatVerifyOutput prefixes JSON status line", () => {
    const out = formatVerifyOutput("tests.test_foo", "passed", "ok\n")
    expect(out.startsWith('{"label":"tests.test_foo","status":"passed"}\n')).toBe(true)
    expect(out.endsWith("ok\n")).toBe(true)
  })

  test("missing exit code is failed not passed", () => {
    expect(verificationStatus(undefined)).not.toBe("passed")
  })
})

describe("bash labelled verification", () => {
  test("shell schema accepts optional label", () => {
    const decoded = Schema.decodeUnknownSync(ShellParameters)({
      command: "pytest tests/test_foo.py",
      label: "tests.test_foo",
    })
    expect(decoded.label).toBe("tests.test_foo")
  })
})
