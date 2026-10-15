/**
 * In-process first-party write provenance for the current trusted Core host.
 * A Location registration's ID/name alone cannot claim files.write.
 *
 * Not a sandbox/security boundary against arbitrary hostile JavaScript inside
 * this process: executable plugins must remain untrusted/unavailable until
 * isolated and mediated by the Rust Guard/ExecutionHost.
 */
import type { AnyTool } from "./tool"

const builtinWrites = new WeakSet<AnyTool>()

/** Called only by the first-party write leaf after constructing its tool. */
export const markBuiltinWrite = (tool: AnyTool): void => {
  builtinWrites.add(tool)
}

export const isBuiltinWrite = (tool: AnyTool): boolean => builtinWrites.has(tool)
