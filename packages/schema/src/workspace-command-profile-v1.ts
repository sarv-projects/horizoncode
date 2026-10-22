/** User-owned, immutable workspace build/test command profile. This is configuration, not execution authority. */

import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Schema } from "effect"
import { encodeCanonicalMessagePackV1 } from "./canonical-msgpack-v1"

const ID = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)).check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/))
const Digest = Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/))
const BoundedText = Schema.String.check(Schema.isMaxLength(256))
const U64 = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/)).check(Schema.makeFilter((value) => {
  try { return BigInt(value) <= 18_446_744_073_709_551_615n ? undefined : "revision exceeds u64" }
  catch { return "revision is invalid" }
}))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveCount = Schema.Int.check(Schema.isGreaterThan(0))
const unique = <A>(items: readonly A[]) => new Set(items).size === items.length

export const WorkspaceCommandProfileDefinitionV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  profileId: ID,
  revision: U64,
  enabled: Schema.Boolean,
  actions: Schema.Array(Schema.Literals(["build", "test"])).check(Schema.isMinLength(1)).check(Schema.isMaxLength(2)).check(Schema.makeFilter((items) => unique(items) ? undefined : "actions must be unique")),
  executable: Schema.Struct({ selector: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)), resolvedDigest: Digest }),
  arguments: Schema.Struct({
    fixedPrefix: Schema.Array(BoundedText).check(Schema.isMaxLength(64)),
    allowedValuesByPosition: Schema.Array(Schema.Array(BoundedText).check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)).check(Schema.makeFilter((items) => unique(items) ? undefined : "allowed argument values must be unique"))).check(Schema.isMaxLength(64)),
    maxCount: Count.check(Schema.isLessThanOrEqualTo(128)),
    maxBytes: PositiveCount.check(Schema.isLessThanOrEqualTo(32768)),
  }),
  workingDirectory: Schema.Literal("registered_workspace_root"),
  environment: Schema.Struct({
    policy: Schema.Literal("sanitized_allowlist"),
    allowedNames: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))).check(Schema.isMaxLength(64)).check(Schema.makeFilter((items) => unique(items) ? undefined : "environment names must be unique")),
  }),
  filesystem: Schema.Literal("registered_workspace_and_isolated_temp_cache_roots"),
  network: Schema.Literals(["deny", "explicit_network_egress_grant"]),
  limits: Schema.Struct({
    maxWallTimeMs: PositiveCount.check(Schema.isLessThanOrEqualTo(3_600_000)),
    maxStdoutBytes: PositiveCount.check(Schema.isLessThanOrEqualTo(16_777_216)),
    maxStderrBytes: PositiveCount.check(Schema.isLessThanOrEqualTo(16_777_216)),
    maxProcesses: PositiveCount.check(Schema.isLessThanOrEqualTo(256)),
    requiredOsGuarantees: Schema.Array(Schema.Literals(["cpu", "memory", "process_count", "file_descriptors", "filesystem_write_confinement", "network_confinement"])).check(Schema.makeFilter((items) => unique(items) ? undefined : "OS guarantees must be unique")),
  }),
  profileDigest: Digest,
}).check(Schema.makeFilter((profile) => {
  if (profile.arguments.fixedPrefix.length + profile.arguments.allowedValuesByPosition.length > profile.arguments.maxCount) {
    return "fixed argv prefix and allowed argument positions exceed maxCount"
  }
  return undefined
})).annotate({ identifier: "Horizon.WorkspaceCommandProfileV1.Definition" })

export type WorkspaceCommandProfileDefinitionV1 = typeof WorkspaceCommandProfileDefinitionV1.Type

export function workspaceCommandProfileDigestV1(profile: Omit<WorkspaceCommandProfileDefinitionV1, "profileDigest">): string {
  const encoded = encodeCanonicalMessagePackV1(profile, { maxEncodedBytes: 256 * 1024, maxDepth: 16, maxNodes: 4096 })
  const domain = new TextEncoder().encode("horizoncode.workspace-command-profile.v1\0")
  const preimage = new Uint8Array(domain.length + encoded.length)
  preimage.set(domain)
  preimage.set(encoded, domain.length)
  return `blake3:${bytesToHex(blake3(preimage))}`
}

export function validateWorkspaceCommandProfileV1(profile: WorkspaceCommandProfileDefinitionV1): boolean {
  const { profileDigest, ...preimage } = profile
  return workspaceCommandProfileDigestV1(preimage) === profileDigest
}
