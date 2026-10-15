import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSupervisor, SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, settleTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_write_tool_test")
const permissionAssertions: PermissionV2.AssertInput[] = []
const supervisorCalls: string[] = []
const approvedChallenges = new Set<string>()

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => permissionAssertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    policySnapshotDigest: () => Effect.succeed(`sha256:${"0".repeat(64)}`),
  }),
)

const supervisor = Layer.succeed(
  SessionSupervisor.Service,
  SessionSupervisor.Service.of({
    open: () => Effect.die("unused"),
    openForSession: () => Effect.die("unused"),
    prepareToolBatch: () => Effect.succeed({ status: "denied", reason: "unused" }),
    approveEffect: ({ challengeID }) =>
      Effect.gen(function* () {
        supervisorCalls.push(`approve:${challengeID}`)
        if (!approvedChallenges.has(challengeID))
          return yield* Effect.fail(new SessionSupervisorError({ stage: "authorization", reason: "unknown challenge" }))
      }),
    executeWrite: ({ challengeID }) =>
      Effect.gen(function* () {
        supervisorCalls.push(`execute:${challengeID}`)
        return yield* Effect.fail(new SessionSupervisorError({ stage: "effect", reason: "unused" }))
      }),
    watchSession: () => Effect.void,
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
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          WriteTool.node,
          SessionSupervisor.node,
        ]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [SessionSupervisor.node, supervisor],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof WriteTool.Input.Type, effect?: ToolRegistry.ExecuteInput["effect"]) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-write", name: "write", input },
  ...(effect ? { effect } : {}),
})

const it = testEffect(Layer.empty)

describe("WriteTool", () => {
  it.live("advertises the real first-party write leaf after provenance validation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const materialized = yield* registry.materialize()
            expect(materialized.definitions.map((definition) => definition.name)).toContain("write")
            expect(materialized.classify(call({ path: "source.txt", content: "ok" }).call)).toEqual({
              id: "files.write",
              effectClass: "effect",
            })
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects direct registry settlement without a Rust effect challenge", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        permissionAssertions.length = 0
        supervisorCalls.length = 0
        approvedChallenges.clear()
        const target = path.join(tmp.path, "blocked.txt")
        return withTool(tmp.path, (registry) => settleTool(registry, call({ path: "blocked.txt", content: "no" }))).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toEqual({ type: "error", value: "Unable to write blocked.txt" })
              expect(permissionAssertions).toEqual([])
              expect(supervisorCalls).toEqual([])
              expect(yield* Effect.promise(() => fs.stat(target).then(() => true, () => false))).toBe(false)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not treat a caller-forged challenge as Rust approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        permissionAssertions.length = 0
        supervisorCalls.length = 0
        approvedChallenges.clear()
        const target = path.join(tmp.path, "forged.txt")
        return withTool(tmp.path, (registry) =>
          settleTool(
            registry,
            call(
              { path: "forged.txt", content: "no" },
              {
                challengeID: "challenge_forged",
                effectID: "effect_forged",
                target,
                resource: "forged.txt",
              },
            ),
          ),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toEqual({ type: "error", value: "Unable to write forged.txt" })
              expect(permissionAssertions.map((input) => input.action)).toEqual(["edit"])
              expect(supervisorCalls).toEqual(["approve:challenge_forged"])
              expect(yield* Effect.promise(() => fs.stat(target).then(() => true, () => false))).toBe(false)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
