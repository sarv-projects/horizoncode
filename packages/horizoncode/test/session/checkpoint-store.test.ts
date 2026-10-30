import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { SessionSupervisor, type EffectChallenge, type EffectReceipt } from "@horizoncode/core/session/supervisor"
import { SessionContextEpochTable } from "@horizoncode/core/session/sql"
import { Database } from "@horizoncode/core/database/database"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Session } from "@/session/session"
import { SessionProjector } from "@horizoncode/core/session/projector"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import {
  CheckpointNotFoundError,
  CheckpointStore,
  RestoreAdmissionRequiredError,
} from "@/session/checkpoint-store"
import { testEffectShared } from "../lib/effect"

// ---------------------------------------------------------------------
// Guarded supervisor double: simulates the host kernel's admission and
// execution half of the ToolBatch relay. Every workspace write in these
// tests happens through executeWrite — never through the restore path.
// ---------------------------------------------------------------------

type SupervisorMode = "prepared" | "denied" | "admitted"
let supervisorMode: SupervisorMode = "prepared"
let preparedBatches: string[] = []
let pendingWrites: Array<{ path: string; content: string }> = []

const batchLease = { effectID: "eff_checkpoint_restore_1", capabilityLeaseDigest: `blake3:${"9".repeat(64)}` }
const pendingChallenge: EffectChallenge = {
  challengeID: "chg_restore_1",
  effectID: "eff_restore_1",
  target: "pending",
  resource: "pending",
  existed: false,
}

function resetSupervisor(mode: SupervisorMode) {
  supervisorMode = mode
  preparedBatches = []
  pendingWrites = []
}

const supervisorMock = Layer.mock(SessionSupervisor.Service)({
  prepareToolBatch: (request) =>
    Effect.gen(function* () {
      preparedBatches.push(request.batchID)
      if (supervisorMode === "denied") return { status: "denied" as const, reason: "denied" }
      if (supervisorMode === "admitted") return { status: "admitted" as const, challenge: pendingChallenge }
      for (const call of request.calls) {
        const args = call.arguments as { path: string; content: string }
        pendingWrites.push({ path: args.path, content: args.content })
      }
      return { status: "prepared" as const, lease: batchLease }
    }),
  executeWrite: (input) =>
    Effect.gen(function* () {
      const next = pendingWrites.shift()
      if (!next) return yield* Effect.die(new Error("executeWrite without a prepared checkpoint call"))
      // Simulated host kernel: perform the admitted write on disk.
      const context = yield* InstanceState.context
      const target = path.join(context.directory, next.path)
      yield* Effect.promise(() => fs.writeFile(target, input.content))
      return {
        effectID: input.lease.effectID,
        receiptDigest: `blake3:${"1".repeat(64)}`,
        target,
        resource: target,
        existed: true,
      } satisfies EffectReceipt
    }),
})

const it = testEffectShared(
  LayerNode.compile(
    LayerNode.group([CheckpointStore.node, Session.node, SessionProjector.node, Storage.node, Database.node]),
    [[SessionSupervisor.node, supervisorMock]],
  ),
)

const principal = { kind: "server_auth", subject: "checkpoint-store-owner" } as const
const withPrincipal = <A, E>(effect: Effect.Effect<A, E, never>) =>
  effect.pipe(Effect.provideService(TrustedPrincipalContext, { principal }))

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const write = (relative: string, content: string) =>
  Effect.gen(function* () {
    const context = yield* InstanceState.context
    const target = path.join(context.directory, relative)
    yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(target, content))
  })

const readDisk = (relative: string) =>
  Effect.gen(function* () {
    const context = yield* InstanceState.context
    return yield* Effect.promise(() => fs.readFile(path.join(context.directory, relative), "utf8"))
  })

const digestOf = (content: string) => `blake3:${bytesToHex(blake3(new TextEncoder().encode(content)))}`

const addUser = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const message = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user" as const,
      sessionID,
      agent: "default",
      model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
      time: { created: Date.now() },
    })
    yield* session.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID, type: "text" as const, text })
    return message
  })

const seedEpochBaseline = (sessionID: SessionID, baseline: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(SessionContextEpochTable)
      .values({ session_id: sessionID, baseline, snapshot: {}, baseline_seq: 0 })
      .run()
      .pipe(Effect.orDie)
  })

const epochBaseline = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const row = yield* database.db
      .select({ baseline: SessionContextEpochTable.baseline })
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    return row?.baseline
  })

/** Two workspace files + a session with three user messages. */
const setup = Effect.fn("test.setup")(function* () {
  const session = yield* Session.Service
  yield* write("a.txt", "alpha")
  yield* write("b.txt", "beta")
  const info = yield* session.create({})
  for (const text of ["one", "two", "three"]) yield* addUser(info.id, text)
  return info.id
})

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("CheckpointStore", () => {
  it.instance("capture persists a restorable checkpoint", () =>
    Effect.gen(function* () {
      resetSupervisor("prepared")
      const store = yield* CheckpointStore.Service
      const storage = yield* Storage.Service
      const sessionID = yield* setup()

      const capture = yield* store.capture({ sessionID })
      expect(capture.messageCount).toBe(3)
      expect(capture.fileCount).toBe(2)
      expect(capture.digest).toMatch(/^blake3:[0-9a-f]{64}$/)
      expect(capture.checkpointID).toMatch(/^chk_\d+_[0-9a-f]{16}$/)

      // Persisted via Storage under the instance data dir.
      const persisted = yield* storage.read<Record<string, unknown>>([
        "checkpoints",
        sessionID,
        capture.checkpointID,
      ])
      expect(persisted.checkpointID).toBe(capture.checkpointID)
      expect(persisted.sessionID).toBe(sessionID)
      expect(persisted.messageCount).toBe(3)
      expect(persisted.digest).toBe(capture.digest)

      const record = yield* store.get({ sessionID, checkpointID: capture.checkpointID })
      expect(record.messageCount).toBe(3)
      expect(record.lastMessageID).not.toBeNull()
      expect(record.files.map((file) => file.path).toSorted()).toEqual(["a.txt", "b.txt"])
      const alpha = record.files.find((file) => file.path === "a.txt")!
      expect(alpha.digest).toBe(digestOf("alpha"))
      expect(alpha.byteLength).toBe(5)
      expect(alpha.executable).toBe(false)
      expect(Buffer.from(alpha.contentBase64, "base64").toString("utf8")).toBe("alpha")

      const ids = yield* store.list({ sessionID })
      expect(ids).toContain(capture.checkpointID)
    }),
    undefined,
    30000,
  )

  it.instance("restore rewinds code and conversation through the Guarded path", () =>
    Effect.gen(function* () {
      resetSupervisor("prepared")
      const store = yield* CheckpointStore.Service
      const session = yield* Session.Service
      const sessionID = yield* setup()
      const capture = yield* store.capture({ sessionID })

      // Mutate both captured files and extend the conversation.
      yield* write("a.txt", "alpha-mutated")
      yield* write("b.txt", "beta-mutated")
      yield* addUser(sessionID, "four")
      yield* addUser(sessionID, "five")
      expect((yield* session.messages({ sessionID })).length).toBe(5)

      // Seed a pre-restore context epoch so the fresh epoch is provable.
      yield* seedEpochBaseline(sessionID, "seed-baseline")

      const result = yield* withPrincipal(store.restore({ sessionID, checkpointID: capture.checkpointID }))
      expect(result).toEqual({
        checkpointID: capture.checkpointID,
        restoredMessages: 2,
        restoredFiles: 2,
        removedFiles: 0,
        guarded: true,
      })

      // Code is back to the captured content (written only via executeWrite).
      expect(yield* readDisk("a.txt")).toBe("alpha")
      expect(yield* readDisk("b.txt")).toBe("beta")
      // Conversation is back to the captured boundary.
      expect((yield* session.messages({ sessionID })).length).toBe(3)
      // Guard relay shape: one batch admission, all writes executed.
      expect(preparedBatches).toEqual([`checkpoint_restore_${capture.checkpointID}_0`])
      expect(pendingWrites.length).toBe(0)

      // A fresh core context epoch row exists after restore (replaces the seed).
      const baseline = yield* epochBaseline(sessionID)
      expect(baseline).toBeDefined()
      expect(baseline).not.toBe("seed-baseline")
    }),
    undefined,
    30000,
  )

  it.instance("guarded restore fails closed without admission", () =>
    Effect.gen(function* () {
      const store = yield* CheckpointStore.Service
      const session = yield* Session.Service

      for (const mode of ["denied", "admitted"] as const) {
        resetSupervisor(mode)
        const sessionID = yield* setup()
        const capture = yield* store.capture({ sessionID })
        yield* write("a.txt", "alpha-mutated")
        yield* write("b.txt", "beta-mutated")
        yield* addUser(sessionID, "four")

        const exit = yield* Effect.result(
          withPrincipal(store.restore({ sessionID, checkpointID: capture.checkpointID })),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(exit.failure).toBeInstanceOf(RestoreAdmissionRequiredError)
        // Fail-closed: nothing mutated — code, conversation, epoch untouched.
        expect(yield* readDisk("a.txt")).toBe("alpha-mutated")
        expect(yield* readDisk("b.txt")).toBe("beta-mutated")
        expect((yield* session.messages({ sessionID })).length).toBe(4)
        expect(pendingWrites.length).toBe(0)
        yield* session.remove(sessionID)
      }

      // A missing authenticated principal also fails closed before any mutation.
      resetSupervisor("prepared")
      const sessionID = yield* setup()
      const capture = yield* store.capture({ sessionID })
      yield* write("a.txt", "alpha-mutated")
      const exit = yield* Effect.result(store.restore({ sessionID, checkpointID: capture.checkpointID }))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(exit.failure).toBeInstanceOf(RestoreAdmissionRequiredError)
      expect(yield* readDisk("a.txt")).toBe("alpha-mutated")
      expect((yield* session.messages({ sessionID })).length).toBe(3)
    }),
    undefined,
    30000,
  )

  it.instance("restore and get fail with CheckpointNotFoundError for an unknown checkpoint", () =>
    Effect.gen(function* () {
      const store = yield* CheckpointStore.Service
      const sessionID = yield* setup()

      const restoreExit = yield* Effect.result(
        withPrincipal(store.restore({ sessionID, checkpointID: "chk_missing" })),
      )
      expect(restoreExit._tag).toBe("Failure")
      if (restoreExit._tag === "Failure") expect(restoreExit.failure).toBeInstanceOf(CheckpointNotFoundError)

      const getExit = yield* Effect.result(store.get({ sessionID, checkpointID: "chk_missing" }))
      expect(getExit._tag).toBe("Failure")
      if (getExit._tag === "Failure") expect(getExit.failure).toBeInstanceOf(CheckpointNotFoundError)
    }),
    undefined,
    30000,
  )

  it.instance("capture skips .git, node_modules and files larger than 1 MiB", () =>
    Effect.gen(function* () {
      resetSupervisor("prepared")
      const store = yield* CheckpointStore.Service
      const sessionID = yield* setup()
      yield* write(".git/config", "[core]")
      yield* write("node_modules/pkg/index.js", "module.exports = 1")
      yield* write("huge.bin", "x".repeat(1024 * 1024 + 1))

      const capture = yield* store.capture({ sessionID })
      expect(capture.fileCount).toBe(2)
      const record = yield* store.get({ sessionID, checkpointID: capture.checkpointID })
      expect(record.files.map((file) => file.path).toSorted()).toEqual(["a.txt", "b.txt"])
      expect(record.files.some((file) => file.path.startsWith("huge"))).toBe(false)
    }),
    undefined,
    30000,
  )
})
