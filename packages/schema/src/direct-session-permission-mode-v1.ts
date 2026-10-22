/** Strict user-facing projection for the HostKernel-owned direct Session posture. */
import { Schema } from "effect"

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
)
const Digest = Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/))
const Revision = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/)).check(
  Schema.makeFilter((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn || "revision exceeds u64"),
)

export const ModeV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Identifier,
  ownerEpoch: Revision,
  locationId: Identifier,
  workspaceId: Identifier,
  workspaceRootDigest: Digest,
  executionBackendId: Identifier,
  policyDigest: Digest,
  sandboxMode: Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
  approvalPolicy: Schema.Literals(["on-request", "always", "never"]),
  source: Schema.Literals(["default", "user-session", "user-config"]),
  revision: Revision,
  digest: Digest,
}).annotate({ identifier: "Horizon.DirectSessionPermissionModeV1" })
export type ModeV1 = typeof ModeV1.Type

export const UpdateV1 = Schema.Struct({
  sandboxMode: ModeV1.fields.sandboxMode,
  approvalPolicy: ModeV1.fields.approvalPolicy,
  expectedRevision: Revision,
}).annotate({ identifier: "Horizon.DirectSessionPermissionModeUpdateV1" })
export type UpdateV1 = typeof UpdateV1.Type
