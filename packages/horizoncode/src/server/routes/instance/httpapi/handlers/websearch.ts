import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceRef } from "@/effect/instance-ref"
import { WebSearchRuntime } from "@/tool/websearch-runtime"
import { InstanceHttpApi } from "../api"

export const webSearchHandlers = HttpApiBuilder.group(InstanceHttpApi, "webSearch", (handlers) =>
  Effect.gen(function* () {
    const runtime = yield* WebSearchRuntime.Service

    return handlers.handle("providers", () =>
      Effect.gen(function* () {
        const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
        if (Option.isNone(authenticated)) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
        const instance = yield* InstanceRef
        if (!instance?.directory) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
        return yield* runtime.inspect({ workspace: instance.directory })
      }),
    )
  }),
)
