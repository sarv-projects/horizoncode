/**
 * Core composition for a Guarded DAP adapter process. It owns no executable,
 * target PID, stdio, or process handle; all lifecycle and protocol IO use the
 * shared HostKernel execution.v1 owner. The route is dormant while the common
 * editor process/protocol gates remain false.
 */

import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { Location } from "@opencode-ai/schema"
import type { Interface as SessionSupervisorInterface } from "@opencode-ai/core/session/supervisor"
import type { GlobalLaunchProfilesConfig } from "@/config/config"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  cancelEditorProcessV1,
  launchApprovedEditorProcessV1,
  readEditorProcessStatusV1,
  type EditorProcessStatusV1,
  type EditorProcessLifecycleScopeV1,
} from "@/lsp/process-lifecycle"
import { makeEditorProtocolGuardAuthorizerV1 } from "@/lsp/guard-authorizer"
import type { HostProcessRefV1 } from "@/lsp/process-scope"
import { projectTrustedGlobalDapProfileV1, resolveTrustedGlobalLaunchProfileV1 } from "@/lsp/launch-profile"
import { assertLanguageServiceProcessAllowed } from "@/lsp/launch"
import { HostKernelDapProtocolClientV1 } from "./host-protocol-client"

type RunTrustedEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

type DapHostRequestV1 = (
  serviceID: "execution.v1",
  operation:
    | "resolve_launch_profile"
    | "prepare"
    | "launch"
    | "status"
    | "read"
    | "cancel"
    | "protocol_op"
    | "protocol_read"
    | "protocol_reply",
  body: Readonly<Record<string, unknown>>,
) => Promise<unknown>

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
  if (input.managedAttempt !== undefined && input.directAttempt !== undefined) {
    throw new TypeError("supervised DAP creation cannot combine managed and direct Attempt scopes")
  }
  if (!input.userActionID.trim() || input.userActionID.length > 160 || !input.callID.trim() || input.callID.length > 160) {
    throw new TypeError("supervised DAP scope requires authenticated userActionID and callID")
  }
  if (input.managedAttempt !== undefined || input.directAttempt !== undefined) {
    const attemptSessionID = input.managedAttempt?.sessionID ?? input.directAttempt!.childSessionID
    const attempt = input.managedAttempt ?? input.directAttempt!
    if (input.sessionID !== attemptSessionID || input.locationID !== attempt.locationID ||
        input.workspaceRevision !== attempt.workspaceRevision ||
        (input.directAttempt && input.workspaceID !== input.directAttempt.workspaceID) ||
        (input.managedAttempt && input.workspaceID !== undefined)) {
      throw new TypeError("supervised DAP scope does not match the authenticated Attempt workspace pins")
    }
  } else if (!input.sessionID || !input.locationID || !/^blake3:[0-9a-f]{64}$/.test(input.workspaceRevision)) {
    throw new TypeError("supervised DAP root Session scope is malformed")
  }
  assertLanguageServiceProcessAllowed("debug.start")
  const scope: EditorProcessLifecycleScopeV1 = Object.freeze({
    sessionID: input.sessionID,
    locationID: input.locationID,
    workspaceRevision: input.workspaceRevision,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    ...(input.managedAttempt === undefined ? {} : { managedAttempt: input.managedAttempt }),
    ...(input.directAttempt === undefined ? {} : { directAttempt: input.directAttempt }),
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
      ...(input.managedAttempt === undefined ? {} : { managedAttempt: input.managedAttempt }),
      ...(input.directAttempt === undefined ? {} : { directAttempt: input.directAttempt }),
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
      ...(input.managedAttempt === undefined ? {} : { managedAttempt: input.managedAttempt }),
      ...(input.directAttempt === undefined ? {} : { directAttempt: input.directAttempt }),
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
        ...(input.managedAttempt === undefined ? {} : { managedAttempt: input.managedAttempt }),
        ...(input.directAttempt === undefined ? {} : { directAttempt: input.directAttempt }),
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
