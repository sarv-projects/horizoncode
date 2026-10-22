/** Versioned provider-independent request-shaping profile contract. */

import { Schema } from "effect"
import * as Composition from "./composition-v1"

const Identifier = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)).check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/))
const Digest = Schema.String.check(Schema.isPattern(/^(?:sha256:[0-9a-f]{64}|blake3:[0-9a-f]{64})$/))

export const HarnessProfileV1 = Schema.Struct({
  harnessId: Identifier,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  displayName: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)),
  source: Schema.Literal("builtin"),
  supportedWireApis: Schema.Array(Schema.Literals(["responses", "chat_completions", "anthropic_messages", "custom"]))
    .check(Schema.isMinLength(1)).check(Schema.isMaxLength(4)),
  systemPromptRef: Composition.ArtifactRef,
  toolProjection: Schema.Literals(["native_rich", "minimal", "bash_only"]),
  messageCodecId: Identifier,
  responseCodecId: Identifier,
  structuredCallPolicyId: Identifier,
  contextPolicyId: Identifier,
  outputPolicyId: Identifier,
  capabilityRequirements: Schema.Array(Identifier).check(Schema.isMaxLength(32)),
  definitionDigest: Digest,
  notes: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
}).check(Schema.makeFilter((profile) => new Set(profile.supportedWireApis).size === profile.supportedWireApis.length
  ? undefined
  : "supportedWireApis must be unique"))

export type HarnessProfileV1 = typeof HarnessProfileV1.Type
export const BuiltinHarnessIdV1 = Schema.Literals(["native-rich", "native-minimal", "bash-only"])
export type BuiltinHarnessIdV1 = typeof BuiltinHarnessIdV1.Type
