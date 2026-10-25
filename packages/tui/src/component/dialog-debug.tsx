import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For } from "solid-js"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useRoute } from "../context/route"
import { useLocal } from "../context/local"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"
import { describeOS, describeTerminal } from "../util/system"
import { formatTuiObservation, projectSessionUsage, tuiAnalyticsProjection } from "../util/tui-analytics"
import { useSync } from "../context/sync"

export function DialogDebug() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const route = useRoute()
  const local = useLocal()
  const clipboard = useClipboard()
  const toast = useToast()
  const sync = useSync()
  const [copied, setCopied] = createSignal(false)

  dialog.setSize("large")

  const entries = createMemo(() => {
    const model = local.model.current()
    const artifactMetrics = tuiAnalyticsProjection.snapshot().map((observation) => formatTuiObservation(observation))
    const streamMetrics = sync.stream.observations().map((observation) => formatTuiObservation(observation))
    const usage = route.data.type === "session"
      ? projectSessionUsage(
          sync.data.message[route.data.sessionID] ?? [],
          4,
          sync.data.part,
        )
      : []
    return [
      { label: "Version", value: `${InstallationVersion} (${InstallationChannel})` },
      { label: "Date", value: new Date().toISOString() },
      { label: "OS", value: describeOS() },
      { label: "Terminal", value: describeTerminal() },
      { label: "Session ID", value: route.data.type === "session" ? route.data.sessionID : "n/a" },
      { label: "Model", value: model ? `${model.providerID}/${model.modelID}` : "n/a" },
      ...usage.map((value, index) => ({
        label: index === 0 ? "Usage" : value.startsWith("Token totals") ? "Tokens" : value.startsWith("Cost observations") ? "Cost" : "",
        value,
      })),
      ...artifactMetrics,
      ...streamMetrics,
    ]
  })

  const copy = () => {
    const text = entries()
      .map((entry) => `${entry.label}: ${entry.value}`)
      .join("\n")
    void clipboard
      .write?.(text)
      .then(() => {
        setCopied(true)
        toast.show({ message: "Debug info copied to clipboard", variant: "info" })
      })
      .catch(toast.error)
  }

  useBindings(() => ({
    bindings: [{ key: "return", desc: "Copy debug info", group: "Dialog", cmd: copy }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Debug
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      {/* No click-to-copy here: releasing a mouse selection must trigger the
          global copy-on-select so users can copy a single value, e.g. the session id. */}
      <box>
        <For each={entries()}>
          {(entry) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme.textMuted}>
                {entry.label.padEnd(10)}
              </text>
              <text fg={theme.text} wrapMode="word">
                {entry.value}
              </text>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>Share this when reporting an issue.</text>
        <text onMouseUp={copy}>
          <span style={{ fg: copied() ? theme.success : theme.text }}>
            <b>{copied() ? "✓ copied" : "copy"}</b>{" "}
          </span>
          <span style={{ fg: theme.textMuted }}>enter</span>
        </text>
      </box>
    </box>
  )
}

/**
 * `/debug effects` diagnostics. Only measured values are shown; the direct
 * read-fast-path/Guard latency counters are not instrumented yet, so they stay
 * explicitly unavailable instead of being rendered as zero.
 */
export function DialogDebugEffects() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()

  dialog.setSize("large")

  const entries = createMemo(() => {
    const session = route.data.type === "session" ? route.data.sessionID : undefined
    const status = session ? sync.session.status(session) : "n/a"
    const pending = sync.guardApproval.pending().length
    return [
      { label: "Session", value: session ?? "n/a" },
      { label: "Status", value: String(status) },
      { label: "Guard asks", value: `${pending} pending` },
      { label: "kernelRpcMs", value: "unavailable · not instrumented" },
      { label: "readFastPathCount", value: "unavailable · not instrumented" },
      { label: "batchReadCoalesced", value: "unavailable · not instrumented" },
      { label: "guardDecisionMs", value: "unavailable · not instrumented" },
      { label: "Effect dispatch", value: "fail-closed unless the Rust Guard/ExecutionHost path accepted it" },
      { label: "UNKNOWN outcomes", value: "never replayed; submit a new explicit continuation" },
    ]
  })

  useBindings(() => ({
    bindings: [{ key: "escape", desc: "Close effect diagnostics", group: "Dialog", cmd: () => dialog.clear() }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Debug · effects
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box>
        <For each={entries()}>
          {(entry) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme.textMuted}>
                {entry.label.padEnd(20)}
              </text>
              <text fg={theme.text} wrapMode="word">
                {entry.value}
              </text>
            </box>
          )}
        </For>
      </box>
      <text fg={theme.textMuted}>No paths, credentials, or effect payloads are logged here.</text>
    </box>
  )
}
