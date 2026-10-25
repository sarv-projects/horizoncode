import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import type { ArtifactRefWireV1 } from "@opencode-ai/core/session/supervisor"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import * as ArtifactControl from "@/session/artifact-control"
import { InstanceHttpApi } from "../api"
import {
  ApiArtifactError,
  ApiArtifactForbiddenError,
  ApiArtifactNotFoundError,
  ApiArtifactUnavailableError,
} from "../groups/artifact"

function wireRef(ref: {
  artifactID: string
  digest: string
  byteLength: string
  mediaType: string
  classification: "PUBLIC" | "WORKSPACE" | "SENSITIVE"
}) {
  return {
    artifactId: ref.artifactID,
    digest: ref.digest,
    byteLength: ref.byteLength,
    mediaType: ref.mediaType,
    classification: ref.classification.toLowerCase() as "public" | "workspace" | "sensitive",
  }
}

function apiRef(ref: ArtifactRefWireV1) {
  return {
    artifactID: ref.artifactId,
    digest: ref.digest,
    byteLength: ref.byteLength,
    mediaType: ref.mediaType,
    classification: ref.classification.toUpperCase() as "PUBLIC" | "WORKSPACE" | "SENSITIVE",
  }
}

function mapError(error: ArtifactControl.ArtifactControlError) {
  const data = { code: error.code, reason: error.reason }
  if (["authorization", "artifact_owner_conflict", "missing_principal"].includes(error.code)) {
    return new ApiArtifactForbiddenError({ name: "ArtifactForbiddenError", data })
  }
  if (["artifact_not_found", "managed_not_found"].includes(error.code)) {
    return new ApiArtifactNotFoundError({ name: "ArtifactNotFoundError", data })
  }
  if (["artifact_unavailable", "artifact_owner_unavailable", "capability_unavailable", "host-kernel-feature"].includes(error.code)) {
    return new ApiArtifactUnavailableError({ name: "ArtifactUnavailableError", data })
  }
  return new ApiArtifactError({ name: "ArtifactError", data })
}

export const artifactHandlers = HttpApiBuilder.group(InstanceHttpApi, "artifact", (handlers) =>
  Effect.gen(function* () {
    function scope(sessionID: string, artifactRef: Parameters<typeof wireRef>[0]) {
      return Effect.gen(function* () {
        const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
        if (!Option.isSome(authenticated) || authenticated.value.principal.kind !== "server_auth") {
          return yield* new ApiArtifactForbiddenError({
            name: "ArtifactForbiddenError",
            data: { code: "authorization", reason: "artifact reads require authenticated ServerAuth" },
          })
        }
        const instance = yield* InstanceState.context
        const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
        // Root direct-session artifacts are admitted only by an exact current
        // HostKernel receipt-index edge. If that bounded index has no matching
        // ref, retain the established verified-managed lookup; transport or
        // authorization failures from the root lookup remain fail-closed.
        const directSession = yield* ArtifactControl.directSessionReadScope({ sessionID, locationRef, artifactRef: wireRef(artifactRef) })
          .pipe(Effect.mapError(mapError))
        if (directSession) return directSession
        return yield* ArtifactControl.resolveVerifiedScope({ sessionID, locationRef, artifactRef: wireRef(artifactRef) })
          .pipe(Effect.mapError(mapError))
      })
    }

    const inspect = Effect.fn("ArtifactHttpApi.inspect")(function* (payload: {
      sessionID: string
      artifactRef: Parameters<typeof wireRef>[0]
    }) {
      const resolved = yield* scope(payload.sessionID, payload.artifactRef)
      return yield* ArtifactControl.inspect(resolved, wireRef(payload.artifactRef)).pipe(Effect.map((value) => ({
        ...value,
        artifactRef: apiRef(value.artifactRef),
      })), Effect.mapError(mapError))
    })

    const readRange = Effect.fn("ArtifactHttpApi.readRange")(function* (payload: {
      sessionID: string
      artifactRef: Parameters<typeof wireRef>[0]
      offset: string
      maxBytes: number
    }) {
      const resolved = yield* scope(payload.sessionID, payload.artifactRef)
      const value = yield* ArtifactControl.readRange(resolved, wireRef(payload.artifactRef), payload.offset, payload.maxBytes)
        .pipe(Effect.mapError(mapError))
      return {
        artifactRef: apiRef(value.artifactRef),
        offset: value.offset,
        nextOffset: value.nextOffset,
        complete: value.complete,
        bytesBase64: Buffer.from(value.bytes).toString("base64"),
      }
    })

    return handlers
      .handle("artifactInspect", ({ payload }) => inspect(payload))
      .handle("artifactReadRange", ({ payload }) => readRange(payload))
  }),
)
