import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@horizoncode/core/filesystem"
import { Watcher } from "@horizoncode/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { SessionSupervisor } from "@horizoncode/core/session/supervisor"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { FSUtil } from "@horizoncode/core/fs-util"
import type { EffectLease, ManagedAttemptScopeV1 } from "@horizoncode/core/session/supervisor"
import {
  isCompletedDirectTurnBatchScope,
  isReceiptAdvancedDirectAttemptScope,
  isReceiptAdvancedManagedAttemptScope,
  sameDirectAttemptScope,
  sameManagedAttemptScope,
  type ManagedAttemptAuthority,
} from "@/session/managed-control"
import { effectMutationPrincipalAllowed } from "@/util/effect-mutation-principal"
import { FileReadTracker } from "@/session/file-read-tracker"
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
    const afs = yield* FSUtil.Service
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
          if (!effectMutationPrincipalAllowed(trustedPrincipal)) {
            return yield* Effect.fail(new Error("Write denied: missing authenticated principal"))
          }
          const principal = trustedPrincipal!
          const managedAttempt = ctx.extra?.managedAttempt as ManagedAttemptAuthority | undefined
          const managedAttemptScope = managedAttempt?.currentScope()
          const directAttempt = ctx.extra?.directAttempt as ToolBatchDirectAttemptAuthority | undefined
          const directAttemptScope = directAttempt?.currentScope()
          const directTurnScope = directAttempt?.directTurn?.currentScope()
          const requestedPath = path.resolve(instance.directory, params.filePath)
          if (yield* afs.existsSafe(requestedPath)) {
            FileReadTracker.assertSeen(ctx.sessionID, requestedPath, instance.directory)
          }
          let expectedTarget: string
          if (yield* afs.existsSafe(requestedPath)) {
            expectedTarget = path.resolve(yield* afs.resolve(requestedPath))
          } else {
            const parent = path.resolve(yield* afs.resolve(path.dirname(requestedPath)))
            expectedTarget = path.join(parent, path.basename(requestedPath))
          }
          const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
          const receipt = yield* Effect.uninterruptible(
            supervisor.executeWrite({
              sessionID: ctx.sessionID,
              locationRef,
              lease,
              content: params.content,
              trustedPrincipal: principal,
              ...(directAttemptScope !== undefined
                ? { directAttempt: directAttemptScope }
                : {}),
              ...(directTurnScope !== undefined ? { directTurnScope } : {}),
              ...(managedAttemptScope !== undefined
                ? { managedAttempt: managedAttemptScope as ManagedAttemptScopeV1 }
                : {}),
            }),
          )
          if (
            receipt.effectID !== lease.effectID ||
            receipt.target !== expectedTarget
          ) {
            throw new Error("Write denied: Rust receipt does not match the requested effect")
          }
          if (directAttemptScope !== undefined && directAttempt) {
            if (!receipt.directAttempt || receipt.attemptScopeTransition !== "effect_receipt") {
              throw new Error("Write denied: HostKernel omitted direct Attempt receipt scope")
            }
            if (
              !sameDirectAttemptScope(directAttempt.currentScope(), directAttemptScope) ||
              !isReceiptAdvancedDirectAttemptScope(directAttemptScope, receipt.directAttempt)
            ) {
              throw new Error("Write denied: HostKernel returned a stale or mismatched direct Attempt receipt scope")
            }
            if (directAttempt.directTurn && receipt.directTurnScope) {
              if (
                !directTurnScope ||
                !isCompletedDirectTurnBatchScope(directTurnScope, receipt.directTurnScope) ||
                !sameDirectAttemptScope(receipt.directTurnScope.directAttempt, receipt.directAttempt)
              ) {
                throw new Error("Write denied: HostKernel returned a stale or mismatched DirectTurn receipt scope")
              }
            }
          }
          if (managedAttemptScope) {
            if (!receipt.managedAttempt || receipt.attemptScopeTransition !== "effect_receipt") {
              throw new Error("Write denied: HostKernel omitted managed receipt scope")
            }
            if (
              !sameManagedAttemptScope(managedAttempt!.currentScope(), managedAttemptScope) ||
              !isReceiptAdvancedManagedAttemptScope(managedAttemptScope, receipt.managedAttempt) ||
              receipt.managedAttempt.effectiveMaxTokens !== managedAttemptScope.effectiveMaxTokens ||
              receipt.managedAttempt.remainingTokens !== managedAttemptScope.remainingTokens
            ) {
              throw new Error("Write denied: HostKernel returned a stale or mismatched managed Attempt receipt scope")
            }
          }
          if (directAttemptScope !== undefined && directAttempt) {
            acceptDirectAttemptReceipt(directAttempt, directAttemptScope, receipt)
            if (directAttempt.directTurn && receipt.directTurnScope) {
              yield* Effect.promise(() => acceptDirectTurnBatchReceipt(directAttempt, receipt))
            }
          }
          if (managedAttemptScope) {
            managedAttempt?.acceptRefreshedScope({
              previous: managedAttemptScope,
              refreshed: receipt.managedAttempt!,
              transition: "effect_receipt",
            })
          }
          yield* Effect.promise(() => settleToolBatchLease(lease, { effectID: receipt.effectID }))
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
