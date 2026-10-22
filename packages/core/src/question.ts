export * as QuestionV2 from "./question"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Question } from "@opencode-ai/schema/question"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"

export const ID = Question.ID
export type ID = typeof ID.Type

export const Option = Question.Option
export type Option = typeof Option.Type

export const Info = Question.Info
export type Info = typeof Info.Type

export const Prompt = Question.Prompt
export type Prompt = typeof Prompt.Type

export const Tool = Question.Tool
export type Tool = typeof Tool.Type

export const Request = Question.Request
export type Request = typeof Request.Type

export const Answer = Question.Answer
export type Answer = typeof Answer.Type

export const Answers = Question.Answers
export type Answers = typeof Answers.Type

export const Reply = Question.Reply
export type Reply = typeof Reply.Type

export const Event = Question.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionV2.RejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("QuestionV2.NotFoundError", {
  requestID: ID,
}) {}

export class InvalidReplyError extends Schema.TaggedErrorClass<InvalidReplyError>()("QuestionV2.InvalidReplyError", {
  requestID: ID,
  reason: Schema.Literals([
    "question-count",
    "malformed-answer",
    "unknown-option",
    "multiple-not-allowed",
    "duplicate-option",
    "custom-disabled",
  ]),
}) {
  override get message() {
    return "The reply does not match the pending question"
  }
}

export const validateReply = (request: Request, answers: ReadonlyArray<Answer>) => {
  if (!Array.isArray(answers) || answers.length !== request.questions.length) return "question-count" as const
  for (const [index, answer] of answers.entries()) {
    const question = request.questions[index]
    if (
      !Array.isArray(answer) ||
      answer.length > 13 ||
      answer.some((value) => typeof value !== "string" || value.length > 512)
    ) return "malformed-answer" as const
    const labels = question.options.map((option) => option.label)
    if (new Set(answer).size !== answer.length) return "duplicate-option" as const
    if (question.multiple !== true && answer.length > 1) return "multiple-not-allowed" as const
    for (const value of answer) {
      if (labels.includes(value)) continue
      if (question.custom === false) return "custom-disabled" as const
      if (value.length === 0) return "unknown-option" as const
    }
  }
}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly tool?: Tool
}

export interface ReplyInput {
  readonly sessionID: SessionSchema.ID
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
}

export interface RejectInput {
  readonly sessionID: SessionSchema.ID
  readonly requestID: ID
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError | InvalidReplyError>
  readonly reject: (input: RejectInput) => Effect.Effect<void, NotFoundError>
  readonly list: (sessionID?: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Question") {}

interface Pending {
  readonly request: Request
  readonly deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

/**
 * Location-owned pending prompts. The Location layer map must materialize this
 * layer once per embedded Location so replies cannot settle another Location's
 * deferred request.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const pending = new Map<ID, Pending>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const ask = Effect.fn("QuestionV2.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = ID.ascending()
          const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
          const request: Request = { id, ...input }
          pending.set(id, { request, deferred })
          return yield* events.publish(Event.Asked, request).pipe(
            Effect.andThen(restore(Deferred.await(deferred))),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("QuestionV2.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing || existing.request.sessionID !== input.sessionID)
            return yield* new NotFoundError({ requestID: input.requestID })
          const invalid = validateReply(existing.request, input.answers)
          if (invalid) return yield* new InvalidReplyError({ requestID: input.requestID, reason: invalid })
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            answers: input.answers.map((answer) => [...answer]),
          })
          yield* Deferred.succeed(existing.deferred, input.answers)
          pending.delete(input.requestID)
        }),
      ),
    )

    const reject = Effect.fn("QuestionV2.reject")((input: RejectInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing || existing.request.sessionID !== input.sessionID)
            return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Rejected, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
          })
          yield* Deferred.fail(existing.deferred, new RejectedError())
          pending.delete(input.requestID)
        }),
      ),
    )

    const list = Effect.fn("QuestionV2.list")(function* (sessionID?: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter(
        (request) => sessionID === undefined || request.sessionID === sessionID,
      )
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node] })
