import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Exit, Effect, Layer, Stream } from "effect"
import path from "path"
import fs from "fs/promises"
import { WriteTool } from "../../src/tool/write"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import {
  SessionSupervisor,
  type EffectReceipt,
  type Interface as SessionSupervisorInterface,
} from "@opencode-ai/core/session/supervisor"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test-write-session"),
  messageID: MessageID.make("msg_test"),
  callID: "call_write",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

type WriteRequest = Parameters<SessionSupervisorInterface["executeWrite"]>[0]
const writeRequests: WriteRequest[] = []
let writeReceiptOverride: Partial<EffectReceipt> | undefined

const supervisor = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(
    SessionSupervisor.Service,
    {
      open: () => Effect.die("unexpected supervisor open"),
      openForSession: () => Effect.die("unexpected supervisor open"),
      registerHostLocation: () => Effect.die("unexpected host location registration"),
      prepareUserEffect: () => Effect.die("unexpected user effect preparation"),
      replyGuardApproval: () => Effect.die("unexpected guard approval reply"),
      awaitManagedVerifierApprovals: () => Effect.die("unexpected managed verifier approval"),
      prepareToolBatch: () => Effect.die("unexpected effect preparation"),
      executeWrite: (input) =>
        Effect.sync(() => {
          writeRequests.push(input)
          return {
            effectID: input.lease.effectID,
            receiptDigest: `blake3:${"a".repeat(64)}`,
            target: "/write-test-target",
            resource: "write-test-target",
            existed: false,
            ...writeReceiptOverride,
          } as EffectReceipt
        }),
      executePatch: () => Effect.die("unexpected patch execution"),
      runPatch: () => Effect.die("unexpected patch execution"),
      requestHostKernel: () => Effect.die("unexpected host kernel request"),
      hostOwnerEpoch: () => Effect.die("unexpected host owner epoch read"),
      subscribeHostKernelEvents: () => Stream.die("unexpected host kernel event subscription"),
      watchSession: () => Effect.die("unexpected session watch"),
    },
  ),
  deps: [],
})

afterEach(async () => {
  await disposeAllInstances()
  writeRequests.length = 0
  writeReceiptOverride = undefined
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
      supervisor,
    ]),
  ),
)

const init = Effect.fn("WriteToolTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const run = Effect.fn("WriteToolTest.run")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

function makeDirectAttempt() {
  const scope = {
    attemptID: "att_0123456789abcdef",
    parentSessionID: "session_parent",
    childSessionID: "session_1",
    profileID: "profile_child",
    profileRevision: "1",
    profileDigest: `blake3:${"9".repeat(64)}`,
    ownerEpoch: "1",
    expectedRevision: "1",
    locationID: "loc_child",
    workspaceID: "wrk_child",
    workspaceRevision: `blake3:${"a".repeat(64)}`,
    capabilityDigest: `sha256:${"b".repeat(64)}`,
    permissionsDigest: `sha256:${"c".repeat(64)}`,
    budgetDigest: `sha256:${"d".repeat(64)}`,
    scopeDigest: `sha256:${"e".repeat(64)}`,
  }
  const refreshed = { ...scope, expectedRevision: "2" }
  let current = scope
  let accepted = false
  return {
    scope,
    refreshed,
    authority: {
      scope,
      currentScope: () => current,
      acceptRefreshedScope: ({ refreshed }: {
        previous: typeof scope
        refreshed: typeof scope
        transition: "batch_bind" | "effect_receipt"
      }) => {
        accepted = true
        current = refreshed
      },
    },
    accepted: () => accepted,
    current: () => current,
  }
}

function guardedContext(directAttempt: unknown): Tool.Context {
  return {
    ...ctx,
    trustedPrincipal: { kind: "server_auth", subject: "test" },
    extra: {
      guardedLease: {
        effectID: "effect_write_test",
        capabilityLeaseDigest: `blake3:${"b".repeat(64)}`,
      },
      directAttempt,
    },
  }
}

it.instance("rejects a write receipt for a different target before Attempt acceptance", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const filepath = path.join(test.directory, "requested.txt")
    const attempt = makeDirectAttempt()
    writeReceiptOverride = {
      target: `${filepath}.different`,
      directAttempt: attempt.refreshed,
      attemptScopeTransition: "effect_receipt",
    }

    const exit = yield* run({ filePath: filepath, content: "content" }, guardedContext(attempt.authority)).pipe(
      Effect.exit,
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(writeRequests).toHaveLength(1)
    expect(attempt.accepted()).toBe(false)
    expect(attempt.current()).toEqual(attempt.scope)
  }),
)

it.instance("rejects a write receipt for a different effect before Attempt acceptance", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const filepath = path.join(test.directory, "requested.txt")
    const attempt = makeDirectAttempt()
    writeReceiptOverride = {
      effectID: "effect_write_other",
      target: filepath,
      directAttempt: attempt.refreshed,
      attemptScopeTransition: "effect_receipt",
    }

    const exit = yield* run({ filePath: filepath, content: "content" }, guardedContext(attempt.authority)).pipe(
      Effect.exit,
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(writeRequests).toHaveLength(1)
    expect(attempt.accepted()).toBe(false)
    expect(attempt.current()).toEqual(attempt.scope)
  }),
)

it.instance("does not accept a direct Attempt receipt when the managed receipt is missing", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const filepath = path.join(test.directory, "requested.txt")
    const attempt = makeDirectAttempt()
    let managedAccepted = false
    writeReceiptOverride = {
      target: filepath,
      directAttempt: attempt.refreshed,
      attemptScopeTransition: "effect_receipt",
    }
    const context = guardedContext(attempt.authority)
    context.extra!.managedAttempt = {
      currentScope: () => ({}) as never,
      acceptRefreshedScope: () => {
        managedAccepted = true
      },
    }

    const exit = yield* run({ filePath: filepath, content: "content" }, context).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(writeRequests).toHaveLength(1)
    expect(attempt.accepted()).toBe(false)
    expect(attempt.current()).toEqual(attempt.scope)
    expect(managedAccepted).toBe(false)
  }),
)

it.instance("refuses to write without the Rust Guard challenge", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const filepath = path.join(test.directory, "existing.txt")
    yield* Effect.promise(() => fs.writeFile(filepath, "original", "utf-8"))
    let permissionAsks = 0
    const context: Tool.Context = {
      ...ctx,
      ask: () => Effect.sync(() => permissionAsks++).pipe(Effect.asVoid),
    }

    const exit = yield* run({ filePath: filepath, content: "unapproved" }, context).pipe(Effect.exit)
    const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(content).toBe("original")
    expect(permissionAsks).toBe(0)
    expect(writeRequests).toHaveLength(0)
  }),
)
