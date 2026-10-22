import type { LspProtocolAdapter, LspServerRequestParams } from "./client"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  freezeDirectAttemptScope,
  freezeManagedAttemptScope,
  validateHostProcessRef,
  validateHostProcessScope,
  type HostProcessRefV1,
} from "./process-scope"
import {
  createHostKernelLspProtocolAdapterV1,
  LspEventCursorV1,
  LspProtocolJournalV1,
  OutboundProtocolSequenceV1,
  lspProtocolCapabilityV1,
  lspServerRequestCapabilityV1,
  isDefinitiveProtocolAdmissionFailure,
  ProtocolAdmissionDeniedError,
  ProtocolDispatchUncertainError,
  validateLspServerRequestParamsV1,
  validateLspProtocolParamsV1,
  type ExecutionHostProtocolRequestV1,
  type LspNotificationMethodV1,
  type LspProtocolOperationRequestV1,
  type LspProtocolReplyRequestV1,
  type LspRequestMethodV1,
  type LspServerNotificationMethod,
  type LspServerRequestMethod,
} from "./protocol"
import { assertHostProtocolAllowed } from "./launch"

type ProtocolLeaseV1 = {
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: string
  readonly capabilityLeaseDigest: string
}

type ProtocolScopeV1 = {
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

type Handler<T> = (params: T) => unknown
type PendingResponse = {
  readonly requestID: string | number
  readonly method: LspRequestMethodV1
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}
type AuthorizeProtocolV1 = (input: {
  readonly capabilityID: string
  readonly authorization: Readonly<Record<string, unknown>>
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly kind: "operation" | "callback_reply"
}) => Promise<ProtocolLeaseV1>

/**
 * The production Core-side LSP connection over the shared HostKernel protocol
 * journal. It owns only sequence/correlation and callback routing; it never
 * owns process bytes or process lifecycle. The provider must request a fresh
 * canonical Guard lease for every operation and callback reply.
 */
export class HostKernelLspProtocolClientV1 implements LspProtocolAdapter {
  readonly #scope: ProtocolScopeV1
  readonly #host: ReturnType<typeof createHostKernelLspProtocolAdapterV1>
  readonly #outbound: OutboundProtocolSequenceV1
  readonly #cursor: LspEventCursorV1
  readonly #journal: LspProtocolJournalV1
  readonly #authorize: AuthorizeProtocolV1
  readonly #onTerminalFailure?: (error: Error) => Promise<void>
  readonly #notifications = new Map<LspServerNotificationMethod, Set<(params: unknown) => void>>()
  readonly #requests = new Map<LspServerRequestMethod, Set<Handler<any>>>()
  readonly #pending = new Map<string, PendingResponse>()
  #nextRequestID = 0
  #listening = false
  #closed = false
  #failure?: Error
  #pump?: Promise<void>
  #dispatchTail: Promise<void> = Promise.resolve()
  #readBarrier?: Promise<void>

  constructor(input: {
    readonly requestHostKernel: ExecutionHostProtocolRequestV1
    readonly scope: ProtocolScopeV1
    readonly authorize: AuthorizeProtocolV1
    readonly onTerminalFailure?: (error: Error) => Promise<void>
  }) {
    const processRef = validateHostProcessRef(input.scope.hostProcessRef)
    if (processRef.kind !== "language_server") throw new TypeError("LSP protocol client requires a language_server process")
    validateHostProcessScope({
      sessionID: input.scope.sessionID,
      locationID: input.scope.locationID,
      ownerEpoch: processRef.ownerEpoch,
      workspaceRevision: input.scope.workspaceRevision,
      managedAttemptScope: input.scope.managedAttempt,
      directAttemptScope: input.scope.directAttempt,
      workspaceID: input.scope.directAttempt?.workspaceID,
    })
    if (input.scope.managedAttempt !== undefined && input.scope.directAttempt !== undefined) {
      throw new TypeError("LSP protocol client cannot combine managed and direct Attempt scopes")
    }
    this.#scope = Object.freeze({
      ...input.scope,
      hostProcessRef: Object.freeze({ ...processRef }),
      ...(input.scope.managedAttempt === undefined ? {} : { managedAttempt: freezeManagedAttemptScope(input.scope.managedAttempt) }),
      ...(input.scope.directAttempt === undefined ? {} : { directAttempt: freezeDirectAttemptScope(input.scope.directAttempt) }),
    })
    this.#authorize = input.authorize
    this.#onTerminalFailure = input.onTerminalFailure
    this.#host = createHostKernelLspProtocolAdapterV1(input.requestHostKernel)
    this.#outbound = new OutboundProtocolSequenceV1(processRef)
    this.#cursor = new LspEventCursorV1(
      processRef,
      input.scope.sessionID,
      input.scope.locationID,
      input.scope.workspaceRevision,
      this.#scope.managedAttempt,
      this.#scope.directAttempt,
    )
    this.#journal = new LspProtocolJournalV1(processRef, input.scope.workspaceRevision)
  }

  onNotification(method: LspServerNotificationMethod, handler: (params: unknown) => void): void {
    this.#addHandler(this.#notifications, method, handler)
  }

  onRequest<M extends LspServerRequestMethod>(method: M, handler: Handler<LspServerRequestParams[M]>): void {
    this.#addHandler(this.#requests, method, handler)
  }

  listen(): void {
    this.#assertLive()
    if (this.#listening) return
    assertHostProtocolAllowed()
    this.#listening = true
    this.#pump = this.#poll()
  }

  async sendRequest<T = unknown, M extends LspRequestMethodV1 = LspRequestMethodV1>(
    method: M,
    params: RequestParams<M>,
  ): Promise<T> {
    this.#assertLive()
    if (!this.#listening) throw new Error("HostKernel LSP protocol client must listen before sending requests")
    const result = await this.#dispatchOperation({ method, params, request: true })
    return result.response as Promise<T>
  }

  async sendNotification<M extends LspNotificationMethodV1 = LspNotificationMethodV1>(
    method: M,
    params: NotificationParams<M>,
  ): Promise<void> {
    this.#assertLive()
    if (!this.#listening) throw new Error("HostKernel LSP protocol client must listen before sending notifications")
    await this.#dispatchOperation({ method, params })
  }

  /** Explicit cancellation preserves the active process generation and sends
   * the protocol's canonical notification through its own fresh Guard lease. */
  async cancelRequest(requestID: string | number): Promise<void> {
    this.#assertLive()
    const pending = [...this.#pending.entries()].find(([, item]) => item.requestID === requestID)
    if (!pending) return
    await this.sendNotification("$/cancelRequest", { id: requestID })
    pending[1].reject(new Error("LSP request cancelled"))
    this.#pending.delete(pending[0])
  }

  /** End is local transport shutdown only. Host process stop belongs to the
   * separately Guarded ExecutionHost lifecycle and is never inferred here. */
  end(): void {
    this.#closed = true
    this.#failPending(new Error("LSP protocol connection ended"))
  }

  dispose(): void {
    this.end()
    this.#notifications.clear()
    this.#requests.clear()
  }

  async #dispatchOperation(input: {
    readonly method: LspRequestMethodV1 | LspNotificationMethodV1
    readonly params: unknown
    readonly request?: boolean
  }): Promise<{ readonly response?: Promise<unknown> }> {
    const dispatch = this.#dispatchTail.then(async () => {
      this.#assertLive()
      if (this.#readBarrier) await this.#readBarrier
      const requestSequence = this.#outbound.next(this.#scope.hostProcessRef)
      const requestID = input.request ? `hc-${requestSequence}` : undefined
      try {
        await this.#dispatchOperationNow({
          requestSequence,
          requestID,
          method: input.method,
          params: input.params,
        })
        let response: Promise<unknown> | undefined
        if (requestID !== undefined) {
          response = new Promise((resolve, reject) => {
            this.#pending.set(requestSequence, { requestID, method: input.method as LspRequestMethodV1, resolve, reject })
          })
        }
        return { ...(response === undefined ? {} : { response }) }
      } catch (error) {
        this.#pending.delete(requestSequence)
        if (isDefinitiveProtocolAdmissionFailure(error)) {
          this.#outbound.rollback(requestSequence, this.#scope.hostProcessRef)
          if (error instanceof ProtocolAdmissionDeniedError) throw error
          throw new ProtocolAdmissionDeniedError({ operation: input.method, ...hostCodeFields(error) })
        }
        throw new ProtocolDispatchUncertainError({ operation: input.method })
      }
    })
    this.#dispatchTail = dispatch.then(() => undefined, (error) => {
      if (error instanceof ProtocolDispatchUncertainError) this.#quarantine(error)
    })
    return dispatch
  }

  async #dispatchOperationNow(input: {
    readonly requestSequence: string
    readonly requestID?: string | number
    readonly method: LspRequestMethodV1 | LspNotificationMethodV1
    readonly params: unknown
  }): Promise<void> {
    const capabilityID = lspProtocolCapabilityV1(input.method)
    if (!capabilityID) throw new ProtocolAdmissionDeniedError({ operation: input.method })
    const params = validateLspProtocolParamsV1(input.params)
    let lease: ProtocolLeaseV1
    try {
      lease = await this.#authorize({
        capabilityID,
        authorization: {
          hostProcessRef: this.#scope.hostProcessRef,
          sessionID: this.#scope.sessionID,
          locationID: this.#scope.locationID,
          workspaceRevision: this.#scope.workspaceRevision,
          protocol: "lsp",
          requestSequence: input.requestSequence,
          operation: {
            requestSequence: input.requestSequence,
            method: input.method,
            ...(input.requestID === undefined ? {} : { requestID: input.requestID }),
            params,
          },
        },
        managedAttempt: this.#scope.managedAttempt,
        directAttempt: this.#scope.directAttempt,
        kind: "operation",
      })
    } catch (error) {
      throw new ProtocolAdmissionDeniedError({ operation: input.method, ...hostCodeFields(error) })
    }
    if (lease.capabilityID !== capabilityID) {
      throw new ProtocolAdmissionDeniedError({ operation: input.method, hostCode: "capability_unavailable" })
    }
    const request: LspProtocolOperationRequestV1 = {
      ...this.#scope,
      ...lease,
      operation: {
        requestSequence: input.requestSequence,
        method: input.method,
        ...(input.requestID === undefined ? {} : { requestID: input.requestID }),
        params,
      },
    }
    let receipt: Awaited<ReturnType<typeof this.#host.protocolOp>>
    try {
      receipt = await this.#host.protocolOp(request)
    } catch (error) {
      if (isDefinitiveProtocolAdmissionFailure(error)) throw error
      throw new ProtocolDispatchUncertainError({ operation: input.method })
    }
    try {
      this.#journal.acceptOperation(request, receipt)
    } catch {
      throw new ProtocolDispatchUncertainError({ operation: input.method })
    }
  }

  async #poll(): Promise<void> {
    while (!this.#closed && !this.#failure) {
      try {
        await this.#dispatchTail
        this.#assertLive()
        let finishRead!: () => void
        const readBarrier = new Promise<void>((resolve) => { finishRead = resolve })
        this.#readBarrier = readBarrier
        let accepted: ReturnType<LspEventCursorV1["accept"]>
        try {
          const page = await this.#host.protocolRead(this.#cursor.readRequest())
          accepted = this.#cursor.accept(page)
          this.#journal.acceptPage(accepted)
        } finally {
          finishRead()
          if (this.#readBarrier === readBarrier) this.#readBarrier = undefined
        }
        for (const event of accepted.events) {
          if (this.#closed || this.#failure) break
          if (event.messageKind === "notification") {
            for (const handler of this.#notifications.get(event.payload.method) ?? []) handler(event.payload.params)
          } else if (event.messageKind === "response") {
            const pending = this.#pending.get(event.payload.requestSequence)
            if (!pending) throw new Error("LSP response has no pending request")
            this.#pending.delete(event.payload.requestSequence)
            if (Object.hasOwn(event.payload, "error")) {
              pending.reject(new Error(event.payload.error?.message ?? "LSP request failed"))
            } else pending.resolve(event.payload.result)
          } else {
            await this.#handleServerRequest(event.payload.eventSequence, event.payload.requestID, event.payload.method, event.payload.params)
          }
        }
        if (accepted.status !== "RUNNING") throw new Error("LSP process is no longer running; new generation required")
        if (accepted.events.length === 0) await delay(50)
      } catch (error) {
        this.#failure = asError(error)
        this.#closed = true
        this.#failPending(this.#failure)
        this.#notifyTerminalFailure(this.#failure)
      }
    }
  }

  async #handleServerRequest(eventSequence: string, requestID: string | number, method: LspServerRequestMethod, rawParams: unknown): Promise<void> {
    const params = validateLspServerRequestParamsV1(method, rawParams)
    const handlers = this.#requests.get(method)
    if (!handlers?.size) throw new Error(`LSP server callback ${method} has no Core handler`)
    if (handlers.size !== 1) throw new Error(`LSP server callback ${method} has ambiguous Core handlers`)
    const capabilityID = lspServerRequestCapabilityV1(method)
    if (!capabilityID) throw new Error("LSP callback has no canonical Guard capability")
    const result = await handlers.values().next().value!(params)
    await this.#dispatchTail
    const dispatch = this.#dispatchTail.then(async () => {
      this.#assertLive()
      const requestSequence = this.#outbound.next(this.#scope.hostProcessRef)
      try {
        let lease: ProtocolLeaseV1
        try {
          lease = await this.#authorize({
            capabilityID,
            authorization: {
              hostProcessRef: this.#scope.hostProcessRef,
              sessionID: this.#scope.sessionID,
              locationID: this.#scope.locationID,
              workspaceRevision: this.#scope.workspaceRevision,
              protocol: "lsp",
              requestSequence,
              operation: { schemaVersion: 1, requestSequence, serverRequestID: requestID, method, result },
              callbackEventSequence: eventSequence,
            },
            managedAttempt: this.#scope.managedAttempt,
            directAttempt: this.#scope.directAttempt,
            kind: "callback_reply",
          })
        } catch (error) {
          throw new ProtocolAdmissionDeniedError({ operation: `callback:${method}`, ...hostCodeFields(error) })
        }
        if (lease.capabilityID !== capabilityID) {
          throw new ProtocolAdmissionDeniedError({ operation: `callback:${method}`, hostCode: "capability_unavailable" })
        }
        const reply: LspProtocolReplyRequestV1 = {
          schemaVersion: 1,
          ...this.#scope,
          ...lease,
          reply: { schemaVersion: 1, requestSequence, serverRequestID: requestID, method, result },
        }
        let receipt: Awaited<ReturnType<typeof this.#host.protocolReply>>
        try {
          receipt = await this.#host.protocolReply(reply)
        } catch (error) {
          if (isDefinitiveProtocolAdmissionFailure(error)) throw error
          throw new ProtocolDispatchUncertainError({ operation: `callback:${method}` })
        }
        try {
          this.#journal.acceptProtocolReply(reply, receipt)
        } catch {
          throw new ProtocolDispatchUncertainError({ operation: `callback:${method}` })
        }
      } catch (error) {
        if (isDefinitiveProtocolAdmissionFailure(error)) {
          this.#outbound.rollback(requestSequence, this.#scope.hostProcessRef)
          if (error instanceof ProtocolAdmissionDeniedError) throw error
          throw new ProtocolAdmissionDeniedError({ operation: `callback:${method}`, ...hostCodeFields(error) })
        }
        throw new ProtocolDispatchUncertainError({ operation: `callback:${method}` })
      }
    })
    this.#dispatchTail = dispatch.then(() => undefined, (error) => {
      if (error instanceof ProtocolDispatchUncertainError) this.#quarantine(error)
    })
    await dispatch
  }

  #addHandler<T>(target: Map<any, Set<Handler<T>>>, method: any, handler: Handler<T>): void {
    if (this.#closed) throw new Error("LSP protocol connection is closed")
    const handlers = target.get(method) ?? new Set<Handler<T>>()
    handlers.add(handler)
    target.set(method, handlers)
  }

  #assertLive(): void {
    if (this.#closed || this.#failure || this.#cursor.quarantined || this.#journal.quarantined) {
      throw this.#failure ?? new Error("LSP process generation is quarantined")
    }
  }

  #quarantine(error: Error): void {
    this.#failure = error
    this.#closed = true
    this.#failPending(error)
    this.#notifyTerminalFailure(error)
  }

  #notifyTerminalFailure(error: Error): void {
    const cleanup = this.#onTerminalFailure
    if (!cleanup) return
    void Promise.resolve()
      .then(() => cleanup(error))
      .catch((cleanupError) => {
        this.#failure = new AggregateError(
          [error, asError(cleanupError)],
          "LSP process generation failed and its exact supervised process could not be confirmed stopped",
        )
      })
  }

  #failPending(error: Error): void {
    for (const item of this.#pending.values()) item.reject(error)
    this.#pending.clear()
  }
}

type RequestParams<M extends LspRequestMethodV1> = Record<string, unknown>
type NotificationParams<M extends LspNotificationMethodV1> = Record<string, unknown> | readonly unknown[]

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("LSP HostKernel protocol failed")
}

function hostCodeFields(error: unknown): { readonly hostCode?: string } {
  if (typeof error !== "object" || error === null) return {}
  const value = error as Record<string, unknown>
  return typeof value.hostCode === "string" ? { hostCode: value.hostCode } : {}
}
