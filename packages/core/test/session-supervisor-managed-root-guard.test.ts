import { expect, test } from "bun:test"
import { validateManagedRootGuardChallenge, type ManagedRootGuardChallengeV1 } from "@opencode-ai/core/session/supervisor"

const locationID = `loc_${"a".repeat(64)}`
const digest = (digit: string) => `blake3:${digit.repeat(64)}`

type ManagedRootGuardChallengeFixture = ManagedRootGuardChallengeV1 & {
  readonly status: "needs_approval"
  readonly targets: ReadonlyArray<unknown>
}

function challenge(
  overrides: Partial<ManagedRootGuardChallengeFixture> = {},
): ManagedRootGuardChallengeFixture {
  const targets = [{ path: "/workspace", operation: "inspect", resource: "worktree" }]
  return {
    status: "needs_approval",
    challengeID: "challenge-root-1",
    effectID: "effect-root-1",
    capabilityID: "git.worktree.list",
    locationID,
    inputDigest: digest("1"),
    targets,
    normalizedTargets: targets,
    expiresAtUnixMs: Date.now() + 60_000,
    policySummary: "Inspect the registered worktree before managed execution.",
    origin: "managed_root",
    source: "host.managed_worktree",
    policyID: "broker-process.local.v1",
    policyDigest: digest("2"),
    normalizedAction: "git.worktree.list",
    argumentSummary: { status: "available", text: "Inspect one registered worktree" },
    requestedGuarantees: ["configured_executable", "bounded_argv_env", "beneath_workspace_root", "one_use"],
    guaranteeAssessment: { status: "assessed", residual: [] },
    noResponse: "deny_and_expire",
    allowEnabled: true,
    ...overrides,
  }
}

test("accepts the exact HostKernel managed-root Inspect challenge", () => {
  expect(validateManagedRootGuardChallenge(locationID, challenge())).toMatchObject({
    capabilityID: "git.worktree.list",
    locationID,
    origin: "managed_root",
    source: "host.managed_worktree",
    policyID: "broker-process.local.v1",
    requestedGuarantees: ["configured_executable", "bounded_argv_env", "beneath_workspace_root", "one_use"],
    allowEnabled: true,
  })
})

test("rejects substituted origin, scope, target, and extra fields before approval", () => {
  const good = challenge()
  const invalid = [
    { ...good, origin: "session_batch" },
    { ...good, source: "core.tool_batch" },
    { ...good, capabilityID: "files.read" },
    { ...good, normalizedAction: "files.read" },
    { ...good, locationID: `loc_${"b".repeat(64)}` },
    { ...good, targets: [{ path: "/other", operation: "inspect", resource: "worktree" }] },
    { ...good, extraAuthority: true },
  ]

  for (const candidate of invalid) {
    expect(() => validateManagedRootGuardChallenge(locationID, candidate)).toThrow()
  }
})

test("rejects noncanonical deadlines and weakened approval constraints", () => {
  const good = challenge()
  const invalid = [
    { ...good, expiresAtUnixMs: String(good.expiresAtUnixMs) },
    { ...good, expiresAtUnixMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...good, requestedGuarantees: [...good.requestedGuarantees].reverse() },
    { ...good, guaranteeAssessment: { status: "not_assessed", residual: null }, allowEnabled: true },
    { ...good, guaranteeAssessment: { status: "assessed", residual: ["one_use"] } },
    { ...good, allowEnabled: false },
    { ...good, noResponse: "allow_once" },
  ]

  for (const candidate of invalid) {
    expect(() => validateManagedRootGuardChallenge(locationID, candidate)).toThrow()
  }
})
