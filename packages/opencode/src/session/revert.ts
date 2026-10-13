import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "./session"
import { Database } from "@opencode-ai/core/database/database"
import type { PatchOperation } from "@opencode-ai/core/session/supervisor"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { Hash } from "@opencode-ai/core/util/hash"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { Snapshot } from "../snapshot"
import { SessionSummary } from "./summary"
import { SessionRunState } from "./run-state"
import { SessionID, MessageID, PartID } from "./schema"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>
export class FileChangesUnavailableError extends Schema.TaggedErrorClass<FileChangesUnavailableError>()(
  "SessionRevert.FileChangesUnavailableError",
  { message: Schema.String },
) {}

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, FileChangesUnavailableError | Session.BusyError>
  readonly unrevert: (input: {
    sessionID: SessionID
  }) => Effect.Effect<Session.Info, FileChangesUnavailableError | Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const supervisor = yield* SessionSupervisor.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service

    const runPatch = Effect.fn("SessionRevert.runPatch")(function* (
      session: Session.Info,
      operations: PatchOperation[],
    ) {
      if (!operations.length) return
      const turnContextDigest = `sha256:${Hash.sha256(
        JSON.stringify({
          action: "session.revert",
          sessionID: session.id,
          workspaceRoot: session.directory,
          operations,
        }),
      )}`
      yield* supervisor
        .runPatch({
          sessionID: session.id,
          source: database.path,
          workspaceRoot: session.directory,
          turnContextDigest,
          operations,
          authorize: async () => {},
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new FileChangesUnavailableError({
                message: error.message,
              }),
          ),
        )
    })

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      return yield* state.withExecutionOwner(
        input.sessionID,
        Effect.gen(function* () {
          const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          let rev: Session.Info["revert"]
          let lastUser: SessionV1.User | undefined
          const patches: Snapshot.Patch[] = []
          for (const msg of all) {
            if (msg.info.role === "user") lastUser = msg.info
            const remaining: SessionV1.Part[] = []
            for (const part of msg.parts) {
              if (rev) {
                if (part.type === "patch") patches.push(part)
                continue
              }
              if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
                const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
                rev = {
                  messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                  partID,
                }
              }
              remaining.push(part)
            }
          }
          if (!rev) return session

          if (session.revert?.snapshot && !session.revert.files) {
            return yield* new FileChangesUnavailableError({
              message: "Cannot safely replace this revert because its persisted touched-file list is missing.",
            })
          }
          const touched = new Set<string>(session.revert?.files ?? [])
          for (const patch of patches) for (const file of patch.files) touched.add(file)
          const files = [...touched]
          const current = yield* snap.track()
          const snapshot = session.revert?.snapshot ?? current
          if (files.length > 0 && (!snapshot || !current)) {
            return yield* new FileChangesUnavailableError({
              message: "Cannot safely revert files without both current and restore snapshots.",
            })
          }
          const desired = new Map<string, Snapshot.TreeFile | undefined>()

          if (session.revert?.snapshot && session.revert.files?.length) {
            for (const file of session.revert.files) desired.set(file, undefined)
            const base = yield* snap
              .tree(session.revert.snapshot, session.revert.files)
              .pipe(Effect.mapError((error) => new FileChangesUnavailableError({ message: error.message })))
            for (const file of base) desired.set(file.path, file)
          }
          const selected = new Set<string>()
          for (const patch of patches) {
            const paths: string[] = []
            for (const file of patch.files) {
              if (selected.has(file)) continue
              selected.add(file)
              paths.push(file)
              desired.set(file, undefined)
            }
            const tree = yield* snap
              .tree(patch.hash, paths)
              .pipe(Effect.mapError((error) => new FileChangesUnavailableError({ message: error.message })))
            for (const file of tree) desired.set(file.path, file)
          }

          const before =
            current && files.length
              ? yield* snap
                  .tree(current, files)
                  .pipe(Effect.mapError((error) => new FileChangesUnavailableError({ message: error.message })))
              : []
          const existing = new Map(before.map((file) => [file.path, file]))
          const operations: PatchOperation[] = []
          for (const file of files) {
            const prior = existing.get(file)
            const next = desired.get(file)
            if (prior?.contentBase64 === next?.contentBase64 && prior?.executable === next?.executable) continue
            if (next) {
              operations.push({
                operation: "write",
                path: file,
                expectedBeforeBase64: prior?.contentBase64 ?? null,
                contentBase64: next.contentBase64,
                executable: next.executable,
              })
            } else if (prior) {
              operations.push({
                operation: "delete",
                path: file,
                expectedBeforeBase64: prior.contentBase64,
              })
            }
          }
          yield* runPatch(session, operations)

          rev.snapshot = snapshot
          rev.files = files
          if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
          const index = all.findIndex((msg) => msg.info.id === rev.messageID)
          const range = index < 0 ? [] : all.slice(index)
          const diffs = yield* summary.computeDiff({ messages: range })
          yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
          yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
          yield* sessions.setRevert({
            sessionID: input.sessionID,
            revert: rev,
            summary: {
              additions: diffs.reduce((sum, item) => sum + item.additions, 0),
              deletions: diffs.reduce((sum, item) => sum + item.deletions, 0),
              files: diffs.length,
            },
          })
          return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        }),
      )
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      yield* state.assertNotBusy(input.sessionID)
      return yield* state.withExecutionOwner(
        input.sessionID,
        Effect.gen(function* () {
          yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          if (!session.revert) return session
          const snapshot = session.revert.snapshot
          if (snapshot && !session.revert.files) {
            return yield* new FileChangesUnavailableError({
              message: "Cannot safely unrevert this session because its persisted touched-file list is missing.",
            })
          }
          const files = session.revert.files ?? []
          if (files.length > 0 && !snapshot) {
            return yield* new FileChangesUnavailableError({
              message: "Cannot safely unrevert files without a saved restore snapshot.",
            })
          }
          if (snapshot && files.length) {
            const current = yield* snap.track()
            if (!current) {
              return yield* new FileChangesUnavailableError({
                message: "Cannot safely unrevert files without a current workspace snapshot.",
              })
            }
            const before = yield* snap
              .tree(current, files)
              .pipe(Effect.mapError((error) => new FileChangesUnavailableError({ message: error.message })))
            const restore = yield* snap
              .tree(snapshot, files)
              .pipe(Effect.mapError((error) => new FileChangesUnavailableError({ message: error.message })))
            const existing = new Map(before.map((file) => [file.path, file]))
            const target = new Map(restore.map((file) => [file.path, file]))
            const operations: PatchOperation[] = []
            for (const file of files) {
              const prior = existing.get(file)
              const next = target.get(file)
              if (prior?.contentBase64 === next?.contentBase64 && prior?.executable === next?.executable) continue
              if (next) {
                operations.push({
                  operation: "write",
                  path: file,
                  expectedBeforeBase64: prior?.contentBase64 ?? null,
                  contentBase64: next.contentBase64,
                  executable: next.executable,
                })
              } else if (prior) {
                operations.push({
                  operation: "delete",
                  path: file,
                  expectedBeforeBase64: prior.contentBase64,
                })
              }
            }
            yield* runPatch(session, operations)
          }
          yield* sessions.clearRevert(input.sessionID)
          return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        }),
      )
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const index = msgs.findIndex((msg) => msg.info.id === messageID)
      const target = index < 0 ? undefined : msgs[index]
      const remove = index < 0 ? [] : msgs.slice(index + (session.revert.partID ? 1 : 0))
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Snapshot.node,
    Storage.node,
    EventV2Bridge.node,
    SessionSummary.node,
    SessionRunState.node,
    Database.node,
    SessionSupervisor.node,
  ],
})

export * as SessionRevert from "./revert"
