import { Effect, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { Auth, type Auth as AuthDef, type AuthInput } from "../auth"
import { render as renderEndpoint } from "../endpoint"
import { Framing, type Framing as FramingDef } from "../framing"
import type { Transport, TransportPrepareInput } from "./index"
import * as ProviderShared from "../../protocols/shared"
import { mergeJsonRecords, type LLMRequest } from "../../schema"

export type JsonRequestInput<Body> = TransportPrepareInput<Body>

export interface JsonRequestParts<Body = unknown> {
  readonly url: string
  readonly jsonBody: Body | Record<string, unknown>
  readonly bodyText: string
  readonly headers: Headers.Headers
}

export interface HttpPrepared<Frame> {
  readonly url: string
  readonly bodyText: string
  readonly headers: Headers.Headers
  readonly auth: AuthDef
  readonly authInput: AuthInput
  readonly framing: FramingDef<Frame>
}

const applyQuery = (url: string, query: Record<string, string> | undefined) => {
  if (!query) return url
  const next = new URL(url)
  Object.entries(query).forEach(([key, value]) => next.searchParams.set(key, value))
  return next.toString()
}

const PROTOCOL_BODY_OVERLAY_DENYLIST = new Set([
  "content",
  "contents",
  "frequencyPenalty",
  "frequency_penalty",
  "generationConfig",
  "inferenceConfig",
  "input",
  "maxTokens",
  "max_tokens",
  "messages",
  "model",
  "presencePenalty",
  "presence_penalty",
  "responseFormat",
  "response_format",
  "seed",
  "stop",
  "stopSequences",
  "stop_sequences",
  "stream",
  "streamOptions",
  "stream_options",
  "system",
  "systemInstruction",
  "system_instruction",
  "temperature",
  "thinking",
  "toolChoice",
  "toolConfig",
  "tool_choice",
  "tool_config",
  "tools",
  "topK",
  "topP",
  "top_k",
  "top_p",
])

const forbiddenBodyOverlayKeys = (body: Record<string, unknown>) =>
  Object.keys(body).filter((key) => PROTOCOL_BODY_OVERLAY_DENYLIST.has(key))

const bodyWithOverlay = <Body>(body: Body, request: LLMRequest, encodeBody: (body: Body) => string) =>
  Effect.gen(function* () {
    if (request.http?.body === undefined) return { jsonBody: body, bodyText: encodeBody(body) }
    const forbiddenKeys = forbiddenBodyOverlayKeys(request.http.body)
    if (forbiddenKeys.length > 0)
      return yield* ProviderShared.invalidRequest(
        `http.body cannot overlay protocol-owned field(s): ${forbiddenKeys.join(", ")}`,
      )
    if (ProviderShared.isRecord(body)) {
      const overlaid = mergeJsonRecords(body, request.http.body) ?? {}
      return { jsonBody: overlaid, bodyText: ProviderShared.encodeJson(overlaid) }
    }
    return yield* ProviderShared.invalidRequest("http.body can only overlay JSON object request bodies")
  })

const jsonRequestPartsWithoutAuth = <Body>(input: JsonRequestInput<Body>) =>
  Effect.gen(function* () {
    const url = applyQuery(
      renderEndpoint(input.endpoint, { request: input.request, body: input.body }).toString(),
      input.request.http?.query,
    )
    const body = yield* bodyWithOverlay(input.body, input.request, input.encodeBody)
    const authInput: AuthInput = {
      request: input.request,
      method: "POST",
      url,
      body: body.bodyText,
      headers: Headers.fromInput({
        ...input.headers?.({ request: input.request }),
        ...input.request.http?.headers,
      }),
    }
    return { url, jsonBody: body.jsonBody, bodyText: body.bodyText, headers: authInput.headers, authInput }
  })

export const jsonRequestParts = <Body>(input: JsonRequestInput<Body>) =>
  jsonRequestPartsWithoutAuth(input).pipe(
    Effect.flatMap((parts) =>
      Auth.toEffect(input.auth)(parts.authInput).pipe(
        Effect.map((headers) => ({ ...parts, headers })),
      ),
    ),
  )

export interface HttpJsonInput<_Body, Frame> {
  readonly framing: FramingDef<Frame>
}

export type HttpJsonPatch<Body, Frame> = Partial<HttpJsonInput<Body, Frame>>

export interface HttpJsonTransport<Body, Frame> extends Transport<Body, HttpPrepared<Frame>, Frame> {
  readonly with: (patch: HttpJsonPatch<Body, Frame>) => HttpJsonTransport<Body, Frame>
}

export const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
  id: "http-json",
  with: (patch) => httpJson({ ...input, ...patch }),
  prepare: (prepareInput) =>
    jsonRequestPartsWithoutAuth({
      ...prepareInput,
    }).pipe(
      Effect.map((parts) => ({
        url: parts.url,
        bodyText: parts.bodyText,
        headers: parts.headers,
        auth: prepareInput.auth,
        authInput: parts.authInput,
        framing: input.framing,
      })),
    ),
  frames: (prepared, request, runtime, executionContext) =>
    Stream.unwrap(
      Auth.withRequestEffect(prepared.auth, prepared.authInput, (headers) =>
        runtime.http.execute(
          ProviderShared.jsonPost({
            url: prepared.url,
            body: prepared.bodyText,
            headers,
          }),
          executionContext,
        ),
      )
        .pipe(
          Effect.map((response) =>
            prepared.framing.frame(
              response.stream.pipe(
                Stream.mapError((error) =>
                  ProviderShared.eventError(
                    `${request.model.provider}/${request.model.route.id}`,
                    `Failed to read ${request.model.provider}/${request.model.route.id} stream`,
                    ProviderShared.errorText(error),
                  ),
                ),
              ),
            ),
          ),
        ),
    ),
})

export const sseJson = {
  id: "http-json/sse",
  with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
