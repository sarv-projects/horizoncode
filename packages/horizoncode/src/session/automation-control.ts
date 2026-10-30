/** Authenticated Core adapter for the Rust-owned automation.v1 journal. */
import { Effect, Schema } from "effect"
import type { TrustedPrincipal as TrustedPrincipalType } from "@horizoncode/core/trusted-principal"
import type { Location } from "@horizoncode/core/location"
import { SessionSupervisor, SessionSupervisorError } from "@horizoncode/core/session/supervisor"

const SERVICE = "automation.v1"
const ID = /^[A-Za-z0-9._-]{1,256}$/
const DIGEST = /^(sha256|blake3):[0-9a-f]{64}$/
const MAX_SCHEDULE_BYTES = 512
const MAX_TIMEZONE_BYTES = 128
const MAX_RETRY_MS = 30 * 24 * 60 * 60 * 1000
const MAX_U64 = 18_446_744_073_709_551_615n
// P1 has not yet exposed an authenticated canonical machine-registry schema
// descriptor/validator. Caller-supplied digests are pins, not authority, so
// creating or editing definitions must stop before asking Guard for a lease.
const AUTOMATION_SCHEMA_VALIDATION_AVAILABLE = false

export class AutomationControlError extends Schema.TaggedErrorClass<AutomationControlError>()(
  "AutomationControlError",
  { operation: Schema.String, code: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `Automation control ${this.operation} failed (${this.code}): ${this.reason}`
  }
}

export type AutomationDefinition = {
  readonly actionCapabilityID: string
  readonly actionVersion: number
  readonly actionDigest: string
  readonly actionSchemaDigest: string | null
  readonly actionInputJSON: string | null
  readonly scheduleExpression: string
  readonly timezone: string
  readonly enabled: boolean
  readonly overlapPolicy: "SKIP" | "QUEUE_ONE"
  readonly missedRunPolicy: "SKIP" | "RUN_LATEST" | "QUEUE_ONE"
  readonly retry: { readonly maxAttempts: number; readonly initialDelayMs: number; readonly maxDelayMs: number }
}

export type AutomationOccurrence = {
  readonly occurrenceID: string
  readonly scheduledAtMs: number
  readonly attempt: number
  readonly status: string
  readonly retryAtMs: number | null
  readonly cancelRequested: boolean
  readonly guardReceiptRef: string | null
}

export type AutomationSummary = {
  readonly automationID: string
  readonly version: string
  readonly definition: AutomationDefinition
  readonly active: AutomationOccurrence | null
  readonly pending: AutomationOccurrence | null
  readonly retryPending: AutomationOccurrence | null
  readonly historyCount: number
  readonly invocation: { readonly available: false; readonly reason: "guarded_invocation_unavailable" }
}

export type AutomationMutationResult = {
  readonly automation: AutomationSummary
  readonly status: "created" | "updated" | "enabled" | "disabled"
  readonly invocation: { readonly available: false; readonly reason: "guarded_invocation_unavailable" }
}

export type AutomationScope = {
  /** Location registered with HostKernel by the trusted Core supervisor. */
  readonly locationID: string
  /** Trusted Core Location used to register and guard user-originated mutations. */
  readonly locationRef: typeof Location.Ref.Type
  /** Core route context only; HostKernel automation authority is owner + Location scoped. */
  readonly sessionID: string
  readonly trustedPrincipal: TrustedPrincipalType
}

function record(operation: string, value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: `${label} is not an object` })
  }
  return value as Record<string, unknown>
}

function text(operation: string, value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max) {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: `${label} is invalid` })
  }
  return value
}

function id(operation: string, value: unknown, label: string): string {
  const result = text(operation, value, label)
  if (!ID.test(result)) throw new AutomationControlError({ operation, code: "managed_protocol", reason: `${label} is invalid` })
  return result
}

function revision(operation: string, value: unknown, label: string): string {
  const result = text(operation, value, label, 20)
  if (!/^(0|[1-9][0-9]{0,19})$/.test(result) || BigInt(result) > MAX_U64) {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: `${label} is not a canonical u64 revision` })
  }
  return result
}

function integer(operation: string, value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: `${label} is outside its bound` })
  }
  return value
}

function boolean(operation: string, value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new AutomationControlError({ operation, code: "managed_protocol", reason: `${label} is not boolean` })
  return value
}

function decodeOccurrence(operation: string, input: unknown): AutomationOccurrence {
  const value = record(operation, input, "occurrence")
  const retryAtMs = value.retryAtMs === null ? null : integer(operation, value.retryAtMs, "retryAtMs")
  const receipt = value.guardReceiptRef === null ? null : text(operation, value.guardReceiptRef, "guardReceiptRef")
  return {
    occurrenceID: id(operation, value.occurrenceID, "occurrenceID"),
    scheduledAtMs: integer(operation, value.scheduledAtMs, "scheduledAtMs"),
    attempt: integer(operation, value.attempt, "attempt", 1, 16),
    status: text(operation, value.status, "status", 32),
    retryAtMs,
    cancelRequested: boolean(operation, value.cancelRequested, "cancelRequested"),
    guardReceiptRef: receipt,
  }
}

function decodeDefinition(operation: string, input: unknown): AutomationDefinition {
  const value = record(operation, input, "definition")
  const retry = record(operation, value.retry, "retry")
  const overlapPolicy = value.overlapPolicy
  const missedRunPolicy = value.missedRunPolicy
  if (overlapPolicy !== "SKIP" && overlapPolicy !== "QUEUE_ONE") {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: "overlapPolicy is invalid" })
  }
  if (missedRunPolicy !== "SKIP" && missedRunPolicy !== "RUN_LATEST" && missedRunPolicy !== "QUEUE_ONE") {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: "missedRunPolicy is invalid" })
  }
  const actionDigest = text(operation, value.actionDigest, "actionDigest")
  if (!DIGEST.test(actionDigest)) throw new AutomationControlError({ operation, code: "managed_protocol", reason: "actionDigest is invalid" })
  const actionSchemaDigest = value.actionSchemaDigest === null || value.actionSchemaDigest === undefined ? null : text(operation, value.actionSchemaDigest, "actionSchemaDigest")
  if (actionSchemaDigest !== null && !/^blake3:[0-9a-f]{64}$/.test(actionSchemaDigest)) throw new AutomationControlError({ operation, code: "managed_protocol", reason: "actionSchemaDigest is invalid" })
  const actionInputJSON = value.actionInputJSON === null || value.actionInputJSON === undefined ? null : text(operation, value.actionInputJSON, "actionInputJSON", 16 * 1024)
  if (actionInputJSON !== null && !isCanonicalActionInputJSON(actionInputJSON)) throw new AutomationControlError({ operation, code: "managed_protocol", reason: "actionInputJSON is not bounded canonical JSON" })
  return {
    actionCapabilityID: id(operation, value.actionCapabilityID, "actionCapabilityID"),
    actionVersion: integer(operation, value.actionVersion, "actionVersion", 1),
    actionDigest,
    actionSchemaDigest,
    actionInputJSON,
    scheduleExpression: text(operation, value.scheduleExpression, "scheduleExpression", MAX_SCHEDULE_BYTES),
    timezone: text(operation, value.timezone, "timezone", MAX_TIMEZONE_BYTES),
    enabled: boolean(operation, value.enabled, "enabled"),
    overlapPolicy,
    missedRunPolicy,
    retry: {
      maxAttempts: integer(operation, retry.maxAttempts, "retry.maxAttempts", 1, 16),
      initialDelayMs: integer(operation, retry.initialDelayMs, "retry.initialDelayMs", 0, MAX_RETRY_MS),
      maxDelayMs: integer(operation, retry.maxDelayMs, "retry.maxDelayMs", 0, MAX_RETRY_MS),
    },
  }
}

function definitionInput(operation: string, input: AutomationDefinition): AutomationDefinition {
  const value = decodeDefinition(operation, input)
  if (value.actionSchemaDigest === null || value.actionInputJSON === null) {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: "legacy automation has no canonical action schema or fixed input payload; edit it with an authenticated registry binding before saving" })
  }
  if (value.retry.initialDelayMs > value.retry.maxDelayMs) {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: "retry initial delay exceeds maximum delay" })
  }
  return value
}

function isCanonicalActionInputJSON(source: string): boolean {
  if (Buffer.byteLength(source, "utf8") > 16 * 1024) return false
  try {
    const parsed: unknown = JSON.parse(source)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false
    let nodes = 0
    const canonical = (value: unknown, depth: number): string => {
      nodes += 1
      if (nodes > 2_048 || depth > 16) throw new Error("action input bound exceeded")
      if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new Error("action input number is not a safe integer")
        return String(value)
      }
      if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`
      if (typeof value === "object") {
        const fields = Object.entries(value as Record<string, unknown>)
        if (fields.some(([key]) => !/^[\x20-\x7e]*$/.test(key))) throw new Error("action input keys must be ASCII")
        fields.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(",")}}`
      }
      throw new Error("unsupported action input value")
    }
    return canonical(parsed, 1) === source
  } catch {
    return false
  }
}

function decodeSummary(operation: string, input: unknown): AutomationSummary {
  const value = record(operation, input, "automation")
  const invocation = record(operation, value.invocation, "invocation")
  if (invocation.available !== false || invocation.reason !== "guarded_invocation_unavailable") {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: "invocation availability projection is invalid" })
  }
  const optionalOccurrence = (entry: unknown) => entry === null ? null : decodeOccurrence(operation, entry)
  return {
    automationID: id(operation, value.automationID, "automationID"),
    version: revision(operation, value.version, "version"),
    definition: decodeDefinition(operation, value.definition),
    active: optionalOccurrence(value.active),
    pending: optionalOccurrence(value.pending),
    retryPending: optionalOccurrence(value.retryPending),
    historyCount: integer(operation, value.historyCount, "historyCount", 0),
    invocation: { available: false, reason: "guarded_invocation_unavailable" },
  }
}

function decodeMutation(operation: string, input: Record<string, unknown>, expectedStatus: AutomationMutationResult["status"], binding?: {
  readonly idempotencyKey: string
  readonly inputDigest: string
  readonly automationID: string
  readonly hostOperation: string
}): AutomationMutationResult {
  if (binding) {
    const receipt = record(operation, input.receipt, "receipt")
    const proof = record(operation, receipt.guardedProof, "guardedProof")
    const digest = (value: unknown, label: string) => {
      const parsed = text(operation, value, label)
      if (!/^blake3:[0-9a-f]{64}$/.test(parsed)) {
        throw new AutomationControlError({ operation, code: "managed_protocol", reason: `${label} is not a BLAKE3 digest` })
      }
      return parsed
    }
    if (
      input.status !== "COMMITTED" ||
      receipt.idempotencyKey !== binding.idempotencyKey ||
      receipt.requestDigest !== binding.inputDigest ||
      receipt.automationID !== binding.automationID ||
      receipt.operation !== binding.hostOperation
    ) {
      throw new AutomationControlError({ operation, code: "managed_protocol", reason: "HostKernel returned a mutation receipt with mismatched idempotency or approved input binding" })
    }
    revision(operation, receipt.definitionVersion, "receipt.definitionVersion")
    digest(proof.challengeDigest, "guardedProof.challengeDigest")
    digest(proof.effectIntentDigest, "guardedProof.effectIntentDigest")
    digest(proof.leaseDigest, "guardedProof.leaseDigest")
    digest(proof.executionReceiptDigest, "guardedProof.executionReceiptDigest")
  }
  const invocation = binding
    ? { available: false, reason: "guarded_invocation_unavailable" }
    : record(operation, input.invocation, "invocation")
  if ((binding ? input.status !== "COMMITTED" : input.status !== expectedStatus) || invocation.available !== false || invocation.reason !== "guarded_invocation_unavailable") {
    throw new AutomationControlError({ operation, code: "managed_protocol", reason: "mutation status or invocation projection is invalid" })
  }
  const automation = record(operation, input.automation, "automation")
  return {
    automation: decodeSummary(operation, { ...automation, invocation }),
    status: expectedStatus,
    invocation: { available: false, reason: "guarded_invocation_unavailable" },
  }
}

function automationMutation(
  operation: "create" | "update" | "enable" | "disable",
  scope: AutomationScope,
  automationID: string,
  idempotencyKey: string,
  arguments_: Readonly<Record<string, unknown>>,
  expectedStatus: AutomationMutationResult["status"],
) {
  return Effect.gen(function* () {
    const key = id(operation, idempotencyKey, "idempotencyKey")
    const targetID = id(operation, automationID, "automationID")
    const capabilityID = `automations.${operation}` as const
    const supervisor = yield* SessionSupervisor.Service
    const prepared = yield* supervisor.prepareUserEffect({
      locationRef: scope.locationRef,
      capabilityID,
      arguments: arguments_,
    }).pipe(Effect.catchTag("SessionSupervisorError", (error: SessionSupervisorError) =>
      Effect.fail(new AutomationControlError({ operation, code: error.hostCode ?? "guard_unavailable", reason: error.reason })),
    ))
    const inputDigest = prepared.inputDigest
    const challengeID = prepared.challengeID
    if (
      prepared.capabilityID !== capabilityID ||
      prepared.locationID !== scope.locationID ||
      !/^action_[A-Za-z0-9-]{1,128}$/.test(prepared.userActionID) ||
      !/^blake3:[0-9a-f]{64}$/.test(prepared.capabilityLeaseDigest) ||
      !inputDigest || !/^blake3:[0-9a-f]{64}$/.test(inputDigest) ||
      !challengeID || !ID.test(challengeID) ||
      prepared.effectID.length === 0 || !ID.test(prepared.effectID)
    ) {
      return yield* Effect.fail(new AutomationControlError({ operation, code: "managed_protocol", reason: "HostKernel returned an incomplete Guard approval and one-use lease binding" }))
    }

    const hostOperation = capabilityID
    const body = {
      locationID: prepared.locationID,
      userActionID: prepared.userActionID,
      challengeID,
      effectID: prepared.effectID,
      capabilityLeaseDigest: prepared.capabilityLeaseDigest,
      inputDigest,
      ...arguments_,
    }
    const binding = { idempotencyKey: key, inputDigest, automationID: targetID, hostOperation: operation }
    const attempted = yield* Effect.result(request(hostOperation, body, scope, key))
    let initialFailure: AutomationControlError | undefined
    if (attempted._tag === "Success") {
      const decoded = yield* Effect.result(Effect.try({
        try: () => decodeMutation(operation, attempted.success, expectedStatus, binding),
        catch: (error) => error instanceof AutomationControlError ? error : new AutomationControlError({ operation, code: "managed_protocol", reason: "HostKernel returned a malformed committed automation receipt" }),
      }))
      if (decoded._tag === "Success") return decoded.success
      initialFailure = decoded.failure
    } else {
      initialFailure = attempted.failure
    }

    // Once the one-use lease has been issued, a lost or malformed reply is
    // reconciled through a read-only host operation. Never repeat the mutation.
    const reconciled = yield* Effect.result(request("automations.reconcile", {
      locationID: prepared.locationID,
      userActionID: prepared.userActionID,
      challengeID,
      effectID: prepared.effectID,
      capabilityLeaseDigest: prepared.capabilityLeaseDigest,
      inputDigest,
      idempotencyKey: key,
      automationID: targetID,
      hostOperation,
    }, scope))
    if (reconciled._tag === "Failure") {
      return yield* Effect.fail(new AutomationControlError({ operation, code: "effect_outcome_unknown", reason: "Mutation reply was lost and HostKernel reconciliation is unavailable; do not retry this one-use action" }))
    }
    const state = reconciled.success.status
    if (state === "COMMITTED") {
      return yield* Effect.try({
        try: () => decodeMutation(operation, reconciled.success, expectedStatus, binding),
        catch: (error) => error instanceof AutomationControlError ? error : new AutomationControlError({ operation, code: "managed_protocol", reason: "HostKernel returned malformed reconciled automation evidence" }),
      })
    }
    if (state === "NOT_FOUND") {
      if (initialFailure?.code === "managed_conflict") return yield* Effect.fail(initialFailure)
      return yield* Effect.fail(new AutomationControlError({ operation, code: "mutation_not_committed", reason: "HostKernel proved no mutation committed; this consumed approval cannot be replayed. Prepare a new user action." }))
    }
    if (state === "CONFLICT") {
      return yield* Effect.fail(new AutomationControlError({ operation, code: "managed_conflict", reason: "Automation idempotency or version binding conflicts with the durable registry" }))
    }
    return yield* Effect.fail(new AutomationControlError({ operation, code: "effect_outcome_unknown", reason: "HostKernel could not reconcile the one-use mutation; do not retry or assume it committed" }))
  })
}

function request(
  operation: string,
  body: Readonly<Record<string, unknown>>,
  scope: AutomationScope,
  deliveryID?: string,
) {
  return Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    const result = yield* supervisor.requestHostKernel(SERVICE, operation, body, {
      trustedPrincipal: scope.trustedPrincipal,
      ...(deliveryID === undefined ? {} : { deliveryID }),
    }).pipe(Effect.catchTag("SessionSupervisorError", (error: SessionSupervisorError) =>
      Effect.fail(new AutomationControlError({ operation, code: error.hostCode ?? "managed_unavailable", reason: error.reason })),
    ))
    return result as Record<string, unknown>
  })
}

function scopeBody(operation: string, scope: AutomationScope) {
  return {
    locationID: id(operation, scope.locationID, "locationID"),
  }
}

export const list = Effect.fn("AutomationControl.list")(function* (scope: AutomationScope) {
  const operation = "automations.list"
  const response = yield* request(operation, scopeBody(operation, scope), scope)
  // Narrow through a local: property narrowing does not survive the closure
  // below, and each entry stays unknown until decodeSummary validates it.
  const automations: unknown = response.automations
  if (!Array.isArray(automations) || automations.length > 128) {
    return yield* Effect.fail(new AutomationControlError({ operation, code: "managed_protocol", reason: "automations is not bounded" }))
  }
  return yield* Effect.try({ try: () => ({ automations: automations.map((item: unknown) => decodeSummary(operation, item)) }), catch: (error) => error as AutomationControlError })
})

export const inspect = Effect.fn("AutomationControl.inspect")(function* (scope: AutomationScope, automationID: string) {
  const operation = "automations.inspect"
  const response = yield* request(operation, { ...scopeBody(operation, scope), automationID: id(operation, automationID, "automationID") }, scope)
  return yield* Effect.try({ try: () => decodeSummary(operation, response.automation), catch: (error) => error as AutomationControlError })
})

export const history = Effect.fn("AutomationControl.history")(function* (scope: AutomationScope, automationID: string, limit = 128) {
  const operation = "automations.history"
  const input = yield* Effect.try({
    try: () => ({
      automationID: id(operation, automationID, "automationID"),
      limit: integer(operation, limit, "limit", 1, 128),
    }),
    catch: (error) => error as AutomationControlError,
  })
  const response = yield* request(operation, { ...scopeBody(operation, scope), ...input }, scope)
  const history: unknown = response.history
  if (!Array.isArray(history) || history.length > 128) return yield* Effect.fail(new AutomationControlError({ operation, code: "managed_protocol", reason: "history is not bounded" }))
  return yield* Effect.try({ try: () => ({
    automationID: id(operation, response.automationID, "automationID"),
    version: revision(operation, response.version, "version"),
    history: history.map((item: unknown) => decodeOccurrence(operation, item)),
    hasMore: boolean(operation, response.hasMore, "hasMore"),
  }), catch: (error) => error as AutomationControlError })
})

export const create = Effect.fn("AutomationControl.create")(function* (scope: AutomationScope, automationID: string, idempotencyKey: string, definition: AutomationDefinition) {
  const operation = "create"
  if (!AUTOMATION_SCHEMA_VALIDATION_AVAILABLE) {
    return yield* Effect.fail(new AutomationControlError({
      operation,
      code: "capability_unavailable",
      reason: "canonical action schema validation is unavailable; no Guard approval or automation mutation was requested",
    }))
  }
  const key = id(operation, idempotencyKey, "idempotencyKey")
  const targetID = id(operation, automationID, "automationID")
  const clean = definitionInput(operation, definition)
  return yield* automationMutation(operation, scope, targetID, key, { automationID: targetID, definition: clean, idempotencyKey: key }, "created")
})

export const update = Effect.fn("AutomationControl.update")(function* (scope: AutomationScope, automationID: string, expectedVersion: string, idempotencyKey: string, definition: AutomationDefinition) {
  const operation = "update"
  if (!AUTOMATION_SCHEMA_VALIDATION_AVAILABLE) {
    return yield* Effect.fail(new AutomationControlError({
      operation,
      code: "capability_unavailable",
      reason: "canonical action schema validation is unavailable; no Guard approval or automation mutation was requested",
    }))
  }
  const key = id(operation, idempotencyKey, "idempotencyKey")
  const targetID = id(operation, automationID, "automationID")
  const expected = revision(operation, expectedVersion, "expectedVersion")
  const clean = definitionInput(operation, definition)
  return yield* automationMutation(operation, scope, targetID, key, { automationID: targetID, definition: clean, expectedVersion: expected, idempotencyKey: key }, "updated")
})

export const setEnabled = Effect.fn("AutomationControl.setEnabled")(function* (scope: AutomationScope, automationID: string, expectedVersion: string, idempotencyKey: string, enabled: boolean) {
  const operation = enabled ? "enable" : "disable"
  const input = yield* Effect.try({
    try: () => ({
      key: id(operation, idempotencyKey, "idempotencyKey"),
      targetID: id(operation, automationID, "automationID"),
      expected: revision(operation, expectedVersion, "expectedVersion"),
    }),
    catch: (error) => error as AutomationControlError,
  })
  return yield* automationMutation(operation, scope, input.targetID, input.key, { automationID: input.targetID, expectedVersion: input.expected, idempotencyKey: input.key }, enabled ? "enabled" : "disabled")
})

export const runNow = Effect.fn("AutomationControl.runNow")(function* (scope: AutomationScope, automationID: string, expectedVersion: string, idempotencyKey: string) {
  const operation = "run_now"
  // V1 has no Guarded automation invocation contract. Refuse locally before the
  // HostKernel boundary so this adapter cannot schedule or start an occurrence.
  return yield* Effect.try({
    try: () => {
      id(operation, automationID, "automationID")
      revision(operation, expectedVersion, "expectedVersion")
      id(operation, idempotencyKey, "idempotencyKey")
      scopeBody(operation, scope)
    },
    catch: (error) => error as AutomationControlError,
  }).pipe(Effect.flatMap(() => Effect.fail(new AutomationControlError({
    operation,
    code: "capability_unavailable",
    reason: "Guarded automation invocation is unavailable in V1",
  }))))
  return yield* Effect.fail(new AutomationControlError({
    operation,
    code: "capability_unavailable",
    reason: "Guarded automation invocation is unavailable in V1",
  }))
})
