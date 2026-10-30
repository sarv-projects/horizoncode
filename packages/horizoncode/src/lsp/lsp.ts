import { LayerNode } from "@horizoncode/core/effect/layer-node"
import * as LSPClient from "./client"
import { pathToFileURL, fileURLToPath } from "url"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { Location } from "@horizoncode/schema"
import { InstanceState } from "@/effect/instance-state"
import { NonNegativeInt } from "@horizoncode/core/schema"
import { LspEvent } from "@horizoncode/schema/lsp-event"
import type { CodeActionEditProposalV1, VersionedWorkspaceEditV1 } from "./edits"
import * as LSPDiagnostic from "./diagnostic"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import type { Info as SupervisedClientInfo } from "./client"
import { assertLanguageServiceProcessAllowed, hostProtocolRouteAvailable, languageServiceProcessRouteAvailable } from "./launch"

/** Attempt-pinned context made available only inside the authenticated prompt fiber. */
export type ExecutionScopeV1 = {
  readonly sessionID: string
  readonly locationID: string
  readonly locationRef: typeof Location.Ref.Type
  readonly workspaceRevision: string
  readonly workspaceID: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  /** Trusted Prompt-owned lazy creator; its closure retains current authority and host runtime. */
  readonly getClients: (file?: string) => Promise<readonly SupervisedClientInfo[]>
  /** Snapshot only; status must never start a process. */
  readonly getExistingClients: () => Promise<readonly SupervisedClientInfo[]>
  /** Prompt-scope finalizer for exactly the clients created above. */
  readonly dispose: () => Promise<void>
}

export class ExecutionScope extends Context.Service<ExecutionScope, ExecutionScopeV1>()("@horizoncode/LSPExecutionScope") {}

export const Event = LspEvent

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

type LocInput = { file: string; line: number; character: number }

interface State {
  clients: LSPClient.Info[]
}

export interface Interface {
  /** Run prompt work with the exact authenticated Attempt/workspace binding. */
  readonly withExecutionScope: <A, E, R>(
    input: ExecutionScopeV1,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, ExecutionScope>>
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  /** Bounded post-patch diagnostics for tool results (ACC-002). Never writes. */
  readonly postPatchDiagnostics: (files: readonly string[]) => Effect.Effect<import("./diagnostic").PostPatchDiagnosticsV1>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  /** Return user-reviewable edits only; application remains a files.patch effect. */
  readonly codeAction: (input: LocInput) => Effect.Effect<CodeActionEditProposalV1[]>
  /** Return a rename proposal only; this service never applies WorkspaceEdit. */
  readonly rename: (input: LocInput & { readonly newName: string }) => Effect.Effect<VersionedWorkspaceEditV1[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@horizoncode/LSP") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* () {
        yield* Effect.logWarning("LSP servers are unavailable until their processes are supervised by ExecutionHost")

        const s: State = { clients: [] }
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all(s.clients.map((client) => client.shutdown()))
          }),
        )
        return s
      }),
    )

    const scopedClients = Effect.fnUntraced(function* (file?: string) {
      const scoped = yield* Effect.serviceOption(ExecutionScope)
      if (Option.isNone(scoped)) return [] as LSPClient.Info[]
      // Keep the first-party route dormant until both shared HostKernel gates
      // are accepted. A future enabled route always resolves clients through
      // this fiber's exact Attempt-bound installer, never shared service state.
      if (!languageServiceProcessRouteAvailable() || !hostProtocolRouteAvailable()) return [] as LSPClient.Info[]
      try {
        assertLanguageServiceProcessAllowed("server.spawn")
      } catch {
        return [] as LSPClient.Info[]
      }
      const clients = yield* Effect.promise(() => scoped.value.getClients(file))
      return [...clients]
    })

    const getClients = Effect.fnUntraced(function* (file: string) {
      yield* InstanceState.get(state)
      return yield* scopedClients(file)
    })

    const existingScopedClients = Effect.fnUntraced(function* () {
      const scoped = yield* Effect.serviceOption(ExecutionScope)
      if (Option.isNone(scoped)) return [] as LSPClient.Info[]
      const clients = yield* Effect.promise(() => scoped.value.getExistingClients())
      return [...clients]
    })

    const withExecutionScope: Interface["withExecutionScope"] = (input, effect) => {
      const scope = validateExecutionScopeV1(input)
      return Effect.provideService(effect, ExecutionScope, scope).pipe(
        Effect.ensuring(Effect.promise(() => scope.dispose())),
      )
    }

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
      const clients = yield* getClients(file)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      yield* InstanceState.get(state)
      const clients = yield* scopedClients()
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      yield* InstanceState.get(state)
      const clients = yield* existingScopedClients()
      return yield* Effect.promise(() => Promise.all(clients.map(async (client) => {
        let connected = true
        try {
          const process = await client.readProcessStatus()
          if (process && process.state !== "RUNNING") connected = false
        } catch {
          connected = false
        }
        return {
          id: client.serverID,
          name: client.serverID,
          root: client.root,
          status: connected ? "connected" as const : "error" as const,
        }
      })))
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      yield* InstanceState.get(state)
      return (yield* scopedClients(file)).length > 0
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      yield* Effect.logInfo("touching file", { file: input })
      const clients = yield* getClients(input)
      yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch(() => {}),
      )
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const postPatchDiagnostics = Effect.fn("LSP.postPatchDiagnostics")(function* (files: readonly string[]) {
      const bounded = [...new Set(files)].slice(0, 64)
      yield* Effect.forEach(
        bounded,
        (file) => touchFile(file, "document").pipe(Effect.ignoreCause),
        { concurrency: 4 },
      )
      const all = yield* diagnostics()
      return LSPDiagnostic.postPatch({ diagnostics: all, touched: bounded })
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      const results = yield* runAll((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const codeAction = Effect.fn("LSP.codeAction")(function* (input: LocInput) {
      const uri = pathToFileURL(input.file).href
      const results = yield* run(input.file, (client) => client.prepareCodeAction({
        textDocument: { uri },
        range: {
          start: { line: input.line, character: input.character },
          end: { line: input.line, character: input.character },
        },
        context: { diagnostics: [] },
      }).catch(() => [] as CodeActionEditProposalV1[]))
      return results.flat()
    })

    const rename = Effect.fn("LSP.rename")(function* (input: LocInput & { readonly newName: string }) {
      const uri = pathToFileURL(input.file).href
      const results = yield* run(input.file, (client) => client.prepareRename({
        textDocument: { uri },
        position: { line: input.line, character: input.character },
        newName: input.newName,
      }).catch(() => undefined))
      return results.filter((result) => result !== undefined)
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client) => {
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      withExecutionScope,
      init,
      status,
      hasClients,
      touchFile,
      diagnostics,
      postPatchDiagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      codeAction,
      rename,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

function validateExecutionScopeV1(input: ExecutionScopeV1): ExecutionScopeV1 {
  if (input.managedAttempt !== undefined && input.directAttempt !== undefined) {
    throw new TypeError("LSP execution scope cannot combine managed and direct Attempt authority")
  }
  const attempt = input.managedAttempt ?? input.directAttempt
  const workspaceID = input.managedAttempt?.worktreeTarget.workspaceID ?? input.directAttempt?.workspaceID ?? input.workspaceID
  if ((attempt !== undefined && (input.sessionID !== (input.managedAttempt?.sessionID ?? input.directAttempt?.childSessionID) ||
      input.locationID !== attempt.locationID || input.workspaceRevision !== attempt.workspaceRevision ||
      workspaceID !== input.workspaceID)) || input.locationRef.workspaceID !== workspaceID ||
      !/^blake3:[0-9a-f]{64}$/.test(input.workspaceRevision) ||
      typeof input.getClients !== "function" || typeof input.dispose !== "function" ||
      typeof input.getExistingClients !== "function" ||
      (input.managedAttempt && (input.managedAttempt.worktreeTarget.locationID !== input.locationID ||
        input.managedAttempt.worktreeTarget.workspaceRevision !== input.workspaceRevision ||
        input.managedAttempt.worktreeTarget.canonicalRoot !== input.locationRef.directory))) {
    throw new TypeError("LSP execution scope does not match its authenticated Attempt workspace pins")
  }
  return Object.freeze({
    ...input,
    locationRef: Object.freeze({ ...input.locationRef }),
    ...(input.managedAttempt === undefined
      ? {}
      : {
          managedAttempt: Object.freeze({
            ...input.managedAttempt,
            worktreeTarget: Object.freeze({ ...input.managedAttempt.worktreeTarget }),
          }),
        }),
    ...(input.directAttempt === undefined ? {} : { directAttempt: Object.freeze({ ...input.directAttempt }) }),
  })
}

export * as Broker from "./broker"
export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [],
})

export * as LSP from "./lsp"
