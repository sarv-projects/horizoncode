import stripAnsi from "strip-ansi"

const MAX_SOURCE_BYTES = 256 * 1024
const MAX_RENDERED_BLOCKS = 32
const MAX_DIAGNOSTICS = 16
const MAX_MERMAID_EDGES = 128
const MAX_MERMAID_NODES = 64
const MAX_CHART_ROWS = 100
const MAX_BAR_WIDTH = 24

export type TuiArtifactRenderResult = {
  content: string
  diagnostics: string[]
}

type Fence = {
  character: "`" | "~"
  length: number
  language: string
}

type NumericCell = {
  value: number
  unit: string
  source: string
}

function sanitizeTerminalText(source: string) {
  return stripAnsi(source)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
}

function exceedsUtf8Limit(value: string, limit: number) {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x7f) bytes += 1
    else if (codeUnit <= 0x7ff) bytes += 2
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3

    if (bytes > limit) return true
  }
  return false
}

function openingFence(line: string): Fence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return
  const marker = match[2]
  if (!marker) return
  const info = match[3]?.trim() ?? ""
  const language = info.split(/\s+/, 1)[0]?.toLowerCase() ?? ""
  return {
    character: marker[0] as Fence["character"],
    length: marker.length,
    language,
  }
}

function closesFence(line: string, fence: Fence) {
  const match = /^ {0,3}(`+|~+)\s*$/.exec(line)
  return match?.[1]?.[0] === fence.character && (match[1]?.length ?? 0) >= fence.length
}

function longestBacktickRun(value: string) {
  let longest = 0
  let current = 0
  for (const character of value) {
    if (character === "`") {
      current++
      if (current > longest) longest = current
      continue
    }
    current = 0
  }
  return longest
}

function fencedText(value: string) {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1))
  return `${fence}text\n${value}\n${fence}`
}

function safeMermaidLabel(value: string | undefined, id: string) {
  if (value === undefined) return id
  const label = value.trim()
  if (!label || label.length > 80 || !/^[\p{L}\p{N} .,_()+/#-]+$/u.test(label)) return
  return label
}

function renderSimpleMermaid(source: string) {
  const [header, ...body] = source.split("\n")
  if (!/^(?:flowchart|graph)\s+(?:LR|RL|TB|TD|BT)$/i.test(header?.trim() ?? "")) return

  const nodes = new Set<string>()
  const edges: string[] = []
  const edgePattern = /^\s*([A-Za-z][A-Za-z0-9_]{0,31})(?:\[([^\]\r\n]{1,80})\])?\s*-->\s*([A-Za-z][A-Za-z0-9_]{0,31})(?:\[([^\]\r\n]{1,80})\])?\s*$/

  for (const line of body) {
    if (!line.trim()) continue
    const match = edgePattern.exec(line)
    if (!match) return
    const fromID = match[1]
    const toID = match[3]
    if (!fromID || !toID) return
    const from = safeMermaidLabel(match[2], fromID)
    const to = safeMermaidLabel(match[4], toID)
    if (!from || !to) return
    nodes.add(fromID)
    nodes.add(toID)
    if (nodes.size > MAX_MERMAID_NODES || edges.length >= MAX_MERMAID_EDGES) return
    edges.push(`${from} (${fromID}) → ${to} (${toID})`)
  }

  if (edges.length === 0) return
  return fencedText(edges.join("\n"))
}

function tableCells(line: string) {
  const trimmed = line.trim()
  if (!trimmed.includes("|") || /\\\|/.test(trimmed)) return
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  return body.split("|").map((cell) => cell.trim())
}

function parseNumericCell(source: string): NumericCell | undefined {
  const match = /^((?:\d+(?:\.\d*)?|\.\d+))(?:\s+([A-Za-z%][A-Za-z0-9%/_-]{0,15}))?$/.exec(source.trim())
  if (!match) return
  const value = Number(match[1])
  if (!Number.isFinite(value)) return
  return { value, unit: match[2] ?? "", source: source.trim() }
}

function renderNumericTable(lines: string[]) {
  if (lines.length < 4 || lines.length > MAX_CHART_ROWS + 2) return
  const header = tableCells(lines[0] ?? "")
  const divider = tableCells(lines[1] ?? "")
  if (header?.length !== 2 || divider?.length !== header.length) return
  if (!header[0] || !header[1] || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))) return

  const rows: Array<{ label: string; metric: NumericCell }> = []
  for (const line of lines.slice(2)) {
    const cells = tableCells(line)
    if (cells?.length !== 2 || !cells[0] || cells[0].length > 40) return
    const metric = parseNumericCell(cells[1] ?? "")
    if (!metric) return
    rows.push({ label: cells[0], metric })
  }
  if (rows.length < 2) return

  const unit = rows[0]?.metric.unit
  if (rows.some((row) => row.metric.unit !== unit)) return
  const maximum = Math.max(...rows.map((row) => row.metric.value))
  if (maximum <= 0) return

  const title = unit ? `${header[1]} (${unit})` : header[1]
  const chart = [
    title,
    ...rows.map((row) => {
      const width = Math.max(1, Math.round((row.metric.value / maximum) * MAX_BAR_WIDTH))
      const bar = "█".repeat(width)
      return `${row.label}  ${bar}  ${row.metric.source}`
    }),
  ]
  return fencedText(chart.join("\n"))
}

function addDiagnostic(diagnostics: string[], message: string) {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(message)
}

export function renderTuiArtifacts(source: string, options: { complete: boolean }): TuiArtifactRenderResult {
  const content = sanitizeTerminalText(source)
  const diagnostics: string[] = []
  if (!options.complete) return { content, diagnostics }
  if (exceedsUtf8Limit(content, MAX_SOURCE_BYTES)) {
    const message = `Artifact preview skipped: source exceeds the ${MAX_SOURCE_BYTES / 1024} KiB render limit.`
    return {
      content: `${content}\n\n[${message}]`,
      diagnostics: [message],
    }
  }

  const lines = content.split("\n")
  const output: string[] = []
  let renderedBlocks = 0
  let skippedBlocks = 0

  for (let index = 0; index < lines.length; ) {
    const fence = openingFence(lines[index] ?? "")
    if (fence) {
      let end = index + 1
      while (end < lines.length && !closesFence(lines[end] ?? "", fence)) end++
      if (end === lines.length) {
        output.push(...lines.slice(index))
        break
      }

      const block = lines.slice(index, end + 1).join("\n")
      const sourceBlock = lines.slice(index + 1, end).join("\n")
      output.push(block)
      if (fence.language === "svg") {
        if (renderedBlocks < MAX_RENDERED_BLOCKS) {
          const message = "SVG preview unavailable; source is shown as inert text."
          addDiagnostic(diagnostics, message)
          output.push(`[${message}]`)
        } else skippedBlocks++
        renderedBlocks++
      } else if (fence.language === "mermaid") {
        if (renderedBlocks < MAX_RENDERED_BLOCKS) {
          const preview = renderSimpleMermaid(sourceBlock)
          if (preview) output.push(preview)
          else {
            const message = "Mermaid preview unavailable for this grammar; source is shown as text."
            addDiagnostic(diagnostics, message)
            output.push(`[${message}]`)
          }
        } else skippedBlocks++
        renderedBlocks++
      }
      index = end + 1
      continue
    }

    const next = lines[index + 1]
    const header = tableCells(lines[index] ?? "")
    const divider = tableCells(next ?? "")
    if (header?.length === 2 && divider?.length === 2 && divider.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      let end = index + 2
      while (end < lines.length && tableCells(lines[end] ?? "")) end++
      const table = lines.slice(index, end)
      const preview = renderNumericTable(table)
      output.push(...table)
      if (preview) {
        if (renderedBlocks < MAX_RENDERED_BLOCKS) {
          output.push(preview)
          renderedBlocks++
        } else skippedBlocks++
      }
      index = end
      continue
    }

    output.push(lines[index] ?? "")
    index++
  }

  if (skippedBlocks > 0) {
    const message = `Preview limit reached; ${skippedBlocks} additional block${skippedBlocks === 1 ? "" : "s"} kept as source only.`
    addDiagnostic(diagnostics, message)
    output.push(`[${message}]`)
  }

  return { content: output.join("\n"), diagnostics }
}
