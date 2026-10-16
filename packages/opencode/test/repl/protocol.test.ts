import { describe, expect, spyOn, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import {
  DEFAULT_IDLE_TTL_MS,
  MAX_CALLBACK_CAPABILITIES,
  MAX_CODE_BYTES,
  MAX_DEADLINE_MS,
  MAX_IDLE_TTL_MS,
  MAX_MEMORY_BYTES,
  MAX_OUTPUT_BYTES,
  ProtocolError,
  parseExecuteRequest,
  parseExecuteResult,
  parseStartRequest,
  validateIdleTtl,
} from "@/repl/protocol"

function capture<T = Record<string, unknown>>(fn: () => unknown): T {
  try {
    fn()
  } catch (error) {
    return error as T
  }
  throw new Error("expected call to throw")
}

const start = (over: Record<string, unknown> = {}) => ({
  language: "python",
  scope: "workspace://ws-1",
  resourceLimits: { maxMemoryBytes: 512 * 1024 * 1024, maxWallTimeMs: 30_000, maxOutputBytes: 1024 * 1024 },
  callbackCapabilities: ["files.read"],
  ...over,
})

function replSourceFiles(): string[] {
  const dir = path.join(import.meta.dir, "../../src/repl")
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(dir, entry))
}

describe("repl.protocol start requests", () => {
  test("accepts a bounded Python-first start request", () => {
    const request = parseStartRequest(start())
    expect(request.language).toBe("python")
    expect(request.callbackCapabilities).toEqual(["files.read"])
  })

  test("rejects malformed and out-of-bounds start requests", () => {
    expect(capture<ProtocolError>(() => parseStartRequest({})).detail).toBe("malformed repl.start request")
    expect(() => parseStartRequest(start({ language: "ruby" }))).toThrow(ProtocolError)
    expect(() => parseStartRequest(start({ resourceLimits: { maxMemoryBytes: MAX_MEMORY_BYTES + 1, maxWallTimeMs: 1000, maxOutputBytes: 1024 } }))).toThrow(
      ProtocolError,
    )
    expect(() => parseStartRequest(start({ resourceLimits: { maxMemoryBytes: 1024, maxWallTimeMs: MAX_DEADLINE_MS + 1, maxOutputBytes: 1024 } }))).toThrow(
      ProtocolError,
    )
    expect(() => parseStartRequest(start({ resourceLimits: { maxMemoryBytes: 1024, maxWallTimeMs: 1000, maxOutputBytes: MAX_OUTPUT_BYTES + 1 } }))).toThrow(
      ProtocolError,
    )
    const tooManyCallbacks = capture<ProtocolError>(() =>
      parseStartRequest(start({ callbackCapabilities: Array.from({ length: MAX_CALLBACK_CAPABILITIES + 1 }, (_, i) => `cap.${i}`) })),
    )
    expect(tooManyCallbacks).toBeInstanceOf(ProtocolError)
  })
})

describe("repl.protocol execute envelopes", () => {
  test("accepts a bounded execute request", () => {
    const request = parseExecuteRequest({ generation: 1, code: "print('hi')", deadlineMs: 10_000 })
    expect(request).toEqual({ generation: 1, code: "print('hi')", deadlineMs: 10_000 })
  })

  test("rejects oversized code, empty code and out-of-range deadlines", () => {
    expect(() => parseExecuteRequest({ generation: 1, code: "x".repeat(MAX_CODE_BYTES + 1), deadlineMs: 1000 })).toThrow(
      ProtocolError,
    )
    expect(() => parseExecuteRequest({ generation: 1, code: "x", deadlineMs: 1 })).toThrow(ProtocolError)
    expect(() => parseExecuteRequest({ generation: 0, code: "x", deadlineMs: 1000 })).toThrow(ProtocolError)
    expect(() => parseExecuteRequest(null)).toThrow(ProtocolError)
  })

  test("accepts a bounded result and requires truncation flags to be explicit", () => {
    const result = parseExecuteResult({
      generation: 1,
      status: "ok",
      value: "3",
      stdout: "hi\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    expect(result.status).toBe("ok")
  })

  test("rejects flooding results instead of buffering them", () => {
    const error = capture<ProtocolError>(() =>
      parseExecuteResult({
        generation: 1,
        status: "ok",
        stdout: "x".repeat(MAX_OUTPUT_BYTES + 1),
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
      }),
    )
    expect(error.detail).toContain("exceeds")
  })

  test("rejects unknown statuses and malformed result envelopes", () => {
    expect(() =>
      parseExecuteResult({ generation: 1, status: "hacked", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
    ).toThrow(ProtocolError)
  })

  test("idle TTL is bounded", () => {
    expect(validateIdleTtl(DEFAULT_IDLE_TTL_MS)).toBe(DEFAULT_IDLE_TTL_MS)
    expect(() => validateIdleTtl(500)).toThrow(ProtocolError)
    expect(() => validateIdleTtl(MAX_IDLE_TTL_MS + 1)).toThrow(ProtocolError)
    expect(() => validateIdleTtl(1.5)).toThrow(ProtocolError)
  })
})

describe("repl.protocol purity", () => {
  test("repl sources import no process, network or download machinery", () => {
    const forbidden = [
      /\bchild_process\b/,
      /\bcross-spawn\b/,
      /["']@\/util\/(?:process|archive)["']/,
      /\bBun\.spawn\b/,
      /\bBun\.\$\b/,
      /\bfetch\s*\(/,
      /\bnode:(?:net|http|https|dgram|worker_threads)["']/,
      /\bNpm\b/,
    ]
    const files = replSourceFiles()
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      for (const pattern of forbidden) expect(source).not.toMatch(pattern)
    }
  })

  test("parsing envelopes spawns no process and writes nothing", () => {
    const spawnSpy = spyOn(Bun, "spawn")
    const writeSpy = spyOn(Bun, "write")
    const fetchSpy = spyOn(globalThis, "fetch")
    try {
      parseStartRequest(start())
      parseExecuteRequest({ generation: 1, code: "1 + 1", deadlineMs: 1000 })
      parseExecuteResult({ generation: 1, status: "ok", stdout: "2", stderr: "", stdoutTruncated: false, stderrTruncated: false })
      capture(() => parseStartRequest({}))
      capture(() => parseExecuteRequest({}))
      capture(() => parseExecuteResult({}))
      validateIdleTtl(DEFAULT_IDLE_TTL_MS)
    } finally {
      spawnSpy.mockRestore()
      writeSpy.mockRestore()
      fetchSpy.mockRestore()
    }
  })
})
