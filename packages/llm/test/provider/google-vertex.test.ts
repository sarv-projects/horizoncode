import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../../src"
import * as Providers from "../../src/providers"
import { Auth, LLMClient } from "../../src/route"
import type { Auth as AuthDef } from "../../src/route"
import type { Model } from "../../src/schema"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const GoogleVertex = Reflect.get(Providers, "GoogleVertex") as
  | {
      configure: (input: { project: string; location: string; auth: AuthDef }) => {
        model: (id: string) => Model
      }
    }
  | undefined

describe("Google Vertex Gemini route", () => {
  it.effect("rejects missing caller auth instead of falling back to unauthenticated Gemini", () =>
    Effect.sync(() => {
      expect(() =>
        GoogleVertex!.configure({
          project: "vertex-project",
          location: "global",
          auth: undefined as unknown as AuthDef,
        }),
      ).toThrow("caller-provided Auth")
    }),
  )

  it.effect("rejects a location that could escape the Vertex host namespace", () =>
    Effect.sync(() => {
      expect(() =>
        GoogleVertex!.configure({
          project: "vertex-project",
          location: "us-central1.attacker.invalid",
          auth: Auth.bearer("caller-owned-token"),
        }),
      ).toThrow("lowercase Vertex location identifier")
    }),
  )

  it.effect("rejects a blank project before request construction", () =>
    Effect.sync(() => {
      expect(() =>
        GoogleVertex!.configure({
          project: "  ",
          location: "global",
          auth: Auth.bearer("caller-owned-token"),
        }),
      ).toThrow("non-empty project")
    }),
  )

  for (const { location, host } of [
    { location: "global", host: "aiplatform.googleapis.com" },
    { location: "eu", host: "aiplatform.eu.rep.googleapis.com" },
    { location: "us", host: "aiplatform.us.rep.googleapis.com" },
    { location: "us-central1", host: "us-central1-aiplatform.googleapis.com" },
  ])
    it.effect(`sends Gemini GenerateContent to the explicit ${location} endpoint with caller auth`, () =>
      Effect.gen(function* () {
        expect(GoogleVertex).toBeDefined()
        const model = GoogleVertex!.configure({
          project: "vertex-project",
          location,
          auth: Auth.bearer("caller-owned-token"),
        }).model("gemini-2.5-flash")

        let observed: { url: string; authorization: string | null; body: unknown } | undefined
        const response = yield* LLM.generate(
          LLM.request({ model, prompt: "Say hello.", generation: { maxTokens: 32 } }),
        ).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                observed = {
                  url: web.url,
                  authorization: web.headers.get("authorization"),
                  body: JSON.parse(input.text),
                }
                return input.respond(
                  sseEvents({
                    candidates: [{ content: { role: "model", parts: [{ text: "Vertex OK" }] }, finishReason: "STOP" }],
                    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                )
              }),
            ),
          ),
        )

        expect(observed).toEqual({
          url: `https://${host}/v1/projects/vertex-project/locations/${location}/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
          authorization: "Bearer caller-owned-token",
          body: {
            contents: [{ role: "user", parts: [{ text: "Say hello." }] }],
            generationConfig: { maxOutputTokens: 32 },
          },
        })
        expect(response.text).toBe("Vertex OK")
      }),
    )
})
