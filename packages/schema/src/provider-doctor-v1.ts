/** Browser-safe Provider Doctor V1 contracts. Provider, auth and probe effects remain outside Schema. */

export * as ProviderDoctorV1 from "./provider-doctor-v1"

import { Schema } from "effect"
import { optional } from "./schema"

const Identifier = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/))

const DeadlineMs = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 }))
const NetworkRequestLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))

export interface SelectionRefV1 extends Schema.Schema.Type<typeof SelectionRefV1> {}
export const SelectionRefV1 = Schema.Struct({
  providerRef: Identifier,
  accountRef: optional(Identifier),
  modelRef: optional(Identifier),
  harnessRef: optional(Identifier),
  endpointRef: optional(Identifier),
  configRevisionRef: optional(Identifier),
  catalogRevisionRef: optional(Identifier),
}).annotate({ identifier: "Horizon.ProviderDoctorV1.SelectionRefV1" })

export interface SelectionV1 extends Schema.Schema.Type<typeof SelectionV1> {}
export const SelectionV1 = Schema.Struct({
  ...SelectionRefV1.fields,
  configurationStatus: Schema.Literals(["VALID", "INVALID", "UNKNOWN"]),
}).annotate({ identifier: "Horizon.ProviderDoctorV1.SelectionV1" })

const RequestBase = {
  schemaVersion: Schema.Literal(1),
  doctorRunId: Identifier,
  selection: SelectionRefV1,
  deadlineMs: DeadlineMs,
}

export const OfflineRequestV1 = Schema.Struct({
  ...RequestBase,
  tier: Schema.Literal("offline"),
  maxNetworkRequests: Schema.Literal(0),
  // Reject removed authority-like request fields instead of letting an HTTP
  // decoder silently treat forged identity labels as harmless extra JSON.
  ownerRef: optional(Schema.Never),
  ownerEpoch: optional(Schema.Never),
  networkGrantRef: optional(Identifier),
  spendConsentRef: optional(Identifier),
})
  .annotate({ identifier: "Horizon.ProviderDoctorV1.OfflineRequestV1" })
  .check(
    Schema.makeFilter((request) =>
      request.networkGrantRef === undefined && request.spendConsentRef === undefined
        ? undefined
        : "offline Doctor requests cannot carry network or spend grants",
    ),
  )

export const CatalogRequestV1 = Schema.Struct({
  ...RequestBase,
  tier: Schema.Literal("catalog"),
  maxNetworkRequests: NetworkRequestLimit,
  networkGrantRef: Identifier,
  spendConsentRef: optional(Identifier),
})
  .annotate({ identifier: "Horizon.ProviderDoctorV1.CatalogRequestV1" })
  .check(
    Schema.makeFilter((request) =>
      request.spendConsentRef === undefined ? undefined : "catalog Doctor requests cannot carry spend consent",
    ),
  )

export const FullRequestV1 = Schema.Struct({
  ...RequestBase,
  tier: Schema.Literal("full"),
  maxNetworkRequests: NetworkRequestLimit,
  networkGrantRef: Identifier,
  spendConsentRef: Identifier,
}).annotate({ identifier: "Horizon.ProviderDoctorV1.FullRequestV1" })

export const RequestV1 = Schema.Union([OfflineRequestV1, CatalogRequestV1, FullRequestV1])
  .pipe(Schema.toTaggedUnion("tier"))
  .annotate({ identifier: "Horizon.ProviderDoctorV1.RequestV1" })
export type RequestV1 = typeof RequestV1.Type

export interface ProbeV1 extends Schema.Schema.Type<typeof ProbeV1> {}
export const ProbeV1 = Schema.Struct({
  phase: Schema.Literals(["config", "auth", "catalog", "capability", "stream", "tool_call", "cache"]),
  outcome: Schema.Literals(["PASS", "FAIL", "SKIPPED", "UNKNOWN"]),
  code: optional(Identifier),
  elapsedMs: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  modelRef: optional(Identifier),
  priceSource: optional(Identifier),
  redactedDetails: optional(Schema.String.check(Schema.isMaxLength(2048))),
}).annotate({ identifier: "Horizon.ProviderDoctorV1.ProbeV1" })

export interface RemoteChecksV1 extends Schema.Schema.Type<typeof RemoteChecksV1> {}
export const RemoteChecksV1 = Schema.Struct({
  entitlement: Schema.Literals(["UNCHECKED", "PASS", "FAIL", "UNKNOWN"]),
  quota: Schema.Literals(["UNCHECKED", "PASS", "FAIL", "UNKNOWN"]),
  service: Schema.Literals(["UNCHECKED", "PASS", "FAIL", "UNKNOWN"]),
}).annotate({ identifier: "Horizon.ProviderDoctorV1.RemoteChecksV1" })

export interface ResultV1 extends Schema.Schema.Type<typeof ResultV1> {}
export const ResultV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  doctorRunId: Identifier,
  tier: Schema.Literals(["offline", "catalog", "full"]),
  selection: SelectionV1,
  localReadiness: Schema.Literals(["READY", "INCOMPLETE", "INVALID", "UNKNOWN"]),
  catalogFreshness: Schema.Literals(["FRESH", "STALE", "UNKNOWN"]),
  remoteChecks: RemoteChecksV1,
  credentialAccess: Schema.Literals(["NOT_READ", "METADATA_ONLY", "CREDENTIAL_USED"]),
  networkRequestCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
  costStatus: Schema.Literals(["NOT_APPLICABLE", "NOT_INCURRED", "UNKNOWN", "CHARGED"]),
  probes: Schema.Array(ProbeV1).check(Schema.isMaxLength(16)),
})
  .annotate({ identifier: "Horizon.ProviderDoctorV1.ResultV1" })
  .check(
    Schema.makeFilter((result) => {
      if (result.tier !== "offline") return undefined
      if (result.networkRequestCount !== 0) return "offline Doctor results cannot include network requests"
      if (result.credentialAccess !== "NOT_READ") return "offline Doctor results cannot read credentials"
      if (result.costStatus !== "NOT_APPLICABLE") return "offline Doctor results cannot report provider cost"
      if (
        result.remoteChecks.entitlement !== "UNCHECKED" ||
        result.remoteChecks.quota !== "UNCHECKED" ||
        result.remoteChecks.service !== "UNCHECKED"
      )
        return "offline Doctor results cannot report remote checks"
      if (result.probes.some((probe) => probe.phase !== "config" && probe.outcome !== "SKIPPED"))
        return "offline Doctor results cannot report credential, catalog, capability, stream, tool, or cache probes"
      return undefined
    }),
  )
