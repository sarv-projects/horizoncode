import { createMemo, createSignal, For, Show } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import {
  boundToolOutput,
  collapseToolOutput,
  sanitizeToolDisplayValue,
  toolArtifactFidelity,
  toolArgumentPreview,
} from "../util/collapse-tool-output"
import type { JSX } from "@opentui/solid"
import type { BoxRenderable, KeyEvent } from "@opentui/core"

type TextPart = Extract<Part, { type: "text" }>
type ReasoningPart = Extract<Part, { type: "reasoning" }>
type ToolPart = Extract<Part, { type: "tool" }>

type ActivityEntry = { kind: "part"; part: Part } | { kind: "limit"; omitted: number }

const MAX_ACTIVITY_NODES = 256
const MAX_ACTIVITY_BYTES = 256 * 1024
const MAX_FINAL_TEXT_BYTES = 64 * 1024
const MAX_TOOL_DETAILS_BYTES = 64 * 1024
const ACTIVITY_LIMIT_MARKER = "Activity limited: remaining parts omitted"
const PART_LIMIT_MARKER_BYTES = 64
const FINAL_TEXT_MARKER = "\n… final text truncated for display …"

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

function sliceUtf8(value: string, maxBytes: number) {
  let bytes = 0
  let index = 0
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
    if (bytes + size > maxBytes) break
    bytes += size
    index += size === 4 ? 2 : 1
  }
  return value.slice(0, index)
}

function boundedFinalText(part: TextPart) {
  const sourceBytes = utf8Size(part.text)
  if (sourceBytes <= MAX_FINAL_TEXT_BYTES) return { part, bytes: sourceBytes }
  const text = `${sliceUtf8(part.text, MAX_FINAL_TEXT_BYTES - utf8Size(FINAL_TEXT_MARKER))}${FINAL_TEXT_MARKER}`
  return { part: { ...part, text }, bytes: utf8Size(text) }
}

function activityPartBytes(part: Part) {
  if (part.type === "text") return utf8Size(part.text)
  if (part.type === "reasoning") return utf8Size("Progress summary unavailable")
  if (part.type === "tool") {
    const output = boundToolOutput(toolOutput(part)).output
    return utf8Size(output) + utf8Size(toolArgumentPreview(part.state.input)) + 96
  }
  return 0
}

function activityProjection(parts: Part[], reserveToolDetails: boolean): ActivityEntry[] {
  const reservedDetails = reserveToolDetails && parts.some((part) => part.type === "tool") ? MAX_TOOL_DETAILS_BYTES : 0
  const maxActivityBytes = MAX_ACTIVITY_BYTES - reservedDetails
  if (parts.length <= MAX_ACTIVITY_NODES) {
    let totalBytes = 0
    let withinByteLimit = true
    for (const part of parts) {
      totalBytes += activityPartBytes(part)
      if (totalBytes > maxActivityBytes) {
        withinByteLimit = false
        break
      }
    }
    if (withinByteLimit) return parts.map((part) => ({ kind: "part", part }))
  }

  const finalTextIndex = parts.findLastIndex((part) => part.type === "text")
  const finalText = finalTextIndex >= 0 ? boundedFinalText(parts[finalTextIndex] as TextPart) : undefined
  const reserveFinalBytes = finalText?.bytes ?? 0
  const entries: ActivityEntry[] = []
  let usedBytes = 0

  for (let index = 0; index < parts.length; index++) {
    if (index === finalTextIndex) {
      entries.push({ kind: "part", part: finalText!.part })
      continue
    }

    const remainingAfter = parts.length - index - 1
    const reserveNodes = (finalTextIndex > index ? 2 : 1) // omission marker and final text, when present
    const exceedsNodes = entries.length + 1 + reserveNodes > MAX_ACTIVITY_NODES
    const exceedsBytes = usedBytes + activityPartBytes(parts[index]) + reserveFinalBytes + PART_LIMIT_MARKER_BYTES > maxActivityBytes
    if (exceedsNodes || exceedsBytes) {
      const omitted = parts.length - index - (finalTextIndex >= index ? 1 : 0)
      if (omitted > 0) entries.push({ kind: "limit", omitted })
      if (finalTextIndex >= index) entries.push({ kind: "part", part: finalText!.part })
      break
    }

    entries.push({ kind: "part", part: parts[index] })
    usedBytes += activityPartBytes(parts[index])
    if (remainingAfter > 0 && index + 1 < parts.length && entries.length + (finalTextIndex > index ? 2 : 1) >= MAX_ACTIVITY_NODES) {
      const omitted = remainingAfter - (finalTextIndex > index ? 1 : 0)
      if (omitted > 0) entries.push({ kind: "limit", omitted })
      if (finalTextIndex > index) entries.push({ kind: "part", part: finalText!.part })
      break
    }
  }
  return entries
}

export function ActivityStream(props: {
  parts: Part[]
  complete: boolean
  width?: number
  renderText: (part: TextPart) => JSX.Element
  renderToolDetails?: (part: ToolPart) => JSX.Element
}) {
  const [expandedPartID, setExpandedPartID] = createSignal<string>()
  const finalTextID = createMemo(() => props.parts.findLast((part) => part.type === "text")?.id)
  const entries = createMemo(() => activityProjection(props.parts, Boolean(props.renderToolDetails)))

  return (
    <For each={entries()}>
      {(entry) => {
        if (entry.kind === "limit") {
          return (
            <box paddingLeft={3} marginTop={1}>
              <text>{`${ACTIVITY_LIMIT_MARKER} (${entry.omitted})`}</text>
            </box>
          )
        }
        const part = entry.part
        if (part.type === "reasoning") return <ProgressSummary part={part} />
        if (part.type === "tool") {
          return (
            <ToolActivity
              part={part}
              width={props.width ?? 80}
              renderDetails={props.renderToolDetails}
              expanded={expandedPartID() === part.id}
              onToggle={() => setExpandedPartID((current) => (current === part.id ? undefined : part.id))}
            />
          )
        }
        if (part.type !== "text") return null
        return (
          <>
            <Show when={props.complete && part.id === finalTextID()}>
              <box paddingLeft={3} marginTop={1}>
                <text>Final answer</text>
              </box>
            </Show>
            {props.renderText(part)}
          </>
        )
      }}
    </For>
  )
}

function ProgressSummary(_props: { part: ReasoningPart }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={3} marginTop={1}>
      <text fg={theme.textMuted}>Progress summary unavailable</text>
    </box>
  )
}

function ToolActivity(props: {
  part: ToolPart
  width: number
  renderDetails?: (part: ToolPart) => JSX.Element
  expanded: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  const output = createMemo(() => toolOutput(props.part))
  const bounded = createMemo(() => boundToolOutput(output()))
  const collapsed = createMemo(() =>
    collapseToolOutput(bounded().output, 3, Math.max(80, props.width * 3)),
  )
  const status = createMemo(() => toolStatus(props.part))
  const statusColor = createMemo(() => {
    if (props.part.state.status === "error") return theme.error
    if (props.part.state.status === "completed") return theme.textMuted
    return theme.warning
  })
  const args = createMemo(() => toolArgumentPreview(props.part.state.input))
  const details = createMemo(() => sanitizeToolDisplayValue(props.part) as ToolPart)
  const artifact = createMemo(() =>
    toolArtifactFidelity("metadata" in props.part.state ? props.part.state.metadata : undefined),
  )
  const canExpand = createMemo(() => Boolean(output()) && (bounded().truncated || collapsed().overflow || props.renderDetails))
  const visibleOutput = createMemo(() => (props.expanded ? bounded().output : collapsed().output))
  const handleToggleKey = (event: KeyEvent) => {
    const key = event.name.toLowerCase()
    if (key !== "enter" && key !== "return" && key !== "space" && key !== " ") return
    event.preventDefault()
    props.onToggle()
  }

  return (
    <box paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
      <text fg={statusColor()}>
        {status().label} {props.part.tool}
        <Show when={args()}>
          {(value) => <span style={{ fg: theme.textMuted }}> {value()}</span>}
        </Show>
      </text>
      <Show when={artifact().visible}>
        <text fg={theme.textMuted}>{`Output artifact: ${artifact().fidelity}`}</text>
      </Show>
      <Show when={output()}>
        <text fg={theme.text}>{visibleOutput()}</text>
      </Show>
      <Show when={bounded().truncated}>
        <text fg={theme.textMuted}>
          Output limited ({bounded().limitedBy === "lines" ? "200 lines" : "64 KiB"})
        </text>
      </Show>
      <Show when={canExpand()}>
        <box
          id={`activity-output-toggle-${props.part.id}`}
          ref={(element: BoxRenderable) => {
            element.focusable = true
          }}
          onKeyDown={handleToggleKey}
          onMouseUp={props.onToggle}
        >
          <text fg={theme.textMuted}>
            {props.expanded ? "Collapse output (Enter/Space)" : "Expand output (Enter/Space)"}
          </text>
        </box>
      </Show>
      <Show when={props.expanded && props.renderDetails}>
        {props.renderDetails?.(details())}
      </Show>
    </box>
  )
}

function toolStatus(part: ToolPart) {
  if (part.state.status === "pending") return { label: "Starting" }
  if (part.state.status === "running") return { label: "Running" }
  if (part.state.status === "completed") return { label: "Succeeded" }
  return { label: "Failed" }
}

function toolOutput(part: ToolPart) {
  const state = part.state
  if (state.status === "pending") return ""
  if (state.status === "error") {
    // Bound before redaction in the presentation layer. Redacting an unbounded
    // provider/tool error here would scan the complete payload on every render.
    return state.error
  }
  if (state.status === "completed" && state.output) return state.output
  if (state.status === "running") return "Progress detail unavailable"
  return ""
}
