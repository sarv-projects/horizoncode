import { fail } from "../effect-cmd"

/**
 * Legacy GitHub automation reads credentials, contacts GitHub, mutates repository
 * files, and can cause child work to run. Keep both entry points unavailable until
 * every effect is admitted and executed by Guard/ExecutionHost.
 */
const unavailable = "GitHub automation is unavailable until guarded execution is implemented"

export const githubInstall = () => fail(unavailable)

export const githubRun = (_args: { event?: string; token?: string }) => fail(unavailable)
