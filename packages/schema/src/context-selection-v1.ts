/** Request-bound, bounded references selected by Core's ContextService. */

import { Schema } from "effect"
import { SessionID } from "./session-id"

const Digest = Schema.String.check(Schema.isPattern(/^(?:sha256:[0-9a-f]{64}|blake3:[0-9a-f]{64})$/))
const DecimalU64 = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/))
const OpaqueID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,256}$/))
const SourceRevision = OpaqueID

export const ContextSelectionModeV1 = Schema.Literals(["fresh", "conversation_slice", "fork"])
export type ContextSelectionModeV1 = typeof ContextSelectionModeV1.Type

export const ContextSelectionSourceKindV1 = Schema.Literals([
  "session-message", "agent-profile", "managed-task", "accepted-spec", "provider-input", "tool", "instruction", "skill", "prompt-template", "artifact",
])
export const ContextSelectionAuthorityV1 = Schema.Literals([
  "session-store", "core-config", "managed-control", "core-prompt-compiler", "tool-registry", "instruction-resolver", "skill-resolver", "template-resolver", "artifact-store",
])
export const ContextSelectionTrustV1 = Schema.Literals(["system", "user", "workspace", "external", "mixed"])
export const ContextSelectionInclusionReasonV1 = Schema.Literals([
  "required", "current_request", "selected_tool", "profile", "instruction", "skill", "template", "artifact", "retrieval", "context_anchor", "history", "summary",
])

/** A reference only: content and copied transcript text are never carried here. */
export const ContextSelectionSourceV1 = Schema.Struct({
  kind: ContextSelectionSourceKindV1,
  sourceID: OpaqueID,
  sourceRevision: SourceRevision,
  contentDigest: Digest,
  sourceAuthority: ContextSelectionAuthorityV1,
  trust: ContextSelectionTrustV1,
  included: Schema.Literal(true),
  inclusionReason: ContextSelectionInclusionReasonV1,
  /** Present only on the toolset manifest so Rust can recompute the generation digest. */
  harnessRevision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))),
})

export const ContextSelectionV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  lane: Schema.Literals(["direct", "managed"]),
  sessionID: SessionID.check(Schema.isPattern(/^ses_[A-Za-z0-9_-]{1,128}$/)),
  /** Stable Core request identity; every selection is frozen at one request boundary. */
  requestID: OpaqueID,
  /** Present only for managed request pins; the direct Session path has no managed Attempt. */
  attemptID: Schema.optional(OpaqueID),
  requestSequence: Schema.optional(DecimalU64),
  mode: ContextSelectionModeV1,
  /** Latest durable Session aggregate cursor observed by Core while compiling. */
  sourceRevision: DecimalU64,
  /** Ordered model-visible references; exclusions remain in ContextLedger, not this selection. */
  sources: Schema.Array(ContextSelectionSourceV1).check(Schema.isMaxLength(64)),
}).check(Schema.makeFilter((selection) => {
  const max = "18446744073709551615"
  const u64 = (value: string) => value.length < max.length || (value.length === max.length && value <= max)
  const decimalU64 = (value: string) => /^(?:0|[1-9][0-9]{0,19})$/.test(value) && u64(value)
  if ((selection.lane === "managed") !== (selection.attemptID !== undefined)) return "lane must match managed Attempt authority"
  if (selection.lane === "direct" && selection.sources.some((source) => source.kind === "managed-task" || source.kind === "accepted-spec")) {
    return "direct selection cannot pin managed-lane sources"
  }
  if (!u64(selection.sourceRevision)) return "sourceRevision exceeds u64"
  if ((selection.attemptID === undefined) !== (selection.requestSequence === undefined)) return "attemptID and requestSequence must be supplied together"
  if (selection.requestSequence !== undefined && (!u64(selection.requestSequence) || selection.requestSequence === "0" || Number(selection.requestSequence) > 1024)) return "requestSequence must be between 1 and 1024"
  if (selection.sources.length === 0) return "context selection must include at least one model-visible reference"
  if (selection.mode === "fresh" && selection.sources.some((source) => source.kind === "session-message")) return "fresh selection cannot include parent messages"
  if (selection.mode !== "fresh" && !selection.sources.some((source) => source.kind === "session-message")) return "non-fresh selection requires a session message source"
  if (selection.sources.some((source) => source.kind === "session-message" && !source.sourceID.startsWith("msg_"))) return "session message sourceID must use the canonical msg_ form"
  for (const source of selection.sources) {
    if (source.kind === "session-message" && !decimalU64(source.sourceRevision)) {
      return "session-message sourceRevision must be a canonical DecimalU64 cursor"
    }
    if (source.kind === "tool" && source.sourceID.startsWith("toolset:") && source.harnessRevision === undefined) {
      return "the toolset manifest must pin its harness revision"
    }
    if (!(source.kind === "tool" && source.sourceID.startsWith("toolset:")) && source.harnessRevision !== undefined) {
      return "only the toolset manifest pins a harness revision"
    }
  }
  const ids = selection.sources.map((source) => `${source.kind}\0${source.sourceID}`)
  if (new Set(ids).size !== ids.length) return "context source references must be unique"
  const expectedAuthority: Record<typeof selection.sources[number]["kind"], typeof selection.sources[number]["sourceAuthority"]> = {
    "session-message": "session-store",
    "agent-profile": "core-config",
    "managed-task": "managed-control",
    "accepted-spec": "managed-control",
    "provider-input": "core-prompt-compiler",
    tool: "tool-registry",
    instruction: "instruction-resolver",
    skill: "skill-resolver",
    "prompt-template": "template-resolver",
    artifact: "artifact-store",
  }
  if (selection.sources.some((source) => source.sourceAuthority !== expectedAuthority[source.kind])) return "source authority does not match source kind"
  const providerInputs = selection.sources.filter((source) => source.kind === "provider-input")
  if (providerInputs.length !== 1 || providerInputs[0].sourceID !== selection.requestID || providerInputs[0].trust !== "mixed" || providerInputs[0].inclusionReason !== "current_request") return "provider-input must pin this exact request"
  if (providerInputs[0].sourceRevision !== (selection.requestSequence ?? selection.sourceRevision)) return "provider-input revision does not match this request sequence"
  if (selection.lane === "direct") {
    const profiles = selection.sources.filter((source) => source.kind === "agent-profile")
    const profile = profiles[0]
    if (profiles.length !== 1 || !profile || profile.sourceAuthority !== "core-config" || !["system", "user"].includes(profile.trust) || profile.inclusionReason !== "profile" || !decimalU64(profile.sourceRevision) || profile.sourceRevision === "0" || !/^blake3:[0-9a-f]{64}$/.test(profile.contentDigest)) {
      return "direct selection requires exactly one active Core Config profile ref with revision and digest"
    }
  }
  if (selection.attemptID !== undefined) {
    for (const kind of ["managed-task", "accepted-spec", "agent-profile"] as const) {
      if (selection.sources.filter((source) => source.kind === kind).length !== 1) return `managed selection requires exactly one ${kind} reference`
    }
    const tools = selection.sources.filter((source) => source.kind === "tool")
    const manifests = tools.filter((source) => source.sourceID.startsWith("toolset:"))
    if (manifests.length !== 1 || manifests[0]?.harnessRevision === undefined || manifests[0].sourceRevision !== manifests[0].contentDigest) return "managed selection requires one revisioned toolset manifest"
    if (tools.length > 33) return "managed selection exceeds the tool registry generation bound"
    const members = tools.filter((source) => !source.sourceID.startsWith("toolset:"))
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index]!
      if (!/^blake3:[0-9a-f]{64}$/.test(member.contentDigest) || member.sourceRevision !== manifests[0]!.sourceRevision || (index > 0 && members[index - 1]!.sourceID >= member.sourceID)) return "managed tool refs must be sorted and pinned to one generation"
    }
  }
  return undefined
}))

export type ContextSelectionV1 = typeof ContextSelectionV1.Type
