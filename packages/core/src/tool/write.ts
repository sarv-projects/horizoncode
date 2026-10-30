/**
 * Model-facing V2 file-write leaf. Relative paths and absolute paths inside
 * the active Location are written by the Rust Guard/ExecutionHost path.
 * External absolute paths remain unavailable until that host supports them.
 */
export * as WriteTool from "./write"

import { ToolFailure } from "@horizoncode/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
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

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
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
              return yield* Effect.fail(new ToolFailure({ message: "Write denied: missing Rust Guard lease" }))
            const trustedPrincipal = context.trustedPrincipal
            if (trustedPrincipal?.kind !== "server_auth" || !trustedPrincipal.subject)
              return yield* Effect.fail(new ToolFailure({ message: "Write denied: missing authenticated principal" }))
            const lease = admission
            if (!lease.effectID || !lease.capabilityLeaseDigest)
              return yield* Effect.fail(new ToolFailure({ message: "Write denied: invalid Rust Guard lease" }))
            const source = {
              type: "tool" as const,
              messageID: context.assistantMessageID,
              callID: context.toolCallID,
            }
            const target = yield* mutation.resolve({ path: input.path, kind: "file" })
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
              supervisor.executeWrite({
                sessionID: context.sessionID,
                locationRef: Location.Ref.make({ directory: location.directory }),
                lease,
                ...(lease.directAttempt ? { directAttempt: lease.directAttempt } : {}),
                ...(lease.managedAttempt ? { managedAttempt: lease.managedAttempt } : {}),
                content: input.content,
                trustedPrincipal,
              }),
            )
            if (
              receipt.effectID !== lease.effectID ||
              receipt.target !== target.canonical ||
              receipt.resource !== target.resource
            )
              return yield* Effect.fail(
                new ToolFailure({ message: "Write denied: Rust receipt does not match the prepared lease" }),
              )
            return {
              operation: "write" as const,
              target: receipt.target,
              resource: receipt.resource,
              existed: receipt.existed,
            }
          }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to write file" }))),
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
  deps: [Location.node, ToolRegistry.node, LocationMutation.node, PermissionV2.node, SessionSupervisor.node],
})
