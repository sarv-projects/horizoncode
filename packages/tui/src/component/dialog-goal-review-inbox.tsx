import { createMemo, createSignal, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogGoalReview, type GoalReviewProjection } from "./dialog-goal-review"

/** Bounded, authenticated inbox for pending SpecVersion reviews in this workspace. */
export function DialogGoalReviewInbox(props: { directory?: string; workspace?: string }) {
  const sdk = useSDK()
  const theme = useTheme()
  const toast = useToast()
  const dialog = useDialog()
  const [goals, setGoals] = createSignal<GoalReviewProjection[]>([])
  const [error, setError] = createSignal<string>()
  const [truncated, setTruncated] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [afterGoalID, setAfterGoalID] = createSignal<string>()

  async function load(after?: string, append = false) {
    if (loading()) return
    setLoading(true)
    setError(undefined)
    try {
      const response = await sdk.client.experimental.goalReview.goalReviews(
        { directory: props.directory, workspace: props.workspace, afterGoalID: after, limit: "64" },
        { throwOnError: true },
      )
      const page = response.data
      const proposals = page.goals.flatMap((goal) => goal.proposals)
      setGoals((current) => append ? [...current, ...proposals] : proposals)
      setTruncated(page.nextAfterGoalID !== null)
      setAfterGoalID(page.nextAfterGoalID ?? undefined)
    } catch {
      setError("The authenticated Goal review inbox is unavailable in this workspace.")
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  const options = createMemo(() => [
    ...goals().map((proposal) => ({
      title: proposal.objective,
      value: { kind: "proposal" as const, proposal },
      category: proposal.goalId,
      description: `Spec ${proposal.specVersionId} · ${proposal.reviewAvailability.available ? "review available" : "review unavailable"}`,
      footer: `${proposal.proposedBy} · ${proposal.specDigest}`,
    })),
    ...(truncated() && afterGoalID() ? [{
      title: "Load the next 64 Goals",
      value: { kind: "next" as const },
      category: "More proposals",
      description: "Fetch the next bounded inbox page.",
    }] : []),
  ])

  function open(proposal: GoalReviewProjection) {
    dialog.push(
      <DialogGoalReview
        proposal={proposal}
        onAccept={async (decision) => {
          await sdk.client.experimental.goalReview.goalReviewDecision({
            directory: props.directory,
            workspace: props.workspace,
            decision: "accept",
            goalID: decision.goalId,
            specID: decision.specVersionId,
            specDigest: decision.specDigest,
            expectedRevision: decision.expectedRevision,
          }, { throwOnError: true })
          await load()
          toast.show({ message: "Accepted the reviewed SpecVersion.", variant: "success" })
        }}
        onReject={async (decision) => {
          await sdk.client.experimental.goalReview.goalReviewDecision({
            directory: props.directory,
            workspace: props.workspace,
            decision: "reject",
            goalID: decision.goalId,
            specID: decision.specVersionId,
            specDigest: decision.specDigest,
            expectedRevision: decision.expectedRevision,
          }, { throwOnError: true })
          await load()
          toast.show({ message: "Rejected the reviewed SpecVersion.", variant: "info" })
        }}
      />,
    )
  }

  if (error()) {
    return <box paddingLeft={2} paddingRight={2} gap={1}><text fg={theme.theme.text}>Managed Goal reviews</text><text fg={theme.theme.error}>{error()}</text></box>
  }

  return (
    <DialogSelect<{ kind: "proposal"; proposal: GoalReviewProjection } | { kind: "next" }>
      title={`Managed Goal review inbox${truncated() ? " · more available" : ""}`}
      options={options()}
      emptyView={<text fg={theme.theme.textMuted}>{loading() ? "Loading proposals…" : "No pending proposals in this workspace."}</text>}
      onSelect={(option) => option.value.kind === "proposal"
        ? open(option.value.proposal)
        : void load(afterGoalID(), true)}
      footer={<text fg={theme.theme.textMuted}>Decisions are bound to the displayed SpecVersion digest and Goal revision; reviewer identity comes from authenticated Core context.</text>}
    />
  )
}
