import { createMemo, createSignal, onMount } from "solid-js"
import type { ConfigRepoIntelligenceV1 } from "@opencode-ai/core/v1/config/config"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"

type Profile = ConfigRepoIntelligenceV1.AnalysisProfile
const PROFILES: readonly Profile[] = ["lightweight", "adaptive", "full"]

export function DialogRepoIntelligenceProfile() {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const [state, setState] = createSignal<ConfigRepoIntelligenceV1.ProfileProjection>()
  const [busy, setBusy] = createSignal(false)

  async function refresh() {
    const response = await sdk.client.config.repoIntelProfile(
      { workspace: project.workspace.current() },
      { throwOnError: true },
    )
    setState(response.data)
  }

  onMount(() => {
    void refresh().catch((error) =>
      toast.show({ message: `Could not load RepoIntel profile: ${error instanceof Error ? error.message : String(error)}`, variant: "error" }),
    )
  })

  const options = createMemo<DialogSelectOption<Profile>[]>(() => {
    const current = state()
    return PROFILES.map((profile) => ({
      title: profile[0]!.toUpperCase() + profile.slice(1),
      value: profile,
      description: profile === "lightweight"
        ? "Bounded low-cost analysis using the current RepoIntel backend."
        : profile === "adaptive"
          ? "Allow richer on-demand analysis when platform and resource policy permit."
          : "Allow the richest on-demand analysis when platform and resource policy permit.",
      footer: current
        ? `requested ${JSON.stringify(current.requestedValue)} → ${current.requested} · effective ${current.effective} (${current.effectiveSource}) · config ${current.configurationSource} · policy ${current.policyLock}${current.reason ? ` · ${current.reason.replaceAll("_", " ")}` : ""}`
        : "Loading trusted config state…",
    }))
  })

  async function select(option: DialogSelectOption<Profile>) {
    const current = state()
    if (busy() || !current) return
    if (current.policyLock === "locked") {
      toast.show({ message: `RepoIntel profile is locked${current.reason ? `: ${current.reason.replaceAll("_", " ")}` : " by policy"}.`, variant: "info" })
      return
    }
    if (option.value === current.requested && current.reason !== "invalid_configuration") return
    setBusy(true)
    try {
      const response = await sdk.client.config.updateRepoIntelProfile(
        {
          workspace: project.workspace.current(),
          updateRepoIntelProfile: {
            expectedProfile: current.requestedValue,
            profile: option.value,
          },
        },
        { throwOnError: true },
      )
      setState(response.data)
      toast.show({ message: `RepoIntel profile requested: ${option.value}.`, variant: "info" })
    } catch (error) {
      toast.show({ message: `Profile was not saved: ${error instanceof Error ? error.message : String(error)}`, variant: "error" })
      await refresh().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  return <DialogSelect title="Settings · RepoIntel analysis profile" options={options()} onSelect={(option) => void select(option)} />
}
