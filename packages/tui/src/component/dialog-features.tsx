import { createMemo, createSignal } from "solid-js"
import { FeatureExposure } from "@opencode-ai/core/v1/config/feature-exposure"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useProject } from "../context/project"
import { useToast } from "../ui/toast"

/**
 * TUI projection of the existing backend config.
 * This dialog never stores independent feature flags or authorizes a tool.
 * Unimplemented experiments are visible but intentionally non-actionable.
 */
export function DialogFeatures() {
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  const features = createMemo(() => FeatureExposure.list(sync.data.config))

  const options = createMemo(() =>
    features().map((feature) => {
      const state = feature.state
      const tag = feature.releaseClass === "stable" ? "" : ` [${feature.releaseClass === "experimental" ? "Experimental" : "Beta"}]`
      const label = state.effectiveState === "unavailable"
        ? `Unavailable: ${state.blockedReason ?? "Unsupported"}`
        : `${state.effectiveEnabled ? "ON" : "OFF"} · Applies ${feature.applyBoundary.replaceAll("_", " ")}`
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
    // The patch helper has an explicit allowlist. No experimental backend
    // can be switched on by reusing a stable Settings control.
    const patch = FeatureExposure.updateCompaction(sync.data.config, feature.featureId, !feature.state.effectiveEnabled)
    if (!patch) return
    setBusy(true)
    try {
      const workspace = project.workspace.current()
      await sdk.client.config.update({ workspace, config: patch }, { throwOnError: true })
      const response = await sdk.client.config.get({ workspace }, { throwOnError: true })
      if (!response.data) throw new Error("No updated configuration returned by the runtime")
      sync.set("config", response.data)
      toast.show({ message: `${feature.title}: saved. Applies to the next session.`, variant: "info" })
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
