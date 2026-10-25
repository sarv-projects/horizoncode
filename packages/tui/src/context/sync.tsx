import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
  EventMessagePartDelta,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onCleanup, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"
import { createUiEventMux } from "./ui-event-mux"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

const SESSION_MESSAGE_PAGE_SIZE = 100
const SESSION_MESSAGE_HISTORY_LIMIT = 10_000
const SESSION_MESSAGE_HARD_LIMIT = 20_000

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

type GuardApprovalState = "pending" | "submitting"

type GuardApprovalRequest = {
  approvalID: string
  challengeID: string
  effectID: string
  capabilityID: string
  locationID: string
  sessionID?: string
  inputDigest: string
  normalizedTargets: unknown[]
  expiresAtUnixMs: number
  policySummary: string
  origin?: "session_batch" | "user_action" | "managed_run" | "managed_root"
  source?: "core.tool_batch" | "authenticated.user_action" | "host.managed_verifier" | "host.managed_provider" | "host.managed_worktree"
  policyID?: string
  policyDigest?: string
  normalizedAction?: string
  argumentSummary?:
    | { readonly status: "available"; readonly text: string }
    | { readonly status: "unavailable"; readonly reason: string }
  requestedGuarantees?: string[]
  guaranteeAssessment?:
    | { readonly status: "assessed"; readonly residual: string[] }
    | { readonly status: "not_assessed"; readonly residual: null }
  runID?: string
  noResponse?: "deny_and_expire"
  allowEnabled?: boolean
  directory: string
  workspace?: string
  state?: GuardApprovalState
}

export type GuardApprovalDecision = "allow_once" | "deny" | "grant_session" | "grant_workspace"

// A complete ToolBatch admits one challenge per effectful call, so several Guard
// approvals can be pending at the same time. Keep the queue bounded and stable.
export const MAX_PENDING_GUARD_APPROVALS = 16

/**
 * Insert or refresh one Guard approval request. A repeated challenge (new approval ID for
 * the same challenge) replaces its previous entry instead of queueing twice, and the
 * queue is capped by dropping the entries that expire first.
 */
export function upsertGuardApprovalRequest(
  current: GuardApprovalRequest[],
  request: GuardApprovalRequest,
  max = MAX_PENDING_GUARD_APPROVALS,
): GuardApprovalRequest[] {
  const next = current.filter(
    (item) => item.approvalID !== request.approvalID && item.challengeID !== request.challengeID,
  )
  next.push(request)
  next.sort((a, b) => a.expiresAtUnixMs - b.expiresAtUnixMs || a.approvalID.localeCompare(b.approvalID))
  return next.length > max ? next.slice(-max) : next
}

/** Pending approvals in decision order: the earliest expiry is answered first. */
export function pendingGuardApprovals(
  current: GuardApprovalRequest[],
  nowMs = Date.now(),
): GuardApprovalRequest[] {
  return current
    .filter((item) => item.expiresAtUnixMs > nowMs)
    .toSorted((a, b) => a.expiresAtUnixMs - b.expiresAtUnixMs || a.approvalID.localeCompare(b.approvalID))
}

function parseGuardApprovalRequest(value: unknown, directory: string, workspace?: string): GuardApprovalRequest | undefined {
  if (typeof value !== "object" || value === null) return
  const item = value as Record<string, unknown>
  if (
    typeof item.approvalID !== "string" ||
    typeof item.challengeID !== "string" ||
    typeof item.effectID !== "string" ||
    typeof item.capabilityID !== "string" ||
    typeof item.locationID !== "string" ||
    (item.sessionID !== undefined && typeof item.sessionID !== "string") ||
    typeof item.inputDigest !== "string" ||
    !Array.isArray(item.normalizedTargets) ||
    typeof item.expiresAtUnixMs !== "number" ||
    !Number.isFinite(item.expiresAtUnixMs) ||
    typeof item.policySummary !== "string"
  ) {
    return
  }
  const summary = item.argumentSummary
  const summaryRecord = typeof summary === "object" && summary !== null && !Array.isArray(summary)
    ? summary as Record<string, unknown>
    : undefined
  const argumentSummary =
    summaryRecord?.status === "available" &&
    typeof summaryRecord.text === "string" &&
    summaryRecord.text.trim().length > 0 &&
    Buffer.byteLength(summaryRecord.text, "utf8") <= 512
      ? { status: "available" as const, text: summaryRecord.text }
      : summaryRecord?.status === "unavailable" &&
          typeof summaryRecord.reason === "string" &&
          Buffer.byteLength(summaryRecord.reason, "utf8") <= 256
        ? { status: "unavailable" as const, reason: summaryRecord.reason }
        : undefined
  const assessment = item.guaranteeAssessment
  const assessmentRecord = typeof assessment === "object" && assessment !== null && !Array.isArray(assessment)
    ? assessment as Record<string, unknown>
    : undefined
  const guaranteeAssessment =
    assessmentRecord?.status === "assessed" &&
    Array.isArray(assessmentRecord.residual) &&
    assessmentRecord.residual.length <= 16 &&
    assessmentRecord.residual.every((id) => typeof id === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(id)) &&
    new Set(assessmentRecord.residual).size === assessmentRecord.residual.length
      ? { status: "assessed" as const, residual: assessmentRecord.residual as string[] }
      : assessmentRecord?.status === "not_assessed" && assessmentRecord.residual === null
        ? { status: "not_assessed" as const, residual: null }
        : undefined
  const requestedGuarantees =
    Array.isArray(item.requestedGuarantees) &&
    item.requestedGuarantees.length > 0 &&
    item.requestedGuarantees.length <= 16 &&
    item.requestedGuarantees.every((id) => typeof id === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(id)) &&
    new Set(item.requestedGuarantees).size === item.requestedGuarantees.length
      ? item.requestedGuarantees as string[]
      : undefined
  const origin = item.origin === "session_batch" || item.origin === "user_action" || item.origin === "managed_run" || item.origin === "managed_root"
    ? item.origin
    : undefined
  const source = item.source === "core.tool_batch" || item.source === "authenticated.user_action" || item.source === "host.managed_verifier" || item.source === "host.managed_provider" || item.source === "host.managed_worktree"
    ? item.source
    : undefined
  const consentFieldsValid =
    origin !== undefined && source !== undefined &&
    ((origin === "managed_run" && source === "host.managed_verifier") ||
      (origin === "managed_run" && source === "host.managed_provider" && item.capabilityID === "providers.infer" &&
        item.policyID === "provider-inference.managed.v1" &&
        requestedGuarantees?.join("\0") === ["live_managed_attempt", "selected_route_revision", "normalized_request_digest", "transport_request_digest", "secret_operation_digest", "explicit_route_consent", "budget_bound", "one_use", "no_fallback"].join("\0") &&
        guaranteeAssessment?.status === "assessed" && guaranteeAssessment.residual.length === 0 && argumentSummary?.status === "available") ||
      (origin === "managed_root" && source === "host.managed_worktree") ||
      (origin !== "managed_run" && origin !== "managed_root" && source !== "host.managed_verifier" && source !== "host.managed_provider" && source !== "host.managed_worktree")) &&
    typeof item.policyID === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(item.policyID) &&
    typeof item.policyDigest === "string" && /^blake3:[0-9a-f]{64}$/.test(item.policyDigest) &&
    item.normalizedAction === item.capabilityID &&
    argumentSummary !== undefined && requestedGuarantees !== undefined &&
    guaranteeAssessment !== undefined && item.noResponse === "deny_and_expire" &&
    (origin !== "managed_root" || (
      item.capabilityID === "git.worktree.list" && item.policyID === "broker-process.local.v1" &&
      requestedGuarantees?.join("\0") === ["configured_executable", "bounded_argv_env", "beneath_workspace_root", "one_use"].join("\0") &&
      guaranteeAssessment?.status === "assessed" && guaranteeAssessment.residual.length === 0 &&
      argumentSummary?.status === "available" && typeof item.runID === "string"
    )) && (guaranteeAssessment.status === "not_assessed" ||
      (guaranteeAssessment.status === "assessed" &&
        guaranteeAssessment.residual.every((id) => requestedGuarantees.includes(id))))
  const allowEnabled = item.allowEnabled === true
    ? consentFieldsValid && argumentSummary?.status === "available" && guaranteeAssessment?.status === "assessed" &&
      (origin !== "managed_root" || (guaranteeAssessment.residual.length === 0 && item.capabilityID === "git.worktree.list"))
    : item.allowEnabled === false ? false : undefined
  return {
    approvalID: item.approvalID,
    challengeID: item.challengeID,
    effectID: item.effectID,
    capabilityID: item.capabilityID,
    locationID: item.locationID,
    ...(typeof item.sessionID === "string" ? { sessionID: item.sessionID } : {}),
    inputDigest: item.inputDigest,
    normalizedTargets: item.normalizedTargets,
    expiresAtUnixMs: item.expiresAtUnixMs,
    policySummary: item.policySummary,
    ...(origin ? { origin } : {}),
    ...(source ? { source } : {}),
    ...(typeof item.policyID === "string" ? { policyID: item.policyID } : {}),
    ...(typeof item.policyDigest === "string" ? { policyDigest: item.policyDigest } : {}),
    ...(typeof item.normalizedAction === "string" ? { normalizedAction: item.normalizedAction } : {}),
    ...(argumentSummary ? { argumentSummary } : {}),
    ...(requestedGuarantees ? { requestedGuarantees } : {}),
    ...(guaranteeAssessment ? { guaranteeAssessment } : {}),
    ...(typeof item.runID === "string" ? { runID: item.runID } : {}),
    ...(item.noResponse === "deny_and_expire" ? { noResponse: item.noResponse } : {}),
    ...(allowEnabled !== undefined ? { allowEnabled } : {}),
    directory,
    ...(workspace ? { workspace } : {}),
    state: "pending",
  }
}

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      guard_approval: GuardApprovalRequest[]
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      session_message_truncated: {
        [sessionID: string]: boolean
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
        catalogSnapshot: { source: "unavailable", freshness: "unknown" },
        anonymousFreeProviders: [],
        anonymousFreeModels: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      guard_approval: [],
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      session_message_truncated: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    // Replies already in flight, so a second click/second surface cannot double-answer
    // the same one-use challenge.
    const guardSubmissions = new Set<string>()

    const removeGuardApproval = (approvalID: string) => {
      setStore(
        "guard_approval",
        produce((draft) => {
          const index = draft.findIndex((item) => item.approvalID === approvalID)
          if (index !== -1) draft.splice(index, 1)
        }),
      )
    }

    const setGuardApprovalState = (approvalID: string, state: GuardApprovalState) => {
      setStore(
        "guard_approval",
        produce((draft) => {
          const index = draft.findIndex((item) => item.approvalID === approvalID)
          if (index !== -1) draft[index] = { ...draft[index], state }
        }),
      )
    }

    /**
     * Answer one Guard approval exactly once. `allow_once` consumes the one-use lease;
     * `deny` closes the challenge. A 404/409 means the challenge is already resolved or
     * expired, so the stale entry is dropped instead of being retried forever.
     */
    const replyGuardApproval = async (approvalID: string, decision: GuardApprovalDecision): Promise<boolean> => {
      const entry = store.guard_approval.find((item) => item.approvalID === approvalID)
      if (!entry || guardSubmissions.has(approvalID)) return false
      guardSubmissions.add(approvalID)
      setGuardApprovalState(approvalID, "submitting")
      try {
        const response = await sdk.client.guard.approval.reply(
          {
            approvalID,
            // The generated SDK decision union lags the authenticated server
            // schema, which accepts session/workspace grants. Send the exact
            // user-selected decision; the server validates it.
            decision: decision as "allow_once" | "deny",
            directory: entry.directory,
            ...(entry.workspace ? { workspace: entry.workspace } : {}),
          },
          { throwOnError: false },
        )
        if (response.error) {
          const status = response.response?.status
          if (status === 404 || status === 409) removeGuardApproval(approvalID)
          else setGuardApprovalState(approvalID, "pending")
          return false
        }
        removeGuardApproval(approvalID)
        return true
      } catch {
        setGuardApprovalState(approvalID, "pending")
        return false
      } finally {
        guardSubmissions.delete(approvalID)
      }
    }

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const olderMessageCursors = new Map<string, string>()
    const loadingOlderMessages = new Map<string, Promise<boolean>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string> }>()
    const resnapshotTasks = new Map<string, Promise<void>>()
    const resnapshotAgain = new Set<string>()
    // The event's source cursor may seed a live stream only when its separate
    // UTF-16 offset agrees with the canonical text currently projected.
    const replaySeeded = new Set<string>()
    const replaySeedKey = (sessionID: string, partID: string, generation: string) =>
      JSON.stringify([sessionID, partID, generation])
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    function applyPartDelta(event: EventMessagePartDelta) {
      if (event.properties.field !== "text") return false
      const parts = store.part[event.properties.messageID]
      if (!parts) {
        void resnapshotSession(event.properties.sessionID)
        return false
      }
      const result = search(parts, event.properties.partID, (part) => part.id)
      if (!result.found) {
        void resnapshotSession(event.properties.sessionID)
        return false
      }
      const part = parts[result.index]
      if (
        event.properties.field !== "text" ||
        (part.type !== "text" && part.type !== "reasoning") ||
        part.text.length !== event.properties.offset
      ) {
        if (part.type === "text" || part.type === "reasoning") void resnapshotSession(event.properties.sessionID)
        return false
      }
      touchPart(event.properties.sessionID, event.properties.partID)
      setStore(
        "part",
        event.properties.messageID,
        produce((draft) => {
          const part = draft[result.index]
          const field = event.properties.field as keyof typeof part
          const existing = part[field] as string | undefined
          ;(part[field] as string) = (existing ?? "") + event.properties.delta
        }),
      )
      return true
    }

    const streamMux = createUiEventMux<EventMessagePartDelta>({
      sessionID: (item) => item.properties.sessionID,
      key: (item) => `${item.properties.messageID}:${item.properties.partID}:${item.properties.field}`,
      merge: (previous, next) => ({
        ...previous,
        properties: { ...previous.properties, delta: previous.properties.delta + next.properties.delta },
      }),
      size: (item) => new TextEncoder().encode(item.properties.delta).byteLength,
      sizeProvenance: "measured",
      cursor: (item) => {
        const sequence = item.properties.sequence
        const sourceGeneration = item.properties.sourceGeneration
        const partID = `${item.properties.messageID}:${item.properties.partID}:${item.properties.field}`
        if (
          typeof item.properties.sessionID !== "string" ||
          item.properties.sessionID.length === 0 ||
          item.properties.sessionID.length > 256
        ) return
        const validSequence = Number.isSafeInteger(sequence) && sequence >= 0
        const validOffset = Number.isSafeInteger(item.properties.offset) && item.properties.offset >= 0
        const validGeneration =
          typeof sourceGeneration === "string" && sourceGeneration.length > 0 && sourceGeneration.length <= 256
        if (!validSequence || !validOffset || !validGeneration) return
        if (resnapshotTasks.has(item.properties.sessionID)) return
        const seedKey = replaySeedKey(item.properties.sessionID, partID, sourceGeneration)
        if (!replaySeeded.has(seedKey)) {
          const parts = store.part[item.properties.messageID]
          const result = parts && search(parts, item.properties.partID, (part) => part.id)
          const canonical = result?.found ? parts?.[result.index] : undefined
          if (!canonical) {
            // A fresh part can only begin at ordinal/offset zero. A later replay
            // delta needs canonical text to prove its separate edit offset.
            if (sequence !== 0 || item.properties.offset !== 0) return
          } else if (
            (canonical.type !== "text" && canonical.type !== "reasoning") ||
            canonical.text.length !== item.properties.offset
          ) {
            return
          }
          streamMux.seedStream({
            sessionID: item.properties.sessionID,
            partID,
            sourceGeneration,
            sequence,
          })
          replaySeeded.add(seedKey)
          while (replaySeeded.size > 4096) {
            const oldest = replaySeeded.values().next().value
            if (oldest === undefined) break
            replaySeeded.delete(oldest)
          }
        }
        return {
          sessionID: item.properties.sessionID,
          partID,
          sourceGeneration,
          sequence,
          advance: 1,
        }
      },
      requireCursor: true,
      onInvalidCursor: (sessionID) => void resnapshotSession(sessionID),
      onResnapshotRequired: (cursor) => {
        replaySeeded.delete(replaySeedKey(cursor.sessionID, cursor.partID, cursor.sourceGeneration))
        void resnapshotSession(cursor.sessionID)
      },
      deliver: (items) => {
        for (const item of items) {
          if (!applyPartDelta(item)) {
            const partID = `${item.properties.messageID}:${item.properties.partID}:${item.properties.field}`
            replaySeeded.delete(replaySeedKey(item.properties.sessionID, partID, item.properties.sourceGeneration))
          }
        }
      },
      maxQueuedEvents: 1024,
      maxQueuedBytes: 64 * 1024,
      maxQueuedSessions: 64,
      flushAfterMs: 16,
      maxStreamCursors: 4096,
    })

    async function resnapshotSessionOnce(sessionID: string) {
      streamMux.flush(sessionID)
      streamMux.forgetStream(sessionID)
      for (const key of replaySeeded) {
        const [owner] = JSON.parse(key) as [string, string, string]
        if (owner === sessionID) replaySeeded.delete(key)
      }
      const tracker = { messages: new Set<string>(), parts: new Set<string>() }
      hydratingSessions.set(sessionID, tracker)
      try {
        const pages: Array<{ info: Message; parts: Part[] }> = []
        let response = await sdk.client.session.messages(
          { sessionID, limit: SESSION_MESSAGE_PAGE_SIZE },
          { throwOnError: true },
        )
        pages.push(...(response.data ?? []))
        let cursor = response.response.headers.get("X-Next-Cursor") ?? undefined
        let count = pages.length
        const seen = new Set<string>()
        while (cursor && count < SESSION_MESSAGE_HISTORY_LIMIT && !seen.has(cursor)) {
          seen.add(cursor)
          response = await sdk.client.session.messages(
            { sessionID, limit: Math.min(SESSION_MESSAGE_PAGE_SIZE, SESSION_MESSAGE_HISTORY_LIMIT - count), before: cursor },
            { throwOnError: true },
          )
          const next = response.data ?? []
          if (!next.length) break
          pages.push(...next)
          count += next.length
          cursor = response.response.headers.get("X-Next-Cursor") ?? undefined
        }
        const current = new Map((store.message[sessionID] ?? []).map((message) => [message.id, message]))
        const canonical = pages.flatMap((item) => {
          const live = current.get(item.info.id)
          const currentParts = store.part[item.info.id] ?? []
          const parts = item.parts.map((part) => {
            if (!tracker.parts.has(part.id)) return part
            return currentParts.find((currentPart) => currentPart.id === part.id) ?? part
          })
          parts.push(...currentParts.filter((part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id)))
          setStore("part", item.info.id, parts)
          return [tracker.messages.has(item.info.id) && live ? live : item.info]
        })
        const canonicalIDs = new Set(canonical.map((message) => message.id))
        canonical.push(...[...current.values()].filter((message) => tracker.messages.has(message.id) && !canonicalIDs.has(message.id)))
        const sorted = canonical.sort(compareMessage).slice(-SESSION_MESSAGE_HISTORY_LIMIT)
        setStore("message", sessionID, sorted)
        olderMessageCursors.set(sessionID, cursor ?? "")
        if (!cursor) olderMessageCursors.delete(sessionID)
        setStore("session_message_truncated", sessionID, Boolean(cursor))
      } catch {
        // A failed reconnect snapshot is retried by the next SSE reconnect or
        // by an out-of-sequence event; live state remains available meanwhile.
      } finally {
        hydratingSessions.delete(sessionID)
      }
    }

    function resnapshotSession(sessionID: string) {
      const current = resnapshotTasks.get(sessionID)
      if (current) {
        resnapshotAgain.add(sessionID)
        return current
      }
      const task = (async () => {
        let passes = 0
        do {
          resnapshotAgain.delete(sessionID)
          await resnapshotSessionOnce(sessionID)
          passes++
        } while (resnapshotAgain.has(sessionID) && passes < 2)
        if (resnapshotAgain.has(sessionID)) {
          resnapshotAgain.delete(sessionID)
          setTimeout(() => void resnapshotSession(sessionID), 250)
        }
      })().finally(() => {
        resnapshotTasks.delete(sessionID)
      })
      resnapshotTasks.set(sessionID, task)
      return task
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    const unsubscribeEvents = event.subscribe((event, { directory, workspace }) => {
      const rawEvent = event as { id?: string; type: string; properties?: unknown }
      if (rawEvent.type === "guard.approval.requested") {
        if (directory === "global") return
        const request = parseGuardApprovalRequest(rawEvent.properties, directory, workspace)
        if (!request) return
        setStore("guard_approval", (current) => upsertGuardApprovalRequest(current, request))
        return
      }
      if (rawEvent.type === "guard.approval.resolved") {
        const approvalID = (rawEvent.properties as { approvalID?: unknown } | undefined)?.approvalID
        if (typeof approvalID !== "string") return
        guardSubmissions.delete(approvalID)
        setStore(
          "guard_approval",
          produce((draft) => {
            const index = draft.findIndex((item) => item.approvalID === approvalID)
            if (index !== -1) draft.splice(index, 1)
          }),
        )
        return
      }
      if (event.type === "message.part.delta") {
        const delta = event as EventMessagePartDelta
        streamMux.push(delta)
        return
      }
      const properties = event.properties as { sessionID?: unknown } | undefined
      const eventSessionID = properties && typeof properties.sessionID === "string" ? properties.sessionID : undefined
      if (typeof eventSessionID === "string") streamMux.flush(eventSessionID)
      switch (event.type) {
        case "server.instance.disposed":
          guardSubmissions.clear()
          setStore("guard_approval", [])
          void bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          if (permission.mode === "auto") {
            void sdk.client.permission.reply({
              requestID: request.id,
              reply: "once",
              directory,
              workspace,
            })
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > SESSION_MESSAGE_HISTORY_LIMIT) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          const index = messages.findIndex((message) => message.id === event.properties.messageID)
          if (index !== -1) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const part = event.properties.part
          if (part.type === "text" || part.type === "reasoning") {
          // Part snapshots intentionally carry no live source ordinal. They
          // cannot seed replay authority from text length or stable IDs.
          streamMux.forgetStream(part.sessionID, `${part.messageID}:${part.id}:text`)
          }
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (part) => part.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const unsubscribeReconnect = sdk.onReconnect(async (signal) => {
      streamMux.reconnect()
      replaySeeded.clear()
      const sessionIDs = Object.keys(store.message)
      for (let offset = 0; offset < sessionIDs.length; offset += 8) {
        if (signal.aborted) return
        await Promise.all(sessionIDs.slice(offset, offset + 8).map(resnapshotSession))
      }
    })
    onCleanup(() => {
      unsubscribeEvents()
      unsubscribeReconnect()
      streamMux.close()
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const consoleState = responses[3]
            const agents = responses[4]
            const config = responses[5]
            const sessions = responses[6]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      /**
       * Pending Guard approvals (one per effectful ToolBatch call). `reply` answers exactly
       * one challenge; the server consumes a one-use approval. The list is already ordered
       * by expiry, so callers can render/answer `pending()[0]` first.
       */
      guardApproval: {
        pending: () => pendingGuardApprovals(store.guard_approval),
        reply: (approvalID: string, decision: GuardApprovalDecision) => replyGuardApproval(approvalID, decision),
        approve: (approvalID: string) => replyGuardApproval(approvalID, "allow_once"),
        deny: (approvalID: string) => replyGuardApproval(approvalID, "deny"),
      },
      stream: {
        stats: () => streamMux.stats(),
        streamStats: () => streamMux.streamStats(),
        observations: () => streamMux.observations(),
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, firstMessages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: SESSION_MESSAGE_PAGE_SIZE }, { throwOnError: true }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
            ])
            // V1 pages are newest-first by cursor, while each page is internally
            // chronological. Bound both the request count and retained history so
            // long sessions never create an unbounded TUI store.
            const messagePages = [firstMessages.data ?? []]
            let loadedMessages = messagePages[0]!.length
            let cursor = firstMessages.response.headers.get("X-Next-Cursor") ?? undefined
            const seenCursors = new Set<string>()
            while (cursor && loadedMessages < SESSION_MESSAGE_HISTORY_LIMIT) {
              if (seenCursors.has(cursor)) break
              seenCursors.add(cursor)
              const page = await sdk.client.session.messages(
                {
                  sessionID,
                  limit: Math.min(SESSION_MESSAGE_PAGE_SIZE, SESSION_MESSAGE_HISTORY_LIMIT - loadedMessages),
                  before: cursor,
                },
                { throwOnError: true },
              )
              const items = page.data ?? []
              if (items.length === 0) break
              messagePages.push(items)
              loadedMessages += items.length
              cursor = page.response.headers.get("X-Next-Cursor") ?? undefined
            }
            const historyTruncated = Boolean(cursor)
            if (cursor) olderMessageCursors.set(sessionID, cursor)
            else olderMessageCursors.delete(sessionID)
            const messageItems = messagePages.reverse().flat()
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data!)
                draft.todo[sessionID] = todo.data ?? []
                draft.session_message_truncated[sessionID] = historyTruncated
                const currentMessages = draft.message[sessionID] ?? []
                const infos = messageItems.flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                infos.sort(compareMessage)
                const removed = infos.slice(0, -SESSION_MESSAGE_HISTORY_LIMIT)
                const visible = infos.slice(-SESSION_MESSAGE_HISTORY_LIMIT)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of messageItems) {
                  if (!visibleIDs.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
                draft.session_diff[sessionID] = diff.data ?? []
              }),
            )
            fullSyncedSessions.add(sessionID)
          })().catch(() => undefined).finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
        async loadOlder(sessionID: string) {
          const existing = loadingOlderMessages.get(sessionID)
          if (existing) return existing
          const cursor = olderMessageCursors.get(sessionID)
          const current = store.message[sessionID] ?? []
          if (!cursor || current.length >= SESSION_MESSAGE_HARD_LIMIT) return false

          const task = (async () => {
            const limit = Math.min(SESSION_MESSAGE_PAGE_SIZE, SESSION_MESSAGE_HARD_LIMIT - current.length)
            const page = await sdk.client.session.messages(
              { sessionID, limit, before: cursor },
              { throwOnError: true },
            )
            const items = page.data ?? []
            const nextCursor = page.response.headers.get("X-Next-Cursor") ?? undefined
            if (!items.length) {
              olderMessageCursors.delete(sessionID)
              setStore("session_message_truncated", sessionID, false)
              return false
            }

            const currentParts = store.part
            setStore(
              produce((draft) => {
                const currentMessages = draft.message[sessionID] ?? []
                const currentIDs = new Set(currentMessages.map((message) => message.id))
                const added = items.flatMap((message) => (currentIDs.has(message.info.id) ? [] : [message.info]))
                const visible = [...added, ...currentMessages]
                  .sort(compareMessage)
                  .slice(0, SESSION_MESSAGE_HARD_LIMIT)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of items) {
                  if (!visibleIDs.has(message.info.id)) continue
                  const retained = currentParts[message.info.id] ?? []
                  const parts = message.parts.map((part) => retained.find((item) => item.id === part.id) ?? part)
                  for (const part of retained) {
                    if (!parts.some((item) => item.id === part.id)) parts.push(part)
                  }
                  draft.part[message.info.id] = parts
                }
                draft.message[sessionID] = visible
                draft.session_message_truncated[sessionID] = Boolean(nextCursor)
              }),
            )
            if (nextCursor) olderMessageCursors.set(sessionID, nextCursor)
            else olderMessageCursors.delete(sessionID)
            return true
          })().finally(() => loadingOlderMessages.delete(sessionID))
          loadingOlderMessages.set(sessionID, task)
          return task
        },
      },
      bootstrap,
    }
    return result
  },
})
