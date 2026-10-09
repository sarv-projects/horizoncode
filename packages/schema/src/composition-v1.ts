/**
 * Browser-safe Horizon composition contracts. This is a direct, specialized schema
 * entrypoint and is intentionally not exported from the OpenCode current-contract
 * root barrel. Runtime policy, SemVer range evaluation and durable ownership remain
 * in CompositionService/Core rather than this module.
 */

import { Schema } from "effect"
import { optional } from "./schema"

const MaxTextLength = 65_536
const MaxListLength = 32_768
const MaxIdentifierLength = 256

const Text = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(MaxTextLength))
const Identifier = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(MaxIdentifierLength))
  .check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/))
export const SemVer = Schema.String.annotate({ identifier: "Horizon.PluginManifestV1.SemVer" })
  .check(
    Schema.isPattern(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    ),
  )
  .check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((value) => {
      const core = value.split(/[+-]/, 1)[0]
      const components = core?.split(".") ?? []
      return components.length === 3 && components.every((component) => Number.isSafeInteger(Number(component)))
        ? undefined
        : "major, minor, and patch numbers must be within the safe integer range"
    }),
  )
export type SemVer = typeof SemVer.Type
export const Digest = Schema.String.annotate({ identifier: "Horizon.PluginManifestV1.Digest" })
  .check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/))
  .pipe(Schema.brand("Horizon.PluginManifestV1.Digest"))
export type Digest = typeof Digest.Type
export const UInt64Decimal = Schema.String.annotate({ identifier: "Horizon.PluginManifestV1.UInt64Decimal" }).check(
  Schema.makeFilter((value) => {
    const max = "18446744073709551615"
    const canonical = /^(0|[1-9]\d{0,19})$/.test(value)
    return canonical && (value.length < max.length || (value.length === max.length && value <= max))
      ? undefined
      : "must be a canonical unsigned 64-bit decimal string"
  }),
)
export type UInt64Decimal = typeof UInt64Decimal.Type
export const Timestamp = Schema.String.annotate({ identifier: "Horizon.PluginManifestV1.Timestamp" }).check(
  Schema.makeFilter((value) => {
    const matchesPrecision = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    const milliseconds = matchesPrecision ? Date.parse(value) : Number.NaN
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
      ? undefined
      : "must be a valid RFC 3339 UTC timestamp with millisecond precision"
  }),
)
export type Timestamp = typeof Timestamp.Type
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const BoundedList = <S extends Schema.Top>(item: S) => Schema.Array(item).check(Schema.isMaxLength(MaxListLength))

export const Cardinality = Schema.Literals(["one", "many"]).annotate({
  identifier: "Horizon.PluginManifestV1.Cardinality",
})
export type Cardinality = typeof Cardinality.Type

export const Replaceability = Schema.Literals(["sealed", "startup_replaceable", "hot_swappable"]).annotate({
  identifier: "Horizon.PluginManifestV1.Replaceability",
})
export type Replaceability = typeof Replaceability.Type

export const Authority = Schema.Literals(["canonical", "derived", "advisory", "presentation"]).annotate({
  identifier: "Horizon.PluginManifestV1.Authority",
})
export type Authority = typeof Authority.Type

export const ExecutionClass = Schema.Literals([
  "kernel",
  "host_trusted",
  "presentation",
  "wasm",
  "restricted_process",
]).annotate({ identifier: "Horizon.PluginManifestV1.ExecutionClass" })
export type ExecutionClass = typeof ExecutionClass.Type

export const EffectClass = Schema.Literals(["query", "local_preference", "guarded_effect", "control"]).annotate({
  identifier: "Horizon.PluginManifestV1.EffectClass",
})
export type EffectClass = typeof EffectClass.Type

export const Idempotency = Schema.Literals([
  "read_only",
  "delivery_id",
  "target_idempotency",
  "not_retryable",
]).annotate({ identifier: "Horizon.PluginManifestV1.Idempotency" })
export type Idempotency = typeof Idempotency.Type

export const TrustClass = Schema.Literals([
  "sealed_system",
  "first_party",
  "presentation",
  "wasm",
  "external_process",
  "opencode_compat",
  "mcp",
  "declarative",
]).annotate({ identifier: "Horizon.PluginManifestV1.TrustClass" })
export type TrustClass = typeof TrustClass.Type

export const Target = Schema.Literals(["host", "tui", "web", "desktop", "kernel-adapter", "worker"]).annotate({
  identifier: "Horizon.PluginManifestV1.Target",
})
export type Target = typeof Target.Type

export const HookEvent = Schema.Literals([
  "before_start",
  "after_start",
  "before_tool",
  "after_tool",
  "tool_failure",
  "before_finish",
  "after_finish",
  "on_failure",
  "on_idle",
  "before_compaction",
  "after_compaction",
]).annotate({ identifier: "Horizon.PluginManifestV1.HookEvent" })
export type HookEvent = typeof HookEvent.Type

export const BlockingHookEvent = Schema.Literals([
  "before_start",
  "before_tool",
  "before_finish",
  "before_compaction",
]).annotate({ identifier: "Horizon.PluginManifestV1.BlockingHookEvent" })
export type BlockingHookEvent = typeof BlockingHookEvent.Type

export const ObservationalHookEvent = Schema.Literals([
  "after_start",
  "after_tool",
  "tool_failure",
  "after_finish",
  "on_failure",
  "on_idle",
  "after_compaction",
]).annotate({ identifier: "Horizon.PluginManifestV1.ObservationalHookEvent" })
export type ObservationalHookEvent = typeof ObservationalHookEvent.Type

export const GlobalHookEvent = Schema.Literals(["before_compaction", "after_compaction"]).annotate({
  identifier: "Horizon.PluginManifestV1.GlobalHookEvent",
})
export type GlobalHookEvent = typeof GlobalHookEvent.Type

export interface ArtifactRef extends Schema.Schema.Type<typeof ArtifactRef> {}
export const ArtifactRef = Schema.Struct({
  artifactId: Identifier,
  digest: Digest,
  byteLength: UInt64Decimal,
  mediaType: Identifier,
  classification: Schema.Literals(["public", "workspace", "sensitive"]),
}).annotate({ identifier: "Horizon.PluginManifestV1.ArtifactRef" })

export interface JsonSchemaRef extends Schema.Schema.Type<typeof JsonSchemaRef> {}
export const JsonSchemaRef = Schema.Struct({
  schemaId: Identifier,
  version: Identifier,
  digest: Digest,
}).annotate({ identifier: "Horizon.PluginManifestV1.JsonSchemaRef" })

export interface CapabilityDescriptor extends Schema.Schema.Type<typeof CapabilityDescriptor> {}
export const CapabilityDescriptor = Schema.Struct({
  capabilityId: Identifier,
  version: SemVer,
  operationIds: BoundedList(Identifier),
  resourceKinds: BoundedList(Identifier),
  executionLocations: BoundedList(Identifier),
  maxLeaseMs: PositiveInt,
  revocable: Schema.Boolean,
  scopeSchema: JsonSchemaRef,
}).annotate({ identifier: "Horizon.PluginManifestV1.CapabilityDescriptor" })

export interface OperationDescriptor extends Schema.Schema.Type<typeof OperationDescriptor> {}
export const OperationDescriptor = Schema.Struct({
  operationId: Identifier,
  inputSchema: JsonSchemaRef,
  outputSchema: JsonSchemaRef,
  effectClass: EffectClass,
  authorizationOwner: optional(Identifier),
  idempotency: Idempotency,
  maxInputBytes: NonNegativeInt,
  maxOutputBytes: NonNegativeInt,
  maxDurationMs: PositiveInt,
}).annotate({ identifier: "Horizon.PluginManifestV1.OperationDescriptor" })

export interface ServiceDefinitionV1 extends Schema.Schema.Type<typeof ServiceDefinitionV1> {}
export const ServiceDefinitionV1 = Schema.Struct({
  serviceId: Identifier,
  apiVersion: Identifier,
  schemaDigest: Digest,
  cardinality: Cardinality,
  replaceability: Replaceability,
  authority: Authority,
  executionClass: ExecutionClass,
  capabilities: BoundedList(CapabilityDescriptor),
  operations: BoundedList(OperationDescriptor),
  readiness: Schema.Literals(["required", "optional"]),
}).annotate({ identifier: "Horizon.PluginManifestV1.ServiceDefinitionV1" })

export interface ServiceOfferV1 extends Schema.Schema.Type<typeof ServiceOfferV1> {}
export const ServiceOfferV1 = Schema.Struct({
  serviceId: Identifier,
  version: SemVer,
  schemaDigest: Digest,
  cardinality: Cardinality,
  replaceability: Replaceability,
  authority: Authority,
  implementationRef: Identifier,
}).annotate({ identifier: "Horizon.PluginManifestV1.ServiceOfferV1" })

export interface ServiceRequirementV1 extends Schema.Schema.Type<typeof ServiceRequirementV1> {}
export const ServiceRequirementV1 = Schema.Struct({
  serviceId: Identifier,
  versionRange: Text,
  schemaDigest: optional(Digest),
  cardinality: Cardinality,
  optional: Schema.Boolean,
}).annotate({ identifier: "Horizon.PluginManifestV1.ServiceRequirementV1" })

export interface CapabilityRequestV1 extends Schema.Schema.Type<typeof CapabilityRequestV1> {}
export const CapabilityRequestV1 = Schema.Struct({
  capabilityId: Identifier,
  requestedScope: ArtifactRef,
  purpose: Text,
  required: Schema.Boolean,
}).annotate({ identifier: "Horizon.PluginManifestV1.CapabilityRequestV1" })

const HookEventContractFields = {
  inputSchema: JsonSchemaRef,
  resultSchema: JsonSchemaRef,
  maxInputBytes: PositiveInt,
  maxOutputBytes: PositiveInt,
  maxDurationMs: PositiveInt,
}
export const HookEventContractV1 = Schema.Union(
  [
    Schema.Struct({ ...HookEventContractFields, event: BlockingHookEvent, mode: Schema.Literal("BLOCKING") }),
    Schema.Struct({ ...HookEventContractFields, event: ObservationalHookEvent, mode: Schema.Literal("OBSERVATIONAL") }),
  ],
  { mode: "oneOf" },
).annotate({ identifier: "Horizon.PluginManifestV1.HookEventContractV1" })
export type HookEventContractV1 = typeof HookEventContractV1.Type

export interface HookContributionV1 extends Schema.Schema.Type<typeof HookContributionV1> {}
export const HookContributionV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  hookId: Identifier,
  pluginId: Identifier,
  version: SemVer,
  packageDigest: Digest,
  implementationRef: Identifier,
  events: Schema.Array(HookEventContractV1).check(Schema.isMaxLength(11)),
  capabilityRequestDigests: Schema.Array(Digest).check(Schema.isMaxLength(1024)),
})
  .annotate({ identifier: "Horizon.PluginManifestV1.HookContributionV1" })
  .check(
    Schema.makeFilter((contribution) => {
      const events = new Set(contribution.events.map((contract) => contract.event))
      if (events.size !== contribution.events.length) {
        return "hook contribution events must be unique"
      }
      const capabilityDigests = new Set(contribution.capabilityRequestDigests)
      if (capabilityDigests.size !== contribution.capabilityRequestDigests.length) {
        return "hook contribution capability request digests must be unique"
      }
      const implementationPrefix = `${contribution.packageDigest}#`
      if (
        !contribution.implementationRef.startsWith(implementationPrefix) ||
        contribution.implementationRef.length === implementationPrefix.length
      ) {
        return "hook implementation reference must be an export from the pinned package"
      }
      return undefined
    }),
  )

export interface HookResultContinueV1 extends Schema.Schema.Type<typeof HookResultContinueV1> {}
export const HookResultContinueV1 = Schema.Struct({
  decision: Schema.Literal("CONTINUE"),
}).annotate({ identifier: "Horizon.PluginManifestV1.HookResultContinueV1" })

export interface HookResultBlockV1 extends Schema.Schema.Type<typeof HookResultBlockV1> {}
export const HookResultBlockV1 = Schema.Struct({
  decision: Schema.Literal("BLOCK"),
  reason: ArtifactRef,
}).annotate({ identifier: "Horizon.PluginManifestV1.HookResultBlockV1" })

export type HookResultV1 = HookResultContinueV1 | HookResultBlockV1
export const HookResultV1 = Schema.Union([HookResultContinueV1, HookResultBlockV1], { mode: "oneOf" }).annotate({
  identifier: "Horizon.PluginManifestV1.HookResultV1",
})

export interface GlobalHookBindingV1 extends Schema.Schema.Type<typeof GlobalHookBindingV1> {}
export const GlobalHookBindingV1 = Schema.Struct({
  event: GlobalHookEvent,
  hookId: Identifier,
  required: Schema.Boolean,
  ordinal: NonNegativeInt,
}).annotate({ identifier: "Horizon.PluginManifestV1.GlobalHookBindingV1" })

export interface GlobalHookResolutionV1 extends Schema.Schema.Type<typeof GlobalHookResolutionV1> {}
export const GlobalHookResolutionV1 = Schema.Struct({
  event: GlobalHookEvent,
  hookId: Identifier,
  ordinal: NonNegativeInt,
  status: Schema.Literals(["RESOLVED", "OPTIONAL_UNAVAILABLE"]),
  contributionDigest: optional(Digest),
  implementationDigest: optional(Digest),
  eventContractDigest: optional(Digest),
  reasonCode: optional(Identifier),
}).annotate({ identifier: "Horizon.PluginManifestV1.GlobalHookResolutionV1" })

export interface PluginProvenanceV1 extends Schema.Schema.Type<typeof PluginProvenanceV1> {}
export const PluginProvenanceV1 = Schema.Struct({
  source: Text,
  publisher: optional(Identifier),
  signatureRef: optional(ArtifactRef),
  digest: Digest,
}).annotate({ identifier: "Horizon.PluginManifestV1.PluginProvenanceV1" })

export interface PluginManifestV1 extends Schema.Schema.Type<typeof PluginManifestV1> {}
export const PluginManifestV1 = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  pluginId: Identifier,
  version: SemVer,
  packageDigest: Digest,
  targets: BoundedList(Target),
  trustClass: TrustClass,
  provides: BoundedList(ServiceOfferV1),
  requires: BoundedList(ServiceRequirementV1),
  optionalRequires: BoundedList(ServiceRequirementV1),
  capabilityRequests: BoundedList(CapabilityRequestV1),
  contributionRefs: BoundedList(ArtifactRef),
  provenance: PluginProvenanceV1,
  configSchema: optional(JsonSchemaRef),
})
  .annotate({ identifier: "Horizon.PluginManifestV1.PluginManifestV1" })
  .check(
    Schema.makeFilter((manifest) =>
      new Set(manifest.targets).size === manifest.targets.length ? undefined : "plugin manifest targets must be unique",
    ),
  )

export interface CompositionLockNodeV1 extends Schema.Schema.Type<typeof CompositionLockNodeV1> {}
export const CompositionLockNodeV1 = Schema.Struct({
  pluginId: Identifier,
  version: SemVer,
  packageDigest: Digest,
  schemaDigests: BoundedList(Digest),
  contributionDigests: BoundedList(Digest),
  activationOrdinal: NonNegativeInt,
}).annotate({ identifier: "Horizon.PluginManifestV1.CompositionLockNodeV1" })

export interface CompositionLockProviderV1 extends Schema.Schema.Type<typeof CompositionLockProviderV1> {}
export const CompositionLockProviderV1 = Schema.Struct({
  serviceId: Identifier,
  pluginId: Identifier,
  providerRef: Identifier,
  schemaDigest: Digest,
}).annotate({ identifier: "Horizon.PluginManifestV1.CompositionLockProviderV1" })

export interface CompositionDependencyEdgeV1 extends Schema.Schema.Type<typeof CompositionDependencyEdgeV1> {}
export const CompositionDependencyEdgeV1 = Schema.Struct({
  consumerPluginId: Identifier,
  serviceId: Identifier,
  providerPluginId: Identifier,
}).annotate({ identifier: "Horizon.PluginManifestV1.CompositionDependencyEdgeV1" })

export interface CompositionLockV1 extends Schema.Schema.Type<typeof CompositionLockV1> {}
export const CompositionLockV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generation: Identifier,
  profileId: Identifier,
  resolverVersion: SemVer,
  nodes: BoundedList(CompositionLockNodeV1),
  providers: BoundedList(CompositionLockProviderV1),
  edges: BoundedList(CompositionDependencyEdgeV1),
  approvedCapabilityDigests: BoundedList(Digest),
  globalHookBindings: BoundedList(GlobalHookBindingV1),
  resolvedGlobalHooks: BoundedList(GlobalHookResolutionV1),
  configDigest: Digest,
  activationOrder: BoundedList(Identifier),
  resolvedAt: Timestamp,
  lockDigest: Digest,
})
  .annotate({ identifier: "Horizon.PluginManifestV1.CompositionLockV1" })
  .check(
    Schema.makeFilter((lock) => {
      const bindings = new Map<string, (typeof lock.globalHookBindings)[number]>()
      const eventOrdinals = new Set<string>()
      const previousOrdinalByEvent = new Map<string, number>()
      for (const binding of lock.globalHookBindings) {
        const bindingKey = JSON.stringify([binding.event, binding.hookId])
        const ordinalKey = JSON.stringify([binding.event, binding.ordinal])
        const previousOrdinal = previousOrdinalByEvent.get(binding.event)
        if (
          bindings.has(bindingKey) ||
          eventOrdinals.has(ordinalKey) ||
          (previousOrdinal !== undefined && binding.ordinal <= previousOrdinal)
        ) {
          return "global hook bindings must have unique event/hook and event/ordinal pairs"
        }
        bindings.set(bindingKey, binding)
        eventOrdinals.add(ordinalKey)
        previousOrdinalByEvent.set(binding.event, binding.ordinal)
      }

      const resolutions = new Set<string>()
      const resolutionByKey = new Map<string, (typeof lock.resolvedGlobalHooks)[number]>()
      if (lock.resolvedGlobalHooks.length !== lock.globalHookBindings.length) {
        return "every global hook binding must have exactly one resolution"
      }
      for (const [index, resolution] of lock.resolvedGlobalHooks.entries()) {
        const resolutionKey = JSON.stringify([resolution.event, resolution.hookId])
        const binding = bindings.get(resolutionKey)
        const orderedBinding = lock.globalHookBindings[index]
        if (
          !binding ||
          binding.ordinal !== resolution.ordinal ||
          orderedBinding.event !== resolution.event ||
          orderedBinding.hookId !== resolution.hookId ||
          orderedBinding.ordinal !== resolution.ordinal ||
          resolutions.has(resolutionKey)
        ) {
          return "each global hook resolution must match one unique binding and ordinal"
        }
        resolutions.add(resolutionKey)
        resolutionByKey.set(resolutionKey, resolution)

        const hasDigests =
          resolution.contributionDigest !== undefined &&
          resolution.implementationDigest !== undefined &&
          resolution.eventContractDigest !== undefined
        const hasPartialDigests =
          resolution.contributionDigest !== undefined ||
          resolution.implementationDigest !== undefined ||
          resolution.eventContractDigest !== undefined
        if (resolution.status === "RESOLVED" && (!hasDigests || resolution.reasonCode !== undefined)) {
          return "resolved global hooks require all pinned digests and no failure reason"
        }
        if (
          resolution.status === "OPTIONAL_UNAVAILABLE" &&
          (binding.required || hasPartialDigests || resolution.reasonCode === undefined)
        ) {
          return "optional unavailable hooks require a bounded reason and cannot pin implementation digests"
        }
      }

      if (resolutions.size !== bindings.size) {
        return "every global hook binding must have exactly one resolution"
      }
      for (const binding of bindings.values()) {
        if (binding.required) {
          const resolution = resolutionByKey.get(JSON.stringify([binding.event, binding.hookId]))
          if (resolution?.status !== "RESOLVED") {
            return "required global hook bindings must resolve"
          }
        }
      }
      return undefined
    }),
  )

export const CompositionGenerationStateV1 = Schema.Literals([
  "CANDIDATE",
  "ACTIVATING",
  "READY",
  "CURRENT",
  "DRAINING",
  "FAILED",
  "QUARANTINED",
  "RETIRED",
]).annotate({ identifier: "Horizon.PluginManifestV1.CompositionGenerationStateV1" })
export type CompositionGenerationStateV1 = typeof CompositionGenerationStateV1.Type

export const PluginLifecycleStateV1 = Schema.Literals([
  "STAGED",
  "VALIDATED",
  "ENABLED",
  "ACTIVATING",
  "READY",
  "DRAINING",
  "DISABLED",
  "FAILED",
  "QUARANTINED",
  "REMOVED",
]).annotate({ identifier: "Horizon.PluginManifestV1.PluginLifecycleStateV1" })
export type PluginLifecycleStateV1 = typeof PluginLifecycleStateV1.Type

export interface TypedErrorV1 extends Schema.Schema.Type<typeof TypedErrorV1> {}
export const TypedErrorV1 = Schema.Struct({
  code: Identifier,
  category: Schema.Literals([
    "validation",
    "conflict",
    "authorization",
    "capability",
    "not_found",
    "unavailable",
    "deadline",
    "uncertain",
    "corruption",
    "internal",
  ]),
  message: Text,
  retryClass: Schema.Literals([
    "NEVER",
    "SAFE_QUERY_RETRY",
    "RETRY_AFTER_RECONCILIATION",
    "RETRY_AFTER_CONTEXT_RECOVERY",
    "USER_ACTION_REQUIRED",
    "RETRY_WITH_NEW_ID",
  ]),
  retryAfterMs: optional(NonNegativeInt),
  ownerCursor: optional(
    Schema.Struct({
      ownerKind: Identifier,
      ownerId: Identifier,
      seq: UInt64Decimal,
      eventDigest: Digest,
    }),
  ),
  subjectIds: BoundedList(Identifier),
  details: optional(ArtifactRef),
}).annotate({ identifier: "Horizon.PluginManifestV1.TypedErrorV1" })

export interface CompositionGenerationV1 extends Schema.Schema.Type<typeof CompositionGenerationV1> {}
export const CompositionGenerationV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generation: Identifier,
  lockDigest: Digest,
  previousGeneration: optional(Identifier),
  state: CompositionGenerationStateV1,
  activationReceipt: optional(ArtifactRef),
  failure: optional(TypedErrorV1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).annotate({ identifier: "Horizon.PluginManifestV1.CompositionGenerationV1" })

export interface PluginGenerationV1 extends Schema.Schema.Type<typeof PluginGenerationV1> {}
export const PluginGenerationV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  compositionGeneration: Identifier,
  pluginId: Identifier,
  packageDigest: Digest,
  compositionLockDigest: optional(Digest),
  configDigest: Digest,
  capabilityApprovalDigests: BoundedList(Digest),
  state: PluginLifecycleStateV1,
  activationReceipt: optional(ArtifactRef),
  failure: optional(TypedErrorV1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).annotate({ identifier: "Horizon.PluginManifestV1.PluginGenerationV1" })

export interface CompositionStateV1 extends Schema.Schema.Type<typeof CompositionStateV1> {}
export const CompositionStateV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  currentGeneration: optional(Identifier),
  candidateGeneration: optional(Identifier),
  generationCounter: UInt64Decimal,
  generations: BoundedList(CompositionGenerationV1),
  plugins: BoundedList(PluginGenerationV1),
  updatedAt: Timestamp,
}).annotate({ identifier: "Horizon.PluginManifestV1.CompositionStateV1" })
