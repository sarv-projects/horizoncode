import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Permission } from "@/permission"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const UNAVAILABLE =
  "Task/subagent execution is unavailable: Rust Guard cannot bind dispatch to an authenticated Attempt."

const seed = Effect.fn("TaskToolTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Parent" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function promptOps(onPrompt: (input: SessionPrompt.PromptInput) => void): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: (input) =>
      Effect.sync(() => {
        onPrompt(input)
        throw new Error("Subagent prompt must not be dispatched without an authenticated Attempt")
      }),
  }
}

function expectUnavailable(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("expected Task/subagent dispatch to be unavailable")
  const error = Cause.squash(exit.cause)
  expect(error).toBeInstanceOf(Error)
  if (error instanceof Error) expect(error.message).toBe(UNAVAILABLE)
}

describe("tool.task fail-closed dispatch", () => {
  it.instance("plan-mode bypass cannot create or execute a child without an authenticated Guard Attempt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      let metadataUpdates = 0
      let permissionAsks = 0

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "plan",
            abort: new AbortController().signal,
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps(() => prompts++),
            },
            messages: [],
            metadata: () => Effect.sync(() => metadataUpdates++),
            ask: () => Effect.sync(() => permissionAsks++),
          },
        )
        .pipe(Effect.exit)

      expectUnavailable(exit)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      expect(yield* jobs.list()).toHaveLength(0)
      expect(prompts).toBe(0)
      expect(metadataUpdates).toBe(0)
      expect(permissionAsks).toBe(0)
    }),
  )

  it.instance(
    "parent task permission and an approval callback do not authorize a child without Rust Guard",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let prompts = 0
        let permissionAsks = 0

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: promptOps(() => prompts++) },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.sync(() => permissionAsks++),
            },
          )
          .pipe(Effect.exit)

        expectUnavailable(exit)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
        expect(yield* jobs.list()).toHaveLength(0)
        expect(prompts).toBe(0)
        expect(permissionAsks).toBe(0)
      }),
    { config: { permission: { task: { general: "allow" } } } },
  )

  it.instance("resuming a parent-owned child is unavailable and leaves its permissions unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const originalPermission = Permission.fromConfig({ read: "deny" })
      const child = yield* sessions.create({
        parentID: chat.id,
        agent: "general",
        permission: originalPermission,
        title: "Existing child",
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      let metadataUpdates = 0

      const exit = yield* def
        .execute(
          {
            description: "resume child",
            prompt: "continue the existing task",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "plan",
            abort: new AbortController().signal,
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps(() => prompts++),
            },
            messages: [],
            metadata: () => Effect.sync(() => metadataUpdates++),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expectUnavailable(exit)
      expect((yield* sessions.get(child.id)).permission).toEqual(originalPermission)
      expect(prompts).toBe(0)
      expect(metadataUpdates).toBe(0)
    }),
  )

  it.instance("foreign task IDs cannot cause any resume side effect", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const otherParent = yield* sessions.create({ title: "Other parent" })
      const originalPermission = Permission.fromConfig({ read: "deny" })
      const foreign = yield* sessions.create({
        parentID: otherParent.id,
        agent: "general",
        permission: originalPermission,
        title: "Foreign child",
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      let metadataUpdates = 0

      const exit = yield* def
        .execute(
          {
            description: "resume foreign task",
            prompt: "continue the task",
            subagent_type: "general",
            task_id: foreign.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: promptOps(() => prompts++) },
            messages: [],
            metadata: () => Effect.sync(() => metadataUpdates++),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expectUnavailable(exit)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      expect((yield* sessions.get(foreign.id)).permission).toEqual(originalPermission)
      expect(prompts).toBe(0)
      expect(metadataUpdates).toBe(0)
    }),
  )
})
