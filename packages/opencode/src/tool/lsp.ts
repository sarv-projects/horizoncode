import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./lsp.txt"
import { InstanceState } from "@/effect/instance-state"
import { pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "codeAction",
  "rename",
] as const

function requireRenameName(value: string | undefined): string {
  if (!value || !value.trim()) throw new Error("newName is required for rename")
  return value
}

export const Parameters = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line number (1-based, as shown in editors)",
  }),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The character offset (1-based, as shown in editors)",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for workspaceSymbol. Empty string requests all symbols.",
  }),
  /** Required only for the rename operation. The server result is a proposal. */
  newName: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))).annotate({
    description: "New symbol name for rename; required only for rename.",
  }),
})

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (args.operation === "rename") requireRenameName(args.newName)
          const instance = yield* InstanceState.context
          const file = path.isAbsolute(args.filePath) ? args.filePath : path.join(instance.directory, args.filePath)
          yield* assertExternalDirectoryEffect(ctx, file)
          // LSP protocol requests are authorized by the active Session's
          // HostKernel protocol dispatcher. The legacy PermissionV1 `always`
          // setting is not a Guard grant and must not become a second consent
          // authority here. Code actions and rename remain proposals; applying
          // either goes through the ordinary guarded `files.patch` path.

          const uri = pathToFileURL(file).href
          const position = { file, line: args.line - 1, character: args.character - 1 }
          const relPath = path.relative(instance.worktree, file)
          const detail =
            args.operation === "workspaceSymbol"
              ? ""
              : args.operation === "documentSymbol"
                ? relPath
                : `${relPath}:${args.line}:${args.character}`
          const title = detail ? `${args.operation} ${detail}` : args.operation

          const available = yield* lsp.hasClients(file)
          if (!available) throw new Error("No LSP server available for this file type.")

          yield* lsp.touchFile(file, "document")

          const result: unknown[] = yield* (() => {
            switch (args.operation) {
              case "goToDefinition":
                return lsp.definition(position)
              case "findReferences":
                return lsp.references(position)
              case "hover":
                return lsp.hover(position)
              case "documentSymbol":
                return lsp.documentSymbol(uri)
              case "workspaceSymbol":
                return lsp.workspaceSymbol(args.query ?? "")
              case "goToImplementation":
                return lsp.implementation(position)
              case "prepareCallHierarchy":
                return lsp.prepareCallHierarchy(position)
              case "incomingCalls":
                return lsp.incomingCalls(position)
              case "outgoingCalls":
                return lsp.outgoingCalls(position)
              case "codeAction":
                return lsp.codeAction(position)
              case "rename":
                return lsp.rename({ ...position, newName: requireRenameName(args.newName) })
            }
          })()

          return {
            title,
            metadata: {
              result,
              ...(args.operation === "codeAction" || args.operation === "rename"
                ? { proposalOnly: true, applyThrough: "files.patch" as const }
                : {}),
            },
            output: result.length === 0
              ? `No results found for ${args.operation}`
              : args.operation === "codeAction" || args.operation === "rename"
                ? `Untrusted LSP edit proposal. Review it; no files were changed. Apply only through files.patch after the normal Guard approval.\n${JSON.stringify(result, null, 2)}`
                : JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
