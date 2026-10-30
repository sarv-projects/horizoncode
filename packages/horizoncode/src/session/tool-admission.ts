// Per-tool ToolBatch admission projection.
//
// `admitBatch` (session/tool-batch.ts) validates and prepares every effect
// member of a provider turn before Guard sees it. The projection lives here so
// the runtime and the admission tests exercise the exact same functions: a test
// that rebuilt this closure locally could keep passing while the shipped
// projection drifted.
//
// Nothing in this module widens admission. `edit` arguments must still satisfy
// the published `edit` schema (exactly `filePath`, `oldString`, `newString` and
// an optional boolean `replaceAll`), the resolved path must still stay inside
// the workspace, and the prepared `files.patch` operation set is still the only
// thing Guard is asked to authorise.

import { Effect } from "effect"
import { Schema } from "effect"
import type { FSUtil } from "@horizoncode/core/fs-util"
import { isRecord } from "@/util/record"
import {
  Parameters as EditParametersSchema,
  prepareEditBatch,
  type EditParameters,
  type PreparedEditBatch,
} from "@/tool/edit"
import type { ToolBatchPreparation, ToolBatchPrepareContext } from "./tool-batch"

/**
 * The session runtime subset an admission projection needs: the instance
 * directory (workspace root), the filesystem service used to read the preimage,
 * and the EffectBridge promise runner that turns a service-free Effect into the
 * Promise the batch gate awaits.
 */
export type ToolAdmissionRuntime = {
  readonly directory: string
  readonly fs: FSUtil.Interface
  readonly promise: <A>(effect: Effect.Effect<A, never, never>) => Promise<A>
}

/**
 * `edit` -> `files.patch` admission projection.
 *
 * `validate` applies the same published schema the model-facing tool advertises
 * (a strict `Schema.Struct`, so an unknown key such as `replace_all` or a
 * non-boolean `replaceAll` is refused). `prepare` then reads the preimage and
 * produces the exact patch operations Guard binds to the challenge; when an
 * earlier member of the same batch already staged this path, it prepares against
 * that staged content so two edits of one file in one turn both admit.
 *
 * A `prepare` failure here is almost never a shape problem: it is the domain
 * refusing the edit ("Could not find oldString...", "Found multiple matches...",
 * "oldString cannot be empty...", "path escapes the workspace"). It must reach
 * the model as that reason, not as a generic argument error (see
 * `admissionFailureReason` in tool-batch.ts).
 */
export function editToolBatchAdmission(runtime: ToolAdmissionRuntime): {
  readonly validate: (value: unknown) => Promise<EditParameters>
  readonly prepare: (value: unknown, context?: ToolBatchPrepareContext) => Promise<ToolBatchPreparation>
} {
  return {
    validate: (value) =>
      runtime.promise(Schema.decodeUnknownEffect(EditParametersSchema)(value).pipe(Effect.orDie)),
    prepare: async (value, context) => {
      if (
        !isRecord(value) ||
        typeof value.filePath !== "string" ||
        typeof value.oldString !== "string" ||
        typeof value.newString !== "string" ||
        (value.replaceAll !== undefined && typeof value.replaceAll !== "boolean")
      ) {
        throw new Error("Invalid edit arguments")
      }
      const overlay = context?.pendingContent
        ? { read: (filePath: string) => context.pendingContent.read(filePath) }
        : undefined
      const prepared: PreparedEditBatch = await runtime.promise(
        prepareEditBatch(value as EditParameters, runtime.directory, runtime.fs, { overlay, sessionID: context?.sessionID }).pipe(
          Effect.orDie,
        ),
      )
      return {
        arguments: { operations: prepared.operations },
        execution: prepared.operations,
      }
    },
  }
}
