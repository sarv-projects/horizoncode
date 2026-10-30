import { describe, expect, test } from "bun:test"
import { PtyProtocol } from "@horizoncode/core/pty/protocol"

describe("pty protocol", () => {
  test("drops invalid binary input frames and decodes valid ones", () => {
    expect(PtyProtocol.decodeInput("ready")).toBe("ready")
    expect(PtyProtocol.decodeInput(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeUndefined()
    expect(PtyProtocol.decodeInput(new TextEncoder().encode("hello"))).toBe("hello")
    expect(PtyProtocol.decodeInput(new TextEncoder().encode("hello").buffer)).toBe("hello")
  })

  test("encodes the cursor as a 0x00-prefixed JSON control frame", () => {
    const frame = PtyProtocol.metaFrame(42)
    expect(frame[0]).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(1)))).toEqual({ cursor: 42 })
  })

  test("splits replay into bounded frames", () => {
    expect(PtyProtocol.chunks("")).toEqual([])
    expect(PtyProtocol.chunks("abc")).toEqual(["abc"])
    const big = "x".repeat(PtyProtocol.REPLAY_CHUNK + 1)
    const frames = PtyProtocol.chunks(big)
    expect(frames.length).toBe(2)
    expect(frames[0].length).toBe(PtyProtocol.REPLAY_CHUNK)
    expect(frames.join("")).toBe(big)
  })

  test("round-trips a bounded binary output frame", () => {
    const payload = new TextEncoder().encode("frame output")
    const frame = PtyProtocol.outputFrame({ sequence: 7, cursor: 42, payload })
    expect(PtyProtocol.decodeTerminalFrame(frame)).toEqual({
      version: 1,
      kind: PtyProtocol.TERMINAL_FRAME_OUTPUT,
      sequence: 7,
      cursor: 42,
      payload,
    })
  })

  test("rejects malformed, oversized, and unsafe binary frames", () => {
    const valid = PtyProtocol.outputFrame({ sequence: 1, cursor: 2, payload: new Uint8Array([1]) })
    expect(() => PtyProtocol.decodeTerminalFrame(valid.slice(0, PtyProtocol.TERMINAL_FRAME_HEADER_BYTES - 1))).toThrow(
      "Truncated terminal frame",
    )

    const badMagic = valid.slice(0)
    new Uint8Array(badMagic)[0] ^= 0xff
    expect(() => PtyProtocol.decodeTerminalFrame(badMagic)).toThrow("Invalid terminal frame magic")

    const badVersion = valid.slice(0)
    new Uint8Array(badVersion)[4] = 2
    expect(() => PtyProtocol.decodeTerminalFrame(badVersion)).toThrow("Unsupported terminal frame version")

    const badLength = valid.slice(0)
    new DataView(badLength).setUint32(22, 2, false)
    expect(() => PtyProtocol.decodeTerminalFrame(badLength)).toThrow("Invalid terminal frame length")

    const unsafeSequence = valid.slice(0)
    new DataView(unsafeSequence).setBigUint64(6, BigInt(Number.MAX_SAFE_INTEGER) + 1n, false)
    expect(() => PtyProtocol.decodeTerminalFrame(unsafeSequence)).toThrow("Unsafe terminal frame cursor")

    const tooLarge = new Uint8Array(PtyProtocol.TERMINAL_FRAME_HEADER_BYTES + PtyProtocol.TERMINAL_OUTPUT_MAX_BYTES + 1)
    tooLarge.set([...PtyProtocol.TERMINAL_FRAME_MAGIC, 1, PtyProtocol.TERMINAL_FRAME_OUTPUT])
    new DataView(tooLarge.buffer).setBigUint64(6, 1n, false)
    new DataView(tooLarge.buffer).setBigUint64(14, 1n, false)
    new DataView(tooLarge.buffer).setUint32(22, tooLarge.byteLength - PtyProtocol.TERMINAL_FRAME_HEADER_BYTES, false)
    expect(() => PtyProtocol.decodeTerminalFrame(tooLarge.buffer)).toThrow("Terminal output frame is too large")

    const oversizedInput = new Uint8Array(PtyProtocol.TERMINAL_FRAME_HEADER_BYTES + PtyProtocol.TERMINAL_INPUT_MAX_BYTES + 1)
    oversizedInput.set([...PtyProtocol.TERMINAL_FRAME_MAGIC, 1, PtyProtocol.TERMINAL_FRAME_INPUT])
    new DataView(oversizedInput.buffer).setBigUint64(6, 1n, false)
    new DataView(oversizedInput.buffer).setBigUint64(14, 1n, false)
    new DataView(oversizedInput.buffer).setUint32(22, oversizedInput.byteLength - PtyProtocol.TERMINAL_FRAME_HEADER_BYTES, false)
    expect(() => PtyProtocol.decodeTerminalFrame(oversizedInput.buffer)).toThrow("Terminal input frame is too large")

  })

  test("rejects unknown binary frame kinds on decode and encode", () => {
    const unknownKind = PtyProtocol.outputFrame({ sequence: 1, cursor: 1, payload: new Uint8Array() })
    new Uint8Array(unknownKind)[5] = 0x7f
    expect(() => PtyProtocol.decodeTerminalFrame(unknownKind)).toThrow("Invalid terminal frame kind")
    expect(() => PtyProtocol.encodeTerminalFrame({ kind: 0x7f, sequence: 1, cursor: 1 })).toThrow(
      "Invalid terminal frame kind",
    )
  })

  test("bounds encoded input, sequence, cursor, and socket backpressure", () => {
    expect(() => PtyProtocol.encodeTerminalFrame({
      kind: PtyProtocol.TERMINAL_FRAME_INPUT,
      sequence: 1,
      cursor: 1,
      payload: new Uint8Array(PtyProtocol.TERMINAL_INPUT_MAX_BYTES + 1),
    })).toThrow("Terminal frame payload is too large")
    expect(() => PtyProtocol.outputFrame({ sequence: -1, cursor: 0, payload: new Uint8Array() })).toThrow(
      "Invalid terminal frame sequence",
    )
    expect(() => PtyProtocol.outputFrame({ sequence: 0, cursor: Number.MAX_SAFE_INTEGER + 1, payload: new Uint8Array() })).toThrow(
      "Invalid terminal frame cursor",
    )

    expect(PtyProtocol.withinTerminalBackpressureLimit(0, PtyProtocol.TERMINAL_SOCKET_QUEUE_MAX_BYTES)).toBe(true)
    expect(PtyProtocol.withinTerminalBackpressureLimit(1, PtyProtocol.TERMINAL_SOCKET_QUEUE_MAX_BYTES)).toBe(false)
    expect(PtyProtocol.withinTerminalBackpressureLimit(Number.NaN, 1)).toBe(false)
    expect(PtyProtocol.withinTerminalBackpressureLimit(-1, 1)).toBe(false)
    expect(PtyProtocol.withinTerminalBackpressureLimit(0, Number.POSITIVE_INFINITY)).toBe(false)
  })

  test("accepts payloads and queue frames exactly at their configured limits", () => {
    const input = new Uint8Array(PtyProtocol.TERMINAL_INPUT_MAX_BYTES)
    const encodedInput = PtyProtocol.encodeTerminalFrame({
      kind: PtyProtocol.TERMINAL_FRAME_INPUT,
      sequence: 1,
      cursor: 0,
      payload: input,
    })
    expect(PtyProtocol.decodeTerminalFrame(encodedInput).payload.byteLength).toBe(PtyProtocol.TERMINAL_INPUT_MAX_BYTES)

    const output = new Uint8Array(PtyProtocol.TERMINAL_OUTPUT_MAX_BYTES)
    const encodedOutput = PtyProtocol.outputFrame({ sequence: 1, cursor: 0, payload: output })
    expect(PtyProtocol.decodeTerminalFrame(encodedOutput).payload.byteLength).toBe(PtyProtocol.TERMINAL_OUTPUT_MAX_BYTES)

    expect(
      PtyProtocol.withinTerminalBackpressureLimit(
        PtyProtocol.TERMINAL_SOCKET_QUEUE_MAX_BYTES - encodedOutput.byteLength,
        encodedOutput.byteLength,
      ),
    ).toBe(true)
  })
})
