import { expect, test } from "bun:test"
import { QuestionApi } from "@/server/routes/instance/httpapi/groups/question"

test("question HTTP API group constructs its schemas at module load", () => {
  expect(QuestionApi).toBeDefined()
})
