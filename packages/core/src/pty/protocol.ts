export * as PtyProtocol from "./protocol"

// Wire protocol for PTY websocket transports. The PTY domain service is transport-free; server
// routes adapt Pty.attach to websockets with these helpers so every surface speaks one protocol.
//
// Outbound frames are raw UTF-8 terminal chunks. One control frame — a 0x00 byte followed by
// UTF-8 JSON — carries the absolute output cursor after replay so clients can resume later.

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

// Replay can be megabytes; send it in bounded frames.
export const REPLAY_CHUNK = 64 * 1024

export function metaFrame(cursor: number) {
  const bytes = encoder.encode(JSON.stringify({ cursor }))
  const out = new Uint8Array(bytes.length + 1)
  out[0] = 0
  out.set(bytes, 1)
  return out
}

export function chunks(data: string) {
  const out: string[] = []
  for (let i = 0; i < data.length; i += REPLAY_CHUNK) out.push(data.slice(i, i + REPLAY_CHUNK))
  return out
}

// Inbound client frames are UTF-8 text or binary; invalid UTF-8 input is dropped.
export function decodeInput(message: string | Uint8Array | ArrayBuffer) {
  if (typeof message === "string") return message
  try {
    return decoder.decode(message instanceof ArrayBuffer ? new Uint8Array(message) : message)
  } catch {
    return undefined
  }
}

// Binary frame layout for the `horizon.terminal.v1` subprotocol. Both the renderer and the
// server speak this one encoding: a 4-byte magic, version, kind, then big-endian sequence and
// cursor, then the payload length and bytes. `kind` distinguishes output, gap and control
// frames in both directions.
export const TERMINAL_FRAME_MAGIC = [0x48, 0x50, 0x54, 0x59] as const
export const TERMINAL_FRAME_HEADER_BYTES = 26
export const TERMINAL_OUTPUT_MAX_BYTES = 64 * 1024
export const TERMINAL_INPUT_MAX_BYTES = 16 * 1024
export const TERMINAL_FRAME_OUTPUT = 0x01
export const TERMINAL_FRAME_GAP = 0x03
export const TERMINAL_FRAME_EXIT = 0x04
export const TERMINAL_FRAME_ENDED = 0x05
export const TERMINAL_FRAME_INPUT = 0x10
export const TERMINAL_FRAME_RESIZE = 0x11
export const TERMINAL_SOCKET_QUEUE_MAX_BYTES = 2 * 1024 * 1024

export function withinTerminalBackpressureLimit(bufferedAmount: number, nextFrameBytes: number) {
  return (
    Number.isSafeInteger(bufferedAmount) &&
    Number.isSafeInteger(nextFrameBytes) &&
    bufferedAmount >= 0 &&
    nextFrameBytes >= 0 &&
    bufferedAmount + nextFrameBytes <= TERMINAL_SOCKET_QUEUE_MAX_BYTES
  )
}

export type TerminalFrame = {
  version: 1
  kind: number
  sequence: number
  cursor: number
  payload: Uint8Array
}

export function decodeTerminalFrame(value: ArrayBuffer): TerminalFrame {
  const bytes = new Uint8Array(value)
  if (bytes.byteLength < TERMINAL_FRAME_HEADER_BYTES) throw new Error("Truncated terminal frame")
  for (const [index, byte] of TERMINAL_FRAME_MAGIC.entries()) {
    if (bytes[index] !== byte) throw new Error("Invalid terminal frame magic")
  }
  const view = new DataView(value)
  const version = view.getUint8(4)
  if (version !== 1) throw new Error("Unsupported terminal frame version")
  const kind = view.getUint8(5)
  const sequence = Number(view.getBigUint64(6, false))
  const cursor = Number(view.getBigUint64(14, false))
  const length = view.getUint32(22, false)
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(cursor)) throw new Error("Unsafe terminal frame cursor")
  if (length !== bytes.byteLength - TERMINAL_FRAME_HEADER_BYTES) throw new Error("Invalid terminal frame length")
  const payload = bytes.subarray(TERMINAL_FRAME_HEADER_BYTES)
  if (kind === TERMINAL_FRAME_OUTPUT && payload.byteLength > TERMINAL_OUTPUT_MAX_BYTES) {
    throw new Error("Terminal output frame is too large")
  }
  return { version: 1, kind, sequence, cursor, payload }
}

export function encodeTerminalFrame(input: {
  kind: number
  sequence: number
  cursor: number
  payload?: Uint8Array
}): ArrayBuffer {
  const payload = input.payload ?? new Uint8Array()
  const limit = input.kind === TERMINAL_FRAME_INPUT ? TERMINAL_INPUT_MAX_BYTES : TERMINAL_OUTPUT_MAX_BYTES
  if (payload.byteLength > limit) throw new Error("Terminal frame payload is too large")
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new Error("Invalid terminal frame sequence")
  if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) throw new Error("Invalid terminal frame cursor")
  const bytes = new Uint8Array(TERMINAL_FRAME_HEADER_BYTES + payload.byteLength)
  bytes.set([...TERMINAL_FRAME_MAGIC, 1, input.kind], 0)
  const view = new DataView(bytes.buffer)
  view.setBigUint64(6, BigInt(input.sequence), false)
  view.setBigUint64(14, BigInt(input.cursor), false)
  view.setUint32(22, payload.byteLength, false)
  bytes.set(payload, TERMINAL_FRAME_HEADER_BYTES)
  return bytes.buffer
}

export function outputFrame(input: { sequence: number; cursor: number; payload: Uint8Array }) {
  return encodeTerminalFrame({ kind: TERMINAL_FRAME_OUTPUT, ...input })
}

export function gapFrame(input: { sequence: number; cursor: number; payload?: Uint8Array }) {
  return encodeTerminalFrame({ kind: TERMINAL_FRAME_GAP, ...input })
}

export function exitFrame(input: { sequence: number; cursor: number; ended?: boolean; payload?: Uint8Array }) {
  return encodeTerminalFrame({
    kind: input.ended ? TERMINAL_FRAME_ENDED : TERMINAL_FRAME_EXIT,
    sequence: input.sequence,
    cursor: input.cursor,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  })
}
