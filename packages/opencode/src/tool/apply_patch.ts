import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import * as Bom from "@/util/bom"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
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
        yield* assertExternalDirectoryEffect(ctx, filePath)

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
            yield* assertExternalDirectoryEffect(ctx, movePath)

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
      if (
        !Array.isArray(guardedPatch) ||
        JSON.stringify(guardedPatch) !== JSON.stringify(operations) ||
        !ctx.effect?.targets
      ) {
        return yield* Effect.fail(new Error("Patch denied: guarded operation set changed"))
      }

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      const admission = ctx.effect
      if (!admission) return yield* Effect.fail(new Error("Patch denied: missing Rust effect challenge"))
      yield* Effect.uninterruptible(
        supervisor.runPatch({
          sessionID: ctx.sessionID,
          operations: guardedPatch as typeof operations,
          preparedChallenge: admission,
          authorize: async () => undefined,
        }),
      )

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
