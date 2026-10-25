import { describe, expect } from "bun:test"
import { type ToolCall } from "@opencode-ai/llm"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { configServiceMockDefaults } from "./lib/config"
import { toolIdentity, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_tool_test")
let processCalls = 0
let permissionCalls = 0

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.sync(() => {
      permissionCalls++
    }),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    policySnapshotDigest: () => Effect.succeed(`sha256:${"0".repeat(64)}`),
  }),
)
const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: () => Effect.sync(() => {
      processCalls++
      throw new Error("unguarded BashTool must not launch a process")
    }),
  } as unknown as AppProcess.Interface),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    ...configServiceMockDefaults,
    entries: () => Effect.succeed([]),
  }),
)

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, BashTool.node]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [AppProcess.node, appProcess],
          [Config.node, config],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof BashTool.Input.Type) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-bash", name: "bash", input },
})

const it = testEffect(Layer.empty)

describe("BashTool", () => {
  it.live("does not expose unguarded bash or launch a process before terminal.run Guard support", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        processCalls = 0
        permissionCalls = 0
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(yield* toolDefinitions(registry)).toEqual([])
            for (const command of [
              "touch should-not-run",
              "echo $(touch should-not-run)",
              "printf safe; touch should-not-run",
              "echo `touch should-not-run`",
            ]) {
              expect(yield* settleTool(registry, call({ command, cwd: tmp.path, timeoutMs: 1_000 }))).toEqual({
                result: { type: "error", value: "Unknown tool: bash" },
              })
            }
            expect(processCalls).toBe(0)
            expect(permissionCalls).toBe(0)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

/** A terminal runner double that reads TrustedPrincipalContext, proving the
 * guarded leaf supplies the authenticated principal at its own boundary. */
const guardedFixture = () => {
  const observed: { called: number; principal?: TrustedPrincipal } = { called: 0 }
  const tool = BashTool.makeTool({
    runTool: () =>
      Effect.gen(function* () {
        const { principal } = yield* TrustedPrincipalContext
        observed.principal = principal
        observed.called++
        return {
          status: "exited",
          exitCode: 0,
          preview: "ok-output",
          previewTruncated: false,
          artifactTruncated: false,
          artifactFidelity: "FULL",
          artifactRef: {
            artifactId: "art_bash_tool_test",
            digest: `blake3:${"1".repeat(64)}`,
            byteLength: "9",
            mediaType: "text/plain",
            classification: "public",
          },
          outputDigest: `blake3:${"2".repeat(64)}`,
          observedBytes: "9",
          droppedBytes: "0",
          receiptRef: `rcpt_${"0".repeat(64)}`,
        }
      }),
  })
  return { tool, observed }
}

const guardedCall: ToolCall = {
  type: "tool-call",
  id: "call-bash",
  name: "bash",
  input: { command: "true", cwd: "/workspace", timeoutMs: 1_000 },
}

const guardedContext = (trustedPrincipal?: TrustedPrincipal): Tool.Context => ({
  sessionID,
  agent: toolIdentity.agent,
  assistantMessageID: toolIdentity.assistantMessageID,
  toolCallID: "call-bash",
  effect: { effectID: "eff_bash_tool_test", capabilityLeaseDigest: `blake3:${"0".repeat(64)}` },
  guardedCall: {
    callID: "call-bash",
    capabilityID: "terminal.run",
    arguments: { command: "true" },
  },
  locationRef: { directory: AbsolutePath.make("/workspace") },
  ...(trustedPrincipal === undefined ? {} : { trustedPrincipal }),
})

describe("BashTool guarded execution context", () => {
  it.live("fails closed without an authenticated trusted principal and never reaches the terminal", () =>
    Effect.gen(function* () {
      const { tool, observed } = guardedFixture()
      const failure = yield* Tool.settle(tool, guardedCall, guardedContext()).pipe(Effect.flip)
      expect(failure.message).toBe(
        "Terminal execution requires an authenticated trusted principal",
      )
      expect(observed.called).toBe(0)
    }),
  )

  it.live("provides the trusted principal service to guarded terminal execution", () =>
    Effect.gen(function* () {
      const { tool, observed } = guardedFixture()
      const output = yield* Tool.settle(
        tool,
        guardedCall,
        guardedContext({ kind: "host_os" }),
      )
      expect(observed.called).toBe(1)
      expect(observed.principal).toEqual({ kind: "host_os" })
      // `structured` carries the strict output projection; the preview text
      // rides in the model content.
      expect(output.structured).toMatchObject({ exit: 0, truncated: false })
      expect(output.content).toEqual([{ type: "text", text: "ok-output" }])
    }),
  )
})
