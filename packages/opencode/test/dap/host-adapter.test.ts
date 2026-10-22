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
})
