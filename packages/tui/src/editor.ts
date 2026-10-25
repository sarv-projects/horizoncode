import type { CliRenderer } from "@opentui/core"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveZedDbPath, resolveZedSelection } from "./editor-zed"

export function normalizePromptContent(content: string) {
  if (content.endsWith("\r\n")) {
    const body = content.slice(0, -2)
    return !body.includes("\n") && !body.includes("\r") ? body : content
  }

  if (content.endsWith("\n")) {
    const body = content.slice(0, -1)
    return !body.includes("\n") && !body.includes("\r") ? body : content
  }

  return content
}

export async function openEditor(_input: { value: string; renderer: CliRenderer; cwd?: string; stdin?: unknown }) {
  // `$EDITOR` is an arbitrary executable and the upstream Windows path used a
  // shell. Refuse before creating a temp file, suspending the TUI, resolving the
  // command, or starting a process. V1 has no Guarded editor-launch DTO.
  return undefined
}

export type SavedEditorSelection = {
  readonly profileId: string
  readonly revision: string
  readonly profileDigest: string
}

export type WorkspaceEditorOpenOutcome =
  | {
      readonly status: "unavailable"
      readonly reason: "no_profile" | "host_route_unavailable"
      readonly message: string
    }
  | {
      readonly status: "rejected"
      readonly reason: "invalid_target" | "invalid_profile"
      readonly message: string
    }

const BLAKE3 = /^blake3:[0-9a-f]{64}$/
const PROFILE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const U64 = /^[1-9][0-9]{0,19}$/
const MAX_U64 = 18_446_744_073_709_551_615n

function validProfileRevision(value: string) {
  return U64.test(value) && BigInt(value) <= MAX_U64
}

/**
 * Decide whether `/editor` can open one Explorer-selected workspace file.
 *
 * The TUI never constructs argv or starts a process. HostKernel launch is
 * P1/P2-owned and not routed yet, so a valid selection returns a typed
 * `host_route_unavailable` outcome and the caller must not fake success. The
 * check lives here (not in a component) so the overlay and tests share the
 * same fail-closed rule and no model/caller input can widen it.
 */
export function workspaceEditorOpenRequest(input: {
  readonly selection: SavedEditorSelection | null
  readonly profiles: readonly SavedEditorSelection[]
  readonly pathRef: string
  readonly sourceRevision: string
  readonly contentDigest: string
}): WorkspaceEditorOpenOutcome {
  if (!input.selection) {
    return {
      status: "unavailable",
      reason: "no_profile",
      message: "Choose an external editor profile in Settings before opening workspace files.",
    }
  }
  if (
    !PROFILE_ID.test(input.selection.profileId) ||
    !validProfileRevision(input.selection.revision) ||
    !BLAKE3.test(input.selection.profileDigest)
  ) {
    return {
      status: "rejected",
      reason: "invalid_profile",
      message: "The saved external editor profile is malformed. Re-select it in Settings.",
    }
  }
  if (!input.profiles.some((profile) =>
    profile.profileId === input.selection?.profileId &&
    profile.revision === input.selection.revision &&
    profile.profileDigest === input.selection.profileDigest,
  )) {
    return {
      status: "rejected",
      reason: "invalid_profile",
      message: "The selected external editor profile is not in saved Core Config. Re-select it in Settings.",
    }
  }
  const segments = input.pathRef.split("/")
  if (
    !input.pathRef ||
    input.pathRef.length > 4096 ||
    input.pathRef.startsWith("/") ||
    input.pathRef.includes("\\") ||
    segments.some((part) => part === "" || part === "." || part === "..") ||
    [...input.pathRef].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f) ||
    !BLAKE3.test(input.sourceRevision) ||
    !BLAKE3.test(input.contentDigest)
  ) {
    return {
      status: "rejected",
      reason: "invalid_target",
      message: "The Explorer preview is stale or escaped the workspace. Re-open the file before launching an editor.",
    }
  }
  // Constant until the HostKernel editor.launch route and P1 containment/
  // receipt acceptance are integrated; no process may be started from the TUI.
  return {
    status: "unavailable",
    reason: "host_route_unavailable",
    message: "Workspace editor launch is unavailable until HostKernel editor containment and receipts pass acceptance. No process was started.",
  }
}


export function discoverEditorConnection(directory: string) {
  const root = path.join(os.homedir(), ".claude", "ide")
  const contains = (parent: string) => {
    const resolved = path.resolve(parent)
    const relative = path.relative(resolved, path.resolve(directory))
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved.length : 0
  }
  try {
    return readdirSync(root)
      .filter((entry) => entry.endsWith(".lock"))
      .flatMap((entry) => {
        const file = path.join(root, entry)
        const port = Number.parseInt(path.basename(file, ".lock"), 10)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return []
        try {
          const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
          if (value.transport !== undefined && value.transport !== "ws") return []
          const folders = Array.isArray(value.workspaceFolders)
            ? value.workspaceFolders.filter((item): item is string => typeof item === "string")
            : []
          const score = Math.max(0, ...folders.map(contains))
          if (!score) return []
          return [
            {
              url: `ws://127.0.0.1:${port}`,
              authToken: typeof value.authToken === "string" ? value.authToken : undefined,
              source: `lock:${port}`,
              score,
              mtime: statSync(file).mtimeMs,
            },
          ]
        } catch {
          return []
        }
      })
      .sort((left, right) => right.score - left.score || right.mtime - left.mtime)
      .map(({ url, authToken, source }) => ({ url, authToken, source }))[0]
  } catch {
    return undefined
  }
}

export const editorIntegration = {
  connection: discoverEditorConnection,
  selection: (directory: string) => resolveZedSelection(resolveZedDbPath() ?? "", directory),
}
