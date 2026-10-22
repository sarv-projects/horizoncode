import { expect, test } from "bun:test"
import { Schema } from "effect"
import * as RepoIntelConfig from "../src/v1/config/repo-intelligence"

test("preserves unknown RepoIntel profile provenance instead of calling it a setting", () => {
  const projection = RepoIntelConfig.resolveProfile({
    requested: "adaptive",
    configurationSource: "unknown",
    policyLock: "unknown",
  })

  expect(projection).toMatchObject({
    requested: "adaptive",
    effective: "lightweight",
    configurationSource: "unknown",
    effectiveSource: "unknown",
    policyLock: "unknown",
    reason: "feature_unavailable",
  })
  expect(Schema.decodeUnknownSync(RepoIntelConfig.ProfileProjection)(projection)).toEqual(projection)
})

test("attributes requested RepoIntel profiles only to their resolved config source", () => {
  expect(RepoIntelConfig.resolveProfile({
    requested: "full",
    configurationSource: "project",
    policyLock: "unlocked",
  }).effectiveSource).toBe("unknown")
  expect(RepoIntelConfig.resolveProfile({
    requested: "full",
    configurationSource: "system_policy",
    policyLock: "locked",
  }).effectiveSource).toBe("unknown")
  expect(RepoIntelConfig.resolveProfile({
    requested: "full",
    configurationSource: "default",
    policyLock: "unlocked",
  }).effectiveSource).toBe("unknown")
  expect(RepoIntelConfig.resolveProfile({ requested: "full" })).toMatchObject({
    requested: "full",
    effective: "lightweight",
    reason: "feature_unavailable",
  })
})

test("attributes an omitted profile to the default even when a config layer exists", () => {
  expect(RepoIntelConfig.resolveProfile({
    configurationSource: "user",
    policyLock: "unlocked",
  })).toMatchObject({
    requested: "lightweight",
    effective: "lightweight",
    requestedValue: null,
    configurationSource: "user",
    effectiveSource: "default",
  })
})
