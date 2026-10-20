export * as Pty from "./pty"

import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Fiber, Layer, Schema, Scope, Stream, Types } from "effect"
import { Pty } from "@opencode-ai/schema/pty"
import { Config } from "./config"
import { EventV2 } from "./event"
import { Location } from "./location"
import { PtyID } from "./pty/schema"
import { Shell } from "./shell"
import {
  SessionSupervisor,
  SessionSupervisorError,
  directAttemptScopeToWire,
  wireUnixMs,
  type Cursor,
  type EffectAdmission,
  type EffectLease,
  type DirectAttemptScopeV1,
  type GuardApprovalDecision,
  type GuardedToolCall,
  type HostKernelEvent,
  isHostKernelResnapshot,
  type HostKernelResnapshot,
  type HostKernelStreamMessage,
} from "./session/supervisor"
import { TrustedPrincipalContext } from "./trusted-principal"

const STATUS_REPLAY_LIMIT = 2 * 1024 * 1024
const SUBSCRIBER_LIMIT = 2 * 1024 * 1024
const OUTPUT_FRAME_LIMIT = 64 * 1024
// `terminal.v1/status` returns at most one 64-KiB page per call; the replay ring itself is
// 2 MiB, so a full catch-up is a bounded sequence of pages.
const SNAPSHOT_PAGE_BYTES = OUTPUT_FRAME_LIMIT
const SNAPSHOT_MAX_CHUNKS = 4096
const SNAPSHOT_MAX_ATTEMPTS = STATUS_REPLAY_LIMIT / SNAPSHOT_PAGE_BYTES + 8
const INPUT_FRAME_LIMIT = 16 * 1024
const EXITED_LIMIT = 25
const BASE_DIGEST = `blake3:${"0".repeat(64)}`
const textEncoder = new TextEncoder()

export const Info = Pty.Info
export type Info = Types.DeepMutable<typeof Info.Type>

export const CreateInput = Pty.CreateInput
export type CreateInput = Types.DeepMutable<typeof CreateInput.Type>

export const UpdateInput = Pty.UpdateInput
export type UpdateInput = Types.DeepMutable<typeof UpdateInput.Type>

export const Event = Pty.Event

export type TerminalStreamEvent = {
  readonly sequence: number
  readonly byteCursor: number
  readonly kind: string
  readonly payload: unknown
}

export type TerminalGap = {
  readonly firstSequence: number
  readonly lastSequenceExclusive: number
  readonly firstByteCursor: number
  readonly lastByteCursorExclusive: number
}

export type TerminalProtocol = "legacy" | "horizon.terminal.v1"

export type CreateServiceInput = CreateInput & { readonly sessionID?: string }

export type TicketBinding = {
  readonly terminalID: PtyID
  readonly origin: string
  readonly protocol: TerminalProtocol
}

export type Ticket = {
  readonly ticketID: string
  readonly ticket: string
  readonly ownerEpoch: number
  readonly expiresAtUnixMs: number
}

export type TicketConsumption = {
  readonly ticketID: string
  readonly attachmentID: string
  readonly terminalID: PtyID
  readonly generation: number
  readonly ownerEpoch: number
}
export type RegisteredShellProfile = {
  readonly profile: Shell.Profile
  readonly shellProfileID: string
}

export type TerminalRunInput = {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
}

export type TerminalRunResult = {
  readonly status: "exited" | "timed_out" | "cancelled" | "unknown"
  readonly exitCode?: number
  readonly preview: string
  readonly previewTruncated: boolean
  readonly artifactTruncated: boolean
  readonly artifactFidelity: "FULL" | "SAMPLE" | "FAILED"
  readonly artifactRef: string
  readonly receiptRef: string
}

export type TerminalToolBatchInput = {
  readonly sessionID: string
  readonly locationRef: typeof Location.Ref.Type
  readonly batchID: string
  readonly turnContextDigest: string
  readonly calls: ReadonlyArray<GuardedToolCall>
  readonly directAttempt?: DirectAttemptScopeV1
  /** Supplied by the server-private shell/plugin environment provider, never by model tool arguments. */
  readonly resolvedEnvironment?: Readonly<Record<string, string>>
}
export type AttachInput = {
  // Absolute byte cursor to replay from. -1 tails from the current end; omitted requests retained host output.
  readonly cursor?: number
  readonly origin: string
  readonly protocol: TerminalProtocol
  readonly attachmentID?: string
  readonly onData: (chunk: Uint8Array, meta: { sequence: number; byteCursor: number }) => void
  readonly onGap?: (gap: TerminalGap) => void
  readonly onState?: (event: TerminalStreamEvent) => void
  readonly onError?: (event: TerminalStreamEvent) => void
  readonly onEvent?: (event: TerminalStreamEvent) => void
  readonly onEnd: (event: { exitCode?: number; unknown?: boolean }) => void
}

type Subscriber = {
  readonly onData: AttachInput["onData"]
  readonly onGap?: AttachInput["onGap"]
  readonly onState?: AttachInput["onState"]
  readonly onError?: AttachInput["onError"]
  readonly onEvent?: AttachInput["onEvent"]
  readonly onEnd: AttachInput["onEnd"]
  active: boolean
  detached: boolean
  pending: TerminalStreamEvent[]
  pendingBytes: number
  overflow?: TerminalGap
  end?: { exitCode?: number; unknown?: boolean }
}

type Channel = {
  readonly attachmentID: string
  sequence: number
  failed: boolean
}

type Active = {
  info: Info
  generation: number
  effectID: string
  grantID: string
  locationID: string
  sessionID?: string
  channel: Channel
  byteCursor: number
  nextSequence: number
  subscribers: Map<object, Subscriber>
  attachments: Set<string>
  stopStream?: () => void
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Pty.NotFoundError", {
  ptyID: PtyID,
}) {}

export class ExitedError extends Schema.TaggedErrorClass<ExitedError>()("Pty.ExitedError", {
  ptyID: PtyID,
}) {}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("Pty.InvalidInputError", {
  reason: Schema.String,
}) {}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("Pty.UnavailableError", {
  ptyID: PtyID,
}) {}

export class ShellProfileUnavailableError extends Schema.TaggedErrorClass<ShellProfileUnavailableError>()(
  "Pty.ShellProfileUnavailableError",
  { profileKey: Schema.optional(Schema.String) },
) {}

export interface Attachment {
  readonly attachmentID: string
  readonly replay: readonly TerminalStreamEvent[]
  readonly replayGap?: TerminalGap
  readonly cursor: number
  readonly write: (data: string | Uint8Array) => Effect.Effect<void, InvalidInputError | ExitedError | UnavailableError | SessionSupervisorError>
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, InvalidInputError | ExitedError | UnavailableError | SessionSupervisorError>
  readonly activate: () => void
  readonly detach: () => void
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateServiceInput) => Effect.Effect<
    Info,
    InvalidInputError | ShellProfileUnavailableError | SessionSupervisorError | UnavailableError,
    TrustedPrincipalContext | Scope.Scope
  >
  readonly update: (
    id: PtyID,
    input: UpdateInput,
  ) => Effect.Effect<Info, NotFoundError | InvalidInputError | ExitedError | SessionSupervisorError | UnavailableError>
  readonly remove: (id: PtyID) => Effect.Effect<void, NotFoundError | SessionSupervisorError>
  readonly write: (
    id: PtyID,
    data: string | Uint8Array,
  ) => Effect.Effect<void, NotFoundError | InvalidInputError | ExitedError | SessionSupervisorError | UnavailableError>
  readonly acquireTicket: (
    input: TicketBinding,
  ) => Effect.Effect<Ticket, NotFoundError | InvalidInputError | UnavailableError | SessionSupervisorError, TrustedPrincipalContext>
  readonly consumeTicket: (
    input: TicketBinding & { readonly ticket: string },
  ) => Effect.Effect<TicketConsumption, NotFoundError | InvalidInputError | UnavailableError | SessionSupervisorError, TrustedPrincipalContext>
  readonly revokeTicket: (input: {
    readonly terminalID: PtyID
    readonly ticketID: string
    readonly attachmentID?: string
  }) => Effect.Effect<void, NotFoundError | InvalidInputError | UnavailableError | SessionSupervisorError, TrustedPrincipalContext>
  readonly replyGuardApproval: (
    input: { readonly approvalID: string; readonly decision: GuardApprovalDecision },
  ) => Effect.Effect<void, SessionSupervisorError, TrustedPrincipalContext>
  readonly attach: (
    id: PtyID,
    input: AttachInput,
  ) => Effect.Effect<Attachment, NotFoundError | InvalidInputError | ExitedError | UnavailableError | SessionSupervisorError, TrustedPrincipalContext>
  readonly prepareToolBatch: (
    input: TerminalToolBatchInput,
  ) => Effect.Effect<
    { readonly admission: EffectAdmission; readonly calls: ReadonlyArray<GuardedToolCall> },
    InvalidInputError | ShellProfileUnavailableError | SessionSupervisorError,
    TrustedPrincipalContext
  >
  readonly runUser: (
    input: TerminalRunInput & { readonly sessionID?: string; readonly locationRef: typeof Location.Ref.Type },
  ) => Effect.Effect<
    TerminalRunResult,
    InvalidInputError | ShellProfileUnavailableError | SessionSupervisorError,
    TrustedPrincipalContext
  >
  readonly runTool: (
    input: {
      readonly sessionID: string
      readonly locationRef: typeof Location.Ref.Type
      readonly lease: EffectLease
      readonly call: GuardedToolCall
    },
  ) => Effect.Effect<
    TerminalRunResult,
    InvalidInputError | ShellProfileUnavailableError | SessionSupervisorError,
    TrustedPrincipalContext
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Pty") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const supervisor = yield* SessionSupervisor.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const sessions = new Map<PtyID, Active>()
    const exitOrder: PtyID[] = []
    const locationRef = {
      directory: location.directory,
      ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
    }
    const registerShellProfiles = Effect.fn("Pty.registerShellProfiles")(function* (selectedShell?: string) {
      const entries = yield* config.entries()
      const profiles = yield* Effect.tryPromise({
        try: () => Shell.discoverProfiles(),
        catch: () => new ShellProfileUnavailableError({}),
      })
      const configuredShell = Config.latest(entries, "shell")
      const defaultProfile = Shell.resolveProfile(configuredShell, profiles)
      const selectedProfile = selectedShell === undefined ? defaultProfile : Shell.resolveProfile(selectedShell, profiles)
      if (!defaultProfile || !selectedProfile) {
        return yield* new ShellProfileUnavailableError({
          ...(selectedShell ?? configuredShell ? { profileKey: selectedShell ?? configuredShell } : {}),
        })
      }
      const response = yield* supervisor.requestHostKernel("terminal.v1", "register_shell_profiles", {
        defaultProfileKey: defaultProfile.profileKey,
        profiles,
      })
      if (
        response.defaultProfileKey !== defaultProfile.profileKey ||
        typeof response.defaultShellProfileID !== "string" ||
        !Array.isArray(response.profiles)
      ) {
        return yield* new ShellProfileUnavailableError({ profileKey: defaultProfile.profileKey })
      }
      const registeredProfiles = response.profiles
      const registered = registeredProfiles.find(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "profileKey" in value &&
          value.profileKey === selectedProfile.profileKey,
      )
      const defaultRegistered = registeredProfiles.find(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "profileKey" in value &&
          value.profileKey === defaultProfile.profileKey,
      )
      if (typeof registered !== "object" || registered === null || typeof defaultRegistered !== "object" || defaultRegistered === null) {
        return yield* new ShellProfileUnavailableError({ profileKey: selectedProfile.profileKey })
      }
      const shellProfileID = "shellProfileID" in registered ? registered.shellProfileID : undefined
      const profileDigest = "profileDigest" in registered ? registered.profileDigest : undefined
      const generation = "generation" in registered ? registered.generation : undefined
      const availability = "availability" in registered ? registered.availability : undefined
      const defaultShellProfileID =
        "shellProfileID" in defaultRegistered ? defaultRegistered.shellProfileID : undefined
      if (
        typeof shellProfileID !== "string" ||
        shellProfileID.length === 0 ||
        shellProfileID.length > 128 ||
        typeof profileDigest !== "string" ||
        !/^blake3:[0-9a-f]{64}$/.test(profileDigest) ||
        !Number.isSafeInteger(generation) ||
        (generation as number) < 1 ||
        availability !== "available" ||
        typeof defaultShellProfileID !== "string" ||
        defaultShellProfileID !== response.defaultShellProfileID
      ) {
        return yield* new ShellProfileUnavailableError({ profileKey: selectedProfile.profileKey })
      }
      return { profile: selectedProfile, shellProfileID }
    })

    const markUnavailable = (session: Active) => {
      if (sessions.get(session.info.id) !== session) return
      sessions.delete(session.info.id)
      notifyEnd(session, { unknown: true })
    }

    function notifyEnd(session: Active, result: { exitCode?: number; unknown?: boolean }) {
      for (const subscriber of session.subscribers.values()) {
        if (!subscriber.active) {
          subscriber.end = result
          continue
        }
        try {
          subscriber.onEnd(result)
        } catch {}
      }
      session.subscribers.clear()
    }

    function stop(session: Active) {
      session.stopStream?.()
      session.stopStream = undefined
    }

    function recordGap(session: Active, gap: TerminalGap) {
      const event: TerminalStreamEvent = {
        sequence: gap.lastSequenceExclusive,
        byteCursor: gap.lastByteCursorExclusive,
        kind: "gap",
        payload: gap,
      }
      for (const subscriber of session.subscribers.values()) dispatch(subscriber, event)
    }

    function dispatch(subscriber: Subscriber, event: TerminalStreamEvent) {
      try {
        subscriber.onEvent?.(event)
        if (event.kind === "output") {
          subscriber.onData(event.payload as Uint8Array, { sequence: event.sequence, byteCursor: event.byteCursor })
        } else if (event.kind === "gap") {
          subscriber.onGap?.(event.payload as TerminalGap)
        } else if (event.kind === "state") {
          subscriber.onState?.(event)
        } else if (event.kind === "error") {
          subscriber.onError?.(event)
        } else if (event.kind === "exit") {
          // The session-level exit handler reports the event exactly once.
        }
      } catch {
        subscriber.detached = true
      }
    }


    function deliver(session: Active, event: TerminalStreamEvent) {
      for (const [token, subscriber] of session.subscribers) {
        if (subscriber.detached) {
          session.subscribers.delete(token)
          continue
        }
        if (!subscriber.active) {
          const size = event.kind === "output" ? (event.payload as Uint8Array).byteLength : 0
          if (subscriber.pendingBytes + size > SUBSCRIBER_LIMIT) {
            const first = subscriber.pending[0]
            subscriber.overflow = {
              firstSequence: first?.sequence ?? event.sequence,
              lastSequenceExclusive: event.sequence + 1,
              firstByteCursor: first?.byteCursor ?? event.byteCursor,
              lastByteCursorExclusive: event.byteCursor,
            }
            subscriber.pending.length = 0
            subscriber.pendingBytes = 0
          } else {
            subscriber.pending.push(event)
            subscriber.pendingBytes += size
          }
          continue
        }
        dispatch(subscriber, event)
        if (subscriber.detached) session.subscribers.delete(token)
      }
    }

    function endSession(session: Active, exitCode?: number) {
      if (session.info.status === "exited") return
      session.info.status = "exited"
      if (exitCode !== undefined && Number.isSafeInteger(exitCode) && exitCode >= 0) {
        session.info.exitCode = exitCode
      }
      notifyEnd(session, session.info.exitCode === undefined ? {} : { exitCode: session.info.exitCode })
      exitOrder.push(session.info.id)
      runFork(
        Effect.gen(function* () {
          if (session.info.exitCode !== undefined) {
            yield* events.publish(Event.Exited, { id: session.info.id, exitCode: session.info.exitCode })
          }
          while (exitOrder.length > EXITED_LIMIT) {
            const oldest = exitOrder[0]
            if (!oldest) break
            yield* removeSession(oldest)
          }
        }),
      )
    }

    const applyStreamEvent = (session: Active, event: TerminalStreamEvent) => {
      if (event.sequence < session.nextSequence) return
      if (event.sequence > session.nextSequence && event.kind !== "gap") {
        recordGap(session, {
          firstSequence: session.nextSequence,
          lastSequenceExclusive: event.sequence,
          firstByteCursor: session.byteCursor,
          lastByteCursorExclusive: event.byteCursor,
        })
      }
      session.nextSequence = event.sequence + 1
      const payload = event.payload
      if (event.kind === "output") {
        const bytes = payload instanceof Uint8Array ? payload : payload instanceof ArrayBuffer ? new Uint8Array(payload) : undefined
        if (!bytes || bytes.byteLength > OUTPUT_FRAME_LIMIT || event.byteCursor < bytes.byteLength) {
          markUnavailable(session)
          return
        }
        if (event.byteCursor < session.byteCursor) return
        session.byteCursor = event.byteCursor
        deliver(session, { sequence: event.sequence, byteCursor: event.byteCursor, kind: event.kind, payload: bytes })
        return
      }
      if (event.kind === "gap") {
        if (typeof payload !== "object" || payload === null) {
          markUnavailable(session)
          return
        }
        const gap = payload as TerminalGap
        if (
          !Number.isSafeInteger(gap.firstSequence) ||
          !Number.isSafeInteger(gap.lastSequenceExclusive) ||
          !Number.isSafeInteger(gap.firstByteCursor) ||
          !Number.isSafeInteger(gap.lastByteCursorExclusive)
        ) {
          markUnavailable(session)
          return
        }
        session.byteCursor = Math.max(session.byteCursor, gap.lastByteCursorExclusive)
      }
      if (event.kind === "exit") {
        const exitCode = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).exitCode : undefined
        deliver(session, { sequence: event.sequence, byteCursor: event.byteCursor, kind: event.kind, payload })
        endSession(session, typeof exitCode === "number" ? exitCode : undefined)
        return
      }
      if (event.kind === "error") {
        const error = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).code : undefined
        deliver(session, { sequence: event.sequence, byteCursor: event.byteCursor, kind: event.kind, payload })
        if (["OWNER_LOST", "UNKNOWN", "UNAVAILABLE", "STALE_GENERATION"].includes(String(error))) {
          markUnavailable(session)
          return
        }
        return
      }
      deliver(session, { sequence: event.sequence, byteCursor: event.byteCursor, kind: event.kind, payload })
    }

    const consumeEvent = (session: Active, message: HostKernelStreamMessage) =>
      Effect.sync(() => {
        if (sessions.get(session.info.id) !== session || session.info.status !== "running") return
        if (message.kind !== "event") return
        if (message.generation !== session.generation || message.terminalID !== session.info.id) {
          markUnavailable(session)
          return
        }
        applyStreamEvent(session, message)
      })

    const parseSnapshotGap = (value: unknown): TerminalGap | undefined => {
      const gap = asRecord(value)
      const firstSequence = finiteInt(gap.firstSequence)
      const lastSequenceExclusive = finiteInt(gap.lastSequenceExclusive)
      const firstByteCursor = finiteInt(gap.firstByteCursor)
      const lastByteCursorExclusive = finiteInt(gap.lastByteCursorExclusive)
      if (
        firstSequence === undefined ||
        lastSequenceExclusive === undefined ||
        firstByteCursor === undefined ||
        lastByteCursorExclusive === undefined ||
        lastSequenceExclusive < firstSequence ||
        lastByteCursorExclusive < firstByteCursor
      ) {
        return undefined
      }
      return { firstSequence, lastSequenceExclusive, firstByteCursor, lastByteCursorExclusive }
    }

    const parseSnapshotChunks = (value: unknown, afterSequence: number, afterByteCursor: number) => {
      if (!Array.isArray(value) || value.length > SNAPSHOT_MAX_CHUNKS) return undefined
      let priorSequence = afterSequence
      let priorByteCursor = afterByteCursor
      const events: TerminalStreamEvent[] = []
      for (const raw of value) {
        const chunk = asRecord(raw)
        const sequence = finiteInt(chunk.sequence)
        const byteCursor = finiteInt(chunk.byteCursor)
        const kind = chunk.kind
        if (
          sequence === undefined ||
          sequence < 1 ||
          sequence <= priorSequence ||
          byteCursor === undefined ||
          byteCursor < priorByteCursor ||
          typeof kind !== "string"
        ) {
          return undefined
        }
        priorSequence = sequence
        priorByteCursor = byteCursor
        let payload = chunk.payload
        if (kind === "output") {
          if (payload instanceof ArrayBuffer) payload = new Uint8Array(payload)
          if (!(payload instanceof Uint8Array) || payload.byteLength > OUTPUT_FRAME_LIMIT || byteCursor < payload.byteLength) {
            return undefined
          }
        }
        events.push({ sequence, byteCursor, kind, payload })
      }
      return events
    }

    // `terminal.v1/status` serves one bounded page per call, so a catch-up is an explicit
    // sequence of pages rather than a single assumed-complete response.
    const readSnapshot = (
      session: Active,
      ownerEpoch: number,
      afterSequence: number,
      afterByteCursor: number,
      stopAtByteCursor?: number,
    ) =>
      Effect.gen(function* () {
        let sequence = afterSequence
        let byteCursor = afterByteCursor
        let bytes = 0
        let status: Record<string, unknown> | undefined
        let gap: TerminalGap | undefined
        const chunks: TerminalStreamEvent[] = []
        for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt++) {
          const page = yield* supervisor.requestHostKernel("terminal.v1", "status", {
            terminalID: session.info.id,
            generation: session.generation,
            afterSequence: sequence,
            afterByteCursor: byteCursor,
            maxBytes: SNAPSHOT_PAGE_BYTES,
          })
          if (
            page.terminalID !== session.info.id ||
            page.generation !== session.generation ||
            page.ownerEpoch !== ownerEpoch
          ) {
            return yield* new UnavailableError({ ptyID: session.info.id })
          }
          status ??= page
          const pageGap = page.gap === undefined ? undefined : parseSnapshotGap(page.gap)
          if (page.gap !== undefined && pageGap === undefined) {
            return yield* new UnavailableError({ ptyID: session.info.id })
          }
          gap ??= pageGap
          const parsed = parseSnapshotChunks(page.replay, sequence, byteCursor)
          if (parsed === undefined) return yield* new UnavailableError({ ptyID: session.info.id })
          for (const chunk of parsed) {
            chunks.push(chunk)
            if (chunk.kind === "output") bytes += (chunk.payload as Uint8Array).byteLength
          }
          if (parsed.length === 0) break
          sequence = parsed[parsed.length - 1]!.sequence
          byteCursor = parsed[parsed.length - 1]!.byteCursor
          if (stopAtByteCursor !== undefined && byteCursor >= stopAtByteCursor) break
          if (bytes >= STATUS_REPLAY_LIMIT || chunks.length >= SNAPSHOT_MAX_CHUNKS) break
        }
        return { status: status!, gap, chunks, byteCursor }
      })

    const recoverResnapshot = (session: Active, message: HostKernelResnapshot) =>
      Effect.gen(function* () {
        if (sessions.get(session.info.id) !== session || session.info.status !== "running") return
        const latestSequence = Number(message.latest.seq)
        if (
          message.requested.ownerKind !== "terminal" ||
          message.requested.ownerId !== session.info.id ||
          message.latest.ownerKind !== "terminal" ||
          message.latest.ownerId !== session.info.id ||
          !Number.isSafeInteger(latestSequence) ||
          latestSequence < 0
        ) {
          markUnavailable(session)
          return
        }
        const ownerEpoch = yield* supervisor.hostOwnerEpoch()
        // Replay only needs to close the window up to `latest`; the resumed subscription
        // continues after it, so anything newer than `latest` arrives as a live event.
        for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS && session.nextSequence <= latestSequence; attempt++) {
          const snapshot = yield* readSnapshot(
            session,
            ownerEpoch,
            session.nextSequence - 1,
            session.byteCursor,
            Number.POSITIVE_INFINITY,
          )
          if (snapshot.status.status !== "running") {
            applySnapshotEnd(session, snapshot.status, snapshot.chunks)
            return
          }
          if (snapshot.gap !== undefined) {
            if (snapshot.gap.lastSequenceExclusive < session.nextSequence) {
              markUnavailable(session)
              return
            }
            recordGap(session, snapshot.gap)
            session.nextSequence = Math.max(session.nextSequence, snapshot.gap.lastSequenceExclusive)
            session.byteCursor = Math.max(session.byteCursor, snapshot.gap.lastByteCursorExclusive)
          }
          for (const chunk of snapshot.chunks) applyStreamEvent(session, chunk)
          if (sessions.get(session.info.id) !== session) return
        }
        if (session.nextSequence <= latestSequence) {
          markUnavailable(session)
        }
      }).pipe(Effect.catchCause(() => Effect.sync(() => markUnavailable(session))))

    function applySnapshotEnd(session: Active, status: Record<string, unknown>, chunks: TerminalStreamEvent[]) {
      for (const chunk of chunks) applyStreamEvent(session, chunk)
      if (status.status === "exited") {
        const exitCode = finiteInt(status.exitCode)
        deliver(session, {
          sequence: session.nextSequence,
          byteCursor: session.byteCursor,
          kind: "exit",
          payload: exitCode === undefined ? {} : { exitCode },
        })
        endSession(session, exitCode)
        return
      }
      if (status.status === "cancelled" || status.status === "timed_out") {
        endSession(session)
        return
      }
      markUnavailable(session)
    }

    const channelFor = (session: Active, attachmentID = `att_${randomUUID().replaceAll("-", "")}`) => {
      const channel: Channel = { attachmentID, sequence: 0, failed: false }
      const submit = (operation: "input" | "resize", value: Uint8Array | { cols: number; rows: number }) =>
        Effect.gen(function* () {
          if (channel.failed) return yield* Effect.fail(new UnavailableError({ ptyID: session.info.id }))
          if (session.info.status !== "running") return yield* Effect.fail(new ExitedError({ ptyID: session.info.id }))
          if (operation === "input" && (value as Uint8Array).byteLength > INPUT_FRAME_LIMIT) {
            return yield* Effect.fail(new InvalidInputError({ reason: "Terminal input exceeds 16 KiB" }))
          }
          if (operation === "resize") {
            const size = value as { cols: number; rows: number }
            if (!Number.isInteger(size.cols) || size.cols < 1 || size.cols > 500 || !Number.isInteger(size.rows) || size.rows < 1 || size.rows > 300) {
              return yield* Effect.fail(new InvalidInputError({ reason: "Terminal size is outside supported bounds" }))
            }
          }
          const body = {
            terminalID: session.info.id,
            generation: session.generation,
            grantID: session.grantID,
            attachmentID: channel.attachmentID,
            sequence: channel.sequence,
            ...(operation === "input" ? { bytes: value } : value),
          }
          yield* supervisor.requestHostKernel("terminal.v1", operation, body).pipe(
            Effect.tapError(() => Effect.sync(() => (channel.failed = true))),
          )
          channel.sequence += 1
        })
      return {
        channel,
        write: (data: string | Uint8Array) => {
          const bytes = typeof data === "string" ? textEncoder.encode(data) : data
          return submit("input", bytes)
        },
        resize: (cols: number, rows: number) => submit("resize", { cols, rows }),
      }
    }

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const session of sessions.values()) {
          stop(session)
          if (session.info.status === "running") {
            yield* supervisor
              .requestHostKernel("terminal.v1", "cancel", {
                effectID: session.effectID,
                terminalID: session.info.id,
                generation: session.generation,
                reason: "owner_shutdown",
              })
              .pipe(Effect.ignore)
          }
          notifyEnd(session, { unknown: true })
        }
        sessions.clear()
        exitOrder.length = 0
      }),
    )

    const requireSession = Effect.fn("Pty.requireSession")(function* (id: PtyID) {
      const session = sessions.get(id)
      if (!session) return yield* new NotFoundError({ ptyID: id })
      return session
    })

    const removeSession = Effect.fnUntraced(function* (id: PtyID) {
      const session = sessions.get(id)
      if (!session) return
      sessions.delete(id)
      const index = exitOrder.indexOf(id)
      if (index !== -1) exitOrder.splice(index, 1)
      stop(session)
      yield* Effect.logInfo("removing session", { id })
      notifyEnd(session, {})
      yield* events.publish(Event.Deleted, { id: session.info.id })
    })

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      const session = yield* requireSession(id)
      if (session.info.status === "running") {
        yield* supervisor.requestHostKernel("terminal.v1", "cancel", {
          effectID: session.effectID,
          terminalID: id,
          generation: session.generation,
          reason: "user_removed",
        })
      }
      yield* removeSession(id)
    })

    const list = Effect.fn("Pty.list")(function* () {
      return Array.from(sessions.values()).map((session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      return (yield* requireSession(id)).info
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateServiceInput) {
      const id = PtyID.ascending()
      const registeredProfile = yield* registerShellProfiles(input.command)
      const { profile, shellProfileID } = registeredProfile
      const command = profile.executable
      const args = profile.login ? [...(input.args ?? []), "-l"] : [...(input.args ?? [])]
      const cwd = input.cwd || location.directory
      const env = {
        ...input.env,
        TERM: "xterm-256color",
        OPENCODE_TERMINAL: "1",
        ...(process.platform === "win32"
          ? { LC_ALL: "C.UTF-8", LC_CTYPE: "C.UTF-8", LANG: "C.UTF-8" }
          : {}),
      } as Record<string, string>
      const cols = 80
      const rows = 24
      const validated = validateStartInput({ command, args, cwd, env, cols, rows, shellProfileID })
      const admission = yield* supervisor.prepareUserEffect({
        locationRef,
        sessionID: input.sessionID,
        capabilityID: "terminal.start",
        arguments: { terminalID: id, ...validated },
      })
      const response = yield* supervisor.requestHostKernel("terminal.v1", "start", {
        effectID: admission.effectID,
        capabilityLeaseDigest: admission.capabilityLeaseDigest,
        locationID: admission.locationID,
        terminalID: id,
        shellProfileID,
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        command,
        args,
        cwd,
        env,
        cols,
        rows,
      })
      if (response.status !== "running" || response.terminalID !== id) {
        return yield* new UnavailableError({ ptyID: id })
      }
      const generation = finiteInt(response.generation)
      const grantID = typeof response.grantID === "string" ? response.grantID : undefined
      const pid = finiteInt(response.pid)
      if (!generation || !grantID || pid === undefined) return yield* new UnavailableError({ ptyID: id })
      const info: Info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "running",
        pid,
      }
      const session: Active = {
        info,
        generation,
        effectID: admission.effectID,
        grantID,
        locationID: admission.locationID,
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        channel: { attachmentID: `owner_${randomUUID().replaceAll("-", "")}`, sequence: 0, failed: false },
        byteCursor: finiteInt(response.byteCursor) ?? 0,
        nextSequence: 1,
        subscribers: new Map(),
        attachments: new Set(),
      }
      sessions.set(id, session)
      const initialCursor: Cursor = {
        ownerKind: "terminal",
        ownerId: id,
        seq: "0",
        eventDigest: BASE_DIGEST,
      }
      const stream = supervisor.subscribeHostKernelEvents({
        terminalID: id,
        generation,
        after: initialCursor,
        capacity: 64,
      })
      const fiber = yield* stream.pipe(
        Stream.runForEach((message) =>
          isHostKernelResnapshot(message) ? recoverResnapshot(session, message) : consumeEvent(session, message),
        ),
        Effect.catchCause(() => Effect.sync(() => markUnavailable(session))),
        Effect.forkScoped({ startImmediately: true }),
      )
      session.stopStream = () => {
        runFork(Fiber.interrupt(fiber))
      }
      yield* events.publish(Event.Created, { info })
      yield* Effect.logInfo("created session", { id, cmd: command, args, cwd })
      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const session = yield* requireSession(id)
      if (input.title) session.info.title = input.title
      if (input.size && session.info.status === "running") {
        const channel = channelFor(session, session.channel.attachmentID)
        session.channel.sequence = channel.channel.sequence
        yield* channel.resize(input.size.cols, input.size.rows)
        session.channel.sequence += 1
      }
      yield* events.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string | Uint8Array) {
      const session = yield* requireSession(id)
      const channel = channelFor(session, session.channel.attachmentID)
      session.channel.sequence = channel.channel.sequence
      yield* channel.write(data)
      session.channel.sequence += 1
    })

    const attach = Effect.fn("Pty.attach")(function* (id: PtyID, input: AttachInput) {
      const session = yield* requireSession(id)
      if (session.info.status !== "running") return yield* new ExitedError({ ptyID: id })
      yield* TrustedPrincipalContext
      yield* validateOrigin(input.origin)
      let attachmentID: string
      if (input.protocol === "horizon.terminal.v1") {
        if (!input.attachmentID || !session.attachments.delete(input.attachmentID)) {
          return yield* new UnavailableError({ ptyID: id })
        }
        attachmentID = input.attachmentID
      } else {
        if (input.attachmentID !== undefined) return yield* new InvalidInputError({ reason: "Legacy attachment cannot use a V2 ticket" })
        attachmentID = `att_${randomUUID().replaceAll("-", "")}`
      }
      if (input.cursor !== undefined && input.cursor !== -1 && (!Number.isSafeInteger(input.cursor) || input.cursor < 0)) {
        return yield* new InvalidInputError({ reason: "Terminal replay cursor is invalid" })
      }
      const afterByteCursor = input.cursor === -1 ? 0 : (input.cursor ?? 0)
      const ownerEpoch = yield* supervisor.hostOwnerEpoch()
      // Register the subscriber before querying the host so output produced while the snapshot is
      // read is buffered for this attachment instead of being dropped between the two steps.
      const token = {}
      const subscriber: Subscriber = {
        onData: input.onData,
        onGap: input.onGap,
        onState: input.onState,
        onError: input.onError,
        onEvent: input.onEvent,
        onEnd: input.onEnd,
        active: false,
        detached: false,
        pending: [],
        pendingBytes: 0,
      }
      session.subscribers.set(token, subscriber)
      const snapshot = yield* readSnapshot(session, ownerEpoch, 0, 0, input.cursor === -1 ? 0 : afterByteCursor).pipe(
        Effect.tapError(() => Effect.sync(() => session.subscribers.delete(token))),
      )
      const status = snapshot.status
      if (status.status !== "running") {
        session.subscribers.delete(token)
        return yield* new UnavailableError({ ptyID: id })
      }
      const end = finiteInt(status.byteCursor)
      const nextSequence = finiteInt(status.nextSequence)
      if (end === undefined || nextSequence === undefined || (input.cursor !== -1 && afterByteCursor > end)) {
        session.subscribers.delete(token)
        return yield* new UnavailableError({ ptyID: id })
      }
      session.byteCursor = Math.max(session.byteCursor, end)
      session.nextSequence = Math.max(session.nextSequence, nextSequence)
      // The attachment resumes from its own byte cursor, so replay only carries the bytes after
      // it; chunks already buffered for this subscriber are excluded to avoid double delivery.
      const firstPending = subscriber.pending[0]?.sequence ?? Number.POSITIVE_INFINITY
      const events: TerminalStreamEvent[] = []
      // `-1` tails from the current end (nothing replayed); otherwise the attachment resumes
      // exactly after its own byte cursor, so replay never repeats bytes it already holds.
      let replayed = input.cursor === -1 ? end : afterByteCursor
      if (input.cursor !== -1) {
        for (const chunk of snapshot.chunks) {
          if (chunk.sequence >= firstPending) break
          if (chunk.byteCursor <= afterByteCursor) continue
          if (chunk.kind !== "output") {
            events.push(chunk)
            continue
          }
          const payload = chunk.payload as Uint8Array
          const start = chunk.byteCursor - payload.byteLength
          if (start >= afterByteCursor) {
            events.push(chunk)
            replayed = chunk.byteCursor
            continue
          }
          const offset = afterByteCursor - start
          events.push({ sequence: chunk.sequence, byteCursor: chunk.byteCursor, kind: chunk.kind, payload: payload.subarray(offset) })
          replayed = chunk.byteCursor
        }
      }
      return {
        attachmentID,
        replay: events,
        ...(snapshot.gap ? { replayGap: snapshot.gap } : {}),
        cursor: replayed,
        ...channelFor(session, attachmentID),
        activate: () => {
          if (subscriber.active || subscriber.detached) return
          subscriber.active = true
          if (subscriber.overflow) {
            dispatch(subscriber, { sequence: subscriber.overflow.lastSequenceExclusive, byteCursor: subscriber.overflow.lastByteCursorExclusive, kind: "gap", payload: subscriber.overflow })
            subscriber.detached = true
            session.subscribers.delete(token)
            return
          }
          for (const event of subscriber.pending) dispatch(subscriber, event)
          subscriber.pending.length = 0
          subscriber.pendingBytes = 0
          if (subscriber.end) subscriber.onEnd(subscriber.end)
        },
        detach: () => {
          subscriber.detached = true
          subscriber.pending.length = 0
          subscriber.pendingBytes = 0
          subscriber.end = undefined
          session.subscribers.delete(token)
        },
      }
    })

    const replyGuardApproval = (input: { approvalID: string; decision: GuardApprovalDecision }) =>
      supervisor.replyGuardApproval(input)
    const prepareToolBatch = Effect.fn("Pty.prepareToolBatch")(function* (input: TerminalToolBatchInput) {
      let profile: RegisteredShellProfile | undefined
      const resolvedEnvironment = yield* Effect.try({
        try: () => validateResolvedEnvironment(input.resolvedEnvironment ?? {}),
        catch: (error) =>
          error instanceof InvalidInputError ? error : new InvalidInputError({ reason: "Terminal environment is invalid" }),
      })
      const calls: GuardedToolCall[] = []
      for (const call of input.calls) {
        if (call.capabilityID !== "terminal.run") {
          calls.push(call)
          continue
        }
        const argumentsValue = yield* Effect.try({
          try: () => {
            const args = asRecord(call.arguments)
            if (
              Object.keys(args).length !== 3 ||
              !("command" in args) ||
              !("cwd" in args) ||
              !("timeoutMs" in args) ||
              "shellProfileID" in args ||
              "resolvedEnvironment" in args
            ) {
              throw new InvalidInputError({ reason: "terminal.run arguments are invalid" })
            }
            return validateTerminalRunInput(args)
          },
          catch: (error) =>
            error instanceof InvalidInputError ? error : new InvalidInputError({ reason: "terminal.run arguments are invalid" }),
        })
        profile ??= yield* registerShellProfiles()
        calls.push({
          ...call,
          arguments: {
            ...argumentsValue,
            shellProfileID: profile.shellProfileID,
            resolvedEnvironment,
          },
        })
      }
      const admission = yield* supervisor.prepareToolBatch({
        sessionID: input.sessionID,
        locationRef: input.locationRef,
        batchID: input.batchID,
        turnContextDigest: input.turnContextDigest,
        calls,
        ...(input.directAttempt ? { directAttempt: input.directAttempt } : {}),
      })
      return { admission, calls }
    })
    const runHost = Effect.fn("Pty.runHost")(function* (input: {
      readonly sessionID?: string
      readonly locationRef: typeof Location.Ref.Type
      readonly effectID: string
      readonly capabilityLeaseDigest: string
      readonly shellProfileID: string
      readonly command: string
      readonly cwd: string
      readonly timeoutMs: number
      readonly resolvedEnvironment: Readonly<Record<string, string>>
      readonly directAttempt?: DirectAttemptScopeV1
    }) {
      const trusted = yield* TrustedPrincipalContext
      const locationID = yield* supervisor.registerHostLocation(input.locationRef)
      const response = yield* supervisor.requestHostKernel("terminal.v1", "run", {
        effectID: input.effectID,
        capabilityLeaseDigest: input.capabilityLeaseDigest,
        locationID,
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        shellProfileID: input.shellProfileID,
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        resolvedEnvironment: input.resolvedEnvironment,
        ...(input.directAttempt ? { directAttempt: directAttemptScopeToWire(input.directAttempt) } : {}),
      }, { cancelOnInterrupt: true, trustedPrincipal: trusted.principal })
      return yield* Effect.try({
        try: () => parseTerminalRunResult(response),
        catch: () => new InvalidInputError({ reason: "Terminal host returned an invalid run result" }),
      })
    })
    const runUser = Effect.fn("Pty.runUser")(function* (
      input: TerminalRunInput & { readonly sessionID?: string; readonly locationRef: typeof Location.Ref.Type },
    ) {
      const args = yield* Effect.try({
        try: () => validateTerminalRunInput(input),
        catch: (error) =>
          error instanceof InvalidInputError ? error : new InvalidInputError({ reason: "terminal.run arguments are invalid" }),
      })
      const { shellProfileID } = yield* registerShellProfiles()
      const resolvedEnvironment = {}
      const prepared = yield* supervisor.prepareUserEffect({
        locationRef: input.locationRef,
        sessionID: input.sessionID,
        capabilityID: "terminal.run",
        arguments: { ...args, shellProfileID, resolvedEnvironment },
      })
      return yield* runHost({
        ...args,
        sessionID: input.sessionID,
        locationRef: input.locationRef,
        effectID: prepared.effectID,
        capabilityLeaseDigest: prepared.capabilityLeaseDigest,
        shellProfileID,
        resolvedEnvironment,
      })
    })
    const runTool = Effect.fn("Pty.runTool")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof Location.Ref.Type
      readonly lease: EffectLease
      readonly call: GuardedToolCall
      readonly directAttempt?: DirectAttemptScopeV1
    }) {
      if (input.call.capabilityID !== "terminal.run") {
        return yield* new InvalidInputError({ reason: "runTool requires a prepared terminal.run call" })
      }
      const args = yield* Effect.try({
        try: () => {
          const value = asRecord(input.call.arguments)
          if (
            Object.keys(value).length !== 5 ||
            !("shellProfileID" in value) ||
            !("resolvedEnvironment" in value) ||
            typeof value.shellProfileID !== "string" ||
            value.shellProfileID.length === 0
          ) {
            throw new InvalidInputError({ reason: "Prepared terminal.run arguments are invalid" })
          }
          return {
            ...validateTerminalRunInput(value),
            shellProfileID: value.shellProfileID,
            resolvedEnvironment: validateResolvedEnvironment(value.resolvedEnvironment),
          }
        },
        catch: (error) =>
          error instanceof InvalidInputError ? error : new InvalidInputError({ reason: "Prepared terminal.run arguments are invalid" }),
      })
      return yield* runHost({
        ...args,
        sessionID: input.sessionID,
        locationRef: input.locationRef,
        effectID: input.lease.effectID,
        capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
        directAttempt: input.directAttempt,
      })
    })
    const acquireTicket = Effect.fn("Pty.acquireTicket")(function* (input: TicketBinding) {
      const session = yield* requireSession(input.terminalID)
      if (input.protocol !== "horizon.terminal.v1") {
        return yield* new InvalidInputError({ reason: "Terminal ticket binding does not match this terminal" })
      }
      yield* validateOrigin(input.origin)
      const trusted = yield* TrustedPrincipalContext
      const principal =
        trusted.principal.kind === "server_auth"
          ? { source: "server_auth", username: trusted.principal.subject }
          : { source: "host_os" }
      const ownerEpoch = yield* supervisor.hostOwnerEpoch()
      const response = yield* supervisor.requestHostKernel(
        "terminal.v1",
        "ticket_acquire",
        {
          terminalID: session.info.id,
          locationID: session.locationID,
          ...(session.sessionID === undefined ? {} : { sessionID: session.sessionID }),
          principal,
          origin: input.origin,
          protocol: input.protocol,
        },
        // The host binds a delegated `server_auth` principal to the authenticated
        // Core peer, so the ticket RPC must carry the typed principal exactly like
        // `terminal.run`; otherwise the kernel denies the request as unattested.
        { trustedPrincipal: trusted.principal },
      )
      const expiresAtUnixMs = wireUnixMs(response.expiresAtUnixMs)
      if (
        typeof response.ticketID !== "string" ||
        !/^ticket_[a-zA-Z0-9_-]{1,128}$/.test(response.ticketID) ||
        typeof response.ticket !== "string" ||
        response.ticket.length < 32 ||
        response.ticket.length > 512 ||
        response.ownerEpoch !== ownerEpoch ||
        expiresAtUnixMs === undefined ||
        expiresAtUnixMs <= Date.now() ||
        expiresAtUnixMs > Date.now() + 30_000
      ) {
        return yield* new UnavailableError({ ptyID: input.terminalID })
      }
      return {
        ticketID: response.ticketID,
        ticket: response.ticket,
        ownerEpoch,
        expiresAtUnixMs: expiresAtUnixMs as number,
      }
    })
    const consumeTicket = Effect.fn("Pty.consumeTicket")(function* (input: TicketBinding & { readonly ticket: string }) {
      const session = yield* requireSession(input.terminalID)
      if (input.protocol !== "horizon.terminal.v1") {
        return yield* new InvalidInputError({ reason: "Terminal ticket binding does not match this terminal" })
      }
      yield* validateOrigin(input.origin)
      if (input.ticket.length < 32 || input.ticket.length > 512) {
        return yield* new InvalidInputError({ reason: "Terminal ticket is invalid" })
      }
      const trusted = yield* TrustedPrincipalContext
      const principal =
        trusted.principal.kind === "server_auth"
          ? { source: "server_auth", username: trusted.principal.subject }
          : { source: "host_os" }
      const ownerEpoch = yield* supervisor.hostOwnerEpoch()
      const response = yield* supervisor.requestHostKernel(
        "terminal.v1",
        "ticket_consume",
        {
          ticket: input.ticket,
          terminalID: session.info.id,
          locationID: session.locationID,
          ...(session.sessionID === undefined ? {} : { sessionID: session.sessionID }),
          principal,
          origin: input.origin,
          protocol: input.protocol,
        },
        { trustedPrincipal: trusted.principal },
      )
      const ticketID = response.ticketID
      const generation = finiteInt(response.generation)
      if (
        typeof ticketID !== "string" ||
        !/^ticket_[a-zA-Z0-9_-]{1,128}$/.test(ticketID) ||
        typeof response.attachmentID !== "string" ||
        !/^att_[a-zA-Z0-9_-]{1,128}$/.test(response.attachmentID) ||
        response.terminalID !== session.info.id ||
        generation !== session.generation ||
        response.ownerEpoch !== ownerEpoch
      ) {
        return yield* new UnavailableError({ ptyID: input.terminalID })
      }
      session.attachments.add(response.attachmentID)
      return {
        ticketID,
        attachmentID: response.attachmentID,
        terminalID: session.info.id,
        generation,
        ownerEpoch,
      }
    })
    const revokeTicket = Effect.fn("Pty.revokeTicket")(function* (input: {
      readonly terminalID: PtyID
      readonly ticketID: string
      readonly attachmentID?: string
    }) {
      const session = yield* requireSession(input.terminalID)
      const trusted = yield* TrustedPrincipalContext
      const principal =
        trusted.principal.kind === "server_auth"
          ? { source: "server_auth", username: trusted.principal.subject }
          : { source: "host_os" }
      if (!/^ticket_[a-zA-Z0-9_-]{1,128}$/.test(input.ticketID)) {
        return yield* new InvalidInputError({ reason: "Terminal ticket ID is invalid" })
      }
      const response = yield* supervisor.requestHostKernel(
        "terminal.v1",
        "ticket_revoke",
        {
          ticketID: input.ticketID,
          terminalID: session.info.id,
          locationID: session.locationID,
          ...(session.sessionID === undefined ? {} : { sessionID: session.sessionID }),
          principal,
          ...(input.attachmentID === undefined ? {} : { attachmentID: input.attachmentID }),
        },
        { trustedPrincipal: trusted.principal },
      )
      if (response.revoked !== true) return yield* new UnavailableError({ ptyID: input.terminalID })
      if (input.attachmentID) session.attachments.delete(input.attachmentID)
    })
    return Service.of({
      list,
      get,
      create,
      update,
      remove,
      write,
      acquireTicket,
      consumeTicket,
      revokeTicket,
      replyGuardApproval,
      attach,
      prepareToolBatch,
      runUser,
      runTool,
    })
  }),
)

function finiteInt(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function validateOrigin(origin: string): Effect.Effect<string, InvalidInputError> {
  return Effect.try({
    try: () => {
      if (origin.length === 0 || Buffer.byteLength(origin, "utf8") > 2048) {
        throw new InvalidInputError({ reason: "Terminal Origin is invalid" })
      }
      const appOrigin = origin === "oc://renderer" || origin === "tauri://localhost"
      if (!appOrigin) {
        const parsed = new URL(origin)
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          parsed.origin !== origin
        ) {
          throw new InvalidInputError({ reason: "Terminal Origin must be an exact app or HTTP(S) origin" })
        }
      }
      return origin
    },
    catch: (error) =>
      error instanceof InvalidInputError ? error : new InvalidInputError({ reason: "Terminal Origin is invalid" }),
  })
}

function validateStartInput(input: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  shellProfileID: string
}) {
  if (Buffer.byteLength(input.command, "utf8") > 64 * 1024) throw new InvalidInputError({ reason: "Command exceeds 64 KiB" })
  if (input.args.length > 256 || input.args.reduce((size, value) => size + Buffer.byteLength(value, "utf8"), 0) > 256 * 1024) {
    throw new InvalidInputError({ reason: "Arguments exceed terminal limits" })
  }
  if (Buffer.byteLength(input.cwd, "utf8") > 4 * 1024) throw new InvalidInputError({ reason: "Working directory exceeds 4 KiB" })
  const envEntries = Object.entries(input.env)
  if (envEntries.length > 128 || envEntries.reduce((size, [key, value]) => size + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8"), 0) > 64 * 1024) {
    throw new InvalidInputError({ reason: "Environment exceeds terminal limits" })
  }
  if (!Number.isInteger(input.cols) || input.cols < 1 || input.cols > 500 || !Number.isInteger(input.rows) || input.rows < 1 || input.rows > 300) {
    throw new InvalidInputError({ reason: "Terminal size is outside supported bounds" })
  }
  return input
}

// terminal.run bounds are intentionally tighter than terminal.start's: a one-shot
// run carries its environment from the host, while start binds an approved env set.
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidInputError({ reason: "Expected an object" })
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidInputError({ reason: "Expected a plain object" })
  }
  return value as Record<string, unknown>
}

function validateTerminalRunInput(value: unknown): TerminalRunInput {
  const input = asRecord(value)
  if (typeof input.command !== "string" || input.command.length === 0 || Buffer.byteLength(input.command, "utf8") > 64 * 1024 || input.command.includes("\0")) {
    throw new InvalidInputError({ reason: "Command is invalid or exceeds 64 KiB" })
  }
  if (typeof input.cwd !== "string" || Buffer.byteLength(input.cwd, "utf8") > 4 * 1024 || input.cwd.includes("\0")) {
    throw new InvalidInputError({ reason: "Working directory is invalid or exceeds 4 KiB" })
  }
  if (!Number.isSafeInteger(input.timeoutMs) || (input.timeoutMs as number) < 1 || (input.timeoutMs as number) > 600_000) {
    throw new InvalidInputError({ reason: "Timeout must be between 1 and 600000 milliseconds" })
  }
  return {
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs as number,
  }
}

function validateResolvedEnvironment(value: unknown): Readonly<Record<string, string>> {
  const environment = asRecord(value)
  const entries = Object.entries(environment)
  if (entries.length > 128) throw new InvalidInputError({ reason: "Environment exceeds 128 entries" })
  let bytes = 0
  const result: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      throw new InvalidInputError({ reason: "Environment contains an invalid key or value" })
    }
    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(entry, "utf8")
    if (bytes > 64 * 1024) throw new InvalidInputError({ reason: "Environment exceeds 64 KiB" })
    result[key] = entry
  }
  return result
}

function parseTerminalRunResult(value: unknown): TerminalRunResult {
  const result = asRecord(value)
  const statuses = ["exited", "timed_out", "cancelled", "unknown"] as const
  const status = result.status
  if (typeof status !== "string" || !statuses.includes(status as (typeof statuses)[number])) {
    throw new InvalidInputError({ reason: "Terminal host returned an invalid status" })
  }
  const preview = result.preview
  if (
    typeof preview !== "string" ||
    Buffer.byteLength(preview, "utf8") > 50 * 1024 ||
    (preview.length > 0 && preview.split(/\r\n|\r|\n/).length > 2_000)
  ) {
    throw new InvalidInputError({ reason: "Terminal host returned an invalid preview" })
  }
  const previewTruncated = result.previewTruncated
  const artifactTruncated = result.artifactTruncated
  const artifactFidelity = result.artifactFidelity
  if (typeof previewTruncated !== "boolean" || typeof artifactTruncated !== "boolean") {
    throw new InvalidInputError({ reason: "Terminal host omitted truncation status" })
  }
  if (artifactFidelity !== "FULL" && artifactFidelity !== "SAMPLE" && artifactFidelity !== "FAILED") {
    throw new InvalidInputError({ reason: "Terminal host omitted artifact fidelity" })
  }
  if (
    (artifactFidelity === "FULL" && (status !== "exited" || artifactTruncated)) ||
    (artifactFidelity === "SAMPLE" && (status !== "exited" || !artifactTruncated)) ||
    (artifactFidelity === "FAILED" && status === "exited")
  ) {
    throw new InvalidInputError({ reason: "Terminal host returned inconsistent artifact fidelity" })
  }
  const artifactRef = result.artifactRef
  const receiptRef = result.receiptRef
  if (
    typeof artifactRef !== "string" ||
    artifactRef.length === 0 ||
    Buffer.byteLength(artifactRef, "utf8") > 4 * 1024 ||
    typeof receiptRef !== "string" ||
    receiptRef.length === 0 ||
    Buffer.byteLength(receiptRef, "utf8") > 4 * 1024
  ) {
    throw new InvalidInputError({ reason: "Terminal host returned an invalid artifact or receipt reference" })
  }
  const exitCode = result.exitCode
  if (
    exitCode !== undefined &&
    (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < -2_147_483_648 || exitCode > 4_294_967_295)
  ) {
    throw new InvalidInputError({ reason: "Terminal host returned an invalid exit code" })
  }
  if (status === "exited" && exitCode === undefined) {
    throw new InvalidInputError({ reason: "Terminal host omitted the exit code" })
  }
  return {
    status: status as TerminalRunResult["status"],
    ...(exitCode === undefined ? {} : { exitCode }),
    preview,
    previewTruncated,
    artifactTruncated,
    artifactFidelity,
    artifactRef,
    receiptRef,
  }
}

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, Config.node, SessionSupervisor.node],
})
