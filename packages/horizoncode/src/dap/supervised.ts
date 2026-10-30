/**
 * Core composition for a Guarded DAP adapter process. It owns no executable,
 * target PID, stdio, or process handle; all lifecycle and protocol IO use the
 * shared HostKernel execution.v1 owner. The route is dormant while the common
 * editor process/protocol gates remain false.
 */

import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import { Location } from "@horizoncode/schema"
import type { Interface as SessionSupervisorInterface } from "@horizoncode/core/session/supervisor"
import type { GlobalLaunchProfilesConfig } from "@/config/config"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  cancelEditorProcessV1,
  launchApprovedEditorProcessV1,
  readEditorProcessStatusV1,
  type EditorProcessStatusV1,
  type EditorProcessLifecycleScopeV1,
  type RequestExecutionHostV1,
} from "@/lsp/process-lifecycle"
import { makeEditorProtocolGuardAuthorizerV1 } from "@/lsp/guard-authorizer"
import { validateHostProcessRef, type HostProcessRefV1 } from "@/lsp/process-scope"
import { projectTrustedGlobalDapProfileV1, resolveTrustedGlobalLaunchProfileV1 } from "@/lsp/launch-profile"
import { assertLanguageServiceProcessAllowed } from "@/lsp/launch"
import { HostKernelDapProtocolClientV1 } from "./host-protocol-client"

type RunTrustedEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

type DapHostRequestV1 = RequestExecutionHostV1

/** Detach authority-bearing Attempt pins from caller-owned mutable objects. */
export function snapshotDapAttemptScopeV1(input: {
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}): Pick<Parameters<typeof createSupervisedDapClientV1>[0], "managedAttempt" | "directAttempt"> {
  return Object.freeze({
    ...(input.managedAttempt === undefined
      ? {}
      : {
          managedAttempt: Object.freeze({
            ...input.managedAttempt,
            worktreeTarget: Object.freeze({ ...input.managedAttempt.worktreeTarget }),
          }),
        }),
    ...(input.directAttempt === undefined
      ? {}
      : { directAttempt: Object.freeze({ ...input.directAttempt }) }),
  })
}

/** Resolve and start only an immutable global DAP profile. Debuggee launch or
 * attach authority is intentionally separate and unavailable in this helper. */
export async function createSupervisedDapClientV1(input: {
  readonly config: GlobalLaunchProfilesConfig
  readonly adapterID: string
  readonly sessionID: string
  readonly locationID: string
  readonly locationRef: typeof Location.Ref.Type
  /** Authenticated producer values. Never synthesize authority/provenance IDs here. */
  readonly userActionID: string
  readonly callID: string
  readonly workspaceRevision: string
  readonly workspaceID?: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  /** Optional HostKernel-minted terminal_run target from the same authenticated scope. */
  readonly targetHostProcessRef?: HostProcessRefV1
  readonly supervisor: Pick<SessionSupervisorInterface, "resolveEditorProcessApproval" | "authorizeEditorProtocolOperation">
  readonly runTrustedEffect: RunTrustedEffect
  readonly requestHostKernel: DapHostRequestV1
}): Promise<{
  readonly client: HostKernelDapProtocolClientV1
  readonly processRef: HostProcessRefV1
  /** Reconcile only this exact HostKernel execution and Attempt. It never relaunches. */
  readonly status: () => Promise<EditorProcessStatusV1>
  readonly stop: () => Promise<void>
}> {
  const { managedAttempt, directAttempt } = snapshotDapAttemptScopeV1(input)
  if (managedAttempt !== undefined && directAttempt !== undefined) {
    throw new TypeError("supervised DAP creation cannot combine managed and direct Attempt scopes")
  }
  if (input.targetHostProcessRef !== undefined) {
    const target = validateHostProcessRef(input.targetHostProcessRef)
    if (target.kind !== "terminal_run") {
      throw new TypeError("DAP attach target must be a HostKernel terminal_run process")
    }
    const attemptEpoch = managedAttempt?.ownerEpoch ?? directAttempt?.ownerEpoch
    if (attemptEpoch !== undefined && target.ownerEpoch !== attemptEpoch) {
      throw new TypeError("DAP attach target does not match the authenticated owner epoch")
    }
  }
  if (!input.userActionID.trim() || input.userActionID.length > 160 || !input.callID.trim() || input.callID.length > 160) {
    throw new TypeError("supervised DAP scope requires authenticated userActionID and callID")
  }
  if (managedAttempt !== undefined || directAttempt !== undefined) {
    const attemptSessionID = managedAttempt?.sessionID ?? directAttempt!.childSessionID
    const attempt = managedAttempt ?? directAttempt!
    if (input.sessionID !== attemptSessionID || input.locationID !== attempt.locationID ||
        input.workspaceRevision !== attempt.workspaceRevision ||
        (directAttempt && input.workspaceID !== directAttempt.workspaceID) ||
        (managedAttempt && input.workspaceID !== undefined)) {
      throw new TypeError("supervised DAP scope does not match the authenticated Attempt workspace pins")
    }
    if (input.workspaceID !== undefined && input.locationRef.workspaceID !== input.workspaceID) {
      throw new TypeError("supervised DAP location pin does not match the authenticated workspace ID")
    }
    if (managedAttempt !== undefined &&
        (path.resolve(input.locationRef.directory) !== path.resolve(managedAttempt.worktreeTarget.canonicalRoot) ||
          input.locationRef.workspaceID !== managedAttempt.worktreeTarget.workspaceID)) {
      throw new TypeError("supervised DAP scope does not match the managed Attempt worktree target")
    }
  } else if (!input.sessionID || !input.locationID || !input.workspaceID ||
      input.locationRef.workspaceID !== input.workspaceID || !/^blake3:[0-9a-f]{64}$/.test(input.workspaceRevision)) {
    throw new TypeError("supervised DAP root Session scope is malformed")
  }
  assertLanguageServiceProcessAllowed("debug.start")
  const scope: EditorProcessLifecycleScopeV1 = Object.freeze({
    sessionID: input.sessionID,
    locationID: input.locationID,
    workspaceRevision: input.workspaceRevision,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    ...(managedAttempt === undefined ? {} : { managedAttempt }),
    ...(directAttempt === undefined ? {} : { directAttempt }),
  })
  const requestHostKernel = input.requestHostKernel
  const profileDefinition = projectTrustedGlobalDapProfileV1({ config: input.config, adapterID: input.adapterID })
  if (!profileDefinition) throw new TypeError(`trusted DAP profile is unavailable for ${input.adapterID}`)
  const approval = await resolveTrustedGlobalLaunchProfileV1({
    config: input.config,
    kind: "dap",
    selectorID: input.adapterID,
    scope: {
      locationID: input.locationID,
      sessionID: input.sessionID,
      userActionID: input.userActionID,
      callID: input.callID,
       ...(managedAttempt === undefined ? {} : { managedAttempt }),
       ...(directAttempt === undefined ? {} : { directAttempt }),
    },
    requestHostKernel,
  })
  if (!approval) throw new TypeError(`trusted DAP launch profile is unavailable for ${input.adapterID}`)
  if (approval.profileRef.profileId !== profileDefinition.profileId ||
      approval.profileRef.revision !== profileDefinition.revision) {
    throw new TypeError("HostKernel DAP process profile differs from the trusted immutable DAP policy")
  }

  const launch = await launchApprovedEditorProcessV1({
    approval,
    scope,
    resolveApproval: (request) => input.runTrustedEffect(input.supervisor.resolveEditorProcessApproval({
      locationRef: input.locationRef,
      challenge: {
        ...request.approval,
        approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
      },
    })),
    requestHostKernel,
  })
  const processRef = launch.processRef
  let client: HostKernelDapProtocolClientV1 | undefined
  let stopPromise: Promise<void> | undefined
  const status = async () => {
    const current = await readEditorProcessStatusV1({
      executionID: processRef.executionID,
      effectID: launch.lease.effectID,
      challengeID: launch.lease.challengeID,
      scope,
      expectedProcessRef: processRef,
      requestHostKernel,
    })
    if (current.state !== "RUNNING" && current.state !== "CANCELLING") client?.end()
    return current
  }
  const stop = () => {
    stopPromise ??= (async () => {
      try {
        await cancelEditorProcessV1({
          processRef,
          effectID: launch.lease.effectID,
          challengeID: launch.lease.challengeID,
          capabilityLeaseDigest: launch.lease.capabilityLeaseDigest,
          scope,
          requestHostKernel,
        })
      } finally {
        client?.end()
      }
    })()
    return stopPromise
  }
  try {
    const authorize = makeEditorProtocolGuardAuthorizerV1({
      supervisor: input.supervisor,
      locationRef: input.locationRef,
      sessionID: input.sessionID,
      locationID: input.locationID,
      ...(managedAttempt === undefined ? {} : { managedAttempt }),
      ...(directAttempt === undefined ? {} : { directAttempt }),
      runTrustedEffect: input.runTrustedEffect,
    })
    client = new HostKernelDapProtocolClientV1({
      requestHostKernel,
      scope: {
        hostProcessRef: processRef,
        ...(profileDefinition.dapPolicy === undefined ? {} : { dapPolicy: profileDefinition.dapPolicy }),
        ...(input.targetHostProcessRef === undefined ? {} : { targetHostProcessRef: input.targetHostProcessRef }),
        sessionID: input.sessionID,
        locationID: input.locationID,
        workspaceRevision: input.workspaceRevision,
         ...(managedAttempt === undefined ? {} : { managedAttempt }),
         ...(directAttempt === undefined ? {} : { directAttempt }),
      },
      authorize,
      onTerminalFailure: () => stop(),
    })
  } catch (error) {
    try {
      await stop()
    } catch (stopError) {
      throw new AggregateError([error, stopError], "DAP adapter setup failed and its exact supervised process could not be confirmed stopped")
    }
    throw error
  }
  return Object.freeze({ client: client!, processRef, status, stop })
}
