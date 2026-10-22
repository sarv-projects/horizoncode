import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

export function spawn(_file: string, _args: string[], _opts: Opts): Proc {
  throw new Error("Direct Bun PTY spawning is unavailable; use the Guarded HostKernel terminal service")
}
