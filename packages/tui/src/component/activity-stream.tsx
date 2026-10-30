import { createMemo, createSignal, For, Show } from "solid-js"
import type { Part } from "@horizoncode/sdk/v2"
import { useTheme } from "../context/theme"
import { projectActivityCards, projectProgressCard, formatActivityDuration, type ActivityCardV1 } from "./activity-cards"
import {
  boundToolOutput,
  collapseToolOutput,
  sanitizeToolDisplayValue,
  safeToolName,
  toolArtifactFidelity,
  toolArgumentPreview,
} from "../util/collapse-tool-output"
import type { JSX } from "@opentui/solid"
import type { BoxRenderable, KeyEvent } from "@opentui/core"

type TextPart = Extract<Part, { type: "text" }>
type ReasoningPart = Extract<Part, { type: "reasoning" }>
type ToolPart = Extract<Part, { type: "tool" }>

type ActivityEntry = { kind: "part"; part: Part } | { kind: "limit"; omitted: number }

// §31.22: at most 64 cards per assistant turn in the activity digest, while
// up to 256 cards may be retained in the sliding transcript window.
const MAX_ACTIVITY_NODES = 64
const MAX_ACTIVITY_BYTES = 256 * 1024
const MAX_FINAL_TEXT_BYTES = 64 * 1024
const MAX_TOOL_DETAILS_BYTES = 64 * 1024
// Include all fixed labels and layout text around a tool. Argument previews
// are counted separately; this conservative allowance keeps the aggregate
// activity budget truthful even when every rendered tool shows status,
// fidelity, truncation, and expansion controls.
const MAX_TOOL_ACTIVITY_CHROME_BYTES = 512
const ACTIVITY_LIMIT_MARKER = "Activity limited: remaining parts omitted"
const PART_LIMIT_MARKER_BYTES = 64
const FINAL_TEXT_MARKER = "\n… final text truncated for display …"

function utf8Size(value: string, stopAfterBytes = Number.POSITIVE_INFINITY) {
  // Every UTF-16 code unit contributes at least one UTF-8 byte, so this fast
  // rejection avoids walking arbitrarily large transcript parts just to decide
  // that they exceed the bounded activity projection.
  if (value.length > stopAfterBytes) return stopAfterBytes + 1
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
    if (bytes > stopAfterBytes) return stopAfterBytes + 1
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
  const sourceBytes = utf8Size(part.text, MAX_FINAL_TEXT_BYTES)
  if (sourceBytes <= MAX_FINAL_TEXT_BYTES) return { part, bytes: sourceBytes }
  const text = `${sliceUtf8(part.text, MAX_FINAL_TEXT_BYTES - utf8Size(FINAL_TEXT_MARKER))}${FINAL_TEXT_MARKER}`
  return { part: { ...part, text }, bytes: utf8Size(text) }
}

function activityPartBytes(part: Part) {
  if (part.type === "text") return utf8Size(part.text, MAX_ACTIVITY_BYTES)
  if (part.type === "reasoning") return utf8Size(projectProgressCard(part).titleLine)
  if (part.type === "tool") {
    const output = boundToolOutput(toolOutput(part)).output
    return utf8Size(output) + utf8Size(toolArgumentPreview(part.state.input)) + MAX_TOOL_ACTIVITY_CHROME_BYTES
  }
  return 0
}

function activityProjection(parts: Part[], reserveToolDetails: boolean): ActivityEntry[] {
  // The transcript may contain a very large part history. Keep the live tail
  // bounded before measuring, rendering, or finding its final text. The marker
  // accounts for the prefix that is deliberately left to the transcript view.
  const omittedPrefix = Math.max(0, parts.length - (MAX_ACTIVITY_NODES - 1))
  const visibleParts = omittedPrefix > 0 ? parts.slice(omittedPrefix) : parts
  const maxNodes = MAX_ACTIVITY_NODES - (omittedPrefix > 0 ? 1 : 0)
  const reservedDetails = reserveToolDetails && visibleParts.some((part) => part.type === "tool") ? MAX_TOOL_DETAILS_BYTES : 0
  const maxActivityBytes = MAX_ACTIVITY_BYTES - reservedDetails
  if (omittedPrefix === 0 && visibleParts.length <= maxNodes) {
    let totalBytes = 0
    let withinByteLimit = true
    for (const part of visibleParts) {
      totalBytes += activityPartBytes(part)
      if (totalBytes > maxActivityBytes) {
        withinByteLimit = false
        break
      }
    }
    if (withinByteLimit) return visibleParts.map((part) => ({ kind: "part", part }))
  }

  const finalTextIndex = visibleParts.findLastIndex((part) => part.type === "text")
  const finalText = finalTextIndex >= 0 ? boundedFinalText(visibleParts[finalTextIndex] as TextPart) : undefined
  const reserveFinalBytes = finalText?.bytes ?? 0
  const entries: ActivityEntry[] = []
  let usedBytes = 0
  if (omittedPrefix > 0) {
    entries.push({ kind: "limit", omitted: omittedPrefix })
    usedBytes = PART_LIMIT_MARKER_BYTES
  }

  for (let index = 0; index < visibleParts.length; index++) {
    if (index === finalTextIndex) {
      entries.push({ kind: "part", part: finalText!.part })
      continue
    }

    const remainingAfter = visibleParts.length - index - 1
    const reserveNodes = (finalTextIndex > index ? 2 : 1) // omission marker and final text, when present
    const exceedsNodes = entries.length + 1 + reserveNodes > maxNodes
    const partBytes = activityPartBytes(visibleParts[index])
    const exceedsBytes = usedBytes + partBytes + reserveFinalBytes + PART_LIMIT_MARKER_BYTES > maxActivityBytes
    if (exceedsNodes || exceedsBytes) {
      const omitted = visibleParts.length - index - (finalTextIndex >= index ? 1 : 0)
      if (omitted > 0) entries.push({ kind: "limit", omitted })
      if (finalTextIndex >= index) entries.push({ kind: "part", part: finalText!.part })
      break
    }

    entries.push({ kind: "part", part: visibleParts[index] })
    usedBytes += partBytes
    if (remainingAfter > 0 && index + 1 < visibleParts.length && entries.length + (finalTextIndex > index ? 2 : 1) >= maxNodes) {
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
  const finalTextID = createMemo(() => props.parts.slice(-MAX_ACTIVITY_NODES).findLast((part) => part.type === "text")?.id)
  const entries = createMemo(() => activityProjection(props.parts, Boolean(props.renderToolDetails)))
  const cards = createMemo(() => {
    const visibleTools = entries().flatMap((entry) => entry.kind === "part" && entry.part.type === "tool" ? [entry.part] : [])
    return new Map(projectActivityCards(visibleTools).flatMap((card) => card.sourcePartIds.map((id) => [id, card] as const)))
  })

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
          const card = cards().get(part.id)
          if (card?.sourcePartIds[0] !== undefined && card.sourcePartIds[0] !== part.id) return null
          return (
            <ToolActivity
              part={part}
              card={card}
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

function ProgressSummary(props: { part: ReasoningPart }) {
  const { theme } = useTheme()
  const card = createMemo(() => projectProgressCard(props.part))
  return (
    <box paddingLeft={3} marginTop={1}>
      <text fg={theme.textMuted}>{card().titleLine}</text>
    </box>
  )
}

function ToolActivity(props: {
  part: ToolPart
  card?: ActivityCardV1
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
  const status = createMemo(() => props.card ? { label: props.card.state === "unknown" ? "UNKNOWN" : props.card.state[0]!.toUpperCase() + props.card.state.slice(1) } : toolStatus(props.part))
  const toolName = createMemo(() => safeToolName(props.part.tool))
  const statusColor = createMemo(() => {
    if (props.part.state.status === "error") return theme.error
    if (props.part.state.status === "completed") return theme.textMuted
    return theme.warning
  })
  const args = createMemo(() => toolArgumentPreview(props.part.state.input))
  const details = createMemo(() => {
    const value = sanitizeToolDisplayValue(props.part)
    // A malformed, accessor-backed, or over-budget tool part may be omitted by
    // the sanitizer. Never pass that failure through a type assertion to a
    // detail renderer; the bounded summary/output remains available instead.
    return value && typeof value === "object" ? value as ToolPart : undefined
  })
  // §31.5/§31.17: `UNKNOWN` is a producer/receipt lifecycle outcome, never an
  // artifact fidelity value. Only `FULL`/`SAMPLE`/`FAILED` are fidelity labels;
  // an unresolvable fidelity is surfaced as lifecycle text instead.
  const artifact = createMemo(() => {
    const projected = toolArtifactFidelity("metadata" in props.part.state ? props.part.state.metadata : undefined)
    const fidelity = projected.visible && projected.fidelity !== "UNKNOWN" ? projected.fidelity : undefined
    return { visible: projected.visible, fidelity }
  })
  const canExpand = createMemo(() => Boolean(output()) || Boolean(props.renderDetails && details()))
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
        {props.card?.titleLine ?? `${status().label} ${toolName()}${args() ? ` ${args()}` : ""}`}
        <Show when={props.card && props.card.kind !== "shell"}>
          <span style={{ fg: theme.textMuted }}> · {status().label}</span>
        </Show>
        <Show when={props.card?.durationMs !== undefined}>
          <span style={{ fg: theme.textMuted }}> · {formatActivityDuration(props.card!.durationMs!)}</span>
        </Show>
      </text>
      <Show when={artifact().visible}>
        <text fg={theme.textMuted}>
          {artifact().fidelity
            ? `Output artifact: ${artifact().fidelity}`
            : "Output artifact · fidelity unknown"}
        </text>
      </Show>
      <Show when={output() && props.expanded}>
        <text fg={theme.text}>{visibleOutput()}</text>
      </Show>
      <Show when={bounded().truncated && props.expanded}>
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
      {props.expanded && props.renderDetails && details() ? props.renderDetails(details()!) : null}
    </box>
  )
}

function toolStatus(part: ToolPart) {
  if (part.state.status === "pending") return { label: "Starting" }
  if (part.state.status === "running") return { label: "Running" }
  if (part.state.status === "completed") return { label: "Succeeded" }
  if ("metadata" in part.state && part.state.metadata?.receiptState === "unknown") return { label: "UNKNOWN" }
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
