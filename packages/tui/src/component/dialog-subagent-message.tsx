import { createSignal } from "solid-js"
import { randomUUID } from "node:crypto"
import type { TextareaRenderable } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

export function DialogSubagentMessage(props: { parentSessionID: string; childSessionID: string; mode?: "queued" | "follow_up" }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [content, setContent] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const requestId = randomUUID()
  let editor: TextareaRenderable | undefined

  async function submit() {
    const text = content()
    if (busy() || !text.trim()) return
    if (new TextEncoder().encode(text).byteLength > 16 * 1024) {
      setError("Messages are limited to 16 KiB.")
      return
    }
    setBusy(true)
    setError("")
    try {
      const response = await sdk.client.session.subagentMessage({
        sessionID: props.parentSessionID,
        childSessionID: props.childSessionID,
        requestId,
        mode: props.mode ?? "queued",
        content: text,
      }, { throwOnError: true })
      const result = response.data
      if (result.status === "QUEUED" || result.status === "FOLLOW_UP_SCHEDULED") {
        dialog.clear()
        toast.show({ message: props.mode === "follow_up"
          ? `Follow-up turn completed for child · #${result.mailboxSequence}`
          : `Message queued for child · #${result.mailboxSequence}`, variant: "info" })
        return
      }
      if (result.status === "UNKNOWN") {
        setError(`Outcome is unknown for request ${requestId}. The durable inbox entry was retained; do not submit this content again under a new request.`)
        setBusy(false)
        return
      }
      if (result.status === "NEEDS_APPROVAL") {
        setError(`Guard approval is required${result.challengeId ? ` (${result.challengeId})` : ""}. Approve it in the Guard dialog, then submit here again to continue the same request. ${result.reason ?? ""}`)
        setBusy(false)
        return
      }
      setError(result.reason ?? "The message could not be queued.")
      setBusy(false)
    } catch {
      setError("The authenticated runtime did not confirm delivery. Inspect child status before retrying.")
      setBusy(false)
    }
  }

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text}>{props.mode === "follow_up" ? "Request one follow-up turn" : "Queue a message"} for {props.childSessionID}</text>
      <text fg={theme.textMuted}>{props.mode === "follow_up"
        ? "This requests exactly one serialized turn after HostKernel authorizes the next safe child input boundary."
        : "Queueing never starts a turn or changes an active stream."}</text>
      <textarea
        ref={(input: TextareaRenderable) => {
          editor = input
          queueMicrotask(() => input.focus())
        }}
        initialValue={content()}
        placeholder="Message for the child inbox"
        placeholderColor={theme.textMuted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.primary}
        minHeight={5}
        maxHeight={14}
        onContentChange={() => setContent(editor?.plainText ?? "")}
        onSubmit={() => void submit()}
      />
      {error() && <text fg={theme.error}>{error()}</text>}
      <text fg={theme.textMuted}>{busy() ? "Waiting for Guarded inbox receipt…" : "Enter to submit · Escape to cancel"}</text>
    </box>
  )
}
