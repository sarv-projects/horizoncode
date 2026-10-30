import type { WorkspaceAdapter } from "../types"

/**
 * The project's own directory as a first-class workspace.
 *
 * Every direct Session must be workspace-bound: HostKernel refuses direct-session
 * effects and permission-mode snapshots for a Location that carries no workspace.
 * A default local install has no worktree workspace, so this adapter supplies the
 * local binding without creating, moving, or deleting anything on disk.
 */
export const LocalAdapter: WorkspaceAdapter = {
  name: "Local",
  description: "Use the project directory directly",
  configure(info, context) {
    const directory = info.directory ?? context?.instance?.directory
    if (!directory) throw new Error("Local workspace requires a directory")
    return { ...info, name: info.name || "Local", branch: null, directory }
  },
  async create() {
    // Nothing to create: the project directory already exists.
  },
  list() {
    return []
  },
  async remove() {
    // Never delete or move the project directory for a local workspace.
  },
  target(info, context) {
    const directory = info.directory ?? context?.instance?.directory
    if (!directory) throw new Error("Local workspace requires a directory")
    return { type: "local", directory }
  },
}
