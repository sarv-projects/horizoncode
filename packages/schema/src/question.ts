export * as Question from "./question"

import { Schema } from "effect"
import { optional } from "./schema"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { SessionID } from "./session-id"
import { statics } from "./schema"

const BoundedText = (max: number) => Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(max))
const QuestionText = BoundedText(2048)
const HeaderText = BoundedText(30)
const OptionLabel = BoundedText(80)
const OptionDescription = BoundedText(512)

export const ID = Schema.String.check(Schema.isStartsWith("que")).pipe(
  Schema.brand("QuestionV2.ID"),
  statics((schema) => {
    const create = () => schema.make("que_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

export const Option = Schema.Struct({
  label: OptionLabel.annotate({ description: "Display text (1-5 words, concise)" }),
  description: OptionDescription.annotate({ description: "Explanation of choice" }),
}).annotate({ identifier: "QuestionV2.Option" })
export interface Option extends Schema.Schema.Type<typeof Option> {}

export const Options = Schema.Array(Option).check(Schema.isMinLength(1)).check(Schema.isMaxLength(12))

const base = {
  question: QuestionText.annotate({ description: "Complete question (maximum 2048 characters)" }),
  header: HeaderText.annotate({ description: "Very short label (maximum 30 characters)" }),
  options: Options.annotate({ description: "One to twelve available choices" }),
  multiple: Schema.Boolean.pipe(optional).annotate({ description: "Allow selecting multiple choices" }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.Boolean.pipe(optional).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}).annotate({ identifier: "QuestionV2.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Questions = Schema.Array(Info).check(Schema.isMinLength(1)).check(Schema.isMaxLength(8))

export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionV2.Prompt" })
export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}

export const Tool = Schema.Struct({
  messageID: Schema.String,
  callID: Schema.String,
}).annotate({ identifier: "QuestionV2.Tool" })
export interface Tool extends Schema.Schema.Type<typeof Tool> {}

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  questions: Questions.annotate({ description: "One to eight questions to ask" }),
  tool: Tool.pipe(optional),
}).annotate({ identifier: "QuestionV2.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

const AnswerValue = Schema.String.check(Schema.isMaxLength(512))
export const Answer = Schema.Array(AnswerValue).check(Schema.isMaxLength(13)).annotate({ identifier: "QuestionV2.Answer" })
export type Answer = typeof Answer.Type

export const Answers = Schema.Array(Answer).check(Schema.isMaxLength(8))

export const Reply = Schema.Struct({
  answers: Answers.annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionV2.Reply" })
export interface Reply extends Schema.Schema.Type<typeof Reply> {}

const Asked = define({ type: "question.v2.asked", schema: Request.fields })
const Replied = define({
  type: "question.v2.replied",
  schema: {
    sessionID: SessionID,
    requestID: ID,
    answers: Answers,
  },
})
const Rejected = define({
  type: "question.v2.rejected",
  schema: {
    sessionID: SessionID,
    requestID: ID,
  },
})
export const Event = { Asked, Replied, Rejected, Definitions: inventory(Asked, Replied, Rejected) }
