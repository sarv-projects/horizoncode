import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import {
  CodeModeTool,
  createCodeModeHostKernelAdapterV1,
  Parameters,
  projectCodeModeEffectiveToolsV1,
  validateCodeModeEnablementV1,
} from "@/tool/code-mode"
import { makeCodeModeStartFrameV1 } from "@/tool/code-mode-protocol"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_code_mode_fail_closed"),
  messageID: MessageID.make("msg_code_mode_fail_closed"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_code_mode_fail_closed",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

test("defines a script body with the Effect schema", async () => {
  const decode = Schema.decodeUnknownEffect(Parameters)
  await expect(Effect.runPromise(decode({ code: "return 1" }))).resolves.toEqual({ code: "return 1" })
  await expect(Effect.runPromise(decode({}))).rejects.toThrow()
})

test("rejects an active CodeMode host state carrying a terminal outer receipt", async () => {
  const adapter = createCodeModeHostKernelAdapterV1(async () => ({
    requestId: "call-1",
    executionID: "exec-1",
    status: "READY",
    nextWave: 0,
    pendingBatchID: null,
    outerReceipt: {
      status: "settled",
      receiptRef: "receipt-1",
      receiptDigest: `blake3:${"a".repeat(64)}`,
    },
  }))

  await expect(adapter.inspect({
    binding: { lane: "direct_session", sessionID: "ses_code_mode_fail_closed" },
    requestID: "call-1",
    executionID: "exec-1",
  })).rejects.toThrow("state conflicts")
})

test("projects only the request-authorized nonrecursive CodeMode catalog", () => {
  const tools = projectCodeModeEffectiveToolsV1([
    {
      toolName: "z_read",
      capabilityId: "files.read",
      effectClass: "read_only",
      description: "Read an authorized file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      toolName: "a_custom",
      capabilityId: "custom.effect",
      effectClass: "effect",
      description: "An adapter surfaced by the authorized resolver",
      inputSchema: { type: "object", additionalProperties: false },
    },
    {
      toolName: "hidden_internal",
      capabilityId: "internal.secret",
      effectClass: "read_only",
      description: "Internal",
      inputSchema: { type: "object" },
      internal: true,
    },
    {
      toolName: "execute",
      capabilityId: "codemode.execute",
      effectClass: "effect",
      description: "Recursive CodeMode",
      inputSchema: { type: "object" },
    },
  ])

  expect(tools.map((item) => [item.capabilityId, item.toolName])).toEqual([
    ["custom.effect", "a_custom"],
    ["files.read", "z_read"],
  ])
  expect(
    tools.every((item) => Object.keys(item).toSorted().join(",") === "capabilityId,description,inputSchema,toolName"),
  ).toBe(true)
  expect(() => projectCodeModeEffectiveToolsV1([{
    toolName: "unsupported",
    capabilityId: "custom.unsupported",
    effectClass: "unknown",
    description: "Not a ToolBatch class",
    inputSchema: { type: "object" },
  }])).toThrow("unsupported effect class")
})

test("keeps CodeMode enablement lane-bound and requires direct UserAction for enable", async () => {
  const calls: Array<{ service: string; operation: string; body: Record<string, unknown> }> = []
  const adapter = createCodeModeHostKernelAdapterV1(async (service, operation, body) => {
    calls.push({ service, operation, body: { ...body } })
    return null
  })
  const direct = { lane: "direct_session" as const, sessionID: "ses_code_mode_fail_closed" }

  await expect(adapter.enablement({ binding: direct, action: "enable" })).rejects.toThrow("UserAction reference")
  await expect(adapter.enablement({
    binding: { lane: "managed_attempt", runID: "run-1", taskID: "task-1", attemptID: "attempt-1" },
    action: "enable",
    approvalRef: "approval-1",
  })).rejects.toThrow("UserAction reference")
  expect(calls).toEqual([])

  await expect(adapter.enablement({ binding: direct, action: "enable", approvalRef: "approval-1" })).resolves.toBeNull()
  await expect(adapter.enablement({
    binding: { lane: "managed_attempt", runID: "run-1", taskID: "task-1", attemptID: "attempt-1" },
    action: "inspect",
  })).resolves.toBeNull()
  expect(calls).toEqual([
    {
      service: "execution.v1",
      operation: "codemode_enablement",
      body: {
        schemaVersion: 1,
        ...direct,
        action: "enable",
        approvalRef: "approval-1",
      },
    },
    {
      service: "execution.v1",
      operation: "codemode_enablement",
      body: {
        schemaVersion: 1,
        lane: "managed_attempt",
        runID: "run-1",
        taskID: "task-1",
        attemptID: "attempt-1",
        action: "inspect",
      },
    },
  ])
})

test("pins the fixed helper selector, SHA-256 manifest digest, resource profile and lane in enablement", async () => {
  const sha = `sha256:${"a".repeat(64)}`
  const blake = (char: string) => `blake3:${char.repeat(64)}`
  const direct = {
    schemaVersion: 1,
    lane: "direct_session",
    grantId: "grant-1",
    principalDigest: sha,
    sessionID: "ses_code_mode_fail_closed",
    ownerEpoch: "1",
    capabilityId: "codemode.execute",
    helperSelector: "horizoncode:codemode:bun",
    helperDigest: sha,
    resourceProfileId: "codemode.v1",
    resourceProfileDigest: blake("c"),
    backend: "linux-cgroup-v2",
    guaranteeDigest: blake("d"),
    policyDigest: blake("e"),
    issuedAtMs: "1",
    expiresAtMs: "9999999999999",
    revocationGeneration: "1",
    enablementDigest: blake("f"),
  }
  const managed = {
    schemaVersion: 1,
    lane: "managed_attempt",
    runID: "run-1",
    taskID: "task-1",
    attemptID: "attempt-1",
    ownerEpoch: "1",
    acceptedSpecVersionID: "spec-version-1",
    acceptedSpecDigest: sha,
    profileID: "profile-1",
    profileRevision: "1",
    profileDigest: blake("b"),
    capabilityId: "codemode.execute",
    helperSelector: "horizoncode:codemode:bun",
    helperDigest: sha,
    resourceProfileId: "codemode.v1",
    resourceProfileDigest: blake("c"),
  }

  // Positives: the exact packaged-helper identity round-trips for both lanes.
  expect(validateCodeModeEnablementV1(direct)).toEqual(direct)
  expect(validateCodeModeEnablementV1(managed)).toEqual(managed)
  expect(validateCodeModeEnablementV1(null)).toBeNull()

  // Negatives: any other helper, algorithm, resource profile or authority
  // shape cannot be accepted as the fixed private helper.
  const rejected: Array<Record<string, unknown>> = [
    // Another helper selector.
    { ...direct, helperSelector: "horizoncode:codemode:node" },
    // Another digest algorithm, and a truncated SHA-256.
    { ...direct, helperDigest: blake("a") },
    { ...direct, helperDigest: `sha256:${"a".repeat(63)}` },
    { ...direct, resourceProfileId: "codemode.v2" },
    { ...direct, capabilityId: "codemode.exec" },
    { ...direct, extra: true },
    Object.fromEntries(Object.entries(direct).filter(([key]) => key !== "helperDigest")),
    { ...direct, ownerEpoch: "0" },
    { ...direct, sessionID: "ses_bad id" },
    // A managed enablement cannot smuggle a direct-only backend field.
    { ...managed, backend: "linux-cgroup-v2" },
  ]
  for (const candidate of rejected) {
    expect(() => validateCodeModeEnablementV1(candidate)).toThrow()
  }
})

test("forwards only the exact opaque enablement reference to the host", async () => {
  const calls: Array<Record<string, unknown>> = []
  const adapter = createCodeModeHostKernelAdapterV1(async (_service, operation, body) => {
    calls.push({ operation, ...body })
    return {
      executionID: "exec-1",
      frame: { schemaVersion: 1, frameType: "completed", requestId: "call-1", sequence: "1", status: "completed", output: "ok" },
    }
  })
  const binding = { lane: "direct_session" as const, sessionID: "ses_code_mode_fail_closed" }
  const startFrame = makeCodeModeStartFrameV1({ requestId: "call-1", code: "return 1", tools: [] })

  for (const enablementRef of ["", "grant-1\nx", "grant 1", "x".repeat(257)]) {
    await expect(adapter.start({ binding, requestID: "call-1", startFrame, enablementRef })).rejects.toThrow("enablementRef")
  }
  expect(calls).toEqual([])

  await adapter.start({ binding, requestID: "call-1", startFrame, enablementRef: "grant-1" })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ operation: "codemode_start", enablementRef: "grant-1" })
})

test("does not evaluate source before the supervised helper is accepted", async () => {
  let dispatches = 0
  const metadata: unknown[] = []
  const tool = {
    def: { name: "echo", description: "test", inputSchema: { type: "object" } } as MCPToolDef,
    client: {
      callTool: async () => {
        dispatches += 1
        return { content: [{ type: "text", text: "unexpected" }] }
      },
    } as any,
  }
  const layer = Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])),
    Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as any) }),
    Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as any) }),
    Layer.mock(MCP.Service, {
      tools: () => Effect.succeed({ fixture_echo: tool }),
      clients: () => Effect.succeed({ fixture: {} as any }),
    }),
  )
  const operation = CodeModeTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer))
  const initialized = await Effect.runPromise(operation)
  const result = await Effect.runPromise(
    initialized.execute(
      { code: "return await tools.fixture.echo({ token: 'must-not-leak' })" },
      { ...ctx, metadata: (value) => Effect.sync(() => metadata.push(value)) },
    ),
  )

  expect(result.output).toContain("supervised helper")
  expect(result.metadata).toMatchObject({ error: true, toolCalls: [] })
  expect(dispatches).toBe(0)
  expect(JSON.stringify(metadata)).not.toContain("must-not-leak")
})

test("does not perform setup or dispatch after cancellation", async () => {
  let mcpReads = 0
  const controller = new AbortController()
  controller.abort()
  const layer = Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])),
    Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as any) }),
    Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as any) }),
    Layer.mock(MCP.Service, {
      tools: () => Effect.sync(() => { mcpReads += 1; return {} }),
      clients: () => Effect.succeed({}),
    }),
  )
  const initialized = await Effect.runPromise(CodeModeTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer)))
  const result = await Effect.runPromise(
    initialized.execute({ code: "throw new Error('must not run')" }, { ...ctx, abort: controller.signal }),
  )

  expect(result.output).toBe("Execution cancelled.")
  expect(mcpReads).toBe(0)
})
