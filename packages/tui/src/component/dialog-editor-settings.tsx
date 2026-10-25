import { createMemo, createSignal, onMount, Show } from "solid-js"
import type { ExternalEditorProfileDefinitionV1, ExternalEditorProfileRefV1, ExternalEditorProfilesProjectionV1 } from "@opencode-ai/sdk/v2"
// The TUI package does not currently declare @opencode-ai/schema as a
// dependency. Import the canonical schema source directly so this surface
// cannot fork its own decoder; packaging must add the workspace dependency.
import * as ExternalEditorProfile from "../../../schema/src/external-editor-profile-v1"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"

type BuiltInEditor = {
  id: string
  title: string
  selector: string
  argv: string[]
  targetArgIndex: number
  launchMode: "foreground_tty" | "wait"
  details: string
}

const BUILT_IN_EDITORS: BuiltInEditor[] = [
  { id: "nano", title: "nano", selector: "horizoncode:editor:nano", argv: [], targetArgIndex: 0, launchMode: "foreground_tty", details: "Terminal editor · foreground TTY handoff" },
  { id: "vi", title: "vi", selector: "horizoncode:editor:vi", argv: [], targetArgIndex: 0, launchMode: "foreground_tty", details: "Terminal editor · foreground TTY handoff" },
  { id: "vim", title: "vim", selector: "horizoncode:editor:vim", argv: [], targetArgIndex: 0, launchMode: "foreground_tty", details: "Terminal editor · foreground TTY handoff" },
  { id: "nvim", title: "nvim", selector: "horizoncode:editor:nvim", argv: [], targetArgIndex: 0, launchMode: "foreground_tty", details: "Terminal editor · foreground TTY handoff" },
  { id: "subl", title: "Sublime Text", selector: "horizoncode:editor:subl", argv: ["--wait"], targetArgIndex: 1, launchMode: "wait", details: "GUI editor · waits for the edit window to close" },
  { id: "code", title: "Visual Studio Code", selector: "horizoncode:editor:code", argv: ["--wait"], targetArgIndex: 1, launchMode: "wait", details: "GUI editor · waits for the edit window to close" },
  { id: "zed", title: "Zed", selector: "horizoncode:editor:zed", argv: ["--wait"], targetArgIndex: 1, launchMode: "wait", details: "GUI editor · waits for the edit window to close" },
]

type EditorChoice =
  | { kind: "select"; ref: ExternalEditorProfileRefV1 }
  | { kind: "add"; editor: BuiltInEditor }
  | { kind: "disable" }
  | { kind: "launch-unavailable" }

function nextDefinition(editor: BuiltInEditor, projection: ExternalEditorProfilesProjectionV1): ExternalEditorProfileDefinitionV1 {
  const previous = projection.profiles
    .filter((item) => item.definition.profileId === editor.id)
    .reduce((latest, item) => BigInt(item.definition.revision) > latest ? BigInt(item.definition.revision) : latest, 0n)
  return {
    schemaVersion: 1,
    profileId: editor.id,
    revision: String(previous + 1n),
    executableSelector: editor.selector,
    argv: [...editor.argv],
    targetArgIndex: editor.targetArgIndex,
    launchMode: editor.launchMode,
    targetKinds: ["prompt_scratch", "workspace_file"],
    environmentPolicy: "sanitized_host",
  }
}

export function DialogEditorSettings(_props: { sessionID: string }) {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const { theme } = useTheme()
  const [projection, setProjection] = createSignal<ExternalEditorProfilesProjectionV1>()
  const [busy, setBusy] = createSignal(false)
  const [unavailable, setUnavailable] = createSignal(false)

  async function load() {
    try {
      const result = await sdk.client.config.externalEditorProfiles(
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

  async function update(input: {
    addProfile?: ExternalEditorProfileDefinitionV1
    select: ExternalEditorProfileRefV1 | null
  }) {
    const current = projection()
    if (!current || busy()) return
    setBusy(true)
    try {
      const result = await sdk.client.config.updateExternalEditorProfiles({
        workspace: project.workspace.current(),
        updateExternalEditorProfiles: {
          expectedSelection: current.selected,
          ...(input.addProfile ? { addProfile: input.addProfile } : {}),
          select: input.select,
        },
      }, { throwOnError: true })
      setProjection(result.data)
      toast.show({
        message: input.select ? "Editor profile saved. Process launch remains unavailable until HostKernel acceptance." : "External editor profile disabled.",
        variant: "info",
      })
    } catch {
      await load()
      toast.show({ message: "Editor settings changed elsewhere or the profile was rejected. Reloaded the global setting.", variant: "warning" })
    } finally {
      setBusy(false)
    }
  }

  const options = createMemo<DialogSelectOption<EditorChoice>[]>(() => {
    const current = projection()
    if (!current) return []
    const result: DialogSelectOption<EditorChoice>[] = [
      {
        title: `${current.selected ? "  " : "● "}No external editor`,
        value: { kind: "disable" },
        category: "Selection",
        description: "Keep the built-in TUI editor behavior. Does not open a process.",
        onSelect: () => void update({ select: null }),
      },
      ...current.profiles.map(({ definition, profileRef }) => ({
        title: `${current.selected?.profileId === profileRef.profileId && current.selected.revision === profileRef.revision ? "● " : "  "}${definition.profileId} · revision ${definition.revision}`,
        value: { kind: "select", ref: profileRef } as EditorChoice,
        category: "Saved immutable profiles",
        description: `${definition.executableSelector} · ${definition.launchMode} · ${definition.argv.join(" ") || "target as one literal argument"}`,
        disabled: busy(),
        onSelect: () => void update({ select: profileRef }),
      })),
      ...BUILT_IN_EDITORS.map((editor) => {
        const definition = nextDefinition(editor, current)
        return {
          title: `Add ${editor.title} revision ${definition.revision}`,
          value: { kind: "add", editor } as EditorChoice,
          category: "Add profile",
          description: `${editor.details}. Adds an immutable revision; selector resolution is HostKernel-owned.`,
          disabled: busy(),
          onSelect: () => void update({ addProfile: definition, select: ExternalEditorProfile.externalEditorProfileRefV1(definition) }),
        }
      }),
      {
        title: "Test selected editor",
        value: { kind: "launch-unavailable" },
        category: "Launch status",
        description: "Unavailable until the authenticated HostKernel editor.launch receipt lifecycle passes integrated acceptance.",
        disabled: true,
      },
    ]
    return result
  })

  const selected = () => projection()?.selected
  const selectedDefinition = () => projection()?.profiles.find((item) =>
    item.profileRef.profileId === selected()?.profileId && item.profileRef.revision === selected()?.revision,
  )?.definition

  return (
    <DialogSelect
      title="Settings · Editors"
      options={options()}
      flat={false}
      locked={busy()}
      emptyView={
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.warning}>{unavailable() ? "Editor settings are unavailable from Core Config." : "Loading global editor profiles…"}</text>
        </box>
      }
      titleView={
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.text}>Selected: {selectedDefinition()?.profileId ?? "none"}</text>
          <Show when={selectedDefinition()}>
            {(definition) => <text fg={theme.textMuted}>{definition().executableSelector} · {definition().launchMode} · revision {definition().revision}</text>}
          </Show>
          <text fg={theme.warning}>Profiles are user-global immutable argv definitions. The saved choice does not launch or authorize a process; HostKernel selector resolution, Guard, confinement, TTY handoff and receipt recovery remain unavailable until integrated acceptance.</text>
          <text fg={theme.textMuted}>The default session stays single-pane. Use /editor to browse; /editor --side is an explicit temporary pane.</text>
        </box>
      }
      onFilter={() => {}}
      onSelect={() => {}}
    />
  )
}
