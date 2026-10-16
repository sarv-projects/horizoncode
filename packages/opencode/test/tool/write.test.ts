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
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
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

const supervisor = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.succeed(
    SessionSupervisor.Service,
    SessionSupervisor.Service.of({
      open: () => Effect.die("unexpected supervisor open"),
      openForSession: () => Effect.die("unexpected supervisor open"),
      registerHostLocation: () => Effect.die("unexpected host location registration"),
      prepareUserEffect: () => Effect.die("unexpected user effect preparation"),
      replyGuardApproval: () => Effect.die("unexpected guard approval reply"),
      prepareToolBatch: () => Effect.die("unexpected effect preparation"),
      executeWrite: () => Effect.die("unexpected effect execution"),
      executePatch: () => Effect.die("unexpected patch execution"),
      runPatch: () => Effect.die("unexpected patch execution"),
      requestHostKernel: () => Effect.die("unexpected host kernel request"),
      hostOwnerEpoch: () => Effect.die("unexpected host owner epoch read"),
      subscribeHostKernelEvents: () => Stream.die("unexpected host kernel event subscription"),
      watchSession: () => Effect.die("unexpected session watch"),
    }),
  ),
  deps: [],
})

afterEach(async () => {
  await disposeAllInstances()
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
  }),
)
