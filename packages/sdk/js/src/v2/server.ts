import { processUnavailable } from "../process.js"

export type ServerOptions = {
  hostname?: string
  port?: number
  signal?: AbortSignal
  timeout?: number
  config?: import("./gen/types.gen.js").Config
}

export type TuiOptions = {
  project?: string
  model?: string
  session?: string
  agent?: string
  signal?: AbortSignal
  config?: import("./gen/types.gen.js").Config
}

export type ServerHandle = { url: string; close(): void }
export type TuiHandle = { close(): void }

/**
 * Launching a detached HorizonCode CLI from an SDK call is a process
 * effect. V1 has no Guard/ExecutionHost bootstrap operation for SDK consumers,
 * so reject before executable lookup or process creation.
 */
export async function createOpencodeServer(_options?: ServerOptions): Promise<ServerHandle> {
  return processUnavailable()
}

/** See `createOpencodeServer`; the SDK TUI launcher is likewise unavailable. */
export function createOpencodeTui(_options?: TuiOptions): TuiHandle {
  return processUnavailable()
}
