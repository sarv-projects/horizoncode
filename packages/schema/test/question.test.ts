import { describe, expect, test } from "bun:test"
import { EventManifest } from "../src/event-manifest"
import { Question } from "../src/question"
import { QuestionV1 } from "../src/question-v1"
import { Schema } from "effect"

describe("Question V2 event contracts", () => {
  const currentTypes = [
    Question.Event.Asked.type,
    Question.Event.Replied.type,
    Question.Event.Rejected.type,
  ]

  test("publishes one canonical definition for each V2 question event", () => {
    const serverTypes = EventManifest.ServerDefinitions.map((definition) => definition.type)
    const publicTypes = EventManifest.Definitions.map((definition) => definition.type)

    for (const type of currentTypes) {
      expect(serverTypes.filter((candidate) => candidate === type)).toHaveLength(1)
      expect(publicTypes.filter((candidate) => candidate === type)).toHaveLength(1)
    }
  })

  test("keeps legacy question event names distinct from the V2 event family", () => {
    const legacyTypes = [
      QuestionV1.Event.Asked.type,
      QuestionV1.Event.Replied.type,
      QuestionV1.Event.Rejected.type,
    ]

    expect(legacyTypes).toEqual(["question.asked", "question.replied", "question.rejected"])
    expect(currentTypes).toEqual(["question.v2.asked", "question.v2.replied", "question.v2.rejected"])
  })

  test("bounds question prompts, options, and answer text on both wire generations", () => {
    const prompt = {
      question: "Which build?",
      header: "Build",
      options: [{ label: "Fast", description: "Fast build" }],
    }
    expect(() => Schema.decodeUnknownSync(Question.Prompt)({ ...prompt, header: "h".repeat(31) })).toThrow()
    expect(() => Schema.decodeUnknownSync(QuestionV1.Prompt)({ ...prompt, question: "q".repeat(2049) })).toThrow()
    expect(() => Schema.decodeUnknownSync(Question.Prompt)({ ...prompt, options: Array.from({ length: 13 }, () => prompt.options[0]) })).toThrow()
    expect(() => Schema.decodeUnknownSync(Question.Reply)({ answers: [["a".repeat(513)]] })).toThrow()
    expect(() => Schema.decodeUnknownSync(QuestionV1.Reply)({ answers: [["a".repeat(513)]] })).toThrow()
  })

  test("caps a single question request to eight bounded prompts", () => {
    const prompt = { question: "Which build?", header: "Build", options: [{ label: "Fast", description: "Fast build" }] }
    expect(() => Schema.decodeUnknownSync(Question.Request)({
      id: "que_test",
      sessionID: "ses_test",
      questions: Array.from({ length: 9 }, () => prompt),
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(QuestionV1.Request)({
      id: "que_test",
      sessionID: "ses_test",
      questions: Array.from({ length: 9 }, () => prompt),
    })).toThrow()
  })
})
