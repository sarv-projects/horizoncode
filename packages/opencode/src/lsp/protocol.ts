import { Schema } from "effect"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import { validateHostProcessRef, validateHostProcessScope, type HostProcessRefV1 } from "./process-scope"
import { assertHostProtocolAllowed } from "./launch"

const MAX_EVENTS = 64
const MAX_PAGE_BYTES = 1024 * 1024
const MAX_JSON_DEPTH = 24
const MAX_JSON_NODES = 16_384
const DECIMAL_U64 = /^(0|[1-9][0-9]*)$/
const MAX_U64 = 18_446_744_073_709_551_615n

export const LspServerRequestMethod = Schema.Literals([
  "window/workDoneProgress/create",
  "workspace/configuration",
  "client/registerCapability",
  "client/unregisterCapability",
  "workspace/workspaceFolders",
  "workspace/diagnostic/refresh",
])
export type LspServerRequestMethod = typeof LspServerRequestMethod.Type

/** HostKernel bounds callback JSON globally; Core additionally narrows each
 * callback payload before the LSP client uses it. In particular, extension
 * registrations cannot smuggle unhandled behavior into the client. */
export function validateLspServerRequestParamsV1(method: LspServerRequestMethod, input: unknown): unknown {
  boundedJson(input)
  const object = typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
  const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const keys = Object.keys(value)
    return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
  }
  const validString = (value: unknown, maximum = 512) => typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0")
  switch (method) {
    case "window/workDoneProgress/create":
      if (!exact(object, ["token"]) || !(validString(object?.token, 256) ||
        (typeof object?.token === "number" && Number.isSafeInteger(object.token) && object.token >= 0))) {
        throw new ProtocolError({ detail: "malformed LSP work-progress request" })
      }
      break
    case "workspace/configuration":
      if (!exact(object, ["items"]) || !Array.isArray(object?.items) || object.items.length > 256 ||
        !object.items.every((item) => exact(item, [], ["section", "scopeUri"]) &&
          (item.section === undefined || validString(item.section)) &&
          (item.scopeUri === undefined || (validString(item.scopeUri, 8 * 1024) && (() => {
            try { return new URL(item.scopeUri as string).protocol === "file:" } catch { return false }
          })())))) {
        throw new ProtocolError({ detail: "malformed LSP workspace configuration request" })
      }
      break
    case "client/registerCapability":
      if (!exact(object, ["registrations"]) || !Array.isArray(object?.registrations) || object.registrations.length > 64 ||
        !object.registrations.every((registration) => exact(registration, ["id", "method"], ["registerOptions"]) &&
          validString(registration.id, 256) && registration.method === "textDocument/diagnostic" &&
          (registration.registerOptions === undefined ||
            (exact(registration.registerOptions, [], ["identifier", "interFileDependencies", "workspaceDiagnostics"]) &&
              (registration.registerOptions.identifier === undefined || validString(registration.registerOptions.identifier, 256)) &&
              (registration.registerOptions.interFileDependencies === undefined || typeof registration.registerOptions.interFileDependencies === "boolean") &&
              (registration.registerOptions.workspaceDiagnostics === undefined || typeof registration.registerOptions.workspaceDiagnostics === "boolean"))))) {
        throw new ProtocolError({ detail: "malformed or unsupported LSP capability registration" })
      }
      break
    case "client/unregisterCapability":
      if (!exact(object, ["unregisterations"]) || !Array.isArray(object?.unregisterations) || object.unregisterations.length > 64 ||
        !object.unregisterations.every((registration) => exact(registration, ["id", "method"]) &&
          validString(registration.id, 256) && registration.method === "textDocument/diagnostic")) {
        throw new ProtocolError({ detail: "malformed or unsupported LSP capability unregistration" })
      }
      break
    case "workspace/workspaceFolders":
    case "workspace/diagnostic/refresh":
      if (!exact(object, [])) throw new ProtocolError({ detail: "malformed LSP empty callback parameters" })
      break
  }
  return freezeLspJson(input)
}

export const LspServerNotificationMethod = Schema.Literal("textDocument/publishDiagnostics")
export type LspServerNotificationMethod = typeof LspServerNotificationMethod.Type

export const LspRequestMethodV1 = Schema.Literals([
  "initialize",
  "shutdown",
  "textDocument/diagnostic",
  "workspace/diagnostic",
  "textDocument/definition",
  "textDocument/references",
  "textDocument/codeAction",
  "textDocument/rename",
  "textDocument/documentSymbol",
  "workspace/symbol",
])
export type LspRequestMethodV1 = typeof LspRequestMethodV1.Type

export const LspNotificationMethodV1 = Schema.Literals([
  "initialized",
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "workspace/didChangeConfiguration",
  "workspace/didChangeWatchedFiles",
  "$/cancelRequest",
  "exit",
])
export type LspNotificationMethodV1 = typeof LspNotificationMethodV1.Type

export type LspEventPageV1 = {
  readonly hostProcessRef: HostProcessRefV1
  readonly afterEventSequence: string
  readonly processIOSequence: string
  readonly workspaceRevision: string
  readonly status: "RUNNING" | "EXITED" | "UNKNOWN"
  readonly events: readonly LspBufferedEventV1[]
}

/** This wrapper is the exact Rust `ExecutionProtocolBufferedEventV1` projection. */
export type LspBufferedEventV1 =
  | {
      readonly protocol: "lsp"
      readonly messageKind: "notification"
      readonly payload: { readonly eventSequence: string; readonly method: LspServerNotificationMethod; readonly params: unknown }
    }
  | {
      readonly protocol: "lsp"
      readonly messageKind: "server_request"
      readonly payload: {
        readonly eventSequence: string
        readonly requestID: string | number
        readonly method: LspServerRequestMethod
        readonly params: unknown
      }
    }
  | {
      readonly protocol: "lsp"
      readonly messageKind: "response"
      readonly payload: {
        readonly schemaVersion: 1
        readonly eventSequence: string
        readonly requestSequence: string
        readonly requestID: string | number
        readonly method: LspRequestMethodV1
        readonly result?: unknown
        readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
      }
    }

export type LspEventReadRequestV1 = {
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly afterEventSequence: string
  readonly maxEvents: number
  readonly maxBytes: number
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

export function validateLspEventReadRequestV1(input: unknown): LspEventReadRequestV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP event read request" })
  }
  const request = input as Record<string, unknown>
  if (!exactKeys(request, [
    "hostProcessRef", "sessionID", "locationID", "workspaceRevision", "afterEventSequence", "maxEvents", "maxBytes",
  ], ["managedAttempt", "directAttempt"]) ||
    (request.managedAttempt !== undefined && request.directAttempt !== undefined)) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP event read request" })
  }
  let processRef: HostProcessRefV1
  try {
    processRef = validateHostProcessRef(request.hostProcessRef)
  } catch {
    throw new ProtocolError({ detail: "invalid HostKernel LSP event read process reference" })
  }
  if (processRef.kind !== "language_server" ||
    typeof request.sessionID !== "string" || !request.sessionID || request.sessionID.length > 160 ||
    typeof request.locationID !== "string" || !request.locationID || request.locationID.length > 160 ||
    typeof request.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(request.workspaceRevision) ||
    !canonicalU64(request.afterEventSequence) ||
    typeof request.maxEvents !== "number" || !Number.isSafeInteger(request.maxEvents) || request.maxEvents < 1 || request.maxEvents > MAX_EVENTS ||
    typeof request.maxBytes !== "number" || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > MAX_PAGE_BYTES) {
    throw new ProtocolError({ detail: "invalid HostKernel LSP event read fields" })
  }
  try {
    validateHostProcessScope({
      sessionID: request.sessionID,
      locationID: request.locationID,
      ownerEpoch: processRef.ownerEpoch,
      workspaceRevision: request.workspaceRevision,
      managedAttemptScope: request.managedAttempt as ManagedAttemptScopeV1 | undefined,
      directAttemptScope: request.directAttempt as DirectAttemptScopeV1 | undefined,
      workspaceID: (request.directAttempt as DirectAttemptScopeV1 | undefined)?.workspaceID,
    })
  } catch {
    throw new ProtocolError({ detail: "LSP event read Attempt scope does not match its process reference" })
  }
  return freezeLspJson(input) as LspEventReadRequestV1
}

/** Narrow adapter for the existing SessionSupervisor authenticated HostKernel RPC. */
export type ExecutionHostProtocolRequestV1 = (
  serviceID: "execution.v1",
  operation: "protocol_op" | "protocol_read" | "protocol_reply",
  body: Readonly<Record<string, unknown>>,
) => Promise<unknown>

export type LspProtocolOperationV1 = {
  readonly requestSequence: string
  readonly method: LspRequestMethodV1 | LspNotificationMethodV1
  readonly requestID?: string | number
  readonly params: Readonly<Record<string, unknown>> | readonly unknown[]
}

/** Exact authenticated body accepted by execution.v1/protocol_op. */
export type LspProtocolOperationRequestV1 = {
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: string
  readonly capabilityLeaseDigest: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly operation: LspProtocolOperationV1
}

const LSP_REQUEST_METHODS = new Set([
  "initialize",
  "shutdown",
  "textDocument/diagnostic",
  "workspace/diagnostic",
  "textDocument/definition",
  "textDocument/references",
  "textDocument/codeAction",
  "textDocument/rename",
  "textDocument/documentSymbol",
  "workspace/symbol",
])
const LSP_NOTIFICATION_METHODS = new Set([
  "initialized",
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "workspace/didChangeConfiguration",
  "workspace/didChangeWatchedFiles",
  "$/cancelRequest",
  "exit",
])

/** Exact Guard action for each supported LSP operation. Keep this in lockstep
 * with kernel::guard::language_protocol_capability; transport DTOs must not
 * let a caller choose a weaker/different capability for the same method. */
export function lspProtocolCapabilityV1(method: string): string | undefined {
  switch (method) {
    case "initialize":
    case "workspace/didChangeConfiguration":
      return "language.start"
    case "shutdown":
    case "exit":
      return "language.stop"
    case "initialized":
    case "textDocument/didOpen":
    case "textDocument/didChange":
    case "textDocument/didClose":
    case "workspace/didChangeWatchedFiles":
    case "$/cancelRequest":
    case "textDocument/diagnostic":
    case "workspace/diagnostic":
    case "textDocument/codeAction":
    case "window/workDoneProgress/create":
    case "workspace/workspaceFolders":
    case "workspace/diagnostic/refresh":
      return "language.diagnostics"
    case "textDocument/definition":
      return "definitions.find"
    case "textDocument/references":
    case "textDocument/rename":
      return "references.find"
    case "textDocument/documentSymbol":
      return "symbols.outline"
    case "workspace/symbol":
      return "symbols.search"
    default:
      return undefined
  }
}

/** Existing query-action name retained for callers that only classify queries. */
export function lspQueryCapabilityV1(method: string): string | undefined {
  const capability = lspProtocolCapabilityV1(method)
  return capability === "language.start" || capability === "language.stop" ? undefined : capability
}

/** Exact Guard action for the finite server→Core callback surface. */
export function lspServerRequestCapabilityV1(method: string): string | undefined {
  switch (method) {
    case "workspace/configuration":
    case "client/registerCapability":
    case "client/unregisterCapability":
      return "language.start"
    case "window/workDoneProgress/create":
    case "workspace/workspaceFolders":
    case "workspace/diagnostic/refresh":
      return "language.diagnostics"
    default:
      return undefined
  }
}

/** Strict Core-side projection for the method-bounded HostKernel operation
 * envelope. This validates a request shape; HostKernel remains the sole policy
 * owner and decides Guard/lease admission and whether the dispatch succeeds. */
export function validateLspProtocolOperationRequestV1(input: unknown): LspProtocolOperationRequestV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP operation" })
  }
  const request = input as Record<string, unknown>
  const required = [
    "hostProcessRef", "sessionID", "locationID", "workspaceRevision", "effectID",
    "challengeID", "capabilityID", "capabilityLeaseDigest", "operation",
  ]
  const allowed = new Set([...required, "managedAttempt", "directAttempt"])
  if (
    !exactKeys(request, required, ["managedAttempt", "directAttempt"]) ||
    (request.managedAttempt !== undefined && request.directAttempt !== undefined)
  ) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP operation" })
  }
  // Keep the explicit set check adjacent to the exact-key check: these strings
  // are part of the private protocol surface, not an extensible JSON-RPC API.
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    throw new ProtocolError({ detail: "unsupported HostKernel LSP operation fields" })
  }
  let processRef: HostProcessRefV1
  try {
    processRef = validateHostProcessRef(request.hostProcessRef)
  } catch {
    throw new ProtocolError({ detail: "invalid HostKernel LSP process reference" })
  }
  if (processRef.kind !== "language_server") {
    throw new ProtocolError({ detail: "LSP operation requires a language server process" })
  }
  if (typeof request.operation !== "object" || request.operation === null || Array.isArray(request.operation)) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP operation payload" })
  }
  const operation = request.operation as Record<string, unknown>
  if (!exactKeys(operation, ["requestSequence", "method", "params"], ["requestID"])) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP operation payload" })
  }
  const method = operation.method
  const isRequest = typeof method === "string" && LSP_REQUEST_METHODS.has(method)
  const isNotification = typeof method === "string" && LSP_NOTIFICATION_METHODS.has(method)
  const expectedCapability = typeof method === "string" ? lspProtocolCapabilityV1(method) : undefined
  if (
    !canonicalU64(operation.requestSequence) || operation.requestSequence === "0" ||
    (!isRequest && !isNotification) ||
    (isRequest && !validRequestID(operation.requestID)) ||
    (isNotification && Object.hasOwn(operation, "requestID")) ||
    typeof request.sessionID !== "string" || !request.sessionID || request.sessionID.length > 160 ||
    typeof request.locationID !== "string" || !request.locationID || request.locationID.length > 160 ||
    typeof request.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(request.workspaceRevision) ||
    typeof request.effectID !== "string" || !request.effectID || request.effectID.length > 160 ||
    typeof request.challengeID !== "string" || !request.challengeID || request.challengeID.length > 160 ||
    typeof request.capabilityID !== "string" || !request.capabilityID || request.capabilityID.length > 160 ||
    (expectedCapability === undefined || request.capabilityID !== expectedCapability) ||
    typeof request.capabilityLeaseDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(request.capabilityLeaseDigest)
  ) {
    throw new ProtocolError({ detail: "invalid HostKernel LSP operation fields" })
  }
  try {
    validateHostProcessScope({
      sessionID: request.sessionID as string,
      locationID: request.locationID as string,
      ownerEpoch: processRef.ownerEpoch,
      workspaceRevision: request.workspaceRevision as string,
      managedAttemptScope: request.managedAttempt as ManagedAttemptScopeV1 | undefined,
      directAttemptScope: request.directAttempt as DirectAttemptScopeV1 | undefined,
      workspaceID: (request.directAttempt as DirectAttemptScopeV1 | undefined)?.workspaceID,
    })
  } catch {
    throw new ProtocolError({ detail: "LSP operation Attempt scope does not match its authenticated process scope" })
  }
  if (!(Array.isArray(operation.params) || (typeof operation.params === "object" && operation.params !== null))) {
    throw new ProtocolError({ detail: "LSP operation params must be a JSON object or array" })
  }
  boundedJson(operation.params)
  const payloadBytes = encoder.encode(JSON.stringify(operation.params)).byteLength
  if (payloadBytes > MAX_PAGE_BYTES) throw new ProtocolError({ detail: "LSP operation payload exceeds bounds" })
  return freezeLspJson(input) as LspProtocolOperationRequestV1
}

export type HostProtocolDispatchReceiptV1 = {
  readonly schemaVersion: 1
  readonly hostProcessRef: HostProcessRefV1
  readonly requestSequence: string
  readonly processIOSequence: string
  readonly operationDigest: string
  readonly dispatchReceiptDigest: string
  readonly status: "DISPATCHED"
}

/** One outbound sequence allocator shared by protocol_op and protocol_reply
 * for a single immutable HostProcessRef generation. Instantiate once per
 * freshly admitted process and never reset it during that generation. */
export class OutboundProtocolSequenceV1 {
  #last = 0n
  readonly #processRef: HostProcessRefV1

  constructor(processRef: HostProcessRefV1) {
    this.#processRef = Object.freeze({ ...validateHostProcessRef(processRef) })
    if (this.#processRef.kind !== "language_server" && this.#processRef.kind !== "debug_adapter") {
      throw new ProtocolError({ detail: "protocol sequence requires an LSP or DAP process" })
    }
  }

  next(processRef: HostProcessRefV1): string {
    let observed: HostProcessRefV1
    try {
      observed = validateHostProcessRef(processRef)
    } catch {
      throw new ResnapshotRequiredError({ reason: "stale_process" })
    }
    if (!sameProcess(this.#processRef, observed)) throw new ResnapshotRequiredError({ reason: "stale_process" })
    if (this.#last >= MAX_U64) throw new ProtocolError({ detail: "outbound process sequence exhausted" })
    this.#last += 1n
    return this.#last.toString(10)
  }

  /** Roll back only the latest sequence after confirmed pre-dispatch denial.
   * Callers serialize allocation and dispatch before using this method. */
  rollback(sequence: string, processRef: HostProcessRefV1): void {
    let observed: HostProcessRefV1
    try {
      observed = validateHostProcessRef(processRef)
    } catch {
      throw new ResnapshotRequiredError({ reason: "stale_process" })
    }
    if (!sameProcess(this.#processRef, observed)) throw new ResnapshotRequiredError({ reason: "stale_process" })
    if (!canonicalU64(sequence) || sequence === "0" || BigInt(sequence) !== this.#last) {
      throw new ProtocolError({ detail: "only the latest outbound sequence can be rolled back" })
    }
    this.#last -= 1n
  }

  get lastIssued(): string {
    return this.#last.toString(10)
  }
}

export type LspProtocolReplyRequestV1 = {
  readonly schemaVersion: 1
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: string
  readonly capabilityLeaseDigest: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly reply: {
    readonly schemaVersion: 1
    /** Fresh outbound process sequence, shared with protocol_op. */
    readonly requestSequence: string
    readonly serverRequestID: string | number
    readonly method: LspServerRequestMethod
    readonly result: unknown
  }
}

/** Validate correlated replies to the finite set of HostKernel-buffered LSP
 * server requests. Arbitrary JSON-RPC response handlers are never exposed. */
export function validateLspProtocolReplyRequestV1(input: unknown): LspProtocolReplyRequestV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP protocol reply" })
  }
  const request = input as Record<string, unknown>
  const required = [
    "schemaVersion", "hostProcessRef", "sessionID", "locationID", "workspaceRevision",
    "effectID", "challengeID", "capabilityID", "capabilityLeaseDigest", "reply",
  ]
  if (
    !exactKeys(request, required, ["managedAttempt", "directAttempt"]) ||
    (request.managedAttempt !== undefined && request.directAttempt !== undefined) ||
    request.schemaVersion !== 1
  ) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP protocol reply" })
  }
  let processRef: HostProcessRefV1
  try {
    processRef = validateHostProcessRef(request.hostProcessRef)
  } catch {
    throw new ProtocolError({ detail: "invalid HostKernel LSP reply process reference" })
  }
  if (processRef.kind !== "language_server") {
    throw new ProtocolError({ detail: "LSP reply requires a language server process" })
  }
  const stringFields = ["sessionID", "locationID", "effectID", "challengeID", "capabilityID"]
  if (
    stringFields.some((key) => typeof request[key] !== "string" || !(request[key] as string).trim() || (request[key] as string).length > 160) ||
    typeof request.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(request.workspaceRevision) ||
    typeof request.capabilityLeaseDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(request.capabilityLeaseDigest) ||
    typeof request.reply !== "object" || request.reply === null || Array.isArray(request.reply)
  ) {
    throw new ProtocolError({ detail: "invalid HostKernel LSP reply fields" })
  }
  try {
    validateHostProcessScope({
      sessionID: request.sessionID as string,
      locationID: request.locationID as string,
      ownerEpoch: processRef.ownerEpoch,
      workspaceRevision: request.workspaceRevision as string,
      managedAttemptScope: request.managedAttempt as ManagedAttemptScopeV1 | undefined,
      directAttemptScope: request.directAttempt as DirectAttemptScopeV1 | undefined,
      workspaceID: (request.directAttempt as DirectAttemptScopeV1 | undefined)?.workspaceID,
    })
  } catch {
    throw new ProtocolError({ detail: "LSP reply Attempt scope does not match its authenticated process scope" })
  }
  const reply = request.reply as Record<string, unknown>
  if (
    !exactKeys(reply, ["schemaVersion", "requestSequence", "serverRequestID", "method", "result"]) ||
    reply.schemaVersion !== 1 ||
    !canonicalU64(reply.requestSequence) || reply.requestSequence === "0" ||
    !validRequestID(reply.serverRequestID) || !Schema.is(LspServerRequestMethod)(reply.method) ||
    request.capabilityID !== lspServerRequestCapabilityV1(reply.method)
  ) {
    throw new ProtocolError({ detail: "invalid HostKernel LSP correlated reply" })
  }
  boundedJson(reply.result)
  if (encoder.encode(JSON.stringify(reply.result)).byteLength > MAX_PAGE_BYTES) {
    throw new ProtocolError({ detail: "HostKernel LSP reply result exceeds bounds" })
  }
  switch (reply.method) {
    case "window/workDoneProgress/create":
    case "client/registerCapability":
    case "client/unregisterCapability":
    case "workspace/diagnostic/refresh":
      if (reply.result !== null) throw new ProtocolError({ detail: "invalid HostKernel LSP null reply" })
      break
    case "workspace/configuration":
      if (!Array.isArray(reply.result)) throw new ProtocolError({ detail: "invalid HostKernel LSP configuration reply" })
      break
    case "workspace/workspaceFolders":
      if (reply.result !== null && !Array.isArray(reply.result)) {
        throw new ProtocolError({ detail: "invalid HostKernel LSP workspace-folder reply" })
      }
      break
  }
  return freezeLspJson(input) as LspProtocolReplyRequestV1
}

/** An unusable event cursor invalidates this process generation. The caller
 * must quarantine it and expose UNKNOWN; no cursor reset or automatic relaunch. */
export class ResnapshotRequiredError extends Schema.TaggedErrorClass<ResnapshotRequiredError>()(
  "LSPResnapshotRequiredError",
  {
    reason: Schema.Literals(["stale_process", "stale_workspace", "cursor_gap", "unknown_process"]),
  },
) {}

export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("LSPHostProtocolError", {
  detail: Schema.String,
}) {}

/** Guard or a deterministic HostKernel admission rejected an operation before
 * the durable protocol journal could consume its outbound sequence. */
export class ProtocolAdmissionDeniedError extends Schema.TaggedErrorClass<ProtocolAdmissionDeniedError>()(
  "LSPProtocolAdmissionDeniedError",
  {
    operation: Schema.String,
    hostCode: Schema.optional(Schema.String),
  },
) {}

/** The request may have reached process IO or its durable receipt may be lost.
 * The current process generation must be quarantined; never retry the frame. */
export class ProtocolDispatchUncertainError extends Schema.TaggedErrorClass<ProtocolDispatchUncertainError>()(
  "LSPProtocolDispatchUncertainError",
  { operation: Schema.String },
) {}

/** Authenticated read completed but its returned page was unusable. The
 * durable cursor may have advanced, so the current projection must stop. */
export class ProtocolReadUncertainError extends Schema.TaggedErrorClass<ProtocolReadUncertainError>()(
  "LSPProtocolReadUncertainError",
  { operation: Schema.String },
) {}

const PRE_DISPATCH_HOST_CODES = new Set([
  "invalid_effect_request",
  "effect_denied",
  "stale_workspace_revision",
  "capability_unavailable",
  "feature_not_negotiated",
  "location_not_registered",
  "approval_not_found",
])

/** HostKernel reports stable RPC codes through SessionSupervisorError.hostCode.
 * Absence of one of these explicit pre-dispatch codes is treated as uncertain. */
export function protocolHostErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const value = error as Record<string, unknown>
  return typeof value.hostCode === "string" ? value.hostCode : undefined
}

export function isDefinitiveProtocolAdmissionFailure(error: unknown): boolean {
  if (error instanceof ProtocolError || error instanceof ProtocolAdmissionDeniedError) return true
  const code = protocolHostErrorCode(error)
  return code !== undefined && PRE_DISPATCH_HOST_CODES.has(code)
}

export function validateDispatchReceiptV1(
  processRefInput: HostProcessRefV1,
  requestSequence: string,
  input: unknown,
): HostProtocolDispatchReceiptV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolError({ detail: "malformed HostKernel dispatch receipt" })
  }
  const receipt = input as Record<string, unknown>
  if (
    !exactKeys(receipt, [
      "schemaVersion",
      "hostProcessRef",
      "requestSequence",
      "processIOSequence",
      "operationDigest",
      "dispatchReceiptDigest",
      "status",
    ]) ||
    receipt.schemaVersion !== 1 ||
    !canonicalU64(requestSequence) || requestSequence === "0" ||
    receipt.requestSequence !== requestSequence ||
    !canonicalU64(receipt.processIOSequence) || receipt.processIOSequence === "0" ||
    !/^blake3:[0-9a-f]{64}$/.test(String(receipt.operationDigest)) ||
    !/^blake3:[0-9a-f]{64}$/.test(String(receipt.dispatchReceiptDigest)) ||
    receipt.status !== "DISPATCHED"
  ) {
    throw new ProtocolError({ detail: "invalid HostKernel dispatch receipt" })
  }
  let returnedRef: HostProcessRefV1
  try {
    returnedRef = validateHostProcessRef(receipt.hostProcessRef)
  } catch {
    throw new ProtocolError({ detail: "invalid HostKernel dispatch process reference" })
  }
  if (!sameProcess(processRefInput, returnedRef)) {
    throw new ResnapshotRequiredError({ reason: "stale_process" })
  }
  return input as HostProtocolDispatchReceiptV1
}

/** Bind the durable HostKernel acknowledgement to the exact process generation
 * and outbound sequence that Core submitted. This is only an acknowledgement;
 * correlated protocol responses are consumed later from protocol_read. */
export function validateProtocolDispatchReceiptV1(
  request: LspProtocolOperationRequestV1,
  input: unknown,
): HostProtocolDispatchReceiptV1 {
  const validatedRequest = validateLspProtocolOperationRequestV1(request)
  let processRef: HostProcessRefV1
  try {
    processRef = validateHostProcessRef(validatedRequest.hostProcessRef)
  } catch {
    throw new ProtocolError({ detail: "invalid LSP dispatch process reference" })
  }
  if (
    processRef.kind !== "language_server" ||
    !canonicalU64(validatedRequest.operation.requestSequence) ||
    validatedRequest.operation.requestSequence === "0"
  ) {
    throw new ProtocolError({ detail: "invalid LSP dispatch request" })
  }
  return validateDispatchReceiptV1(processRef, validatedRequest.operation.requestSequence, input)
}

/** Safe typed adapter helper: validate before crossing the injected HostKernel
 * seam and validate the durable receipt before exposing success to a caller. */
export async function dispatchLspProtocolOperationV1(
  input: unknown,
  dispatch: (request: LspProtocolOperationRequestV1) => Promise<unknown>,
): Promise<HostProtocolDispatchReceiptV1> {
  assertHostProtocolAllowed()
  const request = validateLspProtocolOperationRequestV1(input)
  const receipt = await dispatch(request)
  return validateProtocolDispatchReceiptV1(request, receipt)
}

export function validateProtocolReplyDispatchReceiptV1(
  request: LspProtocolReplyRequestV1,
  input: unknown,
): HostProtocolDispatchReceiptV1 {
  const validatedRequest = validateLspProtocolReplyRequestV1(request)
  return validateDispatchReceiptV1(
    validatedRequest.hostProcessRef,
    validatedRequest.reply.requestSequence,
    input,
  )
}

export async function dispatchLspProtocolReplyV1(
  input: unknown,
  dispatch: (request: LspProtocolReplyRequestV1) => Promise<unknown>,
): Promise<HostProtocolDispatchReceiptV1> {
  assertHostProtocolAllowed()
  const request = validateLspProtocolReplyRequestV1(input)
  const receipt = await dispatch(request)
  return validateProtocolReplyDispatchReceiptV1(request, receipt)
}

/**
 * Bind the validated LSP DTOs to SessionSupervisor's existing authenticated
 * HostKernel route. HostKernel owns the durable journal, one-use Guard lease,
 * process IO and event cursor; this adapter only validates the exact receipt
 * or bounded page before returning it to the P4 client.
 */
export function createHostKernelLspProtocolAdapterV1(requestHostKernel: ExecutionHostProtocolRequestV1) {
  return Object.freeze({
    protocolOp: async (input: unknown) => {
      assertHostProtocolAllowed()
      const request = validateLspProtocolOperationRequestV1(input)
      const response = await requestHostKernel("execution.v1", "protocol_op", request)
      try {
        return validateProtocolDispatchReceiptV1(request, response)
      } catch {
        throw new ProtocolDispatchUncertainError({ operation: request.operation.method })
      }
    },
    protocolReply: async (input: unknown) => {
      assertHostProtocolAllowed()
      const request = validateLspProtocolReplyRequestV1(input)
      const response = await requestHostKernel("execution.v1", "protocol_reply", request)
      try {
        return validateProtocolReplyDispatchReceiptV1(request, response)
      } catch {
        throw new ProtocolDispatchUncertainError({ operation: request.reply.method })
      }
    },
    protocolRead: async (request: LspEventReadRequestV1) => {
      assertHostProtocolAllowed()
      const validated = validateLspEventReadRequestV1(request)
      const response = await requestHostKernel("execution.v1", "protocol_read", validated)
      try {
        return validateEventPageV1(validated, response)
      } catch {
        throw new ProtocolReadUncertainError({ operation: "protocol_read" })
      }
    },
  })
}

const encoder = new TextEncoder()

function freezeLspJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeLspJson))
  if (typeof value !== "object" || value === null) return value
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeLspJson(item)])))
}

/** Validate and detach operation params before Core requests a Guard decision.
 * The full HostKernel DTO is checked again after the lease is attached. */
export function validateLspProtocolParamsV1(input: unknown): Readonly<Record<string, unknown>> | readonly unknown[] {
  const value = freezeLspJson(input)
  if (typeof value !== "object" || value === null) {
    throw new ProtocolError({ detail: "LSP operation params must be an object or array" })
  }
  return value as Readonly<Record<string, unknown>> | readonly unknown[]
}

function canonicalU64(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL_U64.test(value)) return false
  try {
    return BigInt(value) <= MAX_U64
  } catch {
    return false
  }
}

function boundedJson(value: unknown, depth = 0, nodes = { value: 0 }): void {
  nodes.value += 1
  if (nodes.value > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new ProtocolError({ detail: "LSP event exceeds JSON bounds" })
  }
  if (value === null || typeof value === "boolean") return
  if (typeof value === "string") {
    if (value.includes("\0")) throw new ProtocolError({ detail: "LSP event contains an invalid string" })
    return
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProtocolError({ detail: "LSP event is not JSON" })
    return
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).some((key) => {
      if (key === "length") return false
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true
      const index = Number(key)
      return !Number.isSafeInteger(index) || index >= value.length
    })) throw new ProtocolError({ detail: "LSP value must contain plain JSON arrays" })
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new ProtocolError({ detail: "LSP value must contain plain JSON arrays" })
      }
      boundedJson(descriptor.value, depth + 1, nodes)
    }
    return
  }
  if (typeof value !== "object") throw new ProtocolError({ detail: "LSP event is not JSON" })
  if (!plainDataRecord(value)) {
    throw new ProtocolError({ detail: "LSP event must contain plain JSON objects" })
  }
  for (const key of Object.keys(value)) {
    if (key.includes("\0")) throw new ProtocolError({ detail: "LSP event contains an invalid field" })
    boundedJson((value as Record<string, unknown>)[key], depth + 1, nodes)
  }
}

function plainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false
  }
  return true
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function sameProcess(left: HostProcessRefV1, right: HostProcessRefV1): boolean {
  return (
    left.executionID === right.executionID &&
    left.generation === right.generation &&
    left.ownerEpoch === right.ownerEpoch &&
    left.kind === right.kind &&
    left.profileID === right.profileID &&
    left.profileRevision === right.profileRevision &&
    left.profileDigest === right.profileDigest &&
    left.executableDigest === right.executableDigest
  )
}

function validRequestID(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.length > 0 && encoder.encode(value).byteLength <= 128 && !/[\x00-\x1f\x7f]/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  )
}

/** Decode a bounded page and enforce its process, revision and contiguous
 * event cursor before any notification or request reaches the client. */
export function validateEventPageV1(request: LspEventReadRequestV1, input: unknown): LspEventPageV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP event page" })
  }
  const page = input as Record<string, unknown>
  if (!exactKeys(page, ["hostProcessRef", "afterEventSequence", "processIOSequence", "workspaceRevision", "status", "events"])) {
    throw new ProtocolError({ detail: "malformed HostKernel LSP event page" })
  }
  let processRef: HostProcessRefV1
  try {
    processRef = validateHostProcessRef(page.hostProcessRef)
  } catch {
    throw new ProtocolError({ detail: "invalid HostKernel LSP process reference" })
  }
  if (processRef.kind !== "language_server") throw new ProtocolError({ detail: "LSP event page requires a language server" })
  if (
    !canonicalU64(request.afterEventSequence) ||
    typeof request.sessionID !== "string" || !request.sessionID || request.sessionID.length > 160 ||
    typeof request.locationID !== "string" || !request.locationID || request.locationID.length > 160 ||
    typeof request.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(request.workspaceRevision)
  ) throw new ProtocolError({ detail: "invalid LSP event read scope or cursor" })
  try {
    validateHostProcessScope({
      sessionID: request.sessionID,
      locationID: request.locationID,
      ownerEpoch: processRef.ownerEpoch,
      workspaceRevision: request.workspaceRevision,
      managedAttemptScope: request.managedAttempt,
      directAttemptScope: request.directAttempt,
      workspaceID: request.directAttempt?.workspaceID,
    })
  } catch {
    throw new ProtocolError({ detail: "LSP event read Attempt scope does not match its process reference" })
  }
  if (!sameProcess(request.hostProcessRef, processRef)) {
    throw new ResnapshotRequiredError({ reason: "stale_process" })
  }
  if (page.workspaceRevision !== request.workspaceRevision) {
    throw new ResnapshotRequiredError({ reason: "stale_workspace" })
  }
  if (page.afterEventSequence !== request.afterEventSequence) {
    throw new ResnapshotRequiredError({ reason: "cursor_gap" })
  }
  if (
    !canonicalU64(page.processIOSequence) ||
    typeof page.workspaceRevision !== "string" ||
    !/^blake3:[0-9a-f]{64}$/.test(page.workspaceRevision) ||
    !["RUNNING", "EXITED", "UNKNOWN"].includes(String(page.status)) ||
    !Array.isArray(page.events) ||
    !Number.isSafeInteger(request.maxEvents) ||
    page.events.length > Math.min(MAX_EVENTS, request.maxEvents) ||
    request.maxEvents < 1 || request.maxEvents > MAX_EVENTS ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < 1 || request.maxBytes > MAX_PAGE_BYTES
  ) {
    throw new ProtocolError({ detail: "invalid or over-limit HostKernel LSP event page" })
  }
  boundedJson(page)
  if (encoder.encode(JSON.stringify(page)).byteLength > request.maxBytes) {
    throw new ProtocolError({ detail: "HostKernel LSP event page exceeds its byte limit" })
  }

  let cursor = BigInt(request.afterEventSequence)
  for (const raw of page.events) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ProtocolError({ detail: "malformed HostKernel LSP event" })
    }
    const event = raw as Record<string, unknown>
    if (event.protocol !== "lsp" || !exactKeys(event, ["protocol", "messageKind", "payload"])) {
      throw new ProtocolError({ detail: "unsupported HostKernel LSP event kind" })
    }
    const payload = event.payload
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new ProtocolError({ detail: "malformed HostKernel LSP event payload" })
    }
    const body = payload as Record<string, unknown>
    if (event.messageKind === "notification") {
      if (
        !exactKeys(body, ["eventSequence", "method", "params"]) ||
        body.method !== "textDocument/publishDiagnostics" ||
        !(Array.isArray(body.params) || (typeof body.params === "object" && body.params !== null))
      ) {
        throw new ProtocolError({ detail: "unsupported HostKernel LSP notification" })
      }
    } else if (event.messageKind === "server_request") {
      if (
        !exactKeys(body, ["eventSequence", "requestID", "method", "params"]) ||
        !Schema.is(LspServerRequestMethod)(body.method) ||
        !validRequestID(body.requestID) ||
        !(Array.isArray(body.params) || (typeof body.params === "object" && body.params !== null))
      ) {
        throw new ProtocolError({ detail: "unsupported HostKernel LSP server request" })
      }
    } else if (event.messageKind === "response") {
      const hasResult = Object.hasOwn(body, "result")
      const hasError = Object.hasOwn(body, "error")
      const allowedResponseKeys = ["schemaVersion", "eventSequence", "requestSequence", "requestID", "method"]
      const optionalResponseKeys = ["result", "error"]
      const responseKeys = new Set([...allowedResponseKeys, ...optionalResponseKeys])
      if (
        !allowedResponseKeys.every((key) => Object.hasOwn(body, key)) ||
        Object.keys(body).some((key) => !responseKeys.has(key)) ||
        body.schemaVersion !== 1 ||
        !canonicalU64(body.requestSequence) ||
        body.requestSequence === "0" ||
        !validRequestID(body.requestID) ||
        typeof body.method !== "string" ||
        ![
          "initialize",
          "shutdown",
          "textDocument/diagnostic",
          "workspace/diagnostic",
          "textDocument/definition",
          "textDocument/references",
          "textDocument/codeAction",
          "textDocument/rename",
          "textDocument/documentSymbol",
          "workspace/symbol",
        ].includes(body.method) ||
        hasResult === hasError
      ) {
        throw new ProtocolError({ detail: "invalid HostKernel LSP response event" })
      }
      if (hasError) {
        if (typeof body.error !== "object" || body.error === null || Array.isArray(body.error)) {
          throw new ProtocolError({ detail: "invalid HostKernel LSP error response" })
        }
        const errorBody = body.error as Record<string, unknown>
        if (
          !exactKeys(errorBody, ["code", "message"], ["data"]) ||
          typeof errorBody.code !== "number" || !Number.isSafeInteger(errorBody.code) ||
          typeof errorBody.message !== "string" ||
          encoder.encode(errorBody.message).byteLength > 4096 ||
          /[\x00-\x1f\x7f]/.test(errorBody.message)
        ) {
          throw new ProtocolError({ detail: "invalid HostKernel LSP error response" })
        }
      }
    } else {
      throw new ProtocolError({ detail: "unsupported HostKernel LSP event kind" })
    }
    if (!canonicalU64(body.eventSequence)) throw new ProtocolError({ detail: "invalid LSP event sequence" })
    const next = BigInt(body.eventSequence)
    if (next !== cursor + 1n) throw new ResnapshotRequiredError({ reason: "cursor_gap" })
    cursor = next
  }
  if (page.status === "UNKNOWN") throw new ResnapshotRequiredError({ reason: "unknown_process" })
  return freezeLspJson(input) as LspEventPageV1
}

/** Per-process replay cursor. A failed page permanently quarantines this local
 * projection; callers cannot recover by skipping to a newer cursor. */
export class LspEventCursorV1 {
  #afterEventSequence = "0"
  #quarantined = false
  #lastAccepted?: { readonly requestedAfter: string; readonly serialized: string; readonly page: LspEventPageV1 }

  constructor(
    readonly hostProcessRef: HostProcessRefV1,
    readonly sessionID: string,
    readonly locationID: string,
    readonly workspaceRevision: string,
    readonly managedAttempt?: ManagedAttemptScopeV1,
    readonly directAttempt?: DirectAttemptScopeV1,
  ) {}

  get afterEventSequence(): string {
    return this.#afterEventSequence
  }

  get quarantined(): boolean {
    return this.#quarantined
  }

  accept(input: unknown): LspEventPageV1 {
    if (this.#quarantined) throw new ResnapshotRequiredError({ reason: "unknown_process" })
    try {
      // HostKernel read pages are replayable. A transport retry may therefore
      // return the exact last page even after this local cursor advanced. Treat
      // that byte-for-byte replay as already applied so notifications and
      // correlated replies are never delivered twice.
      if (
        typeof input === "object" && input !== null && !Array.isArray(input) &&
        (input as Record<string, unknown>).afterEventSequence !== this.#afterEventSequence
      ) {
        const serialized = JSON.stringify(input)
        if (typeof serialized !== "string") throw new ProtocolError({ detail: "invalid replayed LSP page" })
        if (
          this.#lastAccepted &&
          (input as Record<string, unknown>).afterEventSequence === this.#lastAccepted.requestedAfter &&
          serialized === this.#lastAccepted.serialized
        ) {
          return { ...this.#lastAccepted.page, events: [] }
        }
        throw new ResnapshotRequiredError({ reason: "cursor_gap" })
      }
      const page = validateEventPageV1(
        {
          hostProcessRef: this.hostProcessRef,
          sessionID: this.sessionID,
          locationID: this.locationID,
          workspaceRevision: this.workspaceRevision,
          afterEventSequence: this.#afterEventSequence,
          maxEvents: MAX_EVENTS,
          maxBytes: MAX_PAGE_BYTES,
          ...(this.managedAttempt === undefined ? {} : { managedAttempt: this.managedAttempt }),
          ...(this.directAttempt === undefined ? {} : { directAttempt: this.directAttempt }),
        },
        input,
      )
      if (page.status === "EXITED") this.#quarantined = true
      const serialized = JSON.stringify(input)
      if (typeof serialized !== "string") throw new ProtocolError({ detail: "invalid HostKernel LSP event page" })
      this.#lastAccepted = {
        requestedAfter: this.#afterEventSequence,
        serialized,
        page,
      }
      const last = page.events.at(-1)
      if (last) this.#afterEventSequence = last.payload.eventSequence
      return page
    } catch (error) {
      this.#quarantined = true
      throw error
    }
  }
}

/** Core-side correlation state for the durable outbound receipt and retained
 * inbound events. HostKernel is still the authority for its journal and
 * digest preimages; this ledger rejects mismatched acknowledgements and
 * responses before they reach the LSP client. */
export class LspProtocolJournalV1 {
  #lastRequestSequence = 0n
  #lastProcessIOSequence = 0n
  #lastEventSequence = 0n
  #quarantined = false
  #acceptedDispatches = new Map<string, { readonly requestFingerprint: string; readonly receipt: HostProtocolDispatchReceiptV1 }>()
  #pendingResponses = new Map<string, { readonly requestID: string | number; readonly method: string }>()
  #pendingServerRequests = new Map<string, string>()

  readonly hostProcessRef: HostProcessRefV1

  constructor(hostProcessRef: HostProcessRefV1, readonly workspaceRevision: string) {
    const processRef = validateHostProcessRef(hostProcessRef)
    if (processRef.kind !== "language_server") throw new ProtocolError({ detail: "LSP journal requires a language server" })
    if (!/^blake3:[0-9a-f]{64}$/.test(workspaceRevision)) throw new ProtocolError({ detail: "LSP journal requires a workspace revision" })
    this.hostProcessRef = Object.freeze({ ...processRef })
  }

  get quarantined(): boolean {
    return this.#quarantined
  }

  acceptOperation(requestInput: unknown, receiptInput: unknown): HostProtocolDispatchReceiptV1 {
    this.#assertLive()
    try {
      const request = validateLspProtocolOperationRequestV1(requestInput)
      if (!sameProcess(this.hostProcessRef, request.hostProcessRef)) {
        throw new ResnapshotRequiredError({ reason: "stale_process" })
      }
      if (request.workspaceRevision !== this.workspaceRevision) {
        throw new ResnapshotRequiredError({ reason: "stale_workspace" })
      }
      const sequence = BigInt(request.operation.requestSequence)
      if (sequence <= this.#lastRequestSequence) {
        return this.#replayAccepted(sequence.toString(10), request, receiptInput)
      }
      this.#assertNextSequence(request.operation.requestSequence)
      const receipt = validateProtocolDispatchReceiptV1(request, receiptInput)
      this.#assertProcessIOSequence(receipt.processIOSequence)
      if (LSP_REQUEST_METHODS.has(request.operation.method)) {
        const requestID = request.operation.requestID!
        const key = this.#sequenceKey(request.operation.requestSequence)
        if ([...this.#pendingResponses.values()].some((pending) => this.#requestIDKey(pending.requestID) === this.#requestIDKey(requestID))) {
          throw new ProtocolError({ detail: "duplicate pending LSP request ID" })
        }
        this.#pendingResponses.set(key, { requestID, method: request.operation.method })
      }
      this.#lastRequestSequence = BigInt(request.operation.requestSequence)
      this.#lastProcessIOSequence = BigInt(receipt.processIOSequence)
      this.#rememberAccepted(this.#lastRequestSequence.toString(10), request, receipt)
      return receipt
    } catch (error) {
      this.#quarantined = true
      throw error
    }
  }

  acceptProtocolReply(requestInput: unknown, receiptInput: unknown): HostProtocolDispatchReceiptV1 {
    this.#assertLive()
    try {
      const request = validateLspProtocolReplyRequestV1(requestInput)
      if (!sameProcess(this.hostProcessRef, request.hostProcessRef)) {
        throw new ResnapshotRequiredError({ reason: "stale_process" })
      }
      if (request.workspaceRevision !== this.workspaceRevision) {
        throw new ResnapshotRequiredError({ reason: "stale_workspace" })
      }
      const sequence = BigInt(request.reply.requestSequence)
      if (sequence <= this.#lastRequestSequence) {
        return this.#replayAccepted(sequence.toString(10), request, receiptInput)
      }
      this.#assertNextSequence(request.reply.requestSequence)
      const requestKey = this.#serverRequestKey(request.reply.serverRequestID, request.reply.method)
      if (!this.#pendingServerRequests.has(requestKey)) {
        throw new ResnapshotRequiredError({ reason: "cursor_gap" })
      }
      const receipt = validateProtocolReplyDispatchReceiptV1(request, receiptInput)
      this.#assertProcessIOSequence(receipt.processIOSequence)
      this.#pendingServerRequests.delete(requestKey)
      this.#lastRequestSequence = BigInt(request.reply.requestSequence)
      this.#lastProcessIOSequence = BigInt(receipt.processIOSequence)
      this.#rememberAccepted(this.#lastRequestSequence.toString(10), request, receipt)
      return receipt
    } catch (error) {
      this.#quarantined = true
      throw error
    }
  }

  acceptPage(page: LspEventPageV1): void {
    this.#assertLive()
    try {
      const processRef = validateHostProcessRef(page.hostProcessRef)
      if (!sameProcess(this.hostProcessRef, processRef)) throw new ResnapshotRequiredError({ reason: "stale_process" })
      if (page.workspaceRevision !== this.workspaceRevision) {
        throw new ResnapshotRequiredError({ reason: "stale_workspace" })
      }
      if (!canonicalU64(page.processIOSequence)) throw new ProtocolError({ detail: "invalid LSP process IO sequence" })
      const processIOSequence = BigInt(page.processIOSequence)
      if (processIOSequence < this.#lastProcessIOSequence) {
        throw new ResnapshotRequiredError({ reason: "cursor_gap" })
      }
      if (page.afterEventSequence !== this.#lastEventSequence.toString(10)) {
        const replayCursor = BigInt(page.afterEventSequence)
        if (
          page.events.length === 0 && page.status === "RUNNING" &&
          replayCursor < this.#lastEventSequence && processIOSequence <= this.#lastProcessIOSequence
        ) return
        throw new ResnapshotRequiredError({ reason: "cursor_gap" })
      }
      for (const event of page.events) {
        const payload = event.payload
        const eventSequence = BigInt(payload.eventSequence)
        if (eventSequence !== this.#lastEventSequence + 1n) throw new ResnapshotRequiredError({ reason: "cursor_gap" })
        this.#lastEventSequence = eventSequence
        if (event.messageKind === "response") {
          const key = this.#sequenceKey(payload.requestSequence)
          const pending = this.#pendingResponses.get(key)
          if (
            !pending ||
            this.#requestIDKey(pending.requestID) !== this.#requestIDKey(payload.requestID) ||
            pending.method !== payload.method
          ) {
            throw new ResnapshotRequiredError({ reason: "cursor_gap" })
          }
          this.#pendingResponses.delete(key)
        }
        if (event.messageKind === "server_request") {
          const key = this.#serverRequestKey(payload.requestID, payload.method)
          if (this.#pendingServerRequests.has(key)) {
            throw new ResnapshotRequiredError({ reason: "cursor_gap" })
          }
          this.#pendingServerRequests.set(key, payload.eventSequence)
        }
      }
      if (processIOSequence > this.#lastProcessIOSequence) this.#lastProcessIOSequence = processIOSequence
      if (page.status === "UNKNOWN" || page.status === "EXITED") this.#quarantined = true
    } catch (error) {
      this.#quarantined = true
      throw error
    }
  }

  #assertLive() {
    if (this.#quarantined) throw new ResnapshotRequiredError({ reason: "unknown_process" })
  }

  #assertNextSequence(value: string) {
    if (!canonicalU64(value) || BigInt(value) !== this.#lastRequestSequence + 1n) {
      throw new ResnapshotRequiredError({ reason: "cursor_gap" })
    }
  }

  #assertProcessIOSequence(value: string) {
    if (!canonicalU64(value) || BigInt(value) <= this.#lastProcessIOSequence) {
      throw new ResnapshotRequiredError({ reason: "cursor_gap" })
    }
  }

  #replayAccepted(sequence: string, request: unknown, receiptInput: unknown): HostProtocolDispatchReceiptV1 {
    const accepted = this.#acceptedDispatches.get(sequence)
    const receipt = validateDispatchReceiptV1(this.hostProcessRef, sequence, receiptInput)
    if (
      !accepted ||
      accepted.requestFingerprint !== stableFingerprint(request) ||
      !sameDispatchReceipt(accepted.receipt, receipt)
    ) {
      throw new ResnapshotRequiredError({ reason: "cursor_gap" })
    }
    return accepted.receipt
  }

  #rememberAccepted(sequence: string, request: unknown, receipt: HostProtocolDispatchReceiptV1) {
    this.#acceptedDispatches.set(sequence, {
      requestFingerprint: stableFingerprint(request),
      receipt: Object.freeze({ ...receipt }),
    })
    while (this.#acceptedDispatches.size > 64) {
      const oldest = this.#acceptedDispatches.keys().next().value
      if (oldest === undefined) break
      this.#acceptedDispatches.delete(oldest)
    }
  }

  #sequenceKey(value: string) {
    return value
  }

  #requestIDKey(value: string | number) {
    return `${typeof value}:${value}`
  }

  #serverRequestKey(id: string | number, method: string) {
    return `${this.#requestIDKey(id)}\0${method}`
  }
}

function stableFingerprint(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (typeof item !== "object" || item === null) return item
    const output: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(item).sort()) output[key] = normalize((item as Record<string, unknown>)[key])
    return output
  }
  return JSON.stringify(normalize(value))
}

function sameDispatchReceipt(left: HostProtocolDispatchReceiptV1, right: HostProtocolDispatchReceiptV1): boolean {
  return left.requestSequence === right.requestSequence &&
    left.processIOSequence === right.processIOSequence &&
    left.operationDigest === right.operationDigest &&
    left.dispatchReceiptDigest === right.dispatchReceiptDigest &&
    left.status === right.status && sameProcess(left.hostProcessRef, right.hostProcessRef)
}

export * as LSPProtocol from "./protocol"
