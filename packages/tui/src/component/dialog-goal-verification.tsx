import { createMemo, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export type GoalVerificationResult =
  | {
      readonly status: "ABORTED"
      readonly reason: "reviewer_denied" | "cancelled" | "expired" | "transport_lost"
      readonly revision: string
    }
  | {
      readonly status:
        | "VERIFYING"
        | "SUCCEEDED"
        | "FAILED"
        | "UNKNOWN"
        | "NEEDS_YOU"
        | "CANCELLING"
        | "CANCELLED"
      readonly revision: string
    }

export interface DialogGoalVerificationProps {
  readonly goalID: string
  readonly runID: string
  readonly onVerify: () => Promise<GoalVerificationResult>
}

type Action = "verify" | "close"

function clean(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
}

function outcomeText(result: GoalVerificationResult) {
  if (result.status === "ABORTED") {
    switch (result.reason) {
      case "reviewer_denied":
        return "Verification was stopped after a Guard request was denied. No verifier process started."
      case "cancelled":
        return "Verification was cancelled before any unapproved verifier process could start."
      case "expired":
        return "The approval window expired. Start a fresh verification request if you still want to continue."
      case "transport_lost":
        return "Approval state could not be confirmed. The verifier did not start; check the managed Run before retrying."
    }
  }
  switch (result.status) {
    case "VERIFYING":
      return "Verification is still running. Check the managed Run for its final state."
    case "SUCCEEDED":
      return "The verifier completed against the current workspace revision."
    case "FAILED":
      return "The verifier completed and found that the Run does not pass its accepted criteria."
    case "UNKNOWN":
      return "The verifier result is uncertain. Reconcile this Run before starting another verification."
    case "NEEDS_YOU":
      return "The verifier could not complete every accepted criterion. Review the Run before continuing."
    case "CANCELLING":
      return "Cancellation is still being reconciled. Check the managed Run before retrying or continuing."
    case "CANCELLED":
      return "The managed Run was cancelled after its verifier receipts were reconciled."
  }
}

export function DialogGoalVerification(props: DialogGoalVerificationProps) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<GoalVerificationResult>()
  const [error, setError] = createSignal("")
  const options = createMemo<DialogSelectOption<Action>[]>(() => {
    if (result()) return [{ title: "Close", value: "close", description: outcomeText(result()!) }]
    return [
      {
        title: "Run the accepted verification checks",
        value: "verify",
        disabled: busy(),
        description: busy()
          ? "Waiting for Guard approval and verifier results…"
          : "Each verifier process will ask for Guard approval before it starts.",
      },
      { title: "Close", value: "close", disabled: busy(), description: "Leave this managed Run unchanged." },
    ]
  })

  async function verify() {
    if (busy() || result()) return
    setBusy(true)
    setError("")
    try {
      setResult(await props.onVerify())
    } catch {
      setError("No final verification result was confirmed. Check the managed Run before retrying.")
    } finally {
      setBusy(false)
    }
  }

  const footer = () => {
    const currentError = error()
    if (currentError) return currentError
    const currentResult = result()
    if (currentResult) return `${outcomeText(currentResult)} Revision ${clean(currentResult.revision)}.`
    return `Goal ${clean(props.goalID)} · Run ${clean(props.runID)}. Guard approval is required before verifier processes start.`
  }

  return (
    <DialogSelect
      title="Goal · Verify accepted Run"
      options={options()}
      locked={busy()}
      footer={
        <text>
          <span>{footer()}</span>
        </text>
      }
      onSelect={(option) => {
        if (option.value === "verify") void verify()
        if (option.value === "close" && !busy()) dialog.clear()
      }}
    />
  )
}
