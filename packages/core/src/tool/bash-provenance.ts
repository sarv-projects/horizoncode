/** In-process first-party provenance for the guarded terminal.run leaf. */
import type { AnyTool } from "./tool"

const builtinBash = new WeakSet<AnyTool>()

/** Closed until P1 terminal profile/lease/receipt acceptance is recorded. */
export const GUARDED_TERMINAL_RUN_READY = false

/** Called only by the first-party Bash module after constructing its tool. */
export const markBuiltinBash = (tool: AnyTool): void => {
  builtinBash.add(tool)
}

export const isBuiltinBash = (tool: AnyTool): boolean => builtinBash.has(tool)
