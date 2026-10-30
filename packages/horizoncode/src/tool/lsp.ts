import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./lsp.txt"
import { InstanceState } from "@/effect/instance-state"
import { pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { RuntimeFlags } from "@/effect/runtime-flags"

/**
 * Navigation operations are read-only: they return protocol data and never
 * write, format, or apply anything. They are part of the default tool surface.
 */
const readOnlyOperations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

/**
 * Edit-proposal operations stay behind OPENCODE_EXPERIMENTAL_LSP_TOOL. Their
 * results are untrusted proposals that this tool never applies (see the
 * `proposalOnly` metadata), but they exist to feed rename/code-action flows and
 * are therefore not advertised as default read-only navigation.
 */
const editProposalOperations = ["codeAction", "rename"] as const

const operations = [...readOnlyOperations, ...editProposalOperations] as const

type Operation = (typeof operations)[number]

function requireRenameName(value: string | undefined): string {
  if (!value || !value.trim()) throw new Error("newName is required for rename")
  return value
}

const parametersFor = <const Allowed extends readonly [Operation, ...Operation[]]>(allowed: Allowed) =>
  Schema.Struct({
    operation: Schema.Literals(allowed).annotate({ description: "The LSP operation to perform" }),
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

/** Full surface, including the gated edit-proposal operations. */
export const Parameters = parametersFor(operations)

/** Default surface: navigation and other read-only operations only. */
export const ReadOnlyParameters = parametersFor(readOnlyOperations)

const readOnlyOperationSet: ReadonlySet<string> = new Set(readOnlyOperations)

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const flags = yield* RuntimeFlags.Service
    // Read-only navigation is available without an experimental opt-in. Rename
    // and codeAction only produce editor edit proposals, so they remain behind
    // the existing OPENCODE_EXPERIMENTAL_LSP_TOOL gate.
    const parameters = flags.experimentalLspTool ? Parameters : ReadOnlyParameters
    return {
      description: DESCRIPTION,
      parameters,
      // Navigation and diagnostics are reads; the Session's HostKernel LSP
      // dispatcher authorizes each protocol request under `language.diagnostics`
      // and code actions/rename return proposals, never a direct write.
      capability: { id: "language.diagnostics", effectClass: "read_only" as const },
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!flags.experimentalLspTool && !readOnlyOperationSet.has(args.operation)) {
            throw new Error(
              `${args.operation} is an edit-proposal operation; set OPENCODE_EXPERIMENTAL_LSP_TOOL to enable it`,
            )
          }
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
