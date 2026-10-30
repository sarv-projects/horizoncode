import { EOL } from "os"
import { Effect } from "effect"
import { Catalog } from "@horizoncode/core/catalog"
import { LocationServiceMap, locationServiceMapLayer } from "@horizoncode/core/location-services"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { effectCmd, fail } from "../../effect-cmd"

export const V2Command = effectCmd({
  command: "v2",
  describe: "debug v2 catalog and built-in plugins",
  instance: false,
  handler: () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providers = (yield* catalog.provider.available()).sort((a, b) => a.id.localeCompare(b.id))
      const all = (yield* catalog.provider.all()).sort((a, b) => a.id.localeCompare(b.id))
      const result = {
        providers,
        default: catalog.model.default().pipe(Effect.map((item) => item?.id)),
        small: Object.fromEntries(
          yield* Effect.all(
            all.map((provider) =>
              Effect.map(catalog.model.small(provider.id), (model) => [provider.id, model?.id] as const),
            ),
            { concurrency: "unbounded" },
          ),
        ),
      }
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
    }).pipe(
      Effect.withSpan("Cli.debug.v2"),
      Effect.provide(
        LocationServiceMap.Service.get(
          Location.Ref.make({
            directory: AbsolutePath.make(process.cwd()),
          }),
        ),
      ),
      Effect.provide(locationServiceMapLayer),
      Effect.catchTag("SessionSupervisorError", (error) => fail(error.message)),
    ),
})
