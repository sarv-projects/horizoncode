import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SessionSupervisor, type Service as SessionSupervisorService } from "@horizoncode/core/session/supervisor"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import * as AutomationControl from "@/session/automation-control"
import { InstanceHttpApi } from "../api"
import {
  ApiAutomationConflictError,
  ApiAutomationError,
  ApiAutomationForbiddenError,
  ApiAutomationNotFoundError,
  ApiAutomationUnavailableError,
} from "../groups/automation"

export const automationHandlers = HttpApiBuilder.group(InstanceHttpApi, "automation", (handlers) =>
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    const principal = Effect.gen(function* () {
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (!Option.isSome(authenticated) || authenticated.value.principal.kind !== "server_auth") {
        return yield* Effect.fail(new ApiAutomationForbiddenError({
          name: "AutomationForbiddenError",
          data: { code: "authorization", reason: "automation control requires an authenticated ServerAuth principal" },
        }))
      }
      return authenticated.value.principal
    })
    const scope = (sessionID: string) => Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const trustedPrincipal = yield* principal
      const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      const locationID = yield* supervisor.registerHostLocation(
        locationRef,
      ).pipe(Effect.mapError((error) => new ApiAutomationUnavailableError({
        name: "AutomationUnavailableError",
        data: { code: "managed_unavailable", reason: error.message },
      })))
      return { locationID, locationRef, sessionID, trustedPrincipal }
    })
    const failure = (error: AutomationControl.AutomationControlError) => {
      const data = { code: error.code, reason: error.reason }
      if (error.code === "authorization") return new ApiAutomationForbiddenError({ name: "AutomationForbiddenError", data })
      if (error.code === "managed_not_found") return new ApiAutomationNotFoundError({ name: "AutomationNotFoundError", data })
      if (error.code === "managed_conflict") return new ApiAutomationConflictError({ name: "AutomationConflictError", data })
      if (error.code === "managed_unavailable" || error.code === "capability_unavailable" || error.code === "CAPABILITY_UNAVAILABLE" || error.code === "UNAVAILABLE") {
        return new ApiAutomationUnavailableError({ name: "AutomationUnavailableError", data })
      }
      return new ApiAutomationError({ name: "AutomationError", data })
    }
    // The control effects require the handler's captured supervisor and the
    // scope's authenticated principal; both are bound here so no group handler
    // leaks a service requirement into the route's never-requirement contract.
    const provideScope = <A, E>(
      sessionID: string,
      effect: (value: AutomationControl.AutomationScope) => Effect.Effect<A, E, SessionSupervisorService | TrustedPrincipalContext>,
    ) =>
      scope(sessionID).pipe(
        Effect.flatMap((value) =>
          effect(value).pipe(Effect.provideService(TrustedPrincipalContext, { principal: value.trustedPrincipal })),
        ),
        Effect.provideService(SessionSupervisor.Service, supervisor),
      )
    return handlers
      .handle("automationList", ({ query }) => provideScope(query.sessionID, (value) => AutomationControl.list(value).pipe(Effect.mapError(failure))))
      .handle("automationInspect", ({ query }) => provideScope(query.sessionID, (value) => AutomationControl.inspect(value, query.automationID).pipe(Effect.mapError(failure))))
      .handle("automationHistory", ({ query }) => provideScope(query.sessionID, (value) => AutomationControl.history(value, query.automationID, query.limit ?? 128).pipe(Effect.mapError(failure))))
      .handle("automationCreate", ({ payload }) => provideScope(payload.sessionID, (value) => AutomationControl.create(value, payload.automationID, payload.idempotencyKey, payload.definition).pipe(Effect.mapError(failure))))
      .handle("automationUpdate", ({ payload }) => provideScope(payload.sessionID, (value) => AutomationControl.update(value, payload.automationID, payload.expectedVersion, payload.idempotencyKey, payload.definition).pipe(Effect.mapError(failure))))
      .handle("automationEnable", ({ payload }) => provideScope(payload.sessionID, (value) => AutomationControl.setEnabled(value, payload.automationID, payload.expectedVersion, payload.idempotencyKey, true).pipe(Effect.mapError(failure))))
      .handle("automationDisable", ({ payload }) => provideScope(payload.sessionID, (value) => AutomationControl.setEnabled(value, payload.automationID, payload.expectedVersion, payload.idempotencyKey, false).pipe(Effect.mapError(failure))))
      .handle("automationRunNow", ({ payload }) => provideScope(payload.sessionID, (value) => AutomationControl.runNow(value, payload.automationID, payload.expectedVersion, payload.idempotencyKey).pipe(Effect.mapError(failure))))
  }),
)
