export * as BashTool from "./bash"

import { ToolFailure } from "@horizoncode/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PositiveInt } from "../schema"
import { Pty } from "../pty"
import { TrustedPrincipalContext } from "../trusted-principal"
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

const hasExactKeys = (value: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const guardedArgumentsMatch = (input: typeof Input.Type, args: unknown): boolean => {
  if (!isRecord(args)) return false
  if ("mode" in input) {
    return hasExactKeys(args, ["mode", "action", "profileID", "revision", "profileDigest", "arguments"]) &&
      args.mode === input.mode && args.action === input.action && args.profileID === input.profileID &&
      args.revision === input.revision && args.profileDigest === input.profileDigest &&
      Array.isArray(args.arguments) && args.arguments.length === input.arguments.length &&
      args.arguments.every((value, index) => value === input.arguments[index])
  }
  return hasExactKeys(args, ["mode", "command", "cwd", "timeoutMs", "shellProfileID", "resolvedEnvironment"]) &&
    args.mode === "shell" && args.command === input.command && args.cwd === input.cwd &&
    args.timeoutMs === input.timeoutMs
}

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
type TerminalRunner = Pick<Pty.Interface, "runTool">

/**
 * Builds the guarded terminal leaf over a terminal runner. Extracted so the
 * fail-closed trusted-principal contract at this execution boundary can be
 * exercised directly without assembling the full Location node graph.
 */
export const makeTool = (pty: TerminalRunner) => Tool.make({
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
            !guardedArgumentsMatch(input, call.arguments) || !lease || !lease.effectID ||
            !/^blake3:[0-9a-f]{64}$/.test(lease.capabilityLeaseDigest) || !locationRef) {
          return yield* Effect.fail(new ToolFailure({ message: "Terminal execution requires the exact Guard-admitted call, lease, and Location" }))
        }
        // Fail closed without the runner-captured authenticated principal: the
        // leaf itself binds it into TrustedPrincipalContext for the guarded
        // terminal dispatch instead of depending on ambient context, so the
        // execution boundary never runs unattributed.
        const principal = context.trustedPrincipal
        if (!principal)
          return yield* Effect.fail(new ToolFailure({ message: "Terminal execution requires an authenticated trusted principal" }))
        const ptyResult = yield* pty.runTool({
          sessionID: context.sessionID,
          locationRef,
          lease,
          call,
          ...(context.workspaceCommandProfile ? { workspaceCommandProfile: context.workspaceCommandProfile } : {}),
        }).pipe(
          Effect.provideService(TrustedPrincipalContext, { principal }),
          Effect.mapError(() => new ToolFailure({ message: "Guarded terminal execution failed" })),
        )
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

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const guardedBash = makeTool(yield* Pty.Service)
    markBuiltinBash(guardedBash)
    yield* tools.register({ [name]: guardedBash }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [Pty.node, ToolRegistry.node],
})
