import { createMemo, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogAlert } from "../ui/dialog-alert"

export type VerifiedArtifactRefV1 = {
  readonly artifactID: string
  readonly digest: string
  readonly byteLength: string
  readonly mediaType: string
  readonly classification: "PUBLIC" | "WORKSPACE" | "SENSITIVE"
}

export type WorktreeDispositionSummaryV1 = {
  readonly ownerEpoch: string
  readonly disposition: "REUSABLE" | "QUARANTINED"
  readonly settlementReceiptDigest: string
  readonly finalWorktreeOperationID: string
  readonly finalWorktreeHostReceiptRef: string
  readonly observedWorkspaceRevision: string
  readonly inspectReceiptDigest: string
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
  readonly workerPoolRevision: string
  readonly receiptDigest: string
}

export type DispatchSettlementSummaryV1 =
  | { readonly status: "SETTLED"; readonly receiptDigest: string }
  | { readonly status: "QUARANTINED"; readonly reason: "FAILED_ATTEMPT" | "CANCELLED_TASK"; readonly receiptDigest: string }

export type GoalVerificationResult =
  | {
      readonly status: "ABORTED"
      readonly reason: "reviewer_denied" | "cancelled" | "expired" | "transport_lost"
      readonly revision: string
      readonly evidenceDigest?: never
      readonly artifactCount?: never
      readonly settlementDisposition?: never
      readonly artifactRefs?: never
      readonly dispatchSettlement?: never
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
      readonly reason?:
        | "reviewer_denied"
        | "cancelled"
        | "expired"
        | "transport_lost"
        | "cancelled_before_next_test"
        | "guarded_execution_unavailable"
        | "execution_outcome_unknown"
        | "workspace_revision_changed"
        | "verification_incomplete"
      readonly revision: string
      readonly evidenceDigest?: string
      readonly artifactCount?: number
      readonly sourceRevision?: string
      readonly usageAccounting?: {
        readonly tokenKnownSubtotal: string
        readonly tokenRemainderStatus: "KNOWN" | "ESTIMATED" | "UNKNOWN"
        readonly costKnownSubtotalMicros: string
        readonly costRemainderStatus: "KNOWN" | "ESTIMATED" | "UNKNOWN"
        readonly usageState: "KNOWN" | "ESTIMATED" | "UNKNOWN"
        readonly costStatus: string
      }
      readonly settlementDisposition?: "RELEASED" | "WORKTREE_QUARANTINED"
      readonly worktreeDisposition?: WorktreeDispositionSummaryV1
      readonly artifactRefs?: readonly VerifiedArtifactRefV1[]
      readonly dispatchSettlement?: DispatchSettlementSummaryV1
    }

export interface DialogGoalVerificationProps {
  readonly goalID: string
  readonly runID: string
  /** Must be enabled only after HostKernel verifier and P8 settlement acceptance. */
  readonly available?: boolean
  readonly onVerify: () => Promise<GoalVerificationResult>
  readonly onReadArtifact: (artifact: VerifiedArtifactRefV1) => Promise<string>
}

type Action = "verify" | "close" | `artifact:${number}`

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
      return `The verifier completed against revision ${clean(result.sourceRevision ?? "unavailable")} with ${result.artifactCount ?? 0} evidence artifacts (${clean(result.evidenceDigest ?? "evidence unavailable").slice(0, 24)}); usage ${clean(result.usageAccounting?.tokenKnownSubtotal ?? "unavailable")} known tokens + ${result.usageAccounting?.tokenRemainderStatus ?? "UNKNOWN"} remainder, ${clean(result.usageAccounting?.costKnownSubtotalMicros ?? "unavailable")} known cost micros + ${result.usageAccounting?.costRemainderStatus ?? "UNKNOWN"} remainder (${result.usageAccounting?.costStatus ?? "unknown"}); P8 ${result.settlementDisposition ?? "settlement pending"}, worktree ${result.worktreeDisposition?.disposition ?? "pending"}.`
    case "FAILED":
      return `The verifier completed and found that the Run does not pass its accepted criteria. P8 ${result.dispatchSettlement?.status ?? "settlement pending"}${result.dispatchSettlement?.status === "QUARANTINED" ? ` (${result.dispatchSettlement.reason})` : ""}.`
    case "UNKNOWN":
      switch (result.reason) {
        case "cancelled_before_next_test":
          return "Verification was cancelled before the next check started. Reconcile this Run before retrying."
        case "guarded_execution_unavailable":
          return "Guarded verifier execution was unavailable. Reconcile this Run before retrying."
        case "execution_outcome_unknown":
          return "A verifier execution receipt could not be confirmed. Reconcile this Run before retrying."
        case "workspace_revision_changed":
          return "The workspace changed during verification. Review and reconcile this Run before retrying."
        case "verification_incomplete":
          return "Not every accepted check produced complete evidence. Reconcile this Run before retrying."
        default:
          return "The verifier result is uncertain. Reconcile this Run before starting another verification."
      }
    case "NEEDS_YOU":
      return "The verifier could not complete every accepted criterion. Review the Run before continuing."
    case "CANCELLING":
      return "Cancellation is still being reconciled. Check the managed Run before retrying or continuing."
    case "CANCELLED":
      return `The managed Run was cancelled after its verifier receipts were reconciled. P8 ${result.dispatchSettlement?.status ?? "settlement pending"}${result.dispatchSettlement?.status === "QUARANTINED" ? ` (${result.dispatchSettlement.reason})` : ""}.`
  }
}

export function DialogGoalVerification(props: DialogGoalVerificationProps) {
  const dialog = useDialog()
  const available = () => props.available === true
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<GoalVerificationResult>()
  const [error, setError] = createSignal("")
  const options = createMemo<DialogSelectOption<Action>[]>(() => {
    if (result()) {
      const current = result()!
      const artifacts = current.status === "SUCCEEDED" ? current.artifactRefs ?? [] : []
      return [
        ...artifacts.map((artifact, index) => ({
          title: `Inspect verified artifact · ${clean(artifact.artifactID).slice(0, 80)}`,
          value: `artifact:${index}` as const,
          description: `${clean(artifact.mediaType).slice(0, 80)} · ${artifact.byteLength} bytes · ${artifact.classification}`,
        })),
        { title: "Close", value: "close", description: outcomeText(current) },
      ]
    }
    return [
      {
        title: "Run the accepted verification checks",
        value: "verify",
        disabled: busy() || !available(),
        description: busy()
          ? "Waiting for Guard approval and verifier results…"
          : available()
            ? "Each verifier process will ask for Guard approval before it starts."
            : "Unavailable until trusted HostKernel verification and P8 settlement acceptance are enabled.",
      },
      { title: "Close", value: "close", disabled: busy(), description: "Leave this managed Run unchanged." },
    ]
  })

  async function verify() {
    if (!available() || busy() || result()) return
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
    return available()
      ? `Goal ${clean(props.goalID)} · Run ${clean(props.runID)}. Guard approval is required before verifier processes start.`
      : `Goal ${clean(props.goalID)} · Run ${clean(props.runID)}. Verification is unavailable until trusted HostKernel and P8 acceptance.`
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
        if (option.value.startsWith("artifact:") && !busy()) {
          const index = Number(option.value.slice("artifact:".length))
          const artifact = result()?.status === "SUCCEEDED" ? result()!.artifactRefs?.[index] : undefined
          if (!artifact) return
          setBusy(true)
          setError("")
          void props.onReadArtifact(artifact).then(
            (preview) => DialogAlert.show(dialog, `Verified artifact · ${clean(artifact.artifactID)}`, preview),
            () => setError("Artifact ownership or bounded preview could not be confirmed."),
          ).finally(() => setBusy(false))
        }
      }}
    />
  )
}
