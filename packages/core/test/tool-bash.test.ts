import { describe, expect } from "bun:test"
import { type ToolCall } from "@horizoncode/llm"
import { Effect, Layer } from "effect"
import { Config } from "@horizoncode/core/config"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Location } from "@horizoncode/core/location"
import { LocationMutation } from "@horizoncode/core/location-mutation"
import { PermissionV2 } from "@horizoncode/core/permission"
import { AppProcess } from "@horizoncode/core/process"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SessionV2 } from "@horizoncode/core/session"
import { BashTool } from "@horizoncode/core/tool/bash"
import { ToolRegistry } from "@horizoncode/core/tool/registry"
import { Tool } from "@horizoncode/core/tool/tool"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@horizoncode/core/trusted-principal"
import { ToolOutputStore } from "@horizoncode/core/tool-output-store"
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
  const observed: {
    called: number
    principal?: TrustedPrincipal
    invocation?: NonNullable<Tool.Context["workspaceCommandProfile"]>["reference"] | undefined
  } = { called: 0 }
  const tool = BashTool.makeTool({
    runTool: (input) =>
      Effect.gen(function* () {
        const { principal } = yield* TrustedPrincipalContext
        observed.principal = principal
        observed.invocation = input.workspaceCommandProfile?.reference
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

const workspaceProfileDefinition = (): NonNullable<
  Tool.Context["workspaceCommandProfile"]
>["definition"] => ({
  schemaVersion: 1,
  profileId: "profile_build_test",
  revision: "3",
  enabled: true,
  actions: ["test"],
  executable: { selector: "/usr/bin/bun", resolvedDigest: `blake3:${"c".repeat(64)}` },
  arguments: {
    fixedPrefix: ["--"],
    allowedValuesByPosition: [["focused-suite"]],
    maxCount: 2,
    maxBytes: 4096,
  },
  workingDirectory: "registered_workspace_root",
  environment: { policy: "sanitized_allowlist", allowedNames: [] },
  filesystem: "registered_workspace_and_isolated_temp_cache_roots",
  network: "deny",
  limits: {
    maxWallTimeMs: 60_000,
    maxStdoutBytes: 65_536,
    maxStderrBytes: 65_536,
    maxProcesses: 4,
    requiredOsGuarantees: [],
  },
  profileDigest: `blake3:${"a".repeat(64)}`,
})

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
    arguments: {
      mode: "shell",
      command: "true",
      cwd: "/workspace",
      timeoutMs: 1_000,
      shellProfileID: "shell_fixture",
      resolvedEnvironment: {},
    },
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

  it.live("passes only the exact admitted workspace profile reference to guarded execution", () =>
    Effect.gen(function* () {
      const { tool, observed } = guardedFixture()
      const input = {
        mode: "workspace_profile" as const,
        action: "test" as const,
        profileID: "profile_build_test",
        revision: "3",
        profileDigest: `blake3:${"a".repeat(64)}`,
        arguments: ["--", "focused-suite"],
      }
      const context: Tool.Context = {
        ...guardedContext({ kind: "server_auth", subject: "profile-test" }),
        toolCallID: "call-bash-profile",
        guardedCall: {
          callID: "call-bash-profile",
          capabilityID: "terminal.run",
          arguments: input,
        },
        workspaceCommandProfile: {
          callID: "call-bash-profile",
          reference: {
            profileId: input.profileID,
            revision: input.revision,
            profileDigest: input.profileDigest,
            action: input.action,
          },
          definition: workspaceProfileDefinition(),
          resolvedEnvironment: {},
        },
      }

      const output = yield* Tool.settle(
        tool,
        { ...guardedCall, id: "call-bash-profile", input } as ToolCall,
        context,
      )
      expect(observed.called).toBe(1)
      expect(observed.invocation).toEqual({
        profileId: input.profileID,
        revision: input.revision,
        profileDigest: input.profileDigest,
        action: input.action,
      })
      expect(output.structured).toMatchObject({ exit: 0, truncated: false })
    }),
  )

  it.live("rejects substituted profile identity, digest, action, and argv before guarded execution", () =>
    Effect.gen(function* () {
      const { tool, observed } = guardedFixture()
      const input = {
        mode: "workspace_profile" as const,
        action: "test" as const,
        profileID: "profile_build_test",
        revision: "3",
        profileDigest: `blake3:${"a".repeat(64)}`,
        arguments: ["--", "focused-suite"],
      }
      const context: Tool.Context = {
        ...guardedContext({ kind: "server_auth", subject: "profile-test" }),
        toolCallID: "call-bash-profile",
        guardedCall: { callID: "call-bash-profile", capabilityID: "terminal.run", arguments: input },
        workspaceCommandProfile: {
          callID: "call-bash-profile",
          reference: {
            profileId: input.profileID,
            revision: input.revision,
            profileDigest: input.profileDigest,
            action: input.action,
          },
          definition: workspaceProfileDefinition(),
          resolvedEnvironment: {},
        },
      }
      const toolCall = { ...guardedCall, id: "call-bash-profile", input } as ToolCall
      const cases = [
        { ...input, revision: "4" },
        { ...input, profileDigest: `blake3:${"b".repeat(64)}` },
        { ...input, action: "build" as const },
        { ...input, arguments: ["--", "other-suite"] },
      ]
      for (const substituted of cases) {
        const failure = yield* Tool.settle(tool, { ...toolCall, input: substituted }, context).pipe(Effect.flip)
        expect(failure.message).toBe("Terminal execution requires the exact Guard-admitted call, lease, and Location")
      }
      expect(observed.called).toBe(0)
    }),
  )

  it.live("rejects a Guarded call whose arguments differ from the validated tool input", () =>
    Effect.gen(function* () {
      const { tool, observed } = guardedFixture()
      const context = guardedContext({ kind: "host_os" })
      const mismatchedContext: Tool.Context = {
        ...context,
        guardedCall: {
          ...context.guardedCall!,
          arguments: { command: "rm -rf /workspace", cwd: "/workspace", timeoutMs: 1_000 },
        },
      }

      const failure = yield* Tool.settle(tool, guardedCall, mismatchedContext).pipe(Effect.flip)
      expect(failure.message).toBe("Terminal execution requires the exact Guard-admitted call, lease, and Location")
      expect(observed.called).toBe(0)
    }),
  )
})
