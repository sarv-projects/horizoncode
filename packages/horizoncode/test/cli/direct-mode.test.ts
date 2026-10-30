import { describe, expect, test } from "bun:test"
import {
  applyDirectPermissionMode,
  formatDirectPermissionModeLine,
  type DirectModeClient,
  type DirectSessionPermissionModeUpdate,
} from "@/cli/cmd/direct-mode"

type StubOptions = {
  /** Revisions returned by successive GETs. The last value repeats. */
  revisions: string[]
  /** Statuses returned by successive PATCHes. The last value repeats. */
  patchStatuses: number[]
}

function stubClient(options: StubOptions) {
  let reads = 0
  let patches = 0
  const updates: DirectSessionPermissionModeUpdate[] = []

  const client: DirectModeClient = {
    config: {
      async directSessionPermissionMode() {
        const revision = options.revisions[Math.min(reads, options.revisions.length - 1)]
        reads += 1
        return {
          data: { revision, sandboxMode: "workspace-write", approvalPolicy: "on-request" },
          response: { status: 200 },
        }
      },
      async updateDirectSessionPermissionMode(parameters) {
        const status = options.patchStatuses[Math.min(patches, options.patchStatuses.length - 1)]
        updates.push(parameters.directSessionPermissionModeUpdateV1)
        patches += 1
        if (status !== 200) {
          return {
            error: { name: status === 409 ? "ConflictError" : "NotFoundError", message: status === 409 ? "revision conflict" : "route not found" },
            response: { status },
          }
        }
        const next = String(BigInt(parameters.directSessionPermissionModeUpdateV1.expectedRevision) + 1n)
        return {
          data: {
            revision: next,
            sandboxMode: parameters.directSessionPermissionModeUpdateV1.sandboxMode,
            approvalPolicy: parameters.directSessionPermissionModeUpdateV1.approvalPolicy,
          },
          response: { status: 200 },
        }
      },
    },
  }

  return { client, reads: () => reads, patches: () => patches, updates }
}

function recorder() {
  const lines: string[] = []
  return { lines, log: (line: string) => void lines.push(line) }
}

describe("applyDirectPermissionMode", () => {
  test("applies the requested posture through the authenticated route", async () => {
    const stub = stubClient({ revisions: ["7"], patchStatuses: [200] })
    const { lines, log } = recorder()

    const result = await applyDirectPermissionMode({
      client: stub.client,
      sessionID: "ses_test",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      label: "yolo",
      log,
    })

    expect(result).toEqual({ applied: true, revision: "8" })
    expect(stub.reads()).toBe(1)
    expect(stub.patches()).toBe(1)
    expect(stub.updates).toEqual([{ sandboxMode: "danger-full-access", approvalPolicy: "never", expectedRevision: "7" }])
    expect(lines).toEqual(["permission mode: danger-full-access · never (yolo)"])
    expect(formatDirectPermissionModeLine({ sandboxMode: "workspace-write", approvalPolicy: "never", label: "auto" })).toBe(
      "permission mode: workspace-write · never (auto)",
    )
  })

  test("reports the reason and keeps the fallback when the route is missing", async () => {
    const stub = stubClient({ revisions: ["3"], patchStatuses: [404] })
    const { lines, log } = recorder()

    const result = await applyDirectPermissionMode({
      client: stub.client,
      sessionID: "ses_test",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      label: "auto",
      log,
    })

    expect(result.applied).toBe(false)
    expect(result.reason).toContain("404")
    expect(stub.patches()).toBe(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("permission mode: workspace-write · never (auto) was not applied")
    expect(lines[0]).toContain("404")
  })

  test("retries once after re-reading the revision on conflict", async () => {
    const stub = stubClient({ revisions: ["7", "9"], patchStatuses: [409, 200] })
    const { lines, log } = recorder()

    const result = await applyDirectPermissionMode({
      client: stub.client,
      sessionID: "ses_test",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      label: "auto",
      log,
    })

    expect(result).toEqual({ applied: true, revision: "10" })
    expect(stub.reads()).toBe(2)
    expect(stub.patches()).toBe(2)
    expect(stub.updates.map((update) => update.expectedRevision)).toEqual(["7", "9"])
    expect(lines).toEqual(["permission mode: workspace-write · never (auto)"])
  })
})
