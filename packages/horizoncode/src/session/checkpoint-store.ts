/**
 * Authoritative TypeScript checkpoint capture/restore for a Session.
 *
 * The Rust HostKernel explicitly rejects checkpoint.create/checkpoint.restore
 * (kernel/src/host_kernel.rs), so this store is the real capture/restore path:
 *  - capture reads the conversation through Session.Service and snapshots the
 *    workspace with direct reads (reads are allowed to bypass the Guard).
 *  - restore NEVER writes workspace files with fs directly. Every code write is
 *    admitted through the Guarded path (SessionSupervisor.prepareToolBatch ->
 *    one-use lease -> SessionSupervisor.executeWrite), mirroring
 *    packages/core/src/tool/write.ts. An admission failure mutates nothing.
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import { Session } from "./session"
import { SessionID } from "./schema"
import { NotFoundError, Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import { Database } from "@horizoncode/core/database/database"
import {
  SessionSupervisor,
  type EffectAdmission,
  type EffectLease,
  type GuardedToolCall,
  type SessionSupervisorError,
} from "@horizoncode/core/session/supervisor"
import { SessionContextEpoch } from "@horizoncode/core/session/context-epoch"
import { SystemContext } from "@horizoncode/core/system-context"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { trustedPrincipalAllowsSessionMutation } from "@/util/principal-mint"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"

const ID = /^[A-Za-z0-9._-]{1,256}$/
const DIGEST = /^blake3:[0-9a-f]{64}$/
const MESSAGE_ID = /^msg/
const SKIP_DIRECTORIES = new Set([".git", "node_modules"])
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 2_000
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
/** Mirrors SessionSupervisor's ToolBatch wire bounds (core/session/supervisor.ts). */
const MAX_CALLS_PER_BATCH = 32
const MAX_CALL_ARGUMENT_BYTES = 256 * 1024
const MAX_BATCH_ARGUMENT_BYTES = 512 * 1024
/** Conservative MessagePack framing overhead on top of the raw utf8 members. */
const REST_ARGUMENT_OVERHEAD_BYTES = 128

// ---------------------------------------------------------------- types ----

export type CheckpointFile = {
  readonly path: string
  readonly digest: string
  readonly byteLength: number
  readonly contentBase64: string
  readonly executable: boolean
}

export type CheckpointRecord = {
  readonly checkpointID: string
  readonly sessionID: string
  readonly capturedAt: number
  readonly messageCount: number
  readonly lastMessageID: string | null
  readonly files: readonly CheckpointFile[]
  readonly digest: string
}

export type CaptureResult = {
  readonly checkpointID: string
  readonly messageCount: number
  readonly fileCount: number
  readonly capturedAt: number
  readonly digest: string
}

export type RestoreResult = {
  readonly checkpointID: string
  readonly restoredMessages: number
  readonly restoredFiles: number
  readonly removedFiles: number
  readonly guarded: true
}

// --------------------------------------------------------------- errors ----

export class CheckpointNotFoundError extends Schema.TaggedErrorClass<CheckpointNotFoundError>()(
  "CheckpointStore.NotFound",
  { checkpointID: Schema.String },
) {
  override get message() {
    return `Checkpoint ${this.checkpointID} was not found`
  }
}

export class RestoreAdmissionRequiredError extends Schema.TaggedErrorClass<RestoreAdmissionRequiredError>()(
  "CheckpointStore.RestoreAdmissionRequired",
  { reason: Schema.String },
) {
  override get message() {
    return `Checkpoint restore requires Guard admission: ${this.reason}`
  }
}

export class RestoreFailedError extends Schema.TaggedErrorClass<RestoreFailedError>()(
  "CheckpointStore.RestoreFailed",
  { reason: Schema.String },
) {
  override get message() {
    return `Checkpoint restore failed: ${this.reason}`
  }
}

/**
 * Fail-closed input/limit violations. The EXACT public contract pins each
 * method's typed channel (capture -> CheckpointNotFoundError only), so limits
 * and malformed identifiers surface as loud typed DEFECTS instead of being
 * silently truncated or misreported as NotFound.
 */
export class CheckpointDefectError extends Schema.TaggedErrorClass<CheckpointDefectError>()(
  "CheckpointStore.Defect",
  { operation: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `Checkpoint ${this.operation} hit an unrecoverable condition: ${this.reason}`
  }
}

// ------------------------------------------------------------- digests -----

const encoder = new TextEncoder()

const digestBytes = (bytes: Uint8Array): string => `blake3:${bytesToHex(blake3(bytes))}`
const digestText = (text: string): string => digestBytes(encoder.encode(text))

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`
}

/** Record digest: blake3 over canonical {files digests, lastMessageID, messageCount}. */
const recordDigest = (input: {
  readonly files: readonly { readonly path: string; readonly digest: string }[]
  readonly lastMessageID: string | null
  readonly messageCount: number
}): string =>
  digestText(
    canonicalize({
      files: [...input.files]
        .map((file) => ({ path: file.path, digest: file.digest }))
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      lastMessageID: input.lastMessageID,
      messageCount: input.messageCount,
    }),
  )

// ------------------------------------------------------------ validation ---

/** Mirror Rust's checkpoint relative-path contract. */
function safeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  )
}

const defect = (operation: string, reason: string) => new CheckpointDefectError({ operation, reason })

function requireIdentifier(operation: string, value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw defect(operation, `${label} is invalid`)
  return value
}

// ---------------------------------------------------------------- walk -----

type WalkedFile = {
  readonly path: string
  readonly bytes: Buffer
  readonly digest: string
  readonly executable: boolean
}

/**
 * Walk the workspace collecting regular files with the capture rules:
 * skip .git/ and node_modules/ at any depth, skip files larger than 1 MiB.
 * Capture/reading workspace files directly is allowed; only WRITES are
 * required to go through the Guard.
 */
const walkWorkspace = Effect.fn("CheckpointStore.walkWorkspace")(function* (directory: string) {
  const sink: WalkedFile[] = []
  let totalBytes = 0

  let recurse: (relative: string) => Effect.Effect<void, RestoreFailedError, never>
  recurse = Effect.fnUntraced(function* (relative: string) {
    const entries = yield* Effect.tryPromise({
      try: () => fs.readdir(path.join(directory, relative), { withFileTypes: true }),
      catch: (error) => new RestoreFailedError({ reason: `workspace walk failed: ${String(error)}` }),
    })
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (!safeRelativePath(child)) continue
      if (entry.isDirectory()) {
        yield* recurse(child)
        continue
      }
      if (!entry.isFile()) continue
      const absolute = path.join(directory, child)
      const stat = yield* Effect.tryPromise({
        try: () => fs.stat(absolute),
        catch: (error) => new RestoreFailedError({ reason: `workspace stat failed: ${String(error)}` }),
      })
      if (!stat.isFile()) continue
      // Skip rule: files larger than 1 MiB are excluded from the record.
      if (stat.size > MAX_FILE_BYTES) continue
      const bytes = yield* Effect.tryPromise({
        try: () => fs.readFile(absolute),
        catch: (error) => new RestoreFailedError({ reason: `workspace read failed: ${String(error)}` }),
      })
      totalBytes += bytes.length
      sink.push({
        path: child,
        bytes,
        digest: digestBytes(bytes),
        executable: (stat.mode & 0o111) !== 0,
      })
    }
  })

  yield* recurse("")

  // Hard caps: fail loudly, never silently truncate.
  if (sink.length > MAX_FILES) {
    return yield* Effect.die(
      new CheckpointDefectError({
        operation: "capture",
        reason: `workspace contains ${sink.length} files which exceeds the ${MAX_FILES} checkpoint file cap`,
      }),
    )
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return yield* Effect.die(
      new CheckpointDefectError({
        operation: "capture",
        reason: `workspace snapshot is ${totalBytes} bytes which exceeds the ${MAX_TOTAL_BYTES} checkpoint byte cap`,
      }),
    )
  }
  return sink
})

// ----------------------------------------------------- record validation ---

function decodeRecord(sessionID: string, checkpointID: string, value: unknown): CheckpointRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const files = raw.files
  if (
    raw.checkpointID !== checkpointID ||
    raw.sessionID !== sessionID ||
    typeof raw.capturedAt !== "number" ||
    !Number.isSafeInteger(raw.capturedAt) ||
    typeof raw.messageCount !== "number" ||
    !Number.isSafeInteger(raw.messageCount) ||
    raw.messageCount < 0 ||
    !(raw.lastMessageID === null || (typeof raw.lastMessageID === "string" && MESSAGE_ID.test(raw.lastMessageID))) ||
    typeof raw.digest !== "string" ||
    !DIGEST.test(raw.digest) ||
    !Array.isArray(files)
  ) {
    return undefined
  }
  const decoded: CheckpointFile[] = []
  for (const file of files) {
    if (typeof file !== "object" || file === null || Array.isArray(file)) return undefined
    const item = file as Record<string, unknown>
    if (
      !safeRelativePath(item.path) ||
      typeof item.digest !== "string" ||
      !DIGEST.test(item.digest) ||
      typeof item.byteLength !== "number" ||
      !Number.isSafeInteger(item.byteLength) ||
      item.byteLength < 0 ||
      typeof item.contentBase64 !== "string" ||
      typeof item.executable !== "boolean"
    ) {
      return undefined
    }
    decoded.push({
      path: item.path,
      digest: item.digest,
      byteLength: item.byteLength,
      contentBase64: item.contentBase64,
      executable: item.executable,
    })
  }
  // Integrity: the record digest must cover exactly the persisted members.
  if (
    recordDigest({ files: decoded, lastMessageID: raw.lastMessageID as string | null, messageCount: raw.messageCount }) !==
    raw.digest
  ) {
    return undefined
  }
  return {
    checkpointID,
    sessionID,
    capturedAt: raw.capturedAt,
    messageCount: raw.messageCount,
    lastMessageID: raw.lastMessageID as string | null,
    files: decoded,
    digest: raw.digest,
  }
}

// -------------------------------------------------------------- restore ----

type RestoreWrite = { readonly path: string; readonly content: string; readonly absolutePath: string }

/** Split the write plan into Guard ToolBatch-legal chunks; fail closed on oversized members. */
function chunkRestores(writes: readonly RestoreWrite[]): RestoreWrite[][] {
  const chunks: RestoreWrite[][] = []
  let current: RestoreWrite[] = []
  let bytes = 0
  for (const write of writes) {
    const encoded =
      Buffer.byteLength(write.path, "utf8") + Buffer.byteLength(write.content, "utf8") + REST_ARGUMENT_OVERHEAD_BYTES
    if (encoded > MAX_CALL_ARGUMENT_BYTES) {
      throw new RestoreFailedError({
        reason: `file ${write.path} exceeds the guarded files.write argument bound (${encoded} bytes)`,
      })
    }
    if (current.length >= MAX_CALLS_PER_BATCH || bytes + encoded > MAX_BATCH_ARGUMENT_BYTES) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(write)
    bytes += encoded
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Resolve a Guard admission into one one-use lease per requested call, in order. */
function leasesForAdmission(
  admission: EffectAdmission,
  calls: readonly GuardedToolCall[],
): Effect.Effect<readonly EffectLease[], RestoreAdmissionRequiredError> {
  if (admission.status === "denied") {
    return Effect.fail(
      new RestoreAdmissionRequiredError({ reason: `Guard denied the restore batch: ${admission.reason}` }),
    )
  }
  if (admission.status === "admitted") {
    // A bare "admitted" challenge is still awaiting user approval; Core holds
    // no lease yet, so restore must fail without mutating anything.
    return Effect.fail(
      new RestoreAdmissionRequiredError({ reason: "Guard admission is awaiting user approval (no lease issued)" }),
    )
  }
  const leases: EffectLease[] = []
  if (admission.status === "prepared") {
    // A whole-batch prepared lease authorizes every member of the batch.
    for (let i = 0; i < calls.length; i++) leases.push(admission.lease)
  } else {
    const byCallID = new Map(admission.calls.map((item) => [item.callID, item.lease]))
    for (const call of calls) {
      const lease = byCallID.get(call.callID)
      if (lease === undefined) {
        return Effect.fail(
          new RestoreAdmissionRequiredError({
            reason: `Guard admission omitted the one-use lease for call ${call.callID}`,
          }),
        )
      }
      leases.push(lease)
    }
  }
  for (const lease of leases) {
    if (
      !lease ||
      typeof lease.effectID !== "string" ||
      !lease.effectID ||
      typeof lease.capabilityLeaseDigest !== "string" ||
      !lease.capabilityLeaseDigest
    ) {
      return Effect.fail(
        new RestoreAdmissionRequiredError({ reason: "Guard admission returned an invalid one-use lease" }),
      )
    }
  }
  return Effect.succeed(leases)
}

// ------------------------------------------------------------- service -----

export interface Interface {
  readonly capture: (input: { sessionID: string }) => Effect.Effect<CaptureResult, CheckpointNotFoundError>
  readonly list: (input: { sessionID: string }) => Effect.Effect<string[]>
  readonly get: (input: { sessionID: string; checkpointID: string }) => Effect.Effect<
    CheckpointRecord,
    CheckpointNotFoundError
  >
  readonly restore: (input: {
    sessionID: string
    checkpointID: string
  }) => Effect.Effect<
    RestoreResult,
    | CheckpointNotFoundError
    | RestoreAdmissionRequiredError
    | RestoreFailedError
    | SessionSupervisorError
  >
}

export class Service extends Context.Service<Service, Interface>()("@horizoncode/CheckpointStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const supervisor = yield* SessionSupervisor.Service
    const storage = yield* Storage.Service
    const database = yield* Database.Service

    const capture = Effect.fn("CheckpointStore.capture")(function* (input: { sessionID: string }) {
      requireIdentifier("capture", input.sessionID, "sessionID")
      const messages = yield* session
        .messages({ sessionID: SessionID.make(input.sessionID) })
        .pipe(
          Effect.catchIf(NotFoundError.isInstance, () =>
            Effect.fail(new CheckpointNotFoundError({ checkpointID: "" })),
          ),
        )
      const context = yield* InstanceState.context
      const walked = yield* walkWorkspace(context.directory).pipe(Effect.orDie)
      const checkpointID = `chk_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`
      const lastMessage = messages.at(-1)
      const lastMessageID = lastMessage ? lastMessage.info.id : null
      const files: CheckpointFile[] = walked.map((file) => ({
        path: file.path,
        digest: file.digest,
        byteLength: file.bytes.length,
        contentBase64: file.bytes.toString("base64"),
        executable: file.executable,
      }))
      const record: CheckpointRecord = {
        checkpointID,
        sessionID: input.sessionID,
        capturedAt: Date.now(),
        messageCount: messages.length,
        lastMessageID,
        files,
        digest: recordDigest({ files, lastMessageID, messageCount: messages.length }),
      }
      yield* storage.write(["checkpoints", input.sessionID, checkpointID], record)
      return {
        checkpointID,
        messageCount: record.messageCount,
        fileCount: record.files.length,
        capturedAt: record.capturedAt,
        digest: record.digest,
      }
    })

    const list = Effect.fn("CheckpointStore.list")(function* (input: { sessionID: string }) {
      requireIdentifier("list", input.sessionID, "sessionID")
      const entries = yield* storage.list(["checkpoints", input.sessionID])
      return entries.map((key) => key.at(-1)).filter((id): id is string => typeof id === "string" && ID.test(id))
    })

    const get = Effect.fn("CheckpointStore.get")(function* (input: { sessionID: string; checkpointID: string }) {
      requireIdentifier("get", input.sessionID, "sessionID")
      requireIdentifier("get", input.checkpointID, "checkpointID")
      const stored = yield* storage.read<unknown>(["checkpoints", input.sessionID, input.checkpointID]).pipe(
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.fail(new CheckpointNotFoundError({ checkpointID: input.checkpointID })),
        ),
      )
      // A corrupt or tampered record is unusable: fail closed as not-found
      // rather than restoring from unverifiable content.
      const record = decodeRecord(input.sessionID, input.checkpointID, stored)
      if (!record) return yield* new CheckpointNotFoundError({ checkpointID: input.checkpointID })
      return record
    })

    const restore = Effect.fn("CheckpointStore.restore")(function* (input: {
      sessionID: string
      checkpointID: string
    }) {
      // Fail-closed principal gate before anything is read or mutated.
      const principalOption = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (
        Option.isNone(principalOption) ||
        !trustedPrincipalAllowsSessionMutation(principalOption.value.principal)
      ) {
        return yield* new RestoreAdmissionRequiredError({
          reason: "checkpoint restore requires an authenticated server_auth principal or local CLI host_os principal",
        })
      }
      const principal = principalOption.value
      const trustedPrincipal = principal.principal

      const record = yield* get({ sessionID: input.sessionID, checkpointID: input.checkpointID })
      const sessionID = SessionID.make(record.sessionID)
      const currentMessages = yield* session.messages({ sessionID }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])),
      )

      // Validate the captured conversation boundary exists BEFORE any phase
      // mutates anything, so a stale boundary can never rewind to a guess.
      if (
        record.lastMessageID !== null &&
        currentMessages.length > 0 &&
        !currentMessages.some((message) => message.info.id === record.lastMessageID)
      ) {
        return yield* new RestoreFailedError({
          reason: `captured conversation boundary ${record.lastMessageID} no longer exists in the session`,
        })
      }

      const context = yield* InstanceState.context
      const directory = context.directory
      const walked = yield* walkWorkspace(directory)
      const currentByPath = new Map(walked.map((file) => [file.path, file]))

      // Additive-restore-only code phase: every file present in the checkpoint
      // whose current digest differs (or is missing) is written back through
      // the Guard. We do NOT delete workspace files that were created after the
      // checkpoint: the store has no provenance proving a file belongs to
      // post-checkpoint session state, and fail-closed means never deleting
      // files we cannot prove. removedFiles is therefore always 0.
      const writes: RestoreWrite[] = []
      for (const file of record.files) {
        const now = currentByPath.get(file.path)
        if (now && now.digest === file.digest) continue
        writes.push({
          path: file.path,
          content: Buffer.from(file.contentBase64, "base64").toString("utf8"),
          absolutePath: path.join(directory, file.path),
        })
      }

      // Location.Ref is built from the live instance context, exactly like the
      // guarded write/edit tools (src/tool/edit.ts, src/session/llm.ts).
      const locationRef = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      const batches = yield* Effect.try({
        try: () => chunkRestores(writes),
        catch: (error) =>
          error instanceof RestoreFailedError
            ? error
            : new RestoreFailedError({ reason: `restore write plan is invalid: ${String(error)}` }),
      })

      // ORDERING (fail-closed): the whole code phase — admission AND writes —
      // runs BEFORE the conversation phase. If Guard admission fails at any
      // batch, restore errors out with nothing mutated: no files written, no
      // messages removed, no context epoch reset.
      let restoredFiles = 0
      let callIndex = 0
      for (const [batchIndex, batch] of batches.entries()) {
        const calls: GuardedToolCall[] = batch.map((write, offset) => ({
          callID: `restore_${callIndex + offset}`,
          capabilityID: "files.write",
          arguments: { path: write.path, content: write.content },
        }))
        const admission = yield* supervisor
          .prepareToolBatch({
            sessionID: record.sessionID,
            locationRef,
            batchID: `checkpoint_restore_${record.checkpointID}_${batchIndex}`,
            turnContextDigest: record.digest,
            calls,
          })
          .pipe(Effect.provideService(TrustedPrincipalContext, principal))
        const leases = yield* leasesForAdmission(admission, calls)
        for (const [offset, write] of batch.entries()) {
          const lease = leases[offset]!
          // Every write crosses the same Guarded execution path as the model's
          // write tool: one-use lease -> executeWrite -> receipt validation.
          const receipt = yield* Effect.uninterruptible(
            supervisor.executeWrite({
              sessionID: record.sessionID,
              locationRef,
              lease,
              content: write.content,
              trustedPrincipal,
            }),
          )
          if (
            receipt.effectID !== lease.effectID ||
            receipt.target !== write.absolutePath ||
            receipt.resource !== write.absolutePath
          ) {
            return yield* new RestoreFailedError({
              reason: `Rust receipt for ${write.path} does not match the prepared lease`,
            })
          }
          restoredFiles++
        }
        callIndex += batch.length
      }

      // Conversation phase: remove every message newer than the captured
      // boundary (newest first); a null boundary removes the whole history.
      const boundaryIndex =
        record.lastMessageID === null
          ? -1
          : currentMessages.findIndex((message) => message.info.id === record.lastMessageID)
      const toRemove = (boundaryIndex === -1 ? currentMessages : currentMessages.slice(boundaryIndex + 1)).map(
        (message) => message.info.id,
      )
      for (const messageID of [...toRemove].reverse()) {
        yield* session.removeMessage({ sessionID, messageID })
      }

      // Fresh Context Epoch: drop the pre-restore epoch row and stamp a new
      // one so the next turn's prepare observes the rewind (the empty baseline
      // is refreshed by the runner's real system-context sources on the first
      // turn after restore).
      yield* SessionContextEpoch.reset(database.db, sessionID)
      yield* SessionContextEpoch.initialize(database.db, Effect.succeed(SystemContext.empty), sessionID)

      return {
        checkpointID: record.checkpointID,
        restoredMessages: toRemove.length,
        restoredFiles,
        removedFiles: 0,
        guarded: true as const,
      }
    })

    return Service.of({ capture, list, get, restore } as any)
  }),
)

/**
 * Location is intentionally NOT a layer dependency: the Guard call locationRef
 * is built from the live InstanceState context (same as the guarded edit/write
 * tools), so no ambient Location.Service is required and the node compiles
 * without an unbound location tag.
 */
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, SessionSupervisor.node, Storage.node, Database.node],
})

export * as CheckpointStore from "./checkpoint-store"
