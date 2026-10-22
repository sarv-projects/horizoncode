/**
 * Core adapter for the existing HostKernel supervised stdio process lifecycle.
 * It owns no process, executable, cwd, environment or OS handle.  The caller
 * supplies a profile approval produced from trusted Core Config and must send
 * that challenge through the shared Guard approval owner before this adapter
 * consumes the resulting one-use lease.
 *
 * This adapter is deliberately not installed into a product route yet:
 * `assertLanguageServiceProcessAllowed` remains a constant-false gate until
 * P1 Guard/receipt/confinement acceptance and the P4 integration journey pass.
 */

import { randomUUID } from "node:crypto"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import type { EffectLease } from "@opencode-ai/core/session/supervisor"
import { assertLanguageServiceProcessAllowed } from "./launch"
import {
  validateExecutionLaunchProfileRef,
  validateHostProcessRef,
  validateHostProcessScope,
  sameDirectAttemptScope,
  sameManagedAttemptScope,
  type ExecutionLaunchProfileRefV1,
  type HostProcessRefV1,
} from "./process-scope"
import type { LaunchProfileApprovalV1 } from "./launch-profile"

export type EditorProcessLifecycleScopeV1 = {
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly workspaceID?: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

export type EditorProcessStatusV1 = {
  readonly executionID: string
  readonly generation: string
  readonly state: "PREPARED" | "RUNNING" | "CANCELLING" | "SETTLED" | "UNKNOWN"
  readonly stdoutSequence: string
  readonly stderrSequence: string
  readonly exitCode: number | null
  readonly stdoutDigest: string
  readonly stderrDigest: string
  readonly outputBytes: string
  readonly truncated: boolean
  readonly receiptDigest: string | null
  readonly hostProcessRef?: HostProcessRefV1
  readonly resourceGuarantees?: ProcessResourceGuaranteesV1
}

export type ProcessResourceGuaranteesV1 = {
  readonly cpuTimeEnforced: boolean
  readonly memoryEnforced: boolean
  readonly processCountEnforced: boolean
  readonly fileDescriptorsEnforced: boolean
}

export type EditorProcessOutputPageV1 = {
  readonly executionID: string
  readonly generation: string
  readonly records: readonly {
    readonly source: "stdout" | "stderr"
    readonly sequence: string
    readonly bytes: Uint8Array
  }[]
  readonly nextStdoutSequence: string
  readonly nextStderrSequence: string
  readonly eof: boolean
  readonly truncated: boolean
  readonly state: EditorProcessStatusV1["state"]
  readonly receiptDigest: string | null
  readonly receipt?: EditorProcessReceiptV1
}

export type EditorProcessReceiptV1 = {
  readonly executionID: string
  readonly effectID: string
  readonly generation: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly executableDigest: string
  readonly exitCode: number | null
  readonly stdoutSequence: string
  readonly stderrSequence: string
  readonly stdoutDigest: string
  readonly stderrDigest: string
  readonly outputBytes: string
  readonly truncated: boolean
  readonly receiptDigest: string
}

export type EditorProcessLeaseV1 = EffectLease & {
  readonly challengeID: string
  readonly capabilityID: "language.start" | "debug.start" | "repl.start"
}

export type RequestExecutionHostV1 = (
  serviceID: "execution.v1",
  operation: "resolve_launch_profile" | "prepare" | "launch" | "status" | "read" | "cancel" |
    "repl_next_sequence" | "repl_op" | "repl_callback_read" | "repl_callback_reply",
  body: Readonly<Record<string, unknown>>,
) => Promise<unknown>

export class EditorProcessOutcomeUnknownError extends Error {
  readonly _tag = "EditorProcessOutcomeUnknownError"
  constructor(message = "HostKernel could not prove the exact editor process launch outcome") {
    super(message)
    this.name = "EditorProcessOutcomeUnknownError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value)) {
    throw new TypeError(`${name} is invalid`)
  }
}

function decimal(value: unknown, name: string, zero = false): string {
  const result = typeof value === "bigint" ? value.toString(10)
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value)
      : value
  if (typeof result !== "string" || !(zero ? /^(0|[1-9][0-9]{0,19})$/ : /^[1-9][0-9]{0,19}$/).test(result) ||
      BigInt(result) > 18_446_744_073_709_551_615n) {
    throw new TypeError(`${name} is not a canonical u64`)
  }
  return result
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^blake3:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} is not a BLAKE3 digest`)
  }
  return value
}

function validateScope(scope: EditorProcessLifecycleScopeV1): EditorProcessLifecycleScopeV1 {
  if (scope.managedAttempt !== undefined && scope.directAttempt !== undefined) {
    throw new TypeError("editor process lifecycle cannot combine managed and direct Attempt scopes")
  }
  // Root direct Sessions carry no Attempt. Their epoch and exact process
  // identity are minted and revalidated by the authenticated HostKernel frame;
  // child and managed Sessions retain their stronger Attempt pin here.
  if (scope.managedAttempt !== undefined || scope.directAttempt !== undefined) {
    validateHostProcessScope({
      sessionID: scope.sessionID,
      locationID: scope.locationID,
      ownerEpoch: scope.managedAttempt?.ownerEpoch ?? scope.directAttempt!.ownerEpoch,
      workspaceRevision: scope.workspaceRevision,
      managedAttemptScope: scope.managedAttempt,
      directAttemptScope: scope.directAttempt,
      workspaceID: scope.workspaceID ?? scope.directAttempt?.workspaceID,
    })
  } else if (!scope.sessionID || !scope.locationID || !/^blake3:[0-9a-f]{64}$/.test(scope.workspaceRevision)) {
    throw new TypeError("root Session process scope is malformed")
  }
  return Object.freeze({
    ...scope,
    ...(scope.managedAttempt === undefined ? {} : { managedAttempt: Object.freeze({ ...scope.managedAttempt }) }),
    ...(scope.directAttempt === undefined ? {} : { directAttempt: Object.freeze({ ...scope.directAttempt }) }),
  })
}

function validateLease(
  approval: LaunchProfileApprovalV1,
  scope: EditorProcessLifecycleScopeV1,
  lease: EffectLease,
): EditorProcessLeaseV1 {
  if (!record(lease) || typeof lease.effectID !== "string" || lease.effectID !== approval.effectID ||
      typeof lease.capabilityLeaseDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(lease.capabilityLeaseDigest)) {
    throw new TypeError("editor process approval did not produce its exact one-use Guard lease")
  }
  const scoped = lease as EffectLease
  if (scoped.managedAttempt !== undefined && scoped.directAttempt !== undefined) {
    throw new TypeError("editor process lease cannot combine managed and direct Attempt scopes")
  }
  if (approval.approval.challengeID !== approval.challengeID || approval.capabilityID !== approval.approval.capabilityID ||
      !sameManagedAttemptScope(scoped.managedAttempt, scope.managedAttempt) ||
      !sameDirectAttemptScope(scoped.directAttempt, scope.directAttempt)) {
    throw new TypeError("editor process approval identity is inconsistent")
  }
  return Object.freeze({
    ...scoped,
    challengeID: approval.challengeID,
    capabilityID: approval.capabilityID,
  })
}

function decodeGuarantees(value: unknown): ProcessResourceGuaranteesV1 {
  if (!record(value) || !exactKeys(value, ["cpuTimeEnforced", "memoryEnforced", "processCountEnforced", "fileDescriptorsEnforced"]) ||
      Object.values(value).some((item) => typeof item !== "boolean")) {
    throw new TypeError("HostKernel process resource guarantees are malformed")
  }
  return Object.freeze({
    cpuTimeEnforced: value.cpuTimeEnforced as boolean,
    memoryEnforced: value.memoryEnforced as boolean,
    processCountEnforced: value.processCountEnforced as boolean,
    fileDescriptorsEnforced: value.fileDescriptorsEnforced as boolean,
  })
}

function decodeStatus(value: unknown): EditorProcessStatusV1 {
  const required = [
    "executionID", "generation", "state", "stdoutSequence", "stderrSequence", "exitCode",
    "stdoutDigest", "stderrDigest", "outputBytes", "truncated", "receiptDigest",
  ]
  if (!record(value) || !exactKeys(value, required, ["hostProcessRef", "resourceGuarantees"])) {
    throw new TypeError("HostKernel execution status has unknown or missing fields")
  }
  identifier(value.executionID, "executionID")
  const state = value.state
  if (state !== "PREPARED" && state !== "RUNNING" && state !== "CANCELLING" && state !== "SETTLED" && state !== "UNKNOWN") {
    throw new TypeError("HostKernel execution status state is invalid")
  }
  if (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < -255 || (value.exitCode as number) > 255)) {
    throw new TypeError("HostKernel execution exit code is invalid")
  }
  if (typeof value.truncated !== "boolean") throw new TypeError("HostKernel execution truncation flag is invalid")
  const receiptDigest = value.receiptDigest === null ? null : digest(value.receiptDigest, "execution receiptDigest")
  return Object.freeze({
    executionID: value.executionID,
    generation: decimal(value.generation, "execution generation"),
    state,
    stdoutSequence: decimal(value.stdoutSequence, "stdoutSequence", true),
    stderrSequence: decimal(value.stderrSequence, "stderrSequence", true),
    exitCode: value.exitCode as number | null,
    stdoutDigest: digest(value.stdoutDigest, "stdoutDigest"),
    stderrDigest: digest(value.stderrDigest, "stderrDigest"),
    outputBytes: decimal(value.outputBytes, "outputBytes", true),
    truncated: value.truncated,
    receiptDigest,
    ...(value.hostProcessRef === undefined ? {} : { hostProcessRef: validateHostProcessRef(value.hostProcessRef) }),
    ...(value.resourceGuarantees === undefined ? {} : { resourceGuarantees: decodeGuarantees(value.resourceGuarantees) }),
  })
}

function sameProcess(left: HostProcessRefV1, right: HostProcessRefV1): boolean {
  return left.executionID === right.executionID && left.generation === right.generation &&
    left.ownerEpoch === right.ownerEpoch && left.kind === right.kind && left.profileID === right.profileID &&
    left.profileRevision === right.profileRevision && left.profileDigest === right.profileDigest &&
    left.executableDigest === right.executableDigest
}

function processKind(capabilityID: string): HostProcessRefV1["kind"] {
  if (capabilityID === "language.start") return "language_server"
  if (capabilityID === "debug.start") return "debug_adapter"
  if (capabilityID === "repl.start") return "interpreter"
  throw new TypeError("unsupported editor process capability")
}

function validateApprovalForScope(approval: LaunchProfileApprovalV1, scope: EditorProcessLifecycleScopeV1): void {
  if (approval.sessionID !== scope.sessionID || approval.locationID !== scope.locationID ||
      (approval.capabilityID !== "language.start" && approval.capabilityID !== "debug.start" && approval.capabilityID !== "repl.start") ||
      approval.approval.capabilityID !== approval.capabilityID) {
    throw new TypeError("launch profile approval does not match the requested Session, Location, or process kind")
  }
  const profileKindMatches = approval.capabilityID === "language.start"
    ? approval.profileRef.profileId.startsWith("lsp_")
    : approval.capabilityID === "debug.start"
      ? approval.profileRef.profileId.startsWith("dap_")
      : approval.profileRef.profileId.startsWith("repl_")
  if (!profileKindMatches) {
    throw new TypeError("launch profile approval capability does not match its immutable profile kind")
  }
}

/**
 * Launch the exact approved profile through HostKernel's single execution.v1
 * supervisor. On a lost launch acknowledgement, query only the same opaque
 * execution/effect/challenge/scope binding. This function never retries spawn.
 */
export async function launchApprovedEditorProcessV1(input: {
  readonly approval: LaunchProfileApprovalV1
  readonly scope: EditorProcessLifecycleScopeV1
  readonly resolveApproval: (approval: LaunchProfileApprovalV1) => Promise<EffectLease>
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<{
  readonly processRef: HostProcessRefV1
  readonly status: EditorProcessStatusV1
  readonly resourceGuarantees: ProcessResourceGuaranteesV1
  /** Local Core-only pin retained for exact cancel/receipt reconciliation. */
  readonly lease: EditorProcessLeaseV1
}> {
  assertLanguageServiceProcessAllowed(input.approval.capabilityID === "language.start" ? "server.spawn"
    : input.approval.capabilityID === "debug.start" ? "debug.start" : "repl.start")
  const scope = validateScope(input.scope)
  validateApprovalForScope(input.approval, scope)
  const profileRef: ExecutionLaunchProfileRefV1 = validateExecutionLaunchProfileRef(input.approval.profileRef)
  const lease = validateLease(input.approval, scope, await input.resolveApproval(input.approval))
  const executionID = `editor_${randomUUID().replaceAll("-", "")}`
  const common = Object.freeze({
    executionID,
    effectID: input.approval.effectID,
    challengeID: input.approval.challengeID,
    locationID: scope.locationID,
    sessionID: scope.sessionID,
    capabilityLeaseDigest: lease.capabilityLeaseDigest,
    ...(scope.managedAttempt === undefined ? {} : { managedAttempt: scope.managedAttempt }),
    ...(scope.directAttempt === undefined ? {} : { directAttempt: scope.directAttempt }),
  })
  const preparedRaw = await input.requestHostKernel("execution.v1", "prepare", {
    ...common,
    profileRef,
  })
  if (!record(preparedRaw) || !exactKeys(preparedRaw, [
    "executionID", "generation", "state", "executionDigest", "approvedArgumentsDigest",
    "confinementRecord", "capabilityLeaseDigest", "resourceGuarantees",
  ]) || preparedRaw.executionID !== executionID || preparedRaw.state !== "PREPARED") {
    throw new TypeError("HostKernel did not return the exact prepared editor process")
  }
  const generation = decimal(preparedRaw.generation, "prepared process generation")
  if (digest(preparedRaw.capabilityLeaseDigest, "prepared capability lease") !== lease.capabilityLeaseDigest ||
      typeof preparedRaw.executionDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(preparedRaw.executionDigest) ||
      digest(preparedRaw.approvedArgumentsDigest, "approvedArgumentsDigest") !== input.approval.inputDigest ||
      typeof preparedRaw.confinementRecord !== "string" || !preparedRaw.confinementRecord || preparedRaw.confinementRecord.length > 4096) {
    throw new TypeError("HostKernel prepared process does not match its approved lease or confinement record")
  }
  const preparedGuarantees = decodeGuarantees(preparedRaw.resourceGuarantees)
  const launchBody = Object.freeze({
    ...common,
    generation,
    profileRef,
  })
  try {
    const status = decodeStatus(await input.requestHostKernel("execution.v1", "launch", launchBody))
    if (status.executionID !== executionID || status.generation !== generation || status.state !== "RUNNING" ||
        !status.hostProcessRef || !status.resourceGuarantees) throw new TypeError("HostKernel launch response lacks a live process identity")
    const processRef = validateHostProcessRef(status.hostProcessRef)
    if (processRef.executionID !== executionID || processRef.generation !== generation ||
        (scope.managedAttempt !== undefined || scope.directAttempt !== undefined) &&
          processRef.ownerEpoch !== (scope.managedAttempt?.ownerEpoch ?? scope.directAttempt!.ownerEpoch) ||
        processRef.kind !== processKind(lease.capabilityID) || processRef.profileID !== profileRef.profileId ||
        processRef.profileRevision !== profileRef.revision || processRef.profileDigest !== profileRef.profileDigest) {
      throw new TypeError("HostKernel process identity differs from the approved execution launch profile or owner scope")
    }
    return Object.freeze({ processRef, status, resourceGuarantees: status.resourceGuarantees ?? preparedGuarantees, lease })
  } catch (launchError) {
    let recovered: EditorProcessStatusV1
    try {
      recovered = decodeStatus(await input.requestHostKernel("execution.v1", "status", {
        executionID,
        effectID: common.effectID,
        challengeID: common.challengeID,
        locationID: common.locationID,
        ...(scope.managedAttempt === undefined ? {} : { managedAttempt: scope.managedAttempt }),
        ...(scope.directAttempt === undefined ? {} : { directAttempt: scope.directAttempt }),
      }))
    } catch {
      throw new EditorProcessOutcomeUnknownError()
    }
    const processRef = recovered.hostProcessRef
    if (recovered.executionID !== executionID || recovered.state !== "RUNNING" || !processRef || !recovered.resourceGuarantees ||
        processRef.executionID !== executionID || processRef.generation !== recovered.generation ||
        (scope.managedAttempt !== undefined || scope.directAttempt !== undefined) &&
          processRef.ownerEpoch !== (scope.managedAttempt?.ownerEpoch ?? scope.directAttempt!.ownerEpoch) ||
        processRef.kind !== processKind(lease.capabilityID) || processRef.profileID !== profileRef.profileId ||
        processRef.profileRevision !== profileRef.revision || processRef.profileDigest !== profileRef.profileDigest) {
      throw new EditorProcessOutcomeUnknownError(launchError instanceof Error ? launchError.message : undefined)
    }
    return Object.freeze({
      processRef: Object.freeze({ ...processRef }),
      status: recovered,
      resourceGuarantees: recovered.resourceGuarantees ?? preparedGuarantees,
      lease,
    })
  }
}

/** Read-only exact status/recovery; a process ref is accepted only when minted in this HostKernel epoch. */
export async function readEditorProcessStatusV1(input: {
  readonly executionID: string
  readonly effectID: string
  readonly challengeID: string
  readonly scope: EditorProcessLifecycleScopeV1
  readonly expectedProcessRef?: HostProcessRefV1
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<EditorProcessStatusV1> {
  const scope = validateScope(input.scope)
  const status = decodeStatus(await input.requestHostKernel("execution.v1", "status", {
    executionID: input.executionID,
    effectID: input.effectID,
    challengeID: input.challengeID,
    locationID: scope.locationID,
    ...(scope.managedAttempt === undefined ? {} : { managedAttempt: scope.managedAttempt }),
    ...(scope.directAttempt === undefined ? {} : { directAttempt: scope.directAttempt }),
  }))
  if (status.executionID !== input.executionID) throw new TypeError("HostKernel status returned a different execution")
  if (status.hostProcessRef) {
    const processRef = validateHostProcessRef(status.hostProcessRef)
    if (((scope.managedAttempt !== undefined || scope.directAttempt !== undefined) &&
        processRef.ownerEpoch !== (scope.managedAttempt?.ownerEpoch ?? scope.directAttempt!.ownerEpoch)) ||
        (input.expectedProcessRef && !sameProcess(processRef, validateHostProcessRef(input.expectedProcessRef)))) {
      throw new EditorProcessOutcomeUnknownError("HostKernel status process reference is stale or differs from the expected generation")
    }
  }
  return status
}

/** Stop only the exact retained execution using its launch lease and generation. */
export async function cancelEditorProcessV1(input: {
  readonly processRef: HostProcessRefV1
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityLeaseDigest: string
  readonly scope: EditorProcessLifecycleScopeV1
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<EditorProcessStatusV1> {
  assertLanguageServiceProcessAllowed(processRef.kind === "language_server" ? "server.stop"
    : processRef.kind === "debug_adapter" ? "debug.stop" : "repl.stop")
  const scope = validateScope(input.scope)
  const processRef = validateHostProcessRef(input.processRef)
  const kind = processKind(processRef.kind === "language_server" ? "language.start"
    : processRef.kind === "debug_adapter" ? "debug.start" : "repl.start")
  if (processRef.kind !== kind || ((scope.managedAttempt !== undefined || scope.directAttempt !== undefined) &&
      processRef.ownerEpoch !== (scope.managedAttempt?.ownerEpoch ?? scope.directAttempt!.ownerEpoch))) {
    throw new TypeError("cannot cancel a process outside the authenticated editor Attempt")
  }
  const status = decodeStatus(await input.requestHostKernel("execution.v1", "cancel", {
    executionID: processRef.executionID,
    effectID: input.effectID,
    challengeID: input.challengeID,
    locationID: scope.locationID,
    sessionID: scope.sessionID,
    capabilityLeaseDigest: digest(input.capabilityLeaseDigest, "capabilityLeaseDigest"),
    generation: processRef.generation,
    ...(scope.managedAttempt === undefined ? {} : { managedAttempt: scope.managedAttempt }),
    ...(scope.directAttempt === undefined ? {} : { directAttempt: scope.directAttempt }),
  }))
  if (status.executionID !== processRef.executionID || status.generation !== processRef.generation ||
      status.state === "RUNNING" || status.state === "PREPARED") {
    throw new EditorProcessOutcomeUnknownError("HostKernel cancellation did not return a terminal or cancelling status")
  }
  return status
}

/** Bounded raw output read for diagnostics; protocol traffic uses protocol_read instead. */
export async function readEditorProcessOutputV1(input: {
  readonly processRef: HostProcessRefV1
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityLeaseDigest: string
  readonly scope: EditorProcessLifecycleScopeV1
  readonly afterStdoutSequence: string
  readonly afterStderrSequence: string
  readonly maxBytes: number
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<EditorProcessOutputPageV1> {
  const scope = validateScope(input.scope)
  identifier(input.effectID, "effectID")
  const processRef = validateHostProcessRef(input.processRef)
  const generation = processRef.generation
  if ((scope.managedAttempt !== undefined || scope.directAttempt !== undefined) &&
      processRef.ownerEpoch !== (scope.managedAttempt?.ownerEpoch ?? scope.directAttempt!.ownerEpoch)) {
    throw new TypeError("output read cannot address a process outside the authenticated editor Attempt")
  }
  const stdout = decimal(input.afterStdoutSequence, "afterStdoutSequence", true)
  const stderr = decimal(input.afterStderrSequence, "afterStderrSequence", true)
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 256 * 1024) {
    throw new TypeError("process output page bound is invalid")
  }
  const raw = await input.requestHostKernel("execution.v1", "read", {
    executionID: processRef.executionID,
    effectID: input.effectID,
    challengeID: input.challengeID,
    locationID: scope.locationID,
    sessionID: scope.sessionID,
    capabilityLeaseDigest: digest(input.capabilityLeaseDigest, "capabilityLeaseDigest"),
    generation,
    afterStdoutSequence: stdout,
    afterStderrSequence: stderr,
    maxBytes: input.maxBytes,
    ...(scope.managedAttempt === undefined ? {} : { managedAttempt: scope.managedAttempt }),
    ...(scope.directAttempt === undefined ? {} : { directAttempt: scope.directAttempt }),
  })
  if (!record(raw) || !exactKeys(raw, [
    "executionID", "generation", "records", "nextStdoutSequence", "nextStderrSequence", "eof", "truncated", "state", "receiptDigest",
  ], ["receipt"]) || raw.executionID !== processRef.executionID || decimal(raw.generation, "output generation") !== generation ||
      !Array.isArray(raw.records) || raw.records.length > 4096 || typeof raw.eof !== "boolean" || typeof raw.truncated !== "boolean" ||
      (raw.state !== "PREPARED" && raw.state !== "RUNNING" && raw.state !== "CANCELLING" && raw.state !== "SETTLED" && raw.state !== "UNKNOWN")) {
    throw new TypeError("HostKernel output page is malformed or outside its bound")
  }
  let total = 0
  const records = raw.records.map((item) => {
    if (!record(item) || !exactKeys(item, ["source", "sequence", "bytes"]) ||
        (item.source !== "stdout" && item.source !== "stderr") || !(item.bytes instanceof Uint8Array)) {
      throw new TypeError("HostKernel output record is malformed")
    }
    const bytes = item.bytes.slice()
    total += bytes.byteLength
    if (total > input.maxBytes) throw new TypeError("HostKernel output page exceeds its byte bound")
    return Object.freeze({ source: item.source, sequence: decimal(item.sequence, "output sequence"), bytes })
  })
  const nextSequences = { stdout: BigInt(stdout), stderr: BigInt(stderr) }
  for (const item of records) {
    const expected = nextSequences[item.source] + 1n
    if (BigInt(item.sequence) !== expected) throw new TypeError("HostKernel output page contains a sequence gap or replay")
    nextSequences[item.source] = expected
  }
  const nextStdoutSequence = decimal(raw.nextStdoutSequence, "nextStdoutSequence", true)
  const nextStderrSequence = decimal(raw.nextStderrSequence, "nextStderrSequence", true)
  if (BigInt(nextStdoutSequence) !== nextSequences.stdout || BigInt(nextStderrSequence) !== nextSequences.stderr) {
    throw new TypeError("HostKernel output cursors do not match the returned records")
  }
  const receiptDigest = raw.receiptDigest === null ? null : digest(raw.receiptDigest, "output receiptDigest")
  let receipt: EditorProcessReceiptV1 | undefined
  if (raw.receipt !== undefined) {
    const value = raw.receipt
    if (!record(value) || !exactKeys(value, [
      "executionID", "effectID", "generation", "profileID", "profileRevision", "profileDigest",
      "executableDigest", "exitCode", "stdoutSequence", "stderrSequence", "stdoutDigest", "stderrDigest",
      "outputBytes", "truncated", "receiptDigest",
    ])) throw new TypeError("HostKernel output receipt is malformed")
    identifier(value.executionID, "receipt executionID")
    identifier(value.effectID, "receipt effectID")
    identifier(value.profileID, "receipt profileID")
    if (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < -255 || (value.exitCode as number) > 255)) {
      throw new TypeError("HostKernel output receipt exit code is invalid")
    }
    if (typeof value.truncated !== "boolean") throw new TypeError("HostKernel output receipt truncation flag is invalid")
    receipt = Object.freeze({
      executionID: value.executionID,
      effectID: value.effectID,
      generation: decimal(value.generation, "receipt generation"),
      profileID: value.profileID,
      profileRevision: decimal(value.profileRevision, "receipt profile revision"),
      profileDigest: digest(value.profileDigest, "receipt profile digest"),
      executableDigest: digest(value.executableDigest, "receipt executable digest"),
      exitCode: value.exitCode as number | null,
      stdoutSequence: decimal(value.stdoutSequence, "receipt stdoutSequence", true),
      stderrSequence: decimal(value.stderrSequence, "receipt stderrSequence", true),
      stdoutDigest: digest(value.stdoutDigest, "receipt stdoutDigest"),
      stderrDigest: digest(value.stderrDigest, "receipt stderrDigest"),
      outputBytes: decimal(value.outputBytes, "receipt outputBytes", true),
      truncated: value.truncated,
      receiptDigest: digest(value.receiptDigest, "receipt digest"),
    })
    if (receipt.executionID !== processRef.executionID || receipt.effectID !== input.effectID ||
        receipt.generation !== generation || receipt.profileID !== processRef.profileID ||
        receipt.profileRevision !== processRef.profileRevision || receipt.profileDigest !== processRef.profileDigest ||
        receipt.executableDigest !== processRef.executableDigest || raw.state !== "SETTLED" ||
        BigInt(receipt.stdoutSequence) < BigInt(nextStdoutSequence) || BigInt(receipt.stderrSequence) < BigInt(nextStderrSequence) ||
        (raw.eof && (receipt.stdoutSequence !== nextStdoutSequence || receipt.stderrSequence !== nextStderrSequence)) ||
        receipt.truncated !== raw.truncated || receipt.receiptDigest !== receiptDigest) {
      throw new TypeError("HostKernel output receipt differs from the settled output projection")
    }
  }
  if (raw.state === "SETTLED" && (receipt === undefined || receiptDigest === null)) {
    throw new TypeError("settled HostKernel output is missing its durable process receipt")
  }
  if (receipt === undefined && receiptDigest !== null) {
    throw new TypeError("HostKernel output receipt digest has no matching durable receipt")
  }
  if (raw.state !== "SETTLED" && receipt !== undefined) {
    throw new TypeError("HostKernel returned a terminal process receipt for an unsettled process")
  }
  return Object.freeze({
    executionID: processRef.executionID,
    generation,
    records: Object.freeze(records),
    nextStdoutSequence,
    nextStderrSequence,
    eof: raw.eof,
    truncated: raw.truncated,
    state: raw.state,
    receiptDigest,
    ...(receipt === undefined ? {} : { receipt }),
  })
}
