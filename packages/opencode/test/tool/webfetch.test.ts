import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Exit } from "effect"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

let requestCount = 0
let askCount = 0

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "call-webfetch",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.sync(() => {
    askCount++
  }),
}

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("denies before user approval and outbound HTTP until Guarded HTTP is available", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => Bun.serve({
        port: 0,
        fetch: () => {
          requestCount++
          return new Response("must not be requested")
        },
      })),
      (server) =>
        Effect.gen(function* () {
          requestCount = 0
          askCount = 0
          const exit = yield* Effect.exit(
            exec({ url: new URL("/private", server.url).toString(), format: "text" }),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          expect(requestCount).toBe(0)
          expect(askCount).toBe(0)
        }),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )
})
