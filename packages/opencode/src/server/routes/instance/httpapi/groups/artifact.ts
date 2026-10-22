import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/experimental/artifacts"
const ID = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256), Schema.isPattern(/^[A-Za-z0-9._-]{1,256}$/))
const Decimal = Schema.String.check(Schema.makeFilter((value) => {
  const max = "18446744073709551615"
  return /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    (value.length < max.length || (value.length === max.length && value <= max))
    ? undefined
    : "must be a canonical unsigned 64-bit decimal string"
}))
const ArtifactRef = Schema.Struct({
  artifactID: ID,
  digest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  byteLength: Decimal,
  mediaType: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  classification: Schema.Literals(["PUBLIC", "WORKSPACE", "SENSITIVE"]),
})
const ReadRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionID: ID,
  artifactRef: ArtifactRef,
})
const RangeRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionID: ID,
  artifactRef: ArtifactRef,
  offset: Decimal,
  maxBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(768 * 1024)),
})
const ArtifactRefResult = Schema.Struct({
  artifactID: ID,
  digest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  byteLength: Decimal,
  mediaType: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  classification: Schema.Literals(["PUBLIC", "WORKSPACE", "SENSITIVE"]),
})
const Metadata = Schema.Struct({
  artifactRef: ArtifactRefResult,
  retentionClass: ID,
  createdAt: Schema.String.check(Schema.isMaxLength(64)),
  fidelity: Schema.Literals(["FULL", "SAMPLE", "FAILED"]),
  droppedByteCount: Decimal,
  encryption: Schema.Literals(["NONE", "STATE_KEY"]),
  redaction: Schema.Literals(["NOT_NEEDED", "APPLIED", "UNKNOWN"]),
})
const Range = Schema.Struct({
  artifactRef: ArtifactRefResult,
  offset: Decimal,
  nextOffset: Decimal,
  complete: Schema.Boolean,
  bytesBase64: Schema.String,
})

export class ApiArtifactError extends Schema.ErrorClass<ApiArtifactError>("ArtifactError")(
  { name: Schema.Literal("ArtifactError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 400 },
) {}
export class ApiArtifactForbiddenError extends Schema.ErrorClass<ApiArtifactForbiddenError>("ArtifactForbiddenError")(
  { name: Schema.Literal("ArtifactForbiddenError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 403 },
) {}
export class ApiArtifactNotFoundError extends Schema.ErrorClass<ApiArtifactNotFoundError>("ArtifactNotFoundError")(
  { name: Schema.Literal("ArtifactNotFoundError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 404 },
) {}
export class ApiArtifactUnavailableError extends Schema.ErrorClass<ApiArtifactUnavailableError>("ArtifactUnavailableError")(
  { name: Schema.Literal("ArtifactUnavailableError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 503 },
) {}

const errors = [ApiArtifactError, ApiArtifactForbiddenError, ApiArtifactNotFoundError, ApiArtifactUnavailableError] as const
const common = { query: Schema.Struct(WorkspaceRoutingQueryFields) }

export const ArtifactApi = HttpApi.make("artifact")
  .add(
    HttpApiGroup.make("artifact")
      .add(
        HttpApiEndpoint.post("artifactInspect", `${root}/inspect`, {
          ...common,
          payload: ReadRequest,
          success: described(Metadata, "Metadata for an exact verified managed artifact"),
          error: errors,
        }),
        HttpApiEndpoint.post("artifactReadRange", `${root}/read-range`, {
          ...common,
          payload: RangeRequest,
          success: described(Range, "Bounded bytes for an exact verified managed artifact"),
          error: errors,
        }),
      )
      .annotateMerge(OpenApi.annotations({
        title: "artifact",
        description: "Bounded reads of artifact refs proven by Rust-owned verified managed evidence. The request never accepts principal or Attempt authority.",
      }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
