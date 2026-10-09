import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as Composition from "../src/composition-v1"

const digest = Schema.decodeUnknownSync(Composition.Digest)(
  "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)

const artifact = Schema.decodeUnknownSync(Composition.ArtifactRef)({
  artifactId: "art_1",
  digest,
  byteLength: "12",
  mediaType: "application/json",
  classification: "workspace",
} as unknown)

const manifest = {
  manifestVersion: 1,
  pluginId: "plugin.notes",
  version: "1.2.3",
  packageDigest: digest,
  targets: ["host"],
  trustClass: "first_party",
  provides: [
    {
      serviceId: "notes.store",
      version: "1.0.0",
      schemaDigest: digest,
      cardinality: "one",
      replaceability: "startup_replaceable",
      authority: "advisory",
      implementationRef: "package:plugin.notes#NotesStore",
    },
  ],
  requires: [],
  optionalRequires: [],
  capabilityRequests: [],
  contributionRefs: [artifact],
  provenance: {
    source: "built-in",
    digest,
  },
} as const

const baseLock = {
  schemaVersion: 1,
  generation: "gen_1",
  profileId: "profile_1",
  resolverVersion: "1.0.0",
  nodes: [],
  providers: [],
  edges: [],
  approvedCapabilityDigests: [],
  globalHookBindings: [],
  resolvedGlobalHooks: [],
  configDigest: digest,
  activationOrder: [],
  resolvedAt: "2026-10-08T12:30:45.123Z",
  lockDigest: digest,
} as const

const hookNode = {
  pluginId: "plugin.notes",
  version: "1.2.3",
  packageDigest: digest,
  schemaDigests: [],
  contributionDigests: [digest],
  activationOrdinal: 0,
} as const

describe("Horizon composition v1 contracts", () => {
  test("decodes manifest, service and provenance contracts", () => {
    expect(Schema.decodeUnknownSync(Composition.PluginManifestV1)(manifest as unknown)).toEqual(manifest)
    expect(
      Schema.decodeUnknownSync(Composition.ServiceDefinitionV1)({
        serviceId: "notes.store",
        apiVersion: "1",
        schemaDigest: digest,
        cardinality: "one",
        replaceability: "startup_replaceable",
        authority: "advisory",
        executionClass: "kernel",
        capabilities: [],
        operations: [],
        readiness: "required",
      }).readiness,
    ).toBe("required")
  })

  test("rejects malformed digests, versions, trust classes and hook event names", () => {
    const decodeManifest = Schema.decodeUnknownSync(Composition.PluginManifestV1)
    expect(() => decodeManifest({ ...manifest, packageDigest: "sha256:abc" } as unknown)).toThrow()
    expect(() => decodeManifest({ ...manifest, version: "v1" } as unknown)).toThrow()
    expect(() => decodeManifest({ ...manifest, version: "9007199254740992.0.0" } as unknown)).toThrow()
    expect(() => decodeManifest({ ...manifest, trustClass: "trusted" } as unknown)).toThrow()
    expect(() => decodeManifest({ ...manifest, targets: ["host", "host"] } as unknown)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Composition.HookEventContractV1)({
        event: "on_startish",
        mode: "BLOCKING",
        inputSchema: { schemaId: "hook.input", version: "1", digest },
        resultSchema: { schemaId: "hook.result", version: "1", digest },
        maxInputBytes: 1,
        maxOutputBytes: 1,
        maxDurationMs: 1,
      } as unknown),
    ).toThrow()
  })

  test("enforces canonical u64 decimals, valid UTC millisecond timestamps and hook mode restrictions", () => {
    const decodeU64 = Schema.decodeUnknownSync(Composition.UInt64Decimal)
    expect(decodeU64("18446744073709551615")).toBe("18446744073709551615")
    expect(() => decodeU64("18446744073709551616")).toThrow()
    expect(() => decodeU64("01")).toThrow()

    const decodeTimestamp = Schema.decodeUnknownSync(Composition.Timestamp)
    expect(decodeTimestamp("2026-10-08T12:30:45.123Z")).toBe("2026-10-08T12:30:45.123Z")
    expect(() => decodeTimestamp("2026-02-30T12:30:45.123Z")).toThrow()

    expect(() =>
      Schema.decodeUnknownSync(Composition.HookEventContractV1)({
        event: "after_tool",
        mode: "BLOCKING",
        inputSchema: { schemaId: "hook.input", version: "1", digest },
        resultSchema: { schemaId: "hook.result", version: "1", digest },
        maxInputBytes: 1,
        maxOutputBytes: 1,
        maxDurationMs: 1,
      } as unknown),
    ).toThrow()
  })

  test("validates hook contribution identity, pinned implementation and unique declarations", () => {
    const event = {
      event: "before_tool",
      mode: "BLOCKING",
      inputSchema: { schemaId: "hook.input", version: "1", digest },
      resultSchema: { schemaId: "hook.result", version: "1", digest },
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      maxDurationMs: 100,
    } as const
    const contribution = {
      schemaVersion: 1 as const,
      hookId: "hook.summarize",
      pluginId: "plugin.notes",
      version: "1.2.3",
      packageDigest: digest,
      implementationRef: `${digest}#SummarizeHook`,
      events: [event],
      capabilityRequestDigests: [digest],
    }
    const decode = Schema.decodeUnknownSync(Composition.HookContributionV1)

    expect(decode(contribution)).toEqual(contribution)
    expect(() => decode({ ...contribution, implementationRef: "other#SummarizeHook" })).toThrow()
    expect(() => decode({ ...contribution, events: [event, event] })).toThrow()
    expect(() => decode({ ...contribution, capabilityRequestDigests: [digest, digest] })).toThrow()
    expect(() => decode({ ...contribution, events: Array.from({ length: 12 }, () => event) })).toThrow()
  })

  test("rejects incomplete or mismatched global-hook lock resolutions", () => {
    const binding = {
      event: "before_compaction",
      hookId: "hook.summarize",
      required: true,
      ordinal: 0,
    }
    const completeResolution = {
      event: binding.event,
      hookId: binding.hookId,
      ordinal: binding.ordinal,
      status: "RESOLVED",
      contributionDigest: digest,
      implementationDigest: digest,
      eventContractDigest: digest,
    }
    const hookLock = { ...baseLock, nodes: [hookNode] }
    const decodeLock = Schema.decodeUnknownSync(Composition.CompositionLockV1)

    expect(
      decodeLock({
        ...hookLock,
        globalHookBindings: [binding],
        resolvedGlobalHooks: [completeResolution],
      } as unknown).globalHookBindings,
    ).toHaveLength(1)

    expect(() =>
      decodeLock({
        ...hookLock,
        globalHookBindings: [binding],
        resolvedGlobalHooks: [{ ...completeResolution, implementationDigest: undefined }],
      } as unknown),
    ).toThrow()

    expect(() =>
      decodeLock({
        ...hookLock,
        globalHookBindings: [binding],
        resolvedGlobalHooks: [
          {
            event: binding.event,
            hookId: binding.hookId,
            ordinal: binding.ordinal,
            status: "OPTIONAL_UNAVAILABLE",
          },
        ],
      } as unknown),
    ).toThrow()

    expect(() =>
      decodeLock({
        ...hookLock,
        globalHookBindings: [binding],
        resolvedGlobalHooks: [{ ...completeResolution, ordinal: 1 }],
      } as unknown),
    ).toThrow()

    const secondBinding = {
      event: binding.event,
      hookId: "hook.second",
      required: false,
      ordinal: 1,
    }
    expect(() =>
      decodeLock({
        ...hookLock,
        globalHookBindings: [binding, secondBinding],
        resolvedGlobalHooks: [
          {
            event: secondBinding.event,
            hookId: secondBinding.hookId,
            ordinal: secondBinding.ordinal,
            status: "RESOLVED",
            contributionDigest: digest,
            implementationDigest: digest,
            eventContractDigest: digest,
          },
          completeResolution,
        ],
      } as unknown),
    ).toThrow()

    const optionalBinding = { ...binding, required: false }
    const unavailableResolution = {
      event: optionalBinding.event,
      hookId: optionalBinding.hookId,
      ordinal: optionalBinding.ordinal,
      status: "OPTIONAL_UNAVAILABLE",
    }
    expect(() =>
      decodeLock({
        ...hookLock,
        globalHookBindings: [optionalBinding],
        resolvedGlobalHooks: [unavailableResolution],
      } as unknown),
    ).toThrow()
    expect(() =>
      decodeLock({
        ...hookLock,
        globalHookBindings: [binding],
        resolvedGlobalHooks: [{ ...unavailableResolution, reasonCode: "HANDLER_UNAVAILABLE" }],
      } as unknown),
    ).toThrow()
    expect(
      decodeLock({
        ...hookLock,
        globalHookBindings: [optionalBinding],
        resolvedGlobalHooks: [{ ...unavailableResolution, reasonCode: "HANDLER_UNAVAILABLE" }],
      } as unknown).resolvedGlobalHooks,
    ).toHaveLength(1)
    expect(() =>
      decodeLock({
        ...hookLock,
        globalHookBindings: [optionalBinding],
        resolvedGlobalHooks: [{ ...unavailableResolution, reasonCode: "r".repeat(257) }],
      } as unknown),
    ).toThrow()
  })

  test("requires resolved global-hook contributions to be pinned by a selected lock node", () => {
    const binding = {
      event: "before_compaction",
      hookId: "hook.summarize",
      required: true,
      ordinal: 0,
    }
    const resolution = {
      event: binding.event,
      hookId: binding.hookId,
      ordinal: binding.ordinal,
      status: "RESOLVED",
      contributionDigest: digest,
      implementationDigest: digest,
      eventContractDigest: digest,
    }
    const lock = {
      ...baseLock,
      globalHookBindings: [binding],
      resolvedGlobalHooks: [resolution],
    }
    const otherDigest = Schema.decodeUnknownSync(Composition.Digest)(`blake3:${"a".repeat(64)}`)
    const decodeLock = Schema.decodeUnknownSync(Composition.CompositionLockV1)

    expect(() => decodeLock(lock as unknown)).toThrow()
    expect(decodeLock({ ...lock, nodes: [hookNode] } as unknown).resolvedGlobalHooks).toHaveLength(1)
    expect(() =>
      decodeLock({ ...lock, nodes: [{ ...hookNode, contributionDigests: [otherDigest] }] } as unknown),
    ).toThrow()
  })

  test("models fixed HookResult branches and optional keys omit undefined on encode", () => {
    expect(
      Schema.decodeUnknownSync(Composition.HookResultV1)({
        decision: "BLOCK",
        reason: artifact,
      }),
    ).toEqual({ decision: "BLOCK", reason: artifact })

    const decoded = Schema.decodeUnknownSync(Composition.PluginManifestV1)(manifest as unknown)
    const candidate = {
      ...decoded,
      provenance: { ...decoded.provenance, publisher: undefined, signatureRef: undefined },
      configSchema: undefined,
    }
    const encoded = Schema.encodeSync(Composition.PluginManifestV1)(candidate)
    expect(encoded).not.toHaveProperty("configSchema")
    expect(encoded.provenance).not.toHaveProperty("publisher")
    expect(encoded.provenance).not.toHaveProperty("signatureRef")
  })

  test("publishes stable unique identifiers for reusable contract schemas", () => {
    const schemas = [
      Composition.Cardinality,
      Composition.Replaceability,
      Composition.Authority,
      Composition.ExecutionClass,
      Composition.EffectClass,
      Composition.Idempotency,
      Composition.TrustClass,
      Composition.Target,
      Composition.HookEvent,
      Composition.BlockingHookEvent,
      Composition.ObservationalHookEvent,
      Composition.GlobalHookEvent,
      Composition.SemVer,
      Composition.UInt64Decimal,
      Composition.Timestamp,
      Composition.ArtifactRef,
      Composition.JsonSchemaRef,
      Composition.CapabilityDescriptor,
      Composition.OperationDescriptor,
      Composition.ServiceDefinitionV1,
      Composition.ServiceOfferV1,
      Composition.ServiceRequirementV1,
      Composition.CapabilityRequestV1,
      Composition.HookEventContractV1,
      Composition.HookContributionV1,
      Composition.HookResultV1,
      Composition.GlobalHookBindingV1,
      Composition.GlobalHookResolutionV1,
      Composition.PluginManifestV1,
      Composition.CompositionLockV1,
      Composition.CompositionGenerationV1,
      Composition.PluginGenerationV1,
      Composition.CompositionStateV1,
      Composition.TypedErrorV1,
    ]
    const identifiers = schemas.map((schema) => schema.ast.annotations?.identifier)
    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })
})
