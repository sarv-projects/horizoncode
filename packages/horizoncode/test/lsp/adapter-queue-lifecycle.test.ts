import { expect, mock, test } from "bun:test"
import * as Launch from "@/lsp/launch"

const assertProductionHostProtocolAllowed = Launch.assertHostProtocolAllowed
// Exercise the adapter's queue/lifecycle contract using a narrowly scoped
// protocol-route simulation. Outside these tests, the replacement delegates
// to the real production-false gate so it cannot alter unrelated suite cases.
let queueTestProtocolRouteEnabled = false
mock.module("@/lsp/launch", () => ({
  ...Launch,
  assertHostProtocolAllowed() {
    if (!queueTestProtocolRouteEnabled) assertProductionHostProtocolAllowed()
  },
}))

const { makeHostLspProtocolAdapterV1 } = await import("@/lsp/host-adapter")
const { makeHostDapProtocolAdapterV1 } = await import("@/dap/host-adapter")
import type { HostProcessRefV1 } from "@/lsp/process-scope"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const lspProcessRef: HostProcessRefV1 = {
  executionID: "lsp-queue-test",
  generation: "1",
  ownerEpoch: "7",
  kind: "language_server",
  profileID: "trusted-lsp",
  profileRevision: "1",
  profileDigest: digest("3"),
  executableDigest: digest("4"),
}
const dapProcessRef: HostProcessRefV1 = {
  ...lspProcessRef,
  executionID: "dap-queue-test",
  kind: "debug_adapter",
}

test("LSP does not send a queued notification after disposal", () => withQueueTestProtocolRoute(async () => {
  let enterFirst!: () => void
  let releaseFirst!: () => void
  let authorizeSecond!: () => void
  const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve })
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve })
  const secondAuthorized = new Promise<void>((resolve) => { authorizeSecond = resolve })
  let dispatchCount = 0
  let authorizationCount = 0
  const adapter = makeHostLspProtocolAdapterV1({
    context: { hostProcessRef: lspProcessRef, sessionID: "session-1", locationID: "location-1", workspaceRevision: digest("1") },
    transport: {
      async protocolOp(request) {
        dispatchCount += 1
        if (request.operation.requestSequence === "1") {
          enterFirst()
          await firstRelease
        }
        return {
          schemaVersion: 1,
          hostProcessRef: lspProcessRef,
          requestSequence: request.operation.requestSequence,
          processIOSequence: request.operation.requestSequence,
          operationDigest: digest("5"),
          dispatchReceiptDigest: digest("6"),
          status: "DISPATCHED",
        }
      },
      async protocolRead() { return new Promise(() => undefined) },
      async protocolReply() { throw new Error("unexpected reply") },
    },
    guard: {
      async authorizeOperation() {
        authorizationCount += 1
        if (authorizationCount === 2) authorizeSecond()
        return {
          effectID: `effect-${authorizationCount}`,
          challengeID: `challenge-${authorizationCount}`,
          capabilityID: "language.diagnostics",
          capabilityLeaseDigest: digest("2"),
        }
      },
      async authorizeReply() { throw new Error("unexpected reply authorization") },
    },
  })
  adapter.listen()
  const first = adapter.sendNotification("textDocument/didClose", {
    textDocument: { uri: "file:///workspace/first.ts" },
  })
  await firstEntered
  const second = adapter.sendNotification("textDocument/didClose", {
    textDocument: { uri: "file:///workspace/second.ts" },
  })
  await secondAuthorized

  adapter.dispose()
  releaseFirst()

  await first
  await expect(second).rejects.toMatchObject({
    detail: "LSP HostKernel process generation is closed or quarantined",
  })
  expect(dispatchCount).toBe(1)
}))

test("DAP does not send a queued request after close", () => withQueueTestProtocolRoute(async () => {
  let enterFirst!: () => void
  let releaseFirst!: () => void
  let authorizeSecond!: () => void
  const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve })
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve })
  const secondAuthorized = new Promise<void>((resolve) => { authorizeSecond = resolve })
  let dispatchCount = 0
  let authorizationCount = 0
  const adapter = makeHostDapProtocolAdapterV1({
    context: { hostProcessRef: dapProcessRef, sessionID: "session-1", locationID: "location-1", workspaceRevision: digest("1") },
    transport: {
      async protocolOp(request) {
        dispatchCount += 1
        if (request.operation.requestSequence === "1") {
          enterFirst()
          await firstRelease
        }
        return {
          schemaVersion: 1,
          hostProcessRef: dapProcessRef,
          requestSequence: request.operation.requestSequence,
          processIOSequence: request.operation.requestSequence,
          operationDigest: digest("5"),
          dispatchReceiptDigest: digest("6"),
          status: "DISPATCHED",
        }
      },
      async protocolRead() { return new Promise(() => undefined) },
    },
    guard: {
      async authorizeCommand() {
        authorizationCount += 1
        if (authorizationCount === 2) authorizeSecond()
        return {
          effectID: `effect-${authorizationCount}`,
          challengeID: `challenge-${authorizationCount}`,
          capabilityID: "debug.evaluate",
          capabilityLeaseDigest: digest("2"),
        }
      },
    },
  })
  adapter.listen()
  const first = adapter.request("evaluate", { expression: "1", deadlineMs: 1000, maxOutputBytes: 1024 })
  await firstEntered
  const second = adapter.request("evaluate", { expression: "2", deadlineMs: 1000, maxOutputBytes: 1024 })
  await secondAuthorized

  const firstSettled = first.catch((error) => error)
  const secondSettled = second.catch((error) => error)
  adapter.close()
  releaseFirst()

  expect(await firstSettled).toMatchObject({ detail: "DAP HostKernel adapter closed" })
  expect(await secondSettled).toMatchObject({ detail: "DAP HostKernel adapter closed" })
  expect(dispatchCount).toBe(1)
}))

async function withQueueTestProtocolRoute<T>(run: () => Promise<T>): Promise<T> {
  queueTestProtocolRouteEnabled = true
  try {
    return await run()
  } finally {
    queueTestProtocolRouteEnabled = false
  }
}
