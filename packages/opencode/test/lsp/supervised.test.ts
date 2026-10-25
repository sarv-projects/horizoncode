import { describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LanguageServiceProcessError } from "@/lsp/launch"
import { createSupervisedLspClientV1 } from "@/lsp/supervised"
import type { DirectAttemptScopeV1 } from "@/session/managed-control"

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
})
