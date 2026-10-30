/** HorizonCode minimal, non-blocking MCP trust record.
 *
 * Project-owned configuration can introduce an MCP server (a local command or a
 * remote origin). Neither is started until the user records an explicit,
 * per-project approval bound to that exact server identity. Approvals live in
 * the user global data directory, never in the project that they govern, so a
 * repository cannot approve itself. A changed command, cwd, environment, URL or
 * header set changes the binding and invalidates any earlier approval.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { serverBinding, type ServerBinding } from "@horizoncode/core/config/mcp"

export const MCP_TRUST_FILE = "mcp-trust.json"

const MAX_FILE_BYTES = 512 * 1024
const MAX_APPROVALS = 200
const MAX_FIELD = 512

export interface TrustApproval {
  readonly directory: string
  readonly server: string
  readonly binding: string
  readonly approvedAt: string
}

export type McpTrustDecision =
  | { readonly status: "trusted"; readonly reason: "global_config" | "approved" | "permission_rule" }
  | {
    readonly status: "untrusted"
    readonly reason: "project_config" | "project_override" | "approval_mismatch" | "denied_by_rule"
    /** Digest only; the raw canonical binding is never exposed. */
    readonly binding: string
    readonly message: string
  }

export function trustFilePath(dataDirectory: string) {
  return path.join(dataDirectory, MCP_TRUST_FILE)
}

/** Digest of the exact server identity. SHA-256 over the canonical binding. */
export function bindingDigest(entry: ServerBinding): string {
  return createHash("sha256").update(serverBinding(entry)).digest("hex")
}

function validApproval(value: unknown): value is TrustApproval {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return ["directory", "server", "binding", "approvedAt"].every((key) =>
    typeof record[key] === "string" && (record[key] as string).length > 0 && (record[key] as string).length <= MAX_FIELD)
}

/**
 * Fail-closed read. A missing, oversized, malformed or unreadable record yields
 * no approvals at all, so a corrupt file can never silently trust a server.
 */
export async function readTrustApprovals(file: string): Promise<TrustApproval[]> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return []
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown
    if (!parsed || typeof parsed !== "object") return []
    const record = parsed as Record<string, unknown>
    if (record.version !== 1 || !Array.isArray(record.approvals)) return []
    return record.approvals.filter(validApproval).slice(-MAX_APPROVALS)
  } catch {
    return []
  }
}

async function writeApprovals(file: string, approvals: readonly TrustApproval[]) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  const body = JSON.stringify({ version: 1, approvals: approvals.slice(-MAX_APPROVALS) })
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, file)
}

export async function approveServer(input: {
  file: string
  directory: string
  server: string
  binding: string
  now?: number
}) {
  if (!input.server || input.server.length > MAX_FIELD) throw new Error("MCP server name is invalid")
  const existing = (await readTrustApprovals(input.file)).filter(
    (entry) => !(entry.directory === input.directory && entry.server === input.server))
  existing.push({
    directory: input.directory,
    server: input.server,
    binding: input.binding,
    approvedAt: new Date(input.now ?? Date.now()).toISOString(),
  })
  await writeApprovals(input.file, existing)
}

export async function revokeServer(input: { file: string; directory: string; server: string }) {
  const existing = (await readTrustApprovals(input.file)).filter(
    (entry) => !(entry.directory === input.directory && entry.server === input.server))
  await writeApprovals(input.file, existing)
}

/**
 * Pure trust decision for one configured server.
 *
 * Precedence: an explicit deny permission rule wins over everything; an
 * explicit allow rule is the user speaking for this project; otherwise a
 * server whose identity matches the user global configuration is trusted, and
 * anything project-introduced or project-overridden needs a matching approval.
 */
export function decideTrust(input: {
  server: string
  entry: ServerBinding
  globalEntry?: ServerBinding
  directory: string
  approvals: readonly TrustApproval[]
  rule: "allow" | "deny" | "ask"
}): McpTrustDecision {
  const binding = bindingDigest(input.entry)
  if (input.rule === "deny") {
    return {
      status: "untrusted",
      reason: "denied_by_rule",
      binding,
      message: "an explicit MCP permission rule denies this server",
    }
  }
  if (input.rule === "allow") return { status: "trusted", reason: "permission_rule" }
  if (input.globalEntry && bindingDigest(input.globalEntry) === binding) {
    return { status: "trusted", reason: "global_config" }
  }
  const approval = input.approvals.find(
    (entry) => entry.directory === input.directory && entry.server === input.server)
  if (approval && approval.binding === binding) return { status: "trusted", reason: "approved" }
  if (input.globalEntry) {
    return {
      status: "untrusted",
      reason: "project_override",
      binding,
      message: "project configuration overrides the user global server; approve the exact project definition",
    }
  }
  if (approval) {
    return {
      status: "untrusted",
      reason: "approval_mismatch",
      binding,
      message: "the project server definition changed since it was approved; approve the exact definition",
    }
  }
  return {
    status: "untrusted",
    reason: "project_config",
    binding,
    message: "project configuration introduced this server and the user has not approved it",
  }
}
