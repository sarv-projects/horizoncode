import { expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { isRecord } from "@/util/record"
import {
  createToolBatchContext,
  gateToolCallStream,
  requireToolExecution,
  toolCallOutcome,
  type ToolBatchDefinition,
  type ToolBatchGateInput,
} from "../../src/session/tool-batch"

const writeDefinition: ToolBatchDefinition = {
  capability: { id: "files.write", effectClass: "effect" },
  schema: {
    type: "object",
    properties: { filePath: { type: "string" }, content: { type: "string" } },
    required: ["filePath", "content"],
  },
  validate: async (value) => {
    if (!isRecord(value) || typeof value.filePath !== "string" || typeof value.content !== "string")
      throw new Error("invalid write")
    return value
  },
  normalize: (value) => {
    if (!isRecord(value) || typeof value.filePath !== "string" || typeof value.content !== "string")
      throw new Error("invalid write")
    return { path: value.filePath, content: value.content }
  },
}

const readDefinition: ToolBatchDefinition = {
  capability: { id: "files.read", effectClass: "read_only" },
  schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
  validate: async (value) => {
    if (!isRecord(value) || typeof value.filePath !== "string") throw new Error("invalid read")
    return value
  },
}
const questionDefinition: ToolBatchDefinition = {
  capability: { id: "question.ask", effectClass: "control" },
  schema: {
    type: "object",
    properties: { questions: { type: "array", items: { type: "object" } } },
    required: ["questions"],
  },
  validate: async (value) => {
    if (!isRecord(value) || !Array.isArray(value.questions)) throw new Error("invalid question.ask")
    return value
  },
}
const terminalDefinition: ToolBatchDefinition = {
  capability: { id: "terminal.run", effectClass: "effect" },
  schema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "integer" },
    },
    required: ["command", "cwd", "timeoutMs"],
    additionalProperties: false,
  },
  validate: async (value) => {
    if (
      !isRecord(value) ||
      typeof value.command !== "string" ||
      typeof value.cwd !== "string" ||
      typeof value.timeoutMs !== "number"
    )
      throw new Error("invalid terminal.run")
    return value
  },
}

const finish = {
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool-calls" },
  usage: {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  },
} satisfies LanguageModelV3StreamPart

function toolCall(toolCallId: string, toolName: string, input: string): LanguageModelV3StreamPart {
  return { type: "tool-call", toolCallId, toolName, input }
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
  const result: LanguageModelV3StreamPart[] = []
  const reader = source.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return result
    result.push(next.value)
  }
}

function gateInput(overrides: Partial<ToolBatchGateInput> = {}): ToolBatchGateInput {
  return {
    sessionID: "session_1",
    locationRef: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
    turnContextDigest: `sha256:${"a".repeat(64)}`,
    signal: new AbortController().signal,
    definitions: { write: writeDefinition, read: readDefinition, bash: terminalDefinition },
    prepareToolBatch: async () => ({
      status: "admitted",
      challenge: {
        challengeID: "ch_1",
        effectID: "eff_1",
        target: "/workspace/a.txt",
        resource: "a.txt",
        existed: false,
      },
    }),
    cancelToolBatch: async () => {},
    context: createToolBatchContext(),
    ...overrides,
  }
}


test("withholds tool calls without a complete terminal tool-call finish", async () => {
  const incomplete = [toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}')]
  const wrongFinish = [
    toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}'),
    { ...finish, finishReason: { unified: "stop", raw: "stop" } } satisfies LanguageModelV3StreamPart,
  ]

  for (const parts of [incomplete, wrongFinish]) {
    let preparations = 0
    const gate = gateInput({
      prepareToolBatch: async () => {
        preparations++
        return { status: "denied", reason: "unexpected" }
      },
    })
    await expect(collect(gateToolCallStream(stream(parts), gate))).rejects.toThrow(
      "Incomplete provider response; tool calls withheld",
    )
    expect(preparations).toBe(0)
    expect(gate.context.outcomes.size).toBe(0)
  }
})

test("child effects without Attempt-bound authority are denied before Rust preparation", async () => {
  let preparations = 0
  const gate = gateInput({
    parentSessionID: "session_parent",
    prepareToolBatch: async () => {
      preparations++
      return {
        status: "admitted" as const,
        challenge: {
          challengeID: "ch_child",
          effectID: "eff_child",
          target: "/workspace/a.txt",
          resource: "a.txt",
          existed: false,
        },
      }
    },
  })
  const parts = await collect(
    gateToolCallStream(
      stream([toolCall("child_write", "write", '{"filePath":"/workspace/a.txt","content":"child change"}'), finish]),
      gate,
    ),
  )
  let callbacks = 0
  for (const part of parts) {
    if (part.type !== "tool-call") continue
    try {
      requireToolExecution({ context: gate.context, callID: part.toolCallId, capability: writeDefinition.capability })
      callbacks++
    } catch {
      // A denied ToolBatch outcome must stop the callback before its effect body.
    }
  }

  expect(preparations).toBe(0)
  expect(callbacks).toBe(0)
  expect(toolCallOutcome(gate.context, "child_write")).toEqual({
    status: "denied",
    reason: "child effect requires Attempt-bound Rust authority",
  })
})

test("child read-only calls remain available without Attempt-bound effect authority", async () => {
  let preparations = 0
  const gate = gateInput({
    parentSessionID: "session_parent",
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "read-only calls should not reach Guard preparation" }
    },
  })
  const output = await collect(
    gateToolCallStream(
      stream([toolCall("child_read", "read", '{"filePath":"/workspace/a.txt"}'), finish]),
      gate,
    ),
  )

  expect(output.filter((part) => part.type === "tool-call")).toHaveLength(1)
  expect(preparations).toBe(0)
  expect(toolCallOutcome(gate.context, "child_read")).toEqual({ status: "allowed", capabilityID: "files.read" })
  expect(
    requireToolExecution({
      context: gate.context,
      callID: "child_read",
      capability: readDefinition.capability,
    }),
  ).toBeUndefined()
})

test("child effect batch binds every prepared effect atomically before exposing calls", async () => {
  const originalScope = {
    attemptID: "att_0123456789abcdef",
    parentSessionID: "session_parent",
    childSessionID: "session_1",
    ownerEpoch: "1",
    expectedRevision: "1",
    locationID: "loc_child",
    workspaceID: "wrk_child",
    workspaceRevision: "blake3:" + "a".repeat(64),
    capabilityDigest: "sha256:" + "b".repeat(64),
    permissionsDigest: "sha256:" + "c".repeat(64),
    budgetDigest: "sha256:" + "d".repeat(64),
    scopeDigest: "sha256:" + "e".repeat(64),
  }
  const refreshedScope = { ...originalScope, expectedRevision: "2" }
  let currentScope = originalScope
  let prepareScope: unknown
  let boundIDs: readonly string[] = []
  const gate = gateInput({
    parentSessionID: "session_parent",
    directAttempt: {
      currentScope: () => currentScope,
      bindBatch: async (request: { scope: typeof originalScope; effectIDs: readonly string[] }) => {
        expect(request.scope).toEqual(originalScope)
        boundIDs = request.effectIDs
        currentScope = refreshedScope
        return refreshedScope
      },
    },
    definitions: { write: writeDefinition, bash: terminalDefinition },
    prepareToolBatch: async (request: { directAttempt?: unknown }) => {
      prepareScope = request.directAttempt
      return {
        status: "admitted_batch" as const,
        calls: [
          {
            callID: "child_write_batch",
            capabilityID: "files.write",
            challenge: {
              challengeID: "ch_child_write",
              effectID: "eff_child_write",
              target: "/workspace/a.txt",
              resource: "a.txt",
              existed: false,
            },
          },
          {
            callID: "child_shell_batch",
            capabilityID: "terminal.run",
            challenge: {
              challengeID: "ch_child_shell",
              effectID: "eff_child_shell",
              target: "/workspace",
              resource: "workspace",
              existed: true,
            },
            execution: { command: "echo safe", cwd: "/workspace", timeoutMs: 1000 },
          },
        ],
      }
    },
  } as Partial<ToolBatchGateInput>)

  const output = await collect(
    gateToolCallStream(
      stream([
        toolCall("child_write_batch", "write", '{"filePath":"/workspace/a.txt","content":"child change"}'),
        toolCall("child_shell_batch", "bash", '{"command":"echo safe","cwd":"/workspace","timeoutMs":1000}'),
        finish,
      ]),
      gate,
    ),
  )

  expect(output.filter((part) => part.type === "tool-call")).toHaveLength(2)
  expect(prepareScope).toEqual(originalScope)
  expect(boundIDs).toEqual(["eff_child_write", "eff_child_shell"])
  expect(currentScope).toEqual(refreshedScope)
  expect(toolCallOutcome(gate.context, "child_write_batch")).toMatchObject({
    status: "admitted",
    directAttempt: refreshedScope,
  })
  expect(toolCallOutcome(gate.context, "child_shell_batch")).toMatchObject({
    status: "admitted",
    directAttempt: refreshedScope,
  })
})

test("child batch binding failure cancels and exposes no effect call", async () => {
  let cancellations = 0
  let callbacks = 0
  const scope = {
    attemptID: "att_0123456789abcdef",
    parentSessionID: "session_parent",
    childSessionID: "session_1",
    ownerEpoch: "1",
    expectedRevision: "1",
    locationID: "loc_child",
    workspaceID: "wrk_child",
    workspaceRevision: "blake3:" + "a".repeat(64),
    capabilityDigest: "sha256:" + "b".repeat(64),
    permissionsDigest: "sha256:" + "c".repeat(64),
    budgetDigest: "sha256:" + "d".repeat(64),
    scopeDigest: "sha256:" + "e".repeat(64),
  }
  const gate = gateInput({
    parentSessionID: "session_parent",
    directAttempt: {
      currentScope: () => scope,
      bindBatch: async () => {
        throw new Error("stale direct Attempt scope")
      },
    },
    prepareToolBatch: async () => ({
      status: "admitted" as const,
      challenge: {
        challengeID: "ch_child",
        effectID: "eff_child",
        target: "/workspace/a.txt",
        resource: "a.txt",
        existed: false,
      },
    }),
    cancelToolBatch: async () => {
      cancellations++
    },
  } as Partial<ToolBatchGateInput>)

  const output = await collect(
    gateToolCallStream(
      stream([toolCall("child_write_denied", "write", '{"filePath":"/workspace/a.txt","content":"no"}'), finish]),
      gate,
    ),
  )
  for (const part of output) {
    if (part.type !== "tool-call") continue
    try {
      requireToolExecution({ context: gate.context, callID: part.toolCallId, capability: writeDefinition.capability })
      callbacks++
    } catch {
      // Binding failure must withhold execution before the tool callback.
    }
  }

  expect(cancellations).toBe(1)
  expect(callbacks).toBe(0)
  expect(toolCallOutcome(gate.context, "child_write_denied")).toMatchObject({ status: "denied" })
})

test("child Attempt batches use the refreshed trusted revision on the next turn", async () => {
  const initial = {
    attemptID: "att_0123456789abcdef",
    parentSessionID: "session_parent",
    childSessionID: "session_1",
    ownerEpoch: "1",
    expectedRevision: "1",
    locationID: "loc_child",
    workspaceID: "wrk_child",
    workspaceRevision: "blake3:" + "a".repeat(64),
    capabilityDigest: "sha256:" + "b".repeat(64),
    permissionsDigest: "sha256:" + "c".repeat(64),
    budgetDigest: "sha256:" + "d".repeat(64),
    scopeDigest: "sha256:" + "e".repeat(64),
  }
  let current = initial
  const seenPrepare: string[] = []
  const seenBind: Array<{ revision: string; effectIDs: readonly string[] }> = []
  const gate = gateInput({
    parentSessionID: "session_parent",
    directAttempt: {
      currentScope: () => current,
      bindBatch: async ({ scope, effectIDs }) => {
        expect(scope.expectedRevision).toBe(current.expectedRevision)
        seenBind.push({ revision: String(scope.expectedRevision), effectIDs })
        current = { ...current, expectedRevision: String(Number(current.expectedRevision) + 1) }
        return current
      },
    },
    prepareToolBatch: async (request: { directAttempt?: typeof initial }) => {
      seenPrepare.push(request.directAttempt!.expectedRevision)
      const effectID = `effect_${request.directAttempt!.expectedRevision}`
      return {
        status: "admitted" as const,
        challenge: {
          challengeID: `challenge_${effectID}`,
          effectID,
          target: "/workspace/a.txt",
          resource: "a.txt",
          existed: false,
        },
      }
    },
  } as Partial<ToolBatchGateInput>)

  for (const [callID, expectedRevision] of [["child_turn_one", "1"], ["child_turn_two", "2"]] as const) {
    const output = await collect(
      gateToolCallStream(stream([toolCall(callID, "write", '{"filePath":"/workspace/a.txt","content":"x"}'), finish]), gate),
    )
    expect(output.filter((part) => part.type === "tool-call")).toHaveLength(1)
    expect(toolCallOutcome(gate.context, callID)).toMatchObject({
      status: "admitted",
      directAttempt: { ...initial, expectedRevision: String(Number(expectedRevision) + 1) },
    })
  }
  expect(seenPrepare).toEqual(["1", "2"])
  expect(seenBind).toEqual([
    { revision: "1", effectIDs: ["effect_1"] },
    { revision: "2", effectIDs: ["effect_2"] },
  ])
  expect(current.expectedRevision).toBe("3")
})

test("validates every child effect identity before binding the batch to its Attempt", async () => {
  const scope = {
    attemptID: "att_0123456789abcdef",
    parentSessionID: "session_parent",
    childSessionID: "session_1",
    ownerEpoch: "1",
    expectedRevision: "1",
    locationID: "loc_child",
    workspaceID: "wrk_child",
    workspaceRevision: "blake3:" + "a".repeat(64),
    capabilityDigest: "sha256:" + "b".repeat(64),
    permissionsDigest: "sha256:" + "c".repeat(64),
    budgetDigest: "sha256:" + "d".repeat(64),
    scopeDigest: "sha256:" + "e".repeat(64),
  }
  let bindings = 0
  let cancellations = 0
  const gate = gateInput({
    parentSessionID: "session_parent",
    directAttempt: {
      currentScope: () => scope,
      bindBatch: async () => {
        bindings++
        return { ...scope, expectedRevision: "2" }
      },
    },
    prepareToolBatch: async (request) => ({
      status: "admitted_batch",
      calls: request.calls.map((call, index) => ({
        callID: call.callID,
        capabilityID: call.capabilityID,
        challenge: {
          challengeID: `ch_${index}`,
          effectID: "eff_duplicated",
          target: `/workspace/${call.callID}.txt`,
          resource: `${call.callID}.txt`,
          existed: false,
        },
      })),
    }),
    cancelToolBatch: async () => {
      cancellations++
    },
  })

  await collect(
    gateToolCallStream(
      stream([
        toolCall("child_duplicate_a", "write", '{"filePath":"/workspace/a.txt","content":"a"}'),
        toolCall("child_duplicate_b", "write", '{"filePath":"/workspace/b.txt","content":"b"}'),
        finish,
      ]),
      gate,
    ),
  )

  expect(bindings).toBe(0)
  expect(cancellations).toBe(1)
  expect(toolCallOutcome(gate.context, "child_duplicate_a")).toMatchObject({ status: "denied" })
  expect(toolCallOutcome(gate.context, "child_duplicate_b")).toMatchObject({ status: "denied" })
})

test("a forged Attempt child or parent binding is denied before Guard preparation", async () => {
  let preparations = 0
  const scope = {
    attemptID: "att_0123456789abcdef",
    parentSessionID: "some_other_parent",
    childSessionID: "session_1",
    ownerEpoch: "1",
    expectedRevision: "1",
    locationID: "loc_child",
    workspaceID: "wrk_child",
    workspaceRevision: "blake3:" + "a".repeat(64),
    capabilityDigest: "sha256:" + "b".repeat(64),
    permissionsDigest: "sha256:" + "c".repeat(64),
    budgetDigest: "sha256:" + "d".repeat(64),
    scopeDigest: "sha256:" + "e".repeat(64),
  }
  const gate = gateInput({
    parentSessionID: "session_parent",
    directAttempt: { currentScope: () => scope, bindBatch: async () => scope },
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "must not reach Guard" }
    },
  } as Partial<ToolBatchGateInput>)
  await collect(
    gateToolCallStream(stream([toolCall("child_forged", "write", '{"filePath":"/workspace/a.txt","content":"x"}'), finish]), gate),
  )
  expect(preparations).toBe(0)
  expect(toolCallOutcome(gate.context, "child_forged")).toMatchObject({ status: "denied" })
})

test("withholds every tool callback until the whole response batch is denied", async () => {
  const calls: unknown[] = []
  const gate = gateInput({
    prepareToolBatch: async (request) => {
      calls.push(request)
      return { status: "denied", reason: "only_one_call_supported" }
    },
  })
  const output = await collect(
    gateToolCallStream(
      stream([
        toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}'),
        toolCall("call_read", "read", '{"filePath":"/workspace/a.txt"}'),
        finish,
      ]),
      gate,
    ),
  )
  const toolCalls = output.filter((part) => part.type === "tool-call")
  let callbacks = 0
  for (const call of toolCalls) {
    if (call.type !== "tool-call") continue
    const definition = gate.definitions[call.toolName]
    if (!definition) {
      callbacks++
      continue
    }
    try {
      requireToolExecution({
        context: gate.context,
        callID: call.toolCallId,
        capability: definition.capability,
        internal: definition.internal,
      })
      callbacks++
    } catch {
      // The callback gate rejects this member before its body can run.
    }
  }

  expect(calls).toHaveLength(1)
  const request = calls[0]
  expect(isRecord(request) && Array.isArray(request.calls) ? request.calls : undefined).toHaveLength(2)
  expect(callbacks).toBe(0)
  expect(toolCalls).toHaveLength(2)
  expect(output.at(-1)?.type).toBe("finish")
})

test("rejects malformed members for the complete batch before Guard preparation", async () => {
  let preparations = 0
  const gate = gateInput({
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "unexpected" }
    },
  })
  const output = await collect(
    gateToolCallStream(
      stream([
        toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":3}'),
        toolCall("call_read", "read", '{"filePath":"/workspace/a.txt"}'),
        finish,
      ]),
      gate,
    ),
  )
  let callbacks = 0
  for (const call of output) {
    if (call.type !== "tool-call") continue
    const definition = gate.definitions[call.toolName]
    if (!definition) {
      callbacks++
      continue
    }
    try {
      requireToolExecution({
        context: gate.context,
        callID: call.toolCallId,
        capability: definition.capability,
      })
      callbacks++
    } catch {
      // Invalid arguments reject the whole batch before the callback.
    }
  }

  expect(preparations).toBe(0)
  expect(callbacks).toBe(0)
})

test("attaches the Rust challenge to one admitted write callback", async () => {
  const gate = gateInput()
  const output = await collect(
    gateToolCallStream(
      stream([toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}'), finish]),
      gate,
    ),
  )
  const call = output.find((part) => part.type === "tool-call")
  expect(call?.type).toBe("tool-call")
  if (call?.type !== "tool-call") return
  const challenge = requireToolExecution({
    context: gate.context,
    callID: call.toolCallId,
    capability: writeDefinition.capability,
  })

  if (!challenge || !("challengeID" in challenge)) throw new Error("expected an admitted effect challenge")
  expect(challenge.challengeID).toBe("ch_1")
  expect(challenge.effectID).toBe("eff_1")
  expect(challenge.target).toBe("/workspace/a.txt")
})

test("denies an unsupported origin before Guard preparation", async () => {
  let preparations = 0
  const gate = gateInput({
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "unexpected" }
    },
  })
  const output = await collect(
    gateToolCallStream(stream([toolCall("call_mcp", "mcp_read", "{}"), finish]), gate),
  )
  const call = output.find((part) => part.type === "tool-call")
  expect(call?.type).toBe("tool-call")
  if (call?.type !== "tool-call") return

  expect(preparations).toBe(0)
  expect(() =>
    requireToolExecution({
      context: gate.context,
      callID: call.toolCallId,
      capability: { id: "mcp_read", effectClass: "unknown" },
    }),
  ).toThrow("unsupported tool: mcp_read")
})

test("fails closed when the session-owned Rust Guard is unavailable", async () => {
  const gate = gateInput({
    prepareToolBatch: async () => {
      throw new Error("session owner disappeared")
    },
  })
  const output = await collect(
    gateToolCallStream(
      stream([toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}'), finish]),
      gate,
    ),
  )
  const call = output.find((part) => part.type === "tool-call")
  expect(call?.type).toBe("tool-call")
  if (call?.type !== "tool-call") return
  expect(() =>
    requireToolExecution({
      context: gate.context,
      callID: call.toolCallId,
      capability: writeDefinition.capability,
    }),
  ).toThrow("Rust Guard unavailable")
}, 30_000)

test("does not admit or emit pending calls after cancellation", async () => {
  const controller = new AbortController()
  controller.abort()
  let preparations = 0
  const gate = gateInput({
    signal: controller.signal,
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "unexpected" }
    },
  })
  const reader = gateToolCallStream(
    stream([toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}'), finish]),
    gate,
  ).getReader()

  await expect(reader.read()).rejects.toThrow()
  expect(preparations).toBe(0)
  expect(gate.context.outcomes.size).toBe(0)
})

test("checks cancellation after asynchronous validation and before Guard preparation", async () => {
  const controller = new AbortController()
  let enterValidation!: () => void
  let releaseValidation!: () => void
  const validationStarted = new Promise<void>((resolve) => {
    enterValidation = resolve
  })
  const validationRelease = new Promise<void>((resolve) => {
    releaseValidation = resolve
  })
  let preparations = 0
  const gate = gateInput({
    signal: controller.signal,
    definitions: {
      write: {
        ...writeDefinition,
        validate: async (value) => {
          enterValidation()
          await validationRelease
          return writeDefinition.validate(value)
        },
      },
      read: readDefinition,
    },
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "unexpected" }
    },
  })
  const outputPromise = collect(
    gateToolCallStream(
      stream([toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}'), finish]),
      gate,
    ),
  )

  await validationStarted
  controller.abort()
  releaseValidation()
  await expect(outputPromise).rejects.toThrow()
  expect(preparations).toBe(0)
  expect(gate.context.outcomes.get("call_write")).toEqual({
    status: "denied",
    reason: "tool batch interrupted before Guard preparation",
  })
})

test("cancels the Rust batch when the provider turn aborts during Guard preparation", async () => {
  const controller = new AbortController()
  let enterPreparation!: () => void
  let releasePreparation!: () => void
  let batchID = ""
  const preparationStarted = new Promise<void>((resolve) => {
    enterPreparation = resolve
  })
  const preparationRelease = new Promise<void>((resolve) => {
    releasePreparation = resolve
  })
  const cancellations: Array<{ sessionID: string; batchID: string }> = []
  let preparationSignal: AbortSignal | undefined
  const gate = Object.assign(
    gateInput({
      signal: controller.signal,
      prepareToolBatch: async (request) => {
        preparationSignal = request.signal
        batchID = request.batchID
        enterPreparation()
        await preparationRelease
        return {
          status: "admitted" as const,
          challenge: {
            challengeID: "ch_cancelled",
            effectID: "eff_cancelled",
            target: "/workspace/a.txt",
            resource: "a.txt",
            existed: false,
          },
        }
      },
    }),
    {
      cancelToolBatch: async (input: { sessionID: string; batchID: string }) => {
        cancellations.push(input)
      },
    },
  )
  const outputPromise = collect(
    gateToolCallStream(
      stream([toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}'), finish]),
      gate,
    ),
  )

  await preparationStarted
  expect(preparationSignal).toBe(controller.signal)
  controller.abort(new Error("provider turn cancelled"))
  const cancellationsAtAbort = [...cancellations]
  releasePreparation()
  await expect(outputPromise).rejects.toThrow("provider turn cancelled")
  expect(cancellationsAtAbort).toEqual([])
  expect(cancellations).toEqual([{ sessionID: "session_1", batchID }])
  expect(gate.context.outcomes.get("call_write")).toEqual({
    status: "denied",
    reason: "tool batch interrupted before execution",
  })
})

test("cancels the Rust batch when provider abort races Guard preparation completion", async () => {
  const controller = new AbortController()
  const cancellations: Array<{ sessionID: string; batchID: string }> = []
  const gate = Object.assign(
    gateInput({
      signal: controller.signal,
      prepareToolBatch: async () => {
        controller.abort(new Error("provider turn cancelled"))
        return {
          status: "admitted" as const,
          challenge: {
            challengeID: "ch_cancelled",
            effectID: "eff_cancelled",
            target: "/workspace/a.txt",
            resource: "a.txt",
            existed: false,
          },
        }
      },
    }),
    {
      cancelToolBatch: async (input: { sessionID: string; batchID: string }) => {
        cancellations.push(input)
      },
    },
  )

  const outputPromise = collect(
    gateToolCallStream(
      stream([toolCall("call_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}'), finish]),
      gate,
    ),
  )

  await expect(outputPromise).rejects.toThrow("provider turn cancelled")
  expect(cancellations).toHaveLength(1)
  expect(gate.context.outcomes.get("call_write")).toEqual({
    status: "denied",
    reason: "tool batch interrupted before execution",
  })
})

test("EffectBridge promise interrupts its effect when its AbortSignal aborts", async () => {
  const bridge = await Effect.runPromise(EffectBridge.make())
  const controller = new AbortController()
  let release!: () => void
  const pending = bridge.promise(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    ),
    { signal: controller.signal },
  )

  controller.abort(new Error("provider turn cancelled"))
  release()

  await expect(pending).rejects.toThrow()
})

test("binds model terminal execution to a host-prepared one-use Guard lease", async () => {
  const lease = {
    effectID: "effect_terminal",
    capabilityLeaseDigest: `blake3:${"b".repeat(64)}`,
  }
  let request: unknown
  const gate = gateInput({
    prepareToolBatch: async (value) => {
      request = value
      const canonicalArguments = {
        command: "echo ok",
        cwd: "/workspace",
        timeoutMs: 1000,
        shellProfileID: "profile_linux_bash",
        resolvedEnvironment: {},
      }
      return {
        admission: { status: "prepared", lease },
        calls: value.calls.map((call) => ({ ...call, arguments: canonicalArguments })),
      }
    },
  })
  const output = await collect(
    gateToolCallStream(
      stream([
        toolCall("call_bash", "bash", '{"command":"echo ok","cwd":"/workspace","timeoutMs":1000}'),
        finish,
      ]),
      gate,
    ),
  )
  const call = output.find((part) => part.type === "tool-call")
  expect(call?.type).toBe("tool-call")
  if (call?.type !== "tool-call") return

  expect(request).toMatchObject({
    sessionID: "session_1",
    calls: [
      {
        callID: "call_bash",
        capabilityID: "terminal.run",
        arguments: { command: "echo ok", cwd: "/workspace", timeoutMs: 1000 },
      },
    ],
  })
  expect(gate.context.outcomes.get(call.toolCallId)).toMatchObject({
    status: "prepared",
    capabilityID: "terminal.run",
    lease,
    execution: {
      command: "echo ok",
      cwd: "/workspace",
      timeoutMs: 1000,
      shellProfileID: "profile_linux_bash",
      resolvedEnvironment: {},
    },
  })
  expect(
    requireToolExecution({
      context: gate.context,
      callID: call.toolCallId,
      capability: terminalDefinition.capability,
    }),
  ).toEqual(lease)
})

test("denies terminal execution when Guard admission skipped PTY profile preparation", async () => {
  const gate = gateInput({
    prepareToolBatch: async () => ({
      status: "prepared",
      lease: {
        effectID: "effect_terminal",
        capabilityLeaseDigest: `blake3:${"b".repeat(64)}`,
      },
    }),
  })
  await collect(
    gateToolCallStream(
      stream([toolCall("call_bash", "bash", '{"command":"echo ok","cwd":"/workspace","timeoutMs":1000}'), finish]),
      gate,
    ),
  )
  expect(gate.context.outcomes.get("call_bash")).toEqual({
    status: "denied",
    reason: "terminal.run requires PTY host preparation",
  })
})

test("denies malformed model terminal arguments before Guard preparation", async () => {
  let preparations = 0
  const gate = gateInput({
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "unexpected" }
    },
  })
  const output = await collect(
    gateToolCallStream(
      stream([toolCall("call_bash", "bash", '{"command":"echo ok","cwd":"/workspace"}'), finish]),
      gate,
    ),
  )
  const call = output.find((part) => part.type === "tool-call")
  expect(call?.type).toBe("tool-call")
  if (call?.type !== "tool-call") return
  expect(preparations).toBe(0)
  expect(() =>
    requireToolExecution({
      context: gate.context,
      callID: call.toolCallId,
      capability: terminalDefinition.capability,
    }),
  ).toThrow("invalid tool arguments")
})

test("bounds tool-call count before any read-only callback or Guard preparation", async () => {
  let preparations = 0
  const gate = gateInput({
    prepareToolBatch: async () => {
      preparations++
      throw new Error("should not prepare an oversized batch")
    },
  })
  const calls = Array.from({ length: 33 }, (_, index) =>
    toolCall(`read_${index}`, "read", '{"filePath":"/workspace/a.txt"}'),
  )
  await expect(collect(gateToolCallStream(stream([...calls, finish]), gate))).rejects.toThrow(
    "Tool batch limit exceeded: call count",
  )
  expect(preparations).toBe(0)
  expect(gate.context.outcomes.size).toBe(0)
})

test("rejects excessive individual tool arguments before parsing or Guard", async () => {
  let validations = 0
  let preparations = 0
  const gate = gateInput({
    definitions: {
      read: {
        ...readDefinition,
        validate: async (value) => {
          validations++
          return readDefinition.validate(value)
        },
      },
    },
    prepareToolBatch: async () => {
      preparations++
      throw new Error("must not reach Guard")
    },
  })
  const huge = JSON.stringify({ filePath: "/workspace/a.txt", padding: "x".repeat(256 * 1024) })
  await expect(
    collect(gateToolCallStream(stream([toolCall("read_huge", "read", huge), finish]), gate)),
  ).rejects.toThrow("Tool batch limit exceeded: argument bytes")
  expect(validations).toBe(0)
  expect(preparations).toBe(0)
  expect(gate.context.outcomes.size).toBe(0)
})

test("rejects excessive aggregate arguments even for individually valid read calls", async () => {
  let validations = 0
  let preparations = 0
  const gate = gateInput({
    definitions: {
      read: {
        ...readDefinition,
        validate: async (value) => {
          validations++
          return readDefinition.validate(value)
        },
      },
    },
    prepareToolBatch: async () => {
      preparations++
      throw new Error("must not reach Guard")
    },
  })
  const payload = JSON.stringify({ filePath: "/workspace/a.txt", padding: "x".repeat(180 * 1024) })
  const calls = [1, 2, 3].map((i) => toolCall(`read_${i}`, "read", payload))
  await expect(collect(gateToolCallStream(stream([...calls, finish]), gate))).rejects.toThrow(
    "Tool batch limit exceeded: aggregate argument bytes",
  )
  expect(validations).toBe(0)
  expect(preparations).toBe(0)
  expect(gate.context.outcomes.size).toBe(0)
})

test("rejects oversized tool identity fields without tool dispatch", async () => {
  for (const entry of [
    toolCall("x".repeat(300), "read", '{"filePath":"a"}'),
    toolCall("read_id", "x".repeat(300), "{}"),
  ]) {
    const gate = gateInput()
    await expect(collect(gateToolCallStream(stream([entry, finish]), gate))).rejects.toThrow(
      "Tool batch limit exceeded: tool identity",
    )
    expect(gate.context.outcomes.size).toBe(0)
  }
})

test("accepts the documented maximum of 32 bounded read-only calls", async () => {
  let preparations = 0
  const gate = gateInput({
    prepareToolBatch: async () => {
      preparations++
      throw new Error("read-only batch should not touch Rust")
    },
  })
  const calls = Array.from({ length: 32 }, (_, index) =>
    toolCall(`read_${index}`, "read", '{"filePath":"/workspace/a.txt"}'),
  )
  const output = await collect(gateToolCallStream(stream([...calls, finish]), gate))
  expect(output.filter((part) => part.type === "tool-call")).toHaveLength(32)
  expect(preparations).toBe(0)
  for (const call of calls) {
    if (call.type !== "tool-call") continue
    expect(
      requireToolExecution({
        context: gate.context,
        callID: call.toolCallId,
        capability: readDefinition.capability,
      }),
    ).toBeUndefined()
  }
})

test("oversized sibling cannot dispatch or Guard-admit an otherwise valid write", async () => {
  let preparations = 0
  const gate = gateInput({
    prepareToolBatch: async () => {
      preparations++
      throw new Error("whole batch should be rejected by the stream limit")
    },
  })
  const oversized = JSON.stringify({ filePath: "/workspace/a.txt", padding: "x".repeat(256 * 1024) })
  await expect(
    collect(
      gateToolCallStream(
        stream([
          toolCall("first_write", "write", '{"filePath":"/workspace/a.txt","content":"new"}'),
          toolCall("bad_read", "read", oversized),
          finish,
        ]),
        gate,
      ),
    ),
  ).rejects.toThrow("Tool batch limit exceeded: argument bytes")
  expect(preparations).toBe(0)
  expect(gate.context.outcomes.size).toBe(0)
  expect(() =>
    requireToolExecution({ context: gate.context, callID: "first_write", capability: writeDefinition.capability }),
  ).toThrow("missing validated ToolBatch admission")
})

test("read-only callback requires a completed, validated ToolBatch outcome", () => {
  const gate = gateInput()
  expect(() =>
    requireToolExecution({
      context: gate.context,
      callID: "read_without_batch",
      capability: readDefinition.capability,
    }),
  ).toThrow("missing validated ToolBatch admission")
  expect(() =>
    requireToolExecution({
      context: undefined,
      callID: "read_without_context",
      capability: readDefinition.capability,
    }),
  ).toThrow("missing validated ToolBatch admission")
})

test("control callbacks require a completed validated internal-control batch", () => {
  const control = { id: "tool.noop", effectClass: "control" } as const
  expect(() =>
    requireToolExecution({ context: createToolBatchContext(), callID: "control_unchecked", capability: control, internal: true }),
  ).toThrow("missing validated ToolBatch admission")
})

test("question.ask is admitted only as the canonical standalone control tool", async () => {
  let preparations = 0
  const gate = gateInput({
    definitions: { question: questionDefinition },
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "question.ask must not reach Guard preparation" }
    },
  })
  const output = await collect(
    gateToolCallStream(
      stream([toolCall("question_one", "question", '{"questions":[{"question":"Which option?"}]}'), finish]),
      gate,
    ),
  )

  expect(output.filter((part) => part.type === "tool-call")).toHaveLength(1)
  expect(preparations).toBe(0)
  expect(toolCallOutcome(gate.context, "question_one")).toEqual({
    status: "allowed",
    capabilityID: "question.ask",
  })
  expect(
    requireToolExecution({
      context: gate.context,
      callID: "question_one",
      toolName: "question",
      capability: questionDefinition.capability,
    }),
  ).toBeUndefined()
})

test("spoofed question.ask tool names are denied before Guard preparation and callback", async () => {
  let preparations = 0
  const gate = gateInput({
    definitions: { question_alias: questionDefinition },
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "spoofed control reached Guard" }
    },
  })
  await collect(
    gateToolCallStream(
      stream([toolCall("spoofed_question", "question_alias", '{"questions":[]}'), finish]),
      gate,
    ),
  )

  expect(preparations).toBe(0)
  expect(toolCallOutcome(gate.context, "spoofed_question")).toEqual({
    status: "denied",
    reason: "unsupported control capability",
  })
  expect(() =>
    requireToolExecution({
      context: gate.context,
      callID: "spoofed_question",
      toolName: "question_alias",
      capability: questionDefinition.capability,
    }),
  ).toThrow("Tool batch denied: unsupported control capability")
})

test("question.ask mixed with an effect call denies the complete batch before Guard or callbacks", async () => {
  let preparations = 0
  const gate = gateInput({
    definitions: { question: questionDefinition, write: writeDefinition },
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "mixed batch reached Guard" }
    },
  })
  await collect(
    gateToolCallStream(
      stream([
        toolCall("question_mixed", "question", '{"questions":[{"question":"Proceed?"}]}'),
        toolCall("write_mixed", "write", '{"filePath":"/workspace/a.txt","content":"new"}'),
        finish,
      ]),
      gate,
    ),
  )

  expect(preparations).toBe(0)
  expect(toolCallOutcome(gate.context, "question_mixed")).toEqual({
    status: "denied",
    reason: "control capability must be used in a standalone batch",
  })
  expect(toolCallOutcome(gate.context, "write_mixed")).toEqual({
    status: "denied",
    reason: "control capability must be used in a standalone batch",
  })
  expect(() =>
    requireToolExecution({
      context: gate.context,
      callID: "write_mixed",
      toolName: "write",
      capability: writeDefinition.capability,
    }),
  ).toThrow("Tool batch denied: control capability must be used in a standalone batch")
})

test("question.ask malformed JSON is denied as invalid arguments before Guard admission", async () => {
  let preparations = 0
  const gate = gateInput({
    definitions: { question: questionDefinition },
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "malformed question reached Guard" }
    },
  })
  await collect(gateToolCallStream(stream([toolCall("question_bad_json", "question", '{"questions":'), finish]), gate))

  expect(preparations).toBe(0)
  expect(toolCallOutcome(gate.context, "question_bad_json")).toEqual({
    status: "denied",
    reason: "invalid tool arguments",
  })
  expect(() =>
    requireToolExecution({
      context: gate.context,
      callID: "question_bad_json",
      toolName: "question",
      capability: questionDefinition.capability,
    }),
  ).toThrow("Tool batch denied: invalid tool arguments")
})

test("validated read call ID cannot be reused for another capability", async () => {
  const gate = gateInput()
  await collect(gateToolCallStream(stream([toolCall("read_one", "read", '{"filePath":"a"}'), finish]), gate))
  expect(() =>
    requireToolExecution({
      context: gate.context,
      callID: "read_one",
      capability: { id: "repo.search", effectClass: "read_only" },
    }),
  ).toThrow("capability does not match")
  expect(
    requireToolExecution({ context: gate.context, callID: "read_one", capability: readDefinition.capability }),
  ).toBeUndefined()
})

test("Guard challenge is bound to the admitted capability, not only the call ID", async () => {
  const gate = gateInput()
  await collect(
    gateToolCallStream(
      stream([toolCall("write_one", "write", '{"filePath":"/workspace/a.txt","content":"new"}'), finish]),
      gate,
    ),
  )
  expect(() =>
    requireToolExecution({
      context: gate.context,
      callID: "write_one",
      capability: { id: "shell.exec", effectClass: "effect" },
    }),
  ).toThrow("capability does not match")
  expect(
    requireToolExecution({ context: gate.context, callID: "write_one", capability: writeDefinition.capability }),
  )?.toMatchObject({ challengeID: "ch_1" })
})

test("internal marker never bypasses Rust admission for effectful capabilities", async () => {
  const gate = gateInput({
    definitions: { write: { ...writeDefinition, internal: true } },
    prepareToolBatch: async () => ({ status: "denied", reason: "no internal effect bypass" }),
  })
  const parts = await collect(
    gateToolCallStream(
      stream([toolCall("write_internal", "write", '{"filePath":"/workspace/a.txt","content":"new"}'), finish]),
      gate,
    ),
  )
  expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(1)
  expect(() =>
    requireToolExecution({ context: gate.context, callID: "write_internal", capability: writeDefinition.capability, internal: true }),
  ).toThrow("no internal effect bypass")
})

test("bounds streaming tool-call argument deltas before terminal assembly", async () => {
  const gate = gateInput()
  const chunk = "x".repeat(160 * 1024)
  const streaming = [
    { type: "tool-input-start", id: "stream_read", toolName: "read" },
    { type: "tool-input-delta", id: "stream_read", delta: chunk },
    { type: "tool-input-delta", id: "stream_read", delta: chunk },
  ] satisfies LanguageModelV3StreamPart[]
  await expect(collect(gateToolCallStream(stream([...streaming, finish]), gate))).rejects.toThrow(
    "Tool batch limit exceeded: streamed argument bytes",
  )
  expect(gate.context.outcomes.size).toBe(0)
})

test("an uncompleted streaming tool input never receives a callback admission", async () => {
  const gate = gateInput()
  const parts = [
    { type: "tool-input-start", id: "ghost_read", toolName: "read" },
    { type: "tool-input-delta", id: "ghost_read", delta: '{"filePath":"x"}' },
    finish,
  ] satisfies LanguageModelV3StreamPart[]
  await expect(collect(gateToolCallStream(stream(parts), gate))).rejects.toThrow(
    "Incomplete provider response; tool calls withheld",
  )
  expect(gate.context.outcomes.size).toBe(0)
})

test("streaming tool name must match the canonical terminal call", async () => {
  const gate = gateInput()
  const parts = [
    { type: "tool-input-start", id: "swapped", toolName: "read" },
    toolCall("swapped", "write", '{"filePath":"/workspace/a.txt","content":"new"}'),
    finish,
  ] satisfies LanguageModelV3StreamPart[]
  await expect(collect(gateToolCallStream(stream(parts), gate))).rejects.toThrow(
    "Tool batch denied: streaming tool identity mismatch",
  )
  expect(gate.context.outcomes.size).toBe(0)
})

test("legitimate streaming tool deltas retain an accepted terminal read call", async () => {
  const gate = gateInput()
  const parts = [
    { type: "tool-input-start", id: "read_stream", toolName: "read" },
    { type: "tool-input-delta", id: "read_stream", delta: '{"filePath":' },
    { type: "tool-input-delta", id: "read_stream", delta: '"a.txt"}' },
    toolCall("read_stream", "read", '{"filePath":"a.txt"}'),
    finish,
  ] satisfies LanguageModelV3StreamPart[]
  const output = await collect(gateToolCallStream(stream(parts), gate))
  expect(output.some((part) => part.type === "tool-call")).toBe(true)
  expect(
    requireToolExecution({ context: gate.context, callID: "read_stream", capability: readDefinition.capability }),
  ).toBeUndefined()
})

test("bounds aggregate streamed tool inputs even when each stays below its own limit", async () => {
  const gate = gateInput()
  const parts: LanguageModelV3StreamPart[] = []
  for (let index = 0; index < 4; index++) {
    parts.push({ type: "tool-input-start", id: `stream_${index}`, toolName: "read" })
    parts.push({ type: "tool-input-delta", id: `stream_${index}`, delta: "x".repeat(150 * 1024) })
  }
  await expect(collect(gateToolCallStream(stream([...parts, finish]), gate))).rejects.toThrow(
    "Tool batch limit exceeded: aggregate streamed argument bytes",
  )
  expect(gate.context.outcomes.size).toBe(0)
})

test("bounds the number of streaming tool IDs independently of terminal calls", async () => {
  const gate = gateInput()
  const parts: LanguageModelV3StreamPart[] = Array.from({ length: 33 }, (_, index) => ({
    type: "tool-input-start",
    id: `stream_${index}`,
    toolName: "read",
  }))
  await expect(collect(gateToolCallStream(stream([...parts, finish]), gate))).rejects.toThrow(
    "Tool batch limit exceeded: streaming call count",
  )
  expect(gate.context.outcomes.size).toBe(0)
})


test("turn cancellation interrupts a stalled provider before any ToolBatch admission", async () => {
  const controller = new AbortController()
  let preparations = 0
  let upstreamCancelled = false
  const gate = gateInput({
    signal: controller.signal,
    prepareToolBatch: async () => {
      preparations++
      throw new Error("cancelled response must not reach Guard")
    },
  })
  const provider = new ReadableStream<LanguageModelV3StreamPart>({
    start(stream) {
      stream.enqueue({ type: "tool-input-start", id: "never_finished", toolName: "write" })
      // Simulate a provider that never emits a terminal call or finish frame.
    },
    cancel() {
      upstreamCancelled = true
    },
  })
  const output = gateToolCallStream(provider, gate)
  const reader = output.getReader()
  const initial = await reader.read()
  expect(initial.value?.type).toBe("tool-input-start")
  const pending = reader.read()
  controller.abort(new Error("turn cancelled"))
  await expect(pending).rejects.toThrow()
  expect(preparations).toBe(0)
  expect(gate.context.outcomes.size).toBe(0)
  expect(upstreamCancelled).toBe(true)
})

test("denies streamed delta and end frames without a matching start before any Guard admission", async () => {
  for (const orphan of [
    { type: "tool-input-delta", id: "orphan", delta: '{"filePath":"a"}' },
    { type: "tool-input-end", id: "orphan" },
  ] satisfies LanguageModelV3StreamPart[]) {
    let preparations = 0
    const gate = gateInput({
      prepareToolBatch: async () => {
        preparations++
        throw new Error("malformed stream must never reach Guard")
      },
    })
    await expect(
      collect(gateToolCallStream(stream([orphan, toolCall("orphan", "write", '{"filePath":"/workspace/a.txt","content":"x"}'), finish]), gate)),
    ).rejects.toThrow("Tool batch denied: streamed input without start")
    expect(gate.context.outcomes.size).toBe(0)
    expect(preparations).toBe(0)
  }
})

test("denies duplicate stream starts for one call ID before effect dispatch", async () => {
  const gate = gateInput()
  await expect(
    collect(gateToolCallStream(stream([
      { type: "tool-input-start", id: "dup", toolName: "write" },
      { type: "tool-input-start", id: "dup", toolName: "write" },
      toolCall("dup", "write", '{"filePath":"/workspace/a.txt","content":"x"}'),
      finish,
    ]), gate)),
  ).rejects.toThrow("Tool batch denied: duplicate streaming input start")
  expect(gate.context.outcomes.size).toBe(0)
})

test("denies stream deltas or repeated end frames after input has ended", async () => {
  for (const late of [
    { type: "tool-input-delta", id: "ended", delta: "extra" },
    { type: "tool-input-end", id: "ended" },
  ] satisfies LanguageModelV3StreamPart[]) {
    const gate = gateInput()
    await expect(
      collect(gateToolCallStream(stream([
        { type: "tool-input-start", id: "ended", toolName: "read" },
        { type: "tool-input-end", id: "ended" },
        late,
        toolCall("ended", "read", '{"filePath":"a"}'),
        finish,
      ]), gate)),
    ).rejects.toThrow("Tool batch denied: streamed input after end")
    expect(gate.context.outcomes.size).toBe(0)
  }
})

test("denies extra partial frames after the terminal call for that ID", async () => {
  const gate = gateInput()
  await expect(
    collect(gateToolCallStream(stream([
      { type: "tool-input-start", id: "terminal", toolName: "write" },
      toolCall("terminal", "write", '{"filePath":"/workspace/a.txt","content":"x"}'),
      { type: "tool-input-delta", id: "terminal", delta: "late" },
      finish,
    ]), gate)),
  ).rejects.toThrow("Tool batch denied: streamed input after terminal call")
  expect(gate.context.outcomes.size).toBe(0)
})

test("accepts completed start/delta/end sequence with matching terminal call", async () => {
  const gate = gateInput()
  const output = await collect(gateToolCallStream(stream([
    { type: "tool-input-start", id: "valid", toolName: "read" },
    { type: "tool-input-delta", id: "valid", delta: '{"filePath":"a"}' },
    { type: "tool-input-end", id: "valid" },
    toolCall("valid", "read", '{"filePath":"a"}'),
    finish,
  ]), gate))
  expect(output.some((part) => part.type === "tool-call")).toBe(true)
  expect(requireToolExecution({
    context: gate.context,
    callID: "valid",
    capability: readDefinition.capability,
  })).toBeUndefined()
})


test("hard stream lifetime cancels a silent provider without admitting a write", async () => {
  let preparations = 0
  let cancelled = false
  const gate = gateInput({
    maxStreamDurationMs: 25,
    prepareToolBatch: async () => {
      preparations++
      throw new Error("timed-out response must never reach Guard")
    },
  })
  const provider = new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "tool-input-start", id: "timed_out_write", toolName: "write" })
    },
    cancel() {
      cancelled = true
    },
  })
  const reader = gateToolCallStream(provider, gate).getReader()
  expect((await reader.read()).value?.type).toBe("tool-input-start")
  await expect(reader.read()).rejects.toThrow()
  expect(preparations).toBe(0)
  expect(gate.context.outcomes.size).toBe(0)
  expect(cancelled).toBe(true)
})

const patchDefinition: ToolBatchDefinition = {  capability: { id: "files.patch", effectClass: "effect" },
  schema: {
    type: "object",
    properties: { operations: { type: "array" } },
    required: ["operations"],
  },
  validate: async (value) => {
    if (!isRecord(value) || !Array.isArray(value.operations)) throw new Error("invalid patch")
    return value
  },
}

function effectChallenge(
  callID: string,
  overrides: { target?: string; resource?: string; operation?: "write" | "delete" } = {},
) {
  return {
    challengeID: `ch_${callID}`,
    effectID: `eff_${callID}`,
    target: overrides.target ?? `/workspace/${callID}.txt`,
    resource: overrides.resource ?? `${callID}.txt`,
    existed: false,
    targets: [
      {
        target: overrides.target ?? `/workspace/${callID}.txt`,
        resource: overrides.resource ?? `${callID}.txt`,
        operation: overrides.operation ?? ("write" as const),
        existed: false,
      },
    ],
  }
}

test("admits a complete multi-call batch with one challenge per member", async () => {
  const gate = gateInput({
    definitions: { ...gateInput().definitions, patch: patchDefinition },
    prepareToolBatch: async (request) => ({
      status: "admitted_batch",
      calls: request.calls.map((call) => ({
        callID: call.callID,
        capabilityID: call.capabilityID,
        challenge: effectChallenge(call.callID),
      })),
    }),
  })
  const output = await collect(
    gateToolCallStream(
      stream([
        toolCall("call_first", "write", '{"filePath":"/workspace/call_first.txt","content":"one"}'),
        toolCall("call_second", "write", '{"filePath":"/workspace/call_second.txt","content":"two"}'),
        finish,
      ]),
      gate,
    ),
  )
  expect(output.filter((part) => part.type === "tool-call")).toHaveLength(2)
  expect(gate.context.outcomes.size).toBe(2)
  const first = requireToolExecution({
    context: gate.context,
    callID: "call_first",
    capability: writeDefinition.capability,
  })
  const second = requireToolExecution({
    context: gate.context,
    callID: "call_second",
    capability: writeDefinition.capability,
  })
  expect(first && "challengeID" in first ? first.challengeID : undefined).toBe("ch_call_first")
  expect(second && "challengeID" in second ? second.challengeID : undefined).toBe("ch_call_second")
})

test("withholds the complete multi-call batch when an admitted member is missing", async () => {
  const gate = gateInput({
    prepareToolBatch: async (request) => ({
      status: "admitted_batch",
      calls: [
        {
          callID: request.calls[0]!.callID,
          capabilityID: request.calls[0]!.capabilityID,
          challenge: effectChallenge(request.calls[0]!.callID),
        },
      ],
    }),
  })
  const output = await collect(
    gateToolCallStream(
      stream([
        toolCall("call_one", "write", '{"filePath":"/workspace/call_one.txt","content":"one"}'),
        toolCall("call_two", "write", '{"filePath":"/workspace/call_two.txt","content":"two"}'),
        finish,
      ]),
      gate,
    ),
  )
  expect(output.filter((part) => part.type === "tool-call")).toHaveLength(2)
  expect(gate.context.outcomes.size).toBe(2)
  for (const callID of ["call_one", "call_two"]) {
    expect(() =>
      requireToolExecution({ context: gate.context, callID, capability: writeDefinition.capability }),
    ).toThrow("Tool batch denied")
  }
})

test("withholds the complete multi-call batch when the admission mismatches a call", async () => {
  for (const mutate of [
    (calls: Array<{ callID: string; capabilityID: string; challenge: ReturnType<typeof effectChallenge> }>) => {
      calls[1]!.callID = "call_other"
    },
    (calls: Array<{ callID: string; capabilityID: string; challenge: ReturnType<typeof effectChallenge> }>) => {
      calls[1]!.capabilityID = "files.patch"
    },
    (calls: Array<{ callID: string; capabilityID: string; challenge: ReturnType<typeof effectChallenge> }>) => {
      calls[1]!.challenge = { ...calls[1]!.challenge, effectID: "" }
    },
    (calls: Array<{ callID: string; capabilityID: string; challenge: ReturnType<typeof effectChallenge> }>) => {
      calls[1] = { ...calls[0]! }
    },
  ]) {
    const gate = gateInput({
      prepareToolBatch: async (request) => {
        const calls = request.calls.map((call) => ({
          callID: call.callID,
          capabilityID: call.capabilityID,
          challenge: effectChallenge(call.callID),
        }))
        mutate(calls)
        return { status: "admitted_batch", calls }
      },
    })
    await collect(
      gateToolCallStream(
        stream([
          toolCall("call_alpha", "write", '{"filePath":"/workspace/call_alpha.txt","content":"a"}'),
          toolCall("call_beta", "write", '{"filePath":"/workspace/call_beta.txt","content":"b"}'),
          finish,
        ]),
        gate,
      ),
    )
    expect(gate.context.outcomes.size).toBe(2)
    for (const callID of ["call_alpha", "call_beta"]) {
      expect(() =>
        requireToolExecution({ context: gate.context, callID, capability: writeDefinition.capability }),
      ).toThrow("Tool batch denied")
    }
  }
})

test("refuses a patch challenge whose target set does not match its operations", async () => {  const gate = gateInput({
    definitions: { ...gateInput().definitions, patch: patchDefinition },
    prepareToolBatch: async () => ({
      status: "admitted_batch",
      calls: [
        {
          callID: "call_patch",
          capabilityID: "files.patch",
          challenge: {
            challengeID: "ch_call_patch",
            effectID: "eff_call_patch",
            target: "/workspace/other.txt",
            resource: "other.txt",
            existed: false,
            targets: [
              { target: "/workspace/other.txt", resource: "other.txt", operation: "delete", existed: true },
            ],
          },
        },
      ],
    }),
  })
  await collect(
    gateToolCallStream(
      stream([
        toolCall(
          "call_patch",
          "patch",
          JSON.stringify({
            operations: [{ operation: "write", path: "/workspace/patch.txt", expectedBeforeBase64: null, contentBase64: "eA==" }],
          }),
        ),
        finish,
      ]),
      gate,
    ),
  )
  expect(gate.context.outcomes.size).toBe(1)
  expect(() =>
    requireToolExecution({ context: gate.context, callID: "call_patch", capability: patchDefinition.capability }),
  ).toThrow("Tool batch denied")
})

test("admits a prepared multi-call batch with one one-use lease per member", async () => {
  const lease = (callID: string) => ({
    effectID: `eff_${callID}`,
    capabilityLeaseDigest: `blake3:${"b".repeat(64)}`,
  })
  const gate = gateInput({
    prepareToolBatch: async (request) => ({
      status: "prepared_batch",
      calls: request.calls.map((call) => ({
        callID: call.callID,
        capabilityID: call.capabilityID,
        lease: lease(call.callID),
      })),
    }),
  })
  const output = await collect(
    gateToolCallStream(
      stream([
        toolCall("call_left", "write", '{"filePath":"/workspace/call_left.txt","content":"one"}'),
        toolCall("call_right", "write", '{"filePath":"/workspace/call_right.txt","content":"two"}'),
        finish,
      ]),
      gate,
    ),
  )
  expect(output.filter((part) => part.type === "tool-call")).toHaveLength(2)
  for (const callID of ["call_left", "call_right"]) {
    const effect = requireToolExecution({
      context: gate.context,
      callID,
      capability: writeDefinition.capability,
    })
    expect(effect && "capabilityLeaseDigest" in effect ? effect.capabilityLeaseDigest : undefined).toBe(
      lease(callID).capabilityLeaseDigest,
    )
    expect(effect && "effectID" in effect ? effect.effectID : undefined).toBe(`eff_${callID}`)
  }
})

test("withholds the complete prepared batch when a member lease is missing or mismatched", async () => {
  for (const mutate of [
    (calls: Array<{ callID: string; capabilityID: string; lease: { effectID: string; capabilityLeaseDigest: string } }>) => {
      calls.pop()
    },
    (calls: Array<{ callID: string; capabilityID: string; lease: { effectID: string; capabilityLeaseDigest: string } }>) => {
      calls[1]!.callID = "call_missing"
    },
    (calls: Array<{ callID: string; capabilityID: string; lease: { effectID: string; capabilityLeaseDigest: string } }>) => {
      calls[1]!.capabilityID = "files.patch"
    },
    (calls: Array<{ callID: string; capabilityID: string; lease: { effectID: string; capabilityLeaseDigest: string } }>) => {
      calls[1]!.lease = { effectID: "eff_1", capabilityLeaseDigest: "not-a-digest" }
    },
    (calls: Array<{ callID: string; capabilityID: string; lease: { effectID: string; capabilityLeaseDigest: string } }>) => {
      calls[1] = { ...calls[0]! }
    },
  ]) {
    const gate = gateInput({
      prepareToolBatch: async (request) => {
        const calls = request.calls.map((call) => ({
          callID: call.callID,
          capabilityID: call.capabilityID,
          lease: { effectID: `eff_${call.callID}`, capabilityLeaseDigest: `blake3:${"c".repeat(64)}` },
        }))
        mutate(calls)
        return { status: "prepared_batch", calls }
      },
    })
    await collect(
      gateToolCallStream(
        stream([
          toolCall("call_alpha", "write", '{"filePath":"/workspace/call_alpha.txt","content":"a"}'),
          toolCall("call_beta", "write", '{"filePath":"/workspace/call_beta.txt","content":"b"}'),
          finish,
        ]),
        gate,
      ),
    )
    expect(gate.context.outcomes.size).toBe(2)
    for (const callID of ["call_alpha", "call_beta"]) {
      expect(() =>
        requireToolExecution({ context: gate.context, callID, capability: writeDefinition.capability }),
      ).toThrow("Tool batch denied")
    }
  }
})

test("withholds provider-executed tool calls and denies every member of the batch", async () => {
  let preparations = 0
  const gate = gateInput({
    prepareToolBatch: async () => {
      preparations++
      return { status: "denied", reason: "unexpected" }
    },
  })
  const providerExecuted = {
    type: "tool-call",
    toolCallId: "call_provider",
    toolName: "write",
    input: '{"filePath":"/workspace/provider.txt","content":"new"}',
    providerExecuted: true,
  } as unknown as LanguageModelV3StreamPart
  const output = await collect(
    gateToolCallStream(
      stream([
        toolCall("call_local", "write", '{"filePath":"/workspace/local.txt","content":"new"}'),
        providerExecuted,
        finish,
      ]),
      gate,
    ),
  )
  expect(output.filter((part) => part.type === "tool-call")).toHaveLength(2)
  // A provider-executed member is refused before Guard preparation and withholds the
  // complete batch: the local member must not run either.
  expect(preparations).toBe(0)
  expect(gate.context.outcomes.size).toBe(2)
  for (const callID of ["call_local", "call_provider"]) {
    expect(toolCallOutcome(gate.context, callID)).toMatchObject({
      status: "denied",
      reason: "provider-executed tools are unsupported",
    })
    expect(() =>
      requireToolExecution({ context: gate.context, callID, capability: writeDefinition.capability }),
    ).toThrow("Tool batch denied")
  }
})
