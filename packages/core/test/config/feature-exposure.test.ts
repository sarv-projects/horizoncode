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
    })
    expect(all.find((x) => x.featureId === "compaction.prune")?.state).toMatchObject({
      requestedEnabled: null,
      valueSource: "default",
      effectiveEnabled: false,
    })
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
})
