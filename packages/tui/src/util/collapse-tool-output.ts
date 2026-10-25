import stripAnsi from "strip-ansi"

export type CollapsedToolOutput = {
  output: string
  overflow: boolean
  truncated: false | "lines" | "chars"
  totalLines: number
  shownLines: number
  shownChars: number
}

// Counts Unicode code points without allocating an array of the whole string.
function countCodePoints(value: string, stopAfter?: number) {
  let count = 0
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      index += next >= 0xdc00 && next <= 0xdfff ? 2 : 1
    } else index += 1
    count++
    if (stopAfter !== undefined && count > stopAfter) return count
  }
  return count
}

// Slices without splitting a surrogate pair.
function sliceCodePoints(value: string, limit: number) {
  let count = 0
  let index = 0
  while (index < value.length && count < limit) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      index += next >= 0xdc00 && next <= 0xdfff ? 2 : 1
    } else index += 1
    count++
  }
  return value.slice(0, index)
}

export function collapseToolOutput(output: string, maxLines: number, maxChars: number): CollapsedToolOutput {
  const lines = output.split("\n")
  const totalLines = lines.length
  const measuredChars = lines.length <= maxLines ? countCodePoints(output, maxChars) : undefined
  if (measuredChars !== undefined && measuredChars <= maxChars) {
    return {
      output,
      overflow: false,
      truncated: false,
      totalLines,
      shownLines: totalLines,
      shownChars: measuredChars,
    }
  }

  const preview = lines.slice(0, maxLines).join("\n")
  if (countCodePoints(preview, maxChars) > maxChars) {
    const shown = sliceCodePoints(preview, Math.max(0, maxChars - 1)) + "…"
    return {
      output: shown,
      overflow: true,
      truncated: "chars",
      totalLines,
      shownLines: shown.split("\n").length,
      shownChars: countCodePoints(shown),
    }
  }

  const shown = [...lines.slice(0, maxLines), "…"].join("\n")
  return {
    output: shown,
    overflow: true,
    truncated: "lines",
    totalLines,
    shownLines: maxLines,
    shownChars: countCodePoints(shown),
  }
}

export type BoundedToolOutput = {
  output: string
  truncated: boolean
  limitedBy?: "bytes" | "lines" | "bytes_and_lines"
}

export type ArtifactFidelityV1 = "FULL" | "SAMPLE" | "FAILED" | "UNKNOWN"

export type ToolArtifactFidelityV1 = {
  visible: boolean
  fidelity: ArtifactFidelityV1
}

/** Keep storage completeness separate from whether a short preview was rendered. */
export function toolArtifactFidelity(metadata: unknown): ToolArtifactFidelityV1 {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { visible: false, fidelity: "UNKNOWN" }
  }
  const value = metadata as Record<string, unknown>
  const visible =
    typeof value.artifactRef === "string" ||
    value.artifactFidelity !== undefined ||
    typeof value.artifactTruncated === "boolean" ||
    typeof value.previewTruncated === "boolean" ||
    typeof value.truncated === "boolean"
  if (!visible) return { visible: false, fidelity: "UNKNOWN" }

  const hasArtifactRef =
    typeof value.artifactRef === "string" &&
    !exceedsUtf8Limit(value.artifactRef, 4 * 1024) &&
    value.artifactRef.trim().length > 0
  const explicit = value.artifactFidelity
  if (explicit === "FAILED") return { visible: true, fidelity: "FAILED" }
  if (value.artifactTruncated === true && hasArtifactRef) return { visible: true, fidelity: "SAMPLE" }
  if (explicit === "SAMPLE" && hasArtifactRef) return { visible: true, fidelity: "SAMPLE" }
  if (explicit === "FULL" && hasArtifactRef) return { visible: true, fidelity: "FULL" }
  return { visible: true, fidelity: "UNKNOWN" }
}

const SAFE_TOOL_ARGUMENT_KEYS = new Set([
  "background",
  "command",
  "description",
  "filePath",
  "format",
  "glob",
  "limit",
  "mode",
  "name",
  "offset",
  "path",
  "pattern",
  "provider",
  "query",
  "recursive",
  "replaceAll",
  "start",
  "startLine",
  "subagent_type",
  "url",
  "workdir",
])

const SECRET_KEY = /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|authorization|auth|credential|cookie|private[-_ ]?key)/i
const PAYLOAD_KEY = /(?:content|prompt|text|body|patch|diff|source|stdout|stderr|result|data|attachment|image|buffer|env|question|todo)/i
const MAX_TOOL_DETAIL_NODES = 512
const MAX_TOOL_DETAIL_KEYS = 256
const MAX_TOOL_DETAIL_ENTRIES = 512
const MAX_TOOL_DETAIL_DEPTH = 6
// Enumeration is capped too: slicing `Object.keys()` after the fact still
// allocates an attacker-controlled number of names before the display budget.
const MAX_TOOL_DETAIL_ENUMERATED_KEYS = MAX_TOOL_DETAIL_KEYS * 2
const MAX_ARGUMENT_PREVIEW_ENUMERATED_KEYS = 9

function redactUrlCredentials(value: string) {
  const chunks: string[] = []
  let cursor = 0
  let searchFrom = 0
  while (true) {
    const separator = value.indexOf("://", searchFrom)
    if (separator < 0) break
    searchFrom = separator + 3

    let schemeStart = separator - 1
    while (schemeStart >= 0 && /[a-z0-9+.-]/i.test(value[schemeStart]!)) schemeStart--
    schemeStart++
    while (schemeStart < separator && !/[a-z]/i.test(value[schemeStart]!)) schemeStart++
    if (schemeStart === separator) continue

    const authorityStart = separator + 3
    let authorityEnd = authorityStart
    while (authorityEnd < value.length && !/[\/@\s]/.test(value[authorityEnd]!)) authorityEnd++
    if (value[authorityEnd] !== "@") continue
    const colon = value.indexOf(":", authorityStart)
    if (colon <= authorityStart || colon >= authorityEnd - 1) continue

    chunks.push(value.slice(cursor, schemeStart), value.slice(schemeStart, separator + 3), "[REDACTED]@")
    cursor = authorityEnd + 1
    searchFrom = cursor
  }
  if (cursor === 0) return value
  chunks.push(value.slice(cursor))
  return chunks.join("")
}

function safeArgumentKey(key: string) {
  if (key.length > 64) return false
  return SAFE_TOOL_ARGUMENT_KEYS.has(key) || SAFE_TOOL_ARGUMENT_KEYS.has(key.replace(/[-_]/g, ""))
}

function utf8Size(value: string) {
  let bytes = 0
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 2
        continue
      }
    }
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
    index += 1
  }
  return bytes
}

function exceedsUtf8Limit(value: string, limit: number) {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
    if (bytes > limit) return true
  }
  return false
}

function sliceUtf8(value: string, maxBytes: number) {
  let bytes = 0
  let index = 0
  const limit = Math.max(0, Math.floor(maxBytes))
  while (index < value.length) {
    const code = value.charCodeAt(index)
    const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0
    const size = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
      ? 4
      : code <= 0x7f
        ? 1
        : code <= 0x7ff
          ? 2
          : 3
    if (bytes + size > limit) break
    bytes += size
    index += size === 4 ? 2 : 1
  }
  return { text: value.slice(0, index), truncated: index < value.length }
}

/** Redact common credential forms and remove terminal/control characters before display. */
export function redactToolText(value: string) {
  const clean = stripAnsi(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/g, "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]")
    .replace(
      /(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|authorization|auth|credential|cookie|client[-_ ]?secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)?/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(--(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|cookie)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]",
    )
  return redactUrlCredentials(clean)
}

/** Keep only canonical, printable capability-style tool identifiers in labels. */
export function safeToolName(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return "tool"
  // Provider-controlled names are rendered into the terminal. ASCII capability
  // identifiers avoid ANSI/OSC, bidi, and other control/formatting injection.
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : "tool"
}

/** Keep the executable identity while omitting shell arguments that may contain secrets or private input. */
function safeCommandPreview(value: string) {
  const match = value.slice(0, 4_096).trimStart().match(/^(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/)
  const executable = match?.[1] ?? match?.[2] ?? match?.[3]
  if (!executable) return "[omitted]"
  return `${redactToolText(executable)} …`
}

/** A compact allowlisted argument summary; unknown/free-form payloads are omitted. */
export function toolArgumentPreview(input: unknown, maxChars = 240) {
  const value = parseToolArguments(input)
  if (!value) return typeof input === "string" && input.length > 0 ? "arguments pending" : ""

  const entries: string[] = []
  let hasMore = false
  let enumerated = 0
  for (const key in value) {
    if (enumerated >= MAX_ARGUMENT_PREVIEW_ENUMERATED_KEYS || entries.length >= 8) {
      hasMore = true
      break
    }
    enumerated++
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    let item: unknown
    try {
      item = value[key]
    } catch {
      entries.push("[argument unavailable]")
      continue
    }
    const boundedKey = key.slice(0, 256)
    const displayKey = redactToolText(boundedKey).slice(0, 48)
    if (SECRET_KEY.test(boundedKey)) {
      entries.push(`${displayKey}=[REDACTED]`)
      continue
    }
    if (PAYLOAD_KEY.test(boundedKey)) {
      entries.push(`${displayKey}=[omitted]`)
      continue
    }
    if (!safeArgumentKey(boundedKey)) {
      entries.push(`${displayKey}=[omitted]`)
      continue
    }
    if (typeof item === "string") {
      const prefix = item.slice(0, 4_096)
      const displayValue = key === "command"
        ? safeCommandPreview(item)
        : redactToolText(prefix + (prefix.length < item.length ? "…" : ""))
      entries.push(`${displayKey}=${JSON.stringify(displayValue)}`)
      continue
    }
    if (typeof item === "number" || typeof item === "boolean") {
      entries.push(`${displayKey}=${item}`)
      continue
    }
    if (Array.isArray(item)) {
      entries.push(`${displayKey}=[${item.length} items]`)
      continue
    }
    if (typeof item === "object" && item !== null) {
      entries.push(`${displayKey}={…}`)
      continue
    }
    entries.push(`${displayKey}=[omitted]`)
  }
  if (hasMore) entries.push("…")
  return sliceCodePoints(entries.join(" "), Math.max(0, Math.min(1_024, Math.floor(maxChars))))
}

/** Cap both the output bytes and displayed line count before handing text to a renderer. */
export function boundToolOutput(value: string, maxBytes = 64 * 1024, maxLines = 200): BoundedToolOutput {
  const byteBound = sliceUtf8(value, maxBytes)
  const redacted = redactToolText(byteBound.text)
  const cleanBound = sliceUtf8(redacted, maxBytes)
  const clean = cleanBound.text
  const lineLimit = Math.max(0, Math.floor(maxLines))
  const lines = clean.split("\n", lineLimit + 1)
  const lineTruncated = lines.length > lineLimit
  const prefix = lineTruncated ? lines.slice(0, lineLimit).join("\n") : clean
  const byteTruncated = byteBound.truncated || cleanBound.truncated
  const truncated = byteTruncated || lineTruncated
  const candidate = truncated
    ? `${sliceUtf8(prefix, Math.max(0, maxBytes - utf8Size("…"))).text}…`
    : prefix
  const output = sliceUtf8(candidate, Math.max(0, maxBytes)).text
  return {
    output,
    truncated,
    limitedBy: byteTruncated && lineTruncated ? "bytes_and_lines" : byteTruncated ? "bytes" : lineTruncated ? "lines" : undefined,
  }
}

/** Small terminal-safe one-line preview for prompt text used as a list label. */
export function safeTimelineTitle(value: string, maxBytes = 512) {
  return boundToolOutput(value, Math.max(0, Math.min(512, Math.floor(maxBytes))), 1).output.replace(/\n/g, " ")
}

/** Recursively redact and byte-cap a tool part before handing it to detail renderers. */
export function sanitizeToolDisplayValue(value: unknown, maxBytes = 64 * 1024) {
  type Budget = { bytes: number; nodes: number; keys: number; entries: number }
  const byteLimit = Math.max(0, Math.min(64 * 1024, Math.floor(maxBytes)))
  const budget: Budget = {
    bytes: byteLimit,
    nodes: MAX_TOOL_DETAIL_NODES,
    keys: MAX_TOOL_DETAIL_KEYS,
    entries: MAX_TOOL_DETAIL_ENTRIES,
  }
  const visited = new WeakSet<object>()
  const omitted = Symbol("omitted")

  const encodedSize = (item: unknown) => {
    const encoded = JSON.stringify(item)
    return encoded === undefined ? Number.POSITIVE_INFINITY : utf8Size(encoded)
  }

  function truncateString(item: string, byteLimit: number) {
    if (encodedSize(item) <= byteLimit) return item
    const points = countCodePoints(item)
    let low = 0
    let high = points
    let result: string | undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = sliceCodePoints(item, middle) + "…"
      if (encodedSize(candidate) <= byteLimit) {
        result = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (result !== undefined) return result
    return undefined
  }

  function cloneBudget(from: Budget): Budget {
    return { ...from }
  }

  function commitBudget(target: Budget, source: Budget) {
    target.bytes = source.bytes
    target.nodes = source.nodes
    target.keys = source.keys
    target.entries = source.entries
  }

  function sanitize(
    item: unknown,
    key: string | undefined,
    depth: number,
    current: Budget,
    argumentObject = false,
  ): unknown | typeof omitted {
    if (current.nodes <= 0) return omitted
    if (key && SECRET_KEY.test(key)) item = "[REDACTED]"
    if (key && PAYLOAD_KEY.test(key) && !argumentObject) item = "[omitted]"

    if (key === "input" && typeof item === "string") {
      const parsed = parseToolArguments(item)
      if (!parsed) return sanitize("[arguments omitted]", undefined, depth, current)
      return sanitize(parsed, key, depth, current, true)
    }

    if (typeof item === "string") {
      const source = sliceUtf8(item, current.bytes)
      const clean = redactToolText(source.text + (source.truncated ? "…" : ""))
      const bounded = truncateString(clean, current.bytes)
      if (bounded === undefined) return omitted
      const cost = encodedSize(bounded)
      if (cost > current.bytes) return omitted
      current.nodes--
      current.bytes -= cost
      return bounded
    }
    if (typeof item === "number" || typeof item === "boolean" || item === null) {
      const cost = encodedSize(item)
      if (cost > current.bytes) return omitted
      current.nodes--
      current.bytes -= cost
      return item
    }
    if (typeof item !== "object") return undefined
    if (depth >= MAX_TOOL_DETAIL_DEPTH || visited.has(item)) {
      return sanitize("[nested value omitted]", undefined, depth, current)
    }
    visited.add(item)

    const containerCost = 2 // `[]` or `{}`
    if (current.bytes < containerCost) return omitted
    current.nodes--
    current.bytes -= containerCost

    if (Array.isArray(item)) {
      const result: unknown[] = []
      for (const childValue of item) {
        if (current.entries <= 0 || current.nodes <= 0) break
        const trial = cloneBudget(current)
        if (result.length > 0) trial.bytes-- // comma
        if (trial.bytes < 0) break
        const child = sanitize(childValue, key, depth + 1, trial)
        if (child === omitted) continue
        trial.entries--
        commitBudget(current, trial)
        result.push(child)
      }
      return result
    }

    const result: Record<string, unknown> = {}
    let names: string[]
    let enumerationTruncated = false
    try {
      names = []
      let scanned = 0
      for (const name in item as Record<string, unknown>) {
        if (scanned >= MAX_TOOL_DETAIL_ENUMERATED_KEYS) {
          enumerationTruncated = true
          break
        }
        scanned++
        if (!Object.prototype.hasOwnProperty.call(item, name)) continue
        names.push(name)
      }
    } catch {
      return result
    }
    const isToolInput = argumentObject || key === "input"
    if (isToolInput) {
      names.sort((left, right) => {
        const leftSafe = safeArgumentKey(left)
        const rightSafe = safeArgumentKey(right)
        return Number(rightSafe) - Number(leftSafe)
      })
    }
    for (const name of names) {
      if (current.keys <= 0 || current.entries <= 0 || current.nodes <= 0) break

      const boundedName = sliceUtf8(name, 512)
      const safeName = sliceCodePoints(redactToolText(boundedName.text + (boundedName.truncated ? "…" : "")), 96)
      if (!safeName || Object.prototype.hasOwnProperty.call(result, safeName)) continue
      const trial = cloneBudget(current)
      const nameCost = encodedSize(safeName) + 1 // quoted key plus colon
      const separatorCost = Object.keys(result).length > 0 ? 1 : 0
      trial.bytes -= nameCost + separatorCost
      trial.keys--
      if (trial.bytes < 0) break

      let childValue: unknown
      try {
        childValue = (item as Record<string, unknown>)[name]
      } catch {
        continue
      }

      let child: unknown | typeof omitted
      const boundedKey = boundedName.text
      if (boundedName.truncated) {
        child = sanitize("[omitted]", undefined, depth + 1, trial)
      } else if (SECRET_KEY.test(boundedKey)) {
        child = sanitize("[REDACTED]", undefined, depth + 1, trial)
      } else if (isToolInput && !safeArgumentKey(boundedKey)) {
        child = sanitize("[omitted]", undefined, depth + 1, trial)
      } else if (isToolInput && PAYLOAD_KEY.test(boundedKey)) {
        child = sanitize("[omitted]", undefined, depth + 1, trial)
      } else if (isToolInput && boundedKey === "command" && typeof childValue === "string") {
        child = sanitize(safeCommandPreview(childValue), undefined, depth + 1, trial)
      } else {
        child = sanitize(childValue, boundedKey, depth + 1, trial)
      }
      if (child === omitted || child === undefined) continue
      trial.entries--
      commitBudget(current, trial)
      result[safeName] = child
    }
    // A bounded prefix of an unusually wide object is still a truthful but
    // partial detail projection; the summary keeps that limitation explicit.
    if (enumerationTruncated && current.entries > 0 && current.nodes > 0 && current.keys > 0) {
      const marker = "[additional fields omitted]"
      const cost = encodedSize(marker) + encodedSize("…") + 1 + (Object.keys(result).length > 0 ? 1 : 0)
      if (cost <= current.bytes && !Object.prototype.hasOwnProperty.call(result, "…")) {
        current.bytes -= cost
        current.entries--
        current.nodes--
        current.keys--
        result["…"] = marker
      }
    }
    return result
  }

  const result = sanitize(value, undefined, 0, budget)
  if (result === omitted) return undefined
  const encoded = JSON.stringify(result)
  if (encoded === undefined || utf8Size(encoded) > byteLimit) return undefined
  return result
}

function parseToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    if (value.length === 0 || value.length > 8192) return
    try {
      return parseToolArguments(JSON.parse(value))
    } catch {
      return
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}
