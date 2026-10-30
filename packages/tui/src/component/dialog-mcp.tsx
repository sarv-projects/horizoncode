import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"
import type { McpStatus } from "@horizoncode/sdk/v2"
import { useToast } from "../ui/toast"

export function mcpStatusLabel(status: McpStatus): string {
  switch (status.status) {
    case "connected":
      return "Connected"
    case "disabled":
      return "Disabled"
    case "failed":
      return "Unavailable"
    case "needs_auth":
      return "Needs authentication"
    case "needs_client_registration":
      return "Client registration required"
  }
}

export function mcpStatusDetail(status: McpStatus): string | undefined {
  if (status.status === "failed" || status.status === "needs_client_registration") return status.error
}

function Status(props: { status: McpStatus; loading: boolean }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
  }
  if (props.status.status === "connected") {
    return (
      <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ {mcpStatusLabel(props.status)}</span>
    )
  }
  if (props.status.status === "failed") {
    return <span style={{ fg: theme.error }}>○ {mcpStatusLabel(props.status)}</span>
  }
  if (props.status.status === "needs_auth" || props.status.status === "needs_client_registration") {
    return <span style={{ fg: theme.warning }}>○ {mcpStatusLabel(props.status)}</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ {mcpStatusLabel(props.status)}</span>
}

export function DialogMcp() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)

  const options = createMemo(() => {
    // Track sync data and loading state to trigger re-render when they change
    const mcpData = sync.data.mcp
    const loadingMcp = loading()

    return pipe(
      mcpData ?? {},
      entries(),
      sortBy(([name]) => name),
      map(([name, status]) => ({
        value: name,
        title: name,
        description: mcpStatusDetail(status) ?? mcpStatusLabel(status),
        footer: <Status status={status} loading={loadingMcp === name} />,
        category: undefined,
      })),
    )
  })

  const actions = createMemo(() => [
    {
      command: "dialog.mcp.toggle",
      title: "toggle",
      onTrigger: async (option: DialogSelectOption<string>) => {
        // Prevent toggling while an operation is already in progress
        if (loading() !== null) return

        setLoading(option.value)
        try {
          await local.mcp.toggle(option.value)
          // Refresh MCP status from server
          const status = await sdk.client.mcp.status()
          if (status.data) {
            sync.set("mcp", status.data)
          } else {
            console.error("Failed to refresh MCP status: no data returned")
          }
        } catch {
          const status = sync.data.mcp[option.value]
          const message =
            mcpStatusDetail(status) ?? `Could not change MCP ${option.value}; current status: ${mcpStatusLabel(status)}.`
          toast.show({
            message,
            variant: "error",
          })
        } finally {
          setLoading(null)
        }
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title="MCPs"
      options={options()}
      actions={actions()}
      onSelect={(_option) => {
        // Don't close on select, only on escape
      }}
    />
  )
}
