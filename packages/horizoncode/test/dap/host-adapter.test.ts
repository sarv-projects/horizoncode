import { describe, expect, test } from "bun:test"
import { makeHostDapProtocolAdapterV1 } from "@/dap/host-adapter"
import type { HostProcessRefV1 } from "@/lsp/process-scope"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const hostProcessRef: HostProcessRefV1 = {
  executionID: "dap-adapter-test",
  generation: "1",
  ownerEpoch: "7",
  kind: "debug_adapter",
  profileID: "trusted-dap",
  profileRevision: "1",
  profileDigest: digest("3"),
  executableDigest: digest("4"),
}

describe("DAP HostKernel adapter", () => {
  test("Guard denial is returned before any HostKernel dispatch", async () => {
    let dispatchCount = 0
    const adapter = makeHostDapProtocolAdapterV1({
      context: {
        hostProcessRef,
        sessionID: "session-1",
        locationID: "location-1",
        workspaceRevision: digest("1"),
      },
      transport: {
        async protocolOp() {
          dispatchCount += 1
          throw new Error("must not dispatch")
        },
        async protocolRead() {
          return new Promise(() => undefined)
        },
      },
      guard: {
        async authorizeCommand() {
          throw new Error("debug.evaluate denied")
        },
      },
    })
    adapter.listen()
    await expect(adapter.request("evaluate", { expression: "1 + 1" })).rejects.toThrow("debug.evaluate denied")
    expect(dispatchCount).toBe(0)
    adapter.close()
  })

  test("does not continue an admitted request after the adapter is disposed during authorization", async () => {
    let resolveAuthorization!: (lease: {
      effectID: string
      challengeID: string
      capabilityID: string
      capabilityLeaseDigest: string
    }) => void
    let dispatchCount = 0
    const adapter = makeHostDapProtocolAdapterV1({
      context: {
        hostProcessRef,
        sessionID: "session-1",
        locationID: "location-1",
        workspaceRevision: digest("1"),
      },
      transport: {
        async protocolOp() {
          dispatchCount += 1
          throw new Error("must not dispatch")
        },
        async protocolRead() {
          return new Promise(() => undefined)
        },
      },
      guard: {
        authorizeCommand: () =>
          new Promise((resolve) => {
            resolveAuthorization = resolve
          }),
      },
    })
    adapter.listen()
    const request = adapter.request("evaluate", { expression: "1 + 1" })

    adapter.dispose()
    resolveAuthorization({
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityID: "debug.evaluate",
      capabilityLeaseDigest: digest("2"),
    })

    await expect(request).rejects.toMatchObject({
      detail: "DAP HostKernel process generation closed during authorization",
    })
    expect(dispatchCount).toBe(0)
  })

  test("does not continue an admitted request after the adapter is closed during authorization", async () => {
    let resolveAuthorization!: (lease: {
      effectID: string
      challengeID: string
      capabilityID: string
      capabilityLeaseDigest: string
    }) => void
    let dispatchCount = 0
    const adapter = makeHostDapProtocolAdapterV1({
      context: {
        hostProcessRef,
        sessionID: "session-1",
        locationID: "location-1",
        workspaceRevision: digest("1"),
      },
      transport: {
        async protocolOp() {
          dispatchCount += 1
          throw new Error("must not dispatch")
        },
        async protocolRead() {
          return new Promise(() => undefined)
        },
      },
      guard: {
        authorizeCommand: () =>
          new Promise((resolve) => {
            resolveAuthorization = resolve
          }),
      },
    })
    adapter.listen()
    const request = adapter.request("evaluate", { expression: "1 + 1" })

    adapter.close()
    resolveAuthorization({
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityID: "debug.evaluate",
      capabilityLeaseDigest: digest("2"),
    })

    await expect(request).rejects.toMatchObject({
      detail: "DAP HostKernel process generation closed during authorization",
    })
    expect(dispatchCount).toBe(0)
  })

  test("rejects request without authorization or dispatch when adapter is already closed or quarantined", async () => {
    let guardCallCount = 0
    let dispatchCount = 0
    const adapter = makeHostDapProtocolAdapterV1({
      context: {
        hostProcessRef,
        sessionID: "session-1",
        locationID: "location-1",
        workspaceRevision: digest("1"),
      },
      transport: {
        async protocolOp() {
          dispatchCount += 1
          throw new Error("must not dispatch")
        },
        async protocolRead() {
          return new Promise(() => undefined)
        },
      },
      guard: {
        async authorizeCommand() {
          guardCallCount += 1
          return {
            effectID: "effect-1",
            challengeID: "challenge-1",
            capabilityID: "debug.evaluate",
            capabilityLeaseDigest: digest("2"),
          }
        },
      },
    })
    adapter.listen()
    adapter.close()

    await expect(adapter.request("evaluate", { expression: "1 + 1" })).rejects.toMatchObject({
      detail: "DAP HostKernel process generation is closed or quarantined",
    })
    expect(guardCallCount).toBe(0)
    expect(dispatchCount).toBe(0)
  })

  test("rejects request if response stream is not listening", async () => {
    let guardCallCount = 0
    const adapter = makeHostDapProtocolAdapterV1({
      context: {
        hostProcessRef,
        sessionID: "session-1",
        locationID: "location-1",
        workspaceRevision: digest("1"),
      },
      transport: {
        async protocolOp() {
          throw new Error("must not dispatch")
        },
        async protocolRead() {
          return new Promise(() => undefined)
        },
      },
      guard: {
        async authorizeCommand() {
          guardCallCount += 1
          throw new Error("must not authorize")
        },
      },
    })
    await expect(adapter.request("evaluate", { expression: "1 + 1" })).rejects.toMatchObject({
      detail: "DAP response stream must be listening before requests are sent",
    })
    expect(guardCallCount).toBe(0)
  })

  test("listen throws when called on a closed or quarantined adapter", () => {
    const adapter = makeHostDapProtocolAdapterV1({
      context: {
        hostProcessRef,
        sessionID: "session-1",
        locationID: "location-1",
        workspaceRevision: digest("1"),
      },
      transport: {
        async protocolOp() {
          throw new Error("must not dispatch")
        },
        async protocolRead() {
          return new Promise(() => undefined)
        },
      },
      guard: {
        async authorizeCommand() {
          throw new Error("must not authorize")
        },
      },
    })
    adapter.close()
    try {
      adapter.listen()
      expect(true).toBe(false)
    } catch (error) {
      expect(error).toMatchObject({
        detail: "cannot listen on a closed or quarantined DAP adapter",
      })
    }
  })

})
