export * as BashTool from "./bash"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PositiveInt } from "../schema"
import { Pty } from "../pty"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { markBuiltinBash } from "./bash-provenance"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000

const ShellInput = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute through Guard" }),
  cwd: Schema.String.annotate({ description: "Working directory for the command" }),
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS)).annotate({
    description: `Timeout in milliseconds, up to ${MAX_TIMEOUT_MS}`,
  }),
})

const ProfileInput = Schema.Struct({
  mode: Schema.Literal("workspace_profile"),
  action: Schema.Literals(["build", "test"]),
  profileID: Schema.String,
  revision: Schema.String,
  profileDigest: Schema.String,
  arguments: Schema.Array(Schema.String),
})

export const Input = Schema.Union([ShellInput, ProfileInput])

const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

/**
 * Terminal execution has no process-spawn fallback. This leaf can run only with
 * the exact HostKernel-normalized call and one-use lease admitted by the runner.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const pty = yield* Pty.Service
    const guardedBash = Tool.make({
      description: "Run a bounded shell command through HorizonCode Guard, or invoke a trusted workspace build/test profile.",
      capability: { id: "terminal.run", effectClass: "effect" },
      input: Input,
      output: Output,
      structured: StructuredOutput,
      toStructuredOutput: ({ output }) => ({
        truncated: output.truncated,
        ...(output.exit === undefined ? {} : { exit: output.exit }),
        ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
      }),
      toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
      execute: (input, context) => Effect.gen(function* () {
        const call = context.guardedCall
        const lease = context.effect
        const locationRef = context.locationRef
        if (!call || call.callID !== context.toolCallID || call.capabilityID !== "terminal.run" ||
            !lease || !lease.effectID || !/^blake3:[0-9a-f]{64}$/.test(lease.capabilityLeaseDigest) || !locationRef) {
          return yield* Effect.fail(new ToolFailure({ message: "Terminal execution requires the exact Guard-admitted call, lease, and Location" }))
        }
        const ptyResult = yield* pty.runTool({
          sessionID: context.sessionID,
          locationRef,
          lease,
          call,
          ...(context.workspaceCommandProfile ? { workspaceCommandProfile: context.workspaceCommandProfile } : {}),
        }).pipe(Effect.mapError(() => new ToolFailure({ message: "Guarded terminal execution failed" })))
        if (ptyResult.status === "unknown" || ptyResult.status === "cancelled") {
          return yield* Effect.fail(new ToolFailure({ message: `Terminal outcome is ${ptyResult.status}; inspect the durable receipt before retrying` }))
        }
        const warnings = [
          `Artifact ${ptyResult.artifactFidelity.toLowerCase()} (${ptyResult.observedBytes} bytes observed, ${ptyResult.droppedBytes} dropped)`,
          ...(ptyResult.artifactTruncated ? ["Terminal artifact was truncated"] : []),
        ]
        return {
          output: ptyResult.preview,
          truncated: ptyResult.previewTruncated || ptyResult.artifactTruncated,
          ...(ptyResult.status === "timed_out" ? { timeout: true } : {}),
          ...(ptyResult.exitCode === undefined ? {} : { exit: ptyResult.exitCode }),
          warnings,
        }
      }),
    })
    markBuiltinBash(guardedBash)
    yield* tools.register({ [name]: guardedBash }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [Pty.node, ToolRegistry.node],
})
