export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@horizoncode/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly prune: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
  readonly turnSnapshot?: Config.TurnSnapshot
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[], turnSnapshot?: Config.TurnSnapshot) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  const result = configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      prune: current.prune ?? result.prune,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, prune: false, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
  return {
    ...result,
    auto: turnSnapshot?.compaction?.auto ?? result.auto,
    prune: turnSnapshot?.compaction?.prune ?? result.prune,
  }
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) break
    total = next
    split = index
  }
  return {
    head: conversation.slice(0, split).join("\n\n"),
    recent: conversation.slice(split).join("\n\n"),
  }
}

import {
  applyContextWindowPlanV1,
  clearContextWindowV1,
  planContextPruneV1,
  planContextTrimV1,
  planPressureRecoveryV1,
  pruneContextWindowV1,
  trimContextWindowV1,
} from "./context-compile-policy"
import type { ContextWindowPlanV1 } from "./context-compile-policy"

export {
  applyContextWindowPlanV1,
  clearContextWindowV1,
  ContextWindowPairError,
  planContextClearWindowV1,
  planContextPruneV1 as planPrune,
  planContextPruneWindowV1,
  planContextTrimV1 as planTrim,
  planContextTrimWindowV1,
  planPressureRecoveryV1 as planPressureRecovery,
  pruneContextWindowV1,
  trimContextWindowV1,
} from "./context-compile-policy"
export type {
  ContextCompactionEntryV1,
  ContextWindowOperationV1,
  ContextWindowPayloadReplacementV1,
  ContextWindowPlanV1,
  ContextWindowRewriteV1,
  ContextWindowToolPairErrorV1,
  ContextWindowToolPairTableV1,
  ContextWindowToolPairV1,
  PressureRecoveryPlanV1,
  PruneCandidateV1,
  PrunePlanV1,
  TrimCandidateV1,
  TrimPlanV1,
} from "./context-compile-policy"

/**
 * A-V2-13 ledger operation bounds. Trim, prune and clear rewrite the *model
 * window* for one provider request; they never delete a canonical history row.
 */
export type ContextWindowOpsOptions = {
  readonly protectRecentUserTurns?: number
  readonly minimumBytes?: number
  readonly protectedRefs?: readonly string[]
  readonly pinnedRefs?: readonly string[]
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) => {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  if (!input.previousSummary)
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
    ].join("\n\n")
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join("\n\n")
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config, dependencies.turnSnapshot)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > context - summaryOutput) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          http: input.request.http,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: selected.recent,
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  const autoTrimmedEpochIDs = new Set<string>()
  /**
   * §30.4 step 0 preview. The caller applies the returned trim plan at the next
   * compile boundary, then confirms with `autoTrimApplied` so this epoch never
   * auto-trims twice. `show` remains available for `/trim` without pressure.
   */
  const pressureRecovery = Effect.fn("SessionCompaction.pressureRecovery")(function* (
    input: Input & { readonly epochID: string; readonly autoTrimApplied?: boolean },
  ) {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.epochID)) throw new TypeError("context epoch identity is invalid")
    const plan = planPressureRecoveryV1({
      entries: input.entries,
      request: input.request,
      model: input.model,
      epochID: input.epochID,
      autoTrimmedEpochIDs: [...autoTrimmedEpochIDs],
    })
    if (plan.status === "auto_trim" && input.autoTrimApplied === true) autoTrimmedEpochIDs.add(input.epochID)
    return plan
  })
  /**
   * A-V2-13 `/trim`: rewrite old recoverable tool payloads to their placeholder
   * in the model window. No message, tool_call or tool_result is removed, so the
   * provider pairing and the canonical history both stay intact.
   */
  const trimWindow = (entries: readonly Entry[], options?: ContextWindowOpsOptions) =>
    trimContextWindowV1({
      entries,
      ...(options?.protectRecentUserTurns === undefined
        ? {}
        : { protectRecentUserTurns: options.protectRecentUserTurns }),
      ...(options?.minimumBytes === undefined ? {} : { minimumBytes: options.minimumBytes }),
    })
  /**
   * A-V2-13 `/prune`: drop eligible old tool results from the model window. The
   * assistant tool_call leaves together with its result as one atomic pair, so an
   * orphaned tool_call/tool_result pair can never reach the provider.
   */
  const pruneWindow = (entries: readonly Entry[], options?: ContextWindowOpsOptions) =>
    pruneContextWindowV1({
      entries,
      ...(options?.protectRecentUserTurns === undefined
        ? {}
        : { protectRecentUserTurns: options.protectRecentUserTurns }),
      ...(options?.minimumBytes === undefined ? {} : { minimumBytes: options.minimumBytes }),
      ...(options?.protectedRefs === undefined ? {} : { protectedRefs: options.protectedRefs }),
    })
  /**
   * A-V2-13 `/clear`: reset the model window to system context plus pinned refs.
   * Canonical history rows stay durable and readable.
   */
  const clearWindow = (entries: readonly Entry[], options?: ContextWindowOpsOptions) =>
    clearContextWindowV1({
      entries,
      ...(options?.pinnedRefs === undefined ? {} : { pinnedRefs: options.pinnedRefs }),
    })
  return {
    compactIfNeeded,
    compactAfterOverflow,
    pressureRecovery,
    trim: (entries: readonly Entry[]) => planContextTrimV1({ entries }),
    prune: (entries: readonly Entry[], protectedRefs?: readonly string[]) => planContextPruneV1({ entries, protectedRefs }),
    trimWindow,
    pruneWindow,
    clearWindow,
    applyWindowPlan: (entries: readonly Entry[], plan: ContextWindowPlanV1) =>
      applyContextWindowPlanV1({ entries, plan }),
  }
}
