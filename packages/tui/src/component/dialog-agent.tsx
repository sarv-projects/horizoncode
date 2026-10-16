import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

/**
 * Agent picker metadata is source-backed: the profile description and the
 * explicit model binding from the agent config. No model binding renders no
 * model claim; the effective model only changes when the profile or the
 * user's per-agent selection says so (16.5).
 */
export function agentOptionDescription(item: {
  description?: string
  native?: boolean
  model?: { providerID: string; modelID: string }
}) {
  const model = item.model ? `model ${item.model.providerID}/${item.model.modelID}` : undefined
  return [item.description, model].filter(Boolean).join(" · ") || (item.native ? "Built-in agent" : undefined)
}

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: item.name,
        description: agentOptionDescription(item),
      }
    }),
  )

  return (
    <DialogSelect
      title="Select agent"
      current={local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
