import { createMemo, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

type GuaranteeAssessment =
  | { readonly status: "assessed"; readonly residual: readonly string[] }
  | { readonly status: "not_assessed"; readonly residual: null }

type ArgumentSummary =
  | { readonly status: "available"; readonly text: string }
  | { readonly status: "unavailable"; readonly reason: string }

/** Host-projected consent context. Missing or malformed optional fields stay unavailable. */
export interface GuardApprovalRequestView {
  readonly approvalID: string
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityID: string
  readonly locationID: string
  readonly sessionID?: string
  readonly runID?: string
  readonly inputDigest: string
  readonly normalizedTargets: readonly unknown[]
  readonly expiresAtUnixMs: number
  readonly policySummary: string
  readonly origin?: string
  readonly source?: string
  readonly policyID?: string
  readonly policyDigest?: string
  readonly normalizedAction?: string
  readonly argumentSummary?: ArgumentSummary
  readonly requestedGuarantees?: readonly string[]
  readonly guaranteeAssessment?: GuaranteeAssessment
  readonly noResponse?: "deny_and_expire"
  readonly allowEnabled?: boolean
}

export interface DialogGuardApprovalProps {
  readonly request: GuardApprovalRequestView
  /** Callbacks receive only the selected decision; host fields and IDs stay untouched. */
  readonly onDecision: (decision: "allow_once" | "deny" | "grant_session" | "grant_workspace") => unknown | Promise<unknown>
}

type Action = "allow_once" | "deny" | "grant_session" | "grant_workspace"
type MenuAction = Action | "details" | "previous" | "next"

const MAX_DETAIL_CHARS = 240
const DETAIL_WIDTH = 24
const DETAIL_PAGE_SIZE = 8

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_DETAIL_CHARS)
}

function safeValue(value: unknown): string {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return "unavailable"
    return clean(encoded)
  } catch {
    return "unavailable"
  }
}

function allowEligible(request: GuardApprovalRequestView): boolean {
  const requested = request.requestedGuarantees
  const assessment = request.guaranteeAssessment
  const requestedSet = new Set(requested ?? [])
  const residual = assessment?.status === "assessed" ? assessment.residual : undefined
  // Workspace-owner automation changes are authenticated ServerAuth actions
  // scoped to a HostKernel Location. They intentionally have no Session ID;
  // the capability and source pair must stay exact so this does not loosen
  // session or managed-run approvals.
  const authenticatedAutomationOwnerAction =
    request.origin === "user_action" &&
    request.source === "authenticated.user_action" &&
    /^automations\.(create|update|enable|disable)$/.test(request.capabilityID) &&
    /^loc_[0-9a-f]{64}$/.test(request.locationID)
  return (
    request.allowEnabled === true &&
    (["session_batch", "user_action"].includes(request.origin ?? "") &&
      ["core.tool_batch", "authenticated.user_action"].includes(request.source ?? "") ||
      request.origin === "managed_run" && request.source === "host.managed_verifier" ||
      request.origin === "managed_run" && request.source === "host.managed_provider" && request.capabilityID === "providers.infer" &&
        request.policyID === "provider-inference.managed.v1" &&
        requested?.join("\0") === ["live_managed_attempt", "selected_route_revision", "normalized_request_digest", "transport_request_digest", "secret_operation_digest", "explicit_route_consent", "budget_bound", "one_use", "no_fallback"].join("\0") &&
        assessment?.status === "assessed" && assessment.residual.length === 0 ||
      request.origin === "managed_root" && request.source === "host.managed_worktree" && request.capabilityID === "git.worktree.list") &&
    !!request.policyID && /^[a-z][a-z0-9._-]{0,127}$/.test(request.policyID) &&
    !!request.policyDigest && /^blake3:[0-9a-f]{64}$/.test(request.policyDigest) &&
    request.normalizedAction === request.capabilityID &&
    request.argumentSummary?.status === "available" && request.argumentSummary.text.trim().length > 0 &&
    requested !== undefined && requested.length > 0 && requested.length <= 16 &&
    requestedSet.size === requested.length &&
    requested.every((id) => /^[a-z][a-z0-9._-]{0,63}$/.test(id)) &&
    residual !== undefined &&
    residual.length <= 16 && new Set(residual).size === residual.length &&
    residual.every((id) => requestedSet.has(id)) &&
    (request.origin !== "managed_root" ||
      request.policyID === "broker-process.local.v1" &&
      requested?.join("\0") === ["configured_executable", "bounded_argv_env", "beneath_workspace_root", "one_use"].join("\0") &&
      assessment?.status === "assessed" && assessment.residual.length === 0) &&
    request.normalizedTargets.length > 0 && request.normalizedTargets.length <= 32 &&
    (request.runID !== undefined || request.sessionID !== undefined || authenticatedAutomationOwnerAction) &&
    request.noResponse === "deny_and_expire"
  )
}

function grantEligible(request: GuardApprovalRequestView): boolean {
  return request.origin === "session_batch" && request.source === "core.tool_batch" &&
    request.sessionID !== undefined && request.runID === undefined &&
    ["files.write", "files.patch"].includes(request.capabilityID) &&
    /^[A-Za-z0-9._-]{1,256}$/.test(request.challengeID) &&
    /^[A-Za-z0-9._-]{1,256}$/.test(request.effectID) &&
    /^loc_[0-9a-f]{64}$/.test(request.locationID)
}

function detailLines(request: GuardApprovalRequestView): string[] {
  const assessment = request.guaranteeAssessment
  const argument = request.argumentSummary
  const canAllow = allowEligible(request)
  const targets = request.normalizedTargets.slice(0, 32).flatMap((target, index) => {
    if (typeof target !== "object" || target === null || Array.isArray(target)) {
      return [`Target ${index + 1}: ${safeValue(target)}`]
    }
    const fields = Object.entries(target as Record<string, unknown>)
      .filter(([key]) => /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key))
      .toSorted(([left], [right]) => (left === "resource" ? -1 : right === "resource" ? 1 : 0))
      .slice(0, 8)
      .map(([key, value]) => `${key === "resource" ? "Resource" : clean(key)}: ${safeValue(value)}`)
    return fields.length > 0 ? fields : [`Target ${index + 1}: unavailable`]
  })
  const values = [
    ["Allow", canAllow ? "available once" : "unavailable; consent context incomplete"],
    ["Action", request.normalizedAction ?? request.capabilityID],
    ["Effect", request.effectID],
    ["Run", request.runID ?? "unavailable"],
    ["Session", request.sessionID ?? "unavailable"],
    ["Scope", request.capabilityID.startsWith("automations.") ? "authenticated workspace-owner action" : request.runID ? "managed run" : "session"],
    ["Location", request.locationID],
    ...targets.map((target) => ["", target]),
    ["Origin", request.origin ?? "unavailable"],
    ["Source", request.source ?? "unavailable"],
    ["Policy", request.policyID ?? "unavailable"],
    ["Policy digest", request.policyDigest ?? "unavailable"],
    ["Policy summary", clean(request.policySummary) || "unavailable"],
    ["Arguments", argument?.status === "available" ? clean(argument.text) : `argument summary unavailable${argument?.status === "unavailable" ? ` (${clean(argument.reason)})` : ""}`],
    ["Input digest", request.inputDigest],
    ["Requested guarantees", request.requestedGuarantees?.map(clean).join(", ") || "unavailable"],
    ["Residual guarantees", assessment?.status === "assessed" ? assessment.residual.map(clean).join(", ") || "none remain after assessment" : "residual guarantee assessment not available"],
    ["Expires", Number.isFinite(request.expiresAtUnixMs) && Math.abs(request.expiresAtUnixMs) <= 8.64e15 ? new Date(request.expiresAtUnixMs).toISOString() : "unavailable"],
    ["No response", request.noResponse === "deny_and_expire" ? "denies and expires at deadline" : "unavailable"],
  ]
  return values.flatMap(([label, raw]) => {
    const text = label ? `${label}: ${clean(raw)}` : clean(raw)
    const rows: string[] = []
    for (let offset = 0; offset < text.length; offset += DETAIL_WIDTH) {
      rows.push(`${offset === 0 ? "" : "  "}${text.slice(offset, offset + DETAIL_WIDTH)}`)
    }
    return rows
  })
}

export function DialogGuardApproval(props: DialogGuardApprovalProps) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [page, setPage] = createSignal(0)
  const request = () => props.request
  const canAllow = createMemo(() => allowEligible(request()))
  const canGrant = createMemo(() => grantEligible(request()))
  const pages = createMemo(() => {
    const lines = detailLines(request())
    return Math.max(1, Math.ceil(lines.length / DETAIL_PAGE_SIZE))
  })
  const options = createMemo<DialogSelectOption<MenuAction>[]>(() => [
    {
      title: `Review request details · page ${page() + 1} of ${pages()}`,
      value: "details",
      description: "Review the host-projected action, resources, policy, guarantees and expiry.",
      details: detailLines(request()).slice(page() * DETAIL_PAGE_SIZE, (page() + 1) * DETAIL_PAGE_SIZE),
    },
    {
      title: page() === 0 ? "First details page" : "Previous details page",
      value: "previous",
      disabled: busy() || page() === 0,
      description: page() === 0 ? "There is no earlier details page." : "Show the previous consent context.",
    },
    {
      title: page() + 1 >= pages() ? "Last details page" : "Next details page",
      value: "next",
      disabled: busy() || page() + 1 >= pages(),
      description: page() + 1 >= pages() ? "There are no more details pages." : "Show the next consent context.",
    },
    {
      title: canAllow() ? "Allow this effect once" : "Allow unavailable",
      value: "allow_once",
      // Disabled options are removed from DialogSelect's keyboard traversal.
      // Keep the unavailable detail visible on the first page, but make the
      // deny-only state impossible to select even through keyboard input.
      disabled: busy() || !canAllow(),
      description: canAllow()
        ? "Approve this exact host-minted effect for one use."
        : "Host consent context is incomplete or its guarantees were not assessed.",
    },
    {
      title: "Deny (default)",
      value: "deny",
      disabled: busy(),
      description: error() || "Deny this exact request. No response before expiry also denies and expires it.",
    },
    {
      title: canGrant() ? "Allow supported edits in this Session" : "Session grant unavailable",
      value: "grant_session",
      disabled: busy() || !canGrant(),
      description: "Save explicit consent for supported workspace edits in this Session. This current effect is denied and must be prepared again.",
    },
    {
      title: canGrant() ? "Remember supported edits for this workspace" : "Workspace grant unavailable",
      value: "grant_workspace",
      disabled: busy() || !canGrant(),
      description: "Save explicit consent for supported workspace edits for up to 30 days. This current effect is denied and must be prepared again.",
    },
  ])

  async function decide(decision: Action) {
    if (busy() || (decision === "allow_once" && !canAllow()) ||
      ((decision === "grant_session" || decision === "grant_workspace") && !canGrant())) return
    setBusy(true)
    setError("")
    try {
      await props.onDecision(decision)
      dialog.clear()
    } catch {
      setError("The decision was not confirmed. This request remains fail-closed; deny it or let it expire.")
      setBusy(false)
    }
  }

  return (
    <DialogSelect
      title="Guard approval · Review exact effect"
      options={options()}
      current="deny"
      renderFilter={false}
      locked={busy()}
      footer={
        <text>
          <span>
            {error() ||
              `Approval ${clean(request().approvalID)} · challenge ${clean(request().challengeID)}. No response before expiry denies and expires the challenge.`}
          </span>
        </text>
      }
      onSelect={(option) => {
        if (option.value === "previous" && page() > 0) setPage(page() - 1)
        if (option.value === "next" && page() + 1 < pages()) setPage(page() + 1)
        if (option.value === "allow_once" || option.value === "deny") void decide(option.value)
      }}
    />
  )
}
