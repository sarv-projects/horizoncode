import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./webfetch.txt"

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

const UNAVAILABLE = "Web fetch is unavailable until Guarded outbound HTTP support is wired"

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.succeed({
    description: `${DESCRIPTION}\n\nUnavailable until outbound HTTP is mediated by the canonical Rust Guard/ExecutionHost.`,
    parameters: Parameters,
    execute: () => Effect.fail(new ToolFailure({ message: UNAVAILABLE })).pipe(Effect.orDie),
  }),
)
