import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderDoctorV1 } from "../src/provider-doctor-v1"

const offlineRequest = {
  schemaVersion: 1,
  doctorRunId: "pdr_01",
  tier: "offline",
  selection: {
    providerRef: "provider:opencode",
    modelRef: "model:opencode/big-pickle",
    configRevisionRef: "config:42",
  },
  deadlineMs: 5_000,
  maxNetworkRequests: 0,
} as const

const decodeRequest = Schema.decodeUnknownSync(ProviderDoctorV1.RequestV1)

describe("Provider Doctor V1 request contract", () => {
  test("offline requests cannot authorize network, spend, or carry credential fields", () => {
    expect(decodeRequest(offlineRequest, { onExcessProperty: "error" })).toEqual(offlineRequest)
    expect(() => decodeRequest({ ...offlineRequest, maxNetworkRequests: 1 })).toThrow()
    expect(() => decodeRequest({ ...offlineRequest, networkGrantRef: "network:grant" })).toThrow()
    expect(() => decodeRequest({ ...offlineRequest, spendConsentRef: "spend:grant" })).toThrow()
    expect(() => decodeRequest({ ...offlineRequest, apiKey: "must-not-be-carried" }, { onExcessProperty: "error" })).toThrow()
  })

  test("catalog and full requests require their corresponding scoped grants", () => {
    const base = { ...offlineRequest, maxNetworkRequests: 1 }
    expect(() => decodeRequest({ ...base, tier: "catalog" })).toThrow()
    expect(decodeRequest({ ...base, tier: "catalog", networkGrantRef: "network:grant" })).toMatchObject({
      tier: "catalog",
      networkGrantRef: "network:grant",
    })
    expect(() => decodeRequest({ ...base, tier: "full", networkGrantRef: "network:grant" })).toThrow()
    expect(
      decodeRequest({ ...base, tier: "full", networkGrantRef: "network:grant", spendConsentRef: "spend:grant" }),
    ).toMatchObject({ tier: "full", spendConsentRef: "spend:grant" })
  })

  test("bounds the local deadline and rejects credential-shaped selection metadata", () => {
    expect(() => decodeRequest({ ...offlineRequest, deadlineMs: 0 })).toThrow()
    expect(() => decodeRequest({ ...offlineRequest, ownerEpoch: "" }, { onExcessProperty: "error" })).toThrow()
    expect(() =>
      decodeRequest(
        {
          ...offlineRequest,
          selection: { ...offlineRequest.selection, credentialSource: "env:OPENAI_API_KEY" },
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow()
  })
})

describe("Provider Doctor V1 result contract", () => {
  test("an offline result cannot claim remote checks, credential access, requests, or cost", () => {
    const valid = {
      schemaVersion: 1,
      doctorRunId: "pdr_01",
      tier: "offline",
      selection: { ...offlineRequest.selection, configurationStatus: "UNKNOWN" },
      localReadiness: "READY",
      catalogFreshness: "FRESH",
      remoteChecks: { entitlement: "UNCHECKED", quota: "UNCHECKED", service: "UNCHECKED" },
      credentialAccess: "NOT_READ",
      networkRequestCount: 0,
      costStatus: "NOT_APPLICABLE",
      probes: [],
    } as const
    const decodeResult = Schema.decodeUnknownSync(ProviderDoctorV1.ResultV1)

    expect(decodeResult(valid, { onExcessProperty: "error" })).toEqual(valid)
    expect(() => decodeResult({ ...valid, networkRequestCount: 1 })).toThrow()
    expect(() => decodeResult({ ...valid, credentialAccess: "CREDENTIAL_USED" })).toThrow()
    expect(() => decodeResult({ ...valid, remoteChecks: { ...valid.remoteChecks, quota: "PASS" } })).toThrow()
    expect(() => decodeResult({ ...valid, costStatus: "CHARGED" })).toThrow()
    expect(() =>
      decodeResult({ ...valid, probes: [{ phase: "stream", outcome: "PASS" }] }),
    ).toThrow()
  })
})
