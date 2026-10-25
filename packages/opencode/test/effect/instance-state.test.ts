import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRuntime } from "@/project/instance-runtime"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

class TestState extends Context.Service<TestState, { readonly state: InstanceState.InstanceState<string> }>()(
  "@test/InstanceState",
) {}

// This matches app-node topology: the service layer is built before an
// it.instance body loads and provides its directory-specific InstanceRef.
const stateLayer = Layer.effect(
  TestState,
  Effect.gen(function* () {
    const directory = yield* InstanceState.make((ctx) => Effect.succeed(ctx.directory))
    const state = yield* InstanceState.make(() => InstanceState.get(directory))
    return { state }
  }),
)

const it = testEffect(stateLayer)

test("InstanceRuntime can dispose through a cold AppRuntime without InstanceRef", async () => {
  await InstanceRuntime.disposeAllInstances()
})

it.instance("resolves scoped instance state from an app-node caller", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const { state } = yield* TestState

    expect(yield* InstanceState.get(state)).toBe(instance.directory)
  }),
)

class ConstructionService extends Context.Service<ConstructionService, { readonly label: string }>()(
  "@test/InstanceStateConstructionService",
) {}

/**
 * The cache built below carries its initializer requirement in its own service
 * type instead of widening `TestState`: `InstanceState.get` propagates the
 * cache's `R` to the lookup caller, so a widened shared service would push
 * `ConstructionService` onto the unrelated caller in the first test.
 */
class ConstructionState extends Context.Service<
  ConstructionState,
  { readonly state: InstanceState.InstanceState<string> }
>()("@test/InstanceStateConstructionState") {}

/**
 * The shared cache is built inside a service layer that owns its initializer
 * dependencies; the caller that triggers the lookup receives only InstanceRef.
 * Every other initializer requirement must therefore come from the layer that
 * constructed the cache, not from the lookup caller's context.
 *
 * The `as InstanceState.InstanceState<string>` cast is the same erasure the
 * production services use: `requireServicesAt: "lookup"` types `get` as
 * requiring the initializer's services from the *lookup caller*, while the
 * cache at runtime merges the construction context first — which is exactly
 * the half of the contract this test pins.
 */
const hiddenServiceLayer = Layer.effect(
  ConstructionState,
  Effect.gen(function* () {
    const state = (yield* InstanceState.make((ctx) =>
      Effect.map(ConstructionService, (service) => `${service.label}|${ctx.directory}`),
    )) as InstanceState.InstanceState<string>
    return { state }
  }),
).pipe(Layer.provide(Layer.succeed(ConstructionService, { label: "constructed" })))

const itHidden = testEffect(hiddenServiceLayer)

itHidden.instance("serves construction-time initializer services at lookup time", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const { state } = yield* ConstructionState
    const callerContext = yield* Effect.context()

    expect(Context.getOption(callerContext, ConstructionService)._tag).toBe("None")
    expect(yield* InstanceState.get(state)).toBe(`constructed|${instance.directory}`)
  }),
)
