import stripAnsi from "strip-ansi"

const MAX_DISPLAY_BYTES = 64 * 1024
const MAX_NODES = 512
const MAX_DEPTH = 6
const MAX_KEYS = 128
const MAX_ENTRIES = 128
const SECRET_KEY = /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|authorization|auth|credential|cookie|private[-_ ]?key)/i
const PRIVATE_PAYLOAD_KEY = /(?:content|prompt|text|body|patch|source|stdout|stderr|result|data|attachment|image|buffer|env|question|todo|output|error)/i
const SAFE_ARGUMENT_KEYS = new Set([
  "background", "command", "description", "filePath", "format", "glob", "limit", "mode", "name", "offset",
  "path", "pattern", "provider", "query", "recursive", "replaceAll", "start", "startLine", "subagent_type",
  "url", "workdir",
])

function utf8Prefix(value: string, maxBytes: number) {
  let bytes = 0
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0
    const size = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
    if (bytes + size > maxBytes) break
    bytes += size
    index += size === 4 ? 2 : 1
  }
  return value.slice(0, index)
}

/** Redact credentials and terminal controls after bounding the input scan. */
export function redactToolDisplayText(value: string, maxBytes = MAX_DISPLAY_BYTES) {
  const limit = Math.max(0, Math.min(MAX_DISPLAY_BYTES, maxBytes))
  if (limit === 0) return ""
  const marker = "…[truncated]"
  // Leave room for replacements and the marker. If clipping cuts through a
  // word, discard that whole tail token so a truncated credential cannot be
  // exposed without the delimiter needed by the redaction patterns below.
  let source = utf8Prefix(value, Math.max(0, limit - 64))
  const clipped = source.length < value.length
  if (clipped) {
    const lastBoundary = Math.max(source.lastIndexOf(" "), source.lastIndexOf("\n"), source.lastIndexOf("\t"))
    source = lastBoundary < 0 ? "" : source.slice(0, lastBoundary)
  }
  let limited = stripAnsi(source)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/giu, "")
  limited = limited.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
  // A truncated PEM block has no END marker, so the complete-block expression
  // cannot match it. Remove the remainder of any such partial block as well.
  limited = limited.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/iu, "[REDACTED INCOMPLETE PRIVATE KEY]")
  limited = limited
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gu, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED JWT]")
    .replace(/(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|authorization|auth|credential|cookie|client[-_ ]?secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)?/giu, "$1[REDACTED]")
    .replace(/(--(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|cookie)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/giu, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/giu, "$1[REDACTED]@")
  const outputClipped = clipped || new TextEncoder().encode(limited).byteLength > limit
  if (!outputClipped) return limited
  const suffix = utf8Prefix(marker, limit)
  const bounded = utf8Prefix(limited, Math.max(0, limit - new TextEncoder().encode(suffix).byteLength))
  return `${bounded}${suffix}`
}

export function safeToolDisplayName(value: unknown) {
  if (typeof value !== "string" || value.length > 80 || !/^[a-z][a-z0-9_.-]{0,79}$/u.test(value)) return "tool"
  return value
}

/**
 * Produce a bounded view projection, never a tool input suitable for execution.
 * Unknown argument fields and payload-bearing fields are omitted before renderers
 * receive them; metadata keeps only bounded, recursively redacted values.
 */
export function sanitizeToolDisplayValue(value: unknown, options: { readonly arguments?: boolean; readonly maxBytes?: number } = {}) {
  const budget = { bytes: Math.max(0, Math.min(MAX_DISPLAY_BYTES, options.maxBytes ?? MAX_DISPLAY_BYTES)), nodes: MAX_NODES, keys: MAX_KEYS, entries: MAX_ENTRIES }
  const seen = new WeakSet<object>()
  const omitted = "[omitted]"
  const consume = (item: unknown, key: string | undefined, depth: number): unknown => {
    if (--budget.nodes < 0 || depth > MAX_DEPTH || budget.bytes <= 0 || budget.entries-- <= 0) return omitted
    if (key && SECRET_KEY.test(key)) return "[REDACTED]"
    if (key && PRIVATE_PAYLOAD_KEY.test(key)) return omitted
    if (typeof item === "string") {
      const clean = redactToolDisplayText(item, budget.bytes)
      budget.bytes -= new TextEncoder().encode(clean).byteLength
      return clean
    }
    if (item === null || typeof item === "boolean" || typeof item === "number") return item
    if (typeof item !== "object") return omitted
    if (seen.has(item)) return "[circular]"
    seen.add(item)
    if (Array.isArray(item)) {
      const output: unknown[] = []
      for (let index = 0; index < Math.min(item.length, 32) && budget.nodes > 0 && budget.bytes > 0; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor || !("value" in descriptor)) { output.push(omitted); continue }
        output.push(consume(descriptor.value, undefined, depth + 1))
      }
      if (item.length > output.length) output.push(omitted)
      return output
    }
    const output: Record<string, unknown> = {}
    let keys: string[]
    try { keys = Object.keys(item).slice(0, MAX_KEYS) } catch { return omitted }
    for (const name of keys) {
      if (--budget.keys < 0 || budget.nodes <= 0 || budget.bytes <= 0) break
      const safeName = redactToolDisplayText(name, 256)
      if (!safeName || safeName.length > 256) continue
      const nameBytes = new TextEncoder().encode(safeName).byteLength
      if (nameBytes > budget.bytes) break
      if (options.arguments) {
        const normalized = name.replace(/[-_]/gu, "")
        if (!SAFE_ARGUMENT_KEYS.has(name) && !SAFE_ARGUMENT_KEYS.has(normalized)) continue
        if (name === "command") {
          const descriptor = Object.getOwnPropertyDescriptor(item, name)
          if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") continue
          const executable = descriptor.value.slice(0, 4096).trimStart().match(/^(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/)
          const value = executable?.[1] ?? executable?.[2] ?? executable?.[3]
          const preview = value ? `${redactToolDisplayText(value, Math.max(0, Math.min(256, budget.bytes - nameBytes)))} …` : "[omitted]"
          output[safeName] = redactToolDisplayText(preview, Math.max(0, budget.bytes - nameBytes))
          budget.bytes -= nameBytes + new TextEncoder().encode(String(output[safeName])).byteLength
          continue
        }
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, name)
      budget.bytes -= nameBytes
      if (!descriptor || !("value" in descriptor)) { output[safeName] = omitted; continue }
      output[safeName] = consume(descriptor.value, name, depth + 1)
    }
    if (keys.length === MAX_KEYS) output.__omitted = omitted
    return output
  }
  try { return consume(value, undefined, 0) } catch { return omitted }
}

