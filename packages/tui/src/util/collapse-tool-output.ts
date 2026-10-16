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
