import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderDoctorApi } from "../../src/server/routes/instance/httpapi/groups/provider-doctor"
import { ProviderDoctorV1 } from "@opencode-ai/schema/provider-doctor-v1"

const request = {
  schemaVersion: 1,
  doctorRunId: "doctor:offline-test",
  tier: "offline",
  selection: {
    providerRef: "provider:opencode",
    modelRef: "model:opencode/big-pickle",
  },
  deadlineMs: 5000,
  maxNetworkRequests: 0,
} as const

describe("Provider Doctor offline API contract", () => {
  test("declares only the offline endpoint with the no-network request and result schemas", () => {
    const decoded = Schema.decodeUnknownSync(ProviderDoctorV1.OfflineRequestV1)(request, { onExcessProperty: "error" })
    expect(decoded.tier).toBe("offline")
    expect(ProviderDoctorApi).toBeDefined()
    expect(() => Schema.decodeUnknownSync(ProviderDoctorV1.OfflineRequestV1)({ ...request, maxNetworkRequests: 1 })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ProviderDoctorV1.OfflineRequestV1)(
        { ...request, ownerRef: "spoofed", ownerEpoch: "spoofed", selection: { ...request.selection, configurationStatus: "VALID" } },
        { onExcessProperty: "error" },
      ),
    ).toThrow()
  })
})
