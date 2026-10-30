import type { Part } from "@horizoncode/sdk/v2"
import { redactToolText, safeToolName, toolArgumentPreview, toolArtifactFidelity } from "../util/collapse-tool-output"

type ToolPart = Extract<Part, { type: "tool" }>
type ReasoningPart = Extract<Part, { type: "reasoning" }>

export type ActivityCardKindV1 =
  | "file_edit"
  | "file_read"
  | "read_group"
  | "shell"
  | "repo_intel"
  | "web_search"
  | "subagent"
  | "permission"
  | "codemode"
  | "generic_tool"
  | "progress"
  | "limit_marker"

export type ActivityCardStateV1 = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown"

export type ActivityLineStatsV1 = {
  readonly added: number
  readonly removed: number
}

/**
 * Derived, bounded activity projection (§31.22). It never authorizes effects and
 * never exposes reasoning text: `progress` is a redacted placeholder only.
 */
export type ActivityCardV1 = {
  readonly cardId: string
  readonly kind: ActivityCardKindV1
  readonly state: ActivityCardStateV1
  readonly titleLine: string
  readonly sourcePartIds: readonly string[]
  readonly groupCount?: number
  readonly pathRef?: string
  readonly lineStats?: ActivityLineStatsV1
  readonly durationMs?: number
  readonly receiptState?: "settled" | "unknown"
  readonly fidelity?: "FULL" | "SAMPLE" | "FAILED"
  readonly artifactRef?: string
  readonly collapsedPreviewLines: readonly string[]
  readonly truncatedLineCount: number
  readonly expandable: boolean
  readonly reviewable: boolean
}

const MAX_CARDS = 64
const MAX_TITLE_BYTES = 240
const MAX_PATH_BYTES = 1024
const MAX_ARTIFACT_BYTES = 4 * 1024
const MAX_READ_GROUP_PARTS = 8
const READ_GROUP_WINDOW_MS = 30_000
const MAX_CARD_BYTES = 64 * 1024
const MAX_PREVIEW_LINES = 6
const MAX_PREVIEW_LINE_BYTES = 4 * 1024

function kind(toolName: string): ActivityCardKindV1 {
  if (["write", "edit", "apply_patch", "files.write", "files.patch"].includes(toolName)) return "file_edit"
  if (["read", "files.read"].includes(toolName)) return "file_read"
  if (["bash", "terminal.run"].includes(toolName)) return "shell"
  if (["repo.tree", "repo.detect", "symbols", "references", "grep", "glob"].includes(toolName)) return "repo_intel"
  if (["websearch", "web.search"].includes(toolName)) return "web_search"
  if (toolName === "task") return "subagent"
  if (toolName === "question") return "permission"
  if (toolName === "codemode.execute") return "codemode"
  return "generic_tool"
}

function state(part: ToolPart): ActivityCardStateV1 {
  const partState = part.state
  const metadata = "metadata" in partState && partState.metadata && typeof partState.metadata === "object"
    ? partState.metadata
    : undefined
  if (metadata && "receiptState" in metadata && metadata.receiptState === "unknown") return "unknown"
  if (partState.status === "pending") return "pending"
  if (partState.status === "running") return "running"
  if (partState.status === "completed") return "succeeded"
  return "failed"
}

function timeRange(part: ToolPart): { start?: number; end?: number } {
  const partState = part.state
  if (!("time" in partState) || !partState.time || !Number.isSafeInteger(partState.time.start)) return {}
  return {
    start: partState.time.start,
    ...("end" in partState.time && Number.isSafeInteger(partState.time.end) ? { end: partState.time.end } : {}),
  }
}

function durationMs(part: ToolPart): number | undefined {
  const range = timeRange(part)
  if (range.start === undefined || range.end === undefined || range.end < range.start) return undefined
  return range.end - range.start
}

function metadata(part: ToolPart): Record<string, unknown> | undefined {
  const partState = part.state
  if (!("metadata" in partState) || !partState.metadata || typeof partState.metadata !== "object" || Array.isArray(partState.metadata)) {
    return undefined
  }
  return partState.metadata
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined
  // Activity titles are plain text; strip control/ANSI introducers before they
  // can reach a terminal renderer.
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!stripped) return undefined
  return truncateUtf8(stripped, maxBytes)
}

function pathOf(part: ToolPart): string | undefined {
  const input = part.state.input
  for (const key of ["filePath", "path", "file"] as const) {
    const value = boundedText(input[key], MAX_PATH_BYTES)
    if (value) return value
  }
  return undefined
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function lineStats(part: ToolPart): ActivityLineStatsV1 | undefined {
  const value = metadata(part)
  if (!value) return undefined
  const nested = value.lineStats
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const stats = nested as Record<string, unknown>
    const added = nonNegativeInt(stats.added)
    const removed = nonNegativeInt(stats.removed)
    if (added !== undefined && removed !== undefined) return { added, removed }
  }
  const added = nonNegativeInt(value.additions) ?? nonNegativeInt(value.added)
  const removed = nonNegativeInt(value.deletions) ?? nonNegativeInt(value.removed)
  return added !== undefined && removed !== undefined ? { added, removed } : undefined
}

function receiptState(part: ToolPart): "settled" | "unknown" | undefined {
  const value = metadata(part)?.receiptState
  return value === "settled" || value === "unknown" ? value : undefined
}

function artifact(part: ToolPart): { fidelity?: "FULL" | "SAMPLE" | "FAILED"; artifactRef?: string } {
  const value = metadata(part)
  const projected = toolArtifactFidelity(value)
  const artifactRef = boundedText(value?.artifactRef, MAX_ARTIFACT_BYTES)
  return {
    ...(projected.visible && projected.fidelity !== "UNKNOWN" ? { fidelity: projected.fidelity } : {}),
    ...(artifactRef ? { artifactRef } : {}),
  }
}

export function formatActivityDuration(value: number): string {
  return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`
}

function title(part: ToolPart, cardKind: ActivityCardKindV1, stats?: ActivityLineStatsV1): string {
  const name = safeToolName(part.tool)
  const args = toolArgumentPreview(part.state.input, 128)
  const path = pathOf(part)
  const summary = cardKind === "file_edit"
    ? `${part.state.status === "error" ? "Edit" : "Edited"}${path || args ? ` ${path ?? args}` : ""}${stats ? ` +${stats.added} −${stats.removed}` : ""}`
    : cardKind === "file_read"
      ? `Read${path || args ? ` ${path ?? args}` : ""}`
      : cardKind === "shell"
        ? `${part.state.status === "running" ? "Running" : part.state.status === "error" ? "Failed" : "Succeeded"} shell · ${args || name}`
        : cardKind === "repo_intel"
          ? `Repo ${name}${args ? ` · ${args}` : ""}`
          : cardKind === "web_search"
            ? `Web search${args ? ` · ${args}` : ""}`
             : cardKind === "subagent"
               ? `Subagent ${boundedText(metadata(part)?.profileID, 128) ?? boundedText(metadata(part)?.agent, 128) ?? "worker"} · ${state(part)}${typeof metadata(part)?.sessionId === "string" ? ` · ${boundedText(metadata(part)?.sessionId, 128) ?? ""}` : ""}`
              : cardKind === "permission"
                ? `Approval · ${name}`
                : cardKind === "codemode"
                  ? `CodeMode${args ? ` · ${args}` : ""}`
                  : name
  return truncateUtf8(summary, MAX_TITLE_BYTES)
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let output = ""
  for (const character of value) {
    const size = character.codePointAt(0)! <= 0x7f ? 1 : character.codePointAt(0)! <= 0x7ff ? 2 : character.codePointAt(0)! <= 0xffff ? 3 : 4
    if (bytes + size > maxBytes) return `${output.slice(0, Math.max(0, output.length - 1))}…`
    output += character
    bytes += size
  }
  return output
}

function utf8Bytes(value: string): number {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

function preview(part: ToolPart, availableBytes: number): { lines: string[]; truncatedLineCount: number } {
  const output = "output" in part.state && typeof part.state.output === "string" ? part.state.output : ""
  if (!output || availableBytes <= 0) return { lines: [], truncatedLineCount: 0 }
  const lines: string[] = []
  let lineStart = 0
  let lineCount = 0
  let usedBytes = 0
  for (let index = 0; index <= output.length; index++) {
    if (index !== output.length && output.charCodeAt(index) !== 10) continue
    lineCount++
    if (lines.length < MAX_PREVIEW_LINES && usedBytes < availableBytes) {
      const safe = redactToolText(output.slice(lineStart, index))
      const line = truncateUtf8(safe, Math.min(MAX_PREVIEW_LINE_BYTES, availableBytes - usedBytes))
      if (line) {
        lines.push(line)
        usedBytes += utf8Bytes(line)
      }
    }
    lineStart = index + 1
  }
  return { lines, truncatedLineCount: Math.max(0, lineCount - lines.length) }
}

function canGroup(left: ToolPart, right: ToolPart): boolean {
  if (!["file_read", "repo_intel"].includes(kind(left.tool)) || !["file_read", "repo_intel"].includes(kind(right.tool))) return false
  const leftTime = timeRange(left).start
  const rightTime = timeRange(right).start
  return leftTime !== undefined && rightTime !== undefined && rightTime >= leftTime && rightTime - leftTime <= READ_GROUP_WINDOW_MS
}

/** Build a bounded digest from one canonical assistant-message tool list. */
export function projectActivityCards(parts: readonly Part[]): ActivityCardV1[] {
  const tools = parts.filter((part): part is ToolPart => part.type === "tool")
  const cards: ActivityCardV1[] = []
  let omitted = 0
  let bytes = 0

  for (let index = 0; index < tools.length; index++) {
    const part = tools[index]!
    const cardKind = kind(part.tool)
    const group = cardKind === "file_read" || cardKind === "repo_intel" ? [part] : undefined
    if (group) {
      while (index + 1 < tools.length && group.length < MAX_READ_GROUP_PARTS && canGroup(group.at(-1)!, tools[index + 1]!)) {
        group.push(tools[++index]!)
      }
    }
    const nextKind = group && group.length > 1 ? "read_group" : cardKind
    const stats = lineStats(part)
    const titleLine = nextKind === "read_group" ? `Read ${group!.length} paths` : title(part, cardKind, stats)
    const duration = durationMs(part)
    const fidelity = artifact(part)
    const titleText = truncateUtf8(titleLine, MAX_TITLE_BYTES)
    const sourcePartIds = (group ?? [part]).map((source) => source.id)
    const baseBytes = sourcePartIds.reduce((total, id) => total + utf8Bytes(id), 0) + utf8Bytes(titleText)
    const projectedPreview = preview(part, Math.max(0, MAX_CARD_BYTES - bytes - baseBytes))
    const item: ActivityCardV1 = {
      cardId: group && group.length > 1 ? `read-group:${group[0]!.id}` : part.id,
      kind: nextKind,
      state: group && group.some((read) => state(read) === "unknown") ? "unknown" : group && group.some((read) => state(read) === "failed") ? "failed" : state(part),
      titleLine: titleText,
      sourcePartIds,
      ...(group && group.length > 1 ? { groupCount: group.length } : {}),
      ...(pathOf(part) ? { pathRef: pathOf(part) } : {}),
      ...(stats ? { lineStats: stats } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(receiptState(part) ? { receiptState: receiptState(part) } : {}),
      ...fidelity,
      collapsedPreviewLines: projectedPreview.lines,
      truncatedLineCount: projectedPreview.truncatedLineCount,
      expandable: projectedPreview.lines.length > 0,
      reviewable: projectedPreview.lines.length > 0 || fidelity.artifactRef !== undefined,
    }
    const itemBytes = baseBytes + projectedPreview.lines.reduce((total, line) => total + utf8Bytes(line), 0)
    if (cards.length >= MAX_CARDS - 1 || bytes + itemBytes > MAX_CARD_BYTES) {
      omitted += group?.length ?? 1
      omitted += tools.slice(index + 1).length
      break
    }
    cards.push(item)
    bytes += itemBytes
  }

  if (omitted > 0) cards.push({
    cardId: "activity-limit",
    kind: "limit_marker",
    state: "unknown",
    titleLine: `Activity limited: ${omitted} earlier actions omitted (Ctrl+R transcript)`,
    sourcePartIds: [],
    collapsedPreviewLines: [],
    truncatedLineCount: 0,
    expandable: false,
    reviewable: false,
  })
  return cards
}

/**
 * Project a reasoning part to a redacted progress card. The raw reasoning text
 * is intentionally never copied into the card (§31.22.4 `progress`).
 */
export function projectProgressCard(part: ReasoningPart): ActivityCardV1 {
  const start = Number.isSafeInteger(part.time?.start) ? part.time.start : undefined
  const end = Number.isSafeInteger(part.time?.end) ? part.time.end : undefined
  const duration = start !== undefined && end !== undefined && end >= start ? end - start : undefined
  return {
    cardId: part.id,
    kind: "progress",
    state: end !== undefined ? "succeeded" : "running",
    titleLine: `Reasoning${duration !== undefined ? ` · ${formatActivityDuration(duration)}` : ""}`,
    sourcePartIds: [part.id],
    collapsedPreviewLines: [],
    truncatedLineCount: 0,
    expandable: false,
    reviewable: false,
    ...(duration !== undefined ? { durationMs: duration } : {}),
  }
}
