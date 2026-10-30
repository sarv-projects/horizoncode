import { expect, test } from "bun:test"
import { requireMediatedWorkflowProvider } from "../../src/session/hosted-tools"

test("ordinary local-tool provider execution is unaffected", () => {
  expect(() => requireMediatedWorkflowProvider(false)).not.toThrow()
})

test("unmediated hosted workflow provider is rejected before any request", () => {
  expect(() => requireMediatedWorkflowProvider(true)).toThrow(
    "Hosted workflow provider unavailable",
  )
})
