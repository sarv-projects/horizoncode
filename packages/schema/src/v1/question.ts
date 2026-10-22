export * as QuestionV1 from "./question"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { ascending } from "../identifier"
import { statics } from "../schema"
import { SessionID } from "../session-id"
import { SessionV1 } from "./session"

const BoundedText = (max: number) => Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(max))
const QuestionText = BoundedText(2048)
const HeaderText = BoundedText(30)
const OptionLabel = BoundedText(80)
const OptionDescription = BoundedText(512)

export const ID = Schema.String.check(Schema.isStartsWith("que")).pipe(
  Schema.brand("QuestionID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "que_" + ascending()) })),
)

export const Option = Schema.Struct({
  label: OptionLabel.annotate({ description: "Display text (1-5 words, concise)" }),
  description: OptionDescription.annotate({ description: "Explanation of choice" }),
}).annotate({ identifier: "QuestionOption" })

const Options = Schema.Array(Option).check(Schema.isMinLength(1)).check(Schema.isMaxLength(12))

const base = {
  question: QuestionText.annotate({ description: "Complete question (maximum 2048 characters)" }),
  header: HeaderText.annotate({ description: "Very short label (maximum 30 characters)" }),
  options: Options.annotate({ description: "One to twelve available choices" }),
  multiple: Schema.optional(Schema.Boolean).annotate({ description: "Allow selecting multiple choices" }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.optional(Schema.Boolean).annotate({ description: "Allow typing a custom answer (default: true)" }),
}).annotate({ identifier: "QuestionInfo" })
const Questions = Schema.Array(Info).check(Schema.isMinLength(1)).check(Schema.isMaxLength(8))
export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionPrompt" })
export const Tool = Schema.Struct({ messageID: SessionV1.MessageID, callID: Schema.String }).annotate({
  identifier: "QuestionTool",
})
export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  questions: Questions.annotate({ description: "One to eight questions to ask" }),
  tool: Schema.optional(Tool),
}).annotate({ identifier: "QuestionRequest" })
const AnswerValue = Schema.String.check(Schema.isMaxLength(512))
export const Answer = Schema.Array(AnswerValue).check(Schema.isMaxLength(13)).annotate({ identifier: "QuestionAnswer" })
const Answers = Schema.Array(Answer).check(Schema.isMaxLength(8))
export const Reply = Schema.Struct({
  answers: Answers.annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionReply" })
export const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: ID,
  answers: Answers,
}).annotate({
  identifier: "QuestionReplied",
})
export const Rejected = Schema.Struct({ sessionID: SessionID, requestID: ID }).annotate({
  identifier: "QuestionRejected",
})

const Asked = define({ type: "question.asked", schema: Request.fields })
const RepliedEvent = define({ type: "question.replied", schema: Replied.fields })
const RejectedEvent = define({ type: "question.rejected", schema: Rejected.fields })
export const Event = {
  Asked,
  Replied: RepliedEvent,
  Rejected: RejectedEvent,
  Definitions: inventory(Asked, RepliedEvent, RejectedEvent),
}
