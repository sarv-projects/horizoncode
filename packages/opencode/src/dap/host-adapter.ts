import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  HostDapEventCursorV1,
  HostDapProtocolJournalV1,
  type HostCommand,
  type HostEventName,
  type HostEventPageV1,
  type HostOperationRequestV1,
  ProtocolError,
  dispatchHostDapOperationV1,
} from "./protocol"
import {
  OutboundProtocolSequenceV1,
  type HostProtocolDispatchReceiptV1,
} from "@/lsp/protocol"
import {
  freezeDirectAttemptScope,
  freezeManagedAttemptScope,
  validateHostProcessRef,
  validateHostProcessScope,
  type HostProcessRefV1,
} from "@/lsp/process-scope"
import { makeProtocolDispatchQueue } from "@/lsp/protocol-dispatch-queue"

type GuardLease = {
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: string
  readonly capabilityLeaseDigest: string
}

type DapContext = {
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

/** HostKernel transport only. This boundary has no process, byte, stdio,
 * executable, cwd, environment or PID API. */
export type HostDapProtocolTransportV1 = {
  readonly protocolOp: (request: HostOperationRequestV1) => Promise<unknown>
  readonly protocolRead: (request: ReturnType<HostDapEventCursorV1["readRequest"]>) => Promise<unknown>
}

/** Every command gets its own current Guard lease. HostKernel repeats all
 * validation and is the only component allowed to dispatch it to the adapter. */
export type HostDapGuardAuthorizerV1 = {
  readonly authorizeCommand: (input: {
    readonly processRef: HostProcessRefV1
    readonly command: HostCommand
    readonly requestID: number
    readonly arguments: Readonly<Record<string, unknown>>
    readonly workspaceRevision: string
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly directAttempt?: DirectAttemptScopeV1
  }) => Promise<GuardLease>
}

type PendingResponse = {
  readonly requestID: number
  readonly command: HostCommand
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Typed DAP request/replay lifecycle. Production launch remains fail-closed
 * in dap/session.ts until P1 supplies the durable HostKernel dispatch journal,
 * retained event buffer, Guard lease path and confinement evidence. */
export function makeHostDapProtocolAdapterV1(input: {
  readonly context: DapContext
  readonly transport: HostDapProtocolTransportV1
  readonly guard: HostDapGuardAuthorizerV1
}) {
  const hostProcessRef = Object.freeze({ ...validateHostProcessRef(input.context.hostProcessRef) })
  if (hostProcessRef.kind !== "debug_adapter") {
    throw new ProtocolError({ detail: "DAP adapter requires a HostKernel debug_adapter process reference" })
  }
  if (!/^blake3:[0-9a-f]{64}$/.test(input.context.workspaceRevision)) {
    throw new ProtocolError({ detail: "DAP adapter requires a pinned workspace revision" })
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
    throw new ProtocolError({ detail: "DAP Attempt scope does not match its process/session/workspace binding" })
  }
  const context = Object.freeze({
    ...input.context,
    hostProcessRef,
    managedAttempt: freezeManagedAttemptScope(input.context.managedAttempt),
    directAttempt: freezeDirectAttemptScope(input.context.directAttempt),
  })
  const sequence = new OutboundProtocolSequenceV1(hostProcessRef)
  const cursor = new HostDapEventCursorV1(
    hostProcessRef,
    context.sessionID,
    context.locationID,
    context.workspaceRevision,
    context.managedAttempt,
    context.directAttempt,
  )
  const journal = new HostDapProtocolJournalV1(hostProcessRef, context.workspaceRevision)
  const pending = new Map<string, PendingResponse>()
  const eventHandlers = new Map<HostEventName, Set<(body: unknown) => void>>()
  let nextRequestID = 0
  let dispatchesInFlight = 0
  const outbound = makeProtocolDispatchQueue()
  let listening = false
  let closed = false
  let quarantined = false

  const failGeneration = (error: unknown) => {
    quarantined = true
    const failure = error instanceof Error ? error : new Error("DAP HostKernel protocol outcome is unknown")
    for (const waiter of pending.values()) waiter.reject(failure)
    pending.clear()
  }

  const processPage = async (page: HostEventPageV1) => {
    journal.acceptPage(page)
    for (const event of page.events) {
      if (event.messageKind === "event") {
        for (const handler of eventHandlers.get(event.payload.event) ?? []) handler(event.payload.body)
        continue
      }
      const key = event.payload.requestSequence
      const waiter = pending.get(key)
      if (!waiter || waiter.requestID !== event.payload.requestID || waiter.command !== event.payload.command) {
        throw new ProtocolError({ detail: "DAP response does not match a live request" })
      }
      pending.delete(key)
      if (event.payload.success) waiter.resolve(event.payload.body)
      else waiter.reject(new Error(event.payload.message ?? "DAP request failed"))
    }
    if (page.status === "EXITED" || page.status === "UNKNOWN") {
      failGeneration(new ProtocolError({ detail: `DAP HostKernel process ended with ${page.status}` }))
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
        // A response can be buffered before the matching durable dispatch ACK.
        while (!closed && dispatchesInFlight > 0) await sleep(25)
        if (closed) return
        const page = cursor.accept(raw)
        await processPage(page)
        if (closed || quarantined || page.status !== "RUNNING") return
        if (page.events.length === 0) {
          await sleep(delayMs)
          delayMs = Math.min(500, delayMs * 2)
        } else {
          delayMs = 50
        }
      } catch (error) {
        failGeneration(error)
        return
      }
    }
  }

  return {
    onEvent(event: HostEventName, handler: (body: unknown) => void) {
      const handlers = eventHandlers.get(event) ?? new Set()
      handlers.add(handler)
      eventHandlers.set(event, handlers)
    },
    listen() {
      if (listening) return
      if (closed || quarantined) throw new ProtocolError({ detail: "cannot listen on a closed or quarantined DAP adapter" })
      listening = true
      void poll()
    },
    async request(command: HostCommand, args: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (closed || quarantined) throw new ProtocolError({ detail: "DAP HostKernel process generation is closed or quarantined" })
      if (!listening) throw new ProtocolError({ detail: "DAP response stream must be listening before requests are sent" })
      if (nextRequestID >= Number.MAX_SAFE_INTEGER) throw new ProtocolError({ detail: "DAP request ID space exhausted" })
      nextRequestID += 1
      const id = nextRequestID
      let resolve!: (value: unknown) => void
      let reject!: (error: Error) => void
      const response = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail })
      dispatchesInFlight += 1
      let sequenceKey: string | undefined
      let admitted = false
      try {
        const lease = await input.guard.authorizeCommand({
          processRef: hostProcessRef,
          command,
          requestID: id,
          arguments: args,
          workspaceRevision: context.workspaceRevision,
          ...(context.managedAttempt === undefined ? {} : { managedAttempt: context.managedAttempt }),
          ...(context.directAttempt === undefined ? {} : { directAttempt: context.directAttempt }),
        })
        admitted = true
        if (closed || quarantined) throw new ProtocolError({ detail: "DAP HostKernel process generation closed during authorization" })
        const requestSequence = sequence.next(hostProcessRef)
        sequenceKey = requestSequence
        pending.set(requestSequence, { requestID: id, command, resolve, reject })
        const request: HostOperationRequestV1 = {
          hostProcessRef,
          sessionID: context.sessionID,
          locationID: context.locationID,
          workspaceRevision: context.workspaceRevision,
          effectID: lease.effectID,
          challengeID: lease.challengeID,
          capabilityID: lease.capabilityID,
          capabilityLeaseDigest: lease.capabilityLeaseDigest,
          ...(context.managedAttempt === undefined ? {} : { managedAttempt: context.managedAttempt }),
          ...(context.directAttempt === undefined ? {} : { directAttempt: context.directAttempt }),
          operation: { requestSequence, requestID: id, command, arguments: args },
        }
        const receipt: HostProtocolDispatchReceiptV1 = await outbound.run(() =>
          dispatchHostDapOperationV1(request, input.transport.protocolOp),
        )
        journal.acceptOperation(request, receipt)
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("DAP operation dispatch outcome is unknown")
        reject(failure)
        if (sequenceKey !== undefined) pending.delete(sequenceKey)
        if (admitted) failGeneration(failure)
      } finally {
        dispatchesInFlight -= 1
      }
      return response
    },
    close() {
      closed = true
      const failure = new ProtocolError({ detail: "DAP HostKernel adapter closed" })
      for (const waiter of pending.values()) waiter.reject(failure)
      pending.clear()
      eventHandlers.clear()
    },
    dispose() {
      closed = true
      failGeneration(new ProtocolError({ detail: "DAP HostKernel adapter disposed" }))
      eventHandlers.clear()
    },
  }
}
