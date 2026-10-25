import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FeatureExposure } from "../../src/v1/config/feature-exposure"

/**
 * FEAT-008 descriptor conformance against the canonical machine contract
 * `arch_V1/contracts-v2/feature-exposure-v1.schema.json` (§16.15).
 *
 * The convergence validator exercises static fixtures only; this suite binds
 * the runtime projection itself to the same field bounds and conditional
 * invariants, so a descriptor Core produces or decodes can never claim a state
 * the published contract forbids.
 */
type Feature = FeatureExposure.Feature

const projected = (): Feature => FeatureExposure.list({})[0]!

const withState = (state: Partial<Feature["state"]>): Feature => ({
  ...projected(),
  state: { ...projected().state, ...state },
})

/** One canonical ID so capability-ref rules are exercised, not short-circuited. */
const known = new Set<string>(["repo.tree"])

describe("FeatureExposure canonical contract conformance (FEAT-008)", () => {
  test("the real projected catalog decodes under the canonical rules", () => {
    const features = FeatureExposure.decodeCatalog(JSON.parse(JSON.stringify(FeatureExposure.list({}))), known)
    expect(features).toHaveLength(5)
    expect(features.every((feature) => feature.capabilityIds.length === 0)).toBe(true)
  })

  test("rejects metadata the canonical contract bounds", () => {
    const decode = (feature: unknown) =>
      Schema.decodeUnknownSync(FeatureExposure.FeatureSchema)(feature, { onExcessProperty: "error" })
    expect(() => decode({ ...projected(), title: "" })).toThrow()
    expect(() => decode({ ...projected(), description: "" })).toThrow()
    expect(() => decode({ ...projected(), owner: { config: "x".repeat(129), runtime: "Config" } })).toThrow()
    expect(() => decode({ ...projected(), owner: { config: "Config", runtime: "" } })).toThrow()
    expect(() => decode({ ...projected(), capabilityIds: [""] })).toThrow()
    expect(() => decode({ ...projected(), supportedScopes: [] })).toThrow()
    expect(() => decode({ ...projected(), state: { ...projected().state, blockedReason: "" } })).toThrow()
    expect(() => decode(projected())).not.toThrow()
  })

  test("rejects duplicated supported scopes", () => {
    const duplicate = [{ ...projected(), supportedScopes: ["project", "project"] as const }]
    expect(FeatureExposure.validateCatalog(duplicate, known)).toEqual([
      { code: "duplicate_supported_target", featureId: projected().featureId, target: "project" },
    ])
    expect(() => FeatureExposure.decodeCatalog(duplicate, known)).toThrow()
  })

  test("rejects an effective state that contradicts the effective flag", () => {
    const contradictions: Feature["state"][] = [
      { ...projected().state, effectiveEnabled: true, effectiveState: "blocked", blockedReason: "Managed by administrator" },
      { ...projected().state, effectiveEnabled: true, effectiveState: "off" },
      { ...projected().state, effectiveEnabled: false, effectiveState: "on" },
      { ...projected().state, effectiveEnabled: true, effectiveState: "unavailable", blockedReason: "Not implemented" },
    ]
    for (const state of contradictions) {
      expect(FeatureExposure.validateCatalog([{ ...projected(), state }], known)).toEqual([
        { code: "inconsistent_effect_state", featureId: projected().featureId },
      ])
      expect(() => FeatureExposure.decodeCatalog([{ ...projected(), state }], known)).toThrow()
    }
  })

  test("accepts every coherent state the projection actually emits", () => {
    for (const state of [
      withState({ effectiveEnabled: true, effectiveState: "on" }),
      withState({ effectiveEnabled: false, effectiveState: "off" }),
      withState({ effectiveEnabled: false, effectiveState: "blocked", blockedReason: "Managed by administrator" }),
      withState({ effectiveEnabled: false, effectiveState: "unavailable", blockedReason: "Not implemented" }),
      withState({
        effectiveEnabled: true,
        effectiveState: "pending_apply",
        pendingApplyAt: "next_turn",
        requestedEnabled: false,
      }),
      withState({
        effectiveEnabled: false,
        effectiveState: "pending_apply",
        pendingApplyAt: "restart",
        requestedEnabled: true,
      }),
    ]) {
      expect(FeatureExposure.validateCatalog([state], known)).toEqual([])
      expect(() => FeatureExposure.decodeCatalog([state], known)).not.toThrow()
    }
  })

  test("requires a reason for blocked or unavailable and an apply boundary for pending", () => {
    expect(
      FeatureExposure.validateCatalog([withState({ effectiveEnabled: false, effectiveState: "unavailable" })], known),
    ).toEqual([{ code: "missing_blocked_reason", featureId: projected().featureId }])
    expect(
      FeatureExposure.validateCatalog([withState({ effectiveEnabled: false, effectiveState: "blocked" })], known),
    ).toEqual([{ code: "missing_blocked_reason", featureId: projected().featureId }])
    expect(
      FeatureExposure.validateCatalog(
        [withState({ effectiveEnabled: false, effectiveState: "blocked", blockedReason: "" })],
        known,
      ),
    ).toEqual([{ code: "missing_blocked_reason", featureId: projected().featureId }])
    expect(() =>
      FeatureExposure.decodeCatalog([withState({ effectiveEnabled: false, effectiveState: "blocked" })], known),
    ).toThrow()

    expect(
      FeatureExposure.validateCatalog([withState({ effectiveEnabled: true, effectiveState: "pending_apply" })], known),
    ).toEqual([{ code: "missing_pending_apply_at", featureId: projected().featureId }])
    expect(() =>
      FeatureExposure.decodeCatalog([withState({ effectiveEnabled: true, effectiveState: "pending_apply" })], known),
    ).toThrow()
  })

  test("still rejects the pre-existing duplicate and unwired cases", () => {
    const descriptor = projected()
    expect(
      FeatureExposure.validateCatalog(
        [
          descriptor,
          {
            ...descriptor,
            featureId: "compaction.prune" as const,
            state: withState({ implementationStatus: "designed", effectiveEnabled: true, effectiveState: "on" }).state,
          },
        ],
        known,
      ),
    ).toEqual([
      { code: "duplicate_setting_key", featureId: "compaction.prune", settingKey: descriptor.settingKey },
      { code: "unwired_feature_enabled", featureId: "compaction.prune" },
    ])
  })
})
