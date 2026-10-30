import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { AppProcess } from "@horizoncode/core/process"
import { Info } from "@horizoncode/schema/file-diff"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Info
export type FileDiff = typeof FileDiff.Type

export type TreeFile = {
  readonly path: string
  readonly contentBase64: string
  readonly executable: boolean
}

export class TreeError extends Schema.TaggedErrorClass<TreeError>()("Snapshot.TreeError", {
  message: Schema.String,
}) {}

export class SnapshotUnavailableError extends Schema.TaggedErrorClass<SnapshotUnavailableError>()(
  "Snapshot.SnapshotUnavailableError",
  {
    operation: Schema.String,
  },
) {
  override get message() {
    return `Snapshot ${this.operation} is unavailable until it is mediated by Guard and ExecutionHost`
  }
}

export interface Interface {
  readonly init: () => Effect.Effect<void, SnapshotUnavailableError>
  readonly cleanup: () => Effect.Effect<void, SnapshotUnavailableError>
  readonly track: () => Effect.Effect<string | undefined, SnapshotUnavailableError>
  readonly patch: (hash: string) => Effect.Effect<Patch, SnapshotUnavailableError>
  readonly tree: (hash: string, files: string[]) => Effect.Effect<TreeFile[], TreeError | SnapshotUnavailableError>
  readonly diff: (hash: string) => Effect.Effect<string, SnapshotUnavailableError>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[], SnapshotUnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@horizoncode/Snapshot") {}

const unavailable = (operation: string) => Effect.fail(new SnapshotUnavailableError({ operation }))

const layer: Layer.Layer<Service, never, AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Keep the process dependency injectable so tests can assert that this service
    // does not start a process. No process method is called by this implementation.
    yield* AppProcess.Service
    return Service.of({
      init: () => unavailable("initialization"),
      cleanup: () => unavailable("cleanup"),
      track: () => unavailable("tracking"),
      patch: () => unavailable("patch retrieval"),
      tree: () => unavailable("tree retrieval"),
      diff: () => unavailable("diff retrieval"),
      diffFull: () => unavailable("full diff retrieval"),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [AppProcess.node],
})

export * as Snapshot from "."
