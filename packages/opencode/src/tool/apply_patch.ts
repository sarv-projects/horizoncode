import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import type { ManagedAttemptScopeV1 } from "@opencode-ai/core/session/supervisor"
import type { ManagedAttemptAuthority } from "@/session/managed-control"
import {
  acceptDirectAttemptReceipt,
  acceptDirectTurnBatchReceipt,
  settleToolBatchLease,
  type ToolBatchDirectAttemptAuthority,
} from "@/session/tool-batch"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import type { EffectLease } from "@opencode-ai/core/session/supervisor"
import * as Bom from "@/util/bom"
import * as RepoIntelligenceSchema from "@opencode-ai/schema/repo-intelligence-v1"

function isEffectLease(value: unknown): value is EffectLease {
  if (typeof value !== "object" || value === null) return false
  return (
    "effectID" in value &&
    typeof value.effectID === "string" &&
    "capabilityLeaseDigest" in value &&
    typeof value.capabilityLeaseDigest === "string" &&
    /^blake3:[0-9a-f]{64}$/.test(value.capabilityLeaseDigest)
  )
}

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
  repoIntelFence: Schema.optional(RepoIntelligenceSchema.RepoIntelPatchFenceV1).annotate({
    description: "For edits based on RepoIntel, pass its queryID, sourceGeneration, sourceRevision, workspaceBinding, and exactly one ref per target: {pathRef,fileDigest} for existing content or {pathRef,expectedAbsent:true} for a new destination. HostKernel revalidates this read-only evidence before Guard admission; it grants no write authority. Omit only for edits not based on RepoIntel evidence.",
  }),
})
export const preparePatchBatch = Effect.fn("ApplyPatchTool.prepareBatch")(function* (
  patchText: string,
  root: string,
  afs: FSUtil.Interface,
) {
  const parsed = Patch.parsePatch(patchText)
  if (parsed.hunks.length === 0) {
    const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
    if (normalized !== "*** Begin Patch\n*** End Patch") {
      return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
    }
    return { operations: [] }
  }
  const operations: Array<{
    operation: "write" | "delete"
    path: string
    expectedBeforeBase64: string | null
    contentBase64?: string
  }> = []
  for (const hunk of parsed.hunks) {
    const filePath = path.resolve(root, hunk.path)
    const relativePath = path.relative(root, filePath)
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return yield* Effect.fail(new Error("apply_patch verification failed: path escapes the workspace"))
    }
    if (hunk.type === "add") {
      const content = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
      operations.push({
        operation: "write",
        path: filePath,
        expectedBeforeBase64: null,
        contentBase64: Buffer.from(content, "utf8").toString("base64"),
      })
      continue
    }
    const bytes = yield* afs.readFile(filePath)
    const expectedBeforeBase64 = Buffer.from(bytes).toString("base64")
    if (hunk.type === "delete") {
      operations.push({ operation: "delete", path: filePath, expectedBeforeBase64 })
      continue
    }
    const source = Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
    const update = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks, Bom.join(source.text, source.bom))
    const content = Buffer.from(Bom.join(update.content, update.bom), "utf8").toString("base64")
    if (hunk.move_path) {
      const movePath = path.resolve(root, hunk.move_path)
      const moveRelativePath = path.relative(root, movePath)
      if (
        !moveRelativePath ||
        moveRelativePath === ".." ||
        moveRelativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(moveRelativePath)
      ) {
        return yield* Effect.fail(new Error("apply_patch verification failed: move path escapes the workspace"))
      }
      operations.push({ operation: "delete", path: filePath, expectedBeforeBase64 })
      operations.push({
        operation: "write",
        path: movePath,
        expectedBeforeBase64: null,
        contentBase64: content,
      })
    } else {
      operations.push({
        operation: "write",
        path: filePath,
        expectedBeforeBase64,
        contentBase64: content,
      })
    }
  }
  return { operations }
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const supervisor = yield* SessionSupervisor.Service
    const events = yield* EventV2Bridge.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        if (Array.isArray(ctx.extra?.guardedPatch) && ctx.extra.guardedPatch.length === 0 && !ctx.effect) {
          return {
            title: "Success. No changes made.",
            metadata: { diff: "", files: [], diagnostics: {} },
            output: "Success. No changes made.",
          }
        }
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
      }> = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            const source = yield* Bom.readFile(afs, filePath)
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(
                filePath,
                hunk.chunks,
                Bom.join(source.text, source.bom),
              )
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const source = yield* Bom.readFile(afs, filePath).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const contentToDelete = source.text
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        ...(change.movePath ? { movePath: change.movePath } : {}),
      }))
      const operations: Array<{
        operation: "write" | "delete"
        path: string
        expectedBeforeBase64: string | null
        contentBase64?: string
      }> = []
      for (const change of fileChanges) {
        const expectedBeforeBase64 =
          change.type === "add" ? null : Buffer.from(yield* afs.readFile(change.filePath)).toString("base64")
        if (change.type === "delete") {
          operations.push({ operation: "delete", path: change.filePath, expectedBeforeBase64 })
          continue
        }
        const contentBase64 = Buffer.from(Bom.join(change.newContent, change.bom), "utf8").toString("base64")
        if (change.type === "move" && change.movePath) {
          operations.push({ operation: "delete", path: change.filePath, expectedBeforeBase64 })
          operations.push({
            operation: "write",
            path: change.movePath,
            expectedBeforeBase64: null,
            contentBase64,
          })
          continue
        }
        operations.push({
          operation: "write",
          path: change.filePath,
          expectedBeforeBase64,
          contentBase64,
        })
      }
      const guardedPatch = ctx.extra?.guardedPatch
      const lease = ctx.extra?.guardedLease
      if (
        !Array.isArray(guardedPatch) ||
        JSON.stringify(guardedPatch) !== JSON.stringify(operations) ||
        !isEffectLease(lease)
      ) {
        return yield* Effect.fail(new Error("Patch denied: guarded operation set or lease changed"))
      }
      const trustedPrincipal = ctx.trustedPrincipal
      if (trustedPrincipal?.kind !== "server_auth" || !trustedPrincipal.subject) {
        return yield* Effect.fail(new Error("Patch denied: missing authenticated principal"))
      }
      const managedAttempt = ctx.extra?.managedAttempt as ManagedAttemptAuthority | undefined
      const managedAttemptScope = managedAttempt?.currentScope()
      const directAttempt = ctx.extra?.directAttempt as ToolBatchDirectAttemptAuthority | undefined
      const directAttemptScope = directAttempt?.currentScope()

      const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      const receipt = yield* Effect.uninterruptible(
        supervisor.executePatch({
          sessionID: ctx.sessionID,
          locationRef,
          lease,
          operations: guardedPatch as typeof operations,
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
        if (!receipt.directAttempt || receipt.attemptScopeTransition !== "effect_receipt") {
          return yield* Effect.fail(new Error("Patch denied: HostKernel omitted direct Attempt receipt scope"))
        }
        acceptDirectAttemptReceipt(directAttempt, directAttemptScope, receipt)
        if (directAttempt.directTurn && receipt.directTurnScope) {
          yield* Effect.promise(() => acceptDirectTurnBatchReceipt(directAttempt, receipt))
        }
      }
      yield* Effect.promise(() => settleToolBatchLease(lease, { effectID: receipt.effectID }))
      if (managedAttemptScope) {
        if (!receipt.managedAttempt || receipt.attemptScopeTransition !== "effect_receipt") {
          return yield* Effect.fail(new Error("Patch denied: HostKernel omitted managed receipt scope"))
        }
        managedAttempt?.acceptRefreshedScope({
          previous: managedAttemptScope,
          refreshed: receipt.managedAttempt,
          transition: "effect_receipt",
        })
      }
      const expected = new Map(operations.map((item) => [item.path, item.operation]))
      if (
        receipt.effectID !== lease.effectID ||
        receipt.targets.length !== operations.length ||
        receipt.targets.some((target) => expected.get(target.target) !== target.operation)
      ) {
        return yield* Effect.fail(new Error("Patch denied: Rust receipt does not match the prepared operation set"))
      }

      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            updates.push({ file: change.filePath, event: "add" })
            break
          case "update":
            updates.push({ file: change.filePath, event: "change" })
            break
          case "move":
            if (change.movePath) {
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break
          case "delete":
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }
        if (edited) yield* events.publish(FileSystem.Event.Edited, { file: edited })
      }

      // Publish file change events
      for (const update of updates) {
        yield* events.publish(Watcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      capability: { id: "files.patch", effectClass: "effect" },
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
