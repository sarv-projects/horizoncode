// Applies the CLI `--auto` / `--yolo` intent through the authoritative
// HostKernel-owned direct Session posture instead of only answering
// `permission.asked` events on the client.
//
// `GET|PATCH /config/direct-session-permission-mode?sessionID=...` is the one
// transport the TUI `/permissions` dialog already uses
// (`sdk.client.config.directSessionPermissionMode` /
// `updateDirectSessionPermissionMode`). Nothing else is invented here: the PATCH
// is a compare-and-set against the HostKernel revision and never dispatches an
// effect or grants an approval.
//
// Failures (missing route, non-200, revision conflict) are surfaced as one
// warning line and reported as `applied: false` so the caller can keep the
// client-side auto-replier as a fallback. This module never throws.
import { UI } from "../ui"

export type DirectSandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type DirectApprovalPolicy = "on-request" | "always" | "never"

export interface DirectSessionPermissionModeUpdate {
  sandboxMode: DirectSandboxMode
  approvalPolicy: DirectApprovalPolicy
  expectedRevision: string
}

export interface DirectSessionPermissionModeQuery {
  sessionID: string
  workspace?: string
}

/** The slice of the generated SDK response this module reads. */
export interface DirectModeOutcome {
  data?: unknown
  error?: unknown
  response?: { status?: number } | undefined
}

/**
 * Structural subset of `OpencodeClient` that the apply path needs. Keeping it
 * narrow lets tests stub the transport without a server or network.
 */
export interface DirectModeClient {
  config: {
    directSessionPermissionMode(
      parameters: DirectSessionPermissionModeQuery,
      options?: { throwOnError?: boolean },
    ): Promise<DirectModeOutcome>
    updateDirectSessionPermissionMode(
      parameters: DirectSessionPermissionModeQuery & {
        directSessionPermissionModeUpdateV1: DirectSessionPermissionModeUpdate
      },
      options?: { throwOnError?: boolean },
    ): Promise<DirectModeOutcome>
  }
}

export interface ApplyDirectPermissionModeInput {
  client: DirectModeClient
  sessionID: string
  sandboxMode: DirectSandboxMode
  approvalPolicy: DirectApprovalPolicy
  workspace?: string
  /** Human label for the log line; derived from the posture when omitted. */
  label?: "yolo" | "auto"
  /** Receives exactly one line: the applied posture or the warning. */
  log?: (line: string) => void
}

export interface ApplyDirectPermissionModeResult {
  applied: boolean
  reason?: string
  revision?: string
}

const REVISION = /^[1-9][0-9]{0,19}$/

function modeLabel(input: { sandboxMode: DirectSandboxMode; label?: "yolo" | "auto" }) {
  return input.label ?? (input.sandboxMode === "danger-full-access" ? "yolo" : "auto")
}

export function formatDirectPermissionModeLine(input: {
  sandboxMode: DirectSandboxMode
  approvalPolicy: DirectApprovalPolicy
  label?: "yolo" | "auto"
}) {
  return `permission mode: ${input.sandboxMode} \u00b7 ${input.approvalPolicy} (${modeLabel(input)})`
}

function revisionOf(data: unknown) {
  if (!data || typeof data !== "object") return undefined
  const revision = (data as { revision?: unknown }).revision
  return typeof revision === "string" && REVISION.test(revision) ? revision : undefined
}

function statusOf(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as { status?: unknown; response?: { status?: unknown }; cause?: { status?: unknown } }
  for (const candidate of [record.status, record.response?.status, record.cause?.status]) {
    if (typeof candidate === "number") return candidate
  }
  return undefined
}

function messageOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    return text ? text : undefined
  }
  if (value instanceof Error) {
    const text = value.message.trim()
    return text ? text : undefined
  }
  if (value && typeof value === "object") {
    const record = value as {
      message?: unknown
      name?: unknown
      data?: { message?: unknown }
    }
    for (const candidate of [record.message, record.data?.message, record.name]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
    }
  }
  return undefined
}

function describe(status: number | undefined, message: string | undefined) {
  if (status === undefined) return message ?? "no response from the server"
  return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`
}

type Attempt =
  | { ok: true; revision: string }
  | { ok: false; reason: string; status?: number; conflict: boolean }

async function attempt(call: () => Promise<DirectModeOutcome>): Promise<Attempt> {
  let outcome: DirectModeOutcome
  try {
    outcome = await call()
  } catch (error) {
    const status = statusOf(error)
    const message = messageOf(error)
    return {
      ok: false,
      status,
      conflict: status === 409 || /conflict/i.test(message ?? ""),
      reason: describe(status, message),
    }
  }

  const status = outcome?.response?.status
  if (outcome?.data !== undefined && outcome?.data !== null) {
    const revision = revisionOf(outcome.data)
    if (revision) return { ok: true, revision }
    return {
      ok: false,
      status,
      conflict: false,
      reason: describe(status, "response did not include a direct Session permission revision"),
    }
  }

  const message = messageOf(outcome?.error)
  return {
    ok: false,
    status,
    conflict: status === 409 || /conflict/i.test(message ?? ""),
    reason: describe(status, message),
  }
}

/**
 * Compare-and-set the HostKernel direct Session posture. Reads the current
 * revision, PATCHes the requested posture, and retries once after re-reading when
 * the authority reports a revision conflict. Never throws: every failure becomes
 * `{ applied: false, reason }` plus the single warning line.
 */
export async function applyDirectPermissionMode(
  input: ApplyDirectPermissionModeInput,
): Promise<ApplyDirectPermissionModeResult> {
  const log = input.log ?? ((line: string) => UI.println(line))
  const line = formatDirectPermissionModeLine(input)
  const warn = (reason: string): ApplyDirectPermissionModeResult => {
    log(`${line} was not applied \u2014 ${reason}; keeping the client-side auto-approval fallback`)
    return { applied: false, reason }
  }

  const query: DirectSessionPermissionModeQuery = {
    sessionID: input.sessionID,
    ...(input.workspace ? { workspace: input.workspace } : {}),
  }
  const update = (expectedRevision: string) =>
    input.client.config.updateDirectSessionPermissionMode(
      {
        ...query,
        directSessionPermissionModeUpdateV1: {
          sandboxMode: input.sandboxMode,
          approvalPolicy: input.approvalPolicy,
          expectedRevision,
        },
      },
      { throwOnError: false },
    )
  const read = () => input.client.config.directSessionPermissionMode(query, { throwOnError: false })

  const current = await attempt(read)
  if (!current.ok) return warn(`could not read the current posture (${current.reason})`)

  let updated = await attempt(() => update(current.revision))
  if (!updated.ok && updated.conflict) {
    const reread = await attempt(read)
    if (!reread.ok) return warn(`revision conflict and the re-read failed (${reread.reason})`)
    updated = await attempt(() => update(reread.revision))
  }
  if (!updated.ok) return warn(updated.reason)

  log(line)
  return { applied: true, revision: updated.revision }
}
