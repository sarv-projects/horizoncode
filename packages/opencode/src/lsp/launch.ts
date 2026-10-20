/**
 * Language-service process control is an effect (§30.14, §33.23, §37.6). Core has no
 * direct process API here: it may request a logical HostKernel profile only after the
 * typed Guard/ExecutionHost route is implemented and verified. Until then all lifecycle
 * operations fail closed.
 */
export type LanguageServiceProcessOperation =
  | "server.spawn"
  | "server.install"
  | "server.restart"
  | "server.stop"
  | "server.probe"

export type LanguageServiceProcessReason = "guard_not_verified"

export class LanguageServiceProcessError extends Error {
  readonly _tag = "LanguageServiceProcessError"
  readonly operation: LanguageServiceProcessOperation
  readonly reason: LanguageServiceProcessReason = "guard_not_verified"
  constructor(operation: LanguageServiceProcessOperation) {
    super(
      `Language-service process effect ${operation} is unavailable: the canonical Guard/ExecutionHost route is not registered`,
    )
    this.name = "LanguageServiceProcessError"
    this.operation = operation
  }
}

/** True only when the single HostKernel-backed route is integrated and verified. */
export function languageServiceProcessRouteAvailable(): boolean {
  return false
}

/** Fail-closed gate for every language-service process effect. */
export function assertLanguageServiceProcessAllowed(operation: LanguageServiceProcessOperation): void {
  if (!languageServiceProcessRouteAvailable()) throw new LanguageServiceProcessError(operation)
}

/** Stable terminal refusal used by registry entries while no HostKernel launcher exists. */
export function refuseLanguageServiceProcess(operation: LanguageServiceProcessOperation): never {
  throw new LanguageServiceProcessError(operation)
}
