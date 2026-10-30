import { describe, expect } from "bun:test"
import { Cause, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@horizoncode/core/database/database"
import { EventTable } from "@horizoncode/core/event/sql"
import { eq } from "drizzle-orm"
import { SessionTable } from "@horizoncode/core/session/sql"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { EventV2 } from "@horizoncode/core/event"
import { Location } from "@horizoncode/core/location"
import { ProjectV2 } from "@horizoncode/core/project"
import { AbsolutePath } from "@horizoncode/core/schema"
import { ModelV2 } from "@horizoncode/core/model"
import { ProviderV2 } from "@horizoncode/core/provider"
import { SessionV2 } from "@horizoncode/core/session"
import { SessionEvent } from "@horizoncode/core/session/event"
import { SessionMessage } from "@horizoncode/core/session/message"
import { SessionProjector } from "@horizoncode/core/session/projector"
import { SessionExecution } from "@horizoncode/core/session/execution"
import { SessionStore } from "@horizoncode/core/session/store"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import {
  ImportConflictError,
  SessionTransfer,
  TransferError,
  digestTransferDataV1,
} from "@horizoncode/core/session/transfer"
import { testEffect } from "./lib/effect"

/**
 * P3-11 session export/import (REL-N / §42 SRC-029).
 *
 * Bounds exercised here: own-JSON only (no URL/HTTP import), sanitized
 * digest-bound export, two-phase preview → commit, 409 on existing conflict,
 * no credential copy (provider/auth material and horizonPrincipalOwner never
 * survive an export or enter an import), and import creating a NEW Session only
 * through the Core create path with a single authenticated owner.
 */

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      SessionTransfer.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const serverAuth = Layer.succeed(TrustedPrincipalContext, {
  principal: { kind: "server_auth" as const, subject: "transfer-test" },
})
const hostOs = Layer.succeed(TrustedPrincipalContext, { principal: { kind: "host_os" as const } })

const sessionID = (suffix: string) => SessionV2.ID.make(`ses_transfer_${suffix}`)

const seedSynthetic = (id: SessionV2.ID, texts: readonly string[]) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    let stamp = 1_000
    for (const text of texts) {
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID: id,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(stamp),
        text,
      })
      stamp += 1_000
    }
  })

const createOwned = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return yield* session.create({ id, location })
  }).pipe(Effect.provide(serverAuth))

const transferExport = (id: SessionV2.ID, sanitize?: boolean) =>
  Effect.gen(function* () {
    const transfer = yield* SessionTransfer.Service
    return yield* transfer.export({ sessionID: id, ...(sanitize === undefined ? {} : { sanitize }) })
  })

describe("SessionTransfer.export", () => {
  it.effect("produces a digest-bound sanitized snapshot without horizonPrincipalOwner or credentials", () =>
    Effect.gen(function* () {
      const id = sessionID("export")
      yield* createOwned(id)
      yield* seedSynthetic(id, ["synthetic context"])
      const raw = yield* transferExport(id, false)
      expect(raw.redaction).toBe("none")
      expect(raw.messageCount).toBe(1)
      expect(raw.data.messages).toHaveLength(1)
      expect(digestTransferDataV1(raw.data)).toBe(raw.dataDigest)
      // The create path stamped the authenticated owner into the durable row …
      const { db } = yield* Database.Service
      const row = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
        .pipe(Effect.orDie)
      expect(row?.metadata?.horizonPrincipalOwner).toEqual({ kind: "server_auth", subject: "transfer-test" })
      // … while the transfer payload structurally cannot carry it (SessionV2.Info
      // has no metadata field), and a sanitized export never contains it.
      expect(JSON.stringify(raw.data)).not.toContain("horizonPrincipalOwner")
      const clean = yield* transferExport(id, true)
      expect(clean.redaction).toBe("sanitized")
      expect(JSON.stringify(clean.data)).not.toContain("horizonPrincipalOwner")
      expect(clean.data.info.title).toMatch(/^\[redacted:/)
      expect(digestTransferDataV1(clean.data)).toBe(clean.dataDigest)
    }),
  )

  it.effect("sanitizes token-bearing assistant tool output and message metadata", () =>
    Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const id = sessionID("sanitize")
      const created = yield* createOwned(id)
      const assistant = SessionMessage.Assistant.make({
        id: SessionMessage.ID.create(),
        type: "assistant",
        agent: "build",
        model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        time: { created: DateTime.makeUnsafe(2_000) },
        content: [
          {
            type: "tool",
            id: "prt_tool_import",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "curl -H 'Authorization: Bearer sekrit-token-value'" },
              structured: {},
              content: [{ type: "text", text: "Bearer sekrit-token-value" }],
            },
            time: { created: DateTime.makeUnsafe(2_000) },
          },
        ],
      })
      const snapshot = yield* transfer.export({ sessionID: created.id, sanitize: false })
      // sanitizeData operates on the decoded shape; decode the wire snapshot first.
      const typed = Schema.decodeUnknownSync(SessionTransfer.TransferData)(snapshot.data)
      const withSecret = { ...typed, messages: [...typed.messages, assistant] }
      const sanitized = yield* Effect.try({
        try: () => SessionTransfer.sanitizeData(withSecret),
        catch: () => new Error("sanitize failed"),
      })
      const tool = sanitized.messages.find((message) => message.type === "assistant")
      expect(JSON.stringify(tool)).not.toContain("sekrit-token-value")
      expect(JSON.stringify(sanitized.messages)).not.toContain("horizonPrincipalOwner")
    }),
  )
})

describe("SessionTransfer.previewImport", () => {
  it.effect("validates a digest-bound snapshot without writing anything", () =>
    Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const session = yield* SessionV2.Service
      const source = sessionID("preview_source")
      yield* createOwned(source)
      yield* seedSynthetic(source, ["first", "second"])
      const snapshot = yield* transfer.export({ sessionID: source, sanitize: true })

      const before = yield* session.list()
      const freshID = sessionID("preview_target")
      const data = { ...snapshot.data, info: { ...snapshot.data.info, id: freshID } }
      const preview = yield* transfer.previewImport({ data })

      expect(preview.sessionID).toBe(freshID)
      expect(preview.dataDigest).toBe(digestTransferDataV1(data))
      expect(preview.conflict).toBe(false)
      expect(preview.messageCount).toBe(2)

      // Phase one must never create the Session or any durable row.
      const after = yield* session.list()
      expect(after).toHaveLength(before.length)
      const missing = yield* session.get(freshID).pipe(Effect.exit)
      expect(missing._tag).toBe("Failure")
    }),
  )

  it.effect("reports a conflict for an existing Session identity", () =>
    Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const id = sessionID("conflict")
      yield* createOwned(id)
      const snapshot = yield* transfer.export({ sessionID: id, sanitize: true })
      const preview = yield* transfer.previewImport({ data: snapshot.data })
      expect(preview.conflict).toBe(true)
      expect(preview.sessionID).toBe(id)
    }),
  )

  it.effect("rejects credential material and ownership copies in incoming data", () =>
    Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const id = sessionID("dirty")
      yield* createOwned(id)
      const snapshot = yield* transfer.export({ sessionID: id, sanitize: false })
      const dirty = yield* Effect.exit(
        transfer.previewImport({
          data: {
            ...snapshot.data,
            info: { ...snapshot.data.info, metadata: { apikey: "sk-live-abcdefghijklmnop" } },
          },
        }),
      )
      expect(dirty._tag).toBe("Failure")
      const ownerCopy = yield* Effect.exit(
        transfer.previewImport({
          data: {
            ...snapshot.data,
            info: {
              ...snapshot.data.info,
              metadata: { horizonPrincipalOwner: { kind: "server_auth", subject: "someone-else" } },
            },
          },
        }),
      )
      expect(ownerCopy._tag).toBe("Failure")

      // Schema-valid data still refuses token-bearing tool output (sensitive_material).
      const tokenExit = yield* Effect.exit(
        transfer.previewImport({
          data: {
            ...snapshot.data,
            messages: [
              ...snapshot.data.messages,
              {
                type: "assistant",
                id: "msg_dirty_token",
                agent: "build",
                model: { id: "model", providerID: "provider" },
                time: { created: 2_000 },
                content: [
                  {
                    type: "tool",
                    id: "prt_dirty_token",
                    name: "bash",
                    state: {
                      status: "completed",
                      input: {},
                      structured: {},
                      content: [{ type: "text", text: "Bearer sekrit-token-value" }],
                    },
                    time: { created: 2_000 },
                  },
                ],
              },
            ],
          },
        }),
      )
      expect(tokenExit._tag).toBe("Failure")
      if (tokenExit._tag === "Failure") {
        const error = Cause.squash(tokenExit.cause)
        expect(error).toBeInstanceOf(TransferError)
        if (error instanceof TransferError) expect(error.code).toBe("sensitive_material")
      }
    }),
  )
})

describe("SessionTransfer.commitImport", () => {
  it.effect("fails closed on a digest mismatch", () =>
    Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const id = sessionID("digest")
      yield* createOwned(id)
      const snapshot = yield* transfer.export({ sessionID: id, sanitize: true })
      const fresh = sessionID("digest_target")
      const data = { ...snapshot.data, info: { ...snapshot.data.info, id: fresh }, messages: [] }
      const exit = yield* Effect.exit(
        transfer.commitImport({ data, dataDigest: snapshot.dataDigest, location }),
      )
      expect(exit._tag).toBe("Failure")
      const missing = yield* sessionExit(fresh)
      expect(missing._tag).toBe("Failure")
    }),
  )

  it.effect("answers409 for an existing Session identity", () =>
    Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const id = sessionID("exists")
      yield* createOwned(id)
      const snapshot = yield* transfer.export({ sessionID: id, sanitize: true })
      const exit = yield* Effect.exit(
        transfer.commitImport({ data: snapshot.data, dataDigest: snapshot.dataDigest, location }),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") throw new Error("expected commitImport to report the existing Session")
      expect(Cause.squash(exit.cause)).toBeInstanceOf(ImportConflictError)
    }),
  )

  it.effect("requires an authenticated ServerAuth principal", () =>
    Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const source = sessionID("principal")
      yield* createOwned(source)
      const snapshot = yield* transfer.export({ sessionID: source, sanitize: true })
      const fresh = sessionID("principal_target")
      const data = { ...snapshot.data, info: { ...snapshot.data.info, id: fresh }, messages: [] }
      const exit = yield* Effect.exit(
        transfer
          .commitImport({ data, dataDigest: digestTransferDataV1(data), location })
          .pipe(Effect.provide(hostOs)),
      )
      expect(exit._tag).toBe("Failure")
      const missing = yield* sessionExit(fresh)
      expect(missing._tag).toBe("Failure")
    }),
  )

  it.effect("creates a NEW Session through the create path with one authenticated owner", () =>
    Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const session = yield* SessionV2.Service
      const source = sessionID("commit_source")
      yield* createOwned(source)
      const snapshot = yield* transfer.export({ sessionID: source, sanitize: true })
      const fresh = sessionID("commit_target")
      const data = { ...snapshot.data, info: { ...snapshot.data.info, id: fresh }, messages: [] }

      const committed = yield* transfer
        .commitImport({ data, dataDigest: digestTransferDataV1(data), location })
        .pipe(Effect.provide(serverAuth))
      expect(committed.sessionID).toBe(fresh)

      const created = yield* session.get(fresh)
      expect(created.id).toBe(fresh)
      // Ownership is asserted on the durable row: SessionV2.Info intentionally
      // has no metadata field, so `horizonPrincipalOwner` can never leak into
      // transfer data — one owner, stamped by the create path itself.
      const { db } = yield* Database.Service
      const row = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, fresh))
        .get()
        .pipe(Effect.orDie)
      expect(row?.metadata?.horizonPrincipalOwner).toEqual({
        kind: "server_auth",
        subject: "transfer-test",
      })
      // Never a merge: the source Session still exists separately.
      const sourceRow = yield* session.get(source)
      expect(sourceRow.id).toBe(source)
    }),
  )

  it.effect("restores settled messages through the canonical append path in one atomic import", () =>
    Effect.gen(function* () {
      const transfer = yield* SessionTransfer.Service
      const session = yield* SessionV2.Service
      const source = sessionID("restore_source")
      yield* createOwned(source)
      yield* seedSynthetic(source, ["first restored", "second restored"])
      const sourceContext = yield* session.context(source)
      // Content fidelity is the subject here; the sanitizer is covered above.
      const snapshot = yield* transfer.export({ sessionID: source, sanitize: false })
      const fresh = sessionID("restore_target")
      const data = { ...snapshot.data, info: { ...snapshot.data.info, id: fresh } }

      const committed = yield* transfer
        .commitImport({ data, dataDigest: digestTransferDataV1(data), location })
        .pipe(Effect.provide(serverAuth))
      expect(committed.sessionID).toBe(fresh)

      const context = yield* session.context(fresh)
      expect(context.map((message) => (message.type === "synthetic" ? message.text : message.type))).toEqual([
        "first restored",
        "second restored",
      ])
      // Message identity is canonical for the NEW Session: no durable ID is
      // reused from the source (they are globally unique), and synthetic rows
      // are rebound to the imported Session.
      expect(context.map((message) => message.id)).not.toEqual(sourceContext.map((message) => message.id))
      for (const message of context) {
        if (message.type === "synthetic") expect(message.sessionID).toBe(fresh)
      }

      // Only the dedicated import event is replayed; never a live prompt/turn
      // stream event that could reconstruct dispatch authority.
      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, fresh))
        .all()
        .pipe(Effect.orDie)
      const types = rows.map((row) => row.type)
      expect(types.filter((type) => type.startsWith("session.import.restored."))).toHaveLength(2)
      expect(types.some((type) => type.startsWith("session.next.prompted."))).toBe(false)
      expect(types.some((type) => type.startsWith("session.next.step."))).toBe(false)

      // Never a merge: the source Session and its messages still exist.
      expect((yield* session.context(source)).map((message) => message.id)).toEqual(
        sourceContext.map((message) => message.id),
      )
    }),
  )
})

const sessionExit = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return yield* session.get(id)
  }).pipe(Effect.exit)
