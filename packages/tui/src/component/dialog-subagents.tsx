import { createMemo, createSignal, onMount } from "solid-js"
// The TUI package does not currently declare @opencode-ai/schema as a
// dependency. Import the canonical schema source directly so this surface
// cannot fork its own decoder; packaging must add the workspace dependency.
import type { SubagentStatusV1 } from "../../../schema/src/subagent-status-v1"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { DialogSubagentMessage } from "./dialog-subagent-message"
import { DialogConfirm } from "../ui/dialog-confirm"

export function DialogSubagents(props: { sessionID: string; onOpenChild: (sessionID: string) => void }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const toast = useToast()
  const dialog = useDialog()
  const [result, setResult] = createSignal<SubagentStatusV1.ListV1>()
  const [error, setError] = createSignal<string>()
  const [waiting, setWaiting] = createSignal(false)

  const refresh = () =>
    sdk.client.session
      .subagents({ sessionID: props.sessionID }, { throwOnError: true })
      .then((response) => setResult(response.data as unknown as SubagentStatusV1.ListV1))
      .catch(() => setError("Child status is unavailable from the authenticated runtime."))

  onMount(() => void refresh())

  async function waitForUpdate(sessionID: string) {
    if (waiting()) return
    setWaiting(true)
    try {
      const response = await sdk.client.session.subagentWait(
        { sessionID: props.sessionID, childSessionID: sessionID, timeoutMs: 15_000 },
        { throwOnError: true },
      )
      await refresh()
      toast.show({
        message: response.data.outcome === "timeout" ? "Child is still running; it was not cancelled." : "Child status updated.",
        variant: "info",
      })
    } catch {
      toast.show({ message: "Could not wait for child status.", variant: "error" })
    } finally {
      setWaiting(false)
    }
  }

  async function cancelChild(sessionID: string) {
    if (waiting()) return
    const confirmed = await DialogConfirm.show(
      dialog,
      "Cancel child Session",
      "Request cancellation through the child Attempt fence. An already-dispatched effect may still settle or remain UNKNOWN.",
      "Keep running",
    )
    if (!confirmed) return
    setWaiting(true)
    try {
      await sdk.client.session.abort({ sessionID }, { throwOnError: true })
      const observed = await sdk.client.session.subagentWait(
        { sessionID: props.sessionID, childSessionID: sessionID, timeoutMs: 15_000 },
        { throwOnError: true },
      )
      await refresh()
      const child = observed.data.child
      if (child.state === "cancelled") {
        toast.show({ message: "Child cancellation was observed.", variant: "info" })
      } else if (child.state === "running") {
        toast.show({ message: "STILL_RUNNING: the child did not reach a terminal state before the wait deadline.", variant: "error" })
      } else {
        toast.show({ message: `Cancellation request settled as ${child.state}.`, variant: child.state === "unknown" ? "error" : "info" })
      }
    } catch {
      toast.show({ message: "UNKNOWN: cancellation outcome could not be observed. Inspect the child status before retrying.", variant: "error" })
      await refresh()
    } finally {
      setWaiting(false)
    }
  }

  function chooseMessageMode(childSessionID: string) {
    dialog.push(
      <DialogSelect
        title="Message a child Session"
        options={[
          { title: "Queue for its next turn", value: "queued" as const, description: "Store the message without waking the child." },
          { title: "Request one follow-up turn", value: "follow_up" as const, description: "Wake exactly one turn at the next authorized safe boundary." },
        ]}
        onSelect={(option) => dialog.push(
          <DialogSubagentMessage parentSessionID={props.sessionID} childSessionID={childSessionID} mode={option.value} />,
        )}
      />,
    )
  }

  const options = createMemo(() =>
    (result()?.children ?? []).map((child) => ({
      title: child.title || child.sessionId,
      value: child.sessionId,
      category: "Direct child Sessions",
      description: `${child.state}${child.activeRequest ? " · request active" : " · no active request"} · Attempt ${child.directAttemptId}`,
      footer: `Profile ${child.profileId}@${child.profileRevision} · delivery ${child.deliveryAckState} #${child.lastSequence} · receipt ${child.receiptDigest ?? "unknown"}${child.failureCode ? ` · ${child.failureCode}` : ""}`,
    })),
  )

  if (error()) {
    return (
      <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
        <text fg={theme.text}>Direct child Sessions</text>
        <text fg={theme.error}>{error()}</text>
        <text fg={theme.textMuted}>Messages require HostKernel Guard admission. Follow-up requests run only at a safe child boundary and remain gated until P1/P8 acceptance.</text>
      </box>
    )
  }

  return (
    <DialogSelect
      title={`Direct child Sessions${result()?.truncated ? " · first 64" : ""}`}
      options={options()}
      actions={[
        {
          command: "session.subagents.message",
          title: "Message child Session",
          onTrigger: (option) => chooseMessageMode(option.value),
        },
        {
          command: "session.subagents.wait",
          title: waiting() ? "Waiting for child update…" : "Wait for child update",
          disabled: waiting(),
          onTrigger: (option) => void waitForUpdate(option.value),
        },
        {
          command: "session.subagents.cancel",
          title: waiting() ? "Waiting for cancellation outcome…" : "Cancel child Session",
          disabled: waiting(),
          onTrigger: (option) => void cancelChild(option.value),
        },
      ]}
      emptyView={
        <box gap={1}>
          <text fg={theme.textMuted}>{result() ? "No direct child agents are linked to this Session." : "Loading child status…"}</text>
        <text fg={theme.textMuted}>Messages require HostKernel Guard admission. Follow-up requests run only at a safe child boundary and remain gated until P1/P8 acceptance.</text>
        </box>
      }
      onSelect={(option) => props.onOpenChild(option.value)}
    />
  )
}
