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
const lease = {
  effectID: "effect_prepared",
  capabilityLeaseDigest: `blake3:${"1".repeat(64)}`,
}
let preparedTarget: string | undefined
let preparedResource: string | undefined
let leasePrepared = false
let denyToolBatch = false

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
    prepareToolBatch: ({ locationRef, calls }) => {
      supervisorCalls.push("prepare")
      const input = calls[0]?.arguments
      const relativePath = typeof input === "object" && input !== null && "path" in input ? input.path : undefined
      if (denyToolBatch)
        return Effect.succeed({ status: "denied" as const, reason: "Guard approval denied" })
      if (calls.length !== 1 || calls[0]?.capabilityID !== "files.write" || typeof relativePath !== "string")
        return Effect.succeed({ status: "denied" as const, reason: "unsupported batch" })
      preparedTarget = path.resolve(locationRef.directory, relativePath)
      preparedResource = relativePath
      leasePrepared = true
      return Effect.succeed({ status: "prepared" as const, lease })
    },
    replyGuardApproval: () => Effect.die("unused"),
    executeWrite: ({ lease: providedLease, content }) =>
      Effect.gen(function* () {
        supervisorCalls.push("execute")
        if (
          !leasePrepared ||
          providedLease.effectID !== lease.effectID ||
          providedLease.capabilityLeaseDigest !== lease.capabilityLeaseDigest ||
          !preparedTarget ||
          !preparedResource
        )
          return yield* Effect.fail(new SessionSupervisorError({ stage: "effect", reason: "invalid lease" }))
        leasePrepared = false
        const target = preparedTarget
        const resource = preparedResource
        const existed = yield* Effect.promise(() =>
          fs.stat(target).then(
            () => true,
            () => false,
          ),
        )
        yield* Effect.promise(() => fs.writeFile(target, content))
        return {
          effectID: lease.effectID,
          receiptDigest: `blake3:${"2".repeat(64)}`,
          target,
          resource,
          existed,
        }
      }),
    executePatch: () => Effect.die("unused"),
    runPatch: () => Effect.die("unused"),
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
  it.live("advertises the first-party write after provenance validation", () =>
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

  it.live("writes only with the prepared host lease", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        leasePrepared = false
        preparedTarget = undefined
        preparedResource = undefined
        permissionAssertions.length = 0
        supervisorCalls.length = 0
        const target = path.join(tmp.path, "allowed.txt")
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const admission = yield* SessionSupervisor.Service.pipe(
              Effect.flatMap((service) =>
                service.prepareToolBatch({
                  sessionID,
                  locationRef: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
                  batchID: "batch_write_test",
                  turnContextDigest: `sha256:${"0".repeat(64)}`,
                  calls: [{ callID: "call-write", capabilityID: "files.write", arguments: { path: "allowed.txt" } }],
                }),
              ),
            )
            expect(admission.status).toBe("prepared")
            const settled = yield* settleTool(
              registry,
              call(
                { path: "allowed.txt", content: "allowed" },
                admission.status === "prepared" ? admission.lease : undefined,
              ),
            )
            expect(settled.result).toMatchObject({ type: "text" })
            expect(supervisorCalls).toEqual(["prepare", "execute"])
            expect(permissionAssertions.map((input) => input.action)).toEqual(["edit"])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("allowed")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects settlement without a Rust Guard lease", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        leasePrepared = false
        preparedTarget = undefined
        preparedResource = undefined
        permissionAssertions.length = 0
        supervisorCalls.length = 0
        const target = path.join(tmp.path, "blocked.txt")
        return withTool(tmp.path, (registry) =>
          settleTool(registry, call({ path: "blocked.txt", content: "no" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toMatchObject({ type: "error" })
              expect(permissionAssertions).toEqual([])
              expect(supervisorCalls).toEqual([])
              expect(
                yield* Effect.promise(() =>
                  fs.stat(target).then(
                    () => true,
                    () => false,
                  ),
                ),
              ).toBe(false)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a forged lease and does not mutate", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        leasePrepared = false
        preparedTarget = undefined
        preparedResource = undefined
        permissionAssertions.length = 0
        supervisorCalls.length = 0
        const target = path.join(tmp.path, "forged.txt")
        return withTool(tmp.path, (registry) =>
          settleTool(
            registry,
            call(
              { path: "forged.txt", content: "no" },
              {
                effectID: "effect_forged",
                capabilityLeaseDigest: `blake3:${"9".repeat(64)}`,
              } as unknown as ToolRegistry.ExecuteInput["effect"],
            ),
          ),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toEqual({ type: "error", value: "Unable to write file" })
              expect(permissionAssertions.map((input) => input.action)).toEqual(["edit"])
              expect(supervisorCalls).toEqual(["execute"])
              expect(
                yield* Effect.promise(() =>
                  fs.stat(target).then(
                    () => true,
                    () => false,
                  ),
                ),
              ).toBe(false)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("does not execute after a denied Guard approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        leasePrepared = false
        denyToolBatch = true
        preparedTarget = undefined
        preparedResource = undefined
        permissionAssertions.length = 0
        supervisorCalls.length = 0
        const target = path.join(tmp.path, "denied.txt")
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const service = yield* SessionSupervisor.Service
            const admission = yield* service.prepareToolBatch({
              sessionID,
              locationRef: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
              batchID: "batch_denied_test",
              turnContextDigest: `sha256:${"0".repeat(64)}`,
              calls: [
                { callID: "call-write", capabilityID: "files.write", arguments: { path: "denied.txt" } },
              ],
            })
            expect(admission).toEqual({ status: "denied", reason: "Guard approval denied" })
            expect(
              yield* settleTool(registry, call({ path: "denied.txt", content: "no" })),
            ).toMatchObject({ result: { type: "error" } })
            expect(supervisorCalls).toEqual(["prepare"])
            expect(permissionAssertions).toEqual([])
            expect(
              yield* Effect.promise(() =>
                fs.stat(target).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
          }),
        )
      },
      (tmp) =>
        Effect.sync(() => {
          denyToolBatch = false
        }).pipe(Effect.andThen(Effect.promise(() => tmp[Symbol.asyncDispose]()))),
    ),
  )
})
