/**
 * Pure candidate graph resolution. The caller must supply trusted profile policy and
 * schema-validated manifests. This module does not grant capabilities, authenticate
 * policy, persist a lock, activate plugins, or replace CompositionService validation.
 */

import { satisfies, valid as validVersion, validRange } from "semver"

export const COMPOSITION_LIMITS = {
  plugins: 16_384,
  entriesPerPlugin: 1024,
  totalOffers: 32_768,
  totalRequirements: 32_768,
  edges: 32_768,
  policyEntries: 32_768,
  versionRangeLength: 256,
} as const

export type CompositionCardinality = "one" | "many"

export type CompositionServiceOffer = {
  readonly serviceId: string
  readonly version: string
  readonly schemaDigest: string
  readonly cardinality: CompositionCardinality
}

export type CompositionServiceRequirement = {
  readonly serviceId: string
  readonly versionRange: string
  readonly schemaDigest?: string
  readonly cardinality: CompositionCardinality
  /** Missing optional requirements are allowed; incompatible present providers are not. */
  readonly optional: boolean
}

export type CompositionCandidatePlugin = {
  readonly pluginId: string
  readonly packageDigest: string
  readonly provides: readonly CompositionServiceOffer[]
  readonly requires: readonly CompositionServiceRequirement[]
}

export type TrustedSingletonSelection = {
  readonly serviceId: string
  readonly pluginId: string
}

export type TrustedProviderPriority = {
  readonly serviceId: string
  readonly pluginId: string
  readonly packageDigest: string
  /** Lower safe-integer values sort first for `many` providers. */
  readonly priority: number
}

export type TrustedSealedProvider = {
  readonly serviceId: string
  readonly pluginId: string
  readonly packageDigest: string
  /** These replacements are honored only when the trusted policy explicitly says `test`. */
  readonly testReplacements?: readonly {
    readonly pluginId: string
    readonly packageDigest: string
  }[]
}

export type TrustedCompositionPolicy = {
  readonly mode: "production" | "test"
  readonly singletonSelections?: readonly TrustedSingletonSelection[]
  readonly providerPriorities?: readonly TrustedProviderPriority[]
  readonly sealedProviders: readonly TrustedSealedProvider[]
}

export type CompositionResolveInput = {
  readonly plugins: readonly CompositionCandidatePlugin[]
  /**
   * Must come from a trusted CompositionService/profile boundary. A successful result
   * is only a candidate; the durable owner must independently revalidate the policy.
   */
  readonly trustedPolicy: TrustedCompositionPolicy
}

export type CompositionDiagnostic =
  | { readonly code: "duplicate_plugin_id"; readonly pluginId: string }
  | { readonly code: "duplicate_service_offer"; readonly pluginId: string; readonly serviceId: string }
  | { readonly code: "duplicate_requirement"; readonly pluginId: string; readonly serviceId: string }
  | { readonly code: "invalid_provider_priority"; readonly pluginId: string; readonly serviceId: string }
  | {
      readonly code: "invalid_provider_version"
      readonly pluginId: string
      readonly serviceId: string
      readonly version: string
    }
  | {
      readonly code: "invalid_requirement_range"
      readonly consumerPluginId: string
      readonly serviceId: string
      readonly versionRange: string
    }
  | {
      readonly code: "service_version_mismatch"
      readonly consumerPluginId: string
      readonly serviceId: string
      readonly providerPluginId: string
      readonly expectedRange: string
      readonly actual: string
    }
  | {
      readonly code: "composition_limit_exceeded"
      readonly collection: "plugins" | "offers" | "requirements" | "edges" | "policy"
      readonly actual: number
      readonly max: number
    }
  | { readonly code: "invalid_sealed_provider_policy"; readonly serviceId: string; readonly reason: string }
  | { readonly code: "invalid_plugin_manifest"; readonly candidateIndex: number }
  | { readonly code: "invalid_plugin_version"; readonly pluginId: string; readonly version: string }
  | { readonly code: "duplicate_service_definition"; readonly serviceId: string }
  | { readonly code: "unknown_service_definition"; readonly pluginId: string; readonly serviceId: string }
  | {
      readonly code: "service_offer_definition_mismatch"
      readonly pluginId: string
      readonly serviceId: string
      readonly field: "schemaDigest" | "cardinality" | "replaceability" | "authority"
    }
  | {
      readonly code: "invalid_implementation_ref"
      readonly pluginId: string
      readonly serviceId: string
    }
  | {
      readonly code: "required_service_definition_missing"
      readonly consumerPluginId: string
      readonly serviceId: string
    }
  | {
      readonly code: "manifest_requirement_mode_mismatch"
      readonly pluginId: string
      readonly serviceId: string
      readonly list: "requires" | "optionalRequires"
    }
  | {
      readonly code: "unknown_capability_request"
      readonly pluginId: string
      readonly capabilityId: string
    }
  | { readonly code: "missing_sealed_provider"; readonly serviceId: string; readonly pluginId: string }
  | {
      readonly code: "unauthorized_sealed_provider_replacement"
      readonly serviceId: string
      readonly pluginId: string
    }
  | {
      readonly code: "invalid_singleton_selection"
      readonly serviceId: string
      readonly pluginId: string
      readonly reason: "duplicate_selection" | "unknown_service" | "unknown_provider" | "selection_for_many_service"
    }
  | {
      readonly code: "inconsistent_provider_cardinality"
      readonly serviceId: string
      readonly providers: readonly { readonly pluginId: string; readonly cardinality: CompositionCardinality }[]
    }
  | { readonly code: "singleton_ambiguity"; readonly serviceId: string; readonly providerPluginIds: readonly string[] }
  | { readonly code: "missing_required_service"; readonly consumerPluginId: string; readonly serviceId: string }
  | {
      readonly code: "cardinality_mismatch"
      readonly consumerPluginId: string
      readonly serviceId: string
      readonly providerPluginId: string
      readonly expected: CompositionCardinality
      readonly actual: CompositionCardinality
    }
  | {
      readonly code: "schema_mismatch"
      readonly consumerPluginId: string
      readonly serviceId: string
      readonly providerPluginId: string
      readonly expected: string
      readonly actual: string
    }
  | { readonly code: "dependency_cycle"; readonly path: readonly string[] }

export type CompositionResolvedProvider = {
  readonly serviceId: string
  readonly pluginId: string
  readonly packageDigest: string
  readonly priority: number
}

export type CompositionDependencyEdge = {
  readonly consumerPluginId: string
  readonly serviceId: string
  readonly providerPluginId: string
}

export type CompositionResolution =
  | {
      readonly ok: true
      readonly providers: readonly CompositionResolvedProvider[]
      readonly dependencyEdges: readonly CompositionDependencyEdge[]
      readonly activationOrder: readonly string[]
    }
  | { readonly ok: false; readonly diagnostics: readonly CompositionDiagnostic[] }

type OfferedProvider = {
  readonly plugin: CompositionCandidatePlugin
  readonly offer: CompositionServiceOffer
  readonly priority: number
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

const comparePlugin = (left: CompositionCandidatePlugin, right: CompositionCandidatePlugin) =>
  compareText(left.pluginId, right.pluginId) || compareText(left.packageDigest, right.packageDigest)

const compareProvider = (left: OfferedProvider, right: OfferedProvider) =>
  (left.priority < right.priority ? -1 : left.priority > right.priority ? 1 : 0) ||
  compareText(left.plugin.pluginId, right.plugin.pluginId) ||
  compareText(left.plugin.packageDigest, right.plugin.packageDigest)

const compareDiagnostic = (left: CompositionDiagnostic, right: CompositionDiagnostic) =>
  compareText(JSON.stringify(left), JSON.stringify(right))

const failure = (diagnostics: readonly CompositionDiagnostic[]): CompositionResolution => ({
  ok: false,
  diagnostics: [...diagnostics].sort(compareDiagnostic),
})

function compatibilityDiagnostics(
  consumerPluginId: string,
  requirement: CompositionServiceRequirement,
  provider: OfferedProvider,
): CompositionDiagnostic[] {
  const diagnostics: CompositionDiagnostic[] = []
  if (requirement.cardinality !== provider.offer.cardinality) {
    diagnostics.push({
      code: "cardinality_mismatch",
      consumerPluginId,
      serviceId: requirement.serviceId,
      providerPluginId: provider.plugin.pluginId,
      expected: requirement.cardinality,
      actual: provider.offer.cardinality,
    })
  }
  if (!satisfies(provider.offer.version, requirement.versionRange, { includePrerelease: false })) {
    diagnostics.push({
      code: "service_version_mismatch",
      consumerPluginId,
      serviceId: requirement.serviceId,
      providerPluginId: provider.plugin.pluginId,
      expectedRange: requirement.versionRange,
      actual: provider.offer.version,
    })
  }
  if (requirement.schemaDigest !== undefined && requirement.schemaDigest !== provider.offer.schemaDigest) {
    diagnostics.push({
      code: "schema_mismatch",
      consumerPluginId,
      serviceId: requirement.serviceId,
      providerPluginId: provider.plugin.pluginId,
      expected: requirement.schemaDigest,
      actual: provider.offer.schemaDigest,
    })
  }
  return diagnostics
}

type GraphFrame = { readonly pluginId: string; nextDependency: number }

function graphDependencies(pluginIds: readonly string[], edges: readonly CompositionDependencyEdge[]) {
  const dependencySets = new Map<string, Set<string>>()
  for (const pluginId of pluginIds) dependencySets.set(pluginId, new Set())
  for (const edge of edges) dependencySets.get(edge.consumerPluginId)?.add(edge.providerPluginId)
  return new Map([...dependencySets].map(([pluginId, dependencies]) => [pluginId, [...dependencies].sort(compareText)]))
}

function findCyclePath(pluginIds: readonly string[], dependencyEdges: readonly CompositionDependencyEdge[]) {
  const dependencies = graphDependencies(pluginIds, dependencyEdges)
  const state = new Map<string, "visiting" | "visited">()
  for (const start of pluginIds) {
    if (state.has(start)) continue
    const path = [start]
    const pathIndex = new Map([[start, 0]])
    const frames: GraphFrame[] = [{ pluginId: start, nextDependency: 0 }]
    state.set(start, "visiting")
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      const children = dependencies.get(frame.pluginId) ?? []
      if (frame.nextDependency >= children.length) {
        state.set(frame.pluginId, "visited")
        frames.pop()
        pathIndex.delete(frame.pluginId)
        path.pop()
        continue
      }
      const child = children[frame.nextDependency]
      frame.nextDependency += 1
      if (state.get(child) === "visiting") {
        const cycleStart = pathIndex.get(child)
        if (cycleStart !== undefined) return [...path.slice(cycleStart), child]
      }
      if (state.has(child)) continue
      state.set(child, "visiting")
      pathIndex.set(child, path.length)
      path.push(child)
      frames.push({ pluginId: child, nextDependency: 0 })
    }
  }
  return undefined
}

function topologicalOrder(pluginIds: readonly string[], edges: readonly CompositionDependencyEdge[]) {
  const dependencies = graphDependencies(pluginIds, edges)
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const pluginId of pluginIds) {
    indegree.set(pluginId, dependencies.get(pluginId)?.length ?? 0)
    dependents.set(pluginId, [])
  }
  for (const [consumer, providers] of dependencies) {
    for (const provider of providers) dependents.get(provider)?.push(consumer)
  }
  for (const consumers of dependents.values()) consumers.sort(compareText)

  const ready = new MinHeap()
  for (const pluginId of pluginIds) {
    if (indegree.get(pluginId) === 0) ready.push(pluginId)
  }
  const order: string[] = []
  while (ready.size > 0) {
    const provider = ready.pop()!
    order.push(provider)
    for (const consumer of dependents.get(provider) ?? []) {
      const remaining = (indegree.get(consumer) ?? 0) - 1
      indegree.set(consumer, remaining)
      if (remaining !== 0) continue
      ready.push(consumer)
    }
  }
  return order
}

class MinHeap {
  private readonly values: string[] = []

  get size() {
    return this.values.length
  }

  push(value: string) {
    let index = this.values.length
    this.values.push(value)
    while (index > 0) {
      const parent = (index - 1) >>> 1
      if (compareText(this.values[parent], value) <= 0) break
      this.values[index] = this.values[parent]
      index = parent
    }
    this.values[index] = value
  }

  pop(): string | undefined {
    if (this.values.length === 0) return undefined
    const minimum = this.values[0]
    const last = this.values.pop()!
    if (this.values.length === 0) return minimum

    let index = 0
    while (true) {
      const left = index * 2 + 1
      if (left >= this.values.length) break
      const right = left + 1
      const child = right < this.values.length && compareText(this.values[right], this.values[left]) < 0 ? right : left
      if (compareText(this.values[child], last) >= 0) break
      this.values[index] = this.values[child]
      index = child
    }
    this.values[index] = last
    return minimum
  }
}

const identityKey = (serviceId: string, pluginId: string, packageDigest: string) =>
  JSON.stringify([serviceId, pluginId, packageDigest])

function preflight(input: CompositionResolveInput): CompositionDiagnostic[] {
  const diagnostics: CompositionDiagnostic[] = []
  if (input.plugins.length > COMPOSITION_LIMITS.plugins) {
    diagnostics.push({
      code: "composition_limit_exceeded",
      collection: "plugins",
      actual: input.plugins.length,
      max: COMPOSITION_LIMITS.plugins,
    })
    return diagnostics
  }
  let offers = 0
  let requirements = 0
  for (const plugin of input.plugins) {
    if (plugin.provides.length > COMPOSITION_LIMITS.entriesPerPlugin) {
      diagnostics.push({
        code: "composition_limit_exceeded",
        collection: "offers",
        actual: plugin.provides.length,
        max: COMPOSITION_LIMITS.entriesPerPlugin,
      })
    }
    if (plugin.requires.length > COMPOSITION_LIMITS.entriesPerPlugin) {
      diagnostics.push({
        code: "composition_limit_exceeded",
        collection: "requirements",
        actual: plugin.requires.length,
        max: COMPOSITION_LIMITS.entriesPerPlugin,
      })
    }
    offers += plugin.provides.length
    requirements += plugin.requires.length
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
  let replacementEntries = 0
  for (const sealed of input.trustedPolicy.sealedProviders) {
    replacementEntries += sealed.testReplacements?.length ?? 0
  }
  const policyEntries =
    input.trustedPolicy.sealedProviders.length +
    (input.trustedPolicy.singletonSelections?.length ?? 0) +
    (input.trustedPolicy.providerPriorities?.length ?? 0) +
    replacementEntries
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

function validateTrustedPolicy(
  policy: TrustedCompositionPolicy,
  plugins: readonly CompositionCandidatePlugin[],
): CompositionDiagnostic[] {
  const diagnostics: CompositionDiagnostic[] = []
  const serviceIds = new Set<string>()
  for (const sealed of policy.sealedProviders) {
    if (serviceIds.has(sealed.serviceId)) {
      diagnostics.push({
        code: "invalid_sealed_provider_policy",
        serviceId: sealed.serviceId,
        reason: "duplicate sealed service policy",
      })
    }
    serviceIds.add(sealed.serviceId)
    const replacements = new Set<string>()
    for (const replacement of sealed.testReplacements ?? []) {
      const key = identityKey(sealed.serviceId, replacement.pluginId, replacement.packageDigest)
      if (
        replacements.has(key) ||
        (replacement.pluginId === sealed.pluginId && replacement.packageDigest === sealed.packageDigest)
      ) {
        diagnostics.push({
          code: "invalid_sealed_provider_policy",
          serviceId: sealed.serviceId,
          reason: "test replacement duplicates the sealed provider or another replacement",
        })
      }
      replacements.add(key)
    }
  }

  const knownOffers = new Set(
    plugins.flatMap((plugin) =>
      plugin.provides.map((offer) => identityKey(offer.serviceId, plugin.pluginId, plugin.packageDigest)),
    ),
  )
  const priorityKeys = new Set<string>()
  for (const priority of policy.providerPriorities ?? []) {
    const key = identityKey(priority.serviceId, priority.pluginId, priority.packageDigest)
    if (!Number.isSafeInteger(priority.priority) || priorityKeys.has(key) || !knownOffers.has(key)) {
      diagnostics.push({
        code: "invalid_provider_priority",
        pluginId: priority.pluginId,
        serviceId: priority.serviceId,
      })
    }
    priorityKeys.add(key)
  }
  return diagnostics
}

function validateSealedProviders(
  policy: TrustedCompositionPolicy,
  offersByService: ReadonlyMap<string, readonly OfferedProvider[]>,
): CompositionDiagnostic[] {
  const diagnostics: CompositionDiagnostic[] = []
  for (const sealed of policy.sealedProviders) {
    const providers = offersByService.get(sealed.serviceId) ?? []
    const sealedKey = identityKey(sealed.serviceId, sealed.pluginId, sealed.packageDigest)
    const replacementKeys = new Set(
      policy.mode === "test"
        ? (sealed.testReplacements ?? []).map((replacement) =>
            identityKey(sealed.serviceId, replacement.pluginId, replacement.packageDigest),
          )
        : [],
    )
    const hasAllowedProvider = providers.some(
      (provider) =>
        identityKey(sealed.serviceId, provider.plugin.pluginId, provider.plugin.packageDigest) === sealedKey ||
        replacementKeys.has(identityKey(sealed.serviceId, provider.plugin.pluginId, provider.plugin.packageDigest)),
    )
    if (!hasAllowedProvider) {
      diagnostics.push({
        code: "missing_sealed_provider",
        serviceId: sealed.serviceId,
        pluginId: sealed.pluginId,
      })
    }
    for (const provider of providers) {
      const key = identityKey(sealed.serviceId, provider.plugin.pluginId, provider.plugin.packageDigest)
      if (key !== sealedKey && !replacementKeys.has(key)) {
        diagnostics.push({
          code: "unauthorized_sealed_provider_replacement",
          serviceId: sealed.serviceId,
          pluginId: provider.plugin.pluginId,
        })
      }
      if (provider.offer.cardinality !== "one") {
        diagnostics.push({
          code: "invalid_sealed_provider_policy",
          serviceId: sealed.serviceId,
          reason: "sealed services must have singleton cardinality",
        })
      }
    }
  }
  return diagnostics
}

/** Resolve provider assignments and a stable provider-before-consumer activation order. */
export function resolveComposition(input: CompositionResolveInput): CompositionResolution {
  const earlyDiagnostics = preflight(input)
  if (earlyDiagnostics.length > 0) return failure(earlyDiagnostics)

  const plugins = [...input.plugins].sort(comparePlugin)
  const diagnostics = validateTrustedPolicy(input.trustedPolicy, plugins)
  const pluginIds = new Set<string>()
  let totalOffers = 0
  let totalRequirements = 0

  for (const plugin of plugins) {
    if (pluginIds.has(plugin.pluginId)) diagnostics.push({ code: "duplicate_plugin_id", pluginId: plugin.pluginId })
    pluginIds.add(plugin.pluginId)

    const offerIds = new Set<string>()
    for (const offer of plugin.provides) {
      totalOffers += 1
      if (offerIds.has(offer.serviceId)) {
        diagnostics.push({ code: "duplicate_service_offer", pluginId: plugin.pluginId, serviceId: offer.serviceId })
      }
      offerIds.add(offer.serviceId)
      if (validVersion(offer.version) === null) {
        diagnostics.push({
          code: "invalid_provider_version",
          pluginId: plugin.pluginId,
          serviceId: offer.serviceId,
          version: offer.version,
        })
      }
    }

    const requirementIds = new Set<string>()
    for (const requirement of plugin.requires) {
      totalRequirements += 1
      if (requirementIds.has(requirement.serviceId)) {
        diagnostics.push({ code: "duplicate_requirement", pluginId: plugin.pluginId, serviceId: requirement.serviceId })
      }
      requirementIds.add(requirement.serviceId)
      if (
        requirement.versionRange.length > COMPOSITION_LIMITS.versionRangeLength ||
        validRange(requirement.versionRange, { includePrerelease: false }) === null
      ) {
        diagnostics.push({
          code: "invalid_requirement_range",
          consumerPluginId: plugin.pluginId,
          serviceId: requirement.serviceId,
          versionRange: requirement.versionRange,
        })
      }
    }
  }
  if (totalOffers > COMPOSITION_LIMITS.totalOffers || totalRequirements > COMPOSITION_LIMITS.totalRequirements) {
    return failure([
      ...diagnostics,
      ...(totalOffers > COMPOSITION_LIMITS.totalOffers
        ? [
            {
              code: "composition_limit_exceeded" as const,
              collection: "offers" as const,
              actual: totalOffers,
              max: COMPOSITION_LIMITS.totalOffers,
            },
          ]
        : []),
      ...(totalRequirements > COMPOSITION_LIMITS.totalRequirements
        ? [
            {
              code: "composition_limit_exceeded" as const,
              collection: "requirements" as const,
              actual: totalRequirements,
              max: COMPOSITION_LIMITS.totalRequirements,
            },
          ]
        : []),
    ])
  }
  if (diagnostics.length > 0) return failure(diagnostics)

  const priorityByIdentity = new Map<string, number>()
  for (const priority of input.trustedPolicy.providerPriorities ?? []) {
    priorityByIdentity.set(
      identityKey(priority.serviceId, priority.pluginId, priority.packageDigest),
      priority.priority,
    )
  }

  const offersByService = new Map<string, OfferedProvider[]>()
  for (const plugin of plugins) {
    for (const offer of plugin.provides) {
      const providers = offersByService.get(offer.serviceId) ?? []
      providers.push({
        plugin,
        offer,
        priority: priorityByIdentity.get(identityKey(offer.serviceId, plugin.pluginId, plugin.packageDigest)) ?? 0,
      })
      offersByService.set(offer.serviceId, providers)
    }
  }
  for (const providers of offersByService.values()) providers.sort(compareProvider)

  diagnostics.push(...validateSealedProviders(input.trustedPolicy, offersByService))

  const selections = new Map<string, TrustedSingletonSelection>()
  const selectionsByService = new Map<string, TrustedSingletonSelection[]>()
  for (const selection of input.trustedPolicy.singletonSelections ?? []) {
    const serviceSelections = selectionsByService.get(selection.serviceId) ?? []
    serviceSelections.push(selection)
    selectionsByService.set(selection.serviceId, serviceSelections)
  }
  for (const [serviceId, serviceSelections] of selectionsByService) {
    serviceSelections.sort((left, right) => compareText(left.pluginId, right.pluginId))
    const providers = offersByService.get(serviceId) ?? []
    if (serviceSelections.length > 1) {
      diagnostics.push({
        code: "invalid_singleton_selection",
        serviceId,
        pluginId: serviceSelections[0].pluginId,
        reason: "duplicate_selection",
      })
      continue
    }

    const selection = serviceSelections[0]
    if (providers.length === 0) {
      diagnostics.push({
        code: "invalid_singleton_selection",
        serviceId,
        pluginId: selection.pluginId,
        reason: "unknown_service",
      })
      continue
    }
    const provider = providers.find((candidate) => candidate.plugin.pluginId === selection.pluginId)
    if (!provider) {
      diagnostics.push({
        code: "invalid_singleton_selection",
        serviceId,
        pluginId: selection.pluginId,
        reason: "unknown_provider",
      })
      continue
    }
    if (provider.offer.cardinality !== "one") {
      diagnostics.push({
        code: "invalid_singleton_selection",
        serviceId,
        pluginId: selection.pluginId,
        reason: "selection_for_many_service",
      })
      continue
    }
    selections.set(serviceId, selection)
  }

  const providers: OfferedProvider[] = []
  for (const [serviceId, serviceProviders] of [...offersByService.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const cardinalities = new Set(serviceProviders.map((provider) => provider.offer.cardinality))
    if (cardinalities.size > 1) {
      diagnostics.push({
        code: "inconsistent_provider_cardinality",
        serviceId,
        providers: serviceProviders
          .map((provider) => ({ pluginId: provider.plugin.pluginId, cardinality: provider.offer.cardinality }))
          .sort((left, right) => compareText(left.pluginId, right.pluginId)),
      })
      continue
    }

    if (serviceProviders[0].offer.cardinality === "many") {
      providers.push(...serviceProviders)
      continue
    }

    const selection = selections.get(serviceId)
    if (selection) {
      const selectedProvider = serviceProviders.find((provider) => provider.plugin.pluginId === selection.pluginId)
      if (selectedProvider) providers.push(selectedProvider)
      continue
    }
    if (serviceProviders.length > 1) {
      diagnostics.push({
        code: "singleton_ambiguity",
        serviceId,
        providerPluginIds: serviceProviders.map((provider) => provider.plugin.pluginId).sort(compareText),
      })
      continue
    }
    providers.push(serviceProviders[0])
  }

  const resolvedByService = new Map<string, OfferedProvider[]>()
  for (const provider of providers) {
    const serviceProviders = resolvedByService.get(provider.offer.serviceId) ?? []
    serviceProviders.push(provider)
    resolvedByService.set(provider.offer.serviceId, serviceProviders)
  }

  const dependencyEdges: CompositionDependencyEdge[] = []
  for (const plugin of plugins) {
    const requirements = [...plugin.requires].sort((left, right) => compareText(left.serviceId, right.serviceId))
    for (const requirement of requirements) {
      const allOffers = offersByService.get(requirement.serviceId) ?? []
      if (allOffers.length === 0) {
        if (!requirement.optional) {
          diagnostics.push({
            code: "missing_required_service",
            consumerPluginId: plugin.pluginId,
            serviceId: requirement.serviceId,
          })
        }
        continue
      }

      const resolvedProviders = resolvedByService.get(requirement.serviceId)
      if (!resolvedProviders) continue

      const mismatches = resolvedProviders.flatMap((provider) =>
        compatibilityDiagnostics(plugin.pluginId, requirement, provider),
      )
      if (mismatches.length > 0) {
        diagnostics.push(...mismatches)
        continue
      }

      for (const provider of resolvedProviders) {
        if (dependencyEdges.length >= COMPOSITION_LIMITS.edges) {
          diagnostics.push({
            code: "composition_limit_exceeded",
            collection: "edges",
            actual: dependencyEdges.length + 1,
            max: COMPOSITION_LIMITS.edges,
          })
          break
        }
        dependencyEdges.push({
          consumerPluginId: plugin.pluginId,
          serviceId: requirement.serviceId,
          providerPluginId: provider.plugin.pluginId,
        })
      }
    }
  }

  const sortedPluginIds = plugins.map((plugin) => plugin.pluginId)
  const cyclePath = findCyclePath(sortedPluginIds, dependencyEdges)
  if (cyclePath) diagnostics.push({ code: "dependency_cycle", path: cyclePath })
  if (diagnostics.length > 0) return failure(diagnostics)

  return {
    ok: true,
    providers: providers.map((provider) => ({
      serviceId: provider.offer.serviceId,
      pluginId: provider.plugin.pluginId,
      packageDigest: provider.plugin.packageDigest,
      priority: provider.priority,
    })),
    dependencyEdges,
    activationOrder: topologicalOrder(sortedPluginIds, dependencyEdges),
  }
}
