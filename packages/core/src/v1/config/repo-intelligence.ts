import { Schema } from "effect"

export const AnalysisProfile = Schema.Literals(["lightweight", "adaptive", "full"]).annotate({
  identifier: "ConfigRepoIntelligenceAnalysisProfileV1",
})
export type AnalysisProfile = Schema.Schema.Type<typeof AnalysisProfile>
const ANALYSIS_PROFILES = ["lightweight", "adaptive", "full"] as const

export const Profile = Schema.Struct({
  // Preserve invalid legacy/user input so the trusted projection can show an
  // explicit invalid_configuration reason while resolving conservatively.
  profile: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
}).annotate({ identifier: "ConfigRepoIntelligenceV1" })
export type Profile = Schema.Schema.Type<typeof Profile>

export const ProfileProjection = Schema.Struct({
  requested: AnalysisProfile,
  /** Exact persisted request, including invalid input for conflict-safe repair. */
  requestedValue: Schema.Union([Schema.String.check(Schema.isMaxLength(64)), Schema.Null]),
  effective: AnalysisProfile,
  configurationSource: Schema.Literals(["default", "user", "project", "system_policy", "unknown"]),
  effectiveSource: Schema.Literals(["default", "settings", "platform", "policy", "resource", "unknown"]),
  policyLock: Schema.Literals(["locked", "unlocked", "unknown"]),
  reason: Schema.optional(
    Schema.Literals([
      "policy_restriction",
      "platform_unavailable",
      "resource_pressure",
      "feature_unavailable",
      "invalid_configuration",
    ]),
  ),
}).annotate({ identifier: "RepoIntelProfileProjectionV1" })
export type ProfileProjection = Schema.Schema.Type<typeof ProfileProjection>

export const UpdateProfile = Schema.Struct({
  expectedProfile: Schema.Union([Schema.String.check(Schema.isMaxLength(64)), Schema.Null]),
  profile: AnalysisProfile,
}).annotate({ identifier: "RepoIntelProfileUpdateV1" })
export type UpdateProfile = Schema.Schema.Type<typeof UpdateProfile>

/**
 * Resolve the requested mode conservatively. This projection is configuration
 * metadata only: it never starts indexing, processes, network calls, or models.
 */
export function resolveProfile(input: {
  readonly requested?: unknown
  readonly configurationSource?: ProfileProjection["configurationSource"]
  readonly policyLock?: ProfileProjection["policyLock"]
}): ProfileProjection {
  const supported = ANALYSIS_PROFILES.includes(input.requested as (typeof ANALYSIS_PROFILES)[number])
  const requested = supported ? (input.requested as AnalysisProfile) : "lightweight"
  const invalid = input.requested !== undefined && !supported
  const configurationSource = input.configurationSource ?? "unknown"
  const policyLock = input.policyLock ?? "unknown"
  // The profile selector is implemented as configuration, but richer analysis
  // is not enabled until its parser/LSP/overlay/resource gates are accepted.
  // Do not project a saved adaptive/full request as effective capability.
  const richerProfileUnavailable = requested !== "lightweight"
  const effective: AnalysisProfile = richerProfileUnavailable ? "lightweight" : requested
  return {
    requested,
    requestedValue: typeof input.requested === "string" ? input.requested : null,
    effective,
    configurationSource,
    effectiveSource:
      richerProfileUnavailable && !invalid
        ? "unknown"
        : invalid || input.requested === undefined || configurationSource === "default"
        ? "default"
        : configurationSource === "system_policy"
          ? "policy"
          : configurationSource === "user" || configurationSource === "project"
            ? "settings"
            : "unknown",
    policyLock,
    ...(invalid
      ? { reason: "invalid_configuration" as const }
      : richerProfileUnavailable
        ? { reason: "feature_unavailable" as const }
        : {}),
  }
}
