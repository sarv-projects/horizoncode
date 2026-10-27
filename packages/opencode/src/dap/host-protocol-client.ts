import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  freezeDirectAttemptScope,
  freezeManagedAttemptScope,
  validateHostProcessRef,
  validateHostProcessScope,
  type HostProcessRefV1,
} from "@/lsp/process-scope"
import {
  HostDapEventCursorV1,
  HostDapProtocolJournalV1,
  createHostKernelDapProtocolAdapterV1,
  type ExecutionHostProtocolRequestV1,
  type HostCommand,
  type HostDapProtocolAdapter,
  type HostOperationRequestV1,
  validateDapAuthorizationArgumentsV1,
} from "./protocol"
import {
  OutboundProtocolSequenceV1,
  ProtocolAdmissionDeniedError,
  ProtocolDispatchUncertainError,
  isDefinitiveProtocolAdmissionFailure,
  type HostProtocolDispatchReceiptV1,
} from "@/lsp/protocol"
import { guardActionID, operationForCommand } from "./session"
import { assertHostProtocolAllowed } from "@/lsp/launch"

type ProtocolLeaseV1 = {
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: string
  readonly capabilityLeaseDigest: string
}

type ProtocolScopeV1 = {
  readonly hostProcessRef: HostProcessRefV1
  /** HostKernel-minted terminal target supplied by the authenticated host, never DAP arguments. */
  readonly targetHostProcessRef?: HostProcessRefV1
  /** Projected from the trusted immutable DAP launch profile; Guard still authorizes each call. */
  readonly dapPolicy?: { readonly allowEvaluate: boolean }
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

type PendingResponse = {
  readonly requestID: number
  readonly command: HostCommand
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

type AuthorizeProtocolV1 = (input: {
  readonly capabilityID: string
  readonly authorization: Readonly<Record<string, unknown>>
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}) => Promise<ProtocolLeaseV1>

/** The current per-process sandbox namespaces do not prove the adapter can
 * observe/ptrace the guarded terminal target. Keep attach independently closed. */
const DAP_ATTACH_RUNTIME_READY = false

/**
 * Core DAP client over the shared typed HostKernel process supervisor. It
 * contains no adapter stdio, frame codec, PID, or process-control primitive.
 * Attach remains closed until same-authority namespace/ptrace acceptance.
 * Evaluation requires the immutable trusted-profile opt-in and a fresh
 * `debug.evaluate` Guard lease; HostKernel independently checks both pins.
 */
export class HostKernelDapProtocolClientV1 {
  readonly #scope: ProtocolScopeV1
  readonly #host: HostDapProtocolAdapter
  readonly #cursor: HostDapEventCursorV1
  readonly #journal: HostDapProtocolJournalV1
  readonly #authorize: AuthorizeProtocolV1
  readonly #onTerminalFailure?: (error: Error) => Promise<void>
  readonly #outbound: OutboundProtocolSequenceV1
  readonly #events = new Set<(event: unknown) => void>()
  readonly #pending = new Map<string, PendingResponse>()
  #nextRequestID = 0
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
    if (processRef.kind !== "debug_adapter") throw new TypeError("DAP protocol client requires a debug_adapter process")
    const targetProcessRef = input.scope.targetHostProcessRef === undefined
      ? undefined
      : validateHostProcessRef(input.scope.targetHostProcessRef)
    const dapPolicy = input.scope.dapPolicy
    if (dapPolicy !== undefined && (typeof dapPolicy !== "object" || dapPolicy === null ||
        Object.keys(dapPolicy).length !== 1 || !Object.hasOwn(dapPolicy, "allowEvaluate") ||
        typeof dapPolicy.allowEvaluate !== "boolean")) {
      throw new TypeError("DAP protocol client received a malformed immutable adapter policy")
    }
    if (targetProcessRef && (targetProcessRef.kind !== "terminal_run" || targetProcessRef.ownerEpoch !== processRef.ownerEpoch)) {
      throw new TypeError("DAP attach target must be a same-epoch HostKernel terminal_run process")
    }
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
      throw new TypeError("DAP protocol client cannot combine managed and direct Attempt scopes")
    }
    this.#scope = Object.freeze({
      ...input.scope,
      hostProcessRef: Object.freeze({ ...processRef }),
      ...(targetProcessRef === undefined ? {} : { targetHostProcessRef: Object.freeze({ ...targetProcessRef }) }),
      ...(dapPolicy === undefined ? {} : { dapPolicy: Object.freeze({ allowEvaluate: dapPolicy.allowEvaluate }) }),
      ...(input.scope.managedAttempt === undefined ? {} : { managedAttempt: freezeManagedAttemptScope(input.scope.managedAttempt) }),
      ...(input.scope.directAttempt === undefined ? {} : { directAttempt: freezeDirectAttemptScope(input.scope.directAttempt) }),
    })
    this.#host = createHostKernelDapProtocolAdapterV1(input.requestHostKernel)
    this.#authorize = input.authorize
    this.#onTerminalFailure = input.onTerminalFailure
    this.#outbound = new OutboundProtocolSequenceV1(processRef)
    this.#cursor = new HostDapEventCursorV1(
      processRef,
      input.scope.sessionID,
      input.scope.locationID,
      input.scope.workspaceRevision,
      this.#scope.managedAttempt,
      this.#scope.directAttempt,
    )
    this.#journal = new HostDapProtocolJournalV1(processRef, input.scope.workspaceRevision)
  }

  onEvent(handler: (event: unknown) => void): () => void {
    this.#events.add(handler)
    return () => this.#events.delete(handler)
  }

  listen(): void {
    this.#assertLive()
    if (this.#pump) return
    assertHostProtocolAllowed()
    this.#pump = this.#poll()
  }

  async sendRequest(command: HostCommand, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.#assertLive()
    if (command === "attach" && !DAP_ATTACH_RUNTIME_READY) {
      throw new Error("DAP attach requires an accepted shared debuggee namespace and ptrace policy")
    }
    if (command === "evaluate" && this.#scope.dapPolicy?.allowEvaluate !== true) {
      throw new Error("DAP evaluate is unavailable unless the trusted immutable adapter profile enables it")
    }
    if (!this.#pump) throw new Error("HostKernel DAP protocol client must listen before sending requests")
    let operationArgs = args
    if (command === "attach") {
      if (Object.keys(args).length !== 0) throw new TypeError("DAP attach accepts no caller-supplied target arguments")
      const target = this.#scope.targetHostProcessRef
      if (!target) throw new Error("DAP attach requires a host-supplied HostKernel terminal target")
      validateHostProcessScope({
        sessionID: this.#scope.sessionID,
        locationID: this.#scope.locationID,
        ownerEpoch: target.ownerEpoch,
        workspaceRevision: this.#scope.workspaceRevision,
        managedAttemptScope: this.#scope.managedAttempt,
        directAttemptScope: this.#scope.directAttempt,
        workspaceID: this.#scope.directAttempt?.workspaceID,
      })
      operationArgs = { targetHostProcessRef: target }
    }
    const operation = operationForCommand(command)
    const capabilityID = operation && guardActionID(operation)
    if (!capabilityID) throw new ProtocolAdmissionDeniedError({ operation: command })
    const authorizationArguments = validateDapAuthorizationArgumentsV1(command, operationArgs, this.#scope.dapPolicy)
    const dispatch = this.#dispatchTail.then(async () => {
      this.#assertLive()
      if (this.#readBarrier) await this.#readBarrier
      const requestSequence = this.#outbound.next(this.#scope.hostProcessRef)
      const requestID = this.#nextID()
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
              protocol: "dap",
              requestSequence,
              operation: { requestSequence, requestID, command, arguments: authorizationArguments },
            },
            managedAttempt: this.#scope.managedAttempt,
            directAttempt: this.#scope.directAttempt,
          })
        } catch (error) {
          throw new ProtocolAdmissionDeniedError({ operation: command, ...hostCodeFields(error) })
        }
        if (lease.capabilityID !== capabilityID) {
          throw new ProtocolAdmissionDeniedError({ operation: command, hostCode: "capability_unavailable" })
        }
        const request: HostOperationRequestV1 = {
          hostProcessRef: this.#scope.hostProcessRef,
          sessionID: this.#scope.sessionID,
          locationID: this.#scope.locationID,
          workspaceRevision: this.#scope.workspaceRevision,
          ...(this.#scope.managedAttempt === undefined ? {} : { managedAttempt: this.#scope.managedAttempt }),
          ...(this.#scope.directAttempt === undefined ? {} : { directAttempt: this.#scope.directAttempt }),
          ...lease,
          operation: { requestSequence, requestID, command, arguments: authorizationArguments },
        }
        let receipt: HostProtocolDispatchReceiptV1
        try {
          receipt = await this.#host.protocolOp(request)
        } catch (error) {
          if (isDefinitiveProtocolAdmissionFailure(error)) throw error
          throw new ProtocolDispatchUncertainError({ operation: command })
        }
        try {
          this.#journal.acceptOperation(request, receipt)
        } catch {
          throw new ProtocolDispatchUncertainError({ operation: command })
        }
        let resolve!: (value: unknown) => void
        let reject!: (error: Error) => void
        const response = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail })
        this.#pending.set(requestSequence, { requestID, command, resolve, reject })
        return { response }
      } catch (error) {
        if (isDefinitiveProtocolAdmissionFailure(error)) {
          this.#outbound.rollback(requestSequence, this.#scope.hostProcessRef)
          if (error instanceof ProtocolAdmissionDeniedError) throw error
          throw new ProtocolAdmissionDeniedError({ operation: command, ...hostCodeFields(error) })
        }
        throw new ProtocolDispatchUncertainError({ operation: command })
      }
    })
    this.#dispatchTail = dispatch.then(() => undefined, (error) => {
      if (error instanceof ProtocolDispatchUncertainError) this.#quarantine(error)
    })
    return dispatch.then((result) => result.response)
  }

  end(): void {
    this.#closed = true
    this.#failPending(new Error("DAP protocol connection ended"))
    this.#events.clear()
  }

  async #poll(): Promise<void> {
    while (!this.#closed && !this.#failure) {
      try {
        await this.#dispatchTail
        this.#assertLive()
        let finishRead!: () => void
        const readBarrier = new Promise<void>((resolve) => { finishRead = resolve })
        this.#readBarrier = readBarrier
        let accepted: ReturnType<HostDapEventCursorV1["accept"]>
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
          if (event.messageKind === "response") {
            const pending = this.#pending.get(event.payload.requestSequence)
            if (!pending || pending.requestID !== event.payload.requestID || pending.command !== event.payload.command) {
              throw new Error("DAP response does not match a pending request")
            }
            this.#pending.delete(event.payload.requestSequence)
            if (!event.payload.success) pending.reject(new Error(event.payload.message ?? "DAP request failed"))
            else pending.resolve(event.payload.body)
          } else {
            for (const handler of [...this.#events]) handler(event.payload)
          }
        }
        if (accepted.status !== "RUNNING") throw new Error("DAP process is no longer running; new generation required")
        if (accepted.events.length === 0) await delay(50)
      } catch (error) {
        this.#failure = asError(error)
        this.#closed = true
        this.#failPending(this.#failure)
        this.#notifyTerminalFailure(this.#failure)
      }
    }
  }

  #nextID(): number {
    if (this.#nextRequestID >= Number.MAX_SAFE_INTEGER) throw new Error("DAP request ID space exhausted")
    this.#nextRequestID += 1
    return this.#nextRequestID
  }

  #assertLive(): void {
    if (this.#closed || this.#failure || this.#cursor.quarantined || this.#journal.quarantined) {
      throw this.#failure ?? new Error("DAP process generation is quarantined")
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
          "DAP process generation failed and its exact supervised process could not be confirmed stopped",
        )
      })
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("DAP HostKernel protocol failed")
}

function hostCodeFields(error: unknown): { readonly hostCode?: string } {
  if (typeof error !== "object" || error === null) return {}
  const value = error as Record<string, unknown>
  return typeof value.hostCode === "string" ? { hostCode: value.hostCode } : {}
}
