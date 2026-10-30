import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { it } from "../lib/effect"
import {
  MAX_FRAME_BYTES,
  MAX_HEADER_BYTES,
  ProtocolError,
  classifyCommand,
  decodeFrame,
  encodeFrame,
  parseMessage,
  HostDapEventCursorV1,
  HostDapProtocolJournalV1,
  ResnapshotRequiredError,
  validateHostDapDispatchReceiptV1,
  validateHostEventPageV1,
  validateHostOperationRequestV1,
  type Envelope,
  type HostOperationRequestV1,
} from "@/dap/protocol"
import type { HostProtocolDispatchReceiptV1 } from "@/lsp/protocol"
import type { HostProcessRefV1 } from "@/lsp/process-scope"

/** The protocol validators reject mutated/copied requests structurally, so the
 * fixtures stay mutable while their outbound shape remains exactly pinned. */
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> }

const encoder = new TextEncoder()
const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const hostProcessRef: HostProcessRefV1 = {
  executionID: "dap-protocol-test",
  generation: "1",
  ownerEpoch: "7",
  kind: "debug_adapter",
  profileID: "trusted-dap",
  profileRevision: "1",
  profileDigest: digest("3"),
  executableDigest: digest("4"),
}
const targetHostProcessRef: HostProcessRefV1 = {
  executionID: "terminal-target-test",
  generation: "2",
  ownerEpoch: "7",
  kind: "terminal_run",
  profileID: "shell-default",
  profileRevision: "1",
  profileDigest: digest("8"),
  executableDigest: digest("9"),
}
const workspaceRevision = digest("1")
const directAttempt = {
  attemptID: "attempt-1", parentSessionID: "parent-session-1", childSessionID: "session-1",
  ownerEpoch: "7", expectedRevision: "0", locationID: "location-1", workspaceID: "workspace-1",
  workspaceRevision, profileID: "agent-profile", profileRevision: "2", profileDigest: digest("a"),
  capabilityDigest: digest("5"), permissionsDigest: digest("6"), budgetDigest: digest("7"), scopeDigest: digest("8"),
}

function hostOperationRequest(): Mutable<HostOperationRequestV1> {
  return {
    hostProcessRef,
    sessionID: "session-1",
    locationID: "location-1",
    workspaceRevision,
    effectID: "effect-1",
    challengeID: "challenge-1",
    capabilityID: "debug.start",
    capabilityLeaseDigest: digest("2"),
    directAttempt,
    operation: {
      requestSequence: "1",
      requestID: 1,
      command: "initialize",
      arguments: {},
    },
  }
}

function hostDispatchReceipt(requestSequence = "1"): HostProtocolDispatchReceiptV1 {
  return {
    schemaVersion: 1,
    hostProcessRef,
    requestSequence,
    processIOSequence: "1",
    operationDigest: digest("5"),
    dispatchReceiptDigest: digest("6"),
    status: "DISPATCHED",
  }
}

function hostResponsePage() {
  return {
    hostProcessRef,
    afterEventSequence: "0",
    processIOSequence: "1",
    workspaceRevision,
    status: "RUNNING",
    events: [
      {
        protocol: "dap",
        messageKind: "response",
        payload: {
          schemaVersion: 1,
          eventSequence: "1",
          requestSequence: "1",
          requestID: 1,
          command: "initialize",
          success: true,
          body: { supportsConfigurationDoneRequest: true },
        },
      },
    ],
  } as const
}

const request = (seq = 1, command = "threads"): Envelope => ({ seq, type: "request", command })
const response = (seq = 2): Envelope => ({
  seq,
  type: "response",
  request_seq: 1,
  success: true,
  command: "threads",
  body: { threads: [] },
})
const event = (seq = 3): Envelope => ({ seq, type: "event", event: "initialized", body: {} })

function capture<T = Record<string, unknown>>(fn: () => unknown): T {
  try {
    fn()
  } catch (error) {
    return error as T
  }
  throw new Error("expected call to throw")
}

describe("dap.protocol framing", () => {
  test("round-trips request, response and event envelopes", () => {
    for (const message of [request(), response(), event()]) {
      const decoded = decodeFrame(encodeFrame(message))
      expect(decoded?.message).toEqual(message)
      expect(decoded?.rest.byteLength).toBe(0)
    }
  })

  test("decodes concatenated frames one at a time", () => {
    const first = encodeFrame(request(1, "initialize"))
    const second = encodeFrame(event(2))
    const combined = new Uint8Array(first.byteLength + second.byteLength)
    combined.set(first, 0)
    combined.set(second, first.byteLength)

    const decoded = decodeFrame(combined)
    expect(decoded?.message).toEqual(request(1, "initialize"))
    const next = decodeFrame(decoded!.rest)
    expect(next?.message).toEqual(event(2))
    expect(next?.rest.byteLength).toBe(0)
  })

  test("returns null until the header and body are complete", () => {
    const frame = encodeFrame(request())
    expect(decodeFrame(frame.slice(0, 4))).toBeNull()
    expect(decodeFrame(frame.slice(0, frame.byteLength - 1))).toBeNull()
  })

  test("rejects oversized frames and headers", () => {
    const huge = encoder.encode(`Content-Length: ${MAX_FRAME_BYTES + 1}\r\n\r\n`)
    const error = capture<ProtocolError>(() => decodeFrame(huge))
    expect(error).toBeInstanceOf(ProtocolError)
    expect(error._tag).toBe("DAPProtocolError")

    const headerFlood = new Uint8Array(MAX_HEADER_BYTES + 1).fill(65)
    expect(() => decodeFrame(headerFlood)).toThrow(ProtocolError)
  })

  test("rejects an oversized header even when its terminator is present", () => {
    const body = encoder.encode(JSON.stringify(request()))
    const header = encoder.encode(
      `Content-Length: ${body.byteLength}\r\nX-Pad: ${"x".repeat(MAX_HEADER_BYTES)}\r\n\r\n`,
    )
    const frame = new Uint8Array(header.byteLength + body.byteLength)
    frame.set(header)
    frame.set(body, header.byteLength)

    const error = capture<ProtocolError>(() => decodeFrame(frame))
    expect(error.detail).toContain("DAP header exceeds")
  })

  test("rejects duplicate Content-Length headers", () => {
    const body = encoder.encode(JSON.stringify(request()))
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\nContent-Length: ${body.byteLength}\r\n\r\n`)
    const frame = new Uint8Array(header.byteLength + body.byteLength)
    frame.set(header)
    frame.set(body, header.byteLength)

    expect(() => decodeFrame(frame)).toThrow(ProtocolError)
  })

  test("rejects additional framing headers", () => {
    const body = encoder.encode(JSON.stringify(request()))
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\nX-Adapter-Mode: permissive\r\n\r\n`)
    const frame = new Uint8Array(header.byteLength + body.byteLength)
    frame.set(header)
    frame.set(body, header.byteLength)
    expect(() => decodeFrame(frame)).toThrow(ProtocolError)
  })

  test("rejects invalid UTF-8 in the JSON body", () => {
    const bodyPrefix = encoder.encode('{"seq":1,"type":"event","event":"')
    const bodySuffix = encoder.encode('"}')
    const body = new Uint8Array(bodyPrefix.byteLength + 1 + bodySuffix.byteLength)
    body.set(bodyPrefix)
    body[bodyPrefix.byteLength] = 0xff
    body.set(bodySuffix, bodyPrefix.byteLength + 1)
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
    const frame = new Uint8Array(header.byteLength + body.byteLength)
    frame.set(header)
    frame.set(body, header.byteLength)

    expect(() => decodeFrame(frame)).toThrow(ProtocolError)
  })

  test("rejects invalid UTF-8 in the frame header", () => {
    const prefix = encoder.encode("Content-Length: 2\r\nX-Header: ")
    const suffix = encoder.encode("\r\n\r\n{}")
    const frame = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength)
    frame.set(prefix)
    frame[prefix.byteLength] = 0xff
    frame.set(suffix, prefix.byteLength + 1)

    const error = capture<ProtocolError>(() => decodeFrame(frame))
    expect(error.detail).toContain("not valid UTF-8")
  })

  test("rejects malformed headers and bodies", () => {
    expect(() => decodeFrame(encoder.encode("X-Note: hi\r\n\r\n{}"))).toThrow(ProtocolError)
    expect(() => decodeFrame(encoder.encode("Content-Length: 3\r\n\r\nnot"))).toThrow(ProtocolError)
  })

  test("encodeFrame refuses to emit an oversized frame", () => {
    const payload = {
      seq: 1,
      type: "event",
      event: "output",
      body: "x".repeat(MAX_FRAME_BYTES + 1),
    } as unknown as Envelope
    expect(() => encodeFrame(payload)).toThrow(ProtocolError)
  })
})

describe("dap.protocol message validation", () => {
  test("accepts well-formed envelopes", () => {
    expect(parseMessage({ seq: 1, type: "request", command: "threads" })).toEqual(request())
    expect(
      parseMessage({ seq: 1, type: "response", request_seq: 1, success: false, command: "evaluate", message: "no" })
        .type,
    ).toBe("response")
    expect(parseMessage({ seq: 1, type: "event", event: "stopped", body: { reason: "breakpoint" } }).type).toBe("event")
  })

  test("rejects malformed envelopes without echoing untrusted input", () => {
    for (const bad of [
      {},
      { seq: 0, type: "request", command: "threads" },
      { seq: 1, type: "request" },
      { seq: 1, type: "unknown", command: "threads" },
      { seq: 1, type: "request", command: "threads", pid: 1234 },
      { seq: 1, type: "response", request_seq: 1, success: "yes", command: "threads" },
      { seq: 1.5, type: "event", event: "x" },
      null,
      "request",
    ]) {
      const error = capture<ProtocolError>(() => parseMessage(bad))
      expect(error).toBeInstanceOf(ProtocolError)
      expect(error.detail).toBe("malformed DAP message envelope")
    }
  })

  test("rejects oversized direct messages that bypass frame decoding", () => {
    const error = capture<ProtocolError>(() =>
      parseMessage({ seq: 1, type: "request", command: "launch", arguments: { payload: "x".repeat(MAX_FRAME_BYTES) } }),
    )

    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.detail).toContain("DAP message exceeds")
  })

  test("rejects non-serializable direct message values as a typed protocol error", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    const error = capture<ProtocolError>(() =>
      parseMessage({ seq: 1, type: "request", command: "launch", arguments: circular }),
    )

    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.detail).toBe("malformed DAP message envelope")
  })

  test("encodeFrame validates envelopes at the runtime boundary", () => {
    expect(() => encodeFrame({ seq: 0, type: "request", command: "threads" } as unknown as Envelope)).toThrow(
      ProtocolError,
    )
  })
})

describe("dap.protocol command classification", () => {
  test("classifies read, control, evaluate and launch commands", () => {
    expect(classifyCommand("threads")).toBe("read")
    expect(classifyCommand("stackTrace")).toBe("read")
    expect(classifyCommand("setBreakpoints")).toBe("control")
    expect(classifyCommand("continue")).toBe("control")
    expect(classifyCommand("stepIn")).toBe("control")
    expect(classifyCommand("evaluate")).toBe("evaluate")
    expect(classifyCommand("setVariable")).toBe("evaluate")
    expect(classifyCommand("launch")).toBe("launch")
    expect(classifyCommand("attach")).toBe("launch")
    expect(classifyCommand("runInTerminal")).toBe("launch")
  })

  test("marks variable inspection conditional because adapters may invoke getters or lazy evaluation", () => {
    expect(classifyCommand("variables")).toBe("conditional_read")
  })

  test("unknown commands classify as unknown (fail-closed)", () => {
    expect(classifyCommand("vendor/customCommand")).toBe("unknown")
    expect(classifyCommand("")).toBe("unknown")
  })
})

describe("dap.protocol purity", () => {
  it.live("parsing and classifying spawn no process and download nothing", () =>
    Effect.sync(() => {
      const spawnSpy = spyOn(Bun, "spawn")
      const writeSpy = spyOn(Bun, "write")
      const fetchSpy = spyOn(globalThis, "fetch")
      try {
        const frame = encodeFrame(request(1, "runInTerminal"))
        decodeFrame(frame)
        decodeFrame(new Uint8Array(0))
        parseMessage({ seq: 9, type: "event", event: "output", body: "x" })
        capture(() => parseMessage({ seq: 0, type: "request", command: "threads" }))
        for (const command of [
          "initialize",
          "launch",
          "attach",
          "evaluate",
          "setBreakpoints",
          "threads",
          "runInTerminal",
        ]) {
          classifyCommand(command)
        }
      } finally {
        spawnSpy.mockRestore()
        writeSpy.mockRestore()
        fetchSpy.mockRestore()
      }
      expect(spawnSpy).not.toHaveBeenCalled()
      expect(writeSpy).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    }),
  )
})

describe("DAP typed HostKernel protocol contract", () => {
  test("validates a bounded operation and its exact durable dispatch receipt", () => {
    const request = validateHostOperationRequestV1(hostOperationRequest())
    expect(request).toEqual(hostOperationRequest())
    expect(validateHostDapDispatchReceiptV1(request, hostDispatchReceipt())).toMatchObject({
      requestSequence: "1",
      status: "DISPATCHED",
      hostProcessRef,
    })
  })

  test("denies launch, unsafe IDs, NUL and oversized operation arguments", () => {
    const launch = hostOperationRequest()
    ;(launch.operation as { command: string }).command = "launch"
    expect(() => validateHostOperationRequestV1(launch)).toThrow(ProtocolError)

    const badID = hostOperationRequest()
    ;(badID.operation as { requestID: number }).requestID = Number.MAX_SAFE_INTEGER + 1
    expect(() => validateHostOperationRequestV1(badID)).toThrow(ProtocolError)

    const nul = hostOperationRequest()
    ;(nul.operation as { arguments: Record<string, unknown> }).arguments = { text: "bad\u0000value" }
    expect(() => validateHostOperationRequestV1(nul)).toThrow(ProtocolError)

    const large = hostOperationRequest()
    ;(large.operation as { arguments: Record<string, unknown> }).arguments = { text: "x".repeat(MAX_FRAME_BYTES + 1) }
    expect(() => validateHostOperationRequestV1(large)).toThrow(ProtocolError)
  })

  test("rejects accessor and custom-array serialization before reading or dispatch", () => {
    let getterCalled = false
    const accessor = hostOperationRequest()
    Object.defineProperty(accessor.operation.arguments, "locale", {
      enumerable: true,
      get() {
        getterCalled = true
        return "en"
      },
    })
    expect(() => validateHostOperationRequestV1(accessor)).toThrow(ProtocolError)
    expect(getterCalled).toBe(false)

    const customArray = hostOperationRequest()
    customArray.capabilityID = "debug.breakpoint.set"
    customArray.operation.command = "setExceptionBreakpoints"
    const exceptionOptions = [{ path: [], breakMode: "always" }] as unknown[] & { toJSON?: () => unknown }
    exceptionOptions.toJSON = () => ({ injected: true })
    customArray.operation.arguments = { filters: [], exceptionOptions }
    expect(() => validateHostOperationRequestV1(customArray)).toThrow(ProtocolError)
  })

  test("binds each DAP command to its canonical Guard capability and scopes attach to a minted terminal ref", () => {
    const mismatch = hostOperationRequest()
    mismatch.capabilityID = "debug.evaluate"
    expect(() => validateHostOperationRequestV1(mismatch)).toThrow(ProtocolError)

    const attach = hostOperationRequest()
    attach.operation.command = "attach"
    attach.capabilityID = "debug.attach"
    attach.operation.arguments = { targetHostProcessRef }
    expect(validateHostOperationRequestV1(attach).operation.arguments).toEqual({ targetHostProcessRef })
    attach.operation.arguments = { targetHostProcessRef: { ...targetHostProcessRef, ownerEpoch: "8" } }
    expect(() => validateHostOperationRequestV1(attach)).toThrow(ProtocolError)
    attach.operation.arguments = { targetHostProcessRef: { ...targetHostProcessRef, generation: "3", pid: 1234 } }
    expect(() => validateHostOperationRequestV1(attach)).toThrow(ProtocolError)

    const malformed = hostOperationRequest()
    malformed.operation.command = "threads"
    malformed.operation.arguments = { threadId: 1, unexpected: true }
    expect(() => validateHostOperationRequestV1(malformed)).toThrow(ProtocolError)
  })

  test("rejects mismatched Attempt scope and page limits before projection", () => {
    const scoped = { ...hostOperationRequest(), directAttempt: {} }
    expect(() => validateHostOperationRequestV1(scoped)).toThrow(ProtocolError)

    const cursor = new HostDapEventCursorV1(hostProcessRef, "session-1", "location-1", workspaceRevision, undefined, directAttempt)
    const page = hostResponsePage()
    expect(() => validateHostEventPageV1(
      { ...cursor.readRequest(), maxEvents: 0 },
      page,
    )).toThrow(ProtocolError)
    expect(() => validateHostEventPageV1(
      { ...cursor.readRequest(), maxBytes: 1 },
      page,
    )).toThrow(ProtocolError)
  })

  test("accepts an exact durable receipt replay and rejects a conflicting sequence reuse", () => {
    const request = hostOperationRequest()
    const journal = new HostDapProtocolJournalV1(hostProcessRef, workspaceRevision)
    const receipt = hostDispatchReceipt()
    journal.acceptOperation(request, receipt)
    expect(journal.acceptOperation(request, receipt)).toEqual(receipt)
    expect(journal.quarantined).toBe(false)

    const other = new HostDapProtocolJournalV1(hostProcessRef, workspaceRevision)
    other.acceptOperation(request, receipt)
    const conflicting = hostOperationRequest()
    conflicting.operation = { ...conflicting.operation, requestID: 2 }
    expect(() => other.acceptOperation(conflicting, receipt)).toThrow(ResnapshotRequiredError)
    expect(other.quarantined).toBe(true)
  })

  test("quarantines an outbound sequence gap", () => {
    const journal = new HostDapProtocolJournalV1(hostProcessRef, workspaceRevision)
    const skipped = hostOperationRequest()
    skipped.operation = { ...skipped.operation, requestSequence: "2" }
    expect(() => journal.acceptOperation(skipped, hostDispatchReceipt("2"))).toThrow(ResnapshotRequiredError)
    expect(journal.quarantined).toBe(true)
  })

  test("binds response events to the dispatched DAP request and suppresses exact page replay", () => {
    const request = hostOperationRequest()
    const journal = new HostDapProtocolJournalV1(hostProcessRef, workspaceRevision)
    journal.acceptOperation(request, hostDispatchReceipt())

    const cursor = new HostDapEventCursorV1(hostProcessRef, "session-1", "location-1", workspaceRevision, undefined, directAttempt)
    const page = hostResponsePage()
    const accepted = cursor.accept(page)
    expect(accepted.events).toHaveLength(1)
    journal.acceptPage(accepted)
    expect(journal.quarantined).toBe(false)
    const replay = cursor.accept(page)
    expect(replay.events).toHaveLength(0)
    expect(() => journal.acceptPage(replay)).not.toThrow()
    expect(journal.quarantined).toBe(false)
  })

  test("quarantines stale or mismatched response sequences", () => {
    const request = hostOperationRequest()
    const journal = new HostDapProtocolJournalV1(hostProcessRef, workspaceRevision)
    journal.acceptOperation(request, hostDispatchReceipt())
    const cursor = new HostDapEventCursorV1(hostProcessRef, "session-1", "location-1", workspaceRevision, undefined, directAttempt)
    const badPage = {
      ...hostResponsePage(),
      events: [
        {
          protocol: "dap",
          messageKind: "response",
          payload: { ...hostResponsePage().events[0].payload, requestSequence: "2" },
        },
      ],
    }
    const accepted = cursor.accept(badPage)
    expect(() => journal.acceptPage(accepted)).toThrow(ResnapshotRequiredError)
    expect(journal.quarantined).toBe(true)
  })

  test("the protocol journal rejects a cursor skip even when a caller bypasses the event cursor", () => {
    const journal = new HostDapProtocolJournalV1(hostProcessRef, workspaceRevision)
    expect(() => journal.acceptPage({
      ...hostResponsePage(),
      afterEventSequence: "1",
      events: [],
    })).toThrow(ResnapshotRequiredError)
    expect(journal.quarantined).toBe(true)
  })
})
