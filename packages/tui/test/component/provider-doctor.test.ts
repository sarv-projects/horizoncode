import { describe, expect, test } from "bun:test"
import { providerDoctorOfflineSummary } from "../../src/component/dialog-provider-doctor"

describe("Provider Doctor offline TUI summary", () => {
  test("reports selected model provenance while keeping remote state explicitly unchecked", () => {
    expect(
      providerDoctorOfflineSummary({
        providerID: "opencode",
        providerName: "OpenCode Zen",
        modelID: "big-pickle",
        modelName: "Big Pickle",
        configurationStatus: "VALID",
      }),
    ).toEqual({
      selection: "OpenCode Zen / Big Pickle (opencode/big-pickle)",
      localReadiness: "READY",
      configuration: "VALID",
      credentials: "NOT_READ",
      networkRequests: 0,
      remote: "UNCHECKED",
      cost: "NOT_APPLICABLE",
    })
  })

  test("preserves unknown configuration status instead of guessing readiness or remote state", () => {
    expect(providerDoctorOfflineSummary({ configurationStatus: "UNKNOWN" })).toEqual({
      selection: "No provider/model selected",
      localReadiness: "UNKNOWN",
      configuration: "UNKNOWN",
      credentials: "NOT_READ",
      networkRequests: 0,
      remote: "UNCHECKED",
      cost: "NOT_APPLICABLE",
    })
  })
})
