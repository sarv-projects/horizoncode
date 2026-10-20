export * as Snapshot from "./snapshot"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { File } from "./file"
import { AbsolutePath, RelativePath } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("Snapshot.ID"))
export type ID = typeof ID.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "files", "diff", "preview", "restore"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export interface RestorePlanFile {
  readonly path: RelativePath
  readonly content?: Uint8Array
  readonly executable?: boolean
}

export interface RestorePlan {
  readonly worktree: AbsolutePath
  readonly files: readonly RestorePlanFile[]
}

/** Persisted legacy session diff shape; retained for database decoding compatibility. */
export type LegacyFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export interface PreviewInput extends RestoreInput {
  readonly context?: number
}

export interface Interface {
  /** Returns undefined until snapshots are captured through the Guarded Rust checkpoint service. */
  readonly capture: () => Effect.Effect<ID | undefined>
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>
  readonly preview: (input: PreviewInput) => Effect.Effect<readonly File.Diff[], Error>
  readonly restorePlan: (input: RestoreInput) => Effect.Effect<RestorePlan, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Snapshot") {}

const unavailable = (operation: Error["operation"]) =>
  new Error({
    operation,
    message: "Snapshots are unavailable until the Rust checkpoint Guard/ExecutionHost adapter is wired",
  })

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    capture: () => Effect.succeed(undefined),
    files: () => Effect.fail(unavailable("files")),
    diff: () => Effect.fail(unavailable("diff")),
    preview: () => Effect.fail(unavailable("preview")),
    restorePlan: () => Effect.fail(unavailable("restore")),
  }),
)

export const locationLayer = noopLayer

export const node = makeLocationNode({
  service: Service,
  layer: noopLayer,
  deps: [],
})
