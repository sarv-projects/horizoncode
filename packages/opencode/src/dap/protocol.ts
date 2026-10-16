import { Schema } from "effect"

/**
 * Debug Adapter Protocol (DAP) message parsing/validation — non-effectful
 * preparation for `DebugAdapterBrokerV1` (§37.7, §32.28).
 *
 * This module only parses, validates and classifies protocol messages and
 * frames. It must never spawn a debug adapter, download/install one, send a
 * `runInTerminal` command or evaluate anything; those are effects and remain
 * UNAVAILABLE until the Rust Guard/ExecutionHost mediation for this origin is
 * implemented and verified (see `./session`).
 *
 * Framing follows the DAP stdio wire format: `Content-Length: <bytes>\r\n\r\n`
 * followed by one JSON envelope. Frames are bounded so a hostile or corrupt
 * adapter stream cannot make the client buffer without limit.
 */

export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_HEADER_BYTES = 8 * 1024

export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("DAPProtocolError", {
  detail: Schema.String,
}) {}

const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const Request = Schema.Struct({
  seq: Seq,
  type: Schema.Literal("request"),
  command: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
}).annotate({ identifier: "DAPRequestV1" })
export type Request = typeof Request.Type

export const Response = Schema.Struct({
  seq: Seq,
  type: Schema.Literal("response"),
  request_seq: Seq,
  success: Schema.Boolean,
  command: Schema.String,
  message: Schema.optional(Schema.String),
  body: Schema.optional(Schema.Unknown),
}).annotate({ identifier: "DAPResponseV1" })
export type Response = typeof Response.Type

export const Event = Schema.Struct({
  seq: Seq,
  type: Schema.Literal("event"),
  event: Schema.String,
  body: Schema.optional(Schema.Unknown),
}).annotate({ identifier: "DAPEventV1" })
export type Event = typeof Event.Type

export const Envelope = Schema.Union([Request, Response, Event]).annotate({ identifier: "DAPEnvelopeV1" })
export type Envelope = typeof Envelope.Type

const decodeEnvelope = Schema.decodeUnknownSync(Envelope)

/**
 * Validate one decoded JSON value as a DAP envelope. Untrusted input never
 * leaks into the error: failures are reported as a bounded typed error.
 */
export function parseMessage(input: unknown): Envelope {
  try {
    return decodeEnvelope(input)
  } catch {
    throw new ProtocolError({ detail: "malformed DAP message envelope" })
  }
}

/**
 * Effect classification for a DAP command name. Anything unrecognized is
 * `"unknown"`, which is fail-closed: callers must not dispatch it.
 */
export const CommandClass = Schema.Literals(["read", "control", "evaluate", "launch", "unknown"])
export type CommandClass = typeof CommandClass.Type

const READ_COMMANDS: ReadonlySet<string> = new Set([
  "threads",
  "stackTrace",
  "scopes",
  "variables",
  "source",
  "sources",
  "modules",
  "loadedSources",
  "breakpointLocations",
  "dataBreakpointInfo",
  "disassemble",
  "exceptionInfo",
  "completions",
  "gotoTargets",
])

const CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  "continue",
  "next",
  "stepIn",
  "stepOut",
  "stepBack",
  "reverseContinue",
  "pause",
  "restart",
  "restartFrame",
  "terminate",
  "terminateThreads",
  "disconnect",
  "cancel",
  "configurationDone",
  "setBreakpoints",
  "setFunctionBreakpoints",
  "setExceptionBreakpoints",
  "setDataBreakpoints",
  "setInstructionBreakpoints",
])

const EVALUATE_COMMANDS: ReadonlySet<string> = new Set(["evaluate", "setVariable", "setExpression"])

const LAUNCH_COMMANDS: ReadonlySet<string> = new Set([
  "initialize",
  "launch",
  "attach",
  "runInTerminal",
  "startDebugging",
])

export function classifyCommand(command: string): CommandClass {
  if (LAUNCH_COMMANDS.has(command)) return "launch"
  if (EVALUATE_COMMANDS.has(command)) return "evaluate"
  if (CONTROL_COMMANDS.has(command)) return "control"
  if (READ_COMMANDS.has(command)) return "read"
  return "unknown"
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const HEADER_TERMINATOR = [13, 10, 13, 10] as const

function indexOfSequence(input: Uint8Array, sequence: readonly number[], from = 0): number {
  outer: for (let i = from; i <= input.length - sequence.length; i++) {
    for (let j = 0; j < sequence.length; j++) {
      if (input[i + j] !== sequence[j]) continue outer
    }
    return i
  }
  return -1
}

export interface DecodedFrame {
  readonly message: Envelope
  readonly rest: Uint8Array
}

/**
 * Encode one envelope as a bounded DAP frame.
 */
export function encodeFrame(message: Envelope): Uint8Array {
  const body = encoder.encode(JSON.stringify(message))
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError({ detail: `DAP frame exceeds ${MAX_FRAME_BYTES} bytes` })
  }
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const frame = new Uint8Array(header.byteLength + body.byteLength)
  frame.set(header, 0)
  frame.set(body, header.byteLength)
  return frame
}

/**
 * Decode the first complete frame from a buffer. Returns `null` when more
 * bytes are required (incomplete header or body) and throws `ProtocolError`
 * when the stream cannot be a valid bounded DAP frame.
 */
export function decodeFrame(input: Uint8Array): DecodedFrame | null {
  const headerEnd = indexOfSequence(input, HEADER_TERMINATOR)
  if (headerEnd === -1) {
    if (input.byteLength > MAX_HEADER_BYTES) {
      throw new ProtocolError({ detail: `DAP header exceeds ${MAX_HEADER_BYTES} bytes` })
    }
    return null
  }

  const header = decoder.decode(input.subarray(0, headerEnd))
  const match = /(?:^|\r\n)content-length:\s*(\d+)\s*(?=\r\n|$)/i.exec(header)
  if (!match) {
    throw new ProtocolError({ detail: "DAP frame is missing a Content-Length header" })
  }
  const length = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
    throw new ProtocolError({ detail: `DAP Content-Length exceeds ${MAX_FRAME_BYTES} bytes` })
  }

  const bodyStart = headerEnd + HEADER_TERMINATOR.length
  if (input.byteLength - bodyStart < length) return null

  const bodyEnd = bodyStart + length
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(input.subarray(bodyStart, bodyEnd)))
  } catch {
    throw new ProtocolError({ detail: "DAP frame body is not valid JSON" })
  }

  return { message: parseMessage(parsed), rest: input.subarray(bodyEnd) }
}

export * as DapProtocol from "./protocol"
