import type { AssistantMessage, Part, Provider, UserMessage } from "@horizoncode/sdk/v2"
import { Locale } from "./locale"
import * as Model from "./model"
import { boundToolOutput, redactToolText, sanitizeToolDisplayValue } from "./collapse-tool-output"

const MAX_TRANSCRIPT_BYTES = 1024 * 1024
const MAX_TRANSCRIPT_MESSAGES = 10_000
const MAX_TRANSCRIPT_PARTS_PER_MESSAGE = 4_096
const MAX_FORMATTED_MESSAGE_BYTES = 256 * 1024
const MAX_FORMATTED_PART_BYTES = 64 * 1024
const TRANSCRIPT_TRUNCATION_MARKER = "\n\n… transcript truncated by HorizonCode export limits …\n"
const MESSAGE_TRUNCATION_MARKER = "\n\n… message truncated by HorizonCode export limits …\n"
const TRANSCRIPT_OUTPUT_LINES = MAX_TRANSCRIPT_BYTES

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function appendBounded(chunks: string[], currentBytes: number, value: string, maxBytes: number) {
  const remaining = Math.max(0, maxBytes - currentBytes)
  if (remaining === 0) return { bytes: currentBytes, truncated: value.length > 0 }
  const bounded = boundToolOutput(value, remaining, TRANSCRIPT_OUTPUT_LINES)
  chunks.push(bounded.output)
  return { bytes: currentBytes + byteLength(bounded.output), truncated: bounded.truncated }
}

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  providers?: Provider[]
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  const providers = Model.index(options.providers)
  const contentLimit = MAX_TRANSCRIPT_BYTES - byteLength(TRANSCRIPT_TRUNCATION_MARKER)
  const chunks: string[] = []
  let usedBytes = 0
  let truncated = false
  const header = `# ${boundToolOutput(session.title, 512).output}\n\n` +
    `**Session ID:** ${boundToolOutput(session.id, 256).output}\n` +
    `**Created:** ${new Date(session.time.created).toLocaleString()}\n` +
    `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n` +
    `---\n\n`
  let appended = appendBounded(chunks, usedBytes, header, contentLimit)
  usedBytes = appended.bytes
  truncated ||= appended.truncated

  const ordered = messages.length > MAX_TRANSCRIPT_MESSAGES
    ? messages.slice(-MAX_TRANSCRIPT_MESSAGES)
    : messages
  if (messages.length > ordered.length) {
    appended = appendBounded(
      chunks,
      usedBytes,
      `\n_Export includes the latest ${MAX_TRANSCRIPT_MESSAGES} messages; ${messages.length - ordered.length} older messages were omitted._\n\n`,
      contentLimit,
    )
    usedBytes = appended.bytes
    truncated ||= appended.truncated
  }

  for (const msg of truncated ? [] : ordered.toSorted(
    (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
  )) {
    const formatted = formatMessage(msg.info, msg.parts, options, providers)
    appended = appendBounded(chunks, usedBytes, `${formatted}---\n\n`, contentLimit)
    usedBytes = appended.bytes
    if (appended.truncated) {
      truncated = true
      break
    }
  }

  if (truncated) chunks.push(TRANSCRIPT_TRUNCATION_MARKER)
  return chunks.join("")
}

export function formatMessage(
  msg: UserMessage | AssistantMessage,
  parts: Part[],
  options: TranscriptOptions,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  const contentLimit = MAX_FORMATTED_MESSAGE_BYTES - byteLength(MESSAGE_TRUNCATION_MARKER)
  const chunks: string[] = []
  let usedBytes = 0
  let truncated = false

  if (msg.role === "user") {
    const appended = appendBounded(chunks, usedBytes, `## User\n\n`, contentLimit)
    usedBytes = appended.bytes
    truncated ||= appended.truncated
  } else {
    const appended = appendBounded(
      chunks,
      usedBytes,
      formatAssistantHeader(msg, options.assistantMetadata, providers ?? options.providers),
      contentLimit,
    )
    usedBytes = appended.bytes
    truncated ||= appended.truncated
  }

  const partLimit = Math.min(parts.length, MAX_TRANSCRIPT_PARTS_PER_MESSAGE)
  for (let index = 0; !truncated && index < partLimit; index++) {
    const remaining = contentLimit - usedBytes
    if (remaining <= 0) {
      truncated = true
      break
    }
    const part = parts[index]
    if (!part) continue
    const formatted = formatPartResult(part, options, remaining)
    const appended = appendBounded(chunks, usedBytes, formatted.output, contentLimit)
    usedBytes = appended.bytes
    truncated = formatted.truncated || appended.truncated
  }

  if (parts.length > partLimit) truncated = true
  if (truncated) chunks.push(MESSAGE_TRUNCATION_MARKER)
  return chunks.join("")
}

export function formatAssistantHeader(
  msg: AssistantMessage,
  includeMetadata: boolean,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  // Provider and agent labels are metadata inputs too. Keep them bounded and
  // apply the same terminal/control and credential cleanup as message text.
  const agentName = boundToolOutput(Locale.titlecase(msg.agent), 128).output
  const modelName = boundToolOutput(Model.name(providers, msg.providerID, msg.modelID), 256).output

  return `## Assistant (${agentName} · ${modelName}${duration ? ` · ${duration}` : ""})\n\n`
}

function formatPartResult(part: Part, options: TranscriptOptions, maxBytes: number) {
  maxBytes = Math.min(maxBytes, MAX_FORMATTED_PART_BYTES)
  let result = ""
  let sourceTruncated = false
  if (part.type === "text" && !part.synthetic) {
    const suffix = "\n\n"
    const bounded = boundToolOutput(part.text, Math.max(0, maxBytes - byteLength(suffix)), TRANSCRIPT_OUTPUT_LINES)
    result = `${bounded.output}${suffix}`
    sourceTruncated = bounded.truncated
  }

  else if (part.type === "reasoning") {
    if (options.thinking) {
      const prefix = "_Thinking:_\n\n"
      const suffix = "\n\n"
      const bounded = boundToolOutput(
        part.text,
        Math.max(0, Math.min(MAX_FORMATTED_PART_BYTES, maxBytes - byteLength(prefix) - byteLength(suffix))),
        TRANSCRIPT_OUTPUT_LINES,
      )
      result = `${prefix}${bounded.output}${suffix}`
      sourceTruncated = bounded.truncated
    }
  }

  else if (part.type === "tool") {
    const safe = sanitizeToolDisplayValue(part) as typeof part | undefined
    const fallbackState = part.state.status === "pending"
      ? { ...part.state, input: {}, raw: "" }
      : part.state.status === "running"
        ? { ...part.state, input: {}, title: "Tool details unavailable", metadata: {} }
        : part.state.status === "completed"
          ? { ...part.state, input: {}, output: "Tool details unavailable", title: "Tool details unavailable", metadata: {} }
          : { ...part.state, input: {}, error: "Tool details unavailable", metadata: {} }
    const safePart = safe ?? { ...part, tool: "tool", metadata: undefined, state: fallbackState }
    result = `**Tool: ${boundToolOutput(redactToolText(safePart.tool), 128).output}**\n`
    if (options.toolDetails && safePart.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(safePart.state.input, null, 2)}\n\`\`\`\n`
    }
    if (options.toolDetails && safePart.state.status === "completed" && safePart.state.output) {
      result += `\n**Output:**\n\`\`\`\n${boundToolOutput(safePart.state.output, 64 * 1024).output}\n\`\`\`\n`
    }
    if (options.toolDetails && safePart.state.status === "error" && safePart.state.error) {
      result += `\n**Error:**\n\`\`\`\n${boundToolOutput(safePart.state.error, 64 * 1024).output}\n\`\`\`\n`
    }
    result += `\n`
  }

  const bounded = boundToolOutput(result, Math.max(0, maxBytes), TRANSCRIPT_OUTPUT_LINES)
  return { output: bounded.output, truncated: sourceTruncated || bounded.truncated }
}

export function formatPart(part: Part, options: TranscriptOptions, maxBytes = MAX_FORMATTED_PART_BYTES): string {
  return formatPartResult(part, options, maxBytes).output
}
