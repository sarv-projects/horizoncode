import path from "path"

const bySession = new Map<string, Set<string>>()

function trackerKey(sessionID: string, filePath: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot)
  const resolved = path.resolve(root, filePath)
  return `${sessionID}\0${resolved}`
}

export function mark(sessionID: string, filePath: string, workspaceRoot: string): void {
  if (!sessionID || !filePath) return
  let set = bySession.get(sessionID)
  if (!set) {
    set = new Set()
    bySession.set(sessionID, set)
  }
  set.add(trackerKey(sessionID, filePath, workspaceRoot))
}

export function hasSeen(sessionID: string, filePath: string, workspaceRoot: string): boolean {
  const set = bySession.get(sessionID)
  if (!set) return false
  return set.has(trackerKey(sessionID, filePath, workspaceRoot))
}

export function assertSeen(sessionID: string, filePath: string, workspaceRoot: string): void {
  if (hasSeen(sessionID, filePath, workspaceRoot)) return
  throw new Error(
    `Edit denied: read the file with the Read tool before editing (${path.basename(filePath)}). The edit tool requires an up-to-date view of file contents.`,
  )
}

/** Namespace import for tools (`import { FileReadTracker } from ...`). */
export const FileReadTracker = {
  mark,
  hasSeen,
  assertSeen,
  resetForTests(sessionID?: string): void {
    if (sessionID) bySession.delete(sessionID)
    else bySession.clear()
  },
}
