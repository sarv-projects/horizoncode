import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { SessionID, MessageID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testInstanceStoreLayer, tmpdirScoped, provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = context,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = context,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause)
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("expected shell execution to fail")
})

const runIn = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) => effect.pipe(provideInstance(directory))

const context: Tool.Context = {
  sessionID: SessionID.make("ses_guarded_shell"),
  messageID: MessageID.make("msg_guarded_shell"),
  callID: "call_guarded_shell",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`
const commandThatWouldLaunch = (marker: string) =>
  `${quote(process.execPath)} -e ${quote("require('node:fs').writeFileSync(process.argv[1], 'launched')")} ${quote(marker)}`

describe("tool.shell Guard boundary", () => {
  it.live("denies missing, challenge-only, and malformed leases before launching a process", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const marker = path.join(directory, "shell-was-launched")
      let legacyApprovalCalls = 0
      const challengeOnly: Tool.Context = {
        ...context,
        effect: {
          challengeID: "challenge_only",
          effectID: "effect_only",
          target: directory,
          resource: "shell",
          existed: false,
        },
        ask: () => Effect.sync(() => { legacyApprovalCalls++ }).pipe(Effect.asVoid),
      }
      const malformedLease: Tool.Context = {
        ...context,
        extra: { guardedLease: { effectID: "effect_bad", capabilityLeaseDigest: "not-a-kernel-lease" } },
      }

      for (const candidate of [context, challengeOnly, malformedLease]) {
        const error = yield* runIn(directory, fail({ command: commandThatWouldLaunch(marker) }, candidate))
        expect(error.message).toContain("Shell denied: missing Rust Guard lease")
        expect(existsSync(marker)).toBe(false)
      }
      expect(legacyApprovalCalls).toBe(0)
    }),
  )
})
