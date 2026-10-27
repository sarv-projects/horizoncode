import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  LspEventCursorV1,
  LspProtocolJournalV1,
  OutboundProtocolSequenceV1,
  ProtocolError,
  dispatchLspProtocolOperationV1,
  dispatchLspProtocolReplyV1,
  validateLspServerRequestParamsV1,
  type HostProtocolDispatchReceiptV1,
  type LspEventPageV1,
  type LspProtocolOperationRequestV1,
  type LspProtocolReplyRequestV1,
  type LspRequestMethodV1,
  type LspServerNotificationMethod,
  type LspServerRequestMethod,
  type LspNotificationMethodV1,
} from "./protocol"
import type { LspNotificationParams, LspProtocolAdapter, LspRequestParams } from "./client"
import { makeProtocolDispatchQueue } from "./protocol-dispatch-queue"
import {
  freezeDirectAttemptScope,
  freezeManagedAttemptScope,
  validateHostProcessRef,
  validateHostProcessScope,
  type HostProcessRefV1,
} from "./process-scope"

type GuardLease = {
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: string
  readonly capabilityLeaseDigest: string
}

type ProtocolContext = {
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

/** Only these injected functions can cross the Core→HostKernel boundary. There
 * is no byte, stdio, PID, executable or local-process operation here. */
export type HostLspProtocolTransportV1 = {
  readonly protocolOp: (request: LspProtocolOperationRequestV1) => Promise<unknown>
  readonly protocolRead: (request: ReturnType<LspEventCursorV1["readRequest"]>) => Promise<unknown>
  readonly protocolReply: (request: LspProtocolReplyRequestV1) => Promise<unknown>
}

/** Guard authority is resolved separately for every client operation and
 * correlated server-request reply. HostKernel revalidates each lease. */
export type HostLspGuardAuthorizerV1 = {
  readonly authorizeOperation: (input: {
    readonly processRef: HostProcessRefV1
    readonly method: LspRequestMethodV1 | LspNotificationMethodV1
    readonly requestID?: string | number
    readonly params: Readonly<Record<string, unknown>> | readonly unknown[]
    readonly workspaceRevision: string
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly directAttempt?: DirectAttemptScopeV1
  }) => Promise<GuardLease>
  readonly authorizeReply: (input: {
    readonly processRef: HostProcessRefV1
    readonly method: LspServerRequestMethod
    readonly serverRequestID: string | number
    readonly result: unknown
    readonly workspaceRevision: string
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly directAttempt?: DirectAttemptScopeV1
  }) => Promise<GuardLease>
}

type PendingResponse = {
  readonly requestID: string | number
  readonly method: LspRequestMethodV1
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function requestIDKey(value: string | number): string {
  return `${typeof value}:${value}`
}

/** Concrete LSP adapter over the typed execution.v1 protocol contract. It
 * serializes outbound sequence assignment, correlates responses, applies only
 * validated replay pages, and quarantines a generation on uncertainty. The
 * adapter is not enabled by launch.ts until P1 has a real durable HostKernel
 * dispatcher, event buffer, Guard lease path and confinement evidence. */
export function makeHostLspProtocolAdapterV1(input: {
  readonly context: ProtocolContext
  readonly transport: HostLspProtocolTransportV1
  readonly guard: HostLspGuardAuthorizerV1
}): LspProtocolAdapter {
  const hostProcessRef = Object.freeze({ ...validateHostProcessRef(input.context.hostProcessRef) })
  if (hostProcessRef.kind !== "language_server") {
    throw new ProtocolError({ detail: "LSP adapter requires a HostKernel language_server process reference" })
  }
  if (!/^blake3:[0-9a-f]{64}$/.test(input.context.workspaceRevision)) {
    throw new ProtocolError({ detail: "LSP adapter requires a pinned workspace revision" })
  }
  try {
    validateHostProcessScope({
      sessionID: input.context.sessionID,
      locationID: input.context.locationID,
      ownerEpoch: hostProcessRef.ownerEpoch,
      workspaceRevision: input.context.workspaceRevision,
      managedAttemptScope: input.context.managedAttempt,
      directAttemptScope: input.context.directAttempt,
      workspaceID: input.context.directAttempt?.workspaceID,
    })
  } catch {
    throw new ProtocolError({ detail: "LSP adapter Attempt scope does not match its process/session/workspace binding" })
  }
  const context = Object.freeze({
    ...input.context,
    hostProcessRef,
    managedAttempt: freezeManagedAttemptScope(input.context.managedAttempt),
    directAttempt: freezeDirectAttemptScope(input.context.directAttempt),
  })
  const sequence = new OutboundProtocolSequenceV1(hostProcessRef)
  const cursor = new LspEventCursorV1(
    hostProcessRef,
    context.sessionID,
    context.locationID,
    context.workspaceRevision,
    context.managedAttempt,
    context.directAttempt,
  )
  const journal = new LspProtocolJournalV1(hostProcessRef, context.workspaceRevision)
  const pending = new Map<string, PendingResponse>()
  const notifications = new Map<LspServerNotificationMethod, Set<(params: unknown) => void>>()
  const requests = new Map<LspServerRequestMethod, (params: unknown) => unknown | Promise<unknown>>()
  let requestID = 0
  let listening = false
  let closed = false
  let quarantined = false
  let dispatchesInFlight = 0
  // Sequence allocation and async lease acquisition can finish in a different
  // order from callers. Serialize HostKernel writes and fence the generation
  // after the first uncertain outcome.
  const outbound = makeProtocolDispatchQueue()

  const failGeneration = (error: unknown) => {
    quarantined = true
    const failure = error instanceof Error ? error : new Error("LSP HostKernel protocol outcome is unknown")
    for (const item of pending.values()) item.reject(failure)
    pending.clear()
  }

  const leaseFields = (lease: GuardLease) => ({
    effectID: lease.effectID,
    challengeID: lease.challengeID,
    capabilityID: lease.capabilityID,
    capabilityLeaseDigest: lease.capabilityLeaseDigest,
  })

  const dispatch = async (
    method: LspRequestMethodV1 | LspNotificationMethodV1,
    params: Readonly<Record<string, unknown>> | readonly unknown[],
    id?: string | number,
  ): Promise<HostProtocolDispatchReceiptV1> => {
    if (closed || quarantined || cursor.quarantined || journal.quarantined) {
      throw new ProtocolError({ detail: "LSP HostKernel process generation is closed or quarantined" })
    }
    dispatchesInFlight += 1
    let sequenceAllocated = false
    try {
      const lease = await input.guard.authorizeOperation({
        processRef: hostProcessRef,
        method,
        ...(id === undefined ? {} : { requestID: id }),
        params,
        workspaceRevision: context.workspaceRevision,
        ...(context.managedAttempt === undefined ? {} : { managedAttempt: context.managedAttempt }),
        ...(context.directAttempt === undefined ? {} : { directAttempt: context.directAttempt }),
      })
      if (closed || quarantined) {
        throw new ProtocolError({ detail: "LSP HostKernel process generation is closed or quarantined" })
      }
      const nextSequence = sequence.next(hostProcessRef)
      sequenceAllocated = true
      const request: LspProtocolOperationRequestV1 = {
        hostProcessRef,
        sessionID: context.sessionID,
        locationID: context.locationID,
        workspaceRevision: context.workspaceRevision,
        ...leaseFields(lease),
        ...(context.managedAttempt === undefined ? {} : { managedAttempt: context.managedAttempt }),
        ...(context.directAttempt === undefined ? {} : { directAttempt: context.directAttempt }),
        operation: {
          requestSequence: nextSequence,
          method,
          ...(id === undefined ? {} : { requestID: id }),
          params,
        },
      }
       const receipt = await outbound.run(() => {
         if (closed || quarantined || cursor.quarantined || journal.quarantined) {
           throw new ProtocolError({ detail: "LSP HostKernel process generation is closed or quarantined" })
         }
         return dispatchLspProtocolOperationV1(request, input.transport.protocolOp)
       })
      return journal.acceptOperation(request, receipt)
    } catch (error) {
      if (sequenceAllocated) failGeneration(error)
      throw error
    } finally {
      dispatchesInFlight -= 1
    }
  }

  const replyToServerRequest = async (event: Extract<LspEventPageV1["events"][number], { messageKind: "server_request" }>) => {
    const { requestID, method, params } = event.payload
    const handler = requests.get(method)
    if (!handler) throw new ProtocolError({ detail: `no bounded LSP server-request handler for ${method}` })
    const validatedParams = validateLspServerRequestParamsV1(method, params)
    const result = (await handler(validatedParams)) ?? null
    if (closed || quarantined || cursor.quarantined || journal.quarantined) {
      throw new ProtocolError({ detail: "LSP HostKernel process generation is closed or quarantined" })
    }
    dispatchesInFlight += 1
    try {
      const lease = await input.guard.authorizeReply({
        processRef: hostProcessRef,
        method,
        serverRequestID: requestID,
        result,
        workspaceRevision: context.workspaceRevision,
        ...(context.managedAttempt === undefined ? {} : { managedAttempt: context.managedAttempt }),
        ...(context.directAttempt === undefined ? {} : { directAttempt: context.directAttempt }),
      })
      if (closed || quarantined || cursor.quarantined || journal.quarantined) {
        throw new ProtocolError({ detail: "LSP HostKernel process generation is closed or quarantined" })
      }
      const nextSequence = sequence.next(hostProcessRef)
      const request: LspProtocolReplyRequestV1 = {
        schemaVersion: 1,
        hostProcessRef,
        sessionID: context.sessionID,
        locationID: context.locationID,
        workspaceRevision: context.workspaceRevision,
        ...leaseFields(lease),
        ...(context.managedAttempt === undefined ? {} : { managedAttempt: context.managedAttempt }),
        ...(context.directAttempt === undefined ? {} : { directAttempt: context.directAttempt }),
        reply: {
          schemaVersion: 1,
          requestSequence: nextSequence,
          serverRequestID: requestID,
          method,
          result,
        },
      }
       const receipt = await outbound.run(() => {
         if (closed || quarantined || cursor.quarantined || journal.quarantined) {
           throw new ProtocolError({ detail: "LSP HostKernel process generation is closed or quarantined" })
         }
         return dispatchLspProtocolReplyV1(request, input.transport.protocolReply)
       })
      journal.acceptProtocolReply(request, receipt)
    } finally {
      dispatchesInFlight -= 1
    }
  }

  const processPage = async (page: LspEventPageV1) => {
    journal.acceptPage(page)
    for (const event of page.events) {
      if (event.messageKind === "notification") {
        for (const handler of notifications.get(event.payload.method) ?? []) handler(event.payload.params)
      } else if (event.messageKind === "server_request") {
        await replyToServerRequest(event)
      } else {
        const key = event.payload.requestSequence
        const waiting = pending.get(key)
        if (!waiting) throw new ProtocolError({ detail: "LSP response has no live request waiter" })
        pending.delete(key)
        if (
          requestIDKey(waiting.requestID) !== requestIDKey(event.payload.requestID) ||
          waiting.method !== event.payload.method
        ) throw new ProtocolError({ detail: "LSP response does not match its live request" })
        if (Object.hasOwn(event.payload, "error")) {
          waiting.reject(new Error(event.payload.error!.message))
        } else {
          waiting.resolve(event.payload.result)
        }
      }
    }
    if (page.status === "UNKNOWN" || page.status === "EXITED") {
      failGeneration(new ProtocolError({ detail: `LSP HostKernel process ended with ${page.status}` }))
    }
  }

  const poll = async () => {
    let delayMs = 50
    while (!closed && !quarantined) {
      try {
        if (dispatchesInFlight > 0) {
          await sleep(delayMs)
          delayMs = Math.min(500, delayMs * 2)
          continue
        }
        const raw = await input.transport.protocolRead(cursor.readRequest())
        // A nonblocking read may have started just before a new operation and
        // return its response before that operation's durable ACK. Do not
        // process the page until the outbound journal has recorded that ACK.
        while (!closed && dispatchesInFlight > 0) await sleep(25)
        if (closed) break
        const page = cursor.accept(raw)
        await processPage(page)
        if (closed || quarantined || page.status !== "RUNNING") break
        if (page.events.length === 0) {
          await sleep(delayMs)
          delayMs = Math.min(500, delayMs * 2)
        } else {
          delayMs = 50
        }
      } catch (error) {
        failGeneration(error)
        break
      }
    }
  }

  return {
    onNotification(method, handler) {
      const handlers = notifications.get(method) ?? new Set()
      handlers.add(handler)
      notifications.set(method, handlers)
    },
    onRequest(method, handler) {
      requests.set(method, handler as (params: unknown) => unknown | Promise<unknown>)
    },
    listen() {
      if (listening) return
      if (closed || quarantined) throw new ProtocolError({ detail: "cannot listen on a closed or quarantined LSP adapter" })
      listening = true
      void poll()
    },
    async sendRequest<T = unknown, M extends LspRequestMethodV1 = LspRequestMethodV1>(
      method: M,
      params: LspRequestParams[M],
    ): Promise<T> {
      if (closed || quarantined) throw new ProtocolError({ detail: "LSP HostKernel process generation is closed or quarantined" })
      if (!listening) throw new ProtocolError({ detail: "LSP response stream must be listening before requests are sent" })
      if (requestID >= Number.MAX_SAFE_INTEGER) throw new ProtocolError({ detail: "LSP request ID space exhausted" })
      requestID += 1
      const id = `hc-lsp-${requestID}`
      let resolve!: (value: unknown) => void
      let reject!: (error: Error) => void
      const response = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail })
      dispatchesInFlight += 1
      let admitted = false
      let sequenceKey: string | undefined
      try {
        const lease = await input.guard.authorizeOperation({
          processRef: hostProcessRef,
          method,
          requestID: id,
          params,
          workspaceRevision: context.workspaceRevision,
          ...(context.managedAttempt === undefined ? {} : { managedAttempt: context.managedAttempt }),
          ...(context.directAttempt === undefined ? {} : { directAttempt: context.directAttempt }),
        })
        admitted = true
        if (closed || quarantined) {
          throw new ProtocolError({ detail: "LSP HostKernel process generation is closed or quarantined" })
        }
        const nextSequence = sequence.next(hostProcessRef)
        sequenceKey = nextSequence
        const waiting: PendingResponse = { requestID: id, method, resolve, reject }
        pending.set(nextSequence, waiting)
        const request: LspProtocolOperationRequestV1 = {
          hostProcessRef,
          sessionID: context.sessionID,
          locationID: context.locationID,
          workspaceRevision: context.workspaceRevision,
          ...leaseFields(lease),
          ...(context.managedAttempt === undefined ? {} : { managedAttempt: context.managedAttempt }),
          ...(context.directAttempt === undefined ? {} : { directAttempt: context.directAttempt }),
          operation: { requestSequence: nextSequence, requestID: id, method, params },
        }
          const receipt = await outbound.run(() => {
            if (closed || quarantined || cursor.quarantined || journal.quarantined) {
              throw new ProtocolError({ detail: "LSP HostKernel process generation is closed or quarantined" })
            }
            return dispatchLspProtocolOperationV1(request, input.transport.protocolOp)
          })
        journal.acceptOperation(request, receipt)
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("LSP operation dispatch outcome is unknown")
        reject(failure)
        if (sequenceKey !== undefined) pending.delete(sequenceKey)
        if (admitted) failGeneration(failure)
      } finally {
        dispatchesInFlight -= 1
      }
      return response as Promise<T>
    },
    async sendNotification<M extends LspNotificationMethodV1>(method: M, params: LspNotificationParams[M]): Promise<void> {
      await dispatch(method, params)
    },
    end() {
      closed = true
      const failure = new ProtocolError({ detail: "LSP HostKernel adapter ended" })
      for (const item of pending.values()) item.reject(failure)
      pending.clear()
    },
    dispose() {
      closed = true
      failGeneration(new ProtocolError({ detail: "LSP HostKernel adapter disposed" }))
      notifications.clear()
      requests.clear()
    },
  }
}
