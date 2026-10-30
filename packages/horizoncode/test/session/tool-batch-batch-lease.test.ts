/**
 * Reproduction for the two defects the 2026-10-29 live runs measured:
 *
 *   A3 — a turn that emits more than one `edit` loses every call after the first
 *        to `Edit denied: guarded operation set or lease changed` (28 occurrences),
 *        while every single-edit turn succeeds.
 *   A2 — `bash` intermittently fails with the bare tag `Pty.InvalidInputError`
 *        (6 of 19 calls) after the model sent `{command}` alone or
 *        `{command, workdir}`.
 *
 * The contract this file pins:
 *
 *   1. One ToolBatch = one Guard admission = ONE lease over the whole operation
 *      set, with per-call receipts. A host that repeats the same lease on every
 *      admitted member is describing exactly that and must not be read as a
 *      duplicate-lease fault.
 *   2. Two edits to the SAME file in one batch: member 2 prepares against the
 *      content member 1 will write and executes only after member 1 settles, so
 *      the final file holds both edits in order.
 *   3. The object Guard admits and the object the tool executes under is the same
 *      normalized `{command, cwd, timeoutMs}`, whatever shape the host echoes
 *      back. A raw `{command}` / `{command, workdir}` echo can never reach
 *      `Pty.runTool`.
 *
 * The Guard host is stubbed (a live EffectHost is not required to observe the
 * batch gate's own contract); the real `edit` admission projection, the real
 * `SessionTools.resolve` bash projection and the real `gateToolCallStream` batch
 * gate are driven unmodified.
 */

import { expect } from "bun:test"
import { Buffer } from "node:buffer"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@horizoncode/core/model"
import { ProviderV2 } from "@horizoncode/core/provider"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { FSUtil } from "@horizoncode/core/fs-util"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import type { EffectLease } from "@horizoncode/core/session/supervisor"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { WebSearchRuntime } from "@/tool/websearch-runtime"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import {
  createToolBatchContext,
  gateToolCallStream,
  toolBatchMemberChain,
  toolCallOutcome,
  type ToolBatchContext,
  type ToolBatchDefinition,
  type ToolBatchGateInput,
} from "../../src/session/tool-batch"
import { editToolBatchAdmission } from "../../src/session/tool-admission"
import { Parameters as EditParametersSchema } from "../../src/tool/edit"
import { isRecord } from "../../src/util/record"

const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

const bashTool: Tool.Def = {
  id: "bash",
  capability: { id: "terminal.run", effectClass: "effect" },
  description: "run a terminal command",
  parameters: Schema.Struct({
    command: Schema.String,
    workdir: Schema.optional(Schema.String),
    timeout: Schema.optional(Schema.Number),
  }),
  jsonSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      workdir: { type: "string" },
      timeout: { type: "number" },
    },
    required: ["command"],
  },
  execute: () => Effect.succeed({ title: "bash", metadata: {}, output: "unused" }),
}

const layer = Layer.mergeAll(
  LayerNode.compile(FSUtil.node),
  LayerNode.compile(WebSearchRuntime.node),
  Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    } satisfies Plugin.Interface),
  ),
  Layer.succeed(
    Permission.Service,
    Permission.Service.of({
      ask: () => Effect.void,
      reply: () => Effect.void,
      list: () => Effect.succeed([]),
    } satisfies Permission.Interface),
  ),
  Layer.succeed(
    MCP.Service,
    MCP.Service.of({ tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) } as Partial<MCP.Interface> as MCP.Interface),
  ),
  Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      cleanup: () => Effect.void,
      write: () => Effect.succeed("output.txt"),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
    } satisfies Truncate.Interface),
  ),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["bash"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () => Effect.succeed<Tool.Def[]>([bashTool]),
    }),
  ),
)

const it = testEffect(layer)

const finish = {
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool-calls" },
  usage: {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  },
} satisfies LanguageModelV3StreamPart

function toolCall(toolCallId: string, toolName: string, input: unknown): LanguageModelV3StreamPart {
  return { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }
}

function stream(parts: LanguageModelV3StreamPart[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

async function collect(source: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = source.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return parts
    parts.push(next.value)
  }
}

function gateInput(overrides: {
  readonly directory: string
  readonly definitions: Record<string, ToolBatchDefinition>
  readonly prepareToolBatch: ToolBatchGateInput["prepareToolBatch"]
  readonly context?: ToolBatchContext
}): ToolBatchGateInput {
  return {
    sessionID: "session_batch_lease",
    locationRef: Location.Ref.make({ directory: AbsolutePath.make(overrides.directory) }),
    turnContextDigest: `sha256:${"a".repeat(64)}`,
    signal: new AbortController().signal,
    definitions: overrides.definitions,
    prepareToolBatch: overrides.prepareToolBatch,
    cancelToolBatch: async () => {},
    context: overrides.context ?? createToolBatchContext(),
  }
}

function lease(effectID: string, seed: string): EffectLease {
  return { effectID, capabilityLeaseDigest: `blake3:${seed.repeat(64)}` }
}

/** The challenge a `files.patch` member's prepared operations must produce. */
function patchChallenge(callIDValue: string, args: unknown) {
  const operations = (isRecord(args) && Array.isArray(args.operations) ? args.operations : []) as ReadonlyArray<
    Record<string, unknown>
  >
  const targets = operations.map((operation) => ({
    target: String(operation.path),
    resource: path.basename(String(operation.path)),
    operation: operation.operation as "delete" | "run" | "write",
    existed: typeof operation.expectedBeforeBase64 === "string",
    ...(operation.operation === "write" ? { executable: false } : {}),
  }))
  const first = targets[0]!
  return {
    challengeID: `ch_${callIDValue}`,
    effectID: `eff_${callIDValue}`,
    target: first.target,
    resource: first.resource,
    existed: first.existed,
    targets,
  }
}

function runChallenge(callIDValue: string) {
  return {
    challengeID: `ch_${callIDValue}`,
    effectID: `eff_${callIDValue}`,
    target: "/workspace",
    resource: ".",
    existed: false,
  }
}

type PreparedOperations = ReadonlyArray<{
  readonly operation: "write" | "delete"
  readonly path: string
  readonly expectedBeforeBase64: string | null
  readonly contentBase64?: string
}>

function admittedExecution(context: ToolBatchContext, callIDValue: string): unknown {
  const outcome = toolCallOutcome(context, callIDValue)
  if (outcome?.status !== "prepared" && outcome?.status !== "admitted" && outcome?.status !== "no_effect") {
    throw new Error(`${callIDValue} has no admitted execution: ${JSON.stringify(outcome)}`)
  }
  return (outcome as { execution?: unknown }).execution
}

function preparedOperations(context: ToolBatchContext, callIDValue: string): PreparedOperations {
  const execution = admittedExecution(context, callIDValue)
  if (!Array.isArray(execution)) throw new Error(`${callIDValue} has no prepared operation set`)
  return execution as PreparedOperations
}

/**
 * The kernel's own reconcile step, reduced to what the test needs: a patch
 * operation applies only when the live bytes still equal the approved preimage.
 */
function applyOperations(operations: PreparedOperations): void {
  for (const operation of operations) {
    const current = existsSync(operation.path) ? readFileSync(operation.path, "utf8") : null
    const before = current === null ? null : Buffer.from(current, "utf8").toString("base64")
    if ((operation.expectedBeforeBase64 ?? null) !== before) {
      throw new Error(`CAS rejected ${operation.path}: the approved preimage is not the live file`)
    }
    if (operation.operation === "write") {
      writeFileSync(operation.path, Buffer.from(operation.contentBase64!, "base64").toString("utf8"))
    }
  }
}

/** Execute members in prepared order under the batch lease, exactly as tools.ts does. */
async function executeInPreparedOrder(context: ToolBatchContext, order: ReadonlyArray<string>): Promise<string[]> {
  const executed: string[] = []
  for (const callIDValue of order) {
    const chain = toolBatchMemberChain(callIDValue)
    if (chain?.predecessor) await chain.predecessor
    applyOperations(preparedOperations(context, callIDValue))
    executed.push(callIDValue)
    chain?.settle()
  }
  return executed
}

function processor(directory: string) {
  return {
    message: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      agent: "build",
      mode: "build",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 1 },
    } satisfies SessionV1.Assistant,
    updateToolCall: () => Effect.succeed({} as SessionV1.ToolPart),
    completeToolCall: () => Effect.void,
  } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
}

function editDefinition(directory: string, fs: FSUtil.Interface): ToolBatchDefinition {
  const admission = editToolBatchAdmission({ directory, fs, promise: (effect) => Effect.runPromise(effect) })
  return {
    capability: { id: "files.patch", effectClass: "effect" },
    schema: EditParametersSchema,
    validate: admission.validate,
    prepare: admission.prepare,
  }
}

it.instance("admits two edits in one batch under the one lease the batch was granted", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const fs = yield* FSUtil.Service
    const first = path.join(test.directory, "src", "alpha.ts")
    const second = path.join(test.directory, "src", "beta.ts")
    yield* fs.writeWithDirs(first, "export const alpha = 1\n")
    yield* fs.writeWithDirs(second, "export const beta = 2\n")

    // The host mints ONE lease for the batch operation set and repeats it on
    // every admitted member: exactly what "guarded operation set" names.
    const batchLease = lease("eff_batch", "b")
    const context = createToolBatchContext()
    const gate = gateInput({
      directory: test.directory,
      definitions: { edit: editDefinition(test.directory, fs) },
      context,
      prepareToolBatch: async (request) => ({
        status: "admitted_batch" as const,
        calls: request.calls.map((call) => ({
          callID: call.callID,
          capabilityID: call.capabilityID,
          challenge: patchChallenge(call.callID, call.arguments),
          lease: batchLease,
        })),
      }),
    })
    yield* Effect.promise(() =>
      collect(
        gateToolCallStream(
          stream([
            toolCall("call_alpha", "edit", {
              filePath: first,
              oldString: "export const alpha = 1",
              newString: "export const alpha = 11",
            }),
            toolCall("call_beta", "edit", {
              filePath: second,
              oldString: "export const beta = 2",
              newString: "export const beta = 22",
            }),
            finish,
          ]),
          gate,
        ),
      ),
    )

    // Every member of the batch executes under the SAME lease; a repeated lease
    // is the batch lease, never a duplicate-call fault.
    const leases: EffectLease[] = []
    for (const callIDValue of ["call_alpha", "call_beta"]) {
      const outcome = toolCallOutcome(context, callIDValue)
      expect({
        callID: callIDValue,
        status: outcome?.status,
        reason: outcome && "reason" in outcome ? outcome.reason : undefined,
      }).toEqual({ callID: callIDValue, status: "prepared", reason: undefined })
      if (outcome?.status !== "prepared") throw new Error(`${callIDValue} was not admitted under the batch lease`)
      leases.push(outcome.lease as EffectLease)
    }
    expect(leases.map((item) => item.effectID)).toEqual(["eff_batch", "eff_batch"])
    expect(new Set(leases.map((item) => item.capabilityLeaseDigest))).toEqual(
      new Set([batchLease.capabilityLeaseDigest]),
    )

    const executed = yield* Effect.promise(() => executeInPreparedOrder(context, ["call_alpha", "call_beta"]))
    expect(executed).toEqual(["call_alpha", "call_beta"])
    expect(yield* fs.readFileString(first)).toBe("export const alpha = 11\n")
    expect(yield* fs.readFileString(second)).toBe("export const beta = 22\n")
  }),
)

it.instance("two edits to the same file in one batch apply in order with no lost update", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const fs = yield* FSUtil.Service
    const target = path.join(test.directory, "src", "index.ts")
    const before = "export const alpha = 1\nexport const beta = 2\nexport const gamma = 3\n"
    yield* fs.writeWithDirs(target, before)

    const context = createToolBatchContext()
    const gate = gateInput({
      directory: test.directory,
      definitions: { edit: editDefinition(test.directory, fs) },
      context,
      prepareToolBatch: async (request) => ({
        status: "admitted_batch" as const,
        calls: request.calls.map((call, index) => ({
          callID: call.callID,
          capabilityID: call.capabilityID,
          challenge: patchChallenge(call.callID, call.arguments),
          // Distinct per-call leases so this case isolates the same-path chain
          // from the one-batch-lease contract above.
          lease: lease(`eff_${call.callID}`, index === 0 ? "c" : "d"),
        })),
      }),
    })
    yield* Effect.promise(() =>
      collect(
        gateToolCallStream(
          stream([
            toolCall("call_first_edit", "edit", {
              filePath: target,
              oldString: "export const alpha = 1",
              newString: "export const alpha = 11",
            }),
            toolCall("call_second_edit", "edit", {
              filePath: target,
              oldString: "export const gamma = 3",
              newString: "export const gamma = 33",
            }),
            finish,
          ]),
          gate,
        ),
      ),
    )

    // Member 2 must be prepared against member 1's output, not the pre-batch
    // bytes, and must be chained behind it.
    const firstOperations = preparedOperations(context, "call_first_edit")
    const secondOperations = preparedOperations(context, "call_second_edit")
    const staged = Buffer.from(
      Buffer.from(firstOperations[0]!.contentBase64!, "base64").toString("utf8"),
      "utf8",
    ).toString("base64")
    expect(secondOperations[0]!.expectedBeforeBase64).toBe(staged)
    expect(toolBatchMemberChain("call_second_edit")?.predecessor).toBeDefined()
    expect(toolBatchMemberChain("call_first_edit")?.predecessor).toBeUndefined()

    const executed = yield* Effect.promise(() =>
      executeInPreparedOrder(context, ["call_first_edit", "call_second_edit"]),
    )
    expect(executed).toEqual(["call_first_edit", "call_second_edit"])
    expect(yield* fs.readFileString(target)).toBe(
      "export const alpha = 11\nexport const beta = 2\nexport const gamma = 33\n",
    )
  }),
)

it.instance("normalizes terminal.run to exactly {command, cwd, timeoutMs} for every status", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const fs = yield* FSUtil.Service
    const resolved = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: processor(test.directory),
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const definition = resolved.definitions.bash
    if (!definition?.prepare) throw new Error("bash Guard preparation is missing")

    // The published normalizer always produces the three-key invocation, whether
    // the model sent just `{command}` or `{command, workdir}`.
    const bare = yield* Effect.promise(() => definition.prepare!({ command: "echo hi" }))
    const bareExecution = bare.execution as Record<string, unknown>
    expect(Object.keys(bareExecution).toSorted()).toEqual(["command", "cwd", "timeoutMs"])
    expect(bareExecution.command).toBe("echo hi")
    expect(bareExecution.cwd).toBe(path.resolve(test.directory))
    expect(Number.isSafeInteger(bareExecution.timeoutMs)).toBe(true)
    // Guard is asked to admit exactly the object the tool will execute under.
    expect(bare.arguments).toEqual(bareExecution)

    const withWorkdir = yield* Effect.promise(() => definition.prepare!({ command: "echo hi", workdir: "sub" }))
    const workdirExecution = withWorkdir.execution as Record<string, unknown>
    expect(Object.keys(workdirExecution).toSorted()).toEqual(["command", "cwd", "timeoutMs"])
    expect(workdirExecution.cwd).toBe(path.resolve(test.directory, "sub"))

    // What the batch gate forwards to Guard, and what it hands back to the tool.
    for (const casing of [
      { name: "bare command", args: { command: "echo hi" } },
      { name: "command and workdir", args: { command: "echo hi", workdir: "sub" } },
    ]) {
      const callIDValue = `call_${casing.name.replaceAll(" ", "_")}`
      const guarded: Array<Record<string, unknown>> = []
      const context = createToolBatchContext()
      const gate = gateInput({
        directory: test.directory,
        definitions: { bash: definition },
        context,
        prepareToolBatch: async (request) => {
          for (const call of request.calls) guarded.push(call.arguments as Record<string, unknown>)
          return {
            status: "admitted_batch" as const,
            calls: request.calls.map((call) => ({
              callID: call.callID,
              capabilityID: call.capabilityID,
              challenge: runChallenge(call.callID),
              lease: lease(`eff_${call.callID}`, "e"),
              // The wire shape that produced the bare `Pty.InvalidInputError`: the
              // admission row echoes the RAW model parameters as the execution.
              execution: casing.args,
            })),
          }
        },
      })
      yield* Effect.promise(() =>
        collect(gateToolCallStream(stream([toolCall(callIDValue, "bash", casing.args), finish]), gate)),
      )

      // 1. Guard received the normalized three-key invocation.
      expect(guarded).toHaveLength(1)
      expect(Object.keys(guarded[0]!).toSorted()).toEqual(["command", "cwd", "timeoutMs"])
      const expected = yield* Effect.promise(() => definition.prepare!(casing.args))
      expect(guarded[0]).toEqual(expected.execution as Record<string, unknown>)

      // 2. The tool executes under that same normalized object.
      const outcome = toolCallOutcome(context, callIDValue)
      expect(outcome?.status).toBe("prepared")
      const execution = admittedExecution(context, callIDValue) as Record<string, unknown>
      expect(Object.keys(execution).toSorted()).toEqual(["command", "cwd", "timeoutMs"])
      expect(execution).toEqual(expected.execution as Record<string, unknown>)
    }
  }),
)
