export * as SessionRevert from "./revert"

import { and, asc, eq, gt } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { lstat, open, realpath } from "node:fs/promises"
import type { Stats } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Snapshot } from "../snapshot"
import { Hash } from "../util/hash"
import type { RelativePath } from "../schema"
import { SessionSupervisor, type PatchOperation } from "./supervisor"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

export class FileChangesUnavailableError extends Schema.TaggedErrorClass<FileChangesUnavailableError>()(
  "SessionRevert.FileChangesUnavailableError",
  { message: Schema.String },
) {}

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "Session.MessageNotFoundError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
}

const selectChanges = Effect.fn("SessionRevert.selectChanges")(function* (input: BoundaryInput) {
  const db = (yield* Database.Service).db
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
  const files = new Map<RelativePath, Snapshot.ID>()
  for (const row of rows) {
    const message = yield* decode({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie)
    if (message.type !== "assistant" || !message.snapshot?.start) continue
    for (const file of message.snapshot.files ?? [])
      if (!files.has(file)) files.set(file, Snapshot.ID.make(message.snapshot.start))
  }
  return files
})

export const stage = Effect.fn("SessionRevert.stage")(function* (input: {
  readonly session: SessionSchema.Info
  readonly messageID: SessionMessage.ID
  readonly files?: boolean
}) {
  const snapshot = yield* Snapshot.Service
  const events = yield* EventV2.Service
  const original = input.session.revert?.snapshot
    ? Snapshot.ID.make(input.session.revert.snapshot)
    : yield* snapshot.capture()
  const next = yield* selectChanges({ sessionID: input.session.id, messageID: input.messageID })
  const restore = new Map<RelativePath, Snapshot.ID>()
  if (original) {
    for (const file of input.session.revert?.restoreFiles ??
      input.session.revert?.files?.map((file) => file.path) ??
      [])
      restore.set(file, original)
  }
  if (input.files !== false) for (const [file, tree] of next) restore.set(file, tree)
  if (restore.size) {
    if (!original) {
      return yield* new FileChangesUnavailableError({
        message: "Cannot safely stage file changes without a saved restore snapshot.",
      })
    }
    const plan = yield* snapshot.restorePlan({ files: restore }).pipe(Effect.mapError(unavailable))
    yield* applyGuardedRestore(input.session, plan)
  }
  const paths = Array.from(restore.keys())
  const files = original
    ? yield* snapshot
        .diff({ from: original, to: (yield* snapshot.capture()) ?? original, paths })
        .pipe(Effect.mapError(unavailable))
    : []
  const revert = {
    messageID: input.messageID,
    snapshot: original,
    diff: files
      .map((file) => file.patch)
      .join("")
      .trim(),
    restoreFiles: paths,
  } satisfies SessionSchema.Info["revert"]
  yield* events.publish(SessionEvent.RevertEvent.Staged, {
    sessionID: input.session.id,
    timestamp: yield* DateTime.now,
    revert,
  })
  return revert
})

export const clear = Effect.fn("SessionRevert.clear")(function* (session: SessionSchema.Info) {
  if (!session.revert) return
  const snapshot = yield* Snapshot.Service
  const original = session.revert.snapshot ? Snapshot.ID.make(session.revert.snapshot) : undefined
  if (original) {
    const files = new Map(
      (session.revert.restoreFiles ?? session.revert.files?.map((file) => file.path) ?? []).map(
        (file) => [file, original] as const,
      ),
    )
    if (files.size) {
      const plan = yield* snapshot.restorePlan({ files }).pipe(Effect.mapError(unavailable))
      yield* applyGuardedRestore(session, plan)
    }
  }
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.RevertEvent.Cleared, {
    sessionID: session.id,
    timestamp: yield* DateTime.now,
  })
})

export const commit = Effect.fn("SessionRevert.commit")(function* (session: SessionSchema.Info) {
  if (!session.revert) return
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.RevertEvent.Committed, {
    sessionID: session.id,
    messageID: session.revert.messageID,
    timestamp: yield* DateTime.now,
  })
})

const applyGuardedRestore = Effect.fn("SessionRevert.applyGuardedRestore")(function* (
  session: SessionSchema.Info,
  plan: Snapshot.RestorePlan,
) {
  const database = yield* Database.Service
  const supervisor = yield* SessionSupervisor.Service
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* SessionSupervisor.acquireExecutionOwner(session.id, "core-v2")
      const workspaceRoot = yield* Effect.tryPromise({
        try: () => realpath(session.location.directory),
        catch: unavailable,
      })
      const operations = yield* buildOperations(workspaceRoot, plan)
      if (operations.length === 0) return
      yield* supervisor
        .runPatch({
          sessionID: session.id,
          source: database.path,
          workspaceRoot,
          turnContextDigest: `sha256:${Hash.sha256(JSON.stringify({ capabilityID: "files.patch", sessionID: session.id, workspaceRoot, operations }))}`,
          operations,
          // This API is called by an explicit user action. Rust still evaluates
          // Guard policy and binds approval to this exact operation set.
          authorize: async () => undefined,
        })
        .pipe(Effect.mapError(unavailable))
    }),
  ).pipe(Effect.mapError((error) => (error instanceof FileChangesUnavailableError ? error : unavailable(error))))
})

const buildOperations = Effect.fn("SessionRevert.buildOperations")(function* (
  workspaceRoot: string,
  plan: Snapshot.RestorePlan,
) {
  if (plan.files.length > 64) {
    return yield* Effect.fail(unavailable(new Error("Snapshot restore exceeds the 64-file limit")))
  }
  let totalBytes = 0
  const root = workspaceRoot
  const worktree = yield* Effect.tryPromise({
    try: () => realpath(plan.worktree),
    catch: unavailable,
  })
  const operations: PatchOperation[] = []
  for (const file of plan.files) {
    const target = resolve(worktree, file.path)
    if (!contains(root, target))
      return yield* Effect.fail(unavailable(new Error("Snapshot path is outside the session workspace")))
    const before = yield* readRegularFile(root, target)
    if (file.content === undefined && !before) continue
    if (
      file.content &&
      before &&
      Buffer.compare(Buffer.from(file.content), before.content) === 0 &&
      file.executable === before.executable
    ) {
      continue
    }
    const operationBytes = (before?.content.byteLength ?? 0) + (file.content?.byteLength ?? 0)
    if (
      (before?.content.byteLength ?? 0) > 2 * 1024 * 1024 ||
      (file.content?.byteLength ?? 0) > 2 * 1024 * 1024 ||
      totalBytes + operationBytes > 4 * 1024 * 1024
    ) {
      return yield* Effect.fail(unavailable(new Error("Snapshot restore exceeds the guarded patch byte limits")))
    }
    totalBytes += operationBytes
    const expectedBeforeBase64 = before ? before.content.toString("base64") : null
    if (file.content === undefined) {
      operations.push({ operation: "delete", path: target, expectedBeforeBase64 })
    } else {
      operations.push({
        operation: "write",
        path: target,
        expectedBeforeBase64,
        contentBase64: Buffer.from(file.content).toString("base64"),
        executable: file.executable,
      })
    }
  }
  return operations
})

function readRegularFile(root: string, target: string) {
  return Effect.tryPromise({
    try: async () => {
      if (!contains(root, target)) throw new Error("Patch target is outside the session workspace")
      const segments = relative(root, target).split(sep)
      if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error("Patch target is not a workspace-relative file")
      }
      let current = root
      for (let index = 0; index < segments.length; index++) {
        current = resolve(current, segments[index]!)
        let stat: Stats
        try {
          stat = await lstat(current)
        } catch (cause) {
          if (index === segments.length - 1 && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw cause
        }
        if (stat.isSymbolicLink()) throw new Error("Patch target traverses a symbolic link")
        if (index < segments.length - 1 && !stat.isDirectory()) {
          throw new Error("Patch target parent is not a directory")
        }
        if (index === segments.length - 1) {
          if (!stat.isFile() || stat.nlink > 1) throw new Error("Patch target is not a regular single-link file")
          if (stat.size > 2 * 1024 * 1024) throw new Error("Patch preimage exceeds the 2 MiB file limit")
          const canonical = await realpath(current)
          if (!contains(root, canonical)) throw new Error("Patch target resolves outside the session workspace")
          const handle = await open(canonical, "r")
          try {
            const opened = await handle.stat()
            const named = await lstat(current)
            if (!sameFile(opened, stat) || !sameFile(named, stat) || !opened.isFile() || opened.nlink > 1) {
              throw new Error("Patch target changed while reading its preimage")
            }
            const content = await handle.readFile()
            if (content.byteLength !== opened.size || content.byteLength > 2 * 1024 * 1024) {
              throw new Error("Patch target changed while reading its preimage")
            }
            if (!sameFile(await handle.stat(), opened))
              throw new Error("Patch target changed while reading its preimage")
            return {
              content,
              executable: (opened.mode & 0o111) !== 0,
            }
          } finally {
            await handle.close()
          }
        }
      }
      return undefined
    },
    catch: unavailable,
  })
}

function contains(root: string, target: string) {
  const path = relative(root, target)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
function sameFile(left: Stats, right: Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  )
}

function unavailable(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new FileChangesUnavailableError({ message: `Guarded file restore failed: ${message}` })
}
