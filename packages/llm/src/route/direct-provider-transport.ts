import { Context, Effect, Layer } from "effect"

/** Catalog-derived route and Core journal seam for one direct provider request. */
export type DirectProviderRouteV1 = {
  readonly providerID: string
  readonly modelID: string
  readonly harnessID: string
  readonly routeID: string
  readonly routeRevision: string
  readonly endpointRevision: string
  readonly endpointBase: string
}

export type DirectProviderPinV1 = {
  readonly endpointRevision: string
  readonly transportRequestDigest: string
}

export type DirectProviderJournalV1 = {
  readonly sessionID: string
  readonly requestID: string
  readonly pinDigest: string
  readonly state: "PINNED"
  readonly providerID: string
  readonly modelID: string
  readonly harnessID: string
  readonly routeRevision: string
  readonly endpointRevision: string
  readonly transportRequestDigest: string
  readonly beginDispatch: () => Effect.Effect<{
    readonly state: "DISPATCHING"
    readonly pinDigest: string
    readonly transportRequestDigest: string
  }, unknown>
  readonly markUnknown: (reason: string) => Effect.Effect<void, unknown>
}

/** In-process boundary. Implementations must keep auth material and transport private. */
export interface Interface {
  readonly dispatch: (input: {
    readonly route: DirectProviderRouteV1
    readonly request: Request
    readonly pin: (input: DirectProviderPinV1) => Effect.Effect<DirectProviderJournalV1, unknown>
  }) => Effect.Effect<Response, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM/DirectProviderTransport") {}

export const unavailable: Interface = {
  dispatch: () => Effect.fail(new Error("Direct provider transport is unavailable")),
}

export const unavailableLayer = Layer.succeed(Service, Service.of(unavailable))
