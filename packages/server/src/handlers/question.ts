import { QuestionV2 } from "@opencode-ai/core/question"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { InvalidRequestError, QuestionNotFoundError } from "@opencode-ai/protocol/errors"
import { response } from "../location"

function missingRequest(id: QuestionV2.ID) {
  return new QuestionNotFoundError({ requestID: id, message: `Question request not found: ${id}` })
}

function invalidReply(id: QuestionV2.ID, reason: string) {
  return new InvalidRequestError({
    message: `Question reply does not match request ${id}: ${reason}`,
    kind: "question_invalid_reply",
    field: "answers",
  })
}

export const QuestionHandler = HttpApiBuilder.group(Api, "server.question", (handlers) =>
  Effect.gen(function* () {
    const withOwnedQuestion = Effect.fnUntraced(function* <A, E>(
      sessionID: QuestionV2.Request["sessionID"],
      requestID: QuestionV2.ID,
      use: (question: QuestionV2.Interface) => Effect.Effect<A, E>,
    ) {
      const question = yield* QuestionV2.Service
      const request = (yield* question.list(sessionID)).find((request) => request.id === requestID)
      if (!request || request.sessionID !== sessionID) return yield* Effect.fail(missingRequest(requestID))
      return yield* use(question)
    })

    return handlers
      .handle(
        "question.request.list",
        Effect.fn(function* () {
          return yield* response((yield* QuestionV2.Service).list())
        }),
      )
      .handle(
        "session.question.list",
        Effect.fn(function* (ctx) {
          return { data: yield* (yield* QuestionV2.Service).list(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.question.reply",
        Effect.fn(function* (ctx) {
          yield* withOwnedQuestion(ctx.params.sessionID, ctx.params.requestID, (question) =>
            question
              .reply({
                sessionID: ctx.params.sessionID,
                requestID: ctx.params.requestID,
                answers: ctx.payload.answers,
              })
              .pipe(
                Effect.catchTag("QuestionV2.NotFoundError", () =>
                  Effect.fail(missingRequest(ctx.params.requestID))),
                Effect.catchTag("QuestionV2.InvalidReplyError", (error) =>
                  Effect.fail(invalidReply(ctx.params.requestID, error.reason))),
              ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.question.reject",
        Effect.fn(function* (ctx) {
          yield* withOwnedQuestion(ctx.params.sessionID, ctx.params.requestID, (question) =>
            question
              .reject({
                sessionID: ctx.params.sessionID,
                requestID: ctx.params.requestID,
              })
              .pipe(Effect.catchTag("QuestionV2.NotFoundError", () =>
                Effect.fail(missingRequest(ctx.params.requestID)))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
