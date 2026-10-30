import { describe, expect, test } from "bun:test"
import { Location } from "@horizoncode/schema"
import { AbsolutePath } from "@horizoncode/core/schema"
import { WorkspaceV2 } from "@horizoncode/core/workspace"
import { LanguageServiceProcessError } from "@/lsp/launch"
import { createSupervisedLspClientV1, snapshotLspAttemptScopeV1 } from "@/lsp/supervised"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"

const directAttempt: DirectAttemptScopeV1 = {
  attemptID: "attempt-child-1",
  parentSessionID: "session-parent",
  childSessionID: "session-child",
  profileID: "agent-profile",
  profileRevision: "1",
  profileDigest: `blake3:${"a".repeat(64)}`,
  ownerEpoch: "7",
  expectedRevision: "9",
  locationID: "location-1",
  workspaceID: "wrk_child",
  workspaceRevision: `blake3:${"b".repeat(64)}`,
  capabilityDigest: `blake3:${"c".repeat(64)}`,
  permissionsDigest: `sha256:${"d".repeat(64)}`,
  budgetDigest: `sha256:${"e".repeat(64)}`,
  scopeDigest: `blake3:${"f".repeat(64)}`,
}

const input = {
  config: {},
  serverID: "typescript",
  sessionID: "session-child",
  locationID: "location-1",
  locationRef: Location.Ref.make({
    directory: AbsolutePath.make("/workspace"),
    workspaceID: WorkspaceV2.ID.make("wrk_child"),
  }),
  workspaceRevision: directAttempt.workspaceRevision,
  workspaceID: directAttempt.workspaceID,
  directAttempt,
  root: "/workspace",
  directory: "/workspace",
  instance: { directory: "/workspace", worktree: "/workspace", project: {} },
  supervisor: {},
  runTrustedEffect: async () => {
    throw new Error("closed route unexpectedly reached trusted effect runtime")
  },
  requestHostKernel: async () => ({}),
} as unknown as Parameters<typeof createSupervisedLspClientV1>[0]

describe("supervised LSP Attempt binding", () => {
  test("snapshots nested managed worktree authority", () => {
    const worktreeTarget = {
      worktreeID: "worktree_1",
      worktreeBaseRevision: `blake3:${"5".repeat(64)}`,
      worktreePoolRevision: "3",
      locationID: "location-1",
      workspaceID: "wrk_child",
      workspaceRef: "worktree_1",
      canonicalRoot: "/workspace",
      workspaceRevision: directAttempt.workspaceRevision,
    }
    const managedAttempt = {
      goalID: "goal_1",
      runID: "run_1",
      taskID: "task_1",
      attemptID: "attempt_1",
      ownerEpoch: "1",
      expectedManagedRevision: "1",
      requestSequence: "1",
      requestID: "request_1",
      contextSelectionDigest: `blake3:${"9".repeat(64)}`,
      locationID: "location-1",
      sessionID: "session-child",
      workspaceRevision: directAttempt.workspaceRevision,
      effectiveMaxTokens: "100000",
      remainingTokens: "100000",
      delegationBindingDigest: `blake3:${"c".repeat(64)}`,
      permissionScopeDigest: `blake3:${"a".repeat(64)}`,
      worktreeTarget,
    } as unknown as ManagedAttemptScopeV1

    const snapshot = snapshotLspAttemptScopeV1({ managedAttempt })
    worktreeTarget.canonicalRoot = "/attacker/changed"

    expect(snapshot.managedAttempt?.worktreeTarget.canonicalRoot).toBe("/workspace")
    expect(Object.isFrozen(snapshot.managedAttempt)).toBe(true)
    expect(Object.isFrozen(snapshot.managedAttempt?.worktreeTarget)).toBe(true)
  })

  test("matches the direct child Session ID before reaching the closed process gate", async () => {
    await expect(createSupervisedLspClientV1({ ...input, sessionID: "session-parent" })).rejects.toThrow(
      "supervised LSP scope does not match the authenticated Attempt workspace pins",
    )
    await expect(createSupervisedLspClientV1(input)).rejects.toBeInstanceOf(LanguageServiceProcessError)
  })

  test("rejects a LocationRef for another directory before the closed process gate", async () => {
    await expect(createSupervisedLspClientV1({
      ...input,
      locationRef: Location.Ref.make({
        directory: AbsolutePath.make("/other-workspace"),
        workspaceID: WorkspaceV2.ID.make("wrk_child"),
      }),
    })).rejects.toThrow("supervised LSP location pin does not match the authenticated workspace root")
  })

  test("rejects a LocationRef workspace that differs from the Attempt workspace before the gate", async () => {
    await expect(createSupervisedLspClientV1({
      ...input,
      locationRef: Location.Ref.make({
        directory: AbsolutePath.make("/workspace"),
        workspaceID: WorkspaceV2.ID.make("wrk_foreign"),
      }),
    })).rejects.toThrow("supervised LSP location pin does not match the authenticated workspace ID")
  })

  test("rejects combining managed and direct Attempt scopes", async () => {
    const managedAttempt = {
      goalID: "goal_1",
      runID: "run_1",
      taskID: "task_1",
      attemptID: "attempt_1",
      ownerEpoch: "1",
      expectedManagedRevision: "1",
      requestSequence: "1",
      requestID: "request_1",
      contextSelectionDigest: `blake3:${"9".repeat(64)}`,
      locationID: "location-1",
      sessionID: "session-child",
      workspaceRevision: directAttempt.workspaceRevision,
      effectiveMaxTokens: "100000",
      remainingTokens: "100000",
      delegationBindingDigest: `blake3:${"c".repeat(64)}`,
      permissionScopeDigest: `blake3:${"a".repeat(64)}`,
      worktreeTarget: {
        worktreeID: "worktree_1",
        worktreeBaseRevision: `blake3:${"5".repeat(64)}`,
        worktreePoolRevision: "3",
        locationID: "location-1",
        workspaceID: "wrk_child",
        workspaceRef: "worktree_1",
        canonicalRoot: "/workspace",
        workspaceRevision: directAttempt.workspaceRevision,
      },
    }
    await expect(createSupervisedLspClientV1({
      ...input,
      managedAttempt: managedAttempt as unknown as Parameters<typeof createSupervisedLspClientV1>[0]["managedAttempt"],
    })).rejects.toThrow("supervised LSP creation cannot combine managed and direct Attempt scopes")
  })

  test("rejects a managed Attempt scope with mismatched canonicalRoot", async () => {
    const managedAttempt = {
      goalID: "goal_1",
      runID: "run_1",
      taskID: "task_1",
      attemptID: "attempt_1",
      ownerEpoch: "1",
      expectedManagedRevision: "1",
      requestSequence: "1",
      requestID: "request_1",
      contextSelectionDigest: `blake3:${"9".repeat(64)}`,
      locationID: "location-1",
      sessionID: "session-child",
      workspaceRevision: directAttempt.workspaceRevision,
      effectiveMaxTokens: "100000",
      remainingTokens: "100000",
      delegationBindingDigest: `blake3:${"c".repeat(64)}`,
      permissionScopeDigest: `blake3:${"a".repeat(64)}`,
      worktreeTarget: {
        worktreeID: "worktree_1",
        worktreeBaseRevision: `blake3:${"5".repeat(64)}`,
        worktreePoolRevision: "3",
        locationID: "location-1",
        workspaceID: "wrk_child",
        workspaceRef: "worktree_1",
        canonicalRoot: "/other-workspace",
        workspaceRevision: directAttempt.workspaceRevision,
      },
    }
    await expect(createSupervisedLspClientV1({
      ...input,
      directAttempt: undefined,
      workspaceID: undefined,
      managedAttempt: managedAttempt as unknown as Parameters<typeof createSupervisedLspClientV1>[0]["managedAttempt"],
    })).rejects.toThrow("supervised LSP scope does not match the managed Attempt worktree target")
  })

  test("rejects a malformed root Session scope without workspaceID or valid revision", async () => {
    await expect(createSupervisedLspClientV1({
      ...input,
      directAttempt: undefined,
      workspaceID: undefined,
    })).rejects.toThrow("supervised LSP root Session scope is malformed")

    await expect(createSupervisedLspClientV1({
      ...input,
      directAttempt: undefined,
      workspaceRevision: "not-a-blake3-digest",
    })).rejects.toThrow("supervised LSP root Session scope is malformed")
  })

  test("admits a valid root Session scope up to the closed process gate", async () => {
    await expect(createSupervisedLspClientV1({
      ...input,
      directAttempt: undefined,
    })).rejects.toBeInstanceOf(LanguageServiceProcessError)
  })
})
