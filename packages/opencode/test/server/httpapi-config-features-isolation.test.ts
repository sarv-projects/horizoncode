import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Config } from "../../src/config/config"
import { configHandlers } from "../../src/server/routes/instance/httpapi/handlers/config"
import { ConfigApi } from "../../src/server/routes/instance/httpapi/groups/config"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"

test("config feature reads do not require or resolve Provider.Service", async () => {
  const features = [{ featureId: "compaction.auto" }]
  let reads = 0
  const config = {
    getFeatures: () =>
      Effect.sync(() => {
        reads++
        return features as never
      }),
  }
  const passthrough = ((effect: unknown) => effect) as never
  const dependencies = Layer.mergeAll(
    Layer.succeed(Config.Service, config as never),
    Layer.succeed(Authorization, Authorization.of(passthrough)),
    Layer.succeed(InstanceContextMiddleware, InstanceContextMiddleware.of(passthrough)),
    Layer.succeed(WorkspaceRoutingMiddleware, WorkspaceRoutingMiddleware.of(passthrough)),
    schemaErrorLayer,
  )
  const isolatedHandlers = configHandlers.pipe(Layer.provide(dependencies)) as unknown as Layer.Layer<never, never, never>
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handlersContext = yield* Layer.build(isolatedHandlers)
        const built = Context.getUnsafe(handlersContext, ConfigApi.groups.config as never) as {
          handlers: Map<string, { handler: (input: unknown) => Effect.Effect<unknown> }>
        }
        const handler = built.handlers.get("features")
        expect(handler).toBeDefined()
        return yield* handler!.handler({})
      }),
    ),
  )
  expect(result).toBe(features)
  expect(reads).toBe(1)
})
