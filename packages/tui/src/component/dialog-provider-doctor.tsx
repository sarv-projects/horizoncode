import { createMemo, createSignal, onMount } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"

type DoctorSelection = {
  providerID?: string
  providerName?: string
  modelID?: string
  modelName?: string
  configurationStatus: "VALID" | "INVALID" | "UNKNOWN"
}

export function providerDoctorOfflineSummary(input: DoctorSelection) {
  const selected = input.providerID && input.modelID
  const selection = selected
    ? `${input.providerName ?? input.providerID} / ${input.modelName ?? input.modelID} (${input.providerID}/${input.modelID})`
    : "No provider/model selected"
  const localReadiness =
    input.configurationStatus === "INVALID"
      ? "INVALID"
      : input.configurationStatus === "UNKNOWN"
        ? "UNKNOWN"
        : selected
          ? "READY"
          : "INCOMPLETE"

  return {
    selection,
    localReadiness,
    configuration: input.configurationStatus,
    credentials: "NOT_READ" as const,
    networkRequests: 0 as const,
    remote: "UNCHECKED" as const,
    cost: "NOT_APPLICABLE" as const,
  }
}

export function DialogProviderDoctor() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [serverResult, setServerResult] = createSignal<{
    localReadiness: string
    configuration: string
    credentials: string
    networkRequests: number
    remote: string
    cost: string
  }>()
  const [error, setError] = createSignal(false)
  const selection = createMemo(() => {
    const model = local.model.current()
    const agentModel = local.agent.current()?.model
    const selected = model ?? agentModel
    const provider = selected && sync.data.provider.find((item) => item.id === selected.providerID)
    const modelInfo = selected && provider?.models[selected.modelID]
    return providerDoctorOfflineSummary({
      providerID: selected?.providerID,
      providerName: provider?.name,
      modelID: selected?.modelID,
      modelName: modelInfo?.name,
      // The synced provider catalog does not expose configuration validation.
      // Keep it UNKNOWN instead of treating catalog membership as auth/config proof.
      configurationStatus: "UNKNOWN",
    })
  })

  onMount(async () => {
    const selected = local.model.current() ?? local.agent.current()?.model
    try {
      const response = await sdk.client.provider.doctor.offline(
        {
          schemaVersion: 1,
          doctorRunId: `doctor_offline_${Date.now().toString(36)}`,
          selection: {
            providerRef: selected ? `provider:${selected.providerID}` : "provider:unselected",
            modelRef: selected ? `model:${selected.providerID}/${selected.modelID}` : undefined,
          },
          deadlineMs: 5_000,
          tier: "offline",
          maxNetworkRequests: 0,
        },
        { throwOnError: true },
      )
      setServerResult({
        localReadiness: response.data.localReadiness,
        configuration: response.data.probes.find((probe) => probe.phase === "config")?.outcome ?? "UNKNOWN",
        credentials: response.data.credentialAccess,
        networkRequests: response.data.networkRequestCount,
        remote:
          response.data.remoteChecks.entitlement === "UNCHECKED" &&
          response.data.remoteChecks.quota === "UNCHECKED" &&
          response.data.remoteChecks.service === "UNCHECKED"
            ? "UNCHECKED"
            : "CHECKED",
        cost: response.data.costStatus,
      })
    } catch {
      // Do not render transport bodies or provider details in diagnostics.
      setError(true)
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <text fg={theme.text} attributes={1}>Provider Doctor · Offline</text>
      <text fg={theme.textMuted}>Selected: {selection().selection}</text>
      <text fg={theme.textMuted}>Local readiness: {serverResult()?.localReadiness ?? selection().localReadiness}</text>
      <text fg={theme.textMuted}>Configuration: {serverResult()?.configuration ?? selection().configuration}</text>
      <text fg={theme.textMuted}>Credentials: {serverResult()?.credentials ?? selection().credentials}</text>
      <text fg={theme.textMuted}>
        Remote entitlement, quota, and service: {serverResult()?.remote ?? selection().remote}
      </text>
      <text fg={theme.textMuted}>
        Provider requests: {serverResult()?.networkRequests ?? selection().networkRequests} · Cost: {serverResult()?.cost ?? selection().cost}
      </text>
      <text fg={theme.textMuted}>
        Catalog and full probes are unavailable until guarded network and consent support is verified.
      </text>
      {error() && <text fg={theme.error}>Offline diagnostics could not be loaded from this local runtime.</text>}
      <text fg={theme.textMuted}>This route never reads credentials or contacts a provider.</text>
    </box>
  )
}
