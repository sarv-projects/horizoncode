import { Schema } from "effect"

export const Dimension = Schema.Literals([
  "memoryBytes",
  "cpuMillicores",
  "processes",
  "fds",
  "diskBytes",
  "toolOutputBytes",
  "activeWorkers",
  "tokens",
  "providerCostMicros",
]).annotate({ identifier: "ResourceBudgetDimensionV1" })
export type Dimension = typeof Dimension.Type

const DecimalInteger = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))
const LimitValues = Schema.Struct({
  soft: Schema.optional(DecimalInteger),
  hard: Schema.optional(DecimalInteger),
}).check(Schema.makeFilter((value) =>
  value.soft === undefined || value.hard === undefined || BigInt(value.soft) <= BigInt(value.hard)
    ? undefined
    : "resource soft limit must not exceed hard limit",
))

/** User-requested exact limits. This does not impose or authorize execution. */
export const RequestedLimitV1 = Schema.Struct({
  soft: Schema.optional(DecimalInteger),
  hard: Schema.optional(DecimalInteger),
}).check(Schema.makeFilter((value) =>
  value.soft === undefined || value.hard === undefined || BigInt(value.soft) <= BigInt(value.hard)
    ? undefined
    : "resource soft limit must not exceed hard limit",
)).annotate({ identifier: "RequestedResourceLimitV1" })

export const ConfigV1 = Schema.Struct({
  limits: Schema.Record(Dimension, Schema.optional(RequestedLimitV1)),
}).annotate({ identifier: "ResourcePolicyConfigV1" })
export type ConfigV1 = typeof ConfigV1.Type

/** Canonical §18.18 effective limit authority. This is absent until facts exist. */
export const ResourceLimitV1 = Schema.Struct({
  dimension: Dimension,
  soft: Schema.optional(DecimalInteger),
  hard: Schema.optional(DecimalInteger),
  source: Schema.Literals(["OS_QUOTA", "USER", "WORKSPACE", "RUN", "SYSTEM_DEFAULT"]),
  enforcement: Schema.Literals(["HARD_OS", "ADMISSION_ONLY", "OBSERVE_ONLY", "UNSUPPORTED"]),
}).annotate({ identifier: "ResourceLimitV1" })
export type ResourceLimitV1 = typeof ResourceLimitV1.Type

export const LimitStateV1 = Schema.Struct({
  dimension: Dimension,
  requested: Schema.optional(LimitValues),
  effective: Schema.optional(ResourceLimitV1),
  configurationSource: Schema.Literals(["default", "user", "project", "run", "system_policy", "unknown"]),
  policyLock: Schema.Literals(["locked", "unlocked", "unknown"]),
  enforcement: Schema.Literals(["HARD_OS", "ADMISSION_ONLY", "OBSERVE_ONLY", "UNSUPPORTED"]),
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "ResourceLimitStateV1" })
export type LimitStateV1 = typeof LimitStateV1.Type

/** Canonical §18.18 effective limits; unknown entries are omitted, never fabricated. */
export const ResourcePolicyV1 = Schema.Struct({
  limits: Schema.mutable(Schema.Array(ResourceLimitV1).check(Schema.isMaxLength(9))),
}).annotate({ identifier: "ResourcePolicyV1" })
export type ResourcePolicyV1 = typeof ResourcePolicyV1.Type

/** Config/UI diagnostic projection; not itself an effective resource authority. */
export const ResourcePolicyProjectionV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  limits: Schema.mutable(Schema.Array(LimitStateV1).check(Schema.isMaxLength(9))),
}).annotate({ identifier: "ResourcePolicyProjectionV1" })
export type ResourcePolicyProjectionV1 = typeof ResourcePolicyProjectionV1.Type

export const DIMENSIONS: readonly Dimension[] = [
  "memoryBytes", "cpuMillicores", "processes", "fds", "diskBytes", "toolOutputBytes",
  "activeWorkers", "tokens", "providerCostMicros",
]

/** No calibrated/effective caps are fabricated; source config remains intent only. */
export function project(input: {
  requested?: ConfigV1
  origins?: Partial<Record<Dimension, {
    configurationSource: LimitStateV1["configurationSource"]
    policyLock: LimitStateV1["policyLock"]
    reason?: string
  }>>
}): ResourcePolicyProjectionV1 {
  const requested: Partial<Record<Dimension, Schema.Schema.Type<typeof RequestedLimitV1>>> =
    input.requested?.limits ?? {}
  return {
    schemaVersion: 1,
    limits: DIMENSIONS.map((dimension) => {
      const value = requested[dimension]
      const origin = input.origins?.[dimension]
      const locked = origin?.policyLock === "locked"
      return {
        dimension,
        ...(value ? { requested: { ...(value.soft === undefined ? {} : { soft: value.soft }), ...(value.hard === undefined ? {} : { hard: value.hard }) } } : {}),
        configurationSource: origin?.configurationSource ?? (value ? "unknown" : "default"),
        policyLock: origin?.policyLock ?? "unknown",
        enforcement: "UNSUPPORTED",
        // No effective ResourceLimitV1 is fabricated before platform facts and
        // enforcement exist. Keep the unsupported condition explicit.
        reason: locked
          ? origin?.reason ?? "Managed resource policy is visible but this platform has no verified enforcement"
          : "Effective limit and enforcement are unavailable until platform quota discovery and acceptance are implemented",
      }
    }),
  }
}
