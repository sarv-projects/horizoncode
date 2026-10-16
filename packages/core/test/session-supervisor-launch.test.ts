import { describe, expect, test } from "bun:test"
import {
  assertApplicationFrameFence,
  sessionSupervisorArgs,
  withApplicationFrameFence,
} from "@opencode-ai/core/session/supervisor"

const base = {
  source: "/var/lib/opencode/state.db",
  stateDirectory: "/var/lib/opencode/state/ses_test",
  socketPath: "/var/lib/opencode/state/ses_test/s-0123456789abcdef.sock",
  hostExecutable: "/usr/bin/bun",
  sessionID: "ses_test",
  nonce: "0123456789abcdef0123456789abcdef",
  incarnation: "fedcba9876543210fedcba9876543210",
  ownerEpoch: 7,
} as const

describe("session_supervisor launch arguments", () => {
  test("passes the host kernel owner epoch and the exact accepted argument set", () => {
    const args = sessionSupervisorArgs(base)

    expect(args).toEqual([
      `--source=${base.source}`,
      `--state-dir=${base.stateDirectory}`,
      `--socket=${base.socketPath}`,
      `--host-exe=${base.hostExecutable}`,
      `--session=${base.sessionID}`,
      `--nonce=${base.nonce}`,
      `--incarnation=${base.incarnation}`,
      "--owner-epoch=7",
    ])
    expect(args.some((arg) => arg.startsWith("--workspace-root="))).toBe(false)
  })

  test("rejects a missing, zero, fractional, or unsafe owner epoch", () => {
    for (const ownerEpoch of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => sessionSupervisorArgs({ ...base, ownerEpoch })).toThrow()
    }
  })

  test("rejects a relative launch path", () => {
    expect(() => sessionSupervisorArgs({ ...base, source: "state.db" })).toThrow()
    expect(() => sessionSupervisorArgs({ ...base, socketPath: "s.sock" })).toThrow()
  })
})

describe("supervisor application frame fencing", () => {
  const fence = { ownerEpoch: 7, processIncarnation: "inc-1" } as const
  const request = { kind: "request", protocol: 1, requestId: "req_1" }

  test("binds outbound application frames to the negotiated epoch and incarnation", () => {
    expect(withApplicationFrameFence(request, fence)).toEqual({
      ...request,
      ownerEpoch: fence.ownerEpoch,
      processIncarnation: fence.processIncarnation,
    })
    expect(
      withApplicationFrameFence({ kind: "ack", subscriptionId: "sub_1" }, fence),
    ).toMatchObject({
      ownerEpoch: fence.ownerEpoch,
      processIncarnation: fence.processIncarnation,
    })
    for (const kind of [
      "response",
      "event",
      "subscribe",
      "unsubscribe",
      "page_end",
      "resnapshot_required",
      "cancel_request",
      "ping",
    ]) {
      expect(withApplicationFrameFence({ kind }, fence)).toMatchObject({
        ownerEpoch: fence.ownerEpoch,
        processIncarnation: fence.processIncarnation,
      })
    }
  })

  test("rejects caller-supplied fencing that differs from the negotiated fence", () => {
    expect(() => withApplicationFrameFence({ ...request, ownerEpoch: 8 }, fence)).toThrow()
    expect(() =>
      withApplicationFrameFence({ ...request, processIncarnation: "inc-2" }, fence),
    ).toThrow()
  })

  test("requires exact fencing on inbound application frames", () => {
    expect(() =>
      assertApplicationFrameFence({ ...request, ownerEpoch: 7 }, fence),
    ).toThrow()
    expect(() =>
      assertApplicationFrameFence(
        { ...request, ownerEpoch: 7, processIncarnation: "inc-2" },
        fence,
      ),
    ).toThrow()
    expect(() =>
      assertApplicationFrameFence(
        { ...request, ownerEpoch: 7, processIncarnation: "inc-1" },
        fence,
      ),
    ).not.toThrow()
  })

  test("rejects invalid negotiated fences and non-application frames", () => {
    for (const ownerEpoch of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        withApplicationFrameFence(request, { ownerEpoch, processIncarnation: "inc-1" }),
      ).toThrow()
    }
    for (const processIncarnation of ["", "nul\0", "x".repeat(257)]) {
      expect(() =>
        withApplicationFrameFence(request, { ownerEpoch: 7, processIncarnation }),
      ).toThrow()
    }
    expect(
      withApplicationFrameFence(request, { ownerEpoch: 7, processIncarnation: "é".repeat(128) }),
    ).toMatchObject({ ownerEpoch: 7 })
    expect(() => withApplicationFrameFence({ kind: "hello" }, fence)).toThrow()
  })
})
