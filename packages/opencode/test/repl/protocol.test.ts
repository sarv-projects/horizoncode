import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import {
  DEFAULT_IDLE_TTL_MS,
  MAX_CALLBACK_CAPABILITIES,
  MAX_CODE_BYTES,
  MAX_DEADLINE_MS,
  MAX_IDLE_TTL_MS,
  MAX_MEMORY_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_ARTIFACT_REF_BYTES,
  ProtocolError,
  parseExecuteRequest,
  parseExecuteResult,
  parseCallbackRequest,
  parseCallbackResult,
  parseStartRequest,
  validateIdleTtl,
} from "@/repl/protocol"
import { it } from "../lib/effect"

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

describe("repl.protocol start requests", () => {
  test("accepts a bounded Python-first start request", () => {
    const request = parseStartRequest(start())
    expect(request.language).toBe("python")
    expect(request.callbackCapabilities).toEqual(["files.read"])
  })

  test("rejects malformed and out-of-bounds start requests", () => {
    expect(capture<ProtocolError>(() => parseStartRequest({})).detail).toBe("malformed repl.start request")
    expect(() => parseStartRequest(start({ pid: 1234 }))).toThrow(ProtocolError)
    expect(() => parseStartRequest(start({ resourceLimits: { ...start().resourceLimits, network: true } }))).toThrow(
      ProtocolError,
    )
    expect(() => parseStartRequest(start({ language: "ruby" }))).toThrow(ProtocolError)
    expect(() =>
      parseStartRequest(
        start({ resourceLimits: { maxMemoryBytes: MAX_MEMORY_BYTES + 1, maxWallTimeMs: 1000, maxOutputBytes: 1024 } }),
      ),
    ).toThrow(ProtocolError)
    expect(() =>
      parseStartRequest(
        start({ resourceLimits: { maxMemoryBytes: 1024, maxWallTimeMs: MAX_DEADLINE_MS + 1, maxOutputBytes: 1024 } }),
      ),
    ).toThrow(ProtocolError)
    expect(() =>
      parseStartRequest(
        start({ resourceLimits: { maxMemoryBytes: 1024, maxWallTimeMs: 1000, maxOutputBytes: MAX_OUTPUT_BYTES + 1 } }),
      ),
    ).toThrow(ProtocolError)
    const tooManyCallbacks = capture<ProtocolError>(() =>
      parseStartRequest(
        start({ callbackCapabilities: Array.from({ length: MAX_CALLBACK_CAPABILITIES + 1 }, (_, i) => `cap.${i}`) }),
      ),
    )
    expect(tooManyCallbacks).toBeInstanceOf(ProtocolError)
  })

  test("bounds start scope and callback capability strings by UTF-8 bytes", () => {
    expect(() => parseStartRequest(start({ scope: "é".repeat(2049) }))).toThrow(ProtocolError)
    expect(() => parseStartRequest(start({ callbackCapabilities: ["é".repeat(65)] }))).toThrow(ProtocolError)
    expect(() => parseStartRequest(start({ scope: "   " }))).toThrow(ProtocolError)
    expect(() => parseStartRequest(start({ callbackCapabilities: [""] }))).toThrow(ProtocolError)

    expect(parseStartRequest(start({ scope: "é".repeat(2048) })).scope).toBe("é".repeat(2048))
    expect(parseStartRequest(start({ callbackCapabilities: ["a".repeat(128)] })).callbackCapabilities).toEqual([
      "a".repeat(128),
    ])
  })

  test("rejects accessor-backed start fields without invoking getters", () => {
    let getterCalls = 0
    const input = start()
    Object.defineProperty(input, "scope", {
      enumerable: true,
      get: () => {
        getterCalls++
        return "workspace://ws-1"
      },
    })
    let error: unknown
    try {
      parseStartRequest(input)
    } catch (cause) {
      error = cause
    }
    expect(getterCalls).toBe(0)
    expect(error).toBeInstanceOf(ProtocolError)
  })

  test("rejects accessor-backed resource limits without invoking getters", () => {
    let getterCalls = 0
    const limits = { ...start().resourceLimits }
    Object.defineProperty(limits, "maxMemoryBytes", {
      enumerable: true,
      get: () => {
        getterCalls++
        return 512 * 1024 * 1024
      },
    })
    let error: unknown
    try {
      parseStartRequest(start({ resourceLimits: limits }))
    } catch (cause) {
      error = cause
    }
    expect(getterCalls).toBe(0)
    expect(error).toBeInstanceOf(ProtocolError)
  })

  test("rejects accessor-backed callback capability arrays without invoking getters", () => {
    let getterCalls = 0
    const callbackCapabilities = ["files.read"]
    Object.defineProperty(callbackCapabilities, "0", {
      enumerable: true,
      get: () => {
        getterCalls++
        return "files.read"
      },
    })
    let error: unknown
    try {
      parseStartRequest(start({ callbackCapabilities }))
    } catch (cause) {
      error = cause
    }
    expect(getterCalls).toBe(0)
    expect(error).toBeInstanceOf(ProtocolError)
  })

  test("callback capability declarations use unique canonical IDs only", () => {
    const duplicate = capture<ProtocolError>(() =>
      parseStartRequest(start({ callbackCapabilities: ["files.read", "files.read"] })),
    )
    expect(duplicate.detail).toBe("callback capability set contains duplicates")
    expect(() => parseStartRequest(start({ callbackCapabilities: [" Files.Read "] }))).toThrow(ProtocolError)
    expect(() => parseStartRequest(start({ callbackCapabilities: ["*"] }))).toThrow(ProtocolError)
  })
})

describe("repl.protocol execute envelopes", () => {
  test("rejects accessor-backed execute fields without invoking getters", () => {
    let getterCalls = 0
    const input = { generation: 1, code: "1", deadlineMs: 1000 }
    Object.defineProperty(input, "code", {
      enumerable: true,
      get: () => {
        getterCalls++
        return "1"
      },
    })
    let error: unknown
    try {
      parseExecuteRequest(input)
    } catch (cause) {
      error = cause
    }
    expect(getterCalls).toBe(0)
    expect(error).toBeInstanceOf(ProtocolError)
  })

  test("accepts a bounded execute request", () => {
    const request = parseExecuteRequest({ generation: 1, code: "print('hi')", deadlineMs: 10_000 })
    expect(request).toEqual({ generation: 1, code: "print('hi')", deadlineMs: 10_000 })
  })

  test("rejects oversized code, empty code and out-of-range deadlines", () => {
    expect(() =>
      parseExecuteRequest({ generation: 1, code: "x".repeat(MAX_CODE_BYTES + 1), deadlineMs: 1000 }),
    ).toThrow(ProtocolError)
    expect(() => parseExecuteRequest({ generation: 1, code: "x", deadlineMs: 1 })).toThrow(ProtocolError)
    expect(() => parseExecuteRequest({ generation: 0, code: "x", deadlineMs: 1000 })).toThrow(ProtocolError)
    expect(() => parseExecuteRequest({ generation: 1, code: "x", deadlineMs: 1000, callback: "tool.call" })).toThrow(
      ProtocolError,
    )
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

  test("rejects unknown worker result fields instead of silently stripping them", () => {
    expect(() =>
      parseExecuteResult({
        generation: 1,
        status: "ok",
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        processID: 1234,
      }),
    ).toThrow(ProtocolError)
  })

  test("counts the structured value toward the result output budget", () => {
    const error = capture<ProtocolError>(() =>
      parseExecuteResult({
        generation: 1,
        status: "ok",
        value: "x".repeat(MAX_OUTPUT_BYTES + 1),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    )
    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.detail).toContain("exceeds")
  })

  test("counts the artifact reference toward the result output budget", () => {
    expect(() =>
      parseExecuteResult({
        generation: 1,
        status: "ok",
        artifactRef: "x".repeat(MAX_OUTPUT_BYTES + 1),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).toThrow(ProtocolError)
  })

  test("rejects a present but empty artifact reference", () => {
    expect(() =>
      parseExecuteResult({
        generation: 1,
        status: "ok",
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        artifactRef: " ",
      }),
    ).toThrow(ProtocolError)
  })

  test("bounds artifact reference identifiers independently by UTF-8 bytes", () => {
    const valid = parseExecuteResult({
      generation: 1,
      status: "ok",
      artifactRef: "r".repeat(MAX_ARTIFACT_REF_BYTES),
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    expect(valid.artifactRef).toHaveLength(MAX_ARTIFACT_REF_BYTES)

    expect(() =>
      parseExecuteResult({
        generation: 1,
        status: "ok",
        artifactRef: "r".repeat(MAX_ARTIFACT_REF_BYTES + 1),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).toThrow(ProtocolError)
    expect(() =>
      parseExecuteResult({
        generation: 1,
        status: "ok",
        artifactRef: "é".repeat(Math.ceil(MAX_ARTIFACT_REF_BYTES / 2)),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).toThrow(ProtocolError)
  })

  test("requires an artifact reference when output is truncated", () => {
    for (const artifactRef of [undefined, "", "   "]) {
      expect(() =>
        parseExecuteResult({
          generation: 1,
          status: "ok",
          artifactRef,
          stdout: "partial output",
          stderr: "",
          stdoutTruncated: true,
          stderrTruncated: false,
        }),
      ).toThrow(ProtocolError)
    }
  })

  test("rejects unknown statuses and malformed result envelopes", () => {
    expect(() =>
      parseExecuteResult({
        generation: 1,
        status: "hacked",
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).toThrow(ProtocolError)
  })

  test("idle TTL is bounded", () => {
    expect(validateIdleTtl(DEFAULT_IDLE_TTL_MS)).toBe(DEFAULT_IDLE_TTL_MS)
    expect(() => validateIdleTtl(500)).toThrow(ProtocolError)
    expect(() => validateIdleTtl(MAX_IDLE_TTL_MS + 1)).toThrow(ProtocolError)
    expect(() => validateIdleTtl(1.5)).toThrow(ProtocolError)
  })
})

describe("repl.protocol callback envelopes", () => {
  test("bounds callback envelopes and binds results to exact callback identity", () => {
    const request = parseCallbackRequest({
      generation: 1,
      callbackID: "cb-1",
      capabilityID: "files.read",
      arguments: { path: "src/main.ts" },
    })
    expect(parseCallbackResult({
      generation: 1,
      callbackID: "cb-1",
      status: "ok",
      result: { contents: "ok" },
    }, request)).toMatchObject({ status: "ok", callbackID: "cb-1" })
    expect(() => parseCallbackRequest({ ...request, callbackID: "bad id" })).toThrow(ProtocolError)
    expect(() => parseCallbackResult({
      generation: 1,
      callbackID: "cb-other",
      status: "ok",
      result: null,
    }, request)).toThrow(ProtocolError)
  })
})

describe("repl.protocol purity", () => {
  it.live("parsing envelopes spawns no process and writes nothing", () =>
    Effect.sync(() => {
      const spawnSpy = spyOn(Bun, "spawn")
      const writeSpy = spyOn(Bun, "write")
      const fetchSpy = spyOn(globalThis, "fetch")
      try {
        parseStartRequest(start())
        parseExecuteRequest({ generation: 1, code: "1 + 1", deadlineMs: 1000 })
        parseExecuteResult({
          generation: 1,
          status: "ok",
          stdout: "2",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        })
        capture(() => parseStartRequest({}))
        capture(() => parseExecuteRequest({}))
        capture(() => parseExecuteResult({}))
        validateIdleTtl(DEFAULT_IDLE_TTL_MS)
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
