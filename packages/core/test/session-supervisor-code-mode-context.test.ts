import { expect, test } from "bun:test"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { HostKernelClientImpl, type HostKernelTransport } from "@opencode-ai/core/session/supervisor"

const locationID = `loc_${"a".repeat(64)}`
const sessionID = "ses_code_mode_context"

function client(sends: Array<Record<string, unknown>>) {
  const responses: Array<Record<string, unknown>> = []
  let notify: (() => void) | undefined
  const channel: HostKernelTransport = {
    send: async (value) => {
      sends.push(value)
      responses.push({
        protocol: 1,
        kind: "response",
        requestId: value.requestId,
        outcome: "ok",
        body: { status: "ok" },
      })
      notify?.()
    },
    receive: () =>
      new Promise((resolve) => {
        const next = () => {
          const value = responses.shift()
          if (value !== undefined) resolve(value)
          else notify = next
        }
        next()
      }),
    end: () => {},
    isClosed: () => false,
    destroy: () => {},
  }
  return new HostKernelClientImpl(channel, {} as unknown as ChildProcessHandle, 7, ["effects.v2"])
}

const directContext = { kind: "code_mode_call" as const, sessionID, locationID, callID: "call_1", lane: "direct_session" as const }

test("binds direct-session CodeMode RPC bodies to the exact authenticated call", async () => {
  const sends: Array<Record<string, unknown>> = []
  const subject = client(sends)
  const valid = { schemaVersion: 1, lane: "direct_session", sessionID, locationID, callID: "call_1" }
  const request = subject.request("execution.v1", "codemode_prepare_wave", valid, undefined, undefined, {
    kind: "server_auth",
    subject: "code-mode-test",
  }, directContext)
  expect(sends).toHaveLength(1)
  await request

  for (const body of [
    { ...valid, callID: "call_2" },
    { ...valid, locationID: `loc_${"b".repeat(64)}` },
    { ...valid, sessionID: "ses_other" },
    { schemaVersion: 2, lane: "direct_session", sessionID, locationID, callID: "call_1" },
  ]) {
    const before = sends.length
    await expect(
      subject.request("execution.v1", "codemode_prepare_wave", body, undefined, undefined, {
        kind: "server_auth",
        subject: "code-mode-test",
      }, directContext),
    ).rejects.toThrow("authenticated read context is unavailable or invalid")
    expect(sends).toHaveLength(before)
  }
})

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const managedAttempt = {
  goalID: "goal_1",
  runID: "run_1",
  taskID: "task_1",
  attemptID: "attempt_1",
  ownerEpoch: "7",
  expectedManagedRevision: "9",
  requestSequence: "1",
  requestID: "req_managed_code_mode",
  contextSelectionDigest: digest("1"),
  locationID,
  sessionID,
  workspaceRevision: digest("2"),
  effectiveMaxTokens: "1000",
  remainingTokens: "900",
  delegationBindingDigest: digest("3"),
  permissionScopeDigest: digest("4"),
  worktreeTarget: {
    worktreeID: "worktree_1",
    worktreeBaseRevision: digest("2"),
    worktreePoolRevision: "1",
    locationID,
    workspaceID: "workspace_1",
    workspaceRef: "/workspace",
    canonicalRoot: "/workspace",
    workspaceRevision: digest("2"),
  },
} as const

test("binds managed-attempt CodeMode RPC bodies to the exact authenticated Attempt and call", async () => {
  const sends: Array<Record<string, unknown>> = []
  const subject = client(sends)
  const context = { kind: "code_mode_call" as const, sessionID, locationID, callID: "call_1", lane: "managed_attempt" as const, managedAttempt }
  const valid = {
    schemaVersion: 1,
    lane: "managed_attempt",
    sessionID,
    locationID,
    callID: "call_1",
    runID: managedAttempt.runID,
    taskID: managedAttempt.taskID,
    attemptID: managedAttempt.attemptID,
  }
  await subject.request("execution.v1", "codemode_prepare_wave", valid, undefined, undefined, {
    kind: "server_auth",
    subject: "code-mode-test",
  }, context)
  expect(sends).toHaveLength(1)

  for (const body of [
    { ...valid, callID: "call_2" },
    { ...valid, taskID: "task_2" },
    { ...valid, locationID: `loc_${"b".repeat(64)}` },
  ]) {
    const before = sends.length
    await expect(
      subject.request("execution.v1", "codemode_prepare_wave", body, undefined, undefined, {
        kind: "server_auth",
        subject: "code-mode-test",
      }, context),
    ).rejects.toThrow("authenticated read context is unavailable or invalid")
    expect(sends).toHaveLength(before)
  }
})

test("rejects malformed CodeMode principals and authenticated call identities before any frame", async () => {
  const sends: Array<Record<string, unknown>> = []
  const subject = client(sends)
  const body = { schemaVersion: 1, lane: "direct_session", sessionID, locationID, callID: "call_1" }

  await expect(
    subject.request("execution.v1", "codemode_prepare_wave", body, undefined, undefined, {
      kind: "server_auth",
      subject: "bad\nsubject",
    }, directContext),
  ).rejects.toThrow("authenticated ServerAuth subject is invalid")

  await expect(
    subject.request("execution.v1", "codemode_prepare_wave", body, undefined, undefined, { kind: "host_os" }, directContext),
  ).rejects.toThrow("authenticated read context is unavailable or invalid")

  await expect(
    subject.request("execution.v1", "codemode_prepare_wave", body, undefined, undefined, {
      kind: "server_auth",
      subject: "code-mode-test",
    }, { ...directContext, callID: "bad\ncall" }),
  ).rejects.toThrow("authenticated read context is unavailable or invalid")

  expect(sends).toHaveLength(0)
})
