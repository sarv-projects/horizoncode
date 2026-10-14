import { createMemo, createSignal, For, Show, type Component } from "solid-js"
import { FeatureExposure } from "@opencode-ai/core/v1/config/feature-exposure"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsRowV2 } from "./parts/row"

/**
 * A view of backend-owned configuration, NOT persisted GUI-local settings.
 * Experimental backends are listed only until verified and are never enabled
 * just by changing a checkbox or a frontend flag.
 */
export const SettingsFeaturesV2: Component<{ experimentalOnly?: boolean }> = (props) => {
  const sync = useServerSync()
  const [filter, setFilter] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const all = createMemo(() => FeatureExposure.list(sync().data.config))
  const shown = createMemo(() =>
    all().filter((feature) => {
      if (props.experimentalOnly && feature.releaseClass !== "experimental") return false
      const q = filter().trim().toLocaleLowerCase()
      return !q || `${feature.title} ${feature.description} ${feature.releaseClass}`.toLocaleLowerCase().includes(q)
    }),
  )

  async function toggle(featureId: FeatureExposure.FeatureId, enabled: boolean) {
    if (busy()) return
    const previous = all().find((item) => item.featureId === featureId)
    if (!previous || previous.state.effectiveState === "unavailable" || previous.state.effectiveState === "blocked") return
    const patch = FeatureExposure.updateCompaction(sync().data.config, featureId, enabled)
    if (!patch) return
    setBusy(true)
    try {
      await sync().updateConfig(patch)
      showToast({
        variant: "success",
        title: "Setting saved",
        description: `${previous.title} applies to the next session.`,
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not save setting",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{props.experimentalOnly ? "Experimental" : "Features"}</h2>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
            placeholder="Search optional features"
            aria-label="Search optional features"
          />
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <For each={shown()}>
            {(feature) => {
              const unavailable = () => ["unavailable", "blocked"].includes(feature.state.effectiveState)
              return (
                <SettingsRowV2
                  title={
                    <span>
                      {feature.title}
                      <Show when={feature.releaseClass !== "stable"}>
                        <span class="text-v2-icon-icon-muted"> [{feature.releaseClass === "experimental" ? "Experimental" : "Beta"}]</span>
                      </Show>
                    </span>
                  }
                  description={
                    <span>
                      {feature.description}
                      <Show when={unavailable()}>
                        <span> — {feature.state.blockedReason ?? "Unavailable in this build"}</span>
                      </Show>
                      <Show when={!unavailable()}>
                        <span> — Applies {feature.applyBoundary.replaceAll("_", " ")}</span>
                      </Show>
                      <Show when={feature.state.valueSource === "unknown"}>
                        <span> — Configuration source: unknown</span>
                      </Show>
                    </span>
                  }
                >
                  <Switch
                    checked={feature.state.effectiveEnabled}
                    disabled={unavailable() || busy()}
                    onChange={(value) => void toggle(feature.featureId, value)}
                  />
                </SettingsRowV2>
              )
            }}
          </For>
          <Show when={shown().length === 0}>
            <p class="settings-v2-models-status">No optional features match your search.</p>
          </Show>
        </div>
      </div>
    </>
  )
}
