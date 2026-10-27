import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as DAPSession from "@/dap/session"

/**
 * Minimal product ingress for DAP. The adapter supervisor and protocol client
 * are deliberately not composed here: the direct-session authenticated
 * HostKernel/Guard lease producer and durable receipt recovery are not accepted
 * yet. Keeping this gate false prevents the model from seeing a nonfunctional
 * action, while the execute-side check ensures a future registry mistake still
 * cannot start or dispatch a process.
 */
// CODE_PRESENT / UNWIRED: the model-facing `debug` action stays hidden until integrated Guard/HostKernel acceptance.
export const DAP_TOOL_ACCEPTANCE_READY = false

const Parameters = Schema.Struct({
  adapterID: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)).annotate({
    description: "Trusted DAP adapter profile ID from settings. This selects policy and is not an executable path.",
  }),
})

export const DapTool = Tool.define(
  "debug",
  Effect.succeed({
    description:
      "Start a supervised debugger session using a trusted DAP adapter profile. Debugger launch and protocol dispatch are currently unavailable until the Guard, authenticated Attempt, OS confinement, and receipt recovery acceptance gates pass.",
    parameters: Parameters,
    capability: { id: "debug.start", effectClass: "effect" as const },
    execute: (args: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
      Effect.succeed({
        title: `Debugger unavailable (${args.adapterID})`,
        metadata: {
          available: false as const,
          capabilityID: "debug.start" as const,
          reason: "guard_not_verified" as const,
        },
        output: DAPSession.availability("session.start").detail,
      }),
  }),
)
