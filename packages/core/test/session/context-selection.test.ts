import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "../../src/session/message"
import { SessionSchema } from "../../src/session/schema"
import { compile, compileDirectProviderRequestContextV1 } from "../../src/session/context-selection"
import { ProfileId, Revision, type AgentProfileDefinitionV2 } from "@opencode-ai/schema/agent-profile-v2"

const sessionID = SessionSchema.ID.make("ses_01J9ABCDEF0123456789ABCDEFGH")
const profile = {
  profileID: ProfileId.make("horizon.default"),
  revision: Revision.make("3"),
  profileDigest: `blake3:${"a".repeat(64)}`,
  trust: "system" as const,
}
const providerInput = {
  system: ["System prompt"],
  messages: [{ role: "user", content: "hello" }],
  tools: {},
}

const message = (id: string) => Schema.decodeUnknownSync(SessionMessage.User)({
  id: SessionMessage.ID.make(id),
  type: "user",
  text: id,
  files: [],
  agents: [],
  time: { created: 0 },
})

test("Core context selection pins lane, current cursor, active profile and provider input", () => {
  const selected = compile({
    sessionID,
    requestID: "req_context_1",
    mode: "conversation_slice",
    sourceRevision: "12",
    messages: [message("msg_01J9ABCDEF0123456789ABCDEFG1"), message("msg_01J9ABCDEF0123456789ABCDEFG2")],
    providerInput,
    agentProfile: profile,
  })
  expect(selected.lane).toBe("direct")
  expect(selected.sourceRevision).toBe("12")
  expect(selected.sources.map((item) => `${item.kind}:${item.sourceID}`)).toEqual([
    "session-message:msg_01J9ABCDEF0123456789ABCDEFG1",
    "session-message:msg_01J9ABCDEF0123456789ABCDEFG2",
    "provider-input:req_context_1",
    "agent-profile:horizon.default",
  ])
  expect(selected.sources.find((item) => item.kind === "agent-profile")?.sourceRevision).toBe("3")
  expect(selected.sources.find((item) => item.kind === "provider-input")?.contentDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
  expect(selected).not.toHaveProperty("messages")
})

test("fresh selection omits prior messages but retains the current request and active profile", () => {
  const selected = compile({
    sessionID,
    requestID: "req_context_fresh",
    mode: "fresh",
    sourceRevision: "0",
    messages: [message("msg_01J9ABCDEF0123456789ABCDEFG1")],
    providerInput,
    agentProfile: profile,
  })
  expect(selected.sources.map((item) => item.kind)).toEqual(["provider-input", "agent-profile"])
})

test("pins resolved project instructions inside the bounded source set", () => {
  const instruction = {
    kind: "instruction" as const,
    sourceID: "ins_0123456789abcdef0123456789abcdef",
    sourceRevision: `blake3:${"b".repeat(64)}`,
    contentDigest: `blake3:${"b".repeat(64)}`,
    sourceAuthority: "instruction-resolver" as const,
    trust: "workspace" as const,
    included: true as const,
    inclusionReason: "instruction" as const,
  }
  const selected = compile({
    sessionID,
    requestID: "req_context_instruction",
    mode: "fresh",
    sourceRevision: "0",
    messages: [],
    instructions: [instruction],
    providerInput,
    agentProfile: profile,
  })
  expect(selected.sources.map((item) => item.kind)).toEqual(["instruction", "provider-input", "agent-profile"])
  expect(selected.sources[0]).toEqual(instruction)

  expect(() =>
    compile({
      sessionID,
      requestID: "req_context_instruction",
      mode: "fresh",
      sourceRevision: "0",
      messages: [],
      instructions: [{ ...instruction, kind: "tool" as never }],
      providerInput,
      agentProfile: profile,
    }),
  ).toThrow("instruction-resolver reference")
})

const directProfile = {
  profileId: "horizon.default",
  revision: 3,
  source: "builtin",
} as unknown as AgentProfileDefinitionV2

const directInput = {
  sessionID,
  requestID: "req_direct_1",
  sourceRevision: "12",
  mode: "fresh" as const,
  agentProfile: directProfile,
  messages: [],
  providerInput,
  authority: {
    permissionScopeDigest: `blake3:${"1".repeat(64)}`,
    policyDigest: `blake3:${"2".repeat(64)}`,
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    harnessID: "native-rich",
    harnessRevision: "1",
    routeID: "route_1",
    routeRevision: "route_rev_1",
    endpointRevision: "endpoint_rev_1",
    endpointBase: "https://api.anthropic.com/v1",
  },
  pin: (() => {
    throw new Error("pin is not invoked by this test")
  }) as never,
}

test("direct provider context pins the selectable endpoint and trusted profile provenance", () => {
  const context = compileDirectProviderRequestContextV1(directInput)
  expect(context.route.endpointBase).toBe("https://api.anthropic.com/v1")
  expect(context.contextSelection.sources.find((source) => source.kind === "agent-profile")?.trust).toBe("system")
  expect(context.contextSelection.lane).toBe("direct")
})

test("direct provider context fails closed without a selectable endpoint or a Core Config profile", () => {
  expect(() =>
    compileDirectProviderRequestContextV1({
      ...directInput,
      authority: { ...directInput.authority, endpointBase: undefined },
    }),
  ).toThrow("public endpoint base")
  expect(() =>
    compileDirectProviderRequestContextV1({
      ...directInput,
      agentProfile: { ...directProfile, source: "plugin" } as unknown as AgentProfileDefinitionV2,
    }),
  ).toThrow("Core Config profiles")
})
