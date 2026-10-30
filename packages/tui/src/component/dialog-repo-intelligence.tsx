import { createMemo, createSignal, onMount, Show } from "solid-js"
import type { RepoIntelProfileProjection } from "@horizoncode/sdk/v2"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"

type Profile = "lightweight" | "adaptive" | "full"

const PROFILE_INFO: Record<Profile, { title: string; description: string }> = {
  lightweight: {
    title: "Lightweight",
    description: "Prefer bounded local structure and targeted queries.",
  },
  adaptive: {
    title: "Adaptive",
    description: "Use available local analysis, narrowed by platform and resource policy.",
  },
  full: {
    title: "Full",
    description: "Request the broadest supported local analysis. This does not grant tools or trigger work by itself.",
  },
}

export function DialogRepoIntelligenceSettings() {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const { theme } = useTheme()
  const [projection, setProjection] = createSignal<RepoIntelProfileProjection>()
  const [busy, setBusy] = createSignal(false)
  const [unavailable, setUnavailable] = createSignal(false)

  async function load() {
    try {
      const result = await sdk.client.config.repoIntelProfile(
        { workspace: project.workspace.current() },
        { throwOnError: true },
      )
      setProjection(result.data)
      setUnavailable(false)
    } catch {
      setProjection(undefined)
      setUnavailable(true)
    }
  }

  onMount(() => void load())

  const options = createMemo<DialogSelectOption<Profile>[]>(() => {
    const current = projection()
    return (Object.keys(PROFILE_INFO) as Profile[]).map((profile) => {
      const info = PROFILE_INFO[profile]
      const selected = current?.requested === profile
      return {
        title: `${selected ? "● " : "  "}${info.title}`,
        value: profile,
        description: info.description,
        category: "RepoIntel",
        disabled: busy() || !current || current.policyLock !== "unlocked",
        onSelect: () => void update(profile),
      }
    })
  })

  async function update(profile: Profile) {
    const current = projection()
    if (!current || busy()) return
    if (current.policyLock !== "unlocked") {
      toast.show({ message: "RepoIntel profile is locked by policy.", variant: "info" })
      return
    }
    setBusy(true)
    try {
      const result = await sdk.client.config.updateRepoIntelProfile({
        workspace: project.workspace.current(),
        updateRepoIntelProfile: {
          expectedProfile: current.requestedValue,
          profile,
        },
      }, { throwOnError: true })
      setProjection(result.data)
      toast.show({ message: `RepoIntel profile request saved: ${profile}. No analysis was started.`, variant: "info" })
    } catch {
      await load()
      toast.show({ message: "RepoIntel profile was not changed. Reloaded the current setting.", variant: "warning" })
    } finally {
      setBusy(false)
    }
  }

  const current = () => projection()

  return (
    <DialogSelect
      title="Settings · RepoIntel"
      options={options()}
      flat={false}
      locked={busy()}
      emptyView={
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.warning}>{unavailable() ? "RepoIntel settings are unavailable." : "Loading RepoIntel profile…"}</text>
        </box>
      }
      titleView={
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.text}>RepoIntel profile</text>
          <text fg={theme.textMuted}>Requested: {current()?.requested ?? "UNKNOWN"} · effective: {current()?.effective ?? "UNKNOWN"}</text>
          <text fg={theme.textMuted}>Source: {current()?.configurationSource ?? "unknown"} · effective source: {current()?.effectiveSource ?? "unknown"} · policy: {current()?.policyLock ?? "unknown"}</text>
          <Show when={current()?.reason}>
            <text fg={theme.warning}>Effective profile narrowed: {current()?.reason?.replaceAll("_", " ")}</text>
          </Show>
          <text fg={theme.textMuted}>Selecting a profile changes the requested Config value only. Resource and platform policy may narrow the effective profile; this setting does not start analysis.</text>
        </box>
      }
      onFilter={() => {}}
      onSelect={() => {}}
    />
  )
}
