import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import type { DirectSessionPermissionModeV1 } from "@horizoncode/sdk/v2"
import { HorizonCodingProfile } from "@horizoncode/core/config/coding-profile"

type Choice =
  | { dimension: "sandboxMode"; value: DirectSessionPermissionModeV1["sandboxMode"] }
  | { dimension: "approvalPolicy"; value: DirectSessionPermissionModeV1["approvalPolicy"] }

const SANDBOX: Array<{ value: Choice & { dimension: "sandboxMode" }; title: string; description: string }> = [
  { value: { dimension: "sandboxMode", value: "read-only" }, title: "Sandbox · Read only", description: "Effects cannot write workspace files." },
  { value: { dimension: "sandboxMode", value: "workspace-write" }, title: "Sandbox · Workspace write", description: "Supported effects can read and edit the current workspace." },
  { value: { dimension: "sandboxMode", value: "danger-full-access" }, title: "Sandbox · Full access", description: "No HorizonCode filesystem or network sandbox. Select only when you understand the risk." },
]

const APPROVAL: Array<{ value: Choice & { dimension: "approvalPolicy" }; title: string; description: string }> = [
  { value: { dimension: "approvalPolicy", value: "on-request" }, title: "Approval · On request", description: "Routine supported work inside the selected sandbox proceeds; boundary crossings ask." },
  { value: { dimension: "approvalPolicy", value: "always" }, title: "Approval · Always", description: "Ask before every effect." },
  { value: { dimension: "approvalPolicy", value: "never" }, title: "Approval · Never", description: "Do not prompt inside the selected sandbox. Technical denials still apply." },
]

export function DialogPermissions(props: { sessionID: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const { theme } = useTheme()
  const [mode, setMode] = createSignal<DirectSessionPermissionModeV1>()
  const [busy, setBusy] = createSignal(false)
  const [unavailable, setUnavailable] = createSignal(false)

  const workspace = () => project.workspace.current()
  const options = createMemo<DialogSelectOption<Choice>[]>(() => {
    const current = mode()
    if (!current) return []
    const rows = [
      ...SANDBOX.map((item) => ({ ...item, category: "Sandbox" })),
      ...APPROVAL.map((item) => ({ ...item, category: "Approval" })),
    ]
    return rows.map((item) => {
      const selected = item.value.dimension === "sandboxMode"
        ? current?.sandboxMode === item.value.value
        : current?.approvalPolicy === item.value.value
      return {
        title: `${selected ? "● " : "  "}${item.title}`,
        value: item.value,
        description: item.description,
        category: item.category,
        disabled: !current || busy(),
        onSelect: () => void save(item.value),
      }
    })
  })

  async function load() {
    try {
      const result = await sdk.client.config.directSessionPermissionMode(
        { sessionID: props.sessionID, workspace: workspace() },
        { throwOnError: true },
      )
      setMode(result.data)
      setUnavailable(false)
    } catch {
      setMode(undefined)
      setUnavailable(true)
    }
  }

  async function save(choice: Choice) {
    const current = mode()
    if (!current || busy()) return
    if (choice.dimension === "sandboxMode" && choice.value === "danger-full-access" && current.approvalPolicy !== "never") {
      toast.show({
        message: "Full access requires the explicit Full access + Never posture. Choose both settings deliberately; no effect is dispatched by this change.",
        variant: "info",
      })
      return
    }
    const next = {
      sandboxMode: choice.dimension === "sandboxMode" ? choice.value : current.sandboxMode,
      approvalPolicy: choice.dimension === "approvalPolicy" ? choice.value : current.approvalPolicy,
      expectedRevision: current.revision,
    }
    if (next.sandboxMode === "danger-full-access" && next.approvalPolicy !== "never") {
      toast.show({ message: "Full access is only valid with approval set to Never.", variant: "info" })
      return
    }
    setBusy(true)
    try {
      const result = await sdk.client.config.updateDirectSessionPermissionMode({
        sessionID: props.sessionID,
        workspace: workspace(),
        directSessionPermissionModeUpdateV1: next,
      }, { throwOnError: true })
      setMode(result.data)
      toast.show({ message: "Direct Session permission posture updated. No effect was dispatched.", variant: "info" })
    } catch {
      await load()
      toast.show({ message: "Permission settings were not changed. Reloaded the current HostKernel posture.", variant: "warning" })
    } finally {
      setBusy(false)
    }
  }

  onMount(() => void load())

  const sourceLabel = () => {
    switch (mode()?.source) {
      case "default": return "Default"
      case "user-session": return "This Session"
      case "user-config": return "User configuration"
      default: return "Unavailable"
    }
  }

  return (
    <DialogSelect
      title="Permissions · Direct Session"
      options={options()}
      flat={false}
      locked={busy()}
      onSelect={() => dialog.clear()}
      emptyView={
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.warning}>{unavailable() ? "HostKernel permission settings are unavailable for this Session." : "Loading authenticated permission posture…"}</text>
        </box>
      }
      titleView={
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.text}>Permissions · Direct Session</text>
          <text fg={theme.textMuted}>Sandbox and approval are independent. Every effect still uses Guard, one-use leases, receipts and recovery.</text>
          <text fg={theme.textMuted}>Current: {mode()?.sandboxMode ?? "UNKNOWN"} · {mode()?.approvalPolicy ?? "UNKNOWN"} · source {sourceLabel()} · revision {mode()?.revision ?? "—"}</text>
          <Show when={mode()?.sandboxMode === "danger-full-access"}>
            <text fg={theme.warning}>Full access disables HorizonCode filesystem and network sandboxing for this Session.</text>
          </Show>
          <text fg={theme.textMuted}>Changing this posture does not execute or approve an effect.</text>
          <text fg={theme.textMuted}>Coding (recommended) preset: {HorizonCodingProfile.settings.sandboxMode} + {HorizonCodingProfile.settings.approvalPolicy} · Goal {HorizonCodingProfile.settings.goal} · {HorizonCodingProfile.settings.firstBoundaryGrant} on first boundary crossing.</text>
        </box>
      }
      onFilter={() => {}}
      skipFilter={false}
    />
  )
}
