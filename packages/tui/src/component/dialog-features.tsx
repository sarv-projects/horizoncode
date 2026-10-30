import { createMemo, createSignal, onMount, Show } from "solid-js"
import { FeatureExposure } from "@horizoncode/core/v1/config/feature-exposure"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useToast } from "../ui/toast"

export function featureSettingIsMutable(feature: FeatureExposure.Feature) {
  return (
    feature.state.policyLock === "unlocked" &&
    feature.state.effectiveState !== "unavailable" &&
    feature.state.effectiveState !== "blocked"
  )
}

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
  const [activeFeatureId, setActiveFeatureId] = createSignal<FeatureExposure.FeatureId>()
  const activeFeature = createMemo(() =>
    features().find((feature) => feature.featureId === activeFeatureId()) ?? features()[0],
  )
  onMount(() => {
    void sdk.client.config
      .features({ workspace: project.workspace.current() }, { throwOnError: true })
      .then((response) => {
        setFeatures(response.data)
        setActiveFeatureId(response.data[0]?.featureId)
      })
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
      const tag =
        feature.releaseClass === "stable"
          ? ""
          : ` [${feature.releaseClass === "experimental" ? "Experimental" : "Beta"}]`
      const requested =
        state.requestedEnabled === null
          ? `default ${feature.defaultEnabled ? "ON" : "OFF"}`
          : state.requestedEnabled
            ? "requested ON"
            : "requested OFF"
      const effective = state.effectiveEnabled ? "effective ON" : "effective OFF"
      const source = state.valueSource === "unknown" ? "source unknown" : `source ${state.valueSource}`
      const lock = `policy lock ${state.policyLock}`
      const status = state.implementationStatus.replaceAll("_", " ")
      const label = `${state.policyLock === "locked" ? `Locked: ${state.blockedReason ?? "Managed by policy"} · ` : ""}${state.effectiveState === "unavailable" || state.effectiveState === "blocked" ? `${state.effectiveState === "unavailable" ? "Unavailable" : "Blocked"}: ${state.blockedReason ?? "Unsupported"} · ` : ""}${requested} · ${effective} (${state.effectiveState})${state.pendingApplyAt ? ` · Pending ${state.pendingApplyAt.replaceAll("_", " ")}` : ""} · ${source} · ${lock} · Scope ${feature.supportedScopes.join(", ")} · ${status} · Applies ${feature.applyBoundary.replaceAll("_", " ")}`
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
    if (!featureSettingIsMutable(feature)) {
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
            // A pending next-turn value is the user's current request even
            // while the running Session still reports the prior effective
            // value. Toggle the requested value so the user can cancel it.
            enabled: !(feature.state.requestedEnabled ?? feature.defaultEnabled),
          },
        },
        { throwOnError: true },
      )
      setFeatures(response.data)
      setActiveFeatureId(feature.featureId)
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

  return (
    <DialogSelect
      title="Settings · Features / Experimental"
      options={options()}
      onMove={(option) => setActiveFeatureId(option.value)}
      footer={
        <Show when={activeFeature()} keyed>
          {(feature) => (
            <box flexDirection="column" paddingLeft={2} paddingRight={2}>
              <text wrapMode="word">Owner: {feature.owner.config} / {feature.owner.runtime} · Platforms: {feature.supportedPlatforms.join(", ")}{feature.supportedPlatforms.includes("linux") ? " (includes WSL)" : ""}</text>
              <text wrapMode="word">Models: {feature.supportedModelRefs.length ? feature.supportedModelRefs.join(", ") : "any compatible"} · Harnesses: {feature.supportedHarnessRefs.length ? feature.supportedHarnessRefs.join(", ") : "any compatible"}</text>
              <text wrapMode="word">Prerequisites: {feature.prerequisites.length ? feature.prerequisites.join(", ") : "none"}</text>
              <text wrapMode="word">Risk: {feature.riskNotes ?? "unspecified"} · Cost: {feature.costNotes ?? "unknown"}</text>
            </box>
          )}
        </Show>
      }
      onSelect={(option) => void select(option)}
    />
  )
}
