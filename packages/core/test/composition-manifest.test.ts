import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as Manifest from "@opencode-ai/schema/composition-v1"
import {
  preflightGlobalHookBinding,
  preflightHookContribution,
  preflightHookResult,
  resolveManifestComposition,
} from "../src/composition-manifest"

const digest = "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

const serviceDefinition = Schema.decodeUnknownSync(Manifest.ServiceDefinitionV1)({
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
})

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
      implementationRef: `${digest}#NotesStore`,
    },
  ],
  requires: [],
  optionalRequires: [],
  capabilityRequests: [],
  contributionRefs: [],
  provenance: {
    source: "built-in",
    digest,
  },
} as const

const trustedPolicy = { mode: "production", sealedProviders: [] } as const

describe("resolveManifestComposition", () => {
  test("schema-checks manifests and resolves only service-definition-compatible offers", () => {
    const resolved = resolveManifestComposition({
      manifests: [manifest],
      serviceDefinitions: [serviceDefinition],
      trustedPolicy,
    })

    expect(resolved).toEqual({
      ok: true,
      providers: [
        {
          serviceId: "notes.store",
          pluginId: "plugin.notes",
          packageDigest: digest,
          priority: 0,
        },
      ],
      dependencyEdges: [],
      activationOrder: ["plugin.notes"],
    })
  })

  test("rejects malformed manifests without exposing exception or input details", () => {
    expect(
      resolveManifestComposition({
        manifests: [{ ...manifest, packageDigest: "sha256:secret-content" }],
        serviceDefinitions: [serviceDefinition],
        trustedPolicy,
      }),
    ).toEqual({
      ok: false,
      diagnostics: [{ code: "invalid_plugin_manifest", candidateIndex: 0 }],
    })
  })

  test("rejects oversized manifest lists before schema-decoding their entries", () => {
    const perPlugin = resolveManifestComposition({
      manifests: [{ provides: Array.from({ length: 1025 }, () => null) }],
      serviceDefinitions: [serviceDefinition],
      trustedPolicy,
    })
    expect(perPlugin).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "composition_limit_exceeded",
          collection: "offers",
          actual: 1025,
          max: 1024,
        },
      ],
    })

    const aggregate = resolveManifestComposition({
      manifests: Array.from({ length: 33 }, () => ({ provides: Array.from({ length: 1024 }, () => null) })),
      serviceDefinitions: [serviceDefinition],
      trustedPolicy,
    })
    expect(aggregate).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "composition_limit_exceeded",
          collection: "offers",
          actual: 33 * 1024,
          max: 32_768,
        },
      ],
    })

    const tooManyTargets = resolveManifestComposition({
      manifests: [{ targets: Array.from({ length: 7 }, () => "host") }],
      serviceDefinitions: [serviceDefinition],
      trustedPolicy,
    })
    expect(tooManyTargets).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "composition_limit_exceeded",
          collection: "policy",
          actual: 7,
          max: 6,
        },
      ],
    })
  })

  test("rejects unknown required services, definition drift, and unbound implementation refs", () => {
    const mismatch = resolveManifestComposition({
      manifests: [
        {
          ...manifest,
          provides: [
            {
              ...manifest.provides[0],
              schemaDigest: "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
              implementationRef: "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff#Other",
            },
          ],
          requires: [
            {
              serviceId: "missing.required",
              versionRange: "^1.0.0",
              cardinality: "one",
              optional: false,
            },
          ],
        },
      ],
      serviceDefinitions: [serviceDefinition],
      trustedPolicy,
    })

    expect(mismatch).toMatchObject({ ok: false })
    if (mismatch.ok) throw new Error("Expected manifest compatibility errors")
    expect(mismatch.diagnostics).toContainEqual({
      code: "service_offer_definition_mismatch",
      pluginId: "plugin.notes",
      serviceId: "notes.store",
      field: "schemaDigest",
    })
    expect(mismatch.diagnostics).toContainEqual({
      code: "invalid_implementation_ref",
      pluginId: "plugin.notes",
      serviceId: "notes.store",
    })
    expect(mismatch.diagnostics).toContainEqual({
      code: "required_service_definition_missing",
      consumerPluginId: "plugin.notes",
      serviceId: "missing.required",
    })
  })

  test("checks capability declarations but does not turn a request into a grant", () => {
    const candidate = {
      ...manifest,
      capabilityRequests: [
        {
          capabilityId: "filesystem.read",
          requestedScope: {
            artifactId: "scope_1",
            digest,
            byteLength: "1",
            mediaType: "application/json",
            classification: "workspace",
          },
          purpose: "read project notes",
          required: true,
        },
      ],
    }
    const unknown = resolveManifestComposition({
      manifests: [candidate],
      serviceDefinitions: [serviceDefinition],
      trustedPolicy,
    })
    expect(unknown).toMatchObject({ ok: false })
    if (unknown.ok) throw new Error("Expected undeclared capability rejection")
    expect(unknown.diagnostics).toContainEqual({
      code: "unknown_capability_request",
      pluginId: "plugin.notes",
      capabilityId: "filesystem.read",
    })
  })
})

describe("preflightHookContribution", () => {
  const contributionRef = {
    artifactId: "artifact_hook_1",
    digest,
    byteLength: "128",
    mediaType: "application/json",
    classification: "public",
  }
  const declaredManifest = { ...manifest, contributionRefs: [contributionRef] }
  const contribution = {
    schemaVersion: 1 as const,
    hookId: "hook.notes",
    pluginId: manifest.pluginId,
    version: manifest.version,
    packageDigest: manifest.packageDigest,
    implementationRef: `${digest}#Hook`,
    events: [],
    capabilityRequestDigests: [],
  }

  test("accepts only a declared locator with matching plugin identity", () => {
    const result = preflightHookContribution(declaredManifest, contributionRef, contribution)
    expect(result).toMatchObject({ ok: true, contribution, contributionRef })
  })

  test("rejects an undeclared locator without treating its digest as verified", () => {
    expect(preflightHookContribution(manifest, contributionRef, contribution)).toEqual({
      ok: false,
      diagnostic: { code: "hook_contribution_ref_not_declared" },
    })
  })

  test("rejects more capability digests than the manifest declares requests", () => {
    expect(
      preflightHookContribution(declaredManifest, contributionRef, {
        ...contribution,
        capabilityRequestDigests: [digest],
      }),
    ).toEqual({
      ok: false,
      diagnostic: { code: "hook_capability_digest_count_exceeds_manifest_requests" },
    })
  })

  test("rejects contribution identity drift against its declaring manifest", () => {
    for (const [field, value] of [
      ["pluginId", "plugin.other"],
      ["version", "2.0.0"],
      ["packageDigest", "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    ] as const) {
      const changed = {
        ...contribution,
        [field]: value,
        ...(field === "packageDigest" ? { implementationRef: `${value}#Hook` } : {}),
      }
      expect(preflightHookContribution(declaredManifest, contributionRef, changed)).toEqual({
        ok: false,
        diagnostic: { code: "hook_contribution_identity_mismatch", field },
      })
    }
  })

  test("resolves only a declared hook id and event for a global binding", () => {
    const binding = {
      event: "before_compaction",
      hookId: contribution.hookId,
      required: true,
      ordinal: 0,
    }
    const eventContract = {
      event: "before_compaction",
      mode: "BLOCKING",
      inputSchema: { schemaId: "hook.input", version: "1", digest },
      resultSchema: { schemaId: "hook.result", version: "1", digest },
      maxInputBytes: 1024,
      maxOutputBytes: 128,
      maxDurationMs: 100,
    } as const
    const contributionWithEvent = { ...contribution, events: [eventContract] }

    expect(preflightGlobalHookBinding(declaredManifest, contributionRef, contributionWithEvent, binding)).toMatchObject(
      { ok: true, binding, eventContract },
    )
    expect(
      preflightGlobalHookBinding(declaredManifest, contributionRef, contributionWithEvent, {
        ...binding,
        hookId: "hook.other",
      }),
    ).toEqual({ ok: false, diagnostic: { code: "global_hook_binding_id_mismatch" } })
    expect(
      preflightGlobalHookBinding(declaredManifest, contributionRef, contributionWithEvent, {
        ...binding,
        event: "after_compaction",
      }),
    ).toEqual({ ok: false, diagnostic: { code: "global_hook_binding_event_not_declared" } })
  })

  test("rejects malformed decoded inputs with bounded diagnostics", () => {
    expect(preflightHookContribution(declaredManifest, contributionRef, { ...contribution, events: [null] })).toEqual({
      ok: false,
      diagnostic: { code: "invalid_hook_contribution" },
    })
    expect(preflightHookContribution(declaredManifest, { ...contributionRef, digest: "bad" }, contribution)).toEqual({
      ok: false,
      diagnostic: { code: "invalid_contribution_ref" },
    })
  })
})

describe("preflightHookResult", () => {
  const blockingContract = {
    event: "before_tool",
    mode: "BLOCKING",
    inputSchema: { schemaId: "hook.input", version: "1", digest },
    resultSchema: { schemaId: "hook.result", version: "1", digest },
    maxInputBytes: 1024,
    maxOutputBytes: 8,
    maxDurationMs: 100,
  } as const
  const reason = {
    artifactId: "artifact_reason_1",
    digest,
    byteLength: "8",
    mediaType: "text/plain",
    classification: "public",
  } as const

  test("allows bounded BLOCK only for a blocking event", () => {
    expect(preflightHookResult(blockingContract, { decision: "BLOCK", reason })).toMatchObject({
      ok: true,
      result: { decision: "BLOCK", reason },
    })
    expect(
      preflightHookResult(
        { ...blockingContract, event: "after_tool", mode: "OBSERVATIONAL" },
        {
          decision: "CONTINUE",
        },
      ),
    ).toMatchObject({ ok: true, result: { decision: "CONTINUE" } })
  })

  test("rejects BLOCK for observational events and reason artifacts over the limit", () => {
    const observationalContract = {
      ...blockingContract,
      event: "after_tool",
      mode: "OBSERVATIONAL",
    }
    expect(preflightHookResult(observationalContract, { decision: "BLOCK", reason })).toEqual({
      ok: false,
      diagnostic: { code: "blocking_hook_result_on_observational_event" },
    })
    expect(
      preflightHookResult(blockingContract, {
        decision: "BLOCK",
        reason: { ...reason, byteLength: "9" },
      }),
    ).toEqual({
      ok: false,
      diagnostic: { code: "hook_reason_artifact_exceeds_output_limit" },
    })
  })

  test("rejects malformed contracts and results without exposing their contents", () => {
    expect(preflightHookResult({ ...blockingContract, event: "after_tool" }, { decision: "CONTINUE" })).toEqual({
      ok: false,
      diagnostic: { code: "invalid_hook_event_contract" },
    })
    expect(preflightHookResult(blockingContract, { decision: "BLOCK", reason: "secret" })).toEqual({
      ok: false,
      diagnostic: { code: "invalid_hook_result" },
    })
    expect(
      preflightHookResult(
        { ...blockingContract, maxOutputBytes: Number.MAX_SAFE_INTEGER + 1 },
        { decision: "CONTINUE" },
      ),
    ).toEqual({ ok: false, diagnostic: { code: "invalid_hook_event_contract" } })
  })
})
