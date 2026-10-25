import { Schema } from "effect"
import {
  ExternalEditorLaunchRequestV1,
  ExternalEditorLaunchResultV1,
  externalEditorProfileRefV1,
  type ExternalEditorProfileDefinitionV1,
  type ExternalEditorProfileRefV1,
} from "@opencode-ai/schema/external-editor-profile-v1"

// Mirrors the schema module's decode helpers, which are now exported in the
// curried Effect v4 form (`decodeUnknownSync(schema)(value, options)`). The
// local decoders keep the strict `onExcessProperty: "error"` behavior at this
// call site; the earlier legacy three-argument helper defect is fixed in
// `@opencode-ai/schema/external-editor-profile-v1`.
const decodeLaunchRequest = Schema.decodeUnknownSync(ExternalEditorLaunchRequestV1)
const decodeLaunchResult = Schema.decodeUnknownSync(ExternalEditorLaunchResultV1)

/**
 * Core consumer for the P1 `ExternalEditorExecutionOutcomeV1` contract.
 *
 * The host owns the process, scratch file, confinement, Guard lease and durable
 * receipt. This module owns only request validation, the wait-for-close
 * projection and the post-close changed/conflict classification. It never
 * starts a process itself, never reads workspace files directly, and never
 * applies a write. HostKernel routing for editor launch is still P1/P2 work;
 * until it exists, `openWorkspaceFileV1` fails closed with a typed result and
 * does not invoke the injected host.
 */

/** HostKernel route for external editor launch is P1/P2-owned and not routed yet. */
const EXTERNAL_EDITOR_ROUTE_READY = false

export function externalEditorRouteAvailable(): boolean {
  return EXTERNAL_EDITOR_ROUTE_READY
}

export type ExternalEditorHostV1 = {
  /** Start the exact approved profile. The response is the P1 redacted outcome. */
  readonly launch: (request: ExternalEditorLaunchRequestV1) => Promise<unknown>
  /** Wait for the exact process to close. Returns a terminal P1 outcome. */
  readonly waitForClose: (input: {
    readonly effectID: string
    readonly executionID: string
    readonly expectedWorkspaceRevision: string
    readonly expectedFileDigest: string | null
  }) => Promise<unknown>
}

export type ExternalEditorOpenResultV1 =
  | {
      readonly status: "unavailable"
      readonly reason: "route_unavailable"
      readonly detail: string
    }
  | {
      readonly status: "completed"
      readonly effectID: string
      readonly executionID: string
      readonly receiptDigest: string
      readonly changed: boolean
      /** True when the workspace advanced beyond the preview revision. */
      readonly workspaceAdvanced: boolean
      readonly observedWorkspaceRevision: string
      readonly resultFileDigest: string
    }
  | {
      readonly status: "cancelled" | "conflict" | "unknown"
      readonly effectID: string
      readonly executionID: string
      readonly receiptDigest: string | null
    }

export type ExternalEditorOpenInputV1 = {
  readonly host: ExternalEditorHostV1
  readonly profile: ExternalEditorProfileDefinitionV1
  readonly selected: ExternalEditorProfileRefV1
  readonly sessionId: string
  readonly locationId: string
  readonly pathRef: string
  readonly sourceRevision: string
  readonly contentDigest: string
}

const DIGEST = /^blake3:[0-9a-f]{64}$/

/** Build and validate the private launch payload from user-selected profile and
 * the authenticated Explorer preview. Throws `TypeError` for caller mistakes;
 * it never treats a request body as authority. */
export function planWorkspaceOpenV1(input: {
  readonly profile: ExternalEditorProfileDefinitionV1
  readonly selected: ExternalEditorProfileRefV1
  readonly sessionId: string
  readonly locationId: string
  readonly pathRef: string
  readonly sourceRevision: string
  readonly contentDigest: string
}): ExternalEditorLaunchRequestV1 {
  const expected = externalEditorProfileRefV1(input.profile)
  if (
    expected.profileId !== input.selected.profileId ||
    expected.revision !== input.selected.revision ||
    expected.profileDigest !== input.selected.profileDigest
  ) {
    throw new TypeError("selected external editor ref does not match the immutable profile definition")
  }
  if (!input.profile.targetKinds.includes("workspace_file")) {
    throw new TypeError("selected external editor profile does not permit workspace file targets")
  }
  if (!DIGEST.test(input.sourceRevision) || !DIGEST.test(input.contentDigest)) {
    throw new TypeError("external editor open requires exact blake3 revision and file digests")
  }
  return decodeLaunchRequest({
    schemaVersion: 1,
    sessionId: input.sessionId,
    locationId: input.locationId,
    profileRef: input.selected,
    targetKind: "workspace_file",
    targetRelativePath: input.pathRef,
    expectedWorkspaceRevision: input.sourceRevision,
    expectedFileDigest: input.contentDigest,
  })
}

/** Build a prompt-edit request whose scratch path and initial content are
 * generated exclusively by HostKernel. The client can select the immutable
 * profile, but cannot choose a workspace path or supply scratch preimage data. */
export function planPromptScratchV1(input: {
  readonly profile: ExternalEditorProfileDefinitionV1
  readonly selected: ExternalEditorProfileRefV1
  readonly sessionId: string
  readonly locationId: string
  readonly workspaceRevision: string
}): ExternalEditorLaunchRequestV1 {
  const expected = externalEditorProfileRefV1(input.profile)
  if (
    expected.profileId !== input.selected.profileId ||
    expected.revision !== input.selected.revision ||
    expected.profileDigest !== input.selected.profileDigest
  ) {
    throw new TypeError("selected external editor ref does not match the immutable profile definition")
  }
  if (!input.profile.targetKinds.includes("prompt_scratch")) {
    throw new TypeError("selected external editor profile does not permit prompt scratch targets")
  }
  if (!DIGEST.test(input.workspaceRevision)) {
    throw new TypeError("external editor prompt scratch requires an exact blake3 workspace revision")
  }
  return decodeLaunchRequest({
    schemaVersion: 1,
    sessionId: input.sessionId,
    locationId: input.locationId,
    profileRef: input.selected,
    targetKind: "prompt_scratch",
    targetRelativePath: "",
    expectedWorkspaceRevision: input.workspaceRevision,
    expectedFileDigest: null,
  })
}

/**
 * Open one workspace file through the configured profile and wait for close.
 * Returns `unknown` rather than retrying when the host cannot prove the
 * outcome. Never writes: a changed file is reported for the caller's normal
 * diff/review flow.
 */
export async function openWorkspaceFileV1(input: ExternalEditorOpenInputV1): Promise<ExternalEditorOpenResultV1> {
  if (!EXTERNAL_EDITOR_ROUTE_READY) {
    return Object.freeze({
      status: "unavailable",
      reason: "route_unavailable",
      detail: "external editor launch requires the P1/P2 HostKernel editor effect route and P1 containment/receipt acceptance",
    })
  }
  const request = planWorkspaceOpenV1(input)
  const launched = decodeOutcome(await input.host.launch(request), input.selected)
  const terminal = isTerminal(launched.status)
    ? launched
    : decodeOutcome(await input.host.waitForClose({
        effectID: launched.effectID,
        executionID: launched.executionID,
        expectedWorkspaceRevision: request.expectedWorkspaceRevision,
        expectedFileDigest: request.expectedFileDigest,
      }), input.selected)
  return projectTerminalOutcome(terminal, request.expectedWorkspaceRevision, request.expectedFileDigest)
}

/** Project an already-terminal host outcome. Exposed for the ordinary callers
 * that reconcile a retained editor run after a TUI restart; it performs no IO. */
export function projectEditorOutcomeV1(
  outcome: unknown,
  expected: {
    readonly profile: ExternalEditorProfileRefV1
    readonly sourceRevision: string
    readonly contentDigest: string
  },
): ExternalEditorOpenResultV1 {
  const terminal = decodeOutcome(outcome, expected.profile)
  if (!isTerminal(terminal.status)) {
    return Object.freeze({
      status: "unknown",
      effectID: terminal.effectID,
      executionID: terminal.executionID,
      receiptDigest: null,
    })
  }
  return projectTerminalOutcome(terminal, expected.sourceRevision, expected.contentDigest)
}

function decodeOutcome(value: unknown, profile: ExternalEditorProfileRefV1): ExternalEditorLaunchResultV1 {
  const result = decodeLaunchResult(value, { onExcessProperty: "error" })
  if (result.executionID !== result.processRef.executionID) {
    throw new TypeError("editor outcome process identity differs from execution ID")
  }
  if (
    result.processRef.profileID !== profile.profileId ||
    result.processRef.profileRevision !== profile.revision ||
    result.processRef.profileDigest !== profile.profileDigest
  ) {
    throw new TypeError("editor outcome process profile differs from the immutable selection")
  }
  return result
}

function isTerminal(
  status: ExternalEditorLaunchResultV1["status"],
): status is "completed" | "cancelled" | "conflict" {
  return status === "completed" || status === "cancelled" || status === "conflict"
}

function projectTerminalOutcome(
  outcome: ExternalEditorLaunchResultV1,
  expectedWorkspaceRevision: string,
  expectedFileDigest: string | null,
): ExternalEditorOpenResultV1 {
  if (outcome.status === "completed") {
    if (
      outcome.exitCode !== 0 ||
      outcome.resultFileDigest === null ||
      outcome.observedWorkspaceRevision === null ||
      outcome.receiptDigest === null
    ) {
      throw new TypeError("completed external editor outcome lacks its exact exit/result/workspace pins")
    }
    return Object.freeze({
      status: "completed",
      effectID: outcome.effectID,
      executionID: outcome.executionID,
      receiptDigest: outcome.receiptDigest,
      changed: outcome.resultFileDigest !== expectedFileDigest,
      workspaceAdvanced: outcome.observedWorkspaceRevision !== expectedWorkspaceRevision,
      observedWorkspaceRevision: outcome.observedWorkspaceRevision,
      resultFileDigest: outcome.resultFileDigest,
    })
  }
  if (outcome.status === "cancelled" || outcome.status === "conflict") {
    return Object.freeze({
      status: outcome.status,
      effectID: outcome.effectID,
      executionID: outcome.executionID,
      receiptDigest: outcome.receiptDigest,
    })
  }
  return Object.freeze({
    status: "unknown",
    effectID: outcome.effectID,
    executionID: outcome.executionID,
    receiptDigest: null,
  })
}

export * as ExternalEditor from "./external-editor"
