import { Effect } from "effect"

/** Reject unsupported overlays before the supplied generation/read dispatch can run. */
export const withRepoIntelOverlayGate = <A, E, R>(input: {
  readonly overlayRef: unknown
  readonly unavailable: () => E
  readonly dispatch: () => Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  input.overlayRef === undefined ? input.dispatch() : Effect.fail(input.unavailable())
