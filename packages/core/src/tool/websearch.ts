/**
 * Legacy Core search registration retained for compatibility only.
 *
 * HorizonCode's V1 search provider cascade is owned by the Horizon tool broker
 * and may execute only through its Rust Guard/ExecutionHost transport. This
 * legacy Core tool has no such authenticated transport, so it must stay
 * unavailable. In particular, do not restore direct HttpClient/MCP requests
 * here: doing so would create a second, unguarded search origin.
 */

export * as WebSearchTool from "./websearch"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "websearch"
export const NO_RESULTS = "No search results found. Please try a different query."
export const MAX_NUM_RESULTS = 10
export const MAX_CONTEXT_CHARACTERS = 50_000

export const description =
  "Web search is unavailable until the HorizonCode Rust Guard and ExecutionHost search transport is integrated."

export const Input = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)).annotate({
    description: "Web-search query (up to 2,000 characters)",
  }),
  numResults: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_NUM_RESULTS))),
})

const Output = Schema.Struct({ text: Schema.String })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools.register({
      [name]: Tool.make({
        description,
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: () => Effect.fail(new ToolFailure({ message: description })),
      }),
    }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/websearch", layer, deps: [ToolRegistry.node] })
