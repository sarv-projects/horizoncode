/** Read/cancel adapters for a HostKernel-owned interpreter process.
 *
 * This module does not start a worker, write interpreter input, execute code,
 * reset state, or invoke callbacks. Interpreter start remains denied by the
 * HostKernel while OS resource guarantees are unavailable, and execute/reset
 * have no accepted per-operation DTO yet.
 */

import type {
  EditorProcessOutputPageV1,
  EditorProcessStatusV1,
  RequestExecutionHostV1,
} from "@/lsp/process-lifecycle"
import {
  cancelEditorProcessV1,
  readEditorProcessOutputV1,
  readEditorProcessStatusV1,
} from "@/lsp/process-lifecycle"
import {
  validateHostProcessRef,
  validateHostProcessScope,
  type HostProcessRefV1,
} from "@/lsp/process-scope"
import type {
  Ref,
  Registry,
  ReplAuthorityBinding,
  ReplSession,
} from "./lifecycle"

export class ReplProcessUnavailableError extends Error {
  readonly _tag = "ReplProcessUnavailableError"
  constructor(message: string) {
    super(message)
    this.name = "ReplProcessUnavailableError"
  }
}

type RegistryRecovery = Pick<Registry, "requireScopeOwned">

function processScope(session: ReplSession) {
  return Object.freeze({
    sessionID: session.sessionID,
    locationID: session.locationID,
    workspaceRevision: session.workspaceRevision,
    ...(session.directAttemptScope === undefined ? {} : { workspaceID: session.workspaceId }),
    ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: session.managedAttemptScope }),
    ...(session.directAttemptScope === undefined ? {} : { directAttempt: session.directAttemptScope }),
  })
}

function processForSession(session: ReplSession, input: HostProcessRefV1): HostProcessRefV1 {
  const processRef = validateHostProcessRef(input)
  if (
    processRef.kind !== "interpreter" ||
    processRef.ownerEpoch !== session.ownerEpoch ||
    processRef.profileID !== session.launchProfileRef.profileId ||
    processRef.profileRevision !== session.launchProfileRef.revision ||
    processRef.profileDigest !== session.launchProfileRef.profileDigest
  ) {
    throw new TypeError("HostKernel interpreter reference does not match the authenticated REPL generation and profile")
  }
  validateHostProcessScope({
    sessionID: session.sessionID,
    locationID: session.locationID,
    ownerEpoch: session.ownerEpoch,
    workspaceRevision: session.workspaceRevision,
    managedAttemptScope: session.managedAttemptScope,
    directAttemptScope: session.directAttemptScope,
    workspaceID: session.workspaceId,
  })
  return Object.freeze({ ...processRef })
}

function requireResourceGuarantees(status: EditorProcessStatusV1): void {
  const guarantees = status.resourceGuarantees
  if (
    !guarantees ||
    guarantees.cpuTimeEnforced !== true ||
    guarantees.memoryEnforced !== true ||
    guarantees.processCountEnforced !== true ||
    guarantees.fileDescriptorsEnforced !== true
  ) {
    throw new ReplProcessUnavailableError(
      "interpreter output is unavailable because HostKernel did not confirm every required OS resource limit",
    )
  }
}

/** Reconcile an exact worker execution after a lost response/restart. The
 * HostKernel may return only the process identity it retained for this owner. */
export async function readSupervisedReplStatusV1(input: {
  readonly registry: RegistryRecovery
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly processRef: HostProcessRefV1
  readonly effectID: string
  readonly challengeID: string
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<EditorProcessStatusV1> {
  const session = input.registry.requireScopeOwned(input.ref, input.authority)
  const processRef = processForSession(session, input.processRef)
  const status = await readEditorProcessStatusV1({
    executionID: processRef.executionID,
    effectID: input.effectID,
    challengeID: input.challengeID,
    scope: processScope(session),
    expectedProcessRef: processRef,
    requestHostKernel: input.requestHostKernel,
  })
  if (status.hostProcessRef && validateHostProcessRef(status.hostProcessRef).kind !== "interpreter") {
    throw new TypeError("HostKernel returned a non-interpreter process for the REPL execution")
  }
  if (status.state === "RUNNING" || status.state === "CANCELLING") requireResourceGuarantees(status)
  return status
}

/** Read one bounded output page from the exact authenticated interpreter.
 * This does not decode or dispatch REPL callbacks. */
export async function readSupervisedReplOutputV1(input: {
  readonly registry: RegistryRecovery
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly processRef: HostProcessRefV1
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityLeaseDigest: string
  readonly afterStdoutSequence: string
  readonly afterStderrSequence: string
  readonly maxBytes: number
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<EditorProcessOutputPageV1> {
  const session = input.registry.requireScopeOwned(input.ref, input.authority)
  const processRef = processForSession(session, input.processRef)
  const status = await readEditorProcessStatusV1({
    executionID: processRef.executionID,
    effectID: input.effectID,
    challengeID: input.challengeID,
    scope: processScope(session),
    expectedProcessRef: processRef,
    requestHostKernel: input.requestHostKernel,
  })
  requireResourceGuarantees(status)
  return readEditorProcessOutputV1({
    processRef,
    effectID: input.effectID,
    challengeID: input.challengeID,
    capabilityLeaseDigest: input.capabilityLeaseDigest,
    scope: processScope(session),
    afterStdoutSequence: input.afterStdoutSequence,
    afterStderrSequence: input.afterStderrSequence,
    maxBytes: input.maxBytes,
    requestHostKernel: input.requestHostKernel,
  })
}

/** Cancel only this retained interpreter generation under its original
 * launch lease. An unknown result is left for the caller to quarantine. */
export async function cancelSupervisedReplV1(input: {
  readonly registry: RegistryRecovery
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly processRef: HostProcessRefV1
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityLeaseDigest: string
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<EditorProcessStatusV1> {
  const session = input.registry.requireScopeOwned(input.ref, input.authority)
  const processRef = processForSession(session, input.processRef)
  return cancelEditorProcessV1({
    processRef,
    effectID: input.effectID,
    challengeID: input.challengeID,
    capabilityLeaseDigest: input.capabilityLeaseDigest,
    scope: processScope(session),
    requestHostKernel: input.requestHostKernel,
  })
}
