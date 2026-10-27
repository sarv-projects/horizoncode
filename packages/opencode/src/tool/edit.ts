// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Buffer } from "node:buffer"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import type { EffectLease, ManagedAttemptScopeV1, PatchOperation } from "@opencode-ai/core/session/supervisor"
import type { ManagedAttemptAuthority } from "@/session/managed-control"
import {
  acceptDirectAttemptReceipt,
  acceptDirectTurnBatchReceipt,
  settleToolBatchLease,
  type ToolBatchDirectAttemptAuthority,
} from "@/session/tool-batch"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = FSUtil.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  oldString: Schema.String.annotate({ description: "The text to replace" }),
  newString: Schema.String.annotate({
    description: "The text to replace it with (must be different from oldString)",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString (default false)",
  }),
})


export type EditParameters = Schema.Schema.Type<typeof Parameters>

export type PreparedEditBatch = {
  readonly filePath: string
  readonly contentOld: string
  readonly contentNew: string
  readonly diff: string
  readonly event: "add" | "change"
  readonly operations: ReadonlyArray<PatchOperation>
}

function isWithinWorkspace(root: string, candidate: string, allowRoot = false) {
  const relative = path.relative(root, candidate)
  if (allowRoot && relative === "") return true
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function isEffectLease(value: unknown): value is EffectLease {
  if (typeof value !== "object" || value === null) return false
  return (
    "effectID" in value &&
    typeof value.effectID === "string" &&
    "capabilityLeaseDigest" in value &&
    typeof value.capabilityLeaseDigest === "string" &&
    /^blake3:[0-9a-f]{64}$/.test(value.capabilityLeaseDigest)
  )
}

export const prepareEditBatch = Effect.fn("EditTool.prepareBatch")(function* (
  params: EditParameters,
  workspaceRoot: string,
  afs: FSUtil.Interface,
) {
  if (!params.filePath) throw new Error("filePath is required")
  if (params.oldString === params.newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  const root = path.resolve(yield* afs.resolve(workspaceRoot))
  const requestedPath = path.resolve(root, params.filePath)
  if (!isWithinWorkspace(root, requestedPath)) {
    throw new Error("Edit denied: path escapes the workspace")
  }

  let filePath: string
  const existed = yield* afs.existsSafe(requestedPath)
  if (existed) {
    filePath = path.resolve(yield* afs.resolve(requestedPath))
    if (!isWithinWorkspace(root, filePath)) {
      throw new Error("Edit denied: path escapes the workspace")
    }
  } else {
    const parent = path.resolve(yield* afs.resolve(path.dirname(requestedPath)))
    if (!isWithinWorkspace(root, parent, true)) {
      throw new Error("Edit denied: path escapes the workspace")
    }
    filePath = path.join(parent, path.basename(requestedPath))
  }

  let contentOld = ""
  let contentNew = ""
  let diff = ""
  let bom = false
  let expectedBeforeBase64: string | null = null
  let event: "add" | "change" = "add"

  if (params.oldString === "") {
    if (existed) {
      throw new Error(
        "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
      )
    }
    const next = Bom.split(params.newString)
    bom = next.bom
    contentNew = next.text
    diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
  } else {
    const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info) throw new Error(`File ${filePath} not found`)
    if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
    const bytes = yield* afs.readFile(filePath)
    const source = Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
    contentOld = source.text

    const ending = detectLineEnding(contentOld)
    const old = convertToLineEnding(normalizeLineEndings(params.oldString), ending)
    const replacement = convertToLineEnding(normalizeLineEndings(params.newString), ending)
    const next = Bom.split(replace(contentOld, old, replacement, params.replaceAll))
    bom = source.bom || next.bom
    contentNew = next.text
    expectedBeforeBase64 = Buffer.from(bytes).toString("base64")
    event = "change"
    diff = trimDiff(
      createTwoFilesPatch(
        filePath,
        filePath,
        normalizeLineEndings(contentOld),
        normalizeLineEndings(contentNew),
      ),
    )
  }

  const operations: PatchOperation[] = [
    {
      operation: "write",
      path: filePath,
      expectedBeforeBase64,
      contentBase64: Buffer.from(Bom.join(contentNew, bom), "utf8").toString("base64"),
    },
  ]
  return { filePath, contentOld, contentNew, diff, event, operations }
})

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const supervisor = yield* SessionSupervisor.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      capability: { id: "files.patch", effectClass: "effect" },
      execute: (params: EditParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const initial = yield* prepareEditBatch(params, instance.directory, afs)

          return yield* lock(initial.filePath).withPermits(1)(
            Effect.gen(function* () {
              const prepared = yield* prepareEditBatch(params, instance.directory, afs)
              const guardedPatch = ctx.extra?.guardedPatch
              const lease = ctx.extra?.guardedLease
              if (
                !Array.isArray(guardedPatch) ||
                JSON.stringify(guardedPatch) !== JSON.stringify(prepared.operations) ||
                !isEffectLease(lease)
              ) {
                throw new Error("Edit denied: guarded operation set or lease changed")
              }
              const trustedPrincipal = ctx.trustedPrincipal
              if (trustedPrincipal?.kind !== "server_auth" || !trustedPrincipal.subject) {
                throw new Error("Edit denied: missing authenticated principal")
              }

              const managedAttempt = ctx.extra?.managedAttempt as ManagedAttemptAuthority | undefined
              const managedAttemptScope = managedAttempt?.currentScope()
              const directAttempt = ctx.extra?.directAttempt as ToolBatchDirectAttemptAuthority | undefined
              const directAttemptScope = directAttempt?.currentScope()
              const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
              const receipt = yield* Effect.uninterruptible(
                supervisor.executePatch({
                  sessionID: ctx.sessionID,
                  locationRef,
                  lease,
                  operations: guardedPatch as ReadonlyArray<PatchOperation>,
                  trustedPrincipal,
                  ...(directAttemptScope !== undefined ? { directAttempt: directAttemptScope } : {}),
                  ...(directAttempt?.directTurn ? { directTurnScope: directAttempt.directTurn.currentScope() } : {}),
                  ...(managedAttemptScope !== undefined
                    ? { managedAttempt: managedAttemptScope as ManagedAttemptScopeV1 }
                    : {}),
                }),
              )
              const expected = new Map(prepared.operations.map((operation) => [operation.path, operation.operation]))
              if (
                receipt.effectID !== lease.effectID ||
                receipt.targets.length !== expected.size ||
                receipt.targets.some((target) => {
                  if (expected.get(target.target) !== target.operation) return true
                  expected.delete(target.target)
                  return false
                }) ||
                expected.size > 0
              ) {
                throw new Error("Edit denied: Rust receipt does not match the prepared operation set")
              }
              if (directAttemptScope && directAttempt) {
                if (!receipt.directAttempt || receipt.attemptScopeTransition !== "effect_receipt") {
                  throw new Error("Edit denied: HostKernel omitted direct Attempt receipt scope")
                }
                acceptDirectAttemptReceipt(directAttempt, directAttemptScope, receipt)
                if (directAttempt.directTurn && receipt.directTurnScope) {
                  yield* Effect.promise(() => acceptDirectTurnBatchReceipt(directAttempt, receipt))
                }
              }
              if (managedAttemptScope) {
                if (!receipt.managedAttempt || receipt.attemptScopeTransition !== "effect_receipt") {
                  throw new Error("Edit denied: HostKernel omitted managed receipt scope")
                }
                managedAttempt?.acceptRefreshedScope({
                  previous: managedAttemptScope,
                  refreshed: receipt.managedAttempt,
                  transition: "effect_receipt",
                })
              }
              yield* Effect.promise(() => settleToolBatchLease(lease, { effectID: receipt.effectID }))

              yield* events.publish(FileSystem.Event.Edited, { file: prepared.filePath })
              yield* events.publish(Watcher.Event.Updated, {
                file: prepared.filePath,
                event: prepared.event,
              })

              let additions = 0
              let deletions = 0
              for (const change of diffLines(prepared.contentOld, prepared.contentNew)) {
                if (change.added) additions += change.count || 0
                if (change.removed) deletions += change.count || 0
              }
              const filediff: Snapshot.FileDiff = {
                file: prepared.filePath,
                patch: prepared.diff,
                additions,
                deletions,
              }
              yield* ctx.metadata({
                metadata: {
                  diff: prepared.diff,
                  filediff,
                  diagnostics: {},
                },
              })

              let output = "Edit applied successfully."
              yield* lsp.touchFile(prepared.filePath, "document")
              const diagnostics = yield* lsp.diagnostics()
              const normalizedFilePath = FSUtil.normalizePath(prepared.filePath)
              const block = LSP.Diagnostic.report(prepared.filePath, diagnostics[normalizedFilePath] ?? [])
              if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

              return {
                metadata: {
                  diagnostics,
                  diff: prepared.diff,
                  filediff,
                },
                title: `${path.relative(instance.worktree, prepared.filePath)}`,
                output,
              }
            }),
          )
        }).pipe(Effect.orDie),
    }
  }),
)


export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)

  // Handle single line matches
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  // Try direct match with unescaped find string
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  // Also try finding escaped versions in content that match unescaped find
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  // This replacer yields all exact matches, allowing the replace function
  // to handle multiple occurrences based on replaceAll parameter
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) {
    // Need at least 3 lines to have meaningful context
    return
  }

  // Remove trailing empty line if present
  if (findLines[findLines.length - 1] === "") {
    findLines.pop()
  }

  const contentLines = content.split("\n")

  // Extract first and last lines as context anchors
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  // Find blocks that start and end with the context anchors
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    // Look for the matching last line
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found a potential context block
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")

        // Check if the middle content has reasonable similarity
        // (simple heuristic: at least 50% of non-empty lines should match when trimmed)
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break // Only match the first occurrence
          }
        }
        break
      }
    }
  }
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }
  if (oldString === "") {
    throw new Error(
      "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
    )
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
        )
      }
      if (replaceAll) {
        return content.replaceAll(search, newString)
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    )
  }
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
}

function isDisproportionateMatch(search: string, oldString: string) {
  const oldLines = oldString.split("\n").length
  const searchLines = search.split("\n").length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}
