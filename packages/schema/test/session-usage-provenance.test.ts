import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionEvent } from "../src/session-event"
import { SessionMessage } from "../src/session-message"

const reported = { status: "provider-reported", value: 0 }
const measured = { status: "measured", value: 0 }
const estimated = {
  status: "estimated",
  value: 0.25,
  priceSource: "catalog",
  pricingRevision: `sha256:${"a".repeat(64)}`,
  pricing: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
  algorithm: "per-million-linear-v1",
  tokenInputs: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
}
const unknown = { status: "unknown" }

test("V2 step settlement preserves explicit zero and unknown usage provenance", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Step.Ended)({
    id: "evt_usage",
    type: SessionEvent.Step.Ended.type,
    data: {
      timestamp: Date.now(),
      sessionID: "ses_usage",
      assistantMessageID: "msg_usage",
      finish: "stop",
      usageProvenance: {
        providerID: "provider-a",
        modelID: "model-a",
        requestID: "request-a",
        cost: reported,
        tokens: {
          input: measured,
          output: measured,
          reasoning: unknown,
          cache: { read: unknown, write: measured },
        },
      },
    },
  })
  expect(decoded.data.usageProvenance.cost).toEqual(reported)
  expect(decoded.data.usageProvenance.tokens.cache.read).toEqual(unknown)
  expect(() =>
    Schema.decodeUnknownSync(SessionEvent.Step.Ended)({
      id: "evt_usage_negative",
      type: SessionEvent.Step.Ended.type,
      data: {
        timestamp: Date.now(),
        sessionID: "ses_usage",
        assistantMessageID: "msg_usage",
        finish: "stop",
        usageProvenance: {
          providerID: "provider-a",
          modelID: "model-a",
          cost: unknown,
          tokens: {
            input: { status: "measured", value: -1 },
            output: unknown,
            reasoning: unknown,
            cache: { read: unknown, write: unknown },
          },
        },
      },
    }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(SessionEvent.Step.Ended)({
      id: "evt_usage_unknown_value",
      type: SessionEvent.Step.Ended.type,
      data: {
        timestamp: Date.now(),
        sessionID: "ses_usage",
        assistantMessageID: "msg_usage",
        finish: "stop",
        usageProvenance: {
          providerID: "provider-a",
          modelID: "model-a",
          cost: { status: "unknown", value: 0 },
          tokens: { input: unknown, output: unknown, reasoning: unknown, cache: { read: unknown, write: unknown } },
        },
      },
    }),
  ).toThrow()
})

test("assistant usage metadata accepts estimates, unknowns, and legacy rows", () => {
  const value = {
    id: "msg_usage",
    type: "assistant",
    agent: "build",
    model: { providerID: "provider-a", id: "model-a" },
    content: [],
    time: { created: Date.now() },
    usageProvenance: {
      providerID: "provider-a",
      modelID: "model-a",
      requestID: "request-a",
      cost: estimated,
      tokens: { input: measured, output: unknown, reasoning: unknown, cache: { read: unknown, write: unknown } },
    },
  }
  expect(Schema.decodeUnknownSync(SessionMessage.Assistant)(value).usageProvenance?.cost).toEqual(estimated)

  const legacy = {
    ...value,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  delete (legacy as { usageProvenance?: unknown }).usageProvenance
  expect(Schema.decodeUnknownSync(SessionMessage.Assistant)(legacy).cost).toBe(0)
})

test("usage provenance projection is strict and preserves unavailable cost truth", () => {
  const strict = Schema.decodeUnknownSync(SessionMessage.UsageProvenance, { onExcessProperty: "error" })
  const projection = {
    providerID: "provider-a",
    modelID: "model-a",
    cost: unknown,
    tokens: {
      input: { status: "provider-reported", value: 0 },
      output: unknown,
      reasoning: unknown,
      cache: { read: unknown, write: unknown },
    },
  }
  expect(strict(projection).cost).toEqual({ status: "unknown" })
  expect(() => strict({ ...projection, cost: { status: "unknown", value: 0 } })).toThrow()
  expect(() => strict({ ...projection, untrusted: "extra" })).toThrow()
  expect(() => strict({
    ...projection,
    cost: { status: "measured", value: 0 },
  })).toThrow()
})
