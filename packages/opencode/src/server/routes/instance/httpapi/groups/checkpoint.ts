import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/experimental/checkpoint"
const ID = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256), Schema.isPattern(/^[A-Za-z0-9._-]{1,256}$/))

export class ApiCheckpointError extends Schema.ErrorClass<ApiCheckpointError>("CheckpointError")(
  { name: Schema.Literal("CheckpointError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 400 },
) {}
export class ApiCheckpointForbiddenError extends Schema.ErrorClass<ApiCheckpointForbiddenError>("CheckpointForbiddenError")(
  { name: Schema.Literal("CheckpointForbiddenError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 403 },
) {}
export class ApiCheckpointNotFoundError extends Schema.ErrorClass<ApiCheckpointNotFoundError>("CheckpointNotFoundError")(
  { name: Schema.Literal("CheckpointNotFoundError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 404 },
) {}
export class ApiCheckpointUnavailableError extends Schema.ErrorClass<ApiCheckpointUnavailableError>("CheckpointUnavailableError")(
  { name: Schema.Literal("CheckpointUnavailableError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 503 },
) {}

const CheckpointErrors = [ApiCheckpointError, ApiCheckpointForbiddenError, ApiCheckpointNotFoundError, ApiCheckpointUnavailableError] as const
const CheckpointListResult = Schema.Struct({ checkpointIDs: Schema.Array(ID).check(Schema.isMaxLength(32)) })
const CheckpointPreviewRequest = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: ID,
  checkpointID: ID,
  mode: Schema.Literals(["FULL", "SELECTED_PATHS"]),
  selectedPaths: Schema.Array(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096))).check(Schema.isMaxLength(2_048)),
})
const CheckpointPreviewAction = Schema.Struct({
  path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  expectedBeforeDigest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/))),
  target: Schema.Struct({
    // Match Core's fail-closed planner projection: V1 can preview only a
    // digest-bound regular single-link file target. ABSENT is not a restore
    // action in this contract.
    kind: Schema.Literal("REGULAR_FILE"),
    digest: Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/)),
    byteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    executable: Schema.Boolean,
    linkCount: Schema.Literal(1),
  }),
})
const CheckpointPreviewConflict = Schema.Struct({
  path: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_096))),
  kind: Schema.Literals(["WORKSPACE_REVISION_CHANGED", "DIRTY_PATH", "UNTRACKED_PATH", "WORKSPACE_STATUS_UNAVAILABLE", "UNSAFE_PATH"]),
})
const CheckpointPreviewResult = Schema.Struct({
  checkpointID: ID,
  checkpointArtifact: Schema.Struct({ artifactID: ID, digest: Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/)), byteLength: Schema.String, mediaType: Schema.String, classification: Schema.Literals(["public", "workspace", "sensitive"]) }),
  workspaceRevision: Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/)),
  workspaceRevisionChanged: Schema.Boolean,
  mode: Schema.Literals(["FULL", "SELECTED_PATHS"]),
  selectedPaths: Schema.Array(Schema.String).check(Schema.isMaxLength(2_048)),
  actions: Schema.Array(CheckpointPreviewAction).check(Schema.isMaxLength(2_048)),
  conflicts: Schema.Array(CheckpointPreviewConflict).check(Schema.isMaxLength(2_048)),
  previewDigest: Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/)),
})

export const CheckpointApi = HttpApi.make("checkpoint")
  .add(
    HttpApiGroup.make("checkpoint")
      .add(
        HttpApiEndpoint.get("checkpointList", `${root}/list`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: ID }),
          success: described(CheckpointListResult, "Bounded Rust-owned checkpoint IDs for the authenticated Session"),
          error: CheckpointErrors,
        }),
        HttpApiEndpoint.post("checkpointRestorePreview", `${root}/restore-preview`, {
          payload: CheckpointPreviewRequest,
          success: described(CheckpointPreviewResult, "Read-only digest-bound checkpoint preview; conflicts prevent restore"),
          error: CheckpointErrors,
        }),
      )
      .annotateMerge(OpenApi.annotations({
        title: "checkpoint",
        description: "Authenticated read-only checkpoint listing and restore preview. Preview conflicts block restore; capture and restore remain unavailable until Guarded HostKernel effects pass acceptance.",
      }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
