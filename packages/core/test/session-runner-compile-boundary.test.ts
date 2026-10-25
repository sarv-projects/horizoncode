import { describe, expect, test } from "bun:test"
import {
  directContextCompileOverlapV1,
  directContextSpeedPlanV1,
} from "@opencode-ai/core/session/runner/llm"

/**
 * §30.28 SP-A..D wiring at the direct runner's compile boundary.
 *
 * The Runner owns the exact point where a direct turn's immutable context is
 * frozen. These tests pin the two P3 planner consumers used there: the cold-index
 * speed plan (must never block Send, never fabricate a warm index) and the
 * compile-overlap decision (provider start may reuse/overlap only an exact
 * unchanged ledger + compile policy).
 */
describe("direct runner compile boundary", () => {
  test("cold RepoIntel is honest, symbol-first and never blocks Send (SP-B/C)", () => {
    const cold = directContextSpeedPlanV1({ modelContextLimit: 200_000, nativeTools: true })
    expect(cold).toMatchObject({
      sendBlocked: false,
      indexWarming: true,
      indexMode: "lexical_fallback",
      symbolFirst: true,
      toolBias: ["repo.tree", "symbols.search", "files.read"],
      harnessPreference: "native-rich",
      reason: "index_unavailable",
    })
  })

  test("small context windows prefer the minimal harness, large/no-tool turns do not (SP-D)", () => {
    expect(directContextSpeedPlanV1({ modelContextLimit: 8_000, nativeTools: true }).harnessPreference).toBe(
      "native-minimal",
    )
    expect(directContextSpeedPlanV1({ modelContextLimit: 8_001, nativeTools: true }).harnessPreference).toBe(
      "native-rich",
    )
    expect(directContextSpeedPlanV1({ modelContextLimit: 200_000, nativeTools: false }).harnessPreference).toBe(
      "native-minimal",
    )
    // Unknown/invalid limits are omitted rather than fabricated as a bound.
    expect(directContextSpeedPlanV1({ nativeTools: true }).harnessPreference).toBe("native-rich")
    expect(directContextSpeedPlanV1({ modelContextLimit: 0, nativeTools: true }).harnessPreference).toBe(
      "native-rich",
    )
  })

  test("overlap is allowed only for the exact same ledger and compile policy (SP-A)", () => {
    const previous = {
      ledgerDigest: `blake3:${"1".repeat(64)}`,
      compilePolicyDigest: `blake3:${"2".repeat(64)}`,
    }
    expect(directContextCompileOverlapV1({ previous, current: previous })).toMatchObject({
      overlap: true,
      reason: "digest_unchanged",
      maxOverlapMs: 250,
    })
    expect(
      directContextCompileOverlapV1({
        previous,
        current: { ...previous, ledgerDigest: `blake3:${"3".repeat(64)}` },
      }),
    ).toMatchObject({ overlap: false, reason: "digest_changed" })
    expect(
      directContextCompileOverlapV1({
        previous,
        current: { ...previous, compilePolicyDigest: `blake3:${"4".repeat(64)}` },
      }),
    ).toMatchObject({ overlap: false, reason: "compile_policy_changed" })
    expect(directContextCompileOverlapV1({ current: previous })).toMatchObject({
      overlap: false,
      reason: "no_previous_ledger",
    })
  })
})
