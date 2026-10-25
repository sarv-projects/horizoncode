import { expect, test } from "bun:test"
import { isConfiguredTaskSelectorAgent } from "../../src/tool/registry"

const profile = (revision: unknown = 1) => ({
  profileId: "builtin.general",
  revision,
})

test("advertises only immutable AgentProfileV2 task selectors", () => {
  expect(isConfiguredTaskSelectorAgent({
    mode: "subagent",
    options: { horizonAgentProfile: profile() },
  })).toBe(true)
  expect(isConfiguredTaskSelectorAgent({
    mode: "subagent",
    options: { horizonAgentProfile: profile(2) },
  })).toBe(true)
})

test("never advertises legacy built-in subagents as implicit selectors", () => {
  expect(isConfiguredTaskSelectorAgent({
    mode: "subagent",
    options: {},
  })).toBe(false)
  expect(isConfiguredTaskSelectorAgent({
    mode: "subagent",
    options: { horizonAgentProfile: { profileId: "general", revision: "1" } },
  })).toBe(false)
  expect(isConfiguredTaskSelectorAgent({
    mode: "subagent",
    options: { horizonAgentProfile: { revision: 1 } },
  })).toBe(false)
  expect(isConfiguredTaskSelectorAgent({
    mode: "primary",
    options: { horizonAgentProfile: profile() },
  })).toBe(false)
})
