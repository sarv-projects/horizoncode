import { createMemo, createSignal, onMount } from "solid-js"
import { FeatureExposure } from "@opencode-ai/core/v1/config/feature-exposure"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useToast } from "../ui/toast"

/**
 * TUI projection of the existing backend config.
 * This dialog never stores independent feature flags or authorizes a tool.
 * Unimplemented experiments are visible but intentionally non-actionable.
 */
export function DialogFeatures() {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  const [features, setFeatures] = createSignal<FeatureExposure.Feature[]>([])
  onMount(() => {
    void sdk.client.config
      .features({ workspace: project.workspace.current() }, { throwOnError: true })
      .then((response) => setFeatures(response.data))
      .catch((error) =>
        toast.show({
          message: `Could not load feature settings: ${error instanceof Error ? error.message : String(error)}`,
          variant: "error",
        }),
      )
  })

  const options = createMemo(() =>
    features().map((feature) => {
      const state = feature.state
      const tag = feature.releaseClass === "stable" ? "" : ` [${feature.releaseClass === "experimental" ? "Experimental" : "Beta"}]`
      const requested = state.requestedEnabled === null ? `default ${feature.defaultEnabled ? "ON" : "OFF"}` : state.requestedEnabled ? "requested ON" : "requested OFF"
      const effective = state.effectiveEnabled ? "effective ON" : "effective OFF"
      const source = state.valueSource === "unknown" ? "source unknown" : `source ${state.valueSource}`
      const lock = `policy lock ${state.policyLock}`
      const status = state.implementationStatus.replaceAll("_", " ")
      const label = `${state.effectiveState === "unavailable" || state.effectiveState === "blocked" ? `${state.effectiveState === "unavailable" ? "Unavailable" : "Blocked"}: ${state.blockedReason ?? "Unsupported"} · ` : ""}${requested} · ${effective} (${state.effectiveState})${state.pendingApplyAt ? ` · Pending ${state.pendingApplyAt.replaceAll("_", " ")}` : ""} · ${source} · ${lock} · Scope ${feature.supportedScopes.join(", ")} · ${status} · Applies ${feature.applyBoundary.replaceAll("_", " ")}`
      return {
        title: feature.title + tag,
        value: feature.featureId,
        category: feature.releaseClass === "experimental" ? "Experimental" : "Features",
        description: feature.description,
        footer: label,
      }
    }),
  )

  async function select(option: DialogSelectOption<FeatureExposure.FeatureId>) {
    if (busy()) return
    const feature = features().find((f) => f.featureId === option.value)
    if (!feature) return
    if (feature.state.effectiveState === "unavailable" || feature.state.effectiveState === "blocked") {
      toast.show({
        message: feature.state.blockedReason ?? "This feature is not available in this build.",
        variant: "info",
      })
      return
    }
    // The backend operation is allowlisted and updates config only; experiments
    // remain unavailable and have no update operation.
    if (feature.featureId !== "compaction.auto" && feature.featureId !== "compaction.prune") return
    setBusy(true)
    try {
      const workspace = project.workspace.current()
      const response = await sdk.client.config.featureUpdate(
        {
          workspace,
          featureExposureUpdate: {
            featureId: feature.featureId,
            expectedEnabled: feature.state.requestedEnabled,
            enabled: !feature.state.effectiveEnabled,
          },
        },
        { throwOnError: true },
      )
      setFeatures(response.data)
      toast.show({ message: `${feature.title}: saved.`, variant: "info" })
    } catch (error) {
      toast.show({
        message: `Setting was not saved: ${error instanceof Error ? error.message : String(error)}`,
        variant: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  return <DialogSelect title="Settings · Features / Experimental" options={options()} onSelect={(option) => void select(option)} />
}
