import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/experimental/automation"
const ID = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256), Schema.isPattern(/^[A-Za-z0-9._-]{1,256}$/))
const Decimal = Schema.String.check(Schema.makeFilter((value) => {
  const max = "18446744073709551615"
  return /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    (value.length < max.length || (value.length === max.length && value <= max))
    ? undefined
    : "must be a canonical unsigned 64-bit decimal string"
}))
const DeliveryID = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200), Schema.isPattern(/^[A-Za-z0-9._-]{1,200}$/))
const SessionQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: ID })
const Retry = Schema.Struct({
  maxAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(16)),
  initialDelayMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2_592_000_000)),
  maxDelayMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2_592_000_000)),
})
export const AutomationDefinitionInput = Schema.Struct({
  actionCapabilityID: ID,
  actionVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  actionDigest: Schema.String.check(Schema.isPattern(/^(sha256|blake3):[0-9a-f]{64}$/)),
  actionSchemaDigest: Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/)),
  actionInputJSON: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16 * 1024)),
  scheduleExpression: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  timezone: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  enabled: Schema.Boolean,
  overlapPolicy: Schema.Literals(["SKIP", "QUEUE_ONE"]),
  missedRunPolicy: Schema.Literals(["SKIP", "RUN_LATEST", "QUEUE_ONE"]),
  retry: Retry,
})
const AutomationMutation = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionID: ID,
  automationID: ID,
  idempotencyKey: DeliveryID,
  expectedVersion: Decimal,
  definition: AutomationDefinitionInput,
})
const AutomationControl = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionID: ID,
  automationID: ID,
  idempotencyKey: DeliveryID,
  expectedVersion: Decimal,
})
const Occurrence = Schema.Struct({
  occurrenceID: ID,
  scheduledAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  attempt: Schema.Int,
  status: Schema.String,
  retryAtMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  cancelRequested: Schema.Boolean,
  guardReceiptRef: Schema.NullOr(Schema.String),
})
const Definition = Schema.Struct({
  actionCapabilityID: ID,
  actionVersion: Schema.Int,
  actionDigest: Schema.String,
  actionSchemaDigest: Schema.NullOr(Schema.String),
  actionInputJSON: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16 * 1024))),
  scheduleExpression: Schema.String,
  timezone: Schema.String,
  enabled: Schema.Boolean,
  overlapPolicy: Schema.Literals(["SKIP", "QUEUE_ONE"]),
  missedRunPolicy: Schema.Literals(["SKIP", "RUN_LATEST", "QUEUE_ONE"]),
  retry: Retry,
})
const Summary = Schema.Struct({
  automationID: ID,
  version: Decimal,
  definition: Definition,
  active: Schema.NullOr(Occurrence),
  pending: Schema.NullOr(Occurrence),
  retryPending: Schema.NullOr(Occurrence),
  historyCount: Schema.Int,
  invocation: Schema.Struct({ available: Schema.Literal(false), reason: Schema.Literal("guarded_invocation_unavailable") }),
})
const MutationResult = Schema.Struct({
  automation: Summary,
  status: Schema.Literals(["created", "updated", "enabled", "disabled"]),
  invocation: Schema.Struct({ available: Schema.Literal(false), reason: Schema.Literal("guarded_invocation_unavailable") }),
})
const ListResult = Schema.Struct({ automations: Schema.Array(Summary).check(Schema.isMaxLength(128)) })
const HistoryResult = Schema.Struct({ automationID: ID, version: Decimal, history: Schema.Array(Occurrence).check(Schema.isMaxLength(128)), hasMore: Schema.Boolean })
export class ApiAutomationError extends Schema.ErrorClass<ApiAutomationError>("AutomationError")(
  { name: Schema.Literal("AutomationError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 400 },
) {}
export class ApiAutomationForbiddenError extends Schema.ErrorClass<ApiAutomationForbiddenError>("AutomationForbiddenError")(
  { name: Schema.Literal("AutomationForbiddenError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 403 },
) {}
export class ApiAutomationConflictError extends Schema.ErrorClass<ApiAutomationConflictError>("AutomationConflictError")(
  { name: Schema.Literal("AutomationConflictError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 409 },
) {}
export class ApiAutomationNotFoundError extends Schema.ErrorClass<ApiAutomationNotFoundError>("AutomationNotFoundError")(
  { name: Schema.Literal("AutomationNotFoundError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 404 },
) {}
export class ApiAutomationUnavailableError extends Schema.ErrorClass<ApiAutomationUnavailableError>("AutomationUnavailableError")(
  { name: Schema.Literal("AutomationUnavailableError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 503 },
) {}
const automationErrors = [ApiAutomationError, ApiAutomationForbiddenError, ApiAutomationConflictError, ApiAutomationNotFoundError, ApiAutomationUnavailableError] as const

export const AutomationApi = HttpApi.make("automation")
  .add(
    HttpApiGroup.make("automation")
      .add(
        HttpApiEndpoint.get("automationList", `${root}/list`, {
          query: SessionQuery,
          success: described(ListResult, "Bounded Rust-owned automation definitions"),
          error: automationErrors,
        }),
        HttpApiEndpoint.get("automationInspect", `${root}/inspect`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: ID, automationID: ID }),
          success: described(Summary, "Automation definition and current occurrence state"),
          error: automationErrors,
        }),
        HttpApiEndpoint.get("automationHistory", `${root}/history`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: ID, automationID: ID, limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(128))) }),
          success: described(HistoryResult, "Bounded latest-first automation occurrence history"),
          error: automationErrors,
        }),
        HttpApiEndpoint.post("automationCreate", `${root}/create`, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          payload: Schema.Struct({ schemaVersion: Schema.Literal(1), sessionID: ID, automationID: ID, idempotencyKey: DeliveryID, definition: AutomationDefinitionInput }),
          success: described(MutationResult, "Committed automation definition"),
          error: automationErrors,
        }),
        HttpApiEndpoint.post("automationUpdate", `${root}/update`, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          payload: AutomationMutation,
          success: described(MutationResult, "Updated automation definition"),
          error: automationErrors,
        }),
        HttpApiEndpoint.post("automationEnable", `${root}/enable`, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          payload: AutomationControl,
          success: described(MutationResult, "Enabled automation definition"),
          error: automationErrors,
        }),
        HttpApiEndpoint.post("automationDisable", `${root}/disable`, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          payload: AutomationControl,
          success: described(MutationResult, "Disabled automation definition"),
          error: automationErrors,
        }),
        HttpApiEndpoint.post("automationRunNow", `${root}/run-now`, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          payload: AutomationControl,
          success: described(MutationResult, "Unavailable until guarded invocation is enabled"),
          error: automationErrors,
        }),
      )
      .annotateMerge(OpenApi.annotations({ title: "automation", description: "Authenticated Rust-journal automation controls. Invocation remains unavailable until Guarded effects are supported." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
