import { PermissionV1 } from "@horizoncode/core/v1/permission"
import { Agent } from "@/agent/agent"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { Pty } from "@horizoncode/core/pty"
import { LocationServiceMap } from "@horizoncode/core/location-services"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { SessionV2 } from "@horizoncode/core/session"
import { QuestionV2 } from "@horizoncode/core/question"
import * as SubagentDeliveryV1 from "@horizoncode/schema/subagent-delivery-v1"
import * as SubagentStatusV1 from "@horizoncode/schema/subagent-status-v1"
import {
  digestText,
  inboxReceiptDigest,
} from "@/session/direct-subagent-inbox"
import type { ManagedSubagentInboxStateV1 } from "@/session/managed-subagent-inbox"
import { legacyHostRootCompatible, ownerMatchesPrincipal } from "@/question/owner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { ManagedControl } from "@/session/managed-control"
import { SessionRevert } from "@/session/revert"
import { Database } from "@horizoncode/core/database/database"
import { SessionContextOps } from "@horizoncode/core/session/context-ops"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@horizoncode/core/util/error"
import { SessionSupervisor, SessionSupervisorError } from "@horizoncode/core/session/supervisor"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { InstanceState } from "@/effect/instance-state"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  GuardApprovalPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SubagentWaitQuery,
  SubagentMessagePayload,
  ContextTrimPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import {
  ConflictError,
  ApiNotFoundError,
  ForbiddenError,
  PermissionNotFoundError,
  ServiceUnavailableError,
  SessionBusyError,
} from "../errors"
import * as SessionError from "./session-errors"

const SHELL_UNAVAILABLE_MESSAGE =
  "Shell execution is unavailable until terminal.run is mediated by Rust Guard and ExecutionHost."
const DIRECT_SCOPE_PIN_KEY = "horizonDirectAttemptScopeDigest"

const decodeDirectProfilePin = Schema.decodeUnknownSync(Schema.Struct({
  harness: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,256}$/)),
  profileID: Schema.String.check(Schema.isMaxLength(256)).check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/)),
  profileRevision: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/)),
  profileDigest: Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/)),
  permissionsDigest: Schema.String.check(Schema.isPattern(/^(sha256|blake3):[0-9a-f]{64}$/)),
}))

function directProfilePin(value: unknown) {
  try {
    const pin = decodeDirectProfilePin(value, { onExcessProperty: "error" })
    if (BigInt(pin.profileRevision) > 18_446_744_073_709_551_615n) return undefined
    return pin
  } catch {
    return undefined
  }
}

function subagentDelivery(value: unknown) {
  try {
    return Schema.decodeUnknownSync(SubagentDeliveryV1.SubagentDeliveryV1, { onExcessProperty: "error" })(value)
  } catch {
    return undefined
  }
}

export function mapLegacySupervisorError(error: SessionSupervisorError, sessionID: string, service = "host-kernel") {
  switch (error.stage) {
    case "authorization":
      return new ForbiddenError({ message: error.message })
    case "ownership":
      return new SessionBusyError({ sessionID, message: `Session is busy: ${sessionID}` })
    default:
      return new ServiceUnavailableError({ message: error.message, service })
  }
}

export function mapLegacyRevertError(
  error: SessionRevert.FileChangesUnavailableError | Session.BusyError | SessionSupervisorError,
  sessionID: string,
) {
  if ((error as any) instanceof SessionSupervisorError) return mapLegacySupervisorError(error as any, sessionID, "files.patch")
  if (error instanceof Session.BusyError)
    return new SessionBusyError({ sessionID, message: `Session is busy: ${sessionID}` })
  return new ServiceUnavailableError({ message: error.message, service: "files.patch" })
}

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

// A Guard approval decision can fail for four distinct reasons; the host kernel
// reports them through the typed `approvalCode` rather than a message match.
function guardApprovalFailure(error: SessionSupervisorError) {
  switch (error.approvalCode) {
    case "approval-not-found":
      return new HttpApiError.NotFound({})
    case "approval-conflict":
      return new ConflictError({ message: "Guard approval is no longer active" })
    case "approval-invalid":
      return new HttpApiError.BadRequest({})
    default:
      return new ServiceUnavailableError({ message: error.message, service: "host-kernel" })
  }
}

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service
    const locations = yield* LocationServiceMap.Service
    // Pty is location-scoped, so it is resolved per call instead of bound in this graph.
    const withLocationPty = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(
            Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) }),
          ),
        ),
      )
    })
    const withLocationQuestions = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(
            Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) }),
          ),
        ),
      )
    })
    const withLocationSupervisor = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(
            Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) }),
          ),
        ),
      )
    })
    const requireQuestionOwner = Effect.fn("SessionHttpApi.requireQuestionOwner")(function* (sessionID: SessionID) {
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (Option.isNone(authenticated)) {
        return yield* new ForbiddenError({ message: "Question access requires an authenticated session principal" })
      }
      const principal = authenticated.value.principal
      let current = yield* requireSession(sessionID)
      const instanceDirectory = yield* InstanceState.directory
      const workspaceID = yield* InstanceState.workspaceID
      const seen = new Set<string>()
      for (let depth = 0; depth < 32; depth++) {
        if (seen.has(current.id)) break
        if (current.directory !== instanceDirectory) break
        if (current.workspaceID !== undefined && current.workspaceID !== workspaceID) break
        seen.add(current.id)
        const owner = current.metadata?.horizonPrincipalOwner
        if (owner !== undefined) {
          if (ownerMatchesPrincipal(principal, owner)) return
          break
        }
        if (!current.parentID) {
          // Preserve only pre-owner-metadata roots from this exact instance.
          if (legacyHostRootCompatible(principal, {
            parentID: current.parentID,
            directory: current.directory,
            instanceDirectory: yield* InstanceState.directory,
            ownerMetadata: owner,
          })) return
          break
        }
        current = yield* requireSession(current.parentID)
      }
      return yield* new ForbiddenError({ message: "Question access is outside the authenticated Session owner scope" })
    })
    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      const owner = yield* requireSession(ctx.params.sessionID)
      yield* requireQuestionOwner(owner.id)
      // Project the authenticated Session owner's durable todo list.
      return yield* todoSvc.get(owner.id)
    })

    const questions = Effect.fn("SessionHttpApi.questions")(function* (ctx: { params: { sessionID: SessionID } }) {
      const owner = yield* requireSession(ctx.params.sessionID)
      yield* requireQuestionOwner(owner.id)
      // Pending questions live in the Location-owned QuestionV2 service. Keep
      // this projection scoped to the exact authenticated Session owner.
      return yield* withLocationQuestions(
        QuestionV2.Service.use((service) => service.list(owner.id)),
      ).pipe(
        Effect.mapError((error) =>
          (error as any) instanceof SessionSupervisorError
            ? new ServiceUnavailableError({ message: (error as any).reason, service: "question" })
            : error),
      )
    })
    const questionReply = Effect.fn("SessionHttpApi.questionReply")(function* (ctx: {
      params: { sessionID: SessionID; requestID: QuestionV2.ID }
      payload: typeof QuestionV2.Reply.Type
    }) {
      const owner = yield* requireSession(ctx.params.sessionID)
      yield* requireQuestionOwner(owner.id)
      yield* withLocationQuestions(
        QuestionV2.Service.use((service) => service.reply({
          sessionID: owner.id,
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })),
      ).pipe(
        Effect.catchTag("QuestionV2.NotFoundError", () => Effect.fail(new ApiNotFoundError({
          name: "NotFoundError",
          data: { message: "Pending question not found" },
        }))),
        Effect.catchTag("QuestionV2.InvalidReplyError", () => Effect.fail(new HttpApiError.BadRequest({}))),
        Effect.mapError((error) =>
          (error as any) instanceof SessionSupervisorError
            ? new ServiceUnavailableError({ message: (error as any).reason, service: "question" })
            : error),
      )
      return undefined
    })
    const questionReject = Effect.fn("SessionHttpApi.questionReject")(function* (ctx: {
      params: { sessionID: SessionID; requestID: QuestionV2.ID }
    }) {
      const owner = yield* requireSession(ctx.params.sessionID)
      yield* requireQuestionOwner(owner.id)
      yield* withLocationQuestions(
        QuestionV2.Service.use((service) => service.reject({
          sessionID: owner.id,
          requestID: ctx.params.requestID,
        })),
      ).pipe(
        Effect.catchTag("QuestionV2.NotFoundError", () => Effect.fail(new ApiNotFoundError({
          name: "NotFoundError",
          data: { message: "Pending question not found" },
        }))),
        Effect.mapError((error) =>
          (error as any) instanceof SessionSupervisorError
            ? new ServiceUnavailableError({ message: (error as any).reason, service: "question" })
            : error),
      )
      return undefined
    })
    const scope = yield* Scope.Scope
    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireQuestionOwner(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const subagents = Effect.fn("SessionHttpApi.subagents")(function* (ctx: { params: { sessionID: SessionID } }) {
      const parent = yield* requireSession(ctx.params.sessionID)
      yield* requireQuestionOwner(parent.id)
      const linked = yield* session.children(parent.id)
      const directChildren = linked
        .filter((child) =>
          child.parentID === parent.id && child.directory === parent.directory && child.workspaceID === parent.workspaceID &&
          subagentDelivery(child.metadata?.horizonSubagentDelivery)?.lane === "direct_session" &&
          child.metadata?.horizonAgentProfileV2 !== undefined,
        )
        .sort((left, right) => right.time.updated - left.time.updated || right.id.localeCompare(left.id))
      const visible = directChildren.slice(0, 64)
      const projection: SubagentStatusV1.ChildV1[] = []
      let omitted = 0
      for (const child of visible) {
        const pin = directProfilePin(child.metadata?.horizonAgentProfileV2)
        if (!pin) {
          omitted++
          continue
        }
        const attemptID = child.metadata?.horizonDirectAttemptID
        if (typeof attemptID !== "string" || !/^att_[a-z0-9]{16,64}$/.test(attemptID)) {
          omitted++
          continue
        }
        const snapshot = yield* ManagedControl.snapshotDirectAttempt(attemptID).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        const scopeDigest = child.metadata?.[DIRECT_SCOPE_PIN_KEY]
        const ownedAttempt = snapshot && snapshot.attemptID === attemptID && snapshot.parentSessionID === parent.id &&
          snapshot.childSessionID === child.id && typeof scopeDigest === "string" &&
          /^(sha256|blake3):[0-9a-f]{64}$/.test(scopeDigest) && snapshot.scopeDigest === scopeDigest
          ? snapshot
          : undefined
        const sessionStatus = yield* statusSvc.get(child.id)
        const pendingMessages = (yield* session.directInboxList(child.id)).filter((row) =>
          row.state !== "denied" && (row.state !== "consumed" || row.host_consumed_ack_digest === null),
        ).length
        // HostKernel enforces the same 32-row pending ceiling. A larger local
        // projection signals inconsistent durable state, so omit the child
        // instead of emitting a truncated count that could look authoritative.
        if (pendingMessages > 32) {
          omitted++
          continue
        }
        const delivery = subagentDelivery(child.metadata?.horizonSubagentDelivery)
        const state = ownedAttempt?.phase === "EXECUTING"
          ? "running"
          : ownedAttempt?.phase === "SUCCEEDED"
            ? "completed"
            : ownedAttempt?.phase === "FAILED"
              ? "failed"
              : ownedAttempt?.phase === "CANCELLED"
                ? "cancelled"
                : "unknown"
        projection.push({
          schemaVersion: 1 as const,
          sessionId: child.id,
          parentSessionId: parent.id,
          title: child.title,
          state,
          activeRequest: sessionStatus.type === "busy",
          profileId: pin.profileID,
          profileRevision: pin.profileRevision,
          profileDigest: pin.profileDigest,
          permissionScopeDigest: pin.permissionsDigest,
          directAttemptId: attemptID,
          pendingMessages,
          deliveryAckState: delivery?.lane === "direct_session" ? delivery.ackState : "unknown",
          lastSequence: delivery?.lane === "direct_session" ? delivery.sequence : "0",
          resultDigest: ownedAttempt?.resultDigest ?? null,
          receiptDigest: ownedAttempt?.receiptDigest ?? null,
          failureCode: ownedAttempt?.failureCode ?? null,
          createdAt: child.time.created,
          updatedAt: child.time.updated,
        })
      }
      return Schema.decodeUnknownSync(SubagentStatusV1.ListV1, { onExcessProperty: "error" })({
        schemaVersion: 1,
        parentSessionId: parent.id,
        children: projection,
        truncated: directChildren.length > visible.length || omitted > 0,
      })
    })

    const subagentWait = Effect.fn("SessionHttpApi.subagentWait")(function* (ctx: {
      params: { sessionID: SessionID; childSessionID: SessionID }
      query: typeof SubagentWaitQuery.Type
    }) {
      const parent = yield* requireSession(ctx.params.sessionID)
      yield* requireQuestionOwner(parent.id)
      const childID = ctx.params.childSessionID
      const deadline = Date.now() + ctx.query.timeoutMs
      const project = Effect.fn("SessionHttpApi.projectWaitChild")(function* () {
        // Wait is a repeated read. Re-resolve the authenticated parent on each
        // sample so a changed owner/workspace scope cannot inherit the initial
        // authorization for the remainder of a long poll.
        const currentParent = yield* requireSession(parent.id)
        yield* requireQuestionOwner(currentParent.id)
        if (currentParent.directory !== parent.directory || currentParent.workspaceID !== parent.workspaceID) {
          return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Direct child Session not found" } })
        }
        const child = yield* requireSession(childID)
        if (child.parentID !== currentParent.id || child.directory !== currentParent.directory ||
          child.workspaceID !== currentParent.workspaceID) {
          return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Direct child Session not found" } })
        }
        if (subagentDelivery(child.metadata?.horizonSubagentDelivery)?.lane !== "direct_session") {
          return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Direct child Session not found" } })
        }
        const pin = directProfilePin(child.metadata?.horizonAgentProfileV2)
        const attemptID = child.metadata?.horizonDirectAttemptID
        if (!pin || typeof attemptID !== "string" || !/^att_[a-z0-9]{16,64}$/.test(attemptID)) {
          return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Direct child Attempt not found" } })
        }
        const snapshot = yield* ManagedControl.snapshotDirectAttempt(attemptID).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        const scopeDigest = child.metadata?.[DIRECT_SCOPE_PIN_KEY]
        const ownedAttempt = snapshot && snapshot.attemptID === attemptID && snapshot.parentSessionID === parent.id &&
          snapshot.childSessionID === child.id && typeof scopeDigest === "string" &&
          /^(sha256|blake3):[0-9a-f]{64}$/.test(scopeDigest) && snapshot.scopeDigest === scopeDigest
          ? snapshot
          : undefined
        const status = yield* statusSvc.get(child.id)
        const pendingMessages = (yield* session.directInboxList(child.id)).filter((row) =>
          row.state !== "denied" && (row.state !== "consumed" || row.host_consumed_ack_digest === null),
        ).length
        if (pendingMessages > 32) {
          return yield* new ServiceUnavailableError({ message: "Direct child mailbox capacity projection is inconsistent", service: "session" })
        }
        const delivery = subagentDelivery(child.metadata?.horizonSubagentDelivery)
        const state = ownedAttempt?.phase === "EXECUTING"
          ? "running"
          : ownedAttempt?.phase === "SUCCEEDED"
            ? "completed"
            : ownedAttempt?.phase === "FAILED"
              ? "failed"
              : ownedAttempt?.phase === "CANCELLED"
                ? "cancelled"
                : "unknown"
        return Schema.decodeUnknownSync(SubagentStatusV1.ChildV1, { onExcessProperty: "error" })({
          schemaVersion: 1,
          sessionId: child.id,
          parentSessionId: parent.id,
          title: child.title,
          state,
          activeRequest: status.type === "busy",
          profileId: pin.profileID,
          profileRevision: pin.profileRevision,
          profileDigest: pin.profileDigest,
          permissionScopeDigest: pin.permissionsDigest,
          directAttemptId: attemptID,
          pendingMessages,
          deliveryAckState: delivery?.lane === "direct_session" ? delivery.ackState : "unknown",
          lastSequence: delivery?.lane === "direct_session" ? delivery.sequence : "0",
          resultDigest: ownedAttempt?.resultDigest ?? null,
          receiptDigest: ownedAttempt?.receiptDigest ?? null,
          failureCode: ownedAttempt?.failureCode ?? null,
          createdAt: child.time.created,
          updatedAt: child.time.updated,
        })
      })

      const first = yield* project()
      const isTerminal = (value: SubagentStatusV1.ChildV1) => value.state !== "running"
      let current = first
      let outcome: "terminal" | "activity" | "timeout" = isTerminal(first) ? "terminal" : "timeout"
      while (!isTerminal(current) && Date.now() < deadline) {
        yield* Effect.sleep("200 millis")
        const next = yield* project()
        if (isTerminal(next)) {
          current = next
          outcome = "terminal"
          break
        }
        const changed = next.activeRequest !== current.activeRequest ||
          next.pendingMessages !== current.pendingMessages ||
          next.deliveryAckState !== current.deliveryAckState || next.lastSequence !== current.lastSequence ||
          next.resultDigest !== current.resultDigest || next.receiptDigest !== current.receiptDigest ||
          next.failureCode !== current.failureCode || next.updatedAt !== current.updatedAt
        current = next
        if (changed) {
          outcome = "activity"
          break
        }
      }
      return Schema.decodeUnknownSync(SubagentStatusV1.WaitResultV1, { onExcessProperty: "error" })({
        schemaVersion: 1,
        child: current,
        outcome,
      })
    })

    const subagentMessage = Effect.fn("SessionHttpApi.subagentMessage")(function* (ctx: {
      params: { sessionID: SessionID; childSessionID: SessionID }
      payload: typeof SubagentMessagePayload.Type
    }) {
      const parent = yield* requireSession(ctx.params.sessionID)
      yield* requireQuestionOwner(parent.id)
      const child = yield* requireSession(ctx.params.childSessionID)
      const delivery = subagentDelivery(child.metadata?.horizonSubagentDelivery)
      const encoded = new TextEncoder().encode(ctx.payload.content)
      if (encoded.byteLength === 0 || encoded.byteLength > 16 * 1024) return yield* new HttpApiError.BadRequest({})
      const payloadDigest = digestText(ctx.payload.content)
      if (child.parentID !== parent.id) {
        return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Child Session not found" } })
      }
      if (delivery?.lane === "managed_attempt") {
        // Managed child authority is always re-resolved from HostKernel. The
        // Session metadata below is used only to locate that authenticated
        // projection; no request-body field can select a Goal, Run or Attempt.
        const lineage = child.metadata?.horizonManagedAttempt
        const target = child.metadata?.horizonManagedWorktreeTarget
        const profilePin = child.metadata?.horizonAgentProfileV2
        const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
        if (!Option.isSome(authenticated) || authenticated.value.principal.kind !== "server_auth" ||
          typeof lineage !== "object" || lineage === null || Array.isArray(lineage) ||
          typeof target !== "object" || target === null || Array.isArray(target) ||
          typeof profilePin !== "object" || profilePin === null || Array.isArray(profilePin)) {
          return { status: "UNAVAILABLE" as const, messageId: null, mailboxSequence: null,
            reason: "managed child authority is unavailable to this authenticated principal", challengeId: null, effectId: null }
        }
        const managed = lineage as Record<string, unknown>
        const worktree = target as Record<string, unknown>
        const profileMetadata = profilePin as Record<string, unknown>
        const envelopeAuthority = delivery.authority as Record<string, unknown>
        if (managed.schemaVersion !== 1 || managed.goalID !== envelopeAuthority.goalId || managed.runID !== envelopeAuthority.runId ||
          managed.taskID !== envelopeAuthority.taskId || managed.attemptID !== envelopeAuthority.attemptId ||
          managed.ownerEpoch !== delivery.ownerEpoch || managed.bindingDigest !== envelopeAuthority.delegationBindingDigest ||
          delivery.parentExecutionId !== parent.id || delivery.childExecutionId !== child.id ||
          typeof worktree.locationID !== "string" || typeof worktree.workspaceID !== "string" ||
          typeof worktree.canonicalRoot !== "string" || typeof profileMetadata.profileID !== "string" ||
          typeof profileMetadata.profileRevision !== "string" || typeof profileMetadata.profileDigest !== "string" ||
          typeof profileMetadata.permissionCeilingDigest !== "string") {
          return { status: "UNAVAILABLE" as const, messageId: null, mailboxSequence: null,
            reason: "managed child metadata does not match its lane-tagged delivery envelope", challengeId: null, effectId: null }
        }
        const prior = yield* session.managedInboxGetByRequest({ parentSessionID: parent.id, childSessionID: child.id, requestID: ctx.payload.requestId })
        const managedDeliveryMode = ctx.payload.mode === "follow_up" ? "follow_up" as const : "queued" as const
        const hostDeliveryMode = managedDeliveryMode === "queued" ? "queue" as const : "follow_up" as const
        if (prior && (prior.payload_digest !== payloadDigest || prior.payload_bytes !== encoded.byteLength || prior.delivery_mode !== hostDeliveryMode)) {
          return yield* new ConflictError({ message: "Managed child message requestId was reused with different content or delivery mode" })
        }
        const snapshot = yield* ManagedControl.goalReviewSnapshot(String(managed.goalID), authenticated.value.principal).pipe(
          Effect.catch(() => Effect.fail(new ServiceUnavailableError({ message: "Managed Goal authority cannot be inspected", service: "host-kernel" }))),
        )
        if (snapshot.projectRef !== parent.projectID || snapshot.workspaceRef !== parent.workspaceID) {
          return { status: "UNAVAILABLE" as const, messageId: null, mailboxSequence: null,
            reason: "managed Goal is outside the authenticated parent Session workspace", challengeId: null, effectId: null }
        }
        const rootLocationID = yield* withLocationSupervisor(
          SessionSupervisor.Service.use((supervisor) => supervisor.registerHostLocation(
            Location.Ref.make({ directory: AbsolutePath.make(parent.directory) }),
          )),
        ).pipe(Effect.provideService(TrustedPrincipalContext, authenticated.value))
        const recovery = yield* ManagedControl.activeAttemptRecovery({
          trustedPrincipal: authenticated.value.principal,
          goalID: String(managed.goalID), runID: String(managed.runID), locationID: rootLocationID,
          sessionID: parent.id, expectedRevision: snapshot.goalRevision,
        }).pipe(Effect.catch(() => Effect.fail(new ServiceUnavailableError({ message: "Managed Attempt authority cannot be reconciled", service: "host-kernel" }))))
        const attempt = recovery.attempt
        const scope = attempt?.managedAttempt
        if (recovery.status !== "ACTIVE_ATTEMPT" || !attempt || !scope ||
          recovery.goalID !== managed.goalID || recovery.runID !== managed.runID || recovery.sessionID !== parent.id ||
          recovery.locationID !== rootLocationID || recovery.revision !== snapshot.goalRevision ||
          attempt.attemptID !== managed.attemptID || attempt.sessionID !== child.id || attempt.ownerEpoch !== managed.ownerEpoch ||
          attempt.bindingDigest !== managed.bindingDigest || attempt.phase !== "EXECUTING" || attempt.runPhase !== "RUNNING" ||
          scope.attemptID !== managed.attemptID || scope.sessionID !== child.id || scope.ownerEpoch !== managed.ownerEpoch ||
          scope.delegationBindingDigest !== managed.bindingDigest || !/^blake3:[0-9a-f]{64}$/.test(scope.permissionScopeDigest) ||
          scope.expectedManagedRevision !== recovery.revision ||
          scope.locationID !== worktree.locationID || scope.workspaceRevision !== worktree.workspaceRevision) {
          if (prior && ["preparing", "approval_required", "admitted", "appended", "delivering"].includes(prior.state)) {
            yield* session.managedInboxTransition({ messageID: prior.message_id, expected: [prior.state as ManagedSubagentInboxStateV1], state: "unknown" }).pipe(Effect.ignore)
          }
          return { status: "UNKNOWN" as const, messageId: prior?.message_id ?? null, mailboxSequence: prior?.mailbox_sequence ?? null,
            reason: "the original managed Attempt is not the current live HostKernel authority; no message was reissued", challengeId: null, effectId: null }
        }
        if (prior?.state === "delivering") {
          const pins: ManagedControl.ManagedMessagePinsV1 = {
            lane: "managed_attempt", goalID: prior.goal_id, runID: prior.run_id, taskID: prior.task_id,
            attemptID: prior.attempt_id, parentSessionID: prior.parent_session_id, childSessionID: prior.child_session_id,
            ownerEpoch: prior.owner_epoch, bindingDigest: prior.binding_digest, profileID: prior.profile_id,
            profileRevision: prior.profile_revision, profileDigest: prior.profile_digest,
            permissionScopeDigest: prior.permission_scope_digest, messageID: prior.message_id, deliveryMode: managedDeliveryMode === "queued" ? "queued" : "follow_up",
            payloadDigest: prior.payload_digest, payloadBytes: prior.payload_bytes,
            mailboxSequence: prior.mailbox_sequence, mailboxCapacity: prior.mailbox_capacity,
          }
          const observed = yield* ManagedControl.inspectManagedMessage({ scope, pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          return { status: "UNKNOWN" as const, messageId: prior.message_id, mailboxSequence: prior.mailbox_sequence,
            reason: observed?.status === "QUEUED"
              ? "HostKernel confirms the queue receipt, but Core cannot prove whether the child already consumed it; it was not reinjected"
              : "managed delivery remains ambiguous after restart; exact receipt inspection only", challengeId: null, effectId: null }
        }
        if (prior?.state === "committed" || prior?.state === "consumed") {
          const pins: ManagedControl.ManagedMessagePinsV1 = {
            lane: "managed_attempt", goalID: prior.goal_id, runID: prior.run_id, taskID: prior.task_id,
            attemptID: prior.attempt_id, parentSessionID: prior.parent_session_id, childSessionID: prior.child_session_id,
            ownerEpoch: prior.owner_epoch, bindingDigest: prior.binding_digest, profileID: prior.profile_id,
            profileRevision: prior.profile_revision, profileDigest: prior.profile_digest,
            permissionScopeDigest: prior.permission_scope_digest, messageID: prior.message_id, deliveryMode: "queued",
            payloadDigest: prior.payload_digest, payloadBytes: prior.payload_bytes,
            mailboxSequence: prior.mailbox_sequence, mailboxCapacity: prior.mailbox_capacity,
          }
          const observed = yield* ManagedControl.inspectManagedMessage({ scope, pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const receiptStatus = managedDeliveryMode === "queued" ? "QUEUED" : "FOLLOW_UP_SCHEDULED"
          if (observed?.status !== receiptStatus || observed.receiptDigest !== prior.host_receipt_digest ||
            (managedDeliveryMode === "follow_up" && (observed.wakeReceiptDigest !== prior.wake_receipt_digest ||
              observed.nextRequestSequence !== prior.next_request_sequence))) {
            return { status: "UNKNOWN" as const, messageId: prior.message_id, mailboxSequence: prior.mailbox_sequence,
              reason: "Core ACK and HostKernel queue receipt differ; no delivery was retried", challengeId: null, effectId: null }
          }
          return { status: managedDeliveryMode === "queued" ? "QUEUED" as const : "FOLLOW_UP_SCHEDULED" as const, messageId: prior.message_id, mailboxSequence: prior.mailbox_sequence,
            reason: null, challengeId: null, effectId: null }
        }
        const pinnedAgent = yield* agentSvc.getProfile(String(managed.profileID ?? profileMetadata.profileID), String(profileMetadata.profileRevision)).pipe(
          Effect.catch(() => Effect.fail(new ServiceUnavailableError({ message: "Pinned managed AgentProfileV2 is unavailable", service: "agent-profile" }))),
        )
        const profileProjection = pinnedAgent.options.horizonAgentProfile
        const limits = typeof profileProjection === "object" && profileProjection !== null && !Array.isArray(profileProjection)
          ? (profileProjection as Record<string, unknown>).limits as Record<string, unknown> | undefined : undefined
        const maxMessageBytes = limits?.maxMessageBytes
        const maxPendingMessages = limits?.maxPendingMessages
        if (!limits || String((profileProjection as Record<string, unknown>).profileId) !== profileMetadata.profileID ||
          String((profileProjection as Record<string, unknown>).revision) !== profileMetadata.profileRevision ||
          String((profileProjection as Record<string, unknown>).harness) !== String((profileMetadata as Record<string, unknown>).harness) ||
          recovery.task.profile.profileID !== profileMetadata.profileID || recovery.task.profile.revision !== profileMetadata.profileRevision ||
          recovery.task.profile.definitionDigest !== profileMetadata.profileDigest ||
          typeof maxMessageBytes !== "number" || !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 ||
          typeof maxPendingMessages !== "number" || !Number.isSafeInteger(maxPendingMessages) || maxPendingMessages < 1 ||
          encoded.byteLength > maxMessageBytes || pinnedAgent.model === undefined) {
          return yield* new ServiceUnavailableError({ message: "Pinned managed AgentProfileV2 limits or digest are unavailable", service: "agent-profile" })
        }
        const draft = prior ?? (yield* session.managedInboxCreateDraft({
          messageID: MessageID.ascending(`${parent.id}:${child.id}:${ctx.payload.requestId}`),
          parentSessionID: parent.id, childSessionID: child.id, requestID: ctx.payload.requestId,
          goalID: recovery.goalID, runID: recovery.runID, taskID: recovery.task.taskID, attemptID: attempt.attemptID,
          ownerEpoch: attempt.ownerEpoch, bindingDigest: attempt.bindingDigest,
          profileID: recovery.task.profile.profileID, profileRevision: recovery.task.profile.revision,
          profileDigest: recovery.task.profile.definitionDigest,
          permissionScopeDigest: scope.permissionScopeDigest,
          payload: ctx.payload.content, payloadDigest, payloadBytes: encoded.byteLength,
          deliveryMode: managedDeliveryMode, mailboxCapacity: Math.min(32, maxPendingMessages),
        })).row
        let completedTurnReceiptDigest: string | undefined
        if (managedDeliveryMode === "follow_up") {
          completedTurnReceiptDigest = draft.completed_turn_receipt_digest ?? undefined
          if (!completedTurnReceiptDigest) {
            const history = yield* session.messages({ sessionID: child.id, limit: 512 })
            const latest = MessageV2.latest(history)
            const assistantMessage = latest.assistant
              ? history.findLast((message) => message.info.role === "assistant" && message.info.id === latest.assistant?.id)
              : undefined
            const hasToolCalls = assistantMessage?.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted) ?? false
            if (!latest.user || !latest.assistant || latest.finished?.id !== latest.assistant.id ||
              latest.assistant.parentID !== latest.user.id || !latest.assistant.finish ||
              ["tool-calls", "unknown"].includes(latest.assistant.finish) || hasToolCalls) {
              return { status: "UNAVAILABLE" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence,
                reason: "managed follow-up requires the exact latest completed assistant turn", challengeId: null, effectId: null }
            }
            const authority = ManagedControl.createManagedAttemptAuthority(scope)
            const completion = yield* SessionSupervisor.Service.use((supervisor) =>
              ManagedControl.completeManagedProviderTurn({ authority, assistantEntryID: latest.assistant!.id })
                .pipe(Effect.provideService(SessionSupervisor.Service, supervisor)))
            completedTurnReceiptDigest = completion.completionReceiptDigest
          }
        }
        const pins: ManagedControl.ManagedMessagePinsV1 = {
          lane: "managed_attempt", goalID: draft.goal_id, runID: draft.run_id, taskID: draft.task_id,
          attemptID: draft.attempt_id, parentSessionID: draft.parent_session_id, childSessionID: draft.child_session_id,
          ownerEpoch: draft.owner_epoch, bindingDigest: draft.binding_digest, profileID: draft.profile_id,
          profileRevision: draft.profile_revision, profileDigest: draft.profile_digest,
          permissionScopeDigest: draft.permission_scope_digest, messageID: draft.message_id, deliveryMode: managedDeliveryMode,
          payloadDigest: draft.payload_digest, payloadBytes: draft.payload_bytes,
          mailboxSequence: draft.mailbox_sequence, mailboxCapacity: draft.mailbox_capacity,
        }
        if (prior?.state === "preparing" || prior?.state === "approval_required") {
          const observed = yield* ManagedControl.inspectManagedMessage({ scope, pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const expectedStatus = managedDeliveryMode === "queued" ? "QUEUED" : "FOLLOW_UP_SCHEDULED"
          if (observed?.status === expectedStatus && (managedDeliveryMode === "queued" ||
            observed.wakeReceiptDigest === prior.wake_receipt_digest && observed.nextRequestSequence === prior.next_request_sequence)) {
            yield* session.managedInboxTransition({ messageID: draft.message_id, expected: [prior.state as ManagedSubagentInboxStateV1], state: "committed", hostReceiptDigest: observed.receiptDigest,
              ...(managedDeliveryMode === "follow_up" ? { completedTurnReceiptDigest: prior.completed_turn_receipt_digest, wakeReceiptDigest: observed.wakeReceiptDigest, nextRequestSequence: observed.nextRequestSequence } : {}) })
            return { status: managedDeliveryMode === "queued" ? "QUEUED" as const : "FOLLOW_UP_SCHEDULED" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: null, challengeId: null, effectId: null }
          }
        }
        if (draft.state === "unknown") {
          const observed = yield* ManagedControl.inspectManagedMessage({ scope, pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const expectedStatus = managedDeliveryMode === "queued" ? "QUEUED" : "FOLLOW_UP_SCHEDULED"
          if (observed?.status === expectedStatus && draft.capability_lease_digest && draft.inbox_receipt_digest &&
            (managedDeliveryMode === "queued" || draft.completed_turn_receipt_digest !== null &&
              observed.wakeReceiptDigest !== undefined && observed.nextRequestSequence === (BigInt(scope.requestSequence) + 1n).toString())) {
            const reconciled = yield* session.managedInboxTransition({ messageID: draft.message_id, expected: ["unknown"], state: "committed", hostReceiptDigest: observed.receiptDigest,
              ...(managedDeliveryMode === "follow_up" ? { completedTurnReceiptDigest: draft.completed_turn_receipt_digest, wakeReceiptDigest: observed.wakeReceiptDigest, nextRequestSequence: observed.nextRequestSequence } : {}) })
            return { status: managedDeliveryMode === "queued" ? "QUEUED" as const : "FOLLOW_UP_SCHEDULED" as const, messageId: reconciled.message_id, mailboxSequence: reconciled.mailbox_sequence,
              reason: null, challengeId: null, effectId: null }
          }
          return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence,
            reason: observed?.status === expectedStatus ? "HostKernel has a receipt, but the exact managed delivery transition cannot be reconciled safely" : "managed message authority is unresolved; no retry was attempted",
            challengeId: null, effectId: null }
        }
        const coreReceipt = draft.inbox_receipt_digest
        const prepared = yield* ManagedControl.prepareManagedMessage({ scope, pins, content: draft.payload }).pipe(Effect.result)
        if (prepared._tag === "Failure") {
          return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence,
            reason: "exact managed Guard prepare is unresolved; the durable Core request identity is retained", challengeId: draft.challenge_id, effectId: draft.effect_id }
        }
        if (prepared.success.status === "DENIED") {
          yield* session.managedInboxTransition({ messageID: draft.message_id, expected: [draft.state as ManagedSubagentInboxStateV1], state: "denied", pinsDigest: prepared.success.pinsDigest })
          return { status: "DENIED" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: prepared.success.reasonCode, challengeId: null, effectId: null }
        }
        if (prepared.success.status === "NEEDS_APPROVAL") {
          yield* session.managedInboxTransition({ messageID: draft.message_id, expected: [draft.state as ManagedSubagentInboxStateV1], state: "approval_required",
            challengeID: prepared.success.challengeID, effectID: prepared.success.effectID, pinsDigest: prepared.success.inputDigest })
          return { status: "NEEDS_APPROVAL" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence,
            reason: prepared.success.policySummary, challengeId: prepared.success.challengeID, effectId: prepared.success.effectID }
        }
        let admitted = draft
        if (draft.state !== "admitted" && draft.state !== "appended") admitted = yield* session.managedInboxTransition({
          messageID: draft.message_id, expected: [draft.state as ManagedSubagentInboxStateV1], state: "admitted",
          pinsDigest: prepared.success.pinsDigest, capabilityLeaseDigest: prepared.success.capabilityLeaseDigest,
        })
        if (admitted.state === "admitted") admitted = yield* session.managedInboxTransition({ messageID: draft.message_id, expected: ["admitted"], state: "appended", ...(managedDeliveryMode === "follow_up" ? { completedTurnReceiptDigest } : {}) })
        const committed = yield* ManagedControl.commitManagedMessage({ scope, pins,
          capabilityLeaseDigest: admitted.capability_lease_digest!,
          ...(managedDeliveryMode === "follow_up" ? { completedTurnReceiptDigest } : {}),
          inboxReceipt: { status: managedDeliveryMode === "queued" ? "QUEUED" : "FOLLOW_UP_SCHEDULED", messageID: admitted.message_id, parentSessionID: parent.id,
            childSessionID: child.id, deliveryMode: managedDeliveryMode, mailboxSequence: admitted.mailbox_sequence,
            receiptDigest: coreReceipt },
        }).pipe(Effect.catch(() => ManagedControl.inspectManagedMessage({ scope, pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))) )
        const expectedStatus = managedDeliveryMode === "queued" ? "QUEUED" : "FOLLOW_UP_SCHEDULED"
        if (!committed || committed.status !== expectedStatus || (managedDeliveryMode === "follow_up" &&
          (committed.wakeReceiptDigest === undefined || committed.nextRequestSequence === undefined))) {
          yield* session.managedInboxTransition({ messageID: admitted.message_id, expected: ["appended"], state: "unknown", hostReceiptDigest: committed?.receiptDigest ?? null })
          return { status: "UNKNOWN" as const, messageId: admitted.message_id, mailboxSequence: admitted.mailbox_sequence,
            reason: "HostKernel managed message ACK is unresolved; exact receipt inspection only", challengeId: null, effectId: null }
        }
        const acked = yield* session.managedInboxTransition({ messageID: admitted.message_id, expected: ["appended"], state: "committed", hostReceiptDigest: committed.receiptDigest,
          ...(managedDeliveryMode === "follow_up" ? { completedTurnReceiptDigest, wakeReceiptDigest: committed.wakeReceiptDigest, nextRequestSequence: committed.nextRequestSequence } : {}) })
        return { status: managedDeliveryMode === "queued" ? "QUEUED" as const : "FOLLOW_UP_SCHEDULED" as const, messageId: acked.message_id, mailboxSequence: acked.mailbox_sequence,
          reason: null, challengeId: null, effectId: null }
      }
      if (child.directory !== parent.directory || child.workspaceID !== parent.workspaceID || delivery?.lane !== "direct_session") {
        return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Direct child Session not found" } })
      }
      if (ctx.payload.mode === "follow_up") {
        const turnGate = yield* ManagedControl.requireDirectTurnLifecycle().pipe(Effect.result)
        if (turnGate._tag === "Failure") {
          return { status: "UNAVAILABLE" as const, messageId: null, mailboxSequence: null,
            reason: "HostKernel direct-turn recovery and P1/P8 acceptance have not enabled follow-up dispatch", challengeId: null, effectId: null }
        }
        const profile = directProfilePin(child.metadata?.horizonAgentProfileV2)
        const attemptID = child.metadata?.horizonDirectAttemptID
        const scopeDigest = child.metadata?.[DIRECT_SCOPE_PIN_KEY]
        if (!profile || typeof attemptID !== "string" || !/^att_[a-z0-9]{16,64}$/.test(attemptID) ||
          delivery.ownerEpoch === "0" || typeof scopeDigest !== "string" || !/^(sha256|blake3):[0-9a-f]{64}$/.test(scopeDigest)) {
          return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Direct child Attempt authority not found" } })
        }
        const attempt = yield* ManagedControl.snapshotDirectAttempt(attemptID).pipe(
          Effect.catch(() => Effect.fail(new ServiceUnavailableError({ message: "HostKernel child Attempt cannot be inspected", service: "host-kernel" }))),
        )
        const directAttempt = attempt.directAttempt
        const pinnedAgent = yield* agentSvc.getProfile(profile.profileID, String(profile.profileRevision)).pipe(
          Effect.catch(() => Effect.fail(new ServiceUnavailableError({ message: "Pinned AgentProfileV2 revision is unavailable", service: "agent-profile" }))),
        )
        const profileProjection = pinnedAgent.options.horizonAgentProfile
        const limits = typeof profileProjection === "object" && profileProjection !== null && !Array.isArray(profileProjection)
          ? (profileProjection as Record<string, unknown>).limits as Record<string, unknown> | undefined
          : undefined
        const maxMessageBytes = limits?.maxMessageBytes
        const maxPendingMessages = limits?.maxPendingMessages
        if (!limits || (profileProjection as Record<string, unknown>).profileId !== profile.profileID ||
          String((profileProjection as Record<string, unknown>).revision) !== profile.profileRevision ||
          (profileProjection as Record<string, unknown>).harness !== profile.harness ||
          typeof maxMessageBytes !== "number" || !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 ||
          typeof maxPendingMessages !== "number" || !Number.isSafeInteger(maxPendingMessages) || maxPendingMessages < 1 ||
          encoded.byteLength > maxMessageBytes || pinnedAgent.model === undefined) {
          return yield* new ServiceUnavailableError({ message: "Pinned AgentProfileV2 limits or model are unavailable", service: "agent-profile" })
        }
        const mailboxCapacity = Math.min(32, maxPendingMessages)
        const completedScope = yield* Effect.try({
          try: () => ManagedControl.decodeDirectTurnScopeCandidate(child.metadata?.horizonDirectTurnScope),
          catch: () => new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_conflict", reason: "child has no exact completed turn to follow up" }),
        })
        const completion = child.metadata?.horizonDirectTurnCompletion
        if (attempt.phase !== "EXECUTING" || !directAttempt || attempt.parentSessionID !== parent.id ||
          attempt.childSessionID !== child.id || attempt.scopeDigest !== scopeDigest ||
          !ManagedControl.sameDirectAttemptScope(directAttempt, completedScope.directAttempt) ||
          typeof completion !== "object" || completion === null || Array.isArray(completion) ||
          (completion as Record<string, unknown>).state !== "completed" ||
          (completion as Record<string, unknown>).runnerCycleID !== completedScope.runnerCycleID ||
          (completion as Record<string, unknown>).turnSequence !== completedScope.turnSequence ||
          (completion as Record<string, unknown>).cycleDigest !== completedScope.cycleDigest) {
          return { status: "DENIED" as const, messageId: null, mailboxSequence: null, reason: "the exact child Attempt has no current completed turn for this follow-up", challengeId: null, effectId: null }
        }
        const previous = yield* session.directInboxGetByRequest({ parentSessionID: parent.id, childSessionID: child.id, requestID: ctx.payload.requestId })
        if (previous && (previous.payload_digest !== payloadDigest || previous.payload_bytes !== encoded.byteLength || previous.delivery_mode !== "follow_up")) {
          return yield* new ConflictError({ message: "Direct child message requestId was reused with different payload or delivery mode" })
        }
        if (previous?.state === "denied") return { status: "DENIED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "HostKernel denied this direct follow-up", challengeId: null, effectId: null }
        if (previous?.state === "consumed") {
          if (previous.host_consumed_ack_digest) return { status: "FOLLOW_UP_SCHEDULED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: null, challengeId: null, effectId: null }
          const reconciled = yield* promptSvc.followUpDirectChild({ parentSessionID: parent.id, childSessionID: child.id, messageID: previous.message_id }).pipe(Effect.result)
          return reconciled._tag === "Success"
            ? { status: "FOLLOW_UP_SCHEDULED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: null, challengeId: null, effectId: null }
            : { status: "UNKNOWN" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "follow-up was consumed but its HostKernel capacity acknowledgement is unresolved", challengeId: null, effectId: null }
        }
        let draft = previous
        if (!draft) {
          const messageID = MessageID.ascending(`${parent.id}:${child.id}:${ctx.payload.requestId}`)
          try {
            draft = (yield* session.directInboxCreateDraft({
              messageId: messageID, parentSessionId: parent.id, childSessionId: child.id,
              requestId: ctx.payload.requestId, payload: ctx.payload.content, payloadDigest,
              payloadBytes: encoded.byteLength, deliveryMode: "follow_up", childAttemptId: attemptID,
              childOwnerEpoch: directAttempt.ownerEpoch, profileId: profile.profileID,
              profileRevision: profile.profileRevision, profileDigest: profile.profileDigest,
              permissionScopeDigest: profile.permissionsDigest, mailboxCapacity,
              inboxReceiptDigest: digestText(`${messageID}:preparing`),
            })).row
          } catch (error) {
            return yield* new ConflictError({ message: error instanceof Error ? error.message : "Core direct inbox reservation failed" })
          }
        }
        if (!draft) return yield* new ServiceUnavailableError({ message: "Core direct inbox reservation could not be recovered", service: "host-kernel" })
        if (draft.child_attempt_id !== attemptID || draft.child_owner_epoch !== directAttempt.ownerEpoch ||
          draft.profile_id !== profile.profileID || draft.profile_revision !== profile.profileRevision ||
          draft.profile_digest !== profile.profileDigest || draft.permission_scope_digest !== profile.permissionsDigest ||
          draft.mailbox_capacity !== mailboxCapacity) {
          yield* session.directInboxTransition({ messageID: draft.message_id, expected: ["preparing", "approval_required"], state: "unknown" }).pipe(Effect.ignore)
          return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: "follow-up authority pins changed; only exact receipt inspection is allowed", challengeId: null, effectId: null }
        }
        const pins: ManagedControl.DirectMessagePinsV1 = {
          parentSessionID: parent.id, childSessionID: child.id, childOwnerEpoch: draft.child_owner_epoch,
          profileID: draft.profile_id, profileRevision: draft.profile_revision, profileDigest: draft.profile_digest,
          permissionScopeDigest: draft.permission_scope_digest, directAttemptID: draft.child_attempt_id,
          messageID: draft.message_id, deliveryMode: "follow_up", payloadDigest: draft.payload_digest,
          payloadBytes: draft.payload_bytes, mailboxSequence: draft.mailbox_sequence, mailboxCapacity: draft.mailbox_capacity,
        }
        if (draft.state === "unknown" || draft.state === "delivering") {
          const observed = yield* ManagedControl.inspectDirectMessage({ pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence,
            reason: observed?.status === "FOLLOW_UP_SCHEDULED"
              ? "HostKernel retained the follow-up receipt, but Core cannot prove whether the child runner already consumed it; no replay was attempted"
              : "follow-up dispatch remains uncertain; only exact receipt inspection is permitted",
            challengeId: null, effectId: null }
        }
        const freshTurnAuthorization = yield* ManagedControl.issueFreshTurnAuthorization({ pins, completedTurnScope: completedScope })
          .pipe(Effect.catch((error) => Effect.fail(new ServiceUnavailableError({ message: error.message, service: "host-kernel" }))))
        const inboxDigest = inboxReceiptDigest({
          messageID: draft.message_id, parentSessionID: parent.id, childSessionID: child.id,
          deliveryMode: "follow_up", directAttemptID: draft.child_attempt_id,
          childOwnerEpoch: draft.child_owner_epoch, profileID: draft.profile_id,
          profileRevision: draft.profile_revision, profileDigest: draft.profile_digest,
          permissionScopeDigest: draft.permission_scope_digest, payloadDigest: draft.payload_digest,
          payloadBytes: draft.payload_bytes, mailboxSequence: draft.mailbox_sequence, mailboxCapacity: draft.mailbox_capacity,
        })
        if (draft.state === "preparing" || draft.state === "approval_required") {
          const prepared = yield* ManagedControl.prepareDirectMessage({ pins, content: draft.payload, mailboxCapacity: draft.mailbox_capacity, freshTurnAuthorization })
            .pipe(Effect.result)
          if (prepared._tag === "Failure") return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: "exact follow-up prepare is unresolved; the original inbox identity is retained", challengeId: draft.challenge_id, effectId: draft.effect_id }
          if (prepared.success.status === "DENIED") {
            yield* session.directInboxTransition({ messageID: draft.message_id, expected: [draft.state], state: "denied", pinsDigest: prepared.success.pinsDigest })
            return { status: "DENIED" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: prepared.success.reasonCode, challengeId: null, effectId: null }
          }
          if (prepared.success.status === "NEEDS_APPROVAL") {
            yield* session.directInboxTransition({
              messageID: draft.message_id, expected: [draft.state], state: "approval_required",
              challengeID: prepared.success.challengeID, effectID: prepared.success.effectID,
              approvalExpiresAtUnixMs: prepared.success.expiresAtUnixMs,
              approvalArgumentSummary: JSON.stringify(prepared.success.argumentSummary),
              approvalPolicySummary: prepared.success.policySummary, pinsDigest: prepared.success.inputDigest,
              inboxReceiptDigest: inboxDigest,
            })
            return { status: "NEEDS_APPROVAL" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: prepared.success.policySummary, challengeId: prepared.success.challengeID, effectId: prepared.success.effectID }
          }
          draft = yield* session.directInboxTransition({
            messageID: draft.message_id, expected: [draft.state], state: "admitted",
            capabilityLeaseDigest: prepared.success.capabilityLeaseDigest, pinsDigest: prepared.success.pinsDigest,
            inboxReceiptDigest: inboxDigest,
          })
        }
        if (draft.state === "admitted") draft = yield* session.directInboxTransition({ messageID: draft.message_id, expected: ["admitted"], state: "appended" })
        if (draft.state === "appended") {
          if (!draft.capability_lease_digest || draft.inbox_receipt_digest !== inboxDigest) {
            return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: "admitted follow-up has no exact retained one-use lease or inbox receipt", challengeId: null, effectId: null }
          }
          const committed = yield* ManagedControl.commitDirectMessage({
            pins, capabilityLeaseDigest: draft.capability_lease_digest,
            inboxReceipt: { messageID: draft.message_id, parentSessionID: parent.id, childSessionID: child.id,
              deliveryMode: "follow_up", mailboxSequence: draft.mailbox_sequence, receiptDigest: inboxDigest },
          }).pipe(Effect.catch(() => ManagedControl.inspectDirectMessage({ pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))))
          if (!committed || committed.status !== "FOLLOW_UP_SCHEDULED") {
            yield* session.directInboxTransition({ messageID: draft.message_id, expected: ["appended"], state: "unknown", hostReceiptDigest: committed?.receiptDigest ?? null })
            return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: "HostKernel follow-up commit is unresolved; the child was not woken", challengeId: null, effectId: null }
          }
          draft = yield* session.directInboxTransition({ messageID: draft.message_id, expected: ["appended"], state: "committed", hostReceiptDigest: committed.receiptDigest })
        }
        const committedReceipt = yield* ManagedControl.inspectDirectMessage({ pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (draft.state !== "committed" || committedReceipt?.status !== "FOLLOW_UP_SCHEDULED" ||
          committedReceipt.receiptDigest !== draft.host_receipt_digest) {
          return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: "the follow-up commit receipt is unresolved; the child was not woken", challengeId: null, effectId: null }
        }
        const wake = yield* promptSvc.followUpDirectChild({ parentSessionID: parent.id, childSessionID: child.id,
          messageID: draft.message_id, freshTurnAuthorization }).pipe(Effect.result)
        if (wake._tag === "Failure") {
          yield* session.directInboxTransition({ messageID: draft.message_id, expected: ["delivering"], state: "unknown" }).pipe(Effect.ignore)
          return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: "the exact committed follow-up was not confirmed through the serialized child runner", challengeId: null, effectId: null }
        }
        return { status: "FOLLOW_UP_SCHEDULED" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: null, challengeId: null, effectId: null }
      }
      const profile = directProfilePin(child.metadata?.horizonAgentProfileV2)
      const attemptID = child.metadata?.horizonDirectAttemptID
      const scopeDigest = child.metadata?.[DIRECT_SCOPE_PIN_KEY]
      const previous = yield* session.directInboxGetByRequest({
        parentSessionID: parent.id,
        childSessionID: child.id,
        requestID: ctx.payload.requestId,
      })
      if (previous) {
        if (previous.payload_digest !== payloadDigest || previous.payload_bytes !== encoded.byteLength || previous.delivery_mode !== "queue") {
          return yield* new ConflictError({ message: "Direct child message requestId was reused with different payload or delivery mode" })
        }
        const pins: ManagedControl.DirectMessagePinsV1 = {
          parentSessionID: previous.parent_session_id,
          childSessionID: previous.child_session_id,
          childOwnerEpoch: previous.child_owner_epoch,
          profileID: previous.profile_id,
          profileRevision: previous.profile_revision,
          profileDigest: previous.profile_digest,
          permissionScopeDigest: previous.permission_scope_digest,
          directAttemptID: previous.child_attempt_id,
          messageID: previous.message_id,
          deliveryMode: "queued",
          payloadDigest: previous.payload_digest,
          payloadBytes: previous.payload_bytes,
          mailboxSequence: previous.mailbox_sequence,
          mailboxCapacity: previous.mailbox_capacity,
        }
        if (previous.state === "committed" || previous.state === "consumed") {
          return { status: "QUEUED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: null, challengeId: null, effectId: null }
        }
        if (previous.state === "preparing") {
          // Recover a lost prepare reply only by replaying the exact journal key,
          // pins and payload in the same live child Attempt/owner epoch. The
          // HostKernel journal returns its retained challenge/lease; it cannot
          // mint a replacement for this immutable message identity.
          const sameLiveAuthority = profile && typeof attemptID === "string" &&
            attemptID === previous.child_attempt_id && delivery.ownerEpoch === previous.child_owner_epoch &&
            profile.profileID === previous.profile_id && profile.profileRevision === previous.profile_revision &&
            profile.profileDigest === previous.profile_digest && profile.permissionsDigest === previous.permission_scope_digest &&
            typeof scopeDigest === "string"
          if (!sameLiveAuthority) {
            const observed = yield* ManagedControl.inspectDirectMessage({ pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (observed?.status === "QUEUED") {
              yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["preparing", "appended", "admitted", "unknown"], state: "committed", hostReceiptDigest: observed.receiptDigest })
              return { status: "QUEUED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: null, challengeId: null, effectId: null }
            }
            yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["preparing"], state: "unknown" })
            return { status: "UNKNOWN" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "the original prepare belongs to a stale Attempt or owner epoch; exact inspection only is permitted", challengeId: null, effectId: null }
          }
          const live = yield* ManagedControl.snapshotDirectAttempt(previous.child_attempt_id).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!live || live.phase !== "EXECUTING" || live.parentSessionID !== parent.id || live.childSessionID !== child.id || live.scopeDigest !== scopeDigest) {
            yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["preparing"], state: "unknown" })
            return { status: "UNKNOWN" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "the original child Attempt is no longer live; prepare cannot be replayed", challengeId: null, effectId: null }
          }
          const retry = yield* ManagedControl.prepareDirectMessage({ pins, content: previous.payload, mailboxCapacity: previous.mailbox_capacity }).pipe(Effect.result)
          if (retry._tag === "Failure") {
            // Leave PREPARING durable: a same-epoch exact retry can reconcile a
            // lost reply. A restart changes epoch and takes the fail-closed path.
            return { status: "UNKNOWN" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "exact same-epoch HostKernel prepare replay is unresolved; the immutable Core reservation is retained", challengeId: null, effectId: null }
          }
          const result = retry.success
          if (result.status === "DENIED") {
            yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["preparing"], state: "denied", pinsDigest: result.pinsDigest })
            return { status: "DENIED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: result.reasonCode, challengeId: null, effectId: null }
          }
          if (result.status === "NEEDS_APPROVAL") {
            const receiptDigest = inboxReceiptDigest({
              messageID: previous.message_id, parentSessionID: parent.id, childSessionID: child.id,
              deliveryMode: "queued", directAttemptID: previous.child_attempt_id,
              childOwnerEpoch: previous.child_owner_epoch, profileID: previous.profile_id,
              profileRevision: previous.profile_revision, profileDigest: previous.profile_digest,
              permissionScopeDigest: previous.permission_scope_digest, payloadDigest: previous.payload_digest,
              payloadBytes: previous.payload_bytes, mailboxSequence: previous.mailbox_sequence,
              mailboxCapacity: previous.mailbox_capacity,
            })
            yield* session.directInboxTransition({
              messageID: previous.message_id, expected: ["preparing"], state: "approval_required",
              challengeID: result.challengeID, effectID: result.effectID,
              approvalExpiresAtUnixMs: result.expiresAtUnixMs,
              approvalArgumentSummary: JSON.stringify(result.argumentSummary),
              approvalPolicySummary: result.policySummary, pinsDigest: result.inputDigest,
              inboxReceiptDigest: receiptDigest,
            })
            return { status: "NEEDS_APPROVAL" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: result.policySummary, challengeId: result.challengeID, effectId: result.effectID }
          }
          const receiptDigest = inboxReceiptDigest({
            messageID: previous.message_id, parentSessionID: parent.id, childSessionID: child.id,
            deliveryMode: "queued", directAttemptID: previous.child_attempt_id,
            childOwnerEpoch: previous.child_owner_epoch, profileID: previous.profile_id,
            profileRevision: previous.profile_revision, profileDigest: previous.profile_digest,
            permissionScopeDigest: previous.permission_scope_digest, payloadDigest: previous.payload_digest,
            payloadBytes: previous.payload_bytes, mailboxSequence: previous.mailbox_sequence,
            mailboxCapacity: previous.mailbox_capacity,
          })
          yield* session.directInboxTransition({
            messageID: previous.message_id, expected: ["preparing"], state: "admitted",
            capabilityLeaseDigest: result.capabilityLeaseDigest, pinsDigest: result.pinsDigest,
            inboxReceiptDigest: receiptDigest,
          })
          yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["admitted"], state: "appended" })
          const committed = yield* ManagedControl.commitDirectMessage({
            pins: result.authorityPins,
            capabilityLeaseDigest: result.capabilityLeaseDigest,
            inboxReceipt: { messageID: previous.message_id, parentSessionID: parent.id, childSessionID: child.id, deliveryMode: "queued", mailboxSequence: previous.mailbox_sequence, receiptDigest },
          }).pipe(Effect.catch(() => ManagedControl.inspectDirectMessage({ pins: result.authorityPins }).pipe(Effect.catch(() => Effect.succeed(undefined)))) )
          if (!committed || committed.status !== "QUEUED") {
            yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["appended"], state: "unknown", hostReceiptDigest: committed?.receiptDigest ?? null })
            return { status: "UNKNOWN" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "replayed prepare was admitted but commit remains unresolved", challengeId: null, effectId: null }
          }
          yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["appended"], state: "committed", hostReceiptDigest: committed.receiptDigest })
          return { status: "QUEUED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: null, challengeId: null, effectId: null }
        }
        if (previous.state === "approval_required") {
          const sameLiveAuthority = profile && typeof attemptID === "string" &&
            attemptID === previous.child_attempt_id && delivery.ownerEpoch === previous.child_owner_epoch &&
            profile.profileID === previous.profile_id && profile.profileRevision === previous.profile_revision &&
            profile.profileDigest === previous.profile_digest && profile.permissionsDigest === previous.permission_scope_digest
          if (!sameLiveAuthority) {
            const observed = yield* ManagedControl.inspectDirectMessage({ pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (observed?.status === "QUEUED") {
              yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["approval_required", "appended", "unknown", "admitted"], state: "committed", hostReceiptDigest: observed.receiptDigest })
              return { status: "QUEUED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: null, challengeId: null, effectId: null }
            }
            return { status: "UNKNOWN" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "the original approval is bound to a stale Attempt; only exact receipt inspection is permitted", challengeId: previous.challenge_id, effectId: previous.effect_id }
          }
          const approvalRetry = yield* ManagedControl.prepareDirectMessage({
            pins,
            content: previous.payload,
            mailboxCapacity: previous.mailbox_capacity,
          }).pipe(Effect.result)
          if (approvalRetry._tag === "Failure") {
            yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["approval_required"], state: "unknown" })
            return { status: "UNKNOWN" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "Guard approval outcome could not be reconciled through the exact message prepare; inspect before retrying", challengeId: null, effectId: null }
          }
          const approvedPrepare = approvalRetry.success
          if (approvedPrepare.status === "NEEDS_APPROVAL") {
            yield* session.directInboxTransition({
              messageID: previous.message_id,
              expected: ["approval_required"],
              state: "approval_required",
              challengeID: approvedPrepare.challengeID,
              effectID: approvedPrepare.effectID,
              approvalExpiresAtUnixMs: approvedPrepare.expiresAtUnixMs,
              approvalArgumentSummary: JSON.stringify(approvedPrepare.argumentSummary),
              approvalPolicySummary: approvedPrepare.policySummary,
            })
            return { status: "NEEDS_APPROVAL" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: approvedPrepare.policySummary, challengeId: approvedPrepare.challengeID, effectId: approvedPrepare.effectID }
          }
          if (approvedPrepare.status === "DENIED") {
            yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["approval_required"], state: "denied", pinsDigest: approvedPrepare.pinsDigest })
            return { status: "DENIED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: approvedPrepare.reasonCode, challengeId: null, effectId: null }
          }
          yield* session.directInboxTransition({
            messageID: previous.message_id,
            expected: ["approval_required"],
            state: "admitted",
            capabilityLeaseDigest: approvedPrepare.capabilityLeaseDigest,
            pinsDigest: approvedPrepare.pinsDigest,
          })
          yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["admitted"], state: "appended" })
          const inboxReceipt: ManagedControl.DirectMessageInboxReceiptV1 = {
            messageID: previous.message_id,
            parentSessionID: parent.id,
            childSessionID: child.id,
            deliveryMode: "queued",
            mailboxSequence: previous.mailbox_sequence,
            receiptDigest: previous.inbox_receipt_digest,
          }
          const committed = yield* ManagedControl.commitDirectMessage({
            pins: approvedPrepare.authorityPins,
            capabilityLeaseDigest: approvedPrepare.capabilityLeaseDigest,
            inboxReceipt,
          }).pipe(Effect.catch(() => ManagedControl.inspectDirectMessage({ pins: approvedPrepare.authorityPins }).pipe(Effect.catch(() => Effect.succeed(undefined)))))
          if (!committed || committed.status !== "QUEUED") {
            yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["appended"], state: "unknown", hostReceiptDigest: committed?.receiptDigest ?? null })
            return { status: "UNKNOWN" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "approved message commit is unresolved; inspect the existing request identity", challengeId: null, effectId: null }
          }
          yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["appended"], state: "committed", hostReceiptDigest: committed.receiptDigest })
          return { status: "QUEUED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: null, challengeId: null, effectId: null }
        }
        if (previous.state === "denied") {
          return { status: "DENIED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "HostKernel denied this direct message", challengeId: null, effectId: null }
        }
        const recovered = yield* ManagedControl.inspectDirectMessage({ pins }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (recovered?.status === "QUEUED") {
          if (["appended", "unknown", "admitted"].includes(previous.state)) {
            yield* session.directInboxTransition({ messageID: previous.message_id, expected: ["appended", "unknown", "admitted"], state: "committed", hostReceiptDigest: recovered.receiptDigest })
          }
          return { status: "QUEUED" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: null, challengeId: null, effectId: null }
        }
        return { status: "UNKNOWN" as const, messageId: previous.message_id, mailboxSequence: previous.mailbox_sequence, reason: "HostKernel receipt is unresolved; the original Core inbox entry was retained and not reissued", challengeId: null, effectId: null }
      }
      if (!profile || typeof attemptID !== "string" || !/^att_[a-z0-9]{16,64}$/.test(attemptID) ||
        delivery.ownerEpoch === "0" || typeof scopeDigest !== "string" || !/^(sha256|blake3):[0-9a-f]{64}$/.test(scopeDigest)) {
        return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Direct child Attempt authority not found" } })
      }
      const attempt = yield* ManagedControl.snapshotDirectAttempt(attemptID).pipe(
        Effect.catch(() => Effect.fail(new ServiceUnavailableError({ message: "HostKernel child Attempt cannot be inspected", service: "host-kernel" }))),
      )
      if (attempt.phase !== "EXECUTING" || attempt.parentSessionID !== parent.id || attempt.childSessionID !== child.id || attempt.scopeDigest !== scopeDigest) {
        return { status: "DENIED" as const, messageId: null, mailboxSequence: null, reason: "the exact child DirectAttempt is not live for this parent/profile scope", challengeId: null, effectId: null }
      }
      const messageID = MessageID.ascending(`${parent.id}:${child.id}:${ctx.payload.requestId}`)
      const nowPlaceholder = digestText(`${messageID}:preparing`)
      let reservation
      try {
        reservation = yield* session.directInboxCreateDraft({
          messageId: messageID,
          parentSessionId: parent.id,
          childSessionId: child.id,
          requestId: ctx.payload.requestId,
          payload: ctx.payload.content,
          payloadDigest,
          payloadBytes: encoded.byteLength,
          deliveryMode: "queue",
          childAttemptId: attemptID,
          childOwnerEpoch: delivery.ownerEpoch,
          profileId: profile.profileID,
          profileRevision: profile.profileRevision,
          profileDigest: profile.profileDigest,
          permissionScopeDigest: profile.permissionsDigest,
          mailboxCapacity: 32,
          inboxReceiptDigest: nowPlaceholder,
        })
      } catch (error) {
        return yield* new ConflictError({ message: error instanceof Error ? error.message : "Core direct inbox reservation failed" })
      }
      const draft = reservation.row
      // A reservation created by another concurrent request is always reconciled
      // by the immutable HostKernel message identity, never prepared a second time.
      if (!reservation.created || draft.message_id !== messageID || draft.state !== "preparing") {
        return { status: "UNKNOWN" as const, messageId: draft.message_id, mailboxSequence: draft.mailbox_sequence, reason: "an earlier direct inbox reservation requires receipt reconciliation", challengeId: draft.challenge_id, effectId: draft.effect_id }
      }
      const pins: ManagedControl.DirectMessagePinsV1 = {
        parentSessionID: parent.id,
        childSessionID: child.id,
        childOwnerEpoch: delivery.ownerEpoch,
        profileID: profile.profileID,
        profileRevision: profile.profileRevision,
        profileDigest: profile.profileDigest,
        permissionScopeDigest: profile.permissionsDigest,
        directAttemptID: attemptID,
        messageID,
        deliveryMode: "queued",
        payloadDigest,
        payloadBytes: encoded.byteLength,
        mailboxSequence: draft.mailbox_sequence,
        mailboxCapacity: draft.mailbox_capacity,
      }
      const receiptDigest = inboxReceiptDigest({
        messageID,
        parentSessionID: parent.id,
        childSessionID: child.id,
        deliveryMode: "queued",
        directAttemptID: attemptID,
        childOwnerEpoch: delivery.ownerEpoch,
        profileID: profile.profileID,
        profileRevision: profile.profileRevision,
        profileDigest: profile.profileDigest,
        permissionScopeDigest: profile.permissionsDigest,
        payloadDigest,
        payloadBytes: encoded.byteLength,
        mailboxSequence: draft.mailbox_sequence,
        mailboxCapacity: draft.mailbox_capacity,
      })
      const prepared = yield* ManagedControl.prepareDirectMessage({ pins, content: ctx.payload.content, mailboxCapacity: draft.mailbox_capacity }).pipe(Effect.result)
      if (prepared._tag === "Failure") {
        return {
          status: "UNKNOWN" as const,
          messageId: messageID,
          mailboxSequence: draft.mailbox_sequence,
          reason: "HostKernel prepare outcome is unresolved; the payload and original identity were retained for inspection",
          challengeId: null,
          effectId: null,
        }
      }
      const preparedResult = prepared.success
      if (preparedResult.status === "DENIED") {
        yield* session.directInboxTransition({ messageID, expected: ["preparing"], state: "denied", pinsDigest: preparedResult.pinsDigest })
        return { status: "DENIED" as const, messageId: messageID, mailboxSequence: draft.mailbox_sequence, reason: preparedResult.reasonCode, challengeId: null, effectId: null }
      }
      if (preparedResult.status === "NEEDS_APPROVAL") {
        yield* session.directInboxTransition({
          messageID,
          expected: ["preparing"],
          state: "approval_required",
          challengeID: preparedResult.challengeID,
          effectID: preparedResult.effectID,
          approvalExpiresAtUnixMs: preparedResult.expiresAtUnixMs,
          approvalArgumentSummary: JSON.stringify(preparedResult.argumentSummary),
          approvalPolicySummary: preparedResult.policySummary,
          pinsDigest: preparedResult.inputDigest,
          inboxReceiptDigest: receiptDigest,
        })
        return { status: "NEEDS_APPROVAL" as const, messageId: messageID, mailboxSequence: draft.mailbox_sequence, reason: preparedResult.policySummary, challengeId: preparedResult.challengeID, effectId: preparedResult.effectID }
      }
      yield* session.directInboxTransition({
        messageID,
        expected: ["preparing"],
        state: "admitted",
        capabilityLeaseDigest: preparedResult.capabilityLeaseDigest,
        pinsDigest: preparedResult.pinsDigest,
        inboxReceiptDigest: receiptDigest,
      })
      // The durable Core inbox row is now authorized by the exact one-use lease.
      yield* session.directInboxTransition({ messageID, expected: ["admitted"], state: "appended" })
      const inboxReceipt: ManagedControl.DirectMessageInboxReceiptV1 = {
        messageID,
        parentSessionID: parent.id,
        childSessionID: child.id,
        deliveryMode: "queued",
        mailboxSequence: draft.mailbox_sequence,
        receiptDigest,
      }
      const commit = yield* ManagedControl.commitDirectMessage({
        pins: preparedResult.authorityPins,
        capabilityLeaseDigest: preparedResult.capabilityLeaseDigest,
        inboxReceipt,
      }).pipe(Effect.catch(() => ManagedControl.inspectDirectMessage({ pins: preparedResult.authorityPins }).pipe(Effect.catch(() => Effect.succeed(undefined)))))
      if (!commit || commit.status !== "QUEUED") {
        yield* session.directInboxTransition({ messageID, expected: ["appended"], state: "unknown", hostReceiptDigest: commit?.receiptDigest ?? null })
        return { status: "UNKNOWN" as const, messageId: messageID, mailboxSequence: draft.mailbox_sequence, reason: "HostKernel commit is unresolved; the durable Core inbox entry is retained for reconciliation", challengeId: null, effectId: null }
      }
      yield* session.directInboxTransition({ messageID, expected: ["appended"], state: "committed", hostReceiptDigest: commit.receiptDigest })
      return { status: "QUEUED" as const, messageId: messageID, mailboxSequence: draft.mailbox_sequence, reason: null, challengeId: null, effectId: null }
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      const owner = Option.isSome(authenticated)
        ? authenticated.value.principal.kind === "server_auth"
          ? { kind: "server_auth", subject: authenticated.value.principal.subject }
          : { kind: "host_os" }
        : undefined
      const metadata: Record<string, unknown> = { ...(ctx.payload?.metadata ?? {}) }
      // This reserved field is derived from trusted middleware and always wins
      // over caller metadata; old Sessions without it remain ineligible for
      // managed Run start.
      delete metadata.horizonPrincipalOwner
      delete metadata.horizonManagedRoot
      if (owner) metadata.horizonPrincipalOwner = owner
      return yield* shareSvc.create({
        ...ctx.payload,
        metadata: Object.keys(metadata).length ? metadata : undefined,
      })
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      if (ctx.payload.metadata !== undefined) {
        const metadata = { ...ctx.payload.metadata }
        for (const key of ["horizonPrincipalOwner", "horizonManagedRoot"] as const) {
          const before = current.metadata?.[key]
          const after = metadata[key]
          if (after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
            return yield* new ForbiddenError({ message: `Session metadata field ${key} is server-owned` })
          }
          if (before !== undefined) metadata[key] = before
        }
        yield* session.setMetadata({ sessionID: ctx.params.sessionID, metadata })
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
        }),
      )
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(
        promptSvc
          .command({
            sessionID: ctx.params.sessionID,
            messageID: ctx.payload.messageID,
            model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
            command: Command.Default.INIT,
            arguments: "",
          })
          .pipe(
            Effect.mapError((error) => SessionError.mapLegacyPromptError(error, ctx.params.sessionID)),
          ),
      )
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      return yield* SessionError.mapBusy(
        runState.withExecutionOwner(
          ctx.params.sessionID,
          Effect.gen(function* () {
            yield* revertSvc.cleanup(yield* requireSession(ctx.params.sessionID))
            const messages = yield* SessionError.mapStorageNotFound(
              session.messages({ sessionID: ctx.params.sessionID }),
            )
            const defaultAgent = yield* agentSvc.defaultAgent()
            const currentAgent =
              messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

            yield* compactSvc.create({
              sessionID: ctx.params.sessionID,
              agent: currentAgent,
              model: {
                providerID: ctx.payload.providerID,
                modelID: ctx.payload.modelID,
              },
              auto: ctx.payload.auto ?? false,
            })
            yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
            return true
          }),
        ),
      ).pipe(
        Effect.catchTag("SessionSupervisorError", (error) =>
          Effect.fail(mapLegacySupervisorError(error as any, ctx.params.sessionID)),
        ),
      )
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const message = yield* SessionError.mapBusy(
        promptSvc
          .prompt({
            ...ctx.payload,
            sessionID: ctx.params.sessionID,
          })
          .pipe(
            Effect.mapError((error) => SessionError.mapLegacyPromptError(error, ctx.params.sessionID)),
          ),
      )
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.withExecutionOwner(ctx.params.sessionID, Effect.void))
      yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("prompt_async failed", { sessionID: ctx.params.sessionID, cause })
            yield* events.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(
        promptSvc.command({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
          Effect.mapError((error) => {
            if (error instanceof Session.BusyError) return error
            if (error instanceof Pty.ShellProfileUnavailableError) {
              return new ServiceUnavailableError({
                message: SHELL_UNAVAILABLE_MESSAGE,
                service: "terminal.run",
              })
            }
            if ((error as any) instanceof SessionSupervisorError) {
              if ((error as any).stage === "authorization" || (error as any).stage === "ownership") {
                return mapLegacySupervisorError(error as any, ctx.params.sessionID)
              }
              return new ServiceUnavailableError({ message: SHELL_UNAVAILABLE_MESSAGE, service: "terminal.run" })
            }
            if (error instanceof Pty.UnavailableError) {
              return new ServiceUnavailableError({ message: error.message, service: "terminal.run" })
            }
            if (NamedError.Unknown.isInstance(error) && error.data.message.includes("Command not found")) {
              return new ApiNotFoundError({
                name: "NotFoundError",
                data: { message: error.data.message },
              })
            }
            return new HttpApiError.BadRequest({})
          }),
        ),
      )
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
        Effect.mapError((error) => {
          if (
            (error as any) instanceof SessionSupervisorError &&
            ((error as any).stage === "authorization" || (error as any).stage === "ownership")
          )
            return mapLegacySupervisorError(error as any, ctx.params.sessionID)
          return new ServiceUnavailableError({ message: SHELL_UNAVAILABLE_MESSAGE, service: "terminal.run" })
        }),
      )
    })

    // Context Epoch operations: each drops/prunes projected history and starts
    // a fresh epoch (new Baseline System Context + Context Snapshot) so the next
    // provider turn renders a new baseline. These mirror /compact but do not
    // require a model call — they are ledger operations on the durable store.
    const contextOp = Effect.fnUntraced(function* (
      operation: "clear" | "trim" | "prune",
      sessionID: SessionID,
      keepMessages?: number,
    ) {
      yield* requireSession(sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(sessionID))
      const run = () => {
        if (operation === "clear") return SessionContextOps.clear(database.db, events, sessionID)
        if (operation === "trim") {
          return SessionContextOps.trim(database.db, events, sessionID, {
            ...(keepMessages === undefined ? {} : { keepMessages }),
          })
        }
        return SessionContextOps.prune(database.db, events, sessionID)
      }
      return yield* run().pipe(
        Effect.mapError((error: unknown) =>
          error instanceof SessionSupervisorError
            ? mapLegacySupervisorError(error, sessionID)
            : new ServiceUnavailableError({
                message: error instanceof Error ? error.message : String(error),
                service: "session-context",
              }),
        ),
      )
    })

    const contextClear = Effect.fn("SessionHttpApi.contextClear")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      return yield* contextOp("clear", ctx.params.sessionID)
    })

    const contextTrim = Effect.fn("SessionHttpApi.contextTrim")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ContextTrimPayload.Type
    }) {
      return yield* contextOp("trim", ctx.params.sessionID, ctx.payload.keepMessages)
    })

    const contextPrune = Effect.fn("SessionHttpApi.contextPrune")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      return yield* contextOp("prune", ctx.params.sessionID)
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }).pipe(
        Effect.mapError((error) => mapLegacyRevertError(error, ctx.params.sessionID)),
      )
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* revertSvc.unrevert({ sessionID: ctx.params.sessionID }).pipe(
        Effect.mapError((error) => mapLegacyRevertError(error, ctx.params.sessionID)),
      )
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })
    const guardApproval = Effect.fn("SessionHttpApi.guardApproval")(function* (ctx: {
      params: { approvalID: string }
      payload: typeof GuardApprovalPayload.Type
    }) {
      const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (Option.isNone(principal))
        return yield* new ForbiddenError({ message: "Guard approval requires a trusted principal" })
      if (ctx.payload.decision === "grant_session" || ctx.payload.decision === "grant_workspace") {
        // The PTY Guard reply boundary only accepts allow_once|deny; anything
        // else previously collapsed into a silent deny. Grant decisions fail
        // closed here instead — they require the direct-session grant endpoint.
        return yield* new ServiceUnavailableError({
          message: "Direct-session grant decisions are unavailable at this boundary",
          service: "guard-approval",
        })
      }
      // Bound after the grant guard: narrowing does not survive the callback
      // below, and replyGuardApproval only accepts allow_once|deny.
      const decision = ctx.payload.decision
      yield* withLocationPty(
        Pty.Service.use((service) =>
          service.replyGuardApproval({ approvalID: ctx.params.approvalID, decision }),
        ),
      ).pipe(
        Effect.provideService(TrustedPrincipalContext, principal.value),
        Effect.catchTag("SessionSupervisorError", (error) => Effect.fail(guardApprovalFailure(error))),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload)
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("subagents", subagents)
      .handle("subagentWait", subagentWait)
      .handle("subagentMessage", (ctx) =>
        subagentMessage(ctx).pipe(
          Effect.mapError((error) => {
            if ((error as any) instanceof SessionSupervisorError) {
              return new ServiceUnavailableError({ message: (error as any).reason, service: "host-kernel" })
            }
            if (error instanceof ManagedControl.ManagedControlError) {
              if (error.code === "managed_conflict") return new ConflictError({ message: (error as any).reason })
              if (error.code === "authorization") return new ForbiddenError({ message: (error as any).reason })
              if (error.code === "managed_not_found") {
                return new ApiNotFoundError({ name: "NotFoundError", data: { message: (error as any).reason } })
              }
              return new ServiceUnavailableError({ message: (error as any).reason, service: "managed-control" })
            }
            return new ServiceUnavailableError({
              message: error instanceof Error ? error.message : String(error),
              service: "session",
            })
          }),
        ),
      )
      .handle("todo", todo)
      .handle("questions", questions as any)
      .handle("questionReply", questionReply as any)
      .handle("questionReject", questionReject as any)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("contextClear", contextClear)
      .handle("contextTrim", contextTrim)
      .handle("contextPrune", contextPrune)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("guardApproval", guardApproval)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
