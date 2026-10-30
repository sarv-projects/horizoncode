import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"
import { SessionSupervisorError } from "@horizoncode/core/session/supervisor"
import { Effect } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, E, R>(self: Effect.Effect<A, E | Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) => {
      const busy = error as Session.BusyError
      return Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: busy.sessionID,
          message: `Session is busy: ${busy.sessionID}`,
        }),
      )
    }),
  )
}

export function mapLegacyPromptError(error: unknown, sessionID: string) {
  if (error instanceof Session.BusyError) {
    return new ApiError.SessionBusyError({ sessionID, message: `Session is busy: ${sessionID}` })
  }
  if (error instanceof SessionSupervisorError) {
    switch (error.stage) {
      case "authorization":
        return new ApiError.ForbiddenError({ message: error.message })
      case "ownership":
        return new ApiError.SessionBusyError({ sessionID, message: `Session is busy: ${sessionID}` })
      default:
        return new ApiError.ServiceUnavailableError({ message: error.message, service: "host-kernel" })
    }
  }
  return new HttpApiError.BadRequest({})
}
