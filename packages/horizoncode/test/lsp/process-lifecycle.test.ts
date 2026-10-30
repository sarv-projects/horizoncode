import { describe, expect, test } from "bun:test"
import {
  EditorProcessOutcomeUnknownError,
  cancelEditorProcessV1,
  launchApprovedEditorProcessV1,
  readEditorProcessOutputV1,
  readEditorProcessStatusV1,
  type RequestExecutionHostV1,
} from "@/lsp/process-lifecycle"
import type { LaunchProfileApprovalV1 } from "@/lsp/launch-profile"
import type { HostProcessRefV1 } from "@/lsp/process-scope"
import type { ManagedAttemptScopeV1 } from "@/session/managed-control"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const REVISION = digest("1")
const PROFILE_DIGEST = digest("2")
const EXECUTABLE_DIGEST = digest("3")
const LEASE_DIGEST = digest("4")
const RECEIPT_DIGEST = digest("5")

const rootScope = {
  sessionID: "session-1",
  locationID: "location-1",
  workspaceRevision: REVISION,
}

const processRef: HostProcessRefV1 = {
  executionID: "editor_exec_1",
  generation: "3",
  ownerEpoch: "7",
  kind: "language_server",
  profileID: "lsp_typescript_test",
  profileRevision: "1",
  profileDigest: PROFILE_DIGEST,
  executableDigest: EXECUTABLE_DIGEST,
}

const status = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  executionID: "editor_exec_1",
  generation: "3",
  state: "RUNNING",
  stdoutSequence: "0",
  stderrSequence: "0",
  exitCode: null,
  stdoutDigest: digest("6"),
  stderrDigest: digest("7"),
  outputBytes: "0",
  truncated: false,
  receiptDigest: null,
  hostProcessRef: { ...processRef },
  ...over,
})

type Call = { operation: string; body: Readonly<Record<string, unknown>> }

function recordingHost(responses: Record<string, unknown>): {
  readonly host: RequestExecutionHostV1
  readonly calls: Call[]
} {
  const calls: Call[] = []
  const host: RequestExecutionHostV1 = async (_service, operation, body) => {
    calls.push({ operation, body })
    const response = responses[operation]
    if (response === undefined) throw new Error(`unexpected HostKernel ${operation} call`)
    if (response instanceof Error) throw response
    return response
  }
  return { host, calls }
}

describe("editor process lifecycle status reads", () => {
  test("dispatches exactly one bound status read and decodes the frame", async () => {
    const { host, calls } = recordingHost({ status: status({ state: "UNKNOWN", receiptDigest: null }) })
    const result = await readEditorProcessStatusV1({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      challengeID: "challenge_1",
      scope: rootScope,
      requestHostKernel: host,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.operation).toBe("status")
    expect(calls[0]?.body).toMatchObject({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      challengeID: "challenge_1",
      locationID: "location-1",
    })
    expect(result).toMatchObject({ executionID: "editor_exec_1", state: "UNKNOWN" })
    expect(Object.isFrozen(result)).toBe(true)
  })

  test("rejects a status frame addressed to a different execution", async () => {
    const { host } = recordingHost({ status: status({ executionID: "editor_exec_other" }) })
    await expect(readEditorProcessStatusV1({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      challengeID: "challenge_1",
      scope: rootScope,
      requestHostKernel: host,
    })).rejects.toThrow("HostKernel status returned a different execution")
  })

  test("rejects a status whose embedded process ref belongs to another execution", async () => {
    // The optional expectedProcessRef pin must not be the only thing binding the
    // embedded ref to the queried execution: a frame naming a foreign execution
    // is a host contract violation in its own right.
    const { host } = recordingHost({
      status: status({ hostProcessRef: { ...processRef, executionID: "editor_exec_other" } }),
    })
    await expect(readEditorProcessStatusV1({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      challengeID: "challenge_1",
      scope: rootScope,
      requestHostKernel: host,
    })).rejects.toThrow("HostKernel status returned a process reference for a different execution")
  })

  test("reports a process ref from another generation as an unknown outcome", async () => {
    const { host } = recordingHost({
      status: status({ hostProcessRef: { ...processRef, generation: "4" } }),
    })
    await expect(readEditorProcessStatusV1({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      challengeID: "challenge_1",
      scope: rootScope,
      expectedProcessRef: processRef,
      requestHostKernel: host,
    })).rejects.toBeInstanceOf(EditorProcessOutcomeUnknownError)
  })

  test("rejects malformed status frames field by field", async () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ["unknown extra field", { policy: "smuggled" }],
      ["impossible state", { state: "PAUSED" }],
      ["out-of-range exit code", { state: "SETTLED", exitCode: 300, receiptDigest: RECEIPT_DIGEST }],
      ["non-digest stdout", { stdoutDigest: "sha256:x" }],
      ["non-canonical generation", { generation: "03" }],
      ["non-boolean truncation", { truncated: "true" }],
    ]
    for (const [label, over] of cases) {
      const { host } = recordingHost({ status: status(over) })
      await expect(readEditorProcessStatusV1({
        executionID: "editor_exec_1",
        effectID: "effect_1",
        challengeID: "challenge_1",
        scope: rootScope,
        requestHostKernel: host,
      }), label).rejects.toThrow(TypeError)
    }
  })

  test("rejects a root session scope without an exact workspace revision", async () => {
    const { host, calls } = recordingHost({ status: status() })
    await expect(readEditorProcessStatusV1({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      challengeID: "challenge_1",
      scope: { ...rootScope, workspaceRevision: "sha256:nope" },
      requestHostKernel: host,
    })).rejects.toThrow("root Session process scope is malformed")
    expect(calls).toHaveLength(0)
  })

  test("refuses a managed-scope process ref minted in another owner epoch as unknown", async () => {
    const managedAttempt = managedScope()
    const { host } = recordingHost({
      status: status({ hostProcessRef: { ...processRef, ownerEpoch: "8" } }),
    })
    await expect(readEditorProcessStatusV1({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      challengeID: "challenge_1",
      scope: { ...rootScope, sessionID: "session-managed", locationID: "location-1", managedAttempt },
      requestHostKernel: host,
    })).rejects.toBeInstanceOf(EditorProcessOutcomeUnknownError)
  })

  test("refuses a managed scope whose pins differ from the authenticated session", async () => {
    const { host, calls } = recordingHost({ status: status() })
    await expect(readEditorProcessStatusV1({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      challengeID: "challenge_1",
      scope: { ...rootScope, sessionID: "session-other", managedAttempt: managedScope() },
      requestHostKernel: host,
    })).rejects.toThrow("managed process scope does not match the authenticated session")
    expect(calls).toHaveLength(0)
  })

  test("snapshots nested managed worktree authority before dispatch", async () => {
    const managedAttempt = managedScope()
    let dispatchedRoot: string | undefined
    const host: RequestExecutionHostV1 = async (_service, _operation, body) => {
      ;(managedAttempt.worktreeTarget as { canonicalRoot: string }).canonicalRoot = "/attacker/changed"
      dispatchedRoot = (body.managedAttempt as ManagedAttemptScopeV1).worktreeTarget.canonicalRoot
      return status({ hostProcessRef: undefined })
    }

    await readEditorProcessStatusV1({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      challengeID: "challenge_1",
      scope: { ...rootScope, sessionID: "session-managed", locationID: "location-1", managedAttempt },
      requestHostKernel: host,
    })

    expect(dispatchedRoot).toBe("/workspace/managed")
  })
})

describe("editor process lifecycle output reads", () => {
  const page = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    executionID: "editor_exec_1",
    generation: "3",
    records: [
      { source: "stdout", sequence: "1", bytes: new Uint8Array([104, 105]) },
      { source: "stderr", sequence: "1", bytes: new Uint8Array([111, 112]) },
    ],
    nextStdoutSequence: "1",
    nextStderrSequence: "1",
    eof: false,
    truncated: false,
    state: "RUNNING",
    receiptDigest: null,
    ...over,
  })

  const read = (host: RequestExecutionHostV1, over: Record<string, unknown> = {}) => readEditorProcessOutputV1({
    processRef,
    effectID: "effect_1",
    challengeID: "challenge_1",
    capabilityLeaseDigest: LEASE_DIGEST,
    scope: rootScope,
    afterStdoutSequence: "0",
    afterStderrSequence: "0",
    maxBytes: 1024,
    requestHostKernel: host,
    ...over,
  })

  test("returns a bounded page whose cursors exactly match the ordered records", async () => {
    const { host, calls } = recordingHost({ read: page() })
    const result = await read(host)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.operation).toBe("read")
    expect(calls[0]?.body).toMatchObject({
      executionID: "editor_exec_1",
      afterStdoutSequence: "0",
      afterStderrSequence: "0",
      maxBytes: 1024,
      capabilityLeaseDigest: LEASE_DIGEST,
    })
    expect(result.records.map((record) => [record.source, record.sequence])).toEqual([
      ["stdout", "1"],
      ["stderr", "1"],
    ])
    expect(result.eof).toBe(false)
    expect(result.receipt).toBeUndefined()
  })

  test("rejects a replayed or gapped record sequence instead of buffering it", async () => {
    const { host } = recordingHost({
      read: page({
        records: [{ source: "stdout", sequence: "1", bytes: new Uint8Array([1]) }],
        nextStdoutSequence: "1",
        nextStderrSequence: "0",
      }),
    })
    await expect(read(host, { afterStdoutSequence: "1" })).rejects.toThrow("sequence gap or replay")
  })

  test("rejects cursors that do not describe the returned records", async () => {
    const { host } = recordingHost({ read: page({ nextStdoutSequence: "9" }) })
    await expect(read(host)).rejects.toThrow("output cursors do not match the returned records")
  })

  test("rejects a page that exceeds its declared byte bound", async () => {
    const { host } = recordingHost({
      read: page({
        records: [{ source: "stdout", sequence: "1", bytes: new Uint8Array(64) }],
        nextStdoutSequence: "1",
        nextStderrSequence: "0",
      }),
    })
    await expect(read(host, { maxBytes: 8 })).rejects.toThrow("output page exceeds its byte bound")
  })

  test("rejects an output page bound outside its contract", async () => {
    for (const maxBytes of [0, -1, 256 * 1024 + 1, 1.5]) {
      const { host } = recordingHost({ read: page() })
      await expect(read(host, { maxBytes }), String(maxBytes)).rejects.toThrow("page bound is invalid")
    }
  })

  test("rejects malformed output records", async () => {
    const cases: readonly [string, unknown][] = [
      ["unknown source", { source: "stdin", sequence: "1", bytes: new Uint8Array([1]) }],
      ["string bytes", { source: "stdout", sequence: "1", bytes: "hi" }],
      ["extra field", { source: "stdout", sequence: "1", bytes: new Uint8Array([1]), offset: 0 }],
      ["non-canonical sequence", { source: "stdout", sequence: "01", bytes: new Uint8Array([1]) }],
    ]
    for (const [label, record] of cases) {
      const { host } = recordingHost({
        read: page({ records: [record], nextStdoutSequence: "1", nextStderrSequence: "0" }),
      })
      await expect(read(host), label).rejects.toThrow(TypeError)
    }
  })

  test("a settled page must carry its durable receipt", async () => {
    const { host } = recordingHost({ read: page({ state: "SETTLED", receiptDigest: null, eof: true }) })
    await expect(read(host)).rejects.toThrow("settled HostKernel output is missing its durable process receipt")
  })

  test("an unsettled page must not carry a terminal receipt", async () => {
    const { host } = recordingHost({
      read: page({ state: "RUNNING", receiptDigest: RECEIPT_DIGEST, receipt: receipt() }),
    })
    await expect(read(host)).rejects.toThrow(
      "HostKernel output receipt differs from the settled output projection",
    )
  })

  test("a receipt digest without a durable receipt is rejected", async () => {
    const { host } = recordingHost({ read: page({ receiptDigest: RECEIPT_DIGEST }) })
    await expect(read(host)).rejects.toThrow("output receipt digest has no matching durable receipt")
  })

  test("returns the exact settled receipt only when it matches the output projection", async () => {
    const settled = {
      state: "SETTLED",
      eof: true,
      truncated: false,
      receiptDigest: RECEIPT_DIGEST,
      receipt: receipt(),
    }
    const { host } = recordingHost({ read: page(settled) })
    const result = await read(host)
    expect(result.receipt).toMatchObject({
      executionID: "editor_exec_1",
      effectID: "effect_1",
      receiptDigest: RECEIPT_DIGEST,
    })

    for (const [label, over] of [
      ["foreign profile", { profileID: "lsp_other" }],
      ["foreign effect", { effectID: "effect_2" }],
      ["truncation disagreement", { truncated: true }],
      ["earlier stdout cursor", { stdoutSequence: "0" }],
    ] as const) {
      const mismatched = recordingHost({ read: page({ ...settled, receipt: receipt(over) }) })
      await expect(read(mismatched.host), label).rejects.toThrow(
        "output receipt differs from the settled output projection",
      )
    }
  })
})

describe("editor process lifecycle effect gates", () => {
  test("launch is denied by the closed process route before resolving any approval", async () => {
    let resolved = 0
    const { host, calls } = recordingHost({})
    await expect(launchApprovedEditorProcessV1({
      approval: approval("language.start", "lsp_typescript_test"),
      scope: rootScope,
      resolveApproval: async () => {
        resolved += 1
        return { effectID: "effect_1", capabilityLeaseDigest: LEASE_DIGEST } as never
      },
      requestHostKernel: host,
    })).rejects.toMatchObject({ _tag: "LanguageServiceProcessError", operation: "server.spawn" })
    expect(resolved).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test("launch maps every capability to its exact closed process operation", async () => {
    const cases = [
      ["language.start", "lsp_typescript_test", "server.spawn"],
      ["debug.start", "dap_debugpy_test", "debug.start"],
      ["repl.start", "repl_python", "repl.start"],
    ] as const
    for (const [capabilityID, profileID, operation] of cases) {
      const { host } = recordingHost({})
      await expect(launchApprovedEditorProcessV1({
        approval: approval(capabilityID, profileID),
        scope: rootScope,
        resolveApproval: async () => ({ effectID: "effect_1", capabilityLeaseDigest: LEASE_DIGEST }) as never,
        requestHostKernel: host,
      }), capabilityID).rejects.toMatchObject({ _tag: "LanguageServiceProcessError", operation })
    }
  })

  test("cancel is denied by the closed process route without any HostKernel dispatch", async () => {
    for (const [kind, operation] of [
      ["language_server", "server.stop"],
      ["debug_adapter", "debug.stop"],
      ["interpreter", "repl.stop"],
    ] as const) {
      const { host, calls } = recordingHost({})
      await expect(cancelEditorProcessV1({
        processRef: { ...processRef, kind },
        effectID: "effect_1",
        challengeID: "challenge_1",
        capabilityLeaseDigest: LEASE_DIGEST,
        scope: rootScope,
        requestHostKernel: host,
      }), kind).rejects.toMatchObject({ _tag: "LanguageServiceProcessError", operation })
      expect(calls).toHaveLength(0)
    }
  })

  test("malformed launch approval is rejected before the closed process gate or any HostKernel dispatch", async () => {
    const { host, calls } = recordingHost({})
    await expect(launchApprovedEditorProcessV1({
      approval: {
        ...approval("language.start", "lsp_typescript_test"),
        sessionID: "session-foreign",
      },
      scope: rootScope,
      resolveApproval: async () => {
        throw new Error("approval must not resolve")
      },
      requestHostKernel: host,
    })).rejects.toThrow("launch profile approval does not match the requested Session, Location, or process kind")
    expect(calls).toHaveLength(0)
  })

  test("a malformed immutable launch profile is rejected before the closed process gate or any HostKernel dispatch", async () => {
    const { host, calls } = recordingHost({})
    await expect(launchApprovedEditorProcessV1({
      approval: {
        ...approval("language.start", "lsp_typescript_test"),
        profileRef: { profileId: "dap_debugpy_test", revision: "1", profileDigest: PROFILE_DIGEST },
      },
      scope: rootScope,
      resolveApproval: async () => {
        throw new Error("approval must not resolve")
      },
      requestHostKernel: host,
    })).rejects.toThrow("launch profile approval capability does not match its immutable profile kind")
    expect(calls).toHaveLength(0)
  })

  test("a malformed scope is rejected before the process gate", async () => {
    const { host, calls } = recordingHost({})
    await expect(cancelEditorProcessV1({
      processRef,
      effectID: "effect_1",
      challengeID: "challenge_1",
      capabilityLeaseDigest: LEASE_DIGEST,
      scope: { ...rootScope, managedAttempt: managedScope(), directAttempt: managedScope() as never },
      requestHostKernel: host,
    })).rejects.toThrow("editor process lifecycle cannot combine managed and direct Attempt scopes")
    expect(calls).toHaveLength(0)
  })
})

function approval(
  capabilityID: "language.start" | "debug.start" | "repl.start",
  profileID: string,
): LaunchProfileApprovalV1 {
  return {
    status: "needs_approval",
    challengeID: "challenge_1",
    effectID: "effect_1",
    capabilityID,
    locationID: "location-1",
    sessionID: "session-1",
    profileRef: { profileId: profileID, revision: "1", profileDigest: PROFILE_DIGEST },
    approval: { capabilityID, challengeID: "challenge_1" },
  } as unknown as LaunchProfileApprovalV1
}

function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionID: "editor_exec_1",
    effectID: "effect_1",
    generation: "3",
    profileID: "lsp_typescript_test",
    profileRevision: "1",
    profileDigest: PROFILE_DIGEST,
    executableDigest: EXECUTABLE_DIGEST,
    exitCode: 0,
    stdoutSequence: "1",
    stderrSequence: "1",
    stdoutDigest: digest("6"),
    stderrDigest: digest("7"),
    outputBytes: "4",
    truncated: false,
    receiptDigest: RECEIPT_DIGEST,
    ...over,
  }
}

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
