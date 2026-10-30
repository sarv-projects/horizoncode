import type {
  AgentV2Info,
  CommandV2Info,
  IntegrationInfo,
  LocationRef,
  ModelV2Info,
  PermissionSavedInfo,
  PermissionV2Request,
  ProviderV2Info,
  QuestionRequest,
  QuestionV2Request,
  ReferenceInfo,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionV2Info,
  SkillV2Info,
  V2Event,
} from "@horizoncode/sdk/v2"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useEvent } from "./event"
import { createSignal, onCleanup, onMount } from "solid-js"
import { createUiEventMux } from "./ui-event-mux"
import { inspectUtf8ByteLength } from "../util/utf8"

type LocationData = {
  agent?: AgentV2Info[]
  command?: CommandV2Info[]
  integration?: IntegrationInfo[]
  model?: ModelV2Info[]
  provider?: ProviderV2Info[]
  reference?: ReferenceInfo[]
  skill?: SkillV2Info[]
}

type Data = {
  session: {
    info: Record<string, SessionV2Info>
    message: Record<string, SessionMessage[]>
    contextLedger: Record<string, ContextLedgerSnapshotV1 | undefined>
    permission: Record<string, PermissionV2Request[]>
    question: Record<string, SessionQuestionRequest[]>
  }
  project: {
    permission: Record<string, PermissionSavedInfo[]>
  }
  location: Record<string, LocationData>
}

type ContextLedgerSnapshotV1 = {
  readonly timestamp: number
  readonly requestID: string
  readonly requestSequence?: string
  readonly sourceRevision: string
  readonly sourceGeneration: string
  readonly ledger: Record<string, unknown>
  readonly ledgerDigest: string
}

export type SessionQuestionRequest =
  | { lane: "legacy"; request: QuestionRequest }
  | { lane: "v2"; request: QuestionV2Request }

/**
 * The generated V2 union omits this server-emitted ephemeral projection even
 * though its payload exists in the SDK/schema. Keep a local exact shape: the
 * ledger is display-only and never authorizes or blocks a provider send.
 */
type SessionContextLedgerEventV2 = {
  id: string
  metadata?: { [key: string]: unknown }
  type: "session.context_ledger"
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    requestID: string
    sourceRevision: string
    sourceGeneration: string
    ledger: Record<string, unknown>
    ledgerDigest: string
  }
}

type TuiEvent = V2Event | SessionContextLedgerEventV2

type StreamDeltaEvent =
  | Extract<V2Event, { type: "session.next.text.delta" }>
  | Extract<V2Event, { type: "session.next.reasoning.delta" }>
  | Extract<V2Event, { type: "session.next.tool.input.delta" }>

type StreamDeltaKind = StreamDeltaEvent["type"]

type StreamDelta = {
  sessionID: string
  assistantMessageID: string
  targetID: string
  key: string
  text: string
  /** Source-owned event ordinal. */
  sequence: number
  /** Source-owned stream generation. */
  sourceGeneration: string
  /** Separate UTF-16 offset used only to reconcile the rendered projection. */
  offset: number
  event: StreamDeltaEvent
}

function streamKey(kind: StreamDeltaKind, assistantMessageID: string, targetID: string) {
  return `${kind}:${assistantMessageID}:${targetID}`
}

function replaySeedKey(sessionID: string, partID: string, sourceGeneration: string) {
  return JSON.stringify([sessionID, partID, sourceGeneration])
}

function streamDelta(event: TuiEvent): StreamDelta | undefined {
  if ("durable" in event && event.durable) return
  switch (event.type) {
    case "session.next.text.delta":
      return {
        sessionID: event.data.sessionID,
        assistantMessageID: event.data.assistantMessageID,
        targetID: event.data.textID,
        key: streamKey(event.type, event.data.assistantMessageID, event.data.textID),
        text: event.data.delta,
        sequence: event.data.sequence,
        sourceGeneration: event.data.sourceGeneration,
        offset: event.data.offset,
        event,
      }
    case "session.next.reasoning.delta":
      return {
        sessionID: event.data.sessionID,
        assistantMessageID: event.data.assistantMessageID,
        targetID: event.data.reasoningID,
        key: streamKey(event.type, event.data.assistantMessageID, event.data.reasoningID),
        text: event.data.delta,
        sequence: event.data.sequence,
        sourceGeneration: event.data.sourceGeneration,
        offset: event.data.offset,
        event,
      }
    case "session.next.tool.input.delta":
      return {
        sessionID: event.data.sessionID,
        assistantMessageID: event.data.assistantMessageID,
        targetID: event.data.callID,
        key: streamKey(event.type, event.data.assistantMessageID, event.data.callID),
        text: event.data.delta,
        sequence: event.data.sequence,
        sourceGeneration: event.data.sourceGeneration,
        offset: event.data.offset,
        event,
      }
  }
}

function eventSessionID(event: TuiEvent) {
  const data = event.data
  if (typeof data !== "object" || data === null) return
  const sessionID = (data as { sessionID?: unknown }).sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function questionKey(lane: SessionQuestionRequest["lane"], requestID: string) {
  return `${lane}:${requestID}`
}

function rememberQuestionChange(
  changesBySession: Map<string, Map<string, SessionQuestionRequest | null>>,
  sessionID: string,
  key: string,
  request: SessionQuestionRequest | null,
) {
  let changes = changesBySession.get(sessionID)
  if (!changes) changesBySession.set(sessionID, (changes = new Map()))
  changes.set(key, request)
}

function locationKey(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID])
}

function locationQuery(ref?: LocationRef) {
  return ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: () => {
    const [store, setStore] = createStore<Data>({
      session: {
        info: {},
        message: {},
        contextLedger: {},
        permission: {},
        question: {},
      },
      project: {
        permission: {},
      },
      location: {},
    })
    // Resnapshot deltas belong to this Data owner. A module-global map can
    // leak one TUI provider's owner-scoped question state into another.
    const questionChanges = new Map<string, Map<string, SessionQuestionRequest | null>>()
    const latestPromptBoundary = new Map<string, number>()
    const latestPromptGeneration = new Map<string, string>()
    const maxU64 = "18446744073709551615"
    const isU64 = (value: string) => /^(0|[1-9][0-9]{0,19})$/.test(value) &&
      (value.length < maxU64.length || (value.length === maxU64.length && value <= maxU64))

    const compareDecimal = (left: string, right: string) => {
      if (left.length !== right.length) return left.length - right.length
      return left.localeCompare(right)
    }

    const sdk = useSDK()
    const events = useEvent()
    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({
      directory: sdk.directory ?? process.cwd(),
    })

    const message = {
      update(sessionID: string, fn: (messages: SessionMessage[]) => void) {
        setStore(
          "session",
          "message",
          produce((draft) => {
            fn((draft[sessionID] ??= []))
          }),
        )
      },
      prepend(messages: SessionMessage[], item: SessionMessage) {
        if (messages.some((existing) => existing.id === item.id)) return
        messages.unshift(item)
      },
      activeAssistant(messages: SessionMessage[]) {
        const item = messages.find((item) => item.type === "assistant" && !item.time.completed)
        return item?.type === "assistant" ? item : undefined
      },
      assistant(messages: SessionMessage[], messageID: string) {
        const item = messages.find((item) => item.type === "assistant" && item.id === messageID)
        return item?.type === "assistant" ? item : undefined
      },
      activeShell(messages: SessionMessage[], callID: string) {
        const item = messages.find((item) => item.type === "shell" && item.callID === callID)
        return item?.type === "shell" ? item : undefined
      },
      latestTool(assistant: SessionMessageAssistant | undefined, callID?: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantTool =>
            item.type === "tool" && (callID === undefined || item.id === callID),
        )
      },
      latestText(assistant: SessionMessageAssistant | undefined, textID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantText => item.type === "text" && item.id === textID,
        )
      },
      latestReasoning(assistant: SessionMessageAssistant | undefined, reasoningID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && item.id === reasoningID,
        )
      },
    }

    function handleEvent(event: TuiEvent) {
      switch (event.type) {
        case "catalog.updated":
          void Promise.all([
            result.location.model.refresh(event.location),
            result.location.provider.refresh(event.location),
          ])
          break
        case "session.next.agent.switched":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "agent-switched",
              agent: event.data.agent,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.model.switched":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "model-switched",
              model: event.data.model,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.prompted": {
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "user",
              text: event.data.prompt.text,
              files: event.data.prompt.files,
              agents: event.data.prompt.agents,
              time: { created: event.data.timestamp },
            })
          })
          break
        }
        case "session.next.prompt.admitted":
          latestPromptBoundary.set(event.data.sessionID, event.data.timestamp)
          latestPromptGeneration.set(event.data.sessionID, event.data.messageID)
          while (latestPromptBoundary.size > 4096) {
            const oldest = latestPromptBoundary.keys().next().value
            if (oldest === undefined) break
            latestPromptBoundary.delete(oldest)
            latestPromptGeneration.delete(oldest)
          }
          setStore("session", "contextLedger", event.data.sessionID, undefined)
          break
        case "session.context_ledger": {
          const data = event.data
          const ledger = data.ledger
          const cutoff = latestPromptBoundary.get(data.sessionID) ?? 0
          const activeGeneration = latestPromptGeneration.get(data.sessionID)
          const previous = store.session.contextLedger[data.sessionID]
          const priorSequence = previous?.requestSequence
          const previousRevision = previous?.sourceRevision
          const sameGeneration = previous !== undefined && previous.sourceGeneration === data.sourceGeneration
          const selection = typeof ledger === "object" && ledger !== null && !Array.isArray(ledger)
            ? (ledger as Record<string, unknown>).contextSelection
            : undefined
          const requestSequence = typeof selection === "object" && selection !== null && !Array.isArray(selection)
            ? (selection as Record<string, unknown>).requestSequence
            : undefined
          const selectionRecord = typeof selection === "object" && selection !== null && !Array.isArray(selection)
            ? selection as Record<string, unknown>
            : undefined
          let ledgerBytes = Number.POSITIVE_INFINITY
          try {
            ledgerBytes = Buffer.byteLength(JSON.stringify(ledger), "utf8")
          } catch {
            break
          }
          if (
            !Number.isFinite(data.timestamp) || data.timestamp < cutoff ||
            !activeGeneration || data.sourceGeneration !== activeGeneration ||
            !/^[A-Za-z0-9._:-]{1,256}$/.test(data.requestID) ||
            !isU64(data.sourceRevision) ||
            !/^blake3:[0-9a-f]{64}$/.test(data.ledgerDigest) ||
            typeof ledger !== "object" || ledger === null || Array.isArray(ledger) ||
            ledger.sessionID !== data.sessionID || ledger.requestID !== data.requestID ||
            ledger.sourceRevision !== data.sourceRevision ||
            !selectionRecord || selectionRecord.sessionID !== data.sessionID ||
            selectionRecord.requestID !== data.requestID || selectionRecord.sourceRevision !== data.sourceRevision ||
            selectionRecord.lane !== ledger.lane ||
            (ledger.lane === "managed" && (typeof requestSequence !== "string" || !isU64(requestSequence) ||
              typeof selectionRecord.attemptID !== "string")) ||
            (requestSequence !== undefined && (typeof requestSequence !== "string" || !isU64(requestSequence))) ||
            (sameGeneration && previousRevision !== undefined && compareDecimal(data.sourceRevision, previousRevision) < 0) ||
            (sameGeneration && previousRevision !== undefined && data.sourceRevision === previousRevision &&
              (ledger.lane === "managed"
                ? (typeof requestSequence !== "string" || (priorSequence !== undefined && compareDecimal(requestSequence, priorSequence) <= 0))
                : (previous!.requestID === data.requestID || data.timestamp < previous!.timestamp))) ||
            ledgerBytes > 48 * 1024
          ) break
          setStore("session", "contextLedger", data.sessionID, {
            timestamp: data.timestamp,
            requestID: data.requestID,
            ...(typeof requestSequence === "string" ? { requestSequence } : {}),
            sourceRevision: data.sourceRevision,
            sourceGeneration: data.sourceGeneration,
            ledger,
            ledgerDigest: data.ledgerDigest,
          })
          break
        }
        case "session.next.context.updated":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "system",
              text: event.data.text,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.synthetic":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "synthetic",
              sessionID: event.data.sessionID,
              text: event.data.text,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.shell.started":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "shell",
              callID: event.data.callID,
              command: event.data.command,
              output: "",
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.shell.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.activeShell(draft, event.data.callID)
            if (!match) return
            match.output = event.data.output
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.step.started":
          message.update(event.data.sessionID, (draft) => {
            if (draft.some((message) => message.id === event.data.assistantMessageID)) return
            const currentAssistant = message.activeAssistant(draft)
            if (currentAssistant) currentAssistant.time.completed = event.data.timestamp
            message.prepend(draft, {
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.step.ended":
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.data.timestamp
            currentAssistant.finish = event.data.finish
            currentAssistant.cost = event.data.cost
            currentAssistant.tokens = event.data.tokens
            if (event.data.snapshot)
              currentAssistant.snapshot = { ...currentAssistant.snapshot, end: event.data.snapshot }
          })
          break
        case "session.next.step.failed":
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.data.timestamp
            currentAssistant.finish = "error"
            currentAssistant.error = event.data.error
          })
          break
        case "session.next.text.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "text",
              id: event.data.textID,
              text: "",
            })
          })
          if (event.data.sourceGeneration) {
            const partID = streamKey("session.next.text.delta", event.data.assistantMessageID, event.data.textID)
            streamMux.resetStream({ sessionID: event.data.sessionID, partID, sourceGeneration: event.data.sourceGeneration, sequence: 0 })
            markReplaySeeded(replaySeedKey(event.data.sessionID, partID, event.data.sourceGeneration))
          }
          break
        case "session.next.text.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestText(message.assistant(draft, event.data.assistantMessageID), event.data.textID)
            if (match) match.text += event.data.delta
          })
          break
        case "session.next.text.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestText(message.assistant(draft, event.data.assistantMessageID), event.data.textID)
            if (match) match.text = event.data.text
          })
          const endedPartID = streamKey("session.next.text.delta", event.data.assistantMessageID, event.data.textID)
          if (event.data.sourceGeneration && event.data.sequence !== undefined) {
            streamMux.seedStream({ sessionID: event.data.sessionID, partID: endedPartID, sourceGeneration: event.data.sourceGeneration, sequence: event.data.sequence })
            streamMux.sealStream({ sessionID: event.data.sessionID, partID: endedPartID, sourceGeneration: event.data.sourceGeneration, sequence: event.data.sequence })
          } else streamMux.forgetStream(event.data.sessionID, endedPartID)
          break
        case "session.next.tool.input.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "tool",
              id: event.data.callID,
              name: event.data.name,
              time: { created: event.data.timestamp },
              state: { status: "pending", input: "" },
            })
          })
          if (event.data.sourceGeneration) {
            const partID = streamKey("session.next.tool.input.delta", event.data.assistantMessageID, event.data.callID)
            streamMux.resetStream({ sessionID: event.data.sessionID, partID, sourceGeneration: event.data.sourceGeneration, sequence: 0 })
            markReplaySeeded(replaySeedKey(event.data.sessionID, partID, event.data.sourceGeneration))
          }
          break
        case "session.next.tool.input.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status === "pending") match.state.input += event.data.delta
          })
          break
        case "session.next.tool.input.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status === "pending") match.state.input = event.data.text
          })
          const inputEndedPartID = streamKey("session.next.tool.input.delta", event.data.assistantMessageID, event.data.callID)
          if (event.data.sourceGeneration && event.data.sequence !== undefined) {
            streamMux.seedStream({ sessionID: event.data.sessionID, partID: inputEndedPartID, sourceGeneration: event.data.sourceGeneration, sequence: event.data.sequence })
            streamMux.sealStream({ sessionID: event.data.sessionID, partID: inputEndedPartID, sourceGeneration: event.data.sourceGeneration, sequence: event.data.sequence })
          } else streamMux.forgetStream(event.data.sessionID, inputEndedPartID)
          break
        case "session.next.tool.called":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (!match) return
            match.time.ran = event.data.timestamp
            match.provider = event.data.provider
            match.state = { status: "running", input: event.data.input, structured: {}, content: [] }
          })
          break
        case "session.next.tool.progress":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status !== "running") return
            match.state.structured = event.data.structured
            match.state.content = [...event.data.content]
          })
          break
        case "session.next.tool.success":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status !== "running") return
            match.state = {
              status: "completed",
              input: match.state.input,
              structured: event.data.structured,
              content: [...event.data.content],
              result: event.data.result,
            }
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.tool.failed":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (!match || (match.state.status !== "pending" && match.state.status !== "running")) return
            match.state = {
              status: "error",
              error: event.data.error,
              input: typeof match.state.input === "string" ? {} : match.state.input,
              structured: match.state.status === "running" ? match.state.structured : {},
              content: match.state.status === "running" ? match.state.content : [],
              result: event.data.result,
            }
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.reasoning.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "reasoning",
              id: event.data.reasoningID,
              text: "",
              providerMetadata: event.data.providerMetadata,
            })
          })
          if (event.data.sourceGeneration) {
            const partID = streamKey("session.next.reasoning.delta", event.data.assistantMessageID, event.data.reasoningID)
            streamMux.resetStream({ sessionID: event.data.sessionID, partID, sourceGeneration: event.data.sourceGeneration, sequence: 0 })
            markReplaySeeded(replaySeedKey(event.data.sessionID, partID, event.data.sourceGeneration))
          }
          break
        case "session.next.reasoning.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.data.assistantMessageID),
              event.data.reasoningID,
            )
            if (match) match.text += event.data.delta
          })
          break
        case "session.next.reasoning.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.data.assistantMessageID),
              event.data.reasoningID,
            )
            if (match) {
              match.text = event.data.text
              if (event.data.providerMetadata !== undefined) match.providerMetadata = event.data.providerMetadata
            }
          })
          const reasoningEndedPartID = streamKey("session.next.reasoning.delta", event.data.assistantMessageID, event.data.reasoningID)
          if (event.data.sourceGeneration && event.data.sequence !== undefined) {
            streamMux.seedStream({ sessionID: event.data.sessionID, partID: reasoningEndedPartID, sourceGeneration: event.data.sourceGeneration, sequence: event.data.sequence })
            streamMux.sealStream({ sessionID: event.data.sessionID, partID: reasoningEndedPartID, sourceGeneration: event.data.sourceGeneration, sequence: event.data.sequence })
          } else streamMux.forgetStream(event.data.sessionID, reasoningEndedPartID)
          break
        case "session.next.retried":
        case "session.next.compaction.started":
        case "session.next.compaction.delta":
          break
        case "session.next.compaction.ended":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "compaction",
              reason: event.data.reason,
              summary: event.data.text,
              recent: event.data.recent,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "question.v2.asked": {
          const request: QuestionV2Request = {
            id: event.data.id,
            sessionID: event.data.sessionID,
            questions: event.data.questions,
            ...(event.data.tool ? { tool: event.data.tool } : {}),
          }
          const projected: SessionQuestionRequest = { lane: "v2", request }
          rememberQuestionChange(questionChanges, request.sessionID, questionKey("v2", request.id), projected)
          if (!store.session.question[request.sessionID]) {
            setStore("session", "question", request.sessionID, [projected])
            break
          }
          setStore(
            "session",
            "question",
            request.sessionID,
            produce((draft) => {
              const index = draft.findIndex((item) => item.lane === "v2" && item.request.id === request.id)
              if (index === -1) draft.push(projected)
              else draft[index] = projected
            }),
          )
          break
        }
        case "question.v2.replied":
        case "question.v2.rejected": {
          const { sessionID, requestID } = event.data
          rememberQuestionChange(questionChanges, sessionID, questionKey("v2", requestID), null)
          const requests = store.session.question[sessionID]
          if (!requests) break
          const index = requests.findIndex((item) => item.lane === "v2" && item.request.id === requestID)
          if (index === -1) break
          setStore(
            "session",
            "question",
            sessionID,
            produce((draft) => {
              draft.splice(index, 1)
            }),
          )
          break
        }
        case "question.asked": {
          const request: QuestionRequest = {
            id: event.data.id,
            sessionID: event.data.sessionID,
            questions: event.data.questions,
            ...(event.data.tool ? { tool: event.data.tool } : {}),
          }
          const projected: SessionQuestionRequest = { lane: "legacy", request }
          rememberQuestionChange(questionChanges, request.sessionID, questionKey("legacy", request.id), projected)
          if (!store.session.question[request.sessionID]) {
            setStore("session", "question", request.sessionID, [projected])
            break
          }
          setStore(
            "session",
            "question",
            request.sessionID,
            produce((draft) => {
              const index = draft.findIndex((item) => item.lane === "legacy" && item.request.id === request.id)
              if (index === -1) draft.push(projected)
              else draft[index] = projected
            }),
          )
          break
        }
        case "question.replied":
        case "question.rejected": {
          const { sessionID, requestID } = event.data
          rememberQuestionChange(questionChanges, sessionID, questionKey("legacy", requestID), null)
          const requests = store.session.question[sessionID]
          if (!requests) break
          const index = requests.findIndex((item) => item.lane === "legacy" && item.request.id === requestID)
          if (index === -1) break
          setStore(
            "session",
            "question",
            sessionID,
            produce((draft) => {
              draft.splice(index, 1)
            }),
          )
          break
        }
        case "reference.updated":
          void result.location.reference.refresh()
          break
        case "integration.updated":
          void Promise.all([
            result.location.integration.refresh(event.location),
            result.location.model.refresh(event.location),
            result.location.provider.refresh(event.location),
          ])
          break
      }
    }

    const seenDeltaEventIDs = new Map<string, true>()
    const replaySeeded = new Set<string>()
    // A canonical page read can overlap live source deltas. Track arrivals
    // independently of the paint queue so a stale page set is never allowed
    // to replace a projection that advanced while pagination was in flight.
    const liveDeltaGeneration = new Map<string, number>()
    const refreshInFlight = new Map<string, Promise<void>>()
    const refreshAgain = new Set<string>()

    function markLiveSessionChange(sessionID: string) {
      const next = (liveDeltaGeneration.get(sessionID) ?? 0) + 1
      // Keep this recovery-only fence bounded even if a stream mentions many
      // Sessions that are no longer loaded in this Data owner.
      liveDeltaGeneration.delete(sessionID)
      liveDeltaGeneration.set(sessionID, next)
      while (liveDeltaGeneration.size > 4096) {
        const oldest = [...liveDeltaGeneration.keys()].find((id) => !refreshInFlight.has(id))
        if (oldest === undefined) break
        liveDeltaGeneration.delete(oldest)
      }
    }

    function markReplaySeeded(key: string) {
      replaySeeded.delete(key)
      replaySeeded.add(key)
      while (replaySeeded.size > 4096) {
        const oldest = replaySeeded.values().next().value
        if (oldest === undefined) break
        replaySeeded.delete(oldest)
      }
    }

    function rememberDeltaEventID(id: unknown) {
      if (typeof id !== "string" || id.length === 0) return true
      if (seenDeltaEventIDs.has(id)) return false
      seenDeltaEventIDs.set(id, true)
      if (seenDeltaEventIDs.size > 4096) {
        const oldest = seenDeltaEventIDs.keys().next().value
        if (oldest !== undefined) seenDeltaEventIDs.delete(oldest)
      }
      return true
    }

    async function refreshSessionMessages(sessionID: string) {
      const existing = refreshInFlight.get(sessionID)
      if (existing) {
        refreshAgain.add(sessionID)
        return existing
      }
      const task = (async () => {
        const pageSize = 100
        const historyLimit = 10_000
        // One retry handles a finite burst during pagination. If the source is
        // still advancing, preserve the live projection and its cursor; the
        // next gap/reconnect will request another canonical read.
        for (let pass = 0; pass < 2; pass++) {
          refreshAgain.delete(sessionID)
          streamMux.flush(sessionID)
          const generation = liveDeltaGeneration.get(sessionID) ?? 0
          const pages: SessionMessage[][] = []
          let result = await sdk.client.v2.session.messages(
            { sessionID, limit: pageSize, order: "desc" },
            { throwOnError: true },
          )
          pages.push(result.data.data)
          let loaded = result.data.data.length
          let older = result.data.cursor.previous
          while (older && loaded < historyLimit) {
            result = await sdk.client.v2.session.messages(
              {
                sessionID,
                limit: Math.min(pageSize, historyLimit - loaded),
                order: "desc",
                cursor: older,
              },
              { throwOnError: true },
            )
            if (result.data.data.length === 0) break
            pages.push(result.data.data)
            loaded += result.data.data.length
            older = result.data.cursor.previous
          }
          const canonical = pages.reverse().flatMap((page) => page.toReversed())
          streamMux.flush(sessionID)
          if ((liveDeltaGeneration.get(sessionID) ?? 0) !== generation || refreshAgain.has(sessionID)) {
            if (pass === 0) continue
            return
          }
          streamMux.forgetStream(sessionID)
          for (const key of replaySeeded) {
            const [owner] = JSON.parse(key) as [string, string, string]
            if (owner === sessionID) replaySeeded.delete(key)
          }
          setStore("session", "message", sessionID, canonical)
          liveDeltaGeneration.delete(sessionID)
          return
        }
      })()
      refreshInFlight.set(sessionID, task)
      try {
        await task
      } finally {
        refreshInFlight.delete(sessionID)
        refreshAgain.delete(sessionID)
      }
    }

    async function refreshSessionMessagesUntilSuccessful(sessionID: string, signal: AbortSignal) {
      let failures = 0
      while (!signal.aborted) {
        try {
          await refreshSessionMessages(sessionID)
          return
        } catch {
          if (signal.aborted) return
          const delay = Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000)
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve()
            const finish = () => {
              clearTimeout(timer)
              signal.removeEventListener("abort", finish)
              resolve()
            }
            const timer = setTimeout(finish, delay)
            signal.addEventListener("abort", finish, { once: true })
          })
        }
      }
    }

    const resnapshotAbortController = new AbortController()
    const resnapshotSessions = new Set<string>()
    const MAX_RESNAPSHOT_SESSIONS = 64
    function requestResnapshot(sessionID: string) {
      // A malformed/off-scope event must not turn the recovery path into an
      // unbounded set of HTTP refresh loops. Session IDs are owner-generated;
      // cap both their accepted shape and concurrent recovery work.
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sessionID) ||
        resnapshotSessions.has(sessionID) ||
        resnapshotSessions.size >= MAX_RESNAPSHOT_SESSIONS ||
        resnapshotAbortController.signal.aborted
      ) return
      resnapshotSessions.add(sessionID)
      void refreshSessionMessagesUntilSuccessful(sessionID, resnapshotAbortController.signal).finally(() => {
        resnapshotSessions.delete(sessionID)
      })
    }

    const streamMux = createUiEventMux<StreamDelta>({
      sessionID: (event) => event.sessionID,
      key: (event) => event.key,
      merge: (previous, next) => ({ ...previous, text: previous.text + next.text }),
      size: (event) => inspectUtf8ByteLength(event.text, 64 * 1024).byteLength,
      sizeProvenance: "measured",
      cursor: (event) => {
        if (
          typeof event.sessionID !== "string" ||
          event.sessionID.length === 0 ||
          event.sessionID.length > 256 ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence < 0 ||
          !Number.isSafeInteger(event.offset) ||
          event.offset < 0 ||
          typeof event.sourceGeneration !== "string" ||
          event.sourceGeneration.length === 0 ||
          event.sourceGeneration.length > 256
        ) return
        const seedKey = replaySeedKey(event.sessionID, event.key, event.sourceGeneration)
        if (!replaySeeded.has(seedKey)) {
          const messages = store.session.message[event.sessionID] ?? []
          const assistant = message.assistant(messages, event.assistantMessageID)
          const projected =
            event.event.type === "session.next.text.delta"
              ? message.latestText(assistant, event.targetID)?.text.length
              : event.event.type === "session.next.reasoning.delta"
                ? message.latestReasoning(assistant, event.targetID)?.text.length
                : message.latestTool(assistant, event.targetID)?.state.status === "pending"
                  ? (message.latestTool(assistant, event.targetID)!.state as { input: string }).input.length
                  : undefined
          if (projected !== event.offset) return
          streamMux.seedStream({
            sessionID: event.sessionID,
            partID: event.key,
            sourceGeneration: event.sourceGeneration,
            sequence: event.sequence,
          })
          markReplaySeeded(seedKey)
        }
        return {
          sessionID: event.sessionID,
          partID: event.key,
          sourceGeneration: event.sourceGeneration,
          sequence: event.sequence,
          advance: 1,
        }
      },
      requireCursor: true,
      onInvalidCursor: requestResnapshot,
      onResnapshotRequired: (cursor) => {
        requestResnapshot(cursor.sessionID)
      },
      maxStreamCursors: 4096,
      deliver: (events) => {
        for (const item of events) {
          const messages = store.session.message[item.sessionID] ?? []
          const assistant = message.assistant(messages, item.assistantMessageID)
          const projected =
            item.event.type === "session.next.text.delta"
              ? message.latestText(assistant, item.targetID)?.text.length
              : item.event.type === "session.next.reasoning.delta"
                ? message.latestReasoning(assistant, item.targetID)?.text.length
                : message.latestTool(assistant, item.targetID)?.state.status === "pending"
                  ? (message.latestTool(assistant, item.targetID)!.state as { input: string }).input.length
                  : undefined
          if (projected !== item.offset) {
            requestResnapshot(item.sessionID)
            continue
          }
          switch (item.event.type) {
            case "session.next.text.delta":
              handleEvent({ ...item.event, data: { ...item.event.data, delta: item.text } })
              break
            case "session.next.reasoning.delta":
              handleEvent({ ...item.event, data: { ...item.event.data, delta: item.text } })
              break
            case "session.next.tool.input.delta":
              handleEvent({ ...item.event, data: { ...item.event.data, delta: item.text } })
              break
          }
        }
      },
      maxQueuedEvents: 1024,
      maxQueuedBytes: 64 * 1024,
      flushAfterMs: 16,
    })

    onMount(() => {
      const unsubscribeReconnect = sdk.onReconnect(async (signal) => {
        streamMux.reconnect()
        replaySeeded.clear()
        latestPromptBoundary.clear()
        latestPromptGeneration.clear()
        for (const sessionID of Object.keys(store.session.contextLedger)) {
          setStore("session", "contextLedger", sessionID, undefined)
        }
        const sessionIDs = Object.keys(store.session.message)
        const batchSize = 8
        for (let offset = 0; offset < sessionIDs.length; offset += batchSize) {
          const batch = sessionIDs.slice(offset, offset + batchSize)
          await Promise.all(batch.map((sessionID) => refreshSessionMessagesUntilSuccessful(sessionID, signal)))
        }
      })
      const unsub = events.subscribe((event, metadata) => {
        const mapped = {
          ...event,
          data: event.properties,
          location: { directory: metadata.directory, workspaceID: metadata.workspace },
        } as TuiEvent
        const delta = streamDelta(mapped)
        if (delta) {
          if (!rememberDeltaEventID(mapped.id)) return
          markLiveSessionChange(delta.sessionID)
          streamMux.push(delta)
          return
        }
        const sessionID = eventSessionID(mapped)
        if (sessionID) markLiveSessionChange(sessionID)
        streamMux.flush(sessionID)
        handleEvent(mapped)
      })
      onCleanup(() => {
        resnapshotAbortController.abort()
        unsubscribeReconnect()
        streamMux.close()
        unsub()
      })
    })

    const result = {
      stream: {
        stats() {
          return streamMux.stats()
        },
        streamStats() {
          return streamMux.streamStats()
        },
        /** SSE/control-stream reconnected: drop stale cursors and request canonical resnapshots implicitly. */
        reconnect() {
          replaySeeded.clear()
          return streamMux.reconnect()
        },
        observations() {
          return streamMux.observations()
        },
      },
      session: {
        get(sessionID: string) {
          return store.session.info[sessionID]
        },
        contextLedger(sessionID: string) {
          return store.session.contextLedger[sessionID]
        },
        async refresh(sessionID: string) {
          const result = await sdk.client.v2.session.get({ sessionID }, { throwOnError: true })
          setStore("session", "info", sessionID, result.data.data)
        },
        message: {
          list(sessionID: string) {
            return store.session.message[sessionID]
          },
          async refresh(sessionID: string) {
            await refreshSessionMessages(sessionID)
          },
        },
        permission: {
          list(sessionID: string) {
            return store.session.permission[sessionID]
          },
          async refresh(sessionID: string) {
            const result = await sdk.client.v2.session.permission.list({ sessionID }, { throwOnError: true })
            setStore("session", "permission", sessionID, result.data.data)
          },
        },
        question: {
          list(sessionID: string) {
            return (store.session.question[sessionID] ?? []).map((item) => item.request)
          },
          prompts(sessionID: string) {
            return store.session.question[sessionID] ?? []
          },
          async refresh(sessionID: string) {
            const [v2, legacy] = await Promise.all([
              sdk.client.v2.session.question.list({ sessionID }, { throwOnError: true }),
              sdk.client.question.list({}, { throwOnError: true }),
            ])
            const requests: SessionQuestionRequest[] = [
              ...v2.data.data.map((request): SessionQuestionRequest => ({ lane: "v2", request })),
              ...legacy.data.filter((request) => request.sessionID === sessionID)
                .map((request): SessionQuestionRequest => ({ lane: "legacy", request })),
            ]
            for (const [key, request] of questionChanges.get(sessionID) ?? []) {
              const index = requests.findIndex((item) => questionKey(item.lane, item.request.id) === key)
              if (index !== -1) requests.splice(index, 1)
              if (request) requests.splice(index === -1 ? requests.length : index, 0, request)
            }
            questionChanges.delete(sessionID)
            setStore("session", "question", sessionID, requests)
          },
        },
      },
      project: {
        permission: {
          list(projectID: string) {
            return store.project.permission[projectID]
          },
          async refresh(projectID: string) {
            const result = await sdk.client.v2.permission.saved.list({ projectID }, { throwOnError: true })
            setStore("project", "permission", projectID, result.data.data)
          },
        },
      },
      location: {
        default() {
          return defaultLocation()
        },
        async refresh(ref?: LocationRef) {
          const response = await sdk.client.v2.location.get({ location: locationQuery(ref) }, { throwOnError: true })
          const location = response.data
          const key = locationKey(location)
          if (!store.location[key]) setStore("location", key, {})
          if (!ref) setDefaultLocation({ directory: location.directory, workspaceID: location.workspaceID })
        },
        agent: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.agent
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.agent.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "agent", result.data.data)
          },
        },
        command: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.command
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.command.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "command", result.data.data)
          },
        },
        integration: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.integration
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.integration.list(
              { location: locationQuery(ref) },
              { throwOnError: true },
            )
            const key = locationKey(result.data.location)
            setStore("location", key, "integration", result.data.data)
          },
        },
        model: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.model
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.model.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "model", result.data.data)
          },
        },
        provider: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.provider
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.provider.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "provider", result.data.data)
          },
        },
        reference: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.reference
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.reference.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "reference", result.data.data)
          },
        },
        skill: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.skill
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.skill.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "skill", result.data.data)
          },
        },
      },
    }

    onMount(() => {
      void Promise.allSettled([
        result.location.refresh(),
        result.location.agent.refresh(),
        result.location.integration.refresh(),
        result.location.model.refresh(),
        result.location.provider.refresh(),
        result.location.reference.refresh(),
        result.location.command.refresh(),
        result.location.skill.refresh(),
      ]).then((settled) => {
        for (const failure of settled.filter((item) => item.status === "rejected"))
          console.error("Failed to refresh default location data", failure.reason)
      })
    })

    return result
  },
})
