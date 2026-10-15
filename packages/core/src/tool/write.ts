/**
 * Model-facing V2 file-write leaf. Relative paths and absolute paths inside
 * the active Location are written by the Rust Guard/ExecutionHost path.
 * External absolute paths remain unavailable until that host supports them.
 */
export * as WriteTool from "./write"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { SessionSupervisor } from "../session/supervisor"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { markBuiltinWrite } from "./write-provenance"

export const name = "write"

// Compatibility decision deferred to measured model/harness tests; `path` stays canonical until then.
export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to write. Relative paths and absolute paths inside the active Location are supported. External absolute paths are not supported by the guarded effect host.",
  }),
  content: Schema.String.annotate({ description: "Content to write to the file" }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}`

/** Deferred V2 write UX integrations remain explicit and mapped to later runtime gates. */
// Formatter integration waits for the canonical formatter runtime.
// Watcher/file-edit events wait for the V2 watcher/event owner.
// Snapshot/undo waits for the verified restore/reconciliation design.
// LSP notification/diagnostics wait for the LanguageServiceBroker mutation path.

// Only this first-party leaf may mint a native write registration.
// An arbitrary Location/plugin tool cannot gain file authority by claiming
// capability ID "files.write" and the model-facing name "write".
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const supervisor = yield* SessionSupervisor.Service

    const guardedWrite = Tool.withPermission(
      Tool.make({
            description:
              "Write content to one file within the active Location. External absolute paths are not supported by the guarded effect host.",
            capability: { id: "files.write", effectClass: "effect" },
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const admission = context.effect
                if (!admission)
                  return yield* Effect.fail(new ToolFailure({ message: "Write denied: missing Rust effect challenge" }))
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                if (admission.target !== target.canonical || admission.resource !== target.resource)
                  return yield* Effect.fail(new ToolFailure({ message: "Write denied: effect target changed" }))
                if (target.externalDirectory)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* permission.assert({
                  action: "edit",
                  resources: [target.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const receipt = yield* Effect.uninterruptible(
                  supervisor
                    .approveEffect({
                      sessionID: context.sessionID,
                      challengeID: admission.challengeID,
                    })
                    .pipe(
                      Effect.andThen(
                        supervisor.executeWrite({
                          sessionID: context.sessionID,
                          challengeID: admission.challengeID,
                          content: input.content,
                        }),
                      ),
                    ),
                )
                if (
                  receipt.effectID !== admission.effectID ||
                  receipt.target !== target.canonical ||
                  receipt.resource !== target.resource
                )
                  return yield* Effect.fail(new ToolFailure({ message: "Write denied: Rust receipt does not match its challenge" }))
                return {
                  operation: "write" as const,
                  target: receipt.target,
                  resource: receipt.resource,
                  existed: receipt.existed,
                }
              }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to write ${input.path}` }))),
      }),
      "edit",
    )
    markBuiltinWrite(guardedWrite)
    yield* tools.register({ [name]: guardedWrite }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/write",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, PermissionV2.node, SessionSupervisor.node],
})
