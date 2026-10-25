import * as LSPClient from "./client"

const MAX_PER_FILE = 20
const MAX_FILES = 8
const MAX_TOTAL_ERRORS = 120
const MAX_MESSAGE_CHARS = 4_096

const severityMap = {
  1: "ERROR",
  2: "WARN",
  3: "INFO",
  4: "HINT",
} as const

function severityLabel(severity: number | undefined): string {
  if (severity === 2 || severity === 3 || severity === 4) return severityMap[severity]
  return severityMap[1]
}

export function pretty(diagnostic: LSPClient.Diagnostic) {
  const severity = severityLabel(diagnostic.severity)
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1
  const message = diagnostic.message.length > MAX_MESSAGE_CHARS
    ? `${diagnostic.message.slice(0, MAX_MESSAGE_CHARS)}…`
    : diagnostic.message
  return `${severity} [${line}:${col}] ${message}`
}

export function report(file: string, issues: LSPClient.Diagnostic[]) {
  const errors = issues.filter((item) => item.severity === 1)
  if (errors.length === 0) return ""
  const limited = errors.slice(0, MAX_PER_FILE)
  const more = errors.length - MAX_PER_FILE
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  return `<diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}\n</diagnostics>`
}

const normalize = (file: string) => file.replaceAll("\\", "/")

export type PostPatchDiagnosticFileV1 = Readonly<{
  /** Path exactly as reported by the language server. */
  file: string
  /** Total ERROR diagnostics for this file. */
  errors: number
  /** ERROR diagnostics actually included in `block`. */
  shown: number
  block: string
}>

export type PostPatchDiagnosticsV1 = Readonly<{
  /** Bounded, deterministic, touched-first error blocks. */
  files: readonly PostPatchDiagnosticFileV1[]
  /** Files with errors omitted because the file budget was exhausted. */
  omittedFiles: number
  /** Error diagnostics omitted by per-file/total budgets. */
  omittedErrors: number
}>

/**
 * Bounded post-patch diagnostics for tool results (ACC-002, §30.29 ACC-F).
 *
 * Patch tools call this after `touchFile`/`diagnostics()` with the files they
 * actually changed. Only ERROR diagnostics are surfaced; touched files are
 * reported first in caller order, then other project files in stable lexical
 * order. Every bound (files, per-file items, total items) is reported
 * truthfully rather than silently truncated. It performs no IO and cannot
 * authorize a write.
 */
export function postPatch(input: {
  readonly diagnostics: Readonly<Record<string, readonly LSPClient.Diagnostic[]>>
  readonly touched: readonly string[]
  readonly maxFiles?: number
  readonly maxPerFile?: number
}): PostPatchDiagnosticsV1 {
  const maxFiles = input.maxFiles ?? MAX_FILES
  const maxPerFile = input.maxPerFile ?? MAX_PER_FILE
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new TypeError("maxFiles must be a non-negative integer")
  if (!Number.isSafeInteger(maxPerFile) || maxPerFile < 0) throw new TypeError("maxPerFile must be a non-negative integer")

  const byPath = new Map<string, { file: string; issues: readonly LSPClient.Diagnostic[] }>()
  for (const [file, issues] of Object.entries(input.diagnostics)) {
    const key = normalize(file)
    const existing = byPath.get(key)
    byPath.set(key, existing
      ? { file: existing.file, issues: [...existing.issues, ...issues] }
      : { file, issues })
  }

  const ordered: { file: string; issues: readonly LSPClient.Diagnostic[] }[] = []
  const seen = new Set<string>()
  for (const touched of input.touched) {
    const key = normalize(touched)
    const entry = byPath.get(key)
    seen.add(key)
    if (entry) ordered.push(entry)
  }
  const remaining = [...byPath.entries()]
    .filter(([key]) => !seen.has(key))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, entry]) => entry)
  ordered.push(...remaining)

  const files: PostPatchDiagnosticFileV1[] = []
  let omittedFiles = 0
  let omittedErrors = 0
  let totalErrors = 0
  for (const entry of ordered) {
    const errors = entry.issues.filter((item) => item.severity === 1)
    if (errors.length === 0) continue
    if (files.length >= maxFiles || totalErrors >= MAX_TOTAL_ERRORS) {
      omittedFiles += 1
      omittedErrors += errors.length
      continue
    }
    const remainingBudget = MAX_TOTAL_ERRORS - totalErrors
    const shown = Math.min(errors.length, maxPerFile, remainingBudget)
    const limited = errors.slice(0, shown)
    const more = errors.length - shown
    files.push(Object.freeze({
      file: entry.file,
      errors: errors.length,
      shown,
      block: `<diagnostics file="${entry.file}">\n${limited.map(pretty).join("\n")}${more > 0 ? `\n... and ${more} more` : ""}\n</diagnostics>`,
    }))
    totalErrors += shown
    omittedErrors += more
  }
  return Object.freeze({ files: Object.freeze(files), omittedFiles, omittedErrors })
}

/** Render the bounded blocks as tool-result text. Empty only when the input
 * carried no error diagnostics at all: omitted errors always leave a summary,
 * even when the file budget dropped every block. */
export function postPatchText(result: PostPatchDiagnosticsV1): string {
  const filesWithOmissions =
    result.files.filter((file) => file.errors > file.shown).length + result.omittedFiles
  const summary = result.omittedErrors > 0 || result.omittedFiles > 0
    ? `... ${result.omittedErrors} more error${result.omittedErrors === 1 ? "" : "s"} across ${filesWithOmissions} file${filesWithOmissions === 1 ? "" : "s"} omitted`
    : ""
  if (result.files.length === 0) return summary
  const blocks = result.files.map((file) => file.block).join("\n\n")
  return summary ? `${blocks}\n\n${summary}` : blocks
}

export * as Diagnostic from "./diagnostic"
