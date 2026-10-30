import { describe, expect, test } from "bun:test"
import {
  LspEventCursorV1,
  LspProtocolJournalV1,
  OutboundProtocolSequenceV1,
  ProtocolError,
  ResnapshotRequiredError,
  validateLspProtocolOperationRequestV1,
  validateLspProtocolReplyRequestV1,
  validateLspServerRequestParamsV1,
  lspProtocolCapabilityV1,
  lspServerRequestCapabilityV1,
  validateProtocolDispatchReceiptV1,
  type LspProtocolOperationRequestV1,
  type HostProtocolDispatchReceiptV1,
} from "@/lsp/protocol"
import type { HostProcessRefV1 } from "@/lsp/process-scope"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const processRef: HostProcessRefV1 = {
  executionID: "lsp-protocol-test",
  generation: "1",
  ownerEpoch: "7",
  kind: "language_server",
  profileID: "trusted-lsp",
  profileRevision: "1",
  profileDigest: digest("3"),
  executableDigest: digest("4"),
}
const workspaceRevision = digest("1")
const directAttempt = {
  attemptID: "attempt-1", parentSessionID: "parent-session-1", childSessionID: "session-1",
  ownerEpoch: "7", expectedRevision: "0", locationID: "location-1", workspaceID: "workspace-1",
  workspaceRevision, profileID: "trusted-lsp", profileRevision: "1", profileDigest: digest("3"),
  capabilityDigest: digest("5"), permissionsDigest: digest("6"), budgetDigest: digest("7"), scopeDigest: digest("8"),
}

function operationRequest(): LspProtocolOperationRequestV1 {
  return {
    hostProcessRef: processRef,
    sessionID: "session-1",
    locationID: "location-1",
    workspaceRevision,
    effectID: "effect-1",
    challengeID: "challenge-1",
    capabilityID: "language.diagnostics",
    capabilityLeaseDigest: digest("2"),
    directAttempt,
    operation: {
      requestSequence: "1",
      requestID: 1,
      method: "textDocument/diagnostic",
      params: { textDocument: { uri: "file:///workspace/src/main.ts" } },
    },
  }
}

function dispatchReceipt(requestSequence = "1"): HostProtocolDispatchReceiptV1 {
  return {
    schemaVersion: 1,
    hostProcessRef: processRef,
    requestSequence,
    processIOSequence: "1",
    operationDigest: digest("5"),
    dispatchReceiptDigest: digest("6"),
    status: "DISPATCHED",
  }
}

function responsePage() {
  return {
    hostProcessRef: processRef,
    afterEventSequence: "0",
    processIOSequence: "1",
    workspaceRevision,
    status: "RUNNING",
    events: [
      {
        protocol: "lsp",
        messageKind: "response",
        payload: {
          schemaVersion: 1,
          eventSequence: "1",
          requestSequence: "1",
          requestID: 1,
          method: "textDocument/diagnostic",
          result: { kind: "full", items: [] },
        },
      },
    ],
  } as const
}

describe("LSP typed HostKernel protocol contract", () => {
  test("maps every accepted lifecycle/query and server callback to its canonical Guard action", () => {
    expect(lspProtocolCapabilityV1("initialize")).toBe("language.start")
    expect(lspProtocolCapabilityV1("workspace/didChangeConfiguration")).toBe("language.start")
    expect(lspProtocolCapabilityV1("shutdown")).toBe("language.stop")
    expect(lspProtocolCapabilityV1("exit")).toBe("language.stop")
    for (const notification of [
      "initialized",
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didClose",
      "workspace/didChangeWatchedFiles",
      "$/cancelRequest",
    ]) {
      expect(lspProtocolCapabilityV1(notification)).toBe("language.diagnostics")
    }
    expect(lspProtocolCapabilityV1("textDocument/codeAction")).toBe("language.diagnostics")
    expect(lspProtocolCapabilityV1("textDocument/rename")).toBe("references.find")
    expect(lspProtocolCapabilityV1("workspace/executeCommand")).toBeUndefined()
    expect(lspServerRequestCapabilityV1("workspace/configuration")).toBe("language.start")
    expect(lspServerRequestCapabilityV1("workspace/diagnostic/refresh")).toBe("language.diagnostics")
  })

  test("validates lifecycle requests and notifications against their exact Guard action", () => {
    const lifecycle = [
      { method: "initialize", capabilityID: "language.start", requestID: 1 },
      { method: "initialized", capabilityID: "language.diagnostics" },
      { method: "workspace/didChangeConfiguration", capabilityID: "language.start" },
      { method: "textDocument/didOpen", capabilityID: "language.diagnostics" },
      { method: "textDocument/didChange", capabilityID: "language.diagnostics" },
      { method: "textDocument/didClose", capabilityID: "language.diagnostics" },
      { method: "workspace/didChangeWatchedFiles", capabilityID: "language.diagnostics" },
      { method: "$/cancelRequest", capabilityID: "language.diagnostics" },
      { method: "shutdown", capabilityID: "language.stop", requestID: 2 },
      { method: "exit", capabilityID: "language.stop" },
    ] as const

    for (const { method, capabilityID, ...requestID } of lifecycle) {
      const request = {
        ...operationRequest(),
        capabilityID,
        operation: {
          requestSequence: "1",
          method,
          params: {},
          ...requestID,
        },
      }
      expect(validateLspProtocolOperationRequestV1(request).operation.method).toBe(method)
      const weakerCapability = capabilityID === "language.start" ? "language.diagnostics"
        : capabilityID === "language.stop" ? "language.diagnostics"
          : "language.start"
      expect(() => validateLspProtocolOperationRequestV1({ ...request, capabilityID: weakerCapability })).toThrow(
        ProtocolError,
      )
    }

    for (const method of ["textDocument/didSave", "workspace/executeCommand", "$/setTrace"]) {
      const request = operationRequest()
      ;(request.operation as { method: string }).method = method
      expect(() => validateLspProtocolOperationRequestV1(request)).toThrow(ProtocolError)
    }

    const requestWithIDOnNotification = operationRequest()
    ;(requestWithIDOnNotification.operation as { method: string }).method = "textDocument/didClose"
    expect(() => validateLspProtocolOperationRequestV1(requestWithIDOnNotification)).toThrow(ProtocolError)
  })

  test("narrows buffered server callback params before Core handlers see them", () => {
    expect(validateLspServerRequestParamsV1("workspace/configuration", {
      items: [{ section: "typescript", scopeUri: "file:///workspace" }],
    })).toEqual({ items: [{ section: "typescript", scopeUri: "file:///workspace" }] })
    expect(validateLspServerRequestParamsV1("client/registerCapability", {
      registrations: [{ id: "diag", method: "textDocument/diagnostic", registerOptions: { workspaceDiagnostics: true } }],
    })).toMatchObject({ registrations: [{ id: "diag", method: "textDocument/diagnostic" }] })
    expect(() => validateLspServerRequestParamsV1("client/registerCapability", {
      registrations: [{ id: "exec", method: "workspace/executeCommand" }],
    })).toThrow(ProtocolError)
    expect(() => validateLspServerRequestParamsV1("workspace/configuration", {
      items: Array.from({ length: 257 }, () => ({})),
    })).toThrow(ProtocolError)
    expect(() => validateLspServerRequestParamsV1("workspace/diagnostic/refresh", { extra: true })).toThrow(ProtocolError)
  })

  test("accepts only the fixed typed operation set and binds the durable receipt", () => {
    const request = operationRequest()
    expect(validateLspProtocolOperationRequestV1(request)).toEqual(request)
    expect(validateProtocolDispatchReceiptV1(request, dispatchReceipt())).toMatchObject({
      requestSequence: "1",
      status: "DISPATCHED",
      hostProcessRef: processRef,
    })
  })

  test("allocates one monotonic sequence across operations and protocol replies", () => {
    const sequence = new OutboundProtocolSequenceV1(processRef)
    expect(sequence.next(processRef)).toBe("1")
    expect(sequence.next(processRef)).toBe("2")
    expect(sequence.lastIssued).toBe("2")
    expect(() => sequence.next({ ...processRef, generation: "2" })).toThrow(ResnapshotRequiredError)
  })

  test("rejects custom methods, malformed IDs, NUL and payloads over one MiB", () => {
    const unsupported = operationRequest()
    ;(unsupported.operation as { method: string }).method = "workspace/executeCommand"
    expect(() => validateLspProtocolOperationRequestV1(unsupported)).toThrow(ProtocolError)

    const badID = operationRequest()
    ;(badID.operation as { requestID: string | number }).requestID = -1
    expect(() => validateLspProtocolOperationRequestV1(badID)).toThrow(ProtocolError)

    const nul = operationRequest()
    ;(nul.operation as { params: unknown }).params = { text: "bad\u0000value" }
    expect(() => validateLspProtocolOperationRequestV1(nul)).toThrow(ProtocolError)

    const large = operationRequest()
    ;(large.operation as { params: unknown }).params = { text: "x".repeat(1024 * 1024 + 1) }
    expect(() => validateLspProtocolOperationRequestV1(large)).toThrow(ProtocolError)
  })

  test("rejects accessor-backed values without invoking them", () => {
    let getterCalled = false
    const request = operationRequest()
    const params = request.operation.params as Record<string, unknown>
    Object.defineProperty(params, "textDocument", {
      enumerable: true,
      get() {
        getterCalled = true
        return { uri: "file:///workspace/src/main.ts" }
      },
    })
    expect(() => validateLspProtocolOperationRequestV1(request)).toThrow(ProtocolError)
    expect(getterCalled).toBe(false)
  })

  test("rejects a receipt for another sequence or process generation", () => {
    const request = operationRequest()
    expect(() => validateProtocolDispatchReceiptV1(request, dispatchReceipt("2"))).toThrow(ProtocolError)
    expect(() =>
      validateProtocolDispatchReceiptV1(request, {
        ...dispatchReceipt(),
        hostProcessRef: { ...processRef, generation: "2" },
      }),
    ).toThrow(ResnapshotRequiredError)
  })

  test("accepts an exact durable receipt replay without re-enqueuing the request", () => {
    const journal = new LspProtocolJournalV1(processRef, workspaceRevision)
    const request = operationRequest()
    const receipt = dispatchReceipt()
    journal.acceptOperation(request, receipt)
    expect(journal.acceptOperation(request, receipt)).toEqual(receipt)
    expect(journal.quarantined).toBe(false)
  })

  test("rejects request and callback capability substitution", () => {
    const operation = { ...operationRequest(), capabilityID: "definitions.find" }
    expect(() => validateLspProtocolOperationRequestV1(operation)).toThrow(ProtocolError)

    const reply = {
      schemaVersion: 1,
      hostProcessRef: processRef,
      sessionID: "session-1",
      locationID: "location-1",
      workspaceRevision,
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityID: "language.diagnostics",
      capabilityLeaseDigest: digest("2"),
      directAttempt,
      reply: {
        schemaVersion: 1,
        requestSequence: "1",
        serverRequestID: "cfg-1",
        method: "workspace/configuration",
        result: [],
      },
    }
    expect(() => validateLspProtocolReplyRequestV1(reply)).toThrow(ProtocolError)
  })

  test("quarantines a reused outbound sequence with different operation content", () => {
    const journal = new LspProtocolJournalV1(processRef, workspaceRevision)
    journal.acceptOperation(operationRequest(), dispatchReceipt())
    const original = operationRequest()
    const conflicting = {
      ...original,
      operation: { ...original.operation, params: { textDocument: { uri: "file:///other.ts" } } },
    }
    expect(() => journal.acceptOperation(conflicting, dispatchReceipt())).toThrow(ResnapshotRequiredError)
    expect(journal.quarantined).toBe(true)
  })

  test("correlates typed responses and suppresses an exact replay page", () => {
    const journal = new LspProtocolJournalV1(processRef, workspaceRevision)
    journal.acceptOperation(operationRequest(), dispatchReceipt())
    const cursor = new LspEventCursorV1(processRef, "session-1", "location-1", workspaceRevision, undefined, directAttempt)
    const page = responsePage()
    const accepted = cursor.accept(page)
    expect(accepted.events).toHaveLength(1)
    expect(cursor.afterEventSequence).toBe("1")
    journal.acceptPage(accepted)
    expect(journal.quarantined).toBe(false)
    expect(cursor.accept(page).events).toHaveLength(0)
    expect(() => journal.acceptPage({ ...accepted, events: [] })).not.toThrow()
    expect(journal.quarantined).toBe(false)
  })

  test("quarantines a conflicting duplicate or cursor gap instead of skipping it", () => {
    const cursor = new LspEventCursorV1(processRef, "session-1", "location-1", workspaceRevision, undefined, directAttempt)
    cursor.accept(responsePage())
    const conflict = {
      ...responsePage(),
      events: [
        {
          protocol: "lsp",
          messageKind: "notification",
          payload: { eventSequence: "1", method: "textDocument/publishDiagnostics", params: { uri: "x", diagnostics: [] } },
        },
      ],
    }
    expect(() => cursor.accept(conflict)).toThrow(ResnapshotRequiredError)
    expect(cursor.quarantined).toBe(true)
  })

  test("binds a server-request reply to a retained request and the next outbound sequence", () => {
    const journal = new LspProtocolJournalV1(processRef, workspaceRevision)
    const page = {
      hostProcessRef: processRef,
      afterEventSequence: "0",
      processIOSequence: "0",
      workspaceRevision,
      status: "RUNNING",
      events: [
        {
          protocol: "lsp",
          messageKind: "server_request",
          payload: {
            eventSequence: "1",
            requestID: "cfg-1",
            method: "workspace/configuration",
            params: { items: [{ section: "typescript" }] },
          },
        },
      ],
    } as const
    const cursor = new LspEventCursorV1(processRef, "session-1", "location-1", workspaceRevision, undefined, directAttempt)
    journal.acceptPage(cursor.accept(page))
    const reply = {
      schemaVersion: 1,
      hostProcessRef: processRef,
      sessionID: "session-1",
      locationID: "location-1",
      workspaceRevision,
      effectID: "effect-2",
      challengeID: "challenge-2",
      capabilityID: "language.start",
      capabilityLeaseDigest: digest("2"),
      directAttempt,
      reply: {
        schemaVersion: 1,
        requestSequence: "1",
        serverRequestID: "cfg-1",
        method: "workspace/configuration",
        result: [null],
      },
    }
    journal.acceptProtocolReply(reply, {
      ...dispatchReceipt(),
      processIOSequence: "1",
      requestSequence: "1",
    })
    expect(journal.quarantined).toBe(false)
  })
})
