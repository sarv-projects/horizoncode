import { expect } from "bun:test"
import { AppProcess } from "@horizoncode/core/process"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const processCalls = { count: 0 }
const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: () =>
      Effect.sync(() => {
        processCalls.count++
        throw new Error("Snapshot process execution must remain unavailable")
      }),
    runStream: () => {
      processCalls.count++
      throw new Error("Snapshot process execution must remain unavailable")
    },
  } as unknown as AppProcess.Interface),
)

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Snapshot.node, [[AppProcess.node, appProcess]]), testInstanceStoreLayer),
)

it.instance(
  "fails closed for every snapshot operation before starting a process",
  () =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(() => disposeAllInstances()))
    processCalls.count = 0
    const snapshot = yield* Snapshot.Service
    const results = yield* Effect.all([
      Effect.exit(snapshot.init()),
      Effect.exit(snapshot.cleanup()),
      Effect.exit(snapshot.track()),
      Effect.exit(snapshot.patch("snapshot-id")),
      Effect.exit(snapshot.tree("snapshot-id", ["file.txt"])),
      Effect.exit(snapshot.diff("snapshot-id")),
      Effect.exit(snapshot.diffFull("from", "to")),
    ])

    const isUnavailable = <A, E>(result: Exit.Exit<A, E>) => {
      if (Exit.isSuccess(result)) return false
      return (
        Option.getOrUndefined(Cause.findErrorOption(result.cause)) instanceof Snapshot.SnapshotUnavailableError
      )
    }
    expect(results.map((result) => isUnavailable(result as Exit.Exit<unknown, unknown>)).every(Boolean)).toBe(true)
    expect(processCalls.count).toBe(0)
  }),
  { git: true },
)
