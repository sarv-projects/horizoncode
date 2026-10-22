import { describe, expect, test } from "bun:test"
import { makeHostLspProtocolAdapterV1 } from "@/lsp/host-adapter"
import type { HostProcessRefV1 } from "@/lsp/process-scope"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const hostProcessRef: HostProcessRefV1 = {
  executionID: "lsp-adapter-test",
  generation: "1",
  ownerEpoch: "7",
  kind: "language_server",
  profileID: "trusted-lsp",
  profileRevision: "1",
  profileDigest: digest("3"),
  executableDigest: digest("4"),
}

describe("LSP HostKernel adapter", () => {
  test("Guard denial is returned before any HostKernel dispatch", async () => {
    let dispatchCount = 0
    const adapter = makeHostLspProtocolAdapterV1({
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
        async protocolReply() {
          throw new Error("must not reply")
        },
      },
      guard: {
        async authorizeOperation() {
          throw new Error("language.diagnostics denied")
        },
        async authorizeReply() {
          throw new Error("server reply denied")
        },
      },
    })
    adapter.listen()
    await expect(adapter.sendRequest("textDocument/diagnostic", {
      textDocument: { uri: "file:///workspace/main.ts" },
    })).rejects.toThrow("language.diagnostics denied")
    expect(dispatchCount).toBe(0)
    adapter.dispose()
  })
})
