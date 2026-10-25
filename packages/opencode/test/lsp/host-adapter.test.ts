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

  test("does not continue an admitted request after the adapter is disposed during authorization", async () => {
    let resolveAuthorization!: (lease: {
      effectID: string
      challengeID: string
      capabilityID: string
      capabilityLeaseDigest: string
    }) => void
    const adapter = makeHostLspProtocolAdapterV1({
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
        async protocolReply() {
          throw new Error("must not reply")
        },
      },
      guard: {
        authorizeOperation: () => new Promise((resolve) => {
          resolveAuthorization = resolve
        }),
        async authorizeReply() {
          throw new Error("must not authorize a reply")
        },
      },
    })
    adapter.listen()
    const request = adapter.sendRequest("textDocument/diagnostic", {
      textDocument: { uri: "file:///workspace/main.ts" },
    })

    adapter.dispose()
    resolveAuthorization({
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityID: "language.diagnostics",
      capabilityLeaseDigest: `blake3:${"2".repeat(64)}`,
    })

    await expect(request).rejects.toMatchObject({
      detail: "LSP HostKernel process generation is closed or quarantined",
    })
  })

  test("does not dispatch a notification authorized after the adapter is disposed", async () => {
    let resolveAuthorization!: (lease: {
      effectID: string
      challengeID: string
      capabilityID: string
      capabilityLeaseDigest: string
    }) => void
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
          return null
        },
        async protocolRead() {
          return new Promise(() => undefined)
        },
        async protocolReply() {
          throw new Error("must not reply")
        },
      },
      guard: {
        authorizeOperation: () => new Promise((resolve) => {
          resolveAuthorization = resolve
        }),
        async authorizeReply() {
          throw new Error("must not authorize a reply")
        },
      },
    })
    adapter.listen()
    const notification = adapter.sendNotification("textDocument/didClose", {
      textDocument: { uri: "file:///workspace/main.ts" },
    })

    adapter.dispose()
    resolveAuthorization({
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityID: "language.diagnostics",
      capabilityLeaseDigest: `blake3:${"2".repeat(64)}`,
    })

    await expect(notification).rejects.toMatchObject({
      detail: "LSP HostKernel process generation is closed or quarantined",
    })
    expect(dispatchCount).toBe(0)
  })
})
