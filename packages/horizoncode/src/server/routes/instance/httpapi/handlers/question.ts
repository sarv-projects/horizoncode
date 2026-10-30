import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { legacyHostRootCompatible, ownerMatchesPrincipal } from "@/question/owner"
import { Session as SessionStore } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { QuestionNotFoundError } from "../errors"

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    const sessions = yield* SessionStore.Service

    // Questions are scoped to the authenticated owner of their Session. Direct
    // child Sessions inherit that authority through their durable parent chain;
    // request IDs and caller-provided identity are never authority.
    const canAccess = Effect.fn("QuestionHttpApi.canAccess")(function* (request: Question.Request) {
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (Option.isNone(authenticated)) return false
      const principal = authenticated.value.principal
      const instanceDirectory = yield* InstanceState.directory
      const workspaceID = yield* InstanceState.workspaceID
      let sessionID = request.sessionID
      let matchedOwner = false
      const seen = new Set<string>()
      for (let depth = 0; depth < 32; depth++) {
        if (seen.has(sessionID)) return false
        seen.add(sessionID)
        const found = yield* sessions.get(sessionID).pipe(Effect.option)
        if (Option.isNone(found)) return false
        const session = found.value
        if (session.directory !== instanceDirectory) return false
        if (session.workspaceID !== undefined && session.workspaceID !== workspaceID) return false
        const owner = session.metadata?.horizonPrincipalOwner
        if (owner !== undefined) {
          // Validate every recorded owner in the chain. Returning at the first
          // match would let a child owner hide conflicting authority metadata
          // on an ancestor.
          if (!ownerMatchesPrincipal(principal, owner)) return false
          matchedOwner = true
        }
        if (!session.parentID) {
          if (matchedOwner) return true
          // Compatibility applies only to an ownerless root created in this
          // exact instance directory; it is never inherited from request data.
          return legacyHostRootCompatible(principal, {
            parentID: session.parentID,
            directory: session.directory,
            instanceDirectory,
            ownerMetadata: owner,
          })
        }
        sessionID = session.parentID
      }
      return false
    })

    const notFound = (requestID: QuestionID) =>
      new QuestionNotFoundError({
        requestID: String(requestID),
        message: `Question request not found: ${requestID}`,
      })

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      const requests = yield* svc.list()
      const visible = yield* Effect.forEach(requests, (request) =>
        canAccess(request).pipe(Effect.map((allowed) => (allowed ? request : undefined))),
      )
      return visible.filter((request): request is Question.Request => request !== undefined)
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      const request = (yield* svc.list()).find((item) => item.id === ctx.params.requestID)
      if (!request || !(yield* canAccess(request))) return yield* Effect.fail(notFound(ctx.params.requestID))
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        .pipe(
          Effect.catchTag("Question.InvalidReplyError", () => Effect.fail(new HttpApiError.BadRequest({}))),
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      const request = (yield* svc.list()).find((item) => item.id === ctx.params.requestID)
      if (!request || !(yield* canAccess(request))) return yield* Effect.fail(notFound(ctx.params.requestID))
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject)
  }),
)
