import type { ChildProcess } from "node:child_process"

export class ProcessUnavailableError extends Error {
  readonly _tag = "ProcessUnavailableError"
  constructor() {
    super("HorizonCode SDK process launch is unavailable until HostKernel Guard and ExecutionHost mediate it")
    this.name = "ProcessUnavailableError"
  }
}

export function processUnavailable(): never {
  throw new ProcessUnavailableError()
}

// Duplicated from `packages/horizoncode/src/util/process.ts` because the SDK cannot
// import `opencode` without creating a cycle (`opencode` depends on `@horizoncode/sdk`).
export function stop(proc: ChildProcess) {
  // No SDK-owned child can be created while the launch APIs are unavailable.
  // Do not expose an unmediated general child-process kill fallback.
  void proc
}

export function bindAbort(proc: ChildProcess, signal?: AbortSignal, onAbort?: () => void) {
  void proc
  void signal
  void onAbort
  return () => {}
}
