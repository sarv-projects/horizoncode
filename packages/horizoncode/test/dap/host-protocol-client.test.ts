import { describe, expect, test } from "bun:test"
import { HostKernelDapProtocolClientV1 } from "@/dap/host-protocol-client"
import type { HostProcessRefV1 } from "@/lsp/process-scope"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const REVISION = digest("1")

const hostProcessRef: HostProcessRefV1 = {
  executionID: "dap_exec_1",
  generation: "2",
  ownerEpoch: "7",
  kind: "debug_adapter",
  profileID: "dap_debugpy_test",
  profileRevision: "1",
  profileDigest: digest("2"),
  executableDigest: digest("3"),
}

const terminalTarget: HostProcessRefV1 = {
  executionID: "term_exec_1",
  generation: "5",
  ownerEpoch: "7",
  kind: "terminal_run",
  profileID: "terminal_target",
  profileRevision: "1",
  profileDigest: digest("4"),
  executableDigest: digest("5"),
}

function makeClient(input: {
  readonly scope?: Record<string, unknown>
  readonly calls?: { host: number; authorized: number }
} = {}) {
  const calls = input.calls ?? { host: 0, authorized: 0 }
  const client = new HostKernelDapProtocolClientV1({
    requestHostKernel: async () => {
      calls.host += 1
      return {}
    },
    scope: {
      hostProcessRef,
      sessionID: "session-1",
      locationID: "location-1",
      workspaceRevision: REVISION,
      ...input.scope,
    } as never,
    authorize: async () => {
      calls.authorized += 1
      return {
        effectID: "effect_1",
        challengeID: "challenge_1",
        capabilityID: "debug.continue",
        capabilityLeaseDigest: digest("6"),
      }
    },
  })
  return { client, calls }
}

describe("DAP HostKernel protocol client construction", () => {
  test("accepts a debug_adapter scope with a same-epoch host-minted terminal target", () => {
    const { client, calls } = makeClient({ scope: { targetHostProcessRef: terminalTarget, dapPolicy: { allowEvaluate: false } } })
    expect(typeof client.sendRequest).toBe("function")
    expect(calls.host).toBe(0)
    expect(calls.authorized).toBe(0)
  })

  test("rejects a scope whose process is not a debug adapter", () => {
    expect(() => makeClient({
      scope: { hostProcessRef: { ...hostProcessRef, kind: "language_server" } },
    })).toThrow("DAP protocol client requires a debug_adapter process")
  })

  test("rejects a malformed immutable adapter policy", () => {
    for (const dapPolicy of [{ allowEvaluate: "yes" }, { allowEvaluate: true, extra: 1 }, {}, { other: true }]) {
      expect(() => makeClient({ scope: { dapPolicy } }), JSON.stringify(dapPolicy)).toThrow(
        "DAP protocol client received a malformed immutable adapter policy",
      )
    }
  })

  test("rejects an attach target that is not a same-epoch terminal_run process", () => {
    for (const [label, target] of [
      ["foreign kind", { ...terminalTarget, kind: "debug_adapter" }],
      ["foreign epoch", { ...terminalTarget, ownerEpoch: "8" }],
    ] as const) {
      expect(() => makeClient({ scope: { targetHostProcessRef: target } }), label).toThrow(
        "DAP attach target must be a same-epoch HostKernel terminal_run process",
      )
    }
  })

  test("rejects a scope claiming both managed and direct Attempt authority", () => {
    expect(() => makeClient({
      scope: { managedAttempt: {}, directAttempt: {} },
    })).toThrow("a process request cannot claim both managed and direct Attempt authority")
  })

  test("rejects a scope without an exact workspace revision", () => {
    expect(() => makeClient({ scope: { workspaceRevision: "sha256:nope" } })).toThrow(
      "process scope workspaceRevision must be a BLAKE3 digest",
    )
  })

  test("rejects a malformed HostKernel process reference before any dispatch", () => {
    expect(() => makeClient({
      scope: { hostProcessRef: { ...hostProcessRef, pid: 99 } },
    })).toThrow("process reference must use the exact HostKernel identity fields")
  })
})

describe("DAP HostKernel protocol client fail-closed routing", () => {
  test("refuses to send before listening, without authorizing or dispatching", async () => {
    const { client, calls } = makeClient()
    await expect(client.sendRequest("continue", {})).rejects.toThrow(
      "must listen before sending requests",
    )
    expect(calls.authorized).toBe(0)
    expect(calls.host).toBe(0)
  })

  test("cannot listen while the shared protocol route is unverified", () => {
    const { client, calls } = makeClient()
    expect(() => client.listen()).toThrow("unavailable until the shared Guarded HostKernel journal route is verified")
    expect(calls.host).toBe(0)
  })

  test("DEC-V1-21 attach and evaluate policy denials are observable before the shared route gate", async () => {
    const { client, calls } = makeClient({ scope: { targetHostProcessRef: terminalTarget } })
    await expect(client.sendRequest("attach", {})).rejects.toThrow(
      "DAP attach requires an accepted shared debuggee namespace and ptrace policy",
    )
    await expect(client.sendRequest("evaluate", { expression: "1" })).rejects.toThrow(
      "DAP evaluate is unavailable unless the trusted immutable adapter profile enables it",
    )
    expect(calls.authorized).toBe(0)
    expect(calls.host).toBe(0)
  })

  test("keeps every DAP command, attach included, unreachable behind the closed route", async () => {
    const { client, calls } = makeClient({ scope: { targetHostProcessRef: terminalTarget } })
    expect(() => client.listen()).toThrow("unavailable until the shared Guarded HostKernel journal route is verified")
    for (const [command, args, reason] of [
      ["attach", {}, "DAP attach requires an accepted shared debuggee namespace and ptrace policy"],
      ["evaluate", { expression: "1" }, "DAP evaluate is unavailable unless the trusted immutable adapter profile enables it"],
      ["continue", {}, "must listen before sending requests"],
    ] as const) {
      await expect(client.sendRequest(command, args), command).rejects.toThrow(reason)
    }
    expect(calls.authorized).toBe(0)
    expect(calls.host).toBe(0)
  })

  test("an ended client rejects every further operation without dispatch", async () => {
    const { client, calls } = makeClient()
    client.end()
    expect(() => client.listen()).toThrow()
    await expect(client.sendRequest("continue", {})).rejects.toThrow()
    expect(calls.authorized).toBe(0)
    expect(calls.host).toBe(0)
  })

  test("event handlers unsubscribe without touching any host state", () => {
    const { client } = makeClient()
    const seen: unknown[] = []
    const off = client.onEvent((event) => seen.push(event))
    off()
    expect(seen).toEqual([])
  })
})
