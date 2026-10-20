import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

/** A display-only projection of a proposed immutable SpecVersion, not a wire schema. */
export interface GoalReviewProjection {
  readonly goalId: string
  /** Decimal string preserves Rust u64 revisions exactly across JSON/JS. */
  readonly goalRevision: string
  readonly specVersionId: string
  readonly parentVersionId: string | null
  readonly proposedBy: string
  readonly reviewAvailability:
    | { readonly available: true }
    | { readonly available: false; readonly reason: string }
  readonly specDigest: string
  readonly objective: string
  readonly projectRef: string
  readonly workspaceRef: string
  /** Explicit accepted capability identifiers; empty means no managed effects. */
  readonly capabilityScope: readonly string[]
  readonly scope: readonly string[]
  readonly constraints: readonly string[]
  readonly criteria: readonly { readonly id: string; readonly description: string }[]
  readonly budget: {
    readonly maxTasks: number
    readonly maxAttemptsPerTask: number
    readonly maxRunDurationMs: number
    readonly maxWorkers: number
    /** Decimal strings preserve Rust u64 values exactly; null means no explicit bound. */
    readonly maxMemoryBytes: string | null
    readonly maxDiskBytes: string | null
    readonly maxTokens: string | null
    readonly maxCostMicros: string | null
  }
  readonly sourceDigests: readonly string[]
}

export interface GoalReviewDecision {
  readonly goalId: string
  readonly specVersionId: string
  readonly specDigest: string
  /** Decimal string preserves the exact Rust owner revision for compare-and-swap. */
  readonly expectedRevision: string
}

export type GoalReviewAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string }

export interface DialogGoalReviewProps {
  readonly proposal: GoalReviewProjection
  /** The authenticated Rust/API boundary derives reviewer identity; the UI never submits one. */
  readonly onAccept: (decision: GoalReviewDecision) => void | Promise<void>
  readonly onReject: (decision: GoalReviewDecision) => void | Promise<void>
}

type ReviewAction = "details" | "previous" | "next" | "accept" | "reject"
const DETAIL_PAGE_SIZE = 8

function displayText(value: string) {
  // Spec text is user/model-authored input. Keep terminal control bytes from
  // changing the rendered surface; DialogSelect handles width truncation.
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
}

function detailRows(label: string, value: string, width: number) {
  const text = `${label}: ${displayText(value)}`
  const rows: string[] = []
  let offset = 0
  while (offset < text.length) {
    const continuation = offset > 0
    const indent = continuation && width > 2 ? "  " : ""
    const chunkWidth = Math.max(1, width - indent.length)
    rows.push(`${indent}${text.slice(offset, offset + chunkWidth)}`)
    offset += chunkWidth
  }
  return rows
}

export function DialogGoalReview(props: DialogGoalReviewProps) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const [busy, setBusy] = createSignal(false)
  const [status, setStatus] = createSignal("")
  const [page, setPage] = createSignal(0)
  const availability = () => props.proposal.reviewAvailability
  const detailLines = createMemo(() => {
    const proposal = props.proposal
    // Match DialogSelect's detail truncation width and wrap before it can hide
    // reviewed identifiers, digests, or exact decimal budget/revision values.
    const detailWidth = Math.max(1, Math.min(76, dimensions().width - 12))
    const rows = (label: string, value: string) => detailRows(label, value, detailWidth)
    return [
      ...rows("Goal", proposal.goalId),
      ...rows("Goal revision", proposal.goalRevision),
      ...rows("SpecVersion", proposal.specVersionId),
      ...rows("Parent SpecVersion", proposal.parentVersionId ?? "initial version"),
      ...rows("Proposed by", proposal.proposedBy),
      ...rows("Digest", proposal.specDigest),
      ...rows("Objective", proposal.objective),
      ...rows("Project", proposal.projectRef),
      ...rows("Workspace", proposal.workspaceRef),
      ...(proposal.capabilityScope.length > 0
        ? proposal.capabilityScope.flatMap((item) => rows("Capability", item))
        : rows("Capabilities", "none (effects denied)")),
      ...proposal.scope.flatMap((item) => rows("Scope", item)),
      ...(proposal.constraints.length > 0
        ? proposal.constraints.flatMap((item) => rows("Constraint", item))
        : rows("Constraints", "none")),
      ...proposal.criteria.flatMap((criterion) =>
        rows(`Criterion ${criterion.id}`, criterion.description),
      ),
      ...rows("Budget max tasks", String(proposal.budget.maxTasks)),
      ...rows("Budget max attempts/task", String(proposal.budget.maxAttemptsPerTask)),
      ...rows("Budget max duration ms", String(proposal.budget.maxRunDurationMs)),
      ...rows("Budget max workers", String(proposal.budget.maxWorkers)),
      ...rows("Budget max memory bytes", proposal.budget.maxMemoryBytes ?? "not specified"),
      ...rows("Budget max disk bytes", proposal.budget.maxDiskBytes ?? "not specified"),
      ...rows("Budget max tokens", proposal.budget.maxTokens ?? "not specified"),
      ...rows("Budget max cost micros", proposal.budget.maxCostMicros ?? "not specified"),
      ...(proposal.sourceDigests.length > 0
        ? proposal.sourceDigests.flatMap((digest) => rows("Source digest", digest))
        : rows("Source digests", "none")),
    ]
  })
  const pageCount = createMemo(() => Math.max(1, Math.ceil(detailLines().length / DETAIL_PAGE_SIZE)))
  const options = createMemo<DialogSelectOption<ReviewAction>[]>(() => {
    const currentPage = page()
    const lastPage = pageCount() - 1
    const currentAvailability = availability()
    const decisionsEnabled = currentAvailability.available && !busy()
    const unavailableReason = currentAvailability.available ? undefined : currentAvailability.reason

    return [
      {
        title: `Review proposal details · page ${currentPage + 1} of ${pageCount()}`,
        value: "details",
        description: "Review every page of this immutable proposal before deciding.",
        details: detailLines().slice(
          currentPage * DETAIL_PAGE_SIZE,
          (currentPage + 1) * DETAIL_PAGE_SIZE,
        ),
      },
      {
        title: currentPage === 0 ? "First details page" : "Previous details page",
        value: "previous",
        description: currentPage === 0 ? "There is no earlier page." : "Show the previous proposal details.",
      },
      {
        title: currentPage === lastPage ? "Last details page" : "Next details page",
        value: "next",
        description: currentPage === lastPage ? "There are no more proposal details." : "Show the next proposal details.",
      },
      {
        title: "Accept this exact SpecVersion",
        value: "accept",
        disabled: !decisionsEnabled,
        description: unavailableReason ?? (busy() ? "Saving review decision…" : "Accept the digest and revision shown above."),
      },
      {
        title: "Reject and request a revised SpecVersion",
        value: "reject",
        disabled: !decisionsEnabled,
        description: unavailableReason ?? (busy() ? "Saving review decision…" : "Reject this immutable proposal; it cannot be edited in place."),
      },
    ]
  })

  async function decide(action: "accept" | "reject") {
    if (busy() || !availability().available) return
    setBusy(true)
    setStatus("")
    const decision: GoalReviewDecision = {
      goalId: props.proposal.goalId,
      specVersionId: props.proposal.specVersionId,
      specDigest: props.proposal.specDigest,
      expectedRevision: props.proposal.goalRevision,
    }
    try {
      await (action === "accept" ? props.onAccept(decision) : props.onReject(decision))
      dialog.clear()
    } catch {
      // Do not let a stale or unauthenticated proposal appear accepted. The
      // caller must refresh the projection before another review decision.
      setStatus("Decision was not saved. Refresh the Goal and review the current SpecVersion.")
    } finally {
      setBusy(false)
    }
  }

  function footerText() {
    const currentStatus = status()
    if (currentStatus) return currentStatus
    const currentAvailability = availability()
    if (currentAvailability.available) {
      return `Details page ${page() + 1}/${pageCount()}. Acceptance is recorded by Rust against this exact digest and Goal revision.`
    }
    return `Decision unavailable: ${displayText(currentAvailability.reason)}`
  }

  return (
    <DialogSelect
      title="Goal · Review proposed SpecVersion"
      options={options()}
      locked={busy()}
      footer={
        <text>
          <span>{footerText()}</span>
        </text>
      }
      onSelect={(option) => {
        if (option.value === "previous" && page() > 0) setPage(page() - 1)
        if (option.value === "next" && page() < pageCount() - 1) setPage(page() + 1)
        if (option.value === "accept" || option.value === "reject") void decide(option.value)
      }}
    />
  )
}
