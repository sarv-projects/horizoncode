import { describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { makeEditorProtocolGuardAuthorizerV1 } from "@/lsp/guard-authorizer"
import type { ManagedAttemptScopeV1 } from "@/session/managed-control"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const REVISION = digest("1")

const locationRef = Location.Ref.make({
  directory: AbsolutePath.make("/workspace"),
  workspaceID: WorkspaceV2.ID.make("wrk_authorizer"),
})

const processRef = {
  executionID: "editor_exec_1",
  generation: "3",
  ownerEpoch: "7",
  kind: "language_server",
  profileID: "lsp_typescript_test",
  profileRevision: "1",
  profileDigest: digest("2"),
  executableDigest: digest("3"),
}

type Lease = {
  readonly capabilityID: string
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityLeaseDigest: string
  readonly locationID: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: unknown
}

function lease(over: Partial<Lease> = {}): Lease {
  return leaseFor("session-1", over)
}

function leaseFor(sessionID: string, over: Partial<Lease> = {}): Lease {
  return {
    capabilityID: "language.diagnostics",
    challengeID: "challenge_1",
    effectID: "effect_1",
    capabilityLeaseDigest: digest("4"),
    locationID: "location-1",
    arguments: {
      sessionID,
      locationID: "location-1",
      protocol: "lsp",
      requestSequence: "1",
      hostProcessRef: { ...processRef },
    },
    ...over,
  }
}

function makeAuthorizer(input: {
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly sessionID?: string
  readonly lease?: Lease | (() => never)
  readonly calls?: { count: number; request?: Record<string, unknown> }
}) {
  const calls: { count: number; request?: Record<string, unknown> } = input.calls ?? { count: 0 }
  const supervisor = {
    authorizeEditorProtocolOperation: (request: Record<string, unknown>) => {
      calls.count += 1
      calls.request = request
      if (typeof input.lease === "function") return input.lease()
      return input.lease ?? lease()
    },
  }
  const authorize = makeEditorProtocolGuardAuthorizerV1({
    supervisor: supervisor as never,
    locationRef,
    sessionID: input.sessionID ?? "session-1",
    locationID: "location-1",
    ...(input.managedAttempt === undefined ? {} : { managedAttempt: input.managedAttempt }),
    runTrustedEffect: async (effect) => effect as never,
  })
  return { authorize, calls }
}

const operation = (over: Record<string, unknown> = {}) => ({
  capabilityID: "language.diagnostics",
  authorization: {
    sessionID: "session-1",
    locationID: "location-1",
    protocol: "lsp",
    workspaceRevision: REVISION,
    requestSequence: "1",
    hostProcessRef: { ...processRef },
  },
  ...over,
})

const baseLeaseArguments = () => ({
  sessionID: "session-1",
  locationID: "location-1",
  protocol: "lsp",
  requestSequence: "1",
  hostProcessRef: { ...processRef },
})

describe("editor protocol Guard authorizer construction", () => {
  test("accepts a root Session binding and freezes the issued lease", async () => {
    const { authorize, calls } = makeAuthorizer({})
    const result = await authorize(operation())
    expect(calls.count).toBe(1)
    expect(calls.request).toMatchObject({
      capabilityID: "language.diagnostics",
      sessionID: "session-1",
      arguments: { sessionID: "session-1", locationID: "location-1", protocol: "lsp", requestSequence: "1" },
    })
    expect(result).toEqual({
      effectID: "effect_1",
      challengeID: "challenge_1",
      capabilityID: "language.diagnostics",
      capabilityLeaseDigest: digest("4"),
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  test("refuses to combine managed and direct Attempt authority", () => {
    expect(() => makeEditorProtocolGuardAuthorizerV1({
      supervisor: {} as never,
      locationRef,
      sessionID: "session-1",
      locationID: "location-1",
      managedAttempt: managedScope(),
      directAttempt: {} as never,
      runTrustedEffect: async (effect) => effect as never,
    })).toThrow(TypeError)
  })

  test("refuses malformed Session and Location identities before any request", () => {
    for (const [sessionID, locationID] of [["session one", "location-1"], ["session-1", ""]] as const) {
      expect(() => makeEditorProtocolGuardAuthorizerV1({
        supervisor: {} as never,
        locationRef,
        sessionID,
        locationID,
        runTrustedEffect: async (effect) => effect as never,
      }), `${sessionID}/${locationID}`).toThrow(TypeError)
    }
  })
})

describe("editor protocol Guard authorizer request denials", () => {
  test("rejects an operation whose Attempt scope differs from the Core binding", async () => {
    const { authorize, calls } = makeAuthorizer({})
    await expect(authorize(operation({ managedAttempt: managedScope() }))).rejects.toThrow(
      "protocol operation Attempt scope differs from its authenticated Core binding",
    )
    await expect(authorize(operation({
      managedAttempt: managedScope(),
      directAttempt: {} as never,
    }))).rejects.toThrow("protocol operation Attempt scope differs from its authenticated Core binding")
    expect(calls.count).toBe(0)
  })

  test("rejects empty, oversized, spaced and NUL capability IDs", async () => {
    const { authorize, calls } = makeAuthorizer({})
    for (const capabilityID of ["", "a".repeat(161), "language diagnostics", "lang\u0000uage"]) {
      await expect(authorize(operation({ capabilityID })), capabilityID).rejects.toThrow(
        "protocol operation has an invalid canonical capability ID",
      )
    }
    expect(calls.count).toBe(0)
  })

  test("rejects an authorization that is not the authenticated Session, Location and protocol", async () => {
    const { authorize, calls } = makeAuthorizer({})
    const cases: readonly [string, Record<string, unknown>][] = [
      ["foreign session", { sessionID: "session-2" }],
      ["foreign location", { locationID: "location-2" }],
      ["unknown protocol", { protocol: "ssh" }],
      ["missing protocol", { protocol: undefined }],
    ]
    for (const [label, patch] of cases) {
      await expect(authorize(operation({
        authorization: {
          sessionID: "session-1",
          locationID: "location-1",
          protocol: "lsp",
          workspaceRevision: REVISION,
          requestSequence: "1",
          hostProcessRef: { ...processRef },
          ...patch,
        },
      })), label).rejects.toThrow("does not match its authenticated Session and Location")
    }
    expect(calls.count).toBe(0)
  })

  test("rejects a malformed or foreign HostKernel process reference", async () => {
    const { authorize, calls } = makeAuthorizer({})
    await expect(authorize(operation({
      authorization: {
        sessionID: "session-1",
        locationID: "location-1",
        protocol: "lsp",
        workspaceRevision: REVISION,
        requestSequence: "1",
        hostProcessRef: { ...processRef, pid: 42 },
      },
    }))).rejects.toThrow("process reference must use the exact HostKernel identity fields")

    await expect(authorize(operation({
      authorization: {
        sessionID: "session-1",
        locationID: "location-1",
        protocol: "lsp",
        workspaceRevision: REVISION,
        requestSequence: "1",
        hostProcessRef: { ...processRef, kind: "debug_adapter" },
      },
    }))).rejects.toThrow("process or workspace pin differs from its authenticated Session scope")

    await expect(authorize(operation({
      authorization: {
        sessionID: "session-1",
        locationID: "location-1",
        protocol: "lsp",
        workspaceRevision: "sha256:nope",
        requestSequence: "1",
        hostProcessRef: { ...processRef },
      },
    }))).rejects.toThrow("process or workspace pin differs from its authenticated Session scope")
    expect(calls.count).toBe(0)
  })

  test("rejects a reply attempt on the non-LSP callback path", async () => {
    const { authorize, calls } = makeAuthorizer({})
    await expect(authorize(operation({
      kind: "callback_reply",
      authorization: {
        sessionID: "session-1",
        locationID: "location-1",
        protocol: "dap",
        workspaceRevision: REVISION,
        requestSequence: "1",
        hostProcessRef: { ...processRef, kind: "debug_adapter" },
      },
    }))).rejects.toThrow("only the LSP callback path can authorize a correlated server reply")
    expect(calls.count).toBe(0)
  })
})

describe("editor protocol Guard authorizer lease validation", () => {
  test("rejects a lease for another capability or an unverifiable digest", async () => {
    for (const [label, bad] of [
      ["foreign capability", lease({ capabilityID: "language.rename" })],
      ["foreign location", lease({ locationID: "location-2" })],
      ["non-digest lease", lease({ capabilityLeaseDigest: "sha256:x" })],
      ["empty challenge", lease({ challengeID: "" })],
      ["empty effect", lease({ effectID: "" })],
    ] as const) {
      const { authorize } = makeAuthorizer({ lease: bad })
      await expect(authorize(operation()), label).rejects.toThrow(
        "SessionSupervisor returned a lease outside the exact protocol operation binding",
      )
    }
  })

  test("rejects a lease whose arguments drop part of the protocol operation", async () => {
    for (const [label, argumentsOver] of [
      ["other request sequence", { requestSequence: "2" }],
      ["other session", { sessionID: "session-2" }],
      ["other protocol", { protocol: "ssh" }],
    ] as const) {
      const { authorize } = makeAuthorizer({
        lease: lease({ arguments: { ...baseLeaseArguments(), ...argumentsOver } }),
      })
      await expect(authorize(operation()), label).rejects.toThrow(
        "SessionSupervisor lease does not retain the exact protocol operation",
      )
    }
  })

  test("rejects a lease that swaps the process pin", async () => {
    const { authorize } = makeAuthorizer({
      lease: lease({ arguments: {
        sessionID: "session-1",
        locationID: "location-1",
        protocol: "lsp",
        requestSequence: "1",
        hostProcessRef: { ...processRef, profileID: "lsp_other" },
      } }),
    })
    await expect(authorize(operation())).rejects.toThrow(
      "SessionSupervisor lease process pin differs from the requested operation",
    )
  })

  test("rejects a defect from the trusted effect runtime instead of issuing a lease", async () => {
    const { authorize, calls } = makeAuthorizer({
      lease: () => { throw new Error("supervisor unavailable") },
    })
    await expect(authorize(operation())).rejects.toThrow("supervisor unavailable")
    expect(calls.count).toBe(1)
  })
})

describe("editor protocol Guard authorizer managed Attempt binding", () => {
  const managedAttempt = managedScope()

  test("admits the bound managed Attempt scope up to the trusted runtime", async () => {
    const { authorize, calls } = makeAuthorizer({
      managedAttempt,
      sessionID: "session-managed",
      lease: leaseFor("session-managed", { managedAttempt }),
    })
    const result = await authorize(operation({
      capabilityID: "language.diagnostics",
      authorization: {
        sessionID: "session-managed",
        locationID: "location-1",
        protocol: "lsp",
        workspaceRevision: REVISION,
        requestSequence: "1",
        hostProcessRef: { ...processRef },
      },
      managedAttempt,
    }))
    expect(calls.count).toBe(1)
    expect(result.capabilityID).toBe("language.diagnostics")
  })

  test("rejects a process ref minted in another managed owner epoch", async () => {
    const { authorize, calls } = makeAuthorizer({
      managedAttempt,
      sessionID: "session-managed",
    })
    await expect(authorize(operation({
      authorization: {
        sessionID: "session-managed",
        locationID: "location-1",
        protocol: "lsp",
        workspaceRevision: REVISION,
        requestSequence: "1",
        hostProcessRef: { ...processRef, ownerEpoch: "8" },
      },
      managedAttempt,
    }))).rejects.toThrow("process or workspace pin differs from its authenticated Session scope")
    expect(calls.count).toBe(0)
  })

  test("rejects an authorization workspace revision that differs from the Attempt", async () => {
    const { authorize, calls } = makeAuthorizer({
      managedAttempt,
      sessionID: "session-managed",
    })
    await expect(authorize(operation({
      authorization: {
        sessionID: "session-managed",
        locationID: "location-1",
        protocol: "lsp",
        workspaceRevision: digest("7"),
        requestSequence: "1",
        hostProcessRef: { ...processRef },
      },
      managedAttempt,
    }))).rejects.toThrow("process or workspace pin differs from its authenticated Session scope")
    expect(calls.count).toBe(0)
  })

  test("rejects a managed scope that does not match the authenticated pins", async () => {
    const { authorize, calls } = makeAuthorizer({
      managedAttempt,
      sessionID: "session-managed",
    })
    await expect(authorize(operation({
      authorization: {
        sessionID: "session-managed",
        locationID: "location-1",
        protocol: "lsp",
        workspaceRevision: REVISION,
        requestSequence: "1",
        hostProcessRef: { ...processRef },
      },
      managedAttempt: { ...managedAttempt, sessionID: "session-other" },
    }))).rejects.toThrow("protocol operation Attempt scope differs from its authenticated Core binding")
    expect(calls.count).toBe(0)
  })
})

function managedScope(): ManagedAttemptScopeV1 {
  return {
    goalID: "goal_1",
    runID: "run_1",
    taskID: "task_1",
    attemptID: "attempt_1",
    ownerEpoch: "7",
    expectedManagedRevision: "1",
    requestSequence: "1",
    requestID: "request_1",
    contextSelectionDigest: digest("9"),
    locationID: "location-1",
    sessionID: "session-managed",
    workspaceRevision: REVISION,
    effectiveMaxTokens: "100000",
    remainingTokens: "100000",
    delegationBindingDigest: digest("c"),
    permissionScopeDigest: digest("a"),
    worktreeTarget: {
      worktreeID: "worktree_1",
      worktreeBaseRevision: digest("5"),
      worktreePoolRevision: "3",
      locationID: "location-1",
      workspaceID: "wrk_managed",
      workspaceRef: "worktree_1",
      canonicalRoot: "/workspace/managed",
      workspaceRevision: REVISION,
    },
  }
}
