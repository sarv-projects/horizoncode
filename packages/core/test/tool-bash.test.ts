import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
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
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
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
  test("the leaf itself fails closed without a Guard lease", async () => {
    processCalls = 0
    const exit = await Effect.runPromiseExit(BashTool.guardUnavailable())
    expect(exit._tag).toBe("Failure")
    expect(processCalls).toBe(0)
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("Guarded terminal.run support")
    }
  })

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
              expect(yield* settleTool(registry, call({ command }))).toEqual({
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

test("keeps locked deferred parity TODOs visible", async () => {
  const source = await fs.readFile(new URL("../src/tool/bash.ts", import.meta.url), "utf8")
  for (const todo of [
    "Port tree-sitter bash / PowerShell parser-based approval reduction.",
    "Port BashArity reusable command-prefix approvals.",
    "Replace token-based command-argument external-directory advisories with parser-based detection.",
    "Restore PowerShell and cmd-specific invocation/path handling on Windows.",
    "Add plugin shell.env environment augmentation once V2 plugin hooks exist.",
    "Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.",
    "Persist background job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
    "Stream full shell output into managed storage while retaining only a bounded in-memory preview.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
