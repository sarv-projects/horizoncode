// The binary terminal frame codec is owned by the transport-free protocol module in core so the
// renderer and the server speak exactly one encoding.
export {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_FRAME_HEADER_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_OUTPUT_MAX_BYTES,
  TERMINAL_FRAME_OUTPUT,
  TERMINAL_FRAME_GAP,
  TERMINAL_FRAME_EXIT,
  TERMINAL_FRAME_ENDED,
  TERMINAL_FRAME_INPUT,
  TERMINAL_FRAME_RESIZE,
  TERMINAL_SOCKET_QUEUE_MAX_BYTES,
  withinTerminalBackpressureLimit,
  type TerminalFrame,
} from "@opencode-ai/core/pty/protocol"

export const TERMINAL_PROTOCOL = "horizon.terminal.v1"

const encoder = new TextEncoder()

export function encodeTerminalText(value: string) {
  return encoder.encode(value)
}

export function utf8Length(value: string) {
  return encoder.encode(value).byteLength
}
