import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SessionSupervisor } from "@horizoncode/core/session/supervisor"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import * as CheckpointControl from "@/session/checkpoint-control"
import * as CheckpointStore from "@/session/checkpoint-store"
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
    const checkpointStore = yield* CheckpointStore.Service

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

    const capture = Effect.fn("CheckpointHttpApi.capture")(function* (input: { sessionID: string }) {
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (!Option.isSome(authenticated) || authenticated.value.principal.kind !== "server_auth") {
        return yield* Effect.fail(new ApiCheckpointForbiddenError({
          name: "CheckpointForbiddenError",
          data: { code: "authorization", reason: "checkpoint capture requires an authenticated ServerAuth principal" },
        }))
      }
      return yield* checkpointStore.capture({ sessionID: input.sessionID }).pipe(Effect.mapError((error) => {
        const data = { code: "checkpoint_capture_failed", reason: error.message }
        return new ApiCheckpointError({ name: "CheckpointError", data })
      }))
    })

    const restore = Effect.fn("CheckpointHttpApi.restore")(function* (input: { sessionID: string; checkpointID: string }) {
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (!Option.isSome(authenticated) || authenticated.value.principal.kind !== "server_auth") {
        return yield* Effect.fail(new ApiCheckpointForbiddenError({
          name: "CheckpointForbiddenError",
          data: { code: "authorization", reason: "checkpoint restore requires an authenticated ServerAuth principal" },
        }))
      }
      return yield* checkpointStore.restore({ sessionID: input.sessionID, checkpointID: input.checkpointID }).pipe(
        Effect.mapError((error) => {
          const code = error._tag === "CheckpointStore.RestoreAdmissionRequired"
            ? "guard_admission_required"
            : error._tag === "CheckpointStore.NotFound"
            ? "checkpoint_not_found"
            : "checkpoint_restore_failed"
          const data = { code, reason: error.message }
          if (code === "checkpoint_not_found") {
            return new ApiCheckpointNotFoundError({ name: "CheckpointNotFoundError", data })
          }
          if (code === "guard_admission_required") {
            return new ApiCheckpointForbiddenError({ name: "CheckpointForbiddenError", data })
          }
          return new ApiCheckpointError({ name: "CheckpointError", data })
        }),
      )
    })

    const restorePreview = Effect.fn("CheckpointHttpApi.restorePreview")(function* (input: {
      sessionID: string
      checkpointID: string
      mode: "FULL" | "SELECTED_PATHS"
      selectedPaths: readonly string[]
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
      const preview = yield* CheckpointControl.previewRestore({
        locationID, sessionID: input.sessionID, trustedPrincipal: authenticated.value.principal,
      }, { ...input, selectedPaths: [...input.selectedPaths] }).pipe(Effect.mapError((error) => {
        const data = { code: error.code, reason: error.reason }
        if (error.code === "authorization" || error.code === "missing_principal") return new ApiCheckpointForbiddenError({ name: "CheckpointForbiddenError", data })
        if (error.code === "managed_not_found" || error.code === "checkpoint_not_found") return new ApiCheckpointNotFoundError({ name: "CheckpointNotFoundError", data })
        if (error.code === "managed_unavailable" || error.code === "checkpoint_unavailable" || error.code === "capability_unavailable") return new ApiCheckpointUnavailableError({ name: "CheckpointUnavailableError", data })
        return new ApiCheckpointError({ name: "CheckpointError", data })
      }))
      // Core normalizes an absent conflict path by omitting the key; the HTTP
      // contract declares the HostKernel's always-present nullable path.
      return {
        ...preview,
        conflicts: preview.conflicts.map((conflict) => ({ path: conflict.path ?? null, kind: conflict.kind })),
      }
    })

    return handlers
      .handle("checkpointList", ({ query }) => list(query.sessionID))
      .handle("checkpointCapture", ({ payload }) => capture(payload))
      .handle("checkpointRestore", ({ payload }) => restore(payload))
      .handle("checkpointRestorePreview", ({ payload }) => restorePreview(payload))
  }),
)
