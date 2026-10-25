import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import type { EffectLease, ManagedAttemptScopeV1 } from "@opencode-ai/core/session/supervisor"
import type { ManagedAttemptAuthority } from "@/session/managed-control"
import {
  acceptDirectAttemptReceipt,
  acceptDirectTurnBatchReceipt,
  settleToolBatchLease,
  type ToolBatchDirectAttemptAuthority,
} from "@/session/tool-batch"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

function guardedLease(value: unknown): value is EffectLease {
  if (typeof value !== "object" || value === null) return false
  return (
    "effectID" in value &&
    typeof value.effectID === "string" &&
    "capabilityLeaseDigest" in value &&
    typeof value.capabilityLeaseDigest === "string" &&
    /^blake3:[0-9a-f]{64}$/.test(value.capabilityLeaseDigest)
  )
}

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const events = yield* EventV2Bridge.Service
    const supervisor = yield* SessionSupervisor.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      capability: { id: "files.write", effectClass: "effect" },
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const lease = ctx.extra?.guardedLease
          if (!guardedLease(lease)) return yield* Effect.fail(new Error("Write denied: missing Guard lease"))
          const trustedPrincipal = ctx.trustedPrincipal
          if (trustedPrincipal?.kind !== "server_auth" || !trustedPrincipal.subject) {
            return yield* Effect.fail(new Error("Write denied: missing authenticated principal"))
          }
          const managedAttempt = ctx.extra?.managedAttempt as ManagedAttemptAuthority | undefined
          const managedAttemptScope = managedAttempt?.currentScope()
          const directAttempt = ctx.extra?.directAttempt as ToolBatchDirectAttemptAuthority | undefined
          const directAttemptScope = directAttempt?.currentScope()
          const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
          const receipt = yield* Effect.uninterruptible(
            supervisor.executeWrite({
              sessionID: ctx.sessionID,
              locationRef,
              lease,
              content: params.content,
              trustedPrincipal,
              ...(directAttemptScope !== undefined
                ? { directAttempt: directAttemptScope }
                : {}),
              ...(directAttempt?.directTurn ? { directTurnScope: directAttempt.directTurn.currentScope() } : {}),
              ...(managedAttemptScope !== undefined
                ? { managedAttempt: managedAttemptScope as ManagedAttemptScopeV1 }
                : {}),
            }),
          )
          if (directAttemptScope && directAttempt) {
            acceptDirectAttemptReceipt(directAttempt, directAttemptScope, receipt)
            if (directAttempt.directTurn && receipt.directTurnScope) {
              yield* Effect.promise(() => acceptDirectTurnBatchReceipt(directAttempt, receipt))
            }
          }
          yield* Effect.promise(() => settleToolBatchLease(lease, { effectID: receipt.effectID }))
          if (managedAttemptScope) {
            if (!receipt.managedAttempt || receipt.attemptScopeTransition !== "effect_receipt") {
              return yield* Effect.fail(new Error("Write denied: HostKernel omitted managed receipt scope"))
            }
            managedAttempt?.acceptRefreshedScope({
              previous: managedAttemptScope,
              refreshed: receipt.managedAttempt,
              transition: "effect_receipt",
            })
          }
          const filepath = receipt.target
          const relative = path.relative(instance.directory, filepath).split(path.sep).join("/")
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: receipt.existed ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = filepath.replaceAll("\\", "/")
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file.replaceAll("\\", "/") === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: relative,
            metadata: {
              diagnostics,
              filepath,
              effectID: receipt.effectID,
              receiptDigest: receipt.receiptDigest,
              resource: receipt.resource,
              target: receipt.target,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
