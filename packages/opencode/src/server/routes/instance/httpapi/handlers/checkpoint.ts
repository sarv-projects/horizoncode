import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import * as CheckpointControl from "@/session/checkpoint-control"
import { InstanceHttpApi } from "../api"
import {
  ApiCheckpointError,
  ApiCheckpointForbiddenError,
  ApiCheckpointNotFoundError,
  ApiCheckpointUnavailableError,
} from "../groups/checkpoint"

export const checkpointHandlers = HttpApiBuilder.group(InstanceHttpApi, "checkpoint", (handlers) =>
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service

    const list = Effect.fn("CheckpointHttpApi.list")(function* (sessionID: string) {
      const instance = yield* InstanceState.context
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (!Option.isSome(authenticated) || authenticated.value.principal.kind !== "server_auth") {
        return yield* Effect.fail(new ApiCheckpointForbiddenError({
          name: "CheckpointForbiddenError",
          data: { code: "authorization", reason: "checkpoint access requires an authenticated ServerAuth principal" },
        }))
      }
      const locationID = yield* supervisor.registerHostLocation(
        Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }),
      ).pipe(Effect.mapError((error) => new ApiCheckpointUnavailableError({
        name: "CheckpointUnavailableError",
        data: { code: "checkpoint_unavailable", reason: error.message },
      })))
      const scope: CheckpointControl.CheckpointScope = {
        locationID,
        sessionID,
        trustedPrincipal: authenticated.value.principal,
      }
      return yield* CheckpointControl.list(scope).pipe(Effect.mapError((error) => {
        const data = { code: error.code, reason: error.reason }
        if (error.code === "authorization" || error.code === "missing_principal") {
          return new ApiCheckpointForbiddenError({ name: "CheckpointForbiddenError", data })
        }
        if (error.code === "managed_not_found" || error.code === "checkpoint_not_found") {
          return new ApiCheckpointNotFoundError({ name: "CheckpointNotFoundError", data })
        }
        if (error.code === "managed_unavailable" || error.code === "checkpoint_unavailable" || error.code === "capability_unavailable") {
          return new ApiCheckpointUnavailableError({ name: "CheckpointUnavailableError", data })
        }
        return new ApiCheckpointError({ name: "CheckpointError", data })
      }))
    })

    const restorePreview = Effect.fn("CheckpointHttpApi.restorePreview")(function* (input: {
      sessionID: string
      checkpointID: string
      mode: "FULL" | "SELECTED_PATHS"
      selectedPaths: string[]
    }) {
      const instance = yield* InstanceState.context
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (!Option.isSome(authenticated) || authenticated.value.principal.kind !== "server_auth") {
        return yield* Effect.fail(new ApiCheckpointForbiddenError({
          name: "CheckpointForbiddenError",
          data: { code: "authorization", reason: "checkpoint preview requires an authenticated ServerAuth principal" },
        }))
      }
      const locationID = yield* supervisor.registerHostLocation(
        Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }),
      ).pipe(Effect.mapError((error) => new ApiCheckpointUnavailableError({
        name: "CheckpointUnavailableError",
        data: { code: "checkpoint_unavailable", reason: error.message },
      })))
      return yield* CheckpointControl.previewRestore({
        locationID, sessionID: input.sessionID, trustedPrincipal: authenticated.value.principal,
      }, input).pipe(Effect.mapError((error) => {
        const data = { code: error.code, reason: error.reason }
        if (error.code === "authorization" || error.code === "missing_principal") return new ApiCheckpointForbiddenError({ name: "CheckpointForbiddenError", data })
        if (error.code === "managed_not_found" || error.code === "checkpoint_not_found") return new ApiCheckpointNotFoundError({ name: "CheckpointNotFoundError", data })
        if (error.code === "managed_unavailable" || error.code === "checkpoint_unavailable" || error.code === "capability_unavailable") return new ApiCheckpointUnavailableError({ name: "CheckpointUnavailableError", data })
        return new ApiCheckpointError({ name: "CheckpointError", data })
      }))
    })

    return handlers
      .handle("checkpointList", ({ query }) => list(query.sessionID))
      .handle("checkpointRestorePreview", ({ payload }) => restorePreview(payload))
  }),
)
