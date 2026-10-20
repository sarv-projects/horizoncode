import { describe, expect, test } from "bun:test"
import {
  MAX_PENDING_GUARD_APPROVALS,
  pendingGuardApprovals,
  upsertGuardApprovalRequest,
} from "../../src/context/sync"

type GuardApproval = Parameters<typeof upsertGuardApprovalRequest>[1]

function approval(input: {
  approvalID: string
  challengeID?: string
  expiresAtUnixMs: number
  capabilityID?: string
}): GuardApproval {
  return {
    approvalID: input.approvalID,
    challengeID: input.challengeID ?? `ch_${input.approvalID}`,
    effectID: `eff_${input.approvalID}`,
    capabilityID: input.capabilityID ?? "files.write",
    locationID: "loc_1",
    inputDigest: `blake3:${"a".repeat(64)}`,
    normalizedTargets: [],
    expiresAtUnixMs: input.expiresAtUnixMs,
    policySummary: "workspace-write.local.v1 requires explicit approval",
    directory: "/workspace",
    state: "pending",
  }
}

describe("guard approval queue", () => {
  test("keeps one pending entry per approval and orders by earliest expiry", () => {
    const late = approval({ approvalID: "approval_late", expiresAtUnixMs: 2_000 })
    const early = approval({ approvalID: "approval_early", expiresAtUnixMs: 1_000 })

    let queue: GuardApproval[] = []
    queue = upsertGuardApprovalRequest(queue, late)
    queue = upsertGuardApprovalRequest(queue, early)

    expect(queue.map((item) => item.approvalID)).toEqual(["approval_early", "approval_late"])
    expect(pendingGuardApprovals(queue, 0).map((item) => item.approvalID)).toEqual([
      "approval_early",
      "approval_late",
    ])
  })

  test("a repeated challenge replaces its previous entry instead of queueing twice", () => {
    const first = approval({ approvalID: "approval_first", challengeID: "ch_shared", expiresAtUnixMs: 1_000 })
    const second = approval({ approvalID: "approval_second", challengeID: "ch_shared", expiresAtUnixMs: 3_000 })

    let queue: GuardApproval[] = []
    queue = upsertGuardApprovalRequest(queue, first)
    queue = upsertGuardApprovalRequest(queue, second)

    expect(queue).toHaveLength(1)
    expect(queue[0]?.approvalID).toBe("approval_second")
  })

  test("a refreshed approval ID resets the submission state deterministically", () => {
    const original = approval({ approvalID: "approval_same", expiresAtUnixMs: 1_000 })
    const refreshing = {
      ...approval({ approvalID: "approval_same", expiresAtUnixMs: 2_000 }),
      capabilityID: "files.patch",
    }

    let queue: GuardApproval[] = []
    queue = upsertGuardApprovalRequest(queue, { ...original, state: "submitting" })
    queue = upsertGuardApprovalRequest(queue, refreshing)

    expect(queue).toHaveLength(1)
    expect(queue[0]?.capabilityID).toBe("files.patch")
    expect(queue[0]?.state).toBe("pending")
  })

  test("bounds the queue by dropping the entries that expire first", () => {
    let queue: GuardApproval[] = []
    for (let index = 0; index < MAX_PENDING_GUARD_APPROVALS + 3; index++) {
      queue = upsertGuardApprovalRequest(
        queue,
        approval({ approvalID: `approval_${index}`, expiresAtUnixMs: 1_000 + index }),
      )
    }

    expect(queue).toHaveLength(MAX_PENDING_GUARD_APPROVALS)
    // The three earliest expiries were dropped; the newest arrival is retained.
    expect(queue[0]?.approvalID).toBe("approval_3")
    expect(queue.at(-1)?.approvalID).toBe(`approval_${MAX_PENDING_GUARD_APPROVALS + 2}`)
  })

  test("expired challenges are never reported as pending", () => {
    const queue = [
      approval({ approvalID: "approval_expired", expiresAtUnixMs: 999 }),
      approval({ approvalID: "approval_live", expiresAtUnixMs: 1_001 }),
    ]

    expect(pendingGuardApprovals(queue, 1_000).map((item) => item.approvalID)).toEqual(["approval_live"])
  })
})
