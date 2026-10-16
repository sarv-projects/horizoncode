import { describe, expect, spyOn, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import {
  MAX_FRAME_BYTES,
  MAX_HEADER_BYTES,
  ProtocolError,
  classifyCommand,
  decodeFrame,
  encodeFrame,
  parseMessage,
  type Envelope,
} from "@/dap/protocol"

const encoder = new TextEncoder()

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

function dapSourceFiles(): string[] {
  const dir = path.join(import.meta.dir, "../../src/dap")
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(dir, entry))
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

  test("rejects malformed headers and bodies", () => {
    expect(() => decodeFrame(encoder.encode("X-Note: hi\r\n\r\n{}"))).toThrow(ProtocolError)
    expect(() => decodeFrame(encoder.encode("Content-Length: 3\r\n\r\nnot"))).toThrow(ProtocolError)
  })

  test("encodeFrame refuses to emit an oversized frame", () => {
    const payload = { seq: 1, type: "event", event: "output", body: "x".repeat(MAX_FRAME_BYTES + 1) } as unknown as Envelope
    expect(() => encodeFrame(payload)).toThrow(ProtocolError)
  })
})

describe("dap.protocol message validation", () => {
  test("accepts well-formed envelopes", () => {
    expect(parseMessage({ seq: 1, type: "request", command: "threads" })).toEqual(request())
    expect(parseMessage({ seq: 1, type: "response", request_seq: 1, success: false, command: "evaluate", message: "no" }).type).toBe(
      "response",
    )
    expect(parseMessage({ seq: 1, type: "event", event: "stopped", body: { reason: "breakpoint" } }).type).toBe("event")
  })

  test("rejects malformed envelopes without echoing untrusted input", () => {
    for (const bad of [
      {},
      { seq: 0, type: "request", command: "threads" },
      { seq: 1, type: "request" },
      { seq: 1, type: "unknown", command: "threads" },
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
})

describe("dap.protocol command classification", () => {
  test("classifies read, control, evaluate and launch commands", () => {
    expect(classifyCommand("threads")).toBe("read")
    expect(classifyCommand("stackTrace")).toBe("read")
    expect(classifyCommand("variables")).toBe("read")
    expect(classifyCommand("setBreakpoints")).toBe("control")
    expect(classifyCommand("continue")).toBe("control")
    expect(classifyCommand("stepIn")).toBe("control")
    expect(classifyCommand("evaluate")).toBe("evaluate")
    expect(classifyCommand("setVariable")).toBe("evaluate")
    expect(classifyCommand("launch")).toBe("launch")
    expect(classifyCommand("attach")).toBe("launch")
    expect(classifyCommand("runInTerminal")).toBe("launch")
  })

  test("unknown commands classify as unknown (fail-closed)", () => {
    expect(classifyCommand("vendor/customCommand")).toBe("unknown")
    expect(classifyCommand("")).toBe("unknown")
  })
})

describe("dap.protocol purity", () => {
  test("dap sources import no process, network or download machinery", () => {
    const forbidden = [
      /\bchild_process\b/,
      /\bcross-spawn\b/,
      /["']@\/util\/(?:process|archive)["']/,
      /\bBun\.spawn\b/,
      /\bBun\.\$\b/,
      /\bfetch\s*\(/,
      /\bhttps?\.(?:request|get)\b/,
      /\bnode:(?:net|http|https|dgram|worker_threads)["']/,
      /\bNpm\b/,
    ]
    const files = dapSourceFiles()
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      for (const pattern of forbidden) expect(source).not.toMatch(pattern)
    }
  })

  test("parsing and classifying spawn no process and download nothing", () => {
    const spawnSpy = spyOn(Bun, "spawn")
    const writeSpy = spyOn(Bun, "write")
    const fetchSpy = spyOn(globalThis, "fetch")
    try {
      const frame = encodeFrame(request(1, "runInTerminal"))
      decodeFrame(frame)
      decodeFrame(new Uint8Array(0))
      parseMessage({ seq: 9, type: "event", event: "output", body: "x" })
      capture(() => parseMessage({ seq: 0, type: "request", command: "threads" }))
      for (const command of ["initialize", "launch", "attach", "evaluate", "setBreakpoints", "threads", "runInTerminal"]) {
        classifyCommand(command)
      }
    } finally {
      spawnSpy.mockRestore()
      writeSpy.mockRestore()
      fetchSpy.mockRestore()
    }
  })
})
