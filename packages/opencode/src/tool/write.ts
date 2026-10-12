import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import * as Bom from "@/util/bom"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const supervisor = yield* SessionSupervisor.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      capability: { id: "files.write", effectClass: "effect" },
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          const admission = ctx.effect
          if (!admission) return yield* Effect.fail(new Error("Write denied: missing Rust effect challenge"))

          const canonical = path.resolve(filepath)
          const resource = path.relative(instance.directory, canonical).split(path.sep).join("/")
          if (admission.target !== canonical || admission.resource !== resource) {
            return yield* Effect.fail(new Error("Write denied: effect target changed"))
          }

          const exists = yield* fs.existsSafe(filepath)
          if (exists !== admission.existed) return yield* Effect.fail(new Error("Write denied: target changed"))
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const contentNew = Bom.split(params.content).text
          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, source.text, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          const receipt = yield* Effect.uninterruptible(
            supervisor
              .approveEffect({ sessionID: ctx.sessionID, challengeID: admission.challengeID })
              .pipe(
                Effect.andThen(
                  supervisor.executeWrite({
                    sessionID: ctx.sessionID,
                    challengeID: admission.challengeID,
                    content: params.content,
                  }),
                ),
              ),
          )
          if (
            receipt.effectID !== admission.effectID ||
            receipt.target !== admission.target ||
            receipt.resource !== admission.resource ||
            receipt.existed !== admission.existed
          ) {
            return yield* Effect.fail(new Error("Write denied: Rust receipt does not match its challenge"))
          }

          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
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
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists,
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
