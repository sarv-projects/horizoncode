import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as Manifest from "@opencode-ai/schema/composition-v1"
import { resolveManifestComposition } from "../src/composition-manifest"

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
