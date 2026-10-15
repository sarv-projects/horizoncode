import { describe, expect, test } from "bun:test"
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_FRAME_HEADER_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_SOCKET_QUEUE_MAX_BYTES,
  utf8Length,
  withinTerminalBackpressureLimit,
} from "./terminal-protocol"

describe("terminal binary protocol", () => {
  test("round-trips frame metadata and preserves opaque payload bytes", () => {
    const payload = new TextEncoder().encode("a💡")
    const frame = decodeTerminalFrame(
      encodeTerminalFrame({ kind: 0x01, sequence: 7, cursor: 5, payload }),
    )
    expect(frame).toMatchObject({ version: 1, kind: 0x01, sequence: 7, cursor: 5 })
    expect([...frame.payload]).toEqual([...payload])
    expect(utf8Length("a💡")).toBe(5)
  })

  test("rejects malformed lengths and oversized input frames", () => {
    const valid = encodeTerminalFrame({ kind: 0x10, sequence: 1, cursor: 0, payload: new Uint8Array([65]) })
    const truncated = valid.slice(0, TERMINAL_FRAME_HEADER_BYTES)
    new DataView(truncated).setUint32(22, 2, false)
    expect(() => decodeTerminalFrame(truncated)).toThrow("Invalid terminal frame length")
    expect(() =>
      encodeTerminalFrame({
        kind: 0x10,
        sequence: 1,
        cursor: 0,
        payload: new Uint8Array(TERMINAL_INPUT_MAX_BYTES + 1),
      }),
    ).toThrow("Terminal frame payload is too large")
  })

  test("bounds queued terminal client output at two mebibytes", () => {
    expect(withinTerminalBackpressureLimit(0, TERMINAL_SOCKET_QUEUE_MAX_BYTES)).toBe(true)
    expect(withinTerminalBackpressureLimit(1, TERMINAL_SOCKET_QUEUE_MAX_BYTES)).toBe(false)
    expect(withinTerminalBackpressureLimit(TERMINAL_SOCKET_QUEUE_MAX_BYTES, 0)).toBe(true)
    expect(withinTerminalBackpressureLimit(0, -1)).toBe(false)
    expect(withinTerminalBackpressureLimit(Number.NaN, 1)).toBe(false)
  })
})
