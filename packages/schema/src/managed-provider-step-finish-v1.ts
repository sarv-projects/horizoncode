import { Schema } from "effect"
import { NonNegativeInt } from "./schema"
import { SessionV1 } from "./v1/session"
import { SessionMessage } from "./session-message"

/** First-party strict overlay for fields HorizonCode persists on V1 step-finish parts. */
export const ManagedProviderStepFinishV1 = Schema.Struct({
  id: SessionV1.PartID,
  sessionID: Schema.String.check(Schema.isStartsWith("ses_")),
  messageID: SessionV1.MessageID,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
  }),
  stepFinishIndex: NonNegativeInt.pipe(Schema.check(Schema.isLessThanOrEqualTo(1024))),
  usageProvenance: SessionMessage.UsageProvenance,
}).annotate({ identifier: "HorizonCode.ManagedProviderStepFinishV1" })

export type ManagedProviderStepFinishV1 = typeof ManagedProviderStepFinishV1.Type

/** Exact immutable receipt payload for one completed provider dispatch. */
export const ManagedProviderResponseEntryV2 = Schema.Struct({
  assistantInfo: SessionV1.Assistant,
  stepFinishPart: ManagedProviderStepFinishV1,
  stepFinishIndex: NonNegativeInt.pipe(Schema.check(Schema.isLessThanOrEqualTo(1024))),
}).annotate({ identifier: "HorizonCode.ManagedProviderResponseEntryV2" })

export type ManagedProviderResponseEntryV2 = typeof ManagedProviderResponseEntryV2.Type
