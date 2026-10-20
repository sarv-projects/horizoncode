import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import { LANGUAGE_EXTENSIONS } from "./language"
import { Effect, Schema } from "effect"
import { withTimeout } from "../util/timeout"
import { Filesystem } from "@/util/filesystem"
import type { InstanceContext } from "@/project/instance-context"
import {
  validateExecutionLaunchProfileRef,
  validateHostProcessRef,
  type ExecutionLaunchProfileRefV1,
  type HostProcessRefV1,
} from "./process-scope"
import { assertLanguageServiceProcessAllowed } from "./launch"
import {
  type LspRequestMethodV1,
  type LspServerNotificationMethod,
  type LspServerRequestMethod,
  type LspNotificationMethodV1,
} from "./protocol"

const DIAGNOSTICS_DEBOUNCE_MS = 150
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000

const INITIALIZE_TIMEOUT_MS = 45_000
const MAX_OPEN_DOCUMENT_BYTES = 6 * 1024 * 1024
const MAX_PROTOCOL_VALUE_BYTES = 1024 * 1024
const documentEncoder = new TextEncoder()

// LSP spec constants
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

export type Diagnostic = VSCodeDiagnostic

export type LspRequestParams = {
  initialize: {
    readonly rootUri: string
    readonly processId: null
    readonly workspaceFolders: readonly { readonly name: string; readonly uri: string }[]
    readonly initializationOptions: Record<string, unknown>
    readonly capabilities: Record<string, unknown>
  }
  shutdown: Record<string, never>
  "textDocument/diagnostic": { readonly identifier?: string; readonly textDocument: { readonly uri: string } }
  "workspace/diagnostic": { readonly identifier?: string; readonly previousResultIds: readonly unknown[] }
  "textDocument/definition": Record<string, unknown>
  "textDocument/references": Record<string, unknown>
  "textDocument/documentSymbol": Record<string, unknown>
  "workspace/symbol": Record<string, unknown>
}

export type LspNotificationParams = {
  initialized: Record<string, never>
  "textDocument/didOpen": { readonly textDocument: { readonly uri: string; readonly languageId: string; readonly version: number; readonly text: string } }
  "textDocument/didChange": Record<string, unknown>
  "textDocument/didClose": { readonly textDocument: { readonly uri: string } }
  "$/cancelRequest": { readonly id: string | number }
  exit: Record<string, never>
}

type LspServerRequestParams = {
  "window/workDoneProgress/create": Record<string, unknown>
  "workspace/configuration": { readonly items?: readonly { readonly section?: string }[] }
  "client/registerCapability": { readonly registrations?: readonly CapabilityRegistration[] }
  "client/unregisterCapability": { readonly unregisterations?: readonly { readonly id: string; readonly method: string }[] }
  "workspace/workspaceFolders": Record<string, never>
  "workspace/diagnostic/refresh": Record<string, never>
}

/**
 * Method-bounded HostKernel operation/event adapter. Its provider maps these calls to
 * execution.v1/protocol_op, protocol_read and correlated protocol_reply, adding the
 * authenticated Session/Location and one-use Guard lease. It exposes no generic method,
 * byte, PID, or child-process API.
 */
export interface LspProtocolAdapter {
  /** Connection-facing API only. The implementation owns the injected typed
   * HostKernel transport privately and never exposes raw RPC/lease dispatch to
   * the language client or feature callers. */
  onNotification(method: LspServerNotificationMethod, handler: (params: unknown) => void): void
  onRequest<M extends LspServerRequestMethod>(method: M, handler: (params: LspServerRequestParams[M]) => unknown): void
  listen(): void
  sendRequest<T = unknown, M extends LspRequestMethodV1 = LspRequestMethodV1>(method: M, params: LspRequestParams[M]): Promise<T>
  sendNotification<M extends LspNotificationMethodV1 = LspNotificationMethodV1>(method: M, params: LspNotificationParams[M]): Promise<void>
  end(): void
  dispose(): void
}

export class InitializeError extends Schema.TaggedErrorClass<InitializeError>()("LSPInitializeError", {
  serverID: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class DocumentUnavailableError extends Schema.TaggedErrorClass<DocumentUnavailableError>()(
  "LSPDocumentUnavailableError",
  {
    reason: Schema.Literals(["outside_workspace", "stale_workspace", "too_large", "reader_unavailable"]),
  },
) {}

export type GuardedDocumentSnapshot = {
  readonly text: string
  /** UTF-8 content digest returned by the authenticated HostKernel files.read path. */
  readonly contentDigest: string
  /** Revision observed by the authenticated HostKernel files.read path. */
  readonly observedWorkspaceRevision: string
}

type DocumentDiagnosticReport = {
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DocumentDiagnosticReport>
}

type WorkspaceDiagnosticReport = {
  items?: {
    uri?: string
    items?: Diagnostic[]
  }[]
}

type DiagnosticRequestResult = {
  handled: boolean
  matched: boolean
  byFile: Map<string, Diagnostic[]>
}

type CapabilityRegistration = {
  id: string
  method: string
  registerOptions?: {
    identifier?: string
    workspaceDiagnostics?: boolean
  }
}

type ServerCapabilities = {
  textDocumentSync?:
    | number
    | {
        change?: number
      }
  diagnosticProvider?: unknown
  [key: string]: unknown
}

function getFilePath(uri: unknown) {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return
  try {
    return Filesystem.normalizePath(fileURLToPath(uri))
  } catch {
    return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeInitializationOptions(value: unknown): Record<string, unknown> {
  let nodes = 0
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > 16_384 || depth > 24) throw new TypeError("LSP initialization settings exceed protocol bounds")
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("LSP initialization settings must be JSON values")
      return item
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1))
    if (!isRecord(item)) throw new TypeError("LSP initialization settings must be JSON values")
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("LSP initialization settings must be plain JSON values")
    }
    const result = Object.create(null) as Record<string, unknown>
    for (const [key, child] of Object.entries(item)) {
      // Project secrets and credential-bearing settings are never sent to a language server.
      if (
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor" ||
        /(?:api.?key|token|secret|password|credential|authorization|cookie)/i.test(key)
      ) {
        continue
      }
      result[key] = visit(child, depth + 1)
    }
    return result
  }
  const cleaned = visit(value ?? {}, 0)
  if (!isRecord(cleaned) || documentEncoder.encode(JSON.stringify(cleaned)).byteLength > MAX_PROTOCOL_VALUE_BYTES) {
    throw new TypeError("LSP initialization settings exceed protocol bounds")
  }
  return cleaned
}



function isPosition(value: unknown): value is { line: number; character: number } {
  if (!isRecord(value)) return false
  const line = value.line
  const character = value.character
  return (
    typeof line === "number" &&
    Number.isSafeInteger(line) &&
    line >= 0 &&
    typeof character === "number" &&
    Number.isSafeInteger(character) &&
    character >= 0
  )
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (!isRecord(value) || typeof value.message !== "string" || !isRecord(value.range)) return false
  if (!isPosition(value.range.start) || !isPosition(value.range.end)) return false
  if (value.severity !== undefined && (typeof value.severity !== "number" || ![1, 2, 3, 4].includes(value.severity))) {
    return false
  }
  return true
}

function getSyncKind(capabilities?: ServerCapabilities) {
  if (!capabilities) return
  const sync = capabilities.textDocumentSync
  if (typeof sync === "number") return sync
  return sync?.change
}

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function dedupeDiagnostics(items: Diagnostic[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function configurationValue(settings: unknown, section?: string) {
  // LSP may ask for arbitrary configuration sections. Only a named section in
  // the immutable initialization projection is returned; an omitted or unknown
  // section gets null, never the complete settings object.
  if (!section) return null
  const result = section.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || !(key in acc)) return undefined
    return (acc as Record<string, unknown>)[key]
  }, settings)
  return result ?? null
}

// TypeScript's built-in LSP pushes diagnostics aggressively on first open.
// We seed the push cache on the very first publish so waitForFreshPush can
// resolve immediately instead of waiting for a second debounced push.
function shouldSeedDiagnosticsOnFirstPush(serverID: string) {
  return serverID === "typescript"
}

export async function create(input: {
  serverID: string
  /** Injected typed HostKernel protocol adapter; never a ChildProcess or stdio stream. */
  protocol: LspProtocolAdapter
  processRef: HostProcessRefV1
  launchProfileRef: ExecutionLaunchProfileRefV1
  initialization?: Record<string, any>
  root: string
  directory: string
  instance: InstanceContext
  /** HostKernel files.read adapter; the LSP client never reads workspace files directly. */
  workspaceRevision: string
  readDocument: (request: {
    readonly schemaVersion: 1
    readonly pathRef: string
    readonly expectedWorkspaceRevision: string
    readonly maxBytes: number
  }) => Promise<GuardedDocumentSnapshot>
  /** HostKernel process stop adapter bound to the retained process ref. */
  stopServer: (request: { readonly processRef: HostProcessRefV1; readonly expectedWorkspaceRevision: string }) => Promise<void>
}) {
  // The typed adapter contract is inert until P1 supplies the durable HostKernel
  // operation/event route and verified launch authority.
  assertLanguageServiceProcessAllowed("server.spawn")
  const workspaceRoot = path.resolve(input.root)
  const workspaceFilePath = (uri: unknown) => {
    const filePath = getFilePath(uri)
    if (!filePath) return undefined
    const relative = path.relative(workspaceRoot, path.resolve(filePath))
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
    return Filesystem.normalizePath(filePath)
  }
  const processRef = validateHostProcessRef(input.processRef)
  if (processRef.kind !== "language_server") {
    throw new TypeError("LSP client requires a HostKernel language_server process reference")
  }
  const initialization = safeInitializationOptions(input.initialization)
  const launchProfileRef = validateExecutionLaunchProfileRef(input.launchProfileRef)
  if (
    processRef.profileID !== launchProfileRef.profileId ||
    processRef.profileRevision !== launchProfileRef.revision ||
    processRef.profileDigest !== launchProfileRef.profileDigest
  ) {
    throw new TypeError("LSP process reference does not match its immutable launch profile pin")
  }

  const connection = input.protocol
  // --- Connection state ---

  const pushDiagnostics = new Map<string, Diagnostic[]>()
  const pullDiagnostics = new Map<string, Diagnostic[]>()
  const published = new Map<string, { at: number; version?: number }>()
  const files: Record<string, { version: number; text: string }> = {}
  const diagnosticRegistrations = new Map<string, CapabilityRegistration>()
  const registrationListeners = new Set<() => void>()
  const diagnosticListeners = new Set<(input: { path: string; serverID: string }) => void>()
  const mergedDiagnostics = (filePath: string) =>
    dedupeDiagnostics([...(pushDiagnostics.get(filePath) ?? []), ...(pullDiagnostics.get(filePath) ?? [])])
  const updatePushDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pushDiagnostics.set(filePath, next)
    for (const listener of diagnosticListeners) listener({ path: filePath, serverID: input.serverID })
  }
  const updatePullDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pullDiagnostics.set(filePath, next)
  }
  const emitRegistrationChange = () => {
    for (const listener of [...registrationListeners]) listener()
  }

  // --- LSP connection handlers ---

  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    if (!isRecord(params) || !Array.isArray(params.diagnostics) || !params.diagnostics.every(isDiagnostic)) return
    const filePath = workspaceFilePath(params.uri)
    if (!filePath) return
    const version = params.version
    if (version !== undefined && (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)) return
    const currentDocument = files[filePath]
    // A server can finish analysis for an older document after didChange. Do
    // not replace current diagnostics with a result pinned to another version.
    if (version !== undefined && currentDocument && version !== currentDocument.version) return
    published.set(filePath, {
      at: Date.now(),
      version: version as number | undefined,
    })
    if (shouldSeedDiagnosticsOnFirstPush(input.serverID) && !pushDiagnostics.has(filePath)) {
      pushDiagnostics.set(filePath, params.diagnostics)
      return
    }
    updatePushDiagnostics(filePath, params.diagnostics)
  })
  connection.onRequest("window/workDoneProgress/create", (params) => {
    return null
  })
  connection.onRequest("workspace/configuration", async (params) => {
    const items = (params as { items?: { section?: string }[] }).items ?? []
    return items.map((item) => configurationValue(initialization, item.section))
  })
  connection.onRequest("client/registerCapability", async (params) => {
    const registrations = (params as { registrations?: CapabilityRegistration[] }).registrations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.set(registration.id, registration)
      changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("client/unregisterCapability", async (params) => {
    const registrations = (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.delete(registration.id)
      changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("workspace/workspaceFolders", async () => [
    {
      name: "workspace",
      uri: pathToFileURL(input.root).href,
    },
  ])
  connection.onRequest("workspace/diagnostic/refresh", async () => null)
  connection.listen()

  // --- Initialize handshake ---

  const initialized = await withTimeout(
    connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
        rootUri: pathToFileURL(input.root).href,
        // Never disclose a PID: process authority remains the opaque HostKernel ref.
        processId: null,
        workspaceFolders: [
          {
            name: "workspace",
            uri: pathToFileURL(input.root).href,
          },
        ],
        initializationOptions: initialization,
        capabilities: {
          window: {
            workDoneProgress: true,
          },
          workspace: {
            configuration: true,
            diagnostics: {
              refreshSupport: false,
            },
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
            didClose: true,
            },
            diagnostic: {
              dynamicRegistration: true,
              relatedDocumentSupport: true,
            },
            publishDiagnostics: {
              versionSupport: false,
            },
          },
        },
    }),
    INITIALIZE_TIMEOUT_MS,
  ).catch((err) => {
    throw new InitializeError({ serverID: input.serverID, cause: err })
  })

  const syncKind = getSyncKind(initialized.capabilities)
  const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider)

  await connection.sendNotification("initialized", {})

  // --- Diagnostic helpers ---

  const mergeResults = (filePath: string, results: DiagnosticRequestResult[]) => {
    const handled = results.some((result) => result.handled)
    const matched = results.some((result) => result.matched)
    if (!handled) return { handled: false, matched: false }

    const merged = new Map<string, Diagnostic[]>()
    for (const result of results) {
      for (const [target, items] of result.byFile.entries()) {
        const existing = merged.get(target) ?? []
        merged.set(target, existing.concat(items))
      }
    }

    if (matched && !merged.has(filePath)) merged.set(filePath, [])
    for (const [target, items] of merged.entries()) {
      updatePullDiagnostics(target, dedupeDiagnostics(items))
    }

    return { handled, matched }
  }

  async function requestDiagnosticReport(filePath: string, identifier?: string): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<DocumentDiagnosticReport | null>("textDocument/diagnostic", {
        ...(identifier ? { identifier } : {}),
        textDocument: {
          uri: pathToFileURL(filePath).href,
        },
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }
    if (!isRecord(report)) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const items = report.items
    if (items !== undefined && (!Array.isArray(items) || !items.every(isDiagnostic))) {
      return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }
    }
    const relatedDocuments = report.relatedDocuments
    if (relatedDocuments !== undefined && !isRecord(relatedDocuments)) {
      return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }
    }

    const byFile = new Map<string, Diagnostic[]>()
    const push = (target: string, items: Diagnostic[]) => {
      const existing = byFile.get(target) ?? []
      byFile.set(target, existing.concat(items))
    }

    let handled = false
    let matched = false
    if (Array.isArray(items)) {
      push(filePath, items)
      handled = true
      matched = true
    }
    for (const [uri, related] of Object.entries(relatedDocuments ?? {})) {
      const relatedPath = workspaceFilePath(uri)
      if (!relatedPath || !isRecord(related) || !Array.isArray(related.items) || !related.items.every(isDiagnostic)) {
        continue
      }
      push(relatedPath, related.items)
      handled = true
      matched = matched || relatedPath === filePath
    }

    return { handled, matched, byFile }
  }

  async function requestWorkspaceDiagnosticReport(
    filePath: string,
    identifier?: string,
  ): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<WorkspaceDiagnosticReport | null>("workspace/diagnostic", {
        ...(identifier ? { identifier } : {}),
        previousResultIds: [],
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }
    if (!isRecord(report)) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const items = report.items
    if (items !== undefined && !Array.isArray(items)) {
      return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }
    }

    const byFile = new Map<string, Diagnostic[]>()
    let matched = false
    for (const item of items ?? []) {
      if (!isRecord(item)) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }
      const relatedItems = item.items
      if (Array.isArray(relatedItems) && !relatedItems.every(isDiagnostic)) {
        return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }
      }
      const relatedPath = typeof item.uri === "string" ? workspaceFilePath(item.uri) : undefined
      if (!relatedPath || !Array.isArray(relatedItems)) continue
      const existing = byFile.get(relatedPath) ?? []
      byFile.set(relatedPath, existing.concat(relatedItems))
      matched = matched || relatedPath === filePath
    }

    return { handled: true, matched, byFile }
  }

  function documentPullState() {
    const documentRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics !== true,
    )
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
    }
  }

  function workspacePullState() {
    const workspaceRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics === true,
    )
    return {
      workspaceIdentifiers: [
        ...new Set(workspaceRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: workspaceRegistrations.length > 0,
    }
  }

  const hasCurrentFileDiagnostics = (filePath: string, results: DiagnosticRequestResult[]) =>
    results.some((result) => (result.byFile.get(filePath)?.length ?? 0) > 0)

  async function requestDiagnostics(
    filePath: string,
    requests: Promise<DiagnosticRequestResult>[],
    done: (results: DiagnosticRequestResult[]) => boolean,
  ) {
    if (!requests.length) return { handled: false, matched: false }

    const results: DiagnosticRequestResult[] = []
    return new Promise<{ handled: boolean; matched: boolean }>((resolve) => {
      let pending = requests.length
      let resolved = false
      const finish = (merged: { handled: boolean; matched: boolean }, force = false) => {
        if (resolved) return
        if (!force && !done(results)) return
        resolved = true
        resolve(merged)
      }

      for (const request of requests) {
        request.then((result) => {
          results.push(result)
          pending -= 1
          const merged = mergeResults(filePath, results)
          finish(merged)
          if (pending === 0) finish(merged, true)
        })
      }
    })
  }

  // LATENCY-CRITICAL: dispatch identifier pulls in parallel and unblock once one
  // batch already produced diagnostics for the current file. Let slower pulls keep
  // merging in the background; do not sequence identifier-by-identifier, and do
  // not add a post-match settle/debounce delay. See PR #23771.
  async function requestDocumentDiagnostics(filePath: string) {
    const state = documentPullState()
    if (!state.supported) return { handled: false, matched: false }
    return requestDiagnostics(
      filePath,
      [
        requestDiagnosticReport(filePath),
        ...state.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
      ],
      (results) => hasCurrentFileDiagnostics(filePath, results),
    )
  }

  async function requestFullDiagnostics(filePath: string) {
    const documentState = documentPullState()
    const workspaceState = workspacePullState()
    if (!documentState.supported && !workspaceState.supported) return { handled: false, matched: false }
    return mergeResults(
      filePath,
      await Promise.all([
        ...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
        ...documentState.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
        ...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
        ...workspaceState.workspaceIdentifiers.map((identifier) =>
          requestWorkspaceDiagnosticReport(filePath, identifier),
        ),
      ]),
    )
  }

  function waitForRegistrationChange(timeout: number) {
    if (timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        registrationListeners.delete(listener)
        resolve(result)
      }
      const listener = () => finish(true)
      registrationListeners.add(listener)
      timer = setTimeout(() => finish(false), timeout)
    })
  }

  function waitForFreshPush(request: { path: string; version: number; after: number; timeout: number }) {
    if (request.timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let unsub: (() => void) | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (debounceTimer) clearTimeout(debounceTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        unsub?.()
        resolve(result)
      }
      const schedule = () => {
        const hit = published.get(request.path)
        if (!hit) return
        if (typeof hit.version === "number" && hit.version !== request.version) return
        if (hit.at < request.after && hit.version !== request.version) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => finish(true), Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)))
      }

      timeoutTimer = setTimeout(() => finish(false), request.timeout)
      const listener = (event: { path: string; serverID: string }) => {
        if (event.path !== request.path || event.serverID !== input.serverID) return
        schedule()
      }
      diagnosticListeners.add(listener)
      unsub = () => diagnosticListeners.delete(listener)
      schedule()
    })
  }

  async function waitForDocumentDiagnostics(request: { path: string; version: number; after?: number }) {
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS) {
      const result = await requestDocumentDiagnostics(request.path)
      if (result.matched) return
      const remaining = DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  async function waitForFullDiagnostics(request: { path: string; version: number; after?: number }) {
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS) {
      const result = await requestFullDiagnostics(request.path)
      if (result.handled || result.matched) return
      const remaining = DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  // --- Public API ---

  const result = {
    root: input.root,
    processRef,
    launchProfileRef,
    get serverID() {
      return input.serverID
    },
    get connection() {
      return connection
    },
    notify: {
      async open(request: { path: string }) {
        if (!/^blake3:[0-9a-f]{64}$/.test(input.workspaceRevision)) {
          throw new DocumentUnavailableError({ reason: "stale_workspace" })
        }
        const filePath = Filesystem.normalizePath(
          path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
        )
        const relative = path.relative(workspaceRoot, path.resolve(filePath))
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new DocumentUnavailableError({ reason: "outside_workspace" })
        }
        const pathRef = relative.split(path.sep).join("/")
        if (!pathRef || pathRef.startsWith("/") || pathRef.split("/").some((segment) => segment === "..")) {
          throw new DocumentUnavailableError({ reason: "outside_workspace" })
        }
        let snapshot: GuardedDocumentSnapshot
        try {
          snapshot = await input.readDocument({
            schemaVersion: 1,
            pathRef,
            expectedWorkspaceRevision: input.workspaceRevision,
            maxBytes: MAX_OPEN_DOCUMENT_BYTES,
          })
        } catch {
          throw new DocumentUnavailableError({ reason: "reader_unavailable" })
        }
        if (
          typeof snapshot?.text !== "string" ||
          snapshot.observedWorkspaceRevision !== input.workspaceRevision ||
          !/^blake3:[0-9a-f]{64}$/.test(snapshot.observedWorkspaceRevision) ||
          !/^blake3:[0-9a-f]{64}$/.test(snapshot.contentDigest)
        ) {
          throw new DocumentUnavailableError({ reason: "stale_workspace" })
        }
        const text = snapshot.text
        if (documentEncoder.encode(text).byteLength > MAX_OPEN_DOCUMENT_BYTES) {
          throw new DocumentUnavailableError({ reason: "too_large" })
        }
        const extension = path.extname(filePath)
        const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

        const document = files[filePath]
        if (document !== undefined) {
          // Do not wipe diagnostics on didChange. Some servers (e.g. clangd) only
          // re-emit diagnostics when the content actually changes, so clearing
          // here would lose errors for no-op touchFile calls. Let the server's
          // next push/pull overwrite naturally.
          const next = document.version + 1
          files[filePath] = { version: next, text }
          await connection.sendNotification("textDocument/didChange", {
            textDocument: {
              uri: pathToFileURL(filePath).href,
              version: next,
            },
            contentChanges:
              syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
                ? [
                    {
                      range: {
                        start: { line: 0, character: 0 },
                        end: endPosition(document.text),
                      },
                      text,
                    },
                  ]
                : [{ text }],
          })
          return next
        }

        pushDiagnostics.delete(filePath)
        pullDiagnostics.delete(filePath)
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: pathToFileURL(filePath).href,
            languageId,
            version: 0,
            text,
          },
        })
        files[filePath] = { version: 0, text }
        return 0
      },
      async close(request: { path: string }) {
        const filePath = Filesystem.normalizePath(
          path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
        )
        if (!files[filePath]) return
        await connection.sendNotification("textDocument/didClose", {
          textDocument: { uri: pathToFileURL(filePath).href },
        })
        delete files[filePath]
        pushDiagnostics.delete(filePath)
        pullDiagnostics.delete(filePath)
        published.delete(filePath)
      },
    },
    get diagnostics() {
      const result = new Map<string, Diagnostic[]>()
      for (const key of new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])) {
        result.set(key, mergedDiagnostics(key))
      }
      return result
    },
    async waitForDiagnostics(request: { path: string; version: number; mode?: "document" | "full"; after?: number }) {
      const normalizedPath = Filesystem.normalizePath(
        path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
      )
      if (request.mode === "document") {
        await waitForDocumentDiagnostics({ path: normalizedPath, version: request.version, after: request.after })
        return
      }
      await waitForFullDiagnostics({ path: normalizedPath, version: request.version, after: request.after })
    },
    async shutdown() {
      for (const filePath of Object.keys(files)) {
        await result.notify.close({ path: filePath }).catch(() => undefined)
      }
      try {
        await withTimeout(connection.sendRequest("shutdown", {}), 2_000)
      } catch {
        // A failed graceful shutdown does not authorize a local kill; the
        // HostKernel callback below performs the scoped stop/reconciliation.
      }
      try {
        await connection.sendNotification("exit", {})
      } catch {
        // Continue to the authenticated HostKernel stop path.
      }
      connection.end()
      connection.dispose()
      await input.stopServer({ processRef, expectedWorkspaceRevision: input.workspaceRevision })
    },
  }

  return result
}

export * as LSPClient from "./client"
