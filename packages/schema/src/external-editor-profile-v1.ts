/** Core Config contract for explicit, user-owned external editor profiles. */

import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Schema } from "effect"
import { encodeCanonicalMessagePackV1 } from "./canonical-msgpack-v1"

const Identifier = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/))
const Digest = Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/))
const U64 = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/)).check(Schema.makeFilter((value) => {
  try { return BigInt(value) <= 18_446_744_073_709_551_615n ? undefined : "revision exceeds u64" }
  catch { return "revision is invalid" }
}))
const Text = Schema.String.check(Schema.isMaxLength(4096)).check(Schema.makeFilter((value) =>
  [...value].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)
    ? "editor profile text must not contain control characters"
    : undefined,
))
const unique = <A>(items: readonly A[]) => new Set(items).size === items.length

export const ExternalEditorProfileDefinitionV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  profileId: Identifier,
  revision: U64,
  executableSelector: Text.check(Schema.isNonEmpty()),
  argv: Schema.Array(Text).check(Schema.isMaxLength(127)),
  targetArgIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 127 })),
  launchMode: Schema.Literals(["foreground_tty", "wait"]),
  targetKinds: Schema.Array(Schema.Literals(["prompt_scratch", "workspace_file"]))
    .check(Schema.isMinLength(1)).check(Schema.isMaxLength(2))
    .check(Schema.makeFilter((items) => unique(items) ? undefined : "target kinds must be unique")),
  environmentPolicy: Schema.Literal("sanitized_host"),
}).check(Schema.makeFilter((profile) => {
  if (profile.targetArgIndex > profile.argv.length) return "targetArgIndex must be at most argv.length"
  const bytes = profile.argv.reduce((sum, arg) => sum + new TextEncoder().encode(arg).length, 0)
  if (bytes > 512 * 1024) return "editor profile argv exceeds 512 KiB"
  return undefined
})).annotate({ identifier: "Horizon.ExternalEditorProfileDefinitionV1" })
export type ExternalEditorProfileDefinitionV1 = typeof ExternalEditorProfileDefinitionV1.Type

export const ExternalEditorProfileRefV1 = Schema.Struct({
  profileId: Identifier,
  revision: U64,
  profileDigest: Digest,
}).annotate({ identifier: "Horizon.ExternalEditorProfileRefV1" })
export type ExternalEditorProfileRefV1 = typeof ExternalEditorProfileRefV1.Type

export const ExternalEditorLaunchRequestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Identifier,
  locationId: Identifier,
  profileRef: ExternalEditorProfileRefV1,
  targetKind: Schema.Literals(["prompt_scratch", "workspace_file"]),
  targetRelativePath: Schema.String.check(Schema.isMaxLength(4096)).check(Schema.makeFilter((value) =>
    [...value].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)
      ? "editor target path must not contain control characters"
      : undefined,
  )),
  expectedWorkspaceRevision: Digest,
  expectedFileDigest: Schema.NullOr(Digest),
}).check(Schema.makeFilter((request) => {
  if (request.targetKind === "prompt_scratch") {
    return request.targetRelativePath === "" && request.expectedFileDigest === null
      ? undefined
      : "prompt scratch targets are host-generated and carry no workspace file digest"
  }
  if (!request.targetRelativePath || request.expectedFileDigest === null) {
    return "workspace editor targets require a relative path and exact file digest"
  }
  if (request.targetRelativePath.startsWith("/") || request.targetRelativePath.includes("\\") ||
      request.targetRelativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return "workspace editor target must be a normalized relative path"
  }
  return undefined
})).annotate({ identifier: "Horizon.ExternalEditorLaunchRequestV1" })
export type ExternalEditorLaunchRequestV1 = typeof ExternalEditorLaunchRequestV1.Type

/** Build the private launch payload from the user-selected explorer row and
 * its authenticated preview. This DTO carries no caller-supplied authority;
 * HostKernel must derive principal, owner epoch, workspace root, permission
 * mode, user action, EffectIntent and lease from its authenticated session. */
export function externalEditorLaunchRequestV1(input: {
  readonly sessionId: string
  readonly locationId: string
  readonly profileRef: ExternalEditorProfileRefV1
  readonly pathRef: string
  readonly sourceRevision: string
  readonly contentDigest: string
}): ExternalEditorLaunchRequestV1 {
  return Schema.decodeUnknownSync(ExternalEditorLaunchRequestV1)({
    schemaVersion: 1,
    sessionId: input.sessionId,
    locationId: input.locationId,
    profileRef: input.profileRef,
    targetKind: "workspace_file",
    targetRelativePath: input.pathRef,
    expectedWorkspaceRevision: input.sourceRevision,
    expectedFileDigest: input.contentDigest,
  }, { onExcessProperty: "error" })
}

/** Prompt scratch is always host-generated; the client sends no path or
 * preimage digest and never chooses a file under the workspace. */
export function externalEditorPromptScratchRequestV1(input: {
  readonly sessionId: string
  readonly locationId: string
  readonly profileRef: ExternalEditorProfileRefV1
  readonly workspaceRevision: string
}): ExternalEditorLaunchRequestV1 {
  return Schema.decodeUnknownSync(ExternalEditorLaunchRequestV1)({
    schemaVersion: 1,
    sessionId: input.sessionId,
    locationId: input.locationId,
    profileRef: input.profileRef,
    targetKind: "prompt_scratch",
    targetRelativePath: "",
    expectedWorkspaceRevision: input.workspaceRevision,
    expectedFileDigest: null,
  }, { onExcessProperty: "error" })
}

/** Exact redacted projection of P1 ExternalEditorExecutionOutcomeV1. */
export const ExternalEditorLaunchStatusV1 = Schema.Literals([
  "prepared", "running", "unknown", "cancelled", "completed", "conflict",
])
export const ExternalEditorHostProcessRefV1 = Schema.Struct({
  executionID: Identifier,
  generation: U64,
  ownerEpoch: U64,
  kind: Schema.Literal("external_editor"),
  profileID: Identifier,
  profileRevision: U64,
  profileDigest: Digest,
  executableDigest: Digest,
}).annotate({ identifier: "Horizon.ExternalEditorHostProcessRefV1" })
export const ExternalEditorLaunchResultV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: ExternalEditorLaunchStatusV1,
  effectID: Identifier,
  executionID: Identifier,
  bindingDigest: Digest,
  processRef: ExternalEditorHostProcessRefV1,
  receiptDigest: Schema.NullOr(Digest),
  exitCode: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: -2_147_483_648, maximum: 2_147_483_647 }))),
  resultFileDigest: Schema.NullOr(Digest),
  observedWorkspaceRevision: Schema.NullOr(Digest),
}).check(Schema.makeFilter((result) => {
  const terminal = result.status === "cancelled" || result.status === "completed" || result.status === "conflict"
  if (terminal !== (result.receiptDigest !== null)) return "terminal editor outcomes require exactly one durable receipt digest"
  if (result.status === "completed" && (result.exitCode !== 0 || result.resultFileDigest === null || result.observedWorkspaceRevision === null)) {
    return "completed editor outcome requires successful exit and exact result/workspace digests"
  }
  if ((result.status === "prepared" || result.status === "running" || result.status === "unknown") &&
      (result.exitCode !== null || result.resultFileDigest !== null || result.observedWorkspaceRevision !== null)) {
    return "non-terminal editor outcome cannot expose result evidence"
  }
  return undefined
})).annotate({ identifier: "Horizon.ExternalEditorLaunchResultV1" })
export type ExternalEditorLaunchResultV1 = typeof ExternalEditorLaunchResultV1.Type

/** Strict adapter for the P1 EffectHost outcome. The caller must preserve
 * `unknown` as an uncertain effect and may never retry by launching again. */
export function externalEditorLaunchResultV1(
  value: unknown,
  expectedProfile?: ExternalEditorProfileRefV1,
): ExternalEditorLaunchResultV1 {
  const result = Schema.decodeUnknownSync(ExternalEditorLaunchResultV1)(value, { onExcessProperty: "error" })
  if (result.executionID !== result.processRef.executionID) throw new TypeError("editor outcome process identity differs from execution ID")
  if (expectedProfile && (result.processRef.profileID !== expectedProfile.profileId ||
      result.processRef.profileRevision !== expectedProfile.revision || result.processRef.profileDigest !== expectedProfile.profileDigest)) {
    throw new TypeError("editor outcome process profile differs from the immutable selection")
  }
  return result
}

export function externalEditorProfileDigestV1(profile: ExternalEditorProfileDefinitionV1): string {
  const encoded = encodeCanonicalMessagePackV1(profile, { maxEncodedBytes: 256 * 1024, maxDepth: 16, maxNodes: 4096 })
  const domain = new TextEncoder().encode("horizoncode.external-editor-profile.v1\0")
  const preimage = new Uint8Array(domain.length + encoded.length)
  preimage.set(domain)
  preimage.set(encoded, domain.length)
  return `blake3:${bytesToHex(blake3(preimage))}`
}

export function externalEditorProfileRefV1(profile: ExternalEditorProfileDefinitionV1): ExternalEditorProfileRefV1 {
  return {
    profileId: profile.profileId,
    revision: profile.revision,
    profileDigest: externalEditorProfileDigestV1(profile),
  }
}

export const ExternalEditorProfilesProjectionV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: Schema.Literal("global_user_config"),
  profiles: Schema.Array(Schema.Struct({
    definition: ExternalEditorProfileDefinitionV1,
    profileRef: ExternalEditorProfileRefV1,
  })).check(Schema.isMaxLength(128)),
  selected: Schema.NullOr(ExternalEditorProfileRefV1),
}).annotate({ identifier: "Horizon.ExternalEditorProfilesProjectionV1" })
export type ExternalEditorProfilesProjectionV1 = typeof ExternalEditorProfilesProjectionV1.Type

export const UpdateExternalEditorProfilesV1 = Schema.Struct({
  expectedSelection: Schema.NullOr(ExternalEditorProfileRefV1),
  addProfile: Schema.optional(ExternalEditorProfileDefinitionV1),
  select: Schema.NullOr(ExternalEditorProfileRefV1),
}).annotate({ identifier: "Horizon.UpdateExternalEditorProfilesV1" })
export type UpdateExternalEditorProfilesV1 = typeof UpdateExternalEditorProfilesV1.Type
