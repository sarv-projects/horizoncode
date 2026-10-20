/** Pure offline Provider Doctor projection; it does not initialize provider, auth, catalog, or network services. */

export * as ProviderDoctor from "./doctor"

import { Schema } from "effect"
import type { TrustedPrincipalContextValue } from "@opencode-ai/core/trusted-principal"
import { ProviderDoctorV1 } from "@opencode-ai/schema/provider-doctor-v1"

const decodeRequest = Schema.decodeUnknownSync(ProviderDoctorV1.RequestV1)
const decodeResult = Schema.decodeUnknownSync(ProviderDoctorV1.ResultV1)

function configProbe(status: ProviderDoctorV1.SelectionV1["configurationStatus"]): ProviderDoctorV1.ProbeV1 {
  if (status === "VALID") return { phase: "config", outcome: "PASS", code: "local_config_valid" }
  if (status === "INVALID") return { phase: "config", outcome: "FAIL", code: "local_config_invalid" }
  return { phase: "config", outcome: "UNKNOWN", code: "local_config_status_unknown" }
}

function skippedProbe(phase: ProviderDoctorV1.ProbeV1["phase"], code: string): ProviderDoctorV1.ProbeV1 {
  return { phase, outcome: "SKIPPED", code }
}

export type OfflineProviderFacts = {
  catalog: Record<string, { models: Record<string, unknown> }>
  catalogFreshness?: "fresh" | "stale" | "unknown"
  config: {
    enabled_providers?: string[]
    disabled_providers?: string[]
    provider?: Record<string, { models?: Record<string, unknown>; whitelist?: string[]; blacklist?: string[] }>
  }
}

function inspectSelection(selection: ProviderDoctorV1.RequestV1["selection"], facts?: OfflineProviderFacts) {
  const provider = /^provider:([^/]+)$/.exec(selection.providerRef)?.[1]
  if (!provider) {
    return {
      configurationStatus: "INVALID" as const,
      localReadiness: "INVALID" as const,
      probe: configProbe("INVALID"),
    }
  }
  if (selection.modelRef === undefined) {
    return {
      configurationStatus: "UNKNOWN" as const,
      localReadiness: "INCOMPLETE" as const,
      probe: configProbe("UNKNOWN"),
    }
  }

  const model = /^model:([^/]+)\/(.+)$/.exec(selection.modelRef)
  if (!model) {
    return {
      configurationStatus: "INVALID" as const,
      localReadiness: "INVALID" as const,
      probe: { phase: "config" as const, outcome: "FAIL" as const, code: "invalid_selection_reference" },
    }
  }
  if (provider === "unselected" || model[1] !== provider) {
    return {
      configurationStatus: "INVALID" as const,
      localReadiness: "INVALID" as const,
      probe: { phase: "config" as const, outcome: "FAIL" as const, code: "selected_model_provider_mismatch" },
    }
  }
  if (facts) {
    const providerConfig = facts.config.provider?.[provider]
    const catalogProvider = facts.catalog[provider]
    const providerKnown = providerConfig !== undefined || catalogProvider !== undefined
    if (!providerKnown) {
      return {
        configurationStatus: "UNKNOWN" as const,
        localReadiness: "UNKNOWN" as const,
        probe: { phase: "config" as const, outcome: "UNKNOWN" as const, code: "provider_missing_from_local_catalog" },
      }
    }
    if (
      facts.config.disabled_providers?.includes(provider) ||
      (facts.config.enabled_providers !== undefined && !facts.config.enabled_providers.includes(provider))
    ) {
      return {
        configurationStatus: "INVALID" as const,
        localReadiness: "INVALID" as const,
        probe: { phase: "config" as const, outcome: "FAIL" as const, code: "provider_disabled" },
      }
    }
    const modelId = model[2]!
    const configuredModels = providerConfig?.models
    const configuredModelKnown = configuredModels !== undefined && Object.hasOwn(configuredModels, modelId)
    const catalogModelKnown = catalogProvider !== undefined && Object.hasOwn(catalogProvider.models, modelId)
    const modelKnown = configuredModelKnown || catalogModelKnown
    const excluded =
      providerConfig?.blacklist?.includes(modelId) ||
      (providerConfig?.whitelist !== undefined && !providerConfig.whitelist.includes(modelId))
    if (excluded) {
      return {
        configurationStatus: "INVALID" as const,
        localReadiness: "INVALID" as const,
        probe: { phase: "config" as const, outcome: "FAIL" as const, code: "selected_model_unavailable" },
      }
    }
    // A non-fresh catalog can neither confirm an old row nor prove absence.
    // Only a model explicitly present in effective config is authoritative
    // enough to resolve selection without a fresh catalog snapshot.
    if (
      !configuredModelKnown &&
      facts.catalogFreshness !== undefined &&
      facts.catalogFreshness !== "fresh"
    ) {
      return {
        configurationStatus: "UNKNOWN" as const,
        localReadiness: "UNKNOWN" as const,
        probe: { phase: "config" as const, outcome: "UNKNOWN" as const, code: "catalog_snapshot_not_fresh" },
      }
    }
    if (!modelKnown) {
      return {
        configurationStatus: "INVALID" as const,
        localReadiness: "INVALID" as const,
        probe: { phase: "config" as const, outcome: "FAIL" as const, code: "selected_model_unavailable" },
      }
    }
    return {
      configurationStatus: "VALID" as const,
      localReadiness: "READY" as const,
      probe: configProbe("VALID"),
    }
  }
  // Direct pure callers without trusted config/catalog facts cannot prove
  // model availability. Keep it UNKNOWN rather than trusting request labels.
  return {
    configurationStatus: "UNKNOWN" as const,
    localReadiness: "UNKNOWN" as const,
    probe: configProbe("UNKNOWN"),
  }
}

export function inspectOffline(
  input: unknown,
  auth: TrustedPrincipalContextValue,
  facts?: OfflineProviderFacts,
): ProviderDoctorV1.ResultV1 {
  if (auth?.principal?.kind !== "host_os" && auth?.principal?.kind !== "server_auth") {
    throw new TypeError("inspectOffline requires a trusted authenticated principal")
  }
  const request = decodeRequest(input, { onExcessProperty: "error" })
  if (request.tier !== "offline") throw new TypeError("inspectOffline only accepts offline Doctor requests")

  const local = inspectSelection(request.selection, facts)
  const selection = { ...request.selection, configurationStatus: local.configurationStatus }

  return decodeResult(
    {
      schemaVersion: 1,
      doctorRunId: request.doctorRunId,
      tier: "offline",
      selection,
      localReadiness: local.localReadiness,
      remoteChecks: { entitlement: "UNCHECKED", quota: "UNCHECKED", service: "UNCHECKED" },
      credentialAccess: "NOT_READ",
      networkRequestCount: 0,
      costStatus: "NOT_APPLICABLE",
      probes: [
        local.probe,
        skippedProbe("auth", "offline_credentials_not_read"),
        skippedProbe("catalog", "offline_remote_catalog_not_checked"),
        skippedProbe("capability", "offline_remote_capabilities_not_checked"),
        skippedProbe("stream", "offline_provider_stream_not_checked"),
        skippedProbe("tool_call", "offline_provider_tool_call_not_checked"),
        skippedProbe("cache", "offline_provider_cache_not_checked"),
      ],
    },
    { onExcessProperty: "error" },
  )
}

/**
 * Catalog-tier preparation stays inert until the network origin has a verified
 * pre-dispatch Guard adapter. `networkGrantRef` is an untrusted request label;
 * this projection never treats its presence as authorization.
 */
export function inspectCatalog(
  input: unknown,
  auth: TrustedPrincipalContextValue,
  facts?: OfflineProviderFacts,
): ProviderDoctorV1.ResultV1 {
  if (auth?.principal?.kind !== "host_os" && auth?.principal?.kind !== "server_auth") {
    throw new TypeError("inspectCatalog requires a trusted authenticated principal")
  }
  const request = decodeRequest(input, { onExcessProperty: "error" })
  if (request.tier !== "catalog") throw new TypeError("inspectCatalog only accepts catalog Doctor requests")

  // The network-grant label is never authority. We can still report what the
  // already-loaded local config/catalog proves without dispatching a request.
  const local = inspectSelection(request.selection, facts)
  return decodeResult(
    {
      schemaVersion: 1,
      doctorRunId: request.doctorRunId,
      tier: "catalog",
      selection: { ...request.selection, configurationStatus: local.configurationStatus },
      localReadiness: local.localReadiness,
      remoteChecks: { entitlement: "UNKNOWN", quota: "UNKNOWN", service: "UNKNOWN" },
      credentialAccess: "NOT_READ",
      networkRequestCount: 0,
      costStatus: "NOT_INCURRED",
      probes: [
        local.probe,
        skippedProbe("auth", "catalog_guard_unavailable_credentials_not_read"),
        skippedProbe("catalog", "catalog_pre_dispatch_guard_unavailable"),
        skippedProbe("capability", "catalog_probe_not_dispatched"),
        skippedProbe("stream", "catalog_probe_not_dispatched"),
        skippedProbe("tool_call", "catalog_probe_not_dispatched"),
        skippedProbe("cache", "catalog_probe_not_dispatched"),
      ],
    },
    { onExcessProperty: "error" },
  )
}
