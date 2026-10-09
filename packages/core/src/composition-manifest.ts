/** Parse and semantically validate candidate manifests before graph resolution. */

import * as Manifest from "@opencode-ai/schema/composition-v1"
import { Schema } from "effect"
import { valid as validVersion } from "semver"
import {
  COMPOSITION_LIMITS,
  resolveComposition,
  type CompositionCandidatePlugin,
  type CompositionDiagnostic,
  type CompositionResolution,
  type TrustedCompositionPolicy,
} from "./composition"

export type ResolveManifestCompositionInput = {
  /** Untrusted decoded artifact values; no manifest code is loaded or executed here. */
  readonly manifests: readonly unknown[]
  /** Trusted service definitions and capability catalog from the host composition. */
  readonly serviceDefinitions: readonly Manifest.ServiceDefinitionV1[]
  /** Trusted profile policy; the durable CompositionService must revalidate it. */
  readonly trustedPolicy: TrustedCompositionPolicy
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const compareDiagnostic = (left: CompositionDiagnostic, right: CompositionDiagnostic) =>
  compareText(JSON.stringify(left), JSON.stringify(right))

function failed(diagnostics: readonly CompositionDiagnostic[]): CompositionResolution {
  return { ok: false, diagnostics: [...diagnostics].sort(compareDiagnostic) }
}

function rawListLength(candidate: unknown, field: string): number | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined
  const value = (candidate as Record<string, unknown>)[field]
  return Array.isArray(value) ? value.length : undefined
}

function preflightManifestLists(manifests: readonly unknown[]): CompositionDiagnostic[] {
  let offers = 0
  let requirements = 0
  let policyEntries = 0
  const diagnostics: CompositionDiagnostic[] = []

  for (const candidate of manifests) {
    const provides = rawListLength(candidate, "provides")
    const required = rawListLength(candidate, "requires")
    const optional = rawListLength(candidate, "optionalRequires")
    const capabilityRequests = rawListLength(candidate, "capabilityRequests")
    const contributionRefs = rawListLength(candidate, "contributionRefs")
    const targets = rawListLength(candidate, "targets")

    if (provides !== undefined) offers += provides
    const pluginRequirements = (required ?? 0) + (optional ?? 0)
    requirements += pluginRequirements
    const pluginPolicyEntries = (capabilityRequests ?? 0) + (contributionRefs ?? 0)
    policyEntries += pluginPolicyEntries

    if (provides !== undefined && provides > COMPOSITION_LIMITS.entriesPerPlugin) {
      diagnostics.push({
        code: "composition_limit_exceeded",
        collection: "offers",
        actual: provides,
        max: COMPOSITION_LIMITS.entriesPerPlugin,
      })
    }
    if (pluginRequirements > COMPOSITION_LIMITS.entriesPerPlugin) {
      diagnostics.push({
        code: "composition_limit_exceeded",
        collection: "requirements",
        actual: pluginRequirements,
        max: COMPOSITION_LIMITS.entriesPerPlugin,
      })
    }
    if (pluginPolicyEntries > COMPOSITION_LIMITS.entriesPerPlugin) {
      diagnostics.push({
        code: "composition_limit_exceeded",
        collection: "policy",
        actual: pluginPolicyEntries,
        max: COMPOSITION_LIMITS.entriesPerPlugin,
      })
    }
    if (targets !== undefined && targets > 6) {
      diagnostics.push({
        code: "composition_limit_exceeded",
        collection: "policy",
        actual: targets,
        max: 6,
      })
    }
  }

  if (offers > COMPOSITION_LIMITS.totalOffers) {
    diagnostics.push({
      code: "composition_limit_exceeded",
      collection: "offers",
      actual: offers,
      max: COMPOSITION_LIMITS.totalOffers,
    })
  }
  if (requirements > COMPOSITION_LIMITS.totalRequirements) {
    diagnostics.push({
      code: "composition_limit_exceeded",
      collection: "requirements",
      actual: requirements,
      max: COMPOSITION_LIMITS.totalRequirements,
    })
  }
  if (policyEntries > COMPOSITION_LIMITS.policyEntries) {
    diagnostics.push({
      code: "composition_limit_exceeded",
      collection: "policy",
      actual: policyEntries,
      max: COMPOSITION_LIMITS.policyEntries,
    })
  }
  return diagnostics
}

/**
 * Decode every candidate as data, verify it against trusted ServiceDefinitions and
 * the declared capability catalog, then pass only normalized offers/requirements to
 * the pure graph resolver. Durable CompositionService validation remains mandatory.
 */
export function resolveManifestComposition(input: ResolveManifestCompositionInput): CompositionResolution {
  if (input.manifests.length > COMPOSITION_LIMITS.plugins) {
    return failed([
      {
        code: "composition_limit_exceeded",
        collection: "plugins",
        actual: input.manifests.length,
        max: COMPOSITION_LIMITS.plugins,
      },
    ])
  }
  if (input.serviceDefinitions.length > COMPOSITION_LIMITS.policyEntries) {
    return failed([
      {
        code: "composition_limit_exceeded",
        collection: "policy",
        actual: input.serviceDefinitions.length,
        max: COMPOSITION_LIMITS.policyEntries,
      },
    ])
  }
  const listDiagnostics = preflightManifestLists(input.manifests)
  if (listDiagnostics.length > 0) return failed(listDiagnostics)

  const diagnostics: CompositionDiagnostic[] = []
  const definitions = new Map<string, Manifest.ServiceDefinitionV1>()
  for (const definition of input.serviceDefinitions) {
    if (definitions.has(definition.serviceId)) {
      diagnostics.push({ code: "duplicate_service_definition", serviceId: definition.serviceId })
      continue
    }
    definitions.set(definition.serviceId, definition)
  }
  const capabilityIds = new Set(
    [...definitions.values()].flatMap((definition) =>
      definition.capabilities.map((capability) => capability.capabilityId),
    ),
  )

  const decode = Schema.decodeUnknownSync(Manifest.PluginManifestV1)
  const manifests: Manifest.PluginManifestV1[] = []
  for (const [candidateIndex, value] of input.manifests.entries()) {
    try {
      manifests.push(decode(value))
    } catch {
      diagnostics.push({ code: "invalid_plugin_manifest", candidateIndex })
    }
  }
  if (diagnostics.length > 0) return failed(diagnostics)

  const candidates: CompositionCandidatePlugin[] = []
  for (const manifest of manifests) {
    if (validVersion(manifest.version) === null) {
      diagnostics.push({
        code: "invalid_plugin_version",
        pluginId: manifest.pluginId,
        version: manifest.version,
      })
    }
    const provides: Array<CompositionCandidatePlugin["provides"][number]> = []
    const requires: Array<CompositionCandidatePlugin["requires"][number]> = []

    for (const offer of manifest.provides) {
      const definition = definitions.get(offer.serviceId)
      if (!definition) {
        diagnostics.push({
          code: "unknown_service_definition",
          pluginId: manifest.pluginId,
          serviceId: offer.serviceId,
        })
        continue
      }
      if (offer.schemaDigest !== definition.schemaDigest) {
        diagnostics.push({
          code: "service_offer_definition_mismatch",
          pluginId: manifest.pluginId,
          serviceId: offer.serviceId,
          field: "schemaDigest",
        })
      }
      if (offer.cardinality !== definition.cardinality) {
        diagnostics.push({
          code: "service_offer_definition_mismatch",
          pluginId: manifest.pluginId,
          serviceId: offer.serviceId,
          field: "cardinality",
        })
      }
      if (offer.replaceability !== definition.replaceability) {
        diagnostics.push({
          code: "service_offer_definition_mismatch",
          pluginId: manifest.pluginId,
          serviceId: offer.serviceId,
          field: "replaceability",
        })
      }
      if (offer.authority !== definition.authority) {
        diagnostics.push({
          code: "service_offer_definition_mismatch",
          pluginId: manifest.pluginId,
          serviceId: offer.serviceId,
          field: "authority",
        })
      }
      const implementationPrefix = `${manifest.packageDigest}#`
      if (
        !offer.implementationRef.startsWith(implementationPrefix) ||
        offer.implementationRef.length === implementationPrefix.length
      ) {
        diagnostics.push({
          code: "invalid_implementation_ref",
          pluginId: manifest.pluginId,
          serviceId: offer.serviceId,
        })
      }
      provides.push({
        serviceId: offer.serviceId,
        version: offer.version,
        schemaDigest: offer.schemaDigest,
        cardinality: offer.cardinality,
      })
    }

    for (const requirement of manifest.requires) {
      if (requirement.optional) {
        diagnostics.push({
          code: "manifest_requirement_mode_mismatch",
          pluginId: manifest.pluginId,
          serviceId: requirement.serviceId,
          list: "requires",
        })
      }
      if (!definitions.has(requirement.serviceId)) {
        diagnostics.push({
          code: "required_service_definition_missing",
          consumerPluginId: manifest.pluginId,
          serviceId: requirement.serviceId,
        })
      }
      requires.push({ ...requirement, optional: false })
    }

    for (const requirement of manifest.optionalRequires) {
      if (!requirement.optional) {
        diagnostics.push({
          code: "manifest_requirement_mode_mismatch",
          pluginId: manifest.pluginId,
          serviceId: requirement.serviceId,
          list: "optionalRequires",
        })
      }
      requires.push({ ...requirement, optional: true })
    }

    for (const request of manifest.capabilityRequests) {
      if (!capabilityIds.has(request.capabilityId)) {
        diagnostics.push({
          code: "unknown_capability_request",
          pluginId: manifest.pluginId,
          capabilityId: request.capabilityId,
        })
      }
    }

    candidates.push({
      pluginId: manifest.pluginId,
      packageDigest: manifest.packageDigest,
      provides,
      requires,
    })
  }

  if (diagnostics.length > 0) return failed(diagnostics)
  return resolveComposition({ plugins: candidates, trustedPolicy: input.trustedPolicy })
}
