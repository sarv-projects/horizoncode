import { describe, expect, test } from "bun:test"
import {
  builtinHarnessProfileIDsV1,
  builtinHarnessProfileV1,
  builtinHarnessSystemPromptV1,
} from "../../src/harness-profile"

/**
 * Every built-in HarnessProfileV1 ships a system prompt, and every prompt
 * carries the product's verification discipline: finding the bug is not
 * completion, an edited file is not evidence, and an unrun check is never
 * reported as passing. Pure string assertions — no provider, no network.
 */
const MARKERS = [
  "Verify before you finish",
  "Run the tests that cover the code you changed",
  "surrounding module or package suite",
  "exited 0",
  "observed its output",
  "mark the change unverified",
  "Never present an unrun check as passing",
  "exact commands you ran",
  "Keep the diff minimal",
] as const

describe("built-in harness system prompt", () => {
  test("every profiled harness resolves a non-empty prompt", () => {
    const ids = builtinHarnessProfileIDsV1()
    expect(ids.length).toBeGreaterThan(0)

    for (const id of ids) {
      const prompt = builtinHarnessSystemPromptV1(id)
      expect(prompt).toBeDefined()
      expect(prompt!.trim().length).toBeGreaterThan(0)
    }
  })

  test("every prompt carries the verification discipline markers", () => {
    for (const id of builtinHarnessProfileIDsV1()) {
      const prompt = builtinHarnessSystemPromptV1(id)!
      for (const marker of MARKERS) expect(prompt).toContain(marker)
    }
  })

  test("the discipline stays an instruction, not a manual", () => {
    for (const id of builtinHarnessProfileIDsV1()) {
      const prompt = builtinHarnessSystemPromptV1(id)!
      expect(prompt.split("\n").length).toBeLessThanOrEqual(12)
    }
  })

  test("the profile artifact ref describes the exact prompt it ships", () => {
    for (const id of builtinHarnessProfileIDsV1()) {
      const profile = builtinHarnessProfileV1(id)!
      const prompt = builtinHarnessSystemPromptV1(id)!

      expect(profile.systemPromptRef.artifactId).toBe(`builtin.harness.${id}.system.v1`)
      expect(profile.systemPromptRef.byteLength).toBe(String(Buffer.byteLength(prompt, "utf8")))
    }
  })

  test("an unknown harness id resolves no prompt", () => {
    expect(builtinHarnessSystemPromptV1("not-a-harness")).toBeUndefined()
  })
})
