/**
 * Session export/import transfer seam (REL-N / §42 SRC-029).
 *
 * Provenance: REUSE + ADAPTER of the OpenCode transfer algorithm inspected at
 * candidate revision `43868389223f3553c6786c2f1cfa70a657f8a8bf` (MIT,
 * Copyright (c) 2025 opencode; recorded in §42 SRC-029). Only the sanitizer
 * shape and the digest-bound two-phase preview→commit flow are adapted; every
 * callee is a HorizonCore owner (Session create path, Core Session store).
 *
 * Bounds enforced in code:
 * - own-JSON only: `data` is decoded from a local schema — there is no URL/HTTP
 *   import path in V1;
 * - no credential copy: incoming data may not carry `horizonPrincipalOwner`,
 *   provider/auth material or token-bearing text — preview and commit fail
 *   closed before any write;
 * - one owner per Session: commit requires an authenticated ServerAuth
 *   principal and creates the Session through the Core create path, which
 *   stamps `horizonPrincipalOwner`; no second Session writer and no merge —
 *   an existing identity answers 409 (`ImportConflictError`);
 * - two phase: `previewImport` never writes; `commitImport` re-validates the
 *   caller's exact `dataDigest` before anything else happens;
 * - message restoration is atomic: the canonical Session create path and one
 *   durable `session.import.restored` event per message commit in a single
 *   transaction; any failure rolls back the whole import. Imported messages
 *   receive new canonical IDs and never replay live `session.next.*` events, so
 *   restored history cannot mint provider, tool or effect authority.
 */
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { Location } from "../location"
import { SessionEvent } from "./event"
import {
  NotFoundError,
  Service as SessionService,
  node as sessionNode,
  type Interface as SessionInterface,
} from "../session"
import { TrustedPrincipalContext } from "../trusted-principal"
import type { ToolContent } from "@horizoncode/schema/llm"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

const MAX_TRANSFER_MESSAGES = 10_000
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024
const MAX_CANONICAL_NODES = 200_000
const MAX_CANONICAL_DEPTH = 32

export class TransferError extends Schema.TaggedErrorClass<TransferError>()("SessionTransferError", {
  operation: Schema.String,
  code: Schema.Literals([
    "invalid_data",
    "out_of_bounds",
    "sensitive_material",
    "digest_mismatch",
    "authorization",
    "projection_unavailable",
  ]),
  reason: Schema.String,
}) {}

/** 409: the target Session identity already exists — import never merges. */
export class ImportConflictError extends Schema.TaggedErrorClass<ImportConflictError>()(
  "SessionTransfer.ImportConflictError",
  { sessionID: SessionSchema.ID },
) {}

export const TransferData = Schema.Struct({
  info: SessionSchema.Info,
  messages: Schema.Array(SessionMessage.Message),
}).annotate({ identifier: "SessionTransfer.DataV1" })
export type TransferData = Schema.Schema.Type<typeof TransferData>

export type TransferDataWire = (typeof TransferData)["Encoded"]

export type ExportSnapshotV1 = {
  readonly schemaVersion: 1
  readonly redaction: "none" | "sanitized"
  readonly messageCount: number
  /** `blake3:` digest over the canonical JSON of `data` (wire form). */
  readonly dataDigest: string
  readonly data: TransferDataWire
}

export type ImportPreviewV1 = {
  readonly schemaVersion: 1
  readonly sessionID: SessionSchema.ID
  readonly messageCount: number
  readonly dataDigest: string
  readonly conflict: boolean
}

/** Bounded canonical JSON: sorted keys, no undefined, explicit depth/node caps. */
function canonicalJson(value: unknown, nodes = { count: 0 }, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new RangeError("transfer data exceeds the canonical depth bound")
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("transfer data contains a non-finite number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, nodes, depth + 1)).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => {
        nodes.count += 1
        if (nodes.count > MAX_CANONICAL_NODES) throw new RangeError("transfer data exceeds the canonical node bound")
        return `${JSON.stringify(key)}:${canonicalJson(child, nodes, depth + 1)}`
      })
    return `{${entries.join(",")}}`
  }
  throw new TypeError("transfer data contains an unsupported value")
}

/** `blake3:` digest over `horizon.session-transfer.v1\0` + canonical JSON. */
export function digestTransferDataV1(data: unknown): string {
  const canonical = canonicalJson(data)
  const encoded = new TextEncoder().encode(canonical)
  if (encoded.byteLength > MAX_TRANSFER_BYTES) throw new RangeError("transfer data exceeds the byte bound")
  const prefix = new TextEncoder().encode("horizon.session-transfer.v1\0")
  const preimage = new Uint8Array(prefix.byteLength + encoded.byteLength)
  preimage.set(prefix, 0)
  preimage.set(encoded, prefix.byteLength)
  return `blake3:${bytesToHex(blake3(preimage))}`
}

function redact(kind: string, id: string, value: string): string {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

/** Extensions beyond upstream: never let ownership or credential-class material travel. */
const SENSITIVE_KEY = /^(?:horizonPrincipalOwner|.*(?:api[_-]?key|authorization|credential|secret|passwd|password|access[_-]?token|refresh[_-]?token|private[_-]?key).*)$/i
const TOKEN_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

function sensitiveFindings(data: TransferData): string[] {
  const findings: string[] = []
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > MAX_CANONICAL_DEPTH) return
    if (typeof value === "string") {
      for (const pattern of TOKEN_PATTERNS) {
        if (pattern.test(value)) findings.push(`credential-shaped value at ${path}`)
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1))
      return
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(key)) findings.push(`sensitive field "${key}" at ${path}`)
        visit(child, `${path}.${key}`, depth + 1)
      }
    }
  }
  visit(data.info, "info", 0)
  data.messages.forEach((message, index) => visit(message, `messages[${index}]`, 0))
  return findings
}

/** Redact transcript/title/metadata the way the sanitized export contract requires. */
export function sanitizeData(data: TransferData): TransferData {
  // The session row's `metadata` (which is where `horizonPrincipalOwner` lives)
  // is deliberately outside `SessionV2.Info`, so ownership can never enter the
  // transfer payload; `sensitiveFindings` still rejects it if a producer adds it.
  return {
    info: { ...data.info, title: redact("session-title", data.info.id, data.info.title) },
    messages: data.messages.map((message): SessionMessage.Message => {
      const meta = { redacted: `message-metadata:${message.id}` }
      if (message.type === "user") {
        // Rebuilt from exact fields: file/agent attachments (which can embed
        // local content) are omitted instead of travelling with the transcript.
        return {
          id: message.id,
          time: message.time,
          type: "user",
          metadata: meta,
          text: redact("text", message.id, message.text),
        }
      }
      if (message.type === "assistant") {
        return {
          ...message,
          metadata: meta,
          content: message.content.map((content) => {
            if (content.type === "text") return { ...content, text: redact("text", message.id, content.text) }
            if (content.type === "reasoning") {
              return { ...content, text: redact("reasoning", message.id, content.text) }
            }
            const state = content.state
            const cleanItems = (items: readonly ToolContent[]): ToolContent[] =>
              items.map((item): ToolContent =>
                item.type === "text"
                  ? { ...item, text: redact("tool-output", message.id, item.text) }
                  : { ...item, uri: redact("tool-file-uri", message.id, item.uri) },
              )
            if (state.status === "pending") {
              return { ...content, state: { ...state, input: redact("tool-input", message.id, state.input) } }
            }
            const base = {
              input: { redacted: `tool-input:${message.id}` },
              structured: { redacted: `tool-structured:${message.id}` },
            } as const
            if (state.status === "running") {
              return { ...content, state: { ...state, ...base, content: cleanItems(state.content) } }
            }
            if (state.status === "completed") {
              return { ...content, state: { ...state, ...base, content: cleanItems(state.content) } }
            }
            return {
              ...content,
              state: {
                ...state,
                ...base,
                content: cleanItems(state.content),
                error: { ...state.error, message: redact("tool-error", message.id, state.error.message) },
              },
            }
          }),
        }
      }
      if (message.type === "shell") {
        return {
          ...message,
          metadata: meta,
          command: redact("shell-command", message.id, message.command),
          output: redact("shell-output", message.id, message.output),
        }
      }
      if (message.type === "compaction") {
        return { ...message, metadata: meta, summary: redact("compaction-summary", message.id, message.summary) }
      }
      if (message.type === "synthetic") return { ...message, metadata: meta, text: redact("synthetic-text", message.id, message.text) }
      if (message.type === "system") return { ...message, metadata: meta, text: redact("system-text", message.id, message.text) }
      return { ...message, metadata: meta }
    }),
  }
}

function isSettled(message: SessionMessage.Message): boolean {
  if (message.type === "assistant") return message.time.completed !== undefined
  // Local Shell messages carry no status; a shell without a completion
  // timestamp is still in flight and must not be exported.
  if (message.type === "shell") return message.time.completed !== undefined
  return true
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) continue
      out[key] = pruneUndefined(child)
    }
    return out
  }
  return value
}

function decodeTransferData(input: unknown): TransferData {
  return Schema.decodeUnknownSync(TransferData, { onExcessProperty: "error" })(input)
}

/** Shared phase-one validation: shape → bounds → sensitive material → digest. */
function validateTransfer(input: {
  readonly operation: string
  readonly data: unknown
  readonly dataDigest?: string
}): { data: TransferData; dataDigest: string } {
  const wire = pruneUndefined(input.data)
  let data: TransferData
  try {
    data = decodeTransferData(wire)
  } catch (error) {
    throw new TransferError({
      operation: input.operation,
      code: "invalid_data",
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (data.messages.length > MAX_TRANSFER_MESSAGES) {
    throw new TransferError({
      operation: input.operation,
      code: "out_of_bounds",
      reason: `transfer carries ${data.messages.length} messages (limit ${MAX_TRANSFER_MESSAGES})`,
    })
  }
  const findings = sensitiveFindings(data)
  if (findings.length > 0) {
    throw new TransferError({
      operation: input.operation,
      code: "sensitive_material",
      reason: `transfer refuses credential/ownership material: ${findings.slice(0, 3).join("; ")}`,
    })
  }
  let dataDigest: string
  try {
    dataDigest = digestTransferDataV1(wire)
  } catch (error) {
    throw new TransferError({
      operation: input.operation,
      code: "out_of_bounds",
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (input.dataDigest !== undefined && input.dataDigest !== dataDigest) {
    throw new TransferError({
      operation: input.operation,
      code: "digest_mismatch",
      reason: "the supplied digest does not match the canonical digest of the supplied data",
    })
  }
  return { data, dataDigest }
}

function requireServerAuth(operation: string, subject: string | undefined): void {
  if (!subject) {
    throw new TransferError({
      operation,
      code: "authorization",
      reason: "session import requires an authenticated ServerAuth principal",
    })
  }
}

export interface Interface {
  readonly export: (input: {
    readonly sessionID: SessionSchema.ID
    readonly sanitize?: boolean
  }) => Effect.Effect<ExportSnapshotV1, NotFoundError | MessageDecodeErrorLike | TransferError>
  readonly previewImport: (input: { readonly data: unknown }) => Effect.Effect<ImportPreviewV1, TransferError>
  readonly commitImport: (input: {
    readonly data: unknown
    readonly dataDigest: string
    readonly location: Location.Ref
  }) => Effect.Effect<{ readonly sessionID: SessionSchema.ID }, TransferError | ImportConflictError>
}

// MessageDecodeError lives in the Session error module; re-declared here as a
// local alias so this module's public error union stays explicit.
type MessageDecodeErrorLike = import("./error").MessageDecodeError

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionTransfer") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* SessionService
    // Bind the shared durable projection services at layer construction so the
    // public Service methods stay requirement-free like every other Core
    // service. `SessionService` already depends on both; listing them here keeps
    // the transaction and event publisher on the same client/context.
    const database = yield* Database.Service
    const events = yield* EventV2.Service

    return Service.of({
      export: Effect.fn("SessionTransfer.export")(function* (input) {
        const info = yield* session.get(input.sessionID)
        const messages = (yield* session.messages({ sessionID: input.sessionID, order: "asc" })).filter(isSettled)
        const raw: TransferData = { info, messages }
        const data = input.sanitize ? sanitizeData(raw) : raw
        const wire = Schema.encodeSync(TransferData)(data)
        return {
          schemaVersion: 1,
          redaction: input.sanitize ? ("sanitized" as const) : ("none" as const),
          messageCount: wire.messages.length,
          dataDigest: digestTransferDataV1(wire),
          data: wire,
        }
      }),

      previewImport: Effect.fn("SessionTransfer.previewImport")(function* (input) {
        const { data, dataDigest } = validateTransfer({ operation: "preview", data: input.data })
        const existing = yield* session.get(data.info.id).pipe(Effect.exit)
        return {
          schemaVersion: 1,
          sessionID: data.info.id,
          messageCount: data.messages.length,
          dataDigest,
          conflict: existing._tag === "Success",
        }
      }),

      commitImport: Effect.fn("SessionTransfer.commitImport")(function* (input) {
        const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
        const subject =
          Option.isSome(principal) &&
          principal.value.principal.kind === "server_auth" &&
          principal.value.principal.subject.length > 0 &&
          principal.value.principal.subject.length <= 256
            ? principal.value.principal.subject
            : undefined
        requireServerAuth("commit", subject)

        const { data, dataDigest } = validateTransfer({
          operation: "commit",
          data: input.data,
          dataDigest: input.dataDigest,
        })
        const existing = yield* session.get(data.info.id).pipe(Effect.exit)
        if (existing._tag === "Success") return yield* new ImportConflictError({ sessionID: data.info.id })

        // One atomic import: the canonical Session create path and every
        // restored message event commit in the same transaction. A failure in
        // any message rolls the Session row back too, so import never leaves a
        // partial stand-in Session. Imported history is restored through the
        // canonical durable message event (`session.import.restored`) and the
        // existing projector writer — never by replaying live `session.next.*`.
        const { db } = database
        const imported = db
          .transaction(() =>
            Effect.gen(function* () {
              yield* session.create({
                id: data.info.id,
                location: input.location,
                ...(data.info.agent ? { agent: data.info.agent } : {}),
                ...(data.info.model ? { model: data.info.model } : {}),
              })
              for (const message of data.messages) {
                // Message identities are globally unique in the durable store.
                // An imported Session is a NEW identity, so its messages receive
                // new canonical IDs (and Synthetic rows are rebound to the new
                // Session) instead of colliding with the source installation.
                const restored: SessionMessage.Message = message.type === "synthetic"
                  ? { ...message, id: SessionMessage.ID.create(), sessionID: data.info.id }
                  : { ...message, id: SessionMessage.ID.create() }
                yield* events.publish(
                  SessionEvent.Imported,
                  {
                    sessionID: data.info.id,
                    timestamp: DateTime.makeUnsafe(Date.now()),
                    sourceDigest: dataDigest,
                    message: restored,
                  },
                  { location: input.location },
                )
              }
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (error) =>
              Effect.fail(
                new TransferError({
                  operation: "commit",
                  code: "projection_unavailable",
                  reason: `durable import projection failed and was rolled back: ${error.message}`,
                }),
              ),
            ),
          )
        yield* imported
        return { sessionID: data.info.id }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, sessionNode],
})

export * as SessionTransfer from "./transfer"
