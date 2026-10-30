/** Core adapter from protocol clients to SessionSupervisor's shared Guard owner. */

import { Effect } from "effect"
import { Location } from "@horizoncode/schema"
import type {
  EditorProtocolAuthorizationLeaseV1,
  EditorProtocolAuthorizationRequestV1,
  Interface as SessionSupervisorInterface,
  SessionSupervisorError,
} from "@horizoncode/core/session/supervisor"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  sameDirectAttemptScope,
  sameManagedAttemptScope,
  validateHostProcessRef,
  validateHostProcessScope,
} from "./process-scope"

type RunTrustedEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

type ProtocolGuardLeaseV1 = {
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: string
  readonly capabilityLeaseDigest: string
}

type ProtocolAuthorizationInputV1 = {
  readonly capabilityID: string
  readonly authorization: Readonly<Record<string, unknown>>
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly kind?: "operation" | "callback_reply"
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Construct the exact callback expected by the LSP and DAP HostKernel clients.
 * The supplied runner must be the trusted application Effect runtime so
 * SessionSupervisor obtains ServerAuth itself; this helper accepts no
 * principal or owner identity from protocol input.
 */
export function makeEditorProtocolGuardAuthorizerV1(input: {
  readonly supervisor: Pick<SessionSupervisorInterface, "authorizeEditorProtocolOperation">
  readonly locationRef: typeof Location.Ref.Type
  readonly sessionID: string
  readonly locationID: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly runTrustedEffect: RunTrustedEffect
}): (request: ProtocolAuthorizationInputV1) => Promise<ProtocolGuardLeaseV1> {
  if (input.managedAttempt !== undefined && input.directAttempt !== undefined) {
    throw new TypeError("editor protocol Guard adapter cannot combine managed and direct Attempt scopes")
  }
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(input.sessionID) || !/^[A-Za-z0-9._-]{1,256}$/.test(input.locationID)) {
    throw new TypeError("editor protocol Guard adapter sessionID is invalid")
  }
  const managedAttempt = input.managedAttempt === undefined ? undefined : Object.freeze({ ...input.managedAttempt })
  const directAttempt = input.directAttempt === undefined ? undefined : Object.freeze({ ...input.directAttempt })

  return async (request) => {
    if ((request.managedAttempt !== undefined && request.directAttempt !== undefined) ||
        !sameManagedAttemptScope(request.managedAttempt, managedAttempt) ||
        !sameDirectAttemptScope(request.directAttempt, directAttempt)) {
      throw new TypeError("protocol operation Attempt scope differs from its authenticated Core binding")
    }
    if (request.capabilityID.length === 0 || request.capabilityID.length > 160 || /[\0\s]/.test(request.capabilityID)) {
      throw new TypeError("protocol operation has an invalid canonical capability ID")
    }
    const authorization = request.authorization
    if (!record(authorization) || authorization.sessionID !== input.sessionID ||
        authorization.locationID !== input.locationID ||
        authorization.protocol !== "lsp" && authorization.protocol !== "dap") {
      throw new TypeError("protocol operation does not match its authenticated Session and Location")
    }
    const processRef = validateHostProcessRef(authorization.hostProcessRef)
    const expectedKind = authorization.protocol === "lsp" ? "language_server" : "debug_adapter"
    if (processRef.kind !== expectedKind ||
        ((managedAttempt !== undefined || directAttempt !== undefined) &&
          processRef.ownerEpoch !== (managedAttempt?.ownerEpoch ?? directAttempt!.ownerEpoch)) ||
        typeof authorization.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(authorization.workspaceRevision) ||
        ((managedAttempt !== undefined || directAttempt !== undefined) &&
          authorization.workspaceRevision !== (managedAttempt?.workspaceRevision ?? directAttempt!.workspaceRevision))) {
      throw new TypeError("protocol operation process or workspace pin differs from its authenticated Session scope")
    }
    validateHostProcessScope({
      sessionID: input.sessionID,
      locationID: authorization.locationID as string,
      ownerEpoch: processRef.ownerEpoch,
      workspaceRevision: authorization.workspaceRevision as string,
      managedAttemptScope: managedAttempt,
      directAttemptScope: directAttempt,
      workspaceID: directAttempt?.workspaceID,
    })
    if (request.kind === "callback_reply" && authorization.protocol !== "lsp") {
      throw new TypeError("only the LSP callback path can authorize a correlated server reply")
    }
    const supervisorRequest: EditorProtocolAuthorizationRequestV1 = {
      locationRef: input.locationRef,
      capabilityID: request.capabilityID,
      sessionID: input.sessionID,
      arguments: authorization,
      ...(managedAttempt === undefined ? {} : { managedAttempt }),
      ...(directAttempt === undefined ? {} : { directAttempt }),
    }
    const result: EditorProtocolAuthorizationLeaseV1 = await input.runTrustedEffect(
      input.supervisor.authorizeEditorProtocolOperation(supervisorRequest),
    )
    if (!record(result) || result.capabilityID !== request.capabilityID ||
        result.locationID !== authorization.locationID ||
        typeof result.challengeID !== "string" || result.challengeID.length === 0 ||
        typeof result.effectID !== "string" || result.effectID.length === 0 ||
        !/^blake3:[0-9a-f]{64}$/.test(result.capabilityLeaseDigest) ||
        !sameManagedAttemptScope(result.managedAttempt, managedAttempt) ||
        !sameDirectAttemptScope(result.directAttempt, directAttempt)) {
      throw new TypeError("SessionSupervisor returned a lease outside the exact protocol operation binding")
    }
    if (!record(result.arguments) || result.arguments.sessionID !== input.sessionID ||
        result.arguments.locationID !== authorization.locationID || result.arguments.protocol !== authorization.protocol ||
        result.arguments.requestSequence !== authorization.requestSequence) {
      throw new TypeError("SessionSupervisor lease does not retain the exact protocol operation")
    }
    const returnedProcessRef = validateHostProcessRef(result.arguments.hostProcessRef)
    if (returnedProcessRef.executionID !== processRef.executionID || returnedProcessRef.generation !== processRef.generation ||
        returnedProcessRef.ownerEpoch !== processRef.ownerEpoch || returnedProcessRef.kind !== processRef.kind ||
        returnedProcessRef.profileID !== processRef.profileID || returnedProcessRef.profileRevision !== processRef.profileRevision ||
        returnedProcessRef.profileDigest !== processRef.profileDigest || returnedProcessRef.executableDigest !== processRef.executableDigest) {
      throw new TypeError("SessionSupervisor lease process pin differs from the requested operation")
    }
    return Object.freeze({
      effectID: result.effectID,
      challengeID: result.challengeID,
      capabilityID: result.capabilityID,
      capabilityLeaseDigest: result.capabilityLeaseDigest,
    })
  }
}

// Keep the imported Core error type visible in this adapter's public contract
// without introducing a second error vocabulary around the existing Guard owner.
export type EditorProtocolGuardErrorV1 = SessionSupervisorError | TypeError
