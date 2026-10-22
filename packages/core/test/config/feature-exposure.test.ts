import { describe, expect, test } from "bun:test"
import { FeatureExposure } from "../../src/v1/config/feature-exposure"

describe("FeatureExposure derived Settings projection", () => {
  test("stable settings reflect resolved config and preserve unknown source", () => {
    const all = FeatureExposure.list({ compaction: { auto: false, prune: true } })
    expect(all.find((x) => x.featureId === "compaction.auto")?.state).toEqual({
      implementationStatus: "wired",
      requestedEnabled: false,
      effectiveEnabled: false,
      effectiveState: "off",
      valueSource: "unknown",
      policyLock: "unknown",
    })
    const prune = all.find((x) => x.featureId === "compaction.prune")
    expect(prune?.state.effectiveEnabled).toBe(true)
    expect(prune?.releaseClass).toBe("stable")
    expect(prune?.settingKey).toBe("compaction.prune")
  })

  test("defaults derive from real existing compaction behavior", () => {
    const all = FeatureExposure.list({})
    expect(all.find((x) => x.featureId === "compaction.auto")?.state).toMatchObject({
      requestedEnabled: null,
      valueSource: "default",
      effectiveEnabled: true,
      policyLock: "unlocked",
    })
    expect(all.find((x) => x.featureId === "compaction.prune")?.state).toMatchObject({
      requestedEnabled: null,
      valueSource: "default",
      effectiveEnabled: false,
      policyLock: "unlocked",
    })
    for (const feature of all.filter((item) => item.releaseClass === "stable")) {
      expect(feature.supportedScopes).toEqual(["project"])
      expect(feature.applyBoundary).toBe("next_turn")
    }
  })
  test("merged values distinguish defaults from explicit overrides without guessing scope", () => {
    for (const [auto, effectiveState] of [
      [true, "on"],
      [false, "off"],
    ] as const) {
      const feature = FeatureExposure.list({ compaction: { auto } }).find((item) => item.featureId === "compaction.auto")
      expect(feature?.state).toEqual({
        implementationStatus: "wired",
        requestedEnabled: auto,
        effectiveEnabled: auto,
        effectiveState,
        valueSource: "unknown",
        policyLock: "unknown",
      })
    }

    const inheritedDefault = FeatureExposure.list({}).find((item) => item.featureId === "compaction.auto")
    expect(inheritedDefault?.state.valueSource).toBe("default")
    expect(inheritedDefault?.state.requestedEnabled).toBeNull()
  })

  test("runtime disable overrides block requested-on auto and prune settings", () => {
    for (const featureId of ["compaction.auto", "compaction.prune"] as const) {
      const key = featureId === "compaction.auto" ? "auto" : "prune"
      const feature = FeatureExposure.list(
        { compaction: { [key]: true } },
        { compaction: { [key]: false } },
      ).find((item) => item.featureId === featureId)
      expect(feature?.state).toMatchObject({
        requestedEnabled: true,
        effectiveEnabled: false,
        effectiveState: "blocked",
        blockedReason: "Effective state differs from the request; policy status is unknown",
        valueSource: "unknown",
        policyLock: "unknown",
      })
      expect(feature?.state.pendingApplyAt).toBeUndefined()
    }
  })

  test("projects the winning value source and policy lock instead of inventing either", () => {
    const [auto, prune] = FeatureExposure.list(
      {
        compaction: { auto: true, prune: false },
        origins: {
          auto: { valueSource: "project", policyLock: "unlocked" },
          prune: { valueSource: "user", policyLock: "locked", blockedReason: "Managed by administrator" },
        },
      },
      { compaction: { auto: true, prune: false } },
    )

    expect(auto?.state.valueSource).toBe("project")
    expect(auto?.state.policyLock).toBe("unlocked")
    expect(prune?.state.valueSource).toBe("user")
    expect(prune?.state.policyLock).toBe("locked")
    expect(prune?.state.blockedReason).toBe("Managed by administrator")
  })

  test("projects an apply boundary as pending until the effective runtime catches up", () => {
    const [auto] = FeatureExposure.list(
      {
        compaction: { auto: false },
        origins: { auto: { valueSource: "project", pendingApplyAt: "next_turn" } },
      },
      { compaction: { auto: true } },
    )

    expect(auto?.state).toMatchObject({
      requestedEnabled: false,
      effectiveEnabled: true,
      effectiveState: "pending_apply",
      pendingApplyAt: "next_turn",
      valueSource: "project",
    })
  })

  test("reports a requested-on update as pending instead of runtime-blocked before its apply boundary", () => {
    const [auto] = FeatureExposure.list(
      {
        compaction: { auto: true },
        origins: { auto: { valueSource: "project", policyLock: "unlocked", pendingApplyAt: "next_turn" } },
      },
      { compaction: { auto: false } },
    )

    expect(auto?.state).toMatchObject({
      requestedEnabled: true,
      effectiveEnabled: false,
      effectiveState: "pending_apply",
      pendingApplyAt: "next_turn",
      valueSource: "project",
      policyLock: "unlocked",
    })
    expect(auto?.state.blockedReason).toBeUndefined()
  })

  test("clears pending state once the next-turn runtime applies the requested value", () => {
    const source = {
      compaction: { auto: false },
      origins: {
        auto: { valueSource: "project" as const, policyLock: "unlocked" as const, pendingApplyAt: "next_turn" as const },
      },
    }
    const [pending] = FeatureExposure.list(source, { compaction: { auto: true } })
    expect(pending?.state).toMatchObject({
      requestedEnabled: false,
      effectiveEnabled: true,
      effectiveState: "pending_apply",
      pendingApplyAt: "next_turn",
    })

    const [applied] = FeatureExposure.list(source, { compaction: { auto: false } })
    expect(applied?.state).toMatchObject({
      requestedEnabled: false,
      effectiveEnabled: false,
      effectiveState: "off",
      valueSource: "project",
      policyLock: "unlocked",
    })
    expect(applied?.state.pendingApplyAt).toBeUndefined()
  })

  test("policy denial takes precedence over a pending requested-on change", () => {
    const [auto] = FeatureExposure.list({
      compaction: { auto: true },
      origins: { auto: { valueSource: "system_policy", policyLock: "locked", pendingApplyAt: "next_turn", blockedReason: "Disabled by policy" } },
    }, { compaction: { auto: false } })
    expect(auto?.state).toMatchObject({ effectiveEnabled: false, effectiveState: "blocked", blockedReason: "Disabled by policy" })
    expect(auto?.state.pendingApplyAt).toBeUndefined()
  })

  test("unknown policy state cannot claim an explicit change is pending", () => {
    const [auto] = FeatureExposure.list({
      compaction: { auto: true },
      origins: { auto: { valueSource: "unknown", policyLock: "unknown", pendingApplyAt: "next_turn" } },
    }, { compaction: { auto: false } })
    expect(auto?.state).toMatchObject({
      requestedEnabled: true,
      effectiveEnabled: false,
      effectiveState: "blocked",
      valueSource: "unknown",
      policyLock: "unknown",
      blockedReason: "Effective state differs from the request; policy status is unknown",
    })
    expect(auto?.state.pendingApplyAt).toBeUndefined()

    const [reverse] = FeatureExposure.list({
      compaction: { auto: false },
      origins: { auto: { valueSource: "unknown", policyLock: "unknown", pendingApplyAt: "next_turn" } },
    }, { compaction: { auto: true } })
    expect(reverse?.state).toMatchObject({
      requestedEnabled: false,
      effectiveEnabled: true,
      effectiveState: "blocked",
      policyLock: "unknown",
      blockedReason: "Effective state differs from the request; policy status is unknown",
    })
    expect(reverse?.state.pendingApplyAt).toBeUndefined()
  })


  test("planned experiments are disabled and do not become executable", () => {
    const all = FeatureExposure.list({})
    const experiments = all.filter((x) => x.releaseClass === "experimental")
    expect(experiments).toHaveLength(3)
    for (const feature of experiments) {
      expect(feature.defaultEnabled).toBe(false)
      expect(feature.state).toMatchObject({
        requestedEnabled: null,
        effectiveEnabled: false,
        effectiveState: "unavailable",
        implementationStatus: "designed",
      })
      expect(feature.state.blockedReason).toBeTruthy()
      expect(FeatureExposure.updateCompaction({}, feature.featureId, true)).toBeUndefined()
      expect(FeatureExposure.updateCompaction({}, feature.featureId, false)).toBeUndefined()
    }
  })

  test("legacy experimental config cannot enable Horizon experiments without their owning config path", () => {
    const legacyConfig = {
      experimental: { native_search: true, hashline_edit: true, cow_worktrees: true },
      compaction: { auto: true, prune: false },
    } as FeatureExposure.SourceConfig

    const previous = process.env.OPENCODE_EXPERIMENTAL
    process.env.OPENCODE_EXPERIMENTAL = "true"
    try {
      for (const feature of FeatureExposure.list(legacyConfig).filter((item) => item.releaseClass === "experimental")) {
        expect(feature.state).toMatchObject({
          requestedEnabled: null,
          effectiveEnabled: false,
          effectiveState: "unavailable",
          implementationStatus: "designed",
        })
        expect(FeatureExposure.updateCompaction(legacyConfig, feature.featureId, true)).toBeUndefined()
      }
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL
      else process.env.OPENCODE_EXPERIMENTAL = previous
    }
  })

  test("compaction update is bounded and preserves the other value", () => {
    const source = { compaction: { auto: false, prune: false } }
    expect(FeatureExposure.updateCompaction(source, "compaction.prune", true)).toEqual({
      compaction: { prune: true },
    })
    expect(source.compaction.prune).toBe(false)
    expect(FeatureExposure.updateCompaction(source, "native_search", true)).toBeUndefined()
  })

  test("setting keys and identifiers remain unique", () => {
    const list = FeatureExposure.list({})
    expect(new Set(list.map((x) => x.featureId)).size).toBe(list.length)
    expect(new Set(list.map((x) => x.settingKey)).size).toBe(list.length)
  })

  test("catalog validation catches duplicate settings, unknown capabilities, and effective code that is not wired", () => {
    const descriptor = FeatureExposure.list({})[0]!
    const invalid = [
      descriptor,
      { ...descriptor, featureId: "compaction.prune" as const, capabilityIds: ["missing.capability"] },
    ]
    expect(FeatureExposure.validateCatalog(invalid, new Set(["known.capability"]))).toEqual([
      { code: "duplicate_setting_key", featureId: "compaction.prune", settingKey: descriptor.settingKey },
      { code: "unknown_capability", featureId: "compaction.prune", capabilityId: "missing.capability" },
    ])
    expect(() => FeatureExposure.decodeCatalog(invalid, new Set(["known.capability"]))).toThrow()
  })

  test("catalog validation rejects duplicate capability refs and unimplemented effective settings", () => {
    const descriptor = FeatureExposure.list({})[0]!
    const invalid = [{
      ...descriptor,
      capabilityIds: ["known.capability", "known.capability"],
      state: { ...descriptor.state, implementationStatus: "code_present" as const, effectiveEnabled: true, effectiveState: "on" as const },
    }]
    expect(FeatureExposure.validateCatalog(invalid, new Set(["known.capability"]))).toEqual([
      { code: "duplicate_capability_ref", featureId: descriptor.featureId, capabilityId: "known.capability" },
      { code: "unwired_feature_enabled", featureId: descriptor.featureId },
    ])
  })
})
