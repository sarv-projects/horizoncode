import { expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { isRecord } from "@/util/record"
import {
  createToolBatchContext,
  gateToolCallStream,
  requireToolExecution,
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

  expect(challenge?.challengeID).toBe("ch_1")
  expect(challenge?.effectID).toBe("eff_1")
  expect(challenge?.target).toBe("/workspace/a.txt")
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
})

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
