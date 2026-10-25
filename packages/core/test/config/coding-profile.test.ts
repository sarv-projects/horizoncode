import { describe, expect, test } from "bun:test"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"
import { HorizonCodingProfile } from "../../src/config/coding-profile"

describe("Horizon Coding Profile preset (DEC-V1-37)", () => {
  test("binds Workspace write + Ask on boundary + Goal off with explicit copy", () => {
    expect(HorizonCodingProfile.settings).toMatchObject({
      profileId: "builtin.horizon-coding",
      revision: 1,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      goal: "off",
      firstBoundaryGrant: "allow_session",
    })
    expect(HorizonCodingProfile.settings.goalCopy).toContain("You do not need a Goal to code")
    expect(HorizonCodingProfile.settings.fullAccessWarning).toContain("never asks for approval")
  })

  test("composes one valid AgentProfileV2 with sorted Core+Extended authority only", () => {
    const profile = HorizonCodingProfile.composeHorizonCodingProfileV1({
      providerId: "opencode",
      modelId: "big-pickle",
      model: { toolCall: true, contextWindow: 128_000 },
    })
    expect(profile).toMatchObject({
      schemaVersion: 2,
      profileId: "builtin.horizon-coding",
      revision: "1",
      source: "builtin",
      roles: ["main"],
      harness: "native-rich",
      enabled: true,
    })
    const ceiling = [...profile.capabilityCeiling]
    expect(ceiling).toEqual(ceiling.toSorted())
    expect(new Set(ceiling).size).toBe(ceiling.length)
    expect(ceiling).toContain("files.read")
    expect(ceiling).toContain("codemode.execute")
    expect(ceiling).not.toContain("browser.navigate")
    expect(profile.tools.every((rule) => rule.effect === "allow")).toBe(true)
    expect(profile.tools.map((rule) => rule.toolPattern)).toEqual(ceiling)
    expect(profile.maxParallelChildren).toBeLessThanOrEqual(profile.limits.maxActiveChildren)
    expect(profile.instructions.maxCompiledTokens).toBe("65536")
    expect(profile.context.maxParentHistoryTokens).toBe("32768")
  })

  test("auto-picks native-rich but never silently switches an incompatible pairing", () => {
    expect(HorizonCodingProfile.selectHarnessV1({ model: { toolCall: true } })).toEqual({
      harnessId: "native-rich",
      automatic: true,
    })
    expect(HorizonCodingProfile.selectHarnessV1({ requested: "native-minimal", model: { toolCall: true } })).toEqual({
      harnessId: "native-minimal",
      automatic: false,
    })
    expect(HorizonCodingProfile.selectHarnessV1({ model: { toolCall: false } })).toEqual({
      unavailable: "model_lacks_native_tool_calling",
    })
    expect(HorizonCodingProfile.selectHarnessV1({ requested: "made-up", model: { toolCall: true } })).toEqual({
      unavailable: "unknown_harness",
    })
    expect(() =>
      HorizonCodingProfile.composeHorizonCodingProfileV1({
        providerId: "local",
        modelId: "text-only",
        model: { toolCall: false },
      }),
    ).toThrow(/model_lacks_native_tool_calling/)
  })
})

describe("Tool and skill exposure tiers (DEC-V1-38)", () => {
  const available = [
    { id: "files.read", implementationStatus: "wired" as const },
    { id: "symbols.search", implementationStatus: "wired" as const },
    { id: "codemode.execute", implementationStatus: "designed" as const },
    { id: "browser.navigate", implementationStatus: "designed" as const },
    { id: "mystery.tool", implementationStatus: "wired" as const },
  ]

  test("Core is always on, Extended is requested, Experimental and unclassified are excluded", () => {
    const chips = HorizonCodingProfile.projectCapabilityChips({
      available,
      skillCatalogSize: 7,
    })
    expect(chips.tiers).toEqual(["core", "extended"])
    expect(chips.tools).toEqual({
      effective: 2,
      catalog: 5,
      disabledReason: "experimental_tier_off",
    })
    expect(chips.skills).toEqual({ listed: 7 })
  })

  test("Core-only hides Extended without pretending it is unavailable", () => {
    const chips = HorizonCodingProfile.projectCapabilityChips({
      requestedTiers: ["core"],
      available: [
        { id: "files.read", implementationStatus: "wired" },
        { id: "symbols.search", implementationStatus: "wired" },
      ],
      skillCatalogSize: 3,
    })
    expect(chips.tiers).toEqual(["core"])
    expect(chips.tools).toMatchObject({ effective: 1, catalog: 2 })
    expect(chips.tools.disabledReason).toBeUndefined()
  })

  test("an explicitly enabled Experimental tier still counts only wired capabilities", () => {
    const chips = HorizonCodingProfile.projectCapabilityChips({
      requestedTiers: ["core", "extended", "experimental"],
      available: [
        { id: "files.read", implementationStatus: "wired" },
        { id: "browser.navigate", implementationStatus: "designed" },
      ],
      skillCatalogSize: 1,
    })
    expect(chips.tiers).toEqual(["core", "extended", "experimental"])
    expect(chips.tools).toEqual({ effective: 1, catalog: 2, disabledReason: "capability_not_wired" })
  })

  test("platform, disabled and unclassified capabilities never inflate the effective count", () => {
    const platform = HorizonCodingProfile.projectCapabilityChips({
      available: [{ id: "files.read", implementationStatus: "wired", supportedPlatforms: ["windows"] }],
      skillCatalogSize: 1,
    })
    expect(platform.tools).toEqual({ effective: 0, catalog: 1, disabledReason: "platform_unsupported" })

    const disabled = HorizonCodingProfile.projectCapabilityChips({
      available: [{ id: "files.read", implementationStatus: "wired", disabledReason: "route_disabled" }],
      skillCatalogSize: 1,
    })
    expect(disabled.tools).toEqual({ effective: 0, catalog: 1, disabledReason: "capability_disabled" })

    const unclassified = HorizonCodingProfile.projectCapabilityChips({
      available: [{ id: "future.unknown", implementationStatus: "wired" }],
      skillCatalogSize: 1,
    })
    expect(unclassified.tools).toEqual({ effective: 0, catalog: 1, disabledReason: "unclassified_capability" })
  })

  test("classification of a capability is deterministic and unknown IDs stay unclassified", () => {
    expect(HorizonCodingProfile.classifyCapability("files.read")).toBe("core")
    expect(HorizonCodingProfile.classifyCapability("symbols.search")).toBe("extended")
    expect(HorizonCodingProfile.classifyCapability("browser.navigate")).toBe("experimental")
    expect(HorizonCodingProfile.classifyCapability("mystery.tool")).toBeUndefined()
  })

  test("tools.search exposure returns exactly the enabled, wired tier IDs", () => {
    expect(HorizonCodingProfile.exposeCapabilityIDsV1({
      requestedTiers: ["core"],
      available,
      skillCatalogSize: 0,
    })).toEqual(["files.read"])
    expect(HorizonCodingProfile.exposeCapabilityIDsV1({
      requestedTiers: ["core", "extended"],
      available: [
        { id: "files.read", implementationStatus: "wired" },
        { id: "symbols.search", implementationStatus: "wired" },
        { id: "repo.tree", implementationStatus: "designed" },
        { id: "browser.navigate", implementationStatus: "wired" },
      ],
      skillCatalogSize: 0,
    })).toEqual(["files.read", "symbols.search"])
  })

  test("EXP-001: skill and skills.search are Core-tier and exposed by the default Build profile", () => {
    expect(HorizonCodingProfile.classifyCapability("skill")).toBe("core")
    expect(HorizonCodingProfile.classifyCapability("skills.search")).toBe("core")
    // Default tiers are core+extended: both skill entry points are exposed,
    // extended stays visible, and the post-V1 browser capability never leaks
    // into the effective set (EXP-003) while skills metadata stays listed.
    const exposed = HorizonCodingProfile.exposeCapabilityIDsV1({
      available: [
        { id: "skill", implementationStatus: "wired" },
        { id: "skills.search", implementationStatus: "wired" },
        { id: "symbols.search", implementationStatus: "wired" },
        { id: "browser.navigate", implementationStatus: "wired" },
      ],
      skillCatalogSize: 5,
    })
    expect(exposed).toEqual(["skill", "skills.search", "symbols.search"])
    const chips = HorizonCodingProfile.projectCapabilityChips({
      available: [
        { id: "skill", implementationStatus: "wired" },
        { id: "skills.search", implementationStatus: "wired" },
        { id: "browser.navigate", implementationStatus: "wired" },
      ],
      skillCatalogSize: 5,
    })
    expect(chips.skills).toEqual({ listed: 5 })
    expect(chips.tools.effective).toBe(2)
  })
})
