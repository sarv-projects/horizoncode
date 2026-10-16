import { describe, expect, test } from "bun:test"
import { agentOptionDescription } from "../../src/component/dialog-agent"

describe("agent picker metadata (16.5)", () => {
  test("shows the profile description and its explicit model binding", () => {
    expect(
      agentOptionDescription({
        description: "The default agent. Executes tools based on configured permissions.",
        model: { providerID: "anthropic", modelID: "claude-3" },
      }),
    ).toBe("The default agent. Executes tools based on configured permissions. · model anthropic/claude-3")
  })

  test("never invents a model claim when the profile has no binding", () => {
    expect(agentOptionDescription({ description: "Plan mode. Disallows all edit tools." })).toBe(
      "Plan mode. Disallows all edit tools.",
    )
    expect(agentOptionDescription({ model: { providerID: "openai", modelID: "gpt-4" } })).toBe("model openai/gpt-4")
  })

  test("native agents without a description are labelled as built-in, not 'native'", () => {
    expect(agentOptionDescription({ native: true })).toBe("Built-in agent")
    expect(agentOptionDescription({})).toBeUndefined()
  })
})
