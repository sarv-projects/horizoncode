/**
 * Single Core composition for a supervised LSP server. All authority comes
 * from trusted Core Config, the authenticated SessionSupervisor and the
 * existing HostKernel execution.v1 owner. The adapter owns no process handle,
 * executable path, cwd or direct filesystem reader.
 *
 * This composition remains dormant while the process/protocol gates are
 * false. It is source wiring, not evidence that LSP is runnable.
 */

import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import { Location } from "@opencode-ai/schema"
import type { Interface as SessionSupervisorInterface } from "@opencode-ai/core/session/supervisor"
import type { GlobalLaunchProfilesConfig } from "@/config/config"
import type { InstanceContext } from "@/project/instance-context"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  cancelEditorProcessV1,
  launchApprovedEditorProcessV1,
  readEditorProcessStatusV1,
  type EditorProcessLifecycleScopeV1,
  type RequestExecutionHostV1,
} from "./process-lifecycle"
import { makeEditorProtocolGuardAuthorizerV1 } from "./guard-authorizer"
import { HostKernelLspProtocolClientV1 } from "./host-protocol-client"
import {
  resolveTrustedGlobalLaunchProfileV1,
} from "./launch-profile"
import { createWithRepoDocumentReader, type Info } from "./client"
import { assertLanguageServiceProcessAllowed } from "./launch"

type RunTrustedEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

export type SupervisedLspHostRequestV1 = RequestExecutionHostV1

/** Detach authority-bearing Attempt pins from caller-owned mutable objects. */
export function snapshotLspAttemptScopeV1(input: {
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}): Pick<Parameters<typeof createSupervisedLspClientV1>[0], "managedAttempt" | "directAttempt"> {
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

/**
 * Resolve, approve, start and connect one immutable configured LSP profile.
 * Scope, Location and supervisor are supplied by the trusted Core composition
 * root; the caller cannot supply a process ref or an executable selector path.
 */
export async function createSupervisedLspClientV1(input: {
  readonly config: GlobalLaunchProfilesConfig
  readonly serverID: string
  readonly sessionID: string
  readonly locationID: string
  readonly locationRef: typeof Location.Ref.Type
  readonly workspaceRevision: string
  readonly workspaceID?: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly root: string
  readonly directory: string
  readonly instance: InstanceContext
  readonly initialization?: Record<string, unknown>
  readonly supervisor: Pick<
    SessionSupervisorInterface,
    "resolveEditorProcessApproval" | "authorizeEditorProtocolOperation" | "readRepoDocument"
  >
  readonly runTrustedEffect: RunTrustedEffect
  readonly requestHostKernel: SupervisedLspHostRequestV1
}): Promise<{ readonly client: Info; readonly processRef: Awaited<ReturnType<typeof launchApprovedEditorProcessV1>>["processRef"] }> {
  const { managedAttempt, directAttempt } = snapshotLspAttemptScopeV1(input)
  if (managedAttempt !== undefined && directAttempt !== undefined) {
    throw new TypeError("supervised LSP creation cannot combine managed and direct Attempt scopes")
  }
  if (managedAttempt !== undefined || directAttempt !== undefined) {
    const attemptSessionID = managedAttempt?.sessionID ?? directAttempt!.childSessionID
    const attempt = managedAttempt ?? directAttempt!
    if (input.sessionID !== attemptSessionID || input.locationID !== attempt.locationID ||
        input.workspaceRevision !== attempt.workspaceRevision ||
        (directAttempt && input.workspaceID !== directAttempt.workspaceID) ||
        (managedAttempt && input.workspaceID !== undefined)) {
      throw new TypeError("supervised LSP scope does not match the authenticated Attempt workspace pins")
    }
    if (input.workspaceID !== undefined && input.locationRef.workspaceID !== input.workspaceID) {
      throw new TypeError("supervised LSP location pin does not match the authenticated workspace ID")
    }
    if (managedAttempt !== undefined &&
        (path.resolve(input.root) !== path.resolve(managedAttempt.worktreeTarget.canonicalRoot) ||
          input.locationRef.workspaceID !== managedAttempt.worktreeTarget.workspaceID)) {
      throw new TypeError("supervised LSP scope does not match the managed Attempt worktree target")
    }
  } else if (!input.sessionID || !input.locationID || !input.workspaceID ||
      input.locationRef.workspaceID !== input.workspaceID || !/^blake3:[0-9a-f]{64}$/.test(input.workspaceRevision)) {
    throw new TypeError("supervised LSP root Session scope is malformed")
  }
  // Exact Location pin: the registered Location must resolve to the same root
  // this launch will register, so a stale or foreign LocationRef can never
  // enter HostKernel approval or per-frame protocol authorization.
  if (path.resolve(input.locationRef.directory) !== path.resolve(input.root)) {
    throw new TypeError("supervised LSP location pin does not match the authenticated workspace root")
  }
  assertLanguageServiceProcessAllowed("server.spawn")

  const scope: EditorProcessLifecycleScopeV1 = Object.freeze({
    sessionID: input.sessionID,
    locationID: input.locationID,
    workspaceRevision: input.workspaceRevision,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
     ...(managedAttempt === undefined ? {} : { managedAttempt }),
     ...(directAttempt === undefined ? {} : { directAttempt }),
  })
  const hostRequest = input.requestHostKernel
  const approval = await resolveTrustedGlobalLaunchProfileV1({
    config: input.config,
    kind: "lsp",
    selectorID: input.serverID,
    scope: {
      locationID: input.locationID,
      sessionID: input.sessionID,
      userActionID: `editor_${randomUUID().replaceAll("-", "")}`,
      callID: `editor_${randomUUID().replaceAll("-", "")}`,
       ...(managedAttempt === undefined ? {} : { managedAttempt }),
       ...(directAttempt === undefined ? {} : { directAttempt }),
    },
    requestHostKernel: hostRequest,
  })
  if (!approval) throw new TypeError(`trusted LSP launch profile is unavailable for ${input.serverID}`)

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
    requestHostKernel: hostRequest,
  })

  const processRef = launch.processRef
  let stopPromise: Promise<void> | undefined
  const stopServer = (request: { readonly processRef: typeof processRef; readonly expectedWorkspaceRevision: string }) => {
    if (request.expectedWorkspaceRevision !== input.workspaceRevision) {
      throw new TypeError("LSP stop workspace revision differs from its authenticated launch")
    }
    stopPromise ??= cancelEditorProcessV1({
        processRef,
        effectID: launch.lease.effectID,
        challengeID: launch.lease.challengeID,
        capabilityLeaseDigest: launch.lease.capabilityLeaseDigest,
        scope,
        requestHostKernel: hostRequest,
      }).then(() => undefined)
    return stopPromise!
  }

  let protocol: HostKernelLspProtocolClientV1 | undefined
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
    protocol = new HostKernelLspProtocolClientV1({
      requestHostKernel: input.requestHostKernel,
      scope: {
        hostProcessRef: processRef,
        sessionID: input.sessionID,
        locationID: input.locationID,
        workspaceRevision: input.workspaceRevision,
         ...(managedAttempt === undefined ? {} : { managedAttempt }),
         ...(directAttempt === undefined ? {} : { directAttempt }),
      },
      authorize,
      onTerminalFailure: () => stopServer({
        processRef,
        expectedWorkspaceRevision: input.workspaceRevision,
      }),
    })
    const client = await createWithRepoDocumentReader({
      serverID: input.serverID,
      protocol,
      processRef,
      launchProfileRef: approval.profileRef,
      initialization: input.initialization,
      root: input.root,
      directory: input.directory,
      instance: input.instance,
      workspaceRevision: input.workspaceRevision,
      stopServer,
      readProcessStatus: () => readEditorProcessStatusV1({
        executionID: processRef.executionID,
        effectID: launch.lease.effectID,
        challengeID: launch.lease.challengeID,
        scope,
        expectedProcessRef: processRef,
        requestHostKernel: hostRequest,
      }),
      repoDocumentReader: {
        supervisor: input.supervisor,
        identity: { sessionID: input.sessionID, locationRef: input.locationRef },
        runTrustedEffect: input.runTrustedEffect,
      },
    })
    return Object.freeze({ client, processRef })
  } catch (error) {
    try {
      await stopServer({ processRef, expectedWorkspaceRevision: input.workspaceRevision })
    } catch (stopError) {
      protocol?.dispose()
      throw new AggregateError([error, stopError], "LSP initialization failed and its exact supervised process could not be confirmed stopped")
    }
    protocol?.dispose()
    throw error
  }
}
