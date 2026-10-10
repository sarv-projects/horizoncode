/**
 * Effect-scoped client for the Linux read-only Session observer.
 *
 * OpenCode keeps owning Session rows, messages, provider continuation and EventV2. This
 * module starts the Rust projection observer, negotiates its private MessagePack channel,
 * and forwards only bounded metadata events to its caller.
 */

import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createConnection, type Socket } from "node:net"
import { dirname, join } from "node:path"
import { pack, unpack } from "msgpackr"
import { Context, Effect, Layer, Schema } from "effect"
import type * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { LayerNode } from "../effect/layer-node"
import { AppProcess } from "../process"

const PROTOCOL = 1
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_PENDING_BYTES = MAX_FRAME_BYTES * 2 + 8
const MAX_PENDING_MESSAGES = 128
const PAGE_CONTROL_FEATURE = "session.events.page-control.v1"
const REQUIRED_FEATURES = ["session.events.v1", PAGE_CONTROL_FEATURE] as const
const BASE_DIGEST = `blake3:${"0".repeat(64)}`

export type Cursor = {
  readonly ownerKind: string
  readonly ownerId: string
  readonly seq: string
  readonly eventDigest: string
}

export type SessionEvent = {
  readonly kind: "event"
  readonly subscriptionId: string
  readonly cursor: Cursor
  readonly eventType: string
  readonly payload: unknown
}

export type PageEnd = {
  readonly kind: "page_end"
  readonly subscriptionId: string
  readonly through: Cursor
  readonly hasMore: boolean
}

export type ResnapshotRequired = {
  readonly kind: "resnapshot_required"
  readonly subscriptionId: string
  readonly requested: Cursor
  readonly latest: Cursor
}

export type ServerMessage = SessionEvent | PageEnd | ResnapshotRequired

export type OpenOptions = {
  /** Absolute path to the pinned `session_supervisor` binary. */
  readonly binary: string
  /** Existing OpenCode EventV2 database; Rust opens it read-only. */
  readonly source: string
  /** Private per-Session directory; this service creates it when absent. */
  readonly stateDirectory: string
  readonly sessionID: string
  readonly hostBuildDigest: string
  readonly startupTimeoutMs?: number
}

export class SessionSupervisorError extends Schema.TaggedErrorClass<SessionSupervisorError>()(
  "SessionSupervisorError",
  {
    stage: Schema.String,
    reason: Schema.String,
  },
) {
  override get message() {
    return `Session supervisor ${this.stage} failed: ${this.reason}`
  }
}

export interface SessionSupervisorClient {
  readonly subscriptionId: string
  readonly resumeCursor: () => Promise<Cursor>
  readonly subscribe: (after?: Cursor) => Promise<void>
  readonly receive: () => Promise<ServerMessage>
  readonly ack: (event: SessionEvent) => Promise<void>
  readonly unsubscribe: () => Promise<void>
  readonly stop: () => Promise<void>
}

export interface Interface {
  /**
   * Acquire a child and authenticated channel in the caller's Effect scope. Scope close
   * sends Unsubscribe, closes the socket, and waits for the child before force termination.
   */
  readonly open: (
    options: OpenOptions,
  ) => Effect.Effect<SessionSupervisorClient, SessionSupervisorError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSupervisor") {}

function fail(stage: string, reason: string) {
  return new SessionSupervisorError({ stage, reason })
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail("protocol", "message must be a map")
  }
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0 || Buffer.byteLength(field, "utf8") > 256) {
    throw fail("protocol", `invalid ${key}`)
  }
  return field
}

function cursor(value: unknown): Cursor {
  const item = record(value)
  const ownerKind = stringField(item, "ownerKind")
  const ownerId = stringField(item, "ownerId")
  const seq = stringField(item, "seq")
  const eventDigest = stringField(item, "eventDigest")
  if (!/^(0|[1-9][0-9]*)$/.test(seq) || !/^blake3:[0-9a-f]{64}$/.test(eventDigest)) {
    throw fail("protocol", "invalid cursor encoding")
  }
  return { ownerKind, ownerId, seq, eventDigest }
}

function sameCursor(left: Cursor, right: Cursor) {
  return (
    left.ownerKind === right.ownerKind &&
    left.ownerId === right.ownerId &&
    left.seq === right.seq &&
    left.eventDigest === right.eventDigest
  )
}

function baseCursor(sessionID: string): Cursor {
  return {
    ownerKind: "session",
    ownerId: sessionID,
    seq: "0",
    eventDigest: BASE_DIGEST,
  }
}

function readCheckpoint(path: string, sessionID: string): Cursor {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return baseCursor(sessionID)
    }
    throw fail("checkpoint", "cannot inspect the acknowledged cursor")
  }
  const uid = process.getuid?.()
  if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0 || stat.size > 2048) {
    throw fail("checkpoint", "acknowledged cursor file is unsafe")
  }
  try {
    const decoded = cursor(JSON.parse(readFileSync(path, "utf8")))
    if (decoded.ownerKind !== "session" || decoded.ownerId !== sessionID) {
      throw fail("checkpoint", "acknowledged cursor belongs to another Session")
    }
    return decoded
  } catch (error) {
    throw error instanceof SessionSupervisorError ? error : fail("checkpoint", "acknowledged cursor is malformed")
  }
}

function writeCheckpoint(path: string, value: Cursor) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 })
    const file = openSync(temporary, "r")
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, path)
    const directory = openSync(dirname(path), "r")
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch {
    try {
      unlinkSync(temporary)
    } catch {}
    throw fail("checkpoint", "could not persist acknowledged cursor")
  }
}

function decodeServerMessage(input: unknown): ServerMessage {
  const message = record(input)
  const kind = stringField(message, "kind")
  if (kind === "event") {
    if (message.protocol !== PROTOCOL) throw fail("protocol", "incompatible event protocol")
    return {
      kind,
      subscriptionId: stringField(message, "subscriptionId"),
      cursor: cursor(message.cursor),
      eventType: stringField(message, "eventType"),
      payload: message.payload,
    }
  }
  if (kind === "page_end") {
    if (typeof message.hasMore !== "boolean") throw fail("protocol", "invalid page boundary")
    return {
      kind,
      subscriptionId: stringField(message, "subscriptionId"),
      through: cursor(message.through),
      hasMore: message.hasMore,
    }
  }
  if (kind === "resnapshot_required") {
    const requested = cursor(message.requested)
    const latest = cursor(message.latest)
    if (requested.ownerKind !== latest.ownerKind || requested.ownerId !== latest.ownerId) {
      throw fail("protocol", "resnapshot cursors do not share an owner")
    }
    return {
      kind,
      subscriptionId: stringField(message, "subscriptionId"),
      requested,
      latest,
    }
  }
  throw fail("protocol", "unexpected server message")
}

class MessageChannel {
  #socket: Socket
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  #messages: Array<{ value: unknown; bytes: number }> = []
  #messageBytes = 0
  #waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  #closed: Error | undefined

  constructor(socket: Socket) {
    this.#socket = socket
    socket.on("data", (chunk: Buffer) => this.#onData(chunk))
    socket.on("error", (error) => this.#close(fail("transport", error.message)))
    socket.on("end", () => this.#close(fail("transport", "peer closed the channel")))
    socket.on("close", () => this.#close(fail("transport", "channel closed")))
  }

  async send(value: Record<string, unknown>) {
    if (this.#closed) throw this.#closed
    const payload = Buffer.from(pack(value))
    if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
      throw fail("transport", "outgoing frame exceeds the protocol limit")
    }
    const frame = Buffer.allocUnsafe(payload.length + 4)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(frame, (error) => (error ? reject(fail("transport", error.message)) : resolve()))
    })
  }

  async receive() {
    if (this.#messages.length > 0) {
      const message = this.#messages.shift()!
      this.#messageBytes -= message.bytes
      return message.value
    }
    if (this.#closed) throw this.#closed
    const value = await new Promise<unknown>((resolve, reject) => this.#waiters.push({ resolve, reject }))
    return value
  }

  end() {
    this.#socket.end()
  }

  destroy() {
    this.#socket.destroy()
  }

  #onData(chunk: Buffer) {
    if (this.#closed) return
    if (this.#buffer.length + chunk.length > MAX_PENDING_BYTES) {
      this.#close(fail("transport", "peer exceeded the bounded receive window"))
      this.#socket.destroy()
      return
    }
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.#close(fail("transport", "incoming frame exceeds the protocol limit"))
        this.#socket.destroy()
        return
      }
      if (this.#buffer.length < length + 4) return
      const payload = this.#buffer.subarray(4, length + 4)
      this.#buffer = this.#buffer.subarray(length + 4)
      let value: unknown
      try {
        value = unpack(payload)
      } catch {
        this.#close(fail("protocol", "invalid MessagePack payload"))
        this.#socket.destroy()
        return
      }
      const waiter = this.#waiters.shift()
      if (waiter) waiter.resolve(value)
      else {
        if (this.#messages.length >= MAX_PENDING_MESSAGES || this.#messageBytes + length > MAX_PENDING_BYTES) {
          this.#close(fail("transport", "peer exceeded the bounded message queue"))
          this.#socket.destroy()
          return
        }
        this.#messages.push({ value, bytes: length })
        this.#messageBytes += length
      }
    }
  }

  #close(error: Error) {
    if (this.#closed) return
    this.#closed = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }
}

function validateStateDirectory(path: string) {
  if (!path.startsWith("/")) throw fail("configuration", "state directory must be absolute")
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    canonical = realpathSync(path)
  }
  if (canonical !== path) throw fail("configuration", "state directory must be canonical")
  const stat = lstatSync(path)
  const uid = process.getuid?.()
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw fail("configuration", "state directory must be owner-only and non-symlinked")
  }
  return canonical
}

function validateSocketPath(path: string) {
  if (Buffer.byteLength(path, "utf8") >= 108) throw fail("configuration", "Unix socket path is too long")
  if (existsSync(path)) throw fail("configuration", "refusing to replace an existing socket path")
}

function waitForSocket(path: string, child: ChildProcessHandle, signal: AbortSignal, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  return new Promise<void>((resolve, reject) => {
    const inspect = async () => {
      if (signal.aborted) return reject(signal.reason ?? new Error("aborted"))
      if (Date.now() >= deadline) return reject(fail("startup", "timed out waiting for the supervisor socket"))
      try {
        const stat = lstatSync(path)
        if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
          return reject(fail("authentication", "supervisor socket permissions or owner are invalid"))
        }
        return resolve()
      } catch {
        const running = await Effect.runPromise(child.isRunning).catch(() => false)
        if (!running) return reject(fail("startup", "supervisor exited before binding its socket"))
        setTimeout(inspect, 20)
      }
    }
    inspect()
  })
}

function connectSocket(path: string, signal: AbortSignal, timeoutMs: number) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(path)
    const timer = setTimeout(() => finish(fail("startup", "timed out connecting to supervisor")), timeoutMs)
    const abort = () => finish(fail("startup", "supervisor startup was cancelled"))
    const finish = (error?: Error) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      socket.removeListener("connect", connected)
      socket.removeListener("error", failed)
      if (error) {
        socket.destroy()
        reject(error)
      } else resolve(socket)
    }
    const connected = () => finish()
    const failed = (error: Error) => finish(fail("transport", error.message))
    signal.addEventListener("abort", abort, { once: true })
    socket.once("connect", connected)
    socket.once("error", failed)
  })
}

function validateHelloResult(input: unknown, nonce: string, incarnation: string) {
  const message = record(input)
  if (message.kind !== "hello_result" || message.protocol !== PROTOCOL) {
    throw fail("handshake", "kernel returned an incompatible Hello result")
  }
  if (message.supervisorNonce !== nonce || message.processIncarnation !== incarnation) {
    throw fail("handshake", "kernel Hello result did not bind to this child and host incarnation")
  }
  const enabledFeatures = message.enabledFeatures
  if (!Array.isArray(enabledFeatures) || !REQUIRED_FEATURES.every((feature) => enabledFeatures.includes(feature))) {
    throw fail("handshake", "kernel did not negotiate required Session features")
  }
}

function startupStatus(input: unknown): "starting" | "ready" | "failed" {
  const message = record(input)
  if (message.kind !== "startup_status" || message.protocol !== PROTOCOL) {
    throw fail("startup", "expected a typed startup status")
  }
  if (message.state === "STARTING") return "starting"
  if (message.state === "READY") return "ready"
  if (message.state === "FAILED") return "failed"
  throw fail("startup", "kernel returned an unknown startup state")
}

async function establishChannel(
  options: OpenOptions,
  child: ChildProcessHandle,
  signal: AbortSignal,
  nonce: string,
  incarnation: string,
  socketPath: string,
): Promise<SessionSupervisorClient> {
  const stateDirectory = validateStateDirectory(options.stateDirectory)
  const source = realpathSync(options.source)
  const binary = realpathSync(options.binary)
  if (!/^blake3:[0-9a-f]{64}$/.test(options.hostBuildDigest)) {
    throw fail("configuration", "host build digest must be a canonical BLAKE3 digest")
  }
  if (!/^ses_[a-zA-Z0-9_-]{1,128}$/.test(options.sessionID)) {
    throw fail("configuration", "Session ID is invalid")
  }
  const hostInstanceId = randomUUID()
  const hostExecutable = realpathSync(process.execPath)
  const timeoutMs = options.startupTimeoutMs ?? 10_000
  await waitForSocket(socketPath, child, signal, timeoutMs)
  const socket = await connectSocket(socketPath, signal, timeoutMs)
  const channel = new MessageChannel(socket)
  await channel.send({
    kind: "hello",
    minProtocol: PROTOCOL,
    maxProtocol: PROTOCOL,
    hostBuildDigest: options.hostBuildDigest,
    hostInstanceId,
    processIncarnation: incarnation,
    supervisorNonce: nonce,
    requiredFeatures: [...REQUIRED_FEATURES],
    optionalFeatures: [],
  })
  const reply = record(await channel.receive())
  if (reply.kind === "hello_rejected") throw fail("handshake", "kernel rejected protocol or required features")
  validateHelloResult(reply, nonce, incarnation)
  for (let count = 0; count < 16; count++) {
    const status = startupStatus(await channel.receive())
    if (status === "ready") break
    if (status === "failed") throw fail("startup", "kernel failed before READY")
    if (count === 15) throw fail("startup", "kernel did not reach READY")
  }

  const checkpointPath = join(stateDirectory, `session-${options.sessionID}.cursor`)
  return new SessionSupervisorClientImpl(channel, child, options.sessionID, checkpointPath)
}

class SessionSupervisorClientImpl implements SessionSupervisorClient {
  readonly subscriptionId = `sub_${randomUUID().replaceAll("-", "")}`
  #channel: MessageChannel
  #child: ChildProcessHandle
  #sessionID: string
  #checkpointPath: string
  #subscribed = false
  #lastCursor: Cursor | undefined
  #lastDelivered: Cursor | undefined
  #pending: SessionEvent[] = []
  #closed = false
  #stopPromise: Promise<void> | undefined

  constructor(channel: MessageChannel, child: ChildProcessHandle, sessionID: string, checkpointPath: string) {
    this.#channel = channel
    this.#child = child
    this.#sessionID = sessionID
    this.#checkpointPath = checkpointPath
  }

  async resumeCursor() {
    return readCheckpoint(this.#checkpointPath, this.#sessionID)
  }

  async subscribe(after?: Cursor) {
    if (this.#closed || this.#pending.length > 0) throw fail("subscription", "cannot start a page with pending ACKs")
    const checkpoint = await this.resumeCursor()
    if (after && existsSync(this.#checkpointPath) && !sameCursor(after, checkpoint)) {
      throw fail("subscription", "requested cursor differs from the durable acknowledged cursor")
    }
    after ??= checkpoint
    if (after.ownerKind !== "session" || after.ownerId !== this.#sessionID) {
      throw fail("subscription", "cursor is outside the configured Session")
    }
    if (this.#lastCursor && !sameCursor(after, this.#lastCursor)) {
      throw fail("subscription", "resume cursor differs from the last acknowledged cursor")
    }
    await this.#channel.send({
      kind: "subscribe",
      subscriptionId: this.subscriptionId,
      ownerKind: "session",
      ownerId: this.#sessionID,
      after,
    })
    this.#lastCursor ??= after
    this.#lastDelivered = after
    this.#subscribed = true
  }

  async receive(): Promise<ServerMessage> {
    if (!this.#subscribed || this.#closed) throw fail("subscription", "no active subscription")
    const message = decodeServerMessage(await this.#channel.receive())
    if (message.subscriptionId !== this.subscriptionId) throw fail("protocol", "message belongs to another subscription")
    if (message.kind === "event") {
      if (message.cursor.ownerKind !== "session" || message.cursor.ownerId !== this.#sessionID) {
        throw fail("protocol", "event is outside the configured Session")
      }
      if (this.#pending.length >= 64) throw fail("backpressure", "server exceeded the 64-event delivery window")
      const prior = this.#lastDelivered ?? this.#lastCursor
      if (!prior || BigInt(message.cursor.seq) !== BigInt(prior.seq) + 1n) {
        throw fail("protocol", "event cursor is not the exact next sequence")
      }
      this.#lastDelivered = message.cursor
      this.#pending.push(message)
      return message
    }
    if (message.kind === "page_end") {
      if (this.#pending.length > 0 || !this.#lastCursor || !sameCursor(message.through, this.#lastCursor)) {
        throw fail("protocol", "page ended before contiguous acknowledgments")
      }
      writeCheckpoint(this.#checkpointPath, message.through)
      return message
    }
    this.#closed = true
    return message
  }

  async ack(event: SessionEvent) {
    const first = this.#pending[0]
    if (!first || !sameCursor(first.cursor, event.cursor) || event.subscriptionId !== this.subscriptionId) {
      throw fail("ack", "ACK must match the oldest delivered event for this subscription")
    }
    await this.#channel.send({ kind: "ack", subscriptionId: this.subscriptionId, through: event.cursor })
    this.#pending.shift()
    this.#lastCursor = event.cursor
  }

  async unsubscribe() {
    if (this.#closed) {
      await this.#waitForChildExit()
      return
    }
    if (this.#subscribed && this.#pending.length > 0) throw fail("shutdown", "cannot unsubscribe with unacknowledged events")
    if (this.#subscribed) {
      await this.#channel.send({ kind: "unsubscribe", subscriptionId: this.subscriptionId })
    }
    this.#closed = true
    this.#channel.end()
    await this.#waitForChildExit()
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopPromise = (this.#closed ? this.#waitForChildExit() : this.unsubscribe()).catch(async () => {
      this.#channel.destroy()
      await this.#terminateChild()
    })
    return this.#stopPromise
  }

  async #waitForChildExit() {
    const exit = Effect.runPromise(this.#child.exitCode).then(() => true, () => true)
    const exited = await Promise.race([exit, new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500))])
    if (exited) return
    await this.#terminateChild()
  }

  async #terminateChild() {
    await Effect.runPromise(this.#child.kill({ killSignal: "SIGTERM", forceKillAfter: 1_500 })).catch(() => undefined)
    const exited = await Promise.race([
      Effect.runPromise(this.#child.exitCode).then(() => true, () => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
    ])
    if (!exited) await Effect.runPromise(this.#child.kill({ killSignal: "SIGKILL" })).catch(() => undefined)
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const open = Effect.fn("SessionSupervisor.open")(function* (options: OpenOptions) {
      if (!options.binary.startsWith("/") || !options.source.startsWith("/")) {
        return yield* Effect.fail(fail("configuration", "binary and source paths must be absolute"))
      }
      if (!/^ses_[a-zA-Z0-9_-]{1,128}$/.test(options.sessionID)) {
        return yield* Effect.fail(fail("configuration", "Session ID is invalid"))
      }
      const stateDirectory = options.stateDirectory
      if (!stateDirectory.startsWith("/")) {
        return yield* Effect.fail(fail("configuration", "state directory must be absolute"))
      }
      try {
        mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
      } catch {
        return yield* Effect.fail(fail("configuration", "cannot create supervisor state directory"))
      }
      let binary: string
      try {
        binary = realpathSync(options.binary)
        realpathSync(options.source)
      } catch {
        return yield* Effect.fail(fail("configuration", "binary or OpenCode source path is unavailable"))
      }
      try {
        validateStateDirectory(stateDirectory)
      } catch (error) {
        return yield* Effect.fail(error instanceof SessionSupervisorError ? error : fail("configuration", "state path is unsafe"))
      }
      const nonce = randomUUID()
      const incarnation = randomUUID()
      const socketPath = join(stateDirectory, `session-${nonce}.sock`)
      try {
        validateSocketPath(socketPath)
      } catch (error) {
        return yield* Effect.fail(error instanceof SessionSupervisorError ? error : fail("configuration", "socket path is unsafe"))
      }
      const args = [
        `--source=${realpathSync(options.source)}`,
        `--state-dir=${stateDirectory}`,
        `--socket=${socketPath}`,
        `--host-exe=${realpathSync(globalThis.process.execPath)}`,
        `--session=${options.sessionID}`,
        `--nonce=${nonce}`,
        `--incarnation=${incarnation}`,
      ]
      const child = yield* appProcess.spawn(
        ChildProcess.make(binary, args, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          extendEnv: false,
        }),
      ).pipe(Effect.mapError((error) => fail("spawn", error.message)))
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: (signal) => establishChannel(options, child, signal, nonce, incarnation, socketPath),
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("startup", "host handshake failed"),
        }).pipe(Effect.tapError(() => child.kill().pipe(Effect.ignore))),
        (value) => Effect.promise(() => value.stop()),
      )
      return client
    })
    return Service.of({ open })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [AppProcess.node] })

export const SessionSupervisor = { Service, node }
